/*
 * app.js - signs in, reads the data through Apps Script and draws the screens.
 *
 * Every read and write goes through the script, which checks the session and
 * cuts the data to the user's warehouses. The check shown here is a preview:
 * the script recomputes it when a request is registered or decided. Customer
 * data stays in memory only; just the session token is stored.
 */
(function () {
  'use strict';

  const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyhTT5bBIGue4Kbqs2VAuR39us1cUqNFIHPE9DJpnh77vZjM3bmZb74HgMFh67aG0Q/exec';
  const TOKEN_KEY = 'financialAnalysis.token';
  const PAGE_SIZE = 300;
  const REQUEST_PAGE = 100;
  const CHECK_PAGE = 200;
  const STATUS_TAG = { 'قيد الاعتماد': 'warn', 'معتمد': 'ok', 'مرفوض': 'stop', 'لا يحتاج اعتماد': 'paid' };
  const VERDICT_TAG = { 'سليمة': 'ok', 'تحتاج موافقة': 'warn', 'موقوفة': 'stop' };
  const VERDICT = { ok: 'منتظمة', warn: 'تحتاج متابعة', stop: 'حرجة', paid: 'مسددة' };
  const NEW_VERDICT = {
    ok: ['يمكن إصدار الفاتورة', 'لا توجد ملاحظات على الائتمان أو الضمان أو المتأخرات.'],
    warn: ['تحتاج موافقة قبل الإصدار', 'توجد ملاحظة أو أكثر تحتاج قرار المسؤول.'],
    stop: ['الفاتورة موقوفة', 'لا تُصدر الفاتورة آجلة قبل معالجة الأسباب الموضحة.'],
  };
  const ROLE_ADMIN = 'مدير';
  const ROLE_APPROVER = 'معتمد';
  const THEME_KEY = 'financialAnalysis.theme';
  // The snapshot is a read cache: decisions still go to the script.
  const CACHE_DB = 'financialAnalysis.cache';
  const CACHE_STORE = 'snapshots';
  const CACHE_KEY = 'latest';
  const CACHE_VERSION = 1;
  const CACHE_TTL = 24 * 60 * 60 * 1000;
  const VIEW_META = {
    login: ['تسجيل الدخول', 'الوصول إلى لوحة التحكم'],
    invoices: ['لوحة التحكم', 'نظرة شاملة على الائتمان والضمان والمتأخرات'],
    check: ['فحص فاتورة جديدة', 'قرار سريع قبل إصدار الفاتورة'],
    checks: ['مركز الشيكات', 'الشيكات المفتوحة والمستحقة والمرتجعة'],
    customer: ['ملف العميل', 'الصورة الكاملة للعميل قبل القرار'],
    requests: ['الطلبات والاعتمادات', 'متابعة الطلبات وقرارات الاعتماد'],
    users: ['المستخدمون', 'إدارة الحسابات والصلاحيات ونطاق المخازن'],
    audit: ['سجل العمليات', 'كل دخول وقرار وتغيير، مع الوقت والمنفذ'],
    settings: ['الإعدادات', 'كلمة المرور وقواعد التحليل'],
  };

  const $ = (id) => document.getElementById(id);
  const money = (v) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(v);
  const dateOf = (day) => (day == null ? '—' : new Date(day * 86400000).toISOString().slice(0, 10));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  const state = {
    token: readToken(), user: null, sheets: null, rules: Engine.DEFAULT_RULES, isDemo: false, result: null,
    shown: PAGE_SIZE, bucket: null, filtered: [], requests: [], users: [], lastCheck: null, deciding: null,
    decisionPending: false, decisionPreview: false, decisionCanAct: false, cacheSavedAt: null,
    build: '', requestShown: REQUEST_PAGE, audit: [], auditTotal: 0,
    checkList: null, checkShown: CHECK_PAGE, customerAccount: null, customerFrom: 'invoices', requestsLoaded: false,
  };

  /* ---- the script ------------------------------------------------------------ */

  function readToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function saveToken(token) {
    state.token = token;
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {
      console.warn('session not saved', e);
    }
  }

  async function callScript(action, payload) {
    if (state.isDemo) throw new Error('هذه العملية تحتاج تسجيل الدخول، فأنت تستخدم البيانات النموذجية.');
    let res;
    try {
      // text/plain keeps this a simple request, which Apps Script can answer without CORS preflight.
      res = await fetch(SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action, token: state.token }, payload)),
      });
    } catch (e) {
      throw new Error('تعذّر الوصول إلى الخادم. تحقق من الاتصال وحاول مرة أخرى.');
    }
    let data;
    try {
      data = JSON.parse(await res.text());
    } catch (e) {
      throw new Error('رد الخادم غير متوقع. تأكد من نشر آخر إصدار من السكربت بصلاحية Anyone.');
    }
    if (!data.ok) {
      if (data.login) signedOut(data.error);
      throw new Error(data.error || 'تعذّر تنفيذ الطلب.');
    }
    if (data.user) setUser(data.user);
    if (data.build) state.build = data.build;
    showBuild();
    return data;
  }

  // The server build is shown in the settings, so a stale deployment is visible.
  function showBuild() {
    const el = $('serverBuild');
    if (el) el.textContent = state.build || '—';
  }

  /* ---- local snapshot (IndexedDB) ------------------------------------------- */

  // The snapshot lets a reload show the last data without reading the sheets.
  // It is tied to a hash of the session token, so another login never sees it.

  let dbPromise = null;

  function openCacheDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB غير متاح')); return; }
      const req = indexedDB.open(CACHE_DB, CACHE_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (db.objectStoreNames.contains(CACHE_STORE)) db.deleteObjectStore(CACHE_STORE);
        db.createObjectStore(CACHE_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('تعذّر فتح التخزين المحلي'));
    });
    return dbPromise;
  }

  function cacheRequest(mode, run) {
    return openCacheDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, mode);
      let result;
      const req = run(tx.objectStore(CACHE_STORE));
      req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || req.error);
      tx.onerror = () => reject(tx.error || req.error);
    }));
  }

  async function tokenTag() {
    if (!state.token) return '';
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(state.token));
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      return '';
    }
  }

  async function readCache() {
    try {
      const tag = await tokenTag();
      if (!tag) return null;
      const snap = await cacheRequest('readonly', (store) => store.get(CACHE_KEY));
      if (!snap || snap.version !== CACHE_VERSION || snap.tokenTag !== tag || !snap.user || !snap.base || !snap.tx) return null;
      return snap;
    } catch (e) {
      console.warn('local cache read failed', e);
      return null;
    }
  }

  async function saveCache() {
    if (state.isDemo || !state.token || !state.user || !state.sheets) return;
    try {
      const tag = await tokenTag();
      if (!tag) return;
      await cacheRequest('readwrite', (store) => store.put({
        version: CACHE_VERSION, tokenTag: tag, savedAt: Date.now(), build: state.build,
        user: state.user, rules: state.rules,
        base: state.sheets.base, tx: state.sheets.tx, analysisDay: state.sheets.analysisDay,
        checks: state.sheets.checks, checksError: state.sheets.checksError, dataAt: state.sheets.dataAt,
      }, CACHE_KEY));
    } catch (e) {
      console.warn('local cache save failed', e);
    }
  }

  async function clearCache() {
    try {
      await cacheRequest('readwrite', (store) => store.delete(CACHE_KEY));
    } catch (e) {
      console.warn('local cache clear failed', e);
    }
  }

  const scopeOf = (u) => (u && Array.isArray(u.warehouses) ? u.warehouses.map(String).sort().join('|') : '');
  const ruleKey = (r) => JSON.stringify(Object.keys(r || {}).sort().reduce((o, k) => { o[k] = r[k]; return o; }, {}));

  function cacheNote() {
    if (!state.cacheSavedAt) return '';
    const d = new Date(state.cacheSavedAt);
    const when = `${d.toLocaleDateString('ar-EG-u-nu-latn')} ${d.toLocaleTimeString('ar-EG-u-nu-latn', { hour: '2-digit', minute: '2-digit' })}`;
    return `تُعرض نسخة محفوظة من البيانات بتاريخ ${when}. اضغط «تحديث البيانات» لجلب الأحدث.`;
  }

  function applyCache(snap, user) {
    state.isDemo = false;
    setUser(user || snap.user);
    state.build = snap.build || state.build;
    showBuild();
    state.sheets = {
      base: snap.base, tx: snap.tx, analysisDay: snap.analysisDay,
      checks: snap.checks || null, checksError: snap.checksError || '', dataAt: snap.dataAt || null,
    };
    state.rules = Object.assign({}, Engine.DEFAULT_RULES, snap.rules || {});
    state.cacheSavedAt = snap.savedAt || 0;
    recompute();
    show('invoices');
  }

  /* ---- session --------------------------------------------------------------- */

  const canDecide = () => !!state.user && (state.user.role === ROLE_ADMIN || state.user.role === ROLE_APPROVER);
  const isAdmin = () => !!state.user && state.user.role === ROLE_ADMIN;

  function setUser(user) {
    state.user = user;
    const scope = user.warehouses && user.warehouses.length ? user.warehouses.join('، ') : 'كل المخازن';
    $('whoami').textContent = `${user.name} · ${user.role} · ${scope}`;
    $('userAvatar').textContent = (user.name || user.username || '؟').trim().charAt(0);
    document.querySelectorAll('[data-admin]').forEach((el) => { el.hidden = !isAdmin(); });
  }

  function clearData() {
    Object.assign(state, {
      user: null, sheets: null, result: null, requests: [], users: [], lastCheck: null, bucket: null,
      deciding: null, decisionPending: false, decisionPreview: false, decisionCanAct: false,
      isDemo: false, cacheSavedAt: null, build: '', requestShown: REQUEST_PAGE, audit: [], auditTotal: 0,
      checkList: null, checkShown: CHECK_PAGE, customerAccount: null, customerFrom: 'invoices', requestsLoaded: false,
    });
    for (const id of ['rows', 'kpis', 'aging', 'statusChart', 'requestRows', 'userRows', 'checkResult', 'customerList', 'auditRows', 'auditCount', 'checkKpis', 'checkRows', 'checksCount', 'customerBody']) $(id).innerHTML = '';
    $('requestsMore').hidden = true;
    $('checksMore').hidden = true;
    showBuild();
    $('userAvatar').textContent = '؟';
    document.querySelectorAll('[data-admin]').forEach((el) => { el.hidden = true; });
    $('stamp').textContent = 'الائتمان والضمان والمتأخرات';
  }

  function signedOut(message) {
    saveToken('');
    clearCache();
    clearData();
    $('tabs').hidden = true;
    $('session').hidden = true;
    banner('');
    $('loginError').textContent = message || '';
    $('loginError').hidden = !message;
    $('loginPass').value = '';
    for (const d of ['detail', 'decision']) if ($(d).open) $(d).close();
    show('login');
  }

  function signedIn() {
    $('tabs').hidden = false;
    $('session').hidden = false;
  }

  async function login(event) {
    event.preventDefault();
    $('loginSubmit').disabled = true;
    $('loginError').hidden = true;
    try {
      const data = await callScript('login', { username: $('loginUser').value, password: $('loginPass').value });
      saveToken(data.token);
      $('loginPass').value = '';
      signedIn();
      show('invoices');
      await loadData();
    } catch (e) {
      $('loginError').textContent = e.message;
      $('loginError').hidden = false;
    } finally {
      $('loginSubmit').disabled = false;
    }
  }

  async function logout() {
    if (state.isDemo) { signedOut(); return; }
    try {
      await callScript('logout');
    } catch (e) {
      console.warn('logout not confirmed', e);
    }
    signedOut();
  }

  /* ---- load and analyze ------------------------------------------------------ */

  function banner(text, isError) {
    $('banner').hidden = !text;
    $('banner').textContent = text || '';
    $('banner').classList.toggle('error', !!isError);
  }

  function issuesText(issues) {
    const parts = [];
    if (issues.missingColumns.length) parts.push(`لم أجد في قاعدة العملاء الأعمدة: ${issues.missingColumns.join('، ')}، فستبقى خاناتها فارغة في شيت الطلبات`);
    if (issues.badDates) parts.push(`${issues.badDates} حركة تاريخها غير مقروء ولم تُحسب`);
    if (issues.futureRows) parts.push(`${issues.futureRows} حركة بتاريخ مستقبلي`);
    if (issues.notInBase) parts.push(`${issues.notInBase} حساب غير موجود في قاعدة العملاء، فاعتُبر بلا حد ائتمان أو ضمان`);
    if (issues.blankGuarantee) parts.push(`${issues.blankGuarantee} عميل خانة ضمانه فارغة`);
    if (issues.balanceDiffs) parts.push(`${issues.balanceDiffs} عميل رصيده المحسوب من الحركات يختلف عن رصيد القاعدة`);
    if (issues.checksUnmatched) parts.push(`${issues.checksUnmatched} حساب له شيكات مفتوحة وغير موجود في قاعدة العملاء`);
    if (state.sheets.checksError) parts.push(`الشيكات غير محسوبة: ${state.sheets.checksError}`);
    return parts.length ? `مراجعة البيانات: ${parts.join('، ')}.` : '';
  }

  function recompute() {
    const { base, tx, analysisDay, checks } = state.sheets;
    state.result = Engine.analyze(base, tx, state.rules, analysisDay, checks);
    state.result.invoices.forEach((inv, key) => { inv.key = key; });
    state.checkList = readChecks();
    const prepared = state.sheets.dataAt ? ` · البيانات من ${timeOf(state.sheets.dataAt)}` : '';
    $('stamp').textContent = `المتأخرات حتى ${dateOf(state.result.analysisDay)}${prepared}`;
    $('snapshotInfo').textContent = state.sheets.dataAt ? `آخر تجهيز: ${timeOf(state.sheets.dataAt)}` : '';
    const demoNote = state.isDemo ? 'هذه بيانات نموذجية للتجربة وليست بيانات حقيقية. ' : '';
    banner([cacheNote(), (demoNote + issuesText(state.result.issues)).trim()].filter(Boolean).join(' '));
    fillRepFilter();
    fillCustomerList();
    fillRulesForm();
    state.shown = PAGE_SIZE;
    renderInvoices();
    if (document.body.dataset.view === 'checks') renderChecks();
    if (document.body.dataset.view === 'customer' && state.customerAccount) renderCustomer();
    $('checkResult').innerHTML = '';
  }

  async function loadData() {
    banner('جارٍ قراءة البيانات من الشيت، وقد يستغرق ذلك بعض الوقت…');
    $('reload').disabled = true;
    try {
      const data = await callScript('data');
      state.sheets = {
        base: data.base, tx: data.tx, analysisDay: data.analysisDay, checks: data.checks, checksError: data.checksError, dataAt: data.dataAt || null,
      };
      state.rules = data.rules;
      state.build = data.build || state.build;
      state.cacheSavedAt = null;
      console.info('data read', data.stats);
      recompute();
      show('invoices');
      await saveCache();
    } catch (e) {
      console.error(e);
      if (state.token) banner([cacheNote(), e.message].filter(Boolean).join(' '), true);
    } finally {
      $('reload').disabled = false;
    }
  }

  // A reload first validates the session with a fast ping, then shows the
  // snapshot if it is still usable. The sheets are read only when needed.
  async function boot() {
    signedIn();
    show('invoices');
    banner('جارٍ التحقق من الجلسة وعرض البيانات…');
    const cached = await readCache();
    let ping;
    try {
      const data = await callScript('ping');
      ping = { user: data.user || state.user, rules: data.rules || state.rules, build: data.build || '' };
    } catch (e) {
      if (!state.token) return;  // the session ended; signedOut already ran
      if (cached) {
        applyCache(cached, null);
        banner(`تعذّر التحقق من الجلسة: ${e.message} ${cacheNote()}`, true);
      } else if (/تعذّر الوصول/.test(e.message)) {
        banner(e.message, true);
      } else {
        await loadData();
      }
      return;
    }
    if (!cached) { await loadData(); return; }
    if (cached.build && ping.build && cached.build !== ping.build) { await loadData(); return; }
    if (scopeOf(cached.user) !== scopeOf(ping.user)) { await loadData(); return; }
    if (ruleKey(cached.rules) !== ruleKey(ping.rules)) { await loadData(); return; }
    applyCache(cached, ping.user);
    if (Date.now() - cached.savedAt >= CACHE_TTL) await loadData();
  }

  function loadDemo() {
    const { base, tx, checks } = window.demoSheets();
    state.isDemo = true;
    state.cacheSavedAt = null;
    state.sheets = { base, tx, analysisDay: null, checks, checksError: '' };
    state.rules = Engine.DEFAULT_RULES;
    state.user = null;
    $('whoami').textContent = 'وضع التجربة';
    $('userAvatar').textContent = 'ت';
    $('loginError').hidden = true;
    signedIn();
    recompute();
    show('invoices');
  }

  /* ---- navigation ------------------------------------------------------------- */

  function show(view) {
    for (const name of ['login', 'invoices', 'check', 'checks', 'customer', 'requests', 'users', 'audit', 'settings']) $(`view-${name}`).hidden = name !== view;
    document.querySelectorAll('.tabs button').forEach((b) => {
      if (b.dataset.view === view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    document.body.dataset.view = view;
    const meta = VIEW_META[view];
    if (meta) {
      $('pageTitle').textContent = meta[0];
      $('pageSubtitle').textContent = meta[1];
      document.title = `${meta[0]} · موقف الفواتير`;
    }
    if (view === 'checks' && state.result) renderChecks();
    if (view === 'customer' && state.result) renderCustomer();
    document.body.classList.remove('nav-open');
    $('menuToggle').setAttribute('aria-expanded', 'false');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  function closeNav() {
    document.body.classList.remove('nav-open');
    $('menuToggle').setAttribute('aria-expanded', 'false');
  }

  function applyTheme(theme, persist) {
    const root = document.documentElement;
    if (theme) root.dataset.theme = theme;
    else delete root.dataset.theme;
    if (persist) {
      try {
        if (theme) localStorage.setItem(THEME_KEY, theme);
        else localStorage.removeItem(THEME_KEY);
      } catch (e) {
        console.warn('theme not saved', e);
      }
    }
    const dark = theme ? theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    const btn = $('themeToggle');
    btn.innerHTML = `<svg class="icon"><use href="#i-${dark ? 'sun' : 'moon'}"></use></svg>`;
    const label = dark ? 'التبديل إلى المظهر الفاتح' : 'التبديل إلى المظهر الداكن';
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }

  function initTheme() {
    let saved = '';
    try {
      saved = localStorage.getItem(THEME_KEY) || '';
    } catch (e) {
      saved = '';
    }
    applyTheme(saved === 'dark' || saved === 'light' ? saved : null, false);
  }

  /* ---- invoices screen ------------------------------------------------------ */

  function fillRepFilter() {
    const reps = [...new Set(state.result.invoices.map((i) => i.rep))].sort((a, b) => a.localeCompare(b, 'ar'));
    const current = $('rep').value;
    $('rep').innerHTML = `<option value="">كل المندوبين</option>${reps.map((r) => `<option>${esc(r)}</option>`).join('')}`;
    if (reps.includes(current)) $('rep').value = current;
  }

  function kpiCard(icon, tone, label, value, sub) {
    return `<article class="kpi kpi-${tone}">
      <div class="kpi-top">
        <span class="kpi-icon"><svg class="icon"><use href="#i-${icon}"></use></svg></span>
        <span class="kpi-label">${esc(label)}</span>
      </div>
      <strong class="kpi-value">${esc(value)}</strong>
      <span class="kpi-sub">${esc(sub)}</span>
    </article>`;
  }

  function renderAgingChart(s) {
    const max = Math.max(1, ...s.aging);
    $('aging').innerHTML = Engine.AGING_BUCKETS.map((label, i) => {
      const height = Math.max(5, Math.round((s.aging[i] / max) * 100));
      return `<button type="button" class="bar-col" data-bucket="${i}" aria-pressed="${state.bucket === i}" title="${esc(label)}: ${money(s.aging[i])}">
        <span class="bar-value">${money(s.aging[i])}</span>
        <span class="bar-track"><span class="bar bar-${i}" style="height:${height}%"></span></span>
        <span class="bar-label">${esc(label)}</span>
      </button>`;
    }).join('');
  }

  function renderStatusChart(s) {
    const order = [
      ['stop', 'حرجة', 'var(--c-stop)'],
      ['warn', 'تحتاج متابعة', 'var(--c-warn)'],
      ['ok', 'منتظمة', 'var(--c-ok)'],
      ['paid', 'مسددة', 'var(--c-paid)'],
    ];
    const total = order.reduce((n, [key]) => n + s.byVerdict[key].count, 0);
    let acc = 0;
    const stops = [];
    for (const [key] of order) {
      const count = s.byVerdict[key].count;
      if (!count || !total) continue;
      const to = acc + (count / total) * 100;
      stops.push(`var(--c-${key}) ${acc.toFixed(2)}% ${to.toFixed(2)}%`);
      acc = to;
    }
    const gradient = stops.length
      ? `conic-gradient(from -90deg, ${stops.join(', ')})`
      : 'conic-gradient(var(--line), var(--line))';
    const legend = order.map(([key, label, color]) => `
      <li><span class="dot" style="--dc:${color}"></span>${esc(label)}<b>${money(s.byVerdict[key].count)}</b></li>`).join('');
    $('statusChart').innerHTML = `
      <div class="donut" style="background:${gradient}">
        <div class="donut-hole">
          <span>${money(total)} فاتورة</span>
          <strong>${money(s.openAmount)}</strong>
          <small>متبقٍ مفتوح</small>
        </div>
      </div>
      <ul class="legend">${legend}</ul>`;
  }

  function renderKpis() {
    const s = state.result.summary;
    const pct = (v) => (s.openAmount ? `${Math.round((v / s.openAmount) * 100)}% من المفتوح` : '—');
    $('kpis').innerHTML = [
      kpiCard('wallet', 'primary', 'الفواتير المفتوحة', money(s.openAmount), `${money(s.open)} فاتورة من ${money(s.invoices)}`),
      kpiCard('clock', 'warn', 'المتأخرات', money(s.overdueAmount), pct(s.overdueAmount)),
      kpiCard('shield', 'warn', 'غير مغطى بالضمان', money(s.uncoveredAmount), pct(s.uncoveredAmount)),
      kpiCard('alert', 'stop', 'تجاوز حد الائتمان', money(s.overLimitAmount), `${money(s.overLimitCustomers)} عميل`),
      kpiCard('ban', 'stop', 'فواتير حرجة', money(s.byVerdict.stop.count), `متبقٍ ${money(s.byVerdict.stop.amount)}`),
      s.hasChecks ? kpiCard('check-circle', 'info', 'شيكات مفتوحة', money(s.checksOpen), `مستحقة ${money(s.checksDueCount)} · مرفوضة ${money(s.checksRejectedCount)}`) : '',
    ].join('');
    renderAgingChart(s);
    renderStatusChart(s);
  }

  function matchingInvoices() {
    const q = $('q').value.trim().toLowerCase();
    const verdict = $('verdict').value;
    const rep = $('rep').value;
    const order = { stop: 0, warn: 1, ok: 2, paid: 3 };
    return state.result.invoices
      .filter((i) => {
        if (verdict === 'open' && !i.isOpen) return false;
        if (!['open', 'all'].includes(verdict) && i.verdict !== verdict) return false;
        if (rep && i.rep !== rep) return false;
        if (state.bucket != null && i.bucket !== state.bucket) return false;
        return !q || [i.number, i.voucher, i.customer, i.account].some((v) => String(v).toLowerCase().includes(q));
      })
      .sort((a, b) => order[a.verdict] - order[b.verdict] || b.overdueDays - a.overdueDays || b.remaining - a.remaining);
  }

  function noteCell(check, extra) {
    const applies = check.label !== 'لا ينطبق';
    const cls = applies ? check.level : 'none';
    const detail = extra || (check.amount >= 1 ? money(check.amount) : '');
    return `<span class="note ${cls}">${esc(check.label)}${detail ? `<small>${esc(detail)}</small>` : ''}</span>`;
  }

  function renderInvoices() {
    renderKpis();
    const list = matchingInvoices();
    state.filtered = list;
    const total = list.reduce((s, i) => s + (i.isOpen ? i.remaining : 0), 0);
    $('count').textContent = `${money(list.length)} فاتورة · المتبقي ${money(total)}`;
    if (!list.length) {
      $('rows').innerHTML = '<tr><td colspan="10" class="empty">لا توجد فواتير مطابقة.</td></tr>';
      $('more').hidden = true;
      return;
    }
    const shown = list.slice(0, state.shown);
    $('rows').innerHTML = shown.map((i) => `
      <tr tabindex="0" data-key="${i.key}">
        <td>${esc(i.number)}<span class="sub">${esc(i.type)}</span></td>
        <td><button type="button" class="link-btn" data-account="${esc(i.account)}">${esc(i.customer)}</button><span class="sub">${esc(i.account)} · ${esc(i.rep)}</span></td>
        <td class="date">${dateOf(i.day)}</td>
        <td class="n">${money(i.amount)}</td>
        <td class="n">${money(i.remaining)}</td>
        <td class="date">${dateOf(i.dueDay)}</td>
        <td>${noteCell(i.checks.credit)}</td>
        <td>${noteCell(i.checks.guarantee)}</td>
        <td>${noteCell(i.checks.arrears)}</td>
        <td><span class="tag ${i.verdict}">${VERDICT[i.verdict]}</span></td>
      </tr>`).join('');
    $('more').hidden = list.length <= state.shown;
  }

  /* ---- invoice detail --------------------------------------------------------- */

  function customerFacts(c) {
    const row = (k, v) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`;
    return `<dl>
      ${row('الرصيد', money(c.balance))}
      ${row('حد الائتمان', c.creditLimit > 0 ? money(c.creditLimit) : 'لا يوجد')}
      ${row('المتاح من الحد', c.creditLimit > 0 ? money(c.availableCredit) : '—')}
      ${row('الضمان', c.guarantee > 0 ? money(c.guarantee) : 'لا يوجد')}
      ${row('غير مغطى بالضمان', money(c.uncovered))}
      ${row('المتأخرات', money(c.overdue))}
      ${row('أقدم تأخير', c.oldestOverdueDays ? `${c.oldestOverdueDays} يوم` : '—')}
      ${row('شروط السداد', c.terms || 'غير محددة')}
      ${row('ID number', c.idNumber || 'فارغ')}
      ${row('Warehouse Group', c.warehouse || 'فارغ')}
      ${row('Customer group', c.group || 'فارغ')}
      ${c.hasChecks ? row('شيكات مفتوحة', `${money(c.checksOpen)} (${c.checksOpenCount})`) : ''}
      ${c.hasChecks ? row('الرصيد شامل الشيكات', money(c.exposure)) : ''}
      ${c.hasChecks ? row('شيكات مستحقة لم تُصرف', c.checksDueCount ? `${money(c.checksDue)} (${c.checksDueCount})` : '—') : ''}
      ${c.hasChecks ? row('شيكات مرفوضة', c.checksRejectedCount ? `${money(c.checksRejected)} (${c.checksRejectedCount})` : '—') : ''}
      ${c.hasChecks && c.checksNextDue != null ? row('أقرب استحقاق شيك', dateOf(c.checksNextDue)) : ''}
    </dl>`;
  }

  function openDetail(inv) {
    const c = state.result.customers.find((x) => x.account === inv.account);
    const row = (k, v) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`;
    const creditNote = inv.isSale
      ? `<p class="muted">فحص الائتمان يقارن رصيد العميل بعد الفاتورة (${money(inv.balanceAfter)}) بحده الحالي، لأن الشيت لا يحفظ تاريخ تغيير الحدود.</p>`
      : '';
    const others = c.invoices.filter((x) => x.isOpen && x !== inv);
    $('detailBody').innerHTML = `
      <h2 id="detailTitle">${esc(inv.type)} ${esc(inv.number)} <span class="tag ${inv.verdict}">${VERDICT[inv.verdict]}</span></h2>
      <p class="muted">${esc(inv.customer)} · ${esc(inv.account)}</p>
      <p class="actions"><button type="button" class="btn ghost" data-account="${esc(inv.account)}">
        <svg class="icon"><use href="#i-users"></use></svg><span>ملف العميل 360</span>
      </button></p>
      <h3>الفاتورة</h3>
      <div class="panel"><dl>
        ${row('تاريخ الفاتورة', dateOf(inv.day))}
        ${row('تاريخ الاستحقاق', dateOf(inv.dueDay))}
        ${row('القيمة', money(inv.amount))}
        ${row('المسدد', money(inv.paid))}
        ${row('المتبقي', money(inv.remaining))}
        ${inv.settledDay != null ? row('تاريخ اكتمال السداد', dateOf(inv.settledDay)) : ''}
        ${row('متأخرات العميل عند الإصدار', money(inv.arrearsAtIssue))}
        ${inv.isOpen ? row('المغطى بالضمان', money(inv.covered)) : ''}
        ${inv.isOpen ? row('غير المغطى', money(inv.uncovered)) : ''}
      </dl></div>
      <h3>الموقف</h3>
      <div class="panel cards">
        <div><h3>الائتمان</h3>${noteCell(inv.checks.credit)}</div>
        <div><h3>الضمان</h3>${noteCell(inv.checks.guarantee)}</div>
        <div><h3>المتأخرات</h3>${noteCell(inv.checks.arrears)}</div>
      </div>
      ${creditNote}
      <h3>موقف العميل الحالي</h3>
      <div class="panel">${customerFacts(c)}</div>
      ${others.length ? `<h3>فواتيره المفتوحة الأخرى (${others.length})</h3>
      <div class="inner-wrap"><table>
        <thead><tr><th>الفاتورة</th><th>التاريخ</th><th class="n">المتبقي</th><th>التأخير</th><th>الموقف</th></tr></thead>
        <tbody>${others.slice(0, 50).map((x) => `<tr>
          <td>${esc(x.number)}</td><td class="date">${dateOf(x.day)}</td><td class="n">${money(x.remaining)}</td>
          <td>${x.overdueDays ? `${x.overdueDays} يوم` : '—'}</td><td><span class="tag ${x.verdict}">${VERDICT[x.verdict]}</span></td>
        </tr>`).join('')}</tbody>
      </table></div>` : ''}`;
    $('detail').showModal();
    $('detail').scrollTop = 0;  // showModal scrolls down to the focused close button
  }

  /* ---- new-invoice check ------------------------------------------------------- */

  function fillCustomerList() {
    $('customerList').innerHTML = state.result.customers
      .map((c) => `<option value="${esc(c.account)} — ${esc(c.name)}"></option>`).join('');
  }

  function findCustomer(text) {
    const t = text.trim().toLowerCase();
    if (!t) return null;
    const list = state.result.customers;
    const account = t.split(' — ')[0];
    return list.find((c) => c.account.toLowerCase() === account)
      || list.find((c) => c.name.toLowerCase() === t)
      || null;
  }

  function renderCheck(event) {
    event.preventDefault();
    if (!state.result) { $('checkResult').innerHTML = '<p class="empty">انتظر تحميل البيانات أولًا.</p>'; return; }
    const c = findCustomer($('checkCustomer').value);
    if (!c) { $('checkResult').innerHTML = '<p class="empty">لم أجد هذا العميل في نطاقك. اختره من القائمة.</p>'; return; }
    const amount = Number($('checkAmount').value);
    const r = Engine.evaluateNew(c, amount, state.result.rules);
    // One ref per check, so a retried send cannot register the request twice.
    state.lastCheck = { c, r, amount, ref: `R${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` };
    const [title, sub] = NEW_VERDICT[r.verdict];
    const card = (name, check, why) => `<div class="panel"><h3>${name}</h3>${noteCell(check)}<p class="why">${esc(why)}</p></div>`;
    const afterLabel = c.hasChecks ? 'الرصيد شامل الشيكات بعد الفاتورة' : 'الرصيد بعد الفاتورة';
    const creditWhy = c.stopped ? 'حساب العميل موقوف.'
      : c.creditLimit <= 0 ? 'لا يوجد حد ائتمان مسجل لهذا العميل.'
      : `${afterLabel} ${money(r.exposureAfter)} من حد ${money(c.creditLimit)}. المتاح الآن ${money(r.maxByCredit)}.`;
    const guaranteeWhy = c.guarantee > 0
      ? `الضمان ${money(c.guarantee)}، وغير المغطى بعد الفاتورة ${money(r.uncovered)}.`
      : `لا يوجد ضمان، و${afterLabel} ${money(r.exposureAfter)}.`;
    const chequesWhy = !c.hasChecks ? 'شيت الشيكات غير مربوط، فالرصيد لا يشمل الشيكات تحت التحصيل.'
      : c.checksRejectedCount ? `${c.checksRejectedCount} شيك مرفوض بقيمة ${money(c.checksRejected)} لم يُسوَّ بعد.`
      : c.checksDueCount ? `${c.checksDueCount} شيك استحق ولم يُصرف بقيمة ${money(c.checksDue)}.`
      : c.checksOpenCount ? `${c.checksOpenCount} شيك تحت التحصيل بقيمة ${money(c.checksOpen)}، ومحسوبة في الرصيد.`
      : 'لا توجد شيكات مفتوحة على العميل.';
    const arrearsWhy = c.overdue >= 1
      ? `متأخرات ${money(c.overdue)}، وأقدمها متأخر ${c.oldestOverdueDays} يوم. تصبح حرجة بعد ${state.result.rules.stopDays} يوم.`
      : 'لا توجد متأخرات على العميل.';
    $('checkResult').innerHTML = `
      <div class="result">
        <div class="decision ${r.verdict}">${title}<small>${esc(c.name)} · فاتورة بقيمة ${money(amount)}. ${sub}</small></div>
        <div class="actions"><button type="button" class="btn ghost" data-account="${esc(c.account)}">
          <svg class="icon"><use href="#i-users"></use></svg><span>ملف العميل 360</span>
        </button></div>
        <div class="cards">
          ${card('الائتمان', r.checks.credit, creditWhy)}
          ${card('الضمان', r.checks.guarantee, guaranteeWhy)}
          ${card('المتأخرات', r.checks.arrears, arrearsWhy)}
          ${card('الشيكات', r.checks.cheques, chequesWhy)}
        </div>
        <div class="panel request-form">
          <h3>تسجيل طلب الفاتورة</h3>
          <label>ملاحظات الطلب
            <textarea id="requestNote" rows="2"></textarea>
          </label>
          <div class="actions"><button type="button" id="sendRequest">سجّل الطلب</button></div>
          <p id="requestMsg" aria-live="polite"></p>
        </div>
        <div class="panel"><h3>موقف العميل الحالي</h3>${customerFacts(c)}</div>
      </div>`;
    $('sendRequest').addEventListener('click', sendRequest);
  }

  /* ---- checks center ---------------------------------------------------------- */

  // One list from both check tabs. A customer missing from the base still shows,
  // so an unmatched check stays visible instead of disappearing.
  function readChecks() {
    if (!state.sheets || !state.sheets.checks) return [];
    let list;
    try {
      list = Engine.parseChecks(state.sheets.checks.main, state.sheets.checks.wh);
    } catch (e) {
      console.warn('checks not parsed', e);
      return [];
    }
    const byAccount = new Map();
    for (const c of state.result ? state.result.customers : []) byAccount.set(String(c.account).trim(), c);
    return list.map((k) => {
      const c = byAccount.get(String(k.account).trim());
      return Object.assign({}, k, { customer: c ? c.name : 'غير موجود في قاعدة العملاء', known: !!c });
    });
  }

  function checkStatus(k) {
    if (!k.open) return { key: 'closed', label: 'مغلق', tag: 'paid' };
    if (k.rejected) return { key: 'rejected', label: 'مرفوض', tag: 'stop' };
    if (k.due != null && k.due <= state.result.analysisDay) return { key: 'due', label: 'مستحق', tag: 'warn' };
    return { key: 'open', label: 'تحت التحصيل', tag: 'ok' };
  }

  function checkTiming(k) {
    if (!k.open || k.due == null) return '—';
    const days = k.due - state.result.analysisDay;
    if (days > 0) return `بعد ${money(days)} يوم`;
    if (days === 0) return 'مستحق اليوم';
    return `متأخر ${money(-days)} يوم`;
  }

  function filteredChecks() {
    const q = $('checkQuery').value.trim().toLowerCase();
    const status = $('checkStatus').value;
    const source = $('checkSource').value;
    const list = (state.checkList || []).filter((k) => {
      if (status && checkStatus(k).key !== status) return false;
      if (source && k.src !== source) return false;
      return !q || [k.checkNo, k.account, k.customer].some((v) => String(v == null ? '' : v).toLowerCase().includes(q));
    });
    const rank = (k) => ({ rejected: 0, due: 1, open: 2, closed: 3 }[checkStatus(k).key]);
    const dueKey = (k) => (k.due == null ? Number.MAX_SAFE_INTEGER : k.due);
    const sort = $('checkSort').value;
    return list.sort((a, b) => {
      if (sort === 'amount') return b.net - a.net || a.customer.localeCompare(b.customer, 'ar');
      if (sort === 'customer') return a.customer.localeCompare(b.customer, 'ar') || String(a.checkNo).localeCompare(String(b.checkNo), 'ar');
      return rank(a) - rank(b) || dueKey(a) - dueKey(b) || b.net - a.net;
    });
  }

  function renderChecks() {
    if (!state.result) return;
    const all = state.checkList || [];
    const open = all.filter((k) => k.open);
    const due = open.filter((k) => !k.rejected && k.due != null && k.due <= state.result.analysisDay);
    const rejected = open.filter((k) => k.rejected);
    const next = open
      .filter((k) => !k.rejected && k.due != null && k.due > state.result.analysisDay)
      .sort((a, b) => a.due - b.due)[0];
    const sum = (list) => list.reduce((n, k) => n + (Number(k.net) || 0), 0);
    $('checkKpis').innerHTML = [
      kpiCard('wallet', 'primary', 'شيكات مفتوحة', money(sum(open)), `${money(open.length)} شيك`),
      kpiCard('clock', 'warn', 'مستحقة لم تُصرف', money(sum(due)), `${money(due.length)} شيك`),
      kpiCard('ban', 'stop', 'شيكات مرفوضة', money(sum(rejected)), `${money(rejected.length)} شيك`),
      next
        ? kpiCard('check-circle', 'info', 'أقرب استحقاق', dateOf(next.due), `${next.checkNo} · بعد ${next.due - state.result.analysisDay} يوم`)
        : kpiCard('check-circle', 'info', 'أقرب استحقاق', '—', all.length ? 'لا يوجد استحقاق قادم' : 'شيت الشيكات غير متاح'),
    ].join('');
    const list = filteredChecks();
    $('checksCount').innerHTML = `<span class="chip">${money(list.length)} شيك · ${money(sum(list.filter((k) => k.open)))} مفتوح</span>`;
    const shown = list.slice(0, state.checkShown);
    $('checksMore').hidden = shown.length >= list.length;
    if (!list.length) {
      $('checkRows').innerHTML = `<tr><td colspan="8" class="empty">${all.length ? 'لا توجد شيكات مطابقة.' : 'شيت الشيكات غير متاح أو لا يحتوي بيانات.'}</td></tr>`;
      return;
    }
    $('checkRows').innerHTML = shown.map((k) => {
      const st = checkStatus(k);
      return `<tr>
        <td>${esc(k.checkNo || '—')}<span class="sub">${k.src === 'wh' ? 'شيك مخازن' : 'الشيت الرئيسي'}</span></td>
        <td><button type="button" class="link-btn" data-account="${esc(k.account)}">${esc(k.customer)}</button><span class="sub">${esc(k.account)}</span></td>
        <td class="n">${money(k.amount)}</td>
        <td class="n">${money(k.net)}</td>
        <td class="date">${dateOf(k.due)}</td>
        <td>${esc(checkTiming(k))}</td>
        <td>${k.src === 'wh' ? 'مخازن' : 'رئيسي'}</td>
        <td><span class="tag ${st.tag}">${st.label}</span></td>
      </tr>`;
    }).join('');
  }

  function exportChecks() {
    const header = ['الشيك', 'العميل', 'الكود', 'المصدر', 'القيمة', 'الصافي', 'الاستحقاق', 'المهلة', 'الحالة'];
    const rows = filteredChecks().map((k) => [
      k.checkNo, k.customer, k.account, k.src === 'wh' ? 'مخازن' : 'رئيسي',
      Math.round(k.amount), Math.round(k.net), k.due == null ? '' : dateOf(k.due),
      checkTiming(k), checkStatus(k).label,
    ]);
    downloadCsv(`الشيكات-${dateOf(state.result.analysisDay)}.csv`, header, rows);
  }

  /* ---- customer profile ------------------------------------------------------- */

  function customerByAccount(account) {
    if (!state.result) return null;
    const key = String(account).trim();
    return state.result.customers.find((c) => String(c.account).trim() === key) || null;
  }

  function openCustomer(account, from) {
    const c = customerByAccount(account);
    if (!c) {
      banner(`لم أجد العميل ${account} في نطاقك الحالي.`, true);
      return;
    }
    state.customerAccount = c.account;
    state.customerFrom = from || (document.body.dataset.view !== 'customer' ? document.body.dataset.view : 'invoices');
    show('customer');
  }

  function customerChecks(c) {
    const key = String(c.account).trim();
    return (state.checkList || []).filter((k) => String(k.account).trim() === key);
  }

  function customerRequestsHtml(c) {
    if (!state.requestsLoaded) {
      return state.isDemo
        ? '<p class="empty">الطلبات لا تُقرأ في وضع البيانات النموذجية.</p>'
        : `<p class="muted">لم تُقرأ الطلبات في هذه الجلسة بعد.</p>
           <button type="button" class="btn ghost" data-load-requests>جلب طلبات العميل</button>`;
    }
    const key = String(c.account).trim();
    const list = state.requests
      .filter((r) => String(r.account).trim() === key)
      .slice()
      .reverse();
    if (!list.length) return '<p class="empty">لا توجد طلبات مسجلة لهذا العميل.</p>';
    return `<div class="table-wrap compact-table"><table>
      <thead><tr><th>الطلب</th><th class="n">القيمة</th><th>الفحص</th><th>الحالة</th><th>التاريخ</th></tr></thead>
      <tbody>${list.slice(0, 20).map((r) => `
        <tr>
          <td><button type="button" class="link-btn" data-review-request="${esc(r.id)}">${esc(r.id)}</button><span class="sub">${esc(r.requester || '')}</span></td>
          <td class="n">${money(r.amount)}</td>
          <td><span class="tag ${VERDICT_TAG[r.verdict] || 'paid'}">${esc(r.verdict)}</span><span class="sub">${esc(r.reasons || '')}</span></td>
          <td><span class="tag ${STATUS_TAG[r.status] || 'paid'}">${esc(r.status)}</span>${r.decisionNote ? `<span class="sub">${esc(r.decisionNote)}</span>` : ''}</td>
          <td class="date">${esc(r.createdAt)}</td>
        </tr>`).join('')}</tbody>
    </table></div>${list.length > 20 ? `<p class="muted profile-note">يُعرض أحدث 20 طلبًا من ${money(list.length)}.</p>` : ''}`;
  }

  function renderCustomer() {
    const c = customerByAccount(state.customerAccount);
    if (!c) { show('invoices'); return; }
    const checks = customerChecks(c);
    const openChecks = checks.filter((k) => k.open);
    const rejected = openChecks.filter((k) => k.rejected);
    const dueChecks = openChecks.filter((k) => !k.rejected && k.due != null && k.due <= state.result.analysisDay);
    const sum = (list) => list.reduce((n, k) => n + (Number(k.net) || 0), 0);
    const invoices = c.invoices.slice().sort((a, b) => (b.isOpen - a.isOpen) || b.day - a.day);
    const from = { checks: 'مركز الشيكات', requests: 'الطلبات', check: 'فحص فاتورة جديدة', invoices: 'الفواتير' }[state.customerFrom] || 'الفواتير';
    const stateTag = c.stopped ? '<span class="tag stop">حساب موقوف</span>'
      : c.overLimit > 0 ? '<span class="tag warn">تجاوز الحد</span>'
      : c.overdue > 0 ? '<span class="tag warn">عليه متأخرات</span>'
      : '<span class="tag ok">منتظم</span>';
    $('customerBody').innerHTML = `
      <section class="profile-head panel">
        <span class="avatar lg" aria-hidden="true">${esc((c.name || c.account).trim().charAt(0))}</span>
        <div class="profile-id">
          <h2>${esc(c.name)} ${stateTag}</h2>
          <p class="muted">${esc(c.account)} · ${esc(c.warehouse || 'بلا مخزن')} · ${esc(c.group || 'بلا مجموعة')} · ${esc(c.rep || 'بلا مندوب')}</p>
        </div>
        <div class="actions">
          <button type="button" class="btn ghost" data-back>رجوع إلى ${esc(from)}</button>
          <button type="button" class="btn" data-check-customer="${esc(c.account)}">
            <svg class="icon"><use href="#i-check"></use></svg><span>فحص فاتورة</span>
          </button>
        </div>
      </section>
      <div class="kpis kpis-4">
        ${kpiCard('wallet', 'primary', 'الرصيد', money(c.balance), 'بدون الشيكات المفتوحة')}
        ${kpiCard('check-circle', 'info', 'الرصيد شامل الشيكات', money(c.exposure), `${money(c.checksOpenCount)} شيك مفتوح`)}
        ${kpiCard('shield', c.creditLimit > 0 ? 'ok' : 'warn', 'المتاح من حد الائتمان', c.creditLimit > 0 ? money(c.availableCredit) : 'لا يوجد حد', c.creditLimit > 0 ? `الحد ${money(c.creditLimit)}` : 'حد الائتمان غير مسجل')}
        ${kpiCard('clock', c.overdue > 0 ? 'warn' : 'ok', 'المتأخرات', money(c.overdue), c.oldestOverdueDays ? `أقدمها ${money(c.oldestOverdueDays)} يوم` : 'لا توجد متأخرات')}
      </div>
      <div class="profile-grid">
        <section class="panel"><h3>الموقف الائتماني</h3>${customerFacts(c)}</section>
        <section class="panel">
          <h3>ملخص الشيكات</h3>
          <dl>
            <dt>شيكات مفتوحة</dt><dd>${money(sum(openChecks))} · ${money(openChecks.length)} شيك</dd>
            <dt>مستحقة لم تُصرف</dt><dd>${money(sum(dueChecks))} · ${money(dueChecks.length)} شيك</dd>
            <dt>مرفوضة</dt><dd>${money(sum(rejected))} · ${money(rejected.length)} شيك</dd>
            <dt>أقرب استحقاق</dt><dd>${c.checksNextDue != null ? dateOf(c.checksNextDue) : '—'}</dd>
          </dl>
          ${checks.length ? `<h3 class="sub-head">شيكات العميل (${money(checks.length)})</h3>
          <div class="table-wrap compact-table"><table>
            <thead><tr><th>الشيك</th><th class="n">الصافي</th><th>الاستحقاق</th><th>الحالة</th></tr></thead>
            <tbody>${checks.slice().sort((a, b) => (a.open === b.open ? 0 : a.open ? -1 : 1)
              || (a.due == null ? Number.MAX_SAFE_INTEGER : a.due) - (b.due == null ? Number.MAX_SAFE_INTEGER : b.due)).map((k) => {
              const st = checkStatus(k);
              return `<tr><td>${esc(k.checkNo || '—')}<span class="sub">${k.src === 'wh' ? 'مخازن' : 'رئيسي'}</span></td>
                <td class="n">${money(k.net)}</td><td class="date">${dateOf(k.due)}</td>
                <td><span class="tag ${st.tag}">${st.label}</span></td></tr>`;
            }).join('')}</tbody>
          </table></div>` : '<p class="empty">لا توجد شيكات على هذا العميل.</p>'}
        </section>
      </div>
      <section class="card table-card">
        <div class="card-head"><div><h2>فواتير العميل</h2><p class="muted">${money(invoices.length)} فاتورة · ${money(invoices.filter((x) => x.isOpen).length)} مفتوحة</p></div></div>
        <div class="table-wrap"><table>
          <thead><tr><th>الفاتورة</th><th>التاريخ</th><th class="n">القيمة</th><th class="n">المتبقي</th><th>الاستحقاق</th><th>الموقف</th></tr></thead>
          <tbody>${invoices.length ? invoices.slice(0, 30).map((x) => `
            <tr><td><button type="button" class="link-btn" data-invoice="${x.key}">${esc(x.number)}</button><span class="sub">${esc(x.type)}</span></td>
              <td class="date">${dateOf(x.day)}</td><td class="n">${money(x.amount)}</td><td class="n">${money(x.remaining)}</td>
              <td class="date">${dateOf(x.dueDay)}</td><td><span class="tag ${x.verdict}">${VERDICT[x.verdict]}</span></td></tr>`).join('')
            : '<tr><td colspan="6" class="empty">لا توجد فواتير لهذا العميل.</td></tr>'}</tbody>
        </table></div>
        ${invoices.length > 30 ? `<p class="muted profile-note">يُعرض أحدث 30 فاتورة من ${money(invoices.length)}.</p>` : ''}
      </section>
      <section class="panel customer-requests">
        <h3>طلبات العميل</h3>
        ${customerRequestsHtml(c)}
      </section>`;
  }

  /* ---- requests and approvals --------------------------------------------------- */

  async function sendRequest() {
    const { c, r, amount, ref } = state.lastCheck;
    const msg = $('requestMsg');
    if (state.isDemo) {
      msg.className = 'form-error';
      msg.textContent = 'لا يمكن تسجيل طلب من البيانات النموذجية.';
      return;
    }
    $('sendRequest').disabled = true;
    msg.className = '';
    msg.textContent = 'جارٍ الفحص في الخادم والتسجيل، وقد يستغرق ذلك بعض الوقت…';
    try {
      const data = await callScript('add', { account: c.account, amount, note: $('requestNote').value, ref });
      const previewLabel = { ok: 'سليمة', warn: 'تحتاج موافقة', stop: 'موقوفة' }[r.verdict];
      const changed = data.request.verdict !== previewLabel
        ? ` تغيّرت نتيجة الفحص إلى "${data.request.verdict}" لأن الخادم استخدم أحدث البيانات.` : '';
      msg.className = 'ok-msg';
      msg.textContent = `تم تسجيل الطلب ${data.request.id}: ${data.request.status}.${changed}`;
    } catch (e) {
      msg.className = 'form-error';
      msg.textContent = e.message;
      $('sendRequest').disabled = false;
    }
  }

  async function loadRequests() {
    $('requestsReload').disabled = true;
    $('requestsCount').textContent = 'جارٍ قراءة الطلبات…';
    try {
      const data = await callScript('list');
      state.requests = data.requests;
      state.requestsLoaded = true;
      state.requestShown = REQUEST_PAGE;
      renderRequests();
      if (state.customerAccount && document.body.dataset.view === 'customer') renderCustomer();
    } catch (e) {
      state.requests = [];
      state.requestsLoaded = false;
      $('requestRows').innerHTML = '';
      $('requestsMore').hidden = true;
      $('requestsCount').textContent = e.message;
      if (state.customerAccount && document.body.dataset.view === 'customer') renderCustomer();
    } finally {
      $('requestsReload').disabled = false;
    }
  }

  function requestFilters() {
    return {
      status: $('requestStatus').value,
      from: $('requestFrom').value,
      to: $('requestTo').value,
      q: $('requestQuery').value.trim().toLowerCase(),
    };
  }

  function requestMatches(r, f) {
    if (f.status && r.status !== f.status) return false;
    const day = String(r.createdAt || '').slice(0, 10);
    if (f.from && day < f.from) return false;
    if (f.to && day > f.to) return false;
    if (!f.q) return true;
    return [r.id, r.customer, r.account, r.rep, r.requester, r.note]
      .some((v) => String(v == null ? '' : v).toLowerCase().includes(f.q));
  }

  // Newest first, then the active filters. The page size only limits drawing.
  function filteredRequests() {
    const f = requestFilters();
    return state.requests.filter((r) => requestMatches(r, f)).reverse();
  }

  function renderRequests() {
    const list = filteredRequests();
    const pending = state.requests.filter((r) => r.status === 'قيد الاعتماد');
    const pendingTotal = pending.reduce((s, r) => s + Number(r.amount), 0);
    $('requestsCount').innerHTML = `<span class="chip">${money(list.length)} طلب</span><span class="chip warn">قيد الاعتماد ${money(pending.length)} · ${money(pendingTotal)}</span>`;
    const shown = list.slice(0, state.requestShown);
    $('requestsMore').hidden = shown.length >= list.length;
    if (!list.length) {
      $('requestRows').innerHTML = '<tr><td colspan="7" class="empty">لا توجد طلبات مطابقة.</td></tr>';
      return;
    }
    const own = (r) => state.user && String(r.requesterUser).toLowerCase() === state.user.username;
    $('requestRows').innerHTML = shown.map((r) => {
      const act = canDecide() && r.status === 'قيد الاعتماد' && (isAdmin() || !own(r));
      return `
      <tr tabindex="0" data-review="${esc(r.id)}">
        <td>${esc(r.id)}<span class="sub">${esc(r.createdAt)}</span></td>
        <td><button type="button" class="link-btn" data-account="${esc(r.account)}">${esc(r.customer)}</button><span class="sub">${esc(r.account)} · ${esc(r.rep)}</span></td>
        <td class="n">${money(r.amount)}</td>
        <td><span class="tag ${VERDICT_TAG[r.verdict] || 'paid'}">${esc(r.verdict)}</span><span class="sub">${esc(r.reasons)}</span></td>
        <td>${esc(r.requester)}${r.note ? `<span class="sub">${esc(r.note)}</span>` : ''}</td>
        <td><span class="tag ${STATUS_TAG[r.status] || 'paid'}">${esc(r.status)}</span>
          ${r.approver ? `<span class="sub">${esc(r.approver)} · ${esc(r.decidedAt)}</span>` : ''}
          ${r.verdictAtDecision ? `<span class="sub">عند القرار: ${esc(r.verdictAtDecision)}</span>` : ''}
          ${r.decisionNote ? `<span class="sub">${esc(r.decisionNote)}</span>` : ''}</td>
        <td><button type="button" class="ghost" data-review="${esc(r.id)}">${act ? 'مراجعة' : 'عرض'}</button></td>
      </tr>`;
    }).join('');
  }

  function exportRequests() {
    const header = ['الطلب', 'العميل', 'الكود', 'المندوب', 'القيمة', 'الفحص', 'الأسباب', 'الحالة', 'مقدم الطلب', 'تاريخ الطلب', 'المعتمد', 'تاريخ الاعتماد', 'ملاحظات القرار', 'ملاحظة الطلب'];
    const rows = filteredRequests().map((r) => [
      r.id, r.customer, r.account, r.rep, Math.round(Number(r.amount) || 0), r.verdict, r.reasons || '',
      r.status, r.requester, r.createdAt, r.approver || '', r.decidedAt || '', r.decisionNote || '', r.note || '',
    ]);
    downloadCsv(`الطلبات-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
  }

  /* ---- audit log (admin) ------------------------------------------------------- */

  let auditSeq = 0;

  async function loadAudit() {
    const seq = ++auditSeq;
    $('auditReload').disabled = true;
    $('auditCount').textContent = 'جارٍ قراءة السجل…';
    try {
      const data = await callScript('audit', {
        from: $('auditFrom').value, to: $('auditTo').value,
        user: $('auditUser').value.trim(), op: $('auditAction').value,
      });
      if (seq !== auditSeq) return;  // a newer filter is already loading
      state.audit = data.audit.entries;
      state.auditTotal = data.audit.total;
      fillAuditActions(data.audit.actions);
      renderAudit();
    } catch (e) {
      if (seq !== auditSeq) return;
      state.audit = [];
      state.auditTotal = 0;
      $('auditCount').textContent = '';
      $('auditRows').innerHTML = `<tr><td colspan="4" class="empty">${esc(e.message)}</td></tr>`;
    } finally {
      if (seq === auditSeq) $('auditReload').disabled = false;
    }
  }

  // The menu keeps every operation the log holds, not just the filtered ones.
  function fillAuditActions(actions) {
    const el = $('auditAction');
    const current = el.value;
    el.innerHTML = '<option value="">كل العمليات</option>' + (actions || []).map((a) => `<option>${esc(a)}</option>`).join('');
    if ((actions || []).includes(current)) el.value = current;
  }

  function auditTag(action) {
    if (action === 'دخول' || action === 'معتمد') return 'ok';
    if (action === 'مرفوض') return 'stop';
    if (action === 'تسجيل طلب') return 'warn';
    return 'paid';
  }

  function renderAudit() {
    $('auditCount').innerHTML = `<span class="chip">${money(state.auditTotal)} عملية</span>` +
      (state.auditTotal > state.audit.length ? `<span class="chip warn">المعروض أحدث ${money(state.audit.length)}</span>` : '');
    if (!state.audit.length) {
      $('auditRows').innerHTML = '<tr><td colspan="4" class="empty">لا توجد عمليات مطابقة.</td></tr>';
      return;
    }
    $('auditRows').innerHTML = state.audit.map((e) => `
      <tr>
        <td dir="ltr" class="start">${esc(e.at)}</td>
        <td>${esc(e.user)}</td>
        <td><span class="tag ${auditTag(e.action)}">${esc(e.action)}</span></td>
        <td>${esc(e.detail)}</td>
      </tr>`).join('');
  }

  function exportAudit() {
    downloadCsv(`سجل-العمليات-${new Date().toISOString().slice(0, 10)}.csv`,
      ['الوقت', 'المستخدم', 'العملية', 'التفاصيل'],
      state.audit.map((e) => [e.at, e.user, e.action, e.detail]));
  }

  const VERDICT_LABEL = { ok: 'سليمة', warn: 'تحتاج موافقة', stop: 'موقوفة' };

  // The dialog answers instantly from the data already on screen. The script
  // still recomputes the check before any decision is accepted.
  function previewCheck(r) {
    if (!state.result || !state.result.customers) return null;
    const account = String(r.account).trim();
    const c = state.result.customers.find((x) => String(x.account).trim() === account);
    if (!c) return null;
    const res = Engine.evaluateNew(c, Number(r.amount), state.rules);
    const reasons = Object.keys(res.checks)
      .filter((k) => res.checks[k].level !== 'ok')
      .map((k) => res.checks[k].label).join('، ');
    return {
      verdict: res.verdict, verdictLabel: VERDICT_LABEL[res.verdict] || res.verdict,
      exposureAfter: res.exposureAfter, creditLimit: c.creditLimit, guarantee: c.guarantee,
      overdue: c.overdue, checksRejected: c.checksRejected, reasons,
    };
  }

  function checkHtml(check, label) {
    return `
      <b>${label}:</b><span class="tag ${check.verdict}">${esc(check.verdictLabel)}</span>
      <span class="sub">الرصيد شامل الشيكات بعد الفاتورة ${money(check.exposureAfter)} من حد ${money(check.creditLimit)} · الضمان ${money(check.guarantee)} · المتأخرات ${money(check.overdue)} · شيكات مرفوضة ${money(check.checksRejected)}${check.reasons ? ` · ${esc(check.reasons)}` : ''}</span>`;
  }

  function setBusy(text) {
    $('decisionBusyText').textContent = text || '';
    $('decisionBusy').hidden = !text;
  }

  function requestCanAct(r) {
    return !!r && r.status === 'قيد الاعتماد' && canDecide()
      && (isAdmin() || String(r.requesterUser || '').toLowerCase() !== String(state.user.username || '').toLowerCase());
  }

  function reviewNotice(r) {
    if (!r || r.status !== 'قيد الاعتماد') return '';
    if (!canDecide()) return 'عرض فقط: لا تملك صلاحية اعتماد الطلبات.';
    if (!isAdmin() && String(r.requesterUser || '').toLowerCase() === String(state.user.username || '').toLowerCase()) {
      return 'عرض فقط: لا يمكنك اعتماد طلب سجلته بنفسك.';
    }
    return '';
  }

  function reviewFact(label, value) {
    return value === '' || value == null ? '' : `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`;
  }

  function reviewNum(label, value) {
    return value === '' || value == null ? '' : `<dt>${esc(label)}</dt><dd>${money(value)}</dd>`;
  }

  function reviewDetailsHtml(r) {
    const notice = reviewNotice(r);
    const c = customerByAccount(r.account);
    const customer = c
      ? `<button type="button" class="link-btn" data-account="${esc(r.account)}">${esc(r.customer)}</button>`
      : esc(r.customer);
    const decision = r.status === 'قيد الاعتماد'
      ? '<div class="review-note"><strong>القرار</strong>لم يُتخذ بعد.</div>'
      : `<dl>
          ${reviewFact('المعتمد', r.approver)}
          ${reviewFact('وقت القرار', r.decidedAt)}
          ${reviewFact('الفحص عند القرار', r.verdictAtDecision)}
        </dl>
        ${r.decisionNote ? `<div class="review-note"><strong>ملاحظة القرار</strong>${esc(r.decisionNote)}</div>` : ''}`;
    return `
      ${notice ? `<div class="review-notice">${esc(notice)}</div>` : ''}
      <section class="review-block">
        <h3>بيانات الطلب</h3>
        <dl>
          ${reviewFact('الرقم', r.id)}
          ${reviewFact('التاريخ', r.createdAt)}
          ${reviewFact('مقدم الطلب', r.requester)}
          ${reviewNum('المبلغ', r.amount)}
        </dl>
        ${r.note ? `<div class="review-note"><strong>ملاحظة مقدم الطلب</strong>${esc(r.note)}</div>` : ''}
      </section>
      <section class="review-block">
        <h3>العميل</h3>
        <dl>
          <dt>الاسم</dt><dd>${customer}</dd>
          ${reviewFact('الكود', r.account)}
          ${reviewFact('المندوب', r.rep)}
          ${reviewFact('المخزن', r.warehouse)}
          ${reviewFact('المجموعة', r.group)}
        </dl>
      </section>
      <section class="review-block full">
        <h3>الفحص عند التسجيل</h3>
        <dl>
          <dt>النتيجة</dt><dd><span class="tag ${VERDICT_TAG[r.verdict] || 'paid'}">${esc(r.verdict || '—')}</span></dd>
          ${reviewFact('تاريخ البيانات', r.dataDate)}
          ${reviewNum('الرصيد شامل الشيكات بعد الفاتورة', r.exposureAfter)}
          ${reviewNum('حد الائتمان', r.creditLimit)}
          ${reviewNum('الضمان', r.guarantee)}
          ${reviewNum('المتأخرات', r.overdue)}
          ${reviewNum('شيكات مرفوضة', r.checksRejected)}
        </dl>
        <div class="review-note"><strong>أسباب الفحص</strong>${r.reasons ? esc(r.reasons) : 'لا توجد ملاحظات.'}</div>
      </section>
      <section class="review-block full">
        <h3>القرار</h3>
        ${decision}
      </section>`;
  }

  async function openRequest(id) {
    const r = state.requests.find((x) => x.id === id);
    if (!r) return;
    state.deciding = r;
    state.decisionPending = false;
    state.decisionCanAct = requestCanAct(r);
    state.decisionPreview = false;
    const pending = r.status === 'قيد الاعتماد';
    const status = r.status ? `<span class="tag ${STATUS_TAG[r.status] || 'paid'}">${esc(r.status)}</span>` : '';
    $('decisionTitle').textContent = `${pending && state.decisionCanAct ? 'مراجعة الطلب' : 'تفاصيل الطلب'} ${r.id}`;
    $('decisionInfo').innerHTML = `${status}<span>${esc(r.customer)} · ${money(r.amount)}</span><span>${esc(r.createdAt)}</span>`;
    $('decisionDetails').innerHTML = reviewDetailsHtml(r);
    $('decisionNote').value = '';
    $('decisionError').hidden = true;
    $('decisionRetry').hidden = true;
    $('decisionNoteWrap').hidden = !state.decisionCanAct;
    $('decisionCurrentSection').hidden = !state.decisionCanAct;
    $('approve').hidden = !state.decisionCanAct;
    $('reject').hidden = !state.decisionCanAct;
    $('approve').disabled = $('reject').disabled = true;
    $('decision').showModal();
    $('decision').scrollTop = 0;
    if (!state.decisionCanAct) {
      setBusy('');
      $('decisionCurrent').innerHTML = '';
      return;
    }
    const preview = previewCheck(r);
    state.decisionPreview = !!preview;
    $('decisionCurrent').innerHTML = preview
      ? checkHtml(preview, 'الموقف المتوقع')
      : '<span class="sub">جارٍ جلب بيانات الطلب…</span>';
    // The preview is enough to start a decision: the script recomputes the
    // request before writing it, and the refresh below only adds live detail.
    if (preview) $('approve').disabled = $('reject').disabled = false;
    setBusy(preview ? 'يتم تحديث الموقف في الخلفية…' : 'جارٍ التحقق من الطلب بالبيانات الحالية…');
    await loadDecisionCheck(r);
  }

  async function loadDecisionCheck(r) {
    if (state.deciding !== r) return;
    $('decisionError').hidden = true;
    $('decisionRetry').hidden = true;
    // A preview keeps the buttons usable; the script verifies the decision.
    if (!state.decisionPreview && !state.decisionPending) $('approve').disabled = $('reject').disabled = true;
    setBusy(state.decisionPreview ? 'يتم تحديث الموقف في الخلفية…' : 'جارٍ التحقق من الطلب بالبيانات الحالية…');
    try {
      const { check } = await callScript('recheck', { id: r.id });
      if (state.deciding !== r || state.decisionPending) return;
      $('decisionCurrent').innerHTML = checkHtml(check, 'الموقف الآن');
      $('approve').disabled = $('reject').disabled = false;
    } catch (e) {
      if (state.deciding !== r || state.decisionPending) return;
      setBusy('');
      $('decisionError').textContent = e.message;
      $('decisionError').hidden = false;
      $('decisionRetry').hidden = false;
      return;
    }
    if (state.deciding === r) setBusy('');
  }

  async function decide(decision) {
    if (!state.deciding) return;
    const r = state.deciding;
    state.decisionPending = true;
    $('approve').disabled = $('reject').disabled = true;
    $('decisionError').hidden = true;
    $('decisionRetry').hidden = true;
    setBusy(decision === 'approve' ? 'جارٍ اعتماد الطلب…' : 'جارٍ رفض الطلب…');
    try {
      const data = await callScript('decide', { id: r.id, decision, note: $('decisionNote').value });
      state.requests = state.requests.map((x) => (x.id === data.request.id ? data.request : x));
      state.decisionPending = false;
      setBusy('');
      $('decision').close();
      renderRequests();
      if (document.body.dataset.view === 'customer' && state.customerAccount) renderCustomer();
    } catch (e) {
      state.decisionPending = false;
      setBusy('');
      $('decisionError').textContent = e.message;
      $('decisionError').hidden = false;
      $('approve').disabled = $('reject').disabled = false;
    }
  }

  /* ---- users (admin) -------------------------------------------------------------- */

  async function loadUsers() {
    try {
      const data = await callScript('users');
      state.users = data.users;
      renderUsers();
    } catch (e) {
      $('userRows').innerHTML = `<tr><td colspan="6" class="empty">${esc(e.message)}</td></tr>`;
    }
  }

  function renderUsers() {
    if (!state.users.length) {
      $('userRows').innerHTML = '<tr><td colspan="6" class="empty">لا يوجد مستخدمون بعد. أضف أول مستخدم من النموذج.</td></tr>';
      return;
    }
    $('userRows').innerHTML = state.users.map((u) => `
      <tr>
        <td dir="ltr" class="start">${esc(u.username)}</td>
        <td>${esc(u.name)}</td>
        <td>${esc(u.role)}</td>
        <td>${esc(u.warehouses.length ? u.warehouses.join('، ') : 'الكل')}</td>
        <td><span class="tag ${u.active ? 'ok' : 'paid'}">${u.active ? 'مفعّل' : 'متوقف'}</span></td>
        <td><button type="button" class="ghost" data-user="${esc(u.username)}">تعديل</button></td>
      </tr>`).join('');
  }

  function clearUserForm() {
    $('userForm').reset();
    $('userUsername').readOnly = false;
    $('userError').hidden = true;
  }

  function editUser(username) {
    const u = state.users.find((x) => x.username === username);
    if (!u) return;
    clearUserForm();
    $('userUsername').value = u.username;
    $('userUsername').readOnly = true;
    $('userName').value = u.name;
    $('userRole').value = u.role;
    $('userWarehouses').value = u.warehouses.join('، ');
    $('userActive').checked = u.active;
    $('userForm').scrollIntoView({ block: 'nearest' });
  }

  async function saveUser(event) {
    event.preventDefault();
    $('userSubmit').disabled = true;
    $('userError').hidden = true;
    try {
      const data = await callScript('userSave', {
        username: $('userUsername').value, name: $('userName').value, role: $('userRole').value, active: $('userActive').checked,
        warehouses: $('userWarehouses').value.split(/[،,]/).map((x) => x.trim()).filter(Boolean),
        password: $('userPassword').value,
      });
      state.users = data.users;
      renderUsers();
      clearUserForm();
    } catch (e) {
      $('userError').textContent = e.message;
      $('userError').hidden = false;
    } finally {
      $('userSubmit').disabled = false;
    }
  }

  /* ---- settings ------------------------------------------------------------------- */

  function fillRulesForm() {
    $('overLimit').value = state.rules.overLimit;
    $('stopDays').value = state.rules.stopDays;
    $('tolerance').value = state.rules.tolerance;
  }

  function formMessage(el, text, isError) {
    el.className = isError ? 'form-error' : 'ok-msg';
    el.textContent = text;
  }

  async function changePassword(event) {
    event.preventDefault();
    try {
      await callScript('changePassword', { oldPassword: $('oldPassword').value, newPassword: $('newPassword').value });
      signedOut('تم تغيير كلمة المرور. سجّل الدخول بالكلمة الجديدة.');
    } catch (e) {
      formMessage($('passwordMsg'), e.message, true);
    } finally {
      $('passwordForm').reset();
    }
  }

  // The time the script prepared the data, in the viewer's own clock.
  function timeOf(ms) {
    const d = new Date(ms);
    return `${d.toLocaleDateString('ar-EG-u-nu-latn')} ${d.toLocaleTimeString('ar-EG-u-nu-latn', { hour: '2-digit', minute: '2-digit' })}`;
  }

  async function refreshSnapshot(event) {
    event.preventDefault();
    $('snapshotSubmit').disabled = true;
    formMessage($('snapshotMsg'), 'جارٍ قراءة الشيتات وتجهيز النسخة، وقد يستغرق ذلك دقيقة…');
    try {
      const data = await callScript('refresh');
      const note = (data.checksError ? ` الشيكات غير محسوبة: ${data.checksError}` : '') + (data.triggerError ? ` ${data.triggerError}` : '');
      formMessage($('snapshotMsg'), `تم التجهيز في ${Math.round(data.buildMs / 1000)} ثانية.${note}`, !!(data.checksError || data.triggerError));
      await loadData();
    } catch (e) {
      formMessage($('snapshotMsg'), e.message, true);
    } finally {
      $('snapshotSubmit').disabled = false;
    }
  }

  async function saveRules(event) {
    event.preventDefault();
    try {
      const data = await callScript('setRules', {
        overLimit: $('overLimit').value, stopDays: Number($('stopDays').value), tolerance: Number($('tolerance').value),
      });
      state.rules = data.rules;
      recompute();
      formMessage($('rulesMsg'), 'تم حفظ القواعد.');
    } catch (e) {
      formMessage($('rulesMsg'), e.message, true);
    }
  }

  /* ---- CSV export --------------------------------------------------------------- */

  function downloadCsv(filename, header, rows) {
    const cell = (v) => {
      // A leading = + - @ would run as a formula when the file opens in Excel.
      const s = typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : String(v);
      return `"${s.replace(/"/g, '""')}"`;
    };
    const csv = [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function exportCsv() {
    const header = ['الفاتورة', 'النوع', 'كود العميل', 'العميل', 'المندوب', 'التاريخ', 'الاستحقاق', 'القيمة', 'المسدد', 'المتبقي', 'أيام التأخير', 'الائتمان', 'الضمان', 'غير المغطى', 'المتأخرات', 'الموقف'];
    const rows = state.filtered.map((i) => [
      i.number, i.type, i.account, i.customer, i.rep, dateOf(i.day), dateOf(i.dueDay),
      Math.round(i.amount), Math.round(i.paid), Math.round(i.remaining), i.overdueDays,
      i.checks.credit.label, i.checks.guarantee.label, Math.round(i.uncovered), i.checks.arrears.label, VERDICT[i.verdict],
    ]);
    downloadCsv(`موقف-الفواتير-${dateOf(state.result.analysisDay)}.csv`, header, rows);
  }

  /* ---- events ------------------------------------------------------------------- */

  function refilter() {
    state.shown = PAGE_SIZE;
    if (state.result) renderInvoices();
  }

  function openRow(tr) {
    if (tr && tr.dataset.key) openDetail(state.result.invoices[+tr.dataset.key]);
  }

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    show(b.dataset.view);
    if (b.dataset.view === 'requests') loadRequests();
    if (b.dataset.view === 'users') loadUsers();
    if (b.dataset.view === 'audit') loadAudit();
  }));
  $('themeToggle').addEventListener('click', () => {
    const explicit = document.documentElement.dataset.theme;
    const dark = explicit ? explicit === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(dark ? 'light' : 'dark', true);
  });
  $('menuToggle').addEventListener('click', () => {
    const open = document.body.classList.toggle('nav-open');
    $('menuToggle').setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => {
    if (!document.body.classList.contains('nav-open')) return;
    if (!e.target.closest('.sidebar') && !e.target.closest('#menuToggle')) closeNav();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeNav();
  });
  $('loginForm').addEventListener('submit', login);
  $('logout').addEventListener('click', logout);
  $('demo').addEventListener('click', loadDemo);
  $('reload').addEventListener('click', () => (state.isDemo ? loadDemo() : loadData()));
  for (const id of ['requestStatus', 'requestFrom', 'requestTo', 'requestQuery']) {
    $(id).addEventListener(id === 'requestQuery' ? 'input' : 'change', () => {
      state.requestShown = REQUEST_PAGE;
      renderRequests();
    });
  }
  $('requestsMore').addEventListener('click', () => {
    state.requestShown += REQUEST_PAGE;
    renderRequests();
  });
  $('requestsReload').addEventListener('click', loadRequests);
  $('requestsExport').addEventListener('click', exportRequests);
  $('requestRows').addEventListener('click', (e) => {
    const link = e.target.closest('button[data-account]');
    if (link) { openCustomer(link.dataset.account, 'requests'); return; }
    const review = e.target.closest('[data-review]');
    if (review) openRequest(review.dataset.review);
  });
  $('requestRows').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const row = e.target.closest('tr[data-review]');
    if (row && e.target === row) openRequest(row.dataset.review);
  });
  for (const id of ['checkStatus', 'checkSource', 'checkSort']) {
    $(id).addEventListener('change', () => { state.checkShown = CHECK_PAGE; renderChecks(); });
  }
  let checkTimer = null;
  $('checkQuery').addEventListener('input', () => {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => { state.checkShown = CHECK_PAGE; renderChecks(); }, 160);
  });
  $('checksMore').addEventListener('click', () => { state.checkShown += CHECK_PAGE; renderChecks(); });
  $('checksExport').addEventListener('click', exportChecks);
  $('checkRows').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-account]');
    if (b) openCustomer(b.dataset.account, 'checks');
  });
  $('customerBody').addEventListener('click', (e) => {
    if (e.target.closest('[data-back]')) { show(state.customerFrom || 'invoices'); return; }
    const req = e.target.closest('[data-review-request]');
    if (req) { openRequest(req.dataset.reviewRequest); return; }
    const check = e.target.closest('[data-check-customer]');
    if (check) {
      const c = customerByAccount(check.dataset.checkCustomer);
      show('check');
      $('checkCustomer').value = c ? `${c.account} — ${c.name}` : check.dataset.checkCustomer;
      $('checkAmount').focus();
      return;
    }
    const inv = e.target.closest('[data-invoice]');
    if (inv) { openDetail(state.result.invoices[+inv.dataset.invoice]); return; }
    const load = e.target.closest('[data-load-requests]');
    if (load) { load.disabled = true; load.textContent = 'جارٍ جلب الطلبات…'; loadRequests(); }
  });
  for (const id of ['auditFrom', 'auditTo', 'auditAction']) {
    $(id).addEventListener('change', loadAudit);
  }
  let auditTimer = null;
  $('auditUser').addEventListener('input', () => {
    clearTimeout(auditTimer);
    auditTimer = setTimeout(loadAudit, 350);
  });
  $('auditReload').addEventListener('click', loadAudit);
  $('auditExport').addEventListener('click', exportAudit);
  $('approve').addEventListener('click', () => decide('approve'));
  $('reject').addEventListener('click', () => decide('reject'));
  $('decisionRetry').addEventListener('click', () => { if (state.deciding && state.decisionCanAct) loadDecisionCheck(state.deciding); });
  $('decisionClose').addEventListener('click', () => $('decision').close());
  $('decisionDetails').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-account]');
    if (!b) return;
    const from = document.body.dataset.view === 'customer' ? state.customerFrom : 'requests';
    $('decision').close();
    openCustomer(b.dataset.account, from);
  });
  $('decision').addEventListener('close', () => {
    setBusy('');
    state.deciding = null;
    state.decisionPending = false;
    state.decisionPreview = false;
    state.decisionCanAct = false;
  });
  $('userForm').addEventListener('submit', saveUser);
  $('userClear').addEventListener('click', clearUserForm);
  $('userRows').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-user]');
    if (b) editUser(b.dataset.user);
  });
  $('passwordForm').addEventListener('submit', changePassword);
  $('rulesForm').addEventListener('submit', saveRules);
  $('snapshotForm').addEventListener('submit', refreshSnapshot);
  $('q').addEventListener('input', refilter);
  $('verdict').addEventListener('change', refilter);
  $('rep').addEventListener('change', refilter);
  $('export').addEventListener('click', exportCsv);
  $('more').addEventListener('click', () => { state.shown += PAGE_SIZE; renderInvoices(); });
  $('checkForm').addEventListener('submit', renderCheck);
  $('aging').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const bucket = +b.dataset.bucket;
    state.bucket = state.bucket === bucket ? null : bucket;
    refilter();
  });
  $('rows').addEventListener('click', (e) => {
    const link = e.target.closest('button[data-account]');
    if (link) { openCustomer(link.dataset.account, 'invoices'); return; }
    openRow(e.target.closest('tr'));
  });
  $('rows').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const row = e.target.closest('tr');
    if (row && e.target === row) openRow(row);
  });
  $('detailBody').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-account]');
    if (!b) return;
    const from = document.body.dataset.view === 'customer' ? state.customerFrom : 'invoices';
    $('detail').close();
    openCustomer(b.dataset.account, from);
  });
  $('checkResult').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-account]');
    if (b) openCustomer(b.dataset.account, 'check');
  });

  initTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!document.documentElement.dataset.theme) applyTheme(null, false);
  });

  if (state.token) {
    boot().catch((e) => { console.error(e); banner(e.message, true); });
  } else {
    show('login');
  }
})();

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
  const ROLE_DELIVERY = 'محاسب مخزن';
  const ROLE_COLLECTOR = 'محصل';
  // A user may hold any mix of these; viewing is open to every signed-in user.
  const PERM = {
    add: 'تسجيل الطلبات',
    approve: 'اعتماد الطلبات',
    deliver: 'متابعة التسليم',
    collect: 'متابعة التحصيل',
    admin: 'إدارة النظام',
  };
  const PERM_LIST = [PERM.add, PERM.approve, PERM.deliver, PERM.collect, PERM.admin];
  // Delivery is tracked beside approval: an approved order can wait in the
  // warehouse for a truck without changing its approval status.
  const DELIVERY = {
    warehouse: 'في أرضية المخزن',
    transit: 'جاري التسليم',
    delivered: 'تم التسليم',
    failed: 'متعذر التسليم',
  };
  const DELIVERY_REASONS = ['عدم توافر عربيات النقل', 'العميل غير جاهز', 'نقص أصناف', 'مشكلة مستندات', 'أخرى'];
  // The demo has no plan sheet, so these stand in for «طرق السداد».
  const DEMO_PLANS = [
    { name: 'Net30', weeks: 4, count: 1, days: 30, startPercent: 0, advance: 0, advancePercent: 0, weekly: 0, weeklyPercent: 0 },
    { name: 'Sch_4W', weeks: 4, count: 4, days: 7, startPercent: 0, advance: 0, advancePercent: 0, weekly: 0, weeklyPercent: 0 },
    { name: '25%Sch_8W', weeks: 8, count: 8, days: 7, startPercent: 25, advance: 0, advancePercent: 0, weekly: 0, weeklyPercent: 0 },
  ];
  const DELIVERY_TAG = {
    [DELIVERY.warehouse]: 'warn',
    [DELIVERY.transit]: 'paid',
    [DELIVERY.delivered]: 'ok',
    [DELIVERY.failed]: 'stop',
  };
  const PROMISE_TAG = { 'قائم': 'warn', 'تم الوفاء': 'ok', 'أخلف': 'stop', 'ملغي': 'paid' };
  const THEME_KEY = 'financialAnalysis.theme';
  // The snapshot is a read cache: decisions still go to the script.
  const CACHE_DB = 'financialAnalysis.cache';
  const CACHE_STORE = 'snapshots';
  const CACHE_KEY = 'latest';
  const CACHE_VERSION = 1;
  const CACHE_TTL = 24 * 60 * 60 * 1000;
  const VIEW_META = {
    login: ['تسجيل الدخول', 'الوصول إلى لوحة التحكم'],
    dashboard: ['لوحة القيادة', 'ما يحتاج انتباهك اليوم وأين تتركز المخاطر'],
    invoices: ['الفواتير', 'كل الفواتير وتفاصيل الائتمان والضمان والمتأخرات'],
    check: ['فحص فاتورة جديدة', 'قرار سريع قبل إصدار الفاتورة'],
    checks: ['مركز الشيكات', 'الشيكات المفتوحة والمستحقة والمرتجعة'],
    customer: ['ملف العميل', 'الصورة الكاملة للعميل قبل القرار'],
    requests: ['الطلبات والاعتمادات', 'متابعة الطلبات وقرارات الاعتماد'],
    promises: ['وعود السداد', 'متابعة الوعود والمتأخرات ومواعيد التحصيل'],
    users: ['المستخدمون', 'إدارة الحسابات والصلاحيات ونطاق المخازن'],
    audit: ['سجل العمليات', 'كل دخول وقرار وتغيير، مع الوقت والمنفذ'],
    settings: ['الإعدادات', 'كلمة المرور وقواعد التحليل'],
  };

  const $ = (id) => document.getElementById(id);
  // One formatter for the whole session: constructing Intl.NumberFormat per call
  // is expensive, and the tables call money() thousands of times per render.
  const FMT0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const FMT2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
  const money = (v) => FMT0.format(v);
  // Actual invoice values keep their cents; whole amounts still print without .00.
  const money2 = (v) => FMT2.format(v);
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const dateOf = (day) => (day == null ? '—' : new Date(day * 86400000).toISOString().slice(0, 10));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  const state = {
    token: readToken(), user: null, sheets: null, rules: Engine.DEFAULT_RULES, isDemo: false, result: null,
    shown: PAGE_SIZE, bucket: null, filtered: [], requests: [], users: [], lastCheck: null, deciding: null,
    decisionPending: false, decisionPreview: false, decisionCanAct: false, cacheSavedAt: null,
    build: '', requestShown: REQUEST_PAGE, audit: [], auditTotal: 0,
    checkList: null, checkShown: CHECK_PAGE, customerAccount: null, customerFrom: 'invoices', requestsLoaded: false,
    requestsLoading: false, requestsError: '',
    promises: [], promisesLoaded: false, promisesLoading: false, promisesError: '', promiseEditing: null,
    plans: [], plansLoaded: false, plansPromise: null, plansError: '', editing: null,
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
      // The local copy is a convenience, not a record: never show it after its day.
      if (!(Number(snap.savedAt) > 0) || Date.now() - Number(snap.savedAt) >= CACHE_TTL) {
        await cacheRequest('readwrite', (store) => store.delete(CACHE_KEY));
        return null;
      }
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

  async function applyCache(snap, user) {
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
    await loadPlans();
    recompute();
    show('dashboard');
  }

  /* ---- session --------------------------------------------------------------- */

  // An older server sends no permissions, so the role still seeds them until
  // the new Code.gs is deployed.
  function permissionsOf(user) {
    if (!user) return [];
    if (Array.isArray(user.permissions)) return user.permissions;
    if (user.role === ROLE_ADMIN) return PERM_LIST.slice();
    if (user.role === ROLE_APPROVER) return [PERM.add, PERM.approve, PERM.deliver];
    if (user.role === ROLE_DELIVERY) return [PERM.deliver];
    if (user.role === ROLE_COLLECTOR) return [PERM.collect];
    return [PERM.add];
  }

  function hasPerm(p) {
    if (state.isDemo && p === PERM.add) return true;
    return permissionsOf(state.user).includes(p);
  }

  const canAdd = () => hasPerm(PERM.add);
  const canDecide = () => hasPerm(PERM.approve);
  const canDeliver = () => hasPerm(PERM.deliver);
  const canCollect = () => hasPerm(PERM.collect);
  const isAdmin = () => hasPerm(PERM.admin);

  function applyPermissions() {
    document.querySelectorAll('[data-admin]').forEach((el) => { el.hidden = !isAdmin(); });
    document.querySelectorAll('[data-perm]').forEach((el) => { el.hidden = !hasPerm(el.dataset.perm); });
  }

  // Delivery only starts once the request is approved (or needs no approval).
  const deliveryApplies = (r) => !!r && (r.status === 'معتمد' || r.status === 'لا يحتاج اعتماد');

  function todayStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // Whole days from `earlier` to `later`, both yyyy-MM-dd.
  function dayDiff(later, earlier) {
    const a = String(later || '').slice(0, 10).split('-').map(Number);
    const b = String(earlier || '').slice(0, 10).split('-').map(Number);
    if (a.length !== 3 || b.length !== 3 || a.some(isNaN) || b.some(isNaN)) return 0;
    return Math.round((Date.UTC(a[0], a[1] - 1, a[2]) - Date.UTC(b[0], b[1] - 1, b[2])) / 86400000);
  }

  function deliveryLate(r) {
    if (!r || !r.deliveryDue || r.deliveryStatus === DELIVERY.delivered) return 0;
    return Math.max(0, dayDiff(todayStr(), r.deliveryDue));
  }

  function deliveryWasLate(r) {
    if (!r || !r.deliveryDue || !r.deliveryAt) return 0;
    return Math.max(0, dayDiff(r.deliveryAt, r.deliveryDue));
  }

  function deliveryChip(r) {
    if (!r.deliveryStatus) return '<span class="tag paid">لم يبدأ التسليم</span>';
    const late = deliveryLate(r);
    const wasLate = deliveryWasLate(r);
    return `<span class="tag ${DELIVERY_TAG[r.deliveryStatus] || 'paid'}">${esc(r.deliveryStatus)}</span>`
      + (late ? `<span class="sub late">متأخر ${late} يوم</span>` : '')
      + (wasLate ? `<span class="sub late">سُلّم متأخرًا ${wasLate} يوم</span>` : '');
  }

  // The invoice may be issued at a different value than the agreed one.
  function hasActual(r) {
    return !!r && r.actualAmount !== '' && r.actualAmount != null && isFinite(Number(r.actualAmount));
  }

  function actualDiff(r) {
    return hasActual(r) ? Number(r.actualAmount) - (Number(r.amount) || 0) : null;
  }

  function actualDiffText(diff) {
    if (diff == null) return '';
    if (Math.abs(diff) < 0.005) return 'مطابق للمتفق عليه';
    return diff > 0 ? `أعلى بـ ${money2(diff)}` : `أقل بـ ${money2(-diff)}`;
  }

  function actualCell(r) {
    if (!hasActual(r)) return '<span class="sub">لم تُسجل</span>';
    const diff = actualDiff(r);
    return `<span class="actual">الفعلي ${money2(r.actualAmount)}</span>`
      + `<span class="sub ${diff > 0 ? 'diff-up' : diff < 0 ? 'diff-down' : ''}">${actualDiffText(diff)}</span>`;
  }

  function setUser(user) {
    state.user = user;
    const scope = user.warehouses && user.warehouses.length ? user.warehouses.join('، ') : 'كل المخازن';
    $('whoami').textContent = `${user.name} · ${user.role} · ${scope}`;
    $('userAvatar').textContent = (user.name || user.username || '؟').trim().charAt(0);
    applyPermissions();
  }

  /* ---- payment plans (optional «طرق السداد» sheet) ------------------------- */

  function fillPlanList() {
    $('planList').innerHTML = state.plans
      .map((p) => `<option value="${esc(p.name)}"></option>`).join('');
  }

  /**
   * loadPlans - the «طرق السداد» reference. It must be in hand before the first
   * analysis: without it the engine falls back to the old term code and the due
   * dates look wrong. Callers await this, and every waiter shares one request.
   */
  function loadPlans() {
    if (state.plansLoaded) return Promise.resolve();
    if (state.plansPromise) return state.plansPromise;
    state.plansPromise = (async () => {
      if (state.isDemo) {
        state.plans = DEMO_PLANS;
        state.plansLoaded = true;
        state.plansError = '';
        fillPlanList();
        return;
      }
      try {
        const data = await callScript('plans');
        state.plans = Array.isArray(data.plans) ? data.plans : [];
        state.plansLoaded = true;
        state.plansError = '';
      } catch (e) {
        // Left unloaded on purpose, so the next open or reload tries again.
        state.plans = [];
        state.plansError = `تعذّر قراءة شيت طرق السداد، فحُسبت مدة السداد من عمود Payment schedule وحده. (${e.message})`;
      }
      fillPlanList();
    })().finally(() => { state.plansPromise = null; });
    return state.plansPromise;
  }

  function planByName(name) {
    const key = String(name || '').trim().toLowerCase();
    return key ? state.plans.find((p) => String(p.name).trim().toLowerCase() === key) || null : null;
  }

  function planHint(plan) {
    if (!plan) return '';
    const parts = [];
    if (plan.startPercent) parts.push(`مقدمة ${plan.startPercent}%`);
    if (plan.count > 0) parts.push(`${plan.count} دفعة`);
    if (plan.days > 0) parts.push(`كل ${plan.days} يوم`);
    return parts.join(' · ');
  }

  // The plan is a reference, not a rule: it fills the two fields and the user
  // can still change them before sending.
  function planAmounts(plan, amount) {
    if (!plan) return { advance: '', weekly: '' };
    const value = Number(amount) || 0;
    let advance = Number(plan.advance) || 0;
    if (!advance && plan.advancePercent) advance = value * plan.advancePercent / 100;
    if (!advance && plan.startPercent) advance = value * plan.startPercent / 100;
    advance = Math.min(advance, value);
    let weekly = Number(plan.weekly) || 0;
    if (!weekly && plan.weeklyPercent) weekly = value * plan.weeklyPercent / 100;
    if (!weekly) {
      const count = Number(plan.count) || 0;
      if (count > 1) weekly = (value - advance) / count;
      else if (count === 1 && Number(plan.days) > 0 && Number(plan.days) <= 7) weekly = value - advance;
    }
    return {
      advance: advance > 0 ? String(round2(advance)) : '',
      weekly: weekly > 0 ? String(round2(weekly)) : '',
    };
  }

  function applyPlan(plan, amount, advanceId, weeklyId, hintId) {
    const amounts = planAmounts(plan, amount);
    $(advanceId).value = amounts.advance;
    $(weeklyId).value = amounts.weekly;
    $(hintId).textContent = planHint(plan);
  }

  function clearData() {
    Object.assign(state, {
      user: null, sheets: null, result: null, requests: [], users: [], lastCheck: null, bucket: null,
      deciding: null, decisionPending: false, decisionPreview: false, decisionCanAct: false,
      isDemo: false, cacheSavedAt: null, build: '', requestShown: REQUEST_PAGE, audit: [], auditTotal: 0,
      checkList: null, checkShown: CHECK_PAGE, customerAccount: null, customerFrom: 'invoices', requestsLoaded: false,
      requestsLoading: false, requestsError: '',
      promises: [], promisesLoaded: false, promisesLoading: false, promisesError: '', promiseEditing: null,
      plans: [], plansLoaded: false, editing: null,
    });
    for (const id of ['rows', 'kpis', 'aging', 'statusChart', 'dashboardBody', 'requestRows', 'userRows', 'checkResult', 'customerList', 'promiseCustomerList', 'promiseRows', 'promisesCount', 'auditRows', 'auditCount', 'checkKpis', 'checkRows', 'checksCount', 'customerBody']) $(id).innerHTML = '';
    $('requestsMore').hidden = true;
    $('checksMore').hidden = true;
    showBuild();
    $('userAvatar').textContent = '؟';
    document.querySelectorAll('[data-admin]').forEach((el) => { el.hidden = true; });
    document.querySelectorAll('[data-perm]').forEach((el) => { el.hidden = true; });
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
    loadPlans();
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
      show('dashboard');
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
    if (issues.unknownTerms) parts.push(`${issues.unknownTerms} عميل رمز جدولته غير معروف ولم يوجد له سطر في شيت طرق السداد، فحُسبت مدة السداد ${money(state.rules.defaultTermDays || Engine.DEFAULT_RULES.defaultTermDays)} يومًا`);
    if (state.plansError) parts.push(state.plansError);
    if (state.sheets.checksError) parts.push(`الشيكات غير محسوبة: ${state.sheets.checksError}`);
    return parts.length ? `مراجعة البيانات: ${parts.join('، ')}.` : '';
  }

  function recompute() {
    const { base, tx, analysisDay, checks } = state.sheets;
    state.result = Engine.analyze(base, tx, state.rules, analysisDay, checks, state.plans || []);
    // Sort the invoices once here, so filtering a keystroke does not sort again.
    const order = { stop: 0, warn: 1, ok: 2, paid: 3 };
    state.result.invoices.sort((a, b) => order[a.verdict] - order[b.verdict] || b.overdueDays - a.overdueDays || b.remaining - a.remaining);
    state.result.invoices.forEach((inv, key) => { inv.key = key; });
    state.checkList = readChecks();
    const prepared = state.sheets.dataAt ? ` · البيانات من ${timeOf(state.sheets.dataAt)}` : '';
    $('stamp').textContent = `المتأخرات حتى ${dateOf(state.result.analysisDay)}${prepared}`;
    $('snapshotInfo').textContent = state.sheets.dataAt ? `آخر تجهيز: ${timeOf(state.sheets.dataAt)}` : '';
    const demoNote = state.isDemo ? 'هذه بيانات نموذجية للتجربة وليست بيانات حقيقية. ' : '';
    banner([cacheNote(), (demoNote + issuesText(state.result.issues)).trim()].filter(Boolean).join(' '));
    fillRepFilter();
    fillCustomerList();
    fillPromiseCustomerList();
    fillRulesForm();
    state.shown = PAGE_SIZE;
    renderKpis();
    renderInvoices();
    if (document.body.dataset.view === 'dashboard') renderDashboard();
    if (document.body.dataset.view === 'promises') renderPromises();
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
      // The due dates depend on the plans, so the first analysis never runs without them.
      await loadPlans();
      recompute();
      show('dashboard');
      if (!state.isDemo) { loadRequests(); loadPromises(); }
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
    show('dashboard');
    banner('جارٍ التحقق من الجلسة وعرض البيانات…');
    const cached = await readCache();
    let ping;
    try {
      const data = await callScript('ping');
      ping = { user: data.user || state.user, rules: data.rules || state.rules, build: data.build || '' };
    } catch (e) {
      if (!state.token) return;  // the session ended; signedOut already ran
      if (cached) {
        await applyCache(cached, null);
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
    await applyCache(cached, ping.user);
    if (Date.now() - cached.savedAt >= CACHE_TTL) await loadData();
  }

  function loadDemo() {
    const { base, tx, checks } = window.demoSheets();
    state.isDemo = true;
    state.cacheSavedAt = null;
    state.promises = [];
    state.promisesLoaded = false;
    state.promisesError = '';
    state.promiseEditing = null;
    state.plans = DEMO_PLANS;
    state.plansLoaded = true;
    fillPlanList();
    state.sheets = { base, tx, analysisDay: null, checks, checksError: '' };
    state.rules = Engine.DEFAULT_RULES;
    state.user = null;
    $('whoami').textContent = 'وضع التجربة';
    $('userAvatar').textContent = 'ت';
    $('loginError').hidden = true;
    signedIn();
    applyPermissions();
    recompute();
    show('dashboard');
  }

  /* ---- navigation ------------------------------------------------------------- */

  function show(view) {
    for (const name of ['login', 'dashboard', 'invoices', 'check', 'checks', 'customer', 'requests', 'promises', 'users', 'audit', 'settings']) $(`view-${name}`).hidden = name !== view;
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
    if (view === 'dashboard') { renderDashboard(); ensureRequests(); ensurePromises(); }
    if (view === 'requests') { ensureRequests(); ensurePromises(); }
    if (view === 'promises') { renderPromises(); ensurePromises(); }
    if (view === 'checks' && state.result) renderChecks();
    if (view === 'customer' && state.result) { renderCustomer(); ensurePromises(); }
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

  function renderAgingChart(s, target = 'aging') {
    const el = $(target);
    if (!el) return;
    const max = Math.max(1, ...s.aging);
    el.innerHTML = Engine.AGING_BUCKETS.map((label, i) => {
      const height = Math.max(5, Math.round((s.aging[i] / max) * 100));
      return `<button type="button" class="bar-col" data-bucket="${i}" aria-pressed="${state.bucket === i}" title="${esc(label)}: ${money(s.aging[i])}">
        <span class="bar-value">${money(s.aging[i])}</span>
        <span class="bar-track"><span class="bar bar-${i}" style="height:${height}%"></span></span>
        <span class="bar-label">${esc(label)}</span>
      </button>`;
    }).join('');
  }

  function renderStatusChart(s, target = 'statusChart') {
    const el = $(target);
    if (!el) return;
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
    el.innerHTML = `
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
    // state.result.invoices is already sorted once in recompute, so filtering keeps
    // the order and a keystroke never re-sorts the whole list.
    return state.result.invoices
      .filter((i) => {
        if (verdict === 'open' && !i.isOpen) return false;
        if (!['open', 'all'].includes(verdict) && i.verdict !== verdict) return false;
        if (rep && i.rep !== rep) return false;
        if (state.bucket != null && i.bucket !== state.bucket) return false;
        return !q || [i.number, i.voucher, i.customer, i.account].some((v) => String(v).toLowerCase().includes(q));
      });
  }

  function noteCell(check, extra) {
    const applies = check.label !== 'لا ينطبق';
    const cls = applies ? check.level : 'none';
    const detail = extra || (check.amount >= 1 ? money(check.amount) : '');
    return `<span class="note ${cls}">${esc(check.label)}${detail ? `<small>${esc(detail)}</small>` : ''}</span>`;
  }

  function renderInvoices() {
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

  /* ---- command dashboard ---------------------------------------------------- */

  function ensureRequests() {
    if (state.isDemo || !state.token || state.requestsLoaded || state.requestsLoading) return;
    loadRequests();
  }

  function dashboardRisk(c) {
    if (c.stopped) return { tag: 'stop', label: 'موقوف' };
    if (c.overLimit > 0) return { tag: 'warn', label: 'متجاوز الحد' };
    if (c.overdue > 0) return { tag: 'warn', label: 'متأخر' };
    return { tag: 'ok', label: 'منتظم' };
  }

  function dashboardRequestItem(r) {
    return `<li class="dash-item">
      <button type="button" class="link-btn dash-item-main" data-review="${esc(r.id)}">
        <span class="dash-item-title">${esc(r.customer)} <small>${esc(r.id)}</small></span>
        <span class="dash-item-sub">${money(r.amount)} · ${esc(r.requester || '')} · ${esc(r.createdAt || '')}</span>
      </button>
      <span class="tag ${VERDICT_TAG[r.verdict] || 'paid'}">${esc(r.verdict)}</span>
    </li>`;
  }

  function renderDashboard() {
    if (!state.result) return;
    const s = state.result.summary;
    const requests = state.requests || [];
    const pending = requests.filter((r) => r.status === 'قيد الاعتماد');
    const known = state.requestsLoaded;
    const mine = state.user ? pending.filter(requestCanAct) : [];
    const mineAmount = mine.reduce((n, r) => n + (Number(r.amount) || 0), 0);
    const live = requests.filter(deliveryApplies);
    const late = live.filter((r) => deliveryLate(r) > 0);
    const oldestLate = late.reduce((m, r) => Math.max(m, deliveryLate(r)), 0);
    const promises = state.promises || [];
    const promiseKnown = state.promisesLoaded;
    const today = dateOf(state.result.analysisDay);
    const openPromises = promises.filter((p) => p.status === 'قائم');
    const overduePromises = openPromises.filter((p) => p.due && p.due < today);
    const promiseAmount = openPromises.reduce((n, p) => n + (Number(p.amount) || 0), 0);
    const checks = state.checkList || [];
    const rejected = checks.filter((k) => k.open && k.rejected);
    const due = checks.filter((k) => k.open && !k.rejected && k.due != null && k.due <= state.result.analysisDay);
    const watch = [...rejected, ...due].slice(0, 5);
    const checkAmount = (list) => list.reduce((n, k) => n + (Number(k.net) || 0), 0);
    const overdueCount = state.result.invoices.filter((i) => i.isOpen && i.overdueDays > 0).length;
    const top = state.result.customers
      .filter((c) => c.exposure > 0 || c.overdue > 0 || c.overLimit > 0)
      .sort((a, b) => b.overdue - a.overdue || b.exposure - a.exposure)
      .slice(0, 5);
    const recent = requests.slice().reverse().slice(0, 5);
    const dataAt = Number(state.sheets.dataAt);
    const age = Number.isFinite(dataAt) && dataAt > 0 ? Math.max(0, Math.round((Date.now() - dataAt) / 60000)) : null;
    const stale = age != null && age > 30;
    const pct = (v) => (s.openAmount ? `${Math.round((v / s.openAmount) * 100)}% من المفتوح` : '—');
    const emptyRequests = !known
      ? (state.isDemo ? 'وضع البيانات النموذجية لا يقرأ الطلبات.' : state.requestsError ? esc(state.requestsError) : 'جارٍ تحميل الطلبات…')
      : '';
    const stage = (status) => live.filter((r) => r.deliveryStatus === status).length;
    const stageCard = (status, label, tone) => `<div class="dash-stage ${tone || ''}">
      <span>${esc(label)}</span><strong>${money(stage(status))}</strong>
    </div>`;

    $('dashboardBody').innerHTML = `
      <section class="dash-hero">
        <div class="dash-hero-copy">
          <span class="dash-eyebrow"><svg class="icon"><use href="#i-dashboard"></use></svg> لوحة القيادة</span>
          <h2>مرحبًا، ${esc(state.user ? state.user.name : 'وضع التجربة')}</h2>
          <p>صورة المحفظة حتى ${dateOf(state.result.analysisDay)}${age != null ? ` · البيانات مجهزة ${timeOf(dataAt)}` : ''}${stale ? ' · قد تكون البيانات قديمة' : ''}.</p>
          <div class="dash-actions">
            ${canAdd() ? `<button type="button" data-dash-action="check"><svg class="icon"><use href="#i-check"></use></svg> فحص فاتورة</button>` : ''}
            <button type="button" class="ghost" data-dash-action="requests">مراجعة الطلبات${mine.length ? ` (${mine.length})` : ''}</button>
            <button type="button" class="ghost" data-dash-action="checks">مركز الشيكات</button>
          </div>
        </div>
        <div class="dash-hero-stats">
          <div class="dash-hero-stat ${mine.length ? 'warn' : ''}">
            <span>بانتظار قرارك</span><strong>${known ? money(mine.length) : '—'}</strong><small>${known ? money(mineAmount) : 'جارٍ تحميل الطلبات'}</small>
          </div>
          <div class="dash-hero-stat ${late.length ? 'stop' : ''}">
            <span>تسليم متأخر</span><strong>${money(late.length)}</strong><small>${oldestLate ? `أقدمها ${money(oldestLate)} يوم` : 'لا يوجد تأخير'}</small>
          </div>
          <div class="dash-hero-stat ${rejected.length ? 'stop' : ''}">
            <span>شيكات مرفوضة</span><strong>${s.hasChecks ? money(rejected.length) : '—'}</strong><small>${s.hasChecks ? money(checkAmount(rejected)) : 'شيت الشيكات غير متاح'}</small>
          </div>
        </div>
      </section>

      <div class="kpis">
        ${kpiCard('wallet', 'primary', 'الفواتير المفتوحة', money(s.openAmount), `${money(s.open)} فاتورة من ${money(s.invoices)}`)}
        ${kpiCard('clock', 'warn', 'المتأخرات', money(s.overdueAmount), `${money(overdueCount)} فاتورة متأخرة`)}
        ${kpiCard('shield', 'warn', 'غير مغطى بالضمان', money(s.uncoveredAmount), pct(s.uncoveredAmount))}
        ${kpiCard('alert', 'stop', 'تجاوز حد الائتمان', money(s.overLimitAmount), `${money(s.overLimitCustomers)} عميل`)}
        ${kpiCard('requests', mine.length ? 'warn' : 'primary', 'بانتظار قرارك', known ? money(mine.length) : '—', known ? money(mineAmount) : 'جارٍ تحميل الطلبات')}
        ${kpiCard('check-circle', 'info', 'شيكات تحتاج متابعة', s.hasChecks ? money(rejected.length + due.length) : '—', s.hasChecks ? `مرفوضة ${money(rejected.length)} · مستحقة ${money(due.length)}` : 'شيت الشيكات غير متاح')}
      </div>

      <div class="dash-grid">
        <section class="card dash-card dash-span-7" aria-labelledby="dashApprovalsTitle">
          <div class="card-head">
            <div><h2 id="dashApprovalsTitle">طلبات تنتظرك</h2><p>الأقرب إلى القرار، دون الطلبات التي سجلتها بنفسك.</p></div>
            <button type="button" class="link-btn" data-dash-action="requests">عرض الكل</button>
          </div>
          ${!canDecide()
            ? '<div class="dash-empty">عرض فقط: لا تملك صلاحية اعتماد الطلبات.</div>'
            : !known
              ? `<div class="dash-empty">${emptyRequests}</div>`
              : !mine.length
                ? '<div class="dash-empty">لا توجد طلبات تنتظر قرارك الآن.</div>'
                : `<ul class="dash-list">${mine.slice(0, 4).map(dashboardRequestItem).join('')}</ul>`}
        </section>

        <section class="card dash-card dash-span-5" aria-labelledby="dashDeliveryTitle">
          <div class="card-head">
            <div><h2 id="dashDeliveryTitle">خط التسليم</h2><p>الطلبات المعتمدة وأين وصلت.</p></div>
            <button type="button" class="link-btn" data-dash-action="requests">عرض الكل</button>
          </div>
          <div class="dash-pipeline">
            ${stageCard(DELIVERY.warehouse, 'في المخزن')}
            ${stageCard(DELIVERY.transit, 'جاري التسليم')}
            ${stageCard(DELIVERY.delivered, 'تم التسليم', 'ok')}
            ${stageCard(DELIVERY.failed, 'متعذر', 'stop')}
          </div>
          ${late.length
            ? `<ul class="dash-list">${late.slice(0, 3).map((r) => `
                <li class="dash-item">
                  <button type="button" class="link-btn dash-item-main" data-review="${esc(r.id)}">
                    <span class="dash-item-title">${esc(r.customer)} <small>${esc(r.id)}</small></span>
                    <span class="dash-item-sub">${esc(r.deliveryStatus)} · متأخر ${money(deliveryLate(r))} يوم · ${esc(r.deliveryDue || '')}</span>
                  </button>
                  <span class="tag stop">متأخر</span>
                </li>`).join('')}</ul>`
            : '<p class="dash-empty">لا يوجد تسليم متأخر.</p>'}
        </section>

        <section class="card dash-card dash-span-12" aria-labelledby="dashPromisesTitle">
          <div class="card-head">
            <div><h2 id="dashPromisesTitle">وعود السداد</h2><p>${promiseKnown ? `${money(openPromises.length)} قائم · ${money(overduePromises.length)} متأخر · ${money(promiseAmount)}` : 'متابعة الوعود والتحصيل'}</p></div>
            <div class="actions">
              ${canCollect() ? '<button type="button" class="btn ghost" data-dash-action="newPromise">وعد جديد</button>' : ''}
              <button type="button" class="link-btn" data-dash-action="promises">كل الوعود</button>
            </div>
          </div>
          ${!promiseKnown
            ? `<div class="dash-empty">${state.isDemo ? 'وضع البيانات النموذجية لا يقرأ وعود السداد.' : state.promisesError ? esc(state.promisesError) : 'جارٍ تحميل وعود السداد…'}</div>`
            : !openPromises.length
              ? '<div class="dash-empty">لا توجد وعود سداد قائمة.</div>'
              : `<div class="table-wrap dash-table"><table>
                  <thead><tr><th>العميل</th><th class="n">المبلغ</th><th>تاريخ الوعد</th><th>المتبقي</th><th>المسؤول</th></tr></thead>
                  <tbody>${openPromises.slice(0, 5).map((p) => `<tr tabindex="0" data-promise-edit="${esc(p.id)}">
                    <td><button type="button" class="link-btn" data-account="${esc(p.account)}">${esc(p.customer)}</button><span class="sub">${esc(p.id)}</span></td>
                    <td class="n">${money(p.amount)}</td>
                    <td class="date">${esc(p.due || '—')}</td>
                    <td>${esc(promiseTiming(p))}</td>
                    <td>${esc(p.owner || '—')}</td>
                  </tr>`).join('')}</tbody>
                </table></div>`}
        </section>

        <section class="card chart-card dash-span-7" aria-labelledby="dashAgingTitle">
          <div class="card-head"><div><h2 id="dashAgingTitle">أعمار المديونية</h2><p>اضغط على أي شريحة للانتقال إلى الفواتير</p></div></div>
          <div id="dashAging" class="aging" role="group" aria-label="أعمار الفواتير المفتوحة"></div>
        </section>

        <section class="card chart-card dash-span-5" aria-labelledby="dashStatusTitle">
          <div class="card-head"><div><h2 id="dashStatusTitle">توزيع الفواتير</h2><p>حسب الموقف النهائي</p></div></div>
          <div id="dashStatus" class="status-chart"></div>
        </section>

        <section class="card dash-card dash-span-7" aria-labelledby="dashTopTitle">
          <div class="card-head">
            <div><h2 id="dashTopTitle">أهم العملاء تعرضًا</h2><p>مرتبون بالمتأخرات ثم الرصيد من الحركات.</p></div>
            <button type="button" class="link-btn" data-dash-action="invoices">كل الفواتير</button>
          </div>
          ${top.length ? `<div class="table-wrap dash-table"><table>
            <thead><tr><th>العميل</th><th class="n">الرصيد</th><th class="n">المتأخرات</th><th class="n">تجاوز الحد</th><th>الحالة</th></tr></thead>
            <tbody>${top.map((c) => {
              const risk = dashboardRisk(c);
              return `<tr>
                <td><button type="button" class="link-btn" data-account="${esc(c.account)}">${esc(c.name)}</button><span class="sub">${esc(c.account)} · ${esc(c.warehouse || 'بلا مخزن')}</span></td>
                <td class="n">${money(c.exposure)}</td>
                <td class="n">${c.overdue > 0 ? `<span class="late">${money(c.overdue)}</span>` : money(c.overdue)}</td>
                <td class="n">${c.overLimit > 0 ? `<span class="note warn">${money(c.overLimit)}</span>` : '—'}</td>
                <td><span class="tag ${risk.tag}">${esc(risk.label)}</span></td>
              </tr>`;
            }).join('')}</tbody>
          </table></div>` : '<div class="dash-empty">لا توجد أرصدة أو متأخرات لعرضها.</div>'}
        </section>

        <section class="card dash-card dash-span-5" aria-labelledby="dashChecksTitle">
          <div class="card-head">
            <div><h2 id="dashChecksTitle">شيكات تحتاج متابعة</h2><p>المرفوضة والمستحقة أولًا.</p></div>
            <button type="button" class="link-btn" data-dash-action="checks">عرض الكل</button>
          </div>
          ${!s.hasChecks
            ? '<div class="dash-empty">شيت الشيكات غير متاح، فلا يمكن عرض الشيكات.</div>'
            : !watch.length
              ? '<div class="dash-empty">لا توجد شيكات مرفوضة أو مستحقة.</div>'
              : `<ul class="dash-list">${watch.map((k) => {
                  const st = checkStatus(k);
                  return `<li class="dash-item">
                    <button type="button" class="link-btn dash-item-main" data-account="${esc(k.account)}">
                      <span class="dash-item-title">${esc(k.customer)} <small>${esc(k.checkNo)}</small></span>
                      <span class="dash-item-sub">${money(k.net)} · ${esc(checkTiming(k))}</span>
                    </button>
                    <span class="tag ${st.tag}">${esc(st.label)}</span>
                  </li>`;
                }).join('')}</ul>`}
        </section>

        <section class="card dash-card dash-span-12" aria-labelledby="dashRecentTitle">
          <div class="card-head">
            <div><h2 id="dashRecentTitle">آخر الطلبات</h2><p>أحدث ما سُجل، بغض النظر عن حالته.</p></div>
            <button type="button" class="link-btn" data-dash-action="requests">كل الطلبات</button>
          </div>
          ${!known
            ? `<div class="dash-empty">${emptyRequests}</div>`
            : !recent.length
              ? '<div class="dash-empty">لا توجد طلبات مسجلة بعد.</div>'
              : `<div class="table-wrap dash-table"><table>
                  <thead><tr><th>الطلب</th><th>العميل</th><th class="n">القيمة</th><th>الفحص</th><th>الحالة</th><th>التسليم</th></tr></thead>
                  <tbody>${recent.map((r) => `<tr tabindex="0" data-review="${esc(r.id)}">
                    <td>${esc(r.id)}<span class="sub">${esc(r.createdAt || '')}</span></td>
                    <td><button type="button" class="link-btn" data-account="${esc(r.account)}">${esc(r.customer)}</button></td>
                    <td class="n">${money(r.amount)}</td>
                    <td><span class="tag ${VERDICT_TAG[r.verdict] || 'paid'}">${esc(r.verdict)}</span></td>
                    <td><span class="tag ${STATUS_TAG[r.status] || 'paid'}">${esc(r.status)}</span></td>
                    <td>${deliveryApplies(r) ? `<span class="tag ${DELIVERY_TAG[r.deliveryStatus] || 'paid'}">${esc(r.deliveryStatus || 'لم يبدأ')}</span>` : '<span class="sub">—</span>'}</td>
                  </tr>`).join('')}</tbody>
                </table></div>`}
        </section>
      </div>`;
    renderAgingChart(s, 'dashAging');
    renderStatusChart(s, 'dashStatus');
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
    const afterLabel = 'الرصيد بعد الفاتورة';
    const creditWhy = c.stopped ? 'حساب العميل موقوف.'
      : c.creditLimit <= 0 ? 'لا يوجد حد ائتمان مسجل لهذا العميل.'
      : `${afterLabel} ${money(r.exposureAfter)} من حد ${money(c.creditLimit)}. المتاح الآن ${money(r.maxByCredit)}.`;
    const guaranteeWhy = c.guarantee > 0
      ? `الضمان ${money(c.guarantee)}، وغير المغطى بعد الفاتورة ${money(r.uncovered)}.`
      : `لا يوجد ضمان، و${afterLabel} ${money(r.exposureAfter)}.`;
    const chequesWhy = !c.hasChecks ? 'شيت الشيكات غير مربوط، فلا يمكن عرض الشيكات المفتوحة.'
      : c.checksRejectedCount ? `${c.checksRejectedCount} شيك مرفوض بقيمة ${money(c.checksRejected)} لم يُسوَّ بعد.`
      : c.checksDueCount ? `${c.checksDueCount} شيك استحق ولم يُصرف بقيمة ${money(c.checksDue)}.`
      : c.checksOpenCount ? `${c.checksOpenCount} شيك تحت التحصيل بقيمة ${money(c.checksOpen)}، وهي خارج الرصيد حتى تُحصَّل.`
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
          <div class="pay-grid">
            <label>طريقة السداد / الخطة
              <input id="requestPlan" list="planList" placeholder="اختر خطة أو اكتبها" autocomplete="off">
            </label>
            <label>الدفعة المقدمة
              <input id="requestAdvance" type="number" min="0" step="0.01" inputmode="decimal" dir="ltr" placeholder="اختياري">
            </label>
            <label>الدفعة الأسبوعية
              <input id="requestWeekly" type="number" min="0" step="0.01" inputmode="decimal" dir="ltr" placeholder="اختياري">
            </label>
          </div>
          <p id="requestPlanHint" class="sub"></p>
          <label>ملاحظات الطلب
            <textarea id="requestNote" rows="2"></textarea>
          </label>
          <div class="actions"><button type="button" id="sendRequest">سجّل الطلب</button></div>
          <p id="requestMsg" aria-live="polite"></p>
        </div>
        <div class="panel"><h3>موقف العميل الحالي</h3>${customerFacts(c)}</div>
      </div>`;
    $('sendRequest').addEventListener('click', sendRequest);
    $('requestPlan').addEventListener('change', () => {
      applyPlan(planByName($('requestPlan').value), amount, 'requestAdvance', 'requestWeekly', 'requestPlanHint');
    });
    loadPlans();
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
      <thead><tr><th>الطلب</th><th class="n">القيمة</th><th>الفحص</th><th>الحالة</th><th>التسليم</th><th>التاريخ</th></tr></thead>
      <tbody>${list.slice(0, 20).map((r) => `
        <tr>
          <td><button type="button" class="link-btn" data-review-request="${esc(r.id)}">${esc(r.id)}</button><span class="sub">${esc(r.requester || '')}</span></td>
          <td class="n">${money(r.amount)}</td>
          <td><span class="tag ${VERDICT_TAG[r.verdict] || 'paid'}">${esc(r.verdict)}</span><span class="sub">${esc(r.reasons || '')}</span></td>
          <td><span class="tag ${STATUS_TAG[r.status] || 'paid'}">${esc(r.status)}</span>${r.decisionNote ? `<span class="sub">${esc(r.decisionNote)}</span>` : ''}</td>
          <td>${deliveryApplies(r) ? deliveryChip(r) : '<span class="sub">—</span>'}${r.deliveryDue ? `<span class="sub">الموعد: ${esc(r.deliveryDue)}</span>` : ''}</td>
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
    const from = { dashboard: 'لوحة القيادة', checks: 'مركز الشيكات', requests: 'الطلبات', promises: 'وعود السداد', check: 'فحص فاتورة جديدة', invoices: 'الفواتير' }[state.customerFrom] || 'الفواتير';
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
        ${kpiCard('wallet', 'primary', 'الرصيد', money(c.balance), 'من الحركات، بدون الشيكات المفتوحة')}
        ${kpiCard('check-circle', 'info', 'شيكات مفتوحة', money(c.checksOpen), `${money(c.checksOpenCount)} شيك · خارج الرصيد`)}
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
      </section>
      <section class="panel customer-promises">
        <div class="card-head">
          <h3>وعود السداد</h3>
          ${canCollect() ? `<button type="button" class="btn ghost" data-promise-new="${esc(c.account)}">وعد جديد</button>` : ''}
        </div>
        ${promiseCustomerHtml(c)}
      </section>`;
  }

  /* ---- payment promises ----------------------------------------------------- */

  function promiseTiming(p) {
    if (!p || p.status !== 'قائم' || !p.due || !state.result) return '—';
    const days = dayDiff(dateOf(state.result.analysisDay), p.due);
    if (days > 0) return `متأخر ${money(days)} يوم`;
    if (days === 0) return 'مستحق اليوم';
    return `بعد ${money(-days)} يوم`;
  }

  function promiseStatusTag(status) { return PROMISE_TAG[status] || 'paid'; }

  function fillPromiseCustomerList() {
    if (!state.result) return;
    $('promiseCustomerList').innerHTML = state.result.customers.map((c) =>
      `<option value="${esc(c.account)}">${esc(c.name)} · ${esc(c.warehouse || 'بلا مخزن')}</option>`).join('');
  }

  function promiseCustomerHtml(c) {
    if (!state.promisesLoaded) {
      return state.isDemo
        ? '<p class="empty">الوعود لا تُقرأ في وضع البيانات النموذجية.</p>'
        : `<p class="muted">لم تُقرأ وعود هذا العميل بعد.</p>
           <button type="button" class="btn ghost" data-load-promises>جلب الوعود</button>`;
    }
    const key = String(c.account).trim();
    const list = state.promises
      .filter((p) => String(p.account).trim() === key)
      .sort((a, b) => String(a.due).localeCompare(String(b.due)) || String(a.id).localeCompare(String(b.id)));
    if (!list.length) return '<p class="empty">لا توجد وعود سداد لهذا العميل.</p>';
    return `<div class="table-wrap compact-table"><table>
      <thead><tr><th>الوعد</th><th class="n">المبلغ</th><th>تاريخ الوعد</th><th>المتبقي</th><th>الحالة</th><th>المسؤول</th></tr></thead>
      <tbody>${list.map((p) => `<tr>
        <td><button type="button" class="link-btn" data-promise-edit="${esc(p.id)}">${esc(p.id)}</button>${p.note ? `<span class="sub">${esc(p.note)}</span>` : ''}</td>
        <td class="n">${money(p.amount)}</td>
        <td class="date">${esc(p.due || '—')}</td>
        <td>${esc(promiseTiming(p))}</td>
        <td><span class="tag ${promiseStatusTag(p.status)}">${esc(p.status)}</span></td>
        <td>${esc(p.owner || '—')}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  }

  function filteredPromises() {
    const q = $('promiseQuery').value.trim().toLowerCase();
    const status = $('promiseFilterStatus').value;
    const overdueOnly = $('promiseOverdue').checked;
    const today = state.result ? dateOf(state.result.analysisDay) : todayStr();
    return state.promises.filter((p) => {
      if (status && p.status !== status) return false;
      if (overdueOnly && !(p.status === 'قائم' && p.due && p.due < today)) return false;
      return !q || [p.id, p.customer, p.account, p.owner, p.note]
        .some((v) => String(v == null ? '' : v).toLowerCase().includes(q));
    }).sort((a, b) => String(a.due).localeCompare(String(b.due)) || String(a.id).localeCompare(String(b.id)));
  }

  function renderPromises() {
    if (!state.promisesLoaded) {
      const msg = state.isDemo ? 'الوعود لا تُقرأ في وضع البيانات النموذجية.' : state.promisesError || 'جارٍ تحميل الوعود…';
      $('promisesCount').textContent = state.isDemo ? 'وضع البيانات النموذجية' : state.promisesError || 'جارٍ تحميل الوعود…';
      $('promiseRows').innerHTML = `<tr><td colspan="8" class="empty">${esc(msg)}</td></tr>`;
      return;
    }
    const list = filteredPromises();
    const open = state.promises.filter((p) => p.status === 'قائم');
    const today = state.result ? dateOf(state.result.analysisDay) : todayStr();
    const overdue = open.filter((p) => p.due && p.due < today);
    const amount = open.reduce((n, p) => n + (Number(p.amount) || 0), 0);
    $('promisesCount').innerHTML = `<span class="chip">${money(list.length)} وعد</span>`
      + `<span class="chip">قائم ${money(open.length)} · ${money(amount)}</span>`
      + (overdue.length ? `<span class="chip stop">متأخر ${money(overdue.length)}</span>` : '');
    if (!list.length) {
      $('promiseRows').innerHTML = '<tr><td colspan="8" class="empty">لا توجد وعود مطابقة.</td></tr>';
      return;
    }
    $('promiseRows').innerHTML = list.map((p) => `
      <tr tabindex="0" data-promise-edit="${esc(p.id)}">
        <td>${esc(p.id)}<span class="sub">${esc(p.createdAt || '')}</span>${p.requestId ? `<span class="sub">الطلب ${esc(p.requestId)}</span>` : ''}</td>
        <td><button type="button" class="link-btn" data-account="${esc(p.account)}">${esc(p.customer)}</button><span class="sub">${esc(p.account)} · ${esc(p.warehouse || 'بلا مخزن')}</span></td>
        <td class="n">${money(p.amount)}</td>
        <td class="date">${esc(p.due || '—')}</td>
        <td>${esc(promiseTiming(p))}</td>
        <td><span class="tag ${promiseStatusTag(p.status)}">${esc(p.status)}</span></td>
        <td>${esc(p.owner || '—')}</td>
        <td>${p.note ? esc(p.note) : '<span class="sub">—</span>'}</td>
      </tr>`).join('');
  }

  /**
   * fillPromiseRequestList - the customer's requests, offered as a label for the
   * promise. The link is only a reference for the reader: it has no effect on
   * the promise's amount or status, nor on the request's figures.
   */
  function fillPromiseRequestList(account) {
    const code = String(account || '').trim().toLowerCase();
    const list = code
      ? state.requests.filter((r) => String(r.account).trim().toLowerCase() === code)
      : [];
    $('promiseRequestList').innerHTML = list.map((r) => `<option value="${esc(r.id)}">${esc(r.id)} · ${esc(r.customer)} · ${money(r.amount)}</option>`).join('');
  }

  function openPromise(account, id) {
    if (!canCollect()) return;
    const p = id ? state.promises.find((x) => x.id === id) : null;
    if (id && !p) return;
    state.promiseEditing = p;
    $('promiseTitle').textContent = p ? `تعديل وعد السداد ${p.id}` : 'وعد سداد جديد';
    $('promiseInfo').innerHTML = p
      ? `<span class="tag ${promiseStatusTag(p.status)}">${esc(p.status)}</span><span>${esc(p.customer)} · ${money(p.amount)}</span>`
      : `<span>المسؤول: ${esc(state.user ? state.user.name : '')}</span>`;
    $('promiseAccount').value = p ? p.account : (account || '');
    $('promiseAccount').readOnly = !!p;
    $('promiseAmount').value = p ? p.amount : '';
    $('promiseDue').value = p ? p.due : todayStr();
    $('promiseStatus').value = p ? p.status : 'قائم';
    $('promiseNote').value = p ? p.note : '';
    $('promiseRequest').value = p ? (p.requestId || '') : '';
    $('promiseRequest').readOnly = !!p;
    fillPromiseRequestList(p ? p.account : (account || ''));
    $('promiseError').hidden = true;
    $('promiseSave').disabled = false;
    $('promiseDialog').showModal();
    $('promiseDialog').scrollTop = 0;
  }

  async function savePromiseForm() {
    if (!canCollect()) return;
    const p = state.promiseEditing;
    $('promiseSave').disabled = true;
    $('promiseError').hidden = true;
    try {
      const data = await callScript('savePromise', {
        id: p ? p.id : '',
        account: $('promiseAccount').value.trim(),
        amount: $('promiseAmount').value.trim(),
        due: $('promiseDue').value,
        status: $('promiseStatus').value,
        requestId: $('promiseRequest').value.trim(),
        note: $('promiseNote').value,
      });
      const saved = data.promise;
      state.promises = p ? state.promises.map((x) => (x.id === saved.id ? saved : x)) : [...state.promises, saved];
      state.promisesLoaded = true;
      $('promiseDialog').close();
      renderPromises();
      if (document.body.dataset.view === 'dashboard') renderDashboard();
      if (document.body.dataset.view === 'requests') renderRequests();
      if (document.body.dataset.view === 'customer' && state.customerAccount) renderCustomer();
      banner(`تم حفظ وعد السداد ${saved.id}.`);
    } catch (e) {
      $('promiseError').textContent = e.message;
      $('promiseError').hidden = false;
      $('promiseSave').disabled = false;
    }
  }

  /* ---- requests and approvals --------------------------------------------------- */

  async function sendRequest() {
    const { c, r, amount, ref } = state.lastCheck;
    const msg = $('requestMsg');
    if (!canAdd()) {
      msg.className = 'form-error';
      msg.textContent = 'لا تملك صلاحية تسجيل الطلبات.';
      return;
    }
    if (state.isDemo) {
      msg.className = 'form-error';
      msg.textContent = 'لا يمكن تسجيل طلب من البيانات النموذجية.';
      return;
    }
    const paymentMethod = $('requestPlan').value.trim();
    const advance = $('requestAdvance').value.trim();
    const weekly = $('requestWeekly').value.trim();
    for (const [label, raw] of [['الدفعة المقدمة', advance], ['الدفعة الأسبوعية', weekly]]) {
      if (raw === '') continue;
      const n = Number(raw);
      if (!isFinite(n) || n < 0) {
        msg.className = 'form-error';
        msg.textContent = `${label} يجب أن تكون رقمًا غير سالب.`;
        return;
      }
      if (n > amount) {
        msg.className = 'form-error';
        msg.textContent = `${label} لا تزيد عن قيمة الفاتورة.`;
        return;
      }
    }
    $('sendRequest').disabled = true;
    msg.className = '';
    msg.textContent = 'جارٍ الفحص في الخادم والتسجيل، وقد يستغرق ذلك بعض الوقت…';
    try {
      const data = await callScript('add', {
        account: c.account, amount, note: $('requestNote').value, ref,
        paymentMethod, advance, weekly,
      });
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

  async function loadPromises() {
    if (state.promisesLoading || state.isDemo) return;
    state.promisesLoading = true;
    state.promisesError = '';
    try {
      const data = await callScript('promises');
      state.promises = data.promises || [];
      state.promisesLoaded = true;
    } catch (e) {
      state.promises = [];
      state.promisesLoaded = false;
      state.promisesError = e.message;
    } finally {
      state.promisesLoading = false;
      if (document.body.dataset.view === 'promises') renderPromises();
      if (document.body.dataset.view === 'requests') renderRequests();
      if (document.body.dataset.view === 'dashboard') renderDashboard();
      if (document.body.dataset.view === 'customer' && state.customerAccount) renderCustomer();
      if (document.body.dataset.view === 'requests' && $('decision').open && state.deciding) $('decisionDetails').innerHTML = reviewDetailsHtml(state.deciding);
    }
  }

  function ensurePromises() {
    if (state.isDemo || !state.token || state.promisesLoaded || state.promisesLoading) return;
    loadPromises();
  }

  async function loadRequests() {
    if (state.requestsLoading) return;
    state.requestsLoading = true;
    state.requestsError = '';
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
      state.requestsError = e.message;
      $('requestRows').innerHTML = '';
      $('requestsMore').hidden = true;
      $('requestsCount').textContent = e.message;
      if (state.customerAccount && document.body.dataset.view === 'customer') renderCustomer();
    } finally {
      state.requestsLoading = false;
      $('requestsReload').disabled = false;
      if (document.body.dataset.view === 'dashboard') renderDashboard();
    }
  }

  function requestFilters() {
    return {
      status: $('requestStatus').value,
      delivery: $('requestDelivery').value,
      late: $('requestLate').checked,
      actual: $('requestActual').value,
      from: $('requestFrom').value,
      to: $('requestTo').value,
      q: $('requestQuery').value.trim().toLowerCase(),
    };
  }

  function requestMatches(r, f) {
    if (f.status && r.status !== f.status) return false;
    if (f.delivery === 'none' && r.deliveryStatus) return false;
    if (f.delivery && f.delivery !== 'none' && r.deliveryStatus !== f.delivery) return false;
    if (f.late && deliveryLate(r) === 0) return false;
    if (f.actual === 'none' && hasActual(r)) return false;
    if (f.actual === 'diff' && !(hasActual(r) && actualDiff(r) !== 0)) return false;
    if (f.actual === 'up' && !(hasActual(r) && actualDiff(r) > 0)) return false;
    if (f.actual === 'down' && !(hasActual(r) && actualDiff(r) < 0)) return false;
    const day = String(r.createdAt || '').slice(0, 10);
    if (f.from && day < f.from) return false;
    if (f.to && day > f.to) return false;
    if (!f.q) return true;
    return [r.id, r.customer, r.account, r.rep, r.requester, r.note, r.deliveryReason, r.actualNote]
      .some((v) => String(v == null ? '' : v).toLowerCase().includes(f.q));
  }

  // Newest first, then the active filters. The page size only limits drawing.
  function filteredRequests() {
    const f = requestFilters();
    return state.requests.filter((r) => requestMatches(r, f)).reverse();
  }

  /** requestPromiseHtml - the promise ids recorded against this request, as a label. */
  function requestPromiseHtml(requestId) {
    const list = state.promises.filter((p) => p.requestId === requestId);
    if (!list.length) return '';
    return `<span class="sub">وعد ${list.map((p) => esc(p.id)).join(' · ')}</span>`;
  }

  function renderRequests() {
    const list = filteredRequests();
    const pending = state.requests.filter((r) => r.status === 'قيد الاعتماد');
    const pendingTotal = pending.reduce((s, r) => s + Number(r.amount), 0);
    const undelivered = state.requests.filter((r) => deliveryApplies(r) && r.deliveryStatus !== DELIVERY.delivered);
    const late = undelivered.filter((r) => deliveryLate(r) > 0);
    const oldest = undelivered.reduce((m, r) => {
      const since = String(r.decidedAt || r.createdAt || '').slice(0, 10);
      return Math.max(m, since ? Math.max(0, dayDiff(todayStr(), since)) : 0);
    }, 0);
    const withActual = state.requests.filter(hasActual);
    const actualTotal = withActual.reduce((s, r) => s + Number(r.actualAmount), 0);
    const diffTotal = withActual.reduce((s, r) => s + actualDiff(r), 0);
    $('requestsCount').innerHTML = `<span class="chip">${money(list.length)} طلب</span>`
      + `<span class="chip warn">قيد الاعتماد ${money(pending.length)} · ${money(pendingTotal)}</span>`
      + `<span class="chip">قيد التسليم ${money(undelivered.length)}</span>`
      + (late.length ? `<span class="chip stop">متأخر ${money(late.length)}</span>` : '')
      + (oldest ? `<span class="chip">أقدم غير مسلّم ${oldest} يوم</span>` : '')
      + (withActual.length
        ? `<span class="chip ${Math.abs(diffTotal) >= 1 ? 'warn' : 'ok'}">الفعلي ${money(actualTotal)}`
          + (Math.abs(diffTotal) >= 1 ? ` · فرق ${money(diffTotal)}` : '') + '</span>'
        : '');
    const shown = list.slice(0, state.requestShown);
    $('requestsMore').hidden = shown.length >= list.length;
    if (!list.length) {
      $('requestRows').innerHTML = '<tr><td colspan="10" class="empty">لا توجد طلبات مطابقة.</td></tr>';
      return;
    }
    const own = (r) => state.user && String(r.requesterUser).toLowerCase() === state.user.username;
    $('requestRows').innerHTML = shown.map((r) => {
      const act = canDecide() && r.status === 'قيد الاعتماد' && (isAdmin() || !own(r));
      const editDelivery = canDeliver() && deliveryApplies(r);
      return `
      <tr tabindex="0" data-review="${esc(r.id)}">
        <td>${esc(r.id)}<span class="sub">${esc(r.createdAt)}</span>${requestPromiseHtml(r.id)}</td>
        <td><button type="button" class="link-btn" data-account="${esc(r.account)}">${esc(r.customer)}</button><span class="sub">${esc(r.account)} · ${esc(r.rep)}</span></td>
        <td class="n">${money(r.amount)}${hasActual(r) ? `<span class="sub actual-line">${actualCell(r)}</span>` : ''}</td>
        <td class="n">${r.advancePayment !== '' && r.advancePayment != null ? money(r.advancePayment) : '<span class="sub">—</span>'}</td>
        <td class="n">${r.weeklyPayment !== '' && r.weeklyPayment != null ? money(r.weeklyPayment) : '<span class="sub">—</span>'}</td>
        <td><span class="tag ${VERDICT_TAG[r.verdict] || 'paid'}">${esc(r.verdict)}</span><span class="sub">${esc(r.reasons)}</span></td>
        <td>${esc(r.requester)}${r.note ? `<span class="sub">${esc(r.note)}</span>` : ''}</td>
        <td><span class="tag ${STATUS_TAG[r.status] || 'paid'}">${esc(r.status)}</span>
          ${r.approver ? `<span class="sub">${esc(r.approver)} · ${esc(r.decidedAt)}</span>` : ''}
          ${r.verdictAtDecision ? `<span class="sub">عند القرار: ${esc(r.verdictAtDecision)}</span>` : ''}
          ${r.decisionNote ? `<span class="sub">${esc(r.decisionNote)}</span>` : ''}</td>
        <td>${deliveryApplies(r) ? deliveryChip(r) : '<span class="sub">—</span>'}
          ${r.deliveryDue ? `<span class="sub">الموعد: ${esc(r.deliveryDue)}</span>` : ''}
          ${r.deliveryAt ? `<span class="sub">سُلّم: ${esc(r.deliveryAt)}</span>` : ''}
          ${r.deliveryReason ? `<span class="sub">${esc(r.deliveryReason)}</span>` : ''}</td>
        <td class="row-actions">
          <button type="button" class="ghost" data-review="${esc(r.id)}">${act ? 'مراجعة' : editDelivery ? 'تسليم' : 'عرض'}</button>
          ${canEditRequest(r) ? `<button type="button" class="ghost" data-edit="${esc(r.id)}">تعديل</button>` : ''}
        </td>
      </tr>`;
    }).join('');
  }

  function exportRequests() {
    const header = ['الطلب', 'العميل', 'الكود', 'المندوب', 'القيمة المتفق عليها', 'طريقة السداد', 'الدفعة المقدمة', 'الدفعة الأسبوعية',
      'القيمة الفعلية', 'فرق القيمة', 'سبب اختلاف القيمة',
      'الفحص', 'الأسباب', 'الحالة', 'مقدم الطلب', 'تاريخ الطلب',
      'المعتمد', 'تاريخ الاعتماد', 'ملاحظات القرار', 'ملاحظة الطلب',
      'حالة التسليم', 'موعد التسليم', 'تاريخ التسليم', 'تأخير التسليم (يوم)', 'سبب التأخير', 'ملاحظات التسليم'];
    const rows = filteredRequests().map((r) => [
      r.id, r.customer, r.account, r.rep, Math.round(Number(r.amount) || 0),
      r.paymentMethod || '',
      r.advancePayment === '' || r.advancePayment == null ? '' : Number(r.advancePayment),
      r.weeklyPayment === '' || r.weeklyPayment == null ? '' : Number(r.weeklyPayment),
      hasActual(r) ? Number(r.actualAmount) : '', hasActual(r) ? Math.round(actualDiff(r) * 100) / 100 : '', r.actualNote || '',
      r.verdict, r.reasons || '',
      r.status, r.requester, r.createdAt, r.approver || '', r.decidedAt || '', r.decisionNote || '', r.note || '',
      r.deliveryStatus || '', r.deliveryDue || '', r.deliveryAt || '', deliveryLate(r) || '', r.deliveryReason || '', r.deliveryNote || '',
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
      dataAt: state.sheets.dataAt || null,
    };
  }

  function checkHtml(check, label) {
    const dataAt = Number(check.dataAt);
    const ageMin = Number.isFinite(dataAt) && dataAt > 0
      ? Math.max(0, Math.round((Date.now() - dataAt) / 60000))
      : null;
    const dataLine = ageMin == null ? ''
      : `نسخة البيانات: ${esc(timeOf(dataAt))}${ageMin > 30 ? ' · قد تكون البيانات قديمة، راجعها قبل القرار' : ''} · `;
    return `
      <b>${label}:</b><span class="tag ${check.verdict}">${esc(check.verdictLabel)}</span>
      <span class="sub">${dataLine}الرصيد بعد الفاتورة ${money2(check.exposureAfter)} من حد ${money2(check.creditLimit)} · الضمان ${money2(check.guarantee)} · المتأخرات ${money2(check.overdue)} · شيكات مرفوضة ${money2(check.checksRejected)}${check.reasons ? ` · ${esc(check.reasons)}` : ''}</span>`;
  }

  function setBusy(text) {
    $('decisionBusyText').textContent = text || '';
    $('decisionBusy').hidden = !text;
  }

  function requestCanAct(r) {
    return !!r && r.status === 'قيد الاعتماد' && canDecide()
      && (isAdmin() || String(r.requesterUser || '').toLowerCase() !== String(state.user.username || '').toLowerCase());
  }

  // The agreement may be amended after a rejection, so a pending or rejected
  // request stays editable for whoever may register requests. An approved
  // request is never edited here; the actual value covers that case.
  function canEditRequest(r) {
    return !!r && canAdd() && (r.status === 'قيد الاعتماد' || r.status === 'مرفوض');
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
    return value === '' || value == null ? '' : `<dt>${esc(label)}</dt><dd>${money2(value)}</dd>`;
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
    const delivery = deliveryApplies(r)
      ? `<section class="review-block full">
          <h3>التسليم</h3>
          <dl>
            <dt>الحالة</dt><dd>${deliveryChip(r)}</dd>
            ${reviewFact('موعد التسليم المخطط', r.deliveryDue)}
            ${reviewFact('تاريخ التسليم الفعلي', r.deliveryAt)}
            ${reviewFact('سبب التأخير', r.deliveryReason)}
          </dl>
          ${r.deliveryNote ? `<div class="review-note"><strong>ملاحظات التسليم</strong>${esc(r.deliveryNote)}</div>` : ''}
          ${r.deliveryBy ? `<div class="review-note"><strong>آخر تحديث للتسليم</strong>${esc(r.deliveryBy)} · ${esc(r.deliveryUpdatedAt || '')}</div>` : ''}
        </section>`
      : `<section class="review-block full">
          <h3>التسليم</h3>
          <p class="sub">${r.status === 'مرفوض' ? 'لا ينطبق: الطلب مرفوض.' : 'يبدأ التسليم بعد اعتماد الطلب.'}</p>
        </section>`;
    // The agreed value is fixed; the invoice value is recorded beside it.
    const actual = hasActual(r)
      ? `<section class="review-block full">
          <h3>القيمة الفعلية</h3>
          <dl>
            ${reviewNum('القيمة المتفق عليها', r.amount)}
            ${reviewNum('القيمة الفعلية', r.actualAmount)}
            <dt>الفرق</dt><dd class="${actualDiff(r) > 0 ? 'diff-up' : actualDiff(r) < 0 ? 'diff-down' : ''}">${actualDiffText(actualDiff(r))}</dd>
          </dl>
          ${r.actualNote ? `<div class="review-note"><strong>سبب الاختلاف</strong>${esc(r.actualNote)}</div>` : ''}
          ${r.actualBy ? `<div class="review-note"><strong>آخر تحديث للقيمة</strong>${esc(r.actualBy)} · ${esc(r.actualAt || '')}</div>` : ''}
        </section>`
      : deliveryApplies(r)
        ? `<section class="review-block full">
            <h3>القيمة الفعلية</h3>
            <dl>${reviewNum('القيمة المتفق عليها', r.amount)}</dl>
            <p class="sub">لم تُسجل القيمة الفعلية بعد.</p>
          </section>`
        : '';
    const payments = (r.paymentMethod || (r.advancePayment !== '' && r.advancePayment != null)
      || (r.weeklyPayment !== '' && r.weeklyPayment != null))
      ? `<section class="review-block full">
          <h3>السداد</h3>
          <dl>
            ${reviewFact('طريقة السداد / الخطة', r.paymentMethod)}
            ${reviewNum('الدفعة المقدمة', r.advancePayment)}
            ${reviewNum('الدفعة الأسبوعية', r.weeklyPayment)}
          </dl>
        </section>`
      : '';
    // The linked promises are shown for the record only; nothing here is added
    // to the order's amounts or to its checks.
    const promises = state.promises.filter((p) => p.requestId === r.id);
    const promiseBlock = promises.length
      ? `<section class="review-block full">
          <h3>وعود السداد المرتبطة</h3>
          <dl>${promises.map((p) => `<dt>${esc(p.id)} · ${esc(p.status)}</dt><dd>${money(p.amount)} · ${esc(p.due || '—')}${p.owner ? ` · ${esc(p.owner)}` : ''}</dd>`).join('')}</dl>
        </section>`
      : '';
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
      ${payments}
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
          ${reviewNum('الرصيد بعد الفاتورة', r.exposureAfter)}
          ${reviewNum('حد الائتمان', r.creditLimit)}
          ${reviewNum('الضمان', r.guarantee)}
          ${reviewNum('المتأخرات', r.overdue)}
          ${reviewNum('شيكات مرفوضة', r.checksRejected)}
        </dl>
        <div class="review-note"><strong>أسباب الفحص</strong>${r.reasons ? esc(r.reasons) : 'لا توجد ملاحظات.'}</div>
      </section>
      ${delivery}
      ${actual}
      ${promiseBlock}
      <section class="review-block full">
        <h3>القرار</h3>
        ${decision}
      </section>`;
  }

  function fillDeliveryForm(r) {
    $('deliveryStatus').value = r.deliveryStatus || '';
    $('deliveryDue').value = r.deliveryDue || '';
    $('deliveryAt').value = r.deliveryAt || '';
    $('deliveryReason').value = r.deliveryReason || '';
    $('deliveryNote').value = r.deliveryNote || '';
    $('deliveryActual').value = hasActual(r) ? String(r.actualAmount) : '';
    $('deliveryActualNote').value = r.actualNote || '';
    $('deliveryError').hidden = true;
    $('deliveryMsg').textContent = '';
    updateActualDiff();
  }

  // Live difference between the agreed and the actual value.
  function updateActualDiff() {
    const agreed = state.deciding ? Number(state.deciding.amount) || 0 : 0;
    const raw = $('deliveryActual').value.trim();
    const el = $('deliveryActualDiff');
    if (!raw) {
      el.textContent = 'لم تُسجل القيمة الفعلية.';
      el.className = 'sub';
      return;
    }
    const n = Number(raw);
    if (!isFinite(n)) {
      el.textContent = 'القيمة الفعلية يجب أن تكون رقمًا.';
      el.className = 'sub diff-up';
      return;
    }
    const diff = n - agreed;
    el.textContent = actualDiffText(diff);
    el.className = 'sub ' + (Math.abs(diff) < 0.005 ? '' : diff > 0 ? 'diff-up' : 'diff-down');
  }

  function deliveryError(text) {
    $('deliveryMsg').textContent = '';
    $('deliveryError').textContent = text;
    $('deliveryError').hidden = false;
  }

  async function openRequest(id) {
    const r = state.requests.find((x) => x.id === id);
    if (!r) return;
    state.deciding = r;
    state.decisionPending = false;
    state.decisionCanAct = requestCanAct(r);
    state.decisionPreview = false;
    ensurePromises();
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
    $('decisionEdit').hidden = !canEditRequest(r);
    $('approve').disabled = $('reject').disabled = true;
    const editDelivery = canDeliver() && deliveryApplies(r);
    $('deliverySection').hidden = !editDelivery;
    if (editDelivery) fillDeliveryForm(r);
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

  function openEditRequest(id) {
    const r = state.requests.find((x) => x.id === id);
    if (!r || !canEditRequest(r)) return;
    if ($('decision').open) $('decision').close();
    state.editing = r;
    $('requestEditTitle').textContent = `تعديل الطلب ${r.id}`;
    $('requestEditInfo').innerHTML = `<span class="tag ${STATUS_TAG[r.status] || 'paid'}">${esc(r.status)}</span>`
      + `<span>${esc(r.customer)} · ${money(r.amount)}</span>`;
    $('editAmount').value = r.amount;
    $('editPlan').value = r.paymentMethod || '';
    $('editAdvance').value = r.advancePayment === '' || r.advancePayment == null ? '' : r.advancePayment;
    $('editWeekly').value = r.weeklyPayment === '' || r.weeklyPayment == null ? '' : r.weeklyPayment;
    $('editNote').value = r.note || '';
    $('editPlanHint').textContent = planHint(planByName(r.paymentMethod));
    $('editError').hidden = true;
    $('editMsg').textContent = '';
    $('editSave').disabled = false;
    $('requestEdit').showModal();
    $('requestEdit').scrollTop = 0;
  }

  async function saveEditRequest() {
    const r = state.editing;
    if (!r) return;
    const amount = Number($('editAmount').value);
    const advance = $('editAdvance').value.trim();
    const weekly = $('editWeekly').value.trim();
    const err = $('editError');
    const fail = (text) => {
      err.textContent = text;
      err.hidden = false;
      $('editSave').disabled = false;
    };
    err.hidden = true;
    if (!(amount > 0)) { fail('قيمة الفاتورة يجب أن تكون أكبر من صفر.'); return; }
    for (const [label, raw] of [['الدفعة المقدمة', advance], ['الدفعة الأسبوعية', weekly]]) {
      if (raw === '') continue;
      const n = Number(raw);
      if (!isFinite(n) || n < 0) { fail(`${label} يجب أن تكون رقمًا غير سالب.`); return; }
      if (n > amount) { fail(`${label} لا تزيد عن قيمة الفاتورة.`); return; }
    }
    $('editSave').disabled = true;
    $('editMsg').textContent = 'جارٍ حفظ التعديل وإعادة الفحص…';
    try {
      const data = await callScript('edit', {
        id: r.id, amount, note: $('editNote').value,
        paymentMethod: $('editPlan').value.trim(), advance, weekly,
      });
      const updated = data.request;
      const at = state.requests.findIndex((x) => x.id === updated.id);
      if (at >= 0) state.requests[at] = updated;
      state.editing = null;
      $('requestEdit').close();
      renderRequests();
      if (state.customerAccount && document.body.dataset.view === 'customer') renderCustomer();
      const label = updated.status === 'لا يحتاج اعتماد' ? 'الطلب سليم ولا يحتاج اعتمادًا.' : `أُعيد الطلب إلى ${updated.status}.`;
      banner(`تم تعديل الطلب ${updated.id}. ${label}`);
    } catch (e) {
      fail(e.message);
    }
  }

  async function saveDelivery() {
    const r = state.deciding;
    if (!r) return;
    const status = $('deliveryStatus').value;
    const reason = $('deliveryReason').value;
    if (status === DELIVERY.failed && !reason) {
      deliveryError('اختر سبب تعذر التسليم.');
      return;
    }
    const actualRaw = $('deliveryActual').value.trim();
    const actualNote = $('deliveryActualNote').value.trim();
    if (actualRaw) {
      const n = Number(actualRaw);
      if (!isFinite(n) || n < 0) {
        deliveryError('القيمة الفعلية يجب أن تكون رقمًا غير سالب.');
        return;
      }
      if (Math.abs(n - (Number(r.amount) || 0)) >= 1 && !actualNote) {
        deliveryError('اكتب سبب اختلاف القيمة الفعلية عن القيمة المتفق عليها.');
        return;
      }
    }
    // Delivered without a date means today; the server applies the same rule.
    if (status === DELIVERY.delivered && !$('deliveryAt').value) $('deliveryAt').value = todayStr();
    $('deliverySave').disabled = true;
    $('deliveryError').hidden = true;
    $('deliveryMsg').textContent = 'جارٍ حفظ حالة التسليم…';
    try {
      const data = await callScript('deliver', {
        id: r.id, status,
        due: $('deliveryDue').value,
        at: $('deliveryAt').value,
        reason, note: $('deliveryNote').value,
        actual: actualRaw, actualNote,
      });
      const updated = data.request;
      state.requests = state.requests.map((x) => (x.id === updated.id ? updated : x));
      state.deciding = updated;
      $('decisionDetails').innerHTML = reviewDetailsHtml(updated);
      fillDeliveryForm(updated);
      $('deliveryMsg').textContent = 'تم حفظ حالة التسليم.';
      renderRequests();
      if (document.body.dataset.view === 'customer' && state.customerAccount) renderCustomer();
    } catch (e) {
      deliveryError(e.message);
    } finally {
      $('deliverySave').disabled = false;
    }
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

  const USER_PRESETS = {
    'موظف': [PERM.add],
    'معتمد': [PERM.add, PERM.approve, PERM.deliver],
    'محاسب مخزن': [PERM.deliver],
    'محصل': [PERM.collect],
    'مشاهد': [],
    'مدير': PERM_LIST.slice(),
  };

  function checkedPerms() {
    return [
      [PERM.add, 'permAdd'],
      [PERM.approve, 'permApprove'],
      [PERM.deliver, 'permDeliver'],
      [PERM.collect, 'permCollect'],
      [PERM.admin, 'permAdmin'],
    ].filter(([, id]) => $(id).checked).map(([p]) => p);
  }

  function setCheckedPerms(list) {
    $('permAdd').checked = list.includes(PERM.add);
    $('permApprove').checked = list.includes(PERM.approve);
    $('permDeliver').checked = list.includes(PERM.deliver);
    $('permCollect').checked = list.includes(PERM.collect);
    $('permAdmin').checked = list.includes(PERM.admin);
    syncAdminLock();
  }

  // «إدارة النظام» already carries everything, so the other boxes stay fixed.
  function syncAdminLock() {
    const on = $('permAdmin').checked;
    for (const id of ['permAdd', 'permApprove', 'permDeliver', 'permCollect']) $(id).disabled = on;
  }

  function presetOf(list) {
    const key = (a) => a.slice().sort().join('|');
    return Object.keys(USER_PRESETS).find((name) => key(USER_PRESETS[name]) === key(list)) || '';
  }

  function syncPreset() {
    $('userPreset').value = presetOf(checkedPerms());
  }

  function applyUserPreset(name) {
    setCheckedPerms(USER_PRESETS[name] || []);
    $('userPreset').value = USER_PRESETS[name] ? name : '';
  }

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
    $('userRows').innerHTML = state.users.map((u) => {
      const perms = permissionsOf(u);
      return `
      <tr>
        <td dir="ltr" class="start">${esc(u.username)}</td>
        <td>${esc(u.name)}</td>
        <td><div class="perm-list">${perms.length
          ? perms.map((p) => `<span class="chip">${esc(p)}</span>`).join('')
          : '<span class="sub">عرض فقط</span>'}</div></td>
        <td>${esc(u.warehouses.length ? u.warehouses.join('، ') : 'الكل')}</td>
        <td><span class="tag ${u.active ? 'ok' : 'paid'}">${u.active ? 'مفعّل' : 'متوقف'}</span></td>
        <td><button type="button" class="ghost" data-user="${esc(u.username)}">تعديل</button></td>
      </tr>`;
    }).join('');
  }

  function clearUserForm() {
    $('userForm').reset();
    $('userUsername').readOnly = false;
    $('userError').hidden = true;
    applyUserPreset('موظف');
  }

  function editUser(username) {
    const u = state.users.find((x) => x.username === username);
    if (!u) return;
    clearUserForm();
    $('userUsername').value = u.username;
    $('userUsername').readOnly = true;
    $('userName').value = u.name;
    setCheckedPerms(permissionsOf(u));
    syncPreset();
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
        username: $('userUsername').value, name: $('userName').value, active: $('userActive').checked,
        // The permission list is authoritative; role stays as a hint for an
        // older server that has not been deployed yet.
        permissions: checkedPerms(), role: presetOf(checkedPerms()),
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
  let requestTimer = null;
  for (const id of ['requestStatus', 'requestDelivery', 'requestLate', 'requestActual', 'requestFrom', 'requestTo', 'requestQuery']) {
    $(id).addEventListener(id === 'requestQuery' ? 'input' : 'change', () => {
      state.requestShown = REQUEST_PAGE;
      // Typing in the search box waits a moment; the list may be large.
      if (id === 'requestQuery') {
        clearTimeout(requestTimer);
        requestTimer = setTimeout(renderRequests, 180);
      } else {
        renderRequests();
      }
    });
  }
  $('requestsMore').addEventListener('click', () => {
    state.requestShown += REQUEST_PAGE;
    renderRequests();
  });
  $('requestsReload').addEventListener('click', loadRequests);
  $('requestsExport').addEventListener('click', exportRequests);
  $('promisesReload').addEventListener('click', loadPromises);
  $('promisesNew').addEventListener('click', () => openPromise());
  for (const id of ['promiseQuery', 'promiseFilterStatus', 'promiseOverdue']) {
    $(id).addEventListener(id === 'promiseQuery' ? 'input' : 'change', renderPromises);
  }
  $('promiseRows').addEventListener('click', (e) => {
    const account = e.target.closest('button[data-account]');
    if (account) { openCustomer(account.dataset.account, 'promises'); return; }
    const row = e.target.closest('[data-promise-edit]');
    if (row) openPromise(null, row.dataset.promiseEdit);
  });
  $('promiseRows').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const row = e.target.closest('tr[data-promise-edit]');
    if (row && e.target === row) openPromise(null, row.dataset.promiseEdit);
  });
  $('promiseSave').addEventListener('click', savePromiseForm);
  $('promiseCancel').addEventListener('click', () => $('promiseDialog').close());
  $('promiseAccount').addEventListener('input', () => {
    if (!$('promiseAccount').readOnly) fillPromiseRequestList($('promiseAccount').value);
  });
  $('promiseDialog').addEventListener('close', () => { state.promiseEditing = null; });
  $('requestRows').addEventListener('click', (e) => {
    const link = e.target.closest('button[data-account]');
    if (link) { openCustomer(link.dataset.account, 'requests'); return; }
    const edit = e.target.closest('button[data-edit]');
    if (edit) { openEditRequest(edit.dataset.edit); return; }
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
    if (load) { load.disabled = true; load.textContent = 'جارٍ جلب الطلبات…'; loadRequests(); return; }
    const promiseNew = e.target.closest('[data-promise-new]');
    if (promiseNew) { openPromise(promiseNew.dataset.promiseNew); return; }
    const promiseEdit = e.target.closest('[data-promise-edit]');
    if (promiseEdit) { openPromise(null, promiseEdit.dataset.promiseEdit); return; }
    const promiseLoad = e.target.closest('[data-load-promises]');
    if (promiseLoad) { promiseLoad.disabled = true; promiseLoad.textContent = 'جارٍ جلب الوعود…'; loadPromises(); }
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
  $('decisionEdit').addEventListener('click', () => { if (state.deciding) openEditRequest(state.deciding.id); });
  $('editSave').addEventListener('click', saveEditRequest);
  $('editCancel').addEventListener('click', () => $('requestEdit').close());
  $('editPlan').addEventListener('change', () => {
    applyPlan(planByName($('editPlan').value), Number($('editAmount').value), 'editAdvance', 'editWeekly', 'editPlanHint');
  });
  $('requestEdit').addEventListener('close', () => { state.editing = null; });
  $('deliverySave').addEventListener('click', saveDelivery);
  $('deliveryActual').addEventListener('input', updateActualDiff);
  $('deliveryStatus').addEventListener('change', () => {
    if ($('deliveryStatus').value === DELIVERY.delivered && !$('deliveryAt').value) {
      $('deliveryAt').value = todayStr();
    }
  });
  $('decisionDetails').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-account]');
    if (!b) return;
    const from = document.body.dataset.view === 'customer' ? state.customerFrom : 'requests';
    $('decision').close();
    openCustomer(b.dataset.account, from);
  });
  $('decision').addEventListener('close', () => {
    setBusy('');
    $('deliverySection').hidden = true;
    state.deciding = null;
    state.decisionPending = false;
    state.decisionPreview = false;
    state.decisionCanAct = false;
  });
  $('userForm').addEventListener('submit', saveUser);
  $('userClear').addEventListener('click', clearUserForm);
  $('userPreset').addEventListener('change', () => {
    const name = $('userPreset').value;
    if (name) applyUserPreset(name);
  });
  for (const id of ['permAdd', 'permApprove', 'permDeliver', 'permAdmin']) {
    $(id).addEventListener('change', () => {
      if (id === 'permAdmin') {
        if ($(id).checked) setCheckedPerms(PERM_LIST);
        else syncAdminLock();
      }
      syncPreset();
    });
  }
  $('userRows').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-user]');
    if (b) editUser(b.dataset.user);
  });
  clearUserForm();
  $('passwordForm').addEventListener('submit', changePassword);
  $('rulesForm').addEventListener('submit', saveRules);
  $('snapshotForm').addEventListener('submit', refreshSnapshot);
  let invoiceTimer = null;
  $('q').addEventListener('input', () => {
    clearTimeout(invoiceTimer);
    invoiceTimer = setTimeout(refilter, 180);
  });
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
    // Only the pressed state of the chart changed; the KPIs did not.
    if (state.result) renderAgingChart(state.result.summary);
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

  $('dashboardBody').addEventListener('click', (e) => {
    const bucket = e.target.closest('button[data-bucket]');
    if (bucket) {
      const b = +bucket.dataset.bucket;
      state.bucket = state.bucket === b ? null : b;
      show('invoices');
      renderKpis();
      renderInvoices();
      return;
    }
    const account = e.target.closest('button[data-account]');
    if (account) { openCustomer(account.dataset.account, 'dashboard'); return; }
    const review = e.target.closest('[data-review]');
    if (review) { openRequest(review.dataset.review); return; }
    const promiseRow = e.target.closest('[data-promise-edit]');
    if (promiseRow) { openPromise(null, promiseRow.dataset.promiseEdit); return; }
    const action = e.target.closest('[data-dash-action]');
    if (!action) return;
    const view = action.dataset.dashAction;
    if (view === 'requests') { show('requests'); ensureRequests(); return; }
    if (view === 'promises') { show('promises'); ensurePromises(); return; }
    if (view === 'newPromise') { openPromise(); return; }
    if (view === 'loadRequests') { loadRequests(); return; }
    if (view === 'invoices') { show('invoices'); renderKpis(); renderInvoices(); return; }
    show(view);
  });
  $('dashboardBody').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const row = e.target.closest('tr[data-review]');
    if (row && e.target === row) { openRequest(row.dataset.review); return; }
    const promiseRow = e.target.closest('tr[data-promise-edit]');
    if (promiseRow && e.target === promiseRow) openPromise(null, promiseRow.dataset.promiseEdit);
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

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

  const $ = (id) => document.getElementById(id);
  const money = (v) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(v);
  const dateOf = (day) => (day == null ? '—' : new Date(day * 86400000).toISOString().slice(0, 10));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  const state = {
    token: readToken(), user: null, sheets: null, rules: Engine.DEFAULT_RULES, isDemo: false, result: null,
    shown: PAGE_SIZE, bucket: null, filtered: [], requests: [], users: [], lastCheck: null, deciding: null,
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
    return data;
  }

  /* ---- session --------------------------------------------------------------- */

  const canDecide = () => !!state.user && (state.user.role === ROLE_ADMIN || state.user.role === ROLE_APPROVER);
  const isAdmin = () => !!state.user && state.user.role === ROLE_ADMIN;

  function setUser(user) {
    state.user = user;
    const scope = user.warehouses && user.warehouses.length ? user.warehouses.join('، ') : 'كل المخازن';
    $('whoami').textContent = `${user.name} · ${user.role} · ${scope}`;
    document.querySelectorAll('[data-admin]').forEach((el) => { el.hidden = !isAdmin(); });
  }

  function clearData() {
    Object.assign(state, { user: null, sheets: null, result: null, requests: [], users: [], lastCheck: null, bucket: null, isDemo: false });
    for (const id of ['rows', 'kpis', 'aging', 'requestRows', 'userRows', 'checkResult', 'customerList']) $(id).innerHTML = '';
    document.querySelectorAll('[data-admin]').forEach((el) => { el.hidden = true; });
    $('stamp').textContent = 'الائتمان والضمان والمتأخرات';
  }

  function signedOut(message) {
    saveToken('');
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
    return parts.length ? `مراجعة البيانات: ${parts.join('، ')}.` : '';
  }

  function recompute() {
    const { base, tx, analysisDay } = state.sheets;
    state.result = Engine.analyze(base, tx, state.rules, analysisDay);
    state.result.invoices.forEach((inv, key) => { inv.key = key; });
    $('stamp').textContent = `${state.isDemo ? 'بيانات نموذجية · ' : ''}المتأخرات محسوبة حتى ${dateOf(state.result.analysisDay)} (آخر حركة في الشيت)`;
    const demoNote = state.isDemo ? 'هذه بيانات نموذجية للتجربة وليست بيانات حقيقية. ' : '';
    banner((demoNote + issuesText(state.result.issues)).trim());
    fillRepFilter();
    fillCustomerList();
    fillRulesForm();
    state.shown = PAGE_SIZE;
    renderInvoices();
    $('checkResult').innerHTML = '';
  }

  async function loadData() {
    banner('جارٍ قراءة البيانات من الشيت، وقد يستغرق ذلك بعض الوقت…');
    $('reload').disabled = true;
    try {
      const data = await callScript('data');
      state.sheets = { base: data.base, tx: data.tx, analysisDay: data.analysisDay };
      state.rules = data.rules;
      console.info('data read', data.stats);
      recompute();
      show('invoices');
    } catch (e) {
      console.error(e);
      if (state.token) banner(e.message, true);
    } finally {
      $('reload').disabled = false;
    }
  }

  function loadDemo() {
    const { base, tx } = window.demoSheets();
    state.isDemo = true;
    state.sheets = { base, tx, analysisDay: null };
    state.rules = Engine.DEFAULT_RULES;
    state.user = null;
    $('whoami').textContent = 'وضع التجربة';
    $('loginError').hidden = true;
    signedIn();
    recompute();
    show('invoices');
  }

  /* ---- navigation ------------------------------------------------------------- */

  function show(view) {
    for (const name of ['login', 'invoices', 'check', 'requests', 'users', 'settings']) $(`view-${name}`).hidden = name !== view;
    document.querySelectorAll('.tabs button').forEach((b) => {
      if (b.dataset.view === view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
  }

  /* ---- invoices screen ------------------------------------------------------ */

  function fillRepFilter() {
    const reps = [...new Set(state.result.invoices.map((i) => i.rep))].sort((a, b) => a.localeCompare(b, 'ar'));
    const current = $('rep').value;
    $('rep').innerHTML = `<option value="">كل المندوبين</option>${reps.map((r) => `<option>${esc(r)}</option>`).join('')}`;
    if (reps.includes(current)) $('rep').value = current;
  }

  function renderKpis() {
    const s = state.result.summary;
    const kpi = (label, value, sub) => `<div class="kpi"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(sub)}</small></div>`;
    $('kpis').innerHTML = [
      kpi('الفواتير المفتوحة', money(s.openAmount), `${money(s.open)} فاتورة من ${money(s.invoices)}`),
      kpi('المتأخرات', money(s.overdueAmount), s.openAmount ? `${Math.round((s.overdueAmount / s.openAmount) * 100)}% من المفتوح` : '—'),
      kpi('غير مغطى بالضمان', money(s.uncoveredAmount), s.openAmount ? `${Math.round((s.uncoveredAmount / s.openAmount) * 100)}% من المفتوح` : '—'),
      kpi('تجاوز حد الائتمان', money(s.overLimitAmount), `${money(s.overLimitCustomers)} عميل`),
      kpi('فواتير حرجة', money(s.byVerdict.stop.count), `متبقٍ ${money(s.byVerdict.stop.amount)}`),
    ].join('');
    $('aging').innerHTML = Engine.AGING_BUCKETS.map((label, i) => `
      <button type="button" data-bucket="${i}" aria-pressed="${state.bucket === i}">
        <span>${esc(label)}</span><b>${money(s.aging[i])}</b>
      </button>`).join('');
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
        <td>${esc(i.customer)}<span class="sub">${esc(i.account)} · ${esc(i.rep)}</span></td>
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
    const creditWhy = c.stopped ? 'حساب العميل موقوف.'
      : c.creditLimit <= 0 ? 'لا يوجد حد ائتمان مسجل لهذا العميل.'
      : `الرصيد بعد الفاتورة ${money(r.balanceAfter)} من حد ${money(c.creditLimit)}. المتاح الآن ${money(r.maxByCredit)}.`;
    const guaranteeWhy = c.guarantee > 0
      ? `الضمان ${money(c.guarantee)}، وغير المغطى بعد الفاتورة ${money(r.uncovered)}.`
      : `لا يوجد ضمان، والرصيد بعد الفاتورة ${money(r.balanceAfter)}.`;
    const arrearsWhy = c.overdue >= 1
      ? `متأخرات ${money(c.overdue)}، وأقدمها متأخر ${c.oldestOverdueDays} يوم. تصبح حرجة بعد ${state.result.rules.stopDays} يوم.`
      : 'لا توجد متأخرات على العميل.';
    $('checkResult').innerHTML = `
      <div class="result">
        <div class="decision ${r.verdict}">${title}<small>${esc(c.name)} · فاتورة بقيمة ${money(amount)}. ${sub}</small></div>
        <div class="cards">
          ${card('الائتمان', r.checks.credit, creditWhy)}
          ${card('الضمان', r.checks.guarantee, guaranteeWhy)}
          ${card('المتأخرات', r.checks.arrears, arrearsWhy)}
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
      renderRequests();
    } catch (e) {
      state.requests = [];
      $('requestRows').innerHTML = '';
      $('requestsCount').textContent = e.message;
    } finally {
      $('requestsReload').disabled = false;
    }
  }

  function renderRequests() {
    const status = $('requestStatus').value;
    const list = state.requests.filter((r) => !status || r.status === status).reverse();
    const pending = state.requests.filter((r) => r.status === 'قيد الاعتماد');
    const pendingTotal = pending.reduce((s, r) => s + Number(r.amount), 0);
    $('requestsCount').textContent = `${money(list.length)} طلب · قيد الاعتماد ${money(pending.length)} بقيمة ${money(pendingTotal)}`;
    if (!list.length) {
      $('requestRows').innerHTML = '<tr><td colspan="7" class="empty">لا توجد طلبات مطابقة.</td></tr>';
      return;
    }
    const own = (r) => state.user && String(r.requesterUser).toLowerCase() === state.user.username;
    $('requestRows').innerHTML = list.map((r) => `
      <tr>
        <td>${esc(r.id)}<span class="sub">${esc(r.createdAt)}</span></td>
        <td>${esc(r.customer)}<span class="sub">${esc(r.account)} · ${esc(r.rep)}</span></td>
        <td class="n">${money(r.amount)}</td>
        <td><span class="tag ${VERDICT_TAG[r.verdict] || 'paid'}">${esc(r.verdict)}</span><span class="sub">${esc(r.reasons)}</span></td>
        <td>${esc(r.requester)}${r.note ? `<span class="sub">${esc(r.note)}</span>` : ''}</td>
        <td><span class="tag ${STATUS_TAG[r.status] || 'paid'}">${esc(r.status)}</span>
          ${r.approver ? `<span class="sub">${esc(r.approver)} · ${esc(r.decidedAt)}</span>` : ''}
          ${r.verdictAtDecision ? `<span class="sub">عند القرار: ${esc(r.verdictAtDecision)}</span>` : ''}
          ${r.decisionNote ? `<span class="sub">${esc(r.decisionNote)}</span>` : ''}</td>
        <td>${canDecide() && r.status === 'قيد الاعتماد' && (isAdmin() || !own(r)) ? `<button type="button" class="ghost" data-id="${esc(r.id)}">قرار</button>` : ''}</td>
      </tr>`).join('');
  }

  async function openDecision(id) {
    const r = state.requests.find((x) => x.id === id);
    if (!r) return;
    state.deciding = r;
    $('decisionTitle').textContent = `قرار الطلب ${r.id}`;
    $('decisionInfo').textContent = `${r.customer} · ${money(r.amount)} · عند التسجيل: ${r.verdict}`;
    $('decisionCurrent').textContent = 'جارٍ فحص الطلب بالبيانات الحالية…';
    $('decisionNote').value = '';
    $('decisionError').hidden = true;
    $('approve').disabled = $('reject').disabled = true;
    $('decision').showModal();
    try {
      const { check } = await callScript('recheck', { id });
      if (state.deciding !== r) return;
      $('decisionCurrent').innerHTML = `
        <b>الموقف الآن:</b><span class="tag ${check.verdict}">${esc(check.verdictLabel)}</span>
        <span class="sub">الرصيد بعد الفاتورة ${money(check.balanceAfter)} من حد ${money(check.creditLimit)} · الضمان ${money(check.guarantee)} · المتأخرات ${money(check.overdue)}${check.reasons ? ` · ${esc(check.reasons)}` : ''}</span>`;
      $('approve').disabled = $('reject').disabled = false;
    } catch (e) {
      $('decisionCurrent').textContent = '';
      $('decisionError').textContent = e.message;
      $('decisionError').hidden = false;
    }
  }

  async function decide(decision) {
    $('approve').disabled = $('reject').disabled = true;
    $('decisionError').hidden = true;
    try {
      const data = await callScript('decide', { id: state.deciding.id, decision, note: $('decisionNote').value });
      state.requests = state.requests.map((r) => (r.id === data.request.id ? data.request : r));
      $('decision').close();
      renderRequests();
    } catch (e) {
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

  function exportCsv() {
    const header = ['الفاتورة', 'النوع', 'كود العميل', 'العميل', 'المندوب', 'التاريخ', 'الاستحقاق', 'القيمة', 'المسدد', 'المتبقي', 'أيام التأخير', 'الائتمان', 'الضمان', 'غير المغطى', 'المتأخرات', 'الموقف'];
    const rows = state.filtered.map((i) => [
      i.number, i.type, i.account, i.customer, i.rep, dateOf(i.day), dateOf(i.dueDay),
      Math.round(i.amount), Math.round(i.paid), Math.round(i.remaining), i.overdueDays,
      i.checks.credit.label, i.checks.guarantee.label, Math.round(i.uncovered), i.checks.arrears.label, VERDICT[i.verdict],
    ]);
    const cell = (v) => {
      // A leading = + - @ would run as a formula when the file opens in Excel.
      const s = typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : String(v);
      return `"${s.replace(/"/g, '""')}"`;
    };
    const csv = [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `موقف-الفواتير-${dateOf(state.result.analysisDay)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
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
  }));
  $('loginForm').addEventListener('submit', login);
  $('logout').addEventListener('click', logout);
  $('demo').addEventListener('click', loadDemo);
  $('reload').addEventListener('click', () => (state.isDemo ? loadDemo() : loadData()));
  $('requestStatus').addEventListener('change', renderRequests);
  $('requestsReload').addEventListener('click', loadRequests);
  $('requestRows').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (b) openDecision(b.dataset.id);
  });
  $('approve').addEventListener('click', () => decide('approve'));
  $('reject').addEventListener('click', () => decide('reject'));
  $('decisionClose').addEventListener('click', () => $('decision').close());
  $('userForm').addEventListener('submit', saveUser);
  $('userClear').addEventListener('click', clearUserForm);
  $('userRows').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-user]');
    if (b) editUser(b.dataset.user);
  });
  $('passwordForm').addEventListener('submit', changePassword);
  $('rulesForm').addEventListener('submit', saveRules);
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
  $('rows').addEventListener('click', (e) => openRow(e.target.closest('tr')));
  $('rows').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openRow(e.target.closest('tr'));
  });

  if (state.token) {
    signedIn();
    show('invoices');
    loadData();
  } else {
    show('login');
  }
})();

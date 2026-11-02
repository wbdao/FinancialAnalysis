/*
 * app.js - loads the sheets and draws the three screens.
 *
 * The site reads only: Google Sheets through the public gviz endpoint (JSONP,
 * because that endpoint sends no CORS headers). The sheet link stays in this
 * browser's localStorage and never enters the repository.
 */
(function () {
  'use strict';

  const SETTINGS_KEY = 'financialAnalysis.settings';
  const PAGE_SIZE = 300;
  const DEFAULTS = Object.assign(
    {
      sheetUrl: '', baseTab: 'قاعده عملاء الشركه', txTab: 'حركات العملاء',
      scriptUrl: 'https://script.google.com/macros/s/AKfycbyhTT5bBIGue4Kbqs2VAuR39us1cUqNFIHPE9DJpnh77vZjM3bmZb74HgMFh67aG0Q/exec',
      accessKey: '', userName: '',
    },
    Engine.DEFAULT_RULES,
  );
  const STATUS_TAG = { 'قيد الاعتماد': 'warn', 'معتمد': 'ok', 'مرفوض': 'stop', 'لا يحتاج اعتماد': 'paid' };
  const VERDICT_TAG = { 'سليمة': 'ok', 'تحتاج موافقة': 'warn', 'موقوفة': 'stop' };
  const VERDICT = { ok: 'منتظمة', warn: 'تحتاج متابعة', stop: 'حرجة', paid: 'مسددة' };
  const NEW_VERDICT = {
    ok: ['يمكن إصدار الفاتورة', 'لا توجد ملاحظات على الائتمان أو الضمان أو المتأخرات.'],
    warn: ['تحتاج موافقة قبل الإصدار', 'توجد ملاحظة أو أكثر تحتاج قرار المسؤول.'],
    stop: ['الفاتورة موقوفة', 'لا تُصدر الفاتورة آجلة قبل معالجة الأسباب الموضحة.'],
  };

  const $ = (id) => document.getElementById(id);
  const money = (v) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(v);
  const dateOf = (day) => (day == null ? '—' : new Date(day * 86400000).toISOString().slice(0, 10));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  const state = {
    settings: loadSettings(), rawSheets: null, isDemo: false, result: null, shown: PAGE_SIZE, bucket: null, filtered: [],
    requests: [], role: '', lastCheck: null, deciding: null,
  };

  /* ---- settings ------------------------------------------------------------ */

  function loadSettings() {
    try {
      return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(SETTINGS_KEY)));
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    } catch (e) {
      console.warn('settings not saved', e);
    }
  }

  const rulesFrom = (s) => ({ overLimit: s.overLimit, stopDays: Number(s.stopDays), tolerance: Number(s.tolerance) });

  function fillSettingsForm() {
    for (const key of Object.keys(DEFAULTS)) $(key).value = state.settings[key];
  }

  /* ---- Google Sheets read path (gviz JSONP) --------------------------------- */

  let jsonpSeq = 0;

  function gvizRequest(sheetId, tab) {
    return new Promise((resolve, reject) => {
      const cb = `__gviz_${Date.now().toString(36)}_${jsonpSeq++}`;
      const params = new URLSearchParams({ tqx: `out:json;responseHandler:${cb}`, headers: '1', tq: 'select *', sheet: tab });
      const script = document.createElement('script');
      const cleanup = () => { delete window[cb]; script.remove(); clearTimeout(timer); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`انتهت مهلة قراءة شيت "${tab}".`)); }, 120000);
      window[cb] = (payload) => { cleanup(); resolve(payload); };
      script.onerror = () => {
        cleanup();
        reject(new Error('تعذّر الوصول إلى Google Sheet. تأكد أن الملف محفوظ كـ Google Sheet وليس xlsx، ومشارك «أي شخص لديه الرابط».'));
      };
      script.src = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?${params}`;
      document.head.appendChild(script);
    });
  }

  function gvizCell(cell) {
    if (!cell || cell.v == null) return '';
    const v = cell.v;
    if (typeof v === 'string') {
      const m = /^Date\((\d+),(\d+),(\d+)/.exec(v);
      if (m) return Date.UTC(+m[1], +m[2], +m[3]) / 86400000;
    }
    return v;
  }

  function gvizToRows(payload, tab) {
    if (!payload || payload.status === 'error') {
      const e = (payload && payload.errors && payload.errors[0]) || {};
      if (e.reason === 'access_denied') throw new Error('الشيت غير مشارك. اجعل الوصول «أي شخص لديه الرابط — عارض».');
      throw new Error(`خطأ في قراءة شيت "${tab}": ${e.detailed_message || e.message || 'غير معروف'}`);
    }
    const table = payload.table || { cols: [], rows: [] };
    const header = table.cols.map((c) => (c.label || '').trim());
    const rows = table.rows.map((r) => (r.c || []).map(gvizCell));
    // When gviz did not detect a header row, the first data row holds it.
    if (header.every((h) => !h) && rows.length) return rows;
    return [header].concat(rows);
  }

  const sheetIdFrom = (url) => (/\/spreadsheets\/d\/([\w-]+)/.exec(url || '') || [])[1] || '';

  async function loadFromSheet() {
    const { sheetUrl, baseTab, txTab } = state.settings;
    const id = sheetIdFrom(sheetUrl);
    if (!id) throw new Error('الرابط غير صحيح. الصق رابط Google Sheet كاملًا.');
    const [base, tx] = await Promise.all([gvizRequest(id, baseTab), gvizRequest(id, txTab)]);
    return { base: gvizToRows(base, baseTab), tx: gvizToRows(tx, txTab) };
  }

  /* ---- load and analyze ------------------------------------------------------ */

  function banner(text, isError) {
    $('banner').hidden = !text;
    $('banner').textContent = text || '';
    $('banner').classList.toggle('error', !!isError);
  }

  function issuesText(issues) {
    const parts = [];
    if (issues.badDates) parts.push(`${issues.badDates} حركة تاريخها غير مقروء ولم تُحسب`);
    if (issues.futureRows) parts.push(`${issues.futureRows} حركة بتاريخ مستقبلي`);
    if (issues.notInBase) parts.push(`${issues.notInBase} حساب غير موجود في قاعدة العملاء، فاعتُبر بلا حد ائتمان أو ضمان`);
    if (issues.blankGuarantee) parts.push(`${issues.blankGuarantee} عميل خانة ضمانه فارغة، وربما الرقم مسجل كنص`);
    if (issues.balanceDiffs) parts.push(`${issues.balanceDiffs} عميل رصيده المحسوب من الحركات يختلف عن رصيد القاعدة`);
    return parts.length ? `مراجعة البيانات: ${parts.join('، ')}.` : '';
  }

  function recompute() {
    state.result = Engine.analyze(state.rawSheets.base, state.rawSheets.tx, rulesFrom(state.settings));
    state.result.invoices.forEach((inv, key) => { inv.key = key; });
    const { analysisDay, issues } = state.result;
    $('stamp').textContent = `${state.isDemo ? 'بيانات نموذجية · ' : ''}المتأخرات محسوبة حتى ${dateOf(analysisDay)} (آخر حركة في الشيت)`;
    const demoNote = state.isDemo ? 'هذه بيانات نموذجية للتجربة وليست بيانات حقيقية. ' : '';
    banner((demoNote + issuesText(issues)).trim());
    fillRepFilter();
    fillCustomerList();
    state.shown = PAGE_SIZE;
    renderInvoices();
    $('checkResult').innerHTML = '';
  }

  async function load() {
    if (!state.settings.sheetUrl) {
      show('settings');
      banner('الصق رابط Google Sheet لبدء التحليل، أو جرّب البيانات النموذجية.');
      return;
    }
    banner('جارٍ قراءة الشيت…');
    $('reload').disabled = true;
    try {
      state.rawSheets = await loadFromSheet();
      state.isDemo = false;
      recompute();
      show('invoices');
    } catch (e) {
      console.error(e);
      banner(e.message, true);
      show('settings');
    } finally {
      $('reload').disabled = false;
    }
  }

  function loadDemo() {
    state.rawSheets = window.demoSheets();
    state.isDemo = true;
    recompute();
    show('invoices');
  }

  /* ---- navigation ------------------------------------------------------------- */

  function show(view) {
    for (const name of ['invoices', 'check', 'requests', 'settings']) $(`view-${name}`).hidden = name !== view;
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
      <h2>${esc(inv.type)} ${esc(inv.number)} <span class="tag ${inv.verdict}">${VERDICT[inv.verdict]}</span></h2>
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
    if (!state.result) { $('checkResult').innerHTML = '<p class="empty">حمّل البيانات أولًا من الإعدادات.</p>'; return; }
    const c = findCustomer($('checkCustomer').value);
    if (!c) { $('checkResult').innerHTML = '<p class="empty">لم أجد هذا العميل. اختره من القائمة.</p>'; return; }
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

  /* ---- requests and approvals (Apps Script) ------------------------------------ */

  async function callScript(action, payload) {
    const { scriptUrl, accessKey } = state.settings;
    if (!scriptUrl || !accessKey) throw new Error('اكتب رابط Apps Script ومفتاح الدخول في الإعدادات.');
    // text/plain keeps this a simple request, which Apps Script can answer without CORS preflight.
    const res = await fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action, key: accessKey }, payload)),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('رد السكربت غير متوقع. تأكد من لصق Code.gs ونشر إصدار جديد بصلاحية Anyone.');
    }
    if (!data.ok) throw new Error(data.error || 'تعذّر تنفيذ الطلب.');
    if (data.role) state.role = data.role;
    return data;
  }

  async function sendRequest() {
    const { c, r, amount, ref } = state.lastCheck;
    const msg = $('requestMsg');
    if (state.isDemo) {
      msg.className = 'form-error';
      msg.textContent = 'لا يمكن تسجيل طلب من البيانات النموذجية، حتى لا تصل بيانات وهمية إلى الشيت.';
      return;
    }
    $('sendRequest').disabled = true;
    msg.className = '';
    msg.textContent = 'جارٍ التسجيل…';
    try {
      const data = await callScript('add', {
        request: {
          account: c.account, customer: c.name, rep: c.rep, idNumber: c.idNumber, warehouse: c.warehouse, group: c.group,
          amount, balance: c.balance, balanceAfter: r.balanceAfter,
          creditLimit: c.creditLimit, guarantee: c.guarantee, uncovered: r.uncovered, overdue: c.overdue,
          oldestDays: c.oldestOverdueDays, dataDate: dateOf(state.result.analysisDay), verdict: r.verdict,
          reasons: Object.values(r.checks).filter((x) => x.level !== 'ok').map((x) => x.label).join('، '),
          requester: state.settings.userName, note: $('requestNote').value, ref,
        },
      });
      msg.className = 'ok-msg';
      msg.textContent = `تم تسجيل الطلب ${data.request.id}: ${data.request.status}.`;
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
    $('requestRows').innerHTML = list.map((r) => `
      <tr class="plain">
        <td>${esc(r.id)}<span class="sub">${esc(r.createdAt)}</span></td>
        <td>${esc(r.customer)}<span class="sub">${esc(r.account)} · ${esc(r.rep)}</span></td>
        <td class="n">${money(r.amount)}</td>
        <td><span class="tag ${VERDICT_TAG[r.verdict] || 'paid'}">${esc(r.verdict)}</span><span class="sub">${esc(r.reasons)}</span></td>
        <td>${esc(r.requester)}${r.note ? `<span class="sub">${esc(r.note)}</span>` : ''}</td>
        <td><span class="tag ${STATUS_TAG[r.status] || 'paid'}">${esc(r.status)}</span>
          ${r.approver ? `<span class="sub">${esc(r.approver)} · ${esc(r.decidedAt)}</span>` : ''}
          ${r.decisionNote ? `<span class="sub">${esc(r.decisionNote)}</span>` : ''}</td>
        <td>${state.role === 'approver' && r.status === 'قيد الاعتماد' ? `<button type="button" class="ghost" data-id="${esc(r.id)}">قرار</button>` : ''}</td>
      </tr>`).join('');
  }

  function openDecision(id) {
    const r = state.requests.find((x) => x.id === id);
    if (!r) return;
    state.deciding = r;
    $('decisionTitle').textContent = `قرار الطلب ${r.id}`;
    $('decisionInfo').textContent = `${r.customer} · ${money(r.amount)} · الرصيد بعد الفاتورة ${money(r.balanceAfter)} من حد ${money(r.creditLimit)} · الضمان ${money(r.guarantee)} · المتأخرات ${money(r.overdue)}`;
    $('decisionNote').value = '';
    $('decisionError').hidden = true;
    $('decision').showModal();
  }

  async function decide(decision) {
    $('approve').disabled = $('reject').disabled = true;
    $('decisionError').hidden = true;
    try {
      const data = await callScript('decide', {
        id: state.deciding.id, decision, approver: state.settings.userName, note: $('decisionNote').value,
      });
      state.requests = state.requests.map((r) => (r.id === data.request.id ? data.request : r));
      $('decision').close();
      renderRequests();
    } catch (e) {
      $('decisionError').textContent = e.message;
      $('decisionError').hidden = false;
    } finally {
      $('approve').disabled = $('reject').disabled = false;
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
  }));
  $('requestStatus').addEventListener('change', renderRequests);
  $('requestsReload').addEventListener('click', loadRequests);
  $('requestRows').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (b) openDecision(b.dataset.id);
  });
  $('approve').addEventListener('click', () => decide('approve'));
  $('reject').addEventListener('click', () => decide('reject'));
  $('decisionClose').addEventListener('click', () => $('decision').close());
  $('reload').addEventListener('click', () => (state.isDemo ? loadDemo() : load()));
  $('demo').addEventListener('click', loadDemo);
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
  $('settingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    for (const key of Object.keys(DEFAULTS)) state.settings[key] = $(key).value.trim();
    saveSettings();
    if (state.isDemo && !state.settings.sheetUrl) recompute();
    else load();
  });

  fillSettingsForm();
  load();
})();

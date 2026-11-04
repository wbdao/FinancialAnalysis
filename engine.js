/*
 * engine.js - the position of every invoice: credit, guarantee and arrears.
 *
 * Inputs are plain row arrays (header row first), so the same engine serves the
 * Google Sheets read path, the demo data and the Node tests. Dates must already
 * be epoch-day integers (days since 1970-01-01, UTC).
 *
 * Column names, payment-term codes and the FIFO settlement match CSAccounts, so
 * balances and arrears agree between the two sites.
 */
(function (root) {
  'use strict';

  const DEFAULT_RULES = {
    overLimit: 'stop',  // a new invoice above the credit limit: 'stop' or 'warn'
    stopDays: 90,       // arrears older than this stop the customer
    tolerance: 1000,    // arrears below this amount are ignored
  };
  const AGING_BUCKETS = ['غير مستحق', 'متأخر 1-30', 'متأخر 31-60', 'متأخر 61-90', 'متأخر 91-180', 'متأخر +180'];
  const SEVERITY = { ok: 0, warn: 1, stop: 2 };
  const PAID_BELOW = 0.5;  // a smaller remainder is rounding, not debt

  const BASE_COLS = {
    account: ['Account'], name: ['Name'], warehouse: ['Warehouse Group'], group: ['Customer group'],
    guarantee: ['Eligible credit limit', 'الضمان'], creditLimit: ['Credit limit'], baseBalance: ['Balance'],
    terms: ['Payment schedule'], paymentMethod: ['طريقة السداد', 'طرق السداد'], rep: ['Worker Name'], idNumber: ['ID number'],
  };
  const TX_COLS = {
    account: ['Account'], voucher: ['voucher'], kind: ['Transaction type'], date: ['Date'],
    invoice: ['Invoice'], description: ['Description'], amount: ['Amount'],
  };
  const REQUIRED = { base: ['account', 'name', 'creditLimit'], tx: ['account', 'kind', 'date', 'amount'] };

  // The checks sheet, read as CSAccounts reads it. A received check is booked as
  // a payment at once, so an open check is debt the balance no longer shows.
  // Main tab: these statuses are settled, any other is open. Warehouse tab: only mm = "NN" is open.
  const CHECK_SETTLED = ['خالص', 'متابعة حساب', 'غير تابع'];
  const CHECK_REJECTED = 'تم الرفض';
  const CHECK_COLS = {
    main: {
      account: ['كود العميل'], checkNo: ['رقم الشيك'], amount: ['قيمة الشيك'], paid: ['دفعات شيكات'],
      net: ['صافى الشيك', 'صافي الشيك'], due: ['تاريخ الاستحقاق'], status: ['الحاله', 'الحالة'], cash: ['حالة الصرف'],
    },
    wh: {
      account: ['كود العميل'], checkNo: ['رقم الشيك'], amount: ['قيمة الشيك'], collected: ['التحصيل'],
      net: ['الصافي', 'الصافى'], due: ['تاريخ الاستحقاق'], state: ['mm'],
    },
  };

  function dayOf(y, m, d) { return Date.UTC(y, m - 1, d) / 86400000; }

  const str = (v) => (v == null ? '' : String(v).trim());
  const num = (v) => {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    const n = parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
    return isFinite(n) ? n : 0;
  };

  function mapHeader(header, spec, required, sheetLabel) {
    const norm = header.map((h) => str(h).toLowerCase());
    const idx = {};
    for (const [key, names] of Object.entries(spec)) {
      const i = names.map((n) => norm.indexOf(n.toLowerCase())).find((j) => j >= 0);
      idx[key] = i === undefined ? -1 : i;
    }
    const missing = required.filter((key) => idx[key] < 0).map((key) => spec[key][0]);
    if (missing.length) throw new Error(`شيت "${sheetLabel}" ناقصه الأعمدة: ${missing.join('، ')}`);
    return idx;
  }

  /** Payment-schedule code to contract days (Fixed_N = N months, Sch_NW = N weeks). */
  function termDays(code) {
    const c = str(code);
    let m;
    if ((m = /net\s*(\d+)/i.exec(c))) return +m[1];
    if ((m = /sch_(\d+)w/i.exec(c))) return 7 * m[1];
    if ((m = /fixed_(\d+)/i.exec(c))) return 30 * m[1];
    if (/aow/i.test(c)) return 30;
    if (/cash/i.test(c)) return 1;
    return 0; // Stop and unknown codes: due immediately
  }

  function bucketOf(overdueDays) {
    if (overdueDays <= 0) return 0;
    if (overdueDays <= 30) return 1;
    if (overdueDays <= 60) return 2;
    if (overdueDays <= 90) return 3;
    if (overdueDays <= 180) return 4;
    return 5;
  }

  const worst = (checks) => checks.reduce((w, c) => (SEVERITY[c.level] > SEVERITY[w] ? c.level : w), 'ok');

  /* ---- the three checks: {level: ok|warn|stop, amount, label} -------------- */

  function creditCheck(limit, balanceAfter, invoiceAmount, severity) {
    if (limit <= 0) return { level: severity, amount: invoiceAmount, label: 'لا يوجد حد ائتمان' };
    const over = Math.max(0, balanceAfter - limit);
    if (over < PAID_BELOW) return { level: 'ok', amount: 0, label: 'داخل الحد' };
    return { level: severity, amount: Math.min(over, invoiceAmount), label: 'تجاوز الحد' };
  }

  function guaranteeCheck(guarantee, uncovered, overdueUncovered, rules) {
    if (overdueUncovered >= rules.tolerance) {
      return { level: 'stop', amount: uncovered, label: guarantee > 0 ? 'المتأخرات أعلى من الضمان' : 'متأخرات بدون ضمان' };
    }
    if (uncovered < PAID_BELOW) return { level: 'ok', amount: 0, label: 'مغطاة بالضمان' };
    return { level: 'warn', amount: uncovered, label: guarantee > 0 ? 'مغطاة جزئيًا' : 'بدون ضمان' };
  }

  // A rejected check still open stops new credit; a due check not yet cashed asks for approval.
  function chequesCheck(c, rules) {
    if (!c.hasChecks) return { level: 'ok', amount: 0, label: 'بيانات الشيكات غير متاحة' };
    if (c.checksRejectedCount) return { level: 'stop', amount: c.checksRejected, label: `شيكات مرفوضة (${c.checksRejectedCount})` };
    if (c.checksDue >= rules.tolerance) return { level: 'warn', amount: c.checksDue, label: `شيكات مستحقة لم تُصرف (${c.checksDueCount})` };
    return { level: 'ok', amount: 0, label: c.checksOpenCount ? 'شيكات تحت التحصيل' : 'لا توجد شيكات مفتوحة' };
  }

  function arrearsCheck(overdue, days, rules) {
    if (overdue < rules.tolerance) return { level: 'ok', amount: 0, days: 0, label: 'لا توجد متأخرات' };
    return { level: days > rules.stopDays ? 'stop' : 'warn', amount: overdue, days, label: `متأخرة ${days} يوم` };
  }

  /* ---- the analysis --------------------------------------------------------- */

  /**
   * lastMovementDay - the analysis date: the last real movement in the sheet.
   * Rows with no amount or dated after today are ignored: a date typed day/month
   * into a month/day sheet must not age every debt.
   */
  function lastMovementDay(txRows) {
    const ti = mapHeader(txRows[0] || [], TX_COLS, REQUIRED.tx, 'حركات العملاء');
    const today = Math.floor(Date.now() / 86400000);
    let best = -Infinity;
    for (let r = 1; r < txRows.length; r++) {
      const row = txRows[r];
      const day = row[ti.date];
      if (!str(row[ti.account]) || typeof day !== 'number' || !isFinite(day) || num(row[ti.amount]) === 0) continue;
      const d = Math.floor(day);
      if (d <= today + 1 && d > best) best = d;
    }
    return isFinite(best) ? best : today;
  }

  /**
   * analyze - every debit as an invoice with its position, plus customer totals.
   * @param {!Array<!Array>} baseRows customers sheet, header first
   * @param {!Array<!Array>} txRows movements sheet, header first, dates as epoch days
   * @param {!Object=} rulesIn overrides of DEFAULT_RULES
   * @param {?number=} analysisDayIn the date to age against. A user limited to
   *     some warehouses gets it from the whole sheet, so their aging matches everyone's.
   * @param {?{main: ?Array<!Array>, wh: ?Array<!Array>}=} checkRows the checks tabs,
   *     header first. Without them every check figure is zero and the results are unchanged.
   */
  function analyze(baseRows, txRows, rulesIn, analysisDayIn, checkRows, paymentPlans) {
    const rules = Object.assign({}, DEFAULT_RULES, rulesIn);
    const bi = mapHeader(baseRows[0] || [], BASE_COLS, REQUIRED.base, 'قاعدة العملاء');
    const plans = Array.isArray(paymentPlans) ? paymentPlans : [];
    const planMap = {};
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i] || {};
      const key = str(p.name || p.method || p.paymentMethod || p.planName || p['طريقة السداد']).toLowerCase();
      if (key) planMap[key] = p;
    }
    function planDaysFor(code, method) {
      const m = str(method).toLowerCase();
      if (m && planMap[m]) {
        const pm = planMap[m];
        const cnt = num(pm.count || pm.installments || pm.numPayments || pm['عدد الفعات'] || pm['عدد الدعات']);
        const dper = num(pm.daysPerInstallment || pm.days || pm.periodDays || pm['عدد الايام لكل دعه'] || pm['عدد الأيام لكل دعة']);
        if (dper > 0 && cnt > 0) return Math.round(dper * cnt);
        if (dper > 0) return Math.round(dper);
        if (cnt > 0 && dper > 0) return Math.round(cnt * dper);
      }
      return termDays(code);
    }
    const ti = mapHeader(txRows[0] || [], TX_COLS, REQUIRED.tx, 'حركات العملاء');
    const pick = (row, i) => (i >= 0 ? row[i] : '');
    const issues = {
      badDates: 0, zeroRows: 0, futureRows: 0, notInBase: 0, blankGuarantee: 0, balanceDiffs: 0,
      // Optional for the analysis, but their absence leaves empty cells in the requests sheet.
      missingColumns: ['idNumber', 'warehouse', 'group'].filter((key) => bi[key] < 0).map((key) => BASE_COLS[key][0]),
    };

    // ---- movements ----------------------------------------------------------
    const tx = [];
    const analysisDay = analysisDayIn != null ? analysisDayIn : lastMovementDay(txRows);
    const todayCap = Math.floor(Date.now() / 86400000) + 1;
    for (let r = 1; r < txRows.length; r++) {
      const row = txRows[r];
      const account = str(pick(row, ti.account));
      if (!account) continue;
      const day = row[ti.date];
      if (typeof day !== 'number' || !isFinite(day)) { issues.badDates++; continue; }
      const t = {
        account, day: Math.floor(day), amount: num(row[ti.amount]), kind: str(row[ti.kind]),
        voucher: str(pick(row, ti.voucher)), invoice: str(pick(row, ti.invoice)), description: str(pick(row, ti.description)),
      };
      if (t.invoice === '0') t.invoice = '';
      if (t.amount === 0) { issues.zeroRows++; continue; }
      if (t.day > todayCap) issues.futureRows++;
      tx.push(t);
    }
    tx.sort((a, b) => a.day - b.day || b.amount - a.amount);
    const txByAccount = new Map();
    for (const t of tx) {
      if (!txByAccount.has(t.account)) txByAccount.set(t.account, []);
      txByAccount.get(t.account).push(t);
    }

    // ---- checks ---------------------------------------------------------------
    const hasChecks = !!(checkRows && (checkRows.main || checkRows.wh));
    const checksByAccount = new Map();
    if (hasChecks) {
      for (const k of parseChecks(checkRows.main, checkRows.wh)) {
        if (!checksByAccount.has(k.account)) checksByAccount.set(k.account, []);
        checksByAccount.get(k.account).push(k);
      }
    }

    // ---- customers ----------------------------------------------------------
    const customers = [];
    const seen = new Set();
    const add = (base) => {
      if (seen.has(base.account)) return;
      seen.add(base.account);
      const c = computeCustomer(base, txByAccount.get(base.account) || [], analysisDay, rules, checksByAccount.get(base.account) || [], planDaysFor);
      c.hasChecks = hasChecks;
      customers.push(c);
    };
    for (let r = 1; r < baseRows.length; r++) {
      const row = baseRows[r];
      const account = str(pick(row, bi.account));
      if (!account) continue;
      if (str(pick(row, bi.guarantee)) === '') issues.blankGuarantee++;
      add({
        account, name: str(pick(row, bi.name)) || account, warehouse: str(pick(row, bi.warehouse)), group: str(pick(row, bi.group)),
        creditLimit: num(pick(row, bi.creditLimit)), guarantee: Math.max(0, num(pick(row, bi.guarantee))),
        baseBalance: bi.baseBalance >= 0 ? num(row[bi.baseBalance]) : null,
        terms: str(pick(row, bi.terms)), paymentMethod: bi.paymentMethod >= 0 ? str(pick(row, bi.paymentMethod)) : '', rep: str(pick(row, bi.rep)) || 'بدون مندوب', idNumber: str(pick(row, bi.idNumber)), inBase: true,
      });
    }
    // Accounts that move but are missing from the customer base still count.
    for (const account of txByAccount.keys()) {
      if (seen.has(account)) continue;
      issues.notInBase++;
      add({ account, name: account, warehouse: '', group: '', creditLimit: 0, guarantee: 0, baseBalance: null, terms: '', paymentMethod: '', rep: 'بدون مندوب', idNumber: '', inBase: false });
    }
    issues.balanceDiffs = customers.filter((c) => c.baseBalance != null && Math.abs(c.baseBalance - c.balance) >= 1).length;
    // Open checks of accounts unknown to the customer base add to nobody's exposure.
    issues.checksUnmatched = [...checksByAccount.keys()].filter((a) => !seen.has(a) && checksByAccount.get(a).some((k) => k.open)).length;

    const invoices = customers.flatMap((c) => c.invoices);
    const summary = summarize(customers, invoices);
    summary.hasChecks = hasChecks;
    return { customers, invoices, analysisDay, rules, issues, summary };
  }

  function computeCustomer(base, list, analysisDay, rules, checks, planDaysForFn) {
    const c = Object.assign({}, base, {
      contractDays: (planDaysForFn || termDays)(base.terms, base.paymentMethod), balance: 0, unapplied: 0, overdue: 0, oldestOverdueDays: 0,
      aging: [0, 0, 0, 0, 0, 0], invoices: [],
    });
    c.stopped = /stop/i.test(c.terms) || /^stoped/i.test(c.group);

    // FIFO: every credit settles the oldest open debit.
    const open = [];
    let credit = 0;
    for (const t of list) {
      c.balance += t.amount;
      if (t.amount > 0) {
        const inv = newInvoice(c, t);
        inv.arrearsAtIssue = open.reduce((s, o) => (o.dueDay < t.day ? s + o.remaining : s), 0);
        inv.balanceAfter = c.balance;
        const fromCredit = Math.min(credit, t.amount);
        credit -= fromCredit;
        inv.remaining -= fromCredit;
        if (inv.remaining > 1e-9) open.push(inv);
        else inv.settledDay = t.day;
        c.invoices.push(inv);
      } else {
        let left = -t.amount;
        while (left > 1e-9 && open.length) {
          const inv = open[0];
          const used = Math.min(inv.remaining, left);
          inv.remaining -= used;
          left -= used;
          if (inv.remaining <= 1e-9) { inv.settledDay = t.day; open.shift(); }
        }
        credit += left;
      }
    }
    c.unapplied = credit;

    // Aging of what is still open. The guarantee covers the oldest debts first.
    let guaranteeLeft = c.guarantee;
    for (const inv of open) {
      const days = analysisDay - inv.dueDay;
      c.aging[bucketOf(days)] += inv.remaining;
      if (days > 0) {
        c.overdue += inv.remaining;
        c.oldestOverdueDays = Math.max(c.oldestOverdueDays, days);
      }
      inv.covered = Math.min(guaranteeLeft, inv.remaining);
      guaranteeLeft -= inv.covered;
    }
    // Exposure: the balance plus the open checks it no longer shows.
    c.checksOpen = 0;
    c.checksOpenCount = 0;
    c.checksDue = 0;
    c.checksDueCount = 0;
    c.checksRejected = 0;
    c.checksRejectedCount = 0;
    c.checksNextDue = null;
    for (const k of checks) {
      if (!k.open) continue;
      c.checksOpen += k.net;
      c.checksOpenCount++;
      if (k.rejected) { c.checksRejected += k.net; c.checksRejectedCount++; }
      else if (k.due != null && k.due <= analysisDay) { c.checksDue += k.net; c.checksDueCount++; }
      else if (k.due != null && (c.checksNextDue == null || k.due < c.checksNextDue)) c.checksNextDue = k.due;
    }
    c.exposure = c.balance + c.checksOpen;
    c.uncovered = c.exposure > 0 ? Math.max(0, c.exposure - c.guarantee) : 0;
    c.availableCredit = c.creditLimit > 0 ? Math.max(0, c.creditLimit - c.exposure) : 0;
    c.overLimit = c.creditLimit > 0 ? Math.max(0, c.exposure - c.creditLimit) : 0;
    for (const inv of c.invoices) finishInvoice(inv, c, analysisDay, rules);
    return c;
  }

  function newInvoice(c, t) {
    const isSale = t.kind === 'Sales order';
    const isOpening = !isSale && /افتتاح/.test(t.description);
    return {
      account: c.account, customer: c.name, warehouse: c.warehouse, rep: c.rep,
      number: t.invoice || t.voucher || '—', voucher: t.voucher, isSale,
      type: isSale ? 'فاتورة بيع' : isOpening ? 'رصيد افتتاحي' : 'مديونية أخرى',
      day: t.day, dueDay: t.day + c.contractDays, amount: t.amount, remaining: t.amount, settledDay: null, covered: 0,
    };
  }

  /**
   * finishInvoice - the invoice's final position.
   * The credit check uses today's limit, because the sheet keeps no limit
   * history. So it can only raise a warning on an invoice already issued.
   */
  function finishInvoice(inv, c, analysisDay, rules) {
    inv.paid = inv.amount - inv.remaining;
    inv.isOpen = inv.remaining >= PAID_BELOW;
    inv.overdueDays = inv.isOpen ? Math.max(0, analysisDay - inv.dueDay) : 0;
    inv.bucket = inv.isOpen ? bucketOf(analysisDay - inv.dueDay) : -1;
    inv.uncovered = inv.isOpen ? Math.max(0, inv.remaining - inv.covered) : 0;
    const issued = inv.isSale ? creditCheck(c.creditLimit, inv.balanceAfter, inv.amount, 'warn') : { level: 'ok', amount: 0, label: 'لا ينطبق' };
    if (!inv.isOpen) {
      inv.checks = { credit: issued, guarantee: { level: 'ok', amount: 0, label: 'لا ينطبق' }, arrears: { level: 'ok', amount: 0, days: 0, label: 'مسددة' } };
      inv.verdict = 'paid';
      return;
    }
    const overdueAmount = inv.overdueDays > 0 ? inv.remaining : 0;
    inv.checks = {
      credit: issued,
      guarantee: guaranteeCheck(c.guarantee, inv.uncovered, inv.overdueDays > 0 ? inv.uncovered : 0, rules),
      arrears: arrearsCheck(overdueAmount, inv.overdueDays, rules),
    };
    inv.verdict = worst(Object.values(inv.checks));
  }

  /**
   * evaluateNew - may this customer take a new invoice of this amount?
   * Unlike an invoice already issued, this can be stopped by the credit limit.
   */
  function evaluateNew(c, amount, rules) {
    const r = Object.assign({}, DEFAULT_RULES, rules);
    const balanceAfter = c.balance + amount;
    // Credit and guarantee are measured on the exposure, open checks included.
    const exposureAfter = (c.exposure != null ? c.exposure : c.balance) + amount;
    const uncovered = exposureAfter > 0 ? Math.max(0, exposureAfter - c.guarantee) : 0;
    const overdueUncovered = Math.max(0, c.overdue - c.guarantee);
    const checks = {
      credit: c.stopped
        ? { level: 'stop', amount, label: 'العميل موقوف' }
        : creditCheck(c.creditLimit, exposureAfter, amount, r.overLimit),
      guarantee: guaranteeCheck(c.guarantee, uncovered, overdueUncovered, r),
      arrears: arrearsCheck(c.overdue, c.oldestOverdueDays, r),
      cheques: chequesCheck(c, r),
    };
    return {
      amount, balanceAfter, exposureAfter, uncovered, checks, verdict: worst(Object.values(checks)),
      // The largest invoice the credit limit still allows.
      maxByCredit: c.stopped ? 0 : c.availableCredit,
    };
  }

  function summarize(customers, invoices) {
    const s = {
      invoices: invoices.length, open: 0, openAmount: 0, overdueAmount: 0, uncoveredAmount: 0,
      byVerdict: { ok: { count: 0, amount: 0 }, warn: { count: 0, amount: 0 }, stop: { count: 0, amount: 0 }, paid: { count: 0, amount: 0 } },
      aging: [0, 0, 0, 0, 0, 0], overLimitAmount: 0, overLimitCustomers: 0,
      checksOpen: 0, checksDue: 0, checksDueCount: 0, checksRejected: 0, checksRejectedCount: 0,
    };
    for (const inv of invoices) {
      const v = s.byVerdict[inv.verdict];
      v.count++;
      v.amount += inv.isOpen ? inv.remaining : inv.amount;
      if (!inv.isOpen) continue;
      s.open++;
      s.openAmount += inv.remaining;
      s.uncoveredAmount += inv.uncovered;
      s.aging[inv.bucket] += inv.remaining;
      if (inv.overdueDays > 0) s.overdueAmount += inv.remaining;
    }
    for (const c of customers) {
      if (c.overLimit >= PAID_BELOW) { s.overLimitCustomers++; s.overLimitAmount += c.overLimit; }
      s.checksOpen += c.checksOpen;
      s.checksDue += c.checksDue;
      s.checksDueCount += c.checksDueCount;
      s.checksRejected += c.checksRejected;
      s.checksRejectedCount += c.checksRejectedCount;
    }
    return s;
  }

  /* ---- checks ----------------------------------------------------------------- */

  /** checkDay - a check date: epoch days from the server, or yyyy-mm-dd / d/m/yyyy text. */
  function checkDay(v) {
    if (v === '' || v == null) return null;
    if (typeof v === 'number') return v > 1000 ? Math.floor(v) : null;
    const t = str(v);
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
    if (m) return dayOf(+m[1], +m[2], +m[3]);
    m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(t);
    if (m) return dayOf(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
    return null;
  }

  // Column lookup that also accepts a header merged with a totals cell ("123 كود العميل").
  function checkColumns(header, spec) {
    const norm = header.map((h) => str(h));
    const idx = {};
    for (const [key, names] of Object.entries(spec)) {
      let at = -1;
      for (const n of names) {
        at = norm.indexOf(n);
        if (at < 0) at = norm.findIndex((h) => h.endsWith(' ' + n));
        if (at >= 0) break;
      }
      idx[key] = at;
    }
    return idx;
  }

  /**
   * parseChecks - both checks tabs as one list. A check in both tabs counts once,
   * from the main tab. Rows without a customer (the SUBTOTAL row) are skipped.
   */
  function parseChecks(mainRows, whRows) {
    const list = [];
    const keys = new Set();
    const read = (rows, spec, fn) => {
      if (!rows || !rows.length) return;
      const i = checkColumns(rows[0], spec);
      if (i.account < 0) return;
      const at = (row, k) => (i[k] >= 0 ? row[i[k]] : '');
      for (let r = 1; r < rows.length; r++) fn(rows[r], at);
    };
    read(mainRows, CHECK_COLS.main, (row, at) => {
      const account = str(at(row, 'account'));
      if (!account) return;
      const checkNo = str(at(row, 'checkNo'));
      const amount = num(at(row, 'amount'));
      const net = typeof at(row, 'net') === 'number' ? at(row, 'net') : amount - num(at(row, 'paid'));
      if (checkNo) keys.add(account + '|' + checkNo);
      list.push({
        account, checkNo, amount, net, due: checkDay(at(row, 'due')), src: 'main',
        open: CHECK_SETTLED.indexOf(str(at(row, 'status'))) < 0, rejected: str(at(row, 'cash')) === CHECK_REJECTED,
      });
    });
    read(whRows, CHECK_COLS.wh, (row, at) => {
      const account = str(at(row, 'account'));
      const checkNo = str(at(row, 'checkNo'));
      if (!account || (checkNo && keys.has(account + '|' + checkNo))) return;
      const amount = num(at(row, 'amount'));
      const net = typeof at(row, 'net') === 'number' ? at(row, 'net') : amount - num(at(row, 'collected'));
      list.push({
        account, checkNo, amount, net, due: checkDay(at(row, 'due')), src: 'wh',
        open: str(at(row, 'state')) === 'NN', rejected: false,
      });
    });
    return list;
  }

  const Engine = {
    analyze, evaluateNew, lastMovementDay, parseChecks, termDays, bucketOf, dayOf,
    DEFAULT_RULES, AGING_BUCKETS, BASE_COLS, TX_COLS, CHECK_COLS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  else root.Engine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);

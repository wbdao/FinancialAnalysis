/*
 * engine.test.js - unit tests for engine.js.
 *
 * Run with:  node test/engine.test.js     (no dependencies, exits 1 on failure)
 */
'use strict';

const assert = require('assert');
const Engine = require('../engine.js');

const day = (y, m, d) => Engine.dayOf(y, m, d);
const baseSheet = (rows) => [
  ['Account', 'Name', 'Customer group', 'Credit limit', 'Eligible credit limit', 'Balance', 'Payment schedule', 'Worker Name'],
  ...rows,
];
const txSheet = (rows) => [
  ['Account', 'Transaction type', 'Date', 'Amount', 'voucher', 'Invoice', 'Description'],
  ...rows,
];
// The last row fixes the analysis date for every test.
const asOf = (...rows) => txSheet([...rows, ['CLOCK', 'Payment', day(2026, 6, 30), -1, 'V0', '', '']]);
const cust = (r, account) => r.customers.find((c) => c.account === account);
const inv = (r, number) => r.invoices.find((i) => i.number === number);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('customer base fields used by the requests sheet are read', () => {
  const r = Engine.analyze(
    [['Account', 'Name', 'Credit limit', 'ID number', 'Warehouse Group', 'Customer group'], ['A', 'عميل', 1000, 'CH-7', 65, 'Wsagent-H']],
    txSheet([]),
  );
  const c = cust(r, 'A');
  assert.strictEqual(c.idNumber, 'CH-7');
  assert.strictEqual(c.warehouse, '65');
  assert.strictEqual(c.group, 'Wsagent-H');
});

test('missing requests-sheet columns are reported by name', () => {
  const none = Engine.analyze([['Account', 'Name', 'Credit limit'], ['A', 'عميل', 1000]], txSheet([]));
  assert.deepStrictEqual(none.issues.missingColumns, ['ID number', 'Warehouse Group', 'Customer group']);
  const all = Engine.analyze([['Account', 'Name', 'Credit limit', 'id number', 'WAREHOUSE GROUP', 'Customer group']], txSheet([]));
  assert.deepStrictEqual(all.issues.missingColumns, []);
});

/* ---- checks: the rules of CSAccounts ---- */
const checkMain = (rows) => [['NN', 'كود العميل', 'رقم الشيك', 'قيمة الشيك', 'دفعات شيكات', 'صافى الشيك', 'تاريخ الاستحقاق', 'الحاله', 'حالة الصرف'], ...rows];
const checkWh = (rows) => [['WH', 'كود العميل', 'رقم الشيك', 'قيمة الشيك', 'التحصيل', 'الصافي', 'تاريخ الاستحقاق', 'mm'], ...rows];

test('checks: settled statuses close a check, net falls back to amount minus payments', () => {
  const list = Engine.parseChecks(checkMain([
    ['CH1', 'A', '1', 1000, 0, 1000, day(2026, 7, 1), 'تحت التحصيل', ''],
    ['CH2', 'A', '2', 2000, 0, 2000, day(2026, 7, 1), 'خالص', ''],
    ['CH3', 'A', '3', 3000, 0, 3000, day(2026, 7, 1), 'متابعة حساب', ''],
    ['CH4', 'A', '4', 4000, 0, 4000, day(2026, 7, 1), 'غير تابع', ''],
    ['CH5', 'A', '5', 5000, 1500, '', '2026-07-01', '', 'تم الرفض'],
    ['', '', '', 99999, 0, 99999, '', '', ''],
  ]), null);
  assert.deepStrictEqual(list.map((k) => k.open), [true, false, false, false, true]);
  assert.strictEqual(list[4].net, 3500);
  assert.strictEqual(list[4].rejected, true);
  assert.strictEqual(list[4].due, day(2026, 7, 1));
});

test('checks: a warehouse check is open only at NN, and one in both tabs counts once', () => {
  const list = Engine.parseChecks(
    checkMain([['CH1', 'A', '1', 1000, 0, 1000, '', 'تحت التحصيل', '']]),
    checkWh([
      ['WH1', 'A', '1', 1000, 0, 1000, '', 'NN'],
      ['WH2', 'A', '2', 700, 200, '', '1/8/2026', 'NN'],
      ['WH3', 'A', '3', 900, 0, 900, '', 'محصل'],
    ]),
  );
  assert.strictEqual(list.length, 3);
  assert.deepStrictEqual(list.map((k) => [k.src, k.open, k.net]), [['main', true, 1000], ['wh', true, 500], ['wh', false, 900]]);
  assert.strictEqual(list[1].due, day(2026, 8, 1));
});

test('checks: a header merged with a totals cell is still found', () => {
  const list = Engine.parseChecks([['', '15 كود العميل', 'صافى الشيك', 'الحاله'], ['', 'A', 800, '']], null);
  assert.strictEqual(list[0].account, 'A');
  assert.strictEqual(list[0].net, 800);
});

const checkBase = baseSheet([['A', 'عميل', '', 10000, 8000, 0, 'Net30', 'م']]);
const checkTx = asOf(
  ['A', 'Sales order', day(2026, 6, 20), 9000, 'V1', 'I1', ''],
  ['A', 'Payment', day(2026, 6, 25), -5000, 'V2', '', 'شيك'],
);

test('checks: open checks stay outside the balance and only flag collection risk', () => {
  const r = Engine.analyze(checkBase, checkTx, null, null, {
    main: checkMain([['CH1', 'A', '1', 5000, 0, 5000, day(2026, 8, 1), '', '']]),
  });
  const c = cust(r, 'A');
  assert.strictEqual(c.balance, 4000);
  assert.strictEqual(c.checksOpen, 5000);
  // The checks sheet is a separate record: it never adds to the balance.
  assert.strictEqual(c.exposure, 4000);
  assert.strictEqual(c.availableCredit, 6000);
  assert.strictEqual(c.uncovered, 0);
  assert.strictEqual(c.checksNextDue, day(2026, 8, 1));
  const ok = Engine.evaluateNew(c, 1000);
  assert.strictEqual(ok.exposureAfter, 5000);
  assert.strictEqual(ok.checks.credit.level, 'ok');
  assert.strictEqual(ok.checks.cheques.label, 'شيكات تحت التحصيل');
  // The limit is measured on the movements, so an open check cannot stop it.
  assert.strictEqual(Engine.evaluateNew(c, 2000).checks.credit.level, 'ok');
});

test('checks: a rejected check stops new credit, a due uncashed one asks for approval', () => {
  const run = (rows) => cust(Engine.analyze(checkBase, checkTx, null, null, { main: checkMain(rows) }), 'A');
  const rejected = run([['CH1', 'A', '1', 300, 0, 300, day(2026, 8, 1), '', 'تم الرفض']]);
  assert.strictEqual(Engine.evaluateNew(rejected, 1).checks.cheques.level, 'stop');
  assert.strictEqual(rejected.checksRejectedCount, 1);
  const due = run([['CH1', 'A', '1', 3000, 0, 3000, day(2026, 6, 30), '', '']]);
  assert.strictEqual(due.checksDue, 3000);
  assert.strictEqual(Engine.evaluateNew(due, 1).checks.cheques.level, 'warn');
  const small = run([['CH1', 'A', '1', 500, 0, 500, day(2026, 6, 1), '', '']]);
  assert.strictEqual(Engine.evaluateNew(small, 1).checks.cheques.level, 'ok');
  const settled = run([['CH1', 'A', '1', 3000, 0, 3000, day(2026, 6, 1), 'خالص', 'تم الرفض']]);
  assert.strictEqual(settled.checksOpen, 0);
  assert.strictEqual(Engine.evaluateNew(settled, 1).checks.cheques.label, 'لا توجد شيكات مفتوحة');
});

test('checks: without the checks sheet the check says so and changes nothing', () => {
  const c = cust(Engine.analyze(checkBase, checkTx), 'A');
  assert.strictEqual(c.exposure, c.balance);
  const e = Engine.evaluateNew(c, 1);
  assert.strictEqual(e.checks.cheques.level, 'ok');
  assert.strictEqual(e.checks.cheques.label, 'بيانات الشيكات غير متاحة');
});

test('checks: totals and checks of unknown accounts are reported', () => {
  const r = Engine.analyze(checkBase, checkTx, null, null, {
    main: checkMain([
      ['CH1', 'A', '1', 1000, 0, 1000, day(2026, 6, 1), '', ''],
      ['CH2', 'A', '2', 400, 0, 400, day(2026, 8, 1), '', 'تم الرفض'],
      ['CH3', 'GHOST', '3', 900, 0, 900, '', '', ''],
    ]),
  });
  assert.strictEqual(r.summary.hasChecks, true);
  assert.strictEqual(r.summary.checksOpen, 1400);
  assert.strictEqual(r.summary.checksDue, 1000);
  assert.strictEqual(r.summary.checksRejectedCount, 1);
  assert.strictEqual(r.issues.checksUnmatched, 1);
});

test('FIFO settles the oldest invoice first and leaves the rest open', () => {
  const r = Engine.analyze(
    baseSheet([['A', 'عميل', '', 100000, 100000, 0, 'Net30', 'م']]),
    asOf(
      ['A', 'Sales order', day(2026, 6, 1), 1000, 'V1', 'I1', ''],
      ['A', 'Sales order', day(2026, 6, 10), 2000, 'V2', 'I2', ''],
      ['A', 'Payment', day(2026, 6, 15), -1500, 'V3', '', ''],
    ),
  );
  assert.strictEqual(inv(r, 'I1').verdict, 'paid');
  assert.strictEqual(inv(r, 'I1').settledDay, day(2026, 6, 15));
  assert.strictEqual(inv(r, 'I2').remaining, 1500);
  assert.strictEqual(inv(r, 'I2').paid, 500);
  assert.strictEqual(cust(r, 'A').balance, 1500);
});

test('payments stay credits even when the sheet stores the amount positive', () => {
  const run = (kind, voucher, amount) => Engine.analyze(
    baseSheet([['A', 'عميل', '', 100000, 100000, 0, 'Net30', 'م']]),
    asOf(
      ['A', 'Sales order', day(2026, 6, 1), 10000, 'V1', 'I1', ''],
      ['A', kind, day(2026, 6, 10), amount, voucher, '', ''],
    ),
  );
  // Cust and CHEC are payments in both signs; neither may become an invoice.
  for (const voucher of ['Cust', 'CHEC']) {
    for (const amount of [4000, -4000]) {
      const r = run('Payment', voucher, amount);
      const c = cust(r, 'A');
      assert.strictEqual(c.balance, 6000, `${voucher} ${amount}`);
      assert.strictEqual(c.invoices.length, 1, `${voucher} ${amount}`);
      assert.strictEqual(inv(r, 'I1').remaining, 6000, `${voucher} ${amount}`);
    }
  }
  // The voucher alone classifies the row when Transaction type is blank.
  const blank = run('', 'Cust', 4000);
  assert.strictEqual(cust(blank, 'A').balance, 6000);
  assert.strictEqual(cust(blank, 'A').invoices.length, 1);
  // A return and a negative sales row are credits, a positive one is a debt.
  const returned = run('Return', '', 2500);
  assert.strictEqual(cust(returned, 'A').balance, 7500);
  assert.strictEqual(cust(returned, 'A').invoices.length, 1);
  const creditNote = run('Sales order', '', -2500);
  assert.strictEqual(cust(creditNote, 'A').balance, 7500);
  assert.strictEqual(cust(creditNote, 'A').invoices.length, 1);
  const unknown = run('General journal', '', 2500);
  assert.strictEqual(cust(unknown, 'A').balance, 12500);
  assert.strictEqual(cust(unknown, 'A').invoices.length, 2);
});

test('an invoice inside its limit, guarantee and terms is clean', () => {
  const r = Engine.analyze(
    baseSheet([['A', 'عميل', '', 10000, 10000, 0, 'Net30', 'م']]),
    asOf(['A', 'Sales order', day(2026, 6, 20), 5000, 'V1', 'I1', '']),
  );
  const i = inv(r, 'I1');
  assert.strictEqual(i.verdict, 'ok');
  assert.strictEqual(i.dueDay, day(2026, 7, 20));
  assert.strictEqual(i.overdueDays, 0);
  assert.strictEqual(i.bucket, 0);
});

test('credit: only the part of the invoice above the limit counts, as a warning', () => {
  const r = Engine.analyze(
    baseSheet([['A', 'عميل', '', 6000, 100000, 0, 'Net60', 'م']]),
    asOf(
      ['A', 'Sales order', day(2026, 6, 1), 5000, 'V1', 'I1', ''],
      ['A', 'Sales order', day(2026, 6, 2), 4000, 'V2', 'I2', ''],
    ),
  );
  assert.strictEqual(inv(r, 'I1').checks.credit.level, 'ok');
  assert.strictEqual(inv(r, 'I2').checks.credit.level, 'warn');
  assert.strictEqual(inv(r, 'I2').checks.credit.amount, 3000);
  assert.strictEqual(inv(r, 'I2').verdict, 'warn');
});

test('guarantee covers the oldest debts first; overdue beyond it is critical', () => {
  const r = Engine.analyze(
    baseSheet([['A', 'عميل', '', 100000, 6000, 0, 'Net30', 'م']]),
    asOf(
      ['A', 'Sales order', day(2026, 3, 1), 5000, 'V1', 'I1', ''],
      ['A', 'Sales order', day(2026, 4, 1), 4000, 'V2', 'I2', ''],
      ['A', 'Sales order', day(2026, 6, 25), 3000, 'V3', 'I3', ''],
    ),
  );
  assert.strictEqual(inv(r, 'I1').covered, 5000);
  assert.strictEqual(inv(r, 'I2').covered, 1000);
  assert.strictEqual(inv(r, 'I2').uncovered, 3000);
  assert.strictEqual(inv(r, 'I2').checks.guarantee.level, 'stop');
  // Not due yet and uncovered: a warning, not a stop.
  assert.strictEqual(inv(r, 'I3').checks.guarantee.level, 'warn');
  assert.strictEqual(inv(r, 'I3').checks.arrears.level, 'ok');
});

test('arrears: warn up to stopDays, stop beyond, and tolerance ignores small sums', () => {
  const r = Engine.analyze(
    baseSheet([['A', 'عميل', '', 100000, 100000, 0, 'Net30', 'م']]),
    asOf(
      ['A', 'Sales order', day(2026, 1, 1), 5000, 'V1', 'OLD', ''],
      ['A', 'Sales order', day(2026, 5, 1), 5000, 'V2', 'NEW', ''],
    ),
  );
  assert.strictEqual(inv(r, 'OLD').overdueDays, 150);
  assert.strictEqual(inv(r, 'OLD').checks.arrears.level, 'stop');
  assert.strictEqual(inv(r, 'NEW').overdueDays, 30);
  assert.strictEqual(inv(r, 'NEW').checks.arrears.level, 'warn');

  const small = Engine.analyze(
    baseSheet([['A', 'عميل', '', 100000, 100000, 0, 'Net30', 'م']]),
    asOf(['A', 'Sales order', day(2026, 1, 1), 500, 'V1', 'S', '']),
  );
  assert.strictEqual(inv(small, 'S').overdueDays, 150);
  assert.strictEqual(inv(small, 'S').checks.arrears.level, 'ok');
});

test('arrears at issue: what the customer already owed late when invoiced', () => {
  const r = Engine.analyze(
    baseSheet([['A', 'عميل', '', 100000, 100000, 0, 'Net30', 'م']]),
    asOf(
      ['A', 'Sales order', day(2026, 1, 1), 5000, 'V1', 'I1', ''],
      ['A', 'Sales order', day(2026, 1, 15), 1000, 'V2', 'I2', ''],
      ['A', 'Sales order', day(2026, 3, 1), 2000, 'V3', 'I3', ''],
    ),
  );
  assert.strictEqual(inv(r, 'I2').arrearsAtIssue, 0);
  assert.strictEqual(inv(r, 'I3').arrearsAtIssue, 6000);
});

test('credit on account pays the next invoice', () => {
  const r = Engine.analyze(
    baseSheet([['A', 'عميل', '', 10000, 0, 0, 'Net30', 'م']]),
    asOf(
      ['A', 'Payment', day(2026, 6, 1), -3000, 'V1', '', ''],
      ['A', 'Sales order', day(2026, 6, 2), 2000, 'V2', 'I1', ''],
    ),
  );
  assert.strictEqual(inv(r, 'I1').verdict, 'paid');
  assert.strictEqual(cust(r, 'A').unapplied, 1000);
  assert.strictEqual(cust(r, 'A').balance, -1000);
});

test('opening balances are debts but not credit-limit breaches', () => {
  const r = Engine.analyze(
    baseSheet([['A', 'عميل', '', 1000, 100000, 0, 'Net30', 'م']]),
    asOf(['A', 'General journal', day(2026, 6, 25), 5000, 'V1', '', 'الرصيد الافتتاحى']),
  );
  const i = r.invoices.find((x) => x.account === 'A');
  assert.strictEqual(i.type, 'رصيد افتتاحي');
  assert.strictEqual(i.checks.credit.level, 'ok');
});

test('new invoice: passes, then needs approval, then stops', () => {
  const r = Engine.analyze(
    baseSheet([
      ['OK', 'سليم', '', 10000, 10000, 0, 'Net30', 'م'],
      ['LATE', 'متأخر', '', 100000, 100000, 0, 'Net30', 'م'],
      ['VERYLATE', 'متأخر جدا', '', 100000, 100000, 0, 'Net30', 'م'],
    ]),
    asOf(
      ['OK', 'Sales order', day(2026, 6, 20), 2000, 'V1', 'A1', ''],
      ['LATE', 'Sales order', day(2026, 5, 1), 5000, 'V2', 'A2', ''],
      ['VERYLATE', 'Sales order', day(2026, 1, 1), 5000, 'V3', 'A3', ''],
    ),
  );
  const ok = Engine.evaluateNew(cust(r, 'OK'), 3000);
  assert.strictEqual(ok.verdict, 'ok');
  assert.strictEqual(ok.balanceAfter, 5000);
  assert.strictEqual(ok.maxByCredit, 8000);
  assert.strictEqual(Engine.evaluateNew(cust(r, 'OK'), 9000).verdict, 'stop');
  assert.strictEqual(Engine.evaluateNew(cust(r, 'OK'), 9000, { overLimit: 'warn' }).verdict, 'warn');
  assert.strictEqual(Engine.evaluateNew(cust(r, 'LATE'), 100).verdict, 'warn');
  assert.strictEqual(Engine.evaluateNew(cust(r, 'VERYLATE'), 100).verdict, 'stop');
});

test('new invoice: a stopped customer or one with no limit cannot take credit', () => {
  const r = Engine.analyze(
    baseSheet([
      ['S', 'موقوف', 'Stoped Cus', 100000, 100000, 0, 'Net30', 'م'],
      ['N', 'بدون حد', '', 0, 100000, 0, 'Net30', 'م'],
    ]),
    asOf(),
  );
  assert.strictEqual(Engine.evaluateNew(cust(r, 'S'), 100).checks.credit.label, 'العميل موقوف');
  assert.strictEqual(Engine.evaluateNew(cust(r, 'S'), 100).verdict, 'stop');
  assert.strictEqual(Engine.evaluateNew(cust(r, 'N'), 100).checks.credit.label, 'لا يوجد حد ائتمان');
  assert.strictEqual(Engine.evaluateNew(cust(r, 'N'), 100).verdict, 'stop');
});

test('rules change the outcome', () => {
  const r = Engine.analyze(
    baseSheet([['A', 'عميل', '', 100000, 100000, 0, 'Net30', 'م']]),
    asOf(['A', 'Sales order', day(2026, 5, 1), 5000, 'V1', 'I1', '']),
    { stopDays: 10 },
  );
  assert.strictEqual(inv(r, 'I1').checks.arrears.level, 'stop');
});

test('data problems are counted, not silently absorbed', () => {
  const r = Engine.analyze(
    baseSheet([['A', 'عميل', '', 1000, '', 999, 'Net30', 'م']]),
    asOf(
      ['A', 'Sales order', 'نص', 100, 'V1', 'I1', ''],
      ['A', 'Sales order', day(2026, 6, 1), 0, 'V2', 'I2', ''],
      ['A', 'Sales order', day(2999, 1, 1), 100, 'V3', 'I3', ''],
      ['GHOST', 'Sales order', day(2026, 6, 1), 100, 'V4', 'I4', ''],
    ),
  );
  assert.strictEqual(r.issues.badDates, 1);
  assert.strictEqual(r.issues.zeroRows, 1);
  assert.strictEqual(r.issues.futureRows, 1);
  assert.strictEqual(r.issues.blankGuarantee, 1);
  assert.strictEqual(r.issues.notInBase, 2); // GHOST and the CLOCK row
  assert.strictEqual(r.issues.balanceDiffs, 1);
  assert.strictEqual(r.analysisDay, day(2026, 6, 30));
});

test('missing required columns are named in the error', () => {
  assert.throws(() => Engine.analyze([['Account', 'Name']], txSheet([])), /Credit limit/);
  assert.throws(() => Engine.analyze(baseSheet([]), [['Account']]), /Amount/);
});

test('summary totals tie to the customers', () => {
  const r = Engine.analyze(
    baseSheet([['A', 'عميل', '', 3000, 1000, 0, 'Net30', 'م']]),
    asOf(
      ['A', 'Sales order', day(2026, 1, 1), 5000, 'V1', 'I1', ''],
      ['A', 'Payment', day(2026, 2, 1), -1000, 'V2', '', ''],
    ),
  );
  assert.strictEqual(r.summary.openAmount, 4000);
  assert.strictEqual(r.summary.overdueAmount, 4000);
  assert.strictEqual(r.summary.uncoveredAmount, 3000);
  assert.strictEqual(r.summary.overLimitAmount, 1000);
  assert.strictEqual(r.summary.aging.reduce((a, b) => a + b, 0), 4000);
});

/* ---- payment plans (طرق السداد): where the due period comes from ---------- */
const planBase = (terms, method) => [
  ['Account', 'Name', 'Credit limit', 'Eligible credit limit', 'Payment schedule', 'طريقة السداد'],
  ['A', 'عميل', 100000, 100000, terms, method],
];
const oneInvoice = () => txSheet([['A', 'Sales order', day(2026, 6, 1), 1000, '', 'INV1', '']]);
const planRes = (plans, terms = 'Sch_4W', method = '') =>
  Engine.analyze(planBase(terms, method), oneInvoice(), null, day(2026, 6, 30), null, plans);
const contractOf = (r) => cust(r, 'A').contractDays;

test('plans: the due period is days between payments times the payment count', () => {
  const r = planRes([{ name: 'تقسيط 4', count: 4, days: 14 }], 'Sch_4W', 'تقسيط 4');
  assert.strictEqual(contractOf(r), 56);
  // The plan wins over the schedule code, which would have said 28 days.
  assert.strictEqual(inv(r, 'INV1').dueDay, day(2026, 6, 1) + 56);
  assert.strictEqual(r.issues.unknownTerms, 0);
});

test('plans: the plan name matches despite spaces, percent and hamza forms', () => {
  assert.strictEqual(contractOf(planRes([{ name: '25% Sch_8W', count: 8, days: 7 }], '', '25%Sch_8w')), 56);
  assert.strictEqual(contractOf(planRes([{ name: 'دفعة مقدمة', count: 2, days: 30 }], '', 'دفعه مقدمه')), 60);
  // A plan that is not there must not match by accident.
  assert.strictEqual(contractOf(planRes([{ name: '25% Sch_8W', count: 8, days: 7 }], 'Net30', 'دفعة مقدمة')), 30);
});

test('plans: total weeks or a single period still give a due date', () => {
  assert.strictEqual(contractOf(planRes([{ name: 'أسبوعي', weeks: 6 }], '', 'أسبوعي')), 42);
  assert.strictEqual(contractOf(planRes([{ name: 'نصف شهري', days: 21 }], '', 'نصف شهري')), 21);
  // Fixed_N is weeks, not months: the regression that made 12 weeks 12 months.
  assert.strictEqual(contractOf(planRes([], 'Fixed_12')), 84);
});

test('plans: an unknown schedule code falls back to the default, and is reported', () => {
  const r = planRes([], 'XYZ_99');
  assert.strictEqual(contractOf(r), 30);
  assert.strictEqual(r.issues.unknownTerms, 1);
  const custom = Engine.analyze(planBase('XYZ_99', ''), oneInvoice(), { defaultTermDays: 45 }, day(2026, 6, 30));
  assert.strictEqual(contractOf(custom), 45);
  // Stop is a decision and stays due on issue; a blank code is not "unknown".
  assert.strictEqual(planRes([], 'Stop').issues.unknownTerms, 0);
  assert.strictEqual(contractOf(planRes([], 'Stop')), 0);
  assert.strictEqual(planRes([], '').issues.unknownTerms, 0);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}\n     ${e.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);

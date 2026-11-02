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

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}\n     ${e.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);

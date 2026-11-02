/*
 * script.test.js - unit tests for apps-script/Code.gs.
 *
 * Run with:  node test/script.test.js     (no dependencies, exits 1 on failure)
 */
'use strict';

const assert = require('assert');
const { loadScript, SHEET } = require('./fake-apps-script.js');

const request = (over) => Object.assign({
  account: 'A1', customer: 'عميل', rep: 'م', amount: 5000, balance: 1000, balanceAfter: 6000, creditLimit: 3000,
  guarantee: 2000, uncovered: 4000, overdue: 0, oldestDays: 0, dataDate: '2026-11-02',
  verdict: 'stop', reasons: 'تجاوز الحد', requester: 'أحمد', note: '', ref: '',
}, over);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the placeholder keys refuse every request', () => {
  const s = loadScript({ request: 'غيّر-هذا-المفتاح', approve: 'غيّر-هذا-المفتاح' });
  const r = s.post({ action: 'list', key: 'غيّر-هذا-المفتاح' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /غيّر المفتاحين/);
});

test('a wrong key is refused and the two keys give their roles', () => {
  const s = loadScript();
  assert.strictEqual(s.post({ action: 'list', key: 'x' }).ok, false);
  assert.strictEqual(s.post({ action: 'list', key: 'req-key' }).role, 'requester');
  assert.strictEqual(s.post({ action: 'list', key: 'app-key' }).role, 'approver');
});

test('the sheet and its columns are created on first use', () => {
  const s = loadScript();
  s.post({ action: 'list', key: 'req-key' });
  const header = s.sheets.get(SHEET).grid[0];
  assert.ok(header.includes('رقم الطلب') && header.includes('موقف الاعتماد'));
});

test('existing columns keep their place and values land under the right header', () => {
  const s = loadScript();
  const sh = s.book.insertSheet(SHEET);
  sh.appendRow(['ملاحظة خاصة', 'قيمة الفاتورة']);
  s.post({ action: 'add', key: 'req-key', request: request() });
  assert.strictEqual(sh.grid[0][0], 'ملاحظة خاصة');
  assert.strictEqual(sh.grid[0][1], 'قيمة الفاتورة');
  assert.strictEqual(sh.grid[1][0], '');
  assert.strictEqual(sh.grid[1][1], 5000);
});

test('customer base fields are stored, and an older sheet gains the new columns at its end', () => {
  const s = loadScript();
  const sh = s.book.insertSheet(SHEET);
  sh.appendRow(['رقم الطلب', 'موقف الاعتماد']);
  sh.appendRow(['REQ000001', 'معتمد']);
  const r = s.post({ action: 'add', key: 'req-key', request: request({ idNumber: 'CH-7', warehouse: '65', group: 'Wsagent-H' }) });
  const header = sh.grid[0];
  assert.strictEqual(header[0], 'رقم الطلب');
  assert.strictEqual(sh.grid[2][header.indexOf('ID number')], 'CH-7');
  assert.strictEqual(sh.grid[2][header.indexOf('Warehouse Group')], '65');
  assert.strictEqual(sh.grid[2][header.indexOf('Customer group')], 'Wsagent-H');
  assert.strictEqual(r.request.id, 'REQ000002');
  assert.strictEqual(sh.grid[1][1], 'معتمد');
});

test('ids increase, and a clean check needs no approval', () => {
  const s = loadScript();
  const a = s.post({ action: 'add', key: 'req-key', request: request() });
  const b = s.post({ action: 'add', key: 'req-key', request: request({ verdict: 'ok' }) });
  assert.strictEqual(a.request.id, 'REQ000001');
  assert.strictEqual(a.request.status, 'قيد الاعتماد');
  assert.strictEqual(a.request.verdict, 'موقوفة');
  assert.strictEqual(b.request.id, 'REQ000002');
  assert.strictEqual(b.request.status, 'لا يحتاج اعتماد');
});

test('a client cannot set the status or approver of a new request', () => {
  const s = loadScript();
  const r = s.post({ action: 'add', key: 'req-key', request: request({ status: 'معتمد', approver: 'أنا' }) });
  assert.strictEqual(r.request.status, 'قيد الاعتماد');
  assert.strictEqual(r.request.approver, '');
});

test('a retried send does not create a second request', () => {
  const s = loadScript();
  const a = s.post({ action: 'add', key: 'req-key', request: request({ ref: 'R1' }) });
  const b = s.post({ action: 'add', key: 'req-key', request: request({ ref: 'R1' }) });
  assert.strictEqual(b.duplicate, true);
  assert.strictEqual(b.request.id, a.request.id);
  assert.strictEqual(s.post({ action: 'list', key: 'req-key' }).requests.length, 1);
});

test('bad requests are refused', () => {
  const s = loadScript();
  assert.strictEqual(s.post({ action: 'add', key: 'req-key', request: request({ amount: 0 }) }).ok, false);
  assert.strictEqual(s.post({ action: 'add', key: 'req-key', request: request({ account: '' }) }).ok, false);
  assert.strictEqual(s.post({ action: 'add', key: 'req-key', request: request({ verdict: 'x' }) }).ok, false);
  assert.strictEqual(s.post({ action: 'add', key: 'req-key', request: request({ requester: '' }) }).ok, false);
  assert.strictEqual(s.post({ action: 'list', key: 'req-key' }).requests.length, 0);
});

test('only the approver key decides, and once only', () => {
  const s = loadScript();
  s.post({ action: 'add', key: 'req-key', request: request() });
  const decide = (key, decision, note) => s.post({ action: 'decide', key, id: 'REQ000001', decision, approver: 'المدير', note });
  assert.match(decide('req-key', 'approve').error, /مفتاح الاعتماد/);
  const done = decide('app-key', 'approve', 'استثناء');
  assert.strictEqual(done.request.status, 'معتمد');
  assert.strictEqual(done.request.approver, 'المدير');
  assert.strictEqual(done.request.decisionNote, 'استثناء');
  assert.ok(done.request.decidedAt);
  assert.match(decide('app-key', 'reject', 'لا').error, /لم يعد قيد الاعتماد/);
});

test('a rejection needs a reason and an unknown id is reported', () => {
  const s = loadScript();
  s.post({ action: 'add', key: 'req-key', request: request() });
  assert.match(s.post({ action: 'decide', key: 'app-key', id: 'REQ000001', decision: 'reject', approver: 'م', note: '' }).error, /سبب الرفض/);
  assert.match(s.post({ action: 'decide', key: 'app-key', id: 'REQ9', decision: 'approve', approver: 'م' }).error, /غير موجود/);
});

test('text that looks like a formula is stored as plain text', () => {
  const s = loadScript();
  const r = s.post({ action: 'add', key: 'req-key', request: request({ note: '=IMPORTXML("x")' }) });
  assert.strictEqual(r.request.note, '\'=IMPORTXML("x")');
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}\n     ${e.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);

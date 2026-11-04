/*
 * script.test.js - unit tests for apps-script/Code.gs.
 *
 * Run with:  node test/script.test.js     (no dependencies, exits 1 on failure)
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadScript, REQUESTS, USERS, LOG } = require('./fake-apps-script.js');
const Engine = require('../engine.js');

const day = (y, m, d) => Engine.dayOf(y, m, d);
const PASS = 'admin-test-pass';

// Two warehouses; A1 is over its limit with late debts, B1 is clean.
const source = () => ({
  base: [
    ['Account', 'Name', 'Credit limit', 'Eligible credit limit', 'Balance', 'Payment schedule', 'Worker Name', 'Warehouse Group', 'Customer group', 'ID number', 'سري'],
    ['A1', 'عميل أ', 6000, 2000, 5000, 'Net30', 'مندوب', '65', 'Wsagent-H', 'ID-A', 'قيمة لا تخرج'],
    ['B1', 'عميل ب', 100000, 100000, 1000, 'Net30', 'مندوب', '70', 'Wsagent-E', 'ID-B', 'قيمة لا تخرج'],
  ],
  tx: [
    ['Account', 'Transaction type', 'Date', 'Amount', 'voucher', 'Invoice', 'Description'],
    ['A1', 'Sales order', new Date(Date.UTC(2026, 0, 1)), 5000, 'V1', 'I1', ''],
    ['B1', 'Sales order', new Date(Date.UTC(2026, 5, 20)), 1000, 'V2', 'I2', ''],
    ['B1', 'Payment', new Date(Date.UTC(2026, 5, 30)), -1, 'V3', '', ''],
  ],
});

function setup(extra = {}) {
  const s = loadScript(Object.assign({ source: source() }, extra));
  s.admin = s.post({ action: 'login', username: 'admin', password: PASS }).token;
  s.call = (token, action, extra) => s.post(Object.assign({ action, token }, extra));
  s.addUser = (username, role, warehouses = []) => {
    const r = s.call(s.admin, 'userSave', { username, name: `اسم ${username}`, role, warehouses, password: 'password-1' });
    assert.ok(r.ok, r.error);
    return s.post({ action: 'login', username, password: 'password-1' }).token;
  };
  return s;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('Engine.gs is an exact copy of engine.js', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r/g, '');
  assert.strictEqual(read('apps-script/Engine.gs'), read('engine.js'));
});

test('the placeholder admin password refuses every request', () => {
  const s = loadScript({ password: 'غيّر-هذه-الكلمة' });
  const r = s.post({ action: 'login', username: 'admin', password: 'غيّر-هذه-الكلمة' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /ADMIN_PASSWORD/);
});

test('every action but login needs a session', () => {
  const s = setup();
  for (const action of ['data', 'ping', 'list', 'promises', 'add', 'users', 'audit', 'decide', 'deliver']) {
    const r = s.post({ action, token: 'made-up' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.login, true);
  }
  assert.strictEqual(s.post({ action: 'data' }).login, true);
});

test('wrong passwords lock the account and the right one is then refused', () => {
  const s = setup();
  s.addUser('sara', 'موظف');
  for (let i = 0; i < 5; i++) assert.strictEqual(s.post({ action: 'login', username: 'sara', password: 'wrong' }).ok, false);
  const r = s.post({ action: 'login', username: 'sara', password: 'password-1' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /مقفول/);
});

test('passwords are stored hashed and never sent back', () => {
  const s = setup();
  s.addUser('sara', 'موظف');
  const sheet = JSON.stringify(s.book.getSheetByName(USERS).grid);
  assert.ok(!sheet.includes('password-1'));
  const listed = JSON.stringify(s.call(s.admin, 'users'));
  assert.ok(!listed.includes('hash') && !listed.includes('salt') && !listed.includes('password-1'));
});

test('only the admin manages users and rules', () => {
  const s = setup();
  const t = s.addUser('amr', 'معتمد');
  assert.match(s.call(t, 'users').error, /إدارة النظام/);
  assert.match(s.call(t, 'userSave', { username: 'x12', role: 'مدير', password: 'password-1' }).error, /إدارة النظام/);
  assert.match(s.call(t, 'setRules', { overLimit: 'warn', stopDays: 1, tolerance: 1 }).error, /إدارة النظام/);
});

test('a user cannot lock themselves out', () => {
  const s = setup();
  const t = s.addUser('boss', 'مدير');
  assert.match(s.call(t, 'userSave', { username: 'boss', role: 'موظف' }).error, /من نفسك/);
  assert.match(s.call(t, 'userSave', { username: 'boss', role: 'مدير', active: false }).error, /من نفسك/);
});

test('permissions: a user can hold any mix of features', () => {
  const s = setup();
  const save = (username, permissions) => {
    const r = s.call(s.admin, 'userSave', {
      username, name: username, permissions, warehouses: [], password: 'password-1',
    });
    assert.ok(r.ok, r.error);
    return s.post({ action: 'login', username, password: 'password-1' }).token;
  };
  const approver = save('apr', ['اعتماد الطلبات']);
  const hybrid = save('hyb', ['تسجيل الطلبات', 'متابعة التسليم']);
  const viewer = save('view', []);
  const boss = save('boss', ['إدارة النظام']);

  const id = s.call(hybrid, 'add', { account: 'A1', amount: 3000 }).request.id;
  assert.match(s.call(approver, 'add', { account: 'B1', amount: 1 }).error, /تسجيل الطلبات/);
  assert.match(s.call(viewer, 'add', { account: 'B1', amount: 1 }).error, /تسجيل الطلبات/);
  assert.ok(s.call(viewer, 'list').ok);

  assert.ok(s.call(approver, 'decide', { id, decision: 'approve' }).ok);
  assert.match(s.call(hybrid, 'decide', { id, decision: 'approve' }).error, /صلاحية اعتماد/);
  assert.ok(s.call(hybrid, 'deliver', { id, status: 'جاري التسليم', due: '2026-11-05' }).ok);
  assert.match(s.call(approver, 'deliver', { id, status: 'تم التسليم' }).error, /متابعة التسليم/);

  // «إدارة النظام» carries every other permission.
  assert.ok(s.call(boss, 'users').ok);
  assert.ok(s.call(boss, 'add', { account: 'B1', amount: 1 }).ok);

  const listed = s.call(s.admin, 'users').users.find((u) => u.username === 'hyb');
  assert.deepStrictEqual(listed.permissions, ['تسجيل الطلبات', 'متابعة التسليم']);
  assert.strictEqual(listed.role, 'مخصص');
});

test('stopping a user ends their session at once', () => {
  const s = setup();
  const t = s.addUser('sara', 'موظف');
  assert.ok(s.call(t, 'list').ok);
  s.call(s.admin, 'userSave', { username: 'sara', role: 'موظف', active: false });
  const r = s.call(t, 'list');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.login, true);
  assert.match(s.post({ action: 'login', username: 'sara', password: 'password-1' }).error, /متوقف/);
});

test('changing a password needs the old one and ends older sessions', () => {
  const s = setup();
  const t = s.addUser('sara', 'موظف');
  assert.match(s.call(t, 'changePassword', { oldPassword: 'wrong', newPassword: 'password-2' }).error, /الحالية/);
  assert.match(s.call(t, 'changePassword', { oldPassword: 'password-1', newPassword: 'short' }).error, /8/);
  assert.ok(s.call(t, 'changePassword', { oldPassword: 'password-1', newPassword: 'password-2' }).ok);
  assert.strictEqual(s.call(t, 'list').login, true);
  assert.strictEqual(s.post({ action: 'login', username: 'sara', password: 'password-1' }).ok, false);
  assert.ok(s.post({ action: 'login', username: 'sara', password: 'password-2' }).ok);
});

test('data: only the engine columns leave the sheet, dates as epoch days', () => {
  const s = setup();
  const r = s.call(s.admin, 'data');
  assert.ok(r.ok, r.error);
  assert.ok(!JSON.stringify(r).includes('قيمة لا تخرج'));
  assert.ok(!r.base[0].includes('سري'));
  const dateAt = r.tx[0].indexOf('Date');
  assert.strictEqual(r.tx[1][dateAt], day(2026, 1, 1));
  assert.strictEqual(r.analysisDay, day(2026, 6, 30));
  assert.strictEqual(r.stats.customers, 2);
});

test('data: a warehouse user receives only their customers, with the same analysis date', () => {
  const s = setup();
  const t = s.addUser('sara', 'موظف', ['65']);
  const r = s.call(t, 'data');
  assert.strictEqual(r.base.length, 2);
  assert.ok(JSON.stringify(r.base).includes('A1'));
  assert.ok(!JSON.stringify(r).includes('B1'));
  assert.strictEqual(r.analysisDay, day(2026, 6, 30));
  const a = Engine.analyze(r.base, r.tx, r.rules, r.analysisDay).customers[0];
  assert.strictEqual(a.overdue, 5000);
  assert.strictEqual(r.user.name, 'اسم sara');
});

test('add: the server computes the check and ignores what the browser claims', () => {
  const s = setup();
  const t = s.addUser('sara', 'موظف');
  const r = s.call(t, 'add', {
    account: 'A1', amount: 3000, note: 'ملاحظة', ref: 'R1',
    verdict: 'ok', status: 'معتمد', balance: 0, creditLimit: 999999, requester: 'شخص آخر',
    request: { verdict: 'ok', status: 'معتمد' },
  });
  assert.ok(r.ok, r.error);
  const q = r.request;
  assert.strictEqual(q.verdict, 'موقوفة');
  assert.strictEqual(q.status, 'قيد الاعتماد');
  assert.strictEqual(q.balance, 5000);
  assert.strictEqual(q.balanceAfter, 8000);
  assert.strictEqual(q.creditLimit, 6000);
  assert.strictEqual(q.requester, 'اسم sara');
  assert.strictEqual(q.requesterUser, 'sara');
  assert.strictEqual(q.idNumber, 'ID-A');
  assert.strictEqual(q.warehouse, '65');
  assert.strictEqual(q.group, 'Wsagent-H');
  assert.strictEqual(q.dataDate, '2026-06-30');
  assert.match(q.reasons, /تجاوز الحد/);
});

test('add: a clean check needs no approval, ids increase, a retry is not a second request', () => {
  const s = setup();
  const a = s.call(s.admin, 'add', { account: 'B1', amount: 100, ref: 'R1' });
  assert.strictEqual(a.request.id, 'REQ000001');
  assert.strictEqual(a.request.status, 'لا يحتاج اعتماد');
  assert.strictEqual(s.call(s.admin, 'add', { account: 'B1', amount: 100, ref: 'R1' }).duplicate, true);
  assert.strictEqual(s.call(s.admin, 'add', { account: 'B1', amount: 100, ref: 'R2' }).request.id, 'REQ000002');
  assert.strictEqual(s.call(s.admin, 'list').requests.length, 2);
});

test('add: a retry with another user\'s ref is not a duplicate', () => {
  const s = setup();
  const sara = s.addUser('sara', 'موظف', ['65']);
  const omar = s.addUser('omar', 'موظف', ['70']);
  const first = s.call(sara, 'add', { account: 'A1', amount: 100, ref: 'R-SHARED' });
  assert.ok(first.ok, first.error);
  const second = s.call(omar, 'add', { account: 'B1', amount: 100, ref: 'R-SHARED' });
  assert.ok(second.ok, second.error);
  assert.strictEqual(second.duplicate, undefined);
  assert.notStrictEqual(second.request.id, first.request.id);
  // The same requester still gets the original request back.
  const retry = s.call(sara, 'add', { account: 'A1', amount: 100, ref: 'R-SHARED' });
  assert.strictEqual(retry.duplicate, true);
  assert.strictEqual(retry.request.id, first.request.id);
});

test('recheck: carries the snapshot time for the decision', () => {
  const s = setup();
  const sara = s.addUser('sara', 'موظف', ['65']);
  const amr = s.addUser('amr', 'معتمد', ['65']);
  const id = s.call(sara, 'add', { account: 'A1', amount: 100, ref: 'R-TIME' }).request.id;
  const r = s.call(amr, 'recheck', { id });
  assert.ok(r.ok, r.error);
  assert.ok(r.check.dataAt > 0);
});

test('add: outside the warehouse scope or an unknown customer is refused', () => {
  const s = setup();
  const t = s.addUser('sara', 'موظف', ['65']);
  assert.match(s.call(t, 'add', { account: 'B1', amount: 100 }).error, /خارج نطاق/);
  assert.match(s.call(t, 'add', { account: 'NOPE', amount: 100 }).error, /خارج نطاق/);
  assert.match(s.call(t, 'add', { account: 'A1', amount: 0 }).error, /أكبر من صفر/);
});

test('rules saved by the admin decide the server check', () => {
  const s = setup();
  assert.ok(s.call(s.admin, 'setRules', { overLimit: 'warn', stopDays: 1000, tolerance: 1000000 }).ok);
  assert.strictEqual(s.call(s.admin, 'add', { account: 'A1', amount: 3000 }).request.verdict, 'تحتاج موافقة');
  assert.strictEqual(s.call(s.admin, 'data').rules.stopDays, 1000);
  assert.strictEqual(s.call(s.admin, 'setRules', { overLimit: 'x', stopDays: 1, tolerance: 1 }).ok, false);
});

test('ping: a fast session check that carries the current rules', () => {
  const s = setup();
  const t = s.addUser('nour', 'معتمد', ['70']);
  const r = s.call(t, 'ping');
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.user.role, 'معتمد');
  assert.deepStrictEqual(r.rules, s.call(s.admin, 'data').rules);
  assert.ok(r.build);
  assert.strictEqual(typeof r.dataAt, 'number');
  assert.strictEqual(r.base, undefined);
  assert.strictEqual(r.tx, undefined);
});

test('decide: role, own requests, scope, single decision and a current check', () => {
  const s = setup();
  const clerk = s.addUser('sara', 'موظف');
  const approver = s.addUser('amr', 'معتمد');
  const outsider = s.addUser('nour', 'معتمد', ['70']);
  const id = s.call(clerk, 'add', { account: 'A1', amount: 3000 }).request.id;
  const own = s.call(approver, 'add', { account: 'A1', amount: 100 }).request.id;
  const decide = (t, reqId, decision, note) => s.call(t, 'decide', { id: reqId, decision, note });

  assert.match(decide(clerk, id, 'approve').error, /صلاحية اعتماد/);
  assert.match(decide(approver, own, 'approve').error, /قدّمته بنفسك/);
  assert.match(decide(outsider, id, 'approve').error, /خارج نطاق/);
  assert.match(decide(approver, id, 'reject', '').error, /سبب الرفض/);
  assert.match(decide(approver, 'REQ9', 'approve').error, /غير موجود/);

  const before = s.call(approver, 'recheck', { id });
  assert.strictEqual(before.check.verdict, 'stop');
  const done = decide(approver, id, 'approve', 'استثناء');
  assert.strictEqual(done.request.status, 'معتمد');
  assert.strictEqual(done.request.approver, 'اسم amr');
  assert.match(done.request.verdictAtDecision, /موقوفة/);
  assert.match(decide(approver, id, 'reject', 'لا').error, /لم يعد قيد الاعتماد/);
  // The admin alone may decide their own request.
  const adminOwn = s.call(s.admin, 'add', { account: 'A1', amount: 1 }).request.id;
  assert.strictEqual(decide(s.admin, adminOwn, 'approve').request.status, 'معتمد');
});

test('decide: a decision is not written when the audit log cannot be written', () => {
  const s = setup();
  const id = s.call(s.admin, 'add', { account: 'A1', amount: 100, ref: 'R-AUDIT' }).request.id;
  const log = s.book.getSheetByName(LOG);
  assert.ok(log, 'the log sheet exists');
  const append = log.appendRow;
  log.appendRow = () => { throw new Error('audit down'); };
  const blocked = s.call(s.admin, 'decide', { id, decision: 'approve' });
  assert.strictEqual(blocked.ok, false);
  assert.match(blocked.error, /سجل العمليات/);
  log.appendRow = append;
  const saved = s.call(s.admin, 'list').requests.find((x) => x.id === id);
  assert.strictEqual(saved.status, 'قيد الاعتماد');
  assert.ok(s.call(s.admin, 'decide', { id, decision: 'approve' }).ok);
});

test('deliver: only a delivery role, only approved, with dates and a reason', () => {
  const s = setup();
  const clerk = s.addUser('sara', 'موظف');
  const delivery = s.addUser('mona', 'محاسب مخزن');
  const outsider = s.addUser('nour', 'محاسب مخزن', ['70']);
  const approver = s.addUser('amr', 'معتمد');
  const id = s.call(clerk, 'add', { account: 'A1', amount: 3000 }).request.id;
  const deliver = (t, extra) => s.call(t, 'deliver', Object.assign({ id }, extra));

  assert.match(deliver(delivery, { status: 'في أرضية المخزن' }).error, /لم يُعتمد/);
  assert.match(deliver(clerk, { status: 'في أرضية المخزن' }).error, /متابعة التسليم/);
  assert.ok(s.call(approver, 'decide', { id, decision: 'approve' }).ok);

  assert.match(deliver(outsider, { status: 'في أرضية المخزن' }).error, /خارج نطاق/);
  assert.match(deliver(delivery, { status: 'حالة خاطئة' }).error, /غير معروفة/);
  assert.match(deliver(delivery, { status: 'متعذر التسليم' }).error, /سبب تعذر/);
  assert.match(deliver(delivery, { status: 'جاري التسليم', due: '01/02/2026' }).error, /YYYY-MM-DD/);
  assert.match(deliver(delivery, { status: 'جاري التسليم', due: '2026-13-01' }).error, /تاريخ غير صالح/);

  const moved = deliver(delivery, { status: 'جاري التسليم', due: '2026-11-05', reason: 'عدم توافر عربيات النقل' });
  assert.strictEqual(moved.request.deliveryStatus, 'جاري التسليم');
  assert.strictEqual(moved.request.deliveryDue, '2026-11-05');
  assert.strictEqual(moved.request.deliveryAt, '');
  assert.strictEqual(moved.request.deliveryBy, 'اسم mona');
  assert.strictEqual(moved.request.status, 'معتمد');

  const done = deliver(delivery, { status: 'تم التسليم', due: '2026-11-05', at: '2026-11-07', reason: 'عدم توافر عربيات النقل' });
  assert.strictEqual(done.request.deliveryStatus, 'تم التسليم');
  assert.strictEqual(done.request.deliveryAt, '2026-11-07');
  assert.strictEqual(done.request.deliveryReason, 'عدم توافر عربيات النقل');

  const cleared = deliver(delivery, { status: '' });
  assert.strictEqual(cleared.request.deliveryStatus, '');
  assert.strictEqual(cleared.request.deliveryDue, '');
  assert.strictEqual(cleared.request.deliveryAt, '');
});

test('deliver: a delivery update is not written when the audit log cannot be written', () => {
  const s = setup();
  const id = s.call(s.admin, 'add', { account: 'B1', amount: 100, ref: 'R-DAUDIT' }).request.id;
  const log = s.book.getSheetByName(LOG);
  const append = log.appendRow;
  log.appendRow = () => { throw new Error('audit down'); };
  const blocked = s.call(s.admin, 'deliver', { id, status: 'جاري التسليم' });
  assert.strictEqual(blocked.ok, false);
  assert.match(blocked.error, /سجل العمليات/);
  log.appendRow = append;
  const saved = s.call(s.admin, 'list').requests.find((x) => x.id === id);
  assert.strictEqual(saved.deliveryStatus, 'في أرضية المخزن');
  assert.ok(s.call(s.admin, 'deliver', { id, status: 'جاري التسليم' }).ok);
});

test('delivery starts in the warehouse for a clean request and after approval', () => {
  const s = setup();
  const clean = s.call(s.admin, 'add', { account: 'B1', amount: 100 }).request;
  assert.strictEqual(clean.status, 'لا يحتاج اعتماد');
  assert.strictEqual(clean.deliveryStatus, 'في أرضية المخزن');

  const id = s.call(s.admin, 'add', { account: 'A1', amount: 3000 }).request.id;
  assert.strictEqual(s.call(s.admin, 'list').requests.find((r) => r.id === id).deliveryStatus, '');
  s.call(s.admin, 'decide', { id, decision: 'approve' });
  assert.strictEqual(s.call(s.admin, 'list').requests.find((r) => r.id === id).deliveryStatus, 'في أرضية المخزن');
});

test('deliver: records the actual invoice value beside the agreed one', () => {
  const s = setup();
  const clerk = s.addUser('sara', 'موظف');
  const delivery = s.addUser('mona', 'محاسب مخزن');
  const id = s.call(clerk, 'add', { account: 'A1', amount: 3000 }).request.id;
  s.call(s.admin, 'decide', { id, decision: 'approve' });
  const deliver = (extra) => s.call(delivery, 'deliver',
    Object.assign({ id, status: 'تم التسليم', at: '2026-11-07' }, extra));
  const get = () => s.call(s.admin, 'list').requests.find((r) => r.id === id);

  assert.match(deliver({ actual: 'abc' }).error, /رقم/);
  assert.match(deliver({ actual: '-1' }).error, /سالبة/);
  assert.match(deliver({ actual: '2500' }).error, /سبب اختلاف/);

  const same = deliver({ actual: '3000' });
  assert.strictEqual(same.request.actualAmount, 3000);
  assert.strictEqual(same.request.actualNote, '');
  assert.strictEqual(same.request.actualBy, 'اسم mona');
  assert.ok(same.request.actualAt);

  // A difference under one pound needs no reason; a real one does.
  const cents = deliver({ actual: '3000.50' });
  assert.strictEqual(cents.request.actualAmount, 3000.5);

  const lower = deliver({ actual: '2,500', actualNote: 'خصم كمية' });
  assert.strictEqual(lower.request.actualAmount, 2500);
  assert.strictEqual(lower.request.actualNote, 'خصم كمية');
  assert.strictEqual(get().actualAmount, 2500);

  // An empty figure clears the value and its stamps.
  const cleared = deliver({ actual: '' });
  assert.strictEqual(cleared.request.actualAmount, '');
  assert.strictEqual(cleared.request.actualNote, '');
  assert.strictEqual(cleared.request.actualBy, '');
  assert.strictEqual(cleared.request.actualAt, '');

  assert.ok(JSON.stringify(s.book.getSheetByName(LOG).grid).includes('الفعلي'));
});

test('list: a warehouse user sees only requests of their warehouses', () => {
  const s = setup();
  s.call(s.admin, 'add', { account: 'A1', amount: 1 });
  s.call(s.admin, 'add', { account: 'B1', amount: 1 });
  const t = s.addUser('sara', 'موظف', ['70']);
  const list = s.call(t, 'list').requests;
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].account, 'B1');
});

test('an older requests sheet keeps its rows and gains the new columns at the end', () => {
  const s = setup();
  const sh = s.book.insertSheet(REQUESTS);
  sh.appendRow(['رقم الطلب', 'موقف الاعتماد', 'عمود خاص']);
  sh.appendRow(['REQ000007', 'معتمد', 'قيمة']);
  const r = s.call(s.admin, 'add', { account: 'A1', amount: 1 });
  assert.strictEqual(r.request.id, 'REQ000008');
  assert.strictEqual(sh.grid[1][2], 'قيمة');
  assert.strictEqual(sh.grid[2][sh.grid[0].indexOf('كود العميل')], 'A1');
});

test('text that looks like a formula is stored as plain text', () => {
  const s = setup();
  const r = s.call(s.admin, 'add', { account: 'A1', amount: 1, note: '=IMPORTXML("x")' });
  assert.strictEqual(r.request.note, '\'=IMPORTXML("x")');
});

test('decisions and user changes reach the log, without passwords', () => {
  const s = setup();
  s.addUser('sara', 'موظف');
  const id = s.call(s.admin, 'add', { account: 'A1', amount: 1 }).request.id;
  s.call(s.admin, 'decide', { id, decision: 'approve' });
  const log = JSON.stringify(s.book.getSheetByName(LOG).grid);
  assert.ok(log.includes('إضافة مستخدم') && log.includes('معتمد') && log.includes(id));
  assert.ok(!log.includes('password-1'));
});

test('audit: the admin reads the log newest first, with optional filters', () => {
  const s = setup();
  const t = s.addUser('amr', 'معتمد');
  const id = s.call(s.admin, 'add', { account: 'A1', amount: 3000 }).request.id;
  s.call(s.admin, 'decide', { id, decision: 'approve' });

  const all = s.call(s.admin, 'audit');
  assert.ok(all.ok, all.error);
  assert.strictEqual(all.audit.total, all.audit.entries.length);
  const at = all.audit.entries.map((e) => e.at);
  assert.deepStrictEqual(at, at.slice().sort().reverse());
  assert.ok(all.audit.entries.some((e) => e.action === 'تسجيل طلب' && e.detail.includes(id)));
  assert.ok(all.audit.entries.some((e) => e.action === 'معتمد' && e.detail.includes(id)));
  assert.ok(all.audit.actions.includes('دخول') && all.audit.actions.includes('معتمد'));
  assert.ok(!JSON.stringify(all.audit).includes('password-1'));

  const approved = s.call(s.admin, 'audit', { op: 'معتمد' });
  assert.ok(approved.audit.entries.length >= 1);
  assert.ok(approved.audit.entries.every((e) => e.action === 'معتمد'));

  const byAdmin = s.call(s.admin, 'audit', { user: 'المدير' });
  assert.ok(byAdmin.audit.entries.length >= 1);
  assert.ok(byAdmin.audit.entries.every((e) => e.user.includes('المدير')));

  // The menu always lists every operation, even when a filter is active.
  assert.ok(byAdmin.audit.actions.includes('دخول'));

  assert.strictEqual(s.call(s.admin, 'audit', { from: '2999-01-01' }).audit.total, 0);
  assert.strictEqual(s.call(s.admin, 'audit', { to: '2000-01-01' }).audit.total, 0);

  const one = s.call(s.admin, 'audit', { limit: 1 });
  assert.strictEqual(one.audit.entries.length, 1);
  assert.ok(one.audit.total >= 3);

  assert.match(s.call(t, 'audit').error, /إدارة النظام/);
});

test('source tabs are found despite spaces and spelling, or the real names are listed', () => {
  const rename = (s, from, to) => {
    s.sourceBook.sheets.set(to, s.sourceBook.sheets.get(from));
    s.sourceBook.sheets.delete(from);
  };
  const dataOf = (s) => s.post({ action: 'data', token: s.admin });

  const spaced = setup();
  rename(spaced, 'قاعده عملاء الشركه', ' قاعدة  عملاء الشركة ');
  assert.ok(dataOf(spaced).ok, dataOf(spaced).error);

  const hinted = setup();
  rename(hinted, 'قاعده عملاء الشركه', 'قاعدة العملاء 2026');
  rename(hinted, 'حركات العملاء', 'حركات 2026');
  assert.strictEqual(dataOf(hinted).stats.customers, 2);

  const wrong = setup();
  rename(wrong, 'قاعده عملاء الشركه', 'Customers');
  const r = dataOf(wrong);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /"Customers"/);
  assert.match(r.error, /"حركات العملاء"/);

  const twoLike = setup();
  rename(twoLike, 'قاعده عملاء الشركه', 'قاعدة 1');
  twoLike.sourceBook.insertSheet('قاعدة 2');
  assert.match(dataOf(twoLike).error, /التبويبات الموجودة/);
});

// The main checks tab has a totals row above its header, as in the real sheet.
const checksSheet = () => ({
  main: [
    ['', 'الإجمالي', '', 2500],
    ['NN', 'كود العميل', 'رقم الشيك', 'قيمة الشيك', 'صافى الشيك', 'تاريخ الاستحقاق', 'الحاله', 'حالة الصرف', 'ملاحظة سرية'],
    ['CH1', 'A1', '11', 2000, 2000, new Date(Date.UTC(2026, 7, 1)), 'تحت التحصيل', '', 'لا تخرج'],
    ['CH2', 'B1', '22', 500, 500, new Date(Date.UTC(2026, 7, 1)), '', 'تم الرفض', 'لا تخرج'],
    ['', '', '', 2500, 2500, '', '', '', ''],
  ],
  wh: [
    ['WH', 'كود العميل', 'رقم الشيك', 'قيمة الشيك', 'التحصيل', 'الصافي', 'تاريخ الاستحقاق', 'mm'],
    ['WH1', 'B1', '33', 300, 0, 300, '', 'NN'],
  ],
});
const withChecks = () => setup({ checksId: 'CHECKS', checks: checksSheet() });

test('checks: data carries both tabs, header found under the totals row, extra columns dropped', () => {
  const s = withChecks();
  const r = s.call(s.admin, 'data');
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.checksError, '');
  assert.ok(!JSON.stringify(r).includes('لا تخرج'));
  assert.ok(!r.checks.main[0].includes('ملاحظة سرية'));
  assert.strictEqual(r.checks.main[1][r.checks.main[0].indexOf('تاريخ الاستحقاق')], day(2026, 8, 1));
  assert.strictEqual(r.stats.checks, 3);  // two main checks and one warehouse check; the totals row is not a check
  const a = Engine.analyze(r.base, r.tx, r.rules, r.analysisDay, r.checks).customers.find((c) => c.account === 'A1');
  assert.strictEqual(a.checksOpen, 2000);
  assert.strictEqual(a.exposure, 7000);
});

test('checks: a warehouse user receives only the checks of their customers', () => {
  const s = withChecks();
  const t = s.addUser('sara', 'موظف', ['65']);
  const r = s.call(t, 'data');
  assert.strictEqual(r.checks.main.length, 2);
  assert.strictEqual(r.checks.main[1][r.checks.main[0].indexOf('كود العميل')], 'A1');
  assert.strictEqual(r.checks.wh.length, 1);
  assert.ok(!JSON.stringify(r.checks).includes('B1'));
});

test('checks: a request is checked with them and records their figures', () => {
  const s = withChecks();
  const b = s.call(s.admin, 'add', { account: 'B1', amount: 100 }).request;
  assert.strictEqual(b.verdict, 'موقوفة');
  assert.match(b.reasons, /شيكات مرفوضة/);
  assert.strictEqual(b.checksRejected, 500);
  assert.strictEqual(b.checksOpen, 800);
  const a = s.call(s.admin, 'add', { account: 'A1', amount: 3000 }).request;
  assert.strictEqual(a.checksOpen, 2000);
  assert.strictEqual(a.exposureAfter, 10000);
  assert.strictEqual(a.balanceAfter, 8000);
  const header = s.book.getSheetByName(REQUESTS).grid[0];
  assert.ok(header.includes('شيكات مرفوضة') && header.includes('التعرض بعد الفاتورة (شامل الشيكات)'));
});

test('checks: if they cannot be read, the screens say why and requests are refused', () => {
  const s = setup({ checksId: 'CHECKS' });  // set, but not shared with the script
  const r = s.call(s.admin, 'data');
  assert.ok(r.ok);
  assert.strictEqual(r.checks, null);
  assert.match(r.checksError, /شيت الشيكات/);
  assert.match(s.call(s.admin, 'add', { account: 'A1', amount: 1 }).error, /شيت الشيكات/);

  const renamed = withChecks();
  renamed.checksBook.sheets.set('شيكات', renamed.checksBook.sheets.get('الشيكات (2)'));
  renamed.checksBook.sheets.delete('الشيكات (2)');
  assert.match(renamed.call(renamed.admin, 'data').checksError, /CHECKS_TAB/);
});

test('checks: without CHECKS_SHEET_ID nothing changes', () => {
  const s = setup();
  const r = s.call(s.admin, 'data');
  assert.strictEqual(r.checks, null);
  assert.strictEqual(r.checksError, '');
  assert.strictEqual(s.call(s.admin, 'add', { account: 'B1', amount: 100 }).request.verdict, 'سليمة');
});

/* ---- the data snapshot ---- */

const snapMeta = (s) => JSON.parse(s.props.get('snapshot'));
const sourceReads = (s) => s.reads.source;  // each build reads the two customer tabs

test('snapshot: the sheets are read once, then every action uses the saved copy', () => {
  const s = setup();
  const clerk = s.addUser('sara', 'موظف');
  assert.ok(s.call(clerk, 'data').ok);
  assert.strictEqual(sourceReads(s), 2);
  const id = s.call(clerk, 'add', { account: 'A1', amount: 3000 }).request.id;
  s.call(s.admin, 'recheck', { id });
  s.call(s.admin, 'decide', { id, decision: 'approve' });
  s.call(s.admin, 'data');
  assert.strictEqual(sourceReads(s), 2);
  assert.strictEqual(s.drive.files.size, 1);
  assert.deepStrictEqual(s.triggers, [{ handler: 'refreshSnapshot', minutes: 15 }]);
});

test('snapshot: the saved copy gives the same answers as the sheets', () => {
  const s = setup();
  const first = s.call(s.admin, 'data');
  const again = s.call(s.admin, 'data');
  for (const k of ['base', 'tx', 'analysisDay', 'checks']) assert.deepStrictEqual(again[k], first[k], k);
  assert.strictEqual(again.dataAt, first.dataAt);
  assert.strictEqual(s.call(s.admin, 'add', { account: 'A1', amount: 3000 }).request.verdict, 'موقوفة');
});

test('snapshot: an old copy, a moved source or a deleted file is rebuilt', () => {
  const s = setup();
  s.call(s.admin, 'data');
  const meta = snapMeta(s);
  s.props.set('snapshot', JSON.stringify(Object.assign({}, meta, { builtAt: meta.builtAt - 31 * 60 * 1000 })));
  s.call(s.admin, 'data');
  assert.strictEqual(sourceReads(s), 4);
  assert.strictEqual(s.drive.files.size, 1);  // the same file is rewritten

  s.props.set('snapshot', JSON.stringify(Object.assign({}, snapMeta(s), { source: 'another sheet' })));
  s.call(s.admin, 'data');
  assert.strictEqual(sourceReads(s), 6);

  s.drive.files.clear();
  assert.ok(s.call(s.admin, 'data').ok);
  assert.strictEqual(sourceReads(s), 8);
  assert.strictEqual(s.drive.files.size, 1);
});

test('snapshot: while a rebuild runs, a stale copy is served instead of a second read', () => {
  const s = setup();
  s.call(s.admin, 'data');
  const meta = snapMeta(s);
  s.props.set('snapshot', JSON.stringify(Object.assign({}, meta, { builtAt: meta.builtAt - 60 * 60 * 1000 })));
  s.cache.put('snapshot:building', '1');
  assert.ok(s.call(s.admin, 'data').ok);
  assert.strictEqual(sourceReads(s), 2);
});

test('snapshot: sheet edits appear after the trigger or the admin refresh, not before', () => {
  const s = setup();
  const clerk = s.addUser('sara', 'موظف');
  assert.strictEqual(s.call(s.admin, 'data').base.length, 3);
  s.sourceBook.getSheetByName('قاعده عملاء الشركه').grid.push(['C1', 'عميل جديد', 1000, 0, 0, 'Net30', 'م', '65', '', '']);
  assert.strictEqual(s.call(s.admin, 'data').base.length, 3);
  s.run('refreshSnapshot');
  assert.strictEqual(s.call(s.admin, 'data').base.length, 4);

  s.sourceBook.getSheetByName('قاعده عملاء الشركه').grid.pop();
  assert.match(s.call(clerk, 'refresh').error, /إدارة النظام/);
  const r = s.call(s.admin, 'refresh');
  assert.ok(r.ok, r.error);
  assert.ok(r.builtAt >= snapMeta(s).builtAt - 1);
  assert.strictEqual(s.call(s.admin, 'data').base.length, 3);
  assert.ok(JSON.stringify(s.book.getSheetByName(LOG).grid).includes('تجهيز نسخة البيانات'));
});

test('snapshot: without the trigger permission the data still works and the admin is told', () => {
  const s = setup({ triggersAllowed: false });
  assert.ok(s.call(s.admin, 'data').ok);
  assert.strictEqual(s.triggers.length, 0);
  const r = s.call(s.admin, 'refresh');
  assert.ok(r.ok, r.error);
  assert.match(r.triggerError, /refreshSnapshot/);
  assert.strictEqual(s.call(s.admin, 'add', { account: 'A1', amount: 1 }).ok, true);
  const allowed = setup();
  assert.strictEqual(allowed.call(allowed.admin, 'refresh').triggerError, '');
});

test('decide: one read of the requests sheet, however many requests there are', () => {
  const s = setup();
  const approver = s.addUser('amr', 'معتمد');
  s.call(s.admin, 'add', { account: 'A1', amount: 3000 });
  const sh = s.book.getSheetByName(REQUESTS);
  const statusCol = sh.grid[0].indexOf('موقف الاعتماد');
  const template = sh.grid[1];
  for (let i = 2; i <= 2000; i++) sh.grid.push(template.map((v, k) => (k === 0 ? `REQ${String(i).padStart(6, '0')}` : v)));
  const id = 'REQ002000';
  let calls = 0;
  const getRange = sh.getRange.bind(sh);
  sh.getRange = (...a) => { calls++; return getRange(...a); };
  const r = s.call(approver, 'decide', { id, decision: 'approve', note: 'تمام' });
  assert.ok(r.ok, r.error);
  assert.ok(calls < 20, `${calls} sheet calls`);
  assert.strictEqual(sh.grid[2000][statusCol], 'معتمد');
  assert.strictEqual(sh.grid[1999][statusCol], 'قيد الاعتماد');
  assert.strictEqual(r.request.status, 'معتمد');
  assert.strictEqual(r.request.decisionNote, 'تمام');
});

test('decide: a column of the user\'s own keeps its formula', () => {
  const s = setup();
  s.call(s.admin, 'add', { account: 'A1', amount: 3000 });
  const sh = s.book.getSheetByName(REQUESTS);
  const own = sh.grid[0].length;
  sh.grid[0][own] = 'عمود خاص';
  sh.grid[1][own] = '=1+1';
  s.call(s.admin, 'decide', { id: 'REQ000001', decision: 'approve' });
  assert.strictEqual(sh.grid[1][own], '=1+1');
});

test('a missing source link gives a clear message', () => {
  const s = loadScript({ sourceId: '', source: source() });
  const t = s.post({ action: 'login', username: 'admin', password: PASS }).token;
  assert.match(s.post({ action: 'data', token: t }).error, /SOURCE_SHEET_ID/);
  const noAccess = loadScript({ sourceId: 'OTHER', source: source() });
  const t2 = noAccess.post({ action: 'login', username: 'admin', password: PASS }).token;
  assert.match(noAccess.post({ action: 'data', token: t2 }).error, /تعذّر فتح شيت العملاء/);
});

test('promises: scoped by warehouse, editable, and marked kept', () => {
  const s = setup();
  const col65 = s.addUser('col65', 'محصل', ['65']);
  const col70 = s.addUser('col70', 'محصل', ['70']);
  const created = s.call(s.admin, 'savePromise', {
    account: 'A1', amount: 1200, due: '2026-07-10', note: 'وعد العميل',
  });
  assert.ok(created.ok, created.error);
  const id = created.promise.id;
  assert.strictEqual(created.promise.customer, 'عميل أ');
  assert.strictEqual(created.promise.warehouse, '65');
  assert.strictEqual(created.promise.status, 'قائم');

  assert.deepStrictEqual(s.call(col65, 'promises').promises.map((p) => p.id), [id]);
  assert.deepStrictEqual(s.call(col70, 'promises').promises, []);
  assert.match(s.call(col65, 'savePromise', { account: 'B1', amount: 10, due: '2026-07-10' }).error, /خارج نطاق/);

  const second = s.call(s.admin, 'savePromise', { account: 'B1', amount: 500, due: '2026-07-11' });
  assert.ok(second.ok, second.error);
  assert.strictEqual(s.call(col65, 'promises').promises.length, 1);

  const updated = s.call(col65, 'savePromise', {
    id, amount: 1300, due: '2026-07-12', status: 'تم الوفاء', note: 'سدد',
  });
  assert.ok(updated.ok, updated.error);
  assert.strictEqual(updated.promise.status, 'تم الوفاء');
  const listed = s.call(col65, 'promises').promises.find((p) => p.id === id);
  assert.strictEqual(listed.amount, 1300);
  assert.strictEqual(listed.due, '2026-07-12');
});

test('promises: viewing is open, saving needs collection permission', () => {
  const s = setup();
  const viewer = s.addUser('viewer', 'موظف');
  const collector = s.addUser('collector', 'محصل', ['65']);
  assert.ok(s.call(viewer, 'promises').ok);
  assert.match(s.call(viewer, 'savePromise', { account: 'A1', amount: 10, due: '2026-07-10' }).error, /متابعة التحصيل/);
  assert.ok(s.call(collector, 'savePromise', { account: 'A1', amount: 10, due: '2026-07-10' }).ok);
});

test('promises: a promise is not written when the audit log cannot be written', () => {
  const s = setup();
  const first = s.call(s.admin, 'savePromise', { account: 'A1', amount: 100, due: '2026-07-10' });
  assert.ok(first.ok, first.error);
  const log = s.book.getSheetByName(LOG);
  const append = log.appendRow;
  log.appendRow = () => { throw new Error('audit down'); };
  const blocked = s.call(s.admin, 'savePromise', { account: 'B1', amount: 200, due: '2026-07-11' });
  assert.strictEqual(blocked.ok, false);
  assert.match(blocked.error, /سجل العمليات/);
  log.appendRow = append;
  assert.strictEqual(s.call(s.admin, 'promises').promises.length, 1);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}\n     ${e.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);

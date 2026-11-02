/**
 * واجهة شيت طلبات الفواتير — تُنشر كـ Web App (Deploy > Web app، Execute as: Me، Who has access: Anyone).
 * كل الطلبات POST بجسم JSON نصي: { action, key, ... }
 *   list   → يرجع كل الطلبات وصلاحية المفتاح
 *   add    → يسجل طلب فاتورة جديد
 *   decide → يعتمد طلبًا أو يرفضه (مفتاح الاعتماد فقط)
 * الشيت والأعمدة الناقصة تُنشأ تلقائيًا، والأعمدة تُقرأ باسمها، فيمكن إضافة أعمدة أخرى أو تغيير ترتيبها.
 */

// ===== الإعدادات: غيّر المفتاحين هنا فقط، ولا ترفع المفاتيح الحقيقية إلى GitHub =====
const REQUEST_KEY = 'غيّر-هذا-المفتاح';   // تسجيل الطلبات ومشاهدتها
const APPROVE_KEY = 'غيّر-هذا-المفتاح';   // كل ما سبق + الاعتماد والرفض
// اتركه فارغًا إذا كان السكربت من داخل الشيت (Extensions > Apps Script)، وإلا ضع معرّف الشيت
const SPREADSHEET_ID = '';

const BUILD = '2026-11-02-a2';
const UNSET_KEY = 'غيّر-هذا-المفتاح';
const SHEET_NAME = 'طلبات الفواتير';
const ID_PREFIX = 'REQ';
const ID_DIGITS = 6;
const STATUS = { pending: 'قيد الاعتماد', approved: 'معتمد', rejected: 'مرفوض', clear: 'لا يحتاج اعتماد' };
const VERDICTS = { ok: 'سليمة', warn: 'تحتاج موافقة', stop: 'موقوفة' };

// اسم الحقل في الموقع ← اسم العمود في الشيت
const COLUMNS = {
  id: 'رقم الطلب',
  createdAt: 'تاريخ الطلب',
  account: 'كود العميل',
  customer: 'اسم العميل',
  rep: 'المندوب',
  idNumber: 'ID number',
  warehouse: 'Warehouse Group',
  group: 'Customer group',
  amount: 'قيمة الفاتورة',
  balance: 'الرصيد قبل الفاتورة',
  balanceAfter: 'الرصيد بعد الفاتورة',
  creditLimit: 'حد الائتمان',
  guarantee: 'الضمان',
  uncovered: 'غير مغطى بالضمان',
  overdue: 'المتأخرات',
  oldestDays: 'أقدم تأخير (يوم)',
  dataDate: 'تاريخ البيانات',
  verdict: 'نتيجة الفحص',
  reasons: 'أسباب النتيجة',
  requester: 'مقدم الطلب',
  note: 'ملاحظات الطلب',
  status: 'موقف الاعتماد',
  approver: 'المعتمد',
  decidedAt: 'تاريخ الاعتماد',
  decisionNote: 'ملاحظات الاعتماد',
  ref: 'مرجع الإرسال',
};
const NUMBER_FIELDS = ['amount', 'balance', 'balanceAfter', 'creditLimit', 'guarantee', 'uncovered', 'overdue', 'oldestDays'];

function doGet() {
  return json_({ ok: true, build: BUILD });
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const role = roleOf_(body.key);
    if (body.action === 'list') return json_({ ok: true, build: BUILD, role: role, requests: readAll_(sheet_()) });
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      if (body.action === 'add') return json_(Object.assign({ ok: true, role: role }, add_(body.request || {})));
      if (body.action === 'decide') return json_({ ok: true, role: role, request: decide_(body, role) });
    } finally {
      lock.releaseLock();
    }
    throw new Error('طلب غير معروف');
  } catch (err) {
    return json_({ ok: false, error: err.message });
  }
}

function roleOf_(key) {
  if (REQUEST_KEY === UNSET_KEY || APPROVE_KEY === UNSET_KEY) throw new Error('غيّر المفتاحين في أول Code.gs ثم انشر إصدارًا جديدًا.');
  if (REQUEST_KEY === APPROVE_KEY) throw new Error('يجب أن يختلف مفتاح الطلبات عن مفتاح الاعتماد.');
  if (key === APPROVE_KEY) return 'approver';
  if (key === REQUEST_KEY) return 'requester';
  throw new Error('مفتاح الدخول غير صحيح.');
}

function add_(req) {
  const account = text_(req.account);
  const amount = Number(req.amount);
  if (!account) throw new Error('كود العميل مطلوب.');
  if (!(amount > 0)) throw new Error('قيمة الفاتورة يجب أن تكون أكبر من صفر.');
  if (!VERDICTS[req.verdict]) throw new Error('نتيجة الفحص غير معروفة.');
  if (!text_(req.requester)) throw new Error('اكتب اسمك في الإعدادات قبل تسجيل الطلب.');

  const sh = sheet_();
  const all = readAll_(sh);
  // A retried send must not create a second request.
  const ref = text_(req.ref);
  const again = ref && all.filter(function (r) { return r.ref === ref; })[0];
  if (again) return { request: again, duplicate: true };

  const row = {};
  Object.keys(COLUMNS).forEach(function (f) {
    row[f] = NUMBER_FIELDS.indexOf(f) >= 0 ? Number(req[f]) || 0 : safe_(req[f]);
  });
  row.id = nextId_(all);
  row.createdAt = now_();
  row.verdict = VERDICTS[req.verdict];
  // A clean check needs no approver; anything else waits for one.
  row.status = req.verdict === 'ok' ? STATUS.clear : STATUS.pending;
  row.approver = '';
  row.decidedAt = '';
  row.decisionNote = '';

  const headers = headers_(sh);
  sh.appendRow(headers.map(function (h) {
    const f = fieldOf_(h);
    return f ? row[f] : '';
  }));
  return { request: row };
}

function decide_(body, role) {
  if (role !== 'approver') throw new Error('الاعتماد يحتاج مفتاح الاعتماد.');
  const decision = body.decision === 'approve' ? STATUS.approved : body.decision === 'reject' ? STATUS.rejected : '';
  if (!decision) throw new Error('القرار غير معروف.');
  if (!text_(body.approver)) throw new Error('اكتب اسمك في الإعدادات قبل الاعتماد.');
  if (decision === STATUS.rejected && !text_(body.note)) throw new Error('اكتب سبب الرفض.');

  const sh = sheet_();
  const headers = headers_(sh);
  const idCol = headers.indexOf(COLUMNS.id);
  const lastRow = sh.getLastRow();
  for (let r = 2; r <= lastRow; r++) {
    if (text_(sh.getRange(r, idCol + 1).getValue()) !== text_(body.id)) continue;
    const current = text_(sh.getRange(r, headers.indexOf(COLUMNS.status) + 1).getValue());
    if (current !== STATUS.pending) throw new Error('هذا الطلب لم يعد قيد الاعتماد: ' + current);
    const put = function (field, value) { sh.getRange(r, headers.indexOf(COLUMNS[field]) + 1).setValue(value); };
    put('status', decision);
    put('approver', safe_(body.approver));
    put('decidedAt', now_());
    put('decisionNote', safe_(body.note));
    return rowToObject_(headers, sh.getRange(r, 1, 1, headers.length).getValues()[0]);
  }
  throw new Error('الطلب غير موجود: ' + text_(body.id));
}

/* ---- sheet helpers ---- */

function sheet_() {
  const book = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  if (!book) throw new Error('السكربت غير مرتبط بشيت. ضع معرّف الشيت في SPREADSHEET_ID.');
  const sh = book.getSheetByName(SHEET_NAME) || book.insertSheet(SHEET_NAME);
  ensureColumns_(sh);
  return sh;
}

// Only appends what is missing, so the user's own columns and order survive.
function ensureColumns_(sh) {
  const headers = headers_(sh);
  const missing = Object.keys(COLUMNS).map(function (f) { return COLUMNS[f]; }).filter(function (h) { return headers.indexOf(h) < 0; });
  if (!missing.length) return;
  sh.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
  sh.setFrozenRows(1);
}

function headers_(sh) {
  const n = sh.getLastColumn();
  if (!n) return [];
  return sh.getRange(1, 1, 1, n).getValues()[0].map(text_);
}

function fieldOf_(header) {
  return Object.keys(COLUMNS).filter(function (f) { return COLUMNS[f] === header; })[0];
}

function rowToObject_(headers, values) {
  const out = {};
  headers.forEach(function (h, i) {
    const f = fieldOf_(h);
    if (f) out[f] = values[i] instanceof Date ? formatDate_(values[i]) : values[i];
  });
  return out;
}

function readAll_(sh) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const headers = headers_(sh);
  return sh.getRange(2, 1, lastRow - 1, headers.length).getValues()
    .map(function (v) { return rowToObject_(headers, v); })
    .filter(function (r) { return text_(r.id); });
}

function nextId_(all) {
  const max = all.reduce(function (m, r) {
    const n = parseInt(String(r.id).replace(ID_PREFIX, ''), 10);
    return n > m ? n : m;
  }, 0);
  return ID_PREFIX + String(max + 1).padStart(ID_DIGITS, '0');
}

function text_(v) { return v == null ? '' : String(v).trim(); }

// A leading = + - @ would run as a formula once written to the sheet.
function safe_(v) {
  const s = text_(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function formatDate_(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'); }
function now_() { return formatDate_(new Date()); }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

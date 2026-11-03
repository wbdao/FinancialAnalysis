/**
 * خادم نظام موقف الفواتير — يُنشر كـ Web App (Deploy > Web app، Execute as: Me، Who has access: Anyone).
 * يحتاج ملفين في مشروع السكربت: Code.gs (هذا الملف) و Engine.gs (نسخة من engine.js).
 *
 * كل الطلبات POST بجسم JSON نصي: { action, token, ... } — token من login { username, password }.
 *   data       → بيانات العملاء والحركات في نطاق مخازن المستخدم
 *   add        → تسجيل طلب فاتورة، والخادم هو الذي يحسب الفحص
 *   list       → طلبات نطاق المستخدم
 *   recheck    → فحص طلب بالبيانات الحالية قبل القرار
 *   decide     → اعتماد أو رفض (معتمد أو مدير)
 *   users، userSave، setRules → للمدير فقط
 *   changePassword، logout → لكل مستخدم
 *
 * الشيتات تُنشأ تلقائيًا في شيت الطلبات: «طلبات الفواتير» و«المستخدمين» و«سجل العمليات».
 */

// ===== الإعدادات: غيّرها هنا فقط، ولا ترفع القيم الحقيقية إلى GitHub =====
const ADMIN_PASSWORD = 'غيّر-هذه-الكلمة';   // دخول المدير الاحتياطي: اسم المستخدم admin
const SOURCE_SHEET_ID = '';                 // معرّف شيت العملاء والحركات، من رابطه بعد /d/
const BASE_TAB = 'قاعده عملاء الشركه';
const TX_TAB = 'حركات العملاء';
// اختياري: شيت الشيكات (نفس الذي يقرؤه موقع حسابات العملاء). فارغ = التحليل بدون شيكات
const CHECKS_SHEET_ID = '';
const CHECKS_TAB = 'الشيكات (2)';
const CHECKS_WH_TAB = 'شيكات المخازن';       // فارغ = بدون شيكات المخازن
// اتركه فارغًا إذا كان السكربت من داخل شيت الطلبات، وإلا ضع معرّف شيت الطلبات
const SPREADSHEET_ID = '';

const BUILD = '2026-11-04-a5';
const UNSET_PASSWORD = 'غيّر-هذه-الكلمة';
const SHEET_NAME = 'طلبات الفواتير';
const USERS_SHEET = 'المستخدمين';
const LOG_SHEET = 'سجل العمليات';
const ID_PREFIX = 'REQ';
const ID_DIGITS = 6;
const STATUS = { pending: 'قيد الاعتماد', approved: 'معتمد', rejected: 'مرفوض', clear: 'لا يحتاج اعتماد' };
const VERDICTS = { ok: 'سليمة', warn: 'تحتاج موافقة', stop: 'موقوفة' };

const ROLE_USER = 'موظف', ROLE_APPROVER = 'معتمد', ROLE_ADMIN = 'مدير';
const ROLES = [ROLE_USER, ROLE_APPROVER, ROLE_ADMIN];
const ALL_WAREHOUSES = 'الكل';
const BREAK_GLASS = '*admin*';
const LOGIN_NEEDED = 'سجّل الدخول من جديد.';
const SESSION_SECONDS = 6 * 60 * 60;        // أقصى مدة في CacheService
const USERS_CACHE = 'users:v1';
const USERS_TTL = 5 * 60;
const HASH_ROUNDS = 2000;
const MIN_PASSWORD = 8;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const RULES_KEY = 'rules';

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
  requesterUser: 'مستخدم مقدم الطلب',
  note: 'ملاحظات الطلب',
  status: 'موقف الاعتماد',
  approver: 'المعتمد',
  decidedAt: 'تاريخ الاعتماد',
  decisionNote: 'ملاحظات الاعتماد',
  verdictAtDecision: 'نتيجة الفحص عند القرار',
  checksOpen: 'شيكات مفتوحة',
  checksDue: 'شيكات مستحقة لم تُصرف',
  checksRejected: 'شيكات مرفوضة',
  exposureAfter: 'التعرض بعد الفاتورة (شامل الشيكات)',
  ref: 'مرجع الإرسال',
};
const USER_COLUMNS = {
  username: 'اسم المستخدم', name: 'الاسم', role: 'الصلاحية', active: 'مفعّل',
  warehouses: 'المخازن', hash: 'كلمة السر (مشفرة)', salt: 'Salt',
};

function doGet() {
  return json_({ ok: true, build: BUILD });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (ADMIN_PASSWORD === UNSET_PASSWORD || ADMIN_PASSWORD.length < MIN_PASSWORD) {
      throw new Error('غيّر ADMIN_PASSWORD في أول Code.gs إلى ' + MIN_PASSWORD + ' أحرف على الأقل، ثم انشر إصدارًا جديدًا.');
    }
    if (req.action === 'login') return json_(Object.assign({ ok: true }, login_(req)));
    const who = session_(req.token);
    return json_(Object.assign({ ok: true, build: BUILD, user: publicUser_(who) }, route_(req, who)));
  } catch (err) {
    return json_({ ok: false, error: err.message, login: !!err.login });
  }
}

function route_(req, who) {
  switch (req.action) {
    case 'logout': return logout_(req.token);
    case 'data': return data_(who);
    case 'list': return { requests: scopedRequests_(who) };
    case 'add': return add_(req, who);
    case 'recheck': return { check: recheck_(req, who) };
    case 'decide': return { request: decide_(req, who) };
    case 'changePassword': return changePassword_(req, who);
    case 'users': requireAdmin_(who); return { users: usersList_() };
    case 'userSave': requireAdmin_(who); return { users: locked_(function () { return userSave_(req, who); }) };
    case 'setRules': requireAdmin_(who); return { rules: locked_(function () { return setRules_(req, who); }) };
    default: throw new Error('طلب غير معروف');
  }
}

function locked_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function requireAdmin_(who) {
  if (who.role !== ROLE_ADMIN) throw new Error('هذه العملية للمدير فقط.');
}

/* ---- sessions and passwords ---- */

function login_(req) {
  const uname = normUser_(req.username);
  const pass = String(req.password || '');
  if (!uname || !pass) throw new Error('اكتب اسم المستخدم وكلمة المرور.');
  const cache = CacheService.getScriptCache();
  const failKey = 'fail:' + uname, lockKey = 'lock:' + uname;
  if (cache.get(lockKey)) throw new Error('الحساب مقفول ' + LOCK_MINUTES + ' دقيقة بسبب محاولات خاطئة كثيرة.');
  let who = null;
  if (uname === 'admin' && pass === ADMIN_PASSWORD) {
    who = breakGlass_();
  } else {
    const u = users_()[uname];
    if (u && u.hash && u.salt && hashPassword_(pass, u.salt) === u.hash) {
      if (!u.active) throw new Error('هذا الحساب متوقف. تواصل مع المدير.');
      who = u;
    }
  }
  if (!who) {
    const fails = (parseInt(cache.get(failKey), 10) || 0) + 1;
    if (fails >= MAX_FAILS) {
      cache.put(lockKey, '1', LOCK_MINUTES * 60);
      cache.remove(failKey);
      throw new Error('محاولات خاطئة كثيرة، قُفل الحساب ' + LOCK_MINUTES + ' دقيقة.');
    }
    cache.put(failKey, String(fails), LOCK_MINUTES * 60);
    throw new Error('اسم المستخدم أو كلمة المرور غير صحيح.');
  }
  cache.remove(failKey);
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  const session = { u: who.username };
  if (who.username === BREAK_GLASS) session.tag = passwordTag_();
  else session.tag = who.hash.slice(0, 12);  // A changed password ends older sessions.
  cache.put('sess:' + token, JSON.stringify(session), SESSION_SECONDS);
  audit_(publicName_(who), 'دخول', '');
  return { token: token, user: publicUser_(who) };
}

function session_(token) {
  const key = 'sess:' + String(token || '').trim();
  const cache = CacheService.getScriptCache();
  const raw = token ? cache.get(key) : null;
  if (!raw) throw loginError_(LOGIN_NEEDED);
  const s = JSON.parse(raw);
  if (s.u === BREAK_GLASS) {
    if (s.tag !== passwordTag_()) { cache.remove(key); throw loginError_(LOGIN_NEEDED); }
    return breakGlass_();
  }
  // Read on every request, so stopping a user or changing a role works at once.
  const u = users_()[s.u];
  if (!u || !u.active) { cache.remove(key); throw loginError_('حسابك متوقف. تواصل مع المدير.'); }
  if (s.tag !== u.hash.slice(0, 12)) { cache.remove(key); throw loginError_(LOGIN_NEEDED); }
  return u;
}

function logout_(token) {
  CacheService.getScriptCache().remove('sess:' + String(token || '').trim());
  return {};
}

function changePassword_(req, who) {
  if (who.username === BREAK_GLASS) throw new Error('كلمة مرور admin تتغير من Code.gs.');
  const next = String(req.newPassword || '');
  if (next.length < MIN_PASSWORD) throw new Error('كلمة المرور يجب ألا تقل عن ' + MIN_PASSWORD + ' أحرف.');
  if (hashPassword_(String(req.oldPassword || ''), who.salt) !== who.hash) throw new Error('كلمة المرور الحالية غير صحيحة.');
  locked_(function () {
    const salt = Utilities.getUuid().replace(/-/g, '');
    const hash = hashPassword_(next, salt);
    const sh = usersSheet_();
    const headers = headers_(sh);
    sh.getRange(who.row, headers.indexOf(USER_COLUMNS.hash) + 1).setValue(hash);
    sh.getRange(who.row, headers.indexOf(USER_COLUMNS.salt) + 1).setValue(salt);
    clearUsersCache_();
    audit_(who.name, 'تغيير كلمة المرور', who.username);
  });
  return {};
}

function breakGlass_() {
  return { username: BREAK_GLASS, name: 'المدير', role: ROLE_ADMIN, warehouses: [], active: true };
}

function publicName_(who) { return who.username === BREAK_GLASS ? 'المدير (admin)' : who.name; }

function publicUser_(who) {
  return {
    username: who.username === BREAK_GLASS ? 'admin' : who.username,
    name: who.name, role: who.role, warehouses: who.warehouses,
  };
}

function loginError_(msg) { const e = new Error(msg); e.login = true; return e; }
function normUser_(u) { return text_(u).toLowerCase(); }
function passwordTag_() { return sha_('admin:' + ADMIN_PASSWORD).slice(0, 12); }

function sha_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function hashPassword_(pass, salt) {
  let h = sha_(salt + ':' + pass);
  for (let i = 0; i < HASH_ROUNDS; i++) h = sha_(h + salt);
  return h;
}

/* ---- users ---- */

function usersSheet_() {
  return ensureSheet_(requestsBook_(), USERS_SHEET, USER_COLUMNS);
}

function users_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(USERS_CACHE);
  if (hit) return JSON.parse(hit);
  const sh = usersSheet_();
  const headers = headers_(sh);
  const at = function (field) { return headers.indexOf(USER_COLUMNS[field]); };
  const out = {};
  const last = sh.getLastRow();
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, headers.length).getValues().forEach(function (r, i) {
      const k = normUser_(r[at('username')]);
      if (!k || out[k]) return;
      const role = text_(r[at('role')]);
      out[k] = {
        username: k, name: text_(r[at('name')]) || k, role: ROLES.indexOf(role) >= 0 ? role : ROLE_USER,
        active: isYes_(r[at('active')]), warehouses: parseWarehouses_(r[at('warehouses')]),
        hash: text_(r[at('hash')]), salt: text_(r[at('salt')]), row: i + 2,
      };
    });
  }
  try { cache.put(USERS_CACHE, JSON.stringify(out), USERS_TTL); } catch (e) { /* the cache is optional */ }
  return out;
}

function clearUsersCache_() { CacheService.getScriptCache().remove(USERS_CACHE); }

// A manual edit of the users tab (stopping someone, changing a role) applies at once.
function onEdit(e) {
  if (e && e.range && e.range.getSheet().getName() === USERS_SHEET) clearUsersCache_();
}

function isYes_(v) { return v === true || ['true', 'yes', 'نعم', '1'].indexOf(text_(v).toLowerCase()) >= 0; }

// Empty or «الكل» means every warehouse.
function parseWarehouses_(v) {
  const list = text_(v).split(/[،,]/).map(text_).filter(Boolean);
  return list.indexOf(ALL_WAREHOUSES) >= 0 ? [] : list;
}

function usersList_() {
  const us = users_();
  return Object.keys(us).map(function (k) {
    const u = us[k];
    return { username: u.username, name: u.name, role: u.role, active: u.active, warehouses: u.warehouses };
  });
}

function userSave_(req, who) {
  const k = normUser_(req.username);
  if (!/^[a-z0-9._-]{3,30}$/.test(k)) throw new Error('اسم المستخدم من 3 إلى 30 حرفًا إنجليزيًا أو رقمًا، بدون مسافات.');
  if (k === 'admin') throw new Error('اسم المستخدم admin محجوز للدخول الاحتياطي.');
  if (ROLES.indexOf(req.role) < 0) throw new Error('الصلاحية يجب أن تكون: ' + ROLES.join(' أو '));
  const pass = String(req.password || '');
  if (pass && pass.length < MIN_PASSWORD) throw new Error('كلمة المرور يجب ألا تقل عن ' + MIN_PASSWORD + ' أحرف.');
  if (k === who.username && (req.active === false || req.role !== ROLE_ADMIN)) {
    throw new Error('لا يمكنك إيقاف حسابك أو إزالة صلاحية المدير من نفسك.');
  }
  clearUsersCache_();
  const existing = users_()[k];
  if (!existing && !pass) throw new Error('المستخدم الجديد يحتاج كلمة مرور.');
  const sh = usersSheet_();
  const headers = headers_(sh);
  const list = (Array.isArray(req.warehouses) ? req.warehouses : []).map(text_).filter(Boolean);
  const fields = {
    username: k, name: safe_(req.name) || k, role: req.role, active: req.active !== false,
    warehouses: list.length ? list.join('، ') : ALL_WAREHOUSES,
  };
  if (pass) {
    fields.salt = Utilities.getUuid().replace(/-/g, '');
    fields.hash = hashPassword_(pass, fields.salt);
  }
  if (existing) {
    Object.keys(fields).forEach(function (f) {
      sh.getRange(existing.row, headers.indexOf(USER_COLUMNS[f]) + 1).setValue(fields[f]);
    });
  } else {
    sh.appendRow(headers.map(function (h) {
      const f = Object.keys(USER_COLUMNS).filter(function (x) { return USER_COLUMNS[x] === h; })[0];
      return f && fields[f] !== undefined ? fields[f] : '';
    }));
  }
  clearUsersCache_();
  audit_(publicName_(who), existing ? 'تعديل مستخدم' : 'إضافة مستخدم',
    k + ' · ' + fields.role + ' · ' + fields.warehouses + (fields.active ? '' : ' · متوقف') + (pass ? ' · كلمة مرور جديدة' : ''));
  return usersList_();
}

/* ---- rules ---- */

function rules_() {
  const saved = PropertiesService.getScriptProperties().getProperty(RULES_KEY);
  return Object.assign({}, Engine.DEFAULT_RULES, saved ? JSON.parse(saved) : {});
}

function setRules_(req, who) {
  const stopDays = Number(req.stopDays), tolerance = Number(req.tolerance);
  if (['stop', 'warn'].indexOf(req.overLimit) < 0 || !(stopDays >= 0) || !(tolerance >= 0)) throw new Error('قيم القواعد غير صحيحة.');
  const rules = { overLimit: req.overLimit, stopDays: stopDays, tolerance: tolerance };
  PropertiesService.getScriptProperties().setProperty(RULES_KEY, JSON.stringify(rules));
  audit_(publicName_(who), 'تعديل القواعد', JSON.stringify(rules));
  return rules;
}

/* ---- customer data, always cut to the user's warehouses ---- */

function sourceBook_() {
  if (!SOURCE_SHEET_ID) throw new Error('ضع معرّف شيت العملاء في SOURCE_SHEET_ID في Code.gs، ثم انشر إصدارًا جديدًا.');
  try {
    return SpreadsheetApp.openById(SOURCE_SHEET_ID);
  } catch (e) {
    throw new Error('تعذّر فتح شيت العملاء. تأكد أنه Google Sheet وليس xlsx، وأن حساب ناشر السكربت يملك صلاحية عليه.');
  }
}

/**
 * findTab_ - a tab by name, tolerating extra spaces and common spelling variants
 * as CSAccounts does. The customer tabs also accept one tab whose name looks alike.
 * @param {string=} where the file and settings to name in the error, for the checks sheet
 */
function findTab_(book, tab, where) {
  const norm = function (s) {
    return text_(s).replace(/\s+/g, ' ').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
  };
  const tabs = book.getSheets();
  const same = tabs.filter(function (s) { return norm(s.getName()) === norm(tab); });
  if (same.length === 1) return same[0];
  const hint = tab === BASE_TAB ? /عملاء الشرك|قاعد/ : tab === TX_TAB ? /حركات/ : null;
  const like = hint ? tabs.filter(function (s) { return hint.test(norm(s.getName())); }) : [];
  if (like.length === 1) return like[0];
  const names = tabs.map(function (s) { return '"' + s.getName() + '"'; }).join('، ');
  throw new Error('لم أجد شيت "' + tab + '" في ' + (where || 'شيت العملاء') + '. التبويبات الموجودة: ' + names +
    '. اكتب الاسم الصحيح في ' + (where ? 'CHECKS_TAB أو CHECKS_WH_TAB' : 'BASE_TAB أو TX_TAB') + '.');
}

function isDate_(v) { return Object.prototype.toString.call(v) === '[object Date]'; }

// Only the columns the engine knows leave the sheet, with dates as epoch days.
function sourceRows_(book, tab, spec) {
  const values = findTab_(book, tab).getDataRange().getValues();
  if (!values.length) return [[]];
  const wanted = {};
  Object.keys(spec).forEach(function (k) { spec[k].forEach(function (n) { wanted[n.toLowerCase()] = true; }); });
  const keep = [];
  values[0].forEach(function (h, i) { if (wanted[text_(h).toLowerCase()]) keep.push(i); });
  return project_(values, keep, book.getSpreadsheetTimeZone());
}

function project_(rows, keep, tz) {
  return rows.map(function (row) {
    return keep.map(function (i) {
      const v = row[i];
      if (!isDate_(v)) return v;
      const p = Utilities.formatDate(v, tz, 'yyyy-MM-dd').split('-').map(Number);
      return Date.UTC(p[0], p[1] - 1, p[2]) / 86400000;
    });
  });
}

/**
 * checkRows_ - one checks tab, header first, cut to the accounts in scope.
 * Its header may sit under a totals row, so the header is the first of the top
 * rows that names the customer code; it may also be merged ("15 كود العميل").
 */
function checkRows_(book, tab, spec, mine) {
  const values = findTab_(book, tab, 'شيت الشيكات').getDataRange().getValues();
  const names = function (h) { return text_(h); };
  const isCode = function (h) { return names(h) === 'كود العميل' || names(h).slice(-' كود العميل'.length) === ' كود العميل'; };
  const at = values.slice(0, 5).findIndex(function (r) { return r.some(isCode); });
  if (at < 0) throw new Error('لم أجد عمود "كود العميل" في أول صفوف تبويب "' + tab + '" في شيت الشيكات.');
  const header = values[at];
  const keep = [];
  header.forEach(function (h, i) {
    const wanted = Object.keys(spec).some(function (k) {
      return spec[k].some(function (n) { return names(h) === n || names(h).slice(-(n.length + 1)) === ' ' + n; });
    });
    if (wanted) keep.push(i);
  });
  const code = header.findIndex(isCode);
  const rows = [header].concat(values.slice(at + 1).filter(function (r) { return mine(text_(r[code])); }));
  return project_(rows, keep, book.getSpreadsheetTimeZone());
}

function checksOf_(mine) {
  if (!CHECKS_SHEET_ID) return null;
  let book;
  try {
    book = SpreadsheetApp.openById(CHECKS_SHEET_ID);
  } catch (e) {
    throw new Error('تعذّر فتح شيت الشيكات. تأكد من CHECKS_SHEET_ID، وأنه Google Sheet، وأن حساب ناشر السكربت يملك صلاحية عليه.');
  }
  const main = checkRows_(book, CHECKS_TAB, Engine.CHECK_COLS.main, mine);
  const hasWh = CHECKS_WH_TAB && book.getSheets().some(function (s) { return text_(s.getName()) === CHECKS_WH_TAB; });
  return { main: main, wh: hasWh ? checkRows_(book, CHECKS_WH_TAB, Engine.CHECK_COLS.wh, mine) : null };
}

function columnOf_(rows, names) {
  const header = (rows[0] || []).map(function (h) { return text_(h).toLowerCase(); });
  for (let i = 0; i < names.length; i++) {
    const at = header.indexOf(names[i].toLowerCase());
    if (at >= 0) return at;
  }
  return -1;
}

function inScope_(who, warehouse) {
  return !who.warehouses.length || who.warehouses.indexOf(text_(warehouse)) >= 0;
}

/**
 * scopedSheets_ - the two sheets cut to the user's warehouses, and to one account if given.
 * The analysis date always comes from the whole sheet.
 */
function scopedSheets_(who, account) {
  const book = sourceBook_();
  const base = sourceRows_(book, BASE_TAB, Engine.BASE_COLS);
  const tx = sourceRows_(book, TX_TAB, Engine.TX_COLS);
  const analysisDay = Engine.lastMovementDay(tx);
  const baseAccount = columnOf_(base, Engine.BASE_COLS.account);
  const baseWarehouse = columnOf_(base, Engine.BASE_COLS.warehouse);
  const txAccount = columnOf_(tx, Engine.TX_COLS.account);
  if (who.warehouses.length && baseWarehouse < 0) throw new Error('لا يوجد عمود Warehouse Group في قاعدة العملاء لتطبيق نطاق المخازن.');
  const wholeSheet = !who.warehouses.length && !account;
  const allowed = {};
  const baseOut = [base[0]].concat(base.slice(1).filter(function (r) {
    const code = text_(r[baseAccount]);
    if (!code || (account && code !== account)) return false;
    if (baseWarehouse >= 0 && !inScope_(who, r[baseWarehouse])) return false;
    allowed[code] = true;
    return true;
  }));
  const txOut = wholeSheet ? tx : [tx[0]].concat(tx.slice(1).filter(function (r) { return allowed[text_(r[txAccount])]; }));
  const mine = function (code) { return !!code && (wholeSheet || allowed[code] === true); };
  return { base: baseOut, tx: txOut, analysisDay: analysisDay, mine: mine };
}

function data_(who) {
  const started = Date.now();
  const sheets = scopedSheets_(who, '');
  // The screens still work without the checks; the site shows why they are missing.
  let checks = null, checksError = '';
  try {
    checks = checksOf_(sheets.mine);
  } catch (e) {
    checksError = e.message;
  }
  return {
    base: sheets.base, tx: sheets.tx, analysisDay: sheets.analysisDay, rules: rules_(), checks: checks, checksError: checksError,
    stats: {
      ms: Date.now() - started, customers: sheets.base.length - 1, movements: sheets.tx.length - 1,
      checks: checks ? checks.main.length - 1 + (checks.wh ? checks.wh.length - 1 : 0) : 0,
    },
  };
}

/* ---- the check, computed here so a browser cannot change its result ---- */

function evaluate_(who, account, amount) {
  const sheets = scopedSheets_(who, account);
  if (sheets.base.length < 2) throw new Error('العميل غير موجود في قاعدة العملاء أو خارج نطاق مخازنك: ' + account);
  const rules = rules_();
  // Unlike the screens, a request is never checked without the checks: a failure stops it.
  const checks = checksOf_(sheets.mine);
  const c = Engine.analyze(sheets.base, sheets.tx, rules, sheets.analysisDay, checks).customers[0];
  const result = Engine.evaluateNew(c, amount, rules);
  const reasons = Object.keys(result.checks)
    .map(function (k) { return result.checks[k]; })
    .filter(function (x) { return x.level !== 'ok'; })
    .map(function (x) { return x.label; }).join('، ');
  return {
    account: c.account, customer: c.name, rep: c.rep, idNumber: c.idNumber, warehouse: c.warehouse, group: c.group,
    amount: amount, balance: c.balance, balanceAfter: result.balanceAfter, creditLimit: c.creditLimit, guarantee: c.guarantee,
    uncovered: result.uncovered, overdue: c.overdue, oldestDays: c.oldestOverdueDays,
    checksOpen: c.checksOpen, checksDue: c.checksDue, checksRejected: c.checksRejected, exposureAfter: result.exposureAfter,
    dataDate: Utilities.formatDate(new Date(sheets.analysisDay * 86400000), 'UTC', 'yyyy-MM-dd'),
    verdict: result.verdict, verdictLabel: VERDICTS[result.verdict], reasons: reasons,
  };
}

/* ---- requests ---- */

function add_(req, who) {
  const account = text_(req.account);
  const amount = Number(req.amount);
  if (!account) throw new Error('كود العميل مطلوب.');
  if (!(amount > 0)) throw new Error('قيمة الفاتورة يجب أن تكون أكبر من صفر.');
  // Reading the customer sheets is slow, so it stays outside the lock.
  const check = evaluate_(who, account, amount);
  return locked_(function () {
    const sh = requestsSheet_();
    const all = readAll_(sh);
    // A retried send must not create a second request.
    const ref = text_(req.ref);
    const again = ref && all.filter(function (r) { return r.ref === ref; })[0];
    if (again) return { request: again, duplicate: true };
    const row = {};
    Object.keys(COLUMNS).forEach(function (f) { row[f] = ''; });
    ['account', 'customer', 'rep', 'idNumber', 'warehouse', 'group', 'dataDate', 'reasons'].forEach(function (f) { row[f] = safe_(check[f]); });
    ['amount', 'balance', 'balanceAfter', 'creditLimit', 'guarantee', 'uncovered', 'overdue', 'oldestDays',
      'checksOpen', 'checksDue', 'checksRejected', 'exposureAfter'].forEach(function (f) { row[f] = check[f]; });
    row.id = nextId_(all);
    row.createdAt = now_();
    row.verdict = check.verdictLabel;
    row.requester = safe_(who.name);
    row.requesterUser = who.username === BREAK_GLASS ? 'admin' : who.username;
    row.note = safe_(req.note);
    row.ref = safe_(ref);
    // A clean check needs no approver; anything else waits for one.
    row.status = check.verdict === 'ok' ? STATUS.clear : STATUS.pending;
    const headers = headers_(sh);
    sh.appendRow(headers.map(function (h) {
      const f = fieldOf_(h);
      return f ? row[f] : '';
    }));
    return { request: row };
  });
}

function scopedRequests_(who) {
  return readAll_(requestsSheet_()).filter(function (r) { return inScope_(who, r.warehouse); });
}

function findRequest_(who, id) {
  const r = scopedRequests_(who).filter(function (x) { return text_(x.id) === text_(id); })[0];
  if (!r) throw new Error('الطلب غير موجود أو خارج نطاق مخازنك: ' + text_(id));
  return r;
}

function requireDecider_(who, r) {
  if (who.role !== ROLE_APPROVER && who.role !== ROLE_ADMIN) throw new Error('الاعتماد لصلاحية معتمد أو مدير.');
  // The admin may, so that a one-person setup can still work.
  if (who.role !== ROLE_ADMIN && normUser_(r.requesterUser) === who.username) throw new Error('لا يمكنك اعتماد طلب قدّمته بنفسك.');
}

function recheck_(req, who) {
  const r = findRequest_(who, req.id);
  requireDecider_(who, r);
  return evaluate_(who, text_(r.account), Number(r.amount));
}

function decide_(req, who) {
  const decision = req.decision === 'approve' ? STATUS.approved : req.decision === 'reject' ? STATUS.rejected : '';
  if (!decision) throw new Error('القرار غير معروف.');
  if (decision === STATUS.rejected && !text_(req.note)) throw new Error('اكتب سبب الرفض.');
  const r = findRequest_(who, req.id);
  requireDecider_(who, r);
  const check = evaluate_(who, text_(r.account), Number(r.amount));
  return locked_(function () {
    const sh = requestsSheet_();
    const headers = headers_(sh);
    const idCol = headers.indexOf(COLUMNS.id);
    const lastRow = sh.getLastRow();
    for (let row = 2; row <= lastRow; row++) {
      if (text_(sh.getRange(row, idCol + 1).getValue()) !== text_(req.id)) continue;
      const current = text_(sh.getRange(row, headers.indexOf(COLUMNS.status) + 1).getValue());
      if (current !== STATUS.pending) throw new Error('هذا الطلب لم يعد قيد الاعتماد: ' + current);
      const put = function (field, value) { sh.getRange(row, headers.indexOf(COLUMNS[field]) + 1).setValue(value); };
      put('status', decision);
      put('approver', safe_(publicName_(who)));
      put('decidedAt', now_());
      put('decisionNote', safe_(req.note));
      put('verdictAtDecision', check.verdictLabel + (check.reasons ? ': ' + safe_(check.reasons) : ''));
      audit_(publicName_(who), decision, text_(req.id));
      return rowToObject_(headers, sh.getRange(row, 1, 1, headers.length).getValues()[0]);
    }
    throw new Error('الطلب غير موجود: ' + text_(req.id));
  });
}

/* ---- sheet helpers ---- */

function requestsBook_() {
  const book = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  if (!book) throw new Error('السكربت غير مرتبط بشيت الطلبات. ضع معرّفه في SPREADSHEET_ID.');
  return book;
}

function requestsSheet_() {
  return ensureSheet_(requestsBook_(), SHEET_NAME, COLUMNS);
}

// Only appends what is missing, so the user's own columns and order survive.
function ensureSheet_(book, name, columns) {
  const sh = book.getSheetByName(name) || book.insertSheet(name);
  const headers = headers_(sh);
  const missing = Object.keys(columns).map(function (f) { return columns[f]; }).filter(function (h) { return headers.indexOf(h) < 0; });
  if (missing.length) {
    sh.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function audit_(who, action, detail) {
  try {
    const book = requestsBook_();
    const sh = book.getSheetByName(LOG_SHEET) || book.insertSheet(LOG_SHEET);
    if (!sh.getLastRow()) sh.appendRow(['الوقت', 'المستخدم', 'العملية', 'التفاصيل']);
    sh.appendRow([now_(), safe_(who), action, safe_(detail)]);
  } catch (e) {
    console.warn('audit not written: ' + e.message);
  }
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
    if (f) out[f] = isDate_(values[i]) ? formatDate_(values[i]) : values[i];
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

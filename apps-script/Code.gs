/**
 * خادم نظام موقف الفواتير — يُنشر كـ Web App (Deploy > Web app، Execute as: Me، Who has access: Anyone).
 * يحتاج ملفين في مشروع السكربت: Code.gs (هذا الملف) و Engine.gs (نسخة من engine.js).
 *
 * كل الطلبات POST بجسم JSON نصي: { action, token, ... } — token من login { username, password }.
 *   data       → بيانات العملاء والحركات في نطاق مخازن المستخدم
 *   ping       → تحقق سريع من الجلسة وقواعد التحليل بدون قراءة الشيتات
 *   refresh    → إعادة تجهيز نسخة البيانات الآن (للمدير)
 *   add        → تسجيل طلب فاتورة، والخادم هو الذي يحسب الفحص
 *   edit       → تعديل طلب قيد الاعتماد أو مرفوض وإعادة إرساله
 *   plans      → خطط السداد من شيت «طرق السداد» إن وُجد
 *   list       → طلبات نطاق المستخدم
 *   promises   → وعود السداد في نطاق المستخدم
 *   savePromise → تسجيل وعد سداد أو تحديث حالته
 *   recheck    → فحص طلب بالبيانات الحالية قبل القرار
 *   decide     → اعتماد أو رفض (معتمد أو مدير)
 *   audit      → سجل العمليات مع تصفية اختيارية (للمدير فقط)
 *   users، userSave، setRules، refresh → للمدير فقط
 *   changePassword، logout → لكل مستخدم
 *
 * الشيتات تُنشأ تلقائيًا في شيت الطلبات: «طلبات الفواتير» و«المستخدمين» و«سجل العمليات».
 *
 * السرعة: كل العمليات تقرأ من «نسخة البيانات»، وهي ملف مضغوط في Drive حساب ناشر السكربت
 * يحتوي أعمدة التحليل فقط. يعيد السكربت تجهيزها كل 15 دقيقة بمؤقت ينشئه بنفسه، والمدير يجهزها فورًا
 * من الإعدادات. إذا توقف المؤقت، تُجهَّز عند أول طلب بعد 30 دقيقة.
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
// شيت خطط السداد (اختياري). فارغ = يبحث في شيت العملاء ثم شيت الطلبات.
// إن لم يوجد، تُدخل الدفعة المقدمة والأسبوعية يدويًا في الطلب.
const PLANS_TAB = 'طرق السداد';
const PLANS_FALLBACK_TAB = 'PaymantSchedual';
const PLANS_SHEET_ID = '';

const BUILD = '2026-11-06-a19';
const UNSET_PASSWORD = 'غيّر-هذه-الكلمة';
const SHEET_NAME = 'طلبات الفواتير';
const USERS_SHEET = 'المستخدمين';
const LOG_SHEET = 'سجل العمليات';
const ID_PREFIX = 'REQ';
const ID_DIGITS = 6;
const STATUS = { pending: 'قيد الاعتماد', approved: 'معتمد', rejected: 'مرفوض', clear: 'لا يحتاج اعتماد' };
const VERDICTS = { ok: 'سليمة', warn: 'تحتاج موافقة', stop: 'موقوفة' };
// Delivery is a second axis: an approved request can still sit in the warehouse
// waiting for a truck, so it never changes the approval status above.
const DELIVERY = {
  warehouse: 'في أرضية المخزن',
  transit: 'جاري التسليم',
  delivered: 'تم التسليم',
  failed: 'متعذر التسليم',
};
const DELIVERY_LIST = [DELIVERY.warehouse, DELIVERY.transit, DELIVERY.delivered, DELIVERY.failed];
const DELIVERY_REASONS = [
  'عدم توافر عربيات النقل', 'العميل غير جاهز', 'نقص أصناف', 'مشكلة مستندات', 'أخرى',
];

const ROLE_USER = 'موظف', ROLE_APPROVER = 'معتمد', ROLE_ADMIN = 'مدير', ROLE_DELIVERY = 'محاسب مخزن';
const ROLE_COLLECTOR = 'محصل';
const ROLE_VIEWER = 'مشاهد', ROLE_CUSTOM = 'مخصص';
const ROLES = [ROLE_USER, ROLE_APPROVER, ROLE_DELIVERY, ROLE_COLLECTOR, ROLE_ADMIN];
// A user may hold any mix of these instead of one fixed role. Viewing is open
// to every signed-in user; the rest are granted one by one.
const PERM = {
  add: 'تسجيل الطلبات',
  approve: 'اعتماد الطلبات',
  deliver: 'متابعة التسليم',
  collect: 'متابعة التحصيل',
  admin: 'إدارة النظام',
};
const PERM_LIST = [PERM.add, PERM.approve, PERM.deliver, PERM.collect, PERM.admin];
const ALL_WAREHOUSES = 'الكل';
const BREAK_GLASS = '*admin*';
const LOGIN_NEEDED = 'سجّل الدخول من جديد.';
const SESSION_SECONDS = 6 * 60 * 60;        // أقصى مدة في CacheService
const USERS_CACHE = 'users:v2';
const USERS_TTL = 5 * 60;
const HASH_ROUNDS = 2000;
const MIN_PASSWORD = 8;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const RULES_KEY = 'rules';
// A just-checked customer is reused for a short while, so the approve click
// after reading the decision does not read the sheets again.
const EVAL_CACHE = 'eval:v1';
const EVAL_TTL = 60;
// The optional payment-plan reference sheet changes rarely, so it is cached.
const PLANS_CACHE = 'plans:v1';
const PLANS_TTL = 300;
// The data snapshot: the source sheets read once, gzipped into a Drive file.
const SNAPSHOT_KEY = 'snapshot';
const SNAPSHOT_NAME = 'موقف الفواتير - نسخة البيانات (لا تحذفها)';
const SNAPSHOT_MINUTES = 15;                  // the trigger rebuilds it this often (1, 5, 10, 15 or 30)
const SNAPSHOT_MAX_AGE = 30 * 60 * 1000;      // older than this, the trigger has stopped: rebuild on demand
const SNAPSHOT_BUILDING = 'snapshot:building';
let snapshotMemo_ = null;                     // one read per execution

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
  paymentMethod: 'طريقة السداد',
  advancePayment: 'الدفعة المقدمة',
  weeklyPayment: 'الدفعة الأسبوعية',
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
  deliveryStatus: 'حالة التسليم',
  deliveryDue: 'موعد التسليم المخطط',
  deliveryAt: 'تاريخ التسليم الفعلي',
  deliveryReason: 'سبب تأخير التسليم',
  deliveryNote: 'ملاحظات التسليم',
  deliveryBy: 'محدّث التسليم',
  deliveryUpdatedAt: 'وقت تحديث التسليم',
  actualAmount: 'القيمة الفعلية',
  actualNote: 'سبب اختلاف القيمة',
  actualBy: 'محدّث القيمة الفعلية',
  actualAt: 'وقت تحديث القيمة الفعلية',
};
// Reverse lookup built once: rowToObject_ runs for every cell of every row.
const FIELD_BY_HEADER = Object.keys(COLUMNS).reduce(function (map, f) {
  map[COLUMNS[f]] = f;
  return map;
}, Object.create(null));
const USER_COLUMNS = {
  username: 'اسم المستخدم', name: 'الاسم', role: 'الصلاحية', active: 'مفعّل',
  warehouses: 'المخازن', hash: 'كلمة السر (مشفرة)', salt: 'Salt',
  permissions: 'الصلاحيات',
};

const PROMISE_TAB = 'وعود السداد';
const PROMISE_ID_PREFIX = 'PRM';
const PROMISE_STATUS = { open: 'قائم', kept: 'تم الوفاء', broken: 'أخلف', cancelled: 'ملغي' };
const PROMISE_STATUS_LIST = [
  PROMISE_STATUS.open, PROMISE_STATUS.kept, PROMISE_STATUS.broken, PROMISE_STATUS.cancelled,
];
const PROMISE_COLUMNS = {
  id: 'رقم الوعد', account: 'كود العميل', customer: 'اسم العميل', warehouse: 'Warehouse Group',
  amount: 'المبلغ الموعود', due: 'تاريخ الوعد', status: 'حالة الوعد', owner: 'المسؤول',
  requestId: 'رقم الطلب',
  note: 'ملاحظة', createdAt: 'تاريخ الإنشاء', createdBy: 'أنشأه', updatedAt: 'آخر تحديث', updatedBy: 'حدّثه',
};

const PLANS_COLUMNS = {
  name: 'طريقة السداد',
  count: 'عدد الفعات',
  daysPerInstallment: 'عدد الايام لكل دفعه',
  advancePercent: 'نسبة الدفعه المقدمه',
  note: 'ملاحظات',
};

function doGet() {
  return json_({ ok: true, build: BUILD });
}

function doPost(e) {
  try {
    snapshotMemo_ = null;
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
    case 'ping': {
      const meta = snapshotMeta_();
      return { rules: rules_(), dataAt: meta ? meta.builtAt : 0 };
    }
    case 'data': return data_(who);
    case 'plans': return { plans: paymentPlans_() };
    case 'list': return { requests: scopedRequests_(who) };
    case 'promises': return { promises: scopedPromises_(who).map(promiseView_) };
    case 'savePromise': return locked_(function () { return { promise: savePromise_(req, who) }; });
    case 'add': return add_(req, who);
    case 'edit': return { request: edit_(req, who) };
    case 'recheck': return { check: recheck_(req, who) };
    case 'decide': return { request: decide_(req, who) };
    case 'deliver': return { request: deliver_(req, who) };
    case 'changePassword': return changePassword_(req, who);
    case 'users': requireAdmin_(who); return { users: usersList_() };
    case 'audit': requireAdmin_(who); return { audit: auditList_(req) };
    case 'userSave': requireAdmin_(who); return { users: locked_(function () { return userSave_(req, who); }) };
    case 'setRules': requireAdmin_(who); return { rules: locked_(function () { return setRules_(req, who); }) };
    case 'refresh': requireAdmin_(who); return refresh_(who);
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
  if (!hasPerm_(who, PERM.admin)) throw new Error('هذه العملية تتطلب صلاحية إدارة النظام.');
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
  return {
    username: BREAK_GLASS, name: 'المدير', role: ROLE_ADMIN, warehouses: [], active: true,
    permissions: PERM_LIST.slice(),
  };
}

function publicName_(who) { return who.username === BREAK_GLASS ? 'المدير (admin)' : who.name; }

function publicUser_(who) {
  return {
    username: who.username === BREAK_GLASS ? 'admin' : who.username,
    name: who.name, role: who.role, warehouses: who.warehouses,
    permissions: who.permissions || [],
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
      // The permissions column wins. An older row without it keeps the role
      // it already had, so nothing changes until the admin edits that user.
      const saved = parsePermissions_(r[at('permissions')]);
      const permissions = saved === null ? rolePermissions_(role) : normalizePermissions_(saved);
      out[k] = {
        username: k, name: text_(r[at('name')]) || k, role: roleForPermissions_(permissions),
        permissions: permissions,
        active: isYes_(r[at('active')]), warehouses: parseWarehouses_(r[at('warehouses')]),
        hash: text_(r[at('hash')]), salt: text_(r[at('salt')]), row: i + 2,
      };
    });
  }
  try { cache.put(USERS_CACHE, JSON.stringify(out), USERS_TTL); } catch (e) { /* the cache is optional */ }
  return out;
}

// null means the cell is empty, so the role decides.
function parsePermissions_(v) {
  const s = text_(v);
  if (!s) return null;
  const parts = s.split(/[،,]/).map(text_).filter(Boolean);
  return PERM_LIST.filter(function (p) { return parts.indexOf(p) >= 0; });
}

// «إدارة النظام» carries every other permission, so it is stored expanded.
function normalizePermissions_(list) {
  if (list.indexOf(PERM.admin) >= 0) return PERM_LIST.slice();
  return PERM_LIST.filter(function (p) { return list.indexOf(p) >= 0; });
}

function rolePermissions_(role) {
  if (role === ROLE_ADMIN) return PERM_LIST.slice();
  if (role === ROLE_APPROVER) return [PERM.add, PERM.approve, PERM.deliver];
  if (role === ROLE_DELIVERY) return [PERM.deliver];
  if (role === ROLE_COLLECTOR) return [PERM.collect];
  if (role === ROLE_VIEWER || role === ROLE_CUSTOM) return [];
  return [PERM.add];
}

// The role column stays as a readable label for the permission set.
function roleForPermissions_(list) {
  if (list.indexOf(PERM.admin) >= 0) return ROLE_ADMIN;
  const set = PERM_LIST.filter(function (p) { return list.indexOf(p) >= 0; });
  const key = set.join('|');
  if (!key) return ROLE_VIEWER;
  if (key === [PERM.add].join('|')) return ROLE_USER;
  if (key === [PERM.deliver].join('|')) return ROLE_DELIVERY;
  if (key === [PERM.collect].join('|')) return ROLE_COLLECTOR;
  if (key === [PERM.add, PERM.approve, PERM.deliver].join('|')) return ROLE_APPROVER;
  return ROLE_CUSTOM;
}

function hasPerm_(who, p) {
  if (!who) return false;
  if (who.username === BREAK_GLASS) return true;
  const list = who.permissions || [];
  return list.indexOf(p) >= 0 || list.indexOf(PERM.admin) >= 0;
}

function clearUsersCache_() { CacheService.getScriptCache().remove(USERS_CACHE); }

// A manual edit of the users tab (stopping someone, changing a role) applies at once.
function onEdit(e) {
  if (!e || !e.range) return;
  const name = e.range.getSheet().getName();
  if (name === USERS_SHEET) clearUsersCache_();
  if (name === PLANS_TAB || name === PLANS_FALLBACK_TAB) {
    try { CacheService.getScriptCache().remove(PLANS_CACHE); } catch (err) { /* optional */ }
  }
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
    return {
      username: u.username, name: u.name, role: u.role, permissions: u.permissions,
      active: u.active, warehouses: u.warehouses,
    };
  });
}

// A request may carry an explicit permission list. An older client that sends
// only a role still works, and that role seeds the same permissions as before.
function requestedPermissions_(req) {
  if (Array.isArray(req.permissions) || typeof req.permissions === 'string') {
    const raw = Array.isArray(req.permissions) ? req.permissions : String(req.permissions).split(/[،,]/);
    const list = raw.map(text_).filter(Boolean);
    list.forEach(function (p) {
      if (PERM_LIST.indexOf(p) < 0) throw new Error('صلاحية غير معروفة: ' + p);
    });
    return normalizePermissions_(list);
  }
  if (ROLES.indexOf(req.role) < 0) throw new Error('الصلاحية يجب أن تكون: ' + ROLES.join(' أو '));
  return rolePermissions_(req.role);
}

function userSave_(req, who) {
  const k = normUser_(req.username);
  if (!/^[a-z0-9._-]{3,30}$/.test(k)) throw new Error('اسم المستخدم من 3 إلى 30 حرفًا إنجليزيًا أو رقمًا، بدون مسافات.');
  if (k === 'admin') throw new Error('اسم المستخدم admin محجوز للدخول الاحتياطي.');
  const permissions = requestedPermissions_(req);
  const role = roleForPermissions_(permissions);
  const pass = String(req.password || '');
  if (pass && pass.length < MIN_PASSWORD) throw new Error('كلمة المرور يجب ألا تقل عن ' + MIN_PASSWORD + ' أحرف.');
  if (k === who.username && (req.active === false || permissions.indexOf(PERM.admin) < 0)) {
    throw new Error('لا يمكنك إيقاف حسابك أو إزالة صلاحية إدارة النظام من نفسك.');
  }
  clearUsersCache_();
  const existing = users_()[k];
  if (!existing && !pass) throw new Error('المستخدم الجديد يحتاج كلمة مرور.');
  // Never leave the system without an active administrator.
  if (existing && existing.active && hasPerm_(existing, PERM.admin)
    && (permissions.indexOf(PERM.admin) < 0 || req.active === false)) {
    const others = Object.keys(users_()).filter(function (x) {
      return x !== k && users_()[x].active && hasPerm_(users_()[x], PERM.admin);
    });
    if (!others.length) throw new Error('لا يمكن إزالة صلاحية إدارة النظام من آخر مدير مفعّل.');
  }
  const sh = usersSheet_();
  const headers = headers_(sh);
  const list = (Array.isArray(req.warehouses) ? req.warehouses : []).map(text_).filter(Boolean);
  const fields = {
    username: k, name: safe_(req.name) || k, role: role, active: req.active !== false,
    permissions: permissions.length ? permissions.join('، ') : '',
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
    k + ' · ' + (permissions.length ? permissions.join('، ') : 'عرض فقط')
    + ' · ' + fields.warehouses + (fields.active ? '' : ' · متوقف') + (pass ? ' · كلمة مرور جديدة' : ''));
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

function readChecks_() {
  if (!CHECKS_SHEET_ID) return null;
  const mine = function (code) { return !!code; };
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

// The checks tabs from the snapshot, cut to the accounts in scope.
function checksOf_(snap, mine) {
  if (!snap.checks) return null;
  const cut = function (rows) {
    if (!rows) return null;
    const code = rows[0].findIndex(function (h) { return text_(h) === 'كود العميل' || text_(h).slice(-' كود العميل'.length) === ' كود العميل'; });
    return [rows[0]].concat(rows.slice(1).filter(function (r) { return mine(text_(r[code])); }));
  };
  return { main: cut(snap.checks.main), wh: cut(snap.checks.wh) };
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
  const snap = snapshot_();
  const base = snap.base, tx = snap.tx, analysisDay = snap.analysisDay;
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
  return {
    base: baseOut, tx: txOut, analysisDay: analysisDay, builtAt: snap.builtAt,
    checks: checksOf_(snap, mine), checksError: snap.checksError || '',
  };
}

/* ---- the data snapshot ---- */

// The settings it was built from: changing a sheet id or tab name rebuilds it.
function snapshotSource_() {
  return [SOURCE_SHEET_ID, BASE_TAB, TX_TAB, CHECKS_SHEET_ID, CHECKS_TAB, CHECKS_WH_TAB].join('|');
}

function snapshotMeta_() {
  return JSON.parse(PropertiesService.getScriptProperties().getProperty(SNAPSHOT_KEY) || 'null');
}

/** snapshot_ - the source data: the saved snapshot while fresh, else a new one. */
function snapshot_() {
  if (snapshotMemo_) return snapshotMemo_;
  const meta = snapshotMeta_();
  const usable = meta && meta.source === snapshotSource_();
  const fresh = usable && Date.now() - meta.builtAt < SNAPSHOT_MAX_AGE;
  // While another request rebuilds it, a stale snapshot is better than a second build.
  const building = usable && CacheService.getScriptCache().get(SNAPSHOT_BUILDING);
  if (fresh || building) {
    try {
      snapshotMemo_ = readSnapshotFile_(meta);
      return snapshotMemo_;
    } catch (e) {
      console.warn('snapshot not read, rebuilding: ' + e.message);
    }
  }
  return buildSnapshot_();
}

function buildSnapshot_() {
  const cache = CacheService.getScriptCache();
  cache.put(SNAPSHOT_BUILDING, '1', 5 * 60);
  try {
    const started = Date.now();
    const book = sourceBook_();
    const base = sourceRows_(book, BASE_TAB, Engine.BASE_COLS);
    const tx = sourceRows_(book, TX_TAB, Engine.TX_COLS);
    // The screens still work without the checks; a request is refused (see evaluate_).
    let checks = null, checksError = '';
    try {
      checks = readChecks_();
    } catch (e) {
      checksError = e.message;
    }
    const snap = {
      builtAt: Date.now(), base: base, tx: tx, checks: checks, checksError: checksError,
      analysisDay: Engine.lastMovementDay(tx), buildMs: 0,
    };
    snap.buildMs = Date.now() - started;
    saveSnapshotFile_(snap);
    // Without the trigger the data still works: it is rebuilt on demand every 30 minutes.
    try {
      ensureTrigger_();
    } catch (e) {
      snap.triggerError = 'لم يُنشأ مؤقت التجهيز التلقائي، فستُجهَّز البيانات عند الطلب كل 30 دقيقة. ' +
        'شغّل refreshSnapshot مرة من محرر السكربت ووافق على الصلاحيات. (' + e.message + ')';
      console.warn(snap.triggerError);
    }
    snapshotMemo_ = snap;
    return snap;
  } finally {
    cache.remove(SNAPSHOT_BUILDING);
  }
}

function saveSnapshotFile_(snap) {
  const zipped = Utilities.gzip(Utilities.newBlob(JSON.stringify(snap), 'application/json', 'snapshot.json'));
  const text = Utilities.base64Encode(zipped.getBytes());
  const meta = snapshotMeta_();
  let file = null;
  if (meta && meta.fileId) {
    try {
      file = DriveApp.getFileById(meta.fileId);
      if (file.isTrashed()) file = null;
    } catch (e) {
      file = null;  // deleted by hand: a new one is made
    }
  }
  if (file) file.setContent(text);
  else file = DriveApp.createFile(SNAPSHOT_NAME, text, MimeType.PLAIN_TEXT);
  PropertiesService.getScriptProperties().setProperty(SNAPSHOT_KEY, JSON.stringify({
    fileId: file.getId(), builtAt: snap.builtAt, buildMs: snap.buildMs, source: snapshotSource_(), size: text.length,
  }));
}

function readSnapshotFile_(meta) {
  const text = DriveApp.getFileById(meta.fileId).getBlob().getDataAsString();
  const blob = Utilities.newBlob(Utilities.base64Decode(text), 'application/x-gzip', 'snapshot.json.gz');
  return JSON.parse(Utilities.ungzip(blob).getDataAsString());
}

// The time trigger that keeps the snapshot fresh, made once.
function ensureTrigger_() {
  const has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'refreshSnapshot'; });
  if (!has) ScriptApp.newTrigger('refreshSnapshot').timeBased().everyMinutes(SNAPSHOT_MINUTES).create();
}

/** refreshSnapshot - run by the time trigger. Can also be run once from the editor. */
function refreshSnapshot() {
  snapshotMemo_ = null;
  buildSnapshot_();
}

function refresh_(who) {
  snapshotMemo_ = null;
  try { CacheService.getScriptCache().remove(PLANS_CACHE); } catch (e) { /* optional */ }
  const snap = buildSnapshot_();
  audit_(publicName_(who), 'تجهيز نسخة البيانات', Math.round(snap.buildMs / 1000) + ' ثانية');
  return { builtAt: snap.builtAt, buildMs: snap.buildMs, checksError: snap.checksError, triggerError: snap.triggerError || '' };
}

function data_(who) {
  const started = Date.now();
  const sheets = scopedSheets_(who, '');
  const checks = sheets.checks;
  return {
    base: sheets.base, tx: sheets.tx, analysisDay: sheets.analysisDay, rules: rules_(), checks: checks, checksError: sheets.checksError,
    dataAt: sheets.builtAt,
    stats: {
      ms: Date.now() - started, customers: sheets.base.length - 1, movements: sheets.tx.length - 1,
      checks: checks ? checks.main.length - 1 + (checks.wh ? checks.wh.length - 1 : 0) : 0,
    },
  };
}

/* ---- payment plans (optional reference sheet) ---- */

// The plan sheet may live in the customer workbook or the requests workbook.
// If it is somewhere else, set PLANS_SHEET_ID in the settings above.
function plansSheet_() {
  const books = [];
  if (PLANS_SHEET_ID) {
    try { books.push(SpreadsheetApp.openById(PLANS_SHEET_ID)); } catch (e) { return null; }
  } else {
    try { books.push(sourceBook_()); } catch (e) { /* no customer link */ }
    try { 
      const rb = requestsBook_();
      books.push(rb);
      // Try to create the sheet if it doesn't exist
      try { ensureSheet_(rb, PLANS_TAB, PLANS_COLUMNS); } catch (e) { /* ignore */ }
    } catch (e) { /* not linked */ }
  }
  for (let b = 0; b < books.length; b++) {
    const tabs = books[b].getSheets();
    for (let t = 0; t < tabs.length; t++) {
      const name = text_(tabs[t].getName());
      if (name === PLANS_TAB || name === PLANS_FALLBACK_TAB) return tabs[t];
    }
  }
  return null;
}

/**
 * paymentPlans_ - the optional «طرق السداد» reference: one row per plan.
 * It accepts the PaymantSchedual columns (PaymentSchedule, weekNum,
 * PayQuantity, Days, 25%Start) and Arabic equivalents. A missing sheet is
 * normal: the two payment fields are then typed by hand.
 */
function paymentPlans_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(PLANS_CACHE);
  if (hit) return JSON.parse(hit);
  const sh = plansSheet_();
  if (!sh) {
    try { cache.put(PLANS_CACHE, '[]', PLANS_TTL); } catch (e) { /* optional */ }
    return [];
  }
  const values = sh.getDataRange().getValues();
  if (!values.length) return [];
  const rawHead = values[0].map(text_);
  const head = rawHead.map(normHeader_);
  const at = function (aliases) {
    const want = aliases.map(normHeader_);
    return head.findIndex(function (h) { return want.indexOf(h) >= 0; });
  };
  const nameCol = at(['PaymentSchedule', 'طريقة السداد', 'طرق السداد', 'الخطة', 'خطة السداد', 'Name', 'Plan']);
  if (nameCol < 0) return [];
  const weeksCol = at(['weekNum', 'عدد الأسابيع', 'الأسابيع', 'Weeks']);
  const countCol = at(['PayQuantity', 'عدد الفعات', 'عدد الدفعات', 'عددالفعات', 'الدفعات', 'عدد الأقساط', 'Payments', 'Installments']);
  const daysCol = at(['Days', 'عدد الايام لكل دفعه', 'عدد الأيام لكل دفعة', 'الأيام', 'أيام', 'Period', 'PeriodDays']);
  const startCol = at(['25%Start', 'Start', 'StartPercent', 'نسبة الدفعه المقدمه', 'نسبة الدفعة المقدمة', 'نسبة المقدمة']);
  const advanceCol = at(['AdvancePayment', 'مبلغ المقدمة', 'قيمة المقدمة', 'الدفعة المقدمة', 'DownPayment']);
  const weeklyCol = at(['WeeklyPayment', 'الدفعة الأسبوعية', 'القسط الأسبوعي', 'مبلغ الأسبوع']);
  const noteCol = at(['ملاحظات', 'Note', 'Notes']);
  const plans = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const name = text_(row[nameCol]);
    if (!name) continue;
    const advRaw = advanceCol >= 0 ? text_(row[advanceCol]) : '';
    const weekRaw = weeklyCol >= 0 ? text_(row[weeklyCol]) : '';
    const advPct = advanceCol >= 0 && isPercentHeader_(rawHead[advanceCol]) || /[%٪]/.test(advRaw);
    const weekPct = weeklyCol >= 0 && isPercentHeader_(rawHead[weeklyCol]) || /[%٪]/.test(weekRaw);
    plans.push({
      name: name,
      weeks: planNumber_(weeksCol >= 0 ? row[weeksCol] : ''),
      count: planNumber_(countCol >= 0 ? row[countCol] : ''),
      days: planNumber_(daysCol >= 0 ? row[daysCol] : ''),
      startPercent: percent_(startCol >= 0 ? row[startCol] : ''),
      advance: advPct ? 0 : planNumber_(advRaw),
      advancePercent: advPct ? percent_(advRaw) : 0,
      weekly: weekPct ? 0 : planNumber_(weekRaw),
      weeklyPercent: weekPct ? percent_(weekRaw) : 0,
      note: noteCol >= 0 ? text_(row[noteCol]) : '',
    });
  }
  try { cache.put(PLANS_CACHE, JSON.stringify(plans), PLANS_TTL); } catch (e) { /* optional */ }
  return plans;
}

// Header matching ignores spaces, dashes, hamza forms and the percent sign.
function normHeader_(s) {
  return text_(s).toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[٪%]/g, '')
    .replace(/[\s_\-()]+/g, '');
}

function isPercentHeader_(h) {
  return /[%٪]|نسب/.test(text_(h)) || normHeader_(h).indexOf('percent') >= 0;
}

// Arabic digits and separators are accepted, as the sheet may format them.
function planNumber_(v) {
  const s = text_(v)
    .replace(/[٠-٩]/g, function (d) { return String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)); })
    .replace(/[,\s٬]/g, '')
    .replace(/[٪%]/g, '')
    .replace(/٫/g, '.');
  if (!s) return 0;
  const n = Number(s);
  return isFinite(n) ? n : 0;
}

// A percentage may arrive as 25%, 0.25 or 25.
function percent_(v) {
  const s = text_(v);
  if (!s) return 0;
  const n = planNumber_(s);
  if (!n) return 0;
  return /[%٪]/.test(s) || n <= 1 ? Math.round(n * 10000) / 100 : n;
}

// An optional money figure: empty stays empty, otherwise a non-negative number.
function optionalMoney_(v, label) {
  const s = text_(v)
    .replace(/[٠-٩]/g, function (d) { return String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)); })
    .replace(/[,\s٬]/g, '')
    .replace(/٫/g, '.');
  if (!s) return '';
  const n = Number(s);
  if (!isFinite(n)) throw new Error(label + ' يجب أن تكون رقمًا.');
  if (n < 0) throw new Error(label + ' لا تكون سالبة.');
  return Math.round(n * 100) / 100;
}

/* ---- the check, computed here so a browser cannot change its result ---- */

// Only the fields the check reads: invoices and aging can be large, and the
// cache must stay well under its value limit for a customer with many invoices.
function slimCustomer_(c) {
  return {
    account: c.account, name: c.name, rep: c.rep, idNumber: c.idNumber, warehouse: c.warehouse, group: c.group,
    terms: c.terms, balance: c.balance, creditLimit: c.creditLimit, guarantee: c.guarantee, exposure: c.exposure,
    availableCredit: c.availableCredit, overdue: c.overdue, oldestOverdueDays: c.oldestOverdueDays,
    stopped: c.stopped, hasChecks: c.hasChecks,
    checksOpen: c.checksOpen, checksOpenCount: c.checksOpenCount, checksDue: c.checksDue,
    checksDueCount: c.checksDueCount, checksRejected: c.checksRejected, checksRejectedCount: c.checksRejectedCount,
  };
}

function evaluate_(who, account, amount, advancePayment) {
  const rules = rules_();
  const cache = CacheService.getScriptCache();
  // The scope and rules are part of the key, so two users never share a
  // customer they may not see, and changing the rules invalidates the result.
  // A new snapshot changes the key too, so a result never outlives its data.
  const meta = snapshotMeta_();
  const key = EVAL_CACHE + ':' + sha_(account + '|' + who.warehouses.join(',') + '|' + JSON.stringify(rules) + '|' + (meta ? meta.builtAt : ''));
  let c = null, analysisDay = 0;
  const hit = cache.get(key);
  if (hit) {
    try {
      const packed = JSON.parse(hit);
      c = packed.c;
      analysisDay = packed.day;
    } catch (e) {
      c = null;
    }
  }
  if (!c) {
    const sheets = scopedSheets_(who, account);
    if (sheets.base.length < 2) throw new Error('العميل غير موجود في قاعدة العملاء أو خارج نطاق مخازنك: ' + account);
    // Unlike the screens, a request is never checked without the checks: a failure stops it.
    if (sheets.checksError) throw new Error(sheets.checksError);
    const plans = typeof paymentPlans_ === 'function' ? paymentPlans_() : [];
    c = Engine.analyze(sheets.base, sheets.tx, rules, sheets.analysisDay, sheets.checks, plans).customers[0];
    analysisDay = sheets.analysisDay;
    try { cache.put(key, JSON.stringify({ c: slimCustomer_(c), day: analysisDay }), EVAL_TTL); } catch (e) { /* the cache is optional */ }
  }
  const result = Engine.evaluateNew(c, amount, rules);
  // Apply down payment business rules
  const verdict = applyDownPaymentRules_(result, c, advancePayment);
  const reasons = Object.keys(result.checks)
    .map(function (k) { return result.checks[k]; })
    .filter(function (x) { return x.level !== 'ok'; })
    .map(function (x) { return x.label; }).join('، ');
  return {
    account: c.account, customer: c.name, rep: c.rep, idNumber: c.idNumber, warehouse: c.warehouse, group: c.group,
    terms: c.terms,
    amount: amount, balance: c.balance, balanceAfter: result.balanceAfter, creditLimit: c.creditLimit, guarantee: c.guarantee,
    uncovered: result.uncovered, overdue: c.overdue, oldestDays: c.oldestOverdueDays,
    checksOpen: c.checksOpen, checksDue: c.checksDue, checksRejected: c.checksRejected, exposureAfter: result.exposureAfter,
    dataDate: Utilities.formatDate(new Date(analysisDay * 86400000), 'UTC', 'yyyy-MM-dd'),
    dataAt: meta ? meta.builtAt : 0,
    verdict: verdict, verdictLabel: VERDICTS[verdict], reasons: reasons,
  };
}

function applyDownPaymentRules_(result, customer, advancePayment) {
  let verdict = result.verdict;
  const { creditLimit, balance, guarantee, overdue } = customer;
  // Calculate the risk gap: credit limit excess + overdue amount
  const creditExcess = Math.max(0, (balance || 0) - creditLimit);
  const riskGap = creditExcess + (overdue || 0);
  // If advance payment is provided, apply business rules
  if (advancePayment !== '' && advancePayment != null) {
    const advance = Number(advancePayment);
    // Rule 1: Down payment covers risk gap + has guarantee → auto-approved
    if (advance >= riskGap && guarantee > 0) {
      verdict = 'ok';
    }
    // Rule 2: Down payment covers risk gap but no guarantee → needs approval
    else if (advance >= riskGap && guarantee === 0) {
      verdict = 'warn';
    }
  }
  // Rule 3: Customer has no overdue AND no guarantee → needs approval
  // Unless already auto-approved by Rule 1 (down payment + guarantee)
  if (overdue === 0 && guarantee === 0 && verdict !== 'ok') {
    verdict = 'warn';
  }
  return verdict;
}

/* ---- requests ---- */

function add_(req, who) {
  if (!hasPerm_(who, PERM.add)) throw new Error('لا تملك صلاحية تسجيل الطلبات.');
  const account = text_(req.account);
  const amount = Number(req.amount);
  if (!account) throw new Error('كود العميل مطلوب.');
  if (!(amount > 0)) throw new Error('قيمة الفاتورة يجب أن تكون أكبر من صفر.');
  const paymentMethod = safe_(req.paymentMethod);
  const advance = optionalMoney_(req.advance, 'الدفعة المقدمة');
  const weekly = optionalMoney_(req.weekly, 'الدفعة الأسبوعية');
  if (advance !== '' && advance > amount) throw new Error('الدفعة المقدمة لا تزيد عن قيمة الفاتورة.');
  if (weekly !== '' && weekly > amount) throw new Error('الدفعة الأسبوعية لا تزيد عن قيمة الفاتورة.');
  // Reading the customer sheets is slow, so it stays outside the lock.
  const check = evaluate_(who, account, amount, advance);
  return locked_(function () {
    const sh = requestsSheet_();
    const all = readAll_(sh);
    // A retried send must not create a second request.
    const ref = text_(req.ref);
    // A retry belongs to the same requester and customer in their scope; another
    // user's ref must never bring back a request they may not see.
    const requesterUser = who.username === BREAK_GLASS ? 'admin' : who.username;
    const again = ref && all.filter(function (r) {
      return text_(r.ref) === ref && text_(r.account) === account
        && normUser_(r.requesterUser) === requesterUser && inScope_(who, r.warehouse);
    })[0];
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
    row.requesterUser = requesterUser;
    row.note = safe_(req.note);
    row.paymentMethod = paymentMethod;
    row.advancePayment = advance;
    row.weeklyPayment = weekly;
    row.ref = safe_(ref);
    // A clean check needs no approver; anything else waits for one.
    row.status = check.verdict === 'ok' ? STATUS.clear : STATUS.pending;
    // Approved work starts physically in the warehouse until the delivery clerk moves it.
    row.deliveryStatus = check.verdict === 'ok' ? DELIVERY.warehouse : '';
    const headers = headers_(sh);
    sh.appendRow(headers.map(function (h) {
      const f = fieldOf_(h);
      return f ? row[f] : '';
    }));
    audit_(publicName_(who), 'تسجيل طلب', row.id + ' · ' + row.customer + ' · ' + row.amount + ' · ' + row.verdict);
    return { request: row };
  });
}

/**
 * edit_ - the agreement may change after a rejection, so a pending or rejected
 * request can be amended and sent back for approval. The script recomputes the
 * check with the new amount; an approved request is never changed here.
 */
function edit_(req, who) {
  if (!hasPerm_(who, PERM.add)) throw new Error('تعديل الطلب يتطلب صلاحية تسجيل الطلبات.');
  const r = findRequest_(who, req.id);
  const current = text_(r.status);
  if (current !== STATUS.pending && current !== STATUS.rejected) {
    throw new Error('لا يمكن تعديل طلب حالته: ' + current + '.');
  }
  const account = text_(r.account);
  const amount = Number(req.amount);
  if (!account) throw new Error('كود العميل غير موجود في الطلب.');
  if (!(amount > 0)) throw new Error('قيمة الفاتورة يجب أن تكون أكبر من صفر.');
  const note = safe_(req.note);
  const paymentMethod = safe_(req.paymentMethod);
  const advance = optionalMoney_(req.advance, 'الدفعة المقدمة');
  const weekly = optionalMoney_(req.weekly, 'الدفعة الأسبوعية');
  if (advance !== '' && advance > amount) throw new Error('الدفعة المقدمة لا تزيد عن قيمة الفاتورة.');
  if (weekly !== '' && weekly > amount) throw new Error('الدفعة الأسبوعية لا تزيد عن قيمة الفاتورة.');
  // The check always follows the amount, so the approver sees the new figure.
  const check = evaluate_(who, account, amount, advance);
  return locked_(function () {
    const sh = requestsSheet_();
    const headers = headers_(sh);
    const lastRow = sh.getLastRow();
    const values = lastRow < 2 ? [] : sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
    const idCol = headers.indexOf(COLUMNS.id);
    const at = values.findIndex(function (v) { return text_(v[idCol]) === text_(req.id); });
    if (at < 0) throw new Error('الطلب غير موجود: ' + text_(req.id));
    const statusCol = headers.indexOf(COLUMNS.status);
    const beforeStatus = text_(values[at][statusCol]);
    if (beforeStatus !== STATUS.pending && beforeStatus !== STATUS.rejected) {
      throw new Error('لا يمكن تعديل طلب حالته: ' + beforeStatus + '.');
    }
    const row = values[at].slice();
    // Only these cells are written, so formulas in the user's own columns stay.
    const put = function (field, value) {
      const col = headers.indexOf(COLUMNS[field]);
      sh.getRange(at + 2, col + 1).setValue(value);
      row[col] = value;
    };
    ['amount', 'balance', 'balanceAfter', 'creditLimit', 'guarantee', 'uncovered', 'overdue', 'oldestDays',
      'checksOpen', 'checksDue', 'checksRejected', 'exposureAfter'].forEach(function (f) { put(f, check[f]); });
    ['dataDate', 'verdict', 'reasons'].forEach(function (f) { put(f, safe_(check[f])); });
    put('note', note);
    put('paymentMethod', paymentMethod);
    put('advancePayment', advance);
    put('weeklyPayment', weekly);
    // A rejected request goes back to the queue. A clean check needs no approver.
    const nextStatus = check.verdict === 'ok' ? STATUS.clear : STATUS.pending;
    put('status', nextStatus);
    put('approver', '');
    put('decidedAt', '');
    put('decisionNote', '');
    put('verdictAtDecision', '');
    put('deliveryStatus', nextStatus === STATUS.clear ? DELIVERY.warehouse : '');
    audit_(publicName_(who), 'تعديل طلب',
      text_(req.id) + ' · ' + text_(r.customer) + ' · ' + Number(r.amount) + ' → ' + amount
      + ' · ' + beforeStatus + ' → ' + nextStatus
      + (paymentMethod ? ' · ' + paymentMethod : '')
      + (advance !== '' ? ' · مقدمة ' + advance : '')
      + (weekly !== '' ? ' · أسبوعي ' + weekly : ''));
    return rowToObject_(headers, row);
  });
}

function scopedRequests_(who) {
  return readAll_(requestsSheet_()).filter(function (r) { return inScope_(who, r.warehouse); });
}

/* ---- payment promises ---- */

function promisesSheet_() {
  return ensureSheet_(requestsBook_(), PROMISE_TAB, PROMISE_COLUMNS);
}


function plansSheetEnsure_() {
  try {
    const book = requestsBook_();
    return ensureSheet_(book, PLANS_TAB, PLANS_COLUMNS);
  } catch (e) {
    return null;
  }
}

function promiseField_(header) {
  return Object.keys(PROMISE_COLUMNS).filter(function (f) { return PROMISE_COLUMNS[f] === header; })[0];
}

function promiseView_(p) {
  const out = Object.assign({}, p);
  delete out.row;
  return out;
}

function cellDate_(v) {
  return isDate_(v) ? formatDate_(v).slice(0, 10) : text_(v).slice(0, 10);
}

function readPromises_() {
  const sh = promisesSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const headers = headers_(sh);
  const at = {};
  Object.keys(PROMISE_COLUMNS).forEach(function (f) { at[f] = headers.indexOf(PROMISE_COLUMNS[f]); });
  return sh.getRange(2, 1, last - 1, headers.length).getValues().map(function (v, i) {
    const p = { row: i + 2 };
    Object.keys(PROMISE_COLUMNS).forEach(function (f) {
      p[f] = f === 'due' ? cellDate_(v[at[f]]) : text_(v[at[f]]);
    });
    p.amount = Number(p.amount) || 0;
    if (!p.status) p.status = PROMISE_STATUS.open;
    return p;
  }).filter(function (p) { return p.id; });
}

function scopedPromises_(who) {
  return readPromises_()
    .filter(function (p) { return inScope_(who, p.warehouse); })
    .sort(function (a, b) { return a.due.localeCompare(b.due) || a.id.localeCompare(b.id); });
}

function nextPromiseId_(all) {
  const max = all.reduce(function (m, p) {
    const n = parseInt(String(p.id).replace(PROMISE_ID_PREFIX, ''), 10);
    return n > m ? n : m;
  }, 0);
  return PROMISE_ID_PREFIX + String(max + 1).padStart(ID_DIGITS, '0');
}

/**
 * promiseRequest_ - checks the request a promise names. The link is a label on
 * the promise and nothing else: it changes no balance, verdict, delivery status
 * or promise status, in either direction.
 */
function promiseRequest_(who, id, account) {
  const wanted = text_(id);
  const found = readAll_(requestsSheet_()).filter(function (r) {
    return text_(r.id) === wanted && inScope_(who, r.warehouse);
  })[0];
  if (!found) throw new Error('الطلب غير موجود أو خارج نطاق مخازنك: ' + wanted);
  if (text_(found.account) !== text_(account)) throw new Error('الطلب ' + wanted + ' يخص عميلًا آخر، فلا يُربط بهذا الوعد.');
  return wanted;
}

function promiseAmount_(v) {
  const s = text_(v).replace(/,/g, '');
  const n = Number(s);
  if (!s || !isFinite(n) || n <= 0) throw new Error('المبلغ الموعود يجب أن يكون أكبر من صفر.');
  return Math.round(n * 100) / 100;
}

function promiseCustomer_(who, account) {
  const code = text_(account);
  if (!code) throw new Error('كود العميل مطلوب.');
  const sheets = scopedSheets_(who, code);
  if (sheets.base.length < 2) throw new Error('العميل غير موجود أو خارج نطاق مخازنك: ' + code);
  const plans = typeof paymentPlans_ === 'function' ? paymentPlans_() : [];
  const c = Engine.analyze(sheets.base, sheets.tx, rules_(), sheets.analysisDay, sheets.checks, plans).customers[0];
  if (!c) throw new Error('العميل غير موجود أو خارج نطاق مخازنك: ' + code);
  return c;
}

/**
 * savePromise_ - records a collection promise or updates its amount, date and
 * status. The customer and warehouse are fixed after creation, so a promise
 * cannot move to another customer's file by a stale browser payload.
 */
function savePromise_(req, who) {
  if (!hasPerm_(who, PERM.collect)) throw new Error('تسجيل وعود السداد يتطلب صلاحية متابعة التحصيل.');
  const id = text_(req.id);
  const amount = promiseAmount_(req.amount);
  const due = dateOnly_(req.due);
  if (!due) throw new Error('تاريخ الوعد مطلوب.');
  const status = text_(req.status) || PROMISE_STATUS.open;
  if (PROMISE_STATUS_LIST.indexOf(status) < 0) throw new Error('حالة الوعد غير معروفة: ' + status);
  const note = safe_(req.note);
  const sh = promisesSheet_();
  const all = readPromises_();
  const existing = id ? all.filter(function (p) { return text_(p.id) === id; })[0] : null;
  if (id && !existing) throw new Error('وعد السداد غير موجود: ' + id);
  if (existing && !inScope_(who, existing.warehouse)) throw new Error('وعد السداد خارج نطاق مخازنك: ' + id);

  let account, customer, warehouse;
  // The request link is set at creation and stays fixed, like the customer.
  let requestId = '';
  if (existing) {
    account = existing.account;
    customer = existing.customer;
    warehouse = existing.warehouse;
    requestId = text_(existing.requestId);
  } else {
    const c = promiseCustomer_(who, req.account);
    account = c.account;
    customer = c.name;
    warehouse = c.warehouse;
    if (text_(req.requestId)) requestId = promiseRequest_(who, req.requestId, account);
  }
  const now = now_();
  const row = {
    id: existing ? existing.id : nextPromiseId_(all),
    account: account, customer: customer, warehouse: warehouse,
    amount: amount, due: due, status: status, requestId: requestId,
    owner: existing ? existing.owner : publicName_(who),
    note: note,
    createdAt: existing ? existing.createdAt : now,
    createdBy: existing ? existing.createdBy : publicName_(who),
    updatedAt: now, updatedBy: publicName_(who),
  };
  const headers = headers_(sh);
  const detail = row.id + ' · ' + row.customer + ' · ' + row.amount + ' · ' + row.due + ' · ' + row.status;

  if (existing) {
    const before = id + ' · ' + existing.amount + ' → ' + row.amount + ' · ' + existing.due + ' → ' + row.due
      + ' · ' + existing.status + ' → ' + row.status;
    auditRequired_(publicName_(who), 'تحديث وعد سداد', before + (note ? ' · ' + note : ''));
    try {
      ['amount', 'due', 'status', 'note', 'updatedAt', 'updatedBy'].forEach(function (f) {
        sh.getRange(existing.row, headers.indexOf(PROMISE_COLUMNS[f]) + 1).setValue(row[f]);
      });
    } catch (e) {
      audit_(publicName_(who), 'تعذّر تنفيذ تحديث وعد سداد', before + ' · ' + e.message);
      throw e;
    }
    return promiseView_(row);
  }

  auditRequired_(publicName_(who), 'تسجيل وعد سداد', detail + (note ? ' · ' + note : ''));
  try {
    sh.appendRow(headers.map(function (h) {
      const f = promiseField_(h);
      return f ? row[f] : '';
    }));
  } catch (e) {
    audit_(publicName_(who), 'تعذّر تنفيذ تسجيل وعد سداد', detail + ' · ' + e.message);
    throw e;
  }
  return promiseView_(row);
}

function findRequest_(who, id) {
  const r = scopedRequests_(who).filter(function (x) { return text_(x.id) === text_(id); })[0];
  if (!r) throw new Error('الطلب غير موجود أو خارج نطاق مخازنك: ' + text_(id));
  return r;
}

function requireDecider_(who, r) {
  if (!hasPerm_(who, PERM.approve)) throw new Error('اعتماد الطلبات يتطلب صلاحية اعتماد الطلبات.');
  // The system administrator may, so that a one-person setup can still work.
  if (!hasPerm_(who, PERM.admin) && normUser_(r.requesterUser) === who.username) throw new Error('لا يمكنك اعتماد طلب قدّمته بنفسك.');
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
    // One read of the sheet, inside the lock so the status cannot change under us.
    const sh = requestsSheet_();
    const headers = headers_(sh);
    const lastRow = sh.getLastRow();
    const values = lastRow < 2 ? [] : sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
    const idCol = headers.indexOf(COLUMNS.id);
    const at = values.findIndex(function (v) { return text_(v[idCol]) === text_(req.id); });
    if (at < 0) throw new Error('الطلب غير موجود: ' + text_(req.id));
    const current = text_(values[at][headers.indexOf(COLUMNS.status)]);
    if (current !== STATUS.pending) throw new Error('هذا الطلب لم يعد قيد الاعتماد: ' + current);
    const row = values[at].slice();
    // Only these cells are written, so formulas in the user's own columns stay.
    const put = function (field, value) {
      const col = headers.indexOf(COLUMNS[field]);
      sh.getRange(at + 2, col + 1).setValue(value);
      row[col] = value;
    };
    const detail = text_(req.id) + ' · ' + text_(r.customer) + ' · ' + Number(r.amount);
    // The audit row is written first: a decision without a trace is not a decision.
    auditRequired_(publicName_(who), decision, detail);
    try {
      put('status', decision);
      if (decision === STATUS.approved) put('deliveryStatus', DELIVERY.warehouse);
      put('approver', safe_(publicName_(who)));
      put('decidedAt', now_());
      put('decisionNote', safe_(req.note));
      put('verdictAtDecision', check.verdictLabel + (check.reasons ? ': ' + safe_(check.reasons) : ''));
    } catch (e) {
      // The log already says the decision started; record why it did not finish.
      audit_(publicName_(who), 'تعذّر تنفيذ القرار', detail + ' · ' + e.message);
      throw e;
    }
    return rowToObject_(headers, row);
  });
}

function requireDeliverer_(who) {
  if (!hasPerm_(who, PERM.deliver)) {
    throw new Error('تحديث التسليم يتطلب صلاحية متابعة التسليم.');
  }
}

/**
 * deliver_ - the delivery clerk moves an approved request between the warehouse,
 * the road and the customer. It never touches the approval status or the check,
 * and it writes only the delivery cells so the user's own columns keep their formulas.
 */
function deliver_(req, who) {
  const status = text_(req.status);
  if (status && DELIVERY_LIST.indexOf(status) < 0) throw new Error('حالة التسليم غير معروفة: ' + status);
  const reason = text_(req.reason);
  if (reason && DELIVERY_REASONS.indexOf(reason) < 0) throw new Error('سبب التأخير غير معروف: ' + reason);
  if (status === DELIVERY.failed && !reason) throw new Error('اكتب سبب تعذر التسليم.');
  const due = dateOnly_(req.due);
  const deliveredAt = status === DELIVERY.delivered ? (dateOnly_(req.at) || today_()) : '';
  const note = safe_(req.note);
  // The invoice may come out at a different value than the agreed one. The
  // figure is optional, but a real difference needs a written reason.
  const actual = actualAmount_(req.actual);
  const actualNote = safe_(req.actualNote);
  const r = findRequest_(who, req.id);
  requireDeliverer_(who);
  if (text_(r.status) !== STATUS.approved && text_(r.status) !== STATUS.clear) {
    throw new Error('لا يمكن تسجيل تسليم لطلب لم يُعتمد: ' + text_(r.status));
  }
  return locked_(function () {
    const sh = requestsSheet_();
    const headers = headers_(sh);
    const lastRow = sh.getLastRow();
    const values = lastRow < 2 ? [] : sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
    const idCol = headers.indexOf(COLUMNS.id);
    const at = values.findIndex(function (v) { return text_(v[idCol]) === text_(req.id); });
    if (at < 0) throw new Error('الطلب غير موجود: ' + text_(req.id));
    // The approval may have changed while we waited for the lock.
    const current = text_(values[at][headers.indexOf(COLUMNS.status)]);
    if (current !== STATUS.approved && current !== STATUS.clear) {
      throw new Error('لا يمكن تسجيل تسليم لطلب لم يُعتمد: ' + current);
    }
    // Compare against the amount as it stands in the sheet, not the stale copy.
    const agreed = Number(values[at][headers.indexOf(COLUMNS.amount)]) || 0;
    if (actual !== '' && Math.abs(actual - agreed) >= 1 && !actualNote) {
      throw new Error('اكتب سبب اختلاف القيمة الفعلية عن القيمة المتفق عليها.');
    }
    const row = values[at].slice();
    const put = function (field, value) {
      const col = headers.indexOf(COLUMNS[field]);
      sh.getRange(at + 2, col + 1).setValue(value);
      row[col] = value;
    };
    const before = text_(values[at][headers.indexOf(COLUMNS.deliveryStatus)]) || 'لم يبدأ';
    const detail = text_(req.id) + ' · ' + before + ' → ' + (status || 'لم يبدأ')
      + (reason ? ' · ' + reason : '')
      + (actual !== '' ? ' · الفعلي: ' + actual + (actualNote ? ' · ' + actualNote : '') : '');
    // Delivery moves stock and money: it is logged before any cell changes.
    auditRequired_(publicName_(who), 'تحديث التسليم', detail);
    try {
      put('deliveryStatus', status);
      put('deliveryDue', due);
      put('deliveryAt', deliveredAt);
      put('deliveryReason', status ? reason : '');
      put('deliveryNote', status ? note : '');
      put('deliveryBy', status ? safe_(publicName_(who)) : '');
      put('deliveryUpdatedAt', now_());
      // Only stamp who changed the actual value, and when, when it really changed.
      const prevActual = storedActual_(values[at][headers.indexOf(COLUMNS.actualAmount)]);
      put('actualAmount', actual);
      put('actualNote', actual === '' ? '' : actualNote);
      if (String(prevActual) !== String(actual)) {
        put('actualBy', actual === '' ? '' : safe_(publicName_(who)));
        put('actualAt', actual === '' ? '' : now_());
      }
    } catch (e) {
      audit_(publicName_(who), 'تعذّر تنفيذ تحديث التسليم', detail + ' · ' + e.message);
      throw e;
    }
    return rowToObject_(headers, row);
  });
}

// An optional money figure: empty clears it, otherwise it must be a real,
// non-negative number. Two decimals are kept so cents survive the round trip.
function actualAmount_(v) {
  const s = text_(v).replace(/,/g, '');
  if (!s) return '';
  const n = Number(s);
  if (!isFinite(n)) throw new Error('القيمة الفعلية يجب أن تكون رقمًا.');
  if (n < 0) throw new Error('القيمة الفعلية لا تكون سالبة.');
  return Math.round(n * 100) / 100;
}

// The stored figure may have been typed by hand, so never fail on it.
function storedActual_(v) {
  const s = text_(v).replace(/,/g, '');
  if (!s) return '';
  const n = Number(s);
  return isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : s;
}

function dateOnly_(v) {
  const s = text_(v).slice(0, 10);
  if (!s) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('التاريخ يجب أن يكون بصيغة YYYY-MM-DD.');
  const p = s.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2]);
  if (d.getFullYear() !== p[0] || d.getMonth() !== p[1] - 1 || d.getDate() !== p[2]) {
    throw new Error('تاريخ غير صالح: ' + s);
  }
  return s;
}

function today_() { return now_().slice(0, 10); }

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

/**
 * auditList_ - the operation log, newest first. The filters are optional and
 * compare on the text the sheet already holds, so no date parsing is needed.
 */
function auditList_(req) {
  const sh = requestsBook_().getSheetByName(LOG_SHEET);
  if (!sh || sh.getLastRow() < 2) return { entries: [], total: 0, actions: [] };
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
  const all = rows.map(function (v) {
    return {
      at: isDate_(v[0]) ? formatDate_(v[0]) : text_(v[0]),
      user: text_(v[1]),
      action: text_(v[2]),
      detail: text_(v[3]),
    };
  }).filter(function (e) { return e.at || e.user || e.action; });
  const from = text_(req.from);
  const to = text_(req.to);
  const user = text_(req.user).toLowerCase();
  const op = text_(req.op);
  const entries = all.filter(function (e) {
    const day = e.at.slice(0, 10);
    if (from && day < from) return false;
    if (to && day > to) return false;
    if (user && e.user.toLowerCase().indexOf(user) < 0) return false;
    if (op && e.action !== op) return false;
    return true;
  });
  // The filter menu always lists every operation, not just the filtered ones.
  const actions = all.map(function (e) { return e.action; })
    .filter(function (a, i, list) { return a && list.indexOf(a) === i; })
    .sort(function (a, b) { return a.localeCompare(b, 'ar'); });
  const limit = Math.min(Math.max(parseInt(req.limit, 10) || 500, 1), 2000);
  return { entries: entries.slice(-limit).reverse(), total: entries.length, actions: actions };
}

function audit_(who, action, detail) {
  try {
    const book = requestsBook_();
    const sh = book.getSheetByName(LOG_SHEET) || book.insertSheet(LOG_SHEET);
    if (!sh.getLastRow()) sh.appendRow(['الوقت', 'المستخدم', 'العملية', 'التفاصيل']);
    sh.appendRow([now_(), safe_(who), action, safe_(detail)]);
    return true;
  } catch (e) {
    console.warn('audit not written: ' + e.message);
    return false;
  }
}

// Critical actions must leave a trace; a failed append stops the action.
function auditRequired_(who, action, detail) {
  if (!audit_(who, action, detail)) {
    throw new Error('تعذّر تسجيل العملية في سجل العمليات، فلم تُنفذ. حاول مرة أخرى.');
  }
}

function headers_(sh) {
  const n = sh.getLastColumn();
  if (!n) return [];
  return sh.getRange(1, 1, 1, n).getValues()[0].map(text_);
}

function fieldOf_(header) {
  return FIELD_BY_HEADER[header] || '';
}

function rowToObject_(headers, values) {
  const out = {};
  for (let i = 0; i < headers.length; i++) {
    const f = FIELD_BY_HEADER[headers[i]];
    if (!f) continue;
    const v = values[i];
    out[f] = isDate_(v) ? formatDate_(v) : v;
  }
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

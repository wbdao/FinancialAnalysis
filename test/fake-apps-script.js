/*
 * fake-apps-script.js - runs apps-script/Code.gs + Engine.gs in Node against in-memory sheets.
 * Used by test/script.test.js and for previewing the site locally.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class FakeRange {
  constructor(sheet, row, col, rows, cols) { Object.assign(this, { sheet, row, col, rows, cols }); }
  getValues() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const line = [];
      for (let c = 0; c < this.cols; c++) {
        const v = (this.sheet.grid[this.row - 1 + r] || [])[this.col - 1 + c];
        line.push(v === undefined ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(values) {
    values.forEach((line, r) => line.forEach((v, c) => this.sheet.put(this.row + r, this.col + c, v)));
    return this;
  }
  setValue(v) { this.sheet.put(this.row, this.col, v); return this; }
}

class FakeSheet {
  constructor(grid = []) { this.grid = grid; }
  put(r, c, v) {
    while (this.grid.length < r) this.grid.push([]);
    this.grid[r - 1][c - 1] = v;
  }
  getLastRow() { return this.grid.length; }
  getLastColumn() { return this.grid.reduce((m, l) => Math.max(m, l.length), 0); }
  getRange(row, col, rows = 1, cols = 1) { return new FakeRange(this, row, col, rows, cols); }
  getDataRange() { return this.getRange(1, 1, this.getLastRow(), this.getLastColumn()); }
  appendRow(values) { this.grid.push([...values]); }
  setFrozenRows() {}
}

function fakeBook() {
  const sheets = new Map();
  return {
    sheets,
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => { sheets.set(n, new FakeSheet()); return sheets.get(n); },
    getSpreadsheetTimeZone: () => 'UTC',
  };
}

function fakeCache() {
  const items = new Map();
  return {
    get: (k) => (items.has(k) ? items.get(k) : null),
    put: (k, v) => items.set(k, v),
    remove: (k) => items.delete(k),
  };
}

/** @param {{password?: string, sourceId?: string, source?: {base: Array, tx: Array}}} options */
function loadScript(options = {}) {
  const { password = 'admin-test-pass', sourceId = 'SOURCE', source = { base: [[]], tx: [[]] } } = options;
  const book = fakeBook();
  const sourceBook = fakeBook();
  sourceBook.sheets.set('قاعده عملاء الشركه', new FakeSheet(source.base));
  sourceBook.sheets.set('حركات العملاء', new FakeSheet(source.tx));
  const cache = fakeCache();
  const props = new Map();
  const dir = path.join(__dirname, '..', 'apps-script');
  const code = fs.readFileSync(path.join(dir, 'Code.gs'), 'utf8')
    .replace(/const ADMIN_PASSWORD = '[^']*'/, `const ADMIN_PASSWORD = '${password}'`)
    .replace(/const SOURCE_SHEET_ID = '[^']*'/, `const SOURCE_SHEET_ID = '${sourceId}'`);
  const context = vm.createContext({
    SpreadsheetApp: {
      getActiveSpreadsheet: () => book,
      openById: (id) => { if (id === 'SOURCE') return sourceBook; throw new Error('no access'); },
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => cache },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props.has(k) ? props.get(k) : null), setProperty: (k, v) => props.set(k, v) }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
    Utilities: {
      formatDate: (d, tz, fmt) => (fmt === 'yyyy-MM-dd' ? d.toISOString().slice(0, 10) : d.toISOString().slice(0, 16).replace('T', ' ')),
      getUuid: () => crypto.randomUUID(),
      computeDigest: (alg, s) => [...crypto.createHash('sha256').update(s, 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
    },
    Session: { getScriptTimeZone: () => 'UTC' },
    console,
  });
  vm.runInContext(fs.readFileSync(path.join(dir, 'Engine.gs'), 'utf8'), context);
  vm.runInContext(code, context);
  const post = (body) => JSON.parse(vm.runInContext('doPost', context)({ postData: { contents: JSON.stringify(body) } }).text);
  return { post, book, sourceBook, props, cache };
}

module.exports = { loadScript, FakeSheet, REQUESTS: 'طلبات الفواتير', USERS: 'المستخدمين', LOG: 'سجل العمليات' };

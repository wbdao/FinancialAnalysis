/*
 * fake-apps-script.js - runs apps-script/Code.gs in Node against an in-memory sheet.
 * Used by test/script.test.js and for previewing the requests screen locally.
 */
'use strict';

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
  constructor() { this.grid = []; }
  put(r, c, v) {
    while (this.grid.length < r) this.grid.push([]);
    this.grid[r - 1][c - 1] = v;
  }
  getLastRow() { return this.grid.length; }
  getLastColumn() { return this.grid.reduce((m, l) => Math.max(m, l.length), 0); }
  getRange(row, col, rows = 1, cols = 1) { return new FakeRange(this, row, col, rows, cols); }
  appendRow(values) { this.grid.push([...values]); }
  setFrozenRows() {}
}

function loadScript(keys = { request: 'req-key', approve: 'app-key' }) {
  const sheets = new Map();
  const book = {
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => { sheets.set(n, new FakeSheet()); return sheets.get(n); },
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8')
    .replace(/const REQUEST_KEY = '[^']*'/, `const REQUEST_KEY = '${keys.request}'`)
    .replace(/const APPROVE_KEY = '[^']*'/, `const APPROVE_KEY = '${keys.approve}'`);
  const context = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => book, openById: () => book },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
    Utilities: { formatDate: (d) => d.toISOString().slice(0, 16).replace('T', ' ') },
    Session: { getScriptTimeZone: () => 'UTC' },
  });
  vm.runInContext(source, context);
  const post = (body) => JSON.parse(vm.runInContext('doPost', context)({ postData: { contents: JSON.stringify(body) } }).text);
  return { post, sheets, book };
}

module.exports = { loadScript, SHEET: 'طلبات الفواتير' };

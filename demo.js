/*
 * demo.js - fictional sheets for trying the site without a real link.
 * Dates are relative to today, so the aging always looks the same.
 */
(function () {
  'use strict';

  window.demoSheets = function () {
    const today = Math.floor(Date.now() / 86400000);
    const ago = (n) => today - n;
    const base = [
      ['Account', 'Name', 'Warehouse Group', 'Customer group', 'Credit limit', 'Eligible credit limit', 'Balance', 'Payment schedule', 'Worker Name'],
      ['DEMO-1', 'عميل تجريبي منتظم', 'الرئيسي', 'Wsagent-H', 100000, 80000, 40000, 'Net30', 'مندوب تجريبي أ'],
      ['DEMO-2', 'عميل تجريبي متجاوز الحد', 'الرئيسي', 'Wsagent-H', 50000, 60000, 72000, 'Net60', 'مندوب تجريبي أ'],
      ['DEMO-3', 'عميل تجريبي ضمانه ناقص', 'الفرع', 'Wsagent-E', 150000, 30000, 90000, 'Net45', 'مندوب تجريبي ب'],
      ['DEMO-4', 'عميل تجريبي متأخر', 'الفرع', 'WholDistrb', 200000, 150000, 65000, 'Net30', 'مندوب تجريبي ب'],
      ['DEMO-5', 'عميل تجريبي متعثر', 'الفرع', 'Privt-Reta', 80000, 10000, 95000, 'Net30', 'مندوب تجريبي ب'],
      ['DEMO-6', 'عميل تجريبي موقوف', 'الرئيسي', 'Stoped Cus', 0, 0, 0, 'Stop', 'مندوب تجريبي أ'],
    ];
    base.forEach((row, i) => row.push(i ? `DEMO-ID-${i}` : 'ID number'));
    const sale = (acc, days, amount, inv) => [acc, 'Sales order', ago(days), amount, `SO-${inv}`, inv, ''];
    const pay = (acc, days, amount) => [acc, 'Payment', ago(days), -amount, `PAY-${days}`, '', 'تحصيل'];
    const tx = [
      ['Account', 'Transaction type', 'Date', 'Amount', 'voucher', 'Invoice', 'Description'],
      sale('DEMO-1', 60, 30000, 'INV-1001'), pay('DEMO-1', 25, 30000),
      sale('DEMO-1', 20, 25000, 'INV-1002'), sale('DEMO-1', 6, 17000, 'INV-1003'),
      sale('DEMO-2', 40, 45000, 'INV-2001'), sale('DEMO-2', 12, 27000, 'INV-2002'),
      sale('DEMO-3', 70, 50000, 'INV-3001'), sale('DEMO-3', 20, 40000, 'INV-3002'),
      sale('DEMO-4', 75, 40000, 'INV-4001'), pay('DEMO-4', 30, 10000), sale('DEMO-4', 15, 35000, 'INV-4002'),
      ['DEMO-5', 'General journal', ago(300), 40000, 'OB-5', '', 'الرصيد الافتتاحى'],
      sale('DEMO-5', 160, 35000, 'INV-5001'), sale('DEMO-5', 35, 20000, 'INV-5002'),
      sale('DEMO-6', 90, 5000, 'INV-6001'), pay('DEMO-6', 45, 5000),
      pay('DEMO-1', 0, 2000),
    ];
    // Checks as in the checks sheet: open under collection, rejected, due and not cashed, settled.
    const check = (no, acc, amount, due, status, cash) => [`CH${no}`, acc, String(no), amount, amount, due, status, cash];
    const checks = {
      main: [
        ['NN', 'كود العميل', 'رقم الشيك', 'قيمة الشيك', 'صافى الشيك', 'تاريخ الاستحقاق', 'الحاله', 'حالة الصرف'],
        check(101, 'DEMO-1', 15000, ago(-20), 'تحت التحصيل', ''),
        check(301, 'DEMO-3', 8000, ago(10), '', 'تم الرفض'),
        check(401, 'DEMO-4', 6000, ago(5), '', ''),
        check(201, 'DEMO-2', 9000, ago(30), 'خالص', ''),
      ],
      wh: [
        ['WH', 'كود العميل', 'رقم الشيك', 'قيمة الشيك', 'التحصيل', 'الصافي', 'تاريخ الاستحقاق', 'mm'],
        ['WH1', 'DEMO-1', '102', 2000, 0, 2000, ago(-40), 'NN'],
      ],
    };
    return { base, tx, checks };
  };
})();

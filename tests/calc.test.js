import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSettlement, expenseShares, roundYuan } from '../public/js/calc.js';
import { minimizeTransfers } from '../public/js/settle.js';
import { buildReport } from '../public/js/report.js';

const families = [
  { id: 'A', name: '小明家', adults: 2, children: 1 },
  { id: 'B', name: '小華家', adults: 2, children: 2 },
  { id: 'C', name: '小綠家', adults: 2, children: 0 },
  { id: 'D', name: '小美家', adults: 1, children: 1 },
];
const base = () => ({
  id: 't', name: '測試', families, weights: { adult: 1, child: 0.5 },
  roundingFamilyId: 'A', expenses: [],
});
const pay = (familyId, amount, note) => ({ familyId, amount, note });

test('roundYuan 對稱四捨五入', () => {
  assert.equal(roundYuan(2.5), 3);
  assert.equal(roundYuan(-2.5), -3);
  assert.equal(roundYuan(2.4999999999), 3);
  assert.equal(roundYuan(-0.2), 0);
  assert.ok(Object.is(roundYuan(-0.2), 0));
});

test('按權重均分：大人 1、小孩 0.5', () => {
  const a = base();
  const e = { id: 'e', name: '晚餐', category: 'meal', payments: [pay('A', 9000)],
    split: { mode: 'weighted', participants: ['A', 'B', 'C', 'D'] } };
  // 份數 A 2.5、B 3、C 2、D 1.5 → 共 9
  const { shares } = expenseShares(e, a);
  assert.deepEqual(shares, { A: 2500, B: 3000, C: 2000, D: 1500 });
});

test('權重可調整為 0.7', () => {
  const a = { ...base(), weights: { adult: 1, child: 0.7 } };
  const e = { id: 'e', name: '門票', category: 'other', payments: [pay('B', 1000)],
    split: { mode: 'weighted', participants: ['B', 'D'] } };
  const { shares } = expenseShares(e, a);
  assert.ok(Math.abs(shares.B - 1000 * 3.4 / 5.1) < 1e-9);
  assert.equal(shares.A, undefined);
});

test('指定金額可為負數，且加總需等於付款', () => {
  const a = base();
  const ok = { id: 'e', name: '房費', category: 'room', payments: [pay('A', 20000)],
    split: { mode: 'fixed', amounts: { A: 8000, B: 9000, C: -1170, D: 4170 } } };
  assert.equal(expenseShares(ok, a).error, null);
  const bad = { ...ok, split: { mode: 'fixed', amounts: { A: 8000, B: 9000 } } };
  assert.match(expenseShares(bad, a).error, /不符/);
});

test('完整情境：淨額加總為 0、尾差給主辦人、轉帳次數最少', () => {
  const a = base();
  a.expenses = [
    { id: '1', name: '民宿', category: 'room',
      payments: [pay('A', 5000, '訂金'), pay('B', 15000, '尾款')],
      split: { mode: 'fixed', amounts: { A: 6000, B: 7000, C: 3000, D: 4000 } } },
    { id: '2', name: '小綠房型退費', category: 'room', payments: [pay('A', -1170)],
      split: { mode: 'fixed', amounts: { C: -1170 } } },
    { id: '3', name: '燒肉', category: 'meal', payments: [pay('C', 10000)],
      split: { mode: 'weighted', participants: ['A', 'B', 'C', 'D'] } },
    { id: '4', name: '三家去釣蝦', category: 'other', payments: [pay('D', 1000)],
      split: { mode: 'weighted', participants: ['A', 'B', 'D'] } },
  ];
  const r = computeSettlement(a);
  assert.equal(r.issues.length, 0);
  assert.equal(r.total, 5000 + 15000 - 1170 + 10000 + 1000);
  assert.equal(r.netSum, 0);
  assert.ok(r.balanced);
  // 燒肉 10000/9 份 → 有尾差，全部由 A 吸收
  const owedSum = r.rows.reduce((s, x) => s + x.owed, 0);
  assert.equal(owedSum, r.total);
  for (const row of r.rows) if (row.id !== 'A') assert.equal(row.rounding, 0);
  const C = r.rows.find((x) => x.id === 'C');
  assert.equal(C.byCategory.room, 3000 - 1170);

  const t = minimizeTransfers(r.rows);
  // 轉帳後每家歸零
  const bal = Object.fromEntries(r.rows.map((x) => [x.id, x.net]));
  for (const x of t) { bal[x.from] += x.amount; bal[x.to] -= x.amount; assert.ok(x.amount > 0); }
  for (const v of Object.values(bal)) assert.equal(v, 0);
  assert.ok(t.length <= 3);

  const text = buildReport(a, r, t, { includeExpenses: true });
  assert.match(text, /轉帳清單/);
  assert.match(text, /小綠家/);
});

test('有錯誤的費用整筆排除，帳仍平衡', () => {
  const a = base();
  a.expenses = [
    { id: '1', name: '壞資料', category: 'meal', payments: [pay('A', 500)],
      split: { mode: 'weighted', participants: [] } },
    { id: '2', name: '早餐', category: 'meal', payments: [pay('B', 900)],
      split: { mode: 'weighted', participants: ['A', 'B', 'C', 'D'] } },
  ];
  const r = computeSettlement(a);
  assert.equal(r.issues.length, 1);
  assert.equal(r.total, 900);
  assert.equal(r.netSum, 0);
});

test('金額算式解析', async () => {
  const { parseAmount } = await import('../public/js/calc.js');
  assert.equal(parseAmount('1,200+350'), 1550);
  assert.equal(parseAmount('500*3'), 1500);
  assert.equal(parseAmount('500x3'), 1500);
  assert.equal(parseAmount('-1,170'), -1170);
  assert.equal(parseAmount('(100+200)/3'), 100);
  assert.equal(parseAmount('１２３'), 123);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount('1/0'), null);
  assert.equal(parseAmount('3.'), 3);
});

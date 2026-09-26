import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minimizeTransfers } from '../js/settle.js';

function check(nets) {
  const balances = nets.map((net, i) => ({ id: 'F' + i, net }));
  const t = minimizeTransfers(balances);
  const bal = Object.fromEntries(balances.map((b) => [b.id, b.net]));
  for (const x of t) { bal[x.from] += x.amount; bal[x.to] -= x.amount; }
  for (const v of Object.values(bal)) assert.equal(v, 0);
  return t;
}

test('全部為 0 時不需轉帳', () => {
  assert.deepEqual(check([0, 0, 0]), []);
});

test('找出零和小組以減少轉帳次數', () => {
  // {+100,-100} 與 {+30,+20,-50} 兩組 → 1 + 2 = 3 次；單純貪婪可能要 4 次
  const t = check([100, -100, 30, 20, -50].concat());
  assert.equal(t.length, 3);
  const t2 = check([50, 30, -30, -20, -30]);
  assert.equal(t2.length, 3);
});

test('隨機資料：次數不超過 n−1 且全部歸零', () => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let k = 0; k < 50; k++) {
    const n = 2 + Math.floor(rnd() * 10);
    const nets = Array.from({ length: n - 1 }, () => Math.floor(rnd() * 20000) - 10000);
    nets.push(-nets.reduce((s, v) => s + v, 0));
    const t = check(nets);
    assert.ok(t.length <= nets.filter((v) => v !== 0).length - 1 || t.length === 0);
  }
});

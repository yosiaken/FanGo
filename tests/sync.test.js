import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityFromRemote, applyRemote, canon, hasPending, mergeSettings } from '../public/js/sync.js';

const fam = (id, name, adults = 2, children = 0) => ({ id, name, adults, children });
const S = (families, extra = {}) => ({ name: '旅行', weights: { adult: 1, child: 0.5 }, roundingFamilyId: families[0]?.id ?? null, families, ...extra });

test('canon 與鍵順序無關', () => {
  assert.equal(canon({ a: 1, b: [1, { y: 2, x: 1 }] }), canon({ b: [1, { x: 1, y: 2 }], a: 1 }));
  assert.notEqual(canon({ a: 1 }), canon({ a: 2 }));
});

test('mergeSettings：各自新增家庭都保留', () => {
  const base = S([fam('A', '甲')]);
  const local = S([fam('A', '甲'), fam('B', '乙')]);
  const remote = S([fam('A', '甲'), fam('C', '丙')]);
  const m = mergeSettings(base, local, remote);
  assert.deepEqual(m.families.map((f) => f.id), ['A', 'C', 'B']);
});

test('mergeSettings：欄位各自以修改的一方為準', () => {
  const base = S([fam('A', '甲'), fam('B', '乙')]);
  const local = S([fam('A', '甲家'), fam('B', '乙')], { name: '墾丁' });
  const remote = S([fam('A', '甲'), fam('B', '乙', 2, 2)], { weights: { adult: 1, child: 0.7 } });
  const m = mergeSettings(base, local, remote);
  assert.equal(m.name, '墾丁');
  assert.equal(m.weights.child, 0.7);
  assert.equal(m.families[0].name, '甲家');
  assert.equal(m.families[1].children, 2);
});

test('mergeSettings：刪除與修改衝突時保留修改；單純刪除會生效', () => {
  const base = S([fam('A', '甲'), fam('B', '乙'), fam('C', '丙')]);
  const local = S([fam('A', '甲'), fam('C', '丙丙')]); // 刪 B、改 C
  const remote = S([fam('A', '甲'), fam('B', '乙')], { roundingFamilyId: 'A' }); // 刪 C
  const m = mergeSettings(base, local, remote);
  assert.deepEqual(m.families.map((f) => f.id), ['A', 'C']);
  assert.equal(m.families[1].name, '丙丙');
});

test('mergeSettings：尾差吸收者被刪除時改為第一家', () => {
  const base = S([fam('A', '甲'), fam('B', '乙')], { roundingFamilyId: 'B' });
  const local = S([fam('A', '甲'), fam('B', '乙')], { roundingFamilyId: 'B' });
  const remote = S([fam('A', '甲')], { roundingFamilyId: 'B' });
  assert.equal(mergeSettings(base, local, remote).roundingFamilyId, 'A');
});

const exp = (id, amount) => ({ id, name: id, category: 'meal', payments: [{ familyId: 'A', amount, note: '' }], split: { mode: 'weighted', participants: ['A'] } });
const remoteOf = (rev, settings, expenses) => ({ id: 'trip1', rev, settingsVersion: 1, settings, expenses: expenses.map(([e, v]) => ({ id: e.id, version: v, data: e })) });

test('applyRemote：別人新增／修改／刪除會套用，本機未上傳的修改會保留', () => {
  const settings = S([fam('A', '甲')]);
  const a = activityFromRemote(remoteOf(1, settings, [[exp('e1', 100), 1], [exp('e2', 200), 1], [exp('e3', 300), 1]]));
  assert.equal(hasPending(a), false);

  // 本機：改 e1、刪 e2、新增 e9
  a.expenses[0] = exp('e1', 111);
  a.expenses = a.expenses.filter((e) => e.id !== 'e2');
  a.expenses.push(exp('e9', 999));
  assert.equal(hasPending(a), true);

  // 伺服器：e3 被改、e2 沒變、新增 e4
  const changed = applyRemote(a, remoteOf(5, settings, [[exp('e1', 100), 1], [exp('e2', 200), 1], [exp('e3', 333), 2], [exp('e4', 400), 1]]));
  assert.equal(changed, true);
  const byId = Object.fromEntries(a.expenses.map((e) => [e.id, e.payments[0].amount]));
  assert.deepEqual(byId, { e1: 111, e3: 333, e9: 999, e4: 400 }); // e2 仍是本機刪除、等待上傳
  assert.equal(a.cloud.versions.e3, 2);
  assert.equal(a.cloud.rev, 5);

  // 伺服器刪除 e3（本機沒改）→ 本機也刪除
  applyRemote(a, remoteOf(6, settings, [[exp('e1', 100), 1], [exp('e2', 200), 1], [exp('e4', 400), 1]]));
  assert.ok(!a.expenses.some((e) => e.id === 'e3'));
});

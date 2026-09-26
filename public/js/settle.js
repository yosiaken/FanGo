// 轉帳清單：用最少的轉帳次數讓所有人淨額歸零
//
// 原理：若把有淨額的 n 家分成 k 個「淨額加總為 0」的小組，每組內 m 家只需 m−1 次轉帳，
// 總轉帳次數 = n − k。因此找「最多能切成幾個零和小組」就等於找最少轉帳次數。
// n ≤ MAX_EXACT 時用位元 DP 求最佳解（O(n·2^n)），超過則退回貪婪法。

const MAX_EXACT = 18;

/**
 * @param {{id:string, net:number}[]} balances 淨額（正數拿回、負數要補），需為整數且加總為 0
 * @returns {{from:string, to:string, amount:number}[]}
 */
export function minimizeTransfers(balances) {
  const items = balances.filter((b) => b.net !== 0).map((b) => ({ id: b.id, net: b.net }));
  if (!items.length) return [];

  const groups = items.length <= MAX_EXACT ? zeroSumGroups(items) : [items];
  const result = [];
  for (const g of groups) result.push(...greedySettle(g));
  return result;
}

/** 位元 DP：將 items 切成最多個零和小組 */
function zeroSumGroups(items) {
  const n = items.length;
  const size = 1 << n;
  const sum = new Float64Array(size);
  const dp = new Int16Array(size);
  const parent = new Int8Array(size).fill(-1); // 最後加入的元素

  for (let mask = 1; mask < size; mask++) {
    const low = 31 - Math.clz32(mask & -mask);
    sum[mask] = sum[mask & (mask - 1)] + items[low].net;

    let best = -1;
    let bestI = -1;
    for (let i = 0; i < n; i++) {
      if (!(mask & (1 << i))) continue;
      const v = dp[mask ^ (1 << i)];
      if (v > best) {
        best = v;
        bestI = i;
      }
    }
    dp[mask] = best + (sum[mask] === 0 ? 1 : 0);
    parent[mask] = bestI;
  }

  // 還原加入順序：依序加入時，每當前綴和歸零就切出一組
  const order = [];
  let mask = size - 1;
  while (mask) {
    const i = parent[mask];
    order.push(i);
    mask ^= 1 << i;
  }
  order.reverse();

  const groups = [];
  let cur = [];
  let acc = 0;
  for (const i of order) {
    cur.push(items[i]);
    acc += items[i].net;
    if (acc === 0) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length) groups.push(cur); // 理論上不會發生（總和為 0）
  return groups;
}

/** 組內貪婪配對：最大債務人轉給最大債權人，m 家最多 m−1 次 */
function greedySettle(group) {
  const creditors = group.filter((x) => x.net > 0).map((x) => ({ ...x }));
  const debtors = group.filter((x) => x.net < 0).map((x) => ({ id: x.id, net: -x.net }));
  const out = [];
  while (creditors.length && debtors.length) {
    creditors.sort((a, b) => b.net - a.net);
    debtors.sort((a, b) => b.net - a.net);
    const c = creditors[0];
    const d = debtors[0];
    const amt = Math.min(c.net, d.net);
    out.push({ from: d.id, to: c.id, amount: amt });
    c.net -= amt;
    d.net -= amt;
    if (c.net === 0) creditors.shift();
    if (d.net === 0) debtors.shift();
  }
  return out;
}

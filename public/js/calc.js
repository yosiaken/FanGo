// 分帳計算核心（不依賴 DOM，可在瀏覽器與 Node 測試中共用）

/**
 * @typedef {'room'|'meal'|'other'} Category
 * @typedef {{id:string, name:string, adults:number, children:number}} Family
 * @typedef {{adult:number, child:number}} Weights
 * @typedef {{familyId:string, amount:number, note?:string}} Payment
 * @typedef {{mode:'weighted', participants:string[], weights?:Weights, shares?:Record<string, number>} | {mode:'fixed', amounts:Record<string, number>}} Split
 *   weighted 可選：weights 覆寫這筆費用的大人／小孩權重；shares 直接指定某家的份數（優先於 weights）
 * @typedef {{id:string, name:string, category:Category, payments:Payment[], split:Split}} Expense
 * @typedef {{id:string, name:string, families:Family[], weights:Weights, roundingFamilyId:string|null, expenses:Expense[], updatedAt?:number}} Activity
 */

export const CATEGORIES = /** @type {const} */ (['room', 'meal', 'other']);

export const CATEGORY_LABEL = { room: '房費', meal: '餐費', other: '其他' };

export const DEFAULT_WEIGHTS = { adult: 1, child: 0.5 };

const EPS = 1e-6;

/** 四捨五入到元（正負對稱，並吸收浮點誤差，例如 0.49999999 → 0.5 → 1） */
export function roundYuan(x) {
  if (!Number.isFinite(x)) return 0;
  const r = Math.sign(x) * Math.round(Math.abs(x) + 1e-9);
  return r === 0 ? 0 : r; // 避免 -0
}

/** 將任意輸入轉成數字，無效則為 0 */
export function num(x) {
  const n = typeof x === 'number' ? x : parseFloat(String(x ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** 一家的分攤份數 */
export function familyWeight(family, weights) {
  return num(family.adults) * num(weights.adult) + num(family.children) * num(weights.child);
}

/**
 * 某家在「按權重均分」的某筆費用中佔幾份：
 * 先看這筆是否直接指定該家份數，再看這筆是否自訂大人／小孩權重，最後才用活動預設權重。
 */
export function splitFamilyWeight(family, split, activity) {
  const o = split.shares?.[family.id];
  if (o !== undefined && o !== null && String(o).trim() !== '' && Number.isFinite(Number(o))) {
    return Math.max(0, Number(o));
  }
  return familyWeight(family, split.weights ?? activity.weights);
}

/** 這筆費用是否有自訂權重或份數 */
export function hasCustomWeights(split) {
  return split.mode === 'weighted' && (!!split.weights || (!!split.shares && Object.keys(split.shares).length > 0));
}

/** 一筆費用的總額（所有付款加總，已四捨五入到元） */
export function expenseTotal(expense) {
  return expense.payments.reduce((s, p) => s + roundYuan(num(p.amount)), 0);
}

/**
 * 計算單筆費用各家應分攤的「精確」金額（未四捨五入）。
 * @param {Expense} expense
 * @param {Activity} activity
 * @returns {{shares: Record<string, number>, error: string|null}}
 */
export function expenseShares(expense, activity) {
  const familyIds = new Set(activity.families.map((f) => f.id));
  const total = expenseTotal(expense);

  if (!expense.payments.length) return { shares: {}, error: '沒有付款紀錄' };
  for (const p of expense.payments) {
    if (!familyIds.has(p.familyId)) return { shares: {}, error: '付款人不在家庭名單中' };
  }

  if (expense.split.mode === 'weighted') {
    const members = activity.families.filter((f) => expense.split.participants.includes(f.id));
    if (!members.length) return { shares: {}, error: '沒有選擇分攤的家庭' };
    const w = (f) => splitFamilyWeight(f, expense.split, activity);
    const totalWeight = members.reduce((s, f) => s + w(f), 0);
    if (totalWeight <= 0) return { shares: {}, error: '分攤家庭的權重總和為 0' };
    /** @type {Record<string, number>} */
    const shares = {};
    for (const f of members) shares[f.id] = (total * w(f)) / totalWeight;
    return { shares, error: null };
  }

  if (expense.split.mode === 'fixed') {
    /** @type {Record<string, number>} */
    const shares = {};
    let sum = 0;
    for (const [id, raw] of Object.entries(expense.split.amounts)) {
      const v = roundYuan(num(raw));
      if (v === 0) continue;
      if (!familyIds.has(id)) return { shares: {}, error: '指定金額中有不存在的家庭' };
      shares[id] = v;
      sum += v;
    }
    if (Math.abs(sum - total) > EPS) {
      return {
        shares: {},
        error: `指定金額加總 ${fmt(sum)} 與已付總額 ${fmt(total)} 不符（差 ${fmt(total - sum)}）`,
      };
    }
    return { shares, error: null };
  }

  return { shares: {}, error: '未知的分攤方式' };
}

/**
 * 計算整個活動的帳。
 * 規則：
 *  - 每家應付 = 各筆費用中該家應分攤金額加總（依類別分別四捨五入到元）
 *  - 每家已付 = 該家所有付款加總
 *  - 淨額 = 已付 − 應付（正數拿回、負數要補）
 *  - 四捨五入產生的尾差全部由 roundingFamilyId 吸收，確保淨額加總為 0
 *  - 有錯誤的費用整筆（含付款）不列入計算，並回報在 issues
 * @param {Activity} activity
 */
export function computeSettlement(activity) {
  const fams = activity.families;
  /** @type {Record<string, {room:number, meal:number, other:number}>} */
  const exact = {};
  /** @type {Record<string, number>} */
  const paid = {};
  for (const f of fams) {
    exact[f.id] = { room: 0, meal: 0, other: 0 };
    paid[f.id] = 0;
  }

  /** @type {{expenseId:string, name:string, message:string}[]} */
  const issues = [];
  let total = 0;

  for (const e of activity.expenses) {
    const { shares, error } = expenseShares(e, activity);
    if (error) {
      issues.push({ expenseId: e.id, name: e.name || '(未命名)', message: error });
      continue;
    }
    const cat = CATEGORIES.includes(e.category) ? e.category : 'other';
    for (const [id, v] of Object.entries(shares)) exact[id][cat] += v;
    for (const p of e.payments) paid[p.familyId] += roundYuan(num(p.amount));
    total += expenseTotal(e);
  }

  const rows = fams.map((f) => {
    const byCategory = {
      room: roundYuan(exact[f.id].room),
      meal: roundYuan(exact[f.id].meal),
      other: roundYuan(exact[f.id].other),
    };
    return {
      id: f.id,
      name: f.name,
      adults: num(f.adults),
      children: num(f.children),
      byCategory,
      rounding: 0,
      owed: byCategory.room + byCategory.meal + byCategory.other,
      paid: paid[f.id],
      net: 0,
    };
  });

  // 尾差：總支出 − 各家（四捨五入後）應付加總，全部給吸收尾差的那一家
  const owedSum = rows.reduce((s, r) => s + r.owed, 0);
  const diff = roundYuan(total - owedSum);
  let absorberId = null;
  if (rows.length) {
    const absorber = rows.find((r) => r.id === activity.roundingFamilyId) ?? rows[0];
    absorberId = absorber.id;
    absorber.rounding = diff;
    absorber.owed += diff;
  }

  for (const r of rows) r.net = r.paid - r.owed;
  const netSum = rows.reduce((s, r) => s + r.net, 0);

  return {
    total,
    rows,
    roundingDiff: diff,
    absorberId,
    netSum,
    balanced: netSum === 0,
    issues,
  };
}

/** 千分位格式（不含幣別符號） */
export function fmt(n) {
  const v = roundYuan(n);
  return v.toLocaleString('en-US');
}

/** 帶正負號的格式 */
export function fmtSigned(n) {
  const v = roundYuan(n);
  return (v > 0 ? '+' : '') + v.toLocaleString('en-US');
}

/**
 * 解析金額輸入，支援簡單算式（例如 "1200+350"、"500*3"、"-1,170"）。
 * 無法解析時回傳 null。
 */
export function parseAmount(input) {
  const s = String(input ?? '')
    .replace(/[,\s$元]/g, '')
    .replace(/[＋]/g, '+')
    .replace(/[－−]/g, '-')
    .replace(/[×xX＊]/g, '*')
    .replace(/[÷／]/g, '/')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  if (!s) return null;
  if (!/^[0-9.+\-*/()]+$/.test(s)) return null;
  let i = 0;
  const peek = () => s[i];
  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') v = s[i++] === '+' ? v + term() : v - term();
    return v;
  }
  function term() {
    let v = factor();
    while (peek() === '*' || peek() === '/') v = s[i++] === '*' ? v * factor() : v / factor();
    return v;
  }
  function factor() {
    if (peek() === '-') { i++; return -factor(); }
    if (peek() === '+') { i++; return factor(); }
    if (peek() === '(') {
      i++;
      const v = expr();
      if (s[i++] !== ')') throw new Error('paren');
      return v;
    }
    const m = /^\d+\.?\d*|^\.\d+/.exec(s.slice(i));
    if (!m) throw new Error('num');
    i += m[0].length;
    return parseFloat(m[0]);
  }
  try {
    const v = expr();
    return i === s.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

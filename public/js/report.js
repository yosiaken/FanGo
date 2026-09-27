// 產生可貼到 LINE 群組的純文字結算
import { CATEGORIES, CATEGORY_LABEL, expenseTotal, fmt, fmtSigned } from './calc.js';

/**
 * @param {import('./calc.js').Activity} activity
 * @param {ReturnType<import('./calc.js').computeSettlement>} result
 * @param {{from:string, to:string, amount:number}[]} transfers
 * @param {{includeExpenses?: boolean}} [opts]
 */
export function buildReport(activity, result, transfers, opts = {}) {
  const nameOf = (id) => activity.families.find((f) => f.id === id)?.name ?? '?';
  const lines = [];
  const hr = '──────────';

  lines.push(`【分好帳】${activity.name || '未命名活動'}`);
  lines.push(`總支出 $${fmt(result.total)}`);
  lines.push(hr);

  if (opts.includeExpenses && activity.expenses.length) {
    lines.push('📋 費用明細');
    for (const e of activity.expenses) {
      const payers = e.payments
        .map((p) => `${nameOf(p.familyId)}${p.note ? `(${p.note})` : ''}`)
        .join('、');
      lines.push(`・${e.name || '未命名'}［${CATEGORY_LABEL[e.category] ?? '其他'}］$${fmt(expenseTotal(e))}｜${payers}付`);
    }
    lines.push(hr);
  }

  // 只列出這次活動有發生的類別（例如沒有房費就不顯示「房費 0」）
  const usedCategories = CATEGORIES.filter((c) => result.rows.some((r) => r.byCategory[c] !== 0));
  lines.push('🏠 各家明細');
  for (const r of result.rows) {
    const people = `${r.adults}大${r.children ? r.children + '小' : ''}`;
    lines.push(`▸ ${r.name}（${people}）`);
    const parts = usedCategories.map((c) => `${CATEGORY_LABEL[c]} ${fmt(r.byCategory[c])}`);
    if (r.rounding) parts.push(`尾差 ${fmtSigned(r.rounding)}`);
    if (parts.length) lines.push(`  ${parts.join('｜')}`);
    lines.push(`  應付 ${fmt(r.owed)}｜已代墊 ${fmt(r.paid)}`);
    const verdict = r.net > 0 ? `可拿回 $${fmt(r.net)}` : r.net < 0 ? `需補 $${fmt(-r.net)}` : '剛好打平';
    lines.push(`  👉 ${verdict}`);
  }
  lines.push(hr);

  lines.push('💸 轉帳清單');
  if (!transfers.length) {
    lines.push('不需轉帳，大家剛好打平 🎉');
  } else {
    transfers.forEach((t, i) => {
      lines.push(`${i + 1}. ${nameOf(t.from)} → ${nameOf(t.to)}  $${fmt(t.amount)}`);
    });
  }

  if (result.roundingDiff && result.absorberId) {
    lines.push('');
    lines.push(`※ 四捨五入尾差 ${fmtSigned(result.roundingDiff)} 元由 ${nameOf(result.absorberId)} 吸收`);
  }
  if (result.issues.length) {
    lines.push(`⚠️ 有 ${result.issues.length} 筆費用資料有誤，未列入計算`);
  }
  return lines.join('\n');
}

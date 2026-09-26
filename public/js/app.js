// 分好帳 FanGo — 介面
import {
  CATEGORIES, CATEGORY_LABEL, computeSettlement, expenseShares, expenseTotal,
  familyWeight, fmt, fmtSigned, hasCustomWeights, num, parseAmount, roundYuan, splitFamilyWeight,
} from './calc.js';
import { minimizeTransfers } from './settle.js';
import { buildReport } from './report.js';
import { decodeShare, encodeShare, load, newActivity, normalizeActivity, save, uid } from './store.js';

// ---------------- 狀態 ----------------
const state = load();
const ui = {
  tab: readPref('tab', 'setup'),
  resultView: readPref('resultView', 'cards'),
  includeExpenses: readPref('includeExpenses', '0') === '1',
};

function readPref(k, d) {
  try { return localStorage.getItem('fango:' + k) ?? d; } catch { return d; }
}
function writePref(k, v) {
  try { localStorage.setItem('fango:' + k, v); } catch { /* 忽略 */ }
}

/** @returns {import('./calc.js').Activity} */
function cur() {
  let a = state.activities.find((x) => x.id === state.currentId);
  if (!a) {
    a = state.activities[0];
    if (!a) {
      a = newActivity('我的第一次出遊');
      state.activities.push(a);
    }
    state.currentId = a.id;
  }
  return a;
}

function persist() {
  cur().updatedAt = Date.now();
  if (!save(state)) toast('⚠️ 無法儲存到本機（可能是私密瀏覽模式）');
}

// ---------------- 工具 ----------------
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const famName = (a, id) => a.families.find((f) => f.id === id)?.name || '（已刪除）';
const people = (f) => `${num(f.adults)}大${num(f.children) ? num(f.children) + '小' : ''}`;
const shareStr = (w) => (Math.round(w * 100) / 100).toString();
const money = (n) => `$${fmt(n)}`;
const signedClass = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* 忽略 */ }
    ta.remove();
    return ok;
  }
}

// ---------------- 外框 ----------------
function renderAll() {
  renderActivitySelect();
  renderTabs();
  renderView();
}

function renderActivitySelect() {
  const a = cur();
  $('#activity-select').innerHTML = state.activities
    .slice()
    .sort((x, y) => (y.updatedAt ?? 0) - (x.updatedAt ?? 0))
    .map((x) => `<option value="${esc(x.id)}" ${x.id === a.id ? 'selected' : ''}>${esc(x.name || '未命名活動')}</option>`)
    .join('');
}

function renderTabs() {
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === ui.tab)));
}

function renderView() {
  const a = cur();
  const view = $('#view');
  if (ui.tab === 'setup') view.innerHTML = setupHTML(a);
  else if (ui.tab === 'expenses') view.innerHTML = expensesHTML(a);
  else view.innerHTML = resultHTML(a);
}

function setTab(tab) {
  ui.tab = tab;
  writePref('tab', tab);
  renderTabs();
  renderView();
  window.scrollTo({ top: 0 });
}

// ---------------- ① 家庭設定 ----------------
function setupHTML(a) {
  const totalA = a.families.reduce((s, f) => s + num(f.adults), 0);
  const totalC = a.families.reduce((s, f) => s + num(f.children), 0);
  return `
  <section class="card">
    <h2>活動</h2>
    <label class="field" style="margin:0"><span>活動名稱</span>
      <input type="text" data-bind="name" value="${esc(a.name)}" placeholder="例如：2026 墾丁三天兩夜" maxlength="60" />
    </label>
  </section>

  <section class="card">
    <h2>分攤權重 <span class="hint">「按權重均分」時每人算幾份</span></h2>
    <div class="weights">
      <label class="field" style="margin:0"><span>大人</span>
        <input type="number" inputmode="decimal" step="0.1" min="0" data-bind="w-adult" value="${esc(a.weights.adult)}" /></label>
      <label class="field" style="margin:0"><span>小孩</span>
        <input type="number" inputmode="decimal" step="0.1" min="0" data-bind="w-child" value="${esc(a.weights.child)}" /></label>
    </div>
  </section>

  <section class="card">
    <h2>參加家庭 <span class="hint" id="fam-summary">${a.families.length} 家 · ${totalA} 大 ${totalC} 小</span></h2>
    ${a.families.length ? a.families.map((f) => familyRowHTML(a, f)).join('') : '<p class="empty" style="padding:8px">還沒有家庭，先新增參加的家庭吧！</p>'}
    <button class="btn block" data-action="add-family" style="margin-top:8px">＋ 新增家庭</button>
  </section>

  <section class="card">
    <h2>尾差由誰吸收</h2>
    <select data-bind="rounding" id="rounding-select">${roundingOptions(a)}</select>
    <p class="hint" style="margin:8px 0 0">金額四捨五入到元後，若總帳差個幾塊錢，全部由這一家（例如主辦人）吸收，確保總帳對得起來。</p>
  </section>

  ${a.families.length ? `<button class="btn primary block" data-tab-go="expenses">下一步：記錄費用 →</button>` : ''}`;
}

function familyRowHTML(a, f) {
  const stepper = (field, label) => `
    <span class="stepper"><span>${label}</span>
      <button type="button" data-action="step" data-id="${f.id}" data-field="${field}" data-delta="-1" aria-label="${label}減一">−</button>
      <output data-count="${f.id}-${field}">${num(f[field])}</output>
      <button type="button" data-action="step" data-id="${f.id}" data-field="${field}" data-delta="1" aria-label="${label}加一">＋</button>
    </span>`;
  return `
  <div class="family">
    <input class="name" type="text" data-fam-name="${f.id}" value="${esc(f.name)}" placeholder="家庭名稱，例如：小明家" maxlength="20" />
    <button type="button" class="btn small ghost del danger" data-action="del-family" data-id="${f.id}" aria-label="刪除 ${esc(f.name)}">刪除</button>
    <div class="counts">
      ${stepper('adults', '大人')}
      ${stepper('children', '小孩')}
      <span class="shares" data-shares="${f.id}">${shareStr(familyWeight(f, a.weights))} 份</span>
    </div>
  </div>`;
}

function roundingOptions(a) {
  if (!a.families.length) return '<option value="">（請先新增家庭）</option>';
  const selected = a.families.some((f) => f.id === a.roundingFamilyId) ? a.roundingFamilyId : a.families[0].id;
  return a.families.map((f) => `<option value="${f.id}" ${f.id === selected ? 'selected' : ''}>${esc(f.name || '未命名')}</option>`).join('');
}

function refreshSetupDerived() {
  const a = cur();
  for (const f of a.families) {
    const s = $(`[data-shares="${f.id}"]`);
    if (s) s.textContent = `${shareStr(familyWeight(f, a.weights))} 份`;
    for (const field of ['adults', 'children']) {
      const o = $(`[data-count="${f.id}-${field}"]`);
      if (o) o.textContent = num(f[field]);
    }
  }
  const totalA = a.families.reduce((s, f) => s + num(f.adults), 0);
  const totalC = a.families.reduce((s, f) => s + num(f.children), 0);
  const sum = $('#fam-summary');
  if (sum) sum.textContent = `${a.families.length} 家 · ${totalA} 大 ${totalC} 小`;
}

function familyReferences(a, id) {
  return a.expenses.filter(
    (e) =>
      e.payments.some((p) => p.familyId === id) ||
      (e.split.mode === 'fixed' && roundYuan(num(e.split.amounts[id])) !== 0),
  );
}

// ---------------- ② 費用紀錄 ----------------
function expensesHTML(a) {
  if (!a.families.length) {
    return `<div class="card empty">要先設定參加的家庭，才能記錄費用。<br /><button class="btn primary" data-tab-go="setup">前往家庭設定</button></div>`;
  }
  const valid = computeSettlement(a);
  const list = a.expenses.map((e) => expenseCardHTML(a, e)).join('');
  return `
  <div class="summary-bar">
    <span class="hint">共 ${a.expenses.length} 筆${valid.issues.length ? ` · <span class="neg">${valid.issues.length} 筆有誤</span>` : ''}</span>
    <span><span class="hint">總支出</span> <strong class="num">${money(valid.total)}</strong></span>
  </div>
  ${list || `<div class="card empty">還沒有任何費用。<br />房費、餐費、門票、訂金……都記在這裡。</div>`}
  <button class="btn primary fab" data-action="new-expense">＋ 新增費用</button>`;
}

function splitSummary(a, e) {
  if (e.split.mode === 'fixed') {
    const n = Object.values(e.split.amounts).filter((v) => roundYuan(num(v)) !== 0).length;
    return `指定金額（${n} 家）`;
  }
  const ids = e.split.participants.filter((id) => a.families.some((f) => f.id === id));
  const custom = hasCustomWeights(e.split) ? '・自訂權重' : '';
  if (ids.length === a.families.length) return `按權重・全部家庭${custom}`;
  return `按權重・只分 ${ids.map((id) => famName(a, id)).join('、') || '（無）'}${custom}`;
}

function expenseCardHTML(a, e) {
  const { error } = expenseShares(e, a);
  const payers = e.payments
    .map((p) => `${esc(famName(a, p.familyId))} ${fmt(p.amount)}${p.note ? `（${esc(p.note)}）` : ''}`)
    .join('、');
  return `
  <button class="expense ${error ? 'has-error' : ''}" data-action="edit-expense" data-id="${e.id}">
    <div class="top">
      <span class="chip ${e.category}">${CATEGORY_LABEL[e.category]}</span>
      <span class="title">${esc(e.name || '未命名')}</span>
      <span class="amt num">${money(expenseTotal(e))}</span>
    </div>
    <div class="meta">付款：${payers || '—'}</div>
    <div class="meta">分攤：${esc(splitSummary(a, e))}</div>
    ${error ? `<div class="err">⚠️ ${esc(error)}（不列入計算）</div>` : ''}
  </button>`;
}

// ---------------- 費用編輯視窗 ----------------
/** 編輯中的草稿；金額以字串保存，方便輸入算式 */
let draft = null;

function openExpense(id) {
  const a = cur();
  const e = id ? a.expenses.find((x) => x.id === id) : null;
  const defaultPayer = a.families.some((f) => f.id === a.roundingFamilyId) ? a.roundingFamilyId : a.families[0]?.id;
  if (e) {
    draft = {
      id: e.id,
      name: e.name,
      category: e.category,
      payments: e.payments.map((p) => ({ familyId: p.familyId, amount: String(p.amount), note: p.note ?? '' })),
      mode: e.split.mode,
      participants: e.split.mode === 'weighted' ? [...e.split.participants] : a.families.map((f) => f.id),
      amounts: e.split.mode === 'fixed' ? Object.fromEntries(Object.entries(e.split.amounts).map(([k, v]) => [k, String(v)])) : {},
      modeTouched: true,
      custom: hasCustomWeights(e.split),
      cw: weightStrings(e.split.weights ?? a.weights),
      cshares: Object.fromEntries(Object.entries(e.split.shares ?? {}).map(([k, v]) => [k, String(v)])),
    };
  } else {
    draft = {
      id: null,
      name: '',
      category: 'meal',
      payments: [{ familyId: defaultPayer, amount: '', note: '' }],
      mode: 'weighted',
      participants: a.families.map((f) => f.id),
      amounts: {},
      modeTouched: false,
      custom: false,
      cw: weightStrings(a.weights),
      cshares: {},
    };
  }
  renderDialog();
  const dlg = $('#expense-dialog');
  if (!dlg.open) dlg.showModal();
  if (!e) setTimeout(() => $('[data-d="name"]', dlg)?.focus(), 50);
}

const weightStrings = (w) => ({ adult: String(w.adult), child: String(w.child) });

/** 解析份數／權重輸入：空白回傳 null，無效或負數回傳 NaN */
function parseWeight(v) {
  if (String(v ?? '').trim() === '') return null;
  const n = parseAmount(v);
  return n === null || n < 0 ? NaN : n;
}

/**
 * 由草稿組出「按權重均分」的 split（自訂權重與份數只在有效時才放入）。
 * @returns {{split: import('./calc.js').Split, error: string|null}}
 */
function draftWeightedSplit(a) {
  const split = { mode: 'weighted', participants: a.families.map((f) => f.id).filter((id) => draft.participants.includes(id)) };
  if (!draft.custom) return { split, error: null };
  let error = null;
  const ad = parseWeight(draft.cw.adult);
  const ch = parseWeight(draft.cw.child);
  if (Number.isNaN(ad) || Number.isNaN(ch) || ad === null || ch === null) error = '此筆的大人／小孩權重需為 0 以上的數字';
  else if (ad !== a.weights.adult || ch !== a.weights.child) split.weights = { adult: ad, child: ch };
  const shares = {};
  for (const [id, raw] of Object.entries(draft.cshares)) {
    if (!split.participants.includes(id)) continue;
    const v = parseWeight(raw);
    if (v === null) continue;
    if (Number.isNaN(v)) error ??= `${famName(a, id)} 的份數需為 0 以上的數字`;
    else shares[id] = v;
  }
  if (Object.keys(shares).length) split.shares = shares;
  return { split, error };
}

function draftTotal() {
  return draft.payments.reduce((s, p) => s + roundYuan(parseAmount(p.amount) ?? 0), 0);
}

function renderDialog() {
  const a = cur();
  const dlg = $('#expense-dialog');
  const scroll = $('.dlg-body', dlg)?.scrollTop ?? 0;
  const famOpts = (sel) => a.families.map((f) => `<option value="${f.id}" ${f.id === sel ? 'selected' : ''}>${esc(f.name || '未命名')}</option>`).join('');

  dlg.innerHTML = `
  <form class="dlg" method="dialog" novalidate>
    <div class="dlg-head">
      <h3>${draft.id ? '編輯費用' : '新增費用'}</h3>
      <button type="button" class="x" style="width:36px;height:36px" data-d-action="close" aria-label="關閉">×</button>
    </div>
    <div class="dlg-body">
      <label class="field"><span>項目名稱</span>
        <input type="text" data-d="name" value="${esc(draft.name)}" placeholder="例如：第一晚燒肉、民宿訂金" maxlength="40" /></label>

      <div class="field"><span class="hint">類別</span>
        <div class="seg" role="group" aria-label="類別">
          ${CATEGORIES.map((c) => `<button type="button" data-d-action="cat" data-v="${c}" aria-pressed="${draft.category === c}">${CATEGORY_LABEL[c]}</button>`).join('')}
        </div>
      </div>

      <div class="card" style="padding:12px">
        <h2 style="margin-bottom:10px">誰付的 <span class="hint">訂金、預付款也記在這裡</span></h2>
        ${draft.payments.map((p, i) => `
          <div class="pay-row">
            <select data-d="pay-fam" data-i="${i}" aria-label="付款家庭">${famOpts(p.familyId)}</select>
            <input type="text" inputmode="decimal" class="num" data-d="pay-amt" data-i="${i}" value="${esc(p.amount)}" placeholder="金額" aria-label="金額" autocomplete="off" />
            <input type="text" class="note" data-d="pay-note" data-i="${i}" value="${esc(p.note)}" placeholder="備註（例：訂金、尾款）" maxlength="20" />
            ${draft.payments.length > 1 ? `<button type="button" class="x" data-d-action="del-pay" data-i="${i}" aria-label="移除這筆付款">×</button>` : '<span></span>'}
          </div>`).join('')}
        <button type="button" class="btn small ghost" data-d-action="add-pay">＋ 再加一筆付款（訂金／分次付／別家付）</button>
        <div class="sum-line"><span>費用總額</span><span class="num" id="d-total">${money(draftTotal())}</span></div>
      </div>

      <div class="field"><span class="hint">分攤方式</span>
        <div class="seg" role="group" aria-label="分攤方式">
          <button type="button" data-d-action="mode" data-v="weighted" aria-pressed="${draft.mode === 'weighted'}">按權重均分</button>
          <button type="button" data-d-action="mode" data-v="fixed" aria-pressed="${draft.mode === 'fixed'}">指定每家金額</button>
        </div>
      </div>
      <div class="card" style="padding:12px" id="split-area">${splitAreaHTML(a)}</div>
    </div>
    <div class="dlg-foot">
      ${draft.id ? `<button type="button" class="btn danger-outline" data-d-action="delete">刪除</button>` : ''}
      <span class="grow"></span>
      <button type="button" class="btn" data-d-action="close">取消</button>
      <button type="submit" class="btn primary">儲存</button>
    </div>
  </form>`;
  $('.dlg-body', dlg).scrollTop = scroll;
}

function splitAreaHTML(a) {
  if (draft.mode === 'weighted') {
    return `
      <div class="row" style="margin-bottom:6px">
        <span class="hint grow">勾選要分攤這筆費用的家庭</span>
        <button type="button" class="btn small ghost" data-d-action="all">全選</button>
        <button type="button" class="btn small ghost" data-d-action="none">全不選</button>
      </div>
      <label class="check custom-toggle"><input type="checkbox" data-d="custom" ${draft.custom ? 'checked' : ''} /> 這筆用不同的權重或份數</label>
      ${draft.custom ? `
      <div class="custom-w">
        <label>大人<input type="text" inputmode="decimal" class="num" data-d="cw-adult" value="${esc(draft.cw.adult)}" autocomplete="off" /></label>
        <label>小孩<input type="text" inputmode="decimal" class="num" data-d="cw-child" value="${esc(draft.cw.child)}" autocomplete="off" /></label>
        <button type="button" class="btn small ghost" data-d-action="reset-w">恢復預設</button>
      </div>
      <p class="hint" style="margin:0 0 6px">也可以直接修改下方每家的份數（例如這餐某家只去 2 人）。</p>` : ''}
      <div class="split-list">
        ${a.families.map((f) => `
          <div class="split-row">
            <label>
              <input type="checkbox" data-d="part" data-id="${f.id}" ${draft.participants.includes(f.id) ? 'checked' : ''} />
              <span class="who">${esc(f.name || '未命名')}<small>${people(f)}${draft.custom ? '' : ` · ${shareStr(familyWeight(f, a.weights))} 份`}</small></span>
            </label>
            ${draft.custom ? `<span class="share-in"><input type="text" inputmode="decimal" class="num" data-d="cshare" data-id="${f.id}" value="${esc(draft.cshares[f.id] ?? '')}" aria-label="${esc(f.name)} 份數" autocomplete="off" /><span>份</span></span>` : ''}
            <span class="val num" data-preview="${f.id}"></span>
          </div>`).join('')}
      </div>
      <p class="hint" id="split-note" style="margin:8px 0 0"></p>`;
  }
  return `
    <div class="row" style="margin-bottom:6px">
      <span class="hint grow">填每家應付多少，負數代表要退錢</span>
      <button type="button" class="btn small ghost" data-d-action="fill-weighted">依權重帶入</button>
    </div>
    <div class="split-list">
      ${a.families.map((f) => `
        <div class="split-row">
          <span class="who">${esc(f.name || '未命名')}<small>${people(f)}</small></span>
          <button type="button" class="sign-btn" data-d-action="sign" data-id="${f.id}" aria-label="正負號切換">±</button>
          <input type="text" inputmode="decimal" class="money num" data-d="fixed" data-id="${f.id}" value="${esc(draft.amounts[f.id] ?? '')}" placeholder="0" autocomplete="off" />
        </div>`).join('')}
    </div>
    <div class="sum-line"><span>指定合計</span><span class="num" id="fixed-sum"></span></div>
    <p class="hint" id="split-note" style="margin:6px 0 0"></p>`;
}

/** 依草稿內容更新即時預覽（不重畫輸入框，避免游標跳掉） */
function refreshDialogDerived() {
  if (!draft) return;
  const a = cur();
  const total = draftTotal();
  const t = $('#d-total');
  if (t) t.textContent = money(total);

  for (const p of $$('[data-d="pay-amt"], [data-d="fixed"]')) {
    const bad = p.value.trim() !== '' && parseAmount(p.value) === null;
    p.classList.toggle('invalid', bad);
  }

  const note = $('#split-note');
  if (draft.mode === 'weighted') {
    const { split, error } = draftWeightedSplit(a);
    const w = (f) => splitFamilyWeight(f, split, a);
    const members = a.families.filter((f) => draft.participants.includes(f.id));
    const tw = members.reduce((s, f) => s + w(f), 0);
    for (const f of a.families) {
      const el = $(`[data-preview="${f.id}"]`);
      if (el) el.textContent = draft.participants.includes(f.id) && tw > 0 ? money((total * w(f)) / tw) : '—';
      // 份數欄：沒有手動覆寫的顯示依權重算出的預設份數
      const inp = $(`[data-d="cshare"][data-id="${f.id}"]`);
      if (inp) {
        const overridden = parseWeight(draft.cshares[f.id]) !== null;
        inp.classList.toggle('overridden', overridden);
        inp.classList.toggle('invalid', Number.isNaN(parseWeight(draft.cshares[f.id])));
        inp.disabled = !draft.participants.includes(f.id);
        if (!overridden && document.activeElement !== inp) inp.value = shareStr(familyWeight(f, split.weights ?? a.weights));
      }
    }
    for (const k of ['adult', 'child']) {
      const inp = $(`[data-d="cw-${k}"]`);
      if (inp) inp.classList.toggle('invalid', !(parseWeight(draft.cw[k]) >= 0));
    }
    if (note) {
      note.textContent = error
        ? `⚠️ ${error}`
        : !members.length
        ? '⚠️ 至少要勾選一家'
        : tw > 0
          ? `${members.length} 家共 ${shareStr(tw)} 份，每份約 ${money(total / tw)}（預覽金額已四捨五入）`
          : '⚠️ 勾選家庭的份數總和為 0';
    }
  } else {
    const sum = Object.values(draft.amounts).reduce((s, v) => s + roundYuan(parseAmount(v) ?? 0), 0);
    const el = $('#fixed-sum');
    if (el) el.textContent = `${money(sum)} / ${money(total)}`;
    if (note) {
      const diff = total - sum;
      note.innerHTML = diff === 0 ? '<span class="pos">✓ 與費用總額相符</span>' : `<span class="neg">⚠️ 還差 ${fmtSigned(diff)} 元才會等於費用總額</span>`;
    }
  }
}

function onDialogInput(ev) {
  const el = ev.target;
  const k = el.dataset.d;
  if (!k || !draft) return;
  const i = Number(el.dataset.i);
  if (k === 'name') draft.name = el.value;
  else if (k === 'pay-fam') draft.payments[i].familyId = el.value;
  else if (k === 'pay-amt') draft.payments[i].amount = el.value;
  else if (k === 'pay-note') draft.payments[i].note = el.value;
  else if (k === 'fixed') draft.amounts[el.dataset.id] = el.value;
  else if (k === 'cw-adult') draft.cw.adult = el.value;
  else if (k === 'cw-child') draft.cw.child = el.value;
  else if (k === 'cshare') {
    const f = cur().families.find((x) => x.id === el.dataset.id);
    // 改回與預設相同的份數就視為沒有覆寫
    const w = parseWeight(draft.cw.adult) >= 0 && parseWeight(draft.cw.child) >= 0
      ? { adult: parseWeight(draft.cw.adult), child: parseWeight(draft.cw.child) } : cur().weights;
    if (el.value.trim() === '' || (f && parseWeight(el.value) === familyWeight(f, w))) delete draft.cshares[el.dataset.id];
    else draft.cshares[el.dataset.id] = el.value;
  } else if (k === 'custom') {
    if (ev.type !== 'change') return;
    draft.custom = el.checked;
    draft.cw = weightStrings(cur().weights);
    draft.cshares = {};
    renderDialog();
  }
  else if (k === 'part') {
    const id = el.dataset.id;
    draft.participants = el.checked ? [...new Set([...draft.participants, id])] : draft.participants.filter((x) => x !== id);
  }
  refreshDialogDerived();
}

const isMoneyInput = (el) => el?.dataset?.d === 'pay-amt' || el?.dataset?.d === 'fixed';

/** 把金額欄的算式換成計算結果（純數字則不動） */
function evaluateInPlace(el) {
  const raw = el.value.replace(/,/g, '').trim();
  if (/^-?\d*\.?\d*$/.test(raw)) return;
  const v = parseAmount(el.value);
  if (v === null) return;
  el.value = String(roundYuan(v));
  onDialogInput({ target: el });
}

/** 離開金額欄位時，把算式換成計算結果並收起運算鍵 */
function onDialogBlur(ev) {
  if (ev.target.dataset?.d === 'cshare') return void setTimeout(refreshDialogDerived);
  if (!isMoneyInput(ev.target)) return;
  evaluateInPlace(ev.target);
  $('#calc-bar')?.remove();
}

// ---- 運算鍵列：手機數字鍵盤沒有 + − × ÷，聚焦金額欄時在下方補一排 ----
const CALC_KEYS = [
  ['+', '+'], ['−', '-'], ['×', '×'], ['÷', '÷'], ['(', '('], [')', ')'], ['=', '='],
];

function onDialogFocusIn(ev) {
  const el = ev.target;
  if (!isMoneyInput(el)) return;
  let bar = $('#calc-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'calc-bar';
    bar.className = 'calc-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '運算符號');
    bar.innerHTML = CALC_KEYS.map(([label, v]) => `<button type="button" tabindex="-1" data-calc="${esc(v)}" aria-label="${label === '=' ? '計算' : label}">${label}</button>`).join('');
    // 用 pointerdown 處理並阻止預設行為，焦點留在輸入框，鍵盤不會收起
    const keep = (e) => e.preventDefault();
    bar.addEventListener('mousedown', keep);
    bar.addEventListener('touchstart', keep, { passive: false });
    bar.addEventListener('click', keep);
    bar.addEventListener('pointerdown', (e) => {
      const b = e.target.closest('[data-calc]');
      e.preventDefault();
      if (b && bar.target) pressCalcKey(bar.target, b.dataset.calc);
    });
  }
  bar.target = el;
  const row = el.closest('.pay-row, .split-row');
  if (row && row.nextElementSibling !== bar) row.after(bar);
}

function pressCalcKey(el, key) {
  el.focus();
  if (key === '=') return evaluateInPlace(el);
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.setRangeText(key, start, end, 'end');
  onDialogInput({ target: el });
}

function onDialogClick(ev) {
  const btn = ev.target.closest('[data-d-action]');
  if (!btn || !draft) return;
  const a = cur();
  const act = btn.dataset.dAction;
  const i = Number(btn.dataset.i);
  switch (act) {
    case 'close':
      $('#expense-dialog').close();
      return;
    case 'cat':
      draft.category = btn.dataset.v;
      // 新增時若還沒動過分攤方式：房費預設「指定金額」，其他預設「按權重」
      if (!draft.modeTouched) draft.mode = draft.category === 'room' ? 'fixed' : 'weighted';
      break;
    case 'add-pay': {
      const used = new Set(draft.payments.map((p) => p.familyId));
      const next = a.families.find((f) => !used.has(f.id))?.id ?? a.families[0].id;
      draft.payments.push({ familyId: next, amount: '', note: '' });
      break;
    }
    case 'del-pay':
      draft.payments.splice(i, 1);
      break;
    case 'mode':
      draft.mode = btn.dataset.v;
      draft.modeTouched = true;
      break;
    case 'all':
      draft.participants = a.families.map((f) => f.id);
      break;
    case 'reset-w':
      draft.cw = weightStrings(a.weights);
      draft.cshares = {};
      break;
    case 'none':
      draft.participants = [];
      break;
    case 'sign': {
      const input = $(`[data-d="fixed"][data-id="${btn.dataset.id}"]`);
      const v = input.value.trim();
      input.value = v.startsWith('-') ? v.slice(1) : v ? '-' + v : '-';
      draft.amounts[btn.dataset.id] = input.value;
      input.focus();
      refreshDialogDerived();
      return;
    }
    case 'fill-weighted': {
      // 依權重（全部家庭）帶入金額，尾差放在第一家，之後可再手動調整
      const total = draftTotal();
      const tw = a.families.reduce((s, f) => s + familyWeight(f, a.weights), 0);
      if (!tw) return toast('家庭份數總和為 0，無法帶入');
      let acc = 0;
      const vals = a.families.map((f) => {
        const v = roundYuan((total * familyWeight(f, a.weights)) / tw);
        acc += v;
        return v;
      });
      vals[0] += total - acc;
      a.families.forEach((f, k) => (draft.amounts[f.id] = String(vals[k])));
      break;
    }
    case 'delete': {
      if (!confirm(`確定刪除「${draft.name || '未命名'}」？`)) return;
      a.expenses = a.expenses.filter((e) => e.id !== draft.id);
      persist();
      $('#expense-dialog').close();
      renderView();
      toast('已刪除');
      return;
    }
    default:
      return;
  }
  renderDialog();
  refreshDialogDerived();
}

function onDialogSubmit(ev) {
  ev.preventDefault();
  const a = cur();
  const payments = [];
  for (const p of draft.payments) {
    if (p.amount.trim() === '' && !p.note.trim()) continue;
    const v = parseAmount(p.amount);
    if (v === null) return toast('付款金額格式有誤');
    if (roundYuan(v) === 0) continue;
    payments.push({ familyId: p.familyId, amount: roundYuan(v), note: p.note.trim() });
  }
  if (!payments.length) return toast('請填寫付款金額');

  let split;
  if (draft.mode === 'weighted') {
    const built = draftWeightedSplit(a);
    if (!built.split.participants.length) return toast('請至少勾選一家分攤');
    if (built.error) return toast(built.error);
    split = built.split;
  } else {
    const amounts = {};
    for (const [id, raw] of Object.entries(draft.amounts)) {
      if (String(raw).trim() === '' || String(raw).trim() === '-') continue;
      const v = parseAmount(raw);
      if (v === null) return toast(`${famName(a, id)} 的金額格式有誤`);
      if (roundYuan(v) !== 0) amounts[id] = roundYuan(v);
    }
    split = { mode: 'fixed', amounts };
  }

  const expense = {
    id: draft.id ?? uid(),
    name: draft.name.trim() || CATEGORY_LABEL[draft.category],
    category: draft.category,
    payments,
    split,
  };
  const { error } = expenseShares(expense, a);
  if (error && !confirm(`${error}\n\n仍要儲存嗎？這筆會標示為有誤，暫不列入計算。`)) return;

  const idx = a.expenses.findIndex((e) => e.id === expense.id);
  if (idx >= 0) a.expenses[idx] = expense;
  else a.expenses.push(expense);
  persist();
  $('#expense-dialog').close();
  renderView();
  toast(idx >= 0 ? '已更新' : '已新增');
}

// ---------------- ③ 結算 ----------------
function resultHTML(a) {
  if (!a.families.length) {
    return `<div class="card empty">還沒有家庭資料。<br /><button class="btn primary" data-tab-go="setup">前往家庭設定</button></div>`;
  }
  const r = computeSettlement(a);
  const transfers = minimizeTransfers(r.rows);
  const text = buildReport(a, r, transfers, { includeExpenses: ui.includeExpenses });
  const absorber = r.absorberId ? famName(a, r.absorberId) : '';

  const cards = r.rows.map((row) => `
    <div class="fam-card">
      <div class="head">
        <strong>${esc(row.name || '未命名')}</strong><span class="hint">${people(row)}</span>
        <span class="net num ${signedClass(row.net)}">${row.net > 0 ? '拿回 ' : row.net < 0 ? '要補 ' : ''}${money(Math.abs(row.net))}</span>
      </div>
      <dl class="num">
        <div><dt>房費</dt><dd>${fmt(row.byCategory.room)}</dd></div>
        <div><dt>餐費份額</dt><dd>${fmt(row.byCategory.meal)}</dd></div>
        <div><dt>其他</dt><dd>${fmt(row.byCategory.other)}</dd></div>
        ${row.rounding ? `<div><dt>尾差</dt><dd>${fmtSigned(row.rounding)}</dd></div>` : ''}
        <div><dt>應付合計</dt><dd>${fmt(row.owed)}</dd></div>
        <div><dt>已代墊</dt><dd>${fmt(row.paid)}</dd></div>
      </dl>
    </div>`).join('');

  const sum = (k) => r.rows.reduce((s, x) => s + k(x), 0);
  const table = `
    <div class="table-wrap"><table class="detail num">
      <thead><tr><th>家庭</th><th>房費</th><th>餐費</th><th>其他</th><th>尾差</th><th>應付</th><th>已代墊</th><th>淨額</th></tr></thead>
      <tbody>${r.rows.map((row) => `<tr>
        <td>${esc(row.name || '未命名')}</td><td>${fmt(row.byCategory.room)}</td><td>${fmt(row.byCategory.meal)}</td>
        <td>${fmt(row.byCategory.other)}</td><td>${row.rounding ? fmtSigned(row.rounding) : ''}</td><td>${fmt(row.owed)}</td>
        <td>${fmt(row.paid)}</td><td class="${signedClass(row.net)}">${fmtSigned(row.net)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>合計</td><td>${fmt(sum((x) => x.byCategory.room))}</td><td>${fmt(sum((x) => x.byCategory.meal))}</td>
        <td>${fmt(sum((x) => x.byCategory.other))}</td><td>${r.roundingDiff ? fmtSigned(r.roundingDiff) : ''}</td>
        <td>${fmt(sum((x) => x.owed))}</td><td>${fmt(sum((x) => x.paid))}</td><td>${fmtSigned(r.netSum)}</td></tr></tfoot>
    </table></div>`;

  return `
  <section class="card">
    <div class="check-line">
      ${r.balanced ? '<span class="ok-badge">✓ 所有家庭淨額加總 = 0，帳平</span>' : `<span class="bad-badge">✗ 淨額加總 ${fmtSigned(r.netSum)}，帳不平</span>`}
      <span class="hint">總支出 <b class="num">${money(r.total)}</b></span>
    </div>
    ${r.issues.length ? `<div class="alert">⚠️ 以下費用資料有誤，暫不列入計算：<br />${r.issues.map((x) => `・${esc(x.name)}：${esc(x.message)}`).join('<br />')}</div>` : ''}
    ${r.roundingDiff ? `<p class="hint" style="margin:0">四捨五入尾差 ${fmtSigned(r.roundingDiff)} 元由 <b>${esc(absorber)}</b> 吸收。</p>` : ''}
  </section>

  <section class="card">
    <h2>💸 轉帳清單 <span class="hint">${transfers.length ? `共 ${transfers.length} 筆（已最少化）` : ''}</span></h2>
    ${transfers.length
      ? transfers.map((t, i) => `
        <div class="transfer">
          <span class="idx">${i + 1}</span>
          <span class="who">${esc(famName(a, t.from))}<span class="arrow">→</span>${esc(famName(a, t.to))}</span>
          <span class="amt num">${money(t.amount)}</span>
        </div>`).join('')
      : '<p class="hint" style="margin:0">不需要轉帳，大家剛好打平 🎉</p>'}
  </section>

  <section class="card">
    <h2>🏠 每家明細</h2>
    <div class="seg view-toggle" role="group" aria-label="顯示方式">
      <button type="button" data-action="result-view" data-v="cards" aria-pressed="${ui.resultView === 'cards'}">卡片</button>
      <button type="button" data-action="result-view" data-v="table" aria-pressed="${ui.resultView === 'table'}">表格</button>
    </div>
    ${ui.resultView === 'table' ? table : cards}
    <p class="hint" style="margin:6px 0 0">淨額 = 已代墊 − 應付；正數拿回、負數要補。</p>
  </section>

  <section class="card">
    <h2>📋 貼到 LINE 群組</h2>
    <label class="check"><input type="checkbox" data-action="include-expenses" ${ui.includeExpenses ? 'checked' : ''} /> 包含每筆費用明細</label>
    <textarea id="report-text" readonly>${esc(text)}</textarea>
    <div class="row" style="margin-top:10px">
      <button class="btn primary grow" data-action="copy-report">一鍵複製文字</button>
      <a class="btn" href="https://line.me/R/share?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">分享到 LINE</a>
    </div>
  </section>`;
}

// ---------------- 範例資料 ----------------
function sampleActivity() {
  const a = newActivity('範例：墾丁三天兩夜');
  const [A, B, C, D] = ['小明家', '小華家', '小綠家', '小美家'].map((name, i) => ({
    id: uid(), name, adults: [2, 2, 2, 1][i], children: [1, 2, 0, 1][i],
  }));
  a.families = [A, B, C, D];
  a.roundingFamilyId = A.id;
  const all = a.families.map((f) => f.id);
  a.expenses = [
    { id: uid(), name: '民宿房費', category: 'room',
      payments: [{ familyId: A.id, amount: 6000, note: '訂金' }, { familyId: B.id, amount: 18000, note: '尾款' }],
      split: { mode: 'fixed', amounts: { [A.id]: 8000, [B.id]: 9170, [C.id]: -1170, [D.id]: 8000 } } },
    { id: uid(), name: '第一晚燒肉', category: 'meal', payments: [{ familyId: C.id, amount: 7350, note: '' }],
      split: { mode: 'weighted', participants: all } },
    { id: uid(), name: '早餐', category: 'meal', payments: [{ familyId: D.id, amount: 1280, note: '' }],
      split: { mode: 'weighted', participants: all } },
    { id: uid(), name: '浮潛（三家）', category: 'other', payments: [{ familyId: B.id, amount: 4500, note: '' }],
      split: { mode: 'weighted', participants: [A.id, B.id, D.id] } },
  ];
  return a;
}

// ---------------- 事件 ----------------
function bindEvents() {
  $('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) setTab(b.dataset.tab);
  });

  $('#activity-select').addEventListener('change', (e) => {
    state.currentId = e.target.value;
    save(state);
    renderAll();
  });

  // 選單
  const menu = $('#menu');
  $('#menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true;
  });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    menu.hidden = true;
    menuAction(b.dataset.action);
  });

  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const list = Array.isArray(data.activities) ? data.activities : [data];
      let n = 0;
      for (const raw of list) {
        const a = normalizeActivity(raw);
        if (!a) continue;
        if (state.activities.some((x) => x.id === a.id)) a.id = uid();
        state.activities.push(a);
        state.currentId = a.id;
        n++;
      }
      if (!n) throw new Error('empty');
      persist();
      renderAll();
      toast(`已匯入 ${n} 個活動`);
    } catch {
      toast('檔案格式不正確，無法匯入');
    }
  });

  // 主畫面（事件委派）
  const view = $('#view');
  view.addEventListener('click', (e) => {
    const go = e.target.closest('[data-tab-go]');
    if (go) return setTab(go.dataset.tabGo);
    const b = e.target.closest('[data-action]');
    if (!b) return;
    viewAction(b.dataset.action, b);
  });
  view.addEventListener('input', onViewInput);
  view.addEventListener('change', (e) => {
    if (e.target.dataset.action === 'include-expenses') {
      ui.includeExpenses = e.target.checked;
      writePref('includeExpenses', ui.includeExpenses ? '1' : '0');
      renderView();
    }
  });

  const dlg = $('#expense-dialog');
  dlg.addEventListener('input', onDialogInput);
  dlg.addEventListener('change', onDialogInput);
  dlg.addEventListener('focusout', onDialogBlur);
  dlg.addEventListener('focusin', onDialogFocusIn);
  dlg.addEventListener('click', onDialogClick);
  dlg.addEventListener('submit', onDialogSubmit);
  dlg.addEventListener('close', () => (draft = null));
}

function onViewInput(e) {
  const el = e.target;
  const a = cur();
  if (el.dataset.bind === 'name') {
    a.name = el.value;
    persist();
    const opt = $(`#activity-select option[value="${a.id}"]`);
    if (opt) opt.textContent = a.name || '未命名活動';
  } else if (el.dataset.bind === 'w-adult' || el.dataset.bind === 'w-child') {
    const v = parseFloat(el.value);
    if (!Number.isFinite(v) || v < 0) return el.classList.add('invalid');
    el.classList.remove('invalid');
    a.weights[el.dataset.bind === 'w-adult' ? 'adult' : 'child'] = v;
    persist();
    refreshSetupDerived();
  } else if (el.dataset.bind === 'rounding') {
    a.roundingFamilyId = el.value || null;
    persist();
  } else if (el.dataset.famName) {
    const f = a.families.find((x) => x.id === el.dataset.famName);
    if (!f) return;
    f.name = el.value;
    persist();
    const rs = $('#rounding-select');
    if (rs) rs.innerHTML = roundingOptions(a);
  }
}

function viewAction(action, b) {
  const a = cur();
  switch (action) {
    case 'add-family': {
      const f = { id: uid(), name: `家庭 ${a.families.length + 1}`, adults: 2, children: 0 };
      a.families.push(f);
      if (!a.roundingFamilyId) a.roundingFamilyId = f.id;
      persist();
      renderView();
      const input = $(`[data-fam-name="${f.id}"]`);
      input?.focus();
      input?.select();
      break;
    }
    case 'del-family': {
      const f = a.families.find((x) => x.id === b.dataset.id);
      if (!f) return;
      const refs = familyReferences(a, f.id);
      if (refs.length) {
        alert(`「${f.name}」在以下費用中有付款或指定金額，請先修改這些費用再刪除：\n\n${refs.map((e) => '・' + (e.name || '未命名')).join('\n')}`);
        return;
      }
      if (!confirm(`確定刪除「${f.name || '未命名'}」？`)) return;
      a.families = a.families.filter((x) => x.id !== f.id);
      for (const e of a.expenses) {
        if (e.split.mode === 'weighted') e.split.participants = e.split.participants.filter((id) => id !== f.id);
        else delete e.split.amounts[f.id];
      }
      if (a.roundingFamilyId === f.id) a.roundingFamilyId = a.families[0]?.id ?? null;
      persist();
      renderView();
      break;
    }
    case 'step': {
      const f = a.families.find((x) => x.id === b.dataset.id);
      if (!f) return;
      const field = b.dataset.field;
      f[field] = Math.max(0, num(f[field]) + Number(b.dataset.delta));
      persist();
      refreshSetupDerived();
      break;
    }
    case 'new-expense':
      openExpense(null);
      refreshDialogDerived();
      break;
    case 'edit-expense':
      openExpense(b.dataset.id);
      refreshDialogDerived();
      break;
    case 'result-view':
      ui.resultView = b.dataset.v;
      writePref('resultView', ui.resultView);
      renderView();
      break;
    case 'copy-report':
      copyText($('#report-text').value).then((ok) => toast(ok ? '已複製，貼到 LINE 群組吧！' : '複製失敗，請手動選取文字'));
      break;
  }
}

async function menuAction(action) {
  const a = cur();
  switch (action) {
    case 'new-activity': {
      const name = prompt('活動名稱', '新活動');
      if (name === null) return;
      const n = newActivity(name.trim() || '新活動');
      state.activities.push(n);
      state.currentId = n.id;
      persist();
      ui.tab = 'setup';
      writePref('tab', 'setup');
      renderAll();
      break;
    }
    case 'load-sample': {
      const s = sampleActivity();
      state.activities.push(s);
      state.currentId = s.id;
      persist();
      renderAll();
      toast('已載入範例活動');
      break;
    }
    case 'delete-activity': {
      if (!confirm(`確定刪除活動「${a.name}」？此動作無法復原。`)) return;
      state.activities = state.activities.filter((x) => x.id !== a.id);
      state.currentId = state.activities[0]?.id ?? null;
      cur();
      persist();
      renderAll();
      toast('已刪除活動');
      break;
    }
    case 'export': {
      const blob = new Blob([JSON.stringify(a, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `分好帳-${(a.name || 'activity').replace(/[\\/:*?"<>|]/g, '_')}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      break;
    }
    case 'import':
      $('#import-file').click();
      break;
    case 'share-link': {
      try {
        const code = await encodeShare(a);
        const url = `${location.origin}${location.pathname}#d=${code}`;
        const ok = await copyText(url);
        toast(ok ? '分享連結已複製（資料都在連結裡）' : '複製失敗');
        if (!ok) prompt('請手動複製連結', url);
      } catch {
        toast('產生連結失敗');
      }
      break;
    }
  }
}

/** 開啟分享連結時匯入資料 */
async function importFromHash() {
  const m = location.hash.match(/^#d=([A-Za-z0-9_-]+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const a = await decodeShare(m[1]);
    if (!a) throw new Error('bad');
    const existing = state.activities.findIndex((x) => x.id === a.id);
    if (existing >= 0) {
      if (!confirm(`本機已有「${state.activities[existing].name}」，要用連結中的資料覆蓋嗎？\n（取消則另存一份）`)) {
        a.id = uid();
        state.activities.push(a);
      } else {
        state.activities[existing] = a;
      }
    } else {
      if (!confirm(`要匯入分享的活動「${a.name}」嗎？`)) return;
      state.activities.push(a);
    }
    state.currentId = a.id;
    persist();
    renderAll();
    toast('已匯入分享的活動');
  } catch {
    toast('分享連結無效或已損毀');
  }
}

// ---------------- 啟動 ----------------
cur();
if (!['setup', 'expenses', 'result'].includes(ui.tab)) ui.tab = 'setup';
if (!cur().families.length) ui.tab = 'setup';
bindEvents();
renderAll();
importFromHash();

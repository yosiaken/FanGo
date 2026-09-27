// 本機儲存（localStorage）與分享連結編解碼
import { DEFAULT_WEIGHTS } from './calc.js';

const KEY = 'fango:v1';

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
}

/** @returns {import('./calc.js').Activity} */
export function newActivity(name = '新活動') {
  const a = { id: uid(), name, families: [], weights: { ...DEFAULT_WEIGHTS }, roundingFamilyId: null, expenses: [], updatedAt: Date.now() };
  return a;
}

/** @returns {{activities: import('./calc.js').Activity[], currentId: string|null}} */
export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (Array.isArray(data.activities)) {
        data.activities = data.activities
          .map((raw) => {
            const a = normalizeActivity(raw);
            // 雲端同步狀態只保留在本機儲存中（匯入／分享連結不帶，避免誤連到別人的雲端資料）
            if (a && raw.cloud && typeof raw.cloud === 'object' && raw.cloud.synced) a.cloud = raw.cloud;
            return a;
          })
          .filter(Boolean);
        return data;
      }
    }
  } catch {
    /* 無法讀取（私密模式等）時從空白開始 */
  }
  return { activities: [], currentId: null };
}

let saveFailed = false;
export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    saveFailed = false;
  } catch {
    saveFailed = true;
  }
  return !saveFailed;
}

/** 修正匯入／舊版資料的欄位，避免計算時出錯 */
export function normalizeActivity(a) {
  if (!a || typeof a !== 'object') return null;
  const families = Array.isArray(a.families)
    ? a.families.map((f) => ({ id: String(f.id ?? uid()), name: String(f.name ?? ''), adults: Number(f.adults) || 0, children: Number(f.children) || 0 }))
    : [];
  const expenses = Array.isArray(a.expenses)
    ? a.expenses.map((e) => ({
        id: String(e.id ?? uid()),
        ...(Number.isFinite(e.createdAt) ? { createdAt: e.createdAt } : {}),
        name: String(e.name ?? ''),
        category: ['room', 'meal', 'other'].includes(e.category) ? e.category : 'other',
        payments: Array.isArray(e.payments)
          ? e.payments.map((p) => ({ familyId: String(p.familyId ?? ''), amount: Number(p.amount) || 0, note: p.note ? String(p.note) : '' }))
          : [],
        split:
          e.split?.mode === 'fixed'
            ? { mode: 'fixed', amounts: { ...(e.split.amounts ?? {}) } }
            : normalizeWeighted(e.split, families),
      }))
    : [];
  return {
    id: String(a.id ?? uid()),
    name: String(a.name ?? '未命名活動'),
    families,
    weights: {
      adult: Number.isFinite(Number(a.weights?.adult)) ? Number(a.weights.adult) : DEFAULT_WEIGHTS.adult,
      child: Number.isFinite(Number(a.weights?.child)) ? Number(a.weights.child) : DEFAULT_WEIGHTS.child,
    },
    roundingFamilyId: a.roundingFamilyId ? String(a.roundingFamilyId) : null,
    expenses,
    updatedAt: Number(a.updatedAt) || Date.now(),
  };
}

function normalizeWeighted(split, families) {
  const out = {
    mode: 'weighted',
    participants: Array.isArray(split?.participants) ? split.participants.map(String) : families.map((f) => f.id),
  };
  const w = split?.weights;
  if (w && Number.isFinite(Number(w.adult)) && Number.isFinite(Number(w.child))) {
    out.weights = { adult: Number(w.adult), child: Number(w.child) };
  }
  if (split?.shares && typeof split.shares === 'object') {
    const shares = {};
    for (const [id, v] of Object.entries(split.shares)) if (Number.isFinite(Number(v))) shares[String(id)] = Math.max(0, Number(v));
    if (Object.keys(shares).length) out.shares = shares;
  }
  return out;
}

// ---- 分享連結：JSON → deflate → base64url，放在網址 # 後面（不會傳到伺服器） ----

function toB64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

export async function encodeShare(activity) {
  const json = new TextEncoder().encode(JSON.stringify(activity));
  if (typeof CompressionStream === 'function') {
    return 'z' + toB64url(await pipe(json, new CompressionStream('deflate-raw')));
  }
  return 'j' + toB64url(json);
}

export async function decodeShare(code) {
  const kind = code[0];
  const bytes = fromB64url(code.slice(1));
  const json = kind === 'z' ? await pipe(bytes, new DecompressionStream('deflate-raw')) : bytes;
  return normalizeActivity(JSON.parse(new TextDecoder().decode(json)));
}

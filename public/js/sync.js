// 雲端同步（Cloudflare Worker + D1）
//
// 每趟雲端出遊在本機的 activity 上多一個 cloud 欄位：
//   cloud = { rev, settingsVersion, versions: {expenseId: version}, synced: {settings, expenses: {id: data}}, hasGroup }
// synced 是「上次與伺服器一致的內容」。本機內容與它不同 = 有尚未上傳的修改，因此 app 只要照常修改
// activity 再呼叫 requestSync()，不需要記錄每個動作。
// 衝突處理：
//   設定（名稱、家庭、權重）→ 以 synced 為基準做三方合併，家庭以 id 為單位
//   單筆費用 → 以 version 偵測，兩人同時改同一筆時詢問要保留哪一版

const API = 'api';

// ---------------- 純函式（可在 Node 測試） ----------------

/** 鍵排序後的 JSON，用來比較內容是否相同 */
export function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
}
const same = (a, b) => canon(a) === canon(b);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function settingsOf(a) {
  return { name: a.name, families: a.families, weights: a.weights, roundingFamilyId: a.roundingFamilyId };
}

function applySettings(a, s) {
  a.name = String(s.name ?? '');
  a.families = clone(s.families ?? []);
  a.weights = clone(s.weights ?? { adult: 1, child: 0.5 });
  a.roundingFamilyId = s.roundingFamilyId ?? null;
}

/**
 * 三方合併設定：base = 上次同步版本，local = 我的，remote = 伺服器最新。
 * 欄位層級：我改過的用我的，否則用伺服器的；家庭以 id 為單位合併（新增都保留、刪除與修改衝突時保留修改）。
 */
export function mergeSettings(base, local, remote) {
  base ??= { families: [] };
  const pick = (k) => (same(local[k], base[k]) ? remote[k] : local[k]);
  const byId = (list) => new Map((list ?? []).map((f) => [f.id, f]));
  const B = byId(base.families);
  const L = byId(local.families);
  const R = byId(remote.families);

  const families = [];
  for (const r of remote.families ?? []) {
    const l = L.get(r.id);
    const b = B.get(r.id);
    if (l) families.push(b && same(l, b) ? r : l);
    else if (!b || !same(r, b)) families.push(r); // 別人新增的，或我刪了但別人改過 → 保留
  }
  for (const l of local.families ?? []) {
    if (R.has(l.id)) continue;
    const b = B.get(l.id);
    if (!b || !same(l, b)) families.push(l); // 我新增的，或別人刪了但我改過 → 保留
  }

  const merged = { name: pick('name'), weights: pick('weights'), roundingFamilyId: pick('roundingFamilyId'), families: clone(families) };
  if (!merged.families.some((f) => f.id === merged.roundingFamilyId)) merged.roundingFamilyId = merged.families[0]?.id ?? null;
  return merged;
}

/**
 * 把伺服器資料套用到本機（尚未上傳的修改保留在本機，等上傳時再處理衝突）。
 * @returns {boolean} 畫面是否需要更新
 */
export function applyRemote(a, r) {
  const c = a.cloud;
  const before = canon({ s: settingsOf(a), e: a.expenses });

  const local = settingsOf(a);
  applySettings(a, same(local, c.synced.settings) ? r.settings : mergeSettings(c.synced.settings, local, r.settings));
  c.synced.settings = clone(r.settings);
  c.settingsVersion = r.settingsVersion;

  const remote = new Map(r.expenses.map((x) => [x.id, x]));
  const next = [];
  for (const e of a.expenses) {
    const syncedData = c.synced.expenses[e.id];
    const dirty = !same(e, syncedData);
    const rx = remote.get(e.id);
    if (dirty) next.push(e); // 本機有修改：先保留，上傳時若版本不同會詢問
    else if (rx) {
      next.push(clone(rx.data));
      c.synced.expenses[e.id] = clone(rx.data);
      c.versions[e.id] = rx.version;
    } else {
      // 已同步過、本機沒改，但伺服器上沒了 → 別人刪除
      delete c.synced.expenses[e.id];
      delete c.versions[e.id];
    }
  }
  const localIds = new Set(a.expenses.map((e) => e.id));
  for (const rx of r.expenses) {
    if (localIds.has(rx.id)) continue;
    if (c.synced.expenses[rx.id] && c.versions[rx.id] === rx.version) continue; // 我刪了、等待上傳
    next.push(clone(rx.data));
    c.synced.expenses[rx.id] = clone(rx.data);
    c.versions[rx.id] = rx.version;
  }
  a.expenses = next;
  c.rev = r.rev;
  c.hasGroup = !!r.hasGroup;
  return before !== canon({ s: settingsOf(a), e: a.expenses });
}

/** 本機是否有尚未上傳的修改 */
export function hasPending(a) {
  const c = a.cloud;
  if (!c) return false;
  if (!same(settingsOf(a), c.synced.settings)) return true;
  const ids = new Set(a.expenses.map((e) => e.id));
  if (Object.keys(c.synced.expenses).some((id) => !ids.has(id))) return true;
  return a.expenses.some((e) => !same(e, c.synced.expenses[e.id]));
}

/** 從伺服器回應建立本機 activity */
export function activityFromRemote(r) {
  const a = { id: r.id, name: '', families: [], weights: { adult: 1, child: 0.5 }, roundingFamilyId: null, expenses: [], updatedAt: Date.now() };
  applySettings(a, r.settings);
  a.expenses = r.expenses.map((x) => clone(x.data));
  a.cloud = {
    rev: r.rev,
    settingsVersion: r.settingsVersion,
    hasGroup: !!r.hasGroup,
    versions: Object.fromEntries(r.expenses.map((x) => [x.id, x.version])),
    synced: { settings: clone(r.settings), expenses: Object.fromEntries(r.expenses.map((x) => [x.id, clone(x.data)])) },
  };
  return a;
}

// ---------------- 網路 ----------------

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`${API}/${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, { error: '無法連線' });
  }
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON（例如純靜態主機沒有 API） */ }
  if (!res.ok || !data) throw new ApiError(data ? res.status : 0, data ?? { error: '伺服器沒有回應' });
  return data;
}

export const fetchTrip = async (id) => activityFromRemote(await api('GET', `trips/${encodeURIComponent(id)}`));

/** 把本機活動上傳成雲端出遊（回傳新的 activity，id 會變成雲端 id） */
export async function uploadActivity(a, groupCode) {
  const r = await api('POST', 'trips', { settings: settingsOf(a), expenses: a.expenses, groupCode: groupCode || undefined });
  return activityFromRemote(r);
}

export const lookupGroup = (code) => api('POST', 'groups/lookup', { code });
export const setTripGroup = (id, groupCode) => api('PUT', `trips/${encodeURIComponent(id)}/group`, { groupCode: groupCode || null });
export const deleteTrip = (id) => api('DELETE', `trips/${encodeURIComponent(id)}`);

async function pull(a, full = false) {
  const r = await api('GET', `trips/${encodeURIComponent(a.id)}${full ? '' : `?rev=${a.cloud.rev}`}`);
  if (r.unchanged) return false;
  return applyRemote(a, r);
}

/**
 * 上傳本機修改。onConflict({kind:'edit'|'delete', local, remote}) 需回傳 'mine' 或 'theirs'。
 * @returns {boolean} 本機資料是否因合併／衝突而改變
 */
async function push(a, onConflict) {
  const c = a.cloud;
  const tid = encodeURIComponent(a.id);
  let changed = false;

  // 設定
  for (let attempt = 0; attempt < 3; attempt++) {
    const s = clone(settingsOf(a));
    if (same(s, c.synced.settings)) break;
    try {
      const r = await api('PUT', `trips/${tid}/settings`, { settings: s, baseVersion: c.settingsVersion });
      c.synced.settings = s;
      c.settingsVersion = r.settingsVersion;
      break;
    } catch (e) {
      if (e.status !== 409) throw e;
      if (e.body.settings) {
        applySettings(a, mergeSettings(c.synced.settings, settingsOf(a), e.body.settings));
        c.synced.settings = clone(e.body.settings);
        c.settingsVersion = e.body.settingsVersion;
        changed = true;
      } else {
        changed = (await pull(a, true)) || changed;
      }
    }
  }

  // 新增／修改的費用
  for (const e of [...a.expenses]) {
    if (same(e, c.synced.expenses[e.id])) continue;
    const data = clone(e);
    const put = (force) => api('PUT', `trips/${tid}/expenses/${encodeURIComponent(e.id)}`, { data, baseVersion: c.versions[e.id] ?? 0, force });
    let r;
    try {
      r = await put(false);
    } catch (err) {
      if (err.status !== 409) throw err;
      if (!err.body.current) {
        changed = (await pull(a, true)) || changed;
        continue;
      }
      const cur = err.body.current;
      const choice = await onConflict({ kind: 'edit', local: data, remote: cur.deleted ? null : cur.data });
      if (choice === 'mine') {
        c.versions[e.id] = cur.version;
        r = await put(true);
      } else {
        const idx = a.expenses.findIndex((x) => x.id === e.id);
        if (cur.deleted) {
          if (idx >= 0) a.expenses.splice(idx, 1);
          delete c.synced.expenses[e.id];
          delete c.versions[e.id];
        } else {
          if (idx >= 0) a.expenses[idx] = clone(cur.data);
          c.synced.expenses[e.id] = clone(cur.data);
          c.versions[e.id] = cur.version;
        }
        changed = true;
        continue;
      }
    }
    c.synced.expenses[e.id] = data;
    c.versions[e.id] = r.version;
  }

  // 刪除的費用
  const ids = new Set(a.expenses.map((e) => e.id));
  for (const id of Object.keys(c.synced.expenses)) {
    if (ids.has(id)) continue;
    const del = (force) => api('DELETE', `trips/${tid}/expenses/${encodeURIComponent(id)}`, { baseVersion: c.versions[id] ?? 0, force });
    try {
      await del(false);
    } catch (err) {
      if (err.status !== 409) throw err;
      const cur = err.body.current;
      if (!cur) {
        changed = (await pull(a, true)) || changed;
        continue;
      }
      const choice = await onConflict({ kind: 'delete', local: null, remote: cur.data });
      if (choice === 'mine') {
        c.versions[id] = cur.version;
        await del(true);
      } else {
        a.expenses.push(clone(cur.data));
        c.synced.expenses[id] = clone(cur.data);
        c.versions[id] = cur.version;
        changed = true;
        continue;
      }
    }
    delete c.synced.expenses[id];
    delete c.versions[id];
  }
  return changed;
}

// ---------------- 同步排程 ----------------

/**
 * @param {{getCurrent: () => any, getAll: () => any[], onChange: (a:any) => void,
 *          onStatus: (s:{state:string, at?:number, error?:string}) => void,
 *          onConflict: (x:any) => Promise<'mine'|'theirs'>, save: () => void}} hooks
 */
export function createSyncer(hooks) {
  let running = false;
  let again = false;
  let timer = null;
  let poller = null;

  async function syncOne(a) {
    let changed = await pull(a);
    changed = (await push(a, hooks.onConflict)) || changed;
    hooks.save();
    if (changed) hooks.onChange(a);
  }

  async function run() {
    if (running) {
      again = true;
      return;
    }
    const current = hooks.getCurrent();
    running = true;
    try {
      // 目前這趟：拉取＋上傳，並回報狀態
      if (current?.cloud) {
        hooks.onStatus({ state: 'syncing' });
        try {
          await syncOne(current);
          hooks.onStatus({ state: hasPending(current) ? 'pending' : 'synced', at: Date.now() });
        } catch (e) {
          hooks.save();
          if (e.status === 404) hooks.onStatus({ state: 'gone', error: e.message });
          else hooks.onStatus({ state: e.status === 0 ? 'offline' : 'error', error: e.message });
        }
      } else {
        hooks.onStatus({ state: 'local' });
      }
      // 其他趟若還有沒上傳的修改（例如改完馬上切換），也一併上傳
      for (const a of hooks.getAll()) {
        if (a === current || !a.cloud || a.cloud.gone || !hasPending(a)) continue;
        try {
          await syncOne(a);
        } catch {
          /* 下次再試 */
        }
      }
    } finally {
      running = false;
      if (again) {
        again = false;
        setTimeout(run, 50);
      }
    }
  }

  return {
    /** 本機有修改：稍等一下再上傳（連續輸入時合併成一次） */
    request(delay = 800) {
      clearTimeout(timer);
      timer = setTimeout(run, delay);
    },
    now: run,
    /** 開始定期檢查別人的修改（畫面在前景時） */
    start(intervalMs = 15000) {
      clearInterval(poller);
      poller = setInterval(() => {
        if (document.visibilityState === 'visible') run();
      }, intervalMs);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') run();
      });
      window.addEventListener('online', () => run());
    },
  };
}

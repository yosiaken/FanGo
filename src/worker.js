// 分好帳 FanGo — 雲端同步 API（Cloudflare Worker + D1）
//
// 靜態網頁由 assets（public/）提供；找不到檔案的請求才會進到這裡，因此只需處理 /api/*。
//
// 資料模型：
//   trips     一趟出遊。settings 為 JSON（名稱、家庭、權重、尾差吸收者），rev 每次有任何變更就 +1
//   expenses  一筆費用一列，data 為 JSON；version 用來偵測同時修改；刪除為軟刪除（保留 tombstone）
// 存取控制：知道 trip id（隨機 12 碼）即可讀寫；群組代碼以 SHA-256 雜湊保存，用來列出同群組的出遊。

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    settings TEXT NOT NULL,
    settings_version INTEGER NOT NULL DEFAULT 1,
    rev INTEGER NOT NULL DEFAULT 1,
    group_hash TEXT,
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS trips_group ON trips(group_hash)`,
  `CREATE TABLE IF NOT EXISTS expenses (
    trip_id TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    deleted INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (trip_id, id)
  )`,
];

const MAX_SETTINGS = 100_000;
const MAX_EXPENSE = 20_000;
const MAX_EXPENSES_PER_TRIP = 2000;
const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;

let schemaReady = null;
function ensureSchema(db) {
  schemaReady ??= db.batch(SCHEMA.map((s) => db.prepare(s))).catch((e) => {
    schemaReady = null;
    throw e;
  });
  return schemaReady;
}

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export function newTripId() {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

export async function hashGroup(code) {
  const norm = String(code ?? '').trim().toLowerCase();
  if (norm.length < 4 || norm.length > 64) throw new HttpError(400, '群組代碼需為 4～64 個字元');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('fango-group:' + norm));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function readBody(req, max) {
  const text = await req.text();
  if (text.length > max) throw new HttpError(413, '資料太大');
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new HttpError(400, 'JSON 格式錯誤');
  }
}

function checkSettings(s) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.families)) throw new HttpError(400, 'settings 格式錯誤');
  const text = JSON.stringify(s);
  if (text.length > MAX_SETTINGS) throw new HttpError(413, '資料太大');
  return text;
}

function checkExpense(d, id) {
  if (!d || typeof d !== 'object' || d.id !== id || !Array.isArray(d.payments) || !d.split) {
    throw new HttpError(400, '費用格式錯誤');
  }
  const text = JSON.stringify(d);
  if (text.length > MAX_EXPENSE) throw new HttpError(413, '資料太大');
  return text;
}

async function getTripRow(db, id) {
  if (!ID_RE.test(id)) throw new HttpError(404, '找不到這趟出遊');
  const row = await db.prepare('SELECT * FROM trips WHERE id = ? AND deleted = 0').bind(id).first();
  if (!row) throw new HttpError(404, '找不到這趟出遊');
  return row;
}

async function tripPayload(db, row) {
  const { results } = await db
    .prepare('SELECT id, data, version FROM expenses WHERE trip_id = ? AND deleted = 0')
    .bind(row.id)
    .all();
  return {
    id: row.id,
    rev: row.rev,
    settings: JSON.parse(row.settings),
    settingsVersion: row.settings_version,
    hasGroup: !!row.group_hash,
    updatedAt: row.updated_at,
    expenses: results.map((r) => ({ id: r.id, version: r.version, data: JSON.parse(r.data) })),
  };
}

const bumpRev = (db, id, now) => db.prepare('UPDATE trips SET rev = rev + 1, updated_at = ? WHERE id = ?').bind(now, id);

// ---------------- 路由 ----------------

async function handle(req, env) {
  const db = env.DB;
  if (!db) throw new HttpError(503, '伺服器尚未設定 D1 資料庫');
  await ensureSchema(db);

  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const m = req.method;
  const now = Date.now();

  // POST /api/trips  建立（或上傳本機的）出遊
  if (m === 'POST' && parts.length === 1 && parts[0] === 'trips') {
    const body = await readBody(req, MAX_SETTINGS + MAX_EXPENSE * MAX_EXPENSES_PER_TRIP);
    const settingsText = checkSettings(body.settings);
    const expenses = Array.isArray(body.expenses) ? body.expenses : [];
    if (expenses.length > MAX_EXPENSES_PER_TRIP) throw new HttpError(413, '費用筆數太多');
    const id = newTripId();
    const groupHash = body.groupCode ? await hashGroup(body.groupCode) : null;
    const stmts = [
      db.prepare('INSERT INTO trips (id, name, settings, group_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, String(body.settings.name ?? '').slice(0, 100), settingsText, groupHash, now, now),
    ];
    for (const e of expenses) {
      if (!e || !ID_RE.test(String(e.id))) throw new HttpError(400, '費用 id 格式錯誤');
      stmts.push(
        db.prepare('INSERT INTO expenses (trip_id, id, data, updated_at) VALUES (?, ?, ?, ?)')
          .bind(id, e.id, checkExpense(e, e.id), now),
      );
    }
    await db.batch(stmts);
    return json(await tripPayload(db, await getTripRow(db, id)), 201);
  }

  // POST /api/groups/lookup  {code} → 列出群組內的出遊（代碼放在 body，避免出現在網址紀錄中）
  if (m === 'POST' && parts.length === 2 && parts[0] === 'groups' && parts[1] === 'lookup') {
    const body = await readBody(req, 1000);
    const hash = await hashGroup(body.code);
    const { results } = await db
      .prepare('SELECT id, name, updated_at FROM trips WHERE group_hash = ? AND deleted = 0 ORDER BY updated_at DESC LIMIT 200')
      .bind(hash)
      .all();
    return json({ trips: results.map((r) => ({ id: r.id, name: r.name, updatedAt: r.updated_at })) });
  }

  if (parts[0] !== 'trips' || !parts[1]) throw new HttpError(404, 'Not found');
  const tripId = parts[1];

  // GET /api/trips/:id?rev=N  rev 沒變就只回 unchanged（只讀 1 列，省 D1 額度）
  if (m === 'GET' && parts.length === 2) {
    const row = await getTripRow(db, tripId);
    const known = Number(url.searchParams.get('rev'));
    if (known && known === row.rev) return json({ unchanged: true, rev: row.rev });
    return json(await tripPayload(db, row));
  }

  // DELETE /api/trips/:id  從雲端刪除整趟
  if (m === 'DELETE' && parts.length === 2) {
    await getTripRow(db, tripId);
    await db.prepare('UPDATE trips SET deleted = 1, updated_at = ? WHERE id = ?').bind(now, tripId).run();
    return json({ ok: true });
  }

  // PUT /api/trips/:id/settings  {settings, baseVersion, force?}
  if (m === 'PUT' && parts.length === 3 && parts[2] === 'settings') {
    const body = await readBody(req, MAX_SETTINGS + 1000);
    const text = checkSettings(body.settings);
    const row = await getTripRow(db, tripId);
    if (!body.force && Number(body.baseVersion) !== row.settings_version) {
      throw new HttpError(409, '設定已被其他人修改', {
        settings: JSON.parse(row.settings),
        settingsVersion: row.settings_version,
      });
    }
    const res = await db
      .prepare('UPDATE trips SET settings = ?, name = ?, settings_version = settings_version + 1, rev = rev + 1, updated_at = ? WHERE id = ? AND settings_version = ?')
      .bind(text, String(body.settings.name ?? '').slice(0, 100), now, tripId, row.settings_version)
      .run();
    if (!res.meta.changes) throw new HttpError(409, '設定已被其他人修改', { retry: true });
    return json({ settingsVersion: row.settings_version + 1, rev: row.rev + 1 });
  }

  // PUT /api/trips/:id/group  {groupCode | null}
  if (m === 'PUT' && parts.length === 3 && parts[2] === 'group') {
    const body = await readBody(req, 1000);
    await getTripRow(db, tripId);
    const hash = body.groupCode ? await hashGroup(body.groupCode) : null;
    await db.prepare('UPDATE trips SET group_hash = ?, updated_at = ? WHERE id = ?').bind(hash, now, tripId).run();
    return json({ ok: true, hasGroup: !!hash });
  }

  // PUT / DELETE /api/trips/:id/expenses/:eid  {data, baseVersion (新增為 0), force?}
  if ((m === 'PUT' || m === 'DELETE') && parts.length === 4 && parts[2] === 'expenses') {
    const eid = parts[3];
    if (!ID_RE.test(eid)) throw new HttpError(400, '費用 id 格式錯誤');
    const body = await readBody(req, MAX_EXPENSE + 1000);
    await getTripRow(db, tripId);
    const cur = await db.prepare('SELECT data, version, deleted FROM expenses WHERE trip_id = ? AND id = ?').bind(tripId, eid).first();
    const curVersion = cur ? cur.version : 0;
    const base = Number(body.baseVersion) || 0;

    if (m === 'DELETE') {
      if (!cur || cur.deleted) return json({ ok: true, version: curVersion });
      if (!body.force && base !== curVersion) {
        throw new HttpError(409, '這筆費用已被其他人修改', { current: { version: cur.version, data: JSON.parse(cur.data) } });
      }
      const [res] = await db.batch([
        db.prepare('UPDATE expenses SET deleted = 1, version = version + 1, updated_at = ? WHERE trip_id = ? AND id = ? AND version = ?')
          .bind(now, tripId, eid, curVersion),
        bumpRev(db, tripId, now),
      ]);
      if (!res.meta.changes) throw new HttpError(409, '這筆費用已被其他人修改', { retry: true });
      return json({ ok: true, version: curVersion + 1 });
    }

    const text = checkExpense(body.data, eid);
    if (!body.force && base !== curVersion && !(cur?.deleted && base === 0)) {
      throw new HttpError(409, '這筆費用已被其他人修改', {
        current: cur && !cur.deleted ? { version: cur.version, data: JSON.parse(cur.data) } : { version: curVersion, deleted: true },
      });
    }
    if (!cur) {
      const { count } = await db.prepare('SELECT COUNT(*) AS count FROM expenses WHERE trip_id = ?').bind(tripId).first();
      if (count >= MAX_EXPENSES_PER_TRIP) throw new HttpError(413, '費用筆數太多');
    }
    // 以 version 作為條件寫入，確保兩人同時儲存時只有一方成功
    const write = cur
      ? db.prepare('UPDATE expenses SET data = ?, version = version + 1, deleted = 0, updated_at = ? WHERE trip_id = ? AND id = ? AND version = ?')
          .bind(text, now, tripId, eid, curVersion)
      : db.prepare('INSERT OR IGNORE INTO expenses (trip_id, id, data, version, deleted, updated_at) VALUES (?, ?, ?, 1, 0, ?)')
          .bind(tripId, eid, text, now);
    const [res] = await db.batch([write, bumpRev(db, tripId, now)]);
    if (!res.meta.changes) throw new HttpError(409, '這筆費用已被其他人修改', { retry: true });
    return json({ ok: true, version: curVersion + 1 });
  }

  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) {
      // 理論上靜態檔案不會進到這裡；保險起見交回 assets
      return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Not found', { status: 404 });
    }
    try {
      return await handle(req, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...(e.extra ?? {}) }, e.status);
      console.error(e);
      return json({ error: '伺服器錯誤' }, 500);
    }
  },
};

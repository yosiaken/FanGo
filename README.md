# 分好帳 FanGo

多家庭出遊分帳工具。前端免建置；可選擇只存在手機，或透過 Cloudflare Worker + D1 雲端同步，讓同行的人跨裝置一起記帳。

## 功能

- **家庭設定**：家庭名稱、大人數、小孩數；分攤權重（預設大人 1、小孩 0.5，可改）；指定尾差由哪一家吸收
- **費用紀錄**：項目、類別（房費／餐費／其他）、誰付的（可多筆，訂金、預付、尾款分開記）
  - 按權重均分（可只勾選部分家庭）
    - 可針對單筆費用自訂大人／小孩權重，或直接改某家的份數（例如這餐某家只去 2 人）
  - 指定每家金額（可填負數代表退錢，加總必須等於費用總額）
  - 金額欄可輸入算式，例如 `1200+350`、`500*3`
- **結算**
  - 每家明細：房費、餐費份額、其他、尾差、應付、已代墊、淨額
  - 自動檢查所有家庭淨額加總 = 0
  - 轉帳清單：以零和分組演算法求最少轉帳次數
  - 一鍵複製成文字、直接分享到 LINE
- **雲端同步**（詳見下方）：共用連結多人一起編輯、群組代碼找回所有出遊
- **其他**：多個活動切換、離線可用、JSON 匯出／匯入備份

## 雲端同步

- 新增活動時預設建立在雲端（離線時先存本機，之後可在設定頁「上傳到雲端」）
- 每趟出遊有專屬連結 `https://<網域>/#t=<id>`，打開連結即可一起新增、修改費用
- 畫面在前景時每 15 秒自動檢查別人的修改；修改後約 1 秒上傳；離線時先存手機、連線後自動上傳
- 衝突處理
  - 設定（名稱、家庭、權重）：三方合併，不同人改不同欄位／不同家庭都會保留
  - 單筆費用：兩人同時修改同一筆時，會詢問要保留哪一個版本；不同筆互不影響
- **群組代碼**：同一群朋友共用一個代碼，在任何裝置輸入即可列出群組內所有出遊。代碼以 SHA-256 雜湊保存
- 安全性：沒有帳號系統，**知道連結或群組代碼的人就能讀寫**，請只分享給同行的人

API（`src/worker.js`）：

| Method | Path | 說明 |
|---|---|---|
| POST | `/api/trips` | 建立／上傳出遊 `{settings, expenses, groupCode?}` |
| GET | `/api/trips/:id?rev=N` | 取得出遊；`rev` 沒變時只回 `{unchanged:true}` |
| PUT | `/api/trips/:id/settings` | 更新設定 `{settings, baseVersion}`，版本不符回 409 |
| PUT / DELETE | `/api/trips/:id/expenses/:eid` | 新增／修改／刪除費用 `{data, baseVersion}`，版本不符回 409 |
| PUT | `/api/trips/:id/group` | 加入／移出群組 `{groupCode}` |
| POST | `/api/groups/lookup` | 列出群組內的出遊 `{code}` |
| DELETE | `/api/trips/:id` | 從雲端刪除 |

資料表在第一次呼叫 API 時自動建立，不需要手動跑 migration。

## 計算規則

- 每家應付 = 各筆費用中該家應分攤金額加總（依類別四捨五入到元）
- 每家已付 = 該家所有付款加總
- 淨額 = 已付 − 應付（正數拿回、負數要補）
- 四捨五入後與總支出的差額，全部由「尾差吸收」那一家承擔，確保淨額加總恰為 0
- 資料有誤的費用（例如指定金額加總不符）整筆不列入計算，並在畫面上提示

## 部署到 Cloudflare

`wrangler.jsonc` 已設定好 Worker（`src/worker.js`）、靜態檔案（`public/`）與 D1 資料庫（binding `DB`）。

**Workers（連接 GitHub）**：Build command 留空，Deploy command 用 `npx wrangler deploy`。
`d1_databases` 沒有填 `database_id` 時，wrangler 會在部署時自動建立名為 `fango-db` 的 D1 資料庫並綁定。

若部署 log 顯示無法自動建立（權限不足），請手動建立：

1. Cloudflare Dashboard → Storage & Databases → D1 → Create，名稱填 `fango-db`
2. 複製 Database ID，填到 `wrangler.jsonc` 的 `"database_id"`，推送後重新部署

免費方案（D1 每天讀 500 萬列、寫 10 萬列；Workers 每天 10 萬次請求）對家庭出遊的用量綽綽有餘。

## 本機開發

```bash
npm install
npm run dev     # wrangler dev：本機 Worker + 本機 D1，開 http://localhost:8787
npm test        # 計算、轉帳、同步合併邏輯的單元測試（Node 內建 test runner）
```

只看前端也可以 `cd public && python3 -m http.server`（沒有 API 時會自動以「只存本機」模式運作）。

## 檔案結構

```
public/               部署的靜態檔案
  index.html          頁面外框
  css/style.css       樣式（含深色模式）
  js/calc.js          分帳計算核心
  js/settle.js        最少轉帳演算法
  js/report.js        LINE 文字輸出
  js/store.js         localStorage、分享連結
  js/sync.js          雲端同步（三方合併、衝突處理、排程）
  js/app.js           介面
src/worker.js         API（Cloudflare Worker + D1）
tests/                單元測試
wrangler.jsonc        Cloudflare 部署設定
```

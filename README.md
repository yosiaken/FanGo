# 分好帳 FanGo

多家庭出遊分帳工具。純前端、免建置、無後端，資料只存在自己的瀏覽器（localStorage）。

## 功能

- **家庭設定**：家庭名稱、大人數、小孩數；分攤權重（預設大人 1、小孩 0.5，可改）；指定尾差由哪一家吸收
- **費用紀錄**：項目、類別（房費／餐費／其他）、誰付的（可多筆，訂金、預付、尾款分開記）
  - 按權重均分（可只勾選部分家庭）
  - 指定每家金額（可填負數代表退錢，加總必須等於費用總額）
  - 金額欄可輸入算式，例如 `1200+350`、`500*3`
- **結算**
  - 每家明細：房費、餐費份額、其他、尾差、應付、已代墊、淨額
  - 自動檢查所有家庭淨額加總 = 0
  - 轉帳清單：以零和分組演算法求最少轉帳次數
  - 一鍵複製成文字、直接分享到 LINE
- **其他**：多個活動切換、分享連結（資料壓縮在網址 `#` 後，不經伺服器）、JSON 匯出／匯入備份

## 計算規則

- 每家應付 = 各筆費用中該家應分攤金額加總（依類別四捨五入到元）
- 每家已付 = 該家所有付款加總
- 淨額 = 已付 − 應付（正數拿回、負數要補）
- 四捨五入後與總支出的差額，全部由「尾差吸收」那一家承擔，確保淨額加總恰為 0
- 資料有誤的費用（例如指定金額加總不符）整筆不列入計算，並在畫面上提示

## 部署到 Cloudflare Pages

這是純靜態網站，不需要 build：

1. Cloudflare Dashboard → Workers & Pages → Create → Pages → 連接此 GitHub repo
2. Framework preset：**None**；Build command：**留空**；Build output directory：**`/`**
3. 儲存並部署

也可以用 Wrangler：`npx wrangler pages deploy . --project-name fango`

## 本機開發

```bash
npm run serve   # 或 python3 -m http.server，然後開 http://localhost:8000
npm test        # 計算邏輯單元測試（Node 內建 test runner，無需安裝套件）
```

> 因為使用 ES modules，請用本機伺服器開啟，直接雙擊 `index.html`（file://）會被瀏覽器擋下。

## 檔案結構

```
index.html            頁面外框
css/style.css         樣式（含深色模式）
js/calc.js            分帳計算核心
js/settle.js          最少轉帳演算法
js/report.js          LINE 文字輸出
js/store.js           localStorage、分享連結
js/app.js             介面
tests/                單元測試
```

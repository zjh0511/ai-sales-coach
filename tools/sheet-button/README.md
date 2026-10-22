# 試算表「📊 更新報表」按鈕（Apps Script）

使用者 2026-10-22 要的看報表方式：**需要時打開試算表、按一下才更新**，不定時、不自動、不放在 App 裡。

- 試算表：Google 雲端硬碟「AI業務教練 使用報表」（擁有者 zjh0511@gmail.com）
- 這兩個檔案是那份試算表裡 Apps Script 專案的備份（擴充功能 → Apps Script）。改了這裡要貼回去，反之亦然。
- 用「按按鈕的人自己的 Google 帳號」讀 Firebase（專案擁有者本來就有權限）→ **不需要服務帳戶、金鑰、GitHub**。
- 分頁：來源與裝置統計、成員總表、演練明細、更新紀錄（每按一次附一行）。內容與 `tools/report.mjs` 相同，兩邊欄位要一起改。
- 權限（appsscript.json 的 oauthScopes）：這份試算表、外部連線、自訂選單、Firebase 即時資料庫、E-mail、Google Cloud（讀註冊名單）。
  呼叫 Identity Toolkit 時帶 `x-goog-user-project: ai-sales-coach-4b4cb`——試算表背後自動建立的專案沒有開這個 API。
- 手機的試算表 App 不能按自訂選單（只能看）；要在電腦瀏覽器按。

**設定時踩到的**：Claude 內建瀏覽器太窄，試算表選單列會收起來（Ctrl+Shift+F 切換）；
Apps Script 會開新分頁，內建瀏覽器擋掉非使用者點擊開的分頁——攔截 `window.open` 拿到網址再直接前往。
第一次授權（Google「尚未驗證」→ 進階 → 前往）只能由使用者本人按。

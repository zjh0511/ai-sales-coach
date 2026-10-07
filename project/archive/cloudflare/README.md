# cloudflare\（來自 AI業務教練App：Cloudflare Workers + D1 的公開測試版）

2026-10-07 刪除 `D:\Hao+App\AI業務教練App` 之前保留下來的檔案。

**架構**：前端放 GitHub Pages；後端是 Cloudflare Worker + D1。金鑰經 AES-GCM 加密後存在後端，模型呼叫一律經過後端。登入用 Firebase，而且和 AiCoach 是同一個 Firebase 專案。

**期間**：2026-09-05 ～ 09-18。只做了痛點分析和電話約訪兩個功能。

這些程式原本互相引用，單獨放在這裡不能直接執行，只供參考或重用。

| 檔案 | 內容 |
|---|---|
| `MD檔\..._By Astra 0905.md` | 外部審查 AiCoach（commit bbc9105）的報告：P0／P1 清單、成熟度評分 |
| `MD檔\..._By Sol 0906.md` | V1 產品藍圖：4+1 架構、驗收案例 ACC-01～18、五星錨點、不做的範圍 |
| `MD檔\..._V1.0_2026-09-07.md` | 唯一記錄這些決策的版本：不能用 ChatGPT 帳號額度、Azure F0 額度試算、試點預算 |
| `MD檔\..._V1.4_待確認.md` | 最終企畫：使用者確認過的四項決策、金鑰在後端加密保存的規格 |
| `AI 業務教練 GPTs 提示詞.txt` | 原始 GPTs 提示詞，比 AiCoach 那份多了「Security Policy（智慧財產保護）」 |
| `server\security.mjs` | AES-GCM 加 AAD（綁 uid 和 id）、每個帳號各自的 HMAC 指紋、台灣個資正規表示式、429 分類 |
| `server\law.mjs` | 抓全國法規資料庫《保險業務員管理規則》第 19 條；抓不到就停止回答 |
| `server\practice-review.mjs`、`rapport.mjs` | 角色鎖定（customerRoleDrift／enforceRole）；練完後每 4 句一批做事後查核 |
| `server\audio-review.mjs` + `public\audio-capture.js`、`audio-worklet.js` | 聲音評分：錄音轉 16kHz WAV，送 Gemini 評三項聲音星等（AiCoach 沒有這個功能） |
| `server\store.mjs`、`schema.sql` | 用 revision 做 CAS 鎖，防止兩個分頁同時送出同一場演練 |
| `docs\*.md`（13 份） | 每次修正和驗收的實測紀錄（延遲、手機語音、登入、部署） |
| `tests\voice-lifecycle.test.mjs` | 用模擬的語音事件，測試收音和朗讀流程 |

沒有保留的檔案：
- 企畫書 V1.1～V1.3（已被 V1.4 取代）
- AI 生成的示意圖、原始截圖（可能看得到帳號資訊）
- `dist\`、其他伺服器與多服務商程式、一次性實測腳本、`artifacts\`
- `.private\`：加密主金鑰、本機資料庫、部署工具

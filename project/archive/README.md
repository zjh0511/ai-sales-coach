# archive：已刪除專案的保留資料

2026-10-07 從兩個準備刪除的閒置專案複製過來。重點整理在 `D:\Hao+App\AI業務教練_開發經驗彙整.md`。
這裡只保留原始文件和值得重用的程式，以後需要細節或想拿來用時可以查。
共用的規格文件（01～04、11 號）AiCoach 的 `MD檔\` 已經有相同的檔案，所以沒有重複複製。

## local\（來自 Ai_Sales_Coach_Local：在瀏覽器裡跑本地模型的版本）

| 檔案 | 內容 |
|---|---|
| `DECISION_LOG.md` | D001–D062，其中 D022 以後是本地模型的實測與踩坑（原本沒有進版控） |
| `MD檔\12_LOCAL_MODEL_DEV_PLAN.md` | 本地模型開發計畫 |
| `MD檔\13_LOCAL_MODEL_FINDINGS.md` | 實測結論：哪些模型、哪些裝置可行或不可行 |
| `MD檔\14_DEPLOY_GITHUB_PAGES.md` | 部署紀錄 |
| `docs\engine\scoring\turn-signals.js` | 每回合的確定性檢查（重複、自稱業務員、過度順從、照抄示範…） |
| `docs\engine\scoring\evaluate-local.js` | 五構面程式評分，每個扣分點都附證據 |
| `docs\engine\local\personas.js` | 10 種台灣壽險客戶原型，附痛點的 why／need／ask |
| `docs\engine\local\*.js` | 本地推論層（ONNX／GGUF runtime、模型清單、裝置分級、崩潰記憶） |
| `docs\engine\prompts.small.js` | 小模型用的壓縮提示詞、串流清洗器 |
| `docs\lab*.html`、`memtest.html`、`nettest.html`、`voicelab.html`、`voice-stream.js` | 量測頁：推論速度、記憶體上限、下載速度、語音延遲 |
| `未commit的Groq修改.patch` | 08-26 沒有 commit 的 Groq 支援修改（reasoning_effort、JSON 驗證失敗時重試、413 訊息） |

這些程式原本在 `docs\` 裡互相引用。單獨放在這裡不能直接執行，只供參考或重用。

## app\（來自 Ai_Sales_Coach_App：原生 iOS 規劃，從沒 commit 過）

| 檔案 | 內容 |
|---|---|
| `DECISION_LOG.md` | D001–D026，其中 D022–D026 是原生化的決策 |
| `MD檔\12_NATIVE_APP_DEV_PLAN.md` | iOS 上架清單、審查風險表、Mac 取得方式比較、N0 語音驗證關卡。下次做 iOS 直接當範本 |
| `engine\platform.js` + `engine\shims\` | 平台層：引擎不直接碰 Web API，同一份程式可以在瀏覽器、Node、iOS JavaScriptCore 上跑 |
| `tests\smoke.mjs` | 驗證平台層和錯誤分類，不需要金鑰 |

## cloudflare\（來自 AI業務教練App：Cloudflare Workers + D1 公開測試版，2026-10-07 保留）

內容見 `cloudflare\README.md`：產品企畫、外部審查報告、後端金鑰加密、法規查核、聲音評分、角色鎖定。

注意：三個專案的決策編號從 D022 開始各自不同，引用時要寫明是哪個專案的 D 編號。

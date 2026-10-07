# AI業務教練 開發經驗彙整

> 用途：未來開發類似專案（AI 對練、語音互動、給業務同仁用的工具）時，先讀這份，避免重踩舊坑。
> 整理日期：2026-10-07。來源：三個專案資料夾的決策紀錄、手冊、git 歷史與程式碼，以及開發過程的對話。
> 寫給未來的 Claude：先讀 §0 和 §6，需要細節再往下翻。原始決策紀錄在 `D:\Hao+App\AiCoach\project\DECISION_LOG.md`（D001–D046）。

---

## 0. 一頁摘要

- **最後走通的路線**：純前端 PWA，放在 GitHub Pages。使用者自帶免費的 Google AI Studio 金鑰，瀏覽器直接呼叫 Gemini。用 Firebase（REST）登入並同步訓練紀錄。不需要伺服器、建置步驟或 node_modules。
  - 網址：https://zjh0511.github.io/ai-sales-coach/
  - 程式：`D:\Hao+App\AiCoach\docs\`
- **放棄的三條路線，以及原因**
  1. **自架伺服器（Render）**：免費方案冷啟動要 30–60 秒，改成純前端（D015）。
  2. **瀏覽器內跑本地模型**（Ai_Sales_Coach_Local）：
     - 2B 以下的模型接不住對話；4B 勉強像真人客戶，但要下載約 2GB、每回合 3.5–4.3 秒，iPhone 跑不動。
     - 使用者實測後，覺得和 Gemini 差距明顯。
  3. **原生 iOS App**（Ai_Sales_Coach_App）：
     - 三個前提都沒到位：Mac、Apple 開發者帳號、測試用的實機。
     - PWA 已經提供「像 App」的體驗，原生 App 就不急了。
     - 原生唯一確定的好處是語音能被插話打斷，但從沒驗證過。
- **最重要的五個教訓**
  1. **先確認硬性前提，再開新專案**：設備、帳號、費用、審查。前提沒到位，前面做得再漂亮也會停住。
  2. **把「做不做得到」的驗證放最前面**：用最小的 PoC 驗證核心價值，不要先重構。
  3. **能用程式算的，就不要交給 LLM**：分數、金額、回合數、信任度、什麼時候結束，都由程式決定。LLM 只負責講話。
  4. **免費額度是最大的限制**：要分清楚「每分鐘」和「每天」額度，多個模型輪流用，用完要明確告訴使用者何時恢復。
  5. **新資料夾當天就 commit 並推上 GitHub**：Ai_Sales_Coach_App 一整天的工作從來沒有進版控。

---

## 1. 專案族譜（容易搞混，先看這張表）

| 本機資料夾 | GitHub repo | 公開網址 | 期間 | 狀態 |
|---|---|---|---|---|
| `D:\Hao+App\AiCoach` | zjh0511/ai-sales-coach | zjh0511.github.io/ai-sales-coach/ | 2026-08 ～ 現在（45+ commits） | **穩定版原型，持續使用** |
| ~~`D:\Hao+App\Ai_Sales_Coach_Local`~~ | ~~zjh0511/ai-sales-coach-local~~ | — | 08-16 ～ 08-26（1 commit） | **2026-10-07 已刪除**（保留資料在 `AiCoach\project\archive\local\`） |
| ~~`D:\Hao+App\Ai_Sales_Coach_App`~~ | 沒有 repo（0 個 commit） | — | 08-17（一天） | **2026-10-07 已刪除**（保留資料在 `AiCoach\project\archive\app\`） |
| `D:\Hao+App\AI業務教練App` | ~~zjh0511/ai-sales-coach-app~~ | ~~zjh0511.github.io/ai-sales-coach-app/~~ | 09-12 ～ 09-17（6 commits） | **GitHub repo 與測試站 2026-10-07 已刪除**；本機資料夾還在 |

- **注意**：GitHub 上的 `ai-sales-coach-app` **不是** `Ai_Sales_Coach_App` 推上去的，而是 `AI業務教練App` 那套。它是另一個架構：Cloudflare Workers + D1 + Firebase。
- **教訓**：repo 名稱和資料夾名稱要對得起來，一個專案只用一組名字。

---

## 2. 穩定版原型的架構（AiCoach，2026-09-30，SW v23）

### 2.1 檔案地圖（`docs/` 就是網站根目錄）

**頁面與殼層**

| 檔案 | 角色 |
|---|---|
| `index.html` | 單頁 App，18 個 `<section class="screen">` |
| `app.js` | 畫面流程、語音排程、雲端同步、安裝教學、`boot()` |
| `style.css` | 第 9 行全域 `[hidden]{display:none!important}`（必要，見 §4.5） |
| `voice.js` | 收音（Web Speech STT）與朗讀（Gemini TTS 用 Web Audio 排程，內建 `speechSynthesis` 當退路） |
| `sw.js` | Service Worker，network-first，`VERSION` 每次改版都要 +1 |
| `manifest.webmanifest` | 圖示、長按捷徑 `?go=call\|needs\|pain` |
| `guide.html` + `help/key-1..9.jpg` | 申請金鑰的 9 步實拍教學 |
| `firebase-config.js` | Firebase 公開設定；`apiKey` 清空就停用帳號功能 |

**`engine/` 教練引擎**

| 檔案 | 角色 |
|---|---|
| `api.js` | 本地 API 層；`ENABLED=['gemini']` 決定開放哪些服務商 |
| `gateway.js` | 各服務商的轉接層、模型探測、`PICK` 排序、重試／降階／冷卻、`friendlyError`、`scrubKey` |
| `prompts.js` | 分層提示詞：BASE→Mode→Scenario→Persona→State→Turn |
| `session.js` | 狀態機 INTAKE→READY→ROLEPLAY→COMPLETED→FEEDBACK_READY，`MIN_TURNS=4` |
| `advisor.js` | 痛點分析、理賠 `claimCase`／`calcAmount`、教練對話 |
| `knowledge.js` | 文件結構化（FABE）、`lessonPrompt`、`keyPoints` |
| `docx.js` | 用 `DecompressionStream` 自己解 ZIP+XML（Office 檔不送模型） |
| `store.js` | IndexedDB |
| `compliance.js` | 合規規則，用正規表示式比對 |
| `zhtw.js` | 簡轉繁保險絲，約 700 組 |
| `tts.js` | Gemini TTS 串流、`TtsRotator`、`ttsError`、`nextPacificMidnight` |
| `account.js` | Firebase REST，不用 SDK |

**`tools/` 工具**
- `selftest.mjs`：第 1 節是規則層，約 168 項，不用金鑰；第 2–6 節會真的呼叫 Gemini。
- `fbcheck.mjs`：帳號同步與越權檢查，14 項。
- `serve.mjs`、`gencert.mjs`：本機 HTTPS。
- `report*.mjs`：管理者報表。

### 2.2 資料流與隱私邊界

**上雲的**
- 帳號（Firebase Auth）。
- 訓練紀錄與偏好設定（Realtime DB `/users/$uid`）。紀錄以 `at` 取聯集，設定以 `updatedAt` 較新者為準。
- 安全規則：每個人只能讀寫自己那份。

**只留在本機的**
- API 金鑰（localStorage）。
- 上傳的教材與條款（IndexedDB）。
- 理賠客戶資料（病況不存）。
- 教練對話、TTS 額度狀態。

**AI 請求**：瀏覽器直連 `generativelanguage.googleapis.com`，中間沒有伺服器。SW 一律不攔截跨網域和非 GET 請求。

### 2.3 模型策略

**文字模型**
- 預設 `gemini-3.5-flash-lite`，對練和評分都用它（D036）。
- 備援順序：其他 flash-lite → 3.7-flash → 3.6-flash → 其他 3.x flash；評分最後再加 pro。
- 降階規則：

| 狀況 | 處理 |
|---|---|
| 429 | 冷卻 10 分鐘 |
| 503 | 重試 1 次就換模型，冷卻 1 分鐘 |
| 404 | 跳過 24 小時 |
| 逾時 | 對練 25 秒、評分 45 秒；不重試同一個模型 |

- Gemini 3 一律設 `thinkingLevel:'low'`。

**TTS（語音合成）**
- 三個模型輪流：`gemini-3.8-flash-lite-tts` → `gemini-3.8-flash-tts` → `gemini-3.1-flash-tts-preview`。
- 聲音：

| 角色 | 男聲 | 女聲 |
|---|---|---|
| 客戶 | Charon | Aoede |
| 教練 | Sadaltager | Sulafat |

- 首段聲音 4 秒內沒來，就改用內建朗讀。

**STT（語音辨識）**：瀏覽器 `webkitSpeechRecognition`（zh-TW），時間參數見 §4.3。

### 2.4 六大功能（設計重點）

1. **痛點分析**：一次呼叫產生 JSON，內容是三個痛點和建議的接觸方式。
2. **電話邀約語音對練**：先產生客戶人設和接觸情境（限定業務員此刻知道什麼）→ 語音角色扮演 → 五項評分。初始信任度和掛不掛電話由程式控制。
3. **發掘需求**：模型只回傳揭露了哪幾項的編號，例如 `revealed:[1,3]`，再由程式對應回文字。
4. **商品行銷**：教材先結構化一次 → 看「商品重點」（不花額度）→「教練講解」按了才產生 → 演練 → 逐點檢核必講重點。
5. **理賠諮詢**：先輸入客戶狀況 → 勾選保單（最多 5 張）→ 每張保單平行分析 → 金額由程式 `calcAmount` 計算 → 回覆話術（程式補上「以保險公司核定為準」）。
6. **問問其他問題**：可打字也可連續語音對談；教練聲音可選男女；合規問題即時糾正。

---

## 3. 路線抉擇的關鍵數據（下次評估類似方向時直接用）

### 3.1 瀏覽器內本地模型（Ai_Sales_Coach_Local 的實測）

- **用過的技術**：transformers.js 4.2 + onnxruntime-web 1.26（ONNX），以及 wllama（GGUF，llama.cpp 的 WASM 版）。模型快取放 OPFS。
- **品質門檻**：
  - 2B 以下接不住角色對話；1B 版本使用者評為「對話很不OK」，隱藏需求只挖到 0/3。
  - 4B（Qwen3-4B Q3_K_M，2,076MB）才像真的客戶。
- **約 2 GiB 的硬上限**：32 位元 wasm 的限制。1,979 MiB 可以載入，2,033 MiB 就失敗，錯誤訊息一律是 `Invalid typed array length`。
- **裝置**：
  - iPad Pro M5、有 WebGPU 的桌機可以跑。
  - **iPhone 14 Pro 不行**：688MB 的模型一載入分頁就崩，只剩 135M 的小模型能跑（每回合 8.2 秒）。
  - 能力偵測說可以，不等於實際可用。
- **延遲**：4B 每回合 3.5–4.3 秒；冷啟動的第一回合慢 20 倍，一定要先暖機。
- **語音**：STT 還是用 Web Speech，會上雲端，所以「完全離線」在語音這一段其實不成立。原本計畫的瀏覽器內 Whisper 從沒做。
- **結論**：在手機上做到「離線＋像真人」目前不可行。真的要離線，只能走原生 App。

### 3.2 原生 iOS（Ai_Sales_Coach_App 的規劃）

- **規劃的架構（方案 B′）**：
  - 畫面用 SwiftUI 重寫。
  - 語音用原生：AVAudioEngine 收音並消除回音、SFSpeechRecognizer 在裝置上辨識、AVSpeechSynthesizer 朗讀。
  - **教練引擎沿用 JS**：在 JavaScriptCore 裡執行，透過 `engine/platform.js` 這一層取得網路、儲存等能力。
- **卡死的前提**：
  - Windows 沒有合法方式做 iOS，Xcode、簽章、TestFlight、送審都只能在 macOS 上進行。
  - App Store 賣家名稱要顯示「豪老師 Hao+」，必須用公司帳號，需要 D-U-N-S 編號，申請要好幾週。
- **審查風險**：
  - 使用者自帶金鑰的設計，審查員沒有金鑰就什麼都打不開，常被退件，需要示範模式。
  - 保險類內容要定位成「業務員自我訓練工具」。
  - 不能只用 WebView 包網頁（審查指南 4.2）。
  - 提示詞不能線上更新（2.5.2）。
  - 宣稱支援 iPad，審查員就會在 iPad 上實測。
  - AI 生成內容要有免責說明。
- **原生唯一確定的價值**：AI 講話時，使用者可以直接插話打斷（Safari 做不到邊朗讀邊收音）。這一點要先用 PoC 驗證（N0 關卡）。

### 3.3 PWA 確定做不到的事（決定要不要做原生前，先看這張）

1. AI 講話時直接插話打斷（只能按麥克風打斷）。
2. 在裝置上做語音辨識（STT 會經過 Apple 或 Google）。
3. 背景執行。
4. 在 iPhone 上跑本地模型。
5. 替使用者建立桌面圖示（只能教使用者自己加）。

---

## 4. 踩坑大全（症狀 → 原因 → 解法）

### 4.1 LLM 與提示詞

- **LLM 自己決定結束對話**
  - 症狀：第 1 回合就回 `end:true`。
  - 解法：結束時機由程式判定，至少 4 回合（D004）。
- **思考 token 吃掉輸出額度**
  - 症狀：回傳空字串。
  - 原因：思考 token 也算進 `maxOutputTokens`。
  - 解法：放寬上限，Gemini 3 設 `thinkingLevel:'low'`（D005）。
  - Groq 的 gpt-oss 同理，要加 `reasoning_effort:'low'`。
- **要模型原文照抄就記不住**
  - 症狀：隱藏需求一項都沒記到。
  - 解法：改成回報編號，由程式對應回原文（D009）。
- **模型自己補數字**
  - 症狀：沒有手術倍數表時，模型自己填「倍數 1」，算出 1,000 元，還寫進回覆話術。
  - 解法：用 `undefined` 表示「沒給」（當作 1），`null` 表示「查不到」（不計算）；提示詞也明講查不到就寫 null（D041）。
- **示範句被逐字照抄**
  - 症狀：「你慢慢說沒關係」這類示範句被照抄，發生過三次。
  - 解法：示範只在第一回合給，並加程式檢查 `copiesExample`。小模型特別明顯。
- **逼小模型輸出 JSON**
  - 症狀：數值看起來正常，其實永遠是 0 或空陣列。
  - 解法：拿掉 JSON，數字改由程式算，速度反而快一倍。
- **角色錯亂有三種**：過度順從（「這個保險我一定會買」）、自稱業務員、角色反轉。
  - 要分開檢查，重試時要具體指出錯在哪裡。籠統的「請修正」對小模型沒用。
- **簡體字**
  - 原因：只靠提示詞擋不住。
  - 解法：程式層加 `zhtw.js` 保險絲（D030）。
  - 小心：`toTW()` 收到物件時會靜默失效。
- **品牌**：示範話術一律寫「○○人壽的○○」，提示詞和 `scrubBrands` 兩層把關，因為使用者可能任職任何公司（D011）。
- **資訊邊界**
  - 症狀：示範話術說出「您那筆五百萬的保單」，那是業務員不該知道的事。
  - 解法：加 `demoLeaksPrivateInfo` 檢查（D012）。
- **倫理**：教練不得建議捏造聯繫理由，避免不實招攬（D010）；導入建立信任感的 NLP 原則，並設紅線（D013）。
- **對新人太嚴**：預設難度改為 1，初始信任度等關鍵數值由程式夾住範圍（D021）。

### 4.2 Gemini API、額度與錯誤處理

- **免費 TTS 額度**
  - 額度：每個模型每分鐘約 3 次、每天約 10 次。
  - 症狀：只要冷卻 10 分鐘，兩輪之後就變成機械女聲。
  - 解法：解析 `error.details[].violations[].quotaId`，分出 PerMinute 和 PerDay，讀出 `retryDelay`，三個模型輪流（D043）。
- **每天額度在太平洋時間午夜重置**（台灣下午 3 點，冬令 4 點）。
  - 用 `Intl` 計算 `nextPacificMidnight()`，冬夏令自動處理。
  - 要告訴使用者何時恢復。
- **額度按帳號分開計算**：多一把不同帳號的金鑰，就多一份額度。影片製作 Skill 已經支援「主要金鑰用完就換備用金鑰」。
- **不要用錯誤訊息文字分類錯誤**
  - 症狀：`AbortSignal.timeout()` 的訊息是「aborted due to timeout」，比對「timed out」攔不到。這類 bug 犯過三次。
  - 解法：HTTP 層一律不 throw，回傳固定標籤 `ok|http|timeout|network`（D020、D023）。
- **新錯誤被吞掉**
  - 原因：`friendlyError` 用白名單過濾。
  - 解法：錯誤要在源頭正規化。
- **舊模型 404 讓整條備援鏈中止**
  - 解法：404 改成跳過該模型；全部模型都塞車時，要講清楚原因，不要只說「卡了一下」（D037）。
- **模型 ID 會變**
  - 用 `/models` 端點查實際可用的模型（一手資料）。服務商文件是二手資料。
  - 用比對模式挑模型，同一模式取較新的版本（D029）。
- **OpenRouter／Groq 的坑**
  - OpenRouter 的免費模型 429 是上游共用流量池限流，不是你的額度用完。
  - OpenRouter 的 `/models` 是公開端點，假金鑰也能「登入」。
  - Groq 免費方案每分鐘 8,000 token，評分一次約 10,572 token，會吃到 413。
  - 最後決定只開放 Google AI Studio（D036）。
- **CORS**：NVIDIA 和 ChatGPT 的 OAuth 擋瀏覽器直連，純前端用不了（D017）。

### 4.3 語音（STT／TTS），手機上最容易卡

- **iOS 第一句朗讀**：必須在使用者點擊的事件裡同步呼叫，否則不會發聲。
- **iOS 朗讀完到開麥克風**：音訊通道要等 **3500ms** 才釋放（其他平台 300ms）。
- **iOS 的 `speechSynthesis.onend` 偶爾不觸發**
  - 解法：每 300ms 檢查朗讀狀態，連續兩次閒置就視為播完（D035）。
- **收音卡住**
  - 12 秒沒有任何結果，就判定卡住並自動重接。
  - 拿到結果後 4 秒還沒結束，就強制收尾。
- **每輪對話用 epoch 編號**，作廢已過時的排程，避免 AI 還在思考時突然打開麥克風。
- **iOS 靜音開關會把 Web Audio 消音**：要設 `navigator.audioSession.type='playback'`。
- **Gemini TTS 的細節**
  - 語氣指示會被唸出來，例如「用輕快的語氣說：」，只能寫台詞本身。
  - 串流回傳的是 PCM 不是 WAV；非串流可能直接回 WAV，要先檢查 RIFF 開頭，避免包兩層標頭。
  - SSE 用 `\r\n` 分隔。
  - 內建朗讀在逗號處切段會降調，只在句尾切（D038）。
- **發音**
  - 「AI業務教練」曾被唸成「AI經物教練」，寫成「A I 業務教練」就穩定。
  - **檢查發音時不要把原稿和音檔一起給 AI**，它會「聽到預期的字」。要先讓 AI 盲聽寫，再和原稿比對。
- **語音輸入時按「講完了」**：最後一句可能還沒定稿就被吃掉，要等定稿（D042）。
- **教練對談的停頓判斷**：`CHAT_HOLD_MS=2500`，停頓 2.5 秒才算講完。
- **不做串流**：量過雲端串流只省 100–300ms，不值得增加複雜度（D022）。

### 4.4 PWA、安裝、快取、iOS

- **使用者卡在舊版**
  - 解法：SW 採 network-first，而且一定要 `fetch(req.url,{cache:'no-cache'})`，才能繞過 GitHub Pages 的 `max-age=600`（HTTP 是第二層快取，D026）。
- **SW 安裝**
  - 逐檔 `c.add().catch()`，一個檔 404 不會讓整個 SW 裝不起來。
  - 搭配 `skipWaiting` 和 `clients.claim`；activate 時刪掉舊快取。
  - 新增檔案要記得加進預快取清單。
- **SW 註冊條件**：用 `window.isSecureContext` 判斷，讓 `http://localhost` 也能註冊。
- **LINE、FB、IG、微信的內建瀏覽器不能加到主畫面**
  - 解法：用 UA 判斷（`Line/|FBAN|FBAV|Instagram|MicroMessenger`），先教使用者換到系統瀏覽器。
  - QR Code 要用手機相機掃，不要用 LINE 掃（D031）。
- **iOS 沒有安裝 API，只能教**
  - 用 SVG 畫出分享圖示，註明「不是圓圈箭頭」。
  - iPhone 的分享鍵在下方，iPad 在右上角。
  - iPadOS 的 UA 自稱 Mac，要用 `maxTouchPoints>1` 分辨。
  - iOS 版 Chrome 也能加到主畫面（使用者實測）。
- **iOS 桌面 App 的儲存空間和 Safari 分開**：所以要「先安裝，再登入」（D032）。
- **第一次用手機開啟就主動教安裝**：0.6 秒後跳出，每個瀏覽器只跳一次（D045）。
- **iOS 26 Safari 的 UA 是凍結的**：不能用 UA 判斷 iOS 版本。
- **Safari 不支援 `for await (chunk of res.body)`**：改用 `getReader()`。
- **在 iPhone 上用麥克風必須是 HTTPS**：本機測試要用自簽憑證，憑證要包含區網 IP（`tools/gencert.mjs`）。
- **公司 Wi-Fi 常有 AP isolation**：手機連不到筆電；開發伺服器還會印出 VMware 虛擬網卡的 IP，容易誤導。

### 4.5 CSS 與 UI

- **`[hidden]` 被蓋掉**
  - 症狀：從桌面圖示打開，仍顯示「先加到主畫面」。
  - 原因：`.btn.install{display:flex}` 蓋過了 `[hidden]`。
  - 解法：全域加 `[hidden]{display:none!important}`（D046）。**新專案第一行就加上。**
- **不合法的 font 簡寫會讓整條宣告失效**
  - 例子：`font:600 16px/1 inherit` 被瀏覽器整條丟掉，按鈕的字一直是 13.3px。
  - 解法：寫 `font:inherit`，再分別設大小和字重。
  - 教訓：**要量實際套用的值**（getComputedStyle），不要相信自己寫的 CSS（D039）。
- **按鈕被推出畫面**
  - 原因：字放大加上主視覺後，內容比螢幕高；flex 子元素不會縮。
  - 解法：內容區加捲動（`.scroll`），按鈕固定在底部。用 375×667 的小螢幕驗證（D044）。
- **長輩、業務同仁要大字**：字體整體放大 50%（D039）。
- **重要入口要明顯**：一行小字使用者找不到（D018）；不要把架構細節推給使用者，例如要他選兩個模型（D019）。

### 4.6 帳號（Firebase）

- **不用 SDK，改用 REST**：維持零相依，範圍刻意收窄，只同步紀錄和偏好（D025）。
- **GIS 登入按鈕的假象**：來源沒授權時按鈕照樣畫得出來，按下去才失敗。要用 `/gsi/status` 驗證來源（D027）。
- **refresh token 被撤銷**：程式仍判定已登入，徽章顯示「已同步」。要區分「暫時連不上」和「永久失效」，永久失效就真的登出（D034）。
- **功能移除後，舊旗標還留在使用者端**：例如 `noacct` 讓人繼續繞過登入。改版時要主動清掉舊旗標（D028）。
- **用 CLI 設定 Firebase**：靠探測現況，不要用問的；做不到的那一步才交給使用者（D027）。

### 4.7 開發工具、Windows、測試

- **Windows 上 `process.exit()` 會觸發 libuv 斷言**：改用 `process.exitCode`。
- **轉義地雷**：shell → Python／heredoc 時，`\b`、`\n`、`\r` 會被轉成真的控制字元。
  - 實例：regex 的 `\b` 變成 0x08 退格字元（D037）；寫檔時 `\n` 變成真的換行。
  - 對策：含反斜線的編輯改用編輯工具，或寫成獨立的腳本檔；selftest 也檢查原始碼裡有沒有控制字元。
- **含中文的路徑**：Node 要用 `fileURLToPath(import.meta.url)`，不要用 `URL.pathname`。
- **PowerShell 5.1 腳本只能用 ASCII**：沒有 BOM 的 UTF-8 檔會被讀錯。
- **ffmpeg 的錯誤訊息在 stderr**：要用 `spawnSync` 讀 stderr，`execFileSync` 拿不到。
- **沒金鑰也要能測**：規則層測試不能依賴金鑰。測試要分節執行，只在真的呼叫模型的節次才初始化（D026 App）。
- **測試要能失敗**：先把舊程式換回去，確認新測試會失敗，證明它真的在測東西。
- **開發用參數造成假通過**：Local 的下載修法一直用 `?mirror=1` 驗證，公開路徑其實根本沒生效（D056）。驗證要走使用者會走的那條路。
- **headless Edge 截圖**：要加 `--disable-extensions`（否則會被 Calendly 擴充功能插入按鈕）；要擋掉 `beforeinstallprompt`；注入腳本時 `documentElement` 可能還不存在。

### 4.8 本地模型專屬（只有走這條路才會碰到）

- **同一個模型，不同匯出版本可能差 165 倍**
  - 例子：Qwen3.5-0.8B 的 `-ONNX` 版每 token 165ms，`-ONNX-OPT` 版只要 1–2ms。未優化版偏偏是搜尋第一名。
- **量化品質是 0 或 1**：Q4 會冒出「請告訂時」這類錯字，Q8 就正常；Qwen2.5-1.5B 的 q4f16 直接輸出亂碼。
- **ORT-web 單一 ONNX 檔 1.7GB 會 `bad_alloc`**：模型切成多檔反而載得進去。
- **Cache API 存不了幾百 MB 的檔案**：改用 OPFS。`storage.estimate()` 可能回報 quota 0，但 OPFS 其實正常。
- **Qwen3 預設開 thinking**：要關掉，還要處理被截斷、沒有結束標籤的 `<think>`。
- **停止字串會被變形**：「業務員：」會被寫成「業務苑」，改用換行當停止條件。
- **context 2048 到第 3 回合才爆**：改成 4096。
- **崩潰偵測會把手動重整誤判為崩潰**：用 `pagehide` 區分。
- **先用檢查清單再下載模型**：先 grep 引擎確認支援這個架構 → 確認 grammar 能力 → 確認快取機制 → 最後才下載。

### 4.9 安全

- **金鑰集中放在一個地方**：`D:\Hao+App\API Key.txt`，程式只從那裡讀，絕不印出，也不寫進任何輸出檔。
  - 目前專案資料夾裡還散落幾份金鑰檔，都在 .gitignore 內，但仍建議收斂。
- **使用者的金鑰只存在使用者自己的瀏覽器**：送出錯誤訊息前先 `scrubKey`。
- **GitHub 密鑰掃描**：可能誤判第三方函式庫裡的網址，擋下 push。處理方式是不要把大型 vendor 檔放進 repo。
- **對話中貼過的金鑰**（例如測試期間貼過一把 Groq 金鑰），事後要撤銷。
- **Firebase 網頁設定值本來就是公開的**：真正的保護是資料庫安全規則，要用 `fbcheck` 驗證越權存取。
- **服務帳戶 JSON、報表**：不進版控，也不上雲。

### 4.10 專案管理

- **複製出去的引擎會分岔**：Ai_Sales_Coach_App 從 AiCoach 複製引擎，第二天兩邊就不一樣了。共用的程式要「搬」不要「複製」，或做成可引用的模組。
- **決策編號撞號**：三個專案各自有 D022 以後的編號。新專案的決策紀錄要加前綴，或從新編號開始。
- **文件要跟著程式更新**：README、SHARE.md、Handbook 的統計數字和檔案樹都過時了（見 §7）。
- **重要文件不能只放本機**：Local 專案的決策紀錄 D022–D062（約 100KB）一直沒進版控。

---

## 5. 可重用的設計模式

1. **程式管規則，LLM 管講話**：分數、金額、回合數、信任度、揭露了哪些需求，都由程式計算或夾住範圍。LLM 輸出越簡單越好，例如只回編號。
2. **轉接層（Gateway）樣板**：
   - 多個模型依序 `PICK`。
   - 依錯誤類型決定冷卻時間（429、503、404、逾時各不同）。
   - 錯誤在源頭正規化成固定標籤。
   - 給使用者看的訊息由 `friendlyError` 統一產生，而且要講清楚何時恢復。
3. **額度輪替器（`TtsRotator`）**：記錄「金鑰 × 模型」各自的暫停時間；區分每分鐘和每天額度；全部用完時回報 `retryAt`。
4. **平台層（`engine/platform.js` + shims）**：引擎不直接碰 Web API，網路、計時、儲存、解壓縮都經過這一層。同一份引擎可以在瀏覽器、Node、JavaScriptCore 上跑。程式已保留在 `AiCoach\project\archive\app\engine\`。
5. **每回合的確定性檢查**（Local 的 `turn-signals.js`）：isEcho、isSelfRepeat、claimsToBeAgent、isTooCompliant、invertsRole、copiesExample、trustDelta。雲端版也可以拿來當輸出防線。
6. **五構面程式評分**（Local 的 `evaluate-local.js`）：流暢度、親和力、需求覺察、自信、專業度。每個扣分點都附證據，表現好時改給進階建議。
7. **台灣壽險客戶原型**（Local 的 `personas.js`）：10 種人設，例如家管單薪、單親護理師、小工廠老闆。每個痛點都附 why／need／ask，並用身分詞和處境詞兩級比對。
8. **花額度的內容「按了才產生」**：例如商品的「教練講解」，第一層內容不花使用者的額度。
9. **失敗不丟資料**：評分失敗時保留逐字稿，可以原地重新評分（D033）。
10. **語音時序參數表**：見 §4.3，直接沿用。

---

## 6. 新專案起手檢查清單

**開工前**
- [ ] 硬性前提都到位了嗎？設備（Mac？）、帳號（Apple 公司帳號、D-U-N-S）、費用、審查規則、實機。
- [ ] 核心價值能先用最小的 PoC 驗證嗎？驗證不過就不要往下做。
- [ ] 免費額度夠用嗎？要估算每位使用者每天會呼叫幾次。
- [ ] 先列出 PWA 做不到的事（§3.3），再決定要不要做原生 App。

**第一天**
- [ ] 建資料夾 → `git init` → 第一個 commit → 推上 GitHub。資料夾名稱和 repo 名稱要一致。
- [ ] `.gitignore` 先排除金鑰、憑證、報表、服務帳戶 JSON、簽章檔。
- [ ] 金鑰只從 `D:\Hao+App\API Key.txt` 讀。
- [ ] 建立 `project/DECISION_LOG.md`，決策編號加專案前綴。
- [ ] CSS 第一行加 `[hidden]{display:none!important}`。
- [ ] SW 採 network-first + `cache:'no-cache'`，並設 `VERSION`。

**開發中**
- [ ] 規則層測試不依賴金鑰，而且要先證明測試會失敗。
- [ ] 每個決策都寫 D 紀錄：要寫實測數據、犯了什麼錯、得到什麼教訓。
- [ ] 每次改版：SW `VERSION` +1 → 跑 selftest → commit → push → 用 iPhone 實機測試。
- [ ] 改 UI 後用 375×667 量實際套用的樣式值。

---

## 7. 和豪老師合作的方式

- **先討論再動手**：先提方案，用 ①②③ 或 A／B／C 列出選項，讓他逐點確認後才寫程式。常聽到的話是「先不急著修改程式，討論好再動手」。
- **每次改完都同步 GitHub Pages**，並附上網址。他會用 iPhone 實機測試後回報。
- **一律用繁體中文，白話、分步驟說明**。他不是工程背景。
- **主觀感受由他判斷**：聲音、口音、音量，先產生樣本給他聽。
- **省額度意識很強**：不花學員的 API 額度；目前不考慮付費方案；查證時如果會用掉他的額度，要先問。
- **以實際業務情境主導產品**：同事的回饋優先，例如理賠流程的順序。
- **安全**：金鑰絕不顯示或複製；文件和金鑰不上雲；下載檔案前要先問；品牌主視覺每次使用前都要問。

**AiCoach 文件待更新**
- `README.md`：決策範圍、測試數量、已知限制第 7 條都過時了。
- `SHARE.md`：還寫要選服務商，也沒提強制登入。
- Handbook：§1.1 統計數字、§11.1 檔案樹過時。
- 「還沒有金鑰？」卡片和影片製作的決策，沒有寫進 D 紀錄。

---

## 8. 刪除前確認清單（2026-10-07 盤點）

> 🗑 2026-10-07 已完成刪除：本機兩個資料夾、Claude 裡的兩個舊對話、GitHub 的 `ai-sales-coach-local` 與 `ai-sales-coach-app`。
> 以下保留當時的盤點內容，作為紀錄。

> ✅ 2026-10-07 已經把下面兩個資料夾裡值得保留的文件和程式，複製到 `D:\Hao+App\AiCoach\project\archive\`（說明見那裡的 README.md）。
> 沒有複製的：模型檔、金鑰檔、憑證，以及 AiCoach 已經有的共用規格文件。

**`Ai_Sales_Coach_Local`**

| 項目 | 狀況 |
|---|---|
| `project/DECISION_LOG.md`（D001–D062，約 100KB） | **沒有進版控**，GitHub 上也沒有 |
| `MD檔/12_LOCAL_MODEL_DEV_PLAN.md`、`13_LOCAL_MODEL_FINDINGS.md`、`14_DEPLOY_GITHUB_PAGES.md` | 同上 |
| `docs/engine/gateway.js`、`tools/selftest.mjs` | 08-26 的 Groq 修改**沒有 commit**（AiCoach 已改成只開放 Gemini，影響不大） |
| `models/`（約 15GB 模型檔） | 可直接刪 |
| `API Key.txt`、`certs/key.pem` | 刪除即可；若裡面的金鑰還有效，建議到服務商後台撤銷 |
| 可重用的程式：`turn-signals.js`、`evaluate-local.js`、`personas.js`、`prompts.small.js`、量測頁 `lab*.html` | GitHub 上有一份（e0a887e）；repo 刪掉就沒了 |

**`Ai_Sales_Coach_App`**

| 項目 | 狀況 |
|---|---|
| 整個資料夾 | **0 個 commit、沒有 remote**，刪掉就完全消失 |
| `MD檔/12_NATIVE_APP_DEV_PLAN.md` | iOS 上架清單、審查風險表、Mac 取得方式比較。下次做 iOS 可以直接當範本 |
| `engine/platform.js`、`engine/shims/`、`tests/smoke.mjs` | AiCoach 沒有對應的檔案 |

**GitHub `zjh0511/ai-sales-coach-app`（⚠️ 不是 `Ai_Sales_Coach_App`）**
- 這個 repo 是 `D:\Hao+App\AI業務教練App` 發布出去的「公開測試版」（6 commits，09-12～09-17）。
- **網址 zjh0511.github.io/ai-sales-coach-app/ 目前仍在線上**，repo 刪掉網站就會消失。如果有同事還在用這個網址，要先通知。
- 那套架構用到 Cloudflare Workers + D1：刪 GitHub repo 不會刪掉 Cloudflare 上的資源（如果有部署），要另外到 Cloudflare 後台清理。
- 本彙整**沒有**深入檢視 `AI業務教練App` 資料夾，只確認了它的手機語音修正（已被 AiCoach D035 吸收）。

---

## 9. 原始資料出處

- AiCoach：`project/DECISION_LOG.md`（D001–D046）、`MD檔/11_IMPLEMENTATION_HANDBOOK.md`（§4 踩坑表、§9「不要重複犯的錯」）、`tools/selftest.mjs`
- 影片製作：`D:\Hao+App\【Skills】\teaching-video\`（SKILL.md、references/voices.md、references/deck.md）
- Local 與 App 兩個專案保留下來的原始文件和程式：`D:\Hao+App\AiCoach\project\archive\`（local\、app\）。重點已經摘錄在本文件 §3、§4.8、§5。

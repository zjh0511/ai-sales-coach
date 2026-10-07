# AI業務教練｜原生 App 開發計畫書（iOS / iPadOS → App Store）

**文件名稱：** `12_NATIVE_APP_DEV_PLAN.md`
**產品名稱：** AI業務教練
**品牌：** 豪老師 Hao+
**文件版本：** V1.0（Q1／Q2／Q3／Q5 已確認，N-1 進行中）
**撰寫日期：** 2026-08-17
**最後更新：** 2026-08-17（N-1 第 1～4 項完成）
**上層文件：** `01_PRODUCT_SPEC.md` ～ `04_VOICE_ENGINE.md`、`11_IMPLEMENTATION_HANDBOOK.md`
**新專案根目錄：** `D:\Hao+App\Ai_Sales_Coach_App`
**前一階段成果：** `D:\Hao+App\AiCoach`（GitHub Pages 純前端版，已上線驗證）

> **本文件狀態：主要決策已確認，N-1 階段進行中。**
> 依 `01_PRODUCT_SPEC.md` §50「Agent 不得自行決定的重要事項」，決策先攤開再實作。
> 已確認：Q1（先做 Windows 上能做的）、Q2（Apple 帳號尚未申請，需啟動）、
> Q3（JavaScriptCore 沿用）、Q5（V1 按自帶金鑰，保留可切換介面）。
> **仍待裁決：Q4、Q6～Q10，見 §9。**

---

## 0. 摘要：三句話

1. **最大的阻礙不是技術，是建置環境。** iOS App 必須用 macOS 上的 Xcode 建置與上架，
   目前只有 Windows 11。這一項不解決，後面全部無法開始。
2. **已驗證的教練引擎不該重寫。** 建議用 JavaScriptCore 把現有 `engine/*.js`（約 1,300 行、
   已過 60 項斷言、含 38 KB 提示詞 IP）原樣搬進 iOS App，只把 I/O 換成原生。
3. **N0 語音 PoC 是唯一的 Go/No-Go 關卡。** 依 `11_IMPLEMENTATION_HANDBOOK.md` §7.4，
   若原生 Barge-in 沒有明顯優於網頁版，原生化的主要理由就不成立，該回頭重估而不是硬做。

---

## 1. 現況盤點（實際檢查結果，非推測）

### 1.1 既有資產（`D:\Hao+App\AiCoach`）

| 類別 | 內容 | 可用度 |
|---|---|---|
| 教練引擎 | `docs/engine/` 共 10 檔，約 100 KB | ✅ 已上線驗證，六大功能全跑過 |
| 提示詞 IP | `prompts.js`（38.8 KB） | ✅ **本專案最高價值資產** |
| 模型閘道 | `gateway.js`（24.4 KB，六家服務商、探測、重試、降階） | ✅ 邏輯可留，HTTP 層要換 |
| 狀態機 | `session.js`（11.4 KB） | ✅ 可留 |
| 合規引擎 | `compliance.js`（2.9 KB，正規表示式） | ✅ 可留 |
| 端到端測試 | `tools/selftest.mjs`（19 KB，60+ 斷言） | ✅ **可繼續在 Node 上跑** |
| UI | `app.js` + `index.html` + `style.css`（約 57 KB） | ❌ 全部重寫成 SwiftUI |
| 語音 | `voice.js`（4.2 KB，Web Speech API） | ❌ 全部重寫（也是獲益最大處） |
| 決策紀錄 | `project/DECISION_LOG.md`（27.5 KB，D001–D021） | ✅ 直接沿用 |

### 1.2 規格文件缺口

`AI業務教練_開發流程.txt` 規劃了 `docs/05` ～ `docs/10`，但**實際只寫了 01～04 與 11**：

| 文件 | 狀態 | 對原生階段的影響 |
|---|---|---|
| `05_KNOWLEDGE_RAG.md` | ❌ 未撰寫 | 影響小（V1 用「一次結構化」策略，已在 handbook §2.8 記錄） |
| `06_COMPLIANCE_ENGINE.md` | ❌ 未撰寫 | 影響小（規則已在 `compliance.js` 與 `01` §33–35） |
| `07_SECURITY_IP_PRIVACY.md` | ❌ 未撰寫 | **影響大** — App Store 隱私標籤與金鑰保管需要明確規格 |
| `08_APP_UX_UI_SPEC.md` | ❌ 未撰寫 | **影響大** — SwiftUI 要從零設計版面，沒有規格會反覆改 |
| `09_DATA_ARCHITECTURE.md` | ❌ 未撰寫 | 影響中（SwiftData schema 需定義） |
| `10_TESTING_QA.md` | ❌ 未撰寫 | 影響中（可由 `selftest.mjs` 概念推導） |
| `tests/GOLDEN_REFERENCE.md` | ❌ 未撰寫 | handbook §10.3 明確標記為 V1 已知缺口 |

**建議：** 07 與 08 在 N1 之前補上，其餘可邊做邊寫。不建議為了「文件齊全」而先寫完六份再開工。

### 1.3 本機環境（實測）

| 工具 | 狀態 |
|---|---|
| Node.js | ✅ `C:\Program Files\nodejs\node.exe` |
| Git | ✅ `C:\Program Files\Git\cmd\git.exe` |
| Python 3.11 | ✅ 已安裝 |
| .NET | ✅ 已安裝 |
| **Xcode / iOS SDK** | ❌ **不存在，且 Windows 上無法安裝** |
| Flutter | ❌ 未安裝 |
| Git 版本控管 | ❌ `Ai_Sales_Coach_App` 尚未初始化為 Git repo |

---

## 2. 前置阻礙：iOS 建置環境（最高優先，需你決定）

### 2.1 硬性事實

- Xcode 只發行於 macOS。
- App 簽章（codesign）、TestFlight 上傳、App Store Connect 送審，全部經由 Xcode 或 macOS 命令列工具。
- 沒有任何合法途徑在 Windows 上完成 iOS 上架。

### 2.2 三個選項與我的評估

| 選項 | 做法 | 成本量級 | 可否實機除錯語音 | 評估 |
|---|---|---|---|---|
| **A. 自備 Mac** | Mac mini（Apple Silicon）或 MacBook Air | 一次性硬體支出 | ✅ 可接 iPhone 直接 debug | **建議** |
| B. 雲端 Mac 租用 | MacStadium / Scaleway / MacinCloud 月租 | 持續月費 | ❌ 雲端 Mac 接不到你手上的 iPhone | 不建議當主路徑 |
| C. 純 CI 建置 | GitHub Actions macOS runner → TestFlight | 低（有免費額度） | ❌ 只能建置，無法互動除錯 | 適合當 A 的補充，不能取代 |

### 2.3 為什麼 B 和 C 不能當主路徑

這個 App 的原生化理由（handbook §7.1）有四項，其中三項是**音訊硬體行為**：

- Barge-in（AI 說話時打斷）— 必須在真實麥克風／喇叭環境下調參
- 回音消除是否有效 — 必須用真實裝置的揚聲器測
- 藍牙耳機／AirPods／CarPlay 路由切換 — 只能實機測

`04_VOICE_ENGINE.md` §110、§111、§112 與 handbook §7.3 列出的必測項目，例如
「連續 20 分鐘後溫度與電量」、「來電中斷後能否恢復演練狀態」，都需要
Xcode 連著實機看即時 log 與效能面板。雲端 Mac 只能做到「編譯出來、丟上 TestFlight、
在 iPhone 上手動玩、出問題但看不到堆疊」——這對語音管線調校效率極低。

**我的建議：取得一台 Apple Silicon Mac，並用 C（GitHub Actions）作為之後的自動建置補充。**

### 2.4 另外必備

| 項目 | 說明 | 需你確認 |
|---|---|---|
| Apple Developer Program | 年費制，上架與 TestFlight 都需要 | 是否已有帳號？ |
| 帳號類型 | 個人（Individual）／公司（Organization） | 公司需 D-U-N-S 編號，申請有前置時間 |
| 開發者名稱顯示 | App Store 上顯示的賣家名稱 | 若要顯示「豪老師 Hao+」須用公司帳號 |
| 測試實機 | 至少一台 iPhone + 一台 iPad | 型號會決定效能基準（`01` §28 用 iPhone 14 Pro） |

> **注意：** 若要以「豪老師 Hao+」品牌名義上架，必須是 Organization 帳號，
> 需要 D-U-N-S 編號與法人登記資料，這段申請流程可能耗時數週。
> **這件事應該現在就開始，不要等到 N4 才發現卡住。**

---

## 3. 技術方案建議

### 3.1 引擎策略：採用 handbook §6 方案 B 的強化版

handbook §6 列了三個方案，並建議「先用方案 B 做 iOS PoC」。我同意，並提出更明確的做法：

> **方案 B′：JavaScriptCore 執行既有引擎，所有 I/O 由 Swift 以 host function 注入。**

```
┌─────────────────────────────────────────┐
│  SwiftUI（全新撰寫）                      │
│  畫面、導覽、iPad 版面                     │
└────────────────┬────────────────────────┘
                 │
┌────────────────▼────────────────────────┐
│  Swift Voice Engine（全新撰寫）            │
│  AVAudioEngine / SFSpeechRecognizer      │
│  AVSpeechSynthesizer / Voice State Machine│
└────────────────┬────────────────────────┘
                 │  文字進、文字出
┌────────────────▼────────────────────────┐
│  EngineBridge（Swift，新寫約 400 行）      │
│  JSContext 生命週期、JSValue ↔ Swift 轉換  │
└────────────────┬────────────────────────┘
                 │
┌────────────────▼────────────────────────┐
│  JavaScriptCore：既有 engine/*.js         │
│  api / session / advisor / gateway /      │
│  knowledge / prompts / compliance         │
│  ★ 幾乎不改，含 38 KB 提示詞 IP            │
└────────────────┬────────────────────────┘
                 │  呼叫注入的 host functions
┌────────────────▼────────────────────────┐
│  Native Shims（Swift，新寫約 300 行）      │
│  engine/platform.js 的七項能力            │
│  http          → URLSession               │
│  store         → SwiftData / Keychain     │
│  inflateRaw    → Compression / ZIPFoundation│
│  utf8Decode    → String(decoding:as:)     │
│  base64ToBytes → Data(base64Encoded:)     │
│  sleep         → Task.sleep               │
│  log           → OSLog                    │
└─────────────────────────────────────────┘
```

**平台相依實測盤點（N-1 掃描結果）**

JavaScriptCore 只提供 ECMAScript 標準內建物件，**沒有任何 Web API**。
以下是引擎原本用到、iOS 上會全數失效的清單，以及各自的處置：

| Web API | 原本用在 | 處置 |
|---|---|---|
| `fetch` + `AbortSignal.timeout` | `gateway.js` | → `platform.http` |
| `setTimeout` | `gateway.js` 的 `sleep` | → `platform.sleep` |
| `setInterval` | `session.js` 逾時清理 | → **改惰性清理，介面不需要**（D025） |
| `console.warn/error` | `api.js`、`gateway.js`、`session.js` | → `platform.log` |
| `indexedDB` | `store.js` | → `platform.store`，**`store.js` 已刪除**（D024） |
| `DecompressionStream`／`Blob`／`Response` | `docx.js` | → `platform.inflateRaw` |
| `TextDecoder` | `docx.js`、`knowledge.js` | → `platform.utf8Decode` |
| `atob` | `knowledge.js` | → `platform.base64ToBytes` |
| `btoa`／`crypto.subtle`／`location`／`sessionStorage` | **`oauth.js` 整檔** | → 移出共用引擎，iOS 改用 `ASWebAuthenticationSession`（D024） |

**零平台相依、可完全原樣搬移的檔案：**
`prompts.js`（38.8 KB，核心 IP）、`compliance.js`、`advisor.js`。
這三個檔案在 N-1 中**一個字都沒有改動**——這正是方案 B′ 想保護的資產。

### 3.2 為什麼是這個方案，而不是全 Swift 重寫

| 理由 | 說明 |
|---|---|
| **正規表示式不必翻譯** | `compliance.js` 與 `prompts.js` 大量使用 JS 正規表示式。改寫成 `NSRegularExpression`（ICU 語法）在中文與邊界處理上有差異，**錯了不會拋例外，只會安靜地放過違規內容**——正是 handbook §9.2 第 9 條警告的最危險 bug 類型。留在 JSC 上執行，語法零風險。 |
| **提示詞 IP 零風險搬移** | 38.8 KB 的分層提示詞含大量中文字串。逐字翻成 Swift 字面值，出錯機率高、價值零。 |
| **60 項斷言直接繼承** | `selftest.mjs` 是 Node 程式，可繼續在 Windows／Mac 上對同一份 `engine/*.js` 跑回歸測試。全 Swift 重寫則必須先重建整套測試才敢動。 |
| **降階邏輯已被實測校準** | `gateway.js` 的重試／降階／冷卻順位是依實測延遲排的（handbook §4.1），重寫容易改壞。 |
| **Android 階段可共用** | JavaScriptCore 亦可用於 Android（或改 QuickJS），一份引擎兩平台，避開 handbook §6 方案 A「兩份副本行為不一致」的風險。 |

**代價：** 多一層橋接、除錯較迂迴、JSContext 啟動有成本（實測應在數十毫秒量級，需驗證）。

### 3.3 App Store 審查上的注意

App Store 審查指南禁止**從網路下載並執行程式碼**，但**打包在 App bundle 內的解譯型程式碼是允許的**
（React Native、Hermes、Cordova 皆屬此類）。

**因此：`engine/*.js` 必須完整打包進 App bundle，不得做「線上更新提示詞」的設計。**
若未來想遠端更新提示詞，須改為「下載資料（JSON 字串）而非程式碼」的形式。這一點要寫進架構約束。

### 3.4 各層技術選擇

| 層 | 選擇 | 依據／備註 |
|---|---|---|
| UI | SwiftUI | iPad 用 `NavigationSplitView`（handbook §7.2） |
| 語音辨識 | `SFSpeechRecognizer`，`requiresOnDeviceRecognition = true` | 繁中在裝置端的辨識率**必須實測**；iOS 26 另有新的 Speech 轉寫 API，N0 一併評估 |
| 語音合成 | `AVSpeechSynthesizer` | zh-TW 內建、離線、免費 |
| 音訊管線 | `AVAudioEngine` + voice processing（回音消除） | **Barge-in 的關鍵**，N0 主要驗證對象 |
| 儲存 | SwiftData（文件與紀錄）＋ Keychain（API 金鑰） | 金鑰**絕不可**存 UserDefaults |
| 文件解析 | PDFKit（PDF）＋ ZIPFoundation（docx／pptx） | 沿用 D007「Office 自解、PDF 交模型」 |
| 引擎 | JavaScriptCore（方案 B′） | 見 §3.1 |
| 回歸測試 | Node `selftest.mjs`（引擎層）＋ XCTest（Swift 層） | handbook §10.2 |
| 最低系統版本 | 建議 iOS 17.0 或 18.0 | 待定，見 §9 |

### 3.5 本地模型：本階段**不納入**

handbook §8 的離線化路線（L0–L5）價值明確，但：

- 它與上架 App Store 是**兩件獨立的事**，混在一起做會讓兩邊都延後。
- §8.7 的七個問題（繁中自然度、人設一致性、JSON 穩定度…）需要一個**已能運作的 App** 才好比較。
- 模型檔動輒數百 MB～數 GB，會讓首次上架的體積與下載流程複雜度暴增。

**建議：V1 上架採雲端模式（沿用使用者自帶金鑰），架構上為本地模型留好介面（`tier` 抽象已經在了），
上架後再另立專案推進 L0。**

---

## 4. 專案結構規劃

```
D:\Hao+App\Ai_Sales_Coach_App\
├── README.md
├── .gitignore                        ← 必須排除金鑰與教材
├── MD檔/                             ← 規格文件（已有 01–04、11；本文件為 12）
│   ├── 01_PRODUCT_SPEC.md
│   ├── 02_AI_COACH_ENGINE.md
│   ├── 03_AI_MODEL_ARCHITECTURE.md
│   ├── 04_VOICE_ENGINE.md
│   ├── 07_SECURITY_IP_PRIVACY.md     ← 待補（N1 前）
│   ├── 08_APP_UX_UI_SPEC.md          ← 待補（N1 前）
│   ├── 11_IMPLEMENTATION_HANDBOOK.md
│   └── 12_NATIVE_APP_DEV_PLAN.md     ← 本文件
├── project/
│   ├── DECISION_LOG.md               ← 從 AiCoach 搬過來，繼續 D022 往下寫
│   ├── ROADMAP.md
│   └── APPSTORE_CHECKLIST.md         ← 上架清單（§7）
├── engine/                           ← ★ 共用 JS 引擎（單一真實來源）
│   ├── api.js  session.js  advisor.js  gateway.js
│   ├── knowledge.js  prompts.js  compliance.js
│   ├── platform.js                   ← 新增：host function 介面宣告
│   └── shims/web.js                  ← 網頁版用的 shim（維持 GitHub Pages 版可跑）
├── tests/
│   ├── selftest.mjs                  ← 引擎層回歸測試（Node）
│   └── GOLDEN_REFERENCE.md           ← 待建立（handbook §10.3）
├── ios/                              ← Xcode 專案（在 Mac 上建立）
│   └── AiSalesCoach/
│       ├── App/                      SwiftUI 畫面
│       ├── Voice/                    AVAudioEngine / STT / TTS / State Machine
│       ├── Bridge/                   JSContext + shims
│       ├── Data/                     SwiftData models
│       └── Resources/engine/         ★ 建置時從 /engine 複製進來
└── web/                              ← 保留現有網頁版（對照組與快速驗證用）
```

**關鍵設計：`/engine` 是唯一真實來源，iOS 與網頁版都從這裡取用。**
這讓「用網頁版快速驗證提示詞改動，再同步到 App」成為可能，也讓 `selftest.mjs`
測的永遠是 App 實際跑的那份程式碼。

---

## 5. 分階段計畫

階段編號沿用 handbook §7.4 的 N0–N4。**工作量以「級距」表示而非日期**，
因為我不知道你每週可投入的時數；確認後可換算成日期。

### N-1｜前置準備（在取得 Mac 之前就能做，Windows 上完成）

| # | 工作 | 產出 | 可在 Windows 完成 |
|---|---|---|---|
| 1 | 初始化 Git repo、建立目錄結構 | 專案骨架 | ✅ |
| 2 | 從 `AiCoach` 搬移引擎並抽出 platform 層 | `/engine` + `platform.js` | ✅ |
| 3 | 把 `fetch`／IndexedDB／`DecompressionStream` 的直接呼叫改為經 platform 層 | 引擎與平台解耦 | ✅ |
| 4 | 確認 `selftest.mjs` 在重構後仍全綠 | 回歸測試通過 | ✅ |
| 5 | 撰寫 `07_SECURITY_IP_PRIVACY.md`、`08_APP_UX_UI_SPEC.md` | 兩份規格 | ✅ |
| 6 | 建立 `tests/GOLDEN_REFERENCE.md` 初版（20～30 案例） | 測試集 | ✅ |
| 7 | 申請 Apple Developer Program（尤其公司帳號） | 帳號可用 | ✅ |

**完成條件：** 引擎已平台無關、測試全綠、Apple 帳號在申請中或已下來。
**價值：** 這一階段完全不需要 Mac，可以立刻開始，並且讓 Mac 到手後直接進 N0。

### N0｜語音 PoC（Go / No-Go 關卡）

| 目標 | 一支最小 Swift App：說話 → 辨識 → 呼叫 Gemini → TTS 播放，**含真正的 Barge-in** |
|---|---|

**通過條件**（取自 handbook §7.3 與 `04_VOICE_ENGINE.md` §110）：

```
□ 繁體中文／台灣口音辨識率可接受（安靜、辦公室、車內、戶外四種環境）
□ AI 說話時使用者插話 → 正確停止 TTS 並切到收音
□ 回音消除有效（AI 自己的聲音不會被辨識成使用者說話）
□ 咳嗽、背景雜音不會誤觸發 Barge-in
□ 連續 10 分鐘不崩、不過熱、不卡頓
□ 藍牙耳機／AirPods 路由切換正常
□ 來電、Siri 中斷後能恢復演練狀態
□ Voice-to-Voice 延遲符合 01 §29 的「≤2 秒」
```

> **handbook §7.4 明文：N0 不通過就不要往下走。**
> 若原生 Barge-in 做不出比網頁版明顯更好的體驗，原生化的主要理由不成立。
> **我會如實回報結果，不會為了推進進度而美化 N0 的數據。**

### N1｜引擎接上（「電話邀約」完整跑通）

| # | 工作 |
|---|---|
| 1 | `EngineBridge`：JSContext 建立、`engine/*.js` 載入、JSValue 轉換 |
| 2 | Native shims：`__fetch`（URLSession）、`__store`（SwiftData + Keychain）、`__log` |
| 3 | 登入流程（自帶金鑰）＋ 模型設定頁（沿用 D019「一個欄位」的簡化） |
| 4 | 功能二「電話邀約」完整流程：Persona → 演練 → 五項評分 → 教練回饋 |
| 5 | 難度系統 1–5（D021：信任度區間、引導次數、能否掛電話由程式控制） |
| 6 | XCTest：橋接層與資料層 |

**完成條件：** 在 iPhone 實機上用語音完成一次完整的電話邀約演練並取得評分，
且評分內容與網頁版對同一輸入的結果一致（用 Golden Reference 比對）。

### N2｜功能補齊

其餘五項功能 + 訓練紀錄（`01` §39）+ 個人能力成長（`01` §40）+ 文件管理
（含 `__unzip` shim 與 PDFKit）。

### N3｜iPad 適配

`NavigationSplitView` 大螢幕版面、分割視圖、外接鍵盤、橫豎向。
**注意：App Store 若宣稱支援 iPad，審查員會實際在 iPad 上測，版面破圖會被退。**

### N4｜上架準備

見 §7 完整清單。

### N5｜Android（本計畫不含，僅預留）

依 §3.2 的引擎共用設計，Android 可沿用同一份 `/engine`。成本評估另立文件。

---

## 6. 必須沿用的核心設計（不可在重寫時遺失）

以下取自 handbook §2 與 §3.1，**每一項都是付過代價換到的**。實作時我會逐項對照：

| # | 原則 | 落地位置 |
|---|---|---|
| 1 | Deterministic Engine + LLM 分工（程式管流程，LLM 管生成） | `session.js` 不動 |
| 2 | 明確狀態機，`end: true` 需程式採信（至少 4 回合） | `session.js` 不動 |
| 3 | Model Gateway 抽象，上層只知道 `fast` / `judge` | `gateway.js` 不動 |
| 4 | **難度由程式夾住關鍵數值**，預設 Level 1 | `session.js` + `prompts.js` |
| 5 | **個性由使用者指定，優先於模型判斷**；`scrubMeta()` 兜底 | `prompts.js` 不動 |
| 6 | **資訊邊界約束示範話術**（D012，本專案最重要的發現） | `prompts.js` + `demoLeaksPrivateInfo()` |
| 7 | 兩層防護：提示詞 + 程式規則 | `compliance.js`、各 scrub／validate 函式 |
| 8 | 知識一次結構化；**理賠查詢例外，回頭附條款原文** | `knowledge.js` + `advisor.js` |
| 9 | 錯誤在源頭正規化；認不出就回 `null`；錯誤要能行動 | `__fetch` shim 必須實作同樣的正規化 |
| 10 | 複雜度留在系統裡，不外露給使用者 | UI 設計 |

**特別提醒（handbook §4.3）：** 「漏一個 `await`」這類 bug 不拋例外，只會安靜地給錯答案。
Swift ↔ JS 橋接會新增一整批非同步邊界，**這是本專案最容易重演該錯誤的地方**，
必須在橋接層做明確的錯誤傳遞測試。

---

## 7. App Store 上架清單

### 7.1 權限與隱私

```
□ NSMicrophoneUsageDescription — 具體說明「用於語音對練，錄音不上傳」
□ NSSpeechRecognitionUsageDescription — 說明是否在裝置端進行
□ App Store 隱私標籤：對話內容是否傳送、傳給誰（自帶金鑰＝傳給使用者選的服務商）
□ 首次啟動的合規提醒（01 §25）不可省略
□ 「訓練工具，非保險／法律／財務建議」免責在 App 內可見
□ API 金鑰存 Keychain，不存 UserDefaults、不寫入 log
□ 隱私政策網頁（App Store Connect 必填欄位）
```

### 7.2 已知的審查風險（依風險排序）

| # | 風險 | 說明 | 對策 |
|---|---|---|---|
| 1 | **審查員無法測試** | 自帶金鑰模式下，審查員沒有 API 金鑰就打不開任何功能，這是常見的直接退件原因 | 提供審查專用測試金鑰於 App Review 備註，**或**內建一個不需金鑰的示範模式 |
| 2 | 保險／金融類審查 | 保險相關 App 可能觸發額外審查，要求證明業者資格 | App 定位須明確為「業務員自我訓練工具」，非保險銷售或諮詢；描述與截圖都要一致 |
| 3 | 最低功能性（4.2） | 若被視為「只是包一個網頁」會被退 | 方案 B′ 的 UI 與語音都是原生，此風險低；**但不可用 WKWebView 包網頁版上架** |
| 4 | 執行程式碼（2.5.2） | JS 引擎須完整內建，不得線上下載 | 見 §3.3，架構約束 |
| 5 | iPad 支援宣稱 | 宣稱支援就會被實測 | N3 完成後才勾選 iPad |
| 6 | AI 生成內容 | 需說明內容由 AI 生成、可能不準確 | 免責文字 + 年齡分級評估 |

### 7.3 素材

```
□ App 名稱（含 App Store 搜尋考量）與副標題
□ App 圖示（1024×1024，無圓角無透明）
□ iPhone 截圖（6.9" 與 6.5" 各一組）
□ iPad 截圖（13" 一組）
□ 描述文案、關鍵字、What's New
□ 分類（建議 Business 或 Education，待定）
□ 年齡分級問卷
□ 出口合規（使用加密：HTTPS 通常適用豁免，但須正確申報）
```

---

## 8. 風險清單

| # | 風險 | 影響 | 目前判斷 | 緩解 |
|---|---|---|---|---|
| R1 | 無 Mac 環境 | **阻斷** | 已確認 | §2，需你決定 |
| R2 | 公司帳號 D-U-N-S 申請耗時 | 延後上架 | 未知 | **現在就啟動** |
| R3 | 裝置端繁中辨識率不足 | 核心體驗 | 未實測 | N0 驗證；不足時評估 Whisper（會增加體積與延遲） |
| R4 | 原生 Barge-in 沒有明顯優勢 | **產品前提** | 未實測 | N0 為 Go/No-Go 關卡 |
| R5 | JSC 橋接的非同步錯誤傳遞出錯 | 安靜給錯答案 | 已識別 | 橋接層專門測試（§6 提醒） |
| R6 | 審查員無金鑰無法測試 | 退件 | 已識別 | §7.2 R1 對策，**需你決定要不要做示範模式** |
| R7 | 四家服務商（Anthropic／OpenAI／Groq／DeepSeek）仍未實測 | 功能宣稱不符 | handbook §1.4 已標記 | N1 補測，或先只宣稱 Gemini + OpenRouter |
| R8 | Golden Reference 未建立 | 無法驗證重寫後行為一致 | 已知缺口 | N-1 建立初版 |
| R9 | iPhone TTS `onend` 不觸發（handbook §4.5） | 流程卡死 | Web 版已遇過 | 原生 `AVSpeechSynthesizerDelegate` 也要加保險絲 |

---

## 9. 待你確認的決策點

依 `01_PRODUCT_SPEC.md` §50，以下屬「Agent 不得自行決定」，請逐項裁決：

### 9.1 已確認（2026-08-17）

| # | 決策 | 結果 | 落地 |
|---|---|---|---|
| **Q1** | iOS 建置環境 | **暫無 Mac，先做 Windows 上能做的** | 先完成 N-1，Mac 到位後進 N0 |
| **Q2** | Apple Developer 帳號 | **尚未申請** | ⚠️ **需你盡快啟動**，見 §9.3 |
| **Q3** | 引擎策略 | **JavaScriptCore 沿用（方案 B′）** | D022；N-1 已依此完成解耦 |
| **Q5** | 商業模式 | **未定** → V1 按自帶金鑰做 | 架構保留可切換伺服器的介面（D015 的可逆設計） |

### 9.2 仍待裁決

| # | 決策 | 選項 | 我的建議 | 何時需要答案 |
|---|---|---|---|---|
| **Q4** | V1 上架功能範圍 | 六大功能全上／先上「電話邀約＋痛點分析」 | **先上兩項**（縮短首次送審、降低審查面） | N1 開始前 |
| **Q6** | 審查用示範模式 | 做／不做（改為提供測試金鑰） | **做**。同時解決一般使用者「還沒有金鑰就看不到任何東西」的第一印象問題 | N1 開始前 |
| **Q7** | 最低支援 iOS 版本 | iOS 17／18／更高 | 取決於你的測試機 | N0 |
| **Q8** | 測試實機 | 手上有哪些 iPhone／iPad 型號 | 決定效能基準（`01` §28 原定 iPhone 14 Pro） | N0 |
| **Q9** | 本地模型 | V1 納入／V1 後另立專案 | **V1 後**（§3.5） | 已按「V1 後」推進 |
| **Q10** | 網頁版是否維持 | 維持並共用 `/engine`／凍結 | **維持** | 已按「維持」實作 |

### 9.3 Apple Developer 帳號：現在就該啟動

這是目前**唯一有長前置時間、且完全不受「沒有 Mac」影響**的項目：

- 個人（Individual）帳號：線上申請，通常數日內開通。
- 公司（Organization）帳號：**需要 D-U-N-S 編號**與法人登記資料，申請可能耗時數週。

**若要在 App Store 上顯示「豪老師 Hao+」為賣家名稱，必須是 Organization 帳號。**
個人帳號只能顯示你的個人姓名。

> **這件事不啟動，會在 N4 變成硬阻塞。** 建議本週內決定帳號類型並送出申請。

---

## 10. N-1 執行進度

### 10.1 已完成（2026-08-17，全部在 Windows 上）

| # | 工作 | 成果 |
|---|---|---|
| 1 | 專案骨架與 Git repo | `engine/` `web/` `tests/` `project/` `ios/`；`.gitignore` 已排除金鑰、簽章、教材 |
| 2 | 引擎搬移 | 9 檔進 `engine/`；`oauth.js` 移入 `web/`（純瀏覽器，D024） |
| 3 | **`engine/platform.js`** | 七項平台能力介面；`http()` 回傳型別標籤而非拋錯（D023） |
| 4 | 引擎解耦 | 六檔改走 platform 層；`store.js` 刪除（D024）；`session.js` 背景計時器改惰性清理（D025） |
| 5 | 兩份 shim | `shims/web.js`（瀏覽器）、`shims/node.js`（Node） |
| 6 | 測試可在無金鑰下執行 | `selftest.mjs` 分節修正 + 新增 `smoke.mjs`（D026） |
| 7 | 驗證 | **51 項斷言全綠，零 API 額度消耗**；網頁版在瀏覽器實載通過 |

**驗證細節：**

```
node tests/selftest.mjs 1   → 22/22   規則層（合規、品牌中立化、難度系統、PPTX 解析 13 頁）
node tests/smoke.mjs        → 29/29   平台契約、全模組載入、錯誤分類八種未變
瀏覽器實載                    → 12 個引擎模組全部 200；IndexedDB 往返正常；
                              web 與 node shim 對同一種失敗回報相同標籤
```

### 10.2 N-1 剩餘工作

| # | 工作 | 需要你的輸入 |
|---|---|---|
| 8 | 撰寫 `07_SECURITY_IP_PRIVACY.md` | 金鑰保管、隱私標籤範圍 —— 與 Q5 商業模式相關 |
| 9 | 撰寫 `08_APP_UX_UI_SPEC.md` | **需要你的產品意見**：畫面流程、iPad 版面取向 |
| 10 | 建立 `tests/GOLDEN_REFERENCE.md` 初版 | 20～30 案例。**建議由你提供真實情境**，這是領域知識，我編不出實務感 |
| 11 | 補測 Anthropic／OpenAI／Groq／DeepSeek | 需各家金鑰；或決定 V1 只宣稱 Gemini + OpenRouter（R7） |

### 10.3 進 N0 的前置

1. 取得 Apple Silicon Mac（§2）
2. Apple Developer 帳號開通（§9.3）
3. 確認測試實機型號（Q8）

**N0 是 Go/No-Go 關卡**，我會以實測數據回報，不會為了推進進度而美化結果。

---

## 11. 最後

handbook §12 說：

> **這個產品的價值不在模型多強，而在「程式有多懂業務實務」。**

本計畫的兩個核心判斷都源自這句話：

- **不重寫引擎**——因為 `prompts.js` 裡的領域知識是最難重建、最容易在翻譯中流失的資產。
- **N0 是 Go/No-Go**——因為原生化的價值必須用「使用者是否願意天天練」來檢驗，
  而不是用「技術上更先進」來自我說服。

---

**End of `12_NATIVE_APP_DEV_PLAN.md`**

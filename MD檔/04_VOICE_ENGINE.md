# AI業務教練 App｜Voice Engine 規格

**文件名稱：** `04_VOICE_ENGINE.md`  
**產品名稱：** AI業務教練  
**品牌：** 豪老師 Hao+  
**文件版本：** V1.0  
**文件狀態：** Draft / Architecture Baseline  
**上層文件：** `01_PRODUCT_SPEC.md`、`02_AI_COACH_ENGINE.md`、`03_AI_MODEL_ARCHITECTURE.md`

---

# 1. 文件目的

本文件定義「AI業務教練」的語音互動系統。

本產品不是單純的文字型 Chatbot，而是以：

> **語音對談、角色扮演、即時反應**

作為核心使用體驗之一。

因此 Voice Engine 必須能支援：

- 使用者說話
- AI 聽懂
- AI 即時思考
- AI 自然回答
- AI 說話
- 使用者可以打斷 AI
- 連續多輪語音對談
- 練習結束後產生評量

核心目標：

> **讓使用者感覺自己正在和一個真實客戶通電話，而不是在操作一個語音 Chatbot。**

---

# 2. Voice Engine 核心架構

V1 採：

```text
User Voice
    ↓
Audio Capture
    ↓
VAD
    ↓
STT
    ↓
AI Orchestrator
    ↓
Coach Engine
    ↓
LLM
    ↓
Response Planner
    ↓
TTS
    ↓
Audio Playback
```

同時支援：

```text
Barge-in
Streaming
Turn Detection
Session State
Voice Evaluation
```

---

# 3. Voice Engine 不等於 STT + TTS

Voice Engine 是完整的：

> **Conversation Audio Runtime**

因此除了：

- Speech-to-Text
- Text-to-Speech

之外，還必須處理：

- 說話開始
- 說話結束
- AI 是否正在說話
- 使用者是否打斷
- 是否重新聆聽
- 是否等待
- 是否需要重新辨識
- 對話狀態

---

# 4. 核心設計原則

## 4.1 Voice First

語音不是文字功能的附加項目。

在：

> 電話邀約語音對練

中，Voice 是主要互動方式。

---

# 5. 即時性優先

語音體驗中：

> 延遲比回答長度更重要。

AI 不應：

```text
使用者講完
↓
等待很久
↓
一次完整產生答案
↓
才開始播放
```

而應：

```text
使用者講完
↓
快速取得部分結果
↓
開始生成
↓
TTS Streaming
↓
立即說話
```

---

# 6. Streaming Architecture

推薦：

```text
Audio Streaming
        ↓
Streaming STT
        ↓
Turn Detection
        ↓
LLM Streaming
        ↓
Sentence / Phrase Chunking
        ↓
Streaming TTS
        ↓
Audio Playback
```

---

# 7. Voice State Machine

Voice Engine 必須使用明確 State Machine。

建議狀態：

```text
IDLE
LISTENING
PROCESSING
THINKING
SPEAKING
INTERRUPTED
PAUSED
ENDING
ERROR
```

---

# 8. State Definitions

## IDLE

沒有進行語音互動。

```text
AI 不說話
AI 不錄音
```

## LISTENING

正在等待使用者說話。

```text
Mic ON
VAD ON
STT READY
```

## PROCESSING

使用者已經說完。

系統正在：

```text
Finalize STT
Normalize Text
Check Compliance
Update State
```

## THINKING

AI 正在：

```text
Select Model
Retrieve Knowledge
Generate Response
```

## SPEAKING

AI 正在播放 TTS。

## INTERRUPTED

使用者打斷 AI。

必須：

```text
Stop TTS
Flush Audio Buffer
Stop Current Generation if possible
Switch to LISTENING
```

## ENDING

使用者結束練習。

Voice Engine：

```text
Stop Mic
Stop TTS
Finalize Transcript
Trigger Evaluation
```

---

# 9. Voice Session

每一次語音練習建立：

```text
voice_session_id
```

Session 至少記錄：

```text
session_id
scenario_id
customer_persona
start_time
end_time
turn_count
transcript
audio_metrics
model_version
voice_engine_version
```

---

# 10. Audio Capture

Audio Capture 負責：

- 麥克風權限
- 錄音
- Audio Buffer
- Sample Rate
- Channel
- Audio Session
- Interruption Handling

---

# 11. iOS Audio Session

iOS App 必須正確處理：

- 麥克風權限
- 音訊輸入
- 音訊輸出
- 藍牙耳機
- AirPods
- 電話中斷
- Siri / 系統音效
- App 進入背景

---

# 12. Microphone Permission

第一次使用語音功能：

應清楚說明：

> 「AI業務教練需要使用麥克風，才能進行語音對練。」

不得在沒有必要時要求權限。

---

# 13. VAD

VAD：

> Voice Activity Detection

主要功能：

判斷：

```text
有人說話
```

或：

```text
目前沒有說話
```

---

# 14. VAD 的重要性

沒有 VAD：

```text
錄音一直開著
```

會造成：

- 誤辨識
- 等待時間
- 電量消耗
- 錄音資料增加

因此 VAD 是 Voice Engine 核心元件。

---

# 15. End-of-Turn

系統必須判斷：

> 使用者是不是講完了？

不要只依賴：

> 固定秒數沉默。

可以綜合：

```text
VAD
+
Silence Duration
+
STT Partial Result
+
Semantic Completion
```

---

# 16. Turn Detection

一個完整 Turn：

```text
User Start
↓
User Speech
↓
User Pause
↓
User End
↓
AI Response
```

---

# 17. Pause Handling

業務員在真實通話中會：

- 思考
- 停頓
- 「嗯」
- 「那個」
- 重講
- 修正

系統不應過度敏感。

---

# 18. 建議 Turn Detection 策略

第一階段：

```text
VAD
+
Dynamic Silence Threshold
```

第二階段：

加入：

```text
Semantic End Detection
```

---

# 19. STT

Speech-to-Text 負責：

> 將使用者語音轉換為文字。

要求：

- 繁體中文
- 中文標點
- 業務術語
- 保險術語
- 台灣口音
- 即時 Streaming

---

# 20. STT Model Strategy

STT 必須與 LLM 分離。

可以：

```text
Local STT
```

或：

```text
Cloud STT
```

由 Voice Router 決定。

---

# 21. Local STT 優先

如果 Local STT：

- 速度足夠
- 中文品質足夠
- RAM 合理

則優先使用。

---

# 22. Cloud STT

Cloud STT 適合：

- 高準確率
- 複雜語音
- 噪音環境
- 長句

但：

> 必須考慮隱私與網路。

---

# 23. STT Normalization

STT 結果進入 Coach Engine 前：

```text
Raw Transcript
↓
Normalization
↓
Final Transcript
```

可能包含：

- 去除不必要 filler
- 修正標點
- 保留重要語氣詞
- 修正常見術語

---

# 24. 不要過度修正 STT

評估語音表現時：

> 原始語音特徵仍有價值。

因此：

```text
Raw Transcript
+
Normalized Transcript
```

最好都保留。

---

# 25. TTS

Text-to-Speech 負責：

> 將 AI 回應轉換成自然語音。

要求：

- 繁體中文
- 自然
- 低延遲
- Streaming
- 可選聲音
- Persona 適配

---

# 26. 客戶 Persona Voice

未來可建立：

```text
理性型
冷淡型
猶豫型
忙碌型
友善型
防備型
高壓型
```

每一種 Persona 可搭配：

- 語速
- 音調
- 停頓
- 情緒
- 聲音特質

---

# 27. Persona 不應只改聲音

Persona 必須由：

```text
Scenario Engine
+
Persona State
+
LLM
+
TTS Style
```

共同決定。

例如：

> 冷淡型客戶

不是只有：

> 聲音比較冷。

而是：

- 回答較短
- 主動資訊較少
- 比較容易拒絕
- 對時間敏感

---

# 28. TTS Streaming

不要等待完整回答才生成聲音。

推薦：

```text
LLM Token Stream
↓
Text Chunk
↓
TTS
↓
Audio Stream
```

---

# 29. Sentence Chunking

LLM 可能輸出：

```text
你好，我現在有點忙，不知道你找我有什麼事情？
```

可以切成：

```text
你好，我現在有點忙，
```

先播放。

再：

```text
不知道你找我有什麼事情？
```

---

# 30. 避免切太碎

不要：

```text
你
好
我
現
在
```

逐字 TTS。

會造成：

- 不自然
- 延遲
- 音色跳動

應以：

> 短語 / 句子

為基本 Chunk。

---

# 31. Barge-in

Barge-in 是：

> 使用者可以直接打斷 AI。

這是電話角色扮演非常重要的功能。

---

# 32. Barge-in 流程

```text
AI SPEAKING
↓
VAD detects user voice
↓
Stop TTS
↓
Clear audio queue
↓
Cancel / deprioritize current generation
↓
LISTENING
↓
STT
↓
AI response
```

---

# 33. Barge-in 的判斷

不能只因：

> 一個短暫聲音

就停止 AI。

應避免：

- 咳嗽
- 背景聲
- 雜音
- AirPods noise

造成誤觸發。

---

# 34. Barge-in Threshold

建立：

```text
minimum_voice_duration
```

以及：

```text
confidence_threshold
```

實際數值必須透過實機測試。

---

# 35. Echo Cancellation

AI 自己的聲音可能被麥克風再次收進去。

因此需要：

> Acoustic Echo Cancellation

或使用平台提供的：

> Voice Processing

避免：

```text
AI 說話
↓
Mic 收到
↓
STT 認成使用者說話
```

---

# 36. Noise Suppression

應考慮：

- 環境噪音
- 冷氣
- 車內
- 辦公室
- 咖啡廳

可以使用：

> Audio Session / Voice Processing / DSP

降低噪音。

---

# 37. Audio Route

需要支援：

```text
iPhone Speaker
Receiver
Wired Headphones
Bluetooth
AirPods
CarPlay
```

V1 先確保：

> iPhone Speaker + Bluetooth Headphones

---

# 38. Voice UX

畫面至少應呈現：

```text
Customer Persona
──────────────
🎙️ 正在聆聽

使用者：
「您好，我是……」

AI：
「你好，請問找我有什麼事情？」
```

---

# 39. 不應讓文字干擾語音

Voice Mode 中：

> 文字 Transcript 是輔助資訊。

主要注意力應在：

> 對話。

---

# 40. Voice Mode UI

推薦：

```text
Customer Avatar
+
Persona Name
+
Listening Indicator
+
Speaking Indicator
+
Transcript
+
Mute
+
End Practice
```

---

# 41. AI Speaking Indicator

AI 說話時：

```text
●●●
```

或：

> Audio Waveform

讓使用者知道：

> AI 正在說話。

---

# 42. User Listening Indicator

使用者說話時：

```text
🎙️ Listening...
```

---

# 43. Processing Indicator

如果 AI 正在處理：

```text
思考中...
```

但不要讓使用者等待太久。

---

# 44. Voice Pipeline Latency

應測：

```text
T1 = User End
T2 = STT Final
T3 = LLM First Token
T4 = TTS First Audio
T5 = AI Starts Speaking
```

關鍵：

> T5 - T1

---

# 45. Voice Latency KPI

V1 不在文件中硬性指定固定毫秒數。

應建立：

> Target

與：

> Maximum Acceptable

兩種 KPI。

最後透過 iPhone 14 Pro 實測決定。

---

# 46. Latency Optimization

優先順序：

```text
1. Streaming STT
2. Streaming LLM
3. Early TTS
4. Small Local Model
5. Warm Model
6. Context Compression
```

---

# 47. Local Voice Architecture

理想離線架構：

```text
Mic
↓
Local VAD
↓
Local STT
↓
Local LLM
↓
Local TTS
↓
Speaker
```

這是：

> Full Offline Voice AI。

---

# 48. Hybrid Voice Architecture

若手機效能不足：

```text
Local VAD
↓
Cloud STT
↓
Local / Cloud LLM
↓
Cloud TTS
```

或：

```text
Local STT
↓
Local LLM
↓
Cloud TTS
```

---

# 49. Voice Router

建立：

> Voice Router

根據：

```text
network
battery
device
privacy_mode
latency
model_availability
```

決定：

```text
STT provider
LLM provider
TTS provider
```

---

# 50. Voice Provider Interface

所有 STT / TTS 都應透過抽象介面。

例如：

```text
SpeechRecognizer
    start()
    stop()
    cancel()
    stream()

SpeechSynthesizer
    synthesize()
    stream()
    stop()
```

---

# 51. Provider 可替換

未來可以替換：

```text
Apple
Whisper-based
Cloud STT
Other STT
```

TTS：

```text
Apple
Local TTS
Cloud TTS
Other TTS
```

不應把 Provider 寫死在 Coach Engine。

---

# 52. Voice Error Handling

常見錯誤：

```text
Mic denied
STT failed
TTS failed
Network timeout
Model unavailable
Audio route changed
Interruption
Low memory
```

每種錯誤都應有：

> Recovery Strategy。

---

# 53. Mic Denied

顯示：

> 「需要開啟麥克風權限才能進行語音對練。」

提供：

> 前往設定

---

# 54. STT Error

若 Streaming STT 失敗：

```text
Retry
↓
Fallback Provider
↓
Ask user to repeat
```

---

# 55. TTS Error

如果 TTS 失敗：

可以：

```text
Retry
↓
Fallback TTS
↓
Text Display
```

至少不能讓整個練習 Session Crash。

---

# 56. Network Loss

如果 Cloud 模式中網路中斷：

```text
Detect
↓
Attempt Local Fallback
```

如果沒有 Local Capability：

> 暫停並提示使用者。

---

# 57. Model Load Failure

如果 Local Model 無法載入：

```text
Retry
↓
Clear Cache
↓
Reload
↓
Cloud Fallback
```

---

# 58. System Interruption

例如：

> 電話、Siri、AirPods 等造成音訊中斷。

Voice Engine 必須：

```text
Pause
↓
Store State
↓
Restore
```

---

# 59. Voice Session Recovery

中斷後不得重新開始整個練習。

應保留：

```text
Customer State
Conversation State
Current Turn
Model State if possible
```

---

# 60. Transcript

每一個 Turn 記錄：

```json
{
  "speaker": "user",
  "text": "...",
  "timestamp": "...",
  "duration": 3.2
}
```

AI：

```json
{
  "speaker": "customer_ai",
  "text": "...",
  "timestamp": "...",
  "duration": 2.8
}
```

---

# 61. Raw Audio

V1 不應預設永久保存完整錄音。

優先保存：

> Transcript + Evaluation Data。

若未來提供：

> 回聽功能

再設計 Audio Storage Policy。

---

# 62. Audio Privacy

若保存錄音：

必須：

- 明確告知
- 使用者主動同意
- 可刪除
- 本地優先
- Cloud 上傳需明確說明

---

# 63. Voice Evaluation

結束練習後：

```text
Transcript
+
Timing
+
Audio Features
+
Scenario
+
Customer State
```

送至：

> Evaluation Engine。

---

# 64. 五大評分項目

依既有產品規格：

1. 說話流暢度
2. 聲音語調的親切感
3. 客戶談話的內容掌握
4. 用戶的自信心
5. 用戶的專業度

每項：

> 0～5 星

允許：

```text
0.5
1.0
1.5
...
5.0
```

---

# 65. Voice Evaluation 的資料基礎

### 說話流暢度

可參考：

- 停頓
- 重複
- 語速
- filler
- 句子完整性

---

# 66. 聲音親切感

可參考：

- 語調變化
- 音量
- 語速
- Prosody
- 語氣

注意：

> 不可宣稱能從聲音精準判定人格或心理狀態。

---

# 67. 客戶內容掌握

主要依：

```text
Transcript
+
Scenario State
```

判斷。

---

# 68. 自信心

不得只靠：

> 聲音高低

判定。

可以綜合：

- 回答是否明確
- 是否過度猶豫
- 是否頻繁自我否定
- 是否能持續推進對話

---

# 69. 專業度

依：

```text
Product Knowledge
+
Sales Framework
+
Compliance
+
Conversation Quality
```

評估。

---

# 70. Voice Evaluation 原則

評分必須：

> Evidence-Based。

每個分數都應有：

```text
Observation
↓
Evidence
↓
Score
↓
Recommendation
```

---

# 71. 評分輸出

例如：

```text
說話流暢度 ★★★★☆
原因：
整體表達自然，但有幾次較長停頓。

建議：
下一次練習時，先準備一句開場話術。
```

---

# 72. Voice Feedback

回饋順序：

```text
先肯定
↓
指出具體優點
↓
指出一個最重要改善點
↓
給示範
↓
鼓勵再練一次
```

---

# 73. 不要一次指出太多問題

如果一次講：

> 10 個問題

使用者可能產生挫折。

V1 優先：

> Top 1～3 improvement points。

---

# 74. Realistic Customer Response

AI 客戶不應像：

> 老師。

而應像：

> 真實客戶。

例如：

```text
「嗯……我最近真的滿忙的。」
```

而不是：

```text
「根據你的話術，你下一步應該……」
```

---

# 75. Roleplay During Voice Mode

語音練習期間：

> 不即時教學。

遵循既有產品規格：

```text
Roleplay
→ Customer Only
```

不要：

```text
Customer
+
Coach
```

同時出現。

---

# 76. User卡住時

如果使用者卡住：

AI 可以自然引導：

```text
「你找我什麼事？」
```

或：

```text
「嗯，你可以直接說。」
```

但仍維持：

> 客戶身份。

---

# 77. 三次引導機制

若使用者連續三次無法有效推進：

```text
Guide 1
↓
Guide 2
↓
Guide 3
↓
Customer Politely Rejects
```

然後：

> 結束練習並進入 Feedback。

---

# 78. Compliance in Voice

Voice Engine 不得繞過 Compliance Engine。

流程：

```text
STT
↓
Compliance Check
↓
High Risk?
 ├── Yes → Intervention
 └── No → Roleplay
```

---

# 79. 違規內容處理

例如使用者在語音演練中提到：

- 退佣
- 存錢
- 紅包
- 回饋
- 利息
- 其他依現行保險業規範判定的高風險用語

Voice Engine 必須：

> 即時停止或中斷該段演練流程，交由 Compliance Engine 處理。

---

# 80. Compliance Response

不要讓 Voice Engine 自己發明法規。

應由：

> Compliance Engine

提供標準回應。

---

# 81. Voice Security

語音輸入可能包含：

- 客戶資料
- 個人資訊
- 商品資訊

因此：

> 不得預設把完整錄音上傳第三方。

---

# 82. PII

如果未來需要處理：

- 姓名
- 電話
- 地址
- 身分證資訊
- 財務資料

應加入：

> PII Detection / Masking。

---

# 83. Voice Log

V1 可記錄：

```text
session_id
turn_id
STT latency
LLM latency
TTS latency
total latency
model
provider
error
```

不一定保存 Audio。

---

# 84. Voice Performance Dashboard

內部開發階段應可看到：

```text
Average Latency
P50
P95
STT Accuracy
TTS Failure Rate
Barge-in Success
Session Crash Rate
```

---

# 85. Voice Benchmark

建立標準語音測試：

```text
安靜環境
辦公室
車內
戶外
耳機
手機喇叭
```

---

# 86. Chinese Benchmark

至少包含：

- 台灣繁體中文
- 常見保險術語
- 商品名稱
- 英文縮寫
- 數字
- 金額
- 百分比
- 年齡
- 日期

---

# 87. Insurance Vocabulary

建立：

> Insurance Vocabulary Dictionary

例如：

```text
保單
保費
保障
附約
要保人
被保險人
受益人
理賠
失能
醫療
重大傷病
長照
退休
```

實際詞庫應持續擴充。

---

# 88. Number Recognition

語音中：

```text
一百萬
100萬
一○○萬
1000000
```

應盡可能統一成：

> 結構化數值。

---

# 89. Amount Normalization

例如：

```text
「一年大概三萬五」
```

可標準化：

```text
annual_premium ≈ 35000
```

但：

> 不得在沒有足夠語境時擅自判定數字含義。

---

# 90. Voice + Product Training

商品行銷演練：

```text
Product Knowledge
+
Customer Persona
+
Voice Roleplay
```

例如：

> 使用者上傳公司商品教育簡報。

系統建立：

```text
Product Facts
Benefits
Features
Target Customers
Objections
FAQ
Compliance Notes
```

再進行語音演練。

---

# 91. Product Hallucination Prevention

AI 回答商品資訊時：

優先：

```text
Retrieved Product Facts
```

如果資料不存在：

> 明確表示不知道。

不得自行創造：

- 保費
- 利率
- 理賠條件
- 商品利益
- 法規內容

---

# 92. Voice Coach Architecture

完整架構：

```text
                ┌───────────────┐
                │ Microphone    │
                └───────┬───────┘
                        ↓
                     Audio
                        ↓
                      VAD
                        ↓
                       STT
                        ↓
                ┌───────────────┐
                │ Orchestrator  │
                └───────┬───────┘
                        ↓
                Compliance Check
                        ↓
                 Coach Engine
                        ↓
                  Model Router
                        ↓
                  Local / Cloud
                        ↓
                 Response Text
                        ↓
                  Text Chunking
                        ↓
                       TTS
                        ↓
                     Speaker
                        ↑
                    Barge-in
                        │
                       VAD
```

---

# 93. Voice Engine 與 Coach Engine 分工

Voice Engine 負責：

- 聽
- 說
- Audio
- Turn
- Barge-in
- Streaming

Coach Engine 負責：

- 教練邏輯
- Scenario
- Persona
- State
- Evaluation

兩者不得混在一起。

---

# 94. Voice Engine 與 Model Gateway

Voice Engine 不應直接呼叫某個 LLM。

錯誤：

```text
Voice Engine
→ Gemma
```

正確：

```text
Voice Engine
→ Coach Engine
→ Model Gateway
→ Selected Model
```

---

# 95. Voice Engine 與 Compliance

錯誤：

```text
Voice
→ LLM
→ 回答
```

正確：

```text
Voice
→ STT
→ Compliance
→ Coach
→ LLM
→ Compliance / Validation
→ TTS
```

必要時也可在輸出端再次檢查。

---

# 96. Output Safety Check

AI 即將說話前，可進行：

```text
Generated Text
↓
Safety / Compliance Validation
↓
Approved?
 ├── Yes → TTS
 └── No → Replace Response
```

這對保險業訓練非常重要。

---

# 97. Voice Response Policy

AI 客戶的語音回應：

應：

- 短
- 自然
- 口語
- 有停頓
- 符合 Persona

不應：

- 長篇大論
- 教科書式
- 過度正式
- 一次講太多

---

# 98. Default Response Length

角色扮演期間：

> 優先 1～3 句。

只有在情境需要時才延長。

---

# 99. Voice Persona Consistency

每一個 Session 中：

Persona 不應任意切換。

例如：

> 冷淡型客戶

不能突然變成：

> 熱情型客戶。

除非：

> Customer State 發生變化。

---

# 100. Customer State

可以使用：

```text
trust
interest
time_pressure
resistance
engagement
```

但這些屬於：

> Coaching State

不是心理測量。

---

# 101. State 更新

例如：

```text
良好需求探索
→ trust +5

強硬推銷
→ resistance +10

清楚回應疑慮
→ interest +5
```

實際數值由 Coach Engine 決定。

---

# 102. Voice Session End

結束方式：

### 使用者主動結束

```text
End Practice
```

### AI 判定情境結束

```text
Scenario Complete
```

### Customer Rejection

```text
Polite Rejection
→ End
```

---

# 103. Evaluation Trigger

Session End：

```text
Finalize Transcript
↓
Finalize Audio Metrics
↓
Finalize Scenario State
↓
Evaluation Engine
```

---

# 104. Evaluation 不應阻塞 UX

可以：

```text
Voice Session End
↓
Show 「正在分析你的表現...」
↓
Background Evaluation
↓
Feedback Ready
```

---

# 105. Voice History

每一次練習應保存：

```text
日期
情境
客戶 Persona
練習時間
評分
主要問題
改善建議
```

---

# 106. Voice Replay

未來功能：

> 回聽自己的練習。

需要：

```text
Audio Storage
```

但 V1 可以先不實作。

---

# 107. Voice Coach V1 MVP

必須完成：

```text
□ Mic Permission
□ Audio Capture
□ VAD
□ STT
□ Local/Cloud LLM
□ TTS
□ Streaming
□ Voice State Machine
□ Barge-in
□ Transcript
□ Roleplay
□ Session End
□ Evaluation
```

---

# 108. V1 暫不要求

可以延後：

```text
□ Voice Cloning
□ 多角色聲音庫
□ 情緒精準辨識
□ 高階語音生理分析
□ 語音換聲
□ Voice Replay
□ 多人同時對話
```

---

# 109. Voice PoC

正式 App 開發前：

必須建立：

> Voice PoC

最小流程：

```text
User speaks
↓
STT
↓
Small Local LLM
↓
TTS
↓
Speaker
```

再加入：

```text
Barge-in
```

---

# 110. Voice PoC Pass Criteria

必須實測：

```text
□ 中文辨識
□ 台灣口音
□ 延遲
□ TTS 自然度
□ Barge-in
□ 長時間運作
□ RAM
□ 發熱
□ 電量
□ Crash
```

---

# 111. iPhone 14 Pro 測試

V1 的主要硬體測試：

> iPhone 14 Pro

至少連續進行：

> 10～20 分鐘語音角色扮演。

觀察：

- 溫度
- 電量
- RAM
- 延遲
- Audio Drop
- Crash

---

# 112. 長時間 Voice Test

必須測：

```text
10 min
20 min
30 min
```

避免：

> Demo 可以，但實際使用 20 分鐘後開始卡頓。

---

# 113. Background / Lock

V1 可以先限制：

> Voice Training 必須保持 App 在前景。

未來再支援：

> Background Audio。

---

# 114. Battery Policy

Voice Session 中：

如果：

```text
Battery < threshold
```

可提示：

> 「目前電量較低，建議使用充電或切換節能模式。」

---

# 115. Thermal Policy

如果裝置溫度過高：

可：

```text
降低 Model Tier
↓
降低 TTS Quality
↓
降低 Processing
```

必要時：

> 暫停 AI。

---

# 116. Voice Model Selection

Voice Pipeline 不需要全部使用同一家公司。

例如：

```text
STT → Local
LLM → Local
TTS → Cloud
```

也可以：

```text
STT → Cloud
LLM → Local
TTS → Local
```

---

# 117. Voice Architecture 最佳實務

推薦：

> **Small Local LLM + Efficient STT + Low-latency TTS**

而不是：

> Large LLM + Slow STT + High Quality TTS。

因為：

> 即時性是語音教練的核心體驗。

---

# 118. 最重要的 UX 原則

使用者不應該感覺：

> 「AI 正在計算。」

而應該感覺：

> 「這個客戶正在回我。」

---

# 119. 最終 Voice Architecture

```text
┌──────────────────────────────────────────────┐
│              AI業務教練 Voice Mode            │
├──────────────────────────────────────────────┤
│                                              │
│  Microphone                                  │
│      ↓                                       │
│  Audio Capture                               │
│      ↓                                       │
│  VAD / Echo Cancellation / Noise Suppression │
│      ↓                                       │
│  Streaming STT                               │
│      ↓                                       │
│  Turn Detection                              │
│      ↓                                       │
│  AI Orchestrator                             │
│      ↓                                       │
│  Compliance Engine                           │
│      ↓                                       │
│  Coach Engine                                │
│      ↓                                       │
│  Model Gateway                               │
│      ↓                                       │
│  Local Small LLM / Cloud LLM                 │
│      ↓                                       │
│  Output Validation                            │
│      ↓                                       │
│  Sentence Chunking                           │
│      ↓                                       │
│  Streaming TTS                               │
│      ↓                                       │
│  Audio Playback                              │
│                                              │
│              ↑                               │
│          Barge-in                            │
│              │                               │
└──────────────────────────────────────────────┘
```

---

# 120. 核心結論

「AI業務教練」的語音能力，不應被設計成：

> ChatGPT 加一個麥克風。

而應設計成：

> **一個專為業務實戰角色扮演而打造的即時 Voice AI Engine。**

真正的產品核心是：

```text
Voice
+
Persona
+
State
+
Roleplay
+
Compliance
+
Evaluation
```

---

# 121. Agent 工作規則

Work / Codex 在實作本文件時：

## 必須

- 使用 Voice State Machine
- STT / LLM / TTS 解耦
- 支援 Streaming
- 支援 Barge-in
- 支援 Error Recovery
- 支援 Local / Cloud Provider
- 使用 Model Gateway
- 保留 Transcript
- 支援 Evaluation
- 考慮 iPhone 14 Pro
- 進行實機 Latency Benchmark
- 進行長時間 Thermal / Battery Test

## 不得

- 將 STT、LLM、TTS 寫死成單一 Provider
- 將 Voice Engine 直接綁定某一個 LLM
- 讓 AI 說話時無法被打斷
- 把完整錄音預設上傳 Cloud
- 讓 LLM 自行決定 Compliance
- 讓語音延遲問題被「更換大型模型」掩蓋
- 在未 Benchmark 前宣稱某模型一定能順暢運行

---

# 122. Acceptance Criteria

V1 Voice Engine 必須：

```text
□ 能使用 iPhone 麥克風
□ 能進行繁體中文 STT
□ 能執行 Local Small LLM
□ 能輸出 TTS
□ 能進行 Streaming
□ 能偵測使用者說話
□ 能偵測使用者說完
□ 能被使用者打斷
□ 能連續多輪對談
□ 能保持客戶 Persona
□ 能完成至少一個完整角色扮演
□ 能保存 Transcript
□ 能觸發五項能力評估
□ 能處理網路中斷
□ 能處理 STT/TTS Error
□ 能處理音訊中斷
```

---

# 123. Definition of Done

Voice Engine 只有在：

```text
Voice PoC
+
iPhone 14 Pro Test
+
10～20 Minute Session
+
Barge-in
+
Streaming
+
Evaluation
```

全部通過後，才視為：

> V1 Voice Engine Ready。

---

# 124. 後續文件

本文件完成後，建議下一階段建立：

```text
05_RAG_KNOWLEDGE_ENGINE.md
```

定義：

- PPT / PDF 上傳
- 文件解析
- OCR
- Chunking
- Embedding
- Vector Store
- Retrieval
- 商品知識庫
- 商品行銷演練
- Knowledge Grounding
- Hallucination Prevention

之後再建立：

```text
06_COMPLIANCE_ENGINE.md
```

專門定義保險業務合規檢查。

---

# 125. 最終架構原則

整個 AI業務教練的 Voice Engine，最重要的一句話：

> **不是讓 AI「會說話」，而是讓 AI「像一個真實客戶一樣與業務員對話」。**

因此 Voice Engine 的 KPI 最終不是：

> TTS 聽起來多漂亮。

而是：

> **使用者是否會忘記自己正在跟 AI 練習。**

---

**End of `04_VOICE_ENGINE.md`**

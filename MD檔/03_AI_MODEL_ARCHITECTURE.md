# AI業務教練｜AI Model Architecture 規格

**文件名稱：** `03_AI_MODEL_ARCHITECTURE.md`  
**產品名稱：** AI業務教練  
**品牌：** 豪老師 Hao+  
**文件版本：** V1.0  
**文件狀態：** Draft / Architecture Baseline  
**上層文件：** `01_PRODUCT_SPEC.md`、`02_AI_COACH_ENGINE.md`  
**主要用途：** 定義 AI業務教練的模型層、模型選擇策略、Local AI 架構、Cloud Fallback、模型閘道、Context 管理、推理策略，以及手機端部署的技術原則。

---

# 1. 文件目的

本文件定義「AI業務教練」的 AI Model Architecture。

核心問題不是：

> 「哪一個模型最強？」

而是：

> **「哪一種模型架構，能在手機上兼顧智慧、速度、語音互動、隱私、耗電與可維護性？」**

本專案的模型架構必須同時考慮：

- iPhone 14 Pro 等級裝置
- 小型 Local LLM
- 語音對談
- 商品教材理解
- RAG / Knowledge Retrieval
- 角色扮演
- 長對話
- 即時回應
- 離線能力
- Cloud Fallback
- 未來模型替換

---

# 2. 核心架構原則

AI業務教練不得設計成：

```text
App
 ↓
單一大型 LLM
 ↓
所有事情都交給 LLM
```

應採：

```text
App
 ↓
AI Orchestrator
 ↓
Model Gateway
 ├── Local LLM
 ├── Cloud LLM
 └── Specialized Models
```

並搭配：

```text
State Machine
+
Knowledge Retrieval
+
Compliance Engine
+
Voice Engine
+
Evaluation Engine
```

---

# 3. 最重要的架構決策

## 3.1 Model-Agnostic

AI Coach Engine 不得綁死任何單一模型。

例如：

```text
Gemma
Qwen
Llama
Phi
其他未來模型
```

都應可透過 Model Gateway 接入。

---

# 4. Model ≠ Product Intelligence

本產品的智慧不是單純來自 LLM。

應理解為：

```text
Product Intelligence
=
LLM
+
Prompt
+
State
+
Knowledge
+
Rules
+
Evaluation
+
Scenario
+
Compliance
```

因此：

> 即使 Local LLM 比雲端模型小，也可以透過良好的 Engine Architecture 提升整體產品能力。

---

# 5. Target Device

V1 的主要行動裝置目標：

> iPhone 14 Pro

同時希望未來支援：

- iPhone 15
- iPhone 16
- iPhone 17
- iPad
- Android 高階裝置

---

# 6. iPhone 14 Pro 的模型設計原則

iPhone 14 Pro 的硬體能力足以作為：

> **小型 Local AI 模型的主要測試平台。**

但不應假設：

> 可以舒適地執行任何 4B、7B、8B 模型。

模型是否能順暢運行，需要實機測試：

- RAM 壓力
- 模型量化格式
- KV Cache
- Context Length
- Token Generation Speed
- Metal / GPU 加速
- CPU 使用率
- 溫度
- 電量消耗

---

# 7. V1 Local Model Strategy

本專案的第一優先策略：

> **2B 級小型模型作為 Local LLM 起點。**

原因：

- 記憶體需求較低
- 載入速度較快
- 推理速度較快
- 發熱較低
- 電量消耗較低
- 更適合手機端

但：

> 2B 不代表一定足夠。

必須透過 Benchmark 驗證實際教練能力。

---

# 8. Gemma E2B 定位

如果專案選擇 Gemma E2B 類型的小型模型：

其定位應為：

> **Local Real-Time Coach Model**

主要負責：

- 簡單對話
- 客戶角色扮演
- 短上下文理解
- 基本異議
- 即時語音互動
- 離線訓練

---

# 9. E2B 不應獨立負責

E2B 不應獨立負責：

- 複雜商品條款判讀
- 大型教材完整理解
- 法規最終判定
- 長文件摘要
- 複雜跨文件推理
- 高精度評量

這些應由：

```text
RAG
+
Rules
+
Specialized Models
+
Cloud Fallback
```

共同完成。

---

# 10. 4B 級模型定位

4B 級模型可作為：

> **Higher Intelligence Model**

用途：

- 複雜需求分析
- 商品知識理解
- 長文本分析
- 高難度角色扮演
- 高品質 Feedback
- 複雜評估

但 V1 不應將 4B 視為：

> 所有手機的預設模型。

---

# 11. Model Tier

建議建立：

```text
Tier 0
Rule Engine

Tier 1
Small Local LLM
約 1B～2B

Tier 2
Medium Local LLM
約 3B～4B

Tier 3
Cloud LLM
高能力模型
```

---

# 12. Model Routing

根據任務決定模型。

例如：

```text
簡單角色扮演
→ Tier 1

一般需求分析
→ Tier 1 / Tier 2

商品教材分析
→ Tier 2 / Tier 3

高品質評量
→ Tier 3

合規檢查
→ Rule Engine + Knowledge
```

---

# 13. 不要讓所有請求都使用最高模型

這是本產品降低成本與耗電的關鍵。

錯誤：

```text
Every Request
→ Largest Model
```

正確：

```text
Task Classification
↓
Smallest Capable Model
```

---

# 14. Model Router

建立：

> `Model Router`

輸入：

```text
task_type
complexity
context_length
device_capability
network_state
battery_state
privacy_mode
```

輸出：

```text
selected_model
```

---

# 15. Model Router 範例

```text
if task == simple_roleplay:
    use_local_small_model

if task == complex_product_analysis:
    use_local_medium_model
    or cloud_model

if task == compliance:
    use_rules_first

if network == unavailable:
    use_local_model

if battery == low:
    prefer_small_model
```

---

# 16. Local First Strategy

預設：

> **Local First**

優先使用本地模型。

原因：

- 隱私
- 速度
- 離線
- 成本
- 使用體驗

---

# 17. Cloud Optional Strategy

Cloud AI 不應是必要條件。

可以提供：

> 「智慧增強模式」

例如：

```text
Local Mode
→ 基本訓練

Smart Mode
→ 雲端高階模型
→ 更強分析
→ 更高品質回饋
```

---

# 18. Privacy Mode

建議提供：

### 完全離線

```text
所有 AI
→ Local
```

### 混合模式

```text
一般對話
→ Local

複雜分析
→ Cloud
```

### Cloud Enhanced

```text
大部分 AI
→ Cloud
```

---

# 19. Model Gateway

所有模型必須透過：

> `Model Gateway`

統一介面。

概念：

```text
Coach Engine
      ↓
Model Gateway
      ↓
┌───────────────┐
│ Local LLM     │
│ Cloud LLM     │
│ Future Model  │
└───────────────┘
```

---

# 20. Model Gateway Interface

概念 API：

```text
generate()
stream()
chat()
embed()
healthCheck()
getCapabilities()
```

實際 API Schema 由後續技術文件定義。

---

# 21. Model Capability Metadata

每個模型應描述：

```json
{
  "name": "local-small",
  "parameters": "2B",
  "context_window": "...",
  "supports_streaming": true,
  "supports_tools": false,
  "supports_json": true,
  "supports_multilingual": true,
  "supports_vision": false
}
```

實際欄位依模型 Runtime 調整。

---

# 22. Model Runtime

iOS Local LLM Runtime 應保持可替換。

候選技術方向：

```text
llama.cpp / GGUF
MLX / MLX Swift
Core ML
ExecuTorch
其他適合 Apple Silicon / iOS 的 Runtime
```

V1 不應在產品規格中永久鎖死單一 Runtime。

必須以：

> 實機 Benchmark

決定。

---

# 23. Runtime Selection Criteria

評估 Runtime：

```text
Inference Speed
Memory Usage
Model Compatibility
Metal Acceleration
iOS Integration
Streaming
Quantization
Model Loading
Thermal Behavior
Battery Usage
Community / Maintenance
```

---

# 24. Quantization

手機 Local LLM 優先使用量化模型。

候選：

```text
INT8
INT6
INT5
INT4
```

實際使用哪一種：

> 不以理論決定，而以 iPhone 14 Pro Benchmark 決定。

---

# 25. Quality vs Size

模型越小：

優點：

- 快
- 省電
- 低 RAM

缺點：

- 推理能力降低
- 長上下文能力降低
- 角色一致性可能下降
- 複雜需求分析能力降低

因此：

> **模型大小不是唯一 KPI。**

---

# 26. Core Benchmark

每一個候選模型至少測試：

```text
1. Token Speed
2. First Token Latency
3. RAM Usage
4. Model Load Time
5. Thermal
6. Battery
7. Roleplay Quality
8. Persona Consistency
9. Instruction Following
10. Chinese Quality
11. Feedback Quality
12. Long Context Quality
```

---

# 27. Voice AI 架構

AI業務教練不是純文字 Chatbot。

核心體驗：

> **語音對談。**

因此：

```text
User Voice
↓
STT
↓
AI Coach Engine
↓
LLM
↓
TTS
↓
Voice Output
```

---

# 28. Speech Stack

建議拆成：

```text
Voice Activity Detection
↓
Speech-to-Text
↓
LLM
↓
Text-to-Speech
```

而不是把：

> Voice → LLM

視為單一功能。

---

# 29. STT Model

STT 可以獨立於 LLM。

優先考慮：

- 本地語音辨識
- 中文繁體
- 台灣口音
- 雜訊環境
- 即時辨識
- Streaming

---

# 30. TTS Model

TTS 也應獨立。

需求：

- 中文自然
- 低延遲
- 可串流
- 支援不同聲音角色
- 本地或雲端可切換

---

# 31. Voice Latency

角色扮演體驗中：

> 延遲比模型「理論智商」更重要。

目標：

```text
User stops speaking
↓
STT
↓
LLM
↓
TTS
↓
AI starts speaking
```

應盡可能降低等待時間。

V1 應建立實測 KPI，而不是在未測試前承諾固定毫秒數。

---

# 32. Streaming Architecture

推薦：

```text
STT Streaming
      ↓
LLM Streaming
      ↓
Sentence Chunking
      ↓
TTS Streaming
```

而不是：

```text
STT Complete
↓
LLM Complete
↓
TTS Complete
↓
Play
```

---

# 33. Barge-in

Voice Engine 必須設計：

> 使用者可以打斷 AI。

流程：

```text
AI Speaking
↓
User Speech Detected
↓
Stop TTS
↓
Capture User
↓
STT
↓
Continue
```

---

# 34. Voice Turn Detection

AI 需要知道：

> 使用者什麼時候說完？

可使用：

- VAD
- Silence Detection
- End-of-Turn Model
- 語意判斷

避免：

> 使用者只是停頓 0.5 秒，AI 就搶話。

---

# 35. Voice Evaluation Limitation

如果只有 STT 文字：

可以較可靠評估：

- 用字
- 流暢度文字表現
- 對話內容
- 回應速度

但不能精準評估：

- 真正音色
- 親切程度
- 音量
- 情緒
- 語調

因此：

> 聲音評分必須依據實際可取得的 audio features。

---

# 36. Audio Feature Layer

若未來要評估聲音，可建立：

```text
Pitch
Energy
Speech Rate
Pause
Duration
Voice Activity
Prosody
```

再交給 Evaluation Engine。

---

# 37. Product Knowledge + LLM

商品教材不應直接全部塞入 Context。

正確：

```text
User uploads PPT/PDF
↓
Document Parser
↓
Text / Table / Image Extraction
↓
Chunking
↓
Embedding
↓
Vector Store
↓
Retriever
↓
Relevant Chunks
↓
LLM
```

---

# 38. Model Context Window

不要把：

> 「模型最大 Context」

等同：

> 「App 應該每次都送那麼多內容。」

實際 Context 應：

```text
System
+
State
+
Persona
+
Recent Conversation
+
Relevant Knowledge
```

---

# 39. Context Budget

Context 必須有預算。

例如概念：

```text
System Rules       20%
State              10%
Persona             10%
Recent Conversation 30%
Knowledge           20%
Current Turn        10%
```

實際比例透過 Benchmark 調整。

---

# 40. Long Context Strategy

長文件：

> 不靠單一 LLM Context 解決。

採：

```text
Retrieval
+
Summarization
+
Structured State
```

---

# 41. Document Intelligence

使用者上傳商品簡報後：

第一階段：

> Document Ingestion

第二階段：

> Knowledge Structuring

第三階段：

> Retrieval

第四階段：

> Coaching

---

# 42. Product Training Scenario

未來「商品行銷演練」可使用：

```text
Product Knowledge
↓
Product Scenario
↓
Customer Persona
↓
Customer Need
↓
Roleplay
↓
Evaluation
```

---

# 43. RAG 與 LLM 的責任分工

RAG 負責：

> 「資料在哪裡？」

LLM 負責：

> 「如何理解與表達？」

Application Logic 負責：

> 「現在應該做什麼？」

Compliance Engine 負責：

> 「這樣做是否允許？」

---

# 44. Compliance Architecture

法規不應完全依賴 LLM 記憶。

應採：

```text
Rule Engine
+
Compliance Knowledge Base
+
LLM Interpretation
```

其中：

> Rule Engine 優先。

---

# 45. Compliance Routing

```text
User Message
↓
Keyword / Rule Detection
↓
Risk Classification
↓
High Risk?
 ├── Yes → Block / Intervention
 └── No  → Continue
```

---

# 46. AI Evaluation Architecture

評估不要完全交給同一個模型。

推薦：

```text
Roleplay Model
+
Transcript
+
Evaluation Rules
+
Evaluation Model
```

---

# 47. Judge Model

未來可建立：

> Coach Model

與：

> Judge Model

分離。

例如：

```text
Small Local Model
→ 即時角色扮演

Larger Model
→ 高品質評估
```

---

# 48. Judge Model 不一定需要本地

如果手機效能不足：

```text
Roleplay
→ Local

Evaluation
→ Cloud
```

這是合理架構。

---

# 49. Dual Model Architecture

推薦的 V1.0 架構：

```text
                ┌──────────────┐
                │ Small Local  │
                │    LLM       │
                └──────┬───────┘
                       │
                       ▼
                Real-time Roleplay

                ┌──────────────┐
                │ Larger Model │
                │ Optional     │
                └──────┬───────┘
                       │
                       ▼
                Deep Evaluation
```

---

# 50. 三層 AI 架構

更完整的未來版本：

```text
Layer 1
Rule / Deterministic AI

Layer 2
Small Local LLM

Layer 3
Advanced Cloud LLM
```

---

# 51. Layer 1

負責：

- 狀態
- 規則
- 合規
- Routing
- Format
- 基礎分類

優點：

> 穩定。

---

# 52. Layer 2

負責：

- 即時聊天
- Persona
- Roleplay
- 簡單分析
- 離線訓練

優點：

> 快。

---

# 53. Layer 3

負責：

- 複雜推理
- 深度商品分析
- 高品質回饋
- 長文件
- 高難度情境

優點：

> 強。

---

# 54. Local Model Loading

App 啟動時不一定立即載入 LLM。

可以：

```text
App Launch
↓
UI Ready
↓
User Starts AI Training
↓
Load Model
↓
Warm Up
↓
Ready
```

降低啟動時間。

---

# 55. Model Preloading

如果使用者即將進入語音訓練：

可以：

> 預先載入 Local Model。

例如：

```text
User selects:
「電話邀約」

↓
開始載入 Model
↓
使用者閱讀示範
↓
Model Ready
↓
Start Roleplay
```

---

# 56. Memory Management

Local AI 必須監控：

```text
available_memory
model_memory
kv_cache_memory
audio_buffer
document_cache
```

如果記憶體不足：

```text
縮短 Context
↓
清理 Cache
↓
降低模型
↓
Fallback
```

---

# 57. Thermal Management

連續語音訓練可能造成：

> 裝置升溫。

因此需要：

```text
Session Duration
Token Rate
Model Size
Temperature
Battery
```

動態管理。

---

# 58. Battery-Aware AI

當電量較低：

可以：

```text
降低 Model
降低 Context
降低 TTS Quality
降低 Background Processing
```

而不是直接讓 App 無法使用。

---

# 59. Offline Capability

離線時至少應保留：

```text
基本角色扮演
基本情境
基本評分
本地教材
本地語音
歷史紀錄
```

如果某功能需要 Cloud：

> 清楚提示使用者。

---

# 60. Network-Aware Routing

```text
Wi-Fi
→ 可使用 Cloud Enhanced

Mobile Data
→ 預設 Local

Offline
→ Local Only
```

實際策略可由使用者設定。

---

# 61. Cost-Aware Routing

Cloud 模式必須考慮：

- Token
- API Cost
- 使用量
- 訂閱方案

因此：

> 高成本模型不是預設。

---

# 62. Model Cache

Local Model 檔案可能很大。

應支援：

- 下載
- 更新
- 刪除
- 版本管理
- 完整性檢查
- 儲存空間檢查

---

# 63. Model Versioning

模型必須具有：

```text
model_id
version
quantization
runtime
checksum
release_date
```

例如概念：

```text
coach-small
v1
Q4
runtime-x
```

---

# 64. Model Update

模型更新不能直接覆蓋。

流程：

```text
Download New
↓
Verify
↓
Benchmark
↓
Install
↓
Keep Old Fallback
↓
Activate
```

---

# 65. Rollback

如果新模型造成：

- 速度下降
- 角色崩壞
- 評分錯誤
- Crash

應能：

> 回復舊模型。

---

# 66. Prompt Versioning

Prompt 也必須版本化：

```text
coach_prompt_v1
coach_prompt_v2
```

模型與 Prompt 應一起記錄：

```text
Model Version
+
Prompt Version
+
Engine Version
```

方便追蹤問題。

---

# 67. Reproducibility

一次訓練紀錄至少保留：

```text
session_id
model_version
prompt_version
engine_version
scenario_id
difficulty
timestamp
```

---

# 68. Randomness

角色扮演需要自然變化。

可以使用：

> controlled randomness

避免：

> 每次完全相同。

但評估測試需要：

> deterministic mode。

---

# 69. Temperature Strategy

概念：

```text
Roleplay
→ moderate creativity

Compliance
→ low creativity

Evaluation
→ low creativity

Feedback
→ moderate
```

實際參數由模型 Runtime 決定。

---

# 70. Structured Output

重要 Engine 任務應優先使用：

> JSON / Structured Output

例如：

```json
{
  "intent": "continue_roleplay",
  "risk": "none",
  "state_update": {
    "trust": 62
  }
}
```

避免讓程式解析自然語言。

---

# 71. Function Calling

如果 Local Model 支援：

可使用：

```text
get_product_info()
get_customer_state()
update_session()
check_compliance()
end_roleplay()
```

若不支援：

> 由 Orchestrator 以程式控制。

---

# 72. Tool Use 原則

不要讓模型任意呼叫工具。

工具權限必須由：

> Orchestrator

控制。

---

# 73. Security

Local Model 不能被視為：

> 完全安全。

需要防止：

- Prompt Injection
- Knowledge Injection
- Malicious Document
- Tool Abuse
- Data Exfiltration

---

# 74. Uploaded Document Security

使用者上傳的 PPT/PDF 可能包含：

> 惡意指令。

因此：

> 文件內容只能被視為「資料」，不能自動成為 System Instruction。

---

# 75. Prompt Injection Defense

如果教材出現：

> 「Ignore previous instructions...」

AI 應視為教材文字。

不得因此：

- 修改 System Rules
- 修改 Compliance
- 輸出內部資料
- 改變 AI 身份

---

# 76. Local Privacy

Local AI 的主要優勢之一：

> 客戶模擬資料不需要離開手機。

但 App 仍需清楚告知：

- 哪些資料留在裝置
- 哪些資料會上傳
- Cloud 模式是否會傳送對話
- 使用者如何刪除資料

---

# 77. Telemetry

如果產品需要分析使用狀況：

應優先收集：

```text
anonymous metrics
performance metrics
crash logs
model latency
```

避免預設上傳：

> 完整業務對話。

---

# 78. Model Benchmark Dataset

建立專屬測試集：

```text
Roleplay Cases
Objection Cases
Needs Discovery Cases
Product Cases
Compliance Cases
Long Context Cases
Voice Cases
```

---

# 79. Benchmark Categories

至少：

### A. Roleplay

測：

- 自然度
- Persona
- 一致性

### B. Coaching

測：

- 回饋品質
- 建議實用性

### C. Knowledge

測：

- 商品資料引用
- Hallucination

### D. Compliance

測：

- 違規偵測

---

# 80. Model Selection Score

可以建立：

```text
Model Score
=
Roleplay 25%
+
Chinese 15%
+
Latency 15%
+
Memory 15%
+
Voice Experience 10%
+
Instruction Following 10%
+
Feedback 10%
```

實際權重可在 Benchmark 後調整。

---

# 81. 不要只看 Benchmark Leaderboard

公開 benchmark 只能作為參考。

真正選型依據：

> **AI業務教練自己的測試集。**

---

# 82. Model A/B Testing

可以測：

```text
Model A
vs
Model B
```

比較：

- 使用者完成率
- 平均回合數
- Role Consistency
- 評分一致性
- 延遲
- Crash
- 電量

---

# 83. Recommended V1 Architecture

第一版推薦：

```text
                 AI業務教練 App
                        │
                        ▼
                AI Orchestrator
                        │
         ┌──────────────┼──────────────┐
         ▼              ▼              ▼
    State Engine    Compliance      Knowledge
         │              │              │
         └──────────────┼──────────────┘
                        ▼
                  Model Gateway
                        │
             ┌──────────┴──────────┐
             ▼                     ▼
       Local Small LLM       Cloud LLM
          1B～2B              Optional
             │
             ▼
        Voice Engine
       ┌──────┴──────┐
       ▼             ▼
      STT            TTS
```

---

# 84. V1 預設模型策略

建議：

> **Small Local Model First**

以約 2B 級模型作為第一個 Benchmark 起點。

但：

> 不在尚未實機測試前，永久指定某一個模型。

---

# 85. Gemma E2B 的實際定位

如果 Gemma E2B 在 iPhone 14 Pro Benchmark 通過：

可作：

> V1 Default Local Roleplay Model。

如果 Benchmark 不足：

則應測試其他：

- 1B～2B 模型
- 2B～4B 模型
- 不同量化版本

最後選：

> **整體體驗最佳者。**

---

# 86. 4B 模型策略

4B 不必被排除。

但應採：

```text
High-end Device
→ 4B Local

Normal Device
→ 2B Local

Low-end Device
→ smaller / Cloud
```

即：

> **Device-Adaptive Model Routing**

---

# 87. Device Capability Profile

App 第一次啟動可建立：

```text
device_class
available_memory
os_version
gpu_capability
neural_engine
battery_state
storage_available
```

然後決定：

> Model Tier。

---

# 88. Device Profiles

概念：

```text
Profile A
High Performance
→ Medium Local

Profile B
Standard
→ Small Local

Profile C
Low Memory
→ Smallest Local / Cloud
```

---

# 89. App Size Strategy

模型本身可能是 App 最大的檔案之一。

因此：

> 不一定把所有模型直接打包進 App。

可以：

```text
App Download
↓
Core App
↓
Optional AI Model Download
```

---

# 90. Model Download UX

第一次進入 AI 訓練時：

> 「需要下載 AI 模型約 XX MB。」

顯示：

- 模型大小
- 預估用途
- 是否需要 Wi-Fi
- 是否可以稍後下載

實際大小必須由最終模型檔案決定，不得硬編碼。

---

# 91. User Control

使用者應能選：

```text
Local AI
Smart AI
Auto
```

預設：

> Auto。

---

# 92. Auto Mode

Auto Mode：

```text
檢查裝置
↓
檢查網路
↓
檢查電量
↓
檢查任務
↓
選模型
```

使用者不需要理解模型名稱。

---

# 93. Expert Mode

未來可提供：

```text
Model
Quantization
Context
Cloud
Temperature
```

給進階使用者。

一般使用者不需要看到。

---

# 94. Context Memory Strategy

Local Small Model 特別需要：

> 外部記憶。

因此使用：

```text
Conversation
↓
Structured Summary
↓
State
↓
Recent Turns
```

而不是一直增加 Context。

---

# 95. Summary Memory

例如：

```text
Customer:
45歲男性
科技業主管
已婚
對保險沒有高度興趣
目前工作忙碌
已表示沒有太多時間

Current Objective:
約訪

Current Objection:
沒時間

Trust:
48
```

這種資料比塞入數千字聊天紀錄更適合小模型。

---

# 96. Context Compression Trigger

當：

```text
Token Count
>
Context Threshold
```

觸發：

```text
Summarize
↓
Extract State
↓
Remove Old Turns
```

---

# 97. Knowledge Context Compression

教材資料也應：

> 先 Retrieval，再 Context。

不要：

> 整份 100 頁簡報全部塞給 2B Model。

---

# 98. Product Coach Architecture

未來商品行銷演練：

```text
Product File
↓
Parser
↓
Knowledge Base
↓
Retriever
↓
Product Facts
↓
Scenario Engine
↓
Customer Persona
↓
Local LLM
↓
Voice
```

---

# 99. Model Responsibility in Product Roleplay

Local LLM 主要負責：

> 客戶自然回應。

Product Facts 則由：

> Knowledge Engine

提供。

因此 AI 不應自由創造商品資訊。

---

# 100. Model Responsibility in Feedback

Feedback 可使用：

```text
Transcript
+
Scenario Objective
+
Product Facts
+
Evaluation Rules
```

再交給：

> Judge Model。

---

# 101. Local-Only Product Training

如果教材與 RAG 全部本地化：

可以實現：

> 完全離線商品訓練。

這是本產品重要差異化能力。

---

# 102. Future On-device RAG

未來可使用：

```text
Local Embedding Model
+
Local Vector DB
+
Local LLM
```

實現：

> 完全本地商品知識問答與演練。

---

# 103. Embedding Model

Embedding 模型不一定與 LLM 相同。

應獨立選擇：

> Small Multilingual Embedding Model

要求：

- 中文
- 繁體中文
- 商品術語
- 低 RAM
- 快速

---

# 104. Reranker

如果商品資料量增加：

可加入：

> Local Reranker

流程：

```text
Vector Search
↓
Reranker
↓
Top-K
↓
LLM
```

V1 可先不加入。

---

# 105. AI Model Architecture Summary

本產品推薦：

```text
Small Local LLM
+
Optional Medium Local LLM
+
Optional Cloud LLM
+
Local/Cloud STT
+
Local/Cloud TTS
+
Local/Cloud Embedding
+
Rule Engine
+
Knowledge Engine
```

---

# 106. 核心設計結論

本專案不應追求：

> 「手機裡塞一個最強 AI。」

而應追求：

> **「用最小的模型，搭配最好的 Engine，做出最好的業務訓練體驗。」**

---

# 107. V1 Implementation Priority

實作優先順序：

## P0

```text
Model Gateway
Local Small LLM
Basic Streaming
State Machine
Roleplay
```

## P1

```text
STT
TTS
Voice Roleplay
Evaluation
Feedback
```

## P2

```text
Cloud Fallback
RAG
Product Training
```

## P3

```text
Medium Local Model
Device Adaptive Routing
Advanced Audio Evaluation
```

---

# 108. 不應過早開發

V1 暫時不要投入大量時間：

```text
大型模型微調
自建大型模型
複雜 Multi-Agent
RLHF
大型向量資料庫
高度複雜 Agent Framework
```

先驗證：

> **手機上的 AI 角色扮演是否真的好用。**

---

# 109. 第一個技術驗證 PoC

在正式開發 App 前：

建立一個最小 PoC：

```text
iPhone 14 Pro
+
Candidate Small LLM
+
STT
+
TTS
+
簡單 Persona
+
10 回合角色扮演
```

測試：

1. 是否能跑
2. 是否順
3. 是否會熱
4. 是否耗電
5. 是否自然
6. 是否維持角色
7. 是否能用中文
8. 是否適合語音對談

---

# 110. PoC Pass Criteria

模型只有在：

```text
Performance
+
Quality
+
Stability
+
Voice Experience
```

均達標時，才進入正式 App。

---

# 111. Model Benchmark Report

每個模型應產生：

```text
Model Name
Version
Quantization
Runtime
Load Time
First Token Latency
Tokens/sec
Peak RAM
Average RAM
Temperature
Battery Impact
Roleplay Score
Chinese Score
Instruction Score
Feedback Score
```

---

# 112. Final Architecture

最終推薦架構：

```text
┌──────────────────────────────────────────┐
│              AI業務教練 App               │
│                                          │
│  UI / Voice / Session / Training History │
└────────────────────┬─────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────┐
│             AI Orchestrator              │
│                                          │
│ Intent / State / Routing / Validation    │
└───────────────┬───────────────┬──────────┘
                │               │
                ▼               ▼
       ┌────────────────┐  ┌──────────────┐
       │ Coach Engine   │  │ Compliance   │
       │ Persona        │  │ Rule Engine  │
       │ Scenario       │  └──────────────┘
       │ Roleplay       │
       │ Evaluation     │
       └───────┬────────┘
               │
               ▼
       ┌────────────────┐
       │ Model Gateway  │
       └───────┬────────┘
          ┌────┴────┐
          ▼         ▼
      Local LLM   Cloud LLM
       1B～4B       Optional
          │
          ▼
       Voice AI
      ┌────┴────┐
      ▼         ▼
     STT       TTS

Knowledge Engine
      │
      ▼
Product RAG
```

---

# 113. Architecture Principle

整個架構最重要的一句話：

> **讓小模型負責「即時」，讓規則負責「可靠」，讓知識庫負責「正確」，讓大模型負責「複雜」。**

---

# 114. Agent 工作規則

任何 Work / Codex Agent 在實作本文件時：

## 必須

- 使用 Model Gateway
- 保持模型可替換
- 將 Local / Cloud 分離
- 建立 Benchmark
- 建立模型版本控制
- 支援 Streaming
- 考慮 iPhone 14 Pro
- 不把模型能力當成產品邏輯
- 不把商品知識硬編碼進 Prompt
- 不把合規判斷完全交給 LLM

## 不得

- 未 Benchmark 就指定模型
- 為了 Demo 而選擇過大的模型
- 將 4B 模型視為所有手機預設
- 假設 Context 越大越好
- 把完整教材直接塞入 Context
- 讓 LLM 單獨控制 State Machine
- 將所有對話預設上傳 Cloud
- 把 API Key 放在 App Client
- 將模型權重與核心 IP 無保護地暴露

---

# 115. Acceptance Criteria

V1 Model Architecture 必須：

```text
□ 支援 Local LLM
□ 支援 Model Gateway
□ 支援模型替換
□ 支援 Streaming
□ 支援 Voice Pipeline
□ 支援 Cloud Optional
□ 支援 Offline
□ 支援 Context Management
□ 支援 Device-Adaptive Routing
□ 支援 Model Versioning
□ 支援 Benchmark
□ 支援 Rollback
□ 支援 RAG Interface
□ 支援 Compliance Interface
```

---

# 116. Definition of Done

本文件不以：

> 「模型已經可以回答問題」

作為完成。

必須完成：

```text
□ Candidate Models Defined
□ Runtime Strategy Defined
□ Model Gateway Defined
□ Routing Defined
□ Local / Cloud Strategy Defined
□ Voice Integration Defined
□ Context Strategy Defined
□ Benchmark Defined
□ Versioning Defined
□ Rollback Defined
□ Device Strategy Defined
□ Security Strategy Defined
□ PoC Criteria Defined
```

---

# 117. 最終產品哲學

AI業務教練的模型架構，不追求：

> 最大。

而追求：

> **剛剛好。**

剛剛好的模型：

- 跑得動
- 跑得快
- 不容易熱
- 不過度耗電
- 能自然說中文
- 能維持角色
- 能完成基本教練任務

再搭配：

> Engine + RAG + Rules + Voice + Optional Cloud

才能讓手機上的 AI業務教練真正成為一個：

> **可長期使用、可商業化、可持續升級的產品。**

---

# 118. 文件狀態

本文件為 `03_AI_MODEL_ARCHITECTURE.md` V1.0。

後續模型選型不得只依據公開 Benchmark。

正式決策必須建立於：

> **iPhone 14 Pro 實機 Benchmark + AI業務教練專屬測試集。**

模型選型結果應記錄於獨立的：

`MODEL_BENCHMARK_REPORT.md`

不得直接修改本文件中的架構原則以配合某一個模型。

---

**End of `03_AI_MODEL_ARCHITECTURE.md`**

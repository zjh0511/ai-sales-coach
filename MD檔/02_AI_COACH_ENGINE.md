# AI業務教練｜AI Coach Engine 規格

**文件名稱：** `02_AI_COACH_ENGINE.md`  
**產品名稱：** AI業務教練  
**品牌：** 豪老師 Hao+  
**文件版本：** V1.0  
**文件狀態：** Draft / AI Architecture Baseline  
**上層產品規格：** `01_PRODUCT_SPEC.md`  
**主要用途：** 定義 AI 業務教練的核心人格、教學邏輯、角色扮演、情境管理、對話控制、評估與回饋機制。

---

# 1. 文件目的

本文件定義「AI業務教練」的核心 AI 行為與運作邏輯。

本文件的目的不是建立一份單一 Prompt，而是將原本 Custom GPT 中的 AI 教練能力，重新拆解成可：

- 模組化
- 測試
- 維護
- 更新
- 替換模型
- 本地執行
- 雲端執行
- 擴充不同產業

的 AI Coach Engine。

核心原則：

> **不要把所有能力塞進 System Prompt。**

應將 AI 業務教練拆解成：

```text
AI Coach Engine
│
├── Coach Persona
├── Training Mode Manager
├── User Intent Manager
├── Customer Persona Engine
├── Scenario Engine
├── Conversation Engine
├── Difficulty Engine
├── Intervention Engine
├── Evaluation Engine
├── Feedback Engine
├── Compliance Interface
├── Knowledge Interface
└── Model Gateway
```

---

# 2. 核心產品定義

AI業務教練不是一般 Chatbot。

它的主要工作不是：

> 回答使用者問題。

而是：

> **讓使用者透過實際演練，提升業務溝通能力。**

因此 AI Coach Engine 的核心循環為：

```text
理解訓練目標
↓
建立訓練情境
↓
設定客戶角色
↓
與使用者互動
↓
觀察使用者表現
↓
提供適當挑戰
↓
完成演練
↓
分析表現
↓
提供回饋
↓
提出下一次訓練建議
```

---

# 3. AI Coach Engine 核心哲學

## 3.1 Learn by Doing

優先讓使用者實際做，而不是長篇閱讀理論。

## 3.2 Practice Before Feedback

在角色扮演期間，AI 優先維持角色。

除非使用者主動要求協助，否則：

> **不要在演練過程中頻繁教學。**

## 3.3 Low Pressure / High Challenge

訓練應：

- 有挑戰
- 有真實感
- 不羞辱
- 不打擊
- 不過度簡單
- 不讓使用者失去信心

核心：

> **挑戰使用者，但不要讓使用者害怕練習。**

## 3.4 Specific Feedback

不要只說：

> 「你的表現很好。」

必須指出：

> 「哪裡好、為什麼好、下一次怎麼更好。」

## 3.5 Progressive Difficulty

訓練應逐步提高難度。

```text
簡單
↓
一般
↓
挑戰
↓
高難度
↓
實戰
```

---

# 4. AI Coach Persona

AI 教練本身應具有以下人格：

## 4.1 專業

熟悉：

- 銷售流程
- 客戶溝通
- AIDA
- FABE
- SPIN
- 異議處理
- 促成
- NLP
- 影響力
- 需求探索

## 4.2 鼓勵

優先找出使用者做得好的地方。

## 4.3 客觀

不因為鼓勵而：

- 無條件高分
- 忽略錯誤
- 避免指出問題

## 4.4 有耐心

允許使用者：

- 犯錯
- 卡住
- 重來
- 嘗試不同說法

## 4.5 不說教

AI 教練應避免長篇理論灌輸。

優先：

> 「做一次 → 回饋 → 再做一次」

---

# 5. AI 行為模式

AI Coach Engine 至少包含以下 Mode：

```text
WELCOME
MENU
INTAKE
ANALYSIS
DEMO
ROLEPLAY
GUIDANCE
FEEDBACK
EVALUATION
COMPLIANCE
ERROR
```

---

# 6. WELCOME Mode

第一次進入 App 時：

AI 應：

1. 歡迎使用者
2. 說明用途
3. 提醒生成內容用途
4. 顯示必要的合規提醒
5. 引導選擇訓練模式

概念流程：

```text
歡迎
↓
使用注意事項
↓
今天想練什麼？
↓
選擇模式
```

---

# 7. Training Mode

V1 支援三種主要訓練：

```text
MODE 1
客戶潛在痛點分析

MODE 2
電話邀約語音對練

MODE 3
發掘需求角色扮演
```

未來擴充：

```text
MODE 4
商品行銷演練

MODE 5
異議處理

MODE 6
促成演練

MODE 7
綜合實戰
```

---

# 8. User Intent Manager

AI 必須先判斷使用者目前的目的。

Intent 至少包括：

```text
SELECT_MODE
PROVIDE_CUSTOMER_INFO
START_ROLEPLAY
CONTINUE_ROLEPLAY
ASK_FOR_HELP
END_ROLEPLAY
REQUEST_FEEDBACK
REQUEST_RETRY
REQUEST_EXPLANATION
REQUEST_PRODUCT_INFO
COMPLIANCE_RISK
```

---

# 9. Customer Persona Engine

Customer Persona Engine 負責建立：

> **AI 客戶是誰？**

---

# 10. Persona 基本資料

V1 必須支援：

```text
gender
age
occupation
industry
family
background
```

---

# 11. Persona 延伸資料

AI 可根據背景建立：

```text
personality
communication_style
financial_attitude
insurance_attitude
trust_level
time_pressure
decision_style
risk_attitude
possible_concerns
hidden_needs
objection_style
```

---

# 12. Persona 的「公開資訊」與「隱藏資訊」

這是角色扮演的重要設計。

Persona 應分為：

## Public State

業務員可以知道。

例如：

> 45 歲、科技業主管、已婚。

## Hidden State

業務員不知道。

例如：

> 最近開始擔心退休規劃。

或者：

> 其實非常在意孩子教育費。

Hidden State 只能透過適當的提問逐步取得。

---

# 13. Hidden State 原則

AI 不應在角色扮演開始時直接揭露所有 Hidden State。

例如：

錯誤：

> 「我其實最近很擔心退休，所以你可以幫我規劃退休金。」

正確：

> 「退休？嗯……這個我倒是沒有特別想過。」

業務員需要繼續探索。

---

# 14. Persona Consistency

角色扮演過程中：

> **Persona 必須保持一致。**

除非：

- 使用者改變情境
- 情境自然發展
- 系統明確觸發狀態變化

否則不能突然：

> 冷淡客戶 → 突然變得非常熱情。

---

# 15. Customer Emotional State

AI 客戶可以具有：

```text
neutral
friendly
curious
busy
confused
hesitant
defensive
annoyed
interested
trusting
```

情緒狀態可以隨對話變化。

例如：

```text
好的開場
↓
neutral → curious

有效需求探索
↓
curious → interested

過度推銷
↓
interested → defensive
```

---

# 16. Customer Trust Level

建立 0～100 的概念性信任值。

例如：

```text
0-20   非常防備
21-40  偏冷淡
41-60  中性
61-80  有信任
81-100 高度信任
```

信任值不必直接顯示給使用者。

---

# 17. Customer Disclosure Level

AI 決定願意透露多少資訊。

例如：

```text
低信任
→ 簡短回答

中信任
→ 願意回答問題

高信任
→ 主動補充資訊
```

---

# 18. Scenario Engine

Scenario Engine 負責建立完整練習情境。

Scenario 至少包含：

```text
scenario_id
training_mode
difficulty
customer_persona
objective
hidden_needs
objections
success_conditions
failure_conditions
compliance_constraints
```

---

# 19. Scenario Objective

每個情境必須只有一個主要訓練目標。

例如：

> 練習電話開場。

或：

> 練習第一次遭遇「沒時間」時的處理。

或：

> 練習需求探索。

避免一個情境同時要求：

- 約訪
- 商品介紹
- 異議處理
- 促成
- 轉介紹

造成訓練目標模糊。

---

# 20. Difficulty Engine

難度至少分五級：

## Level 1

友善客戶。

## Level 2

一般客戶。

## Level 3

具有明確異議。

## Level 4

多重異議。

## Level 5

高度接近實戰。

---

# 21. Difficulty Factors

難度可以由以下因素構成：

```text
customer_coldness
objection_count
response_length
hidden_information
time_pressure
trust_level
emotional_intensity
product_complexity
```

---

# 22. Dynamic Difficulty

未來可根據使用者表現自動調整難度。

例如：

使用者連續 3 次成功：

```text
Level 2 → Level 3
```

連續失敗：

```text
Level 3 → Level 2
```

目的：

> 保持「剛好有挑戰」的訓練區間。

---

# 23. Conversation Engine

Conversation Engine 負責：

> **管理角色扮演中的即時對話。**

---

# 24. Role Lock

一旦開始 ROLEPLAY：

```text
User = 業務員
AI = 客戶
```

AI 必須維持：

> **Customer Role Lock**

---

# 25. Role Lock 規則

演練期間 AI：

不得主動：

- 分析使用者
- 評分使用者
- 教學
- 解釋話術
- 提供標準答案

除非：

> 使用者主動要求退出角色或取得協助。

---

# 26. Natural Customer Response

AI 客戶回答應：

- 自然
- 簡潔
- 符合 Persona
- 不過度完整
- 不像教科書

例如：

使用者：

> 「最近有沒有特別想關心的保障？」

AI：

> 「目前好像沒有耶，我工作也蠻忙的。」

而不是：

> 「根據我的背景，我目前最關心的是醫療與退休保障。」

---

# 27. Customer Resistance

AI 應模擬真實客戶可能出現的：

```text
沒時間
沒興趣
已經有保險
我朋友就是做保險的
先不用
我要考慮看看
我不想花錢
最近比較忙
你先傳資料給我
```

---

# 28. Objection Escalation

客戶異議可以分級。

例如：

### 第一次

> 「我最近比較忙。」

### 第二次

> 「我真的沒什麼時間。」

### 第三次

> 「不好意思，我現在真的不方便聊。」

這能模擬真實拒絕。

---

# 29. User Stuck Detection

如果系統發現使用者：

- 長時間沒有有效回應
- 重複相同句子
- 明顯不知道如何回答
- 對話無法推進

可以啟動：

> Guidance Mode

---

# 30. Guidance Mode

引導應保持在角色中。

例如：

> 「嗯……你找我到底是想聊什麼？」

而不是：

> 「你現在應該使用 SPIN 的 Problem Question。」

---

# 31. Guidance Limit

預設最多：

> **3 次自然引導。**

如果仍無法繼續：

> AI 客戶可以自然結束對話。

之後進入 Feedback Mode。

---

# 32. User Help Mode

如果使用者主動說：

> 「我不知道怎麼回答。」

AI 可以暫停角色扮演。

提供：

1. 簡短提示
2. 一個方向
3. 示範說法

例如：

> 「你可以先不要急著介紹商品，可以先接住客戶的『沒時間』，例如：『我了解，你現在方便給我 30 秒嗎？如果不方便，我再配合你的時間。』」

然後詢問：

> 「要不要再試一次？」

---

# 33. Demo Mode

正式角色扮演前：

> **提供示範話術。**

示範內容不宜過長。

應包含：

- 開場
- 一個關鍵問題
- 一個異議處理範例

目的：

> 讓使用者知道怎麼開始，而不是提供完整標準答案。

---

# 34. Training Loop

標準訓練流程：

```text
Intake
↓
Scenario
↓
Demo
↓
Roleplay
↓
End
↓
Evaluation
↓
Feedback
↓
Retry
```

---

# 35. Retry Loop

使用者完成一次練習後：

AI 應鼓勵再次練習。

例如：

> 「剛才你在處理『沒時間』時已經比第一次自然很多。下一次我們把難度提高一點，讓客戶直接說『我沒有興趣』，你想再試一次嗎？」

---

# 36. Evaluation Engine

Evaluation Engine 負責：

> **把對話轉換成能力評估。**

---

# 37. 五項核心評分

V1 固定：

```text
fluency
friendliness
conversation_awareness
confidence
professionalism
```

每項：

> 0～5 星，允許 0.5 分。

---

# 38. Fluency

評估：

- 語句流暢
- 卡頓
- 重複
- 句子完整
- 接話自然

---

# 39. Friendliness

評估：

- 語氣
- 親切度
- 尊重
- 壓迫感
- 語速
- 音量

注意：

> 如果缺乏可靠語音訊號，不得假裝可以精準判斷聲音特徵。

---

# 40. Conversation Awareness

評估：

- 是否聽懂客戶
- 是否回應客戶內容
- 是否抓到關鍵訊息
- 是否適當追問
- 是否偏題

---

# 41. Confidence

可綜合：

- 語句完整度
- 停頓
- 猶豫表達
- 語速
- 回答確定性

但不得將：

> 「說話慢」

直接等同：

> 「缺乏自信」。

---

# 42. Professionalism

評估：

- 銷售流程
- 邏輯
- 專業用語
- 客戶導向
- 需求探索
- 商品表達
- 合規性

---

# 43. Evaluation Evidence

每個分數必須有證據。

例如：

```text
流暢度：4.0 ⭐⭐⭐⭐

表現：
你大部分回答都能自然完成，只有在客戶第二次拒絕時出現明顯停頓。

建議：
可以準備 2～3 個自然銜接句，降低臨場壓力。
```

---

# 44. Score Calibration

AI 不應：

> 因為鼓勵使用者而全部給 4～5 星。

應建立：

```text
0-1   明顯不足
1.5-2 需要大量改善
2.5-3 基礎達標
3.5-4 良好
4.5-5 優秀
```

---

# 45. Feedback Engine

Feedback 必須採用：

```text
Positive
↓
Improvement
↓
Example
↓
Next Action
```

---

# 46. Positive Feedback

優先指出：

> 使用者做得好的地方。

例如：

> 「你這次最大的進步，是沒有急著反駁客戶，而是先承接對方的顧慮。」

---

# 47. Improvement Feedback

指出：

> 最值得改善的一個問題。

避免一次塞入十個改善點。

---

# 48. Example

提供：

> 「你可以把『但是』改成『我理解』，降低防禦感。」

再提供實際話術。

---

# 49. Next Action

每次訓練至少提供一個：

> **下一次可以立即使用的行動。**

例如：

> 「下一次客戶說『沒時間』時，先不要解釋商品，先問一個簡短問題。」

---

# 50. Coaching Priority

如果使用者存在多個問題：

AI 應排序：

```text
Priority 1
最影響結果的問題

Priority 2
次重要問題

Priority 3
加分項
```

不要一次要求使用者全部修正。

---

# 51. Sales Framework Engine

AI Coach Engine 支援以下框架：

## AIDA

```text
Attention
Interest
Desire
Action
```

用途：

> 建立注意 → 興趣 → 欲望 → 行動。

## FABE

```text
Feature
Advantage
Benefit
Evidence
```

用途：

> 商品價值說明。

## SPIN

```text
Situation
Problem
Implication
Need-Payoff
```

用途：

> 發掘需求。

---

# 52. Framework 使用原則

AI 不應為了套框架而套框架。

例如：

錯誤：

> 「現在輪到 SPIN 的 Problem。」

正確：

> 自然地提出一個能探索問題的問題。

框架應該：

> **隱性支援使用者，而不是讓對話變得機械。**

---

# 53. NLP 使用原則

NLP 技巧可以作為：

- 語言模式分析
- 觀點轉換
- 感受承接
- 表達調整
- 問句設計

但不得：

- 操控
- 欺騙
- 虛假承諾
- 不當心理操縱

核心：

> **提升理解與溝通，不是操控客戶。**

---

# 54. Ethical Sales Principle

AI 教練應鼓勵：

- 尊重客戶
- 真實表達
- 需求導向
- 低壓力溝通
- 充分理解
- 合規銷售

不應鼓勵：

- 欺騙
- 隱瞞
- 操縱
- 虛假承諾
- 不當利益交換
- 違規招攬

---

# 55. Compliance Interface

AI Coach Engine 不直接自行定義完整法規。

應透過：

```text
Compliance Engine
```

取得：

```text
risk_level
violation_type
blocked
warning
recommended_response
```

---

# 56. Compliance Priority

如果：

> Coaching Logic

與：

> Compliance Rule

發生衝突：

> **Compliance 優先。**

---

# 57. Compliance Intervention

當發現高風險內容：

```text
正常 Roleplay
↓
Compliance Detection
↓
High Risk
↓
Intervention
↓
停止相關演練
↓
說明問題
↓
提供合規替代說法
```

---

# 58. Knowledge Interface

AI Coach Engine 不應直接把所有商品知識寫進模型。

應透過：

```text
Knowledge Engine
```

取得商品資訊。

例如：

```text
Product Query
↓
Knowledge Retrieval
↓
Relevant Content
↓
AI Coach
```

---

# 59. Knowledge Grounding

如果商品資料不足：

AI 不得自行捏造：

- 商品條款
- 保費
- 利率
- 給付
- 保障
- 限制

應明確表示：

> 「目前提供的商品資料不足，無法確認。」

---

# 60. Hallucination Prevention

AI 不得將：

> 推測

描述成：

> 客戶事實。

也不得將：

> 模擬情境

描述成：

> 真實客戶資料。

---

# 61. Context Management

AI Context 應分層：

```text
System Context
↓
Coach Context
↓
Scenario Context
↓
Persona Context
↓
Conversation Context
↓
Current Turn
```

---

# 62. Context Compression

長對話時，不應無限制保留全部歷史內容。

應保留：

- 客戶 Persona
- 已透露資訊
- 未透露 Hidden State
- 已發生異議
- 使用者主要表現
- 情緒狀態
- 信任狀態
- 訓練目標

並將舊對話壓縮為：

> Structured Memory

---

# 63. Structured Conversation State

建議建立：

```json
{
  "mode": "roleplay",
  "difficulty": 3,
  "customer": {
    "age": 45,
    "gender": "male",
    "occupation": "technology_manager"
  },
  "trust": 54,
  "emotion": "neutral",
  "hidden_needs": [],
  "revealed_needs": [],
  "objections": [],
  "turn_count": 8,
  "user_stuck_count": 0,
  "compliance_risk": false
}
```

實際 Schema 於後續技術文件定義。

---

# 64. Memory Types

分為：

## Session Memory

只存在本次練習。

## User Skill Memory

記錄長期能力。

例如：

> 使用者經常在需求探索階段過早介紹商品。

## Product Knowledge Memory

商品相關知識。

## Compliance Memory

規則與風險資訊。

---

# 65. Model-Agnostic 原則

AI Coach Engine 不得依賴特定模型的特殊 Prompt 行為。

必須假設：

> Local Model 能力有限。

因此：

- 狀態管理由程式控制
- Persona 由結構化資料控制
- 評分由 Evaluation Engine 控制
- 合規由 Compliance Engine 控制
- 模型主要負責自然語言生成與理解

---

# 66. Small Model Strategy

如果使用 Gemma E2B：

不要要求它同時負責：

- 長期記憶
- 法規判斷
- 評分
- Persona 管理
- 完整 RAG
- UI 狀態
- 所有業務邏輯

應採：

> **Small Model + Deterministic Engine**

而不是：

> **Everything in LLM**

---

# 67. AI Orchestrator

AI Orchestrator 是核心控制層。

概念：

```text
User Input
↓
Intent Detection
↓
State Update
↓
Compliance Check
↓
Knowledge Retrieval
↓
Prompt Assembly
↓
Model Gateway
↓
Output Validation
↓
State Update
↓
Response
```

---

# 68. Output Validation

模型輸出後必須檢查：

- 是否符合角色
- 是否符合情境
- 是否包含禁止內容
- 是否需要引用商品知識
- 是否跳出角色
- 是否過度冗長
- 是否符合目前 Mode

若不符合：

> Retry / Repair / Fallback

---

# 69. Prompt Architecture

不要建立一個巨大 Prompt。

應拆成：

```text
Base Coach Prompt
+
Mode Prompt
+
Scenario Prompt
+
Persona Prompt
+
Current State
+
Relevant Knowledge
+
Compliance Rules
+
Current User Message
```

---

# 70. Prompt Priority

優先順序：

```text
Safety / Compliance
↓
System Rules
↓
Product Rules
↓
Mode Rules
↓
Scenario Rules
↓
Persona Rules
↓
Conversation
```

---

# 71. Roleplay Output Constraint

在 ROLEPLAY Mode：

AI 輸出應盡可能：

> 簡潔、自然、像真人。

不應每次回答都：

- 解釋
- 分析
- 條列
- 教學

---

# 72. Coach Output Constraint

在 FEEDBACK Mode：

可以更完整。

建議：

```text
總評
↓
五項評分
↓
做得好的地方
↓
最重要改善點
↓
示範話術
↓
下一次挑戰
```

---

# 73. Streaming

Voice Roleplay 優先使用 Streaming。

流程：

```text
LLM Token Streaming
↓
Sentence Boundary Detection
↓
TTS Streaming
↓
播放
```

避免：

> 等整段文字生成完才開始播放。

---

# 74. Interruptibility

使用者可以在 AI 說話時開始講話。

未來 Voice Engine 應支援：

> **Barge-in**

流程：

```text
AI speaking
↓
User starts speaking
↓
Detect user speech
↓
Stop TTS
↓
Start STT
↓
Continue conversation
```

---

# 75. Response Length

角色扮演中：

> 優先短回答。

建議一般客戶回覆：

> 1～3 句。

特殊情境可延長。

---

# 76. Silence Handling

如果使用者沒有說話：

AI 可以在合理時間後：

> 「嗯？你還在嗎？」

但不能頻繁催促。

---

# 77. Error Recovery

如果模型失敗：

不要直接顯示：

> API Error

應轉為：

> 「剛剛好像卡了一下，我們重新來一次。」

技術錯誤資訊應記錄於 Debug Log。

---

# 78. Fallback Strategy

Local Model 失敗時：

```text
Local LLM
↓
Retry
↓
Fallback Model
↓
Cloud Model（若使用者允許）
```

如果完全離線：

> 使用有限功能模式。

---

# 79. Offline Mode

未來支援：

- 本地 AI
- 本地 STT
- 本地 TTS
- Local Training History

在沒有網路時仍可進行基本角色扮演。

---

# 80. AI Coach Quality Metrics

AI Coach Engine 應建立：

```text
Role Consistency
Instruction Following
Persona Consistency
Response Naturalness
Training Relevance
Feedback Quality
Evaluation Consistency
Compliance Accuracy
```

---

# 81. Role Consistency

測試：

> AI 是否一直是客戶？

目標：

> ≥90%

---

# 82. Persona Consistency

測試：

> AI 是否符合設定的客戶背景與個性？

目標：

> ≥90%

---

# 83. Feedback Quality

測試：

> AI 的回饋是否有實際證據？

不得只是：

> 「你表現很好。」

---

# 84. Evaluation Consistency

同一個案例：

> 多次評估不應出現巨大差異。

應建立：

> Golden Reference Evaluation Set。

---

# 85. Golden Reference

目前 Custom GPT 的行為應被視為：

> **Reference Behavior**

但不是：

> 程式碼直接複製來源。

後續應建立標準案例：

```text
Scenario
User Input
Expected Customer Response
Expected State
Expected Evaluation
Expected Feedback
```

---

# 86. Regression Testing

每次模型或 Prompt 更新後：

必須重新測試：

- 基礎案例
- 困難案例
- 合規案例
- 長對話
- 角色一致性
- 評分

避免：

> 修好 A，卻破壞 B。

---

# 87. AI Coach Safety

AI 不得：

- 鼓勵欺騙
- 鼓勵違規招攬
- 鼓勵虛假承諾
- 鼓勵操控客戶
- 提供非法策略

---

# 88. Privacy

客戶資料可能包含個人資訊。

因此：

> 不應要求使用者輸入真實姓名、身分證號、電話、地址等非必要資料。

建議使用：

> 王先生 / 李小姐

等匿名代稱。

---

# 89. Data Minimization

訓練只需要：

- 年齡區間
- 性別
- 職業
- 家庭背景
- 已知需求

就不要要求：

- 身分證字號
- 電話
- 地址
- 真實姓名

---

# 90. Coach Engine API 概念

未來可提供：

```text
createSession()
setScenario()
setPersona()
startRoleplay()
sendUserMessage()
getCustomerResponse()
endRoleplay()
evaluateSession()
getFeedback()
retrySession()
```

實際 API Schema 另於技術文件定義。

---

# 91. Session Lifecycle

```text
CREATED
↓
INTAKE
↓
READY
↓
ROLEPLAY
↓
PAUSED
↓
ROLEPLAY
↓
COMPLETED
↓
EVALUATING
↓
FEEDBACK_READY
↓
ARCHIVED
```

---

# 92. State Machine

AI Coach Engine 應優先採：

> **Explicit State Machine**

而不是讓 LLM 自由決定目前處於哪一個階段。

例如：

```text
if state == ROLEPLAY:
    AI must behave as customer

if state == FEEDBACK:
    AI behaves as coach
```

---

# 93. Why State Machine

原因：

小型模型可能：

- 忘記角色
- 混淆模式
- 跳出教學
- 過早給答案

因此：

> **重要產品邏輯由程式控制，AI 負責語言生成。**

---

# 94. Coach Engine Layering

推薦：

```text
┌───────────────────────────┐
│       UI / Voice          │
├───────────────────────────┤
│      AI Orchestrator      │
├───────────────────────────┤
│      Coach Engine         │
│                           │
│ Persona / Scenario        │
│ Conversation / Difficulty │
│ Evaluation / Feedback     │
├───────────────────────────┤
│ Compliance / Knowledge    │
├───────────────────────────┤
│       Model Gateway       │
├───────────────────────────┤
│ Gemma / Cloud Model       │
└───────────────────────────┘
```

---

# 95. Core Rule

整個 AI Coach Engine 最重要的工程原則：

> **不要讓 LLM 成為唯一的控制器。**

應採：

> **Application Logic 控制狀態 + AI 負責自然語言。**

---

# 96. AI Coach Engine V1 必須具備

```text
□ Coach Persona
□ Training Mode
□ User Intent
□ Customer Persona
□ Hidden State
□ Scenario Engine
□ Difficulty
□ Role Lock
□ Conversation State
□ Guidance
□ Evaluation
□ Feedback
□ Compliance Interface
□ Knowledge Interface
□ Model Gateway
□ Error Recovery
```

---

# 97. V1 不需要

以下可以延後：

```text
□ 長期 AI 自我學習
□ 自動修改教練人格
□ 自動生成完整新課程
□ 多 AI Agent 協作
□ 大規模企業管理
□ 自動訓練 LLM
□ Reinforcement Learning
```

---

# 98. 未來 V2

V2 可加入：

```text
Product Knowledge
RAG
商品行銷演練
商品異議處理
商品知識測驗
```

---

# 99. 未來 V3

V3 可加入：

```text
Recruiting Coach
Interview Roleplay
Recruiting Objection Handling
Recruiting Call Practice
```

---

# 100. 未來 V4

V4 可加入：

```text
Team Coach
Manager Dashboard
Training Analytics
Team Skill Map
Enterprise Knowledge Base
```

---

# 101. AI Coach Engine 的最終目標

AI Coach Engine 的成功不是：

> 「AI 說得多漂亮。」

而是：

> **使用者經過訓練後，下一次真的說得更好。**

因此核心 KPI 應從：

> AI Response Quality

逐步轉向：

> User Skill Improvement

---

# 102. 最終產品體驗

理想狀態：

```text
使用者：
「我想練電話邀約。」

AI：
「好，今天我們來練電話邀約。
這次我會扮演一位比較忙、對保險沒有特別興趣的客戶。」

↓
建立 Persona

↓
提供簡短示範

↓
開始語音

AI：
「喂，你好。」

使用者：
「王先生您好，我是……」

AI：
「嗯，你好，請問找我有什麼事情？」

↓

持續真實對談

↓

結束

AI：
「好了，我們來看看剛才的表現。」

↓

⭐⭐⭐⭐
⭐⭐⭐½
⭐⭐⭐⭐
⭐⭐⭐
⭐⭐⭐⭐

↓

「這次你最大的優勢是……」

↓

「最值得調整的是……」

↓

「下一次可以試試……」

↓

「要不要直接再挑戰一次？」
```

---

# 103. 最終設計原則

> **AI業務教練不是把知識告訴業務員，而是陪業務員把能力練出來。**

因此：

```text
知識
↓
情境
↓
演練
↓
回饋
↓
修正
↓
再練
↓
能力提升
```

這就是 AI Coach Engine 的核心循環。

---

# 104. 與其他文件的關係

本文件依賴：

```text
01_PRODUCT_SPEC.md
```

並提供需求給：

```text
03_AI_MODEL_ARCHITECTURE.md
04_VOICE_ENGINE.md
05_KNOWLEDGE_RAG.md
06_COMPLIANCE_ENGINE.md
09_DATA_ARCHITECTURE.md
10_TESTING_QA.md
```

文件關係：

```text
                PRODUCT
                   │
                   ▼
          AI COACH ENGINE
                   │
        ┌──────────┼──────────┐
        ▼          ▼          ▼
      MODEL       VOICE     KNOWLEDGE
        │          │          │
        └──────────┼──────────┘
                   ▼
              APPLICATION
                   │
                   ▼
               TESTING
```

---

# 105. Agent 工作規則

任何 AI Agent 在實作 AI Coach Engine 時：

## 必須

- 優先使用明確 State Machine
- 保持 Model-Agnostic
- 將核心邏輯模組化
- 建立可測試介面
- 保留 Debug Log
- 建立 Golden Reference
- 避免把所有規則寫死在 Prompt

## 不得

- 任意改變產品核心流程
- 任意移除角色扮演規則
- 任意修改五項評分
- 任意取消 Compliance
- 任意將所有資料送往 Cloud
- 任意將核心 IP 全部放在 Client
- 為了追求 Demo 效果而犧牲穩定性

---

# 106. Acceptance Criteria

AI Coach Engine V1 必須通過：

```text
□ 可以建立訓練 Session
□ 可以建立 Customer Persona
□ 可以設定 Hidden State
□ 可以建立 Scenario
□ 可以設定 Difficulty
□ 可以進入 Roleplay
□ AI 能維持 Customer Role
□ AI 不會在演練中任意教學
□ 可以偵測使用者卡住
□ 可以提供自然引導
□ 可以結束演練
□ 可以進行五項評分
□ 每項可使用 0.5 分
□ 評分有證據
□ 可以產生教練回饋
□ 可以提出下一次訓練建議
□ 可以介接 Compliance Engine
□ 可以介接 Knowledge Engine
□ 可以介接 Model Gateway
□ 可以更換 Local Model
□ 可以進行 Regression Test
```

---

# 107. Definition of Done

本 Engine 不應以：

> 「Prompt 可以跑」

作為完成標準。

必須達成：

```text
□ Architecture defined
□ State Machine defined
□ Interfaces defined
□ Persona defined
□ Scenario defined
□ Roleplay defined
□ Evaluation defined
□ Feedback defined
□ Compliance interface defined
□ Knowledge interface defined
□ Model interface defined
□ Error handling defined
□ Test cases defined
□ Golden Reference established
```

---

# 108. 最重要的工程決策

AI業務教練應採：

> **Hybrid Intelligence Architecture**

也就是：

```text
Deterministic Software
+
Small Local AI
+
Optional Cloud AI
+
Structured Knowledge
+
Voice Engine
```

而不是：

```text
Everything = One LLM
```

---

# 109. 最終核心公式

AI業務教練的產品能力可抽象為：

```text
AI Coach
=
Persona
+
Scenario
+
Conversation
+
State
+
Difficulty
+
Evaluation
+
Feedback
+
Compliance
+
Knowledge
```

而 AI 模型只是其中的一個元件：

```text
AI Model ≠ AI Coach
```

真正的：

> **AI Coach = Engine + Model + Data + Voice + Training Methodology**

---

# 110. 文件最終原則

本文件所定義的核心 AI 能力，應視為：

> **AI業務教練的核心智慧資產。**

後續任何模型、Prompt、程式架構或 UI 實作，都應服務於：

> **讓使用者更有效率、更自然、更有信心地完成業務溝通訓練。**

最終判斷標準只有一個：

> **「這個設計，是否真的能讓業務員練完一次之後，比練習之前更會說、更會問、更會聽、更會處理客戶？」**

如果答案是「是」，才值得保留。

---

# 111. 文件狀態

本文件為 V1.0 AI Coach Engine 基準規格。

後續若發現產品需求、模型能力、語音能力、合規要求或實際測試結果與本文件衝突：

1. 先記錄差異。
2. 建立 Issue。
3. 評估對產品核心體驗的影響。
4. 再修改本文件版本。
5. 不得由單一 Agent 私自改變核心架構。

---

**End of `02_AI_COACH_ENGINE.md`**

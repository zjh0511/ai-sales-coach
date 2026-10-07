// 本機模型清單 —— 尺寸與量化選項寫在資料裡，不寫進邏輯。
//
// 為什麼要有這一份：
//   handbook §9.1 第 5 條「模型 ID 不要寫死」。雲端版的做法是登入時查詢可用清單，
//   本機版沒有「查詢」這回事，所以改成集中宣告 + 實測數字，換模型只改這一個檔案。
//
// 數字全部是 2026-08-18 由 HuggingFace API 實際查到的檔案大小，不是估算。
// 這很重要：規劃階段我們假設 0.8B q4 約 550 MB，實際是 585～717 MB，
// 差距來自 Qwen3.5 的 248,320 詞彙表（201 種語言）讓 embed_tokens 單獨就 147 MB。

// ── 量化選項的取捨 ──────────────────────────────────────────────
//
//   q4f16   最小，但需要 GPU 支援 shader-f16（Apple 與 NVIDIA 都支援）
//   q4      相容性最好，大約多 60 MB
//   quantized（int8）品質較好但 1.2 GB，手機不可能
//   fp16    2.2 GB，只有桌面談得上
//
// 預設一律 q4f16，偵測不到 f16 才退 q4。

// ── 為什麼每個 GGUF repo 都要鎖 commit（rev）──────────────────────
//
// 模型檔不是我們上傳的，是直接抓第三方的公開 repo（unsloth／bartowski／openbmb）。
// 這樣不必自己託管 2 GB 的檔案，但把三個風險交到了別人手上：
//
//   ① 上游改名或刪檔 → 所有新使用者的第一次下載直接失敗。
//      社群 repo 重新量化、改檔名（例如加上 UD- 前綴）是常態，不是意外。
//   ② 上游replace 檔案內容 → 使用者拿到的權重跟我們驗證過的不是同一份。
//   ③ 檔案大小改變 → 我們的大小驗證會失敗，對使用者顯示成「下載不完整」。
//
// `resolve/main` 會跟著分支移動，所以以上三件事隨時可能發生。
// **綁定 commit SHA 之後那個 URL 就是不可變的**——HF 上某個 commit 的內容不會改。
// 三個風險一次解決，而且不需要在瀏覽器裡算 2 GB 檔案的雜湊
// （WebCrypto 沒有串流 API，那會要求整份放進記憶體）。
//
// rev 是 2026-08-21 查到的最新 commit，而 sizes 裡的數字就是在這些版本上量的。
// 要升級上游版本時：更新 rev、重新量 sizes、重新跑一次實機驗證。
// 沒有 rev 的項目會退回 'main'（量測用的模型不必鎖）。

export const MODELS = {
  // Gemma 4 E2B —— 使用者在同一台 iPad Pro M5 上用原生 App（Locally）跑得很順。
  //
  // 那是有用的證據，但要分清楚：**原生 App 走 Metal／MLX，不受 WebKit 限制**，
  // 所以「原生順」不等於「瀏覽器可行」。它證明的是這台硬體的記憶體與算力夠，
  // 而我們要測的是瀏覽器那一層還剩多少。
  //
  // 架構支援已確認（grep wllama 的 wasm）：gemma4／gemma3n／altup／laurel／per_layer 都在。
  //
  // 注意 E2B 是「等效 2B」——原始權重約 5B，所以檔案比一般 2B 大得多：
  // 最小的 IQ2_M 就 2,291 MB。不需要 mmproj（視覺），省下 986 MB。
  'gemma4-e2b': {
    id: 'unsloth/gemma-4-E2B-it-GGUF',
    label: 'Gemma 4 E2B',
    params: 'E2B（原始約 5B）',
    engine: 'wllama',
    kind: 'gguf',
    note: '使用者在原生 App 上驗證過的模型；瀏覽器可行性待測',
    gguf: {
      repo: 'unsloth/gemma-4-E2B-it-GGUF',
      files: {
        q2: 'gemma-4-E2B-it-UD-IQ2_M.gguf',
        q3: 'gemma-4-E2B-it-Q3_K_M.gguf',
        q4: 'gemma-4-E2B-it-Q4_K_M.gguf',
        q4f16: 'gemma-4-E2B-it-Q3_K_M.gguf',
      },
    },
    modules: ['model'],
    sizes: {
      q2: { model: 2291 },
      q3: { model: 2537 },
      q4: { model: 3107 },
      q4f16: { model: 2537 },
    },
    wastedOnVision: false,
    ctxMax: 32768,
    ctxUse: 4096,
  },

  // 4B 等級走 GGUF 路線的候選。
  //
  // 為什麼是 Qwen3 而不是 Qwen3.5：**wllama 綁的 llama.cpp 不支援 qwen3_5**
  // （實測 grep 它的 wasm：qwen3／qwen3moe／minicpm5 都在，qwen3_5 沒有）。
  // Qwen3.5-4B 的 GGUF 在 HF 上存在，但在這條路線上載不起來。
  //
  // 為什麼要走 GGUF 而不是 ONNX：iPad 實測 ONNX 的 3,019 MB 載入失敗／載完崩潰，
  // 但 GGUF 的 1,154 MB 穩定跑（1,707 ms／回合）。
  // 同樣的位元組數，ONNX 路線在 Apple 裝置上吃更多記憶體
  // （iPhone 上 ONNX 665 MB 就崩，GGUF 105 MB 沒事）。
  //
  // 三種量化刻意跨過 iPad 的未知區間（1.15 GB 可用 ~ 3.0 GB 失敗）：
  //   Q2_K_XL 1,696 MB／Q3_K_M 2,076 MB／IQ4_XS 2,271 MB
  // 這樣一次就能定位天花板，不必每次重下載幾 GB。
  'qwen3-4b-gguf': {
    id: 'unsloth/Qwen3-4B-GGUF',
    label: 'Qwen3 4B（GGUF）',
    params: '4B',
    engine: 'wllama',
    kind: 'gguf',
    note: '4B 等級走 GGUF；用三種量化定位 iPad 的載入天花板',
    gguf: {
      repo: 'unsloth/Qwen3-4B-GGUF',
      rev: '22c9fc8a8c7700b76a1789366280a6a5a1ad1120',   // 鎖版本（見檔案開頭的說明）
      files: {
        q2: 'Qwen3-4B-UD-Q2_K_XL.gguf',
        q3: 'Qwen3-4B-Q3_K_M.gguf',
        // UD-Q3_K_XL（2,132 MB）品質優於 Q3_K_M，但**實測生成失敗**：
        // 2,033 MiB 的檔案加上執行期開銷就越過 2 GiB。我一度以為它「剛好在線內」，
        // 實測推翻——天花板要算的是「模型 + 執行期」，不是只算檔案。
        q3xl: 'Qwen3-4B-UD-Q3_K_XL.gguf',
        // IQ4_XS 是 2,271 MB = 2,166 MiB，超過 2 GiB，生成時必定失敗。
        // 保留在清單裡是為了記錄這個事實，避免日後再試一次。
        q4: 'Qwen3-4B-IQ4_XS.gguf',
        q4f16: 'Qwen3-4B-UD-Q3_K_XL.gguf',
      },
    },
    modules: ['model'],
    sizes: {
      q2: { model: 1696 },
      q3: { model: 2076 },
      q3xl: { model: 2132 },
      q4: { model: 2271 },
      q4f16: { model: 2132 },
    },
    // ── 瀏覽器內 GGUF 的硬天花板：約 2 GiB（2,147 MB）─────────────
    //
    // wllama 把整個模型放進 32 位元 wasm 的線性記憶體，模型必須塞進 2 GiB 位址空間。
    // 桌面實測（2026-08-20）三個檔案跨過這條線，錯誤訊息完全相同
    // （Invalid typed array length: 1163217991）：
    //
    //   Qwen3-4B Q3_K_M      2,076 MB = 1,979 MiB   可以生成  ← 目前找到的最大可用檔案
    //   Qwen3-4B UD-Q3_K_XL  2,132 MB = 2,033 MiB   失敗
    //   Qwen3-4B IQ4_XS      2,271 MB = 2,166 MiB   失敗
    //   Gemma 4 E2B Q3       2,537 MB = 2,420 MiB   失敗
    //
    // 邊界落在 1,979 與 2,033 MiB 之間，所以限制是「模型 + 執行期開銷 < 2,048 MiB」，
    // 換算成檔案大小的實務上限約 2,100 MB。**選模型時先過這一關，再看裝置。**
    //
    // 同一個常數在兩個完全不同的模型上出現，那是「不是模型問題」最直接的證據。
    // 我原本把 Gemma 的失敗歸因於 gemma3n 的逐層嵌入張量，那是錯的。
    ceilingNote: '瀏覽器內 GGUF 的實務上限約 2,100 MB（模型＋執行期須 < 2 GiB）',
    wastedOnVision: false,
    ctxMax: 32768,
    ctxUse: 4096,
  },

  // 管線測試用的極小模型（105 MB）。
  //
  // 為什麼需要：iPhone 上載入 688 MB 會讓分頁崩潰，但實測 wasm 記憶體可以長到 2 GB、
  // ArrayBuffer 到 3 GB——**所以崩潰不是記憶體不足**。
  // 用一個小到不可能有記憶體問題的模型，可以把「相容路徑本身能不能跑」
  // 和「模型太大」這兩件事分開。中文品質完全不重要，它只是量管線。
  'smollm2-135m': {
    id: 'unsloth/SmolLM2-135M-Instruct-GGUF',
    label: 'SmolLM2 135M（管線測試）',
    params: '135M',
    engine: 'wllama',
    kind: 'gguf',
    note: '只用來確認 wllama 相容路徑在該裝置上能否運作，不是候選模型',
    gguf: {
      repo: 'unsloth/SmolLM2-135M-Instruct-GGUF',
      files: { q4: 'SmolLM2-135M-Instruct-Q4_K_M.gguf', q4f16: 'SmolLM2-135M-Instruct-Q4_K_M.gguf' },
    },
    modules: ['model'],
    sizes: { q4: { model: 105 }, q4f16: { model: 105 } },
    wastedOnVision: false,
    ctxMax: 8192,
    ctxUse: 4096,
  },

  // 中間尺寸，用來二分搜尋 iPhone 的載入天花板。
  // 已知：105 MB（SmolLM2）與 688 MB（MiniCPM5 Q4）之間有一條界線，這個 398 MB 落在中間。
  // Qwen2.5-0.5B 的中文比 SmolLM2 好得多，所以萬一天花板真的很低，它也能當備援候選。
  'qwen2.5-0.5b-gguf': {
    id: 'bartowski/Qwen2.5-0.5B-Instruct-GGUF',
    label: 'Qwen2.5 0.5B（GGUF）',
    params: '0.5B',
    engine: 'wllama',
    kind: 'gguf',
    note: '二分搜尋用的中間尺寸；中文品質尚可，可當低配備援',
    gguf: {
      repo: 'bartowski/Qwen2.5-0.5B-Instruct-GGUF',
      rev: '41ba88dbac95fed2528c92514c131d73eb5a174b',   // 鎖版本（見檔案開頭的說明）
      files: {
        q4: 'Qwen2.5-0.5B-Instruct-Q4_K_M.gguf',
        q4f16: 'Qwen2.5-0.5B-Instruct-Q4_K_M.gguf',
        q6: 'Qwen2.5-0.5B-Instruct-Q6_K.gguf',
      },
    },
    modules: ['model'],
    sizes: { q4: { model: 398 }, q4f16: { model: 398 }, q6: { model: 506 } },
    wastedOnVision: false,
    ctxMax: 32768,
    ctxUse: 4096,
  },

  // ── GGUF 路線（wllama／llama.cpp）────────────────────────────
  //
  // MiniCPM5-1B：手機優先的首選候選。
  //   ・官方 GGUF Q4_K_M 只有 688 MB，與 Qwen3.5-0.8B（665 MB）同級 → 手機可行
  //   ・transformers.js 不支援 MiniCPM 架構，但 wllama 的 wasm 裡有 minicpm5（實測 grep 確認）
  //   ・llama.cpp 有 grammar，可在解碼層保證 JSON
  'minicpm5-1b': {
    id: 'openbmb/MiniCPM5-1B-GGUF',
    label: 'MiniCPM5 1B',
    params: '1B',
    engine: 'wllama',
    kind: 'gguf',
    note: '手機優先候選：688 MB、官方 GGUF、wllama 支援該架構',
    // GGUF 路線的量化選擇是「換檔案」，不是換 dtype 參數。
    // 量測 Q8_0 的理由：Q4_K_M 的輸出會出現不成句的詞（「您問得來」「請告訂時」），
    // 那有可能是量化損失而不是模型能力——1B 這種規模對量化更敏感。
    gguf: {
      repo: 'openbmb/MiniCPM5-1B-GGUF',
      rev: '3d55fac80935ae6456986ad2384b5cbcc4d6c948',   // 鎖版本（見檔案開頭的說明）
      files: {
        q4: 'MiniCPM5-1B-Q4_K_M.gguf',
        q4f16: 'MiniCPM5-1B-Q4_K_M.gguf',
        q8: 'MiniCPM5-1B-Q8_0.gguf',
      },
    },
    modules: ['model'],
    sizes: { q4f16: { model: 688 }, q4: { model: 688 }, q8: { model: 1154 } },
    wastedOnVision: false,
    ctxMax: 32768,
    // ⚠ 2048 太小。實機錯誤：request (2065 tokens) exceeds the available context size (2048)。
    // 續寫模式的提示詞本身就約 1,000 token（system 857 字＋兩組示範），
    // 逐字稿再累積兩三回就爆掉——**這是設定錯誤，不是模型限制**。
    // 4096 對記憶體的增加很小，但把上限拉開到夠用。
    ctxUse: 4096,
  },

  'qwen3.5-0.8b': {
    // ⚠ 一定要用 -OPT（官方的圖優化版本），不要用同名的未優化 repo。
    //
    // 2026-08-18 實測，同一個模型、同一份量化、同一台 GPU：
    //   onnx-community/Qwen3.5-0.8B-ONNX      prefill 165～171 ms／token
    //   onnx-community/Qwen3.5-0.8B-ONNX-OPT  prefill   1～2  ms／token
    //
    // 差約 165 倍。原因推測是 Qwen3.5 的混合架構（Gated DeltaNet 的 conv 與 recurrent 狀態）
    // 在未優化的圖裡被展開成逐 token 的序列運算，GPU 使用率只有 19%。
    //
    // 這件事在紙面規格上看不出來——handbook §9.1 第 3 條「不要只看紙面規格選模型」
    // 的又一個實例，而且這次連「模型」都一樣，差的只是匯出方式。
    id: 'onnx-community/Qwen3.5-0.8B-ONNX-OPT',
    label: 'Qwen3.5 0.8B',
    params: '0.8B',
    engine: 'transformers',
    kind: 'vl',            // 多模態：載入類別與 dtype 結構都與純文字模型不同
    note: '手機與桌面通用；目前唯一被證明能在手機瀏覽器跑的尺寸',
    // 這是多模態模型（Qwen3_5ForConditionalGeneration），三個子模型都必須指定 dtype，
    // 否則未指定的那個會退回 fp32（vision_encoder fp32 是 402 MB，會直接壓爆手機）。
    modules: ['embed_tokens', 'decoder_model_merged', 'vision_encoder'],
    // 實測大小（MB），依 dtype 分別列出三個子模型
    sizes: {
      q4f16: { embed_tokens: 147, decoder_model_merged: 437, vision_encoder: 62 },
      q4: { embed_tokens: 163, decoder_model_merged: 486, vision_encoder: 69 },
    },
    // 純文字用不到視覺編碼器，但 transformers.js 的模型類別仍會建立該 session。
    // 記錄下來，之後若要省這 62 MB 得改動 transformers.js 的載入流程（見 §L0b 筆記）。
    wastedOnVision: true,
    ctxMax: 262144,        // 模型能力上限；實際用多少由 §3.6 的上下文預算決定，不是這裡
  },

  'qwen3.5-2b': {
    // 同樣必須用 -OPT（見上方 0.8B 的說明，D028）
    id: 'onnx-community/Qwen3.5-2B-ONNX-OPT',
    label: 'Qwen3.5 2B',
    params: '2B',
    engine: 'transformers',
    kind: 'vl',
    note: '桌面升級選項。1.6 GB，手機瀏覽器不適用',
    modules: ['embed_tokens', 'decoder_model_merged', 'vision_encoder'],
    // 2026-08-18 由 HuggingFace API 實測
    sizes: {
      q4f16: { embed_tokens: 294, decoder_model_merged: 1090, vision_encoder: 197 },
      q4: { embed_tokens: 326, decoder_model_merged: 1208, vision_encoder: 218 },
    },
    wastedOnVision: true,
    ctxMax: 262144,
  },

  // 桌面上限測試：回答「瀏覽器路線到底有沒有可用的尺寸」（計畫書 §15.5 E1）。
  // 3.0 GB，手機完全不可能；純粹是為了知道語意品質的天花板在哪裡。
  'qwen3.5-4b': {
    id: 'onnx-community/Qwen3.5-4B-ONNX-OPT',
    label: 'Qwen3.5 4B',
    params: '4B',
    engine: 'transformers',
    kind: 'vl',
    note: '桌面上限測試，3 GB，手機不適用',
    modules: ['embed_tokens', 'decoder_model_merged', 'vision_encoder'],
    sizes: {
      q4f16: { embed_tokens: 368, decoder_model_merged: 2434, vision_encoder: 198 },
    },
    wastedOnVision: true,
    ctxMax: 262144,
  },

  // ── 對照組：不同模型家族的純文字模型 ────────────────────────
  //
  // 為什麼要試不同家族（計畫書 §15.5 E2）：
  //   Qwen3.5 Small 是「早期融合的多模態模型」——同一份參數要同時處理影像與文字。
  //   我們六大功能沒有一項需要看圖，所以那部分容量對我們是純浪費。
  //   一個同等或更小的**純文字**模型，可能在對話上反而更好。
  //
  // Qwen2.5-1.5B-Instruct 是這個假設最直接的檢驗：純文字、中文成熟度高、
  // 在 transformers.js 生態裡使用量大（實戰驗證多）。
  // Qwen3 世代的純文字小模型。單檔 570 MB，在瀏覽器的可載入範圍內。
  // 早先量 prefill 時用它當對照組（0.8 ms／token），但沒測過對話品質。
  'qwen3-0.6b': {
    id: 'onnx-community/Qwen3-0.6B-ONNX',
    label: 'Qwen3 0.6B',
    params: '0.6B',
    engine: 'transformers',
    kind: 'text',
    note: '對照組：純文字、傳統 dense 架構、單檔 570 MB',
    modules: ['model'],
    sizes: {
      q4f16: { model: 570 },
      q4: { model: 919 },
    },
    wastedOnVision: false,
    ctxMax: 32768,
  },

  'qwen2.5-1.5b': {
    id: 'onnx-community/Qwen2.5-1.5B-Instruct',
    label: 'Qwen2.5 1.5B',
    params: '1.5B',
    engine: 'transformers',
    kind: 'text',          // 純文字：用 AutoTokenizer + AutoModelForCausalLM
    // ⚠ 2026-08-18 實測：q4f16 在 WebGPU 上輸出亂碼（數值精度問題）；
    //   改 q4 則單檔 1,788 MB，載入時 std::bad_alloc——超過 ORT-web 的 wasm 記憶體上限。
    //   結論：這個 repo 在瀏覽器裡沒有可用的組合。保留紀錄避免日後重試。
    unusableInBrowser: 'q4f16 輸出亂碼；q4 單檔 1.8 GB 超過 wasm 上限',
    note: '對照組（實測不可用）：不同家族、純文字',
    modules: ['model'],
    sizes: {
      q4f16: { model: 1222 },
      q4: { model: 1788 },
    },
    wastedOnVision: false,
    ctxMax: 32768,
  },
};

// 某個模型在某種量化下要下載多少 MB（含用不到的 vision encoder）
export function downloadMB(key, dtype) {
  const s = MODELS[key]?.sizes?.[dtype];
  if (!s) return null;
  return Object.values(s).reduce((a, b) => a + b, 0);
}

// 純文字實際需要的權重（供記憶體預算計算，見計畫書 §5.2）
export function textOnlyMB(key, dtype) {
  const s = MODELS[key]?.sizes?.[dtype];
  if (!s) return null;
  // 純文字模型沒有 vision encoder，下載的每一個位元組都會被用到
  if (MODELS[key].kind !== 'vl') return Object.values(s).reduce((a, b) => a + b, 0);
  return s.embed_tokens + s.decoder_model_merged;
}

// 交給 transformers.js 的 dtype 物件：三個子模型都要給，不能留空
export function dtypeMap(key, dtype) {
  const m = MODELS[key];
  if (!m) throw new Error(`未知的本機模型：${key}`);
  return Object.fromEntries(m.modules.map(mod => [mod, dtype]));
}

// ── 取樣參數 ────────────────────────────────────────────────────
//
// Qwen 官方對 non-thinking 模式的建議值。Qwen3.5 Small 預設關閉 thinking，
// 對我們的延遲目標是好事（handbook §29 要求角色扮演 ≤ 2 秒）。
//
// roleplay 的 temperature 比官方建議低：小模型在長對話中容易人設漂移，
// 壓低隨機性是程式層能做的第一道防線（handbook §2.7 兩層防護的下半層）。
export const SAMPLING = {
  // 角色扮演＋JSON：實測（L1-a）發現 temperature 0.2 會讓 0.8B 卡在同一句台詞，
  // 五回合幾乎逐字重複。JSON 需要低隨機性、演戲需要高隨機性，這裡取中間值，
  // 並用**解碼層的重複懲罰**處理鸚鵡式重複——那比提示詞規則有效，
  // 因為它在生成時就讓重複的 token 變不可能（handbook §2.7 的下半層）。
  roleplay: {
    temperature: 0.65, top_p: 0.85, top_k: 20, max_new_tokens: 160,
    repetition_penalty: 1.15,      // 抑制跨句重複
    no_repeat_ngram_size: 4,       // 同一段話裡不重複出現 4 字以上的片段
  },
  // 純結構化輸出（痛點分析、教材摘要）：要穩定，不需要變化
  structured: { temperature: 0.2, top_p: 0.8, top_k: 20, max_new_tokens: 700 },
  feedback: { temperature: 0.5, top_p: 0.9, top_k: 20, max_new_tokens: 500, repetition_penalty: 1.1 },
};

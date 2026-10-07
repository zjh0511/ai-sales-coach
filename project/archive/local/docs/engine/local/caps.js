// 裝置能力偵測 —— 回答「這台裝置能不能跑、能跑哪一個」。
//
// 設計原則（handbook §2.10 / D019）：
//   使用者只看到「本機模型」四個字。0.8B 還是 2B、q4 還是 q4f16、WebGPU 還是 WASM，
//   全部由這一層決定。複雜度留在系統裡。
//
// 錯誤處理原則（handbook §2.9）：
//   偵測不到能力時回傳「標籤 + 可行動的說明」，不回傳原始例外訊息。
//   使用者需要知道「去哪裡做什麼」，不是看到 DOMException。

import { MODELS, downloadMB, textOnlyMB } from './models.js';

// ── 探測 ────────────────────────────────────────────────────────
//
// 回傳的每一個欄位都可能被 UI 直接顯示，所以不放無法解釋的原始值。
export async function probe() {
  const out = {
    webgpu: false,
    f16: false,
    maxBufferMB: 0,
    adapter: null,
    mobile: isMobile(),
    ios: isIOS(),
    tablet: isTablet(),
    cores: navigator.hardwareConcurrency || 0,
    quotaMB: null,
    usedMB: null,
    backend: 'none',        // 'webgpu' | 'wasm' | 'none'
    blocker: null,          // 不可用時的原因標籤
  };

  // 儲存配額：模型要存幾百 MB，配額不足要在下載前就告訴使用者（handbook §2.9 第 3 條）
  try {
    if (navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      // ⚠ 查不到、或回報 0，都要當成「不知道」而不是「沒有空間」。
      //   實測：某些環境（受限的內嵌瀏覽器、部分無痕模式）estimate() 回報 quota 0，
      //   但 OPFS 實際完全可用——2 GB 的模型讀寫都正常。
      //   把 0 當成真的沒空間，會把跑得動的裝置全部擋掉。
      const q = Math.round((e.quota || 0) / 1e6);
      out.quotaMB = q > 0 ? q : null;
      out.usedMB = q > 0 ? Math.round((e.usage || 0) / 1e6) : null;
    }
  } catch { /* 配額查不到不影響能不能跑，繼續 */ }

  if (!navigator.gpu) {
    out.blocker = 'no-webgpu-api';
    out.backend = hasWasm() ? 'wasm' : 'none';
    return out;
  }

  let adapter = null;
  try {
    adapter = await navigator.gpu.requestAdapter();
  } catch {
    out.blocker = 'adapter-error';
    out.backend = hasWasm() ? 'wasm' : 'none';
    return out;
  }
  if (!adapter) {
    // 有 navigator.gpu 但拿不到 adapter：常見於虛擬機、遠端桌面、或 GPU 被停用
    out.blocker = 'no-adapter';
    out.backend = hasWasm() ? 'wasm' : 'none';
    return out;
  }

  out.webgpu = true;
  out.backend = 'webgpu';
  out.f16 = adapter.features.has('shader-f16');
  out.maxBufferMB = Math.round((adapter.limits?.maxBufferSize || 0) / 1e6);
  out.adapter = {
    vendor: adapter.info?.vendor || '',
    architecture: adapter.info?.architecture || '',
  };
  return out;
}

// ── 依能力挑模型 ────────────────────────────────────────────────
//
// 順序刻意寫成「先排除，再挑選」，因為排除條件才是真正決定體驗的東西。
export function pickModel(caps, prefer = null) {
  const dtype = caps.f16 ? 'q4f16' : 'q4';

  // 手機：只有 0.8B 這個選項（D023）。
  // 桌面：預設也是 0.8B，2B 要等實測過才開放（不拿使用者當實驗品）。
  // prefer 只給量測台與（未來的）進階設定使用，不是預設路徑。
  const key = prefer && MODELS[prefer] ? prefer : 'qwen3.5-0.8b';
  const m = MODELS[key];

  const plan = {
    key,
    id: m.id,
    label: m.label,
    kind: m.kind || 'vl',
    dtype,
    device: caps.backend === 'webgpu' ? 'webgpu' : 'wasm',
    downloadMB: downloadMB(key, dtype),
    weightsMB: textOnlyMB(key, dtype),
    warnings: [],
  };

  if (caps.backend === 'none') {
    plan.blocked = 'no-backend';
    plan.blockedText = '這個瀏覽器無法在本機執行模型。請改用較新版的 Chrome、Edge 或 Safari。';
    return plan;
  }

  if (caps.backend === 'wasm') {
    plan.warnings.push('這台裝置沒有 WebGPU，會用較慢的 CPU 模式執行，每回合可能要等十秒以上。');
  }

  // maxBufferSize 是 WebGPU 單一緩衝區上限。權重會被切成多個緩衝區，
  // 但單層權重不能超過它，所以太小就是跑不動——這是 Safari 上最常見的死因。
  if (caps.webgpu && caps.maxBufferMB && caps.maxBufferMB < 256) {
    plan.warnings.push(`這台裝置的 GPU 單一緩衝區上限只有 ${caps.maxBufferMB} MB，模型可能載入失敗。`);
  }

  if (caps.quotaMB != null && plan.downloadMB != null) {
    const free = caps.quotaMB - (caps.usedMB || 0);
    if (free < plan.downloadMB * 1.2) {
      plan.warnings.push(`可用儲存空間約 ${free} MB，模型需要 ${plan.downloadMB} MB。請先清出空間。`);
    }
  }

  // 平板與手機要分開看。
  //
  // 2026-08-19 實測：iPhone 14 Pro（6 GB RAM）上 688 MB 以上一律崩潰，
  // 但那個結論**不能直接套到 iPad Pro M 系列**——桌面級 GPU、記憶體多得多、
  // Safari 給分頁的預算也大得多。把手機的警告套到平板上只會誤導使用者。
  //
  // 兩者共通的是「保持螢幕開啟、連續演練會發熱」，那條對平板一樣成立。
  if (caps.mobile || caps.tablet) {
    plan.warnings.push('行動裝置執行時請保持螢幕開啟；連續演練可能發熱並降速。');
  }
  if (caps.mobile && !caps.tablet && plan.downloadMB > 600) {
    // 手機的實測天花板：105 MB 可載入、688 MB 崩潰（原因不是記憶體總量，見 D041）
    plan.warnings.push(`實測顯示手機瀏覽器在 600 MB 以上極易失敗（${plan.label} 需要 ${plan.downloadMB} MB）。`);
  }

  return plan;
}

// ── 給使用者看的一句話 ──────────────────────────────────────────
export function describe(caps, plan) {
  if (plan.blocked) return plan.blockedText;
  const how = plan.device === 'webgpu' ? '使用 GPU 加速' : '使用 CPU 模式（較慢）';
  return `${plan.label}｜${how}｜首次需下載約 ${plan.downloadMB} MB，之後離線可用`;
}

// ── 平台判斷 ────────────────────────────────────────────────────
//
// 只用來調整預期與提示文字，不用來開關功能——
// User-Agent 判斷平台一定會有例外，不能讓功能建立在它上面。
function isMobile() {
  if (navigator.userAgentData?.mobile != null) return navigator.userAgentData.mobile;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

function isIOS() {
  // iPadOS 的 UA 會偽裝成 Mac，所以要看有沒有觸控點。
  // ⚠ 另外記一筆：**UA 不能用來判斷 iOS 版本**——Safari 從 iOS 26 起回報凍結的
  //    版本字串（實測 iOS 26.6 的裝置回報 "iPhone OS 18_7"）。見 D040 附註。
  return /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// 平板：iPad 的 UA 可能寫 iPad，也可能偽裝成 Mac（桌面版網站模式）。
// 螢幕尺寸是比 UA 更可靠的線索，兩者合併判斷。
function isTablet() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua)) return true;
  const macTouch = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  const big = Math.min(screen.width, screen.height) >= 700;
  return macTouch && big;
}

function hasWasm() {
  return typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';
}

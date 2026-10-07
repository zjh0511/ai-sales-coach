// 本機模型的分級：這台裝置該下載哪一個。
//
// 為什麼不能只靠能力偵測（D042 已經付過代價）：
//   iPhone 14 Pro 的記憶體探測回報「wasm 2048 MB ✅、ArrayBuffer 3072 MB ✅」，
//   看起來完全夠，**然後載入 2 GB 模型時分頁被系統殺掉**（Safari 顯示「重複發生問題」）。
//   分頁被殺掉時 JS 沒有機會執行任何錯誤處理，所以連 try/catch 都攔不到。
//
//   結論：**能力偵測是必要條件，不是充分條件。**
//
// 因此這一層是三道防線疊起來的：
//   ① 裝置類別 ＋ 儲存配額 → 先挑一個合理的起點
//   ② 崩潰記憶（app.js 的 LOAD_FLAG）→ 上一次把分頁弄掛的模型直接排除
//   ③ 使用者可以自己覆寫（?m= 參數）
//
//   只有 ② 是真正可靠的——它記錄的是「實際發生過的事」而不是推測。

// 由大到小。每一級都是**實測過檔案大小**的組合（見 models.js 的 sizes）。
//
// ⚠ shipped 決定「自動選擇會不會用它」。目前只有 4B 是 true。
//
// 為什麼放棄自動降階（2026-08-21，使用者在 iPad 上實測後的決定）：
//   降階本來的用意是「讓跑不動 4B 的裝置至少能練」。但實測證明那個前提是錯的——
//   MiniCPM5 1B 與 Qwen2.5 0.5B 挖到的隱藏需求都是 0／3（4B 是 2／3），
//   使用者的原話是「對話很不OK」。
//
//   一個從不透露心裡話的客戶，讓「發掘需求」這個核心練習等於不成立。
//   **給他一個看起來會動、實際練不到東西的版本，比明確告訴他「這台裝置不行」更糟**——
//   後者他還知道要換 iPad 或用雲端金鑰，前者他會以為這個 App 就是這樣。
//
//   1B／0.5B 的定義留下來，是為了量測台仍然可以用 ?m= 指定它們。
export const LOCAL_TIERS = [
  {
    model: 'qwen3-4b-gguf', shipped: true, dtype: 'q3', mb: 2076,
    label: 'Qwen3 4B',
    quality: '中文最自然，角色維持得最好',
    proven: 'iPad Pro M5、桌機實測可用（感知延遲 0.77 秒）',
  },
  {
    model: 'minicpm5-1b', shipped: false, dtype: 'q8', mb: 1154,
    label: 'MiniCPM5 1B',
    quality: '可以對談，但中文與角色維持明顯不如 4B',
    proven: 'iPad Pro M5 實測可用（每回合 1.7 秒）',
  },
  {
    model: 'qwen2.5-0.5b-gguf', shipped: false, dtype: 'q4', mb: 398,
    label: 'Qwen2.5 0.5B',
    quality: '只能做基本對答，客戶的反應會比較單薄',
    proven: '尚未在手機上完整驗證——手機屬於實驗性支援',
  },
];

const byKey = k => LOCAL_TIERS.find(t => t.model === k);

// OPFS 寫入需要約 2 倍檔案大小的空間。
//
// 實測依據：createWritable() 會先建立一份暫存副本再置換，
// 所以寫入期間同時存在兩份。iPad 上曾在 2,066／2,537 MB 處配額爆掉。
// 這裡取 2.2 倍，多留一點給既有資料。
const QUOTA_FACTOR = 2.2;

export function pickLocalTier(caps = {}, { blocked = [], prefer = null } = {}) {
  const reasons = [];

  // 使用者明確指定（?m=）可以挑任何一級，包含沒有發布的量測用模型。
  // 但已知會把分頁弄掛的仍然不給。
  if (prefer) {
    const p = LOCAL_TIERS.find(t => t.model === prefer && !blocked.includes(t.model));
    if (p) return { tier: p, reasons, forced: true, blocked };
  }

  // 自動選擇只考慮 shipped 的分級（目前只有 4B）
  let list = LOCAL_TIERS.filter(t => t.shipped && !blocked.includes(t.model));

  if (blocked.length) {
    const names = blocked.map(k => byKey(k)?.label || k).join('、');
    reasons.push(`已停用的模型：${names}（上次載入時分頁被系統關閉）。`);
  }

  if (!list.length) {
    return {
      tier: null, blocked, reasons, blockedAll: blocked.length > 0,
      unavailable: blocked.length
        ? '上次載入本機模型時分頁被系統關閉，所以先停用了它。如果那是因為你在下載中重新整理或切換了 App，可以按下面的「重試」再試一次；若不是，請改用 iPad／電腦，或用雲端 API 金鑰登入。'
        : '這台裝置的瀏覽器記憶體不足以執行本機模型。請改用 iPad 或電腦，或用雲端 API 金鑰登入。',
    };
  }

  // ── ① 裝置類別 ──
  //
  // 手機與平板的記憶體探測結果一樣（都回報 2048／3072 MB），區分不出來，
  // 所以改用螢幕尺寸判斷的裝置類別——那是目前唯一與實測結果相符的線索。
  const isPhone = caps.mobile && !caps.tablet;
  if (isPhone) {
    // iPhone 14 Pro 實測：2,076 MB 與 1,154 MB 都會讓分頁被殺掉。
    // 而唯一發布的 4B 就是 2,076 MB，所以手機明確不支援——
    // 不再退到小模型，因為那些模型練不到東西（見上方 shipped 的說明）。
    return {
      tier: null, blocked, reasons, phone: true,
      unavailable: '手機的瀏覽器記憶體不足以執行本機模型（需要 2 GB 以上）。'
        + '請改用 iPad 或電腦，或用雲端 API 金鑰登入——雲端模式在手機上完全沒問題，六大功能都能用。',
    };
  } else if (caps.tablet && caps.cores && caps.cores < 8) {
    // iPad Pro M5 是 8 執行緒且實測可用；核心數更少的平板沒有驗證過。
    // 以前這裡會降階，現在沒有可降的了——所以改成「讓他試，但先講清楚」。
    // 真的跑不動的話，崩潰記憶會在下一次開機時攔下來。
    reasons.push(`偵測到平板，CPU ${caps.cores} 執行緒（實測可用的 iPad Pro M5 是 8）。`
      + '這個組合還沒有驗證過，載入時如果分頁被關閉，那就是記憶體不足。');
  }

  // ── ② 儲存配額 ──
  // 配額查詢不可信時一律當成「不知道」，讓使用者去試——
  // 擋住一台其實跑得動的裝置，比讓他試一次失敗更糟（他沒有第二條路可走）。
  // 實測過的情況：受限環境的 estimate() 回報 quota 0，而 OPFS 完全正常。
  const raw = caps.quotaMB != null && caps.usedMB != null ? caps.quotaMB - caps.usedMB : null;
  const free = raw != null && raw > 0 && caps.quotaMB > 0 ? raw : null;
  if (free != null) {
    const t = list[0];
    // 只有「連一倍都放不下」才真的擋——那是物理上不可能。
    if (free < t.mb) {
      return {
        tier: null, blocked, reasons,
        unavailable: `瀏覽器可用的儲存空間只有約 ${free} MB，放不下 ${t.mb} MB 的模型。`
          + '請清出一些空間，或用雲端 API 金鑰登入。',
      };
    }
    // 一倍到兩倍之間：警告，但**讓他試**。
    //
    // 為什麼不擋：寫入需要約兩倍是觀察到的行為，不是保證值
    // （不同瀏覽器的 OPFS 實作差異很大，而 estimate() 本身也不可靠——
    //  實測遇過回報 quota 0 而 OPFS 完全正常）。
    // 用一個不確定的數字去擋一台可能跑得動的裝置，代價比讓他試一次失敗高：
    // 失敗會得到明確的配額錯誤（那是一般錯誤，不會被記成崩潰），他還能清空間再來；
    // 被擋住的話他只會覺得這個 App 不支援他的裝置。
    if (free < t.mb * QUOTA_FACTOR) {
      reasons.push(`瀏覽器可用的儲存空間約 ${free} MB，而寫入 ${t.mb} MB 的模型時可能需要約兩倍`
        + `（約 ${Math.round(t.mb * QUOTA_FACTOR)} MB）。可以試，但如果中途失敗就是空間不足——`
        + '清出一些空間再試一次即可。');
    }
  }

  return { tier: list[0], reasons, blocked, freeMB: free };
}

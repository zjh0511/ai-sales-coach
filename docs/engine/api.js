// 本地 API 層 —— 取代原本的伺服器。
// 保留與伺服器版完全相同的呼叫介面，UI 不需要知道背後有沒有伺服器。
// 全部運算都在使用者自己的瀏覽器完成，金鑰與文件都不離開這台裝置。

import { PROVIDERS, createAdapter, scrubKey, friendlyError } from './gateway.js';
import * as CE from './session.js';
import * as KB from './knowledge.js';
import * as AD from './advisor.js';

let gw = null;                 // 目前登入的模型連線
let current = { provider: null, key: null };
let onEvent = null;            // 降階／額度事件通知 UI

export const providers = () => PROVIDERS;
export const onModelEvent = fn => { onEvent = fn; if (gw) gw.onEvent = fn; };

function need() {
  if (!gw) { const e = new Error('尚未設定 API 金鑰，請重新登入'); e.auth = true; throw e; }
  return gw;
}

async function connect(provider, key) {
  const a = createAdapter(provider, key);
  try {
    await a.init();                                  // 探測可用模型，順便驗證金鑰
  } catch (err) {
    const raw = scrubKey(err.message, key);
    const e = new Error(friendlyError(raw, provider) || `無法連線：${raw.slice(0, 160)}`);
    e.auth = true;
    throw e;
  }
  a.onEvent = onEvent;
  gw = a;
  current = { provider, key };
  return a;
}

// 重新整理頁面後用已存的金鑰靜默恢復連線
export async function restore(provider, key, pin) {
  if (!provider || !key) return false;
  try {
    const a = await connect(provider, key);
    if (pin) a.pin(pin);
    return true;
  } catch { return false; }
}

export const isReady = () => !!gw;

// ── 路由（與伺服器版同名，方便日後再切回伺服器架構）──────────────
export async function api(path, body = {}) {
  try {
    switch (path) {
      case '/login': {
        const a = await connect(body.provider, body.key);
        if (body.pin) a.pin(body.pin);          // 沿用上次選定的模型
        return { ok: true, provider: body.provider, fast: a.fast, judge: a.judge, file: a.supportsFile };
      }

      // 模型清單與指定（不指定就維持自動）
      case '/models/status': return need().status();
      case '/models/set': return need().pin(body.model || null);

      // 功能一：客戶潛在痛點分析
      case '/analyze/pain':
        return await AD.painPoints(need(), body);

      // 功能二／三／四：角色扮演
      case '/session/start': {
        const doc = body.mode === 'product' ? await KB.getDoc(body.docId) : null;
        if (body.mode === 'product' && !doc) throw new Error('請先選擇一份商品教材');
        return await CE.startSession(need(), {
          mode: body.mode || 'call', gender: body.gender, age: body.age, background: body.background,
          difficulty: Number(body.difficulty) || 2, doc,
          context: body.context || 'cold', contextNote: (body.contextNote || '').slice(0, 300),
        });
      }
      case '/session/begin': return CE.beginRoleplay(session(body));
      case '/session/turn': return await CE.handleTurn(need(), session(body), body.text);
      case '/session/end': {
        const s = session(body);
        const out = await CE.evaluate(need(), s);
        CE.dropSession(s.id);
        return out;
      }
      case '/session/abort': CE.dropSession(body.sessionId); return { ok: true };

      // 文件知識庫
      case '/doc/list': return { docs: await KB.listDocs(body.kind) };
      case '/doc/upload': {
        if (!body.name || !body.base64) throw new Error('沒有收到檔案');
        if (body.kind !== 'product' && body.kind !== 'policy') throw new Error('未指定文件用途');
        return await KB.ingest(need(), body);
      }
      case '/doc/delete': return { ok: await KB.deleteDoc(body.id) ?? true };

      // 功能五：理賠諮詢
      case '/claim/ask': {
        const doc = await KB.getDoc(body.docId);
        if (!doc) throw new Error('請先選擇一份保單條款');
        if (!body.question?.trim()) throw new Error('請描述客戶的狀況');
        return await AD.claimAdvice(need(), doc, { question: body.question, history: body.history });
      }

      // 功能六：行銷諮詢
      case '/coach/chat':
        if (!body.message?.trim()) throw new Error('請輸入內容');
        return await AD.coachChat(need(), body);

      default:
        throw new Error('unknown_endpoint');
    }
  } catch (e) {
    if (e.auth) throw e;
    const raw = scrubKey(e.message, current.key);
    const friendly = friendlyError(raw, current.provider);

    if (friendly) {
      console.error(`[api] ${path} → ${friendly}`);
      // 只有「金鑰無效／沒權限」才該退回登入畫面；
      // 餘額不足、限流、逾時都不是金鑰問題，把人踢回登入只會讓他更困惑
      if (/金鑰無效|沒有使用權限|是否已開通/.test(friendly)) {
        const err = new Error(friendly); err.auth = true; throw err;
      }
      throw new Error(friendly);
    }

    // 我們自己丟出的操作提示，原文就是給使用者看的
    if (/請先|沒有收到|未指定|請描述|請輸入|超過上限|讀不到|解析失敗|不支援|逾時，請重新開始/.test(raw)) {
      throw new Error(raw);
    }

    console.error(`[api] ${path} → ${raw.slice(0, 200)}`);
    throw new Error('剛剛好像卡了一下，請再試一次。');
  }
}

function session(body) {
  const s = CE.getSession(body.sessionId);
  if (!s) throw new Error('這次練習的連線已經逾時，請重新開始。');
  return s;
}

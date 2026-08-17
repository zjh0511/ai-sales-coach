// 讀取本機的「API Key.txt」，格式為：標籤行 + 金鑰行（可用空行分隔）。
// 僅供 tools/ 底下的測試腳本使用；這個檔案在 .gitignore 內，不會進版控。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const MATCH = [
  [/gemini|google/i, 'gemini'],
  [/nvidia|nvapi/i, 'nvidia'],
  [/openrouter/i, 'openrouter'],
  [/anthropic|claude/i, 'anthropic'],
  [/openai|chatgpt/i, 'openai'],
  [/groq/i, 'groq'],
  [/deepseek/i, 'deepseek'],
];

export function loadKeys() {
  const out = {};
  for (const name of ['API Key.txt', 'Gemini API Key.txt']) {
    const p = path.join(ROOT, name);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).map(s => s.trim());
    let label = null;
    for (const line of lines) {
      if (!line) continue;
      const hit = MATCH.find(([re]) => re.test(line));
      // 一行同時像標籤又像金鑰時，以「有空白字元」判定為標籤
      if (hit && /\s/.test(line)) { label = hit[1]; continue; }
      if (label) { out[label] ||= line; label = null; }
      else if (/^AQ\.|^AIza/.test(line)) out.gemini ||= line;
      else if (/^nvapi-/.test(line)) out.nvidia ||= line;
      else if (/^sk-or-/.test(line)) out.openrouter ||= line;
      else if (/^sk-ant-/.test(line)) out.anthropic ||= line;
      else if (/^gsk_/.test(line)) out.groq ||= line;
    }
  }
  for (const [env, k] of [['GEMINI_API_KEY', 'gemini'], ['NVIDIA_API_KEY', 'nvidia'], ['OPENROUTER_API_KEY', 'openrouter']]) {
    if (process.env[env]) out[k] = process.env[env].trim();
  }
  return out;
}

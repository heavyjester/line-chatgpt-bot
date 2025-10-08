// index.js — v2 進階版
// 功能：
// 1) FAQ / 知識庫 (RAG-lite)：先檢索 FAQ，再交給 OpenAI 生成正式回覆
// 2) 多輪對話記憶：保留每位使用者最近 5 輪訊息
// 3) 真人客服轉接：關鍵字偵測（可選 webhook 通知）
// 4) 日誌紀錄：JSON Lines 存入 /logs/chatlog.json（Railway 容器重啟後會清空，正式上線可改雲端 DB）
// 5) 安全與錯誤處理：輸入清洗、簽章錯誤/JSON 錯誤攔截

import 'dotenv/config';
import express from 'express';
import { Client, middleware, JSONParseError, SignatureValidationFailed } from '@line/bot-sdk';
import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';

// ---- 環境變數 ----
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-turbo';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
const HANDOFF_WEBHOOK_URL = process.env.HANDOFF_WEBHOOK_URL || '';

// ---- 初始化 ----
const app = express();
const client = new Client(config);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = process.env.PORT || 3000;

// 使用者上下文記憶（僅存於記憶體，重啟後清空）
const memory = new Map(); // key: userId, value: [{role, content, ts}]

// FAQ 資料與向量快取
let faq = [];
let faqVectors = []; // 與 faq 對齊的 embedding 向量（Float32Array）

// ---- 工具函式 ----
const ensureLogsDir = async () => {
  try { await fs.mkdir('logs', { recursive: true }); } catch {}
};

const appendLog = async (obj) => {
  try {
    await ensureLogsDir();
    await fs.appendFile(path.join('logs', 'chatlog.json'), JSON.stringify(obj) + '\n', 'utf8');
  } catch (e) { console.error('log append failed:', e.message); }
};

const cleanInput = (text) => (text || '')
  .replace(/[\u200B-\u200D\uFEFF]/g, '') // 零寬字
  .slice(0, 2000) // 最長限制
  .trim();

const cosineSim = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
};

const embed = async (texts) => {
  const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: texts });
  return res.data.map(d => d.embedding);
};

const loadFaq = async () => {
  try {
    const raw = await fs.readFile('faq.json', 'utf8');
    faq = JSON.parse(raw); // [{q, a, tags?}]
    // 建向量（問題+答案一起嵌入，提高可檢索性）
    const corpus = faq.map(x => `${x.q}\n${x.a}`);
    faqVectors = (await embed(corpus)).map(v => Float32Array.from(v));
    console.log(`FAQ loaded: ${faq.length} items with vectors`);
  } catch (e) {
    faq = [];
    faqVectors = [];
    console.warn('No faq.json found or failed to load FAQ (optional):', e.message);
  }
};

const searchFaq = async (query, topK = 3) => {
  if (!faq.length) return [];
  try {
    const [qvec] = await embed([query]);
    const qv = Float32Array.from(qvec);
    const scored = faqVectors.map((v, i) => ({ i, score: cosineSim(qv, v) }));
    scored.sort((a, b) => b.score - a.score);
    const picks = scored.slice(0, topK).filter(s => s.score > 0.2).map(s => ({ ...faq[s.i], score: s.score }));
    return picks;
  } catch (e) {
    console.error('FAQ search error:', e.message);
    return [];
  }
};

const pushMemory = (userId, role, content) => {
  const arr = memory.get(userId) || [];
  arr.push({ role, content, ts: Date.now() });
  while (arr.length > 10) arr.shift(); // 總上限
  memory.set(userId, arr);
};

const getRecentMessages = (userId, limit = 5) => {
  const arr = memory.get(userId) || [];
  return arr.slice(-limit).map(x => ({ role: x.role, content: x.content }));
};

const handoffNeeded = (text) => /人工客服|真人客服|真人|請打給我|業務聯絡|電話|聯絡我|找人員/i.test(text);

const notifyHandoff = async (payload) => {
  if (!HANDOFF_WEBHOOK_URL) return;
  try {
    await fetch(HANDOFF_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  } catch (e) { console.warn('handoff notify failed:', e.message); }
};

// ---- 路由 ----
app.get('/', (_, res) => res.send('OK'));
// 讓某些平台探活不報 404
app.get('/webhook', (_, res) => res.status(200).send('OK'));
app.head('/webhook', (_, res) => res.status(200).end());

app.post('/webhook', middleware(config), async (req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  if (events.length === 0) return res.status(200).end();
  await Promise.all(events.map(handleEvent));
  res.status(200).end();
});

async function handleEvent(event) {
  try {
    if (event.type !== 'message' || event.message.type !== 'text') return;
    const userId = event.source?.userId || 'unknown';
    const userText = cleanInput(event.message.text);

    // 日誌：收到使用者訊息
    await appendLog({ t: Date.now(), type: 'in', userId, text: userText });
    pushMemory(userId, 'user', userText);

    // 1) 真人客服轉接
    if (handoffNeeded(userText)) {
      const reply = '已為您安排人工客服協助，稍後將有同仁與您聯繫。若方便，請提供公司/姓名/電話。';
      await client.replyMessage(event.replyToken, { type: 'text', text: reply });
      await notifyHandoff({ userId, text: userText, ts: Date.now() });
      await appendLog({ t: Date.now(), type: 'out', userId, route: 'handoff', text: reply });
      pushMemory(userId, 'assistant', reply);
      return;
    }

    // 2) FAQ 檢索（RAG-lite）
    const faqHits = await searchFaq(userText, 3);
    const faqContext = faqHits.length
      ? faqHits.map((x, idx) => `【FAQ#${idx + 1}（相似度 ${x.score.toFixed(2)}）】\nQ: ${x.q}\nA: ${x.a}`).join('\n\n')
      : '';

    // 3) 多輪對話 + FAQ context → OpenAI
    const contextMsgs = [
      { role: 'system', content: '你是專業且友善的資安客服助理，回答要精準、條列化、可操作，必要時給下一步指引。' }
    ];
    const history = getRecentMessages(userId, 5);
    contextMsgs.push(...history);
    if (faqContext) {
      contextMsgs.push({ role: 'system', content: `以下為公司 FAQ 參考內容，優先使用其中事實：\n\n${faqContext}` });
    }
    contextMsgs.push({ role: 'user', content: userText });

    const completion = await openai.chat.completions.create({ model: OPENAI_MODEL, messages: contextMsgs });
    const answer = (completion.choices?.[0]?.message?.content || '抱歉，我現在沒有足夠資訊回答。').slice(0, 4900);

    await client.replyMessage(event.replyToken, { type: 'text', text: answer });

    // 記憶與日誌
    pushMemory(userId, 'assistant', answer);
    await appendLog({ t: Date.now(), type: 'out', userId, route: faqHits.length ? 'faq+ai' : 'ai', text: answer, hits: faqHits.map(h => ({ q: h.q, score: h.score })) });
  } catch (err) {
    console.error('handleEvent error:', err);
    try {
      await client.replyMessage(event.replyToken, { type: 'text', text: '抱歉，系統忙碌中，我們稍後再回覆您。' });
    } catch {}
  }
}

// 錯誤攔截：讓簽章錯誤→401，JSON 錯誤→400，其餘→500
app.use((err, _req, res, _next) => {
  if (err instanceof SignatureValidationFailed) {
    console.error('Signature validation failed');
    res.status(401).send('Bad signature');
  } else if (err instanceof JSONParseError) {
    console.error('JSON parse error');
    res.status(400).send('Bad request');
  } else {
    console.error('Unhandled error:', err);
    res.status(500).send('Internal Server Error');
  }
});

// 啟動
await loadFaq();
app.listen(PORT, () => {
  console.log('Server running on port', PORT);
});

/* -------------------------
README（部署補充）
1) 新增檔案 `faq.json`（放在專案根目錄）：
[
  { "q": "什麼是產品A授權？", "a": "產品A按年授權，分標準版/企業版…" },
  { "q": "是否支援 macOS？", "a": "支援 12 以上版本…" },
  { "q": "報價流程？", "a": "請提供公司名稱、人數、需求模組…我們 1-2 個工作天回覆。" }
]

2) Railway → Variables：
- LINE_CHANNEL_ACCESS_TOKEN = <你的值>
- LINE_CHANNEL_SECRET = <你的值>
- OPENAI_API_KEY = <你的值>
- OPENAI_MODEL = gpt-5-turbo（可省略）
- EMBEDDING_MODEL = text-embedding-3-small（可省略）
- HANDOFF_WEBHOOK_URL = https://你的內部通知端點（可省略）

3) Commit 後 Redeploy，看到 Logs：`FAQ loaded: n items with vectors` 即完成。
4) 驗證：
- GET / → 200 OK
- GET /webhook → 200 OK
- POST /webhook（無簽章）→ 401
- LINE Verify → 200，手機對話可用

注意：/logs/chatlog.json 寫在容器內，Railway 重新部署會清空。正式上線請改用雲端 DB（如 Supabase、Firestore、MongoDB Atlas）。
------------------------- */

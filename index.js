// index.js — v2.5 進階版（Offline FAQ 模式）
// 功能：
// 1) FAQ 本地檢索（不連 OpenAI）
// 2) 多輪對話記憶（最近 5 輪）
// 3) 真人客服轉接（可選 webhook 通知）
// 4) 日誌紀錄（/logs/chatlog.json）
// 5) 錯誤處理：簽章/JSON 錯誤攔截、GET/HEAD 探活

import 'dotenv/config';
import express from 'express';
import { Client, middleware, JSONParseError, SignatureValidationFailed } from '@line/bot-sdk';
import fs from 'fs/promises';
import path from 'path';

// ---- 環境變數 ----
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const HANDOFF_WEBHOOK_URL = process.env.HANDOFF_WEBHOOK_URL || '';
const OFFLINE_MODE = process.env.OFFLINE_MODE === '1' || true; // 預設離線模式

// ---- 初始化 ----
const app = express();
const client = new Client(config);
const PORT = process.env.PORT || 3000;

// 使用者上下文記憶（僅存於記憶體）
const memory = new Map(); // key: userId, value: [{role, content, ts}]

// FAQ 資料（本地）
let faq = [];

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

// --- Very light tokenizer (中英混合) ---
const tokenize = (s) => {
  const t = (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
  // 針對中英文：把每個中文字也納入 token
  const zh = [...(s || '').replace(/\s+/g, '')];
  const en = t.split(/\s+/).filter(Boolean);
  return Array.from(new Set([...en, ...zh]));
};

// 簡易相似度（Jaccard + 關鍵詞加權）
const scoreSimilarity = (q, text) => {
  const qs = tokenize(q);
  const ts = tokenize(text);
  if (qs.length === 0 || ts.length === 0) return 0;
  const setQ = new Set(qs);
  const setT = new Set(ts);
  let inter = 0;
  for (const w of setQ) if (setT.has(w)) inter++;
  const jaccard = inter / (setQ.size + setT.size - inter);
  // 額外關鍵詞加權
  const bonusWords = ['netwrix','endpoint','protector','dlp','usb','報價','授權','change','tracker','auditor','稽核','合規','macos','windows'];
  let bonus = 0;
  for (const bw of bonusWords) if (setQ.has(bw) && setT.has(bw)) bonus += 0.02;
  return Math.min(1, jaccard + bonus);
};

const loadFaq = async () => {
  try {
    const raw = await fs.readFile('faq.json', 'utf8');
    faq = JSON.parse(raw); // [{q, a, tags?}]
    console.log(`FAQ loaded (offline): ${faq.length} items`);
  } catch (e) {
    faq = [];
    console.warn('No faq.json found or failed to load FAQ (optional):', e.message);
  }
};

const searchFaqLocal = (query, topK = 3) => {
  if (!faq.length) return [];
  const scored = faq.map((x, i) => ({ i, score: scoreSimilarity(query, `${x.q}\n${x.a}`) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).filter(s => s.score > 0.08).map(s => ({ ...faq[s.i], score: s.score }));
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

    // 2) FAQ 檢索（Offline）
    const faqHits = searchFaqLocal(userText, 3);

    let answer = '';
    if (faqHits.length > 0) {
      // 取第一筆為主、附上延伸閱讀
      const top = faqHits[0];
      const extras = faqHits.slice(1).map((x, i) => `\n\n（延伸 #${i+2}）Q: ${x.q}\nA: ${x.a}`).join('');
      answer = `【參考回答】\n${top.a}${extras}`.slice(0, 4900);
    } else {
      // 無命中：提供導引
      answer = '目前為離線 FAQ 模式，請嘗試關鍵詞：如「授權」「報價」「USB 加密」「Change Tracker」「Auditor 稽核」。';
    }

    await client.replyMessage(event.replyToken, { type: 'text', text: answer });

    // 記憶與日誌
    pushMemory(userId, 'assistant', answer);
    await appendLog({
      t: Date.now(),
      type: 'out',
      userId,
      route: faqHits.length ? 'faq-offline' : 'nohit',
      text: answer,
      hits: faqHits.map(h => ({ q: h.q, score: Number(h.score.toFixed(3)) }))
    });
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
  console.log('Server running on port', PORT, 'OFFLINE_MODE=', OFFLINE_MODE);
});

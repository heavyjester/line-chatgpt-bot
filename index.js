import 'dotenv/config';
import express from 'express';
import {
  Client,
  middleware,
  JSONParseError,
  SignatureValidationFailed
} from '@line/bot-sdk';
import OpenAI from 'openai';

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret) {
  console.error('❌ Missing LINE_CHANNEL_ACCESS_TOKEN or LINE_CHANNEL_SECRET');
}

const app = express();
const client = new Client(config);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 健康檢查
app.get('/', (_, res) => res.send('OK'));

// Webhook（一定要在錯誤處理器之前）
app.post('/webhook', middleware(config), async (req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  if (events.length === 0) return res.status(200).end(); // 沒事件就回 200，避免多餘動作

  await Promise.all(events.map(handleEvent));
  res.status(200).end();
});

async function handleEvent(event) {
  // 只處理文字訊息
  if (event.type !== 'message' || event.message.type !== 'text') return;
  const userText = (event.message.text || '').trim();

  // 關鍵字路由（可選）
  const routes = [
    { kw: /報價|價格|費用/, reply: '我們會請業務與您聯繫，請提供公司與聯絡電話，謝謝！' },
    { kw: /人工客服|真人/, reply: '已為您轉接人工客服，稍後將由同仁回覆。' },
  ];
  for (const r of routes) {
    if (r.kw.test(userText)) {
      return client.replyMessage(event.replyToken, { type: 'text', text: r.reply });
    }
  }

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-5-turbo',
      messages: [
        { role: 'system', content: '你是專業、簡潔、友善的資安客服助理。' },
        { role: 'user', content: userText },
      ],
    });

    const answer =
      completion.choices?.[0]?.message?.content?.slice(0, 4900) ||
      '（沒有產生內容）';

    await client.replyMessage(event.replyToken, { type: 'text', text: answer });
  } catch (err) {
    console.error('OpenAI or reply error:', err);
    // 先回一段話，避免 500
    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: '抱歉，系統忙碌中，我們稍後再回覆您。'
    });
  }
}

// ---- 這段是關鍵：把 LINE 驗簽錯誤轉成 401 / 400，而不是 500 ----
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

app.listen(process.env.PORT || 3000, () => {
  console.log('Server running on port', process.env.PORT || 3000);
});

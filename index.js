import 'dotenv/config';
import express from 'express';
import { Client, middleware } from '@line/bot-sdk';
import OpenAI from 'openai';

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();
const client = new Client(config);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 健康檢查：打根目錄會看到 OK
app.get('/', (_, res) => res.send('OK'));

// LINE Webhook 入口（一定要是 /webhook）
app.post('/webhook', middleware(config), async (req, res) => {
  const events = req.body.events || [];
  await Promise.all(events.map(handleEvent));
  res.status(200).end();
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  const userText = event.message.text?.trim() || '';

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-5-turbo',
    messages: [
      { role: 'system', content: '你是專業、簡潔、友善的資安客服助理。' },
      { role: 'user', content: userText }
    ],
  });

  const answer = completion.choices?.[0]?.message?.content?.slice(0, 4900) || '（沒有產生內容）';
  return client.replyMessage(event.replyToken, { type: 'text', text: answer });
}

app.listen(process.env.PORT || 3000, () => {
  console.log('Server running on port', process.env.PORT || 3000);
});

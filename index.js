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


// 健康檢查
app.get('/', (_, res) => res.send('OK'));


// 接收 LINE Webhook 事件
app.post('/webhook', middleware(config), async (req, res) => {
const events = req.body.events || [];
await Promise.all(events.map(handleEvent));
res.status(200).end();
});


async function handleEvent(event) {
// 僅處理文字訊息
if (event.type !== 'message' || event.message.type !== 'text') return;


const userText = event.message.text?.trim() || '';


// 可選：關鍵字導向（先於 AI 回覆）
const routes = [
{ kw: /報價|價格|費用/, reply: '我們會請業務與您聯繫，請提供公司與聯絡電話，謝謝！' },
{ kw: /人工客服|真人/, reply: '已為您轉接人工客服，稍後將由同仁回覆。' },
];
for (const r of routes) {
if (r.kw.test(userText)) {
return client.replyMessage(event.replyToken, { type: 'text', text: r.reply });
}
}


// 呼叫 OpenAI 產生回覆
const completion = await openai.chat.completions.create({
model: process.env.OPENAI_MODEL || 'gpt-5-turbo',
messages: [
{ role: 'system', content: '你是專業、簡潔、友善的資安顧問客服助理。回答請條列化、可操作。' },
{ role: 'user', content: userText }
],
});


const answer = completion.choices?.[0]?.message?.content?.slice(0, 4900) || '（沒有產生內容）';


return client.replyMessage(event.replyToken, { type: 'text', text: answer });
}


// 啟動
app.listen(process.env.PORT || 3000, () => {
console.log('Server running on port', process.env.PORT || 3000);
});

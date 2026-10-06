require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const OpenAI = require('openai');
const fs = require('fs');

const app = express();
app.use(bodyParser.json({limit: '20mb'}));
app.use(require('cors')());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// === CONFIG 4 PAGES IDs ===
const PAGES = {
  '253869557819598': { name: 'ປຸ໋ຍຊີວະພາບກີ່ງຄຳ', token: process.env.PAGE_ACCESS_TOKEN_PAGE1, strategy: 'ALL_3_PRODUCTS' },
  '61559738783553':  { name: 'ປຸ໋ຍຊີວະພາບກີ່ງຄຳ', token: process.env.PAGE_ACCESS_TOKEN_PAGE1, strategy: 'ALL_3_PRODUCTS' },
  '371373162736359': { name: 'ປານີຢາງ', token: process.env.PAGE_ACCESS_TOKEN_PAGE2, strategy: 'FOCUS_PANEEYANG' },
  '61566219633681':  { name: 'ປານີຢາງ', token: process.env.PAGE_ACCESS_TOKEN_PAGE2, strategy: 'FOCUS_PANEEYANG' }
};

const conversations = new Map();
const masterPromptText = fs.existsSync('./MASTER_PROMPT.txt') ? fs.readFileSync('./MASTER_PROMPT.txt','utf8') : 'You are Admin AI of Okham Store, Lao and Hmong friendly.';

function detectLanguage(text){
  const lower = (text||'').toLowerCase();
  if (lower.includes('nyob') || lower.includes('koj') || lower.includes('kuv')) return 'hmong';
  return 'lo';
}

async function callAI(psid, pageId, userText){
  const page = PAGES[pageId] || {name:'Okham', strategy:'ALL_3_PRODUCTS'};
  const conv = conversations.get(psid) || {history:[], pageId};
  const detectedLang = detectLanguage(userText);

  const systemPrompt = `
${masterPromptText}

[CONTEXT]
- Page: ${page.name} (ID: ${pageId}) Strategy: ${page.strategy}
- ลูกค้าใช้ภาษา: ${detectedLang} -> ต้องตอบภาษานี้ (ลาว หรือ ม้ง)
- ประวัติคุยล่าสุด: ${JSON.stringify(conv.history.slice(-6))}
- กฎ COD: รับได้เฉพาะ อานุสิด & รุ่งอรุณ เท่านั้น ห้ามเกียงไก COD
- ห้ามสร้างราคาเอง ใช้ราคาจริงจากระบบ
`;

  const messages = [
    {role:'system', content: systemPrompt},
    ...conv.history,
    {role:'user', content: userText}
  ];

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    temperature: 0.7
  });

  const reply = completion.choices[0].message.content;
  conv.history.push({role:'user', content:userText});
  conv.history.push({role:'assistant', content:reply});
  if (conv.history.length > 20) conv.history = conv.history.slice(-20);
  conversations.set(psid, conv);
  return reply;
}

async function sendMessage(psid, token, text){
  await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, {
    recipient: {id: psid},
    message: {text}
  });
}

// Verify
app.get('/webhook', (req,res)=>{
  if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN){
    res.send(req.query['hub.challenge']);
  } else res.sendStatus(403);
});

// Receive
app.post('/webhook', async (req,res)=>{
  const body = req.body;
  if (body.object === 'page'){
    for (const entry of body.entry){
      const pageId = entry.id;
      const pageConfig = PAGES[pageId];
      if (!pageConfig || !pageConfig.token) continue;
      for (const event of entry.messaging || []){
        const psid = event.sender?.id;
        if (!psid) continue;
        if (event.message && event.message.text){
          const userText = event.message.text;
          console.log(`[${pageConfig.name} ${pageId}] ${psid}: ${userText}`);
          try{
            const reply = await callAI(psid, pageId, userText);
            await sendMessage(psid, pageConfig.token, reply);
          }catch(e){
            console.error('AI error', e.message);
            await sendMessage(psid, pageConfig.token, 'ຂໍໂທດເດີ້ ລະບົບຂັດຂ້ອງໜ້ອຍໜຶ່ງ ລອງໃໝ່ອີກຄັ້ງ 🙏');
          }
        }
      }
    }
    res.sendStatus(200);
  } else res.sendStatus(404);
});

app.get('/', (req,res)=> res.send('Okham AI Agent Running - 4 Pages Ready'));

const port = process.env.PORT || 10000;
app.listen(port, ()=> console.log('Webhook running on', port));


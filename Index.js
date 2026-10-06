
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const OpenAI = require('openai');

const app = express();
app.use(bodyParser.json({limit: '20mb'}));
app.use(require('cors')());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// === CONFIG 2 PAGES - รองรับ ID เก่าและใหม่ 615... ===
const PAGES = {
  // ปุ๋ยชีวภาพกิ่งคำ - ID เก่า + ID ใหม่ที่เจ้าของให้มา
  '253869557819598': { name: 'ປຸ໋ຍຊີວະພາບກີ່ງຄຳ', token: process.env.PAGE_ACCESS_TOKEN_PAGE1, strategy: 'ALL_3_PRODUCTS', defaultLang: 'lo' },
  '61559738783553':  { name: 'ປຸ໋ຍຊີວະພາບກີ່ງຄຳ', token: process.env.PAGE_ACCESS_TOKEN_PAGE1, strategy: 'ALL_3_PRODUCTS', defaultLang: 'lo' },
  // ปานียาง - ID เก่า + ID ใหม่
  '371373162736359': { name: 'ປານີຢາງ', token: process.env.PAGE_ACCESS_TOKEN_PAGE2, strategy: 'FOCUS_PANEEYANG', defaultLang: 'lo' },
  '61566219633681':  { name: 'ປານີຢາງ', token: process.env.PAGE_ACCESS_TOKEN_PAGE2, strategy: 'FOCUS_PANEEYANG', defaultLang: 'lo' }
};

// === PRODUCT DATA ===
const PRODUCTS = {
  yangdee: { name: 'ປຸ໋ຍຢາງດີ', sizes: [{size:'500ml', price:400000, wholesale:'6,250,000/25ກ່ອງ'}, {size:'1000ml', price:600000, wholesale:'4,800,000/12ກ່ອງ'}], usage:'20ml/20L', freq:'15ມື້/ຄັ້ງ' },
  paneeyang: { name: 'ປຸ໋ຍປານີຢາງ', sizes: [{size:'1000ml', price:350000, wholesale:'3,000,000/12ກ່ອງ'}], usage:'ທາຮອບຮ່ອງກີດ ສົດ ຫຼື 1:1', freq:'15ມື້/ຄັ້ງ', focus: 'ນ້ຳຢາງອອກຫຼາຍ ໄຫຼດີ ຂີ້ຢາງແໜ້ນ' },
  kingkham: { name: 'ປຸ໋ຍກິ່ງຄຳ', sizes: [{size:'500ml', price:420000, wholesale:'6,750,000/25ກ່ອງ'}], usage:'20ml/20L', freq:'15ມື້/ຄັ້ງ' }
};

// In-memory conversation context (ໃຊ້ Redis ໃນ Production)
const conversations = new Map(); // key = PSID, value = {history, pageId, orderData, lang}

// === MASTER PROMPT (จากที่เจ้าของให้) ===
const MASTER_PROMPT = `
${open('/mnt/data/okham-master-prompt.txt','r',encoding='utf-8').read() if False else ''}
`;

// โหลด prompt จากไฟล์
const fs = require('fs');
const masterPromptText = fs.existsSync('./MASTER_PROMPT.txt') ? fs.readFileSync('./MASTER_PROMPT.txt','utf8') : 'You are Admin AI of Okham store';

function detectLanguage(text){
  const hmongKeywords = ['nyob zoo', 'koj', 'kuv', 'os', 'ua tsaug', 'xab npum', 'pua muaj', 'nqe', 'pes tsawg', 'thov txim', 'suab'];
  const lower = text.toLowerCase();
  const hmongScore = hmongKeywords.filter(k=> lower.includes(k)).length;
  // ถ้ามีคำม้งชัด หรือประโยคม้งล้วน ให้ตอบม้ง
  if (hmongScore >= 1 && /[a-z]/i.test(text)) {
    // เช็คว่าเป็นประโยคม้งหลักหรือไม่
    if (lower.includes('nyob') || lower.includes('koj') || lower.includes('kuv')) return 'hmong';
  }
  return 'lo';
}

async function transcribeAudio(audioUrl){
  // ดาวน์โหลดไฟล์เสียงจาก Facebook
  try {
    const resp = await axios.get(audioUrl, {responseType:'arraybuffer'});
    const file = require('fs').createWriteStream('/tmp/audio.mp3');
    // ใช้ Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: require('fs').createReadStream('/tmp/audio.mp3'),
      model: "whisper-1",
      language: "lo"
    });
    return transcription.text;
  } catch(e){
    console.error('transcribe error', e.message);
    return "[ສຽງບໍ່ຊັດເຈນ]";
  }
}

async function textToSpeech(text, lang){
  // ใช้ ElevenLabs หรือ OpenAI TTS
  // ตัวอย่าง OpenAI TTS
  try {
    const mp3 = await openai.audio.speech.create({
      model: "tts-1-hd",
      voice: "alloy", // เปลี่ยนเป็น voice id ของเจ้าของร้านที่โคลนไว้
      input: text
    });
    const buffer = Buffer.from(await mp3.arrayBuffer());
    // อัพโหลดไป CDN แล้วส่งกลับเป็น audio attachment
    return buffer;
  } catch(e){
    return null;
  }
}

async function callAI(psid, pageId, userText, isVoice=false){
  const page = PAGES[pageId];
  const conv = conversations.get(psid) || {history:[], order:{}, lang:'lo', pageId};
  conv.pageId = pageId;
  
  // จับภาษา
  const detectedLang = detectLanguage(userText);
  conv.lang = detectedLang;

  // สร้าง context สำหรับ AI
  const systemPrompt = `
${masterPromptText}

[CONTEXT ปัจจุบัน]
- ลูกค้าทักมาจาก Page: ${page.name} (ID: ${pageId}) Strategy: ${page.strategy}
- ภาษาที่ลูกค้าใช้ตอนนี้: ${detectedLang === 'hmong' ? 'Hmong' : 'ลาว'} -> ต้องตอบภาษานี้
- ประวัติการคุย: ${JSON.stringify(conv.history.slice(-6))}
- ข้อมูลออเดอร์ที่เก็บแล้ว: ${JSON.stringify(conv.order)}
- Input นี้มาจาก: ${isVoice ? 'เสียงลูกค้า (transcribed)' : 'ข้อความ'}
- ถ้าจะตอบเป็นเสียง ให้ตอบสั้น 2-3 ประโยค กระชับ อบอุ่น
- กฎ COD: รับได้เฉพาะ อานุสิด & รุ่งอรุณ เท่านั้น ห้ามรับ เกียงไก COD
- ห้ามสร้างราคา/โปรโมชั่นเอง

จงตอบในฐานะ Admin ตามกฎทั้งหมด
`;

  const messages = [
    {role:'system', content: systemPrompt},
    ...conv.history,
    {role:'user', content: userText}
  ];

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages,
    temperature: 0.7
  });

  const reply = completion.choices[0].message.content;
  conv.history.push({role:'user', content:userText});
  conv.history.push({role:'assistant', content:reply});
  conversations.set(psid, conv);
  
  return {reply, lang: detectedLang, conv};
}

async function sendMessage(psid, pageId, text, token, asVoice=false){
  if (asVoice){
    // ส่งเป็นเสียง
    const audioBuffer = await textToSpeech(text, 'lo');
    if (audioBuffer){
      // ส่งไฟล์เสียงผ่าน Send API
      // ต้องอัพโหลดก่อน - ย่อไว้
    }
  }
  // ส่งข้อความธรรมดา
  await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, {
    recipient: {id: psid},
    message: {text}
  });
}

// === WEBHOOK VERIFY ===
app.get('/webhook', (req,res)=>{
  if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN){
    res.send(req.query['hub.challenge']);
  } else res.sendStatus(403);
});

// === WEBHOOK RECEIVE ===
app.post('/webhook', async (req,res)=>{
  const body = req.body;
  if (body.object === 'page'){
    for (const entry of body.entry){
      const pageId = entry.id;
      const pageConfig = PAGES[pageId];
      if (!pageConfig) continue;
      for (const event of entry.messaging){
        const psid = event.sender.id;
        if (event.message){
          let userText = '';
          let isVoice = false;
          if (event.message.text){
            userText = event.message.text;
          } else if (event.message.attachments && event.message.attachments[0].type === 'audio'){
            isVoice = true;
            const audioUrl = event.message.attachments[0].payload.url;
            userText = await transcribeAudio(audioUrl);
          }
          if (!userText) continue;
          console.log(`[Page ${pageConfig.name}] ${psid}: ${userText}`);

          const {reply, lang, conv} = await callAI(psid, pageId, userText, isVoice);

          // ตัดสินใจว่าจะตอบเป็นเสียงเมื่อไหร่ - ตอบเสียงเป็นบางครั้งเพื่อความอบอุ่น ไม่ใช่ทุกครั้ง
          const shouldVoice = isVoice || /ขอบใจ|ออุ่นใจ|ดีใจ|โทษ/.test(reply) && Math.random() > 0.6;
          // ย่อ: ถ้า shouldVoice ให้ตอบสั้น 2-3 ประโยค
          let finalReply = reply;
          let voiceText = null;
          if (shouldVoice && reply.length > 150){
            // แยกประโยคสั้นสำหรับเสียง
            voiceText = reply.split('.')[0] + '.';
          } else if (shouldVoice){
            voiceText = reply;
          }

          await sendMessage(psid, pageId, finalReply, pageConfig.token, false);
          // ถ้ามี voiceText ส่งตามเป็นวอยซ์
          if (voiceText){
            // await sendVoice...
          }

          // บันทึกออเดอร์ลง Dashboard / DB ตรงนี้
          // saveOrderToDB(psid, conv.order, pageId, lang)
        }
      }
    }
    res.sendStatus(200);
  } else res.sendStatus(404);
});

// === ADS STRATEGY ENDPOINT (สำหรับเจ้าของร้านสั่ง) ===
app.post('/ads/plan', async (req,res)=>{
  const {pageId, objective, budget} = req.body; // objective: Engagement/Sales/Leads
  const prompt = `
คุณคือผู้เชี่ยวชาญยิงแอด Meta สำหรับร้านโอคำ ขายปุ๋ยยางพารา 3 ตัว
Page: ${PAGES[pageId]?.name}
Objective: ${objective}
Budget: ${budget}
จงวางแผน:
1. Campaign Objective ที่แนะนำ
2. Core Audience: จังหวัดปลูกยางในลาว, อายุ 25-55, ความสนใจ
3. Custom Audience: retarget คนทักแชท ดูวิดีโอ 50%
4. Lookalike 1-3%
5. Ad Copy: Hook/Body/CTA แยกภาษาลาว/ม้ง
ตอบเป็น JSON
`;
  const completion = await openai.chat.completions.create({model:'gpt-4o', messages:[{role:'user', content:prompt}]});
  res.json({plan: completion.choices[0].message.content});
});

app.get('/', (req,res)=> res.send('Okham AI Agent Webhook Running - 2 Pages Lao+Hmong'));

app.listen(process.env.PORT||3000, ()=> console.log('Webhook running port', process.env.PORT||3000));

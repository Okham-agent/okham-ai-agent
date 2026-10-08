require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const OpenAI = require('openai');
const fs = require('fs');

const app = express();
app.use(bodyParser.json({limit: '20mb'}));
app.use(require('cors')());

let openai = null;
let useGemini = false;
try {
  if (process.env.GEMINI_API_KEY) {
    useGemini = true;
    console.log('Using Gemini API (Free) - Key found');
  }
  if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } else if (!useGemini) {
    console.warn('WARNING: No AI Key set');
  }
} catch(e){
  console.error('Failed to init AI:', e.message);
}

async function callGemini(systemPrompt, history, userText){
  const apiKey = process.env.GEMINI_API_KEY;
  // Auto-discover available models first
  const contents = [];
  for (const h of history.slice(-10)){
    if (!h.content) continue;
    contents.push({role: h.role === 'assistant' ? 'model' : 'user', parts: [{text: String(h.content).substring(0,2000)}]});
  }
  contents.push({role:'user', parts:[{text: String(userText).substring(0,2000)}]});
  
  // List from Google suggestion + 2025-2026 models
  const modelsToTry = [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash-lite',
    'gemini-2.0-flash-exp',
    'gemini-1.5-flash-8b',
    'gemini-1.5-flash-8b-latest',
    'gemini-2.0-flash-thinking-exp',
    'gemini-3.8-flash', // as suggested by API error
    'gemini-1.5-flash',
    'gemini-1.5-flash-latest'
  ];

  // Try to get real list from API
  try {
    const listRes = await axios.get(`https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`);
    const available = listRes.data.models?.filter(m => m.supportedGenerationMethods?.includes('generateContent')).map(m => m.name.replace('models/','')) || [];
    console.log('Available Gemini models:', available);
    if (available.length > 0) {
      // Prioritize flash models
      const flashModels = available.filter(n => n.includes('flash'));
      if (flashModels.length > 0) {
        modelsToTry.unshift(...flashModels.slice(0,3));
      } else {
        modelsToTry.unshift(...available.slice(0,3));
      }
    }
  } catch(e) {
    console.error('ListModels failed:', e.message);
  }

  // Deduplicate
  const uniqueModels = [...new Set(modelsToTry)];

  let lastError = null;
  for (const model of uniqueModels){
    try{
      const res = await axios.post(`https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${apiKey}`, {
        contents,
        systemInstruction: {parts: [{text: systemPrompt.substring(0,8000)}]},
        generationConfig: {temperature: 0.7, maxOutputTokens: 1000}
      });
      const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        console.error(`Gemini ${model} empty`, JSON.stringify(res.data).substring(0,500));
        continue;
      }
      console.log(`Gemini success with model ${model}`);
      return text;
    }catch(e){
      lastError = e;
      const msg = e.response?.data?.error?.message || e.message;
      console.error(`Gemini model ${model} failed:`, msg.substring(0,300));
    }
  }
  throw lastError || new Error('All Gemini models failed');
}

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

  let reply = '';

  // Use Gemini if available (Free)
  if (process.env.GEMINI_API_KEY){
    try{
      reply = await callGemini(systemPrompt, conv.history, userText);
    }catch(e){
      console.error('Gemini error', e.response?.data || e.message);
      // fallback to OpenAI if Gemini fails
      if (openai){
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
        reply = completion.choices[0].message.content;
      } else {
        throw e;
      }
    }
  } else {
    if (!openai){
      throw new Error('No AI Key configured');
    }
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
    reply = completion.choices[0].message.content;
  }

  conv.history.push({role:'user', content:userText});
  conv.history.push({role:'assistant', content:reply});
  if (conv.history.length > 20) conv.history = conv.history.slice(-20);
  conversations.set(psid, conv);
  return reply;
}

async function sendMessage(psid, token, text){
  try {
    console.log(`Sending to ${psid}: ${text.substring(0,50)}...`);
    const res = await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, {
      recipient: {id: psid},
      message: {text}
    });
    console.log('Send success:', res.data.message_id);
    return res.data;
  } catch(e){
    console.error('SendMessage FAILED:', e.response?.data || e.message);
    throw e;
  }
}

// Verify
app.get('/webhook', (req,res)=>{
  console.log('Webhook Verify attempt:', req.query['hub.verify_token']);
  if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN){
    console.log('Verify SUCCESS');
    res.send(req.query['hub.challenge']);
  } else {
    console.log('Verify FAILED - expected:', process.env.VERIFY_TOKEN);
    res.sendStatus(403);
  }
});

// DEBUG ENDPOINTS
app.get('/debug', (req,res)=>{
  res.json({
    status: 'Okham AI Agent Running',
    has_gemini: !!process.env.GEMINI_API_KEY,
    has_openai: !!process.env.OPENAI_API_KEY,
    has_page1: !!process.env.PAGE_ACCESS_TOKEN_PAGE1,
    has_page2: !!process.env.PAGE_ACCESS_TOKEN_PAGE2,
    has_verify: !!process.env.VERIFY_TOKEN,
    verify_token: process.env.VERIFY_TOKEN || 'NOT SET',
    pages: Object.keys(PAGES),
    time: new Date().toISOString()
  });
});

app.get('/test-gemini', async (req,res)=>{
  try{
    if (!process.env.GEMINI_API_KEY) return res.send('No GEMINI_API_KEY set');
    const reply = await callGemini('You are helpful assistant', [], 'Say hello in Lao');
    res.send('Gemini OK: ' + reply);
  }catch(e){
    res.send('Gemini FAILED: ' + (e.response?.data ? JSON.stringify(e.response.data) : e.message));
  }
});

app.get('/test-page-token', async (req,res)=>{
  const token = process.env.PAGE_ACCESS_TOKEN_PAGE1;
  if (!token) return res.send('No PAGE_ACCESS_TOKEN_PAGE1');
  try{
    const r = await axios.get(`https://graph.facebook.com/v19.0/me?access_token=${token}`);
    res.json({ok:true, page: r.data});
  }catch(e){
    res.json({ok:false, error: e.response?.data || e.message});
  }
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



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
try {
  if (process.env.GEMINI_API_KEY) console.log('Using Gemini API (Free) - Key found');
  if (process.env.OPENAI_API_KEY) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
} catch(e){ console.error('Init error', e.message); }

async function callGemini(systemPrompt, history, userText){
  const apiKey = process.env.GEMINI_API_KEY;
  const contents = [];
  for (const h of history.slice(-6)){
    if (!h.content) continue;
    contents.push({role: h.role === 'assistant' ? 'model' : 'user', parts: [{text: String(h.content).substring(0,1500)}]});
  }
  contents.push({role:'user', parts:[{text: String(userText).substring(0,1500)}]});
  
  const modelsToTry = [
    'gemini-2.5-flash-lite',
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-2.5-flash',
    'gemini-3.8-flash',
    'gemini-2.5-pro',
  ];

  try {
    const listRes = await axios.get(`https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`);
    const available = listRes.data.models?.filter(m => m.supportedGenerationMethods?.includes('generateContent')).map(m => m.name.replace('models/','')) || [];
    console.log('Available Gemini models:', available.slice(0,30));
    const preferred = available.filter(n => n.includes('flash-lite') && !n.includes('image'));
    if (preferred.length>0) modelsToTry.unshift(...preferred.slice(0,3));
  } catch(e){ console.error('ListModels failed', e.message); }

  const unique = [...new Set(modelsToTry)];
  for (const model of unique){
    try{
      console.log(`Trying Gemini model ${model}...`);
      const res = await axios.post(`https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${apiKey}`, {
        contents,
        systemInstruction: {parts: [{text: systemPrompt.substring(0,6000)}]},
        generationConfig: {temperature: 0.7, maxOutputTokens: 800}
      }, {timeout: 20000});
      const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) continue;
      console.log(`Gemini success with ${model}`);
      return text;
    }catch(e){
      const msg = e.response?.data?.error?.message || e.message;
      const code = e.response?.status;
      console.error(`Model ${model} failed [${code}]: ${msg.substring(0,500)}`);
      if (msg.includes('high demand') || msg.includes('overloaded') || code==503 || code==429){
        await new Promise(r=>setTimeout(r, 3500));
        try{
          const res2 = await axios.post(`https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${apiKey}`, {
            contents,
            systemInstruction: {parts: [{text: systemPrompt.substring(0,6000)}]},
            generationConfig: {temperature: 0.7, maxOutputTokens: 800}
          }, {timeout:20000});
          const t2 = res2.data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (t2){ console.log(`Retry success ${model}`); return t2; }
        }catch(e2){ console.error(`Retry ${model} failed: ${e2.message}`); }
      }
      if (msg.includes('quota') || msg.includes('Quota')){
        await new Promise(r=>setTimeout(r, 2000));
      }
    }
  }
  throw new Error('All Gemini models failed');
}

function getFallbackReply(userText, lang){
  const lower = userText.toLowerCase();
  if (lower.includes('ລາຄາ') || lower.includes('ເທົ່າໃດ') || lower.includes('price') || lower.includes('nqi')){
    return lang==='hmong' ? `Nyob zoo! Puaj Ginger 1 pob 120,000 kip, 2 pob 200,000 kip xa dawb! Koj xav tau pes tsawg? 🙏` : `ສະບາຍດີເຈົ້າ! 🙏\n\nປຸ໋ຍຂີງກີ່ງຄຳ:\n• 1 ຊອງ 120,000 ກີບ\n• 2 ຊອງ 200,000 ກີບ ສົ່ງຟຣີ!\n\nປຸ໋ຍນ້ຳກ້ວຍ: 2 ຂວດ 150,000 ກີບ\n\nສົນໃຈໂຕໃດເຈົ້າ?`;
  }
  return lang==='hmong' ? `Nyob zoo! Ua tsaug koj hu tuaj. Peb muaj puaj zoo heev. Koj xav paub dab tsi? 😊` : `ສະບາຍດີເຈົ້າ! 🙏 ຂອບໃຈທີ່ທັກມາຫາຮ້ານອົກຄຳ\n\nມີປຸ໋ຍຊີວະພາບກີ່ງຄຳ ປຸ໋ຍນ້ຳກ້ວຍ ປານີຢາງ ພ້ອມສົ່ງ!\n\nລູກຄ້າສົນໃຈໂຕໃດ? 😊`;
}

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
  const systemPrompt = `${masterPromptText}\n[CONTEXT] Page: ${page.name} Lang:${detectedLang} History:${JSON.stringify(conv.history.slice(-4))}`;
  let reply = '';
  let usedAI = false;
  if (process.env.GEMINI_API_KEY){
    try{ reply = await callGemini(systemPrompt, conv.history, userText); usedAI = true; }
    catch(e){ console.error('Gemini final fail', e.message); }
  }
  if (!usedAI || !reply){
    if (openai){
      try{
        const messages = [{role:'system', content: systemPrompt}, ...conv.history.slice(-6), {role:'user', content: userText}];
        const c = await openai.chat.completions.create({model:"gpt-4o-mini", messages, temperature:0.7});
        reply = c.choices[0].message.content; usedAI = true;
      }catch(e2){ console.error('OpenAI fail', e2.message); }
    }
  }
  if (!usedAI || !reply){
    console.log('Using FALLBACK');
    reply = getFallbackReply(userText, detectedLang);
  }
  conv.history.push({role:'user', content:userText});
  conv.history.push({role:'assistant', content:reply});
  if (conv.history.length>12) conv.history = conv.history.slice(-12);
  conversations.set(psid, conv);
  return reply;
}

async function sendMessage(psid, token, text){
  const res = await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, {
    recipient:{id:psid}, message:{text: text.substring(0,1900)}
  });
  console.log('Send success', res.data.message_id);
  return res.data;
}

app.get('/webhook', (req,res)=>{
  if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) res.send(req.query['hub.challenge']);
  else res.sendStatus(403);
});

app.get('/debug', (req,res)=> res.json({
  status:'Okham v4 Fixed',
  has_gemini: !!process.env.GEMINI_API_KEY,
  has_openai: !!process.env.OPENAI_API_KEY,
  has_page1: !!process.env.PAGE_ACCESS_TOKEN_PAGE1,
  has_page2: !!process.env.PAGE_ACCESS_TOKEN_PAGE2,
  time: new Date().toISOString()
}));

app.get('/test-gemini', async (req,res)=>{
  try{
    if (!process.env.GEMINI_API_KEY) return res.send('No GEMINI_API_KEY');
    const r = await callGemini('You are helpful assistant, reply in Lao', [], 'ສະບາຍດີ');
    res.send('Gemini OK: '+r);
  }catch(e){ res.send('Gemini FAILED: '+(e.response?.data?JSON.stringify(e.response.data):e.message).substring(0,1500)); }
});

app.post('/webhook', async (req,res)=>{
  const body = req.body;
  console.log('Webhook hit', JSON.stringify(body).substring(0,800));
  if (body.object==='page'){
    for (const entry of body.entry){
      const pageId = entry.id;
      const pageConfig = PAGES[pageId];
      if (!pageConfig || !pageConfig.token){ console.log('No config for '+pageId); continue; }
      for (const event of entry.messaging||[]){
        const psid = event.sender?.id;
        if (!psid || psid===pageId) continue;
        if (event.message && event.message.text){
          const userText = event.message.text;
          console.log(`[${pageConfig.name} ${pageId}] ${psid}: ${userText}`);
          try{
            const reply = await callAI(psid, pageId, userText);
            await sendMessage(psid, pageConfig.token, reply);
          }catch(e){
            console.error('AI error', e.message);
            try{ await sendMessage(psid, pageConfig.token, getFallbackReply(userText, detectLanguage(userText))); }catch(e2){ console.error('Fallback send fail', e2.message); }
          }
        }
      }
    }
    res.sendStatus(200);
  } else res.sendStatus(404);
});

app.get('/', (req,res)=> res.send('Okham AI Agent v4 - Gemini Fixed - Ready'));

const port = process.env.PORT || 10000;
app.listen(port, ()=> console.log('Webhook running on', port));


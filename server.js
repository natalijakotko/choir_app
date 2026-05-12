const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const fetch = require('node-fetch');
const crypto = require('crypto');
const fs = require('fs');

const TOKEN   = process.env.BOT_TOKEN;
const APP_URL = process.env.APP_URL;
const PORT    = process.env.PORT || 3000;

if (!TOKEN)   throw new Error('BOT_TOKEN is required');
if (!APP_URL) throw new Error('APP_URL is required');

// ── Storage (JSON file) ──────────────────────────
const DB_PATH = '/tmp/choir_files.json';

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return {}; }
}
function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data), 'utf8');
}

// ── Bot ─────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });

const AUDIO_MIME = new Set([
  'audio/mpeg','audio/mp4','audio/wav','audio/ogg',
  'audio/flac','audio/aac','audio/x-m4a','audio/webm',
]);

async function handleAudio(msg, audio) {
  const userId = String(msg.from.id);
  const name   = audio.file_name || audio.title || 'Аудио';

  const db = loadDB();
  if (!db[userId]) db[userId] = [];
  db[userId].unshift({ id: Date.now(), file_id: audio.file_id, name, duration: audio.duration || 0 });
  saveDB(db);

  await bot.sendMessage(userId, `✅ *${name}* добавлен в плеер`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{ text: '🎵 Открыть плеер', web_app: { url: APP_URL } }]],
    },
  });
}

bot.on('audio',    msg => handleAudio(msg, msg.audio));
bot.on('document', msg => {
  const doc = msg.document;
  if (doc.mime_type && AUDIO_MIME.has(doc.mime_type))
    handleAudio(msg, { ...doc, title: doc.file_name });
});
bot.on('message', msg => {
  if (msg.audio || msg.document) return;
  bot.sendMessage(msg.chat.id, 'Привет! 🎶 Перешли аудио-файл — он появится в плеере.');
});

// ── API ─────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

function validateInitData(raw) {
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const checkStr = [...params.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const computed = crypto.createHmac('sha256', secret).update(checkStr).digest('hex');
  if (computed !== hash) return null;
  try { return JSON.parse(params.get('user')); } catch { return null; }
}

function auth(req, res) {
  const user = validateInitData(req.headers['x-init-data']);
  if (!user) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  return user;
}

app.get('/api/files', (req, res) => {
  const user = auth(req, res); if (!user) return;
  const db = loadDB();
  res.json(db[String(user.id)] || []);
});

app.delete('/api/files/:id', (req, res) => {
  const user = auth(req, res); if (!user) return;
  const db = loadDB();
  const uid = String(user.id);
  if (db[uid]) db[uid] = db[uid].filter(f => String(f.id) !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

app.get('/api/audio/:fileId', async (req, res) => {
  const user = auth(req, res); if (!user) return;
  try {
    const info = await bot.getFile(req.params.fileId);
    const tgUrl = `https://api.telegram.org/file/bot${TOKEN}/${info.file_path}`;
    const headers = {};
    if (req.headers.range) headers['Range'] = req.headers.range;
    const upstream = await fetch(tgUrl, { headers });
    res.set('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
    res.set('Accept-Ranges', 'bytes');
    res.set('Access-Control-Allow-Origin', '*');
    const cl = upstream.headers.get('content-length');
    const cr = upstream.headers.get('content-range');
    if (cl) res.set('Content-Length', cl);
    if (cr) { res.set('Content-Range', cr); res.status(206); }
    upstream.body.pipe(res);
  } catch (err) {
    console.error('Audio proxy error:', err.message);
    res.status(500).send('Ошибка получения файла');
  }
});

app.listen(PORT, () => console.log(`Choir bot running on port ${PORT}`));

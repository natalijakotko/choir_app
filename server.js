const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const Database = require('better-sqlite3');
const fetch = require('node-fetch');
const crypto = require('crypto');

const TOKEN   = process.env.BOT_TOKEN;
const APP_URL = process.env.APP_URL;
const PORT    = process.env.PORT || 3000;

if (!TOKEN)   throw new Error('BOT_TOKEN is required');
if (!APP_URL) throw new Error('APP_URL is required');

// ── DB ──────────────────────────────────────────
const db = new Database('data.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT    NOT NULL,
    file_id    TEXT    NOT NULL,
    name       TEXT,
    duration   INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  )
`);

// ── Bot ─────────────────────────────────────────
fetch(`https://api.telegram.org/bot${TOKEN}/deleteWebhook?drop_pending_updates=true`)
  .catch(e => console.error('deleteWebhook error:', e.message));

const bot = new TelegramBot(TOKEN, { polling: { interval: 2000, autoStart: true } });
bot.on('polling_error', err => console.error('polling_error:', err.message));
process.on('uncaughtException', err => console.error('uncaughtException:', err.message));
process.on('unhandledRejection', err => console.error('unhandledRejection:', err));

const AUDIO_MIME = new Set([
  'audio/mpeg','audio/mp4','audio/wav','audio/ogg',
  'audio/flac','audio/aac','audio/x-m4a','audio/webm',
]);

async function handleAudio(msg, audio) {
  const userId = String(msg.from.id);
  const name   = audio.file_name || audio.title || 'Аудио';

  db.prepare(
    'INSERT INTO files (user_id, file_id, name, duration) VALUES (?, ?, ?, ?)'
  ).run(userId, audio.file_id, name, audio.duration || 0);

  await bot.sendMessage(userId, `✅ *${name}* добавлен в плеер`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{
        text: '🎵 Открыть плеер',
        web_app: { url: APP_URL },
      }]],
    },
  });
}

bot.on('audio',    msg => handleAudio(msg, msg.audio));
bot.on('document', msg => {
  const doc = msg.document;
  if (doc.mime_type && AUDIO_MIME.has(doc.mime_type)) {
    handleAudio(msg, { ...doc, title: doc.file_name });
  }
});
bot.on('message', msg => {
  if (msg.audio || msg.document) return;
  bot.sendMessage(
    msg.chat.id,
    'Привет! 🎶 Перешли или отправь аудио-файл — он появится в плеере.',
  );
});

// ── API ─────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Validate Telegram WebApp initData → returns user object or null
function validateInitData(raw) {
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const hash   = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const checkStr = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret  = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const computed = crypto.createHmac('sha256', secret).update(checkStr).digest('hex');
  if (computed !== hash) return null;

  try { return JSON.parse(params.get('user')); }
  catch { return null; }
}

function auth(req, res) {
  const user = validateInitData(req.headers['x-init-data']);
  if (!user) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  return user;
}

// GET /api/files — list user's files
app.get('/api/files', (req, res) => {
  const user = auth(req, res); if (!user) return;
  const files = db.prepare(
    'SELECT id, file_id, name, duration FROM files WHERE user_id = ? ORDER BY created_at DESC'
  ).all(String(user.id));
  res.json(files);
});

// DELETE /api/files/:id — remove a file
app.delete('/api/files/:id', (req, res) => {
  const user = auth(req, res); if (!user) return;
  db.prepare('DELETE FROM files WHERE id = ? AND user_id = ?').run(req.params.id, String(user.id));
  res.json({ ok: true });
});

// GET /api/audio/:fileId — proxy audio from Telegram with CORS headers
app.get('/api/audio/:fileId', async (req, res) => {
  const user = auth(req, res); if (!user) return;

  try {
    const info   = await bot.getFile(req.params.fileId);
    const tgUrl  = `https://api.telegram.org/file/bot${TOKEN}/${info.file_path}`;
    const headers = {};
    if (req.headers.range) headers['Range'] = req.headers.range;

    const upstream = await fetch(tgUrl, { headers });

    res.set('Content-Type',  upstream.headers.get('content-type') || 'audio/mpeg');
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

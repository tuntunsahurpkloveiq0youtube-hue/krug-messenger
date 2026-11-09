/**
 * Круг — маленький мессенджер для друзей.
 * Без внешних зависимостей: Node.js + HTTP + SSE + JSON-файл.
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.KRUG_DATA ? path.resolve(process.env.KRUG_DATA) : path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || '0.0.0.0';
const ACCESS_CODE = (process.env.FRIENDS_CODE || '').trim();

/* версия сборки: видно на экране входа и по /api/version — по ней проверяют, обновился ли деплой */
const APP_VERSION = 4;
const FEATURES = [
  'rooms', 'dm', 'presence', 'typing', 'uploads', 'email', 'pwa', 'calls',
  'password', 'replies', 'reactions', 'edit', 'voice', 'profile', 'theme', 'turn', 'chat-info', 'search',
];

/* вход по почте: либо Resend, либо демо-режим с кодом на экране */
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const MAIL_FROM = (process.env.MAIL_FROM || 'Круг <onboarding@resend.dev>').trim();
const DEV_MAIL = process.env.KRUG_DEV_MAIL === '1';
const EMAIL_AUTH = Boolean(RESEND_API_KEY) || DEV_MAIL;
const CODE_TTL = 10 * 60 * 1000;
const CODE_COOLDOWN = 60 * 1000;
const CODE_MAX_PER_HOUR = 5;

/* TURN-сервер: нужен, чтобы звонки проходили между разными сетями */
const TURN_URLS = (process.env.TURN_URLS || process.env.TURN_URL || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const TURN_USERNAME = (process.env.TURN_USERNAME || '').trim();
const TURN_CREDENTIAL = (process.env.TURN_CREDENTIAL || '').trim();

function iceServers() {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (TURN_URLS.length) {
    const turn = { urls: TURN_URLS };
    if (TURN_USERNAME) turn.username = TURN_USERNAME;
    if (TURN_CREDENTIAL) turn.credential = TURN_CREDENTIAL;
    list.push(turn);
  }
  return list;
}

const MAX_TEXT = 4000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_AVATAR_BYTES = 1024 * 1024;
const MAX_STATUS = 140;
const CONV_CAP = 2000;
const HISTORY_DEFAULT = 50;
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

/* ограничение частоты по адресу клиента — для входа и чувствительных ручек */
const AUTH_WINDOW = 10 * 60 * 1000;
const AUTH_MAX = 30;

const PALETTE = [
  '#7c8cff', '#a78bfa', '#f472b6', '#fb7185', '#fb923c',
  '#fbbf24', '#34d399', '#2dd4bf', '#38bdf8', '#60a5fa',
];

const CSP =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; " +
  "base-uri 'none'; frame-ancestors 'none'";

/* ────────────────────────────  ДАННЫЕ  ──────────────────────────── */

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let db;
try {
  db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} catch {
  db = {};
}
db.users ??= {};
db.rooms ??= [];
db.messages ??= {};
db.reads ??= {};
db.dms ??= [];

if (!db.rooms.some((r) => r.id === 'room:general')) {
  db.rooms.unshift({ id: 'room:general', name: 'general', createdAt: Date.now(), createdBy: 'system' });
}

let saveTimer = null;
let saving = Promise.resolve();

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush();
  }, 200);
}

function flush() {
  const snapshot = JSON.stringify(db);
  saving = saving
    .then(async () => {
      const tmp = DB_FILE + '.tmp';
      await fsp.writeFile(tmp, snapshot);
      await fsp.rename(tmp, DB_FILE);
    })
    .catch((err) => console.error('[db] не удалось сохранить:', err.message));
  return saving;
}

function flushSync() {
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } catch (err) {
    console.error('[db] не удалось сохранить:', err.message);
  }
}

/* ────────────────────────────  ХЕЛПЕРЫ  ──────────────────────────── */

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function colorFor(key) {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/* ── пароли: scrypt из стандартной библиотеки, без внешних зависимостей ── */

const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const SCRYPT_KEYLEN = 32;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p,
  });
  return ['scrypt', SCRYPT_N, SCRYPT_r, SCRYPT_p, salt.toString('base64'), hash.toString('base64')].join('$');
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  let actual;
  try {
    actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p),
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function checkPassword(value) {
  const pw = String(value ?? '');
  if (pw.length < 6) throw httpError(400, 'Пароль — не короче 6 символов');
  if (pw.length > 100) throw httpError(400, 'Слишком длинный пароль');
  return pw;
}

/* ── лимит частоты по адресу клиента (вход, регистрация) ── */

const authHits = new Map(); // ip -> [ts]

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

function authRateLimit(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const arr = (authHits.get(ip) || []).filter((t) => now - t < AUTH_WINDOW);
  if (arr.length >= AUTH_MAX) throw httpError(429, 'Слишком много попыток входа. Подождите 10 минут');
  arr.push(now);
  authHits.set(ip, arr);
}

/* ── проверка файлов по сигнатуре, а не по заявленному типу ── */

function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.slice(0, 3).toString('latin1') === 'GIF') return 'gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

function sniffAudio(buf) {
  if (buf.length < 16) return null;
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WAVE') return 'wav';
  if (buf.slice(0, 4).toString('latin1') === 'OggS') return 'ogg';
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') return 'm4a';
  if (buf.slice(0, 3).toString('latin1') === 'ID3') return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  if (buf.slice(0, 4).toString('latin1') === 'fLaC') return 'flac';
  return null;
}

function dataUrlToBuffer(dataUrl, pattern) {
  const m = pattern.exec(String(dataUrl || ''));
  if (!m) return null;
  const payload = m[2] ?? m[1];
  if (!payload) return null;
  return Buffer.from(payload, 'base64');
}

/* ── публичные данные пользователя ── */

function publicUser(key) {
  const u = db.users[key];
  if (!u) return { key, name: key, color: '#64748b' };
  return {
    key,
    name: u.name,
    color: u.color,
    avatar: u.avatar || '',
    status: u.status || '',
    online: isOnline(key),
    lastSeen: u.lastSeen || 0,
  };
}

function broadcastUsers() {
  const users = Object.keys(db.users).map((k) => publicUser(k));
  broadcast({ type: 'users', users });
}

function isMuted(key, conv) {
  const u = db.users[key];
  return Boolean(u && u.mutes && u.mutes[conv]);
}

function setMuted(key, conv, on) {
  const u = db.users[key];
  if (!u) return;
  u.mutes ??= {};
  if (on) u.mutes[conv] = true;
  else delete u.mutes[conv];
}

/* ── почта ── */

function normEmail(raw) {
  const email = String(raw ?? '').trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email)) {
    throw httpError(400, 'Некорректный адрес почты');
  }
  return email;
}

function uniqueName(base) {
  const taken = new Set(Object.values(db.users).map((u) => u.name.toLowerCase()));
  const clean = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 20);
  const first = clean(base);
  if (first.length >= 2 && !taken.has(first.toLowerCase())) return first;
  for (let i = 2; i < 100; i++) {
    const cand = clean(`${base.slice(0, 17)} ${i}`);
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  return clean(`${base.slice(0, 15)} ${crypto.randomInt(10, 99)}`);
}

function nicknameFromEmail(email) {
  const local = email.split('@')[0] || '';
  let base = local.replace(/[^\p{L}\p{N} ._'-]/gu, '').replace(/\s+/g, ' ').trim();
  if (base.length < 2) base = 'Друг';
  return uniqueName(base);
}

async function sendLoginCode(email, code) {
  if (!RESEND_API_KEY) return; // демо-режим: код уходит в ответ API
  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: [email],
        subject: 'Код входа в «Круг»',
        text:
          `Код для входа в «Круг»: ${code}\n\n` +
          'Код действует 10 минут. Если вы не запрашивали вход, просто проигнорируйте письмо.',
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error('[mail]', err.message);
    throw httpError(502, 'Почтовый сервис не ответил. Попробуйте позже');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('[mail]', res.status, text.slice(0, 300));
    throw httpError(502, 'Не удалось отправить письмо. Проверьте настройки почты');
  }
}

function isOnline(key) {
  for (const s of sessions.values()) if (s.key === key && s.conns.size > 0) return true;
  return false;
}

function onlineList() {
  const seen = new Map();
  for (const s of sessions.values()) {
    if (s.conns.size === 0 || seen.has(s.key)) continue;
    const u = db.users[s.key];
    if (!u) continue;
    seen.set(s.key, { key: s.key, name: u.name, color: u.color });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

function dmId(a, b) {
  return 'dm:' + [a, b].sort().join('|');
}

function dmPartners(convId) {
  return convId.slice(3).split('|');
}

function assertMember(key, convId) {
  if (!convId) throw httpError(400, 'Не указан чат');
  if (convId === 'room:general' || convId.startsWith('room:')) {
    if (!db.rooms.some((r) => r.id === convId)) throw httpError(404, 'Канал не найден');
    return;
  }
  if (convId.startsWith('dm:')) {
    if (!dmPartners(convId).includes(key)) throw httpError(403, 'Это не ваш чат');
    return;
  }
  throw httpError(404, 'Чат не найден');
}

function convFilter(convId) {
  if (convId.startsWith('dm:')) {
    const parts = dmPartners(convId);
    return (s) => parts.includes(s.key);
  }
  return () => true;
}

function touchRead(key, convId, ts) {
  (db.reads[key] ??= {})[convId] = ts;
}

function unreadFor(key, convId) {
  const arr = db.messages[convId] || [];
  const read = (db.reads[key] || {})[convId] || 0;
  let n = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    if (m.ts <= read) break;
    if (m.fromKey !== key) n++;
  }
  return Math.min(n, 99);
}

function lastTs(convId) {
  const arr = db.messages[convId];
  return arr && arr.length ? arr[arr.length - 1].ts : 0;
}

/* ────────────────────────────  SSE / СЕССИИ  ──────────────────────────── */

const sessions = new Map(); // token -> { key, token, conns:Set<res> }
const rate = new Map();     // token -> [ts]
const loginCodes = new Map(); // email -> { code, exp, attempts, sent: [ts] }
const calls = new Map(); // callId -> { id, caller, callee, kind, state, createdAt, timer }

const CALL_RING_TIMEOUT = 45_000;

/* ────────────────────────────  ЗВОНКИ (сигналинг)  ──────────────────────────── */

function callOf(key) {
  for (const c of calls.values()) if (c.caller === key || c.callee === key) return c;
  return null;
}

function endCall(c) {
  if (c.timer) clearTimeout(c.timer);
  c.timer = null;
  calls.delete(c.id);
}

function callEvent(c, actor, extra) {
  const u = db.users[actor];
  broadcast(
    {
      type: 'call',
      callId: c.id,
      kind: c.kind,
      state: c.state,
      caller: c.caller,
      callee: c.callee,
      from: actor,
      fromName: u ? u.name : '',
      ...extra,
    },
    (s) => s.key === c.caller || s.key === c.callee,
  );
}

let presenceTimer = null;
function schedulePresence() {
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(() => {
    broadcast({ type: 'presence', online: onlineList() });
  }, 100);
}

function broadcast(payload, filter) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const s of sessions.values()) {
    if (filter && !filter(s)) continue;
    for (const res of s.conns) {
      try {
        res.write(data);
      } catch {
        /* соединение уже закрыто */
      }
    }
  }
}

function rateLimit(token) {
  const now = Date.now();
  const arr = (rate.get(token) || []).filter((t) => now - t < 10_000);
  if (arr.length >= 20) throw httpError(429, 'Слишком много сообщений, подождите немного');
  arr.push(now);
  rate.set(token, arr);
}

/* ────────────────────────────  HTTP  ──────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Не найдено');
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  const base = PUBLIC_DIR.toLowerCase() + path.sep;
  if (!file.toLowerCase().startsWith(base)) return notFound(res);

  let data;
  try {
    data = await fsp.readFile(file);
  } catch {
    return notFound(res);
  }
  const ext = path.extname(file).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': data.length,
  };
  if (ext === '.html') headers['Content-Security-Policy'] = CSP;
  res.writeHead(200, headers);
  res.end(data);
}

async function serveUpload(res, pathname) {
  const name = path.basename(pathname);
  if (!/^[a-f0-9]{16}\.(png|jpg|gif|webp|webm|ogg|m4a|mp3|flac)$/.test(name)) return notFound(res);
  let data;
  try {
    data = await fsp.readFile(path.join(UPLOAD_DIR, name));
  } catch {
    return notFound(res);
  }
  const ext = path.extname(name).toLowerCase();
  const AUDIO_MIME = {
    '.webm': 'audio/webm',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
  };
  res.writeHead(200, {
    'Content-Type': MIME[ext] || AUDIO_MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': data.length,
  });
  res.end(data);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];
    const fail = (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    };
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        fail(httpError(413, 'Слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(httpError(400, 'Некорректный JSON'));
      }
    });
    req.on('error', fail);
  });
}

function auth(req, url) {
  const token = req.headers['x-token'] || url.searchParams.get('token');
  const s = token && sessions.get(token);
  if (!s) throw httpError(401, 'Нужно войти заново');
  return s;
}

const IMAGE_DATA_URL = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/;
const AUDIO_DATA_URL = /^data:audio\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i;

async function storeFile(buf, ext) {
  const name = crypto.randomBytes(8).toString('hex') + '.' + ext;
  await fsp.writeFile(path.join(UPLOAD_DIR, name), buf);
  return '/uploads/' + name;
}

async function saveImage(dataUrl, maxBytes = MAX_IMAGE_BYTES, limitMessage = 'Картинка больше 5 МБ') {
  const buf = dataUrlToBuffer(dataUrl, IMAGE_DATA_URL);
  if (!buf) throw httpError(400, 'Поддерживаются PNG, JPEG, GIF и WebP');
  const ext = sniffImage(buf);
  if (!ext) throw httpError(400, 'Файл не похож на картинку');
  if (buf.length > maxBytes) throw httpError(413, limitMessage);
  return storeFile(buf, ext);
}

async function saveAudio(dataUrl) {
  const buf = dataUrlToBuffer(dataUrl, AUDIO_DATA_URL);
  if (!buf) throw httpError(400, 'Не удалось прочитать голосовое сообщение');
  const ext = sniffAudio(buf);
  if (!ext) throw httpError(400, 'Поддерживаются голосовые в WebM, OGG, M4A и MP3');
  if (buf.length > MAX_AUDIO_BYTES) throw httpError(413, 'Голосовое больше 8 МБ');
  return storeFile(buf, ext);
}

/* ────────────────────────────  МАРШРУТЫ  ──────────────────────────── */

async function handleApi(req, res, url, pathname) {
  const method = req.method;

  if (pathname === '/api/config' && method === 'GET') {
    return sendJson(res, 200, {
      codeRequired: Boolean(ACCESS_CODE),
      emailAuth: EMAIL_AUTH,
      passwordAuth: true,
      devMail: DEV_MAIL && !RESEND_API_KEY,
      version: APP_VERSION,
      rtc: { iceServers: iceServers() },
    });
  }

  if (pathname === '/api/health' && method === 'GET') {
    return sendJson(res, 200, { ok: true, uptime: process.uptime() });
  }

  if (pathname === '/api/version' && method === 'GET') {
    return sendJson(res, 200, { version: APP_VERSION, features: FEATURES, started: process.uptime() });
  }

  /* ── вход ── */
  /* ── вход по имени и паролю ── */
  if (pathname === '/api/join' && method === 'POST') {
    authRateLimit(req);
    const body = await readBody(req, 64 * 1024);
    const raw = String(body.name ?? '').trim().replace(/\s+/g, ' ');
    if (!/^[\p{L}\p{N} ._'-]{2,20}$/u.test(raw)) {
      throw httpError(400, 'Имя: 2–20 символов — буквы, цифры, пробел, точка, дефис');
    }
    if (ACCESS_CODE && String(body.code ?? '').trim() !== ACCESS_CODE) {
      throw httpError(403, 'Неверный код доступа');
    }
    const key = raw.toLowerCase();
    let user = db.users[key];
    const created = !user;

    if (created) {
      const pw = checkPassword(body.password);
      user = { name: raw, color: colorFor(key), createdAt: Date.now(), pass: hashPassword(pw) };
      db.users[key] = user;
    } else {
      // старым записям без пароля пароль задаётся при первом входе
      if (!user.pass) {
        const pw = checkPassword(body.password);
        user.pass = hashPassword(pw);
      } else if (!verifyPassword(String(body.password ?? ''), user.pass)) {
        throw httpError(401, 'Неверный пароль');
      }
    }

    user.lastSeen = Date.now();
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { key, token, conns: new Set() });
    save();
    return sendJson(res, 200, { token, created, me: publicUser(key) });
  }

  /* ── вход по почте: запросить код ── */
  if (pathname === '/api/auth/email' && method === 'POST') {
    if (!EMAIL_AUTH) throw httpError(404, 'Вход по почте не настроен');
    authRateLimit(req);
    const body = await readBody(req, 16 * 1024);
    if (ACCESS_CODE && String(body.code ?? '').trim() !== ACCESS_CODE) {
      throw httpError(403, 'Неверный код доступа');
    }
    const email = normEmail(body.email);
    const now = Date.now();

    const prev = loginCodes.get(email);
    const sent = (prev?.sent || []).filter((t) => now - t < 60 * 60 * 1000);
    const last = sent[sent.length - 1] || 0;
    if (now - last < CODE_COOLDOWN) {
      const wait = Math.ceil((CODE_COOLDOWN - (now - last)) / 1000);
      throw httpError(429, `Код уже отправлен. Повторить можно через ${wait} с`);
    }
    if (sent.length >= CODE_MAX_PER_HOUR) {
      throw httpError(429, 'Слишком много писем на этот адрес. Попробуйте через час');
    }

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    loginCodes.set(email, { code, exp: now + CODE_TTL, attempts: 0, sent: [...sent, now] });
    await sendLoginCode(email, code);
    const dev = !RESEND_API_KEY;
    return sendJson(res, 200, { ok: true, dev, ...(dev ? { code } : {}) });
  }

  /* ── вход по почте: проверить код ── */
  if (pathname === '/api/auth/verify' && method === 'POST') {
    if (!EMAIL_AUTH) throw httpError(404, 'Вход по почте не настроен');
    const body = await readBody(req, 16 * 1024);
    const email = normEmail(body.email);
    const code = String(body.code ?? '').trim();
    const entry = loginCodes.get(email);
    if (!entry || entry.exp < Date.now()) {
      loginCodes.delete(email);
      throw httpError(400, 'Код истёк или уже использован — запросите новый');
    }
    if (entry.attempts >= 5) {
      loginCodes.delete(email);
      throw httpError(429, 'Слишком много попыток — запросите новый код');
    }
    if (!/^\d{6}$/.test(code) || code !== entry.code) {
      entry.attempts += 1;
      throw httpError(400, 'Неверный код');
    }
    loginCodes.delete(email);

    let user = db.users[email];
    const created = !user;
    if (!user) {
      user = { name: nicknameFromEmail(email), color: colorFor(email), createdAt: Date.now(), email };
      db.users[email] = user;
    }
    user.lastSeen = Date.now();
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { key: email, token, conns: new Set() });
    save();
    return sendJson(res, 200, {
      token,
      created,
      me: { ...publicUser(email), email },
    });
  }

  const s = auth(req, url);

  if (pathname === '/api/state' && method === 'GET') {
    const key = s.key;
    const rooms = db.rooms.map((r) => ({
      id: r.id,
      name: r.name,
      unread: unreadFor(key, r.id),
      lastTs: lastTs(r.id),
      muted: isMuted(key, r.id),
    }));
    const dms = db.dms
      .filter((d) => d.keys.includes(key))
      .map((d) => {
        const otherKey = d.keys.find((k) => k !== key);
        const other = publicUser(otherKey);
        return {
          id: d.id,
          name: other.name,
          color: other.color,
          avatar: other.avatar,
          status: other.status,
          key: otherKey,
          online: other.online,
          unread: unreadFor(key, d.id),
          lastTs: lastTs(d.id),
          muted: isMuted(key, d.id),
          createdAt: d.createdAt || 0,
        };
      })
      .sort((a, b) => b.lastTs - a.lastTs);
    const users = Object.keys(db.users).map((k) => publicUser(k)).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const meUser = db.users[key];
    return sendJson(res, 200, {
      me: { ...publicUser(key), email: meUser.email || '', createdAt: meUser.createdAt || 0 },
      rooms,
      dms,
      users,
      online: onlineList(),
      reactions: REACTIONS,
    });
  }

  /* ── поток событий ── */
  if (pathname === '/api/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    s.conns.add(res);
    res.write(
      'data: ' +
        JSON.stringify({
          type: 'hello',
          online: onlineList(),
          me: publicUser(s.key),
        }) +
        '\n\n',
    );
    schedulePresence();
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      s.conns.delete(res);
      if (s.conns.size === 0) {
        const u = db.users[s.key];
        if (u) u.lastSeen = Date.now();
      }
      schedulePresence();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    return;
  }

  /* ── сообщения ── */
  if (pathname === '/api/messages' && method === 'GET') {
    const conv = url.searchParams.get('conv') || '';
    assertMember(s.key, conv);
    const all = db.messages[conv] || [];

    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    if (q) {
      if (q.length < 2) throw httpError(400, 'Для поиска нужно минимум 2 символа');
      const found = [];
      for (let i = all.length - 1; i >= 0 && found.length < 60; i--) {
        const m = all[i];
        if ((m.text || '').toLowerCase().includes(q)) found.push(m);
      }
      return sendJson(res, 200, { messages: found.reverse(), hasMore: false, query: q });
    }

    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || HISTORY_DEFAULT));
    const before = Number(url.searchParams.get('before')) || 0;
    const filtered = before ? all.filter((m) => m.ts < before) : all;
    const hasMore = filtered.length > limit;
    const messages = filtered.slice(-limit);
    return sendJson(res, 200, { messages, hasMore });
  }

  if (pathname === '/api/messages' && method === 'POST') {
    rateLimit(s.token);
    const body = await readBody(req);
    const conv = String(body.conv ?? '');
    assertMember(s.key, conv);
    let text = String(body.text ?? '').replace(/\r\n/g, '\n').trim();
    if (text.length > MAX_TEXT) throw httpError(400, `Сообщение длиннее ${MAX_TEXT} символов`);

    let image = null;
    if (body.image) image = await saveImage(body.image);

    let audio = null;
    let dur = 0;
    if (body.audio) {
      audio = await saveAudio(body.audio);
      dur = Math.min(600, Math.max(0, Math.round(Number(body.dur) || 0)));
    }

    if (!text && !image && !audio) throw httpError(400, 'Пустое сообщение');

    const msg = {
      id: crypto.randomBytes(8).toString('hex'),
      conv,
      from: db.users[s.key].name,
      fromKey: s.key,
      text,
      ts: Date.now(),
    };
    if (image) msg.image = image;
    if (audio) {
      msg.audio = audio;
      msg.dur = dur;
    }

    const replySource =
      typeof body.replyTo === 'string'
        ? body.replyTo
        : body.replyTo && body.replyTo.id
          ? String(body.replyTo.id)
          : '';
    if (replySource) {
      const src = (db.messages[conv] || []).find((m) => m.id === replySource);
      if (src) {
        msg.replyTo = {
          id: src.id,
          name: src.from,
          fromKey: src.fromKey,
          text: (src.text || '').slice(0, 160),
          image: Boolean(src.image),
          audio: Boolean(src.audio),
        };
      }
    }

    const arr = (db.messages[conv] ??= []);
    arr.push(msg);
    if (arr.length > CONV_CAP) arr.splice(0, arr.length - CONV_CAP);
    touchRead(s.key, conv, msg.ts);
    save();
    broadcast({ type: 'message', message: msg }, convFilter(conv));
    return sendJson(res, 200, { message: msg });
  }

  /* ── правка своего сообщения ── */
  const editMatch = /^\/api\/messages\/([a-f0-9]{16})$/.exec(pathname);
  if (editMatch && method === 'PATCH') {
    const body = await readBody(req, 64 * 1024);
    const conv = String(body.conv ?? '');
    assertMember(s.key, conv);
    const msg = (db.messages[conv] || []).find((m) => m.id === editMatch[1]);
    if (!msg) throw httpError(404, 'Сообщение не найдено');
    if (msg.fromKey !== s.key) throw httpError(403, 'Можно править только свои сообщения');
    const text = String(body.text ?? '').replace(/\r\n/g, '\n').trim();
    if (!text) throw httpError(400, 'Сообщение не может быть пустым');
    if (text.length > MAX_TEXT) throw httpError(400, `Сообщение длиннее ${MAX_TEXT} символов`);
    msg.text = text;
    msg.editedAt = Date.now();
    save();
    broadcast({ type: 'message-edited', conv, id: msg.id, text: msg.text, editedAt: msg.editedAt }, convFilter(conv));
    return sendJson(res, 200, { message: msg });
  }

  /* ── реакции ── */
  const reactMatch = /^\/api\/messages\/([a-f0-9]{16})\/react$/.exec(pathname);
  if (reactMatch && method === 'POST') {
    const body = await readBody(req, 16 * 1024);
    const conv = String(body.conv ?? '');
    assertMember(s.key, conv);
    const emoji = String(body.emoji ?? '');
    if (!REACTIONS.includes(emoji)) throw httpError(400, 'Такой реакции нет');
    const msg = (db.messages[conv] || []).find((m) => m.id === reactMatch[1]);
    if (!msg) throw httpError(404, 'Сообщение не найдено');
    msg.reactions ??= {};
    const list = msg.reactions[emoji] || [];
    const idx = list.indexOf(s.key);
    if (idx === -1) list.push(s.key);
    else list.splice(idx, 1);
    if (list.length) msg.reactions[emoji] = list;
    else delete msg.reactions[emoji];
    if (!Object.keys(msg.reactions).length) delete msg.reactions;
    save();
    broadcast({ type: 'message-reactions', conv, id: msg.id, reactions: msg.reactions || {} }, convFilter(conv));
    return sendJson(res, 200, { reactions: msg.reactions || {} });
  }

  const delMatch = /^\/api\/messages\/([a-f0-9]{16})$/.exec(pathname);
  if (delMatch && method === 'DELETE') {
    const conv = url.searchParams.get('conv') || '';
    assertMember(s.key, conv);
    const arr = db.messages[conv] || [];
    const idx = arr.findIndex((m) => m.id === delMatch[1]);
    if (idx === -1) throw httpError(404, 'Сообщение не найдено');
    if (arr[idx].fromKey !== s.key) throw httpError(403, 'Можно удалять только свои сообщения');
    arr.splice(idx, 1);
    save();
    broadcast({ type: 'message-deleted', conv, id: delMatch[1] }, convFilter(conv));
    return sendJson(res, 200, { ok: true });
  }

  /* ── прочитано ── */
  if (pathname === '/api/read' && method === 'POST') {
    const body = await readBody(req, 16 * 1024);
    const conv = String(body.conv ?? '');
    assertMember(s.key, conv);
    touchRead(s.key, conv, Date.now());
    save();
    return sendJson(res, 200, { ok: true });
  }

  /* ── печатает ── */
  if (pathname === '/api/typing' && method === 'POST') {
    const body = await readBody(req, 16 * 1024);
    const conv = String(body.conv ?? '');
    assertMember(s.key, conv);
    broadcast(
      { type: 'typing', conv, name: db.users[s.key].name, key: s.key },
      (other) => other.token !== s.token && convFilter(conv)(other),
    );
    return sendJson(res, 200, { ok: true });
  }

  /* ── каналы ── */
  if (pathname === '/api/rooms' && method === 'POST') {
    const body = await readBody(req, 64 * 1024);
    const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 30) throw httpError(400, 'Название канала: 2–30 символов');
    if (/[\u0000-\u001f\u007f]/.test(name)) throw httpError(400, 'Некорректное название');
    if (db.rooms.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
      throw httpError(409, 'Канал с таким названием уже есть');
    }
    const room = {
      id: 'room:' + crypto.randomBytes(4).toString('hex'),
      name,
      createdAt: Date.now(),
      createdBy: s.key,
    };
    db.rooms.push(room);
    touchRead(s.key, room.id, Date.now());
    save();
    broadcast({ type: 'rooms', rooms: db.rooms.map((r) => ({ id: r.id, name: r.name })) });
    return sendJson(res, 200, { room: { id: room.id, name: room.name, unread: 0, lastTs: 0 } });
  }

  /* ── личные сообщения ── */
  if (pathname === '/api/dm' && method === 'POST') {
    const body = await readBody(req, 64 * 1024);
    const otherKey = String(body.key ?? '').toLowerCase();
    const other = db.users[otherKey];
    if (!other || otherKey === s.key) throw httpError(404, 'Пользователь не найден');
    const id = dmId(s.key, otherKey);
    let dm = db.dms.find((d) => d.id === id);
    if (!dm) {
      dm = { id, keys: [s.key, otherKey].sort(), createdAt: Date.now() };
      db.dms.push(dm);
      save();
    }
    return sendJson(res, 200, {
      dm: {
        id,
        name: other.name,
        color: other.color,
        avatar: other.avatar || '',
        status: other.status || '',
        key: otherKey,
        online: isOnline(otherKey),
        unread: unreadFor(s.key, id),
        lastTs: lastTs(id),
        muted: isMuted(s.key, id),
        createdAt: dm.createdAt || 0,
      },
    });
  }

  /* ── профиль: статус и аватар ── */
  if (pathname === '/api/me' && method === 'POST') {
    const body = await readBody(req, 2 * 1024 * 1024);
    const user = db.users[s.key];
    if (!user) throw httpError(404, 'Пользователь не найден');

    if (body.status !== undefined) {
      const status = String(body.status ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
      if (status.length > MAX_STATUS) throw httpError(400, `Статус — до ${MAX_STATUS} символов`);
      user.status = status;
    }
    if (body.avatar !== undefined) {
      if (body.avatar === null || body.avatar === '') {
        user.avatar = '';
      } else {
        user.avatar = await saveImage(body.avatar, MAX_AVATAR_BYTES, 'Аватар больше 1 МБ');
      }
    }
    save();
    broadcastUsers();
    return sendJson(res, 200, { me: { ...publicUser(s.key), email: user.email || '' } });
  }

  /* ── отключить уведомления для чата ── */
  if (pathname === '/api/mute' && method === 'POST') {
    const body = await readBody(req, 16 * 1024);
    const conv = String(body.conv ?? '');
    assertMember(s.key, conv);
    setMuted(s.key, conv, Boolean(body.on));
    save();
    return sendJson(res, 200, { conv, muted: isMuted(s.key, conv) });
  }

  /* ── информация о чате ── */
  if (pathname === '/api/chat' && method === 'GET') {
    const conv = url.searchParams.get('conv') || '';
    assertMember(s.key, conv);
    const msgs = db.messages[conv] || [];

    if (conv.startsWith('room:')) {
      const room = db.rooms.find((r) => r.id === conv);
      if (!room) throw httpError(404, 'Канал не найден');
      const authors = new Map();
      for (const m of msgs) if (!authors.has(m.fromKey)) authors.set(m.fromKey, m.from);
      return sendJson(res, 200, {
        kind: 'room',
        id: room.id,
        name: room.name,
        createdAt: room.createdAt || 0,
        createdBy: room.createdBy === 'system' ? 'сервер' : (db.users[room.createdBy] || {}).name || '',
        messageCount: msgs.length,
        members: [...authors.entries()].map(([key, name]) => ({ key, name })),
        totalUsers: Object.keys(db.users).length,
        muted: isMuted(s.key, conv),
      });
    }

    const other = dmPartners(conv).find((k) => k !== s.key);
    const u = publicUser(other);
    const dm = db.dms.find((d) => d.id === conv);
    return sendJson(res, 200, {
      kind: 'dm',
      id: conv,
      name: u.name,
      color: u.color,
      avatar: u.avatar,
      status: u.status,
      createdAt: (dm && dm.createdAt) || 0,
      messageCount: msgs.length,
      firstMessageAt: msgs.length ? msgs[0].ts : 0,
      online: u.online,
      lastSeen: u.lastSeen,
      muted: isMuted(s.key, conv),
    });
  }

  /* ── звонки: сигналинг WebRTC ── */
  if (pathname === '/api/call' && method === 'POST') {
    const body = await readBody(req, 256 * 1024);
    const action = String(body.action || '');

    if (action === 'invite') {
      const to = String(body.to || '').toLowerCase();
      const other = db.users[to];
      if (!other || to === s.key) throw httpError(404, 'Пользователь не найден');
      if (callOf(s.key)) throw httpError(409, 'Вы уже разговариваете');
      if (callOf(to)) throw httpError(409, `${other.name} сейчас занят(а)`);
      if (!isOnline(to)) throw httpError(409, `${other.name} не в сети`);
      const kind = body.kind === 'video' ? 'video' : 'audio';
      const c = {
        id: crypto.randomBytes(8).toString('hex'),
        caller: s.key,
        callee: to,
        kind,
        state: 'ringing',
        createdAt: Date.now(),
        timer: null,
      };
      c.timer = setTimeout(() => {
        endCall(c);
        callEvent(c, c.caller, { action: 'timeout' });
      }, CALL_RING_TIMEOUT);
      if (c.timer.unref) c.timer.unref();
      calls.set(c.id, c);
      callEvent(c, s.key, { action: 'invite' });
      return sendJson(res, 200, { callId: c.id, state: c.state });
    }

    const c = calls.get(String(body.callId || ''));
    if (!c) throw httpError(409, 'Звонок уже завершён');
    if (c.caller !== s.key && c.callee !== s.key) throw httpError(403, 'Это не ваш звонок');

    if (action === 'accept') {
      if (s.key !== c.callee) throw httpError(403, 'Принять звонок может только собеседник');
      if (c.state !== 'ringing') throw httpError(409, 'Звонок уже принят');
      c.state = 'active';
      if (c.timer) clearTimeout(c.timer);
      c.timer = null;
      callEvent(c, s.key, { action: 'accept' });
      return sendJson(res, 200, { ok: true, state: c.state });
    }

    if (action === 'decline' || action === 'hangup') {
      endCall(c);
      callEvent(c, s.key, { action });
      return sendJson(res, 200, { ok: true });
    }

    if (action === 'offer' || action === 'answer') {
      const sdp = body.sdp;
      if (!sdp || typeof sdp !== 'object') throw httpError(400, 'Нет описания соединения');
      callEvent(c, s.key, { action, sdp });
      return sendJson(res, 200, { ok: true });
    }

    if (action === 'ice') {
      if (body.candidate) callEvent(c, s.key, { action: 'ice', candidate: body.candidate });
      return sendJson(res, 200, { ok: true });
    }

    throw httpError(400, 'Неизвестное действие');
  }

  throw httpError(404, 'Неизвестный метод API');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith('/api/')) return await handleApi(req, res, url, pathname);
    if (pathname.startsWith('/uploads/')) return await serveUpload(res, pathname);
    return await serveStatic(res, pathname);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[http]', req.method, req.url, err);
    if (!res.headersSent) {
      sendJson(res, status, { error: err.status ? err.message : 'Внутренняя ошибка сервера' });
    } else {
      res.end();
    }
  }
});

/* ────────────────────────────  ЖИЗНЕННЫЙ ЦИКЛ  ──────────────────────────── */

const heartbeat = setInterval(() => {
  for (const s of sessions.values()) {
    for (const res of s.conns) {
      try {
        res.write(': hb\n\n');
      } catch {
        /* ignore */
      }
    }
  }
  const now = Date.now();
  for (const [token, arr] of rate) {
    if (!arr.some((t) => now - t < 10_000)) rate.delete(token);
  }
  for (const [email, entry] of loginCodes) {
    if (entry.exp < now - 60 * 60 * 1000) loginCodes.delete(email);
  }
  for (const [ip, arr] of authHits) {
    if (!arr.some((t) => now - t < AUTH_WINDOW)) authHits.delete(ip);
  }
}, 25_000);
heartbeat.unref();

function shutdown() {
  clearInterval(heartbeat);
  flushSync();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  Порт ${PORT} уже занят — возможно, сервер уже запущен.`);
    console.error(`  Откройте http://localhost:${PORT}`);
    console.error(`  или запустите на другом порту:  set PORT=3211  &&  start.cmd`);
    console.error('');
  } else {
    console.error('[server]', err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  💬  Круг — мессенджер для друзей');
  console.log('');
  console.log(`  Локально:   http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  В сети:     http://${net.address}:${PORT}`);
      }
    }
  }
  if (ACCESS_CODE) console.log('  Вход по коду доступа включён.');
  if (EMAIL_AUTH) {
    console.log(
      RESEND_API_KEY
        ? `  Вход по почте включён (письма через Resend, от: ${MAIL_FROM}).`
        : '  Вход по почте в демо-режиме: код показывается на экране.',
    );
  }
  console.log('');
  console.log('  Ctrl+C — остановить сервер.');
  console.log('');
});

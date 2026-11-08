'use strict';

/* ─────────────────────────  УТИЛИТЫ  ───────────────────────── */

const $ = (sel) => document.querySelector(sel);

const fmtTime = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const fmtDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

const PALETTE = [
  '#7c8cff', '#a78bfa', '#f472b6', '#fb7185', '#fb923c',
  '#fbbf24', '#34d399', '#2dd4bf', '#38bdf8', '#60a5fa',
];

function initial(name) {
  const chars = Array.from(String(name || '').replace(/\s+/g, ''));
  return (chars[0] || '?').toUpperCase();
}

function colorForKey(key) {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function sameDay(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

function dayLabel(ts) {
  const now = Date.now();
  if (sameDay(ts, now)) return 'Сегодня';
  if (sameDay(ts, now - 86_400_000)) return 'Вчера';
  return fmtDate.format(new Date(ts));
}

function lastSeenText(key) {
  const u = userByKey(key);
  if (!u || !u.lastSeen) return 'не в сети';
  const ts = u.lastSeen;
  if (sameDay(ts, Date.now())) return 'был(а) в ' + fmtTime.format(new Date(ts));
  if (sameDay(ts, Date.now() - 86_400_000)) return 'был(а) вчера';
  return 'был(а) ' + fmtDate.format(new Date(ts));
}

function paintAvatar(node, name, color) {
  node.textContent = initial(name);
  node.style.background = color || '#64748b';
}

function userByKey(key) {
  return users.find((u) => u.key === key) || null;
}

function convMeta(id) {
  if (!id) return null;
  if (id.startsWith('room:')) return rooms.find((r) => r.id === id) || null;
  return dms.find((d) => d.id === id) || null;
}

function convTs(id) {
  const c = cache.get(id);
  if (c && c.messages.length) return c.messages[c.messages.length - 1].ts;
  const m = convMeta(id);
  return (m && m.lastTs) || 0;
}

function totalUnread() {
  let n = 0;
  for (const key of Object.keys(unread)) n += unread[key] || 0;
  return n;
}

function updateTitle() {
  const n = totalUnread();
  document.title = n ? `(${n}) Круг` : 'Круг';
}

/* ─────────────────────────  API  ───────────────────────── */

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (token) headers['x-token'] = token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* пустой ответ */
  }
  if (!res.ok) throw new Error((data && data.error) || `Ошибка ${res.status}`);
  return data;
}

/* ─────────────────────────  СОСТОЯНИЕ  ───────────────────────── */

let token = localStorage.getItem('fm_token');
let me = null;
let rooms = [];
let dms = [];
let users = [];
let online = new Set();
let unread = Object.create(null);
let active = null;
const cache = new Map(); // convId -> { messages: [], hasMore: boolean }
const typingState = new Map(); // convId -> { name, until }
const typingTimers = new Map();
const readTimers = new Map();
let es = null;
let soundOn = localStorage.getItem('fm_sound') !== 'off';
let audioCtx = null;
let lastTypingSent = 0;
let toastTimer = null;

/* ─────────────────────────  ЗВУК  ───────────────────────── */

function initAudio() {
  if (!audioCtx) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    } catch {
      audioCtx = null;
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}

function beep() {
  if (!soundOn) return;
  initAudio();
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(880, t);
  osc.frequency.exponentialRampToValueAtTime(620, t + 0.12);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.05, t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + 0.22);
}

function paintSound() {
  const btn = $('#sound-toggle');
  btn.textContent = soundOn ? '🔔' : '🔕';
  btn.title = soundOn ? 'Выключить звук' : 'Включить звук';
}

/* ─────────────────────────  ВХОД  ───────────────────────── */

async function boot() {
  let cfg = { codeRequired: false, emailAuth: false, devMail: false };
  try {
    cfg = { ...cfg, ...(await fetch('/api/config').then((r) => r.json())) };
  } catch {
    /* сервер проверяется ниже */
  }
  if (cfg.codeRequired) $('#code-wrap').hidden = false;
  if (cfg.emailAuth) setupEmailLogin();

  // PWA: service worker нужен для установки приложения (по http, кроме localhost, браузер его не даст)
  const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
  if (secure && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  if (!token) return;
  try {
    const st = await api('/api/state');
    enterApp(st);
  } catch {
    token = null;
    localStorage.removeItem('fm_token');
  }
}

/* ── вход по почте ── */

let emailTarget = '';
let resendTimer = null;

function hintDefault() {
  const p = $('#join-hint');
  p.textContent = '';
  p.append('Вход по имени или по почте.', document.createElement('br'));
  p.append('История хранится на этом сервере.');
}

function hintAfterSend(email, devCode) {
  const p = $('#join-hint');
  p.textContent = '';
  if (devCode) {
    p.append('Демо-режим: письмо не отправляется, код — ');
    const c = document.createElement('code');
    c.textContent = devCode;
    p.append(c);
  } else {
    p.append(`Код отправлен на ${email}.`);
    p.append(document.createElement('br'), 'Если письма нет — загляните в «Спам».');
  }
}

function setJoinPane(pane) {
  for (const tab of document.querySelectorAll('#join-tabs .tab')) {
    const on = tab.dataset.tab === pane;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', String(on));
  }
  $('#join-form').hidden = pane !== 'name';
  $('#email-form').hidden = pane !== 'email';
  $('#join-error').textContent = '';
  $('#email-error').textContent = '';
}

function setupEmailLogin() {
  $('#join-tabs').hidden = false;
  for (const tab of document.querySelectorAll('#join-tabs .tab')) {
    tab.addEventListener('click', () => setJoinPane(tab.dataset.tab));
  }
  $('#email-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if ($('#email-step2').hidden) requestEmailCode();
    else verifyEmailCode();
  });
  $('#email-resend').addEventListener('click', requestEmailCode);
  $('#email-other').addEventListener('click', () => {
    clearInterval(resendTimer);
    emailTarget = '';
    $('#email-step2').hidden = true;
    $('#email-step1').hidden = false;
    $('#email-input').readOnly = false;
    $('#email-code').value = '';
    $('#email-error').textContent = '';
    hintDefault();
    $('#email-input').focus();
  });
}

function emailError(msg) {
  $('#email-error').textContent = msg || '';
}

function startResendCooldown(sec) {
  const btn = $('#email-resend');
  clearInterval(resendTimer);
  let left = sec;
  btn.disabled = true;
  btn.textContent = `Отправить ещё раз (${left})`;
  resendTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(resendTimer);
      btn.disabled = false;
      btn.textContent = 'Отправить код ещё раз';
    } else {
      btn.textContent = `Отправить ещё раз (${left})`;
    }
  }, 1000);
}

async function requestEmailCode() {
  const email = $('#email-input').value.trim();
  if (!email) {
    emailError('Введите почту');
    return;
  }
  const btn = $('#email-send');
  btn.disabled = true;
  emailError('');
  try {
    const data = await api('/api/auth/email', {
      method: 'POST',
      body: { email, code: $('#join-code').value },
    });
    emailTarget = email;
    $('#email-step1').hidden = true;
    $('#email-step2').hidden = false;
    $('#email-input').readOnly = true;
    $('#email-code').value = '';
    $('#email-code').focus();
    startResendCooldown(60);
    hintAfterSend(email, data.dev ? data.code : '');
  } catch (ex) {
    emailError(ex.message);
  } finally {
    btn.disabled = false;
  }
}

async function verifyEmailCode() {
  const email = emailTarget || $('#email-input').value.trim();
  const code = $('#email-code').value.trim();
  if (!/^\d{6}$/.test(code)) {
    emailError('Введите 6 цифр из письма');
    return;
  }
  const btn = $('#email-verify');
  btn.disabled = true;
  emailError('');
  try {
    const data = await api('/api/auth/verify', { method: 'POST', body: { email, code } });
    token = data.token;
    localStorage.setItem('fm_token', token);
    const st = await api('/api/state');
    initAudio();
    enterApp(st);
  } catch (ex) {
    emailError(ex.message);
  } finally {
    btn.disabled = false;
  }
}

function enterApp(st) {
  me = st.me;
  rooms = st.rooms;
  dms = st.dms;
  users = st.users;
  online = new Set(st.online.map((u) => u.key));
  unread = Object.create(null);
  for (const c of [...rooms, ...dms]) unread[c.id] = c.unread || 0;

  $('#me-name').textContent = me.name;
  paintAvatar($('#me-avatar'), me.name, me.color);
  paintSound();
  $('#join').hidden = true;
  $('#app').hidden = false;

  renderSidebar();
  updateTitle();
  connectSSE();

  const last = localStorage.getItem('fm_last_conv');
  const candidates = [...rooms, ...dms].map((c) => c.id);
  if (last && candidates.includes(last)) {
    openConv(last, { auto: true });
  } else if (window.innerWidth > 780 && rooms.some((r) => r.id === 'room:general')) {
    openConv('room:general', { auto: true });
  }
}

$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#join-btn');
  const err = $('#join-error');
  err.textContent = '';
  btn.disabled = true;
  try {
    const data = await api('/api/join', {
      method: 'POST',
      body: { name: $('#join-name').value, code: $('#join-code').value },
    });
    token = data.token;
    localStorage.setItem('fm_token', token);
    const st = await api('/api/state');
    initAudio();
    enterApp(st);
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
});

/* ─────────────────────────  САЙДБАР  ───────────────────────── */

function badgeNode(n) {
  const b = document.createElement('span');
  b.className = 'badge';
  b.textContent = n > 99 ? '99+' : String(n);
  return b;
}

function renderSidebar() {
  renderRooms();
  renderDms();
  renderOnline();
}

function renderRooms() {
  const ul = $('#room-list');
  ul.textContent = '';
  for (const r of rooms) {
    const li = document.createElement('li');
    li.className = 'conv' + (active === r.id ? ' active' : '');
    li.dataset.conv = r.id;

    const hash = document.createElement('span');
    hash.className = 'hash';
    hash.textContent = '#';

    const name = document.createElement('span');
    name.className = 'conv-name';
    name.textContent = r.name;

    li.append(hash, name);
    if (unread[r.id] && r.id !== active) li.append(badgeNode(unread[r.id]));
    li.addEventListener('click', () => openConv(r.id));
    ul.append(li);
  }
}

function renderDms() {
  const ul = $('#dm-list');
  ul.textContent = '';
  const sorted = [...dms].sort((a, b) => convTs(b.id) - convTs(a.id));

  for (const d of sorted) {
    const li = document.createElement('li');
    li.className = 'conv' + (active === d.id ? ' active' : '');
    li.dataset.conv = d.id;

    const av = document.createElement('div');
    av.className = 'avatar';
    paintAvatar(av, d.name, d.color);

    const name = document.createElement('span');
    name.className = 'conv-name';
    name.textContent = d.name;

    li.append(av, name);
    if (online.has(d.key)) {
      const dot = document.createElement('span');
      dot.className = 'online-dot';
      dot.title = 'в сети';
      li.append(dot);
    }
    if (unread[d.id] && d.id !== active) li.append(badgeNode(unread[d.id]));
    li.addEventListener('click', () => openConv(d.id));
    ul.append(li);
  }

  $('#dm-empty').hidden = dms.length > 0;
}

function renderOnline() {
  const ul = $('#online-list');
  ul.textContent = '';
  const list = users
    .filter((u) => online.has(u.key) && u.key !== me.key)
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  for (const u of list) {
    const li = document.createElement('li');
    li.className = 'conv';
    li.dataset.key = u.key;

    const av = document.createElement('div');
    av.className = 'avatar';
    paintAvatar(av, u.name, u.color);

    const name = document.createElement('span');
    name.className = 'conv-name';
    name.textContent = u.name;

    const dot = document.createElement('span');
    dot.className = 'online-dot';

    li.append(av, name, dot);
    li.addEventListener('click', () => startDm(u.key));
    ul.append(li);
  }

  $('#online-count').textContent = String(list.length);
}

/* ─────────────────────────  ЗАГОЛОВОК ЧАТА  ───────────────────────── */

function renderHeader() {
  const meta = convMeta(active);
  if (!meta) return;
  const av = $('#chat-avatar');
  const sub = $('#chat-sub');
  const actions = $('#chat-actions');
  if (actions) actions.hidden = !active.startsWith('dm:');

  if (active.startsWith('dm:')) {
    paintAvatar(av, meta.name, meta.color);
    av.style.borderRadius = '50%';
    $('#chat-name').textContent = meta.name;
    const isOn = online.has(meta.key);
    sub.textContent = isOn ? 'в сети' : lastSeenText(meta.key);
    sub.classList.toggle('online', isOn);
  } else {
    av.textContent = '#';
    av.style.background = 'linear-gradient(135deg, #334155, #1e293b)';
    av.style.borderRadius = '12px';
    $('#chat-name').textContent = meta.name;
    sub.textContent = 'публичный канал';
    sub.classList.remove('online');
  }
}

/* ─────────────────────────  СООБЩЕНИЯ  ───────────────────────── */

function renderRichText(node, text) {
  const re = /(https?:\/\/[^\s<>"']+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) node.append(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement('a');
    a.href = m[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer nofollow';
    a.textContent = m[0];
    node.append(a);
    last = m.index + m[0].length;
  }
  if (last < text.length) node.append(document.createTextNode(text.slice(last)));
}

function dayDivider(ts) {
  const el = document.createElement('div');
  el.className = 'day';
  el.textContent = dayLabel(ts);
  return el;
}

function buildMessage(m, prev) {
  const own = m.fromKey === me.key;
  const compact =
    !!prev &&
    prev.fromKey === m.fromKey &&
    sameDay(prev.ts, m.ts) &&
    m.ts - prev.ts < 5 * 60 * 1000;

  const row = document.createElement('div');
  row.className = 'msg' + (own ? ' own' : '') + (compact ? ' compact' : '');
  row.dataset.id = m.id;

  if (!own) {
    const av = document.createElement('div');
    av.className = 'avatar';
    paintAvatar(av, m.from, (userByKey(m.fromKey) || {}).color);
    av.title = m.from;
    row.append(av);
  }

  const col = document.createElement('div');
  col.className = 'bubble-col';

  if (!compact) {
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    if (!own) {
      const author = document.createElement('span');
      author.className = 'author';
      author.textContent = m.from;
      meta.append(author);
    }
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = fmtTime.format(new Date(m.ts));
    meta.append(time);
    col.append(meta);
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (compact) bubble.title = fmtTime.format(new Date(m.ts));

  if (m.text) {
    const text = document.createElement('div');
    text.className = 'text';
    renderRichText(text, m.text);
    bubble.append(text);
  }

  if (m.image) {
    const img = document.createElement('img');
    img.className = 'msg-img';
    img.src = m.image;
    img.alt = 'Картинка';
    img.loading = 'lazy';
    img.addEventListener('click', () => showLightbox(m.image));
    bubble.append(img);
  }

  col.append(bubble);
  row.append(col);

  if (own) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del-btn';
    del.textContent = '×';
    del.title = 'Удалить сообщение';
    del.addEventListener('click', () => deleteMessage(m));
    row.append(del);
    // на телефоне кнопка удаления появляется по тапу на сообщение
    row.addEventListener('click', (e) => {
      if (e.target.closest('.del-btn') || e.target.closest('.msg-img')) return;
      row.classList.toggle('reveal');
    });
  }

  return row;
}

function renderMessages(opts = {}) {
  const box = $('#messages');
  const c = cache.get(active);
  if (!c) return;

  const prevHeight = box.scrollHeight;
  const prevTop = box.scrollTop;
  const atBottom = prevHeight - prevTop - box.clientHeight < 140;

  box.textContent = '';

  if (c.hasMore) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'load-older';
    btn.textContent = 'Показать раньше';
    btn.addEventListener('click', loadOlder);
    box.append(btn);
  }

  if (!c.messages.length) {
    const empty = document.createElement('div');
    empty.className = 'loading';
    empty.textContent = 'Сообщений пока нет — напишите первым.';
    box.append(empty);
    updateScrollBtn();
    return;
  }

  let prev = null;
  for (const m of c.messages) {
    if (!prev || !sameDay(prev.ts, m.ts)) box.append(dayDivider(m.ts));
    box.append(buildMessage(m, prev));
    prev = m;
  }

  if (opts.preserve) {
    box.scrollTop = box.scrollHeight - prevHeight + prevTop;
  } else if (opts.forceBottom || atBottom) {
    box.scrollTop = box.scrollHeight;
  }
  updateScrollBtn();
}

function appendMessage(m) {
  const box = $('#messages');
  const c = cache.get(active);
  if (!c) return;

  const empty = box.querySelector('.loading');
  if (empty) empty.remove();

  const prev = c.messages[c.messages.length - 1] || null;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;

  c.messages.push(m);
  if (!prev || !sameDay(prev.ts, m.ts)) box.append(dayDivider(m.ts));
  box.append(buildMessage(m, prev));

  if (atBottom || m.fromKey === me.key) box.scrollTop = box.scrollHeight;
  updateScrollBtn();
}

function updateScrollBtn() {
  const box = $('#messages');
  const far = box.scrollHeight - box.scrollTop - box.clientHeight > 300;
  $('#scroll-down').hidden = !far;
}

async function loadOlder() {
  const c = cache.get(active);
  if (!c || !c.messages.length) return;
  const before = c.messages[0].ts;
  try {
    const data = await api(
      `/api/messages?conv=${encodeURIComponent(active)}&limit=50&before=${before}`,
    );
    c.messages = [...data.messages, ...c.messages];
    c.hasMore = data.hasMore;
    renderMessages({ preserve: true });
  } catch (e) {
    toast(e.message);
  }
}

async function deleteMessage(m) {
  if (!window.confirm('Удалить сообщение?')) return;
  try {
    await api(`/api/messages/${m.id}?conv=${encodeURIComponent(m.conv)}`, { method: 'DELETE' });
    removeMessage(m.conv, m.id);
  } catch (e) {
    toast(e.message);
  }
}

function removeMessage(conv, id) {
  const c = cache.get(conv);
  if (c) {
    const idx = c.messages.findIndex((m) => m.id === id);
    if (idx !== -1) c.messages.splice(idx, 1);
  }
  if (conv === active) {
    const node = document.querySelector(`.msg[data-id="${id}"]`);
    if (node) node.remove();
    updateScrollBtn();
  }
}

function showLightbox(src) {
  const box = $('#lightbox');
  $('#lightbox-img').src = src;
  box.hidden = false;
}

/* ─────────────────────────  ЧАТ: ОТКРЫТИЕ  ───────────────────────── */

async function openConv(id, opts = {}) {
  if (!convMeta(id)) return;
  active = id;
  localStorage.setItem('fm_last_conv', id);
  document.body.classList.add('chat-open');

  $('#empty').hidden = true;
  $('#chat-box').hidden = false;
  renderHeader();
  renderSidebar();
  renderTyping();
  closeEmoji();
  markRead(id);
  $('#typing').hidden = true;

  if (!cache.has(id)) {
    const box = $('#messages');
    box.textContent = '';
    const loading = document.createElement('div');
    loading.className = 'loading';
    loading.textContent = 'Загружаем…';
    box.append(loading);

    try {
      const data = await api(`/api/messages?conv=${encodeURIComponent(id)}&limit=50`);
      if (active !== id) return;
      cache.set(id, { messages: data.messages, hasMore: data.hasMore });
    } catch (e) {
      toast(e.message);
      return;
    }
  }

  renderMessages({ forceBottom: true });
  if (!opts.auto || window.innerWidth > 780) $('#input').focus();
}

/* ─────────────────────────  ПРИЁМ СОБЫТИЙ  ───────────────────────── */

function bumpUnread(conv) {
  unread[conv] = Math.min(99, (unread[conv] || 0) + 1);
}

function markRead(conv) {
  if (!conv || !convMeta(conv)) return;
  if (unread[conv]) {
    unread[conv] = 0;
    renderSidebar();
    updateTitle();
  }
  clearTimeout(readTimers.get(conv));
  readTimers.set(
    conv,
    setTimeout(() => {
      api('/api/read', { method: 'POST', body: { conv } }).catch(() => {});
    }, 350),
  );
}

function scheduleTypingClear(conv) {
  clearTimeout(typingTimers.get(conv));
  typingTimers.set(
    conv,
    setTimeout(() => {
      const t = typingState.get(conv);
      if (t && t.until <= Date.now()) {
        typingState.delete(conv);
        if (conv === active) renderTyping();
      }
    }, 3600),
  );
}

function renderTyping() {
  const el = $('#typing');
  const t = typingState.get(active);
  if (!t || t.until <= Date.now()) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = '';
  const label = document.createElement('span');
  label.textContent = `${t.name} печатает`;
  const dots = document.createElement('span');
  dots.className = 'dots';
  for (let i = 0; i < 3; i++) dots.append(document.createElement('i'));
  el.append(label, dots);
}

async function refreshState() {
  try {
    const st = await api('/api/state');
    me = st.me;
    rooms = st.rooms;
    dms = st.dms;
    users = st.users;
    online = new Set(st.online.map((u) => u.key));
    for (const c of [...rooms, ...dms]) unread[c.id] = c.unread || 0;
    renderSidebar();
    if (active) renderHeader();
    updateTitle();
  } catch {
    /* останемся на старых данных */
  }
}

async function onIncoming(m) {
  const own = m.fromKey === me.key;
  const isActive = m.conv === active;

  let refreshed = false;
  if (!convMeta(m.conv)) {
    await refreshState();
    refreshed = true;
  }

  const c = cache.get(m.conv);
  if (c && !c.messages.some((x) => x.id === m.id)) {
    if (isActive) {
      appendMessage(m);
    } else {
      c.messages.push(m);
      if (c.messages.length > 400) c.messages.splice(0, c.messages.length - 400);
    }
  }

  if (isActive) {
    if (!document.hidden) markRead(m.conv);
    else if (!own) bumpUnread(m.conv);
  } else if (!own && !refreshed) {
    bumpUnread(m.conv);
  }

  if (!own && soundOn && (!isActive || !document.hasFocus())) beep();

  renderSidebar();
  updateTitle();
}

/* ─────────────────────────  SSE  ───────────────────────── */

function setConnection(ok) {
  document.body.classList.toggle('offline', !ok);
  $('#me-status').textContent = ok ? 'в сети' : 'нет связи';
}

function connectSSE() {
  if (es) es.close();
  es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  es.onopen = () => setConnection(true);
  es.onerror = () => setConnection(false);
  es.onmessage = (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleEvent(data);
  };
}

function handleEvent(d) {
  switch (d.type) {
    case 'hello':
    case 'presence': {
      if (Array.isArray(d.online)) online = new Set(d.online.map((u) => u.key));
      renderSidebar();
      if (active) renderHeader();
      break;
    }
    case 'message': {
      onIncoming(d.message);
      break;
    }
    case 'message-deleted': {
      removeMessage(d.conv, d.id);
      break;
    }
    case 'typing': {
      if (!d.conv || !d.name || d.key === me.key) break;
      typingState.set(d.conv, { name: d.name, until: Date.now() + 3200 });
      scheduleTypingClear(d.conv);
      if (d.conv === active) renderTyping();
      break;
    }
    case 'rooms': {
      const known = new Map(rooms.map((r) => [r.id, r]));
      rooms = d.rooms.map((r) => ({
        id: r.id,
        name: r.name,
        unread: unread[r.id] || 0,
        lastTs: (known.get(r.id) || {}).lastTs || 0,
      }));
      renderSidebar();
      break;
    }
    case 'call': {
      handleCallEvent(d);
      break;
    }
    default:
      break;
  }
}

/* ─────────────────────────  ОТПРАВКА  ───────────────────────── */

async function sendText() {
  if (!active) return;
  const input = $('#input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  autoGrow(input);
  closeEmoji();
  try {
    const { message } = await api('/api/messages', {
      method: 'POST',
      body: { conv: active, text },
    });
    onIncoming(message);
  } catch (e) {
    input.value = text;
    autoGrow(input);
    toast(e.message);
  }
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 168) + 'px';
}

function notifyTyping() {
  if (!active) return;
  const now = Date.now();
  if (now - lastTypingSent < 2500) return;
  lastTypingSent = now;
  api('/api/typing', { method: 'POST', body: { conv: active } }).catch(() => {});
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.readAsDataURL(file);
  });
}

async function handleFile(file) {
  if (!file || !active) return;
  if (!/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) {
    toast('Можно отправлять только картинки (PNG, JPEG, GIF, WebP)');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    toast('Картинка больше 5 МБ');
    return;
  }
  const btn = $('#attach-btn');
  btn.disabled = true;
  btn.textContent = '⏳';
  try {
    const dataUrl = await fileToDataUrl(file);
    const conv = active;
    const { message } = await api('/api/messages', {
      method: 'POST',
      body: { conv, image: dataUrl },
    });
    onIncoming(message);
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '📎';
    $('#file-input').value = '';
  }
}

/* ─────────────────────────  КАНАЛЫ И ЛИЧНЫЕ  ───────────────────────── */

async function createRoom() {
  const name = await promptModal({
    title: 'Новый канал',
    placeholder: 'Например, планы на выходные',
    okText: 'Создать',
  });
  if (!name) return;
  try {
    const { room } = await api('/api/rooms', { method: 'POST', body: { name } });
    if (!rooms.some((r) => r.id === room.id)) rooms.push(room);
    renderSidebar();
    openConv(room.id);
  } catch (e) {
    toast(e.message);
  }
}

function upsertDm(dm) {
  const idx = dms.findIndex((d) => d.id === dm.id);
  if (idx === -1) dms.push(dm);
  else dms[idx] = dm;
}

async function startDm(key) {
  try {
    const { dm } = await api('/api/dm', { method: 'POST', body: { key } });
    upsertDm(dm);
    renderSidebar();
    openConv(dm.id);
  } catch (e) {
    toast(e.message);
  }
}

function openDmPicker() {
  const list = document.createElement('div');
  list.className = 'user-pick';

  const others = users.filter((u) => u.key !== me.key);
  if (!others.length) {
    const p = document.createElement('p');
    p.className = 'empty-note';
    p.textContent = 'Пока никого нет — позовите друзей на этот сервер.';
    list.append(p);
  }

  others
    .sort((a, b) => Number(online.has(b.key)) - Number(online.has(a.key)) || a.name.localeCompare(b.name, 'ru'))
    .forEach((u) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'conv';

      const av = document.createElement('div');
      av.className = 'avatar';
      paintAvatar(av, u.name, u.color);

      const name = document.createElement('span');
      name.className = 'conv-name';
      name.textContent = u.name;

      row.append(av, name);
      if (online.has(u.key)) {
        const dot = document.createElement('span');
        dot.className = 'online-dot';
        row.append(dot);
      }

      row.addEventListener('click', () => {
        ref.close();
        startDm(u.key);
      });
      list.append(row);
    });

  const ref = openModal({
    title: 'Кому написать?',
    body: list,
    actions: [{ label: 'Закрыть' }],
  });
}

/* ─────────────────────────  МОДАЛИ  ───────────────────────── */

function openModal({ title, body, actions = [], onClose = () => {} }) {
  const modal = $('#modal');
  $('#modal-title').textContent = title;

  const bodyBox = $('#modal-body');
  bodyBox.textContent = '';
  if (body) bodyBox.append(body);

  const actBox = $('#modal-actions');
  actBox.textContent = '';

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    modal.hidden = true;
    document.removeEventListener('keydown', onKey);
    modal.removeEventListener('mousedown', onBackdrop);
    onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  const onBackdrop = (e) => {
    if (e.target === modal) close();
  };

  for (const a of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = a.primary ? 'primary' : 'ghost';
    btn.textContent = a.label;
    btn.addEventListener('click', () => {
      if (a.onClick) a.onClick(close);
      else close();
    });
    actBox.append(btn);
  }

  modal.hidden = false;
  document.addEventListener('keydown', onKey);
  modal.addEventListener('mousedown', onBackdrop);

  return { close, modal };
}

function promptModal({ title, placeholder = '', value = '', okText = 'OK' }) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 30;
    input.placeholder = placeholder;
    input.value = value;

    let settled = false;
    let ref = null;

    const finish = (v) => {
      if (settled) return;
      settled = true;
      if (ref) ref.close();
      resolve(v);
    };

    ref = openModal({
      title,
      body: input,
      actions: [
        { label: 'Отмена', onClick: () => finish(null) },
        { label: okText, primary: true, onClick: () => finish(input.value.trim() || null) },
      ],
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      },
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(input.value.trim() || null);
      }
    });
    setTimeout(() => input.focus(), 30);
  });
}

/* ─────────────────────────  ЭМОДЗИ  ───────────────────────── */

const EMOJI = (
  '😀 😄 😁 😆 😅 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😋 😛 🤪 😜 🤗 🤔 🤨 😐 😑 😶 🙄 😏 ' +
  '😣 😥 😮 🤐 😯 😪 😴 😌 😝 🤤 😒 😓 😔 😕 🤑 😲 🙁 😖 😞 😟 😤 😢 😭 😦 😨 😩 🤯 😬 ' +
  '😰 😱 🥵 🥶 😳 😵 🥴 😠 😡 🤬 😷 🤒 🤕 🤢 🤮 🤧 🥳 🥺 🤠 🤡 🤫 🤭 🧐 🤓 👍 👎 👌 ✌️ ' +
  '🤞 🤟 🤘 👏 🙌 🙏 💪 🫶 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 💯 🔥 ✨ 🎉 🎁 ☕ 🍕 🍻'
).split(' ');

function buildEmojiPop() {
  const pop = $('#emoji-pop');
  pop.textContent = '';
  for (const e of EMOJI) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = e;
    btn.addEventListener('click', () => insertEmoji(e));
    pop.append(btn);
  }
}

function insertEmoji(e) {
  const input = $('#input');
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + e + input.value.slice(end);
  input.selectionStart = input.selectionEnd = start + e.length;
  input.focus();
  autoGrow(input);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function toggleEmoji() {
  const pop = $('#emoji-pop');
  if (pop.hidden) {
    if (!pop.childElementCount) buildEmojiPop();
    pop.hidden = false;
  } else {
    pop.hidden = true;
  }
}

function closeEmoji() {
  $('#emoji-pop').hidden = true;
}

/* ─────────────────────────  ПРОЧЕЕ  ───────────────────────── */

function toast(text, ms = 2600) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, ms);
}

/* ─────────────────────────  ЗВОНКИ  ───────────────────────── */

const RTC_CONFIG = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
  iceCandidatePoolSize: 4,
};

let call = null;
let callTimerId = null;
let ringId = null;

function postCall(body) {
  return api('/api/call', { method: 'POST', body });
}

function callSupported() {
  return Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.RTCPeerConnection);
}

function secureEnough() {
  return window.isSecureContext || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
}

function mediaErrorText(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Браузер не дал доступ к микрофону и камере';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'Не найдены микрофон или камера';
  if (name === 'NotReadableError') return 'Микрофон или камера заняты другим приложением';
  if (name === 'OverconstrainedError') return 'Устройство не поддерживает нужный формат';
  return (err && err.message) || 'Не удалось начать звонок';
}

async function grabMedia(kind) {
  if (!callSupported()) throw new Error('Этот браузер не умеет звонить');
  if (!secureEnough()) {
    throw new Error('Звонки работают по https или на localhost — откройте сайт из Render либо через localhost');
  }
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: kind === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false,
  });
}

function tone(freq, dur, volume = 0.05, type = 'sine') {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.03);
}

function startRinging(incoming) {
  stopRinging();
  if (!soundOn) return;
  initAudio();
  if (!audioCtx) return;
  const pattern = incoming
    ? () => {
        tone(660, 0.18, 0.06);
        setTimeout(() => tone(880, 0.18, 0.06), 240);
      }
    : () => tone(420, 0.55, 0.035, 'triangle');
  pattern();
  ringId = setInterval(pattern, incoming ? 1900 : 3600);
}

function stopRinging() {
  if (ringId) clearInterval(ringId);
  ringId = null;
}

function callStatusText() {
  if (!call) return '';
  if (call.state === 'incoming') return 'Входящий звонок';
  if (call.state === 'outgoing') return 'Звоним…';
  if (call.state === 'connecting') return 'Соединяем…';
  return 'Идёт звонок';
}

function stopCallTimer() {
  if (callTimerId) clearInterval(callTimerId);
  callTimerId = null;
  $('#call-timer').textContent = '';
}

function startCallTimer() {
  stopCallTimer();
  const started = Date.now();
  const tick = () => {
    if (!call) return;
    const total = Math.floor((Date.now() - started) / 1000);
    $('#call-timer').textContent =
      String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
  };
  tick();
  callTimerId = setInterval(tick, 1000);
}

function renderCall() {
  const layer = $('#call');
  if (!call) {
    layer.hidden = true;
    layer.classList.remove('video');
    stopCallTimer();
    $('#call-remote').srcObject = null;
    $('#call-local').srcObject = null;
    updateTitle();
    return;
  }

  layer.hidden = false;
  paintAvatar($('#call-avatar'), call.peerName, call.peerColor);
  $('#call-name').textContent = call.peerName;
  $('#call-status').textContent = callStatusText();
  $('#call-top-kind').textContent = call.kind === 'video' ? 'Видеозвонок' : 'Аудиозвонок';

  const incoming = call.state === 'incoming';
  const active = call.state === 'active' || call.state === 'connecting';
  const video = call.kind === 'video' && active;
  layer.classList.toggle('video', video);

  $('#call-accept').hidden = !incoming;
  $('#call-decline').hidden = !incoming;
  $('#call-hangup').hidden = incoming;
  $('#call-mic').hidden = !active;
  $('#call-cam').hidden = !video;
  $('#call-timer').hidden = call.state !== 'active';
  $('#call-waves').hidden = !(incoming || call.state === 'outgoing');

  $('#call-remote').hidden = !video;
  $('#call-avatar-stage').hidden = false;
  $('#call-remote').srcObject = video ? call.remoteStream || null : null;
  $('#call-local').hidden = !video;
  $('#call-local').srcObject = video ? call.localStream || null : null;

  if (incoming) document.title = '📞 ' + call.peerName;
  else updateTitle();
}

function ensurePeer(c) {
  if (c.pc) return c.pc;
  const pc = new RTCPeerConnection(RTC_CONFIG);
  c.pc = pc;

  if (c.localStream) for (const track of c.localStream.getTracks()) pc.addTrack(track, c.localStream);

  pc.onicecandidate = (e) => {
    if (e.candidate) postCall({ action: 'ice', callId: c.id, candidate: e.candidate.toJSON() }).catch(() => {});
  };
  pc.ontrack = (e) => {
    c.remoteStream = e.streams[0] || new MediaStream([e.track]);
    const el = $('#call-remote');
    el.srcObject = c.remoteStream;
    el.play().catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    if (call !== c) return;
    if (pc.connectionState === 'connected') {
      c.state = 'active';
      stopRinging();
      startCallTimer();
      renderCall();
    } else if (pc.connectionState === 'failed') {
      toast('Связь прервалась', 3600);
      teardownCall();
      postCall({ action: 'hangup', callId: c.id }).catch(() => {});
    }
  };
  return pc;
}

async function beginOffer(c) {
  const pc = ensurePeer(c);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await postCall({ action: 'offer', callId: c.id, sdp: pc.localDescription.toJSON() });
  await flushIce(c);
}

async function handleOffer(d) {
  const c = call;
  if (!c) return;
  const pc = ensurePeer(c);
  await pc.setRemoteDescription(d.sdp);
  await flushIce(c);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await postCall({ action: 'answer', callId: c.id, sdp: pc.localDescription.toJSON() });
}

function addRemoteIce(candidate) {
  const c = call;
  if (!c || !candidate) return;
  if (!c.pc || !c.pc.remoteDescription) {
    c.pendingIce.push(candidate);
    return;
  }
  c.pc.addIceCandidate(candidate).catch(() => {});
}

async function flushIce(c) {
  if (!c.pc) return;
  const queued = c.pendingIce;
  c.pendingIce = [];
  for (const candidate of queued) {
    try {
      await c.pc.addIceCandidate(candidate);
    } catch {
      /* устаревший кандидат — пропускаем */
    }
  }
}

async function placeCall(kind) {
  if (!active || !active.startsWith('dm:')) return;
  if (call) return toast('Вы уже в звонке');
  const meta = convMeta(active);
  if (!meta) return;

  let stream;
  try {
    stream = await grabMedia(kind);
  } catch (err) {
    return toast(mediaErrorText(err), 4200);
  }

  let res;
  try {
    res = await postCall({ action: 'invite', to: meta.key, kind });
  } catch (err) {
    for (const track of stream.getTracks()) track.stop();
    return toast(err.message, 3800);
  }

  call = {
    id: res.callId,
    kind,
    peerKey: meta.key,
    peerName: meta.name,
    peerColor: meta.color,
    role: 'caller',
    state: 'outgoing',
    localStream: stream,
    remoteStream: null,
    pc: null,
    pendingIce: [],
  };
  initAudio();
  startRinging(false);
  renderCall();
}

async function acceptCall() {
  const c = call;
  if (!c || c.role !== 'callee' || c.state !== 'incoming') return;

  let stream;
  try {
    stream = await grabMedia(c.kind);
  } catch (err) {
    toast(mediaErrorText(err), 4200);
    declineCall();
    return;
  }
  if (call !== c) {
    for (const track of stream.getTracks()) track.stop();
    return;
  }

  c.localStream = stream;
  ensurePeer(c);
  stopRinging();

  try {
    await postCall({ action: 'accept', callId: c.id });
  } catch (err) {
    toast(err.message, 3600);
    teardownCall();
    return;
  }
  if (call !== c) return;
  c.state = 'connecting';
  renderCall();
}

function declineCall() {
  const c = call;
  if (!c) return;
  teardownCall();
  postCall({ action: 'decline', callId: c.id }).catch(() => {});
}

function hangupCall() {
  const c = call;
  if (!c) return;
  const action = c.state === 'incoming' ? 'decline' : 'hangup';
  teardownCall();
  postCall({ action, callId: c.id }).catch(() => {});
}

function teardownCall() {
  const c = call;
  if (!c) return;
  call = null;
  stopRinging();
  if (c.pc) {
    try {
      c.pc.close();
    } catch {
      /* уже закрыт */
    }
  }
  if (c.localStream) for (const track of c.localStream.getTracks()) track.stop();
  $('#call-mic').classList.remove('off');
  $('#call-cam').classList.remove('off');
  $('#call-mic').textContent = '🎙️';
  $('#call-cam').textContent = '🎥';
  renderCall();
}

function toggleMic() {
  const track = call && call.localStream && call.localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $('#call-mic').classList.toggle('off', !track.enabled);
  $('#call-mic').textContent = track.enabled ? '🎙️' : '🔇';
}

function toggleCam() {
  const track = call && call.localStream && call.localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $('#call-cam').classList.toggle('off', !track.enabled);
  $('#call-cam').textContent = track.enabled ? '🎥' : '🚫';
}

function handleCallEvent(d) {
  if (!d || d.type !== 'call' || d.from === me.key) return;

  switch (d.action) {
    case 'invite': {
      if (call) {
        postCall({ action: 'decline', callId: d.callId }).catch(() => {});
        return;
      }
      const peer = userByKey(d.from);
      call = {
        id: d.callId,
        kind: d.kind === 'video' ? 'video' : 'audio',
        peerKey: d.from,
        peerName: d.fromName || (peer && peer.name) || 'Друг',
        peerColor: peer ? peer.color : colorForKey(d.from),
        role: 'callee',
        state: 'incoming',
        localStream: null,
        remoteStream: null,
        pc: null,
        pendingIce: [],
      };
      initAudio();
      startRinging(true);
      renderCall();
      break;
    }
    case 'accept': {
      if (!call || call.id !== d.callId || call.role !== 'caller') return;
      stopRinging();
      call.state = 'connecting';
      renderCall();
      beginOffer(call).catch(() => {
        toast('Не удалось соединиться', 3600);
        hangupCall();
      });
      break;
    }
    case 'decline': {
      if (!call || call.id !== d.callId) return;
      toast(`${call.peerName} отклонил(а) звонок`);
      teardownCall();
      break;
    }
    case 'hangup': {
      if (!call || call.id !== d.callId) return;
      const missed = call.state === 'incoming';
      toast(missed ? 'Пропущенный звонок' : 'Звонок завершён');
      teardownCall();
      break;
    }
    case 'timeout': {
      if (!call || call.id !== d.callId) return;
      toast(call.role === 'caller' ? 'Никто не ответил' : 'Пропущенный звонок');
      teardownCall();
      break;
    }
    case 'offer': {
      if (!call || call.id !== d.callId) return;
      handleOffer(d).catch(() => {
        toast('Не удалось соединиться', 3600);
        hangupCall();
      });
      break;
    }
    case 'answer': {
      if (!call || call.id !== d.callId || !call.pc) return;
      call.pc
        .setRemoteDescription(d.sdp)
        .then(() => flushIce(call))
        .catch(() => {});
      break;
    }
    case 'ice': {
      addRemoteIce(d.candidate);
      break;
    }
    default:
      break;
  }
}

/* ─────────────────────────  СОБЫТИЯ  ───────────────────────── */

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  sendText();
});

$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendText();
  }
});

$('#input').addEventListener('input', (e) => {
  autoGrow(e.target);
  notifyTyping();
});

$('#emoji-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleEmoji();
});

document.addEventListener('click', (e) => {
  const pop = $('#emoji-pop');
  if (pop.hidden) return;
  if (e.target.closest('#emoji-pop') || e.target.closest('#emoji-btn')) return;
  pop.hidden = true;
});

$('#attach-btn').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) handleFile(file);
});

document.addEventListener('paste', (e) => {
  if (!active) return;
  const item = [...(e.clipboardData?.items || [])].find(
    (i) => i.kind === 'file' && i.type.startsWith('image/'),
  );
  if (!item) return;
  e.preventDefault();
  const file = item.getAsFile();
  if (file) handleFile(file);
});

const messagesBox = $('#messages');
messagesBox.addEventListener('scroll', updateScrollBtn);
messagesBox.addEventListener('dragenter', (e) => {
  if (!active) return;
  e.preventDefault();
  messagesBox.classList.add('dragging');
});
messagesBox.addEventListener('dragover', (e) => {
  if (!active) return;
  e.preventDefault();
  messagesBox.classList.add('dragging');
});
messagesBox.addEventListener('dragleave', (e) => {
  if (e.relatedTarget && messagesBox.contains(e.relatedTarget)) return;
  messagesBox.classList.remove('dragging');
});
messagesBox.addEventListener('drop', (e) => {
  e.preventDefault();
  messagesBox.classList.remove('dragging');
  const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
  if (file) handleFile(file);
});
window.addEventListener('dragover', (e) => {
  if (!e.target.closest || !e.target.closest('#messages')) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  if (!e.target.closest || !e.target.closest('#messages')) e.preventDefault();
});

$('#scroll-down').addEventListener('click', () => {
  messagesBox.scrollTo({ top: messagesBox.scrollHeight, behavior: 'smooth' });
});

$('#back').addEventListener('click', () => {
  document.body.classList.remove('chat-open');
});

$('#sound-toggle').addEventListener('click', () => {
  soundOn = !soundOn;
  localStorage.setItem('fm_sound', soundOn ? 'on' : 'off');
  paintSound();
});

$('#logout').addEventListener('click', () => {
  if (!window.confirm('Выйти из чата?')) return;
  localStorage.removeItem('fm_token');
  localStorage.removeItem('fm_last_conv');
  token = null;
  location.reload();
});

$('#add-room').addEventListener('click', createRoom);
$('#new-dm').addEventListener('click', openDmPicker);

$('#lightbox').addEventListener('click', () => {
  $('#lightbox').hidden = true;
  $('#lightbox-img').src = '';
});

window.addEventListener('focus', () => {
  if (active) markRead(active);
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && active) markRead(active);
});

$('#call-audio').addEventListener('click', () => placeCall('audio'));
$('#call-video').addEventListener('click', () => placeCall('video'));
$('#call-accept').addEventListener('click', acceptCall);
$('#call-decline').addEventListener('click', declineCall);
$('#call-hangup').addEventListener('click', hangupCall);
$('#call-mic').addEventListener('click', toggleMic);
$('#call-cam').addEventListener('click', toggleCam);

window.addEventListener('beforeunload', () => {
  if (es) es.close();
});

window.addEventListener('pagehide', () => {
  if (!call || !token) return;
  const action = call.state === 'incoming' ? 'decline' : 'hangup';
  try {
    const blob = new Blob([JSON.stringify({ action, callId: call.id })], { type: 'application/json' });
    navigator.sendBeacon(`/api/call?token=${encodeURIComponent(token)}`, blob);
  } catch {
    /* вкладка уже закрывается — не страшно */
  }
});

paintSound();
boot();

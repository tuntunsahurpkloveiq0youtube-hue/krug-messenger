/**
 * Тест доработок версии 4: пароли, ответы, реакции, правка, голосовые,
 * профиль, mute, поиск, информация о чате, TURN в конфиге.
 * Запуск: node test/features.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3296;
const BASE = `http://127.0.0.1:${PORT}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'krug-feat-'));
const results = [];
let failed = 0;

function check(name, ok, extra = '') {
  results.push(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failed++;
}

async function api(pathname, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers['x-token'] = token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not json */
  }
  return { status: res.status, data };
}

async function waitForServer(timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

// крошечный «webm»-заголовок, чтобы сервер распознал аудио по сигнатуре
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]);
const audioDataUrl = 'data:audio/webm;base64,' + Buffer.concat(Array(20).fill(WEBM)).toString('base64');
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const pngDataUrl = 'data:image/png;base64,' + PNG_1PX;

const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    KRUG_DATA: tmp,
    FRIENDS_CODE: '',
    TURN_URLS: 'turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349',
    TURN_USERNAME: 'krug',
    TURN_CREDENTIAL: 's3cret',
  },
  stdio: 'inherit',
});

function stopServer() {
  if (!server.killed) server.kill();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

try {
  const up = await waitForServer();
  check('сервер запускается', up);
  if (!up) throw new Error('сервер не поднялся');

  const version = await api('/api/version');
  check('версия сборки — 4', version.data?.version === 4, String(version.data?.version));
  check(
    'фичи включают реакции и звонки',
    Array.isArray(version.data?.features) &&
      version.data.features.includes('reactions') &&
      version.data.features.includes('calls'),
  );

  const cfg = await api('/api/config');
  const ice = cfg.data?.rtc?.iceServers || [];
  check('конфиг отдаёт STUN', ice.some((s) => String(s.urls).includes('stun:')));
  check(
    'конфиг отдаёт TURN из переменных окружения',
    ice.some((s) => String(s.urls).includes('turn.example.com') && s.username === 'krug'),
  );

  // ── пароли ──
  const noPass = await api('/api/join', { method: 'POST', body: { name: 'Аня' } });
  check('вход без пароля отклоняется', noPass.status === 400, String(noPass.status));

  const shortPass = await api('/api/join', { method: 'POST', body: { name: 'Аня', password: '123' } });
  check('короткий пароль отклоняется', shortPass.status === 400, String(shortPass.status));

  const reg = await api('/api/join', { method: 'POST', body: { name: 'Аня', password: 'krug12345' } });
  check('регистрация по имени и паролю', reg.status === 200 && reg.data?.created === true);
  const anna = reg.data?.token;

  const wrong = await api('/api/join', { method: 'POST', body: { name: 'Аня', password: 'wrongpass' } });
  check('неверный пароль → 401', wrong.status === 401, String(wrong.status));

  const again = await api('/api/join', { method: 'POST', body: { name: 'Аня', password: 'krug12345' } });
  check('повторный вход с верным паролем', again.status === 200 && !!again.data?.token);
  check('пароль не утекает в ответе', !JSON.stringify(again.data).includes('krug12345'));

  const reg2 = await api('/api/join', { method: 'POST', body: { name: 'Боря', password: 'krug12345' } });
  const boris = reg2.data?.token;

  if (!anna || !boris) throw new Error('не удалось войти тестовыми пользователями');

  // ── личный чат и ответы ──
  const dm = await api('/api/dm', { method: 'POST', token: anna, body: { key: 'боря' } });
  const conv = dm.data?.dm?.id;
  check('личный чат создаётся', !!conv, String(conv));

  const first = await api('/api/messages', {
    method: 'POST',
    token: anna,
    body: { conv, text: 'Привет, как дела?' },
  });
  const firstId = first.data?.message?.id;
  check('сообщение отправляется', !!firstId);

  const reply = await api('/api/messages', {
    method: 'POST',
    token: boris,
    body: { conv, text: 'Всё супер', replyTo: { id: firstId } },
  });
  const replyMsg = reply.data?.message;
  check(
    'ответ приходит с цитатой',
    replyMsg?.replyTo?.id === firstId && replyMsg?.replyTo?.name === 'Аня',
    JSON.stringify(replyMsg?.replyTo?.name),
  );

  // ── реакции ──
  const react = await api(`/api/messages/${firstId}/react`, {
    method: 'POST',
    token: boris,
    body: { conv, emoji: '👍' },
  });
  check('реакция ставится', react.data?.reactions?.['👍']?.length === 1);

  const unreact = await api(`/api/messages/${firstId}/react`, {
    method: 'POST',
    token: boris,
    body: { conv, emoji: '👍' },
  });
  check('повторное нажатие снимает реакцию', !unreact.data?.reactions?.['👍']);

  const badEmoji = await api(`/api/messages/${firstId}/react`, {
    method: 'POST',
    token: boris,
    body: { conv, emoji: '<script>' },
  });
  check('посторонняя «реакция» отклоняется', badEmoji.status === 400, String(badEmoji.status));

  // ── правка ──
  const edit = await api(`/api/messages/${firstId}`, {
    method: 'PATCH',
    token: anna,
    body: { conv, text: 'Привет! Как дела?' },
  });
  check('своя правка сохраняется', edit.status === 200 && edit.data?.message?.text === 'Привет! Как дела?');
  check('правка помечается «изменено»', !!edit.data?.message?.editedAt);

  const foreignEdit = await api(`/api/messages/${firstId}`, {
    method: 'PATCH',
    token: boris,
    body: { conv, text: 'подмена' },
  });
  check('чужую правку сервер не принимает', foreignEdit.status === 403, String(foreignEdit.status));

  // ── голосовые ──
  const voice = await api('/api/messages', {
    method: 'POST',
    token: anna,
    body: { conv, audio: audioDataUrl, dur: 3 },
  });
  check(
    'голосовое сохраняется как файл',
    voice.status === 200 && String(voice.data?.message?.audio || '').startsWith('/uploads/'),
    String(voice.data?.message?.audio),
  );
  check('длительность голосового сохраняется', voice.data?.message?.dur === 3);

  const fakeAudio = await api('/api/messages', {
    method: 'POST',
    token: anna,
    body: { conv, audio: 'data:audio/webm;base64,' + Buffer.from('not-audio-at-all').toString('base64') },
  });
  check('не-аудио отклоняется', fakeAudio.status === 400, String(fakeAudio.status));

  // ── профиль ──
  const avatar = await api('/api/me', { method: 'POST', token: anna, body: { avatar: pngDataUrl } });
  check('аватар загружается', avatar.status === 200 && String(avatar.data?.me?.avatar || '').startsWith('/uploads/'));

  const bigAvatar = await api('/api/me', {
    method: 'POST',
    token: anna,
    body: { avatar: 'data:image/png;base64,' + Buffer.alloc(1200 * 1024, 7).toString('base64') },
  });
  check('слишком большой аватар отклоняется', bigAvatar.status === 400, String(bigAvatar.status));

  const badAvatar = await api('/api/me', {
    method: 'POST',
    token: anna,
    body: { avatar: 'data:text/html;base64,' + Buffer.from('<b>x</b>').toString('base64') },
  });
  check('не-картинка на аватар отклоняется', badAvatar.status === 400, String(badAvatar.status));

  const status = await api('/api/me', { method: 'POST', token: anna, body: { status: 'на связи до 18:00' } });
  check('статус сохраняется', status.data?.me?.status === 'на связи до 18:00');

  const stateB = await api('/api/state', { token: boris });
  const annaView = (stateB.data?.users || []).find((u) => u.key === 'аня') || {};
  check('статус виден другому пользователю', annaView.status === 'на связи до 18:00');
  check('аватар виден другому пользователю', String(annaView.avatar || '').startsWith('/uploads/'));
  check('пароль не отдаётся в /api/state', !JSON.stringify(stateB.data).includes('scrypt$'));

  // ── mute ──
  const mute = await api('/api/mute', { method: 'POST', token: boris, body: { conv, on: true } });
  check('отключение уведомлений принимается', mute.status === 200);
  const chatInfo = await api(`/api/chat?conv=${encodeURIComponent(conv)}`, { token: boris });
  check('информация о ЛС: muted', chatInfo.data?.muted === true);
  check('информация о ЛС: счётчик сообщений', chatInfo.data?.messageCount >= 2);

  const roomInfo = await api('/api/chat?conv=room:general', { token: anna });
  check(
    'информация о канале: участники и дата',
    roomInfo.data?.kind === 'room' && Array.isArray(roomInfo.data?.members) && !!roomInfo.data?.createdAt,
  );

  // ── поиск ──
  const search = await api(`/api/messages?conv=${encodeURIComponent(conv)}&q=супер`, { token: anna });
  check(
    'поиск находит сообщение',
    Array.isArray(search.data?.messages) && search.data.messages.some((m) => m.text.includes('супер')),
  );
  const shortQuery = await api(`/api/messages?conv=${encodeURIComponent(conv)}&q=с`, { token: anna });
  check('слишком короткий запрос отклоняется', shortQuery.status === 400, String(shortQuery.status));

  // ── лимит попыток входа ──
  let limited = 0;
  for (let i = 0; i < 40; i += 1) {
    const r = await api('/api/join', { method: 'POST', body: { name: 'Аня', password: 'nope-nope' } });
    if (r.status === 429) {
      limited += 1;
      break;
    }
  }
  check('частота попыток входа ограничивается', limited === 1);

  // ── XSS-текст остаётся текстом ──
  const xss = await api('/api/messages', {
    method: 'POST',
    token: anna,
    body: { conv, text: '<img src=x onerror=alert(1)>' },
  });
  check(
    'опасный текст хранится как строка, без интерпретации',
    xss.data?.message?.text === '<img src=x onerror=alert(1)>',
  );
} catch (err) {
  check('тест без исключений', false, String(err && err.message));
} finally {
  console.log(results.join('\n'));
  console.log(failed ? `\nПровалено: ${failed}` : `\nВсе проверки пройдены (${results.length})`);
  stopServer();
  process.exitCode = failed ? 1 : 0;
}

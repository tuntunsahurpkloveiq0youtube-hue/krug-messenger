/**
 * Дымовой тест API «Круга».
 * Запуск: node test/smoke.mjs
 * Поднимает сервер на свободном порту с временной папкой данных,
 * проходит основные сценарии и печатает результат.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3299;
const BASE = `http://127.0.0.1:${PORT}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'krug-test-'));
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

const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', KRUG_DATA: tmp, FRIENDS_CODE: '' },
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
  check('сервер запускается и отвечает на /api/health', up);
  if (!up) throw new Error('сервер не поднялся');

  const cfg = await api('/api/config');
  check('GET /api/config — код не требуется', cfg.status === 200 && cfg.data?.codeRequired === false);

  const health = await api('/api/health');
  check('GET /api/health — ok', health.status === 200 && health.data?.ok === true);

  const bad = await api('/api/join', { method: 'POST', body: { name: 'x' } });
  check('вход с коротким именем отклоняется (400)', bad.status === 400);

  const a = await api('/api/join', { method: 'POST', body: { name: 'Аня' } });
  check('вход Ани (200 + token)', a.status === 200 && typeof a.data?.token === 'string');
  const b = await api('/api/join', { method: 'POST', body: { name: 'Боря' } });
  check('вход Бори (200 + token)', b.status === 200 && typeof b.data?.token === 'string');

  const noAuth = await api('/api/state');
  check('без токена /api/state → 401', noAuth.status === 401);

  const state = await api('/api/state', { token: a.data.token });
  check('GET /api/state: каналы и пользователи', state.status === 200 && state.data?.rooms?.length >= 1 && state.data?.users?.length === 2);
  check('GET /api/state: у пользователей есть lastSeen', typeof state.data?.users?.[0]?.lastSeen === 'number');

  const general = state.data.rooms[0].id;

  const sent = await api('/api/messages', {
    method: 'POST',
    token: a.data.token,
    body: { conv: general, text: 'Привет, Боря!' },
  });
  check('отправка сообщения в канал', sent.status === 200 && sent.data?.message?.text === 'Привет, Боря!');

  const hist = await api(`/api/messages?conv=${encodeURIComponent(general)}`, { token: b.data.token });
  check('Боря видит сообщение в истории', hist.status === 200 && hist.data.messages.some((m) => m.text === 'Привет, Боря!'));

  await api('/api/read', { method: 'POST', token: b.data.token, body: { conv: general } });
  const state2 = await api('/api/state', { token: b.data.token });
  const room2 = state2.data.rooms.find((r) => r.id === general);
  check('после /api/read непрочитанных нет', room2 && room2.unread === 0);

  const empty = await api('/api/messages', { method: 'POST', token: a.data.token, body: { conv: general, text: '   ' } });
  check('пустое сообщение отклоняется (400)', empty.status === 400);

  const forbid = await api('/api/messages', { method: 'POST', token: b.data.token, body: { conv: 'room:unknown', text: 'x' } });
  check('сообщение в чужой/неизвестный канал → 403/404', forbid.status === 403 || forbid.status === 404);

  const dm = await api('/api/dm', { method: 'POST', token: a.data.token, body: { key: 'боря' } });
  check('создание личного чата', dm.status === 200 && typeof dm.data?.dm?.id === 'string');

  const dmsg = await api('/api/messages', { method: 'POST', token: a.data.token, body: { conv: dm.data.dm.id, text: 'Только для тебя' } });
  check('личное сообщение отправляется', dmsg.status === 200);

  const c = await api('/api/join', { method: 'POST', body: { name: 'Вика' } });
  const peek = await api(`/api/messages?conv=${encodeURIComponent(dm.data.dm.id)}`, { token: c.data.token });
  check('посторонний не читает чужой ЛС (403)', peek.status === 403 || peek.status === 404);

  const room = await api('/api/rooms', { method: 'POST', token: a.data.token, body: { name: 'Кино' } });
  check('создание канала', room.status === 200 && room.data?.room?.name === 'Кино');

  const dup = await api('/api/rooms', { method: 'POST', token: b.data.token, body: { name: 'кино' } });
  check('дубль канала отклоняется (409)', dup.status === 409);

  /* удаление и картинки */
  const mine = await api('/api/messages', { method: 'POST', token: a.data.token, body: { conv: general, text: 'Это сообщение я удалю' } });
  const delOwn = await api(`/api/messages/${mine.data.message.id}?conv=${encodeURIComponent(general)}`, {
    method: 'DELETE',
    token: a.data.token,
  });
  check('своё сообщение удаляется', delOwn.status === 200 && delOwn.data?.ok === true);

  const afterDel = await api(`/api/messages?conv=${encodeURIComponent(general)}`, { token: a.data.token });
  check('удалённого сообщения нет в истории', !afterDel.data.messages.some((m) => m.id === mine.data.message.id));

  const foreign = await api('/api/messages', { method: 'POST', token: b.data.token, body: { conv: general, text: 'Чужое' } });
  const delForeign = await api(`/api/messages/${foreign.data.message.id}?conv=${encodeURIComponent(general)}`, {
    method: 'DELETE',
    token: a.data.token,
  });
  check('чужое сообщение удалить нельзя (403)', delForeign.status === 403);

  const pixel =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const withImg = await api('/api/messages', { method: 'POST', token: a.data.token, body: { conv: general, text: '', image: pixel } });
  check('картинка сохраняется', withImg.status === 200 && /^\/uploads\/[a-f0-9]{16}\.png$/.test(withImg.data?.message?.image || ''));
  const imgRes = await fetch(BASE + withImg.data.message.image);
  check('загруженная картинка отдаётся', imgRes.status === 200 && imgRes.headers.get('content-type') === 'image/png');
  const badImg = await api('/api/messages', { method: 'POST', token: a.data.token, body: { conv: general, image: 'data:text/plain;base64,aGk=' } });
  check('не-картинка отклоняется (400)', badImg.status === 400);

  const typing = await api('/api/typing', { method: 'POST', token: b.data.token, body: { conv: general } });
  check('событие «печатает» принимается', typing.status === 200);

  /* SSE: Подключаемся и ждём событие на сообщение */
  const sse = await new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, events: [] });
    }, 4000);
    const events = [];
    fetch(`${BASE}/api/events?token=${a.data.token}`, { signal: controller.signal })
      .then(async (res) => {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        (async () => {
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              let idx;
              while ((idx = buf.indexOf('\n\n')) !== -1) {
                const chunk = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                const line = chunk.split('\n').find((l) => l.startsWith('data:'));
                if (line) {
                  try {
                    events.push(JSON.parse(line.slice(5).trim()));
                  } catch {
                    /* ignore */
                  }
                }
              }
            }
          } catch {
            /* aborted */
          }
        })();
        await new Promise((r) => setTimeout(r, 700));
        await api('/api/messages', { method: 'POST', token: b.data.token, body: { conv: general, text: 'Пинг по SSE' } });
        await new Promise((r) => setTimeout(r, 900));
        clearTimeout(timer);
        controller.abort();
        resolve({ ok: events.some((e) => e.type === 'message' && e.message?.text === 'Пинг по SSE'), events });
      })
      .catch(() => {
        clearTimeout(timer);
        resolve({ ok: false, events: [] });
      });
  });
  check('SSE присылает новое сообщение', sse.ok, sse.events.map((e) => e.type).join(','));

  const root = await fetch(BASE + '/');
  const html = await root.text();
  check('главная страница отдаётся', root.status === 200 && html.includes('id="join"'));
  const css = await fetch(BASE + '/styles.css');
  check('styles.css отдаётся', css.status === 200);
  const js = await fetch(BASE + '/app.js');
  check('app.js отдаётся', js.status === 200);

  const save = await api('/api/join', { method: 'POST', body: { name: 'Гоша' } });
  await new Promise((r) => setTimeout(r, 500)); // запись в файл отложена на 200 мс
  const db = JSON.parse(fs.readFileSync(path.join(tmp, 'db.json'), 'utf8'));
  check('данные сохраняются в db.json', Boolean(db.users['гоша']) && save.status === 200);
} catch (err) {
  check('тест без исключений', false, err.message);
  console.error(err);
} finally {
  stopServer();
}

console.log('\n  Дымовой тест «Круг»\n');
for (const line of results) console.log(line);
console.log(`\n  Итог: ${results.length - failed}/${results.length} проверок пройдено.`);
process.exit(failed ? 1 : 0);

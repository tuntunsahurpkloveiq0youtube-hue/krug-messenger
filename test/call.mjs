/**
 * Тест сигналинга звонков «Круга» (без медиа: WebRTC-описания фейковые).
 * Запуск: node test/call.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3297;
const BASE = `http://127.0.0.1:${PORT}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'krug-call-'));
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

function sseClient(token) {
  const ctrl = new AbortController();
  const events = [];
  (async () => {
    const res = await fetch(`${BASE}/api/events?token=${encodeURIComponent(token)}`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch {
            /* ignore */
          }
        }
      }
    }
  })().catch(() => {});

  return {
    events,
    close: () => ctrl.abort(),
    wait: async (pred, ms = 4000) => {
      const started = Date.now();
      while (Date.now() - started < ms) {
        const hit = events.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 25));
      }
      return null;
    },
    clear: () => {
      events.length = 0;
    },
  };
}

const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', KRUG_DATA: tmp, FRIENDS_CODE: '', KRUG_DEV_MAIL: '' },
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
  check('сервер запускается', await waitForServer());
  if (failed) throw new Error('сервер не поднялся');

  const anna = (await api('/api/join', { method: 'POST', body: { name: 'Аня', password: 'secret123' } })).data.token;
  const boris = (await api('/api/join', { method: 'POST', body: { name: 'Боря', password: 'secret123' } })).data.token;
  const vera = (await api('/api/join', { method: 'POST', body: { name: 'Вика', password: 'secret123' } })).data.token;

  const noAuth = await api('/api/call', { method: 'POST', body: { action: 'invite', to: 'боря' } });
  check('звонок без токена — 401', noAuth.status === 401);

  const noUser = await api('/api/call', { method: 'POST', token: anna, body: { action: 'invite', to: 'никого' } });
  check('звонок несуществующему — 404', noUser.status === 404);

  const offline = await api('/api/call', { method: 'POST', token: anna, body: { action: 'invite', to: 'боря' } });
  check('звонок офлайн-другу — 409', offline.status === 409, offline.data?.error);

  const esA = sseClient(anna);
  const esB = sseClient(boris);
  const esV = sseClient(vera);
  await esA.wait((e) => e.type === 'hello');
  await esB.wait((e) => e.type === 'hello');
  await esV.wait((e) => e.type === 'hello');

  const inv = await api('/api/call', {
    method: 'POST',
    token: anna,
    body: { action: 'invite', to: 'боря', kind: 'video' },
  });
  check('приглашение в звонок (200 + callId)', inv.status === 200 && /^[a-f0-9]{16}$/.test(inv.data?.callId || ''));
  const callId = inv.data.callId;

  const ring = await esB.wait((e) => e.type === 'call' && e.action === 'invite');
  check('Боря получает входящий (invite)', ring && ring.callId === callId && ring.kind === 'video');
  check('в приглашении есть имя звонящего', ring?.fromName === 'Аня');
  const echo = await esA.wait((e) => e.type === 'call' && e.action === 'invite');
  check('звонящий получает эхо события (from = сам)', echo?.from === 'аня');

  const busy = await api('/api/call', { method: 'POST', token: vera, body: { action: 'invite', to: 'боря' } });
  check('занятому другу — 409', busy.status === 409, busy.data?.error);

  const wrongAccept = await api('/api/call', { method: 'POST', token: anna, body: { action: 'accept', callId } });
  check('принять может только собеседник — 403', wrongAccept.status === 403);

  const stranger = await api('/api/call', { method: 'POST', token: vera, body: { action: 'hangup', callId } });
  check('чужой не может завершить звонок — 403', stranger.status === 403);

  esA.clear();
  const acc = await api('/api/call', { method: 'POST', token: boris, body: { action: 'accept', callId } });
  check('принятие звонка (200)', acc.status === 200 && acc.data?.state === 'active');
  const accEvent = await esA.wait((e) => e.type === 'call' && e.action === 'accept');
  check('звонящий узнаёт о принятии', accEvent?.from === 'боря');

  const sdp = { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' };
  esB.clear();
  const off = await api('/api/call', { method: 'POST', token: anna, body: { action: 'offer', callId, sdp } });
  check('offer передан (200)', off.status === 200);
  const offEvent = await esB.wait((e) => e.type === 'call' && e.action === 'offer');
  check('собеседник получает offer', offEvent?.sdp?.type === 'offer');

  esA.clear();
  const cand = { candidate: 'candidate:1 1 udp 2122260223 192.168.0.2 55555 typ host', sdpMid: '0', sdpMLineIndex: 0 };
  const ice = await api('/api/call', { method: 'POST', token: boris, body: { action: 'ice', callId, candidate: cand } });
  check('ICE-кандидат передан (200)', ice.status === 200);
  const iceEvent = await esA.wait((e) => e.type === 'call' && e.action === 'ice');
  check('собеседник получает ICE', iceEvent?.candidate?.candidate === cand.candidate);

  esB.clear();
  const answer = { type: 'answer', sdp: 'v=0\r\n' };
  await api('/api/call', { method: 'POST', token: boris, body: { action: 'answer', callId, sdp: answer } });
  const ansEvent = await esB.wait((e) => e.type === 'call' && e.action === 'answer');
  check('answer доходит до звонящего', ansEvent?.sdp?.type === 'answer');

  const badSdp = await api('/api/call', { method: 'POST', token: anna, body: { action: 'offer', callId } });
  check('offer без sdp — 400', badSdp.status === 400);

  esB.clear();
  const bye = await api('/api/call', { method: 'POST', token: anna, body: { action: 'hangup', callId } });
  check('завершение звонка (200)', bye.status === 200);
  const byeEvent = await esB.wait((e) => e.type === 'call' && e.action === 'hangup');
  check('собеседник получает hangup', byeEvent?.action === 'hangup');

  const after = await api('/api/call', { method: 'POST', token: boris, body: { action: 'ice', callId, candidate: cand } });
  check('после завершения звонка сигналы отклоняются (409)', after.status === 409);

  esA.clear();
  const second = await api('/api/call', { method: 'POST', token: anna, body: { action: 'invite', to: 'вика', kind: 'audio' } });
  check('повторный звонок другому (200)', second.status === 200);
  await esV.wait((e) => e.type === 'call' && e.action === 'invite');
  esA.clear();
  const dec = await api('/api/call', { method: 'POST', token: vera, body: { action: 'decline', callId: second.data.callId } });
  check('отклонение звонка (200)', dec.status === 200);
  const decEvent = await esA.wait((e) => e.type === 'call' && e.action === 'decline');
  check('звонящий узнаёт об отказе', decEvent?.from === 'вика');

  const free = await api('/api/call', { method: 'POST', token: anna, body: { action: 'invite', to: 'боря', kind: 'audio' } });
  check('после отказа можно звонить снова (200)', free.status === 200);
  await api('/api/call', { method: 'POST', token: anna, body: { action: 'hangup', callId: free.data.callId } });

  esA.close();
  esB.close();
  esV.close();
} catch (err) {
  check('тест без исключений', false, err.message);
} finally {
  stopServer();
}

console.log('');
for (const line of results) console.log(line);
console.log('');
const passed = results.length - failed;
console.log(`${failed ? '✗' : '✓'} ${passed}/${results.length} проверок пройдено`);
if (failed) process.exitCode = 1;

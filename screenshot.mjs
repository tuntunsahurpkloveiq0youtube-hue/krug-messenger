/**
 * Скриншоты «Круга» через headless Chrome и DevTools Protocol.
 * Только для разработки: нужен Chrome/Edge и свободный порт 9333.
 *
 * Запуск: node tools/screenshot.mjs
 * Результат: shots/desktop-app.png, shots/mobile-app.png
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'shots');
const APP = process.env.KRUG_URL || 'http://127.0.0.1:3210/';
const PORT = 9333;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chromePath) throw new Error('Chrome/Edge не найден, задайте CHROME_PATH');

/* ───────────── мини-клиент WebSocket (CDP) ───────────── */

class Ws {
  constructor(url) {
    const u = new URL(url);
    this.sock = net.connect({ host: u.hostname, port: Number(u.port) });
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.onMessage = () => {};
    this.ready = new Promise((resolve, reject) => {
      this.sock.once('error', reject);
      this.sock.on('connect', () => {
        const key = Buffer.from(Array.from({ length: 16 }, () => Math.random() * 256 | 0)).toString('base64');
        this.sock.write(
          `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
            `Host: ${u.host}\r\n` +
            'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
        const onData = (d) => {
          this.buf = Buffer.concat([this.buf, d]);
          const end = this.buf.indexOf('\r\n\r\n');
          if (end === -1) return;
          const head = this.buf.subarray(0, end).toString();
          if (!/^HTTP\/1\.1 101/.test(head)) return reject(new Error('WS handshake failed: ' + head.split('\r\n')[0]));
          this.sock.off('data', onData);
          this.buf = this.buf.subarray(end + 4);
          this.sock.on('data', (chunk) => this.#feed(chunk));
          if (this.buf.length) this.#feed(Buffer.alloc(0));
          resolve();
        };
        this.sock.on('data', onData);
      });
    });
  }

  #feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;
      let payload = this.buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        payload = Buffer.from(payload.map((v, i) => v ^ mask[i % 4]));
      }
      this.buf = this.buf.subarray(off + maskLen + len);

      if (opcode === 0x9) {
        this.#frame(0xa, payload);
        continue;
      }
      if (opcode === 0x8) {
        this.sock.end();
        return;
      }
      if (opcode === 0x1 || opcode === 0x0) {
        this.frag.push(payload);
        if (fin) {
          const text = Buffer.concat(this.frag).toString('utf8');
          this.frag = [];
          try {
            this.onMessage(JSON.parse(text));
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  #frame(opcode, payload) {
    const mask = Buffer.from(Array.from({ length: 4 }, () => Math.random() * 256 | 0));
    const len = payload.length;
    let head;
    if (len < 126) {
      head = Buffer.from([0x80 | opcode, 0x80 | len]);
    } else if (len < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | opcode;
      head[1] = 0x80 | 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | opcode;
      head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    const masked = Buffer.from(payload.map((v, i) => v ^ mask[i % 4]));
    this.sock.write(Buffer.concat([head, mask, masked]));
  }

  send(text) {
    this.#frame(0x1, Buffer.from(text, 'utf8'));
  }

  close() {
    try {
      this.sock.end();
    } catch {
      /* ignore */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, method = 'GET') {
  const res = await fetch(url, { method });
  return res.json();
}

/* ───────────── CDP ───────────── */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.onMessage = (msg) => {
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    };
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async waitEvent(method, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('timeout waiting for ' + method));
      }, timeout);
      const off = this.on((msg) => {
        if (msg.method === method) {
          clearTimeout(timer);
          off();
          resolve(msg.params);
        }
      });
    });
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error('JS: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value;
  }

  async shot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }
}

/* ───────────── сценарий ───────────── */

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'krug-chrome-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1360,900',
    'about:blank',
  ],
  { stdio: 'ignore', detached: false },
);

let cdp;
try {
  let version = null;
  for (let i = 0; i < 60 && !version; i++) {
    try {
      version = await getJson(`http://127.0.0.1:${PORT}/json/version`);
    } catch {
      await sleep(150);
    }
  }
  if (!version) throw new Error('Chrome не поднялся');

  const tab = await getJson(`http://127.0.0.1:${PORT}/json/new?about:blank`, 'PUT');
  const ws = new Ws(tab.webSocketDebuggerUrl);
  await ws.ready;
  cdp = new Cdp(ws);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  fs.mkdirSync(OUT, { recursive: true });

  /* ── 1. Вход ── */
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
  const loaded = cdp.waitEvent('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: APP });
  await loaded;

  const joined = await cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#join-name').value = 'Аня';
    document.querySelector('#join-form').requestSubmit();
    for (let i = 0; i < 120; i++) {
      if (!document.querySelector('#app').hidden) return document.querySelector('#me-name').textContent;
      await sleep(100);
    }
    throw new Error('вход не выполнился');
  })()`);
  console.log('вошли как:', joined);

  /* ── 2. Друзья и переписка ── */
  const seeded = await cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const myToken = localStorage.getItem('fm_token');
    const call = async (p, opts = {}) => {
      const r = await fetch(p, {
        method: opts.method || 'GET',
        headers: { 'content-type': 'application/json', 'x-token': opts.token || myToken },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      if (!r.ok) throw new Error(p + ' → ' + r.status);
      return r.json();
    };
    const post = (token, conv, text) => call('/api/messages', { method: 'POST', token, body: { conv, text } });
    const join = async (name) => (await call('/api/join', { method: 'POST', token: 'x', body: { name } })).token;

    const b = await join('Боря');
    const v = await join('Вика');
    const s = await join('Слава');
    window.__friends = [b, v, s].map((t) => new EventSource('/api/events?token=' + t));
    await sleep(300);

    await post(b, 'room:general', 'Всем привет! Кто в пятницу свободен?');
    await sleep(120);
    await post(v, 'room:general', 'Я! Давайте в парк, если погода норм ☀️');
    await post(v, 'room:general', 'Или можно ко мне — есть новый настольный хит');
    await sleep(120);
    await post(b, 'room:general', 'Парк звучит лучше. Собираемся в 18:00 у входа?');
    await post(s, 'room:general', 'Плюсую. Возьму фрисби и колонку 🎧');
    await sleep(120);
    await post(b, 'room:general', 'Тогда договорились. Скину точку позже: https://yandex.ru/maps');
    await sleep(120);
    await post(myToken, 'room:general', 'Отлично! Возьму плед и термос ☕');
    await sleep(120);

    const dm = await call('/api/dm', { method: 'POST', body: { key: 'боря' } });
    await post(b, dm.dm.id, 'Кстати, ты взяла ту книгу?');
    await sleep(120);
    await post(myToken, dm.dm.id, 'Да, дочитываю последнюю главу 📖');
    await sleep(120);
    await post(b, dm.dm.id, 'Отдашь, когда закончишь — не горит');

    const room = await call('/api/rooms', { method: 'POST', body: { name: 'Кино' } });
    await post(s, room.room.id, 'Предлагаю «Дюну 2» в субботу');
    await post(v, room.room.id, 'Я за, только не в 21:00 — поздно');
    await sleep(300);
    return { dmId: dm.dm.id, roomId: room.room.id };
  })()`);
  console.log('данные:', seeded);

  await sleep(900);
  await cdp.shot(path.join(OUT, 'desktop-app.png'));
  console.log('shots/desktop-app.png');

  /* ── 3. Личная переписка ── */
  await cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const li = [...document.querySelectorAll('#dm-list li')].find((x) => (x.dataset.conv || '').startsWith('dm:'));
    if (li) li.click();
    await sleep(600);
    return true;
  })()`);
  await cdp.shot(path.join(OUT, 'desktop-dm.png'));
  console.log('shots/desktop-dm.png');

  /* ── 4. Пикер эмодзи ── */
  await cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const li = [...document.querySelectorAll('#room-list li')].find((x) => x.dataset.conv === 'room:general');
    if (li) li.click();
    await sleep(400);
    document.querySelector('#emoji-btn').click();
    await sleep(400);
    return true;
  })()`);
  await cdp.shot(path.join(OUT, 'emoji.png'));
  console.log('shots/emoji.png');

  /* ── 5. Мобильный вид с открытым чатом ── */
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  await cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const pop = document.querySelector('#emoji-pop');
    if (!pop.hidden) document.querySelector('#emoji-btn').click();
    await sleep(200);
    const item = document.querySelector('#room-list li');
    if (item) item.click();
    await sleep(500);
    return true;
  })()`);
  await sleep(500);
  await cdp.shot(path.join(OUT, 'mobile-app.png'));
  console.log('shots/mobile-app.png');

  /* ── 6. Звонок: второе окно (Боря), входящий вызов и видеосвязь ── */
  if (process.env.KRUG_SHOT_CALL === '1') {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const li = [...document.querySelectorAll('#dm-list li')].find((x) => (x.dataset.conv || '').startsWith('dm:'));
      if (li) li.click();
      await sleep(500);
      return true;
    })()`);

    const tabB = await getJson(`http://127.0.0.1:${PORT}/json/new?about:blank`, 'PUT');
    const wsB = new Ws(tabB.webSocketDebuggerUrl);
    await wsB.ready;
    const cdpB = new Cdp(wsB);
    await cdpB.send('Page.enable');
    await cdpB.send('Runtime.enable');
    const loadedB = cdpB.waitEvent('Page.loadEventFired');
    await cdpB.send('Page.navigate', { url: APP });
    await loadedB;
    await cdpB.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });

    /* у второго окна общий localStorage — сбрасываем его, чтобы войти другим именем */
    await cdpB.evaluate(`localStorage.clear()`);
    const reloadedB = cdpB.waitEvent('Page.loadEventFired');
    await cdpB.send('Page.reload');
    await reloadedB;
    await sleep(300);

    const joinedB = await cdpB.evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('#join-name').value = 'Боря';
      document.querySelector('#join-form').requestSubmit();
      for (let i = 0; i < 120; i++) {
        if (!document.querySelector('#app').hidden) return document.querySelector('#me-name').textContent;
        await sleep(100);
      }
      throw new Error('вход второго участника не выполнился');
    })()`);
    console.log('второе окно, вошли как:', joinedB);

    await cdpB.evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 40; i++) {
        const li = [...document.querySelectorAll('#dm-list li')].find((x) => (x.dataset.conv || '').startsWith('dm:'));
        if (li) {
          li.click();
          await sleep(400);
          return true;
        }
        await sleep(100);
      }
      throw new Error('у второго участника нет личных переписок');
    })()`);
    await sleep(400);

    await cdp.evaluate(`document.querySelector('#call-video').click()`);

    await cdpB.evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 150; i++) {
        if (!document.querySelector('#call').hidden) return true;
        await sleep(100);
      }
      throw new Error('входящий звонок не пришёл');
    })()`);
    await sleep(1300);
    await cdpB.shot(path.join(OUT, 'call-incoming.png'));
    console.log('shots/call-incoming.png');

    await cdpB.evaluate(`document.querySelector('#call-accept').click()`);

    await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 200; i++) {
        if (document.querySelector('#call-status').textContent === 'Идёт звонок') return true;
        await sleep(100);
      }
      throw new Error('звонок не соединился: ' + document.querySelector('#call-status').textContent);
    })()`);
    await sleep(1600);
    await cdp.shot(path.join(OUT, 'call-video.png'));
    console.log('shots/call-video.png');

    await cdp.evaluate(`document.querySelector('#call-hangup').click()`);
    await sleep(700);
    cdpB.ws.close();
  }

  /* ── 7. Вход по почте (нужен сервер с KRUG_DEV_MAIL=1) ── */
  if (process.env.KRUG_SHOT_EMAIL === '1') {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.evaluate(`localStorage.clear()`);
    const reloaded = cdp.waitEvent('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: APP });
    await reloaded;
    await sleep(400);
    await cdp.shot(path.join(OUT, 'join.png'));
    console.log('shots/join.png');

    await cdp.evaluate(`document.querySelector('#join-tabs .tab[data-tab="email"]').click()`);    await sleep(250);
    await cdp.shot(path.join(OUT, 'join-email.png'));
    console.log('shots/join-email.png');

    await cdp.evaluate(`(() => {
      document.querySelector('#email-input').value = 'anya@example.com';
      document.querySelector('#email-form').requestSubmit();
    })()`);
    await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 120; i++) {
        if (!document.querySelector('#email-step2').hidden) return true;
        await sleep(100);
      }
      throw new Error('шаг с кодом не открылся');
    })()`);
    await sleep(300);
    await cdp.shot(path.join(OUT, 'join-email-code.png'));
    console.log('shots/join-email-code.png');

    /* демо-код виден в подсказке — вводим его и входим */
    const code = await cdp.evaluate(`document.querySelector('#join-hint code')?.textContent || ''`);
    if (/^\d{6}$/.test(code)) {
      const entered = await cdp.evaluate(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        document.querySelector('#email-code').value = ${JSON.stringify(code)};
        document.querySelector('#email-form').requestSubmit();
        for (let i = 0; i < 120; i++) {
          if (!document.querySelector('#app').hidden) return document.querySelector('#me-name').textContent;
          await sleep(100);
        }
        throw new Error('вход по коду не выполнился: ' + document.querySelector('#email-error').textContent);
      })()`);
      console.log('вошли по почте как:', entered);
      await sleep(700);
      await cdp.shot(path.join(OUT, 'email-user.png'));
      console.log('shots/email-user.png');
    }
  }

  cdp.ws.close();
} finally {
  try {
    chrome.kill();
  } catch {
    /* ignore */
  }
  await sleep(300);
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Диагностика: почему в личном чате не видно кнопок звонка.
 * Запуск: node tools/probe-dm.mjs [url]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = process.argv[2] || process.env.KRUG_URL || 'http://127.0.0.1:3210/';
const PORT = 9334;
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chromePath) throw new Error('Chrome/Edge не найден, задайте CHROME_PATH');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Ws {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve);
      this.ws.addEventListener('error', reject);
    });
  }
  send(data) {
    this.ws.send(data);
  }
  close() {
    this.ws.close();
  }
  set onMessage(fn) {
    this.ws.addEventListener('message', (e) => fn(JSON.parse(e.data)));
  }
}

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
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('JS: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  }
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'krug-probe-'));
const chrome = spawn(
  chromePath,
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--window-size=1360,900', 'about:blank'],
  { stdio: 'ignore' },
);

try {
  let version = null;
  for (let i = 0; i < 60 && !version; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    } catch {
      await sleep(150);
    }
  }
  if (!version) throw new Error('Chrome не поднялся');

  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new Ws(tab.webSocketDebuggerUrl);
  await ws.ready;
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const loaded = new Promise((resolve) => {
    const off = cdp.on((m) => {
      if (m.method === 'Page.loadEventFired') {
        off();
        resolve();
      }
    });
  });
  await cdp.send('Page.navigate', { url: APP });
  await loaded;

  console.log('url:', APP);
  console.log('assets:', await cdp.evaluate(`[...document.querySelectorAll('script[src],link[rel=stylesheet]')].map((e) => e.getAttribute('src') || e.getAttribute('href'))`));

  const me = await cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#join-name').value = 'Проба';
    document.querySelector('#join-form').requestSubmit();
    for (let i = 0; i < 120; i++) {
      if (!document.querySelector('#app').hidden) return document.querySelector('#me-name').textContent;
      await sleep(100);
    }
    throw new Error('вход не выполнен');
  })()`);
  console.log('вошли как:', me);

  const info = await cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const token = localStorage.getItem('fm_token');
    const call = async (p, body) => {
      const r = await fetch(p, {
        method: body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json', 'x-token': token },
        body: body ? JSON.stringify(body) : undefined,
      });
      return r.json();
    };
    await call('/api/join', { name: 'Собеседник' }).catch(() => {});
    const users = await call('/api/state');
    const other = Object.keys(users.users).find((k) => k !== users.me.key);
    const dm = await call('/api/dm', { key: other });
    await sleep(300);
    const li = [...document.querySelectorAll('#dm-list li')].find((x) => (x.dataset.conv || '').startsWith('dm:'));
    if (!li) return { error: 'нет пункта личных сообщений', dm };
    li.click();
    await sleep(500);
    const el = document.querySelector('#chat-actions');
    const audio = document.querySelector('#call-audio');
    const cs = el ? getComputedStyle(el) : null;
    return {
      conv: dm.dm && dm.dm.id,
      activeConv: document.querySelector('#chat') ? 'ok' : 'нет',
      exists: !!el,
      hiddenAttr: el ? el.hasAttribute('hidden') : null,
      display: cs ? cs.display : null,
      visibility: cs ? cs.visibility : null,
      rect: el ? el.getBoundingClientRect().toJSON() : null,
      audioExists: !!audio,
      audioText: audio ? audio.textContent : null,
      html: el ? el.outerHTML.slice(0, 300) : null,
      appJsHasCall: (await (await fetch('/app.js')).text()).includes("'/api/call'"),
    };
  })()`);
  console.log('проверка:', JSON.stringify(info, null, 2));

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

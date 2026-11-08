/**
 * Тест входа по почте.
 * Запуск: node test/email.mjs
 * Поднимает сервер в демо-режиме (KRUG_DEV_MAIL=1), проверяет код,
 * лимиты, одноразовость кода и создание пользователей.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
let failed = 0;

function check(name, ok, extra = '') {
  results.push(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failed++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer({ port, env = {} }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'krug-mail-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', KRUG_DATA: tmp, FRIENDS_CODE: '', ...env },
    stdio: 'inherit',
  });
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  while (Date.now() - started < 8000) {
    try {
      if ((await fetch(base + '/api/health')).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(120);
  }
  return {
    base,
    stop() {
      if (!child.killed) child.kill();
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

async function call(base, pathname, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers['x-token'] = token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + pathname, {
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

/* ── 1. демо-режим ── */

const demo = await startServer({ port: 3291, env: { KRUG_DEV_MAIL: '1' } });
try {
  let r = await call(demo.base, '/api/config');
  check('config: emailAuth включён', r.data?.emailAuth === true);
  check('config: devMail = true', r.data?.devMail === true);

  r = await call(demo.base, '/api/auth/email', { method: 'POST', body: { email: 'Не почта' } });
  check('некорректная почта → 400', r.status === 400, `${r.status} ${r.data?.error || ''}`);

  r = await call(demo.base, '/api/auth/email', { method: 'POST', body: { email: 'anya@example.com' } });
  check('код отправлен (демо)', r.status === 200 && r.data?.ok === true);
  check('код в ответе, 6 цифр', /^\d{6}$/.test(r.data?.code || ''), r.data?.code);
  const code = r.data?.code;

  r = await call(demo.base, '/api/auth/email', { method: 'POST', body: { email: 'anya@example.com' } });
  check('повтор раньше 60 с → 429', r.status === 429, `${r.status} ${r.data?.error || ''}`);

  r = await call(demo.base, '/api/auth/verify', {
    method: 'POST',
    body: { email: 'anya@example.com', code: code === '000000' ? '111111' : '000000' },
  });
  check('неверный код → 400', r.status === 400, `${r.status} ${r.data?.error || ''}`);

  r = await call(demo.base, '/api/auth/verify', { method: 'POST', body: { email: 'anya@example.com', code } });
  check('верный код → токен', r.status === 200 && typeof r.data?.token === 'string');
  check('имя из почты', r.data?.me?.name === 'anya', r.data?.me?.name);
  check('created = true', r.data?.created === true);
  const token = r.data?.token;
  const key = r.data?.me?.key;
  check('ключ пользователя = почта', key === 'anya@example.com', key);

  r = await call(demo.base, '/api/state', { token });
  check('state по токену', r.status === 200 && r.data?.me?.key === key);

  r = await call(demo.base, '/api/auth/verify', { method: 'POST', body: { email: 'anya@example.com', code } });
  check('код одноразовый → 400', r.status === 400, `${r.status} ${r.data?.error || ''}`);

  r = await call(demo.base, '/api/auth/email', { method: 'POST', body: { email: 'anya@work.example.org' } });
  check('вторая почта с тем же логином', r.status === 200, `${r.status} ${r.data?.error || ''}`);
  const code2 = r.data?.code;
  r = await call(demo.base, '/api/auth/verify', { method: 'POST', body: { email: 'anya@work.example.org', code: code2 } });
  check('имя не дублируется: «anya 2»', r.data?.me?.name === 'anya 2', r.data?.me?.name);

  r = await call(demo.base, '/api/join', { method: 'POST', body: { name: 'Гость' } });
  check('вход по имени рядом работает', r.status === 200 && !!r.data?.token);
} finally {
  demo.stop();
}

/* ── 2. код доступа ── */

const guarded = await startServer({ port: 3292, env: { KRUG_DEV_MAIL: '1', FRIENDS_CODE: 'krug123' } });
try {
  let r = await call(guarded.base, '/api/auth/email', { method: 'POST', body: { email: 'borya@example.com' } });
  check('без кода доступа → 403', r.status === 403, `${r.status}`);
  r = await call(guarded.base, '/api/auth/email', {
    method: 'POST',
    body: { email: 'borya@example.com', code: 'krug123' },
  });
  check('с кодом доступа → 200', r.status === 200, `${r.status} ${r.data?.error || ''}`);
} finally {
  guarded.stop();
}

/* ── 3. почта выключена ── */

const off = await startServer({ port: 3293 });
try {
  let r = await call(off.base, '/api/config');
  check('config: emailAuth выключен', r.data?.emailAuth === false);
  r = await call(off.base, '/api/auth/email', { method: 'POST', body: { email: 'x@example.com' } });
  check('без настройки → 404', r.status === 404, `${r.status}`);
  r = await call(off.base, '/api/auth/verify', { method: 'POST', body: { email: 'x@example.com', code: '123456' } });
  check('verify без настройки → 404', r.status === 404, `${r.status}`);
} finally {
  off.stop();
}

console.log('');
console.log(results.join('\n'));
console.log('');
console.log(failed === 0 ? `  Все проверки пройдены (${results.length})` : `  Провалено: ${failed} из ${results.length}`);
process.exit(failed === 0 ? 0 : 1);

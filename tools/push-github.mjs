/**
 * Публикует проект в GitHub через REST API — git и gh не нужны.
 *
 * Токен: GH_TOKEN (или GITHUB_TOKEN) — fine-grained PAT с правами
 *   Contents: Read and write, Administration: Read and write (чтобы создать репозиторий).
 *
 * Использование:
 *   set GH_TOKEN=github_pat_...
 *   node tools/push-github.mjs krug-messenger
 *
 * Скрипт создаёт публичный репозиторий (если его ещё нет), заливает все файлы
 * одним коммитом и печатает ссылку. Повторный запуск обновляет файлы.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.github.com';
const token = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();
const repoName = (process.argv[2] || 'krug-messenger').trim();
const owner = (process.env.GH_OWNER || '').trim();
const isPrivate = process.env.GH_PRIVATE === '1';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'data', 'tmp-demo', '.vscode', '.idea']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

if (!token) {
  console.error('Нужен токен: set GH_TOKEN=... (fine-grained PAT с Contents: Read and write)');
  process.exit(1);
}
if (!/^[A-Za-z0-9._-]+$/.test(repoName)) {
  console.error('Имя репозитория может содержать только латиницу, цифры, точку, дефис и подчёркивание');
  process.exit(1);
}

function collect(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
    if (SKIP_FILES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...collect(full, rel));
    } else if (entry.isFile()) {
      out.push({ path: rel, file: full });
    }
  }
  return out;
}

async function gh(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(API + pathname, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'krug-publish',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const detail = typeof data === 'string' ? data : data?.message || '';
    const hints = {
      401: 'токен неверный или истёк',
      403: 'у токена нет нужных прав (Contents / Administration: Read and write)',
      404: 'репозиторий не найден или нет доступа',
      422: 'проверьте имя репозитория (возможно, уже занято)',
    };
    throw new Error(`${method} ${pathname} → ${res.status} ${detail}${hints[res.status] ? ` (${hints[res.status]})` : ''}`);
  }
  return data;
}

async function main() {
  const me = await gh('/user');
  const login = me.login;
  const repoOwner = owner || login;
  console.log(`Токен: ${login}`);
  console.log(`Репозиторий: ${repoOwner}/${repoName} (${isPrivate ? 'приватный' : 'публичный'})`);

  let repo = null;
  try {
    repo = await gh(`/repos/${repoOwner}/${repoName}`);
  } catch (err) {
    if (!/→ 404/.test(err.message)) throw err;
  }

  if (!repo) {
    repo = await gh(repoOwner === login ? '/user/repos' : `/orgs/${repoOwner}/repos`, {
      method: 'POST',
      body: {
        name: repoName,
        description: 'Круг — маленький мессенджер для друзей (Node.js, SSE, JSON-файл)',
        private: isPrivate,
        auto_init: false,
        has_issues: true,
      },
    });
    console.log('Репозиторий создан');
  } else {
    console.log('Репозиторий уже есть — обновляю файлы');
  }

  /* ветка по умолчанию: main, если её нет — первая существующая */
  let branch = repo.default_branch || 'main';
  let parentCommit = null;
  try {
    const ref = await gh(`/repos/${repoOwner}/${repoName}/git/ref/heads/${branch}`);
    parentCommit = ref.object.sha;
  } catch {
    /* пустой репозиторий */
  }

  const files = collect(ROOT);
  if (!files.length) throw new Error('Нет файлов для отправки');
  console.log(`Файлов: ${files.length}`);

  const blobs = [];
  for (const f of files) {
    const content = fs.readFileSync(f.file).toString('base64');
    const blob = await gh(`/repos/${repoOwner}/${repoName}/git/blobs`, {
      method: 'POST',
      body: { content, encoding: 'base64' },
    });
    blobs.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    process.stdout.write('.');
  }
  console.log('');

  const tree = await gh(`/repos/${repoOwner}/${repoName}/git/trees`, {
    method: 'POST',
    body: { tree: blobs },
  });

  const message = `Круг: мессенджер, вход по почте, деплой на Render\n\nФайлов: ${files.length}`;
  const commit = await gh(`/repos/${repoOwner}/${repoName}/git/commits`, {
    method: 'POST',
    body: {
      message,
      tree: tree.sha,
      parents: parentCommit ? [parentCommit] : [],
    },
  });

  if (parentCommit) {
    await gh(`/repos/${repoOwner}/${repoName}/git/refs/heads/${branch}`, {
      method: 'PATCH',
      body: { sha: commit.sha, force: false },
    });
  } else {
    await gh(`/repos/${repoOwner}/${repoName}/git/refs`, {
      method: 'POST',
      body: { ref: `refs/heads/${branch}`, sha: commit.sha },
    });
  }

  console.log('');
  console.log(`Готово: https://github.com/${repoOwner}/${repoName}`);
  console.log(`Коммит: ${commit.sha.slice(0, 7)}`);
  console.log('');
  console.log('Дальше на Render: New → Blueprint → выберите этот репозиторий → Apply.');
}

main().catch((err) => {
  console.error('');
  console.error('Ошибка:', err.message);
  process.exit(1);
});

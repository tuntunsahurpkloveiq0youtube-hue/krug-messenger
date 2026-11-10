#!/usr/bin/env node
/**
 * Полная замена содержимого репозитория GitHub папкой проекта — без git и gh.
 *
 *   set GH_TOKEN=github_pat_...
 *   node tools/upload-github.mjs [папка] [owner/repo]
 *
 * По умолчанию папка — ../krug-upload, репозиторий — из аргумента или GH_REPO.
 * Дерево собирается целиком (без base_tree), поэтому старые файлы, которых нет
 * в папке, из репозитория удаляются. Коммит атомарный: либо всё, либо ничего.
 */
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.GH_TOKEN || '';
const DIR = path.resolve(process.argv[2] || './krug-upload');
const REPO = process.argv[3] || process.env.GH_REPO || 'tuntunsahurpkloveiq0youtube-hue/krug-messenger';
const BRANCH = process.env.GH_BRANCH || 'main';
const API = 'https://api.github.com';

if (!TOKEN) {
  console.error('Нет GH_TOKEN. Создайте токен: GitHub → Settings → Developer settings →');
  console.error('Personal access tokens → Fine-grained tokens → Contents: Read and write.');
  process.exit(1);
}
if (!fs.existsSync(DIR)) {
  console.error('Нет папки:', DIR);
  process.exit(1);
}

async function api(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'krug-uploader',
      'x-github-api-version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${method} ${url} → ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

// какие файлы заливаем: без мусора и без секретов
const SKIP_DIRS = new Set(['data', 'tmp-demo', 'node_modules', '.git', 'build', '.gradle']);
const SKIP_FILES = new Set(['local.properties', '.DS_Store', 'Thumbs.db']);

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, base, out);
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue;
      if (/\.(zip|apk|aab)$/i.test(entry.name)) continue;
      out.push({ full, rel });
    }
  }
  return out;
}

const files = walk(DIR);
if (!files.length) {
  console.error('Папка пустая:', DIR);
  process.exit(1);
}
console.log(`Файлов к загрузке: ${files.length} (${(files.reduce((n, f) => n + fs.statSync(f.full).size, 0) / 1024).toFixed(0)} КБ)`);

// 1. Текущий head
let head;
for (const branch of BRANCH === 'main' ? ['main', 'master'] : [BRANCH]) {
  try {
    head = await api('GET', `/repos/${REPO}/git/ref/heads/${branch}`);
    break;
  } catch (err) {
    if (err.status !== 404) throw err;
  }
}
if (!head) {
  console.error(`Не нашёл ветку ${BRANCH} в ${REPO}. Проверьте имя репозитория (owner/repo).`);
  process.exit(1);
}
const parentSha = head.object.sha;
const parent = await api('GET', `/repos/${REPO}/git/commits/${parentSha}`);
console.log(`Репозиторий: ${REPO}, ветка ${BRANCH}, коммит ${parentSha.slice(0, 7)}`);

// 2. Блобы
const tree = [];
for (const file of files) {
  const content = fs.readFileSync(file.full).toString('base64');
  const blob = await api('POST', `/repos/${REPO}/git/blobs`, { content, encoding: 'base64' });
  tree.push({ path: file.rel, mode: '100644', type: 'blob', sha: blob.sha });
  process.stdout.write(`  + ${file.rel}\n`);
}

// 3. Дерево без base_tree — полная замена состава файлов
const newTree = await api('POST', `/repos/${REPO}/git/trees`, { tree });

// 4. Коммит и переключение ветки
const message = process.env.GH_MESSAGE || 'Круг: сборка 4 — пароли, ответы и реакции, голосовые, профиль, светлая тема, поиск, TURN';
const commit = await api('POST', `/repos/${REPO}/git/commits`, {
  message,
  tree: newTree.sha,
  parents: [parentSha],
});
await api('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: true });

console.log('\nГотово.');
console.log(`Коммит: ${commit.sha.slice(0, 7)} — https://github.com/${REPO}/commit/${commit.sha}`);
console.log(`Файлов в новом дереве: ${tree.length}`);

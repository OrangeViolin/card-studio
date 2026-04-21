/**
 * 卡片书斋 · card-library
 * 把一本书（PDF / ZIP / Markdown）变成可浏览的知识卡片集
 *
 * 三条导入路径：
 *   [A] 成品直传 ZIP（含 book.json + cards.json）              → 秒级落盘
 *   [B] 素材 ZIP（.md / .txt） 或 单个 .md/.txt                → Claude CLI 生成卡片
 *   [C] PDF                                                   → pdf2x.cn 转 Markdown → Claude CLI 生成卡片
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID: uuidv4 } = require('crypto');
const { spawn } = require('child_process');
const multer = require('multer');
const AdmZip = require('adm-zip');

const app = express();
const PORT = process.env.PORT || 3013;
const DATA_DIR = process.env.CARD_DATA_DIR || path.join(__dirname, 'data');
const PDF2X_ENDPOINT = process.env.PDF2X_ENDPOINT || 'https://insightdoc.memect.cn';

// ============================================================
// Claude CLI 自动探测（跨平台）
// ============================================================
const CLAUDE_CLI_CANDIDATES = [
  process.env.CLAUDE_CLI,
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  '/usr/bin/claude',
  (process.env.HOME || '') + '/.claude/local/claude',
  (process.env.APPDATA || '') + '\\npm\\claude.cmd',
  (process.env.APPDATA || '') + '\\npm\\claude.ps1',
].filter(Boolean);

function findClaudeCli() {
  for (const p of CLAUDE_CLI_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return 'claude'; // fallback: hope it's in PATH
}
const CLAUDE_CLI = findClaudeCli();

// ============================================================
// 静态资源 & 数据目录
// ============================================================
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const BOOKS_ROOT = path.join(DATA_DIR, 'books');
if (!fs.existsSync(BOOKS_ROOT)) fs.mkdirSync(BOOKS_ROOT, { recursive: true });

const booksUpload = multer({ dest: path.join(DATA_DIR, 'book_upload'), limits: { fileSize: 60 * 1024 * 1024 } });

// ============================================================
// 文件锁（串行化 books.json 读改写）
// ============================================================
const fileLocks = {};
function withFileLock(file, fn) {
  if (!fileLocks[file]) fileLocks[file] = Promise.resolve();
  const prev = fileLocks[file];
  const next = prev.then(fn, fn);
  fileLocks[file] = next.catch(() => {});
  return next;
}

// ============================================================
// Claude CLI 调用（一次只能跑一个任务）
// ============================================================
let ccBusy = false;
let ccCurrentTask = '';

app.get('/api/cc/status', (_req, res) => {
  res.json({ busy: ccBusy, task: ccCurrentTask, cli: CLAUDE_CLI });
});

function callClaude(prompt, taskName = '', timeoutMs = 10 * 60 * 1000) {
  if (ccBusy) return Promise.reject(new Error(`CC_BUSY:${ccCurrentTask}`));
  ccBusy = true;
  ccCurrentTask = taskName;
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const child = spawn(CLAUDE_CLI, ['-p', '--output-format', 'text'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWin,
      env: {
        ...process.env,
        HOME: process.env.HOME || process.env.USERPROFILE,
        PATH: isWin
          ? (process.env.PATH || '')
          : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH || ''].join(':'),
      },
      cwd: DATA_DIR,
    });

    try { child.stdin.write(prompt); child.stdin.end(); }
    catch (err) { console.error('[CC] stdin error:', err.message); }

    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      ccBusy = false; ccCurrentTask = '';
      reject(new Error(`Claude 超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      ccBusy = false; ccCurrentTask = '';
      if (stdout.trim()) resolve(stdout.trim());
      else if (code !== 0) reject(new Error(`Claude exited ${code}: ${stderr.slice(0, 300)}`));
      else resolve('');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      ccBusy = false; ccCurrentTask = '';
      reject(err);
    });
  });
}

// ============================================================
// Books 数据层
// ============================================================
const VALID_CARD_TYPES = ['term', 'people', 'counter', 'quote', 'action', 'tech', 'wild'];

function readBooksIndex() {
  const file = path.join(DATA_DIR, 'books.json');
  if (!fs.existsSync(file)) return { books: [] };
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return { books: [] }; }
}
function writeBooksIndex(data) {
  fs.writeFileSync(path.join(DATA_DIR, 'books.json'), JSON.stringify(data, null, 2), 'utf-8');
}
function bookDir(id) { return path.join(BOOKS_ROOT, id); }

function normalizeCard(raw, index) {
  const type = VALID_CARD_TYPES.includes(raw.type) ? raw.type : 'wild';
  return {
    id: raw.id || `c${index}`,
    type,
    title: String(raw.title || '未命名').trim(),
    fields: raw.fields && typeof raw.fields === 'object' ? raw.fields : {},
    source: raw.source || '',
    tags: Array.isArray(raw.tags) ? raw.tags : [],
  };
}

async function persistBook(bookMeta, cardsArray, coverBuf, coverExt) {
  const id = bookMeta.id || uuidv4();
  const dir = bookDir(id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const cards = cardsArray.map((c, i) => normalizeCard(c, i));
  const book = {
    id,
    title: String(bookMeta.title || '未命名'),
    author: bookMeta.author || '',
    subtitle: bookMeta.subtitle || '',
    description: bookMeta.description || '',
    tapeColor: bookMeta.tapeColor || null,
    accentColor: bookMeta.accentColor || null,
    createdAt: now,
    updatedAt: now,
    cardCount: cards.length,
  };
  fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify(book, null, 2), 'utf-8');
  fs.writeFileSync(path.join(dir, 'cards.json'), JSON.stringify(cards, null, 2), 'utf-8');
  if (coverBuf && coverExt) {
    fs.writeFileSync(path.join(dir, `cover.${coverExt}`), coverBuf);
  }
  await withFileLock('books.json', async () => {
    const idx = readBooksIndex();
    const existing = idx.books.findIndex(b => b.id === id);
    const entry = {
      id, title: book.title, author: book.author,
      subtitle: book.subtitle, description: book.description,
      tapeColor: book.tapeColor, accentColor: book.accentColor,
      cardCount: cards.length,
      createdAt: book.createdAt, updatedAt: book.updatedAt,
    };
    if (existing >= 0) idx.books[existing] = entry;
    else idx.books.unshift(entry);
    writeBooksIndex(idx);
  });
  return { id, book, cardCount: cards.length };
}

// ============================================================
// 素材提取 & Prompt
// ============================================================
function collectSkillMaterials(dir, maxTotal = 180000) {
  let total = 0;
  const parts = [];
  function walk(d) {
    for (const item of fs.readdirSync(d)) {
      if (item.startsWith('.') || item === '__MACOSX') continue;
      const p = path.join(d, item);
      const stat = fs.statSync(p);
      if (stat.isDirectory()) { walk(p); continue; }
      const ext = path.extname(item).toLowerCase();
      if (!['.md', '.txt'].includes(ext)) continue;
      if (total >= maxTotal) return;
      try {
        let text = fs.readFileSync(p, 'utf-8');
        if (text.length > 40000) text = text.substring(0, 40000) + '\n...(单文件截断)';
        const rel = path.relative(dir, p);
        const block = `\n\n--- ${rel} ---\n${text}`;
        parts.push(block);
        total += block.length;
      } catch {}
    }
  }
  walk(dir);
  let combined = parts.join('');
  if (combined.length > maxTotal) combined = combined.substring(0, maxTotal) + '\n...(总长度截断)';
  return combined;
}

function buildCardsPrompt(material, targetCount = 30) {
  return `你是一位专业的读书笔记整理师。请把下面的素材，转成"卡片书斋"需要的书籍+卡片 JSON 数据。

## 七种卡片类型及必填字段

- term (术语卡)：首创者 / 诞生时间 / 原始定义 / 所属学科 / 关键论文 / 一句话理解
- people (人名卡)：生卒年 / 时代背景 / 核心贡献 / 代表作品 / 影响力周期 / 一句话评价
- counter (反常识卡)：常识 / 反常识 / 证据类型 / 关键证据 / 出处 / 启发
- quote (金句卡)：金句 / 中译 / 作者 / 语境 / 为何性感
- action (行动卡)：行动 / 来源洞察 / 最小启动 / 预期改变 / 触发场景
- tech (技巧卡)：适用场景 / 操作步骤 / 生效原理 / 注意事项 / 出处
- wild (任意卡)：卡片类型 / 内容 / 为何值得记录

## 输出格式（直接输出 JSON，不要代码块、不要解释）

{
  "book": {
    "title": "书名",
    "author": "作者",
    "subtitle": "副标题（可选）",
    "description": "一句话介绍，≤ 40 字",
    "tapeColor": "#xxxxxx",
    "accentColor": "#xxxxxx"
  },
  "cards": [
    { "id": "t1", "type": "term", "title": "...", "fields": { ... }, "source": "章节/出处" }
  ]
}

## 要求

- **至少生成 ${targetCount} 张卡片**（宁多勿少，素材充分就给到 40-50 张）
- 每种类型至少 3 张（wild 可选），类型分布均衡
- 尽量穷尽书中所有核心术语、关键人物、反常识洞察、精华金句、可执行行动、可复用技巧
- fields 内容高信息密度、具体、带数字/案例；禁止水句和泛泛描述
- 每张卡必须独立可读，不依赖其他卡
- tapeColor 和 accentColor 选择 1 组符合书籍气质的颜色（tapeColor 偏亮、accentColor 偏深）
- id 用 t1/p1/c1/q1/a1/tk1/w1 这类简短前缀 + 序号

## 材料
${material}

记住：至少 ${targetCount} 张，只输出 JSON，不要任何其它文字、不要 markdown 代码块。
**重要：字段值里不要出现字面量英文双引号 " — 需要引用人话时请使用中文引号「」或 『』。**`;
}

function stripJsonFence(s) {
  return s.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
}
function safeJsonParse(text) {
  const attempts = [
    text,
    text.replace(/,(\s*[}\]])/g, '$1'),
    text.replace(/[""]/g, '\\"').replace(/\\"([^",}\]]*)\\"/g, '"$1"'),
  ];
  let lastErr;
  for (const t of attempts) {
    try { return JSON.parse(t); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// ============================================================
// 进度池（生成任务）
// ============================================================
const bookJobs = new Map();
function createBookJob() {
  const id = uuidv4();
  bookJobs.set(id, { id, status: 'pending', progress: '准备中…', createdAt: Date.now() });
  for (const [k, v] of bookJobs) {
    if (Date.now() - v.createdAt > 3600_000) bookJobs.delete(k);
  }
  return id;
}
function updateBookJob(id, patch) {
  const j = bookJobs.get(id);
  if (j) Object.assign(j, patch);
}

app.get('/api/books/jobs/:id', (req, res) => {
  const j = bookJobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'not_found' });
  res.json(j);
});

// ============================================================
// Books API：列表 / 详情 / 卡片 / 封面
// ============================================================
app.get('/api/books', (_req, res) => res.json(readBooksIndex()));

app.get('/api/books/:id', (req, res) => {
  const file = path.join(bookDir(req.params.id), 'book.json');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'not_found' });
  res.json(JSON.parse(fs.readFileSync(file, 'utf-8')));
});

app.get('/api/books/:id/cards', (req, res) => {
  const file = path.join(bookDir(req.params.id), 'cards.json');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'not_found' });
  res.json(JSON.parse(fs.readFileSync(file, 'utf-8')));
});

app.get('/api/books/:id/cover', (req, res) => {
  const dir = bookDir(req.params.id);
  for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
    const p = path.join(dir, `cover.${ext}`);
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  res.status(404).end();
});

app.delete('/api/books/:id', async (req, res) => {
  const id = req.params.id;
  const dir = bookDir(id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  await withFileLock('books.json', async () => {
    const idx = readBooksIndex();
    idx.books = idx.books.filter(b => b.id !== id);
    writeBooksIndex(idx);
  });
  res.json({ ok: true });
});

// ============================================================
// 上传：ZIP / Markdown / TXT
// ============================================================
async function runGenerateJob(jobId, extractDir, originalName) {
  try {
    updateBookJob(jobId, { status: 'running', progress: '扫描素材…' });
    const material = collectSkillMaterials(extractDir);
    if (!material.trim()) throw new Error('未找到 .md/.txt 素材');

    updateBookJob(jobId, { progress: 'Claude 正在生成卡片（约 2-3 分钟）…' });
    const raw = await callClaude(buildCardsPrompt(material, 30), `生成卡片:${originalName}`);
    const cleaned = stripJsonFence(raw);
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Claude 返回格式错误，未找到 JSON');
    const parsed = safeJsonParse(match[0]);

    const bookMeta = parsed.book || {};
    const cards = Array.isArray(parsed.cards) ? parsed.cards : [];
    if (!bookMeta.title) bookMeta.title = path.basename(originalName).replace(/\.(zip|md|txt|pdf)$/i, '');
    if (!cards.length) throw new Error('Claude 未生成任何卡片');

    updateBookJob(jobId, { progress: '保存到书架…' });
    const result = await persistBook(bookMeta, cards, null, null);
    try { fs.writeFileSync(path.join(bookDir(result.id), 'source.txt'), material, 'utf-8'); } catch {}
    updateBookJob(jobId, { status: 'done', progress: `生成完成 · ${result.cardCount} 张卡片`, bookId: result.id, book: result.book });
  } catch (err) {
    console.error('[books/generate]', err);
    updateBookJob(jobId, { status: 'error', error: err.message });
  } finally {
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
  }
}

// ZIP 上传（成品直传 或 素材生成）
app.post('/api/books/upload', booksUpload.single('zipFile'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const tmp = req.file.path;
  const originalName = req.file.originalname || 'book.zip';
  try {
    const zip = new AdmZip(tmp);
    const entries = zip.getEntries();
    const findEntry = (name) => entries.find(e => !e.isDirectory && e.entryName.split('/').pop() === name);
    const bookEntry = findEntry('book.json');
    const cardsEntry = findEntry('cards.json');

    // 路径 A：成品直传
    if (bookEntry && cardsEntry) {
      const bookMeta = JSON.parse(bookEntry.getData().toString('utf-8'));
      const cardsRaw = JSON.parse(cardsEntry.getData().toString('utf-8'));
      const cardsArray = Array.isArray(cardsRaw) ? cardsRaw : (cardsRaw.cards || []);
      if (!bookMeta.title) return res.status(400).json({ error: 'missing_title' });

      let coverBuf = null, coverExt = null;
      for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
        const ce = findEntry(`cover.${ext}`);
        if (ce) { coverBuf = ce.getData(); coverExt = ext; break; }
      }
      const result = await persistBook(bookMeta, cardsArray, coverBuf, coverExt);
      try { fs.unlinkSync(tmp); } catch {}
      return res.json({ ok: true, mode: 'direct', id: result.id, book: result.book, cardCount: result.cardCount });
    }

    // 路径 B：素材生成
    const hasMarkdown = entries.some(e => !e.isDirectory && /\.(md|txt)$/i.test(e.entryName));
    if (!hasMarkdown) {
      try { fs.unlinkSync(tmp); } catch {}
      return res.status(400).json({ error: 'invalid_zip', detail: 'zip 需包含 book.json+cards.json，或 .md/.txt 素材' });
    }
    if (ccBusy) {
      try { fs.unlinkSync(tmp); } catch {}
      return res.status(409).json({ error: 'cc_busy', detail: `Claude 正在忙「${ccCurrentTask}」，稍后再试` });
    }

    const jobId = createBookJob();
    const extractDir = path.join(DATA_DIR, 'book_upload', jobId);
    fs.mkdirSync(extractDir, { recursive: true });
    zip.extractAllTo(extractDir, true);
    try { fs.unlinkSync(tmp); } catch {}

    runGenerateJob(jobId, extractDir, originalName);
    res.json({ ok: true, mode: 'generate', generating: true, jobId });
  } catch (err) {
    console.error('[books/upload]', err);
    try { fs.unlinkSync(tmp); } catch {}
    res.status(500).json({ error: 'parse_failed', detail: err.message });
  }
});

// Markdown / TXT 单文件上传
app.post('/api/books/upload-text', booksUpload.single('textFile'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const tmp = req.file.path;
  const originalName = req.file.originalname || 'notes.md';
  try {
    const material = fs.readFileSync(tmp, 'utf-8');
    if (!material.trim()) {
      try { fs.unlinkSync(tmp); } catch {}
      return res.status(400).json({ error: 'empty' });
    }
    if (ccBusy) {
      try { fs.unlinkSync(tmp); } catch {}
      return res.status(409).json({ error: 'cc_busy', detail: `Claude 正在忙「${ccCurrentTask}」` });
    }
    const jobId = createBookJob();
    // 把素材写到临时目录让 runGenerateJob 消费
    const extractDir = path.join(DATA_DIR, 'book_upload', jobId);
    fs.mkdirSync(extractDir, { recursive: true });
    fs.writeFileSync(path.join(extractDir, path.basename(originalName)), material, 'utf-8');
    try { fs.unlinkSync(tmp); } catch {}
    runGenerateJob(jobId, extractDir, originalName);
    res.json({ ok: true, mode: 'generate', generating: true, jobId });
  } catch (err) {
    console.error('[books/upload-text]', err);
    try { fs.unlinkSync(tmp); } catch {}
    res.status(500).json({ error: 'parse_failed', detail: err.message });
  }
});

// ============================================================
// PDF 上传：走 pdf2x.cn（insightdoc.memect.cn）转 Markdown，再生成卡片
// ============================================================
// 长超时 dispatcher：Node 内置 fetch 默认 headers timeout 5 分钟，大 PDF 提交会挂；
// 必须用 undici 自己的 fetch（内置 fetch 用的是 Node 内部 undici，dispatcher 接口不兼容）
const { Agent, fetch: undiciFetch, FormData: UndiciFormData } = require('undici');
const PDF2X_DISPATCHER = new Agent({
  headersTimeout: 15 * 60 * 1000,
  bodyTimeout:    15 * 60 * 1000,
  connectTimeout: 60 * 1000,
});

async function pdfToMarkdown(pdfPath, apiKey) {
  const buf = fs.readFileSync(pdfPath);
  const form = new UndiciFormData();
  const blob = new Blob([buf], { type: 'application/pdf' });
  form.append('file', blob, path.basename(pdfPath));

  const submit = await undiciFetch(`${PDF2X_ENDPOINT}/api/parse/pdf2markdown`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form,
    dispatcher: PDF2X_DISPATCHER,
  });
  if (!submit.ok) {
    const txt = await submit.text().catch(() => '');
    throw new Error(`pdf2x 提交失败 (${submit.status}): ${txt.slice(0, 200)}`);
  }
  const submitData = await submit.json();
  const taskId = submitData.task_id;
  if (!taskId) throw new Error('pdf2x 未返回 task_id：' + JSON.stringify(submitData).slice(0, 200));

  // 轮询，最多 10 分钟
  const started = Date.now();
  while (Date.now() - started < 10 * 60 * 1000) {
    await new Promise(r => setTimeout(r, 3000));
    const r = await undiciFetch(`${PDF2X_ENDPOINT}/api/parse/result/${encodeURIComponent(taskId)}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      dispatcher: PDF2X_DISPATCHER,
    });
    if (!r.ok) continue;
    const d = await r.json();
    if (d.status === 'done') {
      if (!d.download_url) throw new Error('pdf2x 完成但未返回 download_url');
      const mdRes = await undiciFetch(d.download_url, { dispatcher: PDF2X_DISPATCHER });
      if (!mdRes.ok) throw new Error(`下载 Markdown 失败 (${mdRes.status})`);
      return { markdown: await mdRes.text(), taskId, duration: d.duration };
    }
    if (d.status === 'failed') {
      throw new Error('pdf2x 解析失败：' + (d.error || d.message || 'unknown'));
    }
    // pending / running — 继续轮询
  }
  throw new Error('pdf2x 轮询超时（10 分钟）');
}

async function runPdfJob(jobId, pdfPath, originalName, apiKey) {
  try {
    updateBookJob(jobId, { status: 'running', progress: 'PDF 转 Markdown（pdf2x.cn 处理中，约 15-60 秒）…' });
    const { markdown } = await pdfToMarkdown(pdfPath, apiKey);
    if (!markdown || !markdown.trim()) throw new Error('pdf2x 返回的 Markdown 为空');

    updateBookJob(jobId, { progress: 'Claude 正在生成卡片（约 2-3 分钟）…' });
    const raw = await callClaude(buildCardsPrompt(markdown, 30), `PDF 生成:${originalName}`);
    const cleaned = stripJsonFence(raw);
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Claude 返回格式错误');
    const parsed = safeJsonParse(match[0]);
    const bookMeta = parsed.book || {};
    const cards = Array.isArray(parsed.cards) ? parsed.cards : [];
    if (!bookMeta.title) bookMeta.title = path.basename(originalName).replace(/\.pdf$/i, '');
    if (!cards.length) throw new Error('Claude 未生成任何卡片');

    updateBookJob(jobId, { progress: '保存到书架…' });
    const result = await persistBook(bookMeta, cards, null, null);
    try { fs.writeFileSync(path.join(bookDir(result.id), 'source.txt'), markdown, 'utf-8'); } catch {}
    updateBookJob(jobId, {
      status: 'done',
      progress: `生成完成 · ${result.cardCount} 张卡片`,
      bookId: result.id,
      book: result.book,
    });
  } catch (err) {
    console.error('[books/pdf]', err);
    updateBookJob(jobId, { status: 'error', error: err.message });
  } finally {
    try { fs.unlinkSync(pdfPath); } catch {}
  }
}

app.post('/api/books/upload-pdf', booksUpload.single('pdfFile'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const tmp = req.file.path;
  const originalName = req.file.originalname || 'document.pdf';

  // API Key 优先级：请求头 > 环境变量
  const apiKey = (req.headers['x-pdf2x-key'] || process.env.PDF2X_API_KEY || '').toString().trim();
  if (!apiKey) {
    try { fs.unlinkSync(tmp); } catch {}
    return res.status(400).json({
      error: 'no_api_key',
      detail: '请先设置 pdf2x.cn 的 API Key（右上角 🔑），或设置环境变量 PDF2X_API_KEY',
      keyPage: 'https://pdf2x.cn/api/apikey/page',
    });
  }
  if (ccBusy) {
    try { fs.unlinkSync(tmp); } catch {}
    return res.status(409).json({ error: 'cc_busy', detail: `Claude 正在忙「${ccCurrentTask}」` });
  }

  const jobId = createBookJob();
  runPdfJob(jobId, tmp, originalName, apiKey);
  res.json({ ok: true, mode: 'pdf', generating: true, jobId });
});

// ============================================================
// 启动
// ============================================================
app.listen(PORT, () => {
  console.log(`📚 卡片书斋 running at http://localhost:${PORT}`);
  console.log(`   Claude CLI: ${CLAUDE_CLI}`);
  console.log(`   Data dir:   ${DATA_DIR}`);
  console.log(`   pdf2x:      ${PDF2X_ENDPOINT}`);

  if (!process.env.NO_AUTO_OPEN) {
    const { exec } = require('child_process');
    const url = `http://localhost:${PORT}`;
    switch (process.platform) {
      case 'darwin': exec(`open "${url}"`); break;
      case 'win32': exec(`start "" "${url}"`); break;
      default: exec(`xdg-open "${url}"`); break;
    }
  }
});

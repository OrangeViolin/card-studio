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
const { Agent, fetch: undiciFetch, FormData: UndiciFormData } = require('undici');

// ============================================================
// 启动前加载 config.json（Electron 会把路径通过 CARD_CONFIG_FILE 传入）
// ============================================================
const CARD_CONFIG_FILE = process.env.CARD_CONFIG_FILE || '';
if (CARD_CONFIG_FILE && fs.existsSync(CARD_CONFIG_FILE)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CARD_CONFIG_FILE, 'utf-8'));
    for (const [k, v] of Object.entries(cfg)) {
      if (v != null && v !== '' && process.env[k] == null) {
        process.env[k] = String(v);
      }
    }
  } catch (err) {
    console.error('[config] 读取失败：', err.message);
  }
}

const app = express();
const PORT = process.env.PORT || 3013;
const DATA_DIR = process.env.CARD_DATA_DIR || path.join(__dirname, 'data');
const PDF2X_ENDPOINT = process.env.PDF2X_ENDPOINT || 'https://insightdoc.memect.cn';

// PDF 解析四选一（按 PDF_PARSE_URL 值判断）：
//   空 / 'local' / 未设  → 本地 pdf-parse（默认，离线可用，扫描件效果差）
//   http(s)://xxx        → V1 远程（如内网 http://192.168.41.107:7004/pdf_parse）
//   'pdf2x'              → pdf2x.cn（走 PDF2X_ENDPOINT + PDF2X_API_KEY，扫描件默认不 OCR）
//   'local-ppx'          → 本地 memect-ppx CLI（强制 --ocr yes，扫描件也能出正文，慢）
const PDF_PARSE_URL_RAW = (process.env.PDF_PARSE_URL ?? '').trim();
let PDF_PARSE_MODE = 'local';
let PDF_PARSE_URL = '';
if (/^https?:\/\//i.test(PDF_PARSE_URL_RAW)) {
  PDF_PARSE_MODE = 'v1';
  PDF_PARSE_URL = PDF_PARSE_URL_RAW;
} else if (PDF_PARSE_URL_RAW.toLowerCase() === 'pdf2x') {
  PDF_PARSE_MODE = 'pdf2x';
} else if (PDF_PARSE_URL_RAW.toLowerCase() === 'local-ppx') {
  PDF_PARSE_MODE = 'local-ppx';
}
// 本地 ppx 可执行文件（默认：项目下的 .ppx-venv）
const PPX_BIN = process.env.PPX_BIN || path.join(__dirname, '.ppx-venv', 'bin', 'ppx');

// LLM provider 三选一（按 LLM_PROVIDER 判断）：
//   'cli'（默认）→ 本地 Claude CLI（开发机用，需要装 claude 命令）
//   'mock'       → 离线假数据（跑通 UI 全流程，不依赖任何外部服务）
//   'http'       → OpenAI 兼容 HTTP（内网部署：LLM_API_URL + LLM_API_KEY + LLM_MODEL）
const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'mock').toLowerCase();
const LLM_API_URL = process.env.LLM_API_URL || '';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

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
// 静态资源兼容 Electron 打包：server.js 在 app.asar.unpacked，public 在 app.asar
const PUBLIC_DIR = (() => {
  const unpackedGuess = path.join(__dirname, 'public');
  if (fs.existsSync(unpackedGuess)) return unpackedGuess;
  const asarGuess = __dirname.replace(/app\.asar\.unpacked/, 'app.asar');
  return path.join(asarGuess, 'public');
})();
app.use(express.static(PUBLIC_DIR));

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
// LLM 调用（三种 provider：cli / mock / http，一次只能跑一个任务）
// ============================================================
let ccBusy = false;
let ccCurrentTask = '';

app.get('/api/cc/status', (_req, res) => {
  res.json({
    busy: ccBusy,
    task: ccCurrentTask,
    provider: LLM_PROVIDER,
    cli: LLM_PROVIDER === 'cli' ? CLAUDE_CLI : null,
  });
});

// ============================================================
// 设置面板（桌面 App 用）
// ============================================================
const SETTINGS_KEYS = [
  'LLM_PROVIDER',
  'LLM_API_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'PDF_PARSE_URL',
  'PDF2X_API_KEY',
];

function readSettingsFile() {
  if (!CARD_CONFIG_FILE || !fs.existsSync(CARD_CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CARD_CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeSettingsFile(obj) {
  if (!CARD_CONFIG_FILE) throw new Error('CARD_CONFIG_FILE 未配置（仅桌面 App 模式可用）');
  const dir = path.dirname(CARD_CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CARD_CONFIG_FILE, JSON.stringify(obj, null, 2), 'utf-8');
}

app.get('/api/settings', (_req, res) => {
  const saved = readSettingsFile();
  res.json({
    configFile: CARD_CONFIG_FILE || null,
    llmProvider: saved.LLM_PROVIDER || LLM_PROVIDER,
    llmApiUrl: saved.LLM_API_URL || '',
    llmModel: saved.LLM_MODEL || LLM_MODEL,
    pdfParseUrl: saved.PDF_PARSE_URL || '',
    hasLlmKey: Boolean(saved.LLM_API_KEY),
    hasPdf2xKey: Boolean(saved.PDF2X_API_KEY),
  });
});

app.post('/api/settings', (req, res) => {
  if (!CARD_CONFIG_FILE) {
    return res.status(400).json({ error: 'settings_unavailable', detail: '仅桌面 App 模式可用' });
  }
  try {
    const prev = readSettingsFile();
    const next = { ...prev };
    const body = req.body || {};
    for (const k of SETTINGS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(body, k)) {
        const v = body[k];
        if (v === '' || v == null) {
          delete next[k];
        } else {
          next[k] = String(v);
        }
      }
    }
    writeSettingsFile(next);
    res.json({ ok: true, restartRequired: true });
  } catch (err) {
    res.status(500).json({ error: 'write_failed', detail: err.message });
  }
});

function callClaude(prompt, taskName = '', timeoutMs = 10 * 60 * 1000) {
  if (ccBusy) return Promise.reject(new Error(`CC_BUSY:${ccCurrentTask}`));
  ccBusy = true;
  ccCurrentTask = taskName;
  const release = () => { ccBusy = false; ccCurrentTask = ''; };
  let p;
  if (LLM_PROVIDER === 'mock') p = callLLMMock(prompt);
  else if (LLM_PROVIDER === 'http') p = callLLMHttp(prompt, timeoutMs);
  else p = callClaudeCLI(prompt, timeoutMs);
  return p.then(
    v => { release(); return v; },
    e => { release(); throw e; },
  );
}

// ----- provider: Claude CLI（开发机默认） -----
function callClaudeCLI(prompt, timeoutMs) {
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
      reject(new Error(`Claude 超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (stdout.trim()) resolve(stdout.trim());
      else if (code !== 0) reject(new Error(`Claude exited ${code}: ${stderr.slice(0, 300)}`));
      else resolve('');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ----- provider: Mock（离线假数据，跑通 UI 全流程） -----
async function callLLMMock(prompt) {
  // prompt 尾部是 buildCardsPrompt 拼进来的素材正文；抽取「## 材料」之后的部分
  const marker = '## 材料';
  const idx = prompt.lastIndexOf(marker);
  const material = idx >= 0 ? prompt.slice(idx + marker.length) : prompt;

  // 模拟一点延迟，方便看到"生成中"进度
  await new Promise(r => setTimeout(r, 800));

  // 从素材里抽标题：优先 # 一级标题，其次第一行有内容的短行
  let title = '未命名（mock）';
  const h1 = material.match(/^#\s+(.+)$/m);
  if (h1) title = h1[1].trim().slice(0, 40);
  else {
    const firstLine = material.split(/\n+/).map(s => s.trim()).find(s => s.length >= 4 && s.length <= 40);
    if (firstLine) title = firstLine.slice(0, 40);
  }

  // 抽若干可读长度的行做卡片素材
  const lines = material
    .split(/\n+/)
    .map(l => l.replace(/^[#>*\-\d\.\s]+/, '').trim())
    .filter(l => l.length >= 12 && l.length <= 180);

  const pick = (arr, n) => arr.slice(0, n);
  const q = pick(lines, 8);
  const t = pick(lines.slice(8), 4);
  const a = pick(lines.slice(12), 3);
  const c = pick(lines.slice(15), 2);

  // 如果素材太短，塞点占位行
  while (q.length < 3) q.push('这是一张 mock 模式下的占位金句卡，用来验证 UI 链路。');
  while (t.length < 2) t.push('占位术语：用于演示卡片渲染');
  while (a.length < 2) a.push('下一步：跑通整条链路后再切到真实 LLM');

  const cards = [];
  q.forEach((s, i) => cards.push({
    id: `q${i + 1}`, type: 'quote',
    title: s.slice(0, 18),
    fields: { 金句: s, 作者: '(mock)', 语境: '离线演示', 为何性感: '用于验证卡片渲染' },
    source: 'mock',
  }));
  t.forEach((s, i) => cards.push({
    id: `tm${i + 1}`, type: 'term',
    title: s.slice(0, 14),
    fields: { 原始定义: s, 首创者: '(mock)', 所属学科: '演示', 一句话理解: s.slice(0, 40) },
    source: 'mock',
  }));
  a.forEach((s, i) => cards.push({
    id: `a${i + 1}`, type: 'action',
    title: s.slice(0, 14),
    fields: { 行动: s, 最小启动: '读一遍', 预期改变: '把 UI 跑通', 触发场景: '上传素材后' },
    source: 'mock',
  }));
  c.forEach((s, i) => cards.push({
    id: `cn${i + 1}`, type: 'counter',
    title: s.slice(0, 14),
    fields: { 常识: '要接真实大模型才能测', 反常识: s, 证据类型: '占位', 出处: 'mock' },
    source: 'mock',
  }));

  const result = {
    book: {
      title,
      author: '(mock)',
      subtitle: '',
      description: 'mock 模式自动生成，仅用于 UI 演示',
      tapeColor: '#A7D7B5',
      accentColor: '#1F3D2C',
    },
    cards,
  };
  return JSON.stringify(result);
}

// ----- provider: OpenAI 兼容 HTTP（内网部署） -----
async function callLLMHttp(prompt, timeoutMs) {
  if (!LLM_API_URL) throw new Error('LLM_PROVIDER=http 需要设置 LLM_API_URL');
  const dispatcher = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  async function requestOnce(maxTokens) {
    return await undiciFetch(LLM_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(LLM_API_KEY ? { authorization: `Bearer ${LLM_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: maxTokens,
        stream: false,
      }),
      dispatcher,
    });
  }
  // 先试 8000，被某些模型拒了自动回退 4000
  let resp = await requestOnce(8000);
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    if (resp.status === 400 && /max[_-]?tokens/i.test(detail)) {
      resp = await requestOnce(4000);
      if (!resp.ok) {
        const d2 = await resp.text().catch(() => '');
        throw new Error(`LLM HTTP ${resp.status}: ${d2.slice(0, 300)}`);
      }
    } else {
      throw new Error(`LLM HTTP ${resp.status}: ${detail.slice(0, 300)}`);
    }
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content
    || data?.choices?.[0]?.text
    || data?.output_text
    || '';
  if (!text) throw new Error('LLM HTTP 返回为空');
  return String(text).trim();
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
    materialStats: bookMeta.materialStats || null,
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

// Claude CLI 的 context 大概 200K token，给 prompt 骨架和输出留空间后
// 素材最多约 120K 字符。超过就均匀采样——头部+尾部完整，中间按段截取，
// 这样全书章节都能被看到，不至于只读到前几章。
const MAX_MATERIAL_CHARS = 120_000;
function trimMaterial(material) {
  const s = String(material || '');
  if (s.length <= MAX_MATERIAL_CHARS) return s;
  const segments = 20;
  const budget = MAX_MATERIAL_CHARS - 200; // 留点 overhead 给分隔符
  const perSeg = Math.floor(budget / segments);
  const step = Math.floor(s.length / segments);
  const parts = [];
  for (let i = 0; i < segments; i++) {
    const start = i * step;
    parts.push(s.slice(start, start + perSeg));
  }
  return parts.join('\n\n—— 略 ——\n\n');
}

// 素材质量诊断：扫描 PDF 常只剩分隔符和图片占位符，要让垃圾素材可见
function analyzeMaterial(md) {
  const s = String(md || '');
  const total = s.length;
  const separators = (s.match(/^-{10,}$/gm) || []).length;
  const images = (s.match(/!\[.*?\]\(.*?\)/g) || []).length;
  const zh = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  return {
    total,
    zh,
    separators,
    images,
    zhRatio: total > 0 ? zh / total : 0,
    quality: zh < 2000 ? 'low' : zh < 15000 ? 'medium' : 'high',
    warning: zh < 2000
      ? `素材有效中文仅 ${zh} 字，疑似扫描 PDF 的 OCR 失败，生成的卡片仅供参考`
      : null,
  };
}

// 根据素材质量估算一次生成的目标张数：约每 300 字一张，上限 80（单次 call 天花板）
function computeTargetCount(stats) {
  if (!stats || !stats.zh) return 15;
  if (stats.quality === 'low') return Math.max(5, Math.floor(stats.zh / 400));
  return Math.min(80, Math.max(15, Math.floor(stats.zh / 300)));
}

function buildCardsPrompt(material, targetCount = 30, stats = null) {
  material = trimMaterial(material);
  const qualityLine = stats
    ? `- 素材诊断：有效中文 ${stats.zh} 字，质量 ${stats.quality}${stats.warning ? `；⚠️ ${stats.warning}` : ''}`
    : '';
  return `你是一位严谨的读书笔记整理师。请把下面的素材，转成"卡片书斋"需要的书籍+卡片 JSON 数据。

## 铁律（违反会被拒稿）

1. **只用素材里明确出现的事实**：不要脑补、不要用外部常识补充。素材没写的就不写。
2. **禁用软弱词**：不要出现"据说/可能/也许/相传/大概/应该"等不确定词。
3. **每张卡必须带 source 字段**：从素材里原文引用 20-60 字作为直接依据，能在素材里搜到的真实引文，不是章节名。
4. **宁缺毋滥**：素材支撑不了目标张数时，返回少一点是合规的；编造/硬凑会被拒稿。
5. **禁止重复**：同一 term / 人名 / 反常识观点 / 金句只出现一次。

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
    { "id": "t1", "type": "term", "title": "...", "fields": { ... }, "source": "素材原文引用 20-60 字" }
  ]
}

## 要求

- **目标 ${targetCount} 张卡片**（以素材支撑为上限，支撑不够就少给，不要硬凑）
${qualityLine}
- 类型分布均衡（素材有料则每种至少 3 张，wild 可选）
- fields 内容高信息密度、具体、带数字/案例；禁止水句和泛泛描述
- 每张卡独立可读，不依赖其他卡
- tapeColor 和 accentColor 选择 1 组符合书籍气质的颜色（tapeColor 偏亮、accentColor 偏深）
- id 用 t1/p1/c1/q1/a1/tk1/w1 这类简短前缀 + 序号

## 材料
${material}

记住：目标 ${targetCount} 张（素材不支撑就少给），每张必须带 source 真实引文，只输出 JSON，不要任何其它文字、不要 markdown 代码块。
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
// 分块 & 去重 & 统一生成调度器
// ============================================================

// 按 H2 → H3 → 硬切 三级策略切分长素材
function splitMaterial(md, maxChunkChars = 25000) {
  const s = String(md || '');
  if (s.length <= maxChunkChars) return [s];

  let parts = splitByHeading(s, /^##\s+/);
  // 合并过小碎片（< maxChunkChars / 4）到相邻块，避免浪费 LLM 调用
  parts = mergeSmallChunks(parts, Math.floor(maxChunkChars / 4), maxChunkChars);
  if (parts.every(p => p.length <= maxChunkChars)) return parts;

  parts = parts.flatMap(p => p.length <= maxChunkChars ? [p] : splitByHeading(p, /^###\s+/));
  parts = mergeSmallChunks(parts, Math.floor(maxChunkChars / 4), maxChunkChars);
  if (parts.every(p => p.length <= maxChunkChars)) return parts;

  return parts.flatMap(p => p.length <= maxChunkChars ? [p] : hardSplit(p, maxChunkChars));
}

function splitByHeading(s, headingRe) {
  const lines = s.split('\n');
  const parts = [];
  let buf = [];
  for (const l of lines) {
    if (headingRe.test(l) && buf.length > 0 && buf.join('\n').trim()) {
      parts.push(buf.join('\n'));
      buf = [l];
    } else {
      buf.push(l);
    }
  }
  if (buf.length) parts.push(buf.join('\n'));
  return parts.filter(p => p.trim());
}

function mergeSmallChunks(parts, minSize, maxSize) {
  const out = [];
  let cur = '';
  for (const p of parts) {
    if (!cur) { cur = p; continue; }
    if (cur.length < minSize && cur.length + p.length <= maxSize) {
      cur = cur + '\n\n' + p;
    } else {
      out.push(cur);
      cur = p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function hardSplit(s, maxChars) {
  const parts = [];
  for (let i = 0; i < s.length; i += maxChars) parts.push(s.slice(i, i + maxChars));
  return parts;
}

// 去重：同 type + 同 title 前 20 字 视为重复，保留 fields 更丰富的那张
function dedupeCards(cards) {
  const best = new Map();
  for (const c of cards) {
    const title = String(c.title || '').trim().slice(0, 20);
    const key = `${c.type || 'wild'}::${title}`;
    const size = JSON.stringify(c.fields || {}).length;
    const prev = best.get(key);
    if (!prev || size > prev.size) best.set(key, { card: c, size });
  }
  // 保持首次出现顺序
  const seen = new Set();
  const order = [];
  for (const c of cards) {
    const title = String(c.title || '').trim().slice(0, 20);
    const key = `${c.type || 'wild'}::${title}`;
    if (!seen.has(key)) { seen.add(key); order.push(key); }
  }
  return order.map(k => best.get(k).card);
}

// 核心：一次 LLM 调用 → { book, cards }
async function callLLMForCards(material, targetCount, stats, taskLabel, debugWrite) {
  const raw = await callClaude(buildCardsPrompt(material, targetCount, stats), taskLabel);
  if (debugWrite) {
    try { debugWrite(raw); } catch {}
  }
  const cleaned = stripJsonFence(raw);
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    const preview = (raw || '').slice(0, 400).replace(/\s+/g, ' ');
    throw new Error(`LLM 返回里没有 JSON 对象。前 400 字：${preview || '(空)'}`);
  }
  const parsed = safeJsonParse(match[0]);
  return {
    book: parsed.book || {},
    cards: Array.isArray(parsed.cards) ? parsed.cards : [],
  };
}

// 调度器：短素材一次生成；长素材（zh ≥ 15000）按 H2/H3 分块串行
async function generateCardsForMaterial(material, stats, taskLabel, onProgress, debugWrite) {
  if (stats.zh < 15000) {
    const target = computeTargetCount(stats);
    onProgress?.(`Claude 生成约 ${target} 张卡片（约 2-3 分钟）…`);
    return await callLLMForCards(material, target, stats, taskLabel, debugWrite);
  }
  const chunks = splitMaterial(material, 25000);
  let book = null;
  const all = [];
  let failed = 0;
  for (let i = 0; i < chunks.length; i++) {
    const cst = analyzeMaterial(chunks[i]);
    const t = Math.min(40, Math.max(20, Math.floor(cst.zh / 500)));
    onProgress?.(`分块 ${i + 1}/${chunks.length} 生成中…（累计 ${all.length} 张，目标 ${t}）`);
    try {
      const r = await callLLMForCards(
        chunks[i], t, cst,
        `${taskLabel}[${i + 1}/${chunks.length}]`,
        debugWrite ? (raw) => debugWrite(raw, i + 1) : null,
      );
      if (!book && r.book && r.book.title) book = r.book;
      if (Array.isArray(r.cards)) all.push(...r.cards);
    } catch (e) {
      failed++;
      console.error(`[chunk ${i + 1}/${chunks.length}]`, e.message);
    }
  }
  if (!all.length) {
    throw new Error(`全部 ${chunks.length} 块生成失败（失败 ${failed} 块）`);
  }
  const deduped = dedupeCards(all);
  onProgress?.(`分块合并：原始 ${all.length} 张 → 去重后 ${deduped.length} 张${failed ? ` · 失败 ${failed} 块` : ''}`);
  return { book: book || {}, cards: deduped };
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

    const stats = analyzeMaterial(material);
    updateBookJob(jobId, { progress: `素材 ${stats.zh} 中文字（${stats.quality}），准备生成…` });
    const { book: bookMeta, cards } = await generateCardsForMaterial(
      material, stats, `生成卡片:${originalName}`,
      (msg) => updateBookJob(jobId, { progress: msg }),
    );
    if (!bookMeta.title) bookMeta.title = path.basename(originalName).replace(/\.(zip|md|txt|pdf)$/i, '');
    if (!cards.length) throw new Error('Claude 未生成任何卡片');
    bookMeta.materialStats = stats;

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
const PDF2X_DISPATCHER = new Agent({
  headersTimeout: 15 * 60 * 1000,
  bodyTimeout:    15 * 60 * 1000,
  connectTimeout: 60 * 1000,
});

// 剥掉 pdf-parse v2 自插的 `-- N of M --` 页码分隔符，用来判断实际文本量
function stripPageMarkers(s) {
  return String(s || '').replace(/--\s*\d+\s*of\s*\d+\s*--/gi, '').replace(/\s+/g, '').trim();
}

// 本地解析：pdf-parse v2（默认路径，离线可用，文本型 PDF 效果好、扫描件效果差）
async function pdfToMarkdownLocal(pdfPath) {
  const { PDFParse } = require('pdf-parse');
  const buf = fs.readFileSync(pdfPath);
  // pdf-parse v2 接受 Uint8Array / ArrayBuffer
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    const text = String(result?.text || '').trim();
    const pages = result?.pages?.length ?? result?.total ?? 0;
    // 去掉页码标记后的真实字符数：扫描版常常只剩 `-- N of M --`
    const realChars = stripPageMarkers(text).length;
    const minChars = Math.max(200, pages * 10);
    if (!text || realChars < minChars) {
      throw new Error(
        `本地 pdf-parse 只抽到 ${realChars} 个有效字符（共 ${pages} 页），基本是扫描版 PDF。` +
        `本地模式不能处理扫描件，请改用 V1 或 pdf2x 模式（前者需要自建 parse 服务，后者在右上角 🔑 填 API Key）`
      );
    }
    return { markdown: text, pages };
  } finally {
    try { await parser.destroy(); } catch {}
  }
}

// V1 协议：远程 parse 服务（对应 parse_pdf_util.py 的 _parse_pdf_v1）
async function pdfToMarkdownV1(pdfPath) {
  if (!PDF_PARSE_URL) throw new Error('未配置 PDF_PARSE_URL 环境变量');
  const buf = fs.readFileSync(pdfPath);
  const parseParams = { use_llm: true, output_files: ['doc.md'] };

  // 1. 提交
  const submitUrl = new URL(PDF_PARSE_URL);
  submitUrl.searchParams.set('params', JSON.stringify(parseParams));
  submitUrl.searchParams.set('async', 'true');
  const submit = await undiciFetch(submitUrl.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: buf,
    dispatcher: PDF2X_DISPATCHER,
  });
  if (!submit.ok) {
    const txt = await submit.text().catch(() => '');
    throw new Error(`V1 提交失败 (${submit.status}): ${txt.slice(0, 200)}`);
  }
  const submitData = await submit.json();
  const taskId = submitData?.data?.id || submitData?.task_id || submitData?.id;
  if (!taskId) throw new Error('V1 未返回 task_id：' + JSON.stringify(submitData).slice(0, 200));

  // 2. 轮询
  const pollUrl = new URL(PDF_PARSE_URL);
  pollUrl.searchParams.set('task_id', taskId);
  const started = Date.now();
  while (Date.now() - started < 30 * 60 * 1000) {
    await new Promise(r => setTimeout(r, 3000));
    let poll;
    try {
      poll = await undiciFetch(pollUrl.toString(), { dispatcher: PDF2X_DISPATCHER });
    } catch { continue; }
    if (!poll.ok) continue;
    const ct = poll.headers.get('content-type') || '';
    if (!ct.startsWith('application/json')) {
      // ZIP 返回 = 完成
      const zipBuf = Buffer.from(await poll.arrayBuffer());
      const zip = new AdmZip(zipBuf);
      const docEntry = zip.getEntries().find(e => !e.isDirectory && e.entryName.split('/').pop() === 'doc.md');
      if (!docEntry) throw new Error('V1 返回 ZIP 中未找到 doc.md');
      return { markdown: docEntry.getData().toString('utf-8'), taskId };
    }
    const data = await poll.json();
    if (data.status === 'failed' || data.status === 'error') {
      throw new Error('V1 解析失败：' + (data.error || data.message || 'unknown'));
    }
  }
  throw new Error('V1 轮询超时（30 分钟）');
}

// 本地 ppx：spawn memect-ppx CLI，强制 --ocr yes，输出 doc.md
// 可选 onProgress 回调，用于把子进程 stdout 的阶段信息透传给 job.progress
async function pdfToMarkdownLocalPPX(pdfPath, onProgress) {
  const { spawn } = require('child_process');
  if (!fs.existsSync(PPX_BIN)) {
    throw new Error(`ppx 可执行文件不存在：${PPX_BIN}。安装：uv venv .ppx-venv --python 3.12 && uv pip install --python .ppx-venv/bin/python memect-ppx onnxruntime opencv-contrib-python`);
  }
  const outDir = path.join(DATA_DIR, 'ppx_out', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(outDir, { recursive: true });
  const args = ['parse', pdfPath, '--ocr', 'yes', '--md', '-o', outDir, '--cpu'];
  await new Promise((resolve, reject) => {
    const p = spawn(PPX_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let lastLine = '';
    const onData = (buf) => {
      const s = buf.toString();
      const lines = s.split(/\r?\n/).filter(Boolean);
      if (lines.length) lastLine = lines[lines.length - 1];
      // 从 ppx 日志里抓阶段关键字
      const m = s.match(/(layout|ocr|formula|table|parser|pdf2image)[^\n]{0,80}/i);
      if (m && onProgress) {
        try { onProgress(`ppx 本地 OCR：${m[0].slice(0, 80)}`); } catch {}
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', reject);
    p.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ppx parse 退出码 ${code}：${lastLine.slice(0, 200)}`));
    });
  });
  const mdPath = path.join(outDir, 'doc.md');
  if (!fs.existsSync(mdPath)) throw new Error(`ppx 未生成 doc.md：${mdPath}`);
  const markdown = fs.readFileSync(mdPath, 'utf-8');
  return { markdown };
}

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

async function runPdfJob(jobId, pdfPath, originalName, apiKey, mode) {
  try {
    const progressMsg = {
      local:        'PDF 转文本（本地 pdf-parse，约 5-15 秒）…',
      v1:           'PDF 转 Markdown（自建 parse 服务处理中，可能需要几分钟）…',
      pdf2x:        'PDF 转 Markdown（pdf2x.cn 处理中，约 15-60 秒）…',
      'local-ppx':  'PDF 转 Markdown（本地 memect-ppx + OCR，扫描件也能抽，慢，可能要几分钟到几十分钟）…',
    }[mode] || 'PDF 处理中…';
    updateBookJob(jobId, { status: 'running', progress: progressMsg });
    const onPpxProgress = (msg) => updateBookJob(jobId, { progress: msg });
    const { markdown } =
      mode === 'local'     ? await pdfToMarkdownLocal(pdfPath) :
      mode === 'v1'        ? await pdfToMarkdownV1(pdfPath) :
      mode === 'local-ppx' ? await pdfToMarkdownLocalPPX(pdfPath, onPpxProgress) :
                             await pdfToMarkdown(pdfPath, apiKey);
    if (!markdown || !markdown.trim()) throw new Error(`PDF 解析（${mode}）返回空内容`);
    // 统一护栏：去掉页码/空白后实际字符数过少 = 扫描件或空 PDF，不要喂给 Claude（它会幻觉）
    const realChars = stripPageMarkers(markdown).length;
    if (realChars < 200) {
      throw new Error(
        `PDF 解析（${mode}）只抽出 ${realChars} 个有效字符，基本是扫描版或空文档。` +
        `本地模式抽不出，请换 V1 或 pdf2x 模式重试`
      );
    }

    const stats = analyzeMaterial(markdown);
    updateBookJob(jobId, { progress: `素材 ${stats.zh} 中文字（${stats.quality}），准备生成…` });
    const debugDir = path.join(DATA_DIR, 'llm_debug');
    try { if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true }); } catch {}
    const debugWrite = (raw, chunkIdx) => {
      const name = chunkIdx ? `${jobId}.chunk${chunkIdx}.txt` : `${jobId}.txt`;
      try { fs.writeFileSync(path.join(debugDir, name), raw || '(empty)', 'utf-8'); } catch {}
    };
    const { book: bookMeta, cards } = await generateCardsForMaterial(
      markdown, stats, `PDF 生成:${originalName}`,
      (msg) => updateBookJob(jobId, { progress: msg }),
      debugWrite,
    );
    if (!bookMeta.title) bookMeta.title = path.basename(originalName).replace(/\.pdf$/i, '');
    if (!cards.length) throw new Error('Claude 未生成任何卡片');
    bookMeta.materialStats = stats;

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

  // 按 PDF_PARSE_MODE 分派
  let apiKey = '';
  if (PDF_PARSE_MODE === 'pdf2x') {
    apiKey = (req.headers['x-pdf2x-key'] || process.env.PDF2X_API_KEY || '').toString().trim();
    if (!apiKey) {
      try { fs.unlinkSync(tmp); } catch {}
      return res.status(400).json({
        error: 'no_api_key',
        detail: '当前模式 pdf2x.cn 需要 API Key（右上角 🔑），或改 PDF_PARSE_URL 为空走本地解析',
        keyPage: 'https://pdf2x.cn/api/apikey/page',
      });
    }
  }
  if (ccBusy) {
    try { fs.unlinkSync(tmp); } catch {}
    return res.status(409).json({ error: 'cc_busy', detail: `Claude 正在忙「${ccCurrentTask}」` });
  }

  const jobId = createBookJob();
  runPdfJob(jobId, tmp, originalName, apiKey, PDF_PARSE_MODE);
  res.json({ ok: true, mode: `pdf-${PDF_PARSE_MODE}`, generating: true, jobId });
});

// ============================================================
// 通用：从一段纯文本 material 走 Claude 生成 → 落盘
// ============================================================
async function runMaterialJob(jobId, material, fallbackTitle, progressHint = 'Claude 正在生成卡片（约 2-3 分钟）…') {
  try {
    if (!material || !material.trim()) throw new Error('素材为空');
    const stats = analyzeMaterial(material);
    updateBookJob(jobId, { status: 'running', progress: progressHint });
    const { book: bookMeta, cards } = await generateCardsForMaterial(
      material, stats, `生成卡片:${fallbackTitle}`,
      (msg) => updateBookJob(jobId, { progress: msg }),
    );
    if (!bookMeta.title) bookMeta.title = fallbackTitle;
    if (!cards.length) throw new Error('Claude 未生成任何卡片');
    bookMeta.materialStats = stats;

    updateBookJob(jobId, { progress: '保存到书架…' });
    const result = await persistBook(bookMeta, cards, null, null);
    try { fs.writeFileSync(path.join(bookDir(result.id), 'source.txt'), material, 'utf-8'); } catch {}
    updateBookJob(jobId, {
      status: 'done',
      progress: `生成完成 · ${result.cardCount} 张卡片`,
      bookId: result.id,
      book: result.book,
    });
  } catch (err) {
    console.error('[materialJob]', err);
    updateBookJob(jobId, { status: 'error', error: err.message });
  }
}

function htmlToText(html) {
  // 粗略抽正文：去 script/style/nav/footer，再 strip tags
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

// ------------------------------------------------------------
// [A] URL 抓取：给个链接，抓网页 → 生成卡片
// ------------------------------------------------------------
app.post('/api/books/upload-url', async (req, res) => {
  const url = (req.body?.url || '').toString().trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'invalid_url', detail: '请提供 http(s) 开头的 URL' });
  }
  if (ccBusy) {
    return res.status(409).json({ error: 'cc_busy', detail: `Claude 正在忙「${ccCurrentTask}」` });
  }
  const jobId = createBookJob();
  (async () => {
    try {
      updateBookJob(jobId, { status: 'running', progress: '抓取网页…' });
      const r = await undiciFetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 card-studio' },
        dispatcher: PDF2X_DISPATCHER,
      });
      if (!r.ok) throw new Error(`抓取失败 ${r.status}`);
      const html = await r.text();
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : new URL(url).hostname;
      const body = htmlToText(html);
      const material = `# ${title}\n来源: ${url}\n\n${body.slice(0, 180000)}`;
      await runMaterialJob(jobId, material, title);
    } catch (err) {
      console.error('[upload-url]', err);
      updateBookJob(jobId, { status: 'error', error: err.message });
    }
  })();
  res.json({ ok: true, mode: 'url', generating: true, jobId });
});

// ------------------------------------------------------------
// [B] 粘贴文本：{ text, title? } → 生成卡片
// ------------------------------------------------------------
app.post('/api/books/paste', async (req, res) => {
  const text = (req.body?.text || '').toString();
  const title = (req.body?.title || '剪贴板笔记').toString().trim() || '剪贴板笔记';
  if (!text.trim()) return res.status(400).json({ error: 'empty' });
  if (ccBusy) return res.status(409).json({ error: 'cc_busy', detail: `Claude 正在忙「${ccCurrentTask}」` });
  const jobId = createBookJob();
  runMaterialJob(jobId, `# ${title}\n\n${text}`, title);
  res.json({ ok: true, mode: 'paste', generating: true, jobId });
});

// ------------------------------------------------------------
// [C] 订阅/导入远端 cards.json（或 book.json+cards.json）
// POST { url } → 从远端拉 JSON/ZIP 成品直接落盘
// ------------------------------------------------------------
app.post('/api/books/subscribe', async (req, res) => {
  const url = (req.body?.url || '').toString().trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'invalid_url' });
  }
  try {
    const r = await undiciFetch(url, { dispatcher: PDF2X_DISPATCHER });
    if (!r.ok) throw new Error(`拉取失败 ${r.status}`);
    const ct = r.headers.get('content-type') || '';
    // ZIP
    if (ct.includes('zip') || /\.zip(\?|$)/i.test(url)) {
      const buf = Buffer.from(await r.arrayBuffer());
      const zip = new AdmZip(buf);
      const entries = zip.getEntries();
      const find = (name) => entries.find(e => !e.isDirectory && e.entryName.split('/').pop() === name);
      const bookEntry = find('book.json');
      const cardsEntry = find('cards.json');
      if (!bookEntry || !cardsEntry) throw new Error('ZIP 缺少 book.json 或 cards.json');
      const bookMeta = JSON.parse(bookEntry.getData().toString('utf-8'));
      const cardsRaw = JSON.parse(cardsEntry.getData().toString('utf-8'));
      const cardsArray = Array.isArray(cardsRaw) ? cardsRaw : (cardsRaw.cards || []);
      let coverBuf = null, coverExt = null;
      for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
        const ce = find(`cover.${ext}`);
        if (ce) { coverBuf = ce.getData(); coverExt = ext; break; }
      }
      const result = await persistBook(bookMeta, cardsArray, coverBuf, coverExt);
      return res.json({ ok: true, mode: 'subscribe-zip', id: result.id, book: result.book, cardCount: result.cardCount });
    }
    // JSON：可以是 {book, cards} 或 纯 cards 数组
    const data = await r.json();
    let bookMeta, cardsArray;
    if (Array.isArray(data)) {
      bookMeta = { title: new URL(url).pathname.split('/').pop() || '订阅卡片集' };
      cardsArray = data;
    } else {
      bookMeta = data.book || { title: data.title || '订阅卡片集' };
      cardsArray = Array.isArray(data.cards) ? data.cards : [];
    }
    if (!cardsArray.length) throw new Error('远端未返回任何卡片');
    const result = await persistBook(bookMeta, cardsArray, null, null);
    res.json({ ok: true, mode: 'subscribe-json', id: result.id, book: result.book, cardCount: result.cardCount });
  } catch (err) {
    console.error('[subscribe]', err);
    res.status(500).json({ error: 'subscribe_failed', detail: err.message });
  }
});

// ============================================================
// 启动
// ============================================================
app.listen(PORT, () => {
  console.log(`📚 卡片书斋 running at http://localhost:${PORT}`);
  const llmInfo = {
    cli:  `Claude CLI (${CLAUDE_CLI})`,
    mock: 'mock (离线假数据，零依赖)',
    http: `http (${LLM_API_URL || '<未设 LLM_API_URL>'}, model=${LLM_MODEL})`,
  }[LLM_PROVIDER] || `unknown (${LLM_PROVIDER})`;
  console.log(`   LLM:        ${llmInfo}`);
  console.log(`   Data dir:   ${DATA_DIR}`);
  const pdfInfo = {
    local:       'local (pdf-parse, 离线)',
    v1:          `v1 (${PDF_PARSE_URL})`,
    pdf2x:       `pdf2x.cn (${PDF2X_ENDPOINT})`,
    'local-ppx': `local-ppx (${PPX_BIN})`,
  }[PDF_PARSE_MODE];
  console.log(`   PDF parse:  ${pdfInfo}`);

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

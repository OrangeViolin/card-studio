// 卡片书斋 · 书架

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

// ===== 主题 =====
const THEMES = ['cream', 'mint', 'ink'];
function getTheme() { return localStorage.getItem('cs.theme') || 'cream'; }
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('cs.theme', t);
}
setTheme(getTheme());
$('#themeBtn').addEventListener('click', () => {
  const cur = getTheme();
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  setTheme(next);
});

// ===== 渲染书架 =====
const TAPE_CLASSES = ['', 'tape-b', 'tape-c'];
// 无 tapeColor 时的 fallback 色板
const FALLBACK_PALETTES = [
  { tape: '#F6C453', ink: '#3C2E1F' },
  { tape: '#A7D7B5', ink: '#1F3D2C' },
  { tape: '#F7A5A5', ink: '#4A1F22' },
  { tape: '#A8C8F0', ink: '#1E2E5E' },
  { tape: '#E4B9E4', ink: '#3E1F42' },
  { tape: '#F0C59B', ink: '#3E2818' },
];

// #RRGGBB → {r,g,b}
function hexToRgb(hex) {
  if (!hex) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHex({ r, g, b }) {
  const c = x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
// 变暗/变亮
function shade(hex, amount) {
  const c = hexToRgb(hex); if (!c) return hex;
  const t = amount < 0 ? 0 : 255;
  const p = Math.abs(amount);
  return rgbToHex({ r: c.r + (t - c.r) * p, g: c.g + (t - c.g) * p, b: c.b + (t - c.b) * p });
}
// YIQ 亮度——亮则用深色文字
function isLight(hex) {
  const c = hexToRgb(hex); if (!c) return true;
  return (c.r * 299 + c.g * 587 + c.b * 114) / 1000 > 160;
}

// 根据书名稳定取一个 fallback 色板（相同书每次一致）
function fallbackPalette(title) {
  let h = 0;
  for (const ch of String(title || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK_PALETTES[h % FALLBACK_PALETTES.length];
}

// 封面所需的 4 个颜色：背景 light→dark 两色 + 顶部色条 + 文字色
function coverPalette(book) {
  const fb = fallbackPalette(book.title);
  const tape = book.tapeColor && hexToRgb(book.tapeColor) ? book.tapeColor : fb.tape;
  let accent = book.accentColor && hexToRgb(book.accentColor) ? book.accentColor : null;
  if (!accent || accent.toLowerCase() === tape.toLowerCase()) {
    accent = shade(tape, -0.45);
  }
  // 渐变：tape 从亮到 +10% 加亮，再到 tape 本色
  const top = shade(tape, 0.15);
  const bottom = shade(tape, -0.08);
  const ink = isLight(tape) ? shade(accent, -0.35) : '#F8F4E8';
  const sub = isLight(tape) ? shade(accent, -0.15) : 'rgba(255,255,255,.7)';
  return { tape, accent, top, bottom, ink, sub };
}

// 作者首字（中文取首字，英文取首字母），用作装饰大字
function authorInitial(author) {
  if (!author) return '📖';
  const s = String(author).trim();
  // 中文
  const cn = s.match(/[\u4e00-\u9fff]/);
  if (cn) return cn[0];
  // 英文
  const en = s.match(/[A-Za-z]/);
  if (en) return en[0].toUpperCase();
  return s[0] || '📖';
}

function renderBookCover(book) {
  const p = coverPalette(book);
  const initial = authorInitial(book.author);
  // 用 SVG 做装饰性斜线/网格，避免纯色单调
  const decor = `
    <svg class="cover-decor" viewBox="0 0 100 140" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <pattern id="dots-${book.id.slice(0,6)}" x="0" y="0" width="8" height="8" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="1" fill="${p.ink}" fill-opacity=".08"/>
        </pattern>
      </defs>
      <rect width="100" height="140" fill="url(#dots-${book.id.slice(0,6)})"/>
      <circle cx="86" cy="18" r="34" fill="${p.accent}" fill-opacity=".14"/>
      <circle cx="10" cy="120" r="22" fill="${p.accent}" fill-opacity=".1"/>
    </svg>
  `;
  const topBand = `<div class="cover-band" style="background:${p.accent}"></div>`;
  const initialBadge = `<div class="cover-initial" style="color:${p.accent};border-color:${p.accent}">${escapeHtml(initial)}</div>`;
  const desc = book.subtitle || book.description || '';
  return `
    <div class="book-cover"
         style="--c-top:${p.top};--c-bottom:${p.bottom};--c-ink:${p.ink};--c-sub:${p.sub};--c-accent:${p.accent}">
      ${decor}
      ${topBand}
      ${initialBadge}
      <div class="cover-body">
        <div class="cover-title" style="color:${p.ink}">${escapeHtml(book.title)}</div>
        ${desc ? `<div class="cover-sub" style="color:${p.sub}">${escapeHtml(desc)}</div>` : ''}
      </div>
      <div class="cover-footer">
        <span class="cover-author" style="color:${p.ink};opacity:.85">${escapeHtml(book.author || '佚名')}</span>
        <span class="cover-count" style="background:${p.accent};color:${isLight(p.accent) ? '#222' : '#fff'}">${book.cardCount || 0} 卡</span>
      </div>
    </div>
  `;
}

async function loadBooks() {
  try {
    const res = await fetch('/api/books');
    const data = await res.json();
    renderBooks(data.books || []);
  } catch (e) {
    console.error(e);
    $('#shelfHint').textContent = '加载失败：' + e.message;
  }
}

function renderBooks(books) {
  const grid = $('#bookGrid');
  const empty = $('#emptyState');
  const hint = $('#shelfHint');

  if (!books.length) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    hint.textContent = '还没有书呢，上传一本开始吧 ↗';
    return;
  }

  empty.classList.add('hidden');
  hint.textContent = `共 ${books.length} 本书 · ${books.reduce((a, b) => a + (b.cardCount || 0), 0)} 张卡片`;

  grid.innerHTML = books.map((b, i) => {
    const tapeCls = TAPE_CLASSES[i % 3];
    return `
      <article class="book-card ${tapeCls}" data-id="${b.id}">
        <span class="book-tape"></span>
        <button class="book-delete" data-delete="${b.id}" title="删除">×</button>
        ${renderBookCover(b)}
        <div class="book-meta">
          <span>${fmtDate(b.updatedAt || b.createdAt)}</span>
          <span class="book-id-chip">#${String(b.id).slice(0, 6)}</span>
        </div>
      </article>
    `;
  }).join('');

  // 如果真的有上传的 cover 图片，覆盖掉程序化封面
  $$('.book-card').forEach(el => {
    const id = el.dataset.id;
    const img = new Image();
    img.onload = () => {
      const cover = el.querySelector('.book-cover');
      if (!cover) return;
      cover.classList.add('has-image');
      cover.style.backgroundImage = `url(${img.src})`;
    };
    img.src = `/api/books/${id}/cover`;
  });

  // 点击进入
  $$('.book-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-delete]')) return;
      const id = card.dataset.id;
      location.href = `book.html?id=${encodeURIComponent(id)}`;
    });
  });

  // 删除
  $$('[data-delete]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.delete;
      if (!confirm('确定删除这本书？卡片也会一起删除。')) return;
      await fetch(`/api/books/${id}`, { method: 'DELETE' });
      loadBooks();
    });
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ===== 上传 =====
const modal = $('#uploadModal');
const dropZone = $('#dropZone');
const zipInput = $('#zipInput');
const statusEl = $('#uploadStatus');

$('#uploadBtn').addEventListener('click', () => modal.classList.remove('hidden'));
$$('[data-close]').forEach(el => el.addEventListener('click', () => {
  modal.classList.add('hidden');
  statusEl.className = 'upload-status';
  statusEl.textContent = '';
}));

zipInput.addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) uploadFile(f);
});

['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, (e) => {
  e.preventDefault(); dropZone.classList.add('drag-over');
}));
['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, (e) => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
}));
dropZone.addEventListener('drop', async (e) => {
  // 检测是否拖入了文件夹（支持 webkitGetAsEntry）
  const items = e.dataTransfer.items ? Array.from(e.dataTransfer.items) : [];
  const entries = items.map(it => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
  const firstDir = entries.find(en => en.isDirectory);
  if (firstDir) {
    const files = await walkDirectory(firstDir);
    if (!files.length) { setStatus('error', '文件夹里没找到 .md / .txt'); return; }
    await uploadFolderAsPaste(firstDir.name || '文件夹', files);
    return;
  }
  const f = e.dataTransfer.files[0];
  if (f) uploadFile(f);
});

// 递归遍历 DirectoryEntry，取所有 .md / .txt 文件
async function walkDirectory(dir) {
  const out = [];
  async function readAll(entry) {
    if (entry.isFile) {
      const name = entry.name.toLowerCase();
      if (name.endsWith('.md') || name.endsWith('.markdown') || name.endsWith('.txt')) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        const text = await file.text();
        out.push({ path: entry.fullPath || entry.name, text });
      }
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      while (true) {
        const chunk = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!chunk.length) break;
        for (const c of chunk) await readAll(c);
      }
    }
  }
  await readAll(dir);
  return out;
}

// 文件夹拼成一段 material → 走 /api/books/paste
async function uploadFolderAsPaste(folderName, files) {
  const combined = files.map(f => `\n\n--- ${f.path} ---\n${f.text}`).join('');
  setStatus('info', `📁 识别到文件夹《${folderName}》共 ${files.length} 个文档，提交中…`);
  try {
    const res = await fetch('/api/books/paste', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: folderName, text: combined }),
    });
    const data = await res.json();
    if (!res.ok) { setStatus('error', '❌ ' + (data.detail || data.error)); return; }
    if (data.jobId) await pollGenerateJob(data.jobId);
  } catch (err) { setStatus('error', '❌ ' + err.message); }
}

// ===== 内容源 Tabs =====
$$('.src-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.src-tab').forEach(b => b.classList.toggle('active', b === btn));
    const target = btn.dataset.tab;
    $$('.src-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === target));
    statusEl.className = 'upload-status'; statusEl.textContent = '';
  });
});

// ===== URL 抓取 =====
$('#urlSubmit').addEventListener('click', async () => {
  const url = $('#urlInput').value.trim();
  if (!url) { setStatus('error', '请填 URL'); return; }
  setStatus('info', '🌐 抓取网页中…');
  try {
    const res = await fetch('/api/books/upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) { setStatus('error', '❌ ' + (data.detail || data.error)); return; }
    if (data.jobId) await pollGenerateJob(data.jobId);
  } catch (err) { setStatus('error', '❌ ' + err.message); }
});

// ===== 粘贴文本 =====
$('#pasteSubmit').addEventListener('click', async () => {
  const text = $('#pasteText').value;
  const title = $('#pasteTitle').value.trim() || '剪贴板笔记';
  if (!text.trim()) { setStatus('error', '内容为空'); return; }
  setStatus('info', '📝 提交中…');
  try {
    const res = await fetch('/api/books/paste', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, title }),
    });
    const data = await res.json();
    if (!res.ok) { setStatus('error', '❌ ' + (data.detail || data.error)); return; }
    if (data.jobId) await pollGenerateJob(data.jobId);
  } catch (err) { setStatus('error', '❌ ' + err.message); }
});

// ===== 订阅远端 =====
$('#subSubmit').addEventListener('click', async () => {
  const url = $('#subUrl').value.trim();
  if (!url) { setStatus('error', '请填 URL'); return; }
  setStatus('info', '📡 拉取远端…');
  try {
    const res = await fetch('/api/books/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) { setStatus('error', '❌ ' + (data.detail || data.error)); return; }
    setStatus('success', `✅ 已导入《${data.book.title}》共 ${data.cardCount} 张卡片`);
    await loadBooks();
    setTimeout(() => {
      modal.classList.add('hidden');
      statusEl.className = 'upload-status'; statusEl.textContent = '';
    }, 1200);
  } catch (err) { setStatus('error', '❌ ' + err.message); }
});

// ===== 文件分派：根据扩展名选不同的 endpoint =====
function pickUploadPlan(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.zip'))  return { endpoint: '/api/books/upload',      field: 'zipFile',  label: 'ZIP' };
  if (name.endsWith('.pdf'))  return { endpoint: '/api/books/upload-pdf',  field: 'pdfFile',  label: 'PDF' };
  if (name.endsWith('.md') || name.endsWith('.markdown') || name.endsWith('.txt')) {
    return { endpoint: '/api/books/upload-text', field: 'textFile', label: 'Markdown/TXT' };
  }
  return null;
}

async function uploadFile(file) {
  const plan = pickUploadPlan(file);
  if (!plan) {
    setStatus('error', '只支持 PDF / Markdown / TXT / ZIP 文件');
    return;
  }

  // PDF：尽量带上 Key（如果本地存了），后端会根据自己的 MODE 决定是否使用
  let apiKey = '';
  if (plan.label === 'PDF') {
    apiKey = localStorage.getItem('cs.pdf2xKey') || '';
  }

  setStatus('info', `上传 ${plan.label} 中…`);
  const fd = new FormData();
  fd.append(plan.field, file);

  try {
    const headers = {};
    if (apiKey) headers['X-Pdf2x-Key'] = apiKey;
    const res = await fetch(plan.endpoint, { method: 'POST', body: fd, headers });
    const data = await res.json();
    if (!res.ok) {
      let msg = `❌ ${data.error || '上传失败'}${data.detail ? ' — ' + data.detail : ''}`;
      if (data.error === 'no_api_key') {
        msg += `\n去 ${data.keyPage || 'https://pdf2x.cn/api/apikey/page'} 获取 Key`;
      }
      setStatus('error', msg);
      return;
    }
    // 任何带 jobId 的响应都走 poll（generate / pdf-local / pdf-v1 / pdf-pdf2x / paste / url / ...）
    if (data.jobId || data.generating) {
      await pollGenerateJob(data.jobId);
      return;
    }
    setStatus('success', `✅ 已导入《${data.book.title}》共 ${data.cardCount} 张卡片`);
    await loadBooks();
    setTimeout(() => {
      modal.classList.add('hidden');
      statusEl.className = 'upload-status'; statusEl.textContent = '';
    }, 1200);
  } catch (err) {
    setStatus('error', '❌ ' + err.message);
  }
}

// ===== API Key 设置 =====
const apiKeyModal  = $('#apiKeyModal');
const apiKeyInput  = $('#apiKeyInput');
const apiKeyStatus = $('#apiKeyStatus');

function loadStoredKey() {
  const k = localStorage.getItem('cs.pdf2xKey') || '';
  apiKeyInput.value = k;
}
function setKeyStatus(kind, text) {
  apiKeyStatus.className = 'upload-status ' + kind;
  apiKeyStatus.textContent = text;
}

$('#apiKeyBtn').addEventListener('click', () => {
  loadStoredKey();
  setKeyStatus('', '');
  apiKeyModal.classList.remove('hidden');
});
$$('[data-close-key]').forEach(el => el.addEventListener('click', () => {
  apiKeyModal.classList.add('hidden');
}));
$('#apiKeyToggle').addEventListener('click', () => {
  apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
});
$('#apiKeySave').addEventListener('click', () => {
  const v = apiKeyInput.value.trim();
  if (!v) { setKeyStatus('error', '❌ Key 不能为空'); return; }
  if (!/^sk-/i.test(v)) { setKeyStatus('error', '⚠️ Key 通常以 sk- 开头，请检查是否粘贴完整'); return; }
  localStorage.setItem('cs.pdf2xKey', v);
  setKeyStatus('success', '✅ 已保存到本地');
  setTimeout(() => apiKeyModal.classList.add('hidden'), 900);
});
$('#apiKeyClear').addEventListener('click', () => {
  localStorage.removeItem('cs.pdf2xKey');
  apiKeyInput.value = '';
  setKeyStatus('info', '已清除本地 Key');
});

// ===== LLM / PDF 设置（桌面版） =====
const settingsModal = $('#settingsModal');
const settingsStatus = $('#settingsStatus');
function setSettingsStatus(kind, text) {
  settingsStatus.className = 'upload-status ' + kind;
  settingsStatus.textContent = text;
}

async function openSettings() {
  setSettingsStatus('', '');
  settingsModal.classList.remove('hidden');
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    const unavailable = $('#settingsUnavailable');
    const form = $('#settingsForm');
    if (!data.configFile) {
      unavailable.classList.remove('hidden');
      form.style.opacity = 0.4;
      form.style.pointerEvents = 'none';
      return;
    }
    unavailable.classList.add('hidden');
    form.style.opacity = 1;
    form.style.pointerEvents = '';
    $('#setLlmProvider').value = data.llmProvider === 'http' ? 'http' : 'mock';
    $('#setLlmApiUrl').value = data.llmApiUrl || '';
    $('#setLlmApiKey').value = '';
    $('#setLlmApiKey').placeholder = data.hasLlmKey
      ? '已保存（留空不变，填 - 清除）'
      : '留空则保持原 Key 不变；填 - 清除';
    $('#setLlmModel').value = data.llmModel || '';
    $('#setPdfParseUrl').value = data.pdfParseUrl === 'pdf2x' ? 'pdf2x' : '';
    $('#setPdf2xKey').value = '';
    $('#setPdf2xKey').placeholder = data.hasPdf2xKey
      ? '已保存（留空不变，填 - 清除）'
      : '留空则保持原 Key 不变；填 - 清除';
  } catch (err) {
    setSettingsStatus('error', '❌ 加载失败：' + err.message);
  }
}

$('#settingsBtn').addEventListener('click', openSettings);
$$('[data-close-settings]').forEach(el => el.addEventListener('click', () => {
  settingsModal.classList.add('hidden');
}));

$('#settingsSave').addEventListener('click', async () => {
  const payload = {
    LLM_PROVIDER: $('#setLlmProvider').value,
    LLM_API_URL: $('#setLlmApiUrl').value.trim(),
    LLM_MODEL: $('#setLlmModel').value.trim(),
    PDF_PARSE_URL: $('#setPdfParseUrl').value,
  };
  const llmKey = $('#setLlmApiKey').value;
  if (llmKey === '-') payload.LLM_API_KEY = '';
  else if (llmKey) payload.LLM_API_KEY = llmKey;

  const pdfKey = $('#setPdf2xKey').value;
  if (pdfKey === '-') payload.PDF2X_API_KEY = '';
  else if (pdfKey) payload.PDF2X_API_KEY = pdfKey;

  setSettingsStatus('info', '保存中…');
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || data.error || '保存失败');
    setSettingsStatus('success', '✅ 已保存。请 Cmd+Q 退出 App 后重新打开生效。');
  } catch (err) {
    setSettingsStatus('error', '❌ ' + err.message);
  }
});

async function pollGenerateJob(jobId) {
  setStatus('info', '🧠 CC 正在读这本书并生成卡片（约 1-3 分钟）…');
  const started = Date.now();
  while (true) {
    await new Promise(r => setTimeout(r, 3000));
    let job;
    try {
      const res = await fetch(`/api/books/jobs/${jobId}`);
      if (!res.ok) throw new Error('查询任务失败');
      job = await res.json();
    } catch (e) {
      setStatus('error', '❌ ' + e.message);
      return;
    }
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (job.status === 'done') {
      setStatus('success', `✅ 生成完成《${job.book?.title || ''}》共 ${job.book?.cardCount || 0} 张卡片`);
      await loadBooks();
      setTimeout(() => {
        modal.classList.add('hidden');
        statusEl.className = 'upload-status'; statusEl.textContent = '';
      }, 1500);
      return;
    }
    if (job.status === 'error') {
      setStatus('error', '❌ 生成失败：' + (job.error || '未知错误'));
      return;
    }
    setStatus('info', `🧠 ${job.progress || '生成中…'}（已用 ${elapsed}s）`);
  }
}

function setStatus(kind, text) {
  statusEl.className = 'upload-status ' + kind;
  statusEl.textContent = text;
}

loadBooks();

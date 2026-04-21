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
dropZone.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  if (f) uploadFile(f);
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

  // PDF 需要 API Key
  let apiKey = '';
  if (plan.label === 'PDF') {
    apiKey = localStorage.getItem('cs.pdf2xKey') || '';
    if (!apiKey) {
      setStatus('error', '❌ 上传 PDF 需要先设置 pdf2x.cn 的 API Key（右上角 🔑）');
      return;
    }
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
    if ((data.mode === 'generate' || data.mode === 'pdf') && data.jobId) {
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

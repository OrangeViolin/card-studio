// 纸上键 · 手敲金句（真打字游戏）
// 一句一句地敲出来 — 错字不前进，光标跟随，中英都行
// 数据格式对齐「卡片书斋」(https://github.com/...) 的 cards.json
// Copyright (C) 2026 01fish · GPL-3.0-or-later

try { (function(){
  'use strict';

  // ===== 内置金句库（精选 12 条，中英混搭）=====
  var BUILTIN = [
    { text: "The best moments in our lives are not the passive, receptive, relaxing times.", author: "Mihaly Csikszentmihalyi", source: "《心流》", lang: "en" },
    { text: "反过来想，总是反过来想。", author: "查理·芒格", source: "《穷查理宝典》", lang: "zh" },
    { text: "It is remarkable how much long-term advantage we have gotten by trying to be consistently not stupid.", author: "Charlie Munger", source: "《穷查理宝典》", lang: "en" },
    { text: "人生最美好的时刻，往往发生在身心被推向极限的自愿努力中。", author: "米哈里", source: "《心流》", lang: "zh" },
    { text: "Stay hungry, stay foolish.", author: "Stewart Brand", source: "Whole Earth Catalog", lang: "en" },
    { text: "凡是过去，皆为序章。", author: "莎士比亚", source: "《暴风雨》", lang: "zh" },
    { text: "The only way to do great work is to love what you do.", author: "Steve Jobs", source: "Stanford 2005", lang: "en" },
    { text: "知人者智，自知者明。", author: "老子", source: "《道德经》", lang: "zh" },
    { text: "Simplicity is the ultimate sophistication.", author: "Leonardo da Vinci", source: "笔记", lang: "en" },
    { text: "山川异域，风月同天。", author: "长屋王", source: "《绣袈裟衣缘》", lang: "zh" },
    { text: "What we cannot speak about we must pass over in silence.", author: "Wittgenstein", source: "Tractatus", lang: "en" },
    { text: "纸上得来终觉浅，绝知此事要躬行。", author: "陆游", source: "《冬夜读书示子聿》", lang: "zh" }
  ];

  var state = {
    library: [],        // 当前金句库（内置 + 导入）
    quote: null,        // 当前金句
    startTs: 0,
    errors: 0,          // 累计错误字符数
    maxLen: 0,          // 历史最大正确长度（避免退格刷分）
    running: false,
    composing: false    // IME 中
  };

  function loadLibrary() {
    var imported = [];
    try {
      var raw = localStorage.getItem('paperkey.quotes');
      if (raw) imported = JSON.parse(raw) || [];
    } catch (e) {}
    state.library = BUILTIN.concat(imported);
  }

  function saveImported(arr) {
    localStorage.setItem('paperkey.quotes', JSON.stringify(arr));
    loadLibrary();
  }

  function randomQuote() {
    return state.library[Math.floor(Math.random() * state.library.length)];
  }

  // ===== 渲染 =====
  function render() {
    var stage = document.getElementById('typeText');
    if (!stage || !state.quote) return;
    var target = state.quote.text;
    var input = document.getElementById('typeInput');
    var val = input ? input.value : '';
    var html = '';

    for (var i = 0; i < target.length; i++) {
      var cls = 'tch';
      if (i < val.length) {
        cls += (val[i] === target[i]) ? ' ok' : ' bad';
      } else if (i === val.length) {
        cls += ' cur';
      }
      var ch = target[i] === ' ' ? '\u00A0' : escape(target[i]);
      html += '<span class="' + cls + '">' + ch + '</span>';
    }
    stage.innerHTML = html;

    // 进度条
    var done = 0;
    for (var j = 0; j < Math.min(val.length, target.length); j++) {
      if (val[j] === target[j]) done++;
      else break;
    }
    var bar = document.getElementById('typeProgress');
    if (bar) bar.style.width = (100 * done / target.length).toFixed(1) + '%';

    if (done > state.maxLen) state.maxLen = done;
  }

  function escape(s) {
    return s.replace(/[&<>"']/g, function(c){
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }

  function updateMeta() {
    var meta = document.getElementById('typeMeta');
    if (!meta || !state.quote) return;
    var q = state.quote;
    var len = [].slice.call(q.text).length;
    meta.innerHTML =
      '<span class="tm-source">' + escape(q.source || '') + (q.author ? ' · ' + escape(q.author) : '') + '</span>' +
      '<span class="tm-sep">|</span>' +
      '<span class="tm-lang">' + (q.lang === 'zh' ? '中文' : q.lang === 'en' ? '英文' : (q.lang || '其他')) + ' · ' + len + ' 字</span>';
  }

  // ===== 游戏流程 =====
  function start() {
    state.quote = randomQuote();
    state.startTs = 0;
    state.errors = 0;
    state.maxLen = 0;
    state.running = true;
    var input = document.getElementById('typeInput');
    if (input) {
      input.value = '';
      input.disabled = false;
      setTimeout(function(){ input.focus(); }, 20);
    }
    hideResult();
    updateMeta();
    render();
    setHint('对着文字敲 · 错字要退格');
  }

  function onInput() {
    if (!state.running || !state.quote) return;
    if (state.composing) return;  // IME 组合中不判断
    var input = document.getElementById('typeInput');
    var val = input.value;
    var target = state.quote.text;
    if (state.startTs === 0 && val.length > 0) state.startTs = performance.now();

    // 统计错误：当前 value 中有多少位不匹配（一次性算，避免抖动）
    var miss = 0;
    for (var i = 0; i < val.length && i < target.length; i++) {
      if (val[i] !== target[i]) miss++;
    }
    if (val.length > target.length) miss += val.length - target.length;
    // 累加错误：本次 miss 数比历史记录多则 +1
    if (miss > state.errors) state.errors = miss;

    render();

    // 完成
    if (val === target) finish();
  }

  function onCompositionStart() { state.composing = true; }
  function onCompositionEnd() { state.composing = false; onInput(); }

  function finish() {
    state.running = false;
    var elapsed = (performance.now() - state.startTs) / 1000;
    var target = state.quote.text;
    var len = target.length;
    var total = len + state.errors;
    var accuracy = total > 0 ? (len / total) : 1;
    // WPM 按英文 5 字符=1 词的惯例；中文按字计，不太一样
    var words = state.quote.lang === 'zh' ? len : len / 5;
    var wpm = elapsed > 0 ? (words / (elapsed / 60)) : 0;

    var rank = judge(accuracy, wpm, state.quote.lang);
    showResult({ elapsed: elapsed, chars: len, errors: state.errors, accuracy: accuracy, wpm: wpm, rank: rank });
    var input = document.getElementById('typeInput');
    if (input) input.disabled = true;
  }

  function judge(acc, wpm, lang) {
    var fast = lang === 'zh' ? 60 : 50;  // 中文 60 cpm (字/分), 英文 50 wpm
    if (acc >= 0.98 && wpm >= fast)      return { title: '入木三分', desc: '快而不错，笔下有神。' };
    if (acc >= 0.95)                     return { title: '行云流水', desc: '准头稳，速度也不赖。' };
    if (acc >= 0.85)                     return { title: '笔走龙蛇', desc: '大体顺畅，个别字踉跄。' };
    if (wpm >= fast)                     return { title: '快手毛糙', desc: '手速够了，准头再练练。' };
    return { title: '初学乍练', desc: '先慢下来，稳稳敲。' };
  }

  function showResult(r) {
    var box = document.getElementById('typeResult');
    if (!box) return;
    box.innerHTML =
      '<div class="rc-rank">' + r.rank.title + '</div>' +
      '<div class="rc-desc">' + r.rank.desc + '</div>' +
      '<div class="rc-stats">' +
        '<span>用时 ' + r.elapsed.toFixed(1) + ' 秒</span> · ' +
        '<span>准确率 ' + (r.accuracy * 100).toFixed(1) + '%</span> · ' +
        '<span>速度 ' + r.wpm.toFixed(0) + (state.quote.lang === 'zh' ? ' 字/分' : ' WPM') + '</span> · ' +
        '<span>错 ' + r.errors + ' 字</span>' +
      '</div>' +
      '<div class="rc-quote">"' + escape(state.quote.text) + '"<span class="rc-from"> — ' +
         escape(state.quote.author || '') + (state.quote.source ? '《' + escape(state.quote.source.replace(/《|》/g, '')) + '》' : '') + '</span></div>' +
      '<button class="calli-btn primary" onclick="window.__pk_typing.start()">换一句</button>';
    box.hidden = false;
  }

  function hideResult() {
    var box = document.getElementById('typeResult');
    if (box) box.hidden = true;
  }

  function setHint(msg) {
    var h = document.getElementById('typeHint');
    if (h) h.textContent = msg;
  }

  // ===== 通用金句挖掘 =====
  // 任何文本都往金句的方向挖：cards.json 原教旨 → 引号/引用块 → 独占一段的短句

  function detectLang(s) {
    if (/[\u4e00-\u9fff]/.test(s)) return 'zh';
    if (/^[\x00-\x7f\s]+$/.test(s)) return 'en';
    return 'other';
  }

  // 归一化：去掉首尾标点/空白，合并内部空格
  var EDGE_PUNCT = /^[\s\u0022\u0027\u2018\u2019\u201C\u201D\u300C\u300D\u300E\u300F\u2014-]+|[\s\u0022\u0027\u2018\u2019\u201C\u201D\u300C\u300D\u300E\u300F\u2014-]+$/g;
  function normalize(s) {
    return String(s).replace(/[\s\u3000]+/g, ' ').replace(EDGE_PUNCT, '').trim();
  }

  // 句末标点（中+英）
  var SENT_END = /[。！？；\.!\?;]/;
  // 中文停顿（逗号/顿号）也可作为"有语义停顿"的证据
  var SOFT_PAUSE = /[，、,]/;
  // 标题/列表特征：# 开头、数字列表、短横/项目符号列表、菜单目录类关键词
  var LOOKS_LIKE_TITLE = /^(#+\s|[-*•·]\s|\d+[.、]\s|第[一二三四五六七八九十百千0-9]+[章节讲回课])/;
  var TITLE_WORDS = /^.{0,30}(目录|概览|章节|大纲|列表|清单|索引|导航|简介|前言|后记|作者简介|关于作者|参考文献)$/;
  // 步骤/章节类标题前缀（带冒号通常是标题而非金句）
  var STEP_PREFIX = /^(步骤|阶段|要点|环节|第[一二三四五六七八九十百千0-9]+[步课讲章节部分篇回]|Step\s*\d+|Part\s*\d+|Chapter\s*\d+)/i;
  // 文件路径 / 代码痕迹
  var CODE_JUNK = /[{}\[\]<>|=\\/]|https?:|www\./;

  function ok(s) {
    s = normalize(s);
    if (!s) return null;
    var cj = (s.match(/[\u4e00-\u9fff]/g) || []).length;
    if (cj >= s.length * 0.3) {
      if (s.length < 8 || s.length > 80) return null;
    } else {
      if (s.length < 12 || s.length > 220) return null;
    }
    if (LOOKS_LIKE_TITLE.test(s)) return null;
    if (TITLE_WORDS.test(s)) return null;
    if (STEP_PREFIX.test(s)) return null;
    if (CODE_JUNK.test(s)) return null;
    return s;
  }

  // 更严格：必须含句末标点或软停顿（给"独占段落"用）
  function okStrict(s) {
    var r = ok(s);
    if (!r) return null;
    if (!SENT_END.test(r) && !SOFT_PAUSE.test(r)) return null;
    return r;
  }

  // 占位符/无意义字段值
  var PLACEHOLDER = /^(同上|同前|见原文|见上|见前|略|无|N\/A|—|-|空)$/;
  var IS_META = /(原文即|同上.*原文|未翻译|暂无|略$)/;

  function goodQuote(s) {
    if (!s) return false;
    if (PLACEHOLDER.test(s.trim())) return false;
    if (IS_META.test(s)) return false;
    var cj = (s.match(/[\u4e00-\u9fff]/g) || []).length;
    // 适合打字的金句：中文 ≤60 字，其他 ≤120 字
    if (cj >= s.length * 0.3) {
      if (s.length < 6 || s.length > 60) return false;
    } else {
      if (s.length < 10 || s.length > 120) return false;
    }
    return true;
  }

  // 从 cards.json 抽（卡片书斋正统格式）
  function extractFromCards(cards, srcName) {
    var out = [];
    if (!Array.isArray(cards)) return out;
    cards.forEach(function(c){
      if (c.type !== 'quote' || !c.fields) return;
      var f = c.fields;
      var author = f['作者'] || '';
      var src = c.source || srcName || '';
      if (f['金句']) {
        var a = normalize(f['金句']);
        if (goodQuote(a)) out.push({ text: a, author: author, source: src, lang: detectLang(a) });
      }
      if (f['中译'] && f['中译'] !== f['金句']) {
        var b = normalize(f['中译']);
        if (goodQuote(b)) out.push({ text: b, author: author, source: src, lang: 'zh' });
      }
    });
    return out;
  }

  // 从任意 JSON 对象树里挖（非 cards.json 格式也能挖）
  function walkJsonForQuotes(obj, out, srcName) {
    if (!obj) return;
    if (typeof obj === 'string') {
      var s = ok(obj);
      if (s) out.push({ text: s, author: '', source: srcName || '', lang: detectLang(s) });
      return;
    }
    if (Array.isArray(obj)) { obj.forEach(function(x){ walkJsonForQuotes(x, out, srcName); }); return; }
    if (typeof obj === 'object') {
      // 带语义的字段优先（金句/quote/saying/text/content）
      var keys = Object.keys(obj);
      var priorityKeys = ['金句','中译','名言','quote','saying','text','content','body'];
      priorityKeys.forEach(function(k){ if (obj[k] != null) walkJsonForQuotes(obj[k], out, srcName); });
      keys.forEach(function(k){ if (priorityKeys.indexOf(k) < 0) walkJsonForQuotes(obj[k], out, srcName); });
    }
  }

  // 从纯文本（md/txt）里挖 — 只取"明确是引用"的内容，不硬挖标题
  function extractFromText(text, srcName) {
    var out = [];
    var seen = {};
    function pushQ(s) {
      s = ok(s); if (!s) return;
      if (seen[s]) return; seen[s] = 1;
      out.push({ text: s, author: '', source: srcName || '', lang: detectLang(s) });
    }
    function pushStrict(s) {
      s = okStrict(s); if (!s) return;
      if (seen[s]) return; seen[s] = 1;
      out.push({ text: s, author: '', source: srcName || '', lang: detectLang(s) });
    }
    var m;
    // 1. Markdown 引用块：> ...（引用标记明确，走 ok）
    var re1 = /(?:^|\n)>\s?([^\n]{6,250})/g;
    while ((m = re1.exec(text)) !== null) pushQ(m[1]);
    // 2. 中文引号：\u201C..\u201D（""）/ \u300E..\u300F（『』）/ \u300C..\u300D（「」）
    var re2 = /[\u201C\u300E\u300C]([^\u201C\u201D\u300E\u300F\u300C\u300D]{6,200})[\u201D\u300F\u300D]/g;
    while ((m = re2.exec(text)) !== null) pushQ(m[1]);
    // 3. 英文双引号
    var re3 = /"([^"\n]{10,200})"/g;
    while ((m = re3.exec(text)) !== null) pushQ(m[1]);
    // 4. 独占短段（兜底）：Markdown 标题/列表整段跳过；其余必须含句末标点或软停顿
    text.split(/\n\s*\n/).forEach(function(para){
      var p = para.trim();
      if (!p || p.indexOf('\n') >= 0) return;
      // 以 #, -, *, >, 1. 开头的整段丢掉（标题、列表项、引用已在前面处理过了）
      if (/^(#+\s|[-*•·]\s|\d+[.、]\s|>\s?)/.test(p)) return;
      pushStrict(p);
    });
    return out;
  }

  // HTML → 纯文本（挑主体，去脚本/样式/导航，块标签转换行）
  function stripHtml(html) {
    try {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      doc.querySelectorAll('script,style,noscript,nav,header,footer,aside,form,iframe,svg,button').forEach(function(el){ el.remove(); });
      var main =
        doc.querySelector('#js_content') ||          // 微信公众号
        doc.querySelector('#content') ||
        doc.querySelector('article') ||
        doc.querySelector('main') ||
        doc.querySelector('[class*="post-body"]') ||
        doc.querySelector('[class*="article-content"]') ||
        doc.querySelector('[class*="content"]') ||
        doc.body;
      if (!main) return '';
      var BLOCK = /^(P|DIV|H[1-6]|LI|BLOCKQUOTE|SECTION|ARTICLE|TR|TD|BR|PRE|HR)$/;
      var buf = [];
      (function walk(node){
        var ch = node.childNodes;
        for (var i = 0; i < ch.length; i++) {
          var c = ch[i];
          if (c.nodeType === 3) { buf.push(c.textContent); }
          else if (c.nodeType === 1) {
            var b = BLOCK.test(c.tagName);
            if (b) buf.push('\n');
            walk(c);
            if (b) buf.push('\n');
          }
        }
      })(main);
      return buf.join('').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
    } catch (e) {
      // 兜底：正则剥
      return String(html)
        .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<\/?(p|div|br|h[1-6]|li|blockquote|section|article)[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, function(_, n){ return String.fromCharCode(parseInt(n, 10)); })
        .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
    }
  }

  // 从 HTML <title> 或 og:title 抽书名
  function pickTitleFromHtml(html) {
    try {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var og = doc.querySelector('meta[property="og:title"]');
      if (og && og.getAttribute('content')) return og.getAttribute('content').trim();
      if (doc.title) return doc.title.trim();
    } catch(e){}
    var m = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
    return m ? m[1].trim() : '';
  }

  // 从单个文件内容里挖
  function extractFromFile(name, content, bookName) {
    var lower = (name || '').toLowerCase();
    var src = bookName || name || '';
    var out = [];
    if (lower.endsWith('.json')) {
      try {
        var obj = JSON.parse(content);
        if (Array.isArray(obj) && obj.length && obj[0] && obj[0].type && obj[0].fields) {
          out = extractFromCards(obj, src);
        }
        if (out.length === 0) walkJsonForQuotes(obj, out, src);
      } catch(e) { /* 不是合法 JSON，当文本处理 */
        out = extractFromText(content, src);
      }
    } else if (lower.endsWith('.html') || lower.endsWith('.htm')) {
      out = extractFromText(stripHtml(content), src);
    } else {
      out = extractFromText(content, src);
    }
    return out;
  }

  // 去重 + 入库
  function mergeAndSave(newOnes) {
    var existing = [];
    try { existing = JSON.parse(localStorage.getItem('paperkey.quotes') || '[]'); } catch(e){}
    var seen = {};
    existing.forEach(function(q){ seen[q.text] = 1; });
    var added = newOnes.filter(function(q){ if (seen[q.text]) return false; seen[q.text] = 1; return true; });
    saveImported(existing.concat(added));
    return added.length;
  }

  // 旧 API 保留，用于粘贴 JSON 文本（现在只兼容 cards.json）
  function importFromCards(json) {
    try {
      var cards = typeof json === 'string' ? JSON.parse(json) : json;
      var out = extractFromCards(cards, '');
      if (out.length === 0) { out = []; walkJsonForQuotes(cards, out, ''); }
      if (out.length === 0) return { n: 0, msg: '没挖到金句' };
      var n = mergeAndSave(out);
      return { n: n, msg: '已导入 ' + n + ' 条（库共 ' + state.library.length + ' 条）' };
    } catch (e) {
      return { n: 0, msg: '导入失败：' + e.message };
    }
  }

  // ===== LLM 金句过滤（调用 claude CLI，通过 Tauri） =====
  function tauriInvoke(cmd, args) {
    var t = window.__TAURI__;
    var invoke = (t && t.core && t.core.invoke) || (t && t.invoke);
    if (!invoke) return Promise.reject(new Error('invoke 不可用（非 Tauri 环境）'));
    return invoke(cmd, args || {});
  }

  function hasLLM() {
    return tauriInvoke('has_claude_cli').then(function(ok){ return !!ok; }).catch(function(){ return false; });
  }

  // 分批喂给 LLM，顺序执行（避免并发拖爆）
  // quotes: [{text, ...}]；返回同结构的被保留项数组
  function llmRefine(quotes, onProgress) {
    var BATCH = 50;
    var batches = [];
    for (var i = 0; i < quotes.length; i += BATCH) {
      batches.push(quotes.slice(i, i + BATCH));
    }
    var kept = [];
    var total = batches.length;
    var done = 0;
    function next(idx) {
      if (idx >= batches.length) return Promise.resolve(kept);
      var batch = batches[idx];
      var texts = batch.map(function(q){ return q.text; });
      if (onProgress) onProgress(done, total);
      return tauriInvoke('llm_filter_quotes', { candidates: texts }).then(function(keep){
        var keepSet = {};
        (keep || []).forEach(function(t){ keepSet[t] = 1; });
        batch.forEach(function(q){ if (keepSet[q.text]) kept.push(q); });
        done++;
        if (onProgress) onProgress(done, total);
        return next(idx + 1);
      });
    }
    return next(0);
  }

  // ===== 自建弹窗（Tauri WebView 禁用 prompt/alert/confirm，只能自己撸）=====
  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'pk-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function(){ t.classList.add('show'); }, 10);
    setTimeout(function(){ t.classList.remove('show'); setTimeout(function(){ t.remove(); }, 300); }, 2400);
  }

  // 持久 toast（进度用，手动关闭）
  function stickyToast(msg) {
    var el = document.getElementById('pkStickyToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pkStickyToast';
      el.className = 'pk-toast show';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    return {
      update: function(m){ el.textContent = m; },
      close: function(){ el.classList.remove('show'); setTimeout(function(){ if (el.parentNode) el.remove(); }, 300); }
    };
  }

  // ===== zip / 文本文件导入 =====
  var TEXT_EXT = /\.(json|md|markdown|txt|text|html|htm)$/i;

  // 粗提取出来的 pool 过一遍 LLM 精选；LLM 不可用就原样返回
  function refineWithLLMIfAvailable(pool) {
    return hasLLM().then(function(ok){
      if (!ok) return { pool: pool, refined: false };
      var st = stickyToast('AI 精选中 · 0/' + Math.ceil(pool.length / 50) + ' 批');
      return llmRefine(pool, function(done, total){
        st.update('AI 精选中 · ' + done + '/' + total + ' 批（' + pool.length + ' 条候选）');
      }).then(function(kept){
        st.close();
        return { pool: kept, refined: true };
      }).catch(function(err){
        st.close();
        console.warn('[typing.js] LLM filter failed, fallback to regex:', err);
        toast('AI 精选失败，用正则兜底');
        return { pool: pool, refined: false };
      });
    });
  }

  function parseZipAndImport(file) {
    if (typeof JSZip === 'undefined') { toast('JSZip 未载入'); return; }
    toast('解包中 · ' + file.name);
    var bookName = (file.name || 'import').replace(/\.zip$/i, '');
    JSZip.loadAsync(file).then(function(zip){
      var files = [];
      zip.forEach(function(path, entry){
        if (entry.dir) return;
        if (/(^|\/)__MACOSX\//.test(path)) return;
        if (TEXT_EXT.test(path)) files.push({ path: path, entry: entry });
      });
      if (files.length === 0) { toast('zip 里没有可读文本文件（.json/.md/.txt）'); return; }
      Promise.all(files.map(function(f){ return f.entry.async('string').then(function(t){ return { path: f.path, text: t }; }); })).then(function(all){
        var pool = [];
        var fileCount = 0;
        all.forEach(function(f){
          var out = extractFromFile(f.path, f.text, bookName);
          if (out.length) { pool = pool.concat(out); fileCount++; }
        });
        if (pool.length === 0) { toast('没挖到金句 · 扫了 ' + files.length + ' 个文件'); return; }
        return refineWithLLMIfAvailable(pool).then(function(r){
          if (r.pool.length === 0) { toast('AI 说一条都不够格 · 扫了 ' + pool.length + ' 条候选'); return; }
          var n = mergeAndSave(r.pool);
          var tag = r.refined ? 'AI 精选' : '正则兜底';
          toast(n > 0
            ? '✓ 入库 ' + n + ' 条（' + tag + ' · ' + r.pool.length + '/' + pool.length + ' 通过）'
            : '全是重复的（' + tag + ' 后还剩 ' + r.pool.length + ' 条）');
        });
      });
    }).catch(function(err){
      toast('解包失败：' + (err.message || err));
    });
  }

  function parsePlainFileAndImport(file) {
    var reader = new FileReader();
    var bookName = (file.name || 'import').replace(/\.(json|md|markdown|txt|text|html|htm)$/i, '');
    reader.onload = function(e){
      var out = extractFromFile(file.name, e.target.result, bookName);
      if (out.length === 0) { toast('没挖到金句'); return; }
      refineWithLLMIfAvailable(out).then(function(r){
        if (r.pool.length === 0) { toast('AI 说一条都不够格 · 扫了 ' + out.length + ' 条候选'); return; }
        var n = mergeAndSave(r.pool);
        var tag = r.refined ? 'AI 精选' : '正则兜底';
        toast(n > 0
          ? '✓ 入库 ' + n + ' 条（' + tag + ' · ' + r.pool.length + '/' + out.length + '）'
          : '全是库里已有的');
      });
    };
    reader.onerror = function(){ toast('读取失败'); };
    reader.readAsText(file);
  }

  function pickFileForImport() {
    var inp = document.getElementById('pkImportFile');
    if (!inp) {
      inp = document.createElement('input');
      inp.type = 'file';
      inp.id = 'pkImportFile';
      inp.accept = '.zip,.json,.md,.markdown,.txt,.html,.htm';
      inp.style.display = 'none';
      inp.addEventListener('change', function(){
        var f = inp.files && inp.files[0];
        if (!f) return;
        var name = (f.name || '').toLowerCase();
        if (name.endsWith('.zip') || f.type === 'application/zip') parseZipAndImport(f);
        else parsePlainFileAndImport(f);
        inp.value = '';
      });
      document.body.appendChild(inp);
    }
    inp.click();
  }

  function importFromUrl(url) {
    url = (url || '').trim();
    if (!/^https?:\/\//i.test(url)) { toast('请填 http / https 链接'); return; }
    var st = stickyToast('抓取链接中 · ' + url.slice(0, 40) + (url.length > 40 ? '…' : ''));
    tauriInvoke('fetch_url', { url: url }).then(function(html){
      st.close();
      if (!html) { toast('抓回来是空的'); return; }
      var bookName = pickTitleFromHtml(html) || new URL(url).hostname;
      // 如果抓到的根本不是 HTML（JSON/MD/纯文本），走通用
      var lower = url.toLowerCase();
      var name = lower.endsWith('.md') ? 'page.md'
               : lower.endsWith('.json') ? 'page.json'
               : lower.endsWith('.txt') ? 'page.txt'
               : 'page.html';
      var out = extractFromFile(name, html, bookName);
      if (out.length === 0) { toast('这个链接没挖到金句'); return; }
      refineWithLLMIfAvailable(out).then(function(r){
        if (r.pool.length === 0) { toast('AI 说一条都不够格 · 扫了 ' + out.length + ' 条候选'); return; }
        var n = mergeAndSave(r.pool);
        var tag = r.refined ? 'AI 精选' : '正则兜底';
        toast(n > 0
          ? '✓ 入库 ' + n + ' 条 · ' + bookName.slice(0, 20) + '（' + tag + '）'
          : '这条链接的金句全是库里已有的');
      });
    }).catch(function(err){
      st.close();
      toast('抓取失败：' + (err && err.message || err));
    });
  }

  function openImport() {
    var old = document.getElementById('pkImportModal');
    if (old) old.remove();
    var m = document.createElement('div');
    m.id = 'pkImportModal';
    m.className = 'pk-modal';
    m.innerHTML =
      '<div class="pk-mask"></div>' +
      '<div class="pk-card">' +
        '<h3>导入金句</h3>' +
        '<p class="pk-sub">支持 zip / json / md / txt / html / 链接 · 导入时会走 AI 精选</p>' +
        '<button class="calli-btn pk-pick-file" style="width:100%;margin-top:8px">选文件</button>' +
        '<div class="pk-or">或</div>' +
        '<input type="text" class="pk-url-input" placeholder="粘贴文章链接 https://…" />' +
        '<div class="pk-btns">' +
          '<button class="calli-btn pk-cancel">取消</button>' +
          '<button class="calli-btn primary pk-fetch-url">抓链接</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(m);
    var close = function(){ m.remove(); };
    var urlInp = m.querySelector('.pk-url-input');
    setTimeout(function(){ urlInp.focus(); }, 50);

    m.querySelector('.pk-mask').onclick = close;
    m.querySelector('.pk-cancel').onclick = close;
    m.querySelector('.pk-pick-file').onclick = function(){ close(); pickFileForImport(); };
    var doFetch = function(){
      var u = urlInp.value;
      if (!u || !u.trim()) { toast('先粘贴链接'); return; }
      close();
      importFromUrl(u);
    };
    m.querySelector('.pk-fetch-url').onclick = doFetch;
    urlInp.addEventListener('keydown', function(e){
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doFetch(); }
      if (e.key === 'Escape') close();
    });
  }

  // ===== 金句库管理 =====
  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  function openManager() {
    var old = document.getElementById('pkMgrModal');
    if (old) old.remove();

    var imported = [];
    function reload(){
      try { imported = JSON.parse(localStorage.getItem('paperkey.quotes') || '[]'); } catch(e){ imported = []; }
    }
    reload();

    var m = document.createElement('div');
    m.id = 'pkMgrModal';
    m.className = 'pk-modal';
    document.body.appendChild(m);

    var mode = 'book';        // 'book' | 'all'
    var expanded = {};        // source -> bool
    var clearPending = false;
    var clearTimer = null;

    function save() {
      localStorage.setItem('paperkey.quotes', JSON.stringify(imported));
      loadLibrary();
    }
    function close() {
      if (clearTimer) clearTimeout(clearTimer);
      m.remove();
    }
    function srcOf(q) { return q.source || '未标注出处'; }

    function renderAllList() {
      return imported.map(function(q, i){
        var meta = [];
        if (q.author) meta.push(q.author);
        if (q.source) meta.push(q.source);
        var metaStr = meta.length
          ? '<div class="pk-q-meta">' + escHtml(meta.join(' · ')) + '</div>'
          : '';
        return '<div class="pk-q-row">' +
          '<div class="pk-q-main">' +
            '<div class="pk-q-text">' + escHtml(q.text) + '</div>' +
            metaStr +
          '</div>' +
          '<button class="pk-q-del" title="删除" data-i="' + i + '">×</button>' +
        '</div>';
      }).join('');
    }

    function renderBookList() {
      var groups = {};
      imported.forEach(function(q, i){
        var k = srcOf(q);
        if (!groups[k]) groups[k] = [];
        groups[k].push({ q: q, idx: i });
      });
      var keys = Object.keys(groups).sort(function(a,b){ return groups[b].length - groups[a].length; });
      return keys.map(function(src){
        var items = groups[src];
        var isOpen = !!expanded[src];
        var bodyHtml = '';
        if (isOpen) {
          bodyHtml = '<div class="pk-book-body">' + items.map(function(it){
            var meta = it.q.author || '';
            return '<div class="pk-q-row pk-q-sub">' +
              '<div class="pk-q-main">' +
                '<div class="pk-q-text">' + escHtml(it.q.text) + '</div>' +
                (meta ? '<div class="pk-q-meta">' + escHtml(meta) + '</div>' : '') +
              '</div>' +
              '<button class="pk-q-del" title="删除" data-i="' + it.idx + '">×</button>' +
            '</div>';
          }).join('') + '</div>';
        }
        return '<div class="pk-book">' +
          '<div class="pk-book-head" data-src="' + escHtml(src) + '">' +
            '<span class="pk-book-arrow">' + (isOpen ? '▾' : '▸') + '</span>' +
            '<span class="pk-book-name">' + escHtml(src) + '</span>' +
            '<span class="pk-book-count">' + items.length + '</span>' +
            '<button class="pk-book-del" data-src="' + escHtml(src) + '" title="删除整本">×</button>' +
          '</div>' +
          bodyHtml +
        '</div>';
      }).join('');
    }

    function render() {
      var n = imported.length;
      var listHtml;
      if (n === 0) {
        listHtml = '<div class="pk-empty">还没有导入的金句 · 点「导入」添加</div>';
      } else if (mode === 'book') {
        listHtml = renderBookList();
      } else {
        listHtml = renderAllList();
      }

      var clearBtn = n > 0
        ? '<button class="calli-btn pk-clear-all">' + (clearPending ? '再点一次确认清空' : '清空全部导入') + '</button>'
        : '<span></span>';

      m.innerHTML =
        '<div class="pk-mask"></div>' +
        '<div class="pk-card pk-card-lg">' +
          '<div class="pk-mgr-head">' +
            '<h3>金句库</h3>' +
            '<div class="pk-sub">导入 ' + n + ' 条 · 内置 ' + BUILTIN.length + ' 条（内置不可删）</div>' +
          '</div>' +
          '<div class="pk-mgr-tabs">' +
            '<button class="pk-mgr-tab' + (mode==='book'?' active':'') + '" data-mode="book">按书</button>' +
            '<button class="pk-mgr-tab' + (mode==='all'?' active':'') + '" data-mode="all">全部</button>' +
          '</div>' +
          '<div class="pk-mgr-list">' + listHtml + '</div>' +
          '<div class="pk-btns">' +
            clearBtn +
            '<button class="calli-btn primary pk-close">完成</button>' +
          '</div>' +
        '</div>';
    }

    render();

    m.addEventListener('click', function(e){
      var t = e.target;
      if (t.classList.contains('pk-mask') || t.classList.contains('pk-close')) { close(); return; }

      if (t.classList.contains('pk-mgr-tab')) {
        mode = t.getAttribute('data-mode') || 'book';
        clearPending = false;
        if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
        render();
        return;
      }

      // 单条删除
      if (t.classList.contains('pk-q-del')) {
        var idx = parseInt(t.getAttribute('data-i'), 10);
        if (!isNaN(idx) && idx >= 0 && idx < imported.length) {
          imported.splice(idx, 1);
          save();
          render();
        }
        return;
      }

      // 整本删除
      if (t.classList.contains('pk-book-del')) {
        var bsrc = t.getAttribute('data-src');
        var before = imported.length;
        imported = imported.filter(function(q){ return srcOf(q) !== bsrc; });
        save();
        render();
        toast('已删除 ' + bsrc + '（' + (before - imported.length) + ' 条）');
        return;
      }

      // 展开/折叠
      var head = t.closest ? t.closest('.pk-book-head') : null;
      if (head && !t.classList.contains('pk-book-del')) {
        var src = head.getAttribute('data-src');
        expanded[src] = !expanded[src];
        render();
        return;
      }

      // 清空全部
      if (t.classList.contains('pk-clear-all')) {
        if (!clearPending) {
          clearPending = true;
          render();
          clearTimer = setTimeout(function(){
            clearPending = false;
            clearTimer = null;
            if (document.body.contains(m)) render();
          }, 2500);
        } else {
          imported = [];
          save();
          clearPending = false;
          if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
          render();
          toast('已清空');
        }
        return;
      }
    });
  }

  // ===== 挂载 =====
  function ready() {
    loadLibrary();
    var input = document.getElementById('typeInput');
    if (input) {
      input.addEventListener('input', onInput);
      input.addEventListener('compositionstart', onCompositionStart);
      input.addEventListener('compositionend', onCompositionEnd);
    }
    var stage = document.getElementById('typeText');
    if (stage) {
      stage.innerHTML = '<span class="type-empty">点"抽一句"开始 · 真打字，错字不前进</span>';
    }
    // Enter 键 = 抽下一句（IME 组字中不响应；Shift+Enter 允许换行，不触发）
    document.addEventListener('keydown', function(e){
      if (e.key !== 'Enter') return;
      if (state.composing) return;
      if (e.shiftKey) return;
      var inp = document.getElementById('typeInput');
      var resultBox = document.getElementById('typeResult');
      var inTyping = e.target === inp;
      var finished = !state.running && resultBox && !resultBox.hidden;
      if (!inTyping && !finished) return;
      e.preventDefault();
      start();
    });
  }

  window.__pk_typing = {
    start: start,
    import: openImport,
    manage: openManager,
    clear: openManager, // 兼容旧入口
    isRunning: function(){ return state.running; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready);
  } else {
    ready();
  }
})(); } catch (e) { console.error('[typing.js] crash:', e); }

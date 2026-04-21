# card-studio · 卡片书斋

> 把你读过的金句、写过的段落、看过的 PDF，变成可浏览的知识卡片，和可练习的打字素材。

一个本地优先的知识卡片工作站。上传一本书（PDF / Markdown / TXT / ZIP），用 Claude CLI 把内容解析成七种结构化卡片（术语 / 人物 / 反常识 / 金句 / 行动 / 技巧 / 任意）；或者把卡片库直接接入打字练习，敲字即复习。

---

## 它能做什么

| 能力 | 说明 |
|------|------|
| 书架视图 | 一本书一个格子，封面 + 标题 + 作者 + 卡片数 |
| 上传解析 | PDF（走 pdf2x.cn 或自建 parse 服务）/ Markdown / TXT / ZIP 拖拽或点选上传 |
| 七种卡片 | term · people · counter · quote · action · tech · wild，Claude CLI 生成 |
| 打字练习 | 任意卡片里的 quote 字段可进入打字模式（来自 paper-key 的 typing 引擎） |
| 本地数据 | 全部写 `./data`，不上云，不打点 |

---

## 快速开始 / Quick Start

```bash
# 1. 装依赖（需要 Node ≥ 18）
npm install

# 2. 启动（默认 http://localhost:3013）
npm start
```

首次启动会自动创建 `data/books` 和 `data/book_upload` 目录。

### PDF 上传需要的两件事

1. **Claude CLI**：用于把文本切成卡片。需要先在机器上跑通 `claude` 命令。
2. **PDF 解析服务**（下文 `PDF2X_ENDPOINT`）：把 PDF 转成 Markdown。默认走 `https://insightdoc.memect.cn`；也可以改指向自建 parse 服务。

---

## 环境变量 / Env Vars

| 变量 | 默认值 | 作用 |
|------|--------|------|
| `PORT` | `3013` | HTTP 端口 |
| `DATA_DIR` | `./data` | 书架 + 上传目录根 |
| `PDF2X_ENDPOINT` | `https://insightdoc.memect.cn` | PDF 解析服务地址；指向自建 parse 服务时填 `http://192.168.41.107:7004` 等 |
| `PDF2X_API_KEY` | —— | 仅 pdf2x.cn 需要，自建 parse 服务不需要 |
| `CLAUDE_BIN` | `claude` | Claude CLI 路径 |

---

## 架构 / Architecture

```
┌──────────────────┐     upload      ┌────────────────────┐
│  Browser (SPA)   │ ──────────────▶ │  Express Server    │
│  public/*.html   │                 │  server.js :3013   │
└──────────────────┘                 └─────────┬──────────┘
        ▲                                      │
        │ typing / reading                     ├──▶ PDF Parse Service
        │                                      │    (pdf2x.cn / 自建 7004)
        │                                      │
        │                                      ├──▶ Claude CLI
        │                                      │    生成卡片
        │                                      │
        │                                      └──▶ data/books/<id>/
        │                                           ├── book.json
        │                                           └── cards.json
        │
        └── public/typing/typing.js ◀── cards.json 的 quote 字段
```

---

## 数据目录 / Data Layout

```
data/
├── books/
│   └── <book-id>/
│       ├── book.json          # 元数据：title / author / cover / createdAt
│       ├── cards.json         # 七种卡片列表
│       └── source.md          # 解析后的原始 Markdown（可选）
└── book_upload/               # 临时上传区
```

### cards.json schema

```json
[
  {
    "id": "c1",
    "type": "term",
    "title": "心流 Flow",
    "fields": {
      "首创者": "Mihaly Csikszentmihalyi",
      "诞生时间": "1975",
      "原始定义": "..."
    },
    "source": "p.42",
    "tags": ["心理学"]
  }
]
```

七种 `type`：

| type | 中文 | 用来装什么 |
|------|------|-----------|
| term | 术语卡 | 专有名词、核心概念 |
| people | 人名卡 | 书中出现的关键人物 |
| counter | 反常识卡 | 挑战直觉的结论 |
| quote | 金句卡 | 可直接摘抄的句子，**打字模式的素材源** |
| action | 行动卡 | 可以照做的具体步骤 |
| tech | 技巧卡 | 方法论、套路 |
| wild | 任意卡 | 其他不好分类的 |

---

## API

| Method | 路径 | 作用 |
|--------|------|------|
| GET    | `/api/books` | 书架列表 |
| GET    | `/api/books/:id` | 某本书的元数据 |
| GET    | `/api/books/:id/cards` | 某本书的卡片 |
| POST   | `/api/books/upload` | 上传 Markdown / TXT / ZIP |
| POST   | `/api/books/upload-pdf` | 上传 PDF（走 PDF2X_ENDPOINT 解析） |
| DELETE | `/api/books/:id` | 删除一本书 |

---

## 打字模式 / Typing Mode

卡片库里所有 `type === "quote"` 的卡片，都会自动进入 `/typing` 页面的打字素材池。引擎来自 [paper-key](https://github.com/OrangeViolin/paper-key) 的 `typing.js`（修改版），原版在 paper-key 里保持不动。

特性：

- 支持中英文混排
- 本地存储进度（`localStorage` key `paperkey.quotes`）
- 直接从 `cards.json` 导入，也支持拖入 ZIP / JSON / TXT

---

## 路线图 / Roadmap

- [x] 书架 + 卡片渲染
- [x] PDF / Markdown / ZIP 上传
- [ ] URL 抓取（网页 → 卡片）
- [ ] 剪贴板捕获（选中即入库）
- [ ] 订阅远端 cards.json
- [ ] 文件夹拖入（批量）
- [ ] 打字模式 UI 接入到书架

---

## 致谢 / Credits

- **card-library** — 本项目前端 / 后端基础代码的起点
- **paper-key** — typing.js 打字引擎
- **pdf2x.cn / insightdoc.memect.cn** — PDF 解析服务
- **Claude Code** — 深度参与了本项目的架构和代码

---

## License

**GPL-3.0-or-later**

因为 typing.js 继承自 paper-key（GPL-3.0），本项目整体走 GPL-3.0。

- 你可以自由使用、修改、再分发（含商业用途）
- 衍生作品必须也采用 GPL-3.0 开源
- 分发二进制时需要同时提供源码
- 与 App Store 分发条款不兼容

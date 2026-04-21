# card-studio · 卡片书斋

> 把你读过的书、存过的文档、抓到的网页，变成可浏览的知识卡片集。

一个本地优先的知识卡片书斋。上传一本书（PDF / Markdown / TXT / ZIP），用 Claude CLI 把内容解析成七种结构化卡片（术语 / 人物 / 反常识 / 金句 / 行动 / 技巧 / 任意），摆进你的书架，翻阅、检索、收藏。

---

## 它能做什么

| 能力 | 说明 |
|------|------|
| 书架视图 | 一本书一个格子，封面 + 标题 + 作者 + 卡片数 |
| 文件上传 | PDF / Markdown / TXT / ZIP / 整个文件夹（拖进去就行） |
| PDF 解析 | 走 `pdf2x.cn` 或**自建 parse 服务**（环境变量切换） |
| 网页链接 | 贴一个 URL，服务器抓正文 → 生成卡片 |
| 粘贴文本 | 文章 / 笔记 / 聊天记录，任何长文直接粘进来 |
| 订阅导入 | 从远端 URL 拉 `cards.json` 或 `book.zip`，一键入库 |
| 七种卡片 | term · people · counter · quote · action · tech · wild，Claude CLI 生成 |
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
| `CARD_DATA_DIR` | `./data` | 书架 + 上传目录根 |
| `PDF_PARSE_URL` | `http://192.168.41.107:7004/pdf_parse` | **自建 parse 服务（V1 协议）的完整 URL**。默认走这个，不需要 API Key。设为 `off` 退回 pdf2x.cn |
| `PDF2X_ENDPOINT` | `https://insightdoc.memect.cn` | pdf2x.cn 网关（`PDF_PARSE_URL=off` 时生效） |
| `PDF2X_API_KEY` | —— | 仅 pdf2x.cn 路径需要 |
| `CLAUDE_CLI` | 自动探测 | Claude CLI 路径 |

**PDF 解析分两条路**：

- 默认：走内网 V1 服务 `http://192.168.41.107:7004/pdf_parse`（POST bytes + `async=true` → 轮询 → ZIP 解压出 `doc.md`），无需 Key
- 退路：`PDF_PARSE_URL=off` → 走 `pdf2x.cn` 的 `/api/parse/pdf2markdown`，需要 `PDF2X_API_KEY`

---

## 架构 / Architecture

```
┌──────────────────┐     upload      ┌────────────────────┐
│  Browser (SPA)   │ ──────────────▶ │  Express Server    │
│  public/*.html   │                 │  server.js :3013   │
└──────────────────┘                 └─────────┬──────────┘
        ▲                                      │
        │ read / browse                        ├──▶ PDF Parse Service
        │                                      │    (pdf2x.cn / 自建 7004)
        │                                      │
        │                                      ├──▶ Claude CLI
        │                                      │    生成卡片
        │                                      │
        │                                      └──▶ data/books/<id>/
        │                                           ├── book.json
        │                                           └── cards.json
        │
        └── 翻阅 / 检索 / 收藏
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
| quote | 金句卡 | 可直接摘抄的句子 |
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
| POST   | `/api/books/upload` | 上传 ZIP（成品直传 或 素材包） |
| POST   | `/api/books/upload-text` | 上传 Markdown / TXT 单文件 |
| POST   | `/api/books/upload-pdf` | 上传 PDF（自动选 V1 或 pdf2x） |
| POST   | `/api/books/upload-url` | `{ url }` 抓网页 → 卡片 |
| POST   | `/api/books/paste` | `{ text, title? }` 粘贴文本 → 卡片 |
| POST   | `/api/books/subscribe` | `{ url }` 从远端 URL 拉 cards.json 或 book.zip |
| GET    | `/api/books/jobs/:id` | 轮询生成任务进度 |
| DELETE | `/api/books/:id` | 删除一本书 |

---

## 路线图 / Roadmap

- [x] 书架 + 卡片渲染
- [x] PDF / Markdown / ZIP 上传
- [x] URL 抓取（网页 → 卡片）
- [x] 粘贴文本（文章 / 笔记 / 聊天记录）
- [x] 订阅远端 cards.json / book.zip
- [x] 文件夹拖入（递归读 .md/.txt）
- [x] 自建 parse 服务接入（V1 协议）
- [ ] 卡片检索 / 标签筛选 / 收藏
- [ ] 订阅的定时刷新（当前是一次性导入）
- [ ] 浏览器扩展：选中文字即入库

---

## 致谢 / Credits

- **card-library** — 本项目前端 / 后端基础代码的起点
- **pdf2x.cn / insightdoc.memect.cn** — PDF 解析服务
- **Claude Code** — 深度参与了本项目的架构和代码

---

## License

**GPL-3.0-or-later**

- 你可以自由使用、修改、再分发（含商业用途）
- 衍生作品必须也采用 GPL-3.0 开源
- 分发二进制时需要同时提供源码

# AI 任务分解与执行系统

基于大语言模型的任务规划与执行助手。输入一句项目目标，系统输出一棵可交互的层级任务树，并支持对单个节点追问执行方案、让 AI 从整棵树的高度做全局分析，同时把任务树、进度与对话历史持久化到云端。

前端为原生 HTML/CSS/JS（Material Design 3 风格），后端为 Node.js + Express 5 + SQLite，AI 通过 OpenAI 兼容的 Chat Completions 接口接入（默认 DeepSeek）。

---

## 核心功能

| 能力 | 说明 |
| --- | --- |
| **AI 任务分解** | 输入项目目标，模型按逻辑链拆分为层级任务树，并自动标注优先级（`high` / `normal` / `low`） |
| **导入已有导图** | 上传参考材料（图片或 `.txt`/`.md`），由模型解析为结构化任务树 |
| **单节点提问** | 对任意步骤提问；问题留空则生成该步骤的详细执行方案。回复流式输出，并以进度卡片挂载在节点上 |
| **项目全景助手** | 感知整棵树的结构与进度，回答关键路径、风险、工期、并行可行性等全局问题；支持独立配置专用 API |
| **任务树编辑** | 查看/编辑双模式、拖拽改层级（含防循环移动）、新增子节点、递归删除、标记完成、调整优先级、30 步撤销/重做 |
| **视图与检索** | 纵向/横向布局切换、节点标题与描述搜索高亮、画布缩放平移、2 倍分辨率 PNG 导出 |
| **结构与数据工具** | 任务概览统计、完整性诊断、JSON 备份与恢复、云端历史记录管理 |
| **账户体系** | 用户名密码登录（不存在则静默注册）、JWT 7 天有效期、WebAuthn 通行证免密登录、邮箱绑定与验证码找回密码 |
| **开发者模式** | 用自定义 API Key / Base URL / 模型替换默认服务，配置仅保存在浏览器本地 |
| **可观测性** | 操作审计日志（写入/查询/清空，分级限流）、`/api/health` 健康检查、请求级 `X-Request-Id` |

---

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 前端 | 原生 HTML / CSS / JavaScript，Material Design 3 视觉体系，SSE 流式渲染 |
| 后端 | Node.js ≥ 20，Express 5 |
| 数据库 | SQLite（`better-sqlite3`，WAL 默认，单文件存储） |
| 认证 | JWT（7 天）+ bcrypt 密码哈希 + WebAuthn / FIDO2 |
| AI | OpenAI 兼容 `/chat/completions`，默认 `deepseek-flash`，支持 `response_format: json_object` |
| 邮件 | nodemailer（QQ 邮箱 / 腾讯企业邮箱 SMTP） |
| 反向代理 | Nginx（静态站点 + `/api` 反代，SSE 免缓冲） |

---

## 目录结构

```
ai-task-decomposer/
├── backend/
│   ├── server.js              # 入口：路由、认证、AI 调用、静态托管
│   ├── lib/
│   │   ├── validation.js      # 入参与任务树校验、字段长度限制
│   │   ├── rate-limit.js      # 内存令牌桶限流中间件
│   │   └── tree-analytics.js  # 任务树统计与扁平化
│   ├── test/                  # node:test 单元测试（51 项）
│   ├── .env.example           # 环境变量模板
│   └── ai_tasks.db            # SQLite 运行时数据库（首次启动自动建表）
├── front/
│   ├── index.html             # 桌面端主界面（含内联应用逻辑）
│   ├── app-core.js            # 抽离的核心工具函数
│   ├── login.html             # 登录 / 注册 / 找回密码
│   ├── mobile/                # 移动端界面
│   └── favicon*、robots.txt
├── nginx/                     # 三站点配置：桌面端、移动端、API
├── start-local.ps1            # Windows 一键启动（缺依赖时自动安装）
├── 用户使用说明.md             # 面向最终用户的操作手册
├── 技术文档.md                 # 面向开发者的实现说明
└── docs/                      # 软著材料、历史版本、说明书
```

---

## 快速开始

### 环境要求

- Node.js **20 及以上**（`better-sqlite3` 12.x 的编译产物要求；推荐 22 LTS）
- npm 10 及以上
- 一个可用的 OpenAI 兼容 AI 服务 API Key

### 本地启动

```bash
git clone https://github.com/huangzhuoyue/ai-task-decomposer.git
cd ai-task-decomposer

# 1. 配置环境变量
cp backend/.env.example backend/.env
#    编辑 backend/.env，至少填写 JWT_SECRET 与 DEEPSEEK_API_KEY

# 2. 安装依赖
npm install --prefix backend

# 3. 启动
npm start --prefix backend
```

Windows 下可直接运行 `./start-local.ps1`：脚本会检测 `node_modules`，缺失时自动安装后启动。

启动后访问 <http://localhost:3200>。后端同时托管 `front/` 静态资源，因此本地无需额外启动前端服务。

### 环境变量

| 变量 | 必需 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `PORT` | 否 | `3200` | 监听端口 |
| `HOST` | 否 | `0.0.0.0` | 监听地址 |
| `NODE_ENV` | 否 | `development` | 生产环境设为 `production`，静态资源缓存 1 小时 |
| `JWT_SECRET` | **生产必需** | 内置默认值 | JWT 签名密钥，缺失时启动会告警；生产必须替换为长随机串 |
| `DEEPSEEK_API_KEY` | 是 | — | 默认 AI 服务密钥 |
| `AI_API_URL` | 否 | `https://api.deepseek.com/chat/completions` | OpenAI 兼容接口地址 |
| `DB_PATH` | 否 | `backend/ai_tasks.db` | SQLite 文件路径 |
| `RP_ID` | 否 | `hzyweb.xyz` | WebAuthn 依赖方 ID，本地测试填 `localhost` |
| `EXPECTED_ORIGIN` | 否 | 本地 + `hzyweb.xyz` + `m.hzyweb.xyz` | 允许的 WebAuthn 来源，逗号分隔 |
| `MAIL_USER` | 否 | 空 | 发信邮箱；留空则禁用验证码找回 |
| `MAIL_PASS` | 否 | 空 | 邮箱授权码（非登录密码） |
| `MAIL_FROM_NAME` | 否 | `AI任务拆解系统` | 邮件发件人显示名 |

> `backend/.env` 已被 `.gitignore` 排除，禁止提交任何真实密钥。

---

## 接口概览

所有接口以 `/api` 为前缀，请求与响应均为 JSON；AI 相关接口以 SSE 流式返回。

### 公开接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查，返回数据库状态、运行时长、服务器时间 |
| `POST` | `/api/login` | 用户名密码登录；用户不存在时静默注册（bcrypt 哈希后入库） |
| `POST` | `/api/password/send-reset-code` | 向已绑定邮箱发送 6 位验证码（5 分钟有效，60 秒间隔） |
| `POST` | `/api/password/reset` | 校验验证码并重置密码 |
| `POST` | `/api/auth/login/options`、`/api/auth/login/verify` | WebAuthn 免密登录挑战与校验 |
| `POST` | `/api/decompose` | 任务分解（支持附带图片），SSE 流式返回 |
| `POST` | `/api/import` | 导入导图/文本并解析为任务树，SSE 流式返回 |
| `POST` | `/api/ask` | 单节点提问；登录用户自动双写云端历史 |

### 需登录（`Authorization: Bearer <token>`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/trees` | 当前用户的任务树列表 |
| `GET` | `/api/trees/:id` | 读取指定任务树 |
| `POST` | `/api/trees` | 新建任务树 |
| `PUT` / `PATCH` | `/api/trees/:id` | 整体保存 / 局部更新（需为树所有者） |
| `DELETE` | `/api/trees/:id` | 删除任务树（需为树所有者） |
| `GET` | `/api/trees/:id/stats` | 节点数、根节点数、叶子数、最大深度、完成率、优先级分布、孤立节点数 |
| `POST` | `/api/trees/:id/regenerate` | 按指令重构任务树，返回提案供前端差异对比；默认保留完成状态与进度 |
| `GET` | `/api/history` | 节点级对话历史 |
| `GET` | `/api/chat-tree/history/:treeId` | 全景助手对话历史 |
| `POST` | `/api/chat-tree` | 全景助手提问（未登录可用，但不落库） |
| `GET` | `/api/user/profile` | 当前用户资料 |
| `POST` | `/api/user/email` | 绑定 / 更新邮箱（一邮箱仅限一个账号） |
| `GET` / `PUT` / `DELETE` | `/api/auth/credentials[/:id]` | 通行证列表、重命名、解绑 |
| `GET` / `POST` / `DELETE` | `/api/audit-logs` | 审计日志读取、写入、清空 |

### 数据表

首次启动自动建表：`users`（账号）、`user_trees`（整树快照）、`chat_history`（节点对话）、`global_chat_history`（全景助手对话）、`node_states`（节点记忆与摘要）、`webauthn_credentials`（通行证）、`audit_logs`（审计日志）。

---

## 使用限制与配额

| 项目 | 上限 |
| --- | --- |
| 单棵任务树节点数 | 500 |
| 任务树 JSON 体积 | 5 MB |
| 节点标题 / 描述 | 160 / 8000 字符 |
| 单次提问 | 12000 字符 |
| 单节点进度条目 | 100 条，单条 50000 字符 |
| 上传图片 | 最多 8 张，单张 8 MB |
| AI 接口限流 | 20 次 / 分钟（按用户或 IP） |
| 认证接口限流 | 30 次 / 10 分钟 |
| 审计日志 | 写 60 次/分，读 120 次/分，清空 5 次/10 分钟 |

限流为进程内内存实现，响应头返回 `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset`，超限返回 `429` 与 `Retry-After`。多实例部署时需替换为共享存储（如 Redis）。

---

## 部署

### 拓扑

```
hzyweb.xyz        →  /var/www/html/front        静态前端（桌面端）
m.hzyweb.xyz      →  /var/www/html/front/mobile 静态前端（移动端），/api/ 反代至 127.0.0.1:3000
api.hzyweb.xyz    →  proxy_pass 127.0.0.1:3000  仅提供 API
```

前端使用**同源** `fetch` 调用接口（`API_BASE = location.origin`），因此承载页面的站点必须把 `/api` 反代到后端，仅有 `api.` 子域是不够的。`nginx/` 下提供三份参考配置。

### 生产要点

1. 后端以 `NODE_ENV=production PORT=3000` 常驻（systemd 或 pm2），并设 `JWT_SECRET`。
2. Nginx 反代 AI 接口需关闭缓冲，否则 SSE 会被整体缓存：
   ```nginx
   location /api/ {
       proxy_pass http://127.0.0.1:3000;
       proxy_http_version 1.1;
       proxy_set_header Connection '';
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_buffering off;
       proxy_cache off;
       proxy_read_timeout 300s;
   }
   ```
3. WebAuthn 仅在安全上下文生效：必须使用 HTTPS，且 `RP_ID` 与访问域名一致。
4. 备份策略以 `ai_tasks.db` 单文件为准；升级前复制该文件即可回滚数据。

---

## 测试

```bash
npm run check --prefix backend   # 语法检查（server.js + app-core.js）
npm test --prefix backend        # 单元测试：validation / rate-limit / tree-analytics / app-core
```

当前状态：`node --check` 通过，`node --test` **51 项全部通过**。

---

## 已知限制

- **图片导入依赖模型视觉能力。** 默认模型 `deepseek-flash` 不支持 `image_url` 输入，上传图片会返回上游错误。文本（`.txt`/`.md`）导入不受影响；如需图片识别，请在个人中心的开发者模式中指向支持视觉的 OpenAI 兼容模型。
- **限流与验证码存储为进程内存。** 重启后计数与验证码清零；多实例部署不共享。
- **前端未做构建。** `index.html` 体量较大且含内联脚本，浏览器缓存依赖 `?v=` 版本参数，发版后需确认参数已更新。
- **移动端功能集为桌面端子集**，部分高级工具（备份/恢复、审计日志）未在移动端暴露。

---

## 安全与合规

- `.env`、私钥文件（`.pem` 等）、运行时数据库均**不得**提交到仓库；`.gitignore` 已覆盖 `.env*`，其余文件请在提交前逐一确认。
- 密码以 bcrypt 哈希存储；接口统一返回 400/401/429 等语义化状态码，不泄露内部堆栈。
- 默认安全响应头：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy`、`Permissions-Policy`。
- AI 侧内置内容安全策略：涉及违法、欺骗、色情、暴力等请求时，模型仅返回单个安全审查节点。
- 合法合规与原创性声明见 `docs/v1.1/关于《AI 任务拆解系统》合法合规及原创性声明.docx`。

---

## 相关文档

| 文档 | 读者 | 内容 |
| --- | --- | --- |
| [用户使用说明.md](./用户使用说明.md) | 最终用户 | 界面导航、任务分解、编辑、AI 对话、账户与常见问题 |
| [技术文档.md](./技术文档.md) | 开发者 | 架构、数据模型、接口与实现细节 |
| `docs/` | 归档 | 软著材料、历史版本说明、系统说明书 |

---

## 许可证

本项目采用仓库根目录 `LICENSE` 所声明的许可条款。

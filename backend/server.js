require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const util = require('util');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

// 环境变量配置
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key';
const SALT_ROUNDS = 10;
const API_KEY = process.env.ZHIPU_API_KEY;
const API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const RP_ID = process.env.RP_ID || 'hzyweb.xyz';
const EXPECTED_ORIGIN = process.env.EXPECTED_ORIGIN
    ? process.env.EXPECTED_ORIGIN.split(',').map(s => s.trim())
    : ['https://hzyweb.xyz', 'https://m.hzyweb.xyz'];

// 内存存储 Challenge（由于目前没有 Redis 等会话存储，使用 Map 暂存）
const challengeStore = new Map();

// 数据库初始化与建表
const db = new Database('ai_tasks.db');
db.exec(`
  -- 节点记忆状态表 (用于上下文压缩)
  CREATE TABLE IF NOT EXISTS node_states (
    node_id TEXT PRIMARY KEY,
    title TEXT,
    desc TEXT,
    summary TEXT DEFAULT '',
    recent_chat TEXT DEFAULT '[]',
    chat_count INTEGER DEFAULT 0
  );

  -- 用户表 (存储哈希加密后的密码)
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT
  );

  -- 全量聊天历史表 (云端持久化备份)
  CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    node_id TEXT,
    role TEXT,
    content TEXT,
    created_at DATETIME DEFAULT (datetime('now', '+8 hours'))
  );

  -- 整树快照表
  CREATE TABLE IF NOT EXISTS user_trees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    title TEXT,
    tree_data TEXT,
    created_at DATETIME DEFAULT (datetime('now', '+8 hours'))
  );
  
  -- WebAuthn 凭证表
  CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    credential_id TEXT UNIQUE,
    public_key TEXT,
    counter INTEGER,
    device_name TEXT DEFAULT '未命名设备',
    created_at DATETIME DEFAULT (datetime('now', '+8 hours'))
  );

  -- 全局聊天历史 (针对整个树的问答)
  CREATE TABLE IF NOT EXISTS global_chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tree_id INTEGER,
    role TEXT,
    content TEXT,
    created_at DATETIME DEFAULT (datetime('now', '+8 hours'))
  );
`);
// 数据库迁移：确保 webauthn_credentials 表中有 device_name 列
try {
    db.prepare("ALTER TABLE webauthn_credentials ADD COLUMN device_name TEXT DEFAULT '未命名设备'").run();
} catch (e) {
    // 列可能已经存在，忽略错误
}


// ================= 中间件与辅助函数 =================

// 宽松鉴权中间件：不强制登录，访客放行（挂载 userId = null）
const optionalAuthMiddleware = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        req.userId = null;
        return next();
    }
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        req.userId = err ? null : decoded.userId;
        next();
    });
};

// 严格鉴权中间件：强制必须登录
const strictAuthMiddleware = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: '未登录' });
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(403).json({ error: 'Token 无效或已过期' });
        req.userId = decoded.userId;
        next();
    });
};

// 帮助提取 Axios 错误信息 (特别是支持 stream 模式下的错误)
async function getAxiosError(error) {
    if (!error.response) return error.message;
    const status = error.response.status;

    // 如果是 stream，需要尝试读取数据
    if (error.response.data && typeof error.response.data.on === 'function') {
        try {
            const body = await new Promise((resolve) => {
                let data = '';
                error.response.data.on('data', chunk => { data += chunk; });
                error.response.data.on('end', () => { resolve(data); });
                error.response.data.on('error', () => { resolve(''); });
                setTimeout(() => resolve(''), 1000); // 1秒超时
            });
            return `Status ${status}: ${body || error.message}`;
        } catch (e) {
            return `Status ${status}: ${error.message}`;
        }
    }

    // 非 stream 模式且有 data
    try {
        const body = typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data);
        return `Status ${status}: ${body}`;
    } catch (e) {
        return `Status ${status}: ${error.message}`;
    }
}

// 动态获取 AI 配置 (开发者模式支持)
function getAIConfig(req) {
    const devKey = req.headers['x-dev-key'];
    const devBase = req.headers['x-dev-base'];
    const devModel = req.headers['x-dev-model'];
    const devBodyStr = req.headers['x-dev-body'];

    if (devKey) {
        let customBody = {};
        try { if (devBodyStr) customBody = JSON.parse(devBodyStr); } catch (e) { console.error('Error parsing X-Dev-Body:', e); }
        const config = {
            apiKey: devKey,
            apiUrl: devBase || 'https://api.openai.com/v1/chat/completions',
            model: devModel || 'glm-4.6v',
            customBody: customBody,
            isDev: true
        };
        console.log(`[Developer Mode] Using custom API: ${config.model} @ ${config.apiUrl}`);
        return config;
    }

    return {
        apiKey: API_KEY,
        apiUrl: API_URL,
        model: 'glm-4.6v',
        customBody: {},
        isDev: false
    };
}

// LLM 摘要调用函数 (支持自定义配置)
async function callLLMSummary(messages, config = null) {
    const cfg = config || { apiKey: API_KEY, apiUrl: API_URL, model: 'GLM-4.6V-FlashX', customBody: {} };
    const payload = {
        model: cfg.model || 'GLM-4.6V-FlashX',
        messages: messages,
        temperature: 0.5,
        ...cfg.customBody
    };

    const response = await axios.post(cfg.apiUrl, payload, {
        headers: { 'Authorization': `Bearer ${cfg.apiKey}` }
    });
    return response.data.choices[0].message.content;
}

// ================= API 路由 =================

// 1. 登录与自动注册接口 (Bcrypt 加密)
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

        if (!user) {
            // 用户不存在 -> 执行静默注册
            const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
            const info = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username, hashedPassword);
            user = { id: info.lastInsertRowid, username };
        } else {
            // 用户存在 -> 比对哈希密码
            const match = await bcrypt.compare(password, user.password);
            if (!match) return res.status(401).json({ error: '密码错误' });
        }

        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, message: '认证成功' });
    } catch (error) {
        console.error('Login Error:', error);
        res.status(500).json({ error: '服务器内部错误' });
    }
});



// ================= 新增：WebAuthn API 路由 =================

// 1. 生成绑定选项 (需要已登录，使用 strictAuthMiddleware)
app.get('/api/auth/register/options', strictAuthMiddleware, async (req, res) => {
    try {
        const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.userId);
        if (!user) return res.status(404).json({ error: '用户不存在' });

        // 获取用户已绑定的设备，防止重复绑定
        const existingCreds = db.prepare('SELECT credential_id FROM webauthn_credentials WHERE user_id = ?').all(req.userId);
        console.log("=== 正在生成注册选项，检查参数 ===");
        console.log("1. RP_ID:", RP_ID);
        console.log("2. userID:", req.userId);
        console.log("3. userName:", user.username);
        const options = await generateRegistrationOptions({
            rpName: '我的 AI 任务系统',
            rpID: RP_ID,
            userID: new Uint8Array(Buffer.from(req.userId.toString())),
            userName: user.username,
            excludeCredentials: existingCreds.map(cred => ({
                id: cred.credential_id,
                type: 'public-key',
            })),
            authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
        });

        // 暂存 Challenge，时效可设置 5 分钟
        challengeStore.set(`reg_${req.userId}`, options.challenge);
        res.json(options);
    } catch (error) {
        console.error('【生成注册选项报错完整信息】:', error);
        res.status(500).json({ error: '生成注册选项失败' });
    }
});

//  验证并绑定设备 (需要已登录)
app.post('/api/auth/register/verify', strictAuthMiddleware, async (req, res) => {
    try {
        const expectedChallenge = challengeStore.get(`reg_${req.userId}`);
        if (!expectedChallenge) return res.status(400).json({ error: '请求超时或无效' });

        // 调试日志：查看浏览器实际发送的 origin
        try {
            const clientData = JSON.parse(Buffer.from(req.body.response.clientDataJSON, 'base64url').toString());
            console.log('【调试】浏览器实际 origin:', clientData.origin);
            console.log('【调试】服务端期望 origin:', EXPECTED_ORIGIN);
        } catch (e) { console.log('【调试】无法解析 clientDataJSON'); }

        const verification = await verifyRegistrationResponse({
            response: req.body,
            expectedChallenge,
            expectedOrigin: EXPECTED_ORIGIN,
            expectedRPID: RP_ID,
        });

        const { deviceName } = req.body; // 获取前端传来的设备名称

        if (verification.verified && verification.registrationInfo) {
            const { credential } = verification.registrationInfo;
            const pubKeyBase64 = Buffer.from(credential.publicKey).toString('base64');
            const credIdBase64 = credential.id;

            db.prepare('INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, device_name) VALUES (?, ?, ?, ?, ?)').run(
                req.userId, credIdBase64, pubKeyBase64, credential.counter, deviceName || '未知设备'
            );

            challengeStore.delete(`reg_${req.userId}`);
            res.json({ success: true });
        } else {
            res.status(400).json({ error: '验证失败' });
        }
    } catch (error) {
        console.error('【注册验证报错】:', error);
        res.status(500).json({ error: '设备绑定失败: ' + error.message });
    }
});

//  生成登录选项 (未登录状态，通过 username 获取信息)
app.post('/api/auth/login/options', async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: '需要用户名' });

    try {
        const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
        if (!user) return res.status(404).json({ error: '用户不存在' });

        const credentials = db.prepare('SELECT credential_id FROM webauthn_credentials WHERE user_id = ?').all(user.id);
        if (credentials.length === 0) return res.status(400).json({ error: '该用户未绑定任何通行证' });

        const options = await generateAuthenticationOptions({
            rpID: RP_ID,
            allowCredentials: credentials.map(cred => ({
                id: cred.credential_id,
                type: 'public-key',
            })),
            userVerification: 'preferred',
        });

        challengeStore.set(`login_${user.id}`, options.challenge);
        res.json({ options, userId: user.id });
    } catch (error) {
        res.status(500).json({ error: '生成登录选项失败' });
    }
});

//  验证登录签名
app.post('/api/auth/login/verify', async (req, res) => {
    const { assertion, userId } = req.body;
    try {
        const expectedChallenge = challengeStore.get(`login_${userId}`);
        if (!expectedChallenge) return res.status(400).json({ error: '登录会话已过期' });

        const credIdBase64 = assertion.id;
        const cred = db.prepare('SELECT * FROM webauthn_credentials WHERE user_id = ? AND credential_id = ?').get(userId, credIdBase64);

        if (!cred) return res.status(400).json({ error: '未找到匹配的设备' });

        const verification = await verifyAuthenticationResponse({
            response: assertion,
            expectedChallenge,
            expectedOrigin: EXPECTED_ORIGIN,
            expectedRPID: RP_ID,
            credential: {
                id: cred.credential_id,
                publicKey: Buffer.from(cred.public_key, 'base64'),
                counter: cred.counter,
            },
        });

        if (verification.verified) {
            db.prepare('UPDATE webauthn_credentials SET counter = ? WHERE id = ?').run(verification.authenticationInfo.newCounter, cred.id);
            challengeStore.delete(`login_${userId}`);

            const token = jwt.sign({ userId: cred.user_id }, JWT_SECRET, { expiresIn: '7d' });
            res.json({ success: true, token, message: '通行证认证成功' });
        } else {
            res.status(400).json({ error: '签名验证失败' });
        }
    } catch (error) {
        console.error('【登录验证报错】:', error);
        res.status(500).json({ error: '系统内部错误: ' + error.message });
    }
});



//  获取当前用户的通行证列表
app.get('/api/auth/credentials', strictAuthMiddleware, (req, res) => {
    try {
        // 安全起见：只返回凭证的内部 id、设备名和创建时间
        const credentials = db.prepare('SELECT id, device_name, created_at FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at DESC').all(req.userId);

        res.json(credentials);
    } catch (error) {
        console.error('Fetch Credentials Error:', error);
        res.status(500).json({ error: '获取通行证列表失败' });
    }
});

//  删除（解绑）指定的通行证
app.delete('/api/auth/credentials/:id', strictAuthMiddleware, (req, res) => {
    const credId = req.params.id;

    try {
        // 安全检查：必须同时匹配 id 和当前请求的 user_id
        // 这能防止恶意用户通过遍历 id 来删除其他人的凭证（防越权漏洞）
        const info = db.prepare('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?').run(credId, req.userId);

        if (info.changes > 0) {
            res.json({ success: true, message: '设备解绑成功' });
        } else {
            res.status(404).json({ error: '通行证不存在或无权删除' });
        }
    } catch (error) {
        console.error('Delete Credential Error:', error);
        res.status(500).json({ error: '删除通行证失败' });
    }
});

//  修改通行证设备名称 (需要已登录)
app.put('/api/auth/credentials/:id', strictAuthMiddleware, (req, res) => {
    const credId = req.params.id;
    const { deviceName } = req.body;
    if (!deviceName) return res.status(400).json({ error: '设备名称不能为空' });

    try {
        const info = db.prepare('UPDATE webauthn_credentials SET device_name = ? WHERE id = ? AND user_id = ?').run(deviceName, credId, req.userId);
        if (info.changes > 0) {
            res.json({ success: true, message: '设备名称已更新' });
        } else {
            res.status(404).json({ error: '通行证不存在或无权修改' });
        }
    } catch (error) {
        console.error('Update Credential Name Error:', error);
        res.status(500).json({ error: '更新设备名称失败' });
    }
});

//  获取用户云端历史记录 (严格鉴权)
app.get('/api/history', strictAuthMiddleware, (req, res) => {
    const { nodeId } = req.query;
    if (!nodeId) return res.status(400).json({ error: '缺少 nodeId 参数' });
    try {
        const history = db.prepare(`SELECT role, content, created_at FROM chat_history WHERE user_id = ? AND node_id = ? ORDER BY created_at ASC`).all(req.userId, nodeId);
        res.json(history);
    } catch (error) {
        console.error('History Query Error:', error);
        res.status(500).json({ error: '获取历史记录失败' });
    }
});

//  任务拆解接口 (无状态)
app.post('/api/decompose', async (req, res) => {
    const config = getAIConfig(req);
    try {
        const { taskText, images } = req.body;
        let userContent;
        if (images && images.length > 0) {
            userContent = [{ type: "text", text: taskText }];
            images.forEach(imgBase64 => {
                userContent.push({ type: "image_url", image_url: { url: imgBase64 } });
            });
        } else {
            userContent = taskText;
        }

        const messages = [
            { role: 'system', content: `用中文回复。你是一名专业的任务拆解专家，请按照逻辑链将任务拆分为细小步骤。每个小步骤的 parentId 应为上一步骤的 id（若为根节点则为 null）。你必须且只能严格按照 JSON 数组格式输出，不包含任何 Markdown 标签。格式要求：[{"id": "唯一数字或字符串", "parentId": "父节点 id", "title": "步骤名称", "desc": "具体操作内容"}] ` },
            { role: 'user', content: userContent }
        ];

        // 构建请求负载
        const requestData = {
            model: config.model,
            messages: messages,
            stream: true,
            "thinking": { "type": "disabled" },
            ...config.customBody
        };

        const response = await axios({
            method: 'post',
            url: config.apiUrl,
            responseType: 'stream',
            headers: { 'Authorization': `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
            data: requestData
        });

        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        response.data.pipe(res);

    } catch (error) {
        const errorMsg = await getAxiosError(error);
        console.error('Decompose request failed:', errorMsg);
        res.status(500).json({ error: `Backend processing failed: ${errorMsg}` });
    }
});

//  节点对话接口 (宽松鉴权 + 数据双写)
app.post('/api/ask', optionalAuthMiddleware, async (req, res) => {
    const config = getAIConfig(req);
    const { nodeId, title, desc, userQuestion } = req.body;
    const userId = req.userId; // 可能是 null(访客) 或 具体ID(已登录)

    try {
        // --- 1. 处理节点短记忆 ---
        let stmt = db.prepare('SELECT * FROM node_states WHERE node_id = ?');
        let nodeState = stmt.get(nodeId);

        if (!nodeState) {
            db.prepare('INSERT INTO node_states (node_id, title, desc) VALUES (?, ?, ?)').run(nodeId, title, desc);
            nodeState = { summary: '', recent_chat: '[]', chat_count: 0 };
        }

        const recentChat = JSON.parse(nodeState.recent_chat);
        const currentQuestion = userQuestion || "请提供此步骤的具体执行计划。";

        // --- 2. 写入全量历史 (仅登录用户) ---
        if (userId) {
            db.prepare('INSERT INTO chat_history (user_id, node_id, role, content) VALUES (?, ?, ?, ?)').run(userId, nodeId, 'user', currentQuestion);
        }

        // --- 3. 构建大模型上下文 ---
        let messages = [{ role: 'system', content: `You are a project execution assistant. Current task: ${title}. Description: ${desc}. Please provide concise guidance directly.` }];
        if (nodeState.summary) messages.push({ role: 'system', content: `[Previous Progress Memory]: ${nodeState.summary}` });
        messages.push(...recentChat);
        messages.push({ role: 'user', content: currentQuestion });

        // --- 4. 发起 SSE 流式请求 ---
        const requestData = {
            model: config.model,
            messages: messages,
            stream: true,
            "thinking": { "type": "disabled" },
            ...config.customBody
        };

        const response = await axios({
            method: 'post',
            url: config.apiUrl,
            responseType: 'stream',
            headers: { 'Authorization': `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
            data: requestData
        });

        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        let aiAnswer = '';
        response.data.on('data', chunk => {
            res.write(chunk);
            const lines = chunk.toString().split('\n');
            for (const line of lines) {
                if (line.trim().startsWith('data: ') && !line.includes('[DONE]')) {
                    try {
                        const data = JSON.parse(line.trim().slice(6));
                        if (data.choices?.[0]?.delta?.content) aiAnswer += data.choices[0].delta.content;
                    } catch (e) { }
                }
            }
        });

        // --- 5. 请求结束处理 (写历史与上下文压缩) ---
        response.data.on('end', async () => {
            res.end();

            // 写入 AI 回复到全量历史
            if (userId && aiAnswer) {
                db.prepare('INSERT INTO chat_history (user_id, node_id, role, content) VALUES (?, ?, ?, ?)').run(userId, nodeId, 'assistant', aiAnswer);
            }

            recentChat.push({ role: 'user', content: currentQuestion });
            recentChat.push({ role: 'assistant', content: aiAnswer });
            let newCount = nodeState.chat_count + 1;

            if (newCount >= 4) {
                console.log(`[Node ${nodeId}] Triggering context compression...`);
                const summaryMessages = [
                    { role: 'system', content: '你是一名文本摘要助手。' },
                    { role: 'user', content: `请用中文回复。请将以下历史执行进度总结为不超过 200 字的简洁摘要，保留核心进展与待办事项。\n已有的总结: ${nodeState.summary}\n最新对话: ${JSON.stringify(recentChat)}` }
                ];
                const newSummary = await callLLMSummary(summaryMessages, config);
                db.prepare('UPDATE node_states SET summary = ?, recent_chat = ?, chat_count = ? WHERE node_id = ?').run(newSummary, '[]', 0, nodeId);
            } else {
                db.prepare('UPDATE node_states SET recent_chat = ?, chat_count = ? WHERE node_id = ?').run(JSON.stringify(recentChat), newCount, nodeId);
            }
        });

    } catch (error) {
        const errorMsg = await getAxiosError(error);
        console.error('Ask request failed:', errorMsg);
        if (!res.headersSent) res.status(500).json({ error: `Backend processing failed: ${errorMsg}` });
    }
});

//  导入解析接口 (无状态)
app.post('/api/import', async (req, res) => {
    const { taskText, images = [] } = req.body;

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const IMPORT_PROMPT = `你是一个专业的数据结构转换引擎。用户将提供一张思维导图的图片，或者一份包含层级关系（如 Markdown 列表）的文档。
你的唯一任务是：提取其中的节点和层级，将其转换为扁平化的 JSON 数组格式。
规则：
1. 必须且只能输出一个 JSON 数组。不要有任何 Markdown 代码块或解释性文字。
2. 数组中的每个对象必须严格包含四个字段："id", "title", "desc", "parentId"（根节点 parentId 为 null）。
3. 严禁改变原图或原文档中的逻辑层级和从属关系 。格式要求如下：
[{
  "id": "唯一编号或字符串",
  "parentId": "父节点的ID",
  "title": "步骤名称",
  "desc": "具体操作内容"
}]`;
    const contentList = [{ type: 'text', text: taskText }];
    if (images && images.length > 0) {
        images.forEach(imgBase64 => {
            contentList.push({ type: 'image_url', image_url: { url: imgBase64 } });
        });
    }

    const messages = [
        { role: 'system', content: IMPORT_PROMPT },
        { role: 'user', content: contentList }
    ];

    const config = getAIConfig(req);

    try {
        const fullContent = await callLLMSummary(messages, config);
        const chunkData = { choices: [{ delta: { content: fullContent } }] };

        res.write(`data: ${JSON.stringify(chunkData)}\n\n`);
        res.write('data: [DONE]\n\n');
    } catch (error) {
        console.error('Import API Error:', error);
        const errorData = { choices: [{ delta: { content: "\n[后端请求或解析失败]" } }] };
        res.write(`data: ${JSON.stringify(errorData)}\n\n`);
        res.write('data: [DONE]\n\n');
    } finally {
        res.end();
    }
});

// ================= 整树状态接口 =================


// 获取当前用户的历史树列表
app.get('/api/trees', strictAuthMiddleware, (req, res) => {
    try {
        const trees = db.prepare('SELECT id, title, created_at FROM user_trees WHERE user_id = ? ORDER BY created_at DESC').all(req.userId);
        res.json(trees);
    } catch (err) {
        res.status(500).json({ error: '获取历史列表失败' });
    }
});

// 获取单棵树的完整数据 (主干 + 进度节点)
app.get('/api/trees/:id', strictAuthMiddleware, (req, res) => {
    try {
        const tree = db.prepare('SELECT tree_data FROM user_trees WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
        if (!tree) return res.status(404).json({ error: '记录不存在' });
        res.json(JSON.parse(tree.tree_data));
    } catch (err) {
        res.status(500).json({ error: '获取树详情失败' });
    }
});


app.post('/api/trees', strictAuthMiddleware, (req, res) => {
    const { title, tree_data } = req.body;
    try {
        const info = db.prepare('INSERT INTO user_trees (user_id, title, tree_data) VALUES (?, ?, ?)').run(req.userId, title, JSON.stringify(tree_data));
        res.json({ success: true, id: info.lastInsertRowid }); // 返回生成的 id
    } catch (err) {
        console.error('保存树失败:', err);
        res.status(500).json({ error: '保存历史记录失败' });
    }
});


app.put('/api/trees/:id', strictAuthMiddleware, (req, res) => {
    const { tree_data } = req.body;
    try {
        db.prepare('UPDATE user_trees SET tree_data = ? WHERE id = ? AND user_id = ?').run(JSON.stringify(tree_data), req.params.id, req.userId);
        res.json({ success: true });
    } catch (err) {
        console.error('更新树失败:', err);
        res.status(500).json({ error: '更新历史记录失败' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend proxy and compression engine started, listening on port: ${PORT}`));

// ================= 全局树 Q&A 接口 (无鉴权) =================

// 1. 全局问答对话接口
app.post('/api/chat-tree', async (req, res) => {
    const config = getAIConfig(req);
    const { treeId, treeData, question, history = [] } = req.body;

    try {
        const messages = [
            {
                role: 'system',
                content: `你是一个全方位的项目分析专家。用户已经将任务拆解为如下树状结构：
${JSON.stringify(treeData.mainNodes)}
每个节点可能还包含如下执行进度：
${JSON.stringify(treeData.progressNodes)}

请结合整个任务树的结构、逻辑关联以及已有的进度信息，回答用户关于该项目的全局性、总结性或协调性问题。你应当能够指出关键路径、风险点以及资源分配建议等。请用中文回答。`
            }
        ];

        // 添加历史记录
        messages.push(...history);
        messages.push({ role: 'user', content: question });

        const requestData = {
            model: config.model,
            messages: messages,
            stream: true,
            "thinking": { "type": "disabled" },
            ...config.customBody
        };

        const response = await axios({
            method: 'post',
            url: config.apiUrl,
            responseType: 'stream',
            headers: { 'Authorization': `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
            data: requestData
        });

        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        let aiAnswer = '';
        response.data.on('data', chunk => {
            res.write(chunk);
            const lines = chunk.toString().split('\n');
            for (const line of lines) {
                if (line.trim().startsWith('data: ') && !line.includes('[DONE]')) {
                    try {
                        const data = JSON.parse(line.trim().slice(6));
                        if (data.choices?.[0]?.delta?.content) aiAnswer += data.choices[0].delta.content;
                    } catch (e) { }
                }
            }
        });

        response.data.on('end', () => {
            res.end();
            // 如果提供了 treeId，保存到数据库
            if (treeId && aiAnswer) {
                db.prepare('INSERT INTO global_chat_history (tree_id, role, content) VALUES (?, ?, ?)').run(treeId, 'user', question);
                db.prepare('INSERT INTO global_chat_history (tree_id, role, content) VALUES (?, ?, ?)').run(treeId, 'assistant', aiAnswer);
            }
        });

    } catch (error) {
        const errorMsg = await getAxiosError(error);
        console.error('Chat-tree request failed:', errorMsg);
        if (!res.headersSent) res.status(500).json({ error: `Backend processing failed: ${errorMsg}` });
    }
});

// 2. 获取全局对话历史 (无鉴权)
app.get('/api/chat-tree/history/:treeId', (req, res) => {
    try {
        const history = db.prepare('SELECT role, content, created_at FROM global_chat_history WHERE tree_id = ? ORDER BY created_at ASC').all(req.params.treeId);
        res.json(history);
    } catch (error) {
        res.status(500).json({ error: '获取历史记录失败' });
    }
});
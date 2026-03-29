require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// 环境变量配置
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key';
const SALT_ROUNDS = 10;
const API_KEY = process.env.ZHIPU_API_KEY;
const API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

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

// LLM 摘要调用函数
async function callLLMSummary(messages) {
    const response = await axios.post(API_URL, {
        model: 'GLM-4.6V-FlashX', 
        messages: messages,
        temperature: 0.5
    }, {
        headers: { 'Authorization': `Bearer ${API_KEY}` }
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

// 2. 获取用户云端历史记录 (严格鉴权)
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

// 3. 任务拆解接口 (无状态)
app.post('/api/decompose', async (req, res) => {
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
            { role: 'system', content: `用中文回复。你是一名专业的任务拆解专家，请按照逻辑链将任务拆分为细小步骤。每个小步骤的 parentId 应为上一步骤的 id（若为根节点则为 null）。你必须且只能严格按照 JSON 数组格式输出，不包含任何 Markdown 标签。格式要求：[{"id": "唯一数字或字符串", "parentId": "父节点 id", "title": "步骤名称", "desc": "具体操作内容"}] `},
            { role: 'user', content: userContent }
        ];

        const response = await axios({
            method: 'post', url: API_URL, responseType: 'stream',
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
            data: { model: 'glm-4.6v', messages: messages, stream: true, "thinking": { "type": "disabled" } }
        });

        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        response.data.pipe(res);

    } catch (error) {
        console.error('Decompose request failed:', error.message);
        res.status(500).json({ error: 'Backend processing failed' });
    }
});

// 4. 节点对话接口 (宽松鉴权 + 数据双写)
app.post('/api/ask', optionalAuthMiddleware, async (req, res) => {
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
        const response = await axios({
            method: 'post', url: API_URL, responseType: 'stream',
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
            data: { model: 'glm-4.6v', messages: messages, stream: true ,"thinking": {"type": "disabled" }}
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
                    } catch(e) {}
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
                console.log(`[Node ${nodeId}] Triggering GLM-4.6V-FlashX context compression...`);
                const summaryMessages = [
                    { role: 'system', content: '你是一名文本摘要助手。' },
                    { role: 'user', content: `请用中文回复。请将以下历史执行进度总结为不超过 200 字的简洁摘要，保留核心进展与待办事项。\n已有的总结: ${nodeState.summary}\n最新对话: ${JSON.stringify(recentChat)}` }
                ];
                const newSummary = await callLLMSummary(summaryMessages);
                db.prepare('UPDATE node_states SET summary = ?, recent_chat = ?, chat_count = ? WHERE node_id = ?').run(newSummary, '[]', 0, nodeId);
            } else {
                db.prepare('UPDATE node_states SET recent_chat = ?, chat_count = ? WHERE node_id = ?').run(JSON.stringify(recentChat), newCount, nodeId);
            }
        });

    } catch (error) {
        console.error('Ask request failed:', error.message);
        if (!res.headersSent) res.status(500).json({ error: 'Backend processing failed' });
    }
});

// 5. 导入解析接口 (无状态)
app.post('/api/import', async (req, res) => {
    const { taskText, images = [] } = req.body;

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const IMPORT_PROMPT = `你是一个专业的数据结构转换引擎。用户将提供一张思维导图的图片，或者一份包含层级关系（如 Markdown 列表）的文档。
你的唯一任务是：提取其中的节点和层级，将其转换为扁平化的 JSON 数组格式。
规则：
1. 必须且只能输出一个 JSON 数组。不要有任何 Markdown 代码块（\`\`\`json）或解释性文字。
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

    try {
        const fullContent = await callLLMSummary(messages);
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend proxy and compression engine started, listening on port: ${PORT}`));
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const db = new Database('ai_tasks.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS node_states (
    node_id TEXT PRIMARY KEY,
    title TEXT,
    desc TEXT,
    summary TEXT DEFAULT '',
    recent_chat TEXT DEFAULT '[]',
    chat_count INTEGER DEFAULT 0
  )
`);

const API_KEY = process.env.ZHIPU_API_KEY;
const API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

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
            data: {
                model: 'glm-4.6v', 
                messages: messages,
                stream: true,
  "thinking": {
    "type": "disabled"
  }
            }
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

app.post('/api/ask', async (req, res) => {

    const { nodeId, title, desc, userQuestion } = req.body;

    try {
        let stmt = db.prepare('SELECT * FROM node_states WHERE node_id = ?');
        let nodeState = stmt.get(nodeId);

        if (!nodeState) {
            db.prepare('INSERT INTO node_states (node_id, title, desc) VALUES (?, ?, ?)').run(nodeId, title, desc);
            nodeState = { summary: '', recent_chat: '[]', chat_count: 0 };
        }

        const recentChat = JSON.parse(nodeState.recent_chat);
        const currentQuestion = userQuestion || "Please provide a specific execution plan for this step.";

        let messages = [
            { role: 'system', content: `You are a project execution assistant. Current task: ${title}. Description: ${desc}. Please provide concise guidance directly.` }
        ];
        if (nodeState.summary) messages.push({ role: 'system', content: `[Previous Progress Memory]: ${nodeState.summary}` });
        messages.push(...recentChat);
        messages.push({ role: 'user', content: currentQuestion });

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

        response.data.on('end', async () => {
            res.end();
            recentChat.push({ role: 'user', content: currentQuestion });
            recentChat.push({ role: 'assistant', content: aiAnswer });
            let newCount = nodeState.chat_count + 1;

            if (newCount >= 4) { 
                console.log(`[Node ${nodeId}] Triggering GLM-4.6V-FlashX context compression...`);
                const summaryMessages = [
                    { role: 'system', content: 'You are a text summarization assistant.' },
                    { role: 'user', content: `Response use Chinese.Please summarize the following historical execution progress into a concise summary of no more than 200 words. Retain core progress and pending items.\nExisting summary: ${nodeState.summary}\nLatest chat: ${JSON.stringify(recentChat)}` }
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

app.post('/api/import', async (req, res) => {
    const { taskText, images = [] } = req.body;

    // 必须保留这些响应头，否则前端的 fetchSSE 无法正常建立流式监听
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
        // 调用现有的非流式请求函数，等待大模型一次性生成完整的 JSON 数组字符串
        const fullContent = await callLLMSummary(messages);

        // 核心纠正步骤：将完整内容包装为前端 fetchSSE 能够成功解析的 OpenAI 兼容格式
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
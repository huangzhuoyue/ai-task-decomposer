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
            { role: 'system', content: `Reply use Chinese.You are a professional task breakdown expert. Please break it down into small steps on a logical chain. The parentId of each small step should be the id of the previous step (if it is a root node, it is null). You must and can only output strictly in JSON array format, without any Markdown tags. Format requirement: [{"id": "unique number or string", "parentId": "id of the parent node", "title": "step name", "desc": "what exactly to do"}]` },
            { role: 'user', content: userContent }
        ];

        const response = await axios({
            method: 'post', url: API_URL, responseType: 'stream',
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
            data: {
                model: 'glm-4.6v', 
                messages: messages,
                stream: true
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
            data: { model: 'glm-4.6v', messages: messages, stream: true }
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
                    { role: 'user', content: `Please summarize the following historical execution progress into a concise summary of no more than 200 words. Retain core progress and pending items.\nExisting summary: ${nodeState.summary}\nLatest chat: ${JSON.stringify(recentChat)}` }
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend proxy and compression engine started, listening on port: ${PORT}`));

(function (global) {
    'use strict';

    const SCHEMA_VERSION = 2;
    const PRIORITIES = new Set(['low', 'normal', 'high']);

    function clone(value) {
        if (typeof structuredClone === 'function') return structuredClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    function text(value, fallback = '') {
        if (typeof value !== 'string') return fallback;
        const normalized = value.trim();
        return normalized || fallback;
    }

    function parseGeneratedTree(value) {
        const source = typeof value === 'string'
            ? value.replace(/```json/gi, '').replace(/```/g, '').trim()
            : value;
        if (!source) throw new Error('AI 返回内容为空');
        const parsed = typeof source === 'string' ? JSON.parse(source) : source;
        const nodes = Array.isArray(parsed) ? parsed : parsed?.mainNodes;
        if (!Array.isArray(nodes)) throw new Error('AI 返回的 JSON 缺少 mainNodes 数组');
        return nodes;
    }

    function makeId(prefix = 'node') {
        if (global.crypto && typeof global.crypto.randomUUID === 'function') return `${prefix}-${global.crypto.randomUUID()}`;
        return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

    function safeIdentifier(value, fallback) {
        const normalized = text(String(value ?? '')).replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '');
        return normalized || fallback;
    }

    function normalizeNode(raw, index, usedIds) {
        const source = raw && typeof raw === 'object' ? raw : {};
        let id = safeIdentifier(source.id, makeId('node'));
        while (usedIds.has(id)) id = `${id}-${index + 1}`;
        usedIds.add(id);
        return {
            id,
            parentId: source.parentId === null || source.parentId === undefined || source.parentId === '' ? null : safeIdentifier(source.parentId, null),
            title: text(source.title, `未命名步骤 ${index + 1}`),
            desc: text(source.desc),
            completed: Boolean(source.completed),
            priority: PRIORITIES.has(source.priority) ? source.priority : 'normal'
        };
    }

    function breakCycles(nodes) {
        const byId = new Map(nodes.map(node => [node.id, node]));
        const warnings = [];
        for (const node of nodes) {
            if (node.parentId && !byId.has(node.parentId)) {
                warnings.push(`节点“${node.title}”的父节点不存在，已移到根级`);
                node.parentId = null;
            }
            const visited = new Set([node.id]);
            let cursor = node;
            while (cursor.parentId && byId.has(cursor.parentId)) {
                if (visited.has(cursor.parentId)) {
                    warnings.push(`节点“${node.title}”存在循环引用，已移到根级`);
                    node.parentId = null;
                    break;
                }
                visited.add(cursor.parentId);
                cursor = byId.get(cursor.parentId);
            }
        }
        return warnings;
    }

    function normalizeProgress(raw, ids) {
        const output = {};
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return output;
        Object.entries(raw).forEach(([nodeId, entries]) => {
            if (!ids.has(nodeId) || !Array.isArray(entries)) return;
            output[nodeId] = entries.map(entry => {
                const source = typeof entry === 'string' ? { content: entry } : (entry || {});
                return { content: typeof source.content === 'string' ? source.content : '', createdAt: source.createdAt || null };
            });
        });
        return output;
    }

    function normalizeTree(raw) {
        const source = raw && typeof raw === 'object' ? raw : {};
        const usedIds = new Set();
        const inputNodes = Array.isArray(source.mainNodes) ? source.mainNodes : [];
        const mainNodes = inputNodes.map((node, index) => normalizeNode(node, index, usedIds));
        const warnings = breakCycles(mainNodes);
        return {
            tree: { mainNodes, progressNodes: normalizeProgress(source.progressNodes, usedIds) },
            warnings
        };
    }

    function buildIndex(nodes) {
        const byId = new Map();
        const children = new Map();
        nodes.forEach(node => byId.set(String(node.id), node));
        nodes.forEach(node => {
            const parent = node.parentId == null ? null : String(node.parentId);
            if (!children.has(parent)) children.set(parent, []);
            children.get(parent).push(node);
        });
        return { byId, children };
    }

    function getDepth(node, byId) {
        let depth = 1;
        let cursor = node;
        const visited = new Set([String(node.id)]);
        while (cursor.parentId != null && byId.has(String(cursor.parentId))) {
            const id = String(cursor.parentId);
            if (visited.has(id)) break;
            visited.add(id);
            cursor = byId.get(id);
            depth += 1;
        }
        return depth;
    }

    function analyzeTree(tree) {
        const nodes = Array.isArray(tree?.mainNodes) ? tree.mainNodes : [];
        const progress = tree?.progressNodes || {};
        const { byId, children } = buildIndex(nodes);
        const result = {
            nodes: nodes.length,
            roots: (children.get(null) || []).length,
            leaves: 0,
            maxDepth: 0,
            completed: 0,
            completionRate: 0,
            progressCount: 0,
            priorities: { low: 0, normal: 0, high: 0 }
        };
        nodes.forEach(node => {
            if (!(children.get(String(node.id)) || []).length) result.leaves += 1;
            result.maxDepth = Math.max(result.maxDepth, getDepth(node, byId));
            if (node.completed) result.completed += 1;
            const priority = PRIORITIES.has(node.priority) ? node.priority : 'normal';
            result.priorities[priority] += 1;
            result.progressCount += Array.isArray(progress[node.id]) ? progress[node.id].length : 0;
        });
        result.completionRate = result.nodes ? Math.round((result.completed / result.nodes) * 100) : 0;
        return result;
    }

    function diagnoseTree(tree) {
        const source = tree && typeof tree === 'object' ? tree : {};
        const nodes = Array.isArray(source.mainNodes) ? source.mainNodes : [];
        const progress = source.progressNodes && typeof source.progressNodes === 'object' ? source.progressNodes : {};
        const issues = [];
        const ids = new Map();
        const byId = new Map();

        nodes.forEach((node, index) => {
            const rawId = text(String(node?.id ?? ''));
            if (!rawId) issues.push({ code: 'missing-id', severity: 'error', nodeIndex: index, message: `第 ${index + 1} 个节点缺少 ID` });
            if (rawId && ids.has(rawId)) issues.push({ code: 'duplicate-id', severity: 'error', nodeId: rawId, nodeIndex: index, message: `节点 ID“${rawId}”重复` });
            if (rawId) { ids.set(rawId, (ids.get(rawId) || 0) + 1); if (!byId.has(rawId)) byId.set(rawId, node); }
            if (!text(node?.title)) issues.push({ code: 'missing-title', severity: 'warning', nodeId: rawId, nodeIndex: index, message: `第 ${index + 1} 个节点缺少标题` });
            if (node?.parentId != null && String(node.parentId) === rawId) issues.push({ code: 'self-parent', severity: 'error', nodeId: rawId, nodeIndex: index, message: `节点“${node.title || rawId}”指向自身` });
            if (node?.priority && !PRIORITIES.has(node.priority)) issues.push({ code: 'invalid-priority', severity: 'warning', nodeId: rawId, nodeIndex: index, message: `节点“${node.title || rawId}”的优先级无效` });
        });

        nodes.forEach((node, index) => {
            const nodeId = text(String(node?.id ?? ''));
            const parentId = node?.parentId == null ? null : String(node.parentId);
            if (parentId && !byId.has(parentId)) issues.push({ code: 'orphan', severity: 'error', nodeId, nodeIndex: index, message: `节点“${node.title || nodeId}”引用了不存在的父节点` });
            const visited = new Set(nodeId ? [nodeId] : []);
            let cursor = node;
            while (cursor?.parentId != null && byId.has(String(cursor.parentId))) {
                const nextId = String(cursor.parentId);
                if (visited.has(nextId)) {
                    if (nextId !== nodeId || parentId !== nodeId) issues.push({ code: 'cycle', severity: 'error', nodeId, nodeIndex: index, message: `节点“${node.title || nodeId}”位于循环关系中` });
                    break;
                }
                visited.add(nextId);
                cursor = byId.get(nextId);
            }
        });

        Object.entries(progress).forEach(([nodeId, entries]) => {
            if (!byId.has(nodeId)) issues.push({ code: 'dangling-progress', severity: 'warning', nodeId, message: `节点“${nodeId}”的进度记录没有对应任务` });
            else if (!Array.isArray(entries)) issues.push({ code: 'invalid-progress', severity: 'warning', nodeId, message: `节点“${nodeId}”的进度记录格式无效` });
        });

        const errors = issues.filter(issue => issue.severity === 'error').length;
        const warnings = issues.length - errors;
        return { valid: issues.length === 0, issues, summary: { nodes: nodes.length, errors, warnings, total: issues.length } };
    }

    function repairTree(tree) {
        const source = clone(tree && typeof tree === 'object' ? tree : {});
        const rawNodes = Array.isArray(source.mainNodes) ? source.mainNodes : [];
        const usedIds = new Set();
        const firstIdMapping = new Map();
        const repairs = [];
        const nodes = rawNodes.map((raw, index) => {
            const originalId = text(String(raw?.id ?? ''));
            let id = safeIdentifier(originalId, `node-${index + 1}`);
            const baseId = id;
            let suffix = 2;
            while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
            if (!originalId) repairs.push(`为第 ${index + 1} 个节点生成 ID“${id}”`);
            else if (id !== originalId) repairs.push(`将节点 ID“${originalId}”规范为“${id}”`);
            if (!firstIdMapping.has(originalId)) firstIdMapping.set(originalId, id);
            usedIds.add(id);
            const title = text(raw?.title, `未命名步骤 ${index + 1}`);
            if (!text(raw?.title)) repairs.push(`为节点“${id}”补充默认标题`);
            return {
                id,
                parentId: raw?.parentId == null || raw.parentId === '' ? null : String(raw.parentId),
                title,
                desc: text(raw?.desc),
                completed: Boolean(raw?.completed),
                priority: PRIORITIES.has(raw?.priority) ? raw.priority : 'normal'
            };
        });

        const byId = new Map(nodes.map(node => [node.id, node]));
        nodes.forEach((node, index) => {
            if (node.parentId != null) node.parentId = firstIdMapping.get(String(node.parentId)) || safeIdentifier(node.parentId, null);
            if (node.parentId && !byId.has(node.parentId)) {
                repairs.push(`将孤立节点“${node.title}”移动到根级`);
                node.parentId = null;
            }
            const visited = new Set([node.id]);
            let cursor = node;
            while (cursor.parentId && byId.has(cursor.parentId)) {
                if (visited.has(cursor.parentId)) {
                    repairs.push(`断开节点“${node.title}”的循环父子关系`);
                    node.parentId = null;
                    break;
                }
                visited.add(cursor.parentId);
                cursor = byId.get(cursor.parentId);
            }
            if (!PRIORITIES.has(rawNodes[index]?.priority) && rawNodes[index]?.priority) repairs.push(`重置节点“${node.title}”的无效优先级`);
        });

        const progressNodes = {};
        if (source.progressNodes && typeof source.progressNodes === 'object' && !Array.isArray(source.progressNodes)) {
            Object.entries(source.progressNodes).forEach(([oldId, entries]) => {
                const mappedId = firstIdMapping.get(oldId) || safeIdentifier(oldId, null);
                if (!mappedId || !byId.has(mappedId)) {
                    repairs.push(`移除悬空进度“${oldId}”`);
                    return;
                }
                if (!Array.isArray(entries)) {
                    repairs.push(`重置节点“${mappedId}”的无效进度格式`);
                    progressNodes[mappedId] = [];
                    return;
                }
                progressNodes[mappedId] = entries.map(entry => {
                    const item = typeof entry === 'string' ? { content: entry } : (entry || {});
                    return { content: typeof item.content === 'string' ? item.content : '', createdAt: item.createdAt || null };
                });
            });
        }
        return { tree: { mainNodes: nodes, progressNodes }, repairs, diagnosis: diagnoseTree({ mainNodes: nodes, progressNodes }) };
    }

    function descendantsOf(nodeId, children, output = new Set()) {
        for (const child of children.get(String(nodeId)) || []) {
            if (output.has(String(child.id))) continue;
            output.add(String(child.id));
            descendantsOf(child.id, children, output);
        }
        return output;
    }

    function ancestorsOf(nodeId, byId, output = new Set()) {
        let cursor = byId.get(String(nodeId));
        while (cursor && cursor.parentId != null && byId.has(String(cursor.parentId))) {
            const parentId = String(cursor.parentId);
            if (output.has(parentId)) break;
            output.add(parentId);
            cursor = byId.get(parentId);
        }
        return output;
    }

    function searchTree(tree, query, options = {}) {
        const nodes = Array.isArray(tree?.mainNodes) ? tree.mainNodes : [];
        const normalizedQuery = text(query).toLocaleLowerCase('zh-CN');
        const completed = options.completed || 'all';
        const priority = options.priority || 'all';
        const { byId, children } = buildIndex(nodes);
        const matches = new Set();
        nodes.forEach(node => {
            const haystack = `${node.title || ''}\n${node.desc || ''}`.toLocaleLowerCase('zh-CN');
            const queryMatches = !normalizedQuery || haystack.includes(normalizedQuery);
            const completionMatches = completed === 'all' || (completed === 'done' ? node.completed : !node.completed);
            const priorityMatches = priority === 'all' || node.priority === priority;
            if (queryMatches && completionMatches && priorityMatches) matches.add(String(node.id));
        });
        const visible = new Set(matches);
        matches.forEach(id => ancestorsOf(id, byId, visible));
        return { matches, visible, total: nodes.length };
    }

    function exportTree(tree, metadata = {}) {
        const normalized = normalizeTree(tree).tree;
        return JSON.stringify({
            schema: 'ai-task-tree',
            version: SCHEMA_VERSION,
            exportedAt: new Date().toISOString(),
            metadata: { title: text(metadata.title, 'AI 任务树'), ...metadata },
            tree: normalized
        }, null, 2);
    }

    function importTree(input) {
        let parsed;
        try { parsed = typeof input === 'string' ? JSON.parse(input) : clone(input); }
        catch (error) { throw new Error(`JSON 解析失败：${error.message}`); }
        const candidate = parsed?.schema === 'ai-task-tree' ? parsed.tree : parsed;
        if (!candidate || !Array.isArray(candidate.mainNodes)) throw new Error('文件中未找到有效的 mainNodes 数组');
        const result = normalizeTree(candidate);
        if (!result.tree.mainNodes.length) throw new Error('任务树不包含任何节点');
        return { ...result, metadata: parsed.metadata || {}, version: parsed.version || 1 };
    }

    function toMarkdown(tree, title = 'AI 任务树') {
        const normalized = normalizeTree(tree).tree;
        const { children } = buildIndex(normalized.mainNodes);
        const lines = [`# ${title}`, ''];
        const visit = (node, depth) => {
            const marker = node.completed ? 'x' : ' ';
            const priority = node.priority === 'high' ? ' `高优先级`' : node.priority === 'low' ? ' `低优先级`' : '';
            lines.push(`${'  '.repeat(depth)}- [${marker}] ${node.title}${priority}`);
            if (node.desc) lines.push(`${'  '.repeat(depth + 1)}${node.desc.replace(/\n/g, ' ')}`);
            const progress = normalized.progressNodes[node.id] || [];
            progress.forEach((entry, index) => lines.push(`${'  '.repeat(depth + 1)}- 进度 ${index + 1}：${entry.content.replace(/\n/g, ' ')}`));
            (children.get(String(node.id)) || []).forEach(child => visit(child, depth + 1));
        };
        (children.get(null) || []).forEach(root => visit(root, 0));
        return lines.join('\n');
    }

    function downloadText(filename, content, type = 'application/json;charset=utf-8') {
        const blob = new Blob([content], { type });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function debounce(fn, delay = 300) {
        let timer = null;
        function debounced(...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), delay);
        }
        debounced.cancel = () => { clearTimeout(timer); timer = null; };
        debounced.flush = (...args) => { clearTimeout(timer); timer = null; return fn(...args); };
        return debounced;
    }

    function createSaveQueue(save, options = {}) {
        const delay = options.delay || 800;
        let timer = null;
        let pending = null;
        let running = false;
        let lastError = null;
        const listeners = new Set();

        const notify = status => listeners.forEach(listener => listener(status));
        async function drain() {
            if (running || !pending) return;
            const value = pending;
            pending = null;
            running = true;
            notify({ state: 'saving', error: null });
            try {
                await save(value);
                lastError = null;
                notify({ state: pending ? 'pending' : 'saved', error: null });
            } catch (error) {
                lastError = error;
                notify({ state: 'error', error });
            } finally {
                running = false;
                if (pending) drain();
            }
        }
        return {
            enqueue(value) {
                pending = clone(value);
                clearTimeout(timer);
                timer = setTimeout(drain, delay);
                notify({ state: 'pending', error: null });
            },
            async flush() { clearTimeout(timer); timer = null; await drain(); },
            cancel() { clearTimeout(timer); timer = null; pending = null; notify({ state: 'idle', error: null }); },
            subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
            getStatus() { return { pending: Boolean(pending), running, error: lastError }; }
        };
    }

    function createSSEParser(onMessage) {
        let buffer = '';
        let done = false;
        function consumeBlock(block) {
            const dataLines = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart());
            if (!dataLines.length) return;
            const data = dataLines.join('\n');
            if (data === '[DONE]') { done = true; return; }
            try { onMessage(JSON.parse(data)); } catch { onMessage({ data, parseError: true }); }
        }
        return {
            push(chunk) {
                buffer += chunk;
                const blocks = buffer.split(/\r?\n\r?\n/);
                buffer = blocks.pop() || '';
                blocks.forEach(consumeBlock);
                return done;
            },
            finish() { if (buffer.trim()) consumeBlock(buffer); buffer = ''; return done; }
        };
    }

    function normalizeApiProfile(profile = {}) {
        return {
            apiKey: typeof profile.apiKey === 'string' ? profile.apiKey.trim() : '',
            baseUrl: typeof profile.baseUrl === 'string' ? profile.baseUrl.trim() : '',
            model: typeof profile.model === 'string' ? profile.model.trim() : '',
            customBody: typeof profile.customBody === 'string' ? profile.customBody.trim() : ''
        };
    }

    function normalizeDeveloperSettings(raw = {}) {
        const legacyPrimary = {
            apiKey: raw.apiKey,
            baseUrl: raw.baseUrl,
            model: raw.model,
            customBody: raw.customBody
        };
        return {
            enabled: Boolean(raw.enabled),
            primary: normalizeApiProfile(raw.primary || legacyPrimary),
            panorama: {
                enabled: typeof raw.panorama?.enabled === 'boolean' ? raw.panorama.enabled : Boolean(raw.enabled),
                sameAsPrimary: raw.panorama?.sameAsPrimary !== false,
                ...normalizeApiProfile(raw.panorama || {})
            }
        };
    }

    function buildDeveloperHeaders(rawSettings, scope = 'primary') {
        const settings = normalizeDeveloperSettings(rawSettings);
        if (scope === 'panorama' && !settings.panorama.enabled) return {};
        if (scope !== 'panorama' && !settings.enabled) return {};
        const profile = scope === 'panorama' && !settings.panorama.sameAsPrimary ? settings.panorama : settings.primary;
        if (!profile.apiKey) return {};
        const headers = { 'X-Dev-Key': profile.apiKey };
        if (profile.baseUrl) headers['X-Dev-Base'] = profile.baseUrl;
        if (profile.model) headers['X-Dev-Model'] = profile.model;
        if (profile.customBody) headers['X-Dev-Body'] = profile.customBody;
        return headers;
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
    }

    global.TaskTreeCore = Object.freeze({
        SCHEMA_VERSION, clone, makeId, parseGeneratedTree, normalizeTree, analyzeTree, diagnoseTree, repairTree, buildIndex,
        descendantsOf, ancestorsOf, searchTree, exportTree, importTree,
        toMarkdown, downloadText, debounce, createSaveQueue, createSSEParser,
        normalizeApiProfile, normalizeDeveloperSettings, buildDeveloperHeaders, escapeHtml
    });
})(typeof window !== 'undefined' ? window : globalThis);

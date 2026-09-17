'use strict';

const LIMITS = Object.freeze({
    username: 64,
    password: 128,
    email: 254,
    title: 160,
    description: 8000,
    question: 12000,
    nodeId: 128,
    nodes: 500,
    progressItemsPerNode: 100,
    progressContent: 50000,
    treeBytes: 5 * 1024 * 1024,
    images: 8,
    imageBytes: 8 * 1024 * 1024
});

class ValidationError extends Error {
    constructor(message, details = []) {
        super(message);
        this.name = 'ValidationError';
        this.statusCode = 400;
        this.details = details;
    }
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function cleanText(value, options = {}) {
    const { field = '文本', max = 1000, required = false, trim = true } = options;
    if (value === undefined || value === null) {
        if (required) throw new ValidationError(`${field}不能为空`);
        return '';
    }
    if (typeof value !== 'string') throw new ValidationError(`${field}必须是字符串`);
    const cleaned = trim ? value.trim() : value;
    if (required && !cleaned) throw new ValidationError(`${field}不能为空`);
    if (cleaned.length > max) throw new ValidationError(`${field}不能超过 ${max} 个字符`);
    return cleaned;
}

function cleanId(value, field = 'ID', allowNull = false) {
    if ((value === null || value === undefined || value === '') && allowNull) return null;
    const id = cleanText(String(value ?? ''), { field, max: LIMITS.nodeId, required: true });
    if (!/^[\w.:-]+$/u.test(id)) throw new ValidationError(`${field}包含不支持的字符`);
    return id;
}

function validateEmail(value) {
    const email = cleanText(value, { field: '邮箱', max: LIMITS.email, required: true }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError('邮箱格式不正确');
    return email;
}

function validateCredentials(body) {
    if (!isPlainObject(body)) throw new ValidationError('请求体格式不正确');
    return {
        username: cleanText(body.username, { field: '用户名', max: LIMITS.username, required: true }),
        password: cleanText(body.password, { field: '密码', max: LIMITS.password, required: true, trim: false })
    };
}

function validateImages(images) {
    if (images === undefined) return [];
    if (!Array.isArray(images)) throw new ValidationError('图片列表格式不正确');
    if (images.length > LIMITS.images) throw new ValidationError(`最多上传 ${LIMITS.images} 张图片`);
    return images.map((image, index) => {
        if (typeof image !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/i.test(image)) {
            throw new ValidationError(`第 ${index + 1} 张图片格式不受支持`);
        }
        const approximateBytes = Math.ceil(image.length * 0.75);
        if (approximateBytes > LIMITS.imageBytes) throw new ValidationError(`第 ${index + 1} 张图片超过大小限制`);
        return image;
    });
}

function normalizeNode(raw, index) {
    if (!isPlainObject(raw)) throw new ValidationError(`第 ${index + 1} 个节点格式不正确`);
    return {
        id: cleanId(raw.id, `第 ${index + 1} 个节点 ID`),
        parentId: cleanId(raw.parentId, `第 ${index + 1} 个节点 parentId`, true),
        title: cleanText(raw.title, { field: `第 ${index + 1} 个节点标题`, max: LIMITS.title, required: true }),
        desc: cleanText(raw.desc, { field: `第 ${index + 1} 个节点描述`, max: LIMITS.description }),
        completed: Boolean(raw.completed),
        priority: ['low', 'normal', 'high'].includes(raw.priority) ? raw.priority : 'normal'
    };
}

function validateNodeGraph(nodes) {
    const ids = new Set(nodes.map(node => node.id));
    if (ids.size !== nodes.length) throw new ValidationError('任务树包含重复节点 ID');
    for (const node of nodes) {
        if (node.parentId && !ids.has(node.parentId)) throw new ValidationError(`节点 ${node.id} 引用了不存在的父节点`);
        if (node.parentId === node.id) throw new ValidationError(`节点 ${node.id} 不能指向自身`);
        const seen = new Set([node.id]);
        let current = node;
        while (current.parentId) {
            if (seen.has(current.parentId)) throw new ValidationError(`节点 ${node.id} 所在关系存在循环`);
            seen.add(current.parentId);
            current = nodes.find(candidate => candidate.id === current.parentId);
            if (!current) break;
        }
    }
}

function normalizeProgress(progressNodes, nodeIds) {
    if (progressNodes === undefined || progressNodes === null) return {};
    if (!isPlainObject(progressNodes)) throw new ValidationError('进度数据格式不正确');
    const normalized = {};
    for (const [nodeId, items] of Object.entries(progressNodes)) {
        if (!nodeIds.has(nodeId)) continue;
        if (!Array.isArray(items)) throw new ValidationError(`节点 ${nodeId} 的进度格式不正确`);
        if (items.length > LIMITS.progressItemsPerNode) throw new ValidationError(`节点 ${nodeId} 的进度记录过多`);
        normalized[nodeId] = items.map((item, index) => {
            const source = typeof item === 'string' ? { content: item } : item;
            if (!isPlainObject(source)) throw new ValidationError(`节点 ${nodeId} 的第 ${index + 1} 条进度格式不正确`);
            return {
                content: cleanText(source.content, { field: '进度内容', max: LIMITS.progressContent, trim: false }),
                createdAt: typeof source.createdAt === 'string' ? source.createdAt.slice(0, 40) : null
            };
        });
    }
    return normalized;
}

function normalizeTreeData(treeData) {
    if (!isPlainObject(treeData)) throw new ValidationError('任务树格式不正确');
    if (!Array.isArray(treeData.mainNodes)) throw new ValidationError('任务树缺少 mainNodes 数组');
    if (treeData.mainNodes.length > LIMITS.nodes) throw new ValidationError(`任务树最多包含 ${LIMITS.nodes} 个节点`);
    const mainNodes = treeData.mainNodes.map(normalizeNode);
    validateNodeGraph(mainNodes);
    const nodeIds = new Set(mainNodes.map(node => node.id));
    const progressNodes = normalizeProgress(treeData.progressNodes, nodeIds);
    const normalized = { mainNodes, progressNodes };
    if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > LIMITS.treeBytes) {
        throw new ValidationError('任务树数据超过大小限制');
    }
    return normalized;
}

function validateDecomposeBody(body) {
    if (!isPlainObject(body)) throw new ValidationError('请求体格式不正确');
    return {
        taskText: cleanText(body.taskText, { field: '任务描述', max: LIMITS.description, required: true }),
        images: validateImages(body.images)
    };
}

function validateAskBody(body) {
    if (!isPlainObject(body)) throw new ValidationError('请求体格式不正确');
    return {
        nodeId: cleanId(body.nodeId, '节点 ID'),
        title: cleanText(body.title, { field: '节点标题', max: LIMITS.title, required: true }),
        desc: cleanText(body.desc, { field: '节点描述', max: LIMITS.description }),
        userQuestion: cleanText(body.userQuestion, { field: '问题', max: LIMITS.question })
    };
}

function safeJsonParse(value, fallback = null) {
    try { return JSON.parse(value); } catch { return fallback; }
}

module.exports = {
    LIMITS,
    ValidationError,
    cleanText,
    cleanId,
    validateEmail,
    validateCredentials,
    validateImages,
    normalizeTreeData,
    validateDecomposeBody,
    validateAskBody,
    safeJsonParse,
    isPlainObject
};

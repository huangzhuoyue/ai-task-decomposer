'use strict';

function analyzeTree(treeData) {
    const nodes = Array.isArray(treeData?.mainNodes) ? treeData.mainNodes : [];
    const progress = treeData?.progressNodes && typeof treeData.progressNodes === 'object' ? treeData.progressNodes : {};
    const byParent = new Map();
    const byId = new Map(nodes.map(node => [String(node.id), node]));
    for (const node of nodes) {
        const parent = node.parentId == null ? null : String(node.parentId);
        if (!byParent.has(parent)) byParent.set(parent, []);
        byParent.get(parent).push(node);
    }
    let maxDepth = 0;
    let leaves = 0;
    let completed = 0;
    let progressCount = 0;
    let orphanCount = 0;
    const priorities = { low: 0, normal: 0, high: 0 };
    for (const node of nodes) {
        if (node.completed) completed += 1;
        priorities[node.priority] = (priorities[node.priority] || 0) + 1;
        progressCount += Array.isArray(progress[node.id]) ? progress[node.id].length : 0;
        if (node.parentId != null && !byId.has(String(node.parentId))) orphanCount += 1;
        if (!(byParent.get(String(node.id)) || []).length) leaves += 1;
        let depth = 1;
        let cursor = node;
        const visited = new Set([String(node.id)]);
        while (cursor.parentId != null && byId.has(String(cursor.parentId))) {
            const parentId = String(cursor.parentId);
            if (visited.has(parentId)) break;
            visited.add(parentId);
            cursor = byId.get(parentId);
            depth += 1;
        }
        maxDepth = Math.max(maxDepth, depth);
    }
    return {
        nodes: nodes.length,
        roots: (byParent.get(null) || []).length,
        leaves,
        maxDepth,
        completed,
        completionRate: nodes.length ? Math.round((completed / nodes.length) * 100) : 0,
        progressCount,
        orphanCount,
        priorities
    };
}

function flattenTree(treeData) {
    const nodes = Array.isArray(treeData?.mainNodes) ? treeData.mainNodes : [];
    const children = new Map();
    for (const node of nodes) {
        const parent = node.parentId == null ? null : String(node.parentId);
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(node);
    }
    const result = [];
    const visit = (node, depth, path) => {
        const currentPath = [...path, node.title];
        result.push({ ...node, depth, path: currentPath.join(' / ') });
        for (const child of children.get(String(node.id)) || []) visit(child, depth + 1, currentPath);
    };
    for (const root of children.get(null) || []) visit(root, 0, []);
    return result;
}

module.exports = { analyzeTree, flattenTree };

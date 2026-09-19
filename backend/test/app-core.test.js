'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
require('../../front/app-core.js');
const Core = globalThis.TaskTreeCore;

function sampleTree() {
    return {
        mainNodes: [
            { id: 'root', parentId: null, title: '产品发布', desc: '发布新产品', completed: false, priority: 'high' },
            { id: 'design', parentId: 'root', title: '设计', desc: '完成界面设计', completed: true, priority: 'normal' },
            { id: 'develop', parentId: 'root', title: '开发', desc: '实现核心功能', completed: false, priority: 'normal' },
            { id: 'test', parentId: 'develop', title: '测试', desc: '执行自动化测试', completed: false, priority: 'low' }
        ],
        progressNodes: { develop: [{ content: '接口完成' }] }
    };
}

test('browser core is exposed with a schema version', () => {
    assert.ok(Core);
    assert.equal(Core.SCHEMA_VERSION, 2);
});

test('normalizeTree supplies defaults without mutating input', () => {
    const input = { mainNodes: [{ id: 'a', title: ' A ' }] };
    const result = Core.normalizeTree(input);
    assert.equal(result.tree.mainNodes[0].title, 'A');
    assert.equal(result.tree.mainNodes[0].completed, false);
    assert.equal(result.tree.mainNodes[0].priority, 'normal');
    assert.equal(input.mainNodes[0].priority, undefined);
});

test('normalizeTree repairs missing parents', () => {
    const result = Core.normalizeTree({ mainNodes: [{ id: 'a', parentId: 'missing', title: 'A' }] });
    assert.equal(result.tree.mainNodes[0].parentId, null);
    assert.equal(result.warnings.length, 1);
});

test('normalizeTree repairs cyclic graphs', () => {
    const result = Core.normalizeTree({ mainNodes: [
        { id: 'a', parentId: 'b', title: 'A' },
        { id: 'b', parentId: 'a', title: 'B' }
    ] });
    assert.ok(result.tree.mainNodes.some(node => node.parentId === null));
    assert.ok(result.warnings.some(item => item.includes('循环')));
});

test('normalizeTree replaces duplicate IDs', () => {
    const result = Core.normalizeTree({ mainNodes: [
        { id: 'same', title: 'A' }, { id: 'same', title: 'B' }
    ] });
    assert.equal(new Set(result.tree.mainNodes.map(node => node.id)).size, 2);
});

test('analyzeTree computes client-side overview', () => {
    const stats = Core.analyzeTree(sampleTree());
    assert.equal(stats.nodes, 4);
    assert.equal(stats.roots, 1);
    assert.equal(stats.leaves, 2);
    assert.equal(stats.maxDepth, 3);
    assert.equal(stats.completed, 1);
    assert.equal(stats.completionRate, 25);
    assert.equal(stats.progressCount, 1);
    assert.equal(stats.priorities.high, 1);
});

test('diagnoseTree reports common structural problems', () => {
    const diagnosis = Core.diagnoseTree({
        mainNodes: [
            { id: 'same', parentId: 'missing', title: '', priority: 'urgent' },
            { id: 'same', parentId: null, title: 'Duplicate' },
            { id: 'self', parentId: 'self', title: 'Self' }
        ],
        progressNodes: { ghost: [{ content: 'orphan progress' }], self: 'wrong' }
    });
    const codes = new Set(diagnosis.issues.map(issue => issue.code));
    assert.equal(diagnosis.valid, false);
    assert.ok(codes.has('duplicate-id'));
    assert.ok(codes.has('missing-title'));
    assert.ok(codes.has('invalid-priority'));
    assert.ok(codes.has('orphan'));
    assert.ok(codes.has('self-parent'));
    assert.ok(codes.has('dangling-progress'));
    assert.ok(codes.has('invalid-progress'));
});

test('diagnoseTree accepts a valid task tree', () => {
    const diagnosis = Core.diagnoseTree(sampleTree());
    assert.equal(diagnosis.valid, true);
    assert.deepEqual(diagnosis.summary, { nodes: 4, errors: 0, warnings: 0, total: 0 });
});

test('repairTree makes invalid trees usable', () => {
    const repaired = Core.repairTree({
        mainNodes: [
            { id: 'bad id', parentId: null, title: '', priority: 'urgent' },
            { id: 'bad id', parentId: 'missing', title: 'Duplicate' },
            { id: 'loop-a', parentId: 'loop-b', title: 'A' },
            { id: 'loop-b', parentId: 'loop-a', title: 'B' }
        ],
        progressNodes: { ghost: ['unused'], 'bad id': ['kept'] }
    });
    assert.equal(repaired.diagnosis.valid, true);
    assert.equal(new Set(repaired.tree.mainNodes.map(node => node.id)).size, 4);
    assert.ok(repaired.tree.mainNodes.every(node => node.title));
    assert.ok(repaired.tree.mainNodes.every(node => ['low', 'normal', 'high'].includes(node.priority)));
    assert.equal(repaired.tree.progressNodes.ghost, undefined);
    assert.ok(repaired.repairs.length >= 5);
});

test('buildIndex groups roots and children', () => {
    const index = Core.buildIndex(sampleTree().mainNodes);
    assert.equal(index.byId.get('design').title, '设计');
    assert.equal(index.children.get(null).length, 1);
    assert.equal(index.children.get('root').length, 2);
});

test('ancestor and descendant helpers navigate a tree', () => {
    const index = Core.buildIndex(sampleTree().mainNodes);
    assert.deepEqual([...Core.ancestorsOf('test', index.byId)], ['develop', 'root']);
    assert.deepEqual([...Core.descendantsOf('root', index.children)], ['design', 'develop', 'test']);
});

test('searchTree matches title and keeps ancestors visible', () => {
    const result = Core.searchTree(sampleTree(), '自动化');
    assert.deepEqual([...result.matches], ['test']);
    assert.equal(result.visible.has('develop'), true);
    assert.equal(result.visible.has('root'), true);
    assert.equal(result.visible.has('design'), false);
});

test('searchTree applies completion and priority filters', () => {
    assert.deepEqual([...Core.searchTree(sampleTree(), '', { completed: 'done' }).matches], ['design']);
    assert.deepEqual([...Core.searchTree(sampleTree(), '', { priority: 'high' }).matches], ['root']);
});

test('exportTree and importTree round trip current schema', () => {
    const json = Core.exportTree(sampleTree(), { title: '项目计划' });
    const parsed = JSON.parse(json);
    assert.equal(parsed.schema, 'ai-task-tree');
    assert.equal(parsed.version, 2);
    assert.equal(parsed.metadata.title, '项目计划');
    const imported = Core.importTree(json);
    assert.equal(imported.tree.mainNodes.length, 4);
    assert.equal(imported.metadata.title, '项目计划');
});

test('importTree supports legacy raw trees', () => {
    const imported = Core.importTree(JSON.stringify(sampleTree()));
    assert.equal(imported.version, 1);
    assert.equal(imported.tree.mainNodes[0].title, '产品发布');
});

test('importTree reports invalid files', () => {
    assert.throws(() => Core.importTree('not-json'), /JSON 解析失败/);
    assert.throws(() => Core.importTree('{"hello":"world"}'), /mainNodes/);
    assert.throws(() => Core.importTree('{"mainNodes":[]}'), /不包含任何节点/);
});

test('toMarkdown includes hierarchy, status and progress', () => {
    const markdown = Core.toMarkdown(sampleTree(), '发布计划');
    assert.match(markdown, /^# 发布计划/);
    assert.match(markdown, /- \[x\] 设计/);
    assert.match(markdown, /  - \[ \] 开发/);
    assert.match(markdown, /进度 1：接口完成/);
    assert.match(markdown, /`高优先级`/);
});

test('SSE parser handles split chunks and done signal', () => {
    const messages = [];
    const parser = Core.createSSEParser(message => messages.push(message));
    parser.push('data: {"choices":[{"delta":{"content":"你');
    parser.push('好"}}]}\n\n');
    const done = parser.push('data: [DONE]\n\n');
    assert.equal(done, true);
    assert.equal(messages[0].choices[0].delta.content, '你好');
});

test('SSE parser emits raw malformed payload information', () => {
    const messages = [];
    const parser = Core.createSSEParser(message => messages.push(message));
    parser.push('data: invalid-json\n\n');
    assert.equal(messages[0].parseError, true);
    assert.equal(messages[0].data, 'invalid-json');
});

test('developer settings migrate the legacy primary API shape', () => {
    const settings = Core.normalizeDeveloperSettings({
        enabled: true, apiKey: ' primary-key ', baseUrl: ' https://primary.example/v1 ', model: 'model-a'
    });
    assert.equal(settings.enabled, true);
    assert.equal(settings.primary.apiKey, 'primary-key');
    assert.equal(settings.primary.baseUrl, 'https://primary.example/v1');
    assert.equal(settings.panorama.enabled, true);
    assert.equal(settings.panorama.sameAsPrimary, true);
});

test('panorama assistant uses the primary profile by default', () => {
    const settings = {
        enabled: true,
        primary: { apiKey: 'main-key', baseUrl: 'https://main.example/v1', model: 'main-model' },
        panorama: { sameAsPrimary: true, apiKey: 'unused-key', model: 'unused-model' }
    };
    assert.deepEqual(Core.buildDeveloperHeaders(settings, 'panorama'), {
        'X-Dev-Key': 'main-key', 'X-Dev-Base': 'https://main.example/v1', 'X-Dev-Model': 'main-model'
    });
});

test('panorama assistant can use an independent API profile', () => {
    const settings = {
        enabled: true,
        primary: { apiKey: 'main-key', model: 'main-model' },
        panorama: {
            sameAsPrimary: false,
            apiKey: 'panorama-key', baseUrl: 'https://panorama.example/chat',
            model: 'panorama-model', customBody: '{"temperature":0.2}'
        }
    };
    assert.deepEqual(Core.buildDeveloperHeaders(settings, 'panorama'), {
        'X-Dev-Key': 'panorama-key',
        'X-Dev-Base': 'https://panorama.example/chat',
        'X-Dev-Model': 'panorama-model',
        'X-Dev-Body': '{"temperature":0.2}'
    });
    assert.equal(Core.buildDeveloperHeaders(settings, 'primary')['X-Dev-Key'], 'main-key');
});

test('developer API headers remain empty when disabled or missing a key', () => {
    assert.deepEqual(Core.buildDeveloperHeaders({ enabled: false, primary: { apiKey: 'key' } }), {});
    assert.deepEqual(Core.buildDeveloperHeaders({ enabled: true, primary: { apiKey: '' } }), {});
});

test('panorama custom API can be enabled while the primary custom API is disabled', () => {
    const settings = {
        enabled: false,
        primary: { apiKey: 'unused-main-key', model: 'unused-main-model' },
        panorama: { enabled: true, sameAsPrimary: false, apiKey: 'panorama-only-key', model: 'panorama-only-model' }
    };
    assert.deepEqual(Core.buildDeveloperHeaders(settings, 'primary'), {});
    assert.deepEqual(Core.buildDeveloperHeaders(settings, 'panorama'), {
        'X-Dev-Key': 'panorama-only-key', 'X-Dev-Model': 'panorama-only-model'
    });
});

test('disabled panorama custom API falls back to the system model', () => {
    const settings = {
        enabled: true,
        primary: { apiKey: 'main-key' },
        panorama: { enabled: false, sameAsPrimary: true }
    };
    assert.deepEqual(Core.buildDeveloperHeaders(settings, 'panorama'), {});
});

test('escapeHtml protects HTML interpolation points', () => {
    assert.equal(Core.escapeHtml('<img src="x">'), '&lt;img src=&quot;x&quot;&gt;');
    assert.equal(Core.escapeHtml("Tom & Jerry's"), 'Tom &amp; Jerry&#39;s');
});

test('debounce invokes the final call only', async () => {
    const values = [];
    const fn = Core.debounce(value => values.push(value), 10);
    fn(1); fn(2); fn(3);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.deepEqual(values, [3]);
});

test('save queue coalesces pending snapshots', async () => {
    const saved = [];
    const statuses = [];
    const queue = Core.createSaveQueue(async value => saved.push(value), { delay: 5 });
    queue.subscribe(status => statuses.push(status.state));
    queue.enqueue({ value: 1 });
    queue.enqueue({ value: 2 });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(saved, [{ value: 2 }]);
    assert.ok(statuses.includes('pending'));
    assert.ok(statuses.includes('saved'));
});

test('save queue exposes failures without throwing from timer', async () => {
    const statuses = [];
    const queue = Core.createSaveQueue(async () => { throw new Error('offline'); }, { delay: 5 });
    queue.subscribe(status => statuses.push(status));
    queue.enqueue({ value: 1 });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(statuses.at(-1).state, 'error');
    assert.equal(statuses.at(-1).error.message, 'offline');
    assert.equal(queue.getStatus().error.message, 'offline');
});

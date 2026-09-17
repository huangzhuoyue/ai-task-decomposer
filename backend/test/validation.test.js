'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
} = require('../lib/validation');

test('cleanText trims values and enforces required fields', () => {
    assert.equal(cleanText('  hello  ', { required: true }), 'hello');
    assert.equal(cleanText(undefined), '');
    assert.throws(() => cleanText('   ', { field: '名称', required: true }), /名称不能为空/);
    assert.throws(() => cleanText('abcd', { field: '名称', max: 3 }), /不能超过 3/);
    assert.throws(() => cleanText(42), ValidationError);
});

test('cleanId accepts stable identifiers and rejects unsafe characters', () => {
    assert.equal(cleanId('node-1:a.b'), 'node-1:a.b');
    assert.equal(cleanId(null, '父节点', true), null);
    assert.throws(() => cleanId('<script>'), /不支持的字符/);
});

test('email validation normalizes case', () => {
    assert.equal(validateEmail(' USER@Example.COM '), 'user@example.com');
    assert.throws(() => validateEmail('invalid'), /邮箱格式不正确/);
});

test('credential validation preserves password whitespace', () => {
    assert.deepEqual(validateCredentials({ username: ' alice ', password: ' a secret ' }), {
        username: 'alice', password: ' a secret '
    });
    assert.throws(() => validateCredentials(null), /请求体格式/);
    assert.throws(() => validateCredentials({ username: '', password: 'x' }), /用户名不能为空/);
});

test('image validation accepts supported data URLs', () => {
    const image = 'data:image/png;base64,aGVsbG8=';
    assert.deepEqual(validateImages([image]), [image]);
    assert.throws(() => validateImages(['https://example.com/a.png']), /格式不受支持/);
    assert.throws(() => validateImages('not-array'), /图片列表格式/);
});

test('normalizeTreeData adds optional task metadata defaults', () => {
    const result = normalizeTreeData({
        mainNodes: [
            { id: 'root', parentId: null, title: ' 根 ', desc: '说明' },
            { id: 'child', parentId: 'root', title: '子任务', completed: 1, priority: 'high' }
        ],
        progressNodes: { child: [{ content: 'done' }], missing: [{ content: 'ignored' }] }
    });
    assert.deepEqual(result.mainNodes[0], {
        id: 'root', parentId: null, title: '根', desc: '说明', completed: false, priority: 'normal'
    });
    assert.equal(result.mainNodes[1].completed, true);
    assert.equal(result.mainNodes[1].priority, 'high');
    assert.equal(result.progressNodes.child[0].content, 'done');
    assert.equal(result.progressNodes.missing, undefined);
});

test('normalizeTreeData rejects duplicate IDs', () => {
    assert.throws(() => normalizeTreeData({
        mainNodes: [
            { id: 'same', title: 'A' },
            { id: 'same', title: 'B' }
        ]
    }), /重复节点 ID/);
});

test('normalizeTreeData rejects missing parents', () => {
    assert.throws(() => normalizeTreeData({
        mainNodes: [{ id: 'child', parentId: 'missing', title: 'Child' }]
    }), /不存在的父节点/);
});

test('normalizeTreeData rejects direct and indirect cycles', () => {
    assert.throws(() => normalizeTreeData({ mainNodes: [{ id: 'a', parentId: 'a', title: 'A' }] }), /不能指向自身/);
    assert.throws(() => normalizeTreeData({ mainNodes: [
        { id: 'a', parentId: 'c', title: 'A' },
        { id: 'b', parentId: 'a', title: 'B' },
        { id: 'c', parentId: 'b', title: 'C' }
    ] }), /存在循环/);
});

test('normalizeTreeData validates progress entries', () => {
    assert.throws(() => normalizeTreeData({
        mainNodes: [{ id: 'a', title: 'A' }],
        progressNodes: { a: 'wrong' }
    }), /进度格式不正确/);
    const result = normalizeTreeData({
        mainNodes: [{ id: 'a', title: 'A' }],
        progressNodes: { a: ['text progress'] }
    });
    assert.equal(result.progressNodes.a[0].content, 'text progress');
});

test('decompose and ask payload validation returns canonical objects', () => {
    assert.deepEqual(validateDecomposeBody({ taskText: ' do it ', images: [] }), { taskText: 'do it', images: [] });
    assert.deepEqual(validateAskBody({ nodeId: 'n1', title: ' T ', desc: ' D ', userQuestion: ' Q ' }), {
        nodeId: 'n1', title: 'T', desc: 'D', userQuestion: 'Q'
    });
    assert.throws(() => validateDecomposeBody({ taskText: '' }), /任务描述不能为空/);
    assert.throws(() => validateAskBody({ nodeId: '', title: 'T' }), /节点 ID不能为空/);
});

test('safeJsonParse and isPlainObject handle malformed data', () => {
    assert.deepEqual(safeJsonParse('{"ok":true}'), { ok: true });
    assert.equal(safeJsonParse('bad', 'fallback'), 'fallback');
    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject([]), false);
    assert.equal(isPlainObject(null), false);
});

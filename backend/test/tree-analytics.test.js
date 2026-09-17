'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeTree, flattenTree } = require('../lib/tree-analytics');

const tree = {
    mainNodes: [
        { id: 'root', parentId: null, title: 'Root', completed: true, priority: 'high' },
        { id: 'a', parentId: 'root', title: 'A', completed: false, priority: 'normal' },
        { id: 'b', parentId: 'root', title: 'B', completed: true, priority: 'low' },
        { id: 'deep', parentId: 'a', title: 'Deep', completed: false, priority: 'normal' }
    ],
    progressNodes: { root: [{ content: 'one' }], a: [{ content: 'two' }, { content: 'three' }] }
};

test('analyzeTree calculates structural and progress metrics', () => {
    assert.deepEqual(analyzeTree(tree), {
        nodes: 4,
        roots: 1,
        leaves: 2,
        maxDepth: 3,
        completed: 2,
        completionRate: 50,
        progressCount: 3,
        orphanCount: 0,
        priorities: { low: 1, normal: 2, high: 1 }
    });
});

test('analyzeTree handles empty and partial input', () => {
    assert.equal(analyzeTree(null).nodes, 0);
    assert.equal(analyzeTree({ mainNodes: [] }).completionRate, 0);
    assert.equal(analyzeTree({ mainNodes: [{ id: 'x', parentId: 'missing' }] }).orphanCount, 1);
});

test('flattenTree returns depth and readable paths', () => {
    const flat = flattenTree(tree);
    assert.equal(flat.length, 4);
    assert.equal(flat[0].path, 'Root');
    assert.equal(flat.find(node => node.id === 'deep').path, 'Root / A / Deep');
    assert.equal(flat.find(node => node.id === 'deep').depth, 2);
});

test('flattenTree does not emit disconnected orphans', () => {
    const flat = flattenTree({ mainNodes: [{ id: 'x', parentId: 'missing', title: 'X' }] });
    assert.deepEqual(flat, []);
});

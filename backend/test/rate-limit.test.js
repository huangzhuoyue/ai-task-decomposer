'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter } = require('../lib/rate-limit');

function createResponse() {
    return {
        headers: {}, statusCode: 200, body: null,
        setHeader(name, value) { this.headers[name] = value; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

test('rate limiter allows requests under the limit', () => {
    let current = 1000;
    const limiter = createRateLimiter({ max: 2, windowMs: 1000, now: () => current });
    const request = { ip: '127.0.0.1' };
    let calls = 0;
    const first = createResponse();
    limiter(request, first, () => calls++);
    const second = createResponse();
    limiter(request, second, () => calls++);
    assert.equal(calls, 2);
    assert.equal(first.headers['RateLimit-Remaining'], '1');
    assert.equal(second.headers['RateLimit-Remaining'], '0');
});

test('rate limiter blocks excess requests and provides retry metadata', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 1000, now: () => 1000 });
    const request = { ip: '127.0.0.1' };
    limiter(request, createResponse(), () => {});
    const blocked = createResponse();
    limiter(request, blocked, () => assert.fail('blocked request called next'));
    assert.equal(blocked.statusCode, 429);
    assert.match(blocked.body.error, /频繁/);
    assert.equal(blocked.headers['Retry-After'], '1');
});

test('rate limiter resets after its window', () => {
    let current = 1000;
    const limiter = createRateLimiter({ max: 1, windowMs: 1000, now: () => current });
    const request = { ip: '127.0.0.1' };
    limiter(request, createResponse(), () => {});
    current = 2001;
    let allowed = false;
    limiter(request, createResponse(), () => { allowed = true; });
    assert.equal(allowed, true);
});

test('rate limiter separates authenticated users', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 1000, now: () => 1000 });
    let calls = 0;
    limiter({ userId: 1, ip: 'same' }, createResponse(), () => calls++);
    limiter({ userId: 2, ip: 'same' }, createResponse(), () => calls++);
    assert.equal(calls, 2);
    assert.equal(limiter.size(), 2);
    limiter.reset();
    assert.equal(limiter.size(), 0);
});

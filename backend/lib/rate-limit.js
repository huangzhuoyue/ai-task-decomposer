'use strict';

function createRateLimiter(options = {}) {
    const windowMs = options.windowMs || 60_000;
    const max = options.max || 60;
    const keyGenerator = options.keyGenerator || (req => req.userId ? `user:${req.userId}` : `ip:${req.ip}`);
    const message = options.message || '请求过于频繁，请稍后再试';
    const now = options.now || Date.now;
    const buckets = new Map();

    function cleanup(timestamp) {
        if (buckets.size < 1000) return;
        for (const [key, bucket] of buckets) {
            if (bucket.resetAt <= timestamp) buckets.delete(key);
        }
    }

    const middleware = (req, res, next) => {
        const timestamp = now();
        cleanup(timestamp);
        const key = keyGenerator(req);
        let bucket = buckets.get(key);
        if (!bucket || bucket.resetAt <= timestamp) {
            bucket = { count: 0, resetAt: timestamp + windowMs };
            buckets.set(key, bucket);
        }
        bucket.count += 1;
        const remaining = Math.max(0, max - bucket.count);
        res.setHeader('RateLimit-Limit', String(max));
        res.setHeader('RateLimit-Remaining', String(remaining));
        res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
        if (bucket.count > max) {
            res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - timestamp) / 1000))));
            return res.status(429).json({ error: message });
        }
        next();
    };

    middleware.reset = () => buckets.clear();
    middleware.size = () => buckets.size;
    return middleware;
}

module.exports = { createRateLimiter };

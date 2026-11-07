/**
 * Fixed-window rate limiter keyed by client IP (req.ip).
 * Behind a reverse proxy, set TRUST_PROXY so Express derives req.ip from X-Forwarded-For.
 * In-memory: per process only (use Redis or similar when running several instances).
 */
export function createIpRateLimiter({ windowMs = 60_000, max, name = 'api', message } = {}) {
  const hits = new Map(); // ip -> { count, windowStart }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) {
      if (now - entry.windowStart > windowMs) hits.delete(ip);
    }
  }, windowMs);
  sweep.unref();

  function middleware(req, res, next) {
    const limit = typeof max === 'function' ? max() : max;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();

    let entry = hits.get(ip);
    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { count: 0, windowStart: now };
      hits.set(ip, entry);
    }
    entry.count++;

    const resetSeconds = Math.max(0, Math.ceil((entry.windowStart + windowMs - now) / 1000));
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - entry.count)));
    res.setHeader('RateLimit-Reset', String(resetSeconds));

    if (entry.count > limit) {
      res.setHeader('Retry-After', String(resetSeconds));
      return res.status(429).json({
        error: message || `Rate limit exceeded (${name}): too many requests. Please wait a moment.`
      });
    }
    next();
  }

  middleware.reset = () => hits.clear();
  return middleware;
}

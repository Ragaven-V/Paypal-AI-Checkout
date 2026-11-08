import crypto from 'crypto';
import { config } from './config.js';

/**
 * Small structured logger. LOG_FORMAT=json prints one JSON object per line (for hosting
 * platforms / log search); "pretty" prints readable lines for local development.
 * Never pass secrets in fields.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function serialize(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (value instanceof Error || key === 'err') {
      const e = value instanceof Error ? value : new Error(String(value));
      out.error = { message: e.message.slice(0, 500), status: e.status, stack: config.logLevel === 'debug' ? e.stack : undefined };
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function write(level, msg, fields) {
  if (LEVELS[level] < (LEVELS[config.logLevel] ?? LEVELS.info)) return;
  const data = serialize(fields);
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  if (config.logFormat === 'json') {
    stream.write(JSON.stringify({ time: new Date().toISOString(), level, msg, ...data }) + '\n');
  } else {
    const extra = Object.keys(data).length ? ' ' + JSON.stringify(data) : '';
    stream.write(`${new Date().toISOString().slice(11, 19)} ${level.toUpperCase().padEnd(5)} ${msg}${extra}\n`);
  }
}

export const log = {
  debug: (msg, fields) => write('debug', msg, fields),
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields)
};

/**
 * Gives every request an ID (reusing a valid incoming X-Request-Id), returns it in the response,
 * and logs one line per API request with status and duration. Health checks are not logged.
 */
export function requestLogger(req, res, next) {
  const incoming = req.headers['x-request-id'];
  req.id = typeof incoming === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);

  if (!req.path.startsWith('/api/')) return next();
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    // Path only (no query string): queries can carry session/shopper IDs
    log[level]('request', { requestId: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms) });
  });
  next();
}

// Last-resort error handler: log with the request ID, never leak internals to the client
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(err.status || 400).json({ error: 'Invalid request body' });
  }
  log.error('unhandled error', { requestId: req.id, method: req.method, path: req.path, err });
  res.status(500).json({ error: 'Something went wrong. Please try again.', requestId: req.id });
}

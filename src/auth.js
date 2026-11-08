import crypto from 'crypto';
import { promisify } from 'util';
import { config } from './config.js';
import { userStore, authSessionStore, orderStore } from './db.js';

/**
 * Customer accounts: email + password.
 * - Passwords: scrypt with a random 16-byte salt (memory-hard; stored as a self-describing string).
 * - Login sessions: random 32-byte token in an HttpOnly, SameSite=Lax cookie; only its SHA-256
 *   hash is stored, so a database leak doesn't expose usable sessions.
 */
const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const COOKIE_NAME = 'ab_session';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, N, r, p, saltB64, keyB64] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(key, expected);
}

// Used when the email doesn't exist, so a failed login takes the same time either way
let dummyHash = null;
async function getDummyHash() {
  dummyHash ??= await hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHash;
}

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
export const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

function validateCredentials(email, password) {
  if (!EMAIL_RE.test(email) || email.length > 254) {
    throw httpError('Please enter a valid email address.', 400);
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw httpError(`Password must be at least ${MIN_PASSWORD} characters.`, 400);
  }
  if (password.length > MAX_PASSWORD) {
    throw httpError(`Password must be at most ${MAX_PASSWORD} characters.`, 400);
  }
}

// ---- Failed-login throttling per email (in addition to the per-IP limit) -------------------
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;
const failures = new Map(); // email -> { count, first }

function checkLockout(email) {
  const entry = failures.get(email);
  if (entry && Date.now() - entry.first < FAIL_WINDOW_MS && entry.count >= MAX_FAILS) {
    throw httpError('Too many failed sign-in attempts for this account. Please try again in 15 minutes.', 429);
  }
}

function recordFailure(email) {
  const now = Date.now();
  const entry = failures.get(email);
  if (!entry || now - entry.first >= FAIL_WINDOW_MS) failures.set(email, { count: 1, first: now });
  else entry.count++;
}

export function resetLoginThrottleForTesting() {
  failures.clear();
}

// ---- Accounts ----------------------------------------------------------------------------
export async function registerUser(rawEmail, password) {
  const email = normalizeEmail(rawEmail);
  validateCredentials(email, password);
  if (userStore.getByEmail(email)) {
    throw httpError('An account with this email already exists. Please sign in instead.', 409);
  }
  try {
    return userStore.create(email, await hashPassword(password));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw httpError('An account with this email already exists. Please sign in instead.', 409);
    }
    throw err;
  }
}

export async function authenticateUser(rawEmail, password) {
  const email = normalizeEmail(rawEmail);
  if (!email || typeof password !== 'string' || !password) {
    throw httpError('Please enter your email and password.', 400);
  }
  checkLockout(email);

  const user = userStore.getByEmail(email);
  const ok = await verifyPassword(password.slice(0, MAX_PASSWORD), user ? user.password_hash : await getDummyHash());
  if (!user || !ok) {
    recordFailure(email);
    throw httpError('Incorrect email or password.', 401);
  }
  failures.delete(email);
  userStore.touchLogin(user.id);
  return user;
}

// ---- Login sessions ------------------------------------------------------------------------
export function startLoginSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + config.sessionDays * 24 * 60 * 60 * 1000;
  authSessionStore.create(hashToken(token), userId, expiresAt);
  return { token, expiresAt };
}

export function endLoginSession(token) {
  if (token) authSessionStore.delete(hashToken(token));
}

export function userForToken(token) {
  return token ? authSessionStore.getUser(hashToken(token)) : null;
}

// Move guest orders from this browser/session into the account
export function linkGuestOrders(userId, shopperId, sessionId) {
  return orderStore.linkToUser(userId, shopperId, sessionId);
}

// ---- Cookies -----------------------------------------------------------------------------
export function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

export function setSessionCookie(req, res, token, expiresAt) {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}`
  ];
  if (req.secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

export function clearSessionCookie(req, res) {
  const attrs = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (req.secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

// Middleware: req.user = { id, email } for a valid login cookie, otherwise null
export function authenticate(req, res, next) {
  try {
    req.user = userForToken(readCookie(req, COOKIE_NAME));
  } catch {
    req.user = null;
  }
  next();
}

/**
 * CSRF defence for cookie-authenticated requests: browsers send an Origin header on
 * cross-site POSTs; reject state-changing API calls from other origins.
 * (SameSite=Lax cookies already block most cases; this covers the rest.)
 */
export function sameOriginOnly(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (!origin) return next(); // non-browser clients (curl, server-to-server)
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return res.status(403).json({ error: 'Cross-site request blocked' });
  }
  if (host !== req.headers.host) {
    return res.status(403).json({ error: 'Cross-site request blocked' });
  }
  next();
}

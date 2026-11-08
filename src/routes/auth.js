import { Router } from 'express';
import {
  registerUser,
  authenticateUser,
  startLoginSession,
  endLoginSession,
  linkGuestOrders,
  readCookie,
  setSessionCookie,
  clearSessionCookie,
  COOKIE_NAME
} from '../auth.js';
import { isValidShopperId } from '../orders.js';
import { isValidSessionId } from './api.js';
import { log } from '../logger.js';

// Guest identifiers sent along with sign-in, so earlier guest orders can be attached to the account
function guestIds(body) {
  return {
    shopperId: isValidShopperId(body?.shopperId) ? body.shopperId : null,
    sessionId: isValidSessionId(body?.sessionId) ? body.sessionId : null
  };
}

function signIn(req, res, user, status = 200) {
  const { shopperId, sessionId } = guestIds(req.body);
  const linked = linkGuestOrders(user.id, shopperId, sessionId);
  const { token, expiresAt } = startLoginSession(user.id);
  setSessionCookie(req, res, token, expiresAt);
  res.status(status).json({ user: { id: user.id, email: user.email }, linkedOrders: linked });
}

export function createAuthRouter({ authLimiter }) {
  const router = Router();

  router.get('/me', (req, res) => {
    res.json({ user: req.user ? { id: req.user.id, email: req.user.email } : null });
  });

  router.post('/register', authLimiter, async (req, res) => {
    try {
      const { email, password } = req.body || {};
      const user = await registerUser(email, password);
      log.info('account created', { userId: user.id, requestId: req.id });
      signIn(req, res, user, 201);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not create the account.' });
      if (!err.status) log.error('register failed', { err, requestId: req.id });
    }
  });

  router.post('/login', authLimiter, async (req, res) => {
    try {
      const { email, password } = req.body || {};
      const user = await authenticateUser(email, password);
      signIn(req, res, user);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not sign in.' });
      if (!err.status) log.error('login failed', { err, requestId: req.id });
    }
  });

  router.post('/logout', (req, res) => {
    endLoginSession(readCookie(req, COOKIE_NAME));
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  return router;
}

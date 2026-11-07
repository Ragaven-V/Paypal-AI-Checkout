import crypto from 'crypto';

export const sessions = new Map();

const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

export function getOrCreateSession(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    sessionId = 'session_' + crypto.randomUUID();
  }
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      id: sessionId,
      cart: new Map(), // productId -> quantity (integer 1..10)
      chat: null,
      currentOrderId: null, // PayPal order ID created for this session
      lastActive: Date.now()
    };
    sessions.set(sessionId, session);
  } else {
    session.lastActive = Date.now();
  }
  return session;
}

// Periodic cleanup of sessions inactive for > 2 hours
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastActive > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

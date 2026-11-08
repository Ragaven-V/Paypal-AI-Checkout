import path from 'path';
import { createApp } from './src/app.js';
import { config } from './src/config.js';
import { isAiEnabled, startAiBackground } from './src/ai/gemini.js';
import { closeDb, backupDatabase, getDb, authSessionStore } from './src/db.js';
import { log } from './src/logger.js';

// Re-exports kept for existing imports/tests
export { catalog, catalogMap, executeSearchProducts } from './src/catalog.js';
export { sessions, getOrCreateSession } from './src/sessions.js';
export {
  getCartSummary,
  executeAddToCart,
  executeDecrementCart,
  executeRemoveFromCart,
  executeViewCart
} from './src/cart.js';
export { runMockAi } from './src/ai/mockAi.js';
export { getPayPalAccessToken, createPayPalOrder, capturePayPalOrder } from './src/paypal.js';
export { createApp };

export const app = createApp();

function startBackups() {
  if (config.databasePath === ':memory:' || !config.backupIntervalHours) return null;
  const dir = config.backupDir || path.join(path.dirname(path.resolve(config.databasePath)), 'backups');
  const run = async () => {
    try {
      const file = await backupDatabase(dir, config.backupKeep);
      log.info('database backup written', { file });
    } catch (err) {
      log.error('database backup failed', { err });
    }
  };
  const timer = setInterval(run, config.backupIntervalHours * 60 * 60 * 1000);
  timer.unref();
  return timer;
}

// Start server if invoked directly (node server.js / npm start)
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  getDb(); // open + migrate the database before accepting traffic
  authSessionStore.deleteExpired();

  // Express 5 passes listen errors (e.g. port already in use) to this callback instead of throwing
  const server = app.listen(config.port, (err) => {
    if (err) {
      if (err.code === 'EADDRINUSE') {
        log.error(`Port ${config.port} is already in use, probably by another copy of this server.`);
        log.error('Stop the other one (Ctrl+C in its terminal) or set a different PORT in .env.');
      } else {
        log.error(`Could not start the server: ${err.message}`);
      }
      process.exit(1);
    }
    startAiBackground();
    startBackups();
    log.info('server started', {
      url: `http://localhost:${config.port}`,
      ai: isAiEnabled() ? `Gemini (${config.geminiModel})` : 'Mock AI (rule-based)',
      paypalWebhooks: config.paypalWebhookId ? 'enabled' : 'disabled (set PAYPAL_WEBHOOK_ID)',
      database: config.databasePath
    });
  });

  // Graceful shutdown (deploys/restarts send SIGTERM): stop accepting connections, let
  // in-flight requests finish, then close the database cleanly.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });
    const force = setTimeout(() => {
      log.warn('forcing exit after 10s');
      process.exit(1);
    }, 10_000);
    force.unref();
    server.close(() => {
      try { closeDb(); } catch (err) { log.error('closing database failed', { err }); }
      log.info('shutdown complete');
      process.exit(0);
    });
    server.closeIdleConnections?.();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => log.error('unhandled promise rejection', { err: reason }));
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', { err });
    shutdown('uncaughtException');
  });
}

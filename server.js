// Entry point: assemble modules, start timers, and listen.
// All business logic lives in src/ — see REFACTOR_PLAN.md for the layout.

// .env MUST load before any module snapshots process.env (src/paths, comfy/client,
// comfy/idleRelease, routes/catalog all capture env constants at import time).
const { loadEnv } = require('./services/config');
loadEnv();

const os = require('os');
const { PORT, HOST, COMFY_URL } = require('./src/paths');
const { startTaskCleanupTimer, taskAbortControllers } = require('./src/store/tasks');
const { startIdleReleaseTimer } = require('./src/comfy/idleRelease');
const { createApp } = require('./src/http/app');

startTaskCleanupTimer();
startIdleReleaseTimer();

const app = createApp();
const server = app.listen(PORT, HOST, () => {
  console.log(`=======================================================`);
  console.log(`AI Fashion Studio Web UI is running at:`);
  console.log(`Local:   http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    for (const nets of Object.values(os.networkInterfaces())) {
      for (const net of nets) {
        if (net.family === 'IPv4' && !net.internal) {
          console.log(`Network: http://${net.address}:${PORT}`);
        }
      }
    }
  }
  console.log(`ComfyUI: ${COMFY_URL}`);
  console.log(`=======================================================`);
});

function shutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  for (const [, ac] of taskAbortControllers.entries()) {
    try { ac.abort(new Error(`Server shutting down (${signal})`)); } catch (e) {}
  }
  taskAbortControllers.clear();

  if (typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
  }
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

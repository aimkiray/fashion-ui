const express = require('express');
const cors = require('cors');
const path = require('path');
const { PROJECT_INPUT_DIR, PROJECT_OUTPUT_DIR, ensureStorageDirs } = require('../paths');
const { errorMiddleware } = require('./errorMiddleware');

function createApp() {
  ensureStorageDirs();
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));
  // Static endpoints now point exclusively to the project's own storage!
  app.use('/inputs', express.static(PROJECT_INPUT_DIR));
  app.use('/outputs', express.static(PROJECT_OUTPUT_DIR));

  app.use(require('../routes/catalog'));
  app.use(require('../routes/config'));
  app.use(require('../routes/previewPrompts'));
  app.use(require('../routes/uploads'));
  app.use(require('../routes/generate'));
  app.use(require('../routes/history'));
  app.use(require('../routes/enhance'));

  // Must be registered last: catches malformed/oversized bodies and async route errors.
  app.use(errorMiddleware);

  return app;
}

module.exports = { createApp };
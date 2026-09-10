const express = require("express");
const router = express.Router();
const { getSafeConfig, saveConfig, testOpenAiConnection } = require("../../services/config");
// Configuration Endpoints for Engines (OpenAI, Krea, etc.)
router.get('/api/config', (req, res) => {
  try {
    res.json(getSafeConfig());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/config', (req, res) => {
  try {
    const updated = saveConfig(req.body || {});
    res.json({ success: true, config: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/config/test', async (req, res) => {
  try {
    const { apiKey, baseUrl } = req.body || {};
    const result = await testOpenAiConnection(apiKey, baseUrl);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});


module.exports = router;
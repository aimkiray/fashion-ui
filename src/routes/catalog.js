const express = require("express");
const router = express.Router();
const { COMFY_URL } = require("../paths");
const { H3_ACTIONS } = require("../prompt-catalog/h3Actions");
const { SCENES } = require("../prompt-catalog/scenes");
const { MODEL_STYLES } = require("../prompt-catalog/modelStyles");
const { MODEL_AGES } = require("../prompt-catalog/modelAges");
const { HAIRSTYLES } = require("../prompt-catalog/hairstyles");
const { FACE_SHAPES } = require("../prompt-catalog/faceShapes");
router.get('/api/system', async (req, res) => {
  try {
    const resp = await fetch(`${COMFY_URL}/system_stats`);
    const data = await resp.json();
    let queueInfo = { running: 0, pending: 0 };
    try {
      const qResp = await fetch(`${COMFY_URL}/queue`);
      const qData = await qResp.json();
      queueInfo = {
        running: qData.queue_running ? qData.queue_running.length : 0,
        pending: qData.queue_pending ? qData.queue_pending.length : 0
      };
    } catch(e) {}

    res.json({
      online: true,
      gpu: data.devices && data.devices[0] ? data.devices[0].name : 'Unknown',
      vram_free_gb: data.devices && data.devices[0] ? (data.devices[0].vram_free / 1024 / 1024 / 1024).toFixed(1) : 'N/A',
      vram_total_gb: data.devices && data.devices[0] ? (data.devices[0].vram_total / 1024 / 1024 / 1024).toFixed(1) : 'N/A',
      queue: queueInfo
    });
  } catch (err) {
    res.json({ online: false, error: err.message });
  }
});

router.get('/api/actions', (_req, res) => {
  res.json(Object.values(H3_ACTIONS).map(a => ({ id: a.id, name: a.name, description: a.description })));
});

router.get('/api/scenes', (req, res) => {
  const list = Object.values(SCENES).map(s => ({
    id: s.id,
    name: s.name,
    enName: s.enName,
    icon: s.icon,
    description: s.description
  }));
  res.json(list);
});

router.get('/api/model-styles', (req, res) => {
  res.json(MODEL_STYLES);
});

router.get('/api/model-ages', (_req, res) => {
  res.json(MODEL_AGES);
});

router.get('/api/hairstyles', (_req, res) => {
  res.json(HAIRSTYLES);
});

router.get('/api/face-shapes', (_req, res) => {
  res.json(FACE_SHAPES);
});

module.exports = router;
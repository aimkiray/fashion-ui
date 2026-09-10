const express = require("express");
const router = express.Router();
const {
  startEnhanceJob,
  getEnhanceJob,
  cancelEnhanceJob
} = require("../../services/enhance");

// Start a post-hoc 超清增强 job for an existing generation-history video.
// Returns { jobId, output, resumed } — resumed=true means an identical job was
// already queued/running and its jobId is returned for polling.
router.post('/api/enhance', (req, res) => {
  const result = startEnhanceJob(req.body?.filename);
  if (result.error) return res.status(result.statusCode || 400).json({ error: result.error });
  res.json({ jobId: result.jobId, output: result.output, resumed: !!result.resumed });
});

router.get('/api/enhance/:jobId', (req, res) => {
  const job = getEnhanceJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: '找不到指定的增强任务' });
  res.json(job);
});

router.post('/api/enhance/:jobId/cancel', (req, res) => {
  const cancelled = cancelEnhanceJob(req.params.jobId);
  if (!cancelled) return res.status(400).json({ error: '任务状态不允许取消' });
  res.json({ success: true });
});

module.exports = router;

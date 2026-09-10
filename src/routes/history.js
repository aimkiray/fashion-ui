const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { readPngDims } = require("../images/canvas");
const { PROJECT_VIDEO_DIR, PROJECT_IMAGE_DIR } = require("../paths");
router.get('/api/history', (req, res) => {
  try {
    const list = [];
    // 1. Scan Videos
    if (fs.existsSync(PROJECT_VIDEO_DIR)) {
      const files = fs.readdirSync(PROJECT_VIDEO_DIR);
      files.filter(f => f.endsWith('-audio.mp4') || (f.endsWith('.mp4') && !files.includes(f.replace('.mp4', '-audio.mp4')))).forEach(f => {
        const fullPath = path.join(PROJECT_VIDEO_DIR, f);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size < 1024) return; // Skip empty/stub/corrupted video files
          const previewName = f.replace(/-audio\.mp4$|\.mp4$/, '.png');
          const previewPath = path.join(PROJECT_VIDEO_DIR, previewName);
          const hasPreview = fs.existsSync(previewPath) && fs.statSync(previewPath).size >= 512;
          // Dimensions let the client reserve the thumbnail box before load (no masonry jank)
          const previewDims = hasPreview ? readPngDims(previewPath) : null;
          list.push({
            type: 'video',
            filename: f,
            url: `/outputs/videos/${f}`,
            previewUrl: hasPreview ? `/outputs/videos/${previewName}` : null,
            width: previewDims ? previewDims.w : null,
            height: previewDims ? previewDims.h : null,
            size: (stat.size / 1024 / 1024).toFixed(2) + ' MB',
            createdAt: stat.mtime
          });
        } catch (e) {}
      });
    }

    // 2. Scan Still Photos (Stage 1 outputs)
    if (fs.existsSync(PROJECT_IMAGE_DIR)) {
      const imgFiles = fs.readdirSync(PROJECT_IMAGE_DIR);
      imgFiles.filter(f => f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.webp')).forEach(f => {
        const fullPath = path.join(PROJECT_IMAGE_DIR, f);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size < 512) return; // Skip empty/stub/corrupted image files
          const dims = readPngDims(fullPath); // null for non-PNG (client falls back to measure-after-load)
          list.push({
            type: 'image',
            filename: f,
            url: `/outputs/images/${f}`,
            previewUrl: `/outputs/images/${f}`,
            width: dims ? dims.w : null,
            height: dims ? dims.h : null,
            size: (stat.size / 1024 / 1024).toFixed(2) + ' MB',
            createdAt: stat.mtime
          });
        } catch (e) {}
      });
    }

    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(list.slice(0, 40));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a history item by type + filename (files live in fixed output dirs,
// so the client only supplies an untrusted filename which we sanitize).
router.delete('/api/history/:type/:filename', (req, res) => {
  try {
    const baseDir = req.params.type === 'video' ? PROJECT_VIDEO_DIR : PROJECT_IMAGE_DIR;
    const requested = path.basename(String(req.params.filename));
    if (!requested || requested !== req.params.filename || requested.includes('\\') || requested.startsWith('.')) {
      return res.status(400).json({ error: '非法文件名' });
    }
    const targets = [];
    if (req.params.type === 'video') {
      // Listed videos are the playable file, which may be "<base>.mp4" or "<base>-audio.mp4".
      // Normalize to base name, then clean up all three artifacts: video, audio twin, preview png.
      const base = requested.replace(/-audio\.mp4$|\.mp4$/, '');
      if (base && base !== requested) {
        targets.push(base + '.mp4');
        targets.push(base + '-audio.mp4');
        targets.push(base + '.png');
      }
    } else if (req.params.type === 'image') {
      targets.push(requested);
    } else {
      return res.status(400).json({ error: '未知类型' });
    }
    let deleted = 0;
    for (const name of targets) {
      if (!name || !name.includes('.')) continue;
      const target = path.join(baseDir, name);
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
        deleted++;
      }
    }
    if (deleted === 0) return res.status(404).json({ error: '文件不存在' });
    res.json({ ok: true, deleted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


module.exports = router;
const express = require("express");
const router = express.Router();
const fs = require("fs");
const { upload, looksLikeImage } = require("../http/uploads");

router.post('/api/upload', (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: '请选择或上传服装图片' });
    if (!looksLikeImage(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch(e) {}
      return res.status(400).json({ error: '文件内容不是有效的 PNG/JPG/WEBP/BMP 图片' });
    }
    res.json({
      filename: req.file.filename,
      url: `/inputs/${req.file.filename}`,
      size: req.file.size
    });
  });
});

module.exports = router;
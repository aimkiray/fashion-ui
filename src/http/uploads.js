const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { PROJECT_INPUT_DIR } = require('../paths');

// Configure multer for file uploads -> saves exclusively into PROJECT_INPUT_DIR
const fileFilter = (req, file, cb) => {
  const allowedExts = ['.png', '.jpg', '.jpeg', '.webp', '.bmp'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowedExts.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('只支持上传 PNG, JPG, JPEG, WEBP, BMP 图片格式'));
  }
};
// Disambiguates same-name uploads that land in the same millisecond
let uploadSeq = 0;
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PROJECT_INPUT_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    const prefix = req.query.type ? path.basename(String(req.query.type)) : 'upload';
    cb(null, `${prefix}_${Date.now()}_${(uploadSeq++).toString(36)}_${base}${ext}`);
  }
});
const upload = multer({ storage, fileFilter, limits: { fileSize: 50 * 1024 * 1024 } });

// Extension checks alone accept renamed non-images; verify magic bytes instead.
const IMAGE_MAGICS = [
  [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], // PNG
  [0xFF, 0xD8, 0xFF],                                 // JPEG
  [0x42, 0x4D]                                        // BMP
];
function looksLikeImage(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (e) {
    return false; // file vanished between multer save and check → not a valid image
  }
  try {
    const buf = Buffer.alloc(12);
    const n = fs.readSync(fd, buf, 0, 12, 0);
    const head = buf.subarray(0, n);
    if (IMAGE_MAGICS.some(m => m.every((b, i) => head[i] === b))) return true;
    return n >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP';
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { upload, looksLikeImage };
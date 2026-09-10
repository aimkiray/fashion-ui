const fs = require("fs");
const { ASPECT_CANVAS } = require("../paths");
function readPngDims(filePath) {
  try {
    const buf = Buffer.alloc(24);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buf, 0, 24, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch (e) {
    return null;
  }
}

// Dimension sniffing for the formats the existing-still path may receive
// (PNG / JPEG / WebP). JPEG: scan SOFn markers; WebP: VP8X extended header
// or the lossy VP8 frame header. Returns null for anything unrecognized.
function readImageDims(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    if (read < 24) return null;
    if (buf.toString('ascii', 12, 16) === 'IHDR') {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    // JPEG
    if (buf[0] === 0xFF && buf[1] === 0xD8) {
      let off = 2;
      while (off + 9 < read) {
        if (buf[off] !== 0xFF) { off++; continue; }
        const marker = buf[off + 1];
        // standalone markers without length
        if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) { off += 2; continue; }
        const len = buf.readUInt16BE(off + 2);
        // SOF0-SOF15 except DHT(C4)/JPG(C8)/DAC(CC) carry the frame dimensions
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
        }
        off += 2 + len;
      }
      return null;
    }
    // WebP
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP' && read >= 30) {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8X') {
        // 24-bit canvas-1 dimensions at bytes 24-29
        const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
        const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
        return { w, h };
      }
      if (chunk === 'VP8 ' && buf[23] === 0x9D && buf[24] === 0x01 && buf[25] === 0x2A) {
        // lossy keyframe: 14-bit dimensions after the 3-byte start code
        return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      }
      return null;
    }
    return null;
  } catch (e) {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (e) {}
    }
  }
}

// Pick the video canvas whose aspect ratio best matches the given image
function nearestCanvasKey(width, height) {
  const ratio = width / height;
  let best = null;
  let bestDiff = Infinity;
  for (const [key, c] of Object.entries(ASPECT_CANVAS)) {
    const diff = Math.abs(c.width / c.height - ratio);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = key;
    }
  }
  return best;
}


module.exports = { readPngDims, readImageDims, nearestCanvasKey };

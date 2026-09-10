const fs = require('fs');
const path = require('path');
const { runPythonScript } = require('./pythonBin');

// Ensure the still image fed to Stage 2 perfectly conforms to canvas dimensions
// without distortion. Async: see detectFlatlayScore for why sync is forbidden here.
async function conformImageToCanvas(srcPath, dstPath, width, height) {
  const scriptPath = path.join(__dirname, '..', '..', 'crop_to_canvas.py');
  if (fs.existsSync(scriptPath) && fs.existsSync(srcPath)) {
    try {
      const fitResult = await runPythonScript(scriptPath, [srcPath, dstPath, String(width), String(height)], {
        timeout: 5000
      });
      if (fitResult && fitResult.stderr && fitResult.stderr.trim()) {
        console.warn('crop_to_canvas:', fitResult.stderr.trim());
      }
      if (fs.existsSync(dstPath)) return;
    } catch (err) {
      console.warn('Image resizing to canvas failed, falling back to direct copy:', err.message);
    }
  }
  fs.copyFileSync(srcPath, dstPath);
}

module.exports = { conformImageToCanvas };
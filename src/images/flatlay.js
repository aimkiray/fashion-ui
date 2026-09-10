const path = require('path');
const fs = require('fs');
const { runPythonScript } = require('./pythonBin');

// Detect white-background flat-lay / mannequin product shots. These force the
// diffusion model to inherit the flat studio reflections and plastic mannequin
// texture if ref_boost is too high; loosen it automatically for those inputs.
// Async on purpose: a synchronous execFile would freeze the event loop (and
// every concurrent API request, including progress polling) for seconds.
async function detectFlatlayScore(imagePath) {
  const scriptPath = path.join(__dirname, '..', '..', 'detect_flatlay.py');
  if (!fs.existsSync(scriptPath) || !fs.existsSync(imagePath)) return { flatlay_score: 0 };
  try {
    const { stdout } = await runPythonScript(scriptPath, [imagePath], {
      encoding: 'utf-8',
      timeout: 3000,
      maxBuffer: 1 * 1024 * 1024
    });
    const parsed = JSON.parse(stdout.trim().split(/\r?\n/).pop());
    return typeof parsed.flatlay_score === 'number' ? parsed : { flatlay_score: 0 };
  } catch (err) {
    console.warn('Flat-lay detection skipped:', err.message);
    return { flatlay_score: 0 };
  }
}

module.exports = { detectFlatlayScore };
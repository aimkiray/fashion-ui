const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PROJECT_VIDEO_DIR } = require('../src/paths');

// Post-hoc 超清增强 for existing generation-history videos (video wall card
// button). Generation-time enhancement runs the 3D latent upscaler inside
// ComfyUI; the latents are gone afterwards, so for already-rendered videos the
// only route is a pixel-space pipeline: FFmpeg motion-compensated frame
// interpolation (24fps → 60fps) + Lanczos 1.5x upscale (≈1080p class).

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

// minterpolate(mci/aobmc/bidir) is the heaviest CPU path in ffmpeg — run at
// most one enhancement at a time and queue the rest to protect the server.
const MAX_CONCURRENT = 1;

// In-memory job registry — mirror of tasks.js eviction strategy:
// 2h max age, hard cap with newest-kept trimming. Active (queued/running)
// jobs are never evicted.
const MAX_JOBS = 150;
const TRIM_KEEP = 50;
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const jobs = new Map();
let cleanupTimer = null;

// In-flight locks keyed by output filename: a second POST for the same source
// (or any source colliding on the same output) is rejected instead of racing
// two ffmpeg processes into one .part file (data corruption).
const inflightDst = new Set();
const waitQueue = [];
let activeCount = 0;

function evictStale() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && job.status !== 'queued' && now - job.createdAt > MAX_AGE_MS) {
      jobs.delete(id);
    }
  }
  if (jobs.size > MAX_JOBS) {
    const done = [...jobs.entries()].filter(([, j]) => j.status !== 'running' && j.status !== 'queued');
    done.sort((a, b) => a[1].createdAt - b[1].createdAt);
    const excess = jobs.size - TRIM_KEEP;
    for (let i = 0; i < Math.min(excess, done.length); i++) jobs.delete(done[i][0]);
  }
}

function ensureCleanupTimer() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(evictStale, 10 * 60 * 1000);
  cleanupTimer.unref();
}

// Kill any orphaned .part temp files left behind by a crashed/killed process —
// history scanning ignores them, so they would silently eat disk space.
function cleanupStalePartFiles() {
  try {
    if (!fs.existsSync(PROJECT_VIDEO_DIR)) return;
    for (const f of fs.readdirSync(PROJECT_VIDEO_DIR)) {
      if (!f.endsWith('.mp4.part') && !f.endsWith('.png.part')) continue;
      try { fs.unlinkSync(path.join(PROJECT_VIDEO_DIR, f)); } catch (e) {}
    }
  } catch (e) {}
}

// Output naming: strip the VHS "-audio" twin suffix so the enhanced file is
// listed as its own playable entry (history scan dedupes on -audio.mp4).
function deriveEnhancedName(filename) {
  const base = String(filename).replace(/-audio\.mp4$|\.mp4$/i, '');
  return `${base}_1080p60.mp4`;
}

function isEnhancedVideo(filename) {
  return /_1080p60\.mp4$/i.test(String(filename));
}

// Filename validation aligned with the existing history.js DELETE standard
// (basename must equal the raw input) plus Windows reserved device names.
function validateFilename(filename) {
  const raw = String(filename || '');
  const requested = path.basename(raw);
  if (!raw || !requested || requested !== raw) return '非法文件名';
  if (requested.includes('\\') || requested.includes('\0') || requested.startsWith('.')) return '非法文件名';
  if (!/\.mp4$/i.test(requested)) return '仅支持 .mp4 视频';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(requested)) return '非法文件名';
  return null;
}

function probeDuration(file, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFPROBE, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file
    ], { signal });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('error', reject);
    p.on('close', code => {
      if (code !== 0) return reject(new Error(`ffprobe 退出码 ${code}`));
      try {
        const dur = parseFloat(JSON.parse(out).format.duration);
        resolve(Number.isFinite(dur) && dur > 0 ? dur : null);
      } catch (e) { resolve(null); }
    });
  });
}

// Picks the most informative line for error reporting: ffmpeg's actual error
// line when present, otherwise the tail of stderr.
function pickErrorLine(stderr) {
  const lines = stderr.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.reverse().find(l => /error|invalid|failed|unable/i.test(l)) || lines[0] || '无详细输出';
}

// Streams -progress pipe:1 output; parses per full line so a token split
// across chunk boundaries is not lost.
function runFfmpeg(args, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-nostats', '-y', ...args], { signal });
    let stderr = '';
    let lineBuf = '';
    p.stderr.on('data', d => {
      stderr += d;
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
    });
    if (onProgress) {
      p.stdout.on('data', d => {
        lineBuf += d.toString();
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop();
        for (const line of lines) {
          const m = line.match(/out_time_us=(\d+)/);
          if (m) onProgress(parseInt(m[1], 10));
        }
      });
    }
    p.on('error', reject);
    p.on('close', code => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg 退出码 ${code}: ${pickErrorLine(stderr)}`));
    });
  });
}

function setJob(job, patch) {
  Object.assign(job, patch);
}

function releaseLock(job) {
  inflightDst.delete(job.output);
}

function pumpQueue() {
  while (activeCount < MAX_CONCURRENT && waitQueue.length) {
    const jobId = waitQueue.shift();
    const job = jobs.get(jobId);
    if (!job || job.ac.signal.aborted) {
      if (job) releaseLock(job);
      continue;
    }
    activeCount++;
    runEnhance(jobId).finally(() => {
      activeCount--;
      releaseLock(job);
      pumpQueue();
    });
  }
}

async function runEnhance(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  const srcPath = path.join(PROJECT_VIDEO_DIR, job.filename);
  const dstPath = path.join(PROJECT_VIDEO_DIR, job.output);
  const tmpPath = dstPath + '.part';
  // Run Enhance starts here: mark running immediately so the queued-eviction
  // window (B2) cannot drop an active job.
  setJob(job, { status: 'running', progress: 3, message: '正在启动 FFmpeg 增强 (60fps 运动补偿插帧 + Lanczos 1.5x 放大)...' });

  try {
    const duration = await probeDuration(srcPath, { signal: job.ac.signal });

    // Order matters: minterpolate runs at the source resolution (cheaper flow
    // estimation), the Lanczos upscale comes after.
    const scaleW = "scale=trunc(iw*1.5/2)*2:trunc(ih*1.5/2)*2:flags=lanczos";
    const args = [
      '-i', srcPath,
      '-vf', `minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,${scaleW}`,
      '-c:v', 'libx264', '-crf', '18', '-preset', 'medium',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      '-progress', 'pipe:1',
      tmpPath
    ];

    await runFfmpeg(args, {
      signal: job.ac.signal,
      onProgress: (us) => {
        if (!duration) {
          // Unknown duration: keep an indeterminate progress without percent
          setJob(job, { message: '超清增强处理中...（时长未知）' });
          return;
        }
        const pct = Math.max(3, Math.min(95, Math.round((us / 1e6 / duration) * 92) + 3));
        setJob(job, { progress: pct, message: `超清增强处理中... ${pct}%` });
      }
    });

    if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size < 1024) {
      throw new Error('增强输出文件缺失或损坏');
    }
    // Commit boundary: once renamed, the job can no longer be cancelled.
    if (job.ac.signal.aborted) {
      try { fs.unlinkSync(tmpPath); } catch (e) {}
      setJob(job, { status: 'cancelled', message: '超清增强已被取消' });
      return;
    }
    fs.renameSync(tmpPath, dstPath);

    // Regenerate the masonry preview thumbnail from the enhanced video so the
    // history card shows the real 1080p frame. Written to .part then renamed
    // so a kill cannot leave a half-written PNG that history would display.
    setJob(job, { progress: 97, message: '生成预览缩略图...' });
    try {
      const previewPath = dstPath.replace(/\.mp4$/i, '.png');
      const previewTmp = previewPath + '.part';
      await runFfmpeg(['-i', dstPath, '-frames:v', '1', '-q:v', '2', previewTmp], { signal: job.ac.signal });
      fs.renameSync(previewTmp, previewPath);
    } catch (e) { /* preview is optional */ }

    setJob(job, { status: 'completed', progress: 100, output: job.output, message: '超清增强完成 (1080p·60fps)' });
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
    if (job.ac.signal.aborted) {
      setJob(job, { status: 'cancelled', message: '超清增强已被取消' });
    } else {
      setJob(job, { status: 'error', message: err.message });
    }
  }
}

// Validates the request and queues a background enhancement job.
function startEnhanceJob(filename) {
  const invalid = validateFilename(filename);
  if (invalid) return { error: invalid, statusCode: 400 };
  const requested = path.basename(String(filename));
  if (isEnhancedVideo(requested)) {
    return { error: '该视频已经是超清增强版本', statusCode: 400 };
  }
  const srcPath = path.join(PROJECT_VIDEO_DIR, requested);
  let stat;
  try {
    stat = fs.statSync(srcPath);
  } catch (e) {
    return { error: '找不到指定的视频文件', statusCode: 404 };
  }
  if (!stat.isFile() || stat.size < 1024) {
    return { error: '找不到指定的视频文件', statusCode: 404 };
  }
  const dstName = deriveEnhancedName(requested);
  if (fs.existsSync(path.join(PROJECT_VIDEO_DIR, dstName))) {
    return { error: `已存在增强版本: ${dstName}`, statusCode: 409 };
  }
  if (inflightDst.has(dstName)) {
    // Same output already queued/running: hand back the existing job so the
    // client can resume polling instead of racing a duplicate ffmpeg.
    const existing = [...jobs.values()].find(j =>
      j.output === dstName && (j.status === 'queued' || j.status === 'running'));
    if (existing) return { jobId: existing.id, output: dstName, resumed: true };
    return { error: '该视频正在增强中，请稍候', statusCode: 409 };
  }

  evictStale();
  ensureCleanupTimer();
  const jobId = crypto.randomUUID();
  const job = {
    id: jobId,
    filename: requested,
    output: dstName,
    status: 'queued',
    progress: 0,
    message: '排队等待增强...',
    createdAt: Date.now(),
    ac: new AbortController()
  };
  jobs.set(jobId, job);
  inflightDst.add(dstName);
  waitQueue.push(jobId);
  pumpQueue();
  return { jobId, output: dstName };
}

function getEnhanceJob(jobId) {
  const job = jobs.get(String(jobId || ''));
  if (!job) return null;
  const { ac, ...publicJob } = job;
  return publicJob;
}

function cancelEnhanceJob(jobId) {
  const job = jobs.get(String(jobId || ''));
  if (!job || (job.status !== 'running' && job.status !== 'queued')) return false;
  job.ac.abort(new Error('cancelled'));
  pumpQueue(); // flush a cancelled queued job out of the wait queue
  return true;
}

cleanupStalePartFiles();

module.exports = {
  startEnhanceJob,
  getEnhanceJob,
  cancelEnhanceJob,
  deriveEnhancedName,
  isEnhancedVideo
};

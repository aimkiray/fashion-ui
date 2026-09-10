const { COMFY_URL } = require("../paths");
const { tasks, isActiveTask } = require("../store/tasks");
// Release models after 30 idle minutes. Set IDLE_RELEASE_MS=0 to disable.
const idleReleaseSetting = process.env.IDLE_RELEASE_MS;
const configuredIdleReleaseMs = idleReleaseSetting && idleReleaseSetting.trim() !== ''
  ? Number(idleReleaseSetting)
  : NaN;
const IDLE_RELEASE_MS = Number.isFinite(configuredIdleReleaseMs) && configuredIdleReleaseMs >= 0
  ? configuredIdleReleaseMs
  : 30 * 60 * 1000;
let lastGenerationActivityAt = 0;
let idleReleased = false;

function noteGenerationActivity() {
  lastGenerationActivityAt = Date.now();
  idleReleased = false;
}

async function releaseComfyResourcesIfIdle() {
  if (IDLE_RELEASE_MS === 0 || !lastGenerationActivityAt || idleReleased) return;
  if ([...tasks.values()].some(isActiveTask)) return;
  if (Date.now() - lastGenerationActivityAt < IDLE_RELEASE_MS) return;

  try {
    const queueRes = await fetch(`${COMFY_URL}/queue`);
    if (!queueRes.ok) throw new Error(`queue check returned HTTP ${queueRes.status}`);
    const queue = await queueRes.json();
    const running = queue.queue_running ? queue.queue_running.length : 0;
    const pending = queue.queue_pending ? queue.queue_pending.length : 0;

    // A request may have started while /queue was being read.
    if (running || pending || [...tasks.values()].some(isActiveTask)) return;

    const freeRes = await fetch(`${COMFY_URL}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true })
    });
    if (!freeRes.ok) throw new Error(`resource release returned HTTP ${freeRes.status}`);

    idleReleased = true;
    const idleLabel = IDLE_RELEASE_MS < 60_000
      ? `${Math.round(IDLE_RELEASE_MS / 1000)} seconds`
      : `${Math.round(IDLE_RELEASE_MS / 60_000)} minutes`;
    console.log(`Requested ComfyUI resource release after ${idleLabel} idle.`);
  } catch (err) {
    console.warn('Idle ComfyUI resource release skipped:', err.message);
  }
}


let idleTimer = null;
function startIdleReleaseTimer() {
  if (idleTimer) return idleTimer;
  idleTimer = setInterval(() => {
    void releaseComfyResourcesIfIdle();
  }, 60 * 1000);
  idleTimer.unref();
  return idleTimer;
}

module.exports = { noteGenerationActivity, releaseComfyResourcesIfIdle, startIdleReleaseTimer };

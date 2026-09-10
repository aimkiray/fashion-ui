
// Global task store with auto-cleanup (prevent memory leak)
const tasks = new Map();
const batchJobs = new Map();
const taskAbortControllers = new Map();
const isActiveTask = (task) => task.status === 'queued' || task.status === 'running';

function cancelTask(taskId, reason = '任务已被用户取消') {
  const task = tasks.get(taskId);
  if (!task) return false;
  if (task.status === 'completed' || task.status === 'error' || task.status === 'cancelled') {
    return false;
  }
  task.status = 'cancelled';
  task.error = reason;
  task.message = reason;
  const ac = taskAbortControllers.get(taskId);
  if (ac) {
    try { ac.abort(new Error(reason)); } catch (e) {}
    taskAbortControllers.delete(taskId);
  }
  return true;
}

function cancelBatchJob(batchId, reason = '批量任务已被用户取消') {
  const batch = batchJobs.get(batchId);
  if (!batch) return false;
  if (batch.status === 'completed' || batch.status === 'error' || batch.status === 'cancelled') {
    return false;
  }
  batch.status = 'cancelled';
  batch.error = reason;
  batch.message = reason;
  if (Array.isArray(batch.taskIds)) {
    for (const tid of batch.taskIds) {
      cancelTask(tid, reason);
    }
  }
  return true;
}

// Periodic cleanup so finished tasks/batches never leak memory.
let cleanupTimer = null;

// Eviction rules (extracted for unit testing): finished tasks/batches older
// than maxAge are dropped; active ones are never evicted; task count capped.
function evictStale(now = Date.now()) {
  const maxAge = 2 * 60 * 60 * 1000; // 2 hours
  for (const [id, task] of tasks.entries()) {
    if (isActiveTask(task)) continue; // never evict in-flight tasks
    const age = now - new Date(task.createdAt).getTime();
    if (age > maxAge) {
      tasks.delete(id);
      taskAbortControllers.delete(id);
    }
  }
  for (const [id, batch] of batchJobs.entries()) {
    if (batch.status === 'queued' || batch.status === 'running') continue; // never evict in-flight batches
    const age = now - new Date(batch.createdAt).getTime();
    if (age > maxAge) batchJobs.delete(id);
  }
  if (tasks.size > 150) {
    const sorted = [...tasks.entries()]
      .filter(([, task]) => !isActiveTask(task))
      .sort((a, b) => new Date(a[1].createdAt) - new Date(b[1].createdAt));
    for (let i = 0; i < sorted.length - 50; i++) {
      const delId = sorted[i][0];
      tasks.delete(delId);
      taskAbortControllers.delete(delId);
    }
  }
}

function startTaskCleanupTimer() {
  if (cleanupTimer) return cleanupTimer;
  cleanupTimer = setInterval(() => {
    evictStale();
  }, 10 * 60 * 1000);
  cleanupTimer.unref();
  return cleanupTimer;
}

module.exports = {
  tasks,
  batchJobs,
  taskAbortControllers,
  cancelTask,
  cancelBatchJob,
  isActiveTask,
  evictStale,
  startTaskCleanupTimer
};

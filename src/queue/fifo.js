
let globalJobQueue = Promise.resolve();

function enqueueJob(runner) {
  const next = globalJobQueue.then(async () => {
    try {
      await runner();
    } catch (err) {
      console.error('Job execution failed in global queue:', err);
    }
  }).catch(fatalErr => {
    console.error('Fatal unhandled error in globalJobQueue runner:', fatalErr);
  });
  globalJobQueue = next;
  return next;
}

module.exports = { enqueueJob };
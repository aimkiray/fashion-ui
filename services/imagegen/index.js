const { generateKrea2 } = require('./krea2');
const { generateGptImage2 } = require('./gptImage2');

/**
 * Strategy Router for Reference/Still Image Generation
 *
 * @param {Object} params
 * @param {'krea2'|'gpt_image_2'} params.engine - The image generation engine to use
 * @param {Object} params.task - The fashion generation task
 * @param {string} params.taskId - Unique task ID
 * @param {string} params.prompt - Lookbook prompt for stage 1
 * @param {Function} [params.onProgress] - Progress callback (progressNum, messageText)
 * @param {Object} [params.context] - Dependencies for local execution (ComfyUI dirs, etc.)
 */
async function generateReferenceImage({
  engine = 'krea2',
  task,
  taskId,
  prompt,
  signal,
  onProgress,
  context = {}
}) {
  const normalizedEngine = (engine || 'krea2').toLowerCase().trim();

  if (normalizedEngine === 'gpt_image_2') {
    return await generateGptImage2({
      task,
      taskId,
      prompt,
      signal,
      projectInputDir: context.projectInputDir,
      projectImageDir: context.projectImageDir,
      aspectCanvas: context.aspectCanvas,
      onProgress
    });
  }

  // Default: krea2
  return await generateKrea2({
    task,
    taskId,
    prompt,
    signal,
    projectInputDir: context.projectInputDir,
    projectImageDir: context.projectImageDir,
    comfyTempInputDir: context.comfyTempInputDir,
    comfyOutputDir: context.comfyOutputDir,
    comfyRemote: context.comfyRemote,
    comfyUrl: context.comfyUrl,
    workflowsDir: context.workflowsDir,
    aspectCanvas: context.aspectCanvas,
    randomSeed: context.randomSeed,
    detectFlatlayScore: context.detectFlatlayScore,
    requireNodes: context.requireNodes,
    submitComfyWorkflow: context.submitComfyWorkflow,
    onProgress
  });
}

module.exports = {
  generateReferenceImage
};

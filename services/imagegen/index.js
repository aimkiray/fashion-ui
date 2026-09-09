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
  onProgress,
  context = {}
}) {
  const normalizedEngine = (engine || 'krea2').toLowerCase().trim();

  if (normalizedEngine === 'gpt_image_2') {
    return await generateGptImage2({
      task,
      taskId,
      prompt,
      projectInputDir: context.projectInputDir,
      projectImageDir: context.projectImageDir,
      onProgress
    });
  }

  // Default: krea2
  return await generateKrea2({
    task,
    taskId,
    prompt,
    projectInputDir: context.projectInputDir,
    projectImageDir: context.projectImageDir,
    comfyTempInputDir: context.comfyTempInputDir,
    comfyOutputDir: context.comfyOutputDir,
    workflowsDir: context.workflowsDir,
    aspectCanvas: context.aspectCanvas,
    randomSeed: context.randomSeed,
    detectFlatlayScoreSync: context.detectFlatlayScoreSync,
    requireNodes: context.requireNodes,
    submitComfyWorkflow: context.submitComfyWorkflow,
    onProgress
  });
}

module.exports = {
  generateReferenceImage
};

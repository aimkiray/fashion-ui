const { SCENES } = require("../prompt-catalog/scenes");
const { MODEL_STYLES } = require("../prompt-catalog/modelStyles");
const { H3_ACTION_IDS, normTaskAction } = require("../prompt-catalog/h3Actions");
const { styledSubject } = require("./styledSubject");
const { h3SegPrompt } = require("./h3SegPrompt");
const { stripTextboxNoise } = require("./textbox");
// Centralized authoritative prompt computation for preview and execution
function computeTaskPrompts({
  scene = 'street',
  gender = 'female',
  model_style = 'classic',
  model_style_prompt = '',
  custom_scene = '',
  custom_prompt = '',
  model_image = null,
  scene_image = null,
  action1 = 'random',
  action2 = 'random',
  hair_style = 'natural',
  face_shape = 'oval',
  model_age = 'adult'
} = {}) {
  const modelStyleKey = MODEL_STYLES[model_style] ? model_style : 'classic';
  const sceneConfig = SCENES[scene] || SCENES.street;
  const isM = gender === 'male';

  const cleanCustom = stripTextboxNoise(custom_prompt);
  const cleanCustomScene = stripTextboxNoise(custom_scene);
  const cleanCustomModelStyle = stripTextboxNoise(model_style_prompt);

  const prompts = sceneConfig.buildPrompts(
    gender,
    cleanCustom,
    cleanCustomScene,
    modelStyleKey,
    cleanCustomModelStyle,
    hair_style,
    face_shape,
    model_age
  );

  let kreaPrompt = prompts.krea_prompt;

  if (model_image) {
    const customEnvPreposition = /^(in|on|at|against|under|near|along)\s+/i.test(cleanCustomScene) ? '' : 'in ';
    const sceneEnv = (sceneConfig.id === 'custom' && cleanCustomScene)
      ? `${customEnvPreposition}${cleanCustomScene}, realistic lighting consistent with the environment`
      : (sceneConfig.sceneEnvironment || 'in an aesthetic fashion lookbook background, natural commercial lighting');
    const modelGenderLabel = isM ? 'male model' : 'female model';
    kreaPrompt = `Create an editorial lookbook portrait. Transfer the clothing and outfit from the first reference image onto the ${modelGenderLabel} in the second reference image, strictly preserving their exact facial features, facial identity, eye shape, nose shape, and hairstyle, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, if the reference garment is a separate top or bottom, naturally complementing it with a clean tailored matching piece; if the reference is a dress, jumpsuit or one-piece outfit, keeping it as one complete garment without splitting. ${isM ? 'He' : 'She'} is the clear visual focus with a soft intimate POV feeling, standing ${sceneEnv}. Full body editorial lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on ground with realistic soft ground contact shadows beneath footwear, arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers, subtle natural weight shift. Soft direct eye contact with warm genuine presence, serene composed expression, naturally closed lips without tension, relaxed natural jawline. Realistic lighting consistent with the environment, clean neutral-to-warm color balance, clothing and background colors remaining faithful without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile fabric weave and seam details. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain${cleanCustom ? ', ' + cleanCustom : ''}`;
  } else if (scene_image) {
    const subj = styledSubject(gender, modelStyleKey, 'stylish female model', 'stylish male model', cleanCustomModelStyle, hair_style, face_shape, model_age);
    kreaPrompt = `Create an editorial lookbook portrait of a ${subj} standing full-length in the background environment from the first reference image, wearing the exact clothing and outfit from the second reference image, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, if the reference garment is a separate top or bottom, naturally complementing it with a clean tailored matching piece; if the reference is a dress, jumpsuit or one-piece outfit, keeping it as one complete garment without splitting. ${isM ? 'He' : 'She'} is the clear visual focus with a soft intimate POV feeling. Soft direct eye contact with warm genuine presence, face angle natural and alive. Elegant confident posture, body language relaxed but intentional, shoulders soft and open, waistline visible, posture forming gentle lines. Full body editorial lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on ground with realistic soft ground contact shadows beneath footwear, arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers, subtle natural weight shift. Serene composed expression, naturally closed lips without tension, relaxed natural jawline. Realistic illumination matched to the background environment, clean neutral-to-warm color balance, clothing and background colors remaining faithful without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile fabric weave and seam details. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain${cleanCustom ? ', ' + cleanCustom : ''}`;
  }

  const { action1: a1, action2: a2 } = resolveActions(action1, action2, sceneConfig.id);
  kreaPrompt = injectActionProps(kreaPrompt, a1, a2);

  // 道具仅由 seg2 触发时（a1 非道具动作），seg1 提示词也要锚定道具存在，
  // 防止定妆照中的道具在 seg1 期间凭空消失、seg2 又需要它。
  let seg1Extra = cleanCustom;
  if (!PROP_ACTIONS.includes(a1) && PROP_ACTIONS.includes(a2)) {
    const propKeep = '画面中出现的道具（咖啡杯、手机或挎包）保持自然稳定，不凭空消失或变形。';
    seg1Extra = seg1Extra ? `${seg1Extra}\n${propKeep}` : propKeep;
  }

  return {
    krea_prompt: kreaPrompt,
    seg1_prompt: h3SegPrompt(sceneConfig.id, a1, 1, isM, seg1Extra),
    seg2_prompt: h3SegPrompt(sceneConfig.id, a2, 2, isM, cleanCustom, a1),
    actions: { seg1: a1, seg2: a2 }
  };
}

function resolveActions(action1 = 'random', action2 = 'random', scene = 'street') {
  let a1 = normTaskAction(action1, 'random');
  let a2 = normTaskAction(action2, 'random');
  // Studio scene: cyclorama grey backdrop avoids outdoor bench and storefront window
  const poolBase = scene === 'studio'
    ? H3_ACTION_IDS.filter(id => id !== 'bench_sit' && id !== 'window_browse')
    : H3_ACTION_IDS;

  if (a1 === 'random' && a2 === 'random') {
    a1 = poolBase[Math.floor(Math.random() * poolBase.length)];
    const pool = poolBase.filter(id => id !== a1);
    a2 = pool[Math.floor(Math.random() * pool.length)] || a1;
  } else if (a1 === 'random') {
    const pool = poolBase.filter(id => id !== a2);
    a1 = pool[Math.floor(Math.random() * pool.length)] || a2;
  } else if (a2 === 'random') {
    const pool = poolBase.filter(id => id !== a1);
    a2 = pool[Math.floor(Math.random() * pool.length)] || a1;
  }
  return { action1: a1, action2: a2 };
}

// 收集两个分镜涉及的全部道具（去重）——a1/a2 为不同道具动作时必须同时注入，
// 否则定妆照缺道具会导致 H3 在视频段凭空生成道具。
const PROP_ACTIONS = ['coffee_sip', 'phone_check', 'bag_shift'];

function injectActionProps(promptText, a1, a2) {
  const hints = [];
  const used = new Set([a1, a2]);
  if (used.has('coffee_sip')) {
    hints.push('The model naturally holds a sleek takeaway coffee cup in one hand. ');
  }
  if (used.has('phone_check')) {
    hints.push('The model naturally holds a sleek modern smartphone in both hands. ');
  }
  if (used.has('bag_shift')) {
    hints.push('The model wears a stylish chic leather shoulder bag over one shoulder. ');
  }
  if (!hints.length) return promptText;
  const propHint = hints.join('');

  if (promptText.includes('Props stay small and secondary if present.')) {
    return promptText.replace('Props stay small and secondary if present.', `${propHint}Props stay small and secondary if present.`);
  }
  return promptText + ', ' + propHint.trim();
}

function resolveBatchActions(selectedScenes = [], action1 = 'random', action2 = 'random') {
  const isA1Random = (action1 === 'random' || !action1);
  const isA2Random = (action2 === 'random' || !action2);

  if (!isA1Random && !isA2Random) {
    const fixedA1 = normTaskAction(action1, 'walk');
    const fixedA2 = normTaskAction(action2, 'pose');
    return selectedScenes.map(() => ({ action1: fixedA1, action2: fixedA2 }));
  }

  const usedActions = new Set();
  const results = [];

  for (const scKey of selectedScenes) {
    const poolBase = scKey === 'studio'
      ? H3_ACTION_IDS.filter(id => id !== 'bench_sit' && id !== 'window_browse')
      : H3_ACTION_IDS;

    let a1, a2;

    if (isA1Random && isA2Random) {
      let a1Pool = poolBase.filter(id => !usedActions.has(id));
      if (a1Pool.length < 2) a1Pool = poolBase;
      a1 = a1Pool[Math.floor(Math.random() * a1Pool.length)];
      usedActions.add(a1);

      let a2Pool = poolBase.filter(id => id !== a1 && !usedActions.has(id));
      if (a2Pool.length === 0) a2Pool = poolBase.filter(id => id !== a1);
      a2 = a2Pool[Math.floor(Math.random() * a2Pool.length)] || a1;
      usedActions.add(a2);
    } else if (isA1Random) {
      a2 = normTaskAction(action2, 'pose');
      let a1Pool = poolBase.filter(id => id !== a2 && !usedActions.has(id));
      if (a1Pool.length === 0) a1Pool = poolBase.filter(id => id !== a2);
      a1 = a1Pool[Math.floor(Math.random() * a1Pool.length)] || 'walk';
      usedActions.add(a1);
    } else {
      a1 = normTaskAction(action1, 'walk');
      let a2Pool = poolBase.filter(id => id !== a1 && !usedActions.has(id));
      if (a2Pool.length === 0) a2Pool = poolBase.filter(id => id !== a1);
      a2 = a2Pool[Math.floor(Math.random() * a2Pool.length)] || 'pose';
      usedActions.add(a2);
    }

    results.push({ action1: a1, action2: a2 });
  }

  return results;
}

module.exports = { computeTaskPrompts, resolveActions, resolveBatchActions };
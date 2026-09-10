const { SCENES } = require("../prompt-catalog/scenes");
const { MODEL_STYLES } = require("../prompt-catalog/modelStyles");
const { H3_ACTION_IDS, normTaskAction } = require("../prompt-catalog/h3Actions");
const { styledSubject } = require("./styledSubject");
const { h3SegPrompt } = require("./h3SegPrompt");
const { stripTextboxNoise } = require("./textbox");
const { GARMENT_PRESERVE_LIST, GARMENT_COMBINE } = require("./lookbookSections");
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

  const kidPose = 'a relaxed, natural stance with cute natural kidswear proportions, charming balanced posture, playful and unposed';
  const poseForAge = (base) => (model_age === 'toddler' || model_age === 'child') ? kidPose : base;

  if (model_image) {
    const customEnvPreposition = /^(in|on|at|against|under|near|along)\s+/i.test(cleanCustomScene) ? '' : 'in ';
    const normalizedScene = cleanCustomScene.replace(/^(In|On|At|Against|Under|Near|Along)\b/, (m) => m.toLowerCase());
    const sceneEnv = (sceneConfig.id === 'custom' && cleanCustomScene)
      ? `${customEnvPreposition}${normalizedScene}, realistic lighting consistent with the environment`
      : (sceneConfig.sceneEnvironment || 'in an aesthetic fashion lookbook background, natural commercial lighting');
    const modelGenderLabel = isM ? 'male model' : 'female model';
    kreaPrompt = [
      'Reference images: image 1 is the garment only — ignore any person, mannequin, hanger, background, or lighting shown in it. Image 2 is the model whose identity must be preserved.',
      `Task: transfer the clothing from image 1 onto the ${modelGenderLabel} from image 2. Change only the clothing.`,
      'Preserve from image 2: exact facial features and facial identity, eye and nose shape, hairstyle, skin tone, body proportions, and apparent age.',
      `Preserve from image 1: ${GARMENT_PRESERVE_LIST} ${GARMENT_COMBINE}`,
      `Scene & pose: standing ${sceneEnv}, full body visible head-to-toe with complete footwear and realistic soft ground contact shadows beneath footwear, facing forward toward the camera in a front or flattering three-quarter front view with front of the outfit and full face clearly visible, never back turned to camera, ${poseForAge('arms resting naturally at the sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers, subtle natural weight shift')}. Soft direct eye contact with a warm genuine presence, serene composed expression, naturally closed lips without tension, relaxed natural jawline.`,
      'Light & color: realistic lighting consistent with the environment. Keep garment, skin, and background colors faithful; no heavy yellow or orange cast.',
      'Style: photorealistic real photograph, honest and unposed, with real skin texture, visible pores, and natural color. No glamorization, no heavy retouching. Shot like a film photograph with subtle organic film grain.',
      `Constraints: strictly no back views, never back turned to camera, no facing away from camera; no text, no watermarks, no logos; props stay small and secondary if present.${cleanCustom ? ` Additional user requirements (follow only where they do not conflict with the constraints above): ${cleanCustom}` : ''}`
    ].join('\n');
  } else if (scene_image) {
    const subj = styledSubject(gender, modelStyleKey, 'stylish female model', 'stylish male model', cleanCustomModelStyle, hair_style, face_shape, model_age);
    kreaPrompt = [
      'Reference images: image 1 is the background environment only — ignore any people, mannequins, or text shown in it. Image 2 is the garment only — ignore any person, mannequin, or background shown in it.',
      `Task: create a photorealistic editorial lookbook photograph of a ${subj} wearing the garment from image 2, placed in the environment from image 1. Change only the clothing and the surrounding placement.`,
      `Preserve from image 2: ${GARMENT_PRESERVE_LIST} ${GARMENT_COMBINE}`,
      `Scene & pose: standing full-length on natural ground with realistic soft ground contact shadows beneath footwear, facing forward toward the camera in a front or flattering three-quarter front view with front of the outfit and full face clearly visible, never back turned to camera, ${poseForAge('arms resting naturally at the sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers, subtle natural weight shift')}. Soft direct eye contact with a warm genuine presence, face angle natural and alive. Serene composed expression, naturally closed lips without tension, relaxed natural jawline.`,
      'Light & color: realistic illumination matched to the background environment. Keep garment, skin, and background colors faithful; no heavy yellow or orange cast.',
      'Style: photorealistic real photograph, honest and unposed, with real skin texture, visible pores, and natural color. No glamorization, no heavy retouching. Shot like a film photograph with subtle organic film grain.',
      `Constraints: strictly no back views, never back turned to camera, no facing away from camera; no text, no watermarks, no logos; props stay small and secondary if present.${cleanCustom ? ` Additional user requirements (follow only where they do not conflict with the constraints above): ${cleanCustom}` : ''}`
    ].join('\n');
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

// 道具注入（A2 修复）：道具动作与"双臂自然垂放、双手放松"的基础姿态句硬冲突，
// 注入道具时必须同步替换该姿态句。ARM_PHRASE 同时匹配场景层（大写 Both arms）
// 与分支层（小写 arms）两种措辞。
const ARM_PHRASE = /(?:Both )?[Aa]rms resting naturally at (?:the )?sides?(?: with subtle organic elbow curvature)?,?\s*[Hh]ands relaxed and fully visible with five natural fingers/;

const PROP_POSE = {
  coffee_sip: 'one arm bent naturally holding a sleek takeaway coffee cup at waist height, the other arm relaxed at the side, both hands relaxed and fully visible with five natural fingers',
  phone_check: 'both hands holding a sleek modern smartphone at chest height with the arms bent naturally, fingers relaxed and fully visible with five natural fingers',
  bag_shift: 'a stylish chic leather shoulder bag worn over one shoulder with one hand resting lightly on the strap, hands relaxed and fully visible with five natural fingers'
};

// 双道具/三道具组合不能由单道具句拼接（会互相矛盾），逐组合预写：
const PROP_COMBOS = {
  'coffee_sip+phone_check': 'one hand holding a sleek takeaway coffee cup at waist height while the other hand holds a sleek modern smartphone at chest height, both arms bent naturally, fingers relaxed and fully visible with five natural fingers',
  'coffee_sip+bag_shift': 'one hand holding a sleek takeaway coffee cup at waist height, a stylish chic leather shoulder bag worn over the other shoulder with its strap resting naturally, hands relaxed and fully visible with five natural fingers',
  'phone_check+bag_shift': 'both hands holding a sleek modern smartphone at chest height, a stylish chic leather shoulder bag worn over one shoulder, fingers relaxed and fully visible with five natural fingers',
  'coffee_sip+phone_check+bag_shift': 'one hand holding a sleek takeaway coffee cup at waist height while the other hand holds a sleek modern smartphone at chest height, a stylish chic leather shoulder bag worn over one shoulder, fingers relaxed and fully visible with five natural fingers'
};

// 环境物依赖：这些动作的节拍需要场景中存在对应物件。物件必须进入定妆照
// （= 视频首帧），H3 才不会让它们在视频中凭空出现。
const ENV_PROPS = ['bench_sit', 'window_browse'];
const SCENE_PROPS = {
  bench_sit: 'A simple wooden bench at sitting height stands naturally beside the model in the scene, positioned clear of the figure and fully visible.',
  window_browse: 'A large glass display window with tastefully arranged items stands beside the model in the scene.'
};

function injectActionProps(promptText, a1, a2) {
  const used = ['coffee_sip', 'phone_check', 'bag_shift'].filter(a => a1 === a || a2 === a);
  let out = promptText;

  // 1) 手持道具：替换中性臂句（道具动作与"双臂垂放"硬冲突）
  const held = used.filter(a => PROP_POSE[a]);
  if (held.length) {
    const propText = PROP_COMBOS[held.join('+')] || PROP_POSE[held[0]];
    if (ARM_PHRASE.test(out)) {
      out = out.replace(ARM_PHRASE, propText);
    } else {
      out = out + ', ' + propText;
    }
  }

  // 2) 环境物：长椅/橱窗等动作依赖的场景物件，必须出现在定妆照（首帧）里，
  //    否则 H3 会在视频中凭空变出长椅——"长椅突兀出现"问题的根源。
  const env = ENV_PROPS.filter(a => a1 === a || a2 === a)
    .map(a => SCENE_PROPS[a])
    .join(' ');
  if (env) {
    if (/props stay small and secondary if present/i.test(out)) {
      out = out.replace(/props stay small and secondary if present/i,
        `${env} Props stay small and secondary if present.`);
    } else {
      out = out + ' ' + env;
    }
  }
  return out;
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
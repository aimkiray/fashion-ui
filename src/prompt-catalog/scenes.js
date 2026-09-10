const { styledSubject } = require("../prompts/styledSubject");
const { buildLookbookPrompt } = require("../prompts/lookbookSections");
const { buildCompositionInstructions } = require("../prompts/composition");

// Each scene provides its flavor strings; the shared builder assembles the
// labeled sections recommended by the official image-prompting guide.
// Kid (toddler/child) pose handling is centralized in the builder via ageKey,
// so every scene gets kid-appropriate proportions without per-scene patches.
const SCENES = {
  street: {
    id: 'street',
    name: '阳光都市街拍',
    enName: 'Sunny Streetwear Chic',
    icon: 'buildings',
    description: '阳光洒落的都市街头，自然光影景深，亲密POV眼神交流与潮流编辑感姿势',
    sceneEnvironment: 'on a sunlit city street sidewalk with historic brownstone buildings, natural directional sunlight casting soft ground shadows',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic', customStylePrompt = '', hairKey = 'natural', faceKey = 'oval', ageKey = 'adult') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'stylish East Asian female editorial model', 'stylish East Asian male editorial model', customStylePrompt, hairKey, faceKey, ageKey);
      const pro = isM ? 'he' : 'she';
      const composition = buildCompositionInstructions(`street:${gender}:${style}:${hairKey}:${faceKey}:${ageKey}`).text;
      return {
        krea_prompt: buildLookbookPrompt({
          subj,
          pro,
          ageKey,
          composition,
          scene: 'a sunlit city street sidewalk with historic brownstone buildings',
          pose: 'Relaxed editorial stance facing forward toward the camera, subtle natural weight shift to one hip, shoulders soft and open, front of the outfit and full face clearly visible to the viewer, waistline and long legs forming gentle lines, posture relaxed but intentional. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers.',
          gaze: 'Direct eye contact with the viewer, head in a gentle three-quarter turn, gaze connecting naturally.',
          light: 'Clean directional sunlight from camera left casting soft realistic ground shadows, neutral-to-warm daylight, brick and pavement colors remaining faithful.',
          lens: '35mm lens, f/2.8',
          extra: custom
        })
      };
    }
  },
  studio: {
    id: 'studio',
    name: '极简纯色影棚',
    enName: 'Minimalist Lookbook Studio',
    icon: 'camera',
    description: '纯色摄影棚无影墙，高端柔光箱打光，突出眼神交流与姿态几何',
    sceneEnvironment: 'in a clean minimalist studio against a neutral grey cyclorama backdrop, diffuse softbox studio lighting',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic', customStylePrompt = '', hairKey = 'natural', faceKey = 'oval', ageKey = 'adult') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'professional East Asian female model', 'professional East Asian male model', customStylePrompt, hairKey, faceKey, ageKey);
      const pro = isM ? 'he' : 'she';
      const composition = buildCompositionInstructions(`studio:${gender}:${style}:${hairKey}:${faceKey}:${ageKey}`).text;
      return {
        krea_prompt: buildLookbookPrompt({
          subj,
          pro,
          ageKey,
          composition,
          scene: 'a clean minimalist studio against a neutral grey cyclorama backdrop',
          pose: 'Elegant upright posture facing forward in a clean three-quarter front angle toward the camera, shoulders soft and open, front of the outfit and full face clearly visible to the viewer, waistline forming gentle lines, posture relaxed but intentional. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers.',
          gaze: 'Direct eye contact with the viewer, slightly lowered chin with eyes lifted toward the lens, a quiet intimate gaze.',
          light: 'Diffuse softbox studio lighting with soft shadow falloff, grey backdrop remaining faithful.',
          lens: '50mm lens',
          extra: custom
        })
      };
    }
  },
  office: {
    id: 'office',
    name: '摩天楼职场通勤',
    enName: 'Executive Urban Commuter',
    icon: 'building',
    description: '现代玻璃幕墙大厦大堂，晨光透射，干练优雅的商务编辑感',
    sceneEnvironment: 'in the quiet morning lobby of a modern glass corporate skyscraper with a low reception counter and a few potted plants, polished granite floors with subtle realistic reflections, soft daylight through the tall glass curtain wall',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic', customStylePrompt = '', hairKey = 'natural', faceKey = 'oval', ageKey = 'adult') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'chic East Asian professional female model', 'chic East Asian professional male model', customStylePrompt, hairKey, faceKey, ageKey);
      const pro = isM ? 'he' : 'she';
      const composition = buildCompositionInstructions(`office:${gender}:${style}:${hairKey}:${faceKey}:${ageKey}`).text;
      return {
        krea_prompt: buildLookbookPrompt({
          subj,
          pro,
          ageKey,
          composition,
          scene: 'the quiet morning lobby of a modern glass corporate skyscraper with polished granite floors',
          pose: 'Composed executive stance facing forward toward the camera, posture relaxed but intentional, shoulders soft and open, front of the outfit and full face clearly visible to the viewer, waistline visible beneath tailored garments, long legs forming clean lines. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers.',
          gaze: 'Calm three-quarter front eye contact with confident professional warmth, head turned just enough to show the jawline.',
          light: 'Soft diffuse morning daylight through the tall glass curtain wall, granite and glass tones staying faithful.',
          lens: '35mm lens',
          extra: custom
        })
      };
    }
  },
  boutique: {
    id: 'boutique',
    name: '高端艺术买手店',
    enName: 'Luxury Concept Boutique',
    icon: 'storefront',
    description: '奢华大理石与柔光射灯的高端专柜，突出女性气质与眼神光',
    sceneEnvironment: 'in a luxury designer concept boutique with polished Italian marble floors and minimalist brass fixtures, warm 3200K architectural recessed spotlights',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic', customStylePrompt = '', hairKey = 'natural', faceKey = 'oval', ageKey = 'adult') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'graceful East Asian female fashion model', 'graceful East Asian male fashion model', customStylePrompt, hairKey, faceKey, ageKey);
      const pro = isM ? 'he' : 'she';
      const composition = buildCompositionInstructions(`boutique:${gender}:${style}:${hairKey}:${faceKey}:${ageKey}`).text;
      return {
        krea_prompt: buildLookbookPrompt({
          subj,
          pro,
          ageKey,
          composition,
          scene: 'a luxury designer concept boutique with polished Italian marble floors and minimalist brass fixtures',
          pose: 'Graceful weight on one leg facing forward toward the camera, torso softly angled in a front-facing posture, shoulders and waistline forming refined elegant lines, front of the outfit and full face clearly visible to the viewer, posture relaxed but intentional. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers.',
          gaze: 'Gaze meeting the camera levelly with warm spotlight catchlights in the eyes, composed direct eye contact with the viewer.',
          light: 'Warm but color-neutral retail spotlights with soft falloff, marble and brass tones staying faithful.',
          lens: '35mm lens',
          extra: custom
        })
      };
    }
  },
  outdoor: {
    id: 'outdoor',
    name: '自然户外林荫',
    enName: 'Nature Sunlight & Garden',
    icon: 'leaf',
    description: '绿意盎然的公园石板路与林荫微风，柔和眼神回眸与浪漫编辑感',
    sceneEnvironment: 'on a quiet tree-lined park path with uneven weathered stone pavers, mature green trees and low hedges, scattered fallen leaves, soft diffused daylight through the leaves with gentle natural shadow patches',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic', customStylePrompt = '', hairKey = 'natural', faceKey = 'oval', ageKey = 'adult') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'natural East Asian female model', 'natural East Asian male model', customStylePrompt, hairKey, faceKey, ageKey);
      const pro = isM ? 'he' : 'she';
      const composition = buildCompositionInstructions(`outdoor:${gender}:${style}:${hairKey}:${faceKey}:${ageKey}`).text;
      return {
        krea_prompt: buildLookbookPrompt({
          subj,
          pro,
          ageKey,
          composition,
          scene: 'a quiet tree-lined park path with uneven weathered stone pavers, mature green foliage and low hedges, a few scattered fallen leaves on the ground',
          pose: 'Peaceful relaxed stance facing forward toward the camera beside natural park greenery, posture fluid and natural, shoulders soft and open, front of the outfit and full face clearly visible to the viewer, waistline visible, long legs forming gentle lines. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers.',
          gaze: 'Gentle three-quarter front eye contact with the viewer, face turned toward the camera, warm engaging gaze, face angle natural and alive.',
          light: 'Soft mid-morning daylight filtered through the tree canopy, dappled shadow patches on the path, neutral white balance with a slight green bounce from the foliage.',
          lens: '35mm lens',
          extra: custom
        })
      };
    }
  },
  cafe: {
    id: 'cafe',
    name: '现代极简咖啡厅',
    enName: 'Lifestyle Nordic Cafe',
    icon: 'coffee',
    description: '落地窗暖调咖啡馆，慵懒而亲密的生活编辑感',
    sceneEnvironment: 'in a cozy modern cafe with warm timber oak interiors, a few simple wooden tables and chairs, and large floor-to-ceiling windows, soft natural daylight through the windows',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic', customStylePrompt = '', hairKey = 'natural', faceKey = 'oval', ageKey = 'adult') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'stylish East Asian female model', 'stylish East Asian male model', customStylePrompt, hairKey, faceKey, ageKey);
      const pro = isM ? 'he' : 'she';
      const composition = buildCompositionInstructions(`cafe:${gender}:${style}:${hairKey}:${faceKey}:${ageKey}`).text;
      return {
        krea_prompt: buildLookbookPrompt({
          subj,
          pro,
          ageKey,
          composition,
          scene: 'a cozy modern cafe with warm timber oak interiors, simple wooden tables and chairs, and large floor-to-ceiling windows',
          pose: 'Casual editorial stance facing forward near the window, body language relaxed but intentional, shoulders soft and open, front of the outfit and full face clearly visible to the viewer, posture forming gentle lines. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers.',
          gaze: 'Chin softly lifted, head turned in a three-quarter front view toward the lens, warm approachable eye contact.',
          light: 'Warm natural window light with soft interior fill, warm oak and cream tones staying faithful.',
          lens: '35mm lens',
          extra: custom
        })
      };
    }
  },
  custom: {
    id: 'custom',
    name: '自定义专属场景',
    enName: 'Custom Dream Scene',
    icon: 'palette',
    description: '自由描述任意个性化展示背景（海滩落日、雪山木屋、赛博霓虹、古风江南等），保持眼神交流与真实皮肤质感',
    sceneEnvironment: 'in an aesthetic commercial fashion lookbook background, natural commercial lighting',
    buildPrompts: (gender = 'female', customPrompt = '', customScene = '', style = 'classic', customStylePrompt = '', hairKey = 'natural', faceKey = 'oval', ageKey = 'adult') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'stylish East Asian female editorial model', 'stylish East Asian male editorial model', customStylePrompt, hairKey, faceKey, ageKey);
      const pro = isM ? 'he' : 'she';
      const rawScene = (customScene && customScene.trim()) ? customScene.trim() : 'an aesthetic commercial fashion lookbook background';
      const sceneDesc = /^(in|on|at|against|under|near|along)\b/i.test(rawScene)
        ? rawScene.replace(/^(In|On|At|Against|Under|Near|Along)\b/, (m) => m.toLowerCase())
        : `in ${rawScene}`;
      const composition = buildCompositionInstructions(`custom:${gender}:${style}:${hairKey}:${faceKey}:${ageKey}`).text;
      return {
        krea_prompt: buildLookbookPrompt({
          subj,
          pro,
          ageKey,
          composition,
          scene: sceneDesc,
          pose: 'Elegant confident posture facing forward toward the camera, body language relaxed but intentional, shoulders soft and open, front of the outfit and full face clearly visible to the viewer, waistline visible, posture forming gentle lines. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers.',
          gaze: 'Soft direct eye contact with a warm genuine presence, face angle natural and alive.',
          light: 'Realistic natural lighting consistent with the environment.',
          lens: '35mm lens',
          extra: customPrompt
        })
      };
    }
  }
};

module.exports = { SCENES };

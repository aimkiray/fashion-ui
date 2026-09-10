const { styledSubject } = require("../prompts/styledSubject");

function adaptKidPosture(text, ageKey) {
  if (ageKey !== 'toddler' && ageKey !== 'child') return text;
  return text
    .replace(/waistline and long legs forming gentle lines/g, 'cute natural kidswear proportions, charming balanced stance')
    .replace(/waistline visible beneath tailored garments, long legs forming clean lines/g, 'charming neat kidswear proportions, cute natural posture')
    .replace(/waistline visible, long legs forming gentle lines/g, 'cute natural kidswear proportions, charming gentle posture')
    .replace(/Composed executive stance/g, 'Cheerful natural stance')
    .replace(/Relaxed editorial stance/g, 'Sweet natural child stance');
}

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
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: adaptKidPosture(`a ${subj} standing full-length on a sunlit city street sidewalk with historic brownstone buildings, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, if the reference garment is a separate top or bottom, naturally complementing it with a clean tailored matching piece; if the reference is a dress, jumpsuit or one-piece outfit, keeping it as one complete garment without splitting. ${pro} is the clear visual focus, with a soft intimate POV feeling. Direct eye contact with the viewer, head in a gentle three-quarter turn, gaze connecting naturally. Relaxed editorial stance, subtle natural weight shift to one hip, shoulders soft and open, waistline and long legs forming gentle lines, posture relaxed but intentional. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body editorial fashion lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on the concrete sidewalk with realistic soft ground contact shadows beneath footwear. Serene composed expression, naturally closed lips without tension, relaxed natural jawline. Clean directional sunlight casting soft realistic ground shadows, neutral-to-warm daylight, clothing colors staying true to the reference garment tones, brick and pavement colors remaining faithful, without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering on cheeks, natural catchlights in the eyes, tactile fabric weave and seam details. Props stay small and secondary if present. Shot on 35mm lens, f/2.8, subtle organic film grain, intimate POV with the viewer standing close${extra}`, ageKey)
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
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `a ${subj} standing full-length in a clean minimalist studio against a neutral grey cyclorama backdrop, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, if the reference garment is a separate top or bottom, naturally complementing it with a clean tailored matching piece; if the reference is a dress, jumpsuit or one-piece outfit, keeping it as one complete garment without splitting. ${pro} is the clear visual focus with a soft intimate POV feeling. Slightly lowered chin with eyes lifted toward the lens, a quiet intimate gaze. Elegant upright posture, body turned a quarter away from camera, shoulders soft and open, waistline forming gentle lines, posture relaxed but intentional. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body editorial catalogue lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on the matte studio floor with realistic soft ground contact shadows beneath footwear. Serene composed editorial expression, naturally closed lips without tension, relaxed natural jawline. Diffuse softbox studio lighting with soft shadow falloff, clean neutral-to-warm color balance, clothing colors staying true to the reference garment tones, grey backdrop remaining faithful, without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering on cheeks, natural catchlights in the eyes, tactile cloth texture and seam details. Props stay small and secondary if present. Shot on 50mm lens, subtle organic film grain, soft contact shadows, intimate POV with the viewer standing close${extra}`
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
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: adaptKidPosture(`a ${subj} standing full-length in the quiet morning lobby of a modern glass corporate skyscraper with a low reception counter nearby and polished granite floors, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, if the reference garment is a separate top or bottom, naturally complementing it with a clean tailored matching piece; if the reference is a dress, jumpsuit or one-piece outfit, keeping it as one complete garment without splitting. ${pro} is the clear visual focus with a soft intimate POV feeling. Calm three-quarter eye contact with confident professional warmth, head turned just enough to show the jawline. Composed executive stance, posture relaxed but intentional, shoulders soft and open, waistline visible beneath tailored garments, long legs forming clean lines. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body executive lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on the polished granite floor with realistic soft ground contact shadows beneath footwear and subtle diffuse ambient floor sheen. Naturally closed lips without tension, relaxed natural jawline. Soft diffuse morning daylight through the tall glass curtain wall, clean neutral-to-warm light, granite and glass tones staying faithful, clothing colors remaining true to tone, without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile leather grain and fabric drape. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain, intimate POV with the viewer standing close${extra}`, ageKey)
      };
    }
  },
  boutique: {
    id: 'boutique',
    name: '高端艺术买手店',
    enName: 'Luxury Concept Boutique',
    icon: 'storefront',
    description: '奢华大理石与柔光射灯的高端专柜，突出女性气质与眼神光',
    sceneEnvironment: 'in a luxury designer concept boutique with polished Italian marble floors and minimalist brass fixtures, warm but color-neutral retail spotlights',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic', customStylePrompt = '', hairKey = 'natural', faceKey = 'oval', ageKey = 'adult') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'graceful East Asian female fashion model', 'graceful East Asian male fashion model', customStylePrompt, hairKey, faceKey, ageKey);
      const pro = isM ? 'he' : 'she';
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `a ${subj} standing full-length in a luxury designer concept boutique with polished Italian marble floors and minimalist brass fixtures, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, if the reference garment is a separate top or bottom, naturally complementing it with a clean tailored matching piece; if the reference is a dress, jumpsuit or one-piece outfit, keeping it as one complete garment without splitting. ${pro} is the clear visual focus with a soft intimate POV feeling. Soft upward gaze catching warm spotlight reflections, composed direct eye contact with the viewer. Graceful weight on one leg, torso softly angled, shoulders and waistline forming refined elegant lines, posture relaxed but intentional. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body luxury retail lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on the polished marble floor with realistic soft ground contact shadows beneath footwear and subtle diffuse floor sheen. Serene composed expression, naturally closed lips without tension, relaxed natural jawline. Warm but color-neutral retail spotlights with soft falloff, clean neutral-to-warm color balance, marble and brass tones staying faithful, clothing colors remaining true to tone, without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile fabric weave and leather grain. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain, intimate POV with the viewer standing close${extra}`
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
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: adaptKidPosture(`a ${subj} standing full-length on a quiet tree-lined park path with uneven weathered stone pavers, mature green foliage and low hedges, a few scattered fallen leaves on the ground, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, if the reference garment is a separate top or bottom, naturally complementing it with a clean tailored matching piece; if the reference is a dress, jumpsuit or one-piece outfit, keeping it as one complete garment without splitting. ${pro} is the clear visual focus with a soft intimate POV feeling. A side-angle body with the gaze turned back over the shoulder toward the viewer, face angle varied and alive. Peaceful relaxed stance beside natural park greenery, posture fluid and natural, shoulders soft and open, waistline visible, long legs forming gentle lines. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body lifestyle lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on the stone pavers with realistic soft ground contact shadows beneath footwear. Serene gentle expression, naturally closed lips without tension, relaxed natural jawline. Soft diffused outdoor daylight filtering through the tree canopy, gentle organic shadow patches on the path, clean neutral-to-warm color balance, green foliage staying true to tone without oversaturation, worn stone colors remaining faithful, without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile cloth folds and texture. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain, intimate POV with the viewer standing close${extra}`, ageKey)
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
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `a ${subj} standing full-length in a cozy modern cafe with warm timber oak interiors, a few simple wooden tables and chairs, and large floor-to-ceiling windows, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, if the reference garment is a separate top or bottom, naturally complementing it with a clean tailored matching piece; if the reference is a dress, jumpsuit or one-piece outfit, keeping it as one complete garment without splitting. ${pro} is the clear visual focus with a soft intimate POV feeling. Chin softly lifted, head turned three-quarters toward the lens, warm approachable eye contact. Casual editorial stance near the window, body language relaxed but intentional, shoulders soft and open, posture forming gentle lines. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body cozy editorial lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on the hardwood floor with realistic soft ground contact shadows beneath footwear. Relaxed serene expression, naturally closed lips without tension, relaxed natural jawline. Warm natural window light with soft interior fill, clean neutral-to-warm color balance, warm oak and cream tones staying faithful, without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile knit and fabric weave. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain, intimate POV with the viewer standing close${extra}`
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
      const sceneDesc = /^(in|on|at|against|under|near|along)\s+/i.test(rawScene)
        ? rawScene
        : `in ${rawScene}`;
      const extra = customPrompt ? `, ${customPrompt}` : '';
      return {
        krea_prompt: `a ${subj} standing full-length ${sceneDesc}, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, if the reference garment is a separate top or bottom, naturally complementing it with a clean tailored matching piece; if the reference is a dress, jumpsuit or one-piece outfit, keeping it as one complete garment without splitting. ${pro} is the clear visual focus with a soft intimate POV feeling. Soft direct eye contact with a warm genuine presence, face angle natural and alive. Elegant confident posture, body language relaxed but intentional, shoulders soft and open, waistline visible, posture forming gentle lines. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body editorial lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on ground with realistic soft ground contact shadows beneath footwear. Serene composed expression, naturally closed lips without tension, relaxed natural jawline. Realistic natural lighting consistent with the environment, clean neutral-to-warm color balance, clothing and background colors remaining faithful without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile fabric weave and seam details. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain, intimate POV with the viewer standing close${extra}`
      };
    }
  }
};

module.exports = { SCENES };
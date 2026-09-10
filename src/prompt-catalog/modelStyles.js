
// Scene Presets
// Model style presets — 9 differentiated signatures (bone structure / skin / hair /
// gaze quality / posture). Gaze DIRECTION and face angle stay scene-specific;
// modifiers only carry gaze quality, never where the model looks.
const MODEL_STYLES = {
  classic: {
    name: '高级名模',
    female: 'with sculpted high-fashion supermodel presence, poised regal bearing, composed magnetic gaze, naturally closed lips without tension, and effortless commanding runway posture',
    male: 'with high-fashion supermodel charisma, composed magnetic gaze, naturally closed lips without tension, and commanding runway posture'
  },
  sweet: {
    name: '甜美清新',
    female: 'with sweet youthful charm, bright sparkling eyes full of gentle warmth, dewy fresh skin, naturally closed lips with a faint serene tenderness, and graceful airy posture',
    male: 'with clean boyish charm, soft warm eye expression, fresh dewy skin, naturally closed lips without tension, and light approachable posture'
  },
  athletic: {
    name: '运动活力',
    female: 'with healthy athletic vitality, sun-kissed glowing skin and toned posture, bright focused determined eyes, naturally closed lips with composed confidence, and grounded energetic stance',
    male: 'with athletic vigor, toned build and sun-kissed skin, sharp focused gaze, naturally closed lips without tension, and upright powerful stance'
  },
  mature: {
    name: '成熟御姐',
    female: 'with commanding mature elegance, knowing confident warmth in the eyes, luminous smooth skin, naturally closed lips with serene authority, and statuesque poised posture',
    male: 'with distinguished executive presence, calm assured gaze, naturally closed lips without tension, and commanding confident posture'
  },
  cool: {
    name: '中性酷感',
    female: 'with chic androgynous edge, sharp minimal attitude, cool detached yet engaged gaze, naturally closed lips without tension, and effortless nonchalant posture',
    male: 'with contemporary streetwear edge, understated cool attitude, naturally closed lips without tension, and relaxed confident posture'
  },
  youthful: {
    name: '元气阳光',
    female: 'with lively youthful energy, bright sparkling eyes radiating cheerful vitality, fresh glowing skin, naturally closed lips with a bright cheerful spirit, and light springy posture',
    male: 'with sunny youthful energy, bright lively eyes and fresh open expression, glowing healthy skin, naturally closed lips without tension, and light energetic posture'
  },
  intellectual: {
    name: '温柔知性',
    female: 'with gentle intellectual grace, serene thoughtful eyes carrying quiet depth, soft minimal styling, clean natural makeup look, naturally closed lips with calm composure, and understated elegant posture',
    male: 'with refined scholarly warmth, calm thoughtful gaze and gentle steady presence, clean minimal styling, naturally closed lips without tension, and composed graceful posture'
  },
  french: {
    name: '法式浪漫',
    female: 'with effortless Parisian chic, relaxed romantic air, naturally glowing minimal makeup, warm subtle gaze, naturally closed lips with serene charm, and breezy nonchalant elegance in posture',
    male: 'with relaxed Parisian elegance, easygoing romantic air, warm understated gaze, naturally closed lips without tension, and breezy confident posture'
  },
  retro: {
    name: '复古港风',
    female: 'with 1990s Hong Kong cinematic glamour, luminous warm skin, magnetic star-quality gaze, naturally closed lips with poised mystique, and iconic timeless posture',
    male: 'with 1990s Hong Kong cinematic charisma, luminous warm skin, magnetic film-star gaze, naturally closed lips without tension, and iconic screen-presence posture'
  },
  petite: {
    name: '小巧可爱',
    female: 'with petite adorable charm, small slim frame and fine-boned delicate figure, big bright expressive eyes, smooth dewy skin, naturally closed lips with playful cuteness, and cute perky posture',
    male: 'with cute boyish charm, small lean frame, bright lively eyes, fresh clear skin, naturally closed lips without tension, and playful relaxed posture'
  }
};


module.exports = { MODEL_STYLES };
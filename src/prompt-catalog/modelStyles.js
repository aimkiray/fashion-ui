
// Scene Presets
// Model style presets — 9 differentiated signatures (bone structure / skin / hair /
// gaze quality / posture). Gaze DIRECTION and face angle stay scene-specific;
// modifiers only carry gaze quality, never where the model looks.
const MODEL_STYLES = {
  classic: {
    name: '高级名模',
    female: 'with sculpted high-fashion supermodel presence, poised regal bearing, composed magnetic gaze, and effortless commanding runway posture',
    male: 'with high-fashion supermodel charisma, composed magnetic gaze, and commanding runway posture'
  },
  sweet: {
    name: '甜美清新',
    female: 'with sweet youthful charm, bright sparkling eyes full of gentle warmth, fresh natural skin, and graceful airy posture',
    male: 'with clean boyish charm, soft warm eye expression, fresh natural skin, and light approachable posture'
  },
  athletic: {
    name: '运动活力',
    female: 'with healthy athletic vitality, sun-kissed natural skin and toned posture, bright focused determined eyes, and grounded energetic stance',
    male: 'with athletic vigor, toned build and sun-kissed skin, sharp focused gaze, and upright powerful stance'
  },
  mature: {
    name: '成熟御姐',
    female: 'with commanding mature elegance, knowing confident warmth in the eyes, naturally textured skin, and statuesque poised posture',
    male: 'with distinguished executive presence, calm assured gaze, and commanding confident posture'
  },
  cool: {
    name: '中性酷感',
    female: 'with chic androgynous edge, sharp minimal attitude, cool detached yet engaged gaze, and effortless nonchalant posture',
    male: 'with contemporary streetwear edge, understated cool attitude, and relaxed confident posture'
  },
  youthful: {
    name: '元气阳光',
    female: 'with lively youthful energy, bright sparkling eyes radiating cheerful vitality, fresh glowing skin, and light springy posture',
    male: 'with sunny youthful energy, bright lively eyes and fresh open expression, healthy natural skin, and light energetic posture'
  },
  intellectual: {
    name: '温柔知性',
    female: 'with gentle intellectual grace, serene thoughtful eyes carrying quiet depth, soft minimal styling, clean natural makeup look, and understated elegant posture',
    male: 'with refined scholarly warmth, calm thoughtful gaze and gentle steady presence, clean minimal styling, and composed graceful posture'
  },
  french: {
    name: '法式浪漫',
    female: 'with effortless Parisian chic, relaxed romantic air, minimal natural makeup, warm subtle gaze, and breezy nonchalant elegance in posture',
    male: 'with relaxed Parisian elegance, easygoing romantic air, warm understated gaze, and breezy confident posture'
  },
  retro: {
    name: '复古港风',
    female: 'with 1990s Hong Kong cinematic glamour, luminous warm skin, magnetic star-quality gaze, and iconic timeless posture',
    male: 'with 1990s Hong Kong cinematic charisma, luminous warm skin, magnetic film-star gaze, and iconic screen-presence posture'
  },
  petite: {
    name: '小巧可爱',
    female: 'with petite adorable charm, small slim frame and fine-boned delicate figure, big bright expressive eyes, smooth natural skin, and cute perky posture',
    male: 'with cute boyish charm, small lean frame, bright lively eyes, fresh clear skin, and playful relaxed posture'
  }
};


module.exports = { MODEL_STYLES };
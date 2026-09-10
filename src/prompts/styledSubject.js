const { MODEL_STYLES } = require("../prompt-catalog/modelStyles");
const { HAIRSTYLES } = require("../prompt-catalog/hairstyles");
const { FACE_SHAPES } = require("../prompt-catalog/faceShapes");
const { MODEL_AGES } = require("../prompt-catalog/modelAges");

// Scene-specific subject base + gender-aware style modifier + independent age/hair/face dims.
function styledSubject(gender, style, femaleBase, maleBase, customStylePrompt = null, hairKey = 'natural', faceKey = 'oval', ageKey = 'adult') {
  const isM = gender === 'male';
  let base = isM ? maleBase : femaleBase;
  const g = isM ? 'male' : 'female';
  const face = (FACE_SHAPES[faceKey] || FACE_SHAPES.oval)[g];
  const hair = (HAIRSTYLES[hairKey] || HAIRSTYLES.natural)[g];
  const age = (MODEL_AGES[ageKey] || MODEL_AGES.adult || MODEL_AGES.prime)[g];

  const isKid = ageKey === 'toddler' || ageKey === 'child';
  if (isKid) {
    if (ageKey === 'toddler') {
      base = isM ? 'charming East Asian toddler boy model' : 'charming East Asian toddler girl model';
    } else {
      base = isM ? 'cheerful East Asian young boy model' : 'cheerful East Asian young girl model';
    }
  }

  if (customStylePrompt && typeof customStylePrompt === 'string' && customStylePrompt.trim()) {
    const trimmed = customStylePrompt.trim();
    const head = trimmed.startsWith(',') || trimmed.startsWith('with ') ? base + ' ' + trimmed : base + ', ' + trimmed;
    return head + ', ' + age + ', featuring ' + face + ', styled with ' + hair;
  }

  let modBody;
  if (isKid) {
    // E2: 年龄串已含 chubby cheeks/innocent eyes，这里不再重复堆叠 dewy/innocent
    modBody = isM
      ? 'sunny boyish charm, naturally closed lips with a faint happy smile, and playful balanced natural posture'
      : 'sweet cheerful charm, naturally closed lips with a soft happy smile, and playful balanced natural posture';
  } else {
    const s = MODEL_STYLES[style] || MODEL_STYLES.classic;
    const modifier = isM ? s.male : s.female;
    modBody = modifier.startsWith('with ') ? modifier.slice(5) : modifier;
    // E3: teen(14岁) 不应套用成人 runway/supermodel 修饰
    if (ageKey === 'teen') {
      modBody = modBody
        .replace(/sculpted high-fashion supermodel presence/gi, 'fresh expressive presence')
        .replace(/commanding runway posture/gi, 'natural upright posture')
        .replace(/runway posture/gi, 'natural posture');
    }
  }

  return base + ', ' + age + ', featuring ' + face + ', ' + modBody + ', styled with ' + hair;
}

module.exports = { styledSubject };
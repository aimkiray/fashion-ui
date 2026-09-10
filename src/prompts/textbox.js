
// Format multiline textbox input: strip list bullets at line starts only
// (keep hyphens inside words like "t-shirt"), collapse lines, block audio injection
// Noise words (photorealistic/stunning/8k...) are removed ONLY as standalone
// segments: mid-sentence extraction would shred the user's sentence
// ("she is stunning, flawless and radiant" -> "she is,  and").
// Leading quality-stack runs ("8k hyperrealistic portrait") are removed as a
// whole run so a normal trailing word survives.
const NOISE_WORDS = '8k resolution|8k|hyperrealistic|photorealistic|ultra sharp focus|ultra sharp|pristine|flawless|stunning|cinematic|glamorous|radiant|shimmering|over-sharpened|9:16|16:9|3:4|4:3|1:1';
const stripTextboxNoise = (raw) => (raw || '')
  .replace(/^[•·*\-]\s*/gm, '')
  .replace(/\baudio\s*:/gi, '')
  .replace(/露齿笑|露牙笑|露齿|大笑|狂笑|张嘴笑/g, '闭唇从容神采')
  .replace(/\b(toothy smile|open mouth|grinning|laughing|showing teeth)\b/gi, 'closed lips, serene expression')
  // leading quality-stack run at the very start of the text
  .replace(new RegExp(`^\\s*(?:${NOISE_WORDS})(?:\\s+(?:${NOISE_WORDS}))*(?=\\s|$)`, 'gim'), '')
  // standalone comma/line-separated segments anywhere else (E-1: no mid-sentence extraction)
  .replace(new RegExp(`(^|[，,]\\s*|\\n)\\s*(?:${NOISE_WORDS})\\s*(?=[，,]|\\n|$)`, 'gim'), '$1')
  .replace(/\r\n|\r|\n/g, ', ')
  .replace(/\s+/g, ' ')
  .replace(/[,，\s]+[,，]/g, ', ')
  .replace(/^[,，\s]+|[,，\s]+$/g, '')
  .trim();


module.exports = { stripTextboxNoise };

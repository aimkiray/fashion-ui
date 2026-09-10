
// Format multiline textbox input: strip list bullets at line starts only
// (keep hyphens inside words like "t-shirt"), collapse lines, block audio injection
const stripTextboxNoise = (raw) => (raw || '')
  .replace(/^[•·*\-]\s*/gm, '')
  .replace(/\baudio\s*:/gi, '')
  .replace(/露齿笑|露牙笑|露齿|大笑|狂笑|张嘴笑/g, '闭唇从容神采')
  .replace(/\b(toothy smile|open mouth|grinning|laughing|showing teeth)\b/gi, 'closed lips, serene expression')
  .replace(/\b(8k resolution|8k|hyperrealistic|photorealistic|ultra sharp focus|ultra sharp|pristine|flawless|stunning|cinematic|glamorous|radiant|shimmering|over-sharpened|9:16|16:9|3:4|4:3|1:1)\b/gi, '')
  .replace(/\r\n|\r|\n/g, ', ')
  .replace(/\s+/g, ' ')
  .replace(/[,，\s]+[,，]/g, ', ')
  .replace(/^[,，\s]+|[,，\s]+$/g, '')
  .trim();


module.exports = { stripTextboxNoise };
// Shared section scaffolding for the Stage-1 lookbook prompts, following the
// official OpenAI image-prompting guide: for complex requests organize the
// prompt as labeled sections (Scene / Subject / Outfit / Pose & gaze /
// Light & color / Style / Constraints), state "change only X" separately from
// the preservation list, and assign roles to reference images by number.

// Complete garment preservation list — anything not listed here is a dimension
// GPT Image may freely redesign during the outfit transfer.
const GARMENT_PRESERVE =
  'Preserve from the reference garment exactly: overall silhouette, garment length, neckline shape, sleeve length, fabric texture and weight, pattern and print placement, buttons, zippers and closures, and colors. Keep every hem and edge exactly where the reference garment has them.';

const GARMENT_COMBINE =
  'If the reference garment is a separate top or bottom, complete the look with one minimal tailored piece in the same palette; if it is a dress, jumpsuit or one-piece outfit, keep it as one garment without splitting it.';

// Canonical arm/hands sentence shared by every prompt so injectActionProps can
// swap it out when a prop action requires the hands to be occupied.
const ARMS_NEUTRAL =
  'Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers.';

function buildLookbookPrompt({ subj, pro, scene, pose, gaze, light, lens, ageKey, extra }) {
  const isKid = ageKey === 'toddler' || ageKey === 'child';
  const poseText = isKid
    ? 'A relaxed, natural stance with cute natural kidswear proportions, charming balanced posture, playful and unposed. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers.'
    : pose;
  const sections = [
    `Scene: ${scene}.`,
    `Subject: ${subj}. ${pro} stands full-length in frame — entire figure visible head-to-toe with complete footwear, camera at chest height and far enough back that nothing is cropped.`,
    `Outfit: change only the clothing. ${GARMENT_PRESERVE} ${GARMENT_COMBINE}`,
    `Pose & gaze: ${poseText} ${gaze}`,
    `Light & color: ${light} Keep garment, skin, and background colors faithful to the reference garment and the environment; no heavy yellow or orange cast.`,
    `Style: photorealistic real photograph, honest and unposed, with real skin texture, visible pores, and natural color. No glamorization, no heavy retouching. Shot like a film photograph with subtle organic film grain${lens ? `, ${lens}` : ''}.`,
    `Constraints: no text, no watermarks, no logos; props stay small and secondary if present.${extra ? ` Additional user requirements (follow only where they do not conflict with the constraints above): ${extra}` : ''}`
  ];
  return sections.join('\n');
}

module.exports = { GARMENT_PRESERVE, GARMENT_COMBINE, ARMS_NEUTRAL, buildLookbookPrompt };

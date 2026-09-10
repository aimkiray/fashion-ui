// Shared section scaffolding for the Stage-1 lookbook prompts, following the
// official OpenAI image-prompting guide: for complex requests organize the
// prompt as labeled sections (Scene / Subject / Outfit / Pose & gaze /
// Light & color / Style / Constraints), state "change only X" separately from
// the preservation list, and assign roles to reference images by number.

// The garment preservation list — anything not listed here is a dimension
// GPT Image may freely redesign during the outfit transfer.
const GARMENT_PRESERVE_LIST =
  'overall silhouette, garment length, neckline shape, sleeve length, fabric texture and weight, pattern and print placement, buttons, zippers and closures, and colors. Keep every hem and edge exactly where the reference garment has them.';

const GARMENT_PRESERVE = `Preserve from the reference garment exactly: ${GARMENT_PRESERVE_LIST}`;

const GARMENT_COMBINE =
  'If the reference garment is a separate top or bottom, complete the look with one minimal tailored piece in the same palette; if it is a dress, jumpsuit or one-piece outfit, keep it as one garment without splitting it.';

// Canonical arm/hands sentence shared by every prompt so injectActionProps can
// swap it out when a prop action requires the hands to be occupied.
const ARMS_NEUTRAL =
  'Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers.';

function buildLookbookPrompt({ subj, pro, scene, pose, gaze, light, lens, ageKey, extra, composition }) {
  const isKid = ageKey === 'toddler' || ageKey === 'child';
  const subject = pro.charAt(0).toUpperCase() + pro.slice(1);
  const poseText = isKid
    ? `A relaxed, natural stance facing forward toward the camera with cute natural kidswear proportions, charming balanced posture, playful and unposed. ${ARMS_NEUTRAL}`
    : pose;
  const sections = [
    `Scene: ${scene}.`,
    `Subject: ${subj}. ${subject} stands full-length in frame facing forward toward the camera — entire figure visible head-to-toe with complete footwear, front of the outfit and full face clearly visible to the viewer, camera at chest height relative to the subject and far enough back that nothing is cropped.`,
    `Composition: ${composition}`,
    `Outfit: change only the clothing. ${GARMENT_PRESERVE} ${GARMENT_COMBINE}`,
    `Pose & gaze: ${poseText} ${gaze} The model is facing the camera in a front or flattering three-quarter front view, never with the back turned to the camera.`,
    `Light & color: ${light} Keep garment, skin, and background colors faithful to the reference garment and the environment; no heavy yellow or orange cast.`,
    `Style: Photorealistic real photograph, honest and unposed, with real skin texture, visible pores, and natural color. No glamorization, no heavy retouching. Shot like a film photograph with subtle organic film grain${lens ? `, ${lens}` : ''}.`,
    `Constraints: Strictly no back views, never back turned to camera, no facing away from camera, front of the outfit and full face must be clearly visible; no text, no watermarks, no logos; props stay small and secondary if present.${extra ? ` Additional user requirements (follow only where they do not conflict with the constraints above): ${extra}` : ''}`
  ];
  return sections.join('\n');
}

module.exports = {
  GARMENT_PRESERVE,
  GARMENT_PRESERVE_LIST,
  GARMENT_COMBINE,
  ARMS_NEUTRAL,
  buildLookbookPrompt
};

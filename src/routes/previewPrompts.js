const express = require("express");
const router = express.Router();
const { computeTaskPrompts } = require("../prompts/computeTaskPrompts");
// Endpoint for frontend to preview authoritative underlying prompts for inspection and fine-tuning
router.post('/api/preview-prompts', (req, res) => {
  try {
    const {
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
    } = req.body || {};

    const prompts = computeTaskPrompts({
      scene,
      gender,
      model_style,
      model_style_prompt,
      custom_scene,
      custom_prompt,
      model_image,
      scene_image,
      action1,
      action2,
      hair_style,
      face_shape,
      model_age
    });

    res.json(prompts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
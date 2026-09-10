// 经典构图原理模块（定妆照与视频首帧共用）。
//
// 原理来源（大师总结的经典构图法则，适配全身时装展示）：
// 1. 三分法（Rule of Thirds）：人物纵向落在画面左/右三分线上，而非死点居中；
// 2. 视线高度线：眼睛/面部贴近上三分线，头顶留白（headroom）约 10% 画高；
// 3. 呼吸空间：脚下留 4-6% 地面，人物总高约占画高 82-88%，不顶满画幅；
// 4. 负空间平衡（Lead room）：人物偏置后，在另一侧留出呼吸空间平衡画面。
//
// 左右偏置由配置键的稳定散列决定：同一配置组合输出稳定（预览不抖动），
// 不同配置组合左右大致均匀分布（批量生成构图有变化）。

function hashKey(key) {
  let h = 0;
  const s = String(key || 'default');
  for (let i = 0; i < s.length; i++) {
    h = ((h * 31) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function buildCompositionInstructions(key) {
  const side = hashKey(key) % 2 === 0 ? 'left' : 'right';
  const open = side === 'left' ? 'right' : 'left';
  const text =
    `rule-of-thirds framing — offset the figure to the ${side} third of the frame ` +
    `instead of dead center, with the eyes close to the upper-third line; ` +
    `keep about 10% of the frame height of headroom above the hair and 4-6% of floor below the feet, ` +
    `so the figure spans roughly 82-88% of the frame height and never touches the frame edges; ` +
    `leave gentle negative space on the ${open} side of the frame to balance the pose.`;
  return { side, open, text };
}

module.exports = { buildCompositionInstructions };

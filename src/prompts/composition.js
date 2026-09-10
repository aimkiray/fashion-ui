// 构图方式模块（定妆照与视频首帧共用）。用户可选：
//   auto   三分法自动偏置（左右由配置键稳定散列决定，同配置恒定、不同配置均匀）
//   center 居中对称（时尚 lookbook 经典构图）
//   left   手动偏左三分
//   right  手动偏右三分
//
// 原理来源（经典构图法则，适配全身时装展示）：
// 1. 三分法（Rule of Thirds）/ 中轴对称（Symmetry）：二选一，不混用；
// 2. 头顶留白（headroom）约 10% 画高，人物总高约占画高 82-88%，不顶满画幅；
// 3. 负空间平衡（Lead room / negative space）。
//
// auto 模式的左右偏置由配置键（场景:性别）的稳定散列决定：同场景同性别恒定
// 同侧（三种参考图模式间也一致），不同场景/性别之间左右大致均匀（实测 50/50）。

function hashKey(key) {
  let h = 0;
  const s = String(key || 'default');
  for (let i = 0; i < s.length; i++) {
    h = ((h * 31) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

const COMPOSITION_MODES = ['auto', 'center', 'left', 'right'];

function buildCompositionInstructions(key, mode = 'auto') {
  const m = COMPOSITION_MODES.includes(mode) ? mode : 'auto';

  if (m === 'center') {
    return {
      mode: 'center', side: null, open: null,
      text:
        'centered symmetrical composition — place the figure on the vertical center axis of the frame, ' +
        'with equal margins on the left and right sides; ' +
        'keep about 10% of the frame height of headroom above the hair and 4-6% of floor below the feet, ' +
        'so the figure spans roughly 82-88% of the frame height and never touches the frame edges; ' +
        'keep the pose symmetrical and balanced.'
    };
  }

  const side = (m === 'left' || m === 'right') ? m : (hashKey(key) % 2 === 0 ? 'left' : 'right');
  const open = side === 'left' ? 'right' : 'left';
  const text =
    `rule-of-thirds framing — place the figure's central axis on the ${side} third line ` +
    `of the frame (about one third of the frame width in from the ${side} edge) instead of dead center; ` +
    `keep about 10% of the frame height of headroom above the hair and 4-6% of floor below the feet, ` +
    `so the figure spans roughly 82-88% of the frame height and never touches the frame edges ` +
    `(the head sits within the upper third of the frame); ` +
    `leave gentle negative space on the ${open} side of the frame to balance the pose.`;
  return { mode: m, side, open, text };
}

module.exports = { buildCompositionInstructions, COMPOSITION_MODES };

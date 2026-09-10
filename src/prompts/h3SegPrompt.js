const { H3_SCENE_CFG } = require("../prompt-catalog/h3SceneCfg");
const { H3_ACTIONS } = require("../prompt-catalog/h3Actions");
// 按【最高优先级】→【5秒核心动作】→【表情与眼神】→【真实人体动态】
// →【服装与手部】→【镜头】→【画面质感】→【严格去除AI味】→【最终效果】→【音频】
// 组装单个分镜提示词；她/他按性别替换；分镜二自动加承接句。
function h3SegPrompt(sceneId, actionId, seg, isM, extra = '', prevActionId = null) {
  const cfg = H3_SCENE_CFG[sceneId] || H3_SCENE_CFG.custom;
  const act = H3_ACTIONS[actionId] || H3_ACTIONS.walk;
  const pro = isM ? '他' : '她';
  const segTitle = seg === 1 ? '分镜一' : '分镜二';

  let opener = '';
  if (seg === 2) {
    if (prevActionId === 'coffee_sip' && actionId !== 'coffee_sip') {
      opener = '承接上一镜的动作与站位，上一镜手持的外带咖啡杯自然移出特写画幅或置于身侧，画面保持平滑连续。\n\n';
    } else if (prevActionId === 'phone_check' && actionId !== 'phone_check') {
      opener = '承接上一镜的动作与站位，上一镜查看的手机已自然收纳，画面保持平滑连续。\n\n';
    } else if (prevActionId === 'bag_shift' && actionId !== 'bag_shift') {
      opener = '承接上一镜的动作与站位，肩上的挎包/单肩包保持自然佩戴，画面保持平滑连续。\n\n';
    } else {
      opener = '承接上一镜的动作与站位，画面保持连续。\n\n';
    }
  }

  const beats = opener + act.beats.split('她').join(pro);
  const eye = act.eye.split('她').join(pro);
  const camera = act.camera.split('她').join(pro);
  const recap = act.recap.split('她').join(pro);
  const audio = `${cfg.ambience}，${act.sound}。`;

  // coffee_sip 需要啜饮动作，与无条件的「全程闭唇」直接矛盾——按动作放宽
  const lipRule = actionId === 'coffee_sip'
    ? '模特唇部自然放松，轻抿咖啡时自然启唇啜饮，其余时间自然闭唇，不要露齿笑。'
    : '模特全程自然闭唇、嘴角放松，不要张嘴，不要露齿笑。';

  let handGuidance = '双手自然舒展放松，处于视野内的手部五指健全自然微屈，指节分明无粘连穿模，不盲目插兜握拳。';
  if (actionId === 'pocket_stand') {
    // 与 beats 的条件式一致：服装可能没有口袋，手部动作跟随首帧实际服装
    handGuidance = '若服装有口袋：单手顺应口袋自然插袋，严禁穿模畸变；若无口袋：单手自然轻扶在大腿侧，不凭空捏出衣袋。另一只手在身侧放松微垂，五指自然微屈无多指。';
  } else if (['coffee_sip', 'phone_check', 'bag_shift'].includes(actionId)) {
    handGuidance = '手部动作自然协调，与道具或包带握持接触真实无穿模粘连，指节自然舒展微屈，五指正常无多指。';
  } else if (['hair_tuck', 'jacket_adjust'].includes(actionId)) {
    handGuidance = '手部指尖动作利落连贯，以真实的日常速度执行，指节自然修长微屈无粘连穿模，五指正常无多指。';
  }

  let p = `生成一段5秒、真人写实、自然生活感时尚短视频，适用于 Minimax H3 首帧续写。${cfg.title}·${segTitle}·${act.name}。

【最高优先级】
严格保持首帧画面中模特的人脸、五官、发型、妆容、肤色、身材比例、${cfg.lock}不变。
不要换脸，不要改变人物造型，不要改变服装款式与配色，不要改变场景。
整段视频必须像真实${cfg.shot}记录下的一段生活瞬间：
自然、松弛、有编辑感、有生命感。
不要刻意表演，不要短视频模板感，严格去掉AI味。

━━━━━━━━━━━━━━━━━━
【5秒核心动作】
${beats}

━━━━━━━━━━━━━━━━━━
【表情与眼神｜必须执行】
眼神变化遵循真实顺序：
与镜头对视时，眼神先有细微的亮意，
→ 面部肌肉保持放松，
→ 形成从容、明亮、亲切的神态。
${eye}
允许自然眨眼1次左右，
允许自然的眼球移动和呼吸感。
这些真实的不完美要保留。

禁止：
假表情、
僵硬脸、
突然咧嘴、
过度露齿、
空洞眼神、
夸张眯眼、
标准网红笑。
${lipRule}

━━━━━━━━━━━━━━━━━━
【真实人体动态｜核心要求】
整个5秒必须充满真实的生命感，动作节奏轻快利落，像真实时尚街拍抓拍的瞬间：
自然呼吸与清晰的肩胸起伏，发丝与衣摆随动作呈现自然物理惯性与真实分缕飘动（natural hair locks and distinct strand clumping）；
手部动作以真实的日常速度执行，绝不拖沓放慢；
所有动作连贯有惯性、有真实的力度变化。
杜绝慢动作感，杜绝匀速机械运动，杜绝无过渡的机械式骤停骤起（利落收步≠骤停）。
注意：镜头稳定缓慢与人物动作轻快是两回事，镜头匀速不等于动作缓慢。

━━━━━━━━━━━━━━━━━━
【服装与手部】
服装锁定见最高优先级；本段关注动态稳定性：衣物上已存在的结构（衣摆、下摆、袖口（如有）、缝线）全程稳定。
服装件数与首帧完全一致：全程只穿着首帧中已有的衣物，严禁凭空新增外套、披肩、围巾、帽子等任何衣物层，也不允许任何衣物消失。
面料随动作有符合物理规律的自然摆动和惯性。
禁止：服装变形、纹理跳动、凭空出现的拖尾或裙摆、衣服颜色变化。
${handGuidance}

━━━━━━━━━━━━━━━━━━
【镜头与运镜控制｜核心铁律】
${camera}

运镜速度与距离控制准则：全程保持恒定展示视距，运镜平稳流畅，严禁快速推近、变焦冲镜与镜头拖拽（Strictly No Fast Push-in / No Crash Zoom）。镜头追求稳，人物动作追求轻快——两者解耦，不得因镜头克制而放慢人物动作。
构图沿用首帧的三分法布局：人物保持在画面同一侧的三分之一区域，头顶留白与地面留白全程保持，不要让人物居中顶满画面（环绕/弧形运镜期间允许人物随视差短暂偏移，运镜结束后回到原有三分之一区域）。

━━━━━━━━━━━━━━━━━━
【画面质感】
保持首帧真实自然的光线与色调。
发质与皮肤保留真实物理质感：
发丝分缕清晰自然，根根分明有层次感（distinct individual strands with defined clumping），
发丝受光面有自然柔和的真实高光反光（natural specular hair sheen），
细微毛孔，
真实肤质，
柔和面部高光，
眼睛真实反光，
真实发丝边缘。
不要过度磨皮，不要塑料假发感，不要塑料皮肤，不要蜡像脸，不要过度锐化，不要假白，不要HDR感过重。

━━━━━━━━━━━━━━━━━━
【严格去除AI味】
禁止出现：换脸、五官漂移、发型变化、手指畸形、多指、肢体扭曲、
发丝边缘模糊、长发飘动拖影、发丝与背景溶化涂抹（no blurry hair edges, no hair smearing into background, no misty translucent hair）、
凭空出现或消失衣物层（外套/披肩/围巾/帽子）、服装变形或凭空变化、背景物体闪烁、焦点乱跳、
运镜突进、机械匀速动作、慢动作感、商业广告式表演、明显AI生成痕迹。
同时必须：每一步有真实的落地与地面接触，脚步位移与身体移动严格匹配。

━━━━━━━━━━━━━━━━━━
【最终效果】
${recap}

━━━━━━━━━━━━━━━━━━
【音频】
${audio}`;
  if (extra) p += `\n\n━━━━━━━━━━━━━━━━━━\n【补充要求】\n${extra}`;
  return p;
}


module.exports = { h3SegPrompt };
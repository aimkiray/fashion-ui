const { test } = require('node:test');
const assert = require('node:assert');
const { computeTaskPrompts } = require('../../src/prompts/computeTaskPrompts');
const { styledSubject } = require('../../src/prompts/styledSubject');
const { stripTextboxNoise } = require('../../src/prompts/textbox');
const { h3SegPrompt } = require('../../src/prompts/h3SegPrompt');
const { normTaskAction, H3_ACTIONS, H3_ACTION_IDS } = require('../../src/prompt-catalog/h3Actions');
const { SCENES } = require('../../src/prompt-catalog/scenes');
const { MODEL_STYLES } = require('../../src/prompt-catalog/modelStyles');
const { MODEL_AGES } = require('../../src/prompt-catalog/modelAges');
const { HAIRSTYLES } = require('../../src/prompt-catalog/hairstyles');
const { FACE_SHAPES } = require('../../src/prompt-catalog/faceShapes');

test('computeTaskPrompts returns all three prompts with fixed actions', () => {
  const out = computeTaskPrompts({
    scene: 'street',
    gender: 'female',
    model_style: 'classic',
    action1: 'walk',
    action2: 'pose'
  });
  assert.equal(typeof out.krea_prompt, 'string');
  assert.ok(out.krea_prompt.length > 200);
  assert.equal(typeof out.seg1_prompt, 'string');
  assert.equal(typeof out.seg2_prompt, 'string');
  assert.deepEqual(out.actions, { seg1: 'walk', seg2: 'pose' });
  // 分镜一不含承接句，分镜二必须含
  assert.ok(!out.seg1_prompt.includes('承接上一镜'));
  assert.ok(out.seg2_prompt.includes('承接上一镜'));
});

test('computeTaskPrompts is deterministic with fixed inputs (no random draw)', () => {
  const args = { scene: 'cafe', gender: 'male', action1: 'sidestep', action2: 'turnshow' };
  const a = computeTaskPrompts(args);
  const b = computeTaskPrompts(args);
  assert.equal(a.krea_prompt, b.krea_prompt);
  assert.equal(a.seg1_prompt, b.seg1_prompt);
  assert.equal(a.seg2_prompt, b.seg2_prompt);
});

test('random actions always resolve to known action ids and differ, including single-sided random', () => {
  for (let i = 0; i < 100; i++) {
    const outBoth = computeTaskPrompts({});
    assert.ok(H3_ACTIONS[outBoth.actions.seg1]);
    assert.ok(H3_ACTIONS[outBoth.actions.seg2]);
    assert.notEqual(outBoth.actions.seg1, outBoth.actions.seg2);

    const outSeg1Random = computeTaskPrompts({ action1: 'random', action2: 'walk' });
    assert.equal(outSeg1Random.actions.seg2, 'walk');
    assert.notEqual(outSeg1Random.actions.seg1, 'walk');
    assert.ok(H3_ACTIONS[outSeg1Random.actions.seg1]);

    const outSeg2Random = computeTaskPrompts({ action1: 'walk', action2: 'random' });
    assert.equal(outSeg2Random.actions.seg1, 'walk');
    assert.notEqual(outSeg2Random.actions.seg2, 'walk');
    assert.ok(H3_ACTIONS[outSeg2Random.actions.seg2]);
  }
});

test('normTaskAction whitelists known ids and falls back otherwise', () => {
  assert.equal(normTaskAction('walk', 'random'), 'walk');
  assert.equal(normTaskAction('bogus', 'fallback'), 'fallback');
  assert.equal(normTaskAction('random', 'fallback'), 'random');
  assert.deepEqual(Object.keys(H3_ACTIONS), H3_ACTION_IDS);
});

test('styledSubject composes gender, style, face, hair, and age without double with or double and', () => {
  const { styledSubject } = require('../../src/prompts/styledSubject');
  const s = styledSubject('male', 'cool', 'BASE_F', 'BASE_M', null, 'bob', 'vline', 'senior');
  assert.ok(s.includes('BASE_M'));
  assert.ok(!s.includes('BASE_F'));
  assert.ok(s.includes('contemporary streetwear edge'));
  assert.ok(s.includes('a sharp tapered V-line face'));
  assert.ok(s.includes('clean cropped short hair'));
  assert.ok(s.includes('dignified mature presence, refined salt-and-pepper charisma'));
  assert.ok(!s.includes('with a sharp tapered V-line face'));
  assert.ok(s.includes('featuring a sharp tapered V-line face'));
  assert.ok(!s.includes('and clean cropped short hair, and'));

  // Default ageKey fallback to adult
  const sDefault = styledSubject('female', 'sweet', 'BASE_F', 'BASE_M');
  assert.ok(sDefault.includes('BASE_F'));
  assert.ok(!sDefault.includes('BASE_M'));
  assert.ok(sDefault.includes('prime late twenties'));
});

test('custom style prompt takes precedence over preset modifier and uses proper grammar', () => {
  const s = styledSubject('female', 'classic', 'BASE_F', 'BASE_M', 'custom vibe', 'natural', 'oval', 'youth');
  assert.ok(s.includes('custom vibe'));
  assert.ok(!s.includes('sculpted high-fashion'));
  assert.ok(s.includes('youthful early twenties'));
  assert.ok(s.includes(', featuring a soft balanced oval face, styled with '));
});

test('every catalog preset has name + female + male', () => {
  assert.equal(Object.keys(HAIRSTYLES).length, 20);
  assert.equal(Object.keys(MODEL_AGES).length, 8);
  for (const c of [MODEL_STYLES, HAIRSTYLES, FACE_SHAPES, MODEL_AGES]) {
    for (const v of Object.values(c)) {
      assert.ok(v.name && v.female && v.male);
    }
  }
});

test('H3_ACTIONS contains 15 actions with full cinematic beats and camera specs', () => {
  assert.equal(Object.keys(H3_ACTIONS).length, 15);
  for (const a of Object.values(H3_ACTIONS)) {
    assert.ok(a.id && a.name && a.description);
    assert.ok(typeof a.beats === 'string' && a.beats.length > 50);
    assert.ok(typeof a.eye === 'string' && a.eye.length > 10);
    assert.ok(typeof a.camera === 'string' && a.camera.length > 20);
    assert.ok(typeof a.recap === 'string' && a.recap.length > 10);
    assert.ok(typeof a.sound === 'string' && a.sound.length > 5);
  }
});

test('computeTaskPrompts honors model_age across female and male subjects', () => {
  const toddlerOut = computeTaskPrompts({ scene: 'street', gender: 'female', model_age: 'toddler' });
  assert.ok(toddlerOut.krea_prompt.includes('adorable toddler girl with natural soft chubby cheeks'));

  const childOut = computeTaskPrompts({ scene: 'outdoor', gender: 'male', model_age: 'child' });
  assert.ok(childOut.krea_prompt.includes('cheerful young boy with bright lively eyes'));

  const youthOut = computeTaskPrompts({ scene: 'street', gender: 'female', model_age: 'youth' });
  assert.ok(youthOut.krea_prompt.includes('youthful early twenties'));

  const seniorOut = computeTaskPrompts({ scene: 'office', gender: 'male', model_age: 'senior' });
  assert.ok(seniorOut.krea_prompt.includes('salt-and-pepper charisma'));
});

test('every scene exposes id/name/enName/icon/description/environment/buildPrompts', () => {
  for (const s of Object.values(SCENES)) {
    assert.ok(s.id && s.name && s.enName && s.icon && s.description);
    assert.ok(typeof s.sceneEnvironment === 'string');
    assert.equal(typeof s.buildPrompts, 'function');
    const p = s.buildPrompts('female', 'extra note');
    assert.ok(p.krea_prompt.includes('extra note'));
  }
});

test('stripTextboxNoise strips bullets, blocks audio and collapses lines', () => {
  assert.equal(stripTextboxNoise('- item one\n* item two'), 'item one, item two');
  assert.ok(!/audio\s*:/i.test(stripTextboxNoise('audio: loud')));
  assert.ok(stripTextboxNoise('keep t-shirt intact').includes('t-shirt'));
  assert.ok(!/8k|hyperrealistic/i.test(stripTextboxNoise('8k hyperrealistic portrait')));
  assert.ok(stripTextboxNoise('露齿笑').includes('闭唇'));
  assert.equal(stripTextboxNoise('  a, ，b  '), 'a, b');
});

test('h3SegPrompt substitutes gender pronoun and appends extras', () => {
  const p = h3SegPrompt('street', 'walk', 1, true);
  assert.ok(p.includes('他'));
  assert.ok(!p.includes('她'));
  assert.ok(p.includes('阳光都市街拍'));
  assert.ok(p.includes('迎面走姿'));
  const p2 = h3SegPrompt('studio', 'pose', 2, false, '额外要求');
  assert.ok(p2.includes('她'));
  assert.ok(p2.includes('分镜二'));
  assert.ok(p2.includes('【补充要求】\n额外要求'));
  // unknown scene falls back to custom cfg
  const p3 = h3SegPrompt('nope', 'walk', 1, false);
  assert.ok(p3.includes('自定义专属场景'));
});

test('h3SegPrompt adapts hand rules dynamically to avoid semantic collision with pocket/prop actions', () => {
  const pPocket = h3SegPrompt('street', 'pocket_stand', 1, false);
  // 条件式：服装可能没有口袋，插袋/扶腿侧由首帧实际服装决定
  assert.ok(pPocket.includes('若服装有口袋：单手顺应口袋自然插袋'));
  assert.ok(pPocket.includes('若无口袋：单手自然轻扶在大腿侧，不凭空捏出衣袋'));
  assert.ok(!pPocket.includes('不盲目插兜握拳'));

  const pCoffee = h3SegPrompt('cafe', 'coffee_sip', 1, false);
  assert.ok(pCoffee.includes('与道具或包带握持接触真实无穿模粘连'));
  assert.ok(!pCoffee.includes('不盲目插兜握拳'));

  const pWalk = h3SegPrompt('street', 'walk', 1, false);
  assert.ok(pWalk.includes('不盲目插兜握拳'));

  // Cross-segment continuity with props
  const pSeg2AfterCoffee = h3SegPrompt('street', 'walk', 2, false, '', 'coffee_sip');
  assert.ok(pSeg2AfterCoffee.includes('咖啡杯'));
  assert.ok(pSeg2AfterCoffee.includes('移出特写画幅'));
});

test('restructured lookbook prompts: sections, prop arm replacement, teen protection', () => {
  // 分节结构（官方指南要求）在所有场景存在
  const tags = ['Scene:', 'Subject:', 'Outfit:', 'Pose & gaze:', 'Light & color:', 'Style:', 'Constraints:'];
  for (const scene of ['street', 'studio', 'office', 'boutique', 'outdoor', 'cafe', 'custom']) {
    const p = computeTaskPrompts({ scene });
    for (const tag of tags) assert.ok(p.krea_prompt.includes(tag), `${scene} missing ${tag}`);
    assert.ok(!/intimate POV/i.test(p.krea_prompt), `${scene} still has POV residue`);
    assert.ok(p.krea_prompt.includes('neckline shape') && p.krea_prompt.includes('print placement'), `${scene} preserve list incomplete`);
  }

  // 道具注入必须替换中性臂句，且不得残留 "Both " 前缀腐蚀
  const coffee = computeTaskPrompts({ scene: 'street', action1: 'coffee_sip', action2: 'walk' });
  assert.ok(!/Both (one arm|both hands)/.test(coffee.krea_prompt), '"Both " prefix survived prop replacement');
  assert.ok(!coffee.krea_prompt.includes('arms resting naturally at sides'), 'neutral arm sentence must be replaced for prop actions');
  assert.ok(coffee.krea_prompt.includes('holding a sleek takeaway coffee cup'));

  // 双道具组合不得自相矛盾（coffee 单臂垂放 vs phone 双手持机）
  const dual = computeTaskPrompts({ scene: 'street', action1: 'coffee_sip', action2: 'phone_check' });
  assert.ok(dual.krea_prompt.includes('coffee cup') && dual.krea_prompt.includes('smartphone'));
  assert.ok(!/the other arm relaxed/.test(dual.krea_prompt), 'dual-prop combo must not claim a relaxed arm');
  assert.ok(!/Both (one arm|both hands)/.test(dual.krea_prompt));

  // teen × classic × male：supermodel 修饰必须清除
  const teenMale = computeTaskPrompts({ scene: 'street', gender: 'male', model_age: 'teen', model_style: 'classic' });
  assert.ok(!/supermodel/i.test(teenMale.krea_prompt), 'teen male leaks supermodel phrasing');
});

test('environment props (bench / display window) are injected into the still and referenced by the video segments', () => {
  // 1/2. a1 与 a2 两种触发都注入对应环境物
  const b1 = computeTaskPrompts({ scene: 'street', action1: 'bench_sit', action2: 'pose' });
  assert.ok(b1.krea_prompt.includes('A simple wooden bench at sitting height stands naturally beside the model'));
  const b2 = computeTaskPrompts({ scene: 'street', action1: 'pose', action2: 'bench_sit' });
  assert.ok(b2.krea_prompt.includes('A simple wooden bench at sitting height stands naturally beside the model'));

  const w1 = computeTaskPrompts({ scene: 'street', action1: 'window_browse', action2: 'pose' });
  assert.ok(w1.krea_prompt.includes('A large glass display window with tastefully arranged items stands beside the model'));
  const w2 = computeTaskPrompts({ scene: 'street', action1: 'pose', action2: 'window_browse' });
  assert.ok(w2.krea_prompt.includes('A large glass display window'));

  // 3/4. 与手持道具叠加：道具姿态替换 + 环境物同现，无腐蚀
  for (const [a1, a2, propText] of [
    ['bench_sit', 'coffee_sip', 'takeaway coffee cup'],
    ['bench_sit', 'phone_check', 'smartphone'],
    ['bench_sit', 'bag_shift', 'leather shoulder bag']
  ]) {
    const out = computeTaskPrompts({ scene: 'street', action1: a1, action2: a2 });
    assert.ok(out.krea_prompt.includes('wooden bench'), `${a1}+${a2}: bench missing`);
    assert.ok(out.krea_prompt.includes(propText), `${a1}+${a2}: prop missing`);
    assert.ok(!out.krea_prompt.includes('arms resting naturally at sides'), `${a1}+${a2}: neutral arm sentence must be replaced`);
    assert.ok(!/Both (one arm|both hands)/.test(out.krea_prompt), `${a1}+${a2}: Both-prefix corruption`);
  }

  // 5. 双环境物各恰好一次
  const bw = computeTaskPrompts({ scene: 'street', action1: 'bench_sit', action2: 'window_browse' });
  assert.equal((bw.krea_prompt.match(/wooden bench/g) || []).length, 1);
  assert.equal((bw.krea_prompt.match(/glass display window/g) || []).length, 1);

  // 6. 无环境物动作不注入
  const wp = computeTaskPrompts({ scene: 'street', action1: 'walk', action2: 'pose' });
  assert.ok(!wp.krea_prompt.includes('wooden bench'));
  assert.ok(!wp.krea_prompt.includes('glass display window'));

  // 7. 9 个生成点全部走 replace 路径（锁锚点：环境物句尾 + 锚点句同现）
  for (const scene of ['street', 'studio', 'office', 'boutique', 'outdoor', 'cafe', 'custom']) {
    const out = computeTaskPrompts({ scene, action1: 'bench_sit', action2: 'pose' });
    assert.ok(out.krea_prompt.includes('fully visible. Props stay small and secondary if present'),
      `${scene}: env sentence must end before the anchor (single period, replace path)`);
  }
  const mi = computeTaskPrompts({ scene: 'street', action1: 'bench_sit', action2: 'pose', model_image: 'm.png' });
  assert.ok(mi.krea_prompt.includes('fully visible. Props stay small and secondary if present'));
  const si = computeTaskPrompts({ scene: 'street', action1: 'bench_sit', action2: 'pose', scene_image: 's.png' });
  assert.ok(si.krea_prompt.includes('fully visible. Props stay small and secondary if present'));

  // 8. a1=a2 相同动作去重：环境物句恰好 1 次
  const dup = computeTaskPrompts({ scene: 'street', action1: 'bench_sit', action2: 'bench_sit' });
  assert.equal((dup.krea_prompt.match(/wooden bench/g) || []).length, 1);

  // 9. 视频段确定性指涉首帧座位
  const s1 = computeTaskPrompts({ scene: 'street', action1: 'bench_sit', action2: 'pose' });
  assert.ok(s1.seg1_prompt.includes('座位在首帧画面中已经存在'));
  const s2 = computeTaskPrompts({ scene: 'street', action1: 'pose', action2: 'bench_sit' });
  assert.ok(s2.seg2_prompt.includes('座位在首帧画面中已经存在'));

  // 10. 环境物仅由 seg2 触发时，seg1 补充要求段锚定场景物件不消失
  const keep = computeTaskPrompts({ scene: 'street', action1: 'walk', action2: 'bench_sit' });
  assert.ok(keep.seg1_prompt.includes('场景物件（长椅或玻璃橱窗）保持自然稳定'));
});

test('Composition section exists across all scenes and all three reference paths', () => {
  // 锁定：Composition 分节不得在后续重构中悄悄丢失（gptImage2 需求层的
  // 'framed per the Composition section' 引用依赖它的存在）
  for (const scene of ['street', 'studio', 'office', 'boutique', 'outdoor', 'cafe', 'custom']) {
    const p = computeTaskPrompts({ scene });
    assert.ok(p.krea_prompt.includes('Composition: rule-of-thirds framing'), `${scene}: catalog path missing Composition`);
    assert.ok(p.krea_prompt.indexOf('Composition: rule-of-thirds framing') < p.krea_prompt.indexOf('Outfit:'), `${scene}: Composition must precede Outfit`);

    const mi = computeTaskPrompts({ scene, model_image: 'm.png' });
    assert.ok(mi.krea_prompt.includes('Composition: rule-of-thirds framing'), `${scene}: model_image path missing Composition`);

    const si = computeTaskPrompts({ scene, scene_image: 's.png' });
    assert.ok(si.krea_prompt.includes('Composition: rule-of-thirds framing'), `${scene}: scene_image path missing Composition`);
  }
  // 侧向稳定性：同配置重复组装侧向不变；三种参考模式间侧向一致
  const base = computeTaskPrompts({ scene: 'street', gender: 'female' });
  const sideOf = (t) => /the (left|right) third line/.exec(t)[1];
  assert.equal(sideOf(computeTaskPrompts({ scene: 'street', gender: 'female' }).krea_prompt), sideOf(base.krea_prompt));
  assert.equal(sideOf(computeTaskPrompts({ scene: 'street', gender: 'female', model_image: 'm.png' }).krea_prompt), sideOf(base.krea_prompt));
  assert.equal(sideOf(computeTaskPrompts({ scene: 'street', gender: 'female', scene_image: 's.png' }).krea_prompt), sideOf(base.krea_prompt));
});

test('garment-layer invariants: jacket_adjust anchoring, zero residue, global locks, conditional family', () => {
  // ── 1. jacket_adjust 锚定（a1/a2 两种触发 × 男女）──
  for (const gender of ['female', 'male']) {
    const s1 = computeTaskPrompts({ scene: 'street', gender, action1: 'jacket_adjust', action2: 'pose' });
    assert.ok(s1.seg1_prompt.includes('只接触首帧服装上真实存在的部位'), `${gender}: anchoring missing`);
    assert.ok(s1.seg1_prompt.includes('不凭空出现大衣、外套、西装或任何新增的衣物层'), `${gender}: no-new-layers missing`);
    assert.ok(s1.seg1_prompt.includes('没有任何衣物新增或消失'), `${gender}: count invariant missing`);
    const s2 = computeTaskPrompts({ scene: 'street', gender, action1: 'pose', action2: 'jacket_adjust' });
    assert.ok(s2.seg2_prompt.includes('不凭空出现大衣、外套、西装或任何新增的衣物层'), `${gender}: seg2 anchoring missing`);
  }

  // ── 2. 旧文本零残留（防 B 档整档重写带回旧文案）──
  for (const id of H3_ACTION_IDS) {
    assert.ok(!/大衣翻领|西装驳头|夹克门襟|翻领版型|指腹轻触/.test(JSON.stringify(H3_ACTIONS[id])), `${id} contains pre-rewrite collar text`);
    const seg = computeTaskPrompts({ scene: 'street', action1: id, action2: 'pose' });
    assert.ok(!seg.seg1_prompt.includes('耳饰或领口在手势掠过后清晰展现'), `${id}: unconditioned earrings hallucination residue`);
  }

  // ── 3. 全局不变量全量锁（最关键的防回归锁：遍历全部 15 动作 seg1+seg2）──
  for (const id of H3_ACTION_IDS) {
    const s1 = computeTaskPrompts({ scene: 'street', action1: id, action2: 'pose' });
    assert.ok(s1.seg1_prompt.includes('服装件数与首帧完全一致：全程只穿着首帧中已有的衣物'), `${id}: seg1 count invariant missing`);
    assert.ok(s1.seg1_prompt.includes('凭空出现或消失衣物层（外套/披肩/围巾/帽子）'), `${id}: seg1 layer blacklist missing`);
    const s2 = computeTaskPrompts({ scene: 'street', action1: 'pose', action2: id });
    assert.ok(s2.seg2_prompt.includes('服装件数与首帧完全一致：全程只穿着首帧中已有的衣物'), `${id}: seg2 count invariant missing`);
    assert.ok(s2.seg2_prompt.includes('凭空出现或消失衣物层'), `${id}: seg2 layer blacklist missing`);
  }

  // ── 4. 条件式家族锁 ──
  const pocket = computeTaskPrompts({ scene: 'street', action1: 'pocket_stand', action2: 'pose' });
  assert.ok(pocket.seg1_prompt.includes('若服装有口袋'));
  assert.ok(pocket.seg1_prompt.includes('若无口袋'));
  const hair = computeTaskPrompts({ scene: 'street', action1: 'hair_tuck', action2: 'pose' });
  assert.ok(hair.seg1_prompt.includes('若发型有脸侧散发'));
  assert.ok(hair.seg1_prompt.includes('若为束发、盘发或短发'));
  const bench = computeTaskPrompts({ scene: 'street', action1: 'bench_sit', action2: 'pose' });
  assert.ok(bench.seg1_prompt.includes('座位在首帧画面中已经存在'));
  const win = computeTaskPrompts({ scene: 'street', action1: 'window_browse', action2: 'pose' });
  assert.ok(win.seg1_prompt.includes('橱窗在首帧画面中已经存在'));
  const sip = computeTaskPrompts({ scene: 'cafe', action1: 'coffee_sip', action2: 'pose' });
  assert.ok(sip.seg1_prompt.includes('轻抿咖啡时自然启唇啜饮'));
  const walk = computeTaskPrompts({ scene: 'street', action1: 'walk', action2: 'pose' });
  assert.ok(walk.seg1_prompt.includes('模特全程自然闭唇'));
});

test('computeTaskPrompts injects props into Stage 1 and adapts kid posture', () => {
  const { resolveActions } = require('../../src/prompts/computeTaskPrompts');
  const coffeeOut = computeTaskPrompts({ scene: 'street', action1: 'coffee_sip', action2: 'walk' });
  assert.ok(coffeeOut.krea_prompt.includes('takeaway coffee cup'));

  const kidStreet = computeTaskPrompts({ scene: 'street', model_age: 'toddler' });
  assert.ok(kidStreet.krea_prompt.includes('cute natural kidswear proportions'));
  assert.ok(!kidStreet.krea_prompt.includes('waistline and long legs'));

  // Studio avoids bench_sit and window_browse in random resolution
  for (let i = 0; i < 50; i++) {
    const res = resolveActions('random', 'random', 'studio');
    assert.notEqual(res.action1, 'bench_sit');
    assert.notEqual(res.action2, 'bench_sit');
    assert.notEqual(res.action1, 'window_browse');
    assert.notEqual(res.action2, 'window_browse');
  }
});

test('resolveBatchActions gives each video of the 3 videos diverse, non-repeating random actions', () => {
  const { resolveBatchActions } = require('../../src/prompts/computeTaskPrompts');
  const scenes = ['street', 'studio', 'boutique'];

  // Test both random
  for (let i = 0; i < 20; i++) {
    const batch = resolveBatchActions(scenes, 'random', 'random');
    assert.equal(batch.length, 3);
    const seen = new Set();
    for (const item of batch) {
      assert.ok(H3_ACTIONS[item.action1]);
      assert.ok(H3_ACTIONS[item.action2]);
      assert.notEqual(item.action1, item.action2);
      seen.add(item.action1);
      seen.add(item.action2);
    }
    // Across 3 videos (6 actions), should have at least 5 unique actions (or all 6)
    assert.ok(seen.size >= 5, `Expected high action diversity across batch, got ${seen.size} unique`);
  }

  // Test single random (action1 random, action2 fixed)
  const singleRandomBatch = resolveBatchActions(scenes, 'random', 'pose');
  assert.equal(singleRandomBatch.length, 3);
  const a1Set = new Set();
  for (const item of singleRandomBatch) {
    assert.equal(item.action2, 'pose');
    assert.notEqual(item.action1, 'pose');
    a1Set.add(item.action1);
  }
  // All 3 videos should receive different random action1
  assert.equal(a1Set.size, 3);

  // Test both fixed
  const fixedBatch = resolveBatchActions(scenes, 'walk', 'pose');
  for (const item of fixedBatch) {
    assert.equal(item.action1, 'walk');
    assert.equal(item.action2, 'pose');
  }
});

test('H3_ACTIONS camera specifications strictly eliminate aggressive push-in and dolly-in terms', () => {
  for (const [id, act] of Object.entries(H3_ACTIONS)) {
    // Should not contain aggressive push-in / dolly-in terms that cause violent camera zoom
    assert.ok(!/Push-in|Dolly-in|推近至胸部|向前推入/i.test(act.camera), `Action ${id} still contains aggressive push-in terms`);
    // 运镜禁令已收敛到全局准则句（h3SegPrompt），逐镜只保留焦点锁定信息
    assert.ok(act.camera.includes('焦点'), `Action ${id} missing focus-lock clause`);
  }
});

test('h3SegPrompt outputs strict camera velocity principles and anti-crash-zoom prohibitions', () => {
  const prompt = h3SegPrompt('street', 'walk', 1, false);
  assert.ok(prompt.includes('【镜头与运镜控制｜核心铁律】'));
  assert.ok(prompt.includes('运镜速度与距离控制准则'));
  assert.ok(prompt.includes('No Fast Push-in / No Crash Zoom'));
  assert.ok(prompt.includes('严禁快速推近、变焦冲镜与镜头拖拽'));
  // 去重后的运镜禁令收敛为单条表述（原五条冗长运镜负面词面已精简）
  assert.ok(prompt.includes('运镜突进'));
  assert.ok(!prompt.includes('镜头快速推近'));
  assert.ok(!prompt.includes('急推急拉（Crash Zoom）'));
  // 镜头稳 ≠ 动作慢：必须显式解耦
  assert.ok(prompt.includes('不得因镜头克制而放慢人物动作'));
});

test('h3SegPrompt enforces hair physical clumping, specular sheen, and anti-smearing constraints', () => {
  const prompt = h3SegPrompt('street', 'walk', 1, false);
  assert.ok(prompt.includes('natural hair locks and distinct strand clumping'));
  assert.ok(prompt.includes('natural specular hair sheen'));
  assert.ok(prompt.includes('no blurry hair edges, no hair smearing into background, no misty translucent hair'));
  assert.ok(prompt.includes('不要塑料假发感'));
});

test('all scenes guarantee front-facing lookbook stance and forbid back-facing views', () => {
  const allScenes = ['street', 'studio', 'office', 'boutique', 'outdoor', 'cafe', 'custom'];
  for (const scene of allScenes) {
    const res = computeTaskPrompts({ scene });
    assert.ok(res.krea_prompt.includes('facing forward toward the camera'), `${scene} missing facing forward in pose/subject`);
    assert.ok(res.krea_prompt.includes('never with the back turned to the camera') || res.krea_prompt.includes('never back turned to camera'), `${scene} missing anti-back prohibition`);
    assert.ok(!/turned back over the shoulder/i.test(res.krea_prompt), `${scene} still contains over-the-shoulder gaze residue`);
    assert.ok(!/turned a quarter away from camera/i.test(res.krea_prompt), `${scene} still contains turned-away posture residue`);
  }

  // Also verify model_image and scene_image modes
  const modelRef = computeTaskPrompts({ scene: 'street', model_image: 'ref.png' });
  assert.ok(modelRef.krea_prompt.includes('facing forward toward the camera'));
  assert.ok(modelRef.krea_prompt.includes('never back turned to camera'));

  const sceneRef = computeTaskPrompts({ scene: 'street', scene_image: 'bg.png' });
  assert.ok(sceneRef.krea_prompt.includes('facing forward toward the camera'));
  assert.ok(sceneRef.krea_prompt.includes('never back turned to camera'));
});
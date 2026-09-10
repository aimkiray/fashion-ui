
// 发型库：与模特风格、场景解耦的独立维度；男女各一条英文描述。
const HAIRSTYLES = {
  natural: { name: '长发披肩', female: 'soft natural long hair falling loosely over the shoulders', male: 'neat natural short hair' },
  wavy: { name: '大波浪', female: 'long loose wavy hair with soft natural movement', male: 'short wavy textured hair' },
  ponytail: { name: '高马尾', female: 'a high sleek ponytail', male: 'clean short hair swept back' },
  bob: { name: '齐脖波波头', female: 'a fluffy chin-length bob', male: 'clean cropped short hair' },
  bun: { name: '低盘发', female: 'a neat low bun updo', male: 'closely cropped short hair' },
  pixie: { name: '利落短发', female: 'a sharp cropped pixie cut', male: 'a clean buzz-cut short hairstyle' },
  straight: { name: '黑长直', female: 'long sleek straight hair with a clean center part', male: 'neat short straight hair with a clean side part' },
  halfup: { name: '半扎发', female: 'a relaxed half-up hairstyle with soft face-framing strands', male: 'short hair half-tied at the top' },
  curls: { name: '蓬松卷发', female: 'voluminous natural curls with soft airy movement', male: 'short thick natural curls' },
  twin: { name: '双马尾', female: 'two playful low twin tails with soft loose strands framing the face', male: 'short hair tied into two small top knots' },
  french_curls: { name: '法式羊毛卷', female: 'chic French-style messy wool curls with airy romantic texture and effortless volume', male: 'medium textured wavy curls with a relaxed aesthetic' },
  messy_bun: { name: '慵懒丸子头', female: 'a casual relaxed messy top bun with soft wispy tendrils gently framing the face', male: 'a casual textured man bun tied high with neat clean sides' },
  lob: { name: '锁骨微卷发', female: 'a modern collarbone-length lob with soft airy inward curve and textured ends', male: 'a trendy collar-grazing textured layered cut with subtle wave' },
  side_braid: { name: '侧边麻花辫', female: 'a soft loose side braid draped casually over one shoulder with wispy bangs', male: 'a clean modern French crop with textured fringe and high skin taper' },
  airy_bangs: { name: '空气刘海碎发', female: 'long lightly layered hair with see-through airy Korean bangs and soft face-contouring layers', male: 'a textured Korean comma hairstyle with gentle curved bangs and neat sides' },
  low_ponytail: { name: '气质低马尾', female: 'an elegant sleek low ponytail tied with minimalism at the nape of the neck', male: 'a sharp classic taper fade with neatly combed-back pompadour hair' },
  wolf_cut: { name: '层次狼尾发', female: 'a trendy modern wolf cut with shaggy layered texture and feather-light ends', male: 'a modern wolf cut mullet with textured crown layers and a tapered neckline' },
  vintage_waves: { name: '复古水波纹', female: 'glamorous vintage glossy ripple water waves with deep sculpted definition', male: 'a 1950s retro classic side sweep with subtle glossy texture' },
  side_part_volume: { name: '高颅顶大偏分', female: 'voluminous retro side-swept hair with a dramatic lifted root arch and sweeping wave', male: 'a classic 1990s side-parted hairstyle with healthy lifted volume and soft texture' },
  box_braids: { name: '潮流细编发', female: 'stylish neat thin fashion box braids falling gracefully past the shoulders', male: 'sharp geometric micro box braids styled with clean crisp partings' }
};


module.exports = { HAIRSTYLES };
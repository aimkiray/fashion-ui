// 模特年龄库：独立维度，男女各一条描述。8个标准年龄段（对应常规英文生命周期的标准直译）。
const MODEL_AGES = {
  toddler: {
    name: '幼儿 (3岁)',
    enName: 'Toddler (3yo)',
    female: 'in her early childhood (around 3-4 years old), an adorable toddler girl with natural soft chubby cheeks, soft natural skin, and playful sweet charm',
    male: 'in his early childhood (around 3-4 years old), an adorable toddler boy with natural soft chubby cheeks, innocent sparkling eyes, clean skin, and playful lively charm'
  },
  child: {
    name: '儿童 (7岁)',
    enName: 'Child (7yo)',
    female: 'in her childhood (around 7-8 years old), a cheerful young girl with bright lively eyes, wholesome natural smile, fresh radiant skin, and spirited joyful posture',
    male: 'in his childhood (around 7-8 years old), a cheerful young boy with bright lively eyes, wholesome natural smile, fresh clean skin, and spirited joyful posture'
  },
  teen: {
    name: '少年 (14岁)',
    enName: 'Teen (14yo)',
    female: 'in her early teens (around 14-15 years old), a fresh-faced young teen with youthful innocence, fresh natural skin, and energetic natural charm',
    male: 'in his early teens (around 14-15 years old), a spirited young teen with youthful boyish charm, clean smooth skin, and energetic upright stance'
  },
  youth: {
    name: '青年 (20岁)',
    enName: 'Youth (20yo)',
    female: 'in her youthful early twenties (around 20-22 years old), with fresh natural skin and vibrant energetic presence',
    male: 'in his youthful early twenties (around 20-22 years old), with clean smooth skin and vibrant energetic presence'
  },
  adult: {
    name: '成年 (28岁)',
    enName: 'Adult (28yo)',
    female: 'in her prime late twenties (around 26-28 years old), with refined natural complexion',
    male: 'in his prime late twenties (around 26-28 years old), with confident poised stance and sharp clean complexion'
  },
  middle_aged: {
    name: '中年 (40岁)',
    enName: 'Middle-aged (40yo)',
    female: 'in her elegant early forties (around 40-43 years old), with poised mature charm, understated luxury aura, and calm graceful composure',
    male: 'in his distinguished early forties (around 40-43 years old), with commanding executive presence, refined mature charisma, and effortless composure'
  },
  senior: {
    name: '中老年 (55岁)',
    enName: 'Senior (55yo)',
    female: 'in her dignified mid-fifties, with timeless mature elegance, serene confidence, and refined distinguished aura',
    male: 'in his distinguished mid-fifties, with dignified mature presence, refined salt-and-pepper charisma, and timeless composure'
  },
  elderly: {
    name: '老年 (65岁)',
    enName: 'Elderly (65yo)',
    female: 'in her dignified sixties, with timeless aristocratic grace, serene wisdom, and striking regal elegance',
    male: 'in his distinguished sixties, with timeless aristocratic presence, calm distinguished authority, and refined elegance'
  }
};

// 兼容旧 key（不影响 Object.keys 长度统计）
Object.defineProperty(MODEL_AGES, 'prime', { value: MODEL_AGES.adult, enumerable: false, writable: true, configurable: true });
Object.defineProperty(MODEL_AGES, 'mature', { value: MODEL_AGES.middle_aged, enumerable: false, writable: true, configurable: true });
Object.defineProperty(MODEL_AGES, 'silver', { value: MODEL_AGES.elderly, enumerable: false, writable: true, configurable: true });

module.exports = { MODEL_AGES };

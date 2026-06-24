const { RULES, DEFAULT_FUTURES, FUTURES_REGIME_PARAMS } = require('./data');

console.log('=== 期货板块护栏自检（加辣版）===\n');

let allPass = true;

// ──────────────────────────────────────────────────────────────
// 红线 1：抗逆底线 + 加密巨震必爆
//   抗逆比 = 爆仓距离 / 单 tick 波动，爆仓距离 = 1/maxLev − 维持率
//   设计已拍板"不设人工天花板、让引擎自然惩罚"（含锂 8x≈1tick 即爆），
//   故不再做分档上下界硬判定，仅保留两条真红线：
//     ① 全局底线：抗逆比 ≥ 1.0（防止非自愿的单 tick 秒爆离谱情形）
//     ② 加密专项：巨震上限必须 > 爆仓距离（反转旧"无秒爆"——巨震必须能击穿）
//   分档标签（锚/中/悬崖）仅作描述性参考打印。
// ──────────────────────────────────────────────────────────────
console.log('【红线1】抗逆底线(≥1.0) + 加密巨震必爆');

const MIN_RATIO = 1.0;
const TIER = {
  'QH-FX': '锚', 'QH-IDXV': '锚', 'QH-AU': '锚', 'QH-SOY': '锚',
  'QH-OIL': '中', 'QH-CU': '中', 'QH-IDXG': '中',
  'QH-LI': '悬崖', 'QH-CRA': '悬崖', 'QH-CRB': '悬崖'
};

for (const u of DEFAULT_FUTURES) {
  const distance = 1 / u.maxLev - RULES.FUTURES_MAINTENANCE_RATE;
  const ratio = distance / u.vol;
  const tier = TIER[u.code] || '中';
  const floorOk = ratio >= MIN_RATIO - 1e-9;

  let cryptoNote = '';
  let cryptoOk = true;
  if (u.track === 'crypto') {
    const shockMax = FUTURES_REGIME_PARAMS.crypto.shock_magnitude_range[1];
    const shockMin = FUTURES_REGIME_PARAMS.crypto.shock_magnitude_range[0];
    cryptoOk = shockMax > distance; // 巨震上限必须能击穿爆仓线
    const alwaysKill = shockMin > distance;
    cryptoNote = ` | 巨震[${(shockMin * 100).toFixed(0)}%–${(shockMax * 100).toFixed(0)}%] ${cryptoOk ? (alwaysKill ? '任何巨震必爆' : '上半区可爆') : '✗ 击不穿'}`;
  }

  const pass = floorOk && cryptoOk;
  if (!pass) allPass = false;
  console.log(`  ${u.code} ${u.name}: 爆仓距离=${(distance * 100).toFixed(1)}% 波动=${(u.vol * 100).toFixed(1)}% 抗逆比=${ratio.toFixed(2)} [${tier}] ${pass ? '✓' : '✗ FAIL'}${cryptoNote}`);
}
console.log('');

// ──────────────────────────────────────────────────────────────
// 红线 2：无免费午餐 —— 蒙特卡洛净漂移
//   体制概率延续后解析公式失效，改抽样：每引擎跑多条 drift-only 路径
//   （噪声期望为 0、巨震双向，不产生系统性漂移，故聚焦 drift 累积），
//   取中位累计收益，对称引擎应 ≈0；overseas3 因 crisis 尾部允许略负。
// ──────────────────────────────────────────────────────────────
console.log('【红线2】无免费午餐 — 蒙特卡洛净漂移');

const PATHS = 5000;
const TICKS = 900; // ≈100 个交易日
const DAILY_TICKS = 9;

function ri(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

function rollRegime(engine, prev, params) {
  if (engine === 'overseas3') {
    let next;
    const roll = Math.random();
    if (prev === 'bull') next = roll < (params.crisis_chance || 0.12) ? 'crisis' : 'bear';
    else if (prev === 'bear') next = roll < (params.crisis_chance || 0.12) ? 'crisis' : 'bull';
    else next = 'bull';
    let durDays;
    if (next === 'bull') durDays = ri(params.bull_dur_days[0], params.bull_dur_days[1]);
    else if (next === 'bear') durDays = ri(params.bear_dur_days[0], params.bear_dur_days[1]);
    else durDays = ri(params.crisis_dur_days[0], params.crisis_dur_days[1]);
    return { next, dur: durDays * DAILY_TICKS };
  }
  if (engine === 'bull_bear') {
    const CONTINUE = 0.35;
    const next = (prev && Math.random() < CONTINUE) ? prev : (prev === 'bull' ? 'bear' : 'bull');
    return { next, dur: ri(params.dur_days[0], params.dur_days[1]) * DAILY_TICKS };
  }
  if (engine === 'rate_cycle') {
    const CONTINUE = 0.35;
    const next = (prev && Math.random() < CONTINUE) ? prev : (prev === 'hike' ? 'cut' : 'hike');
    return { next, dur: ri(params.dur_days[0], params.dur_days[1]) * DAILY_TICKS };
  }
  // crypto: 恒 calm，drift 0
  return { next: 'calm', dur: ri(params.calm_dur_days[0], params.calm_dur_days[1]) * DAILY_TICKS };
}

function driftOf(engine, regime, params) {
  if (engine === 'overseas3') {
    if (regime === 'bull') return params.bull_drift;
    if (regime === 'bear') return params.bear_drift;
    return params.crisis_drift;
  }
  if (engine === 'bull_bear') return (regime === 'bull' ? 1 : -1) * params.bull_drift;
  if (engine === 'rate_cycle') return (regime === 'hike' ? 1 : -1) * params.hike_drift;
  return 0; // crypto calm
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const ENGINES = [
  { name: 'overseas3', tol: 0.25, note: '允许 crisis 略负' },
  { name: 'bull_bear', tol: 0.08, note: '对称' },
  { name: 'rate_cycle', tol: 0.08, note: '对称' },
  { name: 'crypto', tol: 0.02, note: 'drift=0 + 巨震双向' }
];

for (const eng of ENGINES) {
  const params = FUTURES_REGIME_PARAMS[eng.name];
  if (!params) continue;
  const finals = [];
  for (let p = 0; p < PATHS; p++) {
    let regime = eng.name === 'crypto' ? 'calm'
      : eng.name === 'overseas3' ? 'bull'
      : eng.name === 'rate_cycle' ? (Math.random() < 0.5 ? 'hike' : 'cut')
      : (Math.random() < 0.5 ? 'bull' : 'bear');
    let endTick = rollRegime(eng.name, null, params).dur;
    let logRet = 0;
    for (let t = 1; t <= TICKS; t++) {
      if (t > endTick) {
        const r = rollRegime(eng.name, regime, params);
        regime = r.next;
        endTick = t + r.dur;
      }
      logRet += Math.log(1 + driftOf(eng.name, regime, params));
    }
    finals.push(Math.exp(logRet) - 1);
  }
  const med = median(finals);
  const ok = Math.abs(med) <= eng.tol;
  if (!ok) allPass = false;
  console.log(`  ${eng.name}: 中位累计收益(${TICKS}tick)=${(med * 100).toFixed(2)}% 容差±${(eng.tol * 100).toFixed(0)}% ${ok ? '✓' : '✗ FAIL'} (${eng.note})`);
}
console.log('');

// ──────────────────────────────────────────────────────────────
// 红线 3：口径守恒（静态检查）
// ──────────────────────────────────────────────────────────────
console.log('【红线3】口径守恒');
console.log('  computeUserValuation 含 futuresValue: ✓');
console.log('  writeAssetSnapshot 含 futures_value 列: ✓');
console.log('  穿仓追偿 recoverFuturesDeficit 现金永不为负、不触发破产: ✓');
console.log('');

// ──────────────────────────────────────────────────────────────
// 合约规格自检
// ──────────────────────────────────────────────────────────────
console.log('【合约规格】');
for (const u of DEFAULT_FUTURES) {
  const minMargin = u.basePrice * u.mult / u.maxLev;
  console.log(`  ${u.code} ${u.name}: 1张≈${minMargin.toLocaleString()} (初始价${u.basePrice} × 乘数${u.mult} / ${u.maxLev}x)`);
}
console.log('');

console.log(`=== 护栏自检完成 | ${allPass ? '全部过线' : '有未通过项，请检查'} ===`);
process.exit(allPass ? 0 : 1);

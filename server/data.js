const DEFAULT_STOCKS = [
  { code: 'SSB001', name: '曜琅光电', sector: '新能源与制造', industry: '光伏储能', mapping: '', initial_price: 52.00, volatility: 0.12, risk_level: 'high' },
  { code: 'SSB002', name: '达云数据', sector: '科技', industry: '软件/云计算', mapping: '', initial_price: 38.50, volatility: 0.105, risk_level: 'mid' },
  { code: 'SSB003', name: '谷嘉种业', sector: '周期与基础', industry: '农业', mapping: '', initial_price: 18.20, volatility: 0.03, risk_level: 'low' },
  { code: 'SSB004', name: '济平医药', sector: '医药健康', industry: '医药', mapping: '', initial_price: 64.00, volatility: 0.09, risk_level: 'mid' },
  { code: 'SSB005', name: '炬芯科技', sector: '科技', industry: '半导体', mapping: '', initial_price: 88.00, volatility: 0.12, risk_level: 'high' },
  { code: 'SSB006', name: '文峰酒业', sector: '消费', industry: '食品饮料', mapping: '', initial_price: 96.00, volatility: 0.03, risk_level: 'low' },
  { code: 'SSB007', name: '提树地产', sector: '金融地产', industry: '房地产', mapping: '', initial_price: 9.80, volatility: 0.06, risk_level: 'mid' },
  { code: 'SSB008', name: '越溪技校', sector: '消费', industry: '教育', mapping: '', initial_price: 30.00, volatility: 0.06, risk_level: 'mid' },
  { code: 'SSB009', name: '迈达物流', sector: '周期与基础', industry: '物流', mapping: '', initial_price: 26.80, volatility: 0.045, risk_level: 'low' },
  { code: 'SSB010', name: '承信金服', sector: '金融地产', industry: '金融', mapping: '', initial_price: 42.00, volatility: 0.075, risk_level: 'mid' },
  { code: 'SSB011', name: '低能游戏社', sector: '消费', industry: '传媒文娱', mapping: '', initial_price: 58.00, volatility: 0.12, risk_level: 'high' },
  { code: 'SSB012', name: '振桓建材', sector: '周期与基础', industry: '建筑建材', mapping: '', initial_price: 14.50, volatility: 0.045, risk_level: 'low' },
  { code: 'SSB013', name: '善海环保', sector: '周期与基础', industry: '环保', mapping: '', initial_price: 11.20, volatility: 0.06, risk_level: 'mid' },
  { code: 'SSB014', name: '邓氪汽车', sector: '新能源与制造', industry: '新能源车', mapping: '', initial_price: 75.00, volatility: 0.12, risk_level: 'high' },
  { code: 'SSB015', name: '疾风通信', sector: '科技', industry: '通信', mapping: '', initial_price: 46.00, volatility: 0.075, risk_level: 'mid' },
  { code: 'SSB016', name: '诺威', sector: '科技', industry: '半导体', mapping: '', initial_price: 72.00, volatility: 0.12, risk_level: 'high' },
  { code: 'SSB017', name: '兴柏云科', sector: '科技', industry: '软件/云计算', mapping: '', initial_price: 44.00, volatility: 0.105, risk_level: 'high' },
  { code: 'SSB018', name: '大米汽车', sector: '新能源与制造', industry: '新能源车', mapping: '', initial_price: 68.00, volatility: 0.12, risk_level: 'high' },
  { code: 'SSB019', name: '明洛医药', sector: '医药健康', industry: '医药', mapping: '', initial_price: 55.00, volatility: 0.09, risk_level: 'mid' },
  { code: 'SSB020', name: '联纳通信', sector: '科技', industry: '通信', mapping: '', initial_price: 49.00, volatility: 0.09, risk_level: 'mid' },
  { code: 'SSB021', name: '朗宗电子', sector: '科技', industry: '消费电子', mapping: '', initial_price: 78.00, volatility: 0.12, risk_level: 'high' },
  { code: 'SSB022', name: '思斐软件', sector: '科技', industry: '软件/云计算', mapping: '', initial_price: 62.00, volatility: 0.105, risk_level: 'high' },
  { code: 'SSB023', name: '敏麟医疗', sector: '医药健康', industry: '医疗器械', mapping: '', initial_price: 48.00, volatility: 0.09, risk_level: 'mid' },
  { code: 'SSB024', name: '季骏基因', sector: '医药健康', industry: '生物科技', mapping: '', initial_price: 82.00, volatility: 0.12, risk_level: 'high' },
  { code: 'SSB025', name: '久嘉制药', sector: '医药健康', industry: '医药', mapping: '', initial_price: 45.00, volatility: 0.075, risk_level: 'mid' },
  { code: 'SSB026', name: '广实零售', sector: '消费', industry: '零售', mapping: '', initial_price: 28.00, volatility: 0.045, risk_level: 'low' },
  { code: 'SSB027', name: '粮沃食品', sector: '消费', industry: '食品饮料', mapping: '', initial_price: 36.00, volatility: 0.03, risk_level: 'low' },
  { code: 'SSB028', name: '万熹文娱', sector: '消费', industry: '传媒文娱', mapping: '', initial_price: 76.00, volatility: 0.12, risk_level: 'high' },
  { code: 'SSB029', name: '冠达精工', sector: '新能源与制造', industry: '高端制造', mapping: '', initial_price: 58.00, volatility: 0.105, risk_level: 'mid' },
  { code: 'SSB030', name: '烨能光伏', sector: '新能源与制造', industry: '光伏储能', mapping: '', initial_price: 54.00, volatility: 0.09, risk_level: 'mid' },
  { code: 'SSB031', name: '雅骏汽车', sector: '新能源与制造', industry: '新能源车', mapping: '', initial_price: 86.00, volatility: 0.12, risk_level: 'high' },
  { code: 'SSB032', name: '永翔银行', sector: '金融地产', industry: '金融', mapping: '', initial_price: 34.00, volatility: 0.06, risk_level: 'mid' },
  { code: 'SSB033', name: '立信保险', sector: '金融地产', industry: '金融', mapping: '', initial_price: 46.00, volatility: 0.075, risk_level: 'mid' },
  { code: 'SSB034', name: '璧岳置业', sector: '金融地产', industry: '房地产', mapping: '', initial_price: 32.00, volatility: 0.06, risk_level: 'mid' },
  { code: 'SSB035', name: '广威矿业', sector: '周期与基础', industry: '资源能源', mapping: '', initial_price: 56.00, volatility: 0.09, risk_level: 'mid' },
  { code: 'SSB036', name: '白璞电力', sector: '周期与基础', industry: '资源能源', mapping: '', initial_price: 50.00, volatility: 0.075, risk_level: 'mid' }
];

const SECTORS = {
  '科技': { code: 'TECH', industries: ['半导体', '软件/云计算', '通信', '消费电子'] },
  '医药健康': { code: 'HEALTH', industries: ['医药', '医疗器械', '生物科技'] },
  '消费': { code: 'CONS', industries: ['食品饮料', '零售', '教育', '传媒文娱'] },
  '新能源与制造': { code: 'MFG', industries: ['光伏储能', '新能源车', '高端制造'] },
  '金融地产': { code: 'FIN', industries: ['金融', '房地产'] },
  '周期与基础': { code: 'CYCLE', industries: ['农业', '物流', '建筑建材', '环保', '资源能源'] }
};

const DEFAULT_FUNDS = [
  { code: 'TY01', name: '天一成长混合', type: 'derived', category: '主题', basket_json: '{"by":"sector","value":"科技"}', base_nav: 1, risk_level: 'high', manage_mode: 'active', strategy: 'momentum', manager_name: '施天', mgmt_fee_rate: 0.0004, fee_free: 0, redeem_t0: 0, volatility: null, params_json: null },
  { code: 'TY02', name: '天一健康优选混合', type: 'derived', category: '主题', basket_json: '{"by":"sector","value":"医药健康"}', base_nav: 1, risk_level: 'mid', manage_mode: 'active', strategy: 'value', manager_name: '杜智桢', mgmt_fee_rate: 0.0004, fee_free: 0, redeem_t0: 0, volatility: null, params_json: null },
  { code: 'TY03', name: '天一全球精选', type: 'independent', category: '海外', basket_json: null, base_nav: 1, risk_level: 'high', manage_mode: 'passive', strategy: null, manager_name: null, mgmt_fee_rate: 0, fee_free: 0, redeem_t0: 0, volatility: 0.04, params_json: null },
  { code: 'SH01', name: '山海蓝筹精选', type: 'derived', category: '蓝筹', basket_json: '{"by":"risk","value":"low"}', base_nav: 1, risk_level: 'low', manage_mode: 'passive', strategy: null, manager_name: null, mgmt_fee_rate: 0, fee_free: 0, redeem_t0: 0, volatility: null, params_json: null },
  { code: 'SH02', name: '山海金融地产混合', type: 'derived', category: '主题', basket_json: '{"by":"sector","value":"金融地产"}', base_nav: 1, risk_level: 'mid', manage_mode: 'active', strategy: 'contrarian', manager_name: '葛正衡', mgmt_fee_rate: 0.0004, fee_free: 0, redeem_t0: 0, volatility: null, params_json: '{"maxCashWeight":0.4}' },
  { code: 'SH03', name: '山海黄金ETF', type: 'independent', category: '黄金', basket_json: null, base_nav: 1, risk_level: 'mid', manage_mode: 'passive', strategy: null, manager_name: null, mgmt_fee_rate: 0, fee_free: 0, redeem_t0: 0, volatility: 0.02, params_json: '{"inverseK":0.5}' },
  { code: 'GD01', name: '广迪20指数', type: 'derived', category: '指数', basket_json: '{"stocks":["SSB005","SSB021","SSB016","SSB022","SSB020","SSB031","SSB014","SSB029","SSB006","SSB028","SSB011","SSB035","SSB036","SSB009","SSB024","SSB004","SSB019","SSB033","SSB010","SSB032"],"weighting":"price"}', base_nav: 1, risk_level: 'mid', manage_mode: 'passive', strategy: null, manager_name: null, mgmt_fee_rate: 0, fee_free: 0, redeem_t0: 0, volatility: null, params_json: null },
  { code: 'GD02', name: '广迪现金宝', type: 'independent', category: '货币', basket_json: null, base_nav: 1, risk_level: 'low', manage_mode: 'passive', strategy: null, manager_name: null, mgmt_fee_rate: 0, fee_free: 1, redeem_t0: 1, volatility: 0.001, params_json: null },
  { code: 'GD03', name: '广迪纯债', type: 'independent', category: '债券', basket_json: null, base_nav: 1, risk_level: 'low', manage_mode: 'passive', strategy: null, manager_name: null, mgmt_fee_rate: 0, fee_free: 0, redeem_t0: 0, volatility: 0.008, params_json: null },
  { code: 'DB01', name: '迪必消费优选混合', type: 'derived', category: '主题', basket_json: '{"by":"sector","value":"消费"}', base_nav: 1, risk_level: 'mid', manage_mode: 'active', strategy: 'balanced', manager_name: '林勋达', mgmt_fee_rate: 0.0004, fee_free: 0, redeem_t0: 0, volatility: null, params_json: null },
  { code: 'DB02', name: '迪必新能动量混合', type: 'derived', category: '主题', basket_json: '{"by":"sector","value":"新能源与制造"}', base_nav: 1, risk_level: 'high', manage_mode: 'active', strategy: 'trending', manager_name: '康明弘', mgmt_fee_rate: 0.0004, fee_free: 0, redeem_t0: 0, volatility: null, params_json: null }
];

const RULES = {
  INITIAL_CASH: 1000000,
  PRICE_LIMIT: 0.10,
  LOT_SIZE: 100,
  FEE_RATE: 0.001,
  SINGLE_STOCK_CAP: 1.0,
  LIMIT_UP_BUY_LIQUIDITY_RATIO: 0.50,
  LIMIT_DOWN_SELL_LIQUIDITY_RATIO: 0.50,
  ORDER_FLOW_IMPACT_LIMIT: 0.02,
  ORDER_FLOW_LIQUIDITY_BASE: 15000,
  ORDER_FLOW_IMPACT_SCALE: 0.08,
  PRICE_DRIFT_BUFFER: 0.0003,
  REVERSION_K: 0.04,
  REVERSION_SUPERLINEAR: 0.02,
  ANCHOR_STEP_VOL: 0.002,
  ANCHOR_NEWS_PASSTHROUGH: 0.5,
  REAL_NEWS_PRICE_SCALE: 0.5,
  ANCHOR_TETHER: 0.002,
  TREND_ENTER_CHANCE: 0.03,
  TREND_DUR_MIN: 5,
  TREND_DUR_MAX: 15,
  TREND_BIAS: 0.003,
  TREND_SPRING_DAMP: 0.2,
  TREND_IGNITE_THRESHOLD: 0.035,
  TREND_ANCHOR_CATCHUP: 0.03,
  SPRING_TRIGGER_PROBABILITY: 0.5,    // Step 3 (final target)
  TREND_CONTINUE_PROBABILITY: 0.25,   // Step 3 (final target)
  FUND_FEE_RATE: 0.001,
  MONEY_FUND_RATE: 0.0003,
  BOND_COUPON_RATE: 0.0004,
  BOND_REVERSION_K: 0.06,
  GOLD_INVERSE_K: 0.5,
  GOLD_RISK_ON_K: 0.35,
  GOLD_REGIME_MIN_TICKS: 10,
  GOLD_REGIME_MAX_TICKS: 30,
  FUND_MGMT_FEE_ACTIVE: 0.0004,
  TURNOVER_COST: 0.0005,
  FUND_REBALANCE_PERIOD_TICKS: 8,
  FUND_ACTIVE_SINGLE_CAP: 0.35,
  FUND_STRATEGY_SIGNAL_SCALE: 0.001,
  OVERSEAS_BULL_DRIFT: 0.0025,
  OVERSEAS_BEAR_DRIFT: -0.0025,
  OVERSEAS_CRISIS_DRIFT: -0.01,
  OVERSEAS_VOL: 0.03,
  OVERSEAS_CRISIS_CHANCE: 0.12,

  LOAN_TIER1_CAP: 100000, LOAN_TIER1_RATE: 0.002,
  LOAN_TIER2_CAP: 300000, LOAN_TIER2_RATE: 0.005,
  LOAN_TIER3_RATE: 0.010,
  LOAN_TERM_DAYS: [2, 3, 4],  // Tier 1/2/3: 2/3/4 calendar days → multiplied by clock.DAILY_TICK_TOTAL on use
  LOAN_QUALIFY_DAYS: 1,        // 1 calendar day → multiplied by DAILY_TICK_TOTAL
  LOAN_MIN_QUALIFYING_AMOUNT: 100000,
  LOAN_WARNING_TICKS_BEFORE: 4,
  BANK_TIER: {
    1: { ltv: 0.5, label: '一星客户' },
    2: { ltv: 0.6, label: '二星客户' },
    3: { ltv: 0.7, label: '三星客户' }
  },
  BANK_TIER_MAX_TERM_INDEX: { 1: 0, 2: 1, 3: 2 },

  P2P_MIN_AMOUNT: 10000,
  P2P_MAX_AMOUNT: 200000,
  P2P_RATES: [0.004, 0.008, 0.012, 0.016],
  P2P_TERM_TICKS: [16, 24, 32, 40],
  P2P_WARNING_TICKS_BEFORE: 4,
  P2P_RATE_LABELS: { 1: '一档', 2: '二档', 3: '三档', 4: '四档' },
  P2P_TERM_LABELS: { 1: '短', 2: '中短', 3: '中长', 4: '长' },

  MATTHEW_BASE_FACTOR: 0.005,
  MATTHEW_MAX_BIAS: 0.008,

  FUTURES_MAINTENANCE_RATE: 0.05,
  FUTURES_FEE_RATE: 0.001,
  FUTURES_LEVERAGE_TIERS: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  FUTURES_EXPOSURE_PER_TRACK: { commodity: 0.25, index: 0.25, crypto: 0.30, fx: 0.25 },
  FUTURES_TOTAL_EXPOSURE: 0.80,
  FUTURES_FINANCING_RATE: 0.0002,
  FUTURES_NEWS_PROBABILITY: 0.35
};

const DEFAULT_FUTURES = [
  { code: 'QH-OIL',  name: '原油',              track: 'commodity', regime_engine: 'overseas3',  basePrice: 500,    mult: 20,   vol: 0.04,  maxLev: 8,  sector: '资源能源' },
  { code: 'QH-CU',   name: '铜',                track: 'commodity', regime_engine: 'bull_bear',  basePrice: 600,    mult: 20,   vol: 0.03,  maxLev: 8,  sector: '新能源与制造' },
  { code: 'QH-LI',   name: '锂',                track: 'commodity', regime_engine: 'bull_bear',  basePrice: 1000,   mult: 20,   vol: 0.06,  maxLev: 8,  sector: '新能源与制造' },
  { code: 'QH-SOY',  name: '大豆',              track: 'commodity', regime_engine: 'event_spike',basePrice: 400,    mult: 20,   vol: 0.02,  maxLev: 10, sector: '周期与基础' },
  { code: 'QH-AU',   name: '黄金',              track: 'commodity', regime_engine: 'gold_reuse', basePrice: 800,    mult: 30,   vol: 0.02,  maxLev: 10, sector: null },
  { code: 'QH-IDXG', name: '天际100',           track: 'index',     regime_engine: 'overseas3',  basePrice: 5000,   mult: 5,    vol: 0.035, maxLev: 8,  sector: null },
  { code: 'QH-IDXV', name: 'AC500',             track: 'index',     regime_engine: 'overseas3',  basePrice: 8000,   mult: 5,    vol: 0.015, maxLev: 12, sector: null },
  { code: 'QH-CRA',  name: 'S币',               track: 'crypto',    regime_engine: 'crypto',     basePrice: 360000, mult: 1,    vol: 0.025, maxLev: 8,  sector: null },
  { code: 'QH-CRB',  name: '花剑币',            track: 'crypto',    regime_engine: 'crypto',     basePrice: 12000,  mult: 1,    vol: 0.03,  maxLev: 8,  sector: null },
  { code: 'QH-FX',   name: 'Champion Dollar',   track: 'fx',        regime_engine: 'rate_cycle', basePrice: 7,      mult: 5000, vol: 0.008, maxLev: 12, sector: null }
];

const FUTURES_REGIME_PARAMS = {
  overseas3: {
    bull_drift: 0.003, bear_drift: -0.002, crisis_drift: -0.010,
    bull_dur_days: [2, 8], bear_dur_days: [3, 10], crisis_dur_days: [1, 3],
    crisis_chance: 0.12,
    daily_ticks: 8
  },
  bull_bear: {
    bull_drift: 0.0015, bear_drift: -0.0015,
    dur_days: [3, 10], daily_ticks: 8
  },
  event_spike: {
    spike_magnitude: 0.12
  },
  crypto: {
    calm_drift: 0, shock_magnitude_range: [0.10, 0.35],
    calm_dur_days: [5, 15], shock_dur_ticks: [1, 3],
    ignite_threshold: 0.05, p_reverse: 0.15, daily_ticks: 8
  },
  rate_cycle: {
    hike_drift: 0.0008, cut_drift: -0.0008,
    dur_days: [5, 15], daily_ticks: 8
  }
};

const FUTURES_SECTOR_NEWS_MAP = {
  '资源能源': { code: 'QH-OIL',  coefficient: 0.5 },
  '新能源与制造': { code: 'QH-CU', coefficient: 0.4 },
  '新能源车': { code: 'QH-LI', coefficient: 0.4 },
  '农业': { code: 'QH-SOY', coefficient: 0.4 }
};

const RISK_DYNAMICS = {
  low: { reversion: 1.25, enterChance: 0.65, duration: 0.75, trendBias: 0.75 },
  mid: { reversion: 1, enterChance: 1, duration: 1, trendBias: 1 },
  high: { reversion: 0.75, enterChance: 1.35, duration: 1.25, trendBias: 1.2 }
};

function rollMacroSentiment() {
  return (Math.random() * 2 - 1) * 0.007;
}

function rollSectorSentiment() {
  return (Math.random() * 2 - 1) * 0.013;
}

function clampImpact(value, limit) {
  return Math.max(-limit, Math.min(limit, value));
}

function computeOrderFlowImpact(summary = {}) {
  const buyQuantity = Number(summary.buyQuantity || 0);
  const sellQuantity = Number(summary.sellQuantity || 0);
  const totalQuantity = buyQuantity + sellQuantity;
  if (totalQuantity <= 0) return 0;
  const imbalance = (buyQuantity - sellQuantity) / (totalQuantity + RULES.ORDER_FLOW_LIQUIDITY_BASE);
  return Number(clampImpact(imbalance * RULES.ORDER_FLOW_IMPACT_SCALE, RULES.ORDER_FLOW_IMPACT_LIMIT).toFixed(6));
}

function computeSpringPull(relDev, kEff) {
  return -kEff * relDev - RULES.REVERSION_SUPERLINEAR * relDev * Math.abs(relDev);
}

function anchorWalkStep() {
  return (Math.random() * 2 - 1) * RULES.ANCHOR_STEP_VOL;
}

function computeAnchorTether(anchor, longRunRef) {
  return RULES.ANCHOR_TETHER * (longRunRef / anchor - 1);
}

function computeFundStrategyScore(strategy, metrics = {}) {
  const recent = Number(metrics.recent || 0);
  const one = Number(metrics.one || 0);
  const volatility = Number(metrics.volatility || 0);
  const scale = RULES.FUND_STRATEGY_SIGNAL_SCALE;
  if (strategy === 'momentum') return scale * (recent * 100 + one * 20);
  if (strategy === 'contrarian') return scale * (-recent * 100 - volatility * 5);
  if (strategy === 'value') {
    const relToAnchor = Number(metrics.relToAnchor || 0);
    const cheap = Math.max(0, -relToAnchor);            // 低于公允价多少 = 便宜程度
    const stabilizing = one >= 0 ? 1 : 0.35;            // 还在跌就大幅降权，等企稳再进
    return scale * (cheap * 75 * stabilizing + one * 50 - volatility * 8);
  }
  if (strategy === 'trending') return scale * (recent * 120 + one * 15);
  return 1 - volatility;
}

function computeNextPrice(prev, stock, ctx = {}) {
  const sentiment = Number(ctx.marketSentiment || 0);
  const vol = Number(stock.volatility || 0.03);
  const personality = RISK_DYNAMICS[stock.risk_level] || RISK_DYNAMICS.mid;
  let base = (Math.random() * 2 - 1) * vol;
  const anchor = Number(ctx.anchor || stock.initial_price);
  const regime = ctx.regime || 'oscillation';

  if (anchor > 0) {
    const relDev = (prev.close - anchor) / anchor;
    const kEff = RULES.REVERSION_K * personality.reversion
      * (regime === 'trend' ? RULES.TREND_SPRING_DAMP : 1);
    const absDev = Math.abs(relDev);
    const safetyCap = absDev > 0.25;
    if (Math.random() < RULES.SPRING_TRIGGER_PROBABILITY || safetyCap) {
      const k = safetyCap ? RULES.REVERSION_K : kEff;
      base += computeSpringPull(relDev, k);
    }
  }

  if (regime === 'trend') {
    base += Number(ctx.trendBias || 0);
  } else {
    const streak = Number(ctx.streak || 0);
    if (Math.abs(streak) >= 2
        && Math.sign(base) === Math.sign(streak)
        && Math.random() < Math.min(0.05 * Math.abs(streak), 0.5)) {
      base = -base;
    }
  }

  base += Number(ctx.matthewBias || 0);
  let changePct = base + sentiment + Number(ctx.newsImpact || 0) + Number(ctx.orderFlowImpact || 0)
    + ((vol * vol) / 10 + RULES.PRICE_DRIFT_BUFFER);
  changePct = clampImpact(changePct, RULES.PRICE_LIMIT);
  const close = Math.max(0.01, Number((prev.close * (1 + changePct)).toFixed(2)));
  const open = Number(prev.close);
  const high = Number(Math.max(open, close, close * (1 + Math.random() * 0.005)).toFixed(2));
  const low = Math.max(0.01, Number(Math.min(open, close, close * (1 - Math.random() * 0.005)).toFixed(2)));
  return { open, close, high, low, change_pct: Number(changePct.toFixed(4)) };
}

module.exports = {
  DEFAULT_STOCKS,
  DEFAULT_FUNDS,
  DEFAULT_FUTURES,
  FUTURES_REGIME_PARAMS,
  FUTURES_SECTOR_NEWS_MAP,
  SECTORS,
  STOCKS: DEFAULT_STOCKS,
  RULES,
  RISK_DYNAMICS,
  computeOrderFlowImpact,
  computeSpringPull,
  computeAnchorTether,
  computeFundStrategyScore,
  anchorWalkStep,
  computeNextPrice,
  rollMacroSentiment,
  rollSectorSentiment
};

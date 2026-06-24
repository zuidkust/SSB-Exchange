const {
  DEFAULT_FUNDS,
  DEFAULT_STOCKS,
  computeFundStrategyScore,
  computeNextPrice,
  computeAnchorTether,
  RISK_DYNAMICS,
  RULES
} = require('./data');

const PATHS_PER_TIER = 30000;
const STEPS = 120;
const MANAGER_ALPHA_LIMIT = 0.001;
const MANAGER_ALPHA_SPREAD_LIMIT = 0.00055;

function assert(condition, label) {
  if (!condition) throw new Error(`FAIL: ${label}`);
}

function simulateTier(riskLevel, volatility) {
  let wins = 0;
  let totalRatio = 0;
  let farCount = 0;

  for (let path = 0; path < PATHS_PER_TIER; path += 1) {
    let close = 100;
    let anchor = 100;
    let streak = 0;
    let regime = 'oscillation';
    let trendDir = 0;
    let trendRemaining = 0;
    let trendTotal = 0;
    const personality = RISK_DYNAMICS[riskLevel];
    for (let step = 0; step < STEPS; step += 1) {
      if (regime === 'trend') {
        trendRemaining -= 1;
        if (trendRemaining <= 0) {
          if (Math.random() < RULES.TREND_CONTINUE_PROBABILITY) {
            const extension = RULES.TREND_DUR_MIN
              + Math.floor(Math.random() * (RULES.TREND_DUR_MAX - RULES.TREND_DUR_MIN + 1));
            trendRemaining = Math.max(2, Math.round(extension * personality.duration));
            trendTotal = Number(trendTotal || 0) + trendRemaining;
          } else {
            regime = 'oscillation';
            trendDir = 0;
            trendTotal = 0;
          }
        }
      }
      if (regime === 'oscillation' && Math.random() < RULES.TREND_ENTER_CHANCE * personality.enterChance) {
        regime = 'trend';
        trendDir = Math.random() < 0.5 ? -1 : 1;
        const baseDuration = RULES.TREND_DUR_MIN
          + Math.floor(Math.random() * (RULES.TREND_DUR_MAX - RULES.TREND_DUR_MIN + 1));
        trendRemaining = Math.max(2, Math.round(baseDuration * personality.duration));
        trendTotal = trendRemaining;
      }
      const catchup = regime === 'trend'
        ? Math.max(-0.02, Math.min(0.02, RULES.TREND_ANCHOR_CATCHUP * ((close - anchor) / anchor)))
        : 0;
      anchor *= 1 + (Math.random() * 2 - 1) * RULES.ANCHOR_STEP_VOL + computeAnchorTether(anchor, 100) + catchup;
      const fade = trendTotal > 0 ? trendRemaining / trendTotal : 0;
      const next = computeNextPrice({ close }, { volatility, initial_price: 100, risk_level: riskLevel }, {
        anchor,
        regime,
        streak,
        trendBias: regime === 'trend' ? trendDir * RULES.TREND_BIAS * personality.trendBias * fade : 0
      });
      const direction = Math.sign(next.change_pct);
      streak = direction === 0 ? 0 : (Math.sign(streak) === direction ? streak + direction : direction);
      close = next.close;
    }
    if (close > 100) wins += 1;
    totalRatio += close / 100;
    if (close < 50 || close > 200) farCount += 1;
  }

  return {
    winRate: wins / PATHS_PER_TIER,
    meanRatio: totalRatio / PATHS_PER_TIER,
    farRate: farCount / PATHS_PER_TIER
  };
}

function cappedWeights(scored, cashWeight = 0) {
  const cap = RULES.FUND_ACTIVE_SINGLE_CAP;
  const investable = 1 - cashWeight;
  const minScore = Math.min(...scored.map((item) => item.score));
  const result = scored.map((item) => ({
    index: item.index,
    raw: Math.max(0.0001, item.score - minScore + 0.1),
    weight: 0
  }));
  let remaining = investable;
  let pool = result.slice();
  while (pool.length && remaining > 1e-9) {
    const totalRaw = pool.reduce((sum, item) => sum + item.raw, 0);
    const nextPool = [];
    let allocated = 0;
    for (const item of pool) {
      const add = Math.min(remaining * item.raw / totalRaw, cap - item.weight);
      item.weight += add;
      allocated += add;
      if (item.weight < cap - 1e-9) nextPool.push(item);
    }
    remaining -= allocated;
    if (allocated <= 1e-9) break;
    pool = nextPool;
  }
  return { weights: result, cashWeight: cashWeight + Math.max(0, remaining) };
}

function stepObservedStock(state) {
  const next = computeNextPrice({ close: state.close }, state.stock, {
    anchor: 100,
    regime: state.regime,
    trendBias: state.regime === 'trend' ? state.trendDir * RULES.TREND_BIAS : 0,
    streak: state.streak
  });
  const direction = Math.sign(next.change_pct);
  return {
    ...state,
    previous: state.close,
    close: next.close,
    streak: direction === 0 ? 0 : (Math.sign(state.streak) === direction ? state.streak + direction : direction)
  };
}

function resolveFundBasket(fund) {
  let rule = {};
  try { rule = JSON.parse(fund.basket_json || '{}'); } catch { return []; }
  if (rule.all) return DEFAULT_STOCKS.slice();
  if (rule.by === 'sector') return DEFAULT_STOCKS.filter((stock) => stock.sector === rule.value);
  if (rule.by === 'risk') return DEFAULT_STOCKS.filter((stock) => stock.risk_level === rule.value);
  return [];
}

function simulateImplementedManagerAlpha() {
  const activeFunds = DEFAULT_FUNDS.filter((fund) => fund.manage_mode === 'active');
  const excess = Object.fromEntries(activeFunds.map((fund) => [fund.code, 0]));
  for (let path = 0; path < PATHS_PER_TIER; path += 1) {
    for (const fund of activeFunds) {
      const basket = resolveFundBasket(fund);
      let states = basket.map((stock, index) => ({
        index,
        stock: { ...stock, initial_price: 100 },
        volatility: Number(stock.volatility),
        regime: Math.random() < 0.28 ? 'trend' : 'oscillation',
        trendDir: Math.random() < 0.5 ? -1 : 1,
        close: 100,
        previous: 100,
        streak: 0
      }));
      for (let step = 0; step < 3; step += 1) states = states.map(stepObservedStock);
      const observed = states.map((state) => ({
        ...state,
        one: state.close / state.previous - 1,
        recent: state.close / 100 - 1
      }));
      const nextStates = states.map(stepObservedStock);
      const nextReturns = nextStates.map((state, index) => state.close / states[index].close - 1);
      const equalReturn = nextReturns.reduce((sum, value) => sum + value, 0) / basket.length;
      const averageRecent = observed.reduce((sum, stock) => sum + stock.recent, 0) / basket.length;
      const cashWeight = fund.strategy === 'contrarian' && averageRecent < 0
        ? Math.min(0.4, Math.abs(averageRecent) * 4)
        : 0;
      const allocation = cappedWeights(observed.map((stock) => ({
        index: stock.index,
        score: computeFundStrategyScore(fund.strategy, stock)
      })), cashWeight);
      const portfolioReturn = allocation.weights.reduce((sum, item) => sum + item.weight * nextReturns[item.index], 0)
        + allocation.cashWeight * RULES.MONEY_FUND_RATE;
      const equalWeight = 1 / basket.length;
      const turnover = allocation.weights.reduce((sum, item) => sum + Math.abs(item.weight - equalWeight), 0)
        + allocation.cashWeight;
      excess[fund.code] += portfolioReturn - fund.mgmt_fee_rate - RULES.TURNOVER_COST * turnover - equalReturn;
    }
  }
  return Object.fromEntries(activeFunds.map((fund) => [fund.code, excess[fund.code] / PATHS_PER_TIER]));
}

function main() {
  const results = {
    low: simulateTier('low', 0.025),
    mid: simulateTier('mid', 0.05),
    high: simulateTier('high', 0.09)
  };

  for (const [tier, result] of Object.entries(results)) {
    assert(result.winRate > 0.42 && result.winRate < 0.72, `${tier} holding win rate remains plausible`);
    assert(result.meanRatio > 0.92 && result.meanRatio < 1.25, `${tier} long-run mean price remains stable`);
    assert(result.farRate < 0.08, `${tier} extreme long-run price escapes remain rare`);
  }

  const managerAlpha = simulateImplementedManagerAlpha();
  for (const [fundCode, alpha] of Object.entries(managerAlpha)) {
    assert(Math.abs(alpha) < MANAGER_ALPHA_LIMIT, `${fundCode} manager alpha stays near zero after fees and turnover`);
  }
  const managerAlphaValues = Object.values(managerAlpha);
  const managerAlphaSpread = Math.max(...managerAlphaValues) - Math.min(...managerAlphaValues);
  assert(managerAlphaSpread < MANAGER_ALPHA_SPREAD_LIMIT, 'active manager alpha spread stays within the fairness gate');
  assert(RULES.MONEY_FUND_RATE < RULES.LOAN_TIER1_RATE, 'money fund yield stays below the cheapest borrowing cost');
  console.log('calibration checks ok', JSON.stringify({
    paths_per_tier: PATHS_PER_TIER,
    results,
    manager_alpha: managerAlpha,
    manager_alpha_spread: managerAlphaSpread
  }));
}

main();

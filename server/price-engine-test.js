const {
  computeNextPrice,
  computeSpringPull,
  computeAnchorTether,
  RULES
} = require('./data');
const news = require('./news');

function assert(condition, label) {
  if (!condition) throw new Error(`FAIL: ${label}`);
}

function approx(actual, expected, tolerance, label) {
  assert(Math.abs(actual - expected) <= tolerance, `${label} (got ${actual}, expected ${expected})`);
}

function withFixedRandom(value, fn) {
  const original = Math.random;
  Math.random = () => value;
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

function withRandomSequence(values, fn) {
  let index = 0;
  const original = Math.random;
  Math.random = () => values[index++ % values.length];
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

function main() {
  const stock = { volatility: 0.04, initial_price: 100, risk_level: 'mid' };

  const drift = withFixedRandom(0.5, () => computeNextPrice({ close: 100 }, stock, {
    anchor: 100
  }));
  assert(drift.close > 100 && drift.close < 100.2, 'small positive drift remains');

  assert(computeSpringPull(0.5, RULES.REVERSION_K) < 0, 'spring pulls an overvalued price down');
  assert(computeSpringPull(-0.4, RULES.REVERSION_K) > 0, 'spring pulls an undervalued price up');
  assert(Math.abs(computeSpringPull(0.5, RULES.REVERSION_K)) > Math.abs(computeSpringPull(0.2, RULES.REVERSION_K)) * 2,
    'spring becomes superlinear at large deviations');
  assert(computeAnchorTether(120, 100) < 0, 'anchor tether pulls a high anchor down');
  assert(computeAnchorTether(80, 100) > 0, 'anchor tether pulls a low anchor up');

  const highPrice = withFixedRandom(0.5, () => computeNextPrice({ close: 150 }, stock, {
    anchor: 100,
    regime: 'oscillation'
  }));
  const lowPrice = withFixedRandom(0.5, () => computeNextPrice({ close: 60 }, stock, {
    anchor: 100,
    regime: 'oscillation'
  }));
  assert(highPrice.close < 150, 'dynamic anchor mean reversion lowers a high price');
  assert(lowPrice.close > 60, 'dynamic anchor mean reversion raises a low price');

  const oscillation = withFixedRandom(0.5, () => computeNextPrice({ close: 150 }, stock, {
    anchor: 100,
    regime: 'oscillation'
  }));
  const trend = withFixedRandom(0.5, () => computeNextPrice({ close: 150 }, stock, {
    anchor: 100,
    regime: 'trend',
    trendBias: 0.004
  }));
  assert(trend.close > oscillation.close, 'trend regime damps the spring and retains directional movement');

  const reversedStreak = withRandomSequence([0.9, 0.9, 0.1, 0.5, 0.5], () => computeNextPrice({ close: 100 }, stock, {
    anchor: 100,
    regime: 'oscillation',
    streak: 5
  }));
  const continuedStreak = withRandomSequence([0.9, 0.9, 0.9, 0.5, 0.5], () => computeNextPrice({ close: 100 }, stock, {
    anchor: 100,
    regime: 'oscillation',
    streak: 5
  }));
  assert(reversedStreak.close < 100, 'long streak can softly reverse');
  assert(continuedStreak.close > 100, 'long streak does not reverse deterministically');

  const realNews = {
    id: 1,
    truth_type: 'real_bullish',
    visible_sentiment: 'bullish',
    target_type: 'industry',
    target_code: '半导体',
    chain: 'tech',
    impact_magnitude: 0.08,
    impact_start_tick: 2,
    impact_duration_ticks: 4,
    is_rumor: 0
  };
  approx(news.calculateRealNewsImpactIncrement(realNews, 'SSB005', '半导体', 2), 0.02, 1e-9,
    'direct real news pushes the anchor incrementally');
  approx(news.calculateRealNewsImpactIncrement(realNews, 'SSB005', '半导体', 3), 0.02, 1e-9,
    'direct real news increment is stable across active ticks');
  const linkedFirst = news.calculateRealNewsImpactIncrement(realNews, 'SSB015', '通信', 2);
  const linkedSecond = news.calculateRealNewsImpactIncrement(realNews, 'SSB015', '通信', 3);
  approx(linkedFirst, linkedSecond, 1e-9, 'industry-chain anchor increment uses a stable linkage ratio');
  assert(news.calculateRealNewsImpactIncrement({ ...realNews, truth_type: 'fake_bullish' }, 'SSB005', '半导体', 2) === 0,
    'fake news never pushes the anchor');

  const extremeBear = withFixedRandom(0, () => computeNextPrice({ close: 100 }, { ...stock, volatility: 0.5 }, {
    anchor: 100,
    marketSentiment: -0.02,
    newsImpact: -1,
    orderFlowImpact: -0.02
  }));
  const extremeBull = withFixedRandom(1, () => computeNextPrice({ close: 100 }, { ...stock, volatility: 0.5 }, {
    anchor: 100,
    marketSentiment: 0.02,
    newsImpact: 1,
    orderFlowImpact: 0.02
  }));
  assert(extremeBear.close >= 100 * (1 - RULES.PRICE_LIMIT) - 0.01, 'downward price limit remains');
  assert(extremeBull.close <= 100 * (1 + RULES.PRICE_LIMIT) + 0.01, 'upward price limit remains');

  console.log('dynamic price engine checks ok');
}

main();

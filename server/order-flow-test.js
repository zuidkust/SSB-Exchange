const { computeNextPrice, computeOrderFlowImpact, RULES } = require('./data');

function assert(condition, label) {
  if (!condition) throw new Error(`Assertion failed: ${label}`);
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

function main() {
  assert(typeof computeOrderFlowImpact === 'function', 'computeOrderFlowImpact is exported');
  assert(RULES.ORDER_FLOW_IMPACT_LIMIT > 0, 'order flow impact limit is configured');

  const bullishImpact = computeOrderFlowImpact({ buyQuantity: 1200, sellQuantity: 0 });
  const bearishImpact = computeOrderFlowImpact({ buyQuantity: 0, sellQuantity: 1200 });
  const flatImpact = computeOrderFlowImpact({ buyQuantity: 500, sellQuantity: 500 });
  const extremeImpact = computeOrderFlowImpact({ buyQuantity: 100000, sellQuantity: 0 });

  assert(bullishImpact > 0, 'net buy order flow produces positive impact');
  assert(bearishImpact < 0, 'net sell order flow produces negative impact');
  assert(flatImpact === 0, 'balanced order flow produces zero impact');
  assert(extremeImpact <= RULES.ORDER_FLOW_IMPACT_LIMIT, 'positive impact is capped');
  assert(Math.abs(bearishImpact) <= RULES.ORDER_FLOW_IMPACT_LIMIT, 'negative impact is capped');

  const prev = { close: 100 };
  const stock = { volatility: 0 };

  const bullishPrice = withFixedRandom(0.5, () => computeNextPrice(prev, stock, {
    marketSentiment: 0,
    newsImpact: 0,
    orderFlowImpact: bullishImpact
  }));
  const bearishPrice = withFixedRandom(0.5, () => computeNextPrice(prev, stock, {
    marketSentiment: 0,
    newsImpact: 0,
    orderFlowImpact: bearishImpact
  }));

  assert(bullishPrice.close > prev.close, 'bullish order flow pushes next price up');
  assert(bearishPrice.close < prev.close, 'bearish order flow pushes next price down');

  console.log('order flow pricing ok');
}

main();

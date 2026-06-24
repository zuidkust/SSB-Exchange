const os = require('node:os');
const path = require('node:path');

process.env.SSB_DB_PATH = path.join(os.tmpdir(), `ssb_fund_engine_${process.pid}_${Date.now()}.sqlite`);

const db = require('./db');
const funds = require('./funds');
const { RULES } = require('./data');

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

function seedNextPrices(stocks) {
  for (const stock of stocks) {
    const current = db.get(`SELECT close FROM stock_prices WHERE stock_code = ${db.q(stock.code)} AND tick = 1;`);
    const multiplier = stock.code === 'SSB005' ? 1.1 : 1;
    const close = Number((Number(current.close) * multiplier).toFixed(2));
    db.exec(`INSERT INTO stock_prices
      (stock_code, tick, open, close, high, low, anchor, change_pct, created_at)
      VALUES (${db.q(stock.code)}, 2, ${current.close}, ${close}, ${close}, ${close},
        ${stock.initial_price}, ${Number((multiplier - 1).toFixed(4))}, datetime('now'));`);
  }
}

function main() {
  db.resetDb();
  const stocks = db.all('SELECT * FROM stocks ORDER BY code;');
  assert(stocks.length === 36, 'fresh catalog contains 36 stocks');
  assert(stocks.every((stock) => stock.sector), 'every stock has a first-level sector');
  assert(stocks.every((stock) => stock.sector !== '科技(TMT)'), 'stock catalog uses the final technology sector name');
  assert(db.get(`SELECT name FROM stocks WHERE code = 'SSB021';`).name === '朗宗电子',
    'fresh catalog uses finalized new-stock names');
  const finalFundCodes = ['DB01', 'DB02', 'GD01', 'GD02', 'GD03', 'SH01', 'SH02', 'SH03', 'TY01', 'TY02', 'TY03'];
  assert(JSON.stringify(funds.getFunds().map((fund) => fund.code)) === JSON.stringify(finalFundCodes),
    'fresh catalog contains only the 11 finalized fund codes');
  const initialFundList = funds.getFundsList(1);
  assert(initialFundList.every((fund) => fund.nav === 1 && fund.has_performance === false && fund.inception_change === 0),
    'fresh funds share a 1.0000 unit NAV and have no first-period performance yet');
  const initialIndexDetail = funds.getFundDetail('GD01', 1, stocks);
  assert(initialIndexDetail.component_count === 20 && /20 只股票价格加权配置/.test(initialIndexDetail.composition_summary),
    'narrow index explains its 20-stock price-weight basket');
  const initialBlueDetail = funds.getFundDetail('SH01', 1, stocks);
  assert(initialBlueDetail.component_count === 6 && initialBlueDetail.weights.length === 6,
    'blue-chip passive fund exposes all low-risk components');
  const initialOverseasDetail = funds.getFundDetail('TY03', 1, stocks);
  assert(/海外市场资产/.test(initialOverseasDetail.asset_description),
    'independent fund detail explains its external asset source');

  const migrationUser = db.get('SELECT * FROM users WHERE is_admin = 1 LIMIT 1;');
  db.exec(`INSERT INTO funds SELECT 'SSBF-TECH', name, type, category, basket_json, base_nav, volatility,
    params_json, risk_level, fee_free, redeem_t0, manage_mode, strategy, manager_name, mgmt_fee_rate
    FROM funds WHERE code = 'TY01';`);
  db.exec(`INSERT OR IGNORE INTO fund_nav
    (fund_code, tick, nav, change_pct, turnover_cost, created_at)
    SELECT 'SSBF-TECH', tick, nav, change_pct, turnover_cost, created_at FROM fund_nav WHERE fund_code = 'TY01';`);
  db.exec(`INSERT OR IGNORE INTO fund_weight
    (fund_code, tick, stock_code, weight)
    SELECT 'SSBF-TECH', tick, stock_code, weight FROM fund_weight WHERE fund_code = 'TY01';`);
  db.exec(`INSERT INTO fund_holdings
    (id, user_id, fund_code, shares, available_shares, avg_nav, updated_at)
    VALUES (${db.q(`${migrationUser.id}_SSBF-TECH`)}, ${db.q(migrationUser.id)}, 'SSBF-TECH', 10, 5, 1, datetime('now'));`);
  db.exec(`INSERT INTO fund_transactions
    (user_id, fund_code, type, shares, nav, amount, fee, tick, created_at)
    VALUES (${db.q(migrationUser.id)}, 'SSBF-TECH', 'buy', 10, 1, 10, 0, 1, datetime('now'));`);
  db.migrateFundCodeReferences('SSBF-TECH', 'TY01');
  assert(!db.get(`SELECT * FROM funds WHERE code = 'SSBF-TECH';`), 'legacy fund row is removed when final code already exists');
  assert(!db.get(`SELECT * FROM fund_nav WHERE fund_code = 'SSBF-TECH';`)
    && !db.get(`SELECT * FROM fund_weight WHERE fund_code = 'SSBF-TECH';`)
    && !db.get(`SELECT * FROM fund_holdings WHERE fund_code = 'SSBF-TECH';`)
    && !db.get(`SELECT * FROM fund_transactions WHERE fund_code = 'SSBF-TECH';`),
  'legacy fund references migrate without leaving duplicate catalogs');
  assert(db.get(`SELECT * FROM fund_holdings WHERE user_id = ${db.q(migrationUser.id)} AND fund_code = 'TY01';`),
    'legacy holding migrates to the finalized fund code');
  db.exec(`DELETE FROM fund_holdings WHERE user_id = ${db.q(migrationUser.id)} AND fund_code = 'TY01';`);
  db.exec(`DELETE FROM fund_transactions WHERE user_id = ${db.q(migrationUser.id)} AND fund_code = 'TY01';`);

  const capped = funds.normalizeCappedWeights([
    { stockCode: 'A', score: 10 },
    { stockCode: 'B', score: 2 },
    { stockCode: 'C', score: 1 },
    { stockCode: 'D', score: 0 }
  ]);
  approx(capped.reduce((sum, item) => sum + item.weight, 0), 1, 1e-8, 'active weights sum to one');
  assert(capped.filter((item) => item.stockCode !== funds.CASH_CODE).every((item) => item.weight <= 0.35 + 1e-9),
    'active single-stock weights respect the 35% cap');

  const capacityLimited = funds.normalizeCappedWeights([
    { stockCode: 'A', score: 2 },
    { stockCode: 'B', score: 1 }
  ]);
  const capacityCash = capacityLimited.find((item) => item.stockCode === funds.CASH_CODE);
  assert(capacityCash && capacityCash.weight >= 0.299999, 'uninvestable residual becomes cash instead of breaking the cap');

  seedNextPrices(stocks);
  const active = funds.getFund('TY01');
  const oldWeights = funds.getLatestWeights(active.code, 1);
  const currentMap = Object.fromEntries(db.all('SELECT stock_code, close FROM stock_prices WHERE tick = 1;')
    .map((row) => [row.stock_code, Number(row.close)]));
  const nextMap = Object.fromEntries(db.all('SELECT stock_code, close FROM stock_prices WHERE tick = 2;')
    .map((row) => [row.stock_code, Number(row.close)]));
  const oldReturn = oldWeights.reduce((sum, item) => {
    return sum + item.weight * (nextMap[item.stockCode] / currentMap[item.stockCode] - 1);
  }, 0);
  const targetWeights = funds.rebalanceActiveFund(active, 2, stocks);
  const turnover = funds.turnoverBetween(oldWeights, targetWeights);
  const expectedNav = Number((1 + oldReturn - active.mgmt_fee_rate - RULES.TURNOVER_COST * turnover).toFixed(4));

  withFixedRandom(0.5, () => funds.advanceFundNavs({
    currentTick: 1,
    nextTick: 2,
    stocks,
    shouldRebalance: true
  }));
  const activeNav = db.get(`SELECT * FROM fund_nav WHERE fund_code = ${db.q(active.code)} AND tick = 2;`);
  approx(Number(activeNav.nav), expectedNav, 1e-9, 'active NAV uses previous weights, management fee, and turnover cost');
  const newWeights = funds.getLatestWeights(active.code, 2);
  assert(JSON.stringify(newWeights) !== JSON.stringify(oldWeights), 'active target weights take effect for the next period');

  const delayedDetail = funds.getFundDetail(active.code, 2, stocks);
  const delayedMap = Object.fromEntries(delayedDetail.weights.map((item) => [item.stock_code, item.weight]));
  for (const item of oldWeights) approx(delayedMap[item.stockCode], item.weight, 1e-8, 'active holdings display is delayed one period');
  const passiveDetail = funds.getFundDetail('GD01', 2, stocks);
  assert(passiveDetail.weights.length === 20, 'passive fund detail exposes its price-weight basket');
  approx(passiveDetail.weights.reduce((sum, item) => sum + item.weight, 0), 1, 1e-8, 'passive weights sum to one');
  const advancedFunds = funds.getFundsList(2);
  assert(advancedFunds.every((fund) => fund.has_performance), 'funds report inception performance after the first advance');
  assert(new Set(advancedFunds.map((fund) => fund.nav)).size >= 4, 'fund NAVs visibly diverge after the first advance');

  const user = db.get('SELECT * FROM users WHERE is_admin = 1 LIMIT 1;');
  db.exec(`UPDATE users SET cash = 10000 WHERE id = ${db.q(user.id)};`);
  const market = { current_tick: 2 };
  const indexNav = Number(db.get(`SELECT nav FROM fund_nav WHERE fund_code = 'GD01' AND tick = 2;`).nav);
  funds.tradeFund({ ...user, cash: 10000 }, {
    action: 'buy', fundCode: 'GD01', amount: 1000, expectedTick: 2, expectedNav: indexNav
  }, { market, tradingAllowed: true });
  const indexHolding = db.get(`SELECT * FROM fund_holdings WHERE user_id = ${db.q(user.id)} AND fund_code = 'GD01';`);
  approx(Number(indexHolding.shares), Number(((1000 - 1000 * RULES.FUND_FEE_RATE) / indexNav).toFixed(6)), 1e-6,
    'fund subscription uses six-decimal shares and total-cash-outflow semantics');
  assert(Number(indexHolding.available_shares) === 0, 'ordinary fund subscription is T+1');
  let blocked = false;
  try {
    funds.tradeFund(db.get(`SELECT * FROM users WHERE id = ${db.q(user.id)};`), {
      action: 'sell', fundCode: 'GD01', shares: 1, expectedTick: 2, expectedNav: indexNav
    }, { market, tradingAllowed: true });
  } catch (error) {
    blocked = /可赎回份额不足/.test(error.message);
  }
  assert(blocked, 'ordinary fund cannot be redeemed in the subscription period');

  const cashNav = Number(db.get(`SELECT nav FROM fund_nav WHERE fund_code = 'GD02' AND tick = 2;`).nav);
  funds.tradeFund(db.get(`SELECT * FROM users WHERE id = ${db.q(user.id)};`), {
    action: 'buy', fundCode: 'GD02', amount: 100, expectedTick: 2, expectedNav: cashNav
  }, { market, tradingAllowed: true });
  const cashHolding = db.get(`SELECT * FROM fund_holdings WHERE user_id = ${db.q(user.id)} AND fund_code = 'GD02';`);
  assert(Number(cashHolding.available_shares) === Number(cashHolding.shares), 'money fund is T+0');
  funds.tradeFund(db.get(`SELECT * FROM users WHERE id = ${db.q(user.id)};`), {
    action: 'sell', fundCode: 'GD02', shares: cashHolding.shares, expectedTick: 2, expectedNav: cashNav
  }, { market, tradingAllowed: true });
  assert(!db.get(`SELECT * FROM fund_holdings WHERE user_id = ${db.q(user.id)} AND fund_code = 'GD02';`),
    'money fund can be redeemed in the same period');

  const bondNav = Number(db.get(`SELECT nav FROM fund_nav WHERE fund_code = 'GD03' AND tick = 2;`).nav);
  funds.tradeFund(db.get(`SELECT * FROM users WHERE id = ${db.q(user.id)};`), {
    action: 'buy', fundCode: 'GD03', amount: 100.009, expectedTick: 2, expectedNav: bondNav
  }, { market, tradingAllowed: true });
  const roundedBuy = db.get(`SELECT * FROM fund_transactions WHERE user_id = ${db.q(user.id)}
    AND fund_code = 'GD03' ORDER BY id DESC LIMIT 1;`);
  assert(Number(roundedBuy.amount) === 100.01, 'subscription amount is normalized to cents before calculating shares');

  funds.releaseSettledShares();
  assert(Number(db.get(`SELECT available_shares FROM fund_holdings WHERE id = ${db.q(indexHolding.id)};`).available_shares)
    === Number(indexHolding.shares), 'ordinary fund shares settle after a tick');
  const bondHolding = db.get(`SELECT * FROM fund_holdings WHERE user_id = ${db.q(user.id)} AND fund_code = 'GD03';`);
  funds.tradeFund(db.get(`SELECT * FROM users WHERE id = ${db.q(user.id)};`), {
    action: 'sell',
    fundCode: 'GD03',
    shares: Number((Number(bondHolding.shares) - 0.000001).toFixed(6)),
    expectedTick: 2,
    expectedNav: bondNav
  }, { market, tradingAllowed: true });
  assert(Number(db.get(`SELECT shares FROM fund_holdings WHERE id = ${db.q(bondHolding.id)};`).shares) === 0.000001,
    'a one-microshare remainder is preserved instead of rounded away');

  for (const [code, shares] of [['SH01', 100], ['GD03', 100], ['GD02', 100]]) {
    db.exec(`INSERT OR REPLACE INTO fund_holdings
      (id, user_id, fund_code, shares, available_shares, avg_nav, updated_at)
      VALUES (${db.q(`${user.id}_${code}`)}, ${db.q(user.id)}, ${db.q(code)}, ${shares}, 0, 1, datetime('now'));`);
  }
  funds.liquidateFunds(user.id, 50, 2, 'low');
  const forced = db.get(`SELECT * FROM fund_transactions WHERE user_id = ${db.q(user.id)}
    AND type = 'forced_liquidation' ORDER BY id DESC LIMIT 1;`);
  assert(forced.fund_code === 'SH01', 'forced liquidation leaves bond and money funds until last');
  assert(Number(forced.fee) === 0, 'forced liquidation charges no fee');

  assert(RULES.MONEY_FUND_RATE < RULES.LOAN_TIER1_RATE, 'money fund cannot arbitrage the cheapest loan rate');
  console.log('fund engine checks ok');
}

main();

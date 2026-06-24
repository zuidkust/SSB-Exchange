const crypto = require('node:crypto');
const db = require('./db');
const clock = require('./clock');
const { RULES, computeFundStrategyScore } = require('./data');

const RISK_SCORE = { high: 3, mid: 2, low: 1 };
const CASH_CODE = 'CASH';
const MONEY_FUND_CODE = 'GD02';
const BOND_FUND_CODE = 'GD03';
const GOLD_FUND_CODE = 'SH03';
const LAST_RESORT_FUND_CODES = new Set([BOND_FUND_CODE, MONEY_FUND_CODE]);
const INDEPENDENT_ASSET_DESCRIPTIONS = {
  TY03: '模拟海外市场资产，净值独立于本地股票市场变化。',
  SH03: '跟踪黄金资产，与股市的关系随阶段切换：或避险反向、或风险同向、或独立震荡。',
  GD02: '配置货币类资产，净值按稳定收益逐期增长。',
  GD03: '配置债券类资产，票息缓慢累积，过程中伴随利率波动带来的涨跌起伏。'
};

const OVERSEAS_FUND_CODE = 'TY03';

function getFundRegime(fundCode) {
  const row = db.get(`SELECT * FROM fund_regime WHERE fund_code = ${db.q(fundCode)};`);
  if (!row) return null;
  return {
    regime: row.regime,
    regimeSinceTick: Number(row.regime_since_tick),
    regimeDurationTicks: Number(row.regime_duration_ticks)
  };
}

function ensureFundRegime(fundCode, currentTick) {
  const existing = getFundRegime(fundCode);
  if (existing && existing.regimeDurationTicks > 0) return existing;
  const dur = randomRegimeDuration('bull');
  if (existing) {
    db.exec(`UPDATE fund_regime
      SET regime = 'bull', regime_since_tick = ${currentTick}, regime_duration_ticks = ${dur}, updated_at = datetime('now')
      WHERE fund_code = ${db.q(fundCode)};`);
  } else {
    db.exec(`INSERT INTO fund_regime (fund_code, regime, regime_since_tick, regime_duration_ticks)
      VALUES (${db.q(fundCode)}, 'bull', ${currentTick}, ${dur});`);
  }
  return { regime: 'bull', regimeSinceTick: currentTick, regimeDurationTicks: dur };
}

function randomRegimeDuration(regime) {
  const ticksPerDay = RULES.FUND_REBALANCE_PERIOD_TICKS;
  if (regime === 'bull') {
    const days = 2 + Math.floor(Math.random() * 7);
    return days * ticksPerDay;
  }
  if (regime === 'bear') {
    const days = 3 + Math.floor(Math.random() * 8);
    return days * ticksPerDay;
  }
  const days = 1 + Math.floor(Math.random() * 3);
  return days * ticksPerDay;
}

function rollOverseasRegime(fundCode, tick) {
  const current = getFundRegime(fundCode);
  if (!current) return ensureFundRegime(fundCode, tick);

  const elapsed = tick - current.regimeSinceTick;
  if (elapsed < current.regimeDurationTicks) return current;

  const roll = Math.random();
  let nextRegime;

  if (current.regime === 'bull') {
    nextRegime = roll < RULES.OVERSEAS_CRISIS_CHANCE ? 'crisis' : 'bear';
  } else if (current.regime === 'bear') {
    nextRegime = roll < RULES.OVERSEAS_CRISIS_CHANCE ? 'crisis' : 'bull';
  } else {
    nextRegime = 'bull';
  }

  const dur = randomRegimeDuration(nextRegime);
  db.exec(`UPDATE fund_regime
    SET regime = ${db.q(nextRegime)},
        regime_since_tick = ${tick},
        regime_duration_ticks = ${dur},
        updated_at = datetime('now')
    WHERE fund_code = ${db.q(fundCode)};`);

  return { regime: nextRegime, regimeSinceTick: tick, regimeDurationTicks: dur };
}

function rollGoldRegime(fundCode, tick) {
  const current = getFundRegime(fundCode);
  if (!current) {
    const regimes = ['safe_haven', 'risk_on', 'idle'];
    const regime = regimes[Math.floor(Math.random() * regimes.length)];
    const dur = RULES.GOLD_REGIME_MIN_TICKS + Math.floor(Math.random() * (RULES.GOLD_REGIME_MAX_TICKS - RULES.GOLD_REGIME_MIN_TICKS + 1));
    db.exec(`INSERT INTO fund_regime (fund_code, regime, regime_since_tick, regime_duration_ticks)
      VALUES (${db.q(fundCode)}, ${db.q(regime)}, ${tick}, ${dur});`);
    return { regime, regimeSinceTick: tick, regimeDurationTicks: dur };
  }

  const elapsed = tick - current.regimeSinceTick;
  if (elapsed < current.regimeDurationTicks) return current;

  let nextRegime;
  const roll = Math.random();
  if (current.regime === 'safe_haven') {
    nextRegime = roll < 0.15 ? 'risk_on' : 'idle';
  } else if (current.regime === 'risk_on') {
    nextRegime = roll < 0.15 ? 'safe_haven' : 'idle';
  } else {
    nextRegime = roll < 0.55 ? 'safe_haven' : 'risk_on';
  }

  const dur = RULES.GOLD_REGIME_MIN_TICKS + Math.floor(Math.random() * (RULES.GOLD_REGIME_MAX_TICKS - RULES.GOLD_REGIME_MIN_TICKS + 1));
  db.exec(`UPDATE fund_regime
    SET regime = ${db.q(nextRegime)},
        regime_since_tick = ${tick},
        regime_duration_ticks = ${dur},
        updated_at = datetime('now')
    WHERE fund_code = ${db.q(fundCode)};`);
  return { regime: nextRegime, regimeSinceTick: tick, regimeDurationTicks: dur };
}

function getFunds() {
  return db.all('SELECT * FROM funds ORDER BY code ASC;').map(normalizeFund);
}

function getFund(code) {
  const row = db.get(`SELECT * FROM funds WHERE code = ${db.q(String(code || '').toUpperCase())};`);
  return row ? normalizeFund(row) : null;
}

function normalizeFund(row) {
  return {
    ...row,
    base_nav: Number(row.base_nav),
    volatility: row.volatility == null ? null : Number(row.volatility),
    fee_free: !!row.fee_free,
    redeem_t0: !!row.redeem_t0,
    mgmt_fee_rate: Number(row.mgmt_fee_rate || 0)
  };
}

function resolveBasketStocks(fund, stocks) {
  if (!fund.basket_json) return [];
  let rule = {};
  try { rule = JSON.parse(fund.basket_json); } catch { return []; }
  if (rule.all) return stocks.slice();
  if (rule.by === 'sector') return stocks.filter((stock) => stock.sector === rule.value);
  if (rule.by === 'risk') return stocks.filter((stock) => stock.risk_level === rule.value);
  if (rule.stocks && Array.isArray(rule.stocks)) {
    const codeSet = new Set(rule.stocks);
    return stocks.filter((stock) => codeSet.has(stock.code));
  }
  return [];
}

function getBasketWeighting(fund) {
  if (!fund.basket_json) return 'equal';
  let rule = {};
  try { rule = JSON.parse(fund.basket_json); } catch { return 'equal'; }
  return rule.weighting || 'equal';
}

function equalWeights(stocks) {
  if (!stocks.length) return [];
  const weight = 1 / stocks.length;
  return stocks.map((stock) => ({ stockCode: stock.code, weight }));
}

function priceWeights(basket, stocks) {
  if (!basket.length) return [];
  const priceMap = Object.fromEntries(stocks.map((s) => [s.code, s.initial_price]));
  const total = basket.reduce((sum, s) => sum + (priceMap[s.code] || 0), 0);
  if (total <= 0) return equalWeights(basket);
  return basket.map((s) => ({
    stockCode: s.code,
    weight: Number(((priceMap[s.code] || 0) / total).toFixed(8))
  }));
}

function getLatestWeights(fundCode, tick) {
  const latest = db.get(`SELECT MAX(tick) AS tick FROM fund_weight
    WHERE fund_code = ${db.q(fundCode)} AND tick <= ${Number(tick)};`);
  if (latest?.tick == null) return [];
  return db.all(`SELECT stock_code, weight FROM fund_weight
    WHERE fund_code = ${db.q(fundCode)} AND tick = ${Number(latest.tick)}
    ORDER BY stock_code;`).map((row) => ({ stockCode: row.stock_code, weight: Number(row.weight) }));
}

function writeWeights(fundCode, tick, weights) {
  db.exec(`DELETE FROM fund_weight WHERE fund_code = ${db.q(fundCode)} AND tick = ${Number(tick)};`);
  for (const item of weights) {
    if (item.weight <= 0) continue;
    db.exec(`INSERT INTO fund_weight (fund_code, tick, stock_code, weight)
      VALUES (${db.q(fundCode)}, ${Number(tick)}, ${db.q(item.stockCode)}, ${Number(item.weight.toFixed(8))});`);
  }
}

function ensureActiveFundWeights(fund, tick, stocks) {
  let weights = getLatestWeights(fund.code, tick);
  if (weights.length) return weights;
  weights = equalWeights(resolveBasketStocks(fund, stocks));
  writeWeights(fund.code, tick, weights);
  return weights;
}

function normalizeCappedWeights(scored, cap = RULES.FUND_ACTIVE_SINGLE_CAP, cashWeight = 0, strategy = null) {
  const investable = Math.max(0, 1 - cashWeight);
  if (!scored.length || investable <= 0) return cashWeight > 0 ? [{ stockCode: CASH_CODE, weight: cashWeight }] : [];
  const minScore = Math.min(...scored.map((item) => item.score));
  const floorMap = { momentum: 0.01, trending: 0.01, value: 0.16, contrarian: 0.02, balanced: 0.05 };
  const floor = floorMap[strategy] ?? 0.1;
  let remaining = investable;
  const result = scored.map((item) => ({ stockCode: item.stockCode, raw: Math.max(0.0001, item.score - minScore + floor), weight: 0 }));
  let pool = result.slice();

  while (pool.length && remaining > 1e-9) {
    const totalRaw = pool.reduce((sum, item) => sum + item.raw, 0) || pool.length;
    const nextPool = [];
    let allocated = 0;
    for (const item of pool) {
      const proposed = remaining * (item.raw / totalRaw);
      const room = Math.max(0, cap - item.weight);
      const add = Math.min(proposed, room);
      item.weight += add;
      allocated += add;
      if (item.weight < cap - 1e-9) nextPool.push(item);
    }
    remaining -= allocated;
    if (allocated <= 1e-9) break;
    pool = nextPool;
  }

  const normalized = result.map(({ stockCode, weight }) => ({ stockCode, weight }));
  const residualCash = Math.max(0, cashWeight + remaining);
  if (residualCash > 1e-9) normalized.push({ stockCode: CASH_CODE, weight: residualCash });
  return normalized;
}

function stockReturns(stockCode, tick, periods = 3) {
  const rows = db.all(`SELECT tick, close FROM stock_prices
    WHERE stock_code = ${db.q(stockCode)} AND tick <= ${Number(tick)}
    ORDER BY tick DESC LIMIT ${Math.max(2, periods + 1)};`).reverse();
  if (rows.length < 2) return { one: 0, recent: 0 };
  return {
    one: Number(rows[rows.length - 1].close) / Number(rows[rows.length - 2].close) - 1,
    recent: Number(rows[rows.length - 1].close) / Number(rows[0].close) - 1
  };
}

function strategyScore(fund, stock, tick) {
  const returns = stockReturns(stock.code, tick, 3);
  const row = db.get(`SELECT close, anchor FROM stock_prices
    WHERE stock_code = ${db.q(stock.code)} AND tick <= ${Number(tick)}
    ORDER BY tick DESC LIMIT 1;`);
  const close = Number(row?.close || 0);
  const anchor = Number(row?.anchor || close || 1);
  const relToAnchor = anchor > 0 ? (close - anchor) / anchor : 0;
  return computeFundStrategyScore(fund.strategy, { ...returns, volatility: stock.volatility, relToAnchor });
}

function rebalanceActiveFund(fund, tick, stocks) {
  const basket = resolveBasketStocks(fund, stocks);
  const scored = basket.map((stock) => ({ stockCode: stock.code, score: strategyScore(fund, stock, tick) }));
  const averageRecent = basket.length
    ? basket.reduce((sum, stock) => sum + stockReturns(stock.code, tick, 3).recent, 0) / basket.length
    : 0;
  let cashWeight = 0;
  if (fund.strategy === 'contrarian' && averageRecent < 0) {
    cashWeight = Math.min(0.4, Math.abs(averageRecent) * 4);
  }
  if (fund.strategy === 'value') {
    // 缓冲：篮子里还在下跌的越多，越多观望现金，等企稳再进场（不接飞刀）
    const fallingFrac = basket.length
      ? basket.filter((stock) => stockReturns(stock.code, tick, 3).one < 0).length / basket.length
      : 0;
    if (fallingFrac > 0.5) cashWeight = Math.min(0.5, (fallingFrac - 0.5) * 1.2);
  }
  return normalizeCappedWeights(scored, RULES.FUND_ACTIVE_SINGLE_CAP, cashWeight, fund.strategy);
}

function turnoverBetween(previous, next) {
  const map = {};
  for (const item of previous) map[item.stockCode] = Number(item.weight || 0);
  for (const item of next) map[item.stockCode] = Number(item.weight || 0) - Number(map[item.stockCode] || 0);
  return Object.values(map).reduce((sum, value) => sum + Math.abs(value), 0);
}

function latestNav(fundCode, tick) {
  return db.get(`SELECT * FROM fund_nav WHERE fund_code = ${db.q(fundCode)}
    AND tick <= ${Number(tick)} ORDER BY tick DESC LIMIT 1;`);
}

function fundPerformance(fund, tick, navRow = null) {
  const nav = Number(navRow?.nav || fund.base_nav);
  const count = Number(db.get(`SELECT COUNT(*) AS count FROM fund_nav
    WHERE fund_code = ${db.q(fund.code)} AND tick <= ${Number(tick)};`)?.count || 0);
  return {
    nav,
    has_performance: count >= 2,
    inception_change: Number((nav / Number(fund.base_nav || 1) - 1).toFixed(6))
  };
}

function advanceFundNavs({ currentTick, nextTick, stocks, shouldRebalance }) {
  const currentPrices = db.all(`SELECT stock_code, close FROM stock_prices WHERE tick = ${Number(currentTick)};`);
  const nextPrices = db.all(`SELECT stock_code, close FROM stock_prices WHERE tick = ${Number(nextTick)};`);
  const currentMap = Object.fromEntries(currentPrices.map((row) => [row.stock_code, Number(row.close)]));
  const nextMap = Object.fromEntries(nextPrices.map((row) => [row.stock_code, Number(row.close)]));
  const indexChange = stocks.length
    ? stocks.reduce((sum, stock) => sum + ((nextMap[stock.code] || currentMap[stock.code]) / currentMap[stock.code] - 1), 0) / stocks.length
    : 0;

  for (const fund of getFunds()) {
    const previousNav = Number(latestNav(fund.code, currentTick)?.nav || fund.base_nav);
    let portfolioReturn = 0;
    let turnoverCost = 0;

    if (fund.type === 'derived') {
      const basket = resolveBasketStocks(fund, stocks);
      const oldWeights = fund.manage_mode === 'active'
        ? ensureActiveFundWeights(fund, currentTick, stocks)
        : getBasketWeighting(fund) === 'price'
          ? priceWeights(basket, stocks)
          : equalWeights(basket);
      for (const item of oldWeights) {
        if (item.stockCode === CASH_CODE) {
          portfolioReturn += item.weight * RULES.MONEY_FUND_RATE;
          continue;
        }
        const previous = currentMap[item.stockCode];
        const next = nextMap[item.stockCode];
        if (previous > 0 && next > 0) portfolioReturn += item.weight * (next / previous - 1);
      }
      if (fund.manage_mode === 'active' && shouldRebalance) {
        const targetWeights = rebalanceActiveFund(fund, nextTick, stocks);
        turnoverCost = RULES.TURNOVER_COST * turnoverBetween(oldWeights, targetWeights);
        writeWeights(fund.code, nextTick, targetWeights);
      }
      portfolioReturn -= fund.mgmt_fee_rate + turnoverCost;
    } else if (fund.code === MONEY_FUND_CODE) {
      portfolioReturn = RULES.MONEY_FUND_RATE + (Math.random() * 2 - 1) * Number(fund.volatility || 0);
    } else if (fund.code === GOLD_FUND_CODE) {
      const ownMove = (Math.random() * 2 - 1) * Number(fund.volatility || 0.02);
      const regime = rollGoldRegime(fund.code, nextTick);
      if (regime.regime === 'safe_haven') {
        portfolioReturn = ownMove - RULES.GOLD_INVERSE_K * indexChange;
      } else if (regime.regime === 'risk_on') {
        portfolioReturn = ownMove + RULES.GOLD_RISK_ON_K * indexChange;
      } else {
        portfolioReturn = ownMove;
      }
    } else if (fund.code === OVERSEAS_FUND_CODE) {
      const regime = shouldRebalance
        ? rollOverseasRegime(fund.code, nextTick)
        : getFundRegime(fund.code) || ensureFundRegime(fund.code, nextTick);
      let drift = RULES.OVERSEAS_BULL_DRIFT;
      if (regime.regime === 'bear') drift = RULES.OVERSEAS_BEAR_DRIFT;
      else if (regime.regime === 'crisis') drift = RULES.OVERSEAS_CRISIS_DRIFT;
      const vol = RULES.OVERSEAS_VOL;
      portfolioReturn = drift + (Math.random() * 2 - 1) * vol;
    } else if (fund.code === BOND_FUND_CODE) {
      const vol = Number(fund.volatility || 0.008);
      const fairNav = Number(fund.base_nav) * (1 + RULES.BOND_COUPON_RATE * nextTick);
      const rw = (Math.random() * 2 - 1) * vol;
      const relDev = (previousNav - fairNav) / Math.max(0.001, fairNav);
      const springPull = -RULES.BOND_REVERSION_K * relDev;
      portfolioReturn = rw + springPull;
    } else {
      const vol = Number(fund.volatility || 0.03);
      portfolioReturn = (Math.random() * 2 - 1) * vol + (vol * vol) / 10 + RULES.PRICE_DRIFT_BUFFER;
    }

    const nav = Math.max(0.0001, Number((previousNav * (1 + portfolioReturn)).toFixed(4)));
    const changePct = Number((nav / previousNav - 1).toFixed(6));
    db.exec(`INSERT OR REPLACE INTO fund_nav
      (fund_code, tick, nav, change_pct, turnover_cost, created_at)
      VALUES (${db.q(fund.code)}, ${Number(nextTick)}, ${nav}, ${changePct}, ${Number(turnoverCost.toFixed(8))}, datetime('now'));`);
  }
}

function getFundsList(tick) {
  return getFunds().map((fund) => {
    const nav = latestNav(fund.code, tick) || { nav: fund.base_nav, change_pct: 0 };
    return {
      ...fund,
      ...fundPerformance(fund, tick, nav),
      change_pct: Number(nav.change_pct || 0)
    };
  });
}

function getFundDetail(code, tick, stocks) {
  const fund = getFund(code);
  if (!fund) throw new Error('基金不存在');
  const nav = latestNav(fund.code, tick) || { nav: fund.base_nav, change_pct: 0 };
  const history = db.all(`SELECT tick, nav, change_pct FROM (
    SELECT tick, nav, change_pct FROM fund_nav WHERE fund_code = ${db.q(fund.code)}
    ORDER BY tick DESC LIMIT 200
  ) ORDER BY tick ASC;`);
  const displayWeights = fund.type !== 'derived'
    ? []
    : fund.manage_mode === 'active'
      ? getLatestWeights(fund.code, Math.max(1, tick - 1))
      : getBasketWeighting(fund) === 'price'
        ? priceWeights(resolveBasketStocks(fund, stocks), stocks)
        : equalWeights(resolveBasketStocks(fund, stocks));
  const performance = fundPerformance(fund, tick, nav);
  const stockMap = Object.fromEntries(stocks.map((stock) => [stock.code, stock]));
  const componentCount = displayWeights.filter((item) => item.stockCode !== CASH_CODE).length;
  const compositionSummary = fund.type === 'derived' && fund.manage_mode === 'passive'
    ? (getBasketWeighting(fund) === 'price'
      ? `${componentCount} 只股票价格加权配置`
      : `${componentCount} 只股票等权配置${componentCount ? `，每只约 ${(100 / componentCount).toFixed(2)}%` : ''}`)
    : null;
  return {
    ...fund,
    ...performance,
    change_pct: Number(nav.change_pct || 0),
    history,
    component_count: componentCount,
    composition_summary: compositionSummary,
    asset_description: INDEPENDENT_ASSET_DESCRIPTIONS[fund.code] || null,
    weights: displayWeights.map((item) => ({
      stock_code: item.stockCode,
      stock_name: item.stockCode === CASH_CODE ? '现金仓位' : (stockMap[item.stockCode]?.name || item.stockCode),
      weight: item.weight
    })).sort((a, b) => b.weight - a.weight)
  };
}

function getFundStatus(userId, tick) {
  const funds = Object.fromEntries(getFundsList(tick).map((fund) => [fund.code, fund]));
  return db.all(`SELECT * FROM fund_holdings WHERE user_id = ${db.q(userId)} ORDER BY fund_code;`).map((holding) => {
    const fund = funds[holding.fund_code] || {};
    const nav = Number(fund.nav || holding.avg_nav || 0);
    return {
      ...holding,
      shares: Number(holding.shares),
      available_shares: Number(holding.available_shares),
      avg_nav: Number(holding.avg_nav),
      fund_name: fund.name || holding.fund_code,
      nav,
      value: Number((Number(holding.shares) * nav).toFixed(2)),
      profit: Number((Number(holding.shares) * (nav - Number(holding.avg_nav))).toFixed(2))
    };
  });
}

function tradeFund(user, body, options = {}) {
  const action = String(body.action || '');
  const fund = getFund(body.fundCode);
  const expectedTick = Number(body.expectedTick);
  const expectedNav = Number(body.expectedNav);
  const market = options.market;
  if (!fund) throw new Error('基金不存在');
  if (!['buy', 'sell'].includes(action)) throw new Error('非法基金操作');
  if (user.bankrupt) throw new Error('已破产，无法交易');
  if (!options.tradingAllowed) throw new Error('当前封盘，只能查看基金');
  if (expectedTick !== Number(market.current_tick)) throw new Error('基金净值已更新，请刷新后重试');
  const navRow = latestNav(fund.code, market.current_tick);
  const nav = Number(navRow?.nav || fund.base_nav);
  if (!Number.isFinite(expectedNav) || Math.abs(expectedNav - nav) > 0.00001) throw new Error('基金净值已更新，请刷新后重试');

  const holdingId = `${user.id}_${fund.code}`;
  const holding = db.get(`SELECT * FROM fund_holdings WHERE id = ${db.q(holdingId)};`);
  const feeRate = fund.fee_free ? 0 : RULES.FUND_FEE_RATE;

  if (action === 'buy') {
    const freshCash = Number(db.get(`SELECT cash FROM users WHERE id = ${db.q(user.id)};`)?.cash || 0);
    const requestedAmount = Number(body.amount || 0);
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) throw new Error('请输入有效申购金额');
    const amount = Number(requestedAmount.toFixed(2));
    if (amount <= 0) throw new Error('申购金额过小');
    if (amount > freshCash) throw new Error('可用资金不足');
    const fee = Number((amount * feeRate).toFixed(2));
    const shares = Number(((amount - fee) / nav).toFixed(6));
    if (shares <= 0) throw new Error('申购金额过小');
    const availableAdd = fund.redeem_t0 ? shares : 0;
    if (holding) {
      const newShares = Number((Number(holding.shares) + shares).toFixed(6));
      const avgNav = Number(((Number(holding.avg_nav) * Number(holding.shares) + nav * shares) / newShares).toFixed(6));
      db.exec(`UPDATE fund_holdings SET shares = ${newShares},
        available_shares = ${Number((Number(holding.available_shares) + availableAdd).toFixed(6))},
        avg_nav = ${avgNav}, updated_at = datetime('now') WHERE id = ${db.q(holdingId)};`);
    } else {
      db.exec(`INSERT INTO fund_holdings
        (id, user_id, fund_code, shares, available_shares, avg_nav, updated_at)
        VALUES (${db.q(holdingId)}, ${db.q(user.id)}, ${db.q(fund.code)}, ${shares}, ${availableAdd}, ${nav}, datetime('now'));`);
    }
    db.exec(`UPDATE users SET cash = ROUND(cash - ${amount}, 2), updated_at = datetime('now') WHERE id = ${db.q(user.id)};`);
    recordFundTx(user.id, fund.code, 'buy', shares, nav, amount, fee, market.current_tick);
    return;
  }

  const shares = Number(Number(body.shares || 0).toFixed(6));
  if (!holding || shares <= 0) throw new Error('请输入有效赎回份额');
  if (shares > Number(holding.available_shares) + 1e-9) throw new Error('可赎回份额不足');
  const gross = Number((shares * nav).toFixed(2));
  const fee = Number((gross * feeRate).toFixed(2));
  const net = Number((gross - fee).toFixed(2));
  const remain = Number((Number(holding.shares) - shares).toFixed(6));
  if (remain <= 0) db.exec(`DELETE FROM fund_holdings WHERE id = ${db.q(holdingId)};`);
  else db.exec(`UPDATE fund_holdings SET shares = ${remain},
    available_shares = ${Math.max(0, Number((Number(holding.available_shares) - shares).toFixed(6)))},
    updated_at = datetime('now') WHERE id = ${db.q(holdingId)};`);
  db.exec(`UPDATE users SET cash = cash + ${net}, updated_at = datetime('now') WHERE id = ${db.q(user.id)};`);
  recordFundTx(user.id, fund.code, 'sell', shares, nav, gross, fee, market.current_tick);
}

function recordFundTx(userId, fundCode, type, shares, nav, amount, fee, tick) {
  db.exec(`INSERT INTO fund_transactions
    (user_id, fund_code, type, shares, nav, amount, fee, tick, created_at)
    VALUES (${db.q(userId)}, ${db.q(fundCode)}, ${db.q(type)}, ${shares}, ${nav}, ${amount}, ${fee}, ${tick}, datetime('now'));`);
}

function fundHistory(userId) {
  return db.all(`SELECT * FROM fund_transactions WHERE user_id = ${db.q(userId)} AND created_at >= ${db.q(clock.shanghaiDaysAgoUtcSpace(2))} ORDER BY id DESC LIMIT 50;`);
}

function releaseSettledShares() {
  db.exec(`UPDATE fund_holdings SET available_shares = shares, updated_at = datetime('now')
    WHERE available_shares != shares;`);
}

function liquidateFunds(userId, needed, tick, riskLevel = null) {
  const funds = Object.fromEntries(getFundsList(tick).map((fund) => [fund.code, fund]));
  const holdings = db.all(`SELECT * FROM fund_holdings WHERE user_id = ${db.q(userId)} AND shares > 0;`);
  const sorted = holdings.map((holding) => {
    const fund = funds[holding.fund_code] || {};
    const nav = Number(fund.nav || holding.avg_nav || 0);
    return { ...holding, fund, nav, value: nav * Number(holding.shares) };
  }).filter((item) => item.nav > 0 && (!riskLevel || item.fund.risk_level === riskLevel)).sort((a, b) => {
    const risk = (RISK_SCORE[b.fund.risk_level] || 0) - (RISK_SCORE[a.fund.risk_level] || 0);
    if (risk !== 0) return risk;
    const aLastResort = LAST_RESORT_FUND_CODES.has(a.fund.code) ? 1 : 0;
    const bLastResort = LAST_RESORT_FUND_CODES.has(b.fund.code) ? 1 : 0;
    if (aLastResort !== bLastResort) return aLastResort - bLastResort;
    return b.value - a.value;
  });

  let total = 0;
  for (const item of sorted) {
    if (total >= needed) break;
    const target = Math.min(item.value, needed - total);
    const shares = Math.min(Number(item.shares), Math.ceil(target / item.nav * 1e6) / 1e6);
    const value = Number((shares * item.nav).toFixed(2));
    const remain = Number((Number(item.shares) - shares).toFixed(6));
    if (remain <= 0) db.exec(`DELETE FROM fund_holdings WHERE id = ${db.q(item.id)};`);
    else db.exec(`UPDATE fund_holdings SET shares = ${remain},
      available_shares = MIN(available_shares, ${remain}), updated_at = datetime('now') WHERE id = ${db.q(item.id)};`);
    db.exec(`UPDATE users SET cash = cash + ${value}, updated_at = datetime('now') WHERE id = ${db.q(userId)};`);
    recordFundTx(userId, item.fund_code, 'forced_liquidation', shares, item.nav, value, 0, tick);
    total = Number((total + value).toFixed(2));
  }
  return total;
}

function recoverActiveFunds(options = {}) {
  const dryRun = options.dryRun !== false;
  const dailyTickTotal = options.dailyTickTotal || 8;
  const results = { cleaned: [], recomputed: [], navRewritten: [] };

  const stocks = db.all('SELECT * FROM stocks ORDER BY code;');
  const activeFunds = db.all("SELECT * FROM funds WHERE manage_mode = 'active';").map(normalizeFund);
  const market = db.get('SELECT * FROM market_state WHERE id = 1;');

  if (!activeFunds.length) {
    if (!dryRun) console.log('No active funds found.');
    return results;
  }

  const dayStartTick = Number(market.day_start_tick || 1);
  const rebalanceTicks = new Set();
  if (dailyTickTotal >= 4) rebalanceTicks.add(dayStartTick + 4);
  rebalanceTicks.add(dayStartTick + dailyTickTotal);

  // Step 1: Clean pollution — delete equal-weight entries at tick>1
  for (const fund of activeFunds) {
    const entries = db.all(
      `SELECT tick, stock_code, weight FROM fund_weight
       WHERE fund_code = ${db.q(fund.code)} AND tick > 1
       ORDER BY tick, stock_code;`
    );

    const byTick = {};
    for (const e of entries) {
      if (!byTick[e.tick]) byTick[e.tick] = [];
      byTick[e.tick].push({ stockCode: e.stock_code, weight: Number(e.weight) });
    }

    for (const [tickStr, weights] of Object.entries(byTick)) {
      const tick = Number(tickStr);
      if (rebalanceTicks.has(tick)) continue;

      const allEqual = weights.every(
        (w) => Math.abs(w.weight - weights[0].weight) < 1e-6
      );

      if (allEqual) {
        results.cleaned.push({ fund: fund.code, tick, count: weights.length });
        if (!dryRun) {
          db.exec(
            `DELETE FROM fund_weight WHERE fund_code = ${db.q(fund.code)} AND tick = ${tick};`
          );
        }
      }
    }
  }

  // Step 2: Recompute rebalances for missing rebalance ticks
  for (const fund of activeFunds) {
    for (const tick of rebalanceTicks) {
      const existing = db.get(
        `SELECT COUNT(*) AS cnt FROM fund_weight WHERE fund_code = ${db.q(fund.code)} AND tick = ${tick};`
      );
      if (existing.cnt > 0) continue;

      try {
        const targetWeights = rebalanceActiveFund(fund, tick, stocks);
        if (targetWeights.length) {
          results.recomputed.push({ fund: fund.code, tick, count: targetWeights.length });
          if (!dryRun) {
            writeWeights(fund.code, tick, targetWeights);
          }
        }
      } catch (err) {
        console.error(`[recover] rebalance failed for ${fund.code} tick=${tick}:`, err.message);
      }
    }
  }

  // Step 3: Recompute NAVs from the first affected tick onward
  const allAffectedTicks = [
    ...results.cleaned.map((c) => c.tick),
    ...results.recomputed.map((r) => r.tick)
  ];
  const firstAffectedTick = allAffectedTicks.length
    ? Math.min(...allAffectedTicks)
    : null;

  if (firstAffectedTick) {
    for (const fund of activeFunds) {
      const prevNavRow = db.get(
        `SELECT nav FROM fund_nav
         WHERE fund_code = ${db.q(fund.code)} AND tick = ${firstAffectedTick - 1}
         ORDER BY tick DESC LIMIT 1;`
      );
      let prevNav = prevNavRow ? Number(prevNavRow.nav) : Number(fund.base_nav);

      const currentTick = Number(market.current_tick);

      for (let tick = firstAffectedTick; tick <= currentTick; tick++) {
        const oldWeights = getLatestWeights(fund.code, tick - 1);
        if (!oldWeights.length) {
          prevNav = Number(
            (db.get(
              `SELECT nav FROM fund_nav WHERE fund_code = ${db.q(fund.code)} AND tick = ${tick} ORDER BY tick DESC LIMIT 1;`
            ) || { nav: fund.base_nav }
            ).nav
          );
          continue;
        }

        const prevPrices = db.all(
          `SELECT stock_code, close FROM stock_prices WHERE tick = ${tick - 1};`
        );
        const currPrices = db.all(
          `SELECT stock_code, close FROM stock_prices WHERE tick = ${tick};`
        );
        const prevMap = Object.fromEntries(
          prevPrices.map((r) => [r.stock_code, Number(r.close)])
        );
        const currMap = Object.fromEntries(
          currPrices.map((r) => [r.stock_code, Number(r.close)])
        );

        let portfolioReturn = 0;
        let turnoverCost = 0;

        for (const item of oldWeights) {
          if (item.stockCode === CASH_CODE) {
            portfolioReturn += item.weight * RULES.MONEY_FUND_RATE;
            continue;
          }
          const prev = prevMap[item.stockCode];
          const curr = currMap[item.stockCode];
          if (prev > 0 && curr > 0) {
            portfolioReturn += item.weight * (curr / prev - 1);
          }
        }

        if (rebalanceTicks.has(tick)) {
          const newWeights = getLatestWeights(fund.code, tick);
          if (newWeights.length) {
            turnoverCost = RULES.TURNOVER_COST * turnoverBetween(oldWeights, newWeights);
          }
        }

        portfolioReturn -= fund.mgmt_fee_rate + turnoverCost;

        const nav = Math.max(
          0.0001,
          Number((prevNav * (1 + portfolioReturn)).toFixed(4))
        );
        const changePct = Number((nav / prevNav - 1).toFixed(6));

        const oldNavRow = db.get(
          `SELECT nav FROM fund_nav WHERE fund_code = ${db.q(fund.code)} AND tick = ${tick};`
        );
        results.navRewritten.push({
          fund: fund.code,
          tick,
          oldNav: oldNavRow ? Number(oldNavRow.nav) : null,
          newNav: nav
        });

        if (!dryRun) {
          db.exec(
            `INSERT OR REPLACE INTO fund_nav
             (fund_code, tick, nav, change_pct, turnover_cost, created_at)
             VALUES (${db.q(fund.code)}, ${tick}, ${nav}, ${changePct},
               ${Number(turnoverCost.toFixed(8))}, datetime('now'));`
          );
        }

        prevNav = nav;
      }
    }
  }

  return results;
}

module.exports = {
  CASH_CODE,
  MONEY_FUND_CODE,
  BOND_FUND_CODE,
  GOLD_FUND_CODE,
  OVERSEAS_FUND_CODE,
  getFunds,
  getFund,
  normalizeFund,
  resolveBasketStocks,
  getBasketWeighting,
  priceWeights,
  getLatestWeights,
  writeWeights,
  ensureActiveFundWeights,
  normalizeCappedWeights,
  rebalanceActiveFund,
  turnoverBetween,
  advanceFundNavs,
  getFundsList,
  getFundDetail,
  getFundStatus,
  tradeFund,
  fundHistory,
  releaseSettledShares,
  liquidateFunds,
  getFundRegime,
  rollOverseasRegime,
  rollGoldRegime,
  recoverActiveFunds
};

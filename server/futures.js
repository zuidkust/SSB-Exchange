const crypto = require('node:crypto');
const db = require('./db');
const clock = require('./clock');
const { RULES, DEFAULT_FUTURES, FUTURES_REGIME_PARAMS } = require('./data');

// ========== PENDING IGNITIONS (crypto delay) ==========
const pendingIgnitions = new Map(); // code -> { triggerTick, direction }

// ========== REGIME MANAGEMENT ==========

function getUnderlyingRegime(code) {
  const row = db.get(`SELECT * FROM commodity_regime WHERE code = ${db.q(code)};`);
  if (!row) return null;
  return {
    regime: row.regime,
    regimeSinceTick: Number(row.regime_since_tick),
    regimeDurationTicks: Number(row.regime_duration_ticks),
    pendingIgnitionTick: row.pending_ignition_tick,
    pendingIgnitionDir: row.pending_ignition_dir
  };
}

function ensureRegime(code, tick, engine, params) {
  const existing = getUnderlyingRegime(code);
  if (existing && existing.regimeDurationTicks > 0) return existing;
  return rollUnderlyingRegime(code, tick, engine, params, true);
}

function rollUnderlyingRegime(code, tick, engine, params, force) {
  const current = force ? null : getUnderlyingRegime(code);
  const dailyTicks = params.daily_ticks || 9;

  if (current && current.regimeDurationTicks > 0) {
    const elapsed = tick - current.regimeSinceTick;
    if (elapsed < current.regimeDurationTicks) return current;
  }

  let nextRegime, durationTicks;

  if (engine === 'overseas3') {
    const prev = current ? current.regime : 'bull';
    const roll = Math.random();
    if (prev === 'bull') {
      nextRegime = roll < (params.crisis_chance || 0.12) ? 'crisis' : 'bear';
    } else if (prev === 'bear') {
      nextRegime = roll < (params.crisis_chance || 0.12) ? 'crisis' : 'bull';
    } else {
      nextRegime = 'bull';
    }
    let durDays;
    if (nextRegime === 'bull') durDays = randomInt(params.bull_dur_days[0], params.bull_dur_days[1]);
    else if (nextRegime === 'bear') durDays = randomInt(params.bear_dur_days[0], params.bear_dur_days[1]);
    else durDays = randomInt(params.crisis_dur_days[0], params.crisis_dur_days[1]);
    durationTicks = durDays * dailyTicks;
  } else if (engine === 'bull_bear') {
    const prev = current ? current.regime : (Math.random() < 0.5 ? 'bull' : 'bear');
    const CONTINUE = 0.35; // 35% 概率延续同向，趋势可连走两段（对称，长期净漂移仍 ≈0）
    nextRegime = (prev && Math.random() < CONTINUE) ? prev : (prev === 'bull' ? 'bear' : 'bull');
    const durDays = randomInt(params.dur_days[0], params.dur_days[1]);
    durationTicks = durDays * dailyTicks;
  } else if (engine === 'event_spike') {
    nextRegime = 'calm';
    durationTicks = 9999;
  } else if (engine === 'gold_reuse') {
    const prev = current ? current.regime : null;
    const roll = Math.random();
    if (prev === 'safe_haven') {
      nextRegime = roll < 0.15 ? 'risk_on' : 'idle';
    } else if (prev === 'risk_on') {
      nextRegime = roll < 0.15 ? 'safe_haven' : 'idle';
    } else {
      nextRegime = roll < 0.55 ? 'safe_haven' : 'risk_on';
    }
    durationTicks = RULES.GOLD_REGIME_MIN_TICKS + Math.floor(Math.random() * (RULES.GOLD_REGIME_MAX_TICKS - RULES.GOLD_REGIME_MIN_TICKS + 1));
  } else if (engine === 'crypto') {
    const prev = current ? current.regime : 'calm';
    if (prev === 'calm') {
      nextRegime = 'calm';
    } else {
      nextRegime = 'calm';
    }
    const durDays = randomInt(params.calm_dur_days[0], params.calm_dur_days[1]);
    durationTicks = durDays * dailyTicks;
  } else if (engine === 'rate_cycle') {
    const prev = current ? current.regime : (Math.random() < 0.5 ? 'hike' : 'cut');
    const CONTINUE = 0.35; // 35% 概率延续同向（对称，长期净漂移仍 ≈0）
    nextRegime = (prev && Math.random() < CONTINUE) ? prev : (prev === 'hike' ? 'cut' : 'hike');
    const durDays = randomInt(params.dur_days[0], params.dur_days[1]);
    durationTicks = durDays * dailyTicks;
  } else {
    nextRegime = 'idle';
    durationTicks = 99;
  }

  db.exec(`INSERT OR REPLACE INTO commodity_regime (code, regime, regime_since_tick, regime_duration_ticks, updated_at)
    VALUES (${db.q(code)}, ${db.q(nextRegime)}, ${tick}, ${durationTicks}, datetime('now'));`);

  return { regime: nextRegime, regimeSinceTick: tick, regimeDurationTicks: durationTicks };
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// ========== PRICE ENGINE ==========

function advanceFutures({ currentTick, nextTick, stocks, activeNews }) {
  const underlyings = db.all('SELECT * FROM futures_underlyings ORDER BY code;');

  // Compute indexChange for gold engine
  const currentPrices = db.all(`SELECT stock_code, close FROM stock_prices WHERE tick = ${Number(currentTick)};`);
  const nextStockPrices = db.all(`SELECT stock_code, close FROM stock_prices WHERE tick = ${Number(nextTick)};`);
  const currentMap = Object.fromEntries(currentPrices.map(r => [r.stock_code, Number(r.close)]));
  const nextMap = Object.fromEntries(nextStockPrices.map(r => [r.stock_code, Number(r.close)]));
  const indexChange = stocks.length
    ? stocks.reduce((sum, s) => sum + ((nextMap[s.code] || currentMap[s.code] || 0) / (currentMap[s.code] || 1) - 1), 0) / stocks.length
    : 0;

  for (const u of underlyings) {
    const params = FUTURES_REGIME_PARAMS[u.regime_engine] || {};
    advanceUnderlyingPrice(u, nextTick, activeNews, stocks, indexChange, params);
  }

  // 4.6 Overnight financing fee: charge before mark-to-market (v1: pure cash deduction;
  // does not affect liquidation since checkLiquidations uses margin+unrealizedPnl, not cash.
  // TODO v2: accrue unpaid financing into margin to properly link to liquidation.)
  chargeFinancingFees(nextTick);

  markToMarketPositions(nextTick);
  checkLiquidations(nextTick);
}

function advanceUnderlyingPrice(u, nextTick, activeNews, stocks, indexChange, params) {
  const engine = u.regime_engine;
  const prevRow = db.get(`SELECT * FROM commodity_prices WHERE code = ${db.q(u.code)} AND tick <= ${Number(nextTick - 1)} ORDER BY tick DESC LIMIT 1;`);
  const prevPrice = prevRow ? Number(prevRow.price) : Number(u.base_price);
  const vol = Number(u.volatility || 0.03);

  let regime, drift;
  if (engine === 'event_spike') {
    const reg = ensureRegime(u.code, nextTick, engine, params);
    regime = reg.regime;
    drift = 0;
  } else if (engine === 'gold_reuse') {
    const reg = ensureRegime(u.code, nextTick, engine, params);
    regime = reg.regime;
    drift = 0;
  } else if (engine === 'crypto') {
    let reg = getUnderlyingRegime(u.code) || ensureRegime(u.code, nextTick, engine, params);
    // BLOCK-2: shock 持续到期后回到 calm，使后续新闻能再次点火
    if (reg.regime === 'shock' && (nextTick - reg.regimeSinceTick) >= reg.regimeDurationTicks) {
      const durationTicks = randomInt(params.calm_dur_days[0], params.calm_dur_days[1]) * (params.daily_ticks || 9);
      db.exec(`INSERT OR REPLACE INTO commodity_regime (code, regime, regime_since_tick, regime_duration_ticks, updated_at)
        VALUES (${db.q(u.code)}, 'calm', ${nextTick}, ${durationTicks}, datetime('now'));`);
      reg = { regime: 'calm', regimeSinceTick: nextTick, regimeDurationTicks: durationTicks };
    }
    regime = reg.regime;
    drift = params.calm_drift || 0;
  } else {
    const reg = ensureRegime(u.code, nextTick, engine, params);
    regime = reg.regime;

    if (engine === 'overseas3') {
      if (regime === 'bull') drift = params.bull_drift || 0.002;
      else if (regime === 'bear') drift = params.bear_drift || -0.002;
      else drift = params.crisis_drift || -0.010;
    } else if (engine === 'bull_bear') {
      drift = (regime === 'bull' ? 1 : -1) * (params.bull_drift || 0.0015);
    } else if (engine === 'rate_cycle') {
      drift = (regime === 'hike' ? 1 : -1) * (params.hike_drift || 0.0008);
    } else {
      drift = 0;
    }
  }

  // News impact on this underlying
  let newsImpact = 0;
  let isCryptoNewsIgnition = false;
  let pendingIgnitionDirection = 0;

  // 4.4 Check for matured pending crypto ignitions (before news loop)
  if (engine === 'crypto') {
    // MED-1: restore pending ignition from DB if not in memory (survives restart)
    if (!pendingIgnitions.has(u.code)) {
      const reg = getUnderlyingRegime(u.code);
      if (reg && reg.pendingIgnitionTick && reg.pendingIgnitionDir) {
        pendingIgnitions.set(u.code, {
          triggerTick: Number(reg.pendingIgnitionTick),
          direction: Number(reg.pendingIgnitionDir)
        });
      }
    }
    const pending = pendingIgnitions.get(u.code);
    if (pending && nextTick >= pending.triggerTick) {
      pendingIgnitionDirection = pending.direction;
      pendingIgnitions.delete(u.code);
      // Don't check news for ignition — pending fire takes priority
    }
  }

  if (activeNews && activeNews.length && pendingIgnitionDirection === 0 && !pendingIgnitions.has(u.code)) {
    for (const news of activeNews) {
      const impact = getFuturesNewsImpact(news, u.code, nextTick);
      if (engine === 'crypto' && regime === 'calm' && Math.abs(impact) >= (params.ignite_threshold || 0.05)) {
        isCryptoNewsIgnition = true;
      }
      newsImpact += impact;
    }
  }

  let changePct;
  if (engine === 'gold_reuse') {
    const ownMove = (Math.random() * 2 - 1) * vol;
    if (regime === 'safe_haven') {
      changePct = ownMove - RULES.GOLD_INVERSE_K * indexChange;
    } else if (regime === 'risk_on') {
      changePct = ownMove + RULES.GOLD_RISK_ON_K * indexChange;
    } else {
      changePct = ownMove;
    }
  } else if (engine === 'event_spike') {
    changePct = (Math.random() * 2 - 1) * vol + newsImpact;
  } else if (engine === 'crypto') {
    if (pendingIgnitionDirection !== 0 && regime === 'calm') {
      // 到期延迟点火：直接放冲击，不再二次反向、不再二次延迟
      const shockMag = params.shock_magnitude_range[0] + Math.random() * (params.shock_magnitude_range[1] - params.shock_magnitude_range[0]);
      changePct = pendingIgnitionDirection * shockMag;
      const shockDur = randomInt(params.shock_dur_ticks[0], params.shock_dur_ticks[1]);
      db.exec(`UPDATE commodity_regime
        SET regime = 'shock', regime_since_tick = ${nextTick}, regime_duration_ticks = ${shockDur},
            pending_ignition_tick = NULL, pending_ignition_dir = NULL, updated_at = datetime('now')
        WHERE code = ${db.q(u.code)};`);
    } else if (isCryptoNewsIgnition && regime === 'calm') {
      // 新触发：方向只在这里定一次（含唯一一次 p_reverse）
      let direction = newsImpact > 0 ? 1 : -1;
      // 4.3 Reverse probability: "利好出尽/利空出尽"
      if (Math.random() < (params.p_reverse ?? 0.15)) direction = -direction;
      // 4.4 Ignition timing delay: randomInt(0,2) ticks before shock fires
      const delay = randomInt(0, 2);
      if (delay === 0) {
        const shockMag = params.shock_magnitude_range[0] + Math.random() * (params.shock_magnitude_range[1] - params.shock_magnitude_range[0]);
        changePct = direction * shockMag;
        const shockDur = randomInt(params.shock_dur_ticks[0], params.shock_dur_ticks[1]);
        db.exec(`UPDATE commodity_regime
          SET regime = 'shock', regime_since_tick = ${nextTick}, regime_duration_ticks = ${shockDur}, updated_at = datetime('now')
          WHERE code = ${db.q(u.code)};`);
      } else {
        pendingIgnitions.set(u.code, { triggerTick: nextTick + delay, direction });
        // MED-1: persist pending ignition to DB
        db.exec(`UPDATE commodity_regime
          SET pending_ignition_tick = ${nextTick + delay}, pending_ignition_dir = ${direction}, updated_at = datetime('now')
          WHERE code = ${db.q(u.code)};`);
        // Normal calm movement for this tick (shock fires later)
        changePct = (Math.random() * 2 - 1) * vol + drift;
      }
    } else {
      changePct = (Math.random() * 2 - 1) * vol + drift;
    }
  } else {
    changePct = drift + (Math.random() * 2 - 1) * vol + newsImpact;
  }

  changePct = Number(changePct.toFixed(6));
  const newPrice = Math.max(0.01, Number((prevPrice * (1 + changePct)).toFixed(2)));

  db.exec(`INSERT OR REPLACE INTO commodity_prices (code, tick, price, change_pct, created_at)
    VALUES (${db.q(u.code)}, ${nextTick}, ${newPrice}, ${changePct}, datetime('now'));`);

  return { price: newPrice, changePct, regime };
}

function getFuturesNewsImpact(news, underlyingCode, currentTick) {
  if (!news || news.is_fluff) return 0;
  if (news.target_type !== 'futures') return 0;
  if (news.target_code !== underlyingCode && news.target_code !== null) return 0;

  const tickSinceStart = currentTick - Number(news.impact_start_tick || currentTick);
  if (tickSinceStart < 0 || tickSinceStart >= Number(news.impact_duration_ticks || 0)) return 0;

  const isFake = String(news.truth_type || '').startsWith('fake');
  const isRevealed = news.reveal_tick && tickSinceStart >= (Number(news.reveal_tick) - Number(news.impact_start_tick));
  if (isFake && isRevealed) return 0;

  const direction = news.visible_sentiment === 'bullish' ? 1 : (news.visible_sentiment === 'bearish' ? -1 : 0);
  if (direction === 0) return 0;

  const progressRatio = (tickSinceStart + 1) / Number(news.impact_duration_ticks || 1);
  return direction * Number(news.impact_magnitude || 0) * progressRatio;
}

// ========== MARK TO MARKET & LIQUIDATIONS ==========

function markToMarketPositions(nextTick) {
  const positions = db.all(`SELECT * FROM futures_positions WHERE status = 'open';`);
  const prices = db.all(`SELECT code, price FROM commodity_prices WHERE tick = ${Number(nextTick)};`);
  const priceMap = Object.fromEntries(prices.map(r => [r.code, Number(r.price)]));

  for (const pos of positions) {
    const currentPrice = priceMap[pos.code];
    if (!currentPrice || currentPrice <= 0) continue;

    const direction = pos.side === 'long' ? 1 : -1;
    const entryPrice = Number(pos.entry_price);
    const contractValue = Number(pos.contract_value);
    const priceReturn = (currentPrice - entryPrice) / entryPrice;
    const unrealizedPnl = Number((direction * priceReturn * contractValue).toFixed(2));

    db.exec(`UPDATE futures_positions SET unrealized_pnl = ${unrealizedPnl}, updated_at = datetime('now') WHERE id = ${db.q(pos.id)};`);
  }
}

// ========== OVERNIGHT FINANCING FEE (4.6) ==========

function chargeFinancingFees(nextTick) {
  const rate = RULES.FUTURES_FINANCING_RATE || 0.0002;
  if (!(rate > 0)) return;

  const positions = db.all(`SELECT * FROM futures_positions WHERE status = 'open';`);
  for (const pos of positions) {
    const contractValue = Number(pos.contract_value);
    const leverage = Number(pos.leverage);
    const borrowed = Number((contractValue * (1 - 1 / leverage)).toFixed(2));
    const fee = Number((borrowed * rate).toFixed(2));
    if (!(fee > 0)) continue;

    // Deduct from user cash; if insufficient, deduct to 0 (v1 simple: pure cash outflow,
    // does not affect liquidation since checkLiquidations uses margin+unrealizedPnl)
    const user = db.get(`SELECT cash FROM users WHERE id = ${db.q(pos.user_id)};`);
    const cash = user ? Number(user.cash || 0) : 0;
    const actualCharge = Math.min(fee, cash);
    if (actualCharge > 0) {
      db.exec(`UPDATE users SET cash = cash - ${actualCharge}, updated_at = datetime('now') WHERE id = ${db.q(pos.user_id)};`);
    }
    // Write financing transaction record
    db.exec(`INSERT INTO futures_transactions (user_id, code, type, side, contracts, price, margin, pnl, fee, tick, created_at)
      VALUES (${db.q(pos.user_id)}, ${db.q(pos.code)}, 'financing', ${db.q(pos.side)},
        ${Number(pos.contracts)}, 0, ${Number(pos.margin)}, 0, ${actualCharge}, ${nextTick}, datetime('now'));`);

    // TODO v2: accrue unpaid financing into margin so it properly feeds into maintenance-margin liquidation
  }
}

function checkLiquidations(nextTick) {
  const positions = db.all(`SELECT * FROM futures_positions WHERE status = 'open';`);
  const prices = db.all(`SELECT code, price FROM commodity_prices WHERE tick = ${Number(nextTick)};`);
  const priceMap = Object.fromEntries(prices.map(r => [r.code, Number(r.price)]));

  const maintenanceRate = RULES.FUTURES_MAINTENANCE_RATE;

  for (const pos of positions) {
    const currentPrice = priceMap[pos.code];
    if (!currentPrice || currentPrice <= 0) continue;

    const margin = Number(pos.margin);
    const unrealizedPnl = Number(pos.unrealized_pnl);
    const contractValue = Number(pos.contract_value);
    const effectiveMargin = margin + unrealizedPnl;

    if (effectiveMargin / contractValue < maintenanceRate) {
      const returnedCash = Math.max(0, effectiveMargin);
      // 穿仓：亏损超过保证金时，超出部分（effectiveMargin 为负的绝对值）需向账户追偿
      const deficit = effectiveMargin < 0 ? Number((-effectiveMargin).toFixed(2)) : 0;
      db.exec(`UPDATE futures_positions SET status = 'liquidated', closed_tick = ${nextTick}, updated_at = datetime('now') WHERE id = ${db.q(pos.id)};`);
      if (returnedCash > 0) {
        db.exec(`UPDATE users SET cash = cash + ${returnedCash}, updated_at = datetime('now') WHERE id = ${db.q(pos.user_id)};`);
      }

      db.exec(`INSERT INTO futures_transactions (user_id, code, type, side, contracts, price, margin, pnl, fee, tick, created_at)
        VALUES (${db.q(pos.user_id)}, ${db.q(pos.code)}, 'liquidation', ${db.q(pos.side)},
          ${Number(pos.contracts)}, ${currentPrice}, ${margin}, ${unrealizedPnl}, 0, ${nextTick}, datetime('now'));`);

      if (deficit > 0) {
        recoverFuturesDeficit(pos.user_id, deficit, nextTick, pos.code);
      }
    }
  }
}

// 穿仓追偿（方案 B）：期货爆仓亏损超过保证金时，对超出部分按
// 现金 → 强卖股票 → 强赎基金 的顺序追偿，零下限停止（cash 永不为负），不触发破产，
// 也不连带平掉用户的其他期货持仓。最终无法覆盖的缺额由系统吸收。
function recoverFuturesDeficit(userId, deficit, tick, originCode) {
  let remaining = Number(deficit);
  if (!(remaining > 0)) return 0;

  // 1) 扣现金（扣到 0 为止）
  const user = db.get(`SELECT cash FROM users WHERE id = ${db.q(userId)};`);
  const cash = user ? Number(user.cash || 0) : 0;
  const cashPay = Math.min(cash, remaining);
  if (cashPay > 0) {
    db.exec(`UPDATE users SET cash = cash - ${cashPay}, updated_at = datetime('now') WHERE id = ${db.q(userId)};`);
    remaining = Number((remaining - cashPay).toFixed(2));
  }

  // 2) 强卖股票（按市值从高到低）。卖出所得直接抵债，账户现金净额不变。
  if (remaining > 0) {
    const holdings = db.all(`SELECT h.id, h.stock_code, h.quantity, sp.close AS price
      FROM holdings h
      LEFT JOIN stock_prices sp ON sp.stock_code = h.stock_code AND sp.tick = ${Number(tick)}
      WHERE h.user_id = ${db.q(userId)} AND h.quantity > 0;`)
      .map(h => ({ ...h, price: Number(h.price || 0), value: Number(h.quantity) * Number(h.price || 0) }))
      .filter(h => h.price > 0)
      .sort((a, b) => b.value - a.value);

    for (const h of holdings) {
      if (remaining <= 0) break;
      const sellValue = Math.min(h.value, remaining);
      const sharesToSell = Math.min(Number(h.quantity), Math.ceil(sellValue / h.price));
      if (sharesToSell <= 0) continue;
      const actualValue = Number((sharesToSell * h.price).toFixed(2));
      db.exec(`UPDATE holdings SET quantity = quantity - ${sharesToSell},
        available_quantity = MAX(0, available_quantity - ${sharesToSell}), updated_at = datetime('now')
        WHERE id = ${db.q(h.id)};`);
      db.exec(`DELETE FROM holdings WHERE id = ${db.q(h.id)} AND quantity <= 0;`);
      db.exec(`INSERT INTO transactions (user_id, stock_code, type, quantity, price, fee, tick, created_at)
        VALUES (${db.q(userId)}, ${db.q(h.stock_code)}, 'forced_liquidation', ${sharesToSell}, ${h.price}, 0, ${Number(tick)}, datetime('now'));`);
      remaining = Number((remaining - actualValue).toFixed(2));
    }
  }

  // 3) 强赎基金：liquidateFunds 会把赎回款加进 cash，故赎回后再从 cash 扣回抵债
  if (remaining > 0) {
    const funds = require('./funds');
    const got = Number(funds.liquidateFunds(userId, remaining, tick) || 0);
    if (got > 0) {
      const deduct = Math.min(got, remaining);
      db.exec(`UPDATE users SET cash = cash - ${deduct}, updated_at = datetime('now') WHERE id = ${db.q(userId)};`);
      remaining = Number((remaining - deduct).toFixed(2));
    }
  }

  // 防御性零下限：现金不可为负
  db.exec(`UPDATE users SET cash = MAX(0, cash), updated_at = datetime('now') WHERE id = ${db.q(userId)};`);

  // 记录穿仓追偿明细（实际追回 = deficit − 未覆盖缺额）
  const recovered = Number((Number(deficit) - Math.max(0, remaining)).toFixed(2));
  db.exec(`INSERT INTO futures_transactions (user_id, code, type, side, contracts, price, margin, pnl, fee, tick, created_at)
    VALUES (${db.q(userId)}, ${db.q(originCode)}, 'deficit_recovery', 'long', 0, 0, 0, ${-recovered}, 0, ${Number(tick)}, datetime('now'));`);

  return recovered;
}

// ========== TRADING ==========

function openPosition(user, body, options = {}) {
  const code = String(body.code || '').toUpperCase();
  const side = String(body.side || '').toLowerCase();
  const contracts = Number(body.contracts);
  const leverage = Number(body.leverage);
  const expectedTick = Number(body.expectedTick);
  const expectedPrice = Number(body.expectedPrice);
  const market = options.market;

  if (user.bankrupt) throw new Error('已破产，无法交易');
  if (!options.tradingAllowed) throw new Error('当前封盘，无法交易');
  if (!['long', 'short'].includes(side)) throw new Error('方向必须为 long 或 short');
  if (!Number.isInteger(contracts) || contracts < 1) throw new Error('张数必须为 ≥1 的整数');
  if (expectedTick !== Number(market.current_tick)) throw new Error('价格已更新，请刷新后重试');

  const underlying = db.get(`SELECT * FROM futures_underlyings WHERE code = ${db.q(code)};`);
  if (!underlying) throw new Error('期货标的不存在');

  const priceRow = db.get(`SELECT price FROM commodity_prices WHERE code = ${db.q(code)} AND tick = ${Number(market.current_tick)};`);
  const currentPrice = priceRow ? Number(priceRow.price) : Number(underlying.base_price);
  if (!Number.isFinite(expectedPrice) || Math.abs(expectedPrice - currentPrice) > 0.01) throw new Error('价格已更新，请刷新后重试');

  if (leverage > Number(underlying.max_leverage)) throw new Error(`该标的最高杠杆为 ${Number(underlying.max_leverage)}x`);
  if (!RULES.FUTURES_LEVERAGE_TIERS.includes(leverage)) throw new Error('无效杠杆档位');

  const contractValue = Number((currentPrice * Number(underlying.contract_multiplier) * contracts).toFixed(2));
  const margin = Number((contractValue / leverage).toFixed(2));

  const freshCash = Number(db.get(`SELECT cash FROM users WHERE id = ${db.q(user.id)};`)?.cash || 0);
  if (margin > freshCash) throw new Error('可用资金不足');

  // Check exposure limits
  const userNetAsset = computeUserNetAsset(user.id, market.current_tick);
  const track = underlying.track;
  const perTrackLimit = (RULES.FUTURES_EXPOSURE_PER_TRACK || {})[track] || 0.20;
  const totalLimit = RULES.FUTURES_TOTAL_EXPOSURE;

  const allPositions = db.all(`SELECT * FROM futures_positions WHERE user_id = ${db.q(user.id)} AND status = 'open';`);
  const trackMargin = allPositions
    .filter(p => {
      const u = db.get(`SELECT track FROM futures_underlyings WHERE code = ${db.q(p.code)};`);
      return u && u.track === track;
    })
    .reduce((sum, p) => sum + Number(p.margin), 0);
  const totalMargin = allPositions.reduce((sum, p) => sum + Number(p.margin), 0);

  if ((trackMargin + margin) / userNetAsset > perTrackLimit) throw new Error(`该赛道敞口已达上限 ${(perTrackLimit * 100).toFixed(0)}%`);
  if ((totalMargin + margin) / userNetAsset > totalLimit) throw new Error(`期货总敞口已达上限 ${(totalLimit * 100).toFixed(0)}%`);

  const positionId = crypto.randomUUID();
  const fee = Number((contractValue * RULES.FUTURES_FEE_RATE).toFixed(2));

  db.exec(`UPDATE users SET cash = ROUND(cash - ${margin} - ${fee}, 2), updated_at = datetime('now') WHERE id = ${db.q(user.id)};`);

  db.exec(`INSERT INTO futures_positions
    (id, user_id, code, side, contracts, contract_value, entry_price, leverage, margin, unrealized_pnl, status, opened_tick, created_at, updated_at)
    VALUES (${db.q(positionId)}, ${db.q(user.id)}, ${db.q(code)}, ${db.q(side)},
      ${contracts}, ${contractValue}, ${currentPrice}, ${leverage}, ${margin}, 0, 'open', ${market.current_tick}, datetime('now'), datetime('now'));`);

  db.exec(`INSERT INTO futures_transactions (user_id, code, type, side, contracts, price, margin, pnl, fee, tick, created_at)
    VALUES (${db.q(user.id)}, ${db.q(code)}, 'open', ${db.q(side)}, ${contracts}, ${currentPrice}, ${margin}, 0, ${fee}, ${market.current_tick}, datetime('now'));`);

  const newCash = Number((Number(user.cash) - margin - fee).toFixed(2));
  const position = db.get(`SELECT * FROM futures_positions WHERE id = ${db.q(positionId)};`);
  return { position: formatPosition(position, currentPrice), newCash };
}

function closePosition(user, body, options = {}) {
  const positionId = String(body.positionId || '');
  const expectedTick = Number(body.expectedTick);
  const expectedPrice = Number(body.expectedPrice);
  const market = options.market;

  if (user.bankrupt) throw new Error('已破产，无法交易');
  if (!options.tradingAllowed) throw new Error('当前封盘，无法交易');
  if (expectedTick !== Number(market.current_tick)) throw new Error('价格已更新，请刷新后重试');

  const position = db.get(`SELECT * FROM futures_positions WHERE id = ${db.q(positionId)} AND user_id = ${db.q(user.id)};`);
  if (!position) throw new Error('持仓不存在');
  if (position.status !== 'open') throw new Error('该仓位已平仓');

  const priceRow = db.get(`SELECT price FROM commodity_prices WHERE code = ${db.q(position.code)} AND tick = ${Number(market.current_tick)};`);
  const currentPrice = priceRow ? Number(priceRow.price) : 0;
  if (!Number.isFinite(expectedPrice) || Math.abs(expectedPrice - currentPrice) > 0.01) throw new Error('价格已更新，请刷新后重试');

  const direction = position.side === 'long' ? 1 : -1;
  const entryPrice = Number(position.entry_price);
  const contractValue = Number(position.contract_value);
  const priceReturn = (currentPrice - entryPrice) / entryPrice;
  const pnl = Number((direction * priceReturn * contractValue).toFixed(2));
  const fee = Number((contractValue * RULES.FUTURES_FEE_RATE).toFixed(2));
  const returnedCash = Number((Number(position.margin) + pnl - fee).toFixed(2));

  db.exec(`UPDATE futures_positions SET status = 'closed', closed_tick = ${market.current_tick}, updated_at = datetime('now') WHERE id = ${db.q(positionId)};`);
  db.exec(`UPDATE users SET cash = cash + ${returnedCash}, updated_at = datetime('now') WHERE id = ${db.q(user.id)};`);

  db.exec(`INSERT INTO futures_transactions (user_id, code, type, side, contracts, price, margin, pnl, fee, tick, created_at)
    VALUES (${db.q(user.id)}, ${db.q(position.code)}, 'close', ${db.q(position.side)},
      ${Number(position.contracts)}, ${currentPrice}, ${Number(position.margin)}, ${pnl}, ${fee}, ${market.current_tick}, datetime('now'));`);

  return { pnl, returnedCash };
}

function liquidateUserFutures(userId, needed, tick) {
  const positions = db.all(`SELECT * FROM futures_positions WHERE user_id = ${db.q(userId)} AND status = 'open';`);
  const prices = db.all(`SELECT code, price FROM commodity_prices WHERE tick = ${Number(tick)};`);
  const priceMap = Object.fromEntries(prices.map(r => [r.code, Number(r.price)]));

  // Sort by risk: crypto first (highest risk), then others
  const sorted = [...positions].sort((a, b) => {
    const aU = db.get(`SELECT track FROM futures_underlyings WHERE code = ${db.q(a.code)};`);
    const bU = db.get(`SELECT track FROM futures_underlyings WHERE code = ${db.q(b.code)};`);
    const riskOrder = { crypto: 0, commodity: 1, index: 2, fx: 3 };
    return (riskOrder[aU?.track] || 99) - (riskOrder[bU?.track] || 99);
  });

  let totalLiquidated = 0;
  const liquidateAll = needed >= Number.MAX_SAFE_INTEGER || needed === Infinity;

  for (const pos of sorted) {
    if (!liquidateAll && totalLiquidated >= needed) break;

    const currentPrice = priceMap[pos.code];
    if (!currentPrice) continue;

    const direction = pos.side === 'long' ? 1 : -1;
    const entryPrice = Number(pos.entry_price);
    const contractValue = Number(pos.contract_value);
    const priceReturn = (currentPrice - entryPrice) / entryPrice;
    const pnl = Number((direction * priceReturn * contractValue).toFixed(2));
    const returnedCash = Math.max(0, Number(pos.margin) + pnl);

    db.exec(`UPDATE futures_positions SET status = 'closed', closed_tick = ${tick}, updated_at = datetime('now') WHERE id = ${db.q(pos.id)};`);
    db.exec(`UPDATE users SET cash = cash + ${returnedCash}, updated_at = datetime('now') WHERE id = ${db.q(userId)};`);

    db.exec(`INSERT INTO futures_transactions (user_id, code, type, side, contracts, price, margin, pnl, fee, tick, created_at)
      VALUES (${db.q(userId)}, ${db.q(pos.code)}, 'forced_liquidation', ${db.q(pos.side)},
        ${Number(pos.contracts)}, ${currentPrice}, ${Number(pos.margin)}, ${pnl}, 0, ${tick}, datetime('now'));`);

    totalLiquidated = Number((totalLiquidated + returnedCash).toFixed(2));
  }
  return totalLiquidated;
}

// ========== API HELPERS ==========

function getFuturesList(tick) {
  const underlyings = db.all('SELECT * FROM futures_underlyings ORDER BY code;');
  const prices = db.all(`SELECT code, price, change_pct FROM commodity_prices WHERE tick = ${Number(tick)};`);
  const priceMap = Object.fromEntries(prices.map(r => [r.code, r]));
  const prevPrices = db.all(`SELECT code, price FROM commodity_prices WHERE tick = ${Number(tick - 1)};`);
  const prevPriceMap = Object.fromEntries(prevPrices.map(r => [r.code, Number(r.price)]));

  return underlyings.map(u => {
    const priceRow = priceMap[u.code];
    const currentPrice = priceRow ? Number(priceRow.price) : Number(u.base_price);
    const prevPrice = prevPriceMap[u.code] || Number(u.base_price);
    const changePct = prevPrice > 0 ? Number(((currentPrice / prevPrice - 1)).toFixed(4)) : 0;
    const minMargin = Number((currentPrice * Number(u.contract_multiplier) * 1 / Number(u.max_leverage)).toFixed(0));

    const regime = getUnderlyingRegime(u.code);
    const regimeHint = regime ? regimeLabel(u.regime_engine, regime.regime) : '';

    return {
      code: u.code,
      name: u.name,
      track: u.track,
      price: currentPrice,
      change_pct: changePct,
      regime_hint: regimeHint,
      basePrice: Number(u.base_price),
      mult: Number(u.contract_multiplier),
      maxLeverage: Number(u.max_leverage),
      minMargin,
      sector: u.linked_sector
    };
  });
}

function getFuturesStatus(userId, tick) {
  const positions = db.all(`SELECT * FROM futures_positions WHERE user_id = ${db.q(userId)} AND status = 'open';`);
  const prices = db.all(`SELECT code, price FROM commodity_prices WHERE tick = ${Number(tick)};`);
  const priceMap = Object.fromEntries(prices.map(r => [r.code, Number(r.price)]));
  const underlyings = db.all('SELECT code, name, contract_multiplier, max_leverage FROM futures_underlyings;');
  const uMap = Object.fromEntries(underlyings.map(u => [u.code, u]));

  const maintenanceRate = RULES.FUTURES_MAINTENANCE_RATE;
  let totalMargin = 0, totalUnrealizedPnl = 0;

  const formattedPositions = positions.map(pos => {
    const currentPrice = priceMap[pos.code] || Number(pos.entry_price);
    const entryPrice = Number(pos.entry_price);
    const margin = Number(pos.margin);
    const unrealizedPnl = Number(pos.unrealized_pnl);
    const contractValue = Number(pos.contract_value);
    const leverage = Number(pos.leverage);
    totalMargin += margin;
    totalUnrealizedPnl += unrealizedPnl;

    // Liquidation price
    let liquidationPrice;
    if (pos.side === 'long') {
      liquidationPrice = Number((entryPrice * (1 - (1 / leverage) + maintenanceRate)).toFixed(2));
    } else {
      liquidationPrice = Number((entryPrice * (1 + (1 / leverage) - maintenanceRate)).toFixed(2));
    }

    // Liquidation distance
    const liquidationDistance = currentPrice > 0
      ? Number((Math.abs(currentPrice - liquidationPrice) / currentPrice).toFixed(4))
      : 0;

    const u = uMap[pos.code] || {};

    return {
      id: pos.id,
      code: pos.code,
      name: u.name || pos.code,
      side: pos.side,
      contracts: Number(pos.contracts),
      leverage,
      margin,
      entryPrice,
      currentPrice,
      contractValue,
      unrealizedPnl,
      liquidationPrice,
      liquidationDistance,
      status: pos.status
    };
  });

  // Compute remaining exposure
  const user = db.get(`SELECT * FROM users WHERE id = ${db.q(userId)};`);
  const netAsset = user ? computeUserNetAssetQuick(userId, tick) : RULES.INITIAL_CASH;
  const totalLimit = RULES.FUTURES_TOTAL_EXPOSURE;
  const remainingExposure = Math.max(0, Number((netAsset * totalLimit - totalMargin).toFixed(2)));

  return {
    positions: formattedPositions,
    summary: {
      futuresValue: Number((totalMargin + totalUnrealizedPnl).toFixed(2)),
      totalMargin: Number(totalMargin.toFixed(2)),
      totalUnrealizedPnl: Number(totalUnrealizedPnl.toFixed(2)),
      remainingExposure
    }
  };
}

function getUnderlyingDetail(code, tick, stocks) {
  const underlying = db.get(`SELECT * FROM futures_underlyings WHERE code = ${db.q(String(code || '').toUpperCase())};`);
  if (!underlying) throw new Error('期货标的不存在');

  const priceRow = db.get(`SELECT price, change_pct FROM commodity_prices WHERE code = ${db.q(underlying.code)} AND tick = ${Number(tick)};`);
  const currentPrice = priceRow ? Number(priceRow.price) : Number(underlying.base_price);
  const changePct = priceRow ? Number(priceRow.change_pct) : 0;

  const priceHistory = db.all(`SELECT tick, price FROM (
    SELECT tick, price FROM commodity_prices WHERE code = ${db.q(underlying.code)} ORDER BY tick DESC LIMIT 200
  ) ORDER BY tick ASC;`);
  const regime = getUnderlyingRegime(underlying.code);
  const regimeHint = regime ? regimeLabel(underlying.regime_engine, regime.regime) : '';

  const activeNews = db.all(`SELECT n.* FROM news n
    JOIN commodity_prices cp ON cp.tick = ${Number(tick)} AND cp.code = ${db.q(underlying.code)}
    WHERE n.published = 1 AND n.target_type = 'futures'
    AND (n.target_code = ${db.q(underlying.code)} OR n.target_code IS NULL)
    AND n.impact_start_tick <= ${Number(tick)}
    AND (n.impact_start_tick + n.impact_duration_ticks) > ${Number(tick)}
    ORDER BY n.impact_magnitude DESC LIMIT 10;`);

  return {
    code: underlying.code,
    name: underlying.name,
    track: underlying.track,
    regime_engine: underlying.regime_engine,
    regime: regime ? regime.regime : '',
    regime_hint: regimeHint,
    price: currentPrice,
    change_pct: changePct,
    prices: priceHistory.map(r => ({ tick: r.tick, price: Number(r.price) })),
    activeNews: (activeNews || []).map(n => db.sanitizeNews ? db.sanitizeNews(n) : n),
    mult: Number(underlying.contract_multiplier),
    maxLeverage: Number(underlying.max_leverage),
    minMargin: Number((currentPrice * Number(underlying.contract_multiplier) * 1 / Number(underlying.max_leverage)).toFixed(0)),
    basePrice: Number(underlying.base_price)
  };
}

function futuresValue(userId, tick) {
  const positions = db.all(`SELECT * FROM futures_positions WHERE user_id = ${db.q(userId)} AND status = 'open';`);
  return positions.reduce((sum, p) => sum + Number(p.margin) + Number(p.unrealized_pnl), 0);
}

function getFuturesHistory(userId) {
  return db.all(`SELECT ft.*, fu.name FROM futures_transactions ft
    LEFT JOIN futures_underlyings fu ON fu.code = ft.code
    WHERE ft.user_id = ${db.q(userId)} AND ft.created_at >= ${db.q(clock.shanghaiDaysAgoUtcSpace(2))}
    ORDER BY ft.id DESC LIMIT 100;`).map(r => ({
    id: r.id,
    code: r.code,
    name: r.name || r.code,
    type: r.type,
    side: r.side,
    contracts: Number(r.contracts),
    price: Number(r.price),
    leverage: Number(r.margin || 0) > 0 && Number(r.contracts || 0) > 0 ? '(历史)' : '',
    margin: Number(r.margin),
    pnl: Number(r.pnl),
    fee: Number(r.fee),
    tick: r.tick,
    createdAt: r.created_at
  }));
}

// ========== HELPERS ==========

function regimeLabel(engine, regime) {
  const labels = {
    overseas3: { bull: '牛市', bear: '熊市', crisis: '危机' },
    bull_bear: { bull: '牛市', bear: '熊市' },
    event_spike: { calm: '平静' },
    gold_reuse: { safe_haven: '避险', risk_on: '风险同向', idle: '独立震荡' },
    crypto: { calm: '平静', shock: '巨震中' },
    rate_cycle: { hike: '加息周期', cut: '降息周期' }
  };
  return (labels[engine] || {})[regime] || regime;
}

function formatPosition(pos, currentPrice) {
  const maintenanceRate = RULES.FUTURES_MAINTENANCE_RATE;
  const entryPrice = Number(pos.entry_price);
  const leverage = Number(pos.leverage);
  let liquidationPrice;
  if (pos.side === 'long') {
    liquidationPrice = Number((entryPrice * (1 - (1 / leverage) + maintenanceRate)).toFixed(2));
  } else {
    liquidationPrice = Number((entryPrice * (1 + (1 / leverage) - maintenanceRate)).toFixed(2));
  }
  const liquidationDistance = currentPrice > 0
    ? Number((Math.abs(currentPrice - liquidationPrice) / currentPrice).toFixed(4))
    : 0;

  return {
    id: pos.id,
    code: pos.code,
    side: pos.side,
    contracts: Number(pos.contracts),
    leverage,
    margin: Number(pos.margin),
    entryPrice,
    currentPrice,
    contractValue: Number(pos.contract_value),
    unrealizedPnl: Number(pos.unrealized_pnl),
    liquidationPrice,
    liquidationDistance,
    status: pos.status
  };
}

function computeUserNetAssetQuick(userId, tick) {
  const user = db.get(`SELECT * FROM users WHERE id = ${db.q(userId)};`);
  if (!user) return RULES.INITIAL_CASH;
  const cash = Number(user.cash);
  const holdings = db.all(`SELECT h.*, sp.close AS current_price FROM holdings h
    LEFT JOIN stock_prices sp ON sp.stock_code = h.stock_code AND sp.tick = ${Number(tick)};`);
  const holdingValue = holdings.reduce((sum, h) => sum + Number(h.quantity) * Number(h.current_price || 0), 0);
  const fundValue = computeFundValueQuick(userId, tick);
  const fValue = futuresValue(userId, tick);
  const loan = db.get(`SELECT SUM(remaining_principal) AS total FROM loans WHERE user_id = ${db.q(userId)} AND status = 'active';`);
  const loanLiability = loan ? Number(loan.total) : 0;
  return cash + holdingValue + fundValue + fValue - loanLiability;
}

function computeFundValueQuick(userId, tick) {
  const fundHoldings = db.all(`SELECT fh.*, fn.nav FROM fund_holdings fh
    LEFT JOIN fund_nav fn ON fn.fund_code = fh.fund_code AND fn.tick = ${Number(tick)};`);
  return fundHoldings.reduce((sum, h) => sum + Number(h.shares) * Number(h.nav || 0), 0);
}

function computeUserNetAsset(userId, tick) {
  return computeUserNetAssetQuick(userId, tick);
}

module.exports = {
  advanceFutures,
  openPosition,
  closePosition,
  recoverFuturesDeficit,
  liquidateUserFutures,
  getFuturesList,
  getFuturesStatus,
  getUnderlyingDetail,
  futuresValue,
  getFuturesHistory,
  getUnderlyingRegime,
  rollUnderlyingRegime
};

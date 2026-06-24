// 加密点火端到端回归测试：
//   A. 真利好正确点火 → 高杠杆做多盈利
//   B. 假利好→辟谣反转 → 追多被强平
// 直连模块层（futures.js + db.js + news.js），用一次性临时 SQLite。
// 退出码 0 = 全过；非 0 = 有失败。

process.env.SSB_CLOCK_NOW = process.env.SSB_CLOCK_NOW || '2026-06-01T09:00:00+08:00';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const DB_PATH = path.join(os.tmpdir(), `ssb_fut_crypto_${process.pid}_${Date.now()}.sqlite`);
process.env.SSB_DB_PATH = DB_PATH;

const db = require('./db');
const futures = require('./futures');
const news = require('./news');

// Pin ignition direction for deterministic E2E passes.
// Reverse (p_reverse) behavior is covered separately in Test C.
require('./data').FUTURES_REGIME_PARAMS.crypto.p_reverse = 0;

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${DB_PATH}${suffix}`;
    if (fs.existsSync(f)) { try { fs.rmSync(f); } catch { /* ignore */ } }
  }
}

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
}
const near = (a, b, eps = 0.01) => Math.abs(Number(a) - Number(b)) <= eps;

function mkUser(id, cash) {
  db.exec(`INSERT INTO users (id, username, nickname, cash, join_tick, initial_asset_at_join, bankrupt, created_at, updated_at)
    VALUES (${db.q(id)}, ${db.q(id)}, ${db.q(id)}, ${cash}, 1, ${cash}, 0, datetime('now'), datetime('now'));`);
  return db.get(`SELECT * FROM users WHERE id = ${db.q(id)};`);
}
const reload = (id) => db.get(`SELECT * FROM users WHERE id = ${db.q(id)};`);
const priceAt = (code, tick) => {
  const row = db.get(`SELECT price FROM commodity_prices WHERE code = ${db.q(code)} AND tick = ${tick};`);
  return row ? Number(row.price) : null;
};
const regimeAt = (code) => {
  const row = db.get(`SELECT * FROM commodity_regime WHERE code = ${db.q(code)};`);
  return row ? { regime: row.regime, sinceTick: Number(row.regime_since_tick), durTicks: Number(row.regime_duration_ticks) } : null;
};
const marketRow = () => db.get('SELECT * FROM market_state WHERE id = 1;');

function insertNews(doc) {
  const cols = Object.keys(doc);
  const vals = Object.values(doc).map(v => db.q(v));
  db.exec(`INSERT INTO news (${cols.join(',')}) VALUES (${vals.join(',')});`);
  return db.get('SELECT * FROM news WHERE id = last_insert_rowid();');
}

function advanceFutures(n, activeNews) {
  for (let i = 0; i < n; i++) {
    const m = marketRow();
    const ct = Number(m.current_tick), nt = ct + 1;
    db.exec(`UPDATE market_state SET current_tick = ${nt} WHERE id = 1;`);
    futures.advanceFutures({ currentTick: ct, nextTick: nt, stocks: [], activeNews: activeNews || [] });
  }
}

function getAllActiveNews(tick) {
  return db.all(
    `SELECT * FROM news WHERE published = 1 AND impact_start_tick <= ${tick}
     AND (impact_start_tick + impact_duration_ticks) > ${tick};`
  );
}

// ─────────────────────────────────────────────────────────────
// Test A: 真利好正确点火 → 高杠杆做多盈利
// ─────────────────────────────────────────────────────────────
function testA() {
  console.log('【A】真利好正确点火 → 高杠杆做多盈利');

  const code = 'QH-CRA'; // S币
  const startTick = Number(marketRow().current_tick);

  // Insert a real_bullish news with magnitude large enough to eventually ignite
  const newsId = insertNews({
    title: 'TEST-利好',
    content: 'TEST-利好内容',
    source_type: 'official',
    news_type: 'policy',
    visible_sentiment: 'bullish',
    target_type: 'futures',
    target_code: code,
    created_tick: startTick,
    published: 1,
    is_rumor: 0,
    truth_type: 'real_bullish',
    impact_magnitude: 0.12,
    impact_start_tick: startTick,
    impact_duration_ticks: 5,
    is_fluff: 0
  }).id;

  // Open a 7x long position before ignition (at tick 0 of news)
  const m0 = marketRow();
  const entryPrice = priceAt(code, Number(m0.current_tick));
  let user = mkUser('cryptoA', 1_000_000);
  futures.openPosition(user, {
    code, side: 'long', contracts: 1, leverage: 7,
    expectedTick: Number(m0.current_tick), expectedPrice: entryPrice
  }, { market: m0, tradingAllowed: true });

  const posId = db.get(`SELECT id FROM futures_positions WHERE user_id = 'cryptoA';`).id;
  const margin = Number(db.get(`SELECT margin FROM futures_positions WHERE id = ${db.q(posId)};`).margin);

  // Advance tick by tick, feeding allActiveNews each step, until shock fires
  let shockFired = false;
  let shockTick = null;
  for (let step = 0; step < 15; step++) {
    const m = marketRow(); const nt = Number(m.current_tick) + 1;
    const activeNews = getAllActiveNews(nt);
    db.exec(`UPDATE market_state SET current_tick = ${nt} WHERE id = 1;`);
    futures.advanceFutures({ currentTick: m.current_tick, nextTick: nt, stocks: [], activeNews });

    const reg = regimeAt(code);
    if (reg && reg.regime === 'shock') {
      shockFired = true;
      shockTick = nt;
      break;
    }
  }

  check('真利好成功触发 crypto shock 体制', shockFired, shockTick ? `shock fired at tick ${shockTick}` : '');

  const regAfter = regimeAt(code);
  check('shock 体制已写入 commodity_regime', regAfter && regAfter.regime === 'shock');

  if (shockFired) {
    // 巨震当期已盯市，立即测量浮盈，避免后续常规波动侵蚀小幅巨震
    const shockChange = Number(db.get(`SELECT change_pct FROM commodity_prices WHERE code = ${db.q(code)} AND tick = ${shockTick};`).change_pct);
    const posAtShock = db.get(`SELECT * FROM futures_positions WHERE id = ${db.q(posId)};`);
    const pnlAtShock = posAtShock ? Number(posAtShock.unrealized_pnl) : 0;

    // 方向正确：多头在牛向巨震下浮盈为正
    check('高杠杆做多产生显著浮盈', pnlAtShock > 0, `unrealizedPnl=${pnlAtShock.toFixed(2)}`);
    // 量级：断言巨震当期幅度本身（恒 ≥ 0.10 的真不变量，不含噪声）
    check('巨震幅度符合预期(≥10%)', Math.abs(shockChange) >= 0.10, `change_pct=${(shockChange * 100).toFixed(1)}%`);

    // 再单独推进，验证 shock→calm 回滚（与浮盈测量解耦）
    advanceFutures(8, getAllActiveNews(shockTick + 8));
    const regFinal = regimeAt(code);
    check('shock 到期后回归 calm', regFinal && regFinal.regime === 'calm',
      `最终 regime=${regFinal?.regime}`);
  }
  console.log('');
}

// ─────────────────────────────────────────────────────────────
// Test B: 假利好→辟谣反转 → 追多被强平
// ─────────────────────────────────────────────────────────────
function testB() {
  console.log('【B】假利好→辟谣反转 → 追多被强平');

  const code = 'QH-CRA';
  const startTick = Number(marketRow().current_tick);

  // Insert a fake_bullish news
  insertNews({
    title: 'TEST-假利好',
    content: 'TEST-假利好内容',
    source_type: 'social_media',
    news_type: 'rumor',
    visible_sentiment: 'bullish',
    target_type: 'futures',
    target_code: code,
    created_tick: startTick,
    published: 1,
    is_rumor: 0,
    truth_type: 'fake_bullish',
    impact_magnitude: 0.06,
    impact_start_tick: startTick,
    impact_duration_ticks: 6,
    reveal_tick: startTick + 3,
    is_fluff: 0
  });

  // Advance 3 ticks with the fake news active.
  advanceFutures(3, getAllActiveNews(startTick + 1));

  const m0 = marketRow();
  const entryPrice = priceAt(code, Number(m0.current_tick));
  let user = mkUser('cryptoB', 1_000_000);
  futures.openPosition(user, {
    code, side: 'long', contracts: 1, leverage: 8,
    expectedTick: Number(m0.current_tick), expectedPrice: entryPrice
  }, { market: m0, tradingAllowed: true });

  const posId = db.get(`SELECT id FROM futures_positions WHERE user_id = 'cryptoB';`).id;
  const margin = Number(db.get(`SELECT margin FROM futures_positions WHERE id = ${db.q(posId)};`).margin);

  // Insert a refutation news (辟谣) — real_bearish with high magnitude
  insertNews({
    title: '【辟谣】TEST-假利好不实',
    content: '经核实该消息不实。',
    source_type: 'official_clarification',
    news_type: 'policy',
    visible_sentiment: 'bearish',
    target_type: 'futures',
    target_code: code,
    created_tick: Number(m0.current_tick),
    published: 1,
    is_rumor: 1,
    truth_type: 'real_bearish',
    impact_magnitude: 0.14,
    impact_start_tick: Number(m0.current_tick),
    impact_duration_ticks: 4,
    is_fluff: 0
  });

  // Advance tick by tick, waiting for shock
  let shockFired = false;
  let liquidated = false;
  for (let step = 0; step < 15; step++) {
    const m = marketRow(); const nt = Number(m.current_tick) + 1;
    const activeNews = getAllActiveNews(nt);
    db.exec(`UPDATE market_state SET current_tick = ${nt} WHERE id = 1;`);
    futures.advanceFutures({ currentTick: m.current_tick, nextTick: nt, stocks: [], activeNews });

    const reg = regimeAt(code);
    if (reg && reg.regime === 'shock') shockFired = true;

    const pos = db.get(`SELECT * FROM futures_positions WHERE id = ${db.q(posId)};`);
    if (!pos || pos.status !== 'open') {
      liquidated = true;
      break;
    }
  }

  check('辟谣新闻触发 crypto shock', shockFired);
  check('追多仓位被强平', liquidated, liquidated ? '仓位已 liquidated' : '仓位仍在 open (p_reverse=0 应恒为熊向)');

  if (liquidated) {
    const liqTx = db.get(`SELECT * FROM futures_transactions WHERE user_id = 'cryptoB' AND type = 'liquidation' LIMIT 1;`);
    check('liquidation 交易记录存在', !!liqTx);
    const finalCash = Number(reload('cryptoB').cash);
    check('穿仓追偿后现金 ≥ 0', finalCash >= -0.01, `cash=${finalCash.toFixed(2)}`);
  }

  console.log('');
}

// ─────────────────────────────────────────────────────────────
// Test C: 反向机制确定性覆盖（p_reverse = 1）
// ─────────────────────────────────────────────────────────────
function testC() {
  console.log('【C】反向机制确定性覆盖（p_reverse = 1）');

  const code = 'QH-CRB'; // 花剑币 — separate underlying to avoid state clash
  const startTick = Number(marketRow().current_tick);

  // Temporarily set p_reverse = 1 for deterministic reverse
  require('./data').FUTURES_REGIME_PARAMS.crypto.p_reverse = 1;

  // Insert a real_bullish news — should trigger bearish shock due to p_reverse=1
  insertNews({
    title: 'TEST-利好→反向',
    content: 'TEST-利好→反向内容',
    source_type: 'official',
    news_type: 'policy',
    visible_sentiment: 'bullish',
    target_type: 'futures',
    target_code: code,
    created_tick: startTick,
    published: 1,
    is_rumor: 0,
    truth_type: 'real_bullish',
    impact_magnitude: 0.14,
    impact_start_tick: startTick,
    impact_duration_ticks: 5,
    is_fluff: 0
  });

  // Pin direction: open a SHORT position. With p_reverse=1, the bullish news
  // should produce a bearish shock → short position profits.
  const m0 = marketRow();
  const entryPrice = priceAt(code, Number(m0.current_tick));
  let user = mkUser('cryptoC', 1_000_000);
  futures.openPosition(user, {
    code, side: 'short', contracts: 1, leverage: 7,
    expectedTick: Number(m0.current_tick), expectedPrice: entryPrice
  }, { market: m0, tradingAllowed: true });

  // Advance until shock fires
  let shockFired = false;
  let directionBearish = false;
  for (let step = 0; step < 15; step++) {
    const m = marketRow(); const nt = Number(m.current_tick) + 1;
    const activeNews = getAllActiveNews(nt);
    const prevPrice = priceAt(code, Number(m.current_tick));
    db.exec(`UPDATE market_state SET current_tick = ${nt} WHERE id = 1;`);
    futures.advanceFutures({ currentTick: m.current_tick, nextTick: nt, stocks: [], activeNews });

    const reg = regimeAt(code);
    if (reg && reg.regime === 'shock') {
      shockFired = true;
      const shockPrice = priceAt(code, nt);
      directionBearish = shockPrice < prevPrice;
      break;
    }
  }

  check('p_reverse=1 时利好仍触发 shock', shockFired);
  check('shock 方向为熊向（利好被翻转）', directionBearish,
    'p_reverse=1 应使利好→熊向巨震');

  // Short position should show positive PnL
  const pos = db.get(`SELECT * FROM futures_positions WHERE user_id = 'cryptoC' AND status = 'open';`);
  const unrealizedPnl = pos ? Number(pos.unrealized_pnl) : 0;
  check('short 仓位浮盈（验证方向确为熊向）', unrealizedPnl > 0,
    `unrealizedPnl=${unrealizedPnl.toFixed(2)}`);

  console.log('');
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
function main() {
  db.ensureDb();

  // Ensure crypto underlyings have prices at tick 0
  const m = marketRow();
  const tick = Number(m.current_tick);
  const underlyings = db.all(`SELECT * FROM futures_underlyings WHERE regime_engine = 'crypto';`);
  for (const u of underlyings) {
    const exists = db.get(`SELECT 1 FROM commodity_prices WHERE code = ${db.q(u.code)} AND tick = ${tick};`);
    if (!exists) {
      db.exec(`INSERT INTO commodity_prices (code, tick, price, change_pct, created_at)
        VALUES (${db.q(u.code)}, ${tick}, ${Number(u.base_price)}, 0, datetime('now'));`);
    }
  }

  testA();
  testB();
  testC();
  // Reset p_reverse to default for production safety
  require('./data').FUTURES_REGIME_PARAMS.crypto.p_reverse = 0.15;

  console.log(`=== 加密点火 E2E ${failures === 0 ? 'PASS ✓' : `FAIL ✗（${failures} 项）`} ===`);
}

try {
  main();
} catch (err) {
  console.error('测试异常：', err.message);
  console.error(err.stack);
  failures++;
} finally {
  cleanup();
}
process.exit(failures === 0 ? 0 : 1);

// Real end-to-end smoke test: boots the actual HTTP server against a throwaway
// SQLite database on an ephemeral port and drives the username+invite account flow.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const TEST_NOW = '2026-06-01T12:30:00+08:00';
process.env.SSB_CLOCK_NOW = TEST_NOW;
const clock = require('./clock');

const PORT = 4100 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(os.tmpdir(), `ssb_smoke_${process.pid}_${Date.now()}.sqlite`);
const SERVER = path.join(__dirname, 'server.js');

let child;

function cleanup() {
  if (child && !child.killed) child.kill();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${DB_PATH}${suffix}`;
    if (fs.existsSync(file)) {
      try { fs.rmSync(file); } catch { /* ignore */ }
    }
  }
}

function assert(condition, label) {
  if (!condition) throw new Error(`Assertion failed: ${label}`);
}

// --- helper wrappers for the new auth model ---

async function apiPostAt(base, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await res.json();
  return data;
}

async function apiPost(path, body, token) {
  return apiPostAt(BASE, path, body, token);
}

async function apiGet(path, token) {
  const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
  const res = await fetch(BASE + path, { headers });
  const data = await res.json();
  return data;
}

async function registerPlayer(inviteCode, username, password) {
  return apiPost('/api/auth/register', { inviteCode, username, password });
}

async function loginAs(username, password) {
  const body = password ? { username, password } : { username };
  return apiPost('/api/auth/login', body);
}

async function loginAsAt(base, username, password) {
  const body = password ? { username, password } : { username };
  return apiPostAt(base, '/api/auth/login', body);
}

function myRankRow(list = []) {
  return list.find((row) => row.is_me) || null;
}

function holdingSummaryRow(list = [], nickname) {
  return list.find((row) => row.nickname === nickname) || null;
}

function shanghaiIsoDaysAgo(days, hour = 9) {
  const date = clock.addDays(clock.shanghaiParts().date, -days);
  return `${date}T${String(hour).padStart(2, '0')}:00:00+08:00`;
}

function readMarketStateRow() {
  const sqlite = new DatabaseSync(DB_PATH);
  try {
    return sqlite.prepare('SELECT * FROM market_state WHERE id = 1;').get();
  } finally {
    sqlite.close();
  }
}

function setMarketLifecycle(overrides = {}) {
  const sqlite = new DatabaseSync(DB_PATH);
  try {
    const current = sqlite.prepare('SELECT * FROM market_state WHERE id = 1;').get();
    sqlite.prepare(`UPDATE market_state
      SET sleeping = ?,
          sleep_reason = ?,
          sleep_since = ?,
          last_player_activity_at = ?,
          run_started_at = ?,
          updated_at = datetime('now')
      WHERE id = 1;`).run(
      overrides.sleeping ?? current.sleeping ?? 0,
      overrides.sleep_reason ?? current.sleep_reason ?? null,
      overrides.sleep_since ?? current.sleep_since ?? null,
      overrides.last_player_activity_at ?? current.last_player_activity_at ?? null,
      overrides.run_started_at ?? current.run_started_at ?? null
    );
  } finally {
    sqlite.close();
  }
}

function assertStockCatalogMatches(rows) {
  const expected = {
    SSB001: { name: '曜琅光电', volatility: 0.12 },
    SSB002: { name: '达云数据', volatility: 0.105 },
    SSB003: { name: '谷嘉种业', volatility: 0.03 },
    SSB004: { name: '济平医药', volatility: 0.09 },
    SSB005: { name: '炬芯科技', volatility: 0.12 },
    SSB006: { name: '文峰酒业', volatility: 0.03 },
    SSB007: { name: '提树地产', volatility: 0.06 },
    SSB008: { name: '越溪技校', volatility: 0.06 },
    SSB009: { name: '迈达物流', volatility: 0.045 },
    SSB010: { name: '承信金服', volatility: 0.075 },
    SSB011: { name: '低能游戏社', volatility: 0.12 },
    SSB012: { name: '振桓建材', volatility: 0.045 },
    SSB013: { name: '善海环保', volatility: 0.06 },
    SSB014: { name: '邓氪汽车', volatility: 0.12 },
    SSB015: { name: '疾风通信', volatility: 0.075 },
    SSB016: { name: '诺威', volatility: 0.12 },
    SSB017: { name: '兴柏云科', volatility: 0.105 },
    SSB018: { name: '大米汽车', volatility: 0.12 },
    SSB019: { name: '明洛医药', volatility: 0.09 },
    SSB020: { name: '联纳通信', volatility: 0.09 }
  };

  for (const row of rows) {
    const target = expected[row.code];
    if (!target) continue;
    assert(row.name === target.name, `${row.code} uses expected stock name`);
    assert(Number(row.volatility) === target.volatility, `${row.code} uses expected stock volatility`);
  }
}

function assertClockRules() {
  const beforeOpen = new Date('2026-06-01T07:59:00+08:00');
  const open = new Date('2026-06-01T08:00:00+08:00');
  const lateLaunch = new Date('2026-06-01T10:30:00+08:00');
  const beforeClose = new Date('2026-06-01T15:59:00+08:00');
  const close = new Date('2026-06-01T16:00:00+08:00');
  const afterClose = new Date('2026-06-01T17:00:00+08:00');
  const missed = new Date('2026-06-01T10:30:00+08:00');

  assert(clock.isTradingAllowed(beforeOpen) === false, 'market is closed before 08:00');
  assert(clock.isTradingAllowed(open) === true, 'market opens at 08:00');
  assert(clock.isTradingAllowed(beforeClose) === true, 'market stays open before 16:00');
  assert(clock.isTradingAllowed(close) === true, 'market stays open at 16:00 (last tick)');
  assert(clock.isTradingAllowed(afterClose) === false, 'market closes at 17:00');
  assert(clock.isAdvanceMoment(open) === true, '08:00 is an advance moment');
  assert(clock.isAdvanceMoment(close) === true, '16:00 is the final advance moment');
  assert(clock.isAdvanceMoment(missed) === false, '10:30 does not catch up missed ticks');
  assert(clock.nextAdvanceAt(beforeOpen) === '2026-06-01T08:00:00+08:00', 'next advance before open is 08:00');
  assert(clock.nextAdvanceAt(beforeClose) === '2026-06-01T16:00:00+08:00', 'next advance before close is 16:00');
  assert(clock.nextAdvanceAt(close) === '2026-06-02T08:00:00+08:00', 'next advance after close is next day');
  assert(clock.buildMarketClock({ day_tick_index: 3 }, open).daily_tick_total === clock.DAILY_TICK_TOTAL, 'daily cycle has correct ticks');
  assert(clock.buildMarketClock({ market_date: '2026-06-01', cycle_started_at: '2026-06-01T10:30:00+08:00' }, lateLaunch).daily_tick_total === 5, 'launch day total shrinks to the remaining scheduled ticks');
  assert(clock.calendarDayDiff('2026-06-01T09:00:00+08:00', new Date('2026-06-08T08:00:00+08:00')) === 7, 'calendar day diff follows Shanghai natural days');
  assert(clock.calendarDayDiff('2026-06-01T09:00:00+08:00', new Date('2026-06-07T23:59:59+08:00')) === 6, 'calendar day diff does not roll by raw hours');
  assert(clock.autoAdvanceDecision({ last_auto_advance_key: clock.advanceKey(open) }, open).should_advance === false, 'auto advance is idempotent per hour');
  assert(clock.autoAdvanceDecision({ sleeping: 1 }, open).reason === 'market_sleeping', 'auto advance stops when market is sleeping');
}

function assertNewsEngineRules(tick) {
  const sqlite = new DatabaseSync(DB_PATH);
  try {
    const rows = sqlite.prepare(`SELECT * FROM news WHERE created_tick = ${tick} AND is_rumor = 0;`).all();
    assert(rows.length >= 0 && rows.length <= 8, 'generated news count stays within 0-8');
    for (const row of rows) {
      const duration = Number(row.impact_duration_ticks);
      if (row.is_fluff) continue;
      if (row.truth_type === 'ambiguous') {
        assert(duration >= 2 && duration <= 4, 'ambiguous news impact duration is doubled');
      } else {
        assert(duration >= 4 && duration <= 8, 'directional news impact duration is doubled');
      }
    }

    const stocks = sqlite.prepare('SELECT code, industry FROM stocks;').all();
    const industryByCode = Object.fromEntries(stocks.map((stock) => [stock.code, stock.industry]));
    const activeRows = sqlite.prepare(`SELECT * FROM news WHERE published = 1 AND impact_start_tick <= ${tick}
      AND (impact_start_tick + impact_duration_ticks) > ${tick};`).all();

    for (let i = 0; i < activeRows.length; i += 1) {
      for (let j = i + 1; j < activeRows.length; j += 1) {
        const left = activeRows[i];
        const right = activeRows[j];
        const leftDirection = newsDirection(left, tick);
        const rightDirection = newsDirection(right, tick);
        if (!leftDirection || !rightDirection) continue;
        const conflicts = leftDirection === -rightDirection && hasPrimaryOverlap(left, right, industryByCode);
        assert(!conflicts, 'active random news avoids opposite primary-target conflicts');
      }
    }
  } finally {
    sqlite.close();
  }
}

function newsDirection(row, tick) {
  if (row.truth_type === 'ambiguous') return 0;
  if (String(row.truth_type || '').startsWith('fake') && row.reveal_tick && tick >= row.reveal_tick) return 0;
  if (row.visible_sentiment === 'bullish') return 1;
  if (row.visible_sentiment === 'bearish') return -1;
  return 0;
}

function hasPrimaryOverlap(left, right, industryByCode) {
  if (left.target_type === 'market' || right.target_type === 'market') {
    return left.target_type === 'market' && right.target_type === 'market';
  }
  if (left.target_type === right.target_type) return left.target_code === right.target_code;
  if (left.target_type === 'stock' && right.target_type === 'industry') {
    return industryByCode[left.target_code] === right.target_code;
  }
  if (left.target_type === 'industry' && right.target_type === 'stock') {
    return left.target_code === industryByCode[right.target_code];
  }
  return false;
}

async function call(method, route, body, token) {
  return callAt(BASE, method, route, body, token);
}

async function callAt(base, method, route, body, token) {
  const init = { method, headers: {} };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (body) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${route}`, init);
  const json = await res.json();
  return { res, json };
}

async function quoteTradeAt(base, token, action, stockCode, lots) {
  const state = await callAt(base, 'GET', `/api/state?selectedCode=${stockCode}`, null, token);
  assert(state.json.code === 0, `quoted state loads before ${action} ${stockCode}`);
  const quote = state.json.data.prices.find((item) => item.stock_code === stockCode);
  assert(quote && quote.close > 0, `quote exists before ${action} ${stockCode}`);
  return callAt(base, 'POST', '/api/trade', {
    action,
    stockCode,
    lots,
    expectedTick: state.json.data.current_tick,
    expectedPrice: quote.close
  }, token);
}

async function waitForReady(timeoutMs = 8000) {
  return waitForReadyAt(BASE, timeoutMs);
}

async function waitForReadyAt(base, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const data = await loginAsAt(base, 'SSB-DEMO');
      if (data.code === 0) return data.data.token;
    } catch { /* server not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('server did not become ready in time');
}

async function assertClosedMarketRejectsTrading() {
  const closedPort = PORT + 1200 + Math.floor(Math.random() * 800);
  const closedBase = `http://127.0.0.1:${closedPort}`;
  const closedDbPath = path.join(os.tmpdir(), `ssb_smoke_closed_${process.pid}_${Date.now()}.sqlite`);
  const closedChild = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: {
      ...process.env,
      PORT: String(closedPort),
      SSB_DB_PATH: closedDbPath,
      SSB_DISABLE_CLOCK: '1',
      SSB_CLOCK_NOW: '2026-06-01T17:01:00+08:00'
    },
    stdio: ['ignore', 'ignore', 'inherit']
  });

  try {
    const token = await waitForReadyAt(closedBase);
    const state = await callAt(closedBase, 'GET', '/api/state?selectedCode=SSB001', null, token);
    assert(state.json.data.market_clock.trading_allowed === false, 'closed server reports trading disabled');
    const trade = await quoteTradeAt(closedBase, token, 'buy', 'SSB001', 1);
    assert(trade.json.code !== 0, 'closed market rejects buy request');
    assert(/封盘/.test(trade.json.message || ''), 'closed market returns clear close message');
  } finally {
    if (!closedChild.killed) closedChild.kill();
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${closedDbPath}${suffix}`;
      if (fs.existsSync(file)) {
        try { fs.rmSync(file); } catch { /* ignore */ }
      }
    }
  }
}

async function main() {
  assertClockRules();

  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: {
      ...process.env,
      PORT: String(PORT),
      SSB_DB_PATH: DB_PATH,
      SSB_DISABLE_CLOCK: '1',
      SSB_FORCE_MARKET_OPEN: '1',
      SSB_CLOCK_NOW: TEST_NOW
    },
    stdio: ['ignore', 'ignore', 'inherit']
  });

  await waitForReady();

  // --- admin login (passwordless) ---
  const adminLogin = await call('POST', '/api/auth/login', { username: 'SSB-DEMO' });
  assert(adminLogin.json.code === 0, 'admin passwordless login succeeds');
  const adminToken = adminLogin.json.data.token;
  assert(adminLogin.json.data.user.is_admin === true, 'SSB-DEMO is admin');

  const adminState = await call('GET', '/api/state?selectedCode=SSB001', null, adminToken);
  assert(adminState.json.code === 0, 'admin state succeeds');
  assert(Array.isArray(adminState.json.data.stocks) && adminState.json.data.stocks.length === 36, 'state carries 36 stocks');
  assert(adminState.json.data.stocks[0].code === 'SSB001', 'default stock code uses SSB prefix');
  assert(adminState.json.data.stocks.find((stock) => stock.code === 'SSB036'), 'state includes expanded default stocks');
  assertStockCatalogMatches(adminState.json.data.stocks);
  assert(adminState.json.data.market_overview.current_index > 0, 'state carries market index overview');
  assert(adminState.json.data.market_clock.daily_tick_total >= 0 && adminState.json.data.market_clock.daily_tick_total <= 8, 'state carries a bounded daily clock total');

  const adminStocks = await call('GET', '/api/admin/stocks', null, adminToken);
  assert(adminStocks.json.code === 0, 'admin stocks endpoint succeeds');
  assert(adminStocks.json.data.stocks.length === 36, 'admin sees stock catalog');

  const addStock = await call('POST', '/api/admin/stocks', {
    code: 'SSB900',
    name: '测试扩容',
    industry: '测试行业',
    mapping: '',
    initial_price: 12.34,
    volatility: 0.075,
        risk_level: 'mid'
  }, adminToken);
  assert(addStock.json.code === 0, 'admin can add a stock');

  const buyAddedStock = await quoteTradeAt(BASE, adminToken, 'buy', 'SSB900', 1);
  assert(buyAddedStock.json.code === 0, 'added stock can be traded');
  assert(buyAddedStock.json.data.holdings.find((h) => h.stock_code === 'SSB900'), 'added stock holding is recorded');

  const renameAddedStock = await call('POST', '/api/admin/stocks/update', {
    currentCode: 'SSB900',
    code: 'SSB901',
    name: '测试扩容二号',
    industry: '测试行业',
    mapping: '',
    initial_price: 12.34,
    volatility: 0.09,
        risk_level: 'high'
  }, adminToken);
  assert(renameAddedStock.json.code === 0, 'admin can update stock code');

  const afterStockRename = await call('GET', '/api/state?selectedCode=SSB901', null, adminToken);
  assert(afterStockRename.json.data.stocks.find((s) => s.code === 'SSB901'), 'renamed stock appears in catalog');
  assert(afterStockRename.json.data.holdings.find((h) => h.stock_code === 'SSB901'), 'holding migrates to renamed stock code');
  assert(afterStockRename.json.data.transactions.find((tx) => tx.stock_code === 'SSB901'), 'transaction history migrates to renamed stock code');

  const initialRanking = await call('GET', '/api/ranking', null, adminToken);
  assert(initialRanking.json.code === 0, 'ranking endpoint succeeds');
  assert(initialRanking.json.data.asset.length === 0, 'unregistered players are hidden from ranking');

  // --- unknown login rejected ---
  const unknownAccount = await loginAs('SSB404', 'badpass');
  assert(unknownAccount.code !== 0, 'unknown username rejected');

  // --- invite code generation ---
  const invites = await apiPost('/api/admin/invites/generate', { count: 3 }, adminToken);
  assert(invites.code === 0 && invites.data.codes.length === 3, 'admin can generate invite codes');
  const inviteCode1 = invites.data.codes[0];
  const inviteCode2 = invites.data.codes[1];
  const inviteCode3 = invites.data.codes[2];

  // set nicknames on invites
  await apiPost('/api/admin/invites/update', { code: inviteCode1, nickname: '演示玩家01' }, adminToken);
  await apiPost('/api/admin/invites/update', { code: inviteCode2, nickname: '演示玩家02' }, adminToken);
  await apiPost('/api/admin/invites/update', { code: inviteCode3, nickname: '新玩家' }, adminToken);

  // --- player registration ---
  const player1Reg = await registerPlayer(inviteCode1, 'SSBTY', 'secret123');
  assert(player1Reg.code === 0, 'player registration succeeds');
  assert(player1Reg.data.token, 'registration returns token');
  const playerToken = player1Reg.data.token;
  assert(player1Reg.data.user.is_admin === false, 'registered player is not admin');

  // --- duplicate registration rejected ---
  const dupReg = await registerPlayer(inviteCode1, 'SSBTY2', 'badpass');
  assert(dupReg.code !== 0, 'used invite code rejected');

  // --- duplicate username rejected ---
  const dupUser = await registerPlayer(inviteCode2, 'SSBTY', 'secret456');
  assert(dupUser.code !== 0, 'duplicate username rejected');

  // --- wrong password rejected ---
  const wrongPassword = await loginAs('SSBTY', 'wrong123');
  assert(wrongPassword.code !== 0, 'wrong password rejected');

  // --- player login with password ---
  const playerLogin = await loginAs('SSBTY', 'secret123');
  assert(playerLogin.code === 0 && playerLogin.data.token, 'registered player can log in with password');

  // --- sports catalog and betting ---
  const sportsOverview = await call('GET', '/api/sports/overview', null, adminToken);
  assert(sportsOverview.json.code === 0, 'sports overview endpoint succeeds');
  assert(sportsOverview.json.data.teams.length === 16, 'sports overview exposes 16 basketball teams');
  assert(sportsOverview.json.data.config.max_bet_per_match === 100000, 'sports per-match limit is 100000');
  const sportsPlayoffs = await call('GET', '/api/sports/playoffs', null, adminToken);
  assert(sportsPlayoffs.json.code === 0 && Array.isArray(sportsPlayoffs.json.data.series), 'sports playoffs endpoint exposes bracket series');
  const sportsOpenMatch = sportsOverview.json.data.matches.find((match) => match.status === 'open');
  assert(sportsOpenMatch, 'sports overview exposes an open match');
  const lowSportsBet = await call('POST', '/api/sports/bet', {
    matchId: sportsOpenMatch.id,
    selectionTeamId: sportsOpenMatch.home_team.id,
    amount: 999
  }, adminToken);
  assert(lowSportsBet.json.code !== 0, 'sports rejects bets below 1000');
  const sportsBet = await call('POST', '/api/sports/bet', {
    matchId: sportsOpenMatch.id,
    selectionTeamId: sportsOpenMatch.home_team.id,
    amount: 1000
  }, adminToken);
  assert(sportsBet.json.code === 0, 'sports bet succeeds');
  assert(sportsBet.json.data.sports_account.pending_stake === 1000, 'sports account exposes pending stake');
  const sportsAdmin = await call('GET', '/api/admin/sports', null, adminToken);
  assert(sportsAdmin.json.code === 0 && sportsAdmin.json.data.totals.staked === 1000, 'admin sports audit exposes stake total');
  const sportsAudit = await call('GET', '/api/admin/sports/audit', null, adminToken);
  assert(sportsAudit.json.code === 0 && sportsAudit.json.data.cash_events.length === 1, 'admin sports audit endpoint exposes cash events');

  // --- fund catalog and trading ---
  const fundList = await call('GET', '/api/funds/list', null, playerToken);
  assert(fundList.json.code === 0 && fundList.json.data.length === 11, 'fund list exposes all default funds');
  const indexFund = fundList.json.data.find((fund) => fund.code === 'GD01');
  const cashFund = fundList.json.data.find((fund) => fund.code === 'GD02');
  assert(indexFund && cashFund, 'fund list contains index and money funds');
  assert(fundList.json.data.every((fund) => fund.nav === 1 && fund.has_performance === false),
    'fresh fund list identifies the common 1.0000 unit NAV as pre-performance');

  const indexDetail = await call('GET', '/api/funds/GD01', null, playerToken);
  assert(indexDetail.json.code === 0 && indexDetail.json.data.weights.length === 20, 'passive fund detail exposes price-weight holdings for 20-component index');
  assert(indexDetail.json.data.component_count === 20 && /20 只股票价格加权配置/.test(indexDetail.json.data.composition_summary),
    'narrow index detail explains component count and price weighting');
  const blueDetail = await call('GET', '/api/funds/SH01', null, playerToken);
  assert(blueDetail.json.code === 0 && blueDetail.json.data.weights.length === 6,
    'blue-chip passive fund detail exposes all low-risk components');
  const overseasDetail = await call('GET', '/api/funds/TY03', null, playerToken);
  assert(overseasDetail.json.code === 0 && /海外市场资产/.test(overseasDetail.json.data.asset_description),
    'independent fund detail explains its external asset source');
  const activeDetail = await call('GET', '/api/funds/TY01', null, playerToken);
  assert(activeDetail.json.code === 0 && activeDetail.json.data.weights.length > 0, 'active fund detail exposes delayed heavy holdings');

  const fundBuy = await call('POST', '/api/funds/buy', {
    fundCode: indexFund.code,
    amount: 1000,
    expectedTick: 1,
    expectedNav: indexFund.nav
  }, playerToken);
  assert(fundBuy.json.code === 0, 'ordinary fund subscription succeeds');
  const boughtFund = fundBuy.json.data.holdings.find((holding) => holding.fund_code === indexFund.code);
  assert(boughtFund && boughtFund.available_shares === 0, 'ordinary fund subscription is T+1');
  assert(fundBuy.json.data.user.fund_value > 0, 'unified user valuation includes fund value');
  assert(fundBuy.json.data.user.total_asset === fundBuy.json.data.user.net_total_asset, 'public total asset uses unified net asset');

  const fundSellEarly = await call('POST', '/api/funds/sell', {
    fundCode: indexFund.code,
    shares: 1,
    expectedTick: 1,
    expectedNav: indexFund.nav
  }, playerToken);
  assert(fundSellEarly.json.code !== 0 && /可赎回份额不足/.test(fundSellEarly.json.message || ''), 'ordinary fund T+1 blocks same-tick redemption');

  const cashBuy = await call('POST', '/api/funds/buy', {
    fundCode: cashFund.code,
    amount: 100,
    expectedTick: 1,
    expectedNav: cashFund.nav
  }, playerToken);
  assert(cashBuy.json.code === 0, 'money fund subscription succeeds');
  const boughtCashFund = cashBuy.json.data.holdings.find((holding) => holding.fund_code === cashFund.code);
  assert(boughtCashFund.available_shares === boughtCashFund.shares, 'money fund is T+0');
  const cashSell = await call('POST', '/api/funds/sell', {
    fundCode: cashFund.code,
    shares: boughtCashFund.shares,
    expectedTick: 1,
    expectedNav: cashFund.nav
  }, playerToken);
  assert(cashSell.json.code === 0, 'money fund can be redeemed in the same tick');

  const fundHistory = await call('GET', '/api/funds/history', null, playerToken);
  assert(fundHistory.json.code === 0 && fundHistory.json.data.length >= 3, 'fund transaction history is exposed');
  const loanStatusWithFund = await call('GET', '/api/loan/status', null, playerToken);
  const rawLimit = Math.floor(fundBuy.json.data.user.net_total_asset * 0.5);
  const expectedLimit = Math.round(rawLimit / 50000) * 50000;
  assert(loanStatusWithFund.json.data.max_loan_amount === expectedLimit,
    'loan limit is based on unified net asset including funds (rounded to 50k)');

  // --- admin overview ---
  const adminOverview = await call('GET', '/api/admin/overview', null, adminToken);
  assert(adminOverview.json.code === 0, 'admin overview succeeds');
  assert(adminOverview.json.data.active_count === 1, 'one normal player is registered');
  assert(adminOverview.json.data.market_clock.daily_tick_total === adminState.json.data.market_clock.daily_tick_total, 'admin overview carries the same dynamic daily clock total');

  // --- player ranking ---
  const playerRanking = await call('GET', '/api/ranking', null, playerToken);
  assert(playerRanking.json.code === 0, 'player ranking succeeds');
  assert(playerRanking.json.data.asset.length === 1, 'ranking shows registered player');
  assert(Array.isArray(playerRanking.json.data.today) && playerRanking.json.data.today.length === 1, 'ranking carries today return board');
  assert(playerRanking.json.data.asset[0].nickname === '演示玩家01', 'ranking shows player nickname');
  assert(playerRanking.json.data.my.asset_rank === 1, 'ranking marks current player');

  const awakeActivityAnchor = shanghaiIsoDaysAgo(2, 9);
  setMarketLifecycle({
    sleeping: 0,
    sleep_reason: null,
    sleep_since: null,
    last_player_activity_at: awakeActivityAnchor,
    run_started_at: shanghaiIsoDaysAgo(2, 8)
  });
  const awakeState = await call('GET', '/api/state?selectedCode=SSB001', null, playerToken);
  assert(awakeState.json.code === 0 && awakeState.json.data.sleeping === false, 'active player can read state while market is awake');
  const awakeMarket = readMarketStateRow();
  assert(awakeMarket.last_player_activity_at !== awakeActivityAnchor, 'awake player state request refreshes last player activity');

  const adminAnchor = shanghaiIsoDaysAgo(2, 10);
  setMarketLifecycle({
    sleeping: 0,
    sleep_reason: null,
    sleep_since: null,
    last_player_activity_at: adminAnchor,
    run_started_at: shanghaiIsoDaysAgo(2, 8)
  });
  const adminOverviewPassive = await call('GET', '/api/admin/overview', null, adminToken);
  assert(adminOverviewPassive.json.code === 0, 'admin overview still loads during active cycle');
  assert(readMarketStateRow().last_player_activity_at === adminAnchor, 'admin activity does not refresh last player activity');

  const inactiveAnchor = shanghaiIsoDaysAgo(8, 9);
  setMarketLifecycle({
    sleeping: 0,
    sleep_reason: null,
    sleep_since: null,
    last_player_activity_at: inactiveAnchor,
    run_started_at: shanghaiIsoDaysAgo(1, 8)
  });
  const sleepingState = await call('GET', '/api/state?selectedCode=SSB001', null, playerToken);
  assert(sleepingState.json.code === 0 && sleepingState.json.data.sleeping === true, 'inactive market auto-enters sleeping state');
  assert(sleepingState.json.data.market_clock.sleep_reason === 'inactive', 'inactive sleep reason is exposed to clients');
  assert(readMarketStateRow().last_player_activity_at === inactiveAnchor, 'sleeping state view does not refresh player activity');

  const sleepingTrade = await quoteTradeAt(BASE, playerToken, 'buy', 'SSB001', 1);
  assert(sleepingTrade.json.code !== 0, 'sleeping market rejects player trades');
  assert(/休眠/.test(sleepingTrade.json.message || ''), 'sleeping trade rejection mentions market sleep');

  const sleepingAdvance = await call('POST', '/api/admin/advance', null, adminToken);
  assert(sleepingAdvance.json.code !== 0, 'sleeping market blocks manual admin advance');
  assert(/休眠/.test(sleepingAdvance.json.message || ''), 'sleeping manual advance returns a clear message');

  const resumeInactive = await call('POST', '/api/market/resume', null, playerToken);
  assert(resumeInactive.json.code === 0 && resumeInactive.json.data.sleeping === false, 'players can resume a sleeping market');
  assert(resumeInactive.json.data.current_tick === sleepingState.json.data.current_tick, 'resume does not immediately advance the tick');
  const resumedInactiveMarket = readMarketStateRow();
  assert(Number(resumedInactiveMarket.sleeping) === 0, 'resume clears sleeping flag');
  assert(!resumedInactiveMarket.sleep_reason && !resumedInactiveMarket.sleep_since, 'resume clears sleep metadata');
  assert(resumedInactiveMarket.last_player_activity_at !== inactiveAnchor, 'resume resets last player activity timestamp');
  assert(resumedInactiveMarket.run_started_at !== shanghaiIsoDaysAgo(1, 8), 'resume resets the continuous run timestamp');

  const stateAfterResume = await call('GET', '/api/state?selectedCode=SSB001', null, playerToken);
  assert(stateAfterResume.json.code === 0 && stateAfterResume.json.data.sleeping === false, 'market is awake after resume');
  assert(stateAfterResume.json.data.market_clock.next_advance_at, 'resume keeps the next scheduled advance in the future');

  const runtimeAnchor = shanghaiIsoDaysAgo(15, 8);
  const runtimeInactiveAnchor = shanghaiIsoDaysAgo(8, 9);
  setMarketLifecycle({
    sleeping: 0,
    sleep_reason: null,
    sleep_since: null,
    last_player_activity_at: runtimeInactiveAnchor,
    run_started_at: runtimeAnchor
  });
  const runtimeSleepState = await call('GET', '/api/state?selectedCode=SSB001', null, playerToken);
  assert(runtimeSleepState.json.code === 0 && runtimeSleepState.json.data.sleeping === true, 'runtime cap can also put market to sleep');
  assert(runtimeSleepState.json.data.market_clock.sleep_reason === 'runtime_cap', 'runtime cap takes priority over inactivity when both apply');
  const runtimeMarket = readMarketStateRow();
  assert(runtimeMarket.sleep_reason === 'runtime_cap', 'runtime cap sleep reason is persisted');
  assert(runtimeMarket.last_player_activity_at === runtimeInactiveAnchor, 'sleeping runtime-cap view does not refresh player activity');

  const resumeRuntime = await call('POST', '/api/market/resume', null, playerToken);
  assert(resumeRuntime.json.code === 0 && resumeRuntime.json.data.sleeping === false, 'players can resume a runtime-cap sleep as well');

  const secondPlayerReg = await registerPlayer(inviteCode2, 'SSBXS', 'secret456');
  assert(secondPlayerReg.code === 0 && secondPlayerReg.data.token, 'second player registration succeeds');
  const secondToken = secondPlayerReg.data.token;

  const secondBuy = await quoteTradeAt(BASE, secondToken, 'buy', 'SSB002', 1);
  assert(secondBuy.json.code === 0, 'second player buy succeeds');
  const secondHolding = secondBuy.json.data.holdings.find((h) => h.stock_code === 'SSB002');
  assert(secondHolding && secondHolding.quantity === 100, 'second player holding lands in second account');

  const firstAfterSecondBuy = await call('GET', '/api/state?selectedCode=SSB002', null, playerToken);
  assert(firstAfterSecondBuy.json.code === 0, 'first player state still loads after second player trade');
  assert(!firstAfterSecondBuy.json.data.holdings.find((h) => h.stock_code === 'SSB002'), 'holdings are isolated by account');
  assert(!firstAfterSecondBuy.json.data.transactions.find((tx) => tx.stock_code === 'SSB002'), 'transactions are isolated by account');

  const firstPlayerBuy = await quoteTradeAt(BASE, playerToken, 'buy', 'SSB003', 1);
  assert(firstPlayerBuy.json.code === 0, 'first player buy succeeds to register as operated user');

  const rankingWithTwo = await call('GET', '/api/ranking', null, playerToken);
  assert(rankingWithTwo.json.data.asset.length === 2, 'ranking shows both registered players only');

  const loanPlayerReg = await registerPlayer(inviteCode3, 'SSBNEW', 'loan1234');
  assert(loanPlayerReg.code === 0 && loanPlayerReg.data.token, 'loan scenario player registration succeeds');
  const loanPlayerToken = loanPlayerReg.data.token;

  const loanPrepBuys = [
    ['SSB018', 44],
    ['SSB014', 39],
    ['SSB005', 33],
    ['SSB002', 30]
  ];
  let loanPrepState = null;
  for (const [stockCode, lots] of loanPrepBuys) {
    const buyResult = await quoteTradeAt(BASE, loanPlayerToken, 'buy', stockCode, lots);
    assert(buyResult.json.code === 0, `loan scenario pre-buy ${stockCode} succeeds`);
    loanPrepState = buyResult.json.data;
  }

  const lowCashBeforeLoan = Number(loanPrepState.user.cash);
  assert(lowCashBeforeLoan < 19219.2, 'loan scenario player cash is too low to buy two lots before borrowing');

  const blockedBeforeLoan = await quoteTradeAt(BASE, loanPlayerToken, 'buy', 'SSB006', 2);
  assert(blockedBeforeLoan.json.code !== 0, 'loan scenario player cannot buy before borrowing');
  assert(/可用资金不足/.test(blockedBeforeLoan.json.message || ''), 'loan scenario surfaces insufficient cash before borrowing');

  const rankingBeforeBorrow = await call('GET', '/api/ranking', null, loanPlayerToken);
  const myAssetBeforeBorrow = myRankRow(rankingBeforeBorrow.json.data.asset);
  const myTodayBeforeBorrow = myRankRow(rankingBeforeBorrow.json.data.today);

  // 先验证非法 term_ticks 被拒绝（额度允许、星级允许、但 term 不在可用列表）
  const badTermBorrow = await call('POST', '/api/loan/borrow', { amount: 50000, term_ticks: 999 }, loanPlayerToken);
  assert(badTermBorrow.json.code !== 0, 'borrow with illegal term_ticks 999 is rejected');

  const borrowLoan = await call('POST', '/api/loan/borrow', { amount: 100000 }, loanPlayerToken);
  assert(borrowLoan.json.code === 0, 'loan borrow request succeeds');
  assert(borrowLoan.json.data.has_active_loan === true, 'loan status marks player as having an active loan');
  assert(borrowLoan.json.data.active_loan && borrowLoan.json.data.active_loan.principal === 100000, 'loan status returns the borrowed principal');

  const afterBorrowState = await call('GET', '/api/state?selectedCode=SSB006', null, loanPlayerToken);
  assert(afterBorrowState.json.code === 0, 'state loads after borrowing');
  assert(afterBorrowState.json.data.user.cash === Number((lowCashBeforeLoan + 100000).toFixed(2)), 'borrowed amount is credited into user cash');
  assert(afterBorrowState.json.data.active_loan && afterBorrowState.json.data.active_loan.principal === 100000, 'state exposes the active loan after borrowing');

  // 验证 available_terms 与 tier 一致
  const loanStatusCheck = await call('GET', '/api/loan/status', null, loanPlayerToken);
  assert(loanStatusCheck.json.code === 0, 'loan status loads for available_terms check');
  assert(Array.isArray(loanStatusCheck.json.data.available_terms), 'available_terms is an array');
  assert(loanStatusCheck.json.data.available_terms.length >= 1, 'tier 1 has at least 1 available term');
  assert(loanStatusCheck.json.data.available_terms[0] === 16, 'tier 1 shortest term is 16 ticks');
  assert(loanStatusCheck.json.data.default_term_ticks === 16, 'default term is 16 for tier 1');
  assert(loanStatusCheck.json.data.tier_config && Array.isArray(loanStatusCheck.json.data.tier_config.caps), 'tier_config.caps is provided');
  assert(loanStatusCheck.json.data.tier_config && Array.isArray(loanStatusCheck.json.data.tier_config.rates), 'tier_config.rates is provided');

  // 验证非法 term_ticks 被拒绝（当前已有活跃贷款，先用另一个方式验证：还款后重新借）
  // 这里验证 API 返回 structure 正确，term_ticks 校验在后端逻辑中由 allowedTermOptions 保证

  const rankingAfterBorrow = await call('GET', '/api/ranking', null, loanPlayerToken);
  const myAssetAfterBorrow = myRankRow(rankingAfterBorrow.json.data.asset);
  const myTodayAfterBorrow = myRankRow(rankingAfterBorrow.json.data.today);
  assert(myAssetBeforeBorrow && myAssetAfterBorrow, 'ranking exposes the borrower in asset standings');
  assert(myTodayBeforeBorrow && myTodayAfterBorrow, 'ranking exposes the borrower in today standings');
  assert(myAssetAfterBorrow.total_asset === myAssetBeforeBorrow.total_asset, 'borrowing cash does not inflate ranking net asset');
  assert(myTodayAfterBorrow.return_today === myTodayBeforeBorrow.return_today, 'borrowing cash does not inflate ranking today return');

  const sqliteAfterBorrow = new DatabaseSync(DB_PATH);
  try {
    const row = sqliteAfterBorrow.prepare(`SELECT id FROM users WHERE username = 'SSBNEW';`).get();
    sqliteAfterBorrow.prepare(`DELETE FROM asset_snapshots WHERE user_id = ?;`).run(row.id);
  } finally {
    sqliteAfterBorrow.close();
  }
  const rankingWithoutBaselineSnapshot = await call('GET', '/api/ranking', null, loanPlayerToken);
  const myTodayWithoutBaselineSnapshot = myRankRow(rankingWithoutBaselineSnapshot.json.data.today);
  assert(myTodayWithoutBaselineSnapshot.return_today > -0.01, 'missing baseline snapshot falls back to initial asset instead of borrowed gross asset');

  const holdingsAfterBorrow = await call('GET', '/api/all-holdings', null, loanPlayerToken);
  const loanHoldingSummary = holdingSummaryRow(holdingsAfterBorrow.json.data, '新玩家');
  assert(loanHoldingSummary, 'all-holdings exposes the loan scenario player');
  assert(loanHoldingSummary.total_asset === myAssetAfterBorrow.total_asset, 'borrowing cash does not inflate all-holdings net asset');

  const fundedAfterLoan = await quoteTradeAt(BASE, loanPlayerToken, 'buy', 'SSB006', 2);
  assert(fundedAfterLoan.json.code === 0, 'loan scenario player can buy immediately after borrowed cash arrives');

  const nonAdminSingleReset = await call('POST', '/api/admin/reset-password', { username: 'SSBXS' }, playerToken);
  assert(nonAdminSingleReset.json.code !== 0, 'normal player cannot reset a password');

  const resetSecondPassword = await call('POST', '/api/admin/reset-password', { username: 'SSBXS' }, adminToken);
  assert(resetSecondPassword.json.code === 0, 'admin can reset one player password');
  assert(resetSecondPassword.json.data.account.activated === false, 'single reset deactivates that player');

  const staleSecondState = await call('GET', '/api/state?selectedCode=SSB002', null, secondToken);
  assert(staleSecondState.json.code !== 0, 'single reset invalidates that player session');

  const secondAfterReset = await loginAs('SSBXS', 'secret456');
  assert(secondAfterReset.code !== 0, 'reset player cannot log in with old password');

  // Full reset of SSBXS player
  const fullReset = await call('POST', '/api/admin/reset-player', { username: 'SSBXS' }, adminToken);
  assert(fullReset.json.code === 0, 'admin can reset a player fully');

  // Generate fresh invite and register a new player
  const freshInvite = await apiPost('/api/admin/invites/generate', { count: 1 }, adminToken);
  await apiPost('/api/admin/invites/update', { code: freshInvite.data.codes[0], nickname: '演示玩家03' }, adminToken);
  const newPlayerReg = await registerPlayer(freshInvite.data.codes[0], 'SSBXSB', 'secret789');
  assert(newPlayerReg.code === 0 && newPlayerReg.data.token, 'new player can register with fresh invite');

  const beforeStockBuy = await call('GET', '/api/state?selectedCode=SSB001', null, playerToken);
  const buy = await quoteTradeAt(BASE, playerToken, 'buy', 'SSB001', 1);
  assert(buy.json.code === 0, 'player buy succeeds');
  const bought = buy.json.data.holdings.find((h) => h.stock_code === 'SSB001');
  assert(bought && bought.quantity === 100, 'holding is 100 shares after buy');
  assert(bought.available_quantity === 0, 'T+1: bought shares not yet sellable');
  const buyTx = buy.json.data.transactions.find((tx) => tx.stock_code === 'SSB001' && tx.type === 'buy');
  assert(!!buyTx, 'buy response includes the latest transaction');
  const expectedCashAfterBuy = Number((beforeStockBuy.json.data.user.cash - (buyTx.quantity * buyTx.price + buyTx.fee)).toFixed(2));
  assert(buy.json.data.user.cash === expectedCashAfterBuy, 'buy response returns fresh user cash');
  assert(buy.json.data.selected_order_flow.stock_code === 'SSB001', 'state carries selected stock order flow');
  assert(buy.json.data.selected_order_flow.buy_quantity === 100, 'buy updates same-tick buy quantity');
  assert(buy.json.data.selected_order_flow.net_quantity === 100, 'buy updates same-tick net quantity');
  assert(buy.json.data.selected_order_flow.price_impact > 0, 'buy-side order flow produces positive next-tick impact');

  const sellEarly = await quoteTradeAt(BASE, playerToken, 'sell', 'SSB001', 1);
  assert(sellEarly.json.code !== 0, 'T+1 blocks selling before advance');

  const nonAdminOverview = await call('GET', '/api/admin/overview', null, playerToken);
  assert(nonAdminOverview.json.code !== 0, 'normal player cannot access admin overview');

  const advance = await call('POST', '/api/admin/advance', null, adminToken);
  assert(advance.json.code === 0 && advance.json.data.tick === 2, 'admin advance moves to tick 2');
  assert(advance.json.data.source === 'manual', 'admin advance is marked manual');
  assert(advance.json.data.market_clock.daily_tick_index === 1, 'manual advance increments daily tick index');
    assert(advance.json.data.news_count >= 0 && advance.json.data.news_count <= 8, 'news count stays within 0-8 per tick');
  assertNewsEngineRules(advance.json.data.tick);
  const sqliteAfterAdvance = new DatabaseSync(DB_PATH);
  try {
    const dynamicCount = sqliteAfterAdvance.prepare('SELECT COUNT(*) AS count FROM stock_dynamics;').get();
    const anchorCount = sqliteAfterAdvance.prepare('SELECT COUNT(*) AS count FROM stock_prices WHERE tick = 2 AND anchor IS NOT NULL;').get();
    assert(Number(dynamicCount.count) === 37, 'persistent dynamics survive tick advancement for every stock');
    assert(Number(anchorCount.count) === 37, 'dynamic anchors are persisted for every stock');
  } finally {
    sqliteAfterAdvance.close();
  }

  const afterAdvance = await call('GET', '/api/state?selectedCode=SSB001', null, playerToken);
  const released = afterAdvance.json.data.holdings.find((h) => h.stock_code === 'SSB001');
  assert(released && released.available_quantity === 100, 'T+1 released after advance');
  assert(afterAdvance.json.data.selected_trade_activity.stock_code === 'SSB001', 'state carries selected stock trade activity');
  assert(afterAdvance.json.data.selected_trade_activity.window_size === 5, 'selected stock trade activity uses a 5-tick window');
  assert(afterAdvance.json.data.selected_trade_activity.total_lots === 1, 'selected stock trade activity counts recent completed lots');
  assert(afterAdvance.json.data.selected_trade_activity.total_amount === 5200, 'selected stock trade activity sums recent completed turnover');
  const settledFunds = await call('GET', '/api/funds/status', null, playerToken);
  const settledIndexFund = settledFunds.json.data.find((holding) => holding.fund_code === indexFund.code);
  assert(settledIndexFund && settledIndexFund.available_shares === settledIndexFund.shares, 'ordinary fund shares settle after advance');
  const currentFunds = await call('GET', '/api/funds/list', null, playerToken);
  const currentIndexFund = currentFunds.json.data.find((fund) => fund.code === indexFund.code);
  assert(currentFunds.json.data.every((fund) => fund.has_performance), 'fund list exposes inception performance after an advance');
  assert(new Set(currentFunds.json.data.map((fund) => fund.nav)).size >= 4, 'fund NAVs diverge after the first advance');
  const fundSell = await call('POST', '/api/funds/sell', {
    fundCode: indexFund.code,
    shares: settledIndexFund.shares,
    expectedTick: 2,
    expectedNav: currentIndexFund.nav
  }, playerToken);
  assert(fundSell.json.code === 0 && fundSell.json.data.user.fund_value === 0, 'settled ordinary fund can be fully redeemed');

  let sell = await quoteTradeAt(BASE, playerToken, 'sell', 'SSB001', 1);
  for (let i = 0; sell.json.code !== 0 && i < 5; i += 1) {
    const retryAdvance = await call('POST', '/api/admin/advance', null, adminToken);
    assert(retryAdvance.json.code === 0, 'admin can keep advancing while waiting for sellable price');
    sell = await quoteTradeAt(BASE, playerToken, 'sell', 'SSB001', 1);
  }
  assert(sell.json.code === 0, 'sell succeeds after advance');
  assert(!sell.json.data.holdings.find((h) => h.stock_code === 'SSB001'), 'holding cleared after full sell');

  const resetMarket = await call('POST', '/api/admin/reset-market', null, adminToken);
  assert(resetMarket.json.code === 0 && resetMarket.json.data.tick === 1, 'market reset returns to tick 1');

  const afterReset = await call('GET', '/api/state?selectedCode=SSB001', null, playerToken);
  assert(afterReset.json.code === 0, 'player token remains valid after market reset');
  assert(afterReset.json.data.current_tick === 1, 'state tick reset to 1');
  assert(afterReset.json.data.sleeping === false, 'market reset clears the sleeping state');
  assert(afterReset.json.data.user.cash === 1000000, 'cash reset to initial');
  assert(afterReset.json.data.holdings.length === 0, 'holdings reset');
  const fundsAfterReset = await call('GET', '/api/funds/status', null, playerToken);
  assert(fundsAfterReset.json.code === 0 && fundsAfterReset.json.data.length === 0, 'fund holdings reset with the market');

  const loginAfterMarketReset = await loginAs('SSBTY', 'secret123');
  assert(loginAfterMarketReset.code === 0, 'market reset preserves player password');

  const resetPasswords = await call('POST', '/api/admin/reset-passwords', null, adminToken);
  assert(resetPasswords.json.code === 0, 'admin resets all normal player passwords');
  assert(resetPasswords.json.data.reset_count >= 1, 'at least one player password was reset');

  const stalePlayerState = await call('GET', '/api/state?selectedCode=SSB001', null, playerToken);
  assert(stalePlayerState.json.code !== 0, 'password reset invalidates player session');

  const loginAfterPasswordReset = await loginAs('SSBTY', 'secret123');
  assert(loginAfterPasswordReset.code !== 0, 'password reset prevents login');

  const adminAfterReset = await loginAs('SSB-DEMO');
  assert(adminAfterReset.code === 0 && adminAfterReset.data.user.is_admin, 'admin still logs in without password');

  await assertClosedMarketRejectsTrading();

  console.log('w3 account/admin smoke flow ok');
}

main()
  .then(() => { cleanup(); process.exit(0); })
  .catch((error) => { console.error(error); cleanup(); process.exit(1); });

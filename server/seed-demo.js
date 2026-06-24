// Seed script: 10 players, 45 ticks, stocks + funds + loans, rich trading history
// Produces data/ssb-demo.sqlite
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 4200 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER = path.join(__dirname, 'server.js');
const DB_PATH = path.join(os.tmpdir(), `ssb_demo_${process.pid}_${Date.now()}.sqlite`);
const OUTPUT_DB = path.join(__dirname, '..', 'data', 'ssb-demo.sqlite');
const DATA_DIR = path.join(__dirname, '..', 'data');
const PROJECT_ROOT = path.join(__dirname, '..');

const PLAYERS = [
  { nickname: '演示玩家01', username: 'demo01' },
  { nickname: '演示玩家02', username: 'demo02' },
  { nickname: '演示玩家03', username: 'demo03' },
  { nickname: '演示玩家04', username: 'demo04' },
  { nickname: '演示玩家05', username: 'demo05' },
  { nickname: '演示玩家06', username: 'demo06' },
  { nickname: '演示玩家07', username: 'demo07' },
  { nickname: '演示玩家08', username: 'demo08' },
  { nickname: '演示玩家09', username: 'demo09' },
  { nickname: '演示玩家10', username: 'demo10' },
];

const PASSWORD = '123456';
const TOTAL_TICKS = 45;
const INITIAL_CASH = 1000000;
const SINGLE_STOCK_CAP = 0.4;
const FEE_RATE = 0.001;
const FUND_FEE_RATE = 0.001;

let child;

function assertSafeEnvironment() {
  const root = path.resolve(PROJECT_ROOT);
  const deploymentLikePrefixes = ['/opt/', '/srv/', '/var/www/', '/www/', '/home/www/'];
  const looksLikeDeployedHost = deploymentLikePrefixes.some((prefix) => root.startsWith(prefix));
  const nodeEnv = String(process.env.NODE_ENV || '').toLowerCase();
  if (nodeEnv === 'production' || looksLikeDeployedHost) {
    throw new Error('seed-demo 仅允许在本地开发/测试环境使用');
  }
}

function cleanup() {
  if (child && !child.killed) child.kill();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${DB_PATH}${suffix}`;
    if (fs.existsSync(file)) {
      try { fs.rmSync(file); } catch { /* ignore */ }
    }
  }
}

async function call(method, route, body, token) {
  const init = { method, headers: {} };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (body) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${route}`, init);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { code: -1, message: text }; }
  return { res, json };
}

async function waitForReady(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { json } = await call('POST', '/api/auth/login', { username: 'SSB-DEMO' });
      if (json.code === 0) return json.data.token;
    } catch { /* server not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Server did not become ready');
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pick(arr, min, max) {
  const n = min + Math.floor(Math.random() * (max - min + 1));
  return shuffle(arr).slice(0, n);
}

async function buyStock(token, stockCode, maxCash, expectedTick) {
  const state = await call('GET', `/api/state?selectedCode=${stockCode}`, null, token);
  if (state.json.code !== 0) return { success: false };
  const quote = state.json.data.prices.find((p) => p.stock_code === stockCode);
  if (!quote || quote.close <= 0) return { success: false };
  const price = quote.close;
  const maxLotsByBudget = Math.floor(maxCash / (price * 100 * (1 + FEE_RATE)));
  const lots = Math.min(maxLotsByBudget, Math.floor(INITIAL_CASH * SINGLE_STOCK_CAP / (price * 100)));
  if (lots <= 0) return { success: false };
  const t = expectedTick || state.json.data.current_tick;
  const trade = await call('POST', '/api/trade', { action: 'buy', stockCode, lots, expectedTick: t, expectedPrice: price }, token);
  if (trade.json.code !== 0) return { success: false };
  return { success: true, lots, price, spent: Math.round(price * lots * 100 * (1 + FEE_RATE) * 100) / 100 };
}

async function sellStock(token, stockCode, lots, expectedTick) {
  const state = await call('GET', `/api/state?selectedCode=${stockCode}`, null, token);
  if (state.json.code !== 0) return { success: false };
  const quote = state.json.data.prices.find((p) => p.stock_code === stockCode);
  if (!quote || quote.close <= 0) return { success: false };
  const t = expectedTick || state.json.data.current_tick;
  const trade = await call('POST', '/api/trade', { action: 'sell', stockCode, lots, expectedTick: t, expectedPrice: quote.close }, token);
  return trade.json.code === 0;
}

async function getCurrentTick(token) {
  const state = await call('GET', '/api/state?selectedCode=SSB001', null, token);
  if (state.json.code !== 0) return 0;
  return state.json.data.current_tick || 0;
}

async function buyFund(token, fundCode, amount, expectedTick) {
  const tick = expectedTick || await getCurrentTick(token);
  if (!tick) return { success: false };
  const list = await call('GET', '/api/funds/list', null, token);
  if (list.json.code !== 0) return { success: false };
  const fund = (list.json.data || []).find((f) => f.code === fundCode);
  if (!fund) return { success: false };
  const trade = await call('POST', '/api/funds/buy', { action: 'buy', fundCode, amount, expectedTick: tick, expectedNav: fund.nav }, token);
  return { success: trade.json.code === 0 };
}

async function sellFund(token, fundCode, shares, expectedTick) {
  const tick = expectedTick || await getCurrentTick(token);
  if (!tick) return { success: false };
  const list = await call('GET', '/api/funds/list', null, token);
  if (list.json.code !== 0) return { success: false };
  const fund = (list.json.data || []).find((f) => f.code === fundCode);
  if (!fund) return { success: false };
  const trade = await call('POST', '/api/funds/sell', { action: 'sell', fundCode, shares, expectedTick: tick, expectedNav: fund.nav }, token);
  return { success: trade.json.code === 0 };
}

async function takeLoan(token, amount, termTicks) {
  const status = await call('GET', '/api/loan/status', null, token);
  if (status.json.code !== 0) return false;
  const max = Number(status.json.data.max_loan_amount || 0);
  const available = status.json.data.available_terms || [16];
  const maxTerm = Math.max(...available);
  const actual = Math.min(amount, max);
  const term = Math.min(termTicks || available[0], maxTerm);
  if (actual <= 0) return false;
  const resp = await call('POST', '/api/loan/borrow', { amount: actual, term_ticks: term }, token);
  return resp.json.code === 0;
}

async function repayLoan(token, amount) {
  const resp = await call('POST', '/api/loan/repay', { amount }, token);
  return resp.json.code === 0;
}

async function advanceTick(adminToken) {
  const advance = await call('POST', '/api/admin/advance', null, adminToken);
  if (advance.json.code !== 0) return null;
  return advance.json.data;
}

async function main() {
  assertSafeEnvironment();
  console.log('=== SSB Exchange Demo Seed Script ===\n');

  // --- Start server ---
  console.log(`Starting server on port ${PORT} with temp database...`);
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: {
      ...process.env,
      PORT: String(PORT),
      SSB_DB_PATH: DB_PATH,
      SSB_DISABLE_CLOCK: '1',
      SSB_FORCE_MARKET_OPEN: '1'
    },
    stdio: ['ignore', 'ignore', 'inherit']
  });

  const adminToken = await waitForReady();
  console.log('Server ready.\n');

  // --- Get stock & fund lists ---
  const state = await call('GET', '/api/state?selectedCode=SSB001', null, adminToken);
  const stocks = state.json.data.stocks.map((s) => s.code);
  const fundListResp = await call('GET', '/api/funds/list', null, adminToken);
  const fundCodes = (fundListResp.json.data || []).map((f) => f.code);
  console.log(`Stocks: ${stocks.length} | Funds: ${fundCodes.length} | Initial tick: ${state.json.data.current_tick}\n`);

  // --- Generate invite codes ---
  console.log('=== Generating invite codes ===');
  const inviteResp = await call('POST', '/api/admin/invites/generate', { count: PLAYERS.length }, adminToken);
  if (inviteResp.json.code !== 0) {
    console.log('Failed to generate invites:', inviteResp.json.message);
    throw new Error('invite generation failed');
  }
  const codes = inviteResp.json.data.codes || [];
  for (let i = 0; i < PLAYERS.length; i++) {
    // Set nicknames on invite codes
    await call('POST', '/api/admin/invites/update', { code: codes[i], nickname: PLAYERS[i].nickname }, adminToken);
  }
  console.log(`Generated ${codes.length} invite codes.\n`);

  // --- Activate players & build initial portfolios ---
  console.log('=== Registering players & building portfolios ===\n');
  const playerTokens = [];

  for (let i = 0; i < PLAYERS.length; i++) {
    const account = PLAYERS[i];
    const inviteCode = codes[i];
    const label = `[${String(i + 1).padStart(2, '0')}/${PLAYERS.length}] ${inviteCode} ${account.nickname}`;
    process.stdout.write(`${label}`);

    // Register
    const registerResp = await call('POST', '/api/auth/register', {
      inviteCode,
      username: account.username,
      password: PASSWORD
    });
    if (registerResp.json.code !== 0) {
      console.log(` REGISTER FAILED: ${registerResp.json.message}`);
      continue;
    }

    // Login
    const loginResp = await call('POST', '/api/auth/login', {
      username: account.username,
      password: PASSWORD
    });
    if (loginResp.json.code !== 0) {
      console.log(` LOGIN FAILED: ${loginResp.json.message}`);
      continue;
    }
    const token = loginResp.json.data.token;
    playerTokens.push({ ...account, inviteCode, token });

    // Buy stocks
    const stockCount = 3 + Math.floor(Math.random() * 5); // 3-7
    const targets = pick(stocks, stockCount, stockCount);
    let cash = INITIAL_CASH;
    let boughtStocks = 0;

    for (let j = 0; j < targets.length; j++) {
      const budget = Math.min(cash, Math.ceil(cash / (targets.length - j) * 1.3));
      const result = await buyStock(token, targets[j], budget);
      if (result.success) {
        boughtStocks++;
        cash -= result.spent;
      }
    }

    // Buy funds (1-3 funds)
    const fundCount = 1 + Math.floor(Math.random() * 3);
    const fundTargets = pick(fundCodes, fundCount, fundCount);
    let boughtFunds = 0;
    for (const fc of fundTargets) {
      const budget = Math.min(cash, Math.ceil(cash / (fundTargets.length - fundTargets.indexOf(fc)) * 0.6));
      const fb = Math.floor(budget);
      if (fb < 100) continue;
      const ok = await buyFund(token, fc, Math.min(fb, 50000));
      if (ok) { boughtFunds++; cash -= Math.min(fb, 50000); }
    }

    // Take loans for players 2, 4, 7, 9 (0-indexed: 1, 3, 6, 8)
    let hasLoan = false;
    if ([1, 3, 6, 8].includes(i)) {
      const loanAmt = 30000 + Math.floor(Math.random() * 120000);
      const loanTerm = 9 + Math.floor(Math.random() * 18); // 9-27 ticks
      hasLoan = await takeLoan(token, loanAmt, loanTerm);
    }

    console.log(` => ${boughtStocks} stocks + ${boughtFunds} funds${hasLoan ? ' + loan' : ''}`);
  }

  // --- Advance ticks with mid-stream trading ---
  console.log(`\n=== Advancing ${TOTAL_TICKS} ticks with mid-stream trading ===\n`);

  // Plan trading events at specific ticks
  const tradePlan = [
    // tick 6: Player 0 sells a random stock
    { tick: 6, action: 'sellStock', playerIdx: 0 },
    // tick 8: Player 2 buys more of a random stock
    { tick: 8, action: 'buyStock', playerIdx: 2 },
    // tick 10: Players 1, 5 buy funds
    { tick: 10, action: 'buyFund', playerIdx: 1 },
    { tick: 10, action: 'buyFund', playerIdx: 5 },
    // tick 12 (same day as 10): Player 1 sells the fund they bought at tick 10
    { tick: 12, action: 'sellFundSameDay', playerIdx: 1 },
    // tick 15: Player 3 repays part of loan
    { tick: 15, action: 'repayLoan', playerIdx: 3 },
    // tick 16 (same day as 15): Player 7 buys stock and sells same stock same day
    { tick: 16, action: 'buyStock', playerIdx: 4 },
    { tick: 17, action: 'sellStockSameDay', playerIdx: 4 },
    // tick 20: Players 0, 6, 8 buy funds
    { tick: 20, action: 'buyFund', playerIdx: 0 },
    { tick: 20, action: 'buyFund', playerIdx: 6 },
    { tick: 20, action: 'buyFund', playerIdx: 8 },
    // tick 22: Player 0 sells stock
    { tick: 22, action: 'sellStock', playerIdx: 0 },
    // tick 24 (same day as 22): Player 0 sells the fund bought at tick 20
    { tick: 24, action: 'sellFundSameDay', playerIdx: 0 },
    // tick 28: Player 5 buys stock, Player 2 buys fund
    { tick: 28, action: 'buyStock', playerIdx: 5 },
    { tick: 28, action: 'buyFund', playerIdx: 2 },
    // tick 30: Player 9 takes a second loan
    { tick: 30, action: 'takeLoan', playerIdx: 8 },
    // tick 32: Player 7 buys stock
    { tick: 32, action: 'buyStock', playerIdx: 6 },
    // tick 33 (same day as 32): Player 7 sells the same stock
    { tick: 33, action: 'sellStockSameDay', playerIdx: 6 },
    // tick 35: Players 3, 4, 9 buy funds
    { tick: 35, action: 'buyFund', playerIdx: 3 },
    { tick: 35, action: 'buyFund', playerIdx: 4 },
    { tick: 35, action: 'buyFund', playerIdx: 8 },
    // tick 38: Player 1 sells stock
    { tick: 38, action: 'sellStock', playerIdx: 1 },
    // tick 39: Player 6 buys stock
    { tick: 39, action: 'buyStock', playerIdx: 5 },
    // tick 40: Player 1 buys new stock (rebalance)
    { tick: 40, action: 'buyStock', playerIdx: 1 },
    // tick 41 (same day as 39-40): Players 2, 8 sell funds
    { tick: 41, action: 'sellFundSameDay', playerIdx: 2 },
    { tick: 41, action: 'sellFundSameDay', playerIdx: 8 },
    // tick 43: Player 3 fully repays loan
    { tick: 43, action: 'repayLoan', playerIdx: 3 },
  ];

  let tradePlanIdx = 0;
  let currentStockHoldings = {}; // playerIdx -> { stockCode: lots }
  let currentFundHoldings = {}; // playerIdx -> { fundCode: shares }
  let dayBuyCache = {}; // playerIdx -> [{type:'stock',code,details},{type:'fund',code,amount}]

  // Helper to get a random held stock for a player
  function getPlayerState(token) {
    return call('GET', '/api/state?selectedCode=SSB001', null, token);
  }
  function getPlayerFundStatus(token) {
    return call('GET', '/api/funds/status', null, token);
  }

  for (let tick = 1; tick <= TOTAL_TICKS; tick++) {
    // Before advancing, do pending trades for this tick
    const plannedActions = tradePlan.filter((p, idx) => p.tick === tick && idx === tradePlan.findIndex((x, xi) => xi === idx && x.tick === tick));

    for (const action of plannedActions) {
      const player = playerTokens[action.playerIdx];
      if (!player) continue;

      const token = player.token;
      process.stdout.write(`  [tick ${tick}] ${player.nickname} `);

      if (action.action === 'buyStock') {
        const s = await getPlayerState(token);
        if (s.json.code !== 0) { process.stdout.write('(state fail)\n'); continue; }
        const stockList = s.json.data.stocks.map((st) => st.code);
        const pickStock = stockList[Math.floor(Math.random() * stockList.length)];
        const quote = s.json.data.prices.find((p) => p.stock_code === pickStock);
        if (!quote) { process.stdout.write('(no quote)\n'); continue; }
        const maxLots = Math.floor(Math.min(300000, INITIAL_CASH * SINGLE_STOCK_CAP) / (quote.close * 100));
        if (maxLots <= 0) { process.stdout.write('(cap)\n'); continue; }
        const lots = 1 + Math.floor(Math.random() * Math.min(maxLots, 8));
        const ok = await buyStock(token, pickStock, quote.close * lots * 100 * 1.1, s.json.data.current_tick);
        if (ok.success) {
          process.stdout.write(`买 ${pickStock} x${lots}\n`);
          if (!dayBuyCache[action.playerIdx]) dayBuyCache[action.playerIdx] = [];
        } else {
          process.stdout.write('(buy fail)\n');
        }
      } else if (action.action === 'sellStock') {
        const s = await getPlayerState(token);
        if (s.json.code !== 0) { process.stdout.write('(state fail)\n'); continue; }
        const holdings = s.json.data.holdings || [];
        if (!holdings.length) { process.stdout.write('(no holdings)\n'); continue; }
        const h = holdings[Math.floor(Math.random() * holdings.length)];
        const lots = Math.min(h.available_quantity / 100, 1 + Math.floor(Math.random() * Math.min(h.available_quantity / 100, 3)));
        if (lots <= 0) { process.stdout.write('(no available)\n'); continue; }
        const ok = await sellStock(token, h.stock_code, Math.floor(lots), s.json.data.current_tick);
        process.stdout.write(`${ok ? '卖' : '(sell fail)'} ${h.stock_code} x${Math.floor(lots)}\n`);
      } else if (action.action === 'buyFund') {
        const fl = await call('GET', '/api/funds/list', null, token);
        if (fl.json.code !== 0) { process.stdout.write('(fund list fail)\n'); continue; }
        const funds = fl.json.data || [];
        if (!funds.length) continue;
        const f = funds[Math.floor(Math.random() * funds.length)];
        const amount = 2000 + Math.floor(Math.random() * 80000);
        const ok = await buyFund(token, f.code, amount);
        if (ok) {
          process.stdout.write(`买 ${f.code} ¥${amount}\n`);
          if (!dayBuyCache[action.playerIdx]) dayBuyCache[action.playerIdx] = [];
          dayBuyCache[action.playerIdx].push({ type: 'fund', code: f.code, amount });
        } else {
          process.stdout.write('(fund buy fail)\n');
        }
      } else if (action.action === 'sellFundSameDay') {
        // Find a fund bought earlier in the same day batch
        const cache = dayBuyCache[action.playerIdx] || [];
        const fundCache = cache.filter((c) => c.type === 'fund');
        if (!fundCache.length) {
          // Fallback: sell any held fund
          const fs2 = await getPlayerFundStatus(token);
          if (fs2.json.code !== 0) { process.stdout.write('(fund status fail)\n'); continue; }
          const holdings = fs2.json.data || [];
          if (!holdings.length) { process.stdout.write('(no fund holdings)\n'); continue; }
          const h = holdings.find((hh) => hh.available_shares > 0);
          if (!h) { process.stdout.write('(no available fund)\n'); continue; }
          const shares = Math.min(h.available_shares, Number((Number(h.available_shares) * (0.3 + Math.random() * 0.5)).toFixed(6)));
          if (shares <= 0) { process.stdout.write('(shares zero)\n'); continue; }
          const ok = await sellFund(token, h.fund_code, shares);
          process.stdout.write(`${ok ? '同日卖' : '(sell fail)'} ${h.fund_code} ${shares.toFixed(4)}份\n`);
        } else {
          const fc = fundCache[0];
          const fs2 = await getPlayerFundStatus(token);
          if (fs2.json.code !== 0) { process.stdout.write('(fund status fail)\n'); continue; }
          const holdings = fs2.json.data || [];
          const h = holdings.find((hh) => hh.fund_code === fc.code);
          if (!h || h.available_shares <= 0) { process.stdout.write('(not settled yet)\n'); continue; }
          const shares = Math.min(h.available_shares, Number((Number(h.available_shares) * 0.6).toFixed(6)));
          if (shares <= 0) { process.stdout.write('(shares zero)\n'); continue; }
          const ok = await sellFund(token, fc.code, shares);
          process.stdout.write(`${ok ? '同日卖' : '(sell fail)'} ${fc.code} ${shares.toFixed(4)}份\n`);
          // Clear for next day
          dayBuyCache[action.playerIdx] = [];
        }
      } else if (action.action === 'sellStockSameDay') {
        const s = await getPlayerState(token);
        if (s.json.code !== 0) { process.stdout.write('(state fail)\n'); continue; }
        const holdings = s.json.data.holdings || [];
        if (!holdings.length) { process.stdout.write('(no holdings)\n'); continue; }
        const h = holdings[holdings.length - 1]; // pick the most recently bought
        const lots = Math.min(h.available_quantity / 100, 1);
        if (lots <= 0) { process.stdout.write('(no available)\n'); continue; }
        const ok = await sellStock(token, h.stock_code, Math.floor(lots), s.json.data.current_tick);
        process.stdout.write(`${ok ? '同日卖' : '(sell fail T+1)'} ${h.stock_code} x${Math.floor(lots)}\n`);
      } else if (action.action === 'takeLoan') {
        const ls = await call('GET', '/api/loan/status', null, token);
        if (ls.json.code !== 0) { process.stdout.write('(loan status fail)\n'); continue; }
        if (ls.json.data.active_loan) { process.stdout.write('(already has loan)\n'); continue; }
        const maxAmt = Math.min(ls.json.data.max_loan_amount || 50000, 150000);
        const available = ls.json.data.available_terms || [16];
        const maxTerm = Math.max(...available);
        const amt = 30000 + Math.floor(Math.random() * (maxAmt - 30000));
        const term = Math.min(maxTerm, 9 + Math.floor(Math.random() * 18));
        const ok = await takeLoan(token, amt, term);
        process.stdout.write(`${ok ? '贷款' : '(loan fail)'} ¥${amt}/${term}t\n`);
      } else if (action.action === 'repayLoan') {
        const ls = await call('GET', '/api/loan/status', null, token);
        if (ls.json.code !== 0) { process.stdout.write('(loan status fail)\n'); continue; }
        if (!ls.json.data.active_loan) { process.stdout.write('(no active loan)\n'); continue; }
        const repayAmt = Math.min(ls.json.data.active_loan.principal || 0, 20000 + Math.floor(Math.random() * 50000));
        if (repayAmt <= 0) { process.stdout.write('(repay zero)\n'); continue; }
        const ok = await repayLoan(token, repayAmt);
        process.stdout.write(`${ok ? '还款' : '(repay fail)'} ¥${repayAmt}\n`);
      }
    }

    // Advance tick
    const data = await advanceTick(adminToken);
    if (!data) {
      console.log(`  Tick advance failed at step ${tick}`);
      break;
    }

    const day = data.market_clock ? `${data.market_clock.daily_tick_index + 1}/${data.market_clock.daily_tick_total}` : '?';
    if (tick % 8 === 0 || tick === 1 || tick === TOTAL_TICKS) {
      process.stdout.write(`  tick ${String(tick).padStart(3, ' ')} | day ${day} | news ${data.news_count || 0}\n`);
    }

    // Add a small delay every few ticks
    if (tick % 5 === 0) await new Promise((r) => setTimeout(r, 200));
  }

  // --- Stop server ---
  console.log('\nStopping server...');
  if (child && !child.killed) child.kill();
  await new Promise((r) => setTimeout(r, 800));

  // --- Checkpoint WAL ---
  const { DatabaseSync } = require('node:sqlite');
  const ckptDb = new DatabaseSync(DB_PATH);
  ckptDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  ckptDb.close();

  // --- Copy DB ---
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.copyFileSync(DB_PATH, OUTPUT_DB);
  console.log(`Database saved: ${OUTPUT_DB}`);

  // Cleanup temp files
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${DB_PATH}${suffix}`;
    if (fs.existsSync(file)) {
      try { fs.rmSync(file); } catch { /* ignore */ }
    }
  }

  // Cleanup stale WAL files in data dir
  for (const suffix of ['-wal', '-shm']) {
    for (const basename of ['ssb.sqlite', 'ssb-demo.sqlite']) {
      const stale = path.join(DATA_DIR, `${basename}${suffix}`);
      if (fs.existsSync(stale)) {
        try { fs.rmSync(stale); } catch { /* ignore */ }
      }
    }
  }

  // --- Summary ---
  console.log('\n=== Done ===');
  console.log('LOCAL DEV ONLY: do not upload this database to production.');
  console.log('To use the demo database:');
  console.log('  mv data/ssb.sqlite data/ssb-backup.sqlite');
  console.log('  mv data/ssb-demo.sqlite data/ssb.sqlite');
  console.log('');
  console.log('IMPORTANT: Delete stale WAL/SHM files before swapping:');
  console.log('  rm -f data/ssb.sqlite-wal data/ssb.sqlite-shm');
  console.log(`\nAll player passwords: ${PASSWORD}`);
  console.log('Admin (SSB-DEMO): no password');
  console.log('\nPlayer accounts:');
  for (const p of playerTokens) {
    console.log(`  ${p.inviteCode} — ${p.nickname} (${p.username})`);
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('Seed failed:', err.message || err); cleanup(); process.exit(1); });

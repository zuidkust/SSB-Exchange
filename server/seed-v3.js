// Seed script v3: 10 players, 90 ticks, stocks + funds (30-50% fund allocation),
// rich multi-round trading history for both stocks and funds, loans
// Produces data/ssb-v3.sqlite
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 4200 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER = path.join(__dirname, 'server.js');
const DB_PATH = path.join(os.tmpdir(), `ssb_v3_${process.pid}_${Date.now()}.sqlite`);
const OUTPUT_DB = path.join(__dirname, '..', 'data', 'ssb-v3.sqlite');
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
const TOTAL_TICKS = 90;
const INITIAL_CASH = 1000000;
const SINGLE_STOCK_CAP = 0.4;
const FEE_RATE = 0.001;

let child;

function assertSafeEnvironment() {
  const root = path.resolve(PROJECT_ROOT);
  const deploymentLikePrefixes = ['/opt/', '/srv/', '/var/www/', '/www/', '/home/www/'];
  const looksLikeDeployedHost = deploymentLikePrefixes.some((prefix) => root.startsWith(prefix));
  const nodeEnv = String(process.env.NODE_ENV || '').toLowerCase();
  if (nodeEnv === 'production' || looksLikeDeployedHost) {
    throw new Error('seed-v3 仅允许在本地开发/测试环境使用');
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

// ─── Stock helpers ───────────────────────────────────────────────────────────

async function getCurrentTick(token) {
  const state = await call('GET', '/api/state?selectedCode=SSB001', null, token);
  if (state.json.code !== 0) return 0;
  return state.json.data.current_tick || 0;
}

async function buyStock(token, stockCode, maxCash, expectedTick) {
  const state = await call('GET', `/api/state?selectedCode=${stockCode}`, null, token);
  if (state.json.code !== 0) return { success: false };
  const quote = state.json.data.prices.find((p) => p.stock_code === stockCode);
  if (!quote || quote.close <= 0) return { success: false };
  const price = quote.close;
  const maxLotsByBudget = Math.floor(maxCash / (price * 100 * (1 + FEE_RATE)));
  const maxLotsByCap = Math.floor(INITIAL_CASH * SINGLE_STOCK_CAP / (price * 100));
  const lots = Math.min(maxLotsByBudget, maxLotsByCap);
  if (lots <= 0) return { success: false };
  const t = expectedTick || state.json.data.current_tick;
  const trade = await call('POST', '/api/trade', {
    action: 'buy', stockCode, lots,
    expectedTick: t, expectedPrice: price
  }, token);
  if (trade.json.code !== 0) return { success: false };
  return { success: true, lots, price, spent: Math.round(price * lots * 100 * (1 + FEE_RATE) * 100) / 100 };
}

async function sellStock(token, stockCode, lots, expectedTick) {
  const state = await call('GET', `/api/state?selectedCode=${stockCode}`, null, token);
  if (state.json.code !== 0) return { success: false };
  const quote = state.json.data.prices.find((p) => p.stock_code === stockCode);
  if (!quote || quote.close <= 0) return { success: false };
  const t = expectedTick || state.json.data.current_tick;
  const trade = await call('POST', '/api/trade', {
    action: 'sell', stockCode, lots,
    expectedTick: t, expectedPrice: quote.close
  }, token);
  return trade.json.code === 0;
}

// ─── Fund helpers ────────────────────────────────────────────────────────────

async function buyFund(token, fundCode, amount, expectedTick) {
  const tick = expectedTick || await getCurrentTick(token);
  if (!tick) return { success: false };
  const list = await call('GET', '/api/funds/list', null, token);
  if (list.json.code !== 0) return { success: false };
  const fund = (list.json.data || []).find((f) => f.code === fundCode);
  if (!fund) return { success: false };
  const trade = await call('POST', '/api/funds/buy', {
    action: 'buy', fundCode, amount,
    expectedTick: tick, expectedNav: fund.nav
  }, token);
  return { success: trade.json.code === 0, amount };
}

async function sellFund(token, fundCode, shares, expectedTick) {
  const tick = expectedTick || await getCurrentTick(token);
  if (!tick) return { success: false };
  const list = await call('GET', '/api/funds/list', null, token);
  if (list.json.code !== 0) return { success: false };
  const fund = (list.json.data || []).find((f) => f.code === fundCode);
  if (!fund) return { success: false };
  const trade = await call('POST', '/api/funds/sell', {
    action: 'sell', fundCode, shares,
    expectedTick: tick, expectedNav: fund.nav
  }, token);
  return { success: trade.json.code === 0 };
}

async function getFundHoldings(token) {
  const fs2 = await call('GET', '/api/funds/status', null, token);
  if (fs2.json.code !== 0) return [];
  return fs2.json.data || [];
}

// ─── Loan helpers ────────────────────────────────────────────────────────────

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

// ─── Main ────────────────────────────────────────────────────────────────────

async function advanceTick(adminToken) {
  const advance = await call('POST', '/api/admin/advance', null, adminToken);
  if (advance.json.code !== 0) return null;
  return advance.json.data;
}

async function main() {
  assertSafeEnvironment();
  console.log('=== SSB Exchange Seed v3 ===');
  console.log(`Players: ${PLAYERS.length} | Ticks: ${TOTAL_TICKS} | Fund allocation: 30-50%\n`);

  // ── Start server ──
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

  // ── Get stock & fund lists ──
  const state = await call('GET', '/api/state?selectedCode=SSB001', null, adminToken);
  const stockCodes = state.json.data.stocks.map((s) => s.code);
  const fundListResp = await call('GET', '/api/funds/list', null, adminToken);
  const fundCodes = (fundListResp.json.data || []).map((f) => f.code);
  console.log(`Stocks: ${stockCodes.length} | Funds: ${fundCodes.length} | Initial tick: ${state.json.data.current_tick}\n`);

  // ── Generate invite codes ──
  console.log('=== Generating invite codes ===');
  const inviteResp = await call('POST', '/api/admin/invites/generate', { count: PLAYERS.length }, adminToken);
  if (inviteResp.json.code !== 0) {
    console.log('Failed to generate invites:', inviteResp.json.message);
    throw new Error('invite generation failed');
  }
  const codes = inviteResp.json.data.codes || [];
  for (let i = 0; i < PLAYERS.length; i++) {
    await call('POST', '/api/admin/invites/update', { code: codes[i], nickname: PLAYERS[i].nickname }, adminToken);
  }
  console.log(`Generated ${codes.length} invite codes.\n`);

  // ── Register players & build initial portfolios ──
  console.log('=== Registering players & building portfolios (fund 30-50%) ===\n');
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

    // ── Determine allocation ──
    const spendRatio = 0.89 + Math.random() * 0.10; // 89%-99% of cash
    const totalSpend = Math.floor(INITIAL_CASH * spendRatio);
    const fundRatio = 0.30 + Math.random() * 0.20;  // 30%-50%
    const fundBudget = Math.floor(totalSpend * fundRatio);
    const stockBudget = totalSpend - fundBudget;

    let cash = INITIAL_CASH;

    // ── Buy stocks ──
    const stockCount = 3 + Math.floor(Math.random() * 5); // 3-7
    const stockTargets = pick(stockCodes, stockCount, stockCount);
    let boughtStocks = 0;
    let stockRemaining = stockBudget;

    for (let j = 0; j < stockTargets.length; j++) {
      const budget = Math.min(Math.min(cash, stockRemaining), Math.ceil(stockRemaining / (stockTargets.length - j) * 1.2));
      const result = await buyStock(token, stockTargets[j], budget);
      if (result.success) {
        boughtStocks++;
        cash -= result.spent;
        stockRemaining -= result.spent;
      }
    }

    // ── Buy funds (2-4 funds, using fund budget) ──
    const fundCount = 2 + Math.floor(Math.random() * 3); // 2-4
    const fundTargets = pick(fundCodes, fundCount, fundCount);
    let boughtFunds = 0;
    let fundRemaining = fundBudget;

    for (let k = 0; k < fundTargets.length; k++) {
      const budget = Math.floor(Math.min(fundRemaining, Math.ceil(fundRemaining / (fundTargets.length - k) * 1.1)));
      if (budget < 100) continue;
      const amount = Math.max(100, Math.min(budget, 200000));
      const ok = await buyFund(token, fundTargets[k], amount);
      if (ok.success) {
        boughtFunds++;
        cash -= ok.amount;
        fundRemaining -= ok.amount;
      }
    }

    // ── Take loans for players 1, 3, 6, 9 (0-indexed) ──
    let hasLoan = false;
    if ([1, 3, 6, 9].includes(i)) {
      const loanAmt = 50000 + Math.floor(Math.random() * 100000);
      const loanTerm = 9 + Math.floor(Math.random() * 18); // 9-27 ticks
      hasLoan = await takeLoan(token, loanAmt, loanTerm);
    }

    const spent = INITIAL_CASH - cash;
    const fundPct = totalSpend > 0 ? (fundBudget / totalSpend * 100).toFixed(0) : 0;
    console.log(` => ${boughtStocks}s + ${boughtFunds}f (fund ~${fundPct}%) | spent ¥${spent}${hasLoan ? ' + loan' : ''}`);
  }

  // ── Generate trading event schedule for each player ──
  // Each player gets events every 5-10 ticks (8-15 events total over 90 ticks)
  console.log(`\n=== Planning trading events for 90 ticks ===`);

  const playerEvents = {}; // playerIdx -> [{ tick, actionType, meta }]
  for (let pi = 0; pi < PLAYERS.length; pi++) {
    const events = [];
    let nextTick = 3 + Math.floor(Math.random() * 5); // first event at tick 3-7

    while (nextTick < TOTAL_TICKS) {
      const r = Math.random();
      let actionType;
      if (r < 0.50) {
        actionType = Math.random() < 0.55 ? 'buyStock' : 'sellStock';
      } else if (r < 0.90) {
        actionType = Math.random() < 0.50 ? 'buyFund' : 'sellFund';
      } else {
        actionType = ['takeLoan', 'repayLoan'][Math.floor(Math.random() * 2)];
      }

      events.push({ tick: nextTick, actionType });
      nextTick += 5 + Math.floor(Math.random() * 6); // 5-10 ticks gap
    }
    playerEvents[pi] = events;
    console.log(`  ${PLAYERS[pi].nickname}: ${events.length} events planned`);
  }

  // Flatten all events sorted by tick
  const allEvents = [];
  for (let pi = 0; pi < PLAYERS.length; pi++) {
    for (const e of playerEvents[pi]) {
      allEvents.push({ ...e, playerIdx: pi });
    }
  }
  allEvents.sort((a, b) => a.tick - b.tick);

  // ── Advance ticks with trading events ──
  console.log(`\n=== Advancing ${TOTAL_TICKS} ticks with trading ===\n`);

  let eventIdx = 0;
  const dayBuyCache = {}; // playerIdx -> [{type:'fund',code,amount}] for same-day sell tracking

  for (let tick = 1; tick <= TOTAL_TICKS; tick++) {
    // Execute all events scheduled for this tick
    while (eventIdx < allEvents.length && allEvents[eventIdx].tick === tick) {
      const event = allEvents[eventIdx++];
      const player = playerTokens[event.playerIdx];
      if (!player) continue;
      const token = player.token;

      process.stdout.write(`  [tick ${String(tick).padStart(3, ' ')}] ${player.nickname} `);

      if (event.actionType === 'buyStock') {
        const s = await call('GET', '/api/state?selectedCode=SSB001', null, token);
        if (s.json.code !== 0) { process.stdout.write('(state fail)\n'); continue; }
        const sl = s.json.data.stocks.map((st) => st.code);
        const pickStock = sl[Math.floor(Math.random() * sl.length)];
        const quote = s.json.data.prices.find((p) => p.stock_code === pickStock);
        if (!quote) { process.stdout.write('(no quote)\n'); continue; }
        const maxLots = Math.floor(Math.min(200000, INITIAL_CASH * SINGLE_STOCK_CAP) / (quote.close * 100));
        if (maxLots <= 0) { process.stdout.write('(cap)\n'); continue; }
        const lots = 1 + Math.floor(Math.random() * Math.min(maxLots, 6));
        const maxCash = quote.close * lots * 100 * 1.1;
        const ok = await buyStock(token, pickStock, maxCash, s.json.data.current_tick);
        process.stdout.write(ok.success ? `买 ${pickStock} x${lots}\n` : '(buy fail)\n');

      } else if (event.actionType === 'sellStock') {
        const s = await call('GET', '/api/state?selectedCode=SSB001', null, token);
        if (s.json.code !== 0) { process.stdout.write('(state fail)\n'); continue; }
        const holdings = s.json.data.holdings || [];
        if (!holdings.length) { process.stdout.write('(no holdings)\n'); continue; }
        const h = holdings[Math.floor(Math.random() * holdings.length)];
        const maxLots = Math.floor(h.available_quantity / 100);
        if (maxLots <= 0) { process.stdout.write('(no available)\n'); continue; }
        const lots = Math.min(maxLots, 1 + Math.floor(Math.random() * Math.min(maxLots, 4)));
        if (lots <= 0) { process.stdout.write('(lots zero)\n'); continue; }
        const ok = await sellStock(token, h.stock_code, lots, s.json.data.current_tick);
        process.stdout.write(ok ? `卖 ${h.stock_code} x${lots}\n` : '(sell fail)\n');

      } else if (event.actionType === 'buyFund') {
        const fl = await call('GET', '/api/funds/list', null, token);
        if (fl.json.code !== 0) { process.stdout.write('(fund list fail)\n'); continue; }
        const funds = fl.json.data || [];
        if (!funds.length) continue;
        const f = funds[Math.floor(Math.random() * funds.length)];
        const amount = 5000 + Math.floor(Math.random() * 75000);
        const ok = await buyFund(token, f.code, amount);
        if (ok.success) {
          process.stdout.write(`买 ${f.code} ¥${amount}\n`);
          if (!dayBuyCache[event.playerIdx]) dayBuyCache[event.playerIdx] = [];
          dayBuyCache[event.playerIdx].push({ type: 'fund', code: f.code, amount });
        } else {
          process.stdout.write('(fund buy fail)\n');
        }

      } else if (event.actionType === 'sellFund') {
        const fh = await getFundHoldings(token);
        if (!fh.length) { process.stdout.write('(no fund holdings)\n'); continue; }
        // Pick a fund with available shares
        const available = fh.filter((h) => Number(h.available_shares) > 0);
        if (!available.length) { process.stdout.write('(no available fund)\n'); continue; }
        const h = available[Math.floor(Math.random() * available.length)];
        const sellRatio = 0.2 + Math.random() * 0.6; // 20%-80% of position
        const shares = Number((Number(h.available_shares) * sellRatio).toFixed(6));
        if (shares <= 0) { process.stdout.write('(shares zero)\n'); continue; }
        const ok = await sellFund(token, h.fund_code, shares);
        process.stdout.write(ok ? `卖 ${h.fund_code} ${shares.toFixed(4)}份\n` : '(fund sell fail)\n');

      } else if (event.actionType === 'takeLoan') {
        const ls = await call('GET', '/api/loan/status', null, token);
        if (ls.json.code !== 0) { process.stdout.write('(loan status fail)\n'); continue; }
        if (ls.json.data.active_loan) { process.stdout.write('(already has loan)\n'); continue; }
        const maxAmt = Math.min(ls.json.data.max_loan_amount || 50000, 120000);
        const available = ls.json.data.available_terms || [16];
        const maxTerm = Math.max(...available);
        const amt = 30000 + Math.floor(Math.random() * (maxAmt - 30000));
        const term = Math.min(maxTerm, 9 + Math.floor(Math.random() * 18));
        const ok = await takeLoan(token, amt, term);
        process.stdout.write(ok ? `贷款 ¥${amt}/${term}t\n` : '(loan fail)\n');

      } else if (event.actionType === 'repayLoan') {
        const ls = await call('GET', '/api/loan/status', null, token);
        if (ls.json.code !== 0) { process.stdout.write('(loan status fail)\n'); continue; }
        if (!ls.json.data.active_loan) { process.stdout.write('(no active loan)\n'); continue; }
        const repayAmt = Math.min(ls.json.data.active_loan.principal || 0, 15000 + Math.floor(Math.random() * 40000));
        if (repayAmt <= 0) { process.stdout.write('(repay zero)\n'); continue; }
        const ok = await repayLoan(token, repayAmt);
        process.stdout.write(ok ? `还款 ¥${repayAmt}\n` : '(repay fail)\n');
      }
    }

    // Advance tick
    const data = await advanceTick(adminToken);
    if (!data) {
      console.log(`  Tick advance failed at step ${tick}`);
      break;
    }

    if (tick % 8 === 0 || tick === 1 || tick === TOTAL_TICKS) {
      const day = data.market_clock ? `${data.market_clock.daily_tick_index + 1}/${data.market_clock.daily_tick_total}` : '?';
      process.stdout.write(`  tick ${String(tick).padStart(3, ' ')} | day ${day} | news ${data.news_count || 0}\n`);
    }

    // Clear same-day caches every 9 ticks (new market day) or at the end
    if (tick % 8 === 0) {
      for (const key of Object.keys(dayBuyCache)) delete dayBuyCache[key];
    }

    // Small delay every few ticks to avoid overwhelming the server
    if (tick % 5 === 0) await new Promise((r) => setTimeout(r, 150));
  }

  // ── Stop server ──
  console.log('\nStopping server...');
  if (child && !child.killed) child.kill();
  await new Promise((r) => setTimeout(r, 800));

  // ── Checkpoint WAL ──
  const { DatabaseSync } = require('node:sqlite');
  const ckptDb = new DatabaseSync(DB_PATH);
  ckptDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  ckptDb.close();

  // ── Copy DB ──
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
    for (const basename of ['ssb.sqlite', 'ssb-v3.sqlite']) {
      const stale = path.join(DATA_DIR, `${basename}${suffix}`);
      if (fs.existsSync(stale)) {
        try { fs.rmSync(stale); } catch { /* ignore */ }
      }
    }
  }

  // ── Summary ──
  console.log('\n=== Done ===');
  console.log('LOCAL DEV ONLY: do not upload this database to production.');
  console.log('To use the v3 database:');
  console.log('  rm -f data/ssb.sqlite-wal data/ssb.sqlite-shm');
  console.log('  mv data/ssb.sqlite data/ssb-backup.sqlite');
  console.log('  mv data/ssb-v3.sqlite data/ssb.sqlite');
  console.log(`\nAll player passwords: ${PASSWORD}`);
  console.log('Admin (SSB-DEMO): no password');
  console.log('\nPlayer accounts:');
  for (const p of playerTokens) {
    console.log(`  ${p.inviteCode} — ${p.nickname} (${p.username})`);
  }

  // Print event summary
  const totalEvents = allEvents.length;
  const stockEvents = allEvents.filter((e) => e.actionType === 'buyStock' || e.actionType === 'sellStock').length;
  const fundEvents = allEvents.filter((e) => e.actionType === 'buyFund' || e.actionType === 'sellFund').length;
  console.log(`\nTotal trading events: ${totalEvents} (stocks: ${stockEvents}, funds: ${fundEvents})`);
}

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('Seed failed:', err.message || err); cleanup(); process.exit(1); });

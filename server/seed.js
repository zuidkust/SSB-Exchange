// Seed script: simulates 11 players trading full portfolios over 20 ticks
// Produces data/ssb-seeded.sqlite without touching the real database
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 4100 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER = path.join(__dirname, 'server.js');
const DB_PATH = path.join(os.tmpdir(), `ssb_seed_${process.pid}_${Date.now()}.sqlite`);
const OUTPUT_DB = path.join(__dirname, '..', 'data', 'ssb-seeded.sqlite');
const DATA_DIR = path.join(__dirname, '..', 'data');
const PROJECT_ROOT = path.join(__dirname, '..');

const PLAYER_ACCOUNTS = [
  { code: 'DEMO01', nickname: '演示玩家01' },
  { code: 'DEMO02', nickname: '演示玩家02' },
  { code: 'DEMO03', nickname: '演示玩家03' },
  { code: 'DEMO04', nickname: '演示玩家04' },
  { code: 'DEMO05', nickname: '演示玩家05' },
  { code: 'DEMO06', nickname: '演示玩家06' },
  { code: 'DEMO07', nickname: '演示玩家07' },
  { code: 'DEMO08', nickname: '演示玩家08' },
  { code: 'DEMO09', nickname: '演示玩家09' },
  { code: 'DEMO10', nickname: '演示玩家10' },
  { code: 'DEMO11', nickname: '演示玩家11' },
];

const PASSWORD = '123456';
const ADVANCE_TICKS = 20;
const STOCKS_PER_PLAYER_MIN = 3;
const STOCKS_PER_PLAYER_MAX = 7;
const INITIAL_CASH = 1000000;
const SINGLE_STOCK_CAP = 0.4; // Initial tick net assets equal initial cash
const FEE_RATE = 0.001;

let child;

function assertSafeEnvironment() {
  const root = path.resolve(PROJECT_ROOT);
  const deploymentLikePrefixes = ['/opt/', '/srv/', '/var/www/', '/www/', '/home/www/'];
  const looksLikeDeployedHost = deploymentLikePrefixes.some((prefix) => root.startsWith(prefix));
  const nodeEnv = String(process.env.NODE_ENV || '').toLowerCase();

  if (nodeEnv === 'production' || looksLikeDeployedHost) {
    throw new Error(
      'seed 工具仅允许在本地开发/测试环境使用；检测到当前环境疑似生产或部署目录，已拒绝执行。'
    );
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

async function waitForReady(timeoutMs = 15000) {
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

function calcCost(price, lots) {
  const shares = lots * 100;
  const fee = Math.round(price * shares * FEE_RATE * 100) / 100;
  return Math.round((price * shares + fee) * 100) / 100;
}

async function buyStock(token, stockCode, maxCash) {
  const state = await call('GET', `/api/state?selectedCode=${stockCode}`, null, token);
  if (state.json.code !== 0) return { success: false, reason: 'state_fetch_failed' };

  const quote = state.json.data.prices.find((p) => p.stock_code === stockCode);
  if (!quote || quote.close <= 0) return { success: false, reason: 'no_quote' };

  const price = quote.close;

  // At the initial tick, the 40% net-asset cap equals INITIAL_CASH * 0.4.
  const maxValueByCap = INITIAL_CASH * SINGLE_STOCK_CAP;
  const maxLotsByCap = Math.floor(maxValueByCap / (price * 100));

  // Cap by available cash budget
  const lotCost = price * 100 * (1 + FEE_RATE);
  const maxLotsByBudget = Math.floor(maxCash / lotCost);

  const lots = Math.min(maxLotsByCap, maxLotsByBudget);
  if (lots <= 0) return { success: false, reason: maxLotsByCap <= 0 ? 'cap' : 'cash' };

  const trade = await call('POST', '/api/trade', {
    action: 'buy',
    stockCode,
    lots,
    expectedTick: state.json.data.current_tick,
    expectedPrice: price
  }, token);

  if (trade.json.code !== 0) {
    process.stdout.write(` [${stockCode}: ${trade.json.message}]`);
    return { success: false, reason: trade.json.message };
  }

  const spent = calcCost(price, lots);
  process.stdout.write(` ${stockCode}x${lots}`);
  return { success: true, spent, lots, price };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main() {
  assertSafeEnvironment();
  console.log('=== SSB Exchange Seed Script ===\n');

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

  // --- Get stock list ---
  const state = await call('GET', '/api/state?selectedCode=SSB001', null, adminToken);
  const stocks = state.json.data.stocks.map((s) => s.code);
  console.log(`Stocks: ${stocks.length} | Initial tick: ${state.json.data.current_tick}\n`);

  // --- Activate & trade for each player ---
  console.log('=== Activating players & building portfolios ===\n');

  for (let i = 0; i < PLAYER_ACCOUNTS.length; i++) {
    const account = PLAYER_ACCOUNTS[i];
    const label = `[${String(i + 1).padStart(2, '0')}/${PLAYER_ACCOUNTS.length}] ${account.code} ${account.nickname}`;
    process.stdout.write(`${label}`);

    // Activate
    const activate = await call('POST', '/api/auth/login', {
      accountCode: account.code,
      newPassword: PASSWORD
    });
    if (activate.json.code !== 0) {
      console.log(` ACTIVATE FAILED: ${activate.json.message}`);
      continue;
    }
    const token = activate.json.data.token;

    // Pick random stocks
    const numStocks = STOCKS_PER_PLAYER_MIN + Math.floor(Math.random() * (STOCKS_PER_PLAYER_MAX - STOCKS_PER_PLAYER_MIN + 1));
    const targets = shuffle(stocks).slice(0, numStocks);

    let cash = INITIAL_CASH;
    let bought = 0;

    for (let j = 0; j < targets.length; j++) {
      const stockCode = targets[j];
      const remaining = targets.length - j;
      const budget = Math.min(cash, Math.ceil(cash / remaining * 1.3));

      const result = await buyStock(token, stockCode, budget);
      if (result.success) {
        bought++;
        cash -= result.spent;
      }
    }

    const spent = INITIAL_CASH - cash;
    console.log(` => ${bought}/${numStocks} stocks | spent ¥${spent.toFixed(0)} | cash ¥${cash.toFixed(0)}`);
  }

  // --- Advance ticks ---
  console.log(`\n=== Advancing ${ADVANCE_TICKS} ticks ===`);
  for (let i = 0; i < ADVANCE_TICKS; i++) {
    const advance = await call('POST', '/api/admin/advance', null, adminToken);
    if (advance.json.code !== 0) {
      console.log(`  Tick advance failed at step ${i + 1}: ${advance.json.message}`);
      break;
    }
    const d = advance.json.data;
    process.stdout.write(`  tick ${String(d.tick).padStart(3, ' ')} | day ${d.market_clock.daily_tick_index + 1}/${d.market_clock.daily_tick_total} | news ${d.news_count}\n`);
    await new Promise((r) => setTimeout(r, 300));
  }

  // --- Stop server ---
  console.log('\nStopping server...');
  if (child && !child.killed) child.kill();
  await new Promise((r) => setTimeout(r, 800));

  // --- Checkpoint WAL into main DB ---
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

  // --- Cleanup stale WAL files in data dir ---
  // These can cause "malformed database schema" if left from a previous run
  for (const suffix of ['-wal', '-shm']) {
    for (const basename of ['ssb.sqlite', 'ssb-seeded.sqlite']) {
      const stale = path.join(DATA_DIR, `${basename}${suffix}`);
      if (fs.existsSync(stale)) {
        try { fs.rmSync(stale); } catch { /* ignore */ }
      }
    }
  }

  // --- Summary ---
  console.log('\n=== Done ===');
  console.log('LOCAL DEV ONLY: do not upload this database to production.');
  console.log('To use the seeded database:');
  console.log('  mv data/ssb.sqlite data/ssb-original.sqlite');
  console.log('  mv data/ssb-seeded.sqlite data/ssb.sqlite');
  console.log('');
  console.log('IMPORTANT: Delete stale WAL/SHM files before swapping:');
  console.log('  rm -f data/ssb.sqlite-wal data/ssb.sqlite-shm');
  console.log(`\nAll player passwords: ${PASSWORD}`);
  console.log('Admin (SSB-DEMO): no password');
}

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('Seed failed:', err.message || err); cleanup(); process.exit(1); });

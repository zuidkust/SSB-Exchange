const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 5100 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(os.tmpdir(), `ssb_error_${process.pid}_${Date.now()}.sqlite`);
const SERVER = path.join(__dirname, 'server.js');
const FEE_RATE = 0.001;

let child;

function assert(condition, label) {
  if (!condition) throw new Error(`Assertion failed: ${label}`);
}

function cleanup() {
  if (child && !child.killed) child.kill();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${DB_PATH}${suffix}`;
    if (fs.existsSync(file)) {
      try { fs.rmSync(file); } catch {}
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
  const json = await res.json();
  return { res, json };
}

async function quoteTrade(baseRoute, token, action, stockCode, lots) {
  const state = await call('GET', `/api/state?selectedCode=${stockCode}`, null, token);
  assert(state.json.code === 0, `quoted state loads before ${action}`);
  const quote = state.json.data.prices.find((item) => item.stock_code === stockCode);
  assert(quote && quote.close > 0, `quote exists before ${action}`);
  return call('POST', '/api/trade', {
    action,
    stockCode,
    lots,
    expectedTick: state.json.data.current_tick,
    expectedPrice: quote.close
  }, token);
}

async function quoteState(stockCode, token) {
  const state = await call('GET', `/api/state?selectedCode=${stockCode}`, null, token);
  assert(state.json.code === 0, `quoted state loads for ${stockCode}`);
  const quote = state.json.data.prices.find((item) => item.stock_code === stockCode);
  assert(quote && quote.close > 0, `quote exists for ${stockCode}`);
  return { state: state.json.data, quote };
}

async function waitForReady(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { json } = await call('POST', '/api/auth/login', { username: 'SSB-DEMO' });
      if (json.code === 0) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('server did not become ready in time');
}

async function main() {
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

  await waitForReady();

  const adminLogin = await call('POST', '/api/auth/login', { username: 'SSB-DEMO' });
  const adminToken = adminLogin.json.data.token;

  // Generate invite for test player
  const inviteRes = await call('POST', '/api/admin/invites/generate', { count: 2 }, adminToken);
  const inviteCode1 = inviteRes.json.data.codes[0];
  const inviteCode2 = inviteRes.json.data.codes[1];

  // Register first player
  const activatePlayer = await call('POST', '/api/auth/register', { inviteCode: inviteCode1, username: 'SSBTY', password: 'secret123' });
  const playerToken = activatePlayer.json.data.token;

  const quotedState = await call('GET', '/api/state?selectedCode=SSB001', null, playerToken);
  assert(quotedState.json.code === 0, 'player can load quoted state');
  const quotedTick = quotedState.json.data.current_tick;
  const quotedPrice = quotedState.json.data.prices.find((item) => item.stock_code === 'SSB001')?.close;
  assert(quotedPrice > 0, 'quoted price is available for stale-order test');

  const quotedAdvance = await call('POST', '/api/admin/advance', null, adminToken);
  assert(quotedAdvance.json.code === 0, 'admin can advance before stale-order test');

  const staleBuy = await call('POST', '/api/trade', {
    action: 'buy',
    stockCode: 'SSB001',
    lots: 1,
    expectedTick: quotedTick,
    expectedPrice: quotedPrice
  }, playerToken);
  assert(staleBuy.json.code !== 0, 'stale quoted buy should fail');
  assert(/行情|刷新|重新确认/.test(staleBuy.json.message || ''), 'stale quoted buy should explain that the quote changed');

  const noHoldingSell = await quoteTrade('/api/trade', playerToken, 'sell', 'SSB001', 1);
  assert(noHoldingSell.json.code !== 0, 'sell without holdings should fail');
  assert(/未持有|无持仓/.test(noHoldingSell.json.message || ''), 'sell without holdings should explain missing position');

  const buy = await quoteTrade('/api/trade', playerToken, 'buy', 'SSB001', 1);
  assert(buy.json.code === 0, 'buy should succeed before sell message checks');

  const tPlusOneSell = await quoteTrade('/api/trade', playerToken, 'sell', 'SSB001', 1);
  assert(tPlusOneSell.json.code !== 0, 'same-tick sell should fail');
  assert(/T\+1/.test(tPlusOneSell.json.message || ''), 'same-tick sell should mention T+1');

  const advance = await call('POST', '/api/admin/advance', null, adminToken);
  assert(advance.json.code === 0, 'advance should succeed');

  const oversell = await quoteTrade('/api/trade', playerToken, 'sell', 'SSB001', 2);
  assert(oversell.json.code !== 0, 'oversell should fail');
  assert(/持仓|可卖/.test(oversell.json.message || ''), 'oversell should explain available position shortage');

  const loanPlayerReg = await call('POST', '/api/auth/register', { inviteCode: inviteCode2, username: 'SSBXS', password: 'loan1234' });
  const loanPlayerToken = loanPlayerReg.json.data.token;

  const borrowLoan = await call('POST', '/api/loan/borrow', { amount: 100000 }, loanPlayerToken);
  assert(borrowLoan.json.code === 0, 'loan borrow should succeed before repay message check');

  const loanPrepStocks = ['SSB018', 'SSB014', 'SSB005', 'SSB002', 'SSB003', 'SSB015'];
  let latestCash = Infinity;
  for (const stockCode of loanPrepStocks) {
    const { state, quote } = await quoteState(stockCode, loanPlayerToken);
    const maxLotsByCap = Math.max(0, Math.floor(300000 / (quote.close * 100)) - 1);
    const maxLotsByCash = Math.max(0, Math.floor((Number(state.user.cash || 0) * 0.995) / (quote.close * 100 * (1 + FEE_RATE))));
    const lots = Math.min(maxLotsByCap, maxLotsByCash);
    const limitAdjustedLots = quote.change_pct >= 0.1 && lots >= 1 ? Math.max(1, Math.floor(lots * 0.5)) : lots;
    if (limitAdjustedLots <= 0) continue;
    const buyResult = await quoteTrade('/api/trade', loanPlayerToken, 'buy', stockCode, limitAdjustedLots);
    assert(buyResult.json.code === 0, `loan repay message setup buy ${stockCode} succeeds`);
    latestCash = Number(buyResult.json.data.user.cash || 0);
    if (latestCash < 100000) break;
  }
  assert(latestCash < 100000, 'loan repay message setup leaves less cash than the early-repay amount');

  const repayInsufficient = await call('POST', '/api/loan/repay', null, loanPlayerToken);
  assert(repayInsufficient.json.code !== 0, 'early repay with insufficient cash should fail');
  assert(/可用资金不足/.test(repayInsufficient.json.message || ''), 'early repay should still explain insufficient cash');
  assert(/卖出股票/.test(repayInsufficient.json.message || ''), 'early repay should instruct the player to sell stocks first');

  const loanStatusAfterRepayFail = await call('GET', '/api/loan/status', null, loanPlayerToken);
  assert(loanStatusAfterRepayFail.json.code === 0, 'loan status still loads after failed early repay');
  assert(loanStatusAfterRepayFail.json.data.has_active_loan === true, 'failed early repay should not clear the active loan');

  console.log('error message checks ok');
}

main()
  .then(() => { cleanup(); process.exit(0); })
  .catch((error) => { console.error(error); cleanup(); process.exit(1); });

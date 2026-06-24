// 穿仓追偿（方案 B）专项回归：deficit 超过现金时，按 现金 → 股票 → 基金 顺序追偿，
// 现金零下限、不触发破产、不连带平其他期货，并写 deficit_recovery 记录。
// 用一次性临时 SQLite，跑完自清理。退出码 0 = 全过。

process.env.SSB_CLOCK_NOW = process.env.SSB_CLOCK_NOW || '2026-06-01T09:00:00+08:00';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DB_PATH = path.join(os.tmpdir(), `ssb_fut_deficit_${process.pid}_${Date.now()}.sqlite`);
process.env.SSB_DB_PATH = DB_PATH;

const db = require('./db');
const futures = require('./futures');
const { DEFAULT_STOCKS, DEFAULT_FUNDS } = require('./data');

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

function main() {
  db.ensureDb();
  const TICK = 1;

  // 构造账户：现金 5000
  db.exec(`INSERT INTO users (id, username, nickname, cash, join_tick, initial_asset_at_join, bankrupt, created_at, updated_at)
    VALUES ('d1', 'd1', 'd1', 5000, 1, 5000, 0, datetime('now'), datetime('now'));`);

  // 股票持仓（市值约 8000）
  const stockCode = DEFAULT_STOCKS[0].code;
  const sp = Number(db.get(`SELECT close FROM stock_prices WHERE stock_code = ${db.q(stockCode)} AND tick = ${TICK};`).close);
  const qty = Math.max(1, Math.floor(8000 / sp));
  const stockVal = qty * sp;
  db.exec(`INSERT INTO holdings (id, user_id, stock_code, quantity, available_quantity, avg_cost, updated_at)
    VALUES (${db.q(crypto.randomUUID())}, 'd1', ${db.q(stockCode)}, ${qty}, ${qty}, ${sp}, datetime('now'));`);

  // 基金持仓（市值约 10000）
  const fundCode = DEFAULT_FUNDS[0].code;
  const nav = Number(db.get(`SELECT nav FROM fund_nav WHERE fund_code = ${db.q(fundCode)} AND tick = ${TICK};`).nav);
  const shares = Math.max(1, Math.floor(10000 / nav));
  const fundVal = shares * nav;
  db.exec(`INSERT INTO fund_holdings (id, user_id, fund_code, shares, available_shares, avg_nav, updated_at)
    VALUES (${db.q(crypto.randomUUID())}, 'd1', ${db.q(fundCode)}, ${shares}, ${shares}, ${nav}, datetime('now'));`);

  console.log(`  场景: cash=5000 股票市值≈${stockVal.toFixed(0)} 基金市值≈${fundVal.toFixed(0)}`);

  // 缺额 = 现金 + 股票全部 + 基金一部分（应吃穿现金与股票，再咬掉部分基金）
  const deficit = Number((5000 + stockVal + 5000).toFixed(2));
  const recovered = futures.recoverFuturesDeficit('d1', deficit, TICK, 'QH-CRA');

  const user = db.get(`SELECT * FROM users WHERE id = 'd1';`);
  const remStock = db.get(`SELECT COALESCE(SUM(quantity),0) AS q FROM holdings WHERE user_id = 'd1';`).q;
  const remFundShares = Number(db.get(`SELECT COALESCE(SUM(shares),0) AS s FROM fund_holdings WHERE user_id = 'd1';`).s);
  const drRow = db.get(`SELECT * FROM futures_transactions WHERE user_id = 'd1' AND type = 'deficit_recovery';`);
  const stockTx = db.get(`SELECT COUNT(*) AS c FROM transactions WHERE user_id = 'd1' AND type = 'forced_liquidation';`).c;
  const fundTx = db.get(`SELECT COUNT(*) AS c FROM fund_transactions WHERE user_id = 'd1' AND type = 'forced_liquidation';`).c;

  console.log('【穿仓三级追偿】');
  check('现金被扣至 0（零下限）', Number(user.cash) === 0, `cash=${user.cash}`);
  check('现金永不为负', Number(user.cash) >= 0, `cash=${user.cash}`);
  check('不触发破产', Number(user.bankrupt) === 0, `bankrupt=${user.bankrupt}`);
  check('股票被强制变卖（清空）', Number(remStock) === 0, `剩余股数=${remStock}`);
  check('股票强卖有交易记录', Number(stockTx) >= 1, `forced_liquidation笔数=${stockTx}`);
  check('基金被部分强赎（仍有剩余）', remFundShares > 0 && remFundShares < shares, `剩余份额=${remFundShares.toFixed(2)}/${shares}`);
  check('基金强赎有交易记录', Number(fundTx) >= 1, `forced_liquidation笔数=${fundTx}`);
  check('deficit_recovery 记录存在且 pnl<0', !!drRow && Number(drRow.pnl) < 0, drRow ? `pnl=${drRow.pnl}` : '无记录');
  check('实际追回 ≈ 缺额（资产足够覆盖）', Math.abs(recovered - deficit) <= 1, `recovered=${recovered} deficit=${deficit}`);

  // 第二场景：资产不足以覆盖，剩余缺额由系统吸收，账户仍不破产、现金为 0
  console.log('【缺额超过全部资产 → 系统吸收】');
  db.exec(`INSERT INTO users (id, username, nickname, cash, join_tick, initial_asset_at_join, bankrupt, created_at, updated_at)
    VALUES ('d2', 'd2', 'd2', 1000, 1, 1000, 0, datetime('now'), datetime('now'));`);
  const rec2 = futures.recoverFuturesDeficit('d2', 50000, TICK, 'QH-CRB');
  const u2 = db.get(`SELECT * FROM users WHERE id = 'd2';`);
  check('现金扣至 0', Number(u2.cash) === 0, `cash=${u2.cash}`);
  check('不破产', Number(u2.bankrupt) === 0, `bankrupt=${u2.bankrupt}`);
  check('仅追回现有现金（1000）', Math.abs(rec2 - 1000) <= 1, `recovered=${rec2}`);

  console.log('');
  if (failures === 0) console.log('=== 穿仓追偿回归 PASS ✓ ===');
  else console.log(`=== 穿仓追偿回归 FAIL ✗ (${failures} 项) ===`);
}

try {
  main();
} catch (e) {
  console.error('测试异常:', e);
  failures++;
} finally {
  cleanup();
}
process.exit(failures === 0 ? 0 : 1);

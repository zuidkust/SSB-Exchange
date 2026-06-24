// 期货守恒回归测试：开仓守恒 / 盯市==平仓口径一致(P0-1) / 爆仓封顶。
// 直连模块层（futures.js + db.js），用一次性临时 SQLite，跑完自清理。
// 退出码 0 = 全过；非 0 = 有失败（可做 CI 门槛）。
//
// 注意：P0-1 修复前，「盯市==平仓」一项会失败（这正是回归用例的意义）。
// 修复 markToMarketPositions 改为对入场价重算后，应全部 ✓。

process.env.SSB_CLOCK_NOW = process.env.SSB_CLOCK_NOW || '2026-06-01T09:00:00+08:00';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const DB_PATH = path.join(os.tmpdir(), `ssb_fut_conv_${process.pid}_${Date.now()}.sqlite`);
process.env.SSB_DB_PATH = DB_PATH;

const db = require('./db');
const futures = require('./futures');

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
const priceAt = (code, tick) => Number(db.get(`SELECT price FROM commodity_prices WHERE code = ${db.q(code)} AND tick = ${tick};`)?.price);
const marketRow = () => db.get('SELECT * FROM market_state WHERE id = 1;');

function advance(n) {
  for (let i = 0; i < n; i++) {
    const m = marketRow();
    const ct = Number(m.current_tick), nt = ct + 1;
    db.exec(`UPDATE market_state SET current_tick = ${nt} WHERE id = 1;`);
    futures.advanceFutures({ currentTick: ct, nextTick: nt, stocks: [], activeNews: [] });
  }
}

function main() {
  db.ensureDb();
  const FEE = 0.001;

  // —— 测试 1：开仓守恒 ——
  console.log('【1】开仓守恒');
  {
    const m = marketRow(); const t = Number(m.current_tick);
    const code = 'QH-OIL';
    const p0 = priceAt(code, t);
    let user = mkUser('c1', 1_000_000);
    const cashBefore = Number(user.cash);
    futures.openPosition(user, { code, side: 'long', contracts: 5, leverage: 5, expectedTick: t, expectedPrice: p0 },
      { market: m, tradingAllowed: true });
    user = reload('c1');
    const pos = db.get(`SELECT * FROM futures_positions WHERE user_id = 'c1';`);
    const margin = Number(pos.margin), cv = Number(pos.contract_value), fee = Number((cv * FEE).toFixed(2));
    const fv = futures.futuresValue('c1', t);
    check('现金降幅 = 保证金 + 手续费', near(cashBefore - Number(user.cash), margin + fee), `Δcash=${(cashBefore - user.cash).toFixed(2)} 期望=${(margin + fee).toFixed(2)}`);
    check('futuresValue = 保证金(浮盈0)', near(fv, margin), `fv=${fv} margin=${margin}`);
    check('净值(cash+fv) = 初始 − 手续费', near(Number(user.cash) + fv, cashBefore - fee), `净值=${(Number(user.cash) + fv).toFixed(2)}`);
  }

  // —— 测试 2：盯市浮盈 == 平仓赔付（P0-1 口径一致）——
  console.log('【2】盯市口径 == 平仓口径（P0-1）');
  {
    const m0 = marketRow(); const t0 = Number(m0.current_tick);
    const code = 'QH-OIL';
    const entry = priceAt(code, t0);
    let user = mkUser('c2', 1_000_000);
    futures.openPosition(user, { code, side: 'long', contracts: 5, leverage: 3, expectedTick: t0, expectedPrice: entry },
      { market: m0, tradingAllowed: true });
    const posId = db.get(`SELECT id FROM futures_positions WHERE user_id = 'c2';`).id;

    advance(6);

    const pos = db.get(`SELECT * FROM futures_positions WHERE id = ${db.q(posId)} AND status = 'open';`);
    if (!pos) {
      check('持仓未中途爆仓（用于口径对比）', false, '仓位被提前平/爆，调低杠杆或波动后重试');
    } else {
      const m = marketRow(); const t = Number(m.current_tick);
      const pNow = priceAt(code, t);
      const cv = Number(pos.contract_value);
      const storedPnl = Number(pos.unrealized_pnl);                       // 净资产/爆仓用
      const truePnl = Number(((pNow - entry) / entry * cv).toFixed(2));   // 平仓口径
      check('盯市浮盈 == 真实总盈亏(对entry)', near(storedPnl, truePnl, 0.5),
        `盯市=${storedPnl.toFixed(2)} 真实=${truePnl.toFixed(2)} 偏差=${(storedPnl - truePnl).toFixed(2)}`);

      user = reload('c2');
      const r = futures.closePosition(user, { positionId: posId, expectedTick: t, expectedPrice: pNow },
        { market: m, tradingAllowed: true });
      const closeFee = Number((cv * FEE).toFixed(2));
      check('closePosition.pnl == 真实总盈亏', near(r.pnl, truePnl), `pnl=${r.pnl} 真实=${truePnl}`);
      check('returnedCash = 保证金 + pnl − 手续费', near(r.returnedCash, Number(pos.margin) + r.pnl - closeFee),
        `返还=${r.returnedCash}`);
    }
  }

  // —— 测试 3：爆仓封顶（现金不为负，亏损 ≤ 保证金）——
  console.log('【3】爆仓封顶（高杠杆长跑，现金恒 ≥ 0，亏损 ≤ 保证金）');
  {
    const m0 = marketRow(); const t0 = Number(m0.current_tick);
    const code = 'QH-IDXV';
    const entry = priceAt(code, t0);
    let user = mkUser('c3', 1_000_000);
    futures.openPosition(user, { code, side: 'long', contracts: 10, leverage: 10, expectedTick: t0, expectedPrice: entry },
      { market: m0, tradingAllowed: true });
    const pos0 = db.get(`SELECT * FROM futures_positions WHERE user_id = 'c3';`);
    const margin = Number(pos0.margin);

    let cashFloorOk = true;
    for (let i = 0; i < 120; i++) {
      advance(1);
      const cash = Number(reload('c3').cash);
      if (cash < -0.01) cashFloorOk = false;
    }
    check('全程现金恒 ≥ 0（亏损不穿透）', cashFloorOk);

    const liq = db.get(`SELECT * FROM futures_transactions WHERE user_id = 'c3' AND type = 'liquidation' ORDER BY id DESC LIMIT 1;`);
    if (liq) {
      check('爆仓亏损 ≤ 保证金（封顶）', Number(liq.pnl) >= -margin - 0.01, `pnl=${liq.pnl} margin=${margin}`);
    } else {
      console.log('  · 本次随机路径未触发爆仓（仅验证了现金不穿透）；多跑几次或调高杠杆可覆盖爆仓分支');
    }
  }

  console.log(`\n=== 期货守恒回归 ${failures === 0 ? 'PASS ✓' : `FAIL ✗（${failures} 项）`} ===`);
}

try {
  main();
} catch (err) {
  console.error('测试异常：', err.message);
  failures++;
} finally {
  cleanup();
}
process.exit(failures === 0 ? 0 : 1);

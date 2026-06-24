// 一键注入虚假强平+追偿数据，用于测试爆仓通知 UI
const db = require('./db');

const market = db.get('SELECT current_tick FROM market_state;');
const tick = market ? Number(market.current_tick) : 1;
const adminRow = db.get("SELECT id FROM users WHERE username = 'SSB-DEMO';");
if (!adminRow) { console.log('SSB-DEMO 账号不存在'); process.exit(1); }
const userId = adminRow.id;

// 清理同 tick 已有虚假记录，防止重复叠加
db.exec(`DELETE FROM futures_transactions WHERE tick = ${tick} AND type IN ('liquidation','deficit_recovery') AND user_id = ${db.q(userId)};`);
db.exec(`DELETE FROM transactions WHERE tick = ${tick} AND type = 'forced_liquidation' AND user_id = ${db.q(userId)};`);
db.exec(`DELETE FROM fund_transactions WHERE tick = ${tick} AND type = 'forced_liquidation' AND user_id = ${db.q(userId)};`);

// 1) 期货强平 —— 花剑币做多 10 张，亏损 21,698.90
db.exec(`INSERT INTO futures_transactions (user_id, code, type, side, contracts, price, margin, pnl, fee, tick, created_at)
  VALUES (${db.q(userId)}, 'QH-CRB', 'liquidation', 'long', 10, 850.00, 32000, -21698.90, 0, ${tick}, datetime('now'));`);

// 2) 期货强平 —— 原油做空 5 张，亏损 8,500.00
db.exec(`INSERT INTO futures_transactions (user_id, code, type, side, contracts, price, margin, pnl, fee, tick, created_at)
  VALUES (${db.q(userId)}, 'QH-OIL', 'liquidation', 'short', 5, 420.00, 18000, -8500.00, 0, ${tick}, datetime('now'));`);

// 3) 穿仓追偿 —— 花剑币穿仓缺口 3,500.00
db.exec(`INSERT INTO futures_transactions (user_id, code, type, side, contracts, price, margin, pnl, fee, tick, created_at)
  VALUES (${db.q(userId)}, 'QH-CRB', 'deficit_recovery', 'long', 0, 850.00, 0, -3500.00, 0, ${tick}, datetime('now'));`);

// 4) 追偿卖出股票 —— 诺危 1000 股 @ 25
db.exec(`INSERT INTO transactions (user_id, stock_code, type, quantity, price, fee, tick, created_at)
  VALUES (${db.q(userId)}, 'SSB016', 'forced_liquidation', 1000, 25.00, 0, ${tick}, datetime('now'));`);

// 5) 追偿卖出股票 —— 炬芯科技 500 股 @ 48
db.exec(`INSERT INTO transactions (user_id, stock_code, type, quantity, price, fee, tick, created_at)
  VALUES (${db.q(userId)}, 'SSB005', 'forced_liquidation', 500, 48.00, 0, ${tick}, datetime('now'));`);

// 6) 追偿赎回基金 —— 广迪全市场指数 15,000.00
db.exec(`INSERT INTO fund_transactions (user_id, fund_code, type, amount, shares, nav, fee, tick, created_at)
  VALUES (${db.q(userId)}, 'GD01', 'forced_liquidation', 15000.00, 14824.55, 1.0117, 0, ${tick}, datetime('now'));`);

console.log(`已将 2 笔强平 + 1 笔穿仓追偿 + 2 笔股票追偿 + 1 笔基金追偿 注入第 ${tick} 期`);
console.log('重启服务后，SSB-DEMO 打开期货页即可看到强平通知');

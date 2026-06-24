#!/usr/bin/env node

const db = require('./db');
const funds = require('./funds');

db.ensureDb();

const market = db.get('SELECT * FROM market_state WHERE id = 1;');
const currentTick = Number(market?.current_tick || 1);

console.log('=== 主动基金权重恢复工具 ===');
console.log(`当前 tick: ${currentTick}`);
console.log(`day_start_tick: ${market?.day_start_tick}`);
console.log(`day_tick_index: ${market?.day_tick_index}`);
console.log();

const activeFunds = db.all("SELECT code, name, strategy, manager_name FROM funds WHERE manage_mode = 'active';");
if (!activeFunds.length) {
  console.log('没有找到主动基金，无需恢复。');
  process.exit(0);
}

console.log(`找到 ${activeFunds.length} 只主动基金:`);
for (const f of activeFunds) {
  console.log(`  ${f.code} ${f.name} — ${f.manager_name} (${f.strategy})`);
}
console.log();

// Inspect current state
console.log('--- 当前 fund_weight 状态 ---');
for (const fund of activeFunds) {
  const entries = db.all(
    `SELECT tick, COUNT(*) as cnt, MIN(weight) as min_w, MAX(weight) as max_w
     FROM fund_weight WHERE fund_code = '${fund.code}'
     GROUP BY tick ORDER BY tick;`
  );
  if (!entries.length) {
    console.log(`  ${fund.code}: 无权重记录`);
    continue;
  }
  for (const e of entries) {
    const isEqual = Math.abs(Number(e.max_w) - Number(e.min_w)) < 1e-6;
    const flag = isEqual && e.tick > 1 ? ' ← 等权污染!' : (isEqual && e.tick === 1 ? ' (基准等权)' : '');
    console.log(`  ${fund.code} tick=${e.tick}: ${e.cnt} 只, min=${Number(e.min_w).toFixed(4)}, max=${Number(e.max_w).toFixed(4)}${flag}`);
  }
}
console.log();

// Execute recovery
console.log('--- 执行恢复（dryRun=false）---');
const results = funds.recoverActiveFunds({ dryRun: false });
console.log();

// Print results
if (results.cleaned.length) {
  console.log('已清理污染条目:');
  for (const item of results.cleaned) {
    console.log(`  ${item.fund} tick=${item.tick} (${item.count} 条)`);
  }
} else {
  console.log('无污染条目需要清理。');
}

if (results.recomputed.length) {
  console.log();
  console.log('已重算调仓权重:');
  for (const item of results.recomputed) {
    const weights = db.all(
      `SELECT stock_code, weight FROM fund_weight WHERE fund_code = '${item.fund}' AND tick = ${item.tick} ORDER BY weight DESC;`
    );
    const detail = weights.map((w) => `${w.stock_code}:${(Number(w.weight) * 100).toFixed(1)}%`).join(', ');
    console.log(`  ${item.fund} tick=${item.tick} (${item.count} 条): ${detail}`);
  }
} else {
  console.log('调仓权重已存在，无需重算。');
}

if (results.navRewritten.length) {
  console.log();
  console.log('已重算净值 (tick: old → new):');
  for (const item of results.navRewritten) {
    const oldStr = item.oldNav != null ? item.oldNav.toFixed(4) : 'N/A';
    console.log(`  ${item.fund} tick=${item.tick}: ${oldStr} → ${item.newNav.toFixed(4)}`);
  }
} else {
  console.log('无净值需要重算。');
}

// Final state
console.log();
console.log('--- 恢复后 fund_weight 状态 ---');
for (const fund of activeFunds) {
  const entries = db.all(
    `SELECT tick, COUNT(*) as cnt, MIN(weight) as min_w, MAX(weight) as max_w
     FROM fund_weight WHERE fund_code = '${fund.code}'
     GROUP BY tick ORDER BY tick;`
  );
  if (!entries.length) {
    console.log(`  ${fund.code}: 无权重记录`);
    continue;
  }
  for (const e of entries) {
    const isEqual = Math.abs(Number(e.max_w) - Number(e.min_w)) < 1e-6;
    const flag = isEqual ? ' (等权)' : ' (策略化 ✓)';
    console.log(`  ${fund.code} tick=${e.tick}: ${e.cnt} 只, min=${Number(e.min_w).toFixed(4)}, max=${Number(e.max_w).toFixed(4)}${flag}`);
  }
}

console.log();
console.log('恢复完成。市场 tick 未被推进。');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DB_PATH = path.join(os.tmpdir(), `ssb_news_balance_${process.pid}_${Date.now()}.sqlite`);
process.env.SSB_DB_PATH = DB_PATH;
process.env.SSB_CLOCK_NOW = '2026-06-01T08:00:00+08:00';

const db = require('./db');
const news = require('./news');
const data = require('./data');

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch {}
  }
}

function truthBucket(truthType) {
  const t = String(truthType || '');
  if (t === 'ambiguous') return 'ambiguous';
  if (t.startsWith('real_bullish')) return 'bullish';
  if (t.startsWith('real_bearish')) return 'bearish';
  if (t.startsWith('fake_bullish')) return 'bullish';
  if (t.startsWith('fake_bearish')) return 'bearish';
  return 'other';
}

try {
  db.ensureDb();
  db.exec('UPDATE market_state SET current_tick = 1 WHERE id = 1;');

  const stocks = data.DEFAULT_STOCKS || data.STOCKS || [];
  if (!stocks.length) {
    throw new Error('股票数据不可用');
  }

  const totalTicks = 20;
  for (let tick = 1; tick <= totalTicks; tick += 1) {
    db.exec(`UPDATE market_state SET current_tick = ${tick} WHERE id = 1;`);
    news.generateNews(tick, stocks);
    news.checkAndGenerateRumors(tick);
  }

  const rows = db.all(`SELECT truth_type, is_rumor FROM news
    WHERE published = 1 AND created_tick BETWEEN 1 AND ${totalTicks}
      AND truth_type IS NOT NULL
      AND truth_type != '';`);
  assert.ok(rows.length >= 30, `新闻数量过少: ${rows.length}`);

  const counts = { bullish: 0, bearish: 0, ambiguous: 0, other: 0 };
  for (const row of rows) {
    counts[truthBucket(row.truth_type)] += 1;
  }
  assert.ok(counts.bullish > 0, '完全没有多头类新闻');
  assert.ok(counts.bearish > 0, '完全没有空头类新闻');

  const directional = counts.bullish + counts.bearish;
  if (directional > 0) {
    const dominantShare = Math.max(counts.bullish, counts.bearish) / directional;
    assert.ok(
      dominantShare <= 0.7,
      `多空严重失衡: bullish=${counts.bullish} bearish=${counts.bearish} ambiguous=${counts.ambiguous}`
    );
  }

  const ambiguousShare = counts.ambiguous / rows.length;
  assert.ok(
    ambiguousShare >= 0.05 && ambiguousShare <= 0.6,
    `模糊新闻占比异常: ${(ambiguousShare * 100).toFixed(1)}% (${counts.ambiguous}/${rows.length})`
  );

  // 新增：辟谣/反转占比检查
  const totalRumors = rows.filter(r => r.is_rumor === 1).length;
  const rumorShare = totalRumors / rows.length;
  assert.ok(
    rumorShare <= 0.15,
    `辟谣占比过高: ${(rumorShare * 100).toFixed(1)}% (${totalRumors}/${rows.length})`
  );

  // 新增：真/假新闻比检查（假应≥真）
  const realCount = rows.filter(r => !r.is_rumor && String(r.truth_type).startsWith('real_')).length;
  const fakeCount = rows.filter(r => !r.is_rumor && String(r.truth_type).startsWith('fake_')).length;
  let realFakeRatio = -1;
  if (fakeCount > 0) {
    realFakeRatio = realCount / fakeCount;
    assert.ok(
      realFakeRatio >= 0.4 && realFakeRatio <= 2.5,
      `真/假新闻比异常: ${realFakeRatio.toFixed(2)} (real=${realCount} fake=${fakeCount})`
    );
  }

  // 新增：单 tick 平均辟谣 ≤ 2
  const perTickRumors = totalRumors / totalTicks;
  assert.ok(
    perTickRumors <= 2,
    `每期平均辟谣过高: ${perTickRumors.toFixed(1)}`
  );

  const active = db.all(`SELECT impact_magnitude FROM news
    WHERE published = 1 AND impact_start_tick <= ${totalTicks}
      AND (impact_start_tick + impact_duration_ticks) > ${totalTicks}
      AND truth_type IS NOT NULL AND truth_type != 'ambiguous';`);
  if (active.length) {
    const avgMag = active.reduce((sum, r) => sum + Math.abs(Number(r.impact_magnitude) || 0), 0) / active.length;
    assert.ok(avgMag > 0 && avgMag < 0.5, `平均影响幅度越界: ${avgMag}`);
  }

  console.log('news-balance-test: PASS');
  console.log(`  totals: bullish=${counts.bullish} bearish=${counts.bearish} ambiguous=${counts.ambiguous} other=${counts.other}`);
  console.log(`  rumorShare=${(rumorShare * 100).toFixed(1)}% (${totalRumors}/${rows.length})  realFakeRatio=${realFakeRatio.toFixed(2)}  avgRumorPerTick=${perTickRumors.toFixed(1)}`);
} finally {
  cleanup();
}

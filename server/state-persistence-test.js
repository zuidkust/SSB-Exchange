const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const databasePath = path.join(os.tmpdir(), `ssb_state_persistence_${process.pid}_${Date.now()}.sqlite`);
process.env.SSB_DB_PATH = databasePath;

const db = require('./db');

function assert(condition, label) {
  if (!condition) throw new Error(`FAIL: ${label}`);
}

function main() {
  db.resetDb();
  db.exec(`UPDATE stock_dynamics
    SET regime = 'trend', trend_dir = -1, trend_remaining = 7, trend_total = 9, streak = -4
    WHERE stock_code = 'SSB001';`);
  db.exec(`INSERT INTO stock_prices
    (stock_code, tick, open, close, high, low, anchor, change_pct, created_at)
    VALUES ('SSB001', 2, 52, 50, 52, 50, 48.7654, -0.0385, datetime('now'));`);
  db.exec('UPDATE market_state SET current_tick = 2 WHERE id = 1;');

  const script = `
    const db = require('./server/db');
    db.ensureDb();
    const dynamics = db.get("SELECT * FROM stock_dynamics WHERE stock_code = 'SSB001';");
    const price = db.get("SELECT * FROM stock_prices WHERE stock_code = 'SSB001' AND tick = 2;");
    process.stdout.write(JSON.stringify({ dynamics, anchor: price.anchor }));
  `;
  const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', script], {
    cwd: root,
    env: { ...process.env, SSB_DB_PATH: databasePath },
    encoding: 'utf8'
  });
  if (child.status !== 0) throw new Error(child.stderr || 'restart child failed');
  const result = JSON.parse(child.stdout);
  assert(result.dynamics.regime === 'trend', 'trend regime survives a process restart');
  assert(Number(result.dynamics.trend_dir) === -1 && Number(result.dynamics.trend_remaining) === 7,
    'trend direction and duration survive a process restart');
  assert(Number(result.dynamics.streak) === -4, 'streak survives a process restart');
  assert(Number(result.anchor) === 48.7654, 'dynamic anchor survives a process restart');
  console.log('persistent market state checks ok');
}

main();

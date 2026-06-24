// 数据库迁移测试：旧库（缺少 client_request_id 列）升级到当前 schema 不应启动失败
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');

function tmpDb() {
  return path.join(os.tmpdir(), `ssb_migrate_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.sqlite`);
}

function columnsOf(dbPath, table) {
  const sqlite = new DatabaseSync(dbPath);
  try { return sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name); }
  finally { sqlite.close(); }
}

function indexesOf(dbPath, table) {
  const sqlite = new DatabaseSync(dbPath);
  try { return sqlite.prepare(`PRAGMA index_list(${table})`).all().map((i) => i.name); }
  finally { sqlite.close(); }
}

try {
  const dbPath = tmpDb();
  process.env.SSB_DB_PATH = dbPath;
  process.env.SSB_CLOCK_NOW = '2026-06-01T08:00:00+08:00';

  const db = require('./db');
  db.ensureDb();

  const sqlite = new DatabaseSync(dbPath);
  try {
    sqlite.exec(`CREATE TABLE sports_bets_backup AS SELECT * FROM sports_bets WHERE 0;`);
    sqlite.exec(`DROP TABLE sports_bets;`);
    sqlite.exec(`CREATE TABLE sports_bets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      match_id TEXT NOT NULL,
      selection_team_id TEXT NOT NULL,
      amount REAL NOT NULL,
      locked_odds REAL NOT NULL,
      status TEXT NOT NULL,
      payout REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      settled_at TEXT
    );`);
    sqlite.prepare(`INSERT INTO sports_bets (id, user_id, match_id, selection_team_id, amount, locked_odds, status, payout, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('legacy-bet-1', 'admin-id', 'm1', 't1', 1000, 1.8, 'pending', 0, '2026-06-01T08:00:00+08:00');
    sqlite.exec(`DROP TABLE sports_bets_backup;`);
    sqlite.exec(`DROP TABLE basketball_player_moves;`);
    sqlite.exec(`CREATE TABLE basketball_player_moves (
      id TEXT PRIMARY KEY,
      season_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      from_team_id TEXT NOT NULL,
      to_team_id TEXT NOT NULL,
      position TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`);
    sqlite.prepare(`INSERT INTO basketball_teams (id, code, name, city, championships, created_at)
      VALUES (?, ?, ?, ?, 0, datetime('now'))`).run('team-8', 'BL08', '重庆山鹰', '重庆');
    sqlite.prepare(`INSERT INTO basketball_teams (id, code, name, city, championships, created_at)
      VALUES (?, ?, ?, ?, 0, datetime('now'))`).run('team-16', 'BL16', '宁波海龙', '宁波');
  } finally { sqlite.close(); }

  assert.ok(!columnsOf(dbPath, 'sports_bets').includes('client_request_id'),
    '前置条件：重建后的 sports_bets 表不应有 client_request_id 列');
  const legacyRow = new DatabaseSync(dbPath).prepare('SELECT * FROM sports_bets WHERE id = ?').get('legacy-bet-1');
  assert.ok(legacyRow, '前置条件：旧库应保留 legacy-bet-1');

  const indexesBefore = indexesOf(dbPath, 'sports_bets');
  assert.ok(!indexesBefore.some((n) => n.includes('user_request')),
    '前置条件：不应存在 user_request 索引');

  const Database = require('./db');
  Database.connect = null;
  delete require.cache[require.resolve('./db')];
  const db2 = require('./db');
  db2.ensureDb();

  const cols = columnsOf(dbPath, 'sports_bets');
  assert.ok(cols.includes('client_request_id'),
    '迁移后 sports_bets 应包含 client_request_id 列');
  assert.ok(columnsOf(dbPath, 'basketball_player_moves').includes('move_type'),
    '迁移后球员流动记录应包含 move_type');
  assert.ok(columnsOf(dbPath, 'basketball_player_moves').includes('event_id'),
    '迁移后球员流动记录应包含 event_id');
  assert.ok(columnsOf(dbPath, 'basketball_trade_events').includes('plan_json'),
    '迁移后应创建常规赛交易计划表');
  assert.ok(columnsOf(dbPath, 'basketball_player_developments').includes('ability_after'),
    '迁移后应创建选秀成长记录表');
  assert.ok(columnsOf(dbPath, 'sports_series_markets').includes('home_win_probability'),
    '迁移后应创建系列赛市场表');
  assert.ok(columnsOf(dbPath, 'sports_series_bets').includes('client_request_id'),
    '迁移后应创建系列赛竞猜订单表');
  assert.ok(columnsOf(dbPath, 'sports_cash_events').includes('series_id'),
    '迁移后赛事资金流水应支持系列赛关联');
  assert.ok(columnsOf(dbPath, 'sports_config').includes('regular_form_cap'),
    '迁移后赛事配置应包含常规赛状态上限');
  assert.ok(columnsOf(dbPath, 'sports_config').includes('regular_scale_factor'),
    '迁移后赛事配置应包含常规赛实力敏感度');

  const idxs = indexesOf(dbPath, 'sports_bets');
  assert.ok(idxs.some((n) => n.includes('user_request')),
    '迁移后应创建 user_request 唯一索引');
  assert.ok(indexesOf(dbPath, 'sports_series_bets').some((n) => n.includes('user_request')),
    '迁移后应创建系列赛订单幂等唯一索引');

  const sqliteAfter = new DatabaseSync(dbPath);
  try {
    const legacyAfter = sqliteAfter.prepare('SELECT * FROM sports_bets WHERE id = ?').get('legacy-bet-1');
    assert.ok(legacyAfter, '迁移不应丢失 legacy-bet-1');
    assert.equal(legacyAfter.amount, 1000, '迁移不应改变 amount');
    assert.equal(legacyAfter.client_request_id, null, '迁移后旧记录的 client_request_id 应为 NULL');
    assert.equal(sqliteAfter.prepare(`SELECT name FROM basketball_teams WHERE id = 'team-8'`).get().name, '重庆飞鹰');
    assert.equal(sqliteAfter.prepare(`SELECT name FROM basketball_teams WHERE id = 'team-16'`).get().name, '宁波地鼠');

    sqliteAfter.prepare('INSERT INTO sports_bets (id, user_id, match_id, selection_team_id, amount, locked_odds, status, payout, client_request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))').run('dup-r1', 'admin-id', 'm2', 't1', 1000, 1.8, 'pending', 0, 'same-key');
    assert.throws(() => {
      sqliteAfter.prepare('INSERT INTO sports_bets (id, user_id, match_id, selection_team_id, amount, locked_odds, status, payout, client_request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))').run('dup-r2', 'admin-id', 'm3', 't1', 1000, 1.8, 'pending', 0, 'same-key');
    }, /UNIQUE/i, '同一 (user_id, client_request_id) 写入必须被唯一索引拒绝');

    sqliteAfter.prepare('INSERT INTO sports_bets (id, user_id, match_id, selection_team_id, amount, locked_odds, status, payout, client_request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, datetime(\'now\'))').run('null-key-1', 'admin-id', 'm4', 't1', 1000, 1.8, 'pending', 0);
    sqliteAfter.prepare('INSERT INTO sports_bets (id, user_id, match_id, selection_team_id, amount, locked_odds, status, payout, client_request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, datetime(\'now\'))').run('null-key-2', 'admin-id', 'm5', 't1', 1000, 1.8, 'pending', 0);
    const nullCount = sqliteAfter.prepare('SELECT COUNT(*) AS c FROM sports_bets WHERE client_request_id IS NULL').get().c;
    assert.ok(nullCount >= 2, 'NULL client_request_id 不应被唯一索引约束');
  } finally { sqliteAfter.close(); }

  console.log('db-migration-test: PASS');
} finally {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync((process.env.SSB_DB_PATH || '') + suffix); } catch {}
  }
}

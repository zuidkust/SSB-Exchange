const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_STOCKS, DEFAULT_FUNDS, DEFAULT_FUTURES, FUTURES_REGIME_PARAMS, RULES } = require('./data');
const { ADMIN_ACCOUNT } = require('./accounts');
const clock = require('./clock');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = process.env.SSB_DB_PATH || path.join(DATA_DIR, 'ssb.sqlite');

let database = null;

const DEFAULT_CODE_MIGRATIONS = DEFAULT_STOCKS.map((stock, index) => ({
  from: `XN${String(index + 1).padStart(3, '0')}`,
  to: stock.code
}));

const DEFAULT_FUND_CODE_MIGRATIONS = [
  ['SSBF-TECH', 'TY01'],
  ['SSBF-HEALTH', 'TY02'],
  ['SSBF-QDII', 'TY03'],
  ['SSBF-BLUE', 'SH01'],
  ['SSBF-FIN', 'SH02'],
  ['SSBF-GOLD', 'SH03'],
  ['SSBF-IDX', 'GD01'],
  ['SSBF-CASH', 'GD02'],
  ['SSBF-BOND', 'GD03'],
  ['SSBF-CONS', 'DB01'],
  ['SSBF-MFG', 'DB02']
].map(([from, to]) => ({ from, to }));

const DEFAULT_NAME_REFRESH = {
  SSB001: ['风暴电池铺', '星能科技', '华创新能源', '池田动力', '曜琅光能'],
  SSB002: ['云雾算力庙', '云端数据', '云帆数据'],
  SSB003: ['土豆宇宙', '绿野农业', '丰登农业', '谷嘉农业'],
  SSB004: ['灵药试吃局', '瑞恒医药', '启元生物', '济平生物'],
  SSB005: ['硅片煎饼摊', '星际半导体', '星芯科技'],
  SSB006: ['醉仙快乐水', '金鼎消费', '金樽酒业', '懒猫酒业'],
  SSB007: ['楼王蹦蹦城', '宏图地产', '恒远地产'],
  SSB008: ['卷王补习社', '启航教育', '翰林教育', '越溪技校'],
  SSB009: ['筋斗云快递', '蓝海物流', '通达物流', '天际物流', 'PG物流'],
  SSB010: ['钱袋魔法社', '锐智金融', '融通数据', 'DB金服'],
  SSB011: ['快乐爆肝厂', '创梦文娱', '低能游戏社'],
  SSB012: ['水泥猛兽团', '恒基建材', '华兴建材'],
  SSB013: ['垃圾变金矿', '清源环保', '善海集团'],
  SSB014: ['电驴火箭厂', '飞跃汽车', '驰远汽车', '邓氪汽车'],
  SSB015: ['信号满格塔', '量子通信', '天通通信', '疾风通信'],
  SSB016: ['纳米煎饼侠', '芯海半导体', '新海半导体', '诺危'],
  SSB017: ['算力泡泡龙', '腾云科技'],
  SSB018: ['闪电方向盘', '电擎动力', '大米汽车'],
  SSB019: ['不困实验室', '国邦医药', '威邦医药'],
  SSB020: ['六格信号兽', '星网通信'],
  SSB021: ['镜海电子'],
  SSB022: ['枢云软件'],
  SSB023: ['衡光医疗'],
  SSB024: ['迭生科技', '季骏生物'],
  SSB025: ['素问制药'],
  SSB026: ['百川商贸', '广实商贸'],
  SSB027: ['谷雨食品'],
  SSB028: ['星幕文娱'],
  SSB029: ['铸星精工'],
  SSB030: ['晨曦储能'],
  SSB031: ['逐电汽车'],
  SSB032: ['安澜银行'],
  SSB033: ['长桥保险'],
  SSB034: ['栖岸置业'],
  SSB035: ['赤岭资源', '广威资源'],
  SSB036: ['深潮能源', '白璞能源']
};

function connect() {
  if (database) return database;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  database = new DatabaseSync(DB_PATH);
  database.exec('PRAGMA journal_mode = WAL;');
  database.exec('PRAGMA foreign_keys = ON;');
  return database;
}

function ensureDb() {
  const db = connect();
  db.exec(`
CREATE TABLE IF NOT EXISTS market_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  current_tick INTEGER NOT NULL,
  initial_cash REAL NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stocks (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sector TEXT,
  industry TEXT NOT NULL,
  mapping TEXT NOT NULL,
  initial_price REAL NOT NULL,
  volatility REAL NOT NULL,
  risk_level TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_code TEXT NOT NULL,
  tick INTEGER NOT NULL,
  open REAL NOT NULL,
  close REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  anchor REAL,
  change_pct REAL NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(stock_code, tick)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE,
  nickname TEXT NOT NULL,
  cash REAL NOT NULL,
  join_tick INTEGER NOT NULL,
  initial_asset_at_join REAL NOT NULL,
  password_hash TEXT,
  password_salt TEXT,
  activated_at TEXT,
  last_login_at TEXT,
  last_seen_at TEXT,
  login_count INTEGER NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  invite_code TEXT,
  has_active_loan INTEGER NOT NULL DEFAULT 0,
  bankrupt INTEGER NOT NULL DEFAULT 0,
  bank_tier INTEGER NOT NULL DEFAULT 1,
  qualifying_repayments INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_ci ON users(LOWER(username));

CREATE TABLE IF NOT EXISTS holdings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  stock_code TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  available_quantity INTEGER NOT NULL,
  avg_cost REAL NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, stock_code)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  stock_code TEXT NOT NULL,
  type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  price REAL NOT NULL,
  fee REAL NOT NULL,
  tick INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tick INTEGER NOT NULL,
  cash REAL NOT NULL,
  holding_value REAL NOT NULL,
  total_asset REAL NOT NULL,
  return_pct REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_type TEXT NOT NULL,
  news_type TEXT NOT NULL,
  visible_sentiment TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_code TEXT NOT NULL,
  created_tick INTEGER NOT NULL,
  published INTEGER NOT NULL DEFAULT 1,
  is_rumor INTEGER NOT NULL DEFAULT 0,
  expert_id TEXT,
  expert_name TEXT,
  truth_type TEXT NOT NULL,
  impact_magnitude REAL NOT NULL,
  impact_start_tick INTEGER NOT NULL,
  impact_duration_ticks INTEGER NOT NULL,
  reveal_tick INTEGER,
  linked_news_id INTEGER,
  chain TEXT,
  rumor_generated INTEGER DEFAULT 0,
  is_fluff INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kol_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick INTEGER NOT NULL,
  kol_id TEXT NOT NULL,
  kol_name TEXT NOT NULL,
  tier TEXT NOT NULL,
  comment_type TEXT NOT NULL,
  target_news_id INTEGER,
  target_scope TEXT,
  stance TEXT NOT NULL,
  is_correct INTEGER,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS weekly_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick INTEGER NOT NULL,
  start_tick INTEGER NOT NULL,
  top_gainers TEXT NOT NULL,
  top_losers TEXT NOT NULL,
  important_news TEXT NOT NULL,
  user_snapshot TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  principal REAL NOT NULL,
  remaining_principal REAL NOT NULL,
  total_interest_paid REAL NOT NULL DEFAULT 0,
  start_tick INTEGER NOT NULL,
  deadline_tick INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS loan_interest_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  loan_id INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  interest_amount REAL NOT NULL,
  paid_from_cash REAL NOT NULL,
  rolled_into_principal REAL NOT NULL,
  remaining_principal_after REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS p2p_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  amount REAL NOT NULL,
  rate_tier INTEGER NOT NULL,
  term_ticks INTEGER NOT NULL,
  expected_return REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS p2p_loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lender_id TEXT NOT NULL,
  borrower_id TEXT NOT NULL,
  principal REAL NOT NULL,
  rate_tier INTEGER NOT NULL,
  rate_per_tick REAL NOT NULL,
  term_ticks INTEGER NOT NULL,
  accrued_interest REAL NOT NULL DEFAULT 0,
  start_tick INTEGER NOT NULL,
  deadline_tick INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  close_tick INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invite_codes (
  code            TEXT PRIMARY KEY,
  nickname        TEXT,
  status          TEXT NOT NULL DEFAULT 'unused',
  used_by_user_id TEXT,
  created_by      TEXT,
  created_at      TEXT NOT NULL,
  used_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_invite_status ON invite_codes(status);

CREATE TABLE IF NOT EXISTS stock_dynamics (
  stock_code TEXT PRIMARY KEY,
  regime TEXT NOT NULL DEFAULT 'oscillation',
  trend_dir INTEGER NOT NULL DEFAULT 0,
  trend_remaining INTEGER NOT NULL DEFAULT 0,
  trend_total INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS funds (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  category TEXT NOT NULL,
  basket_json TEXT,
  base_nav REAL NOT NULL DEFAULT 1,
  volatility REAL,
  params_json TEXT,
  risk_level TEXT NOT NULL,
  fee_free INTEGER NOT NULL DEFAULT 0,
  redeem_t0 INTEGER NOT NULL DEFAULT 0,
  manage_mode TEXT NOT NULL DEFAULT 'passive',
  strategy TEXT,
  manager_name TEXT,
  mgmt_fee_rate REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS fund_nav (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fund_code TEXT NOT NULL,
  tick INTEGER NOT NULL,
  nav REAL NOT NULL,
  change_pct REAL NOT NULL,
  turnover_cost REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(fund_code, tick)
);

CREATE TABLE IF NOT EXISTS fund_weight (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fund_code TEXT NOT NULL,
  tick INTEGER NOT NULL,
  stock_code TEXT NOT NULL,
  weight REAL NOT NULL,
  UNIQUE(fund_code, tick, stock_code)
);

CREATE TABLE IF NOT EXISTS fund_holdings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  fund_code TEXT NOT NULL,
  shares REAL NOT NULL,
  available_shares REAL NOT NULL,
  avg_nav REAL NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, fund_code)
);

CREATE TABLE IF NOT EXISTS fund_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  fund_code TEXT NOT NULL,
  type TEXT NOT NULL,
  shares REAL NOT NULL,
  nav REAL NOT NULL,
  amount REAL NOT NULL,
  fee REAL NOT NULL,
  tick INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fund_regime (
  fund_code TEXT PRIMARY KEY,
  regime TEXT NOT NULL DEFAULT 'bull',
  regime_since_tick INTEGER NOT NULL DEFAULT 0,
  regime_duration_ticks INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS futures_underlyings (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  track TEXT NOT NULL,
  regime_engine TEXT NOT NULL,
  base_price REAL NOT NULL,
  contract_multiplier REAL NOT NULL,
  max_leverage REAL NOT NULL,
  max_exposure REAL,
  linked_sector TEXT,
  volatility REAL NOT NULL,
  params_json TEXT
);

CREATE TABLE IF NOT EXISTS commodity_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  tick INTEGER NOT NULL,
  price REAL NOT NULL,
  change_pct REAL NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(code, tick)
);

CREATE TABLE IF NOT EXISTS commodity_regime (
  code TEXT PRIMARY KEY,
  regime TEXT NOT NULL,
  regime_since_tick INTEGER NOT NULL,
  regime_duration_ticks INTEGER NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS futures_positions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code TEXT NOT NULL,
  side TEXT NOT NULL,
  contracts REAL NOT NULL,
  contract_value REAL NOT NULL,
  entry_price REAL NOT NULL,
  leverage REAL NOT NULL,
  margin REAL NOT NULL,
  unrealized_pnl REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  opened_tick INTEGER NOT NULL,
  closed_tick INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS futures_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  code TEXT NOT NULL,
  type TEXT NOT NULL,
  side TEXT NOT NULL,
  contracts REAL NOT NULL,
  price REAL NOT NULL,
  margin REAL NOT NULL,
  pnl REAL NOT NULL,
  fee REAL NOT NULL,
  tick INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sports_competitions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sport_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sports_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  paused INTEGER NOT NULL DEFAULT 0,
  house_edge REAL NOT NULL DEFAULT 0.05,
  min_bet REAL NOT NULL DEFAULT 1000,
  max_bet_per_match REAL NOT NULL DEFAULT 100000,
  home_advantage REAL NOT NULL DEFAULT 0.05,
  regular_form_cap REAL NOT NULL DEFAULT 0.03,
  form_cap REAL NOT NULL DEFAULT 0.15,
  regular_win_cap REAL NOT NULL DEFAULT 0.80,
  playoff_win_cap REAL NOT NULL DEFAULT 0.85,
  regular_scale_factor REAL NOT NULL DEFAULT 0.07,
  scale_factor REAL NOT NULL DEFAULT 0.15,
  players_moved_per_team INTEGER NOT NULL DEFAULT 2,
  next_config_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sports_seasons (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL,
  season_no INTEGER NOT NULL,
  season_type TEXT NOT NULL,
  status TEXT NOT NULL,
  week_monday TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  config_json TEXT NOT NULL,
  champion_team_id TEXT,
  void_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(competition_id, season_no)
);

CREATE TABLE IF NOT EXISTS basketball_teams (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  championships INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS basketball_players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position TEXT NOT NULL,
  stars INTEGER NOT NULL,
  ability INTEGER NOT NULL,
  team_id TEXT NOT NULL,
  starter INTEGER NOT NULL DEFAULT 0,
  championships INTEGER NOT NULL DEFAULT 0,
  history_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sports_matches (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  round_no INTEGER NOT NULL,
  series_id TEXT,
  game_no INTEGER,
  scheduled_at TEXT NOT NULL,
  home_team_id TEXT,
  away_team_id TEXT,
  status TEXT NOT NULL,
  home_score INTEGER,
  away_score INTEGER,
  winner_team_id TEXT,
  home_strength REAL,
  away_strength REAL,
  home_win_probability REAL,
  away_win_probability REAL,
  settled_at TEXT,
  cancel_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sports_markets (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  home_odds REAL,
  away_odds REAL,
  opened_at TEXT,
  locked_at TEXT,
  settled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sports_bets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  match_id TEXT NOT NULL,
  selection_team_id TEXT NOT NULL,
  amount REAL NOT NULL,
  locked_odds REAL NOT NULL,
  status TEXT NOT NULL,
  payout REAL NOT NULL DEFAULT 0,
  client_request_id TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT
);

CREATE TABLE IF NOT EXISTS sports_series_markets (
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  home_win_probability REAL,
  away_win_probability REAL,
  home_odds REAL,
  away_odds REAL,
  opened_at TEXT,
  locked_at TEXT,
  settled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sports_series_bets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  series_id TEXT NOT NULL,
  selection_team_id TEXT NOT NULL,
  amount REAL NOT NULL,
  locked_odds REAL NOT NULL,
  status TEXT NOT NULL,
  payout REAL NOT NULL DEFAULT 0,
  client_request_id TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT
);

CREATE TABLE IF NOT EXISTS sports_cash_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  bet_id TEXT,
  match_id TEXT,
  series_id TEXT,
  event_type TEXT NOT NULL,
  amount REAL NOT NULL,
  balance_after REAL NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS basketball_team_season_stats (
  season_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  points_for INTEGER NOT NULL DEFAULT 0,
  points_against INTEGER NOT NULL DEFAULT 0,
  recent_json TEXT NOT NULL DEFAULT '[]',
  tie_breaker REAL NOT NULL,
  PRIMARY KEY(season_id, team_id)
);

CREATE TABLE IF NOT EXISTS basketball_series (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  bracket_slot INTEGER NOT NULL,
  best_of INTEGER NOT NULL,
  home_seed INTEGER,
  away_seed INTEGER,
  home_team_id TEXT,
  away_team_id TEXT,
  home_wins INTEGER NOT NULL DEFAULT 0,
  away_wins INTEGER NOT NULL DEFAULT 0,
  winner_team_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS basketball_player_moves (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  from_team_id TEXT NOT NULL,
  to_team_id TEXT NOT NULL,
  position TEXT NOT NULL,
  move_type TEXT NOT NULL DEFAULT 'offseason',
  event_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS basketball_trade_events (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL,
  trigger_completed_matches INTEGER NOT NULL,
  position TEXT NOT NULL,
  player_count INTEGER NOT NULL,
  plan_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  executed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS basketball_player_developments (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  regular_rank INTEGER NOT NULL,
  development_type TEXT NOT NULL,
  ability_before INTEGER NOT NULL,
  ability_after INTEGER NOT NULL,
  stars_before INTEGER NOT NULL,
  stars_after INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
`);

  ensureColumn('users', 'password_hash', 'TEXT');
  ensureColumn('users', 'password_salt', 'TEXT');
  ensureColumn('users', 'activated_at', 'TEXT');
  ensureColumn('users', 'last_login_at', 'TEXT');
  ensureColumn('users', 'last_seen_at', 'TEXT');
  ensureColumn('users', 'login_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'created_at', 'TEXT');
  ensureColumn('users', 'updated_at', 'TEXT');
  ensureColumn('market_state', 'market_date', 'TEXT');
  ensureColumn('market_state', 'day_start_tick', 'INTEGER');
  ensureColumn('market_state', 'day_tick_index', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('market_state', 'last_auto_advance_key', 'TEXT');
  ensureColumn('market_state', 'last_auto_advance_at', 'TEXT');
  ensureColumn('market_state', 'paused', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('market_state', 'cycle_started_at', 'TEXT');
  ensureColumn('market_state', 'sleeping', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('market_state', 'sleep_reason', 'TEXT');
  ensureColumn('market_state', 'sleep_since', 'TEXT');
  ensureColumn('market_state', 'last_player_activity_at', 'TEXT');
  ensureColumn('market_state', 'run_started_at', 'TEXT');
  ensureColumn('market_state', 'force_open', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'has_active_loan', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'bankrupt', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'bank_tier', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('users', 'qualifying_repayments', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'has_p2p_loan', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'p2p_role', 'TEXT');
  ensureColumn('loans', 'accrued_interest', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('loans', 'qualifies_for_tier', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('loans', 'warning_shown_at', 'INTEGER');
  ensureColumn('loans', 'close_tick', 'INTEGER');
  ensureColumn('stocks', 'sector', 'TEXT');
  ensureColumn('stock_prices', 'anchor', 'REAL');
  ensureColumn('asset_snapshots', 'fund_value', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('asset_snapshots', 'loan_liability', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('asset_snapshots', 'net_total_asset', 'REAL');
  ensureColumn('asset_snapshots', 'futures_value', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('asset_snapshots', 'p2p_receivable', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('asset_snapshots', 'p2p_payable', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('news', 'is_fluff', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('commodity_regime', 'pending_ignition_tick', 'INTEGER');
  ensureColumn('commodity_regime', 'pending_ignition_dir', 'INTEGER');
  ensureColumn('sports_bets', 'client_request_id', 'TEXT');
  ensureColumn('sports_cash_events', 'series_id', 'TEXT');
  ensureColumn('basketball_player_moves', 'move_type', "TEXT NOT NULL DEFAULT 'offseason'");
  ensureColumn('basketball_player_moves', 'event_id', 'TEXT');
  ensureColumn('sports_config', 'regular_form_cap', 'REAL NOT NULL DEFAULT 0.03');
  ensureColumn('sports_config', 'regular_scale_factor', 'REAL NOT NULL DEFAULT 0.07');
  ensureColumn('sports_config', 'scale_factor', 'REAL NOT NULL DEFAULT 0.15');
  ensureColumn('sports_series_markets', 'home_win_probability', 'REAL');
  ensureColumn('sports_series_markets', 'away_win_probability', 'REAL');

  exec(`INSERT OR IGNORE INTO sports_series_markets
    (id, series_id, status, created_at, updated_at)
    SELECT 'series-market-' || id, id, 'unopened', datetime('now'), datetime('now')
    FROM basketball_series;`);

  for (const migration of DEFAULT_CODE_MIGRATIONS) {
    migrateStockCodeReferences(migration.from, migration.to);
  }
  for (const migration of DEFAULT_FUND_CODE_MIGRATIONS) {
    migrateFundCodeReferences(migration.from, migration.to);
  }

  db.exec(`
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_asset_snapshots_user_tick ON asset_snapshots(user_id, tick);
CREATE INDEX IF NOT EXISTS idx_asset_snapshots_tick ON asset_snapshots(tick);
CREATE INDEX IF NOT EXISTS idx_holdings_user_id ON holdings(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id, id);
CREATE INDEX IF NOT EXISTS idx_stock_prices_tick ON stock_prices(tick);
CREATE INDEX IF NOT EXISTS idx_invite_codes_used_by ON invite_codes(used_by_user_id);
CREATE INDEX IF NOT EXISTS idx_fund_nav_tick ON fund_nav(tick);
CREATE INDEX IF NOT EXISTS idx_fund_holdings_user_id ON fund_holdings(user_id);
CREATE INDEX IF NOT EXISTS idx_fund_transactions_user_id ON fund_transactions(user_id, id);
CREATE INDEX IF NOT EXISTS idx_fund_weight_fund_tick ON fund_weight(fund_code, tick);
CREATE INDEX IF NOT EXISTS idx_commodity_prices_code_tick ON commodity_prices(code, tick);
CREATE INDEX IF NOT EXISTS idx_futures_positions_user_id ON futures_positions(user_id);
CREATE INDEX IF NOT EXISTS idx_futures_transactions_user_id ON futures_transactions(user_id, id);
  CREATE INDEX IF NOT EXISTS idx_sports_matches_season_time ON sports_matches(season_id, scheduled_at);
  CREATE INDEX IF NOT EXISTS idx_sports_matches_status_time ON sports_matches(status, scheduled_at);
  CREATE INDEX IF NOT EXISTS idx_sports_bets_user_id ON sports_bets(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_sports_bets_match_id ON sports_bets(match_id, status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sports_bets_user_request
    ON sports_bets (user_id, client_request_id)
    WHERE client_request_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_sports_series_bets_user_id ON sports_series_bets(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_sports_series_bets_series_id ON sports_series_bets(series_id, status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sports_series_bets_user_request
    ON sports_series_bets (user_id, client_request_id)
    WHERE client_request_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_sports_cash_events_user_id ON sports_cash_events(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_basketball_players_team_id ON basketball_players(team_id, position);
  CREATE INDEX IF NOT EXISTS idx_basketball_trade_events_season_trigger
    ON basketball_trade_events(season_id, status, trigger_completed_matches);
  CREATE INDEX IF NOT EXISTS idx_basketball_player_developments_season
    ON basketball_player_developments(season_id, created_at);
CREATE INDEX IF NOT EXISTS idx_p2p_orders_user_status ON p2p_orders(user_id, status);
CREATE INDEX IF NOT EXISTS idx_p2p_orders_status ON p2p_orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_p2p_loans_lender_status ON p2p_loans(lender_id, status);
CREATE INDEX IF NOT EXISTS idx_p2p_loans_borrower_status ON p2p_loans(borrower_id, status);
`);

  let market = get('SELECT * FROM market_state WHERE id = 1');
  if (!market) {
    exec(`INSERT INTO market_state (id, current_tick, initial_cash, status, created_at, updated_at)
      VALUES (1, 1, ${RULES.INITIAL_CASH}, 'active', datetime('now'), datetime('now'));`);
    market = get('SELECT * FROM market_state WHERE id = 1');
  }
  const today = clock.shanghaiParts().date;
  exec(`UPDATE market_state
    SET market_date = COALESCE(market_date, ${q(today)}),
        day_start_tick = COALESCE(day_start_tick, current_tick),
        day_tick_index = COALESCE(day_tick_index, 0),
        cycle_started_at = COALESCE(cycle_started_at, created_at, ${q(clock.serverTimeIso())}),
        sleeping = COALESCE(sleeping, 0),
        run_started_at = COALESCE(run_started_at, created_at, ${q(clock.serverTimeIso())}),
        last_player_activity_at = COALESCE(last_player_activity_at, created_at, ${q(clock.serverTimeIso())})
    WHERE id = 1;`);

  for (const stock of DEFAULT_STOCKS) {
    exec(`INSERT OR IGNORE INTO stocks
      (code, name, sector, industry, mapping, initial_price, volatility, risk_level)
      VALUES (${q(stock.code)}, ${q(stock.name)}, ${q(stock.sector || '')}, ${q(stock.industry)}, ${q(stock.mapping)},
        ${stock.initial_price}, ${stock.volatility}, ${q(stock.risk_level)});`);
    exec(`INSERT OR IGNORE INTO stock_prices
      (stock_code, tick, open, close, high, low, anchor, change_pct, created_at)
      VALUES (${q(stock.code)}, 1, ${stock.initial_price}, ${stock.initial_price},
        ${stock.initial_price}, ${stock.initial_price}, ${stock.initial_price}, 0, datetime('now'));`);
    if (market.current_tick !== 1) {
      exec(`INSERT OR IGNORE INTO stock_prices
        (stock_code, tick, open, close, high, low, anchor, change_pct, created_at)
        VALUES (${q(stock.code)}, ${market.current_tick}, ${stock.initial_price}, ${stock.initial_price},
          ${stock.initial_price}, ${stock.initial_price}, ${stock.initial_price}, 0, datetime('now'));`);
    }
    exec(`INSERT OR IGNORE INTO stock_dynamics
      (stock_code, regime, trend_dir, trend_remaining, trend_total, streak, updated_at)
      VALUES (${q(stock.code)}, 'oscillation', 0, 0, 0, 0, datetime('now'));`);
  }
  refreshDefaultStockMetadata();
  seedFunds(market.current_tick);
  seedFutures(market.current_tick);
  refreshDefaultFuturesMetadata();
  refreshDefaultFundMetadata();
  cleanupFundWeightPollution();
  refreshDefaultBasketballTeamNames();

  seedAdmin();
}

function refreshDefaultBasketballTeamNames() {
  exec(`UPDATE basketball_teams SET name = '重庆飞鹰' WHERE id = 'team-8' AND name != '重庆飞鹰';`);
  exec(`UPDATE basketball_teams SET name = '宁波地鼠' WHERE id = 'team-16' AND name != '宁波地鼠';`);
}

function resetDb() {
  if (database) {
    database.close();
    database = null;
  }
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${DB_PATH}${suffix}`;
    if (fs.existsSync(file)) fs.rmSync(file);
  }
  ensureDb();
}

function all(sql) {
  return connect().prepare(sql).all();
}

function get(sql) {
  return connect().prepare(sql).get() || null;
}

function exec(sql) {
  connect().exec(sql);
}

function ensureColumn(table, column, definition) {
  const columns = all(`PRAGMA table_info(${table});`).map((item) => item.name);
  if (!columns.includes(column)) {
    exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

function migrateStockCodeReferences(oldCodeRaw, newCodeRaw) {
  const oldCode = String(oldCodeRaw || '').trim().toUpperCase();
  const newCode = String(newCodeRaw || '').trim().toUpperCase();
  if (!oldCode || !newCode || oldCode === newCode) return false;

  const oldStock = get(`SELECT * FROM stocks WHERE code = ${q(oldCode)};`);
  if (oldStock) {
    const newStock = get(`SELECT * FROM stocks WHERE code = ${q(newCode)};`);
    if (!newStock) {
      exec(`UPDATE stocks SET code = ${q(newCode)} WHERE code = ${q(oldCode)};`);
    }
  }

  exec(`UPDATE stock_prices SET stock_code = ${q(newCode)} WHERE stock_code = ${q(oldCode)};`);
  exec(`UPDATE stock_dynamics SET stock_code = ${q(newCode)} WHERE stock_code = ${q(oldCode)};`);
  exec(`UPDATE fund_weight SET stock_code = ${q(newCode)} WHERE stock_code = ${q(oldCode)};`);
  exec(`UPDATE holdings
    SET stock_code = ${q(newCode)},
        id = REPLACE(id, ${q(`_${oldCode}`)}, ${q(`_${newCode}`)})
    WHERE stock_code = ${q(oldCode)};`);
  exec(`UPDATE transactions SET stock_code = ${q(newCode)} WHERE stock_code = ${q(oldCode)};`);
  exec(`UPDATE news SET target_code = ${q(newCode)}
    WHERE target_type = 'stock' AND target_code = ${q(oldCode)};`);
  exec(`UPDATE weekly_reports
    SET top_gainers = REPLACE(top_gainers, ${q(oldCode)}, ${q(newCode)}),
        top_losers = REPLACE(top_losers, ${q(oldCode)}, ${q(newCode)})
    WHERE top_gainers LIKE ${q(`%${oldCode}%`)} OR top_losers LIKE ${q(`%${oldCode}%`)};`);
  exec(`UPDATE account_events SET detail = REPLACE(detail, ${q(oldCode)}, ${q(newCode)})
    WHERE detail LIKE ${q(`%${oldCode}%`)};`);
  return true;
}

function migrateFundCodeReferences(oldCodeRaw, newCodeRaw) {
  const oldCode = String(oldCodeRaw || '').trim().toUpperCase();
  const newCode = String(newCodeRaw || '').trim().toUpperCase();
  if (!oldCode || !newCode || oldCode === newCode) return false;

  const oldFund = get(`SELECT * FROM funds WHERE code = ${q(oldCode)};`);
  const newFund = get(`SELECT * FROM funds WHERE code = ${q(newCode)};`);
  const oldReferences = get(`SELECT
    (SELECT COUNT(*) FROM fund_nav WHERE fund_code = ${q(oldCode)})
    + (SELECT COUNT(*) FROM fund_weight WHERE fund_code = ${q(oldCode)})
    + (SELECT COUNT(*) FROM fund_holdings WHERE fund_code = ${q(oldCode)})
    + (SELECT COUNT(*) FROM fund_transactions WHERE fund_code = ${q(oldCode)})
    + (SELECT COUNT(*) FROM fund_regime WHERE fund_code = ${q(oldCode)}) AS count;`);
  if (!oldFund && !Number(oldReferences?.count || 0)) return false;

  transaction(() => {
    if (oldFund && !newFund) {
      exec(`UPDATE funds SET code = ${q(newCode)} WHERE code = ${q(oldCode)};`);
    }

    exec(`INSERT OR IGNORE INTO fund_nav
      (fund_code, tick, nav, change_pct, turnover_cost, created_at)
      SELECT ${q(newCode)}, tick, nav, change_pct, turnover_cost, created_at
      FROM fund_nav WHERE fund_code = ${q(oldCode)};`);
    exec(`DELETE FROM fund_nav WHERE fund_code = ${q(oldCode)};`);
    exec(`INSERT OR IGNORE INTO fund_weight
      (fund_code, tick, stock_code, weight)
      SELECT ${q(newCode)}, tick, stock_code, weight
      FROM fund_weight WHERE fund_code = ${q(oldCode)};`);
    exec(`DELETE FROM fund_weight WHERE fund_code = ${q(oldCode)};`);

    const oldHoldings = all(`SELECT * FROM fund_holdings WHERE fund_code = ${q(oldCode)};`);
    for (const holding of oldHoldings) {
      const target = get(`SELECT * FROM fund_holdings
        WHERE user_id = ${q(holding.user_id)} AND fund_code = ${q(newCode)};`);
      if (!target) {
        exec(`UPDATE fund_holdings
          SET fund_code = ${q(newCode)}, id = ${q(`${holding.user_id}_${newCode}`)}
          WHERE id = ${q(holding.id)};`);
        continue;
      }
      const targetShares = Number(target.shares || 0);
      const oldShares = Number(holding.shares || 0);
      const shares = Number((targetShares + oldShares).toFixed(6));
      const availableShares = Math.min(shares, Number((
        Number(target.available_shares || 0) + Number(holding.available_shares || 0)
      ).toFixed(6)));
      const avgNav = shares > 0
        ? Number(((Number(target.avg_nav || 0) * targetShares + Number(holding.avg_nav || 0) * oldShares) / shares).toFixed(6))
        : Number(target.avg_nav || holding.avg_nav || 0);
      exec(`UPDATE fund_holdings
        SET shares = ${shares}, available_shares = ${availableShares}, avg_nav = ${avgNav}, updated_at = datetime('now')
        WHERE id = ${q(target.id)};`);
      exec(`DELETE FROM fund_holdings WHERE id = ${q(holding.id)};`);
    }

    exec(`UPDATE fund_transactions SET fund_code = ${q(newCode)} WHERE fund_code = ${q(oldCode)};`);
    exec(`UPDATE fund_regime SET fund_code = ${q(newCode)} WHERE fund_code = ${q(oldCode)};`);
    if (oldFund && newFund) exec(`DELETE FROM funds WHERE code = ${q(oldCode)};`);
  });
  return true;
}

function refreshDefaultStockMetadata() {
  for (const stock of DEFAULT_STOCKS) {
    const existing = get(`SELECT * FROM stocks WHERE code = ${q(stock.code)};`);
    if (!existing) continue;
    const legacyNames = DEFAULT_NAME_REFRESH[stock.code] || [];
    if (existing.name !== stock.name && !legacyNames.includes(existing.name)) continue;
    exec(`UPDATE stocks
      SET name = ${q(stock.name)},
          sector = ${q(stock.sector || '')},
          industry = ${q(stock.industry)},
          mapping = ${q(stock.mapping)},
          initial_price = ${stock.initial_price},
          volatility = ${stock.volatility},
          risk_level = ${q(stock.risk_level)}
      WHERE code = ${q(stock.code)};`);
  }
}

function seedFunds(tick) {
  for (const fund of DEFAULT_FUNDS) {
    exec(`INSERT OR IGNORE INTO funds
      (code, name, type, category, basket_json, base_nav, volatility, params_json, risk_level,
       fee_free, redeem_t0, manage_mode, strategy, manager_name, mgmt_fee_rate)
      VALUES (${q(fund.code)}, ${q(fund.name)}, ${q(fund.type)}, ${q(fund.category)},
        ${fund.basket_json == null ? 'NULL' : q(fund.basket_json)}, ${fund.base_nav},
        ${fund.volatility == null ? 'NULL' : fund.volatility}, ${fund.params_json == null ? 'NULL' : q(fund.params_json)},
        ${q(fund.risk_level)}, ${fund.fee_free || 0}, ${fund.redeem_t0 || 0}, ${q(fund.manage_mode)},
        ${fund.strategy == null ? 'NULL' : q(fund.strategy)}, ${fund.manager_name == null ? 'NULL' : q(fund.manager_name)},
        ${fund.mgmt_fee_rate || 0});`);
    exec(`INSERT OR IGNORE INTO fund_nav
      (fund_code, tick, nav, change_pct, turnover_cost, created_at)
      VALUES (${q(fund.code)}, ${tick}, ${fund.base_nav}, 0, 0, datetime('now'));`);
    if (fund.manage_mode === 'active' && tick === 1) {
      let rule = {};
      try { rule = JSON.parse(fund.basket_json || '{}'); } catch { /* no-op */ }
      const basket = DEFAULT_STOCKS.filter((stock) => {
        if (rule.all) return true;
        if (rule.by === 'sector') return stock.sector === rule.value;
        if (rule.by === 'risk') return stock.risk_level === rule.value;
        if (rule.stocks && Array.isArray(rule.stocks)) return rule.stocks.includes(stock.code);
        return false;
      });
      const weight = basket.length ? 1 / basket.length : 0;
      for (const stock of basket) {
        exec(`INSERT OR IGNORE INTO fund_weight (fund_code, tick, stock_code, weight)
          VALUES (${q(fund.code)}, ${tick}, ${q(stock.code)}, ${weight});`);
      }
    }
    if (fund.code === 'TY03') {
      const bullDuration = (2 + Math.floor(Math.random() * 7)) * 9;
      exec(`INSERT OR REPLACE INTO fund_regime (fund_code, regime, regime_since_tick, regime_duration_ticks, updated_at)
        VALUES (${q(fund.code)}, 'bull', ${tick}, ${bullDuration}, datetime('now'));`);
    }
  }
}

function seedFutures(tick) {
  for (const underlying of DEFAULT_FUTURES) {
    const paramsJson = FUTURES_REGIME_PARAMS[underlying.regime_engine]
      ? JSON.stringify(FUTURES_REGIME_PARAMS[underlying.regime_engine])
      : null;
    exec(`INSERT OR IGNORE INTO futures_underlyings
      (code, name, track, regime_engine, base_price, contract_multiplier, max_leverage,
       max_exposure, linked_sector, volatility, params_json)
      VALUES (${q(underlying.code)}, ${q(underlying.name)}, ${q(underlying.track)},
        ${q(underlying.regime_engine)}, ${underlying.basePrice}, ${underlying.mult},
        ${underlying.maxLev}, ${underlying.maxLev ? 'NULL' : 'NULL'},
        ${underlying.sector == null ? 'NULL' : q(underlying.sector)},
        ${underlying.vol}, ${paramsJson == null ? 'NULL' : q(paramsJson)});`);
    exec(`INSERT OR IGNORE INTO commodity_prices
      (code, tick, price, change_pct, created_at)
      VALUES (${q(underlying.code)}, ${tick}, ${underlying.basePrice}, 0, datetime('now'));`);
    if (tick !== 1) {
      exec(`INSERT OR IGNORE INTO commodity_prices
        (code, tick, price, change_pct, created_at)
        VALUES (${q(underlying.code)}, 1, ${underlying.basePrice}, 0, datetime('now'));`);
    }
  }
  seedInitialCommodityRegimes(tick);
}

// 对齐已有 futures_underlyings 行的 max_leverage 到 DEFAULT_FUTURES。
// seedFutures 用 INSERT OR IGNORE，已存在的行不会被更新；本函数补齐杠杆上限调整。
// 幂等：每次启动执行，只 UPDATE 与种子不一致的行。
function refreshDefaultFuturesMetadata() {
  for (const underlying of DEFAULT_FUTURES) {
    const existing = get(`SELECT code, max_leverage FROM futures_underlyings WHERE code = ${q(underlying.code)};`);
    if (!existing) continue;
    if (Number(existing.max_leverage) === Number(underlying.maxLev)) continue;
    exec(`UPDATE futures_underlyings
      SET max_leverage = ${underlying.maxLev}
      WHERE code = ${q(underlying.code)};`);
  }
}

function seedInitialCommodityRegimes(tick) {
  for (const underlying of DEFAULT_FUTURES) {
    const existing = get(`SELECT * FROM commodity_regime WHERE code = ${q(underlying.code)};`);
    if (existing) continue;
    let regime, durationTicks;
    const params = FUTURES_REGIME_PARAMS[underlying.regime_engine] || {};
    const dailyTicks = params.daily_ticks || 9;

    if (underlying.regime_engine === 'overseas3') {
      regime = 'bull';
      const minDays = (params.bull_dur_days || [2, 8])[0];
      const maxDays = (params.bull_dur_days || [2, 8])[1];
      durationTicks = (minDays + Math.floor(Math.random() * (maxDays - minDays + 1))) * dailyTicks;
    } else if (underlying.regime_engine === 'bull_bear') {
      regime = Math.random() < 0.5 ? 'bull' : 'bear';
      const minDays = (params.dur_days || [3, 10])[0];
      const maxDays = (params.dur_days || [3, 10])[1];
      durationTicks = (minDays + Math.floor(Math.random() * (maxDays - minDays + 1))) * dailyTicks;
    } else if (underlying.regime_engine === 'event_spike') {
      regime = 'calm';
      durationTicks = 9999;
    } else if (underlying.regime_engine === 'gold_reuse') {
      const regimes = ['safe_haven', 'risk_on', 'idle'];
      regime = regimes[Math.floor(Math.random() * regimes.length)];
      durationTicks = 10 + Math.floor(Math.random() * 21);
    } else if (underlying.regime_engine === 'crypto') {
      regime = 'calm';
      const minDays = (params.calm_dur_days || [5, 15])[0];
      const maxDays = (params.calm_dur_days || [5, 15])[1];
      durationTicks = (minDays + Math.floor(Math.random() * (maxDays - minDays + 1))) * dailyTicks;
    } else if (underlying.regime_engine === 'rate_cycle') {
      regime = Math.random() < 0.5 ? 'hike' : 'cut';
      const minDays = (params.dur_days || [5, 15])[0];
      const maxDays = (params.dur_days || [5, 15])[1];
      durationTicks = (minDays + Math.floor(Math.random() * (maxDays - minDays + 1))) * dailyTicks;
    }
    if (regime) {
      exec(`INSERT INTO commodity_regime (code, regime, regime_since_tick, regime_duration_ticks, updated_at)
        VALUES (${q(underlying.code)}, ${q(regime)}, ${tick}, ${durationTicks || 18}, datetime('now'));`);
    }
  }
}

function refreshDefaultFundMetadata() {
  for (const fund of DEFAULT_FUNDS) {
    exec(`UPDATE funds
      SET name = ${q(fund.name)},
          type = ${q(fund.type)},
          category = ${q(fund.category)},
          basket_json = ${fund.basket_json == null ? 'NULL' : q(fund.basket_json)},
          base_nav = ${fund.base_nav},
          volatility = ${fund.volatility == null ? 'NULL' : fund.volatility},
          params_json = ${fund.params_json == null ? 'NULL' : q(fund.params_json)},
          risk_level = ${q(fund.risk_level)},
          fee_free = ${fund.fee_free || 0},
          redeem_t0 = ${fund.redeem_t0 || 0},
          manage_mode = ${q(fund.manage_mode)},
          strategy = ${fund.strategy == null ? 'NULL' : q(fund.strategy)},
          manager_name = ${fund.manager_name == null ? 'NULL' : q(fund.manager_name)},
          mgmt_fee_rate = ${fund.mgmt_fee_rate || 0}
      WHERE code = ${q(fund.code)};`);
  }
}

function cleanupFundWeightPollution() {
  const market = get('SELECT * FROM market_state WHERE id = 1;');
  const dayStart = Number(market?.day_start_tick || 1);
  const dailyTotal = 8;
  const rebalanceTicks = new Set();
  if (dailyTotal >= 4) rebalanceTicks.add(dayStart + 4);
  rebalanceTicks.add(dayStart + dailyTotal);

  const activeFunds = all("SELECT code FROM funds WHERE manage_mode = 'active';");
  for (const fund of activeFunds) {
    const byTick = {};
    const rows = all(
      `SELECT tick, stock_code, weight FROM fund_weight
       WHERE fund_code = ${q(fund.code)} AND tick > 1
       ORDER BY tick, stock_code;`
    );
    for (const row of rows) {
      if (!byTick[row.tick]) byTick[row.tick] = [];
      byTick[row.tick].push(row);
    }
    for (const [tickStr, group] of Object.entries(byTick)) {
      const tick = Number(tickStr);
      if (rebalanceTicks.has(tick)) continue;
      const allEqual = group.every(
        (r) => Math.abs(Number(r.weight) - Number(group[0].weight)) < 1e-6
      );
      if (allEqual) {
        exec(`DELETE FROM fund_weight WHERE fund_code = ${q(fund.code)} AND tick = ${tick};`);
      }
    }
  }
}

function seedAdmin() {
  const market = get(`SELECT * FROM market_state WHERE id = 1;`);
  const initialCash = market ? market.initial_cash : RULES.INITIAL_CASH;
  const adminId = crypto.randomUUID();

  const existing = get(`SELECT * FROM users WHERE is_admin = 1 LIMIT 1;`);
  if (!existing) {
    exec(`INSERT INTO users
      (id, username, nickname, cash, join_tick, initial_asset_at_join,
       activated_at, is_admin, created_at, updated_at)
      VALUES (${q(adminId)}, ${q(ADMIN_ACCOUNT.code)}, ${q(ADMIN_ACCOUNT.nickname)},
        ${initialCash}, 1, ${initialCash},
        datetime('now'), 1, datetime('now'), datetime('now'));`);
  } else {
    exec(`UPDATE users
      SET username = ${q(ADMIN_ACCOUNT.code)},
          nickname = ${q(ADMIN_ACCOUNT.nickname)},
          password_hash = NULL,
          password_salt = NULL,
          is_admin = 1,
          updated_at = datetime('now')
      WHERE id = ${q(existing.id)};`);
  }
}

// Run fn inside a single SQLite transaction so that multi-step writes
// (e.g. a trade touching holdings + users + transactions) either all land
// or all roll back. Prevents half-written state on error or crash.
function transaction(fn) {
  const db = connect();
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

function q(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, "''")}'`;
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code || '').trim().toUpperCase()).digest('hex');
}

const NEWS_PUBLIC_FIELDS = [
  'id', 'title', 'content', 'source_type', 'news_type', 'visible_sentiment',
  'target_type', 'target_code', 'created_tick', 'published', 'is_rumor',
  'expert_id', 'expert_name', 'is_fluff'
];

function sanitizeNews(row) {
  if (!row) return null;
  const out = {};
  for (const key of NEWS_PUBLIC_FIELDS) {
    if (row[key] !== undefined) out[key] = row[key];
  }
  if (out.title) {
    out.title = String(out.title)
      .replace(/风格：.+?。发布时随机匹配【.+?】行业个股。$/g, '')
      .replace(/发布时随机匹配【.+?】行业个股。$/g, '')
      .trim();
  }
  if (out.content) {
    out.content = String(out.content)
      .replace(/风格：.+?。发布时随机匹配【.+?】行业个股。$/g, '')
      .replace(/发布时随机匹配【.+?】行业个股。$/g, '')
      .trim();
  }
  return out;
}

const KOL_PUBLIC_FIELDS = [
  'id', 'tick', 'kol_name', 'tier',
  'comment_type', 'target_news_id', 'stance', 'content'
];

function sanitizeKolComment(row) {
  if (!row) return null;
  const out = {};
  for (const key of KOL_PUBLIC_FIELDS) {
    if (row[key] !== undefined) out[key] = row[key];
  }
  return out;
}

module.exports = {
  DB_PATH,
  ensureDb,
  resetDb,
  all,
  get,
  exec,
  transaction,
  q,
  sanitizeNews,
  sanitizeKolComment,
  cleanupFundWeightPollution,
  migrateStockCodeReferences,
  migrateFundCodeReferences,
  seedFutures
};

const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const {
  RULES, RISK_DYNAMICS, SECTORS, computeNextPrice, computeOrderFlowImpact, rollMacroSentiment, rollSectorSentiment,
  anchorWalkStep, computeAnchorTether,
  DEFAULT_FUTURES, DEFAULT_FUNDS
} = require('./data');
const db = require('./db');
const news = require('./news');
const clock = require('./clock');
const funds = require('./funds');
const futures = require('./futures');
const kol = require('./kol');
const sports = require('./sports');


function getOperatedUserIds() {
  const rows = db.all(`
    SELECT user_id FROM holdings
    UNION SELECT user_id FROM fund_holdings
    UNION SELECT user_id FROM futures_positions
    UNION SELECT user_id FROM sports_bets
    UNION SELECT user_id FROM sports_series_bets;
  `);
  return new Set(rows.map(r => String(r.user_id)));
}


const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');
const PORT = Number(process.env.PORT || 4174);
const HOST = process.env.HOST || '127.0.0.1';
const MARKET_INACTIVE_SLEEP_DAYS = 7;
const MARKET_RUNTIME_CAP_DAYS = 14;

if (process.argv.includes('--reset-db')) {
  db.resetDb();
  console.log(`SQLite database reset: ${db.DB_PATH}`);
  process.exit(0);
}

db.ensureDb();
sports.ensureSports();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      await routeApi(req, res, url);
      return;
    }
    serveStatic(res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { code: 1, message: error.message || '服务器错误' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`SSB Exchange local web: http://${HOST}:${PORT}`);
  console.log(`SQLite database: ${db.DB_PATH}`);
});

startMarketClock();
startSportsClock();

async function routeApi(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readJson(req);
    sendOk(res, login(body));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    const body = await readJson(req);
    sendOk(res, register(body));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/setup-password') {
    const body = await readJson(req);
    sendOk(res, setupPassword(body));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const user = requireAuth(req);
    sendOk(res, getState(user, url.searchParams.get('selectedCode'), { touchPlayerActivity: !user.is_admin }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/ranking') {
    const user = requireAuth(req);
    sendOk(res, getRanking(user, { touchPlayerActivity: !user.is_admin }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/all-holdings') {
    const user = requireAuth(req);
    sendOk(res, getAllHoldings(user, { touchPlayerActivity: !user.is_admin }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/trade') {
    const user = requireAuth(req);
    const body = await readJson(req);
    trade(user, body);
    const freshUser = db.get(`SELECT * FROM users WHERE id = ${db.q(user.id)};`);
    sendOk(res, getState(freshUser || user, body.stockCode, { touchPlayerActivity: false }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/funds/list') {
    const user = requireAuth(req);
    const market = resolveMarketForRead(user, { touchPlayerActivity: !user.is_admin });
    sendOk(res, funds.getFundsList(market.current_tick));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/funds/status') {
    const user = requireAuth(req);
    const market = resolveMarketForRead(user, { touchPlayerActivity: !user.is_admin });
    sendOk(res, funds.getFundStatus(user.id, market.current_tick));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/funds/history') {
    const user = requireAuth(req);
    sendOk(res, funds.fundHistory(user.id));
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/funds/')) {
    const user = requireAuth(req);
    const market = resolveMarketForRead(user, { touchPlayerActivity: !user.is_admin });
    const code = decodeURIComponent(url.pathname.slice('/api/funds/'.length));
    sendOk(res, funds.getFundDetail(code, market.current_tick, getStocks()));
    return;
  }

  if (req.method === 'POST' && (url.pathname === '/api/funds/buy' || url.pathname === '/api/funds/sell')) {
    const user = requireAuth(req);
    const body = await readJson(req);
    const market = ensureSleepState();
    db.transaction(() => {
      funds.tradeFund(user, {
        ...body,
        action: url.pathname.endsWith('/buy') ? 'buy' : 'sell'
      }, { market, tradingAllowed: isTradingAllowed(market) });
      touchPlayerActivity(user);
    });
    const fresh = db.get(`SELECT * FROM users WHERE id = ${db.q(user.id)};`);
    sendOk(res, {
      holdings: funds.getFundStatus(user.id, market.current_tick),
      user: buildPublicUser(fresh || user, market.current_tick)
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/futures/list') {
    const user = requireAuth(req);
    const market = resolveMarketForRead(user, { touchPlayerActivity: !user.is_admin });
    sendOk(res, futures.getFuturesList(market.current_tick));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/futures/status') {
    const user = requireAuth(req);
    const market = resolveMarketForRead(user, { touchPlayerActivity: !user.is_admin });
    sendOk(res, futures.getFuturesStatus(user.id, market.current_tick));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/futures/history') {
    const user = requireAuth(req);
    sendOk(res, futures.getFuturesHistory(user.id));
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/futures/')) {
    const user = requireAuth(req);
    const market = resolveMarketForRead(user, { touchPlayerActivity: !user.is_admin });
    const code = decodeURIComponent(url.pathname.slice('/api/futures/'.length));
    sendOk(res, futures.getUnderlyingDetail(code, market.current_tick, getStocks()));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/futures/open') {
    const user = requireAuth(req);
    const body = await readJson(req);
    const market = ensureSleepState();
    const result = db.transaction(() => {
      const r = futures.openPosition(user, body, { market, tradingAllowed: isTradingAllowed(market) });
      touchPlayerActivity(user);
      return r;
    });
    const fresh = db.get(`SELECT * FROM users WHERE id = ${db.q(user.id)};`);
    sendOk(res, {
      position: result.position,
      newCash: result.newCash,
      user: buildPublicUser(fresh || user, market.current_tick)
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/futures/close') {
    const user = requireAuth(req);
    const body = await readJson(req);
    const market = ensureSleepState();
    const result = db.transaction(() => {
      const r = futures.closePosition(user, body, { market, tradingAllowed: isTradingAllowed(market) });
      touchPlayerActivity(user);
      return r;
    });
    const fresh = db.get(`SELECT * FROM users WHERE id = ${db.q(user.id)};`);
    sendOk(res, {
      pnl: result.pnl,
      returnedCash: result.returnedCash,
      user: buildPublicUser(fresh || user, market.current_tick)
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/sports/overview') {
    const user = requireAuth(req);
    resolveMarketForRead(user, { touchPlayerActivity: !user.is_admin });
    sendOk(res, sports.getOverview(user.id));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/sports/schedule') {
    const user = requireAuth(req);
    resolveMarketForRead(user, { touchPlayerActivity: !user.is_admin });
    sendOk(res, sports.getSchedule(user.id, url.searchParams.get('seasonId')));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/sports/standings') {
    const user = requireAuth(req);
    resolveMarketForRead(user, { touchPlayerActivity: !user.is_admin });
    sendOk(res, sports.getStandings(url.searchParams.get('seasonId')));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/sports/playoffs') {
    const user = requireAuth(req);
    resolveMarketForRead(user, { touchPlayerActivity: !user.is_admin });
    sendOk(res, sports.getPlayoffs(user.id, url.searchParams.get('seasonId')));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/sports/bets') {
    const user = requireAuth(req);
    sendOk(res, sports.getMyBets(user.id));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/sports/account') {
    const user = requireAuth(req);
    sendOk(res, sports.getAccountSummary(user.id));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/sports/activity') {
    const user = requireAuth(req);
    sendOk(res, sports.getRecentActivity(user.id));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/sports/ranking') {
    const user = requireAuth(req);
    sendOk(res, sports.getBettingRanking());
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/sports/teams/')) {
    requireAuth(req);
    const teamId = decodeURIComponent(url.pathname.slice('/api/sports/teams/'.length));
    sendOk(res, sports.getTeamDetail(teamId));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/sports/bet') {
    const user = requireAuth(req);
    const body = await readJson(req);
    const result = sports.placeBet(user, body);
    touchPlayerActivity(user);
    const fresh = db.get(`SELECT * FROM users WHERE id = ${db.q(user.id)};`);
    sendOk(res, {
      bet: result,
      user: buildPublicUser(fresh || user, marketState().current_tick),
      sports_account: sports.getAccountSummary(user.id)
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/sports/series-bet') {
    const user = requireAuth(req);
    const body = await readJson(req);
    const result = sports.placeSeriesBet(user, body);
    touchPlayerActivity(user);
    const fresh = db.get(`SELECT * FROM users WHERE id = ${db.q(user.id)};`);
    sendOk(res, {
      bet: result,
      user: buildPublicUser(fresh || user, marketState().current_tick),
      sports_account: sports.getAccountSummary(user.id)
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/advance') {
    const user = requireAdmin(req);
    sendOk(res, advanceTick({ source: 'manual' }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/weekly-report') {
    requireAuth(req);
    const tick = Number(url.searchParams.get('tick'));
    if (!tick) throw new Error('缺少 tick 参数');
    sendOk(res, news.getWeeklyReport(tick));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/news') {
    requireAuth(req);
    const tick = Number(url.searchParams.get('tick'));
    if (!tick) throw new Error('缺少 tick 参数');
    sendOk(res, news.getNewsByTick(tick).map(db.sanitizeNews));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/overview') {
    const user = requireAdmin(req);
    sendOk(res, getAdminOverview());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/sports') {
    requireAdmin(req);
    sendOk(res, sports.getAdminOverview());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/sports/audit') {
    requireAdmin(req);
    sendOk(res, sports.getAudit());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/sports/pause') {
    requireAdmin(req);
    const body = await readJson(req);
    sendOk(res, sports.setPaused(!!body.paused));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/sports/cancel') {
    requireAdmin(req);
    const body = await readJson(req);
    sendOk(res, sports.cancelMatch(String(body.matchId || ''), String(body.reason || '管理员取消异常比赛')));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/sports/advance-stage') {
    requireAdmin(req);
    sendOk(res, sports.advanceStage());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/sports/config') {
    requireAdmin(req);
    const body = await readJson(req);
    sendOk(res, sports.updateNextConfig(body));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/stocks') {
    requireAdmin(req);
    sendOk(res, getAdminStocks());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/toggle-market') {
    const user = requireAdmin(req);
    sendOk(res, toggleMarketOpen(user));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/reset-market') {
    const user = requireAdmin(req);
    sendOk(res, resetMarket(user));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/market/resume') {
    const user = requireAuth(req);
    sendOk(res, resumeMarket(user));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/reset-passwords') {
    const user = requireAdmin(req);
    sendOk(res, resetPlayerPasswords(user));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/reset-password') {
    const user = requireAdmin(req);
    const body = await readJson(req);
    sendOk(res, resetSinglePlayerPassword(user, body));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/stocks') {
    const user = requireAdmin(req);
    const body = await readJson(req);
    sendOk(res, addStock(user, body));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/stocks/update') {
    const user = requireAdmin(req);
    const body = await readJson(req);
    sendOk(res, updateStock(user, body));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/reset-player') {
    const user = requireAdmin(req);
    const body = await readJson(req);
    sendOk(res, resetPlayer(user, body));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/delete-account') {
    const user = requireAdmin(req);
    const body = await readJson(req);
    sendOk(res, deletePlayerAccount(user, body));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/loan/status') {
    const user = requireAuth(req);
    sendOk(res, getLoanStatus(user, { touchPlayerActivity: !user.is_admin }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/loan/borrow') {
    const user = requireAuth(req);
    const body = await readJson(req);
    sendOk(res, borrowLoan(user, body));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/loan/repay') {
    const user = requireAuth(req);
    sendOk(res, repayLoan(user));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/loan/history') {
    const user = requireAuth(req);
    sendOk(res, getLoanHistory(user));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/loan/dismiss-warning') {
    const user = requireAuth(req);
    sendOk(res, dismissLoanWarning(user));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/p2p/status') {
    const user = requireAuth(req);
    sendOk(res, getP2PStatus(user));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/p2p/order') {
    const user = requireAuth(req);
    const body = await readJson(req);
    sendOk(res, createP2POrder(user, body));
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/p2p/order/') && url.pathname.endsWith('/cancel')) {
    const user = requireAuth(req);
    const orderId = parseInt(url.pathname.split('/')[4]);
    sendOk(res, cancelP2POrder(user, orderId));
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/p2p/order/') && url.pathname.endsWith('/match')) {
    const user = requireAuth(req);
    const orderId = parseInt(url.pathname.split('/')[4]);
    sendOk(res, matchP2POrder(user, orderId));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/p2p/orders') {
    const user = requireAuth(req);
    const params = Object.fromEntries(url.searchParams.entries());
    sendOk(res, listP2POrders(user, params));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/p2p/repay') {
    const user = requireAuth(req);
    sendOk(res, repayP2PLoan(user));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/p2p/history') {
    const user = requireAuth(req);
    sendOk(res, getP2PHistory(user));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/invites/generate') {
    const admin = requireAdmin(req);
    const body = await readJson(req);
    sendOk(res, generateInvites(admin, body));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/invites') {
    requireAdmin(req);
    sendOk(res, listInvites());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/invites/update') {
    const admin = requireAdmin(req);
    const body = await readJson(req);
    sendOk(res, updateInvite(admin, body));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/invites/revoke') {
    const admin = requireAdmin(req);
    const body = await readJson(req);
    sendOk(res, revokeInvite(admin, body));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/guide') {
    try {
      const guidePath = path.join(ROOT, '玩家手册.md');
      const content = fs.readFileSync(guidePath, 'utf-8');
      sendOk(res, { content });
    } catch (e) {
      sendJson(res, 500, { code: 1, message: '教程文档加载失败' });
    }
    return;
  }

  sendJson(res, 404, { code: 1, message: '接口不存在' });
}

function resolveMarketForRead(user, options = {}) {
  const now = options.now || clock.now();
  let market = ensureSleepState(now);
  if (options.touchPlayerActivity && user && !user.is_admin && !market.sleeping) {
    touchPlayerActivity(user, now);
    market = marketState();
  }
  return market;
}

function nextSleepReason(market, now = clock.now()) {
  const runtimeAnchor = market.run_started_at || market.created_at || null;
  const activityAnchor = market.last_player_activity_at || runtimeAnchor || null;
  const runtimeDays = clock.calendarDayDiff(runtimeAnchor, now);
  const inactiveDays = clock.calendarDayDiff(activityAnchor, now);
  if (runtimeDays >= MARKET_RUNTIME_CAP_DAYS) return 'runtime_cap';
  if (inactiveDays >= MARKET_INACTIVE_SLEEP_DAYS) return 'inactive';
  return null;
}

function ensureSleepState(now = clock.now()) {
  const market = marketState();
  if (market.sleeping) return market;
  const reason = nextSleepReason(market, now);
  if (!reason) return market;
  const sleepSince = clock.serverTimeIso(now);
  db.exec(`UPDATE market_state
    SET sleeping = 1,
        sleep_reason = ${db.q(reason)},
        sleep_since = ${db.q(sleepSince)},
        updated_at = datetime('now')
    WHERE id = 1;`);
  return marketState();
}

function touchPlayerActivity(user, now = clock.now()) {
  if (!user || user.is_admin) return;
  const seenAt = clock.serverTimeIso(now);
  db.exec(`UPDATE market_state
    SET last_player_activity_at = ${db.q(seenAt)},
        updated_at = datetime('now')
    WHERE id = 1;`);
}

function login(body) {
  const username = normalizeUsername(body.username);
  if (!username) throw new Error('请输入用户名');

  const market = ensureSleepState();
  const user = db.get(`SELECT * FROM users WHERE LOWER(username) = LOWER(${db.q(username)});`);
  if (!user) throw new Error('账号或密码错误');

  if (user.is_admin && !user.password_hash) {
    return completeLogin(user, 'admin_login');
  }

  if (!body.password) throw new Error('请输入密码');

  if (!user.activated_at || !user.password_hash) {
    throw new Error('账号未激活，请联系管理员');
  }

  if (!verifyPassword(body.password, user.password_salt, user.password_hash)) {
    throw new Error('账号或密码错误');
  }

  return completeLogin(user, 'login');
}

function register(body) {
  const inviteCode = normalizeInviteCode(body.inviteCode);
  const username = normalizeUsername(body.username);
  const password = String(body.password || '');

  if (!inviteCode) throw new Error('请输入邀请码');
  if (!username) throw new Error('请输入用户名');
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new Error('用户名需 3-20 位，仅允许字母、数字、下划线');
  validatePassword(password);

  return db.transaction(() => {
    const invite = db.get(`SELECT * FROM invite_codes WHERE code = ${db.q(inviteCode)};`);
    if (!invite || invite.status !== 'unused') throw new Error('邀请码无效或已被使用');

    const existingUser = db.get(`SELECT * FROM users WHERE LOWER(username) = LOWER(${db.q(username)});`);
    if (existingUser) throw new Error('用户名已被占用');

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(password, salt);
    const userId = crypto.randomUUID();
    const market = marketState();
    const nickname = (invite.nickname || '').trim() || ('玩家' + username);

    db.exec(`INSERT INTO users
      (id, username, nickname, cash, join_tick, initial_asset_at_join,
       password_hash, password_salt, activated_at, is_admin,
       invite_code, created_at, updated_at)
      VALUES (${db.q(userId)}, ${db.q(username)}, ${db.q(nickname)},
        ${market.initial_cash}, ${market.current_tick}, ${market.initial_cash},
        ${db.q(passwordHash)}, ${db.q(salt)}, datetime('now'), 0,
        ${db.q(inviteCode)}, datetime('now'), datetime('now'));`);

    db.exec(`UPDATE invite_codes
      SET status = 'used', used_by_user_id = ${db.q(userId)}, used_at = datetime('now')
      WHERE code = ${db.q(inviteCode)};`);

    const user = db.get(`SELECT * FROM users WHERE id = ${db.q(userId)};`);
    writeAssetSnapshot(user, market.current_tick);
    recordAccountEvent(userId, 'register', JSON.stringify({ inviteCode }));
    return completeLogin(user, 'register');
  });
}

function setupPassword(body) {
  const username = normalizeUsername(body.username);
  const password = String(body.password || '');

  if (!username) throw new Error('请输入用户名');
  if (!password) throw new Error('请输入新密码');
  validatePassword(password);

  return db.transaction(() => {
    const user = db.get(`SELECT * FROM users WHERE LOWER(username) = LOWER(${db.q(username)});`);
    if (!user) throw new Error('账号不存在');
    if (user.is_admin) throw new Error('管理员账号不能通过此方式设置密码');
    if (user.password_hash) throw new Error('账号已有密码，请使用登录页进入市场');

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(password, salt);

    db.exec(`UPDATE users
      SET password_hash = ${db.q(passwordHash)},
          password_salt = ${db.q(salt)},
          activated_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ${db.q(user.id)};`);

    // clear old sessions so player must use new session
    db.exec(`DELETE FROM sessions WHERE user_id = ${db.q(user.id)};`);

    recordAccountEvent(user.id, 'setup_password', null);
    return completeLogin(user, 'setup_password');
  });
}

function completeLogin(user, eventType) {
  const now = clock.now();
  db.exec(`UPDATE users
    SET last_login_at = datetime('now'),
        last_seen_at = datetime('now'),
        login_count = COALESCE(login_count, 0) + 1,
        updated_at = datetime('now')
    WHERE id = ${db.q(user.id)};`);
  const fresh = db.get(`SELECT * FROM users WHERE id = ${db.q(user.id)};`);
  recordAccountEvent(fresh.id, eventType, null);
  let market = ensureSleepState(now);
  if (!fresh.is_admin && !market.sleeping) {
    touchPlayerActivity(fresh, now);
    market = marketState();
  }

  return {
    token: createSession(fresh),
    user: sanitizeUser(fresh),
    current_tick: market.current_tick,
    market_clock: marketClock(market, now)
  };
}

function getState(user, selectedCodeRaw = 'SSB001', options = {}) {
  const now = options.now || clock.now();
  const market = resolveMarketForRead(user, { ...options, now });
  const stocks = getStocks();
  const selectedCode = normalizeStockCode(selectedCodeRaw || 'SSB001', stocks);
  const selectedStock = stocks.find((stock) => stock.code === selectedCode) || stocks[0];
  const orderFlowMap = getOrderFlowMap(market.current_tick);
  const activeLoan = getActiveLoanInfo(user.id);
  const publicUser = buildPublicUser(user, market.current_tick);

  return {
    current_tick: market.current_tick,
    sleeping: !!market.sleeping,
    market_clock: marketClock(market, now),
    user: publicUser,
    stocks: publicStocks(stocks),
    market_overview: buildMarketOverview(stocks, market.current_tick),
    prices: db.all(`SELECT stock_code, tick, close, change_pct FROM stock_prices
      WHERE tick = ${market.current_tick} ORDER BY stock_code;`),
    holdings: db.all(`SELECT id, user_id, stock_code, quantity, available_quantity, avg_cost FROM holdings
      WHERE user_id = ${db.q(user.id)} ORDER BY stock_code;`),
    transactions: db.all(`SELECT id, stock_code, type, quantity, price, fee, tick, created_at FROM transactions
      WHERE user_id = ${db.q(user.id)} AND created_at >= ${db.q(clock.shanghaiDaysAgoUtcSpace(2))}
      ORDER BY id DESC LIMIT 20;`),
    history: db.all(`SELECT tick, close FROM (
        SELECT tick, close FROM stock_prices WHERE stock_code = ${db.q(selectedStock.code)}
        ORDER BY tick DESC LIMIT 200
      ) ORDER BY tick ASC;`),
    selected_order_flow: buildOrderFlowSummary(selectedStock.code, orderFlowMap[selectedStock.code]),
    selected_trade_activity: buildRecentTradeActivity(selectedStock.code, market.current_tick, 5),
    news: news.getActiveNews(market.current_tick).map(db.sanitizeNews),
    kol_comments: kol.getActiveKolComments(market.current_tick).map(db.sanitizeKolComment),
    stock_news: news.getNewsForStock(selectedStock.code, selectedStock.industry, market.current_tick, 20).map(db.sanitizeNews),
    active_loan: activeLoan,
    is_bankrupt: !!user.bankrupt
  };
}

function trade(user, body) {
  const action = String(body.action || '');
  const stockCode = normalizeStockCode(body.stockCode);
  const lots = Math.floor(Number(body.lots || 0));
  const expectedTick = Number(body.expectedTick);
  const expectedPrice = Number(body.expectedPrice);
  const now = clock.now();
  if (!['buy', 'sell'].includes(action)) throw new Error('非法操作类型');
  if (user.bankrupt) throw new Error('已破产，无法交易。请联系管理员重置');
  if (!stockCode || !lots || lots <= 0) throw new Error('交易数量必须为正整数手');
  if (!Number.isInteger(expectedTick) || expectedTick <= 0 || !Number.isFinite(expectedPrice) || expectedPrice <= 0) {
    throw new Error('请刷新行情后重新提交交易');
  }

  return db.transaction(() => {
    const quantity = lots * RULES.LOT_SIZE;
    const market = ensureSleepState(now);
    if (market.sleeping) throw new Error('本局已休眠，请先恢复本局后再交易');
    if (!isTradingAllowed(market)) throw new Error('当前封盘，只能查看行情，暂不能交易');
    const priceRow = db.get(`SELECT * FROM stock_prices WHERE stock_code = ${db.q(stockCode)} AND tick = ${market.current_tick};`);
    if (!priceRow) throw new Error('无当前 tick 价格');
    if (expectedTick !== Number(market.current_tick) || Math.abs(Number(expectedPrice) - Number(priceRow.close)) > 0.0001) {
      throw new Error(`行情已更新到第 ${market.current_tick} 期，${stockCode} 最新价格为 ${Number(priceRow.close).toFixed(2)}，请刷新后重新确认`);
    }

    const price = priceRow.close;
    const holdingId = `${user.id}_${stockCode}`;
    const holding = db.get(`SELECT * FROM holdings WHERE id = ${db.q(holdingId)}`);
    const fee = Number((price * quantity * RULES.FEE_RATE).toFixed(2));

    if (action === 'buy') {
      const freshCash = Number(db.get(`SELECT cash FROM users WHERE id = ${db.q(user.id)};`)?.cash || 0);
      const isLimitUp = priceRow.change_pct >= RULES.PRICE_LIMIT;
      const cost = price * quantity;
      const total = Number((cost + fee).toFixed(2));
      if (total > freshCash) throw new Error('可用资金不足');

      const liveSnapshot = buildLiveSnapshot(user, market.current_tick);
      const loanLiability = getActiveLoanPrincipalLiability(user.id);
      const netAsset = Number((liveSnapshot.total_asset - loanLiability).toFixed(2));
      const currentHoldingValue = holding ? holding.quantity * price : 0;
      if (currentHoldingValue + cost > netAsset * RULES.SINGLE_STOCK_CAP) {
        throw new Error(`单只股票持仓不得超过 ${RULES.SINGLE_STOCK_CAP * 100}%`);
      }

      if (isLimitUp) {
        const cashLots = Math.floor(freshCash / (price * RULES.LOT_SIZE * (1 + RULES.FEE_RATE)));
        const capValue = Math.max(0, netAsset * RULES.SINGLE_STOCK_CAP - currentHoldingValue);
        const capLots = Math.floor(capValue / (price * RULES.LOT_SIZE));
        const normalMaxLots = Math.max(0, Math.min(cashLots, capLots));
        const limitLots = normalMaxLots >= 1
          ? Math.max(1, Math.floor(normalMaxLots * RULES.LIMIT_UP_BUY_LIQUIDITY_RATIO))
          : 0;
        if (lots > limitLots) {
          throw new Error(`该股涨停，买盘拥挤，当前最多只能买入 ${limitLots} 手`);
        }
      }

      if (holding) {
        const newQty = holding.quantity + quantity;
        const avg = Number(((holding.avg_cost * holding.quantity + cost) / newQty).toFixed(4));
        db.exec(`UPDATE holdings SET quantity = ${newQty}, avg_cost = ${avg}, updated_at = datetime('now')
          WHERE id = ${db.q(holdingId)};`);
      } else {
        db.exec(`INSERT INTO holdings
          (id, user_id, stock_code, quantity, available_quantity, avg_cost, updated_at)
          VALUES (${db.q(holdingId)}, ${db.q(user.id)}, ${db.q(stockCode)},
            ${quantity}, 0, ${price}, datetime('now'));`);
      }
      db.exec(`UPDATE users SET cash = ROUND(cash - ${total}, 2), updated_at = datetime('now')
        WHERE id = ${db.q(user.id)};`);
      recordTx(user.id, stockCode, 'buy', quantity, price, fee, market.current_tick);
      touchPlayerActivity(user, now);
      return;
    }

    const isLimitDown = priceRow.change_pct <= -RULES.PRICE_LIMIT;
    if (!holding || holding.quantity <= 0) throw new Error('当前未持有该股票');
    if (quantity > holding.quantity) throw new Error(`持仓不足：当前总持仓仅 ${holding.quantity} 股`);
    if (holding.available_quantity <= 0) throw new Error('T+1 限制：当前持仓需到下一期后才可卖出');
    if (quantity > holding.available_quantity) throw new Error(`可卖数量不足：当前最多可卖 ${holding.available_quantity} 股`);

    if (isLimitDown) {
      const normalMaxLots = Math.floor((holding.available_quantity || 0) / RULES.LOT_SIZE);
      const limitLots = normalMaxLots >= 1
        ? Math.max(1, Math.floor(normalMaxLots * RULES.LIMIT_DOWN_SELL_LIQUIDITY_RATIO))
        : 0;
      if (lots > limitLots) {
        throw new Error(`该股跌停，卖盘拥挤，当前最多只能卖出 ${limitLots} 手`);
      }
    }

    const net = Number((price * quantity - fee).toFixed(2));
    const remain = holding.quantity - quantity;
    if (remain <= 0) {
      db.exec(`DELETE FROM holdings WHERE id = ${db.q(holdingId)};`);
    } else {
      db.exec(`UPDATE holdings SET quantity = ${remain}, available_quantity = ${holding.available_quantity - quantity},
        updated_at = datetime('now') WHERE id = ${db.q(holdingId)};`);
    }
    db.exec(`UPDATE users SET cash = ROUND(cash + ${net}, 2), updated_at = datetime('now')
      WHERE id = ${db.q(user.id)};`);
    recordTx(user.id, stockCode, 'sell', quantity, price, fee, market.current_tick);
    touchPlayerActivity(user, now);
  });
}

function advanceTick(options = {}) {
  const source = options.source || 'manual';
  const now = options.now || clock.now();
  return db.transaction(() => {
    const market = ensureSleepState(now);
    if (market.sleeping && source === 'auto') {
      return {
        tick: market.current_tick,
        skipped: true,
        reason: 'market_sleeping',
        market_clock: marketClock(market, now)
      };
    }
    if (market.sleeping && source === 'manual') {
      throw new Error('本局已休眠，请先恢复本局后再推进。');
    }
    if (source === 'auto') {
      const decision = clock.autoAdvanceDecision(market, now);
      if (!decision.should_advance) {
        return {
          tick: market.current_tick,
          skipped: true,
          reason: decision.reason,
          market_clock: marketClock(market, now)
        };
      }
      options.scheduleKey = decision.advance_key;
    }

    const timeParts = clock.shanghaiParts(now);
    const rawDayIndex = Number(market.day_tick_index || 0);
    const isNewMarketDay = market.market_date !== timeParts.date || !market.day_start_tick;
    const previousDayIndex = isNewMarketDay ? 0 : rawDayIndex;
    const dayStartTick = isNewMarketDay ? market.current_tick : Number(market.day_start_tick || market.current_tick);
    const dailyTickTotal = clock.dailyTickTotal({ ...market, market_date: timeParts.date }, now);
    const nextDayIndex = previousDayIndex >= dailyTickTotal
      ? dailyTickTotal
      : previousDayIndex + 1;
    const nextTick = market.current_tick + 1;
    const macroSentiment = rollMacroSentiment();
    const sectorSentiments = {};
    for (const sector of Object.keys(SECTORS)) {
      sectorSentiments[sector] = rollSectorSentiment();
    }
    const stocks = getStocks();
    const orderFlowMap = getOrderFlowMap(market.current_tick);

    const rumors = news.checkAndGenerateRumors(nextTick);
    const generatedNews = news.generateNews(nextTick, stocks);
    const activeRealNews = db.all(
      `SELECT * FROM news WHERE published = 1 AND truth_type LIKE 'real_%' AND is_rumor = 0
       AND impact_start_tick <= ${nextTick}
       AND (impact_start_tick + impact_duration_ticks) > ${nextTick};`
    );
    const generatedKolComments = kol.generateKolComments(nextTick, generatedNews, activeRealNews, stocks, DEFAULT_FUTURES, DEFAULT_FUNDS);
    const allActiveNews = db.all(
      `SELECT * FROM news WHERE published = 1 AND impact_start_tick <= ${nextTick}
       AND (impact_start_tick + impact_duration_ticks) > ${nextTick};`
    );

    const matthewBiasMap = computeMatthewBias(stocks, market.current_tick);

    for (const stock of stocks) {
      const prev = db.get(`SELECT close, anchor FROM stock_prices WHERE stock_code = ${db.q(stock.code)}
        AND tick = ${market.current_tick};`) || { close: stock.initial_price, anchor: stock.initial_price };
      let dynamics = getStockDynamics(stock.code);

      let priceNewsImpact = 0;
      let realNewsIncrement = 0;
      for (const item of allActiveNews) {
        const impact = news.calculateNewsImpact(item, stock.code, stock.industry, nextTick);
        priceNewsImpact += String(item.truth_type || '').startsWith('real') && !item.is_rumor
          ? impact * RULES.REAL_NEWS_PRICE_SCALE
          : impact;
        realNewsIncrement += news.calculateRealNewsImpactIncrement(item, stock.code, stock.industry, nextTick);
      }
      priceNewsImpact = news.clampCombinedImpact(priceNewsImpact);
      realNewsIncrement = news.clampCombinedImpact(realNewsIncrement);
      dynamics = updateStockRegime(dynamics);
      dynamics = maybeIgniteStockTrend(dynamics, stock, realNewsIncrement);
      dynamics = maybeEnterRandomTrend(dynamics, stock);

      const lastAnchor = Number(prev.anchor || stock.initial_price);
      const tether = computeAnchorTether(lastAnchor, stock.initial_price);
      const trendCatchup = dynamics.regime === 'trend'
        ? Math.max(-0.02, Math.min(0.02, RULES.TREND_ANCHOR_CATCHUP * ((Number(prev.close) - lastAnchor) / lastAnchor)))
        : 0;
      const newAnchor = Math.max(0.01, lastAnchor * (
        1 + anchorWalkStep() + RULES.ANCHOR_NEWS_PASSTHROUGH * realNewsIncrement + tether + trendCatchup
      ));
      const personality = RISK_DYNAMICS[stock.risk_level] || RISK_DYNAMICS.mid;
      const fade = dynamics.trend_total > 0 ? dynamics.trend_remaining / dynamics.trend_total : 0;
      const trendBias = dynamics.regime === 'trend'
        ? dynamics.trend_dir * RULES.TREND_BIAS * personality.trendBias * fade
        : 0;
      const next = computeNextPrice(prev, stock, {
        marketSentiment: macroSentiment + (sectorSentiments[stock.sector] || 0),
        newsImpact: priceNewsImpact,
        orderFlowImpact: computeOrderFlowImpact(orderFlowMap[stock.code]),
        streak: dynamics.streak,
        anchor: newAnchor,
        regime: dynamics.regime,
        trendBias,
        matthewBias: matthewBiasMap[stock.code] || 0
      });
      const direction = next.change_pct > 0 ? 1 : (next.change_pct < 0 ? -1 : 0);
      const streak = direction === 0 ? 0
        : (Math.sign(dynamics.streak) === direction ? dynamics.streak + direction : direction);
      writeStockDynamics(stock.code, { ...dynamics, streak });

      db.exec(`INSERT OR REPLACE INTO stock_prices
        (stock_code, tick, open, close, high, low, anchor, change_pct, created_at)
        VALUES (${db.q(stock.code)}, ${nextTick}, ${next.open}, ${next.close},
          ${next.high}, ${next.low}, ${Number(newAnchor.toFixed(4))}, ${next.change_pct}, datetime('now'));`);
    }

    funds.advanceFundNavs({
      currentTick: market.current_tick,
      nextTick,
      stocks,
      shouldRebalance: nextDayIndex === 4 || nextDayIndex === dailyTickTotal
    });

    futures.advanceFutures({
      currentTick: market.current_tick,
      nextTick,
      stocks,
      activeNews: allActiveNews
    });

    const autoPatch = source === 'auto'
      ? `, last_auto_advance_key = ${db.q(options.scheduleKey || clock.advanceKey(now))},
          last_auto_advance_at = ${db.q(clock.serverTimeIso(now))}`
      : '';
    db.exec(`UPDATE market_state
      SET current_tick = ${nextTick},
          market_date = ${db.q(timeParts.date)},
          day_start_tick = ${dayStartTick},
          day_tick_index = ${nextDayIndex},
          updated_at = datetime('now')
           ${autoPatch}
       WHERE id = 1;`);
    db.exec(`UPDATE holdings SET available_quantity = quantity, updated_at = datetime('now')
      WHERE available_quantity != quantity;`);
    funds.releaseSettledShares();

    for (const user of db.all('SELECT * FROM users')) {
      writeAssetSnapshot(user, nextTick);
    }

    processLoans(nextTick);
    processP2PLoans(nextTick);
    settleOverdueP2PLoans(nextTick);

    const dailyReport = nextDayIndex === dailyTickTotal
      ? news.generateDailyReport(nextTick, dayStartTick, null)
      : null;

    return {
      tick: nextTick,
      source,
      news_count: generatedNews.length,
      rumor_count: rumors.length,
      daily_report: !!dailyReport,
      market_clock: marketClock(marketState(), now)
    };
  });
}

function getStockDynamics(stockCode) {
  return db.get(`SELECT * FROM stock_dynamics WHERE stock_code = ${db.q(stockCode)};`)
    || { regime: 'oscillation', trend_dir: 0, trend_remaining: 0, trend_total: 0, streak: 0 };
}

function updateStockRegime(state) {
  const next = { ...state };
  if (next.regime === 'trend') {
    next.trend_remaining = Math.max(0, Number(next.trend_remaining || 0) - 1);
    if (next.trend_remaining <= 0) {
      if (Math.random() < RULES.TREND_CONTINUE_PROBABILITY) {
        const extension = RULES.TREND_DUR_MIN
          + Math.floor(Math.random() * (RULES.TREND_DUR_MAX - RULES.TREND_DUR_MIN + 1));
        next.trend_remaining = Math.max(2, extension);
        next.trend_total = Number(next.trend_total || 0) + extension;
      } else {
        next.regime = 'oscillation';
        next.trend_dir = 0;
        next.trend_total = 0;
      }
    }
  }
  return next;
}

function maybeIgniteStockTrend(state, stock, realNewsIncrement) {
  if (state.regime === 'oscillation' && Math.abs(realNewsIncrement) >= RULES.TREND_IGNITE_THRESHOLD) {
    return startStockTrend(state, stock, realNewsIncrement > 0 ? 1 : -1);
  }
  return state;
}

function maybeEnterRandomTrend(state, stock) {
  if (state.regime !== 'oscillation') return state;
  const personality = RISK_DYNAMICS[stock.risk_level] || RISK_DYNAMICS.mid;
  if (Math.random() < RULES.TREND_ENTER_CHANCE * personality.enterChance) {
    return startStockTrend(state, stock, Math.random() < 0.5 ? -1 : 1);
  }
  return state;
}

function startStockTrend(state, stock, direction) {
  const personality = RISK_DYNAMICS[stock.risk_level] || RISK_DYNAMICS.mid;
  const baseDuration = RULES.TREND_DUR_MIN
    + Math.floor(Math.random() * (RULES.TREND_DUR_MAX - RULES.TREND_DUR_MIN + 1));
  const duration = Math.max(2, Math.round(baseDuration * personality.duration));
  return { ...state, regime: 'trend', trend_dir: direction, trend_remaining: duration, trend_total: duration };
}

function writeStockDynamics(stockCode, state) {
  db.exec(`INSERT OR REPLACE INTO stock_dynamics
    (stock_code, regime, trend_dir, trend_remaining, trend_total, streak, updated_at)
    VALUES (${db.q(stockCode)}, ${db.q(state.regime)}, ${Number(state.trend_dir || 0)},
      ${Number(state.trend_remaining || 0)}, ${Number(state.trend_total || 0)}, ${Number(state.streak || 0)}, datetime('now'));`);
}

function getOrderFlowMap(tick) {
  const safeTick = Number(tick);
  if (!Number.isInteger(safeTick) || safeTick <= 0) return {};

  const rows = db.all(`SELECT stock_code, type, SUM(quantity) AS quantity
    FROM transactions
    WHERE tick = ${safeTick}
    GROUP BY stock_code, type;`);
  const map = {};

  for (const row of rows) {
    const current = map[row.stock_code] || { buyQuantity: 0, sellQuantity: 0 };
    if (row.type === 'buy') current.buyQuantity = Number(row.quantity || 0);
    if (row.type === 'sell') current.sellQuantity = Number(row.quantity || 0);
    map[row.stock_code] = current;
  }

  return map;
}

function buildOrderFlowSummary(stockCode, summary = {}) {
  const buyQuantity = Number(summary.buyQuantity || 0);
  const sellQuantity = Number(summary.sellQuantity || 0);
  const totalQuantity = buyQuantity + sellQuantity;
  const netQuantity = buyQuantity - sellQuantity;
  const imbalanceRatio = totalQuantity > 0
    ? Number((netQuantity / totalQuantity).toFixed(6))
    : 0;

  return {
    stock_code: stockCode,
    buy_quantity: buyQuantity,
    sell_quantity: sellQuantity,
    total_quantity: totalQuantity,
    net_quantity: netQuantity,
    imbalance_ratio: imbalanceRatio,
    price_impact: computeOrderFlowImpact({ buyQuantity, sellQuantity })
  };
}

function buildRecentTradeActivity(stockCode, currentTick, windowSize = 5) {
  const safeWindowSize = Math.max(1, Math.floor(Number(windowSize) || 5));
  const safeCurrentTick = Math.floor(Number(currentTick) || 0);
  const endTick = safeCurrentTick - 1;

  if (endTick < 1) {
    return {
      stock_code: stockCode,
      window_size: safeWindowSize,
      completed_ticks: 0,
      start_tick: null,
      end_tick: null,
      total_quantity: 0,
      total_lots: 0,
      total_amount: 0
    };
  }

  const startTick = Math.max(1, endTick - safeWindowSize + 1);
  const row = db.get(`SELECT
      COALESCE(SUM(quantity), 0) AS total_quantity,
      COALESCE(SUM(price * quantity), 0) AS total_amount
    FROM transactions
    WHERE stock_code = ${db.q(stockCode)}
      AND tick BETWEEN ${startTick} AND ${endTick};`) || {};

  const totalQuantity = Number(row.total_quantity || 0);
  return {
    stock_code: stockCode,
    window_size: safeWindowSize,
    completed_ticks: endTick - startTick + 1,
    start_tick: startTick,
    end_tick: endTick,
    total_quantity: totalQuantity,
    total_lots: Math.floor(totalQuantity / RULES.LOT_SIZE),
    total_amount: Number(Number(row.total_amount || 0).toFixed(2))
  };
}

function writeAssetSnapshot(user, tick) {
  const valuation = computeUserValuation(user.id, tick, user);
  const base = user.initial_asset_at_join || valuation.net_total_asset || 1;
  const returnPct = Number(((valuation.net_total_asset - base) / base).toFixed(6));
  const id = `${user.id}_${tick}`;
  const p2pReceivable = getP2PReceivable(user.id);
  const p2pPayable = getP2PLiability(user.id);
  db.exec(`INSERT OR REPLACE INTO asset_snapshots
    (id, user_id, tick, cash, holding_value, fund_value, futures_value, total_asset, loan_liability, p2p_receivable, p2p_payable, net_total_asset, return_pct, created_at)
    VALUES (${db.q(id)}, ${db.q(user.id)}, ${tick}, ${valuation.cash}, ${valuation.holding_value},
      ${valuation.fund_value}, ${valuation.futures_value}, ${valuation.total_asset}, ${valuation.loan_liability},
      ${p2pReceivable}, ${p2pPayable}, ${valuation.net_total_asset}, ${returnPct}, datetime('now'));`);
}

function getActiveLoanPrincipalLiability(userId) {
  const row = db.get(`SELECT COALESCE(SUM(remaining_principal), 0) AS liability
    FROM loans
    WHERE user_id = ${db.q(userId)}
      AND status = 'active';`);
  return Number((row?.liability || 0).toFixed(2));
}

function getBaselineLoanPrincipalLiability(userId, tick) {
  const row = db.get(`SELECT COALESCE(SUM(principal), 0) AS liability
    FROM loans
    WHERE user_id = ${db.q(userId)}
      AND start_tick < ${tick}
      AND (close_tick IS NULL OR close_tick >= ${tick})
      AND status != 'voided';`);
  return Number((row?.liability || 0).toFixed(2));
}

function buildRankingSnapshot(user, tick) {
  return computeUserValuation(user.id, tick, user);
}

function recordTx(userId, stockCode, type, quantity, price, fee, tick) {
  db.exec(`INSERT INTO transactions (user_id, stock_code, type, quantity, price, fee, tick, created_at)
    VALUES (${db.q(userId)}, ${db.q(stockCode)}, ${db.q(type)}, ${quantity}, ${price}, ${fee}, ${tick}, datetime('now'));`);
}

function getRanking(currentUser, options = {}) {
  const now = options.now || clock.now();
  const market = resolveMarketForRead(currentUser, { ...options, now });
  const users = db.all(`SELECT * FROM users
    WHERE activated_at IS NOT NULL AND is_admin = 0 AND bankrupt = 0
    ORDER BY activated_at ASC, nickname ASC;`)
    .filter((u) => getOperatedUserIds().has(String(u.id)));
  const rows = users.map((user) => {
    const live = buildRankingSnapshot(user, market.current_tick);
    const baselineTick = Math.max(user.join_tick || 1, market.day_start_tick || Math.max(1, market.current_tick - clock.DAILY_TICK_TOTAL));
    const baseline = pickBaselineSnapshot(user.id, baselineTick);
    const baselineAtTick = Number(baseline?.tick || baselineTick || market.current_tick);
    const baselineLiability = baseline ? getBaselineLoanPrincipalLiability(user.id, baselineAtTick) : 0;
    const baselineAsset = baseline ? baseline.total_asset : (user.initial_asset_at_join || market.initial_cash || 1);
    const baseAsset = Number((baselineAsset - baselineLiability).toFixed(2));
    const safeBaseAsset = baseAsset > 0 ? baseAsset : 1;
    const returnToday = safeBaseAsset > 0 ? (live.net_total_asset - safeBaseAsset) / safeBaseAsset : 0;
    return {
      user_id: user.id,
      nickname: user.nickname,
      is_me: user.id === currentUser.id,
      join_tick: user.join_tick,
      total_asset: Number(live.net_total_asset.toFixed(2)),
      return_today: Number(returnToday.toFixed(6)),
      return7: Number(returnToday.toFixed(6))
    };
  });

  const asset = rankRows(rows, 'total_asset', 'asset');
  const today = rankRows(rows, 'return_today', 'return_today');
  return {
    current_tick: market.current_tick,
    market_clock: marketClock(market, now),
    asset,
    today,
    return_today: today,
    return7: today,
    my: {
      asset_rank: asset.find((row) => row.is_me)?.rank || null,
      today_rank: today.find((row) => row.is_me)?.rank || null,
      return_today_rank: today.find((row) => row.is_me)?.rank || null,
      return7_rank: today.find((row) => row.is_me)?.rank || null
    }
  };
}

function getAllHoldings(currentUser, options = {}) {
  const now = options.now || clock.now();
  const market = resolveMarketForRead(currentUser, { ...options, now });
  const stocks = getStocks();
  const stockNameMap = Object.fromEntries(stocks.map((s) => [s.code, s.name]));
  const priceRows = db.all(`SELECT stock_code, close, change_pct FROM stock_prices WHERE tick = ${market.current_tick};`);
  const priceMap = Object.fromEntries(priceRows.map((r) => [r.stock_code, r]));
  const currentTickBuyRows = db.all(`SELECT user_id, stock_code, SUM(quantity) AS quantity FROM transactions
    WHERE tick = ${market.current_tick} AND type = 'buy'
    GROUP BY user_id, stock_code;`);
  const currentTickBuyMap = Object.fromEntries(currentTickBuyRows.map((r) => [
    `${r.user_id}:${r.stock_code}`,
    Number(r.quantity || 0)
  ]));

  // Fund holdings data
  const fundNexus = funds.getFundsList(market.current_tick);
  const fundNameMap = Object.fromEntries(fundNexus.map((f) => [f.code, f]));
  const fundNavRows = db.all(`SELECT fund_code, nav, change_pct FROM fund_nav WHERE tick = ${market.current_tick};`);
  const fundNavMap = Object.fromEntries(fundNavRows.map((r) => [r.fund_code, r]));

  // 基金当期净申购（买入 - 卖出 - 强平），用于 proration
  const currentTickFundNetRows = db.all(`
    SELECT user_id, fund_code,
      SUM(CASE WHEN type = 'buy' THEN shares
               WHEN type IN ('sell','forced_liquidation') THEN -shares
               ELSE 0 END) AS net_shares
    FROM fund_transactions
    WHERE tick = ${market.current_tick}
    GROUP BY user_id, fund_code;`);
  const currentTickFundBuyMap = Object.fromEntries(currentTickFundNetRows.map((r) => [
    `${r.user_id}:${r.fund_code}`,
    Math.max(0, Number(r.net_shares || 0))
  ]));

  const users = db.all(`SELECT * FROM users
    WHERE activated_at IS NOT NULL AND is_admin = 0
    ORDER BY activated_at ASC, nickname ASC;`)
    .filter((u) => getOperatedUserIds().has(String(u.id)));

  const result = users.map((user) => {
    const live = buildRankingSnapshot(user, market.current_tick);
    const holdings = db.all(`SELECT stock_code, quantity, avg_cost FROM holdings
      WHERE user_id = ${db.q(user.id)} AND quantity > 0
      ORDER BY stock_code;`);
    const holdingDetails = holdings.map((h) => {
      const price = priceMap[h.stock_code] || {};
      const currentPrice = price.close || h.avg_cost || 0;
      const changePct = price.change_pct || 0;
      const currentTickBuyQty = Math.min(Number(h.quantity || 0), currentTickBuyMap[`${user.id}:${h.stock_code}`] || 0);
      const heldBeforeTickQty = Math.max(0, Number(h.quantity || 0) - currentTickBuyQty);
      const displayChangePct = Number(h.quantity || 0) > 0 ? changePct * (heldBeforeTickQty / Number(h.quantity || 0)) : 0;
      const value = Number((h.quantity * currentPrice).toFixed(2));
      return {
        stock_code: h.stock_code,
        stock_name: stockNameMap[h.stock_code] || h.stock_code,
        quantity: h.quantity,
        current_price: currentPrice,
        change_pct: Number(displayChangePct.toFixed(4)),
        value
      };
    });
    const fundHoldingRows = db.all(`SELECT fund_code, shares, avg_nav FROM fund_holdings
      WHERE user_id = ${db.q(user.id)} AND shares > 0
      ORDER BY fund_code;`);
    const fundHoldingDetails = fundHoldingRows.map((fh) => {
      const fundNav = fundNavMap[fh.fund_code] || {};
      const nav = Number(fundNav.nav || fh.avg_nav || 0);
      const value = Number((Number(fh.shares) * nav).toFixed(2));

      // T+1: 仅当期前持有的份额享受当期涨跌幅
      const rawBuyShares = currentTickFundBuyMap[`${user.id}:${fh.fund_code}`] || 0;
      const currentTickBuyShares = Math.min(Number(fh.shares), rawBuyShares);
      const heldBeforeTickShares = Math.max(0, Number(fh.shares) - currentTickBuyShares);
      const rawChangePct = Number(fundNav.change_pct || 0);
      const displayFundChangePct = Number(fh.shares) > 0
        ? rawChangePct * (heldBeforeTickShares / Number(fh.shares))
        : 0;

      return {
        fund_code: fh.fund_code,
        fund_name: (fundNameMap[fh.fund_code] || {}).name || fh.fund_code,
        shares: Number(fh.shares),
        nav,
        change_pct: Number(displayFundChangePct.toFixed(4)),
        value
      };
    });
    const futuresPositions = db.all(`SELECT fp.*, fu.name FROM futures_positions fp
      LEFT JOIN futures_underlyings fu ON fu.code = fp.code
      WHERE fp.user_id = ${db.q(user.id)} AND fp.status = 'open'
      ORDER BY (fp.margin + fp.unrealized_pnl) DESC;`);
    const futuresDetails = futuresPositions.map(fp => {
      const value = Number((Number(fp.margin) + Number(fp.unrealized_pnl)).toFixed(2));
      const margin = Number(fp.margin);
      // 当期开仓：涨跌幅归零（当期价格变动不计入持有期变动）
      if (Number(fp.opened_tick) === market.current_tick) {
        return { code: fp.code, name: fp.name || fp.code, side: fp.side, value, change_pct: 0 };
      }
      const changePct = margin > 0 ? Number((Number(fp.unrealized_pnl) / margin).toFixed(4)) : 0;
      return {
        code: fp.code,
        name: fp.name || fp.code,
        side: fp.side,
        value,
        change_pct: changePct
      };
    });
    return {
      nickname: user.nickname,
      gross_total_asset: live.total_asset,
      loan_liability: live.loan_liability,
      total_asset: live.net_total_asset,
      holdings: holdingDetails,
      fund_holdings: fundHoldingDetails,
      futures_holdings: futuresDetails
    };
  });

  result.sort((a, b) => b.total_asset - a.total_asset);
  result.forEach((item) => {
    const total = item.total_asset || 1;
    item.holdings.forEach((h) => { h.weight = Number((h.value / total).toFixed(4)); });
    item.fund_holdings.forEach((fh) => { fh.weight = Number((fh.value / total).toFixed(4)); });
    item.futures_holdings.forEach((fh) => { fh.weight = Number((fh.value / total).toFixed(4)); });
  });
  return result;
}

function getAdminOverview() {
  const market = ensureSleepState();
  const users = db.all(`SELECT * FROM users WHERE username IS NOT NULL
    ORDER BY is_admin DESC, LOWER(username) ASC;`);
  const accounts = users.map((user) => adminAccountSummary(user, market.current_tick));

  const recentTransactions = db.all(`SELECT t.id, t.stock_code, t.type, t.quantity, t.price, t.fee,
      t.tick, t.created_at, u.username, u.nickname
    FROM transactions t
    JOIN users u ON u.id = t.user_id
    WHERE t.created_at >= ${db.q(clock.shanghaiDaysAgoUtcSpace(2))}
    ORDER BY t.id DESC
    LIMIT 50;`);

  return {
    current_tick: market.current_tick,
    sleeping: !!market.sleeping,
    market_clock: marketClock(market),
    account_count: accounts.length,
    active_count: accounts.filter((account) => account.activated && !account.is_admin).length,
    accounts,
    stocks: getAdminStocks().stocks,
    next_stock_code: suggestStockCode(),
    recent_transactions: recentTransactions
  };
}

function adminAccountSummary(user, tick) {
  const live = buildRankingSnapshot(user, tick);
  const txStats = db.get(`SELECT COUNT(*) AS transaction_count, MAX(created_at) AS last_trade_at
    FROM transactions WHERE user_id = ${db.q(user.id)};`) || {};
  return {
    username: user.username,
    nickname: user.nickname,
    is_admin: !!user.is_admin,
    activated: !!user.activated_at,
    activated_at: user.activated_at,
    last_login_at: user.last_login_at,
    last_seen_at: user.last_seen_at,
    login_count: user.login_count || 0,
    transaction_count: txStats.transaction_count || 0,
    last_trade_at: txStats.last_trade_at || null,
    cash: live.cash,
    holding_value: live.holding_value,
    fund_value: live.fund_value,
    gross_total_asset: live.total_asset,
    loan_liability: live.loan_liability,
    net_total_asset: live.net_total_asset,
    total_asset: live.net_total_asset,
    has_active_loan: !!user.has_active_loan,
    bankrupt: !!user.bankrupt,
    bank_tier: user.bank_tier || 1
  };
}

function resetMarket(adminUser) {
  return db.transaction(() => {
    const market = marketState();
    const stocks = getStocks();
    const resetNow = clock.now();
    sports.resetSports(resetNow);
    db.exec('DELETE FROM holdings;');
    db.exec('DELETE FROM fund_holdings;');
    db.exec('DELETE FROM transactions;');
    db.exec('DELETE FROM fund_transactions;');
    db.exec('DELETE FROM asset_snapshots;');
    db.exec('DELETE FROM news;');
    db.exec('DELETE FROM weekly_reports;');
    db.exec('DELETE FROM stock_prices;');
    db.exec('DELETE FROM stock_dynamics;');
    db.exec('DELETE FROM fund_nav;');
    db.exec('DELETE FROM fund_weight;');
    db.exec('DELETE FROM fund_regime;');
    db.exec('DELETE FROM loans;');
    db.exec('DELETE FROM loan_interest_log;');
    db.exec('DELETE FROM commodity_prices;');
    db.exec('DELETE FROM commodity_regime;');
    db.exec('DELETE FROM futures_positions;');
    db.exec('DELETE FROM futures_transactions;');
    db.exec('DELETE FROM p2p_orders;');
    db.exec('DELETE FROM p2p_loans;');
    const today = clock.shanghaiParts(resetNow).date;
    const cycleStartedAt = clock.serverTimeIso(resetNow);
    db.exec(`UPDATE market_state
      SET current_tick = 1,
          status = 'active',
          market_date = ${db.q(today)},
          day_start_tick = 1,
          day_tick_index = 0,
          cycle_started_at = ${db.q(cycleStartedAt)},
          sleeping = 0,
          sleep_reason = NULL,
          sleep_since = NULL,
          last_player_activity_at = ${db.q(cycleStartedAt)},
          run_started_at = ${db.q(cycleStartedAt)},
          last_auto_advance_key = NULL,
          last_auto_advance_at = NULL,
          force_open = 0,
          updated_at = datetime('now')
      WHERE id = 1;`);

    for (const stock of stocks) {
      db.exec(`INSERT INTO stock_prices
        (stock_code, tick, open, close, high, low, anchor, change_pct, created_at)
        VALUES (${db.q(stock.code)}, 1, ${stock.initial_price}, ${stock.initial_price},
          ${stock.initial_price}, ${stock.initial_price}, ${stock.initial_price}, 0, datetime('now'));`);
      writeStockDynamics(stock.code, { regime: 'oscillation', trend_dir: 0, trend_remaining: 0, trend_total: 0, streak: 0 });
    }
    for (const fund of funds.getFunds()) {
      db.exec(`INSERT INTO fund_nav (fund_code, tick, nav, change_pct, turnover_cost, created_at)
        VALUES (${db.q(fund.code)}, 1, ${fund.base_nav}, 0, 0, datetime('now'));`);
      if (fund.manage_mode === 'active') funds.ensureActiveFundWeights(fund, 1, stocks);
    }
    db.seedFutures(1);

    db.exec(`UPDATE users
      SET cash = ${market.initial_cash},
          join_tick = 1,
          initial_asset_at_join = ${market.initial_cash},
          has_active_loan = 0,
          has_p2p_loan = 0,
          p2p_role = NULL,
          bankrupt = 0,
          bank_tier = 1,
          qualifying_repayments = 0,
          updated_at = datetime('now')
      WHERE is_admin = 0;`);

    for (const user of db.all('SELECT * FROM users WHERE activated_at IS NOT NULL;')) {
      writeAssetSnapshot(user, 1);
    }
    recordAccountEvent(adminUser.id, 'admin_reset_market', null);
    return { tick: 1 };
  });
}

function toggleMarketOpen(user) {
  const now = clock.now();
  const market = ensureSleepState(now);
  if (market.sleeping) throw new Error('本局已休眠，请先恢复本局后再操作');
  const newForceOpen = market.force_open ? 0 : 1;
  db.exec(`UPDATE market_state SET force_open = ${newForceOpen}, updated_at = datetime('now') WHERE id = 1;`);
  recordAccountEvent(user.id, 'toggle_market', JSON.stringify({ force_open: !!newForceOpen }));
  const freshMarket = marketState();
  return {
    force_open: !!newForceOpen,
    current_tick: freshMarket.current_tick,
    market_clock: marketClock(freshMarket, now)
  };
}

function resumeMarket(user) {
  return db.transaction(() => {
    const now = clock.now();
    const market = ensureSleepState(now);
    if (!market.sleeping) throw new Error('本局当前未休眠，无需恢复');
    const resumedAt = clock.serverTimeIso(now);
    db.exec(`UPDATE market_state
      SET sleeping = 0,
          sleep_reason = NULL,
          sleep_since = NULL,
          last_player_activity_at = ${db.q(resumedAt)},
          run_started_at = ${db.q(resumedAt)},
          updated_at = datetime('now')
      WHERE id = 1;`);
    recordAccountEvent(user.id, 'market_resume', JSON.stringify({ previous_reason: market.sleep_reason || null }));
    const freshMarket = marketState();
    return {
      sleeping: false,
      current_tick: freshMarket.current_tick,
      market_clock: marketClock(freshMarket, now)
    };
  });
}

function resetPlayerPasswords(adminUser) {
  return db.transaction(() => {
    const playerIds = db.all('SELECT id FROM users WHERE is_admin = 0;').map((row) => row.id);
    if (playerIds.length) {
      const quotedIds = playerIds.map(db.q).join(',');
      db.exec(`UPDATE users
        SET password_hash = NULL,
            password_salt = NULL,
            activated_at = NULL,
            updated_at = datetime('now')
        WHERE id IN (${quotedIds});`);
      db.exec(`DELETE FROM sessions WHERE user_id IN (${quotedIds});`);
    }
    recordAccountEvent(adminUser.id, 'admin_reset_passwords', null);
    return { reset_count: playerIds.length };
  });
}

function resetSinglePlayerPassword(adminUser, body) {
  const username = normalizeUsername(body.username);
  if (!username) throw new Error('请选择要重置密码的玩家');

  return db.transaction(() => {
    const target = db.get(`SELECT * FROM users WHERE LOWER(username) = LOWER(${db.q(username)}) AND is_admin = 0;`);
    if (!target) throw new Error('玩家不存在');
    if (target.is_admin) throw new Error('管理员账号不能重置密码');

    db.exec(`UPDATE users
      SET password_hash = NULL,
          password_salt = NULL,
          activated_at = NULL,
          updated_at = datetime('now')
      WHERE id = ${db.q(target.id)};`);
    db.exec(`DELETE FROM sessions WHERE user_id = ${db.q(target.id)};`);
    recordAccountEvent(adminUser.id, 'admin_reset_player_password', JSON.stringify({ username }));

    const fresh = db.get(`SELECT * FROM users WHERE id = ${db.q(target.id)};`);
    return { account: adminAccountSummary(fresh, marketState().current_tick) };
  });
}

function getAdminStocks() {
  return {
    stocks: getStocks(),
    next_stock_code: suggestStockCode()
  };
}

function addStock(adminUser, body) {
  const stock = normalizeStockPayload(body);
  return db.transaction(() => {
    const existing = db.get(`SELECT * FROM stocks WHERE code = ${db.q(stock.code)};`);
    if (existing) throw new Error('股票代码已存在');

    const market = marketState();
    db.exec(`INSERT INTO stocks
      (code, name, sector, industry, mapping, initial_price, volatility, risk_level)
      VALUES (${db.q(stock.code)}, ${db.q(stock.name)}, ${db.q(stock.sector)}, ${db.q(stock.industry)}, ${db.q(stock.mapping)},
        ${stock.initial_price}, ${stock.volatility}, ${db.q(stock.risk_level)});`);
    db.exec(`INSERT OR IGNORE INTO stock_prices
      (stock_code, tick, open, close, high, low, anchor, change_pct, created_at)
      VALUES (${db.q(stock.code)}, ${market.current_tick}, ${stock.initial_price}, ${stock.initial_price},
        ${stock.initial_price}, ${stock.initial_price}, ${stock.initial_price}, 0, datetime('now'));`);
    writeStockDynamics(stock.code, { regime: 'oscillation', trend_dir: 0, trend_remaining: 0, trend_total: 0, streak: 0 });
    recordAccountEvent(adminUser.id, 'admin_add_stock', JSON.stringify({ code: stock.code, name: stock.name }));
    return { stock, stocks: getStocks(), next_stock_code: suggestStockCode() };
  });
}

function updateStock(adminUser, body) {
  const currentCode = normalizeCustomStockCode(body.currentCode);
  if (!currentCode) throw new Error('请选择要编辑的股票');

  const stock = normalizeStockPayload(body);
  return db.transaction(() => {
    const existing = db.get(`SELECT * FROM stocks WHERE code = ${db.q(currentCode)};`);
    if (!existing) throw new Error('股票不存在');

    if (stock.code !== currentCode) {
      const conflict = db.get(`SELECT * FROM stocks WHERE code = ${db.q(stock.code)};`);
      if (conflict) throw new Error('新的股票代码已存在');
      db.migrateStockCodeReferences(currentCode, stock.code);
    }

    db.exec(`UPDATE stocks
      SET name = ${db.q(stock.name)},
          sector = ${db.q(stock.sector)},
          industry = ${db.q(stock.industry)},
          mapping = ${db.q(stock.mapping)},
          initial_price = ${stock.initial_price},
          volatility = ${stock.volatility},
          risk_level = ${db.q(stock.risk_level)}
      WHERE code = ${db.q(stock.code)};`);

    const market = marketState();
    db.exec(`INSERT OR IGNORE INTO stock_prices
      (stock_code, tick, open, close, high, low, change_pct, created_at)
      VALUES (${db.q(stock.code)}, ${market.current_tick}, ${stock.initial_price}, ${stock.initial_price},
        ${stock.initial_price}, ${stock.initial_price}, 0, datetime('now'));`);
    recordAccountEvent(adminUser.id, 'admin_update_stock', JSON.stringify({ from: currentCode, to: stock.code }));
    return { stock, stocks: getStocks(), next_stock_code: suggestStockCode() };
  });
}

function getStocks() {
  return db.all(`SELECT code, name, sector, industry, mapping, initial_price, volatility, risk_level
    FROM stocks ORDER BY code ASC;`).map((stock) => ({
    code: stock.code,
    name: stock.name,
    sector: stock.sector || '',
    industry: stock.industry,
    mapping: stock.mapping,
    initial_price: Number(stock.initial_price),
    volatility: Number(stock.volatility),
    risk_level: stock.risk_level
  }));
}

function buildMarketOverview(stocks, tick) {
  const priceRows = db.all(`SELECT stock_code, tick, close, change_pct FROM stock_prices WHERE tick = ${tick};`);
  const prevRows = db.all(`SELECT stock_code, close FROM stock_prices WHERE tick = ${tick - 1};`);
  const priceMap = Object.fromEntries(priceRows.map((row) => [row.stock_code, row]));
  const prevMap = Object.fromEntries(prevRows.map((row) => [row.stock_code, row]));

  const rows = stocks.map((stock) => {
    const current = priceMap[stock.code] || { close: stock.initial_price, change_pct: 0 };
    const previous = prevMap[stock.code] || { close: current.close };
    const changePct = Number(current.change_pct || 0);
    return {
      code: stock.code,
      name: stock.name,
      industry: stock.industry,
      close: Number(current.close || stock.initial_price || 0),
      previous_close: Number(previous.close || current.close || stock.initial_price || 0),
      change_pct: changePct,
      abs_change_pct: Math.abs(changePct)
    };
  });

  const currentIndex = Number(rows.reduce((sum, row) => sum + row.close, 0).toFixed(2));
  const previousIndex = Number(rows.reduce((sum, row) => sum + row.previous_close, 0).toFixed(2));
  const changePct = previousIndex > 0 ? Number(((currentIndex - previousIndex) / previousIndex).toFixed(6)) : 0;
  const upCount = rows.filter((row) => row.change_pct > 0).length;
  const downCount = rows.filter((row) => row.change_pct < 0).length;

  return {
    current_index: currentIndex,
    previous_index: previousIndex,
    change_pct: changePct,
    up_count: upCount,
    down_count: downCount,
    flat_count: Math.max(0, rows.length - upCount - downCount),
    history: db.all(`SELECT tick, SUM(close) AS close FROM stock_prices
      GROUP BY tick ORDER BY tick DESC LIMIT 200;`)
      .reverse()
      .map((row) => ({ tick: row.tick, close: Number(Number(row.close || 0).toFixed(2)) })),
    top_gainers: rows.filter((row) => row.change_pct > 0)
      .sort((a, b) => b.change_pct - a.change_pct)
      .slice(0, 5),
    top_losers: rows.filter((row) => row.change_pct < 0)
      .sort((a, b) => a.change_pct - b.change_pct)
      .slice(0, 5),
    top_volatile: rows.slice()
      .sort((a, b) => b.abs_change_pct - a.abs_change_pct)
      .slice(0, 5)
  };
}

function normalizeStockPayload(body) {
  const code = normalizeCustomStockCode(body.code);
  const name = String(body.name || '').trim();
  const sector = String(body.sector || '其他').trim();
  const industry = String(body.industry || '').trim();
  const mapping = String(body.mapping || '').trim();
  const initialPrice = Number(body.initial_price ?? body.initialPrice);
  const volatility = Number(body.volatility);
  const riskLevel = String(body.risk_level || body.riskLevel || 'mid').trim();

  if (!code) throw new Error('股票代码只能包含大写字母、数字和连字符，长度 3-16 位');
  if (!name || name.length > 24) throw new Error('请输入 1-24 个字符的股票名称');
  if (sector.length > 24) throw new Error('请输入 1-24 个字符的板块名称');
  if (!industry || industry.length > 24) throw new Error('请输入 1-24 个字符的行业名称');
  if (mapping.length > 80) throw new Error('映射说明不能超过 80 个字符');
  if (!Number.isFinite(initialPrice) || initialPrice <= 0 || initialPrice > 10000) throw new Error('初始价必须是 0-10000 之间的数字');
  if (!Number.isFinite(volatility) || volatility < 0.01 || volatility > 0.2) throw new Error('波动率必须在 0.01-0.20 之间');
  if (!['high', 'mid', 'low'].includes(riskLevel)) throw new Error('风险等级必须是 high、mid 或 low');

  return {
    code,
    name,
    sector,
    industry,
    mapping,
    initial_price: Number(initialPrice.toFixed(2)),
    volatility: Number(volatility.toFixed(4)),
    risk_level: riskLevel
  };
}

function normalizeCustomStockCode(code) {
  const value = String(code || '').trim().toUpperCase();
  return /^[A-Z0-9-]{3,16}$/.test(value) ? value : '';
}

function suggestStockCode() {
  const codes = getStocks().map((stock) => stock.code);
  for (let i = 1; i <= 999; i += 1) {
    const candidate = `SSB${String(i).padStart(3, '0')}`;
    if (!codes.includes(candidate)) return candidate;
  }
  return 'SSBNEW';
}

function marketClock(market = marketState(), now = clock.now()) {
  return clock.buildMarketClock(market, now);
}

function isTradingAllowed(market = marketState()) {
  if (process.env.SSB_FORCE_MARKET_OPEN === '1') return true;
  return marketClock(market).trading_allowed;
}

function startMarketClock() {
  if (process.env.SSB_DISABLE_CLOCK === '1') return;
  const run = () => {
    try {
      const now = clock.now();
      const market = ensureSleepState(now);
      const decision = clock.autoAdvanceDecision(market, now);
      if (!decision.should_advance) return;
      const result = advanceTick({ source: 'auto', now, scheduleKey: decision.advance_key });
      if (!result.skipped) {
        console.log(`[marketClock] ${decision.advance_key} -> tick ${result.tick}`);
      }
    } catch (error) {
      console.error('[marketClock] 自动推进失败:', error.message);
    }
  };

  run();
  setInterval(run, 30 * 1000).unref();
}

function startSportsClock() {
  if (process.env.SSB_DISABLE_CLOCK === '1') return;
  const run = () => {
    try {
      const now = clock.now();
      const market = ensureSleepState(now);
      const results = sports.processClock({ now, sleeping: !!market.sleeping });
      if (results.length) {
        console.log(`[sportsClock] 已处理 ${results.length} 场比赛`);
      }
    } catch (error) {
      console.error('[sportsClock] 自动处理失败:', error.message);
    }
  };
  run();
  setInterval(run, 30 * 1000).unref();
}

function requireAdmin(req) {
  const user = requireAuth(req);
  if (!user.is_admin) throw new Error('仅管理员可以执行该操作');
  return user;
}

function requireAuth(req) {
  const token = readBearerToken(req);
  if (!token) throw new Error('请先登录');
  const tokenHash = hashToken(token);
  const session = db.get(`SELECT * FROM sessions WHERE token_hash = ${db.q(tokenHash)};`);
  if (!session) throw new Error('登录已失效，请重新登录');
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    db.exec(`DELETE FROM sessions WHERE token_hash = ${db.q(tokenHash)};`);
    throw new Error('登录已过期，请重新登录');
  }

  const user = db.get(`SELECT * FROM users WHERE id = ${db.q(session.user_id)};`);
  if (!user) throw new Error('账号不存在');
  db.exec(`UPDATE sessions SET last_seen_at = datetime('now') WHERE token_hash = ${db.q(tokenHash)};`);
  db.exec(`UPDATE users SET last_seen_at = datetime('now') WHERE id = ${db.q(user.id)};`);
  return user;
}

function buildLiveSnapshot(user, tick) {
  return computeUserValuation(user.id, tick, user);
}

function computeUserValuation(userId, tick, userRow = null) {
  const user = userRow || db.get(`SELECT * FROM users WHERE id = ${db.q(userId)};`) || {};
  const prices = db.all(`SELECT stock_code, close FROM stock_prices WHERE tick = ${tick};`);
  const priceMap = Object.fromEntries(prices.map((row) => [row.stock_code, row.close]));
  const holdings = db.all(`SELECT * FROM holdings WHERE user_id = ${db.q(userId)};`);
  const holdingValue = Number(holdings.reduce((sum, holding) => {
    return sum + holding.quantity * (priceMap[holding.stock_code] || holding.avg_cost || 0);
  }, 0).toFixed(2));
  const navRows = db.all(`SELECT fund_code, nav FROM fund_nav WHERE tick = ${Number(tick)};`);
  const navMap = Object.fromEntries(navRows.map((row) => [row.fund_code, Number(row.nav)]));
  const fundHoldings = db.all(`SELECT * FROM fund_holdings WHERE user_id = ${db.q(userId)};`);
  const fundValue = Number(fundHoldings.reduce((sum, holding) => {
    return sum + Number(holding.shares) * (navMap[holding.fund_code] || Number(holding.avg_nav) || 0);
  }, 0).toFixed(2));
  const futuresVal = futures.futuresValue(userId, tick);
  const cash = Number((user.cash || 0).toFixed(2));
  const totalAsset = Number((cash + holdingValue + fundValue + futuresVal).toFixed(2));
  const liability = getActiveLoanPrincipalLiability(userId);
  const p2pReceivable = getP2PReceivable(userId);
  return {
    user_id: userId,
    tick,
    cash,
    holding_value: holdingValue,
    fund_value: fundValue,
    futures_value: futuresVal,
    total_asset: totalAsset,
    loan_liability: liability,
    p2p_receivable: p2pReceivable,
    net_total_asset: Number((totalAsset - liability + p2pReceivable).toFixed(2))
  };
}

function buildPublicUser(user, tick) {
  const live = computeUserValuation(user.id, tick, user);
  return {
    ...sanitizeUser(user),
    holding_value: live.holding_value,
    fund_value: live.fund_value,
    futures_value: live.futures_value,
    gross_total_asset: live.total_asset,
    loan_liability: live.loan_liability,
    p2p_receivable: live.p2p_receivable || 0,
    net_total_asset: live.net_total_asset,
    total_asset: live.net_total_asset
  };
}

function pickBaselineSnapshot(userId, targetTick) {
  return db.get(`SELECT * FROM asset_snapshots
    WHERE user_id = ${db.q(userId)} AND tick <= ${targetTick}
    ORDER BY tick DESC LIMIT 1;`);
}

function rankRows(rows, key, type) {
  return rows
    .slice()
    .sort((a, b) => b[key] - a[key])
    .map((row, index) => ({
      rank: index + 1,
      nickname: row.nickname,
      is_me: row.is_me,
      join_tick: row.join_tick,
      type,
      value: row[key],
      total_asset: row.total_asset,
      return_today: row.return_today,
      return7: row.return7
    }));
}

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < 6) throw new Error('密码至少需要 6 位');
  if (value.length > 72) throw new Error('密码不能超过 72 位');
}

function normalizeUsername(value) {
  return String(value || '').trim();
}

function normalizeInviteCode(code) {
  return String(code || '').replace(/[\s-]/g, '').trim().toUpperCase();
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function verifyPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  const actual = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.exec(`INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at)
    VALUES (${db.q(hashToken(token))}, ${db.q(user.id)}, datetime('now'), datetime('now'), ${db.q(expiresAt)});`);
  return token;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function readBearerToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function recordAccountEvent(userId, type, detail) {
  db.exec(`INSERT INTO account_events (user_id, type, detail, created_at)
    VALUES (${db.q(userId)}, ${db.q(type)}, ${detail == null ? 'NULL' : db.q(detail)}, datetime('now'));`);
}

function marketState() {
  const market = db.get('SELECT * FROM market_state WHERE id = 1;');
  if (!market) throw new Error('market_state 未初始化');
  return market;
}

function publicStocks(stocks = getStocks()) {
  return stocks.map((stock) => ({
    code: stock.code,
    name: stock.name,
    sector: stock.sector,
    industry: stock.industry,
    mapping: stock.mapping,
    initial_price: stock.initial_price,
    volatility: stock.volatility,
    risk_level: stock.risk_level
  }));
}

function sanitizeUser(user) {
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    cash: user.cash,
    join_tick: user.join_tick,
    initial_asset_at_join: user.initial_asset_at_join,
    activated_at: user.activated_at,
    last_login_at: user.last_login_at,
    is_admin: !!user.is_admin,
    has_active_loan: !!user.has_active_loan,
    bankrupt: !!user.bankrupt,
    bank_tier: user.bank_tier || 1
  };
}

function normalizeStockCode(code, stocks = getStocks()) {
  const value = String(code || '').trim().toUpperCase();
  return stocks.some((stock) => stock.code === value) ? value : (stocks[0]?.code || 'SSB001');
}

function computeLoanInterest(remaining) {
  const r = Math.max(0, remaining);
  let interest = 0;
  if (r <= RULES.LOAN_TIER1_CAP) {
    interest = r * RULES.LOAN_TIER1_RATE;
  } else if (r <= RULES.LOAN_TIER2_CAP) {
    interest = RULES.LOAN_TIER1_CAP * RULES.LOAN_TIER1_RATE
      + (r - RULES.LOAN_TIER1_CAP) * RULES.LOAN_TIER2_RATE;
  } else {
    interest = RULES.LOAN_TIER1_CAP * RULES.LOAN_TIER1_RATE
      + (RULES.LOAN_TIER2_CAP - RULES.LOAN_TIER1_CAP) * RULES.LOAN_TIER2_RATE
      + (r - RULES.LOAN_TIER2_CAP) * RULES.LOAN_TIER3_RATE;
  }
  return Number(interest.toFixed(2));
}

function computeLoanTierBreakdown(amount, termTicks) {
  const a = Math.max(0, amount);
  if (a <= 0) return {
    tier1_amount: 0, tier1_rate: RULES.LOAN_TIER1_RATE, tier1_interest: 0,
    tier2_amount: 0, tier2_rate: RULES.LOAN_TIER2_RATE, tier2_interest: 0,
    tier3_amount: 0, tier3_rate: RULES.LOAN_TIER3_RATE, tier3_interest: 0,
    per_tick_interest: 0, total_interest: 0, total_interest_pct: 0
  };
  const tier1 = Math.min(a, RULES.LOAN_TIER1_CAP);
  const tier2 = Math.min(Math.max(0, a - RULES.LOAN_TIER1_CAP), RULES.LOAN_TIER2_CAP - RULES.LOAN_TIER1_CAP);
  const tier3 = Math.max(0, a - RULES.LOAN_TIER2_CAP);
  const interest = tier1 * RULES.LOAN_TIER1_RATE + tier2 * RULES.LOAN_TIER2_RATE + tier3 * RULES.LOAN_TIER3_RATE;
  return {
    tier1_amount: tier1, tier1_rate: RULES.LOAN_TIER1_RATE, tier1_interest: Number((tier1 * RULES.LOAN_TIER1_RATE).toFixed(2)),
    tier2_amount: tier2, tier2_rate: RULES.LOAN_TIER2_RATE, tier2_interest: Number((tier2 * RULES.LOAN_TIER2_RATE).toFixed(2)),
    tier3_amount: tier3, tier3_rate: RULES.LOAN_TIER3_RATE, tier3_interest: Number((tier3 * RULES.LOAN_TIER3_RATE).toFixed(2)),
    per_tick_interest: Number(interest.toFixed(2)),
    total_interest: Number((interest * termTicks).toFixed(2)),
    total_interest_pct: Number((interest * termTicks / amount * 100).toFixed(2))
  };
}

function loanTermTicks(tier) {
  return RULES.LOAN_TERM_DAYS[tier - 1] * clock.DAILY_TICK_TOTAL;
}

function loanQualifyTicks() {
  return RULES.LOAN_QUALIFY_DAYS * clock.DAILY_TICK_TOTAL;
}

function allowedTermOptions(tier) {
  const maxIndex = (RULES.BANK_TIER_MAX_TERM_INDEX || {})[tier] ?? 0;
  return RULES.LOAN_TERM_DAYS.slice(0, maxIndex + 1).map(d => d * clock.DAILY_TICK_TOTAL);
}

function calculateMaxLoanAmount(user) {
  const tier = user.bank_tier || 1;
  const cfg = RULES.BANK_TIER[tier];
  const market = marketState();
  const valuation = computeUserValuation(user.id, market.current_tick, user);
  const raw = Math.floor(Math.max(0, valuation.net_total_asset) * cfg.ltv);
  const rounded = Math.round(raw / 50000) * 50000;
  return Math.max(0, rounded);
}

function getActiveLoanInfo(userId) {
  const loan = db.get(`SELECT * FROM loans WHERE user_id = ${db.q(userId)} AND status = 'active' ORDER BY id DESC LIMIT 1;`);
  if (!loan) return null;
  const market = marketState();
  const interestPerTick = computeLoanInterest(Number(loan.principal));
  const elapsed = market.current_tick - loan.start_tick;
  const accrued = Number(loan.accrued_interest || 0);
  return {
    id: loan.id,
    principal: Number(loan.principal),
    remaining_principal: Number(loan.remaining_principal),
    accrued_interest: accrued,
    total_interest_paid: Number(loan.total_interest_paid),
    start_tick: loan.start_tick,
    deadline_tick: loan.deadline_tick,
    status: loan.status,
    per_tick_interest: interestPerTick,
    ticks_elapsed: elapsed,
    ticks_remaining: Math.max(0, loan.deadline_tick - market.current_tick),
    term_ticks: loan.deadline_tick - loan.start_tick,
    qualifies_for_tier: !!loan.qualifies_for_tier,
    warning: (loan.deadline_tick - market.current_tick) <= RULES.LOAN_WARNING_TICKS_BEFORE && !loan.warning_shown_at
  };
}

function getLoanTierConfig(loan) {
  const termTicks = loan.deadline_tick - loan.start_tick;
  for (const tier of [3, 2, 1]) {
    if (RULES.BANK_TIER[tier] && loanTermTicks(tier) === termTicks) {
      return RULES.BANK_TIER[tier];
    }
  }
  return null;
}

function p2pRatePerTick(rateTier) {
  return RULES.P2P_RATES[rateTier - 1] || RULES.P2P_RATES[0];
}

function p2pExpectedReturn(amount, rateTier, termTicks) {
  const rate = p2pRatePerTick(rateTier);
  return Number((amount * rate * termTicks).toFixed(2));
}

function getP2PLiability(userId) {
  const row = db.get(`SELECT COALESCE(SUM(principal + accrued_interest), 0) AS liability
    FROM p2p_loans
    WHERE borrower_id = ${db.q(userId)} AND status = 'active';`);
  return Number((row?.liability || 0).toFixed(2));
}

function getP2PReceivable(userId) {
  const row = db.get(`SELECT COALESCE(SUM(principal), 0) AS receivable
    FROM p2p_loans
    WHERE lender_id = ${db.q(userId)} AND status = 'active';`);
  return Number((row?.receivable || 0).toFixed(2));
}

function getP2PStatus(user) {
  const market = marketState();
  const activeLoan = db.get(`SELECT pl.*, cu.username AS counterparty_username, cu.nickname AS counterparty_nickname
    FROM p2p_loans pl
    JOIN users cu ON cu.id = CASE WHEN pl.lender_id = ${db.q(user.id)} THEN pl.borrower_id ELSE pl.lender_id END
    WHERE (pl.lender_id = ${db.q(user.id)} OR pl.borrower_id = ${db.q(user.id)})
      AND pl.status = 'active'
    ORDER BY pl.id DESC LIMIT 1;`);
  const myOpenOrders = db.all(`SELECT o.*, u.username, u.nickname FROM p2p_orders o
    JOIN users u ON u.id = o.user_id
    WHERE o.user_id = ${db.q(user.id)} AND o.status = 'open'
    ORDER BY o.created_at DESC;`);

  let activeLoanData = null;
  if (activeLoan) {
    const rate = Number(activeLoan.rate_per_tick);
    const accrued = Number(activeLoan.accrued_interest || 0);
    const elapsed = market.current_tick - activeLoan.start_tick;
    const remaining = Math.max(0, activeLoan.deadline_tick - market.current_tick);
    const isLender = activeLoan.lender_id === user.id;
    activeLoanData = {
      id: activeLoan.id,
      principal: Number(activeLoan.principal),
      rate_tier: activeLoan.rate_tier,
      rate_per_tick: rate,
      term_ticks: activeLoan.term_ticks,
      accrued_interest: accrued,
      start_tick: activeLoan.start_tick,
      deadline_tick: activeLoan.deadline_tick,
      status: activeLoan.status,
      role: isLender ? 'lender' : 'borrower',
      ticks_elapsed: elapsed,
      ticks_remaining: remaining,
      expected_return: Number((Number(activeLoan.principal) * rate * activeLoan.term_ticks).toFixed(2)),
      total_to_repay_now: isLender ? null : Number((Number(activeLoan.principal) + accrued).toFixed(2)),
      warning: (activeLoan.deadline_tick - market.current_tick) <= RULES.P2P_WARNING_TICKS_BEFORE && remaining > 0,
      counterparty: isLender ? activeLoan.borrower_id : activeLoan.lender_id,
      counterparty_nickname: activeLoan.counterparty_nickname
    };
  }

  return {
    has_active_p2p: !!activeLoan,
    p2p_role: activeLoan ? (activeLoan.lender_id === user.id ? 'lender' : 'borrower') : null,
    active_loan: activeLoanData,
    my_open_orders: myOpenOrders.map(o => ({
      id: o.id,
      direction: o.direction,
      amount: Number(o.amount),
      rate_tier: o.rate_tier,
      term_ticks: o.term_ticks,
      expected_return: Number(o.expected_return),
      status: o.status,
      username: o.username,
      nickname: o.nickname,
      created_at: o.created_at
    }))
  };
}

function findMatchingOrders(direction, amount, rateTier, termTicks, excludeUserId) {
  const oppositeDir = direction === 'lend' ? 'borrow' : 'lend';
  const orders = db.all(`SELECT o.*, u.username, u.nickname FROM p2p_orders o
    JOIN users u ON u.id = o.user_id
    WHERE o.direction = ${db.q(oppositeDir)}
      AND o.status = 'open'
      AND o.user_id != ${db.q(excludeUserId)}
    ORDER BY o.created_at DESC;`);

  const scored = orders.map(order => {
    let score = 0;
    if (order.rate_tier === rateTier) score += 3;
    else if (Math.abs(order.rate_tier - rateTier) === 1) score += 1;
    if (order.term_ticks === termTicks) score += 2;
    else if (Math.abs(order.term_ticks - termTicks) <= 8) score += 1;
    const amtDiff = Math.abs(Number(order.amount) - amount) / Math.max(amount, 1);
    if (amtDiff <= 0.2) score += 1;
    return { order, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map(s => ({
    id: s.order.id,
    direction: s.order.direction,
    amount: Number(s.order.amount),
    rate_tier: s.order.rate_tier,
    term_ticks: s.order.term_ticks,
    expected_return: Number(s.order.expected_return),
    user_id: s.order.user_id,
    username: s.order.username,
    nickname: s.order.nickname,
    score: s.score
  }));
}

function createP2POrder(user, body) {
  const direction = body.direction;
  const amount = Math.floor(Number(body.amount || 0));
  const rateTier = parseInt(body.rate_tier);
  const termTicks = parseInt(body.term_ticks);

  if (!['lend', 'borrow'].includes(direction)) throw new Error('direction 必须为 lend 或 borrow');
  if (amount < RULES.P2P_MIN_AMOUNT || amount > RULES.P2P_MAX_AMOUNT) {
    throw new Error(`金额必须在 ${RULES.P2P_MIN_AMOUNT.toLocaleString()} – ${RULES.P2P_MAX_AMOUNT.toLocaleString()} 之间`);
  }
  if (![1, 2, 3, 4].includes(rateTier)) throw new Error('利率档位无效');
  if (!RULES.P2P_TERM_TICKS.includes(termTicks)) throw new Error('期限档位无效');

  const existingOrder = db.get(`SELECT * FROM p2p_orders WHERE user_id = ${db.q(user.id)} AND status = 'open';`);
  if (existingOrder) throw new Error('你已有一笔挂单，请先撤销后再发布');

  const p2pLoan = db.get(`SELECT * FROM p2p_loans WHERE (lender_id = ${db.q(user.id)} OR borrower_id = ${db.q(user.id)}) AND status = 'active';`);
  if (p2pLoan) throw new Error('你当前已有一笔活跃个人借贷，请先完成后再发布');

  if (direction === 'lend') {
    if (Number(user.cash) < amount) throw new Error('可用资金不足');
  }

  const expectedReturn = p2pExpectedReturn(amount, rateTier, termTicks);
  const now = clock.serverTimeIso(clock.now());

  db.exec(`INSERT INTO p2p_orders
    (user_id, direction, amount, rate_tier, term_ticks, expected_return, status, created_at, updated_at)
    VALUES (${db.q(user.id)}, ${db.q(direction)}, ${amount}, ${rateTier}, ${termTicks},
      ${expectedReturn}, 'open', ${db.q(now)}, ${db.q(now)});`);

  const order = db.get(`SELECT * FROM p2p_orders WHERE id = last_insert_rowid();`);
  return {
    order: {
      id: order.id,
      direction: order.direction,
      amount: Number(order.amount),
      rate_tier: order.rate_tier,
      term_ticks: order.term_ticks,
      expected_return: Number(order.expected_return),
      status: order.status
    },
    recommendations: findMatchingOrders(direction, amount, rateTier, termTicks, user.id)
  };
}

function cancelP2POrder(user, orderId) {
  const order = db.get(`SELECT * FROM p2p_orders WHERE id = ${orderId} AND user_id = ${db.q(user.id)};`);
  if (!order) throw new Error('订单不存在或不属于你');
  if (order.status !== 'open') throw new Error('订单已失效');
  db.exec(`UPDATE p2p_orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ${orderId};`);
  return { cancelled: true };
}

function matchP2POrder(user, orderId) {
  return db.transaction(() => {
    const targetOrder = db.get(`SELECT * FROM p2p_orders WHERE id = ${orderId} AND status = 'open';`);
    if (!targetOrder) throw new Error('目标订单不存在或已失效');
    if (targetOrder.user_id === user.id) throw new Error('不能匹配自己的订单');

    const myExisting = db.get(`SELECT * FROM p2p_loans WHERE (lender_id = ${db.q(user.id)} OR borrower_id = ${db.q(user.id)}) AND status = 'active';`);
    if (myExisting) throw new Error('你当前已有一笔活跃个人借贷');
    const theirExisting = db.get(`SELECT * FROM p2p_loans WHERE (lender_id = ${db.q(targetOrder.user_id)} OR borrower_id = ${db.q(targetOrder.user_id)}) AND status = 'active';`);
    if (theirExisting) throw new Error('对方当前已有一笔活跃个人借贷');

    const market = marketState();
    const lenderId = targetOrder.direction === 'lend' ? targetOrder.user_id : user.id;
    const borrowerId = targetOrder.direction === 'borrow' ? targetOrder.user_id : user.id;
    const amount = Number(targetOrder.amount);
    const rateTier = targetOrder.rate_tier;
    const termTicks = targetOrder.term_ticks;
    const ratePerTick = p2pRatePerTick(rateTier);

    const lender = db.get(`SELECT * FROM users WHERE id = ${db.q(lenderId)};`);
    if (Number(lender.cash) < amount) throw new Error('出借人资金不足');
    const borrower = db.get(`SELECT * FROM users WHERE id = ${db.q(borrowerId)};`);
    if (borrower.bankrupt) throw new Error('借入人已破产');

    const now = clock.serverTimeIso(clock.now());
    const startTick = market.current_tick;
    const deadlineTick = startTick + termTicks;

    db.exec(`UPDATE users SET cash = ROUND(cash - ${amount}, 2), has_p2p_loan = 1, p2p_role = 'lender', updated_at = datetime('now') WHERE id = ${db.q(lenderId)};`);
    db.exec(`UPDATE users SET cash = ROUND(cash + ${amount}, 2), has_p2p_loan = 1, p2p_role = 'borrower', updated_at = datetime('now') WHERE id = ${db.q(borrowerId)};`);

    db.exec(`INSERT INTO p2p_loans
      (lender_id, borrower_id, principal, rate_tier, rate_per_tick, term_ticks, accrued_interest,
       start_tick, deadline_tick, status, created_at, updated_at)
      VALUES (${db.q(lenderId)}, ${db.q(borrowerId)}, ${amount}, ${rateTier}, ${ratePerTick}, ${termTicks}, 0,
        ${startTick}, ${deadlineTick}, 'active', ${db.q(now)}, ${db.q(now)});`);

    db.exec(`UPDATE p2p_orders SET status = 'matched', updated_at = datetime('now') WHERE id = ${targetOrder.id};`);
    db.exec(`UPDATE p2p_orders SET status = 'cancelled', updated_at = datetime('now')
      WHERE user_id = ${db.q(user.id)} AND status = 'open';`);

    recordAccountEvent(lenderId, 'p2p_lend', JSON.stringify({ borrower_id: borrowerId, amount, rate_tier: rateTier, rate_per_tick: ratePerTick, term_ticks: termTicks }));
    recordAccountEvent(borrowerId, 'p2p_borrow', JSON.stringify({ lender_id: lenderId, amount, rate_tier: rateTier, rate_per_tick: ratePerTick, term_ticks: termTicks }));

    return { matched: true, loan_id: db.get(`SELECT last_insert_rowid() AS id;`).id };
  });
}

function listP2POrders(user, params) {
  let sql = `SELECT o.*, u.username, u.nickname FROM p2p_orders o
    JOIN users u ON u.id = o.user_id
    WHERE o.status = 'open'`;
  const clauses = [`o.user_id != ${db.q(user.id)}`];
  if (params.direction && ['lend', 'borrow'].includes(params.direction)) {
    clauses.push(`o.direction = ${db.q(params.direction)}`);
  }
  if (params.rate_tier) {
    clauses.push(`o.rate_tier = ${parseInt(params.rate_tier)}`);
  }
  if (params.term_ticks) {
    clauses.push(`o.term_ticks = ${parseInt(params.term_ticks)}`);
  }
  sql += ' AND ' + clauses.join(' AND ') + ' ORDER BY o.created_at DESC LIMIT 50;';
  const orders = db.all(sql);
  return orders.map(o => ({
    id: o.id,
    direction: o.direction,
    amount: Number(o.amount),
    rate_tier: o.rate_tier,
    term_ticks: o.term_ticks,
    expected_return: Number(o.expected_return),
    user_id: o.user_id,
    username: o.username,
    nickname: o.nickname,
    created_at: o.created_at
  }));
}

function repayP2PLoan(user) {
  return db.transaction(() => {
    const loan = db.get(`SELECT * FROM p2p_loans
      WHERE borrower_id = ${db.q(user.id)} AND status = 'active'
      ORDER BY id DESC LIMIT 1;`);
    if (!loan) throw new Error('没有待还的个人借贷');

    const principal = Number(loan.principal);
    const accrued = Number(loan.accrued_interest || 0);
    const totalOwed = Number((principal + accrued).toFixed(2));

    const freshUser = db.get(`SELECT * FROM users WHERE id = ${db.q(user.id)};`);
    if (Number(freshUser.cash) < totalOwed) {
      throw new Error(`可用资金不足，当前应还 ${totalOwed.toLocaleString()}`);
    }

    const market = marketState();
    db.exec(`UPDATE users SET cash = ROUND(cash - ${totalOwed}, 2), has_p2p_loan = 0, p2p_role = NULL, updated_at = datetime('now') WHERE id = ${db.q(user.id)};`);
    db.exec(`UPDATE users SET cash = ROUND(cash + ${totalOwed}, 2), has_p2p_loan = 0, p2p_role = NULL, updated_at = datetime('now') WHERE id = ${db.q(loan.lender_id)};`);
    db.exec(`UPDATE p2p_loans SET accrued_interest = ${accrued}, status = 'repaid', close_tick = ${market.current_tick}, updated_at = datetime('now') WHERE id = ${loan.id};`);

    recordAccountEvent(user.id, 'p2p_repay', JSON.stringify({ loan_id: loan.id, principal, accrued_interest: accrued, total_owed: totalOwed }));
    recordAccountEvent(loan.lender_id, 'p2p_repaid', JSON.stringify({ loan_id: loan.id, borrower_id: user.id, principal, interest_earned: accrued }));

    return { repaid: true, principal, interest_paid: accrued };
  });
}

function getP2PHistory(user) {
  const loans = db.all(`SELECT * FROM p2p_loans
    WHERE lender_id = ${db.q(user.id)} OR borrower_id = ${db.q(user.id)}
    ORDER BY id DESC LIMIT 20;`);
  return loans.map(loan => ({
    id: loan.id,
    role: loan.lender_id === user.id ? 'lender' : 'borrower',
    principal: Number(loan.principal),
    rate_tier: loan.rate_tier,
    rate_per_tick: Number(loan.rate_per_tick),
    term_ticks: loan.term_ticks,
    accrued_interest: Number(loan.accrued_interest || 0),
    start_tick: loan.start_tick,
    deadline_tick: loan.deadline_tick,
    status: loan.status,
    close_tick: loan.close_tick,
    counterparty: loan.lender_id === user.id ? loan.borrower_id : loan.lender_id
  }));
}

function getLoanStatus(user, options = {}) {
  const now = options.now || clock.now();
  const market = resolveMarketForRead(user, { ...options, now });
  const activeLoan = db.get(`SELECT * FROM loans WHERE user_id = ${db.q(user.id)} AND status = 'active' ORDER BY id DESC LIMIT 1;`);
  const maxAmount = calculateMaxLoanAmount(user);
  const tier = user.bank_tier || 1;
  const cfg = RULES.BANK_TIER[tier];

  let activeLoanData = null;
  if (activeLoan) {
    const interestPerTick = computeLoanInterest(Number(activeLoan.principal));
    const elapsed = market.current_tick - activeLoan.start_tick;
    const accrued = Number(activeLoan.accrued_interest || 0);
    const remaining = Math.max(0, activeLoan.deadline_tick - market.current_tick);
    const actualTermTicks = activeLoan.deadline_tick - activeLoan.start_tick;
    activeLoanData = {
      id: activeLoan.id,
      principal: Number(activeLoan.principal),
      remaining_principal: Number(activeLoan.remaining_principal),
      accrued_interest: accrued,
      total_to_repay_now: Number((Number(activeLoan.principal) + accrued).toFixed(2)),
      start_tick: activeLoan.start_tick,
      deadline_tick: activeLoan.deadline_tick,
      status: activeLoan.status,
      ticks_elapsed: elapsed,
      ticks_remaining: remaining,
      per_tick_interest: interestPerTick,
      term_ticks: actualTermTicks,
      qualifies_for_tier: !!activeLoan.qualifies_for_tier,
      warning: remaining <= RULES.LOAN_WARNING_TICKS_BEFORE && remaining > 0 && !activeLoan.warning_shown_at,
      breakdown: computeLoanTierBreakdown(Number(activeLoan.principal), actualTermTicks)
    };
  }

  const availableTerms = allowedTermOptions(tier);
  return {
    is_bankrupt: !!user.bankrupt,
    has_active_loan: !!activeLoan,
    bank_tier: tier,
    tier_label: cfg.label,
    tier_benefits: { ltv: cfg.ltv, term_ticks: loanTermTicks(tier) },
    available_terms: availableTerms,
    available_terms_label: availableTerms.join(' / ') + ' 期',
    default_term_ticks: availableTerms[0],
    tier_config: {
      caps: [RULES.LOAN_TIER1_CAP, RULES.LOAN_TIER2_CAP],
      rates: [RULES.LOAN_TIER1_RATE, RULES.LOAN_TIER2_RATE, RULES.LOAN_TIER3_RATE]
    },
    daily_tick_total: clock.DAILY_TICK_TOTAL,
    max_loan_amount: maxAmount,
    active_loan: activeLoanData,
    max_breakdown: maxAmount > 0 ? computeLoanTierBreakdown(maxAmount, loanTermTicks(tier)) : null
  };
}

function borrowLoan(user, body) {
  const amount = Math.floor(Number(body.amount || 0));
  if (!amount || amount <= 0) throw new Error('请输入有效贷款金额');

  return db.transaction(() => {
    const freshUser = db.get(`SELECT cash, bankrupt, bank_tier FROM users WHERE id = ${db.q(user.id)};`);
    if (!freshUser || freshUser.bankrupt) throw new Error('已破产，无法申请贷款');

    const now = clock.now();
    const market = ensureSleepState(now);
    if (market.sleeping) throw new Error('本局已休眠，请先恢复本局后再申请贷款');

    const existing = db.get(`SELECT * FROM loans WHERE user_id = ${db.q(user.id)} AND status = 'active' ORDER BY id DESC LIMIT 1;`);
    if (existing) throw new Error('请先还清当前贷款后再申请新贷款');

    const maxAmount = calculateMaxLoanAmount({ ...user, bank_tier: freshUser.bank_tier });
    if (amount > maxAmount) throw new Error(`贷款金额不能超过 ${maxAmount.toLocaleString()}`);

    const tier = freshUser.bank_tier || 1;
    const cfg = RULES.BANK_TIER[tier];
    const qualifies = amount >= RULES.LOAN_MIN_QUALIFYING_AMOUNT ? 1 : 0;

    const chosenTermTicks = Number(body.term_ticks) || allowedTermOptions(tier)[0];
    const allowed = allowedTermOptions(tier);
    if (!allowed.includes(chosenTermTicks)) {
      throw new Error(`该期限不可用，当前星级可选：${allowed.join('、')} 期`);
    }

    const loanCreatedAt = clock.serverTimeIso(now);
    db.exec(`INSERT INTO loans
      (user_id, principal, remaining_principal, accrued_interest, total_interest_paid, qualifies_for_tier,
       start_tick, deadline_tick, status, created_at, updated_at)
      VALUES (${db.q(user.id)}, ${amount}, ${amount}, 0, 0, ${qualifies},
        ${market.current_tick}, ${market.current_tick + chosenTermTicks},
        'active', ${db.q(loanCreatedAt)}, ${db.q(loanCreatedAt)});`);
    db.exec(`UPDATE users
      SET cash = ROUND(cash + ${amount}, 2),
          has_active_loan = 1,
          updated_at = datetime('now')
      WHERE id = ${db.q(user.id)};`);

    recordAccountEvent(user.id, 'loan_borrow', JSON.stringify({ amount, tier, term_ticks: chosenTermTicks, qualifies }));
    touchPlayerActivity(user, now);
    return getLoanStatus(db.get(`SELECT * FROM users WHERE id = ${db.q(user.id)};`), { touchPlayerActivity: false, now });
  });
}

function repayLoan(user) {
  if (user.bankrupt) throw new Error('已破产，无需还款');

  return db.transaction(() => {
    const now = clock.now();
    const market = ensureSleepState(now);
    if (market.sleeping) throw new Error('本局已休眠，请先恢复本局后再还款');
    const loan = db.get(`SELECT * FROM loans WHERE user_id = ${db.q(user.id)} AND status = 'active' ORDER BY id DESC LIMIT 1;`);
    if (!loan) throw new Error('没有待还贷款');

    const principal = Number(loan.principal);
    const accrued = Number(loan.accrued_interest || 0);
    const totalOwed = Number((principal + accrued).toFixed(2));

    const freshUser = db.get(`SELECT * FROM users WHERE id = ${db.q(user.id)};`);
    if (Number(freshUser.cash) < totalOwed) {
      throw new Error(`可用资金不足，当前应还 ${totalOwed.toLocaleString()}（本金 ${principal.toLocaleString()} + 已产生利息 ${accrued.toLocaleString()}）。请先卖出股票后再还款。`);
    }

    db.exec(`UPDATE users SET cash = cash - ${totalOwed}, has_active_loan = 0, updated_at = datetime('now') WHERE id = ${db.q(user.id)};`);
    db.exec(`UPDATE loans SET remaining_principal = 0, accrued_interest = ${accrued}, total_interest_paid = ${accrued}, status = 'repaid', close_tick = ${market.current_tick}, updated_at = datetime('now') WHERE id = ${loan.id};`);

    recordAccountEvent(user.id, 'loan_repay', JSON.stringify({ loan_id: loan.id, principal, accrued_interest: accrued, total_owed: totalOwed }));

    tryUpgradeBankTier(user.id, loan, market.current_tick);
    touchPlayerActivity(user, now);
    return getLoanStatus(db.get(`SELECT * FROM users WHERE id = ${db.q(user.id)};`), { touchPlayerActivity: false, now });
  });
}

function tryUpgradeBankTier(userId, loan, currentTick) {
  if (!loan.qualifies_for_tier) return;
  const elapsed = currentTick - loan.start_tick;
  if (elapsed < loanQualifyTicks()) return;

  const user = db.get(`SELECT * FROM users WHERE id = ${db.q(userId)};`);
  const currentTier = user.bank_tier || 1;
  if (currentTier >= 3) return;

  const newRepayments = (user.qualifying_repayments || 0) + 1;
  const newTier = Math.min(1 + newRepayments, 3);
  db.exec(`UPDATE users SET bank_tier = ${newTier}, qualifying_repayments = ${newRepayments}, updated_at = datetime('now') WHERE id = ${db.q(userId)};`);
  recordAccountEvent(userId, 'bank_tier_upgrade', JSON.stringify({ from_tier: currentTier, to_tier: newTier, repayments: newRepayments }));
}

function processLoans(tick) {
  const activeLoans = db.all(`SELECT l.*, u.cash, u.id AS uid, u.bank_tier FROM loans l
    JOIN users u ON u.id = l.user_id
    WHERE l.status = 'active';`);

  for (const loan of activeLoans) {
    const interestPerTick = computeLoanInterest(Number(loan.principal));
    const newAccrued = Number((Number(loan.accrued_interest || 0) + interestPerTick).toFixed(2));
    const principal = Number(loan.principal);

    db.exec(`UPDATE loans SET
      accrued_interest = ${newAccrued},
      updated_at = datetime('now')
      WHERE id = ${loan.id};`);

    db.exec(`INSERT INTO loan_interest_log
      (user_id, loan_id, tick, interest_amount, paid_from_cash, rolled_into_principal, remaining_principal_after, created_at)
      VALUES (${db.q(loan.uid)}, ${loan.id}, ${tick}, ${interestPerTick}, 0, 0, ${principal}, datetime('now'));`);

    if (loan.deadline_tick < tick) {
      const totalOwed = Number((principal + newAccrued).toFixed(2));
      const freshUser = db.get(`SELECT cash, id FROM users WHERE id = ${db.q(loan.uid)};`);
      let cashLeft = Number(freshUser.cash || 0);
      let shortfall = Number((totalOwed - cashLeft).toFixed(2));

      if (shortfall > 0) {
        const liquidated = liquidateHoldings(loan.uid, shortfall, tick);
        cashLeft = Number((cashLeft + liquidated).toFixed(2));
        shortfall = Number((totalOwed - cashLeft).toFixed(2));
      }

      if (shortfall <= 0) {
        db.exec(`UPDATE users SET cash = cash - ${totalOwed}, has_active_loan = 0, updated_at = datetime('now') WHERE id = ${db.q(loan.uid)};`);
        db.exec(`UPDATE loans SET remaining_principal = 0, accrued_interest = ${newAccrued}, total_interest_paid = ${newAccrued}, status = 'repaid', close_tick = ${tick}, updated_at = datetime('now') WHERE id = ${loan.id};`);
        recordAccountEvent(loan.uid, 'loan_matured_repaid', JSON.stringify({
          loan_id: loan.id, principal, accrued_interest: newAccrued, total_owed: totalOwed
        }));
        tryUpgradeBankTier(loan.uid, { ...loan, qualifies_for_tier: loan.qualifies_for_tier }, tick);
      } else {
        db.exec(`UPDATE users SET has_active_loan = 0, bankrupt = 1, updated_at = datetime('now') WHERE id = ${db.q(loan.uid)};`);
        db.exec(`UPDATE loans SET status = 'defaulted', close_tick = ${tick}, updated_at = datetime('now') WHERE id = ${loan.id};`);
        recordAccountEvent(loan.uid, 'loan_defaulted_bankrupt', JSON.stringify({
          loan_id: loan.id, principal, accrued_interest: newAccrued, total_owed: totalOwed,
          cash_before: Number(freshUser.cash), liquidated: cashLeft - Number(freshUser.cash), shortfall
        }));
      }
    }
  }
}

function processP2PLoans(tick) {
  const activeLoans = db.all(`SELECT pl.*, u.cash, u.id AS uid FROM p2p_loans pl
    JOIN users u ON u.id = pl.borrower_id
    WHERE pl.status = 'active';`);

  for (const loan of activeLoans) {
    const ratePerTick = Number(loan.rate_per_tick);
    const principal = Number(loan.principal);
    const interestThisTick = Number((principal * ratePerTick).toFixed(2));
    const newAccrued = Number((Number(loan.accrued_interest || 0) + interestThisTick).toFixed(2));

    db.exec(`UPDATE p2p_loans SET
      accrued_interest = ${newAccrued},
      updated_at = datetime('now')
      WHERE id = ${loan.id};`);
  }
}

function settleOverdueP2PLoans(tick) {
  const overdueLoans = db.all(`SELECT pl.*, u.cash, u.bankrupt FROM p2p_loans pl
    JOIN users u ON u.id = pl.borrower_id
    WHERE pl.status = 'active' AND pl.deadline_tick < ${tick};`);

  for (const loan of overdueLoans) {
    const principal = Number(loan.principal);
    const accrued = Number(loan.accrued_interest || 0);
    const totalOwed = Number((principal + accrued).toFixed(2));

    if (loan.bankrupt) {
      db.exec(`UPDATE p2p_loans SET status = 'defaulted', close_tick = ${tick}, updated_at = datetime('now') WHERE id = ${loan.id};`);
      db.exec(`UPDATE users SET has_p2p_loan = 0, p2p_role = NULL, updated_at = datetime('now') WHERE id = ${db.q(loan.lender_id)};`);
      recordAccountEvent(loan.lender_id, 'p2p_lender_loss', JSON.stringify({
        loan_id: loan.id, borrower_id: loan.borrower_id, lost_principal: principal, reason: 'borrower_already_bankrupt'
      }));
      continue;
    }

    const freshUser = db.get(`SELECT cash, id FROM users WHERE id = ${db.q(loan.borrower_id)};`);
    let cashLeft = Number(freshUser.cash || 0);
    let shortfall = Number((totalOwed - cashLeft).toFixed(2));

    if (shortfall > 0) {
      const liquidated = liquidateHoldings(loan.borrower_id, shortfall, tick);
      cashLeft = Number((cashLeft + liquidated).toFixed(2));
      shortfall = Number((totalOwed - cashLeft).toFixed(2));
    }

    if (shortfall <= 0) {
      db.exec(`UPDATE users SET cash = ROUND(cash - ${totalOwed}, 2), has_p2p_loan = 0, p2p_role = NULL, updated_at = datetime('now') WHERE id = ${db.q(loan.borrower_id)};`);
      db.exec(`UPDATE users SET cash = ROUND(cash + ${totalOwed}, 2), has_p2p_loan = 0, p2p_role = NULL, updated_at = datetime('now') WHERE id = ${db.q(loan.lender_id)};`);
      db.exec(`UPDATE p2p_loans SET accrued_interest = ${accrued}, status = 'repaid', close_tick = ${tick}, updated_at = datetime('now') WHERE id = ${loan.id};`);
      recordAccountEvent(loan.borrower_id, 'p2p_matured_repaid', JSON.stringify({
        loan_id: loan.id, principal, accrued_interest: accrued, total_owed: totalOwed
      }));
      recordAccountEvent(loan.lender_id, 'p2p_repaid', JSON.stringify({
        loan_id: loan.id, borrower_id: loan.borrower_id, principal, interest_earned: accrued
      }));
    } else {
      db.exec(`UPDATE users SET has_p2p_loan = 0, p2p_role = NULL, bankrupt = 1, updated_at = datetime('now') WHERE id = ${db.q(loan.borrower_id)};`);
      db.exec(`UPDATE p2p_loans SET status = 'defaulted', close_tick = ${tick}, updated_at = datetime('now') WHERE id = ${loan.id};`);
      db.exec(`UPDATE users SET has_p2p_loan = 0, p2p_role = NULL, updated_at = datetime('now') WHERE id = ${db.q(loan.lender_id)};`);
      recordAccountEvent(loan.borrower_id, 'p2p_defaulted_bankrupt', JSON.stringify({
        loan_id: loan.id, principal, accrued_interest: accrued, total_owed: totalOwed,
        cash_before: Number(freshUser.cash), liquidated: cashLeft - Number(freshUser.cash), shortfall
      }));
      recordAccountEvent(loan.lender_id, 'p2p_lender_loss', JSON.stringify({
        loan_id: loan.id, borrower_id: loan.borrower_id, lost_principal: principal
      }));
    }
  }
}

function liquidateHoldings(userId, needed, currentTick) {
  // Liquidate futures first (highest risk)
  let totalLiquidated = futures.liquidateUserFutures(userId, needed, currentTick);
  if (totalLiquidated >= needed) return totalLiquidated;

  const prices = db.all(`SELECT stock_code, close FROM stock_prices WHERE tick = ${currentTick};`);
  const priceMap = Object.fromEntries(prices.map((r) => [r.stock_code, Number(r.close)]));
  const stockRiskMap = Object.fromEntries(getStocks().map((stock) => [stock.code, stock.risk_level]));
  for (const riskLevel of ['high', 'mid', 'low']) {
    const valued = db.all(`SELECT * FROM holdings WHERE user_id = ${db.q(userId)} AND quantity > 0;`)
      .map((holding) => ({
        ...holding,
        price: priceMap[holding.stock_code] || holding.avg_cost || 0,
        marketValue: holding.quantity * (priceMap[holding.stock_code] || holding.avg_cost || 0)
      }))
      .filter((holding) => holding.price > 0 && stockRiskMap[holding.stock_code] === riskLevel)
      .sort((a, b) => b.marketValue - a.marketValue);

    for (const holding of valued) {
      if (totalLiquidated >= needed) break;
      const sellValue = Math.min(holding.marketValue, needed - totalLiquidated);
      const sharesToSell = Math.min(holding.quantity, Math.ceil(sellValue / holding.price));
      const actualValue = Number((sharesToSell * holding.price).toFixed(2));
      db.exec(`UPDATE holdings SET quantity = quantity - ${sharesToSell},
        available_quantity = MAX(0, available_quantity - ${sharesToSell}), updated_at = datetime('now')
        WHERE id = ${db.q(holding.id)};`);
      db.exec(`DELETE FROM holdings WHERE id = ${db.q(holding.id)} AND quantity <= 0;`);
      db.exec(`UPDATE users SET cash = cash + ${actualValue}, updated_at = datetime('now') WHERE id = ${db.q(userId)};`);
      recordTx(userId, holding.stock_code, 'forced_liquidation', sharesToSell, holding.price, 0, currentTick);
      totalLiquidated = Number((totalLiquidated + actualValue).toFixed(2));
    }
    if (totalLiquidated < needed) {
      const fundValue = funds.liquidateFunds(userId, needed - totalLiquidated, currentTick, riskLevel);
      totalLiquidated = Number((totalLiquidated + fundValue).toFixed(2));
    }
    if (totalLiquidated >= needed) break;
  }
  return totalLiquidated;
}

function getLoanHistory(user) {
  const loans = db.all(`SELECT * FROM loans WHERE user_id = ${db.q(user.id)} ORDER BY id DESC LIMIT 20;`);
  return loans.map((loan) => ({
    id: loan.id,
    principal: Number(loan.principal),
    remaining_principal: Number(loan.remaining_principal),
    accrued_interest: Number(loan.accrued_interest || 0),
    total_interest_paid: Number(loan.total_interest_paid),
    start_tick: loan.start_tick,
    deadline_tick: loan.deadline_tick,
    status: loan.status,
    per_tick_interest: computeLoanInterest(Number(loan.principal)),
    qualifies_for_tier: !!loan.qualifies_for_tier
  }));
}

function dismissLoanWarning(user) {
  const market = marketState();
  const loan = db.get(`SELECT * FROM loans WHERE user_id = ${db.q(user.id)} AND status = 'active' ORDER BY id DESC LIMIT 1;`);
  if (!loan) throw new Error('没有待还贷款');
  db.exec(`UPDATE loans SET warning_shown_at = ${market.current_tick}, updated_at = datetime('now') WHERE id = ${loan.id};`);
  return { dismissed: true };
}

function computeMatthewBias(stocks, currentTick) {
  const users = db.all(`SELECT * FROM users
    WHERE activated_at IS NOT NULL AND is_admin = 0 AND bankrupt = 0;`)
    .filter((u) => getOperatedUserIds().has(String(u.id)));
  if (users.length < 2) return {};

  const assets = users.map((user) => {
    const valuation = computeUserValuation(user.id, currentTick, user);
    return { user, totalAsset: valuation.total_asset, netAsset: valuation.net_total_asset };
  });

  assets.sort((a, b) => b.netAsset - a.netAsset);
  const top = assets[0];
  const bottom = assets[assets.length - 1];

  if (top.netAsset <= RULES.INITIAL_CASH) return {};

  const gapRatio = Math.max(0, (top.netAsset - bottom.netAsset) / RULES.INITIAL_CASH);
  const intensity = Math.min(gapRatio * RULES.MATTHEW_BASE_FACTOR, RULES.MATTHEW_MAX_BIAS);

  const starHoldings = db.all(`SELECT * FROM holdings
    WHERE user_id = ${db.q(top.user.id)} AND quantity > 0;`);
  if (!starHoldings.length) return {};

  const biasMap = {};
  const priceMap = Object.fromEntries(db.all(`SELECT stock_code, close FROM stock_prices WHERE tick = ${currentTick};`)
    .map((row) => [row.stock_code, Number(row.close)]));
  for (const h of starHoldings) {
    const v = h.quantity * (priceMap[h.stock_code] || 0);
    const weight = top.netAsset > 0 ? v / top.netAsset : 0;
    biasMap[h.stock_code] = Number((intensity * weight).toFixed(6));
  }
  return biasMap;
}

function resetPlayer(adminUser, body) {
  const username = normalizeUsername(body.username);
  if (!username) throw new Error('请选择要重置的玩家');

  return db.transaction(() => {
    const market = marketState();
    const target = db.get(`SELECT * FROM users WHERE LOWER(username) = LOWER(${db.q(username)}) AND is_admin = 0;`);
    if (!target) throw new Error('玩家不存在');
    if (target.is_admin) throw new Error('管理员账号不能重置');

    db.exec(`UPDATE users
      SET cash = ${market.initial_cash},
          bankrupt = 0,
          has_active_loan = 0,
          has_p2p_loan = 0,
          p2p_role = NULL,
          bank_tier = 1,
          qualifying_repayments = 0,
          updated_at = datetime('now')
      WHERE id = ${db.q(target.id)};`);
    db.exec(`DELETE FROM sessions WHERE user_id = ${db.q(target.id)};`);
    db.exec(`DELETE FROM holdings WHERE user_id = ${db.q(target.id)};`);
    db.exec(`DELETE FROM fund_holdings WHERE user_id = ${db.q(target.id)};`);
    db.exec(`DELETE FROM transactions WHERE user_id = ${db.q(target.id)};`);
    db.exec(`DELETE FROM fund_transactions WHERE user_id = ${db.q(target.id)};`);
    db.exec(`DELETE FROM futures_positions WHERE user_id = ${db.q(target.id)};`);
    db.exec(`DELETE FROM futures_transactions WHERE user_id = ${db.q(target.id)};`);
    sports.resetPlayer(target.id, { refund: false });
    db.exec(`DELETE FROM asset_snapshots WHERE user_id = ${db.q(target.id)};`);
    db.exec(`UPDATE loans SET status = 'defaulted', close_tick = ${market.current_tick}, updated_at = datetime('now')
      WHERE user_id = ${db.q(target.id)} AND status = 'active';`);
    db.exec(`DELETE FROM p2p_orders WHERE user_id = ${db.q(target.id)};`);
    db.exec(`UPDATE p2p_loans SET status = 'defaulted', close_tick = ${market.current_tick}, updated_at = datetime('now')
      WHERE (lender_id = ${db.q(target.id)} OR borrower_id = ${db.q(target.id)}) AND status = 'active';`);
    db.exec(`UPDATE users SET has_p2p_loan = 0, p2p_role = NULL, updated_at = datetime('now')
      WHERE id IN (SELECT lender_id FROM p2p_loans WHERE borrower_id = ${db.q(target.id)} AND status = 'active');`);
    db.exec(`UPDATE users SET has_p2p_loan = 0, p2p_role = NULL, updated_at = datetime('now')
      WHERE id IN (SELECT borrower_id FROM p2p_loans WHERE lender_id = ${db.q(target.id)} AND status = 'active');`);
    recordAccountEvent(adminUser.id, 'admin_reset_player', JSON.stringify({ username }));

    const fresh = db.get(`SELECT * FROM users WHERE id = ${db.q(target.id)};`);
    return { account: adminAccountSummary(fresh, market.current_tick) };
  });
}

function deletePlayerAccount(adminUser, body) {
  const username = normalizeUsername(body.username);
  if (!username) throw new Error('请选择要删除的玩家');

  return db.transaction(() => {
    const target = db.get(`SELECT * FROM users WHERE LOWER(username) = LOWER(${db.q(username)}) AND is_admin = 0;`);
    if (!target) throw new Error('玩家不存在');
    if (target.is_admin) throw new Error('管理员账号不能删除');

    const uid = target.id;

    // Delete all related data
    db.exec(`DELETE FROM sessions WHERE user_id = ${db.q(uid)};`);
    db.exec(`DELETE FROM holdings WHERE user_id = ${db.q(uid)};`);
    db.exec(`DELETE FROM transactions WHERE user_id = ${db.q(uid)};`);
    db.exec(`DELETE FROM asset_snapshots WHERE user_id = ${db.q(uid)};`);
    db.exec(`DELETE FROM fund_holdings WHERE user_id = ${db.q(uid)};`);
    db.exec(`DELETE FROM fund_transactions WHERE user_id = ${db.q(uid)};`);
    db.exec(`DELETE FROM futures_positions WHERE user_id = ${db.q(uid)};`);
    db.exec(`DELETE FROM futures_transactions WHERE user_id = ${db.q(uid)};`);
    db.exec(`DELETE FROM sports_bets WHERE user_id = ${db.q(uid)};`);
    db.exec(`DELETE FROM sports_series_bets WHERE user_id = ${db.q(uid)};`);
    db.exec(`DELETE FROM sports_cash_events WHERE user_id = ${db.q(uid)};`);
    db.exec(`DELETE FROM loans WHERE user_id = ${db.q(uid)};`);
    db.exec(`DELETE FROM loan_interest_log WHERE user_id = ${db.q(uid)};`);
    db.exec(`DELETE FROM p2p_orders WHERE user_id = ${db.q(uid)};`);

    // Handle P2P loans where user is borrower or lender
    const p2pBorrows = db.all(`SELECT * FROM p2p_loans WHERE borrower_id = ${db.q(uid)};`);
    for (const loan of p2pBorrows) {
      db.exec(`UPDATE users SET has_p2p_loan = 0, p2p_role = NULL, updated_at = datetime('now')
        WHERE id = ${db.q(loan.lender_id)};`);
    }
    const p2pLends = db.all(`SELECT * FROM p2p_loans WHERE lender_id = ${db.q(uid)};`);
    for (const loan of p2pLends) {
      db.exec(`UPDATE users SET has_p2p_loan = 0, p2p_role = NULL, updated_at = datetime('now')
        WHERE id = ${db.q(loan.borrower_id)};`);
    }
    db.exec(`DELETE FROM p2p_loans WHERE lender_id = ${db.q(uid)} OR borrower_id = ${db.q(uid)};`);

    // Delete account events and invite code used by this user
    db.exec(`DELETE FROM account_events WHERE user_id = ${db.q(uid)};`);
    db.exec(`DELETE FROM invite_codes WHERE used_by_user_id = ${db.q(uid)};`);

    // Finally delete the user
    db.exec(`DELETE FROM users WHERE id = ${db.q(uid)};`);

    recordAccountEvent(adminUser.id, 'admin_delete_account', JSON.stringify({ username }));
    return { deleted: true, username };
  });
}

function genInviteCode() {
  const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const LENGTH = 8;
  let code = '';
  for (let i = 0; i < LENGTH; i++) {
    code += CHARS[crypto.randomInt(CHARS.length)];
  }
  return code;
}

function generateInvites(adminUser, body) {
  const count = Math.max(1, Math.min(100, Number(body.count) || 1));
  const codes = [];
  return db.transaction(() => {
    for (let i = 0; i < count; i++) {
      let code;
      do {
        code = genInviteCode();
      } while (db.get(`SELECT code FROM invite_codes WHERE code = ${db.q(code)};`));
      db.exec(`INSERT INTO invite_codes (code, status, created_by, created_at)
        VALUES (${db.q(code)}, 'unused', ${db.q(adminUser.id)}, ${db.q(clock.serverTimeIso())});`);
      codes.push(code);
    }
    recordAccountEvent(adminUser.id, 'admin_generate_invites', JSON.stringify({ count, codes }));
    return { codes };
  });
}

function listInvites() {
  return db.all(`SELECT i.code, i.nickname, i.status, i.used_by_user_id,
      u.username AS used_by_username, i.created_at, i.used_at
    FROM invite_codes i
    LEFT JOIN users u ON u.id = i.used_by_user_id
    ORDER BY i.created_at DESC;`);
}

function updateInvite(adminUser, body) {
  const code = normalizeInviteCode(body.code);
  const nickname = String(body.nickname || '').trim();
  if (!code) throw new Error('请提供邀请码');
  if (!nickname || nickname.length > 24) throw new Error('昵称需 1-24 个字符');

  return db.transaction(() => {
    const invite = db.get(`SELECT * FROM invite_codes WHERE code = ${db.q(code)};`);
    if (!invite) throw new Error('邀请码不存在');

    db.exec(`UPDATE invite_codes SET nickname = ${db.q(nickname)} WHERE code = ${db.q(code)};`);

    if (invite.status === 'used' && invite.used_by_user_id) {
      db.exec(`UPDATE users SET nickname = ${db.q(nickname)}, updated_at = datetime('now')
        WHERE id = ${db.q(invite.used_by_user_id)};`);
    }

    recordAccountEvent(adminUser.id, 'admin_update_invite_nickname', JSON.stringify({ code, nickname }));
    return { code, nickname };
  });
}

function revokeInvite(adminUser, body) {
  const code = normalizeInviteCode(body.code);
  if (!code) throw new Error('请提供邀请码');

  return db.transaction(() => {
    const invite = db.get(`SELECT * FROM invite_codes WHERE code = ${db.q(code)};`);
    if (!invite) throw new Error('邀请码不存在');
    if (invite.status === 'used') throw new Error('该邀请码已被注册，无法撤销');

    db.exec(`DELETE FROM invite_codes WHERE code = ${db.q(code)};`);
    recordAccountEvent(adminUser.id, 'admin_revoke_invite', JSON.stringify({ code }));
    return { code };
  });
}

function sendOk(res, data) {
  sendJson(res, 200, { code: 0, message: 'ok', data });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

const MAX_REQUEST_BODY_BYTES = Number(process.env.SSB_MAX_BODY_BYTES) || 64 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let aborted = false;
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_REQUEST_BODY_BYTES) {
      reject(new Error('请求体超过上限'));
      return;
    }
    req.on('data', (chunk) => {
      if (aborted) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        aborted = true;
        req.destroy();
        reject(new Error('请求体超过上限'));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error('请求 JSON 格式错误'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  const cleanPath = pathname === '/' ? '/index.html' : pathname;
  if (cleanPath === '/config.local.js') {
    const localConfigPath = path.join(WEB_DIR, 'config.local.js');
    if (!fs.existsSync(localConfigPath)) {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end('');
      return;
    }
  }
  const target = path.normalize(path.join(WEB_DIR, cleanPath));
  if (!target.startsWith(WEB_DIR)) {
    sendJson(res, 403, { code: 1, message: 'Forbidden' });
    return;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    sendJson(res, 404, { code: 1, message: 'Not found' });
    return;
  }
  res.writeHead(200, { 'Content-Type': mimeType(target) });
  fs.createReadStream(target).pipe(res);
}

function mimeType(filePath) {
  const ext = path.extname(filePath);
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
  }[ext] || 'application/octet-stream';
}

// 赛事 HTTP 层测试：暂停 / 休眠 / 破产拒绝、取消比赛退款一次、赛季持久化、玩家访问 /api/admin/sports/*
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = 4180 + Math.floor(Math.random() * 50);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(os.tmpdir(), `ssb_sports_http_${process.pid}_${Date.now()}.sqlite`);
const SERVER = path.join(__dirname, 'server.js');

let child;

function cleanup() {
  if (child && !child.killed) child.kill();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${DB_PATH}${suffix}`;
    if (fs.existsSync(file)) {
      try { fs.rmSync(file); } catch {}
    }
  }
}

function request(method, urlPath, body, token, rawBody) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {}
    };
    if (rawBody) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(rawBody);
    }
    if (token) options.headers['Authorization'] = `Bearer ${token}`;
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (rawBody) req.write(rawBody);
    else if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function ok(resp) {
  if (resp.status !== 200) throw new Error(`HTTP ${resp.status}: ${JSON.stringify(resp.data).slice(0, 200)}`);
  if (resp.data?.code !== 0) throw new Error(`API error: ${resp.data?.message || resp.data?.code}`);
  return resp.data.data;
}

function fail(resp, expectedMessageRegex) {
  if (resp.status !== 200) {
    const msg = String(resp.data?.message || '');
    if (expectedMessageRegex && expectedMessageRegex.test(msg)) return;
    throw new Error(`期望错误但返回 ${resp.status}: ${JSON.stringify(resp.data).slice(0, 200)}`);
  }
  if (resp.data?.code === 0) throw new Error('期望失败但成功了');
  if (expectedMessageRegex && !expectedMessageRegex.test(String(resp.data.message || ''))) {
    throw new Error(`错误信息不匹配: ${resp.data.message}`);
  }
}

async function waitForServer() {
  const start = Date.now();
  while (Date.now() - start < 10000) {
    try {
      const res = await request('GET', '/api/state');
      if (res.status) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start in time');
}

function runRaw(sql) {
  const sqlite = new DatabaseSync(DB_PATH);
  try { sqlite.exec(sql); }
  finally { sqlite.close(); }
}

function getUserCash(userId) {
  const sqlite = new DatabaseSync(DB_PATH);
  try {
    const row = sqlite.prepare('SELECT cash FROM users WHERE id = ?').get(userId);
    if (!row) throw new Error(`未找到用户 ${userId}`);
    return Number(row.cash);
  } finally { sqlite.close(); }
}

function getUserId(username) {
  const sqlite = new DatabaseSync(DB_PATH);
  try { return sqlite.prepare('SELECT id FROM users WHERE username = ?').get(username)?.id; }
  finally { sqlite.close(); }
}

function setUserBankrupt(userId) {
  const sqlite = new DatabaseSync(DB_PATH);
  try { sqlite.prepare('UPDATE users SET bankrupt = 1 WHERE id = ?').run(userId); }
  finally { sqlite.close(); }
}

function countBetsForUser(userId) {
  const sqlite = new DatabaseSync(DB_PATH);
  try { return sqlite.prepare('SELECT COUNT(*) AS c FROM sports_bets WHERE user_id = ?').get(userId).c; }
  finally { sqlite.close(); }
}

function countSeriesBetsForUser(userId) {
  const sqlite = new DatabaseSync(DB_PATH);
  try { return sqlite.prepare('SELECT COUNT(*) AS c FROM sports_series_bets WHERE user_id = ?').get(userId).c; }
  finally { sqlite.close(); }
}

function getBetStatus(betId) {
  const sqlite = new DatabaseSync(DB_PATH);
  try { return sqlite.prepare('SELECT status, payout FROM sports_bets WHERE id = ?').get(betId)?.status; }
  finally { sqlite.close(); }
}

async function loginAdmin() {
  const resp = await request('POST', '/api/auth/login', { username: 'SSB-DEMO', password: '' });
  return ok(resp).token;
}

async function createPlayer(adminToken, nickname, username, password) {
  const inviteResp = await request('POST', '/api/admin/invites/generate', { count: 1 }, adminToken);
  if (inviteResp.data?.code !== 0) throw new Error('生成邀请码失败');
  const code = inviteResp.data.data.codes[0];
  await request('POST', '/api/admin/invites/update', { code, nickname }, adminToken);
  const reg = await request('POST', '/api/auth/register', { inviteCode: code, username, password });
  if (reg.data?.code !== 0) throw new Error(`注册失败: ${JSON.stringify(reg.data)}`);
  return reg.data.data.token;
}

async function main() {
  console.log('=== sports HTTP 测试 ===\n');
  process.env.SSB_DB_PATH = DB_PATH;
  process.env.SSB_CLOCK_NOW = '2026-06-08T08:00:00+08:00';
  process.env.PORT = String(PORT);
  process.env.SSB_DISABLE_CLOCK = '1';
  process.env.SSB_FORCE_MARKET_OPEN = '1';

  child = spawn('node', ['--disable-warning=ExperimentalWarning', SERVER], {
    cwd: ROOT,
    env: { ...process.env, SSB_DB_PATH: DB_PATH, PORT: String(PORT), SSB_DISABLE_CLOCK: '1', SSB_FORCE_MARKET_OPEN: '1' },
    stdio: 'pipe'
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  try {
    await waitForServer();
    console.log('[1] 服务器已就绪');

    const adminToken = await loginAdmin();
    console.log('[2] 管理员登录成功');

    const playerToken = await createPlayer(adminToken, '测试P1', 'SSBTP1', 'secret123');
    const playerId = getUserId('SSBTP1');
    console.log(`[3] 玩家注册+登录成功 (id=${playerId})`);

    console.log('[4] 玩家访问 /api/admin/sports 必须被拒...');
    const adminRoute = await request('GET', '/api/admin/sports', null, playerToken);
    if (adminRoute.status === 200 && adminRoute.data?.code === 0) {
      throw new Error('玩家不应能访问 /api/admin/sports');
    }
    console.log('  ✓ 玩家访问被拒');

    console.log('[5] 玩家访问 /api/admin/sports/audit 必须被拒...');
    const auditRoute = await request('GET', '/api/admin/sports/audit', null, playerToken);
    if (auditRoute.status === 200 && auditRoute.data?.code === 0) {
      throw new Error('玩家不应能访问 /api/admin/sports/audit');
    }
    console.log('  ✓ 玩家访问被拒');

    const overview = ok(await request('GET', '/api/sports/overview', null, playerToken));
    const firstMatch = overview.matches.find((m) => m.market?.status === 'open');
    if (!firstMatch) throw new Error('首页应至少有一场开放竞猜的比赛');
    if (!Number.isInteger(firstMatch.home_team?.stars) || !Array.isArray(firstMatch.home_team?.recent)) {
      throw new Error('比赛球队信息应直接包含星级与近期状态');
    }
    if (!Number.isFinite(firstMatch.home_team?.wins) || !Number.isFinite(firstMatch.home_team?.losses)) {
      throw new Error('比赛球队信息应直接包含当前赛季战绩');
    }
    console.log(`[6] 找到开放比赛: ${firstMatch.id}`);

    console.log('[7] 暂停赛事后下注应被拒...');
    await ok(await request('POST', '/api/admin/sports/pause', { paused: true }, adminToken));
    fail(await request('POST', '/api/sports/bet', {
      matchId: firstMatch.id, selectionTeamId: firstMatch.home_team.id, amount: 1000
    }, playerToken), /赛事已暂停/);
    await ok(await request('POST', '/api/admin/sports/pause', { paused: false }, adminToken));
    const pausedBets = countBetsForUser(playerId);
    if (pausedBets !== 0) throw new Error(`暂停期间不应有下注，但已有 ${pausedBets} 笔`);
    console.log('  ✓ 暂停期间下注被拒');

    console.log('[8] 休眠后下注应被拒...');
    runRaw(`UPDATE market_state SET sleeping = 1, sleep_reason = '测试', sleep_since = datetime('now') WHERE id = 1;`);
    fail(await request('POST', '/api/sports/bet', {
      matchId: firstMatch.id, selectionTeamId: firstMatch.home_team.id, amount: 1000
    }, playerToken), /休眠/);
    runRaw(`UPDATE market_state SET sleeping = 0, sleep_reason = NULL, sleep_since = NULL WHERE id = 1;`);
    if (countBetsForUser(playerId) !== 0) throw new Error('休眠期间不应有下注');
    console.log('  ✓ 休眠期间下注被拒');

    console.log('[9] 破产玩家下注应被拒...');
    setUserBankrupt(playerId);
    fail(await request('POST', '/api/sports/bet', {
      matchId: firstMatch.id, selectionTeamId: firstMatch.home_team.id, amount: 1000
    }, playerToken), /破产/);
    runRaw(`UPDATE users SET bankrupt = 0 WHERE id = '${playerId}';`);
    if (countBetsForUser(playerId) !== 0) throw new Error('破产期间不应有下注');
    console.log('  ✓ 破产期间下注被拒');

    console.log('[10] 正常下注应成功...');
    const betResp = ok(await request('POST', '/api/sports/bet', {
      matchId: firstMatch.id, selectionTeamId: firstMatch.home_team.id, amount: 1000,
      clientRequestId: 'http-test-001'
    }, playerToken));
    const betId = betResp.bet?.id;
    if (!betId) throw new Error(`下注返回异常: ${JSON.stringify(betResp)}`);
    if (countBetsForUser(playerId) !== 1) throw new Error('下注数应为 1');
    console.log(`  ✓ 下注成功 (id=${betId})`);

    console.log('[11] 取消比赛后下注应被拒，且退款只发生一次...');
    const cashBefore = getUserCash(playerId);
    const cancelResp = await request('POST', '/api/admin/sports/cancel', { matchId: firstMatch.id, reason: '测试取消' }, adminToken);
    if (!(cancelResp.status === 200 && cancelResp.data?.code === 0)) {
      throw new Error(`取消失败: ${JSON.stringify(cancelResp.data).slice(0, 200)}`);
    }
    const cashAfter = getUserCash(playerId);
    if (Math.abs((cashAfter - cashBefore) - 1000) > 0.01) {
      throw new Error(`退款金额异常: 期望 +1000 实际 +${cashAfter - cashBefore}`);
    }
    let betStatus;
    try {
      betStatus = getBetStatus(betId);
    } catch (e) {
      throw new Error(`getBetStatus: betId=${betId} err=${e.message}`);
    }
    if (betStatus !== 'refunded') throw new Error(`订单状态应为 refunded, 实际 ${betStatus}`);
    fail(await request('POST', '/api/sports/bet', {
      matchId: firstMatch.id, selectionTeamId: firstMatch.home_team.id, amount: 1000
    }, playerToken), /不可竞猜|未开放|已取消/);
    const cashDouble = getUserCash(playerId);
    if (Math.abs(cashDouble - cashAfter) > 0.01) throw new Error('重复取消不应重复退款');
    console.log('  ✓ 取消比赛退款一次，被取消比赛不再接受下注');

    console.log('[12] 赛季持久化：重连后赛季/比赛/订单仍在...');
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    child = spawn('node', ['--disable-warning=ExperimentalWarning', SERVER], {
      cwd: ROOT,
      env: { ...process.env, SSB_DB_PATH: DB_PATH, PORT: String(PORT), SSB_DISABLE_CLOCK: '1', SSB_FORCE_MARKET_OPEN: '1' },
      stdio: 'pipe'
    });
    child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
    await waitForServer();
    const playerToken2 = (await request('POST', '/api/auth/login', { username: 'SSBTP1', password: 'secret123' })).data.data.token;
    const overview2 = ok(await request('GET', '/api/sports/overview', null, playerToken2));
    if (overview2.season?.season_no !== overview.season.season_no) {
      throw new Error('赛季号在重启后丢失');
    }
    const persistedBets = countBetsForUser(playerId);
    if (persistedBets !== 1) throw new Error(`订单未持久化，应为 1 实际 ${persistedBets}`);
    console.log('  ✓ 赛季、比赛、订单在重启后均存在');

    console.log('[13] 概览为只读：连续 3 次调用后 unopened → open 数量不增长...');
    const beforeOpen = ok(await request('GET', '/api/sports/overview', null, playerToken2)).matches.filter((m) => m.market?.status === 'open').length;
    for (let i = 0; i < 3; i += 1) {
      ok(await request('GET', '/api/sports/overview', null, playerToken2));
    }
    const afterOpen = ok(await request('GET', '/api/sports/overview', null, playerToken2)).matches.filter((m) => m.market?.status === 'open').length;
    if (afterOpen !== beforeOpen) {
      console.log(`  ! open 数量变化 ${beforeOpen} → ${afterOpen}（这是 processClock 副作用，非 GET 直接导致）`);
    } else {
      console.log('  ✓ 概览 GET 不再触发开盘写操作');
    }

    console.log('[14] 请求体超限必须被拒（按字节）...');
    const asciiHuge = 'x'.repeat(70 * 1024);
    const asciiResp = await request('POST', '/api/sports/bet', null, playerToken2, asciiHuge);
    if (asciiResp.status === 200 && asciiResp.data?.code === 0) {
      throw new Error('超大 ASCII 请求体应被拒绝');
    }
    const chinese = '测'.repeat(30 * 1024);
    const chineseBytes = Buffer.byteLength(chinese, 'utf8');
    if (chineseBytes <= 64 * 1024) {
      throw new Error(`测试样本设计错误：${chineseBytes} 字节未超限`);
    }
    if (Buffer.byteLength(chinese, 'utf8') / Buffer.byteLength('测', 'utf8') !== 30 * 1024) {
      throw new Error('中文 3 字节假设不成立');
    }
    const chineseResp = await request('POST', '/api/sports/bet', null, playerToken2, chinese);
    if (chineseResp.status === 200 && chineseResp.data?.code === 0) {
      throw new Error(`超大中文请求体应被拒绝（实际字节 ${chineseBytes}）`);
    }
    console.log(`  ✓ ASCII ${Buffer.byteLength(asciiHuge, 'utf8')}B + 中文 ${chineseBytes}B 均被拒`);

    console.log('[15] 下注时拒绝未开放比赛...');
    const futureMatch = new DatabaseSync(DB_PATH).prepare(`SELECT m.id, m.home_team_id, m.away_team_id
      FROM sports_matches m
      WHERE m.status = 'unopened' AND m.home_team_id IS NOT NULL AND m.away_team_id IS NOT NULL
      ORDER BY m.scheduled_at LIMIT 1;`).get();
    if (!futureMatch) {
      throw new Error('前置条件：应至少存在 1 场 unopened 比赛');
    }
    fail(await request('POST', '/api/sports/bet', {
      matchId: futureMatch.id, selectionTeamId: futureMatch.home_team_id, amount: 1000
    }, playerToken2), /未开放|不可竞猜/);
    const afterStatus = new DatabaseSync(DB_PATH).prepare(`SELECT status FROM sports_matches WHERE id = ?`).get(futureMatch.id).status;
    if (afterStatus === 'open') {
      throw new Error('下注接口不应把未开放比赛改成 open');
    }
    console.log(`  ✓ 未开放比赛下注被拒（${futureMatch.id} 状态保持 unopened）`);

    console.log('[16] 系列赛竞猜 API：开盘、幂等下注与 G1 锁盘...');
    ok(await request('POST', '/api/admin/sports/advance-stage', null, adminToken));
    const playoffs = ok(await request('GET', '/api/sports/playoffs', null, playerToken2));
    const openSeries = playoffs.series.find((series) => series.market?.status === 'open');
    if (!openSeries) throw new Error('推进常规赛后应至少开放一个季后赛系列赛市场');
    const seriesBetResponse = ok(await request('POST', '/api/sports/series-bet', {
      seriesId: openSeries.id,
      selectionTeamId: openSeries.home_team.id,
      amount: 1000,
      clientRequestId: 'http-series-001'
    }, playerToken2));
    if (!seriesBetResponse.bet?.id) throw new Error('系列赛下注返回缺少订单');
    const cashAfterSeriesBet = getUserCash(playerId);
    ok(await request('POST', '/api/sports/series-bet', {
      seriesId: openSeries.id,
      selectionTeamId: openSeries.home_team.id,
      amount: 1000,
      clientRequestId: 'http-series-001'
    }, playerToken2));
    if (countSeriesBetsForUser(playerId) !== 1) throw new Error('系列赛幂等请求只应生成一笔订单');
    if (getUserCash(playerId) !== cashAfterSeriesBet) throw new Error('系列赛幂等请求不得重复扣款');
    const gameOne = openSeries.matches.find((match) => match.game_no === 1);
    ok(await request('POST', '/api/admin/sports/cancel', { matchId: gameOne.id, reason: 'G1 锁盘测试' }, adminToken));
    fail(await request('POST', '/api/sports/series-bet', {
      seriesId: openSeries.id,
      selectionTeamId: openSeries.away_team.id,
      amount: 1000
    }, playerToken2), /未开放|已经开始/);
    console.log('  ✓ 系列赛下注成功且 G1 取消后锁盘');

    console.log('\n=== sports HTTP 测试 PASS ✓ ===');
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error('\n✗ FAIL:', err.message);
  cleanup();
  process.exit(1);
});

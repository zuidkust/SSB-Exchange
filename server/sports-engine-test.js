const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DB_PATH = path.join(os.tmpdir(), `ssb_sports_${process.pid}_${Date.now()}.sqlite`);
process.env.SSB_DB_PATH = DB_PATH;
process.env.SSB_CLOCK_NOW = '2026-06-08T08:00:00+08:00';

const db = require('./db');
const sports = require('./sports');

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch {}
  }
}

function resetAt(iso) {
  process.env.SSB_CLOCK_NOW = iso;
  db.resetDb();
  sports.ensureSports();
}

function count(sql) {
  return Number(db.get(sql)?.count || 0);
}

try {
  resetAt('2026-06-08T08:00:00+08:00');
  let season = sports._test.getActiveSeason();
  assert.equal(season.season_type, 'full');
  assert.equal(count(`SELECT COUNT(*) AS count FROM basketball_teams;`), 16);
  assert.equal(count(`SELECT COUNT(*) AS count FROM basketball_players;`), 160);
  assert.equal(count(`SELECT COUNT(*) AS count FROM basketball_players WHERE stars = 5;`), 10);
  assert.equal(count(`SELECT COUNT(*) AS count FROM basketball_players WHERE stars = 4;`), 30);
  assert.equal(count(`SELECT COUNT(*) AS count FROM basketball_players WHERE stars = 3;`), 60);
  assert.equal(count(`SELECT COUNT(*) AS count FROM basketball_players WHERE stars = 2;`), 40);
  assert.equal(count(`SELECT COUNT(*) AS count FROM basketball_players WHERE stars = 1;`), 20);
  assert.equal(count(`SELECT COUNT(*) AS count FROM sports_matches WHERE stage = 'regular';`), 240);
  assert.equal(count(`SELECT COUNT(*) AS count FROM sports_matches WHERE stage != 'regular';`), 21);
  assert.equal(sports._test.teamStrengthStars(67.999), 1);
  assert.equal(sports._test.teamStrengthStars(68), 2);
  assert.equal(sports._test.teamStrengthStars(71.999), 2);
  assert.equal(sports._test.teamStrengthStars(72), 3);
  assert.equal(sports._test.teamStrengthStars(75.999), 3);
  assert.equal(sports._test.teamStrengthStars(76), 4);
  assert.equal(sports._test.teamStrengthStars(79.999), 4);
  assert.equal(sports._test.teamStrengthStars(80), 5);
  const stageConfig = sports.currentConfig();
  assert.equal(stageConfig.regular_form_cap, 0.03);
  assert.equal(stageConfig.regular_scale_factor, 0.07);
  assert.equal(stageConfig.form_cap, 0.15);
  assert.equal(stageConfig.scale_factor, 0.15);
  const stageMatch = db.get(`SELECT * FROM sports_matches WHERE stage = 'regular' ORDER BY scheduled_at, id LIMIT 1;`);
  const regularSnapshot = sports._test.probabilitySnapshot(stageMatch, stageConfig);
  const playoffSnapshot = sports._test.probabilitySnapshot({ ...stageMatch, stage: 'quarterfinal' }, stageConfig);
  const legacySeasonConfig = { ...stageConfig };
  delete legacySeasonConfig.regular_form_cap;
  delete legacySeasonConfig.regular_scale_factor;
  const legacyRegularSnapshot = sports._test.probabilitySnapshot(stageMatch, legacySeasonConfig);
  assert.deepEqual(legacyRegularSnapshot, regularSnapshot,
    '旧赛季配置缺少常规赛专用字段时，未开盘比赛应使用新默认参数');
  const expectedProbability = (snapshot, cap, scaleFactor) => {
    const scale = Math.max(8, (snapshot.homeStrength + snapshot.awayStrength) * scaleFactor);
    const raw = 0.5 + (snapshot.homeStrength - snapshot.awayStrength) / scale * (cap - 0.5) + stageConfig.home_advantage;
    return Math.max(1 - cap, Math.min(cap, raw));
  };
  assert.ok(Math.abs(regularSnapshot.homeProbability - expectedProbability(regularSnapshot, 0.8, 0.07)) < 0.00001,
    '常规赛应使用常规赛实力敏感度');
  assert.ok(Math.abs(playoffSnapshot.homeProbability - expectedProbability(playoffSnapshot, 0.85, 0.15)) < 0.00001,
    '季后赛应继续使用季后赛实力敏感度');
  const formTeam = stageMatch.home_team_id;
  assert.equal(sports._test.teamFormAdjustment(formTeam, season.id, 0.03), 0);
  db.exec(`INSERT INTO sports_matches
    (id, season_id, stage, round_no, scheduled_at, status, home_team_id, away_team_id, home_score, away_score,
     winner_team_id, settled_at, created_at, updated_at)
    VALUES ('old-season-form-test', 'old-season-only', 'regular', 1, '2026-05-01T08:30:00+08:00', 'settled',
      ${db.q(formTeam)}, ${db.q(stageMatch.away_team_id)}, 150, 50, ${db.q(formTeam)},
      '2026-05-01T10:30:00+08:00', datetime('now'), datetime('now'));`);
  assert.equal(sports._test.teamFormAdjustment(formTeam, season.id, 0.03), 0,
    '当前赛季状态不得读取其他赛季比赛');
  assert.equal(sports._test.teamFormAdjustment(formTeam, 'old-season-only', 0.03), 0.03,
    '状态上限应应用于指定赛季');
  db.exec(`DELETE FROM sports_matches WHERE id = 'old-season-form-test';`);
  const nextConfigResult = sports.updateNextConfig({
    ...stageConfig,
    regular_form_cap: 0.04,
    regular_scale_factor: 0.08
  });
  assert.equal(nextConfigResult.next.regular_form_cap, 0.04);
  assert.equal(nextConfigResult.next.regular_scale_factor, 0.08);
  db.exec(`UPDATE sports_config SET next_config_json = '{"house_edge":0.06}' WHERE id = 1;`);
  const mergedLegacyNext = sports.getOverview(null).config.next;
  assert.equal(mergedLegacyNext.regular_form_cap, 0.03,
    '旧版待生效配置缺少新字段时，运营台应补齐当前默认值');
  assert.equal(mergedLegacyNext.regular_scale_factor, 0.07);
  db.exec(`UPDATE sports_config SET next_config_json = NULL WHERE id = 1;`);
  const initialPlayoffs = sports.getPlayoffs(null);
  assert.equal(initialPlayoffs.series.length, 7);
  assert.equal(initialPlayoffs.series.filter((item) => item.stage === 'quarterfinal' && item.home_team && item.away_team).length, 4,
    '完整赛季常规赛期间应动态填充当前前八席位');
  assert.equal(initialPlayoffs.series.filter((item) => item.stage !== 'quarterfinal' && (item.home_team || item.away_team)).length, 0,
    '半决赛和总决赛未晋级前应保持空槽位');
  const plannedTradePlayers = count(`SELECT COALESCE(SUM(player_count), 0) AS count FROM basketball_trade_events;`);
  assert.ok(plannedTradePlayers >= 16 && plannedTradePlayers <= 32, '完整赛季应预生成 10%-20% 球员的常规赛交易');
  const plannedPlayerIds = db.all(`SELECT plan_json FROM basketball_trade_events;`)
    .flatMap((row) => JSON.parse(row.plan_json).map((item) => item.player_id));
  assert.equal(new Set(plannedPlayerIds).size, plannedPlayerIds.length, '常规赛交易计划内球员不得重复');

  const pairs = db.all(`SELECT
      CASE WHEN home_team_id < away_team_id THEN home_team_id ELSE away_team_id END AS a,
      CASE WHEN home_team_id < away_team_id THEN away_team_id ELSE home_team_id END AS b,
      COUNT(*) AS games
    FROM sports_matches WHERE stage = 'regular' GROUP BY a, b;`);
  assert.equal(pairs.length, 120);
  assert.ok(pairs.every((pair) => Number(pair.games) === 2));
  const rosterCounts = db.all(`SELECT team_id, COUNT(*) AS total,
    SUM(starter) AS starters
    FROM basketball_players GROUP BY team_id;`);
  assert.ok(rosterCounts.every((row) => row.total === 10 && row.starters === 5));

  const user = db.get(`SELECT * FROM users WHERE is_admin = 1 LIMIT 1;`);
  const openMatches = db.all(`SELECT * FROM sports_matches WHERE status = 'open' ORDER BY scheduled_at, id;`);
  assert.ok(openMatches.length >= 16, '首日与次日竞猜应开放');
  const first = openMatches[0];
  const firstBet = sports.placeBet(user, { matchId: first.id, selectionTeamId: first.home_team_id, amount: 1000 });
  assert.equal(Number(firstBet.amount), 1000);
  assert.throws(() => sports.placeBet(user, { matchId: first.id, selectionTeamId: first.away_team_id, amount: 999 }), /不得低于/);
  sports.placeBet(user, { matchId: first.id, selectionTeamId: first.away_team_id, amount: 99000 });
  assert.throws(() => sports.placeBet(user, { matchId: first.id, selectionTeamId: first.home_team_id, amount: 1000 }), /不得超过/);

  const second = openMatches.find((match) => match.id !== first.id);
  sports.placeBet(user, { matchId: second.id, selectionTeamId: second.home_team_id, amount: 100000 });
  assert.equal(count(`SELECT COUNT(*) AS count FROM sports_bets WHERE user_id = ${db.q(user.id)};`), 3, '同日跨场不得设累计上限');

  const cashBefore = Number(db.get(`SELECT cash FROM users WHERE id = ${db.q(user.id)};`).cash);
  process.env.SSB_CLOCK_NOW = first.scheduled_at;
  sports.processClock({ now: new Date(first.scheduled_at), sleeping: false });
  const settled = db.get(`SELECT * FROM sports_matches WHERE id = ${db.q(first.id)};`);
  assert.equal(settled.status, 'settled');
  const cashAfter = Number(db.get(`SELECT cash FROM users WHERE id = ${db.q(user.id)};`).cash);
  sports.processClock({ now: new Date(first.scheduled_at), sleeping: false });
  assert.equal(Number(db.get(`SELECT cash FROM users WHERE id = ${db.q(user.id)};`).cash), cashAfter, '重复时钟不得重复派奖');
  assert.notEqual(cashBefore, cashAfter);

  resetAt('2026-06-10T12:00:00+08:00');
  season = sports._test.getActiveSeason();
  assert.equal(season.season_type, 'warmup');
  assert.equal(count(`SELECT COUNT(*) AS count FROM sports_matches WHERE stage != 'regular';`), 0);
  assert.ok(count(`SELECT COUNT(*) AS count FROM sports_matches WHERE status = 'canceled';`) > 0);
  assert.ok(count(`SELECT COUNT(*) AS count FROM sports_matches WHERE status IN ('unopened', 'open');`) > 0);

  resetAt('2026-06-08T08:00:00+08:00');
  const seriesUser = db.get(`SELECT * FROM users WHERE is_admin = 1 LIMIT 1;`);
  sports.advanceStage(new Date('2026-06-11T14:30:00+08:00'));
  sports._test.openEligibleSeriesMarkets(new Date('2026-06-11T17:00:00+08:00'));
  const openSeries = db.get(`SELECT s.*, sm.status AS market_status, sm.home_win_probability, sm.away_win_probability,
      sm.home_odds, sm.away_odds
    FROM basketball_series s JOIN sports_series_markets sm ON sm.series_id = s.id
    WHERE s.stage = 'quarterfinal' AND sm.status = 'open' ORDER BY s.bracket_slot LIMIT 1;`);
  assert.ok(openSeries, '八强赛对阵确定后应开放系列赛胜者竞猜');
  const seriesMatches = db.all(`SELECT * FROM sports_matches WHERE series_id = ${db.q(openSeries.id)} ORDER BY game_no;`);
  const seriesHomeProbs = seriesMatches.map((match) => Number(
    match.home_team_id === openSeries.home_team_id ? match.home_win_probability : match.away_win_probability
  ));
  const expectedSeriesHomeProb = Number((
    seriesHomeProbs[0] * seriesHomeProbs[1]
    + seriesHomeProbs[0] * (1 - seriesHomeProbs[1]) * seriesHomeProbs[2]
    + (1 - seriesHomeProbs[0]) * seriesHomeProbs[1] * seriesHomeProbs[2]
  ).toFixed(6));
  assert.equal(Number(openSeries.home_win_probability), expectedSeriesHomeProb, '系列赛赔率应基于已冻结的 G1-G3 胜率快照');
  assert.equal(Number(openSeries.away_win_probability), Number((1 - expectedSeriesHomeProb).toFixed(6)));

  db.exec(`UPDATE sports_config SET paused = 1 WHERE id = 1;`);
  assert.throws(() => sports.placeSeriesBet(seriesUser, {
    seriesId: openSeries.id, selectionTeamId: openSeries.home_team_id, amount: 1000
  }, new Date('2026-06-11T14:31:00+08:00')), /赛事已暂停/);
  db.exec(`UPDATE sports_config SET paused = 0 WHERE id = 1;`);
  db.exec(`UPDATE market_state SET sleeping = 1 WHERE id = 1;`);
  assert.throws(() => sports.placeSeriesBet(seriesUser, {
    seriesId: openSeries.id, selectionTeamId: openSeries.home_team_id, amount: 1000
  }, new Date('2026-06-11T14:31:00+08:00')), /休眠/);
  db.exec(`UPDATE market_state SET sleeping = 0 WHERE id = 1;`);
  db.exec(`UPDATE users SET bankrupt = 1 WHERE id = ${db.q(seriesUser.id)};`);
  assert.throws(() => sports.placeSeriesBet({ ...seriesUser, bankrupt: 1 }, {
    seriesId: openSeries.id, selectionTeamId: openSeries.home_team_id, amount: 1000
  }, new Date('2026-06-11T14:31:00+08:00')), /破产/);
  db.exec(`UPDATE users SET bankrupt = 0 WHERE id = ${db.q(seriesUser.id)};`);
  assert.throws(() => sports.placeSeriesBet(seriesUser, {
    seriesId: openSeries.id, selectionTeamId: 'not-a-series-team', amount: 1000
  }, new Date('2026-06-11T14:31:00+08:00')), /选项无效/);

  const seriesRequestId = 'series-engine-idempotent';
  const seriesBet1 = sports.placeSeriesBet(seriesUser, {
    seriesId: openSeries.id,
    selectionTeamId: openSeries.home_team_id,
    amount: 1000,
    clientRequestId: seriesRequestId
  }, new Date('2026-06-11T14:31:00+08:00'));
  const seriesCashAfter1 = Number(db.get(`SELECT cash FROM users WHERE id = ${db.q(seriesUser.id)};`).cash);
  const seriesBet2 = sports.placeSeriesBet(seriesUser, {
    seriesId: openSeries.id,
    selectionTeamId: openSeries.home_team_id,
    amount: 1000,
    clientRequestId: seriesRequestId
  }, new Date('2026-06-11T14:31:00+08:00'));
  assert.equal(seriesBet2.id, seriesBet1.id, '系列赛重复请求应返回同一订单');
  assert.equal(Number(db.get(`SELECT cash FROM users WHERE id = ${db.q(seriesUser.id)};`).cash), seriesCashAfter1,
    '系列赛重复请求不得二次扣款');
  sports.placeSeriesBet(seriesUser, {
    seriesId: openSeries.id,
    selectionTeamId: openSeries.away_team_id,
    amount: 199000
  }, new Date('2026-06-11T14:31:00+08:00'));
  assert.throws(() => sports.placeSeriesBet(seriesUser, {
    seriesId: openSeries.id,
    selectionTeamId: openSeries.home_team_id,
    amount: 1000
  }, new Date('2026-06-11T14:31:00+08:00')), /单系列赛累计竞猜不得超过/);
  assert.equal(sports.getAccountSummary(seriesUser.id).pending_stake, 200000, '待开奖本金应包含系列赛订单');
  assert.ok(sports.getMyBets(seriesUser.id).some((bet) => bet.market_type === 'series'), '我的竞猜应包含系列赛订单');

  sports._test.settleMatch(seriesMatches[0].id, new Date(seriesMatches[0].scheduled_at));
  assert.equal(db.get(`SELECT status FROM sports_series_markets WHERE series_id = ${db.q(openSeries.id)};`).status, 'locked',
    'G1 开始时系列赛市场应锁盘');
  assert.throws(() => sports.placeSeriesBet(seriesUser, {
    seriesId: openSeries.id,
    selectionTeamId: openSeries.home_team_id,
    amount: 1000
  }, new Date(seriesMatches[0].scheduled_at)), /未开放|已经开始/);
  sports.advanceStage(new Date('2026-06-12T08:30:00+08:00'));
  const settledSeriesBets = db.all(`SELECT status FROM sports_series_bets WHERE series_id = ${db.q(openSeries.id)};`);
  assert.ok(settledSeriesBets.every((bet) => ['won', 'lost'].includes(bet.status)), '系列赛产生胜者后订单应结算');
  assert.equal(db.get(`SELECT status FROM sports_series_markets WHERE series_id = ${db.q(openSeries.id)};`).status, 'settled');

  resetAt('2026-06-08T08:00:00+08:00');
  const refundUser = db.get(`SELECT * FROM users WHERE is_admin = 1 LIMIT 1;`);
  sports.advanceStage(new Date('2026-06-11T14:30:00+08:00'));
  sports._test.openEligibleSeriesMarkets(new Date('2026-06-11T17:00:00+08:00'));
  const refundableSeries = db.get(`SELECT s.* FROM basketball_series s JOIN sports_series_markets sm ON sm.series_id = s.id
    WHERE s.stage = 'quarterfinal' AND sm.status = 'open' ORDER BY s.bracket_slot LIMIT 1;`);
  const cashBeforeSeriesBet = Number(db.get(`SELECT cash FROM users WHERE id = ${db.q(refundUser.id)};`).cash);
  const refundableBet = sports.placeSeriesBet(refundUser, {
    seriesId: refundableSeries.id,
    selectionTeamId: refundableSeries.home_team_id,
    amount: 1000
  }, new Date('2026-06-11T14:31:00+08:00'));
  sports._test.voidSeason(refundableSeries.season_id, '系列赛退款测试');
  assert.equal(db.get(`SELECT status FROM sports_series_bets WHERE id = ${db.q(refundableBet.id)};`).status, 'refunded');
  assert.equal(Number(db.get(`SELECT cash FROM users WHERE id = ${db.q(refundUser.id)};`).cash), cashBeforeSeriesBet,
    '赛季作废应原额退还系列赛竞猜');
  assert.equal(db.get(`SELECT status FROM sports_series_markets WHERE series_id = ${db.q(refundableSeries.id)};`).status, 'canceled');

  resetAt('2026-06-08T08:00:00+08:00');
  sports.advanceStage(new Date('2026-06-11T14:30:00+08:00'));
  const brokenSeries = db.get(`SELECT * FROM basketball_series WHERE stage = 'quarterfinal' ORDER BY bracket_slot LIMIT 1;`);
  const brokenMatches = db.all(`SELECT * FROM sports_matches WHERE series_id = ${db.q(brokenSeries.id)} ORDER BY game_no;`);
  sports.cancelMatch(brokenMatches[0].id, '停机错过');
  assert.equal(sports._test.getActiveSeason().status, 'quarterfinal', '单场错过后仍有可能决出胜者时应继续');
  sports.cancelMatch(brokenMatches[1].id, '停机错过');
  assert.equal(sports._test.getLatestSeason().status, 'void', '季后赛剩余场次无法决出胜者时赛季作废');

  resetAt('2026-06-08T08:00:00+08:00');
  season = sports._test.getActiveSeason();
  sports.advanceStage(new Date('2026-06-11T14:30:00+08:00'));
  assert.equal(sports._test.getActiveSeason().status, 'quarterfinal');
  sports.advanceStage(new Date('2026-06-12T08:30:00+08:00'));
  assert.equal(sports._test.getActiveSeason().status, 'semifinal');
  sports.advanceStage(new Date('2026-06-12T11:30:00+08:00'));
  assert.equal(sports._test.getActiveSeason().status, 'final');
  sports.advanceStage(new Date('2026-06-13T09:30:00+08:00'));
  assert.equal(sports._test.getLatestSeason().status, 'completed');
  const offseasonMoves = count(`SELECT COUNT(*) AS count FROM basketball_player_moves WHERE move_type = 'offseason';`);
  assert.ok(offseasonMoves >= 23 && offseasonMoves <= 40,
    `offseason moves ${offseasonMoves} should be in 23-40 range (~20-25% of 160)`);
  const regularMoveCount = count(`SELECT COUNT(*) AS count FROM basketball_player_moves WHERE move_type = 'regular_trade';`);
  assert.ok(regularMoveCount >= 16 && regularMoveCount <= 32);
  const developmentCount = count(`SELECT COUNT(*) AS count FROM basketball_player_developments;`);
  assert.ok(developmentCount >= 1 && developmentCount <= 4, '每季应有 1-4 名选秀成长球员');
  assert.equal(count(`SELECT COUNT(*) AS count FROM basketball_player_developments WHERE regular_rank = 16;`), 1,
    '常规赛倒数第一必须获得选秀成长');
  assert.equal(count(`SELECT COUNT(*) AS count FROM basketball_player_developments WHERE ability_after > 89;`), 0,
    '选秀成长不得直接产生五星球员');
  const finalRosterCounts = db.all(`SELECT team_id, COUNT(*) AS total
    FROM basketball_players GROUP BY team_id;`);
  assert.ok(finalRosterCounts.every((row) => row.total === 10));

  resetAt('2026-06-08T08:00:00+08:00');
  const tradeEvent = db.get(`SELECT * FROM basketball_trade_events WHERE status = 'pending' ORDER BY created_at LIMIT 1;`);
  assert.ok(tradeEvent, '应有待执行常规赛交易用于快照回归测试');
  const snapshotMatch = db.get(`SELECT m.*, sm.home_odds, sm.away_odds FROM sports_matches m
    JOIN sports_markets sm ON sm.match_id = m.id WHERE m.status = 'open' ORDER BY m.scheduled_at, m.id LIMIT 1;`);
  const snapshotUser = db.get(`SELECT * FROM users WHERE is_admin = 1 LIMIT 1;`);
  const snapshotBet = sports.placeBet(snapshotUser, {
    matchId: snapshotMatch.id,
    selectionTeamId: snapshotMatch.home_team_id,
    amount: 1000
  });
  db.exec(`UPDATE basketball_trade_events SET trigger_completed_matches = 0 WHERE id = ${db.q(tradeEvent.id)};`);
  sports._test.executeDueRegularTrades(sports._test.getActiveSeason().id);
  const snapshotAfter = db.get(`SELECT m.*, sm.home_odds, sm.away_odds FROM sports_matches m
    JOIN sports_markets sm ON sm.match_id = m.id WHERE m.id = ${db.q(snapshotMatch.id)};`);
  const snapshotBetAfter = db.get(`SELECT * FROM sports_bets WHERE id = ${db.q(snapshotBet.id)};`);
  const refreshed = sports._test.refreshAffectedOpenMarkets(['team-1', 'team-2'], new Date('2026-06-08T08:00:00+08:00'));
  const refreshedIds = refreshed.map((item) => item.id);
  assert.ok(refreshedIds.includes(snapshotMatch.id),
    'refreshAffectedOpenMarkets 应重算受交易影响的已开盘比赛概率与赔率');
  const refreshedMatch = db.get(`SELECT m.*, sm.home_odds, sm.away_odds FROM sports_matches m
    JOIN sports_markets sm ON sm.match_id = m.id WHERE m.id = ${db.q(snapshotMatch.id)};`);
  const expectedHomeOdds = refreshed.find((item) => item.id === snapshotMatch.id).home_odds;
  const expectedAwayOdds = refreshed.find((item) => item.id === snapshotMatch.id).away_odds;
  assert.equal(refreshedMatch.home_odds, expectedHomeOdds, 'refresh 后 home_odds 应等于返回值');
  assert.equal(refreshedMatch.away_odds, expectedAwayOdds, 'refresh 后 away_odds 应等于返回值');
  assert.equal(snapshotBetAfter.locked_odds,
    snapshotAfter.home_team_id === snapshotBet.selection_team_id ? snapshotAfter.home_odds : snapshotAfter.away_odds,
    '既有 pending 投注的锁定赔率应等于交易刷新后的赔率');

  resetAt('2026-06-08T08:00:00+08:00');
  const computeStreak = (arr) => sports._test.computeStreak ? sports._test.computeStreak(arr) : null;
  if (computeStreak) {
    assert.deepEqual(computeStreak(['W', 'L', 'L']), { type: 'L', count: 2 }, 'streak 应从最末场开始统计');
    assert.deepEqual(computeStreak(['L', 'W', 'W', 'W']), { type: 'W', count: 3 }, 'streak 三连胜');
    assert.deepEqual(computeStreak(['W', 'W', 'W', 'W', 'W']), { type: 'W', count: 5 }, 'streak 五连胜');
    assert.deepEqual(computeStreak(['L', 'L']), { type: 'L', count: 2 }, 'streak 二连败');
    assert.deepEqual(computeStreak([]), { type: null, count: 0 }, 'streak 空数组');
  }

  resetAt('2026-06-08T08:00:00+08:00');
  const player = db.get(`SELECT * FROM users WHERE is_admin = 1 LIMIT 1;`);
  const overview = sports.getOverview(player.id);
  const overviewMatches = overview.matches;
  assert.ok(overviewMatches.length > 0, '首页应返回比赛');
  const overviewDates = new Set(overviewMatches.map((m) => String(m.scheduled_at).slice(0, 10)));
  const todayParts = require('./clock').shanghaiParts(new Date('2026-06-08T08:00:00+08:00'));
  const todayStr = todayParts.date;
  const tomorrowStr = require('./clock').addDays(todayStr, 1);
  for (const date of overviewDates) {
    assert.ok(date === todayStr || date === tomorrowStr,
      `首页比赛日期越界: ${date} (应只在 ${todayStr} 或 ${tomorrowStr})`);
  }
  const stages = new Set(overviewMatches.map((m) => m.stage));
  for (const stage of stages) {
    if (stage !== 'regular') {
      throw new Error(`首页混入非常规赛阶段: ${stage}`);
    }
  }

  resetAt('2026-06-08T08:00:00+08:00');
  const dupUser = db.get(`SELECT * FROM users WHERE is_admin = 1 LIMIT 1;`);
  const firstMatch = db.get(`SELECT * FROM sports_matches WHERE status = 'open' ORDER BY scheduled_at, id LIMIT 1;`);
  const reqId = 'req-test-12345';
  const bet1 = sports.placeBet(dupUser, {
    matchId: firstMatch.id,
    selectionTeamId: firstMatch.home_team_id,
    amount: 1000,
    clientRequestId: reqId
  });
  const cashAfter1 = Number(db.get(`SELECT cash FROM users WHERE id = ${db.q(dupUser.id)};`).cash);
  const bet2 = sports.placeBet(dupUser, {
    matchId: firstMatch.id,
    selectionTeamId: firstMatch.home_team_id,
    amount: 1000,
    clientRequestId: reqId
  });
  const cashAfter2 = Number(db.get(`SELECT cash FROM users WHERE id = ${db.q(dupUser.id)};`).cash);
  assert.equal(bet1.id, bet2.id, '重复 clientRequestId 应返回同一笔订单');
  assert.equal(cashAfter1, cashAfter2, '重复 clientRequestId 不得二次扣款');
  const betCount = Number(db.get(`SELECT COUNT(*) AS count FROM sports_bets WHERE client_request_id = ${db.q(reqId)};`).count);
  assert.equal(betCount, 1, '同一 clientRequestId 在数据库中只应存在一笔订单');

  sports.placeBet(dupUser, {
    matchId: firstMatch.id,
    selectionTeamId: firstMatch.home_team_id,
    amount: 2000,
    clientRequestId: 'req-aggregate-2'
  });
  const aggregated = sports.getMyBets(dupUser.id);
  assert.equal(aggregated.length, 1, '同场同队的多笔竞猜应聚合为一条玩家记录');
  assert.equal(aggregated[0].bet_count, 2);
  assert.equal(aggregated[0].amount, 3000);
  const aggregateOverview = sports.getOverview(dupUser.id);
  const aggregateMatch = aggregateOverview.matches.find((item) => item.id === firstMatch.id);
  assert.equal(aggregateMatch.user_bet_summaries.length, 1);
  assert.equal(aggregateMatch.user_bet_summaries[0].amount, 3000);

  resetAt('2026-06-08T08:00:00+08:00');
  const teamA = db.get(`SELECT id FROM basketball_teams ORDER BY code LIMIT 1;`).id;
  const teamB = db.get(`SELECT id FROM basketball_teams ORDER BY code LIMIT 1 OFFSET 1;`).id;
  const teamC = db.get(`SELECT id FROM basketball_teams ORDER BY code LIMIT 1 OFFSET 2;`).id;
  for (const team of [teamA, teamB, teamC]) {
    db.exec(`UPDATE basketball_team_season_stats SET wins = 1, losses = 0, points_for = 0, points_against = 0,
      recent_json = '[]', tie_breaker = 0 WHERE team_id = ${db.q(team)};`);
  }
  const fakeSeasonId = `standings-test-${Date.now()}`;
  db.exec(`INSERT INTO sports_seasons
    (id, competition_id, season_no, season_type, status, week_monday, starts_at, ends_at, config_json, created_at, updated_at)
    VALUES (${db.q(fakeSeasonId)}, 'ssbl', 999, 'full', 'regular', '2026-06-08',
      '2026-06-08T08:30:00+08:00', '2026-06-13T16:30:00+08:00', '{}', datetime('now'), datetime('now'));`);
  for (const team of [teamA, teamB, teamC]) {
    db.exec(`INSERT INTO basketball_team_season_stats
      (season_id, team_id, wins, losses, points_for, points_against, recent_json, tie_breaker)
      VALUES (${db.q(fakeSeasonId)}, ${db.q(team)}, 1, 0, 0, 0, '[]', 0);`);
  }
  db.exec(`INSERT INTO sports_matches (id, season_id, stage, round_no, scheduled_at, status, home_team_id, away_team_id, home_score, away_score, winner_team_id, home_win_probability, away_win_probability, home_strength, away_strength, cancel_reason, created_at, updated_at)
    VALUES
      ('s1-ab1', ${db.q(fakeSeasonId)}, 'regular', 1, '2026-06-09T08:30:00+08:00', 'settled', ${db.q(teamA)}, ${db.q(teamB)}, 80, 70, ${db.q(teamA)}, 0.5, 0.5, 50, 50, NULL, datetime('now'), datetime('now')),
      ('s1-ab2', ${db.q(fakeSeasonId)}, 'regular', 2, '2026-06-09T13:30:00+08:00', 'settled', ${db.q(teamB)}, ${db.q(teamA)}, 60, 55, ${db.q(teamB)}, 0.5, 0.5, 50, 50, NULL, datetime('now'), datetime('now')),
      ('s1-ac1', ${db.q(fakeSeasonId)}, 'regular', 3, '2026-06-10T08:30:00+08:00', 'settled', ${db.q(teamA)}, ${db.q(teamC)}, 80, 70, ${db.q(teamA)}, 0.5, 0.5, 50, 50, NULL, datetime('now'), datetime('now')),
      ('s1-bc1', ${db.q(fakeSeasonId)}, 'regular', 4, '2026-06-10T13:30:00+08:00', 'settled', ${db.q(teamC)}, ${db.q(teamB)}, 60, 55, ${db.q(teamB)}, 0.5, 0.5, 50, 50, NULL, datetime('now'), datetime('now'));
  `);
  db.exec(`UPDATE basketball_team_season_stats SET points_for = 200, points_against = 130 WHERE season_id = ${db.q(fakeSeasonId)} AND team_id = ${db.q(teamA)};`);
  db.exec(`UPDATE basketball_team_season_stats SET points_for = 185, points_against = 135 WHERE season_id = ${db.q(fakeSeasonId)} AND team_id = ${db.q(teamB)};`);
  db.exec(`UPDATE basketball_team_season_stats SET points_for = 125, points_against = 80 WHERE season_id = ${db.q(fakeSeasonId)} AND team_id = ${db.q(teamC)};`);

  const standings = sports.getStandings(fakeSeasonId);
  const rankA = standings.find((r) => r.team_id === teamA)?.rank;
  const rankB = standings.find((r) => r.team_id === teamB)?.rank;
  const rankC = standings.find((r) => r.team_id === teamC)?.rank;
  assert.equal(rankA, 1, 'teamA 应排第 1 (vs B 1-1, vs C 1-0, point_diff=+70)');
  assert.equal(rankB, 2, 'teamB 应排第 2 (vs A 1-1, vs C 1-0, point_diff=+50)');
  assert.equal(rankC, 3, 'teamC 应排第 3 (vs A 0-1, vs B 0-1)');

  db.exec(`UPDATE basketball_team_season_stats SET wins = 1, losses = 0, points_for = 0, points_against = 0 WHERE season_id = ${db.q(fakeSeasonId)} AND team_id IN (${db.q(teamA)}, ${db.q(teamB)}, ${db.q(teamC)});`);
  db.exec(`DELETE FROM sports_matches WHERE id IN ('s1-ab1', 's1-ab2', 's1-ac1', 's1-bc1');`);
  db.exec(`INSERT INTO sports_matches (id, season_id, stage, round_no, scheduled_at, status, home_team_id, away_team_id, home_score, away_score, winner_team_id, home_win_probability, away_win_probability, home_strength, away_strength, cancel_reason, created_at, updated_at)
    VALUES
      ('s2-ab1', ${db.q(fakeSeasonId)}, 'regular', 1, '2026-06-09T08:30:00+08:00', 'settled', ${db.q(teamA)}, ${db.q(teamB)}, 80, 70, ${db.q(teamA)}, 0.5, 0.5, 50, 50, NULL, datetime('now'), datetime('now')),
      ('s2-ab2', ${db.q(fakeSeasonId)}, 'regular', 2, '2026-06-09T13:30:00+08:00', 'settled', ${db.q(teamB)}, ${db.q(teamA)}, 60, 55, ${db.q(teamB)}, 0.5, 0.5, 50, 50, NULL, datetime('now'), datetime('now')),
      ('s2-bc1', ${db.q(fakeSeasonId)}, 'regular', 3, '2026-06-10T08:30:00+08:00', 'settled', ${db.q(teamB)}, ${db.q(teamC)}, 80, 70, ${db.q(teamB)}, 0.5, 0.5, 50, 50, NULL, datetime('now'), datetime('now')),
      ('s2-bc2', ${db.q(fakeSeasonId)}, 'regular', 4, '2026-06-10T13:30:00+08:00', 'settled', ${db.q(teamC)}, ${db.q(teamB)}, 60, 55, ${db.q(teamC)}, 0.5, 0.5, 50, 50, NULL, datetime('now'), datetime('now')),
      ('s2-ac1', ${db.q(fakeSeasonId)}, 'regular', 5, '2026-06-11T08:30:00+08:00', 'settled', ${db.q(teamA)}, ${db.q(teamC)}, 60, 55, ${db.q(teamC)}, 0.5, 0.5, 50, 50, NULL, datetime('now'), datetime('now')),
      ('s2-ac2', ${db.q(fakeSeasonId)}, 'regular', 6, '2026-06-11T13:30:00+08:00', 'settled', ${db.q(teamC)}, ${db.q(teamA)}, 70, 60, ${db.q(teamC)}, 0.5, 0.5, 50, 50, NULL, datetime('now'), datetime('now'));
  `);
  db.exec(`UPDATE basketball_team_season_stats SET points_for = 100, points_against = 200 WHERE season_id = ${db.q(fakeSeasonId)} AND team_id = ${db.q(teamA)};`);
  db.exec(`UPDATE basketball_team_season_stats SET points_for = 140, points_against = 130 WHERE season_id = ${db.q(fakeSeasonId)} AND team_id = ${db.q(teamB)};`);
  db.exec(`UPDATE basketball_team_season_stats SET points_for = 130, points_against = 140 WHERE season_id = ${db.q(fakeSeasonId)} AND team_id = ${db.q(teamC)};`);

  const standings2 = sports.getStandings(fakeSeasonId);
  const rankA2 = standings2.find((r) => r.team_id === teamA)?.rank;
  const rankB2 = standings2.find((r) => r.team_id === teamB)?.rank;
  const rankC2 = standings2.find((r) => r.team_id === teamC)?.rank;
  assert.equal(rankB2, 1, 'teamB 应排第 1 (point_diff=-100 的 teamA 不应仅凭净胜分反超)');
  assert.equal(rankC2, 2, 'teamC 应排第 2 (净胜分 -10 但交锋净胜 +1)');
  assert.equal(rankA2, 3, 'teamA 应排第 3 (point_diff=-100)');

  console.log('sports-engine-test: PASS');
} finally {
  cleanup();
}

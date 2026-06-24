const crypto = require('node:crypto');
const db = require('./db');
const clock = require('./clock');

const COMPETITION_ID = 'basketball-ssb';
const MATCH_TIMES = [
  [8, 30], [9, 30], [10, 30], [11, 30],
  [13, 30], [14, 30], [15, 30], [16, 30]
];
const PREFERRED_TIMES = [
  [9, 30], [10, 30], [13, 30], [14, 30], [15, 30]
];
const PLAYOFF_BASE_DAY = 10;
const REGULAR_DAYS = 10;
const SLOTS_PER_DAY = PREFERRED_TIMES.length;
const MAX_BET_PER_SERIES = 200000;
const DEFAULT_CONFIG = Object.freeze({
  house_edge: 0.05,
  min_bet: 1000,
  max_bet_per_match: 100000,
  home_advantage: 0.05,
  regular_form_cap: 0.03,
  form_cap: 0.15,
  regular_win_cap: 0.80,
  playoff_win_cap: 0.85,
  regular_scale_factor: 0.07,
  scale_factor: 0.15,
  transfer_pct_min: 0.20,
  transfer_pct_max: 0.25
});
const ACTIVE_SEASON_STATUSES = ['regular', 'quarterfinal', 'semifinal', 'final'];
const TEAM_NAMES = [
  ['北京', '龙焰'], ['上海', '飓风'], ['广州', '南狮'], ['深圳', '闪电'],
  ['杭州', '潮汐'], ['南京', '猛虎'], ['成都', '熊猫'], ['重庆', '飞鹰'],
  ['武汉', '巨浪'], ['西安', '秦箭'], ['天津', '海狼'], ['青岛', '海鲨'],
  ['长沙', '星火'], ['苏州', '剑鱼'], ['厦门', '白鹭'], ['宁波', '地鼠']
];
const STAR_BUCKETS = [
  [5, 10, 90, 99],
  [4, 30, 75, 89],
  [3, 60, 55, 74],
  [2, 40, 35, 54],
  [1, 20, 15, 34]
];

function ensureSports(now = clock.now()) {
  seedCatalog();
  const parts = clock.shanghaiParts(now);

  if (dayOfWeek(parts.date) === 1 && (parts.hour < 8 || (parts.hour === 8 && parts.minute < 30))) {
    const activeSeason = getActiveSeason();
    if (activeSeason && activeSeason.season_type === 'warmup') {
      return db.transaction(() => {
        const pending = db.all(`SELECT * FROM sports_matches WHERE season_id = ${db.q(activeSeason.id)} AND status NOT IN ('settled', 'canceled');`);
        for (const match of pending) {
          cancelMatchInside(match.id, '热身赛季自动结束，转为完整赛季');
        }
        return createSeason(now, 'full');
      });
    }
  }

  const active = getActiveSeason();
  if (active) return active;
  const latest = getLatestSeason();
  if (!latest) return createSeason(now);
  const nextMonday = clock.addDays(latest.week_monday, 14);
  if (parts.date >= nextMonday) return createSeason(now);
  return latest;
}

function seedCatalog() {
  db.exec(`INSERT OR IGNORE INTO sports_competitions (id, code, name, sport_type, status, created_at)
    VALUES (${db.q(COMPETITION_ID)}, 'SSB-BASKETBALL', 'SBA 篮球联赛', 'basketball', 'active', datetime('now'));`);
  db.exec(`INSERT OR IGNORE INTO sports_config
    (id, paused, house_edge, min_bet, max_bet_per_match, home_advantage, regular_form_cap, form_cap,
     regular_win_cap, playoff_win_cap, regular_scale_factor, scale_factor, updated_at)
    VALUES (1, 0, ${DEFAULT_CONFIG.house_edge}, ${DEFAULT_CONFIG.min_bet}, ${DEFAULT_CONFIG.max_bet_per_match},
      ${DEFAULT_CONFIG.home_advantage}, ${DEFAULT_CONFIG.regular_form_cap}, ${DEFAULT_CONFIG.form_cap},
      ${DEFAULT_CONFIG.regular_win_cap}, ${DEFAULT_CONFIG.playoff_win_cap}, ${DEFAULT_CONFIG.regular_scale_factor},
      ${DEFAULT_CONFIG.scale_factor}, datetime('now'));`);

  if (!db.get('SELECT id FROM basketball_teams LIMIT 1;')) {
    TEAM_NAMES.forEach(([city, nickname], index) => {
      db.exec(`INSERT INTO basketball_teams (id, code, name, city, championships, created_at)
        VALUES (${db.q(`team-${index + 1}`)}, ${db.q(`BL${String(index + 1).padStart(2, '0')}`)},
          ${db.q(city + nickname)}, ${db.q(city)}, 0, datetime('now'));`);
    });
  }
  if (!db.get('SELECT id FROM basketball_players LIMIT 1;')) seedPlayers();
}

function seedPlayers() {
  const stars = [];
  STAR_BUCKETS.forEach(([star, count, min, max]) => {
    for (let i = 0; i < count; i += 1) {
      const ability = min + ((i * 7 + star * 3) % (max - min + 1));
      stars.push({ star, ability });
    }
  });
  // 160名球员打乱后每人分配到一个球队，每队10人
  const players = stars.map((rating, index) => ({
    id: `player-${index + 1}`,
    name: `P${String(index + 1).padStart(3, '0')}`,
    position: 'A',
    stars: rating.star,
    ability: rating.ability
  }));
  const shuffled = shuffle(players, Math.random);
  for (let teamIndex = 0; teamIndex < TEAM_NAMES.length; teamIndex += 1) {
    const teamId = `team-${teamIndex + 1}`;
    const roster = shuffled.slice(teamIndex * 10, teamIndex * 10 + 10);
    for (const player of roster) {
      db.exec(`INSERT INTO basketball_players
        (id, name, position, stars, ability, team_id, starter, championships, history_json, created_at, updated_at)
        VALUES (${db.q(player.id)}, ${db.q(player.name)}, ${db.q(player.position)}, ${player.stars}, ${player.ability},
          ${db.q(teamId)}, 0, 0, ${db.q(JSON.stringify([teamId]))}, datetime('now'), datetime('now'));`);
    }
  }
  refreshStarters();
}

function refreshStarters() {
  db.exec('UPDATE basketball_players SET starter = 0, updated_at = datetime(\'now\');');
  for (const team of getTeams()) {
    const starters = db.all(`SELECT id FROM basketball_players
      WHERE team_id = ${db.q(team.id)}
      ORDER BY ability DESC, id ASC LIMIT 5;`);
    starters.forEach((player) => {
      db.exec(`UPDATE basketball_players SET starter = 1, updated_at = datetime('now') WHERE id = ${db.q(player.id)};`);
    });
  }
}

function createSeason(now = clock.now(), forcedType = null, forcedMonday = null) {
  const parts = clock.shanghaiParts(now);
  const monday = forcedMonday || mondayOf(parts.date);
  const seasonType = forcedType || (dayOfWeek(parts.date) === 1 && (parts.hour < 8 || (parts.hour === 8 && parts.minute < 30))
    ? 'full'
    : 'warmup');
  const latest = getLatestSeason();
  const seasonNo = Number(latest?.season_no || 0) + 1;
  applyNextConfig();
  const config = currentConfig();
  const seasonId = `season-${seasonNo}-${crypto.randomUUID().slice(0, 8)}`;
  const startsAt = clock.toZonedIso(monday, 8, 30);
  const endsAt = clock.toZonedIso(clock.addDays(monday, 11), 16, 30);
  db.exec(`INSERT INTO sports_seasons
    (id, competition_id, season_no, season_type, status, week_monday, starts_at, ends_at, config_json, created_at, updated_at)
    VALUES (${db.q(seasonId)}, ${db.q(COMPETITION_ID)}, ${seasonNo}, ${db.q(seasonType)}, 'regular',
      ${db.q(monday)}, ${db.q(startsAt)}, ${db.q(endsAt)}, ${db.q(JSON.stringify(config))}, datetime('now'), datetime('now'));`);

  for (const team of getTeams()) {
    db.exec(`INSERT INTO basketball_team_season_stats
      (season_id, team_id, wins, losses, points_for, points_against, recent_json, tie_breaker)
      VALUES (${db.q(seasonId)}, ${db.q(team.id)}, 0, 0, 0, 0, '[]', ${Math.random()});`);
  }
  generateRegularSchedule(seasonId, monday, now, seasonType);
  if (seasonType === 'full') generatePlayoffSchedule(seasonId, monday);
  if (seasonType === 'full') generateRegularTradePlan(seasonId);
  openEligibleMarkets(now, { initial: true });
  completeSeasonIfReady(seasonId, now);
  return getSeason(seasonId);
}

function generateRegularSchedule(seasonId, monday, now, seasonType) {
  const teamIds = getTeams().map((team) => team.id);
  const rounds = roundRobinRounds(teamIds);
  const allPairs = [];
  rounds.forEach((pairs, roundIdx) => {
    pairs.forEach(([home, away], matchIdx) => {
      allPairs.push({ roundNo: roundIdx + 1, matchNo: matchIdx, home, away });
    });
  });
  const nowMs = now.getTime();
  const totalSlots = REGULAR_DAYS * SLOTS_PER_DAY;
  const totalMatches = allPairs.length;
  const maxPerSlot = Math.floor(totalMatches / totalSlots);
  const bigSlotCount = totalMatches % totalSlots;
  const perSlot = [];
  for (let i = 0; i < totalSlots; i += 1) {
    perSlot.push(i < bigSlotCount ? maxPerSlot + 1 : maxPerSlot);
  }
  const slots = [];
  for (let day = 0; day < REGULAR_DAYS; day += 1) {
    for (let s = 0; s < SLOTS_PER_DAY; s += 1) {
      slots.push({ day, timeIndex: PREFERRED_TIMES[s], matches: [], teams: new Set() });
    }
  }
  for (let si = 0; si < slots.length; si += 1) {
    const slot = slots[si];
    const max = perSlot[si];
    for (const pair of allPairs) {
      if (pair.assigned) continue;
      if (slot.teams.has(pair.home) || slot.teams.has(pair.away)) continue;
      if (slot.matches.length >= max) break;
      slot.matches.push(pair);
      slot.teams.add(pair.home);
      slot.teams.add(pair.away);
      pair.assigned = true;
    }
  }
  for (const slot of slots) {
    const [hour, minute] = slot.timeIndex;
    for (const pair of slot.matches) {
      const scheduledAt = clock.toZonedIso(clock.addDays(monday, slot.day), hour, minute);
      const pastWarmup = seasonType === 'warmup' && new Date(scheduledAt).getTime() <= nowMs;
      insertMatch({
        id: `${seasonId}-R${pair.roundNo}-M${pair.matchNo}`,
        seasonId,
        stage: 'regular',
        roundNo: pair.roundNo,
        scheduledAt,
        home: pair.home,
        away: pair.away,
        status: pastWarmup ? 'canceled' : 'unopened',
        cancelReason: pastWarmup ? '热身赛季启用前已错过' : null
      });
    }
  }
}

function regularRoundSlot(roundNo, matchIndex) {
  const totalSlots = REGULAR_DAYS * SLOTS_PER_DAY;
  const globalIndex = (roundNo - 1) * 8 + (matchIndex || 0);
  const slotIdx = globalIndex % totalSlots;
  const day = Math.floor(slotIdx / SLOTS_PER_DAY);
  const timeIdx = slotIdx % SLOTS_PER_DAY;
  const [hour, minute] = PREFERRED_TIMES[timeIdx];
  return { day, hour, minute };
}

function roundRobinRounds(teamIds) {
  const rotating = teamIds.slice();
  const rounds = [];
  for (let leg = 0; leg < 2; leg += 1) {
    for (let round = 0; round < teamIds.length - 1; round += 1) {
      const pairs = [];
      for (let i = 0; i < teamIds.length / 2; i += 1) {
        let a = rotating[i];
        let b = rotating[teamIds.length - 1 - i];
        if ((round + i) % 2) [a, b] = [b, a];
        if (leg === 1) [a, b] = [b, a];
        pairs.push([a, b]);
      }
      rounds.push(pairs);
      rotating.splice(1, 0, rotating.pop());
    }
  }
  return rounds;
}

function generatePlayoffSchedule(seasonId, monday) {
  const definitions = [
    ['quarterfinal', 4, 3, [[10, 1], [10, 2], [10, 4]]],
    ['semifinal', 2, 3, [[10, 5], [10, 6], [11, 1]]],
    ['final', 1, 3, [[11, 2], [11, 4], [11, 5]]]
  ];
  definitions.forEach(([stage, count, bestOf, slots]) => {
    for (let slot = 1; slot <= count; slot += 1) {
      const seriesId = `${seasonId}-${stage}-${slot}`;
      const seeds = stage === 'quarterfinal' ? [[1, 8], [2, 7], [3, 6], [4, 5]][slot - 1] : [null, null];
      db.exec(`INSERT INTO basketball_series
        (id, season_id, stage, bracket_slot, best_of, home_seed, away_seed, status, created_at, updated_at)
        VALUES (${db.q(seriesId)}, ${db.q(seasonId)}, ${db.q(stage)}, ${slot}, ${bestOf},
          ${seeds[0] == null ? 'NULL' : seeds[0]}, ${seeds[1] == null ? 'NULL' : seeds[1]},
          'pending', datetime('now'), datetime('now'));`);
      db.exec(`INSERT INTO sports_series_markets (id, series_id, status, created_at, updated_at)
        VALUES (${db.q(`series-market-${seriesId}`)}, ${db.q(seriesId)}, 'unopened', datetime('now'), datetime('now'));`);
      slots.forEach(([day, timeIndex], gameIndex) => {
        const time = timeParts(timeIndex);
        insertMatch({
          id: `${seriesId}-G${gameIndex + 1}`,
          seasonId,
          stage,
          roundNo: gameIndex + 1,
          seriesId,
          gameNo: gameIndex + 1,
          scheduledAt: clock.toZonedIso(clock.addDays(monday, day), time.hour, time.minute),
          status: 'unopened'
        });
      });
    }
  });
}

function insertMatch(match) {
  db.exec(`INSERT INTO sports_matches
    (id, season_id, stage, round_no, series_id, game_no, scheduled_at, home_team_id, away_team_id,
     status, cancel_reason, created_at, updated_at)
    VALUES (${db.q(match.id)}, ${db.q(match.seasonId)}, ${db.q(match.stage)}, ${match.roundNo},
      ${match.seriesId ? db.q(match.seriesId) : 'NULL'}, ${match.gameNo || 'NULL'}, ${db.q(match.scheduledAt)},
      ${match.home ? db.q(match.home) : 'NULL'}, ${match.away ? db.q(match.away) : 'NULL'},
      ${db.q(match.status || 'unopened')}, ${match.cancelReason ? db.q(match.cancelReason) : 'NULL'},
      datetime('now'), datetime('now'));`);
  db.exec(`INSERT INTO sports_markets (id, match_id, status, created_at, updated_at)
    VALUES (${db.q(`market-${match.id}`)}, ${db.q(match.id)}, 'unopened', datetime('now'), datetime('now'));`);
}

function processClock(options = {}) {
  const now = options.now || clock.now();
  const sleeping = !!options.sleeping;
  ensureSports(now);
  openEligibleMarkets(now);
  openEligibleSeriesMarkets(now);
  const config = configRow();
  const due = db.all(`SELECT * FROM sports_matches
    WHERE status IN ('unopened', 'open') AND scheduled_at <= ${db.q(clock.serverTimeIso(now))}
    ORDER BY scheduled_at, id;`);
  const results = [];
  for (const match of due) {
    const delayMs = now.getTime() - new Date(match.scheduled_at).getTime();
    if (sleeping || config.paused) {
      results.push(cancelMatch(match.id, sleeping ? '全局休眠期间错过' : '赛事暂停期间错过'));
    } else if (match.home_team_id && match.away_team_id) {
      results.push(settleMatch(match.id, now));
    } else {
      results.push(cancelMatch(match.id, '对阵双方未及时确定'));
    }
  }
  const active = getActiveSeason();
  if (active) completeSeasonIfReady(active.id, now);
  ensureSports(now);
  return results;
}

function openEligibleMarkets(now = clock.now(), options = {}) {
  const parts = clock.shanghaiParts(now);
  const tomorrow = clock.addDays(parts.date, 1);
  const rows = db.all(`SELECT m.*, mk.status AS market_status
    FROM sports_matches m JOIN sports_markets mk ON mk.match_id = m.id
    WHERE m.status = 'unopened' AND m.home_team_id IS NOT NULL AND m.away_team_id IS NOT NULL
      AND m.scheduled_at > ${db.q(clock.serverTimeIso(now))}
    ORDER BY m.scheduled_at;`);
  rows.forEach((match) => {
    const matchDate = String(match.scheduled_at).slice(0, 10);
    const tomorrowOpen = options.initial || parts.hour >= 8;
    const eligible = match.stage !== 'regular' || matchDate <= parts.date || (tomorrowOpen && matchDate === tomorrow);
    if (eligible) openMarket(match.id, now);
  });
}

function openMarket(matchId, now = clock.now()) {
  const match = getMatch(matchId);
  if (!match || match.status !== 'unopened' || !match.home_team_id || !match.away_team_id) return match;
  const season = getSeason(match.season_id);
  const config = JSON.parse(season.config_json);
  const snapshot = probabilitySnapshot(match, config);
  const homeOdds = decimalOdds(snapshot.homeProbability, config.house_edge);
  const awayOdds = decimalOdds(snapshot.awayProbability, config.house_edge);
  db.exec(`UPDATE sports_matches SET status = 'open',
      home_strength = ${snapshot.homeStrength}, away_strength = ${snapshot.awayStrength},
      home_win_probability = ${snapshot.homeProbability}, away_win_probability = ${snapshot.awayProbability},
      updated_at = datetime('now') WHERE id = ${db.q(matchId)} AND status = 'unopened';`);
  db.exec(`UPDATE sports_markets SET status = 'open', home_odds = ${homeOdds}, away_odds = ${awayOdds},
      opened_at = ${db.q(clock.serverTimeIso(now))}, updated_at = datetime('now')
      WHERE match_id = ${db.q(matchId)} AND status = 'unopened';`);
  return getMatch(matchId);
}

function openEligibleSeriesMarkets(now = clock.now(), options = {}) {
  if (!options.skipTimeGuard && clock.shanghaiParts(now).hour < 17) return;
  const rows = db.all(`SELECT s.id FROM basketball_series s
    JOIN sports_series_markets sm ON sm.series_id = s.id
    WHERE s.home_team_id IS NOT NULL AND s.away_team_id IS NOT NULL
      AND s.status = 'active' AND sm.status = 'unopened';`);
  rows.forEach((row) => openSeriesMarket(row.id, now));
}

function openSeriesMarket(seriesId, now = clock.now()) {
  const series = db.get(`SELECT * FROM basketball_series WHERE id = ${db.q(seriesId)};`);
  if (!series || series.status !== 'active' || !series.home_team_id || !series.away_team_id) return null;
  const market = db.get(`SELECT * FROM sports_series_markets WHERE series_id = ${db.q(seriesId)};`);
  if (!market || market.status !== 'unopened') return market;
  const matches = db.all(`SELECT * FROM sports_matches WHERE series_id = ${db.q(seriesId)} ORDER BY game_no;`);
  if (matches.length !== Number(series.best_of) || matches.some((match) => match.home_win_probability == null || match.away_win_probability == null)) {
    return market;
  }
  const probabilities = matches.map((match) => Number(
    match.home_team_id === series.home_team_id ? match.home_win_probability : match.away_win_probability
  ));
  if (probabilities.length !== 3) return market;
  const [p1, p2, p3] = probabilities;
  const homeProbability = round(
    p1 * p2 + p1 * (1 - p2) * p3 + (1 - p1) * p2 * p3,
    6
  );
  const season = getSeason(series.season_id);
  const config = safeJson(season?.config_json, currentConfig());
  const homeOdds = decimalOdds(homeProbability, Number(config.house_edge));
  const awayOdds = decimalOdds(1 - homeProbability, Number(config.house_edge));
  const openedAt = clock.serverTimeIso(now);
  db.exec(`UPDATE sports_series_markets SET status = 'open',
      home_win_probability = ${homeProbability}, away_win_probability = ${round(1 - homeProbability, 6)},
      home_odds = ${homeOdds}, away_odds = ${awayOdds}, opened_at = ${db.q(openedAt)}, updated_at = datetime('now')
    WHERE series_id = ${db.q(seriesId)} AND status = 'unopened';`);
  return db.get(`SELECT * FROM sports_series_markets WHERE series_id = ${db.q(seriesId)};`);
}

function lockSeriesMarket(seriesId, now = clock.now()) {
  if (!seriesId) return;
  db.exec(`UPDATE sports_series_markets SET status = 'locked', locked_at = ${db.q(clock.serverTimeIso(now))},
      updated_at = datetime('now') WHERE series_id = ${db.q(seriesId)} AND status IN ('unopened', 'open');`);
}

function probabilitySnapshot(match, config) {
  const homeBase = teamBaseStrength(match.home_team_id);
  const awayBase = teamBaseStrength(match.away_team_id);
  const isRegular = match.stage === 'regular';
  const formCap = isRegular
    ? Number(config.regular_form_cap ?? DEFAULT_CONFIG.regular_form_cap)
    : Number(config.form_cap ?? DEFAULT_CONFIG.form_cap);
  const scaleFactor = isRegular
    ? Number(config.regular_scale_factor ?? DEFAULT_CONFIG.regular_scale_factor)
    : Number(config.scale_factor ?? DEFAULT_CONFIG.scale_factor);
  const homeForm = teamFormAdjustment(match.home_team_id, match.season_id, formCap);
  const awayForm = teamFormAdjustment(match.away_team_id, match.season_id, formCap);
  const homeStrength = homeBase * (1 + homeForm);
  const awayStrength = awayBase * (1 + awayForm);
  const cap = isRegular ? config.regular_win_cap : config.playoff_win_cap;
  const scale = Math.max(8, (homeStrength + awayStrength) * scaleFactor);
  const raw = 0.5 + (homeStrength - awayStrength) / scale * (cap - 0.5) + config.home_advantage;
  const homeProbability = clamp(raw, 1 - cap, cap);
  return {
    homeStrength: round(homeStrength, 4),
    awayStrength: round(awayStrength, 4),
    homeProbability: round(homeProbability, 6),
    awayProbability: round(1 - homeProbability, 6)
  };
}

function teamBaseStrength(teamId) {
  const starters = db.all(`SELECT ability FROM basketball_players WHERE team_id = ${db.q(teamId)} AND starter = 1;`);
  const bench = db.all(`SELECT ability FROM basketball_players WHERE team_id = ${db.q(teamId)} AND starter = 0;`);
  return average(starters.map((row) => Number(row.ability))) * 0.85 + average(bench.map((row) => Number(row.ability))) * 0.15;
}

function teamFormAdjustment(teamId, seasonId, cap) {
  const rows = db.all(`SELECT home_team_id, away_team_id, home_score, away_score FROM sports_matches
    WHERE season_id = ${db.q(seasonId)} AND status = 'settled'
      AND (home_team_id = ${db.q(teamId)} OR away_team_id = ${db.q(teamId)})
    ORDER BY settled_at DESC LIMIT 5;`);
  if (!rows.length) return 0;
  const differential = rows.reduce((sum, row) => {
    return sum + (row.home_team_id === teamId
      ? Number(row.home_score) - Number(row.away_score)
      : Number(row.away_score) - Number(row.home_score));
  }, 0) / rows.length;
  return clamp(differential / 60, -cap, cap);
}

function teamStrengthStars(strength) {
  const s = Number(strength) || 0;
  if (s >= 80) return 5;
  if (s >= 76) return 4;
  if (s >= 72) return 3;
  if (s >= 68) return 2;
  return 1;
}

function computeStreak(recent) {
  if (!Array.isArray(recent) || !recent.length) return { type: null, count: 0 };
  const last = String(recent[recent.length - 1]).toUpperCase();
  if (last !== 'W' && last !== 'L') return { type: null, count: 0 };
  let count = 0;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if (String(recent[i]).toUpperCase() === last) count += 1;
    else break;
  }
  return { type: last, count };
}

function placeBet(user, body, now = clock.now()) {
  const matchId = String(body.matchId || '');
  const selection = String(body.selectionTeamId || '');
  const amount = round(Number(body.amount), 2);
  const rawRequestId = body.clientRequestId == null ? '' : String(body.clientRequestId);
  const clientRequestId = rawRequestId ? rawRequestId.slice(0, 64) : '';
  if (!matchId || !selection || !Number.isFinite(amount)) throw new Error('竞猜参数不完整');
  if (clientRequestId) {
    const existing = db.get(`SELECT * FROM sports_bets
      WHERE user_id = ${db.q(user.id)} AND client_request_id = ${db.q(clientRequestId)};`);
    if (existing) return getBet(existing.id);
  }
  return db.transaction(() => {
    if (clientRequestId) {
      const existing = db.get(`SELECT * FROM sports_bets
        WHERE user_id = ${db.q(user.id)} AND client_request_id = ${db.q(clientRequestId)};`);
      if (existing) return getBet(existing.id);
    }
    const marketState = db.get('SELECT * FROM market_state WHERE id = 1;');
    const config = configRow();
    if (marketState?.sleeping) throw new Error('本局已休眠，暂不能竞猜');
    if (config.paused) throw new Error('赛事已暂停，暂不能竞猜');
    if (user.bankrupt) throw new Error('已破产，无法竞猜');
    const match = db.get(`SELECT m.*, mk.status AS market_status, mk.home_odds, mk.away_odds
      FROM sports_matches m JOIN sports_markets mk ON mk.match_id = m.id WHERE m.id = ${db.q(matchId)};`);
    if (!match || match.status !== 'open' || match.market_status !== 'open') throw new Error('该场比赛当前未开放竞猜');
    if (new Date(match.scheduled_at).getTime() <= now.getTime()) throw new Error('比赛已经开始');
    if (![match.home_team_id, match.away_team_id].includes(selection)) throw new Error('竞猜选项无效');
    if (amount < Number(config.min_bet)) throw new Error(`单笔竞猜不得低于 ${moneyText(config.min_bet)}`);
    const currentTotal = Number(db.get(`SELECT COALESCE(SUM(amount), 0) AS total FROM sports_bets
      WHERE user_id = ${db.q(user.id)} AND match_id = ${db.q(matchId)}
        AND status IN ('pending', 'won', 'lost');`)?.total || 0);
    if (currentTotal + amount > Number(config.max_bet_per_match)) {
      throw new Error(`单场累计竞猜不得超过 ${moneyText(config.max_bet_per_match)}`);
    }
    const fresh = db.get(`SELECT cash FROM users WHERE id = ${db.q(user.id)};`);
    if (Number(fresh?.cash || 0) < amount) throw new Error('可用资金不足');
    const odds = selection === match.home_team_id ? Number(match.home_odds) : Number(match.away_odds);
    const betId = crypto.randomUUID();
    db.exec(`UPDATE users SET cash = ROUND(cash - ${amount}, 2), updated_at = datetime('now') WHERE id = ${db.q(user.id)};`);
    db.exec(`INSERT INTO sports_bets
      (id, user_id, match_id, selection_team_id, amount, locked_odds, status, payout, client_request_id, created_at)
      VALUES (${db.q(betId)}, ${db.q(user.id)}, ${db.q(matchId)}, ${db.q(selection)}, ${amount}, ${odds}, 'pending', 0,
        ${clientRequestId ? db.q(clientRequestId) : 'NULL'}, ${db.q(clock.serverTimeIso(now))});`);
    cashEvent(user.id, betId, matchId, 'stake', -amount, { odds, selection });
    return getBet(betId);
  });
}

function placeSeriesBet(user, body, now = clock.now()) {
  const seriesId = String(body.seriesId || '');
  const selection = String(body.selectionTeamId || '');
  const amount = round(Number(body.amount), 2);
  const rawRequestId = body.clientRequestId == null ? '' : String(body.clientRequestId);
  const clientRequestId = rawRequestId ? rawRequestId.slice(0, 64) : '';
  if (!seriesId || !selection || !Number.isFinite(amount)) throw new Error('系列赛竞猜参数不完整');
  if (clientRequestId) {
    const existing = db.get(`SELECT * FROM sports_series_bets
      WHERE user_id = ${db.q(user.id)} AND client_request_id = ${db.q(clientRequestId)};`);
    if (existing) return getSeriesBet(existing.id);
  }
  return db.transaction(() => {
    if (clientRequestId) {
      const existing = db.get(`SELECT * FROM sports_series_bets
        WHERE user_id = ${db.q(user.id)} AND client_request_id = ${db.q(clientRequestId)};`);
      if (existing) return getSeriesBet(existing.id);
    }
    const marketState = db.get('SELECT * FROM market_state WHERE id = 1;');
    const config = configRow();
    if (marketState?.sleeping) throw new Error('本局已休眠，暂不能竞猜');
    if (config.paused) throw new Error('赛事已暂停，暂不能竞猜');
    if (user.bankrupt) throw new Error('已破产，无法竞猜');
    const series = db.get(`SELECT s.*, sm.status AS market_status, sm.home_odds, sm.away_odds,
        g1.scheduled_at AS game_one_at, g1.status AS game_one_status
      FROM basketball_series s
      JOIN sports_series_markets sm ON sm.series_id = s.id
      LEFT JOIN sports_matches g1 ON g1.series_id = s.id AND g1.game_no = 1
      WHERE s.id = ${db.q(seriesId)};`);
    if (!series?.home_team_id || !series?.away_team_id) throw new Error('系列赛对阵尚未确定');
    if (series.status !== 'active' || series.market_status !== 'open') throw new Error('该系列赛当前未开放竞猜');
    if (!series.game_one_at || new Date(series.game_one_at).getTime() <= now.getTime()
      || !['unopened', 'open'].includes(series.game_one_status)) {
      throw new Error('系列赛第一场已经开始');
    }
    if (![series.home_team_id, series.away_team_id].includes(selection)) throw new Error('系列赛竞猜选项无效');
    if (amount < Number(config.min_bet)) throw new Error(`单笔竞猜不得低于 ${moneyText(config.min_bet)}`);
    const currentTotal = Number(db.get(`SELECT COALESCE(SUM(amount), 0) AS total FROM sports_series_bets
      WHERE user_id = ${db.q(user.id)} AND series_id = ${db.q(seriesId)}
        AND status IN ('pending', 'won', 'lost');`)?.total || 0);
    if (currentTotal + amount > MAX_BET_PER_SERIES) {
      throw new Error(`单系列赛累计竞猜不得超过 ${moneyText(MAX_BET_PER_SERIES)}`);
    }
    const fresh = db.get(`SELECT cash FROM users WHERE id = ${db.q(user.id)};`);
    if (Number(fresh?.cash || 0) < amount) throw new Error('可用资金不足');
    const odds = selection === series.home_team_id ? Number(series.home_odds) : Number(series.away_odds);
    const betId = crypto.randomUUID();
    db.exec(`UPDATE users SET cash = ROUND(cash - ${amount}, 2), updated_at = datetime('now') WHERE id = ${db.q(user.id)};`);
    db.exec(`INSERT INTO sports_series_bets
      (id, user_id, series_id, selection_team_id, amount, locked_odds, status, payout, client_request_id, created_at)
      VALUES (${db.q(betId)}, ${db.q(user.id)}, ${db.q(seriesId)}, ${db.q(selection)}, ${amount}, ${odds}, 'pending', 0,
        ${clientRequestId ? db.q(clientRequestId) : 'NULL'}, ${db.q(clock.serverTimeIso(now))});`);
    cashEvent(user.id, betId, null, 'stake', -amount, { odds, selection, market_type: 'series' }, seriesId);
    return getSeriesBet(betId);
  });
}

function settleMatch(matchId, now = clock.now()) {
  return db.transaction(() => settleMatchInside(matchId, now));
}

function settleMatchInside(matchId, now) {
  let match = getMatch(matchId);
  if (!match || ['settled', 'canceled'].includes(match.status)) return match;
  if (!match.home_team_id || !match.away_team_id) return cancelMatchInside(matchId, '对阵双方未确定');
  if (match.status === 'unopened') openMarket(matchId, now);
  match = getMatch(matchId);
  if (Number(match.game_no) === 1 && match.series_id) lockSeriesMarket(match.series_id, now);
  db.exec(`UPDATE sports_matches SET status = 'locked', updated_at = datetime('now')
    WHERE id = ${db.q(matchId)} AND status IN ('unopened', 'open');`);
  db.exec(`UPDATE sports_markets SET status = 'locked', locked_at = ${db.q(clock.serverTimeIso(now))}, updated_at = datetime('now')
    WHERE match_id = ${db.q(matchId)} AND status IN ('unopened', 'open');`);
  const homeWins = Math.random() < Number(match.home_win_probability || 0.5);
  const expectedMargin = (Number(match.home_win_probability || 0.5) - 0.5) * 93;
  let margin = Math.max(1, Math.round(Math.abs(expectedMargin) + Math.random() * 8));
  const total = 205 + Math.floor(Math.random() * 56);
  let homeScore = Math.round((total + (homeWins ? margin : -margin)) / 2);
  let awayScore = total - homeScore;
  if (homeScore === awayScore) homeWins ? homeScore++ : awayScore++;
  const winner = homeWins ? match.home_team_id : match.away_team_id;
  const settledAt = clock.serverTimeIso(now);
  db.exec(`UPDATE sports_matches SET status = 'settled', home_score = ${homeScore}, away_score = ${awayScore},
      winner_team_id = ${db.q(winner)}, settled_at = ${db.q(settledAt)}, updated_at = datetime('now')
      WHERE id = ${db.q(matchId)} AND status = 'locked';`);
  db.exec(`UPDATE sports_markets SET status = 'settled', settled_at = ${db.q(settledAt)}, updated_at = datetime('now')
    WHERE match_id = ${db.q(matchId)} AND status = 'locked';`);
  settleBets(matchId, winner, settledAt);
  if (match.stage === 'regular') {
    updateRegularStats(match, homeScore, awayScore);
    executeDueRegularTrades(match.season_id, now);
  }
  else updateSeries(match, winner, now);
  completeSeasonIfReady(match.season_id, now);
  return getMatch(matchId);
}

function settleBets(matchId, winner, settledAt) {
  const bets = db.all(`SELECT * FROM sports_bets WHERE match_id = ${db.q(matchId)} AND status = 'pending' ORDER BY created_at;`);
  for (const bet of bets) {
    if (bet.selection_team_id === winner) {
      const payout = round(Number(bet.amount) * Number(bet.locked_odds), 2);
      db.exec(`UPDATE users SET cash = ROUND(cash + ${payout}, 2), updated_at = datetime('now') WHERE id = ${db.q(bet.user_id)};`);
      db.exec(`UPDATE sports_bets SET status = 'won', payout = ${payout}, settled_at = ${db.q(settledAt)} WHERE id = ${db.q(bet.id)} AND status = 'pending';`);
      cashEvent(bet.user_id, bet.id, matchId, 'payout', payout, { winner });
    } else {
      db.exec(`UPDATE sports_bets SET status = 'lost', payout = 0, settled_at = ${db.q(settledAt)} WHERE id = ${db.q(bet.id)} AND status = 'pending';`);
    }
  }
}

function cancelMatch(matchId, reason = '比赛取消') {
  return db.transaction(() => cancelMatchInside(matchId, reason));
}

function cancelMatchInside(matchId, reason) {
  const match = getMatch(matchId);
  if (!match || ['settled', 'canceled'].includes(match.status)) return match;
  if (Number(match.game_no) === 1 && match.series_id) lockSeriesMarket(match.series_id);
  const bets = db.all(`SELECT * FROM sports_bets WHERE match_id = ${db.q(matchId)} AND status = 'pending';`);
  for (const bet of bets) {
    db.exec(`UPDATE users SET cash = ROUND(cash + ${Number(bet.amount)}, 2), updated_at = datetime('now') WHERE id = ${db.q(bet.user_id)};`);
    db.exec(`UPDATE sports_bets SET status = 'refunded', payout = ${Number(bet.amount)}, settled_at = datetime('now')
      WHERE id = ${db.q(bet.id)} AND status = 'pending';`);
    cashEvent(bet.user_id, bet.id, matchId, 'refund', Number(bet.amount), { reason });
  }
  db.exec(`UPDATE sports_matches SET status = 'canceled', cancel_reason = ${db.q(reason)}, updated_at = datetime('now')
    WHERE id = ${db.q(matchId)} AND status NOT IN ('settled', 'canceled');`);
  db.exec(`UPDATE sports_markets SET status = 'canceled', settled_at = datetime('now'), updated_at = datetime('now')
    WHERE match_id = ${db.q(matchId)} AND status NOT IN ('settled', 'canceled');`);
  const fresh = getMatch(matchId);
  if (fresh?.stage === 'regular') executeDueRegularTrades(fresh.season_id, clock.now());
  if (fresh?.stage !== 'regular' && fresh?.series_id) checkSeriesViability(fresh.series_id);
  completeSeasonIfReady(fresh?.season_id, clock.now());
  return fresh;
}

function updateRegularStats(match, homeScore, awayScore) {
  const homeWon = homeScore > awayScore;
  updateTeamStats(match.season_id, match.home_team_id, homeWon, homeScore, awayScore);
  updateTeamStats(match.season_id, match.away_team_id, !homeWon, awayScore, homeScore);
}

function updateTeamStats(seasonId, teamId, won, pointsFor, pointsAgainst) {
  const row = db.get(`SELECT * FROM basketball_team_season_stats WHERE season_id = ${db.q(seasonId)} AND team_id = ${db.q(teamId)};`);
  const recent = safeJson(row?.recent_json, []);
  recent.push(won ? 'W' : 'L');
  while (recent.length > 5) recent.shift();
  db.exec(`UPDATE basketball_team_season_stats
    SET wins = wins + ${won ? 1 : 0}, losses = losses + ${won ? 0 : 1},
        points_for = points_for + ${pointsFor}, points_against = points_against + ${pointsAgainst},
        recent_json = ${db.q(JSON.stringify(recent))}
    WHERE season_id = ${db.q(seasonId)} AND team_id = ${db.q(teamId)};`);
}

function updateSeries(match, winner, now) {
  const series = db.get(`SELECT * FROM basketball_series WHERE id = ${db.q(match.series_id)};`);
  if (!series || series.status === 'completed') return;
  const isHome = winner === series.home_team_id;
  const nextHomeWins = Number(series.home_wins) + (isHome ? 1 : 0);
  const nextAwayWins = Number(series.away_wins) + (isHome ? 0 : 1);
  const needed = Math.ceil(Number(series.best_of) / 2);
  const completed = nextHomeWins >= needed || nextAwayWins >= needed;
  const seriesWinner = completed ? (nextHomeWins >= needed ? series.home_team_id : series.away_team_id) : null;
  db.exec(`UPDATE basketball_series SET home_wins = ${nextHomeWins}, away_wins = ${nextAwayWins},
      winner_team_id = ${seriesWinner ? db.q(seriesWinner) : 'NULL'}, status = ${db.q(completed ? 'completed' : 'active')},
      updated_at = datetime('now') WHERE id = ${db.q(series.id)};`);
  if (completed) {
    settleSeriesBets(series.id, seriesWinner, clock.serverTimeIso(now));
    const remaining = db.all(`SELECT id FROM sports_matches WHERE series_id = ${db.q(series.id)}
      AND status NOT IN ('settled', 'canceled');`);
    remaining.forEach((row) => cancelMatchInside(row.id, '系列赛已提前结束'));
    advancePlayoffBracket(series.season_id, series.stage, now);
  } else {
    checkSeriesViability(series.id);
  }
}

function advancePlayoffBracket(seasonId, completedStage, now) {
  const stageSeries = db.all(`SELECT * FROM basketball_series WHERE season_id = ${db.q(seasonId)} AND stage = ${db.q(completedStage)} ORDER BY bracket_slot;`);
  if (!stageSeries.length || stageSeries.some((series) => series.status !== 'completed')) return;
  if (completedStage === 'quarterfinal') {
    const semis = db.all(`SELECT * FROM basketball_series WHERE season_id = ${db.q(seasonId)} AND stage = 'semifinal' ORDER BY bracket_slot;`);
    populateSeries(semis[0].id, stageSeries[0].winner_team_id, stageSeries[3].winner_team_id, now);
    populateSeries(semis[1].id, stageSeries[1].winner_team_id, stageSeries[2].winner_team_id, now);
    setSeasonStatus(seasonId, 'semifinal');
  } else if (completedStage === 'semifinal') {
    const final = db.get(`SELECT * FROM basketball_series WHERE season_id = ${db.q(seasonId)} AND stage = 'final' LIMIT 1;`);
    populateSeries(final.id, stageSeries[0].winner_team_id, stageSeries[1].winner_team_id, now);
    setSeasonStatus(seasonId, 'final');
  } else if (completedStage === 'final') {
    finishFullSeason(seasonId, stageSeries[0].winner_team_id);
  }
}

function populateSeries(seriesId, homeTeamId, awayTeamId, now) {
  db.exec(`UPDATE basketball_series SET home_team_id = ${db.q(homeTeamId)}, away_team_id = ${db.q(awayTeamId)},
      status = 'active', updated_at = datetime('now') WHERE id = ${db.q(seriesId)};`);
  const matches = db.all(`SELECT * FROM sports_matches WHERE series_id = ${db.q(seriesId)} ORDER BY game_no;`);
  matches.forEach((match, index) => {
    const swap = index % 2 === 1;
    db.exec(`UPDATE sports_matches SET home_team_id = ${db.q(swap ? awayTeamId : homeTeamId)},
        away_team_id = ${db.q(swap ? homeTeamId : awayTeamId)}, updated_at = datetime('now') WHERE id = ${db.q(match.id)};`);
  });
  openEligibleMarkets(now);
}

function settleSeriesBets(seriesId, winner, settledAt) {
  const bets = db.all(`SELECT * FROM sports_series_bets
    WHERE series_id = ${db.q(seriesId)} AND status = 'pending' ORDER BY created_at;`);
  for (const bet of bets) {
    if (bet.selection_team_id === winner) {
      const payout = round(Number(bet.amount) * Number(bet.locked_odds), 2);
      db.exec(`UPDATE users SET cash = ROUND(cash + ${payout}, 2), updated_at = datetime('now') WHERE id = ${db.q(bet.user_id)};`);
      db.exec(`UPDATE sports_series_bets SET status = 'won', payout = ${payout}, settled_at = ${db.q(settledAt)}
        WHERE id = ${db.q(bet.id)} AND status = 'pending';`);
      cashEvent(bet.user_id, bet.id, null, 'payout', payout, { winner, market_type: 'series' }, seriesId);
    } else {
      db.exec(`UPDATE sports_series_bets SET status = 'lost', payout = 0, settled_at = ${db.q(settledAt)}
        WHERE id = ${db.q(bet.id)} AND status = 'pending';`);
    }
  }
  db.exec(`UPDATE sports_series_markets SET status = 'settled', settled_at = ${db.q(settledAt)}, updated_at = datetime('now')
    WHERE series_id = ${db.q(seriesId)} AND status != 'settled';`);
}

function refundSeriesBets(seriesId, reason, settledAt = clock.serverTimeIso(clock.now())) {
  const bets = db.all(`SELECT * FROM sports_series_bets
    WHERE series_id = ${db.q(seriesId)} AND status = 'pending' ORDER BY created_at;`);
  for (const bet of bets) {
    const amount = Number(bet.amount);
    db.exec(`UPDATE users SET cash = ROUND(cash + ${amount}, 2), updated_at = datetime('now') WHERE id = ${db.q(bet.user_id)};`);
    db.exec(`UPDATE sports_series_bets SET status = 'refunded', payout = ${amount}, settled_at = ${db.q(settledAt)}
      WHERE id = ${db.q(bet.id)} AND status = 'pending';`);
    cashEvent(bet.user_id, bet.id, null, 'refund', amount, { reason, market_type: 'series' }, seriesId);
  }
  db.exec(`UPDATE sports_series_markets SET status = 'canceled', settled_at = ${db.q(settledAt)}, updated_at = datetime('now')
    WHERE series_id = ${db.q(seriesId)} AND status NOT IN ('settled', 'canceled');`);
}

function completeSeasonIfReady(seasonId, now = clock.now()) {
  if (!seasonId) return;
  const season = getSeason(seasonId);
  if (!season || ['completed', 'void'].includes(season.status)) return;
  const regularPending = Number(db.get(`SELECT COUNT(*) AS count FROM sports_matches
    WHERE season_id = ${db.q(seasonId)} AND stage = 'regular' AND status NOT IN ('settled', 'canceled');`)?.count || 0);
  if (regularPending > 0) return;
  if (season.season_type === 'warmup') {
    setSeasonStatus(seasonId, 'completed');
    return;
  }
  if (season.status === 'regular') {
    const standings = getStandings(seasonId);
    const series = db.all(`SELECT * FROM basketball_series WHERE season_id = ${db.q(seasonId)} AND stage = 'quarterfinal' ORDER BY bracket_slot;`);
    for (let i = 0; i < series.length; i += 1) {
      populateSeries(series[i].id, standings[i].team_id, standings[7 - i].team_id, now);
    }
    setSeasonStatus(seasonId, 'quarterfinal');
  }
}

function checkSeriesViability(seriesId) {
  const series = db.get(`SELECT * FROM basketball_series WHERE id = ${db.q(seriesId)};`);
  if (!series || series.status === 'completed') return;
  const remaining = Number(db.get(`SELECT COUNT(*) AS count FROM sports_matches WHERE series_id = ${db.q(seriesId)} AND status NOT IN ('settled', 'canceled');`)?.count || 0);
  const needed = Math.ceil(Number(series.best_of) / 2);
  const homeCanWin = Number(series.home_wins) + remaining >= needed;
  const awayCanWin = Number(series.away_wins) + remaining >= needed;
  if (homeCanWin || awayCanWin) return;
  voidSeason(series.season_id, '季后赛错过比赛，无法决出晋级者');
}

function finishFullSeason(seasonId, championTeamId) {
  const season = getSeason(seasonId);
  if (!season || ['completed', 'void'].includes(season.status)) return;
  const standings = getStandings(seasonId);
  db.exec(`UPDATE basketball_teams SET championships = championships + 1 WHERE id = ${db.q(championTeamId)};`);
  db.exec(`UPDATE basketball_players SET championships = championships + 1 WHERE team_id = ${db.q(championTeamId)};`);
  movePlayers(seasonId);
  applyDraftDevelopment(seasonId, standings);
  db.exec(`UPDATE sports_seasons SET status = 'completed', champion_team_id = ${db.q(championTeamId)}, updated_at = datetime('now')
    WHERE id = ${db.q(seasonId)};`);
}

function movePlayers(seasonId) {
  const TOTAL_PLAYERS = 160;
  const PCT_MIN = DEFAULT_CONFIG.transfer_pct_min;
  const PCT_MAX = DEFAULT_CONFIG.transfer_pct_max;
  const targetCount = randomInt(
    Math.floor(TOTAL_PLAYERS * PCT_MIN),
    Math.floor(TOTAL_PLAYERS * PCT_MAX),
    Math.random
  );

  const pool = db.all('SELECT * FROM basketball_players ORDER BY team_id, id;');
  const shuffled = shuffle(pool, Math.random);
  const selected = shuffled.slice(0, Math.min(targetCount, shuffled.length));

  const teamIds = selected.map((p) => p.team_id);
  let shuffledTeams;
  let attempts = 0;
  do {
    shuffledTeams = shuffle([...teamIds], Math.random);
    attempts++;
  } while (attempts < 100 && teamIds.every((t, i) => t === shuffledTeams[i]));

  let totalMoved = 0;
  for (let i = 0; i < selected.length; i++) {
    const player = selected[i];
    const newTeam = shuffledTeams[i];
    if (player.team_id === newTeam) continue;

    const history = safeJson(player.history_json, []);
    history.push(newTeam);
    db.exec(`UPDATE basketball_players SET team_id = ${db.q(newTeam)}, history_json = ${db.q(JSON.stringify(history))}, updated_at = datetime('now')
      WHERE id = ${db.q(player.id)};`);
    db.exec(`INSERT INTO basketball_player_moves
      (id, season_id, player_id, from_team_id, to_team_id, position, move_type, event_id, created_at)
      VALUES (${db.q(crypto.randomUUID())}, ${db.q(seasonId)}, ${db.q(player.id)}, ${db.q(player.team_id)},
        ${db.q(newTeam)}, ${db.q(player.position)}, 'offseason', NULL, datetime('now'));`);
    totalMoved++;
  }

  if (totalMoved > 0) refreshStarters();
  return totalMoved;
}

function generateRegularTradePlan(seasonId, random = Math.random) {
  const season = getSeason(seasonId);
  if (!season || season.season_type !== 'full') return [];
  const target = randomInt(16, 32, random);
  const usedPlayers = new Set();
  const triggerSet = new Set();
  const events = [];
  let remaining = target;

  while (remaining >= 2) {
    let groupSize = Math.min(randomInt(2, 4, random), remaining);
    if (remaining - groupSize === 1) groupSize -= 1;
    const event = buildRegularTradeEvent(seasonId, groupSize, usedPlayers, triggerSet, random);
    if (!event) break;
    events.push(event);
    remaining -= groupSize;
  }
  return events;
}

function buildRegularTradeEvent(seasonId, groupSize, usedPlayers, triggerSet, random) {
  const teamCandidates = shuffle(getTeams(), random).map((team) => {
    const players = db.all(`SELECT * FROM basketball_players WHERE team_id = ${db.q(team.id)}
      ORDER BY id;`).filter((player) => !usedPlayers.has(player.id));
    return { team, players };
  }).filter((entry) => entry.players.length);
  if (teamCandidates.length < groupSize) return null;

  const chosen = teamCandidates.slice(0, groupSize).map((entry) => {
    const player = entry.players[randomInt(0, entry.players.length - 1, random)];
    return { player_id: player.id, from_team_id: entry.team.id, position: 'A' };
  });
  const plan = chosen.map((item, index) => ({
    ...item,
    to_team_id: chosen[(index + 1) % chosen.length].from_team_id
  }));
  chosen.forEach((item) => usedPlayers.add(item.player_id));
  let trigger = randomInt(24, 216, random);
  while (triggerSet.has(trigger)) trigger = trigger >= 216 ? 24 : trigger + 1;
  triggerSet.add(trigger);
  const id = crypto.randomUUID();
  db.exec(`INSERT INTO basketball_trade_events
    (id, season_id, trigger_completed_matches, position, player_count, plan_json, status, created_at, updated_at)
    VALUES (${db.q(id)}, ${db.q(seasonId)}, ${trigger}, 'A', ${plan.length},
      ${db.q(JSON.stringify(plan))}, 'pending', datetime('now'), datetime('now'));`);
  return { id, season_id: seasonId, trigger_completed_matches: trigger, position: 'A', plan };
}

function executeDueRegularTrades(seasonId, now = clock.now()) {
  const season = getSeason(seasonId);
  if (!season || season.season_type !== 'full' || season.status !== 'regular') return [];
  const completed = Number(db.get(`SELECT COUNT(*) AS count FROM sports_matches
    WHERE season_id = ${db.q(seasonId)} AND stage = 'regular' AND status IN ('settled', 'canceled');`)?.count || 0);
  const due = db.all(`SELECT * FROM basketball_trade_events WHERE season_id = ${db.q(seasonId)}
    AND status = 'pending' AND trigger_completed_matches <= ${completed}
    ORDER BY trigger_completed_matches, created_at;`);
  const executed = [];
  const affectedTeams = new Set();
  for (const event of due) {
    const plan = safeJson(event.plan_json, []);
    const valid = plan.length >= 2 && plan.every((item) => {
      const player = db.get(`SELECT team_id FROM basketball_players WHERE id = ${db.q(item.player_id)};`);
      return player?.team_id === item.from_team_id;
    });
    if (!valid) {
      db.exec(`UPDATE basketball_trade_events SET status = 'skipped', updated_at = datetime('now') WHERE id = ${db.q(event.id)};`);
      continue;
    }
    for (const item of plan) {
      const player = db.get(`SELECT history_json FROM basketball_players WHERE id = ${db.q(item.player_id)};`);
      const history = safeJson(player?.history_json, []);
      history.push(item.to_team_id);
      db.exec(`UPDATE basketball_players SET team_id = ${db.q(item.to_team_id)},
        history_json = ${db.q(JSON.stringify(history))}, updated_at = datetime('now')
        WHERE id = ${db.q(item.player_id)};`);
      db.exec(`INSERT INTO basketball_player_moves
        (id, season_id, player_id, from_team_id, to_team_id, position, move_type, event_id, created_at)
        VALUES (${db.q(crypto.randomUUID())}, ${db.q(seasonId)}, ${db.q(item.player_id)},
          ${db.q(item.from_team_id)}, ${db.q(item.to_team_id)}, ${db.q(item.position)},
          'regular_trade', ${db.q(event.id)}, datetime('now'));`);
      affectedTeams.add(item.from_team_id);
      affectedTeams.add(item.to_team_id);
    }
    db.exec(`UPDATE basketball_trade_events SET status = 'completed', executed_at = datetime('now'),
      updated_at = datetime('now') WHERE id = ${db.q(event.id)};`);
    executed.push(event.id);
  }
  if (executed.length) {
    refreshStarters();
    refreshAffectedOpenMarkets(Array.from(affectedTeams), now);
  }
  return executed;
}

function refreshAffectedOpenMarkets(teamIds, now = clock.now()) {
  if (!Array.isArray(teamIds) || !teamIds.length) return [];
  const teamIdList = teamIds.map((id) => db.q(id)).join(', ');
  const matches = db.all(`SELECT * FROM sports_matches
    WHERE status = 'open' AND stage = 'regular'
      AND (home_team_id IN (${teamIdList}) OR away_team_id IN (${teamIdList}))
      AND scheduled_at > ${db.q(clock.serverTimeIso(now))};`);
  const refreshed = [];
  for (const match of matches) {
    const season = getSeason(match.season_id);
    const config = safeJson(season?.config_json, currentConfig());
    const snapshot = probabilitySnapshot(match, config);
    const homeOdds = decimalOdds(snapshot.homeProbability, config.house_edge);
    const awayOdds = decimalOdds(snapshot.awayProbability, config.house_edge);
    db.exec(`UPDATE sports_matches SET
      home_strength = ${snapshot.homeStrength}, away_strength = ${snapshot.awayStrength},
      home_win_probability = ${snapshot.homeProbability}, away_win_probability = ${snapshot.awayProbability},
      updated_at = datetime('now')
      WHERE id = ${db.q(match.id)} AND status = 'open';`);
    db.exec(`UPDATE sports_markets SET
      home_odds = ${homeOdds}, away_odds = ${awayOdds}, updated_at = datetime('now')
      WHERE match_id = ${db.q(match.id)} AND status = 'open';`);
    const bets = db.all(`SELECT * FROM sports_bets
      WHERE match_id = ${db.q(match.id)} AND status = 'pending';`);
    for (const bet of bets) {
      const newOdds = bet.selection_team_id === match.home_team_id ? homeOdds : awayOdds;
      db.exec(`UPDATE sports_bets SET locked_odds = ${newOdds}
        WHERE id = ${db.q(bet.id)} AND status = 'pending';`);
    }
    refreshed.push({
      id: match.id,
      home_strength: snapshot.homeStrength,
      away_strength: snapshot.awayStrength,
      home_win_probability: snapshot.homeProbability,
      away_win_probability: snapshot.awayProbability,
      home_odds: homeOdds,
      away_odds: awayOdds,
      updated_bets: bets.length
    });
  }
  return refreshed;
}

function applyDraftDevelopment(seasonId, standings, random = Math.random) {
  const bottom = (standings || []).slice().sort((a, b) => Number(b.rank) - Number(a.rank)).slice(0, 4);
  const chances = [1, 0.70, 0.45, 0.25];
  const developments = [];
  bottom.forEach((standing, index) => {
    if (random() > chances[index]) return;
    const player = db.get(`SELECT * FROM basketball_players WHERE team_id = ${db.q(standing.team_id)}
      ORDER BY ability ASC, starter ASC, id ASC LIMIT 1;`);
    if (!player) return;
    const roll = random();
    const thresholds = [
      [0.72, 0.95],
      [0.77, 0.97],
      [0.82, 0.98],
      [0.88, 0.99]
    ][index];
    let type = 'limited';
    let nextAbility = Number(player.ability) + randomInt(3, 8, random);
    if (roll >= thresholds[1]) {
      type = 'starter_breakthrough';
      const starterFloor = Number(db.get(`SELECT MIN(ability) AS ability FROM basketball_players
        WHERE team_id = ${db.q(standing.team_id)} AND starter = 1;`)?.ability || 0);
      nextAbility = Math.max(Number(player.ability) + randomInt(12, 20, random), starterFloor + randomInt(0, 3, random));
    } else if (roll >= thresholds[0]) {
      type = 'rotation_breakthrough';
      nextAbility = Number(player.ability) + randomInt(9, 16, random);
    }
    nextAbility = clamp(nextAbility, Number(player.ability), 99);
    const nextStars = starsForAbility(nextAbility);
    db.exec(`UPDATE basketball_players SET ability = ${nextAbility}, stars = ${nextStars}, updated_at = datetime('now')
      WHERE id = ${db.q(player.id)};`);
    const record = {
      id: crypto.randomUUID(),
      season_id: seasonId,
      team_id: standing.team_id,
      player_id: player.id,
      regular_rank: Number(standing.rank),
      development_type: type,
      ability_before: Number(player.ability),
      ability_after: nextAbility,
      stars_before: Number(player.stars),
      stars_after: nextStars
    };
    db.exec(`INSERT INTO basketball_player_developments
      (id, season_id, team_id, player_id, regular_rank, development_type, ability_before, ability_after,
       stars_before, stars_after, created_at)
      VALUES (${db.q(record.id)}, ${db.q(seasonId)}, ${db.q(record.team_id)}, ${db.q(record.player_id)},
        ${record.regular_rank}, ${db.q(type)}, ${record.ability_before}, ${record.ability_after},
        ${record.stars_before}, ${record.stars_after}, datetime('now'));`);
    developments.push(record);
  });
  if (developments.length) refreshStarters();
  return developments;
}

function voidSeason(seasonId, reason) {
  const season = getSeason(seasonId);
  if (!season || ['completed', 'void'].includes(season.status)) return season;
  db.exec(`UPDATE sports_seasons SET status = 'void', void_reason = ${db.q(reason)}, updated_at = datetime('now') WHERE id = ${db.q(seasonId)};`);
  const series = db.all(`SELECT id FROM basketball_series WHERE season_id = ${db.q(seasonId)};`);
  series.forEach((item) => refundSeriesBets(item.id, reason));
  const pending = db.all(`SELECT id FROM sports_matches WHERE season_id = ${db.q(seasonId)} AND status NOT IN ('settled', 'canceled');`);
  pending.forEach((match) => cancelMatchInside(match.id, reason));
  return getSeason(seasonId);
}

function advanceStage(now = clock.now()) {
  return db.transaction(() => {
    const season = getActiveSeason();
    if (!season) throw new Error('当前没有进行中的赛季');
    const currentStage = season.status;
    const matches = db.all(`SELECT * FROM sports_matches WHERE season_id = ${db.q(season.id)} AND stage = ${db.q(currentStage)}
      AND status NOT IN ('settled', 'canceled') ORDER BY scheduled_at, id;`);
    for (const match of matches) {
      if (match.home_team_id && match.away_team_id) {
        openMarket(match.id, now);
        settleMatchInside(match.id, now);
      } else {
        cancelMatchInside(match.id, '管理员阶段跳跃时对阵未确定');
      }
    }
    completeSeasonIfReady(season.id, now);
    openEligibleSeriesMarkets(now, { skipTimeGuard: true });
    return getSeason(season.id);
  });
}

function getOverview(userId, now = clock.now()) {
  const season = ensureSports(now);
  const today = clock.shanghaiParts(now).date;
  let matchDay = today;
  let matches = publicMatches(db.all(`SELECT * FROM sports_matches WHERE season_id = ${db.q(season.id)}
    AND substr(scheduled_at, 1, 10) = ${db.q(today)}
    AND status != 'canceled'
    ORDER BY scheduled_at, id;`), userId);
  const shanghaiHour = clock.shanghaiParts(now).hour;
  if (matches.length > 0 && matches.every((m) => m.status === 'settled') && shanghaiHour >= 17) {
    matches = [];
  }
  if (!matches.length) {
    const nextRow = db.get(`SELECT substr(scheduled_at, 1, 10) AS match_date FROM sports_matches
      WHERE season_id = ${db.q(season.id)} AND status != 'canceled' AND scheduled_at > ${db.q(clock.serverTimeIso(now))}
      ORDER BY scheduled_at LIMIT 1;`);
    if (nextRow) {
      matchDay = nextRow.match_date;
      matches = publicMatches(db.all(`SELECT * FROM sports_matches WHERE season_id = ${db.q(season.id)}
        AND substr(scheduled_at, 1, 10) = ${db.q(matchDay)}
        AND status != 'canceled'
        ORDER BY scheduled_at, id;`), userId);
    }
  }
  const latestResults = publicMatches(db.all(`SELECT * FROM sports_matches WHERE season_id = ${db.q(season.id)} AND status = 'settled'
    ORDER BY settled_at DESC LIMIT 12;`), userId);
  const pendingBets = userId ? getMyBets(userId, 'pending') : [];
  const nextMatch = db.get(`SELECT scheduled_at FROM sports_matches WHERE season_id = ${db.q(season.id)}
    AND status IN ('unopened', 'open') AND scheduled_at > ${db.q(clock.serverTimeIso(now))} ORDER BY scheduled_at LIMIT 1;`);
  return {
    season: publicSeason(season),
    config: publicConfig(),
    paused: !!configRow().paused,
    server_time: clock.serverTimeIso(now),
    next_match_at: nextMatch?.scheduled_at || null,
    match_day: matchDay,
    matches,
    latest_results: latestResults,
    pending_bets: pendingBets,
    standings: getStandings(season.id),
    teams: getTeams().map(publicTeam)
  };
}

function getSchedule(userId, seasonId = null) {
  const season = seasonId ? getSeason(seasonId) : (getActiveSeason() || getLatestSeason());
  if (!season) return { season: null, matches: [] };
  return {
    season: publicSeason(season),
    matches: publicMatches(db.all(`SELECT * FROM sports_matches WHERE season_id = ${db.q(season.id)} ORDER BY scheduled_at, id;`), userId)
  };
}

function getPlayoffs(userId, seasonId = null) {
  const season = seasonId ? getSeason(seasonId) : (getActiveSeason() || getLatestSeason());
  if (!season) return { season: null, series: [] };
  const standings = getStandings(season.id);
  const standingsByTeam = Object.fromEntries(standings.map((row) => [row.team_id, row]));
  const teams = Object.fromEntries(getTeams().map((team) => [
    team.id,
    publicTeamWithStanding(team, standingsByTeam[team.id])
  ]));
  const standingsByRank = Object.fromEntries(standings.map((row) => [row.rank, teams[row.team_id] || null]));
  const series = db.all(`SELECT s.*, sm.status AS market_status, sm.home_odds, sm.away_odds,
      sm.home_win_probability, sm.away_win_probability
    FROM basketball_series s
    LEFT JOIN sports_series_markets sm ON sm.series_id = s.id
    WHERE s.season_id = ${db.q(season.id)}
    ORDER BY CASE s.stage WHEN 'quarterfinal' THEN 1 WHEN 'semifinal' THEN 2 ELSE 3 END, s.bracket_slot;`).map((item) => {
    const userBets = userId ? aggregateBetRows(getRawSeriesBets(userId, null, { seriesId: item.id })) : [];
    return {
      id: item.id,
      stage: item.stage,
      bracket_slot: Number(item.bracket_slot),
      best_of: Number(item.best_of),
      home_seed: item.home_seed == null ? null : Number(item.home_seed),
      away_seed: item.away_seed == null ? null : Number(item.away_seed),
      home_team: teams[item.home_team_id] || (season.season_type === 'full' && item.stage === 'quarterfinal' ? standingsByRank[item.home_seed] : null),
      away_team: teams[item.away_team_id] || (season.season_type === 'full' && item.stage === 'quarterfinal' ? standingsByRank[item.away_seed] : null),
      home_wins: Number(item.home_wins),
      away_wins: Number(item.away_wins),
      winner_team: teams[item.winner_team_id] || null,
      status: item.status,
      preview: !item.home_team_id || !item.away_team_id,
      market: item.market_status ? {
        status: item.market_status,
        home_odds: item.home_odds == null ? null : Number(item.home_odds),
        away_odds: item.away_odds == null ? null : Number(item.away_odds),
        home_win_probability: item.home_win_probability == null ? null : Number(item.home_win_probability),
        away_win_probability: item.away_win_probability == null ? null : Number(item.away_win_probability)
      } : null,
      user_stake: userBets.filter((bet) => bet.status !== 'refunded').reduce((sum, bet) => sum + Number(bet.amount || 0), 0),
      user_bet_summaries: userBets,
      matches: publicMatches(db.all(`SELECT * FROM sports_matches WHERE series_id = ${db.q(item.id)} ORDER BY game_no;`), userId)
    };
  });
  return { season: publicSeason(season), series };
}

function getStandings(seasonId = null) {
  const season = seasonId ? getSeason(seasonId) : (getActiveSeason() || getLatestSeason());
  if (!season) return [];
  const teams = Object.fromEntries(getTeams().map((team) => [team.id, team]));
  const rows = db.all(`SELECT * FROM basketball_team_season_stats WHERE season_id = ${db.q(season.id)};`).map((row) => {
    const games = Number(row.wins) + Number(row.losses);
    const pointsFor = Number(row.points_for);
    const pointsAgainst = Number(row.points_against);
    const pointDiff = pointsFor - pointsAgainst;
    const recent = safeJson(row.recent_json, []);
    const streak = computeStreak(recent);
    return {
      ...row,
      team_id: row.team_id,
      team_name: teams[row.team_id]?.name || row.team_id,
      games,
      point_diff: pointDiff,
      win_rate: games ? Number(row.wins) / games : 0,
      points_per_game: games ? round(pointsFor / games, 1) : 0,
      points_against_per_game: games ? round(pointsAgainst / games, 1) : 0,
      point_diff_per_game: games ? round(pointDiff / games, 1) : 0,
      strength: round(teamBaseStrength(row.team_id), 2),
      stars: teamStrengthStars(teamBaseStrength(row.team_id)),
      recent,
      streak
    };
  });
  const headToHeadMatrix = computeHeadToHeadMatrix(season.id, rows.map((r) => r.team_id));
  rows.sort((a, b) => {
    if (Number(b.wins) !== Number(a.wins)) return Number(b.wins) - Number(a.wins);
    const aWinsVsB = headToHeadMatrix[a.team_id]?.[b.team_id] || 0;
    const bWinsVsA = headToHeadMatrix[b.team_id]?.[a.team_id] || 0;
    const head = aWinsVsB - bWinsVsA;
    if (head !== 0) return -head;
    if (b.point_diff !== a.point_diff) return b.point_diff - a.point_diff;
    if (Number(b.points_for) !== Number(a.points_for)) return Number(b.points_for) - Number(a.points_for);
    return Number(b.tie_breaker) - Number(a.tie_breaker);
  });
  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}

function computeHeadToHeadMatrix(seasonId, teamIds) {
  if (!teamIds.length) return {};
  const teamSet = new Set(teamIds);
  const rows = db.all(`SELECT home_team_id, away_team_id, winner_team_id FROM sports_matches
    WHERE season_id = ${db.q(seasonId)} AND stage = 'regular' AND status = 'settled'
      AND winner_team_id IS NOT NULL
      AND home_team_id IN (${teamIds.map(db.q).join(',')})
      AND away_team_id IN (${teamIds.map(db.q).join(',')});`);
  const matrix = {};
  for (const id of teamIds) matrix[id] = {};
  for (const row of rows) {
    if (!teamSet.has(row.home_team_id) || !teamSet.has(row.away_team_id)) continue;
    const winner = row.winner_team_id;
    const loser = winner === row.home_team_id ? row.away_team_id : row.home_team_id;
    if (!matrix[winner]) matrix[winner] = {};
    if (!matrix[winner][loser]) matrix[winner][loser] = 0;
    matrix[winner][loser] += 1;
  }
  return matrix;
}

function headToHead(seasonId, a, b) {
  const rows = db.all(`SELECT winner_team_id FROM sports_matches WHERE season_id = ${db.q(seasonId)} AND stage = 'regular'
    AND status = 'settled' AND ((home_team_id = ${db.q(a)} AND away_team_id = ${db.q(b)})
      OR (home_team_id = ${db.q(b)} AND away_team_id = ${db.q(a)}));`);
  const aw = rows.filter((row) => row.winner_team_id === a).length;
  const bw = rows.filter((row) => row.winner_team_id === b).length;
  return aw - bw;
}

function getTeamDetail(teamId) {
  const team = db.get(`SELECT * FROM basketball_teams WHERE id = ${db.q(teamId)};`);
  if (!team) throw new Error('球队不存在');
  const season = getActiveSeason() || getLatestSeason();
  return {
    ...publicTeam(team),
    strength: round(teamBaseStrength(team.id), 2),
    standing: season ? getStandings(season.id).find((row) => row.team_id === team.id) || null : null,
    matches: season ? publicMatches(db.all(`SELECT * FROM sports_matches WHERE season_id = ${db.q(season.id)}
      AND (home_team_id = ${db.q(team.id)} OR away_team_id = ${db.q(team.id)}) ORDER BY scheduled_at;`)) : []
  };
}

function getRawMyBets(userId, status = null, options = {}) {
  const conditions = [`b.user_id = ${db.q(userId)}`];
  if (status) conditions.push(`b.status = ${db.q(status)}`);
  if (options.since) {
    if (options.excludePendingFromSince) {
      conditions.push(`(b.created_at >= ${db.q(options.since)} OR b.status = 'pending')`);
    } else {
      conditions.push(`b.created_at >= ${db.q(options.since)}`);
    }
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.all(`SELECT b.*, 'match' AS market_type, m.series_id, m.scheduled_at, m.stage, m.status AS match_status,
      m.home_team_id, m.away_team_id,
      ht.name AS home_team_name, at.name AS away_team_name, st.name AS selection_team_name
    FROM sports_bets b JOIN sports_matches m ON m.id = b.match_id
    LEFT JOIN basketball_teams ht ON ht.id = m.home_team_id
    LEFT JOIN basketball_teams at ON at.id = m.away_team_id
    LEFT JOIN basketball_teams st ON st.id = b.selection_team_id
    ${whereClause} ORDER BY b.created_at DESC;`).map((bet) => ({
      ...bet,
      amount: Number(bet.amount),
      locked_odds: Number(bet.locked_odds),
      payout: Number(bet.payout)
  }));
}

function getRawSeriesBets(userId, status = null, options = {}) {
  const conditions = [`b.user_id = ${db.q(userId)}`];
  if (status) conditions.push(`b.status = ${db.q(status)}`);
  if (options.seriesId) conditions.push(`b.series_id = ${db.q(options.seriesId)}`);
  if (options.since) {
    if (options.excludePendingFromSince) conditions.push(`(b.created_at >= ${db.q(options.since)} OR b.status = 'pending')`);
    else conditions.push(`b.created_at >= ${db.q(options.since)}`);
  }
  return db.all(`SELECT b.*, 'series' AS market_type, NULL AS match_id, g1.scheduled_at, s.stage,
      s.status AS match_status, s.home_team_id, s.away_team_id,
      ht.name AS home_team_name, at.name AS away_team_name, st.name AS selection_team_name
    FROM sports_series_bets b
    JOIN basketball_series s ON s.id = b.series_id
    LEFT JOIN sports_matches g1 ON g1.series_id = s.id AND g1.game_no = 1
    LEFT JOIN basketball_teams ht ON ht.id = s.home_team_id
    LEFT JOIN basketball_teams at ON at.id = s.away_team_id
    LEFT JOIN basketball_teams st ON st.id = b.selection_team_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY b.created_at DESC;`).map((bet) => ({
      ...bet,
      amount: Number(bet.amount),
      locked_odds: Number(bet.locked_odds),
      payout: Number(bet.payout)
    }));
}

function getMyBets(userId, status = null, options = {}) {
  return aggregateBetRows([
    ...getRawMyBets(userId, status, options),
    ...getRawSeriesBets(userId, status, options)
  ]);
}

function aggregateBetRows(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const targetId = row.market_type === 'series' ? row.series_id : row.match_id;
    const key = `${row.market_type || 'match'}:${targetId}:${row.selection_team_id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        ...row,
        amount: 0,
        payout: 0,
        pnl: 0,
        bet_count: 0,
        statuses: new Set()
      });
    }
    const group = groups.get(key);
    group.amount += Number(row.amount || 0);
    group.payout += Number(row.payout || 0);
    group.bet_count += 1;
    group.statuses.add(row.status);
    if (String(row.created_at || '') > String(group.created_at || '')) group.created_at = row.created_at;
  }
  return Array.from(groups.values()).map((group) => {
    const statuses = group.statuses;
    const status = statuses.has('pending') ? 'pending'
      : statuses.has('open') ? 'open'
        : statuses.has('won') ? 'won'
          : statuses.has('lost') ? 'lost' : 'refunded';
    const amount = round(group.amount, 2);
    const payout = round(group.payout, 2);
    const pnl = status === 'won' ? round(payout - amount, 2) : status === 'lost' ? -amount : 0;
    delete group.statuses;
    return { ...group, status, amount, payout, pnl };
  }).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

function getAccountSummary(userId) {
  const season = getActiveSeason() || getLatestSeason();
  const pendingMatches = Number(db.get(`SELECT COALESCE(SUM(amount), 0) AS total FROM sports_bets
    WHERE user_id = ${db.q(userId)} AND status = 'pending';`)?.total || 0);
  const pendingSeries = Number(db.get(`SELECT COALESCE(SUM(amount), 0) AS total FROM sports_series_bets
    WHERE user_id = ${db.q(userId)} AND status = 'pending';`)?.total || 0);
  let pnl = 0;
  if (season) {
    const matchRow = db.get(`SELECT COALESCE(SUM(CASE WHEN status = 'won' THEN payout - amount WHEN status = 'lost' THEN -amount ELSE 0 END), 0) AS pnl
      FROM sports_bets WHERE user_id = ${db.q(userId)} AND match_id IN (SELECT id FROM sports_matches WHERE season_id = ${db.q(season.id)});`);
    const seriesRow = db.get(`SELECT COALESCE(SUM(CASE WHEN status = 'won' THEN payout - amount WHEN status = 'lost' THEN -amount ELSE 0 END), 0) AS pnl
      FROM sports_series_bets WHERE user_id = ${db.q(userId)}
        AND series_id IN (SELECT id FROM basketball_series WHERE season_id = ${db.q(season.id)});`);
    pnl = Number(matchRow?.pnl || 0) + Number(seriesRow?.pnl || 0);
  }
  const todayCutoff = clock.shanghaiDaysAgoIso(0);
  return {
    pending_stake: round(pendingMatches + pendingSeries, 2),
    season_pnl: round(pnl, 2),
    recent_bets: getMyBets(userId, null, { since: todayCutoff, excludePendingFromSince: true }).slice(0, 30)
  };
}

function getRecentActivity(userId, now = clock.now()) {
  const season = ensureSports(now);
  const today = clock.shanghaiParts(now).date;
  let matchDay = today;
  const todayMatches = db.all(`SELECT id FROM sports_matches WHERE season_id = ${db.q(season.id)}
    AND substr(scheduled_at, 1, 10) = ${db.q(today)} AND status != 'canceled' LIMIT 1;`);
  if (!todayMatches.length) {
    const nextRow = db.get(`SELECT substr(scheduled_at, 1, 10) AS match_date FROM sports_matches
      WHERE season_id = ${db.q(season.id)} AND status != 'canceled' AND scheduled_at > ${db.q(clock.serverTimeIso(now))}
      ORDER BY scheduled_at LIMIT 1;`);
    if (nextRow) matchDay = nextRow.match_date;
  }
  const bets = db.all(`SELECT b.amount, b.status, b.payout, b.created_at,
      u.nickname, m.scheduled_at, m.home_team_id, m.away_team_id,
      ht.name AS home_team_name, at.name AS away_team_name, st.name AS selection_team_name
    FROM sports_bets b
    JOIN sports_matches m ON m.id = b.match_id
    JOIN users u ON u.id = b.user_id
    LEFT JOIN basketball_teams ht ON ht.id = m.home_team_id
    LEFT JOIN basketball_teams at ON at.id = m.away_team_id
    LEFT JOIN basketball_teams st ON st.id = b.selection_team_id
    WHERE b.user_id != ${db.q(userId)} AND b.status != 'refunded'
      AND substr(m.scheduled_at, 1, 10) = ${db.q(matchDay)} AND m.status != 'canceled'
    ORDER BY b.created_at DESC, b.id DESC LIMIT 80;`).map((bet) => {
      let pnl = 0;
      if (bet.status === 'won') pnl = round(Number(bet.payout) - Number(bet.amount), 2);
      else if (bet.status === 'lost') pnl = -Number(bet.amount);
      return {
        nickname: bet.nickname,
        selection_team_name: bet.selection_team_name,
        home_team_name: bet.home_team_name,
        away_team_name: bet.away_team_name,
        scheduled_at: bet.scheduled_at,
        amount: Number(bet.amount),
        status: bet.status,
        pnl
      };
    });
  return { match_day: matchDay, bets };
}

function getAdminOverview() {
  const season = getActiveSeason() || getLatestSeason();
  const matchMoney = db.get(`SELECT
    COALESCE(SUM(amount), 0) AS total_staked,
    COALESCE(SUM(CASE WHEN status = 'won' THEN payout ELSE 0 END), 0) AS total_paid,
    COALESCE(SUM(CASE WHEN status = 'refunded' THEN payout ELSE 0 END), 0) AS total_refunded
    FROM sports_bets;`) || {};
  const seriesMoney = db.get(`SELECT
    COALESCE(SUM(amount), 0) AS total_staked,
    COALESCE(SUM(CASE WHEN status = 'won' THEN payout ELSE 0 END), 0) AS total_paid,
    COALESCE(SUM(CASE WHEN status = 'refunded' THEN payout ELSE 0 END), 0) AS total_refunded
    FROM sports_series_bets;`) || {};
  return {
    season: season ? publicSeason(season) : null,
    config: publicConfig(),
    paused: !!configRow().paused,
    totals: {
      staked: Number(matchMoney.total_staked || 0) + Number(seriesMoney.total_staked || 0),
      paid: Number(matchMoney.total_paid || 0) + Number(seriesMoney.total_paid || 0),
      refunded: Number(matchMoney.total_refunded || 0) + Number(seriesMoney.total_refunded || 0)
    },
    matches: season ? publicMatches(
      db.all(`SELECT * FROM sports_matches WHERE season_id = ${db.q(season.id)} ORDER BY scheduled_at DESC, id;`),
      null,
      { includeAudit: true }
    ) : [],
    series: season ? getPlayoffs(null, season.id).series : [],
    recent_cash_events: db.all(`SELECT e.*, u.nickname FROM sports_cash_events e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.created_at DESC LIMIT 50;`),
    moves: db.all(`SELECT pm.*, p.name AS player_name, ft.name AS from_team_name, tt.name AS to_team_name
      FROM basketball_player_moves pm
      JOIN basketball_players p ON p.id = pm.player_id
      JOIN basketball_teams ft ON ft.id = pm.from_team_id
      JOIN basketball_teams tt ON tt.id = pm.to_team_id
      ORDER BY pm.created_at DESC LIMIT 50;`),
    developments: db.all(`SELECT d.*, p.name AS player_name, t.name AS team_name
      FROM basketball_player_developments d
      JOIN basketball_players p ON p.id = d.player_id
      JOIN basketball_teams t ON t.id = d.team_id
      ORDER BY d.created_at DESC LIMIT 50;`)
  };
}

function getAudit() {
  return {
    pending_bets: db.all(`SELECT b.*, u.nickname, m.scheduled_at
      FROM sports_bets b
      JOIN users u ON u.id = b.user_id
      JOIN sports_matches m ON m.id = b.match_id
      WHERE b.status = 'pending'
      ORDER BY b.created_at DESC LIMIT 100;`),
    pending_series_bets: db.all(`SELECT b.*, u.nickname, s.stage, s.bracket_slot
      FROM sports_series_bets b
      JOIN users u ON u.id = b.user_id
      JOIN basketball_series s ON s.id = b.series_id
      WHERE b.status = 'pending'
      ORDER BY b.created_at DESC LIMIT 100;`),
    cash_events: db.all(`SELECT e.*, u.nickname
      FROM sports_cash_events e LEFT JOIN users u ON u.id = e.user_id
      ORDER BY e.created_at DESC LIMIT 100;`),
    player_moves: db.all(`SELECT pm.*, p.name AS player_name, ft.name AS from_team_name, tt.name AS to_team_name
      FROM basketball_player_moves pm
      JOIN basketball_players p ON p.id = pm.player_id
      JOIN basketball_teams ft ON ft.id = pm.from_team_id
      JOIN basketball_teams tt ON tt.id = pm.to_team_id
      ORDER BY pm.created_at DESC LIMIT 100;`),
    trade_events: db.all(`SELECT * FROM basketball_trade_events ORDER BY created_at DESC LIMIT 100;`),
    player_developments: db.all(`SELECT d.*, p.name AS player_name, t.name AS team_name
      FROM basketball_player_developments d
      JOIN basketball_players p ON p.id = d.player_id
      JOIN basketball_teams t ON t.id = d.team_id
      ORDER BY d.created_at DESC LIMIT 100;`)
  };
}

function setPaused(paused) {
  db.exec(`UPDATE sports_config SET paused = ${paused ? 1 : 0}, updated_at = datetime('now') WHERE id = 1;`);
  return { paused: !!paused };
}

function updateNextConfig(body) {
  const current = currentConfig();
  const next = {
    house_edge: validateNumber(body.house_edge, 0, 0.2, current.house_edge, '系统优势'),
    min_bet: validateNumber(body.min_bet, 1, 100000, current.min_bet, '单笔最低竞猜'),
    max_bet_per_match: validateNumber(body.max_bet_per_match, 1000, 1000000, current.max_bet_per_match, '单场累计上限'),
    home_advantage: validateNumber(body.home_advantage, 0, 0.1, current.home_advantage, '主场优势'),
    regular_form_cap: validateNumber(body.regular_form_cap, 0, 0.25, current.regular_form_cap, '常规赛状态上限'),
    form_cap: validateNumber(body.form_cap, 0, 0.25, current.form_cap, '季后赛状态上限'),
    regular_win_cap: validateNumber(body.regular_win_cap, 0.5, 0.95, current.regular_win_cap, '常规赛胜率上限'),
    playoff_win_cap: validateNumber(body.playoff_win_cap, 0.5, 0.98, current.playoff_win_cap, '季后赛胜率上限'),
    regular_scale_factor: validateNumber(body.regular_scale_factor, 0.05, 0.30, current.regular_scale_factor, '常规赛实力敏感度'),
    scale_factor: validateNumber(body.scale_factor, 0.05, 0.30, current.scale_factor, '季后赛实力敏感度')
  };
  if (next.max_bet_per_match < next.min_bet) throw new Error('单场累计上限不得低于单笔最低竞猜');
  db.exec(`UPDATE sports_config SET next_config_json = ${db.q(JSON.stringify(next))}, updated_at = datetime('now') WHERE id = 1;`);
  return { current: publicConfig(), next };
}

function resetSports(now = clock.now()) {
  refundAllPending('市场重置');
  [
    'sports_cash_events', 'sports_series_bets', 'sports_series_markets', 'sports_bets', 'sports_markets', 'sports_matches',
    'basketball_series', 'basketball_team_season_stats', 'basketball_player_developments',
    'basketball_player_moves', 'basketball_trade_events', 'sports_seasons',
    'basketball_players', 'basketball_teams', 'sports_competitions', 'sports_config'
  ].forEach((table) => db.exec(`DELETE FROM ${table};`));
  seedCatalog();
  return createSeason(now);
}

function resetPlayer(userId, options = {}) {
  if (options.refund !== false) {
    const pending = db.all(`SELECT * FROM sports_bets WHERE user_id = ${db.q(userId)} AND status = 'pending';`);
    const pendingSeries = db.all(`SELECT * FROM sports_series_bets WHERE user_id = ${db.q(userId)} AND status = 'pending';`);
    pending.forEach((bet) => {
      db.exec(`UPDATE users SET cash = ROUND(cash + ${Number(bet.amount)}, 2) WHERE id = ${db.q(userId)};`);
    });
    pendingSeries.forEach((bet) => {
      db.exec(`UPDATE users SET cash = ROUND(cash + ${Number(bet.amount)}, 2) WHERE id = ${db.q(userId)};`);
    });
  }
  db.exec(`DELETE FROM sports_cash_events WHERE user_id = ${db.q(userId)};`);
  db.exec(`DELETE FROM sports_bets WHERE user_id = ${db.q(userId)};`);
  db.exec(`DELETE FROM sports_series_bets WHERE user_id = ${db.q(userId)};`);
}

function refundAllPending(reason) {
  const bets = db.all(`SELECT * FROM sports_bets WHERE status = 'pending';`);
  bets.forEach((bet) => {
    db.exec(`UPDATE users SET cash = ROUND(cash + ${Number(bet.amount)}, 2), updated_at = datetime('now') WHERE id = ${db.q(bet.user_id)};`);
    db.exec(`UPDATE sports_bets SET status = 'refunded', payout = ${Number(bet.amount)}, settled_at = datetime('now') WHERE id = ${db.q(bet.id)};`);
    cashEvent(bet.user_id, bet.id, bet.match_id, 'refund', Number(bet.amount), { reason });
  });
  const seriesBets = db.all(`SELECT * FROM sports_series_bets WHERE status = 'pending';`);
  seriesBets.forEach((bet) => {
    db.exec(`UPDATE users SET cash = ROUND(cash + ${Number(bet.amount)}, 2), updated_at = datetime('now') WHERE id = ${db.q(bet.user_id)};`);
    db.exec(`UPDATE sports_series_bets SET status = 'refunded', payout = ${Number(bet.amount)}, settled_at = datetime('now')
      WHERE id = ${db.q(bet.id)};`);
    cashEvent(bet.user_id, bet.id, null, 'refund', Number(bet.amount), { reason, market_type: 'series' }, bet.series_id);
  });
}

function cashEvent(userId, betId, matchId, eventType, amount, detail, seriesId = null) {
  const cash = Number(db.get(`SELECT cash FROM users WHERE id = ${db.q(userId)};`)?.cash || 0);
  db.exec(`INSERT INTO sports_cash_events (id, user_id, bet_id, match_id, series_id, event_type, amount, balance_after, detail, created_at)
    VALUES (${db.q(crypto.randomUUID())}, ${db.q(userId)}, ${betId ? db.q(betId) : 'NULL'}, ${matchId ? db.q(matchId) : 'NULL'},
      ${seriesId ? db.q(seriesId) : 'NULL'}, ${db.q(eventType)}, ${round(amount, 2)}, ${round(cash, 2)},
      ${detail ? db.q(JSON.stringify(detail)) : 'NULL'}, datetime('now'));`);
}

function publicMatches(rows, userId = null, options = {}) {
  const rawTeams = Object.fromEntries(getTeams().map((team) => [team.id, team]));
  const standingsBySeason = new Map();
  for (const seasonId of new Set(rows.map((match) => match.season_id).filter(Boolean))) {
    standingsBySeason.set(seasonId, Object.fromEntries(getStandings(seasonId).map((row) => [row.team_id, row])));
  }
  const teamForMatch = (teamId, seasonId) => {
    const team = rawTeams[teamId];
    return team ? publicTeamWithStanding(team, standingsBySeason.get(seasonId)?.[teamId]) : null;
  };
  const matchIds = rows.map((m) => m.id);
  const marketsById = new Map();
  if (matchIds.length) {
    const marketRows = db.all(`SELECT match_id, status, home_odds, away_odds, opened_at, locked_at
      FROM sports_markets WHERE match_id IN (${matchIds.map(db.q).join(',')});`);
    for (const row of marketRows) marketsById.set(row.match_id, row);
  }
  const betSummariesById = new Map();
  if (userId && matchIds.length) {
    const betRows = db.all(`SELECT * FROM sports_bets WHERE user_id = ${db.q(userId)}
      AND match_id IN (${matchIds.map(db.q).join(',')}) ORDER BY created_at DESC;`);
    for (const summary of aggregateBetRows(betRows)) {
      summary.selection_team_name = rawTeams[summary.selection_team_id]?.name || summary.selection_team_id;
      if (!betSummariesById.has(summary.match_id)) betSummariesById.set(summary.match_id, []);
      betSummariesById.get(summary.match_id).push(summary);
    }
  }
  const includeAudit = !!options.includeAudit;
  return rows.map((match) => {
    const market = marketsById.get(match.id);
    return {
      id: match.id,
      season_id: match.season_id,
      stage: match.stage,
      round_no: Number(match.round_no),
      series_id: match.series_id,
      game_no: match.game_no == null ? null : Number(match.game_no),
      scheduled_at: match.scheduled_at,
      status: match.status,
      home_team: teamForMatch(match.home_team_id, match.season_id),
      away_team: teamForMatch(match.away_team_id, match.season_id),
      home_score: match.home_score,
      away_score: match.away_score,
      winner_team_id: match.winner_team_id,
      home_win_probability: match.home_win_probability == null ? null : Number(match.home_win_probability),
      market: market ? {
        status: market.status,
        home_odds: market.home_odds == null ? null : Number(market.home_odds),
        away_odds: market.away_odds == null ? null : Number(market.away_odds)
      } : null,
      user_stake: userId ? (betSummariesById.get(match.id) || [])
        .filter((item) => item.status !== 'refunded')
        .reduce((sum, item) => sum + Number(item.amount || 0), 0) : 0,
      user_bet_summaries: userId ? (betSummariesById.get(match.id) || []) : [],
      cancel_reason: match.cancel_reason,
      ...(includeAudit ? {
        home_strength: match.home_strength == null ? null : Number(match.home_strength),
        away_strength: match.away_strength == null ? null : Number(match.away_strength),
        home_win_probability: match.home_win_probability == null ? null : Number(match.home_win_probability),
        away_win_probability: match.away_win_probability == null ? null : Number(match.away_win_probability),
        market_opened_at: market?.opened_at || null,
        market_locked_at: market?.locked_at || null
      } : {})
    };
  });
}

function publicSeason(season) {
  return {
    id: season.id,
    season_no: Number(season.season_no),
    season_type: season.season_type,
    status: season.status,
    week_monday: season.week_monday,
    starts_at: season.starts_at,
    ends_at: season.ends_at,
    champion_team_id: season.champion_team_id,
    void_reason: season.void_reason
  };
}

function publicConfig() {
  const row = configRow();
  const config = {
    house_edge: Number(row.house_edge),
    min_bet: Number(row.min_bet),
    max_bet_per_match: Number(row.max_bet_per_match),
    max_bet_per_series: MAX_BET_PER_SERIES,
    home_advantage: Number(row.home_advantage),
    regular_form_cap: Number(row.regular_form_cap),
    form_cap: Number(row.form_cap),
    regular_win_cap: Number(row.regular_win_cap),
    playoff_win_cap: Number(row.playoff_win_cap),
    regular_scale_factor: Number(row.regular_scale_factor),
    scale_factor: Number(row.scale_factor)
  };
  const savedNext = safeJson(row.next_config_json, null);
  return { ...config, next: savedNext ? { ...config, ...savedNext } : null };
}

function publicTeam(team) {
  return {
    id: team.id,
    code: team.code,
    name: team.name,
    city: team.city,
    championships: Number(team.championships || 0)
  };
}

function publicTeamWithStanding(team, standing) {
  return {
    ...publicTeam(team),
    stars: standing?.stars == null ? null : Number(standing.stars),
    wins: Number(standing?.wins || 0),
    losses: Number(standing?.losses || 0),
    recent: Array.isArray(standing?.recent) ? standing.recent : [],
    streak: standing?.streak || { type: null, count: 0 }
  };
}

function getTeams() {
  return db.all('SELECT * FROM basketball_teams ORDER BY code;');
}

function getSeason(id) {
  return db.get(`SELECT * FROM sports_seasons WHERE id = ${db.q(id)};`);
}

function getActiveSeason() {
  return db.get(`SELECT * FROM sports_seasons WHERE status IN (${ACTIVE_SEASON_STATUSES.map(db.q).join(',')}) ORDER BY season_no DESC LIMIT 1;`);
}

function getLatestSeason() {
  return db.get('SELECT * FROM sports_seasons ORDER BY season_no DESC LIMIT 1;');
}

function getMatch(id) {
  return db.get(`SELECT * FROM sports_matches WHERE id = ${db.q(id)};`);
}

function getBet(id) {
  return db.get(`SELECT * FROM sports_bets WHERE id = ${db.q(id)};`);
}

function getSeriesBet(id) {
  return db.get(`SELECT * FROM sports_series_bets WHERE id = ${db.q(id)};`);
}

function configRow() {
  seedCatalog();
  return db.get('SELECT * FROM sports_config WHERE id = 1;');
}

function currentConfig() {
  const row = configRow();
  return {
    house_edge: Number(row.house_edge),
    min_bet: Number(row.min_bet),
    max_bet_per_match: Number(row.max_bet_per_match),
    home_advantage: Number(row.home_advantage),
    regular_form_cap: Number(row.regular_form_cap),
    form_cap: Number(row.form_cap),
    regular_win_cap: Number(row.regular_win_cap),
    playoff_win_cap: Number(row.playoff_win_cap),
    regular_scale_factor: Number(row.regular_scale_factor),
    scale_factor: Number(row.scale_factor)
  };
}

function applyNextConfig() {
  const row = configRow();
  const saved = safeJson(row.next_config_json, null);
  if (!saved) return;
  const next = { ...currentConfig(), ...saved };
  db.exec(`UPDATE sports_config SET house_edge = ${Number(next.house_edge)}, min_bet = ${Number(next.min_bet)},
    max_bet_per_match = ${Number(next.max_bet_per_match)}, home_advantage = ${Number(next.home_advantage)},
    regular_form_cap = ${Number(next.regular_form_cap)}, form_cap = ${Number(next.form_cap)},
    regular_win_cap = ${Number(next.regular_win_cap)}, playoff_win_cap = ${Number(next.playoff_win_cap)},
    regular_scale_factor = ${Number(next.regular_scale_factor)}, scale_factor = ${Number(next.scale_factor)},
    next_config_json = NULL, updated_at = datetime('now') WHERE id = 1;`);
}

function setSeasonStatus(seasonId, status) {
  db.exec(`UPDATE sports_seasons SET status = ${db.q(status)}, updated_at = datetime('now') WHERE id = ${db.q(seasonId)};`);
}

function mondayOf(dateString) {
  const dow = dayOfWeek(dateString);
  return clock.addDays(dateString, dow === 0 ? -6 : 1 - dow);
}

function dayOfWeek(dateString) {
  return new Date(`${dateString}T12:00:00+08:00`).getUTCDay();
}

function timeParts(index) {
  return { hour: MATCH_TIMES[index][0], minute: MATCH_TIMES[index][1] };
}

function decimalOdds(probability, edge) {
  return Math.max(1.01, Math.round(((1 - edge) / probability) * 100) / 100);
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function randomInt(min, max, random = Math.random) {
  return min + Math.floor(random() * (max - min + 1));
}

function shuffle(values, random = Math.random) {
  const result = values.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i, random);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function starsForAbility(ability) {
  const value = Number(ability);
  if (value >= 90) return 5;
  if (value >= 75) return 4;
  if (value >= 55) return 3;
  if (value >= 35) return 2;
  return 1;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function safeJson(value, fallback) {
  try {
    return value == null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function validateNumber(value, min, max, fallback, label) {
  const number = value === undefined || value === null || value === '' ? Number(fallback) : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${label}参数无效`);
  return number;
}

function moneyText(value) {
  return Number(value).toLocaleString('zh-CN');
}

function getBettingRanking() {
  const today = clock.shanghaiParts().date;
  const todayStart = today + ' 00:00:00';
  const season = getActiveSeason() || getLatestSeason();
  const seasonFilter = season ? `WHERE season_id = ${db.q(season.id)}` : '';
  const rows = db.all(`SELECT * FROM (
      SELECT b.user_id, b.status, b.amount, b.payout, b.settled_at, m.season_id
      FROM sports_bets b JOIN sports_matches m ON m.id = b.match_id
      UNION ALL
      SELECT b.user_id, b.status, b.amount, b.payout, b.settled_at, s.season_id
      FROM sports_series_bets b JOIN basketball_series s ON s.id = b.series_id
    ) ${seasonFilter};`);
  const users = Object.fromEntries(db.all('SELECT id, nickname, is_admin FROM users;').map((user) => [user.id, user]));
  const groups = new Map();
  for (const row of rows) {
    const user = users[row.user_id];
    if (!user || user.is_admin) continue;
    if (!groups.has(row.user_id)) {
      groups.set(row.user_id, { user_id: row.user_id, nickname: user.nickname, total_pnl: 0, today_pnl: 0, settled_count: 0, won_count: 0 });
    }
    const group = groups.get(row.user_id);
    if (['won', 'lost', 'refunded'].includes(row.status)) {
      const pnl = round(Number(row.payout) - Number(row.amount), 2);
      group.total_pnl += pnl;
      if (String(row.settled_at || '') >= todayStart) group.today_pnl += pnl;
    }
    if (['won', 'lost'].includes(row.status)) group.settled_count += 1;
    if (row.status === 'won') group.won_count += 1;
  }
  return Array.from(groups.values()).map((row) => ({
    user_id: row.user_id,
    nickname: row.nickname,
    total_pnl: round(row.total_pnl, 2),
    today_pnl: round(row.today_pnl, 2),
    hit_rate: row.settled_count > 0 ? Number((row.won_count / row.settled_count * 100).toFixed(1)) : 0
  }));
}

module.exports = {
  DEFAULT_CONFIG,
  MAX_BET_PER_SERIES,
  ensureSports,
  processClock,
  placeBet,
  placeSeriesBet,
  cancelMatch,
  advanceStage,
  getOverview,
  getSchedule,
  getPlayoffs,
  getStandings,
  getTeamDetail,
  getMyBets,
  getAccountSummary,
  getRecentActivity,
  getBettingRanking,
  getAdminOverview,
  getAudit,
  setPaused,
  updateNextConfig,
  resetSports,
  resetPlayer,
  currentConfig,
  _test: {
    createSeason,
    roundRobinRounds,
    regularRoundSlot,
    settleMatch,
    voidSeason,
    movePlayers,
    generateRegularTradePlan,
    executeDueRegularTrades,
    applyDraftDevelopment,
    getActiveSeason,
    getLatestSeason,
    openEligibleMarkets,
    openEligibleSeriesMarkets,
    openSeriesMarket,
    lockSeriesMarket,
    settleSeriesBets,
    refundSeriesBets,
    computeStreak,
    probabilitySnapshot,
    teamFormAdjustment,
    teamStrengthStars,
    refreshAffectedOpenMarkets
  }
};

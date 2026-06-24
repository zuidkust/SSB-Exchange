const assert = require('node:assert/strict');

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function randomInt(min, max, random) {
  return min + Math.floor(random() * (max - min + 1));
}

function shuffle(values, random) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function mulberry32(seed) {
  return function random() {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

const TEAM_IDS = Array.from({ length: 16 }, (_, index) => `team-${index + 1}`);
const STAR_BUCKETS = [
  [5, 10, 90, 99],
  [4, 30, 75, 89],
  [3, 60, 55, 74],
  [2, 40, 35, 54],
  [1, 20, 15, 34]
];

function createTeams(random) {
  const ratings = [];
  for (const [star, count, min, max] of STAR_BUCKETS) {
    for (let index = 0; index < count; index += 1) {
      ratings.push({ star, ability: min + ((index * 7 + star * 3) % (max - min + 1)) });
    }
  }
  const players = shuffle(ratings.map((rating, index) => ({
    id: `player-${index + 1}`,
    stars: rating.star,
    ability: rating.ability,
    team_id: null,
    starter: false
  })), random);
  const teams = {};
  TEAM_IDS.forEach((teamId, index) => {
    const roster = players.slice(index * 10, index * 10 + 10);
    roster.forEach((player) => { player.team_id = teamId; });
    teams[teamId] = { id: teamId, roster };
  });
  refreshStarters(teams);
  return teams;
}

function refreshStarters(teams) {
  for (const team of Object.values(teams)) {
    team.roster.forEach((player) => { player.starter = false; });
    team.roster.sort((a, b) => b.ability - a.ability || a.id.localeCompare(b.id))
      .slice(0, 5)
      .forEach((player) => { player.starter = true; });
  }
}

function teamStrength(team) {
  const starters = team.roster.filter((player) => player.starter).map((player) => player.ability);
  const bench = team.roster.filter((player) => !player.starter).map((player) => player.ability);
  return average(starters) * 0.85 + average(bench) * 0.15;
}

function teamStars(team) {
  const strength = teamStrength(team);
  if (strength >= 80) return 5;
  if (strength >= 76) return 4;
  if (strength >= 72) return 3;
  if (strength >= 68) return 2;
  return 1;
}

function formAdjustment(teamId, recentGames, cap) {
  const recent = recentGames[teamId] || [];
  if (!recent.length) return 0;
  const differential = average(recent.map((game) => game.scoreFor - game.scoreAgainst));
  return clamp(differential / 60, -cap, cap);
}

function matchProbability(home, away, recentGames, playoff) {
  const formCap = playoff ? 0.15 : 0.03;
  const scaleFactor = playoff ? 0.15 : 0.07;
  const cap = playoff ? 0.85 : 0.80;
  const homeStrength = teamStrength(home) * (1 + formAdjustment(home.id, recentGames, formCap));
  const awayStrength = teamStrength(away) * (1 + formAdjustment(away.id, recentGames, formCap));
  const scale = Math.max(8, (homeStrength + awayStrength) * scaleFactor);
  const raw = 0.5 + (homeStrength - awayStrength) / scale * (cap - 0.5) + 0.05;
  return clamp(raw, 1 - cap, cap);
}

function simulateScore(homeProbability, random) {
  const homeWins = random() < homeProbability;
  const expectedMargin = (homeProbability - 0.5) * 93;
  const margin = Math.max(1, Math.round(Math.abs(expectedMargin) + random() * 8));
  const total = 205 + Math.floor(random() * 56);
  let homeScore = Math.round((total + (homeWins ? margin : -margin)) / 2);
  let awayScore = total - homeScore;
  if (homeScore === awayScore) homeWins ? homeScore += 1 : awayScore += 1;
  return { homeWins, homeScore, awayScore };
}

function schedule() {
  const matches = [];
  for (let leg = 0; leg < 2; leg += 1) {
    const rotating = [...TEAM_IDS];
    for (let round = 0; round < TEAM_IDS.length - 1; round += 1) {
      for (let index = 0; index < TEAM_IDS.length / 2; index += 1) {
        let home = rotating[index];
        let away = rotating[TEAM_IDS.length - 1 - index];
        if ((round + index) % 2) [home, away] = [away, home];
        if (leg === 1) [home, away] = [away, home];
        matches.push({ home, away });
      }
      rotating.splice(1, 0, rotating.pop());
    }
  }
  const slotCount = 11 * 4;
  const minPerSlot = Math.floor(matches.length / slotCount);
  const largerSlots = matches.length % slotCount;
  const slots = Array.from({ length: slotCount }, (_, index) => ({
    limit: index < largerSlots ? minPerSlot + 1 : minPerSlot,
    teams: new Set(),
    matches: []
  }));
  slots.forEach((slot) => {
    for (const match of matches) {
      if (match.assigned || slot.matches.length >= slot.limit) continue;
      if (slot.teams.has(match.home) || slot.teams.has(match.away)) continue;
      match.assigned = true;
      slot.matches.push(match);
      slot.teams.add(match.home);
      slot.teams.add(match.away);
    }
  });
  return slots.flatMap((slot) => slot.matches).map(({ home, away }) => ({ home, away }));
}

function standings(results) {
  const rows = TEAM_IDS.map((teamId) => {
    const games = results.filter((game) => game.home === teamId || game.away === teamId);
    const wins = games.filter((game) => (
      (game.home === teamId && game.homeWins) || (game.away === teamId && !game.homeWins)
    )).length;
    const pointsFor = games.reduce((sum, game) => sum + (game.home === teamId ? game.homeScore : game.awayScore), 0);
    const pointsAgainst = games.reduce((sum, game) => sum + (game.home === teamId ? game.awayScore : game.homeScore), 0);
    return { team_id: teamId, wins, pointDiff: pointsFor - pointsAgainst, pointsFor };
  });
  const headToHead = Object.fromEntries(TEAM_IDS.map((teamId) => [teamId, {}]));
  results.forEach((game) => {
    const winner = game.homeWins ? game.home : game.away;
    const loser = game.homeWins ? game.away : game.home;
    headToHead[winner][loser] = (headToHead[winner][loser] || 0) + 1;
  });
  rows.sort((a, b) => b.wins - a.wins
    || (headToHead[b.team_id][a.team_id] || 0) - (headToHead[a.team_id][b.team_id] || 0)
    || b.pointDiff - a.pointDiff
    || b.pointsFor - a.pointsFor);
  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}

function createTradePlan(teams, random) {
  const target = randomInt(16, 32, random);
  const used = new Set();
  const triggers = new Set();
  const events = [];
  let remaining = target;
  while (remaining >= 2) {
    let size = Math.min(randomInt(2, 4, random), remaining);
    if (remaining - size === 1) size -= 1;
    const candidates = shuffle(Object.values(teams), random)
      .map((team) => ({ team, players: team.roster.filter((player) => !used.has(player.id)) }))
      .filter((entry) => entry.players.length);
    if (candidates.length < size) break;
    const chosen = candidates.slice(0, size).map((entry) => ({
      player: entry.players[randomInt(0, entry.players.length - 1, random)],
      fromTeamId: entry.team.id
    }));
    chosen.forEach((item) => used.add(item.player.id));
    let trigger = randomInt(24, 216, random);
    while (triggers.has(trigger)) trigger = trigger >= 216 ? 24 : trigger + 1;
    triggers.add(trigger);
    events.push({ trigger, chosen, executed: false });
    remaining -= size;
  }
  return events;
}

function executeTrades(teams, plan, completedMatches) {
  const due = plan.filter((event) => !event.executed && event.trigger <= completedMatches);
  due.forEach((event) => {
    event.executed = true;
    event.chosen.forEach((item, index) => {
      item.player.team_id = event.chosen[(index + 1) % event.chosen.length].fromTeamId;
      item.player.starter = false;
    });
  });
  if (due.length) {
    const players = Object.values(teams).flatMap((team) => team.roster);
    for (const team of Object.values(teams)) {
      team.roster = players.filter((player) => player.team_id === team.id);
    }
    refreshStarters(teams);
  }
}

function offseasonMove(teams, random) {
  const players = Object.values(teams).flatMap((team) => team.roster);
  const selected = shuffle(players, random).slice(0, randomInt(32, 40, random));
  const oldTeams = selected.map((player) => player.team_id);
  let newTeams = shuffle(oldTeams, random);
  let attempts = 0;
  while (attempts < 100 && oldTeams.every((teamId, index) => teamId === newTeams[index])) {
    newTeams = shuffle(oldTeams, random);
    attempts += 1;
  }
  selected.forEach((player, index) => { player.team_id = newTeams[index]; });
  for (const team of Object.values(teams)) {
    team.roster = players.filter((player) => player.team_id === team.id);
  }
  refreshStarters(teams);
}

function draftDevelopment(teams, regularStandings, random) {
  const chances = [1, 0.70, 0.45, 0.25];
  [...regularStandings].sort((a, b) => b.rank - a.rank).slice(0, 4).forEach((standing, index) => {
    if (random() > chances[index]) return;
    const team = teams[standing.team_id];
    const player = [...team.roster].sort((a, b) => a.ability - b.ability || Number(a.starter) - Number(b.starter))[0];
    const roll = random();
    const thresholds = [[0.72, 0.95], [0.77, 0.97], [0.82, 0.98], [0.88, 0.99]][index];
    let nextAbility = player.ability + randomInt(3, 8, random);
    if (roll >= thresholds[1]) {
      const starterFloor = Math.min(...team.roster.filter((item) => item.starter).map((item) => item.ability));
      nextAbility = Math.max(player.ability + randomInt(12, 20, random), starterFloor + randomInt(0, 3, random));
    } else if (roll >= thresholds[0]) {
      nextAbility = player.ability + randomInt(9, 16, random);
    }
    player.ability = clamp(nextAbility, player.ability, 99);
  });
  refreshStarters(teams);
}

function playoffSeries(firstTeamId, secondTeamId, teams, recentGames, random) {
  let firstWins = 0;
  let secondWins = 0;
  let home = firstTeamId;
  let away = secondTeamId;
  while (firstWins < 2 && secondWins < 2) {
    const result = simulateScore(matchProbability(teams[home], teams[away], recentGames, true), random);
    const winner = result.homeWins ? home : away;
    if (winner === firstTeamId) firstWins += 1;
    else secondWins += 1;
    [home, away] = [away, home];
  }
  return firstWins === 2 ? firstTeamId : secondTeamId;
}

function simulateSeason(teams, random) {
  const openingStarsByTeam = Object.fromEntries(TEAM_IDS.map((teamId) => [teamId, teamStars(teams[teamId])]));
  const recentGames = Object.fromEntries(TEAM_IDS.map((teamId) => [teamId, []]));
  const tradePlan = createTradePlan(teams, random);
  const results = [];
  schedule().forEach((match, index) => {
    const score = simulateScore(matchProbability(teams[match.home], teams[match.away], recentGames, false), random);
    results.push({ ...match, ...score });
    recentGames[match.home].push({ scoreFor: score.homeScore, scoreAgainst: score.awayScore });
    recentGames[match.away].push({ scoreFor: score.awayScore, scoreAgainst: score.homeScore });
    recentGames[match.home] = recentGames[match.home].slice(-5);
    recentGames[match.away] = recentGames[match.away].slice(-5);
    executeTrades(teams, tradePlan, index + 1);
  });
  const regularStandings = standings(results);
  const starsByTeam = Object.fromEntries(TEAM_IDS.map((teamId) => [teamId, teamStars(teams[teamId])]));
  const top = regularStandings.slice(0, 8).map((row) => row.team_id);
  const pairs = [[top[0], top[7]], [top[1], top[6]], [top[2], top[5]], [top[3], top[4]]];
  const firstRound = pairs.map(([higher, lower]) => ({
    higher,
    lower,
    winner: playoffSeries(higher, lower, teams, recentGames, random)
  }));
  offseasonMove(teams, random);
  draftDevelopment(teams, regularStandings, random);
  return { regularStandings, starsByTeam, openingStarsByTeam, firstRound };
}

const starStats = Object.fromEntries([1, 2, 3, 4, 5].map((star) => [star, { total: 0, top8: 0 }]));
let highStarTeams = 0;
let seasons = 0;
let firstRoundSeries = 0;
let firstRoundUpsets = 0;
let blackEightUpsets = 0;

for (const seed of [42, 100, 200, 300, 400, 500, 600, 700, 800, 900]) {
  const random = mulberry32(seed);
  const teams = createTeams(random);
  // 以赛季开盘时玩家可见星级预测最终前八，避免用赛季末新阵容倒推已完成比赛。
  for (let season = 0; season < 5; season += 1) {
    const result = simulateSeason(teams, random);
    const top8 = new Set(result.regularStandings.slice(0, 8).map((row) => row.team_id));
    TEAM_IDS.forEach((teamId) => {
      const star = result.openingStarsByTeam[teamId];
      starStats[star].total += 1;
      if (top8.has(teamId)) starStats[star].top8 += 1;
      if (star >= 4) highStarTeams += 1;
    });
    result.firstRound.forEach((series, index) => {
      firstRoundSeries += 1;
      if (series.winner === series.lower) {
        firstRoundUpsets += 1;
        if (index === 0) blackEightUpsets += 1;
      }
    });
    seasons += 1;
  }
}

const rates = Object.fromEntries(Object.entries(starStats).map(([star, stats]) => [
  star,
  stats.total ? stats.top8 / stats.total : 0
]));
const highTotal = starStats[4].total + starStats[5].total;
const highRate = (starStats[4].top8 + starStats[5].top8) / highTotal;
const upsetRate = firstRoundUpsets / firstRoundSeries;
const blackEightRate = blackEightUpsets / seasons;
const avgHighStars = highStarTeams / seasons;

console.log(`sports-stars-calibration: 1★ ${(rates[1] * 100).toFixed(1)}% | 2★ ${(rates[2] * 100).toFixed(1)}% | 3★ ${(rates[3] * 100).toFixed(1)}% | 4★ ${(rates[4] * 100).toFixed(1)}% | 5★ ${(rates[5] * 100).toFixed(1)}% | 4/5★ ${(highRate * 100).toFixed(1)}% | 首轮爆冷 ${(upsetRate * 100).toFixed(1)}% | 黑八 ${(blackEightRate * 100).toFixed(1)}% | 每季高星 ${avgHighStars.toFixed(2)}队`);

assert.ok(highRate >= 0.93 && highRate <= 0.97, `4/5星综合前八率 ${(highRate * 100).toFixed(1)}% 不在 93%-97%`);
assert.ok(rates[5] >= 0.98, `5星前八率 ${(rates[5] * 100).toFixed(1)}% 低于 98%`);
for (let star = 2; star <= 5; star += 1) {
  assert.ok(rates[star] > rates[star - 1],
    `${star}星前八率 ${(rates[star] * 100).toFixed(1)}% 未严格高于 ${star - 1}星 ${(rates[star - 1] * 100).toFixed(1)}%`);
}
assert.ok(avgHighStars >= 3 && avgHighStars <= 5, `每季4/5星球队均值 ${avgHighStars.toFixed(2)} 不在 3-5`);
assert.ok(upsetRate >= 0.25 && upsetRate <= 0.45, `季后赛首轮爆冷率 ${(upsetRate * 100).toFixed(1)}% 明显偏离当前水平`);
assert.ok(blackEightRate >= 0.15 && blackEightRate <= 0.40, `黑八率 ${(blackEightRate * 100).toFixed(1)}% 明显偏离当前水平`);

console.log(`sports-stars-calibration-test: PASS | 4/5星前八 ${(highRate * 100).toFixed(1)}% | 5星前八 ${(rates[5] * 100).toFixed(1)}% | 首轮爆冷 ${(upsetRate * 100).toFixed(1)}% | 黑八 ${(blackEightRate * 100).toFixed(1)}% | 每季高星 ${avgHighStars.toFixed(2)}队`);

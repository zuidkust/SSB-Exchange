const TIMEZONE = 'Asia/Shanghai';
const DAILY_TICK_TOTAL = 8;
const ADVANCE_HOURS = [8, 9, 10, 11, 13, 14, 15, 16];
const OPEN_HOUR = 8;
const CLOSE_HOUR = 17; // 必须 > ADVANCE_HOURS 最后一个元素（16），确保最后一期 tick 后仍有交易窗口

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

function now() {
  return process.env.SSB_CLOCK_NOW ? new Date(process.env.SSB_CLOCK_NOW) : new Date();
}

function shanghaiParts(date = now()) {
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function toZonedIso(dateString, hour, minute = 0, second = 0) {
  return `${dateString}T${pad(hour)}:${pad(minute)}:${pad(second)}+08:00`;
}

function serverTimeIso(date = now()) {
  const parts = shanghaiParts(date);
  return toZonedIso(parts.date, parts.hour, parts.minute, parts.second);
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return shanghaiParts(date).date;
}

function parseClockDate(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
    return new Date(text.replace(' ', 'T') + 'Z');
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isTradingAllowed(date = now()) {
  const parts = shanghaiParts(date);
  return parts.hour >= OPEN_HOUR && parts.hour < CLOSE_HOUR;
}

function isAdvanceMoment(date = now()) {
  const parts = shanghaiParts(date);
  return ADVANCE_HOURS.includes(parts.hour) && parts.minute === 0;
}

function advanceKey(date = now()) {
  const parts = shanghaiParts(date);
  return `${parts.date}-${pad(parts.hour)}`;
}

function nextAdvanceAt(date = now()) {
  const parts = shanghaiParts(date);
  if (parts.hour < OPEN_HOUR) return toZonedIso(parts.date, OPEN_HOUR);
  const nextHour = ADVANCE_HOURS.find((hour) => {
    if (hour <= parts.hour) return false;
    return true;
  });
  if (nextHour) return toZonedIso(parts.date, nextHour);
  return toZonedIso(addDays(parts.date, 1), OPEN_HOUR);
}

function calendarDayDiff(fromValue, toDate = now()) {
  const from = parseClockDate(fromValue);
  if (!from) return 0;
  const fromParts = shanghaiParts(from);
  const toParts = shanghaiParts(toDate);
  const fromDay = new Date(`${fromParts.date}T00:00:00+08:00`);
  const toDay = new Date(`${toParts.date}T00:00:00+08:00`);
  return Math.max(0, Math.round((toDay.getTime() - fromDay.getTime()) / 86400000));
}

function buildMarketClock(market = {}, date = now()) {
  const parts = shanghaiParts(date);
  const sleeping = !!market.sleeping;
  const forceOpen = !!market.force_open;
  const tradingAllowed = forceOpen || (isTradingAllowed(date) && !sleeping);
  return {
    status: tradingAllowed ? 'open' : 'closed',
    timezone: TIMEZONE,
    server_time: serverTimeIso(date),
    market_date: market.market_date || parts.date,
    daily_tick_index: Number(market.day_tick_index || 0),
    daily_tick_total: dailyTickTotal(market, date),
    next_advance_at: sleeping ? null : nextAdvanceAt(date),
    last_auto_advance_key: market.last_auto_advance_key || null,
    last_auto_advance_at: market.last_auto_advance_at || null,
    trading_allowed: tradingAllowed,
    sleeping,
    sleep_reason: market.sleep_reason || null,
    sleep_since: market.sleep_since || null,
    force_open: forceOpen
  };
}

function dailyTickTotal(market = {}, date = now()) {
  const parts = shanghaiParts(date);
  const marketDate = market.market_date || parts.date;
  const cycleStartedAt = market.cycle_started_at || market.created_at || null;
  if (!cycleStartedAt) return DAILY_TICK_TOTAL;

  const started = parseClockDate(cycleStartedAt);
  if (!started) return DAILY_TICK_TOTAL;

  const startedParts = shanghaiParts(started);
  if (startedParts.date !== marketDate) return DAILY_TICK_TOTAL;

  return ADVANCE_HOURS.reduce((count, hour) => {
    const slot = new Date(toZonedIso(marketDate, hour));
    return count + (slot.getTime() >= started.getTime() ? 1 : 0);
  }, 0);
}

function autoAdvanceDecision(market = {}, date = now()) {
  if (market.sleeping) {
    return { should_advance: false, reason: 'market_sleeping', advance_key: advanceKey(date) };
  }
  if (!isAdvanceMoment(date)) {
    return { should_advance: false, reason: 'not_advance_moment', advance_key: advanceKey(date) };
  }
  const key = advanceKey(date);
  if (market.last_auto_advance_key === key) {
    return { should_advance: false, reason: 'already_advanced', advance_key: key };
  }
  return { should_advance: true, reason: 'scheduled', advance_key: key };
}

// 返回 'YYYY-MM-DD HH:MM:SS'（UTC），匹配 datetime('now') 格式
// days=2 → '近3天'（今天 + 前2天 = 3 个日历天）
function shanghaiDaysAgoUtcSpace(days) {
  const today = shanghaiParts().date;
  const target = addDays(today, -days);
  const utc = new Date(`${target}T00:00:00+08:00`);
  const iso = utc.toISOString();
  return iso.replace('T', ' ').replace(/\.\d+Z$/, '');
}

// 返回 'YYYY-MM-DDThh:mm:ss+08:00'，匹配 serverTimeIso 格式（sports_bets.created_at）
function shanghaiDaysAgoIso(days) {
  const today = shanghaiParts().date;
  const target = addDays(today, -days);
  return `${target}T00:00:00+08:00`;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

module.exports = {
  TIMEZONE,
  DAILY_TICK_TOTAL,
  ADVANCE_HOURS,
  OPEN_HOUR,
  CLOSE_HOUR,
  now,
  shanghaiParts,
  toZonedIso,
  serverTimeIso,
  addDays,
  parseClockDate,
  calendarDayDiff,
  isTradingAllowed,
  isAdvanceMoment,
  advanceKey,
  nextAdvanceAt,
  dailyTickTotal,
  buildMarketClock,
  autoAdvanceDecision,
  shanghaiDaysAgoUtcSpace,
  shanghaiDaysAgoIso
};

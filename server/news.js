const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');

let _templates = null;
function getTemplates() {
  if (!_templates) {
    try {
      const filePath = path.join(__dirname, 'news-library.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      _templates = data.templates || [];
    } catch (e) {
      console.error('[newsGenerator] 加载模板库失败:', e.message);
      _templates = [];
    }
    try {
      const futuresPath = path.join(__dirname, 'futures-news.json');
      if (fs.existsSync(futuresPath)) {
        const futuresData = JSON.parse(fs.readFileSync(futuresPath, 'utf8'));
        const futuresTemplates = (futuresData.templates || []).map(t => ({ ...t, is_futures_template: true }));
        _templates = _templates.concat(futuresTemplates);
      }
    } catch (e) {
      console.error('[newsGenerator] 加载期货模板库失败:', e.message);
    }
  }
  return _templates;
}

const INDUSTRY_CHAIN = {
  '光伏储能': 'new_energy', '新能源车': 'new_energy', '环保': 'new_energy',
  '半导体': 'tech', '软件/云计算': 'tech', '通信': 'tech', '消费电子': 'tech',
  '食品饮料': 'consumer', '零售': 'consumer', '教育': 'consumer', '传媒文娱': 'consumer',
  '房地产': 'property', '建筑建材': 'property',
  '医药': 'pharma', '医疗器械': 'pharma', '生物科技': 'pharma',
  '金融': 'finance', '农业': 'cycle', '物流': 'cycle', '资源能源': 'cycle',
  '高端制造': 'manufacturing'
};

const CHAIN_LINKAGE = {
  'new_energy': ['光伏储能', '新能源车', '环保'],
  'tech': ['半导体', '软件/云计算', '通信', '消费电子'],
  'consumer': ['食品饮料', '零售', '教育', '传媒文娱'],
  'property': ['房地产', '建筑建材'],
  'pharma': ['医药', '医疗器械', '生物科技'],
  'finance': ['金融'],
  'cycle': ['农业', '物流', '资源能源'],
  'manufacturing': ['高端制造']
};

const NEWS_IMPACT = {
  REAL_MAGNITUDE: { min: 0.06, max: 0.10 },
  FAKE_INITIAL: { min: 0.03, max: 0.08 },
  FAKE_REVERSAL: { min: 0.04, max: 0.09 },
  DURATION: { min: 4, max: 8 },
  AMBIGUOUS_DURATION: { min: 2, max: 4 },
  RUMOR_DURATION: { min: 1, max: 2 },
  RUMOR_DELAY: { min: 2, max: 5 },
  LINKAGE_RATIO: { min: 0.05, max: 0.15 },
  LINKAGE_INDUSTRY_PICK: { min: 1, max: 2 },
  AMBIGUOUS_MAGNITUDE: { min: 0.01, max: 0.05 },
  MAX_COMBINED: 0.08,
  MARKET_MAGNITUDE_SCALE: 0.4
};

const RUMOR_CONFUSION_RATE = 0.15;
const RUMOR_GENERATION_PROBABILITY = 0.40;
const NEWS_PER_TICK = { min: 4, max: 8 };
const GENERATION_RULES = {
  maxAttemptsMultiplier: 8,
  maxSameDirectionActive: 2
};

function randomBetween(min, max) { return min + Math.random() * (max - min); }
function randomInt(min, max) { return Math.floor(randomBetween(min, max + 1)); }
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function generateNews(tick, stocks) {
  const templates = getTemplates();
  const newsCount = randomInt(NEWS_PER_TICK.min, NEWS_PER_TICK.max);
  const generated = [];
  const activeNews = getImpactNewsAtTick(tick);
  const maxAttempts = Math.max(newsCount * GENERATION_RULES.maxAttemptsMultiplier, NEWS_PER_TICK.min * 4);

  for (let attempts = 0; generated.length < newsCount && attempts < maxAttempts; attempts += 1) {
    const preferAmbiguous = generated.length < NEWS_PER_TICK.min && attempts > maxAttempts * 0.65;
    const nonFuturesTemplates = templates.filter(t => !t.is_futures_template);
    const template = selectTemplate(nonFuturesTemplates.length ? nonFuturesTemplates : templates, { preferAmbiguous });
    if (!template) continue;
    if (template.bind_mode === 'market' && Math.random() < 0.5) continue;

    const resolved = resolveTarget(template, stocks);
    if (!resolved) continue;

    const newsDoc = buildNewsDoc(template, resolved, tick);
    if (shouldSkipGeneratedNews(newsDoc, activeNews, stocks, tick)) continue;

    try {
      const cols = Object.keys(newsDoc);
      const vals = Object.values(newsDoc).map(v => db.q(v));
      db.exec(`INSERT INTO news (${cols.join(',')}) VALUES (${vals.join(',')});`);
      const inserted = db.get('SELECT * FROM news WHERE id = last_insert_rowid();');
      generated.push(inserted);
      activeNews.push(inserted);
    } catch (e) {
      console.error('[newsGenerator] 写入失败:', e.message);
    }
  }

  if (Math.random() < 0.3) {
    const fluffTemplates = templates.filter(t => t.is_fluff);
    if (fluffTemplates.length > 0) {
      const template = pickRandom(fluffTemplates);
      const resolved = resolveTarget(template, stocks);
      if (resolved) {
        const newsDoc = buildNewsDoc(template, resolved, tick);
        try {
          const cols = Object.keys(newsDoc);
          const vals = Object.values(newsDoc).map(v => db.q(v));
          db.exec(`INSERT INTO news (${cols.join(',')}) VALUES (${vals.join(',')});`);
          const inserted = db.get('SELECT * FROM news WHERE id = last_insert_rowid();');
          generated.push(inserted);
        } catch (e) {
          console.error('[newsGenerator] 花边写入失败:', e.message);
        }
      }
    }
  }

  const futuresNews = generateFuturesNews(tick, templates, stocks);
  generated.push(...futuresNews);

  return generated;
}

function generateFuturesNews(tick, templates, stocks) {
  const { RULES } = require('./data');
  const probability = RULES.FUTURES_NEWS_PROBABILITY || 0.20;
  if (Math.random() > probability) return [];

  const futuresTemplates = templates.filter(t => t.is_futures_template);
  if (!futuresTemplates.length) return [];

  let template = selectTemplate(futuresTemplates, {});
  if (!template) return [];

  // 4.2 Crypto real:fake ratio adjustment: selectTemplate gives ~62.5% real
  // among directional news. For crypto, flip ~20% of real→fake to reach ~50:50.
  if (template.pool === 'crypto' && ['real_bullish','real_bearish','fake_bullish','fake_bearish'].includes(template.truth_type)) {
    const isReal = template.truth_type.startsWith('real');
    if (isReal && Math.random() < 0.20) {
      const targetType = template.truth_type === 'real_bullish' ? 'fake_bullish' : 'fake_bearish';
      const alternates = futuresTemplates.filter(t =>
        t.pool === 'crypto' && t.truth_type === targetType
      );
      if (alternates.length > 0) template = pickRandom(alternates);
    }
  }

  const resolved = resolveTarget(template, stocks);
  if (!resolved) return [];

  const newsDoc = buildNewsDoc(template, resolved, tick);
  try {
    const cols = Object.keys(newsDoc);
    const vals = Object.values(newsDoc).map(v => db.q(v));
    db.exec(`INSERT INTO news (${cols.join(',')}) VALUES (${vals.join(',')});`);
    const inserted = db.get('SELECT * FROM news WHERE id = last_insert_rowid();');
    return [inserted];
  } catch (e) {
    console.error('[newsGenerator] 期货新闻写入失败:', e.message);
    return [];
  }
}

function selectTemplate(templates, options = {}) {
  if (templates.length === 0) return null;
  if (options.preferAmbiguous) {
    const ambiguous = templates.filter(t => t.truth_type === 'ambiguous');
    if (ambiguous.length > 0) return pickRandom(ambiguous);
  }

  const rand = Math.random();
  let targetTruthType;
  if (rand < 0.15) targetTruthType = 'real_bullish';
  else if (rand < 0.30) targetTruthType = 'real_bearish';
  else if (rand < 0.70) targetTruthType = Math.random() < 0.5 ? 'fake_bullish' : 'fake_bearish';
  else targetTruthType = 'ambiguous';

  const candidates = templates.filter(t => t.truth_type === targetTruthType);
  return candidates.length > 0 ? pickRandom(candidates) : pickRandom(templates);
}

function getImpactNewsAtTick(tick) {
  return db.all(
    `SELECT * FROM news WHERE published = 1 AND impact_start_tick <= ${tick}
     AND (impact_start_tick + impact_duration_ticks) > ${tick};`
  );
}

function shouldSkipGeneratedNews(newsDoc, activeNews, stocks, tick) {
  const direction = getGenerationDirection(newsDoc, tick);
  if (direction === 0) return false;

  let sameDirectionCount = 0;
  for (const active of activeNews) {
    const activeDirection = getGenerationDirection(active, tick);
    if (activeDirection === 0) continue;
    if (!hasPrimaryTargetOverlap(newsDoc, active, stocks)) continue;

    if (activeDirection === -direction) return true;
    if (activeDirection === direction) sameDirectionCount += 1;
  }

  return sameDirectionCount >= marketMaxSameDirection(newsDoc);
}

function marketMaxSameDirection(newsDoc) {
  return (newsDoc && newsDoc.target_code === 'MARKET') ? 1 : GENERATION_RULES.maxSameDirectionActive;
}

function getGenerationDirection(newsDoc, currentTick) {
  if (!newsDoc) return 0;
  const start = Number(newsDoc.impact_start_tick || currentTick);
  const duration = Number(newsDoc.impact_duration_ticks || 0);
  const tickSinceStart = currentTick - start;
  if (duration && (tickSinceStart < 0 || tickSinceStart >= duration)) return 0;
  if (newsDoc.truth_type === 'ambiguous') return 0;
  if (newsDoc.truth_type && newsDoc.truth_type.startsWith('fake') && newsDoc.reveal_tick && currentTick >= Number(newsDoc.reveal_tick)) {
    return 0;
  }
  return sentimentDirection(newsDoc.visible_sentiment);
}

function sentimentDirection(sentiment) {
  if (sentiment === 'bullish') return 1;
  if (sentiment === 'bearish') return -1;
  return 0;
}

function hasPrimaryTargetOverlap(a, b, stocks) {
  if (a.target_type === 'market' || b.target_type === 'market') {
    return a.target_type === 'market' && b.target_type === 'market';
  }
  if (a.target_type === b.target_type) return a.target_code === b.target_code;
  if (a.target_type === 'stock' && b.target_type === 'industry') {
    return stockIndustry(stocks, a.target_code) === b.target_code;
  }
  if (a.target_type === 'industry' && b.target_type === 'stock') {
    return a.target_code === stockIndustry(stocks, b.target_code);
  }
  return false;
}

function stockIndustry(stocks, code) {
  const stock = stocks.find(s => s.code === code);
  return stock ? stock.industry : null;
}

function resolveTarget(template, stocks) {
  const targetIndustry = template.target_industry;
  switch (template.bind_mode) {
    case 'industry_random': {
      const industryStocks = stocks.filter(s => s.industry === targetIndustry);
      if (industryStocks.length === 0) return null;
      const targetStock = pickRandom(industryStocks);
      return {
        target_type: 'stock', target_code: targetStock.code,
        target_industry: targetIndustry, stock_name: targetStock.name
      };
    }
    case 'industry_direct': {
      let stockName = null;
      if ((template.title || '').includes('{stock_name}') || (template.content || '').includes('{stock_name}')) {
        const industryStocks = stocks.filter(s => s.industry === targetIndustry);
        if (industryStocks.length > 0) {
          stockName = pickRandom(industryStocks).name;
        }
      }
      return {
        target_type: 'industry', target_code: targetIndustry,
        target_industry: targetIndustry, stock_name: stockName
      };
    }
    case 'market':
      return { target_type: 'market', target_code: 'MARKET', target_industry: null, stock_name: null };
    case 'futures_direct': {
      const targetCode = template.target_code;
      if (!targetCode) return null;
      return {
        target_type: 'futures', target_code: targetCode,
        target_industry: template.futures_track || null, stock_name: null
      };
    }
    case 'futures_random': {
      const { DEFAULT_FUTURES } = require('./data');
      if (!DEFAULT_FUTURES || !DEFAULT_FUTURES.length) return null;
      const target = pickRandom(DEFAULT_FUTURES);
      return {
        target_type: 'futures', target_code: target.code,
        target_industry: target.track || null, stock_name: null
      };
    }
    default:
      return null;
  }
}

function sanitizeContent(text) {
  return String(text || '')
    .replace(/风格：.+?。发布时随机匹配【.+?】行业个股。$/g, '')
    .replace(/发布时随机匹配【.+?】行业个股。$/g, '')
    .trim();
}

function buildNewsDoc(template, resolved, tick) {
  let title = sanitizeContent(template.title);
  let content = sanitizeContent(template.content);
  if (resolved.stock_name) {
    title = title.replace(/\{stock_name\}/g, resolved.stock_name);
    content = content.replace(/\{stock_name\}/g, resolved.stock_name);
  }
  // Replace {name} for futures templates
  if (template.is_futures_template && resolved.target_code) {
    const { DEFAULT_FUTURES } = require('./data');
    const underlying = (DEFAULT_FUTURES || []).find(u => u.code === resolved.target_code);
    if (underlying) {
      title = title.replace(/\{name\}/g, underlying.name);
      content = content.replace(/\{name\}/g, underlying.name);
    }
  }
  title = title.replace(/\{stock_name\}/g, '某公司');
  content = content.replace(/\{stock_name\}/g, '某公司');

  const impactParams = calculateImpactParams(template);
  if (resolved.target_type === 'market') {
    impactParams.magnitude = Number((impactParams.magnitude * NEWS_IMPACT.MARKET_MAGNITUDE_SCALE).toFixed(4));
  }

  return {
    title, content,
    source_type: template.source_type,
    news_type: template.news_type,
    visible_sentiment: template.visible_sentiment,
    target_type: resolved.target_type,
    target_code: resolved.target_code,
    created_tick: tick,
    published: 1,
    is_rumor: 0,
    expert_id: template.expert_id || null,
    expert_name: template.expert_name || null,
    truth_type: template.truth_type,
    impact_magnitude: impactParams.magnitude,
    impact_start_tick: tick,
    impact_duration_ticks: impactParams.duration,
    reveal_tick: template.truth_type.startsWith('fake') ? tick + impactParams.revealDelay : null,
    linked_news_id: null,
    chain: template.chain || null,
    rumor_generated: 0,
    is_fluff: template.is_fluff ? 1 : 0
  };
}

function calculateImpactParams(template) {
  if (template.is_fluff) return { magnitude: 0, duration: 0, revealDelay: 0 };
  const isFake = template.truth_type.startsWith('fake');
  const isAmbiguous = template.truth_type === 'ambiguous';
  let magnitude, duration, revealDelay;

  if (isFake) {
    magnitude = randomBetween(NEWS_IMPACT.FAKE_INITIAL.min, NEWS_IMPACT.FAKE_INITIAL.max);
    duration = randomInt(NEWS_IMPACT.DURATION.min, NEWS_IMPACT.DURATION.max);
    revealDelay = randomInt(NEWS_IMPACT.RUMOR_DELAY.min, NEWS_IMPACT.RUMOR_DELAY.max);
  } else if (isAmbiguous) {
    magnitude = randomBetween(NEWS_IMPACT.AMBIGUOUS_MAGNITUDE.min, NEWS_IMPACT.AMBIGUOUS_MAGNITUDE.max);
    duration = randomInt(NEWS_IMPACT.AMBIGUOUS_DURATION.min, NEWS_IMPACT.AMBIGUOUS_DURATION.max);
    revealDelay = 0;
  } else {
    magnitude = randomBetween(NEWS_IMPACT.REAL_MAGNITUDE.min, NEWS_IMPACT.REAL_MAGNITUDE.max);
    duration = randomInt(NEWS_IMPACT.DURATION.min, NEWS_IMPACT.DURATION.max);
    revealDelay = 0;
  }

  return { magnitude, duration, revealDelay };
}

function calculateNewsImpact(news, stockCode, stockIndustry, currentTick) {
  if (news.is_fluff) return 0;
  const tickSinceStart = currentTick - news.impact_start_tick;
  if (tickSinceStart < 0 || tickSinceStart >= news.impact_duration_ticks) return 0;

  const isDirectTarget = isNewsTargetStock(news, stockCode, stockIndustry);
  const isChainLinked = isChainLinkedStock(news, stockIndustry);
  if (!isDirectTarget && !isChainLinked) return 0;

  const direction = getImpactDirection(news, tickSinceStart, stockCode, currentTick);
  if (direction === 0) return 0;

  const progressRatio = (tickSinceStart + 1) / news.impact_duration_ticks;
  let magnitude = news.impact_magnitude * progressRatio;

  if (isChainLinked && !isDirectTarget) {
    magnitude *= stableBetween(`${news.id || news.title}:${stockIndustry}:chain`,
      NEWS_IMPACT.LINKAGE_RATIO.min, NEWS_IMPACT.LINKAGE_RATIO.max);
  }

  if (news.truth_type === 'ambiguous') {
    magnitude *= stableBetween(`${news.id || news.title}:${stockCode}:${currentTick}:ambiguous`, 0.5, 1.5);
  }

  return direction * magnitude;
}

function isNewsTargetStock(news, stockCode, stockIndustry) {
  if (news.target_type === 'stock') return news.target_code === stockCode;
  if (news.target_type === 'industry') return news.target_code === stockIndustry;
  if (news.target_type === 'market') return true;
  return false;
}

function isChainLinkedStock(news, stockIndustry) {
  if (!news.chain) return false;
  const chainIndustries = CHAIN_LINKAGE[news.chain] || [];
  if (!chainIndustries.length) return false;
  const key = `${news.id || ''}:${news.created_tick || 0}:${news.chain}`;
  const range = Math.min(NEWS_IMPACT.LINKAGE_INDUSTRY_PICK.max, chainIndustries.length) - NEWS_IMPACT.LINKAGE_INDUSTRY_PICK.min + 1;
  const pickCount = NEWS_IMPACT.LINKAGE_INDUSTRY_PICK.min + Math.floor(stableUnit(key + ':count') * range);
  const picked = new Set();
  for (let i = 0; i < pickCount; i++) {
    const idx = Math.floor(stableUnit(key + ':pick' + i) * chainIndustries.length);
    picked.add(chainIndustries[idx % chainIndustries.length]);
  }
  return picked.has(stockIndustry);
}

function getImpactDirection(news, tickSinceStart, stockCode, currentTick) {
  if (news.truth_type === 'ambiguous') {
    return stableUnit(`${news.id || news.title}:${stockCode}:${currentTick}:direction`) < 0.5 ? -1 : 1;
  }

  const isFake = news.truth_type.startsWith('fake');
  const isRevealed = news.reveal_tick && tickSinceStart >= (news.reveal_tick - news.impact_start_tick);

  if (!isFake) return sentimentDirection(news.visible_sentiment);

  if (isFake && !isRevealed) return sentimentDirection(news.visible_sentiment);

  return 0;
}

function stableUnit(key) {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function stableBetween(key, min, max) {
  return min + stableUnit(key) * (max - min);
}

function clampCombinedImpact(value) {
  return Math.max(-NEWS_IMPACT.MAX_COMBINED, Math.min(NEWS_IMPACT.MAX_COMBINED, value));
}

function calculateRealNewsImpactIncrement(news, stockCode, stockIndustry, currentTick) {
  if (!news || news.is_rumor || !String(news.truth_type || '').startsWith('real')) return 0;
  const current = calculateNewsImpact(news, stockCode, stockIndustry, currentTick);
  const previous = calculateNewsImpact(news, stockCode, stockIndustry, currentTick - 1);
  return current - previous;
}

function checkAndGenerateRumors(tick) {
  const fakes = db.all(
    `SELECT * FROM news WHERE is_rumor = 0 AND truth_type LIKE 'fake_%'
     AND reveal_tick IS NOT NULL AND reveal_tick <= ${tick} AND (rumor_generated IS NULL OR rumor_generated = 0);`
  );

  const rumors = [];
  for (const fakeNews of fakes) {
    const existing = db.get(
      `SELECT id FROM news WHERE linked_news_id = ${fakeNews.id} AND is_rumor = 1 LIMIT 1;`
    );
    if (existing) continue;

    if (Math.random() >= RUMOR_GENERATION_PROBABILITY) {
      db.exec(`UPDATE news SET rumor_generated = 1 WHERE id = ${fakeNews.id};`);
      continue;
    }

    const isConfusion = Math.random() < RUMOR_CONFUSION_RATE;
    const rumorDoc = buildRumorDoc(fakeNews, tick, isConfusion);

    const cols = Object.keys(rumorDoc);
    const vals = Object.values(rumorDoc).map(v => db.q(v));
    db.exec(`INSERT INTO news (${cols.join(',')}) VALUES (${vals.join(',')});`);
    const inserted = db.get('SELECT * FROM news WHERE id = last_insert_rowid();');

    db.exec(`UPDATE news SET rumor_generated = 1 WHERE id = ${fakeNews.id};`);
    rumors.push(inserted);
  }

  return rumors;
}

function buildRumorDoc(fakeNews, tick, isConfusion) {
  const cleanTitle = (fakeNews.title || '').replace(/\{stock_name\}/g, '某公司');
  const rumorTitle = isConfusion
    ? `【反转】${cleanTitle}，但又有新说法`
    : `【辟谣】${cleanTitle.replace(/【传闻】|惊悚：|假消息：|谣言：/g, '')}，官方澄清`;

  const rumorContent = isConfusion
    ? `${cleanTitle}，然而事件再起波澜，市场解读更加混乱。`
    : `${cleanTitle}。经核实，该消息不实，官方已发布澄清公告。`;

  return {
    title: rumorTitle, content: rumorContent,
    source_type: 'official_clarification',
    news_type: fakeNews.news_type,
    visible_sentiment: isConfusion ? 'neutral' : (fakeNews.visible_sentiment === 'bullish' ? 'bearish' : 'bullish'),
    target_type: fakeNews.target_type,
    target_code: fakeNews.target_code,
    created_tick: tick,
    published: 1,
    is_rumor: 1,
    expert_id: null,
    expert_name: null,
    truth_type: isConfusion ? 'ambiguous' : (fakeNews.truth_type === 'fake_bullish' ? 'real_bearish' : 'real_bullish'),
    impact_magnitude: isConfusion
      ? randomBetween(NEWS_IMPACT.AMBIGUOUS_MAGNITUDE.min, NEWS_IMPACT.AMBIGUOUS_MAGNITUDE.max)
      : randomBetween(NEWS_IMPACT.FAKE_REVERSAL.min, NEWS_IMPACT.FAKE_REVERSAL.max),
    impact_start_tick: tick,
    impact_duration_ticks: randomInt(NEWS_IMPACT.RUMOR_DURATION.min, NEWS_IMPACT.RUMOR_DURATION.max),
    reveal_tick: null,
    linked_news_id: fakeNews.id,
    chain: fakeNews.chain,
    rumor_generated: 0
  };
}

function generateDailyReport(tick, startTick, userId) {
  if (!startTick || startTick >= tick) return null;
  return generateReport(tick, startTick, userId);
}

function generateWeeklyReport(tick, userId) {
  const reportInterval = 7;
  if (tick % reportInterval !== 0) return null;
  const startTick = tick - reportInterval + 1;
  return generateReport(tick, startTick, userId);
}

function generateReport(tick, startTick, userId) {
  const pricesStart = db.all(`SELECT stock_code, close FROM stock_prices WHERE tick = ${startTick};`);
  const pricesEnd = db.all(`SELECT stock_code, close FROM stock_prices WHERE tick = ${tick};`);

  const startMap = Object.fromEntries(pricesStart.map(r => [r.stock_code, r.close]));
  const endMap = Object.fromEntries(pricesEnd.map(r => [r.stock_code, r.close]));

  const changes = [];
  for (const [code, endPrice] of Object.entries(endMap)) {
    const startPrice = startMap[code];
    if (startPrice && endPrice) {
      changes.push({ code, changePct: (endPrice - startPrice) / startPrice });
    }
  }
  changes.sort((a, b) => b.changePct - a.changePct);

  const newsRows = db.all(
    `SELECT title, news_type, visible_sentiment FROM news
     WHERE created_tick > ${startTick} AND created_tick <= ${tick} AND is_rumor = 0
     ORDER BY impact_magnitude DESC LIMIT 5;`
  );

  let userSnapshot = null;
  if (userId) {
    const user = db.get(`SELECT * FROM users WHERE id = ${db.q(userId)};`);
    if (user) {
      const holdings = db.all(`SELECT * FROM holdings WHERE user_id = ${db.q(userId)};`);
      let holdingValue = 0;
      for (const h of holdings) {
        const latestPrice = endMap[h.stock_code] || h.avg_cost;
        holdingValue += h.quantity * latestPrice;
      }
      userSnapshot = {
        cash: user.cash, holding_value: Number(holdingValue.toFixed(2)),
        total_asset: Number((user.cash + holdingValue).toFixed(2))
      };
    }
  }

  const gainers = changes.filter((item) => item.changePct > 0).slice(0, 3);
  const losers = changes.filter((item) => item.changePct < 0)
    .sort((a, b) => a.changePct - b.changePct)
    .slice(0, 3);

  const report = {
    tick, start_tick: startTick,
    top_gainers: gainers.map(c => ({ code: c.code, change_pct: Number(c.changePct.toFixed(4)) })),
    top_losers: losers.map(c => ({ code: c.code, change_pct: Number(c.changePct.toFixed(4)) })),
    important_news: newsRows,
    user_snapshot: userSnapshot
  };

  db.exec(`INSERT INTO weekly_reports (tick, start_tick, top_gainers, top_losers, important_news, user_snapshot, created_at)
    VALUES (${tick}, ${startTick}, ${db.q(JSON.stringify(report.top_gainers))},
      ${db.q(JSON.stringify(report.top_losers))}, ${db.q(JSON.stringify(report.important_news))},
      ${db.q(JSON.stringify(report.user_snapshot))}, datetime('now'));`);

  return report;
}

function getNewsForStock(stockCode, stockIndustry, currentTick, limit = 10) {
  return db.all(
    `SELECT * FROM news WHERE published = 1 AND created_tick <= ${currentTick}
     AND (
       target_code = ${db.q(stockCode)}
       OR (target_type = 'industry' AND target_code = ${db.q(stockIndustry)})
     )
     ORDER BY created_tick DESC LIMIT ${limit};`
  );
}

function getActiveNews(currentTick) {
  return db.all(
    `SELECT * FROM news WHERE published = 1 AND created_tick = ${currentTick}
     ORDER BY id DESC;`
  );
}

function getWeeklyReport(tick) {
  return db.get(`SELECT * FROM weekly_reports WHERE tick = ${tick};`);
}

function getLatestWeeklyReport(currentTick) {
  return db.get(`SELECT * FROM weekly_reports ORDER BY tick DESC LIMIT 1;`) || null;
}

function getNewsByTick(tick) {
  return db.all(
    `SELECT * FROM news WHERE published = 1 AND created_tick = ${tick}
     ORDER BY id DESC;`
  );
}

function getAvailableNewsTicks(currentTick) {
  if (currentTick <= 1) return [];
  return db.all(
    `SELECT DISTINCT created_tick FROM news WHERE published = 1 AND created_tick < ${currentTick}
     ORDER BY created_tick DESC;`
  ).map(r => r.created_tick);
}

module.exports = {
  generateNews, calculateNewsImpact, calculateRealNewsImpactIncrement, checkAndGenerateRumors, clampCombinedImpact,
  generateDailyReport, generateWeeklyReport, getNewsForStock, getActiveNews, getWeeklyReport, getLatestWeeklyReport,
  getNewsByTick, getAvailableNewsTicks,
  INDUSTRY_CHAIN, CHAIN_LINKAGE, NEWS_IMPACT
};

const db = require('./db');

let _roster = null;
function getRoster() {
  if (!_roster) _roster = require('./kol-roster.json');
  return _roster;
}

let _templates = null;
function getTemplates() {
  if (!_templates) _templates = require('./kol-templates.json');
  return _templates;
}

function randomBetween(min, max) { return min + Math.random() * (max - min); }
function randomInt(min, max) { return Math.floor(randomBetween(min, max + 1)); }
function pickRandom(arr) { return arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null; }

const NEUTRAL_PROBABILITY = 0.12;

const TRACK_LABELS = { commodity: '大宗商品', crypto: '加密货币', index: '股指期货', fx: '外汇期货' };

function trackToLabel(track) { return TRACK_LABELS[track] || track; }

function truthDirection(truthType) {
  const map = {
    real_bullish: +1,
    real_bearish: -1,
    fake_bullish: -1,
    fake_bearish: +1
  };
  return map[truthType] || 0;
}

function dirToStance(dir) {
  if (dir > 0) return 'bullish';
  if (dir < 0) return 'bearish';
  return 'neutral';
}

function sentimentStance(visibleSentiment) {
  if (visibleSentiment === 'bullish') return 'bullish';
  if (visibleSentiment === 'bearish') return 'bearish';
  return 'neutral';
}

function pickDomainForKol(kol) {
  const w = kol.domain_weights || { stock: 1.0 };
  const total = (w.stock || 0) + (w.futures || 0) + (w.fund || 0);
  if (total <= 0) return 'stock';
  let r = Math.random() * total;
  for (const [domain, weight] of Object.entries(w)) {
    r -= weight;
    if (r <= 0) return domain;
  }
  return 'stock';
}

function weightedPickDistinct(kols, count) {
  const pool = kols.map(k => ({ kol: k, w: k.weight }));
  const selected = [];
  const remaining = [...pool];
  for (let i = 0; i < count && remaining.length > 0; i++) {
    const totalWeight = remaining.reduce((s, r) => s + r.w, 0);
    let r = Math.random() * totalWeight;
    let picked = remaining[remaining.length - 1];
    for (const entry of remaining) {
      r -= entry.w;
      if (r <= 0) { picked = entry; break; }
    }
    selected.push(picked.kol);
    remaining.splice(remaining.indexOf(picked), 1);
  }
  return selected;
}

function rollHit(probability) {
  return Math.random() < probability;
}

function getStockNameByCode(stockCode, stocks) {
  const stock = (stocks || []).find(s => s.code === stockCode);
  return stock ? stock.name : stockCode;
}

function getFuturesNameByCode(code, futuresData) {
  const f = (futuresData || []).find(u => u.code === code);
  return f ? f.name : code;
}

function getTargetName(newsItem, stocks, futuresData) {
  if (newsItem.target_type === 'stock') return getStockNameByCode(newsItem.target_code, stocks);
  if (newsItem.target_type === 'futures') return getFuturesNameByCode(newsItem.target_code, futuresData);
  return newsItem.target_code;
}

function resolveFundAnchor(fund, activeRealNews, stocks, futuresData) {
  if (!fund || !fund.basket_json) return null;
  try {
    const basket = typeof fund.basket_json === 'string' ? JSON.parse(fund.basket_json) : fund.basket_json;
    if (!basket) return null;

    if (basket.all === true) {
      const dir = netRealDirection('大盘', 'market', activeRealNews, stocks, futuresData);
      return { scope: fund.name, scopeKind: 'fund_sector', anchorDir: dir, scopeName: fund.name };
    }
    if (basket.by === 'risk' && basket.value === 'low') {
      const dir = netRealDirection('大盘', 'market', activeRealNews, stocks, futuresData);
      return { scope: fund.name, scopeKind: 'fund_sector', anchorDir: dir, scopeName: fund.name };
    }
    if (basket.by === 'sector' && basket.value) {
      const dir = netRealDirection(basket.value, 'industry', activeRealNews, stocks, futuresData);
      return { scope: fund.name, scopeKind: 'fund_sector', anchorDir: dir, scopeName: fund.name };
    }
  } catch (e) { /* ignore */ }
  return null;
}

function getGoldFundAnchor(activeRealNews, stocks, futuresData) {
  if (!futuresData) return null;
  const dir = netRealDirection('黄金', 'futures', activeRealNews, stocks, futuresData);
  return { scope: '山海黄金ETF', scopeKind: 'fund_sector', anchorDir: dir, scopeName: '山海黄金ETF' };
}

function pickFundScope(fundsData, activeRealNews, stocks, futuresData) {
  const candidates = [];
  for (const fund of (fundsData || [])) {
    if (fund.code === 'SH03') {
      const anchor = getGoldFundAnchor(activeRealNews, stocks, futuresData);
      if (anchor && anchor.anchorDir !== 0) candidates.push({ anchor });
      continue;
    }
    if (['GD02', 'GD03', 'TY03'].includes(fund.code)) continue;
    const anchor = resolveFundAnchor(fund, activeRealNews, stocks, futuresData);
    if (anchor && anchor.anchorDir !== 0) candidates.push({ anchor });
  }
  return candidates.length ? pickRandom(candidates).anchor : null;
}

function isReviewableNews(newsItem) {
  const type = String(newsItem.truth_type || '');
  if (type === 'ambiguous' || type === 'fluff' || !type.startsWith('real_') && !type.startsWith('fake_')) return false;
  if (newsItem.is_rumor) return false;
  if (!['stock', 'industry', 'futures'].includes(newsItem.target_type)) return false;
  return true;
}

function pickReviewableNews(generatedNews) {
  const candidates = reviewableNewsList(generatedNews);
  return candidates.length ? pickRandom(candidates) : null;
}

function pickReviewableNewsByDomain(generatedNews, domain) {
  const candidates = reviewableNewsList(generatedNews).filter(n => {
    if (domain === 'futures') return n.target_type === 'futures';
    return n.target_type === 'stock' || n.target_type === 'industry';
  });
  return candidates.length ? pickRandom(candidates) : null;
}

function reviewableNewsList(generatedNews) {
  return (generatedNews || []).filter(isReviewableNews);
}

function pickScopeWithRealNews(activeRealNews, stocks, futuresData, domain) {
  const candidates = [];
  const seen = new Set();

  for (const n of activeRealNews) {
    if (domain === 'futures') {
      if (n.target_type === 'futures') {
        const name = getFuturesNameByCode(n.target_code, futuresData);
        if (name && !seen.has(name)) {
          candidates.push({ name, kind: 'futures', scopeKey: 'futures' });
          seen.add(name);
        }
        const fData = (futuresData || []).find(u => u.code === n.target_code);
        const track = fData ? fData.track : null;
        const label = track ? trackToLabel(track) : null;
        if (label && !seen.has('tf-' + label)) {
          candidates.push({ name: label, kind: 'futures_track', scopeKey: 'futures_track' });
          seen.add('tf-' + label);
        }
      }
      continue;
    }

    if (n.target_type === 'market' && !seen.has('大盘')) {
      candidates.push({ name: '大盘', kind: 'market', scopeKey: 'market' });
      seen.add('大盘');
    } else if (n.target_type === 'industry' && !seen.has(n.target_code)) {
      candidates.push({ name: n.target_code, kind: 'industry', scopeKey: 'sector' });
      seen.add(n.target_code);
    } else if (n.target_type === 'stock') {
      const stock = (stocks || []).find(s => s.code === n.target_code);
      const industry = stock ? stock.industry : null;
      if (industry && !seen.has(industry)) {
        candidates.push({ name: industry, kind: 'industry', scopeKey: 'sector' });
        seen.add(industry);
      }
    }
  }

  return candidates.length ? pickRandom(candidates) : null;
}

function netRealDirection(scopeName, scopeKind, activeRealNews, stocks, futuresData) {
  let sum = 0;
  for (const n of activeRealNews) {
    if (scopeKind === 'futures' && n.target_type === 'futures') {
      const name = getFuturesNameByCode(n.target_code, futuresData);
      if (name === scopeName) sum += truthDirection(n.truth_type);
    } else if (scopeKind === 'futures_track' && n.target_type === 'futures') {
      const fData = (futuresData || []).find(u => u.code === n.target_code);
      const track = fData ? fData.track : null;
      if (track && trackToLabel(track) === scopeName) sum += truthDirection(n.truth_type);
    } else if (scopeKind === 'market' && n.target_type === 'market' && scopeName === '大盘') {
      sum += truthDirection(n.truth_type);
    } else if (scopeKind === 'industry' && n.target_type === 'industry' && n.target_code === scopeName) {
      sum += truthDirection(n.truth_type);
    } else if (scopeKind === 'industry' && n.target_type === 'stock') {
      const stock = (stocks || []).find(s => s.code === n.target_code);
      if (stock && stock.industry === scopeName) sum += truthDirection(n.truth_type);
    }
  }
  return sum;
}

function fillTemplate(kol, commentType, stance, vars) {
  const templates = getTemplates();

  const personalMap = templates.personal_templates || {};
  const personal = personalMap[kol.id];
  if (personal && personal.templates && personal.templates.length) {
    const candidates = personal.templates.filter(t => t.type === commentType && t.stance === stance);
    if (candidates.length) {
      let text = pickRandom(candidates).text;
      text = applyVars(text, vars);
      return maybeAppendCatchphrase(text, kol.tier, commentType);
    }
  }

  let scopeKey = vars.stock_scope || 'stock';
  if (commentType !== 'review') {
    scopeKey = vars.scopeKey || ((vars.scope === '大盘') ? 'market' : 'sector');
  }

  const tierTemplates = templates.tier_templates || {};
  const tierBlock = tierTemplates[kol.tier];
  if (!tierBlock || !tierBlock[commentType] || !tierBlock[commentType][stance]) {
    return fallbackText(stance, vars);
  }

  const scopeTemplates = tierBlock[commentType][stance][scopeKey];
  const chosen = scopeTemplates && scopeTemplates.length ? pickRandom(scopeTemplates) : null;
  if (!chosen) return fallbackText(stance, vars);

  let text = applyVars(chosen, vars);
  text = maybeAppendCatchphrase(text, kol.tier, commentType);
  return text;
}

function applyVars(text, vars) {
  let result = String(text || '');
  if (vars.target_name) result = result.replace(/\{target_name\}/g, vars.target_name);
  if (vars.stock_name) result = result.replace(/\{stock_name\}/g, vars.stock_name);
  if (vars.target_name && !vars.stock_name) result = result.replace(/\{stock_name\}/g, vars.target_name);
  if (vars.scope) result = result.replace(/\{scope\}/g, vars.scope);
  if (vars.N !== undefined) result = result.replace(/\{N\}/g, String(vars.N));
  return result;
}

function maybeAppendCatchphrase(text, tier, commentType) {
  if (tier === 'pro' && commentType === 'review') return text;
  const templates = getTemplates();
  const pool = templates.variable_pool?.catchphrase_suffix;
  if (!pool || !pool[tier] || !pool[tier].length) return text;
  if (Math.random() < 0.35) {
    return text + ' ' + pickRandom(pool[tier]);
  }
  return text;
}

function fallbackText(stance, vars) {
  const scope = vars.scope || vars.stock_name || vars.target_name || '市场';
  console.warn('[kol] fallbackText triggered — template bucket empty for stance=' + stance + ' scope=' + scope);
  const map = {
    bullish: '看好' + scope,
    bearish: '谨慎看待' + scope,
    neutral: scope + '方向尚不明朗'
  };
  return map[stance] || scope + '方向不确定';
}

function buildRow(kol, tick, commentType, targetNewsId, targetScope, stance, correct, content) {
  return {
    tick, kol_id: kol.id, kol_name: kol.name, tier: kol.tier,
    comment_type: commentType, target_news_id: targetNewsId, target_scope: targetScope,
    stance, is_correct: correct, content
  };
}

function buildReviewRow(kol, tick, newsTarget, stocks, futuresData) {
  const truthDir = truthDirection(newsTarget.truth_type);
  if (truthDir === 0) return null;

  const isFake = String(newsTarget.truth_type).startsWith('fake');
  let correct, stance;

  if (isFake) {
    const sawThrough = rollHit(kol.seethrough);
    correct = sawThrough ? 1 : 0;
    stance = sawThrough ? dirToStance(truthDir) : sentimentStance(newsTarget.visible_sentiment);
  } else {
    correct = rollHit(kol.accuracy) ? 1 : 0;
    stance = correct ? dirToStance(truthDir) : dirToStance(-truthDir);
  }

  let stockScope = 'stock';
  if (newsTarget.target_type === 'industry') stockScope = 'sector';
  else if (newsTarget.target_type === 'futures') stockScope = 'futures';

  const contentVars = {
    target_name: getTargetName(newsTarget, stocks, futuresData),
    stock_name: getTargetName(newsTarget, stocks, futuresData),
    N: '{N}',
    stock_scope: stockScope
  };
  const content = fillTemplate(kol, 'review', stance, contentVars);
  return buildRow(kol, tick, 'review', newsTarget.id, null, stance, correct, content);
}

function generateKolComments(tick, generatedNews, activeRealNews, stocks, futuresData, fundsData) {
  const roster = getRoster();
  if (!roster.kols || !roster.kols.length) return [];

  const count = randomInt(3, 6);
  const speakers = weightedPickDistinct(roster.kols, count);
  const rows = [];

  for (const kol of speakers) {
    const domain = pickDomainForKol(kol);
    let type, newsTarget, scopeTarget;
    let domainNews, domainScopes;

    type = rollHit(kol.type_bias.review) ? 'review' : 'independent';

    if (rollHit(NEUTRAL_PROBABILITY) && kol.tier !== 'grass') {
      domainNews = pickReviewableNewsByDomain(generatedNews, domain);
      if (!domainNews) domainNews = pickReviewableNews(generatedNews);
      if (domainNews) {
        const stockScope = getStockScope(domainNews);
        const content = fillTemplate(kol, 'review', 'neutral', {
          target_name: getTargetName(domainNews, stocks, futuresData),
          stock_name: getTargetName(domainNews, stocks, futuresData),
          N: '{N}',
          stock_scope: stockScope
        });
        rows.push(buildRow(kol, tick, 'review', domainNews.id, null, 'neutral', null, content));
        continue;
      }
    }

    if (type === 'review') {
      newsTarget = pickReviewableNewsByDomain(generatedNews, domain);
      if (!newsTarget && domain !== 'stock') {
        newsTarget = pickReviewableNewsByDomain(generatedNews, 'stock');
      }
      if (!newsTarget) type = 'independent';
    }

    if (type === 'independent') {
      if (domain === 'fund') {
        const fundAnchor = pickFundScope(fundsData, activeRealNews, stocks, futuresData);
        if (fundAnchor && fundAnchor.anchorDir !== 0) {
          const correct = rollHit(kol.accuracy) ? 1 : 0;
          const stance = correct ? dirToStance(fundAnchor.anchorDir) : dirToStance(-fundAnchor.anchorDir);
          const contentVars = { scope: fundAnchor.scopeName, scopeKey: 'fund_sector' };
          const content = fillTemplate(kol, 'independent', stance, contentVars);
          rows.push(buildRow(kol, tick, 'independent', null, fundAnchor.scopeName, stance, correct, content));
          continue;
        }
        if (fundAnchor && fundAnchor.anchorDir === 0) continue;
        type = 'review';
        newsTarget = pickReviewableNewsByDomain(generatedNews, 'stock');
        if (!newsTarget) continue;
      } else {
        scopeTarget = pickScopeWithRealNews(activeRealNews, stocks, futuresData, domain);
        if (!scopeTarget) {
          type = 'review';
          newsTarget = pickReviewableNewsByDomain(generatedNews, domain);
          if (!newsTarget) newsTarget = pickReviewableNewsByDomain(generatedNews, 'stock');
          if (!newsTarget) continue;
        }
      }
    }

    if (type === 'review') {
      if (newsTarget) {
        const row = buildReviewRow(kol, tick, newsTarget, stocks, futuresData);
        if (row) rows.push(row);
      }
    } else {
      if (!scopeTarget) continue;
      const anchorDir = netRealDirection(scopeTarget.name, scopeTarget.kind, activeRealNews, stocks, futuresData);
      if (anchorDir === 0) {
        const fallbackNews = pickReviewableNewsByDomain(generatedNews, 'stock');
        if (fallbackNews) {
          const row = buildReviewRow(kol, tick, fallbackNews, stocks, futuresData);
          if (row) rows.push(row);
        }
        continue;
      }
      const correct = rollHit(kol.accuracy) ? 1 : 0;
      const stance = correct ? dirToStance(anchorDir) : dirToStance(-anchorDir);
      const contentVars = { scope: scopeTarget.name, scopeKey: scopeTarget.scopeKey || 'sector' };
      const content = fillTemplate(kol, 'independent', stance, contentVars);
      rows.push(buildRow(kol, tick, 'independent', null, scopeTarget.name, stance, correct, content));
    }
  }

  if (rows.length === 0) {
    const reviewable = reviewableNewsList(generatedNews);
    if (reviewable.length) {
      const newsTarget = pickRandom(reviewable);
      if (newsTarget) {
        const kol = pickRandom(roster.kols.filter(k => k.tier === 'grass'));
        if (kol) {
          const row = buildReviewRow(kol, tick, newsTarget, stocks, futuresData);
          if (row) rows.push(row);
        }
      }
    }
  }

  if (rows.length) {
    const placeholders = rows.map(r =>
      `(${r.tick},${db.q(r.kol_id)},${db.q(r.kol_name)},${db.q(r.tier)},${db.q(r.comment_type)},${r.target_news_id || 'NULL'},${r.target_scope ? db.q(r.target_scope) : 'NULL'},${db.q(r.stance)},${r.is_correct === null ? 'NULL' : (r.is_correct ? 1 : 0)},${db.q(r.content)},datetime('now'))`
    ).join(',');
    db.exec(`INSERT INTO kol_comments (tick,kol_id,kol_name,tier,comment_type,target_news_id,target_scope,stance,is_correct,content,created_at) VALUES ${placeholders};`);
  }

  return rows;
}

function getStockScope(newsItem) {
  if (newsItem.target_type === 'industry') return 'sector';
  if (newsItem.target_type === 'futures') return 'futures';
  return 'stock';
}

function getActiveKolComments(tick) {
  return db.all(`SELECT * FROM kol_comments WHERE tick = ${tick} ORDER BY id ASC;`);
}

module.exports = { generateKolComments, getActiveKolComments };

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = path.join(__dirname, 'app.js');
const SOURCE = fs.readFileSync(APP_JS, 'utf8');
const STYLES_CSS = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');

function bootApp(options = {}) {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const storage = new Map();
  const location = { hash: options.hash || '' };
  const history = {
    replaceState(_state, _title, url) {
      const nextUrl = String(url || '');
      const hashIndex = nextUrl.indexOf('#');
      location.hash = hashIndex >= 0 ? nextUrl.slice(hashIndex) : '';
    }
  };
  const appRoot = {
    innerHTML: '',
    addEventListener() {}
  };

  const document = {
    addEventListener(type, handler) {
      documentListeners.set(type, handler);
    },
    getElementById(id) {
      if (id !== 'app') throw new Error(`unexpected root id: ${id}`);
      return appRoot;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };

  const localStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    }
  };

  const context = {
    window: {
      SSB_WEB_CONFIG: { apiBase: '' },
      confirm: () => true,
      localStorage,
      location,
      history,
      addEventListener(type, handler) {
        windowListeners.set(type, handler);
      }
    },
    document,
    localStorage,
    FormData: class FormDataStub {
      get() {
        return '';
      }
    },
    fetch: async () => ({
      ok: true,
      json: async () => ({ code: 0, data: {} })
    }),
    console,
    URLSearchParams,
    Date,
    Math,
    JSON,
    Intl,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Promise,
    RegExp,
    setTimeout,
    clearTimeout,
    setInterval: () => ({ _testStub: true }),
    clearInterval: () => {}
  };

  context.window.document = document;
  context.globalThis = context;

  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: APP_JS });

  const ready = documentListeners.get('DOMContentLoaded');
  if (!ready) throw new Error('DOMContentLoaded handler not registered');
  ready();

  if (!context.window.__SSB_TEST__) {
    throw new Error('missing __SSB_TEST__ hooks');
  }

  return {
    hooks: context.window.__SSB_TEST__,
    location,
    async fireHashChange() {
      const handler = windowListeners.get('hashchange');
      if (handler) await handler();
    },
    html() {
      return appRoot.innerHTML;
    }
  };
}

function buildUser(overrides = {}) {
  return {
    id: 'user_demo',
    username: 'SSBTY',
    nickname: '测试玩家',
    cash: 300000,
    join_tick: 1,
    initial_asset_at_join: 1000000,
    activated_at: '2026-06-01T09:00:00.000Z',
    last_login_at: '2026-06-01T09:00:00.000Z',
    is_admin: false,
    ...overrides
  };
}

function buildClock(overrides = {}) {
  return {
    trading_allowed: true,
    sleeping: false,
    daily_tick_index: 3,
    daily_tick_total: 8,
    next_advance_at: '2026-06-01T04:00:00.000Z',
    server_time: '2026-06-01T03:00:00.000Z',
    ...overrides
  };
}

function testLoginPageRendersCorrectly() {
  const app = bootApp();
  let html = app.html();
  assert.ok(html.includes('输入账号进入市场'), 'login page should show login title');
  assert.ok(html.includes('id="loginUsername"'), 'login page should have username input');
  assert.ok(html.includes('id="loginPassword"'), 'login page should have password input');
  assert.ok(html.includes('没有账号？注册'), 'login page should offer register link');
  assert.ok(!html.includes('ICP备'), 'open-source default should not show deployment filing text');
  assert.ok(!html.includes('公网安备'), 'open-source default should not show public-security filing text');
  assert.ok(html.includes('© 2026 SSB Exchange'), 'login page should show copyright line');

  app.hooks.setState({
    user: buildUser({ username: 'SSB-DEMO', is_admin: true }),
    loginUsername: 'SSB-DEMO'
  });
  app.hooks.clearSession(true);
  app.hooks.render();
  html = app.html();
  assert.ok(!html.includes('value="SSB-DEMO"'), 'logout should not preserve the admin username in the login field');
}

function testFundNavigationAndViewRender() {
  const app = bootApp();
  const fund = {
    code: 'TY01',
    name: '天一成长混合',
    type: 'derived',
    category: '主题',
    manage_mode: 'active',
    manager_name: '施天',
    risk_level: 'high',
    nav: 1.0234,
    change_pct: 0.0123,
    has_performance: true,
    inception_change: 0.0234,
    weights: [{ stock_code: 'SSB005', stock_name: '炬芯科技', weight: 0.35 }],
    history: [{ tick: 1, nav: 1 }, { tick: 2, nav: 1.0234 }]
  };
  app.hooks.setState({
    user: buildUser({ fund_value: 1000 }),
    view: 'funds',
    currentTick: 2,
    market_clock: buildClock(),
    fundsList: [fund],
    fundsStatus: [{ fund_code: fund.code, shares: 100, available_shares: 0, value: 102.34 }],
    selectedFundCode: fund.code,
    selectedFund: fund
  });
  app.hooks.render();
  const html = app.html();
  const marketIndex = html.indexOf('data-view="market"');
  const fundIndex = html.indexOf('data-view="funds"');
  const newsIndex = html.indexOf('data-view="news"');
  assert.ok(marketIndex >= 0 && marketIndex < fundIndex && fundIndex < newsIndex,
    'top navigation order is market, funds, then news');
  assert.ok(html.includes('天一成长混合'), 'fund view renders fund list and detail');
  assert.ok(html.includes('单位净值'), 'fund view labels NAV as unit NAV');
  assert.ok(html.includes('成立以来涨跌 +2.34%'), 'fund view shows inception performance');
  assert.ok(html.includes('上期公开持仓'), 'active fund view labels disclosed holdings as prior-period positions');
  assert.ok(html.includes('查看 1 只持仓'), 'active fund view folds holdings into a shared expander pattern');
  assert.ok(html.includes('申购金额'), 'fund view renders subscription controls');
  assert.ok(html.includes('赎回份额'), 'fund view renders redemption controls');
  assert.ok(html.includes('我的交易记录'), 'fund view renders fund transaction history');
}

function testFundCompositionVariantsRender() {
  const app = bootApp();
  const indexWeights = Array.from({ length: 20 }, (_, index) => ({
    stock_code: `SSB${String(index + 1).padStart(3, '0')}`,
    stock_name: `指数成分${index + 1}`,
    weight: 0.05
  }));
  const indexFund = {
    code: 'GD01',
    name: '广迪20指数',
    type: 'derived',
    category: '指数',
    manage_mode: 'passive',
    manager_name: null,
    risk_level: 'mid',
    nav: 1,
    change_pct: 0,
    has_performance: false,
    inception_change: 0,
    composition_summary: '20 只股票价格加权配置',
    weights: indexWeights,
    history: [{ tick: 1, nav: 1 }]
  };
  app.hooks.setState({
    user: buildUser(),
    view: 'funds',
    currentTick: 1,
    market_clock: buildClock(),
    fundsList: [indexFund],
    selectedFundCode: indexFund.code,
    selectedFund: indexFund
  });
  app.hooks.render();
  let html = app.html();
  assert.ok(html.includes('尚未产生首期涨跌'), 'initial fund NAV explains that first-period performance is unavailable');
  assert.ok(html.includes('当前指数成分'), 'passive fund renders its current components');
  assert.ok(!html.includes('12 只股票等权配置，每只约 8.33%'), 'passive fund no longer shows a separate composition summary line');
  assert.ok(html.includes('查看 20 只成分'), 'large passive basket uses the shared expander copy');
  assert.ok(html.includes('指数成分20'), 'passive fund markup still contains the full basket content');

  const blueWeights = Array.from({ length: 6 }, (_, index) => ({
    stock_code: `LOW${index + 1}`,
    stock_name: `蓝筹成分${index + 1}`,
    weight: 1 / 6
  }));
  const blueFund = {
    ...indexFund,
    code: 'SH01',
    name: '山海蓝筹精选',
    category: '蓝筹',
    composition_summary: '6 只股票等权配置，每只约 16.67%',
    weights: blueWeights
  };
  app.hooks.setState({ fundsList: [blueFund], selectedFundCode: blueFund.code, selectedFund: blueFund });
  app.hooks.render();
  html = app.html();
  assert.ok(html.includes('查看 6 只成分'), 'small passive basket now follows the same expander pattern');
  assert.ok(html.includes('蓝筹成分6'), 'small passive basket still includes every component in the markup');

  const overseasFund = {
    ...indexFund,
    code: 'TY03',
    name: '天一全球精选',
    type: 'independent',
    category: '海外',
    asset_description: '模拟海外市场资产，净值独立于本地股票市场变化。',
    weights: []
  };
  app.hooks.setState({ fundsList: [overseasFund], selectedFundCode: overseasFund.code, selectedFund: overseasFund });
  app.hooks.render();
  html = app.html();
  assert.ok(html.includes('资产来源'), 'independent fund renders an asset-source section');
  assert.ok(html.includes('模拟海外市场资产'), 'independent fund explains what drives its NAV');
}

function testTradeFeedbackStaysLocalToEachSurface() {
  const app = bootApp();
  app.hooks.setStocks([
    {
      code: 'SSB001',
      name: '曜琅光能',
      industry: '新能源',
      initial_price: 52,
      volatility: 0.08,
      risk_level: 'high'
    }
  ]);
  app.hooks.setState({
    user: buildUser(),
    view: 'market',
    stockModalOpen: true,
    selectedCode: 'SSB001',
    market_clock: buildClock(),
    prices: [{ stock_code: 'SSB001', close: 52, change_pct: 0.02 }],
    holdings: [{ stock_code: 'SSB001', quantity: 200, available_quantity: 200, avg_cost: 50 }],
    history: [{ tick: 1, close: 50 }, { tick: 2, close: 52 }],
    stock_news: [],
    tradeFeedback: {
      stock: {
        code: 'SSB001',
        buy: { kind: 'success', message: '买入已提交，持仓和现金已刷新。' },
        sell: { kind: 'error', message: '可卖数量不足：当前最多可卖 100 股' }
      },
      fund: { code: null, buy: null, sell: null },
      futures: { code: null, open: null, closeByPositionId: {} }
    }
  });
  app.hooks.render();
  let html = app.html();
  assert.ok(html.includes('trade-feedback-success'), 'stock buy feedback should render with the shared success style');
  assert.ok(html.includes('trade-feedback-error'), 'stock sell feedback should render with the shared error style');
  assert.ok(!html.includes('class="notice">买入已提交，持仓和现金已刷新。'), 'stock trade success should not return to the global top notice area');

  const fund = {
    code: 'TY01',
    name: '天一成长混合',
    type: 'derived',
    category: '主题',
    manage_mode: 'active',
    manager_name: '施天',
    risk_level: 'high',
    nav: 1.0234,
    change_pct: 0.0123,
    has_performance: true,
    inception_change: 0.0234,
    weights: [{ stock_code: 'SSB005', stock_name: '炬芯科技', weight: 0.35 }],
    history: [{ tick: 1, nav: 1 }, { tick: 2, nav: 1.0234 }]
  };
  app.hooks.setState({
    view: 'funds',
    market_clock: buildClock(),
    fundsList: [fund],
    fundsStatus: [{ fund_code: fund.code, shares: 100, available_shares: 0, value: 102.34 }],
    selectedFundCode: fund.code,
    selectedFund: fund,
    tradeFeedback: {
      stock: { code: null, buy: null, sell: null },
      fund: {
        code: fund.code,
        buy: { kind: 'success', message: '基金申购成功。' },
        sell: { kind: 'error', message: '可赎回份额不足' }
      },
      futures: { code: null, open: null, closeByPositionId: {} }
    }
  });
  app.hooks.render();
  html = app.html();
  assert.ok(html.includes('基金申购成功。'), 'fund buy feedback should render inside the fund trade module');
  assert.ok(html.includes('可赎回份额不足'), 'fund sell feedback should render inside the sell form');
  assert.ok(!html.includes('class="notice">基金申购成功。'), 'fund trade success should not leak to the dashboard top notice area');

  const futuresDetail = {
    code: 'QH-AU',
    name: '沪金主连',
    price: 520.5,
    change_pct: 0.018,
    mult: 10,
    maxLeverage: 10,
    minMargin: 520.5,
    prices: [{ tick: 1, price: 510 }, { tick: 2, price: 520.5 }]
  };
  const futuresPosition = {
    id: 'pos_1',
    code: 'QH-AU',
    name: '沪金主连',
    side: 'long',
    leverage: 10,
    contracts: 2,
    entryPrice: 500,
    currentPrice: 520.5,
    unrealizedPnl: 410,
    margin: 1000,
    contractValue: 10000,
    liquidationPrice: 455,
    liquidationDistance: 0.24
  };
  app.hooks.setState({
    view: 'futures',
    market_clock: buildClock(),
    futuresList: [{ code: 'QH-AU', name: '沪金主连', price: 520.5, change_pct: 0.018, maxLeverage: 10, minMargin: 520.5, track: 'commodity' }],
    futuresStatus: {
      positions: [futuresPosition],
      summary: {
        totalMargin: 1000,
        totalUnrealizedPnl: 410,
        futuresValue: 1410,
        remainingExposure: 9000
      }
    },
    selectedFuturesCode: futuresDetail.code,
    selectedFuturesDetail: futuresDetail,
    tradeFeedback: {
      stock: { code: null, buy: null, sell: null },
      fund: { code: null, buy: null, sell: null },
      futures: {
        code: futuresDetail.code,
        open: { kind: 'error', message: '可用资金不足' },
        closeByPositionId: {
          pos_1: { kind: 'success', message: '期货平仓成功。', positionMeta: { name: '沪金主连', side: 'long', leverage: 10, contracts: 2 } }
        }
      }
    }
  });
  app.hooks.render();
  html = app.html();
  assert.ok(html.includes('可用资金不足'), 'futures open feedback should render inside the open-position panel');
  assert.ok(html.includes('期货平仓成功。'), 'futures close feedback should render on the position card');
  assert.ok(html.includes('futures-pos-actions'), 'futures close action should use the dedicated card-level action column');
  assert.ok(!html.includes('class="notice">期货平仓成功。'), 'futures close success should not leak to the dashboard top notice area');
}

function testTradePanelShowsEstimateAndActionHints() {
  const app = bootApp();
  app.hooks.setStocks([
    {
      code: 'SSB001',
      name: '曜琅光能',
      industry: '新能源',
      initial_price: 52,
      volatility: 0.08,
      risk_level: 'high'
    }
  ]);
  app.hooks.setState({
    user: buildUser(),
    view: 'market',
    stockModalOpen: true,
    selectedCode: 'SSB001',
    market_clock: buildClock({ trading_allowed: false }),
    prices: [{ stock_code: 'SSB001', close: 52, change_pct: 0.02 }],
    holdings: [
      {
        stock_code: 'SSB001',
        quantity: 300,
        available_quantity: 200,
        avg_cost: 50
      }
    ],
    history: [
      { tick: 1, close: 50 },
      { tick: 2, close: 52 }
    ],
    selected_trade_activity: {
      stock_code: 'SSB001',
      window_size: 5,
      total_lots: 42,
      total_amount: 187000
    },
    stock_news: []
  });
  app.hooks.render();

  const html = app.html();
  assert.ok(html.includes('stock-detail-layout'), 'stock detail should render the desktop layout container');
  assert.ok(!html.includes('modal-close'), 'stock detail should not render a close button');
  assert.ok(html.includes('detail-info-column'), 'stock detail should render the stock info column');
  assert.ok(html.includes('detail-trade-column'), 'stock detail should render the trade column');
  assert.ok(html.includes('trade-panel trade-panel-locked'), 'closed market should mark the trade panel as locked');
  assert.ok(html.includes('trade-closed'), 'closed market should render the closed-market notice');
  assert.ok(!html.includes('当前封盘，开盘后才可买入。'), 'closed market should not repeat the locked-state reason in the buy column');
  assert.equal((html.match(/trade-tip-slot/g) || []).length, 2, 'closed market should keep both empty trade tip slots');
  assert.ok(!html.includes('trade-tip-slot has-tip'), 'closed market tip slots should stay empty');
  assert.ok(html.includes('detail-news-column'), 'stock detail should render the news column');
  assert.ok(html.includes('detail-quote-inline'), 'stock price and change should render inline beside the stock title');
  assert.ok(html.includes('按当前价 52.00 / 股'), 'trade panel should show current price context');
  assert.ok(html.includes('账户余额'), 'buy side should show account cash balance');
  assert.ok(html.includes('300,000.00'), 'buy side should show the current account cash amount');
  assert.ok(html.includes('本股最多可买金额'), 'buy side should show max affordable amount for this stock');
  assert.ok(html.includes('当前持有市值'), 'sell side should show current holding market value');
  assert.ok(html.includes('15,600.00'), 'sell side should show current holding market value amount');
  assert.ok(html.includes('最多可卖到账'), 'sell side should show available sell amount');
  assert.ok(html.includes('10,389.60'), 'sell side should show available sell amount after fee');
  assert.ok(html.includes('持仓 300 股 · 可卖 200 股'), 'sell side should keep share quantity as supporting detail');
  assert.ok(html.includes('预计支出'), 'buy side should show estimated cost copy');
  assert.ok(html.includes('约 5.2 万'), 'quick buy action should show a compact estimated amount');
  assert.ok(html.includes('买 10 万'), 'buy side should offer a larger amount shortcut');
  assert.ok(html.includes('买 20 万'), 'buy side should offer a heavy amount shortcut');
  assert.ok(html.includes('买 30 万'), 'buy side should offer a max-cap amount shortcut');
  assert.ok(html.includes('自定义买入金额'), 'buy side should offer custom amount input');
  assert.ok(html.includes('自定义卖出金额'), 'sell side should offer custom amount input');
  assert.ok(!html.includes('自定义余额%'), 'buy side should not show custom cash percent input');
  assert.ok(!html.includes('自定义可卖%'), 'sell side should not show custom sell percent input');
  assert.ok(html.includes('若跨整点切到新一期'), 'trade panel should explain that stale quotes require reconfirmation');
  assert.ok(!html.includes('当前未持有这只股票，先买入后才可卖出。'), 'sell side should not show an obvious no-holding warning');
  assert.ok(!html.includes('近 5 期交易手数'), 'detail should not show recent trade lots cards');
  assert.ok(!html.includes('近 5 期交易金额'), 'detail should not show recent trade amount cards');
}

function testOpenTradePanelDoesNotUseLockedLayout() {
  const app = bootApp();
  app.hooks.setStocks([
    {
      code: 'SSB001',
      name: '曜琅光能',
      industry: '新能源',
      initial_price: 52,
      volatility: 0.08,
      risk_level: 'high'
    }
  ]);
  app.hooks.setState({
    user: buildUser(),
    view: 'market',
    stockModalOpen: true,
    selectedCode: 'SSB001',
    market_clock: buildClock({ market_status: 'open', trading_allowed: true }),
    prices: [{ stock_code: 'SSB001', close: 52, change_pct: 0.1 }],
    holdings: [
      {
        stock_code: 'SSB001',
        quantity: 100,
        available_quantity: 100,
        avg_cost: 50
      }
    ],
    history: [
      { tick: 1, close: 50 },
      { tick: 2, close: 52 }
    ],
    stock_news: []
  });
  app.hooks.render();

  const html = app.html();
  assert.ok(html.includes('class="trade-panel"'), 'open market should render the regular trade panel');
  assert.ok(!html.includes('trade-panel-locked'), 'open market should not use the locked trade layout');
  assert.ok(!html.includes('trade-closed'), 'open market should not render the closed-market notice');
  assert.ok(html.includes('该股已涨停，买盘拥挤'), 'open market should show liquidity-limited buy tip for limit-up stock');
  assert.equal((html.match(/trade-tip-slot/g) || []).length, 2, 'open market should render a fixed tip slot for both trade columns');
  assert.equal((html.match(/trade-tip-slot has-tip/g) || []).length, 1, 'limit-up stock should only fill the buy tip slot');

  app.hooks.setState({
    prices: [{ stock_code: 'SSB001', close: 52, change_pct: 0.02 }]
  });
  app.hooks.render();
  const regularHtml = app.html();
  assert.equal((regularHtml.match(/trade-tip-slot/g) || []).length, 2, 'regular stock should keep both trade tip slots');
  assert.ok(!regularHtml.includes('trade-tip-slot has-tip'), 'regular stock should leave both trade tip slots empty');

  app.hooks.setState({
    prices: [{ stock_code: 'SSB001', close: 52, change_pct: -0.1 }]
  });
  app.hooks.render();
  const limitDownHtml = app.html();
  assert.ok(limitDownHtml.includes('该股已跌停，卖盘拥挤'), 'limit-down stock should show liquidity-limited sell tip');
  assert.equal((limitDownHtml.match(/trade-tip-slot has-tip/g) || []).length, 1, 'limit-down stock should only fill the sell tip slot');
}

function testDesktopTradeLayoutSharesHeightViaSubgrid() {
  // The whole stock-detail modal aligns structurally, not via hand-tuned pixel
  // heights. These guards lock in that structure so we never regress to the
  // earlier "patch one height, break another" approach.

  // Buy and sell columns share one set of row tracks (subgrid), so every row
  // (title / context / tip / quick actions / forms) is exactly as tall as the
  // taller side — buttons align across buy/sell regardless of which side shows
  // a 涨停/跌停 tip or how many lines it wraps.
  assert.ok(
    STYLES_CSS.includes('.detail-trade-column .trade-grid {'),
    'desktop buy/sell should live in a dedicated .trade-grid container'
  );
  assert.ok(
    STYLES_CSS.includes('grid-template-columns: repeat(2, minmax(0, 1fr));') &&
      STYLES_CSS.includes('grid-template-rows: subgrid;'),
    'desktop trade grid should align buy/sell row-by-row via subgrid'
  );

  // The closed-market notice sits above the two columns and is styled on
  // desktop (it spans full width naturally as the only banner row).
  assert.ok(
    STYLES_CSS.includes('.detail-trade-column .trade-closed {'),
    'desktop styles should style the closed-market notice above the trade grid'
  );

  // The trade column is the SOLE height driver; the left column must fill that
  // height without contributing its (tall) news content back into the shared
  // row — that is exactly what `height: 0; min-height: 100%` does. Losing this
  // is what lets the news list expand and blank out the trade column.
  assert.ok(
    STYLES_CSS.includes('height: 0;\n    min-height: 100%;'),
    'left detail column should fill the trade column height without inflating the shared row'
  );
  assert.ok(
    STYLES_CSS.includes('grid-template-rows: auto minmax(0, 1fr);'),
    'left column should keep the info card natural-height and let news absorb the rest'
  );
  assert.ok(
    STYLES_CSS.includes('.detail-trade-column {\n    align-self: stretch;'),
    'desktop trade column should align its bottom edge with the left detail column'
  );

  // News height is driven by the layout and scrolls internally, never by the
  // number of news items.
  assert.ok(
    STYLES_CSS.includes('.detail-news-scroll {') && STYLES_CSS.includes('overflow-y: auto;'),
    'news viewport should scroll internally instead of growing with item count'
  );

  // Regressions we must never reintroduce: a fixed pane height, or a fixed
  // tip-slot height that breaks the moment a tip wraps to multiple lines.
  assert.ok(
    !STYLES_CSS.includes('--stock-detail-pane-height: 484px'),
    'stock detail layout should not rely on a fixed overflowing pane height'
  );
  assert.ok(
    !STYLES_CSS.includes('.detail-trade-column .trade-tip-slot {\n    min-height: 44px;'),
    'desktop tip slot should not use a hard-coded height (subgrid equalizes it instead)'
  );
}

function testMobileSportsRankingKeepsNicknameReadable() {
  assert.ok(
    STYLES_CSS.includes(
      '.sports-ranking-header,\n  .sports-ranking-card {\n    grid-template-columns:\n      18px\n      minmax(48px, 1fr)'
    ),
    'mobile sports ranking should reserve readable space for the nickname column'
  );
  assert.ok(
    STYLES_CSS.includes('.sports-ranking-rank,\n  .sports-ranking-val {\n    min-width: 0;'),
    'mobile sports ranking numeric cells should shrink instead of crushing the nickname'
  );
}

function testStockDetailNoHoldingKeepsChartAreaClean() {
  const app = bootApp();
  app.hooks.setStocks([
    {
      code: 'SSB001',
      name: '曜琅光能',
      industry: '新能源',
      initial_price: 52,
      volatility: 0.08,
      risk_level: 'high'
    }
  ]);
  app.hooks.setState({
    user: buildUser(),
    view: 'market',
    stockModalOpen: true,
    selectedCode: 'SSB001',
    market_clock: buildClock(),
    prices: [{ stock_code: 'SSB001', close: 52.34, change_pct: 0.0066 }],
    holdings: [],
    history: [
      { tick: 1, close: 52 },
      { tick: 2, close: 52.34 }
    ],
    stock_news: []
  });
  app.hooks.render();

  const html = app.html();
  assert.ok(html.includes('detail-quote-inline'), 'stock quote should remain in the compact title row');
  assert.ok(!html.includes('当前账户尚未持有这只股票'), 'no-holding copy should not take space in the chart area');
}

function testMarketOverviewEmptyChartUsesOverviewLayoutClass() {
  const app = bootApp();
  app.hooks.setState({
    user: buildUser(),
    view: 'market',
    market_overview: {
      current_index: 958,
      change_pct: 0,
      up_count: 0,
      down_count: 0,
      flat_count: 20,
      history: []
    }
  });
  app.hooks.render();

  const html = app.html();
  assert.ok(html.includes('class="sparkline empty market-chart"'), 'empty market chart should keep the overview layout class');
}

function testSportsViewRendersCoreWorkflow() {
  const app = bootApp();
  const home = { id: 'team-1', code: 'BL01', name: '北京烈焰', championships: 1, stars: 5, wins: 8, losses: 1, recent: ['W', 'W', 'L', 'W', 'W'] };
  const away = { id: 'team-2', code: 'BL02', name: '上海风暴', championships: 0, stars: 3, wins: 5, losses: 4, recent: ['L', 'W', 'L', 'W', 'L'] };
  app.hooks.setState({
    user: buildUser(),
    view: 'sports',
    sportsSection: 'overview',
    sportsOverview: {
      season: { season_no: 1, season_type: 'full', status: 'regular' },
      paused: false,
      next_match_at: '2026-06-08T08:30:00+08:00',
      config: { min_bet: 1000, max_bet_per_match: 100000 },
      teams: [home, away],
      standings: [{ rank: 1, team_id: home.id, team_name: home.name, wins: 2, losses: 0, point_diff: 20 }],
      pending_bets: [],
      latest_results: [],
      matches: [{
        id: 'match-1',
        stage: 'regular',
        round_no: 1,
        scheduled_at: '2026-06-08T08:30:00+08:00',
        status: 'open',
        home_team: home,
        away_team: away,
        market: { status: 'open', home_odds: 1.8, away_odds: 2.1 },
        user_stake: 0
      }]
    },
    sportsStandings: [],
    sportsAccount: { pending_stake: 0, season_pnl: 0, recent_bets: [] },
    selectedSportsTeam: {
      ...home,
      strength: 70,
      players: [{ id: 'p1', name: '林远昂', position: 'G', stars: 5, starter: 1 }],
      standing: null
    }
  });
  app.hooks.render();
  const html = app.html();
  assert.ok(html.includes('data-view="sports"'), 'top navigation should include sports');
  assert.ok(html.includes('SBA 篮球联赛'), 'sports view should show league title');
  assert.ok(html.includes('北京烈焰 1.80'), 'sports view should render fixed home odds');
  assert.ok(html.includes('★★★★★') && html.includes('★★★☆☆'), 'sports betting card should show both team star ratings');
  assert.ok(html.includes('8 胜 1 负'), 'sports betting card should show overall record');
  assert.ok(html.includes('星级代表当前阵容基础实力；赔率还包含近期状态与主场优势。'),
    'sports overview should explain the difference between stars and odds');
  assert.ok(html.includes('<span>可用资金</span><strong>300,000.00</strong>'), 'sports overview should render available cash');
  assert.ok(!html.includes('<span>竞猜限额</span>'), 'sports overview should no longer render the betting limit stat');
  assert.ok(!html.includes('单日上限'), 'sports view should not introduce a daily betting limit');
}

function testSportsBettingUsesConfirmationAndFailureDialogs() {
  assert.ok(SOURCE.includes("title: '确认单场竞猜'"), 'regular match betting should request confirmation');
  assert.ok(SOURCE.includes("title: '确认系列赛竞猜'"), 'series betting should request confirmation');
  assert.ok(SOURCE.includes('下注成功后赔率锁定，不受后续阵容变化影响。'), 'sports confirmation should explain locked odds');
  assert.ok(!SOURCE.includes('赔率随阵容实时浮动，以结算时为准'), 'sports confirmation should not claim locked odds will float');
  assert.ok(SOURCE.includes("title: '投注失败'"), 'sports betting failures should use a visible dialog');
  assert.ok(SOURCE.includes('alertOnly: true'), 'sports betting failure dialog should use a single acknowledgement action');
  const escapeHandler = SOURCE.slice(SOURCE.indexOf("if (event.key === 'Escape')"), SOURCE.indexOf("if ((event.key === 'Enter'"));
  assert.ok(escapeHandler.indexOf('dismissConfirm(false)') < escapeHandler.indexOf('state.sportsSeriesBetModal'),
    'Escape should close the top confirmation dialog before the underlying series modal');
}

function testSportsBetButtonsLockDuringPendingRequest() {
  const app = bootApp();
  const home = { id: 'team-1', code: 'BL01', name: '北京烈焰', championships: 1 };
  const away = { id: 'team-2', code: 'BL02', name: '上海风暴', championships: 0 };
  app.hooks.setState({
    user: buildUser(),
    view: 'sports',
    sportsSection: 'overview',
    sportsOverview: {
      season: { season_no: 1, season_type: 'full', status: 'regular' },
      paused: false,
      next_match_at: '2026-06-08T08:30:00+08:00',
      config: { min_bet: 1000, max_bet_per_match: 100000 },
      teams: [home, away],
      standings: [],
      pending_bets: [],
      latest_results: [],
      matches: [{
        id: 'match-lock-test',
        stage: 'regular',
        round_no: 1,
        scheduled_at: '2026-06-08T08:30:00+08:00',
        status: 'open',
        home_team: home,
        away_team: away,
        market: { status: 'open', home_odds: 1.8, away_odds: 2.1 },
        user_stake: 0
      }]
    },
    sportsStandings: [],
    sportsAccount: { pending_stake: 0, season_pnl: 0, recent_bets: [] },
    sportsPendingBets: { 'match-lock-test': { clientRequestId: 'abc', selectionTeamId: home.id, amount: 1000 } }
  });
  app.hooks.render();
  const html = app.html();
  assert.ok(html.includes('aria-busy="true"'), 'pending bet should mark buttons as aria-busy');
  assert.ok(html.includes('提交中…'), 'pending bet should show 提交中 label');
  assert.ok(html.includes('竞猜提交中，请稍候'), 'pending bet should show friendly hint');
  assert.ok(html.includes('disabled'), 'pending bet should disable buttons');
  assert.ok(/<input[^>]*disabled/.test(html), 'pending bet should disable the amount input');
}

function testSportsTabUsesAriaSelectedAndRole() {
  const app = bootApp();
  app.hooks.setState({
    user: buildUser(),
    view: 'sports',
    sportsSection: 'teams',
    sportsOverview: {
      season: { season_no: 1, season_type: 'full', status: 'regular' },
      paused: false,
      next_match_at: '2026-06-08T08:30:00+08:00',
      config: { min_bet: 1000, max_bet_per_match: 100000 },
      teams: [],
      standings: [],
      pending_bets: [],
      latest_results: [],
      matches: []
    },
    sportsStandings: [],
    sportsAccount: { pending_stake: 0, season_pnl: 0, recent_bets: [] }
  });
  app.hooks.render();
  const html = app.html();
  assert.ok(html.includes('role="tablist"'), 'sports tab bar should expose role=tablist');
  assert.ok(html.includes('role="tab"'), 'each sports tab should expose role=tab');
  const ariaTrueCount = (html.match(/aria-selected="true"/g) || []).length;
  const ariaFalseCount = (html.match(/aria-selected="false"/g) || []).length;
  assert.ok(ariaTrueCount === 1, `应该有且仅有一个 tab 处于 aria-selected=true，实际 ${ariaTrueCount}`);
  assert.ok(ariaFalseCount >= 4, `其余 tab 应处于 aria-selected=false，实际 ${ariaFalseCount}`);
  const teamsIdx = html.indexOf('data-section="teams"');
  const teamsSelection = html.slice(teamsIdx, teamsIdx + 300).match(/aria-selected="(true|false)"/);
  assert.ok(teamsSelection && teamsSelection[1] === 'true',
    '当前 section 应为 aria-selected=true');
}

function testSportsTimeTabsAndSettledBetResult() {
  const app = bootApp();
  const home = { id: 'team-1', name: '北京龙焰' };
  const away = { id: 'team-2', name: '上海飓风' };
  app.hooks.setState({
    user: buildUser(),
    view: 'sports',
    sportsSection: 'overview',
    sportsOverview: {
      season: { season_no: 1, season_type: 'full', status: 'regular' },
      config: { min_bet: 1000, max_bet_per_match: 100000 },
      teams: [home, away],
      standings: [],
      pending_bets: [],
      latest_results: [],
      matches: [{
        id: 'settled-1',
        stage: 'regular',
        round_no: 1,
        scheduled_at: '2026-06-08T09:30:00+08:00',
        status: 'settled',
        home_team: home,
        away_team: away,
        home_score: 108,
        away_score: 99,
        user_bet_summaries: [{
          selection_team_id: home.id,
          selection_team_name: home.name,
          status: 'won',
          amount: 2000,
          payout: 3600,
          pnl: 1600,
          bet_count: 2
        }]
      }, {
        id: 'open-1',
        stage: 'quarterfinal',
        game_no: 1,
        scheduled_at: '2026-06-08T13:30:00+08:00',
        status: 'open',
        home_team: home,
        away_team: away,
        market: { status: 'open', home_odds: 1.8, away_odds: 2.1 },
        user_bet_summaries: []
      }]
    },
    sportsAccount: { pending_stake: 0, season_pnl: 0, recent_bets: [] },
    sportsPendingBets: {}
  });
  app.hooks.render();
  const html = app.html();
  assert.ok(html.includes('data-time="09:30"') && html.includes('data-time="13:30"'), '应按实际场次生成时间标签');
  assert.ok(html.includes('八强赛 · G1'), '季后赛单场应继续使用比赛卡片并标注 G');
  const homeButton = html.indexOf('北京龙焰 1.80');
  const amountInput = html.indexOf('aria-label="竞猜金额"');
  const awayButton = html.indexOf('上海飓风 2.10');
  assert.ok(homeButton < amountInput && amountInput < awayButton, '下注区顺序应为球队1赔率-输入框-球队2赔率');

  app.hooks.setState({ sportsTimeKey: '09:30' });
  app.hooks.render();
  const settledHtml = app.html();
  assert.ok(settledHtml.includes('获胜 · 盈利 +1,600.00'), '已结束比赛应显示红色获胜盈利');
}

function testSportsPlayoffBracketSeriesBettingKeepsCardCompact() {
  const app = bootApp();
  const home = { id: 'team-1', name: '北京龙焰', stars: 5, wins: 23, losses: 7, recent: ['W', 'W', 'W', 'L', 'W'] };
  const away = { id: 'team-8', name: '重庆飞鹰', stars: 2, wins: 15, losses: 15, recent: ['L', 'W', 'L', 'L', 'W'] };
  app.hooks.setState({
    user: buildUser(),
    view: 'sports',
    sportsSection: 'playoffs',
    sportsOverview: {
      season: { season_no: 1, season_type: 'full', status: 'quarterfinal' },
      config: {},
      teams: [home, away],
      standings: [],
      matches: [],
      pending_bets: [],
      latest_results: []
    },
    sportsPlayoffs: {
      season: { season_no: 1, season_type: 'full', status: 'quarterfinal' },
      series: [{
        id: 'series-qf-1',
        stage: 'quarterfinal',
        bracket_slot: 1,
        home_team: home,
        away_team: away,
        home_wins: 1,
        away_wins: 0,
        status: 'active',
        market: { status: 'open', home_odds: 1.81, away_odds: 2.0 },
        user_stake: 1000,
        user_bet_summaries: [{ selection_team_id: home.id, status: 'pending', amount: 1000 }],
        matches: [{ game_no: 1, status: 'open', scheduled_at: '2026-06-25T09:30:00+08:00', home_score: 108, away_score: 99 }]
      }]
    },
    sportsAccount: { pending_stake: 1000, season_pnl: 0, recent_bets: [] },
    sportsPendingSeriesBets: {}
  });
  app.hooks.render();
  let html = app.html();
  assert.ok(!html.includes('树状图仅展示系列赛大比分'), '旧提示文案应删除');
  assert.ok(html.includes('北京龙焰') && html.includes('重庆飞鹰'));
  assert.ok(html.includes('G1 · 06/25 09:30'), 'G1 开赛前卡片应显示截止时间');
  assert.ok(html.includes('data-action="sports-series-open"'), '开放系列赛卡片应可点击');
  assert.ok(html.includes('class="sports-series-odds">1.81</small><small class="sports-series-stake">已投 1,000.00</small>'),
    '已投金额应作为赔率后的独立品牌金标签展示');
  assert.ok(html.includes('class="sports-series-odds">2.00</small>'), '未投注队伍仍应展示蓝色赔率标签');
  assert.ok(!html.includes('108 : 99'), '季后赛树状图不得展示单场比分');

  app.hooks.setState({ sportsSeriesBetModal: { seriesId: 'series-qf-1' } });
  app.hooks.render();
  html = app.html();
  assert.ok(html.includes('竞猜整个系列赛的胜者，不是单场比赛结果。'));
  assert.ok(html.includes('23 胜 7 负'), '系列赛投注弹窗应展示球队战绩');
  assert.ok(html.includes('★★★★★') && html.includes('★★☆☆☆'), '系列赛投注弹窗应展示双方星级');
  assert.ok(html.includes('G1 开赛时间：06/25 09:30'));
  const homeButton = html.indexOf('北京龙焰 1.81');
  const amountInput = html.indexOf('aria-label="系列赛竞猜金额"');
  const awayButton = html.indexOf('重庆飞鹰 2.00');
  assert.ok(homeButton < amountInput && amountInput < awayButton, '系列赛弹窗应复用常规比赛的球队-金额-球队投注顺序');

  app.hooks.setState({
    sportsSeriesBetModal: null,
    sportsPlayoffs: {
      ...app.hooks.getState().sportsPlayoffs,
      series: [{
        ...app.hooks.getState().sportsPlayoffs.series[0],
        market: { status: 'locked', home_odds: 1.81, away_odds: 2.0 },
        matches: [{ game_no: 1, status: 'settled', scheduled_at: '2026-06-25T09:30:00+08:00' }]
      }]
    }
  });
  app.hooks.render();
  html = app.html();
  assert.ok(!html.includes('G1 · 06/25 09:30'), 'G1 开始后卡片应恢复系列赛状态文案');
  assert.ok(!html.includes('data-action="sports-series-open"'), 'G1 开始后卡片不可继续投注');

  app.hooks.setState({
    sportsPlayoffs: {
      ...app.hooks.getState().sportsPlayoffs,
      series: [{
        ...app.hooks.getState().sportsPlayoffs.series[0],
        status: 'completed',
        winner_team: home,
        market: { status: 'settled', home_odds: 1.81, away_odds: 2.0 }
      }]
    }
  });
  app.hooks.render();
  html = app.html();
  assert.ok(html.includes('sports-bracket-team-name sports-winner">北京龙焰</span>'), '系列赛胜者应加粗显示为品牌蓝');
  assert.ok(html.includes('sports-bracket-team-name sports-loser">重庆飞鹰</span>'), '系列赛败者应显示为灰色');
  assert.ok(!html.includes('sports-win-star'), '系列赛树状图完赛状态不应增加胜者星标');
}

function testAdminSportsAuditExposesStrengthAndOdds() {
  const app = bootApp();
  const home = { id: 'team-1', code: 'BL01', name: '北京烈焰', championships: 1 };
  const away = { id: 'team-2', code: 'BL02', name: '上海风暴', championships: 0 };
  app.hooks.setState({
    user: buildUser({ username: 'SSB-ADMIN', is_admin: true }),
    view: 'admin',
    adminSections: { sports: true },
    admin: {
      sports: {
        season: { season_no: 1, season_type: 'full', status: 'regular' },
        paused: false,
        totals: { staked: 1000, paid: 0, refunded: 0 },
        config: {
          house_edge: 0.05,
          min_bet: 1000,
          max_bet_per_match: 100000,
          home_advantage: 0.05,
          regular_form_cap: 0.03,
          form_cap: 0.15,
          regular_win_cap: 0.8,
          playoff_win_cap: 0.85,
          regular_scale_factor: 0.07,
          scale_factor: 0.15
        },
        matches: [{
          id: 'audit-match-1',
          stage: 'regular',
          round_no: 1,
          scheduled_at: '2026-06-08T08:30:00+08:00',
          status: 'open',
          home_team: home,
          away_team: away,
          market: { status: 'open', home_odds: 1.8, away_odds: 2.1 },
          user_stake: 0,
          home_strength: 78.5,
          away_strength: 64.2,
          home_win_probability: 0.6,
          away_win_probability: 0.4,
          market_opened_at: '2026-06-08T08:00:00+08:00',
          market_locked_at: null
        }],
        recent_cash_events: [],
        moves: []
      }
    }
  });
  app.hooks.render();
  const html = app.html();
  assert.ok(html.includes('查看审计'), 'admin should expose 查看审计 button');
  assert.ok(html.includes('近期比赛审计快照'), 'admin should expose 近期比赛审计快照 section');
  assert.ok(html.includes('78.5'), 'audit row should show home strength');
  assert.ok(html.includes('64.2'), 'audit row should show away strength');
  assert.ok(html.includes('60.0%'), 'audit row should show home win probability as percent');
  assert.ok(html.includes('1.80'), 'audit row should show locked home odds');
  assert.ok(html.includes('data-action="sports-audit-match"'), 'audit button should fire sports-audit-match action');
  assert.ok(html.includes('常规赛状态上限') && html.includes('季后赛状态上限'),
    'admin sports config should split regular and playoff form caps');
  assert.ok(html.includes('常规赛实力敏感度') && html.includes('季后赛实力敏感度'),
    'admin sports config should split regular and playoff scale factors');
}

function testAdminSectionsAreCollapsedByDefault() {
  const app = bootApp();
  app.hooks.setStocks([
    {
      code: 'SSB001',
      name: '曜琅光能',
      industry: '新能源',
      initial_price: 52,
      volatility: 0.08,
      risk_level: 'high'
    }
  ]);
  app.hooks.setState({
    user: buildUser({ username: 'SSB-ADMIN', nickname: '管理员', is_admin: true }),
    view: 'admin',
    admin: {
      current_tick: 1,
      active_count: 1,
      account_count: 2,
      market_clock: buildClock(),
      stocks: [
        {
          code: 'SSB001',
          name: '曜琅光能',
          industry: '新能源',
          initial_price: 52,
          volatility: 0.08,
          risk_level: 'high'
        }
      ],
      next_stock_code: 'SSB002',
      invites: [
        {
          code: 'INV001',
          nickname: '候选玩家',
          status: 'unused',
          created_at: '2026-06-01T09:00:00.000Z'
        }
      ],
      accounts: [
        buildUser({ username: 'SSB-ADMIN', nickname: '管理员', is_admin: true, total_asset: 1000000 })
      ],
      recent_transactions: [
        {
          type: 'buy',
          nickname: '测试玩家',
          stock_code: 'SSB001',
          tick: 1,
          quantity: 100,
          price: 52,
          created_at: '2026-06-01T09:00:00.000Z'
        }
      ]
    }
  });
  app.hooks.render();

  let html = app.html();
  assert.ok(html.includes('股票管理'), 'admin page should show stock accordion header');
  assert.ok(html.includes('邀请码管理'), 'admin page should show invite accordion header');
  assert.ok(html.includes('账号状态'), 'admin page should show account accordion header');
  assert.ok(html.includes('最近交易'), 'admin page should show recent transaction accordion header');
  assert.ok(!html.includes('新增股票'), 'stock management body should be collapsed by default');
  assert.ok(!html.includes('批量生成'), 'invite management body should be collapsed by default');
  assert.ok(!html.includes('SSB-ADMIN · 管理员'), 'account body should be collapsed by default');
  assert.ok(!html.includes('测试玩家 · 曜琅光能'), 'recent transaction body should be collapsed by default');

  app.hooks.setState({
    adminSections: {
      stocks: true,
      invites: true,
      accounts: true,
      transactions: true
    }
  });
  app.hooks.render();
  html = app.html();
  assert.ok(html.includes('新增股票'), 'stock management body should render when expanded');
  assert.ok(html.includes('批量生成'), 'invite management body should render when expanded');
  assert.ok(html.includes('SSB-ADMIN · 管理员'), 'account body should render when expanded');
  assert.ok(html.includes('测试玩家 · 曜琅光能'), 'recent transaction body should render when expanded');
}

async function testRouteHashRestoresAndUpdatesView() {
  const app = bootApp({ hash: '#admin' });
  app.hooks.setState({
    user: buildUser({ username: 'SSB-ADMIN', nickname: '管理员', is_admin: true }),
    admin: {
      current_tick: 1,
      active_count: 1,
      account_count: 2,
      market_clock: buildClock(),
      stocks: [],
      invites: [],
      accounts: [],
      recent_transactions: []
    }
  });
  app.hooks.render();

  assert.equal(app.hooks.getState().view, 'admin', 'initial route hash should restore the admin view');
  assert.ok(app.html().includes('运营台'), 'admin route should render the operation console');

  await app.hooks.setView('holdings');
  assert.equal(app.location.hash, '#holdings', 'view changes should update the route hash');
  assert.equal(app.hooks.getState().view, 'holdings', 'setView should update state');

  app.location.hash = '#admin';
  await app.hooks.applyRouteView();
  assert.equal(app.hooks.getState().view, 'admin', 'hash route changes should update the active view');
}

async function testAdminRouteFallsBackForNonAdminUsers() {
  const app = bootApp({ hash: '#admin' });
  app.hooks.setState({
    user: buildUser({ is_admin: false }),
    view: 'admin'
  });

  await app.hooks.applyRouteView();

  assert.equal(app.hooks.getState().view, 'market', 'non-admin users should not remain on the admin route');
  assert.equal(app.location.hash, '#market', 'invalid admin route should be replaced with the market route');
}

async function main() {
  testLoginPageRendersCorrectly();
  testFundNavigationAndViewRender();
  testFundCompositionVariantsRender();
  testTradeFeedbackStaysLocalToEachSurface();
  testTradePanelShowsEstimateAndActionHints();
  testOpenTradePanelDoesNotUseLockedLayout();
  testDesktopTradeLayoutSharesHeightViaSubgrid();
  testMobileSportsRankingKeepsNicknameReadable();
  testStockDetailNoHoldingKeepsChartAreaClean();
  testMarketOverviewEmptyChartUsesOverviewLayoutClass();
  testSportsViewRendersCoreWorkflow();
  testSportsBettingUsesConfirmationAndFailureDialogs();
  testSportsBetButtonsLockDuringPendingRequest();
  testSportsTabUsesAriaSelectedAndRole();
  testSportsTimeTabsAndSettledBetResult();
  testSportsPlayoffBracketSeriesBettingKeepsCardCompact();
  testAdminSportsAuditExposesStrengthAndOdds();
  testAdminSectionsAreCollapsedByDefault();
  await testRouteHashRestoresAndUpdatesView();
  await testAdminRouteFallsBackForNonAdminUsers();
  console.log('web render checks ok');
}

main();

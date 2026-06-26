(function () {
  const SESSION_KEY = 'ssb_session_token';
  const ACCOUNT_KEY = 'ssb_username';
  const WEB_CONFIG = window.SSB_WEB_CONFIG || {};
  const API_BASE = WEB_CONFIG.apiBase || '';
  const FILING_CONFIG = WEB_CONFIG.filing || {};
  let STOCKS = [];
  let _clockTimer = null;
  let _lastAutoRefreshKey = null;
  let _activeConfirm = null;
  let _noticeTimer = null;
  let _noticeTimerMessage = '';
  let _tradeFeedbackTimers = new Map();
  let _routeChangeInFlight = false;
  let _suppressNextHashChange = false;
  const NOTICE_TIMEOUT_MS = 4500;
  const VIEW_KEYS = ['market', 'funds', 'futures', 'sports', 'news', 'holdings', 'account', 'loan', 'ranking', 'guide', 'admin'];
  // 期货杠杆档位（与后端 RULES.FUTURES_LEVERAGE_TIERS 对齐）
  const FUTURES_LEVERAGE_TIERS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  // 逐标的默认杠杆（基于 4-tick 均衡缓冲：波动率×4+5%维持率）；默认+1 起为红色危险区
  const FUTURES_DEFAULT_LEVERAGE = {
    'QH-FX': 12, 'QH-IDXV': 9, 'QH-AU': 7, 'QH-SOY': 7,
    'QH-CRA': 6, 'QH-CU': 5, 'QH-CRB': 5, 'QH-IDXG': 5,
    'QH-OIL': 4, 'QH-LI': 3
  };
  const futuresDangerLine = (code) => (FUTURES_DEFAULT_LEVERAGE[code] || 6) + 1;

  const state = {
    loading: false,
    error: '',
    notice: '',
    authStep: 'login',
    loginUsername: localStorage.getItem(ACCOUNT_KEY) || '',
    pendingAccount: null,
    token: localStorage.getItem(SESSION_KEY) || '',
    user: null,
    view: 'market',
    currentTick: 1,
    selectedCode: 'SSB001',
    stockModalOpen: false,
    sortKey: 'code',
    sortDir: 'asc',
    prices: [],
    holdings: [],
    transactions: [],
    history: [],
    selected_trade_activity: null,
    market_overview: null,
    market_clock: null,
    guideContent: null,
    news: [],
    stock_news: [],
    kol_comments: [],
    ranking: null,
    allHoldings: null,
    admin: null,
    adminSections: {
      stocks: false,
      invites: false,
      accounts: false,
      transactions: false,
      sports: false,
    },
    transactionsExpanded: false,
    adminStockEditCode: '',
    liveBeijingTime: null,
    sleeping: false,
    loanStatus: null,
    p2pStatus: null,
    loanTab: 'bank',
    p2pFilter: 'all',
    activeLoan: null,
    isBankrupt: false,
    fundsList: [],
    fundsStatus: [],
    fundHistory: [],
    selectedFundCode: localStorage.getItem('selectedFundCode') || '',
    selectedFund: null,
    futuresList: [],
    futuresStatus: null,
    futuresHistory: [],
    selectedFuturesCode: null,
    selectedFuturesDetail: null,
    futuresLeverage: {}, // 用户为每个标的选择的杠杆（以 state 为准，render 后从此重建，避免被重置回默认）
    futuresSide: {}, // 用户为每个标的选择的方向 long/short（以 state 为准，render 后从此重建，避免被重置回默认"做多"）
    futuresModalOpen: false,
    sportsOverview: null,
    sportsSchedule: null,
    sportsPlayoffs: null,
    sportsStandings: [],
    sportsAccount: null,
    sportsActivity: null,
    sportsRanking: null,
    sportsRankingSortKey: 'total_pnl',
    sportsRankingSortDir: 'desc',
    sportsSection: 'overview',
    sportsTimeKey: '',
    sportsPendingBets: {},
    sportsPendingSeriesBets: {},
    sportsSeriesBetModal: null,
    liquidationAlertShownTick: 0,
    tradeFeedback: createTradeFeedbackState(),
  };

  var CHART_HISTORY_WINDOW = 80;

  const appRoot = document.getElementById('app');

  function createTradeFeedbackState() {
    return {
      stock: { code: null, buy: null, sell: null },
      fund: { code: null, buy: null, sell: null },
      futures: { code: null, open: null, closeByPositionId: {} }
    };
  }

  function makeTradeFeedbackTimerKey(surface, slot, context = {}) {
    return surface === 'futures' && slot === 'close'
      ? `${surface}:${slot}:${context.positionId || ''}`
      : `${surface}:${slot}`;
  }

  function clearTradeFeedbackTimer(surface, slot, context = {}) {
    const key = makeTradeFeedbackTimerKey(surface, slot, context);
    const timer = _tradeFeedbackTimers.get(key);
    if (timer) clearTimeout(timer);
    _tradeFeedbackTimers.delete(key);
  }

  function clearAllTradeFeedbackTimers() {
    for (const timer of _tradeFeedbackTimers.values()) clearTimeout(timer);
    _tradeFeedbackTimers = new Map();
  }

  function clearTradeFeedback(surface, options = {}) {
    if (!surface) {
      clearAllTradeFeedbackTimers();
      state.tradeFeedback = createTradeFeedbackState();
      return;
    }

    if (surface === 'stock' || surface === 'fund') {
      const current = state.tradeFeedback[surface];
      const nextCode = options.code !== undefined ? options.code : current.code;
      if (!options.slot) {
        clearTradeFeedbackTimer(surface, 'buy');
        clearTradeFeedbackTimer(surface, 'sell');
        state.tradeFeedback[surface] = { code: nextCode || null, buy: null, sell: null };
        return;
      }
      clearTradeFeedbackTimer(surface, options.slot);
      current.code = nextCode || null;
      current[options.slot] = null;
      return;
    }

    if (surface === 'futures') {
      const current = state.tradeFeedback.futures;
      const nextCode = options.code !== undefined ? options.code : current.code;
      if (!options.slot) {
        clearTradeFeedbackTimer(surface, 'open');
        Object.keys(current.closeByPositionId || {}).forEach((positionId) => {
          clearTradeFeedbackTimer(surface, 'close', { positionId });
        });
        state.tradeFeedback.futures = { code: nextCode || null, open: null, closeByPositionId: {} };
        return;
      }
      if (options.slot === 'open') {
        clearTradeFeedbackTimer(surface, 'open');
        current.code = nextCode || null;
        current.open = null;
        return;
      }
      if (options.slot === 'close' && options.positionId) {
        clearTradeFeedbackTimer(surface, 'close', { positionId: options.positionId });
        current.code = nextCode || null;
        delete current.closeByPositionId[options.positionId];
      }
    }
  }

  function setTradeFeedback(surface, slot, message, kind, context = {}) {
    if (!message) {
      clearTradeFeedback(surface, { slot, code: context.code, positionId: context.positionId });
      return;
    }

    const safeKind = ['success', 'error', 'warning'].includes(kind) ? kind : 'warning';
    const entry = { kind: safeKind, message: String(message) };
    if (context.positionMeta) entry.positionMeta = { ...context.positionMeta };

    if (surface === 'stock' || surface === 'fund') {
      const target = state.tradeFeedback[surface];
      target.code = context.code || target.code || null;
      target[slot] = entry;
    } else if (surface === 'futures') {
      const target = state.tradeFeedback.futures;
      target.code = context.code || target.code || null;
      if (slot === 'open') {
        target.open = entry;
      } else if (slot === 'close' && context.positionId) {
        target.closeByPositionId[context.positionId] = entry;
      }
    }

    clearTradeFeedbackTimer(surface, slot, context);
    if (safeKind !== 'success') return;

    const key = makeTradeFeedbackTimerKey(surface, slot, context);
    const timer = setTimeout(() => {
      const active = getTradeFeedback(surface, slot, context);
      if (!active || active.message !== entry.message || active.kind !== entry.kind) return;
      clearTradeFeedback(surface, { slot, code: context.code, positionId: context.positionId });
      render();
    }, NOTICE_TIMEOUT_MS);
    _tradeFeedbackTimers.set(key, timer);
  }

  function getTradeFeedback(surface, slot, context = {}) {
    if (surface === 'stock' || surface === 'fund') {
      const target = state.tradeFeedback[surface];
      if (context.code && target.code && context.code !== target.code) return null;
      return target[slot] || null;
    }
    if (surface === 'futures') {
      const target = state.tradeFeedback.futures;
      if (context.code && target.code && context.code !== target.code) return null;
      if (slot === 'open') return target.open || null;
      if (slot === 'close' && context.positionId) return target.closeByPositionId[context.positionId] || null;
    }
    return null;
  }

  function renderTradeFeedback(entry, fallbackMessage) {
    const active = entry || (fallbackMessage ? { kind: 'warning', message: fallbackMessage } : null);
    if (!active || !active.message) return '';
    const kind = ['success', 'error', 'warning'].includes(active.kind) ? active.kind : 'warning';
    return `<div class="trade-feedback trade-feedback-${kind}">${escapeHtml(active.message)}</div>`;
  }

  function getTradeLockReason(surface) {
    if (!state.user) return '';
    if (state.isBankrupt) return '已破产，无法交易，请联系管理员重置';
    if (state.sleeping) return '本局已休眠，请先恢复本局后再交易';
    if (isTradingAllowed()) return '';
    if (surface === 'market') return '当前封盘，只能查看行情，暂不能交易';
    if (surface === 'fund') return '当前封盘，只能查看基金，暂不能交易';
    if (surface === 'futures') return '当前封盘，只能查看期货，暂不能交易';
    return '当前不可交易';
  }

  document.addEventListener('DOMContentLoaded', () => {
    startLiveClock();
    state.view = getRouteView();
    render();
    restoreSession();
  });

  if (typeof window.addEventListener === 'function') {
    window.addEventListener('hashchange', () => {
      if (_suppressNextHashChange) {
        _suppressNextHashChange = false;
        return;
      }
      applyRouteView();
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (dismissConfirm(false)) {
        event.preventDefault();
        return;
      }
      if (state.sportsSeriesBetModal) {
        state.sportsSeriesBetModal = null;
        render();
        event.preventDefault();
        return;
      }
      if (state.stockModalOpen) {
      state.stockModalOpen = false;
      state.futuresModalOpen = false;
      render();
      }
    }
    if ((event.key === 'Enter' || event.key === ' ') && event.target?.dataset?.action === 'sports-series-open') {
      event.preventDefault();
      event.target.click();
    }
  });

  appRoot.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!form.matches('[data-form]')) return;
    event.preventDefault();
    const data = new FormData(form);

    if (form.dataset.form === 'login') {
      await doLogin(data.get('username'), data.get('password'));
      return;
    }

    if (form.dataset.form === 'register') {
      await doRegister(data.get('inviteCode'), data.get('username'), data.get('password'), data.get('confirmPassword'));
      return;
    }

    if (form.dataset.form === 'reset-password') {
      await doSetupPassword(data.get('username'), data.get('password'), data.get('confirmPassword'));
      return;
    }

    if (form.dataset.form === 'trade-custom') {
      const submitter = event.submitter;
      await tradeCustomLots(submitter?.dataset.trade, submitter?.dataset.code, Number(data.get('lots') || 0));
    }

    if (form.dataset.form === 'trade-custom-amount') {
      const submitter = event.submitter;
      await tradeByAmount(submitter?.dataset.trade, submitter?.dataset.code, Number(data.get('amount') || 0));
    }

    if (form.dataset.form === 'add-stock') {
      await addStock(stockPayloadFromForm(data));
    }

    if (form.dataset.form === 'update-stock') {
      await updateStock(stockPayloadFromForm(data));
    }

    if (form.dataset.form === 'loan-borrow') {
      await borrowLoanRequest(Number(data.get('loanAmount')));
    }

    if (form.dataset.form === 'fund-buy') {
      await tradeFundRequest('buy', String(data.get('fundCode')), Number(data.get('amount') || 0));
    }

    if (form.dataset.form === 'fund-sell') {
      await tradeFundRequest('sell', String(data.get('fundCode')), Number(data.get('shares') || 0));
    }

    if (form.dataset.form === 'sports-config') {
      await saveSportsConfig(Object.fromEntries(data.entries()));
    }
  });

  appRoot.addEventListener('click', async (event) => {
    // 自定义杠杆下拉：点击菜单外区域收起所有展开的下拉
    const levTrigger = event.target.closest('[data-action="lev-toggle"]');
    const levOption = event.target.closest('[data-action="lev-pick"]');
    document.querySelectorAll('.lev-select.open').forEach((sel) => {
      if ((levTrigger && sel.contains(levTrigger)) || (levOption && sel.contains(levOption))) return;
      closeLevSelect(sel);
    });

    const target = event.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;

    if (action === 'lev-toggle') {
      const sel = target.closest('.lev-select');
      if (sel) {
        const willOpen = !sel.classList.contains('open');
        sel.classList.toggle('open', willOpen);
        target.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        const menu = sel.querySelector('.lev-select-menu');
        if (menu) menu.hidden = !willOpen;
      }
      return;
    }

    if (action === 'lev-pick') {
      pickLeverage(target);
      return;
    }

    if (action === 'select-stock') {
      state.selectedCode = target.dataset.code;
      state.stockModalOpen = true;
      clearTradeFeedback('stock', { code: state.selectedCode || null });
      await loadState(false);
      render();
      return;
    }

    if (action === 'close-stock') {
      if (target.classList.contains('modal-layer') && event.target.closest('.stock-modal')) return;
      state.stockModalOpen = false;
      clearTradeFeedback('stock', { code: null });
      render();
      return;
    }

    if (action === 'set-sort') {
      const key = target.dataset.sortKey || 'code';
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = key;
        state.sortDir = key === 'code' ? 'asc' : 'desc';
      }
      render();
      return;
    }

    if (action === 'set-view') {
      if (target.dataset.loanTab) {
        state.loanTab = target.dataset.loanTab;
      }
      await setView(target.dataset.view || 'market');
      if (state.loanTab === 'p2p' && target.dataset.view === 'loan') {
        loadP2POrders();
      }
      return;
    }

    if (action === 'refresh') {
      await refreshCurrentView();
      return;
    }

    if (action === 'select-fund') {
      state.selectedFundCode = target.dataset.code || state.selectedFundCode;
      localStorage.setItem('selectedFundCode', state.selectedFundCode);
      clearTradeFeedback('fund', { code: state.selectedFundCode || null });
      await loadSelectedFund(true);
      return;
    }

    if (action === 'select-futures') {
      state.selectedFuturesCode = target.dataset.code || state.selectedFuturesCode;
      state.futuresModalOpen = false;
      clearTradeFeedback('futures', { code: state.selectedFuturesCode || null });
      await loadFuturesDetail(state.selectedFuturesCode);
      render();
      return;
    }

    if (action === 'futures-open') {
      const code = target.closest('[data-code]')?.dataset?.code || state.selectedFuturesCode;
      const form = target.closest('.futures-form');
      if (!form) return;
      const sideEl = form.querySelector('[name="futures-side"]:checked');
      const contractsEl = form.querySelector('[name="futures-contracts"]');
      const leverageEl = form.querySelector('[name="futures-leverage"]');
      const side = sideEl ? sideEl.value : 'long';
      const contracts = parseInt(contractsEl ? contractsEl.value : 1, 10);
      const leverage = parseInt(leverageEl ? leverageEl.value : 3, 10);
      if (!contracts || contracts < 1) {
        setTradeFeedback('futures', 'open', '请输入有效张数', 'error', { code });
        render();
        return;
      }
      const confirmedLeverage = await confirmFuturesLeverage(code, leverage);
      if (!confirmedLeverage) return;
      await openFuturesPosition(code, side, contracts, leverage);
      return;
    }

    if (action === 'futures-close') {
      const positionId = target.closest('[data-position-id]')?.dataset?.positionId;
      if (!positionId) return;
      await closeFuturesPosition(positionId);
      return;
    }

    if (action === 'sports-section') {
      state.sportsSection = target.dataset.section || 'overview';
      if (state.sportsSection === 'playoffs') await loadSportsPlayoffs();
      if (state.sportsSection === 'bets') await loadSportsActivity();
      if (state.sportsSection === 'ranking') await loadSportsRanking();
      render();
      return;
    }

    if (action === 'set-sports-ranking-sort') {
      const key = target.dataset.sortKey || 'total_pnl';
      if (state.sportsRankingSortKey === key) {
        state.sportsRankingSortDir = state.sportsRankingSortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sportsRankingSortKey = key;
        state.sportsRankingSortDir = 'desc';
      }
      render();
      return;
    }

    if (action === 'sports-time') {
      state.sportsTimeKey = target.dataset.time || '';
      render();
      return;
    }

    if (action === 'sports-bet') {
      if (target.disabled || target.getAttribute('aria-busy') === 'true') return;
      const matchId = target.dataset.matchId;
      const selectionTeamId = target.dataset.selectionTeamId;
      const input = document.getElementById(`sports-bet-${matchId}`);
      await placeSportsBet(matchId, selectionTeamId, Number(input?.value || 0));
      return;
    }

    if (action === 'sports-series-open') {
      if (target.getAttribute('aria-disabled') === 'true') return;
      openSportsSeriesBetModal(target.dataset.seriesId);
      return;
    }

    if (action === 'sports-series-close') {
      if (target.classList.contains('modal-layer') && event.target !== target) return;
      state.sportsSeriesBetModal = null;
      render();
      return;
    }

    if (action === 'sports-series-bet') {
      if (target.disabled || target.getAttribute('aria-busy') === 'true') return;
      const seriesId = target.dataset.seriesId;
      const selectionTeamId = target.dataset.selectionTeamId;
      const input = document.getElementById(`sports-series-bet-${seriesId}`);
      await placeSportsSeriesBet(seriesId, selectionTeamId, Number(input?.value || 0));
      return;
    }

    if (action === 'sports-pause') {
      await setSportsPaused(target.dataset.paused === 'true');
      return;
    }

    if (action === 'sports-advance-stage') {
      await advanceSportsStage();
      return;
    }

    if (action === 'sports-cancel-match') {
      await cancelSportsMatch(target.dataset.matchId);
      return;
    }

    if (action === 'sports-audit-match') {
      const id = target.dataset.matchId;
      const detail = document.getElementById(`sports-audit-${id}`);
      if (detail) {
        const isHidden = detail.hasAttribute('hidden');
        if (isHidden) detail.removeAttribute('hidden');
        else detail.setAttribute('hidden', '');
      }
      return;
    }

    if (action === 'repay-loan') {
      await repayLoanRequest();
      return;
    }

    if (action === 'set-loan-tab') {
      state.loanTab = target.dataset.tab;
      if (state.loanTab === 'p2p') {
        loadP2PStatus().then(() => { render(); loadP2POrders(); });
        return;
      }
      render();
      return;
    }

    if (action === 'loan-term') {
      if (target.disabled || target.classList.contains('disabled')) return;
      document.querySelectorAll('.term-btn').forEach(b => b.classList.remove('active'));
      target.classList.add('active');
      window.updateLoanPreview();
      return;
    }

    if (action === 'logout') {
      clearSession(true);
      state.notice = '';
      state.error = '';
      render();
      return;
    }

    if (action === 'back-login') {
      state.authStep = 'login';
      state.pendingAccount = null;
      state.error = '';
      render();
      return;
    }

    if (action === 'switch-to-register') {
      state.authStep = 'register';
      state.error = '';
      render();
      return;
    }

    if (action === 'switch-to-reset-password') {
      state.authStep = 'reset-password';
      state.error = '';
      render();
      return;
    }

    if (action === 'switch-to-login') {
      state.authStep = 'login';
      state.error = '';
      render();
      return;
    }

    if (action === 'advance') {
      await advanceTick();
      return;
    }

    if (action === 'resume-market') {
      await resumeMarket();
      return;
    }

    if (action === 'toggle-market') {
      await toggleMarketOpen();
      return;
    }

    if (action === 'trade') {
      await trade(target.dataset.trade, target.dataset.code, Number(target.dataset.lots || 0));
      return;
    }

    if (action === 'trade-amount') {
      await tradeByAmount(target.dataset.trade, target.dataset.code, Number(target.dataset.amount || 0));
      return;
    }

    if (action === 'reset-market') {
      await resetMarket();
      return;
    }

    if (action === 'reset-passwords') {
      await resetPasswords();
      return;
    }

    if (action === 'reset-player-password') {
      await resetPlayerPassword(target.dataset.username, target.dataset.nickname);
    }

    if (action === 'reset-player') {
      await resetPlayer(target.dataset.username, target.dataset.nickname);
    }

    if (action === 'delete-account') {
      await deleteAccount(target.dataset.username, target.dataset.nickname);
    }

    if (action === 'edit-stock') {
      state.adminStockEditCode = target.dataset.code || '';
      render();
      return;
    }

    if (action === 'cancel-stock-edit') {
      state.adminStockEditCode = '';
      render();
    }

    if (action === 'toggle-admin-section') {
      const section = target.dataset.section;
      if (section && Object.prototype.hasOwnProperty.call(state.adminSections, section)) {
        state.adminSections[section] = !state.adminSections[section];
        render();
      }
      return;
    }

    if (action === 'toggle-transactions') {
      state.transactionsExpanded = !state.transactionsExpanded;
      render();
      return;
    }

    if (action === 'generate-invites') {
      const countInput = document.getElementById('inviteCount');
      const count = Math.max(1, Math.min(100, Number(countInput?.value) || 5));
      await generateInvites(count);
      return;
    }

    if (action === 'save-invite-nickname') {
      const code = target.dataset.inviteCode;
      const input = document.querySelector('input[data-invite-code="' + code + '"]');
      const nickname = (input?.value || '').trim();
      await saveInviteNickname(code, nickname);
      return;
    }

    if (action === 'revoke-invite') {
      const code = target.dataset.inviteCode;
      await revokeInvite(code);
      return;
    }

    if (action === 'show-p2p-order-popup') {
      var direction = target.dataset.direction;
      var existing = (state.p2pStatus && state.p2pStatus.my_open_orders && state.p2pStatus.my_open_orders.length > 0);
      if (existing) {
        await confirmAction({ title: '已有挂单', message: '你已有一笔挂单，请先撤销后再发布新单。', confirmText: '知道了', cancelText: '关闭' });
        return;
      }
      var popup = showP2POrderPopup(direction);
      initP2POrderPopup(popup);
      return;
    }

    if (action === 'p2p-filter') {
      const filter = target.dataset.filter;
      loadP2POrders(filter);
      return;
    }

    if (action === 'match-p2p-order') {
      const orderId = parseInt(target.dataset.id);
      const ok = await confirmAction({ title: '确认匹配', message: '确认匹配该订单？匹配后资金将立即转移。' });
      if (!ok) return;
      try {
        await api('/api/p2p/order/' + orderId + '/match', { method: 'POST' });
        await refreshCurrentView();
      } catch (e) { await confirmAction({ title: '操作失败', message: e.message || '匹配失败', confirmText: '知道了', cancelText: '关闭' }); }
      return;
    }

    if (action === 'cancel-p2p-order') {
      const orderId = parseInt(target.dataset.id);
      try {
        await api('/api/p2p/order/' + orderId + '/cancel', { method: 'POST' });
        await refreshCurrentView();
      } catch (e) { await confirmAction({ title: '操作失败', message: '取消失败', confirmText: '知道了', cancelText: '关闭' }); }
      return;
    }

    if (action === 'repay-p2p') {
      const ok = await confirmAction({ title: '确认还款', message: '确认提前还清个人借贷？你需要支付本金+已产生利息。', tone: 'danger' });
      if (!ok) return;
      try {
        await api('/api/p2p/repay', { method: 'POST' });
        await refreshCurrentView();
      } catch (e) { await confirmAction({ title: '操作失败', message: e.message || '还款失败', confirmText: '知道了', cancelText: '关闭' }); }
      return;
    }

  });

  appRoot.addEventListener('input', (event) => {
    const target = event.target;
    if (!target.matches('[data-clamp]')) return;
    clampTradeInput(target);
    if (target.dataset.action === 'calc-futures') {
      updateFuturesCalc();
      return;
    }
  });

  appRoot.addEventListener('change', (event) => {
    const target = event.target;
    if (target.dataset.action === 'calc-futures') {
      updateFuturesCalc();
    }
  });

  async function restoreSession() {
    if (!state.token) return;
    const routeView = getRouteView();
    state.view = routeView;
    state.loading = true;
    render();
    await loadState(false);
    if (state.user) {
      state.view = resolveAccessibleView(routeView);
      syncRouteToView(true);
      state.loading = false;
      render();
      await loadRanking(false);
      if (state.user.is_admin) await loadAdmin(false);
      await loadViewData(state.view, false);
    }
    state.loading = false;
    render();
  }

  async function doLogin(username, password) {
    state.loading = true;
    state.error = '';
    render();

    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: { username, password }
      });
      await acceptLogin(data, '登录成功。');
    } catch (error) {
      setError(error.message || '登录失败');
    } finally {
      state.loading = false;
      render();
    }
  }

  async function doRegister(inviteCode, username, password, confirmPassword) {
    if (String(password || '') !== String(confirmPassword || '')) {
      setError('两次输入的密码不一致');
      render();
      return;
    }

    state.loading = true;
    state.error = '';
    render();

    try {
      const data = await api('/api/auth/register', {
        method: 'POST',
        body: { inviteCode, username, password }
      });
      await acceptLogin(data, '注册成功，欢迎进入市场。');
    } catch (error) {
      setError(error.message || '注册失败');
    } finally {
      state.loading = false;
      render();
    }
  }

  async function doSetupPassword(username, password, confirmPassword) {
    if (String(password || '') !== String(confirmPassword || '')) {
      setError('两次输入的密码不一致');
      render();
      return;
    }

    state.loading = true;
    state.error = '';
    render();

    try {
      const data = await api('/api/auth/setup-password', {
        method: 'POST',
        body: { username, password }
      });
      await acceptLogin(data, '密码设置成功，已进入市场。');
    } catch (error) {
      setError(error.message || '密码设置失败');
    } finally {
      state.loading = false;
      render();
    }
  }

  async function acceptLogin(data, notice) {
    state.token = data.token || '';
    state.user = data.user || null;
    state.currentTick = data.current_tick || state.currentTick;
    state.market_clock = data.market_clock || state.market_clock;
    state.sleeping = data.market_clock?.sleeping || false;
    state.pendingAccount = null;
    state.authStep = 'login';
    state.view = resolveAccessibleView(getRouteView());
    state.notice = notice;
    state.error = '';
    syncRouteToView(true);
    localStorage.setItem(SESSION_KEY, state.token);
    localStorage.setItem(ACCOUNT_KEY, state.user?.username || state.loginUsername);
    await loadState(false);
    await loadRanking(false);
    if (state.user?.is_admin) await loadAdmin(false);
    await loadViewData(state.view, false);
  }

  async function refreshCurrentView() {
    await loadState(true);
    await loadViewData(state.view, true);
  }

  async function setView(view) {
    if (_routeChangeInFlight) return;
    _routeChangeInFlight = true;
    try {
      state.view = resolveAccessibleView(view);
      clearTradeFeedback();
      syncRouteToView(false);
      if (state.view !== 'futures') {
        state.selectedFuturesCode = null;
        state.selectedFuturesDetail = null;
        state.futuresModalOpen = false;
      }
      if (state.view !== 'market') { state.selectedCode = null; state.stockModalOpen = false; }
      await loadViewData(state.view, true);
    } finally {
      _routeChangeInFlight = false;
    }
    render();
  }

  async function applyRouteView() {
    if (_routeChangeInFlight || !state.user) return;
    _routeChangeInFlight = true;
    try {
      state.view = resolveAccessibleView(getRouteView());
      clearTradeFeedback();
      syncRouteToView(true);
      await loadViewData(state.view, true);
      state.stockModalOpen = false;
      render();
    } finally {
      _routeChangeInFlight = false;
    }
  }

  async function loadViewData(view, showLoading) {
    if (view === 'ranking') await loadRanking(showLoading);
    if (view === 'holdings') await loadAllHoldings(showLoading);
    if (view === 'admin') await loadAdmin(showLoading);
    if (view === 'loan') await loadLoanStatus(showLoading);
    if (view === 'funds') await loadFunds(showLoading);
    if (view === 'futures') await loadFutures(showLoading);
    if (view === 'sports') await loadSports(showLoading);
    if (view === 'account') await loadAccountData(showLoading);
    if (view === 'guide') await loadGuide(showLoading);
  }

  async function loadGuide(showLoading) {
    if (state.guideContent) return;
    if (showLoading) { state.loading = true; state.error = ''; render(); }
    try {
      var data = await api('/api/guide');
      state.guideContent = data.content || '';
    } catch (e) {
      handleApiError(e, '教程加载失败');
    } finally {
      state.loading = false;
      if (showLoading) render();
    }
  }

  async function loadAccountData(showLoading) {
    if (state.fundsStatus.length > 0 && state.futuresStatus && state.futuresHistory.length > 0 && state.sportsAccount) return;
    if (showLoading) {
      state.loading = true;
      state.error = '';
      render();
    }
    try {
      if (!state.fundsStatus || !state.fundsStatus.length) {
        const fundStatus = await api('/api/funds/status');
        state.fundsStatus = fundStatus || [];
      }
      if (!state.futuresStatus) {
        const futuresStatus = await api('/api/futures/status');
        state.futuresStatus = futuresStatus || createEmptyFuturesStatus();
      }
      if (!state.futuresHistory || !state.futuresHistory.length) {
        const history = await api('/api/futures/history');
        state.futuresHistory = history || [];
      }
      if (!state.fundHistory || !state.fundHistory.length) {
        const fundHistory = await api('/api/funds/history');
        state.fundHistory = fundHistory || [];
      }
      state.sportsAccount = await api('/api/sports/account');
    } catch (error) {
      handleApiError(error, '账户数据加载失败');
    } finally {
      state.loading = false;
      if (showLoading) render();
    }
  }

  function getRouteView() {
    const raw = String(window.location?.hash || '').replace(/^#\/?/, '').split(/[/?&]/)[0];
    return VIEW_KEYS.includes(raw) ? raw : 'market';
  }

  function resolveAccessibleView(view) {
    const nextView = VIEW_KEYS.includes(view) ? view : 'market';
    if (nextView === 'admin' && !state.user?.is_admin) return 'market';
    return nextView;
  }

  function syncRouteToView(replace) {
    if (!window.location) return;
    const nextHash = `#${state.view}`;
    if (window.location.hash === nextHash) return;
    if (replace && window.history?.replaceState) {
      window.history.replaceState(null, '', nextHash);
      return;
    }
    _suppressNextHashChange = true;
    window.location.hash = nextHash;
  }

  async function loadState(showLoading) {
    if (!state.token) return;
    if (showLoading) {
      state.loading = true;
      state.error = '';
      render();
    }

    try {
      const params = new URLSearchParams({ selectedCode: state.selectedCode });
      const data = await api(`/api/state?${params.toString()}`);
      applyState(data);
    } catch (error) {
      handleApiError(error, '加载失败');
    } finally {
      state.loading = false;
      if (showLoading) render();
    }
  }

  async function loadRanking(showLoading) {
    if (!state.token) return;
    if (showLoading) {
      state.loading = true;
      state.error = '';
      render();
    }

    try {
      state.ranking = await api('/api/ranking');
      if (state.ranking?.market_clock) {
        state.market_clock = state.ranking.market_clock;
        state.sleeping = !!state.ranking.market_clock.sleeping;
      }
    } catch (error) {
      handleApiError(error, '排行榜加载失败');
    } finally {
      state.loading = false;
      if (showLoading) render();
    }
  }

  async function loadAdmin(showLoading) {
    if (!state.token || !state.user?.is_admin) return;
    if (showLoading) {
      state.loading = true;
      state.error = '';
      render();
    }

    try {
      state.admin = await api('/api/admin/overview');
      state.admin.invites = await api('/api/admin/invites') || [];
      state.admin.sports = await api('/api/admin/sports');
      if (state.admin?.market_clock) {
        state.market_clock = state.admin.market_clock;
        state.sleeping = !!state.admin.market_clock.sleeping;
      }
    } catch (error) {
      handleApiError(error, '管理员数据加载失败');
    } finally {
      state.loading = false;
      if (showLoading) render();
    }
  }

  async function loadSports(showLoading) {
    if (!state.token) return;
    if (showLoading) {
      state.loading = true;
      state.error = '';
      render();
    }
    try {
      const [overview, standings, account] = await Promise.all([
        api('/api/sports/overview'),
        api('/api/sports/standings'),
        api('/api/sports/account')
      ]);
      const previousDate = String(state.sportsOverview?.matches?.[0]?.scheduled_at || '').slice(0, 10);
      const nextDate = String(overview?.matches?.[0]?.scheduled_at || '').slice(0, 10);
      if (previousDate !== nextDate) state.sportsTimeKey = '';
      state.sportsOverview = overview;
      state.sportsStandings = standings || [];
      state.sportsAccount = account;
      if (state.sportsSection === 'playoffs') await loadSportsPlayoffs();
      if (state.sportsSection === 'bets') await loadSportsActivity();
      if (state.sportsSection === 'ranking') await loadSportsRanking();
    } catch (error) {
      handleApiError(error, '赛事数据加载失败');
    } finally {
      state.loading = false;
      if (showLoading) render();
    }
  }

  async function loadSportsPlayoffs() {
    try {
      state.sportsPlayoffs = await api('/api/sports/playoffs');
    } catch (error) {
      handleApiError(error, '季后赛对阵加载失败');
    }
  }

  async function loadSportsActivity() {
    try {
      state.sportsActivity = await api('/api/sports/activity');
    } catch (error) {
      handleApiError(error, '投注动态加载失败');
    }
  }

  async function loadSportsRanking() {
    try {
      state.sportsRanking = await api('/api/sports/ranking');
    } catch (error) {
      handleApiError(error, '竞猜排行加载失败');
    }
  }

  async function placeSportsBet(matchId, selectionTeamId, amount) {
    if (!amount || amount < 0) {
      await showSportsBetFailure('请输入有效竞猜金额');
      return;
    }
    if (state.sportsPendingBets[matchId]) {
      await showSportsBetFailure('该场比赛竞猜正在提交中，请勿重复点击');
      return;
    }
    const match = state.sportsOverview?.matches?.find((item) => item.id === matchId);
    const selection = match?.home_team?.id === selectionTeamId ? match.home_team : match?.away_team;
    const odds = match?.home_team?.id === selectionTeamId ? match?.market?.home_odds : match?.market?.away_odds;
    const confirmed = await confirmSportsBet({
      title: '确认单场竞猜',
      selectionName: selection?.name || selectionTeamId,
      amount,
      odds
    });
    if (!confirmed) return;
    const clientRequestId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `bet-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    state.sportsPendingBets[matchId] = { clientRequestId, selectionTeamId, amount };
    render();
    try {
      const data = await api('/api/sports/bet', {
        method: 'POST',
        body: { matchId, selectionTeamId, amount, clientRequestId }
      });
      state.user = data.user || state.user;
      state.sportsAccount = data.sports_account || state.sportsAccount;
      await confirmAction({ kicker: '竞猜结果', title: '竞猜提交成功', note: '下注成功后赔率锁定，不受后续阵容变化影响。', confirmText: '知道了', alertOnly: true });
      await loadSports(false);
    } catch (error) {
      await showSportsBetFailure(error, '竞猜提交失败');
    } finally {
      delete state.sportsPendingBets[matchId];
      render();
    }
  }

  function openSportsSeriesBetModal(seriesId) {
    const series = state.sportsPlayoffs?.series?.find((item) => item.id === seriesId);
    if (!series || series.market?.status !== 'open' || !series.home_team || !series.away_team) return;
    state.sportsSeriesBetModal = { seriesId };
    render();
    setTimeout(() => document.getElementById(`sports-series-bet-${seriesId}`)?.focus(), 0);
  }

  async function placeSportsSeriesBet(seriesId, selectionTeamId, amount) {
    if (!amount || amount < 0) {
      await showSportsBetFailure('请输入有效竞猜金额');
      return;
    }
    if (state.sportsPendingSeriesBets[seriesId]) {
      await showSportsBetFailure('该系列赛竞猜正在提交中，请勿重复点击');
      return;
    }
    const series = state.sportsPlayoffs?.series?.find((item) => item.id === seriesId);
    const selection = series?.home_team?.id === selectionTeamId ? series.home_team : series?.away_team;
    const odds = series?.home_team?.id === selectionTeamId ? series?.market?.home_odds : series?.market?.away_odds;
    const confirmed = await confirmSportsBet({
      title: '确认系列赛竞猜',
      selectionName: selection?.name || selectionTeamId,
      amount,
      odds,
      marketLabel: '系列赛胜者'
    });
    if (!confirmed) return;
    const clientRequestId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `series-bet-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    state.sportsPendingSeriesBets[seriesId] = { clientRequestId, selectionTeamId, amount };
    render();
    try {
      const data = await api('/api/sports/series-bet', {
        method: 'POST',
        body: { seriesId, selectionTeamId, amount, clientRequestId }
      });
      state.user = data.user || state.user;
      state.sportsAccount = data.sports_account || state.sportsAccount;
      state.sportsSeriesBetModal = null;
      await confirmAction({ kicker: '竞猜结果', title: '竞猜提交成功', note: '下注成功后赔率锁定，不受后续阵容变化影响。', confirmText: '知道了', alertOnly: true });
      await loadSports(false);
    } catch (error) {
      await showSportsBetFailure(error, '系列赛竞猜提交失败');
    } finally {
      delete state.sportsPendingSeriesBets[seriesId];
      render();
    }
  }

  function confirmSportsBet({ title, selectionName, amount, odds, marketLabel = '单场胜负' }) {
    const lockedOdds = Number(odds || 0);
    return confirmAction({
      kicker: '竞猜确认',
      title,
      message: `竞猜类型：${marketLabel}\n选择：${selectionName}\n竞猜金额：${money(amount)}\n锁定赔率：${lockedOdds.toFixed(2)}\n预计返还：${money(Number(amount || 0) * lockedOdds)}`,
      note: '下注成功后赔率锁定，不受后续阵容变化影响。',
      confirmText: '确认投注',
      cancelText: '返回修改'
    });
  }

  async function showSportsBetFailure(error, fallback = '竞猜提交失败') {
    const message = typeof error === 'string' ? error : (error?.message || fallback);
    if (message.includes('登录')) clearSession(false);
    state.error = '';
    await confirmAction({
      kicker: '竞猜提醒',
      title: '投注失败',
      message,
      confirmText: '知道了',
      alertOnly: true,
      tone: 'danger'
    });
  }

  async function setSportsPaused(paused) {
    try {
      await api('/api/admin/sports/pause', { method: 'POST', body: { paused } });
      state.notice = paused ? '赛事已暂停。' : '赛事已恢复。';
      await loadAdmin(false);
    } catch (error) {
      handleApiError(error, '赛事状态更新失败');
    }
    render();
  }

  async function advanceSportsStage() {
    const confirmed = await confirmAction({
      title: '推进赛事阶段',
      message: '确认批量模拟并结算当前阶段剩余比赛？',
      confirmText: '确认推进',
      confirmClass: 'danger',
      tone: 'danger'
    });
    if (!confirmed) return;
    try {
      await api('/api/admin/sports/advance-stage', { method: 'POST' });
      state.notice = '赛事阶段已推进。';
      await loadAdmin(false);
    } catch (error) {
      handleApiError(error, '赛事阶段推进失败');
    }
    render();
  }

  async function cancelSportsMatch(matchId) {
    if (!matchId) return;
    const confirmed = await confirmAction({
      title: '取消异常比赛',
      message: '确认取消该场比赛并自动退还未结算竞猜本金？',
      confirmText: '取消比赛',
      confirmClass: 'danger',
      tone: 'danger'
    });
    if (!confirmed) return;
    try {
      await api('/api/admin/sports/cancel', { method: 'POST', body: { matchId } });
      state.notice = '比赛已取消并完成退款。';
      await loadAdmin(false);
    } catch (error) {
      handleApiError(error, '取消比赛失败');
    }
    render();
  }

  async function saveSportsConfig(payload) {
    try {
      await api('/api/admin/sports/config', { method: 'POST', body: payload });
      state.notice = '下一赛季参数已保存。';
      await loadAdmin(false);
    } catch (error) {
      handleApiError(error, '赛事参数保存失败');
    }
    render();
  }

  async function loadAllHoldings(showLoading) {
    if (!state.token) return;
    if (showLoading) {
      state.loading = true;
      state.error = '';
      render();
    }

    try {
      state.allHoldings = await api('/api/all-holdings');
    } catch (error) {
      handleApiError(error, '持仓数据加载失败');
    } finally {
      state.loading = false;
      if (showLoading) render();
    }
  }

  async function loadLoanStatus(showLoading) {
    if (!state.token) return;
    if (showLoading) {
      state.loading = true;
      state.error = '';
      render();
    }

    try {
      state.loanStatus = await api('/api/loan/status');
      checkLoanWarning();
      if (state.loanTab === 'p2p') {
        await loadP2PStatus();
      }
    } catch (error) {
      handleApiError(error, '贷款状态加载失败');
    } finally {
      state.loading = false;
      if (showLoading) render();
    }
  }

  async function loadP2PStatus() {
    try {
      state.p2pStatus = await api('/api/p2p/status');
    } catch (e) {
      state.p2pStatus = null;
    }
  }

  async function loadFunds(showLoading) {
    if (!state.token) { render(); return; }
    if (showLoading) {
      state.loading = true;
      state.error = '';
      render();
    }
    try {
      const [list, status, history] = await Promise.all([
        api('/api/funds/list'),
        api('/api/funds/status'),
        api('/api/funds/history')
      ]);
      state.fundsList = list || [];
      state.fundsStatus = status || [];
      state.fundHistory = history || [];
      if (!state.fundsList.some((fund) => fund.code === state.selectedFundCode)) {
        state.selectedFundCode = state.fundsList[0]?.code || '';
      }
      await loadSelectedFund(false);
    } catch (error) {
      handleApiError(error, '基金数据加载失败');
    } finally {
      state.loading = false;
      if (showLoading) render();
    }
  }

  async function loadSelectedFund(showLoading) {
    if (!state.selectedFundCode) return;
    if (showLoading) {
      state.loading = true;
      render();
    }
    try {
      state.selectedFund = await api(`/api/funds/${encodeURIComponent(state.selectedFundCode)}`);
    } catch (error) {
      handleApiError(error, '基金详情加载失败');
    } finally {
      state.loading = false;
      if (showLoading) render();
    }
  }

  async function tradeFundRequest(action, fundCode, value) {
    const fund = state.fundsList.find((item) => item.code === fundCode);
    if (!fund) return;
    clearTradeFeedback('fund', { slot: action, code: fundCode });
    state.loading = true;
    render();
    try {
      await api(`/api/funds/${action}`, {
        method: 'POST',
        body: {
          fundCode,
          expectedTick: state.currentTick,
          expectedNav: fund.nav,
          ...(action === 'buy' ? { amount: value } : { shares: value })
        }
      });
      await Promise.all([loadState(false), loadFunds(false)]);
      setTradeFeedback('fund', action, action === 'buy' ? '基金申购成功。' : '基金赎回成功。', 'success', { code: fundCode });
    } catch (error) {
      setTradeFeedback('fund', action, error.message || (action === 'buy' ? '基金申购失败' : '基金赎回失败'), 'error', { code: fundCode });
    } finally {
      state.loading = false;
      render();
    }
  }

  function checkLoanWarning() {
    const al = state.activeLoan;
    if (al && al.warning && !state._loanWarningDismissed) {
      state._loanWarningDismissed = true;
      showLoanWarningModal(al);
    }
  }

  function showLoanWarningModal(al) {
    const content = `
      <div class="modal-layer" style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;">
        <div style="background:#fff;border-radius:12px;padding:24px;max-width:400px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.2);">
          <div style="font-size:18px;font-weight:700;margin-bottom:12px;color:var(--danger);">贷款即将到期</div>
          <div style="margin-bottom:16px;font-size:14px;line-height:1.6;">
            <p>你的贷款距到期仅剩 <strong style="color:var(--danger);">${al.ticks_remaining}</strong> 期。</p>
            <p>当前应还总额：<strong>${money(al.total_to_repay_now || (al.principal + (al.accrued_interest || 0)))}</strong></p>
            <p style="color:var(--muted);">到期时优先扣除现金，不足部分将<strong>强制卖出持仓</strong>（低仓位优先）以偿还债务。</p>
          </div>
          <div style="display:flex;gap:10px;">
            <button class="primary" style="flex:1;" data-action="dismiss-loan-warning">我知道了</button>
          </div>
        </div>
      </div>
    `;
    const wrapper = document.createElement('div');
    wrapper.id = 'loan-warning-overlay';
    wrapper.innerHTML = content;
    document.body.appendChild(wrapper);

    wrapper.querySelector('[data-action="dismiss-loan-warning"]').addEventListener('click', async () => {
      try {
        await api('/api/loan/dismiss-warning', { method: 'POST' });
      } catch (_) { /* dismiss non-critical */ }
      document.getElementById('loan-warning-overlay')?.remove();
    });
  }

  function dismissConfirm(result) {
    if (!_activeConfirm) return false;
    const { overlay, resolve, previousOverflow } = _activeConfirm;
    _activeConfirm = null;
    document.body.style.overflow = previousOverflow;
    overlay.remove();
    resolve(result);
    return true;
  }

  function confirmMessageHtml(message) {
    return String(message || '')
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `<p>${escapeHtml(line)}</p>`)
      .join('');
  }

  function confirmAction(options = {}) {
    const {
      title = '请确认操作',
      message = '',
      kicker = '',
      note = '',
      confirmText = '确认',
      cancelText = '取消',
      confirmClass = 'primary',
      tone = 'primary',
      wide = false,
      alertOnly = false
    } = options;

    if (_activeConfirm) dismissConfirm(false);

    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      const previousOverflow = document.body.style.overflow;
      const toneClass = tone === 'danger' ? 'danger' : 'primary';
      overlay.className = 'confirm-modal-layer';
      overlay.innerHTML = `
        <div class="confirm-modal confirm-tone-${toneClass}${wide ? ' confirm-modal-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
          <div class="confirm-modal-body">
            <div class="confirm-modal-kicker">${escapeHtml(kicker || (tone === 'danger' ? '高风险操作' : '操作确认'))}</div>
            <h2 class="confirm-modal-title" id="confirm-title">${escapeHtml(title)}</h2>
            <div class="confirm-modal-copy">${confirmMessageHtml(message)}</div>
            ${note ? `<small class="muted confirm-modal-note">${escapeHtml(note)}</small>` : ''}
            <div class="confirm-modal-actions${alertOnly ? ' confirm-modal-actions-single' : ''}">
              ${alertOnly ? '' : `<button class="secondary" type="button" data-confirm="cancel">${escapeHtml(cancelText)}</button>`}
              <button class="${confirmClass}" type="button" data-confirm="confirm">${escapeHtml(confirmText)}</button>
            </div>
          </div>
        </div>
      `;

      _activeConfirm = { overlay, resolve, previousOverflow };
      document.body.style.overflow = 'hidden';
      document.body.appendChild(overlay);

      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) dismissConfirm(false);
      });
      overlay.querySelector('[data-confirm="cancel"]')?.addEventListener('click', () => dismissConfirm(false));
      overlay.querySelector('[data-confirm="confirm"]').addEventListener('click', () => dismissConfirm(true));
      overlay.querySelector(alertOnly ? '[data-confirm="confirm"]' : '[data-confirm="cancel"]').focus();
    });
  }

  function computeLoanPreview(amount, termTicks, caps, rates, dailyTickTotal) {
    if (!amount || amount <= 0) return null;
    const tier1 = Math.min(amount, caps[0]);
    const tier2 = Math.min(Math.max(0, amount - caps[0]), caps[1] - caps[0]);
    const tier3 = Math.max(0, amount - caps[1]);
    const perTick = tier1 * rates[0] + tier2 * rates[1] + tier3 * rates[2];
    return {
      perTickInterest: Number(perTick.toFixed(2)),
      totalInterest: Number((perTick * termTicks).toFixed(2)),
      totalPct: Number((perTick * termTicks / amount * 100).toFixed(2)),
      dailyRate: Number((perTick / amount * dailyTickTotal * 100).toFixed(1))
    };
  }

  window.updateLoanPreview = function() {
    const loan = state.loanStatus;
    if (!loan || !loan.tier_config) return;
    const amount = Number(document.getElementById('loanAmount')?.value || 0);
    const activeBtn = document.querySelector('.term-btn.active');
    const termTicks = Number(activeBtn?.dataset.term || 0);
    const { caps, rates } = loan.tier_config;
    const dailyTickTotal = loan.daily_tick_total || 8;
    const preview = computeLoanPreview(amount, termTicks, caps, rates, dailyTickTotal);
    const el = document.getElementById('loanInterestPreview');
    if (!el) return;
    if (preview) {
      el.innerHTML = `
        <div class="interest-main">预计总利息 <strong>${money(preview.totalInterest)}</strong></div>
        <div class="interest-detail">
          <span>每期利息 <b>${money(preview.perTickInterest)}</b></span>
          <span>日化率 <b>${preview.dailyRate}%</b></span>
          <span>占本金 <b>${preview.totalPct}%</b></span>
        </div>`;
    } else {
      el.innerHTML = `
        <div class="interest-main">预计总利息 <strong>--</strong></div>
        <div class="interest-detail">
          <span>每期利息 <b>--</b></span>
          <span>日化率 <b>--</b></span>
          <span>占本金 <b>--</b></span>
        </div>`;
    }
  };

  async function borrowLoanRequest(amount) {
    state.loading = true;
    state.error = '';
    render();

    try {
      const termTicks = Number(document.querySelector('.term-btn.active')?.dataset.term || 0);
      state.loanStatus = await api('/api/loan/borrow', { method: 'POST', body: { amount, term_ticks: termTicks } });
      await loadState(false);
      state.notice = `已成功贷款 ${money(amount)}`;
    } catch (error) {
      handleApiError(error, '贷款申请失败');
    } finally {
      state.loading = false;
      render();
    }
  }

  async function repayLoanRequest() {
    const al = state.loanStatus?.active_loan;
    const totalOwed = al ? al.total_to_repay_now : 0;
    if (!await confirmAction({
      title: '提前还清贷款',
      message: `确认提前还清贷款？将从现金扣除 ${money(totalOwed)}。\n本金 + 已产生利息，未到期部分利息不计。`,
      confirmText: '确认还款',
      cancelText: '再想想',
      confirmClass: 'primary',
      tone: 'primary'
    })) return;
    state.loading = true;
    state.error = '';
    render();

    try {
      state.loanStatus = await api('/api/loan/repay', { method: 'POST' });
      await loadState(false);
      state.notice = '贷款已还清';
    } catch (error) {
      handleApiError(error, '还款失败');
    } finally {
      state.loading = false;
      render();
    }
  }

  async function advanceTick() {
    if (!await confirmAction({
      title: '手动补推进一期',
      message: '手动补推进只用于自动时钟异常或临时修复。确认现在补推进一期？',
      confirmText: '确认推进',
      cancelText: '取消'
    })) return;
    state.loading = true;
    state.error = '';
    render();

    try {
      const data = await api('/api/admin/advance', { method: 'POST' });
      state.currentTick = data.tick || state.currentTick;
      await loadState(false);
      await loadRanking(false);
      if (state.user?.is_admin) await loadAdmin(false);
      state.notice = `已手动补推进到第 ${state.currentTick} 期。`;
    } catch (error) {
      handleApiError(error, '推进失败');
    } finally {
      state.loading = false;
      render();
    }
  }

  async function toggleMarketOpen() {
    const forceOpen = !!state.market_clock?.force_open;
    const actionLabel = forceOpen ? '恢复封盘' : '临时解除封盘';
    const message = forceOpen
      ? '确定恢复封盘？交易将回到正常的盘中/盘外时钟。'
      : '确定临时解除封盘？这将暂时允许所有玩家在盘外时间交易。';
    if (!await confirmAction({
      title: actionLabel,
      message,
      confirmText: actionLabel,
      cancelText: '取消'
    })) return;
    state.loading = true;
    state.error = '';
    render();

    try {
      const data = await api('/api/admin/toggle-market', { method: 'POST' });
      await loadState(false);
      if (state.user?.is_admin) await loadAdmin(false);
      state.notice = data.force_open ? '已临时解除封盘，当前可交易。' : '已恢复封盘，交易需在盘中。';
    } catch (error) {
      handleApiError(error, '操作失败');
    } finally {
      state.loading = false;
      render();
    }
  }

  async function resumeMarket() {
    if (!await confirmAction({
      title: '恢复本局',
      message: '确认恢复本局？恢复后不会补跑错过的期数，只会从下一次合法推进时点继续。',
      confirmText: '确认恢复',
      cancelText: '取消'
    })) return;
    state.loading = true;
    state.error = '';
    render();

    try {
      await api('/api/market/resume', { method: 'POST' });
      await loadState(false);
      await loadRanking(false);
      if (state.user?.is_admin) await loadAdmin(false);
      state.notice = '本局已恢复，下一交易时段将继续自动推进。';
    } catch (error) {
      handleApiError(error, '恢复本局失败');
    } finally {
      state.loading = false;
      render();
    }
  }

  async function trade(type, stockCode, lots) {
    if (!state.user || !stockCode || !lots || state.loading) return;
    clearTradeFeedback('stock', { slot: type, code: stockCode });
    const lockReason = getTradeLockReason('market');
    if (lockReason) {
      setTradeFeedback('stock', type, lockReason, 'warning', { code: stockCode });
      render();
      return;
    }
    state.loading = true;
    render();

    try {
      const quotedPrice = getPrice(stockCode).close;
      const data = await api('/api/trade', {
        method: 'POST',
        body: {
          action: type,
          stockCode,
          lots,
          expectedTick: state.currentTick,
          expectedPrice: quotedPrice
        }
      });
      applyState(data);
      await loadRanking(false);
      setTradeFeedback('stock', type, type === 'buy' ? '买入已提交，持仓和现金已刷新。' : '卖出已提交，持仓和现金已刷新。', 'success', { code: stockCode });
    } catch (error) {
      if ((error.message || '').includes('行情已更新到第')) {
        await loadState(false);
      }
      setTradeFeedback('stock', type, error.message || '交易失败', 'error', { code: stockCode });
    } finally {
      state.loading = false;
      render();
    }
  }

  async function tradeCustomLots(type, stockCode, lots) {
    const clampedLots = clampLotsForTrade(type, stockCode, lots);
    await trade(type, stockCode, clampedLots);
  }

  async function tradeByAmount(type, stockCode, amount) {
    const safeAmount = Math.max(0, Number(amount || 0));
    if (!Number.isFinite(safeAmount) || !safeAmount) return;
    const lots = type === 'buy'
      ? getBuyLotsByAmount(stockCode, safeAmount)
      : getSellLotsByAmount(stockCode, safeAmount);
    await trade(type, stockCode, lots);
  }

  async function resetMarket() {
    if (!await confirmAction({
      title: '重置整个市场周期',
      message: '账号和密码会保留，行情、持仓、交易、新闻和排行榜会重置。',
      confirmText: '确认重置',
      cancelText: '取消',
      confirmClass: 'danger',
      tone: 'danger'
    })) return;
    state.loading = true;
    state.error = '';
    render();

    try {
      await api('/api/admin/reset-market', { method: 'POST' });
      await loadState(false);
      await loadRanking(false);
      await loadAdmin(false);
      state.notice = '市场周期已重置，账号和密码已保留。';
    } catch (error) {
      handleApiError(error, '重置市场失败');
    } finally {
      state.loading = false;
      render();
    }
  }

  async function resetPasswords() {
    if (!await confirmAction({
      title: '重置所有普通玩家密码',
      message: '确认重置所有普通玩家密码？玩家将回到未激活状态，需要重新设置密码。',
      confirmText: '确认重置',
      cancelText: '取消',
      confirmClass: 'danger',
      tone: 'danger'
    })) return;
    state.loading = true;
    state.error = '';
    render();

    try {
      const data = await api('/api/admin/reset-passwords', { method: 'POST' });
      await loadRanking(false);
      await loadAdmin(false);
      state.notice = `已重置 ${data.reset_count || 0} 个玩家密码。`;
    } catch (error) {
      handleApiError(error, '重置密码失败');
    } finally {
      state.loading = false;
      render();
    }
  }

  async function resetPlayerPassword(username, nickname) {
    if (!username) return;
    if (!await confirmAction({
      title: `重置 ${nickname} 的密码`,
      message: `确认重置 ${nickname}（${username}）的密码？\n该玩家需要重新设置密码，资金、持仓和交易记录会保留。`,
      confirmText: '确认重置',
      cancelText: '取消',
      confirmClass: 'danger',
      tone: 'danger'
    })) return;
    state.loading = true;
    state.error = '';
    render();

    try {
      await api('/api/admin/reset-password', {
        method: 'POST',
        body: { username }
      });
      await loadRanking(false);
      await loadAdmin(false);
      state.notice = `已重置 ${nickname}（${username}）的密码。`;
    } catch (error) {
      handleApiError(error, '重置玩家密码失败');
    } finally {
      state.loading = false;
      render();
    }
  }

  async function resetPlayer(username, nickname) {
    if (!username) return;
    if (!await confirmAction({
      title: `重置 ${nickname} 资产`,
      message: `确认重置 ${nickname}（${username}）的资产？\n该操作将清空其所有贷款、持仓、交易记录，现金恢复为 100 万，保留密码和激活状态不变。\n通常用于破产玩家复活。`,
      confirmText: '确认重置',
      cancelText: '取消',
      confirmClass: 'danger',
      tone: 'danger'
    })) return;
    state.loading = true;
    state.error = '';
    render();

    try {
      await api('/api/admin/reset-player', {
        method: 'POST',
        body: { username }
      });
      await loadRanking(false);
      await loadAdmin(false);
      state.notice = `已重置 ${nickname}（${username}）的账户。`;
    } catch (error) {
      handleApiError(error, '重置玩家失败');
    } finally {
      state.loading = false;
      render();
    }
  }

  async function deleteAccount(username, nickname) {
    if (!username) return;
    if (!await confirmAction({
      title: `删除 ${nickname} 的账号`,
      message: `确认永久删除 ${nickname}（${username}）？\n该操作将清空其所有数据（资金、持仓、交易、贷款、投注、操作日志），且不可恢复。\n邀请码也将一并回收。`,
      confirmText: '确认删除',
      cancelText: '取消',
      confirmClass: 'danger',
      tone: 'danger',
      kicker: '不可逆操作'
    })) return;
    state.loading = true;
    state.error = '';
    render();

    try {
      await api('/api/admin/delete-account', {
        method: 'POST',
        body: { username }
      });
      await loadRanking(false);
      await loadAdmin(false);
      state.notice = `已删除 ${nickname}（${username}）的账号。`;
    } catch (error) {
      handleApiError(error, '删除账号失败');
    } finally {
      state.loading = false;
      render();
    }
  }

  async function generateInvites(count) {
    state.loading = true;
    state.error = '';
    render();

    try {
      const data = await api('/api/admin/invites/generate', {
        method: 'POST',
        body: { count }
      });
      await loadAdmin(false);
      state.notice = '已生成 ' + data.codes.length + ' 个邀请码。';
    } catch (error) {
      handleApiError(error, '生成邀请码失败');
    } finally {
      state.loading = false;
      render();
    }
  }

  async function saveInviteNickname(code, nickname) {
    state.loading = true;
    state.error = '';
    render();

    try {
      await api('/api/admin/invites/update', {
        method: 'POST',
        body: { code, nickname }
      });
      await loadAdmin(false);
      state.notice = '已更新邀请码 ' + code + ' 的昵称。';
    } catch (error) {
      handleApiError(error, '更新昵称失败');
    } finally {
      state.loading = false;
      render();
    }
  }

  async function revokeInvite(code) {
    state.loading = true;
    state.error = '';
    render();

    try {
      await api('/api/admin/invites/revoke', {
        method: 'POST',
        body: { code }
      });
      await loadAdmin(false);
      state.notice = '已撤销邀请码 ' + code + '。';
    } catch (error) {
      handleApiError(error, '撤销邀请码失败');
    } finally {
      state.loading = false;
      render();
    }
  }

  async function addStock(payload) {
    state.loading = true;
    state.error = '';
    render();

    try {
      const data = await api('/api/admin/stocks', {
        method: 'POST',
        body: payload
      });
      applyAdminStockResult(data);
      await loadState(false);
      state.notice = `已新增股票 ${payload.code}。`;
    } catch (error) {
      handleApiError(error, '新增股票失败');
    } finally {
      state.loading = false;
      render();
    }
  }

  async function updateStock(payload) {
    state.loading = true;
    state.error = '';
    render();

    try {
      const currentCode = payload.currentCode;
      const data = await api('/api/admin/stocks/update', {
        method: 'POST',
        body: payload
      });
      applyAdminStockResult(data);
      if (state.selectedCode === currentCode && data.stock?.code) state.selectedCode = data.stock.code;
      state.adminStockEditCode = '';
      await loadState(false);
      state.notice = `已更新股票 ${data.stock?.code || payload.code}。`;
    } catch (error) {
      handleApiError(error, '更新股票失败');
    } finally {
      state.loading = false;
      render();
    }
  }

  function applyState(data) {
    state.currentTick = data.current_tick || state.currentTick;
    state.market_clock = data.market_clock || state.market_clock;
    state.user = data.user || state.user;
    if (Array.isArray(data.stocks) && data.stocks.length) STOCKS = data.stocks;
    state.market_overview = data.market_overview || state.market_overview;
    state.prices = data.prices || [];
    state.holdings = data.holdings || [];
    state.transactions = data.transactions || [];
    state.history = data.history || [];
    state.selected_trade_activity = data.selected_trade_activity || null;
    state.news = data.news || [];
    state.kol_comments = data.kol_comments || [];
    state.sleeping = data.sleeping || (data.market_clock?.sleeping) || false;
    state.stock_news = data.stock_news || [];
    if (data.active_loan !== undefined) state.activeLoan = data.active_loan;
    if (data.is_bankrupt !== undefined) state.isBankrupt = data.is_bankrupt;

    setTimeout(() => checkLoanWarning(), 0);
  }

  function applyAdminStockResult(data) {
    if (!state.admin) state.admin = {};
    if (Array.isArray(data.stocks)) {
      state.admin.stocks = data.stocks;
      STOCKS = data.stocks;
    }
    if (data.next_stock_code) state.admin.next_stock_code = data.next_stock_code;
  }

  async function api(path, options = {}) {
    const init = { method: options.method || 'GET', headers: {} };
    if (state.token) init.headers.Authorization = `Bearer ${state.token}`;
    if (options.body) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    const response = await fetch(`${API_BASE}${path}`, init);
    const result = await response.json();
    if (!response.ok || result.code !== 0) {
      throw new Error(result.message || '请求失败');
    }
    return result.data;
  }

  async function loadFutures(showLoading) {
    if (!state.token) return;
    if (showLoading) {
      state.loading = true;
      state.error = '';
      render();
    }
    try {
      const [list, status, history, fundHistory] = await Promise.all([
        api('/api/futures/list'),
        api('/api/futures/status'),
        api('/api/futures/history'),
        api('/api/funds/history')
      ]);
      state.futuresList = list || [];
      state.futuresStatus = status || createEmptyFuturesStatus();
      state.futuresHistory = history || [];
      state.fundHistory = fundHistory || state.fundHistory || [];
      if (!state.futuresList.some((u) => u.code === state.selectedFuturesCode)) {
        state.selectedFuturesCode = state.futuresList[0]?.code || null;
      }
      if (state.selectedFuturesCode) {
        await loadFuturesDetail(state.selectedFuturesCode);
      } else {
        state.selectedFuturesDetail = null;
      }
    } catch (error) {
      handleApiError(error, '期货数据加载失败');
    } finally {
      state.loading = false;
      if (showLoading) render();
    }
  }

  async function loadFuturesDetail(code) {
    if (!code) {
      state.selectedFuturesDetail = null;
      return;
    }
    try {
      state.selectedFuturesDetail = await api(`/api/futures/${encodeURIComponent(code)}`);
    } catch (error) {
      handleApiError(error, '期货详情加载失败');
    }
  }

  function updateFuturesCalc() {
    const form = document.querySelector('.futures-form');
    if (!form) return;
    const sideEl = form.querySelector('[name="futures-side"]:checked');
    const contractsEl = form.querySelector('[name="futures-contracts"]');
    const leverageEl = form.querySelector('[name="futures-leverage"]');
    if (!sideEl || !contractsEl || !leverageEl) return;
    const side = sideEl.value;
    const contracts = parseInt(contractsEl.value, 10) || 1;
    const leverage = parseInt(leverageEl.value, 10) || 1;
    const detail = state.selectedFuturesDetail;
    if (!detail) return;
    // 以 state 为准持久化所选方向，使其在后续任何 render（行情刷新/资金不足等校验失败后刷新）后仍保留
    if (detail.code) state.futuresSide[detail.code] = side;
    const price = detail.price || 0;
    const mult = detail.mult || 1;
    const contractValue = price * mult * contracts;
    const margin = contractValue / leverage;
    const maintRate = 0.05;
    const liqPriceLong = Number((price * (1 - 1 / leverage + maintRate)).toFixed(2));
    const liqPriceShort = Number((price * (1 + 1 / leverage - maintRate)).toFixed(2));

    const cvEl = document.getElementById('calc-contract-value');
    const mEl = document.getElementById('calc-margin');
    const llEl = document.getElementById('calc-liq-long');
    const lsEl = document.getElementById('calc-liq-short');
    if (cvEl) cvEl.textContent = contractValue.toLocaleString();
    if (mEl) mEl.textContent = margin.toLocaleString();
    if (llEl) llEl.textContent = liqPriceLong.toFixed(2);
    if (lsEl) lsEl.textContent = liqPriceShort.toFixed(2);
  }

  // 自定义杠杆下拉：收起 / 选择
  function closeLevSelect(sel) {
    sel.classList.remove('open');
    const trigger = sel.querySelector('.lev-select-trigger');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    const menu = sel.querySelector('.lev-select-menu');
    if (menu) menu.hidden = true;
  }

  function pickLeverage(optionEl) {
    const sel = optionEl.closest('.lev-select');
    if (!sel) return;
    const val = parseInt(optionEl.dataset.value, 10);
    // 以 state 为准持久化用户选择，使其在后续任何 render（行情刷新/开仓后刷新）后仍保留
    const code = optionEl.closest('[data-code]')?.dataset?.code || state.selectedFuturesCode;
    if (code) state.futuresLeverage[code] = val;
    const input = sel.querySelector('input[name="futures-leverage"]');
    if (input) input.value = String(val);
    const valueLabel = sel.querySelector('.lev-select-value');
    if (valueLabel) valueLabel.textContent = `${val}x`;
    sel.querySelectorAll('.lev-option').forEach((o) => o.classList.toggle('is-selected', parseInt(o.dataset.value, 10) === val));
    sel.classList.toggle('is-danger', val >= futuresDangerLine(code));
    closeLevSelect(sel);
    updateFuturesCalc();
  }

  // 提交开仓时按所选杠杆做风险确认：仅当杠杆 ≥ 该标的危险线（默认+1）时弹出确认
  async function confirmFuturesLeverage(code, leverage) {
    const dangerLine = futuresDangerLine(code);
    if (!(leverage >= dangerLine)) return true;
    const maintRate = 0.05;
    const movePct = ((1 / leverage - maintRate) * 100).toFixed(1);
    const name = (state.futuresList.find(u => u.code === code) || {}).name || code;
    return confirmAction({
      tone: 'danger',
      confirmClass: 'danger',
      wide: true,
      title: '高杠杆风险确认',
      message: `${name} · ${leverage} 倍杠杆：价格反向波动 ${movePct}% 即触发强制平仓。\n若穿仓，您的股票和基金将被强制变卖以填补亏空。\n确认继续？`,
      confirmText: '确认开仓',
      cancelText: '取消'
    });
  }

  async function openFuturesPosition(code, side, contracts, leverage) {
    clearTradeFeedback('futures', { slot: 'open', code });
    state.loading = true;
    render();
    try {
      const underlying = state.futuresList.find(u => u.code === code);
      await api('/api/futures/open', {
        method: 'POST',
        body: { code, side, contracts, leverage, expectedTick: state.currentTick, expectedPrice: underlying ? underlying.price : 0 }
      });
      await Promise.all([loadState(false), loadFutures(false)]);
      setTradeFeedback('futures', 'open', side === 'long' ? '期货开多成功。' : '期货开空成功。', 'success', { code });
    } catch (error) {
      setTradeFeedback('futures', 'open', error.message || '开仓失败', 'error', { code });
    } finally {
      state.loading = false;
      render();
    }
  }

  async function closeFuturesPosition(positionId) {
    const status = state.futuresStatus;
    const pos = (status && status.positions || []).find(p => p.id === positionId);
    const feedbackCode = pos ? pos.code : state.selectedFuturesCode;
    clearTradeFeedback('futures', { slot: 'close', code: feedbackCode, positionId });
    state.loading = true;
    render();
    try {
      const underlying = pos ? state.futuresList.find(u => u.code === pos.code) : null;
      await api('/api/futures/close', {
        method: 'POST',
        body: { positionId, expectedTick: state.currentTick, expectedPrice: underlying ? underlying.price : 0 }
      });
      await Promise.all([loadState(false), loadFutures(false)]);
      setTradeFeedback('futures', 'close', '期货平仓成功。', 'success', {
        code: feedbackCode,
        positionId,
        positionMeta: pos ? { name: pos.name, side: pos.side, leverage: pos.leverage, contracts: pos.contracts } : null
      });
    } catch (error) {
      setTradeFeedback('futures', 'close', error.message || '平仓失败', 'error', {
        code: feedbackCode,
        positionId,
        positionMeta: pos ? { name: pos.name, side: pos.side, leverage: pos.leverage, contracts: pos.contracts } : null
      });
    } finally {
      state.loading = false;
      render();
    }
  }

  function handleApiError(error, fallback) {
    const message = error.message || fallback;
    if (message.includes('登录')) clearSession(false);
    setError(message);
  }

  function clearSession(keepAccount) {
    if (_clockTimer) {
      clearInterval(_clockTimer);
      _clockTimer = null;
    }
    localStorage.removeItem(SESSION_KEY);
    const savedUsername = String(state.user?.username || state.loginUsername || '').trim();
    const shouldForgetAccount = !keepAccount || !!state.user?.is_admin || savedUsername === 'SSB-DEMO';
    if (shouldForgetAccount) localStorage.removeItem(ACCOUNT_KEY);
    state.token = '';
    state.user = null;
    state.view = 'market';
    syncRouteToView(true);
    state.ranking = null;
    state.admin = null;
    state.loanStatus = null;
    state.activeLoan = null;
    state.isBankrupt = false;
    state.sleeping = false;
    state.fundsList = [];
    state.fundsStatus = [];
    state.fundHistory = [];
    state.selectedFund = null;
    state.futuresList = [];
    state.futuresStatus = null;
    state.futuresHistory = [];
    state.selectedFuturesCode = null;
    state.futuresModalOpen = false;
    state.selectedFuturesDetail = null;
    state.sportsOverview = null;
    state.sportsSchedule = null;
    state.sportsPlayoffs = null;
    state.sportsStandings = [];
    state.sportsAccount = null;
    clearTradeFeedback();
    if (shouldForgetAccount) state.loginUsername = '';
  }

  function startLiveClock() {
    state.liveBeijingTime = new Date();
    if (_clockTimer) return;
    const ADVANCE_HOURS = [8, 9, 10, 11, 13, 14, 15, 16];
    const OVERVIEW_ADVANCE_HOURS = [17];
    _clockTimer = setInterval(() => {
      state.liveBeijingTime = new Date();
      const liveEls = document.querySelectorAll('[data-live-time]');
      if (liveEls.length) {
        const text = liveBeijingTimeText();
        for (const el of liveEls) el.textContent = text;
      }
      if (!state.user) return;
      const now = state.liveBeijingTime;
      const parts = now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).split(/[:\s]+/);
      const hour = Number(parts[0]);
      const minute = parts[1];
      const second = parts[2];
      if (ADVANCE_HOURS.includes(hour) && minute === '00' && second === '02') {
        const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
        const key = `${dateStr}-${String(hour).padStart(2, '0')}`;
        if (key !== _lastAutoRefreshKey) {
          _lastAutoRefreshKey = key;
          refreshCurrentView();
        }
      }
      if (OVERVIEW_ADVANCE_HOURS.includes(hour) && minute === '00' && second === '02') {
        const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
        const key = `${dateStr}-${String(hour).padStart(2, '0')}`;
        if (key !== _lastAutoRefreshKey) {
          _lastAutoRefreshKey = key;
          refreshCurrentView();
        }
      }
    }, 1000);
  }

  function liveBeijingTimeText() {
    const d = state.liveBeijingTime || new Date();
    return d.toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  }

  function getLiquidationAlertData() {
    const tick = state.currentTick;
    if (state.liquidationAlertShownTick === tick) return null;
    const all = (state.futuresHistory || []).filter(tx =>
      tx.tick === tick && (tx.type === 'liquidation' || tx.type === 'deficit_recovery')
    );
    if (!all.length) return null;

    const liqEvents = all.filter(e => e.type === 'liquidation');
    const defEvents = all.filter(e => e.type === 'deficit_recovery');
    const forcedStocks = (state.transactions || []).filter(tx => tx.tick === tick && tx.type === 'forced_liquidation');
    const forcedFunds = (state.fundHistory || []).filter(tx => tx.tick === tick && tx.type === 'forced_liquidation');

    const liqTotal = liqEvents.reduce((s, e) => s + Math.abs(Number(e.pnl || 0)), 0);
    const defTotal = defEvents.reduce((s, e) => s + Math.abs(Number(e.pnl || 0)), 0);
    const totalLoss = liqTotal + defTotal;

    return { tick, liqEvents, defEvents, forcedStocks, forcedFunds, liqTotal, defTotal, totalLoss };
  }

  function renderLiquidationAlertHtml() {
    const d = getLiquidationAlertData();
    if (!d) return '';

    const rows = [];
    if (d.liqEvents.length) {
      rows.push('<div class="liq-alert-section-title">── 强制平仓 ──</div>');
      for (const e of d.liqEvents) {
        const name = e.name || e.code || '';
        const side = e.side === 'long' ? '做多' : '做空';
        const contracts = e.contracts || 0;
        const pnl = Number(e.pnl || 0);
        rows.push(`<div class="liq-alert-row"><span>${escapeHtml(name)} · ${side} · ${contracts} 张</span><span class="liq-alert-amount down">${money(pnl)}</span></div>`);
      }
    }
    if (d.defEvents.length) {
      rows.push('<div class="liq-alert-section-title">── 穿仓追偿 ──</div>');
      for (const e of d.defEvents) {
        const name = e.name || e.code || '';
        const pnl = Number(e.pnl || 0);
        rows.push(`<div class="liq-alert-row"><span>${escapeHtml(name)} · 穿仓缺口</span><span class="liq-alert-amount down">${money(pnl)}</span></div>`);
      }
      if (d.forcedStocks.length) {
        rows.push('<div class="liq-alert-subtitle">追偿卖出股票</div>');
        for (const s of d.forcedStocks) {
          const stockName = (STOCKS.find(x => x.code === s.stock_code) || {}).name || s.stock_code;
          rows.push(`<div class="liq-alert-row"><span>${escapeHtml(stockName)} · ${s.quantity || 0} 股</span><span class="liq-alert-amount down">${money(s.total_amount || s.quantity * s.price || 0)}</span></div>`);
        }
      }
      if (d.forcedFunds.length) {
        rows.push('<div class="liq-alert-subtitle">追偿赎回基金</div>');
        for (const f of d.forcedFunds) {
          const fundName = (state.fundsList || []).find(x => x.code === f.fund_code)?.name || f.fund_name || f.fund_code || '';
          rows.push(`<div class="liq-alert-row"><span>${escapeHtml(fundName)}</span><span class="liq-alert-amount down">${money(f.amount || 0)}</span></div>`);
        }
      }
    }
    rows.push(`<div class="liq-alert-divider"></div>`);
    rows.push(`<div class="liq-alert-row liq-alert-total"><strong>本期总计损失</strong><strong class="down">${money(d.totalLoss)}</strong></div>`);

    return `
      <div class="confirm-modal-layer" id="liq-alert-overlay" onclick="if(event.target===this)window.dismissLiquidationAlert()">
        <div class="confirm-modal confirm-modal-wide" role="dialog" aria-modal="true">
          <div class="confirm-modal-body">
            <div class="confirm-modal-kicker">系统通知</div>
            <h2 class="confirm-modal-title">⚠️ 期货强平通知 · 第 ${d.tick} 期</h2>
            <div class="confirm-modal-copy liq-alert-body">${rows.join('')}</div>
            <div class="confirm-modal-actions">
              <button class="primary" type="button" onclick="window.dismissLiquidationAlert()">知道了</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  window.dismissLiquidationAlert = function() {
    state.liquidationAlertShownTick = state.currentTick;
    render();
  };

  function render() {
    appRoot.innerHTML = `
      <div class="shell">
        ${renderTopbar()}
        ${state.user ? renderDashboard() : (state.token ? renderRestoringOverlay() : renderLogin())}
        ${renderSiteFooter()}
      </div>
      <div id="treemap-tooltip" class="treemap-tooltip" style="display:none;"></div>
      ${state.view === 'futures' ? renderLiquidationAlertHtml() : ''}
    `;
    sanitizeLoginField();
    syncNoticeAutoDismiss();
    if (state.view === 'loan' && state.loanTab === 'p2p' && state.p2pStatus && !state.p2pStatus.has_active_p2p) {
      setTimeout(function() { loadP2POrders(); }, 0);
    }
    if (state.view === 'guide') {
      setTimeout(setupGuideScrollSpy, 0);
    }
  }

  function setupGuideScrollSpy() {
    var links = document.querySelectorAll('[data-guide-link]');
    var bar = document.getElementById('guideNavBar');
    if (!links.length) return;
    var headings = [];
    links.forEach(function(l) {
      var el = document.getElementById(l.getAttribute('data-guide-link'));
      if (el) headings.push({ el: el, link: l });
    });
    function moveBar(link) {
      if (!bar || !link) return;
      var li = link.parentNode;
      bar.style.top = li.offsetTop + 'px';
      bar.style.height = li.offsetHeight + 'px';
    }
    var observer = new IntersectionObserver(function(entries) {
      entries.forEach(function(e) {
        if (e.isIntersecting) {
          var id = e.target.id;
          links.forEach(function(l) {
            var match = l.getAttribute('data-guide-link') === id;
            l.classList.toggle('active', match);
            if (match) moveBar(l);
          });
        }
      });
    }, { rootMargin: '-80px 0px -60% 0px' });
    headings.forEach(function(h) { observer.observe(h.el); });
  }

  function renderSiteFooter() {
    const icpText = String(FILING_CONFIG.icpText || '').trim();
    const icpUrl = String(FILING_CONFIG.icpUrl || 'https://beian.miit.gov.cn/').trim();
    const publicSecurityText = String(FILING_CONFIG.publicSecurityText || '').trim();
    const publicSecurityUrl = String(FILING_CONFIG.publicSecurityUrl || '').trim();
    const icpLink = icpText
      ? `<a href="${escapeHtml(icpUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(icpText)}</a>`
      : '';
    const publicSecurityLink = publicSecurityText
      ? `<a class="public-security-record" href="${escapeHtml(publicSecurityUrl || '#')}" target="_blank" rel="noopener noreferrer">
            <svg class="public-security-record-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 2.5 20 5v6.2c0 5.2-3.3 8.7-8 10.3-4.7-1.6-8-5.1-8-10.3V5l8-2.5Z"></path>
              <path d="m8.7 11.7 2.1 2.1 4.6-4.6"></path>
            </svg>
            <span>${escapeHtml(publicSecurityText)}</span>
          </a>`
      : '';
    return `
      <footer class="site-footer">
        <div class="site-footer-inner">
          <span class="site-footer-copyright">© 2026 SSB Exchange</span>
          ${icpLink}
          ${publicSecurityLink}
        </div>
      </footer>
    `;
  }

  function syncNoticeAutoDismiss() {
    if (!state.notice) {
      clearNoticeTimer();
      return;
    }
    if (_noticeTimer && _noticeTimerMessage === state.notice) return;
    clearNoticeTimer();
    _noticeTimerMessage = state.notice;
    _noticeTimer = setTimeout(() => {
      if (state.notice !== _noticeTimerMessage) return;
      state.notice = '';
      clearNoticeTimer();
      render();
    }, NOTICE_TIMEOUT_MS);
  }

  function clearNoticeTimer() {
    if (_noticeTimer) clearTimeout(_noticeTimer);
    _noticeTimer = null;
    _noticeTimerMessage = '';
  }

  function sanitizeLoginField() {
    if (state.user || typeof appRoot.querySelector !== 'function') return;
    const loginInput = appRoot.querySelector('#loginUsername');
    if (!loginInput) return;
    const raw = String(loginInput.value || '').trim().toUpperCase();
    if (raw === 'SSB-DEMO') loginInput.value = '';
  }

  function renderTopbar() {
    return `
      <header class="topbar">
        <div class="topbar-inner">
          <div class="brand">
            <img class="brand-mark" src="./apple-touch-icon.png" alt="SSB 交易所图标">
            <div class="brand-copy">
              <div class="brand-title">SSB 交易所</div>
              <div class="brand-subtitle">第 ${state.currentTick} 期 · ${state.sleeping ? '⏸ 休眠中' : marketClockShortText()}</div>
            </div>
          </div>
          <div class="toolbar">
            ${state.user ? navButton('market', '股票') : ''}
            ${state.user ? navButton('funds', '基金') : ''}
            ${state.user ? navButton('futures', '期货') : ''}
            ${state.user ? navButton('sports', '赛事') : ''}
            ${state.user ? navButton('news', '新闻') : ''}
            ${state.user ? navButton('holdings', '持仓') : ''}
            ${state.user ? navButton('account', '账户') : ''}
            ${state.user ? navButton('loan', '贷款') : ''}
            ${state.user ? navButton('ranking', '排行') : ''}
            ${state.user ? navButton('guide', '教程') : ''}
            ${state.user && state.user.is_admin ? navButton('admin', '运营台') : ''}
            ${state.user ? '<button class="secondary" data-action="logout">退出</button>' : ''}
          </div>
        </div>
      </header>
    `;
  }

  function navButton(view, label) {
    return `<button class="secondary nav-button ${state.view === view ? 'active' : ''}" data-action="set-view" data-view="${view}">${label}</button>`;
  }

  function renderClockBadge(clockData = state.market_clock) {
    if (!clockData) return '';
    return `
      <div class="clock-badge ${clockData.trading_allowed ? 'clock-open' : 'clock-closed'}">
        <strong>${clockData.sleeping ? '休眠中' : (clockData.trading_allowed ? '开盘中' : '封盘中')}</strong>
        <span data-live-time>${liveBeijingTimeText()}</span> · 今日 ${tickProgressText(clockData)}</span>
      </div>
    `;
  }

  function renderClockPanel(clockData = state.market_clock) {
    if (!clockData) return '';
    return `
      <div class="clock-panel ${clockData.trading_allowed ? 'clock-open' : 'clock-closed'}">
        <div>
          <div class="muted">市场时间</div>
          <strong>${clockData.sleeping ? '休眠中' : (clockData.trading_allowed ? '开盘中' : '封盘中')}</strong>
        </div>
        <div>
          <div class="muted">北京时间</div>
          <strong data-live-time>${liveBeijingTimeText()}</strong>
        </div>
        <div>
          <div class="muted">今日进度</div>
          <strong>${tickProgressText(clockData)} 期</strong>
        </div>
        <div>
          <div class="muted">下次推进</div>
          <strong>${clockData.sleeping ? '休眠中' : clockTime(clockData.next_advance_at)}</strong>
        </div>
      </div>
    `;
  }

  function renderSleepBanner(clockData = state.market_clock) {
    if (!state.user || !clockData?.sleeping) return '';
    return `
      <section class="notice" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
        <div>⏸ ${escapeHtml(sleepReasonMessage(clockData))}</div>
        <button class="primary" data-action="resume-market" ${state.loading ? 'disabled' : ''}>恢复本局</button>
      </section>
    `;
  }

  function renderRestoringOverlay() {
    return `
      <main class="login-wrap">
        <section class="panel panel-pad login-panel" style="text-align:center;">
          <h1 class="title" style="margin-bottom:8px;">SSB 交易所</h1>
          <p class="muted" style="margin-bottom:18px;">正在恢复交易会话…</p>
          <div class="loading-dots"><span></span><span></span><span></span></div>
        </section>
      </main>
    `;
  }

  function renderLogin() {
    if (state.authStep === 'register') {
      return `
        <main class="login-wrap">
          <section class="panel panel-pad login-panel">
            <h1 class="title">注册新账号</h1>
            <form data-form="register">
              <div class="field">
                <label for="inviteCode">邀请码</label>
                <input id="inviteCode" name="inviteCode" autocomplete="off" placeholder="例如 K7M2QX" required>
              </div>
              <div class="field">
                <label for="regUsername">用户名</label>
                <input id="regUsername" name="username" autocomplete="username" placeholder="3-20 位字母/数字/下划线" maxlength="20" required>
              </div>
              <div class="field">
                <label for="regPassword">密码</label>
                <input id="regPassword" name="password" type="password" autocomplete="new-password" minlength="6" required>
                <div class="field-hint">至少 6 位</div>
              </div>
              <div class="field">
                <label for="regConfirmPassword">确认密码</label>
                <input id="regConfirmPassword" name="confirmPassword" type="password" autocomplete="new-password" minlength="6" required>
              </div>
              <div class="login-actions">
                <button class="primary" type="submit" ${state.loading ? 'disabled' : ''}>${state.loading ? '注册中...' : '注册并进入市场'}</button>
                <button class="secondary" type="button" data-action="switch-to-login">已有账号？登录</button>
              </div>
              ${renderLoginMessages()}
            </form>
          </section>
        </main>
      `;
    }

    if (state.authStep === 'reset-password') {
      return `
        <main class="login-wrap">
          <section class="panel panel-pad login-panel">
            <h1 class="title">重置密码</h1>
            <p class="muted">管理员已重置你的密码，请设置一个新密码激活账号</p>
            <form data-form="reset-password">
              <div class="field">
                <label for="resetUsername">用户名</label>
                <input id="resetUsername" name="username" value="${escapeHtml(state.loginUsername || '')}" autocomplete="username" placeholder="用户名" required>
              </div>
              <div class="field">
                <label for="resetPassword">新密码</label>
                <input id="resetPassword" name="password" type="password" autocomplete="new-password" minlength="6" required>
                <div class="field-hint">至少 6 位</div>
              </div>
              <div class="field">
                <label for="resetConfirmPassword">确认新密码</label>
                <input id="resetConfirmPassword" name="confirmPassword" type="password" autocomplete="new-password" minlength="6" required>
              </div>
              <div class="login-actions">
                <button class="primary" type="submit" ${state.loading ? 'disabled' : ''}>${state.loading ? '设置中...' : '设置密码并进入市场'}</button>
                <button class="secondary" type="button" data-action="switch-to-login">返回登录</button>
              </div>
              ${renderLoginMessages()}
            </form>
          </section>
        </main>
      `;
    }

    return `
      <main class="login-wrap">
        <section class="panel panel-pad login-panel">
          <h1 class="title">输入账号进入市场</h1>
          <p class="muted">新玩家请先联系管理员获取邀请码</p>
          <form data-form="login">
            <div class="field">
              <label for="loginUsername">用户名</label>
              <input id="loginUsername" name="username" value="${escapeHtml(state.loginUsername || '')}" autocomplete="username" placeholder="用户名" required>
            </div>
            <div class="field">
              <label for="loginPassword">密码</label>
              <input id="loginPassword" name="password" type="password" autocomplete="current-password">
              <div class="field-hint" style="text-align:right;margin-top:2px;">
                <span class="muted" style="cursor:pointer;font-size:0.85em;" data-action="switch-to-reset-password" role="button" tabindex="0">忘记密码？</span>
              </div>
            </div>
            <div class="login-actions">
              <button class="primary" type="submit" ${state.loading ? 'disabled' : ''}>${state.loading ? '登录中...' : '进入市场'}</button>
              <button class="secondary" type="button" data-action="switch-to-register">没有账号？注册</button>
            </div>
            ${renderLoginMessages()}
          </form>
        </section>
      </main>
    `;
  }

  function renderLoginMessages() {
    return `
      ${state.notice ? `<div class="notice">${escapeHtml(state.notice)}</div>` : ''}
      ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
    `;
  }

  function renderDashboard() {
    return `
      <main class="container">
        ${state.notice ? `<div class="notice">${escapeHtml(state.notice)}</div>` : ''}
        ${state.error ? `<div class="notice error">${escapeHtml(state.error)}</div>` : ''}
        ${renderSleepBanner()}
        ${state.view === 'news' ? renderNewsView() : ''}
        ${state.view === 'funds' ? renderFundsView() : ''}
        ${state.view === 'holdings' ? renderHoldingsView() : ''}
        ${state.view === 'account' ? renderAccountView() : ''}
        ${state.view === 'loan' ? renderLoanView() : ''}
        ${state.view === 'ranking' ? renderRanking() : ''}
        ${state.view === 'admin' ? renderAdmin() : ''}
        ${state.view === 'market' ? renderMarket() : ''}
        ${state.view === 'futures' ? renderFuturesView() : ''}
        ${state.view === 'sports' ? renderSportsView() : ''}
        ${state.view === 'guide' ? renderGuide() : ''}
        ${state.stockModalOpen ? renderStockModal() : ''}
      </main>
    `;
  }


  function createEmptyFuturesStatus() {
    return {
      positions: [],
      summary: {
        futuresValue: 0,
        totalMargin: 0,
        totalUnrealizedPnl: 0,
        remainingExposure: 0
      }
    };
  }

  function futuresPnlClass(value) {
    if (value > 0) return 'up';
    if (value < 0) return 'down';
    return 'flat';
  }

  function formatSignedNumber(value) {
    const num = Number(value || 0);
    if (num > 0) return `+${num.toLocaleString()}`;
    return num.toLocaleString();
  }

  function buildFuturesPositionMap(positions) {
    return (positions || []).reduce((map, position) => {
      if (!map[position.code]) map[position.code] = [];
      map[position.code].push(position);
      return map;
    }, {});
  }

  function summarizeFuturesExposure(positions) {
    if (!positions || !positions.length) {
      return {
        hasPosition: false,
        toneClass: 'muted',
        text: '未持仓'
      };
    }

    let longContracts = 0;
    let shortContracts = 0;
    let totalPnl = 0;
    for (const position of positions) {
      totalPnl += Number(position.unrealizedPnl || 0);
      if (position.side === 'long') longContracts += Number(position.contracts || 0);
      else shortContracts += Number(position.contracts || 0);
    }

    const bidirectional = longContracts > 0 && shortContracts > 0;
    const toneClass = futuresPnlClass(totalPnl);
    if (bidirectional) {
      return {
        hasPosition: true,
        toneClass,
        text: `双向持仓 · ${positions.length}笔 · ${formatSignedNumber(totalPnl)}`
      };
    }

    const sideLabel = longContracts > 0 ? '多' : '空';
    const totalContracts = longContracts || shortContracts;
    return {
      hasPosition: true,
      toneClass,
      text: `${sideLabel} · ${totalContracts}张 · ${formatSignedNumber(totalPnl)}`
    };
  }

  function renderFuturesView() {
    const list = state.futuresList || [];
    const status = state.futuresStatus || createEmptyFuturesStatus();
    const detail = state.selectedFuturesDetail;
    const positionsByCode = buildFuturesPositionMap(status.positions);
    const tracks = [
      { key: 'commodity', label: '商品期货' },
      { key: 'index', label: '海外指数期货' },
      { key: 'crypto', label: '虚拟币期货' },
      { key: 'fx', label: '外汇期货' }
    ];

    function renderCard(u) {
      const cls = u.change_pct >= 0 ? 'up' : 'down';
      const sign = u.change_pct >= 0 ? '+' : '';
      const exposure = summarizeFuturesExposure(positionsByCode[u.code] || []);
      return `<button class="fund-row futures-row ${u.code === state.selectedFuturesCode ? 'active' : ''}" data-action="select-futures" data-code="${escapeHtml(u.code)}">
        <div class="futures-row-main">
          <strong>${escapeHtml(u.name)}</strong>
          <div class="futures-row-exposure ${exposure.hasPosition ? `has-position ${exposure.toneClass}` : 'muted'}">${escapeHtml(exposure.text)}</div>
        </div>
        <span class="tag tag-${futuresTrackRiskLevel(u.track)}">${riskLabel(futuresTrackRiskLevel(u.track))}</span>
        <div class="num">
          <div class="fund-nav-label">现价</div>
          <strong class="${cls}">${u.price.toFixed(2)}</strong>
          <div class="${cls}">${sign}${(u.change_pct * 100).toFixed(2)}%</div>
        </div>
        <div class="num futures-row-margin">
          <div class="fund-nav-label">1张保证金</div>
          <strong>${u.minMargin.toLocaleString()}</strong>
        </div>
      </button>`;
    }

    return `<div class="fund-layout futures-layout">
      <section class="panel panel-pad futures-market-panel">
        <div class="panel-head">
          <div>
            <h1 class="title">期货市场</h1>
          </div>
        </div>
        <div class="futures-risk-banner" role="note">
          <p class="futures-risk-line">期货为高杠杆品种，可能损失全部保证金并触发穿仓追偿。</p>
          <p class="futures-risk-line">穿仓追偿：强制变卖您的股票、基金。</p>
        </div>
        ${tracks.map(track => {
          const items = list.filter(u => u.track === track.key);
          if (!items.length) return '';
          return `<h3 class="section-title fund-group-title">${track.label}</h3>
            <div class="fund-list">${items.map(renderCard).join('')}</div>`;
        }).join('')}
      </section>
      ${detail ? renderFuturesDetail(detail, status) : '<section class="panel panel-pad fund-detail"><div class="empty">暂无期货品种</div></section>'}
    </div>`;
  }

  function renderFuturesDetail(detail, status) {
    const underlying = state.futuresList.find(u => u.code === detail.code) || {};
    const futuresStatus = status || createEmptyFuturesStatus();
    const selectedPositions = (futuresStatus.positions || []).filter((position) => position.code === detail.code);
    const contractPnl = selectedPositions.reduce((sum, p) => sum + Number(p.unrealizedPnl), 0);
    const exposureMax = Math.floor(Number(futuresStatus.summary.remainingExposure || 0) / (detail.minMargin || 1));
    const cashMax = Math.floor(Number(state.user?.cash || 0) / ((detail.minMargin || 1) * 1.01));
    const maxContracts = Math.max(0, Math.min(exposureMax, cashMax));
    const maxLev = detail.maxLeverage || underlying.maxLeverage || 5;
    const contracts = 1;
    // 默认杠杆按标的波动率分档（4-tick 均衡缓冲），封顶该标的 maxLev；
    // 若用户已为该标的选过杠杆，则沿用其选择（render 后从 state 重建，避免重置回默认）
    const defaultLev = Math.min(maxLev, FUTURES_DEFAULT_LEVERAGE[detail.code] || 6);
    const storedLev = state.futuresLeverage[detail.code];
    const leverage = storedLev != null ? Math.min(storedLev, maxLev) : defaultLev;
    const storedSide = state.futuresSide[detail.code];
    const side = storedSide === 'short' ? 'short' : 'long';
    const price = detail.price || 0;
    const contractValue = price * detail.mult * contracts;
    const margin = contractValue / leverage;
    const maintRate = 0.05;
    const liqPriceLong = Number((price * (1 - 1 / leverage + maintRate)).toFixed(2));
    const liqPriceShort = Number((price * (1 + 1 / leverage - maintRate)).toFixed(2));
    const priceHistory = detail.prices || [];
    const chartHistory = priceHistory.map(row => ({ tick: row.tick, close: row.price })).filter(h => h.close > 0);
    const futuresWindow = chartHistory.slice(-CHART_HISTORY_WINDOW);
    const fWinMinTick = futuresWindow.length ? futuresWindow[0].tick : 0;
    const futuresTrades = (state.futuresHistory || [])
      .filter(tx => tx.code === detail.code && (tx.type === 'open' || tx.type === 'close') && tx.tick >= fWinMinTick)
      .map(tx => ({ tick: tx.tick, type: (tx.type === 'open' ? 'buy' : 'sell') + '_' + tx.side }));
    const tradeLockReason = getTradeLockReason('futures');
    const canTrade = !tradeLockReason;
    const openFeedback = getTradeFeedback('futures', 'open', { code: detail.code });
    const closeFeedbackEntries = state.tradeFeedback.futures.code === detail.code ? state.tradeFeedback.futures.closeByPositionId || {} : {};

    function renderPosition(pos) {
      const pnlCls = futuresPnlClass(pos.unrealizedPnl);
      const distCls = pos.liquidationDistance > 0.3 ? 'safe' : (pos.liquidationDistance > 0.15 ? 'warn' : 'danger');
      const sideLabel = pos.side === 'long' ? '多' : '空';
      const sideCls = pos.side === 'long' ? 'side-long' : 'side-short';
      const closeFeedback = getTradeFeedback('futures', 'close', { code: detail.code, positionId: pos.id });
      const closeWarning = '';
      return `<div class="futures-position" data-position-id="${escapeHtml(pos.id)}">
        <div class="futures-pos-header">
          <span class="futures-pos-name">${escapeHtml(pos.name)}</span>
          <span class="futures-pos-side ${sideCls}">${sideLabel} ${pos.leverage}x</span>
          <span class="futures-pos-contracts">${pos.contracts}张</span>
        </div>
        <div class="futures-pos-body">
          <div class="futures-pos-detail">
            <div class="futures-pos-metric">
              <span class="futures-pos-label">开仓价 → 现价</span>
              <strong class="futures-pos-value">${pos.entryPrice.toFixed(2)} → ${pos.currentPrice.toFixed(2)}</strong>
            </div>
            <div class="futures-pos-metric">
              <span class="futures-pos-label">浮盈亏</span>
              <strong class="futures-pos-value ${pnlCls}">${formatSignedNumber(pos.unrealizedPnl)}</strong>
            </div>
            <div class="futures-pos-metric">
              <span class="futures-pos-label">保证金 | 敞口</span>
              <strong class="futures-pos-value">${pos.margin.toLocaleString()} | ${pos.contractValue.toLocaleString()}</strong>
            </div>
            <div class="futures-pos-metric">
              <span class="futures-pos-label">爆仓价 | 距离</span>
              <strong class="futures-pos-value">${pos.liquidationPrice.toFixed(2)} | <span class="${distCls}">${(pos.liquidationDistance * 100).toFixed(1)}%</span></strong>
            </div>
          </div>
          <div class="futures-pos-actions">
            ${renderTradeFeedback(closeFeedback, closeWarning)}
            <button class="sell mini-button futures-close-button" data-action="futures-close" ${state.loading || !canTrade ? 'disabled' : ''}>平仓</button>
          </div>
        </div>
      </div>`;
    }

    function renderCloseFeedbackCard(positionId, entry) {
      if (!entry || !entry.positionMeta) return '';
      const sideLabel = entry.positionMeta.side === 'long' ? '多' : '空';
      const sideCls = entry.positionMeta.side === 'long' ? 'side-long' : 'side-short';
      return `<div class="futures-position futures-position-feedback" data-position-feedback-id="${escapeHtml(positionId)}">
        <div class="futures-pos-header">
          <span class="futures-pos-name">${escapeHtml(entry.positionMeta.name || detail.name)}</span>
          <span class="futures-pos-side ${sideCls}">${sideLabel} ${escapeHtml(entry.positionMeta.leverage || '--')}x</span>
          <span class="futures-pos-contracts">${escapeHtml(entry.positionMeta.contracts || '--')}张</span>
        </div>
        ${renderTradeFeedback(entry, '')}
      </div>`;
    }

    const livePositionIds = new Set(selectedPositions.map((position) => position.id));
    const lingeringCloseFeedbackCards = Object.entries(closeFeedbackEntries)
      .filter(([positionId, entry]) => entry?.positionMeta && !livePositionIds.has(positionId))
      .map(([positionId, entry]) => renderCloseFeedbackCard(positionId, entry))
      .join('');
    const emptyPositionState = !selectedPositions.length && !lingeringCloseFeedbackCards
      ? '<div class="empty futures-empty-card">当前未持仓</div>'
      : '';

    return `<section class="panel panel-pad fund-detail">
      <div class="panel-head">
        <div>
          <h2 class="title">${escapeHtml(detail.name)}</h2>
          <div class="muted">${escapeHtml(detail.code)}</div>
        </div>
        <div class="num">
          <div class="detail-price ${detail.change_pct >= 0 ? 'up' : 'down'}">${price.toFixed(2)}</div>
          <div class="${detail.change_pct >= 0 ? 'up' : 'down'}">${detail.change_pct >= 0 ? '+' : ''}${(detail.change_pct * 100).toFixed(2)}%</div>
        </div>
      </div>
      ${futuresWindow.length >= 2 ? renderLineChart(futuresWindow, '价格走势', 'futures-chart', futuresTrades, { buy_long: '开仓 · 做多', buy_short: '开仓 · 做空', sell_long: '平仓 · 做多', sell_short: '平仓 · 做空', both: '开仓 + 平仓' }) : '<div class="sparkline empty">暂无走势数据</div>'}
      <div class="fund-meta-grid futures-meta-grid">
        <div><span>最高杠杆</span><strong>${detail.maxLeverage}x</strong></div>
        <div><span>1张保证金</span><strong>${detail.minMargin.toLocaleString()}</strong></div>
        <div><span>剩余可开额度</span><strong>${futuresStatus.summary.remainingExposure.toLocaleString()}</strong></div>
        <div><span>持有浮盈</span><strong class="${futuresPnlClass(contractPnl)}">${formatSignedNumber(contractPnl)}</strong></div>
      </div>
      <section class="futures-detail-section">
        <div class="futures-section-head">
          <h3 class="section-title">当前标的持仓</h3>
          <span class="status-pill">${selectedPositions.length ? `${selectedPositions.length} 笔` : '当前未持仓'}</span>
        </div>
        ${selectedPositions.length ? selectedPositions.map(renderPosition).join('') : emptyPositionState}
        ${lingeringCloseFeedbackCards}
      </section>
      <section class="trade-panel futures-trade-panel">
        ${tradeLockReason ? `<div class="trade-closed">${escapeHtml(tradeLockReason)}</div>` : ''}
        <div class="futures-form" data-code="${escapeHtml(detail.code)}">
          <div class="futures-section-head">
            <h3 class="section-title">开仓</h3>
          </div>
          ${renderTradeFeedback(openFeedback, '')}
          <div class="trade-context">
            <div class="trade-context-line"><strong>${escapeHtml(detail.name)}</strong> · 当前价 ${price.toFixed(2)} · 合约乘数 ×${detail.mult}</div>
            <div class="trade-context-line">最高杠杆 ${maxLev}x · 1张保证金约 ${detail.minMargin.toLocaleString()} · 提交时会校验当前价格</div>
          </div>
          <div class="futures-direction-group">
            <span class="futures-field-label">方向</span>
            <div class="futures-direction-options">
              <label class="futures-direction-option futures-direction-option-long">
                <input type="radio" name="futures-side" value="long" ${side === 'long' ? 'checked' : ''} data-action="calc-futures">
                <span>做多</span>
              </label>
              <label class="futures-direction-option futures-direction-option-short">
                <input type="radio" name="futures-side" value="short" ${side === 'short' ? 'checked' : ''} data-action="calc-futures">
                <span>做空</span>
              </label>
            </div>
          </div>
          <div class="futures-field-grid">
            <label class="futures-field">
              <span class="futures-field-label">杠杆</span>
              <div class="lev-select ${leverage >= futuresDangerLine(detail.code) ? 'is-danger' : ''}" data-lev-select>
                <button type="button" class="lev-select-trigger" data-action="lev-toggle" aria-haspopup="listbox" aria-expanded="false">
                  <span class="lev-select-value">${leverage}x</span>
                  <span class="lev-select-caret" aria-hidden="true"></span>
                </button>
                <div class="lev-select-menu" role="listbox" hidden>
                  ${FUTURES_LEVERAGE_TIERS.filter(l => l <= maxLev).map(l => `<button type="button" class="lev-option ${l >= futuresDangerLine(detail.code) ? 'is-danger' : ''} ${l === leverage ? 'is-selected' : ''}" role="option" data-action="lev-pick" data-value="${l}">${l}x</button>`).join('')}
                </div>
                <input type="hidden" name="futures-leverage" value="${leverage}">
              </div>
            </label>
            <label class="futures-field">
              <span class="futures-field-label">张数</span>
              <input type="number" name="futures-contracts" id="futures-contracts-input" min="1" step="1" data-clamp="futures-contracts" data-code="" placeholder="最多 ${maxContracts} 张" data-action="calc-futures">
            </label>
          </div>
          <div class="trade-money-strip futures-form-calc-grid">
            <div>
              <span>合约价值</span>
              <strong id="calc-contract-value">${contractValue.toLocaleString()}</strong>
            </div>
            <div>
              <span>所需保证金</span>
              <strong id="calc-margin">${margin.toLocaleString()}</strong>
            </div>
            <div>
              <span>爆仓价(多)</span>
              <strong id="calc-liq-long">${liqPriceLong.toFixed(2)}</strong>
            </div>
            <div>
              <span>爆仓价(空)</span>
              <strong id="calc-liq-short">${liqPriceShort.toFixed(2)}</strong>
            </div>
          </div>
          <button class="primary futures-submit-button" data-action="futures-open" ${state.loading || !canTrade ? 'disabled' : ''}>确认开仓</button>
        </div>
      </section>
    </section>`;
  }

  function renderMarket() {
    return `
      ${renderMarketOverview()}
      <div class="market-layout">
        <section class="panel stock-table">
          <div class="panel-pad panel-head">
            <div>
              <h1 class="title">行情</h1>
            </div>
          </div>
          ${renderStockSortBar()}
          ${renderStockRows()}
        </section>
        ${renderMarketMovers()}
      </div>
    `;
  }

  function renderFundsView() {
    const selected = state.selectedFund;
    const holdingMap = Object.fromEntries((state.fundsStatus || []).map((holding) => [holding.fund_code, holding]));
    const groups = [
      ['行业基金', state.fundsList.filter((fund) => fund.type === 'derived')],
      ['独立资产', state.fundsList.filter((fund) => fund.type !== 'derived')]
    ];
    return `
      <div class="fund-layout">
        <section class="panel panel-pad">
          <div class="panel-head">
            <div>
              <h1 class="title">基金</h1>
            </div>
          </div>
          ${groups.map(([label, list]) => `
            <h3 class="section-title fund-group-title">${label}</h3>
            <div class="fund-list">
              ${list.map((fund) => {
                const holding = holdingMap[fund.code];
                return `
                  <button class="fund-row ${fund.code === state.selectedFundCode ? 'active' : ''}" data-action="select-fund" data-code="${fund.code}">
                    <div>
                      <strong>${escapeHtml(fund.name)}</strong>
                       <div class="muted">${fund.code}</div>
                    </div>
                    <span class="tag tag-${fund.risk_level}">${riskLabel(fund.risk_level)}</span>
                    <div class="num">
                      <div class="fund-nav-label">单位净值</div>
                      <strong>${Number(fund.nav || 0).toFixed(4)}</strong>
                      ${fund.has_performance ? `<div class="${trendClass(fund.inception_change)} fund-perf-list">成立以来涨跌 ${percent(fund.inception_change)}</div>` : ''}
                    </div>
                    <div class="num muted">${holding ? `持有 ${money(holding.value)}` : '未持有'}</div>
                  </button>
                `;
              }).join('')}
            </div>
          `).join('')}
        </section>
        ${selected ? renderFundDetail(selected, holdingMap[selected.code]) : '<section class="panel panel-pad"><div class="empty">请选择基金</div></section>'}
      </div>
    `;
  }

  function renderFundDetail(fund, holding) {
    const chartHistory = (fund.history || []).map((row) => ({ tick: row.tick, close: row.nav }));
    const fundWindow = chartHistory.slice(-CHART_HISTORY_WINDOW);
    const fundWinMinTick = fundWindow.length ? fundWindow[0].tick : 0;
    const transactions = (state.fundHistory || []).filter((item) => item.fund_code === fund.code).slice(0, 5);
    const chartTrades = (state.fundHistory || []).filter((item) => item.fund_code === fund.code && item.type !== 'forced_liquidation' && item.tick >= fundWinMinTick);
    const tradeLockReason = getTradeLockReason('fund');
    const canTrade = !tradeLockReason;
    const buyFeedback = getTradeFeedback('fund', 'buy', { code: fund.code });
    const sellFeedback = getTradeFeedback('fund', 'sell', { code: fund.code });
    const sellWarning = '';
    return `
      <section class="panel panel-pad fund-detail">
        <div class="panel-head">
          <div>
            <h2 class="title">${escapeHtml(fund.name)}</h2>
            <div class="muted">${fund.code}</div>
          </div>
          <div class="num">
            <div class="fund-nav-label">单位净值</div>
            <div class="detail-price ${fund.has_performance ? trendClass(fund.inception_change) : 'flat'}">${Number(fund.nav || 0).toFixed(4)}</div>
            <div class="${fund.has_performance ? trendClass(fund.inception_change) : 'muted'}">${fundPerformanceText(fund)}</div>
          </div>
        </div>
        ${fundWindow.length >= 2 ? renderLineChart(fundWindow, '基金净值走势', 'fund-nav-chart', chartTrades) : '<div class="sparkline empty">尚未产生首期涨跌</div>'}
        <div class="fund-meta-grid">
          <div><span>风险等级</span><strong>${riskLabel(fund.risk_level)}</strong></div>
          <div><span>基金经理</span>${fund.manager_name && managerStyle(fund.strategy)
            ? `<strong class="manager-name" tabindex="0">${escapeHtml(fund.manager_name)}<span class="manager-tip" role="tooltip">${escapeHtml(managerStyle(fund.strategy))}</span></strong>`
            : `<strong>${escapeHtml(fund.manager_name || '被动规则')}</strong>`}</div>
          <div><span>当前持有</span><strong>${holding ? money(holding.value) : '0.00'}</strong></div>
          <div><span>持有盈亏</span><strong class="${trendClass(holding?.profit || 0)}">${money(holding?.profit || 0)}</strong></div>
        </div>
        ${renderFundComposition(fund)}
        ${tradeLockReason ? `<div class="trade-closed" style="margin-top:18px;">${escapeHtml(tradeLockReason)}</div>` : ''}
        <div class="fund-trade-grid">
          <form data-form="fund-buy">
            <input type="hidden" name="fundCode" value="${escapeHtml(fund.code)}">
            <label>申购金额</label>
            <input name="amount" type="number" min="1" step="0.01" data-clamp="fund-buy" placeholder="最多 ${money(state.user.cash)}">
            <button class="buy" type="submit" ${state.loading || !canTrade ? 'disabled' : ''}>申购</button>
            ${renderTradeFeedback(buyFeedback, '')}
          </form>
          <form data-form="fund-sell">
            <input type="hidden" name="fundCode" value="${escapeHtml(fund.code)}">
            <label>赎回份额</label>
            <input name="shares" type="number" min="0.000001" step="0.000001" data-clamp="fund-sell" placeholder="可赎 ${Number(holding?.available_shares || 0).toFixed(6)}">
            <button class="sell" type="submit" ${state.loading || !canTrade || !holding?.available_shares ? 'disabled' : ''}>赎回</button>
            ${renderTradeFeedback(sellFeedback, sellWarning)}
          </form>
        </div>
        <h3 class="section-title" style="margin-top:18px;">我的交易记录</h3>
        ${transactions.length ? transactions.map((item) => `
          <div class="flat-row">
            <span>${fundTransactionLabel(item.type)} · 第 ${item.tick} 期 · ${Number(item.shares || 0).toFixed(6)} 份</span>
            <strong>${money(item.amount || 0)}</strong>
          </div>
        `).join('') : '<div class="empty">暂无该基金交易记录</div>'}
      </section>
    `;
  }

  function renderFundComposition(fund) {
    const weights = fund.weights || [];
    if (fund.type !== 'derived') {
      return `
        <div class="fund-asset-note">
          <h3 class="section-title">资产来源</h3>
          <div>${escapeHtml(fund.asset_description || '配置游戏市场之外的独立资产，净值不直接由本地股票持仓计算。')}</div>
        </div>
      `;
    }
    const isActiveFund = fund.manage_mode === 'active';
    const visibleWeights = isActiveFund ? weights.slice(0, 6) : weights;
    const rows = renderFundWeightRows(visibleWeights, isActiveFund ? '尚未形成公开持仓' : '尚未形成指数成分');
    const sectionTitle = isActiveFund ? '上期公开持仓' : '当前指数成分';
    const summaryLabel = visibleWeights.length
      ? `查看 ${visibleWeights.length} 只${isActiveFund ? '持仓' : '成分'}`
      : `查看${isActiveFund ? '公开持仓' : '指数成分'}`;
    return `
      <h3 class="section-title" style="margin-top:18px;">${sectionTitle}</h3>
      <details class="fund-components">
        <summary>${summaryLabel}</summary>
        <div class="fund-weights">${rows}</div>
      </details>
    `;
  }

  function renderFundWeightRows(weights, emptyText) {
    return weights.map((item) => `
      <div class="flat-row"><span>${escapeHtml(item.stock_name)}</span><strong>${percent(item.weight)}</strong></div>
    `).join('') || `<div class="empty">${escapeHtml(emptyText)}</div>`;
  }

  function fundPerformanceText(fund) {
    return fund.has_performance ? `成立以来涨跌 ${percent(fund.inception_change)}` : '尚未产生首期涨跌';
  }

  function renderNewsView() {
    const ordered = sortNewsByPriority(state.news);
    const indexMap = buildNewsIndexMap(ordered);
    return `
      <section class="panel panel-pad" style="margin-top:18px;">
        <div class="panel-head">
          <div>
            <h1 class="title">新闻</h1>
          </div>
          <span class="status-pill">第 ${state.currentTick} 期</span>
        </div>
        ${state.news.length
          ? `<div class="news-layout">
              <div class="news-main">${renderGlobalNewsList(ordered, indexMap)}</div>
              <aside class="kol-column">${renderKolColumn(state.kol_comments, indexMap)}</aside>
            </div>`
          : '<div class="empty">本期暂无新闻，推进后会刷新。</div>'}
      </section>
    `;
  }

  function renderSportsView() {
    const overview = state.sportsOverview;
    if (!overview) return '<section class="panel panel-pad"><div class="empty">赛事数据加载中</div></section>';
    const season = overview.season || {};
    const sections = [
      ['overview', '赛事首页'],
      ['teams', '球队'],
      ['playoffs', '季后赛'],
      ['bets', '竞猜详情'],
      ['ranking', '竞猜排行'],
      ['rules', '规则']
    ];
    return `
      <section class="panel panel-pad sports-shell">
        <div class="panel-head">
          <div>
            <h1 class="title">SBA 篮球联赛</h1>
            <div class="muted">第 ${season.season_no || '--'} 赛季 · ${season.season_type === 'warmup' ? '热身赛季' : '完整赛季'} · ${sportsStageLabel(season.status)}</div>
          </div>
          <span class="status-pill">${overview.paused ? '赛事暂停' : (state.sleeping ? '全局休眠' : `下一场 ${clockTime(overview.next_match_at)}`)}</span>
        </div>
        <div class="sports-tabs" role="tablist">
          ${sections.map(([key, label]) => `<button class="secondary mini-button sports-tab ${state.sportsSection === key ? 'active' : ''}" data-action="sports-section" data-section="${key}" role="tab" aria-selected="${state.sportsSection === key ? 'true' : 'false'}">${label}</button>`).join('')}
        </div>
        ${state.sportsSection === 'overview' ? renderSportsOverview(overview) : ''}
        ${state.sportsSection === 'playoffs' ? renderSportsPlayoffs() : ''}
        ${state.sportsSection === 'teams' ? renderSportsTeams(overview.teams || [], overview.standings || [], overview.season?.season_type) : ''}
        ${state.sportsSection === 'bets' ? renderSportsBetDetail() : ''}
        ${state.sportsSection === 'ranking' ? renderSportsBettingRanking() : ''}
        ${state.sportsSection === 'rules' ? renderSportsRules(overview.config || {}) : ''}
      </section>
      ${renderSportsSeriesBetModal()}
    `;
  }

  function sportsMatchTimeKey(match) {
    return String(match?.scheduled_at || '').slice(11, 16);
  }

  function selectedSportsTimeKey(matches) {
    const times = [...new Set((matches || []).map(sportsMatchTimeKey).filter(Boolean))].sort();
    if (!times.length) return '';
    if (times.includes(state.sportsTimeKey)) return state.sportsTimeKey;
    const next = (matches || []).find((match) => ['open', 'unopened'].includes(match.status));
    state.sportsTimeKey = next ? sportsMatchTimeKey(next) : times[times.length - 1];
    return state.sportsTimeKey;
  }

  function renderSportsOverview(overview) {
    const matches = overview.matches || [];
    const selectedTime = selectedSportsTimeKey(matches);
    const times = [...new Set(matches.map(sportsMatchTimeKey).filter(Boolean))].sort();
    const selectedMatches = matches.filter((match) => sportsMatchTimeKey(match) === selectedTime);
    return `
      ${overview.season?.season_type === 'warmup' ? '<div class="notice sports-warmup">当前为热身赛季：只进行本周尚未开始的常规赛，不进入季后赛、不产生冠军。</div>' : ''}
      <div class="sports-summary-grid">
        <div class="sports-stat"><span>当前阶段</span><strong>${sportsStageLabel(overview.season?.status)}</strong></div>
        <div class="sports-stat"><span>待开奖本金</span><strong>${money(state.sportsAccount?.pending_stake || 0)}</strong></div>
        <div class="sports-stat"><span>本赛季盈亏</span><strong class="${trendClass(state.sportsAccount?.season_pnl || 0)}">${money(state.sportsAccount?.season_pnl || 0)}</strong></div>
        <div class="sports-stat"><span>可用资金</span><strong>${money(state.user?.cash || 0)}</strong></div>
      </div>
        <div class="sports-two-column">
        <div>
          <h2 class="section-title">${overview.match_day === serverDate() ? '今日比赛' : '最近比赛 · ' + formatSportsDate(overview.match_day)}</h2>
          ${times.length ? `<div class="sports-time-tabs" role="tablist" aria-label="今日比赛时间">
            ${times.map((time) => `<button class="secondary mini-button sports-time-tab ${selectedTime === time ? 'active' : ''}"
              data-action="sports-time" data-time="${time}" role="tab" aria-selected="${selectedTime === time ? 'true' : 'false'}">${time}</button>`).join('')}
          </div>` : ''}
          <div class="sports-betting-guide">星级代表当前阵容基础实力；赔率还包含近期状态与主场优势。</div>
          <div class="sports-match-list">${selectedMatches.map(renderSportsMatchCard).join('') || '<div class="empty">今日暂无比赛</div>'}</div>
        </div>
        <aside>
          <h2 class="section-title">联赛排名</h2>
          ${renderSportsStandings(overview.standings || [], true)}
        </aside>
      </div>
    `;
  }

  function renderSportsPlayoffs() {
    const playoff = state.sportsPlayoffs;
    if (!playoff) {
      loadSportsPlayoffs().then(render);
      return '<div class="empty">季后赛对阵加载中</div>';
    }
    const byKey = Object.fromEntries((playoff.series || []).map((series) => [`${series.stage}:${series.bracket_slot}`, series]));
    const round = (title, stage, slots) => `<section class="sports-bracket-round sports-bracket-${stage}">
      <h3>${title}</h3>
      ${slots.map((slot) => renderSportsBracketSeries(byKey[`${stage}:${slot}`], stage, slot, anyMarketOpen)).join('')}
    </section>`;
    const anyMarketOpen = (playoff.series || []).some((s) => s.market?.status === 'open');
    return `
      <div class="sports-section-head"><h2 class="section-title">季后赛对阵<span class="sports-playoff-sub"> · ${anyMarketOpen ? '可投注' : '尚未开放投注'}</span></h2></div>
      <div class="sports-bracket">
        ${round('八强赛', 'quarterfinal', [1, 4, 2, 3])}
        ${round('半决赛', 'semifinal', [1, 2])}
        ${round('总决赛', 'final', [1])}
      </div>
    `;
  }

  function renderSportsBracketSeries(series, stage, slot, anyMarketOpen = false) {
    const home = series?.home_team?.name || '';
    const away = series?.away_team?.name || '';
    const homeWins = series ? Number(series.home_wins || 0) : 0;
    const awayWins = series ? Number(series.away_wins || 0) : 0;
    const gameOne = series?.matches?.find((match) => Number(match.game_no) === 1) || series?.matches?.[0];
    const beforeGameOne = gameOne && ['unopened', 'open'].includes(gameOne.status);
    const label = beforeGameOne ? `G1 · ${formatSportsTime(gameOne.scheduled_at)}`
      : (series?.status === 'completed' ? '已结束' : '系列赛');
    const showDetail = !!series && !series.preview && (series.status !== 'pending' || series.market?.status === 'open');
    const canBet = !!series && !series.preview && series.market?.status === 'open'
      && !state.sleeping && !state.sportsOverview?.paused;
    const completed = series?.status === 'completed' && !!series?.winner_team?.id;
    const userBetMap = Object.fromEntries((series?.user_bet_summaries || [])
      .filter((bet) => bet.status !== 'refunded')
      .map((bet) => [bet.selection_team_id, bet]));
    const teamBadges = (team, odds) => {
      if (!team || odds == null) return '';
      const placed = userBetMap[team.id];
      return `<small class="sports-series-odds">${Number(odds).toFixed(2)}</small>${placed
        ? `<small class="sports-series-stake">已投 ${money(placed.amount)}</small>`
        : ''}`;
    };
    const teamName = (team) => {
      const resultClass = completed
        ? (series.winner_team.id === team?.id ? ' sports-winner' : ' sports-loser')
        : '';
      return `<span class="sports-bracket-team-name${resultClass}">${escapeHtml(team?.name || '待定')}</span>`;
    };
    const actionAttrs = canBet
      ? `data-action="sports-series-open" data-series-id="${escapeHtml(series.id)}" role="button" tabindex="0" aria-label="投注 ${escapeHtml(home)} 对 ${escapeHtml(away)} 系列赛胜者"`
      : '';
    return `<article class="sports-bracket-card sports-bracket-card-${stage}${canBet ? ' sports-bracket-card-bettable' : ''}" data-slot="${slot}" ${actionAttrs}>
      <div class="sports-bracket-card-head"><span>${sportsStageLabel(stage)} · 第 ${slot} 组</span>${showDetail ? `<small>${label}</small>` : ''}</div>
      <div class="sports-bracket-team"><span class="sports-bracket-team-copy">${teamName(series?.home_team)}${teamBadges(series?.home_team, series?.market?.home_odds)}</span>${showDetail ? `<strong>${homeWins}</strong>` : ''}</div>
      <div class="sports-bracket-team"><span class="sports-bracket-team-copy">${teamName(series?.away_team)}${teamBadges(series?.away_team, series?.market?.away_odds)}</span>${showDetail ? `<strong>${awayWins}</strong>` : ''}</div>
    </article>`;
  }

  function renderSportsSeriesBetModal() {
    const seriesId = state.sportsSeriesBetModal?.seriesId;
    if (!seriesId) return '';
    const series = state.sportsPlayoffs?.series?.find((item) => item.id === seriesId);
    if (!series?.home_team || !series?.away_team || !series.market) return '';
    const gameOne = series.matches?.find((match) => Number(match.game_no) === 1) || series.matches?.[0];
    const pending = state.sportsPendingSeriesBets[seriesId];
    const minBet = state.sportsOverview?.config?.min_bet || 1000;
    const maxBet = state.sportsOverview?.config?.max_bet_per_series || 200000;
    return `<div class="modal-layer sports-series-bet-layer" data-action="sports-series-close">
      <div class="confirm-modal confirm-modal-wide sports-series-bet-modal" role="dialog" aria-modal="true" aria-labelledby="sports-series-bet-title">
        <div class="confirm-modal-body">
          <div class="sports-series-bet-head">
            <div>
              <div class="confirm-modal-kicker">${sportsStageLabel(series.stage)} · 第 ${series.bracket_slot} 组</div>
              <h2 class="confirm-modal-title" id="sports-series-bet-title">投注系列赛胜者</h2>
            </div>
            <button class="secondary mini-button" type="button" data-action="sports-series-close">关闭</button>
          </div>
          <div class="sports-series-bet-matchup">
            <strong>${escapeHtml(series.home_team.name)}</strong>
            <span>BO3</span>
            <strong>${escapeHtml(series.away_team.name)}</strong>
          </div>
          <div class="sports-match-team-guides sports-series-team-guides">
            ${renderSportsTeamBettingGuide(series.home_team)}
            ${renderSportsTeamBettingGuide(series.away_team, true)}
          </div>
          <div class="sports-series-bet-note">
            <strong>竞猜整个系列赛的胜者，不是单场比赛结果。</strong>
            <span>星级代表当前阵容基础实力；赔率还包含近期状态与主场优势。</span>
            <span>G1 开赛时间：${formatSportsTime(gameOne?.scheduled_at)}，开赛后停止投注。</span>
          </div>
          <div class="sports-bet-row sports-series-bet-row">
            <button class="sports-bet-btn mini-button" data-action="sports-series-bet" data-series-id="${escapeHtml(series.id)}"
              data-selection-team-id="${escapeHtml(series.home_team.id)}" ${pending ? 'disabled aria-busy="true"' : ''}>
              ${pending ? '提交中…' : `${escapeHtml(series.home_team.name)} ${Number(series.market.home_odds).toFixed(2)}`}
            </button>
            <input id="sports-series-bet-${escapeHtml(series.id)}" type="number" inputmode="numeric" min="${minBet}" step="1000"
              value="${minBet}" aria-label="系列赛竞猜金额" ${pending ? 'disabled' : ''}>
            <button class="sports-bet-btn mini-button" data-action="sports-series-bet" data-series-id="${escapeHtml(series.id)}"
              data-selection-team-id="${escapeHtml(series.away_team.id)}" ${pending ? 'disabled aria-busy="true"' : ''}>
              ${pending ? '提交中…' : `${escapeHtml(series.away_team.name)} ${Number(series.market.away_odds).toFixed(2)}`}
            </button>
          </div>
          <div class="sports-series-bet-meta">
            <span>可用资金 ${money(state.user?.cash || 0)}</span>
            <span>本系列赛已投 ${money(series.user_stake || 0)} / ${money(maxBet)}</span>
          </div>
        </div>
      </div>
    </div>`;
  }

  function renderSportsTeams(teams, standings, seasonType) {
    if (!teams?.length) return '<div class="empty">暂无球队数据</div>';
    const standingMap = {};
    (standings || []).forEach(s => { standingMap[s.team_id] = s; });
    const showPlayoffCut = seasonType !== 'warmup';
    const sortedRows = teams.map((team) => ({ team, standing: standingMap[team.id] || null }))
      .sort((a, b) => (a.standing?.rank || 99) - (b.standing?.rank || 99));
    const rows = [];
    sortedRows.forEach((entry, idx) => {
      if (showPlayoffCut && entry.standing && entry.standing.rank === 9) {
        rows.push(`<div class="sports-team-cutoff"><span>季后赛区</span></div>`);
      }
      rows.push(renderSportsTeamRow(entry.team, entry.standing));
    });
    return `<div class="sports-team-list">${rows.join('')}</div>`;
  }

  function renderSportsTeamRow(team, standing) {
    const rank = standing?.rank;
    const wins = standing?.wins ?? 0;
    const losses = standing?.losses ?? 0;
    const winRate = standing ? Math.round((standing.win_rate || 0) * 1000) / 10 : 0;
    const pDiff = standing?.point_diff_per_game ?? 0;
    const stars = standing?.stars ?? 0;
    const streak = standing?.streak || { type: null, count: 0 };
    const isPlayoff = rank != null && rank <= 8;
    const rankCell = rank != null
      ? `<span class="sports-team-rank ${isPlayoff ? 'is-playoff' : ''}">${rank}</span>`
      : `<span class="sports-team-rank">—</span>`;
    const winRateText = (standing?.games ?? 0) > 0 ? `${winRate.toFixed(1)}%` : '—';
    const pDiffText = (standing?.games ?? 0) > 0
      ? `${pDiff > 0 ? '+' : ''}${pDiff}`
      : '—';
    const pDiffClass = pDiff > 0 ? 'is-up' : (pDiff < 0 ? 'is-down' : '');
    const streakText = streak.type ? `${streak.type === 'W' ? '连胜' : '连败'} ${streak.count}` : '—';
    const streakClass = streak.type === 'W' ? 'is-up' : (streak.type === 'L' ? 'is-down' : '');
    return `<div class="sports-team-row ${isPlayoff ? 'is-playoff' : ''}">
      <div class="sports-team-cell sports-team-cell-rank">${rankCell}</div>
      <div class="sports-team-cell sports-team-cell-name">
        <strong class="sports-team-name">${escapeHtml(team.name)}</strong>
        <span class="sports-team-city muted">${escapeHtml(team.city || '')}</span>
      </div>
      <div class="sports-team-cell sports-team-cell-record">
        <span class="sports-team-cell-value">${wins}-${losses}</span>
        <span class="sports-team-cell-label">战绩</span>
      </div>
      <div class="sports-team-cell sports-team-cell-rate">
        <span class="sports-team-cell-value">${winRateText}</span>
        <span class="sports-team-cell-label">胜率</span>
      </div>
      <div class="sports-team-cell sports-team-cell-diff">
        <span class="sports-team-cell-value ${pDiffClass}">${pDiffText}</span>
        <span class="sports-team-cell-label">场均净胜分</span>
      </div>
      <div class="sports-team-cell sports-team-cell-strength">
        <span class="sports-team-stars" title="战力指数 ${standing?.strength ?? '—'}">${renderSportsStars(stars)}</span>
        <span class="sports-team-cell-label">战力</span>
      </div>
      <div class="sports-team-cell sports-team-cell-streak">
        <span class="sports-team-cell-value ${streakClass}">${streakText}</span>
        <span class="sports-team-cell-label">状态</span>
      </div>
      <div class="sports-team-cell sports-team-cell-titles">
        <span class="sports-team-cell-value">${team.championships || 0}</span>
        <span class="sports-team-cell-label">冠军</span>
      </div>
    </div>`;
  }

  function renderSportsStars(stars) {
    const total = 5;
    const filled = Math.max(0, Math.min(total, Number(stars) || 0));
    return `<span class="sports-team-stars-track" aria-label="${filled}/${total} 颗星">
      <span class="sports-team-stars-fill">${'★'.repeat(filled)}${'☆'.repeat(total - filled)}</span>
    </span>`;
  }

  function renderSportsTeamBettingGuide(team, away = false) {
    const wins = Number(team?.wins || 0);
    const losses = Number(team?.losses || 0);
    const hasRecord = (team?.wins != null) || (team?.losses != null) || (team?.recent?.length ?? 0) > 0;
    return `<div class="sports-match-team-guide${away ? ' is-away' : ''}">
      <span>${renderSportsStars(team?.stars || 0)}</span>
      <small>${hasRecord ? `${wins} 胜 ${losses} 负` : '近期暂无战绩'}</small>
    </div>`;
  }

  function renderSportsMatchCard(match) {
    const home = match.home_team;
    const away = match.away_team;
    const settled = match.status === 'settled';
    const homeWin = settled && match.home_score > match.away_score;
    const awayWin = settled && match.away_score > match.home_score;
    const canBet = match.status === 'open' && match.market?.status === 'open' && !state.sleeping && !state.sportsOverview?.paused;
    const pending = state.sportsPendingBets[match.id];
    const betDisabled = !canBet || !!pending;
    const pendingLabel = pending ? '提交中…' : '';
    return `
      <article class="sports-match-card">
        <div class="sports-match-meta">
          <span>${sportsStageLabel(match.stage)}${match.stage === 'regular' ? ` · 第 ${match.round_no} 轮` : ` · G${match.game_no || match.round_no}`}</span>
          <span>${formatSportsTime(match.scheduled_at)} · ${sportsStatusLabel(match.status)}</span>
        </div>
        <div class="sports-matchup">
          <span class="sports-team-link${homeWin ? ' sports-winner' : (awayWin ? ' sports-loser' : '')}">${escapeHtml(home?.name || '待定')}${homeWin ? '<span class="sports-win-star"> ★</span>' : ''}</span>
          <strong class="sports-score">${settled ? `${match.home_score} : ${match.away_score}` : '<span class="sports-label">主场</span> VS <span class="sports-label">客场</span>'}</strong>
          <span class="sports-team-link${awayWin ? ' sports-winner' : (homeWin ? ' sports-loser' : '')}">${awayWin ? '<span class="sports-win-star">★ </span>' : ''}${escapeHtml(away?.name || '待定')}</span>
        </div>
        <div class="sports-match-team-guides">
          ${renderSportsTeamBettingGuide(home)}
          ${renderSportsTeamBettingGuide(away, true)}
        </div>
        ${canBet ? `
          <div class="sports-bet-row">
            <button class="sports-bet-btn mini-button" data-action="sports-bet" data-match-id="${escapeHtml(match.id)}" data-selection-team-id="${escapeHtml(home.id)}" ${betDisabled ? 'disabled aria-busy="true"' : ''}>${pendingLabel || `${escapeHtml(home.name)} ${Number(match.market.home_odds).toFixed(2)}`}</button>
            <input id="sports-bet-${escapeHtml(match.id)}" type="number" inputmode="numeric" min="${state.sportsOverview?.config?.min_bet || 1000}" step="1000" value="${state.sportsOverview?.config?.min_bet || 1000}" aria-label="竞猜金额" ${pending ? 'disabled' : ''}>
            <button class="sports-bet-btn mini-button" data-action="sports-bet" data-match-id="${escapeHtml(match.id)}" data-selection-team-id="${escapeHtml(away.id)}" ${betDisabled ? 'disabled aria-busy="true"' : ''}>${pendingLabel || `${escapeHtml(away.name)} ${Number(match.market.away_odds).toFixed(2)}`}</button>
          </div>
          ${pending ? `<div class="muted sports-stake-note">竞猜提交中，请稍候…</div>` : match.user_stake ? `<div class="sports-stake-tags">${(match.user_bet_summaries || []).filter(s => s.status !== 'refunded').map(s => `<small class="sports-series-stake">${escapeHtml(s.selection_team_name)} 已投 ${money(s.amount)}</small>`).join('')}</div>` : ''}
        ` : match.cancel_reason ? `<div class="muted sports-stake-note">${escapeHtml(match.cancel_reason)}</div>` : ''}
        ${renderSportsMatchBetResults(match)}
      </article>
    `;
  }

  function renderSportsMatchBetResults(match) {
    const summaries = match.user_bet_summaries || [];
    if (!summaries.length || !['settled', 'canceled'].includes(match.status)) return '';
    return `<div class="sports-card-bet-results">${summaries.map((bet) => {
      const label = bet.status === 'won' ? '获胜' : bet.status === 'lost' ? '失败' : '已退款';
      const detail = bet.status === 'won'
        ? `盈利 +${money(bet.pnl)}`
        : bet.status === 'lost' ? `亏损 -${money(Math.abs(bet.pnl))}` : `退款 ${money(bet.payout)}`;
      const cls = bet.status === 'won' ? 'up' : bet.status === 'lost' ? 'down' : 'muted';
      return `<div class="sports-card-bet-result"><span>${escapeHtml(bet.selection_team_name || bet.selection_team_id)}</span><strong class="${cls}">${label} · ${detail}</strong></div>`;
    }).join('')}</div>`;
  }

  function renderSportsStandings(rows, compact = false) {
    if (!rows?.length) return '<div class="empty compact-empty">暂无排名</div>';
    return `<div class="sports-standing ${compact ? 'compact' : ''}">
      ${rows.map((row) => `<div class="sports-standing-row">
        <strong>${row.rank}</strong>
        <span>${escapeHtml(row.team_name)}</span>
        <span>${row.wins}-${row.losses}</span>
      </div>`).join('')}
    </div>`;
  }

  function renderSportsBets(bets, compact = false) {
    if (!bets?.length) return '<div class="empty compact-empty">暂无竞猜记录</div>';
    return `<div class="sports-bet-history ${compact ? 'compact' : ''}">${bets.map((bet) => `
      <div class="sports-bet-history-row">
        <div><strong>${escapeHtml(bet.selection_team_name || bet.selection_team_id)}</strong><div class="muted">${bet.market_type === 'series' ? '系列赛胜者 · ' : ''}${escapeHtml(bet.home_team_name || '待定')} vs ${escapeHtml(bet.away_team_name || '待定')} · ${Number(bet.locked_odds || 0).toFixed(2)} 倍</div></div>
        <div class="num ${bet.status === 'won' ? 'up' : bet.status === 'lost' ? 'down' : ''}">${sportsBetStatusLabel(bet.status)}
          <div class="muted">投入 ${money(bet.amount)}${Number(bet.bet_count || 1) > 1 ? ` · ${bet.bet_count} 笔合并` : ''}</div>
          ${['won', 'lost'].includes(bet.status) ? `<div>${bet.status === 'won' ? '盈利 +' : '亏损 -'}${money(Math.abs(bet.pnl || 0))}</div>` : ''}
        </div>
      </div>`).join('')}</div>`;
  }

  function renderMyBetsDetail(bets) {
    return `<div class="sports-bet-history">${bets.map((bet) => `
      <div class="sports-bet-history-row">
        <div><strong>${escapeHtml(bet.selection_team_name || bet.selection_team_id)}</strong><div class="muted">${bet.market_type === 'series' ? '系列赛胜者 · ' : ''}${formatSportsTime(bet.scheduled_at)} · ${escapeHtml(bet.home_team_name || '待定')} vs ${escapeHtml(bet.away_team_name || '待定')}</div></div>
        <div class="num ${bet.status === 'won' ? 'up' : bet.status === 'lost' ? 'down' : ''}">${sportsBetStatusLabel(bet.status)}
          <div class="muted">投入 ${money(bet.amount)}${Number(bet.bet_count || 1) > 1 ? ` · ${bet.bet_count} 笔合并` : ''}</div>
          ${['won', 'lost'].includes(bet.status) ? `<div>${bet.status === 'won' ? '盈利 +' : '亏损 -'}${money(Math.abs(bet.pnl || 0))}</div>` : ''}
        </div>
      </div>`).join('')}</div>`;
  }

  function renderActivityRow(bet) {
    const timeLabel = bet.scheduled_at ? formatSportsTime(bet.scheduled_at) : '';
    const cls = bet.status === 'won' ? 'up' : bet.status === 'lost' ? 'down' : '';
    return `<div class="sports-bet-history-row">
      <div><strong>${escapeHtml(bet.nickname || '?')}</strong><div class="muted">${escapeHtml(bet.selection_team_name || '?')} (${timeLabel})</div></div>
      <div class="num ${cls}">${sportsBetStatusLabel(bet.status)}
        <div class="muted">投入 ${money(bet.amount)}</div>
        ${bet.status === 'won' ? `<div>盈利 +${money(Math.abs(bet.pnl || 0))}</div>` : ''}
        ${bet.status === 'lost' ? `<div>亏损 -${money(Math.abs(bet.pnl || 0))}</div>` : ''}
      </div>
    </div>`;
  }

  function renderSportsBetDetail() {
    const account = state.sportsAccount;
    const activity = state.sportsActivity;

    const summary = account ? `
      <div class="sports-summary-grid">
        <div class="sports-stat"><span>待开奖本金</span><strong>${money(account.pending_stake || 0)}</strong></div>
        <div class="sports-stat"><span>本赛季盈亏</span><strong class="${trendClass(account.season_pnl || 0)}">${money(account.season_pnl || 0)}</strong></div>
        <div class="sports-stat"><span>单场限额</span><strong>${money(state.sportsOverview?.config?.max_bet_per_match || 100000)}</strong></div>
      </div>` : '';

    const myBets = account?.recent_bets?.length
      ? renderMyBetsDetail(account.recent_bets)
      : '<div class="empty">暂无竞猜记录</div>';

    let activitySection = '';
    if (activity?.bets?.length) {
      const dateLabel = activity.match_day === serverDate() ? '今日投注动态' : `最近投注动态 (${formatSportsDate(activity.match_day)})`;
      activitySection = `
        <div style="margin-top:24px;">
          <h2 class="section-title">${dateLabel}</h2>
          <div class="sports-bet-history">${activity.bets.map((bet) => renderActivityRow(bet)).join('')}</div>
        </div>`;
    }

    return `
      ${summary ? `<div style="margin-bottom:4px;">${summary}</div>` : ''}
      <h2 class="section-title" style="margin-top:20px;">我的竞猜</h2>
      ${myBets}
      ${activitySection}
    `;
  }

  function renderSportsRules(config) {
    return `
      <div class="sports-rules">
        <h2 class="section-title">竞猜规则</h2>
        <p>支持单场胜负竞猜与季后赛系列赛胜者竞猜。下注后赔率固定，比赛结果不受投注方向、人数或金额影响。</p>
        <p>战力星级只代表当前阵容基础实力；赔率还会计入近期状态和主场优势，高星不等于单场必胜。</p>
        <p>单笔最低 ${money(config.min_bet || 1000)}，单玩家单场累计最高 ${money(config.max_bet_per_match || 100000)}，单系列赛累计最高 ${money(config.max_bet_per_series || 200000)}。</p>
        <p>下注立即扣款，获胜按锁定赔率返还，比赛取消原额退款。待开奖本金不计入净资产。</p>
        <h2 class="section-title">赛季规则</h2>
        <p>16 支球队双循环常规赛，前八名进入季后赛。八强赛与半决赛三局两胜，总决赛五局三胜。</p>
        <p>完整赛季常规赛期间会随机发生球员交易；赛季结束后进行休赛期轮换，并为战绩倒数四队提供递减概率的选秀成长。</p>
      </div>
    `;
  }

  function renderSportsBettingRanking() {
    const data = state.sportsRanking || [];
    if (!data.length) return '<div class="empty">暂无竞猜数据</div>';

    const sorted = [...data].sort((a, b) => {
      let result = 0;
      if (state.sportsRankingSortKey === 'total_pnl') result = a.total_pnl - b.total_pnl;
      else if (state.sportsRankingSortKey === 'today_pnl') result = a.today_pnl - b.today_pnl;
      else if (state.sportsRankingSortKey === 'hit_rate') result = a.hit_rate - b.hit_rate;
      return state.sportsRankingSortDir === 'asc' ? result : -result;
    });

    const sortBtn = (key, label) => {
      const active = state.sportsRankingSortKey === key;
      const arrow = active ? (state.sportsRankingSortDir === 'asc' ? ' ↑' : ' ↓') : '';
      return `<button class="sports-rank-sort-btn${active ? ' active' : ''}" data-action="set-sports-ranking-sort" data-sort-key="${key}">${label}${arrow}</button>`;
    };

    return `
      <div>
        <div class="sports-ranking-header">
          <span></span>
          <span></span>
          ${sortBtn('total_pnl', '总盈亏')}
          ${sortBtn('today_pnl', '今日盈亏')}
          ${sortBtn('hit_rate', '命中率')}
        </div>
        <div class="sports-ranking-list">
          ${sorted.map((item, i) => renderRankingCard(item, i)).join('')}
        </div>
      </div>
    `;
  }

  function renderRankingCard(item, index) {
    return `
      <div class="sports-ranking-card">
        <span class="sports-ranking-rank">${index + 1}</span>
        <span class="sports-ranking-nickname">${escapeHtml(item.nickname)}</span>
        <span class="sports-ranking-val ${trendClass(item.total_pnl)}">${item.total_pnl >= 0 ? '+' : ''}${money(item.total_pnl)}</span>
        <span class="sports-ranking-val ${trendClass(item.today_pnl)}">${item.today_pnl >= 0 ? '+' : ''}${money(item.today_pnl)}</span>
        <span class="sports-ranking-val">${item.hit_rate.toFixed(1)}%</span>
      </div>
    `;
  }

  function sportsStageLabel(value) {
    return { regular: '常规赛', quarterfinal: '八强赛', semifinal: '半决赛', final: '总决赛', completed: '赛季完成', void: '赛季作废' }[value] || '季前准备';
  }

  function sportsStatusLabel(value) {
    return { unopened: '未开放', open: '接受竞猜', locked: '已锁定', settled: '已结束', canceled: '已取消' }[value] || value || '';
  }

  function sportsBetStatusLabel(value) {
    return { pending: '待开奖', won: '获胜', lost: '失败', refunded: '已退款' }[value] || value || '';
  }

  function sportsCashEventLabel(value) {
    return { stake: '竞猜扣款', payout: '竞猜派奖', refund: '竞猜退款' }[value] || value || '';
  }

  function renderSportsAuditDetail(match) {
    const homeOdds = match.market?.home_odds;
    const awayOdds = match.market?.away_odds;
    return `<div class="sports-audit-block">
      <div class="muted">阶段：${sportsStageLabel(match.stage)} · 状态：${sportsStatusLabel(match.status)}</div>
      <div class="muted">时间：${formatSportsTime(match.scheduled_at)}</div>
      <div class="muted">主队实力：${match.home_strength != null ? Number(match.home_strength).toFixed(2) : '—'} · 客队实力：${match.away_strength != null ? Number(match.away_strength).toFixed(2) : '—'}</div>
      <div class="muted">主队胜率：${match.home_win_probability != null ? (Number(match.home_win_probability) * 100).toFixed(2) + '%' : '—'} · 客队胜率：${match.away_win_probability != null ? (Number(match.away_win_probability) * 100).toFixed(2) + '%' : '—'}</div>
      <div class="muted">锁定赔率：主 ${homeOdds != null ? Number(homeOdds).toFixed(2) : '—'} / 客 ${awayOdds != null ? Number(awayOdds).toFixed(2) : '—'}</div>
      <div class="muted">开盘时间：${match.market_opened_at || '—'}</div>
      <div class="muted">封盘时间：${match.market_locked_at || '—'}</div>
      ${match.winner_team_id ? `<div class="muted">结果：${escapeHtml((match.home_team?.id === match.winner_team_id ? match.home_team?.name : match.away_team?.name) || '?')} 胜 ${match.home_score ?? '?'} - ${match.away_score ?? '?'}</div>` : ''}
      ${match.cancel_reason ? `<div class="muted">取消原因：${escapeHtml(match.cancel_reason)}</div>` : ''}
    </div>`;
  }

  function formatSportsTime(value) {
    if (!value) return '--';
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(new Date(value));
  }

  function formatSportsDate(value) {
    if (!value) return '';
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit'
    }).format(new Date(value + 'T12:00:00+08:00'));
  }

  function serverDate() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now);
    return parts.map(p => p.type !== 'literal' ? p.value : '').join('').replace(/\//g, '-');
  }

  function renderAccountView() {
    return renderPortfolio(false);
  }

  function renderLoanReminders() {
    var html = '';
    var al = state.activeLoan;
    if (al) {
      var ticksElapsed = Math.min(Math.max(0, al.ticks_elapsed || (state.currentTick - al.start_tick)), al.term_ticks || 18);
      var accrued = al.accrued_interest || 0;
      html += `
        <div class="loan-reminder" style="background:var(--surface-2);padding:12px 16px;border-radius:8px;margin:12px 0;">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
            <div>
              <div style="font-weight:700;">银行贷款</div>
              <div class="muted" style="font-size:13px;">本金 ${money(al.principal)} · 第 ${ticksElapsed}/${al.term_ticks || 18} 期 · 已产生利息 ${money(accrued)}</div>
            </div>
            <button class="secondary mini-button" data-action="set-view" data-view="loan">查看详情</button>
          </div>
        </div>
      `;
    }
    var p2p = state.p2pStatus;
    if (p2p && p2p.has_active_p2p && p2p.active_loan) {
      var pl = p2p.active_loan;
      var isLender = pl.role === 'lender';
      var ticksElapsedP2P = Math.min(pl.ticks_elapsed, pl.term_ticks);
      html += `
        <div class="loan-reminder" style="background:var(--surface-2);padding:12px 16px;border-radius:8px;margin:12px 0;border-left:3px solid var(--accent);">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
            <div>
              <div style="font-weight:700;">个人借贷${isLender ? '（出借中）' : '（借入中）'}</div>
              <div class="muted" style="font-size:13px;">本金 ${money(pl.principal)} · 第 ${ticksElapsedP2P}/${pl.term_ticks} 期 · ${isLender ? '预期收益' : '已产生利息'} ${isLender ? money(pl.expected_return) : money(pl.accrued_interest)}</div>
            </div>
            <button class="secondary mini-button" data-action="set-view" data-view="loan" data-loan-tab="p2p">查看详情</button>
          </div>
        </div>
      `;
    }
    return html;
  }

  function renderLoanView() {
    const loan = state.loanStatus;
    const p2p = state.p2pStatus;

    if (state.loading && !loan) {
      return '<section class="panel panel-pad"><div class="empty">加载中…</div></section>';
    }
    if (!loan) {
      return '<section class="panel panel-pad"><div class="empty">贷款数据加载中</div></section>';
    }
    if (loan.is_bankrupt) {
      return `
        <section class="panel panel-pad">
          <div class="panel-head">
            <h1 class="title">贷款</h1>
          </div>
          <div class="notice" style="background:var(--surface-2);border-left:4px solid var(--muted);padding:16px;border-radius:8px;">
            <div style="font-weight:700;margin-bottom:4px;">已破产</div>
            <div class="muted">你的账户已破产，无法申请贷款或交易。请联系管理员手动重置。</div>
          </div>
        </section>
      `;
    }

    const activeTab = state.loanTab || 'bank';
    return `
      <section class="panel panel-pad">
        <div class="panel-head">
          <h1 class="title">贷款</h1>
        </div>
        <div class="tab-bar" style="margin-bottom:16px;">
          <button class="tab-button ${activeTab === 'bank' ? 'active' : ''}" data-action="set-loan-tab" data-tab="bank">银行贷款</button>
          <button class="tab-button ${activeTab === 'p2p' ? 'active' : ''}" data-action="set-loan-tab" data-tab="p2p">个人借贷</button>
        </div>
        ${activeTab === 'bank' ? renderBankLoanView() : renderP2PView()}
      </section>
    `;
  }

  function renderP2PView() {
    const p2p = state.p2pStatus;
    if (!p2p) return '<div class="empty">加载中…</div>';

    if (p2p.has_active_p2p && p2p.active_loan) {
      return renderP2PActiveLoan(p2p);
    }

    return renderP2PMarketplace(p2p);
  }

  function renderP2PActiveLoan(p2p) {
    const al = p2p.active_loan;
    const isLender = al.role === 'lender';
    const ticksElapsed = Math.min(al.ticks_elapsed, al.term_ticks);
    const progressPct = Math.min(100, Math.round(ticksElapsed / al.term_ticks * 100));
    const isUrgent = al.ticks_remaining <= 3;
    const ratePct = (al.rate_per_tick * 100).toFixed(1);

    return `
      <div class="loan-summary" style="background:var(--surface-2);border-radius:8px;padding:18px;margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:12px;">
          <div>
            <div class="muted">${isLender ? '出借本金' : '借款本金'}</div>
            <div style="font-size:28px;font-weight:700;">${money(al.principal)}</div>
          </div>
          <div style="text-align:right;">
            <div class="muted">${isLender ? '已有 / 预期利息' : '已产生利息'}</div>
            <div style="font-size:18px;font-weight:600;${isUrgent ? 'color:var(--danger);' : ''}">${money(al.accrued_interest)}${isLender ? ' / ' + money(al.expected_return) : ''}</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
          <div><div class="muted" style="font-size:13px;">利率（每期）</div><div style="font-weight:600;">${ratePct}%</div></div>
          <div><div class="muted" style="font-size:13px;">对方</div><div style="font-weight:600;">${escapeHtml(al.counterparty_nickname || '')}</div></div>
          <div><div class="muted" style="font-size:13px;">到期</div><div style="font-weight:600;${isUrgent ? 'color:var(--danger);' : ''}">第 ${al.deadline_tick} 期${isUrgent ? ' ⚠' : ''}</div></div>
        </div>
        <div style="margin-top:12px;">
          <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;">
            <span>进度 ${ticksElapsed}/${al.term_ticks} 期</span>
            <span>${isUrgent ? '<span style="color:var(--danger);">剩余 ' + al.ticks_remaining + ' 期</span>' : '剩余 ' + al.ticks_remaining + ' 期'}</span>
          </div>
          <div style="background:var(--line);border-radius:4px;height:8px;overflow:hidden;">
            <div style="width:${progressPct}%;height:100%;background:${isUrgent ? 'var(--danger)' : 'var(--primary)'};border-radius:4px;transition:width 0.3s;"></div>
          </div>
        </div>
        ${isUrgent ? '<div class="notice" style="margin-top:12px;background:#fef3f2;border-left:4px solid var(--danger);">距到期仅剩 ' + al.ticks_remaining + ' 期！到期优先扣现金，不足将<strong>强制卖股</strong>还债。</div>' : ''}
        ${al.ticks_remaining <= 0 ? '<div class="notice" style="margin-top:12px;background:#fef3f2;border-left:4px solid var(--danger);"><strong>已到期！</strong>请在下一期推进前还清贷款，否则将触发强制平仓。</div>' : ''}
      </div>
      ${!isLender ? '<button class="primary" data-action="repay-p2p" style="width:100%;margin-bottom:16px;">提前还清个人借贷</button>' : ''}
    `;
  }

  function renderP2PMarketplace(p2p) {
    const openOrders = p2p.my_open_orders || [];
    return `
      <div style="display:flex;gap:10px;margin-bottom:16px;">
        <button class="primary" data-action="show-p2p-order-popup" data-direction="lend" style="flex:1;">我要出借</button>
        <button class="primary" data-action="show-p2p-order-popup" data-direction="borrow" style="flex:1;background:var(--accent);">我要借用</button>
      </div>
      ${openOrders.length > 0 ? `
        <div style="margin-bottom:16px;">
          <h2 class="section-title">我的挂单</h2>
          ${openOrders.map(o => renderP2POrderCard(o, true)).join('')}
        </div>
      ` : ''}
      <h2 class="section-title">市场挂单</h2>
      <div id="p2p-market-orders"><div class="empty">暂无挂单</div></div>
    `;
  }

  function renderP2POrderCard(order, isMine) {
    const rateLabel = ['','一档','二档','三档','四档'][order.rate_tier] || '';
    const termDays = order.term_ticks / 8;
    return `
      <div class="mini-row" style="justify-content:space-between;align-items:center;">
        <div>
          <strong><span class="p2p-tag ${order.direction === 'lend' ? 'p2p-tag-lend' : 'p2p-tag-borrow'}">${order.direction === 'lend' ? '出借' : '借入'}</span> ${escapeHtml(order.nickname || order.username || '')}</strong>
          <div class="muted">${money(order.amount)} · ${rateLabel}(${p2pRatePct(order.rate_tier)}%/期) · ${termDays}天 · 总利息 ${money(order.expected_return)}</div>
        </div>
        ${isMine ? `
          <button class="secondary mini-button" data-action="cancel-p2p-order" data-id="${order.id}">撤销</button>
        ` : `
          <button class="primary mini-button" data-action="match-p2p-order" data-id="${order.id}">匹配</button>
        `}
      </div>
    `;
  }

  function p2pRatePct(tier) {
    return [0.4, 0.8, 1.2, 1.6][tier - 1] || 0.4;
  }

  async function loadP2POrders(filter) {
    state.p2pFilter = filter || 'all';
    var url = '/api/p2p/orders';
    if (state.p2pFilter !== 'all') {
      url += '?direction=' + state.p2pFilter;
    }
    try {
      var data = await api(url);
      var container = document.getElementById('p2p-market-orders');
      if (container) {
        container.innerHTML = data.length
          ? data.map(o => renderP2POrderCard(o, false)).join('')
          : '<div class="empty">暂无挂单</div>';
      }
    } catch (e) { /* ignore */ }
  }

  function showP2POrderPopup(direction) {
    const isLend = direction === 'lend';
    const title = isLend ? '发布出借' : '发布借款';
    const rateLabels = ['一档(0.4%/期)', '二档(0.8%/期)', '三档(1.2%/期)', '四档(1.6%/期)'];
    const termLabels = ['2天(16期)', '3天(24期)', '4天(32期)', '5天(40期)'];
    const termValues = [16, 24, 32, 40];

    const popup = document.createElement('div');
    popup.className = 'modal-layer';
    popup.id = 'p2p-order-popup';
    popup.innerHTML = `
      <div class="confirm-modal" style="max-width:460px;">
        <div class="confirm-modal-body" style="display:flex;flex-direction:column;gap:16px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <h3 style="margin:0;">${title}</h3>
            <button class="secondary mini-button" data-action="p2p-close-popup">✕</button>
          </div>
          <div>
            <label style="font-weight:600;display:block;margin-bottom:6px;">利率档位</label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
              ${rateLabels.map((label, i) => `
                <button class="secondary p2p-rate-btn" data-rate="${i + 1}" style="padding:10px;text-align:center;font-size:13px;">${label}</button>
              `).join('')}
            </div>
          </div>
          <div>
            <label style="font-weight:600;display:block;margin-bottom:6px;">还款期限</label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
              ${termLabels.map((label, i) => `
                <button class="secondary p2p-term-btn" data-term="${termValues[i]}" style="padding:10px;text-align:center;font-size:13px;">${label}</button>
              `).join('')}
            </div>
          </div>
          <div class="field">
            <label for="p2pOrderAmount">金额（1万 – 200,000）</label>
            <input id="p2pOrderAmount" type="number" min="10000" max="200000" step="1000" placeholder="输入金额">
          </div>
          <div id="p2p-expected-return" class="notice" style="display:none;background:var(--surface-2);text-align:center;font-size:15px;font-weight:600;">
          </div>
          <div id="p2p-recommendations" style="display:none;">
            <div style="font-weight:600;margin-bottom:8px;">推荐匹配</div>
            <div id="p2p-rec-list"></div>
          </div>
        </div>
        <div class="confirm-modal-actions" style="display:flex;gap:10px;">
          <button class="secondary" data-action="p2p-close-popup" style="flex:1;">取消</button>
          <button class="primary" id="p2p-submit-order" data-direction="${direction}" style="flex:1;">直接发布</button>
        </div>
      </div>
    `;
    document.body.appendChild(popup);

    popup._p2p = { rate_tier: null, term_ticks: null };
    return popup;
  }

  function initP2POrderPopup(popup) {
    let selectedRate = null;
    let selectedTerm = null;

    popup.querySelectorAll('.p2p-rate-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        popup.querySelectorAll('.p2p-rate-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedRate = parseInt(btn.dataset.rate);
        popup._p2p.rate_tier = selectedRate;
        updateP2PPopupPreview(popup);
      });
    });

    popup.querySelectorAll('.p2p-term-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        popup.querySelectorAll('.p2p-term-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedTerm = parseInt(btn.dataset.term);
        popup._p2p.term_ticks = selectedTerm;
        updateP2PPopupPreview(popup);
      });
    });

    const amountInput = popup.querySelector('#p2pOrderAmount');
    amountInput.addEventListener('input', () => {
      var v = parseInt(amountInput.value);
      if (v > 200000) { amountInput.value = 200000; }
      updateP2PPopupPreview(popup);
    });

    popup.querySelectorAll('[data-action="p2p-close-popup"]').forEach(btn => {
      btn.addEventListener('click', () => popup.remove());
    });

    popup.addEventListener('click', (event) => {
      if (event.target === popup) popup.remove();
    });

    popup.querySelector('#p2p-submit-order').addEventListener('click', async () => {
      const amount = parseInt(amountInput.value);
      const direction = popup.querySelector('#p2p-submit-order').dataset.direction;

      if (!amount || amount < 10000 || amount > 200000) { await confirmAction({ title: '提示', message: '金额必须在 1 万 – 20 万之间', confirmText: '知道了', cancelText: '关闭' }); return; }
      if (!selectedRate) { await confirmAction({ title: '提示', message: '请选择利率档位', confirmText: '知道了', cancelText: '关闭' }); return; }
      if (!selectedTerm) { await confirmAction({ title: '提示', message: '请选择还款期限', confirmText: '知道了', cancelText: '关闭' }); return; }

      try {
        await api('/api/p2p/order', {
          method: 'POST',
          body: { direction, amount, rate_tier: selectedRate, term_ticks: selectedTerm }
        });
        popup.remove();
        await refreshCurrentView();
      } catch (e) { await confirmAction({ title: '发布失败', message: e.message || '发布失败', confirmText: '知道了', cancelText: '关闭' }); }
    });
  }

  async function updateP2PPopupPreview(popup) {
    const rateTier = popup._p2p.rate_tier;
    const termTicks = popup._p2p.term_ticks;
    const amount = parseInt(popup.querySelector('#p2pOrderAmount').value) || 0;
    const direction = popup.querySelector('#p2p-submit-order').dataset.direction;

    const retEl = popup.querySelector('#p2p-expected-return');
    if (rateTier && termTicks && amount >= 10000) {
      const rate = [0, 0.004, 0.008, 0.012, 0.016][rateTier] || 0;
      const expected = Math.round(amount * rate * termTicks);
      const isLend = direction === 'lend';
      retEl.style.display = 'block';
      retEl.innerHTML = isLend
        ? '预期收益: ' + money(expected) + '（' + (expected / amount * 100).toFixed(1) + '%）'
        : '预期应还利息: ' + money(expected) + '（' + (expected / amount * 100).toFixed(1) + '%）';
    } else {
      retEl.style.display = 'none';
    }

    const recEl = popup.querySelector('#p2p-recommendations');
    const recList = popup.querySelector('#p2p-rec-list');
    if (rateTier && termTicks && amount >= 10000) {
      try {
        const orders = await api('/api/p2p/orders');
        const oppositeDir = direction === 'lend' ? 'borrow' : 'lend';
        const scored = orders
          .filter(o => o.direction === oppositeDir)
          .map(o => {
            let score = 0;
            if (o.rate_tier === rateTier) score += 3;
            else if (Math.abs(o.rate_tier - rateTier) === 1) score += 1;
            if (o.term_ticks === termTicks) score += 2;
            else if (Math.abs(o.term_ticks - termTicks) <= 8) score += 1;
            if (Math.abs(o.amount - amount) / Math.max(amount, 1) <= 0.2) score += 1;
            return { ...o, score };
          })
          .filter(o => o.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3);
        if (scored.length) {
          recEl.style.display = 'block';
          recList.innerHTML = scored.map(o => `
            <div class="mini-row" style="justify-content:space-between;align-items:center;">
              <div>
                <strong><span class="p2p-tag ${o.direction === 'lend' ? 'p2p-tag-lend' : 'p2p-tag-borrow'}">${o.direction === 'lend' ? '出借' : '借入'}</span> ${escapeHtml(o.nickname || o.username || '')}</strong>
                <div class="muted">${money(o.amount)} · ${p2pRatePct(o.rate_tier)}%/期 · ${o.term_ticks / 8}天 · 匹配度${matchStars(o.score)}</div>
              </div>
              <button class="primary mini-button p2p-rec-match" data-id="${o.id}">匹配</button>
            </div>
          `).join('');
          recList.querySelectorAll('.p2p-rec-match').forEach(btn => {
            btn.addEventListener('click', async () => {
              const orderId = parseInt(btn.dataset.id);
              try {
                await api('/api/p2p/order/' + orderId + '/match', { method: 'POST' });
                popup.remove();
                await refreshCurrentView();
              } catch (e) { await confirmAction({ title: '操作失败', message: e.message || '匹配失败', confirmText: '知道了', cancelText: '关闭' }); }
            });
          });
        } else {
          recEl.style.display = 'none';
        }
      } catch (e) { recEl.style.display = 'none'; }
    } else {
      recEl.style.display = 'none';
    }
  }

  function matchStars(score) {
    let s = '';
    for (let i = 0; i < Math.min(score, 4); i++) s += '\u2605';
    return s;
  }

  function renderBankLoanView() {
    const loan = state.loanStatus;

    if (state.loading && !loan) {
      return '<section class="panel panel-pad"><div class="empty">加载中…</div></section>';
    }

    if (!loan) {
      return '<section class="panel panel-pad"><div class="empty">贷款数据加载中</div></section>';
    }

    if (loan.is_bankrupt) {
      return `
        <section class="panel panel-pad">
          <div class="panel-head">
            <h1 class="title">贷款</h1>
          </div>
          <div class="notice" style="background:var(--surface-2);border-left:4px solid var(--muted);padding:16px;border-radius:8px;">
            <div style="font-weight:700;margin-bottom:4px;">已破产</div>
            <div class="muted">你的账户已破产，无法申请贷款或交易。请联系管理员手动重置。</div>
          </div>
        </section>
      `;
    }

    const tier = loan.bank_tier || 1;
    const tierStars = '\u2605'.repeat(tier) + '\u2606'.repeat(3 - tier);
    const tierColor = tier === 3 ? 'var(--danger)' : tier === 2 ? 'var(--accent)' : 'var(--primary)';

    const tierBadge = `
      <div style="background:var(--surface-2);border-radius:8px;padding:12px 16px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div style="font-size:14px;font-weight:600;color:${tierColor};">${tierStars} ${loan.tier_label}</div>
          <div class="muted" style="font-size:12px;">可贷额度：资产×${Math.round(loan.tier_benefits.ltv * 100)}% · ${loan.available_terms_label || (loan.tier_benefits.term_ticks + ' 期')}</div>
        </div>
      </div>
    `;

    if (loan.has_active_loan && loan.active_loan) {
      const al = loan.active_loan;
      const ticksElapsed = Math.min(al.ticks_elapsed, al.term_ticks || 18);
      const progressPct = Math.min(100, Math.round(ticksElapsed / (al.term_ticks || 18) * 100));
      const isUrgent = al.ticks_remaining <= 3;
      const accrued = al.accrued_interest || 0;
      const totalNow = al.total_to_repay_now || (al.principal + accrued);

      return `
        <section class="panel panel-pad">
          <div class="panel-head">
            <h1 class="title">贷款</h1>
            <span class="status-pill" style="background:var(--accent);color:#fff;">还款中</span>
          </div>
          ${tierBadge}
          <div class="loan-summary" style="background:var(--surface-2);border-radius:8px;padding:18px;margin-bottom:16px;">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
              <div>
                <div class="muted">应还本金</div>
                <div style="font-size:28px;font-weight:700;">${money(al.principal)}</div>
              </div>
              <div style="text-align:right;">
                <div class="muted">已产生利息</div>
                <div style="font-size:18px;font-weight:600;${isUrgent ? 'color:var(--danger);' : ''}">${money(accrued)}</div>
              </div>
            </div>
            <div style="margin-top:12px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
              <div>
                <div class="muted" style="font-size:13px;">每期利息</div>
                <div style="font-weight:600;${isUrgent ? 'color:var(--danger);' : ''}">${money(al.per_tick_interest)}</div>
              </div>
              <div>
                <div class="muted" style="font-size:13px;">当前应还</div>
                <div style="font-weight:600;">${money(totalNow)}</div>
              </div>
              <div>
                <div class="muted" style="font-size:13px;">到期</div>
                <div style="font-weight:600;${isUrgent ? 'color:var(--danger);' : ''}">第 ${al.deadline_tick} 期${isUrgent ? ' ⚠' : ''}</div>
              </div>
            </div>
            <div style="margin-top:12px;">
              <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;">
                <span>还款进度 ${ticksElapsed}/${al.term_ticks || 18} 期</span>
                <span>${isUrgent ? `<span style="color:var(--danger);">剩余 ${al.ticks_remaining} 期</span>` : `剩余 ${al.ticks_remaining} 期`}</span>
              </div>
              <div style="background:var(--line);border-radius:4px;height:8px;overflow:hidden;">
                <div style="width:${progressPct}%;height:100%;background:${isUrgent ? 'var(--danger)' : 'var(--primary)'};border-radius:4px;transition:width 0.3s;"></div>
              </div>
            </div>
            ${isUrgent ? `<div class="notice" style="margin-top:12px;background:#fef3f2;border-left:4px solid var(--danger);">距到期仅剩 ${al.ticks_remaining} 期！到期优先扣现金，不足将<strong>强制卖股</strong>还债。</div>` : ''}
            ${al.ticks_remaining <= 0 ? '<div class="notice" style="margin-top:12px;background:#fef3f2;border-left:4px solid var(--danger);"><strong>已到期！</strong>请在下一期推进前还清贷款，否则将触发强制平仓。</div>' : ''}
          </div>
          <button class="primary" data-action="repay-loan" style="width:100%;margin-bottom:16px;">提前还清贷款</button>
        </section>
      `;
    }

    const mb = loan.max_breakdown;
    const term = loan.tier_benefits.term_ticks;
    return `
      <section class="panel panel-pad">
        ${tierBadge}
        <div class="loan-summary" style="background:var(--surface-2);border-radius:8px;padding:18px;margin-bottom:16px;">
          <div class="muted">最高可贷额度</div>
          <div style="font-size:28px;font-weight:700;color:var(--primary);">${money(loan.max_loan_amount)}</div>
          <div class="muted" style="margin-top:4px;font-size:13px;">额度 = 总资产 × ${Math.round(loan.tier_benefits.ltv * 100)}%（四舍五入至 5 万整） · 期限 ${term} 期</div>
        </div>
        <h2 class="section-title">利率阶梯</h2>
        <div class="loan-tiers" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px;">
          <div class="loan-tier" style="background:var(--surface-2);border-radius:8px;padding:14px;text-align:center;${loan.max_loan_amount <= 100000 ? 'border:2px solid var(--primary);' : ''}">
            <div style="font-size:13px;color:var(--muted);margin-bottom:4px;">基础授信</div>
            <div style="font-weight:700;margin-bottom:2px;">0 – 100,000</div>
            <div style="font-size:18px;font-weight:700;color:var(--down);">0.20%</div>
            <div style="font-size:12px;color:var(--muted);">每期利率</div>
          </div>
          <div class="loan-tier" style="background:var(--surface-2);border-radius:8px;padding:14px;text-align:center;${loan.max_loan_amount > 100000 && loan.max_loan_amount <= 300000 ? 'border:2px solid var(--accent);' : ''}">
            <div style="font-size:13px;color:var(--muted);margin-bottom:4px;">追加授信</div>
            <div style="font-weight:700;margin-bottom:2px;">100,001 – 300,000</div>
            <div style="font-size:18px;font-weight:700;color:var(--accent);">0.50%</div>
            <div style="font-size:12px;color:var(--muted);">每期利率</div>
          </div>
          <div class="loan-tier" style="background:var(--surface-2);border-radius:8px;padding:14px;text-align:center;">
            <div style="font-size:13px;color:var(--muted);margin-bottom:4px;">高额授信</div>
            <div style="font-weight:700;margin-bottom:2px;">300,001 以上</div>
            <div style="font-size:18px;font-weight:700;color:var(--danger);">1.00%</div>
            <div style="font-size:12px;color:var(--muted);">每期利率</div>
          </div>
        </div>
        ${mb ? `
          <div class="loan-calculator" style="background:var(--surface-2);border-radius:8px;padding:18px;margin-bottom:16px;">
            <h3 style="margin:0 0 12px;font-size:15px;">期限与利息试算</h3>
            <div class="term-buttons" id="loanTermButtons">
              ${[16, 24, 32].map(t => {
                const available = (loan.available_terms || []).includes(t);
                const isFirst = t === (loan.available_terms || [16])[0];
                return `<button class="term-btn${isFirst ? ' active' : ''}${!available ? ' disabled' : ''}"
                  data-action="loan-term" data-term="${t}" type="button"${!available ? ' disabled' : ''}>${t} 期</button>`;
              }).join('')}
            </div>
            <div class="interest-preview" id="loanInterestPreview">
              <div class="interest-main">预计总利息 <strong>--</strong></div>
              <div class="interest-detail">
                <span>每期利息 <b>--</b></span>
                <span>日化率 <b>--</b></span>
                <span>占本金 <b>--</b></span>
              </div>
            </div>
          </div>
        ` : ''}
        <form data-form="loan-borrow" style="display:flex;gap:10px;align-items:flex-end;">
          <div class="field" style="flex:1;margin:0;">
            <label for="loanAmount">贷款金额</label>
            <input id="loanAmount" name="loanAmount" type="number" min="1" max="${loan.max_loan_amount}" step="1" data-clamp="loan-amount" placeholder="输入贷款金额（1 – ${money(loan.max_loan_amount)}）" style="background:#fff;" oninput="window.updateLoanPreview()" required>
          </div>
          <button type="submit" class="primary" ${state.loading ? 'disabled' : ''} ${loan.max_loan_amount <= 0 ? 'disabled' : ''}>申请贷款</button>
        </form>
      </section>
    `;
  }

  function renderMarketOverview() {
    const overview = state.market_overview;
    if (!overview) {
      return `<section class="panel panel-pad"><div class="empty">大盘数据加载中</div></section>`;
    }
    return `
      <section class="panel panel-pad market-overview">
        ${renderClockPanel()}
        <div class="market-index">
          <div class="market-index-head">
            <div class="market-index-kicker muted">大盘指数</div>
            <div class="market-index-value ${trendClass(overview.change_pct)}">${price(overview.current_index)}</div>
            <div class="market-index-change ${trendClass(overview.change_pct)}">${percent(overview.change_pct)}</div>
          </div>
          <div class="market-counts">
            <div><strong class="up">${overview.up_count || 0}</strong><span>上涨</span></div>
            <div><strong class="down">${overview.down_count || 0}</strong><span>下跌</span></div>
            <div><strong class="flat">${overview.flat_count || 0}</strong><span>平盘</span></div>
          </div>
        </div>
        ${renderLineChart((overview.history || []).slice(-CHART_HISTORY_WINDOW), '大盘走势线图', 'market-chart')}
      </section>
    `;
  }

  function renderMarketMovers() {
    const overview = state.market_overview || {};
    return `
      <aside class="mover-stack">
        ${renderMoverPanel('涨幅榜', overview.top_gainers || [], 'up')}
        ${renderMoverPanel('跌幅榜', overview.top_losers || [], 'down')}
        ${renderMoverPanel('波动榜', overview.top_volatile || [], 'flat')}
      </aside>
    `;
  }

  function renderMoverPanel(title, rows, tone) {
    return `
      <section class="panel panel-pad mover-panel">
        <h2 class="section-title">${title}</h2>
        ${rows.length ? rows.map((row) => `
          <div class="mini-row">
            <div>
              <strong>${escapeHtml(row.name)}</strong>
              <div class="muted">${escapeHtml(row.code)} · ${escapeHtml(row.industry)}</div>
            </div>
            <div class="num ${tone === 'flat' ? trendClass(row.change_pct) : tone}">${percent(row.change_pct)}</div>
          </div>
        `).join('') : '<div class="empty compact-empty">暂无数据</div>'}
      </section>
    `;
  }

  function renderRanking() {
    const ranking = state.ranking;
    if (!ranking) {
      return `<section class="panel panel-pad"><div class="empty">暂无排行榜数据</div></section>`;
    }
    const todayList = ranking.today || ranking.return_today || ranking.return7 || [];
    const todayRank = ranking.my?.today_rank || ranking.my?.return_today_rank || ranking.my?.return7_rank || '--';
    return `
      <section class="panel panel-pad">
        <div class="panel-head">
          <div>
            <h1 class="title">SSB排行榜</h1>
            <div class="muted">第 ${ranking.current_tick} 期 · 今日第 ${tickProgressText(ranking.market_clock || state.market_clock)} 期</div>
          </div>
          <span class="status-pill">净资产第${ranking.my?.asset_rank || '--'}名 &nbsp;|&nbsp; 今日收益率第${todayRank}名</span>
        </div>
        <div class="rank-grid">
          <div>
            <h2 class="section-title">当前净资产</h2>
            ${renderRankingList(ranking.asset || [], 'asset')}
          </div>
          <div>
            <h2 class="section-title">今日收益率</h2>
            ${renderRankingList(todayList, 'today')}
          </div>
        </div>
      </section>
    `;
  }

  function renderRankingList(list, type) {
    if (!list.length) return '<div class="empty">暂无已激活玩家</div>';
    return list.map((item) => `
      <div class="rank-row ${item.is_me ? 'rank-me' : ''}">
        <div class="rank-no">${item.rank}</div>
        <div>
          <strong>${escapeHtml(item.nickname)}</strong>
        </div>
        <div class="num ${type !== 'asset' ? trendClass(item.return_today ?? item.return7) : ''}">
          ${type === 'asset' ? money(item.total_asset) : percent(item.return_today ?? item.return7)}
        </div>
      </div>
    `).join('');
  }

  function renderGuide() {
    var md = state.guideContent;
    if (!md) return '<section class="panel panel-pad"><div class="empty">加载中...</div></section>';
    var lines = md.split('\n');
    var sections = [];
    var html = '';
    var buf = '';
    var inTable = false;
    var tableHtml = '';
    var inBlockquote = false;
    var firstH1 = true;

    function flushPara() {
      var t = buf.trim();
      buf = '';
      if (!t) return;
      // inline bold
      t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      html += '<p>' + t + '</p>';
    }

    function flushTable() {
      if (!inTable) return;
      inTable = false;
      html += '<table>' + tableHtml + '</table>';
      tableHtml = '';
    }

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var line = raw.trim();

      // blockquote
      if (line.startsWith('> ')) {
        flushPara();
        flushTable();
        var qt = line.slice(2).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        if (inBlockquote) {
          html += '<br>' + qt;
        } else {
          inBlockquote = true;
          html += '<blockquote>' + qt;
        }
        continue;
      } else if (inBlockquote) {
        inBlockquote = false;
        html += '</blockquote>';
      }

      // headings
      if (line.startsWith('#### ')) {
        flushPara(); flushTable();
        html += '<h4>' + esc(line.slice(5)) + '</h4>';
        continue;
      }
      if (line.startsWith('### ')) {
        flushPara(); flushTable();
        html += '<h3>' + esc(line.slice(4)) + '</h3>';
        continue;
      }
      if (line.startsWith('## ')) {
        flushPara(); flushTable();
        var hLabel = line.slice(3).replace(/\*\*(.+?)\*\*/g, '$1');
        var hId = 'guide-' + secIndex(sections.length);
        sections.push({ id: hId, label: hLabel });
        html += '<h2 id="' + hId + '">' + esc(line.slice(3)) + '</h2>';
        continue;
      }
      if (line.startsWith('# ')) {
        flushPara(); flushTable();
        html += firstH1 ? '<h1>' + esc(line.slice(2)) + '</h1>' : '';
        firstH1 = false;
        continue;
      }

      // hr
      if (line === '---') {
        flushPara(); flushTable();
        continue;
      }

      // table
      if (line.startsWith('|')) {
        flushPara();
        var cells = line.split('|').filter(function(c) { return c.trim(); });
        var isSep = cells.every(function(c) { return /^:?-{3,}:?$/.test(c.trim()); });
        if (isSep) continue;
        if (!inTable) { inTable = true; tableHtml = ''; }
        var tag = inTable && tableHtml.indexOf('<tbody>') >= 0 ? 'td' : 'th';
        tableHtml += '<tr>' + cells.map(function(c) {
          return '<' + tag + '>' + c.trim().replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') + '</' + tag + '>';
        }).join('') + '</tr>';
        if (tag === 'th') { tableHtml = '<thead>' + tableHtml + '</thead><tbody>'; }
        continue;
      } else if (inTable) {
        flushTable();
      }

      // list items
      if (/^\d+\.\s/.test(line)) {
        flushPara(); flushTable();
        html += '<ol><li>' + line.replace(/^\d+\.\s/, '').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') + '</li></ol>';
        continue;
      }
      if (line.startsWith('- ')) {
        flushPara(); flushTable();
        html += '<ul><li>' + line.slice(2).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') + '</li></ul>';
        continue;
      }

      // empty line → paragraph break
      if (!line) {
        flushPara();
        continue;
      }

      // regular text
      if (buf) buf += ' ';
      buf += line;
    }
    flushPara();
    flushTable();
    if (inBlockquote) html += '</blockquote>';

    // merge consecutive ul/ol
    html = html.replace(/<\/ul>\s*<ul>/g, '').replace(/<\/ol>\s*<ol>/g, '');

    var navHtml = '<nav class="guide-nav"><div class="guide-nav-bar" id="guideNavBar"></div><ul>';
    sections.forEach(function(s) {
      navHtml += '<li><a href="#' + s.id + '" data-guide-link="' + s.id + '" onclick="document.getElementById(\'' + s.id + '\').scrollIntoView({behavior:\'smooth\',block:\'start\'});return false;">' + s.label + '</a></li>';
    });
    navHtml += '</ul></nav>';

    return '<section class="guide-layout">' +
      navHtml +
      '<article class="guide-content">' + html + '</article>' +
      '</section>';
  }

  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function secIndex(n) { return 's' + n; }

  function renderAdmin() {
    if (!state.user?.is_admin) return '<section class="panel panel-pad"><div class="empty">无管理员权限</div></section>';
    const admin = state.admin;
    if (!admin) return '<section class="panel panel-pad"><div class="empty">暂无后台数据</div></section>';
    const invites = admin.invites || [];
    const unusedInviteCount = invites.filter((invite) => invite.status !== 'used').length;
    const recentTransactions = admin.recent_transactions || [];

    return `
      <section class="panel panel-pad">
        <div class="panel-head">
          <div>
            <h1 class="title">运营台</h1>
            <div class="muted">第 ${admin.current_tick} 期 · ${admin.active_count}/${admin.account_count - 1} 位玩家已激活 · ${marketClockShortText(admin.market_clock)}</div>
          </div>
          <span class="status-pill">管理员</span>
        </div>
        ${renderClockPanel(admin.market_clock)}
        <div class="admin-actions">
          <button class="secondary" data-action="advance" ${state.loading || state.sleeping ? 'disabled' : ''}>手动补推进</button>
          <button class="secondary" data-action="toggle-market" ${state.loading || state.sleeping ? 'disabled' : ''}>${admin.market_clock?.force_open ? '恢复封盘' : '临时解除封盘'}</button>
          <button class="danger" data-action="reset-market" ${state.loading ? 'disabled' : ''}>重置市场周期</button>
          <button class="danger" data-action="reset-passwords" ${state.loading ? 'disabled' : ''}>重置所有玩家密码</button>
        </div>
        ${renderAdminAccordion('stocks', '股票管理', `${(admin.stocks || STOCKS).length} 只股票`, renderAdminStocks)}
        ${renderAdminAccordion('invites', '邀请码管理', `${invites.length} 个邀请码 · ${unusedInviteCount} 个未注册`, renderAdminInvites)}
        ${renderAdminAccordion('accounts', '账号状态', `${(admin.accounts || []).length} 个账号`, renderAdminAccounts)}
        ${renderAdminAccordion('transactions', '最近交易', `${recentTransactions.length} 笔记录`, () => renderAdminTransactions(recentTransactions))}
        ${renderAdminAccordion('sports', '赛事运营', admin.sports?.season ? `第 ${admin.sports.season.season_no} 赛季 · ${sportsStageLabel(admin.sports.season.status)}` : '赛事准备中', renderAdminSports)}
      </section>
    `;
  }

  function renderAdminAccordion(key, title, summary, renderContent) {
    const expanded = !!state.adminSections[key];
    return `
      <section class="admin-accordion ${expanded ? 'is-open' : ''}">
        <button
          class="admin-accordion-toggle"
          type="button"
          data-action="toggle-admin-section"
          data-section="${key}"
          aria-expanded="${expanded ? 'true' : 'false'}"
        >
          <span class="admin-accordion-title">${title}</span>
          <span class="admin-accordion-summary">${summary}</span>
          <span class="admin-accordion-state">${expanded ? '收起' : '展开'}</span>
        </button>
        ${expanded ? `<div class="admin-accordion-body">${renderContent()}</div>` : ''}
      </section>
    `;
  }

  function renderAdminInvites() {
    return `
      <div class="invite-generate-row">
        <input id="inviteCount" name="inviteCount" type="number" min="1" max="100" value="5" class="compact-input" autocomplete="off" aria-label="生成邀请码数量">
        <button class="secondary" data-action="generate-invites" ${state.loading ? 'disabled' : ''}>批量生成</button>
      </div>
      <div class="invite-table">
        ${renderInviteTable(state.admin?.invites || [])}
      </div>
    `;
  }

  function renderAdminSports() {
    const sportsAdmin = state.admin?.sports;
    if (!sportsAdmin) return '<div class="empty">赛事运营数据加载中</div>';
    const config = sportsAdmin.config || {};
    const next = config.next || config;
    const actionable = (sportsAdmin.matches || []).filter((match) => !['settled', 'canceled'].includes(match.status)).slice(0, 24);
    return `
      <div class="sports-admin-summary">
        <div class="sports-summary-grid compact">
          <div class="sports-stat"><span>竞猜总额</span><strong>${money(sportsAdmin.totals?.staked || 0)}</strong></div>
          <div class="sports-stat"><span>累计派奖</span><strong>${money(sportsAdmin.totals?.paid || 0)}</strong></div>
          <div class="sports-stat"><span>累计退款</span><strong>${money(sportsAdmin.totals?.refunded || 0)}</strong></div>
          <div class="sports-stat"><span>赛事状态</span><strong>${sportsAdmin.paused ? '暂停' : '运行中'}</strong></div>
        </div>
        <div class="admin-actions">
          <button class="secondary" data-action="sports-pause" data-paused="${sportsAdmin.paused ? 'false' : 'true'}">${sportsAdmin.paused ? '恢复赛事' : '暂停赛事'}</button>
          <button class="danger" data-action="sports-advance-stage">推进当前阶段</button>
        </div>
        <h3 class="section-title">下一赛季参数</h3>
        <form class="sports-config-form" data-form="sports-config">
          ${sportsConfigField('house_edge', '系统优势', next.house_edge, 0, 0.2, 0.01)}
          ${sportsConfigField('min_bet', '单笔最低', next.min_bet, 1, 100000, 100)}
          ${sportsConfigField('max_bet_per_match', '单场累计上限', next.max_bet_per_match, 1000, 1000000, 1000)}
          ${sportsConfigField('home_advantage', '主场优势', next.home_advantage, 0, 0.1, 0.01)}
          ${sportsConfigField('regular_form_cap', '常规赛状态上限', next.regular_form_cap, 0, 0.25, 0.01)}
          ${sportsConfigField('form_cap', '季后赛状态上限', next.form_cap, 0, 0.25, 0.01)}
          ${sportsConfigField('regular_win_cap', '常规赛胜率上限', next.regular_win_cap, 0.5, 0.95, 0.01)}
          ${sportsConfigField('playoff_win_cap', '季后赛胜率上限', next.playoff_win_cap, 0.5, 0.98, 0.01)}
          ${sportsConfigField('regular_scale_factor', '常规赛实力敏感度', next.regular_scale_factor, 0.05, 0.30, 0.01)}
          ${sportsConfigField('scale_factor', '季后赛实力敏感度', next.scale_factor, 0.05, 0.30, 0.01)}
          <button class="primary" type="submit">保存下一赛季参数</button>
        </form>
        <h3 class="section-title">待处理比赛</h3>
        <div class="sports-admin-matches">${actionable.map((match) => `
          <div class="flat-row sports-admin-match-row">
            <div><strong>${escapeHtml(match.home_team?.name || '待定')} vs ${escapeHtml(match.away_team?.name || '待定')}</strong><div class="muted">${formatSportsTime(match.scheduled_at)} · ${sportsStageLabel(match.stage)} · ${sportsStatusLabel(match.status)}</div></div>
            <div class="sports-admin-match-actions">
              <button class="secondary mini-button" data-action="sports-audit-match" data-match-id="${escapeHtml(match.id)}">查看审计</button>
              <button class="mini-danger" data-action="sports-cancel-match" data-match-id="${escapeHtml(match.id)}">取消并退款</button>
            </div>
          </div>
          <div class="sports-audit-detail" id="sports-audit-${escapeHtml(match.id)}" hidden>${renderSportsAuditDetail(match)}</div>
        `).join('') || '<div class="empty">暂无待处理比赛</div>'}</div>
        <h3 class="section-title sports-side-title">近期比赛审计快照（按时间倒序，最多 40 场）</h3>
        <div class="sports-admin-audit">${(sportsAdmin.matches || []).slice(0, 40).map((match) => `
          <div class="flat-row">
            <div>
              <strong>${escapeHtml(match.home_team?.name || '待定')} vs ${escapeHtml(match.away_team?.name || '待定')}</strong>
              <div class="muted">${formatSportsTime(match.scheduled_at)} · ${sportsStageLabel(match.stage)} · ${sportsStatusLabel(match.status)}</div>
              <div class="muted sports-audit-line">实力 ${match.home_strength != null ? Number(match.home_strength).toFixed(1) : '—'} / ${match.away_strength != null ? Number(match.away_strength).toFixed(1) : '—'} · 胜率 ${match.home_win_probability != null ? (Number(match.home_win_probability) * 100).toFixed(1) : '—'}% / ${match.away_win_probability != null ? (Number(match.away_win_probability) * 100).toFixed(1) : '—'}% · 锁定赔率 ${match.market?.home_odds != null ? Number(match.market.home_odds).toFixed(2) : '—'} / ${match.market?.away_odds != null ? Number(match.market.away_odds).toFixed(2) : '—'}</div>
            </div>
            <span class="num muted">${match.winner_team_id ? `胜方 ${escapeHtml((match.home_team?.id === match.winner_team_id ? match.home_team?.name : match.away_team?.name) || '?')}` : '未开赛'}</span>
          </div>`).join('') || '<div class="empty">暂无审计快照</div>'}</div>
        <h3 class="section-title sports-side-title">系列赛市场审计</h3>
        <div class="sports-admin-audit">${(sportsAdmin.series || []).map((series) => `
          <div class="flat-row">
            <div>
              <strong>${escapeHtml(series.home_team?.name || '待定')} vs ${escapeHtml(series.away_team?.name || '待定')}</strong>
              <div class="muted">${sportsStageLabel(series.stage)} · ${sportsStatusLabel(series.market?.status || series.status)}</div>
              <div class="muted sports-audit-line">系列赛胜率 ${series.market?.home_win_probability != null ? (Number(series.market.home_win_probability) * 100).toFixed(1) : '—'}% / ${series.market?.away_win_probability != null ? (Number(series.market.away_win_probability) * 100).toFixed(1) : '—'}% · 锁定赔率 ${series.market?.home_odds != null ? Number(series.market.home_odds).toFixed(2) : '—'} / ${series.market?.away_odds != null ? Number(series.market.away_odds).toFixed(2) : '—'}</div>
            </div>
            <span class="num muted">${series.home_wins}-${series.away_wins}</span>
          </div>`).join('') || '<div class="empty">暂无系列赛市场</div>'}</div>
        <h3 class="section-title sports-side-title">竞猜资金审计</h3>
        <div class="sports-admin-audit">${(sportsAdmin.recent_cash_events || []).map((event) => `
          <div class="flat-row">
            <div><strong>${escapeHtml(event.nickname || event.user_id)}</strong><div class="muted">${sportsCashEventLabel(event.event_type)} · ${escapeHtml(event.series_id ? `系列赛 ${event.series_id}` : (event.match_id || ''))}</div></div>
            <span class="num ${Number(event.amount) >= 0 ? 'up' : 'down'}">${Number(event.amount) >= 0 ? '+' : ''}${money(event.amount)}</span>
          </div>`).join('') || '<div class="empty">暂无赛事资金流水</div>'}</div>
        <h3 class="section-title sports-side-title">球员流动记录</h3>
        <div class="sports-admin-audit">${(sportsAdmin.moves || []).map((move) => `
          <div class="flat-row">
            <div><strong>${escapeHtml(move.player_name)}</strong><div class="muted">${move.move_type === 'regular_trade' ? '常规赛交易' : '休赛期轮换'} · ${escapeHtml(move.position)} · ${escapeHtml(move.from_team_name)} → ${escapeHtml(move.to_team_name)}</div></div>
          </div>`).join('') || '<div class="empty">本赛季暂无球员流动</div>'}</div>
        <h3 class="section-title sports-side-title">选秀成长记录</h3>
        <div class="sports-admin-audit">${(sportsAdmin.developments || []).map((item) => `
          <div class="flat-row">
            <div><strong>${escapeHtml(item.player_name)}</strong><div class="muted">${escapeHtml(item.team_name)} · 常规赛第 ${item.regular_rank} 名 · ${sportsDevelopmentLabel(item.development_type)}</div></div>
            <span class="num up">${item.ability_before} → ${item.ability_after}</span>
          </div>`).join('') || '<div class="empty">暂无选秀成长记录</div>'}</div>
      </div>
    `;
  }

  function sportsConfigField(name, label, value, min, max, step) {
    return `<label class="field compact-field"><span>${label}</span><input name="${name}" type="number" min="${min}" max="${max}" step="${step}" value="${escapeHtml(value)}" required></label>`;
  }

  function sportsDevelopmentLabel(value) {
    return {
      limited: '有限成长',
      rotation_breakthrough: '轮换突破',
      starter_breakthrough: '首发突破'
    }[value] || value || '';
  }

  function renderAdminAccounts() {
    const accounts = state.admin?.accounts || [];
    if (!accounts.length) return '<div class="empty">暂无账号</div>';
    return `
      <div class="account-list">
        ${accounts.map(renderAdminAccount).join('')}
      </div>
    `;
  }

  function renderInviteTable(invites) {
    if (!invites.length) return '<div class="empty">暂无邀请码</div>';
    return `
      <div class="invite-header">
        <span>邀请码</span><span>昵称</span><span>状态</span><span>注册者</span><span>生成时间</span><span>操作</span>
      </div>
      ${invites.map(renderInviteRow).join('')}
    `;
  }

  function renderInviteRow(inv) {
    const used = inv.status === 'used';
    const statusClass = used ? 'invite-used' : 'invite-unused';
    const statusText = used ? `已注册 · ${escapeHtml(inv.used_by_username || '')}` : '未注册';
    return `
      <div class="invite-row" data-code="${escapeHtml(inv.code)}">
        <span class="invite-code">${escapeHtml(inv.code)}</span>
        <span class="invite-nickname-cell">
          <input class="invite-nickname-input" value="${escapeHtml(inv.nickname || '')}" placeholder="输入昵称" data-invite-code="${escapeHtml(inv.code)}" maxlength="24">
          <button class="mini-button primary" data-action="save-invite-nickname" data-invite-code="${escapeHtml(inv.code)}">保存</button>
        </span>
        <span class="${statusClass}">${statusText}</span>
        <span class="muted">${inv.used_by_username ? escapeHtml(inv.used_by_username) : '—'}</span>
        <span class="muted">${dateText(inv.created_at)}</span>
        <span>
          ${!used ? `<button class="mini-danger" data-action="revoke-invite" data-invite-code="${escapeHtml(inv.code)}" ${state.loading ? 'disabled' : ''}>撤销</button>` : '<span class="muted">—</span>'}
        </span>
      </div>
    `;
  }

  function renderAdminStocks() {
    const stocks = state.admin?.stocks || STOCKS;
    const editStock = stocks.find((stock) => stock.code === state.adminStockEditCode);
    const nextCode = state.admin?.next_stock_code || suggestClientStockCode(stocks);
    return `
      <form class="stock-admin-form" data-form="add-stock">
        ${renderStockFields({
          code: nextCode,
          name: '',
          sector: '其他',
          industry: '',
          initial_price: 20,
          volatility: 0.05,
          risk_level: 'mid'
        })}
        <button class="secondary" type="submit" ${state.loading ? 'disabled' : ''}>新增股票</button>
      </form>
      ${editStock ? `
        <form class="stock-admin-form stock-edit-form" data-form="update-stock">
          <input type="hidden" name="currentCode" value="${escapeHtml(editStock.code)}">
          ${renderStockFields(editStock)}
          <button class="primary" type="submit" ${state.loading ? 'disabled' : ''}>保存修改</button>
          <button class="secondary" type="button" data-action="cancel-stock-edit">取消</button>
        </form>
      ` : ''}
      <div class="stock-admin-list">
        ${stocks.map((stock) => `
          <div class="stock-admin-row">
            <div>
              <strong>${escapeHtml(stock.name)}</strong>
              <div class="muted">${escapeHtml(stock.code)} · ${escapeHtml(stock.sector || '其他')} / ${escapeHtml(stock.industry)} · ${riskLabel(stock.risk_level)}</div>
            </div>
            <div class="admin-meta">
              <span>初始 ${price(stock.initial_price)}</span>
              <span>波动 ${(Number(stock.volatility || 0) * 100).toFixed(1)}%</span>
            </div>
            <button class="secondary mini-button" data-action="edit-stock" data-code="${escapeHtml(stock.code)}">编辑</button>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderStockFields(stock) {
    const industries = getIndustryOptions(stock.industry);
    return `
      <div class="field compact-field">
        <label>代码</label>
        <input name="code" value="${escapeHtml(stock.code || '')}" autocomplete="off" required>
      </div>
      <div class="field compact-field">
        <label>名称</label>
        <input name="name" value="${escapeHtml(stock.name || '')}" autocomplete="off" required>
      </div>
      <div class="field compact-field">
        <label>板块</label>
        <input name="sector" value="${escapeHtml(stock.sector || '其他')}" autocomplete="off" required>
      </div>
      <div class="field compact-field">
        <label>行业</label>
        <select name="industry" required>
          ${industries.map((industry) => `<option value="${escapeHtml(industry)}" ${industry === stock.industry ? 'selected' : ''}>${escapeHtml(industry)}</option>`).join('')}
        </select>
      </div>
      <div class="field compact-field">
        <label>初始价</label>
        <input name="initial_price" type="number" min="0.01" max="10000" step="0.01" value="${escapeHtml(stock.initial_price || 20)}" required>
      </div>
      <div class="field compact-field">
        <label>波动率</label>
        <input name="volatility" type="number" min="0.01" max="0.2" step="0.01" value="${escapeHtml(stock.volatility || 0.05)}" required>
      </div>
      <div class="field compact-field">
        <label>风险</label>
        <select name="risk_level">
          <option value="low" ${stock.risk_level === 'low' ? 'selected' : ''}>低风险</option>
          <option value="mid" ${stock.risk_level === 'mid' ? 'selected' : ''}>中风险</option>
          <option value="high" ${stock.risk_level === 'high' ? 'selected' : ''}>高风险</option>
        </select>
      </div>
    `;
  }

   function renderAdminAccount(account) {
    return `
      <div class="account-row">
        <div>
          <strong>${escapeHtml(account.nickname)}</strong>
          <div class="muted">${escapeHtml(account.username)} · ${account.is_admin ? '管理员' : account.activated ? '已激活' : '未激活'}${account.bankrupt ? ' · <span style="color:var(--danger);font-weight:600;">已破产</span>' : ''}${account.has_active_loan && !account.bankrupt ? ' · <span style="color:var(--accent);">有贷款</span>' : ''}</div>
        </div>
        <div class="admin-meta">
          <span>登录 ${dateText(account.last_login_at)}</span>
          <span>交易 ${dateText(account.last_trade_at)}</span>
          <span>${account.transaction_count || 0} 笔</span>
        </div>
        <div class="num">${money(account.total_asset || 0)}</div>
        <div class="account-actions">
          ${account.is_admin ? '' : `<button class="mini-danger" data-action="reset-player-password" data-username="${escapeHtml(account.username)}" data-nickname="${escapeHtml(account.nickname)}" ${state.loading ? 'disabled' : ''}>重置密码</button>`}
          ${account.is_admin ? '' : `<button class="mini-danger" data-action="reset-player" data-username="${escapeHtml(account.username)}" data-nickname="${escapeHtml(account.nickname)}" ${state.loading ? 'disabled' : ''} title="重置破产玩家：清贷款、清持仓、现金回 100 万，保留密码和激活状态">重置资产</button>`}
          ${account.is_admin ? '' : `<button class="mini-danger" data-action="delete-account" data-username="${escapeHtml(account.username)}" data-nickname="${escapeHtml(account.nickname)}" ${state.loading ? 'disabled' : ''}>删除账号</button>`}
        </div>
      </div>
    `;
  }

  function renderAdminTransactions(items) {
    if (!items.length) return '<div class="empty">暂无交易记录</div>';
    return items.map((tx) => {
      const stock = STOCKS.find((item) => item.code === tx.stock_code) || { name: tx.stock_code };
      return `
        <div class="flat-row">
          <div>
            <strong class="${tx.type === 'buy' ? 'up' : 'down'}">${tx.type === 'buy' ? '买入' : '卖出'}</strong>
            <span>${escapeHtml(tx.nickname)} · ${escapeHtml(stock.name)}</span>
            <div class="muted">第 ${tx.tick} 期 · ${tx.quantity} 股 @ ${price(tx.price)} · ${dateText(tx.created_at)}</div>
          </div>
          <div class="num">${money(tx.quantity * tx.price)}</div>
        </div>
      `;
    }).join('');
  }

  function renderStockSortBar() {
    return `
      <div class="stock-sortbar" role="group" aria-label="行情排序">
        ${sortButton('code', '代码')}
        <div></div>
        <div></div>
        ${sortButton('price', '市价')}
        ${sortButton('change', '涨跌幅')}
      </div>
    `;
  }

  function sortButton(key, label) {
    const active = state.sortKey === key;
    const arrow = active ? (state.sortDir === 'asc' ? '↑' : '↓') : '';
    return `<button class="sort-button ${key === 'code' ? '' : 'sort-numeric'} ${active ? 'active' : ''}" data-action="set-sort" data-sort-key="${key}"><span>${label}</span><span>${arrow}</span></button>`;
  }

  function renderStockRows() {
    const rows = getDisplayRows();
    if (!rows.length) return '<div class="empty">行情加载中</div>';
    return rows.map((row) => {
      const owned = getHolding(row.code);
      return `
      <div class="stock-row ${row.code === state.selectedCode ? 'active' : ''} ${owned ? 'owned' : ''}" tabindex="0" data-action="select-stock" data-code="${row.code}">
        <div>
          <div class="stock-name">
            <span>${escapeHtml(row.name)}</span>
          </div>
          <div class="stock-meta">${row.code} · ${escapeHtml(row.sector || '')} / ${escapeHtml(row.industry)}</div>
        </div>
        <div>${owned ? '<span class="holding-tag">持仓</span>' : ''}</div>
        <div><span class="tag tag-${row.risk_level}">${riskLabel(row.risk_level)}</span></div>
        <div class="num">${price(row.close)}</div>
        <div class="num ${trendClass(row.change_pct)}">${percent(row.change_pct)}</div>
      </div>
    `;
    }).join('');
  }

  function renderStockModal() {
    return `
      <div class="modal-layer" data-action="close-stock" role="dialog" aria-modal="true" aria-label="股票详情">
        <div class="stock-modal">
          ${renderDetail()}
        </div>
      </div>
    `;
  }

  function renderDetail() {
    const stock = getSelectedStock();
    if (!stock) return '<section class="panel panel-pad"><div class="empty">请选择股票</div></section>';
    const priceRow = getPrice(stock.code);
    const holding = getHolding(stock.code);
    const sellLots = holding ? Math.floor((holding.available_quantity || 0) / 100) : 0;
    const maxBuyLots = getMaxBuyLots(stock.code);

    return `
      <section class="panel-pad detail-panel">
        <div class="stock-detail-layout">
          <div class="detail-left-column">
            <section class="detail-info-column">
              <div class="panel-head">
                <div class="detail-title-block">
                  <h2 class="title">${escapeHtml(stock.name)}</h2>
                </div>
                <div class="detail-quote-inline">
                  <span class="detail-price ${trendClass(priceRow.change_pct)}">${price(priceRow.close)}</span>
                  <span class="detail-change ${trendClass(priceRow.change_pct)}">${percent(priceRow.change_pct)}</span>
                </div>
              </div>
              ${renderSparkline()}
              ${holding ? `
                <div class="holding-summary">
                  <span>持仓 ${holding.quantity || 0} 股</span>
                  <span>可卖 ${holding.available_quantity || 0} 股</span>
                  <span>成本 ${price(holding.avg_cost)}</span>
                </div>
              ` : ''}
            </section>
            <aside class="detail-news-column">
              <div class="detail-news-head">
                <h3 class="section-title">关联新闻</h3>
                <span class="status-pill">${(state.stock_news || []).length} 条</span>
              </div>
              <div class="detail-news-scroll">
                ${renderNews()}
              </div>
            </aside>
          </div>
          <section class="detail-trade-column">
            ${renderTradePanel(stock, maxBuyLots, sellLots)}
          </section>
        </div>
      </section>
    `;
  }

  function renderTradePanel(stock, maxBuyLots, sellLots) {
    const fixedLots = [10, 50, 100];
    const fixedAmounts = [100000, 200000, 300000];
    const tradeLockReason = getTradeLockReason('market');
    const locked = !!tradeLockReason;
    const buyFeedback = getTradeFeedback('stock', 'buy', { code: stock.code });
    const sellFeedback = getTradeFeedback('stock', 'sell', { code: stock.code });
    const buyReason = locked ? '' : getBuyDisabledReason(stock.code);
    const sellReason = locked ? '' : getSellDisabledReason(stock.code);
    const priceValue = Number(getPrice(stock.code).close || 0);
    const holding = getHolding(stock.code);
    const holdingQuantity = holding?.quantity || 0;
    const availableQuantity = holding?.available_quantity || 0;
    const holdingMarketValue = holdingQuantity * priceValue;
    const availableSellAmount = getMaxSellAmount(stock.code);
    return `
      <div class="trade-panel${locked ? ' trade-panel-locked' : ''}">
        ${locked ? `<div class="trade-closed">${escapeHtml(tradeLockReason)}</div>` : ''}
        <div class="trade-grid">
        <div>
          <h3 class="section-title">买入</h3>
          <div class="trade-context">
            <div class="trade-money-strip">
              <div>
                <span>账户余额</span>
                <strong>${money(state.user?.cash || 0)}</strong>
              </div>
              <div>
                <span>本股最多可买金额</span>
                <strong>${money(getMaxBuyAmount(stock.code))}</strong>
              </div>
            </div>
            <div class="trade-context-line"><strong>${escapeHtml(stock.name)}</strong> · 按当前价 ${price(priceValue)} / 股</div>
            <div class="trade-context-line">1 手 = 100 股 · 最多可买 ${maxBuyLots} 手 · 预计支出已含 0.1% 手续费</div>
            <div class="trade-context-line trade-quote-note">若跨整点切到新一期，系统会要求按最新价格重新确认。</div>
            <div class="trade-tip-slot${buyFeedback || buyReason ? ' has-tip' : ''}">${renderTradeFeedback(buyFeedback, buyReason)}</div>
          </div>
          <div class="quick-actions">
            ${fixedLots.map((lots) => tradeButton('buy', stock.code, lots, `买 ${lots} 手`, compactWanAmount(estimateBuyTotal(stock.code, lots)), locked || maxBuyLots < lots)).join('')}
          </div>
          <div class="quick-actions">
            ${fixedAmounts.map((amountValue) => {
              const lots = getBuyLotsByAmount(stock.code, amountValue);
              return amountButton('buy', stock.code, amountValue, `买 ${compactWanAmount(amountValue, { approximate: false })}`, `${lots} 手 · ${compactWanAmount(estimateBuyTotal(stock.code, lots))}`, locked || lots < 1);
            }).join('')}
          </div>
          <form class="trade-custom-form" data-form="trade-custom">
            <label for="customBuyLots">自定义买入手数</label>
            <input id="customBuyLots" name="lots" type="number" min="1" step="1" data-clamp="buy-lots" data-code="${stock.code}" placeholder="最多 ${maxBuyLots} 手">
            <button class="buy" type="submit" data-trade="buy" data-code="${stock.code}" ${state.loading || locked || maxBuyLots < 1 ? 'disabled' : ''}>买入</button>
          </form>
          <form class="trade-custom-form" data-form="trade-custom-amount">
            <label for="customBuyAmount">自定义买入金额</label>
            <input id="customBuyAmount" name="amount" type="number" min="1" step="0.01" data-clamp="buy-amount" data-code="${stock.code}" placeholder="最多 ${money(getMaxBuyAmount(stock.code))}">
            <button class="buy" type="submit" data-trade="buy" data-code="${stock.code}" ${state.loading || locked || maxBuyLots < 1 ? 'disabled' : ''}>买入</button>
          </form>
        </div>
        <div>
          <h3 class="section-title">卖出</h3>
          <div class="trade-context">
            <div class="trade-money-strip">
              <div>
                <span>当前持有市值</span>
                <strong>${money(holdingMarketValue)}</strong>
              </div>
              <div>
                <span>最多可卖到账</span>
                <strong>${money(availableSellAmount)}</strong>
              </div>
            </div>
            <div class="trade-context-line"><strong>${escapeHtml(stock.name)}</strong> · 按当前价 ${price(priceValue)} / 股</div>
            <div class="trade-context-line">持仓 ${holdingQuantity} 股 · 可卖 ${availableQuantity} 股 · 预计到账已扣除 0.1% 手续费</div>
            <div class="trade-context-line trade-quote-note">若跨整点切到新一期，系统会要求按最新价格重新确认。</div>
            <div class="trade-tip-slot${sellFeedback || sellReason ? ' has-tip' : ''}">${renderTradeFeedback(sellFeedback, sellReason)}</div>
          </div>
          <div class="quick-actions">
            ${fixedLots.map((lots) => tradeButton('sell', stock.code, lots, `卖 ${lots} 手`, compactWanAmount(estimateSellNet(stock.code, lots)), locked || sellLots < lots)).join('')}
          </div>
          <div class="quick-actions">
            ${fixedAmounts.map((amountValue) => {
              const lots = getSellLotsByAmount(stock.code, amountValue);
              return amountButton('sell', stock.code, amountValue, `卖 ${compactWanAmount(amountValue, { approximate: false })}`, `${lots} 手 · ${compactWanAmount(estimateSellNet(stock.code, lots))}`, locked || lots < 1);
            }).join('')}
          </div>
          <form class="trade-custom-form" data-form="trade-custom">
            <label for="customSellLots">自定义卖出手数</label>
            <input id="customSellLots" name="lots" type="number" min="1" step="1" data-clamp="sell-lots" data-code="${stock.code}" placeholder="最多 ${sellLots} 手">
            <button class="sell" type="submit" data-trade="sell" data-code="${stock.code}" ${state.loading || locked || sellLots < 1 ? 'disabled' : ''}>卖出</button>
          </form>
          <form class="trade-custom-form" data-form="trade-custom-amount">
            <label for="customSellAmount">自定义卖出金额</label>
            <input id="customSellAmount" name="amount" type="number" min="1" step="0.01" data-clamp="sell-amount" data-code="${stock.code}" placeholder="最多 ${money(getMaxSellAmount(stock.code))}">
            <button class="sell" type="submit" data-trade="sell" data-code="${stock.code}" ${state.loading || locked || sellLots < 1 ? 'disabled' : ''}>卖出</button>
          </form>
        </div>
        </div>
      </div>
    `;
  }

  function tradeButton(type, code, lots, label, estimate, disabled) {
    return `
      <button class="${type === 'buy' ? 'buy' : 'sell'} action-button" data-action="trade" data-trade="${type}" data-code="${code}" data-lots="${lots}" ${state.loading || disabled ? 'disabled' : ''}>
        <span class="action-main">${escapeHtml(label)}</span>
        <span class="action-sub">${escapeHtml(estimate)}</span>
      </button>
    `;
  }

  function amountButton(type, code, amountValue, label, estimate, disabled) {
    return `
      <button class="${type === 'buy' ? 'buy' : 'sell'} action-button" data-action="trade-amount" data-trade="${type}" data-code="${code}" data-amount="${amountValue}" ${state.loading || disabled ? 'disabled' : ''}>
        <span class="action-main">${escapeHtml(label)}</span>
        <span class="action-sub">${escapeHtml(estimate)}</span>
      </button>
    `;
  }

  function renderSparkline() {
    if (!state.history || state.history.length < 2) {
      return '<div class="sparkline empty">至少需要 2 期价格数据</div>';
    }
    var stockWindow = state.history.slice(-CHART_HISTORY_WINDOW);
    var windowMinTick = stockWindow.length ? stockWindow[0].tick : 0;
    var trades = (state.transactions || []).filter(function(tx) {
      return tx.stock_code === state.selectedCode && tx.tick >= windowMinTick;
    });
    return renderLineChart(stockWindow, '价格走势线图', 'detail-price-chart', trades);
  }

  function niceTicks(min, max, maxTicks) {
    var range = max - min || 1;
    var roughStep = range / maxTicks;
    var magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
    var normalized = roughStep / magnitude;
    var step;
    if (normalized <= 1.5) step = 1 * magnitude;
    else if (normalized <= 3) step = 2 * magnitude;
    else if (normalized <= 7) step = 5 * magnitude;
    else step = 10 * magnitude;
    var first = Math.floor(min / step) * step;
    var ticks = [];
    for (var v = first; v <= max + step * 0.01; v += step) {
      if (v >= min - step * 0.01) ticks.push(v);
    }
    if (ticks.length < 2) ticks = [min, max];
    return ticks;
  }

  function formatAxisPrice(val) {
    if (val >= 1000000) return (val / 1000000).toFixed(1) + 'M';
    if (val >= 10000) return (val / 10000).toFixed(1) + '万';
    if (val >= 100) return val.toFixed(0);
    if (val >= 0.01) return val.toFixed(2);
    return val.toFixed(4);
  }

  window.showCrosshair = function(chartId, event) {
    var rect = event.target;
    var svg = rect.closest('svg');
    if (!svg) return;
    var container = svg.parentElement;
    if (!container) return;
    var svgRect = svg.getBoundingClientRect();
    var containerRect = container.getBoundingClientRect();
    var pt = svg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    var ctm = svg.getScreenCTM();
    var svgP = ctm ? pt.matrixTransform(ctm.inverse()) : pt;
    var svgX = svgP.x;
    var pts;
    try { pts = JSON.parse(rect.getAttribute('data-points')); } catch(e) { return; }
    var best = pts[0];
    var minD = Math.abs(best.x - svgX);
    for (var i = 1; i < pts.length; i++) {
      var d = Math.abs(pts[i].x - svgX);
      if (d < minD) { minD = d; best = pts[i]; }
    }
    var cross = document.getElementById(chartId + '_cr');
    var dot = document.getElementById(chartId + '_dt');
    var tip = document.getElementById(chartId + '_tip');
    if (cross) { cross.setAttribute('x1', best.x); cross.setAttribute('x2', best.x); cross.style.display = ''; }
    if (dot) { dot.setAttribute('cx', best.x); dot.setAttribute('cy', best.y); dot.style.display = ''; }
    if (tip) {
      var tradeLabel = '';
      var tradesMap;
      try {
        tradesMap = JSON.parse(rect.getAttribute('data-trades') || '{}');
      } catch(e) { tradesMap = {}; }
      var status = tradesMap[String(best.tick)];
      var labelMap;
      try {
        labelMap = JSON.parse(rect.getAttribute('data-trade-labels') || '{}');
      } catch(e) { labelMap = {}; }
      if (status) tradeLabel = ' · ' + (labelMap[status] || status);
      tip.innerHTML = '第 ' + best.tick + ' 期 · ' + best.close.toFixed(2) + tradeLabel;
      tip.style.display = 'block';
      var tipW = tip.offsetWidth || 100;
      var tipPt = svg.createSVGPoint();
      tipPt.x = best.x;
      tipPt.y = best.y;
      var tipScreen = ctm ? tipPt.matrixTransform(ctm) : tipPt;
      var tipX = tipScreen.x - containerRect.left;
      tip.style.left = Math.max(0, Math.min(containerRect.width - tipW, tipX - tipW / 2)) + 'px';
      tip.style.top = '0px';
    }
  }

  window.hideCrosshair = function(chartId) {
    var cross = document.getElementById(chartId + '_cr');
    var dot = document.getElementById(chartId + '_dt');
    var tip = document.getElementById(chartId + '_tip');
    if (cross) cross.style.display = 'none';
    if (dot) dot.style.display = 'none';
    if (tip) tip.style.display = 'none';
  }

  function renderLineChart(pointsSource, label, extraClass = '', trades = [], tradeLabelMap = null) {
    if (!tradeLabelMap) tradeLabelMap = { buy: '买入', sell: '卖出', both: '买入+卖出' };
    if (!pointsSource || pointsSource.length < 2) {
      const emptyClassName = ['sparkline', 'empty', extraClass].filter(Boolean).join(' ');
      return '<div class="' + emptyClassName + '">' + escapeHtml(label) + '暂无足够数据</div>';
    }

    // Fixed viewBox; the SVG scales uniformly (preserveAspectRatio defaults to
    // "meet"), so the line stroke and axis text never get squashed or stretched.
    // The home 大盘 chart sits in a wide, short card slot, so it gets a wide
    // aspect ratio that fills that slot at ~1.3x instead of ballooning; the
    // detail popup keeps its taller, near-square frame.
    var isMarket = String(extraClass || '').includes('market-chart');
    var width = isMarket ? 540 : 420;
    var height = isMarket ? 170 : 188;
    var topPad = 16;
    var rightPad = 16;
    var bottomPad = 24;
    var leftPad = 60;
    var plotW = width - leftPad - rightPad;
    var plotH = height - topPad - bottomPad;
    var plotTop = topPad;
    var plotBottom = topPad + plotH;

    var closes = pointsSource.map(function(item) { return item.close; });
    var min = Math.min.apply(null, closes);
    var max = Math.max.apply(null, closes);
    // Breathing room so the curve never kisses the top/bottom edges.
    var pad = (max - min) * 0.14 || (max || 1) * 0.02;
    var lo = min - pad;
    var hi = max + pad;
    var span = hi - lo || 1;

    var dataPoints = pointsSource.map(function(item, index) {
      var x = leftPad + (index / (pointsSource.length - 1)) * plotW;
      var y = plotBottom - ((item.close - lo) / span) * plotH;
      return { x: x, y: y, tick: item.tick, close: item.close };
    });

    var tradeMap = {};
    trades.forEach(function(tx) {
      var key = String(tx.tick);
      if (!tradeMap[key]) tradeMap[key] = tx.type;
      else if (tradeMap[key] !== tx.type) tradeMap[key] = 'both';
    });
    var colorUp = '#c8372d', colorDown = '#178245', colorBoth = '#e67e22';
    var tradeDotsHtml = '';
    dataPoints.forEach(function(dp) {
      var status = tradeMap[String(dp.tick)];
      if (!status) return;
      var c = (status === 'buy' || (status && status.startsWith('buy_'))) ? colorUp :
              (status === 'sell' || (status && status.startsWith('sell_'))) ? colorDown : colorBoth;
      tradeDotsHtml += '<circle cx="' + dp.x.toFixed(1) + '" cy="' + dp.y.toFixed(1) +
        '" r="4.5" fill="' + c + '" stroke="#fff" stroke-width="1.5" ' +
        'class="trade-dot" pointer-events="none" data-status="' + status + '"></circle>';
    });
    var tradesJson = JSON.stringify(tradeMap).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    var labelsJson = JSON.stringify(tradeLabelMap).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    var pointsStr = dataPoints.map(function(p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ');
    var areaPath = 'M' + dataPoints[0].x.toFixed(1) + ',' + plotBottom +
      ' L' + dataPoints.map(function(p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' L') +
      ' L' + dataPoints[dataPoints.length - 1].x.toFixed(1) + ',' + plotBottom + ' Z';
    var lastPoint = dataPoints[dataPoints.length - 1];
    var color = (typeof getComputedStyle === 'function'
      ? getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()
      : '') || '#114084';
    var chartId = 'ch_' + Math.random().toString(36).slice(2, 7);

    var yTicks = niceTicks(min, max, 4);
    var yAxisHtml = yTicks.map(function(val) {
      var y = plotBottom - ((val - lo) / span) * plotH;
      if (y < plotTop - 0.5 || y > plotBottom + 0.5) return '';
      return '<line x1="' + leftPad + '" y1="' + y.toFixed(1) + '" x2="' + (leftPad + plotW) + '" y2="' + y.toFixed(1) + '" stroke="#eef1f5"/>' +
        '<text x="' + (leftPad - 8) + '" y="' + y.toFixed(1) + '" text-anchor="end" dominant-baseline="middle" class="chart-axis-label">' + formatAxisPrice(val) + '</text>';
    }).join('');

    var n = dataPoints.length;
    var xStep = n > 12 ? Math.ceil((n - 1) / 5) : 1;
    var xAxisHtml = dataPoints.filter(function(p, i) { return i % xStep === 0 || i === n - 1; }).map(function(p) {
      return '<text x="' + p.x.toFixed(1) + '" y="' + (height - 7) + '" text-anchor="middle" class="chart-axis-label">' + p.tick + '</text>';
    }).join('');

    var ptsJson = JSON.stringify(dataPoints.map(function(p) {
      return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, tick: p.tick, close: p.close };
    }));

    var className = ['chart-container', extraClass].filter(Boolean).join(' ');
    return '<div class="' + className + '">' +
      '<div class="chart-tooltip" id="' + chartId + '_tip"></div>' +
      '<svg class="sparkline" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + escapeHtml(label) + '">' +
        '<defs><linearGradient id="' + chartId + '_fill" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0" stop-color="' + color + '" stop-opacity="0.20"></stop>' +
          '<stop offset="1" stop-color="' + color + '" stop-opacity="0"></stop>' +
        '</linearGradient></defs>' +
        yAxisHtml +
        '<path d="' + areaPath + '" fill="url(#' + chartId + '_fill)" stroke="none"></path>' +
        '<line x1="' + leftPad + '" y1="' + plotBottom + '" x2="' + (leftPad + plotW) + '" y2="' + plotBottom + '" stroke="#dfe4ea"></line>' +
        '<polyline points="' + pointsStr + '" fill="none" stroke="' + color + '" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round"></polyline>' +
        '<circle cx="' + lastPoint.x.toFixed(1) + '" cy="' + lastPoint.y.toFixed(1) + '" r="3.4" fill="' + color + '" stroke="#fff" stroke-width="1.5"></circle>' +
        xAxisHtml +
        '<line id="' + chartId + '_cr" x1="0" y1="' + plotTop + '" x2="0" y2="' + plotBottom + '" stroke="#9aa3ad" stroke-width="1" stroke-dasharray="4,3" style="display:none"></line>' +
        '<circle id="' + chartId + '_dt" cx="0" cy="0" r="4.5" fill="' + color + '" stroke="#fff" stroke-width="1.5" style="display:none"></circle>' +
        '<rect x="' + leftPad + '" y="' + plotTop + '" width="' + plotW + '" height="' + plotH + '" fill="transparent" stroke="none" pointer-events="all" style="cursor:crosshair"' +
        " data-points='" + ptsJson + "'" +
        " data-trades='" + tradesJson + "'" +
        " data-trade-labels='" + labelsJson + "'" +
        ' onmousemove="showCrosshair(\'' + chartId + '\',event)"' +
        ' onmouseleave="hideCrosshair(\'' + chartId + '\')"' +
        '></rect>' +
        tradeDotsHtml +
      '</svg>' +
    '</div>';
  }

  function renderNews() {
    const items = sortNewsByPriority(state.stock_news);
    if (!items.length) return '<div class="empty">暂无关联新闻</div>';
    return `
      <div class="news-list">
        ${items.map((item) => `
          <div class="news-item ${newsCardClass(item)}">
            <div class="muted">第 ${item.created_tick || '--'} 期 · ${sourceLabel(item.source_type)}${item.is_rumor ? ' · 辟谣' : ''}</div>
            <div class="news-title">${escapeHtml(item.title || '未命名新闻')}</div>
            <div class="news-summary">${escapeHtml(summary(item.content || ''))}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderGlobalNews() {
    if (!state.news.length) return '';
    return `
      <section class="panel panel-pad" style="margin-top:18px;">
        <h2 class="section-title">本期新闻</h2>
        ${renderGlobalNewsList(state.news)}
      </section>
    `;
  }

  function renderGlobalNewsList(items, indexMap) {
    const orderedItems = sortNewsByPriority(items);
    const map = indexMap || {};
    return `
      <div class="news-list">
        ${orderedItems.map((item, idx) => `
          <div class="news-item ${newsCardClass(item)}" id="news-${item.id}" data-news-id="${item.id}">
            <div class="news-head-row">
              <span class="news-number">#${map[item.id] || (idx + 1)}</span>
              <span class="muted">${sourceLabel(item.source_type)}${item.is_rumor ? ' · 辟谣' : ''}${item.expert_name ? ' · ' + escapeHtml(item.expert_name) : ''}</span>
            </div>
            <div class="news-title">${escapeHtml(item.title || '未命名新闻')}</div>
            <div class="news-summary">${escapeHtml(summary(item.content || ''))}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  function buildNewsIndexMap(ordered) {
    const map = {};
    (ordered || []).forEach((item, idx) => { map[item.id] = idx + 1; });
    return map;
  }

  function renderKolColumn(comments, indexMap) {
    if (!comments || !comments.length) {
      return '<div class="kol-empty">本期暂无自媒体解读</div>';
    }
    const map = indexMap || {};
    return `
      <div class="kol-head">
        <span class="kol-head-title">自媒体</span>
        <span class="status-pill">${comments.length} 条</span>
      </div>
      <div class="kol-scroll">
        ${comments.map(c => renderKolCard(c, map)).join('')}
      </div>
    `;
  }

  function getKolAvatar(kolName, tier) {
    var femaleNames = ['追风的人', '吃瓜群众', '静待花开', '山那边的风', '简单生活'];
    if (femaleNames.includes(kolName)) return 'avatars/female.png';
    if (tier === 'pro') return 'avatars/pro-male.png';
    if (tier === 'semi') return 'avatars/semi-male.png';
    return 'avatars/grass-male.png';
  }

  function renderKolCard(comment, indexMap) {
    const badgeHtml = comment.tier === 'pro'
      ? '<span class="kol-badge kol-badge-pro">' + escapeHtml('执业分析师') + '</span>'
      : comment.tier === 'semi'
        ? '<span class="kol-badge kol-badge-semi">' + escapeHtml('财经领域创作者') + '</span>'
        : '';

    const avatarSrc = getKolAvatar(comment.kol_name, comment.tier);

    let content = escapeHtml(comment.content || '');
    if (comment.comment_type === 'review' && comment.target_news_id !== undefined) {
      const newsNum = indexMap[comment.target_news_id];
      if (newsNum) {
        content = content.replace(/\{N\}/g, String(newsNum));
      } else {
        content = content.replace(/\{N\}/g, '?');
      }
      content = content.replace(
        /#新闻(\d+)/g,
        '<a class="kol-tag" data-news-id="' + comment.target_news_id + '" onclick="window.scrollToNews(' + comment.target_news_id + ')">#新闻$1</a>'
      );
    }

    return `
      <div class="kol-card">
        <div class="kol-card-header">
          <img class="kol-avatar" src="${avatarSrc}" alt="" width="20" height="20">
          <span class="kol-name"><strong>${escapeHtml(comment.kol_name)}</strong></span>
          ${badgeHtml}
        </div>
        <div class="kol-content">${content}</div>
      </div>
    `;
  }

  window.scrollToNews = function(newsId) {
    const el = document.getElementById('news-' + newsId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('news-flash');
      setTimeout(() => el.classList.remove('news-flash'), 1500);
    }
  };

  function renderPortfolio(withMargin = true) {
    if (!state.user) return '';
    const holdingValue = getHoldingValue();
    const fundValue = Number(state.user.fund_value || 0);
    const futuresValue = Number(state.user.futures_value || 0);
    const grossTotal = (state.user.cash || 0) + holdingValue + fundValue + futuresValue;
    const loanLiability = Number(state.user.loan_liability || state.activeLoan?.principal || 0);
    const netTotal = Number(state.user.net_total_asset ?? (grossTotal - loanLiability));

    // Build tier-2 sub-cards for each asset class
    const stockHoldings = buildStockHoldings();
    const fundHoldings = buildFundHoldings();
    const futuresHoldings = buildFuturesHoldings();

    const holdingCards = [
      stockHoldings,
      fundHoldings,
      futuresHoldings
    ].filter(Boolean).join('');

    return `
      <section class="panel panel-pad" style="${withMargin ? 'margin-top:18px;' : ''}">
        <div class="panel-head">
          <div>
            <h1 class="title">我的账户</h1>
            <div class="muted">${escapeHtml(state.user.nickname || '玩家')} · 第 ${state.currentTick} 期</div>
          </div>
        </div>
        <div class="asset-strip">
          <div class="asset-cell">
            <div class="asset-label">可用资金</div>
            <div class="asset-value">${money(state.user.cash || 0)}</div>
          </div>
          <div class="asset-cell">
            <div class="asset-label">持仓市值</div>
            <div class="asset-value">${money(holdingValue)}</div>
          </div>
          <div class="asset-cell">
            <div class="asset-label">基金市值</div>
            <div class="asset-value">${money(fundValue)}</div>
          </div>
          <div class="asset-cell">
            <div class="asset-label">期货市值</div>
            <div class="asset-value">${money(futuresValue)}</div>
          </div>
          <div class="asset-cell">
            <div class="asset-label">净资产</div>
            <div class="asset-value">${money(netTotal)}</div>
          </div>
        </div>
        ${renderLoanReminders()}
        ${renderSportsAccountCard()}
        ${state.isBankrupt ? '<div class="notice" style="background:#fef3f2;border-left:4px solid var(--danger);padding:12px;border-radius:8px;margin:12px 0;font-weight:600;">已破产 — 无法交易，请联系管理员重置</div>' : ''}
        ${holdingCards || '<div class="empty" style="margin-top:18px;">暂无持仓</div>'}
        ${renderTransactionAccordion()}
      </section>
    `;
  }

  function renderSportsAccountCard() {
    const account = state.sportsAccount;
    if (!account) return '';
    return `
      <div class="holding-subcard" style="border:1px solid var(--line);border-radius:8px;overflow:hidden;margin-top:14px;">
        <div class="holding-subcard-head" style="background:var(--surface-2);padding:10px 14px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--line);">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#0f766e;flex-shrink:0;"></span>
          <strong style="font-size:15px;">赛事竞猜</strong>
          <span class="muted">待开奖 ${money(account.pending_stake || 0)} · 本赛季盈亏 ${money(account.season_pnl || 0)}</span>
          <button class="secondary mini-button" data-action="set-view" data-view="sports" style="margin-left:auto;">查看赛事</button>
        </div>
        <div class="holding-subcard-body" style="padding:12px 16px;">${renderSportsBets((account.recent_bets || []).slice(0, 8), true)}</div>
      </div>
    `;
  }

  function buildStockHoldings() {
    if (!state.holdings.length) return '';
    const items = state.holdings.map((holding) => {
      const stock = STOCKS.find((item) => item.code === holding.stock_code) || { name: holding.stock_code };
      const current = getPrice(holding.stock_code).close;
      const value = current * holding.quantity;
      const cost = holding.avg_cost * holding.quantity;
      const pl = value - cost;
      return { ...holding, name: stock.name, code: holding.stock_code, price: current, value, pl };
    }).sort((a, b) => b.value - a.value);

    return renderHoldingSubCard('股票', '#3b5bdb', items.map((item) => `
      <div class="flat-row">
        <div>
          <strong>${escapeHtml(item.name)}</strong> <span style="margin-left:6px;font-size:0.92em;font-weight:600;color:#5f6b7a;">${money(item.value)}</span>
          <div class="muted">${item.code} · ${item.quantity} 股 · 可卖 ${item.available_quantity || 0} 股</div>
        </div>
        <div class="num ${trendClass(item.pl)}">${money(item.pl)}</div>
      </div>
    `).join(''));
  }

  function buildFundHoldings() {
    const items = (state.fundsStatus || []).filter((fh) => Number(fh.shares || 0) > 0);
    if (!items.length) return '';
    const sorted = items.map((fh) => ({
      ...fh,
      value: Number(fh.value || 0),
      pl: Number(fh.profit || 0)
    })).sort((a, b) => b.value - a.value);

    return renderHoldingSubCard('基金', '#f59e0b', sorted.map((item) => `
      <div class="flat-row">
        <div>
          <strong>${escapeHtml(item.fund_name || item.fund_code)}</strong> <span style="margin-left:6px;font-size:0.92em;font-weight:600;color:#5f6b7a;">${money(item.value)}</span>
          <div class="muted">${item.fund_code} · ${Number(item.shares).toFixed(2)} 份 · 净值 ${Number(item.nav || 0).toFixed(4)}</div>
        </div>
        <div class="num ${trendClass(item.pl)}">${money(item.pl)}</div>
      </div>
    `).join(''));
  }

  function buildFuturesHoldings() {
    const items = state.futuresStatus && state.futuresStatus.positions ? state.futuresStatus.positions : [];
    if (!items.length) return '';
    const sorted = items.map((pos) => ({
      ...pos,
      value: Number(pos.margin || 0) + Number(pos.unrealizedPnl || 0),
      pl: Number(pos.unrealizedPnl || 0)
    })).sort((a, b) => b.value - a.value);

    return renderHoldingSubCard('期货', '#a21caf', sorted.map((item) => {
      const sideLabel = item.side === 'long' ? '多' : '空';
      return `
        <div class="flat-row">
          <div>
            <strong>${escapeHtml(item.name || item.code)}</strong> <span style="margin-left:6px;font-size:0.92em;font-weight:600;color:#5f6b7a;">${money(item.value)}</span>
            <div class="muted">${item.code} · ${sideLabel} · ${item.contracts || 0} 张 · ${item.leverage || 0}x</div>
          </div>
          <div class="num ${trendClass(item.pl)}">${money(item.pl)}</div>
        </div>
      `;
    }).join(''));
  }

  function renderHoldingSubCard(title, accentColor, bodyHtml) {
    return `
      <div class="holding-subcard" style="border:1px solid var(--line);border-radius:8px;overflow:hidden;margin-top:14px;">
        <div class="holding-subcard-head" style="background:var(--surface-2);padding:10px 14px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--line);">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${accentColor};flex-shrink:0;"></span>
          <strong style="font-size:15px;">${title}</strong>
        </div>
        <div class="holding-subcard-body" style="padding:12px 16px;">${bodyHtml}</div>
      </div>
    `;
  }

  function renderTransactionAccordion() {
    const allTrades = collectAllTransactions();
    if (!allTrades.length) return '<div class="empty" style="margin-top:18px;">暂无交易记录</div>';

    const expanded = !!state.transactionsExpanded;
    return `
      <section class="admin-accordion ${expanded ? 'is-open' : ''}" style="margin-top:14px;">
        <button
          class="admin-accordion-toggle"
          type="button"
          data-action="toggle-transactions"
          aria-expanded="${expanded ? 'true' : 'false'}"
        >
          <span class="admin-accordion-title">最近交易</span>
          <span class="admin-accordion-summary">共 ${allTrades.length} 笔</span>
          <span class="admin-accordion-state">${expanded ? '收起' : '展开'}</span>
        </button>
        ${expanded ? `<div class="admin-accordion-body">${allTrades.slice(0, 15).map(renderTradeRow).join('')}</div>` : ''}
      </section>
    `;
  }

  function collectAllTransactions() {
    const trades = [];

    // Stock transactions
    (state.transactions || []).forEach((tx) => {
      const stock = STOCKS.find((s) => s.code === tx.stock_code) || { name: tx.stock_code };
      trades.push({
        tick: tx.tick,
        type: tx.type === 'buy' ? '买入' : '卖出',
        className: tx.type === 'buy' ? 'up' : 'down',
        label: escapeHtml(stock.name),
        detail: `${tx.stock_code} · ${tx.quantity} 股 @ ${price(tx.price)}`,
        amount: tx.quantity * tx.price
      });
    });

    // Fund transactions
    (state.fundHistory || []).forEach((tx) => {
      const fundName = tx.fund_name || tx.fund_code || '';
      trades.push({
        tick: tx.tick,
        type: tx.type === 'buy' ? '申购' : (tx.type === 'forced_liquidation' ? '强平' : '赎回'),
        className: tx.type === 'buy' ? 'up' : (tx.type === 'forced_liquidation' ? 'down' : 'down'),
        label: escapeHtml(fundName),
        detail: `${tx.fund_code || ''} · ${Number(tx.amount || 0).toFixed(2)}`,
        amount: Number(tx.amount || 0)
      });
    });

    // Futures transactions
    (state.futuresHistory || []).filter(tx => tx.type !== 'financing').forEach((tx) => {
      const name = tx.name || tx.code || '';
      const typeLabel = tx.type === 'open' ? '开仓' : tx.type === 'close' ? '平仓' : tx.type === 'liquidation' ? '强平' : tx.type === 'deficit_recovery' ? '穿仓追偿' : tx.type;
      const className = tx.type === 'open' ? 'up' : 'down';
      trades.push({
        tick: tx.tick,
        type: typeLabel,
        className: className,
        label: escapeHtml(name),
        detail: `${tx.code || ''} · ${tx.side === 'long' ? '多' : '空'} · ${tx.contracts || 0} 张${tx.leverage ? ' · ' + tx.leverage + 'x' : ''}`,
        amount: Math.abs(Number(tx.pnl || 0) - Number(tx.fee || 0))
      });
    });

    // Sort by tick descending
    trades.sort((a, b) => b.tick - a.tick);
    return trades;
  }

  function renderTradeRow(trade) {
    return `
      <div class="flat-row">
        <div>
          <strong class="${trade.className}">${trade.type}</strong>
          <span>${trade.label}</span>
          <div class="muted">第 ${trade.tick} 期 · ${trade.detail}</div>
        </div>
        <div class="num">${money(trade.amount)}</div>
      </div>
    `;
  }

  var holdingTooltipData = {};

  function formatHoldingValue(value) {
    var v = Number(value || 0);
    if (v >= 1000) return (v / 10000).toFixed(1) + '万';
    return v.toFixed(1);
  }

  function showHoldingTooltip(evt, tid) {
    var data = holdingTooltipData[tid];
    if (!data) return;
    var tooltip = document.getElementById('holding-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.id = 'holding-tooltip';
      tooltip.className = 'holding-tooltip';
      document.body.appendChild(tooltip);
    }

    var rows = [];
    var items = data.items || [];
    if (!items || !items.length) {
      rows.push('<div class="holding-tooltip-row" style="background:transparent"><span class="holding-tooltip-name">' + escapeHtml(data.label) + '</span><span class="holding-tooltip-pct">' + money(data.value) + '</span></div>');
    } else {
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var changePct = Number(item.change_pct || 0);
        // 与显示精度(.toFixed(1))对齐：< 0.0005 的值 *100 后 < 0.05，舍入显示为 0.0%
        if (Math.abs(changePct) < 0.0005) { changePct = 0; }
        var sign = changePct > 0 ? '+' : '';
        var pctStr = sign + (changePct * 100).toFixed(1) + '%';
        var bgClass = changePct > 0 ? 'tooltip-row-up' : changePct < 0 ? 'tooltip-row-down' : 'tooltip-row-flat';
        var name = escapeHtml(item.stock_name || item.fund_name || item.name || '');
        var valStr = formatHoldingValue(item.value);
        var line = name + ' &middot; ' + valStr;
        if (data.isFutures && item.side) {
          var sideLabel = item.side === 'long' ? '多' : '空';
          line = name + ' &middot; ' + sideLabel + ' &middot; ' + valStr;
        }
        rows.push('<div class="holding-tooltip-row ' + bgClass + '"><span class="holding-tooltip-name">' + line + '</span><span class="holding-tooltip-pct">' + pctStr + '</span></div>');
      }
    }

    tooltip.innerHTML = '<div class="holding-tooltip-title">' + escapeHtml(data.label) + '</div>' + rows.join('');
    tooltip.style.display = 'block';

    var rect = evt.currentTarget.getBoundingClientRect();
    var tipW = tooltip.offsetWidth;
    var tipH = tooltip.offsetHeight;
    var left = Math.max(8, Math.min(rect.left, window.innerWidth - tipW - 8));
    var top = rect.bottom + 6;
    if (top + tipH > window.innerHeight - 8) {
      top = rect.top - tipH - 6; // 下方空间不足（如最底部玩家）→ 翻到色条上方
    }
    if (top < 8) top = 8;
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  }

  function hideHoldingTooltip() {
    var tooltip = document.getElementById('holding-tooltip');
    if (tooltip) tooltip.style.display = 'none';
  }

  window.showHoldingTooltip = showHoldingTooltip;
  window.hideHoldingTooltip = hideHoldingTooltip;

  function renderHoldingsView() {
    var data = state.allHoldings;
    if (!data) {
      return '<section class="panel panel-pad"><div class="empty">暂无持仓数据</div></section>';
    }
    var activeCount = data.length;
    return `
      <section class="panel panel-pad">
        <div class="panel-head">
          <div>
            <h1 class="title">持仓一览</h1>
            <div class="muted">第 ${state.currentTick} 期 · ${activeCount} 位玩家</div>
          </div>
          <span class="status-pill">按净资产排序</span>
        </div>
        <div class="holdings-grid">
          ${data.map(function (user) { return renderHoldingCard(user); }).join('')}
        </div>
      </section>
    `;
  }

  function renderHoldingCard(user) {
    var stockItems = user.holdings || [];
    var fundItems = user.fund_holdings || [];
    var futuresItems = user.futures_holdings || [];
    var stockTotal = stockItems.reduce(function(s, h) { return s + (h.value || 0); }, 0);
    var fundTotal = fundItems.reduce(function(s, h) { return s + (h.value || 0); }, 0);
    var futuresTotal = futuresItems.reduce(function(s, h) { return s + (h.value || 0); }, 0);
    var investedTotal = stockTotal + fundTotal + futuresTotal || 1;

    var segments = [];
    function pushSegment(label, value, color, items, isFutures) {
      if (value <= 0) return;
      var pct = investedTotal > 0 ? (value / investedTotal * 100) : 0;
      if (pct < 3) return;
      var tid = 'ht-' + Math.random().toString(36).slice(2, 8);
      holdingTooltipData[tid] = { label: label, value: value, items: items, isFutures: isFutures };
      segments.push({ pct: pct, color: color, tid: tid });
    }
    pushSegment('股票', stockTotal, '#3b5bdb', stockItems, false);
    pushSegment('基金', fundTotal, '#f59e0b', fundItems, false);
    pushSegment('期货', futuresTotal, '#a21caf', futuresItems, true);

    var barHtml;
    if (segments.length) {
      var totalPct = segments.reduce(function(s, seg) { return s + seg.pct; }, 0);
      barHtml = segments.map(function(seg) {
        var flexVal = totalPct > 0 ? (seg.pct / totalPct * 100).toFixed(2) : 0;
        return '<div class="holding-bar-segment" style="flex:' + flexVal + ' 0 0%;background:' + seg.color + ';" onmouseenter="showHoldingTooltip(event,\'' + seg.tid + '\')" onmouseleave="hideHoldingTooltip()"></div>';
      }).join('');
    } else {
      barHtml = '<div class="holding-bar-empty">暂无持仓</div>';
    }

    return `
      <div class="holding-card">
        <div class="holding-card-head">
          <strong>${escapeHtml(user.nickname)}</strong>
          <div class="holding-card-asset">${money(user.total_asset)}</div>
        </div>
        <div class="holding-bar-wrapper">
          <div class="holding-bar">${barHtml}</div>
        </div>
      </div>
    `;
  }

  function getDisplayRows() {
    const priceMap = {};
    state.prices.forEach((item) => { priceMap[item.stock_code] = item; });
    return STOCKS.map((stock) => {
      const row = priceMap[stock.code] || {};
      return {
        ...stock,
        close: row.close || stock.initial_price,
        change_pct: row.change_pct || 0
      };
    }).sort((a, b) => {
      let result = 0;
      if (state.sortKey === 'price') result = Number(a.close || 0) - Number(b.close || 0);
      else if (state.sortKey === 'change') result = Number(a.change_pct || 0) - Number(b.change_pct || 0);
      else result = String(a.code).localeCompare(String(b.code));
      return state.sortDir === 'asc' ? result : -result;
    });
  }

  function getSelectedStock() {
    return STOCKS.find((stock) => stock.code === state.selectedCode) || STOCKS[0] || null;
  }

  function getPrice(code) {
    return state.prices.find((item) => item.stock_code === code) || {
      stock_code: code,
      close: (STOCKS.find((stock) => stock.code === code) || {}).initial_price || 0,
      change_pct: 0
    };
  }

  function getHolding(code) {
    return state.holdings.find((item) => item.stock_code === code) || null;
  }

  function getHoldingValue() {
    return state.holdings.reduce((sum, holding) => {
      return sum + holding.quantity * getPrice(holding.stock_code).close;
    }, 0);
  }

  function getMaxBuyLots(code) {
    const stock = STOCKS.find((item) => item.code === code);
    const priceRow = getPrice(code);
    const priceValue = Number(priceRow.close || stock?.initial_price || 0);
    if (!priceValue) return 0;
    const isLimitUp = priceRow.change_pct >= 0.1;
    const feeRate = 0.001;
    const lotSize = 100;
    const cashLots = Math.floor((state.user.cash || 0) / (priceValue * lotSize * (1 + feeRate)));
    const normalMax = cashLots;
    if (isLimitUp) {
      return normalMax >= 1 ? Math.max(1, Math.floor(normalMax * 0.5)) : 0;
    }
    return normalMax;
  }

  function getBuyLotsByAmount(code, amount) {
    const stock = STOCKS.find((item) => item.code === code);
    const priceRow = getPrice(code);
    const priceValue = Number(priceRow.close || stock?.initial_price || 0);
    if (!priceValue) return 0;
    const budget = Math.max(0, Number(amount || 0));
    const lotsByBudget = Math.floor(budget / (priceValue * 100 * 1.001));
    return Math.max(0, Math.min(lotsByBudget, getMaxBuyLots(code)));
  }

  function getSellLotsByAmount(code, amount) {
    const priceValue = Number(getPrice(code).close || 0);
    if (!priceValue) return 0;
    const target = Math.max(0, Number(amount || 0));
    const lotsByTarget = Math.floor(target / (priceValue * 100 * 0.999));
    return Math.max(0, Math.min(lotsByTarget, getSellLots(code)));
  }

  function getSellLots(code) {
    const holding = getHolding(code);
    const normalMax = holding ? Math.floor((holding.available_quantity || 0) / 100) : 0;
    const priceRow = getPrice(code);
    const isLimitDown = Number(priceRow.change_pct || 0) <= -0.1;
    if (isLimitDown) {
      return normalMax >= 1 ? Math.max(1, Math.floor(normalMax * 0.5)) : 0;
    }
    return normalMax;
  }

  function estimateBuyTotal(code, lots) {
    const safeLots = Math.max(0, Number(lots || 0));
    return getPrice(code).close * safeLots * 100 * 1.001;
  }

  function estimateSellNet(code, lots) {
    const safeLots = Math.max(0, Number(lots || 0));
    return getPrice(code).close * safeLots * 100 * 0.999;
  }

  function getMaxBuyAmount(code) {
    return estimateBuyTotal(code, getMaxBuyLots(code));
  }

  function getMaxSellAmount(code) {
    return estimateSellNet(code, getSellLots(code));
  }

  function getBuyDisabledReason(code) {
    if (!state.user) return '';
    if (state.isBankrupt) return '已破产，无法交易。请联系管理员重置';
    if (!isTradingAllowed()) return '当前封盘，开盘后才可买入。';
    const priceRow = getPrice(code);
    if (Number(priceRow.change_pct || 0) >= 0.1) {
      return getMaxBuyLots(code) > 0
        ? '该股已涨停，买盘拥挤，当前只能按正常可买量的 50% 成交。'
        : '该股已涨停，且资金或仓位已达上限，暂时无法买入。';
    }
    const lotTotal = estimateBuyTotal(code, 1);
    if ((state.user.cash || 0) < lotTotal) return `可用资金不足，至少需要 ${money(lotTotal)} 才能买入 1 手。`;
    return '';
  }

  function getSellDisabledReason(code) {
    if (!state.user) return '';
    if (state.isBankrupt) return '已破产，无法交易。请联系管理员重置';
    if (!isTradingAllowed()) return '当前封盘，开盘后才可卖出。';
    const priceRow = getPrice(code);
    if (Number(priceRow.change_pct || 0) <= -0.1) {
      return getSellLots(code) > 0
        ? '该股已跌停，卖盘拥挤，当前只能按正常可卖量的 50% 成交。'
        : '该股已跌停，且无可卖持仓，暂时无法卖出。';
    }
    const holding = getHolding(code);
    if (!holding) return '当前未持有这只股票，先买入后才可卖出。';
    if ((holding.available_quantity || 0) < 100) return 'T+1 限制：本期新买入的持仓需要下一期后才可卖出。';
    return '';
  }

  function getFundSellDisabledReason(holding) {
    if (!state.user) return '';
    if (!holding || Number(holding.shares || 0) <= 0) return '当前暂无可赎回份额';
    if (Number(holding.available_shares || 0) <= 0) return '当前份额需到下一期后才可赎回';
    return '';
  }

  function clampLotsForTrade(type, code, lots) {
    const max = type === 'sell' ? getSellLots(code) : getMaxBuyLots(code);
    const value = Math.floor(Number(lots || 0));
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.max(0, Math.min(value, max));
  }

  function clampTradeInput(input) {
    if (input.value === '') return;
    const mode = input.dataset.clamp;
    let max = 100;
    if (mode === 'buy-lots') max = getMaxBuyLots(input.dataset.code);
    if (mode === 'sell-lots') max = getSellLots(input.dataset.code);
    if (mode === 'buy-amount') max = getMaxBuyAmount(input.dataset.code);
    if (mode === 'sell-amount') max = getMaxSellAmount(input.dataset.code);
    if (mode === 'fund-buy') max = state.user?.cash || 0;
    if (mode === 'fund-sell') {
      const detail = state.selectedFund;
      const holding = detail ? (state.fundsStatus || []).find(h => h.fund_code === detail.code) : null;
      max = Number(holding?.available_shares || 0);
    }
    if (mode === 'loan-amount') {
      max = (state.loanStatus && state.loanStatus.max_loan_amount) ? state.loanStatus.max_loan_amount : 0;
    }
    if (mode === 'futures-contracts') {
      const detail = state.selectedFuturesDetail;
      const status = state.futuresStatus || createEmptyFuturesStatus();
      const remaining = Number(status.summary?.remainingExposure || 0);
      const cash = Number(state.user?.cash || 0);
      const minMargin = detail?.minMargin || 0;
      max = minMargin > 0 ? Math.floor(Math.min(remaining, cash) / (minMargin * 1.01)) : 0;
    }
    const value = Number(input.value || 0);
    if (!Number.isFinite(value)) return;
    if (value > max) input.value = mode.includes('amount') || mode.includes('fund-buy') ? Number(max.toFixed(2)).toString() : String(max);
    if (value < 0) input.value = '0';
  }

  function stockPayloadFromForm(data) {
    return {
      currentCode: data.get('currentCode') || '',
      code: String(data.get('code') || '').trim().toUpperCase(),
      name: String(data.get('name') || '').trim(),
      sector: String(data.get('sector') || '其他').trim(),
      industry: String(data.get('industry') || '').trim(),
      mapping: '',
      initial_price: Number(data.get('initial_price') || 0),
      volatility: Number(data.get('volatility') || 0),
      risk_level: String(data.get('risk_level') || 'mid')
    };
  }

  function suggestClientStockCode(stocks) {
    const codes = (stocks || []).map((stock) => stock.code);
    for (let i = 1; i <= 999; i += 1) {
      const code = `SSB${String(i).padStart(3, '0')}`;
      if (!codes.includes(code)) return code;
    }
    return 'SSBNEW';
  }

  function getIndustryOptions(currentIndustry) {
    const industries = Array.from(new Set(STOCKS.map((stock) => stock.industry).filter(Boolean)));
    if (currentIndustry && !industries.includes(currentIndustry)) industries.push(currentIndustry);
    return industries.length ? industries : ['新能源'];
  }

  function setError(message) {
    state.error = message;
    state.notice = '';
  }

  function price(value) {
    return Number(value || 0).toFixed(2);
  }

  function money(value) {
    return Number(value || 0).toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function compactWanAmount(value, options = {}) {
    const amount = Math.max(0, Number(value || 0));
    const prefix = options.approximate === false ? '' : '约 ';
    if (amount <= 0) return `${prefix}0 万`;
    const wan = amount / 10000;
    const digits = options.digits ?? (options.approximate === false ? 0 : 1);
    return `${prefix}${wan.toFixed(digits)} 万`;
  }

  function percent(value) {
    const n = Number(value || 0) * 100;
    const sign = n > 0 ? '+' : '';
    return `${sign}${n.toFixed(2)}%`;
  }

  function dateText(value) {
    if (!value) return '--';
    return new Date(value).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function clockTime(value) {
    if (!value) return '--';
    return new Date(value).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  }

  function tickProgressText(clockData = state.market_clock) {
    if (!clockData) return '--/--';
    const index = Number(clockData.daily_tick_index ?? 0);
    const total = Number(clockData.daily_tick_total ?? 0);
    return `${index}/${total}`;
  }

  function marketClockShortText(clockData = state.market_clock) {
    if (!clockData) return '市场时钟同步中';
    if (clockData.sleeping) return `休眠中 · ${sleepReasonShortText(clockData)}`;
    const status = clockData.trading_allowed ? '开盘中' : '封盘中';
    return `${status} · 今日 ${tickProgressText(clockData)} · 下次 ${clockTime(clockData.next_advance_at)}`;
  }

  function sleepReasonShortText(clockData = state.market_clock) {
    if (!clockData?.sleeping) return '市场活跃';
    if (clockData.sleep_reason === 'runtime_cap') return '连续运行满 14 天';
    return '连续 7 天无人活跃';
  }

  function sleepReasonMessage(clockData = state.market_clock) {
    if (!clockData?.sleeping) return '';
    if (clockData.sleep_reason === 'runtime_cap') return '本局连续运行已满 14 个自然日，已自动休眠。恢复后将从下一次合法推进时点继续。';
    return '连续 7 个自然日无人活跃，本局已自动休眠。恢复后将从下一次合法推进时点继续。';
  }

  function isTradingAllowed() {
    return !!state.market_clock?.trading_allowed;
  }

  function trendClass(value) {
    if (value > 0) return 'up';
    if (value < 0) return 'down';
    return 'flat';
  }

  function riskLabel(value) {
    return { high: '高风险', mid: '中风险', low: '低风险' }[value] || '中风险';
  }

  function futuresTrackRiskLevel(track) {
    return { crypto: 'high', commodity: 'mid', index: 'mid', fx: 'low' }[track] || 'mid';
  }

  function strategyLabel(value) {
    return {
      momentum: '成长动量',
      value: '稳健价值',
      balanced: '均衡配置',
      trending: '趋势押注',
      contrarian: '逆向防御'
    }[value] || '规则管理';
  }

  function managerStyle(strategy) {
    return {
      momentum: '追涨型：偏爱近期强势股，顺势加仓，进攻性强。',
      value: '低吸型：只买跌破公允价的便宜股，待企稳后进场。',
      contrarian: '逆向型：专挑超跌反弹，板块走弱时增持现金防守。',
      balanced: '均衡型：分散持有、偏好低波动标的，稳中求进。',
      trending: '趋势型：重仓押注当下最强趋势，集中而凶悍。'
    }[strategy] || '';
  }

  function fundTransactionLabel(value) {
    return {
      buy: '申购',
      sell: '赎回',
      forced_liquidation: '强平赎回'
    }[value] || '基金交易';
  }

  function sourceLabel(value) {
    return {
      company_announcement: '公司公告',
      government_report: '政府通报',
      industry_flash: '行业快讯',
      macro_policy: '政策解读',
      macro_data: '宏观数据',
      expert_opinion: '专家观点',
      market_rumor: '市场传闻',
      official_clarification: '官方澄清',
      regulatory_filing: '监管文件'
    }[value] || '新闻';
  }

  function isHighlightedNews(item) {
    if (!item) return false;
    return [
      'official_clarification',
      'macro_policy',
      'government_report',
      'regulatory_filing',
      'macro_data'
    ].includes(item.source_type) || !!item.is_rumor;
  }

  function newsCardClass(item) {
    return [
      isHighlightedNews(item) ? 'news-highlight' : '',
      item && item.is_rumor ? 'news-rumor' : ''
    ].filter(Boolean).join(' ');
  }

  function sortNewsByPriority(items) {
    return (items || [])
      .map(function (item, index) { return { item: item, index: index }; })
      .sort(function (a, b) {
        var aPriority = isHighlightedNews(a.item) ? 1 : 0;
        var bPriority = isHighlightedNews(b.item) ? 1 : 0;
        if (aPriority !== bPriority) return bPriority - aPriority;
        return a.index - b.index;
      })
      .map(function (entry) { return entry.item; });
  }

  function summary(text) {
    return text.length > 72 ? `${text.slice(0, 72)}...` : text;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  if (typeof window !== 'undefined') {
    window.__SSB_TEST__ = {
      clearSession,
      render,
      setStocks(nextStocks) {
        STOCKS = Array.isArray(nextStocks) ? nextStocks.slice() : [];
      },
      setState(patch) {
        Object.assign(state, patch || {});
      },
      async setView(view) {
        await setView(view);
      },
      async applyRouteView() {
        await applyRouteView();
      },
      getState() {
        return JSON.parse(JSON.stringify(state));
      }
    };
  }
}());

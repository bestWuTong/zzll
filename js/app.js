/* ==========================================================================
   政治理论排坑速练 — 应用逻辑
   视图：home（首页）/ wrong（错题集）/ quiz（刷题）/ result（结果）
   模式：chapter（章节练习）/ random（打乱刷题）/ wrong（错题集练习）
   题库：由 window.ZZLL_BANKS 注册（data/<题库id>.js），当前题库记在浏览器缓存
   选项：固定「正确」/「错误」，直接与题库数据里的 answer 比较
   ========================================================================== */

(function () {
  'use strict';

  var Store = window.ZZLLStore;

  var RING_CIRC = 326.7;      /* 2πr, r = 52 */
  var ANSWER_TRUE = '正确';
  var ANSWER_FALSE = '错误';

  var state = {
    banks: [],
    bank: null,        /* 当前题库对象 */
    store: null,       /* 当前题库的 { Wrong, Progress } */
    session: null,
    toastTimer: null
  };

  function $(id) { return document.getElementById(id); }

  /* ------------------------------------------------------------------ 工具 */
  function esc(str) {
    return String(str === null || str === undefined ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function clip(list, n) {
    return (!n || n <= 0 || n >= list.length) ? list : list.slice(0, n);
  }

  function contrastAnswer(answer) {
    return answer === ANSWER_TRUE ? ANSWER_FALSE : ANSWER_TRUE;
  }

  function toTop() {
    window.scrollTo(0, 0);
    if (document.documentElement) document.documentElement.scrollTop = 0;
    if (document.body) document.body.scrollTop = 0;
  }

  function showView(name) {
    ['home', 'wrong', 'quiz', 'result'].forEach(function (v) {
      var node = $('view-' + v);
      if (node) node.classList.toggle('is-active', v === name);
    });
    /* 刷题页在移动端要把按钮沉到屏幕底部，需要收紧 .app 的底部内边距 */
    document.body.classList.toggle('is-quiz', name === 'quiz');
    toTop();
  }

  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    el.style.animation = 'none';
    void el.offsetWidth;          /* 强制重排以重播动画 */
    el.style.animation = '';
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () { el.hidden = true; }, 2400);
  }

  /* -------------------------------------------------------- 主题（暗色/浅色）
     选择存在 zzll.theme.v1；没存过就跟随系统偏好（首帧前的内联脚本已处理初始值）。
     切换用 View Transitions 做 Telegram 同款的圆形遮罩扩散动画。 */
  var THEME_KEY = 'zzll.theme.v1';
  var ICON_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"></path></svg>';
  var ICON_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.1"></circle>' +
    '<path d="M12 2.6v2.3M12 19.1v2.3M4.5 4.5l1.6 1.6M17.9 17.9l1.6 1.6M2.6 12h2.3M19.1 12h2.3' +
    'M4.5 19.5l1.6-1.6M17.9 6.1l1.6-1.6"></path></svg>';

  function savedTheme() {
    try {
      var v = window.localStorage.getItem(THEME_KEY);
      return v === 'dark' || v === 'light' ? v : null;
    } catch (e) {
      return null;
    }
  }

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function renderThemeBtn() {
    var btn = $('themeBtn');
    if (!btn) return;
    var dark = currentTheme() === 'dark';
    var label = dark ? '切换到浅色模式' : '切换到暗色模式';
    btn.innerHTML = dark ? ICON_SUN : ICON_MOON;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
  }

  /** 同步浏览器地址栏配色，直接取计算后的 --bg，避免和 CSS 两处维护 */
  function syncThemeColor() {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    var bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (bg) meta.setAttribute('content', bg);
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    renderThemeBtn();
    syncThemeColor();
  }

  function toggleTheme(evt) {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    try { window.localStorage.setItem(THEME_KEY, next); } catch (e) { /* 隐私模式忽略 */ }

    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || typeof document.startViewTransition !== 'function') {
      setTheme(next);
      return;
    }

    /* 圆心取点击位置；键盘触发（无坐标）时退回按钮中心 */
    var x, y;
    if (evt && typeof evt.clientX === 'number' && (evt.clientX || evt.clientY)) {
      x = evt.clientX;
      y = evt.clientY;
    } else {
      var rect = $('themeBtn').getBoundingClientRect();
      x = rect.left + rect.width / 2;
      y = rect.top + rect.height / 2;
    }
    /* 半径取到最远角，保证圆形遮罩能铺满整屏 */
    var radius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y)
    );

    var vt = document.startViewTransition(function () { setTheme(next); });
    vt.ready.then(function () {
      document.documentElement.animate(
        {
          clipPath: [
            'circle(0px at ' + x + 'px ' + y + 'px)',
            'circle(' + radius + 'px at ' + x + 'px ' + y + 'px)'
          ]
        },
        {
          duration: 560,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          pseudoElement: '::view-transition-new(root)'
        }
      );
    }).catch(function () { /* 过渡被中断，忽略 */ });
  }

  /** 没显式选过主题时，跟随系统变化 */
  function watchSystemTheme() {
    if (!window.matchMedia) return;
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function (e) {
      if (savedTheme()) return;          /* 用户已显式选择，不覆盖 */
      setTheme(e.matches ? 'dark' : 'light');
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  /* -------------------------------------------------------------- 题库管理 */
  function loadBanks() {
    var reg = window.ZZLL_BANKS || {};
    var list = Object.keys(reg).map(function (k) { return reg[k]; })
      .filter(function (b) { return b && b.id && Array.isArray(b.chapters); });
    list.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    return list;
  }

  function bankById(id) {
    for (var i = 0; i < state.banks.length; i++) {
      if (state.banks[i].id === id) return state.banks[i];
    }
    return null;
  }

  /** 切换当前题库：换存储实例、记住选择 */
  function useBank(bankId) {
    var bank = bankById(bankId) || state.banks[0] || null;
    state.bank = bank;
    state.store = bank ? Store.forBank(bank.id) : null;
    if (state.store) state.store.Stats.seedFromProgress();
    if (bank) Store.Banks.select(bank.id);
    return bank;
  }

  function bankTitle() {
    return state.bank ? (state.bank.shortName || state.bank.name) : '';
  }

  function countQuestions(bank) {
    if (bank.meta && bank.meta.totalQuestions) return bank.meta.totalQuestions;
    var n = 0;
    (bank.chapters || []).forEach(function (c) { n += (c.questions || []).length; });
    return n;
  }

  /** 当前题库的全部题目（打平，带上章节信息） */
  function allQuestions() {
    var bank = state.bank;
    if (!bank) return [];
    var out = [];
    (bank.chapters || []).forEach(function (ch) {
      (ch.questions || []).forEach(function (q) {
        out.push({
          id: q.id, no: q.no, stem: q.stem,
          answer: q.answer, explanation: q.explanation,
          chapterId: ch.id, chapterTitle: ch.title
        });
      });
    });
    return out;
  }

  /* --------------------------------------------------------- 首页：题库切换 */
  function renderBankSwitcher() {
    var bank = state.bank;
    $('bankBtnLabel').textContent = bank ? (bank.shortName || bank.name) : '选择题库';
    $('bankBtn').disabled = state.banks.length < 1;
    $('bankSwitch').hidden = state.banks.length < 2;

    $('bankMenu').innerHTML = state.banks.map(function (b) {
      var on = !!(bank && b.id === bank.id);
      var overall = Store.forBank(b.id).Progress.overall();
      var meta = countQuestions(b) + ' 题 · ' + (b.chapters || []).length + ' 章';
      if (overall.answered) meta += ' · 已练 ' + overall.answered;
      return '' +
        '<button class="bank-item' + (on ? ' is-on' : '') + '" type="button" role="option" ' +
          'aria-selected="' + (on ? 'true' : 'false') + '" data-bank="' + esc(b.id) + '">' +
          '<span class="bank-item-main">' +
            '<span class="bank-item-name">' + esc(b.name) + '</span>' +
            '<span class="bank-item-meta">' + esc(meta) + '</span>' +
          '</span>' +
          '<svg class="bank-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M20 6 9 17l-5-5"></path></svg>' +
        '</button>';
    }).join('');
  }

  function setBankMenuOpen(open) {
    $('bankMenu').hidden = !open;
    $('bankBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
    $('bankBtn').classList.toggle('is-open', !!open);
  }

  function isBankMenuOpen() {
    return !$('bankMenu').hidden;
  }

  /* -------------------------------------------------------------- 首页渲染 */
  function renderHome() {
    renderBankSwitcher();
    renderChapterList();
    renderHeroStats();
    $('footMeta').textContent = (state.bank && state.bank.meta && state.bank.meta.generatedAt)
      ? bankTitle() + '题库更新于 ' + state.bank.meta.generatedAt
      : '';
  }

  function renderHeroStats() {
    var bank = state.bank;
    if (!bank) { $('homeStats').innerHTML = ''; return; }

    var total = countQuestions(bank);
    var wrongCount = state.store.Wrong.count();
    var overall = state.store.Progress.overall();

    var stats = [
      '题库 <b>' + total + '</b> 题',
      '<b>' + (bank.chapters || []).length + '</b> 个章节'
    ];
    if (overall.answered > 0) {
      stats.push('已练 <b>' + overall.answered + '</b> 题');
      stats.push('正确率 <b>' + Math.round(overall.rate * 100) + '%</b>');
    }
    $('homeStats').innerHTML = stats.map(function (s) { return '<span>' + s + '</span>'; }).join('');

    $('wrongCountText').textContent = wrongCount + ' 题';
    $('modalSub').textContent = '从「' + bankTitle() + '」的全部题目中随机抽取';

    /* 没有练习记录时「清除练习记录」置灰 */
    var recorded = overall.answered > 0 || Object.keys(state.store.Stats.all()).length > 0;
    if ($('btnClearRecord')) $('btnClearRecord').disabled = !recorded;
  }

  function renderChapterList() {
    var bank = state.bank;
    if (!bank) {
      $('chapterList').innerHTML =
        '<div class="empty-state"><p class="empty-title">尚未加载题库</p>' +
        '<p class="empty-desc">题库数据缺失，请先运行题库解析脚本<br>生成 data/&lt;题库&gt;.json 后再打开页面。</p></div>';
      return;
    }

    $('chapterList').innerHTML = (bank.chapters || []).map(function (ch) {
      var count = (ch.questions || []).length;
      var st = state.store.Progress.chapterStats(ch.id);
      var meta = count + ' 题';
      if (st.answered > 0) {
        meta += ' · 已练 ' + st.answered + ' · 正确率 ' + Math.round(st.rate * 100) + '%';
      }
      return '' +
        '<button class="chapter-item" type="button" data-chapter="' + esc(ch.id) + '">' +
          '<span class="chapter-main">' +
            '<span class="chapter-name">' + esc(ch.title) + '</span>' +
            '<span class="chapter-meta">' + meta + '</span>' +
          '</span>' +
          chapterRing(st) +
          '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"></path></svg>' +
        '</button>';
    }).join('');
  }

  function chapterRing(st) {
    if (!st.answered) {
      return '<span class="chapter-ring is-empty">' +
        '<svg viewBox="0 0 42 42"><circle class="cr-bg" cx="21" cy="21" r="17"></circle></svg>' +
        '<span class="cr-text">未练</span></span>';
    }
    var p = st.rate;
    var offset = (106.8 * (1 - p)).toFixed(1);
    var color = p >= 0.8 ? 'var(--green)' : (p >= 0.5 ? 'var(--accent)' : 'var(--orange)');
    return '<span class="chapter-ring">' +
      '<svg viewBox="0 0 42 42">' +
        '<circle class="cr-bg" cx="21" cy="21" r="17"></circle>' +
        '<circle class="cr-fg" cx="21" cy="21" r="17" stroke="' + color + '" ' +
          'style="stroke-dasharray:106.8;stroke-dashoffset:' + offset + '"></circle>' +
      '</svg>' +
      '<span class="cr-text" style="color:' + color + '">' + Math.round(p * 100) + '</span>' +
    '</span>';
  }

  /* ------------------------------------------------------------ 会话 / 刷题 */
  /**
   * shuffleState 仅「打乱刷题」有，用于串联多组：
   *   { size: 每组题量（0 = 全部）, used: Set<题目id> 本次系列已出过的题 }
   * 靠它在「下一组」时跳过做过的题，做完全部后隐藏按钮。
   */
  function startSession(opts) {
    state.session = {
      mode: opts.mode,
      title: opts.title,
      questions: opts.questions,
      index: 0,
      answers: opts.questions.map(function () { return null; }),
      addedToWrong: false,
      shuffle: opts.shuffle || null,
      chapterId: opts.chapterId || null      /* 章节模式才有，用于「下一节」 */
    };
    showView('quiz');
    renderQuestion();
  }

  /** 开始某个章节的练习 */
  function startChapter(ch) {
    if (!ch) return;
    var qs = (ch.questions || []).map(function (q) {
      return {
        id: q.id, no: q.no, stem: q.stem, answer: q.answer,
        explanation: q.explanation,
        chapterId: ch.id, chapterTitle: ch.title
      };
    });
    if (!qs.length) { toast('该章节暂无题目'); return; }
    startSession({ mode: 'chapter', title: ch.title, questions: qs, chapterId: ch.id });
  }

  /** 当前章节的下一节（最后一节返回 null） */
  function nextChapterOf(s) {
    if (!s || s.mode !== 'chapter' || !s.chapterId) return null;
    var chapters = (state.bank && state.bank.chapters) || [];
    for (var i = 0; i < chapters.length; i++) {
      if (chapters[i].id === s.chapterId) return chapters[i + 1] || null;
    }
    return null;
  }

  /** 打乱刷题：题库里还没出过的题 */
  function shuffleRemaining(s) {
    if (!s || s.mode !== 'random' || !s.shuffle) return [];
    var used = s.shuffle.used;
    return allQuestions().filter(function (q) { return !used.has(q.id); });
  }

  /**
   * 从候选池里取 n 题。
   * priority=true 时按「答对次数最少优先」：先按次数分桶，
   * 从 0 次桶开始依次取（桶内随机），所以生疏的题会先出现。
   */
  function pickQuestions(pool, n, priority) {
    if (!n || n <= 0) return shuffle(pool);
    if (!priority) return clip(shuffle(pool), n);

    var counts = state.store.Stats.all();
    var buckets = {};
    pool.forEach(function (q) {
      var c = counts[q.id] || 0;
      if (!buckets[c]) buckets[c] = [];
      buckets[c].push(q);
    });

    var keys = Object.keys(buckets).map(Number).sort(function (a, b) { return a - b; });
    var out = [];
    for (var i = 0; i < keys.length && out.length < n; i++) {
      var group = shuffle(buckets[keys[i]]);
      for (var j = 0; j < group.length && out.length < n; j++) out.push(group[j]);
    }
    return out;
  }

  /** 重做一遍：同样的题目、同样的顺序，作答记录清空 */
  function restartSession() {
    var s = state.session;
    if (!s) return;
    startSession({
      mode: s.mode,
      title: s.title,
      questions: s.questions,
      shuffle: s.shuffle,
      chapterId: s.chapterId
    });
  }

  /** 下一组：按相同题量再抽一组未做过的题；题目用尽时提示 */
  function startNextShuffleGroup() {
    var s = state.session;
    if (!s || s.mode !== 'random' || !s.shuffle) return;
    var remaining = shuffleRemaining(s);
    if (!remaining.length) { toast('这个题库的题目都刷过了'); return; }

    var size = s.shuffle.size;
    var priority = s.shuffle.priority;
    var take = Math.min(size, remaining.length);
    var picked = pickQuestions(remaining, take, priority);
    var used = s.shuffle.used;
    picked.forEach(function (q) { used.add(q.id); });

    startSession({
      mode: 'random',
      title: '打乱刷题 · ' + picked.length + ' 题',
      questions: picked,
      shuffle: { size: size, used: used, priority: priority }
    });
    toast(remaining.length > picked.length
      ? '下一组 ' + picked.length + ' 题（还剩 ' + (remaining.length - picked.length) + ' 题）'
      : '最后一组，已刷完这个题库的全部题目');
  }

  /**
   * 会话失效时的兜底：视图还停在刷题页但会话已经不在，
   * 直接退回首页，避免界面卡死无法操作。
   */
  function ensureSession() {
    if (state.session) return state.session;
    var quizView = $('view-quiz');
    if (quizView && quizView.classList.contains('is-active')) {
      renderHome();
      showView('home');
      toast('练习状态已重置');
    }
    return null;
  }

  function answeredCount(s) {
    var n = 0;
    for (var i = 0; i < s.answers.length; i++) if (s.answers[i]) n++;
    return n;
  }

  function correctCount(s) {
    var n = 0;
    s.questions.forEach(function (q, i) {
      var a = s.answers[i];
      if (a && a.choice === q.answer) n++;
    });
    return n;
  }

  function updateHud() {
    var s = state.session;
    if (!s) return;
    var total = s.questions.length;
    var correct = correctCount(s);
    var answered = answeredCount(s);
    $('quizScore').innerHTML = '✓ ' + correct + ' · ✗ ' + (answered - correct);
    $('quizProgress').style.width = (total ? answered / total * 100 : 0) + '%';
  }

  /** 答对瞬间给比分一次绿色脉冲，作为「已判定为正确」的即时反馈 */
  function pulseScore() {
    var el = $('quizScore');
    el.classList.remove('pulse');
    void el.offsetWidth;
    el.classList.add('pulse');
  }

  function renderQuestion() {
    var s = state.session;
    if (!s) return;
    var q = s.questions[s.index];
    if (!q) { finishSession(); return; }
    var total = s.questions.length;
    var a = s.answers[s.index];

    $('quizTitle').textContent = s.title;
    $('quizCounter').textContent = '第 ' + (s.index + 1) + ' / ' + total + ' 题';
    updateHud();

    $('qTag').textContent = q.chapterTitle
      ? q.chapterTitle + (s.mode === 'wrong' ? ' · 错题重练' : '')
      : '判断题';
    $('qStem').textContent = q.stem;

    var opts = $('qOptions');
    Array.prototype.forEach.call(opts.children, function (btn) {
      btn.classList.remove('is-picked', 'is-correct', 'is-wrong');
      btn.disabled = false;
    });

    var fb = $('qFeedback');
    fb.hidden = true;
    fb.className = 'feedback';
    fb.innerHTML = '';

    if (a) paintAnswer(q, a.choice);

    $('btnPrev').disabled = s.index === 0;
    $('btnNext').disabled = !a;
    $('btnNext').textContent = (s.index === total - 1) ? '查看结果' : '下一题';

    toTop();
  }

  /** 把「已作答」状态画到选项与反馈区上 */
  function paintAnswer(q, choice) {
    var isCorrect = choice === q.answer;
    var buttons = $('qOptions').children;

    Array.prototype.forEach.call(buttons, function (btn) {
      btn.disabled = true;
      var val = btn.getAttribute('data-choice');
      if (val === choice) btn.classList.add('is-picked');
      /* 正确答案永远高亮为绿；选错的标红 */
      if (val === q.answer) btn.classList.add('is-correct');
      if (val !== q.answer && val === choice) btn.classList.add('is-wrong');
    });

    var fb = $('qFeedback');
    var icon = isCorrect
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"></path></svg>';

    /* 解析不分对错一律展示：答对会瞬间跳题，回看时同样要能看到解析，
       便于判断某题是「真会」还是「碰巧选对」 */
    var explHTML =
      '<div class="fb-expl">' +
        '<div class="fb-expl-label">解析</div>' +
        '<div class="fb-expl-text' + (q.explanation ? '' : ' is-empty') + '">' +
          esc(q.explanation || '本题暂无解析') +
        '</div>' +
      '</div>';

    if (isCorrect) {
      fb.className = 'feedback is-correct';
      fb.innerHTML =
        '<div class="fb-head">' + icon + '<span>回答正确</span></div>' +
        '<div class="fb-meta">正确答案：<b>' + esc(q.answer) + '</b></div>' +
        explHTML;
    } else {
      fb.className = 'feedback is-wrong';
      fb.innerHTML =
        '<div class="fb-head">' + icon + '<span>回答错误</span></div>' +
        '<div class="fb-meta">你的选择：<b>' + esc(choice) +
          '</b> · 正确答案：<b>' + esc(q.answer) + '</b></div>' +
        explHTML;
    }
    fb.hidden = false;
  }

  function chooseAnswer(choice) {
    var s = ensureSession();
    if (!s) return;
    var index = s.index;
    var q = s.questions[index];
    if (!q) return;
    /* 本题已作答：直接忽略重复点击（选项此时已是禁用态） */
    if (s.answers[index]) return;

    s.answers[index] = { choice: choice };
    var correct = choice === q.answer;
    var isLast = index >= s.questions.length - 1;

    state.store.Progress.record(q.chapterId, q.id, correct);
    if (correct) state.store.Stats.bump(q.id);          /* 累计每题答对次数 */

    if (correct && !isLast) {
      /* 答对且不是最后一题：不停顿，直接进入下一题（不展示「回答正确」过渡） */
      s.index = index + 1;
      renderQuestion();
      pulseScore();
      return;
    }

    /* 答错，或者本题就是最后一题：停留在此题，展示正确答案与解析，
       由用户手动点「下一题 / 查看结果」。
       最后一题答对也停下，是为了让人先看完解析再进入结果页。 */
    paintAnswer(q, choice);
    updateHud();
    if (correct) pulseScore();
    $('btnNext').disabled = false;
    $('btnNext').textContent = isLast ? '查看结果' : '下一题';
  }

  function goNext() {
    var s = ensureSession();
    if (!s) return;
    if (!s.answers[s.index]) return;                /* 未作答不允许跳过 */
    if (s.index >= s.questions.length - 1) { finishSession(); return; }
    s.index++;
    renderQuestion();
  }

  function goPrev() {
    var s = ensureSession();
    if (!s || s.index === 0) return;
    s.index--;
    renderQuestion();
  }

  /* ---------------------------------------------------------------- 结果页 */
  function finishSession() {
    var s = state.session;
    var total = s.questions.length;
    var correct = correctCount(s);
    var rate = total ? correct / total : 0;

    var color = rate >= 0.8 ? 'var(--green)' : (rate >= 0.5 ? 'var(--accent)' : 'var(--orange)');
    var ring = $('ringFg');
    ring.style.stroke = color;
    ring.style.strokeDashoffset = RING_CIRC;

    $('resultRate').textContent = Math.round(rate * 100) + '%';
    $('resultRate').style.color = rate >= 0.8 ? 'var(--green)' : 'var(--text)';
    $('resultCount').textContent = '正确 ' + correct + ' 题 / 共 ' + total + ' 题';

    var hint;
    if (rate === 1) hint = '全部答对，这一组很稳。';
    else if (rate >= 0.8) hint = '表现不错，留意个别易错点。';
    else if (rate >= 0.6) hint = '基础还可以，错的几题值得回头看解析。';
    else hint = '错的比较多，建议把解析逐条过一遍。';
    $('resultHint').textContent = hint;

    var wrongOnes = [];
    s.questions.forEach(function (q, i) {
      var a = s.answers[i];
      if (a && a.choice !== q.answer) wrongOnes.push(q);
    });
    var correctOnes = s.questions.filter(function (q, i) {
      var a = s.answers[i];
      return a && a.choice === q.answer;
    });

    var actions = $('resultActions');
    var html = '';

    if (s.mode === 'wrong') {
      html += '<button class="btn btn-primary" type="button" data-act="back-wrong">返回错题集</button>';
      html += '<button class="btn btn-soft" type="button" data-act="prune"' +
        (correctOnes.length ? '' : ' disabled') + '>将答对的 ' + correctOnes.length +
        ' 题移出错题集</button>';
    } else {
      /* 打乱刷题：还有没做过的题时给出「下一组」。
         「下一节」「下一组」「重做一遍」都用与「返回首页」相同的 btn-ghost 样式
         （白底描边），只有「加入错题集」是强调按钮。 */
      var remaining = shuffleRemaining(s).length;
      var canNextGroup = s.mode === 'random' && remaining > 0;
      var nextChapter = nextChapterOf(s);

      if (canNextGroup) {
        html += '<button class="btn btn-ghost" type="button" data-act="next-group">' +
          '下一组（还剩 ' + remaining + ' 题）</button>';
      } else if (nextChapter) {
        html += '<button class="btn btn-ghost" type="button" data-act="next-chapter" ' +
          'title="' + esc(nextChapter.title) + '">下一节</button>';
      }

      var already = s.addedToWrong;
      html += '<button class="btn btn-primary" type="button" data-act="add-wrong"' +
        (wrongOnes.length && !already ? '' : ' disabled') + '>' +
        (already ? '已加入错题集' :
          (wrongOnes.length ? '把错题 ' + wrongOnes.length + ' 题加入错题集' : '本次无错题')) +
        '</button>';

      html += '<button class="btn btn-ghost" type="button" data-act="redo">重做一遍</button>';
      html += '<button class="btn btn-ghost" type="button" data-act="home">返回首页</button>';
    }
    actions.innerHTML = html;

    var review = '';
    if (wrongOnes.length) {
      review = '<h3 class="review-title">本次答错的 ' + wrongOnes.length + ' 题</h3>' +
        '<div class="wrong-list">' + wrongOnes.map(function (q) {
          return wrongItemHTML(q, false);
        }).join('') + '</div>';
    }
    $('resultReview').innerHTML = review;

    showView('result');
    setTimeout(function () {
      ring.style.strokeDashoffset = (RING_CIRC * (1 - rate)).toFixed(1);
    }, 60);
  }

  /* ------------------------------------------------------------- 错题集页面 */
  function wrongItemHTML(q, withRemove) {
    var removeBtn = withRemove
      ? '<button class="remove-btn" type="button" data-remove="' + esc(q.id) + '">移除</button>'
      : '';
    var isTrue = q.answer === ANSWER_TRUE;
    return '' +
      '<article class="wrong-item" data-id="' + esc(q.id) + '">' +
        '<div class="wrong-top">' +
          (q.chapterTitle ? '<span class="wrong-tag">' + esc(q.chapterTitle) + '</span>' : '') +
          '<span class="wrong-spacer"></span>' +
          removeBtn +
        '</div>' +
        '<p class="wrong-stem">' + esc(q.stem) + '</p>' +
        '<span class="wrong-answer ' + (isTrue ? 'is-true' : 'is-false') + '">正确答案：' +
          esc(q.answer) + '</span>' +
        '<div class="wrong-expl">' + esc(q.explanation || '本题暂无解析') + '</div>' +
      '</article>';
  }

  function renderWrong() {
    var list = state.store.Wrong.all();
    $('wrongSub').textContent = bankTitle() + ' · 共 ' + list.length + ' 题';
    $('btnWrongStart').disabled = list.length === 0;
    $('btnWrongExport').disabled = list.length === 0;
    $('btnWrongClear').disabled = list.length === 0;

    if (!list.length) {
      $('wrongList').innerHTML =
        '<div class="empty-state">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M12 3.5 20 7v5.2c0 4.4-3.2 7.4-8 8.3-4.8-.9-8-3.9-8-8.3V7l8-3.5Z"></path>' +
            '<path d="M9.2 12.2l2 2 3.6-3.9"></path></svg>' +
          '<p class="empty-title">「' + esc(bankTitle()) + '」的错题集还是空的</p>' +
          '<p class="empty-desc">刷完后在结果页点「加入错题集」，<br>或者在此处导入之前导出的 JSON 文件。</p>' +
        '</div>';
      return;
    }

    $('wrongList').innerHTML = list.map(function (q) {
      return wrongItemHTML(q, true);
    }).join('');
  }

  /* --------------------------------------------------------------- 导入导出 */
  function download(filename, text) {
    var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '_' + p(d.getHours()) + p(d.getMinutes());
  }

  function handleImport(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var payload = JSON.parse(String(reader.result));
        var res = state.store.Wrong.importPayload(payload);
        renderWrong();
        var from = res.fromBank && res.fromBank.name && res.fromBank.id !== state.bank.id
          ? '（文件来自「' + res.fromBank.name + '」）' : '';
        toast('导入到「' + bankTitle() + '」：新增 ' + res.added + ' 题，已存在 ' +
          res.existed + ' 题' + from);
      } catch (err) {
        toast('导入失败：' + (err && err.message ? err.message : '文件格式不正确'));
      }
    };
    reader.onerror = function () { toast('导入失败：无法读取文件'); };
    reader.readAsText(file, 'utf-8');
  }

  /* ------------------------------------------------------------- 事件绑定 */
  function bind() {
    /* 暗色模式切换 */
    $('themeBtn').addEventListener('click', toggleTheme);

    /* 首页：题库切换 */
    $('bankBtn').addEventListener('click', function (e) {
      e.stopPropagation();
      setBankMenuOpen(!isBankMenuOpen());
    });

    $('bankMenu').addEventListener('click', function (e) {
      var item = e.target.closest ? e.target.closest('.bank-item') : null;
      if (!item) return;
      var id = item.getAttribute('data-bank');
      setBankMenuOpen(false);
      if (!id || (state.bank && id === state.bank.id)) return;
      useBank(id);
      renderHome();
      toast('已切换到「' + bankTitle() + '」');
    });

    document.addEventListener('click', function (e) {
      if (!isBankMenuOpen()) return;
      /* 菜单现在是工具区的子元素，不能只判断切换器 */
      if ($('bankSwitch').contains(e.target) || $('bankMenu').contains(e.target)) return;
      setBankMenuOpen(false);
    });

    /* 首页 */
    $('btnGoWrong').addEventListener('click', function () {
      renderWrong();
      showView('wrong');
    });

    /* 清除练习记录：只清当前题库的「练习」数据（答对次数 + 章节进度/正确率），
       不碰错题集，也不碰题库选择与主题 */
    $('btnClearRecord').addEventListener('click', function () {
      if (!state.store) return;
      var name = bankTitle();
      var answered = state.store.Progress.overall().answered;
      var counted = Object.keys(state.store.Stats.all()).length;
      if (!answered && !counted) { toast('「' + name + '」还没有练习记录'); return; }
      if (!window.confirm(
        '清除「' + name + '」的练习记录？\n\n' +
        '会清空：每题答对次数、各章节正确率与已练进度。\n' +
        '错题集不受影响。此操作不可撤销。')) return;
      state.store.Stats.reset();
      state.store.Progress.reset();
      renderHome();
      toast('已清除「' + name + '」的练习记录');
    });

    $('btnShuffle').addEventListener('click', function () {
      /* 每次打开都回到默认：勾选「优先推送答对次数最少的题目」 */
      $('optPriority').checked = true;
      $('shuffleModal').hidden = false;
    });

    $('chapterList').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.chapter-item') : null;
      if (!btn) return;
      var cid = btn.getAttribute('data-chapter');
      var ch = (state.bank.chapters || []).filter(function (c) { return c.id === cid; })[0];
      startChapter(ch);
    });

    /* 打乱刷题弹窗 */
    var modal = $('shuffleModal');
    modal.addEventListener('click', function (e) {
      if (e.target.getAttribute && e.target.getAttribute('data-close')) {
        modal.hidden = true;
        return;
      }
      var opt = e.target.closest ? e.target.closest('.modal-opt') : null;
      if (!opt) return;
      var n = parseInt(opt.getAttribute('data-count'), 10);
      var priority = !!($('optPriority') && $('optPriority').checked);
      modal.hidden = true;
      var pool = allQuestions();
      if (!pool.length) { toast('题库为空'); return; }
      var picked = pickQuestions(pool, n, priority);
      var used = new Set();
      picked.forEach(function (q) { used.add(q.id); });
      startSession({
        mode: 'random',
        title: '打乱刷题 · ' + picked.length + ' 题',
        questions: picked,
        shuffle: { size: n, used: used, priority: priority }
      });
    });

    /* 刷题页 */
    $('qOptions').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.opt') : null;
      if (!btn || btn.disabled) return;
      /* 答对会瞬间跳到下一题，若用户是双击，第二下会落在新题的同一位置，
         等于替下一题作答。detail > 1 即「同一次连击的第 2、3 下」，直接忽略
         （鼠标单击为 1、键盘触发的点击为 0、触屏为 1，均不受影响）。 */
      if (e.detail > 1) return;
      chooseAnswer(btn.getAttribute('data-choice'));
    });
    $('btnNext').addEventListener('click', goNext);
    $('btnPrev').addEventListener('click', goPrev);
    $('quizBack').addEventListener('click', function () {
      var s = state.session;
      if (s) {
        var done = answeredCount(s);
        if (done > 0 && done < s.questions.length) {
          if (!window.confirm('本次练习还没做完，确定要退出吗？')) return;
        }
      }
      var backToWrong = !!(s && s.mode === 'wrong');
      state.session = null;
      if (backToWrong) { renderWrong(); showView('wrong'); }
      else { renderHome(); showView('home'); }
    });

    /* 结果页 */
    $('resultActions').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!btn || btn.disabled) return;
      var act = btn.getAttribute('data-act');
      var s = state.session;

      if (act === 'add-wrong') {
        var wrongOnes = [];
        s.questions.forEach(function (q, i) {
          var a = s.answers[i];
          if (a && a.choice !== q.answer) wrongOnes.push(q);
        });
        var res = state.store.Wrong.addMany(wrongOnes, function (q) {
          return { chapterId: q.chapterId, chapterTitle: q.chapterTitle };
        });
        s.addedToWrong = true;
        btn.disabled = true;
        btn.textContent = '已加入错题集';
        toast('已加入「' + bankTitle() + '」错题集：新增 ' + res.added + ' 题，已存在 ' + res.existed + ' 题');
      } else if (act === 'prune') {
        var ids = [];
        s.questions.forEach(function (q, i) {
          var a = s.answers[i];
          if (a && a.choice === q.answer) ids.push(q.id);
        });
        var removed = state.store.Wrong.removeMany(ids);
        toast('已从「' + bankTitle() + '」错题集移除 ' + removed + ' 题');
        state.session = null;
        renderWrong();
        showView('wrong');
      } else if (act === 'next-group') {
        startNextShuffleGroup();
      } else if (act === 'next-chapter') {
        startChapter(nextChapterOf(s));
      } else if (act === 'redo') {
        restartSession();
      } else if (act === 'back-wrong') {
        renderWrong();
        showView('wrong');
      } else if (act === 'home') {
        renderHome();
        showView('home');
      }
    });

    /* 错题集页 */
    $('wrongBack').addEventListener('click', function () {
      renderHome();
      showView('home');
    });

    $('btnWrongStart').addEventListener('click', function () {
      var list = state.store.Wrong.all();
      if (!list.length) { toast('错题集为空'); return; }
      startSession({
        mode: 'wrong',
        title: '错题集 · 随机练习',
        questions: shuffle(list)
      });
    });

    $('wrongList').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-remove]') : null;
      if (!btn) return;
      var id = btn.getAttribute('data-remove');
      var item = btn.closest('.wrong-item');
      state.store.Wrong.remove(id);
      if (item && item.parentNode) item.parentNode.removeChild(item);
      var left = state.store.Wrong.count();
      $('wrongSub').textContent = bankTitle() + ' · 共 ' + left + ' 题';
      $('btnWrongStart').disabled = left === 0;
      $('btnWrongExport').disabled = left === 0;
      $('btnWrongClear').disabled = left === 0;
      if (left === 0) renderWrong();
      toast('已移除');
    });

    $('btnWrongExport').addEventListener('click', function () {
      if (!state.store.Wrong.count()) return;
      download('政治理论错题集_' + bankTitle() + '_' + stamp() + '.json',
        JSON.stringify(state.store.Wrong.exportPayload(state.bank), null, 2));
      toast('已导出「' + bankTitle() + '」错题 ' + state.store.Wrong.count() + ' 题');
    });

    $('btnWrongImport').addEventListener('click', function () {
      $('importFile').value = '';
      $('importFile').click();
    });

    $('importFile').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (file) handleImport(file);
    });

    $('btnWrongClear').addEventListener('click', function () {
      if (!state.store.Wrong.count()) return;
      if (!window.confirm('确定要清空「' + bankTitle() + '」错题集（' +
        state.store.Wrong.count() + ' 题）吗？此操作不可撤销。')) return;
      state.store.Wrong.clear();
      renderWrong();
      toast('「' + bankTitle() + '」错题集已清空');
    });

    /* 键盘快捷键：← → 翻题，1 / 2 作答，Esc 关下拉 */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isBankMenuOpen()) { setBankMenuOpen(false); return; }
      if (!$('view-quiz').classList.contains('is-active')) return;
      if (e.key === 'ArrowRight' || e.key === 'Enter') { goNext(); }
      else if (e.key === 'ArrowLeft') { goPrev(); }
      else if (e.key === '1') { chooseAnswer(ANSWER_TRUE); }
      else if (e.key === '2') { chooseAnswer(ANSWER_FALSE); }
    });
  }

  /* ---------------------------------------------------------------- 启动 */
  function boot() {
    state.banks = loadBanks();
    useBank(Store.Banks.selected());
    /* 旧版本只有一个题库，错题集/进度存在无题库维度的 key 里，搬到超格名下。
       存储读取是懒加载的，这里搬完就可以直接渲染。 */
    Store.Banks.migrateLegacy();
    renderThemeBtn();
    syncThemeColor();
    watchSystemTheme();
    bind();
    renderHome();
    /* 首页已经渲染好，撤掉启动遮罩（最短展示时长由 hideBoot 内部保证） */
    if (window.hideBoot) window.hideBoot();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

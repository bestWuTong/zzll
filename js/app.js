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
    sectionMode: 'practice',   /* 章节模式：practice 刷题 / read 阅读 */
    toastTimer: null,
    booting: true,             /* 启动阶段：同步结果先暂存，进页面后再提示 */
    bootSyncEvent: null,
    resumeProgress: null       /* 打乱刷题：上次未完成的序列（弹窗里展示用） */
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
    ['home', 'wrong', 'quiz', 'result', 'read'].forEach(function (v) {
      var node = $('view-' + v);
      if (node) node.classList.toggle('is-active', v === name);
    });
    /* 刷题页在移动端要把按钮沉到屏幕底部，需要收紧 .app 的底部内边距 */
    document.body.classList.toggle('is-quiz', name === 'quiz');
    /* 离开结果页就掐掉彩带（避免在看不见的地方空跑） */
    if (name !== 'result' && window.ZZLLConfetti) window.ZZLLConfetti.stop();
    /* 首页重新可见后重新贴合模式开关的滑块。
       从阅读/结果页返回时，视图刚从 display:none 变回可见，
       必须等一帧再量宽度（否则量到 0）。 */
    if (name === 'home') requestAnimationFrame(positionModeThumb);
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
      var overall = bankProgress(Store.forBank(b.id), b);
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
    var overall = bankProgress(state.store, bank);

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

  /**
   * 按「题库里现存的题目」统计一章的进度。
   * 不能直接用 Store 的 chapterStats：它数的是 seen / correct 集合的大小，
   * 题库更新删掉或改过 id 之后，旧 id 会一直留在存储里，
   * 于是会出现「共 10 题 · 已练 11」这种越界数字。
   */
  function chapterProgress(s, ch) {
    var p = s.Progress.all()[ch.id] || {};
    var seen = p.seen || {}, correct = p.correct || {};
    var questions = ch.questions || [];
    var answered = 0, ok = 0;
    questions.forEach(function (q) {
      if (seen[q.id]) {
        answered++;
        if (correct[q.id]) ok++;
      }
    });
    return {
      total: questions.length,
      answered: answered,
      correct: ok,
      rate: answered ? ok / answered : 0
    };
  }

  /** 整册统计（同样只认现存题目），chapters 为空时返回 0 */
  function bankProgress(s, bank) {
    var all = s.Progress.all();
    var answered = 0, ok = 0;
    ((bank && bank.chapters) || []).forEach(function (ch) {
      var p = all[ch.id] || {};
      var seen = p.seen || {}, correct = p.correct || {};
      (ch.questions || []).forEach(function (q) {
        if (seen[q.id]) {
          answered++;
          if (correct[q.id]) ok++;
        }
      });
    });
    return { answered: answered, correct: ok, rate: answered ? ok / answered : 0 };
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
      var st = chapterProgress(state.store, ch);
      /* 只有整章每道题都练过才算「完成」，完成前不显示正确率（样本不完整会误导） */
      var done = count > 0 && st.answered >= count;
      var meta = count + ' 题';
      if (done) {
        meta += ' · 已练 ' + st.answered + ' · 正确率 ' + Math.round(st.rate * 100) + '%';
      } else if (st.answered > 0) {
        meta += ' · 已练 ' + st.answered + ' · 未完成';
      }
      return '' +
        '<button class="chapter-item" type="button" data-chapter="' + esc(ch.id) + '">' +
          '<span class="chapter-main">' +
            '<span class="chapter-name">' + esc(ch.title) + '</span>' +
            '<span class="chapter-meta">' + meta + '</span>' +
          '</span>' +
          chapterRing(st, done) +
          '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"></path></svg>' +
        '</button>';
    }).join('');
  }

  /* ------------------------------------------------------ 章节模式：刷题/阅读 */
  function positionModeThumb() {
    var sw = $('modeSwitch');
    if (!sw) return;
    var on = sw.querySelector('.mode-opt.is-on');
    var thumb = sw.querySelector('.mode-thumb');
    if (!on || !thumb) return;
    /* 视图隐藏（.view 非 is-active 时 display:none）量到的宽度是 0。
       此时绝不能写进去，否则回到首页会看到宽度为 0 的滑块，也就是「按钮消失」。 */
    if (!on.offsetWidth) return;
    thumb.style.width = on.offsetWidth + 'px';
    thumb.style.transform = 'translateX(' + (on.offsetLeft - 3) + 'px)';
  }

  /**
   * 应用章节模式。animate=false 用于首屏（不加滑动动画，避免从 0 宽度滑入）。
   * 只影响「点章节」的去向，错题集与打乱刷题不受影响。
   */
  function applySectionMode(mode, animate) {
    state.sectionMode = mode === 'read' ? 'read' : 'practice';
    var sw = $('modeSwitch');
    if (!sw) return;
    sw.setAttribute('data-mode', state.sectionMode);

    var opts = sw.querySelectorAll('.mode-opt');
    for (var i = 0; i < opts.length; i++) {
      var on = opts[i].getAttribute('data-mode') === state.sectionMode;
      opts[i].classList.toggle('is-on', on);
      opts[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }

    if (!animate) {
      sw.classList.add('no-anim');
      positionModeThumb();
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { sw.classList.remove('no-anim'); });
      });
    } else {
      positionModeThumb();
    }
  }

  /**
   * 章节模式切换。只做两件必要的事：更新开关 UI、写入缓存。
   * **不重建章节列表** —— 列表内容与模式无关（只影响点章节的去向），
   * 重建只会让同样的内容从透明状态重播一遍入场动画，视觉上就是"闪一下"。
   */
  function setSectionMode(mode) {
    applySectionMode(mode, true);
    Store.SectionMode.set(state.sectionMode);
  }

  /** 阅读模式：把整章题目按顺序铺成一篇可滚动的文档 */
  function openRead(ch) {
    if (!ch) return;
    var questions = ch.questions || [];
    if (!questions.length) { toast('该章节暂无题目'); return; }

    var counts = state.store.Stats.all();
    var wrongIds = {};
    state.store.Wrong.all().forEach(function (w) { wrongIds[w.id] = true; });

    $('readTitle').textContent = ch.title;
    $('readSub').textContent = '共 ' + questions.length + ' 题 · 阅读模式';
    $('readRight').textContent = '';

    $('readList').innerHTML = questions.map(function (q, i) {
      var times = counts[q.id] || 0;
      var isWrongSet = !!wrongIds[q.id];
      var yes = q.answer === '正确';
      var delay = Math.min(i * 26, 420);
      return '<article class="read-item" style="animation-delay:' + delay + 'ms">' +
          '<div class="read-top">' +
            '<span class="read-no">' + pad2(i + 1) + '</span>' +
            /* 两个徽标都靠右，顺序为「已在错题集」→「已答对 N 次」；
               右对齐 + auto 左边距，所以答对次数永远贴着右边缘，
               错题标记只是往左伸出一截，不会推动它 */
            '<span class="read-flags">' +
              (isWrongSet ? '<span class="read-badge is-wrongset">已在错题集</span>' : '') +
              '<span class="read-badge is-times">已答对 ' + times + ' 次</span>' +
            '</span>' +
          '</div>' +
          '<p class="read-stem">' + esc(q.stem) + '</p>' +
          '<span class="read-answer ' + (yes ? 'is-yes' : 'is-no') + '">' +
            '答案 · ' + esc(q.answer) + '</span>' +
          (q.explanation
            ? '<p class="read-expl">' + esc(q.explanation) + '</p>'
            : '<p class="read-expl is-empty">暂无解析</p>') +
        '</article>';
    }).join('');

    showView('read');
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /**
   * 章节进度环。
   * - 未练过：空环 + 「未练」
   * - 练过但没练完：空环（不画进度）+ 中心显示「x/y」，避免用不完整的样本算正确率
   * - 整章练完：按正确率画环
   */
  function chapterRing(st, done) {
    if (!st.answered) {
      return '<span class="chapter-ring is-empty">' +
        '<svg viewBox="0 0 42 42"><circle class="cr-bg" cx="21" cy="21" r="17"></circle></svg>' +
        '<span class="cr-text">未练</span></span>';
    }
    if (!done) {
      return '<span class="chapter-ring is-empty">' +
        '<svg viewBox="0 0 42 42"><circle class="cr-bg" cx="21" cy="21" r="17"></circle></svg>' +
        '<span class="cr-text">未完成</span></span>';
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

  /**
   * 错题集练习：从错题集里随机抽一组。
   * - size 为空或大于池子 → 全部
   * - used 传入时表示「下一组」：跳过已经练过的题
   */
  function startWrongGroup(size, used) {
    var list = state.store.Wrong.all();
    var pool = used ? list.filter(function (q) { return !used.has(q.id); }) : list;
    if (!pool.length) { toast('错题集里的题都练过了'); return; }

    var n = Math.min(size || pool.length, pool.length);
    var picked = clip(shuffle(pool), n);
    var set = used || new Set();
    picked.forEach(function (q) { set.add(q.id); });

    startSession({
      mode: 'wrong',
      title: '错题集 · ' + picked.length + ' 题',
      questions: picked,
      shuffle: { size: n, used: set }
    });

    if (used) {
      toast(pool.length > picked.length
        ? '下一组 ' + picked.length + ' 题（还剩 ' + (pool.length - picked.length) + ' 题）'
        : '最后一组，错题集已经都练过了');
    }
  }

  /** 错题集里还没出过的题（用于结果页「下一组」） */
  function wrongRemaining(s) {
    if (!s || s.mode !== 'wrong' || !s.shuffle) return [];
    var used = s.shuffle.used;
    return state.store.Wrong.all().filter(function (q) { return !used.has(q.id); });
  }

  /**
   * 错题集题量弹窗：档位按错题总数动态生成
   * —— 5 / 10 / 20 里小于总数的才出现，最后固定有一个「全部 N 题」。
   */
  function openWrongPickModal() {
    var total = state.store.Wrong.count();
    if (!total) { toast('错题集为空'); return; }

    var tips = { 5: '快速热身', 10: '一组常规练习', 20: '一组强化练习' };
    var html = [5, 10, 20].filter(function (n) { return n < total; }).map(function (n) {
      return '<button class="modal-opt" data-count="' + n + '" type="button">' +
        '<span>' + n + ' 题</span><em>' + tips[n] + '</em></button>';
    }).join('');
    html += '<button class="modal-opt" data-count="' + total + '" type="button">' +
      '<span>全部 ' + total + ' 题</span><em>一次刷完</em></button>';

    $('wrongPickOptions').innerHTML = html;
    $('wrongPickSub').textContent = bankTitle() + ' · 共 ' + total + ' 题';
    $('wrongPickModal').hidden = false;
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

  /* -------------------------------------------------- 打乱刷题：续刷上次 */

  /** 题库里还没出过的题（按 id 数组过滤，供「继续上次」估剩余量） */
  function unpickedQuestions(usedIds) {
    var used = {};
    (usedIds || []).forEach(function (id) { used[id] = 1; });
    return allQuestions().filter(function (q) { return !used[q.id]; });
  }

  /** 弹窗顶部「继续上次」：有进度、且题库里确实还有题时才显示 */
  function renderResumeCard() {
    var card = $('btnResumeShuffle');
    if (!card) return;
    var prog = state.store.Shuffle.get();
    var left = prog ? unpickedQuestions(prog.used) : [];
    if (!prog || !left.length) {
      state.resumeProgress = null;
      card.hidden = true;
      return;
    }
    state.resumeProgress = prog;
    $('resumeDesc').textContent = '已完成 ' + prog.rounds + ' 组 · 每组 ' + prog.size +
      ' 题 · 还剩 ' + left.length + ' 题';
    card.hidden = false;
  }

  function openShuffleModal() {
    /* 勾选状态记住上次的选择（本机偏好，不参与云同步），默认勾选 */
    $('optPriority').checked = Store.ShufflePriority.get();
    renderResumeCard();
    $('shuffleModal').hidden = false;
  }

  /** 接着上次的序列再抽一组（沿用原来的每组题量与「已出过」的题） */
  function resumeShuffle() {
    var prog = state.resumeProgress;
    if (!prog) return;
    var left = unpickedQuestions(prog.used);
    if (!left.length) { toast('上次的题目已经刷完了'); return; }

    var used = new Set();
    prog.used.forEach(function (id) { used.add(id); });
    var priority = Store.ShufflePriority.get();
    var take = Math.min(prog.size, left.length);
    var picked = pickQuestions(left, take, priority);
    picked.forEach(function (q) { used.add(q.id); });

    startSession({
      mode: 'random',
      title: '打乱刷题 · ' + picked.length + ' 题',
      questions: picked,
      shuffle: { size: prog.size, used: used, priority: priority, rounds: prog.rounds + 1 }
    });
    toast('继续上次：第 ' + (prog.rounds + 1) + ' 组，' + picked.length + ' 题');
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
      shuffle: {
        size: size, used: used, priority: priority,
        rounds: (s.shuffle.rounds || 1) + 1
      }
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

    /* 这一组全部答完才落库 + 同步一次；中途退出不写任何数据 */
    if (allAnswered(s) && commitSession(s)) requestSync(true);

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
  /**
   * 结果页的动作按钮。
   * 单独抽出来是因为「移除答对的题」之后要**原地刷新这一块**，
   * 不退出结果页、不重建整页（否则又会出现内容闪一下）。
   */
  function renderResultActions() {
    var s = state.session;
    if (!s) return;
    var actions = $('resultActions');

    var wrongOnes = [];
    s.questions.forEach(function (q, i) {
      var a = s.answers[i];
      if (a && a.choice !== q.answer) wrongOnes.push(q);
    });
    var correctOnes = s.questions.filter(function (q, i) {
      var a = s.answers[i];
      return a && a.choice === q.answer;
    });

    var html = '';

    if (s.mode === 'wrong') {
      /* 本次只抽了一部分时，给出「下一组」（跳过本组已练过的题） */
      var wrongLeft = wrongRemaining(s);
      if (wrongLeft.length) {
        html += '<button class="btn btn-ghost" type="button" data-act="next-wrong">' +
          '下一组（还剩 ' + wrongLeft.length + ' 题）</button>';
      }
      html += '<button class="btn btn-primary" type="button" data-act="back-wrong">返回错题集</button>';
      if (s.pruned) {
        /* 已移除过：按钮变状态位，避免重复点击 */
        html += '<button class="btn btn-soft" type="button" disabled>已移除 ' + s.pruned + ' 题</button>';
      } else {
        html += '<button class="btn btn-soft" type="button" data-act="prune"' +
          (correctOnes.length ? '' : ' disabled') + '>将答对的 ' + correctOnes.length +
          ' 题移出错题集</button>';
      }
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
  }

  /* ------------------------------------------------- 100% 正确率的彩带 */
  /**
   * 把彩带画布贴到「正确率圆环 → 提示文字」这一块上，从左右下角各放一发礼炮。
   * 只在正确率 100% 时调用（效果见 js/confetti.js）。
   */
  function celebrate() {
    if (!window.ZZLLConfetti) return;
    var wrap = document.querySelector('#view-result .result-wrap');
    var canvas = $('confetti');
    var ring = wrap && wrap.querySelector('.result-ring');
    var hint = $('resultHint');
    if (!wrap || !canvas || !ring || !hint) return;

    var top = ring.offsetTop - 10;                         /* 圆环上方留一点余量 */
    var fireDocY = hint.offsetTop + hint.offsetHeight;     /* 炮口落在提示文字下沿 */
    var bottom = fireDocY + 90;                            /* 再往下留出下落空间 */

    canvas.style.left = '0px';
    canvas.style.top = top + 'px';
    canvas.style.width = wrap.clientWidth + 'px';
    canvas.style.height = (bottom - top) + 'px';

    window.ZZLLConfetti.fire(canvas, fireDocY - top);
  }

  function finishSession() {
    var s = state.session;
    /* 兜底：正常路径在「答完最后一题」时就已落库，这里防重复 */
    if (commitSession(s)) requestSync(true);
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
    renderResultActions();

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
    /* 满分才放彩带；延后一点，等圆环画完再炸 */
    if (total > 0 && rate === 1) setTimeout(celebrate, 260);
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
    $('btnWrongClear').disabled = list.length === 0;

    if (!list.length) {
      $('wrongList').innerHTML =
        '<div class="empty-state">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M12 3.5 20 7v5.2c0 4.4-3.2 7.4-8 8.3-4.8-.9-8-3.9-8-8.3V7l8-3.5Z"></path>' +
            '<path d="M9.2 12.2l2 2 3.6-3.9"></path></svg>' +
          '<p class="empty-title">「' + esc(bankTitle()) + '」的错题集还是空的</p>' +
          '<p class="empty-desc">刷完后在结果页点「加入错题集」，<br>或用右上角「同步」在设备之间搬运数据。</p>' +
        '</div>';
      return;
    }

    $('wrongList').innerHTML = list.map(function (q) {
      return wrongItemHTML(q, true);
    }).join('');
  }

  /* --------------------------------------------------------------- 数据同步 */
  var Sync = window.ZZLLSync;

  function syncTimeText(ts) {
    if (!ts) return '从未同步';
    var d = new Date(ts);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function renderSyncStatus() {
    var el = $('syncStatus');
    if (!el) return;
    var cfg = Sync.config();
    var st = Sync.state();
    if (!cfg.gistId || !cfg.token) {
      el.textContent = '尚未配置：填写 Gist ID 与访问令牌后可云同步';
      el.className = 'sync-status';
      return;
    }
    if (st.lastError) {
      el.textContent = '上次同步失败：' + st.lastError + '（继续使用本地数据）';
      el.className = 'sync-status is-error';
      return;
    }
    if (!st.lastSyncAt) {
      el.textContent = '已配置，尚未同步过';
      el.className = 'sync-status';
      return;
    }
    el.textContent = '上次同步：' + syncTimeText(st.lastSyncAt);
    el.className = 'sync-status is-ok';
  }

  function fillSyncForm() {
    var cfg = Sync.config();
    $('syncGist').value = cfg.gistId;
    $('syncToken').value = cfg.token;
    $('syncFilename').value = cfg.filename;
    $('syncAuto').checked = cfg.autoSync;
    renderSyncStatus();
  }

  function openSyncModal() {
    fillSyncForm();
    var wrap = $('syncPasteWrap');
    if (wrap) { wrap.hidden = true; }
    var box = $('syncPasteBox');
    if (box) box.value = '';
    $('syncModal').hidden = false;
  }

  /** 表单 → 配置（失焦/操作前都落盘，避免用户没点保存就关窗丢配置） */
  function persistSyncForm() {
    Sync.saveConfig({
      gistId: $('syncGist').value.trim(),
      token: $('syncToken').value.trim(),
      /* 留空就用默认文件名（zzll-wutong.json），界面上不预填 */
      filename: $('syncFilename').value.trim(),
      autoSync: !!$('syncAuto').checked
    });
  }

  /** 同步把数据写回本地后刷新当前视图 */
  function refreshAfterSync() {
    if ($('view-wrong').classList.contains('is-active')) renderWrong();

    if ($('view-home').classList.contains('is-active')) renderHome();
    renderSyncStatus();
  }

  function setSyncBusy(busy, label) {
    $('btnSyncNow').disabled = busy;
    $('btnSyncTest').disabled = busy;
    $('btnSyncNow').textContent = busy ? (label || '同步中…') : '立即同步';
  }

  /* ------------------------------------------------------------ 同步气泡 */
  var bubbleTimer = null;

  /**
   * 页面下方的同步气泡：三种状态，不拦截点击，不打断操作。
   * kind: 'loading' | 'done' | 'error'
   */
  function showSyncBubble(kind, text) {
    var el = $('syncBubble');
    if (!el) return;
    clearTimeout(bubbleTimer);
    el.hidden = false;
    el.className = 'sync-bubble is-' + kind;
    document.body.classList.add('has-sync-bubble');

    var icon = $('syncBubbleIcon');
    if (kind === 'done') {
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
        'stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>';
    } else if (kind === 'error') {
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" ' +
        'stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v6"></path><path d="M12 17h.01"></path>' +
        '</svg>';
    } else {
      icon.innerHTML = '';   /* 转圈用 CSS 画 */
    }
    $('syncBubbleText').textContent = text;

    /* 同步中常驻；完成/失败自动消失（失败停留久一点，够看清原因） */
    if (kind !== 'loading') {
      bubbleTimer = setTimeout(hideSyncBubble, kind === 'error' ? 4200 : 1500);
    }
  }

  function hideSyncBubble() {
    var el = $('syncBubble');
    if (!el) return;
    clearTimeout(bubbleTimer);
    el.hidden = true;
    document.body.classList.remove('has-sync-bubble');
  }

  /**
   * 触发一次带气泡的同步。
   * auto=true 时要求「已配置 + 自动同步开着」，否则直接跳过（不打扰用户）。
   */
  function requestSync(auto) {
    if (!Sync || !Sync.configured()) return;
    if (auto && !Sync.config().autoSync) return;
    Sync.syncWithNotice().catch(function () { /* 失败已由气泡与状态条呈现 */ });
  }

  /**
   * 一组题目全部答完才落库并同步（用户要求）：
   * - 答题过程中只把答案放在内存（s.answers），不写 localStorage
   * - 中途退出/关页面 = 这一组数据整体丢弃，不会污染练习记录
   * - 错题集刷题不记录练习数据（不计答对次数），所以也不触发同步
   * 返回 true 表示这次真的写入了数据（需要同步一次）。
   */
  function commitSession(s) {
    if (!s || s.committed) return false;
    s.committed = true;
    if (s.mode === 'wrong') return false;

    var wrote = false;
    s.questions.forEach(function (q, i) {
      var a = s.answers[i];
      if (!a) return;
      var ok = a.choice === q.answer;
      state.store.Progress.record(q.chapterId, q.id, ok);
      if (ok) state.store.Stats.bump(q.id);
      wrote = true;
    });

    /* 打乱刷题：进度要在这里落库 —— 调用方会在 commitSession 之后立刻触发同步，
       放到 finishSession 里就晚了一步，推上去的快照不含本组 */
    if (s.mode === 'random' && s.shuffle) {
      var left = shuffleRemaining(s);
      if (left.length) {
        var ids = [];
        s.shuffle.used.forEach(function (id) { ids.push(id); });
        state.store.Shuffle.save(s.shuffle.size, ids, s.shuffle.rounds || 1);
      } else {
        state.store.Shuffle.clear();
      }
    }

    return wrote;
  }

  /** 一组题目是否已全部作答 */
  function allAnswered(s) {
    if (!s || !s.answers.length) return false;
    for (var i = 0; i < s.answers.length; i++) if (!s.answers[i]) return false;
    return true;
  }

  /* ------------------------------------------------------------- 事件绑定 */
  function bind() {
    /* 暗色模式切换 */
    $('themeBtn').addEventListener('click', toggleTheme);

    /* 窗口尺寸变化后重新贴合开关的 thumb（字体/换行可能改变按钮宽度） */
    window.addEventListener('resize', function () {
      positionModeThumb();
    });

    /* 比 window.resize 更准：开关自身尺寸真正变化时（视图隐藏→显示、
       字体加载完成、旋转屏幕）都会触发。配合 positionModeThumb 的零宽保护，
       隐藏期间量到 0 也不会把滑块写成 0 宽。 */
    if (window.ResizeObserver) {
      new ResizeObserver(function () { positionModeThumb(); }).observe($('modeSwitch'));
    }

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
      var answered = bankProgress(state.store, state.bank).answered;
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
      requestSync(true);
    });

    /* ---- 开发者选项：数据维护入口（后续调试功能都挂这里） ---- */
    $('btnDev').addEventListener('click', function () {
      $('devPruneResult').hidden = true;
      $('devPruneResult').textContent = '';
      $('devModal').hidden = false;
    });

    var devModal = $('devModal');
    devModal.addEventListener('click', function (e) {
      var hit = e.target.closest ? e.target.closest('[data-close]') : null;
      if (hit) devModal.hidden = true;
    });

    /* 手动清理失效记录：不点就永远不触发（启动时不再自动执行） */
    $('btnPrune').addEventListener('click', function () {
      var r = pruneAllBanks();
      var box = $('devPruneResult');
      box.hidden = false;

      if (r.blocked.length) {
        var bad = r.blocked[0];
        box.textContent = '已跳过「' + bad.name + '」：失效记录占 ' + bad.cut + '/' + bad.total +
          '（超过 30%），更像是题库题目 id 整体变了。为免误删整份记录，这次没有清理。';
        return;
      }

      var n = r.progress + r.stats + r.wrong + r.chapters;
      if (!n) {
        box.textContent = '没有需要清理的记录：现有记录都对应题库里还能找到的题目。';
        return;
      }
      var parts = [];
      if (r.progress) parts.push('章节进度 ' + r.progress + ' 条');
      if (r.stats) parts.push('答对次数 ' + r.stats + ' 条');
      if (r.wrong) parts.push('错题 ' + r.wrong + ' 条');
      if (r.chapters) parts.push('整章失效 ' + r.chapters + ' 个');
      box.textContent = '已清理：' + parts.join('、') + '。旧数据有备份，可在控制台恢复。';

      renderHome();
      requestSync(true);   /* 让云端也干净（未配置或关了自动同步则跳过） */
    });

    $('btnShuffle').addEventListener('click', openShuffleModal);

    /* 「继续上次」：接着上次的序列再抽一组 */
    $('btnResumeShuffle').addEventListener('click', function () {
      if (!state.resumeProgress) return;
      $('shuffleModal').hidden = true;
      resumeShuffle();
    });

    /* 勾一下记一下，不必等点「开始」才落盘 */
    $('optPriority').addEventListener('change', function () {
      Store.ShufflePriority.set(!!$('optPriority').checked);
    });

    /* 章节模式开关：刷题 / 阅读 */
    $('modeSwitch').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.mode-opt') : null;
      if (!b) return;
      if (b.getAttribute('data-mode') === state.sectionMode) return;
      setSectionMode(b.getAttribute('data-mode'));
    });

    /* 阅读模式：返回首页 */
    $('readBack').addEventListener('click', function () {
      renderHome();
      showView('home');
    });

    $('chapterList').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.chapter-item') : null;
      if (!btn) return;
      var cid = btn.getAttribute('data-chapter');
      var ch = (state.bank.chapters || []).filter(function (c) { return c.id === cid; })[0];
      if (!ch) return;
      /* 阅读模式只改「点章节」的去向，错题集/打乱刷题不受影响 */
      if (state.sectionMode === 'read') openRead(ch);
      else startChapter(ch);
    });

    /* 打乱刷题弹窗 */
    var modal = $('shuffleModal');
    modal.addEventListener('click', function (e) {
      /* 同样用 closest：遮罩和「取消」按钮本身有 data-close，
         但以后若在里面放图标，直接读 e.target 会点不中 */
      var closer = e.target.closest ? e.target.closest('[data-close]') : null;
      if (closer) {
        modal.hidden = true;
        return;
      }
      var opt = e.target.closest ? e.target.closest('.modal-opt') : null;
      if (!opt) return;
      var n = parseInt(opt.getAttribute('data-count'), 10);
      var priority = !!($('optPriority') && $('optPriority').checked);

      /* 选了新的题量 = 开一轮新的序列：上次没刷完的进度要先清掉，提前问一声 */
      if (state.resumeProgress) {
        var ok = window.confirm('开始新的打乱刷题会清空上次未完成的进度（已完成 ' +
          state.resumeProgress.rounds + ' 组），确定吗？');
        if (!ok) return;          /* 取消就留在弹窗里，不动进度 */
        state.store.Shuffle.clear();
        state.resumeProgress = null;
      }

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
        shuffle: { size: n, used: used, priority: priority, rounds: 1 }
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
          if (!window.confirm('这一组还没答完，退出后本次作答不会保存。\n确定要退出吗？')) return;
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

      if (act === 'next-wrong') {
        startWrongGroup(s.shuffle && s.shuffle.size, s.shuffle ? s.shuffle.used : null);
      } else if (act === 'add-wrong') {
        var wrongOnes = [];
        s.questions.forEach(function (q, i) {
          var a = s.answers[i];
          if (a && a.choice !== q.answer) wrongOnes.push(q);
        });
        /* 错题集只记题目 id，章节/题干/解析在渲染时从题库数据还原 */
        var res = state.store.Wrong.addMany(wrongOnes);
        s.addedToWrong = true;
        btn.disabled = true;
        btn.textContent = '已加入错题集';
        toast('已加入「' + bankTitle() + '」错题集：新增 ' + res.added + ' 题，已存在 ' + res.existed + ' 题');
        requestSync(true);   /* 错题增删是唯一需要同步的错题集操作 */
      } else if (act === 'prune') {
        var ids = [];
        s.questions.forEach(function (q, i) {
          var a = s.answers[i];
          if (a && a.choice === q.answer) ids.push(q.id);
        });
        var removed = state.store.Wrong.removeMany(ids);
        /* 留在结果页：只把这一排按钮原地刷新（按钮变「已移除 N 题」并禁用），
           让用户还能继续「下一组」或看下面的错题解析 */
        s.pruned = removed;
        renderResultActions();
        toast('已从「' + bankTitle() + '」错题集移除 ' + removed + ' 题');
        requestSync(true);
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
      openWrongPickModal();
    });

    /* 错题集题量弹窗（与打乱刷题弹窗同一套交互：点遮罩/取消关闭，点档位开始） */
    var wrongPick = $('wrongPickModal');
    wrongPick.addEventListener('click', function (e) {
      var closer = e.target.closest ? e.target.closest('[data-close]') : null;
      if (closer) { wrongPick.hidden = true; return; }
      var opt = e.target.closest ? e.target.closest('.modal-opt') : null;
      if (!opt) return;
      var n = parseInt(opt.getAttribute('data-count'), 10);
      wrongPick.hidden = true;
      startWrongGroup(n);
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
      $('btnWrongClear').disabled = left === 0;
      if (left === 0) renderWrong();
      toast('已移除');
      requestSync(true);
    });

    /* ---- 数据同步（入口只在首页右上角，错题集页不再重复放一个） ---- */
    $('syncBtn').addEventListener('click', openSyncModal);

    ['syncGist', 'syncToken', 'syncFilename'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        persistSyncForm();
        renderSyncStatus();
      });
    });

    $('syncAuto').addEventListener('change', persistSyncForm);

    $('syncModal').addEventListener('click', function (e) {
      /* 用 closest 而不是直接看 e.target：
         点 X 图标时 target 是内层 <path>/<svg>，本身没有 data-close，
         只有点到按钮边缘才关得掉（表现为「点好几下才有反应」）。 */
      var hit = e.target.closest ? e.target.closest('[data-close]') : null;
      if (hit) $('syncModal').hidden = true;
    });

    $('btnSyncNow').addEventListener('click', function () {
      persistSyncForm();
      if (!Sync.configured()) { toast('请先填写 Gist ID 与访问令牌'); return; }
      setSyncBusy(true);
      Sync.syncWithNotice().then(function () {
        setSyncBusy(false);
        refreshAfterSync();
      }, function () {
        setSyncBusy(false);
        renderSyncStatus();
        refreshAfterSync();
      });
    });

    $('btnSyncTest').addEventListener('click', function () {
      persistSyncForm();
      if (!Sync.configured()) { toast('请先填写 Gist ID 与访问令牌'); return; }
      setSyncBusy(true, '测试中…');
      Sync.testConnection().then(function (res) {
        setSyncBusy(false);
        toast(res.hasData
          ? '连接正常，云端已有数据（' + res.updatedAt + '）'
          : '连接正常，云端暂无数据，首次同步会上传');
        renderSyncStatus();
      }, function (err) {
        setSyncBusy(false);
        toast('连接失败：' + (err && err.message ? err.message : '未知错误'));
        renderSyncStatus();
      });
    });

    $('btnSyncCopy').addEventListener('click', function () {
      Sync.copyToClipboard(Sync.exportText()).then(function () {
        toast('已复制同步数据，可在另一台设备「粘贴并导入」');
      }, function (err) {
        toast('复制失败：' + (err && err.message ? err.message : '浏览器不允许'));
      });
    });

    $('btnSyncPaste').addEventListener('click', function () {
      Sync.readClipboard().then(function (text) {
        doImportText(text);
      }, function () {
        toast('浏览器不允许读取剪贴板，请手动粘贴后点「导入这段数据」');
        var wrap = $('syncPasteWrap');
        if (wrap) { wrap.hidden = false; $('syncPasteBox').focus(); }
      });
    });

    var pasteBox = $('syncPasteBox');
    if (pasteBox) {
      $('btnSyncPasteGo').addEventListener('click', function () {
        doImportText(pasteBox.value);
      });
    }

    function doImportText(text) {
      try {
        var res = Sync.importText(text);
        $('syncModal').hidden = true;
        var wrap = $('syncPasteWrap');
        if (wrap) { wrap.hidden = true; }
        if (pasteBox) pasteBox.value = '';
        renderHome();
        if ($('view-wrong').classList.contains('is-active')) renderWrong();
        toast('已导入 ' + res.banks + ' 个题库的数据，错题共 ' + res.wrong + ' 题');
        /* 手动导入后立刻推到云端（不要求自动同步开关） */
        requestSync(false);
      } catch (err) {
        toast('导入失败：' + (err && err.message ? err.message : '数据格式不正确'));
      }
    }

    $('btnWrongClear').addEventListener('click', function () {
      if (!state.store.Wrong.count()) return;
      if (!window.confirm('确定要清空「' + bankTitle() + '」错题集（' +
        state.store.Wrong.count() + ' 题）吗？此操作不可撤销。')) return;
      state.store.Wrong.clear();
      renderWrong();
      toast('「' + bankTitle() + '」错题集已清空');
      requestSync(true);
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
  /** 题库数据是否真的可用：当前题库存在、有章节、且每章都有题目 */
  function bankDataReady(bank) {
    bank = bank || state.bank;
    if (!bank || !bank.chapters || !bank.chapters.length) return false;
    for (var i = 0; i < bank.chapters.length; i++) {
      if (!bank.chapters[i].questions || !bank.chapters[i].questions.length) return false;
    }
    return true;
  }

  /**
   * 清掉「题库里已经不存在的题目」留下的记录（进度 / 答对次数 / 错题集）。
   * 只在开发者选项里手动触发：题库更新删题或改 id 后这些旧 id 会一直堆着，
   * 既让统计虚高，也让同步载荷变大。
   * 只对数据完整的题库动手：题库没加载好时宁可不清理，避免把数据全删了。
   * 返回各项删除条数。
   */
  function pruneAllBanks() {
    var total = { progress: 0, stats: 0, wrong: 0, chapters: 0, blocked: [] };
    (state.banks || []).forEach(function (b) {
      if (!bankDataReady(b)) return;
      var r = null;
      try {
        r = Store.forBank(b.id).prune(b);
      } catch (e) { r = null; }
      if (!r) return;
      if (r.blocked) {
        total.blocked.push({ id: b.id, name: b.name, cut: r.cut, total: r.total });
        return;
      }
      total.progress += r.progress;
      total.stats += r.stats;
      total.wrong += r.wrong;
      total.chapters += r.chapters;
    });
    return total;
  }

  /**
   * 撤掉启动遮罩的时机 = 题库数据就绪 + （配置了同步时）首次同步有结果 + 首页绘制完成。
   * - 数据没就绪时短暂轮询（最多 ~3s），超时也放行
   * - 有同步配置时等这一次同步结束（成功或失败都算结束），最长等 6s，避免网络差时卡死
   * - 双 rAF 等一帧，确保 renderHome() 的结果真的画上屏了
   */
  function finishBoot() {
    var tries = 0;
    var fired = false;
    function go() {
      if (fired) return;
      fired = true;
      state.booting = false;
      /* 启动同步可能刚把云端数据写回本地，而首页是同步前渲染的。
         必须先按最新数据重绘（章节进度 / 正确率 / 错题数），再撤遮罩，
         否则用户会看到同步前的旧数据，得手动刷新才更新。 */
      if (state.bootSyncEvent) refreshAfterSync();
      if (window.hideBoot) window.hideBoot();
      /* 启动那次同步的结果，进入页面后再补一条通知 */
      if (state.bootSyncEvent) {
        var ev = state.bootSyncEvent;
        state.bootSyncEvent = null;
        if (ev.action === 'error') {
          showSyncBubble('error', '同步失败：' + (ev.error && ev.error.message ? ev.error.message : '未知错误'));
        } else if (ev.action === 'done') {
          showSyncBubble('done', '同步完成');
        }
      }
    }
    function ready() {
      requestAnimationFrame(function () { requestAnimationFrame(go); });
      setTimeout(go, 150);
    }
    (function wait() {
      if (!bankDataReady() && tries++ < 60) { setTimeout(wait, 50); return; }
      var p = Sync ? Sync.bootSync() : null;
      if (!p) { ready(); return; }
      var guard = new Promise(function (resolve) { setTimeout(resolve, 6000); });
      Promise.race([p.catch(function () {}), guard]).then(ready);
    })();
  }

  function boot() {
    state.banks = loadBanks();
    useBank(Store.Banks.selected());
    /* 旧版本只有一个题库，错题集/进度存在无题库维度的 key 里，搬到超格名下。
       存储读取是懒加载的，这里搬完就可以直接渲染。 */
    Store.Banks.migrateLegacy();
    /* 章节模式：读缓存（默认刷题），首屏不加滑动动画 */
    applySectionMode(Store.SectionMode.get(), false);
    renderThemeBtn();
    syncThemeColor();
    watchSystemTheme();
    bind();
    renderHome();
    /* 同步层：启动同步在 finishBoot 里等结果；这里只订阅气泡事件 */
    if (Sync) {
      Sync.init();
      Sync.subscribe(function (ev) {
        if (ev.action === 'start') {
          /* 加载页阶段也提示（气泡层级高于遮罩），保证「所有同步都有通知」 */
          showSyncBubble('loading', '正在同步…');
          return;
        }
        if (state.booting) {
          /* 启动同步：先把结果记下来，进页面后补一条通知 */
          state.bootSyncEvent = ev;
          return;
        }
        if (ev.action === 'error') {
          showSyncBubble('error', '同步失败：' + (ev.error && ev.error.message ? ev.error.message : '未知错误'));
        } else {
          showSyncBubble('done', '同步完成');
        }
        renderSyncStatus();
        if (ev.action !== 'error') refreshAfterSync();
      });
      renderSyncStatus();
    }
    /* 题库数据就绪 + 首次同步有结果后，才撤掉启动遮罩 */
    finishBoot();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

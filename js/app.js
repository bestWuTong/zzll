/* ==========================================================================
   政治理论排坑速练 — 应用逻辑
   视图：home（首页）/ wrong（错题集）/ quiz（刷题）/ result（结果）
   模式：chapter（章节练习）/ random（打乱刷题）/ wrong（错题集练习）
   ========================================================================== */

(function () {
  'use strict';

  var Store = window.ZZLLStore;
  var Wrong = Store.Wrong;
  var Progress = Store.Progress;

  var DATA = window.QUESTIONS_DATA || { chapters: [] };
  var CHAPTERS = Array.isArray(DATA.chapters) ? DATA.chapters : [];
  var RING_CIRC = 326.7;   /* 2πr, r = 52 */

  var state = { session: null, toastTimer: null };

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

  function allQuestions() {
    var out = [];
    CHAPTERS.forEach(function (ch) {
      (ch.questions || []).forEach(function (q) {
        out.push({
          id: q.id, no: q.no, stem: q.stem,
          answer: q.answer, answerText: q.answerText,
          explanation: q.explanation,
          chapterId: ch.id, chapterTitle: ch.title
        });
      });
    });
    return out;
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
    toTop();
  }

  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    el.style.animation = 'none';
    /* 强制重排以重播动画 */
    void el.offsetWidth;
    el.style.animation = '';
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () { el.hidden = true; }, 2200);
  }

  /* -------------------------------------------------------------- 首页渲染 */
  function renderHome() {
    var total = DATA.meta && DATA.meta.totalQuestions
      ? DATA.meta.totalQuestions
      : allQuestions().length;
    var wrongCount = Wrong.count();
    var overall = Progress.overall();

    var stats = [
      '题库 <b>' + total + '</b> 题',
      '<b>' + CHAPTERS.length + '</b> 个章节'
    ];
    if (overall.answered > 0) {
      stats.push('已练 <b>' + overall.answered + '</b> 题');
      stats.push('正确率 <b>' + Math.round(overall.rate * 100) + '%</b>');
    }
    $('homeStats').innerHTML = stats.map(function (s) {
      return '<span>' + s + '</span>';
    }).join('');

    $('wrongCountText').textContent = wrongCount + ' 题';
    $('modalAllLabel').textContent = '所有题目（' + total + ' 题）';

    if (!CHAPTERS.length) {
      $('chapterList').innerHTML =
        '<div class="empty-state"><p class="empty-title">尚未加载题库</p>' +
        '<p class="empty-desc">请先运行 <code>python scripts/parse_questions.py</code> 生成题库数据。</p></div>';
      return;
    }

    $('chapterList').innerHTML = CHAPTERS.map(function (ch) {
      var count = (ch.questions || []).length;
      var st = Progress.chapterStats(ch.id);
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

    $('footMeta').textContent = (DATA.meta && DATA.meta.generatedAt)
      ? '题库更新于 ' + DATA.meta.generatedAt
      : '';
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
  function startSession(opts) {
    state.session = {
      mode: opts.mode,
      title: opts.title,
      questions: opts.questions,
      index: 0,
      answers: opts.questions.map(function () { return null; }),
      addedToWrong: false
    };
    showView('quiz');
    renderQuestion();
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

  /** 刷新顶部比分与进度条（作答 / 翻页后都要同步） */
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
    void el.offsetWidth;          /* 强制重排以重播动画 */
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
        '<div class="fb-meta">正确答案：<b>' + esc(q.answerText) + '</b></div>' +
        explHTML;
    } else {
      fb.className = 'feedback is-wrong';
      fb.innerHTML =
        '<div class="fb-head">' + icon + '<span>回答错误</span></div>' +
        '<div class="fb-meta">你的选择：<b>' + esc(choice === 'A' ? '正确' : '错误') +
          '</b> · 正确答案：<b>' + esc(q.answerText) + '</b></div>' +
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

    Progress.record(q.chapterId, q.id, correct);

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

    /* 本次答错的题 */
    var wrongOnes = [];
    s.questions.forEach(function (q, i) {
      var a = s.answers[i];
      if (a && a.choice !== q.answer) wrongOnes.push(q);
    });
    var correctOnes = s.questions.filter(function (q, i) {
      var a = s.answers[i];
      return a && a.choice === q.answer;
    });

    /* 按钮 */
    var actions = $('resultActions');
    var html = '';

    if (s.mode === 'wrong') {
      html += '<button class="btn btn-primary" type="button" data-act="back-wrong">返回错题集</button>';
      html += '<button class="btn btn-soft" type="button" data-act="prune"' +
        (correctOnes.length ? '' : ' disabled') + '>将答对的 ' + correctOnes.length +
        ' 题移出错题集</button>';
    } else {
      var already = s.addedToWrong;
      html += '<button class="btn btn-primary" type="button" data-act="add-wrong"' +
        (wrongOnes.length && !already ? '' : ' disabled') + '>' +
        (already ? '已加入错题集' :
          (wrongOnes.length ? '把错题 ' + wrongOnes.length + ' 题加入错题集' : '本次无错题')) +
        '</button>';
      html += '<button class="btn btn-ghost" type="button" data-act="home">返回首页</button>';
    }
    actions.innerHTML = html;

    /* 复盘列表 */
    var review = '';
    if (wrongOnes.length) {
      review = '<h3 class="review-title">本次答错的 ' + wrongOnes.length + ' 题</h3>' +
        '<div class="wrong-list">' + wrongOnes.map(function (q) {
          return wrongItemHTML(q, false);
        }).join('') + '</div>';
    }
    $('resultReview').innerHTML = review;

    showView('result');
    /* 环形进度动画 */
    setTimeout(function () {
      ring.style.strokeDashoffset = (RING_CIRC * (1 - rate)).toFixed(1);
    }, 60);
  }

  /* ------------------------------------------------------------- 错题集页面 */
  function wrongItemHTML(q, withRemove) {
    var isTrue = q.answer === 'A';
    var removeBtn = withRemove
      ? '<button class="remove-btn" type="button" data-remove="' + esc(q.id) + '">移除</button>'
      : '';
    return '' +
      '<article class="wrong-item" data-id="' + esc(q.id) + '">' +
        '<div class="wrong-top">' +
          (q.chapterTitle ? '<span class="wrong-tag">' + esc(q.chapterTitle) + '</span>' : '') +
          '<span class="wrong-spacer"></span>' +
          removeBtn +
        '</div>' +
        '<p class="wrong-stem">' + esc(q.stem) + '</p>' +
        '<span class="wrong-answer ' + (isTrue ? 'is-true' : 'is-false') + '">正确答案：' +
          esc(q.answerText || (isTrue ? '正确' : '错误')) + '</span>' +
        '<div class="wrong-expl">' + esc(q.explanation || '本题暂无解析') + '</div>' +
      '</article>';
  }

  function renderWrong() {
    var list = Wrong.all();
    $('wrongSub').textContent = '共 ' + list.length + ' 题';
    $('btnWrongStart').disabled = list.length === 0;
    $('btnWrongExport').disabled = list.length === 0;
    $('btnWrongClear').disabled = list.length === 0;

    if (!list.length) {
      $('wrongList').innerHTML =
        '<div class="empty-state">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M12 3.5 20 7v5.2c0 4.4-3.2 7.4-8 8.3-4.8-.9-8-3.9-8-8.3V7l8-3.5Z"></path>' +
            '<path d="M9.2 12.2l2 2 3.6-3.9"></path></svg>' +
          '<p class="empty-title">错题集还是空的</p>' +
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
        var res = Wrong.importPayload(payload);
        renderWrong();
        toast('导入完成：新增 ' + res.added + ' 题，已存在 ' + res.existed + ' 题');
      } catch (err) {
        toast('导入失败：' + (err && err.message ? err.message : '文件格式不正确'));
      }
    };
    reader.onerror = function () { toast('导入失败：无法读取文件'); };
    reader.readAsText(file, 'utf-8');
  }

  /* ------------------------------------------------------------- 事件绑定 */
  function bind() {
    /* 首页 */
    $('btnGoWrong').addEventListener('click', function () {
      renderWrong();
      showView('wrong');
    });

    $('btnShuffle').addEventListener('click', function () {
      $('shuffleModal').hidden = false;
    });

    $('chapterList').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.chapter-item') : null;
      if (!btn) return;
      var cid = btn.getAttribute('data-chapter');
      var ch = CHAPTERS.filter(function (c) { return c.id === cid; })[0];
      if (!ch) return;
      var qs = (ch.questions || []).map(function (q) {
        return {
          id: q.id, no: q.no, stem: q.stem, answer: q.answer,
          answerText: q.answerText, explanation: q.explanation,
          chapterId: ch.id, chapterTitle: ch.title
        };
      });
      if (!qs.length) { toast('该章节暂无题目'); return; }
      startSession({ mode: 'chapter', title: ch.title, questions: qs });
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
      modal.hidden = true;
      var pool = allQuestions();
      if (!pool.length) { toast('题库为空'); return; }
      var picked = clip(shuffle(pool), n);
      startSession({
        mode: 'random',
        title: n > 0 ? ('打乱刷题 · ' + picked.length + ' 题') : '打乱刷题 · 全部题目',
        questions: picked
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
        var res = Wrong.addMany(wrongOnes, function (q) {
          return { chapterId: q.chapterId, chapterTitle: q.chapterTitle };
        });
        s.addedToWrong = true;
        btn.disabled = true;
        btn.textContent = '已加入错题集';
        toast('已加入错题集：新增 ' + res.added + ' 题，已存在 ' + res.existed + ' 题');
      } else if (act === 'prune') {
        var ids = [];
        s.questions.forEach(function (q, i) {
          var a = s.answers[i];
          if (a && a.choice === q.answer) ids.push(q.id);
        });
        var removed = Wrong.removeMany(ids);
        toast('已从错题集移除 ' + removed + ' 题');
        state.session = null;
        renderWrong();
        showView('wrong');
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
      var list = Wrong.all();
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
      Wrong.remove(id);
      if (item && item.parentNode) item.parentNode.removeChild(item);
      var left = Wrong.count();
      $('wrongSub').textContent = '共 ' + left + ' 题';
      $('btnWrongStart').disabled = left === 0;
      $('btnWrongExport').disabled = left === 0;
      $('btnWrongClear').disabled = left === 0;
      if (left === 0) renderWrong();
      toast('已移除');
    });

    $('btnWrongExport').addEventListener('click', function () {
      if (!Wrong.count()) return;
      download('政治理论错题集_' + stamp() + '.json',
        JSON.stringify(Wrong.exportPayload(), null, 2));
      toast('已导出 ' + Wrong.count() + ' 题');
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
      if (!Wrong.count()) return;
      if (!window.confirm('确定要清空错题集（' + Wrong.count() + ' 题）吗？此操作不可撤销。')) return;
      Wrong.clear();
      renderWrong();
      toast('错题集已清空');
    });

    /* 键盘快捷键：← → 与 1 / 2 */
    document.addEventListener('keydown', function (e) {
      if (!$('view-quiz').classList.contains('is-active')) return;
      if (e.key === 'ArrowRight' || e.key === 'Enter') { goNext(); }
      else if (e.key === 'ArrowLeft') { goPrev(); }
      else if (e.key === '1') { chooseAnswer('A'); }
      else if (e.key === '2') { chooseAnswer('B'); }
    });
  }

  /* ---------------------------------------------------------------- 启动 */
  function boot() {
    if (!window.QUESTIONS_DATA) {
      /* 直接以 file:// 打开时若 questions.js 缺失，尝试拉取 JSON */
      if (window.fetch) {
        fetch('data/questions.json')
          .then(function (r) { return r.json(); })
          .then(function (json) {
            window.QUESTIONS_DATA = json;
            CHAPTERS = json.chapters || [];
            renderHome();
          })
          .catch(function () { renderHome(); });
      }
    }
    bind();
    renderHome();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

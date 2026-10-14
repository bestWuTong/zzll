/* ==========================================================================
   本地存储层：
   - Wrong    : 错题集（localStorage 持久化，支持导出 / 导入 JSON）
   - Progress : 各章节练习进度（已练题数、正确数）
   localStorage 不可用时自动降级为内存存储，页面功能不中断。
   ========================================================================== */

(function (global) {
  'use strict';

  var WRONG_KEY = 'zzll.wrong.v1';
  var PROGRESS_KEY = 'zzll.progress.v1';
  var EXPORT_TYPE = 'zzll-wrong';

  /* ------------------------------------------------------------- 存储适配层 */
  var memory = {};

  function storageGet(key) {
    try {
      var v = global.localStorage.getItem(key);
      return v === null ? (key in memory ? memory[key] : null) : v;
    } catch (e) {
      return key in memory ? memory[key] : null;
    }
  }

  function storageSet(key, value) {
    memory[key] = value;
    try {
      global.localStorage.setItem(key, value);
    } catch (e) {
      /* 隐私模式 / 配额不足：仅保存在内存中 */
    }
  }

  function readJSON(key, fallback) {
    var raw = storageGet(key);
    if (!raw) return fallback;
    try {
      var parsed = JSON.parse(raw);
      return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    storageSet(key, JSON.stringify(value));
  }

  /* ---------------------------------------------------------------- 错题集 */
  function normalize(q, chapterId, chapterTitle) {
    return {
      id: String(q.id || ''),
      no: q.no || 0,
      stem: String(q.stem || ''),
      answer: q.answer === 'A' ? 'A' : 'B',
      answerText: q.answer === 'A' ? '正确' : '错误',
      explanation: String(q.explanation || ''),
      chapterId: chapterId || q.chapterId || '',
      chapterTitle: chapterTitle || q.chapterTitle || ''
    };
  }

  var Wrong = {
    /** 全部错题（数组，按加入顺序，新的在后） */
    all: function () {
      var list = readJSON(WRONG_KEY, []);
      return Array.isArray(list) ? list : [];
    },

    count: function () {
      return this.all().length;
    },

    has: function (id) {
      return this.all().some(function (q) { return q.id === id; });
    },

    /** 加入一题，返回 true=新增 / false=已存在 */
    add: function (question, chapterId, chapterTitle) {
      var q = normalize(question, chapterId, chapterTitle);
      if (!q.id || !q.stem) return false;
      var list = this.all();
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === q.id) {
          /* 已存在：刷新题干与解析（题库更新后保持同步） */
          list[i] = q;
          writeJSON(WRONG_KEY, list);
          return false;
        }
      }
      list.push(q);
      writeJSON(WRONG_KEY, list);
      return true;
    },

    /** 批量加入，返回 { added, existed } */
    addMany: function (questions, chapterOf) {
      var list = this.all();
      var index = {};
      list.forEach(function (q) { index[q.id] = true; });
      var added = 0, existed = 0;
      questions.forEach(function (raw) {
        var ctx = chapterOf ? chapterOf(raw) : {};
        var q = normalize(raw, ctx.chapterId, ctx.chapterTitle);
        if (!q.id || !q.stem) return;
        if (index[q.id]) { existed++; return; }
        index[q.id] = true;
        list.push(q);
        added++;
      });
      writeJSON(WRONG_KEY, list);
      return { added: added, existed: existed };
    },

    /** 按 id 集合移除，返回移除数量 */
    removeMany: function (ids) {
      var set = {};
      ids.forEach(function (id) { set[id] = true; });
      var list = this.all();
      var kept = list.filter(function (q) { return !set[q.id]; });
      writeJSON(WRONG_KEY, kept);
      return list.length - kept.length;
    },

    remove: function (id) {
      var list = this.all();
      var kept = list.filter(function (q) { return q.id !== id; });
      writeJSON(WRONG_KEY, kept);
      return list.length !== kept.length;
    },

    clear: function () {
      writeJSON(WRONG_KEY, []);
    },

    /** 导出载荷 */
    exportPayload: function () {
      return {
        type: EXPORT_TYPE,
        version: 1,
        exportedAt: new Date().toISOString(),
        count: this.all().length,
        questions: this.all()
      };
    },

    /**
     * 导入。兼容三种格式：
     *  1) 本应用导出的 { type:'zzll-wrong', questions:[...] }
     *  2) 题库文件      { meta, chapters:[{ questions:[...] }] }
     *  3) 纯数组        [ {...}, {...} ]
     * 返回 { added, existed, total }
     */
    importPayload: function (payload) {
      var items = [];
      if (Array.isArray(payload)) {
        items = payload;
      } else if (payload && Array.isArray(payload.questions)) {
        items = payload.questions;
      } else if (payload && Array.isArray(payload.chapters)) {
        payload.chapters.forEach(function (ch) {
          (ch.questions || []).forEach(function (q) {
            items.push({
              id: q.id, no: q.no, stem: q.stem, answer: q.answer,
              answerText: q.answerText, explanation: q.explanation,
              chapterId: ch.id, chapterTitle: ch.title
            });
          });
        });
      } else if (payload && payload.meta && Array.isArray(payload.meta)) {
        items = payload.meta;
      } else {
        throw new Error('无法识别的 JSON 格式');
      }

      var valid = items.filter(function (q) { return q && q.stem && q.answer; });
      if (!valid.length) throw new Error('文件中没有可识别的题目');

      var res = this.addMany(valid, null);
      return { added: res.added, existed: res.existed, total: valid.length };
    }
  };

  /* ------------------------------------------------------------ 章节进度 */
  var Progress = {
    all: function () {
      var p = readJSON(PROGRESS_KEY, {});
      return p && typeof p === 'object' ? p : {};
    },

    /** 记录一次作答 */
    record: function (chapterId, questionId, correct) {
      if (!chapterId || !questionId) return;
      var all = this.all();
      var ch = all[chapterId] || { seen: {}, correct: {} };
      ch.seen[questionId] = 1;
      if (correct) ch.correct[questionId] = 1;
      else delete ch.correct[questionId];
      all[chapterId] = ch;
      writeJSON(PROGRESS_KEY, all);
    },

    /** 章节统计：{ answered, correct, rate } */
    chapterStats: function (chapterId) {
      var ch = this.all()[chapterId];
      if (!ch) return { answered: 0, correct: 0, rate: 0 };
      var answered = Object.keys(ch.seen || {}).length;
      var correct = Object.keys(ch.correct || {}).length;
      return {
        answered: answered,
        correct: correct,
        rate: answered ? correct / answered : 0
      };
    },

    overall: function () {
      var all = this.all();
      var answered = 0, correct = 0;
      Object.keys(all).forEach(function (k) {
        answered += Object.keys(all[k].seen || {}).length;
        correct += Object.keys(all[k].correct || {}).length;
      });
      return { answered: answered, correct: correct, rate: answered ? correct / answered : 0 };
    },

    reset: function () {
      writeJSON(PROGRESS_KEY, {});
    }
  };

  global.ZZLLStore = { Wrong: Wrong, Progress: Progress };
})(window);

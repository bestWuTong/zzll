/* ==========================================================================
   本地存储层（按题库隔离）
   - Banks    : 当前选中的题库（zzll.bank.v1）+ 旧数据一次性迁移
   - forBank(): 取某个题库的存储实例
       Wrong    错题集  zzll.wrong.<题库id>.v1
       Progress 进度    zzll.progress.<题库id>.v1
   localStorage 不可用时自动降级为内存存储，页面功能不中断。
   ========================================================================== */

(function (global) {
  'use strict';

  var BANK_KEY = 'zzll.bank.v1';
  var DEFAULT_BANK = 'chaoge';
  var EXPORT_TYPE = 'zzll-wrong';
  /* 旧版本只有一个题库，key 里没有题库维度 */
  var LEGACY_WRONG_KEY = 'zzll.wrong.v1';
  var LEGACY_PROGRESS_KEY = 'zzll.progress.v1';

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

  /* ------------------------------------------------------------ 答案归一化 */
  /* 题库数据里答案只有「正确」/「错误」两个值；
     这里兼容历史数据、旧导出文件里的 A/B、对/错、T/F 写法 */
  var ANSWER_ALIASES = {
    'A': '正确', 'B': '错误',
    '对': '正确', '错': '错误',
    'T': '正确', 'F': '错误'
  };

  function normalizeAnswer(value) {
    if (value === '正确' || value === '错误') return value;
    var s = String(value === null || value === undefined ? '' : value).trim();
    if (s === '正确' || s === '错误') return s;
    return ANSWER_ALIASES[s] || ANSWER_ALIASES[s.toUpperCase()] || null;
  }

  function normalize(q, chapterId, chapterTitle) {
    var answer = normalizeAnswer(q.answer) || '正确';
    return {
      id: String(q.id || ''),
      no: q.no || 0,
      stem: String(q.stem || ''),
      answer: answer,
      explanation: String(q.explanation || ''),
      chapterId: chapterId || q.chapterId || '',
      chapterTitle: chapterTitle || q.chapterTitle || ''
    };
  }

  /* ------------------------------------------------------- 单个题库的存储 */
  function createBankStore(bankId) {
    var wrongKey = 'zzll.wrong.' + bankId + '.v1';
    var progressKey = 'zzll.progress.' + bankId + '.v1';
    var correctKey = 'zzll.correct.' + bankId + '.v1';

    var Wrong = {
      key: wrongKey,

      all: function () {
        var list = readJSON(wrongKey, []);
        return Array.isArray(list) ? list : [];
      },

      count: function () {
        return this.all().length;
      },

      has: function (id) {
        return this.all().some(function (q) { return q.id === id; });
      },

      /** 加入一题，返回 true=新增 / false=已存在（已存在则刷新题干与解析） */
      add: function (question, chapterId, chapterTitle) {
        var q = normalize(question, chapterId, chapterTitle);
        if (!q.id || !q.stem) return false;
        var list = this.all();
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === q.id) {
            list[i] = q;
            writeJSON(wrongKey, list);
            return false;
          }
        }
        list.push(q);
        writeJSON(wrongKey, list);
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
        writeJSON(wrongKey, list);
        return { added: added, existed: existed };
      },

      removeMany: function (ids) {
        var set = {};
        ids.forEach(function (id) { set[id] = true; });
        var list = this.all();
        var kept = list.filter(function (q) { return !set[q.id]; });
        writeJSON(wrongKey, kept);
        return list.length - kept.length;
      },

      remove: function (id) {
        var list = this.all();
        var kept = list.filter(function (q) { return q.id !== id; });
        writeJSON(wrongKey, kept);
        return list.length !== kept.length;
      },

      clear: function () {
        writeJSON(wrongKey, []);
      },

      /** 导出载荷；bankInfo 用于标记来源题库 */
      exportPayload: function (bankInfo) {
        return {
          type: EXPORT_TYPE,
          version: 2,
          bank: bankInfo ? { id: bankInfo.id, name: bankInfo.name } : null,
          exportedAt: new Date().toISOString(),
          count: this.all().length,
          questions: this.all()
        };
      },

      /**
       * 导入。兼容：
       *  1) 本应用导出的 { type:'zzll-wrong', questions:[...] }
       *  2) 题库文件      { id/name/meta/chapters:[{ questions:[...] }] }
       *  3) 纯数组        [ {...}, {...} ]
       * 答案值为 A/B 的历史文件会自动归一化为 正确/错误。
       * 返回 { added, existed, total, fromBank }
       */
      importPayload: function (payload) {
        var items = [];
        var fromBank = null;

        if (Array.isArray(payload)) {
          items = payload;
        } else if (payload && Array.isArray(payload.questions)) {
          items = payload.questions;
          if (payload.bank && payload.bank.name) fromBank = payload.bank;
        } else if (payload && Array.isArray(payload.chapters)) {
          payload.chapters.forEach(function (ch) {
            (ch.questions || []).forEach(function (q) {
              items.push({
                id: q.id, no: q.no, stem: q.stem, answer: q.answer,
                explanation: q.explanation,
                chapterId: ch.id, chapterTitle: ch.title
              });
            });
          });
          if (payload.name || payload.shortName) {
            fromBank = { id: payload.id || '', name: payload.name || payload.shortName };
          }
        } else {
          throw new Error('无法识别的 JSON 格式');
        }

        var valid = items.filter(function (q) {
          return q && q.stem && normalizeAnswer(q.answer);
        });
        if (!valid.length) throw new Error('文件中没有可识别的题目');

        var res = this.addMany(valid, null);
        return { added: res.added, existed: res.existed, total: valid.length, fromBank: fromBank };
      }
    };

    var Progress = {
      key: progressKey,

      all: function () {
        var p = readJSON(progressKey, {});
        return p && typeof p === 'object' ? p : {};
      },

      record: function (chapterId, questionId, correct) {
        if (!chapterId || !questionId) return;
        var all = this.all();
        var ch = all[chapterId] || { seen: {}, correct: {} };
        ch.seen[questionId] = 1;
        if (correct) ch.correct[questionId] = 1;
        else delete ch.correct[questionId];
        all[chapterId] = ch;
        writeJSON(progressKey, all);
      },

      chapterStats: function (chapterId) {
        var ch = this.all()[chapterId];
        if (!ch) return { answered: 0, correct: 0, rate: 0 };
        var answered = Object.keys(ch.seen || {}).length;
        var correct = Object.keys(ch.correct || {}).length;
        return { answered: answered, correct: correct, rate: answered ? correct / answered : 0 };
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
        writeJSON(progressKey, {});
      }
    };

    /* 每题答对次数：{ <题目id>: 次数 }。
       用于「优先推送答对次数最少的题目」——次数越少说明越生疏。
       与 Progress（章节维度）分开存，因为它按题目累计，不含章节概念。 */
    var Stats = {
      key: correctKey,

      all: function () {
        var m = readJSON(correctKey, {});
        return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
      },

      get: function (questionId) {
        return this.all()[questionId] || 0;
      },

      bump: function (questionId) {
        if (!questionId) return;
        var m = this.all();
        m[questionId] = (m[questionId] || 0) + 1;
        writeJSON(correctKey, m);
      },

      reset: function () {
        writeJSON(correctKey, {});
      },

      /**
       * 一次性播种：老用户的进度里记着「哪些题答对过」，但没有次数。
       * 首次使用本功能时，把这些题按「答对 1 次」补进去，
       * 避免历史做过的题全被当成 0 次而优先推送一遍。
       * 已经初始化过（值存在，哪怕是空对象）就跳过。
       */
      seedFromProgress: function () {
        if (readJSON(correctKey, null) !== null) return false;
        var prog = Progress.all();
        var seed = {};
        Object.keys(prog).forEach(function (ch) {
          Object.keys(prog[ch].correct || {}).forEach(function (qid) {
            seed[qid] = 1;
          });
        });
        writeJSON(correctKey, seed);
        return true;
      }
    };

    return { bankId: bankId, Wrong: Wrong, Progress: Progress, Stats: Stats };
  }

  /* --------------------------------------------------------------- 题库选择 */
  var Banks = {
    defaultId: DEFAULT_BANK,

    selected: function () {
      return storageGet(BANK_KEY) || DEFAULT_BANK;
    },

    select: function (bankId) {
      storageSet(BANK_KEY, String(bankId));
    },

    /**
     * 旧版本只有超格一个题库，错题集/进度存在无题库维度的 key 里。
     * 首次运行时搬到超格名下（保留旧 key 作备份，不删除）。
     * 返回被迁移的旧 key 列表。
     */
    migrateLegacy: function () {
      var moved = [];
      var targetWrong = 'zzll.wrong.' + DEFAULT_BANK + '.v1';
      var targetProgress = 'zzll.progress.' + DEFAULT_BANK + '.v1';

      var legacyWrong = readJSON(LEGACY_WRONG_KEY, null);
      if (Array.isArray(legacyWrong) && legacyWrong.length && !storageGet(targetWrong)) {
        /* 顺手把历史 A/B 答案归一化成 正确/错误 */
        var normalized = legacyWrong.map(function (q) { return normalize(q); })
          .filter(function (q) { return q.id && q.stem; });
        writeJSON(targetWrong, normalized);
        moved.push(LEGACY_WRONG_KEY);
      }

      var legacyProgress = storageGet(LEGACY_PROGRESS_KEY);
      if (legacyProgress && !storageGet(targetProgress)) {
        storageSet(targetProgress, legacyProgress);
        moved.push(LEGACY_PROGRESS_KEY);
      }

      return moved;
    }
  };

  global.ZZLLStore = {
    forBank: createBankStore,
    Banks: Banks,
    normalizeAnswer: normalizeAnswer
  };
})(window);

/* ==========================================================================
   本地存储层（按题库隔离）
   - Banks    : 当前选中的题库（zzll.bank.v1）+ 旧数据一次性迁移
   - forBank(): 取某个题库的存储实例
       Wrong    错题集   zzll.wrong.<题库id>.v2  —— 只存题目 id，题干从题库数据还原
       Progress 进度     zzll.progress.<题库id>.v1
       Stats    答对次数 zzll.correct.<题库id>.v1
   - 业务写操作会派发 zzll:data-changed，同步层据此防抖推送
   localStorage 不可用时自动降级为内存存储，页面功能不中断。
   ========================================================================== */

(function (global) {
  'use strict';

  var BANK_KEY = 'zzll.bank.v1';
  var DEFAULT_BANK = 'chaoge';
  /* 旧版本只有一个题库，key 里没有题库维度 */
  var LEGACY_WRONG_KEY = 'zzll.wrong.v1';
  var LEGACY_PROGRESS_KEY = 'zzll.progress.v1';
  /* 同步层用来判断「本地有没有未推送的改动」 */
  var DATA_UPDATED_KEY = 'zzll.data.updatedAt';

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

  /** 数据变更信标：记时间戳 + 通知同步层（同步层自己写入时用 silent 避免回环） */
  function notifyChange() {
    storageSet(DATA_UPDATED_KEY, String(Date.now()));
    try {
      if (typeof global.dispatchEvent === 'function') {
        global.dispatchEvent(new CustomEvent('zzll:data-changed'));
      }
    } catch (e) { /* 老浏览器忽略 */ }
  }

  function uniq(list) {
    var seen = {}, out = [];
    (list || []).forEach(function (v) {
      if (typeof v !== 'string' || !v || seen[v]) return;
      seen[v] = true;
      out.push(v);
    });
    return out;
  }

  /* ---------------------------------------------------- 题库数据 → 题目索引
     错题集只保存题目 id，题干/答案/解析在渲染时从题库数据还原。
     新增题库或题目无需改动这里：遍历的是题库对象本身。
     索引在页面生命周期内缓存（题库数据是静态的）。 */
  var questionIndexCache = {};

  function questionIndex(bankId) {
    if (questionIndexCache[bankId]) return questionIndexCache[bankId];
    var bank = (global.ZZLL_BANKS || {})[bankId];
    if (!bank || !Array.isArray(bank.chapters)) return null;
    var map = {};
    bank.chapters.forEach(function (ch) {
      (ch.questions || []).forEach(function (q) {
        if (!q || !q.id) return;
        map[q.id] = {
          id: q.id,
          no: q.no,
          stem: q.stem,
          answer: q.answer,
          explanation: q.explanation,
          chapterId: ch.id,
          chapterTitle: ch.title
        };
      });
    });
    questionIndexCache[bankId] = map;
    return map;
  }

  /* ------------------------------------------------------- 单个题库的存储 */
  function createBankStore(bankId) {
    var wrongKey = 'zzll.wrong.' + bankId + '.v2';
    var wrongKeyV1 = 'zzll.wrong.' + bankId + '.v1';
    var progressKey = 'zzll.progress.' + bankId + '.v1';
    var correctKey = 'zzll.correct.' + bankId + '.v1';
    var shuffleKey = 'zzll.shuffle.progress.' + bankId + '.v1';

    /** 旧版错题集存的是整题对象，这里一次性转成 id 数组（保留旧 key 作备份） */
    function migrateWrong() {
      if (storageGet(wrongKey) !== null) return;
      var legacy = readJSON(wrongKeyV1, null);
      if (!Array.isArray(legacy) || !legacy.length) return;
      var ids = legacy.map(function (q) { return q && q.id ? String(q.id) : ''; });
      writeJSON(wrongKey, uniq(ids));
    }

    var Wrong = {
      key: wrongKey,

      /** 原始题目 id 列表（同步载荷用这个，不带题干） */
      ids: function () {
        migrateWrong();
        var list = readJSON(wrongKey, []);
        return Array.isArray(list) ? uniq(list) : [];
      },

      /** 还原成题目对象（题干、答案、解析、章节都从题库数据取） */
      all: function () {
        var index = questionIndex(bankId);
        if (!index) return [];
        return this.ids().map(function (id) { return index[id]; })
          .filter(function (q) { return !!q; });
      },

      count: function () {
        return this.all().length;
      },

      has: function (id) {
        return this.ids().indexOf(id) !== -1;
      },

      /** 加入一题，返回 true=新增 / false=已存在 */
      add: function (question) {
        var id = question && question.id ? String(question.id) : '';
        if (!id) return false;
        var list = this.ids();
        if (list.indexOf(id) !== -1) return false;
        list.push(id);
        writeJSON(wrongKey, list);
        notifyChange();
        return true;
      },

      /** 批量加入，返回 { added, existed } */
      addMany: function (questions) {
        var list = this.ids();
        var seen = {};
        list.forEach(function (id) { seen[id] = true; });
        var added = 0, existed = 0;
        (questions || []).forEach(function (q) {
          var id = q && q.id ? String(q.id) : '';
          if (!id) return;
          if (seen[id]) { existed++; return; }
          seen[id] = true;
          list.push(id);
          added++;
        });
        if (added) {
          writeJSON(wrongKey, list);
          notifyChange();
        }
        return { added: added, existed: existed };
      },

      removeMany: function (ids) {
        var set = {};
        (ids || []).forEach(function (id) { set[id] = true; });
        var list = this.ids();
        var kept = list.filter(function (id) { return !set[id]; });
        writeJSON(wrongKey, kept);
        if (kept.length !== list.length) notifyChange();
        return list.length - kept.length;
      },

      remove: function (id) {
        var list = this.ids();
        var kept = list.filter(function (v) { return v !== id; });
        writeJSON(wrongKey, kept);
        if (kept.length !== list.length) notifyChange();
        return list.length !== kept.length;
      },

      clear: function () {
        writeJSON(wrongKey, []);
        notifyChange();
      },

      /** 同步层整表写入：静默（不触发推送回环） */
      replace: function (ids) {
        writeJSON(wrongKey, uniq((ids || []).filter(function (v) {
          return typeof v === 'string' && v;
        })));
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
        notifyChange();
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
        notifyChange();
      },

      replace: function (obj) {
        writeJSON(progressKey, (obj && typeof obj === 'object') ? obj : {});
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
        notifyChange();
      },

      reset: function () {
        writeJSON(correctKey, {});
        notifyChange();
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
      },

      replace: function (obj) {
        writeJSON(correctKey, (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {});
      }
    };

    /* 打乱刷题序列：记录「上次未完成」的进度，供弹窗里的「继续上次」使用。
       - 按题库隔离（used 里是题目 id，跨题库没意义）
       - 只在**每组答完后**写入；中途退出的那一组作废，不会被记录
       - 只存本机，不进同步快照 */
    var Shuffle = {
      key: shuffleKey,

      get: function () {
        var v = readJSON(shuffleKey, null);
        if (!v || typeof v !== 'object') return null;
        var used = Array.isArray(v.used) ? v.used.filter(function (x) {
          return typeof x === 'string' && x;
        }) : [];
        if (!used.length) return null;
        return {
          size: typeof v.size === 'number' && v.size > 0 ? v.size : used.length,
          used: used,
          rounds: typeof v.rounds === 'number' && v.rounds > 0 ? v.rounds : 1,
          updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0
        };
      },

      save: function (size, usedIds, rounds) {
        writeJSON(shuffleKey, {
          size: size,
          used: (usedIds || []).slice(),
          rounds: rounds || 0,
          updatedAt: Date.now()
        });
      },

      /** 原始记录（含 updatedAt），同步层打包用；从没写过返回 null */
      raw: function () {
        var v = readJSON(shuffleKey, null);
        return v && typeof v === 'object' ? v : null;
      },

      /** 同步层整表写入（静默，不触发推送） */
      replace: function (obj) {
        if (!obj || typeof obj !== 'object') {
          try { global.localStorage.removeItem(shuffleKey); } catch (e) {}
          return;
        }
        var used = Array.isArray(obj.used) ? obj.used.filter(function (x) {
          return typeof x === 'string' && x;
        }) : [];
        writeJSON(shuffleKey, {
          size: typeof obj.size === 'number' && obj.size > 0 ? obj.size : 0,
          used: used,
          rounds: typeof obj.rounds === 'number' && obj.rounds > 0 ? obj.rounds : 0,
          updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : 0
        });
      },

      /* 清空：写一个空壳而不是删 key —— 保留「什么时候清的」，
         否则这台设备上的「已刷完」没法传播到另一台（会被对方的旧进度合回来） */
      clear: function () {
        writeJSON(shuffleKey, { size: 0, used: [], rounds: 0, updatedAt: Date.now() });
      }
    };

    return { bankId: bankId, Wrong: Wrong, Progress: Progress, Stats: Stats, Shuffle: Shuffle };
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
      var targetWrong = 'zzll.wrong.' + DEFAULT_BANK + '.v2';
      var targetProgress = 'zzll.progress.' + DEFAULT_BANK + '.v1';

      var legacyWrong = readJSON(LEGACY_WRONG_KEY, null);
      if (Array.isArray(legacyWrong) && legacyWrong.length && !storageGet(targetWrong)) {
        var ids = legacyWrong.map(function (q) { return q && q.id ? String(q.id) : ''; });
        writeJSON(targetWrong, uniq(ids));
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

  /* -------------------------------------------------- 章节模式（刷题 / 阅读）
     全局偏好，不分题库：'practice'（默认）| 'read' */
  var SECTION_MODE_KEY = 'zzll.sectionmode.v1';

  var SectionMode = {
    key: SECTION_MODE_KEY,

    get: function () {
      var v = storageGet(SECTION_MODE_KEY);
      return v === 'read' ? 'read' : 'practice';
    },

    set: function (mode) {
      storageSet(SECTION_MODE_KEY, mode === 'read' ? 'read' : 'practice');
    }
  };

  /* -------------------------------------------------- 打乱刷题偏好
     全局偏好，不分题库、不参与云同步：是否「优先推送答对次数最少的题目」。
     默认开（没存过 / 值不合法都按开处理）。 */
  var SHUFFLE_PRIORITY_KEY = 'zzll.shufflepriority.v1';

  var ShufflePriority = {
    key: SHUFFLE_PRIORITY_KEY,

    get: function () {
      var v = storageGet(SHUFFLE_PRIORITY_KEY);
      return v === null || v === undefined || v === '' ? true : v === '1';
    },

    set: function (on) {
      storageSet(SHUFFLE_PRIORITY_KEY, on ? '1' : '0');
    }
  };

  global.ZZLLStore = {
    forBank: createBankStore,
    Banks: Banks,
    SectionMode: SectionMode,
    ShufflePriority: ShufflePriority,
    /* 同步层用：本地数据最后修改时间（毫秒） */
    dataUpdatedAt: function () {
      return Number(storageGet(DATA_UPDATED_KEY) || 0) || 0;
    }
  };
})(window);

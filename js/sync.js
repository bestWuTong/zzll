/* ==========================================================================
   数据同步层（云同步 + 手动剪贴板同步）
   - 同步范围：所有题库的 错题集(题目id) / 章节进度 / 每题答对次数
   - 不同步：当前题库选择、主题、章节阅读模式（这些属于「这台设备的偏好」）
   - 云端：GitHub Gist 单文件，内容就是一份全量快照 JSON
   - 失败策略：连接失败自动重试 3 次；仍失败则保留本地数据继续用，只提示
   - 冲突策略：只有一端改过 → 直接采用它（保证删除/清空能传播）；
     两端都改过 → 合并（错题集并集、进度并集、答对次数取较大值）
   ========================================================================== */

(function (global) {
  'use strict';

  var Store = global.ZZLLStore;
  var CFG_KEY = 'zzll.sync.v1';
  var STATE_KEY = 'zzll.sync.state.v1';
  var DATA_UPDATED_KEY = 'zzll.data.updatedAt';
  var TYPE = 'zzll-sync';
  var VERSION = 2;
  var DEFAULT_FILENAME = 'zzll-wutong.json';
  var API = 'https://api.github.com';
  var RETRY = 3;
  var TIMEOUT = 15000;

  var listeners = [];
  var syncing = false;
  var pending = null;      /* 进行中的 Promise：重复调用复用同一次同步 */

  /* ---------------------------------------------------------------- 配置 */
  function readJSON(key, fallback) {
    try {
      var raw = global.localStorage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return v === null || v === undefined ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try { global.localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  function config() {
    var c = readJSON(CFG_KEY, {});
    return {
      gistId: typeof c.gistId === 'string' ? c.gistId : '',
      token: typeof c.token === 'string' ? c.token : '',
      /* 没填时留空，真正用的时候再回退到默认文件名（界面上不预填） */
      filename: typeof c.filename === 'string' ? c.filename : '',
      autoSync: c.autoSync !== false
    };
  }

  function saveConfig(patch) {
    var before = config();
    var c = config();
    Object.keys(patch || {}).forEach(function (k) { c[k] = patch[k]; });
    writeJSON(CFG_KEY, c);
    /* 换了 Gist 就重置比对基准，否则会拿旧仓库的同步时间跟新仓库比较 */
    if (patch && typeof patch.gistId === 'string' && patch.gistId !== before.gistId) {
      saveState({ lastSyncAt: 0, lastError: '' });
    }
    return c;
  }

  function configured() {
    var c = config();
    return !!(c.gistId && c.token);
  }

  function rawState() {
    var s = readJSON(STATE_KEY, {});
    return (s && typeof s === 'object' && !Array.isArray(s)) ? s : {};
  }

  function state() {
    var s = rawState();
    if (typeof s.deviceId !== 'string' || !s.deviceId) {
      s.deviceId = 'web-' + Math.random().toString(36).slice(2, 8);
      writeJSON(STATE_KEY, s);
    }
    return {
      deviceId: s.deviceId,
      lastSyncAt: typeof s.lastSyncAt === 'number' ? s.lastSyncAt : 0,
      lastError: typeof s.lastError === 'string' ? s.lastError : ''
    };
  }

  function saveState(patch) {
    var s = rawState();
    Object.keys(patch || {}).forEach(function (k) { s[k] = patch[k]; });
    writeJSON(STATE_KEY, s);
    return s;
  }

  function localUpdatedAt() {
    try {
      return Number(global.localStorage.getItem(DATA_UPDATED_KEY) || 0) || 0;
    } catch (e) {
      return Store.dataUpdatedAt ? Store.dataUpdatedAt() : 0;
    }
  }

  /* ------------------------------------------------------------ 快照构建 */
  /** 所有已注册题库的同步数据；新增题库自动纳入，无需改这里 */
  function buildSnapshot() {
    var reg = global.ZZLL_BANKS || {};
    var banks = {};
    Object.keys(reg).forEach(function (bankId) {
      var bank = reg[bankId];
      if (!bank || !Array.isArray(bank.chapters)) return;
      var s = Store.forBank(bankId);
      banks[bankId] = {
        wrong: s.Wrong.ids(),
        progress: s.Progress.all(),
        stats: s.Stats.all()
      };
    });
    return {
      type: TYPE,
      version: VERSION,
      updatedAt: new Date().toISOString(),
      deviceId: state().deviceId,
      banks: banks
    };
  }

  /** 把快照写回本地（静默，不触发推送回环） */
  function applySnapshot(snap) {
    if (!snap || snap.type !== TYPE || typeof snap.banks !== 'object') {
      throw new Error('同步数据格式不正确');
    }
    Object.keys(snap.banks).forEach(function (bankId) {
      var data = snap.banks[bankId] || {};
      var s = Store.forBank(bankId);
      s.Wrong.replace(Array.isArray(data.wrong) ? data.wrong : []);
      s.Progress.replace(data.progress);
      s.Stats.replace(data.stats);
    });
  }

  /* ------------------------------------------------------------ 合并快照 */
  function unionInto(dst, src) {
    Object.keys(src || {}).forEach(function (k) { dst[k] = src[k]; });
    return dst;
  }

  function mergeBanks(a, b) {
    var out = {};
    var ids = {};
    Object.keys(a || {}).forEach(function (k) { ids[k] = 1; });
    Object.keys(b || {}).forEach(function (k) { ids[k] = 1; });

    Object.keys(ids).forEach(function (bankId) {
      var x = (a && a[bankId]) || {};
      var y = (b && b[bankId]) || {};

      /* 错题集：题目 id 并集 */
      var wrong = [];
      var wseen = {};
      (Array.isArray(x.wrong) ? x.wrong : []).concat(Array.isArray(y.wrong) ? y.wrong : [])
        .forEach(function (id) {
          if (typeof id !== 'string' || !id || wseen[id]) return;
          wseen[id] = 1;
          wrong.push(id);
        });

      /* 进度：按章节并集（seen / correct 都取并集） */
      var progress = {};
      var pX = (x.progress && typeof x.progress === 'object') ? x.progress : {};
      var pY = (y.progress && typeof y.progress === 'object') ? y.progress : {};
      var chapters = {};
      Object.keys(pX).forEach(function (c) { chapters[c] = 1; });
      Object.keys(pY).forEach(function (c) { chapters[c] = 1; });
      Object.keys(chapters).forEach(function (ch) {
        var cx = pX[ch] || {}, cy = pY[ch] || {};
        progress[ch] = {
          seen: unionInto(unionInto({}, cx.seen), cy.seen),
          correct: unionInto(unionInto({}, cx.correct), cy.correct)
        };
      });

      /* 答对次数：同一题取较大值（两台设备各答对的次数不重复累加，避免虚高） */
      var stats = {};
      var sX = (x.stats && typeof x.stats === 'object') ? x.stats : {};
      var sY = (y.stats && typeof y.stats === 'object') ? y.stats : {};
      Object.keys(sX).forEach(function (q) { stats[q] = sX[q]; });
      Object.keys(sY).forEach(function (q) {
        stats[q] = Math.max(stats[q] || 0, sY[q] || 0);
      });

      out[bankId] = { wrong: wrong, progress: progress, stats: stats };
    });
    return out;
  }

  function mergeSnapshots(local, remote) {
    return {
      type: TYPE,
      version: VERSION,
      updatedAt: new Date().toISOString(),
      deviceId: local.deviceId || state().deviceId,
      banks: mergeBanks(local.banks, remote.banks)
    };
  }

  function snapshotStamp(snap) {
    var t = snap && snap.updatedAt ? Date.parse(snap.updatedAt) : NaN;
    return isNaN(t) ? 0 : t;
  }

  /* ------------------------------------------------------------ 网络请求 */
  function request(method, path, body) {
    var cfg = config();
    var headers = {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + cfg.token
    };
    if (body) headers['Content-Type'] = 'application/json';

    var controller = null;
    var timer = null;
    var opts = { method: method, headers: headers };
    if (body) opts.body = JSON.stringify(body);

    if (typeof AbortController === 'function') {
      controller = new AbortController();
      opts.signal = controller.signal;
      timer = setTimeout(function () { controller.abort(); }, TIMEOUT);
    }

    return global.fetch(API + path, opts).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var err = new Error(errorText(res.status, data));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    }, function (err) {
      if (timer) clearTimeout(timer);
      var e = new Error(err && err.name === 'AbortError' ? '请求超时' : '网络不可用');
      e.network = true;
      throw e;
    });
  }

  function errorText(status, data) {
    if (status === 401) return '令牌无效或已过期（401）';
    if (status === 403) return '权限不足或触发限速（403），令牌需 Gists 读写权限';
    if (status === 404) return '找不到 Gist（404），检查 Gist ID 与令牌权限';
    if (status === 422) return '文件名或内容不合法（422）';
    if (status >= 500) return 'GitHub 服务异常（' + status + '）';
    var msg = data && data.message ? data.message : '';
    return '请求失败（' + status + '）' + (msg ? '：' + msg : '');
  }

  /** 带重试：网络 / 5xx / 429 才重试，4xx 直接失败 */
  function withRetry(fn) {
    var attempt = 0;
    function run() {
      attempt++;
      return fn().catch(function (err) {
        var retryable = err.network || err.status === 429 || err.status >= 500;
        if (!retryable || attempt >= RETRY) throw err;
        return new Promise(function (resolve) {
          setTimeout(resolve, 700 * attempt);
        }).then(run);
      });
    }
    return run();
  }

  function remoteFilename() {
    return config().filename || DEFAULT_FILENAME;
  }

  function pull() {
    var cfg = config();
    return withRetry(function () {
      return request('GET', '/gists/' + encodeURIComponent(cfg.gistId));
    }).then(function (data) {
      var file = data && data.files && data.files[remoteFilename()];
      if (!file || typeof file.content !== 'string' || !file.content) return null;
      try {
        var snap = JSON.parse(file.content);
        if (snap && snap.type === TYPE) return snap;
        return null;
      } catch (e) {
        return null;   /* 云端内容损坏：按「没有远端数据」处理，下次推送覆盖 */
      }
    });
  }

  function push(snap) {
    var cfg = config();
    var body = { files: {} };
    body.files[remoteFilename()] = {
      content: JSON.stringify(snap, null, 2)
    };
    return withRetry(function () {
      return request('PATCH', '/gists/' + encodeURIComponent(cfg.gistId), body);
    });
  }

  /* ------------------------------------------------------------ 同步流程 */
  function hasAnyData(snap) {
    var banks = (snap && snap.banks) || {};
    return Object.keys(banks).some(function (k) {
      var b = banks[k] || {};
      return (b.wrong && b.wrong.length) ||
        (b.progress && Object.keys(b.progress).length) ||
        (b.stats && Object.keys(b.stats).length);
    });
  }

  /**
   * 单次同步：
   * 1) 拉云端；没有 → 直接推本地
   * 2) 只有一端改过 → 用改过的那端（删除 / 清空也能传播）
   * 3) 两端都改过 → 合并后再推
   */
  function syncOnce() {
    var st = state();
    var local = buildSnapshot();
    var localAt = localUpdatedAt();

    return pull().then(function (remote) {
      if (!remote) {
        return push(local).then(function () { return { action: 'push', snap: local }; });
      }
      var remoteAt = snapshotStamp(remote);
      var localChanged = localAt > st.lastSyncAt;
      /* 老用户升级前没有 dataUpdatedAt 信标，但本地已有数据：
         这种情况按「本地有改动」处理，走合并，避免被云端直接覆盖。 */
      if (!localChanged && !localAt && hasAnyData(local)) localChanged = true;
      var remoteChanged = remoteAt > st.lastSyncAt;

      if (!localChanged && !remoteChanged) {
        return { action: 'none', snap: remote };
      }
      if (!localChanged && remoteChanged) {
        applySnapshot(remote);
        return { action: 'pull', snap: remote };
      }
      if (localChanged && !remoteChanged) {
        return push(local).then(function () { return { action: 'push', snap: local }; });
      }
      var merged = mergeSnapshots(local, remote);
      applySnapshot(merged);
      return push(merged).then(function () { return { action: 'merge', snap: merged }; });
    }).then(function (res) {
      saveState({ lastSyncAt: Date.now(), lastError: '' });
      notify(res);
      return res;
    }, function (err) {
      saveState({ lastError: err && err.message ? err.message : '同步失败' });
      notify({ action: 'error', error: err });
      throw err;
    });
  }

  function sync() {
    if (pending) return pending;
    if (!configured()) return Promise.reject(new Error('请先填写 Gist ID 与访问令牌'));
    syncing = true;
    pending = syncOnce().then(function (res) {
      syncing = false;
      pending = null;
      return res;
    }, function (err) {
      syncing = false;
      pending = null;
      throw err;
    });
    return pending;
  }

  /** 测试连接：只读一次，不写任何数据 */
  function testConnection() {
    if (!configured()) return Promise.reject(new Error('请先填写 Gist ID 与访问令牌'));
    return pull().then(function (snap) {
      return { ok: true, hasData: !!snap, updatedAt: snap ? snap.updatedAt : null };
    });
  }

  /* -------------------------------------------------------- 手动同步（剪贴板） */
  function exportText() {
    return JSON.stringify(buildSnapshot(), null, 2);
  }

  function importText(text) {
    var snap = null;
    try { snap = JSON.parse(String(text || '')); } catch (e) { snap = null; }
    if (!snap || snap.type !== TYPE) throw new Error('不是本应用的同步数据');
    if (!snap.banks || typeof snap.banks !== 'object') throw new Error('同步数据缺少题库内容');

    var local = buildSnapshot();
    var merged = mergeSnapshots(local, snap);
    applySnapshot(merged);
    /* 手动导入也算「本地有改动」：把时间信标推到最新，
       这样之后云同步会把这份数据推上去，而不是误判为「本地没动」。
       注意不能动 lastSyncAt——那是云同步的比对基准。 */
    try { global.localStorage.setItem(DATA_UPDATED_KEY, String(Date.now())); } catch (e) {}
    var banks = Object.keys(merged.banks || {}).length;
    var wrong = 0;
    Object.keys(merged.banks || {}).forEach(function (k) {
      wrong += (merged.banks[k].wrong || []).length;
    });
    /* 导入后是否推云端由调用方决定（app 层会弹一次带通知的同步） */
    return { banks: banks, wrong: wrong };
  }

  function copyToClipboard(text) {
    if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
      return global.navigator.clipboard.writeText(text).then(function () { return true; });
    }
    /* 回退：临时 textarea + execCommand，兼容 file:// 与老浏览器 */
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        var ok = document.execCommand && document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? resolve(true) : reject(new Error('浏览器不允许写入剪贴板'));
      } catch (e) {
        reject(new Error('复制失败：' + (e && e.message ? e.message : '未知错误')));
      }
    });
  }

  function readClipboard() {
    if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.readText) {
      return global.navigator.clipboard.readText();
    }
    return Promise.reject(new Error('浏览器不允许读取剪贴板，请手动粘贴'));
  }

  /* ------------------------------------------------------------ 订阅 UI */
  function notify(event) {
    listeners.forEach(function (fn) {
      try { fn(event); } catch (e) {}
    });
  }

  function subscribe(fn) {
    listeners.push(fn);
  }

  /** 自动同步是否可用（有配置 + 没被关掉） */
  function autoEnabled() {
    var cfg = config();
    return cfg.autoSync && configured();
  }

  /**
   * 带气泡通知的同步入口。所有同步都走这里，保证「开始 / 完成 / 失败」都有提示。
   * 返回的是同一个 Promise（并发调用会复用）。
   */
  function syncWithNotice() {
    if (!configured()) return Promise.reject(new Error('请先填写 Gist ID 与访问令牌'));
    notify({ action: 'start' });
    return sync().then(function (res) {
      notify({ action: 'done', result: res });
      return res;
    }, function (err) {
      notify({ action: 'error', error: err });
      throw err;
    });
  }

  /** 进入页面时用：只有「配置了且开着自动同步」才需要等它 */
  function bootSync() {
    if (!autoEnabled()) return null;
    return syncWithNotice();
  }

  function init() {
    /* 同步时机全部由业务侧显式触发（启动 / 整组答完 / 错题增删），不再监听数据变更 */
  }

  global.ZZLLSync = {
    init: init,
    subscribe: subscribe,
    config: config,
    saveConfig: saveConfig,
    configured: configured,
    autoEnabled: autoEnabled,
    state: state,
    sync: sync,
    syncWithNotice: syncWithNotice,
    bootSync: bootSync,
    testConnection: testConnection,
    exportText: exportText,
    importText: importText,
    copyToClipboard: copyToClipboard,
    readClipboard: readClipboard,
    buildSnapshot: buildSnapshot,
    applySnapshot: applySnapshot,
    mergeSnapshots: mergeSnapshots,
    isSyncing: function () { return syncing; }
  };
})(window);

/* ==========================================================================
   通用对话框 —— 替代浏览器原生 alert / confirm
   --------------------------------------------------------------------------
   原生弹窗的问题：样式完全不可控（和站点风格割裂）、会阻塞主线程、
   在手机上还会显示来源域名。这里用站内卡片 + 遮罩实现同一套语义。

     ZZLLDialog.confirm({ title, message, okText, cancelText, danger })
       → Promise<boolean>     true = 确定，false = 取消 / 点遮罩 / Esc
     ZZLLDialog.alert({ title, message, okText })
       → Promise<void>
     ZZLLDialog.isOpen()
       → boolean              用于屏蔽背后的快捷键

   两个注意点（从原生 confirm 迁移过来时最容易踩）：
   1. 原生 confirm 是**同步阻塞**的，这里返回 Promise —— 调用点必须改成 .then()
   2. 原生弹窗会吞掉所有键盘事件，换成站内卡片后不会 ——
      刷题页的 ← → / 1 / 2 快捷键要自己判断 isOpen()，
      本组件也会在捕获阶段拦下按键，双保险
   ========================================================================== */

(function (global) {
  'use strict';

  var el = null;
  var titleEl = null;
  var msgEl = null;
  var okBtn = null;
  var cancelBtn = null;
  var pending = null;      /* { resolve } —— 有值表示对话框正在显示 */
  var lastFocus = null;

  function $(id) { return document.getElementById(id); }

  function init() {
    if (el) return;
    el = $('dialogModal');
    if (!el) return;
    titleEl = $('dlgTitle');
    msgEl = $('dlgMessage');
    okBtn = $('dlgOk');
    cancelBtn = $('dlgCancel');

    el.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-dlg]') : null;
      if (!b) return;
      close(b.getAttribute('data-dlg') === 'ok');
    });

    /* 捕获阶段拦按键：既处理 Esc/Enter，也防止底下页面的快捷键被触发 */
    document.addEventListener('keydown', function (e) {
      if (!pending) return;
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        if (cancelBtn.hidden) close(true);   /* alert 没有取消按钮 */
        else close(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        /* 焦点在「取消」上时按回车 = 取消，符合直觉 */
        close(document.activeElement === cancelBtn ? false : true);
      }
    }, true);
  }

  function open(opts) {
    init();
    if (!el) return Promise.resolve(false);

    /* 并发调用：先把上一个按「取消」结掉，避免 promise 泄漏 */
    if (pending) {
      var prev = pending;
      pending = null;
      prev.resolve(false);
    }

    var o = opts || {};
    lastFocus = document.activeElement;

    titleEl.textContent = o.title || '提示';
    msgEl.textContent = o.message || '';
    msgEl.hidden = !o.message;
    okBtn.textContent = o.okText || '确定';
    okBtn.classList.toggle('is-danger', !!o.danger);
    okBtn.hidden = false;
    cancelBtn.hidden = !!o.single;              /* alert：只有一个按钮 */
    cancelBtn.textContent = o.cancelText || '取消';

    el.hidden = false;
    setTimeout(function () {
      try { okBtn.focus(); } catch (e) {}
    }, 0);

    return new Promise(function (resolve) { pending = { resolve: resolve }; });
  }

  function close(ok) {
    if (!pending) return;
    var p = pending;
    pending = null;
    el.hidden = true;
    /* 焦点还给打开对话框之前的元素，键盘操作不会丢位置 */
    if (lastFocus && lastFocus.focus) {
      try { lastFocus.focus(); } catch (e) {}
    }
    lastFocus = null;
    p.resolve(!!ok);
  }

  function confirm(opts) {
    var o = opts || {};
    return open({
      title: o.title,
      message: o.message,
      okText: o.okText,
      cancelText: o.cancelText,
      danger: o.danger
    });
  }

  function alert(opts) {
    var o = opts || {};
    return open({
      title: o.title,
      message: o.message,
      okText: o.okText,
      single: true
    }).then(function () { /* void */ });
  }

  global.ZZLLDialog = {
    confirm: confirm,
    alert: alert,
    isOpen: function () { return !!pending; }
  };
})(window);

/* ==========================================================================
   彩带引擎 —— 复刻 canvas-confetti 的「Basic Cannon」
   --------------------------------------------------------------------------
   左侧、右侧各放一发礼炮，朝屏幕内侧上方斜射（60° / 120°，扩散 55°），
   粒子受重力下坠、受空气阻力减速、边飞边自转。

   自实现、零依赖。性能优先的几处取舍：
   1. 粒子数固定（默认每侧 70，合计 140），不随画布面积放大
   2. 设备像素比上限 2 —— 3x 屏上按 3 倍绘制纯属浪费，视觉几乎无差别
   3. 全程只有一条 rAF 循环；粒子全部消失后立即停循环并把画布隐藏
   4. 绘制用 setTransform + fillRect，不用 save/restore
   5. dt 上限 32ms —— 从后台标签页切回来时不会让粒子瞬移出屏
   6. 尊重 prefers-reduced-motion：直接不放
   ========================================================================== */

(function (global) {
  'use strict';

  /* 取站点配色（蓝 / 绿 / 橙 / 红 / 紫），深浅色主题下都够醒目 */
  var COLORS = ['#0071e3', '#34c759', '#ff9f0a', '#ff375f', '#5e5ce6'];

  var GRAVITY = 1500;      /* px/s² */
  var DRAG = 1.15;         /* 指数阻尼系数，越大减速越快 */
  var SPEED_MIN = 760;
  var SPEED_MAX = 1250;
  var SPREAD = 27.5;       /* 半角，对应 canvas-confetti 的 spread: 55 */
  var LIFE = 2.5;          /* 秒（每颗粒子再加 ±随机抖动） */
  var FADE_FROM = 0.72;    /* 生命周期过了这个比例开始淡出 */

  var current = null;      /* 正在跑的循环，便于中途 stop() */

  function rand(a, b) { return a + Math.random() * (b - a); }

  function spawn(list, ox, oy, angle, count) {
    for (var i = 0; i < count; i++) {
      var rad = (angle + rand(-SPREAD, SPREAD)) * Math.PI / 180;
      var v = rand(SPEED_MIN, SPEED_MAX);
      list.push({
        x: ox,
        y: oy,
        vx: Math.cos(rad) * v,
        vy: -Math.sin(rad) * v,      /* 屏幕坐标 y 向下，所以取负 */
        w: rand(7, 12),
        h: rand(5, 8),
        rot: rand(0, Math.PI * 2),
        vrot: rand(-9, 9),           /* rad/s */
        color: COLORS[(Math.random() * COLORS.length) | 0],
        age: 0,
        life: LIFE * rand(0.85, 1.12)
      });
    }
  }

  /**
   * 放一次彩带。
   * @param {HTMLCanvasElement} canvas 画布（尺寸由调用方用 CSS 定好）
   * @param {number} fireY 炮口在画布内的 y（CSS px）；省略则用画布底边
   * @param {object} [opts] { particles: 每侧粒子数 }
   * @returns {boolean} 是否真的播放了
   */
  function fire(canvas, fireY, opts) {
    if (!canvas) return false;
    if (global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;

    stop();                          /* 上一发还没放完就先掐掉，避免两条循环 */
    canvas.hidden = false;           /* 先显示，否则量到的尺寸是 0 */

    var w = canvas.clientWidth;
    var h = canvas.clientHeight;
    if (!w || !h) { canvas.hidden = true; return false; }

    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var pw = Math.round(w * dpr);
    var ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }

    var ctx = canvas.getContext('2d');
    if (!ctx) { canvas.hidden = true; return false; }

    var count = (opts && opts.particles) || 70;
    var y = (fireY == null) ? h : fireY;
    var parts = [];
    spawn(parts, -6, y, 60, count);        /* 左炮：向右上 */
    spawn(parts, w + 6, y, 120, count);    /* 右炮：向左上 */

    var base = dpr;
    var last = 0;
    var raf = 0;
    var stopped = false;

    function paint(now) {
      if (stopped) return;
      var dt = last ? Math.min((now - last) / 1000, 0.032) : 0.016;
      last = now;

      ctx.setTransform(base, 0, 0, base, 0, 0);
      ctx.clearRect(0, 0, w, h);

      var alive = 0;
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (p.age >= p.life) continue;

        p.age += dt;
        if (p.age >= p.life) continue;

        var decay = Math.exp(-DRAG * dt);
        p.vx *= decay;
        p.vy = p.vy * decay + GRAVITY * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vrot * dt;

        /* 飞出画布太多就直接判死，省掉后续绘制 */
        if (p.x < -80 || p.x > w + 80 || p.y > h + 80) { p.age = p.life; continue; }

        alive++;
        var t = p.age / p.life;
        ctx.globalAlpha = t < FADE_FROM ? 1 : 1 - (t - FADE_FROM) / (1 - FADE_FROM);
        ctx.fillStyle = p.color;
        var c = Math.cos(p.rot) * base;
        var s = Math.sin(p.rot) * base;
        ctx.setTransform(c, s, -s, c, p.x * base, p.y * base);
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      }

      if (!alive) {
        finish();
        return;
      }
      raf = global.requestAnimationFrame(paint);
    }

    function finish() {
      stopped = true;
      current = null;
      if (raf) global.cancelAnimationFrame(raf);
      raf = 0;
      ctx.setTransform(base, 0, 0, base, 0, 0);
      ctx.clearRect(0, 0, w, h);
      canvas.hidden = true;
    }

    current = { finish: finish };
    raf = global.requestAnimationFrame(paint);
    return true;
  }

  /** 中止正在播放的彩带（切换页面时用） */
  function stop() {
    if (current) current.finish();
    current = null;
  }

  global.ZZLLConfetti = { fire: fire, stop: stop, colors: COLORS };
})(window);

/* ==========================================================================
   彩带引擎 —— 复刻 canvas-confetti 的「Basic Cannon」
   --------------------------------------------------------------------------
   官网该效果就是一个居中礼炮、垂直向上、扩散 70°：

       confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } })

   其余全部取默认值。粒子形态与物理**照抄原版源码**：
   不是"旋转的实心方块"，而是会被裁成细纸条、边飞边翻面的四边形
   （正方形占一半，另一半是椭圆）。

     wobbleX = x + 10*cos(wobble)      ← 纸条的另一端
     wobbleY = y + 10*sin(wobble)
     x1 = x + random*tiltCos           ← random ∈ [2,3)，决定纸条厚度
     y1 = y + random*tiltSin
     四边形：(x,y) → (wobbleX, y1) → (x2, y2) → (x1, wobbleY)
     圆形：  椭圆中心 (x,y)，半径 |x2-x1|*0.6 / |y2-y1|*0.6，旋转 π/10*wobble

   tiltAngle 每帧 +0.1，tiltSin/Cos 缓慢变化 —— 纸条就在"完全展开"和
   "被压成一条线"之间反复翻转，这是原版纸屑感的来源。

   物理（单位「每帧」，60fps，与原版一致）：
     velocity = startVelocity*0.5 + rand*startVelocity    // 45 → [22.5, 67.5)
     angle2D  = -angle + (0.5*spread - rand*spread)       // 角度取负，y 轴向下
     x += cos(angle2D) * velocity
     y += sin(angle2D) * velocity + gravity(=3)
     velocity *= decay(0.9)
     alpha = 1 - tick/totalTicks                          // 全程线性淡出
                                                            // 寿命取原版 200 帧的 2/3

   性能取舍：
   1. 粒子数固定 100（原版该效果就是 100），不随面积放大
   2. 设备像素比上限 2 —— 3x 屏按 2x 绘制，视觉几乎无差别
   3. 单条 rAF 循环；按真实时间换算成「帧」推进物理，120Hz 屏不会翻倍加速
   4. 每帧只算一次衰减系数（所有粒子共用），避免逐粒子 Math.pow
   5. 粒子全部消失后立即停循环并隐藏画布
   6. dt 上限 50ms —— 从后台标签页切回来不会瞬移
   7. 尊重 prefers-reduced-motion：直接不放
   ========================================================================== */

(function (global) {
  'use strict';

  /* 原版默认配色 */
  var COLORS = ['#26ccff', '#a25afd', '#ff5e7e', '#88ff5a', '#fcff42', '#ffa62d', '#ff36ff'];

  /* ---- 与原版默认值对齐（均为「每帧」，按 60fps 计） ---- */
  var PARTICLE_COUNT = 100;  /* 单炮 100 个 */
  var START_VELOCITY = 45;   /* px/帧；实际取 0.5 ~ 1.5 倍 */
  var DECAY = 0.9;           /* 每帧速度乘 0.9 */
  var GRAVITY = 3;           /* 每帧额外 +3px（源码里 gravity:1 内部乘 3） */
  /* 寿命：原版 200 帧（≈3.3s），这里按需求缩短到 2/3 ≈ 2.2s */
  var TICKS = 133;
  var SCALAR = 1;            /* 尺寸系数，纸条长度 = 10 * scalar */
  var SPREAD = 70;           /* Basic Cannon 的 spread */
  var ANGLE = 90;            /* 默认 angle：垂直向上 */

  var SIZE = 10 * SCALAR;
  var OVAL = 0.6;            /* 原版 ovalScalar：圆形粒子的半径系数 */
  var LAMBDA = -Math.log(DECAY) * 60;   /* 连续时间阻尼系数 ≈ 6.32 /s */

  var current = null;      /* 正在跑的循环，便于中途 stop() */

  function makeParticle(x, y) {
    var radAngle = ANGLE * Math.PI / 180;
    var radSpread = SPREAD * Math.PI / 180;
    return {
      x: x,
      y: y,
      /* 原版：angle2D = -radAngle + (0.5*radSpread - rand*radSpread) */
      angle2D: -radAngle + (0.5 * radSpread - Math.random() * radSpread),
      velocity: (START_VELOCITY * 0.5) + (Math.random() * START_VELOCITY),
      tick: 0,
      totalTicks: TICKS,
      /* 原版 shapes: ['square','circle'] 等概率取一种 */
      shape: Math.random() < 0.5 ? 'square' : 'circle',
      /* 纸条摆动的相位与角速度 */
      wobble: Math.random() * 10,
      wobbleSpeed: Math.min(0.11, Math.random() * 0.1 + 0.05),
      /* 翻面角度：初始 [0.25π, 0.75π)，每帧 +0.1 */
      tiltAngle: (Math.random() * 0.5 + 0.25) * Math.PI,
      tiltSin: 0,
      tiltCos: 0,
      random: Math.random() + 2,
      wobbleX: x,
      wobbleY: y,
      color: COLORS[(Math.random() * COLORS.length) | 0]
    };
  }

  function update(p, k, decay) {
    p.x += Math.cos(p.angle2D) * p.velocity * k;
    p.y += Math.sin(p.angle2D) * p.velocity * k + GRAVITY * k;
    p.velocity *= decay;
    p.tick += k;

    p.wobble += p.wobbleSpeed * k;
    p.wobbleX = p.x + SIZE * Math.cos(p.wobble);
    p.wobbleY = p.y + SIZE * Math.sin(p.wobble);

    p.tiltAngle += 0.1 * k;
    p.tiltSin = Math.sin(p.tiltAngle);
    p.tiltCos = Math.cos(p.tiltAngle);
    p.random = Math.random() + 2;
  }

  function draw(ctx, p) {
    var progress = p.tick / p.totalTicks;
    if (progress >= 1) return false;

    /* 右下角与左上角各偏开 random*(tiltCos, tiltSin)，形成纸条厚度 */
    var x1 = p.x + p.random * p.tiltCos;
    var y1 = p.y + p.random * p.tiltSin;
    var x2 = p.wobbleX + p.random * p.tiltCos;
    var y2 = p.wobbleY + p.random * p.tiltSin;

    ctx.globalAlpha = 1 - progress;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    if (p.shape === 'circle') {
      /* 原版圆形分支：椭圆半径 = 两角距离 * 0.6，旋转 π/10*wobble */
      ctx.ellipse(p.x, p.y,
        Math.abs(x2 - x1) * OVAL,
        Math.abs(y2 - y1) * OVAL,
        Math.PI / 10 * p.wobble, 0, 2 * Math.PI);
    } else {
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.wobbleX, y1);
      ctx.lineTo(x2, y2);
      ctx.lineTo(x1, p.wobbleY);
      ctx.closePath();
    }
    ctx.fill();
    return true;
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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var per = (opts && opts.particles) || PARTICLE_COUNT;
    var y = (fireY == null) ? h * 0.6 : fireY;
    var parts = [];
    /* Basic Cannon：单炮、炮口在水平中央 */
    for (var i = 0; i < per; i++) parts.push(makeParticle(w / 2, y));

    var stopped = false;
    var raf = 0;
    var last = 0;

    function frame(now) {
      if (stopped) return;
      var dt = last ? Math.min((now - last) / 1000, 0.05) : 1 / 60;
      last = now;

      /* 把真实时间换算成「帧数」，物理仍按原版的每帧步长推进 */
      var k = dt * 60;
      var decay = Math.exp(-LAMBDA * dt);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      var alive = 0;
      for (var j = 0; j < parts.length; j++) {
        var p = parts[j];
        if (p.tick >= p.totalTicks) continue;
        update(p, k, decay);
        /* 明显飞出画布就不画了（画布边缘本身也会裁切，这里只是省算力） */
        if (p.x < -120 || p.x > w + 120 || p.y > h + 120) { p.tick = p.totalTicks; continue; }
        if (draw(ctx, p)) alive++;
      }
      ctx.globalAlpha = 1;

      if (!alive) { finish(); return; }
      raf = global.requestAnimationFrame(frame);
    }

    function finish() {
      stopped = true;
      current = null;
      if (raf) global.cancelAnimationFrame(raf);
      raf = 0;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      canvas.hidden = true;
    }

    current = { finish: finish };
    raf = global.requestAnimationFrame(frame);
    return true;
  }

  /** 中止正在播放的彩带（切换页面时用） */
  function stop() {
    if (current) current.finish();
    current = null;
  }

  global.ZZLLConfetti = { fire: fire, stop: stop, colors: COLORS };
})(window);


(() => {
  const REMASTER = {
    bootMinMs: 1500,
    assetsReady: false,
    bootDone: false,
    bootStartedAt: performance.now(),
    onlineCancelled: false,
    connectGeneration: 0,
    connectRetry: null,
    images: {}
  };

  const IMG_FILES = {
    solids: 'assets/img/solidsSpriteSheet.png',
    spot: 'assets/img/spotSpriteSheet.png',
    shadow: 'assets/img/shadow.png',
    shade: 'assets/img/shade.png',
    cloth: 'assets/img/cloth.png',
    tableTop: 'assets/img/tableTop.png',
    pockets: 'assets/img/pockets.png',
    stripe9: 'assets/img/ballSpriteSheet9.png',
    stripe10: 'assets/img/ballSpriteSheet10.png',
    stripe11: 'assets/img/ballSpriteSheet11.png',
    stripe12: 'assets/img/ballSpriteSheet12.png',
    stripe13: 'assets/img/ballSpriteSheet13.png',
    stripe14: 'assets/img/ballSpriteSheet14.png',
    stripe15: 'assets/img/ballSpriteSheet15.png'
  };

  const SPRITES = {
    solids: { fw: 48, fh: 48, cols: 3, frames: 9 },
    spot: { fw: 38, fh: 38, cols: 4, frames: 16 },
    stripe: { fw: 50, fh: 50, cols: 5, frames: 41 }
  };

  const origDrawTable = typeof drawTable === 'function' ? drawTable : null;
  const origDrawBall = typeof drawBall === 'function' ? drawBall : null;
  const origMakeBalls = typeof makeBalls === 'function' ? makeBalls : null;
  const origMakeCue = typeof makeCue === 'function' ? makeCue : null;
  const origMakeBallsSeeded = typeof makeBallsSeeded === 'function' ? makeBallsSeeded : null;
  const origHandleWsMsg = typeof handleWsMsg === 'function' ? handleWsMsg : null;

  function hq(ctx2){
    if (!ctx2) return;
    ctx2.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx2) ctx2.imageSmoothingQuality = 'high';
  }
  [ctx, actx, pctx, bgctx].forEach(hq);

  function loadImage(src){
    return new Promise((resolve,reject)=>{
      const img = new Image();
      img.onload = ()=>resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  Promise.all(Object.entries(IMG_FILES).map(([key,src]) => loadImage(src).then(img => { REMASTER.images[key] = img; })))
    .then(()=>{ REMASTER.assetsReady = true; })
    .catch(err => {
      console.warn('Remaster assets could not be fully loaded:', err);
    });

  function clampV(v,a,b){ return Math.max(a, Math.min(b, v)); }

  function initBallVisual(ball){
    if (!ball) return ball;
    if (!ball.r) ball.r = R;
    if (!ball.circRad) ball.circRad = ball.r;
    if (!ball.ballRotation || !Array.isArray(ball.ballRotation) || ball.ballRotation.length !== 4) {
      ball.ballRotation = [1,0,0,0];
    }
    ball.rotX = ball.rotX || 0;
    ball.rotY = ball.rotY || 0;
    ball.rotZ = ball.rotZ || 0;
    ball.__visInit = true;
    return ball;
  }

  function initAllBalls(){
    if (G && Array.isArray(G.balls)) G.balls.forEach(initBallVisual);
    if (G && G.cue) initBallVisual(G.cue);
  }

  if (origMakeBalls) {
    makeBalls = function(){
      const balls = origMakeBalls();
      balls.forEach(initBallVisual);
      return balls;
    };
  }

  if (origMakeCue) {
    makeCue = function(){
      const cue = origMakeCue();
      initBallVisual(cue);
      cue.id = 0;
      cue.stripe = false;
      return cue;
    };
  }

  if (origMakeBallsSeeded) {
    makeBallsSeeded = function(seed){
      const balls = origMakeBallsSeeded(seed);
      balls.forEach(initBallVisual);
      return balls;
    };
  }

  function normalizeQuat(q){
    const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0]/len, q[1]/len, q[2]/len, q[3]/len];
  }

  function rotateQuat(q, x, y, z, angle){
    const axisLen = Math.hypot(x,y,z);
    if (axisLen < 1e-6 || !isFinite(angle) || angle === 0) return q;
    const ax = x / axisLen, ay = y / axisLen, az = z / axisLen;
    const half = angle * 0.5;
    const s = Math.sin(half);
    const n = ax * s, d = ay * s, c = az * s, M = Math.cos(half);
    const P = q[0], Y = q[1], H = q[2], Rq = q[3];
    return [
      P*M + Y*c - H*d + Rq*n,
      -P*c + Y*M + H*n + Rq*d,
      P*d - Y*n + H*M + Rq*c,
      -P*n - Y*d - H*c + Rq*M
    ];
  }

  function updateBallQuaternion(ball, moveX, moveY){
    initBallVisual(ball);
    const dx = moveX;
    const dz = moveY;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return;
    const axisX = dz / len;
    const axisY = -dx / len;
    const axisZ = 0;
    ball.ballRotation = normalizeQuat(rotateQuat(ball.ballRotation, axisX, axisY, axisZ, len / ball.r));
  }

  function quaternionToView(ball){
    initBallVisual(ball);
    const q = ball.ballRotation;
    const s = q[0], h = q[1], i = q[2], a = q[3];
    const o = Math.atan2(2*s*a - 2*h*i, 1 - 2*s*s - 2*i*i) + Math.PI;
    const r = Math.asin(clampV(2*h*s + 2*i*a, -1, 1)) + Math.PI;
    const e = Math.atan2(2*h*a - 2*s*i, 1 - 2*h*h - 2*i*i) + Math.PI;
    return { o, r, e, singular: (h*s + i*a > 0.499 || h*s + i*a < -0.499) };
  }

  function drawFrame(image, frame, meta, x, y, w, h){
    if (!image) return;
    const safeFrame = clampV(frame|0, 0, meta.frames - 1);
    const sx = (safeFrame % meta.cols) * meta.fw;
    const sy = Math.floor(safeFrame / meta.cols) * meta.fh;
    ctx.drawImage(image, sx, sy, meta.fw, meta.fh, x, y, w, h);
  }

  function drawImageCover(image, dx, dy, dw, dh, alpha=1){
    if (!image) return;
    const sw = image.width, sh = image.height;
    const srcAspect = sw / sh;
    const dstAspect = dw / dh;
    let sx = 0, sy = 0, sWidth = sw, sHeight = sh;
    if (srcAspect > dstAspect) {
      sWidth = sh * dstAspect;
      sx = (sw - sWidth) * 0.5;
    } else {
      sHeight = sw / dstAspect;
      sy = (sh - sHeight) * 0.5;
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(image, sx, sy, sWidth, sHeight, dx, dy, dw, dh);
    ctx.restore();
  }

  function drawSpotOnBall(view, id){
    if (id <= 0 || !REMASTER.images.spot) return;
    let spotX = 0, spotY = 0;
    const circRad = R;
    const r = view.r, e = view.e;
    if (r < Math.PI/2 || r > 3*Math.PI/2) {
      if (e > Math.PI/2 && e < 3*Math.PI/2) {
        spotY = circRad * Math.cos(e) * Math.sin(r);
        spotX = circRad * Math.sin(e);
      } else {
        spotY = -circRad * Math.cos(e) * Math.sin(r);
        spotX = -circRad * Math.sin(e);
      }
    } else {
      if (e > Math.PI/2 && e < 3*Math.PI/2) {
        spotY = -circRad * Math.cos(e) * Math.sin(r);
        spotX = -circRad * Math.sin(e);
      } else {
        spotY = circRad * Math.cos(e) * Math.sin(r);
        spotX = circRad * Math.sin(e);
      }
    }

    const n = Math.hypot(spotX, spotY) / circRad;
    const flatten = Math.cos(n * Math.PI * 0.5);
    const holderAngle = Math.atan2(spotY, spotX) + Math.PI * 0.5;
    const spotSize = circRad * 1.04;

    ctx.save();
    ctx.translate(spotX, spotY);
    ctx.rotate(holderAngle);
    ctx.scale(1, Math.max(0.12, flatten));
    drawFrame(REMASTER.images.spot, id, SPRITES.spot, -spotSize * 0.5, -spotSize * 0.5, spotSize, spotSize);
    ctx.restore();
  }

  drawTable = function(){
    if (!REMASTER.assetsReady || !REMASTER.images.tableTop || !REMASTER.images.cloth || !REMASTER.images.pockets) {
      if (origDrawTable) return origDrawTable();
      return;
    }

    ctx.clearRect(0,0,CW,CH);
    ctx.fillStyle = '#120603';
    ctx.fillRect(0,0,CW,CH);

    drawImageCover(REMASTER.images.tableTop, 0, 0, CW, CH, 1);
    drawImageCover(REMASTER.images.cloth, PAD-2, PAD-2, CW-(PAD-2)*2, CH-(PAD-2)*2, 0.95);
    drawImageCover(REMASTER.images.pockets, 0, 0, CW, CH, 1);

    ctx.save();
    ctx.globalAlpha = 0.18;
    const feltGrain = ctx.createLinearGradient(PAD, PAD, CW-PAD, CH-PAD);
    feltGrain.addColorStop(0, 'rgba(255,255,255,0.12)');
    feltGrain.addColorStop(0.5, 'rgba(255,255,255,0.01)');
    feltGrain.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = feltGrain;
    ctx.fillRect(PAD, PAD, CW-PAD*2, CH-PAD*2);
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(CW * 0.27, PAD + 6);
    ctx.lineTo(CW * 0.27, CH - PAD - 6);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    ctx.save();
    const railGlow = ctx.createLinearGradient(0,0,0,CH);
    railGlow.addColorStop(0,'rgba(255,160,90,0.16)');
    railGlow.addColorStop(0.5,'rgba(255,120,50,0.03)');
    railGlow.addColorStop(1,'rgba(0,0,0,0.25)');
    ctx.strokeStyle = railGlow;
    ctx.lineWidth = 3;
    ctx.strokeRect(PAD+4, PAD+4, CW-PAD*2-8, CH-PAD*2-8);
    ctx.restore();
  };

  function drawBallShadowAt(x, y, scale=1){
    if (REMASTER.images.shadow) {
      ctx.save();
      ctx.globalAlpha = 0.42;
      ctx.drawImage(REMASTER.images.shadow, x - R*1.04, y - R*0.82 + 4, R*2.08, R*1.64);
      ctx.restore();
    } else {
      ctx.save();
      ctx.globalAlpha = 0.3;
      const g = ctx.createRadialGradient(x+1, y+4, 0, x+1, y+4, R*1.1);
      g.addColorStop(0, 'rgba(0,0,0,0.45)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x+1, y+4, R*1.05, R*0.78, 0, 0, Math.PI*2);
      ctx.fill();
      ctx.restore();
    }
  }

  function getGlowForBall(ball){
    if (ball.type === 'cue') return 'rgba(255,255,255,0.35)';
    if (ball.type === '8ball') return 'rgba(255,140,0,0.28)';
    return EL && EL[ball.type] && EL[ball.type].glow ? EL[ball.type].glow : 'rgba(255,180,80,0.18)';
  }

  drawBall = function(ball){
    if (!ball || ball.sunk) return;
    initBallVisual(ball);

    if (!REMASTER.assetsReady || !REMASTER.images.solids || !REMASTER.images.spot) {
      if (origDrawBall) return origDrawBall(ball);
      return;
    }

    const speed = Math.hypot(ball.vx || 0, ball.vy || 0);
    const glow = getGlowForBall(ball);
    const view = quaternionToView(ball);
    const rot = view.o - Math.PI;

    if (speed > 1.1) {
      ctx.save();
      ctx.globalAlpha = Math.min(0.16, speed * 0.015);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.ellipse(ball.x - (ball.vx||0) * 0.7, ball.y - (ball.vy||0) * 0.7, R * 1.1, R * 0.92, 0, 0, Math.PI*2);
      ctx.fill();
      ctx.restore();
    }

    drawBallShadowAt(ball.x, ball.y);

    ctx.save();
    ctx.translate(ball.x, ball.y);
    ctx.rotate(rot);

    if (ball.type === 'cue') {
      drawFrame(REMASTER.images.solids, 0, SPRITES.solids, -R, -R, R*2, R*2);
    } else if (ball.type === '8ball') {
      drawFrame(REMASTER.images.solids, 8, SPRITES.solids, -R, -R, R*2, R*2);
      drawSpotOnBall(view, 8);
    } else if (ball.stripe) {
      const stripeImg = REMASTER.images['stripe' + ball.id];
      const p = (view.r - 0.5 * Math.PI) / Math.PI;
      const frame = clampV(41 - Math.round(41 * p), 0, 40);
      if (stripeImg) drawFrame(stripeImg, frame, SPRITES.stripe, -R*1.04, -R*1.04, R*2.08, R*2.08);
      drawSpotOnBall(view, ball.id);
    } else {
      const frame = clampV(ball.id, 0, 8);
      drawFrame(REMASTER.images.solids, frame, SPRITES.solids, -R, -R, R*2, R*2);
      drawSpotOnBall(view, ball.id);
    }
    ctx.restore();

    if (REMASTER.images.shade) {
      ctx.save();
      ctx.globalAlpha = 0.32;
      ctx.drawImage(REMASTER.images.shade, ball.x - R*1.05, ball.y - R*1.05, R*2.1, R*2.1);
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = 0.15;
    const ring = ctx.createRadialGradient(ball.x - R*0.34, ball.y - R*0.42, R*0.05, ball.x, ball.y, R*1.38);
    ring.addColorStop(0, 'rgba(255,255,255,0.95)');
    ring.addColorStop(0.22, 'rgba(255,255,255,0.20)');
    ring.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = ring;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, R*1.38, 0, Math.PI*2);
    ctx.fill();
    ctx.restore();
  };

  physStep = function(){
    const all = [G.cue, ...(G.balls || [])].filter(b => b && !b.sunk);
    const STEPS = 8;

    for (let s = 0; s < STEPS; s++) {
      for (const b of all) {
        const dx = (b.vx || 0) / STEPS;
        const dy = (b.vy || 0) / STEPS;
        b.x += dx;
        b.y += dy;
        updateBallQuaternion(b, dx, dy);
      }

      all.forEach(checkPockets);
      all.forEach(resolveWall);

      for (let pass = 0; pass < 3; pass++) {
        for (let i = 0; i < all.length; i++) {
          for (let j = i + 1; j < all.length; j++) {
            resolveBalls(all[i], all[j]);
          }
        }
      }
    }

    all.forEach(b => {
      b.vx *= FRICTION;
      b.vy *= FRICTION;
      if (Math.abs(b.vx) < MIN_V && Math.abs(b.vy) < MIN_V) {
        b.vx = 0;
        b.vy = 0;
      }
    });
  };

  function revealIntroUi(){
    ['intro-logo','intro-sub','intro-btn'].forEach((id, idx) => {
      const node = el(id);
      if (!node) return;
      setTimeout(() => node.classList.add('show'), 60 + idx * 140);
    });
  }

  function hideLoader(){
    const loader = el('loading-screen');
    if (loader) loader.style.display = 'none';
  }

  function showLoader(titleText, statusText){
    const loader = el('loading-screen');
    if (!loader) return;
    loader.style.display = 'flex';
    const fireText = loader.querySelector('.fire-text');
    if (fireText && titleText) fireText.textContent = titleText;
    const status = el('load-status');
    if (status && statusText) status.textContent = statusText;
  }

  function finishBoot(force=false){
    if (REMASTER.bootDone) return;
    const elapsed = performance.now() - REMASTER.bootStartedAt;
    if (!force && elapsed < REMASTER.bootMinMs) {
      setTimeout(() => finishBoot(true), REMASTER.bootMinMs - elapsed + 10);
      return;
    }
    REMASTER.bootDone = true;
    hideLoader();
    showScreen('intro');
  }

  skipLoading = function(){
    const loader = el('loading-screen');
    const loaderVisible = loader && loader.style.display !== 'none';
    if (G && G.phase === 'online-waiting') {
      REMASTER.onlineCancelled = true;
      if (REMASTER.connectRetry) clearTimeout(REMASTER.connectRetry);
      try { if (WS) WS.close(); } catch (e) {}
      hideLoader();
      setOnlineStatus('idle');
      showScreen('menu');
      return;
    }
    if (!loaderVisible && REMASTER.bootDone) return;
    finishBoot(true);
  };

  showScreen = function(n){
    G.phase = n;
    if (n !== 'online-loading') hideLoader();
    ['intro','menu','game','over','shop','online','lb'].forEach(s => {
      const sc = document.getElementById('screen-' + s);
      if (sc) sc.classList.toggle('active', s === n);
    });
    if (n === 'menu' && typeof refreshMenu === 'function') refreshMenu();
    if (n === 'shop' && typeof renderShop === 'function') renderShop();
    if (n === 'intro') revealIntroUi();
  };

  fbCancelMatch = async function(){
    REMASTER.onlineCancelled = true;
    REMASTER.connectGeneration++;
    if (REMASTER.connectRetry) clearTimeout(REMASTER.connectRetry);
    try { if (WS) WS.close(); } catch (e) {}
    hideLoader();
    setOnlineStatus('idle');
  };

  wsConnect = function(onOpen){
    REMASTER.onlineCancelled = false;
    const thisGen = ++REMASTER.connectGeneration;

    if (WS && WS.readyState === WebSocket.OPEN) {
      _serverReady = true;
      onOpen && onOpen();
      return;
    }

    function tryConnect(){
      if (thisGen !== REMASTER.connectGeneration || REMASTER.onlineCancelled) return;
      try {
        WS = new WebSocket(WS_URL);
      } catch (err) {
        REMASTER.connectRetry = setTimeout(tryConnect, 2000);
        return;
      }

      WS.onopen = () => {
        if (thisGen !== REMASTER.connectGeneration) return;
        _serverReady = true;
        hideLoader();
        setOnlineStatus('searching');
        onOpen && onOpen();
      };

      WS.onmessage = (e) => {
        try { origHandleWsMsg ? origHandleWsMsg(JSON.parse(e.data)) : handleWsMsg(JSON.parse(e.data)); } catch (err) {}
      };

      WS.onerror = () => {
        const st = el('load-status');
        if (st && G.phase === 'online-waiting') st.textContent = 'Server is sleeping, retrying...';
      };

      WS.onclose = () => {
        if (thisGen !== REMASTER.connectGeneration || REMASTER.onlineCancelled) return;
        if (G.phase === 'online-waiting') {
          const st = el('load-status');
          if (st) st.textContent = 'Inferno server is waking...';
          REMASTER.connectRetry = setTimeout(tryConnect, 2000);
        } else if (G.phase !== 'over' && G.phase !== 'menu') {
          hideLoader();
          toast2('Baglanti kesildi!');
          showScreen('menu');
        }
      };
    }

    tryConnect();
  };

  startOnlineMode = function(){
    REMASTER.onlineCancelled = false;
    showLoader('🔥 Connecting to Inferno Server...', 'Waking up Inferno server...');
    ['intro','menu','game','over','shop','online','lb'].forEach(s => {
      const sc = document.getElementById('screen-' + s);
      if (sc) sc.classList.remove('active');
    });
    const onl = el('screen-online');
    if (onl) onl.classList.add('active');
    G.phase = 'online-waiting';
    el('online-msg').textContent = 'Connecting to game server...';
    el('online-room-info').textContent = '';
    setOnlineStatus('searching');
    fbFindMatch();
  };

  // More reliable intro and boot flow
  setTimeout(() => finishBoot(false), REMASTER.bootMinMs + 100);
  revealIntroUi();

  // Make sure current balls/cue get upgraded too
  initAllBalls();

  // Extra safety: current menu play button should use patched path
  const playBtn = el('menu-play');
  if (playBtn) playBtn.onclick = () => startGame();
  const introBtn = el('intro-btn');
  if (introBtn) introBtn.onclick = () => { if (typeof getAC === 'function') getAC(); showScreen('menu'); };
})();

/*!
 * ball3d.canvas2d.js — InfernoPool standalone (inferno-pool-test.html) adaptoru
 * -----------------------------------------------------------------------------
 * Cekirdegi (ball3d.core.js) saf Canvas2D build'ine baglar.
 *
 * Bu dosya oyunun fizigine, carpisma cozumune, cep mantigina veya kurallarina
 * HIC dokunmaz. Yalnizca okur: b.x, b.y, b.qr, b.sunk, b.id.
 *
 * Fallback sozlesmesi: WebGL yoksa, GLB yuklenemezse ya da ?ball3d=0 verilirse
 * window.Ball3D.active false kalir ve oyun mevcut 2D drawBall() cizimine
 * kesintisiz devam eder.
 * -----------------------------------------------------------------------------
 */

import { BallRenderer } from './ball3d.core.js';

const CANVAS_ID = 'ball3d-canvas';
// GORECELI yol. CrazyGames / Yandex Games / PixiDusta alt dizinde servis
// edebildigi icin absolute path kullanilmaz.
const GLB_URL = 'assets/billiards_balls.glb';

const api = {
  ready: false,
  active: false,
  renderer: null,
  report: null,
  error: null,
  sync: function () {},
  disable: function () { api.active = false; },
  enable: function () { if (api.ready) api.active = true; },
};

window.Ball3D = api;

function forced2D() {
  if (window.BALL3D_FORCE_2D) return true;
  try {
    return new URLSearchParams(window.location.search).get('ball3d') === '0';
  } catch (e) {
    return false;
  }
}

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext &&
      (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (e) {
    return false;
  }
}

function pickPixelRatio() {
  const dpr = window.devicePixelRatio || 1;
  const cores = navigator.hardwareConcurrency || 4;
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  // Toplar ekranda ~20px. Mobilde 1.5x zaten fazlasiyla temiz, 2x bosuna fragman.
  if (coarse && cores <= 4) return Math.min(dpr, 1.25);
  if (coarse) return Math.min(dpr, 1.5);
  return Math.min(dpr, 2);
}

async function boot() {
  if (forced2D()) {
    console.info('[Ball3D] 2D fallback zorlandi — 3D toplar devre disi.');
    return;
  }
  if (!hasWebGL()) {
    console.warn('[Ball3D] WebGL yok — 2D drawBall() fallback aktif.');
    return;
  }

  const view = window.BALL3D_VIEW;
  const canvas = document.getElementById(CANVAS_ID);
  if (!view || !canvas) {
    console.warn('[Ball3D] BALL3D_VIEW veya #' + CANVAS_ID + ' bulunamadi — fallback aktif.');
    return;
  }

  const renderer = new BallRenderer({
    canvas: canvas,
    glbUrl: GLB_URL,
    width: view.CW,
    height: view.CH,
    ballRadiusPx: view.R,
    maxPixelRatio: pickPixelRatio(),
  });

  let report;
  try {
    report = await renderer.init();
  } catch (err) {
    api.error = err;
    console.warn('[Ball3D] GLB yuklenemedi, 2D fallback aktif:', err);
    try { renderer.dispose(); } catch (e) { /* yut */ }
    return;
  }

  api.renderer = renderer;
  api.report = report;
  api.ready = true;
  api.active = true;

  if (report.missing.length) {
    console.warn('[Ball3D] GLB icinde eslesmeyen top id\'leri:', report.missing);
  }
  if (report.unmatched.length) {
    console.warn('[Ball3D] Adi cozulemeyen node\'lar:', report.unmatched);
  }
  console.info('[Ball3D] hazir —', report.matched.length, '/ 16 top eslesti.');

  /**
   * Her karede oyun durumunu 3D katmana yansitir.
   * @param {object} G Oyun durumu (loop() icinden gecilir)
   */
  api.sync = function (G) {
    if (!api.active || !G) return;

    const cue = G.cue;
    if (cue) renderer.setBall(0, cue.x, cue.y, cue.qr, !cue.sunk);
    else renderer.setBall(0, 0, 0, null, false);

    const seen = new Set([0]);
    const balls = G.balls || [];
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (!b || b.id == null) continue;
      seen.add(b.id);
      renderer.setBall(b.id, b.x, b.y, b.qr, !b.sunk);
    }
    // Rack'te olmayan id'leri gizli tut (ornegin farkli mod/dizilim).
    for (let id = 1; id <= 15; id++) {
      if (!seen.has(id)) renderer.setBall(id, 0, 0, null, false);
    }

    renderer.render();
  };

  api.disable = function () {
    api.active = false;
    for (let id = 0; id <= 15; id++) renderer.setBall(id, 0, 0, null, false);
    renderer.render(true);
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

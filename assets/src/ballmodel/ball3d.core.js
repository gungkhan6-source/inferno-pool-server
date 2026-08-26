/*!
 * ball3d.core.js — InfernoPool
 * -----------------------------------------------------------------------------
 * billiards_balls.glb tabanli GERCEK 3D top render katmani.
 *
 * Bu modul MOTOR BAGIMSIZDIR. Fizik bilmez, oyun kurallari bilmez.
 * Tek girdisi ekran uzayi: piksel konum (+X sag, +Y ASAGI) ve bir yonelim
 * quaternion'u. Ciktisi seffaf bir WebGL tuvali. Fizik <-> gorsel ayrimi
 * boylece tek yonlu kalir: fizik uretir, bu katman tuketir.
 *
 * 3D asset attribution:
 *   "Billiard Balls" by Yanez Designs — Sketchfab
 *   https://sketchfab.com/3d-models/billiard-balls-523ac862d2154a7e8c96b964fb7cb11f
 *   License: Creative Commons Attribution (CC BY)
 *   Model olcek/yon bakimindan oyuna uyarlanmistir; atif yukumlulugu devam eder.
 * -----------------------------------------------------------------------------
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/** Istaka (beyaz) topun dahili id'si. Her iki build de 0 kullaniyor. */
export const CUE_BALL_ID = 0;

/**
 * Modelin kanonik temel yonelimi.
 *
 * Olculen gercek: mesh yerel uzayinda numara cikartmasi -Y yonune, serit/kutup
 * ekseni ise ±Z yonune bakiyor. GLB'deki Ball1..Ball15 node'lari X'te -120°
 * dondurulmus (numara yukari kaciyor, seritler yamuk duruyor); Ball Clube ise
 * dogru yonde. X'te -90° donus numarayi tam one, seridi yatay banda getiriyor.
 * Bu yuzden node rotasyonlari yok sayilir ve 16 topun hepsine bu tek quaternion
 * uygulanir.
 */
export const BASE_QUAT = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);

/**
 * GLB node adindan oyun top id'sine cevirir.
 *
 * GLTFLoader node adlarindaki boslugu '_' yapar ve '.' karakterini atar, o
 * yuzden hem "Ball12_21 - Default_0" hem "Ball12_21_-_Default_0" desteklenir.
 * DIKKAT: name.startsWith('Ball1') kullanilmaz — Ball10..Ball15'i de yakalar.
 *
 * @param {string} rawName
 * @returns {number|null} 0..15 arasi id, eslesmezse null
 */
export function nodeNameToBallId(rawName) {
  const n = String(rawName || '').trim();
  const m = /^Ball[_\s]*(\d+)(?:[_\s-]|$)/.exec(n);
  if (m) {
    const v = parseInt(m[1], 10);
    if (v >= 1 && v <= 15) return v;
  }
  if (/^Ball[_\s]*(clube|cue|white)/i.test(n)) return CUE_BALL_ID;
  return null;
}

/**
 * Kucuk bir equirect gradyandan PMREM ortam haritasi uretir.
 *
 * GLB materyalleri metalness 0.4 ile geliyor; yansitacak bir ortam olmadan
 * mat ve olu gorunurler. Harici bir HDR dosyasi eklemek yerine 64x32'lik bir
 * gradyan yeterli — dagitim boyutuna hicbir sey eklemiyor.
 */
function makeEnvironment(renderer) {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 32;
  const g = c.getContext('2d');

  const sky = g.createLinearGradient(0, 0, 0, 32);
  sky.addColorStop(0.00, '#ffffff');
  sky.addColorStop(0.45, '#a8bccd');
  sky.addColorStop(0.55, '#3d454c');
  sky.addColorStop(1.00, '#0a0d11');
  g.fillStyle = sky;
  g.fillRect(0, 0, 64, 32);

  // Sol-ust anahtar isik lekesi: 2D cizimdeki (-R*0.32, -R*0.35) parlamayi taklit eder.
  const key = g.createRadialGradient(15, 7, 0, 15, 7, 13);
  key.addColorStop(0, 'rgba(255,255,255,1)');
  key.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = key;
  g.fillRect(0, 0, 64, 32);

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromEquirectangular(tex);
  pmrem.dispose();
  tex.dispose();
  return rt;
}

export class BallRenderer {
  /**
   * @param {object} opts
   * @param {HTMLCanvasElement} opts.canvas   Seffaf overlay tuvali
   * @param {string} opts.glbUrl              GORECELI yol (absolute path YOK)
   * @param {number} opts.width               Mantiksal tuval genisligi (px)
   * @param {number} opts.height              Mantiksal tuval yuksekligi (px)
   * @param {number} opts.ballRadiusPx        Fizikteki top yaricapinin piksel karsiligi
   * @param {number} [opts.maxPixelRatio=2]
   */
  constructor(opts) {
    this.canvas = opts.canvas;
    this.glbUrl = opts.glbUrl;
    this.width = opts.width;
    this.height = opts.height;
    this.ballRadiusPx = opts.ballRadiusPx;
    this.maxPixelRatio = opts.maxPixelRatio != null ? opts.maxPixelRatio : 2;

    this.ready = false;
    this.balls = new Map();   // id -> THREE.Mesh
    this.report = { matched: [], unmatched: [], missing: [] };

    this._dirty = true;
    this._tmpQ = new THREE.Quaternion();
    this._last = new Map();   // id -> {x,y,qw,qx,qy,qz,v}
  }

  async init() {
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: dpr < 2,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.width, this.height, false);
    this.renderer.setClearAlpha(0);
    // Materyalleri oldugu gibi birakabilmek icin tone mapping kapali.
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.scene = new THREE.Scene();

    // Ortografik kamera: dunya birimi == piksel. Fizik merkezi ile model merkezi
    // birebir ortusur, perspektif kaymasi olmaz.
    this.camera = new THREE.OrthographicCamera(
      -this.width / 2, this.width / 2,
      this.height / 2, -this.height / 2,
      -1000, 1000
    );
    this.camera.position.set(0, 0, 100);
    this.camera.lookAt(0, 0, 0);

    this._envRT = makeEnvironment(this.renderer);
    this.scene.environment = this._envRT.texture;

    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-0.55, 0.75, 1).multiplyScalar(10);
    this.scene.add(key);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));

    const gltf = await new GLTFLoader().loadAsync(this.glbUrl);
    this._buildBalls(gltf);

    this.ready = true;
    this._dirty = true;
    return this.report;
  }

  _buildBalls(gltf) {
    const meshes = [];
    gltf.scene.traverse((o) => { if (o.isMesh) meshes.push(o); });

    for (const mesh of meshes) {
      let id = nodeNameToBallId(mesh.name);
      if (id == null && mesh.parent) id = nodeNameToBallId(mesh.parent.name);
      if (id == null) {
        this.report.unmatched.push(mesh.name);
        continue;
      }
      if (this.balls.has(id)) {
        this.report.unmatched.push(mesh.name + ' (dublicate id ' + id + ')');
        continue;
      }

      // Mesh'i kendi sahnemize tasi ve GLB'deki rack yerlesim transformunu at.
      mesh.removeFromParent();
      mesh.position.set(0, 0, 0);
      mesh.quaternion.copy(BASE_QUAT);
      mesh.matrixAutoUpdate = true;

      // Olculen gercek: mesh origin'i bbox merkezinde degil (Y'de ~0.0005 kayik).
      // Merkezlenmezse top donerken yalpalar.
      const geo = mesh.geometry;
      geo.computeBoundingSphere();
      const bs = geo.boundingSphere;
      geo.translate(-bs.center.x, -bs.center.y, -bs.center.z);
      geo.computeBoundingSphere();

      // Olcek modelden olculur, sabitten degil: GLB degisirse kod bozulmaz.
      const modelR = geo.boundingSphere.radius || 1;
      mesh.scale.setScalar(this.ballRadiusPx / modelR);

      // Kapali kureler; arka yuzleri cizmenin anlami yok (mobil kazanc).
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) if (mat) mat.side = THREE.FrontSide;

      mesh.visible = false;
      mesh.renderOrder = id;
      this.scene.add(mesh);
      this.balls.set(id, mesh);
      this.report.matched.push({ id, node: mesh.name });
    }

    for (let i = 0; i <= 15; i++) {
      if (!this.balls.has(i)) this.report.missing.push(i);
    }
    this.report.matched.sort((a, b) => a.id - b.id);
  }

  /**
   * Bir topun ekran durumunu yazar. Fizigi HIC etkilemez.
   *
   * @param {number} id       0 = istaka topu, 1..15 = numarali toplar
   * @param {number} x        Tuval x (px, sola 0)
   * @param {number} y        Tuval y (px, YUKARIDAN asagi)
   * @param {number[]|null} q Yonelim [w,x,y,z] — oyun cercevesinde
   *                          (+X sag, +Y ASAGI, +Z izleyiciye dogru)
   * @param {boolean} visible
   */
  setBall(id, x, y, q, visible) {
    const mesh = this.balls.get(id);
    if (!mesh) return;

    const qw = q ? q[0] : 1, qx = q ? q[1] : 0, qy = q ? q[2] : 0, qz = q ? q[3] : 0;
    const prev = this._last.get(id);
    if (prev && prev.v === visible && prev.x === x && prev.y === y &&
        prev.qw === qw && prev.qx === qx && prev.qy === qy && prev.qz === qz) {
      return;
    }
    this._last.set(id, { x, y, qw, qx, qy, qz, v: visible });
    this._dirty = true;

    mesh.visible = !!visible;
    if (!visible) return;

    // Ekran uzayi (Y asagi) -> three dunyasi (Y yukari)
    mesh.position.set(x - this.width / 2, -(y - this.height / 2), 0);

    // Ayni Y yansimasi altinda rotasyon quaternion'u (w,x,y,z) -> (w,-x,y,-z)
    // olur (donme ekseni bir pseudovektor oldugu icin isaret degisir).
    this._tmpQ.set(-qx, qy, -qz, qw);
    mesh.quaternion.copy(this._tmpQ).multiply(BASE_QUAT);
  }

  /** Degisiklik yoksa GPU'ya hic dokunmaz — bos beklemede mobil pil kazanci. */
  render(force) {
    if (!this.ready) return false;
    if (!this._dirty && !force) return false;
    this.renderer.render(this.scene, this.camera);
    this._dirty = false;
    return true;
  }

  setViewport(width, height) {
    this.width = width;
    this.height = height;
    this.camera.left = -width / 2;
    this.camera.right = width / 2;
    this.camera.top = height / 2;
    this.camera.bottom = -height / 2;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this._last.clear();
    this._dirty = true;
  }

  setBallRadiusPx(r) {
    this.ballRadiusPx = r;
    for (const mesh of this.balls.values()) {
      const mr = mesh.geometry.boundingSphere ? mesh.geometry.boundingSphere.radius : 1;
      mesh.scale.setScalar(r / (mr || 1));
    }
    this._dirty = true;
  }

  dispose() {
    for (const mesh of this.balls.values()) {
      mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (!m) continue;
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']) {
          if (m[k]) m[k].dispose();
        }
        m.dispose();
      }
    }
    this.balls.clear();
    this._last.clear();
    if (this._envRT) this._envRT.dispose();
    if (this.renderer) this.renderer.dispose();
    this.ready = false;
  }
}

export default BallRenderer;

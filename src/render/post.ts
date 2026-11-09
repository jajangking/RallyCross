import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/**
 * Post-processing "setengah-AC": **AO kontak (GTAO) + bloom + tone mapping**
 * lewat `EffectComposer`. Sengaja tanpa DOF, motion blur, dan TAA — tiga efek
 * itu yang paling mahal dan paling mudah bikin HP tersendat.
 *
 * Semuanya berjalan di resolusi buffer yang sama dengan kanvas; AO memakai
 * sampel sedikit (8) dan radius kecil, karena yang penting cuma bayangan
 * kontak di sudut kotak servis, bawah mobil, dan bibir kerb.
 */
export interface PostStack {
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  readonly gtao: GTAOPass;
  render(): void;
  setSize(width: number, height: number, pixelRatio: number): void;
  /** Matikan/hidupkan AO (mis. saat frame drop). */
  setAo(on: boolean): void;
}

export interface PostOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  width: number;
  height: number;
  pixelRatio: number;
  /** Kekuatan bloom. 0 = mati. */
  bloomStrength?: number;
  /** Jumlah sampel MSAA di buffer composer (0 = mati). */
  msaa?: number;
}

export function createPost(options: PostOptions): PostStack | null {
  const { renderer, scene, camera } = options;
  const width = Math.max(2, Math.floor(options.width));
  const height = Math.max(2, Math.floor(options.height));
  const pixelRatio = Math.max(0.5, options.pixelRatio);

  try {
    // Buffer sendiri supaya MSAA (tepi mobil, kerb, dan pagar) tetap halus.
    // Tanpa ini composer selalu tanpa anti-alias, sekeras apa pun `antialias`
    // di renderer. `HalfFloat` wajib supaya bloom tidak pecah di area terang.
    const target = new THREE.WebGLRenderTarget(
      Math.floor(width * pixelRatio),
      Math.floor(height * pixelRatio),
      {
        type: THREE.HalfFloatType,
        samples: Math.max(0, Math.floor(options.msaa ?? 0)),
      },
    );
    const composer = new EffectComposer(renderer, target);
    composer.setPixelRatio(pixelRatio);
    composer.setSize(width, height);
    composer.addPass(new RenderPass(scene, camera));

    // --- AO kontak: inilah yang membuat objek terasa "menempel" di tanah ---
    const gtao = new GTAOPass(scene, camera, width, height);
    gtao.output = GTAOPass.OUTPUT.Default;
    gtao.blendIntensity = 0.85;
    gtao.updateGtaoMaterial({
      radius: 0.5,
      distanceExponent: 1.6,
      thickness: 1.2,
      scale: 1.1,
      samples: 8,
      distanceFallOff: 1,
      screenSpaceRadius: false,
    });
    composer.addPass(gtao);

    // --- bloom halus: kilau matahari, lampu, dan bagian bodi yang mengkilap ---
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(width / 2, height / 2),
      options.bloomStrength ?? 0.26,
      0.55,
      0.86,
    );
    composer.addPass(bloom);

    // OutputPass: tone mapping + konversi warna (wajib saat memakai composer).
    composer.addPass(new OutputPass());

    return {
      composer,
      bloom,
      gtao,
      render: () => composer.render(),
      setSize: (w, h, ratio) => {
        const cw = Math.max(2, Math.floor(w));
        const ch = Math.max(2, Math.floor(h));
        composer.setPixelRatio(ratio);
        composer.setSize(cw, ch);
        gtao.setSize(cw, ch);
        bloom.setSize(cw / 2, ch / 2);
      },
      setAo: (on) => {
        gtao.enabled = on;
      },
    };
  } catch (err) {
    console.warn('post-processing dilewati:', err);
    return null;
  }
}

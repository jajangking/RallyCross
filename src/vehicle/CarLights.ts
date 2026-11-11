import * as THREE from 'three';
import { surface } from '../world/style';
import type { VehicleConfig } from './VehiclePhysics';
import { roundedBox } from './carParts';

export interface CarLightState {
  /** 0..1 brake pedal opening. */
  brake: number;
  /** Reverse gear engaged. */
  reverse: boolean;
  left: boolean;
  right: boolean;
  hazard: boolean;
  headlights: boolean;
}

export interface CarLightReadings {
  tail: number;
  reverse: number;
  head: number;
  amberLeft: number;
  amberRight: number;
  blinkOn: boolean;
}

const BLINK_HALF_PERIOD = 0.42; // on for 0.42 s, off for 0.42 s

/**
 * Turns the driver's inputs into lamp intensities. Kept free of geometry so the
 * procedural car and an imported GLB model can share exactly the same timing,
 * easing and blink behaviour.
 */
export class LampController {
  private tail = 0.6;
  private head = 0.2;
  private reverse = 0;
  private amberLeft = 0;
  private amberRight = 0;
  private blinkPhaseOn = true;
  private blinkTimer = 0;
  private wasLeft = false;
  private wasRight = false;
  private spot = 0;

  /** Current beam intensity, already eased by the head light switch. */
  get spotIntensity() {
    return this.spot;
  }

  /** True while the indicators are in their "on" half of the blink cycle. */
  get blinkOn() {
    return this.blinkPhaseOn;
  }

  update(dt: number, state: CarLightState): CarLightReadings {
    /* brake lights: bright when the pedal is pressed, dim tail otherwise */
    const tailTarget = THREE.MathUtils.clamp(state.brake, 0, 1) > 0.05 ? 3.6 : 0.6;
    this.tail += (tailTarget - this.tail) * Math.min(1, dt * 14);

    /* reverse lamp follows the manual gear */
    this.reverse = state.reverse ? 2.6 : 0;

    /* head lamps + spot lights */
    this.head = state.headlights ? 3.2 : 0.2;
    const spotTarget = state.headlights ? 260 : 0;
    this.spot += (spotTarget - this.spot) * Math.min(1, dt * 6);

    /* indicators: restarted instantly when the selection changes */
    const wantLeft = state.hazard || state.left;
    const wantRight = state.hazard || state.right;
    if (wantLeft !== this.wasLeft || wantRight !== this.wasRight) {
      this.blinkTimer = 0;
      this.blinkPhaseOn = true;
      this.wasLeft = wantLeft;
      this.wasRight = wantRight;
    } else {
      this.blinkTimer += dt;
      if (this.blinkTimer >= BLINK_HALF_PERIOD) {
        this.blinkTimer -= BLINK_HALF_PERIOD;
        this.blinkPhaseOn = !this.blinkPhaseOn;
      }
    }

    const amber = this.blinkPhaseOn ? 3.6 : 0;
    this.amberLeft = wantLeft ? amber : 0;
    this.amberRight = wantRight ? amber : 0;

    return {
      tail: this.tail,
      reverse: this.reverse,
      head: this.head,
      amberLeft: this.amberLeft,
      amberRight: this.amberRight,
      blinkOn: this.blinkPhaseOn,
    };
  }
}

/**
 * Head lights, brake lights, reverse lights and turn signals. Everything is
 * driven from the simulation state (brake pedal, gear, indicator selection),
 * never from a static material.
 */
export class CarLights {
  readonly group = new THREE.Group();
  readonly lamp = new LampController();

  private readonly headMat: THREE.MeshStandardMaterial;
  private readonly tailMat: THREE.MeshStandardMaterial;
  private readonly reverseMat: THREE.MeshStandardMaterial;
  private readonly amberLeftMat: THREE.MeshStandardMaterial;
  private readonly amberRightMat: THREE.MeshStandardMaterial;


  constructor(parent: THREE.Object3D, cfg: VehicleConfig, _detail: boolean) {
    const L = cfg.halfLength;
    const lampMat = (
      color: number,
      emissive: number,
      intensity: number,
    ) =>
      surface({ color, emissive, emissiveIntensity: intensity });

    this.headMat = lampMat(0xdfe4ea, 0xfff4d6, 0.2);
    this.tailMat = lampMat(0x330603, 0xff1508, 0.6);
    this.reverseMat = lampMat(0xcdd4db, 0xeef4ff, 0);
    this.amberLeftMat = lampMat(0x3a1c00, 0xff7a0a, 0);
    this.amberRightMat = lampMat(0x3a1c00, 0xff7a0a, 0);

    const add = (
      w: number,
      h: number,
      d: number,
      x: number,
      y: number,
      z: number,
      mat: THREE.Material,
    ) => {
      const mesh = roundedBox(w, h, d, 0.02, mat);
      mesh.position.set(x, y, z);
      this.group.add(mesh);
      return mesh;
    };

    // head lamps + front indicators
    for (const side of [-1, 1]) {
      add(0.4, 0.13, 0.07, side * 0.52, 0.1, L + 0.045, this.headMat);
      add(0.13, 0.07, 0.075, side * 0.79, 0.0, L + 0.05, side < 0 ? this.amberLeftMat : this.amberRightMat);
      // tail lamps, reverse lamps + rear indicators
      add(0.44, 0.14, 0.075, side * 0.56, 0.16, -L - 0.055, this.tailMat);
      add(0.13, 0.09, 0.075, side * 0.76, 0.02, -L - 0.05, this.reverseMat);
      add(0.11, 0.09, 0.075, side * 0.8, 0.11, -L - 0.05, side < 0 ? this.amberLeftMat : this.amberRightMat);
    }

    // Dulu ada dua SpotLight per mobil untuk sorot lampu utama. Dengan enam
    // mobil itu berarti 12 lampu: setiap fragment semua material menghitung
    // ke-12-nya. Lampu emissive di atas sudah cukup, dan
    // seluruh scene jadi jauh lebih ringan.

    parent.add(this.group);
  }

  update(dt: number, state: CarLightState) {
    const read = this.lamp.update(dt, state);

    this.tailMat.emissiveIntensity = read.tail;
    this.reverseMat.emissiveIntensity = read.reverse;
    this.headMat.emissiveIntensity = read.head;
    this.amberLeftMat.emissiveIntensity = read.amberLeft;
    this.amberRightMat.emissiveIntensity = read.amberRight;
  }

  /** Exposed for the browser regression check. */
  get readings(): CarLightReadings {
    return {
      tail: this.tailMat.emissiveIntensity,
      reverse: this.reverseMat.emissiveIntensity,
      head: this.headMat.emissiveIntensity,
      amberLeft: this.amberLeftMat.emissiveIntensity,
      amberRight: this.amberRightMat.emissiveIntensity,
      blinkOn: this.lamp.blinkOn,
    };
  }
}

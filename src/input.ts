import type { GearDirection, VehicleInput } from './vehicle/VehiclePhysics';

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const toward = (cur: number, target: number, maxStep: number) =>
  Math.abs(target - cur) <= maxStep ? target : cur + Math.sign(target - cur) * maxStep;

/* keyboard only: how fast a held key reaches full travel (per second) */
const KEY_GAS_ATTACK = 3.0; // full gas in ~0.33 s
const KEY_BRAKE_ATTACK = 5.0;
const KEY_STEER_ATTACK = 4.5; // full lock in ~0.22 s

/* how fast a control springs back when released */
const PEDAL_RELEASE = 7.0;
const STEER_RELEASE = 8.0;

export interface InputActions {
  reset(): void;
  camera(): void;
  gui(): void;
  ai(): void;
}

interface SliderOpts {
  axis: 'x' | 'y';
  min: number;
  max: number;
  rest: number;
  releaseRate: number;
}

/**
 * Touch control whose position is the value, 1:1 with the finger.
 * Hold it to keep that opening; let go and it springs back to `rest`.
 */
class TouchSlider {
  value: number;
  held = false;

  private readonly track: HTMLElement;
  private activePid: number | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly opts: SliderOpts,
  ) {
    const track = root.querySelector<HTMLElement>('.track');
    if (!track) throw new Error('slider is missing .track');
    this.track = track;
    this.value = opts.rest;

    root.addEventListener('pointerdown', this.onDown);
    root.addEventListener('pointermove', this.onMove);
    root.addEventListener('pointerup', this.onUp);
    root.addEventListener('pointercancel', this.onUp);
    root.addEventListener('lostpointercapture', this.onUp);
    root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private setFromEvent(e: PointerEvent) {
    const r = this.track.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const f =
      this.opts.axis === 'x' ? (e.clientX - r.left) / r.width : 1 - (e.clientY - r.top) / r.height;
    this.value = this.opts.min + clamp(f, 0, 1) * (this.opts.max - this.opts.min);
  }

  private onDown = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Ignore a second finger on the same control: the first one keeps ownership.
    if (this.activePid !== null && this.activePid !== e.pointerId) return;
    this.activePid = e.pointerId;
    this.held = true;
    this.setFromEvent(e);
    this.root.classList.add('on');
    try {
      this.root.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers (tests) have no capture target */
    }
  };

  private onMove = (e: PointerEvent) => {
    if (!this.held || e.pointerId !== this.activePid) return;
    e.preventDefault();
    this.setFromEvent(e);
  };

  private onUp = (e: PointerEvent) => {
    if (this.activePid !== null && e.pointerId !== this.activePid) return;
    this.release();
  };

  release() {
    if (!this.held && this.activePid === null) return;
    this.held = false;
    this.activePid = null;
    this.root.classList.remove('on');
  }

  /** Springs to the keyboard target, or to rest when no key is held. */
  update(dt: number, keyTarget: number, attack: number) {
    if (this.held) return;
    const rate = keyTarget !== 0 ? attack : this.opts.releaseRate;
    this.value = toward(this.value, keyTarget !== 0 ? keyTarget : this.opts.rest, rate * dt);
  }

  render() {
    this.root.style.setProperty('--v', this.value.toFixed(3));
  }
}

type TouchKey = 'hand';

export interface LightControls {
  left: boolean;
  right: boolean;
  hazard: boolean;
  headlights: boolean;
}

export class Input {
  /** Analogue throughout: throttle/brake 0..1, steer -1..1, gear D/R. */
  readonly state: VehicleInput = { throttle: 0, brake: 0, steer: 0, handbrake: false, gear: 1 };
  readonly isTouch: boolean;

  /** Sein kiri/kanan, hazard, dan lampu utama — tidak menyentuh fisika. */
  readonly lights: LightControls = { left: false, right: false, hazard: false, headlights: false };

  private readonly keys = new Set<string>();
  private readonly touch: Record<TouchKey, boolean> = { hand: false };
  private gearBtn: HTMLButtonElement | null = null;
  private gearShown: GearDirection | null = null;
  private lampButtons: HTMLButtonElement[] = [];
  private aiButton: HTMLButtonElement | null = null;

  private steer: TouchSlider | null = null;
  private gas: TouchSlider | null = null;
  private brake: TouchSlider | null = null;

  constructor(private readonly actions: InputActions) {
    this.isTouch =
      typeof window !== 'undefined' &&
      (window.matchMedia('(pointer: coarse)').matches ||
        'ontouchstart' in window ||
        new URLSearchParams(location.search).has('touch'));

    if (this.isTouch) document.body.classList.add('is-touch');

    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.clear());
    this.bindTouch();
    this.bindLamps();
    this.syncGearButton();
  }

  get gear(): GearDirection {
    return this.state.gear;
  }

  /** Gigi mundur manual: D <-> R. Mobil sendiri yang memutuskan kapan boleh masuk. */
  toggleGear() {
    this.state.gear = this.state.gear === 1 ? -1 : 1;
    this.syncGearButton();
  }

  setGear(gear: GearDirection) {
    this.state.gear = gear;
    this.syncGearButton();
  }

  /** Nyalakan/matikan tampilan tombol AI di layar sentuh. */
  setAi(on: boolean) {
    const btn = this.aiButton;
    if (!btn) return;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  toggleSignal(side: 'left' | 'right') {
    const on = !this.lights[side];
    this.lights.left = side === 'left' ? on : false;
    this.lights.right = side === 'right' ? on : false;
    this.syncLamps();
  }

  toggleHazard() {
    this.lights.hazard = !this.lights.hazard;
    this.syncLamps();
  }

  toggleHeadlights() {
    this.lights.headlights = !this.lights.headlights;
    this.syncLamps();
  }

  private bindLamps() {
    this.lampButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('#lampbar button[data-lamp]'),
    );
    for (const btn of this.lampButtons) {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (btn.dataset.lamp === 'left') this.toggleSignal('left');
        else if (btn.dataset.lamp === 'right') this.toggleSignal('right');
        else if (btn.dataset.lamp === 'hazard') this.toggleHazard();
        else this.toggleHeadlights();
      });
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    this.syncLamps();

    // Touch has no keyboard, so the AI toggle and the tuning panel need
    // buttons of their own.
    this.aiButton = document.querySelector<HTMLButtonElement>('#lampbar button[data-ai]');
    if (this.aiButton) {
      this.aiButton.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.actions.ai();
      });
      this.aiButton.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    const panelBtn = document.querySelector<HTMLButtonElement>('#lampbar button[data-panel]');
    if (panelBtn) {
      panelBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.actions.gui();
      });
      panelBtn.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }

  private syncLamps() {
    for (const btn of this.lampButtons) {
      const key = btn.dataset.lamp;
      const on =
        key === 'left'
          ? this.lights.left
          : key === 'right'
            ? this.lights.right
            : key === 'hazard'
              ? this.lights.hazard
              : this.lights.headlights;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
    }
  }

  private syncGearButton() {
    if (!this.gearBtn || this.gearShown === this.state.gear) return;
    this.gearShown = this.state.gear;
    const reverse = this.state.gear === -1;
    this.gearBtn.textContent = reverse ? 'R' : 'D';
    this.gearBtn.classList.toggle('on', reverse);
    this.gearBtn.setAttribute('aria-pressed', String(reverse));
  }

  private onKeyDown(e: KeyboardEvent) {
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    if (e.repeat) return;

    this.keys.add(e.code);

    switch (e.code) {
      case 'KeyR':
        this.actions.reset();
        break;
      case 'KeyC':
        this.actions.camera();
        break;
      case 'KeyG':
        this.actions.gui();
        break;
      case 'KeyP':
        this.actions.ai();
        break;
      case 'KeyQ':
        this.toggleGear();
        break;
      case 'KeyZ':
        this.toggleSignal('left');
        break;
      case 'KeyX':
        this.toggleSignal('right');
        break;
      case 'KeyH':
        this.toggleHazard();
        break;
      case 'KeyL':
        this.toggleHeadlights();
        break;
    }
  }

  private bindTouch() {
    for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('#touch button'))) {
      const key = btn.dataset.k as TouchKey | undefined;
      if (!key) continue;

      const down = (e: PointerEvent) => {
        e.preventDefault();
        this.touch[key] = true;
        btn.classList.add('on');
        btn.setPointerCapture?.(e.pointerId);
      };
      const up = (e: PointerEvent) => {
        e.preventDefault();
        this.touch[key] = false;
        btn.classList.remove('on');
      };

      btn.addEventListener('pointerdown', down);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('lostpointercapture', up);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    this.gearBtn = document.querySelector<HTMLButtonElement>('#touch button[data-gear]');
    if (this.gearBtn) {
      this.gearBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.toggleGear();
      });
      this.gearBtn.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    const ctl = (id: string) => document.querySelector<HTMLElement>(`#touch [data-ctl="${id}"]`);
    const steerEl = ctl('steer');
    const gasEl = ctl('gas');
    const brakeEl = ctl('brake');

    if (steerEl) {
      this.steer = new TouchSlider(steerEl, { axis: 'x', min: -1, max: 1, rest: 0, releaseRate: STEER_RELEASE });
    }
    if (gasEl) {
      this.gas = new TouchSlider(gasEl, { axis: 'y', min: 0, max: 1, rest: 0, releaseRate: PEDAL_RELEASE });
    }
    if (brakeEl) {
      this.brake = new TouchSlider(brakeEl, { axis: 'y', min: 0, max: 1, rest: 0, releaseRate: PEDAL_RELEASE });
    }
  }

  clear() {
    this.keys.clear();
    this.touch.hand = false;
    this.steer?.release();
    this.gas?.release();
    this.brake?.release();
    document.querySelectorAll('#touch button.on').forEach((b) => b.classList.remove('on'));
    this.gearShown = null;
    this.syncGearButton();
  }

  update(dt = 1 / 60) {
    const k = this.keys;

    /* keyboard: progressive attack, so a tap gives a small opening */
    const gasKey = k.has('KeyW') || k.has('ArrowUp');
    const brakeKey = k.has('KeyS') || k.has('ArrowDown');
    const steerKey =
      (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);

    this.gas?.update(dt, gasKey ? 1 : 0, KEY_GAS_ATTACK);
    this.brake?.update(dt, brakeKey ? 1 : 0, KEY_BRAKE_ATTACK);
    this.steer?.update(dt, steerKey, KEY_STEER_ATTACK);

    const gas = this.gas ? this.gas.value : gasKey ? 1 : 0;
    const brake = this.brake ? this.brake.value : brakeKey ? 1 : 0;

    // Gas and brake are independent pedals now: the brake never turns into
    // reverse, that is what the manual R gear is for.
    this.state.throttle = clamp(gas, 0, 1);
    this.state.brake = clamp(brake, 0, 1);
    this.state.steer = this.steer ? this.steer.value : steerKey;
    this.state.handbrake = k.has('Space') || this.touch.hand;
    this.syncGearButton();

    this.steer?.render();
    this.gas?.render();
    this.brake?.render();
  }
}

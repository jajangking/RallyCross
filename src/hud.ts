import * as THREE from 'three';
import type { VehiclePhysics } from './vehicle/VehiclePhysics';

const RAD2DEG = 180 / Math.PI;
const fwd = new THREE.Vector3();

export class Hud {
  private readonly speedEl = document.getElementById('speed')!;
  private readonly gearEl = document.getElementById('gear')!;
  private readonly telemEl = document.getElementById('telem')!;
  private readonly autoEl = document.getElementById('auto');
  private readonly rivalEl = document.getElementById('rival');
  private readonly finishEl = document.getElementById('finish');
  private readonly tvEl = document.getElementById('tv');
  private readonly indLeft = document.getElementById('ind-left');
  private readonly indRight = document.getElementById('ind-right');
  private readonly indBeam = document.getElementById('ind-beam');
  private readonly bars: Array<{ root: HTMLElement; fill: HTMLElement }> = [];
  private readonly maxLoad: number;
  private accum = 0;

  constructor(mass: number) {
    const host = document.getElementById('bars')!;
    for (let i = 0; i < 4; i++) {
      const root = document.createElement('div');
      root.className = 'bar air';
      const fill = document.createElement('i');
      root.appendChild(fill);
      host.appendChild(root);
      this.bars.push({ root, fill });
    }
    this.maxLoad = ((mass * 9.81) / 4) * 3.2;
  }

  /** Turn-signal / hazard / head-light repeaters. */
  setLamps(state: { left: boolean; right: boolean; hazard: boolean; headlights: boolean }) {
    const left = state.hazard || state.left;
    const right = state.hazard || state.right;
    this.indLeft?.classList.toggle('on', left);
    this.indRight?.classList.toggle('on', right);
    this.indBeam?.classList.toggle('on', state.headlights);
  }

  /** Baris status AI: menyala, nomor lap, waktu lap terakhir dan terbaik. */
  setAutopilot(on: boolean, lap: number, lapTime: number, best: number) {
    const el = this.autoEl;
    if (!el) return;
    el.classList.toggle('off', !on);
    const text = on
      ? `AI mengemudi · lap ${Math.max(1, lap + 1)} · ${lapTime.toFixed(1)}s` +
        (Number.isFinite(best) ? ` · best ${best.toFixed(1)}s` : '')
      : 'AI nonaktif · P';
    if (el.textContent !== text) el.textContent = text;
  }

  /**
   * Baris status lawan. `gap` dalam meter: positif berarti lawan di depan.
   */
  setRival(on: boolean, lap: number, laps: number, gap: number) {
    const el = this.rivalEl;
    if (!el) return;
    el.classList.toggle('ahead', on && gap <= 0);
    el.classList.toggle('behind', on && gap > 0);
    const text = !on
      ? 'LAWAN nonaktif'
      : `LAWAN · lap ${Math.min(lap + 1, laps)}/${laps} · ${gap > 0 ? '+' : '−'}${Math.abs(gap).toFixed(0)} m`;
    if (el.textContent !== text) el.textContent = text;
  }

  /** Overlay kamera TV: muncul hanya saat kamera siaran aktif. */
  setCamera(tv: boolean, name: string | null) {
    const el = this.tvEl;
    if (!el) return;
    el.classList.toggle('hide', !tv);
    const text = name ? `● LIVE · ${name}` : '● LIVE';
    if (tv && el.textContent !== text) el.textContent = text;
  }

  /** Banner hasil balapan; `null` menyembunyikannya. */
  setFinish(text: string | null) {
    const el = this.finishEl;
    if (!el) return;
    el.classList.toggle('hide', !text);
    if (text && el.textContent !== text) el.textContent = text;
  }

  update(phys: VehiclePhysics, dt: number) {
    this.accum += dt;
    if (this.accum < 1 / 15) return;
    this.accum = 0;

    const kmh = phys.speedKmh;
    this.speedEl.textContent = String(Math.round(kmh));

    fwd.set(0, 0, 1).applyQuaternion(phys.quaternion);
    const vLong = phys.velocity.x * fwd.x + phys.velocity.z * fwd.z;

    // Real gear state (manual D/R) + a cosmetic running number for forward gear.
    let gear = 'N';
    if (kmh < 1.5 && Math.abs(vLong) < 0.4) gear = 'N';
    else if (phys.gear === -1) gear = 'R';
    else gear = String(Math.min(6, 1 + Math.floor(kmh / 26)));
    this.gearEl.textContent = gear;
    this.gearEl.classList.toggle('rev', phys.gear === -1);

    let contacts = 0;
    let traction = 0;

    for (let i = 0; i < 4; i++) {
      const w = phys.wheels[i];
      const bar = this.bars[i];

      if (!w.contact) {
        bar.root.classList.add('air');
        bar.fill.style.width = '0%';
        continue;
      }

      contacts++;
      traction += w.traction;
      bar.root.classList.remove('air');
      const ratio = Math.min(1, w.springForce / this.maxLoad);
      bar.fill.style.width = `${(ratio * 100).toFixed(0)}%`;
      bar.fill.style.background =
        w.traction > 0.94 ? '#ff5a3c' : w.traction > 0.75 ? '#ffb02e' : '#57d68d';
    }

    const drift = phys.driftAngle * RAD2DEG;
    // steerAngle is CCW-positive in world space; show it as the driver thinks:
    // positive == steering right.
    const steer = -phys.steerAngle * RAD2DEG;
    const grip = contacts > 0 ? (traction / contacts) * 100 : 0;

    this.telemEl.textContent =
      `kontak  ${contacts}/4\n` +
      `drift   ${drift >= 0 ? '+' : ''}${drift.toFixed(1)}°\n` +
      `setir   ${steer >= 0 ? '+' : ''}${steer.toFixed(1)}°\n` +
      `grip    ${grip.toFixed(0)}%`;
  }
}

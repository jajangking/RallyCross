import * as THREE from 'three';
import type { VehiclePhysics } from './vehicle/VehiclePhysics';

const RAD2DEG = 180 / Math.PI;
const fwd = new THREE.Vector3();

export class Hud {
  private readonly speedEl = document.getElementById('speed')!;
  private readonly gearEl = document.getElementById('gear')!;
  private readonly telemEl = document.getElementById('telem')!;
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

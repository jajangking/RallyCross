import * as THREE from 'three';
import type { VehiclePhysics } from './vehicle/VehiclePhysics';
import type { VehicleDamage } from './vehicle/Damage';
import type { LapRecords, StandingsRow } from './race/Standings';

const RAD2DEG = 180 / Math.PI;
const fwd = new THREE.Vector3();

/** Urutan roda sama dengan `VehiclePhysics.wheels`: FL, FR, RL, RR. */
const WHEEL_NAMES = ['KIRI DEPAN', 'KANAN DEPAN', 'KIRI BELAKANG', 'KANAN BELAKANG'];

export class Hud {
  private readonly speedEl = document.getElementById('speed')!;
  private readonly gearEl = document.getElementById('gear')!;
  private readonly telemEl = document.getElementById('telem')!;
  private readonly damageEl = document.getElementById('damage');
  private readonly autoEl = document.getElementById('auto');
  private readonly boardEl = document.getElementById('board');
  private readonly standingsEl = document.getElementById('standings');
  private readonly recordEl = document.getElementById('record');
  private readonly rows: HTMLElement[] = [];
  private readonly finishEl = document.getElementById('finish');
  private readonly tvEl = document.getElementById('tv');
  private readonly indLeft = document.getElementById('ind-left');
  private readonly indRight = document.getElementById('ind-right');
  private readonly indBeam = document.getElementById('ind-beam');
  private readonly bars: Array<{ root: HTMLElement; fill: HTMLElement }> = [];
  private readonly maxLoad: number;
  private accum = 0;
  private damageKey = '';
  private flashText = '';
  private flashUntil = 0;

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
   * Papan klasemen 6 mobil + rekor lap. Barisnya dibuat sekali (DOM tidak
   * dibuat ulang tiap frame), lalu teks & urutannya dirapikan di tempat.
   */
  setStandings(
    rows: readonly StandingsRow[],
    on: boolean,
    records: LapRecords,
    flashRecord: boolean,
  ) {
    const board = this.boardEl;
    const list = this.standingsEl;
    if (!board || !list) return;
    board.classList.toggle('hide', !on);
    if (!on) return;

    while (this.rows.length < rows.length) {
      const li = document.createElement('li');
      li.className = 'row';
      const name = document.createElement('span');
      name.className = 'who';
      const time = document.createElement('span');
      time.className = 'time';
      li.append(name, time);
      list.appendChild(li);
      this.rows.push(li);
    }

    for (let i = 0; i < this.rows.length; i++) {
      const el = this.rows[i];
      const row = rows[i];
      if (!row) {
        el.classList.add('hide');
        continue;
      }
      el.classList.remove('hide');
      el.classList.toggle('me', !!row.isPlayer);
      el.classList.toggle('lead', row.position === 1);
      el.style.setProperty('--dot', `#${row.color.toString(16).padStart(6, '0')}`);
      const best = Number.isFinite(row.bestLap) ? row.bestLap.toFixed(1) : '—';
      const lapText = row.finished ? 'FIN' : `${Math.min(row.lap + 1, row.laps)}/${row.laps}`;
      const gap = row.position === 1 ? lapText : `+${row.gap.toFixed(0)} m`;
      const text = `${row.position} ${row.name}`;
      const detail = `${gap} · ${best}s`;
      const who = el.firstElementChild as HTMLElement;
      const tm = el.lastElementChild as HTMLElement;
      if (who.textContent !== text) who.textContent = text;
      if (tm.textContent !== detail) tm.textContent = detail;
    }

    const rec = this.recordEl;
    if (rec) {
      // Saat rekor baru dipecahkan, barisnya berubah jadi pengumuman singkat.
      const text = !records.hasRecord
        ? 'REKOR —'
        : flashRecord
          ? `REKOR BARU ${records.best.toFixed(2)}s · ${records.holder}`
          : `REKOR ${records.best.toFixed(2)}s · ${records.holder}`;
      if (rec.textContent !== text) rec.textContent = text;
      rec.classList.toggle('fresh', flashRecord);
    }
  }

  /** Overlay kamera TV: muncul hanya saat kamera siaran aktif. */
  setCamera(live: boolean, name: string | null) {
    const el = this.tvEl;
    if (!el) return;
    el.classList.toggle('hide', !live);
    const text = name ? `● LIVE · ${name}` : '● LIVE';
    if (live && el.textContent !== text) el.textContent = text;
  }

  /** Banner hasil balapan; `null` menyembunyikannya. */
  setFinish(text: string | null) {
    const el = this.finishEl;
    if (!el) return;
    el.classList.toggle('hide', !text);
    if (text && el.textContent !== text) el.textContent = text;
  }

  /**
   * Panel kerusakan. Kosong sama sekali selama mobil utuh, jadi HUD tetap
   * bersih; begitu ada yang rusak muncul barisnya. Teks Indonesia, huruf
   * kapital, dan sengaja pendek supaya tidak menutupi jalan di layar HP.
   */
  setDamage(dmg: VehicleDamage) {
    const now = performance.now();
    // Kejadian baru (ban pecah/copot, mesin mati) dipamerkan sebentar.
    for (const ev of dmg.drainEvents()) {
      this.flashUntil = now + 1900;
      this.flashText =
        ev.kind === 'wheel-off'
          ? `BAN ${WHEEL_NAMES[ev.wheel]} COPOT!`
          : ev.kind === 'puncture'
            ? `BAN ${WHEEL_NAMES[ev.wheel]} PECAH!`
            : ev.kind === 'engine'
              ? 'MESIN MATI — TIDAK BISA MAJU'
              : 'BODI PENYOK';
    }

    const el = this.damageEl;
    if (!el) return;
    const flash = now < this.flashUntil;
    const bodyPct = Math.round(Math.max(0, dmg.bodyHealth) * 100);
    const damaged = dmg.dentLevel > 0.01 || dmg.puncturedCount > 0 || dmg.lostCount > 0 || dmg.engineDead;

    // Kunci isi panel: DOM cuma ditulis kalau memang ada yang berubah.
    const key = `${flash ? this.flashText : ''}|${bodyPct}|${Math.round(dmg.engineHealth * 100)}|` +
      dmg.wheels.map((w) => (w.lost ? 2 : w.punctured ? 1 : 0)).join('');
    if (key === this.damageKey) return;
    this.damageKey = key;

    el.classList.toggle('hide', !damaged && !flash);
    if (!damaged && !flash) {
      el.replaceChildren();
      return;
    }

    const rows: string[] = [];
    if (flash) rows.push(`<div class="dmg-row flash">${this.flashText}</div>`);
    if (dmg.dentLevel > 0.01) {
      rows.push(
        `<div class="dmg-row">PENYOK <span class="meter"><i style="width:${100 - bodyPct}%"></i></span>` +
          `<span>${bodyPct}%</span></div>`,
      );
    }
    if (dmg.engineDead) {
      rows.push('<div class="dmg-row dead">MESIN MATI · TIDAK BISA MAJU</div>');
    } else if (dmg.engineHealth < 0.9) {
      rows.push(`<div class="dmg-row">MESIN ${Math.round(dmg.engineHealth * 100)}%</div>`);
    }
    for (let i = 0; i < dmg.wheels.length; i++) {
      const w = dmg.wheels[i];
      if (!w.lost && !w.punctured) continue;
      rows.push(
        `<div class="dmg-row${w.lost ? ' lost' : ''}">BAN ${WHEEL_NAMES[i]} ${w.lost ? 'COPOT' : 'PECAH'}</div>`,
      );
    }
    el.innerHTML = rows.join('');
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

    this.setDamage(phys.damage);

    this.telemEl.textContent =
      `kontak  ${contacts}/4\n` +
      `drift   ${drift >= 0 ? '+' : ''}${drift.toFixed(1)}°\n` +
      `setir   ${steer >= 0 ? '+' : ''}${steer.toFixed(1)}°\n` +
      `grip    ${grip.toFixed(0)}%`;
  }
}

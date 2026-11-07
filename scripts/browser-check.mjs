/**
 * Optional browser regression check (needs a Chromium binary).
 *
 *   npm run build
 *   npx vite preview --port 4173 &
 *   npm run check:browser
 *
 * On Termux the Android headless shell works:
 *   CHROME_BIN=$PREFIX/bin/headless_shell npm run check:browser
 *
 * NOTE: headless SwiftShader on Android loses the WebGL context after ~1s.
 * That is an environment limitation, not an app bug — the script therefore
 * asserts on draw calls / triangles (rendered frames), not on pixels.
 */
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://127.0.0.1:4173/?quality=low&touch=1';
const candidates = [
  process.env.CHROME_BIN,
  '/data/data/com.termux/files/usr/bin/headless_shell',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean);
const exe = candidates.find((p) => existsSync(p));
if (!exe) {
  console.error('No Chromium found. Set CHROME_BIN=/path/to/chrome');
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
  ],
});

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 480, height: 300, deviceScaleFactor: 1 });

  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 500));

  const boot = await page.evaluate(() => {
    const rc = window.rc;
    const info = rc?.renderer.info;
    return {
      hasRc: !!rc,
      bootDone: !document.getElementById('boot'),
      drawCalls: info?.render.calls ?? 0,
      triangles: info?.render.triangles ?? 0,
      programs: info?.programs?.length ?? 0,
      contacts: rc ? rc.car.wheels.filter((w) => w.contact).length : 0,
      mass: rc ? rc.car.body.mass() : 0,
      y: rc ? rc.car.position.y : 0,
      speedHud: document.getElementById('speed')?.textContent,
    };
  });

  console.log('\n— page —');
  check(boot.hasRc, 'debug handle exposed');
  check(boot.bootDone, 'boot overlay removed');
  check(boot.drawCalls > 0, 'scene submitted draw calls', `${boot.drawCalls} calls / ${boot.triangles} tris`);
  check(boot.programs > 0, 'shaders compiled', `${boot.programs} program(s)`);
  check(boot.contacts === 4, 'wheels on the ground', `${boot.contacts}/4`);
  check(Math.abs(boot.mass - 1250) < 1, 'car mass', `${boot.mass.toFixed(0)} kg`);
  check(Math.abs(boot.y - 0.923) < 0.06, 'ride height', `y=${boot.y.toFixed(3)}`);

  console.log('\n— input —');
  await page.keyboard.down('KeyW');
  await new Promise((r) => setTimeout(r, 1500));
  await page.keyboard.up('KeyW');
  const drive = await page.evaluate(() => ({
    speed: window.rc.car.speed,
    z: window.rc.car.position.z,
    hud: document.getElementById('speed')?.textContent,
  }));
  check(drive.speed > 6, 'accelerates on W', `${drive.speed.toFixed(1)} m/s`);
  check(drive.z > 3, 'moves forward', `z=${drive.z.toFixed(1)}`);
  check(drive.hud !== '0', 'speedometer updates', `${drive.hud} km/h`);

  console.log('\n— steering direction —');
  await page.evaluate(() => window.rc.car.reset());
  await new Promise((r) => setTimeout(r, 300));

  const readYaw = () =>
    page.evaluate(() => {
      const q = window.rc.car.quaternion;
      const fx = 2 * (q.x * q.z + q.w * q.y);
      const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
      return Math.atan2(fx, fz);
    });

  const yawBefore = await readYaw();
  await page.keyboard.down('KeyW');
  await page.keyboard.down('KeyD');
  await new Promise((r) => setTimeout(r, 1400));
  await page.keyboard.up('KeyD');
  await page.keyboard.up('KeyW');
  const yawAfter = await readYaw();
  let dYaw = yawAfter - yawBefore;
  while (dYaw > Math.PI) dYaw -= Math.PI * 2;
  while (dYaw < -Math.PI) dYaw += Math.PI * 2;

  const sides = await page.evaluate(() => {
    const q = window.rc.car.quaternion;
    // forward = +Z rotated by q; right = forward x up = (-fz, 0, fx)
    const fx = 2 * (q.x * q.z + q.w * q.y);
    const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    const rx = -fz;
    const rz = fx;
    // camera screen-right is the camera's local +X axis, first column of matrixWorld
    const e = window.rc.cameraRig.camera.matrixWorld.elements;
    return { camRightDot: rx * e[0] + rz * e[2] };
  });

  check(dYaw < -0.15, 'D steers right (world yaw decreases)', `Δyaw=${dYaw.toFixed(2)} rad`);
  check(sides.camRightDot > 0.5, 'car right maps to screen right', `dot=${sides.camRightDot.toFixed(2)}`);

  console.log('\n— analogue touch controls —');

  const boxOf = (sel) =>
    page.evaluate((sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return { w: r.width, h: r.height };
    }, sel);

  const steerBox = await boxOf('#touch [data-ctl="steer"] .track');
  const gasBox = await boxOf('#touch [data-ctl="gas"] .track');
  const brakeBox = await boxOf('#touch [data-ctl="brake"] .track');
  check(steerBox.w > 60 && steerBox.h > 30, 'steer slider rendered', `${steerBox.w.toFixed(0)}×${steerBox.h.toFixed(0)}`);
  check(gasBox.w > 30 && gasBox.h > 60, 'gas slider rendered', `${gasBox.w.toFixed(0)}×${gasBox.h.toFixed(0)}`);
  check(brakeBox.w > 30 && brakeBox.h > 60, 'brake slider rendered', `${brakeBox.w.toFixed(0)}×${brakeBox.h.toFixed(0)}`);

  const press = (id, f, ms = 90) =>
    page.evaluate(
      ({ id, f, ms }) =>
        new Promise((resolve) => {
          const el = document.querySelector(`#touch [data-ctl="${id}"]`);
          const r = el.querySelector('.track').getBoundingClientRect();
          const x = id === 'steer' ? r.left + r.width * (0.5 + 0.5 * f) : r.left + r.width / 2;
          const y = id === 'steer' ? r.top + r.height / 2 : r.bottom - r.height * f;
          el.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, pointerId: 11, clientX: x, clientY: y }),
          );
          setTimeout(
            () => resolve({ steer: window.rc.input.state.steer, throttle: window.rc.input.state.throttle }),
            ms,
          );
        }),
      { id, f, ms },
    );

  const moveTo = (id, f, ms = 90) =>
    page.evaluate(
      ({ id, f, ms }) =>
        new Promise((resolve) => {
          const el = document.querySelector(`#touch [data-ctl="${id}"]`);
          const r = el.querySelector('.track').getBoundingClientRect();
          const x = id === 'steer' ? r.left + r.width * (0.5 + 0.5 * f) : r.left + r.width / 2;
          const y = id === 'steer' ? r.top + r.height / 2 : r.bottom - r.height * f;
          el.dispatchEvent(
            new PointerEvent('pointermove', { bubbles: true, pointerId: 11, clientX: x, clientY: y }),
          );
          setTimeout(
            () => resolve({ steer: window.rc.input.state.steer, throttle: window.rc.input.state.throttle }),
            ms,
          );
        }),
      { id, f, ms },
    );

  const release = (id, ms = 400) =>
    page.evaluate(
      ({ id, ms }) =>
        new Promise((resolve) => {
          const el = document.querySelector(`#touch [data-ctl="${id}"]`);
          el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 11 }));
          setTimeout(
            () => resolve({ steer: window.rc.input.state.steer, throttle: window.rc.input.state.throttle }),
            ms,
          );
        }),
      { id, ms },
    );

  await page.evaluate(() => window.rc.car.reset());
  await new Promise((r) => setTimeout(r, 400)); // let pedals from the previous test settle

  // gas is a direct opening control, not a ramp
  let v = await press('gas', 0.5);
  check(Math.abs(v.throttle - 0.5) < 0.05, 'gas opening 50%', `throttle=${v.throttle.toFixed(2)}`);
  v = await moveTo('gas', 0.85);
  check(Math.abs(v.throttle - 0.85) < 0.05, 'gas opening adjustable while held', `throttle=${v.throttle.toFixed(2)}`);
  v = await release('gas');
  check(Math.abs(v.throttle) < 0.05, 'gas closes on release', `throttle=${v.throttle.toFixed(2)}`);

  // brake is its own opening control too
  v = await press('brake', 0.7);
  check(Math.abs(v.throttle + 0.7) < 0.05, 'brake opening 70%', `throttle=${v.throttle.toFixed(2)}`);
  v = await release('brake');
  check(Math.abs(v.throttle) < 0.05, 'brake closes on release', `throttle=${v.throttle.toFixed(2)}`);

  // both pedals at once cancel out
  await press('gas', 0.6);
  v = await press('brake', 0.6);
  check(Math.abs(v.throttle) < 0.05, 'gas + brake cancel', `throttle=${v.throttle.toFixed(2)}`);
  await release('brake');
  await release('gas');

  // steering is 1:1 while held, springs back to centre
  v = await press('steer', 0.55);
  check(Math.abs(v.steer - 0.55) < 0.04, 'steer opening 55%', `steer=${v.steer.toFixed(2)}`);
  v = await release('steer');
  check(Math.abs(v.steer) < 0.05, 'steer springs back to centre', `steer=${v.steer.toFixed(2)}`);

  // keyboard still ramps, so a tap gives a small opening
  await page.keyboard.down('KeyW');
  await new Promise((r) => setTimeout(r, 120));
  const partial = await page.evaluate(() => window.rc.input.state.throttle);
  await page.keyboard.up('KeyW');
  check(partial > 0.05 && partial < 0.95, 'keyboard gas is progressive', `throttle=${partial.toFixed(2)} after 120 ms`);
  await new Promise((r) => setTimeout(r, 400));

  check(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? '✅ browser check passed' : `❌ ${failures} check(s) failed`}\n`);
if (failures > 0) process.exitCode = 1;

// Real native-window lifecycle, audio continuity, tray controls and process memory.
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  copyFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { wave } from "../../scripts/fixtures/pcm.mjs";
const root = resolve(import.meta.dirname, "../..");
const release = process.argv.includes("--release");
mkdirSync(join(root, "apps/desktop/test-results"), { recursive: true });
const folder = mkdtempSync(
  join(root, "apps/desktop/test-results/native-background-"),
);
const first = join(folder, "晨光.wav"),
  second = join(folder, "月色.wav");
writeFileSync(first, wave({ seconds: 5 }));
writeFileSync(second, wave({ seconds: 60 }));
for (const file of [first, second])
  copyFileSync(
    join(root, "apps/desktop/build/icon.png"),
    file.replace(".wav", ".png"),
  );
const handoff = join(folder, "handoff.json");
writeFileSync(
  handoff,
  JSON.stringify({
    volume: 0.05,
    output: { api: "null", deviceId: null, bufferMs: 40, dsdMode: "pcm" },
  }),
);
const child = spawn(
  join(
    root,
    "target",
    release ? "release" : "debug",
    process.platform === "win32" ? "jap-lightweight.exe" : "jap-lightweight",
  ),
  ["--data-dir", folder, "--handoff", handoff, "--qa"],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
let log = "";
child.stdout.on("data", (b) => (log += b));
child.stderr.on("data", (b) => (log += b));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const report = () => {
  try {
    return JSON.parse(readFileSync(join(folder, "native-report.json"), "utf8"));
  } catch {
    return null;
  }
};
async function wait(predicate) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const s = report();
    if (s && predicate(s)) return s;
    if (child.exitCode !== null) throw Error("Native exit: " + log);
    await delay(60);
  }
  throw Error(
    "Timeout: " + predicate + " " + JSON.stringify(report()) + " " + log,
  );
}
async function send(value) {
  const file = join(folder, "native-input.json");
  for (let i = 0; existsSync(file) && i < 100; i++) await delay(30);
  writeFileSync(file + ".pending", JSON.stringify(value));
  renameSync(file + ".pending", file);
}
async function click(id) {
  const r = report().controls[id];
  assert(r, `Missing ${id}`);
  const x = (r[0] + r[2]) / 2,
    y = (r[1] + r[3]) / 2;
  await send({ type: "pointer", x, y, down: true });
  await delay(150);
  await send({ type: "pointer", x, y, down: false });
}
function memory() {
  if (process.platform !== "win32") return null;
  const command = `$p=Get-Process -Id ${child.pid};[pscustomobject]@{workingMiB=[math]::Round($p.WorkingSet64/1MB,2);privateMiB=[math]::Round($p.PrivateMemorySize64/1MB,2);cpuSeconds=$p.CPU}|ConvertTo-Json -Compress`;
  const result = spawnSync("powershell", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function identity() {
  if (process.platform !== "win32") return null;
  const command = `
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class NativeWindowIdentity{[DllImport("user32.dll")]public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);}'
$p=Get-Process -Id ${child.pid}
$icon=[NativeWindowIdentity]::SendMessage($p.MainWindowHandle,127,[IntPtr]2,[IntPtr]::Zero)
if($icon -eq [IntPtr]::Zero){$icon=[NativeWindowIdentity]::SendMessage($p.MainWindowHandle,127,[IntPtr]1,[IntPtr]::Zero)}
[pscustomobject]@{title=$p.MainWindowTitle;windowIcon=($icon -ne [IntPtr]::Zero);product=$p.MainModule.FileVersionInfo.ProductName;description=$p.MainModule.FileVersionInfo.FileDescription}|ConvertTo-Json -Compress`;
  const result = spawnSync("powershell", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const measurements = {},
  checks = [];
try {
  await wait((s) => s.controls.play);
  assert.equal(report().graphics.backend, "Software");
  assert.equal(report().webview, false);
  assert.equal(report().tray, true, "System tray not registered");
  const appIdentity = identity();
  if (appIdentity) {
    assert.equal(appIdentity.product, "Just A Player");
    assert.equal(appIdentity.description, "Just A Player Native");
    assert.equal(appIdentity.windowIcon, true);
    checks.push("actual native titlebar icon and embedded executable identity");
  }
  await delay(1500);
  measurements.idle = memory();
  if (measurements.idle)
    assert(
      measurements.idle.privateMiB < 180,
      "Idle private memory regression",
    );
  await send({ type: "import", paths: [first, second] });
  await wait((s) => s.library.lists[0].items.length === 2);
  await send({ type: "command", command: "play" });
  await wait((s) => s.state === "playing" && s.position > 300 && s.hasCover);
  await send({ type: "meter", id: "vu", enabled: true });
  await wait((s) => s.analysisFrames >= 4);
  measurements.playing = memory();
  await send({ type: "window-close" });
  await wait(
    (s) => s.view === "Hidden" && !s.visual && !s.renderResourcesResident,
  );
  const hidden = report(),
    cpuStart = memory();
  await delay(2400);
  const after = report();
  assert.equal(after.draws, hidden.draws);
  assert.equal(after.analysisFrames, hidden.analysisFrames);
  measurements.background = memory();
  if (cpuStart && measurements.background) {
    measurements.background.cpuDelta = +(
      measurements.background.cpuSeconds - cpuStart.cpuSeconds
    ).toFixed(3);
    assert(
      measurements.background.cpuDelta < 0.7,
      "Background busy loop: " + JSON.stringify(measurements),
    );
  }
  checks.push(
    "close to tray keeps audio and releases UI; zero hidden draws and FFT frames",
  );
  await wait(
    (s) =>
      s.state === "playing" && s.current?.path === second && s.position > 200,
  );
  checks.push("background automatically advances to next track");
  await send({ type: "tray" });
  await wait((s) => s.view === "Popup" && s.controls.quit && s.hasCover);
  assert.equal(report().renderResourcesResident, true);
  for (const id of ["previous", "play", "next", "reset", "show", "quit"])
    assert(
      report().controls[id][3] <= report().viewport[1],
      `Clipped tray button: ${id}`,
    );
  await send({ type: "screenshot" });
  await delay(300);
  copyFileSync(join(folder, "native-screenshot.png"), join(folder, "tray.png"));
  checks.push("custom tray panel restores cover and all controls fit");
  await click("play");
  await wait((s) => s.state === "paused");
  await click("play");
  await wait((s) => s.state === "playing");
  await click("reset");
  await delay(300);
  assert.equal(report().state, "playing");
  checks.push("real pointer clicks control pause, resume and buffer reset");
  await click("show");
  await wait((s) => s.view === "Main" && s.controls["settings"]);
  assert.equal(report().current.path, second);
  assert(report().position > 300);
  checks.push("restore retains same playing track and progress");
  measurements.restored = memory();
  for (let i = 0; i < 3; i++) {
    await send({ type: "window-close" });
    await wait((s) => s.view === "Hidden");
    await send({ type: "show" });
    await wait((s) => s.view === "Main" && s.controls.settings);
  }
  measurements.afterCycles = memory();
  if (measurements.restored && measurements.afterCycles)
    assert(
      measurements.afterCycles.privateMiB - measurements.restored.privateMiB <
        30,
      "Repeated restore leaks UI allocations",
    );
  checks.push("repeated hide and restore without resource accumulation");
  await send({ type: "minimize" });
  await wait((s) => s.view === "Minimized" && !s.renderResourcesResident);
  const minimized = report();
  await delay(500);
  assert.equal(report().draws, minimized.draws);
  assert.equal(report().state, "playing");
  await send({ type: "show" });
  await wait((s) => s.view === "Main" && s.controls.settings);
  checks.push(
    "minimize suspends rendering and restores without stopping audio",
  );
  await send({ type: "tray" });
  await wait((s) => s.view === "Popup" && s.controls.quit);
  await click("quit");
  const until = Date.now() + 8000;
  while (child.exitCode === null && Date.now() < until) await delay(50);
  assert.equal(child.exitCode, 0, log);
  checks.push("tray quit actually exits");
  const result = { passed: true, release, checks, measurements, folder };
  writeFileSync(join(folder, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  writeFileSync(
    join(folder, "memory.json"),
    JSON.stringify(measurements, null, 2),
  );
  if (child.exitCode === null) {
    await send({ type: "close" });
    await delay(1500);
    if (child.exitCode === null) child.kill();
  }
}

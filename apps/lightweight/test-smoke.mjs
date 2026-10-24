import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "../..");
mkdirSync(join(root, "apps/desktop/test-results"), { recursive: true });
const data = mkdtempSync(join(root, "apps/desktop/test-results/native-smoke-"));
const report = join(data, "report.json");
const child = spawn(
  join(
    root,
    "target/debug",
    process.platform === "win32" ? "jap-lightweight.exe" : "jap-lightweight",
  ),
  ["--data-dir", data, "--smoke-report", report],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
let log = "";
child.stdout.on("data", (b) => (log += b));
child.stderr.on("data", (b) => (log += b));
const exit = await new Promise((accept, reject) => {
  const timer = setTimeout(() => {
    child.kill();
    reject(Error("Native startup timed out: " + log));
  }, 30000);
  child.once("error", reject);
  child.once("exit", (code) => {
    clearTimeout(timer);
    accept(code);
  });
});
assert.equal(exit, 0, log);
const state = JSON.parse(readFileSync(report, "utf8"));
assert.equal(state.renderer, "egui-native");
assert.equal(state.webview, false);
assert.equal(state.passed, true);
assert.equal(state.visual, false);
if(process.platform==="win32"){
  assert.equal(state.graphics.backend,"Dx12");
  if(process.env.JAP_LIGHT_SOFTWARE==="1")assert.equal(state.graphics.deviceType,"Cpu");
}
assert(state.controls.play);
assert(
  existsSync(report.replace(".json", ".png")),
  "Native framebuffer screenshot missing",
);
console.log(
  JSON.stringify({
    passed: true,
    platform: process.platform,
    arch: process.arch,
    renderer: state.renderer,
    graphics:state.graphics,
    report,
  }),
);

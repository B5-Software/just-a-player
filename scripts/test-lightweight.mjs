import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
// Native widget tests feed real pointer events through egui and rasterize pixels.
const native = spawnSync("cargo", ["test", "-p", "jap-light", "--locked"], {
  stdio: "inherit",
  windowsHide: true,
});
assert.equal(native.status, 0, "Native UI tests failed");
const { vuPosition, smoothVu } =
  await import("../apps/desktop/src/renderer/src/viz/vu-scale.ts");
assert(Math.abs(vuPosition(10 ** (-18 / 20)) - 0.625) < 1e-6);
assert(
  vuPosition(10 ** (-8 / 20)) < 0.85,
  "Modern program RMS must not pin the meter",
);
assert.equal(vuPosition(0), 0);
assert.equal(vuPosition(1), 1);
assert(
  Math.abs(smoothVu(0, 1, 0.3) - 0.99) < 1e-6,
  "VU must reach 99% at 300 ms",
);
const cargo = readFileSync(
  new URL("../apps/lightweight/Cargo.toml", import.meta.url),
  "utf8",
);
assert(
  !cargo.includes("wry =") && !cargo.includes("tao ="),
  "Browser host dependency remains",
);
console.log(
  "Native UI, enhanced lyrics, independent meters and VU headroom passed",
);

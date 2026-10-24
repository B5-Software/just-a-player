import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("..", import.meta.url));
const debug = process.argv.includes("--debug");
const result = spawnSync(
  "cargo",
  [
    "build",
    "-p",
    "jap-lightweight",
    "--locked",
    ...(debug ? [] : ["--release"]),
  ],
  { cwd: root, stdio: "inherit", windowsHide: true },
);
if (result.status) process.exit(result.status);
const directory = join(root, "apps/desktop/build/lightweight");
mkdirSync(directory, { recursive: true });
const binary =
  process.platform === "win32" ? "jap-lightweight.exe" : "jap-lightweight";
copyFileSync(
  join(root, "target", debug ? "debug" : "release", binary),
  join(directory, binary),
);

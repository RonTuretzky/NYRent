// Assemble every captured frames dir (e2e/.artifacts/guide/<shot>/) into
// web/public/docs/<shot>.gif with scripts/gif_assemble.py — 12fps resample,
// 900px (landing tries 1000px first), global MEDIANCUT palette, <4MB enforced
// by the python script (exit 2 = over budget → retry narrower, then slower).
// One copy under web/public/ serves both the Pages site and the in-app Docs
// page (vite copies public/ into dist/).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const FRAMES = path.join(HERE, "..", ".artifacts", "guide");
const OUT_DIR = path.join(REPO, "web", "public", "docs");
const ASSEMBLER = path.join(REPO, "scripts", "gif_assemble.py");

/** Attempts run in order until one lands under the 4MB budget. */
const SHOTS = [
  { name: "landing", attempts: [{ width: 1000 }, { width: 900 }, { width: 900, fps: 10 }], hold: 800 },
  { name: "docs", attempts: [{ width: 900 }, { width: 900, fps: 10 }] },
  { name: "connect-browse", attempts: [{ width: 900 }, { width: 900, fps: 10 }] },
  { name: "sponsor-fund", attempts: [{ width: 900 }, { width: 900, fps: 10 }] },
  { name: "buy", attempts: [{ width: 900 }, { width: 900, fps: 10 }] },
  { name: "settle", attempts: [{ width: 900 }, { width: 900, fps: 10 }] },
  { name: "redeem", attempts: [{ width: 900 }, { width: 900, fps: 10 }] },
  { name: "sponsor-withdraw", attempts: [{ width: 900 }, { width: 900, fps: 10 }] },
  { name: "buy-with-usdce", attempts: [{ width: 900 }, { width: 900, fps: 10 }] },
];

fs.mkdirSync(OUT_DIR, { recursive: true });
const failures = [];
for (const shot of SHOTS) {
  const framesDir = path.join(FRAMES, shot.name);
  if (!fs.existsSync(path.join(framesDir, "timestamps.json"))) {
    failures.push(`${shot.name}: no frames captured (${framesDir})`);
    continue;
  }
  const out = path.join(OUT_DIR, `${shot.name}.gif`);
  let done = false;
  for (const attempt of shot.attempts) {
    const args = [
      ASSEMBLER,
      framesDir,
      out,
      "--fps",
      String(attempt.fps ?? 12),
      "--width",
      String(attempt.width),
    ];
    if (shot.hold !== undefined) args.push("--hold", String(shot.hold));
    const res = spawnSync("python3", args, { stdio: "inherit" });
    if (res.status === 0) {
      done = true;
      break;
    }
    if (res.status !== 2) {
      // exit 2 = over budget (retryable); anything else is a real failure
      failures.push(`${shot.name}: gif_assemble.py exited ${res.status}`);
      done = true;
      break;
    }
  }
  if (!done) failures.push(`${shot.name}: over 4MB at every attempt`);
}

if (failures.length > 0) {
  console.error(`\nassemble failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`\nAll guide GIFs assembled into ${OUT_DIR}`);

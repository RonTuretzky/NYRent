import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEPLOYMENT_PATH } from "./support/helpers";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ART = path.join(HERE, ".artifacts");

function kill(pid?: number): void {
  if (!pid) return;
  // Children were spawned detached (own process group): signal the group so
  // npm-wrapped vite dies with its wrapper, then fall back to the single pid.
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

export default async function globalTeardown(): Promise<void> {
  let pids: { anvil?: number; preview?: number } = {};
  try {
    pids = JSON.parse(fs.readFileSync(path.join(ART, "pids.json"), "utf8"));
  } catch {
    /* setup failed before writing pids */
  }
  kill(pids.preview);
  kill(pids.anvil);

  // Put back whatever deployment.json existed before the run (or remove ours).
  const bak = path.join(ART, "deployment.json.bak");
  if (fs.existsSync(bak)) fs.copyFileSync(bak, DEPLOYMENT_PATH);
  else fs.rmSync(DEPLOYMENT_PATH, { force: true });

  // Parallel-phase Foundry dirs are ours to delete (workspace hard rule).
  for (const dir of ["out-e2e", "cache-e2e"]) {
    fs.rmSync(path.join(ROOT, dir), { recursive: true, force: true });
  }
}

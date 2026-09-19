import fs from "node:fs";
import { DEPLOYMENT_BAK, DEPLOYMENT_PATH, PIDS_PATH, STATE_PATH } from "./support";

function kill(pid?: number): void {
  if (!pid) return;
  // Children were spawned detached (own process group): signal the group so
  // npx-wrapped vite dies with its wrapper, then fall back to the single pid.
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
    pids = JSON.parse(fs.readFileSync(PIDS_PATH, "utf8"));
  } catch {
    /* setup failed before writing pids */
  }
  kill(pids.preview);
  kill(pids.anvil);

  // Put back the committed deployment.json the temporary 42161 file replaced.
  if (fs.existsSync(DEPLOYMENT_BAK)) {
    fs.copyFileSync(DEPLOYMENT_BAK, DEPLOYMENT_PATH);
    fs.rmSync(DEPLOYMENT_BAK, { force: true });
  }
  fs.rmSync(PIDS_PATH, { force: true });
  fs.rmSync(STATE_PATH, { force: true });
}

import fs from "node:fs";
import path from "node:path";
import {
  APARTMENTS_DEPLOYMENT_BAK, APARTMENTS_DEPLOYMENT_PATH, PIDS_PATH, REPO_ROOT,
} from "./support";

function kill(pid?: number): void {
  if (!pid) return;
  // Only processes this suite spawned (own process group), never other anvils.
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

/** Puts back the committed deployment file the setup temporarily replaced. */
export function restoreFiles(): void {
  if (fs.existsSync(APARTMENTS_DEPLOYMENT_BAK)) {
    fs.copyFileSync(APARTMENTS_DEPLOYMENT_BAK, APARTMENTS_DEPLOYMENT_PATH);
    fs.rmSync(APARTMENTS_DEPLOYMENT_BAK, { force: true });
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
  restoreFiles();
  fs.rmSync(PIDS_PATH, { force: true });
  for (const dir of ["out-policies", "cache-policies"]) fs.rmSync(path.join(REPO_ROOT, dir), { recursive: true, force: true });
}

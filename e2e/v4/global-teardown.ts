import fs from "node:fs";
import path from "node:path";
import { ART } from "./constants";
export default async function cleanup() {
  const file = path.join(ART, "pids.json");
  if (!fs.existsSync(file)) return;
  const pids = JSON.parse(fs.readFileSync(file, "utf8")) as {anvil?: number; preview?: number};
  for (const pid of [pids.preview, pids.anvil]) {
    if (!pid) continue;
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* exited */ } }
  }
  fs.rmSync(file, {force: true});
}

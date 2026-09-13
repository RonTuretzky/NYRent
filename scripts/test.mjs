import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
process.chdir(new URL("..", import.meta.url).pathname);
const solc = spawnSync("which", ["solc"], { encoding: "utf8" }).stdout.trim();
const build = spawnSync("forge", ["build", ...(solc ? ["--use", solc] : [])], { stdio: "inherit" });
if (build.status) process.exit(build.status);
const children = new Set();
const start = (cmd, args, options = {}) => {
  const p = spawn(cmd, args, options); children.add(p); p.on("exit", () => children.delete(p)); return p;
};
const stop = () => { for (const p of children) p.kill("SIGTERM"); };
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stop(); process.exit(1); });
const chain = start("anvil", ["--host", "127.0.0.1", "--port", "18548", "--chain-id", "31338", "--timestamp", "1789041600", "--gas-limit", "120000000", "--silent"], { stdio: "pipe" });
let diagnostic = ""; chain.stderr.on("data", data => diagnostic += data); chain.stdout.resume();
try {
  await delay(400);
  if (chain.exitCode !== null) throw Error("Unable to start isolated test chain: " + diagnostic);
  const legacy = start("node", ["--test", "test/integration.test.mjs"], { env: { ...process.env, RENT_RPC: "http://127.0.0.1:18548" }, stdio: "inherit" });
  const code = await new Promise(resolve => legacy.on("exit", resolve));
  if (code !== 0) throw Error("Legacy integration tests failed");
  chain.kill("SIGTERM");
  const archived = start("node", ["--test", "test/archives.test.mjs"], { stdio: "inherit" });
  const nextCode = await new Promise(resolve => archived.on("exit", resolve));
  if (nextCode !== 0) throw Error("Archive/pinned-key tests failed");
} finally { stop(); }

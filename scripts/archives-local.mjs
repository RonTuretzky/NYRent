import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { JsonRpcProvider, Contract } from "ethers";
import {
  deployArchives,
  ARCHIVE_RPC,
  ARCHIVE_START,
} from "./deploy-archives.mjs";
process.chdir(new URL("..", import.meta.url).pathname);
const children = [];
const start = (cmd, args) => {
  const p = spawn(cmd, args, { stdio: "inherit" });
  children.push(p);
  return p;
};
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    for (const p of children) p.kill("SIGTERM");
    process.exit(0);
  });
const solc = spawnSync("which", ["solc"], { encoding: "utf8" }).stdout.trim();
const built = spawnSync("forge", ["build", ...(solc ? ["--use", solc] : [])], {
  stdio: "inherit",
});
if (built.status) process.exit(built.status);
const data = spawnSync("node", ["scripts/archive-data.mjs"], {
  stdio: "inherit",
});
if (data.status) process.exit(data.status);
let running = false;
try {
  const r = await fetch(ARCHIVE_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_chainId",
      params: [],
    }),
    signal: AbortSignal.timeout(700),
  });
  const v = await r.json();
  if (v.result !== "0x7a6b") throw Error("Port 18547 belongs to another chain");
  running = true;
} catch (e) {
  if (e.message.includes("another chain")) throw e;
}
if (!running) {
  start("anvil", [
    "--host",
    "127.0.0.1",
    "--port",
    "18547",
    "--chain-id",
    "31339",
    "--timestamp",
    String(ARCHIVE_START),
    "--gas-limit",
    "120000000",
    "--state",
    ".local/archive-anvil-state.json",
    "--state-interval",
    "10",
    "--silent",
  ]);
  await delay(500);
}
const provider = new JsonRpcProvider(ARCHIVE_RPC);
let reuse = false;
if (existsSync("web/archive/config.json")) {
  const c = JSON.parse(readFileSync("web/archive/config.json"));
  if ((await provider.getCode(c.feed)) !== "0x") {
    const feed = new Contract(
      c.feed,
      ["function policyHash() view returns(bytes32)"],
      provider,
    );
    reuse = (await feed.policyHash()) === c.policyHash;
  }
}
if (!reuse) await deployArchives(provider);
provider.destroy();
try {
  const r = await fetch("http://127.0.0.1:8766/archive/corpus.json", {
    signal: AbortSignal.timeout(700),
  });
  if (!r.ok) throw Error();
} catch {
  start("node", ["scripts/server.mjs"]);
}
console.log(
  "Archive parser: http://127.0.0.1:8766/archives.html\nArchive excerpts are real research evidence. Signatures and keys in the optional transaction harness are synthetic.",
);

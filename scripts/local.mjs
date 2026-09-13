import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { JsonRpcProvider, Contract } from "ethers";
import { generate } from "./fixtures.mjs";
import { deploy, RPC } from "./deploy.mjs";
process.chdir(new URL("..", import.meta.url).pathname);
const children = [];
function start(cmd, args) {
  const p = spawn(cmd, args, { stdio: "inherit" });
  children.push(p);
  return p;
}
function stop() {
  for (const p of children) p.kill("SIGTERM");
}
process.on("SIGINT", () => {
  stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stop();
  process.exit(0);
});
let running = false;
try {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_chainId",
      params: [],
    }),
    signal: AbortSignal.timeout(800),
  });
  const x = await r.json();
  if (x.result !== "0x7a6a")
    throw Error("Port 18545 is occupied by another chain");
  running = true;
} catch (e) {
  if (e.message.includes("another chain")) throw e;
}
if (!existsSync(".local/fixtures.json")) await generate();
const localSolc = spawnSync("which", ["solc"], {
  encoding: "utf8",
}).stdout.trim();
const args = ["build"];
if (localSolc) args.push("--use", localSolc);
const build = spawnSync("forge", args, { stdio: "inherit" });
if (build.status) process.exit(build.status);
if (!running) {
  start("anvil", [
    "--host",
    "127.0.0.1",
    "--port",
    "18545",
    "--chain-id",
    "31338",
    "--timestamp",
    String(JSON.parse(readFileSync(".local/fixtures.json")).start),
    "--gas-limit",
    "120000000",
    "--state",
    ".local/anvil-state.json",
    "--state-interval",
    "10",
    "--silent",
  ]);
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
      });
      break;
    } catch {
      await delay(200);
    }
  }
}
const provider = new JsonRpcProvider(RPC);
let reuse = false;
if (existsSync("web/config.json")) {
  const c = JSON.parse(readFileSync("web/config.json"));
  if ((await provider.getCode(c.RentEmailFeed)) !== "0x") {
    const f = new Contract(
      c.RentEmailFeed,
      ["function policyHash() view returns(bytes32)"],
      provider,
    );
    reuse = (await f.policyHash()) === c.policyHash;
  }
}
if (!reuse) await deploy(provider);
else console.log("Reusing the existing local deployment and monthly records.");
provider.destroy();
try {
  const r = await fetch("http://127.0.0.1:8766/config.json", {
    signal: AbortSignal.timeout(800),
  });
  if (r.ok) {
    console.log("Already open at http://127.0.0.1:8766");
  } else start("node", ["scripts/server.mjs"]);
} catch {
  start("node", ["scripts/server.mjs"]);
}
console.log(
  "Local test application: http://127.0.0.1:8766\nNo public network, personal email, or real funds are used.",
);

#!/usr/bin/env node
/**
 * gen-abi.mjs — regenerate web/src/chain/abi.ts from the compiled contracts.
 *
 *   node scripts/gen-abi.mjs
 *
 * Runs `forge inspect <contract> abi --json` for CredailyRentOracle, CoverPool,
 * CoverToken and SwapAndBuyRouter and writes them as `as const` JSON ABIs
 * (fully typed for viem/wagmi). The currency/ERC-20 ABI is a hand-maintained
 * constant below (it is not our contract). Run after any contract interface
 * change.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "web", "src", "chain", "abi.ts");

const CONTRACTS = [
  ["oracleAbi", "src/CredailyRentOracle.sol:CredailyRentOracle"],
  ["poolAbi", "src/CoverPool.sol:CoverPool"],
  ["coverTokenAbi", "src/CoverToken.sol:CoverToken"],
  ["routerAbi", "src/SwapAndBuyRouter.sol:SwapAndBuyRouter"],
];

/** Pool currencies (WXDAI on Gnosis, USDC on Arbitrum) + minimal ERC-20.
 * `deposit`/`withdraw` are the WETH9-style wrap surface (WXDAI only). */
const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "wad", type: "uint256" }], outputs: [] },
];

function inspect(target) {
  const json = execFileSync("forge", ["inspect", target, "abi", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    // keep lint notes off stdout
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(json);
}

const sections = [];
const errorEntries = [];
const seenErrors = new Set();

for (const [exportName, target] of CONTRACTS) {
  const abi = inspect(target);
  sections.push(
    `/** ${target} (forge inspect). */\nexport const ${exportName} = ${JSON.stringify(abi, null, 2)} as const satisfies Abi;`,
  );
  for (const item of abi) {
    if (item.type !== "error") continue;
    const key = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
    if (seenErrors.has(key)) continue;
    seenErrors.add(key);
    errorEntries.push(item);
  }
}

sections.push(
  `/** Pool currencies (WXDAI on Gnosis, USDC on Arbitrum) + minimal ERC-20; deposit/withdraw are WETH9-style (WXDAI only). */\nexport const erc20Abi = ${JSON.stringify(ERC20_ABI, null, 2)} as const satisfies Abi;`,
);

sections.push(
  `/** Every custom error across our contracts (deduplicated), for decodeErrorResult fallback loops. */\nexport const allErrorsAbi = ${JSON.stringify(errorEntries, null, 2)} as const satisfies Abi;`,
);

const header = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Regenerate with \`node scripts/gen-abi.mjs\` (runs \`forge inspect\` on the
 * compiled contracts). JSON ABIs are exported \`as const\` so viem/wagmi infer
 * full argument/return types with no parseAbi step.
 */
import type { Abi } from "viem";
`;

writeFileSync(OUT, `${header}\n${sections.join("\n\n")}\n`);
console.log(`wrote ${OUT}`);

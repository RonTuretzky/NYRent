#!/usr/bin/env node
/**
 * Build-level check for the production bundle (run after `npm run build`):
 *   - every neighborhood-policy route and the live pool address are in it;
 *   - none of the retired office-market products leaked back in: no old
 *     CoverPool / Uniswap v4 / router addresses, no app copy for them, and no
 *     public assets that only the removed pages used.
 * Library code (RainbowKit's chain table and wallet names) legitimately
 * mentions other chains and wallets, so only app-authored strings are banned.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(WEB, "..");
const DIST = path.join(WEB, "dist");
const failures = [];

if (!existsSync(path.join(DIST, "index.html"))) {
  console.error("web/dist/index.html is missing: run `npm run build` first.");
  process.exit(1);
}

const assets = readdirSync(path.join(DIST, "assets")).filter((f) => /\.(js|css)$/.test(f));
const bundle = assets.map((f) => readFileSync(path.join(DIST, "assets", f), "utf8")).join("\n");
const html = readFileSync(path.join(DIST, "index.html"), "utf8");
const lower = bundle.toLowerCase();

// 1. What must be there.
for (const route of ["/policies", "/policies/new", "/policies/submit", "/policies/guide", "/policies/:id"]) {
  if (!bundle.includes(`"${route}"`)) failures.push(`route ${route} is not in the bundle`);
}
// Both pools (V2 for new policies, V1 for the earlier ones) and the shared oracle.
const live = JSON.parse(readFileSync(path.join(WEB, "src/chain/apartments-deployment.json"), "utf8"));
if (live.chainId !== 42161) failures.push(`apartments-deployment.json chainId is ${live.chainId}, expected 42161`);
const liveAddresses = {
  oracle: live.oracle, "v2.pool": live.v2?.pool, "v2.token": live.v2?.token,
};
for (const [key, value] of Object.entries(liveAddresses)) {
  const a = String(value ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(a) || /^0x0{40}$/.test(a)) failures.push(`apartments-deployment.json ${key} is not a live address`);
  else if (!lower.includes(a.toLowerCase())) failures.push(`live ${key} ${a} is not in the bundle`);
}
for (const text of ["Neighborhood rent policies", "Arbitrum One"]) {
  if (!html.includes(text)) failures.push(`index.html does not mention "${text}"`);
}

// 2. What must not be there: retired contract addresses.
const retired = new Set([
  // Former web/src/chain/deployments.json (CoverPool on Gnosis and Arbitrum).
  "0xCBD1F13ed4F376fBE662d4634de52C31bEFb6E43", "0x821d100Aa36Beec16D830C7E2B8D5249AF62C857",
  "0x68A3b66cb9d66c359B83d6CaAEeAABbA0cA29Aa3", "0x36861cbD424CDAaf9EF981Dd8C6a89F77CEB5f8b",
  "0x128fF279AbD137DE6e378E8aCcefFe77Ea5259B3", "0xaB1abFCa157aAD0bCE63A0a578c20122e1a9925E",
  "0x6699fb5cdADb6065c71457Dc44A6f9d0688a5e4c", "0xFE9CA93d607f38e152a3b3A1CB320950209c2F2F",
].map((a) => a.toLowerCase()));
// The office files the operator scripts still read (moved out of web/src).
for (const f of ["gnosis-deployment.json", "v4-deployments.json", "v4-targets.json"]) {
  const file = path.join(ROOT, "scripts", "data", f);
  if (!existsSync(file)) continue;
  for (const a of readFileSync(file, "utf8").match(/0x[0-9a-fA-F]{40}/g) ?? []) retired.add(a.toLowerCase());
}
const allowed = new Set([
  "0x0000000000000000000000000000000000000000",
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831", // Arbitrum USDC: the policy currency
]);
for (const a of retired) {
  if (!allowed.has(a) && lower.includes(a.slice(2))) failures.push(`retired address ${a} is in the bundle`);
}

// 3. App copy of the retired products.
for (const text of ["CRE Daily", "credaily", "WXDAI", "Bankr", "Redeem RENT", "Buy & Sell", "Create a market", "Manhattan Office Rent"]) {
  if (bundle.includes(text) || html.includes(text)) failures.push(`"${text}" is in the bundle`);
}

// 4. Public assets only the removed pages used.
for (const dir of ["story", "guides", "docs", "sources"]) {
  if (existsSync(path.join(DIST, dir))) failures.push(`dist/${dir}/ was published`);
}

if (failures.length) {
  console.error(`check-dist: ${failures.length} problem(s)\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(`check-dist: ok (${assets.length} assets, ${retired.size} retired addresses absent)`);

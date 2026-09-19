import path from "node:path";
import { fileURLToPath } from "node:url";
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "../..");
export const ART = path.join(HERE, ".artifacts");
export const RPC = "http://127.0.0.1:8559";
export const PREVIEW = "http://127.0.0.1:5199";
export const CREATOR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
export const BUYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
export const BASE_TIME = 1789642464n; // September 17, 2026 (synthetic TEST-key print)
export const START_TIME = BASE_TIME + 3600n;
export const OBS_START = 1819756800n; // September 1, 2027
export const OBS_END = 1822348740n;
export const CLAIM_END = 1824940740n;
export const SETTLE_TIME = OBS_START + 3600n;
export const UNIT = 1_000_000n;

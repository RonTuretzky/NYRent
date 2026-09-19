// Recording helpers for the guide GIFs: CDP screencast capture (PNG frames +
// per-frame timestamps for scripts/gif_assemble.py), a fake cursor overlay so
// clicks are visible on film, human pacing, and a caption chip. Everything here
// is presentation only — the flows themselves reuse e2e/support/helpers.ts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page } from "@playwright/test";
import { RPC_URL, CHAIN_ID_HEX, ACCOUNTS } from "../support/helpers";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Frames land in e2e/.artifacts/guide/<shot>/ — one dir per GIF. */
export const FRAMES_ROOT = path.join(HERE, "..", ".artifacts", "guide");

// ── capture ──────────────────────────────────────────────────────────────────

/**
 * Start a CDP Page.startScreencast capture into FRAMES_ROOT/<shot>. Frames are
 * PNG at up to 1800px wide (the config's 1280×720 viewport at deviceScaleFactor
 * 2 supersamples text 2× for the 900px GIF). screencastFrameAck is mandatory —
 * Chrome stops pushing after a few unacked frames. Returns the stop function,
 * which also writes timestamps.json for the assembly script.
 */
export async function startCapture(page: Page, shot: string): Promise<() => Promise<void>> {
  const dir = path.join(FRAMES_ROOT, shot);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const meta: { file: string; ts: number }[] = [];
  let n = 0;
  cdp.on("Page.screencastFrame", (ev) => {
    const file = `f${String(n).padStart(5, "0")}.png`;
    n += 1;
    fs.writeFileSync(path.join(dir, file), Buffer.from(ev.data, "base64"));
    meta.push({ file, ts: ev.metadata.timestamp ?? meta.length / 30 });
    cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", {
    format: "png",
    everyNthFrame: 2, // ~30 effective fps — plenty for the 12fps GIF resample
    maxWidth: 1800,
    maxHeight: 1013,
  });
  return async () => {
    await cdp.send("Page.stopScreencast").catch(() => {});
    await cdp.detach().catch(() => {});
    fs.writeFileSync(path.join(dir, "timestamps.json"), JSON.stringify(meta));
    if (meta.length < 2) throw new Error(`shot "${shot}" captured ${meta.length} frames`);
  };
}

// ── presentation overlays ─────────────────────────────────────────────────────

/** Fake cursor + click pulse, installed before any app script so it survives
 * navigations. Follows the real (trusted) mouse events Playwright dispatches;
 * it stays parked off-screen until the first glide. */
export async function installCursor(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const ensure = () => {
      if (document.getElementById("__guide-cursor") || !document.body) return;
      const c = document.createElement("div");
      c.id = "__guide-cursor";
      Object.assign(c.style, {
        position: "fixed",
        left: "-60px",
        top: "-60px",
        width: "22px",
        height: "22px",
        border: "2.5px solid #14532d",
        borderRadius: "50%",
        background: "rgba(255,255,255,0.6)",
        boxShadow: "0 1px 5px rgba(0,0,0,0.4)",
        zIndex: "2147483647",
        pointerEvents: "none",
        transform: "translate(-50%,-50%)",
        transition: "width 0.1s, height 0.1s",
      } as CSSStyleDeclaration);
      document.body.appendChild(c);
      document.addEventListener(
        "mousemove",
        (e) => {
          c.style.left = `${e.clientX}px`;
          c.style.top = `${e.clientY}px`;
        },
        true,
      );
      document.addEventListener(
        "mousedown",
        () => {
          c.style.width = "15px";
          c.style.height = "15px";
        },
        true,
      );
      document.addEventListener(
        "mouseup",
        () => {
          c.style.width = "22px";
          c.style.height = "22px";
        },
        true,
      );
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", ensure);
    } else {
      ensure();
    }
  });
}

/** Show (or with null, remove) the step-caption chip at the bottom center. */
export async function caption(page: Page, text: string | null): Promise<void> {
  await page.evaluate((t) => {
    let el = document.getElementById("__guide-caption");
    if (t === null) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement("div");
      el.id = "__guide-caption";
      Object.assign(el.style, {
        position: "fixed",
        left: "50%",
        bottom: "18px",
        transform: "translateX(-50%)",
        background: "rgba(17,24,39,0.92)",
        color: "#fff",
        padding: "8px 16px",
        borderRadius: "9999px",
        font: "600 14px/1.3 -apple-system, 'Helvetica Neue', sans-serif",
        letterSpacing: "0.01em",
        zIndex: "2147483646",
        pointerEvents: "none",
        boxShadow: "0 2px 10px rgba(0,0,0,0.35)",
        maxWidth: "80%",
        textAlign: "center",
      } as CSSStyleDeclaration);
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
}

// ── human pacing ─────────────────────────────────────────────────────────────

/** Viewer-readable beat between state changes (default 900ms). */
export const pause = (page: Page, ms = 900) => page.waitForTimeout(ms);

/** Glide the fake cursor to a locator's center in ~450ms of real mouse moves. */
export async function glide(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("glide target has no bounding box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 28 });
}

/** Glide to the target, beat, then click it — the visible click on film. */
export async function glideClick(page: Page, target: Locator, beat = 350): Promise<void> {
  await glide(page, target);
  await page.waitForTimeout(beat);
  await target.click();
}

/** Type like a person: glide to the field, click it, then key by key. */
export async function slowType(page: Page, target: Locator, text: string): Promise<void> {
  await glideClick(page, target);
  await target.pressSequentially(text, { delay: 110 });
}

/** Smooth-scroll an element to the viewport center and let it settle. */
export async function scrollToView(page: Page, target: Locator, settle = 1100): Promise<void> {
  await target.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
  await page.waitForTimeout(settle);
}

// ── guide wallet ─────────────────────────────────────────────────────────────

/** installWallet's twin, pointing at the rebranded shim (+ cursor overlay). */
export async function installGuideWallet(
  page: Page,
  opts: { accountIndex?: number; rpcUrl?: string; chainIdHex?: string; accounts?: readonly string[] } = {},
): Promise<void> {
  const cfg = {
    rpcUrl: opts.rpcUrl ?? RPC_URL,
    chainIdHex: opts.chainIdHex ?? CHAIN_ID_HEX,
    accounts: [...(opts.accounts ?? ACCOUNTS)],
    accountIndex: opts.accountIndex ?? 0,
  };
  await page.addInitScript((c) => {
    (window as unknown as { __E2E_WALLET_CONFIG: unknown }).__E2E_WALLET_CONFIG = c;
  }, cfg);
  await page.addInitScript({ path: path.join(HERE, "wallet-shim-guide.js") });
  await installCursor(page);
}

/**
 * Hold until a stat row STABLY shows `text`. On anvil, blocks only appear with
 * transactions, so a stale in-flight read can overwrite the fresh value and
 * then never be corrected (the app refetches per new block). Mining empty
 * blocks forces fresh refetches until the value sticks — presentation-only,
 * on the throwaway local chain.
 */
export async function awaitStat(page: Page, row: Locator, text: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    if (((await row.textContent()) ?? "").includes(text)) {
      await page.waitForTimeout(1200); // survive a late stale response
      if (((await row.textContent()) ?? "").includes(text)) return;
    }
    await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "evm_mine", params: [] }),
    });
    await page.waitForTimeout(1500);
  }
  await expect(row).toContainText(text);
}

const WALLET_OPTION = /NY Rent Cover Guide Wallet|E2E Test Wallet|Injected|Browser/i;

/**
 * Connect through the RainbowKit modal. `animated` glides the cursor through
 * the modal for on-camera shots; leave it false to connect quietly before a
 * capture starts so the GIF opens on the flow itself.
 */
export async function connectGuideWallet(page: Page, opts: { animated?: boolean } = {}): Promise<void> {
  const connect = page.getByRole("button", { name: /connect wallet/i }).first();
  if (!(await connect.isVisible().catch(() => false))) return;
  const option = page.getByRole("button", { name: WALLET_OPTION }).first();
  if (opts.animated) {
    await glideClick(page, connect);
    await expect(option).toBeVisible();
    await pause(page, 1100);
    await glideClick(page, option);
  } else {
    await connect.click();
    await option.click();
  }
  await expect(connect).toBeHidden();
}

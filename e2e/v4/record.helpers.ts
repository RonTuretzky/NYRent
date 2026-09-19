import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, type Locator, type Page } from "@playwright/test";
import { ART, ROOT } from "./constants";
import { installCursor } from "../record/guide.helpers";

export const MEDIA = path.join(ROOT, "web/public/guides");
export const RAW = path.join(ART, "recordings");
export type Chapter = { id: string; title: string; start: number; end?: number; caption: string };

export async function presentation(page: Page) {
  await installCursor(page);
  await page.addInitScript(() => {
    const install = () => {
      const style = document.createElement("style");
      style.textContent = "html { scroll-behavior: smooth !important; } body { padding-bottom: 108px !important; }";
      document.head.append(style);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
    else install();
  });
}

export async function say(page: Page, text: string, scope = "Local lifecycle · test-signed emails · synthetic funds") {
  await page.evaluate(({ text, scope }) => {
    let panel = document.getElementById("recording-caption");
    if (!panel) {
      panel = document.createElement("aside"); panel.id = "recording-caption";
      Object.assign(panel.style, { position: "fixed", bottom: "18px", left: "5%", width: "90%", boxSizing: "border-box", padding: "14px 24px", background: "rgba(15, 46, 32, .96)", color: "#fff", borderRadius: "16px", boxShadow: "0 5px 24px #0003", zIndex: "2147483646", fontFamily: "-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif", textAlign: "center", pointerEvents: "none" });
      panel.append(document.createElement("div"), document.createElement("div"));
      Object.assign((panel.children[0] as HTMLElement).style, { fontSize: "12px", fontWeight: "600", letterSpacing: ".055em", textTransform: "uppercase", color: "#b5e1bd", marginBottom: "5px" });
      Object.assign((panel.children[1] as HTMLElement).style, { fontSize: "20px", fontWeight: "600", lineHeight: "1.35" });
      document.body.append(panel);
    }
    panel.children[0].textContent = scope; panel.children[1].textContent = text;
  }, { text, scope });
}

export async function focus(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  await target.evaluate(el => el.scrollIntoView({ behavior: "smooth", block: "center" }));
  await page.waitForTimeout(600);
}
export async function click(page: Page, target: Locator) {
  await focus(page, target);
  await expect(target).toBeEnabled();
  const box = await target.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 24 });
  await page.waitForTimeout(250); await target.click();
}
export async function fill(page: Page, target: Locator, value: string) {
  await focus(page, target); await target.fill(value); await target.press("Tab");
  await page.waitForTimeout(500);
}
export const hold = (page: Page, seconds = 4) => page.waitForTimeout(seconds * 1000 * Number(process.env.RECORD_PACE ?? "1"));

function ffmpeg(args: string[]) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status})`);
}
export function publishCapture(raw: string, name: string, chapters: Chapter[], proof: Record<string, unknown>) {
  fs.mkdirSync(MEDIA, { recursive: true });
  const mp4 = path.join(MEDIA, `${name}.mp4`);
  ffmpeg(["-i", raw, "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "25", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4]);
  ffmpeg(["-ss", "3", "-i", mp4, "-frames:v", "1", "-q:v", "2", path.join(MEDIA, `${name}.jpg`)]);
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", mp4], { encoding: "utf8" });
  const duration = Number(probe.stdout.trim());
  if (!Number.isFinite(duration) || duration < 10) throw new Error("Recording duration is invalid");
  const complete = chapters.map((chapter, index) => ({ ...chapter, end: chapters[index + 1]?.start ?? duration }));
  fs.writeFileSync(path.join(MEDIA, `${name}.json`), JSON.stringify({ name, recordedAt: new Date().toISOString(), duration, chapters: complete, proof }, null, 2));
  for (const chapter of complete) {
    ffmpeg(["-ss", String(chapter.start), "-i", mp4, "-t", String(chapter.end - chapter.start), "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "25", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path.join(MEDIA, `${name}-${chapter.id}.mp4`)]);
  }
  return { duration, chapters: complete };
}

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeftIcon, ArrowRightIcon, DownloadSimpleIcon, PlayCircleIcon } from "@phosphor-icons/react";
import { Card } from "../components/States";

type Chapter = { id: string; title: string; caption: string; start: number; end: number };
type Recording = { duration: number; chapters: Chapter[] };
const ROOT = "/guides/rentsafe-lifecycle";
const timestamp = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export function Walkthrough() {
  const player = useRef<HTMLVideoElement>(null);
  const [recording, setRecording] = useState<Recording>();
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${ROOT}.json`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("Recording chapters are unavailable");
      return response.json() as Promise<Recording>;
    }).then(setRecording).catch(() => { /* The video remains usable without chapter metadata. */ });
    return () => controller.abort();
  }, []);
  function playChapter(start: number) {
    const video = player.current;
    if (!video) return;
    video.currentTime = start;
    video.scrollIntoView({ behavior: "smooth", block: "center" });
    void video.play().catch(() => { /* Native controls remain available if autoplay is restricted. */ });
  }
  return <div className="max-w-5xl mx-auto space-y-8">
    <header className="max-w-3xl space-y-4">
      <Link to="/docs" className="inline-flex items-center gap-2 text-sm font-parkBody text-surface-grey-2 hover:text-core-green"><ArrowLeftIcon size={16} /> Back to docs</Link>
      <p className="font-parkBody font-bold text-sm text-core-green">Watch the complete flow</p>
      <h1 className="font-parkDisplay font-bold text-4xl text-text-standard">From backing RENT to redeeming it</h1>
      <p className="font-parkBody text-lg text-surface-grey-2">Follow the three parties through the calculators, Uniswap trades, signed-email settlement and the final USDC payout. The recording is captioned throughout; no audio is required.</p>
    </header>

    <section className="overflow-hidden rounded-3xl border border-paper-2 bg-paper-0 shadow-sm" aria-label="Complete RentSafe lifecycle recording">
      <video ref={player} className="w-full bg-primary-pine" controls playsInline preload="metadata" poster={`${ROOT}.jpg`} aria-label="Captioned recording of the complete RentSafe local lifecycle">
        <source src={`${ROOT}.mp4`} type="video/mp4" />
        Your browser cannot play this recording. <a href={`${ROOT}.mp4`}>Download the MP4</a>.
      </video>
      <div className="p-5 sm:p-6 flex flex-wrap gap-4 justify-between items-start">
        <div>
          <h2 className="font-parkDisplay font-bold text-xl text-text-standard">The complete lifecycle {recording ? <span className="text-surface-grey-2 font-normal">· {timestamp(recording.duration)}</span> : null}</h2>
          <p className="font-parkBody text-sm text-surface-grey-2 mt-1">Local lifecycle · test-signed emails · synthetic funds</p>
        </div>
        <a href={`${ROOT}.mp4`} download className="inline-flex items-center gap-2 rounded-xl border border-paper-2 bg-paper-1 px-4 py-2 font-parkBody font-bold text-sm hover:border-core-green"><DownloadSimpleIcon size={18} /> Download recording</a>
      </div>
    </section>

    <Card>
      <h2 className="font-parkDisplay font-bold text-xl text-text-standard">What you’re watching</h2>
      <p className="font-parkBody text-surface-grey-2 mt-3">These are actual contract calls on an isolated local chain running the RentSafe contracts and Uniswap v4. The wallet funds are synthetic, and the future settlement email is signed with the test key. Local time advances to show the entire lifecycle, including the claim deadline.</p>
      <p className="font-parkBody text-surface-grey-2 mt-3">The public market is on Polygon. Its real September 2027 settlement has not happened. The recording uses a larger local liquidity pool so the complete 3,000 RENT example can execute; a quote on the public pool depends on its own available liquidity.</p>
    </Card>

    <section className="overflow-hidden rounded-3xl border border-paper-2 bg-paper-0 shadow-sm" aria-label="Polygon market walkthrough recording">
      <div className="p-5 sm:p-6">
        <h2 className="font-parkDisplay font-bold text-2xl text-text-standard">A look at the Polygon market</h2>
        <p className="font-parkBody text-surface-grey-2 mt-2">The current interface reading Polygon mainnet: the money-flow diagram, coverage calculator, a real liquidity-limited quote, the Uniswap guide and market view. It also verifies the actual CRE Daily publisher-signed email behind the $92.88/SF baseline. This separate recording connects no wallet and sends no transactions.</p>
      </div>
      <video className="w-full bg-primary-pine" controls playsInline preload="metadata" poster="/guides/rentsafe-polygon.jpg" aria-label="Captioned read-only walkthrough of the Polygon market">
        <source src="/guides/rentsafe-polygon.mp4" type="video/mp4" />
        Your browser cannot play this recording. <a href="/guides/rentsafe-polygon.mp4">Download the MP4</a>.
      </video>
      <div className="p-5 flex flex-wrap justify-between gap-3 items-center">
        <p className="font-parkBody text-sm text-surface-grey-2">Polygon mainnet · read-only · recorded September 19, 2026</p>
        <a href="/guides/rentsafe-polygon.mp4" download className="inline-flex items-center gap-2 font-parkBody font-bold text-sm text-core-green underline underline-offset-4"><DownloadSimpleIcon size={18} /> Download recording</a>
      </div>
    </section>

    {recording ? <section className="space-y-4" aria-labelledby="recording-chapters">
      <h2 id="recording-chapters" className="font-parkDisplay font-bold text-2xl text-text-standard">Jump to a step</h2>
      <div className="grid sm:grid-cols-2 gap-4">
        {recording.chapters.map((chapter, index) => <article key={chapter.id} className="rounded-2xl border border-paper-2 bg-paper-0 p-5 space-y-3">
          <button type="button" onClick={() => playChapter(chapter.start)} className="w-full text-left group flex items-start gap-3">
            <PlayCircleIcon size={28} className="text-core-green shrink-0 mt-0.5" />
            <span><span className="block font-parkBody text-xs text-surface-grey-2 mb-1">{String(index + 1).padStart(2, "0")} · {timestamp(chapter.start)}</span><span className="font-parkDisplay font-bold text-lg text-text-standard group-hover:text-core-green">{chapter.title}</span></span>
          </button>
          <p className="font-parkBody text-sm text-surface-grey-2 leading-relaxed">{chapter.caption}</p>
          <a href={`${ROOT}-${chapter.id}.mp4`} download className="inline-flex items-center gap-1.5 font-parkBody text-xs font-bold text-core-green underline underline-offset-4"><DownloadSimpleIcon size={14} /> Download this clip</a>
        </article>)}
      </div>
    </section> : null}

    <div className="grid sm:grid-cols-3 gap-4">
      {[{ to: "/docs/uniswap", label: "How Uniswap fits together" }, { to: "/settle", label: "Verify a signed newsletter" }, { to: "/redeem", label: "Redeem RENT" }].map(link => <Link key={link.to} to={link.to} className="flex items-center justify-between gap-3 rounded-2xl border border-paper-2 bg-paper-0 p-5 font-parkBody font-bold text-sm hover:border-core-green">{link.label}<ArrowRightIcon size={18} className="text-core-green shrink-0" /></Link>)}
    </div>
  </div>;
}

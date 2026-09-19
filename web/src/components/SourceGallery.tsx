import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRightIcon, PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { INDEXED_EDITION_COUNT, RENT_SOURCES, type RentSource } from "../data/rentSources";
import "./SourceGallery.css";

export function SourceLogo({ source, className = "" }: { source: RentSource; className?: string }) {
  return <div className={`flex h-16 items-center justify-center rounded-lg ${source.darkLogo ? "bg-primary-pine px-3" : "bg-white px-2"} ${className}`}>
    <img src={source.logo} alt="" width={source.smallLogo ? 32 : 128} height={source.smallLogo ? 32 : 56} loading="lazy" decoding="async" className={source.smallLogo ? "h-8 w-8 object-contain" : "h-14 w-full max-w-32 object-contain"} />
  </div>;
}

export function SourceGallery() {
  const [paused, setPaused] = useState(false);
  const headingId = useId();
  return <section className="source-gallery min-w-0 border-t border-paper-2 py-8 sm:py-10" data-paused={paused} aria-labelledby={headingId}>
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0 max-w-2xl">
        <p className="font-parkBody text-xs font-semibold uppercase tracking-widest text-core-green">Published rent research</p>
        <h2 id={headingId} className="font-parkDisplay mt-2 text-xl font-bold sm:text-2xl">The newsletters behind our source archive</h2>
        <p className="font-parkBody mt-2 text-sm leading-relaxed text-surface-grey-2">{INDEXED_EDITION_COUNT} indexed editions · {RENT_SOURCES.length} publications.</p>
      </div>
      <button type="button" onClick={() => setPaused(value => !value)} aria-pressed={paused} aria-label={paused ? "Play source gallery" : "Pause source gallery"} className="source-gallery-motion inline-flex min-h-11 items-center gap-2 rounded-xl border border-paper-2 bg-paper-0 px-4 font-parkBody text-sm text-surface-grey-2 hover:border-core-green focus-visible:outline-2 focus-visible:outline-core-green">
        {paused ? <PlayIcon size={16} /> : <PauseIcon size={16} />}{paused ? "Play" : "Pause"}
      </button>
    </div>
    <div className="source-gallery-window" aria-label="Indexed newsletter publications" onTouchStart={() => setPaused(true)}>
      <div className="source-gallery-track">
        {[false, true].map(duplicate => <div key={String(duplicate)} aria-hidden={duplicate || undefined} className={`source-gallery-group ${duplicate ? "source-gallery-duplicate" : ""}`}>
          {RENT_SOURCES.map(source => <a key={source.id} href={source.url} target="_blank" rel="noreferrer" tabIndex={duplicate ? -1 : undefined} className="source-gallery-card rounded-2xl border border-paper-2 bg-paper-0 p-4 transition-colors hover:border-core-green focus-visible:outline-2 focus-visible:outline-core-green">
            <SourceLogo source={source} />
            <p className="font-parkDisplay mt-3 min-h-10 text-sm font-bold leading-5 text-text-standard">{source.name}</p>
          </a>)}
        </div>)}
      </div>
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-x-5 gap-y-1">
      <p className="font-parkBody text-xs leading-relaxed text-surface-grey-2">Source attribution, not a partnership or endorsement.</p>
      <Link to="/docs/sources" className="inline-flex min-h-11 items-center gap-2 rounded-lg font-parkBody text-sm font-semibold text-core-green hover:underline focus-visible:outline-2 focus-visible:outline-core-green">Explore the source archive <ArrowRightIcon size={16} /></Link>
    </div>
  </section>;
}

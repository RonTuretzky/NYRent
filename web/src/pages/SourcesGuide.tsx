import { Link } from "react-router-dom";
import { ArrowLeftIcon, ArrowUpRightIcon, EnvelopeSimpleIcon } from "@phosphor-icons/react";
import { Card } from "../components/States";
import { SourceLogo } from "../components/SourceGallery";
import { INDEXED_EDITION_COUNT, RENT_SOURCES, type RentSourceEdition } from "../data/rentSources";

function editionDate(edition: RentSourceEdition) {
  return new Date(`${edition.publishedAt}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", ...(!edition.dateApproximate ? { day: "numeric" as const } : {}), year: "numeric", timeZone: "UTC" });
}

export function SourcesGuide() {
  return <div className="mx-auto max-w-5xl min-w-0 space-y-8">
    <header className="max-w-3xl">
      <Link to="/docs" className="inline-flex min-h-11 items-center gap-2 rounded-lg font-parkBody text-sm text-core-green hover:underline focus-visible:outline-2 focus-visible:outline-core-green"><ArrowLeftIcon size={16} />Docs</Link>
      <p className="font-parkBody mt-4 text-xs font-semibold uppercase tracking-widest text-core-green">Sources and evidence</p>
      <h1 className="font-parkDisplay mt-3 text-3xl font-bold sm:text-4xl">Where the rent numbers come from</h1>
      <p className="font-parkBody mt-4 text-base leading-relaxed text-surface-grey-2 sm:text-lg">Our research archive indexes {INDEXED_EDITION_COUNT} public newsletter editions from {RENT_SOURCES.length} publications. Explore the rent figures, original reports and evidence behind them.</p>
    </header>
    <Card>
      <div className="flex items-center gap-3"><EnvelopeSimpleIcon size={24} className="shrink-0 text-core-green" /><h2 className="font-parkDisplay text-xl font-bold">The authenticated baseline</h2></div>
      <p className="font-parkBody mt-3 leading-relaxed text-surface-grey-2">The authenticated September 2026 baseline is $92.88/SF, printed in CRE Daily’s Market Snapshot using CompStak data. The oracle verifies the original email’s publisher signature and body. A qualifying September 2027 email will determine the payout; that future observation has not arrived.</p>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 font-parkBody text-sm font-semibold text-core-green"><Link to="/settle" className="inline-flex min-h-11 items-center hover:underline">Verify a signed newsletter →</Link><Link to="/docs/walkthrough" className="inline-flex min-h-11 items-center hover:underline">Watch the publisher-email check →</Link></div>
    </Card>
    <section className="rounded-2xl border border-paper-2 bg-paper-1 p-5 sm:p-6" aria-labelledby="archive-scope">
      <h2 id="archive-scope" className="font-parkDisplay text-xl font-bold">What the broader archive establishes</h2>
      <p className="font-parkBody mt-3 leading-relaxed text-surface-grey-2">The editions below are public newsletter web versions and email archives. Some entries report averages, particular apartment sizes or other boroughs; entries with ambiguous dates or labels remain flagged for review.</p>
      <p className="font-parkBody mt-3 leading-relaxed text-surface-grey-2">Seven publishers are not seven independent datasets. Several repeat Corcoran, StreetEasy or Miller Samuel / The Real Deal figures. We retain that source lineage rather than counting republication as independent confirmation.</p>
    </section>
    <div className="grid items-start gap-5 md:grid-cols-2">
      {RENT_SOURCES.map(source => <article key={source.id} id={`source-${source.id}`} className="min-w-0 scroll-mt-24 rounded-2xl border border-paper-2 bg-paper-0 p-5 sm:p-6">
        <div className="flex items-center gap-4"><SourceLogo source={source} className="w-28 shrink-0" /><div className="min-w-0"><h2 className="font-parkDisplay text-lg font-bold leading-tight">{source.name}</h2></div></div>
        <p className="font-parkBody mt-4 text-sm leading-relaxed text-surface-grey-2">{source.description}</p>
        <a href={source.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex min-h-11 items-center gap-2 rounded-lg font-parkBody text-sm font-semibold text-core-green hover:underline focus-visible:outline-2 focus-visible:outline-core-green">Visit publication <ArrowUpRightIcon size={16} /></a>
        <details className="mt-3 border-t border-paper-2 pt-1">
          <summary className="min-h-11 cursor-pointer py-3 font-parkBody text-sm font-semibold text-text-standard focus-visible:outline-2 focus-visible:outline-core-green">Indexed editions ({source.editions.length})</summary>
          <ul className="space-y-3 pb-2">
            {source.editions.map(edition => <li key={edition.id} className="rounded-xl bg-paper-1 p-3">
              <a href={edition.publicArticleUrl ?? edition.url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center font-parkBody text-sm font-semibold leading-relaxed text-core-green underline underline-offset-4">{edition.title}</a>
              <p className="font-parkBody mt-1 text-xs leading-relaxed text-surface-grey-2">{editionDate(edition)}{edition.dateApproximate ? " · approximate publication month" : ""}{edition.requiresReview ? " · flagged for review" : ""}</p>
              {edition.lineage ? <p className="font-parkBody mt-2 text-xs leading-relaxed text-surface-grey-2">{edition.lineage}</p> : null}
              {edition.lineageUrl ? <a className="inline-flex min-h-11 items-center font-parkBody text-xs text-core-green underline" href={edition.lineageUrl} target="_blank" rel="noreferrer">Underlying report ↗</a> : null}
            </li>)}
          </ul>
        </details>
      </article>)}
    </div>
    <div className="font-parkBody text-xs leading-relaxed text-surface-grey-2">
      <p>Archive inventory reviewed September 19, 2026. Publisher names and logos identify sources; no partnership or endorsement is implied. No private email addresses or message bodies are published here.</p>
      <div className="mt-2 flex flex-wrap gap-x-5"><a className="inline-flex min-h-11 items-center text-core-green underline" href="/sources/indexed-editions.json">Public archive metadata</a><a className="inline-flex min-h-11 items-center text-core-green underline" href="/sources/logo-provenance.json">Logo provenance</a></div>
    </div>
  </div>;
}

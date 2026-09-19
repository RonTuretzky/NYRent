/**
 * reports.mjs — correlated market-research signals (NOT the settlement
 * metric; that is credaily.mjs / oracle.mjs). Four real sources, all
 * verified live 2026-09-18, all parsed with plain string scanning (no
 * regex, no cheerio, no new deps):
 *
 * 1. Cushman & Wakefield Manhattan Office MarketBeat page — quarterly
 *    overall vacancy % and overall asking rent $/SF. This is the exact
 *    settlement source of Kalshi's KXMANOFFVAC market.
 * 2. Commercial Observer RSS — daily NYC office-leasing headlines.
 * 3. The Real Deal New York RSS — daily NYC CRE headlines (the site's AWS
 *    WAF rejects non-"Mozilla/5.0"-prefixed user agents; our UA passes).
 * 4. BLS series CUURS12ASEHA (api.bls.gov, public JSON) — CPI rent of
 *    primary residence, NY metro area: the macro residential-rent trend.
 *
 * (Colliers /en/research and Moody's CommercialEdge blog hard-403 bots at
 * the CDN — probed 2026-09-18 — so they are intentionally not collected.)
 */
import {
  fetchText,
  fetchJson,
  signal,
  fail,
  htmlToText,
  between,
  parseDollarCents,
  parsePercent,
  isMain,
  printResult,
} from "./_shared.mjs";

// ---------------------------------------------------------------------------
// 1. Cushman & Wakefield Manhattan Office MarketBeat
// ---------------------------------------------------------------------------

export const CUSHMAN_URL =
  "https://www.cushmanwakefield.com/en/united-states/insights/us-marketbeats/new-york-city-area-marketbeats/manhattan-office";

const isDigit = (c) => c >= "0" && c <= "9";

/** First "Q<d> 20<dd>" period mentioned in the text ("Q2 2026"), or "". */
export function findQuarter(text) {
  let i = 0;
  for (;;) {
    i = text.indexOf("Q", i);
    if (i === -1) return "";
    const s = text.slice(i, i + 7); // "Q2 2026"
    if (isDigit(s[1]) && s[2] === " " && s[3] === "2" && s[4] === "0" && isDigit(s[5]) && isDigit(s[6])) {
      return s;
    }
    i += 1;
  }
}

/** "Q2 2026" -> ISO date of the quarter end (the datum's reference date). */
export function quarterEndIso(quarter) {
  if (!quarter) return "";
  const q = Number(quarter[1]);
  const year = Number(quarter.slice(3));
  if (!(q >= 1 && q <= 4) || !Number.isFinite(year)) return "";
  const monthDay = ["03-31", "06-30", "09-30", "12-31"][q - 1];
  return `${year}-${monthDay}T00:00:00Z`;
}

/**
 * Parse the MarketBeat page text: overall vacancy % and overall asking rent.
 * The asking-rent sentence reads "… overall asking rents dipped by $0.29 to
 * $72.83 per square foot (psf) …", so the level is the amount after " to $"
 * (falling back to the first amount for "remained stable at $76.98" wording).
 */
export function parseCushman(html) {
  const text = htmlToText(html);
  const quarter = findQuarter(text);

  let vacancyPct = null;
  const vi = text.indexOf("overall vacancy rate");
  if (vi !== -1) {
    const p = parsePercent(text, vi, 300);
    if (p) vacancyPct = p.pct;
  }

  let askingRentCents = null;
  const ai = text.indexOf("overall asking rents");
  if (ai !== -1) {
    const windowEnd = ai + 300;
    const toIdx = text.indexOf(" to $", ai);
    const from = toIdx !== -1 && toIdx < windowEnd ? toIdx + 4 : ai;
    const d = parseDollarCents(text, from, 300);
    if (d) askingRentCents = d.cents;
  }

  return { quarter, vacancyPct, askingRentCents };
}

export async function collectCushman() {
  const source = "cushman";
  const page = await fetchText(CUSHMAN_URL, { accept: "text/html" });
  if (!page.ok) return fail(source, page.error);
  const { quarter, vacancyPct, askingRentCents } = parseCushman(page.text);
  const asOf = quarterEndIso(quarter) || new Date().toISOString();
  const signals = [];
  if (vacancyPct !== null) {
    signals.push(
      signal({
        source,
        asOf,
        kind: "manhattan_office_vacancy_pct",
        value: vacancyPct,
        detail: `C&W Manhattan Office MarketBeat ${quarter || "(period unknown)"} overall vacancy rate (KXMANOFFVAC settlement source)`,
        url: CUSHMAN_URL,
      }),
    );
  }
  if (askingRentCents !== null) {
    signals.push(
      signal({
        source,
        asOf,
        kind: "manhattan_office_overall_asking_rent_cents",
        value: askingRentCents,
        detail: `C&W Manhattan Office MarketBeat ${quarter || "(period unknown)"} overall asking rent $${(askingRentCents / 100).toFixed(2)}/SF (asking, not effective)`,
        url: CUSHMAN_URL,
      }),
    );
  }
  if (signals.length === 0) return fail(source, "page fetched but neither vacancy nor asking rent parsed");
  return { ok: true, signals };
}

// ---------------------------------------------------------------------------
// 2 + 3. RSS feeds (Commercial Observer, The Real Deal New York)
// ---------------------------------------------------------------------------

export const CO_FEED_URL = "https://commercialobserver.com/feed/";
export const TRD_FEED_URL = "https://therealdeal.com/new-york/feed/";

export const OFFICE_KEYWORDS = [
  "office",
  "lease",
  "leasing",
  "manhattan",
  "rent",
  "vacancy",
  "tower",
  "landlord",
  "tenant",
  "sublease",
];

/** Strip CDATA wrappers, then decode entities/tags to plain text. */
const rssText = (raw) => htmlToText(raw.split("<![CDATA[").join("").split("]]>").join(""));

/** Parse RSS 2.0 <item> blocks with plain string scanning. */
export function parseRssItems(xml) {
  const items = [];
  let i = 0;
  for (;;) {
    const start = xml.indexOf("<item>", i);
    if (start === -1) break;
    const end = xml.indexOf("</item>", start);
    if (end === -1) break;
    const block = xml.slice(start, end);
    items.push({
      title: rssText(between(block, "<title>", "</title>")).trim(),
      link: rssText(between(block, "<link>", "</link>")).trim(),
      pubDate: between(block, "<pubDate>", "</pubDate>").trim(),
    });
    i = end + 7;
  }
  return items;
}

/** Crude relevance score: how many office-market keywords the title hits. */
export function scoreHeadline(title) {
  const t = title.toLowerCase();
  let score = 0;
  for (const kw of OFFICE_KEYWORDS) if (t.includes(kw)) score += 1;
  return score;
}

const pubDateIso = (pubDate) => {
  const d = new Date(pubDate);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
};

/** Feed XML -> per-headline signals + one rollup count signal. */
export function feedToSignals(source, xml, feedUrl) {
  const items = parseRssItems(xml);
  const signals = [];
  let newest = "";
  for (const item of items) {
    const score = scoreHeadline(item.title);
    if (score < 1) continue;
    const asOf = pubDateIso(item.pubDate);
    if (asOf > newest) newest = asOf;
    signals.push(
      signal({ source, asOf, kind: "news_headline", value: score, detail: item.title, url: item.link }),
    );
  }
  signals.push(
    signal({
      source,
      asOf: newest || new Date().toISOString(),
      kind: "nyc_office_headline_count",
      value: signals.length,
      detail: `${signals.length}/${items.length} current feed items match office-market keywords`,
      url: feedUrl,
    }),
  );
  return { signals, itemCount: items.length };
}

async function collectFeed(source, feedUrl) {
  const r = await fetchText(feedUrl, { accept: "application/rss+xml, application/xml, text/xml, */*" });
  if (!r.ok) return fail(source, r.error);
  const { signals, itemCount } = feedToSignals(source, r.text, feedUrl);
  if (itemCount === 0) return fail(source, "feed fetched but contained no <item> entries");
  return { ok: true, signals };
}

export const collectCommercialObserver = () => collectFeed("commercialobserver", CO_FEED_URL);
export const collectTheRealDeal = () => collectFeed("therealdeal", TRD_FEED_URL);

// ---------------------------------------------------------------------------
// 4. BLS CUURS12ASEHA — CPI rent of primary residence, NY metro
// ---------------------------------------------------------------------------

export const BLS_SERIES = "CUURS12ASEHA";
export const BLS_URL = `https://api.bls.gov/publicAPI/v2/timeseries/data/${BLS_SERIES}`;

/** BLS JSON -> { latest, yoyPct } (yoyPct null when no year-ago datum). */
export function parseBls(json) {
  if (json?.status !== "REQUEST_SUCCEEDED") return null;
  const series = json?.Results?.series?.[0];
  const data = series?.data ?? [];
  if (data.length === 0) return null;
  const latest = data[0]; // BLS returns newest first
  const prior = data.find((d) => d.period === latest.period && Number(d.year) === Number(latest.year) - 1);
  const latestValue = Number(latest.value);
  const yoyPct = prior ? ((latestValue / Number(prior.value)) - 1) * 100 : null;
  return { latest, latestValue, yoyPct };
}

const blsAsOf = (entry) => `${entry.year}-${entry.period.slice(1)}-01T00:00:00Z`; // period "M08" -> 2026-08-01

export async function collectBls() {
  const source = "bls";
  const r = await fetchJson(BLS_URL);
  if (!r.ok) return fail(source, r.error);
  const parsed = parseBls(r.json);
  if (!parsed) return fail(source, `unexpected BLS payload (status=${r.json?.status})`);
  const { latest, latestValue, yoyPct } = parsed;
  const signals = [
    signal({
      source,
      asOf: blsAsOf(latest),
      kind: "nyc_rent_cpi_index",
      value: latestValue,
      detail: `BLS ${BLS_SERIES} (CPI rent of primary residence, NY metro) ${latest.periodName} ${latest.year} = ${latest.value}`,
      url: BLS_URL,
    }),
  ];
  if (yoyPct !== null) {
    signals.push(
      signal({
        source,
        asOf: blsAsOf(latest),
        kind: "nyc_rent_cpi_yoy_pct",
        value: Math.round(yoyPct * 100) / 100,
        detail: `BLS ${BLS_SERIES} year-over-year change, ${latest.periodName} ${Number(latest.year) - 1} -> ${latest.year}`,
        url: BLS_URL,
      }),
    );
  }
  return { ok: true, signals };
}

// ---------------------------------------------------------------------------
// Aggregate collector
// ---------------------------------------------------------------------------

/** Run all four report sources; ok when at least one succeeded. */
export async function collectReports() {
  const results = await Promise.all([
    collectCushman(),
    collectCommercialObserver(),
    collectTheRealDeal(),
    collectBls(),
  ]);
  const signals = [];
  const errors = [];
  for (const r of results) {
    if (r.ok) signals.push(...r.signals);
    else errors.push(`${r.source}: ${r.error}`);
  }
  if (signals.length === 0) return fail("reports", errors.join(" | "));
  return { ok: true, signals, errors };
}

if (isMain(import.meta.url)) {
  const res = await collectReports();
  printResult("reports", res);
  if (res.ok && res.errors?.length) console.log(`  (non-fatal: ${res.errors.join(" | ")})`);
  process.exit(res.ok ? 0 : 1);
}

/**
 * kalshi.mjs — Kalshi prediction-market collector (public, unauthenticated
 * market data; verified live 2026-09-18).
 *
 *   GET https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=X
 *   GET https://api.elections.kalshi.com/trade-api/v2/series?category=Economics
 *
 * Core series: KXMANOFFVAC (Manhattan office vacancy — settled on the same
 * Cushman & Wakefield MarketBeat that reports.mjs scrapes; vacancy is the
 * inverse-signal for effective rents) plus the NYC residential rent series.
 * `discover` additionally scans the Economics series list for any other
 * NYC/Manhattan rent/office/vacancy series and includes them.
 *
 * Prices are correlated signals, NOT the settlement metric (that is
 * credaily.mjs / oracle.mjs).
 */
import { fetchJson, signal, fail, isMain, printResult } from "./_shared.mjs";

export const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

export const DEFAULT_SERIES = ["KXMANOFFVAC", "KXNYCRENTSY", "KXNYCASKRENT", "KXMANHATTANRENT"];

const NYC_WORDS = ["manhattan", "nyc", "new york"];
const RENT_WORDS = ["rent", "office", "vacancy"];

/** Filter a /series listing down to NYC rent/office/vacancy series tickers. */
export function filterNycRentSeries(seriesJson) {
  const out = [];
  for (const s of seriesJson?.series ?? []) {
    const t = `${s.title ?? ""} ${s.ticker ?? ""}`.toLowerCase();
    if (NYC_WORDS.some((w) => t.includes(w)) && RENT_WORDS.some((w) => t.includes(w))) {
      out.push(s.ticker);
    }
  }
  return out;
}

/**
 * Turn one /markets response into Signals (one per market). Each signal also
 * carries a structured `market` block (ticker/status/expiry/open interest/
 * volume) so consumers can select markets without re-parsing `detail`.
 */
export function marketsToSignals(seriesTicker, marketsJson) {
  const signals = [];
  for (const m of marketsJson?.markets ?? []) {
    const last = m.last_price_dollars !== undefined ? Number(m.last_price_dollars) : Number(m.last_price ?? 0) / 100;
    if (!Number.isFinite(last)) continue;
    signals.push({
      ...signal({
        source: "kalshi",
        asOf: m.updated_time ?? m.open_time ?? new Date().toISOString(),
        kind: "kalshi_yes_price",
        value: last,
        detail:
          `${m.ticker} — ${m.title ?? ""} | yes ${m.yes_bid_dollars ?? "?"}/${m.yes_ask_dollars ?? "?"}` +
          ` vol=${m.volume_fp ?? "?"} oi=${m.open_interest_fp ?? "?"} status=${m.status ?? "?"}` +
          (m.result ? ` result=${m.result}` : ""),
        url: `https://kalshi.com/markets/${seriesTicker.toLowerCase()}`,
      }),
      market: {
        ticker: m.ticker ?? "",
        status: m.status ?? "",
        expirationTime: m.expiration_time ?? m.expected_expiration_time ?? null,
        openInterest: Number(m.open_interest_fp ?? m.open_interest ?? 0),
        volume: Number(m.volume_fp ?? m.volume ?? 0),
      },
    });
  }
  return signals;
}

/**
 * Pick the market signal that should drive the vacancy-stress modifier:
 * ACTIVE markets of the given series with NONZERO open interest only,
 * preferring the NEAREST expiry — never just first-in-API-order (which can be
 * a closed, finalized, or never-traded strike whose last price is meaningless).
 * Returns the chosen signal or null.
 */
export function pickVacancyMarket(signals, { seriesPrefix = "KXMANOFFVAC" } = {}) {
  const candidates = (signals ?? []).filter(
    (s) =>
      s?.kind === "kalshi_yes_price" &&
      (s.market?.ticker ?? "").startsWith(seriesPrefix) &&
      s.market?.status === "active" &&
      Number(s.market?.openInterest) > 0 &&
      Number.isFinite(s.value),
  );
  candidates.sort((a, b) => {
    const ea = Date.parse(a.market?.expirationTime ?? "");
    const eb = Date.parse(b.market?.expirationTime ?? "");
    return (Number.isFinite(ea) ? ea : Infinity) - (Number.isFinite(eb) ? eb : Infinity);
  });
  return candidates[0] ?? null;
}

/** Live discovery of extra NYC rent/office series via the series endpoint. */
export async function discoverSeries({ timeoutMs } = {}) {
  const r = await fetchJson(`${KALSHI_BASE}/series?category=Economics`, { timeoutMs });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, tickers: filterNycRentSeries(r.json) };
}

/**
 * Collector: fetch markets for the core series plus any discovered NYC
 * rent/office series. Never throws; per-series failures are non-fatal.
 */
export async function collectKalshi({ seriesTickers = DEFAULT_SERIES, discover = true, maxSeries = 12 } = {}) {
  const source = "kalshi";
  const tickers = [...seriesTickers];
  const errors = [];

  if (discover) {
    const found = await discoverSeries();
    if (found.ok) {
      for (const t of found.tickers) if (!tickers.includes(t)) tickers.push(t);
    } else {
      errors.push(`series discovery failed: ${found.error}`);
    }
  }

  const signals = [];
  for (const ticker of tickers.slice(0, maxSeries)) {
    const r = await fetchJson(`${KALSHI_BASE}/markets?series_ticker=${encodeURIComponent(ticker)}`);
    if (!r.ok) {
      errors.push(r.error);
      continue;
    }
    signals.push(...marketsToSignals(ticker, r.json));
  }
  if (signals.length === 0) return fail(source, `no markets returned: ${errors.join(" | ") || "all series empty"}`);
  return { ok: true, signals, errors };
}

if (isMain(import.meta.url)) {
  const res = await collectKalshi();
  printResult("kalshi", res);
  if (res.ok && res.errors?.length) console.log(`  (non-fatal: ${res.errors.join(" | ")})`);
  process.exit(res.ok ? 0 : 1);
}

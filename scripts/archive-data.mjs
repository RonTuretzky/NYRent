import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";

// Input is preserved research evidence, not original RFC5322 messages.
const original = JSON.parse(
  await readFile("data/archive-research-corpus.json", "utf8"),
);
const profiles = {
  pinpointe: 0,
  bigger_apple: 1,
  hemlane: 2,
  cre_daily_ny: 3,
  finding_space: 4,
  hallmark: 5,
  broadsheet: 6,
};
const rejected = {
  "pinpointe-2025-05": "NoMatchingMedian",
  "pinpointe-2025-07": "StaleSection",
  "cre-2026-03": "NoMatchingMedian",
  "bigger-2026-03": "NoMatchingMedian",
  "hallmark-2026-07": "UnsupportedPublication",
  "broadsheet-2024-09": "UnsupportedPublication",
};
const cases = original.map((r) => {
  let text = r.text;
  const segments = [{ kind: "quoted_excerpt", text: r.text }];
  if (
    r.source === "pinpointe" &&
    !r.id.endsWith("2026-05") &&
    !text.startsWith("Market Pulse:")
  ) {
    const heading = r.location.split(" / ")[0];
    segments.unshift(
      { kind: "observed_section_heading", text: heading },
      { kind: "observed_section_heading", text: "Rental Rundown" },
    );
    text = `${heading}\nRental Rundown\n${text}`;
  }
  const expected = r.expected.find(
    ([geo, statistic, bedrooms]) =>
      geo === "manhattan" && statistic === "median" && bedrooms === "all",
  );
  return {
    id: r.id,
    publication: profiles[r.source],
    source: r.source,
    publishedAt: r.published_at,
    issuedAt: Date.parse(r.published_at + "T12:00:00Z") / 1000,
    url: r.url,
    evidenceKind: r.evidence_kind,
    location: r.location,
    fixtureKind: "curated_archive_excerpt",
    originalEmail: false,
    authenticated: false,
    contentType: "text/plain; charset=utf-8",
    encoding: "8bit",
    text,
    segments,
    sha256: createHash("sha256").update(text).digest("hex"),
    note: "Visible archive wording and section labels only. Line breaks are normalized; intervening content is omitted. Publication date is unauthenticated metadata for parser testing. This is not original email MIME.",
    expected: rejected[r.id]
      ? { error: rejected[r.id] }
      : { month: Number(expected[4].replace("-", "")), cents: expected[3] },
  };
});
await mkdir("web/archive", { recursive: true });
await writeFile("web/archive/corpus.json", JSON.stringify(cases, null, 2));
console.log(
  `Prepared ${cases.length} archive excerpt cases; ${cases.filter((r) => !r.expected.error).length} eligible Manhattan medians.`,
);

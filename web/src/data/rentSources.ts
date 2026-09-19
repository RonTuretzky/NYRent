import raw from "./rentSources.json";

export type RentSourceEdition = {
  id: string;
  title: string;
  publishedAt: string;
  dateApproximate: boolean;
  url: string;
  publicArticleUrl: string | null;
  kind: string;
  lineage?: string;
  lineageUrl?: string;
  requiresReview: boolean;
};
export type RentSource = {
  id: string;
  name: string;
  url: string;
  description: string;
  logo: string;
  logoKind: string;
  darkLogo: boolean;
  smallLogo: boolean;
  liveOraclePublisher: boolean;
  editions: RentSourceEdition[];
};
export const RENT_SOURCES = raw as RentSource[];
export const INDEXED_EDITION_COUNT = RENT_SOURCES.reduce((sum, source) => sum + source.editions.length, 0);

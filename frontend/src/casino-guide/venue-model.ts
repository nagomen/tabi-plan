interface VenueComparison {
  readonly use: string;
  readonly tables: string;
  readonly machines: string;
  readonly trait: string;
  readonly access: string;
}

interface VenueFact {
  readonly label: string;
  readonly value: string;
}

interface VenueLink {
  readonly label: string;
  readonly href: string;
}

/** 国別データと共通の比較・地図UIを結ぶ店舗データ契約。 */
export interface CasinoVenue {
  readonly id: string;
  readonly number: string;
  readonly shortName: string;
  readonly matrixName: string;
  readonly name: string;
  readonly titleLines: readonly string[];
  readonly eyebrow: string;
  readonly area: string;
  readonly mapSummary: string;
  readonly lat: number;
  readonly lng: number;
  readonly recommended: boolean;
  readonly airport: boolean;
  readonly badge: string;
  readonly lead: string;
  readonly comparison: VenueComparison;
  readonly facts: readonly VenueFact[];
  readonly fit: string;
  readonly links: readonly VenueLink[];
  readonly verifiedAt: `${number}-${number}-${number}`;
}

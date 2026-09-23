// The API's own vocabulary, kept small: a day is a date and a version.
export interface DaySelection {
  date: string;
  winner: string;
  commemoratio: string;
  scriptura: string;
  commune: string;
  communetype: string;
  rank: string;
  rule: string;
  laudes: number;
  communerule: string;
  headline: string;
  colourKey: string;
  titles: string[];
}

export interface CalendarArtifact {
  version: string;
  year: number;
  generatedBy: string;
  days: Record<string, DaySelection>;
}

export interface CalendarIndex {
  generatedBy: string;
  versions: Record<string, { version: string; years: number[] }>;
}

/** ``Rubrics 1960 - 1960`` -> ``rubrics-1960-1960``, one dash per gap. */
export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The reader's own version names, as its settings offer them. */
export const VERSIONS = [
  "Rubrics 1960 - 1960",
  "Rubrics 1960 - 2020 USA",
  "Reduced - 1955",
  "Divino Afflatu - 1954",
  "Divino Afflatu - 1939",
  "Tridentine - 1906",
  "Tridentine - 1888",
  "Tridentine - 1570",
  "Monastic - 1963",
  "Monastic - 1963 - Barroux",
  "Monastic Divino 1930",
  "Monastic Tridentinum 1617",
  "Monastic Tridentinum Cisterciensis 1951",
  "Monastic Tridentinum Cisterciensis Altovadensis",
  "Ordo Praedicatorum - 1962",
] as const;

export function normalizeVersion(requested: string | null): string {
  const wanted = (requested ?? "").trim();
  if (wanted === "") return VERSIONS[0];
  const exact = VERSIONS.find((version) => version === wanted);
  if (exact) return exact;
  const loose = VERSIONS.find((version) => version.toLowerCase() === wanted.toLowerCase());
  return loose ?? VERSIONS[0];
}

// The reader's own version names, as its settings offer them. The engine knows
// all of these; the Worker normalises whatever arrives into one of them.
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

export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function normalizeVersion(requested: string | null): string {
  const wanted = (requested ?? "").trim();
  if (wanted === "") return VERSIONS[0];
  const exact = VERSIONS.find((version) => version === wanted);
  if (exact) return exact;
  const loose = VERSIONS.find((version) => version.toLowerCase() === wanted.toLowerCase());
  return loose ?? VERSIONS[0];
}

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

export const CALENDARS = [
  { value: "Generale", label: "Calendarium Generale" },
  { value: "Urbis", label: "Diœcesis Urbis seu Romana" },
  { value: "Monacensis", label: "Archidiœcesis Monacensis et Frisingensis" },
  { value: "Passaviensis", label: "Diœcesis Passaviensis" },
  { value: "Ratisbonensis", label: "Diœcesis Ratisbonensis" },
  { value: "Spirensis", label: "Diœcesis Spirensis" },
  { value: "Brasilia", label: "Brasília (Brasil)" },
  { value: "Ultrajectum", label: "Archidiœcesis Ultrajectensis" },
  { value: "Groningen", label: "Diœcesis Groningensis" },
] as const;

export const LANGUAGES = [
  { value: "Latin", label: "Latin" },
  { value: "English", label: "English" },
  { value: "Deutsch", label: "Deutsch" },
  { value: "Francais", label: "Français" },
  { value: "Italiano", label: "Italiano" },
  { value: "Espanol", label: "Español" },
  { value: "Portugues", label: "Português" },
  { value: "Polski", label: "Polski" },
  { value: "Magyar", label: "Magyar" },
  { value: "Magyar-Kaldi", label: "Magyar (Káldi)" },
  { value: "Nederlands", label: "Nederlands" },
  { value: "Dansk", label: "Dansk" },
  { value: "Bohemice", label: "Čeština" },
  { value: "Cesky-Schaller", label: "Čeština (Schaller)" },
  { value: "Vietnamice", label: "Tiếng Việt" },
  { value: "Hebrew", label: "עברית" },
  { value: "Latin-Bea", label: "Latin (Pius XII psalter)" },
  { value: "Latin-gabc", label: "Latin (gabc)" },
  { value: "Polski-Newer", label: "Polski (newer)" },
] as const;

export const VOTIVES = [
  { value: "Hodie", label: "Missa diei" },
  { value: "C1", label: "Apostolorum" },
  { value: "C1a", label: "Evangelistarum" },
  { value: "C2", label: "Unius Martyris Pontificis" },
  { value: "C2a", label: "Unius Martyris non Pontificis" },
  { value: "C3", label: "Plurium Martyrum Pontificum" },
  { value: "C3a", label: "Plurium Martyrum non Pontificum" },
  { value: "C4", label: "Confessoris Pontificis" },
  { value: "C4a", label: "Doctoris Pontificis" },
  { value: "C4c", label: "Plurium Confessorum Pontificum" },
  { value: "C5", label: "Confessoris non Pontificis" },
  { value: "C5a", label: "Doctoris non Pontificis" },
  { value: "C5b", label: "Abbatis" },
  { value: "C5c", label: "Plurium Confessorum non Pontificum" },
  { value: "C6", label: "Unius Virginis Martyris" },
  { value: "C6a", label: "Unius Virginis tantum" },
  { value: "C6b", label: "Plurium Virginum Martyrum" },
  { value: "C7", label: "Unius non Virginis Martyris" },
  { value: "C7a", label: "Unius non Virginis nec Martyris" },
  { value: "C7b", label: "Plurium non Virginum Martyrum" },
  { value: "C8", label: "Dedicationis Ecclesiae" },
  { value: "C9", label: "Officium defunctorum" },
  { value: "C10", label: "Beata Maria in Sabbato" },
  { value: "C11", label: "Beatae Mariae Virginis" },
  { value: "C12", label: "Officium parvum Beatae Mariae Virginis" },
  { value: "V4", label: "De S. Joseph Sponso BMV (Feria IV)" },
  { value: "V6", label: "De Passione DNJC (Feria VI)" },
] as const;

export const MASS_FORMS = [
  { value: "Propers", label: "Propers" },
  { value: "Full", label: "Full Mass" },
] as const;

export const HOURS = [
  "Matutinum",
  "Laudes",
  "Prima",
  "Tertia",
  "Sexta",
  "Nona",
  "Vesperae",
  "Completorium",
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

export function normalizeCalendar(requested: string | null): string {
  const wanted = (requested ?? "").trim();
  if (wanted === "") return CALENDARS[0].value;
  const exact = CALENDARS.find((calendar) => calendar.value === wanted);
  if (exact) return exact.value;
  const loose = CALENDARS.find((calendar) => calendar.value.toLowerCase() === wanted.toLowerCase());
  return loose?.value ?? CALENDARS[0].value;
}

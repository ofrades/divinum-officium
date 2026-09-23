// The martyrology's opening: "Luna duodécima. Anno Dómini 2026".
//
// A port of the engine's `_luna_day` / `_luna_table` / `_luna`
// (specials/specprima.pl). It is table-driven because the liturgical
// martyrologies print the moon's age per day with their own golden-number
// lettering, not an astronomical calculation.

/** Day of the year, 1-based, Gregorian. */
function yearDay(day: number, month: number, year: number): number {
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  let total = day;
  for (let index = 0; index < month - 1; index++) total += lengths[index];
  if (leap && month > 2) total += 1;
  return total;
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const LETTERS = "abcdefghiklmnpqrstuABCDERFGHMNP";

function lunaTable(yday: number, letter: string): number {
  const position = LETTERS.indexOf(letter) + 1;
  const modulus = yday < 36 ? 30 : ((yday - 35) % 59 || 59) < 29 ? 29 : 30;
  let index = yday % 59 < 36 ? position : position - 1;

  if (yday % 59 < 36) {
    if (position > 25) index -= 1;
    if (position === 25 && yday % 59 === 35) index += 1;
  } else {
    if (position > 25) index -= 2;
  }

  if (yday > 58) {
    if (position > 25 && yday % 59 < 5) index -= 1;
    if (position === 26 && yday % 59 === 5) index -= 1;
  }

  return ((index - 1 + (yday % 59)) % modulus + modulus) % modulus + 1;
}

export function lunaDay(month: number, day: number, year: number): number {
  const letters =
    year < 1700 ? "amDdqGgtNkBbnEerHhu"
    : year < 1900 ? "PlCcpFfsMiAamDdqGgt"
    : year < 2200 ? "NkBbnEerHhuPlCcpRfs"
    : "MiAamDdqGgtNkBbnEer";

  const goldenNumber = (year % 19) + 1;
  const letter = letters.slice(goldenNumber - 1, goldenNumber);
  let yday = yearDay(day, month, year);
  if (isLeap(year) && (month > 2 || (month === 2 && day > 23))) yday -= 1;

  let luna = lunaTable(yday, letter);
  if (goldenNumber === 1 && month === 1 && letter !== "P" && day + lunaTable(1, letter) < 32) {
    luna -= 1;
  }
  return luna;
}

const LATIN_ORDINALS = [
  "prima", "secúnda", "tértia", "quarta", "quinta", "sexta", "séptima", "octáva", "nona", "décima",
  "undécima", "duodécima", "tértia décima", "quarta décima", "quinta décima", "sexta décima",
  "décima séptima", "duodevicésima", "undevicésima", "vicésima", "vicésima prima", "vicésima secúnda",
  "vicésima tértia", "vicésima quarta", "vicésima quinta", "vicésima sexta", "vicésima séptima",
  "vicésima octáva", "vicésima nona", "tricésima",
];

const PORTUGUESE_ORDINALS = [
  "primeira", "segunda", "terceira", "quarta", "quinta", "sexta", "sétima", "oitava", "nona", "décima",
  "undécima", "duodécima", "décima terceira", "décima quarta", "décima quinta", "décima sexta",
  "décima sétima", "décima oitava", "décima nona", "vigésima", "vigésima primeira", "vigésima segunda",
  "vigésima terceira", "vigésima quarta", "vigésima quinta", "vigésima sexta", "vigésima sétima",
  "vigésima oitava", "vigésima nona", "trigésima",
];

/** "Luna duodécima. Anno Dómini 2026" — or the Portuguese wording. */
export function luna(month: number, day: number, year: number, lang: string): string {
  const day_ = lunaDay(month, day, year);
  if (/Portugues/i.test(lang)) {
    return `Lua ${PORTUGUESE_ORDINALS[day_ - 1]}. Ano do Senhor de ${year}`;
  }
  return `Luna ${LATIN_ORDINALS[day_ - 1]}. Anno Dómini ${year}`;
}

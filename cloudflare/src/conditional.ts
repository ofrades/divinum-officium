// A faithful port of the engine's conditional-line processor.
//
// The Divinum Officium data files are not plain text: they carry conditions —
// `(rubrica 196 ... omittitur)`, `(sed rubrica ^Monastic)`, `(deinde dicitur)` —
// whose semantics are a small language of stopwords, strengths, and scopes
// (line / chunk / nest, forwards and backwards). The engine implements it in
// `DivinumOfficium/SetupString.pl` (`process_conditional_lines`,
// `parse_conditional`, `vero`); this is that implementation, ported rather than
// reinvented, because every hour's shape depends on it.
//
// Backward scoping is why it cannot be a simple filter: a `sed` alternative
// *removes* lines already emitted before the condition, which is how
// `Capitulum Versus` replaces `Capitulum Responsorum Versus`, and how a ferial
// preces block disappears under the 1960 rubrics.

export interface ConditionContext {
  /** The rubrical version, exactly as the reader names it. */
  version: string;
  /** The liturgical season, for `tempore …` conditions. Approximated from the
   *  calendar artifact's day key (e.g. "Pent17" → "post Pentecosten"). */
  season: string;
  /** Votive office, when one is being read (`votiva c12` …). */
  votive: string;
  /** The hour being assembled, for `ad …` conditions. */
  hour: string;
}

const STOPWORD_WEIGHTS: Record<string, number> = {
  sed: 1,
  vero: 1,
  atque: 2,
  attamen: 3,
  si: 0,
  deinde: 1,
};

/** Stopwords that imply a backward scope even without an explicit one. */
const BACKSCOPED = new Set(["sed", "vero", "atque", "attamen"]);

/** Predicates the engine names outright; anything else is a regex on the subject. */
const PREDICATES: Record<string, (subject: string) => boolean> = {
  tridentina: (subject) => /Trident/.test(subject),
  monastica: (subject) => /Monastic/.test(subject),
  innovata: (subject) => /2020 USA|NewCal/i.test(subject),
  innovatis: (subject) => /2020 USA|NewCal/i.test(subject),
  paschali: (subject) => /Paschæ|Ascensionis|Octava Pentecostes/i.test(subject),
  "post septuagesimam": (subject) => /Septua|Quadra|Passio/i.test(subject),
  prima: (subject) => Number(subject) === 1,
  secunda: (subject) => Number(subject) === 2,
  tertia: (subject) => Number(subject) === 3,
  longior: (subject) => Number(subject) === 1,
  brevior: (subject) => Number(subject) === 2,
  "summorum pontificum": (subject) => /194[2-9]|195[45]|196/.test(subject),
  feriali: (subject) => /feria|vigilia/i.test(subject),
};

/** `vero($condition)` — `aut` binds tighter than `et`, `nisi` negates onwards. */
export function vero(condition: string, context: ConditionContext): boolean {
  const text = condition.trim();
  // The empty condition is true: safer, since conditions were once unused.
  if (text === "") return true;

  for (const branch of text.split(/\baut\b/)) {
    let negation = false;
    let affirmative = true;

    for (const piece of branch.split(/\b(et|nisi)\b/)) {
      if (/^nisi$/.test(piece)) {
        negation = true;
        continue;
      }
      if (/^et$/.test(piece)) continue;

      const item = piece.trim().replace(/\s+/g, " ");
      if (item === "") continue;

      let [subject, predicate] = splitOnce(item);
      // Subject is optional.
      if (predicate === undefined) {
        predicate = subject;
        subject = "";
      }
      // A multi-word predicate with implicit subject: `post octavam paschæ`.
      if (subject !== "" && !isKnownSubject(subject)) {
        predicate = `${subject} ${predicate}`;
        subject = "";
      }
      subject = subject === "" ? "tempore" : subject;

      const subjectValue = resolveSubject(subject, context);
      const predicateText = predicate;
      const test = PREDICATES[predicateText.toLowerCase()] ?? ((value: string) => new RegExp(predicateText, "i").test(value));

      if (!(test(subjectValue) !== negation)) affirmative = false;
    }

    if (affirmative) return true;
  }
  return false;
}

function splitOnce(text: string): [string, string | undefined] {
  const match = /^(\S+)\s*(.*)$/.exec(text);
  if (!match) return [text, undefined];
  return [match[1], match[2] === "" ? undefined : match[2]];
}

function isKnownSubject(subject: string): boolean {
  return (
    subject === "rubrica" ||
    subject === "rubricis" ||
    subject === "communi" ||
    subject === "tempore" ||
    subject === "die" ||
    subject === "feria" ||
    subject === "votiva" ||
    subject === "officio" ||
    subject === "ad" ||
    subject === "mense" ||
    subject === "missa" ||
    subject === "commune" ||
    subject === "dioecesis"
  );
}

function resolveSubject(subject: string, context: ConditionContext): string {
  switch (subject) {
    case "rubrica":
    case "rubricis":
    case "communi":
      return context.version;
    case "tempore":
      return context.season;
    case "votiva":
      return context.votive;
    case "ad":
      return context.hour;
    default:
      return "";
  }
}

type Scope = 0 | 1 | 2 | 3; // null, line, chunk, nest
const SCOPE_NULL = 0;
const SCOPE_LINE = 1;
const SCOPE_CHUNK = 2;
const SCOPE_NEST = 3;

const COND_NOT_YET_AFFIRMATIVE = 0;
const COND_AFFIRMATIVE = 1;
const COND_DUMMY_FRAME = 2;

// `\(\s*(sed|vero|…)*\s*(condition)\s*(scope)\s*\)\s*(rest)` — the engine's
// `$conditional_regex`, written out rather than composed, since it is subtle.
const CONDITION_RE = new RegExp(
  [
    "^\\(\\s*",
    "((?:(?:sed|vero|atque|attamen|si|deinde)\\b\\s*)*)", // stopwords
    "(.*?)", // the condition
    "((?:\\bloco\\s+(?:hu[ij]us\\s+versus|horum\\s+versuum)\\b)?\\s*",
    "(?:\\b(?:(?:dicitur|dicuntur)(?:\\s+semper)?",
    "|(?:hic\\s+versus\\s+)?omittitur",
    "|(?:hoc\\s+versus\\s+)?omittitur",
    "|(?:hæc\\s+versus\\s+)?omittuntur",
    "|(?:hi\\s+versus\\s+)?omittuntur",
    "|(?:haec\\s+versus\\s+)?omittuntur)\\b)?)", // the scope
    "\\s*\\)\\s*(.*)$", // the rest of the line
  ].join(""),
  "i",
);

function isBlank(line: string): boolean {
  return /^\s*$/.test(line);
}

/** `parse_conditional` — strength from stopwords, scopes from the directive. */
function parseConditional(stopwords: string, condition: string, scope: string, context: ConditionContext) {
  let strength = 0;
  for (const word of stopwords.toLowerCase().split(/\s+/)) {
    if (word === "") continue;
    strength += STOPWORD_WEIGHTS[word] ?? 0;
  }
  const result = vero(condition, context);
  const implicitBackscope = stopwords
    .toLowerCase()
    .split(/\s+/)
    .some((word) => BACKSCOPED.has(word));

  const backscope: Scope = /versuum|omittuntur/i.test(scope)
    ? SCOPE_NEST
    : /versus|omittitur/i.test(scope)
      ? SCOPE_CHUNK
      : !/semper/i.test(scope) && implicitBackscope
        ? SCOPE_LINE
        : SCOPE_NULL;

  let forwardscope: Scope;
  if (/omittitur|omittuntur/i.test(scope)) forwardscope = SCOPE_NULL;
  else if (/dicuntur/i.test(scope)) forwardscope = backscope === SCOPE_CHUNK ? SCOPE_CHUNK : SCOPE_NEST;
  else forwardscope = backscope === SCOPE_CHUNK || backscope === SCOPE_NEST ? SCOPE_CHUNK : SCOPE_LINE;

  return { strength, result, backscope, forwardscope };
}

/**
 * `process_conditional_lines` — walk the lines and decide which survive.
 *
 * A condition can carry a *backward* scope, which removes lines already
 * emitted; that is how a `sed` alternative replaces what came before it.
 */
export function processConditionalLines(lines: string[], context: ConditionContext): string[] {
  const output: string[] = [];
  const stack: Array<{ state: number; forward: Scope }> = [{ state: COND_AFFIRMATIVE, forward: SCOPE_NEST }];
  const offsets: number[] = [-1];

  for (const raw of lines) {
    let line = raw;
    const match = CONDITION_RE.exec(line);

    if (match) {
      const [, stopwords = "", condition = "", scope = "", rest = ""] = match;
      const { strength, result, backscope, forwardscope: parsedForward } = parseConditional(stopwords, condition ?? "", scope ?? "", context);
      let forwardscope = parsedForward;
      let outcome = result;
      line = rest;

      const topState = stack[stack.length - 1].state;
      if (topState === COND_AFFIRMATIVE || strength >= offsets.length - 1) {
        if (strength >= offsets.length - 1) {
          stack.length = 0;
        } else if (strength >= offsets.length - 1 - (stack.length - 1)) {
          stack.length = offsets.length - strength - 1;
        }

        if (outcome) {
          const fence = offsets.length - 1 >= strength ? offsets[strength] : -1;
          if (backscope === SCOPE_LINE) {
            if (output.length - 1 > fence) output.pop();
          } else if (backscope === SCOPE_CHUNK) {
            while (output.length - 1 > fence && !isBlank(output[output.length - 1])) output.pop();
            while (output.length - 1 > fence && isBlank(output[output.length - 1])) output.pop();
          } else if (backscope === SCOPE_NEST) {
            output.length = fence + 1;
          }
        }

        // Having backtracked, a null forward scope behaves like a satisfied
        // conditional with nesting forward scope.
        if (forwardscope === SCOPE_NULL) {
          forwardscope = SCOPE_NEST;
          outcome = true;
        }

        if (outcome) {
          for (let index = 0; index <= strength; index++) offsets[index] = output.length - 1;
        }

        while (strength < offsets.length - 1 - (stack.length - 1) - 1) {
          stack.push({ state: COND_DUMMY_FRAME, forward: forwardscope });
        }
        stack.push({ state: outcome ? COND_AFFIRMATIVE : COND_NOT_YET_AFFIRMATIVE, forward: forwardscope });
      }

      if (line === "") continue;
    }

    line = line.replace(/^~/, "");

    if (stack[stack.length - 1].state === COND_AFFIRMATIVE) output.push(line);

    while (stack[stack.length - 1].forward === SCOPE_LINE || (stack[stack.length - 1].forward === SCOPE_CHUNK && isBlank(line))) {
      do {
        stack.pop();
      } while (stack.length > 0 && stack[stack.length - 1].state === COND_DUMMY_FRAME);
      if (stack.length === 0) stack.push({ state: COND_AFFIRMATIVE, forward: SCOPE_NEST });
    }
  }

  return output;
}

/** The season a day belongs to, from the calendar artifact's day key. */
export function seasonFromDayKey(dayKey: string): string {
  if (/^Adv/.test(dayKey)) return "Adventus";
  if (/^Nat/.test(dayKey)) return "Nativitatis";
  if (/^Epi/.test(dayKey)) return "Epiphaniæ";
  if (/^Quadp/.test(dayKey)) return "Septuagesimæ";
  if (/^Quad[56]/.test(dayKey)) return "Passionis";
  if (/^Quad/.test(dayKey)) return "Quadragesimæ";
  if (/^Pasc/.test(dayKey)) return "Paschæ";
  if (/^Pent/.test(dayKey)) return "post Pentecosten";
  return "";
}

import type { DaySelection } from "./artifact";
import { seasonFromDayKey, type ConditionContext } from "./conditional";
import { lectioBrevis, littleChapter, minorOratio } from "./chapter";
import { psalmodyRows } from "./psalterium";
import { specialBody } from "./special";
import { renderBody, renderLine, type RenderContext } from "./render";
import { parseScript, scriptBlocks, scriptSections, type ScriptBlock, type TextSource } from "./script";
import { resolveSection } from "./texts";

// Assembling an hour: the day's identity comes from the calendar artifact, the
// shape of the hour comes from its Ordinarium script, and the texts come from
// the repository's files. This is the skeleton: it establishes the section
// frame (and the title, colour and heading the reader shows) so every later
// pass — references, psalmody, commemorations — has somewhere to land and
// something to be measured against.

export interface OfficeLine {
  k: "text" | "rubric" | "verse" | "title";
  marker?: string;
  text?: string;
  after?: string;
}

export interface OfficeColumn {
  label: string;
  note: string;
  lines: OfficeLine[];
}

export interface OfficeSection {
  columns: OfficeColumn[];
}

export interface OfficePayload {
  ok: true;
  rite: "office";
  date: string;
  hour: string;
  version: string;
  lang1: string;
  lang2: string;
  title: string;
  colourKey: string;
  colourName: string;
  hourTitle: string;
  commemorations: string[];
  sections: OfficeSection[];
  sectionCount: number;
  /** What this build of the assembler actually did, so a caller can tell. */
  assembler: { stage: string; notes: string[] };
}

export interface AssembleRequest {
  source: TextSource;
  date: string;
  hour: string;
  version: string;
  lang1: string;
  lang2: string;
  selection: DaySelection;
}

/** The engine's own heading for each hour. */
const HOUR_TITLES: Record<string, string> = {
  Matutinum: "Ad Matutinum",
  Laudes: "Ad Laudes",
  Prima: "Ad Primam",
  Tertia: "Ad Tertiam",
  Sexta: "Ad Sextam",
  Nona: "Ad Nonam",
  Vesperae: "Ad Vesperas",
  Completorium: "Ad Completorium",
};

/** Tertia, Sexta and Nona share one Ordinarium; Vespers has its own spelling. */
const ORDINARIUM_HOUR: Record<string, string> = {
  Tertia: "Minor",
  Sexta: "Minor",
  Nona: "Minor",
  Vesperae: "Vespera",
};

const COLOUR_NAMES: Record<string, string> = {
  black: "White",
  white: "White",
  red: "Red",
  green: "Green",
  purple: "Violet",
  blue: "Marian Blue",
  grey: "Black",
  gold: "Gold",
};

export const SUPPORTED_HOURS = ["Prima", "Laudes", "Vesperae", "Completorium"] as const;

/** The day's own file, as the engine reads it (per language). */
function dayFileFor(language: string, winner: string): string | undefined {
  return winner === "" ? undefined : `horas/${language}/${winner}`;
}

async function resolveBlock(
  block: ScriptBlock,
  language: string,
  request: AssembleRequest,
  context: ConditionContext,
  renderContext: RenderContext,
): Promise<OfficeLine[]> {
  const lines: OfficeLine[] = [];
  for (const item of block.items) {
    if (item.kind === "ref") {
      const body = await resolveSection({
        name: item.value,
        lang: language,
        dayFile: dayFileFor(language, request.selection.winner),
        source: request.source,
        context,
      });
      if (body) lines.push(...renderBody(body, renderContext, /^alleluia/i.test(item.value)));
      continue;
    }
    if (item.kind === "text") {
      const rendered = renderLine(item.value, renderContext);
      if (rendered) lines.push(rendered);
    }
  }
  return lines;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The day's rule can omit whole sections: `Omit Incipit Invitatorium Hymnus …`
 * (Good Friday, for instance). The engine tests the rule against a section's
 * *first word* — `#De Officio Capituli` is matched by `De`, `#Conclusio` by
 * `Conclusion` — so this does the same (specials.pl, "Omit this section if the
 * rule says so"), including its two guards.
 */
export function omittedByRule(label: string, rule: string, hour: string): boolean {
  if (rule === "") return false;
  const first = label.split(/\s+/)[0] ?? "";
  if (first === "" || !new RegExp(`Omit.*? ${escapeRegExp(first)}`, "i").test(rule)) return false;
  if (/Omit ad Matutinum/i.test(rule) && hour !== "Matutinum") return false;
  if (/Capitulum/i.test(label) && /Capitulum Versum 2/i.test(rule) && (hour === "Laudes" || hour === "Vesperae")) return false;
  return true;
}

export async function assembleOffice(request: AssembleRequest): Promise<OfficePayload> {
  const { source, hour, version, selection } = request;
  const notes: string[] = [];

  const ordinariumHour = ORDINARIUM_HOUR[hour] ?? hour;
  const script = await source.read(`horas/Ordinarium/${ordinariumHour}.txt`);
  if (script === null) {
    notes.push(`no Ordinarium script at horas/Ordinarium/${ordinariumHour}.txt`);
  }
  const context: ConditionContext = {
    version,
    // The season governs `tempore …` conditions; the artifact's day key names it.
    season: seasonFromDayKey(selection.titles[0] ?? ""),
    votive: "",
    hour,
  };
  const items = script === null ? [] : parseScript(script, context);
  const labels = scriptSections(items)
    .filter((section) => !omittedByRule(section.label, selection.rule, hour))
    // The preces are filled from tables the engine consults only when the day
    // calls for them; an empty `#Preces …` marker is therefore not rendered
    // until that table is ported.
    .filter((section) => section.hasContent || !/^Preces/i.test(section.label))
    .map((section) => section.label);

  notes.push(
    `${labels.length} sections from the Ordinarium; references resolve through the language's own tables`,
  );
  if (selection.headline === "" && selection.titles.length === 0) {
    notes.push("the calendar artifact has no headline for this day");
  }

  // Every block is resolved through the same pipeline — lookup, notation,
  // classification. A block whose references need a table that is not ported
  // yet simply comes out empty, and the parity tool reports the difference.
  const blocks = scriptBlocks(items).filter((block) => labels.includes(block.label));
  const renderContext: RenderContext = { version };
  const languages = [request.lang1, request.lang2];

  const sections: OfficeSection[] = [];
  const weekday = new Date(`${request.date}T12:00:00Z`).getUTCDay();
  for (const block of blocks) {
    // The psalmody is the one block that becomes several rows: one per psalm,
    // the first carrying the label and the antiphon, the last the repeat.
    if (/^Psalmi$/i.test(block.label)) {
      const rows = await psalmodyRows(
        request.source,
        request.lang1,
        hour,
        request.date,
        weekday,
        selection.rule,
        context,
        renderContext,
      );
      if (rows) {
        for (const [index, lines] of rows.entries()) {
          sections.push({
            columns: [{ label: index === 0 ? block.label : "", note: "", lines }, { label: "", note: "", lines: [] }],
          });
        }
        continue;
      }
    }

    const columns: OfficeColumn[] = [];
    for (const language of languages) {
      // The little chapter, its responsory and the versicle are generated from
      // the hour's Special file, not written in the Ordinarium.
      if (/^Capitulum/i.test(block.label) && /^(Prima|Tertia|Sexta|Nona)$/.test(hour)) {
        const chapter = await littleChapter(
          request.source,
          language,
          hour,
          context,
          renderContext,
          context.season,
          weekday,
        );
        if (chapter) {
          columns.push({ label: language === request.lang1 ? block.label : "", note: "", lines: chapter });
          continue;
        }
      }
      // Prime's short reading is generated too: blessing, reading, dismissal.
      if (/^Lectio brevis/i.test(block.label) && hour === "Prima") {
        const reading = await lectioBrevis(
          request.source,
          language,
          hour,
          selection.titles[0] ?? "",
          context,
          renderContext,
        );
        if (reading) {
          columns.push({ label: language === request.lang1 ? block.label : "", note: "", lines: reading });
          continue;
        }
      }
      // The Oratio of a little hour is generated: versicles, the day's collect.
      if (/^Oratio/i.test(block.label) && /^(Tertia|Sexta|Nona)$/.test(hour)) {
        const oratio = await minorOratio(request.source, language, request.selection, context, renderContext);
        if (oratio) {
          columns.push({ label: language === request.lang1 ? block.label : "", note: "", lines: oratio });
          continue;
        }
      }
      // The hymn of a little hour lives in the hour's Special file.
      const isHymn = /^Hymnus/i.test(block.label);
      let lines: OfficeLine[] = [];
      if (isHymn && /^(Prima|Tertia|Sexta|Nona)$/.test(hour)) {
        const body = await specialBody(request.source, language, hour, [`Hymnus ${hour}`, "Hymnus"], context);
        if (body) lines = renderBody(body, renderContext);
      }
      if (lines.length === 0) lines = await resolveBlock(block, language, request, context, renderContext);
      columns.push({ label: language === request.lang1 ? block.label : "", note: "", lines });
    }
    sections.push({ columns });
  }

  return {
    ok: true,
    rite: "office",
    date: request.date,
    hour,
    version,
    lang1: request.lang1,
    lang2: request.lang2,
    title: selection.headline,
    colourKey: selection.colourKey,
    colourName: COLOUR_NAMES[selection.colourKey] ?? "—",
    hourTitle: HOUR_TITLES[hour] ?? hour,
    commemorations: selection.commemoratio ? [selection.commemoratio] : [],
    sections,
    sectionCount: sections.length,
    assembler: { stage: "frame", notes },
  };
}

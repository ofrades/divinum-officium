import type { DaySelection } from "./artifact";
import { parseScript, scriptSections, type TextSource } from "./script";

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

export async function assembleOffice(request: AssembleRequest): Promise<OfficePayload> {
  const { source, hour, version, selection } = request;
  const notes: string[] = [];

  const ordinariumHour = ORDINARIUM_HOUR[hour] ?? hour;
  const script = await source.read(`horas/Ordinarium/${ordinariumHour}.txt`);
  if (script === null) {
    notes.push(`no Ordinarium script at horas/Ordinarium/${ordinariumHour}.txt`);
  }
  const items = script === null ? [] : parseScript(script, version, hour);
  const labels = scriptSections(items);

  notes.push(
    `frame only: ${labels.length} sections from the Ordinarium; references, psalmody and commemorations still to come`,
  );
  if (selection.headline === "" && selection.titles.length === 0) {
    notes.push("the calendar artifact has no headline for this day");
  }

  const sections: OfficeSection[] = labels.map((label) => ({
    columns: [
      { label, note: "", lines: [] },
      { label: "", note: "", lines: [] },
    ],
  }));

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

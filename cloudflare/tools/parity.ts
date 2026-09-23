#!/usr/bin/env bun
// Measure the TypeScript assembler against the golden corpus.
//
// The corpus was written by the engine itself (tools/generate_slice.py), in the
// reader's own format, so this is the number that matters: how much of a day's
// office the assembler reproduces, bit for bit.
//
//   bun tools/parity.ts --corpus tests/golden/1960-latin-portugues \
//       --repo ~/divinum-officium --hour Prima
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assembleOffice, type OfficePayload } from "../src/office";
import type { DaySelection } from "../src/artifact";
import type { TextSource } from "../src/script";

interface Args {
  corpus: string;
  repo: string;
  assets: string;
  hour: string;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    corpus: "tests/golden/1960-latin-portugues",
    repo: join(import.meta.dirname, "..", ".."),
    assets: join(import.meta.dirname, "..", ".assets"),
    hour: "Prima",
    limit: 0,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index].replace(/^--/, "");
    const value = argv[index + 1];
    if (key === "limit") args.limit = parseInt(value, 10);
    else if (key in args) (args as unknown as Record<string, string>)[key] = value;
  }
  return args;
}

/** Reads a repository file by its web/www-relative path. */
function repositorySource(repo: string): TextSource {
  return {
    async read(path: string) {
      const file = join(repo, "web", "www", path);
      return existsSync(file) ? readFile(file, "utf8") : null;
    },
  };
}

async function loadArtifact(assets: string, date: string, version: string) {
  const slug = version.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const file = join(assets, "calendar", slug, `${date.slice(0, 4)}.json`);
  if (!existsSync(file)) return null;
  const artifact = JSON.parse(await readFile(file, "utf8")) as { days: Record<string, DaySelection> };
  return artifact.days[date] ?? null;
}

function corpusSections(payload: OfficePayload | Record<string, unknown>): string[] {
  const sections = (payload as { sections?: Array<{ columns: Array<{ label: string }> }> }).sections ?? [];
  return sections
    .map((section) => section.columns.find((column) => column.label !== "")?.label ?? "")
    .filter((label) => label !== "");
}

/**
 * The labelled sections, in order, with their first-column lines.
 *
 * Continuation rows (a psalm continuing across the table, which the corpus
 * carries as an unlabelled section) are not compared here: they belong to the
 * psalmody, and until that is ported they would only shift the alignment.
 */
function labelledSections(payload: Record<string, unknown>): Array<{ label: string; lines: string[] }> {
  const sections = (payload as { sections?: OfficePayload["sections"] }).sections ?? [];
  const out: Array<{ label: string; lines: string[] }> = [];
  for (const section of sections) {
    const label = section.columns.find((column) => column.label !== "")?.label ?? "";
    if (label === "") continue;
    out.push({
      label,
      lines: (section.columns[0]?.lines ?? []).map((line) => `${line.k}|${line.marker ?? ""}|${line.text ?? ""}|${line.after ?? ""}`),
    });
  }
  return out;
}

function sectionLabel(payload: Record<string, unknown>, index: number): string {
  const sections = (payload as { sections?: OfficePayload["sections"] }).sections ?? [];
  const section = sections[index];
  if (!section) return "";
  return section.columns.find((column) => column.label !== "")?.label ?? "(continued)";
}

function lineTexts(payload: Record<string, unknown>): string[] {
  const sections = (payload as { sections?: OfficePayload["sections"] }).sections ?? [];
  const out: string[] = [];
  for (const section of sections) {
    for (const line of section.columns[0]?.lines ?? []) {
      out.push(`${line.k}|${line.marker ?? ""}|${line.text ?? ""}|${line.after ?? ""}`);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = repositorySource(args.repo);
  const officeDir = join(args.corpus, "office");

  const versions = (await readdir(officeDir)).filter((name) => !name.startsWith("."));
  let files: string[] = [];
  for (const version of versions) {
    const yearDirs = await readdir(join(officeDir, version));
    for (const year of yearDirs) {
      const dayDirs = await readdir(join(officeDir, version, year));
      for (const day of dayDirs.sort()) {
        const name = `${args.hour.toLowerCase()}-latin-portugues.json`;
        if (existsSync(join(officeDir, version, year, day, name))) {
          files.push(join(officeDir, version, year, day, name));
        }
      }
    }
  }
  files = files.sort();
  if (args.limit > 0) files = files.slice(0, args.limit);

  let titleMatches = 0;
  let colourMatches = 0;
  let labelMatches = 0;
  let labelTotal = 0;
  let lineMatches = 0;
  let lineTotal = 0;
  let daysWithSectionShape = 0;
  const examples: string[] = [];
  const byLabel = new Map<string, { want: number; matched: number }>();

  for (const file of files) {
    const corpus = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown> & {
      date: string;
      hour: string;
      version: string;
      title: string;
      colorKey: string;
      lang1: string;
      lang2: string;
    };
    const selection = await loadArtifact(args.assets, corpus.date, corpus.version);
    if (!selection) continue;

    const produced = await assembleOffice({
      source,
      date: corpus.date,
      hour: corpus.hour,
      version: corpus.version,
      lang1: corpus.lang1,
      lang2: corpus.lang2,
      selection,
    });

    if (produced.title === corpus.title) titleMatches++;
    if (produced.colourKey === corpus.colorKey) colourMatches++;

    const want = corpusSections(corpus);
    const got = produced.sections
      .map((section) => section.columns.find((column) => column.label !== "")?.label ?? "")
      .filter((label) => label !== "");
    labelTotal += want.length;
    let matched = 0;
    for (let index = 0; index < Math.min(want.length, got.length); index++) {
      if (want[index] === got[index]) matched++;
    }
    labelMatches += matched;
    if (want.length > 0 && matched === want.length) daysWithSectionShape++;

    // Line parity is per section: a global count hides which part of the hour
    // is done and which is not.
    const wantSections = labelledSections(corpus);
    const gotSections = labelledSections(produced as unknown as Record<string, unknown>);
    lineTotal += wantSections.reduce((sum, section) => sum + section.lines.length, 0);
    for (let index = 0; index < Math.min(wantSections.length, gotSections.length); index++) {
      const want = wantSections[index];
      const got = gotSections[index];
      let matched = 0;
      for (let line = 0; line < Math.min(want.lines.length, got.lines.length); line++) {
        if (want.lines[line] === got.lines[line]) matched++;
      }
      lineMatches += matched;
      const label = want.label;
      const stat = byLabel.get(label) ?? { want: 0, matched: 0 };
      stat.want += want.lines.length;
      stat.matched += matched;
      byLabel.set(label, stat);
    }

    if (examples.length < 3 && matched !== want.length) {
      examples.push(
        `  ${corpus.date}\n    corpus:   ${JSON.stringify(want)}\n    produced: ${JSON.stringify(got)}`,
      );
    }
  }

  const percent = (a: number, b: number) => (b === 0 ? "n/a" : `${((a / b) * 100).toFixed(1)}%`);
  console.log(`corpus:  ${args.corpus}`);
  console.log(`hour:    ${args.hour}   days: ${files.length}`);
  console.log("");
  console.log(`  title         ${titleMatches}/${files.length}   ${percent(titleMatches, files.length)}`);
  console.log(`  colour        ${colourMatches}/${files.length}   ${percent(colourMatches, files.length)}`);
  console.log(`  section shape ${daysWithSectionShape}/${files.length}   ${percent(daysWithSectionShape, files.length)}`);
  console.log(`  section labels ${labelMatches}/${labelTotal}   ${percent(labelMatches, labelTotal)}`);
  console.log(`  lines         ${lineMatches}/${lineTotal}   ${percent(lineMatches, lineTotal)}`);
  console.log("\nby section (corpus lines matched):");
  for (const [label, stat] of byLabel) {
    const bar = stat.want === 0 ? "" : `  ${percent(stat.matched, stat.want)}`;
    console.log(`  ${label.padEnd(30)} ${String(stat.matched).padStart(5)}/${String(stat.want).padEnd(5)}${bar}`);
  }
  if (examples.length) {
    console.log("\nfirst shape differences:");
    console.log(examples.join("\n"));
  }
}

await main();

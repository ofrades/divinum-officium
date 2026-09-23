// The reader itself: one page, no build step, no framework. It asks the API
// the same questions the Omarchy plugin does — what day is it, and what does
// this hour say — and draws the answer the same way: hour pills, day
// navigation, two language columns, and the liturgical colour of the day.
export const SITE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Divinum Officium</title>
<style>
  :root { --ink: #1c1a19; --dim: #6b6560; --line: #ddd7d0; --paper: #faf7f2; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink);
         font: 15px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
  main { max-width: 62rem; margin: 0 auto; padding: 2rem 1.25rem 5rem; }
  header { border-bottom: 1px solid var(--line); padding-bottom: 1rem; margin-bottom: 1.25rem; }
  h1 { font-size: 1rem; font-weight: 600; margin: 0 0 .35rem; letter-spacing: .01em; }
  .day { color: var(--dim); font-size: .9rem; }
  .colour { display: inline-block; width: .6rem; height: .6rem; border-radius: 50%;
            margin-right: .45rem; vertical-align: baseline; border: 1px solid rgba(0,0,0,.25); }
  nav { display: flex; flex-wrap: wrap; gap: .3rem; margin: 1.1rem 0 .6rem; }
  nav.day { gap: .5rem; align-items: center; }
  button { font: inherit; padding: .3rem .6rem; background: transparent; color: inherit;
           border: 1px solid var(--line); border-radius: .35rem; cursor: pointer; }
  button:hover { border-color: var(--dim); }
  button[aria-pressed="true"] { background: var(--ink); color: var(--paper); border-color: var(--ink); }
  .meta { color: var(--dim); font-size: .82rem; margin-top: .2rem; }
  section { border-top: 1px solid var(--line); padding: 1rem 0 .3rem; }
  section h2 { font-size: .78rem; font-weight: 600; color: var(--dim); text-transform: uppercase;
               letter-spacing: .09em; margin: 0 0 .6rem; }
  .cols { display: grid; grid-template-columns: 1fr; gap: 1.25rem; }
  @media (min-width: 46rem) { .cols.two { grid-template-columns: 1fr 1fr; } }
  p { margin: 0 0 .45rem; white-space: pre-wrap; }
  .rubric { color: #8d4b3f; }
  .verse .n { color: var(--dim); font-size: .78rem; margin-right: .35rem; }
  .title { font-weight: 600; }
  .title .after { color: var(--dim); font-weight: 400; font-size: .8rem; }
  .state { color: var(--dim); }
  footer { margin-top: 2.5rem; color: var(--dim); font-size: .78rem; }
  a { color: inherit; }
</style>
</head>
<body>
<main>
  <header>
    <h1 id="headline">Divinum Officium</h1>
    <div class="day" id="dayline"><span class="colour" id="colour" hidden></span><span id="date"></span></div>
    <div class="meta" id="meta"></div>
  </header>

  <nav class="day">
    <button id="prev" title="Previous day">‹</button>
    <button id="today">Today</button>
    <button id="next" title="Next day">›</button>
    <span style="flex:1"></span>
    <button id="office" aria-pressed="true">Officium</button>
    <button id="mass" aria-pressed="false">Missa</button>
  </nav>
  <nav id="hours"></nav>
  <nav class="day">
    <label class="meta">Languages
      <select id="langs">
        <option value="Latin|Portugues">Latin + Português</option>
        <option value="Latin|English">Latin + English</option>
        <option value="Latin|Latin">Latin only</option>
        <option value="Portugues|Portugues">Português only</option>
      </select>
    </label>
  </nav>

  <div id="text"><p class="state">Loading…</p></div>

  <footer>
    Texts from the <a href="https://github.com/DivinumOfficium/divinum-officium">Divinum Officium</a>
    project, assembled per request from the repository's own files.
  </footer>
</main>

<script>
const HOURS = ["Matutinum","Laudes","Prima","Tertia","Sexta","Nona","Vesperae","Completorium"];
const state = { date: new Date().toISOString().slice(0,10), hour: "Prima", rite: "office",
                lang1: "Latin", lang2: "Portugues", day: null, office: null };

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());

function shift(days) {
  const d = new Date(state.date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  state.date = iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())));
}

async function get(path) {
  const response = await fetch(path);
  if (!response.ok) return null;
  return response.json();
}

async function loadDay() {
  state.day = await get("/v1/day/" + state.date);
  $("headline").textContent = state.day?.headline || "Divinum Officium";
  $("date").textContent = new Date(state.date + "T12:00:00Z").toLocaleDateString(undefined,
    { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const colour = $("colour");
  if (state.day) {
    colour.hidden = false;
    colour.style.background = swatch(state.day.colourKey);
    colour.title = state.day.colourKey;
  } else {
    colour.hidden = true;
  }
  $("meta").textContent = state.day ? [state.day.rank && ("rank " + state.day.rank),
                                       state.day.commemorations.join(" · ")].filter(Boolean).join(" · ") : "";
}

function swatch(key) {
  return ({ white: "#f2efe9", black: "#f2efe9", grey: "#3a3a3f", red: "#b3453a",
            green: "#5c9a52", purple: "#8a6bbf", blue: "#5c85c4", gold: "#c9a227" })[key] || "#f2efe9";
}

function pills() {
  $("hours").innerHTML = "";
  for (const hour of HOURS) {
    const b = document.createElement("button");
    b.textContent = hour;
    b.setAttribute("aria-pressed", String(hour === state.hour));
    b.onclick = () => { state.hour = hour; pills(); loadText(); };
    $("hours").appendChild(b);
  }
}

function line(entry) {
  const rub = (m) => '<span class="rubric">' + m + "</span> ";
  if (entry.k === "rubric") return "<p>" + (entry.marker ? rub(entry.marker) : "") + escape(entry.text || "") + "</p>";
  if (entry.k === "verse") return '<p class="verse"><span class="n">' + escape(entry.marker || "") + "</span>" + escape(entry.text || "") + "</p>";
  if (entry.k === "title") return '<p class="title">' + escape(entry.text || "") + (entry.after ? ' <span class="after">' + escape(entry.after) + "</span>" : "") + "</p>";
  return "<p>" + escape(entry.text || "") + "</p>";
}

function escape(text) {
  return String(text).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

function render(payload) {
  const host = $("text");
  if (!payload || payload.ok !== true) {
    host.innerHTML = '<p class="state">' + escape(payload?.error || "Nothing came back for this hour.") + "</p>";
    return;
  }
  host.innerHTML = payload.sections.map((section) => {
    const columns = section.columns.filter((column) => column.lines.length > 0);
    if (columns.length === 0) return "";
    const label = columns.map((c) => c.label).find((l) => l) || "";
    const two = columns.length > 1;
    return "<section>" + (label ? "<h2>" + escape(label) + "</h2>" : "") +
      '<div class="cols' + (two ? " two" : "") + '">' +
      columns.map((c) => "<div>" + c.lines.map(line).join("") + "</div>").join("") +
      "</div></section>";
  }).join("");
}

async function loadText() {
  $("text").innerHTML = '<p class="state">Loading…</p>';
  const path = state.rite === "office"
    ? "/v1/office/" + state.date + "/" + state.hour
    : "/v1/mass/" + state.date;
  const query = "?lang1=" + state.lang1 + "&lang2=" + state.lang2;
  render(await get(path + query));
}

function controls() {
  $("prev").onclick = () => { shift(-1); refresh(); };
  $("next").onclick = () => { shift(1); refresh(); };
  $("today").onclick = () => { state.date = new Date().toISOString().slice(0, 10); refresh(); };
  $("office").onclick = () => { state.rite = "office"; rites(); loadText(); };
  $("mass").onclick = () => { state.rite = "mass"; rites(); loadText(); };
  $("langs").onchange = (event) => {
    const [lang1, lang2] = event.target.value.split("|");
    state.lang1 = lang1; state.lang2 = lang2; loadText();
  };
}

function rites() {
  $("office").setAttribute("aria-pressed", String(state.rite === "office"));
  $("mass").setAttribute("aria-pressed", String(state.rite === "mass"));
  $("hours").style.display = state.rite === "office" ? "flex" : "none";
}

async function refresh() { await loadDay(); await loadText(); }

controls(); pills(); rites(); refresh();
</script>
</body>
</html>
`;

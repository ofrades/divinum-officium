// The reader itself: one page, no build step. Its controls mirror the Omarchy
// plugin: rite, hour, rubrics, calendar, languages, votive Mass, and Mass form.
export const SITE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Divinum Officium</title>
<style>
  :root { color-scheme: light; --ink: #1c1a19; --dim: #6b6560; --line: #ddd7d0; --paper: #faf7f2; }
  :root[data-theme="dark"] { color-scheme: dark; --ink: #eee9e1; --dim: #aaa198; --line: #4a4540; --paper: #171514; }
  @media (prefers-color-scheme: dark) {
    :root[data-theme="system"] { color-scheme: dark; --ink: #eee9e1; --dim: #aaa198; --line: #4a4540; --paper: #171514; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink);
         font: 15px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
  main { max-width: 68rem; margin: 0 auto; padding: 2rem 1.25rem 5rem; }
  header { border-bottom: 1px solid var(--line); padding-bottom: 1rem; margin-bottom: 1.25rem; }
  h1 { font-size: 1rem; font-weight: 600; margin: 0 0 .35rem; letter-spacing: .01em; }
  .day { color: var(--dim); font-size: .9rem; }
  .colour { display: inline-block; width: .6rem; height: .6rem; border-radius: 50%;
            margin-right: .45rem; vertical-align: baseline; border: 1px solid rgba(0,0,0,.25); }
  nav { display: flex; flex-wrap: wrap; gap: .3rem; margin: 1.1rem 0 .6rem; }
  nav.day { gap: .5rem; align-items: center; }
  button, select { font: inherit; }
  button { padding: .3rem .6rem; background: transparent; color: inherit;
           border: 1px solid var(--line); border-radius: .35rem; cursor: pointer; }
  button:hover, select:hover { border-color: var(--dim); }
  button[aria-pressed="true"] { background: var(--ink); color: var(--paper); border-color: var(--ink); }
  .settings { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
              gap: .7rem; margin: 1.1rem 0 1.3rem; }
  .control { display: flex; flex-direction: column; gap: .25rem; color: var(--dim); font-size: .78rem; }
  select { width: 100%; min-width: 0; padding: .35rem .45rem; color: var(--ink);
           background: transparent; border: 1px solid var(--line); border-radius: .35rem; }
  .mass-controls { display: contents; }
  .mass-form { display: flex; gap: .3rem; align-items: end; }
  .mass-form button { flex: 1; }
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
    <button id="mass" aria-pressed="true">Missa</button>
    <button id="office" aria-pressed="false">Officium</button>
  </nav>
  <nav id="hours"></nav>

  <div class="settings">
    <label class="control">Rubrics<select id="version"></select></label>
    <label class="control">Calendar<select id="calendar"></select></label>
    <label class="control">Text<select id="lang1"></select></label>
    <label class="control">Second column<select id="lang2"></select></label>
    <label class="control">Theme<select id="theme">
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select></label>
    <div class="mass-controls" id="massControls">
      <label class="control">Mass<select id="votive"></select></label>
      <div class="control">
        <span>Form</span>
        <div class="mass-form">
          <button id="propers" aria-pressed="true">Propers</button>
          <button id="full" aria-pressed="false">Full Mass</button>
        </div>
      </div>
    </div>
  </div>

  <div id="text"><p class="state">Loading…</p></div>

  <footer>
    Texts from the <a href="https://github.com/DivinumOfficium/divinum-officium">Divinum Officium</a>
    project, assembled per request from the repository's own files.
  </footer>
</main>

<script>
const HOURS = ["Matutinum","Laudes","Prima","Tertia","Sexta","Nona","Vesperae","Completorium"];
const state = {
  date: new Date().toISOString().slice(0,10), hour: "Prima", rite: "mass",
  version: "Rubrics 1960 - 1960", calendar: "Generale", lang1: "Latin", lang2: "English",
  votive: "Hodie", propers: true, theme: "system",
  options: { versions: [], calendars: [], languages: [], votives: [] },
  day: null
};

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());

function storedTheme() {
  try {
    const value = localStorage.getItem("divinum-officium-theme");
    return ["system", "light", "dark"].includes(value) ? value : "system";
  } catch (_) {
    return "system";
  }
}

function applyTheme(value) {
  const theme = ["system", "light", "dark"].includes(value) ? value : "system";
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  $("theme").value = theme;
  try { localStorage.setItem("divinum-officium-theme", theme); } catch (_) {}
}

function shift(days) {
  const d = new Date(state.date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  state.date = iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())));
}

async function get(path, params) {
  const query = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  });
  const response = await fetch(path + (query.toString() ? "?" + query : ""));
  if (!response.ok) return null;
  return response.json();
}

function values(options) {
  return (options || []).map((option) => typeof option === "string"
    ? { value: option, label: option }
    : option);
}

function fill(id, options, selected) {
  const select = $(id);
  const list = values(options);
  select.innerHTML = list.map((option) =>
    '<option value="' + escape(option.value) + '">' + escape(option.label) + "</option>").join("");
  if (list.some((option) => option.value === selected)) select.value = selected;
  else if (list[0]) select.value = list[0].value;
}

async function loadOptions() {
  const index = await get("/v1/index.json");
  if (index) {
    state.options.calendars = index.calendars || [];
    state.options.languages = index.languages || [];
    state.options.votives = index.votives || [];
    state.options.versions = Object.values(index.versions || {}).map((entry) =>
      ({ value: entry.version, label: entry.version }));
  }
  fill("version", state.options.versions, state.version);
  fill("calendar", state.options.calendars, state.calendar);
  fill("lang1", state.options.languages, state.lang1);
  fill("lang2", [{ value: "None", label: "None (single column)" }].concat(state.options.languages), state.lang2);
  fill("votive", state.options.votives, state.votive);
  state.version = $("version").value || state.version;
  state.calendar = $("calendar").value || state.calendar;
  state.lang1 = $("lang1").value || state.lang1;
  state.lang2 = $("lang2").value || state.lang2;
  state.votive = $("votive").value || state.votive;
}

function shiftQuery() {
  return { version: state.version, calendar: state.calendar, lang1: state.lang1, lang2: state.lang2 };
}

async function loadDay() {
  state.day = await get("/v1/day/" + state.date, shiftQuery());
  $("headline").textContent = state.day?.headline || "Divinum Officium";
  $("date").textContent = new Date(state.date + "T12:00:00Z").toLocaleDateString(undefined,
    { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const colour = $("colour");
  if (state.day) {
    colour.hidden = false;
    colour.style.background = swatch(state.day.colourKey);
    colour.title = state.day.colourKey || "";
  } else {
    colour.hidden = true;
  }
  const calendar = values(state.options.calendars).find((entry) => entry.value === state.calendar);
  $("meta").textContent = state.day
    ? [calendar?.label, state.day.rank && ("rank " + state.day.rank), (state.day.commemorations || []).join(" · ")]
      .filter(Boolean).join(" · ")
    : "";
}

function swatch(key) {
  return ({ white: "#f2efe9", black: "#f2efe9", grey: "#3a3a3f", red: "#b3453a",
            green: "#5c9a52", purple: "#8a6bbf", blue: "#5c85c4", gold: "#c9a227" })[key] || "#f2efe9";
}

function pills() {
  $("hours").innerHTML = "";
  $("hours").style.display = state.rite === "office" ? "flex" : "none";
  if (state.rite !== "office") return;
  for (const hour of HOURS) {
    const button = document.createElement("button");
    button.textContent = hour;
    button.setAttribute("aria-pressed", String(hour === state.hour));
    button.onclick = () => { state.hour = hour; pills(); loadText(); };
    $("hours").appendChild(button);
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
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function render(payload) {
  const host = $("text");
  if (!payload || payload.ok !== true) {
    host.innerHTML = '<p class="state">' + escape(payload?.error || "Nothing came back for this request.") + "</p>";
    return;
  }
  host.innerHTML = payload.sections.map((section) => {
    const columns = section.columns.filter((column) => column.lines.length > 0);
    if (columns.length === 0) return "";
    const label = columns.map((column) => column.label).find((value) => value) || "";
    const two = columns.length > 1;
    return "<section>" + (label ? "<h2>" + escape(label) + "</h2>" : "") +
      '<div class="cols' + (two ? " two" : "") + '">' +
      columns.map((column) => "<div>" + column.lines.map(line).join("") + "</div>").join("") +
      "</div></section>";
  }).join("");
}

async function loadText() {
  $("text").innerHTML = '<p class="state">Loading…</p>';
  const path = state.rite === "office"
    ? "/v1/office/" + state.date + "/" + state.hour
    : "/v1/mass/" + state.date;
  const params = shiftQuery();
  if (state.rite === "mass") {
    params.votive = state.votive;
    if (state.propers) params.propers = "1";
  }
  render(await get(path, params));
}

function rites() {
  $("mass").setAttribute("aria-pressed", String(state.rite === "mass"));
  $("office").setAttribute("aria-pressed", String(state.rite === "office"));
  $("massControls").style.display = state.rite === "mass" ? "contents" : "none";
  pills();
}

function massForms() {
  $("propers").setAttribute("aria-pressed", String(state.propers));
  $("full").setAttribute("aria-pressed", String(!state.propers));
}

function controls() {
  $("prev").onclick = () => { shift(-1); refresh(); };
  $("next").onclick = () => { shift(1); refresh(); };
  $("today").onclick = () => { state.date = new Date().toISOString().slice(0,10); refresh(); };
  $("mass").onclick = () => { state.rite = "mass"; rites(); loadText(); };
  $("office").onclick = () => { state.rite = "office"; rites(); loadText(); };
  $("version").onchange = (event) => { state.version = event.target.value; refresh(); };
  $("calendar").onchange = (event) => { state.calendar = event.target.value; refresh(); };
  $("lang1").onchange = (event) => { state.lang1 = event.target.value; refresh(); };
  $("lang2").onchange = (event) => { state.lang2 = event.target.value === "None" ? state.lang1 : event.target.value; refresh(); };
  $("theme").onchange = (event) => applyTheme(event.target.value);
  $("votive").onchange = (event) => { state.votive = event.target.value; loadText(); };
  $("propers").onclick = () => { state.propers = true; massForms(); loadText(); };
  $("full").onclick = () => { state.propers = false; massForms(); loadText(); };
}

async function refresh() { await loadDay(); await loadText(); }

controls();
state.theme = storedTheme();
applyTheme(state.theme);
massForms();
loadOptions().then(() => { rites(); refresh(); });
</script>
</body>
</html>
`;

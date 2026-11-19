// The demo runs entirely in memory and sends no analytics.
const report = document.querySelector("#report");
const feedback = document.querySelector("#feedback");
const send = document.querySelector("#send");

function seed() {
  const counts = [8, 12, 9, 16, 13, 18, 21];
  const rows = [];
  counts.forEach((count, day) => {
    for (let n = 0; n < count; n++) {
      const visitor =
        "visitor_" + String(1 + ((day * 9 + n) % 48)).padStart(3, "0");
      rows.push({ event: "page_view", visitor, day, minute: 540 + n * 3 });
      if ((day + n) % 4 === 0)
        rows.push({ event: "sign_up", visitor, day, minute: 541 + n * 3 });
      if (n % 3 === 0)
        rows.push({ event: "button_click", visitor, day, minute: 542 + n * 3 });
    }
  });
  return rows;
}
let rows = seed();
let mode = "overview";
function visitors() {
  const viewed = new Set(),
    converted = new Set();
  for (const row of rows) {
    if (row.event === "page_view") viewed.add(row.visitor);
    if (row.event === "sign_up" && viewed.has(row.visitor))
      converted.add(row.visitor);
  }
  return { viewed, converted };
}
function stat(label, n) {
  return (
    '<div><span class="stat-name">' +
    label +
    '</span><strong class="stat-value">' +
    n +
    "</strong></div>"
  );
}
function render() {
  const { viewed, converted } = visitors();
  const rate = Math.round((100 * converted.size) / viewed.size);
  if (mode === "overview") {
    const days = Array.from({ length: 7 }, (_, day) => {
      const values = rows.filter((r) => r.day === day);
      return [
        values.length,
        values.filter((r) => r.event === "page_view").length,
      ];
    });
    const max = Math.max(...days.map((d) => d[0]));
    const bars = days
      .map(
        ([total, views], i) =>
          '<div class="group" title="Nov ' +
          (i + 1) +
          ": " +
          total +
          " events, " +
          views +
          ' page views"><i class="bar" style="height:' +
          (total / max) * 100 +
          '%"></i><i class="bar views" style="height:' +
          (views / max) * 100 +
          '%"></i></div>'
      )
      .join("");
    report.innerHTML =
      '<div class="stats">' +
      stat("Total events", rows.length) +
      stat("Visitors", viewed.size) +
      stat("Sign-up rate", rate + "%") +
      '</div><div class="chart-label"><b class="card-title">Events by day</b><div class="legend"><span>Events</span><span>Views</span></div></div><div class="plot" role="img" aria-label="Events by day, November 1 through 7: ' +
      days.map((d) => d[0]).join(", ") +
      '">' +
      bars +
      '</div><div class="axis">' +
      days.map((d, i) => "<span>Nov " + (i + 1) + "</span>").join("") +
      "</div>";
  } else if (mode === "events") {
    report.innerHTML =
      '<b class="card-title">Recent events</b>' +
      rows
        .slice(-6)
        .reverse()
        .map(
          (r) =>
            '<div class="event-row"><b>' +
            r.event +
            "</b><span>" +
            r.visitor +
            "</span><span>" +
            String(Math.floor(r.minute / 60)).padStart(2, "0") +
            ":" +
            String(r.minute % 60).padStart(2, "0") +
            "</span></div>"
        )
        .join("");
  } else {
    report.innerHTML =
      '<div class="funnel-head"><strong>' +
      rate +
      "%</strong><span>converted to sign-up</span></div>" +
      [
        ["page_view", viewed.size],
        ["sign_up", converted.size],
      ]
        .map(
          ([name, count]) =>
            '<div class="funnel-row"><div><b>' +
            name +
            "</b><span>" +
            count +
            ' people</span></div><i style="width:' +
            (count / viewed.size) * 100 +
            '%"></i></div>'
        )
        .join("");
  }
  send.lastChild.textContent =
    viewed.size === converted.size ? "Reset demo" : "Record a sign-up";
}
function tabs(selector, key, callback) {
  const list = [...document.querySelectorAll(selector)];
  function activate(button) {
    for (const item of list) {
      const active = item === button;
      item.setAttribute("aria-selected", String(active));
      item.tabIndex = active ? 0 : -1;
    }
    callback(button.dataset[key], button);
  }
  list.forEach((button, index) => {
    button.addEventListener("click", () => activate(button));
    button.addEventListener("keydown", (event) => {
      const to = {
        ArrowRight: (index + 1) % list.length,
        ArrowLeft: (index + list.length - 1) % list.length,
        Home: 0,
        End: list.length - 1,
      }[event.key];
      if (to === undefined) return;
      event.preventDefault();
      list[to].focus();
      activate(list[to]);
    });
  });
}
tabs("[data-report]", "report", (value, button) => {
  mode = value;
  report.setAttribute("aria-labelledby", button.id);
  render();
});
send.addEventListener("click", () => {
  const { viewed, converted } = visitors();
  const visitor = [...viewed].find((id) => !converted.has(id));
  if (visitor) {
    rows.push({
      event: "sign_up",
      visitor,
      day: 6,
      minute: 700 + converted.size,
    });
    feedback.textContent = "Added a sign-up for " + visitor + ".";
  } else {
    rows = seed();
    feedback.textContent = "Demo reset.";
  }
  render();
});
const examples = {
  browser: `import { createBrowserClient } from "@birdwatch/sdk";

type Events = { sign_up: { plan: "free" | "pro" } };
const app = createBrowserClient<Events>({
  host: "http://127.0.0.1:8123",
  writeKey: "YOUR_PROJECT_WRITE_KEY",
});

app.identify("user_42");
await app.capture("sign_up", { plan: "pro" });`,
  node: `import { createServerClient } from "@birdwatch/sdk";

const app = createServerClient({
  host: "http://127.0.0.1:8123",
  writeKey: "YOUR_PROJECT_WRITE_KEY",
});

await app.capture({
  event: "sign_up", distinctId: "user_42",
  properties: { plan: "pro" },
});
await app.shutdown();`,
};
const snippet = document.querySelector("#snippet");
const copy = document.querySelector("#copy");
let lang = "browser",
  copyTimer;
function setCode(name, button) {
  lang = name;
  snippet.setAttribute("aria-labelledby", button.id);
  snippet.replaceChildren();
  copy.querySelector("span").textContent = "Copy";
  clearTimeout(copyTimer);
  const code = document.createElement("code");
  for (const token of examples[lang].split(
    /("[^"]*"|\b(?:import|from|const|type|await)\b|\b(?:identify|capture|createBrowserClient|createServerClient|shutdown)\b)/g
  )) {
    const span = document.createElement("span");
    span.textContent = token;
    span.className = token.startsWith('"')
      ? "tok-string"
      : /^(import|from|const|type|await)$/.test(token)
      ? "tok-key"
      : /^(identify|capture|createBrowserClient|createServerClient|shutdown)$/.test(
          token
        )
      ? "tok-call"
      : "";
    code.append(span);
  }
  snippet.append(code);
}
tabs("[data-lang]", "lang", setCode);
copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(examples[lang]);
    copy.querySelector("span").textContent = "Copied";
  } catch {
    const range = document.createRange();
    range.selectNodeContents(snippet);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    copy.querySelector("span").textContent = "Selected";
  }
  clearTimeout(copyTimer);
  copyTimer = setTimeout(
    () => (copy.querySelector("span").textContent = "Copy"),
    2000
  );
});
render();
setCode("browser", document.querySelector("#code-browser"));

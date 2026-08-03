// Boundary tests for the facilitator dropdowns and the blend card.
// Run: node verify_pickers.js
//
// What matters here: the caps hold, nothing can be picked twice, every one of
// the 34 strengths and 19 gifts is actually reachable in a dropdown, and a
// cell with no written blend still renders something useful rather than a
// dead end.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "facilitator.html"), "utf8");
const LIBDATA = require("../lib/library-strengths-gifts.json");
const script = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"));

let pass = 0, fail = 0;
const results = [];
function check(name, fn) {
  let problem = null;
  try { problem = fn(); } catch (e) { problem = "threw: " + e.message; }
  if (problem) { fail++; results.push("FAIL  " + name + " -- " + problem); }
  else { pass++; results.push("ok    " + name); }
}

function sandbox() {
  const els = {};
  const make = () => ({ onclick: null, onchange: null, focus() {},
                        dataset: {}, value: "", innerHTML: "" });
  const s = {
    document: { getElementById: (id) => (els[id] = els[id] || make()),
                querySelectorAll: () => [] },
    console,
  };
  vm.createContext(s);
  vm.runInContext(script.replace(
    /^(let|const)\s+(LIB|view|email|pwd|loginErr|busy|ME|picked|MAX|DOMAIN_COLORS|DOMAIN_LABELS)\b/gm, "var $2"), s);
  s.LIB = JSON.parse(JSON.stringify({ items: LIBDATA.items, blends: LIBDATA.blends }));
  s._els = els;
  return s;
}

// --- The tension row is gone ---------------------------------------------

check("no tension row renders on the card", () =>
  /The tension/i.test(html) ? "tension row still in the card" : null);

check("page no longer reads LIB.tensions", () =>
  /LIB\.tensions/.test(script) ? "still references the retired key" : null);

// --- Dropdowns, not text inputs ------------------------------------------

check("pickers are select elements", () => {
  const p = script.slice(script.indexOf("function picker"), script.indexOf("function cell"));
  if (!/<select id="q-\$\{kind\}"/.test(p)) return "picker is not a select";
  if (/<input id="q-/.test(p)) return "a text input survived";
  return null;
});

check("every strength is reachable in the dropdown", () => {
  const s = sandbox();
  const html2 = s.options("strengths");
  const missing = Object.keys(LIBDATA.items.strengths).filter(n => !html2.includes(">" + n + "<"));
  return missing.length ? "missing: " + missing.join(", ") : null;
});

check("every gift is reachable in the dropdown", () => {
  const s = sandbox();
  const html2 = s.options("gifts");
  const missing = Object.keys(LIBDATA.items.gifts).filter(n => !html2.includes(">" + n + "<"));
  return missing.length ? "missing: " + missing.join(", ") : null;
});

check("strengths are grouped under all four domains", () => {
  const s = sandbox();
  const out = s.options("strengths");
  const want = ["Strategic Thinking", "Influencing", "Relationship Building", "Executing"];
  const missing = want.filter(d => !out.includes('label="' + d + '"'));
  return missing.length ? "no optgroup for: " + missing.join(", ") : null;
});

check("gifts are a flat list, not grouped", () => {
  const s = sandbox();
  return s.options("gifts").includes("optgroup") ? "gifts were grouped" : null;
});

check("an already-picked item drops out of the list", () => {
  const s = sandbox();
  s.picked.strengths.push("Analytical");
  const out = s.options("strengths");
  return out.includes(">Analytical<") ? "duplicate selectable" : null;
});

// --- Caps hold ------------------------------------------------------------

check("strengths cap at 5, gifts at 3", () => {
  const s = sandbox();
  const names = Object.keys(LIBDATA.items.strengths).slice(0, 8);
  for (const n of names) {
    if (s.picked.strengths.length < s.MAX.strengths) s.picked.strengths.push(n);
  }
  if (s.picked.strengths.length !== 5) return "strengths reached " + s.picked.strengths.length;
  if (s.MAX.gifts !== 3) return "gift cap is " + s.MAX.gifts;
  return null;
});

check("select is disabled at the cap", () => {
  const s = sandbox();
  s.picked.gifts = ["Wisdom", "Mercy", "Teaching"];
  return /disabled/.test(s.picker("gifts", "Gifts")) ? null : "not disabled at cap";
});

check("the cap is enforced in the handler, not only the markup", () => {
  const w = script.slice(script.indexOf("q.onchange"), script.indexOf("q.onchange") + 500);
  return /picked\[kind\]\.length < MAX\[kind\]/.test(w)
    ? null : "handler trusts the disabled attribute alone";
});

// --- The card -------------------------------------------------------------

// This test used to hardcode Analytical x Wisdom as its example of an
// unwritten cell. That cell has since been written, so the empty-state branch
// never rendered and the test reported a failure that did not exist. Find a
// genuinely unwritten pair at runtime instead -- then it cannot rot again as
// the library fills in.
function firstUnwrittenPair(LIB) {
  for (const s of Object.keys(LIB.items.strengths))
    for (const g of Object.keys(LIB.items.gifts))
      if (!LIB.blends[s + "|" + g]) return [s, g];
  return null;
}

check("a cell with no written blend still gives the facilitator something", () => {
  const s = sandbox();
  const pair = firstUnwrittenPair(s.LIB);
  // Once all 646 are written there is no empty state left to test, and that is
  // a good problem. Say so rather than failing.
  if (!pair) return null;
  const [st, gf] = pair;
  const out = s.cell(st, gf);
  const seeds = s.LIB.items.strengths[st].essence + " + " + s.LIB.items.gifts[gf].essence;
  if (/Not yet written/i.test(out)) return "still shows the old dead-end text";
  if (!/seed words/i.test(out)) return `empty state gives no instruction (${st} x ${gf})`;
  if (!out.includes(seeds)) return `seed words missing from empty card (expected "${seeds}")`;
  return null;
});

check("a written blend renders both lines", () => {
  const s = sandbox();
  s.LIB.blends["Analytical|Wisdom"] = { recognize: "RECOG-LINE", ask: "ASK-LINE" };
  const out = s.cell("Analytical", "Wisdom");
  if (!out.includes("RECOG-LINE")) return "recognition line missing";
  if (!out.includes("ASK-LINE")) return "facilitator prompt missing";
  if (!/Looks like/.test(out) || !/Ask them/.test(out)) return "row labels missing";
  return null;
});

check("blend text is escaped, not injected", () => {
  const s = sandbox();
  s.LIB.blends["Analytical|Wisdom"] = { recognize: '<img src=x onerror=alert(1)>', ask: "ok" };
  const out = s.cell("Analytical", "Wisdom");
  return out.includes("<img") ? "unescaped HTML reached the card" : null;
});

check("seeds and shadows still render on every card", () => {
  const s = sandbox();
  const out = s.cell("Command", "Giving");
  return out.includes("authority + release") && out.includes("steamrolls + buys")
    ? null : "seed or shadow row lost in the rewrite";
});

// --- Data integrity -------------------------------------------------------

check("library still holds 34 strengths and 19 gifts", () => {
  const sN = Object.keys(LIBDATA.items.strengths).length;
  const gN = Object.keys(LIBDATA.items.gifts).length;
  return (sN === 34 && gN === 19) ? null : "counts are " + sN + " x " + gN;
});

check("the 19 original tensions were retired, not deleted", () =>
  LIBDATA.retired_tensions && Object.keys(LIBDATA.retired_tensions).length === 19
    ? null : "retired tensions missing");

check("every blend key names a real strength and gift", () => {
  const bad = Object.keys(LIBDATA.blends).filter(k => {
    const [s, g] = k.split("|");
    return !LIBDATA.items.strengths[s] || !LIBDATA.items.gifts[g];
  });
  return bad.length ? "unknown pairing: " + bad.slice(0, 3).join(", ") : null;
});

check("every written blend has both a recognize and an ask line", () => {
  const bad = Object.entries(LIBDATA.blends).filter(([, v]) =>
    !v || typeof v.recognize !== "string" || !v.recognize.trim()
       || typeof v.ask !== "string" || !v.ask.trim());
  return bad.length ? bad.length + " incomplete: " + bad.slice(0, 3).map(b => b[0]).join(", ") : null;
});

console.log(results.join("\n"));
const total = Object.keys(LIBDATA.items.strengths).length * Object.keys(LIBDATA.items.gifts).length;
console.log("\nblends written: " + Object.keys(LIBDATA.blends).length + " / " + total);
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);

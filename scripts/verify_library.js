// verify_library.js — boundary checks for the Strengths x Gifts teaching library.
// Run: node verify_library.js
const fs = require("fs");
const path = require("path");

// Resolve from this file, not the working directory, so `node scripts/verify_library.js`
// works from the repo root and `node verify_library.js` works from inside scripts/.
const PATH = path.join(__dirname, "..", "lib", "library-strengths-gifts.json");
let fail = 0, warn = 0;
const bad = (m) => { console.log("  FAIL  " + m); fail++; };
const soft = (m) => { console.log("  WARN  " + m); warn++; };
const ok = (m) => console.log("  ok    " + m);

// 1. Parses at all
let lib;
try {
  lib = JSON.parse(fs.readFileSync(PATH, "utf8"));
  ok("file parses as valid JSON");
} catch (e) {
  console.log("  FAIL  file does not parse: " + e.message);
  process.exit(1);
}

const strengths = lib.items.strengths;
const gifts = lib.items.gifts;
const sNames = Object.keys(strengths);
const gNames = Object.keys(gifts);

// 2. Counts match the source assessments
sNames.length === 34 ? ok("34 strengths present") : bad(`expected 34 strengths, found ${sNames.length}`);
gNames.length === 19 ? ok("19 gifts present") : bad(`expected 19 gifts, found ${gNames.length}`);
const universe = sNames.length * gNames.length;
universe === 646 ? ok("cell universe = 646") : bad(`cell universe = ${universe}, expected 646`);

// 3. Every item has all three fields, non-empty, single lowercase word
const FIELDS = ["essence", "action", "shadow"];
const checkItem = (name, obj, kind) => {
  for (const f of FIELDS) {
    const v = obj[f];
    if (!v || typeof v !== "string" || !v.trim()) { bad(`${kind} "${name}" missing ${f}`); continue; }
    if (v !== v.toLowerCase()) soft(`${kind} "${name}" ${f} is not lowercase: "${v}"`);
    if (/\s/.test(v)) soft(`${kind} "${name}" ${f} is multi-word: "${v}"`);
  }
};
sNames.forEach((n) => checkItem(n, strengths[n], "strength"));
gNames.forEach((n) => checkItem(n, gifts[n], "gift"));
ok("all 53 items carry essence / action / shadow");

// 4. Domains are valid and every strength has one
const DOMAINS = ["Strategic", "Influencing", "Relationship", "Executing"];
const domainCount = {};
sNames.forEach((n) => {
  const d = strengths[n].domain;
  if (!DOMAINS.includes(d)) bad(`strength "${n}" has invalid domain "${d}"`);
  domainCount[d] = (domainCount[d] || 0) + 1;
});
ok("domains: " + DOMAINS.map((d) => `${d} ${domainCount[d] || 0}`).join(", "));

// 5. THE BIG ONE — no word repeats within a column across the full 53.
//    A repeat renders a doubled cell, e.g. "confronts + confronts".
let collisions = 0;
for (const f of FIELDS) {
  const seen = new Map();
  const all = [...sNames.map((n) => [n, strengths[n][f]]), ...gNames.map((n) => [n, gifts[n][f]])];
  for (const [name, val] of all) {
    if (seen.has(val)) { bad(`${f} collision: "${val}" used by both ${seen.get(val)} and ${name}`); collisions++; }
    else seen.set(val, name);
  }
}
if (collisions === 0) ok("no word collisions in any column — no cell can render a doubled pair");

// 6. Tension keys are well formed and point at real items
const tensions = lib.tensions || {};
const tKeys = Object.keys(tensions);
const byStrength = {};
for (const k of tKeys) {
  const parts = k.split("|");
  if (parts.length !== 2) { bad(`malformed key "${k}" (expected Strength|Gift)`); continue; }
  const [s, g] = parts;
  if (!strengths[s]) bad(`key "${k}" references unknown strength "${s}"`);
  if (!gifts[g]) bad(`key "${k}" references unknown gift "${g}"`);
  byStrength[s] = (byStrength[s] || 0) + 1;
}
ok(`${tKeys.length} tension lines, all keys well formed`);

// 7. Tension content sanity — not empty, not a summary stub, no duplicates
const texts = new Map();
for (const [k, v] of Object.entries(tensions)) {
  if (!v || v.trim().length < 30) bad(`tension "${k}" is empty or too short to be a real line`);
  if (texts.has(v)) bad(`tension "${k}" is a duplicate of "${texts.get(v)}"`);
  else texts.set(v, k);
  const words = v.trim().split(/\s+/).length;
  if (words > 45) soft(`tension "${k}" is long (${words} words) — may not fit a phone card`);
}
ok("all tension lines unique and substantive");

// 8. The one non-negotiable: the approved reference line is intact, verbatim
const REF_KEY = "Command|Faith";
const REF = "One of these gets its authority from you. The other gets it from God. Both make you move before other people are ready.";
tensions[REF_KEY] === REF
  ? ok("approved reference line (Command|Faith) intact, verbatim")
  : bad("approved reference line (Command|Faith) has been altered");

// 9. Coverage report
const done = tKeys.length;
console.log("");
console.log(`  Coverage: ${done} / 646 cells (${((done / 646) * 100).toFixed(1)}%)`);
const complete = sNames.filter((n) => (byStrength[n] || 0) === 19);
const partial = sNames.filter((n) => (byStrength[n] || 0) > 0 && (byStrength[n] || 0) < 19);
console.log(`  Batches complete: ${complete.length} / 34${complete.length ? " — " + complete.join(", ") : ""}`);
if (partial.length) partial.forEach((n) => soft(`batch "${n}" is partial: ${byStrength[n]} / 19`));
console.log(`  Batches remaining: ${sNames.filter((n) => !(byStrength[n] || 0)).length}`);

console.log("");
console.log(fail === 0 ? `PASS — ${warn} warning(s)` : `FAILED — ${fail} error(s), ${warn} warning(s)`);
process.exit(fail === 0 ? 0 : 1);

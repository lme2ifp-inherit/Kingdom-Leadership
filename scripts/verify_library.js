// verify_library.js -- boundary checks for the Strengths x Gifts teaching library.
// Run from the repo root:  node scripts/verify_library.js
//
// This file was rewritten on August 2, 2026. The old version still checked
// `lib.tensions`, a key that was retired when the card format changed from a
// single tension line to the recognize / ask pair. It therefore failed on a
// perfectly healthy file, which meant nobody trusted it, which meant the
// library went unverified for several sessions. Do not let that happen again:
// if the file format changes, this file changes in the same commit.
//
// THE FLOOR is the point of this script. Content only ever goes up. If a
// delivered file has fewer cells than the last known good count, something was
// dropped -- almost certainly by a replacement file built from a stale copy --
// and that must fail loudly rather than deploy quietly. The app degrades
// gracefully on a missing blend, so lost content looks like unfinished content.
// This is the only place it can be caught.
//
// When a batch is approved and written, raise FLOOR to the new count in the
// same edit. Never lower it.

const fs = require("fs");
const path = require("path");

const FLOOR = 323;

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
  console.log("\nFAILED -- 1 error");
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

// 5. No word repeats within a column across the full 53.
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
if (collisions === 0) ok("no word collisions in any column -- no cell can render a doubled pair");

// 6. Blend keys are well formed and point at real items
const blends = lib.blends || {};
const bKeys = Object.keys(blends);
const byStrength = {};
for (const k of bKeys) {
  const parts = k.split("|");
  if (parts.length !== 2) { bad(`malformed key "${k}" (expected Strength|Gift)`); continue; }
  const [s, g] = parts;
  if (!strengths[s]) bad(`key "${k}" references unknown strength "${s}"`);
  if (!gifts[g]) bad(`key "${k}" references unknown gift "${g}"`);
  byStrength[s] = (byStrength[s] || 0) + 1;
}
ok(`${bKeys.length} blends, all keys well formed`);

// 7. Blend content sanity -- both fields present, substantive, unique, card-sized
const seenText = new Map();
for (const [k, v] of Object.entries(blends)) {
  if (!v || typeof v !== "object") { bad(`blend "${k}" is not an object`); continue; }
  for (const f of ["recognize", "ask"]) {
    const t = v[f];
    if (typeof t !== "string" || !t.trim()) { bad(`blend "${k}" missing ${f}`); continue; }
    // recognize carries the description and needs room. An ask does not:
    // "When is it done?" is one of the strongest lines in the library. Only
    // flag an ask short enough to be a stub or a placeholder.
    const floorFor = f === "recognize" ? 20 : 10;
    if (t.trim().length < floorFor) bad(`blend "${k}" ${f} is too short to be a real line`);
    const dupKey = f + "::" + t;
    if (seenText.has(dupKey)) bad(`blend "${k}" ${f} duplicates ${seenText.get(dupKey)}`);
    else seenText.set(dupKey, k);
  }
  if (typeof v.ask === "string" && v.ask.trim() && !v.ask.trim().endsWith("?")) {
    bad(`blend "${k}" ask is not a question`);
  }
  if (typeof v.recognize === "string") {
    const words = v.recognize.trim().split(/\s+/).length;
    if (words > 55) soft(`blend "${k}" recognize is long (${words} words) -- may not fit a phone card`);
  }
  const extra = Object.keys(v).filter((f) => f !== "recognize" && f !== "ask");
  if (extra.length) soft(`blend "${k}" carries unexpected field(s): ${extra.join(", ")}`);
}
ok("all recognize / ask lines present, unique and substantive");

// 8. No partial rows. A row is 19 gifts or it is not written.
const partial = sNames.filter((n) => (byStrength[n] || 0) > 0 && (byStrength[n] || 0) < 19);
partial.length
  ? partial.forEach((n) => bad(`row "${n}" is partial: ${byStrength[n]} / 19 -- a batch was cut off`))
  : ok("no partial rows -- every started row is complete");

// 9. THE FLOOR. Content never goes backwards.
bKeys.length >= FLOOR
  ? ok(`floor holds: ${bKeys.length} >= ${FLOOR}`)
  : bad(`CONTENT LOST: ${bKeys.length} blends, floor is ${FLOOR}. ` +
        `${FLOOR - bKeys.length} cell(s) missing. Do not deploy this file. ` +
        `Almost certainly a replacement built from a stale copy.`);

// 10. The file's own coverage block must agree with the file
const cov = lib.coverage;
if (!cov) {
  soft("no coverage block -- handoffs will have to claim a count instead of reading one");
} else {
  cov.written === bKeys.length
    ? ok(`coverage block agrees with the file (${cov.written})`)
    : bad(`coverage block says ${cov.written} but the file holds ${bKeys.length}`);
  cov.of === 646 || bad(`coverage.of is ${cov.of}, expected 646`);
  const actualComplete = sNames.filter((n) => (byStrength[n] || 0) === 19);
  const claimed = (cov.rowsComplete || []).slice().sort().join(",");
  actualComplete.slice().sort().join(",") === claimed
    ? ok("coverage block lists the right completed rows")
    : bad("coverage.rowsComplete does not match the rows actually written");
}

// 11. The retired tension lines were retired, not deleted.
//     The approved reference line lives here now and is the voice standard.
const retired = lib.retired_tensions || {};
Object.keys(retired).length === 19
  ? ok("19 original tension lines retained under retired_tensions")
  : bad(`retired_tensions holds ${Object.keys(retired).length}, expected 19`);

const REF_KEY = "Command|Faith";
const REF = "One of these gets its authority from you. The other gets it from God. Both make you move before other people are ready.";
retired[REF_KEY] === REF
  ? ok("approved reference line (Command|Faith) intact, verbatim")
  : bad("approved reference line (Command|Faith) has been altered or lost");

// 12. Coverage report
console.log("");
console.log(`  Coverage: ${bKeys.length} / 646 cells (${((bKeys.length / 646) * 100).toFixed(1)}%)`);
const complete = sNames.filter((n) => (byStrength[n] || 0) === 19);
console.log(`  Rows complete: ${complete.length} / 34${complete.length ? " -- " + complete.join(", ") : ""}`);
console.log(`  Rows remaining: ${sNames.filter((n) => !(byStrength[n] || 0)).length}`);

console.log("");
console.log(fail === 0 ? `PASS -- ${warn} warning(s)` : `FAILED -- ${fail} error(s), ${warn} warning(s)`);
process.exit(fail === 0 ? 0 : 1);

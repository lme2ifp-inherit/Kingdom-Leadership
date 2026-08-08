// verify_strengths_personality_library.js -- boundary checks for the
// Strengths x Personality teaching library. Run from the repo root:
//   node scripts/verify_strengths_personality_library.js
//
// Third sibling of scripts/verify_library.js and
// scripts/verify_personality_library.js, and deliberately mirrors both. Three
// libraries, three scripts, three floors. No script ever checks another
// library's file, because a single script over all three would happily pass a
// file that had silently swapped its contents for one of the others.
//
// THE FLOOR is the point of this script. Content only ever goes up. If a
// delivered file has fewer cells than the last known good count, something was
// dropped -- almost certainly a replacement built from a stale copy -- and that
// must fail loudly rather than deploy quietly. The app degrades gracefully on
// a missing blend, so lost content looks exactly like unfinished content. This
// is the only place it can be caught.
//
// This library is COMPLETE at 2448. The floor and the universe are therefore
// the same number, and they should stay that way forever. If a future edit
// makes FLOOR less than UNIVERSE, that is not a new phase of authoring -- it is
// someone lowering the bar to make a broken file pass.

const fs = require("fs");
const path = require("path");

const FLOOR = 2448;

const STRENGTHS = 34; // CliftonStrengths themes
const DESCRIPTORS = 72; // unique 16Personalities strength descriptors, deduplicated
const UNIVERSE = STRENGTHS * DESCRIPTORS; // 2448

// __dirname, not process.cwd(). This script lives in scripts/ and must resolve
// the same path no matter which directory it is invoked from.
const PATH = path.join(__dirname, "..", "lib", "library-strengths-personality.json");
const SIBLING = path.join(__dirname, "..", "lib", "library-personality-gifts.json");

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

const strengths = (lib.items && lib.items.strengths) || {};
const descriptors = (lib.items && lib.items.descriptors) || {};
const sNames = Object.keys(strengths);
const dNames = Object.keys(descriptors);
const blends = lib.blends || {};
const bKeys = Object.keys(blends);

// 2. Counts match the source lists
sNames.length === STRENGTHS
  ? ok(`${STRENGTHS} strengths present`)
  : bad(`expected ${STRENGTHS} strengths, found ${sNames.length}`);
dNames.length === DESCRIPTORS
  ? ok(`${DESCRIPTORS} descriptors present`)
  : bad(`expected ${DESCRIPTORS} descriptors, found ${dNames.length}`);
const universe = sNames.length * dNames.length;
universe === UNIVERSE
  ? ok(`cell universe = ${UNIVERSE}`)
  : bad(`cell universe = ${universe}, expected ${UNIVERSE}`);

// 3. Every item has its fields, non-empty, single lowercase word.
//    Strengths additionally carry a domain; descriptors deliberately do not.
const FIELDS = ["essence", "action", "shadow"];
const DOMAINS = ["Strategic", "Influencing", "Relationship", "Executing"];
const checkItem = (name, obj, kind, needDomain) => {
  for (const f of FIELDS) {
    const v = obj[f];
    if (typeof v !== "string" || !v.trim()) {
      bad(`${kind} "${name}" has no ${f}`);
    } else if (!/^[a-z][a-z-]*$/.test(v)) {
      bad(`${kind} "${name}" ${f} "${v}" is not a single lowercase word`);
    }
  }
  if (needDomain && !DOMAINS.includes(obj.domain)) {
    bad(`strength "${name}" has an unknown domain: ${JSON.stringify(obj.domain)}`);
  }
};
for (const n of sNames) checkItem(n, strengths[n], "strength", true);
for (const n of dNames) checkItem(n, descriptors[n], "descriptor", false);
if (!fail) ok("every item word is a single lowercase word");

// 4. Descriptors must be IDENTICAL to library two's.
//    Both libraries use the same deduplicated 72. If they ever drift, one of
//    the two files was rebuilt from a stale descriptor list, and the facilitator
//    page -- which falls through between the two for its item words -- would
//    show words from one library against blends from the other.
try {
  const sib = JSON.parse(fs.readFileSync(SIBLING, "utf8"));
  const sibD = (sib.items && sib.items.descriptors) || {};
  const a = JSON.stringify(Object.keys(sibD).sort());
  const b = JSON.stringify(dNames.slice().sort());
  if (a !== b) {
    bad("descriptor NAMES differ from library-personality-gifts.json");
  } else {
    let drift = 0;
    for (const n of dNames) {
      for (const f of FIELDS) {
        if (sibD[n][f] !== descriptors[n][f]) {
          bad(`descriptor "${n}" ${f} differs from library two: `
            + `"${descriptors[n][f]}" vs "${sibD[n][f]}"`);
          drift++;
        }
      }
    }
    if (!drift) ok("descriptors match library-personality-gifts.json exactly");
  }
} catch (e) {
  soft("could not read library-personality-gifts.json to cross-check descriptors");
}

// 5. THE FLOOR
bKeys.length >= FLOOR
  ? ok(`${bKeys.length} blends written (floor ${FLOOR})`)
  : bad(`${bKeys.length} blends written, FLOOR is ${FLOOR} -- content was LOST`);
if (FLOOR < UNIVERSE) {
  bad(`FLOOR (${FLOOR}) is below the universe (${UNIVERSE}); this library is complete `
    + "and the floor must never be lowered");
}
bKeys.length <= UNIVERSE
  ? ok("no more blends than the universe allows")
  : bad(`${bKeys.length} blends exceeds the ${UNIVERSE}-cell universe`);

// 6. The coverage block is the file's own self-report. It is the number the
//    handoff prose is checked AGAINST, having been wrong in prose twice.
const cov = lib.coverage || {};
cov.written === bKeys.length
  ? ok(`coverage.written (${cov.written}) matches the actual blend count`)
  : bad(`coverage.written says ${cov.written} but there are ${bKeys.length} blends`);
cov.of === UNIVERSE
  ? ok(`coverage.of = ${UNIVERSE}`)
  : bad(`coverage.of says ${cov.of}, expected ${UNIVERSE}`);
lib.totalCells === UNIVERSE
  ? ok(`totalCells = ${UNIVERSE}`)
  : bad(`totalCells says ${lib.totalCells}, expected ${UNIVERSE}`);
Array.isArray(cov.rowsRemaining) && cov.rowsRemaining.length === 0
  ? ok("coverage.rowsRemaining is empty -- library is complete")
  : bad("coverage.rowsRemaining is not empty, but every row should be written");
Array.isArray(cov.rowsComplete) && cov.rowsComplete.length === STRENGTHS
  ? ok(`coverage.rowsComplete lists all ${STRENGTHS} rows`)
  : bad(`coverage.rowsComplete lists ${(cov.rowsComplete || []).length} rows, expected ${STRENGTHS}`);

// 7. Every key is a real strength|descriptor pair, and none is duplicated or
//    transposed. A transposed key ("Altruistic|Woo") is the failure this
//    catches: it parses, it looks plausible, and it never renders.
const sSet = new Set(sNames), dSet = new Set(dNames);
let keyBad = 0;
for (const k of bKeys) {
  const i = k.indexOf("|");
  if (i < 0) { bad(`blend key "${k}" has no separator`); keyBad++; continue; }
  const r = k.slice(0, i), c = k.slice(i + 1);
  if (!sSet.has(r)) { bad(`blend key "${k}" -- "${r}" is not a strength`); keyBad++; }
  else if (!dSet.has(c)) { bad(`blend key "${k}" -- "${c}" is not a descriptor`); keyBad++; }
}
if (!keyBad) ok("every blend key is a valid strength|descriptor pair");

// 8. Full grid: every pair present exactly once.
let missing = 0;
for (const s of sNames) {
  for (const d of dNames) {
    if (!blends[s + "|" + d]) {
      if (missing < 5) bad(`missing cell: ${s} x ${d}`);
      missing++;
    }
  }
}
missing === 0
  ? ok("all 2448 cells present -- the grid is complete")
  : bad(`${missing} cells missing from the grid`);

// 9. Blend bodies. The recognize line is capped at 55 words and must address
//    the facilitator's participant in the second person; the ask must be one
//    question. These are the same constraints the authoring sweep enforces,
//    re-asserted here so a hand edit cannot quietly break them.
let bodyBad = 0, longest = 0;
for (const k of bKeys) {
  const b = blends[k];
  if (!b || typeof b.recognize !== "string" || typeof b.ask !== "string") {
    if (bodyBad < 5) bad(`blend "${k}" is missing recognize or ask`);
    bodyBad++; continue;
  }
  const words = b.recognize.trim().split(/\s+/).length;
  if (words > longest) longest = words;
  if (words > 55) { if (bodyBad < 5) bad(`blend "${k}" recognize is ${words} words (max 55)`); bodyBad++; }
  if (!/^(You|Your)\b/.test(b.recognize)) {
    if (bodyBad < 5) bad(`blend "${k}" recognize does not open in the second person`);
    bodyBad++;
  }
  const qs = (b.ask.match(/\?/g) || []).length;
  if (qs !== 1 || !b.ask.trim().endsWith("?")) {
    if (bodyBad < 5) bad(`blend "${k}" ask is not a single question`);
    bodyBad++;
  }
}
bodyBad === 0
  ? ok(`every blend body is well formed (longest recognize ${longest} words)`)
  : bad(`${bodyBad} blend bodies are malformed`);

// 10. Pure ASCII. Smart quotes and dashes have corrupted a migration in this
//     project before, and they fail silently rather than loudly.
const raw = fs.readFileSync(PATH, "utf8");
const nonAscii = raw.match(/[^\x00-\x7F]/g);
nonAscii
  ? bad(`file contains ${nonAscii.length} non-ASCII characters, first is ${JSON.stringify(nonAscii[0])}`)
  : ok("file is pure ASCII");

// 11. The library must never be importable by the page. This does not prove
//     it, but it does assert the one fact the page relies on: the file is a
//     bare JSON object, not a JS module that could be script-tagged.
/^\s*\{/.test(raw)
  ? ok("file is bare JSON, not an executable module")
  : bad("file does not begin with an object literal");

console.log("");
if (fail) {
  console.log(`FAILED -- ${fail} error${fail === 1 ? "" : "s"}`
    + (warn ? `, ${warn} warning${warn === 1 ? "" : "s"}` : ""));
  process.exit(1);
}
console.log(`PASSED -- ${bKeys.length} cells`
  + (warn ? `, ${warn} warning${warn === 1 ? "" : "s"}` : ""));

// verify_personality_library.js -- boundary checks for the Personality x Gifts
// teaching library. Run from the repo root:  node scripts/verify_personality_library.js
//
// This is the sibling of scripts/verify_library.js and deliberately mirrors it.
// Two libraries, two scripts, two floors. Neither file is ever checked by the
// other's script, because a single script over both would pass a file that had
// silently swapped its contents for the other one's.
//
// THE FLOOR is the point of this script. Content only ever goes up. If a
// delivered file has fewer cells than the last known good count, something was
// dropped -- almost certainly a replacement built from a stale copy -- and that
// must fail loudly rather than deploy quietly. The app degrades gracefully on a
// missing blend, so lost content looks exactly like unfinished content. This is
// the only place it can be caught.
//
// When a batch is approved and written, raise FLOOR to the new count in the
// same edit. Never lower it.

const fs = require("fs");
const path = require("path");

const FLOOR = 1368;

const DESCRIPTORS = 72; // unique 16Personalities strength descriptors, deduplicated
const GIFTS = 19;
const UNIVERSE = DESCRIPTORS * GIFTS; // 1368

const PATH = path.join(__dirname, "..", "lib", "library-personality-gifts.json");
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

const descriptors = (lib.items && lib.items.descriptors) || {};
const gifts = (lib.items && lib.items.gifts) || {};
const dNames = Object.keys(descriptors);
const gNames = Object.keys(gifts);

// 2. Counts match the source lists
dNames.length === DESCRIPTORS ? ok(`${DESCRIPTORS} descriptors present`) : bad(`expected ${DESCRIPTORS} descriptors, found ${dNames.length}`);
gNames.length === GIFTS ? ok(`${GIFTS} gifts present`) : bad(`expected ${GIFTS} gifts, found ${gNames.length}`);
const universe = dNames.length * gNames.length;
universe === UNIVERSE ? ok(`cell universe = ${UNIVERSE}`) : bad(`cell universe = ${universe}, expected ${UNIVERSE}`);

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
dNames.forEach((n) => checkItem(n, descriptors[n], "descriptor"));
gNames.forEach((n) => checkItem(n, gifts[n], "gift"));
ok(`all ${dNames.length + gNames.length} items carry essence / action / shadow`);

// 4. No word repeats within a column across the full item set.
//    A repeat renders a doubled cell, e.g. "attracts + attracts".
let collisions = 0;
for (const f of FIELDS) {
  const seen = new Map();
  const all = [...dNames.map((n) => [n, descriptors[n][f]]), ...gNames.map((n) => [n, gifts[n][f]])];
  for (const [name, val] of all) {
    if (seen.has(val)) { bad(`${f} collision: "${val}" used by both ${seen.get(val)} and ${name}`); collisions++; }
    else seen.set(val, name);
  }
}
if (collisions === 0) ok("no word collisions in any column -- no cell can render a doubled pair");

// 5. The gifts block must be identical to the one in the Strengths x Gifts
//    library. Both cards can sit in front of the same facilitator in the same
//    minute; a gift whose words drifted between files would render two
//    different Faiths.
const SIBLING = path.join(__dirname, "..", "lib", "library-strengths-gifts.json");
try {
  const sib = JSON.parse(fs.readFileSync(SIBLING, "utf8"));
  const a = JSON.stringify(sib.items.gifts, Object.keys(sib.items.gifts).sort());
  const b = JSON.stringify(gifts, Object.keys(gifts).sort());
  a === b ? ok("gift words match the Strengths x Gifts library exactly")
          : bad("gift words have drifted from the Strengths x Gifts library -- the same gift would render differently on two cards");
} catch (e) {
  soft("could not read the sibling library to compare gift words: " + e.message);
}

// 6. Blend keys are well formed and point at real items
const blends = lib.blends || {};
const bKeys = Object.keys(blends);
const byDescriptor = {};
for (const k of bKeys) {
  const parts = k.split("|");
  if (parts.length !== 2) { bad(`malformed key "${k}" (expected Descriptor|Gift)`); continue; }
  const [d, g] = parts;
  if (!descriptors[d]) bad(`key "${k}" references unknown descriptor "${d}"`);
  if (!gifts[g]) bad(`key "${k}" references unknown gift "${g}"`);
  byDescriptor[d] = (byDescriptor[d] || 0) + 1;
}
ok(`${bKeys.length} blends, all keys well formed`);

// 7. Blend content sanity -- both fields present, substantive, unique, card-sized
const seenText = new Map();
for (const [k, v] of Object.entries(blends)) {
  if (!v || typeof v !== "object") { bad(`blend "${k}" is not an object`); continue; }
  for (const f of ["recognize", "ask"]) {
    const t = v[f];
    if (typeof t !== "string" || !t.trim()) { bad(`blend "${k}" missing ${f}`); continue; }
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

// 8. Pure ASCII. Curly quotes and em-dashes break the build check.
for (const [k, v] of Object.entries(blends)) {
  const t = (v.recognize || "") + " " + (v.ask || "");
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(t)) bad(`blend "${k}" contains a non-ASCII character`);
}
ok("all blend text is pure ASCII");

// 9. No cell reuses a word already composed onto the card above it.
//    "Watch for: dazzles + presumes" printed above a recognize line that also
//    says "dazzles" wastes the line. Stem-level so plurals and -ing forms count.
const stem = (w) => {
  w = w.toLowerCase();
  for (const s of ["ings", "ing", "ies", "es", "ed", "ly", "s"]) {
    if (w.endsWith(s) && w.length - s.length >= 4) return w.slice(0, -s.length);
  }
  return w;
};
let reuse = 0;
for (const [k, v] of Object.entries(blends)) {
  const [d, g] = k.split("|");
  if (!descriptors[d] || !gifts[g]) continue;
  const banned = new Set([...FIELDS.map((f) => stem(descriptors[d][f])), ...FIELDS.map((f) => stem(gifts[g][f]))]);
  const words = ((v.recognize || "") + " " + (v.ask || "")).match(/[A-Za-z']+/g) || [];
  for (const w of words) {
    if (banned.has(stem(w))) { bad(`blend "${k}" reuses a composed word: "${w}"`); reuse++; }
  }
}
if (reuse === 0) ok("no cell reuses a word already printed on its own card");

// 10. No partial rows. A row is 19 gifts or it is not written.
const partial = dNames.filter((n) => (byDescriptor[n] || 0) > 0 && (byDescriptor[n] || 0) < GIFTS);
partial.length
  ? partial.forEach((n) => bad(`row "${n}" is partial: ${byDescriptor[n]} / ${GIFTS} -- a batch was cut off`))
  : ok("no partial rows -- every started row is complete");

// 11. THE FLOOR. Content never goes backwards.
bKeys.length >= FLOOR
  ? ok(`floor holds: ${bKeys.length} >= ${FLOOR}`)
  : bad(`CONTENT LOST: ${bKeys.length} blends, floor is ${FLOOR}. ` +
        `${FLOOR - bKeys.length} cell(s) missing. Do not deploy this file. ` +
        `Almost certainly a replacement built from a stale copy.`);

// 12. The file's own coverage block must agree with the file
const cov = lib.coverage;
if (!cov) {
  soft("no coverage block -- handoffs will have to claim a count instead of reading one");
} else {
  cov.written === bKeys.length
    ? ok(`coverage block agrees with the file (${cov.written})`)
    : bad(`coverage block says ${cov.written} but the file holds ${bKeys.length}`);
  cov.of === UNIVERSE || bad(`coverage.of is ${cov.of}, expected ${UNIVERSE}`);
  const actualComplete = dNames.filter((n) => (byDescriptor[n] || 0) === GIFTS);
  const claimed = (cov.rowsComplete || []).slice().sort().join(",");
  actualComplete.slice().sort().join(",") === claimed
    ? ok("coverage block lists the right completed rows")
    : bad("coverage.rowsComplete does not match the rows actually written");
}

// 13. Coverage report
console.log("");
console.log(`  Coverage: ${bKeys.length} / ${UNIVERSE} cells (${((bKeys.length / UNIVERSE) * 100).toFixed(1)}%)`);
const complete = dNames.filter((n) => (byDescriptor[n] || 0) === GIFTS);
console.log(`  Rows complete: ${complete.length} / ${DESCRIPTORS}${complete.length ? " -- " + complete.join(", ") : ""}`);
console.log(`  Rows remaining: ${dNames.filter((n) => !(byDescriptor[n] || 0)).length}`);

console.log("");
console.log(fail === 0 ? `PASS -- ${warn} warning(s)` : `FAILED -- ${fail} error(s), ${warn} warning(s)`);
process.exit(fail === 0 ? 0 : 1);

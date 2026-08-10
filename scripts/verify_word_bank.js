// ===========================================================================
// WORD BANK VERIFIER -- scripts/verify_word_bank.js
// August 9, 2026.
//
// The word bank replaced the two-word "Blend seeds" row with six words, three
// from each side of a pairing. This script asserts the facts the two pages
// rely on when they print those words.
//
// WHY EACH CHECK EXISTS -- every one of these caught a real defect during
// authoring, except where noted:
//
// 1. Shape. Three words per item, lowercase ASCII, first word is the item's
//    own essence. Matches the existing item-word rule the other verifiers
//    already enforce on essence/action/shadow.
//
// 2. Uniqueness. No ADDED word appears twice across all items in all three
//    libraries. Two items sharing a bank word means a card could print the
//    same word on both sides of the plus.
//
//    bank[0] is exempt because it is the item's own essence, which is library
//    content this script does not govern -- and there is one real pre-existing
//    collision there: the gift Knowledge and library three's Relator both
//    carry the essence "depth". They can never meet on a card (the only cell
//    pairing them is Relator|Knowledge in library one, where Relator's essence
//    is "closeness"), so this is recorded rather than fixed. Failing on it
//    would mean editing library content to satisfy a check about added words.
//
// 3. Corpus. No bank word duplicates any item's action or shadow. A card
//    printing "vision" in the Word Bank and "vision" again under In action
//    reads as though it is repeating itself.
//
// 4. Body. No bank word appears in the recognize or ask text of any card that
//    item appears on. THIS IS THE CHECK THAT MATTERS MOST and the one that
//    caught the most defects -- 105 on the first authoring pass. A bank word
//    echoed in the card text below it makes the card look like it is quoting
//    itself.
//
// 5. Names. No bank word duplicates an item name, or any word inside a
//    multi-word name. Added after "command" was nearly chosen for Knowledge,
//    which would have printed "mastery, command" beside a Command row.
//
// 6. Shared items agree. Gifts appear in libraries one and two; descriptors in
//    two and three. Their banks must be identical across files, or a reader
//    sees different words for the same gift depending on the tab. The existing
//    verifiers compare essence/action/shadow across siblings but not bank, so
//    without this check that drift would be invisible.
//
// A NOTE ON THE FIVE DIVERGENT STRENGTHS:
// Empathy, Harmony, Individualization, Positivity and Relator carry different
// essence words in library three than in library one. Their BANKS are checked
// against both libraries' card text and run clean on both, so one shared bank
// serves both tabs. Check 6 therefore requires strength banks to match across
// libraries one and three even though their essence words do not -- the first
// bank word is allowed to differ, since it is each library's own essence.
// ===========================================================================

const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "lib");
const L1 = JSON.parse(fs.readFileSync(path.join(DIR, "library-strengths-gifts.json"), "utf8"));
const L2 = JSON.parse(fs.readFileSync(path.join(DIR, "library-personality-gifts.json"), "utf8"));
const L3 = JSON.parse(fs.readFileSync(path.join(DIR, "library-strengths-personality.json"), "utf8"));

let fail = 0, shown = 0;
const bad = (m) => { fail++; if (shown++ < 12) console.log("  FAIL  " + m); };
const ok = (m) => console.log("  ok    " + m);

// Same stemmer the authoring harness used. Deliberately crude: it exists to
// catch "vision"/"visions", not to be linguistically correct.
function stem(w) {
  w = String(w).toLowerCase();
  const sufs = ["ingly","ings","ing","ies","ied","ers","er","es","ed","s","ly",
                "ness","ment","tion","ion"];
  for (const s of sufs) {
    if (w.length > s.length + 3 && w.endsWith(s)) return w.slice(0, -s.length);
  }
  return w;
}

const LIBS = [["one", L1], ["two", L2], ["three", L3]];

// ── 1. Shape ──────────────────────────────────────────────────────────────
let items = 0;
for (const [tag, L] of LIBS) {
  for (const kind of Object.keys(L.items)) {
    for (const [name, v] of Object.entries(L.items[kind])) {
      items++;
      if (!Array.isArray(v.bank)) { bad(`${tag}/${kind} "${name}" has no bank array`); continue; }
      if (v.bank.length !== 3) bad(`${tag}/${kind} "${name}" bank has ${v.bank.length} words, expected 3`);
      if (v.bank[0] !== v.essence)
        bad(`${tag}/${kind} "${name}" bank[0] is "${v.bank[0]}", expected its essence "${v.essence}"`);
      for (const w of v.bank) {
        if (typeof w !== "string" || !/^[a-z][a-z-]*$/.test(w))
          bad(`${tag}/${kind} "${name}" bank word ${JSON.stringify(w)} is not a single lowercase word`);
      }
    }
  }
}
if (!fail) ok(`${items} item banks are well formed (3 lowercase words, essence first)`);

// ── 2. Uniqueness ─────────────────────────────────────────────────────────
// Keyed by item name so the same shared gift in two libraries is not reported
// as colliding with itself.
{
  const seen = new Map();
  let dupes = 0;
  for (const [, L] of LIBS) {
    for (const kind of Object.keys(L.items)) {
      for (const [name, v] of Object.entries(L.items[kind])) {
        for (const w of (v.bank || [])) {
          if (w === v.essence) continue;   // see note 2 above
          const k = stem(w);
          const prev = seen.get(k);
          if (prev && prev !== name) { bad(`bank word "${w}" used by both "${prev}" and "${name}"`); dupes++; }
          else seen.set(k, name);
        }
      }
    }
  }
  if (!dupes) ok(`every added bank word is unique across all items (${seen.size} distinct)`);
}

// ── 3. Corpus ─────────────────────────────────────────────────────────────
{
  const other = new Map();
  for (const [, L] of LIBS)
    for (const kind of Object.keys(L.items))
      for (const [name, v] of Object.entries(L.items[kind]))
        for (const f of ["action", "shadow"]) other.set(stem(v[f]), `${name}.${f}`);
  let hits = 0;
  for (const [, L] of LIBS)
    for (const kind of Object.keys(L.items))
      for (const [name, v] of Object.entries(L.items[kind]))
        for (const w of (v.bank || [])) {
          const o = other.get(stem(w));
          if (o) { bad(`"${name}" bank word "${w}" duplicates ${o}`); hits++; }
        }
  if (!hits) ok("no bank word duplicates any action or shadow word");
}

// ── 4. Body ───────────────────────────────────────────────────────────────
// Axis map: which side of the "row|col" key each item kind sits on, per
// library. Getting these backwards silently checks the wrong item set --
// exactly the bug that let 7 defects through the first authoring pass, when
// library two's gift was read from the descriptor side of the key.
{
  const AXES = [
    [L1, 0, "strengths"], [L1, 1, "gifts"],
    [L2, 0, "descriptors"], [L2, 1, "gifts"],
    [L3, 0, "strengths"], [L3, 1, "descriptors"],
  ];
  const bodies = new Map();  // item name -> Set of stemmed words in its cards
  let cells = 0;
  for (const [L, axis] of AXES) {
    for (const [key, b] of Object.entries(L.blends)) {
      const name = key.split("|")[axis];
      let set = bodies.get(name);
      if (!set) { set = new Set(); bodies.set(name, set); }
      const text = ((b.recognize || "") + " " + (b.ask || "")).toLowerCase();
      for (const t of text.match(/[a-z']+/g) || []) set.add(stem(t));
    }
    cells += Object.keys(L.blends).length;
  }
  let hits = 0;
  for (const [, L] of LIBS)
    for (const kind of Object.keys(L.items))
      for (const [name, v] of Object.entries(L.items[kind]))
        for (const w of (v.bank || [])) {
          // bank[0] is the item's own essence, which the library authors
          // already cleared against their own bodies. Only the two added
          // words are this script's business.
          if (w === v.essence) continue;
          if ((bodies.get(name) || new Set()).has(stem(w))) {
            bad(`"${name}" bank word "${w}" appears in the card text of its own cells`);
            hits++;
          }
        }
  if (!hits) ok(`no added bank word appears in any card body (${cells} cell readings)`);
}

// ── 5. Names ──────────────────────────────────────────────────────────────
{
  const nameWords = new Set();
  for (const [, L] of LIBS)
    for (const kind of Object.keys(L.items))
      for (const n of Object.keys(L.items[kind]))
        for (const t of n.toLowerCase().match(/[a-z']+/g) || []) nameWords.add(stem(t));
  let hits = 0;
  for (const [, L] of LIBS)
    for (const kind of Object.keys(L.items))
      for (const [name, v] of Object.entries(L.items[kind]))
        for (const w of (v.bank || [])) {
          if (w === v.essence) continue;
          if (nameWords.has(stem(w))) { bad(`"${name}" bank word "${w}" duplicates an item name`); hits++; }
        }
  if (!hits) ok("no added bank word duplicates an item name");
}

// ── 6. Shared items agree across libraries ────────────────────────────────
{
  const compare = (aLib, bLib, kind, aTag, bTag, allowFirstToDiffer) => {
    const A = aLib.items[kind] || {}, B = bLib.items[kind] || {};
    const an = Object.keys(A).sort(), bn = Object.keys(B).sort();
    if (JSON.stringify(an) !== JSON.stringify(bn)) {
      bad(`${kind} names differ between library ${aTag} and ${bTag}`);
      return;
    }
    let drift = 0;
    for (const n of an) {
      const x = (A[n].bank || []).slice(allowFirstToDiffer ? 1 : 0);
      const y = (B[n].bank || []).slice(allowFirstToDiffer ? 1 : 0);
      if (JSON.stringify(x) !== JSON.stringify(y)) {
        bad(`${kind} "${n}" bank differs: library ${aTag} ${JSON.stringify(x)} vs ${bTag} ${JSON.stringify(y)}`);
        drift++;
      }
    }
    if (!drift) ok(`${kind} banks agree between library ${aTag} and ${bTag} (${an.length} items)`);
  };
  compare(L1, L2, "gifts", "one", "two", false);
  compare(L2, L3, "descriptors", "two", "three", false);
  // Libraries one and three disagree on five strengths' essence words by
  // design, so bank[0] is allowed to differ. The two ADDED words must match.
  compare(L1, L3, "strengths", "one", "three", true);
}

console.log("");
if (fail) {
  if (fail > shown) console.log(`  ... and ${fail - shown} more`);
  console.log(`WORD BANK: FAIL (${fail})`);
  process.exit(1);
}
console.log("WORD BANK: PASS");

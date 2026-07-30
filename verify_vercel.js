// Standalone boundary tests for api/ai.js (Vercel migration, July 30 2026).
// Tests pure logic only — no network, no database. Run: node verify_vercel.js

const {
  parseCacheKey,
  cacheKeyFromRow,
  eqFilter,
  normalizeEmail,
  rowToProfile,
  monthsSince,
  EFFORT_CAPABLE,
  REGEN_MONTHS,
  UPSTREAM_TIMEOUT_MS
} = require("./api/ai.js")._internal;

let pass = 0, fail = 0;
function t(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`  FAIL: ${label}\n    expected ${e}\n    got      ${a}`); }
}

console.log("\n── parseCacheKey ──");
t("m1 key parses", parseCacheKey("cache_m1|Achiever|INFJ-A"), { matrix: "m1", keyA: "Achiever", keyB: "INFJ-A" });
t("m2 key parses", parseCacheKey("cache_m2|Achiever|Prophecy"), { matrix: "m2", keyA: "Achiever", keyB: "Prophecy" });
t("m3 key parses", parseCacheKey("cache_m3|INFJ-A|Mercy"), { matrix: "m3", keyA: "INFJ-A", keyB: "Mercy" });
t("m4 is rejected (never cached)", parseCacheKey("cache_m4|a|b"), null);
t("profile key rejected", parseCacheKey("profile_seth@x.com"), null);
t("approved_emails key rejected", parseCacheKey("approved_emails"), null);
t("empty rejected", parseCacheKey(""), null);
t("null rejected", parseCacheKey(null), null);
t("undefined rejected", parseCacheKey(undefined), null);
t("missing third segment rejected", parseCacheKey("cache_m1|Achiever"), null);
t("empty keyA rejected", parseCacheKey("cache_m1||INFJ-A"), null);
t("empty keyB rejected", parseCacheKey("cache_m1|Achiever|"), null);
t("prefix-only rejected", parseCacheKey("cache_m1|"), null);
t("lookalike prefix rejected", parseCacheKey("xcache_m1|a|b"), null);
t("m5 rejected", parseCacheKey("cache_m5|a|b"), null);
// A value containing a pipe must not silently truncate into a different entry.
t("extra pipes join into keyB", parseCacheKey("cache_m2|Achiever|Faith|Extra"), { matrix: "m2", keyA: "Achiever", keyB: "Faith|Extra" });

console.log("\n── cacheKeyFromRow round-trip ──");
const rows = [
  { matrix: "m1", key_a: "Achiever", key_b: "INFJ-A" },
  { matrix: "m2", key_a: "Woo", key_b: "Teaching" },
  { matrix: "m3", key_a: "ENTP-T", key_b: "Leadership" }
];
for (const r of rows) {
  const key = cacheKeyFromRow(r);
  t(`round-trip ${key}`, parseCacheKey(key), { matrix: r.matrix, keyA: r.key_a, keyB: r.key_b });
}

console.log("\n── eqFilter (injection safety) ──");
t("simple value quoted", eqFilter("Achiever"), "eq." + encodeURIComponent('"Achiever"'));
t("value with space", eqFilter("Strategic Thinking"), "eq." + encodeURIComponent('"Strategic Thinking"'));
// A comma would otherwise terminate a PostgREST filter expression.
t("comma is contained", eqFilter("a,b"), "eq." + encodeURIComponent('"a,b"'));
t("embedded quote escaped", eqFilter('say"hi'), "eq." + encodeURIComponent('"say\\"hi"'));
t("backslash escaped", eqFilter("a\\b"), "eq." + encodeURIComponent('"a\\\\b"'));
t("no raw comma survives encoding", eqFilter("a,b").includes(","), false);
t("no raw ampersand survives", eqFilter("a&b").includes("&"), false);

console.log("\n── normalizeEmail ──");
t("lowercases", normalizeEmail("Seth@Inheritance.Vision"), "seth@inheritance.vision");
t("trims", normalizeEmail("  a@b.com  "), "a@b.com");
t("null safe", normalizeEmail(null), "");
t("undefined safe", normalizeEmail(undefined), "");

console.log("\n── rowToProfile (frontend contract) ──");
const iso = "2026-01-15T12:00:00.000Z";
const p = rowToProfile({
  email: "a@b.com", name: "Seth", personality: "INFJ-A",
  strengths: ["Achiever"], gifts: ["Faith"],
  ai_data: { m1Data: { Achiever: {} } }, saved_at: iso
});
// restoreProfileToState() and profileAgeMonths() both require savedAt to be a
// NUMBER. An ISO string here would make profileAgeMonths return NaN — the exact
// class of bug that broke profile restore in June.
t("savedAt is a number", typeof p.savedAt, "number");
t("savedAt matches ISO input", p.savedAt, new Date(iso).getTime());
t("aiData mapped from ai_data", p.aiData, { m1Data: { Achiever: {} } });
t("strengths array preserved", p.strengths, ["Achiever"]);
t("gifts array preserved", p.gifts, ["Faith"]);
t("null row returns null", rowToProfile(null), null);
const bare = rowToProfile({ email: "x@y.com", name: "X", personality: "P", saved_at: iso });
t("missing strengths becomes []", bare.strengths, []);
t("missing gifts becomes []", bare.gifts, []);
t("missing ai_data becomes null", bare.aiData, null);
t("non-array strengths becomes []", rowToProfile({ saved_at: iso, strengths: "nope" }).strengths, []);

console.log("\n── 12-month soft tracker ──");
t("REGEN_MONTHS is 12", REGEN_MONTHS, 12);
const DAY = 24 * 60 * 60 * 1000;
const ageAt = (days) => monthsSince(Date.now() - days * DAY);
t("fresh profile is ~0 months", Math.round(ageAt(0)), 0);
t("6 months does NOT need refresh at 12mo policy", ageAt(183) >= REGEN_MONTHS, false);
t("11 months does not trigger", ageAt(334) >= REGEN_MONTHS, false);
t("13 months does trigger", ageAt(396) >= REGEN_MONTHS, true);
t("just under 12mo does not trigger", ageAt(364) >= REGEN_MONTHS, false);
t("just over 12mo triggers", ageAt(367) >= REGEN_MONTHS, true);

console.log("\n── effort capability gate ──");
// Attaching output_config.effort to a model that does not support it returns a
// 400. This gate broke all three matrix summaries before it existed.
t("opus-5 supports effort", EFFORT_CAPABLE.test("claude-opus-5"), true);
t("sonnet-5 supports effort", EFFORT_CAPABLE.test("claude-sonnet-5"), true);
t("sonnet-4-6 supports effort", EFFORT_CAPABLE.test("claude-sonnet-4-6"), true);
t("fable-5 supports effort", EFFORT_CAPABLE.test("claude-fable-5"), true);
t("mythos-5 supports effort", EFFORT_CAPABLE.test("claude-mythos-5"), true);
t("opus-4-5 supports effort", EFFORT_CAPABLE.test("claude-opus-4-5"), true);
t("sonnet-4-5 does NOT (the summaries bug)", EFFORT_CAPABLE.test("claude-sonnet-4-5"), false);
t("haiku-4-5 does NOT", EFFORT_CAPABLE.test("claude-haiku-4-5"), false);
t("opus-4-1 does NOT", EFFORT_CAPABLE.test("claude-opus-4-1"), false);
t("empty string does NOT", EFFORT_CAPABLE.test(""), false);

console.log("\n── timeout budget ──");
const MAX_DURATION_S = JSON.parse(require("fs").readFileSync("./vercel.json", "utf8")).functions["api/ai.js"].maxDuration;
t("vercel.json maxDuration is 300", MAX_DURATION_S, 300);
t("self-abort is 270s", UPSTREAM_TIMEOUT_MS, 270000);
// Must abort BEFORE Vercel kills the function, or the caller gets an HTML error
// page instead of readable JSON — the original invisible-failure bug.
t("self-abort fires before Vercel limit", UPSTREAM_TIMEOUT_MS < MAX_DURATION_S * 1000, true);
t("at least 20s margin to build error response", (MAX_DURATION_S * 1000 - UPSTREAM_TIMEOUT_MS) >= 20000, true);
// The old Netlify ceiling was 8.5s and every generation exceeded it.
t("headroom vastly exceeds old 8.5s ceiling", UPSTREAM_TIMEOUT_MS > 8500 * 10, true);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

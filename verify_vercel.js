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
  UPSTREAM_TIMEOUT_MS,
  powerConfig,
  POWER_LEVELS,
  GENERATION_POWER,
  THINKING_OFF_ALLOWED,
  SYSTEM_PROMPT,
  buildM1Prompt,
  buildM2Prompt,
  buildM3Prompt,
  buildM4Prompt,
  buildM4StrCardPrompt,
  buildM4BonusPrompt
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

console.log("\n── eqFilter (PostgREST semantics) ──");
// REGRESSION GUARD: quoting values broke every filtered query in production on
// July 30, 2026 — PostgREST matched against the quote marks themselves, so
// checkEmail found nobody and no cache lookup could ever hit.
t("plain value, no quotes", eqFilter("Achiever"), "eq.Achiever");
t("email encodes @ but is NOT quoted", eqFilter("lme2@me.com"), "eq.lme2%40me.com");
t("no double quote is ever emitted", eqFilter("lme2@me.com").includes("%22"), false);
t("no literal quote is ever emitted", eqFilter("lme2@me.com").includes('"'), false);
t("dots survive unencoded in the value", eqFilter("a.b.com"), "eq.a.b.com");
t("personality code passes through", eqFilter("INFJ-A"), "eq.INFJ-A");
t("space is encoded", eqFilter("Strategic Thinking"), "eq.Strategic%20Thinking");
t("ampersand cannot break the query string", eqFilter("a&b").includes("&"), false);
t("hash is encoded", eqFilter("a#b").includes("#"), false);
// Every real caller must stay inside the no-reserved-characters constraint the
// helper documents. If a value ever gains a comma, this is where it surfaces.
const REAL_VALUES = [
  "lme2@me.com", "seth@inheritance.vision", "lowdenj@tecumsehschools.org",
  "Achiever", "Strategic", "Woo", "Input", "Learner",
  "INFJ-A", "ENTP-T", "ISTJ-A",
  "Prophecy", "Teaching", "Mercy", "Faith", "Leadership",
  "m1", "m2", "m3"
];
let reservedHits = 0;
for (const v of REAL_VALUES) if (/[,():]/.test(v)) reservedHits++;
t("no real value contains a reserved character", reservedHits, 0);
for (const v of REAL_VALUES) {
  t(`round-trip decodes to original: ${v}`, decodeURIComponent(eqFilter(v).slice(3)), v);
}

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

console.log("\n── generation power dial ──");
// THE 400 GUARD. Opus 5 rejects thinking:{disabled} at effort xhigh or max.
// This must be structurally impossible, not merely documented.
for (const [name, cfg] of Object.entries(POWER_LEVELS)) {
  const p = powerConfig(name);
  const illegal = p.disableThinking && !THINKING_OFF_ALLOWED.includes(p.effort);
  t(`${name}: never disables thinking above high effort`, illegal, false);
  t(`${name}: effort is a real Opus 5 level`, ["low", "medium", "high", "xhigh", "max"].includes(p.effort), true);
  t(`${name}: maxTokens leaves room for card JSON`, p.maxTokens >= 15000, true);
  t(`${name}: maxTokens within Opus 5 128k ceiling`, p.maxTokens <= 128000, true);
  t(`${name}: config matches declared level`, p.effort, cfg.effort);
}
// Thinking ON tiers must carry more room, since thinking shares the ceiling.
t("deep raises max_tokens above standard", POWER_LEVELS.deep.maxTokens > POWER_LEVELS.standard.maxTokens, true);
t("max raises max_tokens above deep", POWER_LEVELS.max.maxTokens > POWER_LEVELS.deep.maxTokens, true);
t("standard keeps the proven 14s config", powerConfig("standard"), { effort: "high", disableThinking: true, maxTokens: 15000 });
t("deep leaves thinking on", powerConfig("deep").disableThinking, false);
t("max leaves thinking on", powerConfig("max").disableThinking, false);
// A typo in the dial must fall back to the proven setting, not crash or 400.
t("unknown level falls back to standard", powerConfig("turbo"), powerConfig("standard"));
t("empty level falls back to standard", powerConfig(""), powerConfig("standard"));
t("undefined level falls back to standard", powerConfig(undefined), powerConfig("standard"));
// Fail-safe direction: a hand-edit asking for the illegal combo must not 400.
t("illegal hand-edit fails safe to thinking ON",
  powerConfig(Object.keys(POWER_LEVELS).find((k) => POWER_LEVELS[k].effort === "max")).disableThinking, false);
t("dial is set to a level that exists", Object.keys(POWER_LEVELS).includes(GENERATION_POWER), true);

console.log("\n── card voice (A + C) ──");
// The words "poetic" and "vivid" in the schemas are what produced the flat,
// flowery cards. If either ever comes back, these fail.
const ALL_PROMPTS = [
  buildM1Prompt("Strategic", "ENTJ-A"),
  buildM2Prompt("Strategic", "Leadership"),
  buildM3Prompt("ENTJ-A", "Leadership"),
  buildM4Prompt("Seth", ["Strategic", "Achiever"], "ENTJ-A", ["Leadership", "Faith"]),
  buildM4StrCardPrompt("Seth", "Strategic", "ENTJ-A", ["Leadership"]),
  buildM4BonusPrompt("Seth", ["Strategic", "Achiever", "Woo"], "ENTJ-A", ["Leadership", "Faith", "Teaching"])
];
for (const p of ALL_PROMPTS) {
  t("no 'poetic' in schema", /poetic/i.test(p), false);
  t("no 'vivid' in schema", /vivid/i.test(p), false);
  t("still demands pure JSON", /pure JSON only/.test(p), true);
}
// Every card-shaped prompt (not the bonus, which has no shadowSide) must ask
// for the cost to OTHERS, which is the whole point of option C.
for (const p of ALL_PROMPTS.slice(0, 4)) {
  t("shadowSide names cost to others", /PEOPLE (AROUND THEM|BEING SERVED)/.test(p), true);
  t("growth edge has a real price", /costs? (this person )?time, comfort, or control/.test(p), true);
}
// Option A lives in the system prompt and must survive edits.
t("system prompt demands observable behavior", /OBSERVABLE BEHAVIOR/.test(SYSTEM_PROMPT), true);
t("system prompt demands honest cost", /HONEST COST/.test(SYSTEM_PROMPT), true);
t("system prompt bans elevated nouns", /sovereign, architect, unflinching/.test(SYSTEM_PROMPT), true);
t("system prompt still forbids non-Latin scripts", /non-Latin scripts/.test(SYSTEM_PROMPT), true);
t("system prompt still demands pure JSON", /Return pure JSON only/.test(SYSTEM_PROMPT), true);
// Prayers stay first person; the bonus blessing stays third person.
for (const p of ALL_PROMPTS.slice(0, 5)) {
  t("prayer stays first person", /NOT a prayer spoken over them/.test(p), true);
}
t("bonus blessing stays third person", /third person/.test(ALL_PROMPTS[5]), true);
// M4 is the only tier that sees the whole person — it must actually use it.
t("M4 receives the participant name", /Seth/.test(ALL_PROMPTS[3]), true);
t("M4 receives all strengths", /Strategic, Achiever/.test(ALL_PROMPTS[3]), true);
t("M4 is told to use the named traits", /ACTUAL named strengths and gifts/.test(ALL_PROMPTS[3]), true);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

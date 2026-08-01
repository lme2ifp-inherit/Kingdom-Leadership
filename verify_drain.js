// Boundary tests for the generation queue (July 31, 2026).
// Pure logic only — no network, no database. Run: node verify_drain.js

const ai = require("./api/ai.js")._internal;
const drain = require("./api/drain.js")._internal;
const { planItemsFor, buildPromptFor, CACHEABLE_KINDS } = ai;
const {
  extractCard, assembleProfile, withTimeout,
  FUNCTION_BUDGET_MS, CARD_TIMEOUT_MS, RESPONSE_OVERHEAD_MS, WAVE_SIZE, MAX_ITEM_ATTEMPTS
} = drain;

let pass = 0, fail = 0;
function t(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`  FAIL: ${label}\n    expected ${e}\n    got      ${a}`); }
}
function ok(label, cond) { t(label, !!cond, true); }

const PARTICIPANT = {
  name: "Seth",
  personality: "ENTJ-A",
  strengths: ["Strategic", "Arranger", "Responsibility", "Analytical", "Command"],
  gifts: ["Giving", "Administration", "Wisdom"]
};

console.log("\n── job planning ──");
const items = planItemsFor(PARTICIPANT);
const countOf = (k) => items.filter((i) => i.kind === k).length;
t("m1: one per strength", countOf("m1"), 5);
t("m2: strengths x gifts", countOf("m2"), 15);
t("m3: one per gift", countOf("m3"), 3);
t("one summary per matrix", countOf("m1sum") + countOf("m2sum") + countOf("m3sum"), 3);
t("one m4 master", countOf("m4"), 1);
t("one m4 bonus", countOf("m4bonus"), 1);
t("m4str: one per strength", countOf("m4str"), 5);
t("total is 33 cards", items.length, 33);

// A duplicate cache_key would violate the unique index and fail the whole insert.
const keys = items.map((i) => i.cache_key);
t("every cache key is unique", new Set(keys).size, keys.length);
ok("positions are sequential from 0", items.every((it, i) => it.position === i));

console.log("\n── cacheability ──");
// Only M1/M2/M3 are shared between people. Caching anything personal would
// serve one participant's card to a different participant.
for (const it of items) {
  const shouldCache = CACHEABLE_KINDS.indexOf(it.kind) !== -1;
  t(`${it.kind} cacheable=${shouldCache}`, it.cacheable, shouldCache);
}
t("exactly 23 cards are cacheable", items.filter((i) => i.cacheable).length, 23);
t("10 cards are always personal", items.filter((i) => !i.cacheable).length, 10);
// The personal ten are the real steady-state cost once the cache is warm.
ok("no m4-tier card is ever cacheable",
  items.filter((i) => i.kind.startsWith("m4")).every((i) => !i.cacheable));
ok("no summary is ever cacheable",
  items.filter((i) => i.kind.endsWith("sum")).every((i) => !i.cacheable));

console.log("\n── prompt dispatch ──");
for (const it of items) {
  const prompt = buildPromptFor(it.kind, it.params);
  ok(`${it.kind} builds a prompt`, typeof prompt === "string" && prompt.length > 50);
  ok(`${it.kind} demands pure JSON`, /pure JSON only/i.test(prompt));
  // The July 30 voice rewrite must reach every prompt, including the three
  // summaries that used to be built in the browser and were missed.
  ok(`${it.kind} has no 'poetic'`, !/poetic/i.test(prompt));
  ok(`${it.kind} has no 'vivid'`, !/vivid/i.test(prompt));
}
t("unknown kind returns null", buildPromptFor("m9", {}), null);
// Malformed items must fail CLEANLY rather than throw or, worse, build a
// prompt containing the string "undefined" and bill for a garbage card.
t("missing params returns null, not a prompt", buildPromptFor("m1", {}), null);
t("empty strengths array returns null", buildPromptFor("m4", { personality: "ENTJ-A", strengths: [], gifts: ["Faith"] }), null);
t("missing personality returns null", buildPromptFor("m1", { strength: "Strategic" }), null);
t("null params returns null", buildPromptFor("m1", null), null);
ok("no prompt ever contains the word undefined",
  items.every((it) => !/undefined/.test(buildPromptFor(it.kind, it.params) || "")));

console.log("\n── budget gate (the Health lesson) ──");
// Health's first version used a flat elapsed-time deadline, which ignored how
// long the NEXT item could take. A fast first item let a second start, run
// long, and get hard-killed past maxDuration with no logged reason.
const needPerWave = CARD_TIMEOUT_MS + RESPONSE_OVERHEAD_MS;
ok("a full wave's worst case fits in the budget", needPerWave < FUNCTION_BUDGET_MS);
t("at least 2 waves guaranteed even at worst case",
  Math.floor(FUNCTION_BUDGET_MS / needPerWave) >= 2, true);

// Simulate the gate against arbitrary wave durations. The invariant: the
// function must NEVER still be working past its budget.
function simulate(waveDurations) {
  const start = 0;
  const deadline = start + FUNCTION_BUDGET_MS;
  let now = start, wavesRun = 0;
  for (const d of waveDurations) {
    if (now + needPerWave > deadline) break;   // the gate, verbatim
    now += d;
    wavesRun++;
  }
  return { finishedAt: now, wavesRun, overran: now > FUNCTION_BUDGET_MS };
}
const scenarios = {
  "all fast (14s observed)":      Array(20).fill(14000),
  "all at worst case (45s)":      Array(20).fill(CARD_TIMEOUT_MS),
  "fast then slow (the old bug)": [1000, 1000, 1000, CARD_TIMEOUT_MS, CARD_TIMEOUT_MS, CARD_TIMEOUT_MS],
  "instant then one huge":        [100, 100, 100, 100, CARD_TIMEOUT_MS],
  "alternating":                  [2000, 45000, 2000, 45000, 2000, 45000]
};
for (const [name, durations] of Object.entries(scenarios)) {
  const r = simulate(durations);
  ok(`${name}: never overruns budget`, !r.overran);
  ok(`${name}: does at least one wave`, r.wavesRun >= 1);
}
// A 33-card job at observed speed should clear in a single invocation.
const realistic = simulate(Array(7).fill(14000));
t("33 cards (7 waves @14s) complete in one run", realistic.wavesRun, 7);
ok("and finish well inside budget", realistic.finishedAt < FUNCTION_BUDGET_MS);

console.log("\n── wave sizing ──");
t("wave size is 5", WAVE_SIZE, 5);
t("33 cards is 7 waves", Math.ceil(33 / WAVE_SIZE), 7);
// Because a wave runs concurrently, its worst case equals ONE card's timeout —
// not the sum. That is what makes concurrency improve the budget maths.
ok("wave worst case is one card, not the sum", needPerWave < CARD_TIMEOUT_MS * WAVE_SIZE);

console.log("\n── ceiling safety ──");
const vercelJson = JSON.parse(require("fs").readFileSync("./vercel.json", "utf8"));
const drainMax = vercelJson.functions["api/drain.js"].maxDuration;
t("drain registered in vercel.json", drainMax, 180);
t("budget matches vercel.json", FUNCTION_BUDGET_MS, drainMax * 1000);
// Headroom below the Hobby ceiling is what turns a platform hard-kill into a
// clean logged stop. Not maxed to 300 on purpose.
ok("drain stays below the 300s Hobby ceiling", drainMax < 300);
ok("leaves >=100s of headroom", 300 - drainMax >= 100);

console.log("\n── card extraction ──");
const good = { content: [{ type: "text", text: '{"theme":"Sees The Route"}' }], stop_reason: "end_turn" };
t("clean JSON parses", extractCard(good).ok, true);
t("parsed card is returned", extractCard(good).card.theme, "Sees The Route");
t("markdown fences stripped", extractCard({ content: [{ type: "text", text: '```json\n{"a":1}\n```' }] }).ok, true);
t("prose around JSON tolerated", extractCard({ content: [{ type: "text", text: 'Here:\n{"a":1}\nDone' }] }).ok, true);
// TRUNCATED must fail rather than persist half a card — a truncated card that
// parsed would be saved permanently and look real.
t("truncated is rejected", extractCard({ content: [{ type: "text", text: '{"a":1}' }], stop_reason: "max_tokens" }).ok, false);
ok("truncation names the ceiling", /TRUNCATED/.test(extractCard({ content: [{ type: "text", text: "{}" }], stop_reason: "max_tokens" }).error));
t("empty content rejected", extractCard({ content: [] }).ok, false);
t("no JSON rejected", extractCard({ content: [{ type: "text", text: "sorry, I cannot" }] }).ok, false);
t("malformed JSON rejected", extractCard({ content: [{ type: "text", text: "{broken" }] }).ok, false);
t("api error rejected", extractCard({ error: { message: "rate limited" } }).ok, false);
t("null response rejected", extractCard(null).ok, false);
ok("error text always present", extractCard(null).error.length > 0);

console.log("\n── profile assembly ──");
const done = (kind, params, result) => ({ kind, params, result, status: "done" });
const assembled = assembleProfile({ participant: PARTICIPANT }, [
  done("m1", { strength: "Strategic" }, { theme: "A" }),
  done("m2", { strength: "Strategic", gift: "Wisdom" }, { theme: "B" }),
  done("m3", { gift: "Wisdom" }, { theme: "C" }),
  done("m1sum", {}, { theme: "S1" }),
  done("m2sum", {}, { theme: "S2" }),
  done("m3sum", {}, { theme: "S3" }),
  done("m4", {}, { unifiedTheme: "M4" }),
  done("m4bonus", {}, { bonusTheme: "BON" }),
  done("m4str", { strength: "Strategic" }, { cardTheme: "SC" })
]);
// Shape must match what the frontend already reads, or restore breaks silently.
t("m1Data keyed by strength", assembled.m1Data.Strategic.theme, "A");
t("m2Data nested strength->gift", assembled.m2Data.Strategic.Wisdom.theme, "B");
t("m3Data keyed by gift", assembled.m3Data.Wisdom.theme, "C");
t("m4Cards keyed by strength", assembled.m4Cards.Strategic.cardTheme, "SC");
t("m1Summary is a single object", assembled.m1Summary.theme, "S1");
t("m4Data is a single object", assembled.m4Data.unifiedTheme, "M4");
t("m4Bonus is a single object", assembled.m4Bonus.bonusTheme, "BON");
// Failed items must never reach the profile — the July 26 corruption lesson.
const withFailure = assembleProfile({ participant: PARTICIPANT }, [
  done("m1", { strength: "Strategic" }, { theme: "good" }),
  { kind: "m1", params: { strength: "Command" }, result: { theme: "bad" }, status: "failed" }
]);
t("failed items excluded from profile", withFailure.m1Data.Command, undefined);
t("done items still included", withFailure.m1Data.Strategic.theme, "good");
t("missing kind yields null, not undefined", assembleProfile({}, []).m4Data, null);

console.log("\n── retry bounds ──");
t("max attempts is 3", MAX_ITEM_ATTEMPTS, 3);
// Retries bill on every attempt, including truncated responses. Unbounded
// retry on a persistently failing card is unbounded spend.
ok("retries are bounded", MAX_ITEM_ATTEMPTS < 10);
ok("but more than one attempt is allowed", MAX_ITEM_ATTEMPTS > 1);

console.log("\n── withTimeout ──");
(async () => {
  t("resolves fast promise", await withTimeout(Promise.resolve("ok"), 1000), "ok");
  let timedOut = false;
  try { await withTimeout(new Promise(() => {}), 50); } catch (e) { timedOut = /exceeded/.test(e.message); }
  ok("rejects a hung promise", timedOut);
  let propagated = false;
  try { await withTimeout(Promise.reject(new Error("upstream")), 1000); } catch (e) { propagated = e.message === "upstream"; }
  ok("propagates the real error", propagated);

  console.log("\n── concurrent drain safety ──");
// The cron fires every 60s but a cold job runs ~100s, so two drains WILL
// overlap. If both could claim the same job they would generate the same
// in-flight cards twice — duplicate Opus 5 spend, which the unique index does
// not prevent (it stops duplicate rows, not duplicate API calls).
const { HEARTBEAT_STALE_MS } = drain;
const CRON_INTERVAL_MS = 60000;
ok("stale window exceeds the cron interval", HEARTBEAT_STALE_MS > CRON_INTERVAL_MS);
// A heartbeat is written after every wave, so the longest legitimate silence
// is one wave's worst case. The window must exceed that or a healthy job gets
// stolen mid-run.
const maxHeartbeatGap = CARD_TIMEOUT_MS + RESPONSE_OVERHEAD_MS;
ok("stale window exceeds the longest legitimate heartbeat gap", HEARTBEAT_STALE_MS > maxHeartbeatGap);
// But it must still be short enough that a genuinely dead job is picked up
// well within the function budget, rather than stalling the queue.
ok("stale window is shorter than the function budget", HEARTBEAT_STALE_MS < FUNCTION_BUDGET_MS);

function claimable(job, nowMs) {
  if (job.status === "pending") return true;
  if (job.status !== "processing") return false;
  return (nowMs - job.heartbeatMs) >= HEARTBEAT_STALE_MS;
}
const now = 1000000;
t("pending job is claimable", claimable({ status: "pending" }, now), true);
t("actively beating job is NOT claimable", claimable({ status: "processing", heartbeatMs: now - 5000 }, now), false);
t("job one cron tick old is NOT claimable", claimable({ status: "processing", heartbeatMs: now - CRON_INTERVAL_MS }, now), false);
t("job mid-wave is NOT claimable", claimable({ status: "processing", heartbeatMs: now - maxHeartbeatGap }, now), false);
t("dead job IS reclaimable", claimable({ status: "processing", heartbeatMs: now - HEARTBEAT_STALE_MS - 1 }, now), true);
t("complete job is never claimable", claimable({ status: "complete", heartbeatMs: 0 }, now), false);
t("failed job is never claimable", claimable({ status: "failed", heartbeatMs: 0 }, now), false);

console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();

// Boundary tests for the Phase 4 frontend changes (July 30, 2026).
// Extracts the real resolveEndpoint logic from index.html and exercises it
// against simulated platform responses. Run: node verify_frontend.js

const fs = require("fs");

const html = fs.readFileSync("./index.html", "utf8");

let pass = 0, fail = 0;
function t(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`  FAIL: ${label}\n    expected ${e}\n    got      ${a}`); }
}

// ── Extract the real source rather than retyping it, so these tests cannot
// ── silently pass against a stale copy of the logic.
function extract(startMarker, endMarker) {
  const s = html.indexOf(startMarker);
  if (s === -1) throw new Error("Could not find: " + startMarker);
  const e = html.indexOf(endMarker, s);
  if (e === -1) throw new Error("Could not find end marker after: " + startMarker);
  return html.slice(s, e + endMarker.length);
}

const candidatesSrc = extract('const ENDPOINT_CANDIDATES', '];');
const resolverSrc = extract('async function resolveEndpoint()', '\n}');
const timeoutSrc = extract('const CLIENT_TIMEOUT_MS', ';');

// Build a sandbox where fetch is controllable.
function makeResolver(fetchImpl) {
  const factory = new Function("fetch", `
    ${candidatesSrc}
    let RESOLVED_ENDPOINT = null;
    ${resolverSrc}
    return { resolveEndpoint, ENDPOINT_CANDIDATES, reset: () => { RESOLVED_ENDPOINT = null; } };
  `);
  return factory(fetchImpl);
}

const jsonRes = (status) => ({
  status,
  headers: { get: (h) => (h.toLowerCase() === "content-type" ? "application/json; charset=utf-8" : null) }
});
const htmlRes = (status) => ({
  status,
  headers: { get: (h) => (h.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) }
});

(async () => {
  console.log("\n── endpoint candidate order ──");
  const base = makeResolver(async () => jsonRes(400));
  t("Vercel path is tried first", base.ENDPOINT_CANDIDATES[0], "/api/ai");
  t("Netlify path is the fallback", base.ENDPOINT_CANDIDATES[1], "/.netlify/functions/ai");
  t("exactly two candidates", base.ENDPOINT_CANDIDATES.length, 2);

  console.log("\n── running on Vercel ──");
  // Vercel: /api/ai answers with the function's own JSON 400 "Unknown action".
  const onVercel = makeResolver(async (url) =>
    url === "/api/ai" ? jsonRes(400) : jsonRes(404)
  );
  t("resolves to /api/ai", await onVercel.resolveEndpoint(), "/api/ai");

  console.log("\n── running on Netlify ──");
  const onNetlify = makeResolver(async (url) =>
    url === "/.netlify/functions/ai" ? jsonRes(400) : jsonRes(404)
  );
  t("resolves to Netlify path", await onNetlify.resolveEndpoint(), "/.netlify/functions/ai");

  console.log("\n── SPA catch-all trap ──");
  // The dangerous case: a static host answers ANY unknown path with 200 + HTML.
  // Status alone would accept it and every call would then fail confusingly.
  const spaCatchAll = makeResolver(async (url) =>
    url === "/api/ai" ? htmlRes(200) : jsonRes(400)
  );
  t("HTML 200 is rejected, falls through to Netlify", await spaCatchAll.resolveEndpoint(), "/.netlify/functions/ai");

  const spaCatchAll404 = makeResolver(async (url) =>
    url === "/api/ai" ? htmlRes(404) : jsonRes(400)
  );
  t("HTML 404 also falls through", await spaCatchAll404.resolveEndpoint(), "/.netlify/functions/ai");

  console.log("\n── error tolerance ──");
  // A thrown fetch (DNS failure, blocked request) must not abort resolution.
  const firstThrows = makeResolver(async (url) => {
    if (url === "/api/ai") throw new Error("network down");
    return jsonRes(400);
  });
  t("throwing candidate is skipped", await firstThrows.resolveEndpoint(), "/.netlify/functions/ai");

  const allThrow = makeResolver(async () => { throw new Error("offline"); });
  t("total failure still returns a usable path", await allThrow.resolveEndpoint(), "/.netlify/functions/ai");

  const allFourOhFour = makeResolver(async () => jsonRes(404));
  t("all 404 returns last candidate (real error, not silence)", await allFourOhFour.resolveEndpoint(), "/.netlify/functions/ai");

  console.log("\n── non-400 JSON responses are accepted ──");
  for (const status of [200, 400, 405, 500]) {
    const r = makeResolver(async (url) => (url === "/api/ai" ? jsonRes(status) : jsonRes(404)));
    t(`JSON ${status} on /api/ai accepted`, await r.resolveEndpoint(), "/api/ai");
  }

  console.log("\n── session caching (probe runs once) ──");
  let calls = 0;
  const counting = makeResolver(async (url) => { calls++; return url === "/api/ai" ? jsonRes(400) : jsonRes(404); });
  await counting.resolveEndpoint();
  const afterFirst = calls;
  await counting.resolveEndpoint();
  await counting.resolveEndpoint();
  t("first resolution probes once", afterFirst, 1);
  t("subsequent calls make no further requests", calls, afterFirst);

  console.log("\n── client timeout budget ──");
  const clientMs = Number(timeoutSrc.match(/=\s*(\d+)/)[1]);
  const vercelJson = JSON.parse(fs.readFileSync("./vercel.json", "utf8"));
  const maxDurationMs = vercelJson.functions["api/ai.js"].maxDuration * 1000;
  const serverAbortMs = 270000;

  t("client ceiling is 285s", clientMs, 285000);
  t("no longer the old 12s ceiling", clientMs === 12000, false);
  // Ordering is the whole point: server aborts first (so its readable JSON error
  // wins), platform kill is last (so it is never what the user sees).
  t("client waits LONGER than server self-abort", clientMs > serverAbortMs, true);
  t("client gives up BEFORE platform hard kill", clientMs < maxDurationMs, true);
  t("server abort precedes platform kill", serverAbortMs < maxDurationMs, true);
  t("client leaves >=10s for server error to arrive", clientMs - serverAbortMs >= 10000, true);

  console.log("\n── IS_LIVE host detection ──");
  const isLiveSrc = extract("const IS_LIVE", ";");
  const isLiveFor = (hostname) =>
    new Function("window", `${isLiveSrc}; return IS_LIVE;`)({ location: { hostname } });

  t("netlify.app is live", isLiveFor("kingdom-leadership.netlify.app"), true);
  t("production domain is live", isLiveFor("leadership.inheritance.vision"), true);
  // Without this, Phase 5 preview testing would silently use localStorage and
  // appear to pass while never touching Supabase.
  t("vercel.app preview is live", isLiveFor("kingdom-leadership-abc123.vercel.app"), true);
  t("vercel production alias is live", isLiveFor("kingdom-leadership.vercel.app"), true);
  t("localhost is NOT live", isLiveFor("localhost"), false);
  t("random host is NOT live", isLiveFor("example.com"), false);

  console.log("\n── no stale hardcoded endpoints remain ──");
  const scriptBody = html.slice(html.indexOf("<script>"), html.lastIndexOf("</script>"));
  const hardcodedFetches = (scriptBody.match(/fetch\(\s*["']\/\.netlify\/functions\/ai["']/g) || []).length;
  t("no fetch() hardcodes the Netlify path", hardcodedFetches, 0);
  const hardcodedVercel = (scriptBody.match(/fetch\(\s*["']\/api\/ai["']/g) || []).length;
  t("no fetch() hardcodes the Vercel path", hardcodedVercel, 0);
  t("12000 no longer used as a timeout", /setTimeout\(\s*\(\)\s*=>\s*ctrl\.abort\(\)\s*,\s*12000\s*\)/.test(scriptBody), false);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();

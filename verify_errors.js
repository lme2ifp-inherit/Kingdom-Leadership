// Behavioral tests for the error-surfacing fix (July 31 2026).
// Simulates each way the serverless call can fail and asserts that the app
// reports the REAL reason rather than inventing a friendly-sounding lie.
// Run: node verify_errors.js

const fs = require("fs");
const html = fs.readFileSync("./index.html", "utf8");
const start = html.indexOf("<script>") + "<script>".length;
const end = html.indexOf("</script>", start);
const src = html.slice(start, end);

let pass = 0, fail = 0;
function t(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`  FAIL: ${label}\n    expected ${e}\n    got      ${a}`); }
}
function ok(label, cond) { t(label, !!cond, true); }

// Pull the pieces under test out of the page and run them against a fake fetch.
function harness(fetchImpl, hostname) {
  const pieces = [
    src.match(/const runDiag = \{[\s\S]*?\n\};/)[0],
    src.match(/function diagReset\(\)[\s\S]*?\n\}/)[0],
    src.match(/function diagFail\([\s\S]*?\n\}/)[0],
    "let lastFnError = null;",
    src.match(/function fnFail\([\s\S]*?\n\}/)[0],
    src.match(/function fnErrorText\([\s\S]*?\n\}/)[0],
    src.match(/const DIAG_MEANING = \{[\s\S]*?\n\};/)[0],
    src.match(/async function fnCall\(body\) \{[\s\S]*?\n\}/)[0],
    src.match(/async function isEmailApproved\([\s\S]*?\n\}/)[0],
    src.match(/async function saveProfile\([\s\S]*?\n\}/)[0]
  ].join("\n");

  const stubs = `
    const CLIENT_TIMEOUT_MS = 285000;
    const IS_LIVE = ${hostname !== "local"};
    async function resolveEndpoint() { return "/api/ai"; }
    async function getApprovedEmails() { return []; }
    const console = { error(){}, warn(){}, log(){} };
    const localStorage = {
      _d: {},
      getItem(k){ return this._d[k] || null; },
      setItem(k,v){ if (this._failWrites) throw new Error("QuotaExceededError"); this._d[k]=v; }
    };
  `;

  return new Function("fetch", stubs + pieces +
    "\nreturn { fnCall, isEmailApproved, saveProfile, fnErrorText, runDiag, getErr: () => lastFnError, localStorage };"
  )(fetchImpl);
}

const resp = (status, body, isText) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (isText ? body : JSON.stringify(body))
});

console.log("\n── the login lie: infra failure must not read as 'not approved' ──");

(async () => {
  {
    const h = harness(async () => { throw Object.assign(new Error("Failed to fetch"), { name: "TypeError" }); }, "live");
    const r = await h.isEmailApproved("seth@inheritance.vision");
    t("network down returns 'error', not false", r, "error");
    ok("network failure is recorded", h.getErr() !== null);
    t("recorded as NETWORK", h.getErr().reason, "NETWORK");
    ok("real message preserved", h.getErr().detail.includes("Failed to fetch"));
    ok("error text is never empty", h.fnErrorText().length > 0);
  }
  {
    // Platform returns an HTML error page — the classic disguise.
    const h = harness(resp(500, "<html><body>Internal Server Error</body></html>", true), "live");
    const r = await h.isEmailApproved("seth@inheritance.vision");
    t("HTML error page returns 'error', not false", r, "error");
    t("recorded with the HTTP status", h.getErr().reason, "HTTP_500");
    ok("HTML body captured for debugging", h.getErr().detail.includes("Internal Server Error"));
  }
  {
    // Server returns a structured error with a 200 — several paths do this.
    const h = harness(resp(200, { error: { message: "Supabase insert rejected", _diag: "SUPABASE_WRITE" } }), "live");
    const r = await h.isEmailApproved("seth@inheritance.vision");
    t("structured 200 error returns 'error'", r, "error");
    t("server's own _diag code is used", h.getErr().reason, "SUPABASE_WRITE");
    ok("server's own message survives", h.getErr().detail.includes("Supabase insert rejected"));
    ok("error text explains the code", h.fnErrorText().includes("NOT saved"));
  }
  {
    // Malformed success — 200, valid JSON, but no 'approved' field.
    const h = harness(resp(200, { something: "else" }), "live");
    const r = await h.isEmailApproved("seth@inheritance.vision");
    t("malformed success returns 'error'", r, "error");
    t("recorded as BAD_SHAPE", h.getErr().reason, "BAD_SHAPE");
  }
  {
    // A genuine denial must still be a denial, not an error.
    const h = harness(resp(200, { approved: false }), "live");
    t("genuine denial still returns false", await h.isEmailApproved("nobody@example.com"), false);
    t("denial records no error", h.getErr(), null);
  }
  {
    const h = harness(resp(200, { approved: true }), "live");
    t("approval returns true", await h.isEmailApproved("seth@inheritance.vision"), true);
    t("approval records no error", h.getErr(), null);
  }

  console.log("\n── the save lie: a failed write must not report success ──");
  {
    const h = harness(resp(500, { error: { message: "row level security violation", _diag: "SUPABASE_WRITE" } }), "live");
    const r = await h.saveProfile("seth@inheritance.vision", { name: "Seth" });
    t("failed save reports ok:false", r.ok, false);
    ok("failed save carries a real reason", r.error && r.error.includes("SUPABASE_WRITE"));
    ok("record still returned for retry", r.record && r.record.name === "Seth");
  }
  {
    const h = harness(async () => { throw new Error("connection reset"); }, "live");
    const r = await h.saveProfile("seth@inheritance.vision", { name: "Seth" });
    t("network failure reports ok:false", r.ok, false);
    ok("network reason surfaces", r.error.includes("connection reset"));
  }
  {
    const h = harness(resp(200, { success: true }), "live");
    const r = await h.saveProfile("seth@inheritance.vision", { name: "Seth" });
    t("successful save reports ok:true", r.ok, true);
    t("successful save has no error", r.error, null);
    ok("email is normalised on the record", r.record.email === "seth@inheritance.vision");
    ok("savedAt is a number", typeof r.record.savedAt === "number");
  }

  console.log("\n── failures accumulate and stay readable ──");
  {
    const h = harness(resp(503, { error: { message: "upstream unavailable" } }), "live");
    for (let i = 0; i < 25; i++) await h.isEmailApproved("a@b.com");
    t("infra log is capped at 20", h.runDiag.infra.length, 20);
    ok("most recent failure retained", h.getErr().reason === "HTTP_503");
  }
  {
    // diagReset runs at the start of every generation. It must NOT erase an
    // infra failure recorded moments earlier at login.
    const h = harness(resp(500, { error: { message: "boom" } }), "live");
    await h.isEmailApproved("a@b.com");
    const before = h.runDiag.infra.length;
    ok("an infra failure was recorded", before > 0);
    const reset = new Function("runDiag", src.match(/function diagReset\(\)[\s\S]*?\n\}/)[0] + "\nreturn diagReset;")(h.runDiag);
    reset();
    t("diagReset preserves infra failures", h.runDiag.infra.length, before);
    t("diagReset still clears card failures", h.runDiag.failures.length, 0);
  }

  console.log("\n── no failure mode is silent ──");
  {
    const modes = [
      ["network",      async () => { throw new Error("x"); }],
      ["http 500",     resp(500, { error: { message: "m" } })],
      ["http 404",     resp(404, "not found", true)],
      ["bad json",     resp(200, "<html>", true)],
      ["empty body",   resp(200, "", true)],
      ["200 w/ error", resp(200, { error: { message: "m" } })]
    ];
    for (const [name, f] of modes) {
      const h = harness(f, "live");
      const r = await h.fnCall({ action: "checkEmail" });
      t(`${name}: fnCall returns null`, r, null);
      ok(`${name}: reason was recorded`, h.getErr() !== null);
      ok(`${name}: action was recorded`, h.getErr().action === "checkEmail");
      ok(`${name}: detail is non-empty`, h.getErr().detail.length > 0);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();

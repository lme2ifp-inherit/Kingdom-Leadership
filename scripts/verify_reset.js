// Boundary tests for api/reset-request.js and api/reset-confirm.js.
// Run: node verify_reset.js
//
// Two properties matter more than the rest and most of this file exists to
// hold them still:
//
//   1. reset-request answers IDENTICALLY whether or not the account exists.
//      The moment those two replies differ, the endpoint becomes a way to
//      find out who has an account.
//   2. reset-confirm sends the RECOVERY SESSION, not the service key, when
//      it writes the new password. The service key would scope the write to
//      every account instead of the one the emailed link belongs to.
//
// Lives in scripts/ alongside verify_library.js. Vercel does not build or
// serve this directory, so a test file here ships nothing and costs nothing.
// It must never move into api/ -- everything in api/ becomes a public
// endpoint, and a test harness is not one.

const path = require("path");

// Resolved via __dirname, not a bare relative path, so the suite works from
// scripts/ no matter what the working directory is when it is invoked. A
// plain "./reset-request.js" only works when the test sits beside the
// endpoints -- that assumption broke verify_library.js once already.
const API = path.join(__dirname, "..", "api");
const requestHandler = require(path.join(API, "reset-request.js"));
const confirmHandler = require(path.join(API, "reset-confirm.js"));

let pass = 0, fail = 0;
const results = [];

function mockRes() {
  const r = { statusCode: null, payload: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.payload = p; return r; };
  return r;
}

// Records every outbound call so tests can assert on what was sent, not just
// on what came back.
function recorder(responders) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url: String(url), opts: opts || {} });
    for (const r of responders) {
      if (String(url).indexOf(r.match) !== -1) return r.reply();
    }
    throw new Error("unexpected fetch: " + url);
  };
  fn.calls = calls;
  return fn;
}

function reply(status, bodyObj, text) {
  return () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => (bodyObj === undefined ? {} : bodyObj),
    text: async () => (text !== undefined ? text : JSON.stringify(bodyObj || {})),
  });
}

async function check(name, handler, { method = "POST", body, headers, env, fetchImpl }, expect) {
  const saved = { ...process.env };
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_KEY = "service-key";
  process.env.SITE_URL = "https://kingdom-leadership.vercel.app";
  if (env) for (const k of Object.keys(env)) {
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
  const f = fetchImpl || recorder([]);
  global.fetch = f;

  const res = mockRes();
  await handler({ method, body, headers: headers || {} }, res);
  process.env = saved;

  const problems = [];
  if (expect.status !== undefined && res.statusCode !== expect.status) {
    problems.push("status " + res.statusCode + " expected " + expect.status);
  }
  if (res.headers["cache-control"] !== "no-store, max-age=0") {
    problems.push("missing no-store header");
  }
  if (expect.check) {
    const e = expect.check(res.payload, f.calls || []);
    if (e) problems.push(e);
  }

  if (problems.length) { fail++; results.push("FAIL  " + name + " -- " + problems.join("; ")); }
  else { pass++; results.push("ok    " + name); }
}

// The exact wording does not matter; that both paths produce the SAME
// wording does. Captured once and compared everywhere.
let GENERIC_SEEN = null;

(async () => {

  // =========================================================================
  console.log("\n-- reset-request: method and configuration --");
  // =========================================================================

  await check("GET is rejected", requestHandler,
    { method: "GET" }, { status: 405 });

  await check("PUT is rejected", requestHandler,
    { method: "PUT" }, { status: 405 });

  await check("missing SUPABASE_URL fails closed, does not claim mail was sent", requestHandler,
    { body: { email: "a@b.com" }, env: { SUPABASE_URL: undefined } },
    { status: 500, check: (p) => (p && p.ok === false) ? null : "did not fail closed" });

  await check("missing SUPABASE_SERVICE_KEY fails closed", requestHandler,
    { body: { email: "a@b.com" }, env: { SUPABASE_SERVICE_KEY: undefined } },
    { status: 500, check: (p) => (p && p.ok === false) ? null : "did not fail closed" });

  // =========================================================================
  console.log("\n-- reset-request: the reply must not reveal who has an account --");
  // =========================================================================

  await check("known address -> generic reply", requestHandler,
    {
      body: { email: "real@church.org" },
      fetchImpl: recorder([{ match: "/auth/v1/recover", reply: reply(200, {}) }]),
    },
    {
      status: 200,
      check: (p) => {
        if (!p || p.ok !== true || typeof p.message !== "string") return "no generic message";
        GENERIC_SEEN = p.message;
        return null;
      },
    });

  await check("UNKNOWN address -> byte-identical reply", requestHandler,
    {
      body: { email: "nobody@nowhere.example" },
      fetchImpl: recorder([
        // Supabase refuses an unknown address on some configurations. The
        // endpoint must not let that difference reach the caller.
        { match: "/auth/v1/recover", reply: reply(400, { msg: "User not found" }, '{"msg":"User not found"}') },
      ]),
    },
    {
      status: 200,
      check: (p) => {
        if (!p || p.ok !== true) return "unknown address answered differently";
        if (p.message !== GENERIC_SEEN) return "MESSAGE DIFFERS FROM KNOWN-ADDRESS REPLY -- enumeration leak";
        return null;
      },
    });

  await check("Supabase 500 -> still the same generic reply", requestHandler,
    {
      body: { email: "real@church.org" },
      fetchImpl: recorder([{ match: "/auth/v1/recover", reply: reply(500, {}, "boom") }]),
    },
    {
      status: 200,
      check: (p) => (p && p.message === GENERIC_SEEN) ? null : "reply diverged on upstream 500",
    });

  await check("empty email -> generic reply, no upstream call", requestHandler,
    { body: { email: "   " } },
    {
      status: 200,
      check: (p, calls) => {
        if (!p || p.message !== GENERIC_SEEN) return "reply diverged on empty input";
        if (calls.length !== 0) return "called Supabase for an empty address";
        return null;
      },
    });

  await check("malformed email -> generic reply", requestHandler,
    { body: { email: "not-an-address" } },
    { status: 200, check: (p) => (p && p.message === GENERIC_SEEN) ? null : "reply diverged on malformed input" });

  await check("object with a helpful toString() is not a string", requestHandler,
    { body: { email: { toString: () => "real@church.org" } } },
    {
      status: 200,
      check: (p, calls) => {
        if (calls.length !== 0) return "coerced an object into an email";
        return (p && p.message === GENERIC_SEEN) ? null : "reply diverged";
      },
    });

  await check("missing body entirely", requestHandler,
    { body: undefined },
    { status: 200, check: (p) => (p && p.ok === true) ? null : "threw or diverged on empty body" });

  await check("string body is parsed", requestHandler,
    {
      body: JSON.stringify({ email: "real@church.org" }),
      fetchImpl: recorder([{ match: "/auth/v1/recover", reply: reply(200, {}) }]),
    },
    { status: 200, check: (p, calls) => calls.length === 1 ? null : "did not parse a string body" });

  // =========================================================================
  console.log("\n-- reset-request: silent failure is the thing to avoid --");
  // =========================================================================

  await check("rate limited -> says so, does NOT claim mail was sent", requestHandler,
    {
      body: { email: "real@church.org" },
      fetchImpl: recorder([{ match: "/auth/v1/recover", reply: reply(429, {}, "rate limited") }]),
    },
    {
      status: 429,
      check: (p) => {
        if (!p || p.ok !== false) return "reported success while rate limited";
        if (p.message === GENERIC_SEEN) return "told the user to check email when nothing was sent";
        return null;
      },
    });

  await check("Supabase unreachable -> 503, not a false success", requestHandler,
    {
      body: { email: "real@church.org" },
      fetchImpl: (async () => { throw new Error("network down"); }),
    },
    { status: 503, check: (p) => (p && p.ok === false) ? null : "claimed success while unreachable" });

  await check("redirect_to points at the reset page", requestHandler,
    {
      body: { email: "real@church.org" },
      fetchImpl: recorder([{ match: "/auth/v1/recover", reply: reply(200, {}) }]),
    },
    {
      status: 200,
      check: (p, calls) => {
        if (!calls.length) return "no upstream call";
        return calls[0].url.indexOf("reset.html") !== -1 ? null : "redirect_to missing reset.html";
      },
    });

  await check("falls back to request host when SITE_URL is unset", requestHandler,
    {
      body: { email: "real@church.org" },
      headers: { host: "preview-abc.vercel.app" },
      env: { SITE_URL: undefined },
      fetchImpl: recorder([{ match: "/auth/v1/recover", reply: reply(200, {}) }]),
    },
    {
      status: 200,
      check: (p, calls) =>
        calls[0].url.indexOf("preview-abc.vercel.app") !== -1 ? null : "did not fall back to host header",
    });

  // =========================================================================
  console.log("\n-- reset-confirm: method, configuration, input --");
  // =========================================================================

  await check("GET is rejected", confirmHandler, { method: "GET" }, { status: 405 });

  await check("missing env fails closed", confirmHandler,
    { body: { token_hash: "t", password: "abcdefgh" }, env: { SUPABASE_URL: undefined } },
    { status: 500 });

  await check("no token at all -> 400", confirmHandler,
    { body: { password: "abcdefgh" } },
    { status: 400, check: (p, calls) => calls.length === 0 ? null : "called upstream with no token" });

  await check("short password refused before any upstream call", confirmHandler,
    { body: { token_hash: "t", password: "abc" } },
    { status: 400, check: (p, calls) => calls.length === 0 ? null : "called upstream on a bad password" });

  await check("password over 72 bytes refused", confirmHandler,
    { body: { token_hash: "t", password: "x".repeat(73) } },
    { status: 400, check: (p, calls) => calls.length === 0 ? null : "accepted an over-length password" });

  await check("exactly 8 characters is accepted", confirmHandler,
    {
      body: { token_hash: "t", password: "12345678" },
      fetchImpl: recorder([
        { match: "/auth/v1/verify", reply: reply(200, { access_token: "sess" }) },
        { match: "/auth/v1/user", reply: reply(200, {}) },
      ]),
    },
    { status: 200 });

  await check("non-string password refused", confirmHandler,
    { body: { token_hash: "t", password: { toString: () => "abcdefghij" } } },
    { status: 400, check: (p, calls) => calls.length === 0 ? null : "coerced a non-string password" });

  await check("non-string token refused", confirmHandler,
    { body: { token_hash: { toString: () => "t" }, password: "abcdefgh" } },
    { status: 400 });

  // =========================================================================
  console.log("\n-- reset-confirm: token handling --");
  // =========================================================================

  await check("token_hash is exchanged at /verify first", confirmHandler,
    {
      body: { token_hash: "hash123", password: "abcdefgh" },
      fetchImpl: recorder([
        { match: "/auth/v1/verify", reply: reply(200, { access_token: "sess" }) },
        { match: "/auth/v1/user", reply: reply(200, {}) },
      ]),
    },
    {
      status: 200,
      check: (p, calls) => {
        if (calls.length !== 2) return "expected verify then update, saw " + calls.length + " calls";
        if (calls[0].url.indexOf("/auth/v1/verify") === -1) return "did not exchange the token first";
        const sent = JSON.parse(calls[0].opts.body || "{}");
        if (sent.type !== "recovery") return "wrong verify type: " + sent.type;
        if (sent.token_hash !== "hash123") return "token not passed through";
        return null;
      },
    });

  await check("access_token skips the exchange", confirmHandler,
    {
      body: { access_token: "sess-direct", password: "abcdefgh" },
      fetchImpl: recorder([{ match: "/auth/v1/user", reply: reply(200, {}) }]),
    },
    {
      status: 200,
      check: (p, calls) => {
        if (calls.length !== 1) return "expected one call, saw " + calls.length;
        if (calls[0].url.indexOf("/auth/v1/verify") !== -1) return "exchanged a token that was already a session";
        return null;
      },
    });

  await check("expired or spent token -> 400, no password write attempted", confirmHandler,
    {
      body: { token_hash: "old", password: "abcdefgh" },
      fetchImpl: recorder([
        { match: "/auth/v1/verify", reply: reply(401, { error: "expired" }) },
        { match: "/auth/v1/user", reply: reply(200, {}) },
      ]),
    },
    {
      status: 400,
      check: (p, calls) => {
        const wrote = calls.some((c) => c.url.indexOf("/auth/v1/user") !== -1);
        return wrote ? "WROTE A PASSWORD ON A REJECTED TOKEN" : null;
      },
    });

  await check("verify returning no access_token -> 400", confirmHandler,
    {
      body: { token_hash: "t", password: "abcdefgh" },
      fetchImpl: recorder([{ match: "/auth/v1/verify", reply: reply(200, { user: {} }) }]),
    },
    { status: 400 });

  await check("verify unreachable -> 503, not 400", confirmHandler,
    {
      body: { token_hash: "t", password: "abcdefgh" },
      fetchImpl: (async () => { throw new Error("down"); }),
    },
    { status: 503 });

  // =========================================================================
  console.log("\n-- reset-confirm: the write is scoped to one account --");
  // =========================================================================

  await check("password write carries the RECOVERY SESSION, not the service key", confirmHandler,
    {
      body: { token_hash: "t", password: "abcdefgh" },
      fetchImpl: recorder([
        { match: "/auth/v1/verify", reply: reply(200, { access_token: "recovery-session-token" }) },
        { match: "/auth/v1/user", reply: reply(200, {}) },
      ]),
    },
    {
      status: 200,
      check: (p, calls) => {
        const put = calls.find((c) => c.url.indexOf("/auth/v1/user") !== -1);
        if (!put) return "no password write";
        if (put.opts.method !== "PUT") return "wrong method: " + put.opts.method;
        const auth = (put.opts.headers || {}).Authorization || "";
        if (auth.indexOf("service-key") !== -1) {
          return "AUTHORIZATION USED THE SERVICE KEY -- write is not scoped to one account";
        }
        if (auth !== "Bearer recovery-session-token") return "wrong Authorization: " + auth;
        return null;
      },
    });

  await check("new password is what gets sent upstream", confirmHandler,
    {
      body: { access_token: "sess", password: "correcthorse" },
      fetchImpl: recorder([{ match: "/auth/v1/user", reply: reply(200, {}) }]),
    },
    {
      status: 200,
      check: (p, calls) => {
        const sent = JSON.parse(calls[0].opts.body || "{}");
        return sent.password === "correcthorse" ? null : "password not passed through";
      },
    });

  await check("rejected write (401) -> 400 bad link", confirmHandler,
    {
      body: { access_token: "stale", password: "abcdefgh" },
      fetchImpl: recorder([{ match: "/auth/v1/user", reply: reply(401, {}, "unauthorized") }]),
    },
    { status: 400 });

  await check("same-as-current password -> a message the user can act on", confirmHandler,
    {
      body: { access_token: "sess", password: "abcdefgh" },
      fetchImpl: recorder([
        { match: "/auth/v1/user", reply: reply(422, {}, '{"msg":"New password should be different from the old password."}') },
      ]),
    },
    {
      status: 400,
      check: (p) => (p && /different/i.test(p.error || "")) ? null : "unhelpful message on a reused password",
    });

  await check("write unreachable -> 503", confirmHandler,
    {
      body: { access_token: "sess", password: "abcdefgh" },
      fetchImpl: recorder([
        { match: "/auth/v1/user", reply: () => { throw new Error("down"); } },
      ]),
    },
    { status: 503 });

  // =========================================================================
  console.log("\n-- reset-confirm: nothing sensitive comes back --");
  // =========================================================================

  await check("success returns no token, session or password", confirmHandler,
    {
      body: { access_token: "sess-secret", password: "hunter2hunter2" },
      fetchImpl: recorder([{ match: "/auth/v1/user", reply: reply(200, { user: { id: "u1" } }) }]),
    },
    {
      status: 200,
      check: (p) => {
        const s = JSON.stringify(p || {});
        if (s.indexOf("sess-secret") !== -1) return "SESSION TOKEN ECHOED BACK";
        if (s.indexOf("hunter2") !== -1) return "PASSWORD ECHOED BACK";
        if (s.indexOf("access_token") !== -1) return "access_token present in response";
        return null;
      },
    });

  await check("failure returns nothing sensitive either", confirmHandler,
    {
      body: { token_hash: "hash-secret", password: "hunter2hunter2" },
      fetchImpl: recorder([{ match: "/auth/v1/verify", reply: reply(401, {}) }]),
    },
    {
      status: 400,
      check: (p) => {
        const s = JSON.stringify(p || {});
        if (s.indexOf("hash-secret") !== -1) return "TOKEN ECHOED BACK";
        if (s.indexOf("hunter2") !== -1) return "PASSWORD ECHOED BACK";
        return null;
      },
    });

  console.log("");
  results.forEach((r) => console.log("  " + r));
  console.log("\n" + pass + " passed, " + fail + " failed");
  if (fail) process.exit(1);
})();

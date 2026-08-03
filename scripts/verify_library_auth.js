// Boundary tests for api/library.js Stage 2 auth.
// Run: node verify_library_auth.js
// Every failure path must return no library content. That is the point.

const handler = require("../api/library.js");

let pass = 0, fail = 0;
const results = [];

function mockRes() {
  const r = { statusCode: null, payload: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.payload = p; return r; };
  return r;
}

function leaks(payload) {
  const s = JSON.stringify(payload || {});
  // Markers that appear ONLY in real library data. Note "recognize" is
  // unusable here: the words "not recognized" are in the auth error message,
  // which would flag every correct refusal as a leak.
  return s.includes("essence") || s.includes('"blends"') || s.includes("Pastor/Shepherd");
}

async function check(name, { method = "POST", body, env, fetchImpl }, expect) {
  const saved = { ...process.env };
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_KEY = "service-key";
  if (env) for (const k of Object.keys(env)) {
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
  global.fetch = fetchImpl || (async () => { throw new Error("fetch not expected"); });

  const res = mockRes();
  await handler({ method, body }, res);
  process.env = saved;

  const problems = [];
  if (res.statusCode !== expect.status) {
    problems.push("status " + res.statusCode + " expected " + expect.status);
  }
  if (expect.library === false && leaks(res.payload)) {
    problems.push("LIBRARY CONTENT LEAKED");
  }
  if (expect.library === true && !leaks(res.payload)) {
    problems.push("library missing from success response");
  }
  if (res.headers["cache-control"] !== "no-store, max-age=0") {
    problems.push("missing no-store header");
  }
  if (expect.check) {
    const e = expect.check(res.payload);
    if (e) problems.push(e);
  }

  if (problems.length) { fail++; results.push("FAIL  " + name + " -- " + problems.join("; ")); }
  else { pass++; results.push("ok    " + name); }
}

const okAuth = async (url) => {
  if (String(url).includes("/auth/v1/token")) {
    return { ok: true, json: async () => ({ user: { id: "user-123" } }) };
  }
  return { ok: true, json: async () => ([
    { role: "facilitator", campus_id: "shawnee", status: "active",
      display_name: "Test Person", email: "t@example.com" }
  ]) };
};

(async () => {
  await check("GET is rejected", { method: "GET" }, { status: 405, library: false });

  await check("missing env fails closed", {
    body: { email: "a@b.com", password: "x" },
    env: { SUPABASE_SERVICE_KEY: undefined },
  }, { status: 500, library: false });

  await check("no credentials", { body: {} }, { status: 401, library: false });
  await check("email only", { body: { email: "a@b.com" } }, { status: 401, library: false });
  await check("password only", { body: { password: "x" } }, { status: 401, library: false });
  await check("empty strings", { body: { email: "", password: "" } }, { status: 401, library: false });

  for (const [label, value] of [
    ["null", null], ["number", 0], ["boolean", true],
    ["object", {}], ["array", []],
  ]) {
    await check("non-string password: " + label,
      { body: { email: "a@b.com", password: value } },
      { status: 401, library: false });
    await check("non-string email: " + label,
      { body: { email: value, password: "x" } },
      { status: 401, library: false });
  }

  await check("object with toString is not a string", {
    body: {
      email: "a@b.com",
      password: { toString: () => "the-real-password" },
    },
  }, { status: 401, library: false });

  await check("wrong credentials rejected by Supabase", {
    body: { email: "a@b.com", password: "wrong" },
    fetchImpl: async () => ({ ok: false, json: async () => ({ error: "Invalid login credentials" }) }),
  }, {
    status: 401, library: false,
    check: (p) => /invalid login|not confirmed/i.test(JSON.stringify(p))
      ? "leaked Supabase's specific reason" : null,
  });

  await check("auth ok but no facilitators row", {
    body: { email: "participant@b.com", password: "x" },
    fetchImpl: async (url) => String(url).includes("/auth/v1/token")
      ? { ok: true, json: async () => ({ user: { id: "user-123" } }) }
      : { ok: true, json: async () => ([]) },
  }, { status: 403, library: false });

  await check("disabled facilitator", {
    body: { email: "old@b.com", password: "x" },
    fetchImpl: async (url) => String(url).includes("/auth/v1/token")
      ? { ok: true, json: async () => ({ user: { id: "user-123" } }) }
      : { ok: true, json: async () => ([{ role: "facilitator", campus_id: "shawnee",
          status: "disabled", display_name: "Old", email: "old@b.com" }]) },
  }, { status: 403, library: false });

  // --- The paths that used to masquerade as 403 ----------------------------
  // A permission error on the facilitators table is NOT a refusal of access.
  // This is the exact failure that cost a session on August 2, 2026.
  await check("lookup denied by Postgres is 503, not 403", {
    body: { email: "admin@b.com", password: "x" },
    fetchImpl: async (url) => String(url).includes("/auth/v1/token")
      ? { ok: true, json: async () => ({ user: { id: "user-123" } }) }
      : { ok: false, status: 401, text: async () => "permission denied for table facilitators",
          json: async () => ({ message: "permission denied for table facilitators" }) },
  }, {
    status: 503, library: false,
    check: (p) => p.diag === "lookup-401" ? null : "missing or wrong diag code",
  });

  await check("lookup 404 (table not exposed) is 503", {
    body: { email: "admin@b.com", password: "x" },
    fetchImpl: async (url) => String(url).includes("/auth/v1/token")
      ? { ok: true, json: async () => ({ user: { id: "user-123" } }) }
      : { ok: false, status: 404, text: async () => "relation does not exist",
          json: async () => ({}) },
  }, {
    status: 503, library: false,
    check: (p) => p.diag === "lookup-404" ? null : "missing or wrong diag code",
  });

  await check("lookup returning a non-array is 503", {
    body: { email: "admin@b.com", password: "x" },
    fetchImpl: async (url) => String(url).includes("/auth/v1/token")
      ? { ok: true, json: async () => ({ user: { id: "user-123" } }) }
      : { ok: true, json: async () => ({ message: "not an array" }) },
  }, {
    status: 503, library: false,
    check: (p) => p.diag === "lookup-shape" ? null : "missing or wrong diag code",
  });

  await check("lookup throwing is 503 and says so", {
    body: { email: "admin@b.com", password: "x" },
    fetchImpl: async (url) => {
      if (String(url).includes("/auth/v1/token")) {
        return { ok: true, json: async () => ({ user: { id: "user-123" } }) };
      }
      throw new Error("socket hang up");
    },
  }, {
    status: 503, library: false,
    check: (p) => p.diag === "lookup-unreachable" ? null : "missing or wrong diag code",
  });

  await check("503 diagnostics never expose backend detail", {
    body: { email: "admin@b.com", password: "x" },
    fetchImpl: async (url) => String(url).includes("/auth/v1/token")
      ? { ok: true, json: async () => ({ user: { id: "user-123" } }) }
      : { ok: false, status: 401,
          text: async () => "permission denied for table facilitators",
          json: async () => ({}) },
  }, {
    status: 503, library: false,
    check: (p) => /permission denied|facilitators|service-key|supabase/i.test(JSON.stringify(p))
      ? "backend detail leaked to the browser" : null,
  });

  await check("auth service unreachable", {
    body: { email: "a@b.com", password: "x" },
    fetchImpl: async () => { throw new Error("network down"); },
  }, { status: 503, library: false });

  await check("valid facilitator gets the library", {
    body: { email: "t@example.com", password: "right" },
    fetchImpl: okAuth,
  }, {
    status: 200, library: true,
    check: (p) => p.role === "facilitator" && p.campusId === "shawnee"
      ? null : "role or campus missing from success response",
  });

  await check("admin gets null campus, not blocked", {
    body: { email: "lme2ifp@gmail.com", password: "right" },
    fetchImpl: async (url) => String(url).includes("/auth/v1/token")
      ? { ok: true, json: async () => ({ user: { id: "admin-1" } }) }
      : { ok: true, json: async () => ([{ role: "admin", campus_id: null,
          status: "active", display_name: "Seth", email: "lme2ifp@gmail.com" }]) },
  }, {
    status: 200, library: true,
    check: (p) => p.role === "admin" && p.campusId === null
      ? null : "admin response wrong",
  });

  await check("email is normalized before lookup", {
    body: { email: "  T@Example.COM  ", password: "right" },
    fetchImpl: async (url, opts) => {
      if (String(url).includes("/auth/v1/token")) {
        const sent = JSON.parse(opts.body);
        if (sent.email !== "t@example.com") {
          return { ok: false, json: async () => ({ error: "not normalized" }) };
        }
        return { ok: true, json: async () => ({ user: { id: "user-123" } }) };
      }
      return { ok: true, json: async () => ([{ role: "facilitator", campus_id: "shawnee",
        status: "active", display_name: "T", email: "t@example.com" }]) };
    },
  }, { status: 200, library: true });

  console.log(results.join("\n"));
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();

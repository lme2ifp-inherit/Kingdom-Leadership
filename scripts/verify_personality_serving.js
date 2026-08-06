// verify_personality_serving.js -- checks that library two actually reaches a
// signed-in facilitator, and reaches nobody else.
// Run from the repo root:  node scripts/verify_personality_serving.js
//
// The two library scripts verify the FILES. verify_library_auth.js verifies the
// GATES. Neither of them notices the failure this script exists to catch: a
// complete, correct library-personality-gifts.json sitting in lib/ that the
// endpoint never sends and the page never shows. That failure is silent from
// every direction -- the file verifier passes, the auth harness passes, the
// deploy succeeds, and the second tab is just empty.
//
// It also guards the rule the whole design rests on: library content must not
// be in facilitator.html. If somebody ever "simplifies" the page by importing
// the JSON, view-source hands every participant every answer. That check is
// last in this file and it is the one that matters most.

const fs = require("fs");
const path = require("path");

const handler = require(path.join(__dirname, "..", "api", "library.js"));
const HTML = path.join(__dirname, "..", "facilitator.html");
const LIB2_PATH = path.join(__dirname, "..", "lib", "library-personality-gifts.json");

let pass = 0, fail = 0;
const out = [];
const ok = (m) => { pass++; out.push("  ok    " + m); };
const bad = (m) => { fail++; out.push("  FAIL  " + m); };

function mockRes() {
  const r = { statusCode: null, payload: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.payload = p; return r; };
  return r;
}

// A marker that appears in library two and NOWHERE else -- not in library one,
// not in any error string. Descriptor names are the safest choice: library one
// is keyed on CliftonStrengths themes, which share no names with the 16
// Personalities descriptors.
const LIB2_MARKER = "Rational and Practical";

function hasLib2(payload) {
  return JSON.stringify(payload || {}).includes(LIB2_MARKER);
}

async function call({ method = "POST", body, fetchImpl }) {
  const saved = { ...process.env };
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_KEY = "service-key";
  global.fetch = fetchImpl || (async () => { throw new Error("fetch not expected"); });
  const res = mockRes();
  await handler({ method, body }, res);
  process.env = saved;
  return res;
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

const notAFacilitator = async (url) => {
  if (String(url).includes("/auth/v1/token")) {
    return { ok: true, json: async () => ({ user: { id: "user-123" } }) };
  }
  return { ok: true, json: async () => ([]) };
};

const disabled = async (url) => {
  if (String(url).includes("/auth/v1/token")) {
    return { ok: true, json: async () => ({ user: { id: "user-123" } }) };
  }
  return { ok: true, json: async () => ([
    { role: "facilitator", campus_id: "shawnee", status: "disabled",
      display_name: "Test Person", email: "t@example.com" }
  ]) };
};

(async () => {
  const creds = { email: "t@example.com", password: "pw" };

  // -- 1. The happy path actually carries library two ------------------------
  const good = await call({ body: creds, fetchImpl: okAuth });
  good.statusCode === 200
    ? ok("signed-in facilitator gets a 200")
    : bad("signed-in facilitator got " + good.statusCode);

  hasLib2(good.payload)
    ? ok("library two is present in the success payload")
    : bad("LIBRARY TWO MISSING from the success payload -- the file is in lib/ " +
          "but api/library.js is not sending it");

  const p = good.payload || {};
  p.items2 && p.items2.descriptors
    ? ok("items2.descriptors present")
    : bad("items2.descriptors missing");
  p.items2 && p.items2.gifts
    ? ok("items2.gifts present")
    : bad("items2.gifts missing");

  const n2 = p.blends2 ? Object.keys(p.blends2).length : 0;
  const onDisk = Object.keys(JSON.parse(fs.readFileSync(LIB2_PATH, "utf8")).blends).length;
  n2 === onDisk
    ? ok(`blends2 carries all ${n2} cells from disk`)
    : bad(`blends2 carries ${n2} cells but the file on disk holds ${onDisk}`);

  // -- 2. Library one is untouched by the addition ---------------------------
  //
  // The whole point of the additive shape. If a future edit renames these,
  // every existing caller breaks quietly and this is where it surfaces.
  p.items && p.items.strengths
    ? ok("items.strengths still present -- library one shape unchanged")
    : bad("items.strengths MISSING -- library one's shape was broken by the change");
  p.blends && Object.keys(p.blends).length > 0
    ? ok(`blends still present (${Object.keys(p.blends).length} cells)`)
    : bad("blends MISSING -- library one's shape was broken by the change");

  // -- 3. Every refusal path carries no library two --------------------------
  const refusals = [
    ["GET is rejected", { method: "GET" }],
    ["no credentials", { body: {} }],
    ["email only", { body: { email: "t@example.com" } }],
    ["password only", { body: { password: "pw" } }],
    ["non-string credentials", { body: { email: {}, password: [] } }],
    ["auth rejects the password", { body: creds, fetchImpl: async () => ({
      ok: false, json: async () => ({ error: "bad" }) }) }],
    ["valid account, not a facilitator", { body: creds, fetchImpl: notAFacilitator }],
    ["facilitator account disabled", { body: creds, fetchImpl: disabled }],
    ["lookup unreachable", { body: creds, fetchImpl: async (url) => {
      if (String(url).includes("/auth/v1/token")) {
        return { ok: true, json: async () => ({ user: { id: "user-123" } }) };
      }
      throw new Error("network down");
    } }],
  ];

  for (const [name, args] of refusals) {
    const r = await call(args);
    if (r.statusCode === 200) {
      bad(name + " -- returned 200, it should have refused");
    } else if (hasLib2(r.payload)) {
      bad(name + " -- LIBRARY TWO LEAKED on a refusal path");
    } else {
      ok(name + " -- refused, no library two (" + r.statusCode + ")");
    }
  }

  // -- 4. The page is wired for the second library ---------------------------
  let html = "";
  try {
    html = fs.readFileSync(HTML, "utf8");
    ok("facilitator.html readable");
  } catch (e) {
    bad("facilitator.html not found at repo root: " + e.message);
  }

  const wiring = [
    ["reads items2 from the response", /d\.items2/],
    ["reads blends2 from the response", /d\.blends2/],
    ["has a descriptors picker", /picker\("descriptors"/],
    ["has a personality card renderer", /function cell2\(/],
    ["tabs are clickable", /data-tab/],
    ["sign-out clears library two", /LIB2 = null/],
  ];
  for (const [name, re] of wiring) {
    re.test(html) ? ok("page " + name) : bad("page does NOT " + name);
  }

  // -- 5. THE RULE. No library content is baked into the page ----------------
  //
  // Last, loudest, and the only check here that is about a security property
  // rather than a feature working. A single blend key or descriptor name in
  // the HTML means the library shipped to the browser unauthenticated.
  const bakedIn = [
    ["a library two descriptor name", LIB2_MARKER],
    ["a blend key", "|Pastor/Shepherd"],
    ["an item word block", '"essence":'],
    ["a JSON import of library two", "library-personality-gifts.json"],
  ];
  let baked = 0;
  for (const [what, needle] of bakedIn) {
    if (html.includes(needle)) { bad("PAGE CONTAINS " + what + " -- library content is in the HTML"); baked++; }
  }
  if (!baked) ok("no library content anywhere in facilitator.html");

  console.log("\n" + out.join("\n"));
  console.log("\n" + (pass + fail) + " checks, " +
    (fail ? "FAILED -- " + fail + " error(s)" : "PASS") + "\n");
  process.exit(fail ? 1 : 0);
})();

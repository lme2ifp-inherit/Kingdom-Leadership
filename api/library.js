// ===========================================================================
// FACILITATOR TEACHING LIBRARY -- api/library.js
// Stage 2: real accounts. August 2, 2026.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE:
// The library is never in the page. facilitator.html ships empty and asks
// this endpoint for the data after the caller proves who they are. If the
// JSON were imported into the HTML instead, view-source would hand any
// participant every answer and the whole exercise would be pointless.
//
// Stage 1 used one shared password in FACILITATOR_PASSWORD. That is gone.
// Access now requires a Supabase Auth account that also has an active row in
// the facilitators table. Two gates, not one: an auth user with no
// facilitators row gets nothing, which means a leaked participant login
// cannot reach the library.
//
// Sign-in happens HERE, not in the browser, so no Supabase key of any kind
// ships to the page. Same pattern as ai.js.
// ===========================================================================

const LIBRARY = require("../lib/library-strengths-gifts.json");

const AUTH_FAIL = "Email or password not recognized.";

function json(res, status, payload) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.status(status).json(payload);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "Use POST." });
    return;
  }

  const baseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!baseUrl || !serviceKey) {
    // Fail closed. A missing env var must never mean "let everyone in".
    json(res, 500, { ok: false, error: "Server not configured." });
    return;
  }

  // Vercel usually parses JSON bodies, but not for every content-type.
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  // Strict typing. An object whose toString() returns something useful is
  // still not a string, and must not be coerced into one.
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) {
    json(res, 401, { ok: false, error: AUTH_FAIL });
    return;
  }

  // -- GATE 1: does Supabase Auth accept these credentials? -----------------
  let userId = null;
  try {
    const r = await fetch(baseUrl + "/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": serviceKey,
      },
      body: JSON.stringify({ email, password }),
    });
    const d = await r.json().catch(() => ({}));
    // Deliberately not surfacing Supabase's own message. "Invalid login
    // credentials" and "Email not confirmed" tell an attacker which
    // addresses exist. One message for every failure.
    if (!r.ok || !d || !d.user || typeof d.user.id !== "string") {
      json(res, 401, { ok: false, error: AUTH_FAIL });
      return;
    }
    userId = d.user.id;
  } catch (e) {
    json(res, 503, { ok: false, error: "Could not reach the sign-in service." });
    return;
  }

  // -- GATE 2: is this user actually a facilitator, and still active? -------
  //
  // "The lookup broke" and "the lookup worked and found nobody" are different
  // problems and must not share a status code. They did once, and it cost a
  // session: a missing service_role SELECT grant on this table looked exactly
  // like a legitimate refusal, so the failure pointed at the wrong suspect.
  //   503 + diag  -> we could not ask the question. Operator problem.
  //   403         -> we asked, and this person has no access. User problem.
  // The diag code is deliberately coarse. Full detail goes to the Vercel log,
  // never to the browser, so a stranger cannot map the backend by poking it.
  let person = null;
  let rows = null;
  try {
    const url = baseUrl
      + "/rest/v1/facilitators"
      + "?select=role,campus_id,status,display_name,email"
      + "&id=eq." + encodeURIComponent(userId)
      + "&limit=1";
    const r = await fetch(url, {
      headers: { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey },
    });

    if (!r.ok) {
      let detail = "";
      try { detail = String(await r.text()).slice(0, 300); } catch (e2) { detail = "(unreadable)"; }
      console.error("library: facilitators lookup failed", r.status, detail);
      json(res, 503, {
        ok: false,
        error: "Could not verify access. Please try again shortly.",
        diag: "lookup-" + r.status,
      });
      return;
    }

    rows = await r.json().catch(() => null);
    if (!Array.isArray(rows)) {
      console.error("library: facilitators lookup returned a non-array body");
      json(res, 503, {
        ok: false,
        error: "Could not verify access. Please try again shortly.",
        diag: "lookup-shape",
      });
      return;
    }
  } catch (e) {
    console.error("library: facilitators lookup threw", e && e.message);
    json(res, 503, {
      ok: false,
      error: "Could not verify access. Please try again shortly.",
      diag: "lookup-unreachable",
    });
    return;
  }

  if (rows.length === 0) {
    // Valid Supabase account, but not a facilitator. Participants have
    // accounts too; this is the line that keeps them out.
    json(res, 403, { ok: false, error: "This account has no facilitator access." });
    return;
  }
  person = rows[0];

  if (person.status !== "active") {
    json(res, 403, { ok: false, error: "This account has been disabled." });
    return;
  }

  // Campus comes back so the page can scope what it shows. Admins have no
  // campus by design -- null here means all 48, not "none".
  json(res, 200, {
    ok: true,
    version: LIBRARY.version,
    role: person.role,
    campusId: person.campus_id,
    displayName: person.display_name || person.email,
    items: LIBRARY.items,
    blends: LIBRARY.blends,
  });
};

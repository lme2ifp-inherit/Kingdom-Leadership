// ===========================================================================
// SHARED FACILITATOR AUTH -- lib/facilitatorAuth.js
// Extracted August 8, 2026, when admin actions moved from a shared
// ADMIN_PASSWORD in api/ai.js into the same facilitator system api/library.js
// already used.
//
// THE RULE THIS FILE EXISTS TO ENFORCE:
// There is exactly one copy of the two-gate check (Supabase Auth, then the
// facilitators table). api/library.js and api/ai.js both call it. A second,
// hand-copied gate is the one that drifts out of sync and becomes the leak --
// this is the same reasoning the payload-size note in api/library.js gives
// for not duplicating gates across endpoints.
//
// TWO ENTRY POINTS, ONE PAIR OF GATES:
//   verifyFacilitatorPassword(email, password) -- used once, at login. Talks
//     to Supabase Auth's password grant directly and returns a session
//     access_token alongside the facilitator record, so the caller never has
//     to ask for the password again.
//   verifyFacilitatorToken(token) -- used on every later admin action. Takes
//     the access_token handed back from login and asks Supabase Auth whose
//     token it is, then runs the same facilitators lookup.
//
// Both return the same shape:
//   { ok: true, userId, role, campusId, displayName, email, accessToken }
//   { ok: false, status, error, diag? }
// so callers do not need to know which path was used to get there.
// ===========================================================================

function envOrFail() {
  const baseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!baseUrl || !serviceKey) {
    // Fail closed. A missing env var must never mean "let everyone in".
    return { ok: false, status: 500, error: "Server not configured." };
  }
  return { ok: true, baseUrl, serviceKey };
}

// -- GATE 2: is this user actually a facilitator, and still active? ---------
//
// "The lookup broke" and "the lookup worked and found nobody" are different
// problems and must not share a status code. They did once, in the library
// endpoint, and it cost a session: a missing service_role SELECT grant on
// this table looked exactly like a legitimate refusal, so the failure
// pointed at the wrong suspect.
//   503 + diag  -> we could not ask the question. Operator problem.
//   403         -> we asked, and this person has no access. User problem.
// The diag code is deliberately coarse. Full detail goes to the Vercel log,
// never to the caller, so a stranger cannot map the backend by poking it.
async function lookupFacilitator(baseUrl, serviceKey, userId) {
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
      console.error("facilitatorAuth: facilitators lookup failed", r.status, detail);
      return { ok: false, status: 503, error: "Could not verify access. Please try again shortly.", diag: "lookup-" + r.status };
    }

    rows = await r.json().catch(() => null);
    if (!Array.isArray(rows)) {
      console.error("facilitatorAuth: facilitators lookup returned a non-array body");
      return { ok: false, status: 503, error: "Could not verify access. Please try again shortly.", diag: "lookup-shape" };
    }
  } catch (e) {
    console.error("facilitatorAuth: facilitators lookup threw", e && e.message);
    return { ok: false, status: 503, error: "Could not verify access. Please try again shortly.", diag: "lookup-unreachable" };
  }

  if (rows.length === 0) {
    // Valid Supabase account, but not a facilitator. Participants have
    // accounts too; this is the line that keeps them out.
    return { ok: false, status: 403, error: "This account has no facilitator access." };
  }
  const person = rows[0];

  if (person.status !== "active") {
    return { ok: false, status: 403, error: "This account has been disabled." };
  }

  return { ok: true, person };
}

// -- Entry point 1: email + password. Used once, at login. ------------------
async function verifyFacilitatorPassword(email, password) {
  const env = envOrFail();
  if (!env.ok) return env;
  const { baseUrl, serviceKey } = env;

  const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const cleanPassword = typeof password === "string" ? password : "";
  if (!cleanEmail || !cleanPassword) {
    return { ok: false, status: 401, error: "Email or password not recognized." };
  }

  let userId = null;
  let accessToken = null;
  try {
    const r = await fetch(baseUrl + "/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": serviceKey },
      body: JSON.stringify({ email: cleanEmail, password: cleanPassword }),
    });
    const d = await r.json().catch(() => ({}));
    // Deliberately not surfacing Supabase's own message. "Invalid login
    // credentials" and "Email not confirmed" tell an attacker which
    // addresses exist. One message for every failure.
    if (!r.ok || !d || !d.user || typeof d.user.id !== "string") {
      return { ok: false, status: 401, error: "Email or password not recognized." };
    }
    userId = d.user.id;
    accessToken = typeof d.access_token === "string" ? d.access_token : null;
  } catch (e) {
    return { ok: false, status: 503, error: "Could not reach the sign-in service." };
  }

  const found = await lookupFacilitator(baseUrl, serviceKey, userId);
  if (!found.ok) return found;

  return {
    ok: true,
    userId,
    accessToken,
    role: found.person.role,
    campusId: found.person.campus_id,
    displayName: found.person.display_name || found.person.email,
    email: found.person.email,
  };
}

// -- Entry point 2: a Supabase access_token from a prior login. -------------
// Used by every admin action after the initial sign-in, so the browser never
// has to hold or resend the password.
async function verifyFacilitatorToken(token) {
  const env = envOrFail();
  if (!env.ok) return env;
  const { baseUrl, serviceKey } = env;

  const cleanToken = typeof token === "string" ? token.trim() : "";
  if (!cleanToken) {
    return { ok: false, status: 401, error: "Not signed in." };
  }

  let userId = null;
  try {
    const r = await fetch(baseUrl + "/auth/v1/user", {
      headers: { "apikey": serviceKey, "Authorization": "Bearer " + cleanToken },
    });
    if (!r.ok) {
      // Expired or invalid token. Same generic message either way -- do not
      // tell a caller which half of "expired" vs "forged" they hit.
      return { ok: false, status: 401, error: "Session expired. Please sign in again." };
    }
    const d = await r.json().catch(() => ({}));
    if (!d || typeof d.id !== "string") {
      return { ok: false, status: 401, error: "Session expired. Please sign in again." };
    }
    userId = d.id;
  } catch (e) {
    return { ok: false, status: 503, error: "Could not reach the sign-in service." };
  }

  const found = await lookupFacilitator(baseUrl, serviceKey, userId);
  if (!found.ok) return found;

  return {
    ok: true,
    userId,
    accessToken: cleanToken,
    role: found.person.role,
    campusId: found.person.campus_id,
    displayName: found.person.display_name || found.person.email,
    email: found.person.email,
  };
}

// -- Convenience: same as verifyFacilitatorToken, but also requires admin. --
// This is the one every admin-only action in api/ai.js calls. Centralizing
// the role check here means "what counts as admin" is defined in exactly one
// place, not re-typed at each call site.
async function requireAdmin(token) {
  const found = await verifyFacilitatorToken(token);
  if (!found.ok) return found;
  if (found.role !== "admin") {
    return { ok: false, status: 403, error: "Admin access required." };
  }
  return found;
}

module.exports = {
  verifyFacilitatorPassword,
  verifyFacilitatorToken,
  requireAdmin,
};

// ===========================================================================
// FACILITATOR / ADMIN SIGN-IN -- api/library.js
// Stage 2: real accounts. August 2, 2026.
// Auth gates extracted to lib/facilitatorAuth.js: August 8, 2026.
// Library payload removed: August 9, 2026 -- see below.
//
// THE ONE RULE THIS FILE STILL EXISTS TO ENFORCE:
// Access requires a Supabase Auth account that also has an active row in the
// facilitators table. Two gates, not one: an auth user with no facilitators
// row gets nothing, which means a leaked participant login cannot reach
// facilitator or admin actions. Both gates live in lib/facilitatorAuth.js so
// api/ai.js can reuse them for admin actions instead of a second,
// hand-copied check.
//
// Sign-in happens HERE, not in the browser, so no Supabase key of any kind
// ships to the page. Same pattern as ai.js.
//
// SESSION TOKEN, ADDED AUGUST 8, 2026:
// The Supabase Auth call already returns an access_token; it used to be
// discarded. It is now passed back to the browser as `sessionToken` so admin
// actions in api/ai.js can be authenticated without the page holding the
// facilitator's password in memory for the length of the session. The
// password itself is still never stored past this one request.
//
// WHY THE LIBRARY IS NO LONGER SENT HERE. August 9, 2026.
// This endpoint used to carry all three libraries -- items and blends for
// each, ~1.49 MB raw -- because facilitator.html needed them to render cards
// client-side after sign-in. That card tool moved to the public
// helpful-hints.html / api/hints.js, which is unauthenticated on purpose: the
// course now runs with the cards as a public resource, not facilitator-only
// material. facilitator.html has nothing left to do with library content --
// it is sign-in plus admin actions only -- so sending it the library on every
// login was pure waste: every admin and facilitator sign-in downloaded 1.5 MB
// they discarded on arrival.
//
// The name of this file and its route (/api/library) are unchanged on
// purpose, to avoid touching facilitator.html's fetch call along with this
// trim. It is a sign-in endpoint now in everything but name.
//
// scripts/verify_library_auth.js was written when a successful response was
// expected to contain library markers. Its three success-case tests were
// updated alongside this file -- see that file's history -- to expect
// `library: false` on success now, the same as every other response from
// this endpoint.
// ===========================================================================

const { verifyFacilitatorPassword } = require("../lib/facilitatorAuth.js");

function json(res, status, payload) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.status(status).json(payload);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "Use POST." });
    return;
  }

  // Vercel usually parses JSON bodies, but not for every content-type.
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const found = await verifyFacilitatorPassword(body.email, body.password);
  if (!found.ok) {
    json(res, found.status, { ok: false, error: found.error, diag: found.diag });
    return;
  }

  // Campus comes back so the page can scope what it shows. Admins have no
  // campus by design -- null here means all 48, not "none".
  json(res, 200, {
    ok: true,
    role: found.role,
    campusId: found.campusId,
    displayName: found.displayName,
    sessionToken: found.accessToken,
  });
};

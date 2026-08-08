// ===========================================================================
// FACILITATOR TEACHING LIBRARY -- api/library.js
// Stage 2: real accounts. August 2, 2026.
// Auth gates extracted to lib/facilitatorAuth.js: August 8, 2026.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE:
// The library is never in the page. facilitator.html ships empty and asks
// this endpoint for the data after the caller proves who they are. If the
// JSON were imported into the HTML instead, view-source would hand any
// participant every answer and the whole exercise would be pointless.
//
// Access requires a Supabase Auth account that also has an active row in the
// facilitators table. Two gates, not one: an auth user with no facilitators
// row gets nothing, which means a leaked participant login cannot reach the
// library. Both gates now live in lib/facilitatorAuth.js so api/ai.js can
// reuse them for admin actions instead of a second, hand-copied check.
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
// ===========================================================================

const LIBRARY = require("../lib/library-strengths-gifts.json");
const LIBRARY2 = require("../lib/library-personality-gifts.json");
const LIBRARY3 = require("../lib/library-strengths-personality.json");
const { verifyFacilitatorPassword } = require("../lib/facilitatorAuth.js");

// TWO LIBRARIES, ONE RESPONSE. August 5, 2026.
//
// Library two (Personality x Gifts, 1,368 cells) ships in the same
// authenticated payload as library one rather than behind a second endpoint.
// One sign-in, one round trip, one place where the auth gates live. A second
// endpoint would mean a second copy of every gate below, and the copy that
// drifts is the one that leaks.
//
// The shape is ADDITIVE on purpose. `items` and `blends` still mean exactly
// what they meant before -- library one and nothing else -- so anything
// already reading this endpoint keeps working. Library two arrives alongside
// as `items2` / `blends2`. Renaming the originals would have been tidier and
// would have silently broken every existing caller, including the auth
// harness.
//
// THREE LIBRARIES NOW. August 7, 2026.
//
// Library three (Strengths x Personality, 2,448 cells) joins the same payload
// as `items3` / `blends3`. Same reasoning as library two: one sign-in, one
// round trip, one copy of the gates. The note below said to revisit the size
// question when a third library arrived, so it was revisited rather than
// assumed.
//
// MEASURED, not estimated:
//   library one    172 KB raw    43 KB gzipped
//   library two    437 KB raw   113 KB gzipped
//   library three  948 KB raw   238 KB gzipped
//   all three    ~1,490 KB raw  ~392 KB gzipped
//
// Vercel's hard limit on a function response body is 4.5 MB, returning
// 413 FUNCTION_PAYLOAD_TOO_LARGE above it. The limit applies to the RAW body,
// not the gzipped one, so 1.49 MB is the number that matters and the headroom
// is roughly 3x. That is comfortable but no longer enormous.
//
// A FOURTH LIBRARY MUST NOT BE ADDED HERE WITHOUT SPLITTING THE ENDPOINT.
// A fourth of library three's size would land near 2.5 MB raw and the margin
// stops being safe. At that point move to per-library endpoints behind a
// shared gate helper, so the gates below exist once and are imported, not
// copied. The copy that drifts is the one that leaks.

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
    version: LIBRARY.version,
    version2: LIBRARY2.version,
    version3: LIBRARY3.version,
    role: found.role,
    campusId: found.campusId,
    displayName: found.displayName,
    sessionToken: found.accessToken,
    items: LIBRARY.items,
    blends: LIBRARY.blends,
    items2: LIBRARY2.items,
    blends2: LIBRARY2.blends,
    items3: LIBRARY3.items,
    blends3: LIBRARY3.blends,
  });
};

// ===========================================================================
// HELPFUL HINTS -- api/hints.js
// Public, unauthenticated library endpoint. August 9, 2026.
//
// WHY THIS FILE EXISTS SEPARATELY FROM api/library.js:
// api/library.js exists to enforce an auth gate. Adding a "public mode" flag
// to it would put the bypass inside the file whose only job is refusing
// callers who have not proved who they are, and a gate with a documented way
// around it is not a gate. This endpoint has no gates at all, so there is
// nothing here to bypass, and api/library.js keeps refusing everyone exactly
// as it did before. The facilitator path is untouched.
//
// WHAT CHANGED IN THE COURSE, AND WHY THAT MAKES THIS SAFE:
// api/library.js carries a rule that the library must never reach the page
// unauthenticated, because view-source would hand a participant every answer
// before the exercise ran. That rule was correct for a facilitator-led course
// where the cards were the facilitator's material and surprise was part of
// the method.
//
// The course no longer runs that way. The cards are now a public resource
// participants are meant to read for themselves, which removes the thing the
// gate was protecting. This is a deliberate reversal of a deliberate
// decision, not an oversight, and it is recorded here so nobody restores the
// gate later thinking they are fixing a leak.
//
// api/library.js keeps its gate regardless. Facilitators still sign in there,
// and the admin panel still lives behind that sign-in.
//
// GET, NOT POST:
// api/library.js is POST because it carries credentials. Nothing is sent
// here, so GET is the honest verb and lets the response be cached.
//
// CACHING:
// api/library.js sets no-store because its payload is per-facilitator and
// carries a session token. This payload is identical for every caller and
// changes only when the library files are redeployed, so it is cached hard at
// the edge. That matters at conference scale: without it every visitor costs
// a function invocation to send the same 1.5 MB.
//
// SIZE -- the constraint inherited from api/library.js:
//   library one    172 KB raw    43 KB gzipped
//   library two    437 KB raw   113 KB gzipped
//   library three  948 KB raw   238 KB gzipped
//   all three    ~1,490 KB raw  ~392 KB gzipped
//
// Vercel returns 413 FUNCTION_PAYLOAD_TOO_LARGE above 4.5 MB RAW, so the raw
// figure is the one that matters and the headroom is roughly 3x. The word
// bank added ~30 KB across the three files, which does not change that.
//
// A FOURTH LIBRARY MUST NOT BE ADDED HERE WITHOUT SPLITTING THE ENDPOINT --
// the same warning api/library.js carries, for the same reason.
// ===========================================================================

const LIBRARY = require("../lib/library-strengths-gifts.json");
const LIBRARY2 = require("../lib/library-personality-gifts.json");
const LIBRARY3 = require("../lib/library-strengths-personality.json");

module.exports = async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.status(405).json({ ok: false, error: "Use GET." });
    return;
  }

  // Cached for an hour at the edge, and served stale for a day after that
  // while a fresh copy is fetched in the background. A deploy invalidates the
  // cache, so a content change never waits an hour to appear -- the stale
  // window only ever covers a cache miss, never a redeploy.
  res.setHeader("Cache-Control",
    "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400");

  if (req.method === "HEAD") { res.status(200).end(); return; }

  // Deliberately the same field names api/library.js uses. helpful-hints.html
  // and facilitator.html render identical cards from identical shapes, so the
  // renderers stay copy-compatible and a fix to one can be applied to the
  // other without translating field names first.
  //
  // Not sent, on purpose: role, campusId, displayName, sessionToken. Those
  // are facts about a signed-in facilitator and there is no facilitator here.
  res.status(200).json({
    ok: true,
    version: LIBRARY.version,
    version2: LIBRARY2.version,
    version3: LIBRARY3.version,
    items: LIBRARY.items,
    blends: LIBRARY.blends,
    items2: LIBRARY2.items,
    blends2: LIBRARY2.blends,
    items3: LIBRARY3.items,
    blends3: LIBRARY3.blends,
  });
};

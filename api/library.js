// ═══════════════════════════════════════════════════════════════════════════
// FACILITATOR TEACHING LIBRARY — api/library.js
// August 2, 2026
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE:
// The library is never in the page. facilitator.html ships empty and asks
// this endpoint for the data after a password check. If the JSON were
// imported into the HTML instead, view-source would hand any participant
// every answer and the whole exercise would be pointless.
//
// Stage 1 access: one shared password in the FACILITATOR_PASSWORD env var.
// Stage 2 swaps this for a Supabase `facilitators` table with a role column.
// The response shape will not change when that happens — only the block
// marked AUTH below gets replaced.
// ═══════════════════════════════════════════════════════════════════════════

// Bundled at build time by the Vercel node builder. This is a static import,
// not a filesystem read, so it works regardless of function bundling rules.
const LIBRARY = require("../lib/library-strengths-gifts.json");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Use POST." });
    return;
  }

  const expected = process.env.FACILITATOR_PASSWORD;
  if (!expected) {
    // Fail closed. A missing env var must never mean "let everyone in".
    res.status(500).json({ ok: false, error: "Server not configured." });
    return;
  }

  // Vercel usually parses JSON bodies, but not for every content-type.
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  // ── AUTH ────────────────────────────────────────────────────────────────
  // Stage 2 replaces this block with a Supabase lookup. Nothing below changes.
  const supplied = typeof body.password === "string" ? body.password : "";
  if (supplied !== expected) {
    res.status(401).json({ ok: false, error: "Not recognized." });
    return;
  }
  // ────────────────────────────────────────────────────────────────────────

  // No caching anywhere. This response is privileged.
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.status(200).json({
    ok: true,
    version: LIBRARY.version,
    items: LIBRARY.items,
    tensions: LIBRARY.tensions,
  });
};

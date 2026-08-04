// ===========================================================================
// PASSWORD RESET, STEP 1 -- api/reset-request.js
// August 3, 2026.
//
// Takes an email address and asks Supabase to send that person a recovery
// link. Same architectural rule as api/library.js: the Supabase call happens
// HERE, on the server, so no Supabase key of any kind ships to the browser.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE:
// The response never reveals whether an account exists. A stranger who POSTs
// a thousand addresses learns nothing from the thousand replies. This is the
// same reasoning behind the single AUTH_FAIL message in library.js -- if a
// wrong address answered differently from a right one, the endpoint would be
// a free membership directory.
//
// Note there is deliberately NO facilitator check here. Resetting a password
// grants nothing on its own; api/library.js still requires an active row in
// the facilitators table before any content moves. Adding a check here would
// only create a second way to probe who is a facilitator.
// ===========================================================================

// Always the same, whatever actually happened.
const GENERIC = "If that address has an account, a reset link is on its way. "
              + "Check your inbox, including spam.";

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
    // Fail closed, and say so plainly. A missing env var must never be
    // reported to the user as "sent" -- they would wait for mail forever.
    console.error("reset-request: missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
    json(res, 500, { ok: false, error: "Server not configured." });
    return;
  }

  // SITE_URL is where the emailed link comes back to. Falls back to the
  // request's own host so a preview deployment still works.
  let site = process.env.SITE_URL || "";
  if (!site) {
    const host = req.headers && req.headers.host;
    if (host) site = "https://" + host;
  }
  const redirectTo = site ? site.replace(/\/+$/, "") + "/reset.html" : "";

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  // Strict typing, same as library.js. An object with a helpful toString()
  // is still not a string.
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  // An empty or malformed address gets the generic answer too. Telling the
  // caller "that is not a valid email" is harmless on its own, but it starts
  // the habit of branching the response, and the branching is the leak.
  if (!email || email.length > 320 || email.indexOf("@") < 1) {
    json(res, 200, { ok: true, message: GENERIC });
    return;
  }

  try {
    const url = baseUrl + "/auth/v1/recover"
      + (redirectTo ? "?redirect_to=" + encodeURIComponent(redirectTo) : "");
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": serviceKey,
        "Authorization": "Bearer " + serviceKey,
      },
      body: JSON.stringify({ email }),
    });

    // 429 is the one case worth surfacing, and it leaks nothing: the built-in
    // Supabase mailer is rate limited PROJECT-WIDE, not per address, so a 429
    // says something about the project's last hour and nothing about whether
    // this particular person has an account.
    //
    // This matters more than it looks. The built-in mailer fails silently --
    // without this branch the page would cheerfully say "check your email"
    // while nothing was ever sent, and the person would sit waiting.
    if (r.status === 429) {
      json(res, 429, {
        ok: false,
        error: "Too many reset requests have been sent recently. "
             + "Please wait a few minutes and try again.",
      });
      return;
    }

    if (!r.ok) {
      // Everything else is logged for the operator and hidden from the
      // caller. An unknown address also lands here on some Supabase
      // configurations, which is exactly why it cannot change the reply.
      let detail = "";
      try { detail = String(await r.text()).slice(0, 300); } catch (e2) { detail = "(unreadable)"; }
      console.error("reset-request: recover failed", r.status, detail);
    }
  } catch (e) {
    // Could not reach Supabase at all. This one is honest, because pretending
    // to have sent mail we could not send is the failure mode we are trying
    // to avoid.
    console.error("reset-request: recover threw", e && e.message);
    json(res, 503, {
      ok: false,
      error: "Could not reach the sign-in service. Please try again shortly.",
    });
    return;
  }

  json(res, 200, { ok: true, message: GENERIC });
};

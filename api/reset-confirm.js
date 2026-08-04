// ===========================================================================
// PASSWORD RESET, STEP 2 -- api/reset-confirm.js
// August 3, 2026.
//
// Takes the token out of the emailed link plus a new password, and sets it.
// Supabase is called from HERE, never from the page, so no Supabase key of
// any kind ships to the browser. Same rule as api/library.js.
//
// WHY THIS ACCEPTS TWO DIFFERENT TOKENS:
// Supabase can deliver a recovery link in two shapes depending on how the
// email template is written in the dashboard:
//
//   token_hash    -- the newer style. Arrives as ?token_hash=... in the URL
//                    query. Must be exchanged at /auth/v1/verify first.
//   access_token  -- the older implicit style. Arrives in the URL fragment
//                    (#access_token=...) already exchanged by Supabase.
//
// Supporting both means the flow works whichever way the template is set,
// instead of failing in a way that looks like broken code when it is really
// a dashboard setting. If the template is ever changed, nothing here breaks.
//
// The token is single-use and short-lived. Once spent, the link is dead --
// which is why the expiry message tells the person to request a new one
// rather than leaving them to guess.
// ===========================================================================

const MIN_PASSWORD = 8;
// bcrypt silently ignores anything past 72 bytes. Refusing here is honest;
// accepting a 200-character password and quietly using the first 72 is not.
const MAX_PASSWORD = 72;

const BAD_LINK = "This reset link has expired or has already been used. "
               + "Please request a new one.";

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
    console.error("reset-confirm: missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
    json(res, 500, { ok: false, error: "Server not configured." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const tokenHash   = typeof body.token_hash   === "string" ? body.token_hash.trim()   : "";
  const accessToken = typeof body.access_token === "string" ? body.access_token.trim() : "";
  const password    = typeof body.password     === "string" ? body.password            : "";

  if (!tokenHash && !accessToken) {
    json(res, 400, { ok: false, error: BAD_LINK });
    return;
  }

  // Password rules are checked here as well as in the page. The page can be
  // bypassed; this cannot.
  if (password.length < MIN_PASSWORD) {
    json(res, 400, {
      ok: false,
      error: "Password must be at least " + MIN_PASSWORD + " characters.",
    });
    return;
  }
  if (password.length > MAX_PASSWORD) {
    json(res, 400, {
      ok: false,
      error: "Password must be " + MAX_PASSWORD + " characters or fewer.",
    });
    return;
  }

  // -- Get a usable session token ------------------------------------------
  let session = accessToken;
  if (!session) {
    try {
      const r = await fetch(baseUrl + "/auth/v1/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": serviceKey,
        },
        body: JSON.stringify({ type: "recovery", token_hash: tokenHash }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d || typeof d.access_token !== "string") {
        // Expired, already spent, or fabricated. All three are the same
        // thing from the user's side and must not be told apart -- a
        // distinct "already used" message would confirm a real link existed.
        console.error("reset-confirm: verify rejected token", r.status);
        json(res, 400, { ok: false, error: BAD_LINK });
        return;
      }
      session = d.access_token;
    } catch (e) {
      console.error("reset-confirm: verify threw", e && e.message);
      json(res, 503, {
        ok: false,
        error: "Could not reach the sign-in service. Please try again shortly.",
      });
      return;
    }
  }

  // -- Set the new password -------------------------------------------------
  //
  // Authorization carries the RECOVERY SESSION, not the service key. That is
  // what scopes this write to the one account the emailed link belongs to.
  // Using the service key here instead would let any valid-looking request
  // rewrite any account, so the two headers are not interchangeable.
  try {
    const r = await fetch(baseUrl + "/auth/v1/user", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "apikey": serviceKey,
        "Authorization": "Bearer " + session,
      },
      body: JSON.stringify({ password }),
    });

    if (!r.ok) {
      let detail = "";
      try { detail = String(await r.text()).slice(0, 300); } catch (e2) { detail = "(unreadable)"; }
      console.error("reset-confirm: password update failed", r.status, detail);

      // Supabase rejects a password identical to the current one, and that
      // refusal is worth passing on -- the person is standing at the form and
      // needs to know why it will not take.
      if (r.status === 422 && detail.indexOf("different from the old") !== -1) {
        json(res, 400, {
          ok: false,
          error: "That is the password you already have. Please choose a different one.",
        });
        return;
      }
      if (r.status === 401 || r.status === 403) {
        json(res, 400, { ok: false, error: BAD_LINK });
        return;
      }
      json(res, 503, {
        ok: false,
        error: "Could not set the new password. Please try again shortly.",
      });
      return;
    }
  } catch (e) {
    console.error("reset-confirm: password update threw", e && e.message);
    json(res, 503, {
      ok: false,
      error: "Could not reach the sign-in service. Please try again shortly.",
    });
    return;
  }

  // No session, no token, no auto sign-in. They go back to the tool and sign
  // in with the new password, which proves it took.
  json(res, 200, {
    ok: true,
    message: "Password updated. You can sign in now.",
  });
};

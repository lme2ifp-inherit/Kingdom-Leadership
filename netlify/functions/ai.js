const https = require("https");

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
exports.handler = async function(event, context) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  // ── BLOBS: initialised inside handler so Netlify context is available ────────
  const { getStore } = require("@netlify/blobs");

  async function blobGet(key) {
    try {
      const store = getStore({ name: "kingdom-leadership", consistency: "strong" });
      const result = await store.get(key, { type: "json" });
      return result !== null ? result : null;
    } catch(e) { return null; }
  }

  async function blobSet(key, value) {
    try {
      const store = getStore({ name: "kingdom-leadership", consistency: "strong" });
      await store.setJSON(key, value);
      return true;
    } catch(e) { return false; }
  }

  const apiKey = process.env.ANTHROPIC_KEY;

  try {
    const body = JSON.parse(event.body);
    const action = body.action || "ai";

    // ── EMAIL STORAGE ACTIONS ──────────────────────────────────────────────────
    if (action === "getEmails") {
      const data = await blobGet("approved_emails");
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ emails: data || [] })
      };
    }

    if (action === "addEmails") {
      const current = await blobGet("approved_emails") || [];
      const newOnes = (body.emails || []).map(e => e.toLowerCase().trim()).filter(e => e.includes("@"));
      const merged = [...new Set([...current, ...newOnes])];
      await blobSet("approved_emails", merged);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ success: true, added: newOnes.length, total: merged.length, emails: merged })
      };
    }

    if (action === "removeEmail") {
      const current = await blobGet("approved_emails") || [];
      const updated = current.filter(e => e !== body.email.toLowerCase().trim());
      await blobSet("approved_emails", updated);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ success: true, emails: updated })
      };
    }

    if (action === "checkEmail") {
      const approved = await blobGet("approved_emails") || [];
      const email = (body.email || "").toLowerCase().trim();
      const isApproved = approved.map(e => e.toLowerCase().trim()).includes(email);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ approved: isApproved })
      };
    }

    if (action === "saveProfile") {
      await blobSet("profile_" + body.email.toLowerCase().trim(), body.profile);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ success: true })
      };
    }

    if (action === "loadProfile") {
      const profile = await blobGet("profile_" + body.email.toLowerCase().trim());
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ profile: profile || null })
      };
    }

    // ── AI GENERATION ──────────────────────────────────────────────────────────
    if (!apiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: { message: "API key not configured" } })
      };
    }

    const payload = JSON.stringify({
      model: body.model || "claude-sonnet-4-5",
      max_tokens: body.max_tokens || 1500,
      system: "You are a faith-based leadership profile writer for a church conference. Respond only in English. Do not use any characters from non-Latin scripts, including but not limited to Chinese, Japanese, Korean, Arabic, or any other non-English writing system. Return pure JSON only with no markdown, preamble, or explanation.",
      messages: body.messages
    });

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Length": Buffer.byteLength(payload)
        }
      };
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", chunk => { data += chunk; });
        res.on("end", () => { resolve(JSON.parse(data)); });
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(result)
    };

  } catch(err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: { message: err.message } })
    };
  }
};

const https = require("https");

// ── NETLIFY BLOBS HELPER ──────────────────────────────────────────────────────
async function blobGet(key) {
  try {
    const siteId = "8b2f683b-313c-4c7d-9972-5c3a1aec465d";
    const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.TOKEN;
    if (!token) return null;
    
    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: "api.netlify.com",
        path: `/api/v1/blobs/${siteId}/production/${encodeURIComponent(key)}`,
        method: "GET",
        headers: {
          "Authorization": `Bearer ${token}`,
        }
      };
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", chunk => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode === 200) resolve(JSON.parse(data));
          else resolve(null);
        });
      });
      req.on("error", () => resolve(null));
      req.end();
    });
    return result;
  } catch(e) { return null; }
}

async function blobSet(key, value) {
  try {
    const siteId = "8b2f683b-313c-4c7d-9972-5c3a1aec465d";
    const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.TOKEN;
    if (!token) return false;
    
    const payload = JSON.stringify(value);
    await new Promise((resolve, reject) => {
      const options = {
        hostname: "api.netlify.com",
        path: `/api/v1/blobs/${siteId}/production/${encodeURIComponent(key)}`,
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      };
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", chunk => { data += chunk; });
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", () => resolve(null));
      req.write(payload);
      req.end();
    });
    return true;
  } catch(e) { return false; }
}

async function blobDelete(key) {
  try {
    const siteId = "8b2f683b-313c-4c7d-9972-5c3a1aec465d";
    const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.TOKEN;
    if (!token) return false;
    await new Promise((resolve) => {
      const options = {
        hostname: "api.netlify.com",
        path: `/api/v1/blobs/${siteId}/production/${encodeURIComponent(key)}`,
        method: "DELETE",
        headers: { "Authorization": `Bearer ${token}` }
      };
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", chunk => { data += chunk; });
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", () => resolve(null));
      req.end();
    });
    return true;
  } catch(e) { return false; }
}

async function blobList(prefix) {
  try {
    const siteId = "8b2f683b-313c-4c7d-9972-5c3a1aec465d";
    const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.TOKEN;
    if (!token) return [];
    const result = await new Promise((resolve) => {
      const path = `/api/v1/blobs/${siteId}/production?prefix=${encodeURIComponent(prefix)}&paginate=true`;
      const options = {
        hostname: "api.netlify.com",
        path,
        method: "GET",
        headers: { "Authorization": `Bearer ${token}` }
      };
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", chunk => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode === 200) {
            try { resolve(JSON.parse(data)); } catch(e) { resolve(null); }
          } else resolve(null);
        });
      });
      req.on("error", () => resolve(null));
      req.end();
    });
    if (!result || !result.blobs) return [];
    return result.blobs.map(b => b.key);
  } catch(e) { return []; }
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
exports.handler = async function(event, context) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
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

    // ── CARD CACHE ACTIONS ────────────────────────────────────────────────────
    if (action === "getCachedCard") {
      // Only cache M1/M2/M3 — never M4
      const key = body.cacheKey || "";
      if (!key.startsWith("cache_m1|") && !key.startsWith("cache_m2|") && !key.startsWith("cache_m3|")) {
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({ card: null })
        };
      }
      const card = await blobGet(key);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ card: card || null })
      };
    }

    if (action === "setCachedCard") {
      const key = body.cacheKey || "";
      if (!key.startsWith("cache_m1|") && !key.startsWith("cache_m2|") && !key.startsWith("cache_m3|")) {
        return {
          statusCode: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({ error: "Invalid cache key" })
        };
      }
      const card = { ...body.card, shadowSide: null, scripture: null, generatedAt: Date.now() };
      await blobSet(key, card);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ success: true })
      };
    }

    if (action === "deleteCachedCard") {
      // Admin only — delete a specific cache entry to force regeneration
      const key = body.cacheKey || "";
      if (!key.startsWith("cache_m1|") && !key.startsWith("cache_m2|") && !key.startsWith("cache_m3|")) {
        return {
          statusCode: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({ error: "Invalid cache key" })
        };
      }
      await blobDelete(key);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ success: true })
      };
    }

    if (action === "listCachedCards") {
      // Admin only — list all cached card keys with counts by matrix
      const keys = await blobList("cache_");
      const m1 = keys.filter(k => k.startsWith("cache_m1|"));
      const m2 = keys.filter(k => k.startsWith("cache_m2|"));
      const m3 = keys.filter(k => k.startsWith("cache_m3|"));
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ keys, counts: { m1: m1.length, m2: m2.length, m3: m3.length, total: keys.length } })
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

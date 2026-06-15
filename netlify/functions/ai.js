const https = require("https");

// ── NETLIFY BLOBS HELPERS ─────────────────────────────────────────────────────
async function blobGet(key) {
  try {
    const siteId = "8b2f683b-313c-4c7d-9972-5c3a1aec465d";
    const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.TOKEN;
    if (!token) return null;
    const result = await new Promise((resolve) => {
      const options = {
        hostname: "api.netlify.com",
        path: `/api/v1/blobs/${siteId}/production/${encodeURIComponent(key)}`,
        method: "GET",
        headers: { "Authorization": `Bearer ${token}` }
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
    await new Promise((resolve) => {
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

// ── AI CALL HELPER ────────────────────────────────────────────────────────────
async function callClaude(prompt, maxTokens) {
  const apiKey = process.env.ANTHROPIC_KEY;
  if (!apiKey) throw new Error("API key not configured");
  const payload = JSON.stringify({
    model: "claude-sonnet-4-5",
    max_tokens: maxTokens || 1500,
    system: "You are a faith-based leadership profile writer for a church conference. Respond only in English. Do not use any characters from non-Latin scripts, including but not limited to Chinese, Japanese, Korean, Arabic, or any other non-English writing system. Return pure JSON only with no markdown, preamble, or explanation.",
    messages: [{ role: "user", content: prompt }]
  });
  return await new Promise((resolve, reject) => {
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
}

// ── SERVER-SIDE PROMPT BUILDERS ───────────────────────────────────────────────
function buildM1Prompt(strength, personality) {
  const pBase = personality.split("-")[0];
  const v = personality.includes("-A") ? "Assertive" : "Turbulent";
  const schema = '{"theme":"3-5 word poetic leadership title","description":"3-4 vivid sentences on how this strength and personality interact and what this person does differently because of this exact combination","gift":"One sentence on the unique gift this combination brings to a team","shadowSide":"2 sentences — first describes the dark side or blind spot of this exact combination when unchecked, second gives a specific growth edge to counteract it. Scoped only to this combination, no personal names","scripture":"One Bible verse reference and brief quote from KJV, NIV, NLT, or NASB1995 — choose whichever translation best fits this combination — then one sentence on why it speaks to this specific pairing. Format: BookChapter:Verse TranslationAbbrev — quote — explanation","prayer":"3 sentence prayer written in first person as if the participant is praying it themselves using I me my Lord You — NOT a prayer spoken over them"}';
  return `Faith-based leadership conference. Matrix 1 Core Traits combining Clifton Strengths and 16 Personalities. This combination is ${strength} strength with ${personality} personality (${pBase} ${v} variant). Return pure JSON only with no markdown or explanation matching this exact shape: ${schema}`;
}

function buildM2Prompt(strength, gift) {
  const schema = '{"theme":"3-5 word poetic title for this talent and gift combination","description":"3-4 vivid sentences on how this natural talent and spiritual gift work together in kingdom ministry","gift":"One sentence on the unique contribution this combination makes to the body of Christ","shadowSide":"2 sentences — first describes the dark side or blind spot of this exact strength-gift combination when unchecked, second gives a specific growth edge to counteract it. Scoped only to this combination, no personal names","scripture":"One Bible verse reference and brief quote from KJV, NIV, NLT, or NASB1995 — choose whichever translation best fits this combination — then one sentence on why it speaks to this specific pairing. Format: BookChapter:Verse TranslationAbbrev — quote — explanation","prayer":"3 sentence prayer written in first person as if the participant is praying it themselves using I me my Lord You — NOT a prayer spoken over them"}';
  return `Faith-based leadership conference. Matrix 2 Empowered Abilities combining Clifton Strengths and Spiritual Gifts. This combination is ${strength} CliftonStrength with ${gift} Spiritual Gift. Return pure JSON only with no markdown or explanation matching this exact shape: ${schema}`;
}

function buildM3Prompt(personality, gift) {
  const pBase = personality.split("-")[0];
  const schema = '{"theme":"3-5 word poetic title for how the Spirit expresses this gift through this personality","description":"3-4 vivid sentences on how the Holy Spirit empowers this spiritual gift uniquely through this personality type","gift":"One sentence on how the Spirit uniquely moves through this personality to exercise this gift","shadowSide":"2 sentences — first describes the dark side or blind spot of this exact personality-gift combination when unchecked, second gives a specific growth edge to counteract it. Scoped only to this combination, no personal names","scripture":"One Bible verse reference and brief quote from KJV, NIV, NLT, or NASB1995 — choose whichever translation best fits this combination — then one sentence on why it speaks to this specific pairing. Format: BookChapter:Verse TranslationAbbrev — quote — explanation","prayer":"3 sentence prayer written in first person as if the participant is praying it themselves using I me my Lord You — NOT a prayer spoken over them"}';
  return `Faith-based leadership conference. Matrix 3 Innate Qualities combining 16 Personalities and Spiritual Gifts. This combination is ${personality} personality (${pBase}) with ${gift} Spiritual Gift. Return pure JSON only with no markdown or explanation matching this exact shape: ${schema}`;
}

function buildM4Prompt(name, strengths, personality, gifts) {
  const sAll = strengths.join(", ");
  const gAll = gifts.join(", ");
  const pBase = personality.split("-")[0];
  const schema = '{"unifiedTheme":"3-6 word poetic title capturing this persons complete God-given leadership identity","description":"4-5 vivid sentences on how all three frameworks work together as one unified expression of Gods design that should feel like a revelation","kingdomRole":"2-3 sentences on the specific irreplaceable role this person is designed to play in Gods kingdom","teamContribution":"2-3 sentences on what this person uniquely brings to any team that no one else can replicate","shadowSide":"2-3 sentences on where this combination can go wrong and the honest growth edge","scripture":"One Bible verse reference and brief quote from KJV, NIV, NLT, or NASB1995 then one sentence on why it speaks to this combination","prayer":"4-5 sentence prayer written in first person as if the participant is praying it themselves using I me my Lord You — NOT a prayer spoken over them"}';
  return `Faith-based leadership conference. Matrix 4 Unified Potential master synthesis for ${name}. Top strengths: ${sAll}. Personality: ${personality} (${pBase}). Spiritual gifts: ${gAll}. Return pure JSON only with no markdown or explanation matching this exact shape: ${schema}`;
}

function buildM4StrCardPrompt(name, strength, personality, gifts) {
  const gAll = gifts.join(", ");
  const pBase = personality.split("-")[0];
  const schema = '{"cardTheme":"3-5 word poetic title for how this strength integrates with this personality and gifts","description":"3-4 vivid sentences on how this specific strength filtered through this personality and activated by these spiritual gifts creates something unique and kingdom-powerful","scripture":"One Bible verse reference and brief quote from KJV, NIV, NLT, or NASB1995 anchoring this strength with these gifts","prayer":"2-3 sentence prayer written in first person as if the participant is praying it themselves using I me my Lord You — NOT a prayer spoken over them"}';
  return `Faith-based leadership conference. Matrix 4 Individual Strength Card for ${name}. Strength: ${strength}. Personality: ${personality} (${pBase}). Spiritual gifts: ${gAll}. Return pure JSON only with no markdown or explanation matching this exact shape: ${schema}`;
}

function buildM4BonusPrompt(name, strengths, personality, gifts) {
  const top3s = strengths.slice(0, 3).join(", ");
  const top3g = gifts.slice(0, 3).join(", ");
  const pBase = personality.split("-")[0];
  const schema = '{"bonusTheme":"3-5 word poetic title","synthesis":"3-4 sentences distilling the essence of this persons kingdom identity","coreCall":"One powerful sentence naming this persons core kingdom calling","blessing":"3-4 sentence spoken blessing written in third person as if a pastor is speaking it over the participant using their name and he/she/they"}';
  return `Faith-based leadership conference. Streamlined Synthesis for ${name}. Top 3 strengths: ${top3s}. Personality: ${personality} (${pBase}). Top spiritual gifts: ${top3g}. Return pure JSON only with no markdown or explanation matching this exact shape: ${schema}`;
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
exports.handler = async function(event, context) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  try {
    const body = JSON.parse(event.body);
    const action = body.action || "ai";

    // ── ADMIN VERIFICATION (server-side — password never in client code) ───────
    if (action === "verifyAdmin") {
      const adminPassword = process.env.ADMIN_PASSWORD;
      if (!adminPassword) {
        return {
          statusCode: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({ error: "Admin not configured" })
        };
      }
      const valid = body.password === adminPassword;
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ valid })
      };
    }

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
      // Preserve all fields including shadowSide and scripture
      const card = { ...body.card, generatedAt: Date.now() };
      await blobSet(key, card);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ success: true })
      };
    }

    if (action === "deleteCachedCard") {
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

    // ── SERVER-SIDE CARD GENERATION (prompts never exposed to client) ──────────
    if (action === "generateCard") {
      const { matrix, strength, personality, gift, name, strengths, gifts, maxTokens } = body;
      let prompt = "";

      if (matrix === "m1") prompt = buildM1Prompt(strength, personality);
      else if (matrix === "m2") prompt = buildM2Prompt(strength, gift);
      else if (matrix === "m3") prompt = buildM3Prompt(personality, gift);
      else if (matrix === "m4") prompt = buildM4Prompt(name, strengths, personality, gifts);
      else if (matrix === "m4str") prompt = buildM4StrCardPrompt(name, strength, personality, gifts);
      else if (matrix === "m4bonus") prompt = buildM4BonusPrompt(name, strengths, personality, gifts);
      else {
        return {
          statusCode: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({ error: "Invalid matrix type" })
        };
      }

      const result = await callClaude(prompt, maxTokens || 1500);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify(result)
      };
    }

    // ── LEGACY AI PASSTHROUGH (kept for backward compatibility) ───────────────
    if (action === "ai" || !action) {
      const apiKey = process.env.ANTHROPIC_KEY;
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
    }

    return {
      statusCode: 400,
      body: JSON.stringify({ error: { message: "Unknown action" } })
    };

  } catch(err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: { message: err.message } })
    };
  }
};

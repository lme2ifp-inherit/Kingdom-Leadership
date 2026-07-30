const https = require("https");

// ═══════════════════════════════════════════════════════════════════════════════
// KINGDOM LEADERSHIP DISCOVERY — VERCEL FUNCTION
//
// Migrated from Netlify (netlify/functions/ai.js) on July 30, 2026.
//
// WHY THE MIGRATION: Netlify kills synchronous functions at 10 seconds. A live
// diagnostic on July 27, 2026 showed 100% of non-cached Opus 5 card generations
// failing with TIMEOUT (19 attempted, 0 generated). That is a hard platform
// ceiling, not a tail-latency problem.
//
// Vercel Fluid Compute allows 300s on every plan (800s Pro, 1800s beta), and
// active-CPU billing does NOT charge for time spent waiting on I/O — so waiting
// on Anthropic is nearly free. Long timeouts are cheap here.
//
// Storage moved from Netlify Blobs to Supabase (project: Kingdom Leadership),
// matching the pattern already proven on Stewardship Health.
// ═══════════════════════════════════════════════════════════════════════════════

// ── CONFIG ────────────────────────────────────────────────────────────────────

// Self-abort ceiling. Vercel terminates at maxDuration (300s, set in vercel.json)
// and would return an HTML/plain error page — which makes the browser's r.json()
// throw and hides the real cause. We abort first at 270s and return structured
// JSON the on-screen diagnostics banner can actually display. The 30s margin is
// deliberate: it leaves room to build and send the error response.
const UPSTREAM_TIMEOUT_MS = 270000;

// Profile freshness tracker. SOFT ONLY — this never blocks a regeneration.
// The server reports how old a profile is; the participant decides what to do.
// Nothing is ever overwritten automatically. Raised from 6 to 12 months on
// July 30, 2026.
const REGEN_MONTHS = 12;

const SYSTEM_PROMPT = "You are a faith-based leadership profile writer for a church conference. Respond only in English. Do not use any characters from non-Latin scripts, including but not limited to Chinese, Japanese, Korean, Arabic, or any other non-English writing system. Return pure JSON only with no markdown, preamble, or explanation.";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*"
};

// ── SUPABASE REST HELPER ──────────────────────────────────────────────────────
// Deliberately uses plain HTTPS against PostgREST rather than @supabase/supabase-js.
// Two reasons: this repo has zero npm dependencies and we keep it that way, and
// — more importantly — we need the REAL HTTP status code on every write. The
// July 26 Netlify Blobs bugs were all caused by helpers that returned `true`
// unconditionally, so failed writes reported success. The SDK would bury those
// codes behind its own error objects. Never report success we did not verify.

function supabaseRequest(method, path, opts) {
  const options = opts || {};
  return new Promise((resolve) => {
    const baseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;

    if (!baseUrl || !serviceKey) {
      return resolve({ ok: false, status: 0, data: null, error: "Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY missing)" });
    }

    let hostname;
    try {
      hostname = new URL(baseUrl).hostname;
    } catch (e) {
      return resolve({ ok: false, status: 0, data: null, error: "SUPABASE_URL is not a valid URL" });
    }

    const payload = options.body ? JSON.stringify(options.body) : null;

    const headers = {
      "apikey": serviceKey,
      "Authorization": "Bearer " + serviceKey,
      "Accept": "application/json"
    };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    if (options.prefer) headers["Prefer"] = options.prefer;

    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

    const req = https.request({ hostname, path, method, headers }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        let data = null;
        if (raw) {
          try { data = JSON.parse(raw); } catch (e) { data = null; }
        }
        finish({
          ok,
          status: res.statusCode,
          data,
          error: ok ? null : (raw ? raw.slice(0, 300) : `HTTP ${res.statusCode}`)
        });
      });
    });

    // Storage calls should be fast. If Supabase is unreachable we want to know
    // quickly rather than burn the whole 270s budget on a database round trip.
    const timer = setTimeout(() => {
      req.destroy();
      finish({ ok: false, status: 0, data: null, error: "Supabase request timed out after 15s" });
    }, 15000);

    req.on("close", () => clearTimeout(timer));
    req.on("error", (err) => {
      finish({ ok: false, status: 0, data: null, error: "Network error contacting Supabase: " + err.message });
    });

    if (payload) req.write(payload);
    req.end();
  });
}

// PostgREST filter values are quoted so that values containing commas, spaces or
// reserved characters cannot break out of the filter expression.
function eqFilter(value) {
  const quoted = '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  return "eq." + encodeURIComponent(quoted);
}

function normalizeEmail(e) {
  return String(e || "").toLowerCase().trim();
}

// ── APPROVED EMAIL ALLOWLIST ──────────────────────────────────────────────────

async function getApprovedEmails() {
  const r = await supabaseRequest("GET", "/rest/v1/approved_emails?select=email&order=created_at.asc");
  if (!r.ok || !Array.isArray(r.data)) return { ok: false, emails: [], error: r.error };
  return { ok: true, emails: r.data.map((row) => row.email), error: null };
}

async function addApprovedEmails(list) {
  const incoming = (Array.isArray(list) ? list : [])
    .map(normalizeEmail)
    .filter((e) => e.includes("@"));

  // Deduplicate within the submitted batch itself — PostgREST rejects an insert
  // that contains the same conflict key twice in one payload.
  const unique = [...new Set(incoming)];

  if (unique.length === 0) {
    const current = await getApprovedEmails();
    return { ok: current.ok, added: 0, emails: current.emails, error: current.error };
  }

  // resolution=ignore-duplicates means already-approved addresses are skipped
  // rather than erroring, and return=representation gives back ONLY the rows
  // actually inserted — so `added` is a true count, not just what was submitted.
  const r = await supabaseRequest(
    "POST",
    "/rest/v1/approved_emails?on_conflict=email",
    {
      body: unique.map((email) => ({ email })),
      prefer: "resolution=ignore-duplicates,return=representation"
    }
  );

  if (!r.ok) return { ok: false, added: 0, emails: [], error: r.error };

  const added = Array.isArray(r.data) ? r.data.length : 0;
  const current = await getApprovedEmails();
  return { ok: true, added, emails: current.emails, error: current.error };
}

async function removeApprovedEmail(email) {
  const e = normalizeEmail(email);
  if (!e) return { ok: false, emails: [], error: "No email supplied" };

  const r = await supabaseRequest("DELETE", `/rest/v1/approved_emails?email=${eqFilter(e)}`);
  if (!r.ok) return { ok: false, emails: [], error: r.error };

  const current = await getApprovedEmails();
  return { ok: true, emails: current.emails, error: current.error };
}

async function isEmailApproved(email) {
  const e = normalizeEmail(email);
  if (!e) return { ok: true, approved: false, error: null };

  const r = await supabaseRequest("GET", `/rest/v1/approved_emails?select=email&email=${eqFilter(e)}&limit=1`);
  if (!r.ok || !Array.isArray(r.data)) return { ok: false, approved: false, error: r.error };
  return { ok: true, approved: r.data.length > 0, error: null };
}

// ── PARTICIPANT PROFILES ──────────────────────────────────────────────────────

function monthsSince(ms) {
  return (Date.now() - ms) / (1000 * 60 * 60 * 24 * 30.44);
}

// Rebuilds the exact object shape the frontend already expects, so index.html
// needs no changes for profiles: name, personality, strengths, gifts, savedAt
// (epoch milliseconds — restoreProfileToState and profileAgeMonths both rely on
// this being a number, not an ISO string) and the aiData bundle.
function rowToProfile(row) {
  if (!row) return null;
  const savedAtMs = row.saved_at ? new Date(row.saved_at).getTime() : Date.now();
  return {
    email: row.email,
    name: row.name,
    personality: row.personality,
    strengths: Array.isArray(row.strengths) ? row.strengths : [],
    gifts: Array.isArray(row.gifts) ? row.gifts : [],
    aiData: row.ai_data || null,
    savedAt: savedAtMs
  };
}

async function saveParticipantProfile(email, profile) {
  const e = normalizeEmail(email);
  if (!e) return { ok: false, error: "No email supplied" };
  if (!profile || typeof profile !== "object") return { ok: false, error: "No profile supplied" };

  const savedAtMs = typeof profile.savedAt === "number" ? profile.savedAt : Date.now();

  const row = {
    email: e,
    name: String(profile.name || ""),
    personality: String(profile.personality || ""),
    strengths: Array.isArray(profile.strengths) ? profile.strengths : [],
    gifts: Array.isArray(profile.gifts) ? profile.gifts : [],
    ai_data: profile.aiData || {},
    saved_at: new Date(savedAtMs).toISOString(),
    updated_at: new Date().toISOString()
  };

  // Upsert on email. This replaces the old blob write path — and is very likely
  // the structural fix for BUG-LEADERSHIP-001 (admin participant edits not
  // saving), since a Postgres upsert either succeeds or reports why.
  const r = await supabaseRequest(
    "POST",
    "/rest/v1/participant_profiles?on_conflict=email",
    { body: [row], prefer: "resolution=merge-duplicates,return=representation" }
  );

  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, error: null };
}

async function loadParticipantProfile(email) {
  const e = normalizeEmail(email);
  if (!e) return { ok: true, profile: null, error: null };

  const r = await supabaseRequest("GET", `/rest/v1/participant_profiles?select=*&email=${eqFilter(e)}&limit=1`);
  if (!r.ok || !Array.isArray(r.data)) return { ok: false, profile: null, error: r.error };
  if (r.data.length === 0) return { ok: true, profile: null, error: null };

  return { ok: true, profile: rowToProfile(r.data[0]), error: null };
}

// ── CARD CACHE ────────────────────────────────────────────────────────────────
// The client still sends the original pipe-delimited key ("cache_m1|A|B") so the
// frontend did not have to change. We parse it into real columns on arrival.
// key_b keeps any remaining pipes joined back in, so a value that ever contained
// a "|" cannot silently truncate into a different cache entry.

function parseCacheKey(key) {
  const raw = String(key || "");
  const m = raw.match(/^cache_(m1|m2|m3)\|/);
  if (!m) return null;

  const parts = raw.split("|");
  if (parts.length < 3) return null;

  const keyA = parts[1];
  const keyB = parts.slice(2).join("|");
  if (!keyA || !keyB) return null;

  return { matrix: m[1], keyA, keyB };
}

function cacheKeyFromRow(row) {
  return `cache_${row.matrix}|${row.key_a}|${row.key_b}`;
}

async function getCachedCard(parsed) {
  const path = `/rest/v1/card_cache?select=card&matrix=${eqFilter(parsed.matrix)}&key_a=${eqFilter(parsed.keyA)}&key_b=${eqFilter(parsed.keyB)}&limit=1`;
  const r = await supabaseRequest("GET", path);
  if (!r.ok || !Array.isArray(r.data) || r.data.length === 0) return null;
  return r.data[0].card || null;
}

async function setCachedCard(parsed, card) {
  const r = await supabaseRequest(
    "POST",
    "/rest/v1/card_cache?on_conflict=matrix,key_a,key_b",
    {
      body: [{
        matrix: parsed.matrix,
        key_a: parsed.keyA,
        key_b: parsed.keyB,
        card: card
      }],
      prefer: "resolution=merge-duplicates,return=representation"
    }
  );
  // Returns the true result. A silently failed cache write is expensive — that
  // combination would regenerate, and bill, on every future request.
  return { ok: r.ok, error: r.error };
}

async function deleteCachedCard(parsed) {
  const path = `/rest/v1/card_cache?matrix=${eqFilter(parsed.matrix)}&key_a=${eqFilter(parsed.keyA)}&key_b=${eqFilter(parsed.keyB)}`;
  const r = await supabaseRequest("DELETE", path, { prefer: "return=representation" });
  // A delete that removed nothing still counts as success — the key is gone
  // either way. Same asymmetry as the old blobDelete: 404 is success for a
  // delete, but failure for a write.
  return { ok: r.ok, error: r.error };
}

async function listCachedCards() {
  const r = await supabaseRequest("GET", "/rest/v1/card_cache?select=matrix,key_a,key_b&order=created_at.asc");
  if (!r.ok || !Array.isArray(r.data)) return { ok: false, keys: [], counts: { m1: 0, m2: 0, m3: 0, total: 0 }, error: r.error };

  const keys = r.data.map(cacheKeyFromRow);
  const counts = {
    m1: r.data.filter((x) => x.matrix === "m1").length,
    m2: r.data.filter((x) => x.matrix === "m2").length,
    m3: r.data.filter((x) => x.matrix === "m3").length,
    total: r.data.length
  };
  return { ok: true, keys, counts, error: null };
}

async function clearAllCache() {
  // Count first so we can report found vs deleted honestly rather than assuming.
  const before = await listCachedCards();
  if (!before.ok) return { ok: false, found: 0, deleted: 0, failed: 0, error: before.error };

  // PostgREST refuses an unfiltered DELETE, so `id=not.is.null` is the explicit
  // "every row" filter. return=representation gives back exactly what was
  // removed, so the count is measured rather than assumed.
  const r = await supabaseRequest("DELETE", "/rest/v1/card_cache?id=not.is.null", { prefer: "return=representation" });

  if (!r.ok) {
    return { ok: false, found: before.counts.total, deleted: 0, failed: before.counts.total, error: r.error };
  }

  const deleted = Array.isArray(r.data) ? r.data.length : 0;
  return {
    ok: true,
    found: before.counts.total,
    deleted,
    failed: Math.max(0, before.counts.total - deleted),
    error: null
  };
}

// ── ANTHROPIC CALL ────────────────────────────────────────────────────────────

function postToAnthropic(payload, apiKey) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };

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
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          finish(JSON.parse(data));
        } catch (e) {
          finish({ error: { message: `Upstream returned unparseable body (HTTP ${res.statusCode})`, _diag: "BAD_JSON" } });
        }
      });
    });

    const timer = setTimeout(() => {
      req.destroy();
      finish({ error: { message: `Generation exceeded ${UPSTREAM_TIMEOUT_MS / 1000}s and was aborted before the Vercel function limit`, _diag: "TIMEOUT" } });
    }, UPSTREAM_TIMEOUT_MS);

    req.on("close", () => clearTimeout(timer));
    req.on("error", (err) => {
      finish({ error: { message: `Network error contacting Anthropic: ${err.message}`, _diag: "NETWORK" } });
    });

    req.write(payload);
    req.end();
  });
}

// Models that accept output_config.effort. Sending effort to a model that does
// not support it returns a 400 — this exact bug silently broke all three matrix
// summaries (which request claude-sonnet-4-5) on every run after Opus 5 landed.
const EFFORT_CAPABLE = /^claude-(opus-5|opus-4-[5-8]|sonnet-5|sonnet-4-6|fable-5|mythos-5)/;

async function callClaude(prompt, maxTokens) {
  const apiKey = process.env.ANTHROPIC_KEY;
  if (!apiKey) throw new Error("API key not configured");
  const payload = JSON.stringify({
    model: "claude-opus-5",
    max_tokens: maxTokens || 15000,
    output_config: { effort: "high" },
    // Opus 5 runs adaptive thinking ON by default when this field is omitted.
    // Thinking tokens bill at the output rate but are never shown to participants,
    // and they consume the same max_tokens ceiling as the card JSON — which was
    // starving some cards into truncated/unparseable output.
    // Devotional card writing does not benefit from step-by-step reasoning the
    // way math or code does, so it is disabled here.
    //
    // ⚠ CONSTRAINT: disabling thinking is only permitted at effort "high" or
    // below. If effort is ever raised to "xhigh" or "max", this thinking line
    // MUST be removed first or the API returns a 400 error.
    thinking: { type: "disabled" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }]
  });
  return await postToAnthropic(payload, apiKey);
}

// ── SERVER-SIDE PROMPT BUILDERS ───────────────────────────────────────────────
// IP protection: all prompt-building logic stays server-side. Nothing
// prompt-related moves back into index.html.

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
// Vercel signature: (req, res) — replaces Netlify's exports.handler(event, context).

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  const send = (status, payload) => {
    for (const [k, v] of Object.entries(JSON_HEADERS)) res.setHeader(k, v);
    return res.status(status).json(payload);
  };

  if (req.method !== "POST") {
    return send(405, { error: { message: "Method not allowed" } });
  }

  try {
    // Vercel usually parses JSON bodies automatically, but not always (raw
    // strings arrive when the content-type header is absent or unexpected), so
    // handle both rather than assuming.
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    if (!body || typeof body !== "object") body = {};

    const action = body.action || "ai";

    // ── ADMIN VERIFICATION (server-side — password never in client code) ──────
    if (action === "verifyAdmin") {
      const adminPassword = process.env.ADMIN_PASSWORD;
      if (!adminPassword) {
        return send(500, { error: "Admin not configured" });
      }
      return send(200, { valid: body.password === adminPassword });
    }

    // ── EMAIL ALLOWLIST ───────────────────────────────────────────────────────
    if (action === "getEmails") {
      const r = await getApprovedEmails();
      if (!r.ok) return send(500, { emails: [], error: r.error });
      return send(200, { emails: r.emails });
    }

    if (action === "addEmails") {
      const r = await addApprovedEmails(body.emails);
      if (!r.ok) return send(500, { success: false, added: 0, total: 0, emails: [], error: r.error });
      return send(200, { success: true, added: r.added, total: r.emails.length, emails: r.emails });
    }

    if (action === "removeEmail") {
      const r = await removeApprovedEmail(body.email);
      if (!r.ok) return send(500, { success: false, emails: [], error: r.error });
      return send(200, { success: true, emails: r.emails });
    }

    if (action === "checkEmail") {
      const r = await isEmailApproved(body.email);
      if (!r.ok) return send(500, { approved: false, error: r.error });
      return send(200, { approved: r.approved });
    }

    // ── PARTICIPANT PROFILES ──────────────────────────────────────────────────
    if (action === "saveProfile") {
      const r = await saveParticipantProfile(body.email, body.profile);
      if (!r.ok) return send(500, { success: false, error: r.error });
      return send(200, { success: true });
    }

    if (action === "loadProfile") {
      const r = await loadParticipantProfile(body.email);
      if (!r.ok) return send(500, { profile: null, error: r.error });

      // 12-month freshness tracker — INFORMATIONAL ONLY.
      // The server reports age; it never refuses a regeneration and never
      // overwrites anything. If the participant's results have not changed,
      // the profile is simply left alone.
      let meta = { regenMonths: REGEN_MONTHS, ageMonths: null, needsRefresh: false, enforced: false };
      if (r.profile && typeof r.profile.savedAt === "number") {
        const age = monthsSince(r.profile.savedAt);
        meta = {
          regenMonths: REGEN_MONTHS,
          ageMonths: Math.round(age * 100) / 100,
          needsRefresh: age >= REGEN_MONTHS,
          enforced: false
        };
      }

      return send(200, { profile: r.profile, meta });
    }

    // ── CARD CACHE ────────────────────────────────────────────────────────────
    if (action === "getCachedCard") {
      const parsed = parseCacheKey(body.cacheKey);
      if (!parsed) return send(200, { card: null });
      const card = await getCachedCard(parsed);
      return send(200, { card: card || null });
    }

    if (action === "setCachedCard") {
      const parsed = parseCacheKey(body.cacheKey);
      if (!parsed) return send(400, { error: "Invalid cache key" });
      if (!body.card || typeof body.card !== "object") return send(400, { error: "No card supplied" });

      // Preserve all fields including shadowSide and scripture.
      const card = Object.assign({}, body.card, { generatedAt: Date.now() });
      const r = await setCachedCard(parsed, card);
      return send(r.ok ? 200 : 500, { success: r.ok, error: r.error });
    }

    if (action === "deleteCachedCard") {
      const parsed = parseCacheKey(body.cacheKey);
      if (!parsed) return send(400, { error: "Invalid cache key" });
      const r = await deleteCachedCard(parsed);
      return send(r.ok ? 200 : 500, { success: r.ok, error: r.error });
    }

    if (action === "listCachedCards") {
      const r = await listCachedCards();
      if (!r.ok) return send(500, { keys: [], counts: r.counts, error: r.error });
      return send(200, { keys: r.keys, counts: r.counts });
    }

    // ── MASTER CACHE RESET — wipes every cached M1/M2/M3 card ─────────────────
    // Used after a model upgrade so all cards regenerate at the new quality.
    // Participant profiles live in a separate table and are untouched.
    if (action === "clearAllCache") {
      const r = await clearAllCache();
      return send(r.ok ? 200 : 500, {
        found: r.found,
        deleted: r.deleted,
        failed: r.failed,
        error: r.error
      });
    }

    // ── SERVER-SIDE CARD GENERATION ───────────────────────────────────────────
    if (action === "generateCard") {
      const { matrix, strength, personality, gift, name, strengths, gifts, maxTokens } = body;
      let prompt = "";

      if (matrix === "m1") prompt = buildM1Prompt(strength, personality);
      else if (matrix === "m2") prompt = buildM2Prompt(strength, gift);
      else if (matrix === "m3") prompt = buildM3Prompt(personality, gift);
      else if (matrix === "m4") prompt = buildM4Prompt(name, strengths, personality, gifts);
      else if (matrix === "m4str") prompt = buildM4StrCardPrompt(name, strength, personality, gifts);
      else if (matrix === "m4bonus") prompt = buildM4BonusPrompt(name, strengths, personality, gifts);
      else return send(400, { error: "Invalid matrix type" });

      const result = await callClaude(prompt, maxTokens || 15000);
      return send(200, result);
    }

    // ── LEGACY AI PASSTHROUGH (used by the three matrix summaries) ────────────
    if (action === "ai" || !action) {
      const apiKey = process.env.ANTHROPIC_KEY;
      if (!apiKey) {
        return send(500, { error: { message: "API key not configured" } });
      }

      const requestedModel = body.model || "claude-opus-5";
      const supportsEffort = EFFORT_CAPABLE.test(requestedModel);

      const payloadObj = {
        model: requestedModel,
        max_tokens: body.max_tokens || 15000,
        system: SYSTEM_PROMPT,
        messages: body.messages
      };
      if (supportsEffort) {
        payloadObj.output_config = { effort: "high" };
        // See callClaude(). Must be removed if effort ever goes above "high".
        payloadObj.thinking = { type: "disabled" };
      }

      const result = await postToAnthropic(JSON.stringify(payloadObj), apiKey);
      return send(200, result);
    }

    return send(400, { error: { message: "Unknown action" } });

  } catch (err) {
    return send(500, { error: { message: err.message } });
  }
};

// Exported for the standalone boundary tests. Not used by the handler path.
module.exports._internal = {
  parseCacheKey,
  cacheKeyFromRow,
  eqFilter,
  normalizeEmail,
  rowToProfile,
  monthsSince,
  EFFORT_CAPABLE,
  REGEN_MONTHS,
  UPSTREAM_TIMEOUT_MS
};

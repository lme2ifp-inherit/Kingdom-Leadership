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

// ── GENERATION POWER DIAL ─────────────────────────────────────────────────────
// One knob. Change this single string and redeploy — nothing else needs editing.
//
//   "standard" — effort high, thinking off.  ~14s/card.  Current proven setting.
//   "deep"     — effort xhigh, thinking on.  Slower and costs more per card.
//   "max"      — effort max,   thinking on.  Deepest reasoning available.
//
// Cards are cached permanently per combination, so a higher setting is paid for
// ONCE per combination, not once per participant. Raising this is cheap in
// absolute terms; it mainly costs generation time.
//
// ⚠ Opus 5 rule (verified against Anthropic docs, July 30 2026): thinking can
// only be DISABLED at effort "high" or below. Sending thinking:{disabled} with
// effort "xhigh" or "max" returns a 400. powerConfig() enforces this in code
// rather than in a comment, so the invalid combination is unreachable.
//
// ⚠ max_tokens is a hard ceiling on TOTAL output — thinking tokens plus card
// JSON share it. That is why the higher tiers raise it: thinking on a 15000
// ceiling can starve the card itself into truncated, unparseable output.
const GENERATION_POWER = "standard";

const POWER_LEVELS = {
  standard: { effort: "high",  thinkingOff: true,  maxTokens: 15000 },
  deep:     { effort: "xhigh", thinkingOff: false, maxTokens: 32000 },
  max:      { effort: "max",   thinkingOff: false, maxTokens: 64000 }
};

// Effort levels at which Opus 5 permits thinking to be disabled.
const THINKING_OFF_ALLOWED = ["low", "medium", "high"];

function powerConfig(level) {
  const cfg = POWER_LEVELS[level] || POWER_LEVELS.standard;
  return {
    effort: cfg.effort,
    // Fails SAFE: if a future edit ever asks for thinking-off above "high", we
    // silently leave thinking on rather than sending a request that 400s.
    disableThinking: cfg.thinkingOff && THINKING_OFF_ALLOWED.includes(cfg.effort),
    maxTokens: cfg.maxTokens
  };
}

// ── VOICE ─────────────────────────────────────────────────────────────────────
// Rewritten July 30 2026. The previous prompt said nothing about voice, and the
// schemas asked for "poetic" titles and "vivid" sentences — which is precisely
// what produced flowery, generic cards like "The Sovereign Architect".
// This is the A+C combination: Observable Behavior + Honest Cost, with the
// teaching obligation folded into the scripture and growth-edge fields.
const SYSTEM_PROMPT = [
  "You are writing leadership profile cards for participants at a faith-based church leadership conference.",
  "These are real people trying to understand how God has wired them and how He wants to use them.",
  "",
  "VOICE RULES. These override any adjective used in the JSON schema:",
  "1. OBSERVABLE BEHAVIOR. Every claim must cash out in something the reader would catch themselves actually doing — in a meeting, a decision, a conversation, a Sunday. If a sentence could be printed on a motivational poster, rewrite it. Name the behavior, not the abstraction.",
  "2. HONEST COST. The shadow side must name what this wiring costs THE PEOPLE AROUND THEM, not only what it costs the reader internally. Then give a growth edge with a real price attached — something that costs them time, comfort, or control. No free virtues.",
  "3. TEACH, DO NOT DECORATE. Every field should leave the reader knowing something they did not know walking in — the mechanism behind the pattern, not a restatement of the label they already have.",
  "4. PLAIN WORDS. Do not use elevated nouns such as sovereign, architect, unflinching, warrior, beacon, tapestry, forge, crucible, mantle, or journey. Write the way a trusted mentor talks across a kitchen table.",
  "5. END FORWARD. Encouragement is earned by honesty first. Close on something the reader can do or ask God for, never on a compliment.",
  "6. SECOND PERSON. Address the reader directly as you, except in the prayer, which is first person.",
  "",
  "Respond only in English. Do not use characters from non-Latin scripts, including but not limited to Chinese, Japanese, Korean, or Arabic.",
  "Return pure JSON only with no markdown, preamble, or explanation."
].join("\n");

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

// PostgREST equality filter.
//
// ⚠ HARD-WON: an earlier version wrapped values in double quotes as an
// injection guard. That was WRONG and silently broke every filtered query —
// PostgREST compared against a value that literally included the quote marks,
// so checkEmail said nobody was approved and NO cache lookup could ever hit
// (which would have meant regenerating, and paying for, every card forever
// while merely looking like an empty cache).
//
// Per the PostgREST URL-grammar docs, quoting is only needed when a value
// contains a RESERVED character ( , . : ( ) ). For a plain `col=eq.value`
// match, percent-encoding alone is correct — this is exactly what the official
// supabase-js client emits.
//
// Constraint this relies on: no value passed here contains a comma or
// parenthesis. True for every caller — emails, Clifton Strengths, 16
// Personalities codes, Spiritual Gifts, and the m1/m2/m3 matrix tag. Dots in
// email addresses are fine: only the FIRST dot after the operator is
// structural, everything after it is the value.
function eqFilter(value) {
  return "eq." + encodeURIComponent(String(value));
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
  const power = powerConfig(GENERATION_POWER);

  const payloadObj = {
    model: "claude-opus-5",
    // A caller-supplied ceiling still wins, but the dial raises the floor so
    // that turning thinking on does not starve the card JSON of room.
    max_tokens: Math.max(maxTokens || 0, power.maxTokens),
    output_config: { effort: power.effort },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }]
  };

  // Opus 5 runs adaptive thinking ON by default when this field is omitted.
  // At "standard" we turn it off: thinking tokens bill at the output rate, are
  // never shown to participants, and share the max_tokens ceiling with the card.
  // At "deep"/"max" we omit the field entirely so thinking stays on — required,
  // since disabling it above effort "high" is a 400.
  if (power.disableThinking) payloadObj.thinking = { type: "disabled" };

  return await postToAnthropic(JSON.stringify(payloadObj), apiKey);
}

// ── SERVER-SIDE PROMPT BUILDERS ───────────────────────────────────────────────
// IP protection: all prompt-building logic stays server-side. Nothing
// prompt-related moves back into index.html.

function buildM1Prompt(strength, personality) {
  const pBase = personality.split("-")[0];
  const v = personality.includes("-A") ? "Assertive" : "Turbulent";
  const schema = '{"theme":"3-5 word title naming what this person actually does. Concrete and plain, not decorative. No elevated nouns","description":"3-4 sentences on how this strength and this personality interact. Every sentence must describe observable behavior — what this person does in a meeting, a decision, or a conversation that someone with a different combination would not do. Name the mechanism, not the label","gift":"One sentence on what this combination gives a team, stated as a specific thing they do that unsticks something others could not","shadowSide":"2 sentences. FIRST: what this wiring costs THE PEOPLE AROUND THEM when unchecked — the effect others actually experience, not just an internal flaw. SECOND: one growth edge with a real price attached, something that costs this person time, comfort, or control. Scoped only to this combination, no personal names","scripture":"One Bible verse reference and brief quote from KJV, NIV, NLT, or NASB1995 — choose whichever translation best fits this combination — then one sentence explaining the MECHANISM of why it speaks to this exact pairing, not a general application. Format: BookChapter:Verse TranslationAbbrev — quote — explanation","prayer":"3 sentence prayer written in first person as if the participant is praying it themselves using I me my Lord You — NOT a prayer spoken over them. Ends forward: something asked for, not something admired"}';
  return `Faith-based leadership conference. Matrix 1 Core Traits combining Clifton Strengths and 16 Personalities. This combination is ${strength} strength with ${personality} personality (${pBase} ${v} variant). Return pure JSON only with no markdown or explanation matching this exact shape: ${schema}`;
}

function buildM2Prompt(strength, gift) {
  const schema = '{"theme":"3-5 word title naming what this talent and gift actually produce together. Concrete and plain, not decorative","description":"3-4 sentences on how this natural talent and this spiritual gift work together in ministry. Every sentence must describe observable behavior — what this person does in a serving context that someone with the same gift but a different strength would not do","gift":"One sentence on the specific contribution this combination makes to the body of Christ, stated as an action, not a quality","shadowSide":"2 sentences. FIRST: what this combination costs THE PEOPLE BEING SERVED when unchecked — the effect others actually experience. SECOND: one growth edge with a real price attached, something that costs this person time, comfort, or control. Scoped only to this combination, no personal names","scripture":"One Bible verse reference and brief quote from KJV, NIV, NLT, or NASB1995 — choose whichever translation best fits this combination — then one sentence explaining the MECHANISM of why it speaks to this exact pairing, not a general application. Format: BookChapter:Verse TranslationAbbrev — quote — explanation","prayer":"3 sentence prayer written in first person as if the participant is praying it themselves using I me my Lord You — NOT a prayer spoken over them. Ends forward: something asked for, not something admired"}';
  return `Faith-based leadership conference. Matrix 2 Empowered Abilities combining Clifton Strengths and Spiritual Gifts. This combination is ${strength} CliftonStrength with ${gift} Spiritual Gift. Return pure JSON only with no markdown or explanation matching this exact shape: ${schema}`;
}

function buildM3Prompt(personality, gift) {
  const pBase = personality.split("-")[0];
  const schema = '{"theme":"3-5 word title naming how this gift actually shows up through this personality. Concrete and plain, not decorative","description":"3-4 sentences on how the Holy Spirit works this gift through this specific personality. Every sentence must describe observable behavior — what this looks like in practice, and how it differs visibly from the same gift exercised through an opposite personality","gift":"One sentence on what the Spirit does through this personality that would look different through another, stated as an action","shadowSide":"2 sentences. FIRST: what this pairing costs THE PEOPLE AROUND THEM when unchecked — the effect others actually experience, including how the personality can distort the gift. SECOND: one growth edge with a real price attached, something that costs this person time, comfort, or control. Scoped only to this combination, no personal names","scripture":"One Bible verse reference and brief quote from KJV, NIV, NLT, or NASB1995 — choose whichever translation best fits this combination — then one sentence explaining the MECHANISM of why it speaks to this exact pairing, not a general application. Format: BookChapter:Verse TranslationAbbrev — quote — explanation","prayer":"3 sentence prayer written in first person as if the participant is praying it themselves using I me my Lord You — NOT a prayer spoken over them. Ends forward: something asked for, not something admired"}';
  return `Faith-based leadership conference. Matrix 3 Innate Qualities combining 16 Personalities and Spiritual Gifts. This combination is ${personality} personality (${pBase}) with ${gift} Spiritual Gift. Return pure JSON only with no markdown or explanation matching this exact shape: ${schema}`;
}

function buildM4Prompt(name, strengths, personality, gifts) {
  const sAll = strengths.join(", ");
  const gAll = gifts.join(", ");
  const pBase = personality.split("-")[0];
  const schema = '{"unifiedTheme":"3-6 word title naming what this person is actually built to do. Concrete and plain, not decorative. No elevated nouns","description":"4-5 sentences on how these specific strengths, this personality, and these gifts work as one system. Reference the ACTUAL named strengths and gifts given above — not leadership in general. Every sentence must describe observable behavior, and at least one must name a tension or friction between two of these traits and how it resolves in practice","kingdomRole":"2-3 sentences on the specific role this person is built for. Name the kind of situation, room, or season where this exact wiring is the right tool — and be concrete enough that the reader could recognize the situation next week","teamContribution":"2-3 sentences on what this person does for a team that a differently-wired person would not. State it as behavior others would notice, not as a quality they possess","shadowSide":"2-3 sentences. FIRST: what this combination costs THE PEOPLE AROUND THEM when unchecked — the effect others actually experience. Name which specific traits collide to produce it. THEN: a growth edge with a real price attached, something that costs this person time, comfort, or control. Be honest; do not soften it into a compliment","scripture":"One Bible verse reference and brief quote from KJV, NIV, NLT, or NASB1995 then one sentence explaining the MECHANISM of why it speaks to this exact combination, not a general application","prayer":"4-5 sentence prayer written in first person as if the participant is praying it themselves using I me my Lord You — NOT a prayer spoken over them. It should name the growth edge honestly and end forward: something asked for, not something admired"}';
  return `Faith-based leadership conference. Matrix 4 Unified Potential master synthesis for ${name}. Top strengths: ${sAll}. Personality: ${personality} (${pBase}). Spiritual gifts: ${gAll}. Return pure JSON only with no markdown or explanation matching this exact shape: ${schema}`;
}

function buildM4StrCardPrompt(name, strength, personality, gifts) {
  const gAll = gifts.join(", ");
  const pBase = personality.split("-")[0];
  const schema = '{"cardTheme":"3-5 word title naming what this strength does once this personality and these gifts are running through it. Concrete and plain, not decorative","description":"3-4 sentences on how this strength changes shape when filtered through this personality and activated by these gifts. Every sentence must describe observable behavior. Name at least one thing this person does that another person with the SAME strength but different gifts would not do","scripture":"One Bible verse reference and brief quote from KJV, NIV, NLT, or NASB1995 anchoring this strength with these gifts, then one sentence on the mechanism of why it fits","prayer":"2-3 sentence prayer written in first person as if the participant is praying it themselves using I me my Lord You — NOT a prayer spoken over them. Ends forward: something asked for, not something admired"}';
  return `Faith-based leadership conference. Matrix 4 Individual Strength Card for ${name}. Strength: ${strength}. Personality: ${personality} (${pBase}). Spiritual gifts: ${gAll}. Return pure JSON only with no markdown or explanation matching this exact shape: ${schema}`;
}

function buildM4BonusPrompt(name, strengths, personality, gifts) {
  const top3s = strengths.slice(0, 3).join(", ");
  const top3g = gifts.slice(0, 3).join(", ");
  const pBase = personality.split("-")[0];
  const schema = '{"bonusTheme":"3-5 word title, concrete and plain, not decorative","synthesis":"3-4 sentences distilling what this person is built to do, referencing the ACTUAL named strengths and gifts above. Observable behavior, not abstractions","coreCall":"One clear sentence naming what this person is called to do. Plain language a person would actually say out loud — not a slogan","blessing":"3-4 sentence spoken blessing written in third person as if a pastor is speaking it over the participant using their name and he/she/they. Warm and personal, grounded in the specific traits named above rather than generic praise"}';
  return `Faith-based leadership conference. Streamlined Synthesis for ${name}. Top 3 strengths: ${top3s}. Personality: ${personality} (${pBase}). Top spiritual gifts: ${top3g}. Return pure JSON only with no markdown or explanation matching this exact shape: ${schema}`;
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
// Vercel signature: (req, res) — replaces Netlify's exports.handler(event, context).

// ── MATRIX SUMMARY PROMPTS ────────────────────────────────────────────────────
// Moved server-side July 31, 2026. These previously lived in index.html and
// were built by the browser, which meant they were invisible to the July 30
// voice rewrite — all three still asked for a "poetic title" and were still
// producing the old flowery output long after the card schemas were fixed.
// Server-side is also required for the drain, which has no browser to ask.
function buildM1SummaryPrompt(strengths, personality) {
  const sAll = (strengths || []).join(", ");
  const pBase = String(personality || "").split("-")[0];
  const schema = '{"theme":"3-5 word title naming the single leadership style these strengths add up to under this personality. Concrete and plain, not decorative","summary":"4-5 sentences on how the ' + pBase + ' personality unifies ALL these strengths into one operating style — the combined effect, not each strength separately. Describe observable behavior, and name at least one place two of these strengths pull against each other and how this personality resolves it","teamRole":"2 sentences on the role this combination actually plays on a team, stated as behavior others would notice"}';
  return "Faith-based leadership conference. Matrix 1 Summary for " + personality + " personality (" + pBase + ") with these 5 strengths: " + sAll + ". Describe how this personality shapes and unifies all these strengths as one leadership style. Return pure JSON only no markdown: " + schema;
}

function buildM2SummaryPrompt(strengths, gifts) {
  const sAll = (strengths || []).join(", ");
  const gAll = (gifts || []).join(", ");
  const schema = '{"theme":"3-5 word title naming what these gifts produce when they run through these strengths. Concrete and plain, not decorative","summary":"4-5 sentences on how these spiritual gifts work through these natural strengths as one expression — the overall pattern, not each pair. Describe observable behavior in a serving context","kingdomExpression":"2 sentences on what this combination actually does for the body of Christ, stated as action rather than quality"}';
  return "Faith-based leadership conference. Matrix 2 Summary: spiritual gifts (" + gAll + ") flowing through strengths (" + sAll + ") as a unified expression. Describe the overall pattern. Return pure JSON only no markdown: " + schema;
}

function buildM3SummaryPrompt(personality, gifts) {
  const pBase = String(personality || "").split("-")[0];
  const gAll = (gifts || []).join(", ");
  const schema = '{"theme":"3-5 word title naming how this personality carries these gifts. Concrete and plain, not decorative","summary":"4-5 sentences on how the ' + pBase + ' personality channels these gifts together — the overall Spirit-empowered pattern. Describe observable behavior, and name how this looks visibly different from the same gifts through an opposite personality","empoweredIdentity":"2 sentences on who this person is when operating at their best, in plain language rather than elevated nouns"}';
  return "Faith-based leadership conference. Matrix 3 Summary: how does " + personality + " personality (" + pBase + ") channel these spiritual gifts together: " + gAll + ". Return pure JSON only no markdown: " + schema;
}

// ── PROMPT DISPATCH ───────────────────────────────────────────────────────────
// Single source of truth mapping an item kind to its prompt. The drain worker
// uses this rather than carrying its own copy — one place to change a prompt,
// not two that can silently drift apart.
function buildPromptFor(kind, p) {
  const params = p || {};
  // Validate BEFORE building. Two reasons this matters: an undefined value
  // throws inside the builders (killing the item on an exception rather than a
  // readable error), and a value that stringifies to "undefined" would produce
  // a real, billable card about an undefined personality. Returning null lets
  // the caller fail the item explicitly without spending anything.
  const str = (v) => typeof v === "string" && v.length > 0;
  const arr = (v) => Array.isArray(v) && v.length > 0;
  const need = {
    m1:      () => str(params.strength) && str(params.personality),
    m2:      () => str(params.strength) && str(params.gift),
    m3:      () => str(params.personality) && str(params.gift),
    m1sum:   () => arr(params.strengths) && str(params.personality),
    m2sum:   () => arr(params.strengths) && arr(params.gifts),
    m3sum:   () => str(params.personality) && arr(params.gifts),
    m4:      () => arr(params.strengths) && str(params.personality) && arr(params.gifts),
    m4bonus: () => arr(params.strengths) && str(params.personality) && arr(params.gifts),
    m4str:   () => str(params.strength) && str(params.personality) && arr(params.gifts)
  };
  if (!need[kind] || !need[kind]()) return null;

  switch (kind) {
    case "m1":      return buildM1Prompt(params.strength, params.personality);
    case "m2":      return buildM2Prompt(params.strength, params.gift);
    case "m3":      return buildM3Prompt(params.personality, params.gift);
    case "m1sum":   return buildM1SummaryPrompt(params.strengths, params.personality);
    case "m2sum":   return buildM2SummaryPrompt(params.strengths, params.gifts);
    case "m3sum":   return buildM3SummaryPrompt(params.personality, params.gifts);
    case "m4":      return buildM4Prompt(params.name, params.strengths, params.personality, params.gifts);
    case "m4bonus": return buildM4BonusPrompt(params.name, params.strengths, params.personality, params.gifts);
    case "m4str":   return buildM4StrCardPrompt(params.name, params.strength, params.personality, params.gifts);
    default:        return null;
  }
}

// Only M1/M2/M3 are shared across participants and therefore worth caching.
// Everything else is personal to one person — the summaries depend on the whole
// set of five strengths, and the M4 tier sees the entire profile.
const CACHEABLE_KINDS = ["m1", "m2", "m3"];

// ── JOB PLANNING ──────────────────────────────────────────────────────────────
// Expands a participant into the full ordered list of cards their profile
// needs. Order matters: cheap shared cards first (most likely to be cache
// hits), the personal M4 tier last, so a partially drained job still shows
// meaningful progress.
function planItemsFor(participant) {
  const p = participant || {};
  const strengths = Array.isArray(p.strengths) ? p.strengths : [];
  const gifts = Array.isArray(p.gifts) ? p.gifts : [];
  const personality = p.personality;
  const name = p.name;
  const items = [];
  const push = (kind, cache_key, params) => {
    items.push({
      kind,
      cache_key,
      params,
      cacheable: CACHEABLE_KINDS.indexOf(kind) !== -1,
      position: items.length
    });
  };

  for (const s of strengths) push("m1", `m1|${s}|${personality}`, { strength: s, personality });
  for (const s of strengths) for (const g of gifts) push("m2", `m2|${s}|${g}`, { strength: s, gift: g });
  for (const g of gifts) push("m3", `m3|${personality}|${g}`, { personality, gift: g });

  push("m1sum", `m1sum|${strengths.join(",")}|${personality}`, { strengths, personality });
  push("m2sum", `m2sum|${strengths.join(",")}|${gifts.join(",")}`, { strengths, gifts });
  push("m3sum", `m3sum|${personality}|${gifts.join(",")}`, { personality, gifts });

  push("m4", `m4|${strengths.join(",")}|${personality}|${gifts.join(",")}`, { name, strengths, personality, gifts });
  push("m4bonus", `m4bonus|${strengths.slice(0, 3).join(",")}|${personality}|${gifts.slice(0, 3).join(",")}`, { name, strengths, personality, gifts });
  for (const s of strengths) push("m4str", `m4c|${s}|${personality}|${gifts.join(",")}`, { name, strength: s, personality, gifts });

  return items;
}

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

    // ── QUEUE: ENQUEUE A GENERATION JOB ───────────────────────────────────────
    // Replaces the browser orchestrating 33 sequential calls. The browser now
    // submits once and polls; the drain does the work. A participant can close
    // the tab, lock the phone, or lose signal without losing the run.
    if (action === "enqueueJob") {
      const email = normalizeEmail(body.email);
      const participant = body.participant || {};
      if (!email || !email.includes("@")) {
        return send(400, { error: { message: "A valid email is required" } });
      }
      if (!participant.personality || !Array.isArray(participant.strengths) || !Array.isArray(participant.gifts)) {
        return send(400, { error: { message: "participant needs personality, strengths[] and gifts[]" } });
      }

      // Never queue a second job for someone who already has one running —
      // that would double the spend and produce two writes racing for the
      // same profile row.
      const existing = await supabaseRequest(
        "GET",
        `/rest/v1/generation_jobs?email=${eqFilter(email)}&status=in.(pending,processing)&select=id,status,total_items,done_items&limit=1`
      );
      if (existing.ok && Array.isArray(existing.data) && existing.data.length > 0) {
        const j = existing.data[0];
        return send(200, { jobId: j.id, status: j.status, alreadyQueued: true, total: j.total_items, done: j.done_items });
      }

      const items = planItemsFor(participant);
      if (items.length === 0) {
        return send(400, { error: { message: "Nothing to generate — check strengths and gifts" } });
      }

      const jobIns = await supabaseRequest("POST", "/rest/v1/generation_jobs", {
        body: [{ email, participant, status: "pending", total_items: items.length, done_items: 0 }],
        prefer: "return=representation"
      });
      if (!jobIns.ok || !Array.isArray(jobIns.data) || jobIns.data.length === 0) {
        return send(500, { error: { message: "Could not create job", _diag: "SUPABASE_WRITE", detail: jobIns.error } });
      }
      const jobId = jobIns.data[0].id;

      const itemIns = await supabaseRequest("POST", "/rest/v1/generation_items", {
        body: items.map((it) => ({
          job_id: jobId,
          kind: it.kind,
          cache_key: it.cache_key,
          params: it.params,
          cacheable: it.cacheable,
          position: it.position,
          status: "pending"
        }))
      });
      if (!itemIns.ok) {
        // Roll the job back rather than leaving an empty one to be claimed,
        // drained to "zero pending", and marked complete with no cards.
        await supabaseRequest("DELETE", `/rest/v1/generation_jobs?id=${eqFilter(jobId)}`);
        return send(500, { error: { message: "Could not queue cards", _diag: "SUPABASE_WRITE", detail: itemIns.error } });
      }

      return send(200, { jobId, status: "pending", total: items.length, done: 0, queuePosition: null });
    }

    // ── QUEUE: JOB STATUS (polled by the browser) ─────────────────────────────
    if (action === "jobStatus") {
      const email = normalizeEmail(body.email);
      const jobId = body.jobId;
      const query = jobId
        ? `/rest/v1/generation_jobs?id=${eqFilter(jobId)}&select=*&limit=1`
        : `/rest/v1/generation_jobs?email=${eqFilter(email)}&select=*&order=created_at.desc&limit=1`;
      const r = await supabaseRequest("GET", query);
      if (!r.ok) return send(500, { error: { message: "Could not read job status", detail: r.error } });
      if (!Array.isArray(r.data) || r.data.length === 0) return send(200, { job: null });

      const job = r.data[0];

      // How many people are ahead of them. At a conference this is the number
      // that actually calms a room down.
      let ahead = 0;
      if (job.status === "pending" || job.status === "processing") {
        const q = await supabaseRequest(
          "GET",
          `/rest/v1/generation_jobs?status=in.(pending,processing)&created_at=lt.${encodeURIComponent(job.created_at)}&select=id`
        );
        if (q.ok && Array.isArray(q.data)) ahead = q.data.length;
      }

      return send(200, {
        job: {
          id: job.id,
          status: job.status,
          total: job.total_items,
          done: job.done_items,
          ahead,
          error: job.last_error || null,
          createdAt: job.created_at,
          finishedAt: job.finished_at
        }
      });
    }

    // ── QUEUE: ADMIN CONTROL ──────────────────────────────────────────────────
    if (action === "queueStatus" || action === "queuePause" || action === "queueResume") {
      const adminPassword = process.env.ADMIN_PASSWORD;
      if (!adminPassword || body.password !== adminPassword) {
        return send(401, { error: { message: "Admin password required" } });
      }

      if (action === "queuePause" || action === "queueResume") {
        const pausing = action === "queuePause";
        const patch = pausing
          ? { paused: true, paused_reason: "Paused from admin panel", paused_at: new Date().toISOString(), paused_by: "admin" }
          : { paused: false, paused_reason: null, paused_at: null, paused_by: null, consecutive_bad_runs: 0 };
        const r = await supabaseRequest("PATCH", "/rest/v1/generation_control?id=eq.1", { body: patch });
        if (!r.ok) return send(500, { error: { message: "Could not update queue control", detail: r.error } });
      }

      const ctl = await supabaseRequest("GET", "/rest/v1/generation_control?id=eq.1&select=*");
      const jobs = await supabaseRequest(
        "GET",
        "/rest/v1/generation_jobs?select=id,email,status,total_items,done_items,created_at,last_error&order=created_at.desc&limit=25"
      );
      return send(200, {
        control: (ctl.ok && Array.isArray(ctl.data) && ctl.data[0]) || null,
        jobs: (jobs.ok && Array.isArray(jobs.data)) ? jobs.data : []
      });
    }

    // ── LEGACY AI PASSTHROUGH (used by the three matrix summaries) ────────────
    if (action === "ai" || !action) {
      const apiKey = process.env.ANTHROPIC_KEY;
      if (!apiKey) {
        return send(500, { error: { message: "API key not configured" } });
      }

      const requestedModel = body.model || "claude-opus-5";
      const supportsEffort = EFFORT_CAPABLE.test(requestedModel);

      const power = powerConfig(GENERATION_POWER);
      const payloadObj = {
        model: requestedModel,
        max_tokens: Math.max(body.max_tokens || 0, power.maxTokens),
        system: SYSTEM_PROMPT,
        messages: body.messages
      };
      if (supportsEffort) {
        payloadObj.output_config = { effort: power.effort };
        // Only sent when the dial permits it. See powerConfig().
        if (power.disableThinking) payloadObj.thinking = { type: "disabled" };
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
  UPSTREAM_TIMEOUT_MS,
  powerConfig,
  POWER_LEVELS,
  GENERATION_POWER,
  THINKING_OFF_ALLOWED,
  SYSTEM_PROMPT,
  buildM1Prompt,
  buildM2Prompt,
  buildM3Prompt,
  buildM4Prompt,
  buildM4StrCardPrompt,
  buildM4BonusPrompt,
  buildM1SummaryPrompt,
  buildM2SummaryPrompt,
  buildM3SummaryPrompt,
  buildPromptFor,
  planItemsFor,
  CACHEABLE_KINDS
};

// Used by api/drain.js. Exported separately from _internal (which is test-only)
// because these are a real runtime dependency, not test scaffolding.
module.exports._shared = {
  supabaseRequest,
  eqFilter,
  normalizeEmail,
  callClaude,
  buildPromptFor,
  planItemsFor,
  powerConfig,
  GENERATION_POWER
};

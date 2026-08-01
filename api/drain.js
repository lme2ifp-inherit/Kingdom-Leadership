// ═══════════════════════════════════════════════════════════════════════════
// GENERATION QUEUE DRAIN — api/drain.js
// July 31, 2026
//
// Invoked by pg_cron every minute. Claims the oldest unfinished job and
// generates as many of its cards as it can safely fit inside this invocation,
// writing each one to Supabase the moment it completes.
//
// Pattern adapted from the Stewardship Health medication queue drain, which
// has been running live on a 1-minute cadence. Two lessons carried over from
// that build, both paid for the hard way:
//
//   1. BUDGET-AWARE GATING, NOT A FLAT DEADLINE. Health's first version used
//      "stop claiming work after N ms elapsed", which does not account for how
//      long the NEXT item could itself take. A fast first item left the
//      deadline unmet, a second item started, ran long, and the platform hard-
//      killed the function before its own timeout code could fire — producing
//      an orphaned 'processing' row with no logged reason. We gate on whether
//      the REMAINING budget can absorb the next wave's absolute worst case.
//
//   2. THE CIRCUIT BREAKER FAILS CLOSED. A control row we cannot read is
//      treated as paused. Three consecutive bad runs auto-pause. This is the
//      only cost protection that works when nobody is watching, and a runaway
//      loop here means Opus 5 calls across 45 campuses.
//
// One deliberate difference from Health: Health drains items sequentially
// because each medication lookup takes 35-40s. Cards take ~14s, so this drains
// in PARALLEL WAVES. That also improves the budget maths — because a wave runs
// concurrently, the worst case for a wave equals the worst case for a single
// item, not the sum of the wave.
// ═══════════════════════════════════════════════════════════════════════════

const shared = require("./ai.js")._shared;
const { supabaseRequest, eqFilter, callClaude, buildPromptFor, planItemsFor } = shared;

// ── BUDGET CONSTANTS ─────────────────────────────────────────────────────────
// maxDuration for this function is 180s (see vercel.json), deliberately BELOW
// the 300s Hobby ceiling rather than maxed to it. Headroom is what turns a
// hard platform kill into a clean, logged stop.
//
// When the account moves to Pro in January these numbers are the only thing
// that changes — the architecture does not. That is the point of the drain:
// the platform ceiling is a tuning parameter, not a design constraint.
const FUNCTION_BUDGET_MS = 180000;

// Absolute worst case for one card. Observed generation is ~14s at "standard"
// power; this is ~3x headroom, and also covers the slower "deep"/"max" dial
// settings without needing to be retuned.
const CARD_TIMEOUT_MS = 45000;

// Room to write results, update the job row, and build a response after the
// last wave finishes.
const RESPONSE_OVERHEAD_MS = 12000;

// Cards generated concurrently per wave. Modest on purpose: enough to collapse
// 33 serial calls into a handful of waves, low enough not to trip Anthropic
// rate limits when several campuses run at once.
const WAVE_SIZE = 5;

// A card that has failed this many times is left failed rather than retried
// forever. Retries bill on every attempt, including truncated responses.
const MAX_ITEM_ATTEMPTS = 3;

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*"
};

// ── CIRCUIT BREAKER ──────────────────────────────────────────────────────────

async function readControl() {
  const r = await supabaseRequest("GET", "/rest/v1/generation_control?id=eq.1&select=*");
  if (!r.ok || !Array.isArray(r.data) || r.data.length === 0) {
    // FAIL CLOSED. An unreadable control row is treated as paused. The
    // alternative — assuming it is safe to proceed — is how an outage during a
    // database problem turns into unbounded spend.
    return { ok: false, paused: true, reason: "control row unreadable: " + (r.error || "not found"), row: null };
  }
  const row = r.data[0];
  return { ok: true, paused: !!row.paused, reason: row.paused_reason || null, row };
}

async function recordRun(wasBad, summary) {
  const control = await readControl();
  const prior = control.row ? (control.row.consecutive_bad_runs || 0) : 0;
  const next = wasBad ? prior + 1 : 0;
  const patch = {
    consecutive_bad_runs: next,
    last_run_at: new Date().toISOString(),
    last_run_summary: String(summary || "").slice(0, 500)
  };
  // Three consecutive bad runs pauses the queue without anyone watching.
  if (next >= 3) {
    patch.paused = true;
    patch.paused_reason = `Auto-paused after ${next} consecutive failed runs. Last: ${String(summary || "").slice(0, 200)}`;
    patch.paused_at = new Date().toISOString();
    patch.paused_by = "circuit-breaker";
  }
  await supabaseRequest("PATCH", "/rest/v1/generation_control?id=eq.1", { body: patch });
  return next;
}

// ── JOB CLAIMING ─────────────────────────────────────────────────────────────

// How long a job's heartbeat must be silent before another drain may take it
// over. Must exceed the longest plausible gap between heartbeats — one wave,
// which is one card's worst case plus overhead.
const HEARTBEAT_STALE_MS = 90000;

async function claimNextJob() {
  // Release anything a hard-killed invocation left stranded, so a crashed run
  // cannot block the queue permanently.
  await supabaseRequest("POST", "/rest/v1/rpc/release_stale_generation_jobs", { body: {} });

  // Eligible = never started, OR started but gone quiet. Without the heartbeat
  // condition, the 1-minute cron would claim a job that a previous invocation
  // is still actively draining — a ~100s cold job overlaps the next tick by
  // ~40s — and both would generate the same in-flight cards. The unique index
  // prevents duplicate ROWS but not duplicate Opus 5 calls, so this is a
  // spending bug, not just a correctness one.
  const staleBefore = new Date(Date.now() - HEARTBEAT_STALE_MS).toISOString();
  const r = await supabaseRequest(
    "GET",
    "/rest/v1/generation_jobs?select=*&order=created_at.asc&limit=1" +
    `&or=(status.eq.pending,and(status.eq.processing,heartbeat_at.lt.${encodeURIComponent(staleBefore)}))`
  );
  if (!r.ok || !Array.isArray(r.data) || r.data.length === 0) return null;
  const job = r.data[0];

  const patch = {
    status: "processing",
    heartbeat_at: new Date().toISOString()
  };
  if (!job.started_at) patch.started_at = new Date().toISOString();
  if (job.status === "pending") patch.attempts = (job.attempts || 0) + 1;

  const upd = await supabaseRequest("PATCH", `/rest/v1/generation_jobs?id=${eqFilter(job.id)}`, {
    body: patch,
    prefer: "return=representation"
  });
  if (!upd.ok) return null;
  return job;
}

async function heartbeat(jobId) {
  await supabaseRequest("PATCH", `/rest/v1/generation_jobs?id=${eqFilter(jobId)}`, {
    body: { heartbeat_at: new Date().toISOString() }
  });
}

async function pendingItems(jobId) {
  const r = await supabaseRequest(
    "GET",
    `/rest/v1/generation_items?job_id=${eqFilter(jobId)}&status=eq.pending&select=*&order=position.asc`
  );
  if (!r.ok || !Array.isArray(r.data)) return [];
  return r.data.filter((it) => (it.attempts || 0) < MAX_ITEM_ATTEMPTS);
}

// ── SHARED CARD CACHE ────────────────────────────────────────────────────────
// M1/M2/M3 are identical for everyone with that combination, so at 45 campuses
// the same card is reused thousands of times. Checking the cache before
// generating is the entire economic basis for running Opus 5 here.

async function readCache(cacheKey) {
  const parts = String(cacheKey).split("|");
  if (parts.length < 3) return null;
  const r = await supabaseRequest(
    "GET",
    `/rest/v1/card_cache?matrix=${eqFilter(parts[0])}&key_a=${eqFilter(parts[1])}&key_b=${eqFilter(parts.slice(2).join("|"))}&select=card&limit=1`
  );
  if (!r.ok || !Array.isArray(r.data) || r.data.length === 0) return null;
  return r.data[0].card || null;
}

async function writeCache(cacheKey, card) {
  const parts = String(cacheKey).split("|");
  if (parts.length < 3) return;
  await supabaseRequest("POST", "/rest/v1/card_cache?on_conflict=matrix,key_a,key_b", {
    body: [{ matrix: parts[0], key_a: parts[1], key_b: parts.slice(2).join("|"), card }],
    prefer: "resolution=merge-duplicates"
  });
}

// ── CARD GENERATION ──────────────────────────────────────────────────────────

function extractCard(response) {
  if (!response || response.error) {
    return { ok: false, error: (response && response.error && response.error.message) || "no response" };
  }
  if (!Array.isArray(response.content) || response.content.length === 0) {
    return { ok: false, error: "EMPTY_CONTENT stop_reason=" + response.stop_reason };
  }
  if (response.stop_reason === "max_tokens") {
    return { ok: false, error: "TRUNCATED — hit max_tokens ceiling" };
  }
  let text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("")
    .trim()
    .replace(/```json|```/g, "")
    .trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1) return { ok: false, error: "NO_JSON: " + text.slice(0, 120) };
  try {
    return { ok: true, card: JSON.parse(text.slice(first, last + 1)) };
  } catch (e) {
    return { ok: false, error: "BAD_JSON: " + e.message };
  }
}

// Never throws. A rejected promise inside a wave would take down the whole
// wave, losing cards that had already succeeded.
async function processItem(item) {
  try {
    if (item.cacheable) {
      const cached = await readCache(item.cache_key);
      if (cached) return { id: item.id, ok: true, card: cached, cached: true };
    }

    const prompt = buildPromptFor(item.kind, item.params);
    if (!prompt) return { id: item.id, ok: false, error: "unknown item kind: " + item.kind };

    const response = await withTimeout(callClaude(prompt), CARD_TIMEOUT_MS);
    const parsed = extractCard(response);
    if (!parsed.ok) return { id: item.id, ok: false, error: parsed.error };

    if (item.cacheable) await writeCache(item.cache_key, parsed.card);
    return { id: item.id, ok: true, card: parsed.card, cached: false };
  } catch (e) {
    return { id: item.id, ok: false, error: (e && e.message) || "exception" };
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`card generation exceeded ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function saveItemResult(item, outcome) {
  const patch = outcome.ok
    ? { status: "done", result: outcome.card, finished_at: new Date().toISOString(), last_error: null }
    : {
        status: (item.attempts || 0) + 1 >= MAX_ITEM_ATTEMPTS ? "failed" : "pending",
        attempts: (item.attempts || 0) + 1,
        last_error: String(outcome.error || "").slice(0, 300)
      };
  if (outcome.ok) patch.attempts = (item.attempts || 0) + 1;
  const r = await supabaseRequest("PATCH", `/rest/v1/generation_items?id=${eqFilter(item.id)}`, { body: patch });
  return r.ok;
}

// ── JOB COMPLETION ───────────────────────────────────────────────────────────
// Reassembles finished items into the aiData shape the frontend already
// expects, then writes the profile. Deliberately reuses the existing profile
// table rather than introducing a second place a profile can live.

function assembleProfile(job, items) {
  const byKind = (k) => items.filter((i) => i.kind === k && i.status === "done");
  const one = (k) => { const m = byKind(k); return m.length ? m[0].result : null; };
  const keyed = (k, field) => {
    const out = {};
    for (const it of byKind(k)) {
      const p = it.params || {};
      out[p[field]] = it.result;
    }
    return out;
  };

  // m2Data uses FLAT pipe-delimited keys ("Strategic|Wisdom"), not nesting.
  // This must match how index.html reads it — state.m2Data[`${s}|${g}`] — or
  // every M2 card renders blank while the profile looks correctly saved.
  const m2Data = {};
  for (const it of byKind("m2")) {
    const p = it.params || {};
    m2Data[`${p.strength}|${p.gift}`] = it.result;
  }

  return {
    m1Data: keyed("m1", "strength"),
    m2Data,
    m3Data: keyed("m3", "gift"),
    m4Data: one("m4"),
    m4Cards: keyed("m4str", "strength"),
    m1Summary: one("m1sum"),
    m2Summary: one("m2sum"),
    m3Summary: one("m3sum"),
    m4Bonus: one("m4bonus")
  };
}

async function finishJob(job) {
  const r = await supabaseRequest(
    "GET",
    `/rest/v1/generation_items?job_id=${eqFilter(job.id)}&select=*&order=position.asc`
  );
  if (!r.ok || !Array.isArray(r.data)) return { ok: false, error: "could not read items to assemble" };

  const items = r.data;
  const failed = items.filter((i) => i.status === "failed");
  const pending = items.filter((i) => i.status === "pending");
  if (pending.length > 0) return { ok: false, error: "still pending", pending: pending.length };

  // A profile with failed cards is NOT saved. This is the July 26 data
  // corruption lesson: a partially-failed run used to persist placeholder
  // filler into the participant's permanent profile, and it was
  // indistinguishable from real output forever after.
  if (failed.length > 0) {
    await supabaseRequest("PATCH", `/rest/v1/generation_jobs?id=${eqFilter(job.id)}`, {
      body: {
        status: "failed",
        finished_at: new Date().toISOString(),
        last_error: `${failed.length} card(s) failed: ${failed.map((f) => f.cache_key).slice(0, 5).join(", ")}`
      }
    });
    return { ok: false, error: `${failed.length} cards failed`, failed: failed.length };
  }

  const p = job.participant || {};
  const now = new Date().toISOString();
  const profileRow = {
    email: String(job.email || "").toLowerCase().trim(),
    name: String(p.name || ""),
    personality: String(p.personality || ""),
    strengths: Array.isArray(p.strengths) ? p.strengths : [],
    gifts: Array.isArray(p.gifts) ? p.gifts : [],
    ai_data: assembleProfile(job, items),
    saved_at: now,
    updated_at: now
  };

  const save = await supabaseRequest("POST", "/rest/v1/participant_profiles?on_conflict=email", {
    body: [profileRow],
    prefer: "resolution=merge-duplicates,return=representation"
  });
  if (!save.ok) return { ok: false, error: "profile write failed: " + save.error };

  await supabaseRequest("PATCH", `/rest/v1/generation_jobs?id=${eqFilter(job.id)}`, {
    body: { status: "complete", finished_at: new Date().toISOString(), last_error: null }
  });
  return { ok: true };
}

// ── THE DRAIN ────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  const startedAt = Date.now();
  const send = (status, payload) => {
    for (const [k, v] of Object.entries(JSON_HEADERS)) res.setHeader(k, v);
    return res.status(status).json(payload);
  };

  // Only the cron job and the admin panel should be able to trigger this.
  const secret = process.env.DRAIN_SECRET;
  if (secret) {
    const provided = req.headers["x-drain-secret"] ||
      (req.body && typeof req.body === "object" && req.body.secret);
    if (provided !== secret) return send(401, { error: "unauthorized" });
  }

  const control = await readControl();
  if (control.paused) {
    return send(200, { skipped: true, reason: "paused: " + (control.reason || "unspecified") });
  }

  let job;
  try {
    job = await claimNextJob();
  } catch (e) {
    await recordRun(true, "claim failed: " + e.message);
    return send(500, { error: "claim failed: " + e.message });
  }
  if (!job) return send(200, { idle: true, message: "no jobs waiting" });

  const deadline = startedAt + FUNCTION_BUDGET_MS;
  const needPerWave = CARD_TIMEOUT_MS + RESPONSE_OVERHEAD_MS;

  let generated = 0, fromCache = 0, failedCount = 0, waves = 0;
  let stoppedForBudget = false;

  try {
    let queue = await pendingItems(job.id);

    while (queue.length > 0) {
      // THE BUDGET GATE. Ask whether the remaining budget can absorb this
      // wave's absolute worst case — not whether some elapsed threshold has
      // been crossed. Because the wave runs concurrently, its worst case is
      // one card's timeout, not the sum of the wave.
      if (Date.now() + needPerWave > deadline) { stoppedForBudget = true; break; }

      const wave = queue.splice(0, WAVE_SIZE);
      waves++;

      const outcomes = await Promise.all(wave.map(processItem));

      for (let i = 0; i < wave.length; i++) {
        const o = outcomes[i];
        await saveItemResult(wave[i], o);
        if (o.ok) { generated++; if (o.cached) fromCache++; }
        else failedCount++;
      }

      await heartbeat(job.id);
    }

    // Recount from the database rather than from local tallies — the numbers
    // that matter are the ones actually persisted.
    const counted = await supabaseRequest(
      "GET",
      `/rest/v1/generation_items?job_id=${eqFilter(job.id)}&select=status`
    );
    const rows = (counted.ok && Array.isArray(counted.data)) ? counted.data : [];
    const doneCount = rows.filter((r) => r.status === "done").length;
    const stillPending = rows.filter((r) => r.status === "pending").length;

    await supabaseRequest("PATCH", `/rest/v1/generation_jobs?id=${eqFilter(job.id)}`, {
      body: {
        done_items: doneCount,
        total_items: rows.length,
        heartbeat_at: new Date().toISOString(),
        status: stillPending > 0 ? "processing" : "processing"
      }
    });

    let finished = null;
    if (stillPending === 0) finished = await finishJob(job);

    const summary = `job=${job.id} generated=${generated} cached=${fromCache} failed=${failedCount} waves=${waves} pending=${stillPending}${stoppedForBudget ? " (budget)" : ""}`;

    // A run is "bad" only if it did real work and all of it failed. Stopping
    // cleanly for budget is the system working correctly, not a failure.
    const wasBad = failedCount > 0 && generated === 0;
    await recordRun(wasBad, summary);

    return send(200, {
      jobId: job.id,
      generated,
      fromCache,
      failed: failedCount,
      waves,
      pending: stillPending,
      stoppedForBudget,
      complete: stillPending === 0,
      finished,
      elapsedMs: Date.now() - startedAt
    });

  } catch (e) {
    await supabaseRequest("PATCH", `/rest/v1/generation_jobs?id=${eqFilter(job.id)}`, {
      body: { status: "pending", last_error: String(e.message || e).slice(0, 300) }
    });
    await recordRun(true, "drain threw: " + e.message);
    return send(500, { error: "drain failed: " + e.message, jobId: job.id });
  }
};

module.exports._internal = {
  extractCard,
  assembleProfile,
  withTimeout,
  FUNCTION_BUDGET_MS,
  CARD_TIMEOUT_MS,
  RESPONSE_OVERHEAD_MS,
  WAVE_SIZE,
  MAX_ITEM_ATTEMPTS,
  HEARTBEAT_STALE_MS
};

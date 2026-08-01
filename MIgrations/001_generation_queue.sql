-- ═══════════════════════════════════════════════════════════════════════════
-- Kingdom Leadership Discovery — server-side generation queue
-- Migration 001 · July 31, 2026
--
-- WHY THIS EXISTS
-- Card generation was driven by the browser: 33 sequential fetch() calls from
-- index.html. On iOS Safari a backgrounded tab is suspended, so a participant
-- who locked their phone or took a call lost the entire run and had to start
-- over. At a conference that is most of the room.
--
-- These tables move the work server-side. The browser enqueues a job and then
-- only polls. A cron-driven drain does the generating, writing each card the
-- moment it completes, so a run that is interrupted resumes where it stopped
-- instead of restarting.
--
-- Run this ONCE in the Supabase SQL editor before deploying api/drain.js.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── JOBS ─────────────────────────────────────────────────────────────────────
-- One row per participant profile generation. FIFO by created_at: a job is
-- drained to completion before the next one starts. That is deliberate — at a
-- conference it is better for person 1 to be finished than for everyone to be
-- half done.
create table if not exists generation_jobs (
  id             uuid primary key default gen_random_uuid(),
  email          text not null,
  participant    jsonb not null,          -- { name, personality, strengths[], gifts[] }
  status         text not null default 'pending'
                 check (status in ('pending','processing','complete','failed')),
  total_items    integer not null default 0,
  done_items     integer not null default 0,
  attempts       integer not null default 0,
  last_error     text,
  created_at     timestamptz not null default now(),
  started_at     timestamptz,
  finished_at    timestamptz,
  heartbeat_at   timestamptz
);

-- The drain claims the oldest unfinished job. This index makes that O(1).
create index if not exists generation_jobs_queue_idx
  on generation_jobs (status, created_at)
  where status in ('pending','processing');

create index if not exists generation_jobs_email_idx on generation_jobs (email);

-- ── WORK ITEMS ───────────────────────────────────────────────────────────────
-- One row per card. Written the moment it completes, which is what makes a
-- job resumable: a drain killed mid-run loses only the cards still in flight.
create table if not exists generation_items (
  id             bigserial primary key,
  job_id         uuid not null references generation_jobs(id) on delete cascade,
  kind           text not null
                 check (kind in ('m1','m2','m3','m1sum','m2sum','m3sum','m4','m4bonus','m4str')),
  cache_key      text not null,           -- e.g. "m1|Strategic|ENTJ-A"
  params         jsonb not null,
  cacheable      boolean not null default false,
  status         text not null default 'pending'
                 check (status in ('pending','done','failed')),
  result         jsonb,
  attempts       integer not null default 0,
  last_error     text,
  position       integer not null default 0,
  created_at     timestamptz not null default now(),
  finished_at    timestamptz
);

create index if not exists generation_items_job_idx
  on generation_items (job_id, status, position);

-- A job must never contain the same card twice.
create unique index if not exists generation_items_job_key_idx
  on generation_items (job_id, cache_key);

-- ── CIRCUIT BREAKER ──────────────────────────────────────────────────────────
-- Singleton. The drain reads this BEFORE claiming any work and FAILS CLOSED:
-- a row it cannot read is treated as paused, never as safe-to-proceed. Three
-- consecutive bad runs auto-pause without anyone watching. This is the only
-- protection that works when Seth is not the one running the app — and a
-- runaway loop here is Opus 5 calls across 45 campuses.
create table if not exists generation_control (
  id                   integer primary key default 1 check (id = 1),
  paused               boolean not null default false,
  paused_reason        text,
  paused_at            timestamptz,
  paused_by            text,
  consecutive_bad_runs integer not null default 0,
  last_run_at          timestamptz,
  last_run_summary     text
);

insert into generation_control (id, paused) values (1, false)
  on conflict (id) do nothing;

-- ── SECURITY ─────────────────────────────────────────────────────────────────
-- Every one of these tables is touched ONLY by the serverless function using
-- the service_role key. No browser ever reads them directly. RLS is enabled
-- with no permissive policy for anon/authenticated, so a leaked publishable
-- key exposes nothing here.
--
-- Explicit grants are included deliberately: a missing grant surfaces as a 401
-- that looks exactly like an auth-configuration failure and costs a debugging
-- session to identify.
alter table generation_jobs    enable row level security;
alter table generation_items   enable row level security;
alter table generation_control enable row level security;

grant all on generation_jobs    to service_role;
grant all on generation_items   to service_role;
grant all on generation_control to service_role;
grant usage, select on sequence generation_items_id_seq to service_role;

revoke all on generation_jobs    from anon, authenticated;
revoke all on generation_items   from anon, authenticated;
revoke all on generation_control from anon, authenticated;

-- ── STALE JOB RECOVERY ───────────────────────────────────────────────────────
-- If a drain is hard-killed by the platform mid-job, the job stays 'processing'
-- with a stale heartbeat and would otherwise block the queue forever. This
-- releases anything untouched for 5 minutes back to 'pending'. Items already
-- marked done are untouched, so a released job resumes rather than restarts.
create or replace function release_stale_generation_jobs()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  released integer;
begin
  update generation_jobs
     set status = 'pending'
   where status = 'processing'
     and coalesce(heartbeat_at, started_at, created_at) < now() - interval '5 minutes';
  get diagnostics released = row_count;
  return released;
end;
$$;

revoke all on function release_stale_generation_jobs() from public, anon, authenticated;
grant execute on function release_stale_generation_jobs() to service_role;

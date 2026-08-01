// Tests for the browser-side queue flow (Phase B, July 31 2026).
// Pure logic, no network. Run: node verify_queue_flow.js

const fs = require("fs");
const html = fs.readFileSync("./index.html", "utf8");
const src = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"));

let pass = 0, fail = 0;
function t(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else { fail++; console.log(`  FAIL: ${label}\n    expected ${e}\n    got      ${a}`); }
}
function ok(label, cond) { t(label, !!cond, true); }

console.log("\n-- the browser no longer orchestrates generation --");
// The whole point of Phase B: generate() must submit ONE request, not drive 33.
const genFn = src.match(/async function generate\(\)[\s\S]*?\n\}/)[0];
ok("generate enqueues a job", /action: "enqueueJob"/.test(genFn));
ok("generate no longer loops over strengths", !/for \(const s of p\.strengths\)/.test(genFn));
ok("generate no longer calls callAI directly", !/await callAI\(/.test(genFn));
ok("generate no longer calls callAILegacy", !/callAILegacy/.test(genFn));
ok("generate sends the participant payload", /participant: \{/.test(genFn));
ok("generate switches to the waiting view", /state\.view = "waiting"/.test(genFn));

console.log("\n-- placeholder filler is gone --");
// The old flow substituted hardcoded text on failure, which then got saved and
// was indistinguishable from real output forever (the July 26 corruption bug).
// The server now refuses to save a job with any failed card, so the browser
// must not reintroduce filler.
ok("no _failed placeholder objects in generate", !/_failed:true/.test(genFn));
ok("no hardcoded 'unique contribution' filler", !/A unique contribution/.test(genFn));
ok("no hardcoded 'Kingdom Servant Leader' filler", !/Kingdom Servant Leader/.test(genFn));

console.log("\n-- polling behaviour --");
const pollFn = src.match(/async function pollJobOnce\(\)[\s\S]*?\n\}/)[0];
// A transient network blip must not be reported as a failed profile.
ok("a null response keeps polling", /jobPollTimer = setTimeout\(pollJobOnce/.test(pollFn));
ok("complete stops polling", /stopJobPolling\(\)/.test(pollFn));
ok("complete loads the real profile", /loadFinishedProfile\(\)/.test(pollFn));
ok("failed surfaces the server's reason", /r\.job\.error/.test(pollFn));
ok("failed does not show a profile", /state\.view = "entry"/.test(pollFn));

const interval = parseInt((src.match(/const POLL_INTERVAL_MS = (\d+)/) || [])[1], 10);
ok("poll interval is defined", !isNaN(interval));
ok("poll interval is not aggressive", interval >= 2000);
ok("poll interval is responsive enough", interval <= 10000);

console.log("\n-- resume after closing the tab --");
const resumeFn = src.match(/async function resumeJobIfRunning\([\s\S]*?\n\}/)[0];
ok("resume checks job status", /action: "jobStatus"/.test(resumeFn));
ok("resume rejoins a pending job", /"pending"/.test(resumeFn));
ok("resume rejoins a processing job", /"processing"/.test(resumeFn));
ok("resume restarts polling", /startJobPolling\(\)/.test(resumeFn));
// Login must consult it BEFORE offering a fresh entry form, or the participant
// starts a second job and pays for the same profile twice.
const loginFlow = src.match(/const approved = await isEmailApproved[\s\S]*?state\.view="entry"; \}/)[0];
ok("login checks for a running job", /resumeJobIfRunning/.test(loginFlow));
ok("login checks it before loading a profile", loginFlow.indexOf("resumeJobIfRunning") < loginFlow.indexOf("loadProfile"));

console.log("\n-- a finished job must produce a real profile --");
const loadFn = src.match(/async function loadFinishedProfile\(\)[\s\S]*?\n\}/)[0];
ok("missing profile is reported, not shown empty", /could not be loaded/.test(loadFn));
ok("missing profile does not land on the profile view", /state\.view = "entry"/.test(loadFn));
ok("a real profile restores state", /restoreProfileToState/.test(loadFn));
ok("a real profile sets the profile view", /state\.view = "profile"/.test(loadFn));

console.log("\n-- the waiting screen --");
const waitFn = src.match(/function buildWaiting\(\)[\s\S]*?\n\}/)[0];
// The single most valuable line on the screen: permission to leave.
ok("tells the participant they can close the page", /close this page/i.test(waitFn));
ok("explains work happens on the server", /servers, not in this browser/i.test(waitFn));
ok("shows queue position", /ahead of you/i.test(waitFn));
ok("shows card progress", /cards complete/i.test(waitFn));
ok("handles being next in line", /next in line/i.test(waitFn));
ok("singular vs plural for one person", /person is/.test(waitFn) && /people are/.test(waitFn));
ok("no mojibake in the waiting screen", !/[^\x00-\x7F]/.test(waitFn.replace(/&[a-z]+;/g, "")));

console.log("\n-- wiring --");
ok("waiting view is in the render dispatch", /if \(state\.view === "waiting"\) return buildWaiting\(\)/.test(src));
ok("generate is bound to the button", /getElementById\("btnGenerate"\)\?\.addEventListener\("click", generate\)/.test(src));
ok("job state is initialised", /job: null,/.test(src));
ok("jobPolling state is initialised", /jobPolling: false,/.test(src));

console.log("\n-- no orphaned code from the replaced function --");
// The old generate() ended with a save block. If its tail survived the
// replacement it would be unreachable code referencing undefined variables.
ok("no stray 'state.profileAge = 0;' outside a function", !/^\s{6}state\.profileAge = 0;/m.test(src));
const braces = (src.match(/\{/g) || []).length - (src.match(/\}/g) || []).length;
t("braces balance across the script", braces, 0);

console.log("\n-- refresh recovery (session) --");
// A refresh used to reset state and dump the participant on the landing page,
// which looks exactly like the app losing their work mid-generation.
ok("startup is initApp, not a bare render", /<script>initApp\(\);<\/script>/.test(html));
ok("bare render() startup is gone", !/<script>render\(\);<\/script>/.test(html));

const initFn = src.match(/async function initApp\(\)[\s\S]*?\n\}/)[0];
ok("startup reads the stored session", /readSession\(\)/.test(initFn));
ok("no session goes straight to render", /if \(!email\) \{ render\(\); return; \}/.test(initFn));
// A stored email is a hint, never proof. Approval must be re-checked because
// access can be revoked between visits.
ok("startup re-checks approval", /isEmailApproved\(email\)/.test(initFn));
ok("revoked access clears the session", /clearSession\(\)/.test(initFn));
ok("a verification error does not silently deny", /=== "error"/.test(initFn));
// Priority order matters: a running job outranks a finished profile, or
// someone mid-generation would be shown a stale profile instead.
ok("startup rejoins a running job", /resumeJobIfRunning\(email\)/.test(initFn));
ok("job check comes before profile load", initFn.indexOf("resumeJobIfRunning") < initFn.indexOf("loadProfile"));
ok("falls back to the entry form", /state\.view = "entry"/.test(initFn));
ok("startup failure never strands a blank screen", /catch \(e\)/.test(initFn));

console.log("\n-- session hygiene --");
const saveFn = src.match(/function saveSession\([\s\S]*?\n\}/)[0];
ok("admin session is never persisted", /admin@kingdom/.test(saveFn));
ok("storage failure is tolerated (private mode)", /catch \(e\)/.test(saveFn));
ok("readSession tolerates storage failure", /function readSession[\s\S]*?catch \(e\) \{ return null; \}/.test(src));
ok("login stores the session", /saveSession\(email\)/.test(src));
// Both sign-out paths must clear it, or the next visitor on a shared device
// resumes someone else's session.
const headerLogout = src.match(/getElementById\("btnHeaderLogout"\)[\s\S]*?\n  \}\);/)[0];
const adminLogout  = src.match(/getElementById\("btnAdminLogout"\)[\s\S]*?\n  \}\);/)[0];
ok("participant sign-out clears the session", /clearSession\(\)/.test(headerLogout));
ok("admin sign-out clears the session", /clearSession\(\)/.test(adminLogout));
// Polling must stop on sign-out or it keeps running against the old identity.
ok("participant sign-out stops polling", /stopJobPolling\(\)/.test(headerLogout));
ok("admin sign-out stops polling", /stopJobPolling\(\)/.test(adminLogout));
ok("participant sign-out clears the job", /state\.job=null/.test(headerLogout));

console.log("\n-- returning to a throttled tab --");
// Background tabs throttle timers. Without this, a finished profile can take
// an extra minute to appear after the participant comes back.
ok("visibilitychange is handled", /visibilitychange/.test(src));
ok("returning re-polls immediately", /if \(!document\.hidden && state\.jobPolling\)/.test(src));

console.log("\n-- restoring view --");
ok("restoring view is in the dispatch", /state\.view === "restoring"/.test(src));
ok("restoring view avoids a landing-page flash", /finding your profile/i.test(src));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

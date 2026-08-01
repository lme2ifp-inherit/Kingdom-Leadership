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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

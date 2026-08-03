// Tests for the admin generation-queue panel (July 31 2026).
// Pure logic, no network. Run from the repo root: node scripts/verify_admin_queue.js

// Paths resolve from this file, not the working directory, so the suite runs
// correctly from the repo root or from inside scripts/.
const ROOT = require("path").join(__dirname, "..");

const fs = require("fs");
const html = fs.readFileSync(ROOT + "/index.html", "utf8");
const src = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"));

let pass = 0, fail = 0;
function t(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else { fail++; console.log(`  FAIL: ${label}\n    expected ${e}\n    got      ${a}`); }
}
function ok(label, cond) { t(label, !!cond, true); }

const panel = src.match(/function buildQueuePanel\(\)[\s\S]*?\n\}\n\nlet queueAutoTimer/)[0];

console.log("\n-- panel is wired in --");
ok("panel is rendered inside the admin page", /\$\{buildQueuePanel\(\)\}/.test(src));
ok("queueAdmin state exists", /queueAdmin: null,/.test(src));
ok("adminAuth state exists", /adminAuth: null,/.test(src));

console.log("\n-- paused state is unmissable --");
// If the queue is paused during a conference, nothing generates for anyone.
// That fact must not be subtle.
ok("paused shows an explicit warning", /Queue is PAUSED/.test(panel));
ok("paused explains the consequence", /nothing is generating/i.test(panel));
ok("paused shows the recorded reason", /paused_reason/.test(panel));
ok("paused shows when and who", /paused_at/.test(panel) && /paused_by/.test(panel));
ok("running state is shown too", /Queue is running/.test(panel));

console.log("\n-- circuit breaker visibility --");
// Three consecutive bad runs auto-pauses. Seeing 2 is the warning that matters.
ok("consecutive bad runs are surfaced", /consecutive_bad_runs/.test(panel));
ok("auto-pause threshold is stated", /auto-pauses at 3/.test(panel));
ok("last drain summary is shown", /last_run_summary/.test(panel));

console.log("\n-- pause is guarded --");
const pauseHandler = src.match(/getElementById\("btnQueuePause"\)[\s\S]*?\n  \}\);/)[0];
ok("pause asks for confirmation", /confirm\(/.test(pauseHandler));
// The confirmation must say how many people it affects — pausing with a room
// waiting is a different decision from pausing an idle queue.
ok("confirmation counts waiting participants", /currently waiting/.test(pauseHandler));
ok("confirmation reassures nothing is lost", /Nothing is lost/.test(pauseHandler));
ok("resume resets the failure counter in its message", /failed-run counter has been reset/.test(src));

console.log("\n-- authentication --");
// These actions are password-gated server-side. adminPwdInput is wiped right
// after login, so using it would send an empty password and 401 every time.
ok("queue calls use the retained password", /password: state\.adminAuth/.test(src));
ok("queue calls do NOT use the wiped input", !/action: action \|\| "queueStatus", password: state\.adminPwdInput/.test(src));
ok("password is retained only after verification", /res && res\.valid[\s\S]{0,300}state\.adminAuth = pwd/.test(src));
// It must never be persisted — a refresh should require re-entering it.
ok("admin password is never written to storage", !/localStorage\.setItem\([^)]*adminAuth/.test(src));
ok("session helper refuses the admin account", /admin@kingdom/.test(src.match(/function saveSession\([\s\S]*?\n\}/)[0]));

console.log("\n-- cleanup on sign-out --");
const headerLogout = src.match(/getElementById\("btnHeaderLogout"\)[\s\S]*?\n  \}\);/)[0];
const adminLogout  = src.match(/getElementById\("btnAdminLogout"\)[\s\S]*?\n  \}\);/)[0];
for (const [name, h] of [["participant", headerLogout], ["admin", adminLogout]]) {
  ok(`${name} sign-out clears the admin password`, /state\.adminAuth=null/.test(h));
  ok(`${name} sign-out stops the auto-refresh`, /stopQueueAuto\(\)/.test(h));
  ok(`${name} sign-out drops cached queue data`, /state\.queueAdmin=null/.test(h));
}

console.log("\n-- auto-refresh does not leak --");
const autoHandler = src.match(/getElementById\("chkQueueAuto"\)[\s\S]*?\n  \}\);/)[0];
ok("previous timer is cleared before starting", /stopQueueAuto\(\)/.test(autoHandler));
// A timer that keeps polling after navigating away is a silent background
// load on the server for as long as the tab stays open.
ok("timer stops when leaving the admin view", /state\.view !== "admin"/.test(autoHandler));
const period = parseInt((autoHandler.match(/\}, (\d+)\)/) || [])[1], 10);
ok("refresh period is defined", !isNaN(period));
ok("refresh period is not aggressive", period >= 3000);

console.log("\n-- output is escaped --");
// Participant emails and server error text are rendered here. Both are
// attacker-influenced in principle and neither should be able to inject markup.
ok("an escape helper exists", /const esc = \(s\)/.test(panel));
ok("escapes ampersands first", /replace\(\/&\/g, "&amp;"\)/.test(panel));
ok("escapes angle brackets", /replace\(\/</.test(panel));
ok("email is escaped", /esc\(j\.email\)/.test(panel));
ok("job error is escaped", /esc\(String\(j\.last_error\)/.test(panel));
ok("pause reason is escaped", /esc\(c\.paused_reason/.test(panel));

console.log("\n-- failure to load is reported --");
const loadFn = src.match(/async function loadQueueStatus\([\s\S]*?\n\}/)[0];
ok("a failed load surfaces the real reason", /fnErrorText/.test(loadFn));
ok("a failed load does not blank existing data", /state\.queueAdmin = state\.queueAdmin \|\| null/.test(loadFn));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

// Boundary tests for the facilitator.html sign-out control.
// Run: node verify_signout.js
//
// The point of these tests: signing out must leave NO library content and NO
// participant selections reachable in memory. A "logout" that only changes the
// view is not a logout -- the data would still be one re-render away.

const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "facilitator.html"), "utf8");
const open = html.indexOf("<script>");
const close = html.indexOf("</script>");
const script = html.slice(open + 8, close);

let pass = 0, fail = 0;
const results = [];
function check(name, fn) {
  let problem = null;
  try { problem = fn(); } catch (e) { problem = "threw: " + e.message; }
  if (problem) { fail++; results.push("FAIL  " + name + " -- " + problem); }
  else { pass++; results.push("ok    " + name); }
}

// --- Static checks on the markup ------------------------------------------

check("sign-out control exists in the tool view", () =>
  /id="signout"/.test(html) ? null : "no #signout element");

check("sign-out is a real button, not a bare div", () =>
  /<button[^>]*id="signout"[^>]*type="button"/.test(html)
    ? null : "not a button with type=button (would submit or be untappable)");

check("sign-out is absent from the login view", () => {
  const loginFn = script.slice(script.indexOf("function loginView"),
                               script.indexOf("function picker"));
  return /signout/.test(loginFn) ? "sign-out rendered while signed out" : null;
});

check("sign-out is wired to a handler", () =>
  /getElementById\("signout"\)/.test(script) && /onclick\s*=\s*signOut/.test(script)
    ? null : "control exists but nothing binds it");

// --- Behavioural check: run signOut against a live sandbox ----------------
// Load the real script with DOM calls stubbed, then populate state as though
// a facilitator were mid-session and confirm signOut wipes all of it.

function runSandbox() {
  const els = {};
  const makeEl = () => ({ onclick: null, onfocus: null, oninput: null,
                          onkeydown: null, focus() {}, setSelectionRange() {},
                          dataset: {}, value: "", innerHTML: "" });
  const document = {
    getElementById: (id) => (els[id] = els[id] || makeEl()),
    querySelectorAll: () => [],
  };
  const sandbox = { document, console };
  const vm = require("vm");
  vm.createContext(sandbox);
  // Top-level `let` in a vm context is block-scoped to the script and never
  // becomes a property of the sandbox object -- the test would silently read
  // its own shadow copy instead of the variable signOut actually writes.
  // Rewriting the declarations to `var` makes the real state observable.
  const observable = script.replace(/^(let|const)\s+(LIB|view|email|pwd|loginErr|busy|ME|picked)\b/gm,
                                    "var $2");
  vm.runInContext(observable, sandbox);
  return sandbox;
}

check("signOut clears library, identity, and selections", () => {
  const s = runSandbox();
  s.LIB = { items: { strengths: { Analytical: { essence: "proof" } }, gifts: {} },
            blends: { "Analytical|Wisdom": { recognize: "secret coaching text", ask: "x" } } };
  s.ME = { role: "admin", campusId: null, displayName: "Seth" };
  s.picked = { strengths: ["Analytical", "Command"], gifts: ["Wisdom"] };
  s.email = "admin@example.com";
  s.pwd = "hunter2";
  s.view = "tool";

  s.signOut();

  const problems = [];
  if (s.LIB !== null) problems.push("LIB survived");
  if (s.ME.role !== null || s.ME.displayName !== "") problems.push("identity survived");
  if (s.picked.strengths.length || s.picked.gifts.length) problems.push("selections survived");
  if (s.pwd !== "") problems.push("password survived");
  if (s.email !== "") problems.push("email survived");
  if (s.view !== "login") problems.push("view is " + s.view + ", expected login");
  return problems.length ? problems.join("; ") : null;
});

check("no library content is reachable after signOut", () => {
  const s = runSandbox();
  s.LIB = { items: {}, blends: { "Analytical|Wisdom": { recognize: "secret coaching text" } } };
  s.picked = { strengths: ["Analytical"], gifts: ["Wisdom"] };
  s.view = "tool";
  s.signOut();
  const dump = JSON.stringify({ LIB: s.LIB, ME: s.ME, picked: s.picked });
  return dump.includes("secret coaching text") || dump.includes("Analytical")
    ? "content still reachable in memory" : null;
});

check("signOut leaves no stale error or busy flag", () => {
  const s = runSandbox();
  s.loginErr = "Email or password not recognized.";
  s.busy = true;
  s.signOut();
  if (s.busy !== false) return "busy stuck true -- sign-in button would be dead";
  if (s.loginErr !== "") return "stale error shown on a fresh login screen";
  return null;
});

check("signing out then in again starts clean", () => {
  const s = runSandbox();
  s.LIB = { items: {}, blends: { x: { recognize: "old" } } };
  s.picked = { strengths: ["Command"], gifts: ["Giving"] };
  s.signOut();
  // Simulate a second sign-in populating fresh state.
  s.ME = { role: "facilitator", campusId: "shawnee", displayName: "Ian" };
  return s.picked.strengths.length === 0 && s.ME.displayName === "Ian"
    ? null : "previous session bled into the next";
});

// Nothing may persist across a reload -- that was true before and must stay true.
check("no browser storage is used anywhere", () =>
  /localStorage|sessionStorage|document\.cookie|indexedDB/.test(script)
    ? "page writes to storage; a refresh would no longer clear the library" : null);

console.log(results.join("\n"));
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);

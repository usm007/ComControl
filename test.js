/**
 * Tests for the Communication Controller plugin.
 * Drives the plugin hooks directly with mocked context — no live
 * OpenCode session needed. Run: node test.js
 */
import assert from "node:assert/strict";
import ControllerPlugin from "./plugins/communication-controller.js";

assert.equal(ControllerPlugin.id, "communication-controller", "stable plugin id present");
assert.equal(typeof ControllerPlugin.server, "function", "server entry present");
const CommunicationController = ControllerPlugin.server;

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log("PASS  " + name);
  } catch (err) {
    console.error("FAIL  " + name + " :: " + (err && err.message));
    process.exitCode = 1;
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log("PASS  " + name);
  } catch (err) {
    console.error("FAIL  " + name + " :: " + (err && err.message));
    process.exitCode = 1;
  }
}

const logged = [];
const mockCtx = {
  client: { app: { log: async (e) => logged.push(e) } },
  project: {},
  directory: process.cwd(),
  worktree: process.cwd(),
};

const hooks = await CommunicationController(mockCtx);
assert.ok(hooks["experimental.chat.system.transform"], "system hook present");
assert.ok(hooks["chat.message"], "message hook present");
assert.ok(hooks["command.execute.before"], "command hook present");
assert.ok(hooks.event, "event hook present");
assert.ok(hooks.tool && hooks.tool.communication_set_mode, "mode tool present");
assert.ok(hooks.tool.communication_status, "status tool present");
assert.ok(hooks.tool.communication_reset, "reset tool present");
console.log("PASS  plugin loads with all hooks and tools");
passed++;

function systemFor(sessionID) {
  const output = { system: ["base"] };
  return hooks["experimental.chat.system.transform"]({ sessionID, model: {} }, output).then(() => output.system);
}
function send(sessionID, text) {
  return hooks["chat.message"](
    { sessionID },
    { message: { role: "user", content: text }, parts: [{ type: "text", text }] }
  );
}
function idle(sessionID) {
  return hooks.event({ event: { type: "session.idle", properties: { sessionID } } });
}
async function toolCall(name, args, sessionID) {
  return hooks.tool[name].execute(args || {}, { sessionID, directory: process.cwd(), worktree: process.cwd() });
}

// 1 — Default: new session gets FUNCTIONAL policy, no implementation detail exposure in the policy itself.
await checkAsync("default session injects FUNCTIONAL policy", async () => {
  const sys = await systemFor("sess-default");
  const policy = sys[sys.length - 1];
  assert.match(policy, /FUNCTIONAL/);
  assert.match(policy, /never narrate/i);
  assert.match(policy, /VERIFIED WORKING/);
});

// 2/4 — Explicit technical request temporarily lifts the session.
await checkAsync("explicit code request lifts to TECHNICAL", async () => {
  await send("sess-tech", "Show me the exact code responsible for detecting the video.");
  const sys = await systemFor("sess-tech");
  assert.match(sys[sys.length - 1], /mode: TECHNICAL/);
});

// 3 — Functional request with a technical SUBJECT stays functional.
await checkAsync("technical subject without explicit ask stays FUNCTIONAL", async () => {
  await send("sess-subject", "How does the app let me download a video from a webpage?");
  const sys = await systemFor("sess-subject");
  assert.match(sys[sys.length - 1], /mode: FUNCTIONAL/);
});
await checkAsync("'which component handles' is an explicit ask", async () => {
  await send("sess-which", "Which component handles media detection?");
  const sys = await systemFor("sess-which");
  assert.match(sys[sys.length - 1], /mode: TECHNICAL/);
});

// 5 — Functional policy bans investigation narration.
await checkAsync("functional policy bans narration phrases", async () => {
  const sys = await systemFor("sess-narr");
  const policy = sys[sys.length - 1];
  assert.match(policy, /I'll inspect/);
  assert.match(policy, /Work silently/);
});

// 6/7 — Verification wording present; uncertainty never rewritten.
await checkAsync("verification states present in policy", async () => {
  const sys = await systemFor("sess-ver");
  const policy = sys[sys.length - 1];
  for (const s of ["PARTIALLY WORKING", "NOT FULLY VERIFIED", "NOT VERIFIED", "NOT WORKING"]) {
    assert.ok(policy.includes(s), "missing " + s);
  }
  assert.match(policy, /Never invent verification/);
});

// 8 — Mode switching: pin TECHNICAL via command, persists across idle; reset returns to FUNCTIONAL.
await checkAsync("pinned technical survives idle; reset restores functional", async () => {
  await hooks["command.execute.before"]({ command: "technical", sessionID: "sess-pin", arguments: "" }, { parts: [] });
  let sys = await systemFor("sess-pin");
  assert.match(sys[sys.length - 1], /mode: TECHNICAL/);
  await idle("sess-pin");
  sys = await systemFor("sess-pin");
  assert.match(sys[sys.length - 1], /mode: TECHNICAL/, "pinned mode must survive idle");
  const out = await toolCall("communication_reset", {}, "sess-pin");
  assert.match(out, /FUNCTIONAL/);
  sys = await systemFor("sess-pin");
  assert.match(sys[sys.length - 1], /mode: FUNCTIONAL/);
});

// Auto-detected technical expires at idle (temporary, not forever).
await checkAsync("auto-detected technical reverts to FUNCTIONAL after turn", async () => {
  await send("sess-auto", "Show me the implementation.");
  let sys = await systemFor("sess-auto");
  assert.match(sys[sys.length - 1], /mode: TECHNICAL/);
  await idle("sess-auto");
  sys = await systemFor("sess-auto");
  assert.match(sys[sys.length - 1], /mode: FUNCTIONAL/);
});

// 9 — Session isolation.
await checkAsync("sessions are isolated", async () => {
  await hooks["command.execute.before"]({ command: "technical", sessionID: "sess-A", arguments: "" }, { parts: [] });
  const sysB = await systemFor("sess-B");
  assert.match(sysB[sysB.length - 1], /mode: FUNCTIONAL/);
  const sysA = await systemFor("sess-A");
  assert.match(sysA[sysA.length - 1], /mode: TECHNICAL/);
});

// 10 — Tools round-trip: set/status via tool calls.
await checkAsync("tools switch and report mode", async () => {
  const r1 = await toolCall("communication_set_mode", { mode: "diagnostic" }, "sess-tool");
  assert.match(r1, /DIAGNOSTIC/);
  const r2 = await toolCall("communication_status", {}, "sess-tool");
  assert.match(r2, /Communication mode: DIAGNOSTIC/);
  assert.match(r2, /Verification reporting: enabled/);
  const r3 = await toolCall("communication_set_mode", { mode: "bogus" }, "sess-tool");
  assert.match(r3, /Unknown mode/);
});

// 12 — Error reporting path: tripwire observes but never rewrites.
await checkAsync("text tripwire never mutates answers", async () => {
  const output = { text: "The fix is in src/player.ts in class Player." };
  await hooks["experimental.text.complete"](
    { sessionID: "sess-trip", messageID: "m", partID: "p" },
    output
  );
  assert.equal(output.text, "The fix is in src/player.ts in class Player.");
  assert.ok(logged.length > 0, "expected a debug log entry");
});

// Realistic WDM-style questions stay functional; explicit ask lifts.
await checkAsync("realistic questions route correctly", async () => {
  const functionalQs = [
    "Does media detection work?",
    "What changed in the downloader?",
    "Can I download a video from this webpage?",
    "Why can't I download this video?",
    "Is HLS supported?",
    "What happens when a page contains multiple videos?",
  ];
  for (const q of functionalQs) {
    const id = "sess-wdm-" + Math.random().toString(36).slice(2);
    await send(id, q);
    const sys = await systemFor(id);
    assert.match(sys[sys.length - 1], /mode: FUNCTIONAL/, "should stay functional: " + q);
  }
  const id2 = "sess-wdm-tech";
  await send(id2, "Show me how HLS detection is implemented.");
  const sys2 = await systemFor(id2);
  assert.match(sys2[sys2.length - 1], /mode: TECHNICAL/);
});

// Compaction hook preserves pinned mode; failure safety: hooks never throw.
await checkAsync("compaction preserves mode; hooks never throw", async () => {
  await hooks["command.execute.before"]({ command: "engineering", sessionID: "sess-comp", arguments: "" }, { parts: [] });
  const output = { context: [] };
  await hooks["experimental.session.compacting"]({ sessionID: "sess-comp" }, output);
  assert.match(output.context.join("\n"), /ENGINEERING/);
  await hooks["experimental.chat.system.transform"]({}, null);
  await hooks["chat.message"]({}, {});
  await hooks.event({});
  await hooks["experimental.session.compacting"]({}, {});
});

// In-place mutation: hook must push, never reassign (reassignment is a silent no-op in OpenCode).
await checkAsync("system hook mutates in place and preserves cache shape", async () => {
  const output = { system: ["header"] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "sess-cache" }, output);
  assert.equal(output.system[0], "header");
  assert.equal(output.system.length, 2);
});

console.log("\n" + passed + " checks passed.");

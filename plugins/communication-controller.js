/**
 * OpenCode Communication Controller — global plugin.
 *
 * What it does (plain language): controls HOW OpenCode talks to you, not
 * WHAT it can do. Every session starts in FUNCTIONAL mode (what you can do
 * and see). Technical details appear only when you explicitly ask for them
 * or switch modes on purpose.
 *
 * Modes: functional (default) → diagnostic → technical → engineering.
 *
 * How enforcement works:
 * - `experimental.chat.system.transform` injects the active mode policy
 *   right before the model answers (appended at the end, in place, so
 *   prompt-cache shape is preserved). This is the primary layer.
 * - `chat.message` watches your message for explicit technical requests
 *   ("show me the code", ...) and temporarily lifts the session to
 *   TECHNICAL for that turn. When the turn ends (`session.idle`) the
 *   session falls back to FUNCTIONAL unless you pinned a mode with a
 *   slash command.
 * - `command.execute.before` + real plugin tools perform mode switches.
 *   The mode lives in THIS plugin's state — commands never rely on the
 *   model merely "remembering" anything.
 * - `experimental.text.complete` is a read-only tripwire: it never edits
 *   answers (accuracy outranks style), it only logs when a functional
 *   answer leaks implementation details, so the policy can be improved.
 *
 * Safety: every hook is wrapped so a failure degrades to "no policy",
 * never to a broken session. No network calls, no extra model calls,
 * no per-project setup. Optional config:
 *   ~/.config/opencode/communication-controller.json
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MODES = ["functional", "diagnostic", "technical", "engineering"];

const DEFAULT_CONFIG = {
  defaultMode: "functional",
  allowExplicitTechnicalRequests: true,
  strictFunctionalMode: true,
  investigationNarration: false,
  verificationAwareness: true,
  responseValidation: true,
};

// sessionID -> { mode, sticky }. Absent entry = default mode. In-memory
// only: a restart (or reset) always returns to the default — a temporary
// technical detour can never permanently change your default.
const sessions = new Map();

let configCache = null;
let configMtime = 0;

function configPath() {
  try {
    return path.join(os.homedir(), ".config", "opencode", "communication-controller.json");
  } catch {
    return null;
  }
}

function loadConfig() {
  try {
    const p = configPath();
    if (!p) return { ...DEFAULT_CONFIG };
    let mtime = 0;
    try {
      mtime = fs.statSync(p).mtimeMs || 0;
    } catch {
      return { ...DEFAULT_CONFIG };
    }
    if (configCache && mtime === configMtime) return configCache;
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const next = { ...DEFAULT_CONFIG };
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (raw[key] !== undefined) next[key] = raw[key];
    }
    if (!MODES.includes(next.defaultMode)) next.defaultMode = "functional";
    configCache = next;
    configMtime = mtime;
    return next;
  } catch {
    return configCache || { ...DEFAULT_CONFIG };
  }
}

function getMode(sessionID) {
  const cfg = loadConfig();
  if (!sessionID) return cfg.defaultMode;
  const entry = sessions.get(sessionID);
  return entry ? entry.mode : cfg.defaultMode;
}

function setMode(sessionID, mode, sticky) {
  if (!MODES.includes(mode)) return false;
  if (!sessionID) return false;
  sessions.set(sessionID, { mode, sticky: !!sticky });
  return true;
}

function resetSession(sessionID) {
  if (!sessionID) return false;
  return sessions.delete(sessionID);
}

// --- Explicit technical-request detection ---------------------------------
// Natural-language asks that mean "technical details are wanted for this
// turn". A technically complex SUBJECT ("how do I download a video?") must
// NOT match — only explicit asks for implementation-level information.

const TECHNICAL_PATTERNS = [
  /show me (the )?(code|implementation|files?|diff|source)/i,
  /give me (the )?(code|implementation|diff|exact)/i,
  /which (files?|components?|functions?|classes?|modules?)\b/i,
  /what (function|file|class|api|component|module|method)\b/i,
  /what api\b/i,
  /explain (the )?(architecture|implementation|internals)/i,
  /how .* implemented/i,
  /why does .* work internally/i,
  /technical (analysis|explanation|details|breakdown)/i,
  /deep (technical|engineering|dive)/i,
  /inspect (the )?(source|code|everything)/i,
  /analy[sz]e the codebase/i,
  /exact (code|implementation)/i,
  /complete architecture/i,
  /explain .* internally/i,
];

function wantsTechnical(text) {
  if (!text || typeof text !== "string") return false;
  return TECHNICAL_PATTERNS.some((re) => re.test(text));
}

// Slash-command fallback: if "/technical" etc. ever arrives as plain text,
// treat it as a real (sticky) switch rather than conversation.
const SLASH_MODE_RE = /^\s*\/(functional|diagnostic|technical|engineering)\b/i;
const SLASH_RESET_RE = /^\s*\/communication\s+reset\b/i;

function collectText(value, out, depth) {
  if (out.length > 40 || depth > 4 || value == null) return;
  if (typeof value === "string") {
    if (value.length > 0 && value.length < 8000) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectText(v, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const k of ["text", "content", "value", "data"]) {
      if (typeof value[k] === "string") out.push(value[k]);
    }
    if (typeof value.type === "string" && typeof value.text === "string") out.push(value.text);
  }
}

function messageText(output) {
  const out = [];
  try {
    collectText(output && output.parts, out, 0);
    collectText(output && output.message, out, 0);
  } catch {
    // fall through with whatever was collected
  }
  return out.join("\n");
}

// --- Mode policies (injected into model context) ---------------------------

function functionalPolicy() {
  return [
    "[communication-controller • mode: FUNCTIONAL (default)]",
    "Talk about WHAT the user can do and see — never HOW it is implemented.",
    "You may inspect code, logs, tests, and architecture internally, but never narrate that investigation.",
    'Banned narration: "I\'ll inspect/examine/search/read/trace…", "I found the file/implementation…", "I\'ll check the function/code/architecture…". Work silently, then report the result in user-visible terms.',
    "Translate concepts into observable behavior; do NOT expose file paths, file names, classes, functions, variables, namespaces, APIs, diffs, commits, or architecture.",
    "Report verification honestly: VERIFIED WORKING (actually tested), PARTIALLY WORKING (works with limits), IMPLEMENTED / NOT FULLY VERIFIED, NOT VERIFIED, or NOT WORKING. Never invent verification; never trade uncertainty for confidence.",
    "When reporting a change, cover: what the user can do now, what they will see, how to use it, what was verified, limitations, what to try next. Be specific about behavior, abstract about implementation.",
    "If the user's message explicitly requests code, files, architecture, or another technical detail, answer technically for that request — explicit intent wins. Otherwise stay functional.",
  ].join("\n");
}

function diagnosticPolicy() {
  return [
    "[communication-controller • mode: DIAGNOSTIC]",
    "Stay user-facing, with a little more depth for debugging: 1) what is failing, 2) what the user can observe, 3) the probable user-visible cause (only when verified), 4) what to try, 5) what result to expect, 6) what remains uncertain.",
    "Do NOT expose implementation details (files, code, symbols, APIs, architecture) unless the user explicitly asks.",
    "Never narrate internal investigation; report verification honestly (verified / partially / not verified / not working).",
  ].join("\n");
}

function technicalPolicy() {
  return [
    "[communication-controller • mode: TECHNICAL]",
    "The user explicitly requested technical detail: file names, directories, classes, functions, APIs, architecture, code, diffs, and terminology are allowed.",
    "Stay accurate: report verification honestly (verified / partially / not verified / not working) and never invent test results.",
  ].join("\n");
}

function engineeringPolicy() {
  return [
    "[communication-controller • mode: ENGINEERING]",
    "Unrestricted engineering communication: exact files, symbols, code, diffs, dependencies, execution flow, tests, build details, configuration, and tradeoffs are all allowed.",
    "Stay accurate: distinguish verified behavior from inference, and say what remains uncertain.",
  ].join("\n");
}

function policyFor(mode) {
  switch (mode) {
    case "diagnostic":
      return diagnosticPolicy();
    case "technical":
      return technicalPolicy();
    case "engineering":
      return engineeringPolicy();
    default:
      return functionalPolicy();
  }
}

// --- Read-only response tripwire -------------------------------------------
// Never rewrites answers. Logs (debug) when a functional/diagnostic answer
// visibly leaks implementation detail, so the policy text can be improved.

const LEAK_PATTERNS = [
  /[A-Za-z]:\\[\w\-.K\\]+/m,
  /[\w\-.K]+\.(tsx?|jsx?|mts|cts|cs|py|rs|go|java|rb|php|jsonc?|ya?ml|md)\b/,
  /```\w*\n[\s\S]*?```/,
  /\b(class|namespace|interface)\s+[A-Z]\w+/,
  /I('ll| will)\s+(inspect|examine|search|read|trace|check the function|look at the code|inspect the architecture)/i,
  /I found the (relevant |)(file|implementation|class|function)/i,
];

function looksLikeLeak(text) {
  if (!text || typeof text !== "string") return null;
  for (const re of LEAK_PATTERNS) {
    const m = text.match(re);
    if (m) return m[0].slice(0, 120);
  }
  return null;
}

async function logDebug(client, message, extra) {
  try {
    if (client && client.app && typeof client.app.log === "function") {
      await client.app.log({
        body: {
          service: "communication-controller",
          level: "debug",
          message,
          extra: extra || {},
        },
      });
    }
  } catch {
    // logging must never break a session
  }
}

function statusText(sessionID) {
  const mode = getMode(sessionID).toUpperCase();
  const technicalLine =
    mode === "FUNCTIONAL" || mode === "DIAGNOSTIC"
      ? "Technical details: hidden unless explicitly requested"
      : "Technical details: shown (explicitly requested)";
  return ["Communication mode: " + mode, technicalLine, "Verification reporting: enabled"].join("\n");
}

function findEventSessionId(event) {
  try {
    if (!event || typeof event !== "object") return null;
    const p = event.properties || {};
    return (
      event.sessionID ||
      event.sessionId ||
      p.sessionID ||
      p.sessionId ||
      (p.session && (p.session.id || p.sessionID)) ||
      null
    );
  } catch {
    return null;
  }
}

async function loadToolHelper() {
  try {
    return (await import("@opencode-ai/plugin")).tool;
  } catch {
    return null;
  }
}

const CommunicationController = async (ctx) => {
  const client = (ctx && ctx.client) || null;
  loadConfig();

  let toolHelpers = null;
  try {
    toolHelpers = await loadToolHelper();
  } catch {
    toolHelpers = null;
  }

  const hooks = {
    // Highest priority: policy goes in as close to the model request as
    // the installed API allows. Appended at the end (in place) so the
    // cached system-prompt prefix stays stable.
    "experimental.chat.system.transform": async (input, output) => {
      try {
        if (!output || !Array.isArray(output.system)) return;
        const sessionID = (input && (input.sessionID || input.sessionId)) || null;
        output.system.push(policyFor(getMode(sessionID)));
      } catch {
        // policy injection must never break a model call
      }
    },

    // Detect explicit technical requests in the user's message. This is a
    // TEMPORARY lift: it expires when the turn ends (see session.idle).
    "chat.message": async (input, output) => {
      try {
        const cfg = loadConfig();
        const sessionID = (input && (input.sessionID || input.sessionId)) || null;
        if (!sessionID) return;
        const text = messageText(output);
        const slash = text.match(SLASH_MODE_RE);
        if (slash) {
          setMode(sessionID, slash[1].toLowerCase(), true);
          return;
        }
        if (SLASH_RESET_RE.test(text)) {
          resetSession(sessionID);
          return;
        }
        if (cfg.allowExplicitTechnicalRequests && wantsTechnical(text)) {
          setMode(sessionID, "technical", false);
        }
      } catch {
        // detection must never block a message
      }
    },

    // Real mode switches, kept in plugin state. Runs before the command's
    // prompt reaches the model, so the new mode already applies.
    "command.execute.before": async (input) => {
      try {
        const sessionID = input && (input.sessionID || input.sessionId);
        const raw = String((input && (input.command || "")) || "").toLowerCase();
        const name = raw.replace(/^\//, "").split(/[\s]+/)[0];
        const args = String((input && (input.arguments || "")) || "").toLowerCase();
        if (!sessionID) return;
        if (MODES.includes(name)) {
          setMode(sessionID, name, true);
          return;
        }
        if (name === "communication") {
          if (args.includes("reset")) resetSession(sessionID);
        }
      } catch {
        // switching must never break a command
      }
    },

    event: async (input) => {
      try {
        const event = input && input.event;
        const type = event && event.type;
        if (type === "session.idle") {
          // Turn finished: temporary (auto-detected) modes expire back to
          // the default. Pinned modes (via slash command) survive.
          const sessionID = findEventSessionId(event);
          if (!sessionID) return;
          const entry = sessions.get(sessionID);
          if (entry && !entry.sticky) sessions.delete(sessionID);
        } else if (type === "session.deleted") {
          const sessionID = findEventSessionId(event);
          if (sessionID) sessions.delete(sessionID);
        }
      } catch {
        // lifecycle bookkeeping must never break events
      }
    },

    // Keep the mode visible across compaction summaries.
    "experimental.session.compacting": async (input, output) => {
      try {
        if (!output || !Array.isArray(output.context)) return;
        const sessionID = input && (input.sessionID || input.sessionId);
        if (!sessionID) return;
        const entry = sessions.get(sessionID);
        if (entry) {
          output.context.push(
            "Communication mode for this session: " +
              entry.mode.toUpperCase() +
              (entry.sticky ? " (pinned by the user; keep it)" : " (temporary; default back to FUNCTIONAL after this turn)")
          );
        }
      } catch {
        // compaction context is best-effort
      }
    },

    // Read-only tripwire: observe, log, never rewrite.
    "experimental.text.complete": async (input, output) => {
      try {
        const cfg = loadConfig();
        if (!cfg.responseValidation) return;
        const sessionID = input && (input.sessionID || input.sessionId);
        const mode = getMode(sessionID);
        if (mode !== "functional" && mode !== "diagnostic") return;
        const leak = looksLikeLeak(output && output.text);
        if (leak) {
          await logDebug(client, "functional response leaked implementation detail", {
            sessionID: sessionID || null,
            mode,
            sample: leak,
          });
        }
      } catch {
        // observation must never touch the answer
      }
    },
  };

  if (toolHelpers) {
    hooks.tool = {
      communication_set_mode: toolHelpers({
        description:
          "Switch this session's communication mode: functional (plain user-visible language, default), diagnostic (debugging without internals), technical (files, code, architecture allowed), engineering (unrestricted). Call it when the user runs a mode command or explicitly asks for a different level of detail.",
        args: {
          mode: toolHelpers.schema.string().describe("One of: functional, diagnostic, technical, engineering"),
        },
        async execute(args, context) {
          try {
            const mode = String((args && args.mode) || "").toLowerCase();
            if (!MODES.includes(mode)) {
              return "Unknown mode. Use one of: functional, diagnostic, technical, engineering.";
            }
            const sessionID = context && (context.sessionID || context.sessionId);
            if (!sessionID) return "Could not determine the session; mode unchanged.";
            setMode(sessionID, mode, true);
            if (mode === "functional" || mode === "diagnostic") {
              return "Communication mode: " + mode.toUpperCase() + ". I will describe what you can do and see, without implementation details.";
            }
            return "Communication mode: " + mode.toUpperCase() + ". Technical details will now be shown.";
          } catch {
            return "Mode unchanged (internal error).";
          }
        },
      }),
      communication_status: toolHelpers({
        description: "Report this session's active communication mode in plain language.",
        args: {},
        async execute(args, context) {
          try {
            const sessionID = context && (context.sessionID || context.sessionId);
            return statusText(sessionID);
          } catch {
            return "Communication mode: FUNCTIONAL";
          }
        },
      }),
      communication_reset: toolHelpers({
        description: "Reset this session's communication mode back to the default (FUNCTIONAL).",
        args: {},
        async execute(args, context) {
          try {
            const sessionID = context && (context.sessionID || context.sessionId);
            if (sessionID) resetSession(sessionID);
            return "Communication mode reset to FUNCTIONAL.";
          } catch {
            return "Reset failed; mode unchanged.";
          }
        },
      }),
    };
  }

  return hooks;
};

// Stable plugin identity: single default export (V1 module shape).
// Keep exactly one export — a second (named) export would register the
// plugin twice on runtimes that also scan named exports.
export default {
  id: "comcontrol",
  server: CommunicationController,
};

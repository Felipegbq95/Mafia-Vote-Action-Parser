// --- Parsing -----------------------------------------------------------

const LINE_RE = /^([^:]{1,50}):\s*([\s\S]*)$/;
const KEYWORD_RE = /\b(unvote|vote)\b/gi;
const TARGET_RE = /^[\s:]*(?:for\s+)?([A-Za-z0-9_'\-]+(?:[ \t]+[A-Za-z0-9_'\-]+){0,3})/i;

function normalizeTarget(raw) {
  if (!raw) return "";
  return raw
    .replace(/^[@"'\s]+|["'\s.,!?;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Only the last VOTE/UNVOTE keyword in a message determines that message's
// action, so a target capture must stop at the next keyword rather than
// swallowing it (e.g. "VOTE: Bob actually no UNVOTE" must resolve to unvote).
function findLastAction(message) {
  const keywords = [];
  let match;
  KEYWORD_RE.lastIndex = 0;
  while ((match = KEYWORD_RE.exec(message)) !== null) {
    keywords.push({ type: match[1].toLowerCase(), end: match.index + match[1].length });
  }
  if (keywords.length === 0) return null;

  const last = keywords[keywords.length - 1];
  if (last.type === "unvote") {
    return { type: "unvote", target: "" };
  }

  const rest = message.slice(last.end);
  const targetMatch = rest.match(TARGET_RE);
  const target = targetMatch ? normalizeTarget(targetMatch[1]) : "";
  return { type: "vote", target };
}

function parsePlayerList(text) {
  return (text || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseVotes(logText, playersText) {
  const roster = parsePlayerList(playersText);
  const rosterByLower = new Map(roster.map((p) => [p.toLowerCase(), p]));

  const currentVotes = new Map(); // authorLower -> { authorDisplay, targetLower, targetDisplay }
  const debug = [];

  const lines = (logText || "").split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const lineMatch = line.match(LINE_RE);
    if (!lineMatch) {
      debug.push({ line, note: "ignored — no \"Author: message\" prefix found", ignored: true });
      continue;
    }

    const author = lineMatch[1].trim();
    const message = lineMatch[2];
    const authorLower = author.toLowerCase();
    const action = findLastAction(message);

    if (!action) {
      debug.push({ line, note: "no vote action found", ignored: true });
      continue;
    }

    if (action.type === "unvote") {
      if (currentVotes.has(authorLower)) {
        currentVotes.delete(authorLower);
        debug.push({ line, note: `${author} unvoted` });
      } else {
        debug.push({ line, note: `${author} unvoted (no active vote to remove)` });
      }
      continue;
    }

    // type === "vote"
    if (!action.target) {
      debug.push({ line, note: "vote found but no target name", ignored: true });
      continue;
    }

    let targetDisplay = action.target;
    const targetLower = action.target.toLowerCase();
    if (rosterByLower.has(targetLower)) {
      targetDisplay = rosterByLower.get(targetLower);
    } else if (roster.length) {
      debug.push({ line, note: `note: "${action.target}" is not in the player list (counted anyway)` });
    }

    currentVotes.set(authorLower, { authorDisplay: author, targetLower, targetDisplay });
    debug.push({ line, note: `${author} → votes ${targetDisplay}` });
  }

  const tallyMap = new Map(); // targetLower -> { display, voters: [] }
  for (const { authorDisplay, targetLower, targetDisplay } of currentVotes.values()) {
    if (!tallyMap.has(targetLower)) {
      tallyMap.set(targetLower, { display: targetDisplay, voters: [] });
    }
    tallyMap.get(targetLower).voters.push(authorDisplay);
  }

  const tallies = Array.from(tallyMap.values()).sort((a, b) => {
    if (b.voters.length !== a.voters.length) return b.voters.length - a.voters.length;
    return a.display.localeCompare(b.display);
  });

  const votingAuthors = new Set(currentVotes.keys());
  const notVoting = roster.filter((p) => !votingAuthors.has(p.toLowerCase()));

  const majority = roster.length ? Math.floor(roster.length / 2) + 1 : null;

  return { tallies, notVoting, majority, roster, debug };
}

// --- Message formatting --------------------------------------------------

function buildMessage(dayLabel, result) {
  const { tallies, notVoting, majority, roster } = result;
  const out = [];

  out.push(`🗳️ Vote Count${dayLabel ? " — " + dayLabel : ""}`);
  out.push("");

  if (tallies.length === 0) {
    out.push("No votes cast yet.");
  } else {
    for (const t of tallies) {
      out.push(`${t.display} (${t.voters.length}): ${t.voters.join(", ")}`);
    }
  }

  if (majority !== null) {
    out.push("");
    out.push(`Majority: ${majority} vote${majority === 1 ? "" : "s"} needed.`);
    const leaders = tallies.filter((t) => t.voters.length >= majority);
    for (const l of leaders) {
      out.push(`⚠️ ${l.display} has reached majority!`);
    }
  }

  if (roster.length && notVoting.length) {
    out.push("");
    out.push(`Not voting (${notVoting.length}): ${notVoting.join(", ")}`);
  }

  return out.join("\n");
}

// --- Wiring ---------------------------------------------------------------

if (typeof document !== "undefined") {
  const logInput = document.getElementById("log-input");
  const dayLabelInput = document.getElementById("day-label");
  const playersInput = document.getElementById("players-input");
  const parseBtn = document.getElementById("parse-btn");
  const copyBtn = document.getElementById("copy-btn");
  const resultsSection = document.getElementById("results");
  const output = document.getElementById("output");
  const debugList = document.getElementById("debug-list");

  const render = () => {
    const result = parseVotes(logInput.value, playersInput.value);
    const message = buildMessage(dayLabelInput.value.trim(), result);

    output.textContent = message;

    debugList.innerHTML = "";
    for (const entry of result.debug) {
      const li = document.createElement("li");
      li.textContent = `"${entry.line}" — ${entry.note}`;
      if (entry.ignored) li.classList.add("ignored");
      debugList.appendChild(li);
    }

    resultsSection.hidden = false;
  };

  parseBtn.addEventListener("click", render);

  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(output.textContent);
    } catch (e) {
      const range = document.createRange();
      range.selectNode(output);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      document.execCommand("copy");
      window.getSelection().removeAllRanges();
    }
    copyBtn.textContent = "Copied!";
    copyBtn.classList.add("copied");
    setTimeout(() => {
      copyBtn.textContent = "Copy message";
      copyBtn.classList.remove("copied");
    }, 1500);
  });
}

if (typeof module !== "undefined") {
  module.exports = { parseVotes, buildMessage, normalizeTarget };
}

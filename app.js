// --- Shared helpers --------------------------------------------------------

const KEYWORD_RE = /\b(unvote|vote)\b/gi;

function normalizeTarget(raw) {
  if (!raw) return "";
  return raw
    .replace(/^[@"'\s]+|["'\s.,!?;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePlayerList(text) {
  return (text || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// "CanonicalName: alias1, alias2" per line -> Map<aliasLower, CanonicalName>.
// Lets players who go by an unrelated nickname (e.g. "Axatar" also goes by
// "Joe") resolve correctly without relying on prefix/fuzzy guessing.
function parseAliasMap(text) {
  const map = new Map();
  const lines = (text || "").split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const sepIdx = line.indexOf(":");
    if (sepIdx === -1) continue;
    const canonical = line.slice(0, sepIdx).trim();
    if (!canonical) continue;
    const aliases = line
      .slice(sepIdx + 1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const alias of aliases) {
      map.set(alias.toLowerCase(), canonical);
    }
  }
  return map;
}

// Resolves the free-text word(s) after a vote keyword to a canonical roster
// name. Tries progressively shorter word-prefixes against the roster and the
// alias map first (exact, case-insensitive, longest phrase wins), then falls
// back to a fuzzy prefix match (handles nicknames like "blotty" for roster
// entry "Blott"), then just the first word.
function extractTarget(text, roster, aliasMap) {
  let candidate = text.replace(/^[\s:]*(?:for\s+)?/i, "");
  const stopMatch = candidate.match(/^([^.!?;\n]*)/);
  candidate = (stopMatch ? stopMatch[1] : candidate).trim();
  if (!candidate) return "";

  const words = candidate
    .split(/\s+/)
    .filter(Boolean)
    .map(normalizeTarget)
    .filter(Boolean);
  if (!words.length) return "";

  const rosterLower = roster && roster.length ? roster.map((r) => r.toLowerCase()) : [];

  for (let n = Math.min(words.length, 4); n >= 1; n--) {
    const candText = words.slice(0, n).join(" ").toLowerCase();
    const rosterIdx = rosterLower.indexOf(candText);
    if (rosterIdx !== -1) return roster[rosterIdx];
    if (aliasMap && aliasMap.has(candText)) return aliasMap.get(candText);
  }

  if (rosterLower.length) {
    const w0 = words[0].toLowerCase();
    const fuzzyIdx = rosterLower.findIndex(
      (r) => r.length >= 3 && w0.length >= 3 && (w0.startsWith(r) || r.startsWith(w0))
    );
    if (fuzzyIdx !== -1) return roster[fuzzyIdx];
  }

  return words[0];
}

// Only the last VOTE/UNVOTE keyword in a message determines that message's
// action, so a target capture must stop at the next keyword rather than
// swallowing it (e.g. "VOTE: Bob actually no UNVOTE" must resolve to unvote).
// A player who re-votes without ever typing UNVOTE is handled the same way
// as an explicit unvote+vote: whatever their latest message says wins.
function findLastAction(message, roster, aliasMap) {
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

  const target = extractTarget(message.slice(last.end), roster, aliasMap);
  return target ? { type: "vote", target } : null;
}

// Builds the sorted tally list from a Map<authorLower, {authorDisplay,
// targetLower, targetDisplay, order}>. Voters within a target are listed in
// the order they voted (ascending "order"). Targets are ranked by vote count
// descending; ties are broken by whoever reached that count first
// (ascending order of their most recent/deciding voter) — matching standard
// mafia tie rules, not alphabetically.
function buildTallies(currentVotes) {
  const tallyMap = new Map(); // targetLower -> { display, entries: [{name, order}] }
  for (const { authorDisplay, targetLower, targetDisplay, order } of currentVotes.values()) {
    if (!tallyMap.has(targetLower)) tallyMap.set(targetLower, { display: targetDisplay, entries: [] });
    tallyMap.get(targetLower).entries.push({ name: authorDisplay, order });
  }

  const tallies = Array.from(tallyMap.values()).map((t) => {
    const entries = t.entries.slice().sort((a, b) => a.order - b.order);
    const reachedAt = entries.length ? entries[entries.length - 1].order : 0;
    return {
      display: t.display,
      voters: entries.map((e) => e.name),
      voterEntries: entries,
      reachedAt,
    };
  });

  tallies.sort((a, b) => {
    if (b.voters.length !== a.voters.length) return b.voters.length - a.voters.length;
    return a.reachedAt - b.reachedAt;
  });

  return tallies;
}

// --- Simple "Username: message" log format ---------------------------------

const LINE_RE = /^([^:]{1,50}):\s*([\s\S]*)$/;

function parseSimpleLog(logText, roster, aliasMap) {
  const currentVotes = new Map(); // authorLower -> { authorDisplay, targetLower, targetDisplay, order }
  const debug = [];
  const lines = (logText || "").split("\n");
  let order = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    order++;

    const lineMatch = line.match(LINE_RE);
    if (!lineMatch) {
      debug.push({ line, note: "ignored — no \"Author: message\" prefix found", ignored: true });
      continue;
    }

    const author = lineMatch[1].trim();
    const message = lineMatch[2];
    const authorLower = author.toLowerCase();
    const action = findLastAction(message, roster, aliasMap);

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

    currentVotes.set(authorLower, {
      authorDisplay: author,
      targetLower: action.target.toLowerCase(),
      targetDisplay: action.target,
      order,
    });
    debug.push({ line, note: `${author} → votes ${action.target}` });
  }

  const tallies = buildTallies(currentVotes);
  const votingAuthors = new Set(currentVotes.keys());
  const notVoting = roster.filter((p) => !votingAuthors.has(p.toLowerCase()));
  const majority = roster.length ? Math.floor(roster.length / 2) + 1 : null;

  return {
    day: null,
    requestedDay: null,
    dayFound: true,
    tallies,
    notVoting,
    majority,
    roster,
    debug,
    showPostNumbers: false,
  };
}

// --- Forum "print" thread format --------------------------------------------
//
// Real export from forum software (e.g. SMF) looks like repeated blocks of:
//   Title: Re: <game title>
//   Post by: <author> on <date>, <time>
//   <post content, possibly containing "Quote from: X on Y" blocks>
// mixed with game-master posts announcing day starts, vote-count recaps,
// alive-player rosters and eliminations.

const POST_HEADER_RE = /Title:.*?\r?\nPost by:\s*(.+?)\s+on\s+(.+?)\r?\n/g;
const QUOTE_HEADER_RE = /^Quote from:\s*(.+?)\s+on\s+(.+?)\s*$/;
const SYSTEM_SIGNATURE_RE =
  /Vote Count|Alive Player List|has been exiled|has been knocked out|Day\s+\d+\s+(Start|ends)|Final Vote Count|Nyaight\s+\d+\s+(has begun|ends)/i;
const DAY_START_RE = /Day\s+(\d+)\s+Start/i;
const ROSTER_BLOCK_RE = /Alive Player List([\s\S]*?)With\s+\d+\s+players?\s+alive/i;
const ROSTER_LINE_RE = /^\s*\d+[.,]\s*(.+?)\s*$/gm;
const MAJORITY_RE = /With\s+\d+\s+players?\s+alive\s+it\s+will\s+take\s+(\d+)\s+to\s+achieve\s+majority/i;

function looksLikeForumThread(text) {
  return /Post by:\s*.+\s+on\s+.+/.test(text);
}

// postIndex is the 1-based position of each post across the *entire* pasted
// thread (including the game master's own posts), matching the "(#N)" style
// numbers a game master tallies by hand — but only if the whole thread is
// pasted starting from post #1; a partial paste yields numbers relative to
// wherever the paste starts, not the forum's true numbering.
function splitForumPosts(rawText) {
  const headers = [];
  let m;
  POST_HEADER_RE.lastIndex = 0;
  while ((m = POST_HEADER_RE.exec(rawText)) !== null) {
    headers.push({
      author: m[1].trim(),
      timestamp: m[2].trim(),
      matchStart: m.index,
      contentStart: POST_HEADER_RE.lastIndex,
    });
  }
  const posts = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const end = i + 1 < headers.length ? headers[i + 1].matchStart : rawText.length;
    posts.push({
      author: h.author,
      timestamp: h.timestamp,
      content: rawText.slice(h.contentStart, end).trim(),
      postIndex: i + 1,
    });
  }
  return posts;
}

// Quoted text (someone's earlier vote being re-displayed) must not be
// re-counted as the quoting author's new vote. We resolve each
// "Quote from: X on Y" block against X's actual earlier post (looked up by
// author+timestamp) and walk the quoted lines forward, dropping anything
// that matches. If a quote's author can't be resolved (the plain-text export
// sometimes mangles colored usernames into stray "<font" fragments), we fall
// back to keeping only the last blank-line-separated paragraph of the post,
// since a post's genuinely new content is always at the end.
function stripQuotes(content, postMap) {
  const lines = content.split("\n");

  const hasUnresolvableQuote = lines.some((l) => {
    const m = l.trim().match(QUOTE_HEADER_RE);
    if (!m) return false;
    return !postMap.has(`${m[1].trim()}|${m[2].trim()}`);
  });

  if (hasUnresolvableQuote) {
    const paragraphs = content
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    return paragraphs.length ? paragraphs[paragraphs.length - 1] : "";
  }

  const output = [];
  const stack = []; // { lines: string[], ptr: number }

  for (const rawLine of lines) {
    const headerMatch = rawLine.trim().match(QUOTE_HEADER_RE);
    if (headerMatch) {
      const key = `${headerMatch[1].trim()}|${headerMatch[2].trim()}`;
      stack.push({ lines: postMap.get(key) || [], ptr: 0 });
      continue;
    }

    const trimmed = rawLine.trim();
    if (stack.length === 0) {
      output.push(rawLine);
      continue;
    }
    if (trimmed === "") continue;

    let consumed = false;
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const idx = top.lines.indexOf(trimmed, top.ptr);
      if (idx !== -1 && idx - top.ptr <= 3) {
        top.ptr = idx + 1;
        consumed = true;
        break;
      }
      stack.pop();
    }
    if (!consumed) output.push(rawLine);
  }

  return output.join("\n");
}

function parseForumThread(rawText, { fallbackRoster = [], targetDay = null, aliasMap = null } = {}) {
  const posts = splitForumPosts(rawText);
  const postMap = new Map();

  let currentVotes = new Map();
  let roster = fallbackRoster.slice();
  let majority = null;
  let dayNumber = null;
  let dayFound = targetDay == null;
  const debug = [];

  for (const post of posts) {
    postMap.set(
      `${post.author}|${post.timestamp}`,
      post.content
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
    );

    if (SYSTEM_SIGNATURE_RE.test(post.content)) {
      const dayMatch = post.content.match(DAY_START_RE);
      if (dayMatch) {
        const newDay = parseInt(dayMatch[1], 10);
        if (targetDay != null && dayNumber === targetDay && newDay !== targetDay) {
          // We've already captured the requested day in full; anything from
          // a later day (or a different one) is irrelevant to that tally.
          break;
        }
        if (targetDay == null || newDay === targetDay) {
          dayNumber = newDay;
          currentVotes = new Map();
          if (newDay === targetDay) dayFound = true;
          debug.push({ line: `Day ${dayNumber} Start`, note: "new day detected, tally reset" });
        }
      }
      if (targetDay == null || dayNumber === targetDay) {
        const rosterMatch = post.content.match(ROSTER_BLOCK_RE);
        if (rosterMatch) {
          const names = [];
          let lm;
          ROSTER_LINE_RE.lastIndex = 0;
          while ((lm = ROSTER_LINE_RE.exec(rosterMatch[1])) !== null) {
            names.push(lm[1].trim());
          }
          if (names.length) roster = names;
        }
        const majorityMatch = post.content.match(MAJORITY_RE);
        if (majorityMatch) majority = parseInt(majorityMatch[1], 10);
      }
      continue;
    }

    if (targetDay != null && dayNumber !== targetDay) continue;

    const cleaned = stripQuotes(post.content, postMap);
    const action = findLastAction(cleaned, roster, aliasMap);
    if (!action) continue;

    const authorLower = post.author.toLowerCase();
    if (action.type === "unvote") {
      if (currentVotes.has(authorLower)) {
        currentVotes.delete(authorLower);
        debug.push({ line: post.author, note: "unvoted" });
      }
      continue;
    }

    currentVotes.set(authorLower, {
      authorDisplay: post.author,
      targetDisplay: action.target,
      targetLower: action.target.toLowerCase(),
      order: post.postIndex,
    });
    debug.push({ line: post.author, note: `votes ${action.target} (post #${post.postIndex})` });
  }

  const tallies = buildTallies(currentVotes);

  // Voter identities are full forum usernames (e.g. "Blottica") while the
  // roster uses short in-game names (e.g. "Blott"), so "not voting" is
  // computed with the same fuzzy prefix match used for target resolution.
  const votingAuthorsLower = Array.from(currentVotes.keys());
  const notVoting = roster.filter((name) => {
    const nameLower = name.toLowerCase();
    return !votingAuthorsLower.some((a) => a.startsWith(nameLower) || nameLower.startsWith(a));
  });

  if (majority === null && roster.length) majority = Math.floor(roster.length / 2) + 1;

  return {
    day: dayNumber,
    requestedDay: targetDay,
    dayFound,
    tallies,
    notVoting,
    majority,
    roster,
    debug,
    showPostNumbers: true,
  };
}

// --- Entry points ------------------------------------------------------------

function parseVotes(logText, playersText, opts = {}) {
  const fallbackRoster = parsePlayerList(playersText);
  const aliasMap = parseAliasMap(opts.aliasText);
  const targetDay = opts.day != null && opts.day !== "" ? parseInt(opts.day, 10) : null;

  if (looksLikeForumThread(logText)) {
    return parseForumThread(logText, { fallbackRoster, targetDay: Number.isNaN(targetDay) ? null : targetDay, aliasMap });
  }
  return parseSimpleLog(logText, fallbackRoster, aliasMap);
}

function buildMessage(result) {
  const { tallies, notVoting, majority, roster, day, requestedDay, dayFound, showPostNumbers } = result;

  if (requestedDay != null && !dayFound) {
    return `⚠️ Day ${requestedDay} wasn't found in the pasted thread — nothing to show. Check the day number or paste more of the thread.`;
  }

  const dayLabel = day ? `Day ${day}` : "";
  const out = [];

  out.push(`🗳️ Vote Count${dayLabel ? " — " + dayLabel : ""}`);
  out.push("");

  if (tallies.length === 0) {
    out.push("No votes cast yet.");
  } else {
    for (const t of tallies) {
      const voterText = showPostNumbers
        ? t.voterEntries.map((v) => `${v.name} (#${v.order})`).join(", ")
        : t.voters.join(", ");
      out.push(`${t.display}(${t.voters.length}): ${voterText}`);
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
  const ALIAS_STORAGE_KEY = "mafia-vote-counter-aliases";

  const logInput = document.getElementById("log-input");
  const dayInput = document.getElementById("day-input");
  const playersInput = document.getElementById("players-input");
  const aliasInput = document.getElementById("alias-input");
  const parseBtn = document.getElementById("parse-btn");
  const copyBtn = document.getElementById("copy-btn");
  const resultsSection = document.getElementById("results");
  const output = document.getElementById("output");
  const debugList = document.getElementById("debug-list");
  const detectedInfo = document.getElementById("detected-info");

  try {
    const savedAliases = window.localStorage.getItem(ALIAS_STORAGE_KEY);
    if (savedAliases) aliasInput.value = savedAliases;
  } catch (e) {
    // localStorage unavailable (e.g. private browsing) — just skip persistence.
  }

  const render = () => {
    try {
      window.localStorage.setItem(ALIAS_STORAGE_KEY, aliasInput.value);
    } catch (e) {
      // ignore
    }

    const result = parseVotes(logInput.value, playersInput.value, {
      day: dayInput.value.trim(),
      aliasText: aliasInput.value,
    });
    const message = buildMessage(result);

    output.textContent = message;

    if (detectedInfo) {
      const bits = [];
      if (result.day) bits.push(`Day ${result.day}`);
      bits.push(`${result.roster.length || "?"} player${result.roster.length === 1 ? "" : "s"}`);
      if (result.majority) bits.push(`majority ${result.majority}`);
      detectedInfo.textContent = "Detected: " + bits.join(" · ");
    }

    debugList.innerHTML = "";
    for (const entry of result.debug) {
      const li = document.createElement("li");
      li.textContent = `${entry.line} — ${entry.note}`;
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
  module.exports = { parseVotes, buildMessage, normalizeTarget, parseAliasMap };
}

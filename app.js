// --- Shared helpers --------------------------------------------------------

const KEYWORD_RE = /\b(unvote|vote)\b/gi;

// Invisible sentinels marking bold spans, inserted by the DOM->text walk in
// the browser (see extractMarkedText below) when the pasted content actually
// carries rich formatting. Plain strings (tests, plain-text pastes) never
// contain these, which is what lets bold-checking stay a no-op for them.
const BOLD_START = "\u0001";
const BOLD_END = "\u0002";

// Sentinels marking a real DOM <blockquote> (SMF's rendering of [quote]
// BBCode), inserted by the same DOM->text walk. Unlike the fuzzy "Quote
// from: X on Y" text-matching stripQuotes falls back to, these come from
// the browser's own parsed structure, so a quoted line can be identified
// with certainty instead of guessed at.
const QUOTE_START = "\u0003";
const QUOTE_END = "\u0004";

function isBoldAt(str, index) {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    const ch = str[i];
    if (ch === BOLD_START) depth++;
    else if (ch === BOLD_END) depth = Math.max(0, depth - 1);
  }
  return depth > 0;
}

// A real forum template bolds "Title:", "Post by:", the username, and the
// date as separate styled spans, so sentinels land *inside* structural text
// like "Post by: X on Y" -- not just around a player's vote. That's worse
// than it sounds: POST_HEADER_RE requires "Post by:" immediately after a
// literal newline with zero tolerance for anything in between, so a
// sentinel sitting right at that boundary (because "Post by:" itself is
// bold) makes the whole regex fail to match, not just corrupt a capture --
// the post is silently never found at all. Trimming captured groups can't
// fix a match that never happened.
//
// The fix is to never run structural regexes (post/quote headers, roster,
// day, majority) against sentinel-laden text in the first place. This pulls
// the sentinels back out into a same-length boolean array, so parsing goes
// back to working on plain text -- identical to before bold support existed
// -- while boldness for any position is still a cheap array lookup for the
// one thing that actually needs it: was *this specific* "vote" keyword
// bolded.
function splitMarkedText(marked) {
  let clean = "";
  const bold = [];
  const quoted = [];
  let boldDepth = 0;
  let quoteDepth = 0;
  for (let i = 0; i < marked.length; i++) {
    const ch = marked[i];
    if (ch === BOLD_START) {
      boldDepth++;
      continue;
    }
    if (ch === BOLD_END) {
      boldDepth = Math.max(0, boldDepth - 1);
      continue;
    }
    if (ch === QUOTE_START) {
      quoteDepth++;
      continue;
    }
    if (ch === QUOTE_END) {
      quoteDepth = Math.max(0, quoteDepth - 1);
      continue;
    }
    clean += ch;
    bold.push(boldDepth > 0);
    quoted.push(quoteDepth > 0);
  }
  return { clean, bold, quoted };
}

function stripSentinels(raw) {
  return (raw || "").replace(/[\u0001\u0002]/g, "").trim();
}

function normalizeTarget(raw) {
  if (!raw) return "";
  return raw
    .replace(/[\u0001\u0002]/g, "")
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
// entry "Blott"). Returns { text, resolved }: resolved is true when the name
// matched a known player (or no roster is known yet, so there's nothing to
// check against). If a roster is known and nothing matched, the raw typed
// word is returned with resolved: false -- callers surface these separately
// (e.g. a typo like "blitt") rather than silently dropping them.
function extractTarget(text, roster, aliasMap) {
  let candidate = text.replace(/^[\s:]*(?:for\s+)?/i, "");
  const stopMatch = candidate.match(/^([^.!?;\n]*)/);
  candidate = (stopMatch ? stopMatch[1] : candidate).trim();
  if (!candidate) return { text: "", resolved: false };

  const words = candidate
    .split(/\s+/)
    .filter(Boolean)
    .map(normalizeTarget)
    .filter(Boolean);
  if (!words.length) return { text: "", resolved: false };

  const rosterLower = roster && roster.length ? roster.map((r) => r.toLowerCase()) : [];

  for (let n = Math.min(words.length, 4); n >= 1; n--) {
    const candText = words.slice(0, n).join(" ").toLowerCase();
    const rosterIdx = rosterLower.indexOf(candText);
    if (rosterIdx !== -1) return { text: roster[rosterIdx], resolved: true };
    if (aliasMap && aliasMap.has(candText)) return { text: aliasMap.get(candText), resolved: true };
  }

  if (rosterLower.length) {
    const w0 = words[0].toLowerCase();
    const fuzzyIdx = rosterLower.findIndex(
      (r) => r.length >= 3 && w0.length >= 3 && (w0.startsWith(r) || r.startsWith(w0))
    );
    if (fuzzyIdx !== -1) return { text: roster[fuzzyIdx], resolved: true };
  }

  if (!rosterLower.length) return { text: words[0], resolved: true };

  return { text: words[0], resolved: false };
}

// Only the last VOTE/UNVOTE keyword in a message determines that message's
// action, so a target capture must stop at the next keyword rather than
// swallowing it (e.g. "VOTE: Bob actually no UNVOTE" must resolve to unvote).
// A player who re-votes without ever typing UNVOTE is handled the same way
// as an explicit unvote+vote: whatever their latest message says wins.
//
// requireBold: when the pasted content actually carries bold formatting
// (BOLD_START appears anywhere in it), the game's own rule applies -- only a
// bolded "vote"/"unvote" counts. Keyword occurrences that aren't bolded are
// skipped entirely, as if the word wasn't a vote action at all. When the
// paste carries no formatting info (plain text, or the unit tests), this is
// a no-op and every keyword occurrence is eligible, same as before.
//
// boldAt: an optional boolean array aligned with `message` (see
// splitMarkedText) for callers that have already pulled sentinels out of
// their text. When omitted, falls back to scanning `message` itself for
// inline sentinels via isBoldAt -- used by the simple "Username: message"
// log format, which has no header/quote structure for sentinels to corrupt.
function findLastAction(message, roster, aliasMap, requireBold, boldAt) {
  const keywords = [];
  let match;
  KEYWORD_RE.lastIndex = 0;
  while ((match = KEYWORD_RE.exec(message)) !== null) {
    keywords.push({
      type: match[1].toLowerCase(),
      start: match.index,
      end: match.index + match[1].length,
    });
  }
  if (keywords.length === 0) return null;

  const isBold = boldAt ? (index) => boldAt[index] === true : (index) => isBoldAt(message, index);
  const eligible = requireBold ? keywords.filter((k) => isBold(k.start)) : keywords;
  if (eligible.length === 0) {
    // Every "vote"/"unvote" mention in this message was plain text, not
    // bold -- per the game's rule, none of them count as a real action.
    return { type: "unbolded", target: "" };
  }

  const last = eligible[eligible.length - 1];
  if (last.type === "unvote") {
    return { type: "unvote", target: "" };
  }

  // target === "" means a "vote" keyword was found but nothing after it
  // resolved to a known player (e.g. "I'll vote unless someone convinces
  // me") -- distinct from `null` (no vote keyword in the message at all) so
  // callers can surface *why* a message with the word "vote" in it didn't
  // register, instead of silently doing nothing.
  const target = extractTarget(message.slice(last.end), roster, aliasMap);
  return { type: "vote", target: target.text, resolved: target.resolved };
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
  const requireBold = (logText || "").includes(BOLD_START);
  const currentVotes = new Map(); // authorLower -> { authorDisplay, targetLower, targetDisplay, order, resolved }
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
    const action = findLastAction(message, roster, aliasMap, requireBold);

    if (!action) {
      debug.push({ line, note: "no vote action found", ignored: true });
      continue;
    }

    if (action.type === "unbolded") {
      debug.push({ line, note: `${author} mentioned "vote"/"unvote" but not in bold — ignored`, ignored: true });
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

    if (!action.target) {
      debug.push({ line, note: `${author} used the word "vote" but nothing followed it — ignored`, ignored: true });
      continue;
    }

    currentVotes.set(authorLower, {
      authorDisplay: author,
      targetLower: action.target.toLowerCase(),
      targetDisplay: action.target,
      order,
      resolved: action.resolved,
    });
    debug.push({ line, note: `${author} → votes ${action.target}` });
  }

  const resolvedVotes = new Map();
  const unresolvedVotes = new Map();
  for (const [key, v] of currentVotes) {
    (v.resolved ? resolvedVotes : unresolvedVotes).set(key, v);
  }

  const tallies = buildTallies(resolvedVotes);
  const unresolvedTallies = buildTallies(unresolvedVotes);
  const votingAuthors = new Set(currentVotes.keys());
  const notVoting = roster.filter((p) => !votingAuthors.has(p.toLowerCase()));
  const majority = roster.length ? Math.floor(roster.length / 2) + 1 : null;

  return {
    day: null,
    requestedDay: null,
    dayFound: true,
    tallies,
    unresolvedTallies,
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

// postIndex matches the forum's own "Reply #N" numbering: the thread's
// original post (the very first header in the pasted text) never gets a
// reply number of its own in SMF, so it's index 0 and the first actual
// reply after it is #1, counting up from there — matching the "(#N)" style
// numbers a game master tallies by hand, but only if the whole thread is
// pasted starting from the true first post; a partial paste yields numbers
// relative to wherever the paste starts, not the forum's true numbering.
function splitForumPosts(rawText) {
  const headers = [];
  let m;
  POST_HEADER_RE.lastIndex = 0;
  while ((m = POST_HEADER_RE.exec(rawText)) !== null) {
    headers.push({
      author: stripSentinels(m[1]),
      timestamp: stripSentinels(m[2]),
      matchStart: m.index,
      contentStart: POST_HEADER_RE.lastIndex,
    });
  }
  const posts = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const end = i + 1 < headers.length ? headers[i + 1].matchStart : rawText.length;
    const untrimmed = rawText.slice(h.contentStart, end);
    const leading = untrimmed.length - untrimmed.trimStart().length;
    const trimmed = untrimmed.trim();
    posts.push({
      author: h.author,
      timestamp: h.timestamp,
      content: trimmed,
      // Absolute offsets of `content` within `rawText`, so a caller holding
      // a same-length boldness array for rawText (see splitMarkedText) can
      // slice out the bold info for exactly this post's content.
      contentAbsStart: h.contentStart + leading,
      contentAbsEnd: h.contentStart + leading + trimmed.length,
      postIndex: i,
    });
  }
  return posts;
}

// Splits `text` into lines (matching text.split("\n")) alongside the
// matching slice of a same-length boldness array per line, so line-based
// operations can carry boldness along without re-deriving positions.
function splitLinesWithBold(text, boldArr) {
  const lines = text.split("\n");
  const boldLines = [];
  let pos = 0;
  for (const line of lines) {
    boldLines.push(boldArr.slice(pos, pos + line.length));
    pos += line.length + 1; // +1 for the "\n" consumed by split
  }
  return { lines, boldLines };
}

// Rejoins per-line boldness arrays the way Array.prototype.join("\n") on the
// paired lines would, inserting a non-bold slot for each joining "\n".
function joinBoldLines(boldLines) {
  const joined = [];
  boldLines.forEach((line, i) => {
    if (i > 0) joined.push(false);
    joined.push(...line);
  });
  return joined;
}

// Quoted text (someone's earlier vote being re-displayed) must not be
// re-counted as the quoting author's new vote. When the paste carries real
// DOM structure (a <blockquote> the browser itself rendered for a [quote]
// BBCode block -- see extractMarkedText/buildPasteFragment), contentQuoted
// says with certainty which characters came from inside one, and any line
// made up entirely of such characters is dropped outright, no guessing
// needed. Only when a post has no such DOM info at all (plain-text paste,
// or the unit tests) do we fall back to the older heuristic: resolve each
// "Quote from: X on Y" block against X's actual earlier post (looked up by
// author+timestamp) and walk the quoted lines forward, dropping anything
// that matches; if a quote's author can't be resolved (the plain-text
// export sometimes mangles colored usernames into stray "<font"
// fragments), keep only the last blank-line-separated paragraph of the
// post, since a post's genuinely new content is always at the end.
//
// contentBold/contentQuoted are boolean arrays the same length as `content`
// (see splitMarkedText); the function returns the surviving text's own
// boldness array alongside it, kept in lockstep through every line
// kept/dropped.
function stripQuotes(content, contentBold, contentQuoted, postMap) {
  const { lines, boldLines } = splitLinesWithBold(content, contentBold);
  const { boldLines: quotedLines } = splitLinesWithBold(content, contentQuoted);

  const hasDomQuoteInfo = contentQuoted.some(Boolean);
  const isDomQuotedLine = (li) => {
    const q = quotedLines[li];
    return q.length > 0 && q.every(Boolean);
  };

  const hasUnresolvableQuote =
    !hasDomQuoteInfo &&
    lines.some((l) => {
      const m = l.trim().match(QUOTE_HEADER_RE);
      if (!m) return false;
      return !postMap.has(`${stripSentinels(m[1])}|${stripSentinels(m[2])}`);
    });

  if (hasUnresolvableQuote) {
    const paragraphs = [];
    let current = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === "") {
        if (current.length) paragraphs.push(current);
        current = [];
      } else {
        current.push(i);
      }
    }
    if (current.length) paragraphs.push(current);
    if (!paragraphs.length) return { text: "", bold: [] };

    const idxs = paragraphs[paragraphs.length - 1];
    const rawParaText = idxs.map((i) => lines[i]).join("\n");
    const rawParaBold = joinBoldLines(idxs.map((i) => boldLines[i]));
    const leading = rawParaText.length - rawParaText.trimStart().length;
    const text = rawParaText.trim();
    const bold = rawParaBold.slice(leading, leading + text.length);
    return { text, bold };
  }

  const outputLines = [];
  const outputBoldLines = [];
  const stack = []; // { lines: string[], ptr: number }

  for (let li = 0; li < lines.length; li++) {
    if (isDomQuotedLine(li)) continue;

    const rawLine = lines[li];
    const headerMatch = rawLine.trim().match(QUOTE_HEADER_RE);
    if (headerMatch) {
      const key = `${stripSentinels(headerMatch[1])}|${stripSentinels(headerMatch[2])}`;
      stack.push({ lines: postMap.get(key) || [], ptr: 0 });
      continue;
    }

    const trimmed = rawLine.trim();
    if (stack.length === 0) {
      outputLines.push(rawLine);
      outputBoldLines.push(boldLines[li]);
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
    if (!consumed) {
      outputLines.push(rawLine);
      outputBoldLines.push(boldLines[li]);
    }
  }

  return { text: outputLines.join("\n"), bold: joinBoldLines(outputBoldLines) };
}

function parseForumThread(rawText, { fallbackRoster = [], targetDay = null, aliasMap = null } = {}) {
  const requireBold = rawText.includes(BOLD_START);
  // Structural parsing (post/quote headers, roster, day, majority) always
  // runs on sentinel-free text -- see splitMarkedText's comment for why a
  // bolded "Post by:" would otherwise make posts silently fail to be found
  // at all. `bold` is boldness-per-character of `cleanText`, sliced out
  // per-post below for the one thing that still needs it: vote keywords.
  const { clean: cleanText, bold, quoted } = splitMarkedText(rawText);
  const posts = splitForumPosts(cleanText);
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
            names.push(stripSentinels(lm[1]));
          }
          if (names.length) roster = names;
        }
        const majorityMatch = post.content.match(MAJORITY_RE);
        if (majorityMatch) majority = parseInt(majorityMatch[1], 10);
      }
      continue;
    }

    if (targetDay != null && dayNumber !== targetDay) continue;

    const contentBold = bold.slice(post.contentAbsStart, post.contentAbsEnd);
    const contentQuoted = quoted.slice(post.contentAbsStart, post.contentAbsEnd);
    const cleaned = stripQuotes(post.content, contentBold, contentQuoted, postMap);
    const action = findLastAction(cleaned.text, roster, aliasMap, requireBold, cleaned.bold);
    if (!action) continue;

    const authorLower = post.author.toLowerCase();

    if (action.type === "unbolded") {
      debug.push({
        line: post.author,
        note: `mentioned "vote"/"unvote" but not in bold (post #${post.postIndex}) — ignored`,
        ignored: true,
      });
      continue;
    }

    if (action.type === "unvote") {
      if (currentVotes.has(authorLower)) {
        currentVotes.delete(authorLower);
        debug.push({ line: post.author, note: "unvoted" });
      }
      continue;
    }

    if (!action.target) {
      debug.push({
        line: post.author,
        note: `used the word "vote" but nothing followed it (post #${post.postIndex}) — ignored`,
        ignored: true,
      });
      continue;
    }

    currentVotes.set(authorLower, {
      authorDisplay: post.author,
      targetDisplay: action.target,
      targetLower: action.target.toLowerCase(),
      order: post.postIndex,
      resolved: action.resolved,
    });
    debug.push({ line: post.author, note: `votes ${action.target} (post #${post.postIndex})` });
  }

  const resolvedVotes = new Map();
  const unresolvedVotes = new Map();
  for (const [key, v] of currentVotes) {
    (v.resolved ? resolvedVotes : unresolvedVotes).set(key, v);
  }

  const tallies = buildTallies(resolvedVotes);
  const unresolvedTallies = buildTallies(unresolvedVotes);

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
    unresolvedTallies,
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

// Builds the tally lines shared by both output modes: "Target(N): voter1
// (#123), voter2 (#456)" for a forum-parsed thread (post numbers), or just
// comma-separated names for the simple "Username: message" log format.
function buildTallyLines(tallies, showPostNumbers) {
  if (tallies.length === 0) return ["No votes cast yet."];
  return tallies.map((t) => {
    const voterText = showPostNumbers
      ? t.voterEntries.map((v) => `${v.name} (#${v.order})`).join(", ")
      : t.voters.join(", ");
    return `${t.display}(${t.voters.length}): ${voterText}`;
  });
}

// opts.mode: "midday" (default) is an in-progress status check-in --
// tallies plus the full alive roster and a reminder of when the day ends.
// "final" is the closing-the-day announcement -- tallies, who died, and a
// banner declaring the night has begun. Both are formatted as SMF BBCode
// (color/size tags) so the result can be pasted directly into a forum post.
// opts.dayEndsOn/dayEndsAt are free text (e.g. "Wednesday" / "8pm eastern")
// since the actual day/time varies game to game and even day to day.
function buildMessage(result, opts = {}) {
  const { tallies, majority, roster, day, requestedDay, dayFound, showPostNumbers } = result;
  const { dayEndsOn = "", dayEndsAt = "", mode = "midday" } = opts;

  if (requestedDay != null && !dayFound) {
    return `⚠️ Day ${requestedDay} wasn't found in the pasted thread — nothing to show. Check the day number or paste more of the thread.`;
  }

  const dayLabel = day ? `Day ${day} ` : "";
  const out = [];

  if (mode === "final") {
    out.push(`[size=4][color=yellow]${dayLabel}Final Vote Count[/color][/size]`);
    out.push(...buildTallyLines(tallies, showPostNumbers));

    if (tallies.length) {
      out.push("");
      out.push(`${tallies[0].display} has died`);
    }

    if (dayEndsOn && dayEndsAt) {
      out.push("");
      out.push(`[b][size=4][color=red]${dayLabel}is over. THE NIGHT WILL END ${dayEndsOn} @ ${dayEndsAt}[/color][/size][/b]`);
    }

    return out.join("\n");
  }

  out.push(`[size=4][color=yellow]${dayLabel}Vote Count[/color][/size]`);
  out.push(...buildTallyLines(tallies, showPostNumbers));

  if (majority !== null) {
    const leaders = tallies.filter((t) => t.voters.length >= majority);
    for (const l of leaders) {
      out.push(`⚠️ ${l.display} has reached majority!`);
    }
  }

  if (roster.length) {
    out.push("");
    out.push("");
    out.push("Alive Player List");
    out.push("");
    const alphabetical = roster.slice().sort((a, b) => a.localeCompare(b));
    alphabetical.forEach((name, i) => out.push(`${i + 1}. ${name}`));
  }

  if (majority !== null && roster.length) {
    out.push("");
    out.push("");
    out.push(`[color=yellow]With ${roster.length} players alive it will take ${majority} to achieve majority.[/color]`);
  }

  if (dayEndsOn && dayEndsAt) {
    out.push("");
    out.push(`${dayLabel}ends ${dayEndsOn} at ${dayEndsAt}.`);
  }

  return out.join("\n");
}

// --- Wiring ---------------------------------------------------------------

// The game thread box is a contenteditable div rather than a <textarea>
// specifically so pasted rich text keeps its formatting: browsers only hand
// a <textarea> the plain-text clipboard entry, but a contenteditable element
// receives the actual pasted HTML (bold, links, colors, all of it) and
// renders it as real DOM nodes. This walks those nodes back into a single
// string for the regex-based parser, wrapping any text that's bold (a <b>/
// <strong> tag, or an inline/computed font-weight of 600+) in the BOLD_START
// / BOLD_END sentinels so findLastAction can tell a genuine bolded vote from
// a plain-text mention of the word "vote" in someone's prose — matching the
// game's own rule that only bolded votes count. Content typed by hand (no
// paste) naturally produces no bold markers at all, same as a plain-text log.
function extractMarkedText(root) {
  const BLOCK_TAGS = new Set(["div", "p", "li", "tr", "blockquote", "h1", "h2", "h3", "h4"]);
  let text = "";

  function isBoldNode(node) {
    const tag = node.tagName.toLowerCase();
    if (tag === "b" || tag === "strong") return true;
    const weight = node.style && node.style.fontWeight;
    if (!weight) return false;
    if (weight === "bold" || weight === "bolder") return true;
    const n = parseInt(weight, 10);
    return !Number.isNaN(n) && n >= 600;
  }

  function walk(node, bold, quoted) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.nodeValue) return;
      let chunk = node.nodeValue;
      if (bold) chunk = BOLD_START + chunk + BOLD_END;
      if (quoted) chunk = QUOTE_START + chunk + QUOTE_END;
      text += chunk;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName.toLowerCase();
    if (tag === "script" || tag === "style") return;
    if (tag === "br") {
      text += "\n";
      return;
    }
    const childBold = bold || isBoldNode(node);
    const childQuoted = quoted || tag === "blockquote";
    for (const child of node.childNodes) walk(child, childBold, childQuoted);
    if (BLOCK_TAGS.has(tag)) text += "\n";
  }

  for (const child of root.childNodes) walk(child, false, false);
  return text;
}

// A real forum "print" page is riddled with embedded images/gifs *and* with
// small inline-styled spans around nearly every date, username, and post
// header — real forum markup, not something we control. Two different
// things go wrong if the browser's default paste behavior is left alone:
//
// 1. Every <img>/<video> becomes a real node that starts fetching and
//    decoding immediately.
// 2. `document.execCommand("insertHTML", ...)` — the standard way to insert
//    sanitized HTML into a contenteditable at the cursor — is notoriously
//    slow for large pastes: it does per-node style normalization and undo-
//    stack bookkeeping as it goes, so a few thousand small styled spans (one
//    real 1500-post thread's worth) makes it hang for a minute or more, with
//    or without any images in the mix.
//
// The fix for both is to never hand the original, deeply-nested markup to
// the live DOM at all. We only care about plain text plus which parts of it
// are bold, so this walks the pasted HTML *once*, off-DOM, collapses it into
// a short list of (text, isBold) runs (adjacent same-boldness text merges
// into one run), and builds a *minimal* fragment — one <b> or text node per
// run — to insert directly via Range.insertNode. A thousand-post paste with
// thousands of source spans collapses to a comparative handful of runs,
// which is cheap to insert regardless of how heavy the original markup was.
const STRIP_TAGS = ["img", "video", "audio", "picture", "source", "iframe", "embed", "object", "svg", "canvas", "script", "style", "link", "track"];
const BLOCK_TAGS = new Set(["div", "p", "li", "tr", "blockquote", "h1", "h2", "h3", "h4"]);

// Browsers start fetching an <img src="..."> (or an <iframe src>, <video
// src>, etc.) the instant the tag is parsed into *any* element, even one
// that is detached and never rendered -- so removing the node afterward is
// too late to stop the network request. Rather than string-searching for
// each tag's matching close tag (which, on a large paste with an
// unmatched/malformed opening tag -- a stray <object>/<embed> ad leftover
// is common in real forum exports -- degrades to quadratic time and is
// exactly the kind of thing that can make a big paste hang for a minute),
// this just strips every attribute off the *opening* tag in one linear
// pass. That's enough on its own: no src/srcset/data/poster attribute
// survives to trigger a fetch, and the DOM walk below already skips these
// tags (and everything inside them) entirely regardless of whether their
// closing tag -- or any content in between -- is still present in the
// string.
function neutralizeFetchTags(html) {
  const pattern = new RegExp(`<(${STRIP_TAGS.join("|")})\\b[^>]*>`, "gi");
  return html.replace(pattern, "<$1>");
}

function isBoldElement(node) {
  const tag = node.tagName.toLowerCase();
  if (tag === "b" || tag === "strong") return true;
  const weight = node.style && node.style.fontWeight;
  if (!weight) return false;
  if (weight === "bold" || weight === "bolder") return true;
  const n = parseInt(weight, 10);
  return !Number.isNaN(n) && n >= 600;
}

// Builds a small DocumentFragment (plain text nodes + <b> wrappers only)
// from pasted HTML, for insertion into the live contenteditable in place of
// the original markup. See the block comment above for why.
function buildPasteFragment(html) {
  const cleaned = neutralizeFetchTags(html);

  const container = document.createElement("div");
  container.innerHTML = cleaned;

  const runs = []; // { text, bold, quoted }
  const pushText = (text, bold, quoted) => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last && last.bold === bold && last.quoted === quoted) last.text += text;
    else runs.push({ text, bold, quoted });
  };

  const walk = (node, bold, quoted) => {
    if (node.nodeType === Node.TEXT_NODE) {
      pushText(node.nodeValue, bold, quoted);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName.toLowerCase();
    if (STRIP_TAGS.includes(tag)) return;
    if (tag === "br") {
      pushText("\n", false, false);
      return;
    }
    const childBold = bold || isBoldElement(node);
    const childQuoted = quoted || tag === "blockquote";
    for (const child of node.childNodes) walk(child, childBold, childQuoted);
    if (BLOCK_TAGS.has(tag)) pushText("\n", false, false);
  };

  for (const child of container.childNodes) walk(child, false, false);

  // Consecutive quoted runs are grouped into a single real <blockquote>
  // element (rather than one per run) so extractMarkedText's later re-walk
  // sees one coherent quote block, matching how a genuine [quote] renders --
  // and so a bold toggle *inside* a quote doesn't fragment it into multiple
  // block-level elements, which would inject spurious newlines mid-quote.
  const fragment = document.createDocumentFragment();
  let quoteEl = null;
  for (const run of runs) {
    let target = fragment;
    if (run.quoted) {
      if (!quoteEl) {
        quoteEl = document.createElement("blockquote");
        fragment.appendChild(quoteEl);
      }
      target = quoteEl;
    } else {
      quoteEl = null;
    }
    if (run.bold) {
      const b = document.createElement("b");
      b.appendChild(document.createTextNode(run.text));
      target.appendChild(b);
    } else {
      target.appendChild(document.createTextNode(run.text));
    }
  }
  return fragment;
}

if (typeof document !== "undefined") {
  const ALIAS_STORAGE_KEY = "mafia-vote-counter-aliases";
  const DAY_ENDS_AT_STORAGE_KEY = "mafia-vote-counter-day-ends-at";

  const logInput = document.getElementById("log-input");
  const dayInput = document.getElementById("day-input");
  const playersInput = document.getElementById("players-input");
  const aliasInput = document.getElementById("alias-input");
  const modeInput = document.getElementById("mode-input");
  const dayEndsOnInput = document.getElementById("day-ends-on-input");
  const dayEndsAtInput = document.getElementById("day-ends-at-input");
  const parseBtn = document.getElementById("parse-btn");
  const copyBtn = document.getElementById("copy-btn");
  const resultsSection = document.getElementById("results");
  const output = document.getElementById("output");
  const debugList = document.getElementById("debug-list");
  const detectedInfo = document.getElementById("detected-info");
  const unresolvedSection = document.getElementById("unresolved-section");
  const unresolvedList = document.getElementById("unresolved-list");

  try {
    const savedAliases = window.localStorage.getItem(ALIAS_STORAGE_KEY);
    if (savedAliases) aliasInput.value = savedAliases;
    const savedDayEndsAt = window.localStorage.getItem(DAY_ENDS_AT_STORAGE_KEY);
    if (savedDayEndsAt) dayEndsAtInput.value = savedDayEndsAt;
  } catch (e) {
    // localStorage unavailable (e.g. private browsing) — just skip persistence.
  }

  logInput.addEventListener("paste", (event) => {
    event.preventDefault();
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();

    const html = event.clipboardData && event.clipboardData.getData("text/html");
    const fragment = html
      ? buildPasteFragment(html)
      : document.createTextNode((event.clipboardData && event.clipboardData.getData("text/plain")) || "");
    range.insertNode(fragment);

    // Move the cursor to the end of the box rather than tracking the exact
    // insertion point — for a paste this size the user is about to hit
    // Parse anyway, not keep typing mid-document.
    const endRange = document.createRange();
    endRange.selectNodeContents(logInput);
    endRange.collapse(false);
    selection.removeAllRanges();
    selection.addRange(endRange);
  });

  const render = () => {
    try {
      window.localStorage.setItem(ALIAS_STORAGE_KEY, aliasInput.value);
      window.localStorage.setItem(DAY_ENDS_AT_STORAGE_KEY, dayEndsAtInput.value);
    } catch (e) {
      // ignore
    }

    const rawText = extractMarkedText(logInput);
    const result = parseVotes(rawText, playersInput.value, {
      day: dayInput.value.trim(),
      aliasText: aliasInput.value,
    });
    const message = buildMessage(result, {
      mode: modeInput.value,
      dayEndsOn: dayEndsOnInput.value.trim(),
      dayEndsAt: dayEndsAtInput.value.trim(),
    });

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

    if (unresolvedSection && unresolvedList) {
      unresolvedList.innerHTML = "";
      const unresolved = result.unresolvedTallies || [];
      unresolvedSection.hidden = unresolved.length === 0;
      for (const t of unresolved) {
        const li = document.createElement("li");
        const voterText = result.showPostNumbers
          ? t.voterEntries.map((v) => `${v.name} (#${v.order})`).join(", ")
          : t.voters.join(", ");
        li.textContent = `${t.display}(${t.voters.length}): ${voterText}`;
        unresolvedList.appendChild(li);
      }
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

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseVotes, buildMessage } = require("./app.js");

test("basic vote counting", () => {
  const log = [
    "Alice: I think it's Bob. VOTE: Bob",
    "Bob: nice try. VOTE: Alice",
    "Carol: VOTE: Bob",
  ].join("\n");

  const result = parseVotes(log, "");
  assert.equal(result.tallies.length, 2);
  assert.equal(result.tallies[0].display, "Bob");
  assert.equal(result.tallies[0].voters.length, 2);
  assert.deepEqual(result.tallies[0].voters, ["Alice", "Carol"]);
  assert.equal(result.tallies[1].display, "Alice");
  assert.equal(result.tallies[1].voters.length, 1);
});

test("unvote removes the vote", () => {
  const log = [
    "Alice: VOTE: Bob",
    "Alice: UNVOTE",
  ].join("\n");

  const result = parseVotes(log, "");
  assert.equal(result.tallies.length, 0);
});

test("only the last action per author counts", () => {
  const log = [
    "Alice: VOTE: Bob",
    "Alice: VOTE: Carol",
  ].join("\n");

  const result = parseVotes(log, "");
  assert.equal(result.tallies.length, 1);
  assert.equal(result.tallies[0].display, "Carol");
});

test("last action within a single message wins", () => {
  const log = ["Alice: VOTE: Bob actually no UNVOTE"].join("\n");
  const result = parseVotes(log, "");
  assert.equal(result.tallies.length, 0);
});

test("lines without an Author: prefix are ignored", () => {
  const log = ["this is not a valid log line"].join("\n");
  const result = parseVotes(log, "");
  assert.equal(result.tallies.length, 0);
  assert.equal(result.debug[0].ignored, true);
});

test("target names are matched case-insensitively against the roster", () => {
  const log = ["Alice: VOTE: bob"].join("\n");
  const result = parseVotes(log, "Alice, Bob, Carol");
  assert.equal(result.tallies[0].display, "Bob");
});

test("majority and not-voting are computed from the roster", () => {
  const log = ["Alice: VOTE: Bob", "Carol: VOTE: Bob"].join("\n");
  const result = parseVotes(log, "Alice, Bob, Carol, Dave");
  assert.equal(result.majority, 3); // floor(4/2)+1
  assert.deepEqual(result.notVoting, ["Bob", "Dave"]);
});

test("buildMessage flags a player who reached majority", () => {
  const log = ["Alice: VOTE: Bob", "Carol: VOTE: Bob", "Dave: VOTE: Bob"].join("\n");
  const result = parseVotes(log, "Alice, Bob, Carol, Dave, Eve");
  const message = buildMessage(result);
  assert.match(message, /Bob\(3\): Alice, Carol, Dave/);
  assert.match(message, /⚠️ Bob has reached majority!/);
  assert.match(message, /With 5 players alive it will take 3 to achieve majority\./);
});

test("re-voting without an explicit UNVOTE still overrides the previous vote", () => {
  const log = ["Alice: VOTE: Bob", "Alice: actually VOTE: Carol"].join("\n");
  const result = parseVotes(log, "");
  assert.equal(result.tallies.length, 1);
  assert.equal(result.tallies[0].display, "Carol");
  assert.deepEqual(result.tallies[0].voters, ["Alice"]);
});

test("tied vote counts are ordered by who reached that count first, not alphabetically", () => {
  // Bob reaches 2 votes before Alice does, even though "Alice" sorts first.
  const log = ["Carol: VOTE: Bob", "Dave: VOTE: Bob", "Eve: VOTE: Alice", "Frank: VOTE: Alice"].join("\n");
  const result = parseVotes(log, "");
  assert.equal(result.tallies[0].display, "Bob");
  assert.equal(result.tallies[1].display, "Alice");
});

test("vote with no target name is ignored", () => {
  const log = ["Alice: I VOTE"].join("\n");
  const result = parseVotes(log, "");
  assert.equal(result.tallies.length, 0);
});

// --- Forum "print" thread format --------------------------------------------

function forumPost(author, timestamp, body) {
  return `Title: Re: Test Game\nPost by: ${author} on ${timestamp}\n${body}\n\n`;
}

test("forum format: basic vote via Post by: header", () => {
  const log =
    forumPost("Bobsal", "May 1, 2026, 1:00:00 PM", "Day 1 Start\n\nAlive Player List\n\n1. Alice\n2. Bob\n\nWith 2 players alive it will take 2 to achieve majority.") +
    forumPost("Alice", "May 1, 2026, 1:05:00 PM", "vote bob") +
    forumPost("Bob", "May 1, 2026, 1:06:00 PM", "vote:alice");

  const result = parseVotes(log, "");
  assert.equal(result.day, 1);
  assert.deepEqual(result.roster, ["Alice", "Bob"]);
  assert.equal(result.majority, 2);
  assert.equal(result.tallies.length, 2);
});

test("forum format: quoted old vote is not re-counted as a new vote", () => {
  const log =
    forumPost("Bobsal", "May 1, 2026, 1:00:00 PM", "Day 1 Start\n\nAlive Player List\n\n1. Alice\n2. Bob\n\nWith 2 players alive it will take 2 to achieve majority.") +
    forumPost("Alice", "May 1, 2026, 1:05:00 PM", "vote bob") +
    forumPost(
      "Bob",
      "May 1, 2026, 1:10:00 PM",
      "Quote from: Alice on May 1, 2026, 1:05:00 PM\nvote bob\n\nlol why would you pick me"
    );

  const result = parseVotes(log, "");
  // Bob's real reply has no vote keyword, so Bob should not appear as a voter.
  assert.equal(result.tallies.length, 1);
  assert.equal(result.tallies[0].display, "Bob");
  assert.deepEqual(result.tallies[0].voters, ["Alice"]);
});

test("forum format: mod recap posts (Vote Count / Alive Player List) are not scanned for votes", () => {
  const log =
    forumPost("Bobsal", "May 1, 2026, 1:00:00 PM", "Day 1 Start\n\nAlive Player List\n\n1. Alice\n2. Bob\n\nWith 2 players alive it will take 2 to achieve majority.") +
    forumPost("Alice", "May 1, 2026, 1:05:00 PM", "vote bob") +
    forumPost("Bobsal", "May 1, 2026, 1:10:00 PM", "Day 1 Vote Count\nBob(1): Alice");

  const result = parseVotes(log, "");
  assert.equal(result.tallies.length, 1);
  assert.deepEqual(result.tallies[0].voters, ["Alice"]);
});

test("forum format: a later Day N Start resets the tally", () => {
  const log =
    forumPost("Bobsal", "May 1, 2026, 1:00:00 PM", "Day 1 Start\n\nAlive Player List\n\n1. Alice\n2. Bob\n\nWith 2 players alive it will take 2 to achieve majority.") +
    forumPost("Alice", "May 1, 2026, 1:05:00 PM", "vote bob") +
    forumPost("Bobsal", "May 2, 2026, 1:00:00 PM", "Day 2 Start\n\nAlive Player List\n\n1. Alice\n2. Bob\n\nWith 2 players alive it will take 2 to achieve majority.") +
    forumPost("Bob", "May 2, 2026, 1:05:00 PM", "vote alice");

  const result = parseVotes(log, "");
  assert.equal(result.day, 2);
  assert.equal(result.tallies.length, 1);
  assert.equal(result.tallies[0].display, "Alice");
  assert.deepEqual(result.tallies[0].voters, ["Bob"]);
});

test("forum format: an unresolved vote target is shown raw in a separate list instead of silently dropped (e.g. a typo)", () => {
  const log =
    forumPost("Bobsal", "May 1, 2026, 1:00:00 PM", "Day 1 Start\n\nAlive Player List\n\n1. Blott\n2. Zorf\n\nWith 2 players alive it will take 2 to achieve majority.") +
    forumPost("Alice", "May 1, 2026, 1:05:00 PM", "vote:blitt");

  const result = parseVotes(log, "");
  // Not a real tally entry (an unknown "blitt" shouldn't count toward anyone's
  // majority) -- it shows up in the separate unresolved list instead.
  assert.equal(result.tallies.length, 0);
  assert.equal(result.unresolvedTallies.length, 1);
  assert.equal(result.unresolvedTallies[0].display, "blitt");
  assert.deepEqual(result.unresolvedTallies[0].voters, ["Alice"]);
});

test("forum format: a 'vote' with nothing after it is ignored rather than treated as a target", () => {
  const log =
    forumPost("Bobsal", "May 1, 2026, 1:00:00 PM", "Day 1 Start\n\nAlive Player List\n\n1. Blott\n2. Zorf\n\nWith 2 players alive it will take 2 to achieve majority.") +
    forumPost("Alice", "May 1, 2026, 1:05:00 PM", "vote: blott") +
    forumPost("Alice", "May 1, 2026, 1:10:00 PM", "hmm let me think, I vote");

  const result = parseVotes(log, "");
  assert.equal(result.tallies.length, 1);
  assert.equal(result.tallies[0].display, "Blott");

  const ignoredNote = result.debug.find((d) => d.ignored && d.line === "Alice");
  assert.ok(ignoredNote, "the empty 'vote' should show up in the debug log");
  assert.match(ignoredNote.note, /nothing followed it/);
});

test("forum format: not-voting uses fuzzy match between full forum name and short roster name", () => {
  const log =
    forumPost("Bobsal", "May 1, 2026, 1:00:00 PM", "Day 1 Start\n\nAlive Player List\n\n1. Blott\n2. Zorf\n\nWith 2 players alive it will take 2 to achieve majority.") +
    forumPost("Blottica", "May 1, 2026, 1:05:00 PM", "vote zorf");

  const result = parseVotes(log, "");
  assert.equal(result.tallies[0].display, "Zorf");
  assert.deepEqual(result.tallies[0].voters, ["Blottica"]);
  // "Blott" is covered by Blottica's vote (fuzzy match); "Zorf" hasn't voted himself.
  assert.deepEqual(result.notVoting, ["Zorf"]);
});

test("forum format: requesting a specific day only tallies that day, even if the thread continues", () => {
  const log =
    forumPost("Bobsal", "May 1, 2026, 1:00:00 PM", "Day 1 Start\n\nAlive Player List\n\n1. Alice\n2. Bob\n\nWith 2 players alive it will take 2 to achieve majority.") +
    forumPost("Alice", "May 1, 2026, 1:05:00 PM", "vote bob") +
    forumPost("Bobsal", "May 2, 2026, 1:00:00 PM", "Day 2 Start\n\nAlive Player List\n\n1. Alice\n2. Bob\n\nWith 2 players alive it will take 2 to achieve majority.") +
    forumPost("Bob", "May 2, 2026, 1:05:00 PM", "vote alice");

  const result = parseVotes(log, "", { day: 1 });
  assert.equal(result.day, 1);
  assert.equal(result.dayFound, true);
  assert.equal(result.tallies.length, 1);
  assert.equal(result.tallies[0].display, "Bob");
  assert.deepEqual(result.tallies[0].voters, ["Alice"]);
});

test("forum format: requesting a day that isn't in the pasted thread is reported, not silently wrong", () => {
  const log = forumPost(
    "Bobsal",
    "May 1, 2026, 1:00:00 PM",
    "Day 1 Start\n\nAlive Player List\n\n1. Alice\n2. Bob\n\nWith 2 players alive it will take 2 to achieve majority."
  );

  const result = parseVotes(log, "", { day: 5 });
  assert.equal(result.dayFound, false);
  const message = buildMessage(result);
  assert.match(message, /Day 5 wasn't found/);
});

test("forum format: post numbers match the forum's own \"Reply #N\" numbering, not a raw post count", () => {
  const log =
    forumPost("Bobsal", "May 1, 2026, 1:00:00 PM", "Day 1 Start\n\nAlive Player List\n\n1. Alice\n2. Bob\n\nWith 2 players alive it will take 2 to achieve majority.") +
    forumPost("Alice", "May 1, 2026, 1:05:00 PM", "vote bob");

  const result = parseVotes(log, "");
  const message = buildMessage(result);
  // Bobsal's post is the thread's original post -- SMF gives it no reply
  // number at all -- so Alice's post right after it is Reply #1, not #2.
  assert.match(message, /Bob\(1\): Alice \(#1\)/);
});

test("forum format: alias whitelist resolves nicknames unrelated to the roster name", () => {
  const log =
    forumPost("Bobsal", "May 1, 2026, 1:00:00 PM", "Day 1 Start\n\nAlive Player List\n\n1. Axatar\n2. Bob\n\nWith 2 players alive it will take 2 to achieve majority.") +
    forumPost("Bob", "May 1, 2026, 1:05:00 PM", "vote joe");

  const result = parseVotes(log, "", { aliasText: "Axatar: Joe, Joe Boy" });
  assert.equal(result.tallies.length, 1);
  assert.equal(result.tallies[0].display, "Axatar");
});

// --- Bold-only voting -------------------------------------------------------
//
// When the pasted content actually carries bold formatting (via the
// contenteditable box's DOM walk in the browser), only a bolded "vote" /
// "unvote" counts, matching most games' own rule. These tests use the same
// \u0001 / \u0002 sentinels the DOM walk emits to simulate that without a
// browser.
const B = "\u0001";
const E = "\u0002";

test("bold-only voting: a bolded vote counts, a plain-text one is ignored", () => {
  const log =
    forumPost("Bobsal", "May 1, 2026, 1:00:00 PM", "Day 1 Start\n\nAlive Player List\n\n1. Alice\n2. Bob\n\nWith 2 players alive it will take 2 to achieve majority.") +
    forumPost("Alice", "May 1, 2026, 1:05:00 PM", `${B}vote bob${E}`) +
    forumPost("Bob", "May 1, 2026, 1:06:00 PM", "I might vote unless someone convinces me otherwise");

  const result = parseVotes(log, "");
  assert.equal(result.tallies.length, 1);
  assert.equal(result.tallies[0].display, "Bob");
  assert.deepEqual(result.tallies[0].voters, ["Alice"]);

  const ignoredNote = result.debug.find((d) => d.line === "Bob" && d.ignored);
  assert.ok(ignoredNote, "Bob's plain-text 'vote' mention should be logged as ignored");
  assert.match(ignoredNote.note, /not in bold/);
});

test("bold-only voting: with no bold anywhere in the paste, plain-text votes still count (backward compatible)", () => {
  const log =
    forumPost("Bobsal", "May 1, 2026, 1:00:00 PM", "Day 1 Start\n\nAlive Player List\n\n1. Alice\n2. Bob\n\nWith 2 players alive it will take 2 to achieve majority.") +
    forumPost("Alice", "May 1, 2026, 1:05:00 PM", "vote bob");

  const result = parseVotes(log, "");
  assert.equal(result.tallies.length, 1);
  assert.equal(result.tallies[0].display, "Bob");
});

test("bold-only voting: only the bolded portion of a message needs to cover the vote keyword", () => {
  const log =
    forumPost("Bobsal", "May 1, 2026, 1:00:00 PM", "Day 1 Start\n\nAlive Player List\n\n1. Alice\n2. Bob\n\nWith 2 players alive it will take 2 to achieve majority.") +
    forumPost("Alice", "May 1, 2026, 1:05:00 PM", `thinking about it... ${B}vote${E}: bob`);

  const result = parseVotes(log, "");
  assert.equal(result.tallies.length, 1);
  assert.equal(result.tallies[0].display, "Bob");
});

// A real forum print page bolds "Title:", "Post by:", the username, and the
// date as separate styled spans (each gets its own bold/color wrapper), so
// the DOM walk emits sentinels *inside* the "Post by: X on Y" header line
// itself, not just around a player's vote. This must not break post
// detection -- a sentinel sitting where the header regex expects a literal
// newline immediately followed by "Post by:" used to make the whole post
// silently fail to be found at all.
function boldForumHeaderPost(author, timestamp, body) {
  return (
    `Title: Re: Test Game\n${B}Post by:${E} ${B}${author}${E} on ${B}${timestamp}${E}\n${body}\n\n`
  );
}

test("bold-only voting: a bolded 'Post by:' header (real forum template styling) doesn't break post detection", () => {
  const log =
    boldForumHeaderPost("Bobsal", "May 1, 2026, 1:00:00 PM", "Day 1 Start\n\nAlive Player List\n\n1. Alice\n2. Bob\n\nWith 2 players alive it will take 2 to achieve majority.") +
    boldForumHeaderPost("Alice", "May 1, 2026, 1:05:00 PM", `${B}vote bob${E}`);

  const result = parseVotes(log, "");
  assert.equal(result.day, 1);
  assert.deepEqual(result.roster, ["Alice", "Bob"]);
  assert.equal(result.majority, 2);
  assert.equal(result.tallies.length, 1);
  assert.equal(result.tallies[0].display, "Bob");
  assert.deepEqual(result.tallies[0].voters, ["Alice"]);
});

test("bold-only voting: a quoted post still resolves correctly when both posts have bolded headers", () => {
  const log =
    boldForumHeaderPost("Bobsal", "May 1, 2026, 1:00:00 PM", "Day 1 Start\n\nAlive Player List\n\n1. Alice\n2. Bob\n\nWith 2 players alive it will take 2 to achieve majority.") +
    boldForumHeaderPost("Alice", "May 1, 2026, 1:05:00 PM", `${B}vote bob${E}`) +
    boldForumHeaderPost(
      "Bob",
      "May 1, 2026, 1:10:00 PM",
      `Quote from: Alice on May 1, 2026, 1:05:00 PM\nvote bob\n\nlol why would you pick me`
    );

  const result = parseVotes(log, "");
  // Bob's real reply has no bolded vote keyword of its own, so he shouldn't
  // appear as a voter -- his quote of Alice's bolded vote must be stripped.
  assert.equal(result.tallies.length, 1);
  assert.equal(result.tallies[0].display, "Bob");
  assert.deepEqual(result.tallies[0].voters, ["Alice"]);
});

// --- DOM-detected quote blocks ----------------------------------------------
//
// When the pasted content came from real HTML, a [quote] block renders as an
// actual <blockquote> element, and the DOM walk marks its text with these
// sentinels (see extractMarkedText/buildPasteFragment). That lets stripQuotes
// drop exactly the quoted lines with certainty, instead of falling back to
// fuzzy "Quote from: X on Y" text-matching against an earlier post.
const Q = "";
const QE = "";

test("DOM-detected quote block is stripped precisely, without falling back to guessing", () => {
  const log =
    forumPost(
      "Bobsal",
      "May 1, 2026, 1:00:00 PM",
      "Day 1 Start\n\nAlive Player List\n\n1. Alice\n2. Bob\n3. Carol\n\nWith 3 players alive it will take 2 to achieve majority."
    ) +
    forumPost(
      "Bob",
      "May 1, 2026, 1:10:00 PM",
      `Quote from: SomeoneNotInThread on Jan 1, 2020, 1:00:00 AM\n${Q}vote alice${QE}\n\nactually i vote carol`
    );

  // The quoted author/timestamp isn't in this thread at all, so the old
  // heuristic (nothing to resolve it against) would have fallen back to
  // "keep only the last paragraph" -- which happens to work here too, but
  // only by luck of paragraph structure. The DOM markers make it exact: the
  // quoted "vote alice" line is dropped because it's quoted, not because of
  // its position in the post.
  const result = parseVotes(log, "");
  assert.equal(result.tallies.length, 1);
  assert.equal(result.tallies[0].display, "Carol");
  assert.deepEqual(result.tallies[0].voters, ["Bob"]);
});

test("bold-only voting: a bolded vote inside a DOM-detected quote block is stripped, not counted", () => {
  const log =
    boldForumHeaderPost(
      "Bobsal",
      "May 1, 2026, 1:00:00 PM",
      "Day 1 Start\n\nAlive Player List\n\n1. Alice\n2. Bob\n\nWith 2 players alive it will take 2 to achieve majority."
    ) +
    boldForumHeaderPost(
      "Bob",
      "May 1, 2026, 1:10:00 PM",
      `Quote from: SomeoneNotInThread on Jan 1, 2020, 1:00:00 AM\n${Q}${B}vote alice${E}${QE}\n\nlol no thanks`
    );

  const result = parseVotes(log, "");
  assert.equal(result.tallies.length, 0);
});

test("forum format: real game excerpt (Day 10) matches the game master's own final tally", () => {
  const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "day10.txt"), "utf8");
  const result = parseVotes(fixture, "");

  assert.equal(result.day, 10);
  assert.equal(result.majority, 4);

  assert.equal(result.tallies.length, 2);
  const blott = result.tallies.find((t) => t.display === "Blott");
  const zorf = result.tallies.find((t) => t.display === "Zorf");

  assert.ok(blott, "Blott should have votes");
  assert.deepEqual(blott.voters.sort(), ["Eleplane", "Mytholxgy", "Nightexe", "Zorf"].sort());

  assert.ok(zorf, "Zorf should have votes");
  assert.deepEqual(zorf.voters, ["Blottica"]);

  // Ribs's post only quotes an old (unresolvable) message and adds no new
  // vote of his own, and cellucore never casts a vote this day.
  const voters = result.tallies.flatMap((t) => t.voters);
  assert.ok(!voters.includes("Ribs"));
  assert.ok(!voters.includes("cellucore"));
});

// --- BBCode output formats (mid-day check-in vs end-of-day final) ----------

test("buildMessage mid-day mode: BBCode tally, alphabetical alive roster, majority and day-ends lines", () => {
  const log =
    forumPost(
      "Bobsal",
      "May 1, 2026, 1:00:00 PM",
      "Day 5 Start\n\nAlive Player List\n\n1. Zorf\n2. Ele\n3. Blott\n4. Cell\n\nWith 4 players alive it will take 3 to achieve majority."
    ) +
    forumPost("Ele", "May 1, 2026, 1:05:00 PM", "vote blott") +
    forumPost("Zorf", "May 1, 2026, 1:06:00 PM", "vote blott");

  const result = parseVotes(log, "");
  const message = buildMessage(result, { mode: "midday", dayEndsOn: "Wednesday", dayEndsAt: "8pm eastern" });

  assert.match(message, /^\[size=4\]\[color=yellow\]Day 5 Vote Count\[\/color\]\[\/size\]\n/);
  assert.match(message, /Blott\(2\): Ele \(#1\), Zorf \(#2\)/);

  // Alive Player List is the *whole* roster, alphabetically, regardless of
  // the order it was originally posted in (Zorf, Ele, Blott, Cell above).
  const rosterIdx = message.indexOf("Alive Player List");
  assert.ok(rosterIdx !== -1);
  const rosterBlock = message.slice(rosterIdx);
  assert.match(rosterBlock, /1\. Blott\n2\. Cell\n3\. Ele\n4\. Zorf/);

  assert.match(message, /\[color=yellow\]With 4 players alive it will take 3 to achieve majority\.\[\/color\]/);
  assert.match(message, /Day 5 ends Wednesday at 8pm eastern\.$/);
});

test("buildMessage mid-day mode: day-ends line is omitted when the time isn't provided", () => {
  const log = forumPost(
    "Bobsal",
    "May 1, 2026, 1:00:00 PM",
    "Day 1 Start\n\nAlive Player List\n\n1. Alice\n2. Bob\n\nWith 2 players alive it will take 2 to achieve majority."
  );
  const result = parseVotes(log, "");
  const message = buildMessage(result, { mode: "midday" });
  assert.ok(!message.includes("ends"));
});

test("buildMessage final mode: title, top-voted player dies, closing night banner", () => {
  const log =
    forumPost(
      "Bobsal",
      "May 1, 2026, 1:00:00 PM",
      "Day 5 Start\n\nAlive Player List\n\n1. Alice\n2. Bob\n3. Carol\n\nWith 3 players alive it will take 2 to achieve majority."
    ) +
    forumPost("Alice", "May 1, 2026, 1:05:00 PM", "vote bob") +
    forumPost("Carol", "May 1, 2026, 1:06:00 PM", "vote bob");

  const result = parseVotes(log, "");
  const message = buildMessage(result, { mode: "final", dayEndsOn: "Wednesday", dayEndsAt: "8pm eastern" });

  assert.match(message, /^\[size=4\]\[color=yellow\]Day 5 Final Vote Count\[\/color\]\[\/size\]\n/);
  assert.match(message, /Bob\(2\): Alice \(#1\), Carol \(#2\)/);
  assert.match(message, /Bob has died/);
  // Final mode never shows the alive roster or the mid-day majority line.
  assert.ok(!message.includes("Alive Player List"));
  assert.ok(!message.includes("With 3 players alive"));
  assert.match(
    message,
    /\[b\]\[size=4\]\[color=red\]Day 5 is over\. THE NIGHT WILL END Wednesday @ 8pm eastern\[\/color\]\[\/size\]\[\/b\]$/
  );
});

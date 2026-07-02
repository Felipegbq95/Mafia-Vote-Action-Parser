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
  const message = buildMessage("Day 1", result);
  assert.match(message, /Bob \(3\): Alice, Carol, Dave/);
  assert.match(message, /Majority: 3 votes needed\./);
  assert.match(message, /⚠️ Bob has reached majority!/);
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

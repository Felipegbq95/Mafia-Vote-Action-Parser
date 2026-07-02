const test = require("node:test");
const assert = require("node:assert/strict");
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

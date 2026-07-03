# Mafia Vote Counter

A static, no-backend web app that parses a pasted Mafia game thread and
produces a ready-to-post vote tally.

## Usage

Open `index.html` in a browser (or serve the folder with any static file
server, e.g. `npx serve .`). Paste your forum's **"Print"** thread view
(the format with `Title:` / `Post by: Name on <date>` repeated per post)
into the game thread box. Unlike a plain `<textarea>`, that box keeps rich
formatting when you paste (bold, links, colors) because it's a
contenteditable element, not a plain text field. Images and gifs embedded in
the posts (avatars, memes, screenshots) are stripped out of the paste before
they ever touch the page, so a real, long-running game thread full of them
pastes in instantly instead of freezing the tab while dozens of images try to
load. From your game master's own posts we auto-detect:

- the current day (from the most recent `Day N Start`, so pasting the whole
  thread from game start each time works fine: only the latest day is
  tallied)
- the alive player roster (from `Alive Player List`)
- the majority threshold (from `...it will take N to achieve majority`)

Within that day, each player's most recent message wins:

- `VOTE: Name` casts (or changes) that player's vote
- `UNVOTE` clears that player's current vote

If your paste has any bold formatting in it at all, **only a bolded
`VOTE`/`UNVOTE` counts**. A plain-text mention of the word "vote" in
someone's prose (e.g. "I might vote unless someone convinces me otherwise")
is ignored, matching the common house rule that unbolded votes don't count.
If nothing in the paste is bold (e.g. a plain-text log), every `VOTE`/
`UNVOTE` mention counts as before; this only kicks in once real formatting
is actually present.

A name after `VOTE:` that doesn't match anyone on the detected roster or
alias list (typically a typo) isn't dropped or guessed at. It shows up
verbatim in a separate "Votes that didn't match a player" box in the
results, so you can spot and correct it without it silently affecting the
real tally or majority count.

Quoted earlier messages are stripped out so a quoted old vote isn't
re-counted as a new one from whoever quoted it. When you paste real HTML
(the normal case), a `[quote]` renders as an actual bordered/indented box in
the paste area, and that real structure is used to drop the quoted lines
with certainty. If a quote has no such structure to go on (a plain-text
paste), it falls back to matching the `Quote from: X on Y` header against an
earlier post on a best-effort basis. Game-master recap posts (`Vote Count`,
eliminations, etc.) are excluded from voting entirely. Forum usernames that
differ from the shorter names players vote with (e.g. a poster called
`Blottica` voting as "Blott") are matched against the detected roster.

A player who re-votes without ever typing `UNVOTE` is handled the same as an
explicit unvote-then-vote: whatever their latest message says wins.

The output is formatted as SMF BBCode, ready to paste straight into a forum
post. Vote tallies read `Name(count): voter1 (#12), voter2 (#47)`, where
`#N` matches the forum's own "Reply #N" numbering: the thread's very first
post doesn't get a reply number of its own, so the post right after it is
`#1`. This only lines up with the forum's real numbering if you paste the
whole thread from its true first post each time; a partial paste yields
numbers relative to wherever the paste starts instead. Players are ranked by
vote count, and **ties are broken by whoever reached that count first**
(standard mafia tie rules), not alphabetically.

There are two output shapes, picked with the **Vote count type** dropdown:

- **Mid-day check-in** (default): tallies, a bolded red
  "`Name has reached majority!`" line for anyone there, then the full alive
  roster (alphabetical, not the order the game master posted it in), the
  majority threshold, and a reminder of when the day ends.
- **End of day (final)**: a shorter closing announcement, tallies, whoever
  has the most votes ("`X has died`"), and a bolded red banner declaring the
  night has begun. No roster or majority line, since the day's already over.

Both use the **Day ends on** / **Day ends at** fields (e.g. "Wednesday" /
"8pm eastern") to fill in that reminder or banner; leave either blank to
omit that line entirely. "Day ends at" is saved in your browser since it's
usually the same all game; "Day ends on" changes each day so it isn't.

A plain `Username: message` log (one message per line) also works if you'd
rather not paste a forum export; see the in-app placeholder for the exact
format. Post numbers aren't shown for that format since there's no real
post ordering to reference.

Optional fields:

- **Day #**: tally a specific day instead of the latest one. Useful if
  you're pasting the whole thread but want an earlier day's result, or to
  double check a day before it's over. Leave blank to auto-use the most
  recent `Day N Start`. If the requested day isn't found in what you pasted,
  you'll get a warning instead of a silently empty/wrong tally.
- **Player list fallback**: only used if no roster could be auto-detected.
- **Vote count type / Day ends on / Day ends at**: see output format above.
- **Known aliases**: one player per line as `RosterName: nickname1,
  nickname2`, for players who go by a name unrelated to their roster/forum
  name (e.g. "Axatar" also goes by "Joe"). Checked before any fuzzy
  name-guessing. Saved in your browser (`localStorage`) so a recurring group
  doesn't have to re-enter it every game.

Click **Count Votes** to generate the tally, then **Copy message** to copy the
formatted result straight to your clipboard for posting.

### Known limitations

- Quote-stripping is exact when pasted HTML has real `[quote]` structure to
  detect, but falls back to a heuristic (keeping only the last paragraph of
  the post) for plain-text pastes where a `Quote from: X on Y` header can't
  be resolved against an earlier post. This covers the common cases but
  isn't foolproof.
- Post numbers are computed locally from what you pasted, matching the
  forum's "Reply #N" numbering only if you paste starting from the thread's
  true first post; a partial paste yields numbers relative to wherever the
  paste starts, not the forum's real reply IDs.
- Bold-only enforcement checks whether the `VOTE`/`UNVOTE` *keyword itself*
  is bolded, not the target name: bolding just the player's name without
  bolding the word "vote" won't count. It also only activates when the paste
  has bold formatting somewhere in it at all; a fully plain-text paste never
  requires bold, so nothing breaks for games that don't use this rule.
- Special vote-weight abilities (e.g. a "double vote" role) aren't detected
  automatically; each player's tally still counts as one vote.
- Non-lynch votes using the same `VOTE:` syntax for unrelated day-one events
  (e.g. a "vote for your favorite picture" mini-game) will be parsed as if
  they were lynch votes.

## Development

```
npm test
```

Runs the parser test suite (`app.test.js`, including a real-game fixture in
`fixtures/day10.txt`) with Node's built-in test runner.

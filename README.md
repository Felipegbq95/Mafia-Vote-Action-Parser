# Mafia Vote Counter

A static, no-backend web app that parses a pasted Mafia game thread and
produces a ready-to-post vote tally.

## Usage

Open `index.html` in a browser (or serve the folder with any static file
server, e.g. `npx serve .`). Paste the **"Print" / text-only** thread view
from your forum (the format with `Title:` / `Post by: Name on <date>`
repeated per post). From your game master's own posts we auto-detect:

- the current day (from the most recent `Day N Start`, so pasting the whole
  thread from game start each time works fine — only the latest day is
  tallied)
- the alive player roster (from `Alive Player List`)
- the majority threshold (from `...it will take N to achieve majority`)

Within that day, each player's most recent message wins:

- `VOTE: Name` — casts (or changes) that player's vote
- `UNVOTE` — clears that player's current vote

Quoted earlier messages (`Quote from: X on Y`) are stripped out on a
best-effort basis so a quoted old vote isn't re-counted as a new one from
whoever quoted it. Game-master recap posts (`Vote Count`, eliminations, etc.)
are excluded from voting entirely. Forum usernames that differ from the
shorter names players vote with (e.g. a poster called `Blottica` voting as
"Blott") are matched against the detected roster.

A player who re-votes without ever typing `UNVOTE` is handled the same as an
explicit unvote-then-vote — whatever their latest message says wins.

The output format matches how game masters usually post it by hand:
`Name(count): voter1 (#12), voter2 (#47)`, where `#N` is that voter's
position across the *entire pasted thread* (so it only lines up with a game
master's real numbering if you paste the whole thread from post #1 each
time). Players are ranked by vote count, and **ties are broken by whoever
reached that count first** (standard mafia tie rules), not alphabetically.

A plain `Username: message` log (one message per line) also works if you'd
rather not paste a forum export — see the in-app placeholder for the exact
format. Post numbers aren't shown for that format since there's no real
post ordering to reference.

Optional fields:

- **Day #** — tally a specific day instead of the latest one. Useful if
  you're pasting the whole thread but want an earlier day's result, or to
  double check a day before it's over. Leave blank to auto-use the most
  recent `Day N Start`. If the requested day isn't found in what you pasted,
  you'll get a warning instead of a silently empty/wrong tally.
- **Player list fallback** — only used if no roster could be auto-detected.
- **Known aliases** — one player per line as `RosterName: nickname1,
  nickname2`, for players who go by a name unrelated to their roster/forum
  name (e.g. "Axatar" also goes by "Joe"). Checked before any fuzzy
  name-guessing. Saved in your browser (`localStorage`) so a recurring group
  doesn't have to re-enter it every game.

Click **Count Votes** to generate the tally, then **Copy message** to copy the
formatted result straight to your clipboard for posting.

### Known limitations

- Quote-stripping is heuristic, not a full BBCode parser — reused quote
  markup that doesn't cleanly resolve is handled by keeping only the last
  paragraph of the post, which covers the common cases but isn't foolproof.
- Post numbers are a locally-computed count of posts in what you pasted, not
  the forum's true internal reply IDs (which aren't present in the
  text-only export) — accurate only if you paste from post #1 onward.
- Special vote-weight abilities (e.g. a "double vote" role) aren't detected
  automatically — each player's tally still counts as one vote.
- Non-lynch votes using the same `VOTE:` syntax for unrelated day-one events
  (e.g. a "vote for your favorite picture" mini-game) will be parsed as if
  they were lynch votes.

## Development

```
npm test
```

Runs the parser test suite (`app.test.js`, including a real-game fixture in
`fixtures/day10.txt`) with Node's built-in test runner.

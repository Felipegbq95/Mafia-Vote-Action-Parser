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

A plain `Username: message` log (one message per line) also works if you'd
rather not paste a forum export — see the in-app placeholder for the exact
format.

Optional fields:

- **Day label override** — use if you want a specific label instead of the
  auto-detected day number
- **Player list fallback** — only used if no roster could be auto-detected

Click **Count Votes** to generate the tally, then **Copy message** to copy the
formatted result straight to your clipboard for posting.

### Known limitations

- Quote-stripping is heuristic, not a full BBCode parser — reused quote
  markup that doesn't cleanly resolve is handled by keeping only the last
  paragraph of the post, which covers the common cases but isn't foolproof.
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

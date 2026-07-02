# Mafia Vote Counter

A static, no-backend web app that parses a pasted Mafia game log and produces
a ready-to-post vote tally.

## Usage

Open `index.html` in a browser (or serve the folder with any static file
server, e.g. `npx serve .`). Paste your game log into the text box, one
message per line, formatted as:

```
Username: message text
```

The parser looks for these actions anywhere in a message:

- `VOTE: Name` — casts (or changes) that user's vote to `Name`
- `UNVOTE` — clears that user's current vote

Only each player's **last** action counts, and only their last message's
action is used, so re-voting or unvoting later in the log overrides earlier
lines.

Optional fields:

- **Day label** — prefixes the output, e.g. `Day 3`
- **Player list** — comma-separated roster used to compute majority (floor(N/2)+1),
  flag whoever has reached it, and list players who currently have no vote

Click **Count Votes** to generate the tally, then **Copy message** to copy the
formatted result straight to your clipboard for posting.

## Development

```
npm test
```

Runs the parser test suite (`app.test.js`) with Node's built-in test runner.

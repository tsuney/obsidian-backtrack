# Backtrack

One button that undoes your last move.

## The problem

Obsidian goes back well between notes. Press the back command and you land where you were reading, part way down the page.

It cannot go back *inside* a note. A jump to a heading or a block reference never becomes a history entry, so the back command steps over it and takes you to whatever note you had open before. On a long note read through its own table of contents, that is exactly the move you wanted to undo.

On a phone this is worse. There is no hover preview to avoid the jump, and no hotkey to undo it.

## What this does

A small round button appears in the bottom right corner once there is something to undo. Press it and the last move is undone.

- **Inside a note** it puts you back where you were reading.
- **Between notes** it hands the move to Obsidian's own back command, which already does this correctly.

You never have to remember which kind of jump you made. There is one control and it always means the same thing.

Press and hold the button (or right-click it) to hear where it would take you.

There is also a command, **Backtrack: Undo the last move**, if you would rather bind a key.

## Why one button and not two

A control that only handled jumps inside a note would ask you to remember how you arrived. Reading mixes the two freely: note to note, then a heading inside that note, then out to a third note. Two controls for one intention means two answers to one question, and you will pick the wrong one.

So the position is restored in one place only. Between notes, Obsidian already keeps it correctly, and a position kept in two places is a position that will disagree with itself.

## When the button appears and disappears

It appears when there is a move to undo, and it goes when there is not. It is never on a timer. A control that vanishes by itself has to be looked for every time, and a control you have to look for is one you stop trusting.

At most ten moves are remembered, and only for as long as the app is open. Nothing is written to disk and nothing is synced.

If you navigate away by hand and a remembered move no longer fits the note on screen, that move is dropped rather than forced on you.

## Install

Not in the community plugin list yet. Use [BRAT](https://github.com/TfTHacker/obsidian42-brat) with `tsuney/obsidian-backtrack`, or copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/backtrack/`.

## Development

No build step. `main.js` is plain CommonJS.

```bash
node test.js                      # unit and interaction tests, no dependencies
bash scripts/deploy.sh /path/to/vault
```

The tests run first during deploy, and a failure copies nothing.

## Licence

MIT

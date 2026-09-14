# Backtrack

One button that undoes your last move.

## Read without opening tabs

Reading a note means glancing at other notes and at other parts of the same note. Open each one in a tab and the tabs pile up - and most of them you only ever needed to look at once. What is left is a row of tabs where you have to work out which ones still matter.

If you can go and come back in the same tab, you never open them. The tabs you have open are the ones you still have a use for.

That only works if you can undo every kind of jump. Obsidian can already undo the jump between notes, and it puts you back where you were reading. **It cannot undo a jump inside a note.** A heading link or a block reference never becomes a history entry, so the back command steps over it and takes you to whatever note you had open before. On a long note read through its own table of contents - the case where staying in one tab matters most - going back is exactly what you cannot do.

On a phone it is worse. There is no hover preview to avoid the jump, and no hotkey to undo it.

## What it does

A small round button appears once there is something to undo. Press it and the last move is undone.

- **Inside a note** it puts you back where you were reading.
- **Between notes** it hands the move to Obsidian's own back command, which already does this correctly.
- **Out of a pinned note**, where Obsidian opens another pane rather than navigating, it takes you back to the pane you clicked in.

Footnotes count as jumps. Obsidian puts a small arrow at the end of each footnote, but that only helps once you are down there and have noticed it.

You never have to remember which kind of jump you made. There is one control and it always means the same thing.

The link you came from is lit when you land on it, so you do not have to find your line again.

## Using it

- **Press** it to go back. **Enter** or **Space** work when it has focus.
- **Press and hold** (or right-click) to hear where it would take you.
- **Drag** it anywhere. Where you leave it is remembered for that device.
- Commands: **Undo the last move**, and **Put the button back** to undo a drag.

It appears when there is a move to undo and goes when there is not. It is never on a timer: a control that vanishes by itself has to be looked for every time, and a control you have to look for is one you stop trusting.

At most ten moves are remembered, and only for as long as the app is open. Nothing is written to your vault and nothing is synced.

## Why it reads three private values

Obsidian's public API cannot answer one question this needs: **does this pane still have a step to go back to?** Without an answer, the button would offer moves it cannot make, and a button that does nothing is worse than no button.

So three values outside the public API are read: the `app:go-back` command, its availability check, and the pane's own back history. Each is tested for before it is used, and if any is missing the plugin falls back rather than failing. Success is never taken from a return value - it is judged by whether the open file actually changed.

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

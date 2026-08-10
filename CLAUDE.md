# Otto — Claude Code project instructions

Otto is a personal work tracker: a static web app (`index.html` + `css/` +
`js/`) paired with a Cowork skill (`otto-scan`) that scans Slack, email, and
Teams and turns what needs follow-up into tasks and loops.

One-sentence job: **each morning, tell me what I owe people and whether I can
take on more, without digging through Slack, email, and Teams.**

For full setup, see `README.md`. For sharing with someone else, see
`otto-handoff-guide.md`. For the deep design/decision history behind this
project, see `CLAUDE.local.md` (not in this repo — personal, gitignored).

## File structure

```
index.html            markup only
css/style.css         all styles
js/app.js             all behavior — one file, vanilla JS, no build step, no framework
js/verify.js          structural checker
otto-scan/SKILL.md    the Cowork skill; versioned, self-announcing
otto-data.json        NEVER in this repo — the user's real tasks/loops/calendar/name
```

## Non-negotiable rules

1. **After any edit to `js/app.js`, run both, from the repo root:**
   ```
   node --check js/app.js
   node js/verify.js index.html
   ```
   The second is a structural checker specific to this app (dead event
   handlers, orphan tabs, render functions never wired into `renderAll`) —
   `node --check` alone will not catch these.

2. **`otto-data.json` must never be committed.** It's the user's real data.
   `.gitignore` already excludes it — don't remove that entry, and if a new
   personal-data file type is ever introduced, gitignore it too.

3. **Editing `otto-scan/SKILL.md`:** bump the `SKILL VERSION` header and add a
   changelog line on every change, no matter how small. The skill
   self-announces its version on every run specifically so a stale install is
   obvious — this only works if every edit bumps the number. Cowork skill
   installs don't reliably update in place; the user has to **delete and
   re-upload**, not overwrite.

4. **No frameworks, no build step, no bundler.** Otto is intentionally vanilla
   HTML/CSS/JS. Don't introduce React, a bundler, TypeScript, or a package.json
   unless the user explicitly asks to change this architecture.

5. **Capture vs. display, when deciding what to touch:** does the change alter
   *what gets captured* (→ `otto-scan/SKILL.md`) or *how Otto shows/behaves
   with what it already has* (→ `js/app.js` / `css/style.css`)? Most requests
   are the latter.

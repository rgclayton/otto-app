# Otto

**⚠️ TODO: add the live GitHub Pages URL here once Pages is turned on** —
`https://rgclayton.github.io/otto-app/` (or whatever it ends up being). This
is the link you'll actually hand to coworkers, so it belongs at the top.

A personal work tracker: a small static web app (`index.html` + `css/` + `js/`)
paired with a Cowork skill (`otto-scan`) that scans Slack, email, and Teams and
turns what needs follow-up into tasks and loops.

Otto's job, in one sentence: **each morning, tell me what I owe people and whether I
can take on more, without me digging through Slack, email, and Teams.**

## What's in this repo

```
index.html            the app shell — markup only
css/style.css         all styles
js/app.js             all of Otto's behavior
js/verify.js          structural checker — run after any edit to js/app.js
otto-scan/SKILL.md    the Cowork skill that feeds Otto from Slack/email/Teams/calendar
otto-handoff-guide.md setup guide for a new person running their own copy
otto-data.json        NOT in this repo — see below
```

`index.html`, `css/style.css`, and `js/app.js` always travel together — none
of them do anything on their own. Named `index.html` specifically so GitHub
Pages serves it at the repo's root URL with no filename in the address.

## Running it

**Hosted (GitHub Pages):** just open the Pages URL — no setup needed to view
the app itself. (Per-person data setup below still applies.)

**Local, for testing changes:** Otto needs to be served over `localhost`, not
opened as a `file://` link — the File System Access API (the file-link/chain
button) only persists on a secure context, and both `localhost` and a real
HTTPS host (like Pages) qualify; a raw `file://` link does not.

```
cd path/to/this/repo
python3 -m http.server 8000
```

Then open `http://localhost:8000/` (index.html loads automatically).

**A couple of things worth knowing:**
- `favicon.ico` isn't included in this repo — add your own at the repo root if you want a tab icon; without it the app still works fine, just with the browser's default icon.
- After pushing an update, your own browser (or a coworker's) may show a cached
  older version for a bit. A hard refresh (Cmd/Ctrl+Shift+R) forces the latest.

## Your data stays out of the repo

`otto-data.json` — your real tasks, loops, calendar hours, and name — is
git-ignored on purpose and is never checked in. Otto creates it on first
link/first scan, and it should live wherever you keep it locally (e.g. a
synced OneDrive folder), never in version control.

## Making changes to `js/app.js`

After any edit, run both checks before trusting the result (from the repo root):

```
node --check js/app.js
node js/verify.js index.html
```

The second one is a structural checker specific to this app — it catches
wiring bugs that syntax checking alone misses (a rendered view with no event
handler, a tab with no matching section, etc.).

## Updating the `otto-scan` skill

Skill installs in Cowork don't reliably update in place. To roll out a new
version: delete the existing `otto-scan` skill from Cowork's Skills manager,
then upload the current `SKILL.md` fresh. The skill self-announces its
version number on every run, so you can confirm the update actually took.

## Sharing with someone else

See `otto-handoff-guide.md` — it walks a new person through getting their own
independent copy running (their own data file, their own Cowork skill
install, their own Slack/M365 connection). Nothing about a second person's
setup touches your data or vice versa.

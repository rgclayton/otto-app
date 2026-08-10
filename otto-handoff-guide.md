# Setting up Otto — handoff guide

Otto is a personal work tracker: a small web app paired with a Cowork skill
(`otto-scan`) that scans Slack, email, and Teams and feeds it new tasks and
loops. This guide gets a coworker from zero to a running, personal copy.

**Important:** this is a *personal* copy, not a shared one. Tasks, loops, and calendar data are pulling from your own credentials via Cowork — nothing here connects back to
your Otto or your data. Each person runs their own independent instance, using
the same hosted app.

---

## What they'll need

- **Google Chrome or Microsoft Edge** (required — Otto uses the File System Access API, which only these browsers support)
- **Claude Cowork** access, with **Slack** and **Microsoft 365** connectors available
- One file from you: **`otto-scan/SKILL.md`**
- The Otto URL:  https://rgclayton.github.io/otto-app/

You do **not** need to send them the app itself, and they don't need Python or
a local server — the app is hosted, so opening the link is the whole setup for
that part.

---

## Step 1 — Open Otto and pick a data folder

1. Open the Otto URL in Chrome or Edge.
2. Pick (or create) a folder for their data, ideally somewhere cloud-synced
   (OneDrive, Google Drive, etc.) so it's backed up automatically — for
   example `OneDrive/Otto/`. This is just a folder on their machine; nothing
   needs to go in it yet. Otto creates `otto-data.json` there once it's linked.

## Step 2 — Install the `otto-scan` skill in Cowork

1. In Claude, open **Cowork → Customize → Skills**.
2. Click **＋ → Upload a skill** and select the `otto-scan/SKILL.md` file you gave them.
3. Confirm `otto-scan` now appears in their skills list.
4. Make sure **Slack** and **Microsoft 365** are connected in Cowork (Customize → Connectors, or wherever their org exposes this).

## Step 3 — Run the first scan

In a Cowork session:

> *Run the otto-scan skill for yesterday. Write otto-data.json into [their chosen folder from Step 1].*

This creates `otto-data.json` in that folder and stages anything it finds into
a review queue — it does **not** commit things automatically, so nothing lands
on their board unreviewed.

## Step 4 — Link Otto to the data file

Back in the Otto tab:

1. Click the **chain icon** in the top-right.
2. Select the `otto-data.json` file the scan just created.
3. Grant file access when Chrome/Edge prompts.

They should now see the scanned items waiting in the **Review** tab. From here
it's their tool — approve, reject, and triage as normal.

## Step 5 — Confirm it's really working

Two quick checks worth doing on day one:

- **Reload the page.** A reload drops the file permission by design (a browser
  security behavior) — an amber bar should appear saying "Reconnect & load."
  One click on it restores the connection. This is expected, not a bug.
- **Re-run the scan** once more and confirm no duplicates appear — that
  confirms the dedup logic is working correctly for their account.

---

## What they own vs. what's shared

| | Personal to them | Comes from you / the hosted app |
|---|---|---|
| The Otto app itself | — | ✅ same hosted URL everyone uses |
| `otto-scan/SKILL.md` | — | ✅ same file you use |
| `otto-data.json` (their tasks/loops/calendar) | ✅ entirely their own | — |
| Slack/M365 connection | ✅ their own account | — |

Hosting means everyone's always on the latest version of the **app** the
moment you push an update — no re-sending a file. The **skill** is the
exception: Cowork skill installs don't reliably auto-update, so whenever
`otto-scan` changes, re-send `SKILL.md` and have them **delete and re-upload**
it in Cowork rather than overwrite in place.

---

## Known rough edges (be upfront about these)

- **Browser caching.** After you push an update to the app, their browser
  might briefly show an older cached version. A hard refresh
  (Cmd/Ctrl+Shift+R) forces the latest.
- **Chrome/Edge only** — Safari and Firefox don't support the File System
  Access API that Otto's file-linking depends on.
- Everything here is a **personal, single-user setup** — there's no shared
  team view or cross-person visibility (that's a bigger, separate feature,
  not part of this handoff).

# Setting up Otto — handoff guide

Otto is a personal work tracker: a small web app paired with a Cowork skill
(`otto-scan`) that scans Slack, email, and Teams and turns what needs
follow-up into tasks and loops. This guide gets you from zero to a running,
personal copy.

**Important:** this is a *personal* copy, not a shared one. Your tasks,
loops, and calendar data are pulled from your own credentials via Cowork.
Your copy is completely independent — nothing here connects back to the
person who shared this guide with you, or to their data. Everyone runs their own instance, using the same hosted app.

---

## What you'll need

Before you start, make sure you have all of these:

- **Google Chrome or Microsoft Edge** — required. Otto uses the File System
  Access API, which only these two browsers support.
- **Claude Cowork** access, with **Slack** and **Microsoft 365** connectors
  already connected.
- The **`otto-scan/SKILL.md`** file — download it from
  https://github.com/rgclayton/otto-app/blob/main/otto-scan/SKILL.md
- The Otto URL: https://rgclayton.github.io/otto-app/

That's everything. Otto is hosted, so opening the link above is the whole
"install" for the app itself — no Python, no local server, nothing to
download.

> **Note:** the link above always points to the latest published skill. If
> you're testing local changes to `SKILL.md` that haven't been pushed yet,
> use that local copy instead.

---

## Prefer to have an AI walk you through it?

Copy this entire document and paste it into Claude (or another AI
assistant), then ask it to help you install Otto. It will walk you through
Steps 1–5 below, one at a time.

Worth knowing up front: only **Step 3** (running the scan) can actually
happen inside an AI session — it's just a command typed into Cowork. **Steps
1, 2, and 4 need your own click.** Installing a skill, picking a folder, and
granting file access are all gated behind a real user click in the browser —
no AI can do that part for you, no matter how capable it is. For those
steps, the AI's job is to tell you exactly what to click and wait for you to
confirm it worked.

**If you're the AI reading this:** for Steps 1, 2, and 4 —

1. Tell them exactly what to click or type, one action at a time.
2. Wait for them to confirm it worked before moving to the next step.
3. Never say a step is done unless they've told you it is.
4. In Step 3, replace `[your folder path]` with the exact path they gave you
   in Step 2 — don't hand them a command with brackets still in it.

---

## Step 1 — Install the `otto-scan` skill in Cowork

1. In Claude, open **Cowork → Customize → Skills**.
2. Click **＋ → Upload a skill** and select the `otto-scan/SKILL.md` file.
3. Confirm `otto-scan` now appears in your skills list.
4. Make sure **Slack** and **Microsoft 365** are connected in Cowork
   (Customize → Connectors, or wherever your org exposes this).

## Step 2 — Open Otto and pick a data folder

1. Open the Otto URL in Chrome or Edge.
2. Pick (or create) a folder for your data, ideally somewhere cloud-synced
   (OneDrive, Google Drive, etc.) so it's backed up automatically — for
   example `OneDrive/Otto/`. This is just an empty folder for now; the scan
   in Step 3 is what creates `otto-data.json` inside it.

## Step 3 — Run the first scan

In a Cowork session, run this — replacing the bracket with the folder path
from Step 2:

> *Run the otto-scan skill for yesterday. Write otto-data.json into [your folder path].*

This creates `otto-data.json` in that folder and stages anything it finds
into a review queue — it does **not** commit things automatically, so
nothing lands on your board unreviewed.

## Step 4 — Link Otto to the data file

Back in the Otto tab:

1. Click the **chain icon** in the top-right.
2. Select the `otto-data.json` file the scan just created.
3. Grant file access when Chrome/Edge prompts you.
   *(This permission prompt can only be approved by clicking it yourself —
   not even an AI walking you through this can do it on your behalf.)*

You should now see the scanned items waiting in the **Review** tab. From
here it's your tool — approve, reject, and triage as normal.

## Step 5 — Confirm it's really working

Two quick checks worth doing on day one:

- **Reload the page.** A reload drops the file permission by design (a
  browser security behavior) — an amber bar should appear saying "Reconnect
  & load." One click on it restores the connection. This is expected, not a
  bug.
- **Re-run the scan** once more and confirm no duplicates appear — that
  confirms the dedup logic is working correctly for your account.

---

## What's yours vs. what's shared

| | Personal to you | Shared / centrally maintained |
|---|---|---|
| The Otto app itself | — | ✅ same hosted URL everyone uses |
| `otto-scan/SKILL.md` | — | ✅ same file everyone runs |
| `otto-data.json` (your tasks/loops/calendar) | ✅ entirely yours | — |
| Your Slack/M365 connection | ✅ your own account | — |

Because the app is hosted, everyone is always on the latest version the
moment it's updated — nothing to re-send. The skill is the exception: Cowork
skill installs don't reliably auto-update, so whenever `otto-scan` changes,
get the new `SKILL.md` and **delete and re-upload** it in Cowork rather than
overwriting it in place.

---

## Known rough edges

- **Browser caching.** After an update goes out, your browser might briefly
  show an older cached version. A hard refresh (Cmd/Ctrl+Shift+R) forces the
  latest.
- **Chrome/Edge only** — Safari and Firefox don't support the File System
  Access API that Otto's file-linking depends on.
- **Personal, single-user setup** — there's no shared team view or
  cross-person visibility. That's a deliberately separate, bigger feature,
  not part of this handoff.

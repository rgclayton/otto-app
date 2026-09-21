---
name: "otto-scan"
description: "Scan a recent day's Slack, email, and Teams meetings for anything that needs follow-up and turn it into Otto tasks and loops, appended to the shared otto-data.json file. Runs on demand at any time of day, and also on a schedule. Use this skill whenever the user asks to run the scan (or \"morning scan\"), triage yesterday, catch up on what needs follow-up, \"update Otto\", or generate follow-ups — and whenever the scheduled task fires. Trigger even if the user only says something like \"run Otto\", \"what do I owe people\", or \"what did I miss yesterday\"."
---

<!-- SKILL VERSION: v15 · 2026-09-21
     changelog:
       v15 2026-09-21 — write meta.skillVersion on every run so Otto can detect when the installed skill is out of date and prompt users to reinstall
       v14 2026-09-17 — added concrete pending-item JSON examples + field-name cheat sheet (context-loss guard); fixes "undefined" rendering caused by wrong field names after context compaction
       v13 2026-09-04 — name Teams transcript-skip failure mode explicitly; finish-check now requires a stated attempt count so a silent 0 can't pass
       v12 2026-08-07 — meeting hours now count busy OR tentative events (dropped the "accepted" requirement); still excludes free/all-day/cancelled/declined
       v11 2026-07-22 — auto-detect the user's display name from M365/Slack and write settings.userName once, only if blank; never overwrites a value already set (manual or auto)
       v10 2026-07-22 — capture source.from + source.at on every item (provenance line in Otto)
       v9 2026-07-22 — meeting hours now also cover next week (Mon–Fri) to feed the weekly review's "week ahead"
       v8 2026-07-22 — read meta.missed (false-negative flags) as a recall signal; widen coverage cautiously where the user repeatedly flags misses
       v7 2026-07-22 — rolling "since last run" scan window (self-heals missed runs); removed the special Monday weekend rule (now subsumed)
       v6 2026-07-22 — email scans whole mailbox (all folders) within the date window; flag > unread > read as actionable signals
       v5 2026-07-22 — added version header + version-announce in finish-check
       v4 2026-07-22 — Jira/tracker tasks carry both link (ticket) and altLink (email)
       v3 2026-07-22 — calendar meeting hours written to meetingHours (capacity)
       v2 2026-07-21 — Teams meeting records + pending/rejected review queue + feedback ledger
       v1 2026-07-20 — initial scan: Slack/email/Teams → tasks & loops, dedup ledger
     When updating this skill, bump the version line above and add a changelog entry. -->

# Otto Morning Scan

**Running this skill: state its version.** The first thing to do on any run is read the `SKILL VERSION` line above and include it in your summary (e.g. "otto-scan v14"). This lets the user confirm at a glance that the installed copy is the current one — the recurring failure with this skill is an *older* version being executed from memory after an update. Announcing the version makes a stale copy obvious immediately.

Otto is the user's personal work tracker. This skill is its producer: on each run it looks back over everything since the last run, decides what genuinely needs the user to follow up, and writes those items into Otto's data file as **tasks** (work to do) and **loops** (conversations that need a response). Otto reads that file; this skill's only job is to keep it accurately fed without ever creating duplicates.

## The one rule that matters most

**Never add the same thing twice.** This runs every weekday, over overlapping windows, forever. If dedup is sloppy, the user drowns in repeats and stops trusting it. Every item carries a stable `source.sourceId`, and nothing is added if that id has been seen before — see [Idempotency](#idempotency-non-negotiable). Get this right before anything else.

## The data file

Default location: `otto-data.json` in the task's working folder. If the user has pointed Otto at a specific path, use that instead. If the file doesn't exist, create it with the empty shape below.

```json
{
  "tasks": [],
  "loops": [],
  "pending": [],
  "rejected": [],
  "meetings": [],
  "meetingHours": {},
  "settings": { "budget": 15, "dailyHours": 8, "manualStatus": "auto", "theme": "auto", "reviewMode": true, "userName": "" },
  "meta": { "lastRun": null, "processedSourceIds": [], "feedback": [] }
}
```

- `tasks` / `loops` — the **approved**, active items Otto shows on the board.
- `pending` — the **staging queue**: newly scanned items awaiting the user's Approve/Reject. In review mode, the scan writes here, not to `tasks`/`loops`.
- `rejected` — the **durable archive** of rejected items. Never auto-purged; the user can reassess and restore from it later.
- `meetings` — **reference records** of recorded Teams meetings (title, date, recap notes, recording link). These are *not* staged and *not* approved — they go straight into `meetings` for the user to read in Otto's Teams tab. Action items *from* a meeting are still extracted separately into tasks/loops (see Teams gather).
- `meetingHours` — a **map of ISO date → total booked meeting hours** for that day (e.g. `{"2026-07-21": 5.5}`). Powers Otto's capacity gauge. Overwritten each run from the calendar (see [Meeting hours](#meeting-hours-capacity)). Don't confuse with `meetings`: that's recorded-meeting *notes*; this is *how many hours* are booked each day.
- `meta.feedback` — the **learned suppression list** built from rejections (see below).
- `settings.reviewMode` — when `true` (the default while tuning), the scan stages into `pending`. When the user flips it to `false`, the scan commits straight to `tasks`/`loops`.
- `settings.dailyHours` — the user's workday ceiling (Otto's, not yours to compute against). Leave it alone; you only write `meetingHours`.
- `settings.userName` — shown in Otto's header. Set once, only if blank (see step 2). Never overwrite a value that's already there.


Otto ignores fields it doesn't recognize, so `source` and `meta` are safe to include — and this is the exact file Otto reads, so match the field names precisely. Items in `pending` and `rejected` use the same Task/Loop shape below, each additionally carrying a `kind` field (`"task"` or `"loop"`) so the queue knows which list to file an approval into.

## Review mode & the queue

While the classification rules are still being tuned, the scan does **not** put items straight onto the board. It appends them to `pending`. The user reviews the queue in Otto and, per item:

- **Approve** → the item moves from `pending` into `tasks` or `loops` (per its `kind`).
- **Reject** (with a reason) → the item moves from `pending` into `rejected`, stamped with the reason and time. It is archived, not deleted.

Either decision records the item's `sourceId` in `meta.processedSourceIds` so the scan never re-surfaces it on its own. Restoring a rejected item (a manual action in Otto) is the *only* way something leaves the archive — it moves back to `pending` for another look. Because restore is manual, the item keeps its place in `processedSourceIds`; the scan won't duplicate it.

### Task object

A concrete piece of work the user will do (a fix, a doc, a deliverable), as opposed to a conversation.

| field | values | notes |
|---|---|---|
| `id` | string | Set to `"<system>:<sourceId>"` so it's stable across runs |
| `title` | string | Short, action-first: "Fix CORS on milolibs param" |
| `type` | `task` \| `bug` \| `project` | Default `task`; `bug` for defects; `project` for multi-step efforts |
| `area` | string | Best guess at the workstream (e.g. "Site Redesign", "Milo Core"). Leave "" if unclear |
| `eff` | `1` \| `2` \| `3` | Effort: 1 = S (<30 min), 2 = M (a few hrs), 3 = L (half-day+) |
| `pri` | `low` \| `med` \| `high` | See heuristics below |
| `bucket` | `today` \| `mon`–`fri` \| `later` | Urgent/needs-action-now → `today`; otherwise `later` |
| `link` | url | Primary link — where the user acts (ticket / PR / thread / doc). Shows as a prominent chip when `altLink` is also set |
| `altLink` | url | Optional secondary link, shown as a subtle chip. For Jira/GitHub/Workfront tasks, this is the notification email; otherwise omit |
| `note` | string | One-line TLDR so the user needn't reopen the source |
| `done` | `false` | Always false on creation |
| `source` | object | `{ "system": "slack"\|"email"\|"teams", "sourceId": "...", "from": "...", "at": "ISO", "capturedFrom": "morning-scan" }` — `from` and `at` power Otto's provenance line (see [Provenance](#provenance)) |

### Loop object

A conversation where the next action is the user engaging in the thread itself.

| field | values | notes |
|---|---|---|
| `id` | string | `"<system>:<sourceId>"` |
| `src` | `slack` \| `email` \| `other` | Teams items use `other` (Otto has no Teams badge yet); `source.system` still records `teams` |
| `who` | string | Person or channel: "#team-eng", "Priya" |
| `summary` | string | What the thread needs, in one line |
| `needs` | `reply` \| `ticket` \| `meeting` \| `feedback` \| `review` \| `decision` \| `other` | The action type |
| `link` | url | Permalink to the thread/message |
| `done` | `false` | Always false on creation |
| `source` | object | `{ "system": ..., "sourceId": ..., "from": "...", "at": "ISO" }` |

### Concrete pending-item examples

**⚠️ Context-loss guard — read before writing any pending items.** If you are resuming from a summary or compacted context and cannot recall the exact field names, copy these verbatim. Do NOT invent new field names. The field names below are what Otto's UI reads; any deviation causes "undefined" in the review queue. This error has occurred before (v14 changelog) and the examples below are the fix.

Pending items use the **full task or loop shape above, PLUS `kind`**. Both are required simultaneously:
- Omitting `kind` → Otto can't distinguish task from loop, defaults everything to loop rendering.
- Using `kind` without the correct type-specific fields (e.g. writing `body` instead of `note`, or `title` instead of `summary` in a loop) → undefined display values.
- **Always read an existing task and an existing loop from `otto-data.json` before writing pending items**, to confirm the schema matches what's in production.

```json
// Pending TASK — full task shape + kind field
{
  "id": "slack:1789656490.366739",
  "kind": "task",
  "title": "Review Milo PRs #6545 and #6538",
  "type": "task",
  "area": "Milo Core",
  "eff": 2,
  "pri": "med",
  "bucket": "today",
  "link": "https://github.com/adobecom/milo/pull/6545",
  "note": "Dusan Kosanovic asked Ryan to review both PRs.",
  "done": false,
  "source": {
    "system": "slack",
    "sourceId": "1789656490.366739",
    "from": "Dusan Kosanovic",
    "at": "2026-09-17T14:01:30Z",
    "capturedFrom": "morning-scan"
  },
  "created": "2026-09-17T14:52:52Z"
}

// Pending LOOP — full loop shape + kind field
{
  "id": "slack:1789633026.310189",
  "kind": "loop",
  "src": "slack",
  "who": "Narcis Radu",
  "summary": "Narcis raised concerns about a11y SLA due dates; Ryan may need to weigh in.",
  "needs": "feedback",
  "done": false,
  "source": {
    "system": "slack",
    "sourceId": "1789633026.310189",
    "from": "Narcis Radu",
    "at": "2026-09-17T07:37:06Z",
    "capturedFrom": "morning-scan"
  },
  "created": "2026-09-17T14:52:52Z"
}
```

**Field-name cheat sheet (pending items):**

| Wrong ❌ | Correct ✓ | Where |
|---|---|---|
| `kind: "task"` only, no type-specific fields | full task shape + `kind: "task"` | pending tasks |
| `body` | `note` | tasks |
| `createdAt` | `created` | both |
| `type: "loop"` without `kind` | add `kind: "loop"` (Otto routes approvals by `kind`, not `type`) | loops |
| `title` in a loop item | `summary` + `who` | loops |
| `from` at top level | `source.from` | both |

### Meeting object (Teams reference records)

A recorded Teams meeting the user attended, captured as reference notes — **not** staged, **not** approved. Goes straight into `meetings`.

| field | values | notes |
|---|---|---|
| `id` | string | `"teams:<meetingId>"` |
| `title` | string | Meeting subject |
| `date` | ISO string | Meeting start (e.g. `"2026-07-20T15:00:00Z"`) — Otto sorts newest first |
| `notes` | string | The recap/summary: key points and decisions, in plain text. This is the reference the user reads |
| `link` | url | Link to the recording or recap, if the tool provides one; else `""` |
| `source` | object | `{ "system": "teams", "sourceId": "<meetingId>" }` |

## Workflow

1. **Read the file.** Load `otto-data.json` (or create the empty shape). Build the candidate "already seen" set from `meta.processedSourceIds` **plus** the `sourceId`s of every item in `tasks`, `loops`, `pending`, and `rejected`. **Do not** include `meetings` in this set — meeting records dedup separately (against `meetings` only, see Teams gather). Also load `meta.feedback` for suppression (step 5).

2. **Set the user's name, but only if it's blank.** If `settings.userName` is empty, look up the account holder's own display name — prefer the Microsoft 365 profile (their own Graph profile, not a lookup on someone else) over Slack's, since a work display name is usually the more presentable one; fall back to Slack's own-profile name if M365 isn't reachable. Write it to `settings.userName`. **If `settings.userName` already has anything in it — auto-detected before or typed by hand — leave it alone.** This is a one-time convenience, not a sync: the user may prefer a nickname or shortened name, and their choice always wins once made.

3. **Set the window.** Use a **rolling "since last run" window**: scan from `meta.lastRun` up to the current moment. This self-heals — if a scheduled run was missed, the next run automatically covers the gap (including weekends: Monday's run sees `meta.lastRun` was Friday and covers Fri-through-Mon on its own, so there is no special weekend rule). Rules:
   - If `meta.lastRun` is missing (first run, or after a reset), fall back to the **last 48 hours**.
   - **Cap the look-back at 7 days.** If `meta.lastRun` is older than 7 days (e.g. after vacation), scan only the last 7 days and note in the summary that older items were skipped — don't dredge a giant backlog in one batch.
   - **On-demand override:** if the user asks for a specific window ("scan today", "catch up on this week"), honor that instead of the rolling default.
   - This window governs the **follow-up scan** (Slack / email / Teams items). It does **not** govern meeting hours — those are always recomputed for the current week (see [Meeting hours](#meeting-hours-capacity)).

4. **Gather, per source** (use the connected Slack and Microsoft 365 tools; skip any source that isn't connected and note it):
   - **Slack** — direct mentions, DMs, and threads the user participated in that have unanswered replies directed at them. Ignore channels they only lurked in.
   - **Email (Outlook)** — search the **whole mailbox (all folders), filtered by received date within the window** — *not* just the Inbox. The user files read mail into folders as personal organization; filing must not hide an actionable message from the scan, and the date window keeps a whole-mailbox search from dredging up old archived mail. Within that window, treat as actionable any message **addressed to the user that asks for something** and that they haven't already answered. Signals, strongest first: a **follow-up flag** (the most reliable "I owe a reply" marker — honor it regardless of read state or folder), then **unread**, then a read message that plausibly still needs a reply. Ignore newsletters, notifications, and automated mail — **with one exception**: assignment and mention notifications from **Jira, GitHub, and Workfront** are real work, not noise. When an automated mail from one of those tools says an issue/PR/task was **assigned to the user** or **@-mentions the user**, capture it as a **task** (type `bug` for a Jira/GitHub defect, else `task`). For these you MUST set **both** links — this is a two-link task, and dropping the email is a known failure: `link` = the **item's own URL** (the Jira ticket `.../browse/KEY`, the PR, the Workfront task — pull it from the "View issue"/"View request" link in the mail, or build the Jira URL from the issue key + the user's Jira base URL), and `altLink` = the notification email's `webLink`. **Never set `link` without also setting `altLink` for these.** The item URL is primary (prominent); the email is the secondary fallback. Still ignore their purely informational mail (status digests, "X commented", CI results the user isn't mentioned in).
   - **Teams** — **This step is mandatory on every run. Do not skip it.** The documented failure mode is completing Slack/email/calendar work and then stopping without ever calling `read_resource` on any `meetingTranscriptUrl` — the scan appears finished but Teams was silently omitted. Before writing the file you MUST have (1) searched the calendar window for recorded meetings and (2) attempted to read each transcript URL. If none exist or none carry a transcript, say so explicitly — a silent 0 is the failure mode. Then for each **recorded** meeting the user attended in the window that has a recap/transcript, you MUST do **both** of the following. **Doing only the action-item half is the single most common secondary failure — do not skip the meeting record.**
     1. **Capture a meeting record** → build a Meeting object (title, date, `notes` = the recap/key points/decisions, `link` = recording/recap URL) and add it to `meetings`. **Dedup it ONLY against existing `meetings` entries (by meeting id) — never against `processedSourceIds`.** A meeting record and its action items are different things: the action items may already have been processed in an earlier run, but the meeting record should still be created if it isn't already in `meetings`. Do **not** add the meeting id to `processedSourceIds`. This is reference material; it is **never** staged into `pending` and **never** needs approval.
     2. **Extract the user's action items** → any follow-up assigned to or owed by the user becomes a task or loop like any other candidate, staged normally. Give each action item its **own** `sourceId` distinct from the meeting's — e.g. `"<meetingId>#a1"`, `"<meetingId>#a2"` — so the meeting record and its action items don't collide in the seen-set.
     **Rule of thumb: if you read a meeting's transcript for action items, that meeting MUST also have a record in `meetings`. Never one without the other.**
   If transcript access isn't available, note that and continue.
   - **Calendar (capacity)** — separately from Teams recordings above, read the user's Outlook/Teams **calendar** and compute total booked meeting hours per day, writing them to `meetingHours`. See [Meeting hours](#meeting-hours-capacity) for exactly how. This runs every scan regardless of the follow-up window.

5. **Classify & suppress.** Classify each candidate into a task or a loop (rules below), tagging it with `kind`. Then drop any candidate that matches a `meta.feedback` suppression rule (see [Feedback ledger](#the-feedback-ledger)) — these are patterns the user has already rejected repeatedly. One conversation usually yields **one** item; only split into a task *and* a loop when there are clearly two distinct actions.

6. **Dedup.** Drop any candidate whose `sourceId` is in the already-seen set. This is the critical step. **Dedup only on `sourceId` — never on topic or similarity.** Two different messages about the same underlying work (e.g. Alex and Priya both asking about the bento review) are two separate items the user owes two separate responses; keep both. Only an identical source (same message/thread/meeting) is a duplicate. Merging by topic risks silently dropping one person's ask.

7. **Stage & write.** Meeting records always go straight into `meetings` (never staged, deduped only against `meetings`). Meeting **hours** are written to `meetingHours` (overwriting each day in the capacity window — see below). For everything else: if `settings.reviewMode` is `true`, append survivors to **`pending`**; if `false`, append straight to `tasks`/`loops`. Add every **candidate** `sourceId` encountered this run (action items and message/email candidates, even deduped/suppressed ones) to `meta.processedSourceIds` — but **not** meeting ids. **Set `meta.lastRun` to the current moment — this becomes the start of the next run's rolling window, so getting it right is what keeps runs tiling without gaps.** Also set `meta.skillVersion` to the current skill version (e.g. `"v15"`) — Otto reads this to detect when the installed skill is out of date and prompt users to reinstall. Write the file back.

8. **Report.** Start the summary by stating the skill version (from the `SKILL VERSION` header, e.g. "otto-scan v14") **and the window you covered** (e.g. "since Fri 7:02am — 3d") so the range is never a mystery. Then a short plain summary: counts staged (or added) grouped by source, meeting records captured, and the **meeting hours per day** you wrote (e.g. "Mon 5.5h · Tue 3h · Wed 6h · Thu 2h · Fri 4h") — so the user can skim before opening Otto. Note anything suppressed by feedback and any source that failed. Don't restate items skipped as duplicates.

9. **Finish-check (required).** Before you end, verify and state these in your summary:
   - **(a)** how many recorded meetings you read in the window, and **(b)** how many meeting records now exist in `meetings` for that window. **They must match.** If (b) < (a), you skipped the meeting-record step — go back and add the missing records.
   - **(c)** every task sourced from Jira/GitHub/Workfront mail has **both** `link` (the item URL) and a non-empty `altLink` (the email). If any is missing `altLink`, add it before finishing.
   - **(d) Teams transcript attempt count:** state how many calendar meetings in the window you found, how many had a transcript/recording URL you attempted to read (`read_resource` was called), and how many meeting records were written. **A 0 is only valid if you explicitly looked and found none — "Teams step was not reached" is a failure, not a valid 0.** If you cannot account for this count, go back and run the Teams step before finishing.
   These checks exist because silently skipping the Teams transcript step entirely, skipping the meeting-record half, and dropping the second link on tracker tasks, are this skill's three most common failures.

## Classification rules

**Task vs loop.** If the next action happens *inside the thread* (respond, react, decide there) → **loop**. If the next action is a discrete piece of work done *elsewhere* (write, build, fix, file) → **task**.

**When ownership is uncertain, prefer a loop.** Only create a task when it's clear the user owns the work. If someone flags a problem but it's not established that *the user* is the one to fix it (e.g. "the routing doc is 404ing for me"), don't assume ownership and stage a fix-it task — stage a **loop** to reply/triage instead. A loop keeps the ball in the user's court without silently committing them to work that might be someone else's. Turning a reply into a task is one tap for the user; un-committing from a wrongly-assumed task is friction.

**`needs` (loops):** the person wants a written answer → `reply`; a bug/work item logged → `ticket`; time on the calendar → `meeting`; your opinion on something → `feedback`; a PR/doc reviewed → `review`; a choice from the user → `decision`; anything else → `other`.

**Priority (`pri`):**
- `high` — blocks someone else, has a deadline today or tomorrow, or is an explicit urgent ask.
- `med` — a real ask with no urgent deadline (default).
- `low` — actionable but low-stakes / FYI-with-a-nudge.

**Effort (`eff`):** 1 = a quick reply or trivial fix; 2 = a few hours; 3 = half a day or more. When unsure, guess 2.

**Bucket:** `today` only if it genuinely needs action today (high priority or a same-day ask). Everything else → `later`, so Today doesn't get flooded every morning. Never auto-assign specific weekdays; let the user pull items onto days themselves.

## Idempotency (non-negotiable)

- The dedup key is `source.sourceId`: the Slack message `ts`, the email's internet message id / Graph id, or the Teams meeting/event id. Always capture the real, stable id — never a hash of the text (text changes; ids don't).
- A candidate is added only if its `sourceId` is **not** among current items (`tasks`, `loops`, `pending`, `rejected`) **and not** in `meta.processedSourceIds`.
- `meta.processedSourceIds` exists so that if the user **deletes, completes, approves, or rejects** an item, the next run doesn't resurrect it. Always record processed ids there, including ones you skipped or suppressed.
- Set `id = "<system>:<sourceId>"` so the object's own id is also stable and collision-free.

## Capturing links (so the "Open" buttons actually work)

The `link` field powers the "Open in Slack" / "Open email" buttons in Otto. A wrong link is worse than none — it dead-ends the user. Capture the **real, tool-provided permalink**, never a hand-built one.

- **Slack** — use the `permalink` that the Slack tool returns for the message (or fetch it explicitly with the message's channel `id` + `ts`). It looks like `https://<workspace>.slack.com/archives/<CHANNEL_ID>/p<TS>` — a channel **ID** (starts with `C`/`G`/`D`), not the channel name, and the message `ts` with the dot removed, prefixed `p`. **Never** build a URL from the channel name (e.g. `/archives/#team-eng`); those do not resolve.
- **Email (Outlook)** — use the message's Graph `webLink` (opens the mail in Outlook on the web). Don't invent an Outlook URL from the subject or id.
- **Jira / GitHub / Workfront assignment mail** — set `link` to the **item's own URL** (`.../browse/KEY`, the PR, the Workfront request) and `altLink` to the email's `webLink`. The ticket is what the user wants most, so it's primary; the email stays reachable as the secondary chip. Build the Jira URL from the issue key + base URL if the mail doesn't carry a clean "View issue" link.
- **Teams** — use the meeting's/chat's join or permalink URL if the tool provides one; otherwise leave `link` empty.
- **If no reliable permalink is available, set `link` to `""`.** An empty link (no button) is correct; a fabricated one is a bug. The same value also goes in `source.url`.

## Provenance

Every captured item's `source` should carry two fields that let Otto show a quiet "where this came from" line — this is what makes a capture feel trustworthy and a mis-capture understandable at a glance:

- **`from`** — a short, human-readable origin: the Slack channel (`#team-eng`) or DM sender's name, the email sender's name, or the meeting title. Not an id — the thing a human would say.
- **`at`** — the ISO timestamp of the **original** message / email / meeting (when it happened), not when you scanned it.

Both are best-effort: if you genuinely can't determine one, omit it rather than guessing. Otto shows whatever's present (e.g. "from slack · #team-eng · Tue 9:14am"), degrading gracefully to just the system name.

## Meeting hours (capacity)

Every run, populate `meetingHours` — a map of ISO date (`YYYY-MM-DD`, the user's timezone) → total booked hours that day. Otto subtracts these from the user's workday to show how full each day is.

**Which days.** Cover **Monday through Friday of the current week AND next week** (ten weekdays total), plus **today** if today is a weekend. The current week powers Otto's day columns and today's gauge; **next week powers the weekly review's "week ahead" look-ahead**, so the user can see how booked they are before the week starts. This is independent of the follow-up window — do it even on a plain "scan yesterday" run.

**How to count each day's hours:**
- Include real, time-blocking meetings the user is on: events showing as **busy** or **tentative** (no acceptance requirement — a not-yet-responded invite still blocks the time on the calendar).
- **Exclude** all-day events, events marked **free**, declined events, and cancelled events.
- **Don't double-count overlaps.** If two meetings overlap, count the wall-clock time covered once (union of busy intervals), not the sum of both durations — the user only has one clock.
- **Round to the nearest 0.5h.**

**Write behavior.** Set `meetingHours[date] = computed hours` for each day in range — **overwrite**, don't accumulate. Note in your summary that manual edits the user made to a day's hours in Otto are replaced by the calendar value on each run; that's expected (the calendar is the source of truth). If the calendar isn't reachable, leave `meetingHours` untouched and say so — never zero out days you couldn't read.

## The rejected archive

Rejecting is filing, not shredding. A rejected item moves to `rejected` with its full original object intact, plus:

```json
{ "reason": "not-actionable", "rejectedAt": "<ISO timestamp>", "kind": "loop" }
```

`reason` is one of a fixed set — `not-actionable`, `wrong-type`, `wrong-priority`, `already-handled`, `duplicate` — chosen so each maps cleanly to a rule fix. The archive is **never auto-purged**: the user must be able to pull it up later and reassess, in case something was killed by mistake. Restore is always a manual user action; the scan never reads from `rejected` except to keep those `sourceId`s out of new results.

## The feedback ledger

`meta.feedback` is how rejections make future runs quieter *without* waiting on a human rule rewrite. It's a small list of suppression rules distilled from repeated rejections, e.g.:

```json
{ "match": { "system": "slack", "channel": "#random" }, "reason": "not-actionable", "count": 3 }
```

- Otto appends/increments these as the user rejects items (grouping by an obvious signal: sender, channel, subject pattern, meeting series).
- In step 5 the scan drops candidates matching a ledger rule whose `count` is at or above a threshold (start at **3**) — enough repetition to be confident it's noise, not a one-off.
- This only catches blunt, repeating offenders. Nuanced misjudgments still need a human to revise the classification rules in this file — the ledger and the rule rewrites are complementary, not a substitute for each other.

## The missed ledger (recall signal)

`meta.missed` is the mirror of the feedback ledger, for the opposite failure: things the scan **should have caught but didn't**. When the user adds an item by hand in Otto and flags it as a scan miss, Otto appends an entry:

```json
{ "id": "...", "kind": "task", "title": "...", "source": "slack", "at": "2026-07-22T15:00:00Z" }
```

- **At the start of a run, read `meta.missed`.** Treat it as evidence about where your gather rules are too narrow. If the user has flagged **repeated** misses from the same source/channel/sender (say 2+), widen coverage there on this run — e.g. include a Slack channel you'd been treating as lurk-only, or stop filtering a sender you'd been ignoring.
- **Widen cautiously, one signal at a time.** A single flagged miss is a data point, not a mandate — don't over-correct into flooding Review with a channel's noise. Recall and precision trade off; nudge, don't lunge.
- Like the feedback ledger, this handles the blunt, repeating cases. A one-off miss is mostly a signal for a human (the maintainer) to consider a rule change — note anything striking in your summary so it's visible.

## Guardrails

- **Under-add rather than over-add.** A missed item is a minor annoyance; a noisy flood of false positives makes the user abandon the tool. When a candidate is borderline "does this really need follow-up?", leave it out.
- **Never invent.** Every item must trace to a real message/meeting with a real link. No summarizing-into-existence.
- **Don't touch existing items.** Only append. Never edit, reorder, complete, or delete what's already in the file — the user owns those.
- **Preserve the file on error.** If a source fails mid-run, write what you have and report the failure; never overwrite the file with a partial/empty structure.
- **Respect privacy.** Pull only the user's own accounts. Summaries are for the user's own eyes; keep them factual and brief.


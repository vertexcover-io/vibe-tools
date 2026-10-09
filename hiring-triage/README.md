# hiring-triage

A keyboard-driven local web app for working through job applicants stored in a
Notion database. It lists candidates for one position by status, shows their
score, notes, links and resume PDF side by side, and lets you accept, park or
reject each one with a single key. Rejecting sends a polite email through Gmail.

It only talks to Notion (and Gmail for rejections), so it works no matter how
candidates got into the database: by hand, from a form, or from an ingestion
script.

## Run

Node 18+:

```bash
npm install
cp .env.example .env   # fill in NOTION_TOKEN and NOTION_DATA_SOURCE_ID
npm run auth           # once: Google sign-in for sending rejection emails
npm start              # open http://localhost:3737
```

The server reads `.env` from its own folder, so it can be started from anywhere.
Variables already set in the shell override `.env`.

## Prerequisites

- A **Notion integration token**, with the integration shared with your hiring database.
- A **Google OAuth client** (type "Desktop app", Gmail API enabled) for rejection
  emails. Put its ID and secret in `.env`, then run `npm run auth`: it prints a
  sign-in link, you paste back the URL Google redirects to, and it saves
  `GOOGLE_REFRESH_TOKEN` to `.env`. It only asks for permission to send mail.
  Everything except rejecting works without this. If the OAuth app is in
  "Testing" mode, Google expires the token after 7 days.

## Notion database

The database needs these properties:

| Property | Type | Notes |
| --- | --- | --- |
| `Name` | title | |
| `Position` | select | filtered by `POSITION` |
| `Status` | status | `Not started`, `Intro Call`, `Hold`, `Rejected`, … |
| `Email` | email | required before a reject can be sent |
| `Score` | number | 1–10 |
| `Score Reason` | rich text | |
| `Resume` | files | shown inline |
| `Reject Mail Sent At` | date | stamped after the email goes out; blocks a second send |
| `Github`, `Linkedin`, `Profile URL` | url | optional |
| `Source` | select | optional |

## Keys

| Key | Action |
| --- | --- |
| `J` / `K` | next / previous candidate |
| `1`–`9`, `0` | set score (`0` = 10) |
| `A` | Accept → `Intro Call` |
| `M` | Maybe → `Hold` |
| `R` | Reject → preview the email, `Y` sends it and sets `Rejected` |
| `X` / `Space` | select for bulk actions |
| `/` | search by name |
| `N` / `E` | edit notes / email |
| `G` / `L` / `P` | open GitHub / LinkedIn / portfolio |
| `?` | all shortcuts |

Tabs switch between **Not Started**, **Intro** and **Maybe**. Select several
candidates to accept, park, reject or delete them in bulk. Delete moves the
Notion page to the trash and sends nothing.

## Configuration

All settings live in `.env`; see [`.env.example`](.env.example). Only
`NOTION_TOKEN` and `NOTION_DATA_SOURCE_ID` are required.

## Run as a service

`hiring-triage.service` is a systemd user unit that starts the server at boot and
restarts it if it crashes. Install it straight from the repo:

```bash
systemctl --user link "$PWD/hiring-triage.service"
systemctl --user enable --now hiring-triage
journalctl --user -u hiring-triage -f   # logs
```

It assumes the repo is at `~/Projects/vibe-tools`; edit `WorkingDirectory` if not.
After changing `.env`, run `systemctl --user restart hiring-triage`.

Use `stop` / `start` to pause it. `disable` also removes the link to this file,
so after a `disable` you need to run the `link` command again.

## Decision log

Every decision is appended to `decisions.jsonl` in this folder (override with
`DECISIONS_FILE`) with the score and notes at the time, so you can later compare
your calls against an automated scorer. Both `.env` and `decisions.jsonl` are
gitignored.

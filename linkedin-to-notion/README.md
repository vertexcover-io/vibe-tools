# linkedin-to-notion

**Rolodex** — a Chrome extension (Manifest V3) that clips LinkedIn profiles into
a Notion database.

Two ways to use it:

- **On a profile** — click the toolbar icon, check the prefilled form, save.
- **From any list** — right-click someone's name in search results, your
  connections, or a company's people tab and choose
  **Save profile to Notion (Rolodex)**. A hidden tab opens, reads the profile,
  and closes. You never leave the list.

It captures **Name**, **LinkedIn URL**, **Headline Title**, **Connection**,
**Current Company**, **Current Title** and **Location**.

## No duplicates

Every profile URL is reduced to `https://www.linkedin.com/in/SLUG` before it is
used, so the same person clipped from a search list, a connections page and the
profile itself all produce one key. Before writing anything, Rolodex queries the
database for that URL and refuses to add a second row:

- **Popup** — the button changes to *Already in Notion* with a link to the
  existing page. It re-checks immediately before saving, in case the popup sat
  open while you clipped the same person from a list.
- **Right-click** — the check runs *before* a tab is opened, so a duplicate
  costs nothing. You get an "Already in Notion" notification.

This needs a **URL** property in the database. Without one, Settings warns you
that duplicates cannot be blocked.

## Notion setup

1. Create an internal integration at https://www.notion.so/profile/integrations and copy its secret.
2. Create (or pick) a database with these properties:

   | Property | Type |
   | --- | --- |
   | Name | Title |
   | LinkedIn URL | URL |
   | Headline Title | Text |
   | Connection | Select |
   | Current Company | Text |
   | Current Title | Text |
   | Location | Text |

   Names match case-insensitively and common aliases work (`Company`,
   `Headline`, `Role`, `City`). The Title property is matched by type, so it can
   be called anything. Anything unmatched is skipped, and Settings shows the
   exact mapping before you save a single page.

3. Open the database, `...` menu -> Connections -> add your integration.
   Skip this and Notion answers 404.

## Install

1. Open `chrome://extensions`, turn on Developer mode.
2. "Load unpacked" -> choose this folder.

## Use

1. Click the Rolodex icon, open Settings (gear), paste the integration secret and
   the database URL, hit **Connect database**.
2. Then either clip from a profile page, or right-click any profile link in a list.

## The Experience quirk

LinkedIn renders the Experience card on a profile only after a *real* human
scroll. A programmatic scroll plus a ten-second wait does nothing — that was
tested repeatedly. Everything else comes from the top card and is available
instantly.

Rolodex works around it by reading `/in/SLUG/details/experience/`, a standalone
page where the same data renders immediately with no scrolling:

- **Right-click flow** — always uses that page, so Current Title and Company are
  filled in without you doing anything.
- **Popup** — if you have already scrolled to Experience it reads it in place.
  If not, a **Fetch title & company** button appears and does the same
  background-tab trip on demand.

The extension never scrolls the page you are reading. It does not work, and it
would move the page under you.

## Notes

- Current Company prefers Experience. Failing that it falls back to the top-card
  badge, but only when the headline mentions it too — without that check, a
  profile with no current job donates its *university* to the Current Company
  column.
- Several roles at one employer are grouped by LinkedIn: the entry leads with
  the company and a total duration ("Google", "22 yrs 5 mos") before listing
  roles. Parsed naively that puts `22 yrs 5 mos` in the job title, so grouped
  entries are detected and parsed separately.
- The secret lives in `chrome.storage.local` on your machine. Nothing is sent
  anywhere except `api.notion.com`.
- LinkedIn's profile page has no `<h1>`, no JSON-LD, no `og:` tags, and every CSS
  class is a hash like `.c77fab07` that rotates each deploy. The scrapers key off
  card container ids, `componentkey` entry wrappers, reading order, and the
  "Contact info" link. See the comment block in `linkedin-to-notion.js`.

## Files

| File | Role |
| --- | --- |
| `linkedin-to-notion.js` | Shared core — the two page scrapers and the Notion client |
| `popup.js` / `popup.html` | The clip form and settings |
| `background.js` | Context menu, hidden-tab orchestration, notifications |

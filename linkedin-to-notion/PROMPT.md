# Prompts

Agent: Claude Code
Model: Claude Opus 5 (1M context)

## Prompt 1 — initial build

> Help me build a chrome extension that lets me add a linkedin url to a notion
> database. It adds linkedin url + Name, Headline Title, Connection, Current
> Compamy, Current Title, Location

Produced a working Notion round-trip and a plain popup, with field extractors
written against the LinkedIn markup the model remembered (`h1.text-heading-xlarge`,
`div.text-body-medium`, `#experience`). None of it matched the live site.

## Prompt 2 — test it, and make it nice

> Tedt it out the field extractors are not working. Improve the UI, generate good
> icon, better name, etc

Driven with Claude in Chrome against real logged-in profiles (Bill Gates,
Satya Nadella, the author's own). What the live DOM actually showed:

- **Zero `<h1>` elements, no JSON-LD, no `og:` meta tags, no embedded state blob.**
  The profile is a React rebuild ("como") where every class is a rotating hash
  like `.c77fab07`. Selector scraping is not viable.
- **Stable hooks that do exist:** card container ids ending in `Topcard` and
  `ExperienceTopLevelSection`, a handful of `data-testid`s, and the reading
  order of text inside each card.
- **Hidden duplicate lines.** LinkedIn renders extra copies of the degree badge
  and company badge for other breakpoints. On Satya Nadella's profile the hidden
  copy said `1st` while the visible one said `2nd` — reading the DOM naively
  gives the wrong connection degree. Every text node is now filtered by whether
  it occupies space.
- **Location has no reliable class or comma pattern** (`Greater Surat Area`).
  It is found instead by climbing from the "Contact info" link, which shares its
  row.
- **The Experience card only renders after a genuine user scroll.** A single
  `scrollIntoView` followed by a quiet ten-second wait produced nothing, twice;
  a real scroll gesture loaded it within seconds. So the extension no longer
  scrolls at all — it reads Experience when present and says so when not.
- **The top-card company badge is not always a company.** On a profile with no
  current job it is the university. It is accepted as Current Company only when
  the headline mentions it too.
- **Date parsing.** The first regex handled `2018 – Present` but silently missed
  `Sep 2024 - May 2026`, so most roles were skipped and the wrong one could win.
- **Timer drift.** LinkedIn keeps the main thread busy enough that `sleep(250)`
  routinely took ~880ms, turning a 5-attempt retry loop into a 6-second stall.
  The grace period is now a wall-clock deadline, guarded by a cheap
  `textContent.length` check so the expensive visibility walk never runs on a
  skeleton.

Also in this pass: named it **Rolodex**, drew an icon (a contact card on a
rolodex spindle, LinkedIn blue fading to Notion black) and rendered it to PNG at
16/32/48/128, and rebuilt the popup — profile preview with avatar and degree
chip, two-column field grid, gear-toggled settings, live property-mapping table,
and light/dark themes. The rebuilt popup was verified by serving it locally with
the `chrome.*` and `fetch` APIs stubbed, checking every state and the exact
Notion payload it POSTs.

## Prompt 3 — bulk clipping from lists, and no duplicates

> Can we add it to right click on a profile in a list page -> open it on the tab
> extract details and close it ?

> Also when adding to notion should prevent duplicate using linkedin url

> Current title / 6 yrs 9 mos / Current company are broken

Three things in one pass.

**Right-click clipping.** A context menu on `*://*.linkedin.com/in/*` links,
backed by a new service worker. It opens the profile in a background tab, reads
the top card, then navigates the same tab to `/details/experience/`, then closes
it. Feedback comes as a toolbar badge and a system notification.

This only became possible because of a discovery made while testing: the
standalone `/in/SLUG/details/experience/` page renders the full history
immediately at `scrollY: 0` — measured at 7ms — while the profile page's inline
Experience card needs a real human scroll that a background tab will never get.
The same page now also powers a "Fetch title & company" button in the popup,
which removes the "go scroll down first" wart from the previous version.

**Duplicate prevention.** Profile URLs are normalised to
`https://www.linkedin.com/in/SLUG` — stripping `?miniProfileUrn=...`, trailing
slashes, `/details/experience/`, bare hosts and regional subdomains — then
matched against the database before writing. The right-click flow checks *before*
opening a tab, so a duplicate costs zero page loads. The popup re-checks
immediately before the POST in case it sat open while the same person was clipped
from a list. Matching uses several exact `equals` variants rather than
`contains`, because `contains: "/in/jay"` would collide with `/in/jay-sutariya`.

A first cut of the normaliser accepted `https://example.com/in/nope` and
rewrote it into a linkedin.com URL; a hostname check was added.

**The grouped-roles bug.** Reported from real use as a job title reading
`6 yrs 9 mos`, and reproduced exactly on Sundar Pichai's profile. When someone
has held several roles at one employer, LinkedIn groups the entry:

```
Google                            <- company
22 yrs 5 mos                      <- total duration
CEO                               <- role
2015 - Present
Product Management + Leadership   <- earlier role
Apr 2004 - 2015 - 10 yrs 10 mos
```

The parser anchored on the date line and stepped back two, which on a grouped
entry yields the duration as the title and the role as the company. The fix was
structural: both pages wrap each entry in
`componentkey="entity-collection-item--*"`, so entries are parsed individually,
a leading duration line marks a grouped entry, and durations and date ranges are
rejected as titles or company names outright. Verified against grouped
(Sundar Pichai, both pages) and ungrouped profiles (10 roles parsed correctly).

The scrapers were also split in two — `scrapeProfilePage` for the top card and
`scrapeExperience` for whichever experience card a page has — so the popup and
the service worker share one implementation instead of two drifting copies.

## Decisions the agent made without being asked

- **Scrape the open tab rather than fetch a pasted URL.** Profiles are behind an
  auth wall; a background fetch returns a login page.
- **Editable form before saving.** LinkedIn's markup will break this again.
  Saving never depends on the scrape.
- **Runtime schema matching.** The database schema is fetched and each field
  mapped to a property by name (with aliases), Name by `title` type. Values are
  coerced to whatever type the property actually is, so no hard-coded schema and
  no type-mismatch errors.
- **Blank over wrong.** Where a value cannot be trusted (company badge that might
  be a university, Experience that has not loaded) the field is left empty with
  an explanation, rather than guessed.
- **No content script, no service worker.** Everything runs in the popup, which
  is an extension page and so bypasses CORS for hosts in `host_permissions`.
- **Notion API pinned to `2022-06-28`** so `parent: { database_id }` keeps working
  (2025-09-03 moves databases to data sources).
- **Check for duplicates before spending a page load,** not after.
- **Never scroll the reader's page.** It does not trigger LinkedIn's lazy load
  anyway, and it moves the page under them.

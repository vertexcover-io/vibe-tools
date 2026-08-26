// AI-generated. See PROMPT.md for the prompts and model used.
//
// Shared core: profile scrapers plus the Notion client. Imported by both
// popup.js (the clip form) and background.js (the right-click flow).

export const NOTION_VERSION = '2022-06-28';

export const FIELDS = [
  { key: 'name', label: 'Name', aliases: ['name', 'full name', 'person', 'contact'] },
  { key: 'url', label: 'LinkedIn URL', aliases: ['linkedin url', 'linkedin', 'profile url', 'link', 'url'] },
  { key: 'headline', label: 'Headline Title', aliases: ['headline title', 'headline', 'tagline'] },
  { key: 'connection', label: 'Connection', aliases: ['connection degree', 'connection', 'degree'] },
  { key: 'company', label: 'Current Company', aliases: ['current company', 'company', 'organisation', 'organization', 'employer'] },
  { key: 'title', label: 'Current Title', aliases: ['current title', 'current role', 'job title', 'role', 'position', 'title'] },
  { key: 'location', label: 'Location', aliases: ['location', 'city', 'based in', 'region'] },
];

// ---------------------------------------------------------------- urls

// Every profile reduces to https://www.linkedin.com/in/<slug> so that the same
// person clipped from a search list, a connections page and the profile itself
// produces one identical key to deduplicate on.
export const normalizeProfileUrl = (raw) => {
  try {
    const parsed = new URL(String(raw), 'https://www.linkedin.com');
    if (!/(^|\.)linkedin\.com$/i.test(parsed.hostname)) return '';
    const match = parsed.pathname.match(/^\/in\/([^/]+)/);
    if (!match) return '';
    return 'https://www.linkedin.com/in/' + decodeURIComponent(match[1]);
  } catch {
    return '';
  }
};

// Rows saved before normalisation existed, or by hand, may carry a trailing
// slash or a bare host. Exact variants only -- a "contains" match on the slug
// would make /in/jay collide with /in/jay-sutariya.
export const urlVariants = (url) => {
  const slug = url.split('/in/')[1];
  if (!slug) return [url];
  return [...new Set([
    `https://www.linkedin.com/in/${slug}`,
    `https://www.linkedin.com/in/${slug}/`,
    `https://linkedin.com/in/${slug}`,
    `https://www.linkedin.com/in/${slug.toLowerCase()}`,
    `https://www.linkedin.com/in/${slug.toLowerCase()}/`,
  ])];
};

export const experienceUrl = (url) => url + '/details/experience/';

// ---------------------------------------------------------------- scraping
// These run inside the LinkedIn tab via chrome.scripting.executeScript, so each
// must be self contained -- no imports, no closure over module scope.
//
// LinkedIn's rebuilt profile page offers scrapers almost nothing: no <h1>, no
// JSON-LD, no og: tags, and every CSS class is a hash like ".c77fab07" that
// rotates each deploy. Nothing below keys off a class. What holds up, verified
// live against several profiles:
//
//   * card container ids ending in Topcard / ExperienceTopLevelSection /
//     ExperienceDetailsSection
//   * componentkey="entity-collection-item--*" wrapping each experience entry
//   * the "Contact info" link, which shares a row with the location
//
// Traps found the hard way:
//
//   1. Duplicate hidden lines. LinkedIn renders extra copies of the degree and
//      company badges for other breakpoints, and the hidden degree is often
//      stale ("1st" beside the real "2nd"). Text is filtered by whether it
//      occupies space.
//   2. The Experience card on the profile page only renders after a genuine
//      user scroll. A programmatic scrollIntoView plus a ten second wait does
//      nothing. The standalone /details/experience/ page has the same data
//      immediately, which is how the background tab reads it.
//   3. Several roles at one employer are grouped: the entry leads with the
//      company and a total duration ("Google", "22 yrs 5 mos") and only then
//      lists roles. Parsing every entry the same way yields a duration as the
//      job title.

export async function scrapeProfilePage() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  const isVisible = (node) => {
    const rect = node?.getBoundingClientRect?.();
    return !!rect && rect.width > 0 && rect.height > 0;
  };

  const linesIn = (root, limit, visibleOnly) => {
    if (!root) return [];
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const out = [];
    let node;
    while ((node = walk.nextNode()) && out.length < limit) {
      const text = clean(node.textContent);
      if (text && (!visibleOnly || isVisible(node.parentElement))) out.push(text);
    }
    return out;
  };

  const DEGREE = /^[·•\s]*(1st|2nd|3rd\+?)[·•\s]*$/i;
  const FOLLOWERS = /^[\d,.]+[kmb]?\s+(followers|connections)$/i;
  const noise = (l) => !l || /^[·•|]$/.test(l) || /^contact info$/i.test(l);

  const topcard =
    document.querySelector('[id$="Topcard"]') ||
    document.querySelector('[data-testid="lazy-column"]');
  if (!topcard) return null;

  const shown = linesIn(topcard, 30, true);
  const all = linesIn(topcard, 30, false);
  if (!shown.length) return null;

  let name = clean(topcard.querySelector('h1, h2')?.textContent) || shown[0] || '';

  let connection = '';
  let degreeIdx = -1;
  for (let i = 0; i < Math.min(shown.length, 6); i++) {
    const match = shown[i].match(DEGREE);
    if (match) {
      connection = match[1];
      degreeIdx = i;
      break;
    }
  }

  const headline = shown[(degreeIdx >= 0 ? degreeIdx : 0) + 1] || '';

  // Location shares a row with the "Contact info" link. Climb from that link
  // until an ancestor holds text other than the link itself.
  let location = '';
  const contactLink = [...document.querySelectorAll('a')].find(
    (a) => /^contact info$/i.test(clean(a.textContent))
  );
  let row = contactLink?.parentElement;
  for (let i = 0; i < 3 && row && !location; i++) {
    const candidate = linesIn(row, 6, true).filter((l) => !noise(l))[0];
    if (candidate && candidate !== name && candidate !== headline) location = candidate;
    row = row.parentElement;
  }
  if (!location) {
    const stop = shown.findIndex((l) => FOLLOWERS.test(l));
    for (let i = (stop > 0 ? stop : shown.length) - 1; i > 0; i--) {
      const line = shown[i];
      if (noise(line) || DEGREE.test(line) || /^https?:/i.test(line)) continue;
      if (line === name || line === headline) continue;
      location = line;
      break;
    }
  }

  // A badge sits just after the headline, but it is whatever LinkedIn has to
  // hand: on a profile with no current job it is the university. Offer it only
  // when the headline names it too, and let the caller prefer Experience.
  let companyBadge = '';
  const headlineIdx = all.indexOf(headline);
  for (let i = headlineIdx + 1; i >= 1 && i < all.length; i++) {
    const badge = all[i];
    if (noise(badge) || DEGREE.test(badge)) continue;
    const plausible =
      badge !== location &&
      !FOLLOWERS.test(badge) &&
      !/^https?:/i.test(badge) &&
      headline.toLowerCase().includes(badge.toLowerCase());
    if (plausible) companyBadge = badge;
    break;
  }

  if (!name) name = clean(document.title).replace(/\s*\|\s*LinkedIn\s*$/i, '');

  const photo =
    [...topcard.querySelectorAll('img')]
      .map((img) => img.currentSrc || img.src)
      .find((src) => /profile-displayphoto|profile-framedphoto/.test(src || '')) || '';

  const here = new URL(window.location.href);
  const url = (here.origin + here.pathname).replace(/\/$/, '');

  return { name, url, headline, connection, location, companyBadge, photo };
}

// Reads the current role from whichever experience card this page has: the
// inline one on a profile (present only if the reader scrolled to it) or the
// standalone /details/experience/ section. Returns null when neither has
// rendered, so the caller can decide whether to go fetch the details page.
export async function scrapeExperience(budgetMs = 1200) {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const isVisible = (node) => {
    const rect = node?.getBoundingClientRect?.();
    return !!rect && rect.width > 0 && rect.height > 0;
  };

  const linesIn = (root, limit) => {
    if (!root) return [];
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const out = [];
    let node;
    while ((node = walk.nextNode()) && out.length < limit) {
      const text = clean(node.textContent);
      if (text && isVisible(node.parentElement)) out.push(text);
    }
    return out;
  };

  const findCard = () =>
    document.querySelector('[id$="ExperienceDetailsSection"]') ||
    document.querySelector('[id$="ExperienceTopLevelSection"]') ||
    document.querySelector('[id^="profileCardsExperienceOnly"]');

  // The visibility walk is costly, so skip it while the card is a skeleton. The
  // budget is wall clock, not a retry count: LinkedIn keeps the main thread busy
  // enough that a 200ms timer routinely takes four times that.
  let card = null;
  const deadline = performance.now() + budgetMs;
  do {
    card = findCard();
    if (card && clean(card.textContent).length > 20) break;
    card = null;
    await sleep(200);
  } while (performance.now() < deadline);

  if (!card) return null;

  const DATES = /(19|20)\d{2}\s*[–—-]\s*([A-Za-z]{3,9}\s+)?(present|(19|20)\d{2})/i;
  const DURATION = /^\d+\s*(yrs?|mos?)(\s+\d+\s*mos?)?$/i;

  // Each experience entry is its own componentkey container on both the profile
  // card and the details page.
  let entries = [...card.querySelectorAll('[componentkey^="entity-collection-item"]')]
    .map((el) => linesIn(el, 30))
    .filter((lines) => lines.length > 1);

  // Fallback for a layout without those containers: treat the whole card as one
  // entry, minus the "Experience" heading.
  if (!entries.length) {
    const flat = linesIn(card, 60);
    if (flat.length < 3) return null;
    entries = [flat.slice(1)];
  }

  const roles = [];
  for (const lines of entries) {
    // Grouped entry: company, total duration, then role/date pairs.
    if (DURATION.test(lines[1] || '')) {
      const company = lines[0].split('·')[0].trim();
      for (let i = 2; i < lines.length; i++) {
        if (!DATES.test(lines[i])) continue;
        const title = lines[i - 1];
        if (!title || DATES.test(title) || DURATION.test(title)) continue;
        roles.push({ title, company, dates: lines[i] });
      }
      continue;
    }
    // Plain entry: title, company, dates.
    for (let i = 2; i < lines.length; i++) {
      if (!DATES.test(lines[i])) continue;
      const title = lines[i - 2];
      const company = lines[i - 1];
      if (!title || !company) continue;
      if (DATES.test(company) || DURATION.test(company) || DURATION.test(title)) continue;
      roles.push({ title, company: company.split('·')[0].trim(), dates: lines[i] });
      break;
    }
  }

  if (!roles.length) return null;
  const current = roles.find((r) => /present/i.test(r.dates)) || roles[0];
  return { title: current.title, company: current.company };
}

// ---------------------------------------------------------------- notion

export const notion = async (token, path, init = {}) => {
  const res = await fetch('https://api.notion.com/v1' + path, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + token,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw new Error('Notion rejected that secret. Check it in Settings.');
    if (res.status === 404) throw new Error('Database not found. Share it with your integration.');
    throw new Error(body.message || 'Notion error ' + res.status);
  }
  return body;
};

export const matchProperties = (schema) => {
  const entries = Object.entries(schema);
  const used = new Set();
  const map = {};

  const titleProp = entries.find(([, prop]) => prop.type === 'title');
  if (titleProp) {
    map.name = titleProp[0];
    used.add(titleProp[0]);
  }

  for (const field of FIELDS) {
    if (map[field.key]) continue;
    for (const alias of field.aliases) {
      const hit = entries.find(([n]) => !used.has(n) && n.trim().toLowerCase() === alias);
      if (hit) {
        map[field.key] = hit[0];
        used.add(hit[0]);
        break;
      }
    }
  }
  return map;
};

export const buildValue = (type, value) => {
  const text = String(value).slice(0, 2000);
  switch (type) {
    case 'title': return { title: [{ text: { content: text } }] };
    case 'rich_text': return { rich_text: [{ text: { content: text } }] };
    case 'url': return { url: text };
    case 'select': return { select: { name: text.slice(0, 100) } };
    case 'multi_select': return { multi_select: [{ name: text.slice(0, 100) }] };
    case 'status': return { status: { name: text.slice(0, 100) } };
    case 'email': return { email: text };
    case 'phone_number': return { phone_number: text };
    default: return null;
  }
};

export const buildProperties = (schema, map, values) => {
  const props = {};
  for (const field of FIELDS) {
    const propName = map[field.key];
    const value = (values[field.key] || '').trim();
    if (!propName || !value) continue;
    const built = buildValue(schema[propName].type, value);
    if (built) props[propName] = built;
  }
  return props;
};

export const loadDatabase = async (token, dbId) => {
  const db = await notion(token, '/databases/' + dbId);
  return { schema: db.properties, map: matchProperties(db.properties) };
};

// Deduplication key. Returns the existing page, or null. Returns null too when
// the database has no URL property to match on -- canDedupe() reports that so
// callers can warn instead of silently allowing duplicates.
export const canDedupe = (schema, map) =>
  Boolean(map.url && schema[map.url]?.type === 'url');

export const findExisting = async (token, dbId, schema, map, url) => {
  if (!canDedupe(schema, map) || !url) return null;
  const body = await notion(token, `/databases/${dbId}/query`, {
    method: 'POST',
    body: JSON.stringify({
      filter: {
        or: urlVariants(url).map((variant) => ({
          property: map.url,
          url: { equals: variant },
        })),
      },
      page_size: 1,
    }),
  });
  return body.results?.[0] || null;
};

export const createPage = (token, dbId, properties) =>
  notion(token, '/pages', {
    method: 'POST',
    body: JSON.stringify({ parent: { database_id: dbId }, properties }),
  });

export const parseDbId = (raw) => {
  const match = String(raw || '').replace(/-/g, '').match(/[0-9a-f]{32}/i);
  return match ? match[0] : '';
};

export const getSettings = () => chrome.storage.local.get(['token', 'dbId']);

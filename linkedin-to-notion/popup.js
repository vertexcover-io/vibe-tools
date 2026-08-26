// AI-generated. See PROMPT.md for the prompts and model used.

import {
  FIELDS,
  buildProperties,
  canDedupe,
  createPage,
  findExisting,
  getSettings,
  loadDatabase,
  normalizeProfileUrl,
  parseDbId,
  scrapeExperience,
  scrapeProfilePage,
} from './linkedin-to-notion.js';

const $ = (id) => document.getElementById(id);

const setMsg = (node, text, kind, href) => {
  node.textContent = '';
  node.className = 'msg ' + kind;
  node.hidden = false;
  node.append(text);
  if (href) {
    const link = document.createElement('a');
    link.href = href;
    link.target = '_blank';
    link.textContent = ' Open →';
    node.append(link);
  }
};
const clearMsg = (node) => { node.hidden = true; };

const initials = (name) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

const readForm = () => Object.fromEntries(FIELDS.map((f) => [f.key, $('f-' + f.key).value]));

const renderPerson = (data) => {
  $('person').classList.remove('loading');
  $('p-name').textContent = data.name || 'Unknown profile';
  $('p-sub').textContent = data.headline || data.title || data.url || '';

  const degree = $('p-degree');
  degree.hidden = !data.connection;
  degree.textContent = data.connection;

  const avatar = $('avatar');
  avatar.textContent = initials(data.name || '?');
  if (!data.photo) return;

  const img = document.createElement('img');
  img.className = 'avatar';
  img.alt = '';
  img.onload = () => avatar.replaceWith(img);
  img.src = data.photo;
};

const renderMapping = (schema, map) => {
  const box = $('mapping');
  box.textContent = '';
  box.hidden = false;
  for (const field of FIELDS) {
    const propName = map[field.key];
    const row = document.createElement('div');
    row.className = 'map-row' + (propName ? '' : ' miss');
    const left = document.createElement('b');
    left.textContent = field.label;
    const right = document.createElement('span');
    right.textContent = propName ? `${propName} · ${schema[propName].type}` : 'not in database';
    row.append(left, right);
    box.append(row);
  }
};

const showSettings = (on) => {
  $('view-settings').hidden = !on;
  $('view-clip').hidden = on;
  $('gear').setAttribute('aria-pressed', String(on));
};

let db = { dbId: '', schema: null, map: null };

const ensureDatabase = async (token, dbId) => {
  if (db.dbId === dbId && db.schema) return db;
  const { schema, map } = await loadDatabase(token, dbId);
  db = { dbId, schema, map };
  return db;
};

const lockAsDuplicate = (page) => {
  setMsg($('notice'), 'Already in Notion — not saving a duplicate.', 'warn', page.url);
  const save = $('save');
  save.disabled = true;
  save.textContent = 'Already in Notion';
};

const scrapeActiveTab = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/[^/]*\.?linkedin\.com\/in\//.test(tab.url || '')) return null;

  const run = async (func, args = []) => {
    const [injected] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args });
    return injected?.result || null;
  };

  const profile = await run(scrapeProfilePage);
  if (!profile) return null;

  // Present only if the reader already scrolled down to it; the "Fetch title &
  // company" button covers the case where they have not.
  const experience = await run(scrapeExperience, [1200]);
  return {
    ...profile,
    title: experience?.title || '',
    company: experience?.company || profile.companyBadge || '',
  };
};

const init = async () => {
  const { token, dbId } = await getSettings();
  const configured = Boolean(token && dbId);

  if (configured) {
    $('s-token').value = token;
    $('s-db').value = dbId;
  } else {
    showSettings(true);
    setMsg($('settings-status'), 'Connect a Notion database to start clipping profiles.', 'warn');
  }

  let scraped = null;
  try {
    scraped = await scrapeActiveTab();
  } catch (err) {
    setMsg($('notice'), 'Could not read this page: ' + err.message, 'warn');
  }

  if (scraped) {
    for (const field of FIELDS) $('f-' + field.key).value = scraped[field.key] || '';
    renderPerson(scraped);
    if (!scraped.title) $('fetch-exp').hidden = false;
  } else {
    $('person').classList.remove('loading');
    $('p-name').textContent = 'No profile detected';
    $('p-sub').textContent = 'Fill the fields in by hand';
    $('avatar').textContent = '?';
    if ($('notice').hidden) {
      setMsg($('notice'), 'Open a linkedin.com/in/... page to autofill this form.', 'warn');
    }
  }

  if (!configured) return;

  try {
    const { schema, map } = await ensureDatabase(token, dbId);
    renderMapping(schema, map);
    const url = normalizeProfileUrl($('f-url').value);
    const existing = await findExisting(token, dbId, schema, map, url);
    if (existing) lockAsDuplicate(existing);
  } catch (err) {
    setMsg($('notice'), err.message, 'err');
  }
};

$('fetch-exp').addEventListener('click', async () => {
  const button = $('fetch-exp');
  const url = normalizeProfileUrl($('f-url').value);
  if (!url) return;

  button.disabled = true;
  button.textContent = 'Opening experience page…';
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'fetch-experience', url });
    if (reply?.experience) {
      $('f-title').value = reply.experience.title || $('f-title').value;
      $('f-company').value = reply.experience.company || $('f-company').value;
      button.hidden = true;
      clearMsg($('notice'));
    } else {
      setMsg($('notice'), reply?.error || 'Could not read the experience page.', 'warn');
      button.disabled = false;
      button.textContent = 'Fetch title & company';
    }
  } catch (err) {
    setMsg($('notice'), err.message, 'err');
    button.disabled = false;
    button.textContent = 'Fetch title & company';
  }
});

$('save').addEventListener('click', async () => {
  clearMsg($('status'));
  const { token, dbId } = await getSettings();
  if (!token || !dbId) {
    showSettings(true);
    setMsg($('settings-status'), 'Connect a Notion database first.', 'warn');
    return;
  }

  const button = $('save');
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    const { schema, map } = await ensureDatabase(token, dbId);
    const values = readForm();
    values.url = normalizeProfileUrl(values.url) || values.url;

    // Re-check immediately before writing: the popup may have been open a while,
    // or the same profile may have been clipped from a list in the meantime.
    const existing = await findExisting(token, dbId, schema, map, values.url);
    if (existing) {
      lockAsDuplicate(existing);
      return;
    }

    const properties = buildProperties(schema, map, values);
    if (!Object.keys(properties).length) throw new Error('Nothing matched — check Settings.');

    const page = await createPage(token, dbId, properties);
    setMsg($('status'), 'Saved to Notion.', 'ok', page.url);
    button.textContent = 'Saved';
  } catch (err) {
    setMsg($('status'), err.message, 'err');
    button.disabled = false;
    button.textContent = 'Save to Notion';
  }
});

$('gear').addEventListener('click', () => showSettings($('view-settings').hidden));

$('save-settings').addEventListener('click', async () => {
  const token = $('s-token').value.trim();
  const dbId = parseDbId($('s-db').value);
  if (!token) return setMsg($('settings-status'), 'Paste your Notion integration secret.', 'err');
  if (!dbId) return setMsg($('settings-status'), 'That does not contain a Notion database ID.', 'err');

  const button = $('save-settings');
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    db = { dbId: '', schema: null, map: null };
    const { schema, map } = await ensureDatabase(token, dbId);
    await chrome.storage.local.set({ token, dbId });
    renderMapping(schema, map);

    const missing = FIELDS.filter((f) => !map[f.key]).map((f) => f.label);
    if (!canDedupe(schema, map)) {
      setMsg(
        $('settings-status'),
        'Connected, but there is no URL property to match on, so duplicates cannot be blocked. Add a URL property named "LinkedIn URL".',
        'warn'
      );
    } else {
      setMsg(
        $('settings-status'),
        missing.length ? `Connected. Skipping: ${missing.join(', ')}.` : 'Connected. Every field matched.',
        missing.length ? 'warn' : 'ok'
      );
    }
    clearMsg($('notice'));
  } catch (err) {
    setMsg($('settings-status'), err.message, 'err');
  } finally {
    button.disabled = false;
    button.textContent = 'Connect database';
  }
});

init();

// AI-generated. See PROMPT.md for the prompts and model used.
//
// Right-click flow: from any LinkedIn list (search results, connections, a
// company's people tab) right-click someone's name and the profile is clipped
// without leaving the page. A hidden tab opens, two pages are read, the tab
// closes.

import {
  buildProperties,
  canDedupe,
  createPage,
  experienceUrl,
  findExisting,
  getSettings,
  loadDatabase,
  normalizeProfileUrl,
  scrapeExperience,
  scrapeProfilePage,
} from './linkedin-to-notion.js';

const MENU_ID = 'rolodex-clip-profile';

const createMenu = () => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Save profile to Notion (Rolodex)',
      contexts: ['link'],
      targetUrlPatterns: ['*://*.linkedin.com/in/*'],
    });
  });
};

chrome.runtime.onInstalled.addListener(createMenu);
chrome.runtime.onStartup.addListener(createMenu);

// ---------------------------------------------------------------- feedback

const notify = (title, message) =>
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon-128.png',
    title,
    message,
  });

const badge = (text, color) => {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
};

const clearBadgeSoon = () => setTimeout(() => badge(''), 4000);

// ---------------------------------------------------------------- tab helper

const waitForTabLoad = (tabId, timeout = 20000) =>
  new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') done();
    };
    const timer = setTimeout(done, timeout);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab?.status === 'complete') done();
    }).catch(done);
  });

// The page is client rendered, so a "complete" tab is not a populated one.
// Inject repeatedly until the scraper returns something or the budget runs out.
const scrapeUntilReady = async (tabId, func, { timeout = 15000, args = [] } = {}) => {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const [injected] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
      last = injected?.result ?? null;
      if (last) return last;
    } catch {
      // tab still navigating; try again shortly
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
};

// ---------------------------------------------------------------- clip

export const clipProfile = async (rawUrl) => {
  const url = normalizeProfileUrl(rawUrl);
  if (!url) throw new Error('That link is not a LinkedIn profile.');

  const { token, dbId } = await getSettings();
  if (!token || !dbId) {
    throw new Error('Open Rolodex and connect a Notion database first.');
  }

  const { schema, map } = await loadDatabase(token, dbId);

  // Check before opening anything: a duplicate costs zero page loads.
  const existing = await findExisting(token, dbId, schema, map, url);
  if (existing) return { status: 'duplicate', url, page: existing };

  const tab = await chrome.tabs.create({ url, active: false });
  let profile = null;
  let experience = null;

  try {
    await waitForTabLoad(tab.id);
    profile = await scrapeUntilReady(tab.id, scrapeProfilePage);

    // The profile page only renders Experience after a real human scroll, which
    // a background tab will never get. The standalone details page renders it
    // immediately, so go there instead.
    await chrome.tabs.update(tab.id, { url: experienceUrl(url) });
    await waitForTabLoad(tab.id);
    experience = await scrapeUntilReady(tab.id, scrapeExperience, {
      timeout: 12000,
      args: [8000],
    });
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }

  if (!profile) throw new Error('Could not read that profile.');

  const values = {
    ...profile,
    url,
    title: experience?.title || '',
    company: experience?.company || profile.companyBadge || '',
  };

  const properties = buildProperties(schema, map, values);
  if (!Object.keys(properties).length) {
    throw new Error('No Notion properties matched. Check Rolodex settings.');
  }

  const page = await createPage(token, dbId, properties);
  return { status: 'saved', url, page, values, dedupe: canDedupe(schema, map) };
};

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== MENU_ID) return;
  badge('…', '#0a66c2');
  try {
    const result = await clipProfile(info.linkUrl);
    if (result.status === 'duplicate') {
      badge('=', '#8a5d00');
      notify('Already in Notion', 'That profile is already saved. Nothing added.');
    } else {
      badge('✓', '#10693e');
      const who = result.values.name || 'Profile';
      const role = [result.values.title, result.values.company].filter(Boolean).join(' · ');
      notify('Saved to Notion', role ? `${who} — ${role}` : who);
    }
  } catch (err) {
    badge('!', '#b3261e');
    notify('Rolodex could not save that', err.message);
  }
  clearBadgeSoon();
});

// Lets the popup borrow the same background-tab trick to fill in current title
// and company when the reader has not scrolled down to Experience.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'fetch-experience') return undefined;
  (async () => {
    const url = normalizeProfileUrl(message.url);
    if (!url) return sendResponse({ error: 'Not a profile URL.' });
    const tab = await chrome.tabs.create({ url: experienceUrl(url), active: false });
    try {
      await waitForTabLoad(tab.id);
      const experience = await scrapeUntilReady(tab.id, scrapeExperience, {
        timeout: 12000,
        args: [8000],
      });
      sendResponse(experience ? { experience } : { error: 'No experience found on that profile.' });
    } catch (err) {
      sendResponse({ error: err.message });
    } finally {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
  })();
  return true; // keep the message channel open for the async reply
});

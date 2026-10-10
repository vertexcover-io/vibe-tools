/* AI-generated. See PROMPT.md for the prompts and model used. */
// Owns the recording state and relays everything to the local recorder process. State lives in
// session storage so the page overlay can follow it and so a restarted worker loses nothing.
const SERVER = 'http://127.0.0.1:9335';
const SHOWN_STEPS = 200;

const post = (path, body) =>
  fetch(SERVER + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});

// Session storage is closed to content scripts until the worker opens it; the page panel reads it.
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });

const EMPTY = { recording: false, startedAt: 0, steps: [], transcript: [], interim: '', mic: '', lang: 'en-US', hidden: false };
const state = () => chrome.storage.session.get(EMPTY);

// Is the recorder process up? Answered fast either way: a closed port refuses at once.
const server = () => fetch(SERVER + '/status', { signal: AbortSignal.timeout(800) }).then(r => r.json()).catch(() => null);

// Writes are queued so two quick clicks cannot read the same steps array and drop one.
let queue = Promise.resolve();
const update = (change) => (queue = queue.then(async () => {
  const st = await state();
  await chrome.storage.session.set(change(st));
}));

const stepLine = (ev) => {
  const what = ev.label || ev.text || ev.tag || '';
  if (ev.type === 'navigate') return { t: ev.t, text: 'open ' + ev.url.replace(/^https?:\/\//, '').slice(0, 70) };
  if (ev.type === 'click') return { t: ev.t, text: 'click ' + what };
  if (ev.type === 'press') return { t: ev.t, text: 'press ' + ev.key + ' in ' + what };
  return { t: ev.t, text: ev.type + ' "' + (ev.value || '') + '" in ' + what };
};

const recordEvent = async (ev) => {
  if (!(await state()).recording) return;
  post('/event', ev);
  update(st => ({ steps: [...st.steps, stepLine(ev)].slice(-SHOWN_STEPS) }));
};

const openMic = async () => {
  try { await chrome.offscreen.closeDocument(); } catch (err) { /* none open */ }
  try {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'Record the narration while a walkthrough is recorded' });
  } catch (err) {
    await chrome.storage.session.set({ mic: 'failed: ' + err.message });
  }
};

const start = async ({ url, lang }) => {
  await chrome.storage.session.set({ ...EMPTY, recording: true, startedAt: Date.now(), lang, mic: 'starting' });
  await openMic();
  if (url) chrome.tabs.create({ url });
};

// The hidden mic page cannot ask for permission; a visible extension page can, once. Opened
// only when the mic was refused, so every run after the first stays on the site.
const micRefused = (status) => /NotAllowed|denied|Permission/i.test(status);

const stop = async () => {
  await chrome.storage.session.set({ recording: false });
  try { await chrome.runtime.sendMessage({ kind: 'mic-stop' }); } catch (err) { /* no offscreen page */ }
  await post('/stop', {});
  try { await chrome.offscreen.closeDocument(); } catch (err) { /* already gone */ }
  await chrome.storage.session.set({ ...EMPTY });
};

// The toolbar icon brings a minimised panel back. With no recorder running there is nothing to
// show on the page, so the start page explains instead.
chrome.action.onClicked.addListener(async () => {
  const st = await state();
  if (st.recording || await server()) return chrome.storage.session.set({ hidden: false });
  chrome.tabs.create({ url: chrome.runtime.getURL('start.html') });
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.kind === 'event') recordEvent(msg.payload);
  if (msg.kind === 'server') { server().then(st => reply(st)); return true; }
  if (msg.kind === 'lang') { state().then(st => reply({ lang: st.lang })); return true; }
  if (msg.kind === 'start') start(msg).then(() => reply({ ok: true }));
  if (msg.kind === 'mic-restart') openMic().then(() => reply({ ok: true }));
  if (msg.kind === 'stop') stop().then(() => reply({ ok: true }));
  if (msg.kind === 'speech') { post('/speech', msg.payload); update(st => ({ transcript: [...st.transcript, msg.payload.text], interim: '' })); }
  if (msg.kind === 'interim') chrome.storage.session.set({ interim: msg.text });
  if (msg.kind === 'mic') {
    chrome.storage.session.set({ mic: msg.status });
    if (micRefused(msg.status)) chrome.tabs.create({ url: chrome.runtime.getURL('start.html') });
  }
  return ['start', 'stop', 'mic-restart'].includes(msg.kind);
});

// Full loads plus the in-page URL changes single-page consoles make instead of loading.
const navigated = (d) => {
  if (d.frameId !== 0 || !/^https?:/.test(d.url)) return;
  recordEvent({ t: Date.now(), type: 'navigate', url: d.url });
};
chrome.webNavigation.onCommitted.addListener(navigated);
chrome.webNavigation.onHistoryStateUpdated.addListener(navigated);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(navigated);

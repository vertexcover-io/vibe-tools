/* AI-generated. See PROMPT.md for the prompts and model used. */
// Runs in every frame, in the extension's isolated world, so nothing here is visible to the
// page's own scripts. Capture-phase listeners so the page cannot swallow an event first.
(() => {
  // The panel in the corner of the page: what has been heard and done so far, and Stop. Drawn
  // inside a shadow root so the page's styles and ours never meet; hidden when nothing records.
  const overlay = { host: null, els: null, timer: null };
  const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  const PANEL = `
    <style>
      :host { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; font: 12px/1.4 system-ui, sans-serif; color: #e8e8e8; }
      .panel { width: 340px; background: #1c1c1e; border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.45); overflow: hidden; }
      .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #2a2a2d; cursor: pointer; }
      .dot { width: 10px; height: 10px; border-radius: 50%; background: #ff3b30; animation: blink 1.2s infinite; }
      @keyframes blink { 50% { opacity: .3; } }
      .title { font-weight: 600; flex: 1; }
      .mic { color: #9a9a9a; }
      .body { padding: 10px 12px; display: grid; gap: 8px; }
      .body[hidden] { display: none; }
      h4 { margin: 0 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #9a9a9a; }
      ol { margin: 0; padding-left: 18px; max-height: 120px; overflow-y: auto; }
      li { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .said { max-height: 110px; overflow-y: auto; white-space: pre-wrap; }
      .interim { color: #8a8a8a; font-style: italic; }
      button { font: inherit; font-weight: 600; padding: 8px 12px; border: 0; border-radius: 6px; background: #ff3b30; color: #fff; cursor: pointer; }
      button.start { background: #34c759; color: #062; }
      button:disabled { background: #666; cursor: default; }
      .ready .dot { background: #34c759; animation: none; }
      .ready .body { display: none; }
      .ready .title { flex: none; }
      .head button { margin-left: auto; padding: 5px 10px; }
      .min { background: none; color: #bbb; padding: 0 4px; font-size: 16px; line-height: 1; margin-left: 0; }
      .min:hover { color: #fff; }
    </style>
    <div class="panel">
      <div class="head"><span class="dot"></span><span class="title">Recording <span class="time">00:00</span></span><span class="mic"></span><button class="start" hidden>Start recording</button><span class="toggle">▾</span><button class="min" title="Minimise; the toolbar icon brings it back">–</button></div>
      <div class="body">
        <div><h4>Steps <span class="count"></span></h4><ol class="steps"></ol></div>
        <div><h4>Heard</h4><div class="said"></div><div class="interim"></div></div>
        <button class="stop">Stop and save</button>
      </div>
    </div>`;
  const showOverlay = () => {
    if (overlay.host) return;
    const host = document.createElement('flow-recorder');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = PANEL;
    const q = (sel) => root.querySelector(sel);
    overlay.host = host;
    overlay.els = { panel: q('.panel'), title: q('.title'), time: q('.time'), mic: q('.mic'), count: q('.count'), steps: q('.steps'), said: q('.said'), interim: q('.interim'), stop: q('.stop'), start: q('.start'), toggle: q('.toggle'), body: q('.body') };
    q('.min').onclick = (e) => { e.stopPropagation(); chrome.storage.session.set({ hidden: true }); };
    q('.head').onclick = (e) => { if (e.target === overlay.els.start) return; overlay.els.body.hidden = !overlay.els.body.hidden; overlay.els.toggle.textContent = overlay.els.body.hidden ? '▸' : '▾'; };
    overlay.els.start.onclick = () => { overlay.els.start.disabled = true; chrome.runtime.sendMessage({ kind: 'start', url: '', lang: overlay.lang }); };
    overlay.els.stop.onclick = () => { overlay.els.stop.disabled = true; overlay.els.stop.textContent = 'Saving...'; chrome.runtime.sendMessage({ kind: 'stop' }); };
    document.documentElement.appendChild(host);
  };
  const hideOverlay = () => { if (!overlay.host) return; overlay.host.remove(); overlay.host = null; clearInterval(overlay.timer); };
  // Nothing recording: show a Start button if the recorder process is up, else nothing at all.
  const renderReady = async () => {
    const server = await chrome.runtime.sendMessage({ kind: 'server' }).catch(() => null);
    if (!server) return hideOverlay();
    showOverlay();
    overlay.lang = server.lang || 'en-US';
    const { els } = overlay;
    els.panel.classList.add('ready');
    els.title.textContent = 'Flow recorder ready';
    els.start.hidden = false; els.start.disabled = false; els.toggle.hidden = true;
  };
  const render = (st) => {
    if (st.hidden) return hideOverlay();
    if (!st.recording) return renderReady();
    showOverlay();
    const { els } = overlay;
    els.panel.classList.remove('ready');
    els.start.hidden = true; els.toggle.hidden = false;
    if (!els.title.contains(els.time)) { els.title.textContent = 'Recording '; els.title.appendChild(els.time); }
    els.mic.textContent = st.mic === 'on' ? '🎙' : (st.mic || '');
    els.count.textContent = st.steps.length ? '(' + st.steps.length + ')' : '';
    els.steps.innerHTML = st.steps.slice(-8).map(s => '<li>' + clock(s.t - st.startedAt) + ' ' + s.text.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</li>').join('');
    els.steps.scrollTop = els.steps.scrollHeight;
    els.said.textContent = st.transcript.slice(-6).join('\n');
    els.said.scrollTop = els.said.scrollHeight;
    els.interim.textContent = st.interim || '';
    clearInterval(overlay.timer);
    overlay.timer = setInterval(() => { if (overlay.els) overlay.els.time.textContent = clock(Date.now() - st.startedAt); }, 1000);
  };
  const STATE = { recording: false, startedAt: 0, steps: [], transcript: [], interim: '', mic: '', hidden: false };
  // The worker opens session storage to pages when it starts, and it starts lazily -- so the
  // first read can lose the race. Poking it with a message starts it; then read again.
  const loadState = async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      try { return await chrome.storage.session.get(STATE); } catch (err) {
        await chrome.runtime.sendMessage({ kind: 'ping' }).catch(() => {});
        await new Promise(r => setTimeout(r, 250));
      }
    }
    return null;
  };
  if (window === window.top) {
    loadState().then(st => st && render(st));
    chrome.storage.onChanged.addListener((changes, area) => { if (area === 'session') loadState().then(st => st && render(st)); });
  }

  const attr = (el, n) => (el.getAttribute && el.getAttribute(n)) || '';
  const xpathOf = (el) => {
    if (el.id) return `//*[@id="${el.id}"]`;
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentNode) {
      const same = Array.from(n.parentNode ? n.parentNode.children : []).filter(c => c.localName === n.localName);
      parts.unshift(same.length > 1 ? `${n.localName}[${same.indexOf(n) + 1}]` : n.localName);
      const parent = n.parentNode;
      if (parent && parent.nodeType === 1 && parent.id) return `//*[@id="${parent.id}"]/` + parts.join('/');
    }
    return '/html/' + parts.join('/');
  };
  const inputRoles = { checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button' };
  const tagRoles = { a: 'link', button: 'button', select: 'combobox', textarea: 'textbox' };
  const roleOf = (el) => attr(el, 'role') || (el.localName === 'input' ? (inputRoles[el.type] || 'textbox') : tagRoles[el.localName] || '');
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const isField = (el) => ['input', 'select', 'textarea'].includes(el.localName);
  // aria-labelledby points at other nodes (Gmail's row checkboxes name the row's sender this way).
  const labelledBy = (el) => attr(el, 'aria-labelledby').split(/\s+/).map(id => document.getElementById(id)).filter(Boolean).map(n => n.innerText).join(' ');
  const labelOf = (el) => clean(attr(el, 'aria-label') || labelledBy(el) || (el.labels && el.labels[0] && el.labels[0].innerText) || (isField(el) ? attr(el, 'placeholder') || attr(el, 'name') : el.innerText));
  // Playwright's own generator, vendored in pw_injected.js; what a script will actually type.
  const playwrightLocator = (el) => {
    try {
      const pw = window.__flowPlaywright;
      const selector = pw.generateSelector(el, { testIdAttributeName: 'data-testid' }).selector;
      return { pw_selector: selector, pw_locator: pw.utils.asLocator('python', selector) };
    } catch (err) { return { pw_selector: '', pw_locator: '' }; }
  };
  const describe = (el) => ({
    tag: el.localName, xpath: xpathOf(el), ...playwrightLocator(el),
    testid: attr(el, 'data-testid') || attr(el, 'data-qa') || attr(el, 'data-test') || attr(el, 'data-cy'), jsname: attr(el, 'jsname'),
    id: el.id || '', name: attr(el, 'name'), role: roleOf(el), label: labelOf(el),
    placeholder: attr(el, 'placeholder'), text: isField(el) ? '' : clean(el.innerText),
    html: el.outerHTML.slice(0, 1200),  // 300 was too short to identify a control from its markup
  });
  const target = (e) => {
    const path = e.composedPath ? e.composedPath() : [e.target];
    if (overlay.host && path.includes(overlay.host)) return null;
    const p = path[0];
    return p && p.nodeType === 1 ? p : e.target;
  };
  // Climb to the control that was clicked -- but only to things a person can actually operate.
  // `[role]` used to be in this list, and role="dialog" matched it: every click on a wrapper
  // inside a modal was recorded as a click on the modal, losing the element entirely. That is why
  // five recordings of the 1Password invite dialog show "clicked the dialog" and never the
  // invitation-type control that was clicked.
  const INTERACTIVE = [
    'button', 'a', 'input', 'select', 'textarea', 'label', 'summary', 'option',
    '[contenteditable="true"]', '[onclick]',
    '[role="button"]', '[role="link"]', '[role="option"]', '[role="combobox"]', '[role="listbox"]',
    '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]', '[role="tab"]',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="textbox"]', '[role="searchbox"]',
  ].join(',');
  const clickable = (el) => el.closest(INTERACTIVE) || el;
  // A password input is not the only field worth hiding. 1Password's Secret Key box is a plain
  // text input, so the real key was captured verbatim on 2026-09-10 -- and a Secret Key plus a
  // password is the whole account. Anything whose id, name, label, placeholder or autocomplete
  // hint says secret/key/token/otp is masked the same way a password is.
  const SECRET_HINT = /secret|account-key|accountkey|api[-_ ]?key|token|passphrase|recovery|one[-_ ]?time|\botp\b|\bmfa\b|2fa/i;
  const looksSecret = (el) => {
    if (el.type === 'password') return true;
    const hints = [el.id, el.name, el.placeholder, el.getAttribute('aria-label'), el.getAttribute('autocomplete'), el.getAttribute('data-testid')];
    const labelled = el.labels && el.labels.length ? [...el.labels].map(l => l.textContent) : [];
    return SECRET_HINT.test([...hints, ...labelled].filter(Boolean).join(' '));
  };
  const valueOf = (el) => looksSecret(el) ? '***' : (el.isContentEditable ? el.innerText : el.value);
  const send = (type, el, extra) => chrome.runtime.sendMessage({ kind: 'event', payload: { t: Date.now(), type, url: location.href, ...describe(el), ...extra } });
  const picked = (el) => el.localName === 'select' || ['checkbox', 'radio', 'file'].includes(el.type) || ['combobox', 'listbox'].includes(attr(el, 'role'));
  const pending = new Map();

  // Component libraries (Radix, Headless UI, MUI menus) open on `pointerdown` and either swallow
  // the click or let it land on the overlay they just mounted. Measured 2026-09-10 on 1Password's
  // invitation-type control -- a Radix Select -- where opening the list and picking an option
  // produced one event between them: a click on <body>. So the pointer is followed too: the
  // pointerdown target is held, a click that follows repairs itself against it, and a widget that
  // never produces a click is emitted on its own.
  const WIDGET = '[role="combobox"],[role="option"],[role="listbox"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="tab"],[role="switch"],[aria-haspopup],[data-state]';
  const isWidget = (el) => !!(el.matches && el.matches(WIDGET));
  let downOn = null, downTimer = null;

  document.addEventListener('pointerdown', e => {
    const el = target(e);
    if (!el) return;
    const control = clickable(el);
    clearTimeout(downTimer);
    downOn = control;
    if (!isWidget(control)) return;
    // No click is coming for this one; record it before the widget tears itself down.
    downTimer = setTimeout(() => { if (downOn === control) { downOn = null; send('click', control, {}); } }, 400);
  }, true);

  document.addEventListener('click', e => {
    const el = target(e);
    if (!el) return;
    clearTimeout(downTimer);
    const control = clickable(el), from = downOn;
    downOn = null;
    // A click landing on the document root straight after a pointerdown on a real control is an
    // overlay stealing it -- `pointer-events: none` on <body> hit-tests out to body or html.
    const root = (el) => el.localName === 'body' || el.localName === 'html';
    send('click', root(control) && from && !root(from) ? from : control, {});
  }, true);
  document.addEventListener('input', e => {
    const el = target(e), t = Date.now();
    if (!el || picked(el)) return;
    clearTimeout(pending.get(el));
    pending.set(el, setTimeout(() => { pending.delete(el); send('fill', el, { t, value: valueOf(el) }); }, 600));
  }, true);
  document.addEventListener('change', e => {
    const el = target(e);
    if (!el || !picked(el)) return;
    send('change', el, { value: el.type === 'checkbox' || el.type === 'radio' ? String(el.checked) : valueOf(el) });
  }, true);
  document.addEventListener('keydown', e => { const el = target(e); if (el && ['Enter', 'Escape', 'Tab'].includes(e.key)) send('press', el, { key: e.key }); }, true);
})();

/* AI-generated. See PROMPT.md for the prompts and model used. */
// Runs one chunk of flow steps inside the page, fast and without any model in the loop.
// `browser-flows.py render` prepends `const STEPS = [...]` and the whole thing is pasted into
// Claude in Chrome's javascript_tool. Returns {ok, done} or {ok:false, failed, reason, url}.
await (async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const ACTIONABLE = 'button,a,input,select,textarea,label,summary,option,[role],[onclick],[contenteditable="true"]';
  const byText = (txt, exact) => {
    const want = norm(txt).toLowerCase();
    const all = [...document.querySelectorAll(ACTIONABLE)];
    const hit = (el) => { const t = norm(el.innerText || el.value || el.getAttribute('aria-label')).toLowerCase(); return exact ? t === want : t.includes(want); };
    return all.filter(hit).sort((a, b) => norm(a.innerText).length - norm(b.innerText).length)[0] || null;
  };
  const byLabel = (txt) => {
    const want = norm(txt).toLowerCase();
    const same = (v) => norm(v).toLowerCase() === want;
    for (const el of document.querySelectorAll('input,textarea,select,[contenteditable="true"],[role="textbox"],[role="combobox"]')) {
      if (same(el.getAttribute('aria-label')) || same(el.getAttribute('placeholder')) || same(el.getAttribute('name'))) return el;
      if (el.labels && [...el.labels].some(l => same(l.innerText))) return el;
    }
    const lab = [...document.querySelectorAll('label')].find(l => same(l.innerText));
    return lab ? (lab.control || document.getElementById(lab.htmlFor)) : null;
  };
  const byXpath = (xp) => document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  const resolveOne = (sel) => {
    const i = sel.indexOf(':'), kind = sel.slice(0, i), arg = sel.slice(i + 1);
    if (kind === 'css') return document.querySelector(arg);
    if (kind === 'xpath') return byXpath(arg);
    if (kind === 'text') return byText(arg, true);
    if (kind === 'text~') return byText(arg, false);
    if (kind === 'label') return byLabel(arg);
    return document.querySelector(sel);
  };
  const find = async (step) => {
    const deadline = Date.now() + (step.timeout || 8000);
    while (Date.now() < deadline) {
      for (const sel of step.selectors || []) {
        try { const el = resolveOne(sel); if (el && visible(el)) return el; } catch (e) { /* bad selector, try next */ }
      }
      await sleep(200);
    }
    return null;
  };
  const setValue = (el, value) => {
    el.focus();
    if (el.isContentEditable) { el.innerText = value; el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })); return; }
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const press = (el, key) => {
    const init = { key, code: key, bubbles: true, cancelable: true };
    const notCancelled = el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keypress', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    if (key === 'Enter' && notCancelled && el.form && !['TEXTAREA'].includes(el.tagName)) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
  };
  const act = async (step, el) => {
    el.scrollIntoView({ block: 'center' });
    if (step.type === 'click') { el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); el.click(); return; }
    if (step.type === 'fill') { setValue(el, step.value); return; }
    if (step.type === 'change') {
      if (el.type === 'checkbox' || el.type === 'radio') { if (String(el.checked) !== String(step.value)) el.click(); return; }
      if (el.tagName === 'SELECT') { const opt = [...el.options].find(o => o.value === step.value || norm(o.text) === norm(step.value)); if (opt) { setValue(el, opt.value); return; } throw new Error('no option ' + step.value); }
      setValue(el, step.value); return;
    }
    if (step.type === 'press') { press(el, step.key); return; }
    if (step.type === 'wait_for') return;
    throw new Error('unknown step type ' + step.type);
  };
  let done = 0;
  for (const step of STEPS) {
    if (step.type === 'wait') { await sleep(step.ms || 1000); done++; continue; }
    const el = await find(step);
    if (!el) {
      if (step.optional) { done++; continue; }
      return { ok: false, failed: step.id, reason: 'not found: ' + (step.selectors || []).join(' | '), url: location.href, title: document.title };
    }
    if (step.navigates) {
      // The page is about to die; hand the result back first, then click.
      setTimeout(() => act(step, el).catch(() => {}), 50);
      return { ok: true, done: done + 1, navigating: true, url: location.href, title: document.title };
    }
    try { await act(step, el); } catch (err) {
      if (step.optional) { done++; continue; }
      return { ok: false, failed: step.id, reason: String(err && err.message || err), url: location.href, title: document.title };
    }
    done++;
    await sleep(step.after || 400);
  }
  return { ok: true, done, url: location.href, title: document.title };
})();

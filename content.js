// FormPilot content script: scans form fields on the page and fills approved values.
// Injected on demand from the side panel. Never submits anything.
(() => {
  if (window.__formPilotLoaded) return;
  window.__formPilotLoaded = true;

  const FIELD_SEL = 'input, select, textarea, [contenteditable="true"], [contenteditable=""]';
  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'password']);
  const registry = new Map(); // id -> field (with _els)

  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  }

  function isCandidate(el) {
    const tag = el.tagName;
    if (tag === 'INPUT' && SKIP_TYPES.has((el.type || 'text').toLowerCase())) return false;
    if (el.disabled || el.readOnly) return false;
    if (el.closest('[data-formpilot-ignore]')) return false;
    if (isVisible(el)) return true;
    // Custom-styled selects / checkboxes often hide the native control.
    if ((tag === 'SELECT' || el.type === 'checkbox' || el.type === 'radio') && isVisible(el.parentElement)) return true;
    return false;
  }

  // If a modal/dialog with fields is open, that's the form the user is looking at.
  function findRoot() {
    const dialogs = [...document.querySelectorAll(
      '[role="dialog"], [aria-modal="true"], dialog[open], .modal.show, .modal.in, .modal[style*="display: block"]'
    )].filter((d) => isVisible(d) && d.querySelector(FIELD_SEL));
    return dialogs.length ? dialogs[dialogs.length - 1] : document.body;
  }

  function textOfId(id) {
    const n = document.getElementById(id);
    return n ? clean(n.innerText || n.textContent) : '';
  }

  function labelOf(el) {
    const parts = [];
    const lb = el.getAttribute('aria-labelledby');
    if (lb) parts.push(lb.split(/\s+/).map(textOfId).join(' '));
    if (el.getAttribute('aria-label')) parts.push(el.getAttribute('aria-label'));
    if (el.labels && el.labels.length) parts.push([...el.labels].map((l) => clean(l.innerText || l.textContent)).join(' '));
    if (el.placeholder) parts.push(el.placeholder);
    if (el.title) parts.push(el.title);
    return clean(parts.filter(Boolean).join(' | ')).slice(0, 300);
  }

  const groupKey = (el) => (el.type === 'radio' && el.name ? 'radio:' + el.name : el);

  // Climb from the field to the largest ancestor that still belongs to "this question"
  // (e.g. the row holding the criterion text, the rating select and its comment box).
  function contextOf(el, candSet) {
    let node = el;
    for (let i = 0; i < 8; i++) {
      const p = node.parentElement;
      if (!p || p === document.body) break;
      const keys = new Set();
      p.querySelectorAll(FIELD_SEL).forEach((f) => { if (candSet.has(f)) keys.add(groupKey(f)); });
      if (keys.size > 2 && clean(node.innerText).length > 20) break;
      node = p;
    }
    return clean(node.innerText).slice(0, 1200);
  }

  function radioLabel(r) {
    const t = (r.labels && r.labels[0] && r.labels[0].innerText) || r.getAttribute('aria-label') ||
      (r.parentElement && r.parentElement.innerText) || r.value;
    return clean(t).slice(0, 150);
  }

  function currentValue(f) {
    const el = f._els[0];
    switch (f.kind) {
      case 'select': return el.value;
      case 'multiselect': return [...el.selectedOptions].map((o) => o.value).join(', ');
      case 'radio': return (f._els.find((r) => r.checked) || {}).value || '';
      case 'checkbox': return el.checked ? 'true' : 'false';
      case 'richtext': return clean(el.innerText);
      default: return el.value || '';
    }
  }

  function scan() {
    registry.clear();
    const root = findRoot();
    const cand = [...root.querySelectorAll(FIELD_SEL)]
      .filter(isCandidate)
      .filter((el) => !(el.isContentEditable && el.parentElement && el.parentElement.isContentEditable));
    const candSet = new Set(cand);
    const fields = [];
    const radios = new Map();
    let n = 0;

    for (const el of cand) {
      if (el.type === 'radio' && el.name && radios.has(el.name)) { radios.get(el.name)._els.push(el); continue; }
      const tag = el.tagName;
      let kind;
      if (tag === 'SELECT') kind = el.multiple ? 'multiselect' : 'select';
      else if (tag === 'TEXTAREA') kind = 'textarea';
      else if (tag !== 'INPUT' && el.isContentEditable) kind = 'richtext';
      else if (el.type === 'radio') kind = 'radio';
      else if (el.type === 'checkbox') kind = 'checkbox';
      else kind = 'text';

      const f = {
        id: 'f' + (++n),
        kind,
        label: labelOf(el),
        name: el.name || el.id || '',
        context: contextOf(el, candSet),
        required: !!(el.required || el.getAttribute('aria-required') === 'true'),
        _els: [el],
      };
      if (kind === 'text') f.inputType = (el.type || 'text').toLowerCase();
      if (el.maxLength > 0) f.maxLength = el.maxLength;
      if (tag === 'SELECT') {
        f.options = [...el.options].filter((o) => !o.disabled).map((o) => ({ value: o.value, text: clean(o.text) }));
      }
      fields.push(f);
      if (kind === 'radio' && el.name) radios.set(el.name, f);
    }

    for (const f of fields) {
      if (f.kind === 'radio') f.options = f._els.map((r) => ({ value: r.value, text: radioLabel(r) }));
      f.currentValue = currentValue(f);
      f._els.forEach((e) => e.setAttribute('data-formpilot-id', f.id));
      registry.set(f.id, f);
    }

    return {
      url: location.href,
      title: document.title,
      scope: root === document.body ? 'page' : 'dialog',
      fields: fields.map(({ _els, ...rest }) => rest),
      pageText: (document.body.innerText || '').slice(0, 80000),
    };
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); // works with React/Vue
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function matchOption(options, v) {
    const s = String(v ?? '').trim().toLowerCase();
    if (!s) return null;
    const lc = (x) => x.toLowerCase();
    return options.find((o) => lc(o.value) === s)
      || options.find((o) => lc(o.text) === s)
      || options.find((o) => o.value && lc(o.text).startsWith(s))
      || options.find((o) => o.value && o.text && s.startsWith(lc(o.text)))
      || options.find((o) => o.value && lc(o.text).includes(s))
      || null;
  }

  function highlightTarget(el) { return isVisible(el) ? el : el.parentElement || el; }

  function flash(el) {
    const t = highlightTarget(el);
    const prev = t.style.outline;
    t.style.outline = '2px solid #6d5dfc';
    t.style.outlineOffset = '2px';
    setTimeout(() => { t.style.outline = prev; t.style.outlineOffset = ''; }, 1500);
  }

  function fillOne(f, value) {
    const el = f._els[0];
    switch (f.kind) {
      case 'select': {
        const o = matchOption(f.options, value);
        if (!o) return `no option matches "${value}"`;
        setNativeValue(el, o.value);
        break;
      }
      case 'multiselect': {
        const wanted = String(value).split(/\s*[,;]\s*/).filter(Boolean);
        [...el.options].forEach((op) => {
          op.selected = wanted.some((w) => matchOption([{ value: op.value, text: clean(op.text) }], w));
        });
        el.dispatchEvent(new Event('change', { bubbles: true }));
        break;
      }
      case 'radio': {
        const o = matchOption(f.options, value);
        if (!o) return `no option matches "${value}"`;
        const r = f._els[f.options.indexOf(o)];
        if (r && !r.checked) r.click();
        break;
      }
      case 'checkbox': {
        const want = /^(true|yes|y|1|on|checked)$/i.test(String(value).trim());
        if (el.checked !== want) el.click();
        break;
      }
      case 'richtext': {
        el.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, String(value));
        break;
      }
      default: {
        el.focus();
        setNativeValue(el, String(value));
        el.blur();
      }
    }
    flash(el);
    return null;
  }

  function fill(values) {
    return values.map(({ id, value }) => {
      const f = registry.get(id);
      if (!f || !f._els[0].isConnected) return { id, ok: false, error: 'field not found — scan again' };
      try {
        const err = fillOne(f, value);
        return { id, ok: !err, error: err || undefined };
      } catch (e) {
        return { id, ok: false, error: e.message };
      }
    });
  }

  function focusField(id) {
    const f = registry.get(id);
    if (!f) return;
    highlightTarget(f._els[0]).scrollIntoView({ block: 'center', behavior: 'smooth' });
    flash(f._els[0]);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      if (msg.type === 'fp:scan') sendResponse({ ok: true, data: scan() });
      else if (msg.type === 'fp:fill') sendResponse({ ok: true, data: fill(msg.values || []) });
      else if (msg.type === 'fp:focus') { focusField(msg.id); sendResponse({ ok: true }); }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  });
})();

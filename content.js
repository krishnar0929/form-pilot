// FormPilot content script: scans form fields on the page and fills approved values.
// Injected on demand from the side panel. Never submits anything.
(() => {
  // Version-aware guard: after the extension is updated, a stale copy can linger in the tab's
  // isolated world. Let a newer version take over instead of bailing out.
  const VERSION = chrome.runtime.getManifest().version;
  if (window.__formPilotLoaded === VERSION) return;
  window.__formPilotLoaded = VERSION;

  const FIELD_SEL = 'input, select, textarea, [contenteditable="true"], [contenteditable=""], ' +
    '[role="combobox"]:not(input), button[aria-haspopup="listbox"]';
  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'password']);
  const COMBO_CLASS = /(^|[\s_-])(select|dropdown|combo|chosen|choices|multiselect|picker)/i;
  // Things that can be an option inside an opened custom dropdown.
  const OPTION_SEL = '[role="option"], li, .option, .dropdown-item, [class*="option"], [class*="item"], a, span, div';
  const registry = new Map(); // id -> field (with _els)

  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  }

  // A text-like control that actually behaves like a pick-list (custom dropdown widget).
  function isComboLike(el) {
    if (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return false;
    if (el.tagName !== 'INPUT') return true; // role=combobox div / listbox button
    const t = (el.type || 'text').toLowerCase();
    if (!['text', 'search', ''].includes(t)) return false;
    if (el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-haspopup') ||
        el.hasAttribute('aria-autocomplete') || el.hasAttribute('aria-expanded') || el.readOnly) return true;
    let n = el;
    for (let i = 0; i < 3 && n; i++, n = n.parentElement) {
      if (COMBO_CLASS.test(n.className && typeof n.className === 'string' ? n.className : '')) return true;
    }
    return false;
  }

  function isCandidate(el) {
    const tag = el.tagName;
    if (tag === 'INPUT' && SKIP_TYPES.has((el.type || 'text').toLowerCase())) return false;
    if (el.disabled) return false;
    if (el.readOnly && !isComboLike(el)) return false;
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
    const label = clean(parts.filter(Boolean).join(' | ')).slice(0, 300);
    return /^[\[\]{}()\s|]*$/.test(label) ? '' : label; // drop junk like "[]"
  }

  const groupKey = (el) => (el.type === 'radio' && el.name ? 'radio:' + el.name : el);

  // Climb from the field to the largest ancestor that still belongs to "this question"
  // (e.g. the row holding the criterion text, the rating control and its comment box).
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

  // ---------- custom dropdown helpers ----------
  function isTiny(el) {
    const r = el.getBoundingClientRect();
    return r.width < 8 || r.height < 8;
  }

  function widgetOf(el) {
    // Hidden/tiny backing input: the clickable box is the nearest real-sized ancestor.
    if (isTiny(el) || !isVisible(el)) {
      let a = el.parentElement;
      for (let i = 0; i < 6 && a; i++, a = a.parentElement) {
        const r = a.getBoundingClientRect();
        if (isVisible(a) && r.width >= 60 && r.height >= 18) return a;
      }
    }
    // The visible box the user clicks (input itself, or its styled wrapper).
    let n = el;
    for (let i = 0; i < 3 && n.parentElement; i++) {
      const p = n.parentElement;
      if (COMBO_CLASS.test(typeof p.className === 'string' ? p.className : '') && isVisible(p)) return p;
      n = p;
    }
    return isVisible(el) ? el : el.parentElement;
  }

  function nearbySelect(el) {
    let n = el;
    for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
      const s = n.querySelector && n.querySelector('select');
      if (s && s.options.length > 1) return s;
    }
    return null;
  }

  function fire(el, type) {
    const opts = { bubbles: true, cancelable: true, view: window };
    const E = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    el.dispatchEvent(new E(type, opts));
  }
  function realClick(el) {
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => fire(el, t));
  }

  function visibleOptionCandidates() {
    return new Set([...document.querySelectorAll(OPTION_SEL)].filter((e) => {
      if (!isVisible(e)) return false;
      const t = clean(e.innerText);
      return t && t.length <= 80;
    }));
  }

  // Leaf-most option-like elements that appeared after opening the widget.
  function appearedOptions(before, anchor) {
    const listbox = anchor.getAttribute('aria-controls') || anchor.getAttribute('aria-owns');
    if (listbox && document.getElementById(listbox)) {
      const lb = document.getElementById(listbox);
      const opts = [...lb.querySelectorAll('[role="option"], li')].filter(isVisible);
      if (opts.length) return opts;
    }
    const roleOpts = [...document.querySelectorAll('[role="option"]')].filter((e) => isVisible(e) && !before.has(e));
    if (roleOpts.length) return roleOpts;
    const fresh = [...visibleOptionCandidates()].filter((e) => !before.has(e));
    // keep leaves: drop elements that contain another fresh element with the same text
    const leaves = fresh.filter((e) => !fresh.some((o) => o !== e && e.contains(o) && clean(o.innerText) === clean(e.innerText)));
    // keep the largest group of siblings (the actual list)
    const groups = new Map();
    leaves.forEach((e) => {
      const k = e.parentElement;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    });
    let best = [];
    groups.forEach((g) => { if (g.length > best.length) best = g; });
    return best.length >= 2 ? best : [];
  }

  async function openWidget(el) {
    const before = visibleOptionCandidates();
    const w = widgetOf(el);
    el.focus && el.focus();
    realClick(w);
    await sleep(180);
    let opts = appearedOptions(before, el);
    if (!opts.length && w !== el) { realClick(el); await sleep(180); opts = appearedOptions(before, el); }
    if (!opts.length) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
      await sleep(180);
      opts = appearedOptions(before, el);
    }
    return opts;
  }

  async function closeWidget(el) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    el.blur && el.blur();
    await sleep(60);
  }

  function comboDisplay(el) {
    if (el.tagName === 'INPUT' && el.value && !isTiny(el) && isVisible(el) && !el.readOnly) return clean(el.value);
    if (el.tagName === 'INPUT' && el.value && el.readOnly && !isTiny(el)) return clean(el.value);
    return clean(widgetOf(el).innerText.replace(/[×✕✖]/g, ' ')).slice(0, 120);
  }

  // Remove buttons on already-selected chips/tags (so a single rating gets replaced, not added).
  function chipRemovers(el) {
    const w = widgetOf(el);
    const sel = '[class*="remove"], [class*="clear"], [class*="times"], [class*="close"], ' +
      '[aria-label*="remove" i], [title*="remove" i], [aria-label*="clear" i], [title*="clear" i], [aria-label*="delete" i]';
    const byClass = [...w.querySelectorAll(sel)];
    const byGlyph = [...w.querySelectorAll('*')].filter((e) => e.children.length === 0 && /^[×✕✖]$/.test(clean(e.textContent)));
    return [...new Set([...byClass, ...byGlyph])].filter(isVisible);
  }

  // ---------- scan ----------
  function currentValue(f) {
    const el = f._els[0];
    switch (f.kind) {
      case 'select': return el.value;
      case 'multiselect': return [...el.selectedOptions].map((o) => o.value).join(', ');
      case 'radio': return (f._els.find((r) => r.checked) || {}).value || '';
      case 'checkbox': return el.checked ? 'true' : 'false';
      case 'richtext': return clean(el.innerText);
      case 'combo': return comboDisplay(el);
      default: return el.value || '';
    }
  }

  async function scan() {
    registry.clear();
    const root = findRoot();
    let cand = [...root.querySelectorAll(FIELD_SEL)]
      .filter(isCandidate)
      .filter((el) => !(el.isContentEditable && el.parentElement && el.parentElement.isContentEditable));

    // Custom dropdowns: drop their hidden native <select> / inner inputs so each shows once.
    const combos = cand.filter(isComboLike);
    const linkedSelects = new Map();
    combos.forEach((c) => { const s = nearbySelect(c); if (s) linkedSelects.set(c, s); });
    const linked = new Set(linkedSelects.values());
    cand = cand.filter((el) => !linked.has(el))
      .filter((el) => !(isComboLike(el) && el.tagName !== 'INPUT' && el.querySelector('input') && cand.includes(el.querySelector('input'))));

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
      else if (isComboLike(el)) kind = 'combo';
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
      if (kind === 'combo') {
        const sel = linkedSelects.get(el);
        if (sel) f._select = sel;
        f.options = sel
          ? [...sel.options].filter((o) => !o.disabled && clean(o.text)).map((o) => ({ value: clean(o.text), text: clean(o.text) }))
          : [];
      }
      fields.push(f);
      if (kind === 'radio' && el.name) radios.set(el.name, f);
    }

    // Plain-looking text boxes can still be pick-lists: click each empty short one and see if a list pops up.
    for (const f of fields.filter((x) => x.kind === 'text' && ['text', 'search'].includes(x.inputType)).slice(0, 30)) {
      try {
        const opts = await openWidget(f._els[0]);
        if (opts.length >= 2) {
          f.kind = 'combo';
          delete f.inputType;
          f.options = opts.map((o) => ({ value: clean(o.innerText), text: clean(o.innerText) }));
        }
        await closeWidget(f._els[0]);
      } catch (e) { /* ignore */ }
    }

    // Read the options of custom dropdowns by briefly opening them.
    for (const f of fields.filter((x) => x.kind === 'combo' && !x.options.length).slice(0, 30)) {
      try {
        const opts = await openWidget(f._els[0]);
        f.options = opts.map((o) => ({ value: clean(o.innerText), text: clean(o.innerText) }));
        await closeWidget(f._els[0]);
      } catch (e) { /* ignore */ }
      if (!f.options.length) { f.kind = 'text'; f.inputType = 'text'; } // free-text autocomplete
    }

    const combosAll = fields.filter((x) => x.kind === 'combo' && x.options.length);
    const fullest = combosAll.reduce((a, b) => (b.options.length > a.length ? b.options : a), []);
    const fullSet = new Set(fullest.map((o) => o.text.toLowerCase()));
    combosAll.forEach((x) => {
      if (x.options.length < fullest.length && x.options.every((o) => fullSet.has(o.text.toLowerCase()))) {
        x.options = fullest.map((o) => ({ ...o }));
      }
    });

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
      fields: fields.map(({ _els, _select, ...rest }) => rest),
      pageText: (document.body.innerText || '').slice(0, 80000),
    };
  }

  // ---------- fill ----------
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
    const lc = (x) => (x || '').toLowerCase();
    const real = options.filter((o) => o.value !== '' || o.text);
    const nonEmpty = options.filter((o) => o.value !== '' && o.text);
    return options.find((o) => lc(o.value) === s)
      || options.find((o) => lc(o.text) === s)
      || real.find((o) => o.value && lc(o.text).startsWith(s))
      || real.find((o) => o.text && s.startsWith(lc(o.text)))
      // "3" on a 1–5 scale whose options are words (Minimal … Exceeding)
      || (/^\d+$/.test(s) && nonEmpty[Number(s) - 1])
      || real.find((o) => o.value && lc(o.text).includes(s))
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

  async function fillCombo(f, value) {
    const el = f._els[0];
    const want = matchOption(f.options || [], value);
    if (!want) return `no option matches "${value}"`;
    const wantText = want.text;
    const lcWant = wantText.toLowerCase();
    const shownNow = () => comboDisplay(el).toLowerCase();
    if (shownNow() === lcWant) return null; // already set

    // Single-choice tag widgets: remove the current chip before choosing a new one.
    const removers = chipRemovers(el);
    for (const r of removers) { realClick(r); await sleep(120); }

    const opts = await openWidget(el);
    const byText = (o) => clean(o.innerText).toLowerCase();
    const target = opts.find((o) => byText(o) === lcWant) || opts.find((o) => byText(o).startsWith(lcWant));
    if (target) {
      realClick(target);
      await sleep(180);
      if (opts.some((o) => o.isConnected && isVisible(o))) await closeWidget(el);
    } else {
      await closeWidget(el);
    }
    // Hidden native select behind the widget: set it too so the form posts the value.
    if (f._select) {
      const so = matchOption([...f._select.options].map((o) => ({ value: o.value, text: clean(o.text) })), wantText);
      if (so) setNativeValue(f._select, so.value);
    }
    const shown = shownNow();
    if (shown.includes(lcWant)) {
      const others = (f.options || []).filter((o) => o.text.toLowerCase() !== lcWant && shown.includes(o.text.toLowerCase()));
      return others.length ? `set "${wantText}" but "${others[0].text}" is still selected — remove it on the page` : null;
    }
    if (target || f._select) return null;
    return `couldn't find "${wantText}" in the dropdown`;
  }

  async function fillOne(f, value) {
    const el = f._els[0];
    switch (f.kind) {
      case 'select': {
        const o = matchOption(f.options, value);
        if (!o) return `no option matches "${value}"`;
        setNativeValue(el, o.value);
        break;
      }
      case 'combo': {
        const err = await fillCombo(f, value);
        if (err) return err;
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

  async function fill(values) {
    const out = [];
    for (const { id, value } of values) {
      const f = registry.get(id);
      if (!f || !f._els[0].isConnected) { out.push({ id, ok: false, error: 'field not found — scan again' }); continue; }
      try {
        const err = await fillOne(f, value);
        out.push({ id, ok: !err, error: err || undefined });
      } catch (e) {
        out.push({ id, ok: false, error: e.message });
      }
    }
    return out;
  }

  function focusField(id) {
    const f = registry.get(id);
    if (!f) return;
    highlightTarget(f._els[0]).scrollIntoView({ block: 'center', behavior: 'smooth' });
    flash(f._els[0]);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const reply = (p) => p.then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    if (msg.type === 'fp:scan') { reply(scan()); return true; }
    if (msg.type === 'fp:fill') { reply(fill(msg.values || [])); return true; }
    if (msg.type === 'fp:focus') { focusField(msg.id); sendResponse({ ok: true }); }
    if (msg.type === 'fp:debug') {
      const out = { version: VERSION, url: location.href, fields: [] };
      registry.forEach((f) => {
        const el = f._els[0];
        let box = el;
        for (let i = 0; i < 3 && box.parentElement; i++) box = box.parentElement;
        out.fields.push({
          id: f.id, kind: f.kind, tag: el.tagName, type: el.type || '', role: el.getAttribute('role') || '',
          readOnly: !!el.readOnly, visible: isVisible(el), options: (f.options || []).length,
          html: box.outerHTML.replace(/\s+/g, ' ').slice(0, 1500),
        });
      });
      sendResponse({ ok: true, data: out });
    }
    return false;
  });
})();

// QuickFill AI – content.js v5.3
// Changes over v5.2:
// - Fix 4: Defensive string coercion for field.question / field.label throughout
//   applyAnswerToField — prevents "[object Object]" in console warns when a field
//   arrives with a non-string question property (e.g. from legacy harvestFields path).
// - Fix 4: options display in Select no-match warn now safely handles both plain
//   string options and {label, value} object options.
// - Fix 4: getFieldLabel() helper centralises safe label extraction so all warn
//   sites are consistent.
// (Fixes 1-3 from v5.2 preserved unchanged)

'use strict';

if (window.__qfLoaded) {
  // Already injected — do nothing
} else {
window.__qfLoaded = true;

// ─── SmartApply step URL patterns ─────────────────────────────────────────

const SA = {
  DOMAIN:      'smartapply.indeed.com',
  CONTACT:     'contact-info',
  LOCATION:    'profile-location',
  RESUME:      'resume',
  PRIVACY:     'privacy',
  EXPERIENCE:  'experience',
  REVIEW:      'review',
  QUAL:        'qualification-questions-module',
  EMP_Q:       'questions-module',
  RESUME_SEL:  'resume-selection-module',
  APPLY_BY_ID: 'applybyapplyablejobid',
};

function isSmartApplyPage() {
  return location.hostname.includes(SA.DOMAIN);
}

function getSmartApplyStep() {
  const url = location.href.toLowerCase();
  if (url.includes(SA.RESUME_SEL))  return 'resume-selection';
  if (url.includes(SA.QUAL))        return 'qual-questions';
  if (url.includes(SA.EMP_Q))       return 'emp-questions';
  if (url.includes(SA.CONTACT))     return 'contact-info';
  if (url.includes(SA.LOCATION))    return 'location';
  if (url.includes(SA.REVIEW))      return 'review';
  if (url.includes(SA.PRIVACY))     return 'privacy';
  if (url.includes(SA.EXPERIENCE))  return 'experience';
  if (url.includes(SA.RESUME))      return 'resume';
  if (url.includes(SA.APPLY_BY_ID)) return 'redirect';
  return 'unknown';
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeText(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s/+.-]/g, '')
    .trim()
    .toLowerCase();
}

function getPageText() {
  return (document.body?.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isVisible(el) {
  if (!el || el.disabled || el.readOnly) return false;
  const s = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return (
    s.display    !== 'none'   &&
    s.visibility !== 'hidden' &&
    s.opacity    !== '0'      &&
    rect.width  > 0           &&
    rect.height > 0
  );
}

// ─── Unique ID system ──────────────────────────────────────────────────────

const _idMap = new WeakMap();
let _idCounter = 0;

function uniqueId(el) {
  if (!_idMap.has(el)) {
    const id = `__qf_${_idCounter++}`;
    _idMap.set(el, id);
    el.dataset.__qfId = id;
  }
  return _idMap.get(el);
}

// ─── Label detection ───────────────────────────────────────────────────────

function getLabelText(el) {
  if (el.id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (lbl) return lbl.innerText.trim();
  }

  const wrap = el.closest('label');
  if (wrap) return wrap.innerText.trim();

  const lblId = el.getAttribute('aria-labelledby');
  if (lblId) {
    const text = lblId.trim().split(/\s+/)
      .map(id => { const r = document.getElementById(id); return r ? r.innerText.trim() : ''; })
      .filter(Boolean).join(' ');
    if (text) return text;
  }

  const al = el.getAttribute('aria-label');
  if (al) return al.trim();

  let node = el.parentElement;
  for (let i = 0; i < 8; i++) {
    if (!node) break;
    const candidates = node.querySelectorAll(
      'label, legend, [class*="label"], [class*="Label"], [class*="question"], [class*="Question"], ' +
      '[data-testid*="question"], [data-testid*="Questions"], span, p, h1, h2, h3, h4'
    );
    for (const c of candidates) {
      if (c.contains(el)) continue;
      const txt = (c.innerText || '').trim();
      if (txt.length > 2 && txt.length < 300) return txt;
    }
    node = node.parentElement;
  }

  return el.getAttribute('placeholder') || el.name || el.id || '';
}

function getFieldsetLegend(el) {
  const fs = el.closest('fieldset');
  if (fs) {
    const leg = fs.querySelector('legend');
    if (leg) return leg.innerText.trim();
  }
  return '';
}

function getIndeedQuestionText(el) {
  let node = el.parentElement;
  for (let i = 0; i < 10; i++) {
    if (!node) break;
    const text = (node.innerText || '').trim();
    if (text.length > 5 && text.length < 500 && !text.includes('\n\n\n')) {
      const clean = text.replace(el.value || '', '').trim();
      if (clean.length > 5) return clean;
    }
    node = node.parentElement;
  }
  return '';
}

function getQuestionContainer(el) {
  return (
    el.closest('fieldset')                          ||
    el.closest('[role="group"]')                    ||
    el.closest('[role="radiogroup"]')               ||
    el.closest('[data-testid*="question"]')         ||
    el.closest('[data-testid*="Questions"]')        ||
    el.closest('[class*="Question"]')               ||
    el.closest('[class*="question"]')               ||
    el.closest('[class*="ia-Questions"]')           ||
    el.closest('[class*="questions-module"]')       ||
    el.closest('[class*="formField"]')              ||
    el.parentElement
  );
}

// ─── Indeed: extract question text for a radio group by name='q_{hash}' ───

function extractIndeedQuestionTextForRadioGroup(radioName, options) {
  let questionText = '';

  try {
    const container = document.querySelector(`[data-testid*="${CSS.escape(radioName)}"]`);
    if (container) {
      let qt = container.innerText || '';
      for (const [, optText] of options) {
        if (optText) qt = qt.replace(optText, ' ');
      }
      qt = qt.replace(/\*/g, ' ').replace(/Required/gi, ' ');
      questionText = qt.replace(/\s+/g, ' ').trim();
    }
  } catch (_) {}

  if (!questionText && options.length) {
    try {
      let node = options[0][0].parentElement;
      for (let i = 0; i < 8; i++) {
        if (!node) break;
        if ((node.id && /^q_/.test(node.id)) ||
            (node.className && node.className.includes('ia-Questions-item'))) {
          let qt = node.innerText || '';
          for (const [, optText] of options) {
            if (optText) qt = qt.replace(optText, ' ');
          }
          qt = qt.replace(/\*/g, ' ').replace(/Required/gi, ' ');
          questionText = qt.replace(/\s+/g, ' ').trim();
          break;
        }
        node = node.parentElement;
      }
    } catch (_) {}
  }

  if (!questionText && options.length) {
    try {
      questionText = getLabelText(options[0][0]) || getIndeedQuestionText(options[0][0]);
    } catch (_) {}
  }

  return questionText || '';
}

// ─── Indeed: rule-based choice picker ──────────────────────────────────────
// Ported from indeed_bot.py — 30+ patterns.
// options: Array of [element, labelText]
// Returns: element to click, or null (→ fall through to AI)

function pickChoiceByRules(questionLower, options) {
  const q = questionLower;

  function pick(...prefs) {
    for (const pref of prefs) {
      for (const [el, lbl] of options) {
        if (lbl.toLowerCase().includes(pref.toLowerCase())) return el;
      }
    }
    return null;
  }

  // Commute / relocation / travel
  if (/commute|reliably commute|relocat|willing to travel/.test(q))
    return pick('yes, i can make the commute', 'can make the commute',
                'yes, i am able to commute', 'commute readily', 'yes');

  // Sponsorship / visa
  if (/sponsorship|visa sponsor|require sponsor|work permit/.test(q))
    return pick('no', 'do not require', 'not require', 'no sponsorship');

  // Work eligibility / authorization
  if (/eligible|authorized to work|legal right|legally authorized|work in canada|work in the us/.test(q))
    return pick('yes', 'canadian citizen', 'authorized', 'eligible', 'permanent resident');

  // English / language proficiency
  if (/speak english|english proficiency|proficient in english|fluent in english|english language|do you speak/.test(q))
    return pick('yes', 'advanced', 'native', 'fluent', 'mother tongue');

  // Background check consent
  if (/background check|criminal record check|screening|consent to a check/.test(q))
    return pick('yes', 'i consent', 'agree', 'authorize');
  
  // Pre-employment / mandatory tests
  if (/pre.?employment\s+test|mandatory\s+test|medical\s+test|drug.*alcohol|health.*safety.*test/i.test(q))
    return pick('yes', 'i consent', 'agree', 'authorize');

  // Drug test
  if (/drug test|substance test/.test(q))
    return pick('yes', 'i consent', 'agree');

  // Gender / pronouns → prefer not to disclose
  if (/\bgender\b|\bpronoun/.test(q))
    return pick('prefer not', 'prefer not to disclose', 'prefer not to say', 'decline', 'male');

  // Indigenous / Aboriginal / First Nations
  if (/indigenous|aboriginal|first nation|métis|metis|inuit|status indian/.test(q))
    return pick('no', 'non', 'prefer not to say', 'prefer not to disclose');

  // Disability
  if (/disability|disabled|handicap|differently abled/.test(q))
    return pick('no', 'non', 'prefer not to say', 'prefer not to disclose');

  // Visible minority / race / ethnicity
  if (/visible minority|racial|racialized|race|ethnicity|ethnic origin/.test(q))
    return pick('south asian', 'asian', 'prefer not to say', 'prefer not to disclose');

  // Veteran / military
  if (/veteran|military service|armed forces|protected veteran/.test(q))
    return pick('not a veteran', 'i am not', 'no', 'none', 'prefer not');

  // LGBTQ+ / sexual orientation
  if (/lgbtq|sexual orientation|sexual identity/.test(q))
    return pick('prefer not', 'prefer not to disclose', 'prefer not to say');

  // Conviction / criminal
  if (/convicted|felony|criminal charge|criminal offence/.test(q))
    return pick('no', 'none');

  // Age 18+
  if (/18 or above|over 18|at least 18|minimum age|18 years of age|age 18|be 18/.test(q))
    return pick('yes', 'oui');

  // Previous employment at this company
  if (/ever worked for|previously worked for|have you worked at|ever been employed by|formerly employed by|worked at any of|previously employed by|ever been employed by|ever employed by|work for any of/.test(q))
    return pick('no', 'non');

  // "Have you ever been an employee at [company]?"
  if (/ever been an employee|been an employee at|have you ever been.*employee/.test(q))
    return pick('no, i have never', 'never worked', 'never been', 'i have never', 'no');

  // Currently employed
  if (/currently employed (with|at|by|for)|are you (currently|presently) employed/.test(q))
    return pick('no', 'non');

  // Former employee / ex-employee
  if (/\bformer\b.*\bemployee\b|\bex.?employee\b|former staff/.test(q))
    return pick('no, i have never', 'never worked', 'never been', 'i have never', 'no');

  // Were you referred
  if (/were you referred|referred to (the|this) position|referred by (a |an )?(current |existing )?employee/.test(q)) {
    const lowers = options.map(([, lbl]) => lbl.toLowerCase().trim());
    const isYesNo = lowers.every(l => /^(yes|no|oui|non)$/.test(l));
    if (isYesNo || !options.length) return pick('no', 'non');
  }

  // Do you know anyone that works
  if (/do you know anyone (that|who) works|know (of )?anyone.*work(s| for)|know anyone that works/.test(q))
    return pick('no', 'non');

  // Availability / schedule / office patterns
  if (/available to work|work evenings|work weekends|work overtime|flexible schedule|work on weekends|work.*office|from the office|in office|in the office|office.*days|days.*per week|days a week|hybrid|3x per week|two days|three days|three times per week|tuesdays|wednesdays|thursdays|\bonsite\b/.test(q))
    return pick('yes', 'oui');

  // Full-time onsite
  if (/\bonsite\b|full.?time onsite|work.*on.?site|able to work.*onsite/.test(q))
    return pick('locally based', 'onsite (locally', 'yes');

  // Canadian citizen / PR
  if (/canadian citizen|permanent resident|pr holder|citizen of canada/.test(q))
    return pick('yes', 'canadian citizen', 'permanent resident');

  // Currently enrolled / student
  if (/currently enrolled|are you a student/.test(q))
    return pick('yes', 'oui');

  // 18+ (alternate phrasing)
  if (/are you at least|are you over/.test(q))
    return pick('yes', 'oui');

  // Years of experience — pick lowest range that covers ~4 years
  if (/how many years|years of experience|amount of experience|years have you/.test(q)) {
    for (const [el, lbl] of options) {
      const nums = (lbl.match(/\d+/g) || []).map(Number);
      if (!nums.length) continue;
      if (nums.length === 1 && nums[0] <= 4) return el;
      if (nums.length >= 2 && nums[0] <= 4 && nums[1] >= 4) return el;
    }
    return options[0]?.[0] || null;
  }

  // Pure Yes/No — defer to AI
  const lowers = options.map(([, lbl]) => lbl.toLowerCase().trim());
  const isYesNo = lowers.every(l => /^(yes|no|oui|non|true|false)$/.test(l));
  if (isYesNo) return null;

  return null; // → AI fallback
}

// ─── Indeed: harvest radios grouped by name='q_{hash}' ────────────────────

function harvestIndeedNamedRadioGroups(seen) {
  const fields = [];
  const groups = new Map();

  for (const r of document.querySelectorAll('input[type="radio"]')) {
    if (!isVisible(r)) continue;
    const name = r.getAttribute('name') || '';
    if (!name) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(r);
  }

  for (const [name, radios] of groups) {
    if (radios.some(r => seen.has(r))) continue;
    if (radios.some(r => r.checked))   continue;

    const options = radios.map(r => {
      const rid  = r.getAttribute('id') || '';
      const lbl  = rid ? document.querySelector(`label[for="${CSS.escape(rid)}"]`) : null;
      const text = (lbl ? lbl.innerText.trim() : (r.getAttribute('value') || '')).trim();
      return [r, text];
    }).filter(([, t]) => t);

    if (!options.length) continue;

    const questionText = extractIndeedQuestionTextForRadioGroup(name, options);
    const opts = options.map(([, t]) => t);

    radios.forEach(r => seen.add(r));

    fields.push({
      id:             'radio::' + name,
      tag:            'radio',
      type:           'radio',
      name,
      label:          questionText || name,
      options:        opts,
      currentValue:   '',
      _indeedOptions: options,
    });
  }

  return fields;
}

// ─── Indeed checkbox-group harvester ──────────────────────────────────────

function extractIndeedQuestionTextForCheckboxGroup(groupName, options) {
  let questionText = '';

  try {
    const container = document.querySelector(`[data-testid*="${CSS.escape(groupName)}"]`);
    if (container) {
      let qt = container.innerText || '';
      for (const [, optText] of options) {
        if (optText) qt = qt.replace(optText, ' ');
      }
      qt = qt.replace(/\*/g, ' ').replace(/Required/gi, ' ');
      questionText = qt.replace(/\s+/g, ' ').trim();
    }
  } catch (_) {}

  if (!questionText && options.length) {
    try {
      let node = options[0][0].parentElement;
      for (let i = 0; i < 8; i++) {
        if (!node) break;
        if (
          node.matches?.('fieldset') ||
          (node.id && /^q_/.test(node.id)) ||
          (node.className && String(node.className).includes('ia-Questions-item'))
        ) {
          let qt = node.innerText || '';
          for (const [, optText] of options) {
            if (optText) qt = qt.replace(optText, ' ');
          }
          qt = qt.replace(/\*/g, ' ').replace(/Required/gi, ' ');
          questionText = qt.replace(/\s+/g, ' ').trim();
          break;
        }
        node = node.parentElement;
      }
    } catch (_) {}
  }

  if (!questionText && options.length) {
    try {
      questionText =
        getFieldsetLegend(options[0][0]) ||
        getLabelText(options[0][0]) ||
        getIndeedQuestionText(options[0][0]);
    } catch (_) {}
  }

  return questionText || '';
}

function harvestIndeedNamedCheckboxGroups(seen) {
  const fields = [];
  const groups = new Map();

  for (const c of document.querySelectorAll('input[type="checkbox"]')) {
    if (!isVisible(c)) continue;

    const name = c.getAttribute('name') || '';
    if (!name) continue;

    const lbl = (getLabelText(c) || '').toLowerCase();

    // keep consent boxes in the existing auto-click path
    if (/consent|agree|understand|authorize|accept|confirm/.test(lbl)) continue;

    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(c);
  }

  for (const [name, boxes] of groups) {
    if (boxes.length < 2) continue;
    if (boxes.some(b => seen.has(b))) continue;

    const options = boxes.map(b => {
      const bid     = b.getAttribute('id') || '';
      const lblEl   = bid ? document.querySelector(`label[for="${CSS.escape(bid)}"]`) : null;
      const wrapLbl = b.closest('label');
      const text = (
        (lblEl   ? lblEl.innerText.trim()   : '') ||
        (wrapLbl ? wrapLbl.innerText.trim() : '') ||
        b.getAttribute('value') || ''
      ).trim();
      return [b, text];
    }).filter(([, t]) => t);

    if (!options.length) continue;

    const questionText = extractIndeedQuestionTextForCheckboxGroup(name, options);
    const current = options.filter(([b]) => b.checked).map(([, t]) => t);

    boxes.forEach(b => seen.add(b));

    fields.push({
      id:           'checkboxgroup::' + name,
      tag:          'checkbox-group',
      type:         'checkbox-group',
      name,
      label:        questionText || name,
      options:      options.map(([, t]) => t),
      currentValue: current.join(', '),
    });
  }

  return fields;
}

// ─── Indeed: legacy container-based harvester ──────────────────────────────

function harvestIndeedContainerFields(seen) {
  const extra = [];

  const questionContainers = document.querySelectorAll(
    '[data-testid*="ia-Questions"], [class*="ia-Questions"], ' +
    '[data-testid*="screenerQuestion"], [class*="screenerQuestion"]'
  );

  for (const container of questionContainers) {
    if (!isVisible(container)) continue;

    const questionEl =
      container.querySelector('[class*="questionTitle"], [class*="question-title"], legend, h3, h4, p') ||
      container.querySelector('label') ||
      container;
    const questionText = (questionEl?.innerText || '').trim();
    if (!questionText || questionText.length < 4) continue;

    const sel = container.querySelector('select');
    if (sel && isVisible(sel) && !seen.has(sel)) {
      seen.add(sel);
      const opts = Array.from(sel.options)
        .filter(o => o.value || o.text.trim())
        .map(o => o.text.trim())
        .filter(Boolean);
      if (opts.length) {
        extra.push({
          id:           uniqueId(sel),
          tag:          'select',
          type:         'select',
          name:         sel.name || sel.id || '',
          label:        questionText,
          options:      opts,
          currentValue: sel.options[sel.selectedIndex]?.text || '',
        });
      }
      continue;
    }

    const radioInputs = Array.from(container.querySelectorAll('input[type="radio"]'));
    if (radioInputs.length && radioInputs.some(r => !r.checked)) {
      const groupName = radioInputs[0].name || uniqueId(container);
      if (!radioInputs.some(r => seen.has(r))) {
        radioInputs.forEach(r => seen.add(r));
        const opts = radioInputs.map(r => {
          const rid = r.id;
          const lbl = rid ? document.querySelector(`label[for="${CSS.escape(rid)}"]`) : null;
          return ((lbl ? lbl.innerText.trim() : r.value) || r.value || '').trim();
        }).filter(Boolean);
        extra.push({
          id:           'radio::' + groupName,
          tag:          'radio',
          type:         'radio',
          name:         groupName,
          label:        questionText,
          options:      opts,
          currentValue: '',
        });
      }
      continue;
    }

    const inp = container.querySelector('input[type="text"], input[type="number"], input:not([type])');
    if (inp && isVisible(inp) && !seen.has(inp)) {
      seen.add(inp);
      extra.push({
        id:           uniqueId(inp),
        tag:          'input-text',
        type:         inp.type || 'text',
        name:         inp.name || inp.id || '',
        label:        questionText,
        placeholder:  inp.getAttribute('placeholder') || '',
        options:      [],
        currentValue: inp.value || '',
      });
    }
  }

  return extra;
}

// ─── Indeed page-type detectors ────────────────────────────────────────────

function isIndeedPage() {
  return /indeed\.com/i.test(location.hostname);
}

function shouldSkipCurrentPage(text) {
  return (
    text.includes('enter a job that shows relevant experience') ||
    text.includes('we share one job title with the employer to introduce you as a candidate')
  );
}

function isEmployerRequirementsWarningPage(text) {
  return (
    text.includes("it looks like you don't meet these employer requirements") ||
    text.includes('you may not hear back from the employer based on your responses to their questions') ||
    text.includes('you may not hear back from the employer based on your responses')
  );
}

function isReasonForApplyingPage(text) {
  return (
    text.includes("help indeed better understand why you're applying") ||
    text.includes('reason for applying')
  );
}

// ─── Button detection ──────────────────────────────────────────────────────

function getBtnText(btn) {
  return (
    (btn.innerText || btn.textContent || btn.value || btn.getAttribute('aria-label') || '')
      .trim().toLowerCase()
  );
}

function getVisibleButtons() {
  return Array.from(
    document.querySelectorAll('button, input[type="button"], input[type="submit"]')
  ).filter(el => isVisible(el));
}

function isSubmitButton(btn) {
  if (btn.dataset?.testid === 'submit-application-button') return true;
  const txt = getBtnText(btn);
  return (
    txt.includes('submit your application') ||
    txt === 'submit'                         ||
    txt.includes('submit application')
  );
}

function isContinueButton(btn) {
  const dt = btn.dataset?.testid || '';
  if (dt === 'continue-button' || /^hp-continue-button/.test(dt)) return true;
  const txt = getBtnText(btn);
  return (
    txt === 'continue'                   ||
    txt === 'next'                       ||
    txt.includes('continue')            ||
    txt.includes('next')                ||
    txt.includes('apply anyway')        ||
    txt.includes('continue applying')   ||
    txt.includes('review application')  ||
    txt === 'review'
  );
}

function findSubmitButton() {
  const sa = document.querySelector("button[data-testid='submit-application-button']");
  if (sa && isVisible(sa)) return sa;
  return getVisibleButtons().find(isSubmitButton) || null;
}

function findContinueButton() {
  for (const sel of [
    "button[data-testid='continue-button']",
    "button[data-testid*='hp-continue-button']",
    "div[data-testid='resume-selection-footer'] button",
  ]) {
    const el = document.querySelector(sel);
    if (el && isVisible(el)) return el;
  }
  const buttons = getVisibleButtons();
  for (const btn of buttons) {
    if (isSubmitButton(btn)) continue;
    if (isContinueButton(btn)) return btn;
  }
  return null;
}

function findAnyNavigationButton() {
  const NAV_RE  = /\b(continue|next|proceed|apply|forward|review|submit|go)\b/;
  const SKIP_RE = /\b(back|previous|cancel|close|sign\s*in|log\s*in|save\s*draft|delete|remove)\b/;
  const candidates = Array.from(document.querySelectorAll(
    'button, input[type="button"], input[type="submit"], [role="button"], a[role="button"]'
  ));
  for (const btn of candidates) {
    const s = window.getComputedStyle(btn);
    if (s.display === 'none' || s.visibility === 'hidden') continue;
    if (btn.disabled) continue;
    const txt = getBtnText(btn);
    if (!txt) continue;
    if (SKIP_RE.test(txt)) continue;
    if (NAV_RE.test(txt)) return btn;
  }
  return null;
}

async function findAnyNavigationButtonWithRetry(timeout = 800, interval = 250) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const btn = findContinueButton() || findAnyNavigationButton();
    if (btn) return btn;
    await sleep(interval);
  }
  return null;
}

function findApplyAnywayButton() {
  return getVisibleButtons().find(btn => getBtnText(btn).includes('apply anyway')) || null;
}

// ─── DOM interaction helpers ───────────────────────────────────────────────

function clickElement(el) {
  if (!el) return false;
  try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (_) {}
  try { el.click(); return true; } catch (_) {}
  try {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true }));
    return true;
  } catch (_) {}
  return false;
}

function fireKeyboardOpen(el) {
  try {
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup',   { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
    return true;
  } catch (_) { return false; }
}

function waitForDomChange(previousSnapshot, timeout = 2500) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      observer.disconnect();
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), timeout);
    const observer = new MutationObserver(() => {
      const now = (document.body?.innerText || '').slice(0, 2000).replace(/\s+/g, ' ').toLowerCase();
      if (now !== previousSnapshot) finish(true);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}

async function safeNavigate(btn, beforeSnapshot) {
  if (!btn) return false;
  clickElement(btn);
  await sleep(250);
  await waitForDomChange(beforeSnapshot, 1800);
  await sleep(100);
  return true;
}

// ─── Combobox helpers ──────────────────────────────────────────────────────

function getOptionText(el) {
  return (
    el.getAttribute('aria-label') ||
    el.getAttribute('data-testid') ||
    el.innerText ||
    el.textContent ||
    ''
  ).replace(/\s+/g, ' ').trim();
}

function getComboboxOptions() {
  const combined =
    '[role="option"], [role="listbox"] [tabindex], [role="listbox"] li, ' +
    '[role="listbox"] button, [role="menu"] [role="menuitem"], [role="menu"] li, ' +
    '[data-testid*="menu"] [role="option"], [data-testid*="listbox"] [role="option"], ' +
    'ul[role="listbox"] li, div[role="dialog"] [role="option"]';
  const seen = new Set();
  const out  = [];
  for (const el of document.querySelectorAll(combined)) {
    if (!isVisible(el)) continue;
    if (seen.has(el)) continue;
    const txt = getOptionText(el);
    if (!txt) continue;
    seen.add(el);
    out.push(el);
  }
  return out;
}

function findBestMatch(answer, options) {
  const ans = normalizeText(answer);
  if (!ans) return null;
  let exact = null, includes = null;
  for (const opt of options) {
    const txt = normalizeText(getOptionText(opt));
    if (!txt) continue;
    if (txt === ans) { exact = opt; break; }
    if (!includes && (txt.includes(ans) || ans.includes(txt))) includes = opt;
  }
  return exact || includes || null;
}

async function chooseComboboxOption(comboEl, answer) {
  if (!comboEl || !answer) return false;
  clickElement(comboEl);
  await sleep(150);
  let options = getComboboxOptions();
  if (!options.length) {
    fireKeyboardOpen(comboEl);
    await sleep(200);
    options = getComboboxOptions();
  }
  const best = findBestMatch(answer, options);
  if (best) { clickElement(best); await sleep(100); return true; }
  return false;
}

function getRadioLikeOptions(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(
    'input[type="radio"], [role="radio"], button, label, [data-testid*="radio"], ' +
    '[class*="radio"], [class*="Radio"], [class*="option"], [class*="Option"], ' +
    '[class*="card"], [class*="Card"]'
  )).filter(isVisible).map(el => {
    let text = '';
    if (el.matches('input[type="radio"]')) {
      const rid = el.id;
      const lbl = rid ? document.querySelector(`label[for="${CSS.escape(rid)}"]`) : null;
      text = (lbl ? lbl.innerText : el.value || '').trim();
    } else {
      text = getOptionText(el);
    }
    return { el, text };
  }).filter(x => x.text && x.text.length < 200);
}

function findCustomRadioGroupByName(name) {
  const exact = document.querySelector(`[role="radiogroup"][data-qf-name="${CSS.escape(name)}"]`);
  if (exact) return exact;
  const radios = document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`);
  if (radios.length) return radios[0].closest('fieldset, [role="radiogroup"], [role="group"], div') || radios[0];
  return null;
}

// ─── Export-extension field capture primitives ────────────────────────────

const isElement = (n) => n instanceof Element;

const cleanText = (v) => (v || '').replace(/\s+/g, ' ').trim();

const cssPath = (el) => {
  if (!isElement(el)) return '';
  try {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let cur = el;
    while (isElement(cur) && parts.length < 8) {
      let sel = cur.nodeName.toLowerCase();
      if (cur.classList && cur.classList.length)
        sel += '.' + Array.from(cur.classList).slice(0, 2).map(c => CSS.escape(c)).join('.');
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.nodeName === cur.nodeName);
        if (siblings.length > 1) sel += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
      }
      parts.unshift(sel);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  } catch (_) { return ''; }
};

const EX_JUNK = ['search', 'captcha', 'recaptcha', 'save and close', 'continue', 'tell us more'];
const EX_OPTION_ONLY = /^(yes|no|other|select an option|canada|usa|another country|annually|hourly|monthly|weekly)$/i;

const getExFieldset      = (el) => isElement(el) ? (el.closest('fieldset') || null) : null;
const getExQuestionItem  = (el) => isElement(el) ? (el.closest('.ia-Questions-item') || null) : null;
const getExLegendText    = (fs) => {
  if (!isElement(fs)) return '';
  const leg = fs.querySelector('legend [data-testid*="-label"]') || fs.querySelector('legend');
  return cleanText(leg?.innerText || leg?.textContent || '');
};

function getExQuestionContainer(el) {
  if (!isElement(el)) return el;
  return getExFieldset(el) || getExQuestionItem(el) || el.closest('[id^="q_"]') || el.closest('form') || el;
}

function cleanExQuestionText(text) {
  const t = cleanText(text || '');
  if (!t) return '';
  const seen = new Set();
  const lines = t.split('\n').map(cleanText).filter(Boolean).filter(line => {
    const key = line.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).filter(l => !EX_OPTION_ONLY.test(l)).filter(l => !EX_JUNK.some(j => l.toLowerCase().includes(j)));
  if (!lines.length) return '';
  const best =
    lines.find(l => /\?\s*\*?$/.test(l)) ||
    lines.find(l => /\*\s*$/.test(l))    ||
    lines.find(l => /experience|hear|onsite|legally|country|city|salary|start|employee|privacy|consent|certify|currency|linkedin/i.test(l)) ||
    lines[0];
  return cleanText(best).replace(/\s+(Yes|No|Other)(\s+(Yes|No|Other))*$/i, '').trim();
}

function getExQuestionText(el) {
  if (!isElement(el)) return '';
  const fs = getExFieldset(el);
  const legendText = cleanExQuestionText(getExLegendText(fs));
  if (legendText && !EX_OPTION_ONLY.test(legendText)) return legendText;
  const item = getExQuestionItem(el);
  if (item) {
    for (const c of [
      item.querySelector('legend'),
      item.querySelector('[data-testid*="-label"]'),
      item.querySelector('[role="heading"]'),
      item.querySelector('h1,h2,h3,h4,h5,h6'),
      item.querySelector('label'),
    ].filter(Boolean)) {
      const txt = cleanExQuestionText(c.innerText || c.textContent || '');
      if (txt && !EX_OPTION_ONLY.test(txt) && txt.split(' ').length > 3 && txt.length < 120) return txt;
    }
  }
  return '';
}

function findExLabel(el) {
  if (!isElement(el)) return '';
  const direct = cleanText(
    el.labels?.[0]?.innerText ||
    (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText) ||
    el.getAttribute('aria-label') || el.getAttribute('placeholder') || ''
  );
  if (direct && !EX_OPTION_ONLY.test(direct)) return direct;
  const qt = getExQuestionText(el);
  if (qt) return qt;
  let node = el.parentElement;
  while (isElement(node) && node !== document.body) {
    const txt = cleanExQuestionText(node.innerText || '');
    if (txt && txt.length < 120 && txt.split(' ').length > 3 && !EX_OPTION_ONLY.test(txt)) return txt;
    node = node.parentElement;
  }
  return cleanText(el.name || el.id || el.type || el.tagName);
}

function getExValidationMessage(el) {
  const describedBy = el.getAttribute('aria-describedby');
  if (describedBy) {
    const txt = describedBy.split(/\s+/).map(id => document.getElementById(id))
      .filter(Boolean).map(n => cleanText(n.innerText || n.textContent || '')).filter(Boolean).join(' | ');
    if (txt) return txt;
  }
  const inv = el.closest('[aria-invalid="true"], .icl-TextInput-error, [class*="error"], [class*="invalid"]');
  return inv ? cleanText(inv.innerText).slice(0, 300) : '';
}

function getExSection(el) {
  const s = el.closest('[data-testid*="section"], section, form, main');
  if (!s) return '';
  return cleanText(s.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]')?.innerText || '');
}

const isExRequired = (el, question) =>
  !!(el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(question || ''));

const isExConsentBlock = (fs, question) => {
  if (!isElement(fs)) return false;
  const txt = `${question} ${cleanText(fs.innerText || '')}`;
  return /privacy|consent|certif|acknowledg|background check|credit check|personal information/i.test(txt) && txt.length > 120;
};

const getExOptionLabel = (input) =>
  cleanText(input.closest('label')?.innerText) ||
  cleanText((input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.innerText) || '') ||
  cleanText(input.value);

const isExFakeCombo = (el) => {
  if (!isElement(el)) return false;
  const role = (el.getAttribute('role') || '').toLowerCase();
  const popup = (el.getAttribute('aria-haspopup') || '').toLowerCase();
  return role === 'combobox' || popup === 'listbox';
};

function isRealQuestionField(el) {
  if (!isElement(el) || !isVisible(el)) return false;
  if (el.disabled || el.readOnly) return false;
  const tag  = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const allowed = ['input', 'textarea', 'select'].includes(tag) || isExFakeCombo(el);
  if (!allowed) return false;
  if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) return false;
  const blob = [
    findExLabel(el), el.getAttribute('name'), el.id,
    el.getAttribute('placeholder'), el.getAttribute('data-testid'),
  ].join(' ').toLowerCase();
  return !EX_JUNK.some(w => blob.includes(w));
}

function exDomSnapshot(el, container) {
  return {
    selector:        cssPath(el),
    id:              el.id || '',
    name:            el.getAttribute('name') || el.name || '',
    role:            el.getAttribute('role') || '',
    placeholder:     el.getAttribute('placeholder') || '',
    ariaInvalid:     el.getAttribute('aria-invalid') || '',
    autocomplete:    el.getAttribute('autocomplete') || '',
    inputMode:       el.getAttribute('inputmode') || '',
    visible:         isVisible(el),
    disabled:        !!el.disabled,
    readOnly:        !!el.readOnly,
  };
}

// ── Harvesters ─────────────────────────────────────────────────────────────

function collectRadioGroup(el) {
  const name = el.name;
  if (!name) return null;
  const group = Array.from(document.querySelectorAll(
    `input[type="radio"][name="${CSS.escape(name)}"]`
  )).filter(isRealQuestionField);
  if (!group.length) return null;
  const first     = group[0];
  const container = getExQuestionContainer(first);
  const question  = getExLegendText(getExFieldset(first)) || getExQuestionText(first) || findExLabel(first);
  if (!question || question.length < 5) return null;
  const options = group.map(r => ({
    label:    getExOptionLabel(r),
    value:    r.value || '',
    checked:  !!r.checked,
    selector: cssPath(r),
    id:       r.id || '',
    name:     r.name || '',
  }));
  return {
    question, type: 'radio', tag: 'input',
    required: isExRequired(first, question),
    answer:   options.find(o => o.checked)?.label || '',
    options,
    dom:              exDomSnapshot(first, container),
    section:          getExSection(first),
    validationMessage: getExValidationMessage(first),
    targets: group.map(r => ({ selector: cssPath(r), id: r.id || '', name: r.name || '', tag: 'input', type: 'radio' })),
  };
}

function collectCheckboxGroup(el) {
  const name = el.name;
  if (!name) return null;
  const group = Array.from(document.querySelectorAll(
    `input[type="checkbox"][name="${CSS.escape(name)}"]`
  )).filter(isRealQuestionField);
  if (!group.length) return null;
  const first     = group[0];
  const container = getExQuestionContainer(first);
  const fs        = getExFieldset(first);
  const question  = getExLegendText(fs) || getExQuestionText(first) || findExLabel(first);
  if (!question || question.length < 5) return null;
  const consent   = isExConsentBlock(fs, question);
  const options = group.map(c => ({
    label:    getExOptionLabel(c),
    value:    c.value || '',
    checked:  !!c.checked,
    selector: cssPath(c),
    id:       c.id || '',
    name:     c.name || '',
  }));
  return {
    question, type: consent ? 'consent_checkbox_group' : 'checkbox_group', tag: 'input',
    required: group.some(i => i.required) || isExRequired(first, question),
    answer:   options.filter(o => o.checked).map(o => o.label || o.value),
    options,
    dom:              exDomSnapshot(first, container),
    section:          getExSection(first),
    validationMessage: getExValidationMessage(first),
    targets: group.map(c => ({ selector: cssPath(c), id: c.id || '', name: c.name || '', tag: 'input', type: 'checkbox' })),
  };
}

function collectNativeSelect(el) {
  const question  = findExLabel(el);
  const container = getExQuestionContainer(el);
  const options = Array.from(el.options)
    .map((o, idx) => ({ index: idx, label: cleanText(o.textContent), value: o.value, selected: o.selected }))
    .filter(o => o.label || o.value);
  return {
    question, type: 'select', tag: 'select',
    required: isExRequired(el, question),
    answer:   el.value || '',
    options,
    dom:              exDomSnapshot(el, container),
    section:          getExSection(el),
    validationMessage: getExValidationMessage(el),
    targets: [{ selector: cssPath(el), id: el.id || '', name: el.name || '', tag: 'select', type: 'select' }],
  };
}

function collectFakeCombobox(el) {
  const question  = findExLabel(el);
  const container = getExQuestionContainer(el);
  const options = Array.from(container.querySelectorAll('[role="option"], option'))
    .map((n, idx) => ({
      index: idx,
      label: cleanText(n.innerText || n.textContent || ''),
      value: n.getAttribute('data-value') || n.getAttribute('value') || cleanText(n.innerText || n.textContent || ''),
      selected: n.getAttribute('aria-selected') === 'true',
    })).filter(o => o.label || o.value);
  return {
    question, type: 'select', tag: el.tagName.toLowerCase(),
    required: isExRequired(el, question),
    answer:   cleanText(el.innerText || el.textContent || '') || el.getAttribute('aria-label') || '',
    options,
    dom:              exDomSnapshot(el, container),
    section:          getExSection(el),
    validationMessage: getExValidationMessage(el),
    targets: [{ selector: cssPath(el), id: el.id || '', name: el.getAttribute('name') || '', tag: el.tagName.toLowerCase(), type: 'select' }],
  };
}

function looksNumericField(el, question) {
  const type = (el.getAttribute('type') || '').toLowerCase();
  const min = el.getAttribute('min'), max = el.getAttribute('max'), step = el.getAttribute('step');
  if (type === 'number') return true;
  if (/how many|years of|experience|amount|salary/i.test(question || '')) return true;
  if ((min && !Number.isNaN(Number(min))) || (max && !Number.isNaN(Number(max)))) return true;
  if (step && step !== 'any' && !Number.isNaN(Number(step))) return true;
  const validMsg = getExValidationMessage(el).toLowerCase();
  if (/valid number|no decimals|must be a number|enter a number|numeric/i.test(validMsg)) return true;
  return false;
}

function collectSingleField(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'select')    return collectNativeSelect(el);
  if (isExFakeCombo(el))   return collectFakeCombobox(el);
  const type     = (el.getAttribute('type') || '').toLowerCase();
  const question = findExLabel(el);
  const container = getExQuestionContainer(el);
  if (!question || question.length < 3) return null;
  let fieldType = type || tag;
  if ((fieldType === 'text' || fieldType === 'textarea' || fieldType === 'input') && looksNumericField(el, question))
    fieldType = 'number';
  return {
    question, type: fieldType, tag,
    required: isExRequired(el, question),
    answer:   ('value' in el ? el.value : '') || '',
    options:  [],
    dom:              exDomSnapshot(el, container),
    section:          getExSection(el),
    validationMessage: getExValidationMessage(el),
    targets: [{ selector: cssPath(el), id: el.id || '', name: el.name || '', tag, type: type || tag }],
  };
}

function attachOtherFollowups(fields) {
  const out = [];
  for (const field of fields) {
    const q = (field.question || '').toLowerCase().trim();
    const isOther = /^other:?$/.test(q) || q.includes('please specify');
    if (isOther && out.length) {
      const parent = out[out.length - 1];
      if (parent && ['radio', 'checkbox_group', 'consent_checkbox_group', 'select'].includes(parent.type)) {
        if (!parent.followups) parent.followups = [];
        parent.followups.push({ question: field.question, type: field.type, answer: field.answer, dom: field.dom, targets: field.targets });
        continue;
      }
    }
    out.push(field);
  }
  return out;
}

// ── Auto-click consent checkboxes ───────────────────────────────────────────

function autoClickConsentCheckboxes() {
  document.querySelectorAll('input[type="checkbox"]').forEach(el => {
    if (!isVisible(el) || el.checked) return;
    const label = getLabelText(el) || '';
    if (/consent|agree|understand|authorize|accept|confirm/i.test(label)) el.click();
  });
}

// ── Main field collector ────────────────────────────────────────────────────

function collectFields() {
  autoClickConsentCheckboxes();

  const nodes = Array.from(document.querySelectorAll(
    'input, textarea, select, [role="combobox"], [aria-haspopup="listbox"]'
  )).filter(isRealQuestionField);

  const seen   = new Set();
  const fields = [];

  for (const el of nodes) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    const name = el.getAttribute('name') || '';
    let field  = null;

    if (type === 'radio') {
      const key = `radio:${name || cssPath(el)}`;
      if (seen.has(key)) continue;
      field = collectRadioGroup(el);
      if (field) seen.add(key);
    } else if (type === 'checkbox') {
      const key = `checkbox:${name || cssPath(el)}`;
      if (seen.has(key)) continue;
      field = collectCheckboxGroup(el);
      if (field) seen.add(key);
    } else {
      const key = `${el.tagName.toLowerCase()}:${el.id || name || cssPath(el)}`;
      if (!key || seen.has(key)) continue;
      field = collectSingleField(el);
      if (field) seen.add(key);
    }

    if (field) fields.push(field);
  }

  return attachOtherFollowups(fields);
}

// ── Selector-based fill ─────────────────────────────────────────────────────

function resolveElement(target) {
  if (!target) return null;
  let el = null;
  if (target.selector) {
    try { el = document.querySelector(target.selector); } catch (_) {}
  }
  if (!el && target.name) {
    try { el = document.querySelector(`[name="${CSS.escape(target.name)}"]`); } catch (_) {}
  }
  if (!el && target.id) {
    try { el = document.getElementById(target.id); } catch (_) {}
  }
  return el || null;
}

// ── Fix 4: Safe field label extractor ──────────────────────────────────────
// field.question or field.label could be a non-string if field construction went
// wrong (e.g. a DOM node or options array leaked in). Always returns a plain string.
function getFieldLabel(field) {
  const raw = field.question || field.label || '';
  return typeof raw === 'string' ? raw : String(raw && typeof raw === 'object' && raw.innerText ? raw.innerText : '');
}

// ── FIX 2: Range-aware findExMatchingOption ─────────────────────────────────

function findExMatchingOption(field, answer) {
  const raw        = String(answer || '').trim();
  const normalized = raw.toLowerCase();
  if (!normalized) return null;

  const opts = field.options || [];

  // 1. Exact case-insensitive match
  const exact = opts.find(o => String(o.label || '').trim().toLowerCase() === normalized);
  if (exact) return exact;

  // 2. Normalized match (strip punctuation/currency symbols)
  const normAnswer = normalizeText(raw);
  const normExact  = opts.find(o => normalizeText(String(o.label || '')) === normAnswer);
  if (normExact) return normExact;

  // 3. Partial substring match (either direction)
  const partial = opts.find(o => {
    const l = String(o.label || '').trim().toLowerCase();
    return l.includes(normalized) || normalized.includes(l);
  });
  if (partial) return partial;

  // 4. Normalized partial match
  const normPartial = opts.find(o => {
    const l = normalizeText(String(o.label || ''));
    return l.includes(normAnswer) || normAnswer.includes(l);
  });
  if (normPartial) return normPartial;

  // 5. FIX: Range-aware numeric match
  // Answer is a number (e.g. "3" from estimateExperienceYears).
  // Find the option whose range contains that number.
  // Handles: "1 to 2 years", "3 - 5 years", "Less than 1 year", "6+ years", "10 or more"
  const answerNum = parseFloat(raw);
  if (!isNaN(answerNum)) {
    // "Less than 1" / "Under 1" / "0-1" → match if answerNum < 1
    const lessThanOne = opts.find(o =>
      /less\s+than\s+1|under\s+1|0\s*[-–]\s*1\s+year|fewer\s+than\s+1/i.test(String(o.label || ''))
    );
    if (lessThanOne && answerNum < 1) return lessThanOne;

    // Ceiling / "N+" bucket and range buckets
    let bestCeiling = null;
    let bestCeilingThreshold = -Infinity;
    let bestRange = null;

    for (const o of opts) {
      const label = String(o.label || '');

      // "N+ years" / "More than N" / "N or more"
      const moreMatch = label.match(/(\d+)\s*\+|\bmore\s+than\s+(\d+)|\b(\d+)\s+or\s+more/i);
      if (moreMatch) {
        const threshold = parseInt(moreMatch[1] || moreMatch[2] || moreMatch[3], 10);
        if (answerNum >= threshold && threshold >= bestCeilingThreshold) {
          bestCeilingThreshold = threshold;
          bestCeiling = o;
        }
        continue;
      }

      // Range: "N to M", "N - M", "N–M"
      const nums = label.match(/\d+/g);
      if (!nums || nums.length < 2) continue;
      const lo = Math.min(...nums.map(Number));
      const hi = Math.max(...nums.map(Number));
      if (answerNum >= lo && answerNum <= hi) {
        // Prefer narrower ranges (smaller hi - lo)
        if (!bestRange || (hi - lo) < (bestRange._hi - bestRange._lo)) {
          bestRange = { o, _lo: lo, _hi: hi };
        }
      }
    }

    if (bestRange) return bestRange.o;
    if (bestCeiling) return bestCeiling;

    // Single-number options (e.g. "3 years") — match closest within ±2
    let closestOpt = null;
    let closestDiff = Infinity;
    for (const o of opts) {
      const nums = (String(o.label || '').match(/\d+/g) || []).map(Number);
      if (nums.length !== 1) continue;
      const diff = Math.abs(nums[0] - answerNum);
      if (diff < closestDiff) { closestDiff = diff; closestOpt = o; }
    }
    if (closestOpt && closestDiff <= 2) return closestOpt;
  }

  // 6. FIX: Word-overlap fallback — only words longer than 3 chars to reduce noise
  // (filters out "to", "of", "the", "for", etc.)
  const answerWords = new Set(normalized.split(/\W+/).filter(w => w.length > 3));
  if (answerWords.size > 0) {
    let bestOpt = null;
    let bestScore = 0;
    for (const o of opts) {
      const optWords = String(o.label || '').toLowerCase().split(/\W+/).filter(Boolean);
      const score = optWords.filter(w => answerWords.has(w)).length;
      if (score > bestScore) { bestScore = score; bestOpt = o; }
    }
    if (bestOpt && bestScore >= 1) return bestOpt;
  }

  return null;
}

function setExInputValue(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) { setter.call(el, ''); setter.call(el, value); } else { el.value = value; }
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur',   { bubbles: true }));
}

async function applyAnswerToField(field, answer) {
  if (!answer && answer !== 0) return false;
  if (answer === '__SKIP__') return false;

  const mainTarget = field.targets?.[0];
  if (!mainTarget) return false;

  const type = field.type;

  // text / textarea / number
  if (['text', 'textarea', 'number', 'email', 'tel', 'url'].includes(type)) {
    const el = resolveElement(mainTarget);
    if (!el) return false;
    setExInputValue(el, String(answer));
    return true;
  }

  // radio
  if (type === 'radio') {
    const match = findExMatchingOption(field, answer);
    if (match?.selector) {
      let el = null;
      try { el = document.querySelector(match.selector); } catch (_) {}

      if (!el && match.name) {
        el = Array.from(
          document.querySelectorAll(`input[type="radio"][name="${CSS.escape(match.name)}"]`)
        ).find(r => r.value === match.value) || null;
      }

      if (el) {
        if (!el.checked) el.click();
        return true;
      }
    }

    const qLower = getFieldLabel(field).toLowerCase();
    const radioOptPairs = (field.options || []).map(opt => {
      let el = null;

      try { el = opt.selector ? document.querySelector(opt.selector) : null; } catch (_) {}
      if (!el && opt.id) {
        try { el = document.getElementById(opt.id); } catch (_) {}
      }
      if (!el && opt.name && opt.value !== undefined) {
        el = Array.from(
          document.querySelectorAll(`input[type="radio"][name="${CSS.escape(opt.name)}"]`)
        ).find(r => r.value === opt.value) || null;
      }

      return el ? [el, opt.label || ''] : null;
    }).filter(Boolean);

    if (radioOptPairs.length) {
      const ruleEl = pickChoiceByRules(qLower, radioOptPairs);
      if (ruleEl) {
        if (!ruleEl.checked) ruleEl.click();
        return true;
      }
    }

    console.warn('[QuickFill] Radio no match:', {
      question: getFieldLabel(field) || '(unknown)',
      answer,
      options: (field.options || []).slice(0, 5).map(o =>
        typeof o === 'string' ? o : String(o.label || o.value || '(opt)')
      ),
    });
    return false;
  }

  // ── FIX 3: select with experience-select belt-and-suspenders fallback ──
  if (type === 'select') {
    const el = resolveElement(mainTarget);
    if (!el) return false;

    // Country/phone-code alias normalization
    const countryAliases = {
      canada: 'CA',
      'united states': 'US',
      usa: 'US',
    };

    const answerNorm = String(answer || '').toLowerCase().trim();
    if (countryAliases[answerNorm]) {
      const code = countryAliases[answerNorm];
      const aliasMatch = (field.options || []).find(o =>
        String(o.value || '').toUpperCase().startsWith(code) ||
        String(o.label || '').toLowerCase().includes(answerNorm)
      );

      if (aliasMatch) {
        el.value = aliasMatch.value !== undefined ? aliasMatch.value : aliasMatch.label;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
        return true;
      }
    }

    let match = findExMatchingOption(field, answer);

    // FIX 3: experience-select fallback — if no match and question is about years,
    // try passing just the numeric value through range matching directly.
    if (!match && /how many years|years of (relevant |work |related )?experience/i.test(
      getFieldLabel(field)
    )) {
      const num = parseFloat(String(answer));
      if (!isNaN(num)) {
        match = findExMatchingOption(field, String(num));
      }
    }

    if (!match) {
      console.warn('[QuickFill] Select no match:', {
        label: getFieldLabel(field) || '(unknown)',
        answer,
        options: (field.options || []).slice(0, 8).map(o =>
          typeof o === 'string' ? o : String(o.label || o.value || '(opt)')
        ),
      });
      return false;
    }

    el.value = match.value !== undefined ? match.value : match.label;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }

  // checkbox_group / consent_checkbox_group
  if (type === 'checkbox_group' || type === 'consent_checkbox_group') {
    const answers = Array.isArray(answer) ? answer : [answer];
    let success = false;

    const effectiveAnswers = answers.length
      ? answers
      : (() => {
          const generalOpt = (field.options || []).find(o =>
            /general|broad|basic|all|management|operations/i.test(o.label || '')
          );
          const lastOpt = field.options?.[field.options.length - 1];
          return [(generalOpt || lastOpt)?.label].filter(Boolean);
        })();

    for (const a of effectiveAnswers) {
      const match = findExMatchingOption(field, a);
      if (!match) continue;

      let el = null;
      try { el = match.selector ? document.querySelector(match.selector) : null; } catch (_) {}

      if (!el && match.name) {
        el = Array.from(
          document.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(match.name)}"]`)
        ).find(c => c.value === match.value) || null;
      }

      if (el && !el.checked) {
        el.click();
        success = true;
      }
    }

    return success;
  }

  return false;
}

// ── FIX 1: AI field mapping — tag experience selects as 'number' ────────────

function mapExtractedFieldForAI(field) {
  const mainTarget = field.targets?.[0] || {};

  const labelText = String(field.question || field.label || '');

  // FIX 1: if a select's label looks like an experience/years question, mark it
  // as 'number' so rules.js resolveRuleField → estimateExperienceYears() handles it.
  // The returned number string then goes through findExMatchingOption's range-aware
  // step 5 to correctly match labels like "3 to 5 years".
  const looksLikeExperienceSelect =
    field.type === 'select' &&
    /how many years|years of (relevant |work |related )?experience|years have you|amount of experience/i.test(labelText);

  return {
    label: labelText,
    name: mainTarget.name || field.dom?.name || '',
    placeholder: field.dom?.placeholder || '',
    // FIX 1: coerce experience selects to 'number' so rules.js intercepts them
    type: looksLikeExperienceSelect ? 'number' : (field.type || ''),
    tag: field.tag || mainTarget.tag || '',
    options: (field.options || [])
      .map(o => (typeof o === 'string' ? o : (o.label || o.value || '')))
      .filter(Boolean),
    currentValue: (Array.isArray(field.answer) ? field.answer.join(', ') : field.answer) || '',
    required: !!field.required,
    section: field.section || '',
    validationMsg: field.validationMessage || '',
    domRole: field.dom?.role || '',
    ariaInvalid: field.dom?.ariaInvalid || '',
    _pageUrl: location.pathname,
    // Preserve original type so applyAnswerToField uses the right fill path
    // (applyAnswerToField receives fields[i] which has the original collected type,
    //  not the AI-mapped version, so no change is needed there)
    _originalType: field.type || '',
  };
}

// ─── Standard field harvest ────────────────────────────────────────────────

function harvestFields() {
  const fields = [];
  const seen   = new Set();

  // ── Text / number / email / tel / date / url inputs ──
  document.querySelectorAll(
    'input[type="text"], input[type="number"], input[type="email"], input[type="tel"], ' +
    'input[type="date"], input[type="url"], input:not([type])'
  ).forEach(el => {
    if (!isVisible(el) || seen.has(el)) return;
    seen.add(el);
    let label = getLabelText(el);
    if (!label || label.length < 2) label = getIndeedQuestionText(el);
    if (!label || label.length < 2) return;
    fields.push({
      id:           uniqueId(el),
      tag:          'input-text',
      type:         el.type || 'text',
      name:         el.name || el.id || '',
      label,
      placeholder:  el.getAttribute('placeholder') || '',
      options:      [],
      currentValue: el.value || '',
    });
  });

  // ── Textareas ──
  document.querySelectorAll('textarea').forEach(el => {
    if (!isVisible(el) || seen.has(el)) return;
    seen.add(el);
    let label = getLabelText(el) || el.getAttribute('placeholder') || el.name || '';
    if (!label || label.length < 2) label = getIndeedQuestionText(el);
    if (!label || label.length < 2) return;
    fields.push({
      id:           uniqueId(el),
      tag:          'textarea',
      type:         'textarea',
      name:         el.name || el.id || '',
      label,
      placeholder:  el.getAttribute('placeholder') || '',
      options:      [],
      currentValue: el.value || '',
    });
  });

  // ── Selects ──
  document.querySelectorAll('select').forEach(el => {
    if (!isVisible(el) || seen.has(el)) return;
    seen.add(el);
    let label = getLabelText(el) || el.name || '';
    if (!label || label.length < 2) label = getIndeedQuestionText(el);
    const opts = Array.from(el.options)
      .filter(o => o.value || o.text.trim())
      .map(o => o.text.trim()).filter(Boolean);
    if (!label || label.length < 2 || opts.length === 0) return;
    fields.push({
      id:           uniqueId(el),
      tag:          'select',
      type:         'select',
      name:         el.name || el.id || '',
      label,
      options:      opts,
      currentValue: el.options[el.selectedIndex]?.text || '',
    });
  });

  // ── Comboboxes ──
  document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"]').forEach(el => {
    if (!isVisible(el) || seen.has(el)) return;
    if (el.tagName === 'SELECT') return;
    const label =
      getLabelText(el)                           ||
      getIndeedQuestionText(el)                  ||
      getLabelText(getQuestionContainer(el))     ||
      '';
    if (!label || label.length < 2) return;
    const currentValue =
      el.getAttribute('aria-valuetext') ||
      el.getAttribute('value')          ||
      el.innerText || '';
    fields.push({
      id:           uniqueId(el),
      tag:          'combobox',
      type:         'combobox',
      name:         el.getAttribute('name') || el.id || '',
      label,
      placeholder:  el.getAttribute('placeholder') || '',
      options:      [],
      currentValue: currentValue.trim(),
    });
    seen.add(el);
  });

  // ── Native radio groups (fieldset / name based) ──
  const radioGroups = {};
  document.querySelectorAll('input[type="radio"]').forEach(el => {
    if (!isVisible(el)) return;
    const groupKey = el.name || el.closest('fieldset')?.id || el.id || '';
    if (!groupKey) return;
    if (!radioGroups[groupKey]) radioGroups[groupKey] = [];
    radioGroups[groupKey].push(el);
  });

  Object.entries(radioGroups).forEach(([groupName, radios]) => {
    if (radios.some(r => r.checked)) return;
    const first  = radios[0];
    const legend = getFieldsetLegend(first);
    const label  = legend || getLabelText(first) || getIndeedQuestionText(first) || groupName;
    const opts   = radios.map(r => {
      const rid = r.id;
      const lbl = rid ? document.querySelector(`label[for="${CSS.escape(rid)}"]`) : null;
      return ((lbl ? lbl.innerText.trim() : r.value) || r.value || '').trim();
    }).filter(Boolean);
    fields.push({
      id:           'radio::' + groupName,
      tag:          'radio',
      type:         'radio',
      name:         groupName,
      label,
      options:      opts,
      currentValue: '',
    });
  });

  // ── Custom radiogroups (ARIA role="radiogroup") ──
  document.querySelectorAll('[role="radiogroup"], [role="group"]').forEach(group => {
    if (!isVisible(group) || seen.has(group)) return;
    const radioOpts = getRadioLikeOptions(group);
    if (radioOpts.length < 2) return;
    const hasAriaRadio   = group.querySelector('[role="radio"]');
    const hasNativeRadio = group.querySelector('input[type="radio"]');
    if (!hasAriaRadio && !hasNativeRadio) return;
    const checked = group.querySelector('[role="radio"][aria-checked="true"], input[type="radio"]:checked');
    if (checked) return;
    const label =
      getFieldsetLegend(group)                   ||
      getLabelText(group)                        ||
      getIndeedQuestionText(group)               ||
      getLabelText(getQuestionContainer(group))  ||
      '';
    if (!label || label.length < 2) return;
    const groupName = uniqueId(group);
    group.dataset.qfName = groupName;
    fields.push({
      id:           'customradio::' + groupName,
      tag:          'custom-radio',
      type:         'custom-radio',
      name:         groupName,
      label,
      options:      radioOpts.map(x => x.text),
      currentValue: '',
    });
    seen.add(group);
  });

  // ── Auto-click consent checkboxes ──
  document.querySelectorAll('input[type="checkbox"]').forEach(el => {
    if (!isVisible(el) || el.checked || seen.has(el)) return;
    seen.add(el);
    const label = getLabelText(el) || '';
    if (/consent|agree|understand|authorize|accept|confirm/i.test(label)) {
      el.click();
    }
  });

  // ── Indeed-specific harvesting ──
  if (isIndeedPage() || isSmartApplyPage()) {
    const namedRadios = harvestIndeedNamedRadioGroups(seen);
    for (const nf of namedRadios) {
      const exists = fields.findIndex(f => f.id === nf.id);
      if (exists >= 0) fields[exists] = nf;
      else fields.push(nf);
    }

    const namedCheckboxGroups = harvestIndeedNamedCheckboxGroups(seen);
    for (const cf of namedCheckboxGroups) {
      const exists = fields.findIndex(f => f.id === cf.id);
      if (exists >= 0) fields[exists] = cf;
      else fields.push(cf);
    }

    const containerFields = harvestIndeedContainerFields(seen);
    for (const cf of containerFields) {
      const exists = fields.findIndex(f => f.id === cf.id || f.name === cf.name);
      if (exists < 0) fields.push(cf);
    }
  }

  return fields;
}

// ─── Native fill ───────────────────────────────────────────────────────────

function fillNative(el, value) {
  el.focus();
  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value');
  if (nativeSetter && nativeSetter.set) {
    nativeSetter.set.call(el, '');
    nativeSetter.set.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: value }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur',   { bubbles: true }));
  try {
    const fiberKey = Object.keys(el).find(
      k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
    );
    if (fiberKey) {
      let fiber = el[fiberKey];
      while (fiber) {
        const props = fiber.memoizedProps || (fiber.stateNode && fiber.stateNode.props);
        if (props && typeof props.onChange === 'function') {
          props.onChange({ target: el, currentTarget: el, bubbles: true });
          break;
        }
        fiber = fiber.return;
      }
    }
  } catch (_) {}
}

async function dispatchInputEvents(el) {
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur',   { bubbles: true }));
  await sleep(120);
}

async function clearAndType(el, value) {
  el.focus();

  if (el.tagName === 'SELECT') {
    const options = [...el.options];
    const target  = String(value || '').trim().toLowerCase();
    let match = options.find(o => o.textContent.trim().toLowerCase() === target);
    if (!match) match = options.find(o => o.textContent.trim().toLowerCase().includes(target));
    if (!match) return false;
    el.value = match.value;
    await dispatchInputEvents(el);
    return true;
  }

  if (el.type === 'checkbox') {
    const desired = /^(true|yes|1)$/i.test(String(value || '').trim());
    if (el.checked !== desired) el.click();
    await sleep(80);
    return true;
  }

  if (el.type === 'radio') {
    const group  = document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name || '')}"]`);
    const wanted = String(value || '').trim().toLowerCase();
    for (const radio of group) {
      const label =
        normalizeText(radio.value) + ' ' +
        normalizeText(document.querySelector(`label[for="${radio.id}"]`)?.textContent || '') + ' ' +
        normalizeText(radio.closest('label')?.textContent || '');
      if (label.toLowerCase().includes(wanted)) {
        radio.click();
        await sleep(80);
        return true;
      }
    }
    return false;
  }

  el.value = '';
  await dispatchInputEvents(el);
  el.value = String(value || '');
  await dispatchInputEvents(el);
  return true;
}

// ─── applyAnswer ───────────────────────────────────────────────────────────

async function applyAnswer(field, answer) {
  if (!answer || answer === '__SKIP__') return false;

  // ── Checkbox-group handler ──────────────────────────────────────────────
  if (field.tag === 'checkbox-group') {
    const boxes = Array.from(document.querySelectorAll(
      `input[type="checkbox"][name="${CSS.escape(field.name)}"]`
    ));

    if (!boxes.length) return false;

    const options = boxes.map(b => {
      const bid     = b.getAttribute('id') || '';
      const lblEl   = bid ? document.querySelector(`label[for="${CSS.escape(bid)}"]`) : null;
      const wrapLbl = b.closest('label');
      const text = (
        (lblEl   ? lblEl.innerText.trim()   : '') ||
        (wrapLbl ? wrapLbl.innerText.trim() : '') ||
        b.getAttribute('value') || ''
      ).trim();
      return [b, text];
    }).filter(([, t]) => t);

    if (!options.length) return false;

    const qLower = (field.label || '').toLowerCase();

    // 1. Rule-based single choice
    const ruleChoice = pickChoiceByRules(qLower, options);
    if (ruleChoice) {
      for (const [box] of options) {
        if (box !== ruleChoice && box.checked) box.click();
      }
      if (!ruleChoice.checked) ruleChoice.click();
      await sleep(100);
      return true;
    }

    // 2. Comma-separated multi-answer strings from AI
    const rawAnswers = String(answer).split(',').map(a => normalizeText(a.trim())).filter(Boolean);

    if (rawAnswers.length > 1) {
      const chosenBoxes = new Set();
      for (const [box, text] of options) {
        const t = normalizeText(text);
        if (rawAnswers.some(ans => t === ans || t.includes(ans) || ans.includes(t))) {
          chosenBoxes.add(box);
        }
      }
      if (chosenBoxes.size) {
        for (const [box] of options) {
          const shouldCheck = chosenBoxes.has(box);
          if (box.checked !== shouldCheck) box.click();
        }
        await sleep(100);
        return true;
      }
    }

    // 3. Single-answer text match
    const ans = normalizeText(answer);
    let chosen = null;
    for (const [box, text] of options) {
      const t = normalizeText(text);
      if (t === ans || t.includes(ans) || ans.includes(t)) {
        chosen = box;
        break;
      }
    }

    // 4. Simple Yes/No fallback
    if (!chosen && /^(yes|true|1)$/i.test(String(answer).trim())) {
      chosen = options.find(([, text]) => /^(yes|oui|true)$/i.test(text.trim()))?.[0] || null;
    }
    if (!chosen && /^(no|false|0)$/i.test(String(answer).trim())) {
      chosen = options.find(([, text]) => /^(no|non|false)$/i.test(text.trim()))?.[0] || null;
    }

    // 5. Last resort: first option
    if (!chosen && options.length) chosen = options[0][0];

    for (const [box] of options) {
      if (box !== chosen && box.checked) box.click();
    }
    if (chosen && !chosen.checked) chosen.click();

    await sleep(100);
    return true;
  }

  // ── Named radio (Indeed q_{hash} pattern) ──────────────────────────────
  if (field.tag === 'radio') {
    const radios = document.querySelectorAll(
      `input[type="radio"][name="${CSS.escape(field.name)}"]`
    );

    if (radios.length) {
      const options = Array.from(radios).map(r => {
        const rid  = r.id;
        const lbl  = rid ? document.querySelector(`label[for="${CSS.escape(rid)}"]`) : null;
        const text = ((lbl ? lbl.innerText.trim() : r.value) || '').trim();
        return [r, text];
      }).filter(([, t]) => t);

      const qLower     = (field.label || '').toLowerCase();
      const ruleChoice = pickChoiceByRules(qLower, options);
      if (ruleChoice) {
        if (!ruleChoice.checked) ruleChoice.click();
        return true;
      }
    }

    const ans = normalizeText(answer);
    for (const r of radios) {
      const rid  = r.id;
      const lbl  = rid ? document.querySelector(`label[for="${CSS.escape(rid)}"]`) : null;
      const text = normalizeText((lbl ? lbl.innerText.trim() : r.value) || '');
      if (text === ans || text.includes(ans) || ans.includes(text)) {
        if (!r.checked) r.click();
        return true;
      }
    }

    if (radios.length > 0 && !radios[0].checked) radios[0].click();
    return true;
  }

  // ── Custom radio (ARIA role="radio") ──────────────────────────────────
  if (field.tag === 'custom-radio') {
    const container = findCustomRadioGroupByName(field.name);
    const radioOpts = getRadioLikeOptions(container);
    const ans = normalizeText(answer);
    for (const item of radioOpts) {
      const txt = normalizeText(item.text);
      if (txt === ans || txt.includes(ans) || ans.includes(txt)) {
        clickElement(item.el);
        await sleep(100);
        return true;
      }
    }
    if (radioOpts.length) { clickElement(radioOpts[0].el); await sleep(100); return true; }
    return false;
  }

  // ── Locate target element ──────────────────────────────────────────────
  let target = document.querySelector(`[data-__qf-id="${CSS.escape(field.id)}"]`) || null;

  if (!target && field.name) {
    const tag =
      field.tag === 'textarea' ? 'textarea'                              :
      field.tag === 'select'   ? 'select'                                :
      field.tag === 'combobox' ? '[role="combobox"], [aria-haspopup="listbox"]' :
      'input';
    try { target = document.querySelector(`${tag}[name="${CSS.escape(field.name)}"]`); } catch (_) {}
  }

  if (!target && field.placeholder) {
    target = Array.from(
      document.querySelectorAll('input, textarea, [role="combobox"], [aria-haspopup="listbox"]')
    ).find(e => (e.getAttribute('placeholder') || '').trim() === field.placeholder) || null;
  }

  if (!target && field.label) {
    const allCombos = Array.from(
      document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"]')
    ).filter(isVisible);
    target = allCombos.find(e => {
      const lbl = normalizeText(
        getLabelText(e) || getIndeedQuestionText(e) || getLabelText(getQuestionContainer(e)) || ''
      );
      return lbl && (lbl === normalizeText(field.label) || lbl.includes(normalizeText(field.label)));
    }) || null;
  }

  if (!target) {
    console.warn('[QuickFill] Could not find element:', field.label, '| id:', field.id, '| name:', field.name);
    return false;
  }

  // ── Select ──
  if (field.tag === 'select') {
    const ans  = normalizeText(answer);
    const opts = Array.from(target.options);
    let match  = opts.find(o => normalizeText(o.text || '') === ans);
    if (!match) match = opts.find(o => {
      const t = normalizeText(o.text || '');
      return t.includes(ans) || ans.includes(t);
    });
    if (!match && /\b(country|pays)\b/i.test(`${field.label || ''} ${field.name || ''}`)) {
      const wantedCountry = normalizeText(answer);
      match = opts.find(o => normalizeText(o.text || '').includes(wantedCountry));
    }
    if (match) {
      target.value = match.value;
      target.dispatchEvent(new Event('input',  { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      target.dispatchEvent(new Event('blur',   { bubbles: true }));
      return true;
    }
    console.warn('[QuickFill] Select match failed:', { label: field.label, answer, options: opts.map(o => o.text) });
    return false;
  }

  // ── Combobox ──
  if (field.tag === 'combobox') {
    return await chooseComboboxOption(target, answer);
  }

  // ── Text / textarea ──
  fillNative(target, answer);
  return true;
}

// ─── Validation helpers ────────────────────────────────────────────────────

function getFieldContainer(el) {
  return (
    el.closest('[data-testid], .ia-BasePage-component, .artdeco-inline-feedback') ||
    el.closest('div, fieldset, li, section, form')                                ||
    el.parentElement
  );
}

function getValidationState(el) {
  if (!el) return { isInvalid: false, errorText: '' };
  const container = getFieldContainer(el);

  const ariaInvalid =
    el.getAttribute('aria-invalid') === 'true' ||
    el.getAttribute('data-invalid')  === 'true';

  const nativeInvalid =
    typeof el.checkValidity === 'function' ? !el.checkValidity() : false;

  const invalidClass =
    el.matches('.invalid, .error, .is-invalid, [data-invalid="true"]') ||
    !!container?.querySelector('.invalid, .error, .is-invalid, [data-invalid="true"]');

  const errorNode = container?.querySelector([
    '[role="alert"]',
    '.error', '.errors', '.error-text',
    '.invalid-feedback', '.help-block',
    '.artdeco-inline-feedback__message',
    '[aria-live="polite"]', '[aria-live="assertive"]',
  ].join(', '));

  const errorText = String(errorNode?.textContent || '').replace(/\s+/g, ' ').trim();

  return {
    isInvalid: !!(ariaInvalid || nativeInvalid || invalidClass || errorText),
    errorText,
  };
}

// ─── Retry answer request ──────────────────────────────────────────────────

async function requestRetryAnswer(field, previousAnswer, validationError) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({
      action: 'RETRY_FIELD_ANSWER',
      field,
      previousAnswer,
      validationError,
    }, resp => {
      if (chrome.runtime.lastError || !resp?.ok) { resolve(null); return; }
      resolve(resp.answer || null);
    });
  });
}

async function fillFieldWithValidationRetry(field, answer, log) {
  if (!answer || answer === '__SKIP__') return { ok: false, skipped: true };

  const applied = await applyAnswer(field, answer);
  if (!applied) return { ok: false, reason: 'apply_failed' };

  await sleep(300);

  const el =
    document.querySelector(`[data-__qf-id="${CSS.escape(field.id)}"]`) ||
    (field.name
      ? document.querySelector(
          `input[name="${CSS.escape(field.name)}"], ` +
          `textarea[name="${CSS.escape(field.name)}"], ` +
          `select[name="${CSS.escape(field.name)}"]`
        )
      : null);

  if (!el || field.tag === 'radio' || field.tag === 'custom-radio' || field.tag === 'combobox' || field.tag === 'checkbox-group') {
    return { ok: true, retried: false };
  }

  let state = getValidationState(el);
  if (!state.isInvalid) return { ok: true, retried: false };

  if (log) {
    log.push(`⚠ Validation failed: "${field.label}"${state.errorText ? ` — ${state.errorText}` : ''}`);
    log.push(`⟳ Retrying: "${field.label}"`);
  }

  const retryAnswer = await requestRetryAnswer(field, answer, state.errorText);
  if (!retryAnswer || retryAnswer === '__SKIP__')
    return { ok: false, retried: true, reason: 'no_retry_answer', errorText: state.errorText };

  const reApplied = await clearAndType(el, retryAnswer);
  if (!reApplied)
    return { ok: false, retried: true, reason: 'retry_apply_failed', errorText: state.errorText };

  await sleep(300);
  state = getValidationState(el);
  if (!state.isInvalid) return { ok: true, retried: true };
  return { ok: false, retried: true, reason: 'still_invalid', errorText: state.errorText };
}

// ─── AI answer request ─────────────────────────────────────────────────────

async function requestAiAnswers(fields) {
  const serialisable = fields.map(f => {
    const { _indeedOptions, ...rest } = f;
    return rest;
  });
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'GET_AI_ANSWERS_ONLY', fields: serialisable }, res => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || 'Background script unreachable'));
        return;
      }
      if (!res) { reject(new Error('No response from background script')); return; }
      if (!res.ok) {
        console.warn('[QuickFill] GET_AI_ANSWERS_ONLY error:', res.error);
        resolve({ ok: false, answers: [], error: res.error });
        return;
      }
      resolve(res);
    });
  });
}

// ─── Step summary ──────────────────────────────────────────────────────────

function buildStepSummary(answers) {
  const counts = { profile: 0, rule: 0, ai: 0, skipped: 0, memory: 0, error: 0, timeout: 0 };
  for (const a of answers) {
    const src = (a.source || '').toLowerCase();
    if (src.includes('memory')) counts.memory++;
    else if (src === 'profile') counts.profile++;
    else if (src === 'rule')    counts.rule++;
    else if (src === 'ai')      counts.ai++;
    else if (src === 'skipped') counts.skipped++;
    else if (src === 'timeout') counts.timeout++;
    else if (src === 'error')   counts.error++;
    else counts.skipped++;
  }
  const parts = [];
  if (counts.profile) parts.push(`✅ ${counts.profile} profile`);
  if (counts.rule)    parts.push(`⚙️ ${counts.rule} rules`);
  if (counts.memory)  parts.push(`💾 ${counts.memory} memory`);
  if (counts.ai)      parts.push(`🤖 ${counts.ai} AI`);
  if (counts.timeout) parts.push(`⏱ ${counts.timeout} timeout`);
  if (counts.error)   parts.push(`❌ ${counts.error} error`);
  return parts.join(' ');
}

// ─── Flow state helpers ────────────────────────────────────────────────────

function reportProgress(state) {
  try { chrome.runtime.sendMessage({ action: 'REPORT_FLOW_PROGRESS', state }); } catch (_) {}
}

function isCancelledInStorage() {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get(['flowCancelled'], d => resolve(!!d.flowCancelled));
    } catch (_) { resolve(false); }
  });
}

function pushLog(log, msg) {
  const next = [...log, msg];
  return next.length > 10 ? next.slice(next.length - 10) : next;
}

// ─── Multi-step runner ─────────────────────────────────────────────────────
async function runMultiStepFlow(maxSteps = 12) {
  let totalFilled = 0;
  let log = [];

  chrome.storage.local.set({ flowCancelled: false });
  reportProgress({
    status: 'running',
    step: 0,
    maxSteps,
    filled: 0,
    message: 'Starting…',
    log,
    startedAt: Date.now(),
    stats: { profile: 0, rule: 0, ai: 0, memory: 0, skipped: 0 },
  });

  const totalStats = { profile: 0, rule: 0, ai: 0, memory: 0, skipped: 0 };

  for (let step = 0; step < maxSteps; step++) {
    if (await isCancelledInStorage()) {
      log = pushLog(log, '⊘ Stopped by user');
      reportProgress({
        status: 'stopped',
        step,
        maxSteps,
        filled: totalFilled,
        message: 'Stopped by user',
        log,
        stats: totalStats,
      });
      return { ok: false, submitted: false, totalFilled, error: 'Cancelled by user' };
    }

    const pageText = getPageText();
    const beforeSnapshot = pageText.slice(0, 2000);

    if (isSmartApplyPage() && getSmartApplyStep() === 'redirect') {
      await sleep(800);
      continue;
    }

    if (isEmployerRequirementsWarningPage(pageText)) {
      log = pushLog(log, `⚠ Step ${step + 1} – Requirements warning, clicking Apply Anyway`);
      reportProgress({
        status: 'running',
        step: step + 1,
        maxSteps,
        filled: totalFilled,
        message: 'Bypassing requirements warning…',
        log,
        stats: totalStats,
      });
      const btn = findApplyAnywayButton();
      if (btn) {
        await safeNavigate(btn, beforeSnapshot);
        continue;
      }
    }

    if (!shouldSkipCurrentPage(pageText) && !isReasonForApplyingPage(pageText)) {
      let fields = collectFields();
      if (fields.length === 0) {
        await sleep(400);
        fields = collectFields();
      }

      if (fields.length > 0) {
        log = pushLog(
          log,
          `⟳ Step ${step + 1} – Processing ${fields.length} field${fields.length === 1 ? '' : 's'}…`
        );
        reportProgress({
          status: 'running',
          step: step + 1,
          maxSteps,
          filled: totalFilled,
          message: `Step ${step + 1} – Processing ${fields.length} field${fields.length === 1 ? '' : 's'}…`,
          log,
          stats: totalStats,
        });

        if (await isCancelledInStorage()) {
          log = pushLog(log, '⊘ Stopped by user');
          reportProgress({
            status: 'stopped',
            step: step + 1,
            maxSteps,
            filled: totalFilled,
            message: 'Stopped by user',
            log,
            stats: totalStats,
          });
          return { ok: false, submitted: false, totalFilled, error: 'Cancelled by user' };
        }

        const aiReadyFields = fields.map(mapExtractedFieldForAI);

        const aiResp = await Promise.race([
          requestAiAnswers(aiReadyFields),
          new Promise(res => setTimeout(() => res({ ok: false, answers: [], error: 'timeout' }), 4000)),
        ]);
        const answers = aiResp?.answers || [];

        for (const a of answers) {
          const src = (a.source || '').toLowerCase();
          if (src.includes('memory')) totalStats.memory++;
          else if (src === 'profile') totalStats.profile++;
          else if (src === 'rule') totalStats.rule++;
          else if (src === 'ai') totalStats.ai++;
          else totalStats.skipped++;
        }

        let filled = 0;

        for (let i = 0; i < fields.length; i++) {
          const field = fields[i];
          const resolved = answers[i] || {};
          let answer = resolved.answer;

          if (answer == null || answer === '' || answer === '__SKIP__') {
            continue;
          }

          if (Array.isArray(answer)) {
            answer = answer
              .map(v => (v == null ? '' : String(v).trim()))
              .filter(Boolean);

            if (!answer.length) continue;
          } else if (typeof answer === 'string') {
            answer = answer.trim();
            if (!answer) continue;
          } else if (typeof answer === 'number' || typeof answer === 'boolean') {
            answer = String(answer);
          } else {
            console.warn('Skipping invalid non-serializable answer', {
              field,
              resolved,
              answerType: typeof answer,
            });
            continue;
          }

          if (field.type === 'checkbox_group' && typeof answer === 'string') {
            answer = answer
              .split(',')
              .map(s => s.trim())
              .filter(Boolean);

            if (!answer.length) continue;
          }

          try {
            const ok = await applyAnswerToField(field, answer);
            if (ok) filled++;
          } catch (err) {
            console.warn('applyAnswerToField failed', {
              field,
              resolved,
              normalizedAnswer: answer,
              error: err?.message || err,
            });
          }
        }

        totalFilled += filled;
        const summary = buildStepSummary(answers);
        log = pushLog(log, `✓ Step ${step + 1} – Filled ${filled}/${fields.length} ${summary}`);
        reportProgress({
          status: 'running',
          step: step + 1,
          maxSteps,
          filled: totalFilled,
          message: `Step ${step + 1} – Filled ${filled} field${filled === 1 ? '' : 's'}`,
          log,
          stats: totalStats,
        });
        await sleep(100);
      } else {
        log = pushLog(log, `– Step ${step + 1} – No fields on this page, looking for navigation…`);
        reportProgress({
          status: 'running',
          step: step + 1,
          maxSteps,
          filled: totalFilled,
          message: `Step ${step + 1} – No fields, looking for Continue…`,
          log,
          stats: totalStats,
        });
      }
    } else {
      log = pushLog(log, `– Step ${step + 1} – Skipping page (special page type)`);
      reportProgress({
        status: 'running',
        step: step + 1,
        maxSteps,
        filled: totalFilled,
        message: `Step ${step + 1} – Skipping special page…`,
        log,
        stats: totalStats,
      });
    }

    const submitBtn = findSubmitButton();
    if (submitBtn) {
      log = pushLog(log, `🏁 Reached submit page — ${totalFilled} field${totalFilled === 1 ? '' : 's'} filled`);
      reportProgress({
        status: 'done',
        step: step + 1,
        maxSteps,
        filled: totalFilled,
        message: 'Reached submit page — review and submit manually',
        log,
        stoppedAtSubmit: true,
        stats: totalStats,
      });
      return {
        ok: true,
        submitted: false,
        stoppedAtSubmit: true,
        totalFilled,
        steps: step + 1,
      };
    }

    const btn = await findAnyNavigationButtonWithRetry();

    if (!btn) {
      log = pushLog(log, `✗ No Continue/Next button found at step ${step + 1}`);
      reportProgress({
        status: 'error',
        step: step + 1,
        maxSteps,
        filled: totalFilled,
        message: 'No Continue/Next button found',
        log,
        stats: totalStats,
      });
      return {
        ok: false,
        submitted: false,
        totalFilled,
        steps: step + 1,
        error: 'No Continue/Next/Submit button found',
      };
    }

    const btnText = getBtnText(btn);

    if (isSubmitButton(btn)) {
      log = pushLog(log, `🚀 Step ${step + 1} – Submitting application…`);
      reportProgress({
        status: 'running',
        step: step + 1,
        maxSteps,
        filled: totalFilled,
        message: 'Submitting application…',
        log,
        stats: totalStats,
      });
      await safeNavigate(btn, beforeSnapshot);
      return { ok: true, submitted: true, totalFilled };
    }

    log = pushLog(log, `→ Step ${step + 1} – ${btnText || 'Continue'}`);
    reportProgress({
      status: 'running',
      step: step + 1,
      maxSteps,
      filled: totalFilled,
      message: `Step ${step + 1} – Going to next page…`,
      log,
      stats: totalStats,
    });
    await safeNavigate(btn, beforeSnapshot);
  }

  log = pushLog(log, `⚠ Max steps (${maxSteps}) reached`);
  reportProgress({
    status: 'error',
    step: maxSteps,
    maxSteps,
    filled: totalFilled,
    message: 'Max steps reached',
    log,
    stats: totalStats,
  });
  return { ok: false, submitted: false, totalFilled, error: 'Max steps reached' };
}

// ─── Message listener ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.action === 'HARVEST_FIELDS') {
    sendResponse({ fields: harvestFields() });
    return;
  }

  if (msg.action === 'APPLY_ANSWERS') {
    (async () => {
      let filled = 0;
      for (const item of msg.answers) {
        if (await applyAnswer(item, item.answer)) filled++;
      }
      sendResponse({ filled });
    })();
    return true;
  }

  if (msg.action === 'RUN_MULTI_STEP_FLOW') {
    runMultiStepFlow(msg.maxSteps || 12)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ ok: false, submitted: false, error: err?.message ? err.message : String(err) }));
    return true;
  }

  if (msg.action === 'FILL_NAME_ONLY') {
    const { profile } = msg;
    let filled = 0;
    document.querySelectorAll('input[type="text"], input:not([type])').forEach(el => {
      if (!isVisible(el)) return;
      const hints = [
        el.name, el.id,
        el.getAttribute('autocomplete') || '',
        el.getAttribute('placeholder')  || '',
        getLabelText(el),
      ].join(' ').toLowerCase();
      if (!/\bname\b/.test(hints)) return;
      const hasFirst = /first|fname|given/.test(hints);
      const hasLast  = /last|lname|family|surname/.test(hints);
      const value =
        hasFirst && !hasLast ? profile.firstName :
        hasLast  && !hasFirst ? profile.lastName :
        profile.fullName;
      if (value) { fillNative(el, value); filled++; }
    });
    sendResponse({ status: 'ok', filled });
    return;
  }

  if (msg.action === 'DEBUG_HARVEST') {
    const fields = harvestFields();
    console.log('[QuickFill DEBUG] Fields found:', JSON.stringify(fields, null, 2));
    sendResponse({ fields });
    return;
  }

});

} // end window.__qfLoaded guard

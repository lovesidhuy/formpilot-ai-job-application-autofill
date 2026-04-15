// QuickFill AI – content.js v5.4
// Changes over v5.3:
// - Fix E: findExMatchingOption now normalizes options to {label, value} objects
//   before matching. Previously, options from harvestIndeedNamedRadioGroups were
//   plain strings — o.label was undefined, so ALL matches failed silently and
//   logged "[object Object]". One-line normalization at the top of the function
//   fixes matching for both string-option fields (Indeed named radios) and
//   object-option fields (collectRadioGroup) uniformly.

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

const PAGE_TYPES = {
  RESUME_SELECTION: 'RESUME_SELECTION',
  QUESTION_PAGE: 'QUESTION_PAGE',
  REQUIREMENT_WARNING: 'REQUIREMENT_WARNING',
  WHY_APPLYING: 'WHY_APPLYING',
  RELEVANT_EXPERIENCE_JOB: 'RELEVANT_EXPERIENCE_JOB',
  REVIEW_PAGE: 'REVIEW_PAGE',
  CAPTCHA_OR_BLOCKED: 'CAPTCHA_OR_BLOCKED',
  UNKNOWN_PAGE: 'UNKNOWN_PAGE',
};

const FLOW_STATES = {
  SCAN_PAGE: 'SCAN_PAGE',
  CLASSIFY_PAGE: 'CLASSIFY_PAGE',
  BUILD_FIELD_MODELS: 'BUILD_FIELD_MODELS',
  ANSWER_FIELDS: 'ANSWER_FIELDS',
  APPLY_FIELDS: 'APPLY_FIELDS',
  VERIFY_FIELDS: 'VERIFY_FIELDS',
  CHECK_ERRORS: 'CHECK_ERRORS',
  NAVIGATE: 'NAVIGATE',
  WAIT_FOR_PAGE_CHANGE: 'WAIT_FOR_PAGE_CHANGE',
  DONE: 'DONE',
  BLOCKED: 'BLOCKED',
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


// ─── Indeed: extract question text for a radio group by name='q_{hash}' ───

function extractIndeedQuestionTextForRadioGroup(radioName, options) {
  let questionText = '';
  const stripOptionText = (text) => {
    let qt = String(text || '');
    for (const [, optText] of options) {
      if (optText) qt = qt.replace(optText, ' ');
    }
    return qt.replace(/\*/g, ' ').replace(/Required/gi, ' ').replace(/\s+/g, ' ').trim();
  };
  const pickQuestionLine = (text) => {
    const lines = dedupeLines(String(text || ''))
      .map(line => cleanQuestionText(stripOptionText(line)))
      .filter(line => line && !isGenericQuestionText(line) && line.length >= 3);
    if (!lines.length) return '';
    return (
      lines.find(line => /\?\s*$/.test(line)) ||
      lines.find(line => /understanding|experience|work|legally|authorized|country|city|salary|start/i.test(line)) ||
      lines.sort((a, b) => b.length - a.length)[0]
    );
  };

  try {
    const container = document.querySelector(`[data-testid*="${CSS.escape(radioName)}"]`);
    if (container) {
      questionText = pickQuestionLine(container.innerText || '') || stripOptionText(container.innerText || '');
    }
  } catch (_) {}

  if (!questionText && options.length) {
    try {
      let node = options[0][0].parentElement;
      for (let i = 0; i < 12; i++) {
        if (!node) break;
        const candidate = pickQuestionLine(node.innerText || '');
        if (candidate) {
          questionText = candidate;
          break;
        }
        node = node.parentElement;
      }
    } catch (_) {}
  }

  if (!questionText && options.length) {
    try {
      const radio = options[0][0];
      const container = radio.closest(`[id="${CSS.escape(radioName)}"], [data-testid*="${CSS.escape(radioName)}"], [class*="ia-Questions-item"], fieldset, li, section, div`);
      if (container) questionText = pickQuestionLine(container.innerText || '') || stripOptionText(container.innerText || '');
    } catch (_) {}
  }

  if (!questionText && options.length) {
    try {
      questionText =
        cleanQuestionText(getQuestionText(options[0][0])) ||
        cleanQuestionText(getLabelText(options[0][0])) ||
        cleanQuestionText(getIndeedQuestionText(options[0][0]));
    } catch (_) {}
  }

  return cleanQuestionText(questionText || '');
}

function buildFallbackQuestionLabel(el, question = '', name = '') {
  const cleanedQuestion = cleanQuestionText(question || '');
  if (cleanedQuestion && !isGarbageLabel(cleanedQuestion) && cleanedQuestion.length >= 3) {
    return cleanedQuestion;
  }

  if (el) {
    try {
      let node = getQuestionContainer(el);
      for (let i = 0; i < 10; i++) {
        if (!node) break;
        const candidate = cleanQuestionText(node.innerText || '');
        if (candidate && !isGarbageLabel(candidate) && candidate.length >= 3) {
          return candidate;
        }
        node = node.parentElement;
      }
    } catch (_) {}
  }

  const normalizedName = clean(String(name || '').replace(/[_-]+/g, ' '));
  if (normalizedName && !/^q_[a-f0-9]+$/i.test(normalizedName) && normalizedName.length >= 3) {
    return normalizedName;
  }

  return cleanedQuestion || normalizedName || '';
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
      label:          buildFallbackQuestionLabel(radios[0], questionText, name) || name,
      options:        opts,
      currentValue:   options.find(([r]) => r.checked)?.[1] || '',
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

// ─── Job description caching (main extension version) ────────────────────

function _scrapeJobInfo() {
  const titleEl = document.querySelector([
    'h1[data-testid*="title"]', 'h1[class*="title"]',
    '.ia-JobHeader h1', '[class*="JobTitle"]', 'h1'
  ].join(', '));
  const title = (titleEl?.innerText || '').trim();

  const companyEl = document.querySelector([
    '[data-testid*="company"]', '[class*="companyName"]', '[class*="company-name"]'
  ].join(', '));
  const company = (companyEl?.innerText || '').trim();

  const descSelectors = [
    '[data-testid="jobsearch-JobComponent-description"]',
    '.jobsearch-jobDescriptionText',
    '[class*="jobDescription"]', '[id*="jobDescription"]',
    '.ia-JobDescription', '[data-testid*="job-description"]',
    '.ia-JobDetails', '[class*="JobDetails"]', '[class*="job-details"]',
  ];
  let desc = '';
  for (const sel of descSelectors) {
    const el = document.querySelector(sel);
    if (el) {
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (text.length > 200) { desc = text; break; }
    }
  }
  if (!desc) {
    const KW = /responsibilit|qualif|requirement|experience|skill|benefit|salary|about (us|the role)/i;
    let bestEl = null, bestLen = 200;
    for (const el of document.querySelectorAll('div, section, article, main')) {
      if (el.children.length > 30) continue;
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (text.length > bestLen && KW.test(text)) { bestLen = text.length; bestEl = el; }
    }
    if (bestEl) desc = (bestEl.innerText || '').replace(/\s+/g, ' ').trim();
  }
  return { title, company, desc: desc.slice(0, 4000) };
}

function _cacheJobOpportunistically() {
  if (!isIndeedPage()) return;
  try {
    const jk = location.href.match(/[?&]jk=([a-zA-Z0-9]+)/);
    const jobId = jk ? jk[1] : location.hostname + location.pathname;
    const { title, company, desc } = _scrapeJobInfo();
    chrome.storage.session.get(['qf_cachedJob'], (data) => {
      const existing = data.qf_cachedJob || {};
      const isSame = existing.jobId === jobId;
      chrome.storage.session.set({ qf_cachedJob: {
        jobId,
        title:   title   || (isSame ? existing.title   : ''),
        company: company || (isSame ? existing.company : ''),
        desc:    desc    || (isSame ? existing.desc    : ''),
        ts: Date.now(),
      }});
    });
  } catch (_) {}
}

function _readCachedJobDescription() {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(''), 1500);
    try {
      chrome.storage.session.get(['qf_cachedJob'], (data) => {
        clearTimeout(timer);
        const job = data?.qf_cachedJob;
        if (!job) { resolve(''); return; }
        const parts = [
          job.title   ? `Job Title: ${job.title}`   : '',
          job.company ? `Company: ${job.company}`   : '',
          job.desc    ? `Job Description:\n${job.desc}` : '',
        ].filter(Boolean);
        resolve(parts.join('\n\n'));
      });
    } catch (_) { clearTimeout(timer); resolve(''); }
  });
}

// Cache on every page load (guarded inside the function)
_cacheJobOpportunistically();

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

function isCaptchaOrBlockedPage(text) {
  const bodyText = String(text || '').toLowerCase();
  const hasCaptchaWidget = !!document.querySelector(
    'iframe[src*="captcha"], iframe[src*="recaptcha"], .g-recaptcha, .h-captcha, [data-sitekey], textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"]'
  );
  const hasExplicitBlockText = /verify you are human|security check|access denied|temporarily blocked|unusual traffic|complete the captcha|solve the captcha/i.test(bodyText);
  const hasOnlyLegalNotice = /protected by recaptcha|google.?s privacy policy|terms of service apply/i.test(bodyText) && !hasExplicitBlockText;
  return (hasCaptchaWidget && !hasOnlyLegalNotice) || hasExplicitBlockText;
}

function isResumeSelectionPage(text) {
  return getSmartApplyStep() === 'resume-selection' ||
    /add a resume for the employer|resume selection|choose a resume|select a resume|upload a resume|existing resume/i.test(text || '');
}

function isReviewPage(text) {
  return getSmartApplyStep() === 'review' ||
    /please review your application|review your application|application review|before submitting|submit your application/i.test(text || '') ||
    !!findSubmitButton();
}

function getVisibleQuestionControlCount() {
  const selectors = [
    'input:not([type="hidden"]):not([type="button"]):not([type="submit"])',
    'textarea',
    'select',
    '[role="radiogroup"]',
    '[role="combobox"]',
  ];
  return selectors.reduce((count, sel) => count + Array.from(document.querySelectorAll(sel)).filter(isVisible).length, 0);
}

function classifyCurrentPage(pageText = getPageText()) {
  const text = String(pageText || '').toLowerCase();
  const step = getSmartApplyStep();

  if (isCaptchaOrBlockedPage(text)) {
    return { type: PAGE_TYPES.CAPTCHA_OR_BLOCKED, step, reason: 'captcha_or_blocked' };
  }
  if (isEmployerRequirementsWarningPage(text)) {
    return { type: PAGE_TYPES.REQUIREMENT_WARNING, step, reason: 'requirements_warning' };
  }
  if (isReasonForApplyingPage(text)) {
    return { type: PAGE_TYPES.WHY_APPLYING, step, reason: 'why_applying' };
  }
  if (shouldSkipCurrentPage(text)) {
    return { type: PAGE_TYPES.RELEVANT_EXPERIENCE_JOB, step, reason: 'relevant_experience_job' };
  }
  if (isResumeSelectionPage(text)) {
    return { type: PAGE_TYPES.RESUME_SELECTION, step, reason: 'resume_selection' };
  }
  if (isReviewPage(text)) {
    return { type: PAGE_TYPES.REVIEW_PAGE, step, reason: 'review' };
  }
  if (
    step === 'qual-questions' ||
    step === 'emp-questions' ||
    step === 'contact-info' ||
    step === 'location' ||
    step === 'experience' ||
    getVisibleQuestionControlCount() > 0
  ) {
    return { type: PAGE_TYPES.QUESTION_PAGE, step, reason: 'question_controls' };
  }
  return { type: PAGE_TYPES.UNKNOWN_PAGE, step, reason: 'unclassified' };
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

function getAnswerText(answer) {
  if (answer === null || answer === undefined) return '';
  if (Array.isArray(answer)) {
    return answer.map(item => getAnswerText(item)).filter(Boolean).join(', ');
  }
  if (typeof answer === 'object') {
    return String(answer.label ?? answer.value ?? answer.answer ?? answer.text ?? '').trim();
  }
  return String(answer).trim();
}

function describeAnswerForLog(answer) {
  if (typeof answer === 'string') return answer;
  const text = getAnswerText(answer);
  if (text) return text;
  try {
    return JSON.stringify(answer);
  } catch (_) {
    return String(answer);
  }
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

// ─── Field capture primitives ──────────────────────────────────────────────

const isElement = (n) => n instanceof Element;

const clean = (v) => (v || '').replace(/\s+/g, ' ').trim();

const dedupeLines = (text) => {
  const seen = new Set();
  return (text || '')
    .split('\n')
    .map(clean)
    .filter(Boolean)
    .filter(line => {
      const key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

const getBoundedRect = (el) => {
  if (!isElement(el)) return { x: 0, y: 0, width: 0, height: 0 };
  const r = el.getBoundingClientRect();
  return {
    x: Math.max(0, Math.round(r.x)),
    y: Math.max(0, Math.round(r.y)),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
};

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

const JUNK = [
  'search', 'captcha', 'recaptcha', 'save and close',
  'continue', 'tell us more', 'export indeed data',
];
const OPTION_ONLY_TEXT = /^(yes|no|other|select an option|language options|canada|usa|another country|annually|hourly|monthly|weekly)$/i;

const isGenericQuestionText = (text) => {
  const t = clean(text || '');
  if (!t) return true;
  return OPTION_ONLY_TEXT.test(t) || /^(language options|options|answer choices|radio group)$/i.test(t);
};

// ── layer 1: indeed-aware containers ─────────────────────────────────────

const getFieldset         = (el) => isElement(el) ? (el.closest('fieldset') || null) : null;
const getIndeedQuestionItem = (el) => isElement(el) ? (el.closest('.ia-Questions-item') || null) : null;

const getLegendText = (fieldset) => {
  if (!isElement(fieldset)) return '';
  const legend =
    fieldset.querySelector('legend [data-testid*="-label"]') ||
    fieldset.querySelector('legend');
  return clean(legend?.innerText || legend?.textContent || '');
};

const getQuestionContainer = (el) => {
  if (!isElement(el)) return el;
  return (
    getFieldset(el) ||
    getIndeedQuestionItem(el) ||
    el.closest('[id^="q_"]') ||
    el.closest('form') ||
    el
  );
};

const cleanQuestionText = (text) => {
  const t = clean(text || '');
  if (!t) return '';
  const lines = dedupeLines(t)
    .filter(line => !OPTION_ONLY_TEXT.test(line))
    .filter(line => !JUNK.some(j => line.toLowerCase().includes(j)));
  if (!lines.length) return '';
  const best =
    lines.find(line => /\?\s*\*?$/.test(line)) ||
    lines.find(line => /\*\s*$/.test(line)) ||
    lines.find(line => /experience|hear|onsite|legally|country|city|salary|start|work in canada|employee|privacy|consent|acknowledge|certify|currency|linkedin|microsoft 365|msp/i.test(line)) ||
    lines[0];
  return clean(best).replace(/\s+(Yes|No|Other)(\s+(Yes|No|Other))*$/i, '').trim();
};

const getQuestionText = (el) => {
  if (!isElement(el)) return '';
  const fieldset = getFieldset(el);
  const legendText = cleanQuestionText(getLegendText(fieldset));
  if (legendText && !OPTION_ONLY_TEXT.test(legendText)) return legendText;
  const item = getIndeedQuestionItem(el);
  if (item) {
    const candidates = [
      item.querySelector('legend'),
      item.querySelector('[data-testid*="-label"]'),
      item.querySelector('[role="heading"]'),
      item.querySelector('h1,h2,h3,h4,h5,h6'),
      item.querySelector('label'),
    ].filter(Boolean);
    for (const node of candidates) {
      const text = cleanQuestionText(node.innerText || node.textContent || '');
      if (text && !OPTION_ONLY_TEXT.test(text) && text.split(' ').length > 3 && text.length < 120) {
        return text;
      }
    }
  }
  return '';
};

// ── layer 2: label fallback ───────────────────────────────────────────────

const findLabel = (el) => {
  if (!isElement(el)) return '';
  const direct = clean(
    el.labels?.[0]?.innerText ||
    (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText) ||
    el.getAttribute('aria-label') ||
    el.getAttribute('placeholder') ||
    ''
  );
  if (direct && !OPTION_ONLY_TEXT.test(direct)) return direct;
  const questionText = getQuestionText(el);
  if (questionText) return questionText;
  let node = el.parentElement;
  while (isElement(node) && node !== document.body) {
    const text = cleanQuestionText(node.innerText || '');
    if (text && text.length < 120 && text.split(' ').length > 3 && !OPTION_ONLY_TEXT.test(text)) return text;
    node = node.parentElement;
  }
  return clean(el.name || el.id || el.type || el.tagName);
};

// ── metadata helpers ──────────────────────────────────────────────────────

const getValidationMessage = (el) => {
  const describedBy = el.getAttribute('aria-describedby');
  if (describedBy) {
    const text = describedBy.split(/\s+/)
      .map(id => document.getElementById(id))
      .filter(Boolean)
      .map(node => clean(node.innerText || node.textContent || ''))
      .filter(Boolean)
      .join(' | ');
    if (text) return text;
  }
  const inv = el.closest('[aria-invalid="true"], .icl-TextInput-error, [class*="error"], [class*="invalid"]');
  return inv ? clean(inv.innerText).slice(0, 300) : '';
};

const getSection = (el) => {
  const s = el.closest('[data-testid*="section"], section, form, main');
  if (!s) return '';
  return clean(s.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]')?.innerText || '');
};

const hasRequiredQuestionMarker = (question) => /(^|\s)\*(\s|$)|\*\s*$/.test(question || '');

function getElementRequirementSignals(el, question = '') {
  if (!isElement(el)) return [];

  const signals = [];
  if (el.required) signals.push('required');
  if (el.getAttribute('aria-required') === 'true') signals.push('aria-required');
  if (hasRequiredQuestionMarker(question)) signals.push('question-*');
  if (el.getAttribute('aria-invalid') === 'true' || el.getAttribute('data-invalid') === 'true') {
    signals.push('aria-invalid');
  }
  if (getValidationMessage(el)) signals.push('visible-validation-text');
  return Array.from(new Set(signals));
}

const isRequired = (el, question) => getElementRequirementSignals(el, question).length > 0;

const isConsentBlock = (fieldset, question) => {
  if (!isElement(fieldset)) return false;
  const text = `${question} ${clean(fieldset.innerText || '')}`;
  return /privacy|consent|certif|acknowledg|background check|credit check|personal information/i.test(text) &&
    text.length > 120;
};

const getOptionLabel = (input) =>
  clean(input.closest('label')?.innerText) ||
  clean((input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.innerText) || '') ||
  clean(input.value);

const isLikelySingleChoiceCheckboxGroup = (question, options) => {
  if (!Array.isArray(options) || options.length < 2) return false;
  const labels = options.map(o => (o.label || '').toLowerCase());
  const hasNever = labels.some(l => /never worked|none|no[, ]/i.test(l));
  const yesLike = labels.filter(l => /^yes\b/i.test(l)).length;
  return /employee|employment|worked/i.test(question || '') && hasNever && yesLike >= 1;
};

// ── field filtering ───────────────────────────────────────────────────────

const isFakeCombo = (el) => {
  if (!isElement(el)) return false;
  const role = (el.getAttribute('role') || '').toLowerCase();
  const hasPopup = (el.getAttribute('aria-haspopup') || '').toLowerCase();
  return role === 'combobox' || hasPopup === 'listbox';
};

function isRealQuestionField(el) {
  if (!isElement(el) || !isVisible(el)) return false;
  if (el.disabled || el.readOnly) return false;
  const tag  = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const allowed = ['input', 'textarea', 'select'].includes(tag) || isFakeCombo(el);
  if (!allowed) return false;
  if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) return false;
  const blob = [
    findLabel(el), el.getAttribute('name'), el.id,
    el.getAttribute('placeholder'), el.getAttribute('data-testid'),
  ].join(' ').toLowerCase();
  return !JUNK.some(w => blob.includes(w));
}

// ── dom snapshot helper ───────────────────────────────────────────────────

const domSnapshot = (el, container) => ({
  selector:          cssPath(el),
  containerSelector: cssPath(container),
  id:                el.id || '',
  name:              el.getAttribute('name') || el.name || '',
  className:         typeof el.className === 'string' ? el.className : '',
  role:              el.getAttribute('role') || '',
  dataTestId:        el.getAttribute('data-testid') || '',
  placeholder:       el.getAttribute('placeholder') || '',
  ariaLabel:         el.getAttribute('aria-label') || '',
  ariaDescribedBy:   el.getAttribute('aria-describedby') || '',
  ariaRequired:      el.getAttribute('aria-required') || '',
  ariaInvalid:       el.getAttribute('aria-invalid') || '',
  autocomplete:      el.getAttribute('autocomplete') || '',
  inputMode:         el.getAttribute('inputmode') || '',
  visible:           isVisible(el),
  disabled:          !!el.disabled,
  readOnly:          !!el.readOnly,
  multiple:          !!el.multiple,
  min:               el.getAttribute('min') || '',
  max:               el.getAttribute('max') || '',
  step:              el.getAttribute('step') || '',
  pattern:           el.getAttribute('pattern') || '',
  maxLength:         typeof el.maxLength === 'number' ? el.maxLength : null,
  rect:              getBoundedRect(container),
});

// ── Harvesters ─────────────────────────────────────────────────────────────

function collectRadioGroup(el) {
  const name = el.name;
  if (!name) return null;
  const group = Array.from(document.querySelectorAll(
    `input[type="radio"][name="${CSS.escape(name)}"]`
  )).filter(isRealQuestionField);
  if (!group.length) return null;
  const first     = group[0];
  const container = getQuestionContainer(first);
  let question  = getLegendText(getFieldset(first)) || getQuestionText(first) || findLabel(first);
  if (isGarbageLabel(question) && /^q_[a-f0-9]+$/i.test(name)) {
    const fallbackOptions = group.map(r => [r, getOptionLabel(r)]).filter(([, text]) => text);
    question = extractIndeedQuestionTextForRadioGroup(name, fallbackOptions) || question;
  }
  question = buildFallbackQuestionLabel(first, question, name);
  if (!question || question.length < 3) return null;
  const options = group.map(r => ({
    label:    getOptionLabel(r),
    value:    r.value || '',
    checked:  !!r.checked,
    selector: cssPath(r),
    id:       r.id || '',
    name:     r.name || '',
  }));
  return {
    question, type: 'radio', tag: 'input',
    required: group.some(r => getElementRequirementSignals(r, question).length > 0),
    answer:   options.find(o => o.checked)?.label || options.find(o => o.checked)?.value || '',
    options,
    dom:               domSnapshot(first, container),
    section:           getSection(first),
    validationMessage: getValidationMessage(first),
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
  const container = getQuestionContainer(first);
  const fieldset  = getFieldset(first);
  const question  = getLegendText(fieldset) || getQuestionText(first) || findLabel(first);
  if (!question || question.length < 5) return null;
  const consent = isConsentBlock(fieldset, question);
  const options = group.map(c => ({
    label:    getOptionLabel(c),
    value:    c.value || '',
    checked:  !!c.checked,
    selector: cssPath(c),
    id:       c.id || '',
    name:     c.name || '',
  }));
  return {
    question,
    type: consent ? 'consent_checkbox_group' : 'checkbox_group',
    tag: 'input',
    required: group.some(i => getElementRequirementSignals(i, question).length > 0),
    answer:   options.filter(o => o.checked).map(o => o.label || o.value),
    options,
    singleChoiceLikely: !consent && isLikelySingleChoiceCheckboxGroup(question, options),
    dom:               domSnapshot(first, container),
    section:           getSection(first),
    validationMessage: getValidationMessage(first),
    targets: group.map(c => ({ selector: cssPath(c), id: c.id || '', name: c.name || '', tag: 'input', type: 'checkbox' })),
  };
}

function collectNativeSelect(el) {
  const question  = buildFallbackQuestionLabel(el, findLabel(el), el.name || el.id || '');
  const container = getQuestionContainer(el);
  const options = Array.from(el.options)
    .map((o, idx) => ({ index: idx, label: clean(o.textContent), value: o.value, selected: o.selected }))
    .filter(o => o.label || o.value);
  return {
    question, type: 'select', tag: 'select',
    required: isRequired(el, question),
    answer:   el.value || '',
    options,
    dom:               domSnapshot(el, container),
    section:           getSection(el),
    validationMessage: getValidationMessage(el),
    targets: [{ selector: cssPath(el), id: el.id || '', name: el.name || '', tag: 'select', type: 'select' }],
  };
}

function collectFakeCombobox(el) {
  const question  = buildFallbackQuestionLabel(el, findLabel(el), el.getAttribute('name') || el.id || '');
  const container = getQuestionContainer(el);
  const options = Array.from(container.querySelectorAll('[role="option"], option'))
    .map((n, idx) => ({
      index:    idx,
      label:    clean(n.innerText || n.textContent || ''),
      value:    n.getAttribute('data-value') || n.getAttribute('value') || clean(n.innerText || n.textContent || ''),
      selected: n.getAttribute('aria-selected') === 'true',
    })).filter(o => o.label || o.value);
  return {
    question, type: 'select', tag: el.tagName.toLowerCase(),
    required: isRequired(el, question),
    answer:   clean(el.innerText || el.textContent || '') || el.getAttribute('aria-label') || '',
    options,
    dom:               domSnapshot(el, container),
    section:           getSection(el),
    validationMessage: getValidationMessage(el),
    targets: [{ selector: cssPath(el), id: el.id || '', name: el.getAttribute('name') || '', tag: el.tagName.toLowerCase(), type: 'select' }],
  };
}

function looksNumericField(el, question) {
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const min = el.getAttribute('min'), max = el.getAttribute('max'), step = el.getAttribute('step');
  if (tag === 'textarea') return false;
  if (type === 'number') return true;
  if (/how many|years of|experience|amount|salary/i.test(question || '')) return true;
  if ((min && !Number.isNaN(Number(min))) || (max && !Number.isNaN(Number(max)))) return true;
  if (step && step !== 'any' && !Number.isNaN(Number(step))) return true;
  const validMsg = getValidationMessage(el).toLowerCase();
  if (/valid number|no decimals|must be a number|enter a number|numeric/i.test(validMsg)) return true;
  return false;
}

function collectSingleField(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'select')   return collectNativeSelect(el);
  if (isFakeCombo(el))    return collectFakeCombobox(el);
  const type      = (el.getAttribute('type') || '').toLowerCase();
  const question  = buildFallbackQuestionLabel(el, findLabel(el), el.name || el.id || '');
  const container = getQuestionContainer(el);
  if (!question || question.length < 3) return null;
  let fieldType = type || tag;
  if (tag !== 'textarea' && (fieldType === 'text' || fieldType === 'input') && looksNumericField(el, question))
    fieldType = 'number';
  return {
    question, type: fieldType, tag,
    required: isRequired(el, question),
    answer:   ('value' in el ? el.value : '') || '',
    options:  [],
    dom:               domSnapshot(el, container),
    section:           getSection(el),
    validationMessage: getValidationMessage(el),
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

// ═══════════════════════════════════════════════════════════════════════════
// FIX D – SECTION 1: harvestAriaRadioGroups
// ═══════════════════════════════════════════════════════════════════════════

function harvestAriaRadioGroups(seenEls) {
  const fields = [];

  for (const group of document.querySelectorAll('[role="radiogroup"]')) {
    if (!isVisible(group)) continue;

    const radios = Array.from(group.querySelectorAll('[role="radio"]'))
      .filter(r => isVisible(r));

    if (radios.length < 2) continue;
    if (radios.some(r => seenEls.has(r))) continue;

    let questionText = '';
    const firstRadio = radios[0];

    const labelledBy = group.getAttribute('aria-labelledby');
    if (labelledBy) {
      questionText = labelledBy.trim().split(/\s+/)
        .map(id => { const el = document.getElementById(id); return el ? el.innerText.trim() : ''; })
        .filter(Boolean).join(' ');
      questionText = cleanQuestionText(questionText);
    }

    if (!questionText || isGenericQuestionText(questionText)) {
      questionText = cleanQuestionText(getQuestionText(firstRadio));
    }

    if (!questionText || isGenericQuestionText(questionText)) {
      questionText = cleanQuestionText(group.getAttribute('aria-label') || '');
    }

    if (!questionText || isGenericQuestionText(questionText)) {
      const fs = group.closest('fieldset');
      questionText = cleanQuestionText(getLegendText(fs));
    }

    if (!questionText || isGenericQuestionText(questionText)) {
      let node = group.parentElement;
      for (let i = 0; i < 6; i++) {
        if (!node || node === document.body) break;
        const heading = node.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"],label,legend,p');
        if (heading && !group.contains(heading)) {
          const txt = cleanQuestionText(heading.innerText || heading.textContent || '');
          if (txt.length > 4 && txt.length < 300 && !isGenericQuestionText(txt)) {
            questionText = txt;
            break;
          }
        }
        node = node.parentElement;
      }
    }

    if (!questionText || isGenericQuestionText(questionText)) {
      questionText = cleanQuestionText((group.getAttribute('data-testid') || group.id || '').replace(/[-_]/g, ' '));
    }

    if (!questionText || isGenericQuestionText(questionText) || questionText.length < 3) continue;

    const options = radios.map(r => {
      const lbId = r.getAttribute('aria-labelledby');
      if (lbId) {
        const txt = lbId.trim().split(/\s+/)
          .map(id => { const el = document.getElementById(id); return el ? el.innerText.trim() : ''; })
          .filter(Boolean).join(' ');
        if (txt) return { el: r, label: txt, value: r.getAttribute('aria-valuenow') || txt };
      }
      const al = (r.getAttribute('aria-label') || '').trim();
      if (al) return { el: r, label: al, value: al };
      const inner = r.innerText.trim();
      if (inner) return { el: r, label: inner, value: inner };
      const sibling =
        r.nextElementSibling?.innerText?.trim() ||
        r.closest('[data-testid]')?.querySelector('span,label')?.innerText?.trim() ||
        r.parentElement?.innerText?.trim() || '';
      return { el: r, label: sibling, value: sibling };
    }).filter(o => o.label);

    if (!options.length) continue;

    radios.forEach(r => seenEls.add(r));

    const groupId =
      group.id ||
      group.getAttribute('data-testid') ||
      group.getAttribute('aria-labelledby') ||
      cssPath(group);

    const targets = options.map(o => ({
      selector: cssPath(o.el),
      id:       o.el.id || '',
      name:     groupId,
      tag:      'aria-radio',
      type:     'radio',
      label:    o.label,
      value:    o.value,
    }));

    fields.push({
      id:           'aria-radiogroup::' + groupId,
      tag:          'aria-radio',
      type:         'radio',
      name:         groupId,
      label:        questionText,
      question:     questionText,
      options:      options.map(o => o.label),
      currentValue: options.find(o => o.el.getAttribute('aria-checked') === 'true')?.label || '',
      required:     (
        group.getAttribute('aria-required') === 'true' ||
        hasRequiredQuestionMarker(questionText) ||
        radios.some(r => r.getAttribute('aria-invalid') === 'true')
      ),
      targets,
      _ariaOptions: options,
    });
  }

  return fields;
}

// ── Main field collector ────────────────────────────────────────────────────

function collectFields(pageType = classifyCurrentPage().type) {
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

  // ── Indeed-specific supplement ──────────────────────────────────────────
  if (isIndeedPage() || isSmartApplyPage()) {
    const seenEls = new Set(nodes);

    const seenNames = new Set(
      fields.flatMap(f => {
        const n = f.targets?.[0]?.name || f.dom?.name || f.name || '';
        return n ? [n] : [];
      })
    );

    const namedRadios = harvestIndeedNamedRadioGroups(seenEls);
    for (const nf of namedRadios) {
      if (!seenNames.has(nf.name)) { fields.push(nf); seenNames.add(nf.name); }
    }

    const namedCheckboxGroups = harvestIndeedNamedCheckboxGroups(seenEls);
    for (const cf of namedCheckboxGroups) {
      if (!seenNames.has(cf.name)) { fields.push(cf); seenNames.add(cf.name); }
    }

    const containerFields = harvestIndeedContainerFields(seenEls);
    for (const cf of containerFields) {
      if (!seenNames.has(cf.name)) fields.push(cf);
    }
  }

  // ── ARIA radiogroup supplement (platform-agnostic) ──────────────────────
  {
    const richSeenEls = new Set();
    for (const f of fields) {
      if (f.targets) {
        for (const t of f.targets) {
          if (t.selector) {
            try {
              const el = document.querySelector(t.selector);
              if (el) richSeenEls.add(el);
            } catch (_) {}
          }
        }
      }
    }

    const ariaGroups = harvestAriaRadioGroups(richSeenEls);

    const seenQuestions = new Set(
      fields.map(f => (f.question || f.label || '').toLowerCase().trim())
    );

    for (const ag of ariaGroups) {
      const q = (ag.question || '').toLowerCase().trim();
      if (!seenQuestions.has(q)) {
        fields.push(ag);
        seenQuestions.add(q);
      }
    }
  }

  return attachOtherFollowups(fields).map(field => enrichCanonicalFieldModel(field, pageType));
}

function inferAllowedAnswerShape(field) {
  if (field.type === 'radio' || field.type === 'select' || field.tag === 'aria-radio') return 'exact_option';
  if (field.type === 'checkbox_group' || field.type === 'consent_checkbox_group') return 'option_array';
  if (field.type === 'number') return 'numeric';
  if (field.type === 'textarea') return 'descriptive_text';
  if (['text', 'email', 'tel', 'url'].includes(field.type)) return 'scalar_text';
  return 'unknown';
}

function enrichCanonicalFieldModel(field, pageType = PAGE_TYPES.UNKNOWN_PAGE) {
  const firstTarget = field.targets?.[0] || {};
  const containerId = field.dom?.containerSelector || firstTarget.selector || '';
  const questionText = clean(field.question || field.label || '');
  const helpText = clean(field.validationMessage || '');
  const currentValue = Array.isArray(field.answer) ? field.answer.slice() : (field.answer || field.currentValue || '');
  const visible = (field.targets || []).some(resolveElement) || field.dom?.visible !== false;
  const enabled = (field.targets || []).map(resolveElement).filter(Boolean).some(el => !el.disabled && !el.readOnly);
  const hasError = !!helpText || collectVisibleErrorUi(field).length > 0;
  return {
    ...field,
    id: field.id || uniqueId(resolveElement(firstTarget) || document.body),
    containerId,
    pageType,
    questionText,
    helpText,
    currentValue,
    visible,
    enabled,
    errorText: helpText,
    hasError,
    dependency: field.dependency || null,
    allowedAnswerShape: inferAllowedAnswerShape(field),
    confidence: questionText && !isGenericQuestionText(questionText) ? 0.9 : 0.45,
  };
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

// ── FIX E: findExMatchingOption — handles both plain string and object options
// harvestIndeedNamedRadioGroups produces plain string arrays e.g. ["Yes", "No"].
// collectRadioGroup produces object arrays e.g. [{label:"Yes", value:"abc", ...}].
// Previously String(o.label || '') on a plain string gave "" causing all matches
// to fail silently. Normalizing at the top fixes both paths uniformly.

function findExMatchingOption(field, answer) {
  const raw        = getAnswerText(answer);
  const normalized = raw.toLowerCase();
  if (!normalized) return null;

  const normalizeOptionForMatch = (value) => {
    const text = String(value || '')
      .replace(/\*+/g, ' ')
      .replace(/\brequired\b/gi, ' ')
      .replace(/\((?:[^)(]*required[^)(]*|no\s+visa\s+sponsorship[^)(]*|visa\s+sponsorship[^)(]*|select\s+one[^)(]*|choose\s+one[^)(]*)\)/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return normalizeText(text);
  };

  // Normalize: wrap plain strings into {label, value} so all code below is uniform
  const opts = (field.options || []).map(o =>
    typeof o === 'string' ? { label: o, value: o } : o
  );

  // 1. Exact case-insensitive match
  const exact = opts.find(o => String(o.label || '').trim().toLowerCase() === normalized);
  if (exact) return exact;

  // 1b. Yes/No → True/False alias
  if (/^(yes|oui)$/i.test(normalized)) {
    const tf = opts.find(o => /^true$/i.test(String(o.label || '').trim()));
    if (tf) return tf;
  }
  if (/^(no|non)$/i.test(normalized)) {
    const tf = opts.find(o => /^false$/i.test(String(o.label || '').trim()));
    if (tf) return tf;
  }

  // 2. Normalized match
  const normAnswer = normalizeText(raw);
  const normExact  = opts.find(o => normalizeOptionForMatch(String(o.label || '')) === normAnswer);
  if (normExact) return normExact;

  // 3. Partial substring match (either direction)
  const partial = opts.find(o => {
    const l = String(o.label || '').trim().toLowerCase();
    return l.includes(normalized) || normalized.includes(l);
  });
  if (partial) return partial;

  // 4. Normalized partial match
  const normPartial = opts.find(o => {
    const l = normalizeOptionForMatch(String(o.label || ''));
    return l.includes(normAnswer) || normAnswer.includes(l);
  });
  if (normPartial) return normPartial;

  // 5. Range-aware numeric match
  const answerNum = parseFloat(raw);
  if (!isNaN(answerNum)) {
    const lessThanOne = opts.find(o =>
      /less\s+than\s+1|under\s+1|0\s*[-–]\s*1\s+year|fewer\s+than\s+1/i.test(String(o.label || ''))
    );
    if (lessThanOne && answerNum < 1) return lessThanOne;

    let bestCeiling = null;
    let bestCeilingThreshold = -Infinity;
    let bestRange = null;

    for (const o of opts) {
      const label = String(o.label || '');

      const moreMatch = label.match(/(\d+)\s*\+|\bmore\s+than\s+(\d+)|\b(\d+)\s+or\s+more/i);
      if (moreMatch) {
        const threshold = parseInt(moreMatch[1] || moreMatch[2] || moreMatch[3], 10);
        if (answerNum >= threshold && threshold >= bestCeilingThreshold) {
          bestCeilingThreshold = threshold;
          bestCeiling = o;
        }
        continue;
      }

      const nums = label.match(/\d+/g);
      if (!nums || nums.length < 2) continue;
      const lo = Math.min(...nums.map(Number));
      const hi = Math.max(...nums.map(Number));
      if (answerNum >= lo && answerNum <= hi) {
        if (!bestRange || (hi - lo) < (bestRange._hi - bestRange._lo)) {
          bestRange = { o, _lo: lo, _hi: hi };
        }
      }
    }

    if (bestRange) return bestRange.o;
    if (bestCeiling) return bestCeiling;

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

  // 6. Word-overlap fallback (words > 3 chars only)
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

async function verifyRadioSelection(field, answer, selectedEl = null) {
  await sleep(120);

  const desired = normalizeText(getAnswerText(answer));
  const targets = Array.isArray(field?.targets) ? field.targets : [];
  const els = targets.map(resolveElement).filter(Boolean);

  const isSelected = (el) => !!el && (
    el.checked === true ||
    el.getAttribute?.('aria-checked') === 'true'
  );

  const getRadioText = (el) => normalizeText(
    el?.getAttribute?.('aria-label') ||
    el?.closest?.('label')?.innerText ||
    (el?.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText) ||
    el?.innerText ||
    el?.textContent ||
    el?.value ||
    ''
  );

  if (selectedEl && isSelected(selectedEl)) {
    const selectedText = getRadioText(selectedEl);
    if (!desired || selectedText === desired || selectedText.includes(desired) || desired.includes(selectedText)) {
      return true;
    }
  }

  const selected = els.find(isSelected);
  if (!selected) return false;

  const selectedText = getRadioText(selected);
  if (!desired) return true;
  return selectedText === desired || selectedText.includes(desired) || desired.includes(selectedText);
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

  // ── ARIA radio widget branch (FIX D – SECTION 3) ──────────────────────
  if (field.tag === 'aria-radio') {
    const answerText = getAnswerText(answer);
    const ansNorm  = answerText.toLowerCase();
    const ariaOpts = field._ariaOptions || [];

    for (const opt of ariaOpts) {
      if (
        opt.label.toLowerCase() === ansNorm ||
        opt.label.toLowerCase().includes(ansNorm) ||
        ansNorm.includes(opt.label.toLowerCase())
      ) {
        let el = null;
        try { el = opt.selector ? document.querySelector(opt.selector) : null; } catch (_) {}
        if (!el) el = opt.el;
        if (el && isVisible(el)) {
          clickElement(el);
          return await verifyRadioSelection(field, answer, el);
        }
      }
    }

    if (field.name) {
      const container =
        document.getElementById(field.name) ||
        document.querySelector(`[role="radiogroup"][id="${CSS.escape(field.name)}"]`) ||
        document.querySelector(`[role="radiogroup"][data-testid="${CSS.escape(field.name)}"]`);
      if (container) {
        for (const r of container.querySelectorAll('[role="radio"]')) {
          if (!isVisible(r)) continue;
          const lbl = (
            r.getAttribute('aria-label') ||
            r.innerText ||
            r.nextElementSibling?.innerText || ''
          ).trim().toLowerCase();
          if (lbl === ansNorm || lbl.includes(ansNorm) || ansNorm.includes(lbl)) {
            clickElement(r);
            return await verifyRadioSelection(field, answer, r);
          }
        }
      }
    }

    for (const t of (field.targets || [])) {
      if (
        (t.label || '').toLowerCase() === ansNorm ||
        (t.label || '').toLowerCase().includes(ansNorm)
      ) {
        let el = null;
        try { el = t.selector ? document.querySelector(t.selector) : null; } catch (_) {}
        if (el && isVisible(el)) {
          clickElement(el);
          return await verifyRadioSelection(field, answer, el);
        }
      }
    }

    const debugAnswer = describeAnswerForLog(answer);
    const debugOptions = (field._ariaOptions || []).map(o => o.label);
    const debugTargets = (field.targets || []).map(t => t.label).filter(Boolean);
    console.warn(
      `[QuickFill] ARIA radio no match: question="${String(field.question || field.label || '(unknown)')}" answer="${debugAnswer}"`,
      { options: debugOptions, targetLabels: debugTargets }
    );
    return false;
  }

  // radio (native inputs)
  if (type === 'radio') {
    const match = findExMatchingOption(field, answer);
    if (match) {
      let el = null;

      if (match.selector) {
        try { el = document.querySelector(match.selector); } catch (_) {}
      }

      if (!el && match.name) {
        el = Array.from(
          document.querySelectorAll(`input[type="radio"][name="${CSS.escape(match.name)}"]`)
        ).find(r => r.value.toLowerCase() === String(match.value || '').toLowerCase()) || null;
      }

      if (!el && match.name) {
        el = Array.from(
          document.querySelectorAll(`input[type="radio"][name="${CSS.escape(match.name)}"]`)
        ).find(r => getOptionLabel(r).toLowerCase() === String(match.label || '').toLowerCase()) || null;
      }

      if (el) {
        if (!el.checked) el.click();
        return await verifyRadioSelection(field, answer, el);
      }
    }

    console.warn(
      `[QuickFill] Radio no match: question="${String(field.question || field.label || '(unknown)')}" answer="${describeAnswerForLog(answer)}"`,
      {
        options: (field.options || []).slice(0, 5).map(o => typeof o === 'string' ? o : (o.label || o.value || String(o))),
      }
    );
    return false;
  }

  // select
  if (type === 'select') {
    const el = resolveElement(mainTarget);
    if (!el) return false;

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

    if (!match && /how many years|years of (relevant |work |related )?experience/i.test(
      String(field.question || field.label || '')
    )) {
      const num = parseFloat(String(answer));
      if (!isNaN(num)) {
        match = findExMatchingOption(field, String(num));
      }
    }

    if (!match) {
      console.warn('[QuickFill] Select no match:', {
        label: String(field.question || field.label || '(unknown)'),
        answer,
        options: (field.options || []).slice(0, 8).map(o => typeof o === 'string' ? o : (o.label || o.value || String(o))),
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

// ── FIX 1: AI field mapping ────────────────────────────────────────────────

function isGarbageLabel(text) {
  if (!text) return true;
  const t = text.trim();
  if (/^q_[a-f0-9]{8,}$/i.test(t)) return true;
  if (/^[a-f0-9]{20,}$/.test(t)) return true;
  if (/^\d{5,}$/.test(t)) return true;
  if (t.length < 3) return true;
  return false;
}

function mapExtractedFieldForAI(field, jobDesc = '') {
  const mainTarget = field.targets?.[0] || {};

  let labelText = field.question || field.label || '';

  if (isGarbageLabel(labelText)) {
    if (field.options && field.options.length) {
      const optSample = field.options.slice(0, 3).map(o =>
        typeof o === 'string' ? o : (o.label || o.value || '')
      ).join(' ');
      if (/canada|united states|australia/i.test(optSample)) labelText = 'Country';
      else if (/yes|no/i.test(optSample)) labelText = field.name || 'Yes/No question';
      else labelText = 'Select one option';
    } else {
      labelText = field.name || (mainTarget.name || '') || field.dom?.placeholder || 'Unknown field';
    }
  }

  const looksLikeExperienceSelect =
    field.type === 'select' &&
    /how many years|years of (relevant |work |related )?experience|years have you|amount of experience/i.test(labelText);

  return {
    label: labelText,
    name: mainTarget.name || field.dom?.name || '',
    placeholder: field.dom?.placeholder || '',
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
    _pageUrl:      location.pathname,
    _jobContext:   jobDesc,
    _originalType: field.type || '',
  };
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

    const ans = normalizeText(answer);
    let chosen = null;
    for (const [box, text] of options) {
      const t = normalizeText(text);
      if (t === ans || t.includes(ans) || ans.includes(t)) {
        chosen = box;
        break;
      }
    }

    if (!chosen && /^(yes|true|1)$/i.test(String(answer).trim())) {
      chosen = options.find(([, text]) => /^(yes|oui|true)$/i.test(text.trim()))?.[0] || null;
    }
    if (!chosen && /^(no|false|0)$/i.test(String(answer).trim())) {
      chosen = options.find(([, text]) => /^(no|non|false)$/i.test(text.trim()))?.[0] || null;
    }

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

    const ans = normalizeText(answer);
    for (const r of radios) {
      const rid  = r.id;
      const lbl  = rid ? document.querySelector(`label[for="${CSS.escape(rid)}"]`) : null;
      const text = normalizeText((lbl ? lbl.innerText.trim() : r.value) || '');
      if (text === ans || text.includes(ans) || ans.includes(text)) {
        if (!r.checked) r.click();
        return await verifyRadioSelection(field, answer, r);
      }
    }

    if (radios.length > 0 && !radios[0].checked) {
      radios[0].click();
      return await verifyRadioSelection(field, answer, radios[0]);
    }
    return false;
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
        return await verifyRadioSelection(field, answer, item.el);
      }
    }
    if (radioOpts.length) {
      clickElement(radioOpts[0].el);
      return await verifyRadioSelection(field, answer, radioOpts[0].el);
    }
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

function getFieldRequirementState(field) {
  const targets = Array.isArray(field?.targets) ? field.targets : [];
  const els = targets.map(resolveElement).filter(Boolean);
  const question = field?.question || field?.label || '';
  const reasons = new Set();

  if (field?.required) reasons.add('harvest-required');
  if (hasRequiredQuestionMarker(question)) reasons.add('question-*');

  for (const el of els) {
    for (const signal of getElementRequirementSignals(el, question)) {
      reasons.add(signal);
    }
  }

  const hasVisibleValidation = collectVisibleErrorUi(field).length > 0;
  if (hasVisibleValidation) reasons.add('visible-validation-text');

  const value = readFieldValue(field);
  const emptyArray = Array.isArray(value) && value.length === 0;
  const emptyValue = Array.isArray(value) ? emptyArray : !clean(value);

  if (field?.type === 'radio' && emptyValue && reasons.size > 0) {
    reasons.add('radio-required-no-selection');
  }

  return {
    required: reasons.size > 0,
    reasons: Array.from(reasons),
  };
}

const HARD_STOP_JUNK_TEXT = new Set([
  'n/a', 'na', 'none', 'no', 'nope', 'null', 'unknown', '-', '--', '.',
]);

function describeField(field, fallback = 'Untitled field') {
  return clean(field?.question || field?.label || field?.name || field?.dom?.name || fallback);
}

function isTextLikeField(field) {
  return ['text', 'textarea', 'email', 'tel', 'url', 'number'].includes(field?.type);
}

function isJunkTextValue(value) {
  const normalized = clean(value).toLowerCase();
  if (!normalized) return true;
  if (HARD_STOP_JUNK_TEXT.has(normalized)) return true;
  if (/^(test|asdf|qwerty|lorem ipsum)$/i.test(normalized)) return true;
  if (/^no[.!]*$/i.test(normalized)) return true;
  return false;
}

function collectFieldCandidateElements(field) {
  const out = [];
  const seen = new Set();

  const push = el => {
    if (!el || seen.has(el)) return;
    seen.add(el);
    out.push(el);
  };

  for (const target of Array.isArray(field?.targets) ? field.targets : []) {
    push(resolveElement(target));

    if (target?.name) {
      const selector =
        `${target.tag || ''}[name="${CSS.escape(target.name)}"], ` +
        `input[name="${CSS.escape(target.name)}"], ` +
        `textarea[name="${CSS.escape(target.name)}"], ` +
        `select[name="${CSS.escape(target.name)}"]`;
      try {
        for (const el of document.querySelectorAll(selector)) push(el);
      } catch (_) {}
    }

    if (target?.id) push(document.getElementById(target.id));
  }

  if (field?.id) {
    try { push(document.querySelector(`[data-__qf-id="${CSS.escape(field.id)}"]`)); } catch (_) {}
  }

  return out;
}

function readFieldValue(field) {
  const els = collectFieldCandidateElements(field);
  const visibleEls = els.filter(isVisible);
  const rankedEls = visibleEls.length ? visibleEls : els;

  if (field?.type === 'radio') {
    const checked = rankedEls.find(el =>
      el.getAttribute?.('aria-checked') === 'true' || el.checked === true
    );
    const match = field.options?.find(opt => {
      const label = typeof opt === 'string' ? opt : (opt?.label || opt?.value || '');
      return clean(label);
    });
    return checked
      ? clean(
          checked.getAttribute?.('aria-label') ||
          checked.closest?.('label')?.innerText ||
          (checked.id && document.querySelector(`label[for="${CSS.escape(checked.id)}"]`)?.innerText) ||
          checked.value ||
          match?.label ||
          ''
        )
      : '';
  }

  if (field?.type === 'checkbox_group' || field?.type === 'consent_checkbox_group') {
    return rankedEls.filter(el => el.checked).map(el => clean(
      el.closest?.('label')?.innerText ||
      (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText) ||
      el.value ||
      ''
    ));
  }

  if (!rankedEls.length) return Array.isArray(field?.answer) ? field.answer : clean(field?.answer || '');

  const values = rankedEls
    .map(el => {
      if (el.tagName === 'SELECT') return clean(el.value || el.selectedOptions?.[0]?.textContent || '');
      return clean(
        ('value' in el ? el.value : '') ||
        el.getAttribute?.('aria-valuetext') ||
        el.getAttribute?.('aria-label') ||
        el.innerText ||
        ''
      );
    })
    .filter(Boolean);

  if (!values.length) return Array.isArray(field?.answer) ? field.answer : clean(field?.answer || '');
  return values.sort((a, b) => b.length - a.length)[0];
}

function collectVisibleErrorUi(field) {
  const targets = Array.isArray(field?.targets) ? field.targets : [];
  const seen = new Set();
  const matches = [];

  for (const el of targets.map(resolveElement).filter(Boolean)) {
    const container = getFieldContainer(el);
    const state = getValidationState(el);
    if (state.isInvalid) {
      const key = `${describeField(field)}::${state.errorText || 'invalid'}`;
      if (!seen.has(key)) {
        seen.add(key);
        matches.push({
          field: describeField(field),
          message: state.errorText || 'Field shows invalid/error UI',
        });
      }
    }

    const nodes = container
      ? Array.from(container.querySelectorAll([
          '[role="alert"]',
          '.error', '.errors', '.error-text',
          '.invalid-feedback', '.help-block',
          '.artdeco-inline-feedback__message',
          '[aria-live="polite"]', '[aria-live="assertive"]',
        ].join(', ')))
      : [];

    for (const node of nodes) {
      const text = clean(node.textContent || '');
      if (!text) continue;
      if (!isVisible(node)) continue;
      const key = `${describeField(field)}::${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ field: describeField(field), message: text });
    }
  }

  return matches;
}

function scanBlockingFields(fields = collectFields()) {
  const result = {
    hasBlocking: false,
    requiredFields: [],
    unselectedRadios: [],
    textFields: [],
    visibleErrors: [],
    preFill: false,
  };

  const dedupe = {
    requiredFields: new Set(),
    unselectedRadios: new Set(),
    textFields: new Set(),
    visibleErrors: new Set(),
  };

  for (const field of fields) {
    const name = describeField(field);
    const invalidTargets = collectVisibleErrorUi(field);
    const requirementState = getFieldRequirementState(field);

    for (const err of invalidTargets) {
      const key = `${err.field}::${err.message}`;
      if (dedupe.visibleErrors.has(key)) continue;
      dedupe.visibleErrors.add(key);
      result.visibleErrors.push(err);
    }

    if (!requirementState.required) continue;

    const value = readFieldValue(field);
    const emptyArray = Array.isArray(value) && value.length === 0;
    const emptyValue = Array.isArray(value) ? emptyArray : !clean(value);

    if (field.type === 'radio' && emptyValue) {
      if (!dedupe.unselectedRadios.has(name)) {
        dedupe.unselectedRadios.add(name);
        result.unselectedRadios.push(name);
      }
    }

    if (isTextLikeField(field) && isJunkTextValue(Array.isArray(value) ? value.join(', ') : value)) {
      if (!dedupe.textFields.has(name)) {
        dedupe.textFields.add(name);
        result.textFields.push({
          field: name,
          value: Array.isArray(value) ? value.join(', ') : clean(value || ''),
        });
      }
    }

    const isBlocking =
      invalidTargets.length > 0 ||
      (field.type === 'radio' && emptyValue) ||
      (field.type === 'checkbox_group' && emptyArray) ||
      (field.type === 'consent_checkbox_group' && emptyArray) ||
      (field.type === 'select' && emptyValue) ||
      (isTextLikeField(field) && isJunkTextValue(Array.isArray(value) ? value.join(', ') : value)) ||
      (!isTextLikeField(field) && field.type !== 'radio' && emptyValue);

    if (isBlocking && !dedupe.requiredFields.has(name)) {
      dedupe.requiredFields.add(name);
      result.requiredFields.push(name);
    }
  }

  result.hasBlocking =
    result.requiredFields.length > 0 ||
    result.unselectedRadios.length > 0 ||
    result.textFields.length > 0 ||
    result.visibleErrors.length > 0;

  return result;
}

function summarizeBlockingFields(blockers) {
  const parts = [];
  if (blockers.requiredFields.length) {
    parts.push(`required: ${blockers.requiredFields.slice(0, 3).join(', ')}`);
  }
  if (blockers.unselectedRadios.length) {
    parts.push(`radios: ${blockers.unselectedRadios.slice(0, 3).join(', ')}`);
  }
  if (blockers.textFields.length) {
    parts.push(`text: ${blockers.textFields.slice(0, 3).map(item => item.field).join(', ')}`);
  }
  if (blockers.visibleErrors.length) {
    parts.push(`errors: ${blockers.visibleErrors.slice(0, 2).map(item => item.field).join(', ')}`);
  }
  return parts.join(' | ');
}

function getFieldBlockingState(field) {
  const invalidTargets = collectVisibleErrorUi(field);
  const requirementState = getFieldRequirementState(field);
  const value = readFieldValue(field);
  const emptyArray = Array.isArray(value) && value.length === 0;
  const emptyValue = Array.isArray(value) ? emptyArray : !clean(value);

  const blockingReasons = [];

  if (invalidTargets.length > 0) {
    blockingReasons.push(...invalidTargets.map(item => item.message || 'Visible error UI'));
  }

  if (requirementState.required) {
    if (field.type === 'radio' && emptyValue) blockingReasons.push('Required radio is unselected');
    else if (field.type === 'checkbox_group' && emptyArray) blockingReasons.push('Required checkbox group is empty');
    else if (field.type === 'consent_checkbox_group' && emptyArray) blockingReasons.push('Required checkbox group is empty');
    else if (field.type === 'select' && emptyValue) blockingReasons.push('Required select is empty');
    else if (isTextLikeField(field) && isJunkTextValue(Array.isArray(value) ? value.join(', ') : value)) {
      blockingReasons.push('Required text is empty or junk');
    } else if (!isTextLikeField(field) && field.type !== 'radio' && emptyValue) {
      blockingReasons.push('Required field is empty');
    }
  }

  return {
    stillBlocking: blockingReasons.length > 0,
    reasons: blockingReasons,
    value,
    required: requirementState.required,
    requiredSignals: requirementState.reasons,
  };
}

function formatFieldLogValue(value) {
  if (Array.isArray(value)) return value.length ? value.join(', ') : '[]';
  if (value == null) return 'null';
  const text = clean(String(value));
  return text || '""';
}

function appendFieldLifecycleLog(log, field, chosenAnswer, applied, blockingState) {
  const harvested = `${describeField(field)}${blockingState.required ? ' *' : ''}`;
  const chosen = Array.isArray(chosenAnswer)
    ? `[${chosenAnswer.map(v => formatFieldLogValue(v)).join(', ')}]`
    : formatFieldLogValue(chosenAnswer);
  const reasons = blockingState.reasons.length
    ? ` (${blockingState.reasons.slice(0, 2).join(' | ')})`
    : '';

  log = pushLog(log, `harvested: ${harvested}`);
  log = pushLog(log, `chosenAnswer: ${chosen}`);
  log = pushLog(log, `applied: ${applied}`);
  log = pushLog(log, `stillBlocking: ${blockingState.stillBlocking}${reasons}`);
  return log;
}

function appendConstraintFailureLog(log, field, chosenAnswer, reason, blockingState) {
  log = appendFieldLifecycleLog(log, field, chosenAnswer, false, blockingState);
  return pushLog(log, `constraintValidation: ${describeField(field)} → ${reason}`);
}

function normalizeOptionLabels(field) {
  return (field.options || [])
    .map(o => typeof o === 'string' ? o : (o.label || o.value || ''))
    .map(v => clean(String(v)))
    .filter(Boolean);
}

function validateAnswerAgainstFieldModel(field, answer) {
  if (answer == null || answer === '' || answer === '__SKIP__') {
    return field.required
      ? { ok: false, reason: 'required field cannot be skipped' }
      : { ok: true, normalizedAnswer: '__SKIP__' };
  }

  const type = field.type || field.tag || '';
  const options = normalizeOptionLabels(field);

  if (type === 'number') {
    const raw = Array.isArray(answer) ? answer[0] : answer;
    const text = clean(String(raw));
    return /^-?\d+(\.\d+)?$/.test(text)
      ? { ok: true, normalizedAnswer: text }
      : { ok: false, reason: 'numeric field received non-numeric answer' };
  }

  if (type === 'textarea') {
    const text = clean(Array.isArray(answer) ? answer.join(', ') : String(answer));
    if (!text) return field.required ? { ok: false, reason: 'required textarea is empty' } : { ok: true, normalizedAnswer: '' };
    if (/describe|tell us|about|explain|why/i.test(field.questionText || field.question || '') && text.split(/\s+/).length < 3) {
      return { ok: false, reason: 'descriptive textarea answer is too short' };
    }
    return { ok: true, normalizedAnswer: text };
  }

  if (type === 'checkbox_group' || type === 'consent_checkbox_group') {
    const values = Array.isArray(answer)
      ? answer.map(v => clean(String(v))).filter(Boolean)
      : clean(String(answer)).split(',').map(v => clean(v)).filter(Boolean);
    if (!values.length) return field.required ? { ok: false, reason: 'required checkbox group is empty' } : { ok: true, normalizedAnswer: [] };
    const invalid = values.find(v => !findExMatchingOption(field, v));
    return invalid
      ? { ok: false, reason: `checkbox option not allowed: ${invalid}` }
      : { ok: true, normalizedAnswer: values };
  }

  if (type === 'radio' || type === 'select' || field.tag === 'aria-radio') {
    const raw = clean(Array.isArray(answer) ? answer[0] : String(answer));
    if (!raw) return field.required ? { ok: false, reason: 'required option field is empty' } : { ok: true, normalizedAnswer: '' };
    const match = findExMatchingOption(field, raw);
    if (match) return { ok: true, normalizedAnswer: clean(match.label || match.value || raw) };
    if (/^(yes|no)$/i.test(raw) && options.length) {
      return { ok: false, reason: `answer "${raw}" did not match visible options: ${options.join(' / ')}` };
    }
    return { ok: false, reason: `option answer not allowed: ${raw}` };
  }

  const text = clean(Array.isArray(answer) ? answer.join(', ') : String(answer));
  return text
    ? { ok: true, normalizedAnswer: text }
    : { ok: false, reason: 'empty scalar answer' };
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
    const { _indeedOptions, _ariaOptions, ...rest } = f;
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
  try {
    chrome.runtime.sendMessage({ action: 'REPORT_FLOW_PROGRESS', state }, () => {
      void chrome.runtime.lastError;
    });
  } catch (_) {}
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
  return next.length > 200 ? next.slice(next.length - 200) : next;
}

// ─── Multi-step runner ─────────────────────────────────────────────────────

async function runMultiStepFlow(maxSteps = 12) {
  let totalFilled = 0;
  let log = [];
  let consecutiveZeroFill = 0;

  chrome.storage.local.set({ flowCancelled: false });
  reportProgress({
    status: 'running',
    step: 0,
    maxSteps,
    filled: 0,
    message: 'Starting…',
    log,
    startedAt: Date.now(),
    phase: FLOW_STATES.SCAN_PAGE,
    stats: { profile: 0, rule: 0, ai: 0, memory: 0, skipped: 0, detected: 0, answered: 0, applied: 0, verified: 0, valid: 0, invalid: 0, blocked: 0 },
  });

  const totalStats = { profile: 0, rule: 0, ai: 0, memory: 0, skipped: 0, detected: 0, answered: 0, applied: 0, verified: 0, valid: 0, invalid: 0, blocked: 0 };

  const _jobDesc = await _readCachedJobDescription();

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
    const pageInfo = classifyCurrentPage(pageText);
    log = pushLog(log, `📍 Step ${step + 1} – ${pageInfo.type}${pageInfo.reason ? ` (${pageInfo.reason})` : ''}`);
    reportProgress({
      status: 'running',
      step: step + 1,
      maxSteps,
      filled: totalFilled,
      message: `Step ${step + 1} – ${pageInfo.type}`,
      log,
      stats: totalStats,
      phase: FLOW_STATES.CLASSIFY_PAGE,
      pageType: pageInfo.type,
      pageReason: pageInfo.reason,
    });

    if (isSmartApplyPage() && getSmartApplyStep() === 'redirect') {
      await sleep(800);
      continue;
    }

    if (pageInfo.type === PAGE_TYPES.CAPTCHA_OR_BLOCKED) {
      log = pushLog(log, `✗ Blocked by captcha or access wall`);
      reportProgress({
        status: 'error',
        step: step + 1,
        maxSteps,
        filled: totalFilled,
        message: 'Blocked by captcha or access check',
        log,
        stats: totalStats,
        phase: FLOW_STATES.BLOCKED,
        pageType: pageInfo.type,
      });
      return { ok: false, submitted: false, totalFilled, error: 'Captcha or blocked page detected', pageType: pageInfo.type };
    }

    if (pageInfo.type === PAGE_TYPES.REQUIREMENT_WARNING) {
      log = pushLog(log, `⚠ Step ${step + 1} – Requirements warning, clicking Apply Anyway`);
      reportProgress({
        status: 'running',
        step: step + 1,
        maxSteps,
        filled: totalFilled,
        message: 'Bypassing requirements warning…',
        log,
        stats: totalStats,
        phase: FLOW_STATES.NAVIGATE,
        pageType: pageInfo.type,
      });
      const btn = findApplyAnywayButton();
      if (btn) {
        await safeNavigate(btn, beforeSnapshot);
        continue;
      }
    }

    if (pageInfo.type === PAGE_TYPES.REVIEW_PAGE) {
      log = pushLog(log, `🏁 Reached review page — stopping before final submission`);
      reportProgress({
        status: 'done',
        step: step + 1,
        maxSteps,
        filled: totalFilled,
        message: 'Reached review page — review and submit manually',
        log,
        stats: totalStats,
        phase: FLOW_STATES.DONE,
        pageType: pageInfo.type,
        stoppedAtSubmit: true,
      });
      return { ok: true, submitted: false, stoppedAtSubmit: true, totalFilled, steps: step + 1, pageType: pageInfo.type };
    }

    if (pageInfo.type !== PAGE_TYPES.RELEVANT_EXPERIENCE_JOB) {
      let fields = collectFields(pageInfo.type);
      if (fields.length === 0) {
        await sleep(400);
        fields = collectFields(pageInfo.type);
      }

      if (fields.length > 0) {
        totalStats.detected += fields.length;
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
          phase: FLOW_STATES.BUILD_FIELD_MODELS,
          pageType: pageInfo.type,
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

        const preFillBlockers = scanBlockingFields(fields);
        const preFillSummary = summarizeBlockingFields(preFillBlockers);
        log = pushLog(
          log,
          preFillBlockers.hasBlocking
            ? `⚠ Pre-fill validation scan — blocking fields detected${preFillSummary ? ` (${preFillSummary})` : ''}`
            : '✓ Pre-fill validation scan — no blocking fields detected'
        );
        reportProgress({
          status: 'running',
          step: step + 1,
          maxSteps,
          filled: totalFilled,
          message: 'Scanning required fields before fill…',
          log,
          stats: totalStats,
          phase: FLOW_STATES.CHECK_ERRORS,
          preFillBlockers,
        });

        const aiReadyFields = fields.map(f => mapExtractedFieldForAI(f, _jobDesc));

        const aiResp = await Promise.race([
          requestAiAnswers(aiReadyFields),
          new Promise(res => setTimeout(() => res({ ok: false, answers: [], error: 'timeout' }), 4000)),
        ]);
        const answers = aiResp?.answers || [];

        const allNetworkErrors = answers.length > 0 &&
          answers.every(a => a.source === 'network_error' || a.source === 'skipped') &&
          answers.some(a => a.source === 'network_error');

        if (allNetworkErrors && fields.length > 0) {
          log = pushLog(log, `✗ Ollama appears to be offline — all fields skipped`);
          reportProgress({
            status: 'error',
            step: step + 1,
            maxSteps,
            filled: totalFilled,
            message: 'Ollama offline — start Ollama and try again',
            log,
            stats: totalStats,
          });
          return { ok: false, submitted: false, totalFilled, error: 'Ollama offline' };
        }

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
          let chosenAnswer = answer;
          let applied = false;

          if (answer == null || answer === '' || answer === '__SKIP__') {
            const blockingState = getFieldBlockingState(field);
            if (blockingState.stillBlocking) totalStats.blocked++;
            log = appendFieldLifecycleLog(log, field, answer == null || answer === '' ? '__SKIP__' : answer, false, blockingState);
            continue;
          }

          if (Array.isArray(answer)) {
            answer = answer
              .map(v => (v == null ? '' : String(v).trim()))
              .filter(Boolean);
            if (!answer.length) {
              const blockingState = getFieldBlockingState(field);
              log = appendFieldLifecycleLog(log, field, '__SKIP__', false, blockingState);
              continue;
            }
          } else if (typeof answer === 'string') {
            answer = answer.trim();
            if (!answer) {
              const blockingState = getFieldBlockingState(field);
              log = appendFieldLifecycleLog(log, field, '__SKIP__', false, blockingState);
              continue;
            }
          } else if (typeof answer === 'number' || typeof answer === 'boolean') {
            answer = String(answer);
          } else {
            console.warn('Skipping invalid non-serializable answer', {
              field,
              resolved,
              answerType: typeof answer,
            });
            const blockingState = getFieldBlockingState(field);
            log = appendFieldLifecycleLog(log, field, '__SKIP__', false, blockingState);
            continue;
          }

          if (field.type === 'checkbox_group' && typeof answer === 'string') {
            answer = answer
              .split(',')
              .map(s => s.trim())
              .filter(Boolean);
            if (!answer.length) {
              const blockingState = getFieldBlockingState(field);
              log = appendFieldLifecycleLog(log, field, '__SKIP__', false, blockingState);
              continue;
            }
          }

          chosenAnswer = answer;

          const validation = validateAnswerAgainstFieldModel(field, answer);
          if (!validation.ok) {
            totalStats.invalid++;
            const blockingState = getFieldBlockingState(field);
            log = appendConstraintFailureLog(log, field, answer, validation.reason, blockingState);
            continue;
          }

          answer = validation.normalizedAnswer;
          chosenAnswer = answer;
          totalStats.answered++;

          try {
            applied = field.targets?.length
              ? await applyAnswerToField(field, answer)
              : await applyAnswer(field, answer);
            if (applied) {
              filled++;
              totalStats.applied++;
            }
          } catch (err) {
            console.warn('applyAnswerToField failed', {
              field,
              resolved,
              normalizedAnswer: answer,
              error: err?.message || err,
            });
          }

          const blockingState = getFieldBlockingState(field);
          if (applied) totalStats.verified++;
          if (blockingState.stillBlocking) {
            totalStats.invalid++;
            totalStats.blocked++;
          } else if (applied) {
            totalStats.valid++;
          }
          log = appendFieldLifecycleLog(log, field, chosenAnswer, applied, blockingState);
        }

        totalFilled += filled;

        if (filled === 0 && fields.length > 0) {
          consecutiveZeroFill++;
          if (consecutiveZeroFill >= 2) {
            log = pushLog(log, `✗ Form stuck — 0/${fields.length} filled for ${consecutiveZeroFill} steps. Required fields need manual input or AI unavailable.`);
            reportProgress({
              status: 'error',
              step: step + 1,
              maxSteps,
              filled: totalFilled,
              message: 'Form stuck — required fields could not be auto-filled. Check the Logs tab.',
              log,
              stats: totalStats,
              phase: FLOW_STATES.BLOCKED,
              pageType: pageInfo.type,
            });
            return { ok: false, submitted: false, totalFilled, steps: step + 1, error: 'Form stuck — 0 fields filled for 2+ consecutive steps' };
          }
        } else {
          consecutiveZeroFill = 0;
        }

        const blockers = scanBlockingFields();
        if (blockers.hasBlocking) {
          const blockerSummary = summarizeBlockingFields(blockers);
          log = pushLog(log, `⚠ Blocking fields still detected after fill${blockerSummary ? ` (${blockerSummary})` : ''} — trying Continue anyway`);
          reportProgress({
            status: 'running',
            step: step + 1,
            maxSteps,
            filled: totalFilled,
            message: 'Some fields still look blocked — trying Continue anyway',
            log,
            stats: totalStats,
            phase: FLOW_STATES.VERIFY_FIELDS,
            blockers,
            pageType: pageInfo.type,
          });
        }

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
          phase: FLOW_STATES.VERIFY_FIELDS,
          pageType: pageInfo.type,
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
          phase: FLOW_STATES.NAVIGATE,
          pageType: pageInfo.type,
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
        phase: FLOW_STATES.NAVIGATE,
        pageType: pageInfo.type,
      });
    }

    const blockers = scanBlockingFields();
    if (blockers.hasBlocking) {
      const blockerSummary = summarizeBlockingFields(blockers);
      log = pushLog(log, `⚠ Blocking fields remain before continue${blockerSummary ? ` (${blockerSummary})` : ''} — letting page validation decide`);
      reportProgress({
        status: 'running',
        step: step + 1,
        maxSteps,
        filled: totalFilled,
        message: 'Trying Continue with remaining blockers',
        log,
        stats: totalStats,
        phase: FLOW_STATES.NAVIGATE,
        blockers,
        pageType: pageInfo.type,
      });
    }

    const submitBtn = findSubmitButton();
    if (submitBtn) {
      log = pushLog(log, `🏁 Reached terminal review state — ${totalFilled} field${totalFilled === 1 ? '' : 's'} filled`);
      reportProgress({
        status: 'done',
        step: step + 1,
        maxSteps,
        filled: totalFilled,
        message: 'Reached submit page — review and submit manually',
        log,
        stoppedAtSubmit: true,
        stats: totalStats,
        phase: FLOW_STATES.DONE,
        pageType: PAGE_TYPES.REVIEW_PAGE,
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
        phase: FLOW_STATES.BLOCKED,
        pageType: pageInfo.type,
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
      log = pushLog(log, `🏁 Submit button detected — stopping for manual review`);
      reportProgress({
        status: 'done',
        step: step + 1,
        maxSteps,
        filled: totalFilled,
        message: 'Submit button detected — review and submit manually',
        log,
        stats: totalStats,
        phase: FLOW_STATES.DONE,
        pageType: PAGE_TYPES.REVIEW_PAGE,
        stoppedAtSubmit: true,
      });
      return { ok: true, submitted: false, stoppedAtSubmit: true, totalFilled, steps: step + 1 };
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
      phase: FLOW_STATES.NAVIGATE,
      pageType: pageInfo.type,
    });
    await safeNavigate(btn, beforeSnapshot);

    const afterSnapshot = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 800);
    const pageActuallyChanged = afterSnapshot !== beforeSnapshot.slice(0, 800);

    if (!pageActuallyChanged) {
      const afterText = getPageText();
      const afterPageInfo = classifyCurrentPage(afterText);
      const blockersAfterNav = scanBlockingFields();
      const blockerSummary = summarizeBlockingFields(blockersAfterNav);
      log = pushLog(log, `⚠ Step ${step + 1} – Page did not change after clicking "${getBtnText(btn)}"`);
      if (afterPageInfo.type === pageInfo.type) {
        log = pushLog(log, `✗ Navigation blocked on ${afterPageInfo.type}${blockerSummary ? ` (${blockerSummary})` : ''}`);
        reportProgress({
          status: 'error',
          step: step + 1,
          maxSteps,
          filled: totalFilled,
          message: 'Navigation blocked — page did not advance',
          log,
          stats: totalStats,
          phase: FLOW_STATES.BLOCKED,
          pageType: afterPageInfo.type,
          blockers: blockersAfterNav,
        });
        return { ok: false, submitted: false, totalFilled, error: 'Navigation stuck', pageType: afterPageInfo.type, blockers: blockersAfterNav };
      }
      continue;
    }
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
    sendResponse({ fields: collectFields() });
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
    const fields = collectFields();
    console.log('[QuickFill DEBUG] Fields found:', JSON.stringify(fields, null, 2));
    sendResponse({ fields });
    return;
  }

});

} // end window.__qfLoaded guard

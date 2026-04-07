(() => {
  'use strict';

  if (window.__indeedExporterLoaded) return;
  window.__indeedExporterLoaded = true;

  const isInIframe = window !== window.top;
  const isSmartApply = location.hostname.includes('smartapply.indeed.com');
  const shouldShowButton = isInIframe || isSmartApply;

  const BUTTON_ID = 'indeed-exporter-btn';
  const PANEL_ID = 'indeed-exporter-status';

  // ── primitive helpers ─────────────────────────────────────────────────────

  const isElement = (n) => n instanceof Element;

  const isVisible = (el) => {
    if (!isElement(el)) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  };

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
      height: Math.round(r.height)
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
        if (cur.classList && cur.classList.length) {
          sel += '.' + Array.from(cur.classList).slice(0, 2).map(c => CSS.escape(c)).join('.');
        }
        const parent = cur.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(c => c.nodeName === cur.nodeName);
          if (siblings.length > 1) sel += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
        }
        parts.unshift(sel);
        cur = cur.parentElement;
      }
      return parts.join(' > ');
    } catch (_) {
      return '';
    }
  };

  const JUNK = [
    'search', 'captcha', 'recaptcha', 'save and close',
    'continue', 'tell us more', 'export indeed data'
  ];

  const OPTION_ONLY_TEXT = /^(yes|no|other|select an option|canada|usa|another country|annually|hourly|monthly|weekly)$/i;

  // ── layer 1: indeed-aware containers ─────────────────────────────────────

  const getIndeedQuestionItem = (el) =>
    isElement(el) ? (el.closest('.ia-Questions-item') || null) : null;

  const getFieldset = (el) =>
    isElement(el) ? (el.closest('fieldset') || null) : null;

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

    return clean(best)
      .replace(/\s+(Yes|No|Other)(\s+(Yes|No|Other))*$/i, '')
      .trim();
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
        item.querySelector('label')
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

  const isRequired = (el, question) =>
    !!(el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(question || ''));

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

  const isRealQuestionField = (el) => {
    if (!isElement(el) || !isVisible(el)) return false;
    if (el.disabled || el.readOnly) return false;
    if (el.closest(`#${BUTTON_ID}`)) return false;

    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();

    const allowed = ['input', 'textarea', 'select'].includes(tag) || isFakeCombo(el);
    if (!allowed) return false;
    if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) return false;

    const blob = [
      findLabel(el), el.getAttribute('name'), el.id,
      el.getAttribute('placeholder'), el.getAttribute('data-testid')
    ].join(' ').toLowerCase();

    return !JUNK.some(w => blob.includes(w));
  };

  // ── dom snapshot helper ───────────────────────────────────────────────────

  const domSnapshot = (el, container) => ({
    selector: cssPath(el),
    containerSelector: cssPath(container),
    id: el.id || '',
    name: el.getAttribute('name') || el.name || '',
    className: typeof el.className === 'string' ? el.className : '',
    role: el.getAttribute('role') || '',
    dataTestId: el.getAttribute('data-testid') || '',
    placeholder: el.getAttribute('placeholder') || '',
    ariaLabel: el.getAttribute('aria-label') || '',
    ariaDescribedBy: el.getAttribute('aria-describedby') || '',
    ariaRequired: el.getAttribute('aria-required') || '',
    ariaInvalid: el.getAttribute('aria-invalid') || '',
    autocomplete: el.getAttribute('autocomplete') || '',
    inputMode: el.getAttribute('inputmode') || '',
    visible: isVisible(el),
    disabled: !!el.disabled,
    readOnly: !!el.readOnly,
    multiple: !!el.multiple,
    min: el.getAttribute('min') || '',
    max: el.getAttribute('max') || '',
    step: el.getAttribute('step') || '',
    pattern: el.getAttribute('pattern') || '',
    maxLength: typeof el.maxLength === 'number' ? el.maxLength : null,
    rect: getBoundedRect(container)
  });

  // ── harvesters ────────────────────────────────────────────────────────────

  const harvestRadioGroup = (el) => {
    const name = el.name;
    if (!name) return null;

    const group = Array.from(
      document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`)
    ).filter(isRealQuestionField);

    if (!group.length) return null;

    const first = group[0];
    const container = getQuestionContainer(first);
    const question =
      getLegendText(getFieldset(first)) ||
      getQuestionText(first) ||
      findLabel(first);

    if (!question || question.length < 5) return null;

    const options = group.map(input => ({
      label: getOptionLabel(input),
      value: input.value || '',
      checked: !!input.checked,
      selector: cssPath(input),
      id: input.id || '',
      name: input.name || ''
    }));

    return {
      question,
      type: 'radio',
      tag: 'input',
      required: isRequired(first, question),
      answer: options.find(o => o.checked)?.label || options.find(o => o.checked)?.value || '',
      options,
      dom: domSnapshot(first, container),
      section: getSection(first),
      validationMessage: getValidationMessage(first),
      targets: group.map(input => ({
        selector: cssPath(input),
        id: input.id || '',
        name: input.name || '',
        tag: 'input',
        type: 'radio'
      }))
    };
  };

  const harvestCheckboxGroup = (el) => {
    const name = el.name;
    if (!name) return null;

    const group = Array.from(
      document.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(name)}"]`)
    ).filter(isRealQuestionField);

    if (!group.length) return null;

    const first = group[0];
    const container = getQuestionContainer(first);
    const fieldset = getFieldset(first);
    const question =
      getLegendText(fieldset) ||
      getQuestionText(first) ||
      findLabel(first);

    if (!question || question.length < 5) return null;

    const consent = isConsentBlock(fieldset, question);

    const options = group.map(input => ({
      label: getOptionLabel(input),
      value: input.value || '',
      checked: !!input.checked,
      selector: cssPath(input),
      id: input.id || '',
      name: input.name || ''
    }));

    return {
      question,
      type: consent ? 'consent_checkbox_group' : 'checkbox_group',
      tag: 'input',
      required: group.some(i => i.required) || isRequired(first, question),
      answer: options.filter(o => o.checked).map(o => o.label || o.value),
      options,
      singleChoiceLikely: !consent && isLikelySingleChoiceCheckboxGroup(question, options),
      dom: domSnapshot(first, container),
      section: getSection(first),
      validationMessage: getValidationMessage(first),
      targets: group.map(input => ({
        selector: cssPath(input),
        id: input.id || '',
        name: input.name || '',
        tag: 'input',
        type: 'checkbox'
      }))
    };
  };

  const harvestNativeSelect = (el) => {
    const question = findLabel(el);
    const container = getQuestionContainer(el);
    const options = Array.from(el.options)
      .map((opt, idx) => ({
        index: idx,
        label: clean(opt.textContent),
        value: opt.value,
        selected: opt.selected
      }))
      .filter(o => o.label || o.value);

    return {
      question,
      type: 'select',
      tag: 'select',
      required: isRequired(el, question),
      answer: el.value || '',
      options,
      dom: domSnapshot(el, container),
      section: getSection(el),
      validationMessage: getValidationMessage(el),
      targets: [{ selector: cssPath(el), id: el.id || '', name: el.name || '', tag: 'select', type: 'select' }]
    };
  };

  const harvestFakeCombobox = (el) => {
    const question = findLabel(el);
    const container = getQuestionContainer(el);
    const options = Array.from(container.querySelectorAll('[role="option"], option'))
      .map((node, idx) => ({
        index: idx,
        label: clean(node.innerText || node.textContent || ''),
        value: node.getAttribute('data-value') || node.getAttribute('value') || clean(node.innerText || node.textContent || ''),
        selected: node.getAttribute('aria-selected') === 'true'
      }))
      .filter(o => o.label || o.value);

    return {
      question,
      type: 'select',
      tag: el.tagName.toLowerCase(),
      required: isRequired(el, question),
      answer: clean(el.innerText || el.textContent || '') || el.getAttribute('aria-label') || '',
      options,
      dom: domSnapshot(el, container),
      section: getSection(el),
      validationMessage: getValidationMessage(el),
      targets: [{
        selector: cssPath(el), id: el.id || '',
        name: el.getAttribute('name') || '', tag: el.tagName.toLowerCase(), type: 'select'
      }]
    };
  };

  const looksNumeric = (el, question) => {
    const type = (el.getAttribute('type') || '').toLowerCase();
    const min = el.getAttribute('min');
    const max = el.getAttribute('max');
    const step = el.getAttribute('step');
    if (type === 'number') return true;
    if (/how many|years of|experience|amount|salary/i.test(question || '')) return true;
    if ((min && !Number.isNaN(Number(min))) || (max && !Number.isNaN(Number(max)))) return true;
    if (step && step !== 'any' && !Number.isNaN(Number(step))) return true;
    return false;
  };

  const harvestSingleField = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') return harvestNativeSelect(el);
    if (isFakeCombo(el)) return harvestFakeCombobox(el);

    const type = (el.getAttribute('type') || '').toLowerCase();
    const question = findLabel(el);
    const container = getQuestionContainer(el);

    if (!question || question.length < 3) return null;

    let fieldType = type || tag;
    if ((fieldType === 'text' || fieldType === 'textarea' || fieldType === 'input') && looksNumeric(el, question)) {
      fieldType = 'number';
    }

    return {
      question,
      type: fieldType,
      tag,
      required: isRequired(el, question),
      answer: ('value' in el ? el.value : '') || '',
      options: [],
      dom: domSnapshot(el, container),
      section: getSection(el),
      validationMessage: getValidationMessage(el),
      targets: [{ selector: cssPath(el), id: el.id || '', name: el.name || '', tag, type: type || tag }]
    };
  };

  // ── follow-up linking ─────────────────────────────────────────────────────

  const attachOtherFollowups = (fields) => {
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
  };

  // ── collector ─────────────────────────────────────────────────────────────

  const collectFields = () => {
    const nodes = Array.from(document.querySelectorAll(
      'input, textarea, select, [role="combobox"], [aria-haspopup="listbox"]'
    )).filter(isRealQuestionField);

    const seen = new Set();
    const fields = [];

    for (const el of nodes) {
      const type = (el.getAttribute('type') || '').toLowerCase();
      const name = el.getAttribute('name') || '';
      let field = null;

      if (type === 'radio') {
        const key = `radio:${name || cssPath(el)}`;
        if (seen.has(key)) continue;
        field = harvestRadioGroup(el);
        if (field) seen.add(key);
      } else if (type === 'checkbox') {
        const key = `checkbox:${name || cssPath(el)}`;
        if (seen.has(key)) continue;
        field = harvestCheckboxGroup(el);
        if (field) seen.add(key);
      } else {
        const key = `${el.tagName.toLowerCase()}:${el.id || name || cssPath(el)}`;
        if (!key || seen.has(key)) continue;
        field = harvestSingleField(el);
        if (field) seen.add(key);
      }

      if (field) fields.push(field);
    }

    return attachOtherFollowups(fields);
  };

  // ── export ────────────────────────────────────────────────────────────────

  const buildExport = () => ({
    exportedAt: new Date().toISOString(),
    page: { title: document.title, url: location.href },
    fields: collectFields()
  });

  const downloadJson = (data) => {
    const filename = `indeed_export_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return filename;
  };

  // ── answer engine ─────────────────────────────────────────────────────────

  // Low-level helper: pick first option whose label contains any keyword
  const pickOption = (field, keywords = []) => {
    const opts = field.options || [];
    for (const opt of opts) {
      const label = (opt.label || '').toLowerCase();
      for (const k of keywords) {
        if (label.includes(k.toLowerCase())) return opt.label;
      }
    }
    return '';
  };

  // Fuzzy option matcher: exact → substring → token overlap → first non-placeholder
  const pickBestMatchingOption = (field, answer) => {
    const opts = (field.options || []).filter(o => o.label && o.value !== '');
    if (!opts.length) return '';
    const a = answer.toLowerCase().trim();

    // exact match
    const exact = opts.find(o => o.label.toLowerCase() === a);
    if (exact) return exact.label;

    // substring either way
    const sub = opts.find(o =>
      o.label.toLowerCase().includes(a) || a.includes(o.label.toLowerCase())
    );
    if (sub) return sub.label;

    // token overlap — split both into words and count shared tokens
    const aTokens = new Set(a.split(/\W+/).filter(Boolean));
    let best = null;
    let bestScore = 0;
    for (const opt of opts) {
      const oTokens = opt.label.toLowerCase().split(/\W+/).filter(Boolean);
      const shared = oTokens.filter(t => aTokens.has(t)).length;
      if (shared > bestScore) { bestScore = shared; best = opt; }
    }
    if (best && bestScore > 0) return best.label;

    return '';
  };

  // ── Step 1: classify by question meaning ──────────────────────────────────

  const classifyField = (field) => {
    const q = (field.question || '').toLowerCase();

    if (field.type === 'consent_checkbox_group') return 'consent';

    if (/driver.?s licen|class \d+ licen/.test(q))                         return 'license_yes_no';
    if (/willing to travel|travel within canada|travel.*u\.s/.test(q))     return 'travel_yes_no';
    if (/how many years/.test(q))                                           return 'years_experience';
    if (/briefly describe your experience|describe your experience/.test(q)) return 'experience_short_text';
    if (/legally entitled|authorized to work|work in canada/.test(q))      return 'work_auth';
    if (/require sponsorship|sponsorship to work/.test(q))                  return 'sponsorship';
    if (/currently based in|what country/.test(q))                          return 'country';
    if (/which city/.test(q))                                               return 'city';
    if (/interview/.test(q) && /dates|time range|availab/.test(q))         return 'interview_availability';
    if (/hear about this opportunity|how did you hear/.test(q))             return 'source';
    if (/onsite|on-site|on site|work full.time onsite/.test(q))            return 'onsite_preference';
    if (/commute|relocate/.test(q))                                         return 'commute_or_relocate';
    if (/employee at|worked with|worked for/.test(q) && /past|before|previously/.test(q)) return 'previous_employee';
    if (/education|highest level|degree/.test(q))                           return 'education';
    if (/linkedin/.test(q))                                                 return 'linkedin';
    if (/salary|compensation|expectation/.test(q))                          return 'salary';
    if (/currency/.test(q))                                                 return 'currency';
    if (/pay period|pay frequency/.test(q))                                 return 'pay_period';
    if (/why are you interested|why do you want|why this role/.test(q))    return 'why_interested';
    if (/years of .* experience/.test(q))                                   return 'years_experience';

    return 'unknown';
  };

  // ── Step 2: resolve answer by semantic category ────────────────────────────

  const resolveAnswerByCategory = (field, category, profile) => {
    switch (category) {

      case 'license_yes_no':
        return 'Yes';

      case 'travel_yes_no':
        return 'Yes';

      case 'years_experience':
        return String(profile.defaultYears ?? profile.yearsExperience ?? 3);

      case 'experience_short_text': {
        // Pick a tailored summary based on question keywords
        const q = (field.question || '').toLowerCase();
        if (/presentation|demo|lunch.and.learn|trade show|zoom/.test(q)) {
          return profile.presentationSummary ||
            'I have experience presenting products and solutions to clients through meetings, demos, and follow-up conversations. I am comfortable tailoring presentations to different audiences and have led lunch-and-learns and trade show walkthroughs.';
        }
        if (/architect|interior design|engineer|contractor|electrical|wholesaler/.test(q)) {
          return profile.tradeSummary ||
            'I have experience engaging with architects, contractors, and electrical distributors in a B2B capacity. I understand the specification-driven purchasing process and how to position products effectively within those channels.';
        }
        return profile.salesSummary ||
          'I have experience presenting products and solutions to clients through meetings, demos, and follow-up conversations, and I am comfortable tailoring my approach to different audiences and decision-makers.';
      }

      case 'work_auth':
        return pickOption(field, ['yes']) || 'Yes';

      case 'sponsorship':
        // "Do you currently require sponsorship?" → No
        return pickOption(field, ['no']) || 'No';

      case 'country':
        return pickOption(field, ['canada']) || profile.country || 'Canada';

      case 'city':
        return profile.city || 'Surrey';

      case 'interview_availability':
        return profile.interviewDates || [
          'April 8: 10:00 AM – 1:00 PM',
          'April 9: 1:00 PM – 4:00 PM',
          'April 10: 9:00 AM – 12:00 PM'
        ].join('\n');

      case 'consent':
        return (field.options || []).map(o => o.label);

      case 'source':
        return pickOption(field, ['indeed', 'third party', 'linkedin', 'job board']) ||
               (field.options || []).filter(o => o.value)[0]?.label || '';

      case 'onsite_preference':
        return pickOption(field, [
          profile.onsitePreference || 'hybrid',
          'remote',
          'onsite (locally based)'
        ]) || '';

      case 'commute_or_relocate':
        return pickOption(field, ['make the commute', 'commute', 'yes, i can']) || '';

      case 'previous_employee':
        // singleChoiceLikely group — pick the "never" option
        return pickOption(field, ['never worked', 'never', 'no,']) || '';

      case 'education':
        return pickOption(field, [
          profile.education || 'bachelor',
          'degree',
          'post-secondary'
        ]) || (field.options || []).filter(o => o.value)[0]?.label || '';

      case 'linkedin':
        return profile.linkedin || '';

      case 'salary':
        return String(profile.salaryExpectation || 60000);

      case 'currency':
        return pickOption(field, ['cad', 'canadian']) || '';

      case 'pay_period':
        return pickOption(field, ['annually', 'yearly']) || '';

      case 'why_interested':
        return profile.whyInterested ||
          'I am interested in this role because it aligns with my background and problem-solving strengths. I am eager to contribute to a team where I can keep learning and add value quickly.';

      default:
        return '';
    }
  };

  // ── Step 3: normalize to the actual field type ─────────────────────────────

  const normalizeAnswerForField = (field, answer) => {
    if (answer == null) return '';

    // Consent and multi-checkbox always return an array
    if (field.type === 'consent_checkbox_group') {
      return Array.isArray(answer) ? answer : [String(answer)];
    }

    if (field.type === 'checkbox_group') {
      return Array.isArray(answer) ? answer : [String(answer)];
    }

    if (field.type === 'radio' || field.type === 'select') {
      return pickBestMatchingOption(field, String(answer));
    }

    // Only coerce to a numeric string when the actual DOM element is a number
    // input — NOT when it's a textarea that looksNumeric() mis-classified.
    if (field.type === 'number' && field.tag !== 'textarea') {
      const n = String(answer).match(/\d+(\.\d+)?/);
      return n ? n[0] : '';
    }

    // textarea / text (including mis-classified 'number' textareas)
    return String(answer).trim();
  };

  // Guard against obviously bad answers
  const isBadAnswer = (field, answer) => {
    if (answer === null || answer === undefined) return true;
    if (Array.isArray(answer)) return answer.length === 0;
    const a = String(answer).trim().toLowerCase();
    if (!a) return true;
    if (a === 'n/a' && field.required) return true;
    if (a.includes('as an ai')) return true;
    if (a.includes('i do not know')) return true;
    // Only flag NaN for true numeric inputs (not mis-classified textareas)
    if (field.type === 'number' && field.tag !== 'textarea' && isNaN(Number(a))) return true;
    return false;
  };

  // ── Main resolution pipeline: classify → resolve → normalize → guard ───────

  const resolveBestAnswer = (field, profile = {}) => {
    const category = classifyField(field);
    let answer = resolveAnswerByCategory(field, category, profile);
    answer = normalizeAnswerForField(field, answer);
    if (isBadAnswer(field, answer)) return '';
    return answer;
  };

  // ── fill engine ───────────────────────────────────────────────────────────

  const fillField = (field, answer) => {
    if (!answer && answer !== 0) return;
    if (Array.isArray(answer) && answer.length === 0) return;

    const type = field.type;

    // consent + multi checkbox
    if (type === 'consent_checkbox_group' || (type === 'checkbox_group' && Array.isArray(answer))) {
      const labels = Array.isArray(answer) ? answer : [answer];
      for (const opt of field.options || []) {
        if (labels.includes(opt.label)) {
          const el = document.querySelector(opt.selector);
          if (el && !el.checked) el.click();
        }
      }
      return;
    }

    // radio + single-choice checkbox
    if (type === 'radio' || type === 'checkbox_group') {
      const match = (field.options || []).find(o => o.label === answer);
      if (match) {
        const el = document.querySelector(match.selector);
        if (el && !el.checked) el.click();
      }
      return;
    }

    // select
    if (type === 'select') {
      const target = field.targets?.[0];
      if (!target) return;
      const el = document.querySelector(target.selector);
      if (!el) return;
      const match = (field.options || []).find(o => o.label === answer);
      if (match) {
        el.value = match.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }

    // text / textarea / number
    if (['text', 'textarea', 'number', 'email', 'tel', 'url'].includes(type)) {
      const target = field.targets?.[0];
      if (!target) return;
      const el = document.querySelector(target.selector);
      if (!el) return;
      el.focus();
      el.value = String(answer);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    }
  };

  // Verify a fill actually stuck
  const verifyFilled = (field, answer) => {
    const target = field.targets?.[0];
    if (!target) return false;
    const el = document.querySelector(target.selector);
    if (!el) return false;

    if (['text', 'textarea', 'number'].includes(field.type)) {
      return String(el.value || '').trim() === String(answer).trim();
    }
    if (field.type === 'radio') {
      const match = field.options?.find(o => o.label === answer);
      const optEl = match ? document.querySelector(match.selector) : null;
      return !!optEl?.checked;
    }
    if (field.type === 'select') {
      return String(el.value || '').trim() !== '';
    }
    return true;
  };

  // ── AI bridge ─────────────────────────────────────────────────────────────

  /**
   * Map the new extractor's field shape → the shape background.js expects.
   * Preserves __rawField so we can apply answers to the original targets later.
   */
  const mapExtractedFieldForAI = (field) => {
    const mainTarget = field.targets?.[0] || {};
    return {
      label:        field.question || '',
      name:         mainTarget.name || field.dom?.name || '',
      placeholder:  field.dom?.placeholder || '',
      type:         field.type || mainTarget.type || '',
      tag:          field.tag  || mainTarget.tag  || '',
      options:      (field.options || []).map(opt => opt.label || opt.value).filter(Boolean),
      currentValue: field.answer || '',
      required:     !!field.required,
      __rawField:   field,
    };
  };

  /**
   * Send mapped fields to background.js (GET_AI_ANSWERS_ONLY) and return answers[].
   * Resolves to [] on any error.
   */
  const getAiAnswersForExtractedFields = (extractedFields) => {
    if (typeof chrome === 'undefined' || !chrome?.runtime?.sendMessage) return Promise.resolve([]);

    const aiFields = extractedFields.map(mapExtractedFieldForAI);

    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { action: 'GET_AI_ANSWERS_ONLY', fields: aiFields },
          (response) => {
            if (chrome.runtime.lastError) {
              console.warn('[Indeed Autofill] background error:', chrome.runtime.lastError.message);
              resolve([]);
              return;
            }
            if (!response?.ok) {
              console.warn('[Indeed Autofill] AI answer error:', response?.error);
              resolve([]);
              return;
            }
            resolve(response.answers || []);
          }
        );
      } catch (err) {
        console.warn('[Indeed Autofill] sendMessage threw:', err);
        resolve([]);
      }
    });
  };

  /**
   * Get AI answers, then zip them back onto the extracted fields as .aiAnswer / .aiSource.
   */
  const resolveAnswersFromBackground = async (extractedFields) => {
    const aiAnswers = await getAiAnswersForExtractedFields(extractedFields);
    return extractedFields.map((field, i) => {
      const resolved = aiAnswers[i] || {};
      return {
        ...field,
        aiAnswer: resolved.answer || '',
        aiSource: resolved.source || 'unknown',
      };
    });
  };

  // ── low-level fill helpers (React / Vue compatible) ───────────────────────

  const setInputValue = (el, value) => {
    const nativeSetter =
      Object.getOwnPropertyDescriptor(el.__proto__, 'value')?.set ||
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set ||
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;

    if (nativeSetter) {
      nativeSetter.call(el, value);
    } else {
      el.value = value;
    }

    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
  };

  const findMatchingOption = (field, answer) => {
    const normalized = String(answer || '').trim().toLowerCase();
    if (!normalized) return null;

    const exact = (field.options || []).find(
      o => String(o.label || '').trim().toLowerCase() === normalized
    );
    if (exact) return exact;

    const partial = (field.options || []).find(o => {
      const label = String(o.label || '').trim().toLowerCase();
      return label.includes(normalized) || normalized.includes(label);
    });
    return partial || null;
  };

  /**
   * Apply a single answer using the selectors stored in field.targets / field.options[].selector.
   * Returns true if something was written.
   */
  const applyAnswerToField = (field, answer) => {
    if (!answer && answer !== 0) return false;
    if (answer === '__SKIP__') return false;

    const mainTarget = field.targets?.[0];
    if (!mainTarget) return false;

    const type = field.type;

    // text / textarea / number
    if (['text', 'textarea', 'number', 'email', 'tel', 'url'].includes(type)) {
      const el = document.querySelector(mainTarget.selector);
      if (!el) return false;
      setInputValue(el, String(answer));
      return true;
    }

    // radio
    if (type === 'radio') {
      const match = findMatchingOption(field, answer);
      if (!match?.selector) return false;
      const el = document.querySelector(match.selector);
      if (!el) return false;
      if (!el.checked) el.click();
      return true;
    }

    // native select
    if (type === 'select') {
      const el = document.querySelector(mainTarget.selector);
      if (!el) return false;
      const match = findMatchingOption(field, answer);
      if (!match) return false;
      el.value = match.value !== undefined ? match.value : match.label;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur',   { bubbles: true }));
      return true;
    }

    // checkbox_group / consent_checkbox_group
    if (type === 'checkbox_group' || type === 'consent_checkbox_group') {
      const answers = Array.isArray(answer) ? answer : [answer];
      let success = false;
      for (const a of answers) {
        const match = findMatchingOption(field, a);
        if (!match?.selector) continue;
        const el = document.querySelector(match.selector);
        if (el && !el.checked) { el.click(); success = true; }
      }
      return success;
    }

    return false;
  };

  // ── AI-backed autofill orchestrator ───────────────────────────────────────

  const parentNeedsFollowup = (answer) => {
    const a = String(answer || '').toLowerCase();
    return /\bother\b|please specify|recommendation from someone/i.test(a);
  };

  const applyFollowups = (field, answer) => {
    if (!field.followups?.length) return;
    if (!parentNeedsFollowup(answer)) return;
    for (const followup of field.followups) {
      applyAnswerToField(followup, 'Indeed');
    }
  };

  /**
   * Full AI-backed page fill:
   *   collectFields → resolveAnswersFromBackground → applyAnswerToField
   * Returns { filled, total }.
   */
  const autofillCurrentPageFromExtractor = async () => {
    const extractedFields = collectFields();
    console.log('[Indeed Autofill] Extracted fields:', extractedFields.length, extractedFields);

    const resolvedFields = await resolveAnswersFromBackground(extractedFields);

    let filled = 0;

    for (const field of resolvedFields) {
      const answer = field.aiAnswer;

      // If AI gave nothing, fall back to local rule-based resolver
      const finalAnswer = answer || resolveBestAnswer(field, {});

      if (!finalAnswer && finalAnswer !== 0) {
        console.log('[Indeed Autofill] No answer for:', field.question);
        continue;
      }

      const ok = applyAnswerToField(field, finalAnswer);
      if (ok) {
        filled++;
        applyFollowups(field, finalAnswer);
      }

      console.log('[Indeed Autofill] Field:', {
        question: field.question,
        answer:   finalAnswer,
        source:   field.aiSource,
        ok,
      });
    }

    return { filled, total: resolvedFields.length };
  };

  // Expose for DevTools testing
  window.testAutofill = autofillCurrentPageFromExtractor;

  // ── autofill runner (local / offline fallback) ────────────────────────────

  // Returns true when the chosen answer semantically requires a follow-up field
  const answerNeedsFollowup = (answer) => {
    if (!answer || typeof answer !== 'string') return false;
    return /\bother\b|please specify|recommendation from someone/i.test(answer);
  };

  const runAutofill = (profile = {}) => {
    const fields = collectFields();
    let filled = 0;
    let failed = 0;

    for (const field of fields) {
      const answer = resolveBestAnswer(field, profile);
      if (answer === '' || answer === null) continue;

      fillField(field, answer);

      if (verifyFilled(field, answer)) {
        filled++;
      } else {
        failed++;
        console.warn('[Indeed Autofill] Fill may not have stuck:', field.question, '→', answer);
      }

      // Only fill follow-up fields when the selected answer actually requires them
      // (e.g. "Other" or "Recommendation from someone" was chosen)
      if (field.followups?.length && answerNeedsFollowup(answer)) {
        for (const followup of field.followups) {
          const fa = resolveBestAnswer(followup, profile);
          if (fa) {
            fillField(followup, fa);
            filled++;
          }
        }
      }
    }

    if (failed > 0) console.warn(`[Indeed Autofill] ${failed} field(s) may need manual review`);
    return filled;
  };

  // ── UI ────────────────────────────────────────────────────────────────────

  const setStatus = (msg) => {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.style.cssText = [
        'position:fixed', 'right:18px', 'bottom:68px', 'z-index:2147483647',
        'background:#111', 'color:#fff', 'padding:10px 12px', 'border-radius:10px',
        'font:12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
        'box-shadow:0 6px 20px rgba(0,0,0,.25)', 'max-width:280px'
      ].join(';');
      document.body.appendChild(panel);
    }
    panel.textContent = msg;
    clearTimeout(panel.__hideTimer);
    panel.__hideTimer = setTimeout(() => panel.remove(), 4000);
  };

  const injectButton = () => {
    if (!shouldShowButton) return;
    if (document.getElementById(BUTTON_ID)) return;

    // ── edit your profile here ────────────────────────────────────────────
    const profile = {
      // Location
      city: 'Surrey',
      country: 'Canada',

      // Identity / auth
      linkedin: '',

      // Compensation
      salaryExpectation: 60000,

      // Experience
      yearsExperience: 3,      // used by 'years_experience' category
      defaultYears: 3,         // alias — same number, explicit override slot

      // Education: matched against select options (e.g. "Bachelor's Degree")
      education: "bachelor's degree",

      // Work-site preference: 'hybrid', 'remote', or 'onsite (locally based)'
      onsitePreference: 'hybrid',

      // Scheduling
      interviewDates: 'Flexible — available Monday to Friday, 9am–5pm',

      // Motivation (leave blank to use built-in default)
      whyInterested: '',

      // Open-text experience summaries (leave blank to use built-in defaults)
      salesSummary: '',        // generic sales/experience answer
      presentationSummary: '', // demos, lunch-and-learns, trade shows
      tradeSummary: '',        // architects, contractors, electrical channel

      // Fallback for any unclassified text field
      defaultText: ''
    };

    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.textContent = 'Autofill + Export';
    btn.style.cssText = [
      'position:fixed', 'right:18px', 'bottom:18px', 'z-index:2147483647',
      'background:#2557a7', 'color:#fff', 'border:none', 'border-radius:999px',
      'padding:12px 16px',
      'font:600 13px/1 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,.22)', 'cursor:pointer'
    ].join(';');

    btn.addEventListener('click', async () => {
      try {
        setStatus('Filling fields…');

        // Try AI-backed path first; fall back to local rules if AI is unavailable.
        let filled = 0;
        try {
          const result = await autofillCurrentPageFromExtractor();
          filled = result.filled;
        } catch (aiErr) {
          console.warn('[Indeed Autofill] AI path failed, falling back to local rules:', aiErr);
          filled = runAutofill(profile);
        }

        setStatus(`Filled ${filled} field(s) — exporting…`);
        setTimeout(() => {
          const data = buildExport();
          const name = downloadJson(data);
          setStatus(`Done. Saved ${name}`);
        }, 400);
      } catch (err) {
        console.error('[Indeed Autofill]', err);
        setStatus(`Error: ${err.message || err}`);
      }
    });

    document.body.appendChild(btn);
  };

  injectButton();

  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      document.getElementById(BUTTON_ID)?.click();
    }
  });

  console.log(`[Indeed Autofill] Loaded on ${location.hostname} (iframe: ${isInIframe}). Button: ${shouldShowButton}`);
})();
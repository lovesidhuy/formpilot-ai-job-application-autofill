'use strict';

function attachLeverHarvestMeta(fields, meta = {}) {
  const list = Array.isArray(fields) ? fields : [];
  for (const [key, value] of Object.entries(meta)) {
    try {
      Object.defineProperty(list, key, {
        value,
        configurable: true,
        enumerable: false,
        writable: true,
      });
    } catch (_) {
      list[key] = value;
    }
  }
  return list;
}

function cleanLeverText(value) {
  return String(value || '')
    .replace(/\bRequired\b/gi, '')
    .replace(/\s*\u2731\s*/g, ' ')
    .replace(/^[\s\u2022*-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function leverCssPath(el) {
  if (typeof cssPath === 'function') return cssPath(el);
  if (!el || !el.tagName) return '';
  if (el.id && typeof CSS !== 'undefined' && CSS.escape) return `#${CSS.escape(el.id)}`;
  const parts = [];
  let cur = el;
  while (cur && cur.tagName && parts.length < 6) {
    let sel = cur.tagName.toLowerCase();
    const parent = cur.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(child => child.tagName === cur.tagName);
      if (siblings.length > 1) sel += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
    }
    parts.unshift(sel);
    cur = parent;
  }
  return parts.join(' > ');
}

function isVisibleLeverElement(el) {
  if (!el || !el.tagName) return false;
  if (typeof isVisible === 'function') return isVisible(el);
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
  const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  return true;
}

function isVisibleLeverControl(input) {
  return isVisibleLeverElement(input) ||
    isVisibleLeverElement(input?.closest?.('label')) ||
    isVisibleLeverElement(input?.closest?.('.application-question'));
}

function getLeverSection(questionEl) {
  const section = questionEl.closest('.application-form, section, form');
  return cleanLeverText(
    section?.querySelector?.('[data-qa="card-name"], h4, h3, h2')?.textContent || ''
  );
}

function getLeverQuestionText(questionEl, input = null) {
  const label = questionEl.querySelector('.application-label .text, .application-label, [data-qa*="label"]');
  if (label) {
    const clone = label.cloneNode(true);
    clone.querySelectorAll('.required, [aria-hidden="true"]').forEach(node => node.remove());
    const text = cleanLeverText(clone.textContent || '');
    if (text) return text;
  }

  if (input?.id) {
    const forLabel = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
    const text = cleanLeverText(forLabel?.textContent || '');
    if (text && !/^(yes|no|n\/a|none)$/i.test(text)) return text;
  }

  const aria = cleanLeverText(input?.getAttribute?.('aria-label') || input?.placeholder || '');
  if (aria) return aria;

  return cleanLeverText(input?.name || input?.id || '');
}

function isLeverRequired(questionEl, input = null, question = '') {
  return !!(
    input?.required ||
    input?.getAttribute?.('aria-required') === 'true' ||
    questionEl.matches?.('.required-field, .required') ||
    questionEl.querySelector?.('.required, .required-field') ||
    /\*$/.test(question)
  );
}

function leverDomSnapshot(el, container) {
  return {
    selector: leverCssPath(el),
    containerSelector: leverCssPath(container || el),
    id: el.id || '',
    name: el.getAttribute('name') || el.name || '',
    className: typeof el.className === 'string' ? el.className : '',
    role: el.getAttribute('role') || '',
    dataTestId: el.getAttribute('data-qa') || el.getAttribute('data-testid') || '',
    placeholder: el.getAttribute('placeholder') || '',
    ariaLabel: el.getAttribute('aria-label') || '',
    ariaRequired: el.getAttribute('aria-required') || '',
    ariaInvalid: el.getAttribute('aria-invalid') || '',
    visible: isVisibleLeverElement(el),
    disabled: !!el.disabled,
    readOnly: !!el.readOnly,
    multiple: !!el.multiple,
  };
}

function getLeverOptionLabel(input) {
  return cleanLeverText(
    input.closest('label')?.querySelector('.application-answer-alternative')?.textContent ||
    input.closest('label')?.textContent ||
    (input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent) ||
    input.value ||
    ''
  );
}

function collectLeverChoiceField(questionEl, inputType, question, section) {
  const inputs = Array.from(questionEl.querySelectorAll(`input[type="${inputType}"][name]`))
    .filter(input => isVisibleLeverControl(input) && !input.disabled);
  if (!inputs.length) return null;

  const groups = new Map();
  for (const input of inputs) {
    const name = input.getAttribute('name') || '';
    if (!name) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(input);
  }

  const fields = [];
  for (const [name, group] of groups.entries()) {
    const first = group[0];
    const options = group.map(input => ({
      label: getLeverOptionLabel(input),
      value: input.value || '',
      checked: !!input.checked,
      selector: leverCssPath(input),
      id: input.id || '',
      name,
    })).filter(option => option.label || option.value);

    if (!options.length) continue;

    const consent = inputType === 'checkbox' && /privacy|consent|acknowledg|certif|authorize/i.test(question);
    fields.push({
      id: `lever-${inputType}::${name}`,
      question,
      label: question,
      type: inputType === 'radio' ? 'radio' : (consent ? 'consent_checkbox_group' : 'checkbox_group'),
      tag: 'input',
      name,
      required: group.some(input => isLeverRequired(questionEl, input, question)),
      answer: inputType === 'radio'
        ? (options.find(option => option.checked)?.label || options.find(option => option.checked)?.value || '')
        : options.filter(option => option.checked).map(option => option.label || option.value),
      options,
      section,
      validationMessage: '',
      dom: leverDomSnapshot(first, questionEl),
      targets: group.map(input => ({
        selector: leverCssPath(input),
        id: input.id || '',
        name,
        tag: 'input',
        type: inputType,
        label: getLeverOptionLabel(input),
        value: input.value || '',
      })),
    });
  }

  return fields;
}

function collectLeverSingleField(questionEl, input, question, section) {
  const tag = input.tagName.toLowerCase();
  const inputType = (input.getAttribute('type') || tag).toLowerCase();

  if (tag === 'select') {
    const options = Array.from(input.options || [])
      .map((option, index) => ({
        index,
        label: cleanLeverText(option.textContent || ''),
        value: option.value,
        selected: !!option.selected,
      }))
      .filter(option => option.label || option.value);

    return {
      id: `lever-select::${input.name || input.id || leverCssPath(input)}`,
      question,
      label: question,
      type: 'select',
      tag,
      name: input.name || '',
      required: isLeverRequired(questionEl, input, question),
      answer: input.value || '',
      options,
      section,
      validationMessage: '',
      dom: leverDomSnapshot(input, questionEl),
      targets: [{ selector: leverCssPath(input), id: input.id || '', name: input.name || '', tag, type: 'select' }],
    };
  }

  const fieldType = tag === 'textarea' ? 'textarea' : (inputType || 'text');
  return {
    id: `lever-${fieldType}::${input.name || input.id || leverCssPath(input)}`,
    question,
    label: question,
    type: fieldType,
    tag,
    name: input.name || '',
    required: isLeverRequired(questionEl, input, question),
    answer: input.value || '',
    options: [],
    section,
    validationMessage: '',
    dom: leverDomSnapshot(input, questionEl),
    targets: [{ selector: leverCssPath(input), id: input.id || '', name: input.name || '', tag, type: inputType || tag }],
  };
}

function dedupeLeverFields(fields) {
  const out = [];
  const seen = new Set();
  for (const field of fields || []) {
    const key = [
      field.type || '',
      field.name || field.targets?.[0]?.name || '',
      field.question || field.label || '',
      field.targets?.[0]?.selector || '',
    ].join('::').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(field);
  }
  return out;
}

function collectLeverApplicationQuestionFields() {
  const fields = [];
  const questionBlocks = Array.from(document.querySelectorAll(
    '.application-question, .application-additional, [data-qa="additional-cards"] .custom-question'
  )).filter(isVisibleLeverElement);

  for (const questionEl of questionBlocks) {
    const controls = Array.from(questionEl.querySelectorAll('input, textarea, select'))
      .filter(input => {
        if (!isVisibleLeverControl(input) || input.disabled || input.readOnly) return false;
        const type = (input.getAttribute('type') || '').toLowerCase();
        return !['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type);
      });

    if (!controls.length) continue;

    const question = getLeverQuestionText(questionEl, controls[0]);
    if (!question || question.length < 2) continue;

    const section = getLeverSection(questionEl);
    fields.push(...(collectLeverChoiceField(questionEl, 'radio', question, section) || []));
    fields.push(...(collectLeverChoiceField(questionEl, 'checkbox', question, section) || []));

    const choiceNames = new Set(
      fields.flatMap(field => field.targets || [])
        .filter(target => target.type === 'radio' || target.type === 'checkbox')
        .map(target => `${target.type}:${target.name}`)
    );

    for (const input of controls) {
      const type = (input.getAttribute('type') || '').toLowerCase();
      if ((type === 'radio' || type === 'checkbox') && choiceNames.has(`${type}:${input.name || ''}`)) continue;
      const field = collectLeverSingleField(questionEl, input, question, section);
      if (field) fields.push(field);
    }
  }

  return dedupeLeverFields(fields);
}

function harvestLeverFields(pageType) {
  const leverFields = collectLeverApplicationQuestionFields();
  if (leverFields.length) {
    return attachLeverHarvestMeta(leverFields, { __harvestSource: 'lever-specific' });
  }

  let fallback = [];
  if (typeof harvestGenericAtsForm === 'function') {
    fallback = harvestGenericAtsForm(pageType);
  } else if (typeof collectBaseFields === 'function') {
    fallback = collectBaseFields(pageType);
  }

  return attachLeverHarvestMeta(fallback, { __harvestSource: 'generic-fallback' });
}

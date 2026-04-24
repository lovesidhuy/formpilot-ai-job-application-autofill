'use strict';

function qfClean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function qfCleanQuestion(value) {
  const text = qfClean(value);
  if (!text) return '';
  if (typeof cleanQuestionText === 'function') return cleanQuestionText(text);
  return text.replace(/\bRequired\b/gi, '').replace(/\s+/g, ' ').trim();
}

function resolveQuestionText(el, step, name) {
  if (!el) return '';

  if (step === 'QUAL_QUESTIONS' || step === 'EMP_QUESTIONS') {
    return resolveIndeedQuestionText(el, name);
  }

  if (step === 'CONTACT_INFO') {
    return resolveContactFieldLabel(el);
  }

  return resolveGenericLabel(el);
}

function resolveIndeedQuestionText(el, radioGroupName) {
  try {
    const container = document.querySelector(
      `[data-testid*="${CSS.escape(radioGroupName)}"]`
    );
    if (container) {
      const text = extractQuestionFromContainer(container, radioGroupName);
      if (text && text.length >= 3) return text;
    }
  } catch (_) {}

  let node = el.parentElement;
  for (let i = 0; i < 12; i++) {
    if (!node || node === document.body) break;

    const className = typeof node.className === 'string' ? node.className : '';
    const dataTestId = node.getAttribute?.('data-testid') || '';

    if (
      /^q_\d+$/i.test(node.id || '') ||
      className.includes('ia-Questions-item') ||
      dataTestId.includes('question')
    ) {
      const text = extractQuestionFromContainer(node, radioGroupName);
      if (text && text.length >= 3) return text;
    }
    node = node.parentElement;
  }

  const groupEl =
    el.closest?.('[role="radiogroup"][aria-labelledby], fieldset') ||
    document.querySelector('[role="radiogroup"][aria-labelledby], fieldset');

  if (groupEl) {
    const labelledBy = groupEl.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) return qfCleanQuestion(labelEl.innerText);
    }
    const legend = groupEl.querySelector('legend');
    if (legend) return qfCleanQuestion(legend.innerText);
  }

  return '';
}

function extractQuestionFromContainer(container, radioGroupName) {
  const fullText = container.innerText || '';
  const radios = document.querySelectorAll(
    `input[type="radio"][name="${CSS.escape(radioGroupName)}"]`
  );

  let questionText = fullText;

  for (const radio of radios) {
    const rid = radio.id;
    const lbl = rid ? document.querySelector(`label[for="${CSS.escape(rid)}"]`) : null;
    const optText = lbl ? lbl.innerText.trim() : (radio.value || '').trim();
    if (optText) {
      questionText = questionText.replace(optText, ' ');
    }
  }

  const lines = questionText
    .replace(/\*/g, ' ')
    .replace(/Required/gi, ' ')
    .split('\n')
    .map(line => qfCleanQuestion(line))
    .filter(line => line.length > 4 && line.length < 300);

  return (
    lines.find(line => line.endsWith('?')) ||
    lines.find(line => line.length > 10) ||
    lines[0] ||
    ''
  );
}

function resolveContactFieldLabel(el) {
  const directLabel = qfCleanQuestion(
    (typeof getLabelText === 'function' ? getLabelText(el) : '') ||
    el.getAttribute('aria-label') ||
    el.getAttribute('placeholder') ||
    el.name ||
    el.id ||
    ''
  );
  if (directLabel && directLabel.length >= 3) return directLabel;

  const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
  const fieldKey = [
    el.name || '',
    el.id || '',
    autocomplete,
    el.getAttribute('data-testid') || '',
  ].join(' ').toLowerCase();

  if (fieldKey.includes('first') || autocomplete === 'given-name') return 'First name';
  if (fieldKey.includes('last') || autocomplete === 'family-name') return 'Last name';
  if (fieldKey.includes('phone') || autocomplete === 'tel') return 'Phone number';
  if (fieldKey.includes('email') || autocomplete === 'email') return 'Email address';
  if (fieldKey.includes('country')) return 'Country code';

  return directLabel;
}

function resolveGenericLabel(el) {
  if (!el) return '';

  const direct = qfCleanQuestion(
    (typeof findLabel === 'function' ? findLabel(el) : '') ||
    (typeof getLabelText === 'function' ? getLabelText(el) : '') ||
    el.getAttribute('aria-label') ||
    el.getAttribute('placeholder') ||
    ''
  );
  if (direct && direct.length >= 3) return direct;

  let node = el.parentElement;
  for (let i = 0; i < 8; i++) {
    if (!node || node === document.body) break;

    const labelledBy = node.getAttribute?.('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map(id => document.getElementById(id))
        .filter(Boolean)
        .map(labelNode => qfCleanQuestion(labelNode.innerText || labelNode.textContent || ''))
        .filter(Boolean)
        .join(' ');
      if (text.length >= 3) return text;
    }

    const heading = node.querySelector?.('legend, label, h1, h2, h3, h4, h5, h6, [role="heading"], p, span');
    if (heading && !heading.contains(el)) {
      const text = qfCleanQuestion(heading.innerText || heading.textContent || '');
      if (text.length >= 3) return text;
    }

    node = node.parentElement;
  }

  return direct;
}

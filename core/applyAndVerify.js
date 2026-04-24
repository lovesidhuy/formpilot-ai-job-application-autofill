'use strict';

async function applyAndVerify(field, answer, pipeline) {
  const questionText = pipeline?.registry?.get(field.id)?.questionText || field.questionText || field.label || field.name || '';
  const logger = pipeline?.logger || null;

  if (!answer || answer === '__SKIP__') {
    logger?.skipping(`'${questionText}'`);
    return false;
  }

  const applied = field.targets?.length
    ? await applyAnswerToField(field, answer)
    : await applyAnswer(field, answer);

  if (!applied) {
    logger?.failed(questionText, `apply '${answer}'`);
    return false;
  }

  await sleep(150);
  const verified = await verifyFieldValue(field, answer);

  if (verified) {
    logger?.selected(answer);
    return true;
  }

  logger?.push(`⚠ Applied but verification failed: '${questionText}' → '${answer}'`);

  await forceApplyAnswer(field, answer);
  await sleep(100);

  const retryVerified = await verifyFieldValue(field, answer);
  if (retryVerified) {
    logger?.selected(answer);
    return true;
  }

  logger?.failed(questionText, `verification failed for '${answer}'`);
  return false;
}

async function forceApplyAnswer(field, answer) {
  if (!answer || answer === '__SKIP__') return false;

  try {
    const applied = await applyAnswer(field, answer);
    if (applied) return true;
  } catch (_) {}

  try {
    const applied = await applyAnswerToField(field, answer);
    if (applied) return true;
  } catch (_) {}

  return false;
}

async function verifyFieldValue(field, expectedAnswer) {
  const expected = String(Array.isArray(expectedAnswer) ? expectedAnswer[0] : expectedAnswer)
    .toLowerCase()
    .trim();

  if (!expected) return false;

  if (field.type === 'radio' || field.tag === 'radio' || field.tag === 'aria-radio') {
    const radioName = field.name || field.targets?.[0]?.name || field.dom?.name || '';

    if (radioName) {
      const radios = document.querySelectorAll(
        `input[type="radio"][name="${CSS.escape(radioName)}"]`
      );

      for (const radio of radios) {
        if (!radio.checked) continue;
        const rid = radio.id;
        const lbl = rid ? document.querySelector(`label[for="${CSS.escape(rid)}"]`) : null;
        const text = String(lbl ? lbl.innerText.trim() : (radio.value || '')).toLowerCase().trim();
        if (text === expected || text.includes(expected) || expected.includes(text)) {
          return true;
        }
      }
    }

    // `readFieldValue` is declared in `content.js`, which is loaded later into
    // the same content-script scope. This lookup happens at call time, not load time.
    const current = String(readFieldValue(field) || '').toLowerCase().trim();
    return !!current && (current === expected || current.includes(expected) || expected.includes(current));
  }

  if (field.type === 'select') {
    const name = field.name || field.targets?.[0]?.name || field.dom?.name || '';
    let el = null;

    if (name) {
      try { el = document.querySelector(`select[name="${CSS.escape(name)}"]`); } catch (_) {}
    }
    if (!el && field.targets?.[0]) el = resolveElement(field.targets[0]);
    if (!el) return false;

    const selectedText = String(el.selectedOptions?.[0]?.text || el.value || '').toLowerCase().trim();
    return selectedText === expected || selectedText.includes(expected) || expected.includes(selectedText);
  }

  if (['text', 'textarea', 'email', 'tel', 'url', 'number'].includes(field.type)) {
    let el = field.targets?.[0] ? resolveElement(field.targets[0]) : null;
    const name = field.name || field.targets?.[0]?.name || field.dom?.name || '';

    if (!el && name) {
      try {
        el = document.querySelector(
          `input[name="${CSS.escape(name)}"], textarea[name="${CSS.escape(name)}"]`
        );
      } catch (_) {}
    }
    if (!el) return false;

    const directValue = String(el.value || '').toLowerCase().trim();
    if (directValue === expected) return true;

    const current = String(readFieldValue(field) || '').toLowerCase().trim();
    return !!current && current === expected;
  }

  if (field.type === 'checkbox_group' || field.type === 'consent_checkbox_group') {
    const expectedValues = (Array.isArray(expectedAnswer) ? expectedAnswer : String(expectedAnswer).split(','))
      .map(v => String(v || '').toLowerCase().trim())
      .filter(Boolean);
    const actualValues = (Array.isArray(readFieldValue(field)) ? readFieldValue(field) : [])
      .map(v => String(v || '').toLowerCase().trim())
      .filter(Boolean);

    if (!expectedValues.length) return actualValues.length === 0;
    return expectedValues.every(value =>
      actualValues.some(actual => actual === value || actual.includes(value) || value.includes(actual))
    );
  }

  return true;
}

'use strict';

function createSmartApplyDebug(step) {
  return {
    step,
    detectorResult: '',
    candidateRoots: [],
    questionContainers: [],
    normalizedFields: [],
    rejected: [],
    fallbackReason: '',
  };
}

function pushSmartApplyDebug(debug, line) {
  if (!debug) return;
  if (!debug.lines) debug.lines = [];
  debug.lines.push(line);
  try { console.log(`[FormPilot][SmartApply] ${line}`); } catch (_) {}
}

function pushSmartApplyReject(debug, reason, detail = '') {
  if (!debug) return;
  debug.rejected.push({ reason, detail });
  pushSmartApplyDebug(debug, `reject ${reason}${detail ? `: ${detail}` : ''}`);
}

function attachHarvestMeta(fields, meta = {}) {
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

function dedupeHarvestedFields(fields) {
  const out = [];
  const seen = new Set();

  for (const field of fields || []) {
    const key = [
      field?.type || field?.tag || '',
      field?.name || field?.dom?.name || '',
      field?.question || field?.label || '',
      field?.dom?.selector || field?.id || '',
    ].join('::').toLowerCase();

    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(field);
  }

  return out;
}

function toArray(value) {
  return Array.isArray(value) ? value : [value];
}

function queryAllVisible(selectors, root = document) {
  const results = [];
  for (const selector of toArray(selectors)) {
    try {
      for (const el of root.querySelectorAll(selector)) {
        if (!isElement(el) || !isVisible(el)) continue;
        results.push(el);
      }
    } catch (_) {}
  }
  return results;
}

function getFirstVisible(selectors, root = document) {
  return queryAllVisible(selectors, root)[0] || null;
}

function uniqueElements(elements) {
  return Array.from(new Set((elements || []).filter(Boolean)));
}

function getSmartApplyRootSelectors(step) {
  const rootsByStep = {
    CONTACT_INFO: [
      '[data-testid*="contact-info"]',
      '[id*="contact-info"]',
      '[class*="contact-info"]',
    ],
    LOCATION: [
      '[data-testid*="profile-location"]',
      '[id*="profile-location"]',
      '[class*="profile-location"]',
    ],
    QUAL_QUESTIONS: [
      '[data-testid*="qualification-questions-module"]',
      '[id*="qualification-questions-module"]',
      '[class*="qualification-questions-module"]',
    ],
    EMP_QUESTIONS: [
      '[data-testid*="questions-module"]',
      '[data-testid*="QuestionsModule"]',
      '[data-testid*="screener"]',
      '[data-testid*="question"]',
      '[id*="questions-module"]',
      '[id*="question-module"]',
      '[id*="screener"]',
      '[class*="questions-module"]',
      '[class*="QuestionsModule"]',
      '[class*="question-module"]',
      '[class*="screener"]',
      '[data-testid*="ia-Questions"]',
      '[class*="ia-Questions"]',
      'main form',
      'main',
    ],
    EXPERIENCE: [
      '[data-testid*="experience"]',
      '[id*="experience"]',
      '[class*="experience"]',
    ],
    PRIVACY: [
      '[data-testid*="privacy"]',
      '[id*="privacy"]',
      '[class*="privacy"]',
    ],
    RESUME_UPLOAD: [
      '[data-testid*="resume"]',
      '[id*="resume"]',
      '[class*="resume"]',
      '[data-testid*="upload"]',
      '[class*="upload"]',
    ],
    RESUME_SELECTION: [
      '[data-testid*="resume-selection-module"]',
      '[id*="resume-selection-module"]',
      '[class*="resume-selection-module"]',
    ],
  };

  return rootsByStep[step] || [];
}

function getSmartApplyCandidateRoots(step, debug = null) {
  const selectors = getSmartApplyRootSelectors(step);
  const roots = uniqueElements([
    ...queryAllVisible(selectors),
    document.querySelector('main form'),
    document.querySelector('main'),
  ]).filter(Boolean);

  const resolvedRoots = roots.length ? roots : [document];
  const detectorResult = roots.length
    ? `matched ${roots.length} candidate roots`
    : 'no explicit SmartApply root matched; using document';

  if (debug) {
    debug.detectorResult = detectorResult;
    debug.candidateRoots = resolvedRoots.map(root => {
      const id = root.id ? `#${root.id}` : '';
      const testId = root.getAttribute?.('data-testid') ? `[data-testid="${root.getAttribute('data-testid')}"]` : '';
      const cls = typeof root.className === 'string' && root.className.trim()
        ? `.${root.className.trim().split(/\s+/).slice(0, 2).join('.')}`
        : '';
      return `${root.tagName.toLowerCase()}${id}${testId}${cls}`;
    });
    pushSmartApplyDebug(debug, `detector result: ${detectorResult}`);
    pushSmartApplyDebug(debug, `candidate roots found: ${debug.candidateRoots.length}`);
  }

  return resolvedRoots;
}

function getSmartApplyStepRoot(step) {
  return getSmartApplyCandidateRoots(step)[0] || document;
}

function getSmartApplyQuestionContainers(step, roots, debug = null) {
  const containerSelectors = [
    '[id^="q_"]',
    '[data-testid*="question"]',
    '[data-testid*="Question"]',
    '[class*="ia-Questions-item"]',
    '[class*="question-item"]',
    '[class*="QuestionItem"]',
    '[role="group"]',
    'fieldset',
    'li',
    'section',
    'article',
  ];

  const containers = [];
  for (const root of roots || []) {
    const found = queryAllVisible(containerSelectors, root);
    for (const el of found) {
      if (!root.contains(el)) continue;
      // FIXED: removed the strict child-input guard that was killing extraction
      containers.push(el);
    }
  }

  const unique = uniqueElements(containers);
  const resolved = unique.length ? unique : uniqueElements(roots || []);

  if (debug) {
    debug.questionContainers = resolved.map(el => {
      const id = el.id ? `#${el.id}` : '';
      const testId = el.getAttribute?.('data-testid') ? `[data-testid="${el.getAttribute('data-testid')}"]` : '';
      return `${el.tagName.toLowerCase()}${id}${testId}`;
    });
    pushSmartApplyDebug(debug, `question containers found: ${resolved.length}`);
  }

  return resolved;
}

function resolveSmartApplyLabelFromContainer(el, container = null) {
  const target = container || el;
  const fromLegend = target.closest?.('fieldset')?.querySelector?.('legend')?.innerText || '';
  if (qfCleanLabel(fromLegend)) return qfCleanLabel(fromLegend);

  const labelledBy = el.getAttribute?.('aria-labelledby') || target.getAttribute?.('aria-labelledby') || '';
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ');
    if (qfCleanLabel(text)) return qfCleanLabel(text);
  }

  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (qfCleanLabel(label?.innerText || '')) return qfCleanLabel(label.innerText);
  }

  const wrappedLabel = el.closest?.('label')?.innerText || '';
  if (qfCleanLabel(wrappedLabel)) return qfCleanLabel(wrappedLabel);

  const ariaLabel = el.getAttribute?.('aria-label') || '';
  if (qfCleanLabel(ariaLabel)) return qfCleanLabel(ariaLabel);

  const headingSelector = 'legend, h1, h2, h3, h4, label, [data-testid*="label"], [class*="label"], [class*="question"], p, span';
  for (const heading of Array.from(target.querySelectorAll?.(headingSelector) || [])) {
    if (heading.contains?.(el)) continue;
    const text = qfCleanLabel(heading.innerText || heading.textContent || '');
    if (text) return text;
  }

  let node = target.parentElement;
  for (let i = 0; i < 6; i++) {
    if (!node) break;
    for (const candidate of Array.from(node.querySelectorAll?.(headingSelector) || [])) {
      if (candidate.contains?.(el)) continue;
      const text = qfCleanLabel(candidate.innerText || candidate.textContent || '');
      if (text) return text;
    }
    node = node.parentElement;
  }

  return '';
}

function qfCleanLabel(value) {
  const text = String(value || '')
    .replace(/\bRequired\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return '';
  if (/^select an option$/i.test(text)) return '';
  if (/^answer (this question to continue|must be a valid number)/i.test(text)) return '';
  if (/^(invalid|required field|please enter|please select|error)/i.test(text)) return '';
  if (text.length > 220 && /select an option/i.test(text)) return '';
  return text;
}

function isChoiceLikeField(field) {
  const type = String(field?.type || field?.tag || '').toLowerCase();
  return ['radio', 'select', 'checkbox_group', 'checkbox-group', 'consent_checkbox_group', 'aria-radio', 'custom-radio'].includes(type);
}

function canonicalQuestionKey(field) {
  return qfCleanLabel(field?.question || field?.label || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pruneConflictingQuestionDuplicates(fields, debug = null) {
  const grouped = new Map();

  for (const field of fields || []) {
    const key = canonicalQuestionKey(field);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(field);
  }

  const drop = new Set();

  for (const [question, group] of grouped.entries()) {
    if (group.length < 2) continue;

    const choiceFields = group.filter(isChoiceLikeField);
    if (!choiceFields.length) continue;

    for (const field of group) {
      if (isChoiceLikeField(field)) continue;
      drop.add(field);
      pushSmartApplyReject(debug, 'question_shadowed_by_choice_field', question);
    }
  }

  return fields.filter(field => !drop.has(field));
}

function pruneQuestionShadows(fields, debug = null) {
  const choiceFields = (fields || []).filter(isChoiceLikeField);
  if (!choiceFields.length) return fields;

  const drop = new Set();

  for (const field of fields || []) {
    if (isChoiceLikeField(field)) continue;

    const key = canonicalQuestionKey(field);
    if (!key) continue;

    const shadowed = choiceFields.find(choice => {
      const choiceKey = canonicalQuestionKey(choice);
      if (!choiceKey) return false;
      if (choiceKey === key) return true;
      if (key.length >= 24 && choiceKey.startsWith(key.slice(0, 24))) return true;
      if (choiceKey.length >= 24 && key.startsWith(choiceKey.slice(0, 24))) return true;
      return false;
    });

    if (!shadowed) continue;
    drop.add(field);
    pushSmartApplyReject(debug, 'question_shadowed_by_similar_choice_field', key);
  }

  return fields.filter(field => !drop.has(field));
}

function describeSmartApplyElement(el) {
  if (!el) return '(missing)';
  const tag = el.tagName?.toLowerCase?.() || 'node';
  const type = el.getAttribute?.('type') ? `[type="${el.getAttribute('type')}"]` : '';
  const name = el.getAttribute?.('name') ? `[name="${el.getAttribute('name')}"]` : '';
  const id = el.id ? `#${el.id}` : '';
  return `${tag}${id}${type}${name}`;
}

// FIXED: scan roots directly instead of containers, then resolve container per-input
function collectSmartApplyEmpQuestionFields(step, seen = new Set(), debug = null) {
  const roots = getSmartApplyCandidateRoots(step, debug);

  // Still collect containers for debug info, but don't use them as the scan scope
  getSmartApplyQuestionContainers(step, roots, debug);

  const fields = [];
  const fieldKeys = new Set();
  const groupedNames = new Set();

  const candidateInputs = [];

  // FIXED: use raw querySelectorAll so visibility/display quirks don't block discovery
  for (const root of roots) {
    const rawInputs = Array.from(root.querySelectorAll('input, textarea, select, [role="combobox"], [aria-haspopup="listbox"]'));
    pushSmartApplyDebug(debug, `RAW inputs found in root (${root.tagName?.toLowerCase?.() || 'node'}): ${rawInputs.length}`);

    for (const el of uniqueElements(rawInputs)) {
      if (seen.has(el)) continue;
      // Skip truly hidden inputs (type=hidden) — everything else gets a chance
      if ((el.getAttribute('type') || '').toLowerCase() === 'hidden') continue;
      // Resolve the closest meaningful container for label resolution
      const container =
        el.closest('[id^="q_"]') ||
        el.closest('[data-testid*="question"], [data-testid*="Question"]') ||
        el.closest('[class*="ia-Questions-item"], [class*="question-item"], [class*="QuestionItem"]') ||
        el.closest('[role="group"]') ||
        el.closest('fieldset') ||
        el.closest('li') ||
        el.closest('section') ||
        el.closest('article') ||
        el.parentElement ||
        root;
      candidateInputs.push({ el, container });
    }
  }

  pushSmartApplyDebug(debug, `input-first candidates found: ${candidateInputs.length}`);

  for (const { el, container } of candidateInputs) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    const tag = el.tagName.toLowerCase();

    // Relaxed visibility check: skip only if truly not rendered (offsetParent null and not fixed/sticky)
    if (!el.offsetParent && getComputedStyle(el).position !== 'fixed' && getComputedStyle(el).position !== 'sticky') {
      pushSmartApplyReject(debug, 'hidden_input', describeSmartApplyElement(el));
      continue;
    }

    if (!['input', 'textarea', 'select'].includes(tag) && !isFakeCombo(el)) {
      pushSmartApplyReject(debug, 'unsupported_type', describeSmartApplyElement(el));
      continue;
    }

    const inferredLabel = resolveSmartApplyLabelFromContainer(el, container);
    if (!inferredLabel && type !== 'radio' && type !== 'checkbox') {
      pushSmartApplyReject(debug, 'missing_label', describeSmartApplyElement(el));
      continue;
    }

    if ((type === 'radio' || type === 'checkbox') && el.name) {
      const groupKey = `${type}:${el.name}`;
      if (groupedNames.has(groupKey)) continue;
      groupedNames.add(groupKey);

      // Group siblings are often rendered outside the tiny node that matched our
      // candidate-root selector, so scan the whole document for same-name inputs.
      const groupOptions = Array.from(
        document.querySelectorAll(`input[type="${type}"][name="${CSS.escape(el.name)}"]`)
      ).filter(input => (input.getAttribute('type') || '').toLowerCase() !== 'hidden');

      if (!groupOptions.length || (type === 'radio' && groupOptions.length < 2)) {
        pushSmartApplyReject(debug, 'no_group_options', `${groupKey} (${groupOptions.length})`);
        continue;
      }
    }

    const field = collectFieldFromElement(el);
    if (!field) {
      pushSmartApplyReject(debug, 'unsupported_type', describeSmartApplyElement(el));
      continue;
    }

    const resolvedLabel =
      qfCleanLabel(field.question || field.label || '') ||
      qfCleanLabel(inferredLabel);

    if (!resolvedLabel) {
      pushSmartApplyReject(debug, 'missing_label', describeSmartApplyElement(el));
      continue;
    }

    field.question = resolvedLabel;
    field.label = resolvedLabel;

    const key = [
      field.type || field.tag || '',
      field.targets?.[0]?.name || field.dom?.name || field.name || '',
      resolvedLabel,
    ].join('::').toLowerCase();

    if (fieldKeys.has(key)) {
      pushSmartApplyReject(debug, 'duplicate_question', resolvedLabel);
      continue;
    }

    fieldKeys.add(key);
    fields.push(field);
  }

  return finalizeSmartApplyQuestionFields(fields, seen, debug);
}

function finalizeSmartApplyQuestionFields(fields, seen = new Set(), debug = null) {
  const merged = dedupeHarvestedFields([
    ...(fields || []),
    ...harvestAriaRadioGroups(seen),
  ]);

  const normalized = pruneQuestionShadows(
    pruneConflictingQuestionDuplicates(merged, debug),
    debug
  );

  if (debug) {
    debug.normalizedFields = normalized.map(field => ({
      type: field.type || field.tag || 'unknown',
      question: qfCleanLabel(field.question || field.label || field.name || ''),
    }));
    pushSmartApplyDebug(debug, `normalized fields returned: ${normalized.length}`);
  }

  return normalized;
}

function collectFieldFromElement(el) {
  if (!isElement(el) || !isRealQuestionField(el)) return null;

  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();

  if (type === 'radio') return collectRadioGroup(el);
  if (type === 'checkbox') return collectCheckboxGroup(el);
  if (tag === 'select') return collectNativeSelect(el);
  if (isFakeCombo(el)) return collectFakeCombobox(el);
  return collectSingleField(el);
}

function pushField(fields, fieldKeys, field) {
  if (!field) return;

  const key = [
    field.type || field.tag || '',
    field.targets?.[0]?.name || field.dom?.name || field.name || '',
    field.question || field.label || '',
    field.dom?.selector || field.id || '',
  ].join('::').toLowerCase();

  if (!key || fieldKeys.has(key)) return;
  fieldKeys.add(key);
  fields.push(field);
}

function harvestScopedElements(elements, seen = new Set()) {
  const fields = [];
  const fieldKeys = new Set();
  const groupKeys = new Set();

  for (const el of uniqueElements(elements)) {
    if (!isElement(el) || !isVisible(el)) continue;

    const type = (el.getAttribute('type') || '').toLowerCase();
    const groupName = el.getAttribute('name') || '';
    if ((type === 'radio' || type === 'checkbox') && groupName) {
      const groupKey = `${type}:${groupName}`;
      if (groupKeys.has(groupKey)) continue;
      groupKeys.add(groupKey);
    }

    const field = collectFieldFromElement(el);
    if (!field) continue;

    pushField(fields, fieldKeys, field);

    for (const target of field.targets || []) {
      const targetEl = resolveElement(target);
      if (targetEl) seen.add(targetEl);
    }
  }

  return dedupeHarvestedFields(fields);
}

function findContactInfoElements() {
  const root = getSmartApplyStepRoot('CONTACT_INFO');
  return uniqueElements([
    ...queryAllVisible([
      'input[autocomplete="given-name"]',
      'input[name*="first" i]',
      'input[id*="first" i]',
      'input[data-testid*="first" i]',
    ], root),
    ...queryAllVisible([
      'input[autocomplete="family-name"]',
      'input[name*="last" i]',
      'input[id*="last" i]',
      'input[data-testid*="last" i]',
    ], root),
    ...queryAllVisible([
      'input[type="tel"]',
      'input[autocomplete="tel"]',
      'input[name*="phone" i]',
      'input[id*="phone" i]',
      'input[data-testid*="phone" i]',
    ], root),
    ...queryAllVisible([
      'select[name*="country" i]',
      'select[id*="country" i]',
      'select[aria-label*="country code" i]',
      'select[data-testid*="country" i]',
      '[role="combobox"][aria-label*="country code" i]',
    ], root),
    ...queryAllVisible([
      'input[type="email"]',
      'input[autocomplete="email"]',
      'input[name*="email" i]',
      'input[id*="email" i]',
    ], root),
  ]);
}

function findLocationElements() {
  const root = getSmartApplyStepRoot('LOCATION');
  return uniqueElements([
    ...queryAllVisible([
      'input[name*="location" i]',
      'input[id*="location" i]',
      'input[autocomplete*="address-level2"]',
      'input[name*="city" i]',
      'input[id*="city" i]',
      'input[data-testid*="city" i]',
    ], root),
    ...queryAllVisible([
      'input[autocomplete*="address-level1"]',
      'input[name*="state" i]',
      'input[name*="province" i]',
      'input[id*="state" i]',
      'input[id*="province" i]',
    ], root),
    ...queryAllVisible([
      'input[autocomplete*="postal-code"]',
      'input[name*="postal" i]',
      'input[name*="zip" i]',
      'input[id*="postal" i]',
      'input[id*="zip" i]',
    ], root),
    ...queryAllVisible([
      'select[name*="country" i]',
      'select[id*="country" i]',
      '[role="combobox"][aria-label*="country" i]',
    ], root),
    ...queryAllVisible([
      'input[autocomplete*="street-address"]',
      'input[name*="address" i]',
      'input[id*="address" i]',
    ], root),
  ]);
}

function getQuestionModuleRoots(step) {
  const root = getSmartApplyStepRoot(step);
  const questionItems = queryAllVisible('[id^="q_"], .ia-Questions-item', root);
  return questionItems.length ? questionItems : [root];
}

function harvestScopedNamedGroups(step, inputType, seen = new Set()) {
  const fields = [];
  const fieldKeys = new Set();
  const groupNames = new Set();

  for (const root of getQuestionModuleRoots(step)) {
    const inputs = queryAllVisible(`input[type="${inputType}"][name]`, root)
      .filter(el => /^q_/i.test(el.getAttribute('name') || ''));

    for (const input of inputs) {
      const name = input.getAttribute('name') || '';
      if (!name || groupNames.has(name)) continue;
      groupNames.add(name);

      const field = inputType === 'radio'
        ? collectRadioGroup(input)
        : collectCheckboxGroup(input);

      pushField(fields, fieldKeys, field);

      for (const target of field?.targets || []) {
        const targetEl = resolveElement(target);
        if (targetEl) seen.add(targetEl);
      }
    }
  }

  return dedupeHarvestedFields(fields);
}

function harvestScopedQuestionInputs(step, selectors, seen = new Set()) {
  const roots = getQuestionModuleRoots(step);
  const elements = [];

  for (const root of roots) {
    for (const el of queryAllVisible(selectors, root)) {
      if (seen.has(el)) continue;
      elements.push(el);
    }
  }

  return harvestScopedElements(elements, seen);
}

function harvestScopedStepInputs(step, selectors, seen = new Set()) {
  const root = getSmartApplyStepRoot(step);
  return harvestScopedElements(queryAllVisible(selectors, root), seen);
}

function harvestGenericForm(pageType) {
  return withHarvestSource(collectBaseFields(pageType), 'generic');
}

function withHarvestSource(fields, source, extraMeta = {}) {
  return attachHarvestMeta(fields, { __harvestSource: source, ...extraMeta });
}

function withGenericFallback(fields, pageType, seen = new Set(), debug = null) {
  const primary = dedupeHarvestedFields(fields || []);
  if (primary.length) return withHarvestSource(primary, 'smartapply-specific', { __harvestDebug: debug });

  const fallbackFields = collectBaseFields(pageType).filter(field => {
    for (const target of field.targets || []) {
      const targetEl = resolveElement(target);
      if (targetEl && seen.has(targetEl)) return false;
    }
    return true;
  });

  if (debug && !debug.fallbackReason) {
    debug.fallbackReason = 'smartapply_extracted_zero_fields';
    pushSmartApplyDebug(debug, `fallback reason: ${debug.fallbackReason}`);
  }

  return withHarvestSource(dedupeHarvestedFields(fallbackFields), 'generic-fallback', { __harvestDebug: debug });
}

function harvestContactInfoStep(seen = new Set()) {
  return withHarvestSource(harvestScopedElements(findContactInfoElements(), seen), 'smartapply-specific');
}

function harvestLocationStep(seen = new Set()) {
  return withHarvestSource(harvestScopedElements(findLocationElements(), seen), 'smartapply-specific');
}

function harvestNamedRadioGroups(step, seen = new Set()) {
  if (step === 'QUAL_QUESTIONS' || step === 'EMP_QUESTIONS') {
    return harvestScopedNamedGroups(step, 'radio', seen);
  }
  return harvestIndeedNamedRadioGroups(seen);
}

function harvestNamedCheckboxGroups(step, seen = new Set()) {
  if (step === 'EMP_QUESTIONS') {
    return harvestScopedNamedGroups(step, 'checkbox', seen);
  }
  return harvestIndeedNamedCheckboxGroups(seen);
}

function harvestTextInputs(step, seen = new Set()) {
  if (step !== 'EMP_QUESTIONS') return [];

  return harvestScopedQuestionInputs(step, [
    'input[type="text"]',
    'input[type="email"]',
    'input[type="tel"]',
    'input[type="number"]',
    'input[type="url"]',
    'input:not([type])',
    '[role="combobox"]',
    '[aria-haspopup="listbox"]',
  ], seen);
}

function harvestTextareas(step, seen = new Set()) {
  if (step !== 'EMP_QUESTIONS') return [];

  return harvestScopedQuestionInputs(step, ['textarea'], seen);
}

function harvestSelectFields(step, seen = new Set()) {
  if (step !== 'EMP_QUESTIONS') return [];

  return harvestScopedQuestionInputs(step, ['select'], seen);
}

function harvestResumeSelectionStep(seen = new Set()) {
  const debug = createSmartApplyDebug('RESUME_SELECTION');
  const root = getSmartApplyStepRoot('RESUME_SELECTION');
  const elements = queryAllVisible(['input[type="radio"]'], root);
  const nativeFields = harvestScopedElements(elements, seen);
  const ariaFields = harvestAriaRadioGroups(seen);
  const cardFields = [];

  if (!nativeFields.length && !ariaFields.length) {
    const choices = getRadioLikeOptions(root)
      .filter(item => item.text && item.text.length >= 3)
      .filter(item => !/continue|next|review|submit|back|cancel/i.test(item.text));

    const uniqueChoices = [];
    const seenChoiceText = new Set();
    for (const item of choices) {
      const key = qfCleanLabel(item.text).toLowerCase();
      if (!key || seenChoiceText.has(key)) continue;
      seenChoiceText.add(key);
      uniqueChoices.push(item);
    }

    if (uniqueChoices.length >= 2) {
      cardFields.push({
        id: 'custom-radio::resume-selection',
        tag: 'custom-radio',
        type: 'radio',
        name: 'resume-selection',
        label: 'Resume selection',
        question: 'Resume selection',
        options: uniqueChoices.map(item => item.text),
        currentValue: '',
        targets: uniqueChoices.map(item => ({
          selector: cssPath(item.el),
          id: item.el.id || '',
          name: 'resume-selection',
          tag: item.el.tagName?.toLowerCase?.() || 'div',
          type: 'radio',
          label: item.text,
          value: item.text,
        })),
      });
    }
  }

  return withGenericFallback([...nativeFields, ...ariaFields, ...cardFields], PAGE_TYPES.RESUME_SELECTION, seen, debug);
}

function harvestExperienceStep(seen = new Set()) {
  return withHarvestSource(dedupeHarvestedFields([
    ...harvestScopedStepInputs('EXPERIENCE', [
      'input[type="radio"]',
      'input[type="checkbox"]',
      'input[type="text"]',
      'input[type="email"]',
      'input[type="tel"]',
      'input[type="number"]',
      'input[type="url"]',
      'input:not([type])',
      'textarea',
      'select',
      '[role="combobox"]',
      '[aria-haspopup="listbox"]',
    ], seen),
    ...harvestAriaRadioGroups(seen),
  ]), 'smartapply-specific');
}

function harvestPrivacyStep(seen = new Set()) {
  return withHarvestSource(dedupeHarvestedFields([
    ...harvestScopedStepInputs('PRIVACY', [
      'input[type="checkbox"]',
      'input[type="radio"]',
      'input[type="text"]',
      'input:not([type])',
      'textarea',
      'select',
      '[role="combobox"]',
      '[aria-haspopup="listbox"]',
    ], seen),
    ...harvestAriaRadioGroups(seen),
  ]), 'smartapply-specific');
}

function harvestResumeUploadStep(seen = new Set()) {
  const root = getSmartApplyStepRoot('RESUME_UPLOAD');
  const supportedFields = harvestScopedStepInputs('RESUME_UPLOAD', [
    'input[type="radio"]',
    'input[type="checkbox"]',
    'input[type="text"]',
    'input[type="email"]',
    'input[type="tel"]',
    'input[type="number"]',
    'input[type="url"]',
    'input:not([type])',
    'textarea',
    'select',
    '[role="combobox"]',
    '[aria-haspopup="listbox"]',
  ], seen);

  // File inputs remain intentionally out of the field model until upload support exists.
  const uploadChoiceFields = harvestScopedElements(
    queryAllVisible(['input[type="radio"]'], root),
    seen
  );

  return withHarvestSource(dedupeHarvestedFields([
    ...supportedFields,
    ...uploadChoiceFields,
    ...harvestAriaRadioGroups(seen),
  ]), 'smartapply-specific');
}

const STEP_HARVESTERS = {
  CONTACT_INFO: (seen) => harvestContactInfoStep(seen),
  LOCATION: (seen) => harvestLocationStep(seen),
  QUAL_QUESTIONS: (seen, pageType) => {
    const debug = createSmartApplyDebug('QUAL_QUESTIONS');
    return withGenericFallback(
      harvestNamedRadioGroups('QUAL_QUESTIONS', seen),
      pageType || PAGE_TYPES.QUESTION_PAGE,
      seen,
      debug
    );
  },
  EMP_QUESTIONS: (seen, pageType) => {
    const debug = createSmartApplyDebug('EMP_QUESTIONS');
    const smartApplyFields = collectSmartApplyEmpQuestionFields('EMP_QUESTIONS', seen, debug);
    const meaningfulFieldCount = smartApplyFields.filter(field =>
      qfCleanLabel(field.question || field.label || field.name || '').length >= 3
    ).length;

    if (!meaningfulFieldCount) {
      debug.fallbackReason = 'smartapply_extracted_too_little';
      pushSmartApplyDebug(debug, `fallback reason: ${debug.fallbackReason}`);
      return withGenericFallback(smartApplyFields, pageType || PAGE_TYPES.QUESTION_PAGE, seen, debug);
    }

    return withHarvestSource(smartApplyFields, 'smartapply-specific', { __harvestDebug: debug });
  },
  EXPERIENCE: (seen) => harvestExperienceStep(seen),
  PRIVACY: (seen) => harvestPrivacyStep(seen),
  RESUME_UPLOAD: (seen) => harvestResumeUploadStep(seen),
  RESUME_SELECTION: (seen) => harvestResumeSelectionStep(seen),
  REVIEW: () => ({ isReviewPage: true, fields: [] }),
  ATS_FORM: (_, pageType) => harvestGenericForm(pageType),
};

function collectStepFields(route = getCurrentStep(), pageType) {
  if (!route || !route.step) return null;

  if (route.platform === 'indeed' && route.step === 'JOB_PAGE') {
    return [];
  }

  const harvester = STEP_HARVESTERS[route.step];
  if (!harvester) return null;

  return harvester(new Set(), pageType);
}

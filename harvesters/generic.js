'use strict';

function collectBaseFields(pageType = classifyCurrentPage().type) {
  autoClickConsentCheckboxes();

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

  return attachOtherFollowups(fields);
}

function collectAndEnrichFields(fields, pageType = classifyCurrentPage().type) {
  const step = getCurrentStep().step;
  const registry = new QuestionRegistry().buildFromFields(fields || [], step);
  return (fields || []).map(field => enrichCanonicalFieldModel(field, pageType, registry));
}

function collectGenericFields(pageType = classifyCurrentPage().type) {
  return collectAndEnrichFields(collectBaseFields(pageType), pageType);
}

function collectFields(pageType = classifyCurrentPage().type) {
  const routed = collectStepFields(getCurrentStep(), pageType);

  if (routed && !Array.isArray(routed) && routed.isReviewPage) {
    return [];
  }

  if (Array.isArray(routed)) {
    return collectAndEnrichFields(routed, pageType);
  }

  return collectGenericFields(pageType);
}

function harvestGenericAtsForm(pageType) {
  return collectBaseFields(pageType);
}

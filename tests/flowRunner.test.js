'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'flowRunner.js'), 'utf8');

const sandbox = {
  normalizePipelineFieldType(fieldOrType) {
    const raw = typeof fieldOrType === 'string'
      ? fieldOrType
      : (fieldOrType?.type || fieldOrType?.tag || '');
    return String(raw || '').toLowerCase();
  },
  normalizePipelineText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  },
  canonicalizeAnswerForField(fieldOrType, answer) {
    const type = typeof fieldOrType === 'string'
      ? fieldOrType
      : String(fieldOrType?.type || fieldOrType?.tag || '').toLowerCase();
    if (type === 'checkbox_group' || type === 'consent_checkbox_group') {
      return Array.isArray(answer) ? answer : String(answer || '').split(',').map(v => String(v).trim()).filter(Boolean);
    }
    return String(Array.isArray(answer) ? answer[0] : answer || '').trim();
  },
  getPipelineOptionLabels(field) {
    return (field.options || []).map(option => typeof option === 'string' ? option : (option.label || option.value || '')).filter(Boolean);
  },
};

vm.runInNewContext(source, sandbox, { filename: 'core/flowRunner.js' });

{
  const log = [];
  const validation = sandbox.recoverStructuredFallbackValidation(
    { type: 'radio', options: [{ label: 'Yes - I can commute daily', value: 'yes' }, { label: 'No', value: 'no' }] },
    { source: 'rule', answer: 'Yes' },
    { ok: false, reason: 'answer "Yes" did not match visible options' },
    { push: msg => log.push(msg) }
  );

  assert.equal(validation.ok, true);
  assert.equal(validation.normalizedAnswer, 'Yes - I can commute daily');
  assert.ok(log.some(line => line.includes('forcing option through validation')));
}

{
  const validation = sandbox.recoverStructuredFallbackValidation(
    { type: 'radio', options: ['Available', 'Unavailable'] },
    { source: 'ai', answer: 'Available' },
    { ok: false, reason: 'still invalid' },
    { push() {} }
  );

  assert.equal(validation.ok, false);
}

console.log('flowRunner.test.js passed');

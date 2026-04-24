'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'questionText.js'), 'utf8');

function makeElement(attrs = {}) {
  return {
    name: attrs.name || '',
    id: attrs.id || '',
    parentElement: null,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : '';
    },
  };
}

const sandbox = {
  cleanQuestionText: value => String(value || '').replace(/\bRequired\b/gi, '').trim(),
  getLabelText: () => '',
  findLabel: () => '',
  CSS: { escape: value => String(value) },
  document: {
    body: {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementById() { return null; },
  },
};

vm.runInNewContext(source, sandbox, { filename: 'core/questionText.js' });

const firstNameEl = makeElement({ autocomplete: 'given-name' });
assert.equal(sandbox.resolveQuestionText(firstNameEl, 'CONTACT_INFO', ''), 'First name');

const genericEl = makeElement({ 'aria-label': 'LinkedIn profile URL' });
assert.equal(sandbox.resolveQuestionText(genericEl, 'ATS_FORM', ''), 'LinkedIn profile URL');

console.log('questionText.test.js passed');


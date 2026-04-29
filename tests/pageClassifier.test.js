'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'pageClassifier.js'), 'utf8');

function loadPageClassifier({ hasCaptcha = false, visibleControls = 0, text = '' } = {}) {
  const controls = Array.from({ length: visibleControls }, () => ({ visible: true }));
  const sandbox = {
    location: {
      href: 'https://jobs.lever.co/acme/posting/apply',
      hostname: 'jobs.lever.co',
    },
    document: {
      querySelector(selector) {
        return hasCaptcha && /captcha|data-sitekey/i.test(selector) ? { id: 'h-captcha' } : null;
      },
      querySelectorAll(selector) {
        if (/input|textarea|select|radiogroup|combobox/i.test(selector)) return controls;
        return [];
      },
    },
    getCurrentStep() {
      return { platform: 'lever', step: 'ATS_FORM' };
    },
    getPageText() {
      return text;
    },
    isVisible(el) {
      return !!el.visible;
    },
    findSubmitButton() {
      return null;
    },
  };

  vm.runInNewContext(source, sandbox, { filename: 'core/pageClassifier.js' });
  return sandbox;
}

{
  const sandbox = loadPageClassifier({
    hasCaptcha: true,
    visibleControls: 4,
    text: 'submit your application full name email phone hcaptcha',
  });

  const result = sandbox.classifyCurrentPage();
  assert.equal(result.type, sandbox.PAGE_TYPES.QUESTION_PAGE);
}

{
  const sandbox = loadPageClassifier({
    hasCaptcha: true,
    visibleControls: 0,
    text: 'one more step',
  });

  const result = sandbox.classifyCurrentPage();
  assert.equal(result.type, sandbox.PAGE_TYPES.CAPTCHA_OR_BLOCKED);
}

console.log('pageClassifier.test.js passed');

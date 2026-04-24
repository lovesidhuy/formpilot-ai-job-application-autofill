'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'stepRouter.js'), 'utf8');

function loadStepRouter(locationOverrides = {}) {
  const sandbox = {
    location: {
      href: 'https://smartapply.indeed.com/beta/indeedapply/form/contact-info',
      hostname: 'smartapply.indeed.com',
      ...locationOverrides,
    },
  };

  vm.runInNewContext(source, sandbox, { filename: 'core/stepRouter.js' });
  return sandbox;
}

{
  const sandbox = loadStepRouter();
  const result = sandbox.getCurrentStep();
  assert.equal(result.platform, 'smartapply');
  assert.equal(result.step, 'CONTACT_INFO');
}

{
  const sandbox = loadStepRouter({
    href: 'https://boards.greenhouse.io/acme/jobs/123',
    hostname: 'boards.greenhouse.io',
  });
  assert.equal(sandbox.detectAtsPlatform('boards.greenhouse.io'), 'greenhouse');
  const result = sandbox.getCurrentStep();
  assert.equal(result.platform, 'greenhouse');
  assert.equal(result.step, 'ATS_FORM');
}

console.log('stepRouter.test.js passed');

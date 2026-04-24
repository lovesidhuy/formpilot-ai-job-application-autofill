'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'harvesters', 'smartapply.js'), 'utf8');

const sandbox = {
  console: { log() {} },
  harvestAriaRadioGroups() {
    return [{
      type: 'radio',
      tag: 'aria-radio',
      question: 'I know where Hanover, ON is and am able to commute there daily.',
      label: 'I know where Hanover, ON is and am able to commute there daily.',
      options: ['Yes', 'No'],
      name: 'commute-confirmation',
    }];
  },
};

vm.runInNewContext(source, sandbox, { filename: 'harvesters/smartapply.js' });

const debug = { rejected: [] };
const finalized = sandbox.finalizeSmartApplyQuestionFields([{
  type: 'textarea',
  tag: 'textarea',
  question: 'I know where Hanover, ON is and am able to commute there daily.',
  label: 'I know where Hanover, ON is and am able to commute there daily.',
  name: 'mirror-textarea',
}], new Set(), debug);

assert.equal(finalized.length, 1);
assert.equal(finalized[0].type, 'radio');
assert.equal(finalized[0].question, 'I know where Hanover, ON is and am able to commute there daily.');
assert.ok(
  debug.rejected.some(entry => entry.reason === 'question_shadowed_by_choice_field'),
  'expected textarea mirror field to be dropped once a structured choice field exists'
);

console.log('smartapply.test.js passed');

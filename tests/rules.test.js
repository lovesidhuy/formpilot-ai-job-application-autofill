'use strict';

const assert = require('assert/strict');
const path = require('path');

const {
  resolveHardRules,
  resolveProfileBoundField,
  resolveHelpfulDefaultField,
  cleanAnswer,
} = require(path.join(__dirname, '..', 'rules.js'));

{
  const result = resolveHardRules(
    { label: 'Are you legally authorized to work in Canada?', type: 'radio', options: ['Yes', 'No'] },
    { country: 'Canada', workAuthorization: true }
  );
  assert.equal(result.answer, 'Yes');
}

{
  const result = resolveProfileBoundField(
    { label: 'Phone number', type: 'tel', options: [] },
    { phone: '+1 604 555 1212' }
  );
  assert.equal(result.answer, '6045551212');
}

assert.equal(cleanAnswer(' Yes ', { type: 'radio', options: ['Yes', 'No'] }, {}), 'Yes');

{
  const result = resolveHelpfulDefaultField(
    {
      label: 'What is the highest level of education you have completed?',
      type: 'select',
      options: ['No diploma', 'Secondary School', 'DCS / DEC', 'AEC / DEP or Skilled Trade Certificate'],
    },
    {
      education: 'Bachelor of Technology - Information Technology, Kwantlen Polytechnic University',
      educationLevel: "Bachelor's degree",
    }
  );
  assert.equal(result.answer, 'DCS / DEC');
}

{
  const result = resolveHelpfulDefaultField(
    {
      label: 'What is the highest level of education you have completed?',
      type: 'select',
      options: ['No diploma', 'Secondary School', "Bachelor's degree"],
    },
    {
      education: 'Bachelor of Technology - Information Technology, Kwantlen Polytechnic University',
      educationLevel: "Bachelor's degree",
    }
  );
  assert.equal(result.answer, "Bachelor's degree");
}

console.log('rules.test.js passed');

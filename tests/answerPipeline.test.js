'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'answerPipeline.js'), 'utf8');
const sandbox = {};

vm.runInNewContext(`${source}\nthis.AnswerPipeline = AnswerPipeline;`, sandbox, { filename: 'core/answerPipeline.js' });

assert.equal(
  sandbox.isStatementLikeTextareaPrompt('I know where Hanover, ON is and am able to commute there daily.'),
  true
);

assert.equal(
  sandbox.isStatementLikeTextareaPrompt('Tell us about yourself.'),
  false
);

{
  const logs = [];
  const pipeline = new sandbox.AnswerPipeline(
    { summary: 'Profile summary' },
    { get() { return null; } },
    'EMP_QUESTIONS',
    '',
    {
      push(msg) { logs.push(msg); },
      question() {},
      ruleAnswer() {},
      profileAnswer() {},
      aiAnswer() {},
      getAll() { return logs; },
      skipping() {},
    }
  );

  sandbox.resolveHardRules = () => null;
  sandbox.resolveProfileBoundField = () => null;
  sandbox.resolveHelpfulDefaultField = () => null;
  sandbox.lookupPipelineMemory = async () => null;
  pipeline.askAi = async () => '__SKIP__';

  (async () => {
    const result = await pipeline.processField({
      id: 'statement-textarea',
      type: 'textarea',
      question: 'I know where Hanover, ON is and am able to commute there daily.',
      label: 'I know where Hanover, ON is and am able to commute there daily.',
      options: [],
    });

    assert.equal(result.source, 'rule');
    assert.equal(result.answer, 'I understand and agree.');
    assert.equal(pipeline.stats.rule, 1);
    assert.ok(logs.some(line => line.includes('statement-like textarea -> auto-affirm')));
    console.log('answerPipeline.test.js passed');
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

{
  const logs = [];
  const pipeline = new sandbox.AnswerPipeline(
    { summary: '', salary: '$85,000', experienceYears: '4' },
    { get() { return null; } },
    'EMP_QUESTIONS',
    '',
    {
      push(msg) { logs.push(msg); },
      question() {},
      ruleAnswer() {},
      profileAnswer() {},
      aiAnswer() {},
      getAll() { return logs; },
      skipping() {},
    }
  );

  sandbox.resolveHardRules = () => null;
  sandbox.resolveProfileBoundField = () => null;
  sandbox.resolveHelpfulDefaultField = () => null;
  sandbox.lookupPipelineMemory = async () => null;
  pipeline.askAi = async () => '__SKIP__';

  (async () => {
    const result = await pipeline.processField({
      id: 'salary-number',
      type: 'number',
      question: 'Expected salary',
      label: 'Expected salary',
      options: [],
    });

    assert.equal(result.source, 'profile');
    assert.equal(result.answer, '85000');
    assert.ok(logs.some(line => line.includes('number salary -> 85000')));
    console.log('answerPipeline salary fallback test passed');
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

{
  const logs = [];
  const pipeline = new sandbox.AnswerPipeline(
    { summary: 'Reusable profile summary' },
    { get() { return null; } },
    'EMP_QUESTIONS',
    '',
    {
      push(msg) { logs.push(msg); },
      question() {},
      ruleAnswer() {},
      profileAnswer() {},
      aiAnswer() {},
      getAll() { return logs; },
      skipping() {},
    }
  );

  sandbox.resolveHardRules = () => null;
  sandbox.resolveProfileBoundField = () => null;
  sandbox.resolveHelpfulDefaultField = () => null;
  sandbox.lookupPipelineMemory = async () => null;
  pipeline.askAi = async () => '__SKIP__';

  (async () => {
    const result = await pipeline.processField({
      id: 'review-copy',
      type: 'textarea',
      question: 'Start of main content Please review your application You will not be able to make changes after you submit your application. This site is protected by reCAPTCHA, and Google’s Privacy Policy and Terms of Service apply.',
      label: 'Start of main content Please review your application You will not be able to make changes after you submit your application. This site is protected by reCAPTCHA, and Google’s Privacy Policy and Terms of Service apply.',
      options: [],
    });

    assert.equal(result.source, 'skipped');
    assert.equal(result.answer, '__SKIP__');
    assert.ok(logs.some(line => line.includes('skipped page/review text')));
    console.log('answerPipeline page chrome guard test passed');
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

{
  const logs = [];
  const pipeline = new sandbox.AnswerPipeline(
    { summary: 'Reusable profile summary' },
    { get() { return null; } },
    'EMP_QUESTIONS',
    '',
    {
      push(msg) { logs.push(msg); },
      question() {},
      ruleAnswer() {},
      profileAnswer() {},
      aiAnswer() {},
      getAll() { return logs; },
      skipping(msg) { logs.push(msg); },
    }
  );

  sandbox.resolveHardRules = () => null;
  sandbox.resolveProfileBoundField = () => null;
  sandbox.resolveHelpfulDefaultField = () => null;
  sandbox.lookupPipelineMemory = async () => null;
  pipeline.askAi = async () => '__SKIP__';

  (async () => {
    const result = await pipeline.processField({
      id: 'custom-textarea',
      type: 'textarea',
      question: 'Describe a recent project that required stakeholder communication.',
      label: 'Describe a recent project that required stakeholder communication.',
      options: [],
    });

    assert.equal(result.source, 'skipped');
    assert.equal(result.answer, '__SKIP__');
    console.log('answerPipeline non-summary textarea fallback test passed');
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

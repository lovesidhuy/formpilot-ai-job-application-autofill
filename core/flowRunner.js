'use strict';

globalThis.__qfFlowRunnerLoaded = true;

function getPageSnapshot() {
  return {
    url: location.href,
    step: getCurrentStep().step,
    text: getPageText().slice(0, 2000),
  };
}

async function waitForNavigation(previousSnapshot, timeout = 2500) {
  await waitForDomChange(previousSnapshot?.text || '', timeout);
  await sleep(100);
  const currentSnapshot = getPageSnapshot();
  return (
    currentSnapshot.url !== previousSnapshot?.url ||
    currentSnapshot.step !== previousSnapshot?.step ||
    currentSnapshot.text !== previousSnapshot?.text
  );
}

async function clickContinueButton() {
  const btn = findContinueButton() || await findAnyNavigationButtonWithRetry();
  if (!btn) return false;
  return clickElement(btn);
}

async function handleResumeSelection() {
  const rawFields = harvestResumeSelectionStep(new Set());
  const fields = collectAndEnrichFields(rawFields, PAGE_TYPES.RESUME_SELECTION);
  if (!fields.length) return false;

  const registry = new QuestionRegistry().buildFromFields(fields, 'RESUME_SELECTION');
  const pipeline = {
    registry,
    pushLog() {},
  };

  for (const field of fields) {
    const option = pickResumeSelectionOption(field);

    if (!option) continue;
    const didApply = await applyAndVerify(field, option, pipeline);
    if (didApply) return true;

    for (const target of field.targets || []) {
      const targetLabel = String(target.label || target.value || '').trim();
      if (
        targetLabel &&
        /upload|add\s+(a\s+)?resume|create\s+(a\s+)?resume|new\s+resume/i.test(targetLabel)
      ) {
        continue;
      }

      const el = resolveElement(target);
      if (!el || !isVisible(el)) continue;
      if (clickElement(el)) return true;
    }
  }

  return false;
}

function pickResumeSelectionOption(field) {
  const options = (field.options || []).map(option =>
    typeof option === 'string' ? option : (option.label || option.value || '')
  ).filter(Boolean);

  if (!options.length) return '';

  const current = String(field.currentValue || field.answer || '').trim();
  if (current) return current;

  const ranked = [
    option => !/\bupload|add\s+(a\s+)?resume|create\s+(a\s+)?resume|new\s+resume\b/i.test(option),
    option => /\b(existing|resume|indeed resume|saved)\b/i.test(option),
    option => true,
  ];

  for (const rule of ranked) {
    const match = options.find(rule);
    if (match) return match;
  }

  return options[0] || '';
}

function describeFlowAnswer(answer) {
  if (Array.isArray(answer)) return `[${answer.join(', ')}]`;
  return String(answer || '');
}

function recoverStructuredFallbackValidation(field, result, validation, logger = null) {
  if (validation?.ok) return validation;
  if (!result || result.source !== 'rule' || result.answer === '__SKIP__') return validation;

  const fieldType = normalizePipelineFieldType(field);
  if (!['radio', 'select', 'aria-radio', 'checkbox_group', 'consent_checkbox_group'].includes(fieldType)) {
    return validation;
  }

  const options = getPipelineOptionLabels(field);
  if (!options.length) return validation;

  const normalizedCandidate = canonicalizeAnswerForField(field, result.answer);

  if (fieldType === 'checkbox_group' || fieldType === 'consent_checkbox_group') {
    const desiredValues = Array.isArray(normalizedCandidate) ? normalizedCandidate : [normalizedCandidate];
    const normalizedOptions = options.map(option => normalizePipelineText(option).toLowerCase());
    const matchedValues = desiredValues
      .map(value => normalizePipelineText(value).toLowerCase())
      .filter(Boolean)
      .filter(value => normalizedOptions.some(option => option === value || option.includes(value) || value.includes(option)));

    if (matchedValues.length) {
      const normalizedAnswer = desiredValues.filter(value => {
        const normalizedValue = normalizePipelineText(value).toLowerCase();
        return normalizedOptions.some(option => option === normalizedValue || option.includes(normalizedValue) || normalizedValue.includes(option));
      });
      logger?.push(`[Fallback] forcing structured checkbox answer through validation: '${describeFlowAnswer(normalizedAnswer)}'`);
      return { ok: true, normalizedAnswer };
    }

    return validation;
  }

  const normalizedAnswer = normalizePipelineText(Array.isArray(normalizedCandidate) ? normalizedCandidate[0] : normalizedCandidate);
  const answerNorm = normalizedAnswer.toLowerCase();
  if (!answerNorm) return validation;

  const matchedOption = options.find(option => {
    const optionNorm = normalizePipelineText(option).toLowerCase();
    return optionNorm === answerNorm || optionNorm.includes(answerNorm) || answerNorm.includes(optionNorm);
  });

  if (matchedOption) {
    logger?.push(`[Fallback] forcing option through validation: '${matchedOption}'`);
    return { ok: true, normalizedAnswer: matchedOption };
  }

  if (['radio', 'select', 'aria-radio'].includes(fieldType)) {
    logger?.push(`[Fallback] forcing first option raw: '${options[0]}'`);
    return { ok: true, normalizedAnswer: options[0] };
  }

  return validation;
}

async function runSmartApplyFlow(maxSteps = 20) {
  let totalFilled = 0;
  const profile = await loadPipelineProfile();
  const jobContext = await _readCachedJobDescription();
  const logger = new FlowLogger();
  const getLog = () => logger.getAll();

  chrome.storage.local.set({ flowCancelled: false });
  reportProgress({
    status: 'running',
    step: 0,
    maxSteps,
    filled: 0,
    message: 'Starting…',
    log: getLog(),
    startedAt: Date.now(),
  });

  for (let step = 0; step < maxSteps; step++) {
    if (await isCancelledInStorage()) {
      logger.skipping('Stopped by user');
      reportProgress({ status: 'stopped', step, maxSteps, filled: totalFilled, message: 'Stopped by user', log: getLog() });
      return { ok: false, submitted: false, totalFilled, error: 'Cancelled by user' };
    }

    const pageInfo = classifyCurrentPage();
    const { platform, step: stepName } = getCurrentStep();
    const beforeSnapshot = getPageSnapshot();

    logger.step(stepName);
    reportProgress({
      status: 'running',
      step: step + 1,
      maxSteps,
      filled: totalFilled,
      message: stepName,
      log: getLog(),
      pageType: pageInfo.type,
      platform,
    });

    if (pageInfo.type === PAGE_TYPES.CAPTCHA_OR_BLOCKED) {
      logger.failed(stepName, 'captcha or access wall');
      reportProgress({ status: 'error', step: step + 1, maxSteps, filled: totalFilled, message: 'Blocked by captcha or access check', log: getLog() });
      return { ok: false, submitted: false, totalFilled, error: 'Captcha or blocked page detected' };
    }

    if (pageInfo.type === PAGE_TYPES.REQUIREMENT_WARNING) {
      const btn = findApplyAnywayButton();
      if (!btn) {
        logger.failed(stepName, 'requirements warning without Apply Anyway button');
        return { ok: false, submitted: false, totalFilled, error: 'Requirements warning without continue path' };
      }
      logger.push('⚠ Requirements warning — clicking Apply Anyway');
      await safeNavigate(btn, beforeSnapshot.text);
      await waitForNavigation(beforeSnapshot);
      continue;
    }

    if (stepName === 'REDIRECT') {
      await sleep(800);
      continue;
    }

    if (stepName === 'REVIEW' || pageInfo.type === PAGE_TYPES.REVIEW_PAGE) {
      logger.push('🏁 Review page — stopping for manual submission');
      reportProgress({ status: 'done', step: step + 1, maxSteps, filled: totalFilled, stoppedAtSubmit: true, log: getLog() });
      return { ok: true, stoppedAtSubmit: true, totalFilled, submitted: false };
    }

    if (stepName === 'RESUME_SELECTION') {
      const handled = await handleResumeSelection();
      if (handled) {
        logger.push('✓ Resume selected, clicking Continue');
        const clicked = await clickContinueButton();
        if (!clicked) return { ok: false, error: 'No Continue button after resume selection', totalFilled, submitted: false };
        const moved = await waitForNavigation(beforeSnapshot);
        if (!moved) {
          return { ok: false, error: 'Resume selection did not advance the page', totalFilled, submitted: false };
        }
        continue;
      }
    }

    const harvestFn = STEP_HARVESTERS[stepName] || STEP_HARVESTERS.ATS_FORM;
    let rawFields = [];
    let harvestSource = 'unknown';
    let harvestDebug = null;
    let fields = [];

    for (let attempt = 0; attempt < 3; attempt++) {
      const seen = new Set();
      rawFields = harvestFn(seen, pageInfo.type);
      harvestSource = Array.isArray(rawFields) ? (rawFields.__harvestSource || 'unknown') : 'unknown';
      harvestDebug = Array.isArray(rawFields) ? rawFields.__harvestDebug : null;
      fields = collectAndEnrichFields(Array.isArray(rawFields) ? rawFields : [], pageInfo.type);

      const shouldRetryEmptyHarvest =
        fields.length === 0 &&
        pageInfo.type === PAGE_TYPES.QUESTION_PAGE &&
        ['CONTACT_INFO', 'LOCATION', 'QUAL_QUESTIONS', 'EMP_QUESTIONS', 'EXPERIENCE', 'ATS_FORM'].includes(stepName);

      if (!shouldRetryEmptyHarvest || attempt === 2) break;
      await sleep(350);
    }

    logger.push(`⟳ Harvest source: ${harvestSource}`);
    if (harvestDebug?.detectorResult) {
      logger.push(`⟳ Detector result: ${harvestDebug.detectorResult}`);
    }
    if (Array.isArray(harvestDebug?.candidateRoots) && harvestDebug.candidateRoots.length) {
      logger.push(`⟳ Candidate roots found: ${harvestDebug.candidateRoots.length}`);
    }
    if (Array.isArray(harvestDebug?.questionContainers) && harvestDebug.questionContainers.length) {
      logger.push(`⟳ Question containers found: ${harvestDebug.questionContainers.length}`);
    }
    if (harvestDebug?.fallbackReason) {
      logger.push(`⟳ Fallback reason: ${harvestDebug.fallbackReason}`);
    }
    if (Array.isArray(harvestDebug?.rejected)) {
      const topRejected = harvestDebug.rejected.slice(0, 5)
        .map(item => `${item.reason}${item.detail ? `:${item.detail}` : ''}`)
        .join(' | ');
      if (topRejected) logger.push(`⟳ Rejected candidates: ${topRejected}`);
    }
    logger.push(`⟳ Found ${fields.length} fields on step: ${stepName}`);

    if (fields.length > 0) {
      const registry = new QuestionRegistry().buildFromFields(fields, stepName);

      for (const field of fields) {
        logger.push(registry.logEntry(field.id));
        reportProgress({ status: 'running', step: step + 1, maxSteps, filled: totalFilled, log: getLog() });
      }

      const pipeline = new AnswerPipeline(profile, registry, stepName, jobContext, logger);
      pipeline._jobContext = jobContext;

      let filledThisStep = 0;

      for (const field of fields) {
        const aiField = {
          ...field,
          ...mapExtractedFieldForAI(field, jobContext),
          id: field.id,
        };
        const result = await pipeline.processField(aiField);
        const originalAnswer = result?.originalAnswer ?? result?.answer;
        let validation = validateAnswerAgainstFieldModel(field, result?.answer);
        validation = recoverStructuredFallbackValidation(field, result, validation, logger);
        logger.push(
          `[Answer] type=${field.type || field.tag || 'unknown'} original='${describeFlowAnswer(originalAnswer)}' normalized='${describeFlowAnswer(validation.ok ? validation.normalizedAnswer : '__INVALID__')}' cache=no`
        );
        if (!validation.ok) {
          logger.failed(describeField(field), validation.reason);
          continue;
        }
        const normalizedAnswer = validation.normalizedAnswer;
        const didApply = await applyAndVerify(field, normalizedAnswer, pipeline);
        let didCache = false;

        if (didApply) {
          filledThisStep++;
          totalFilled++;
          didCache = await storePipelineMemory(
            aiField.questionText || aiField.label || aiField.name || '',
            field,
            normalizedAnswer,
            result?.source || 'ai'
          );
        }

        logger.push(
          `[Answer] type=${field.type || field.tag || 'unknown'} original='${describeFlowAnswer(originalAnswer)}' normalized='${describeFlowAnswer(normalizedAnswer)}' cache=${didCache ? 'yes' : 'no'}`
        );

        reportProgress({
          status: 'running',
          step: step + 1,
          maxSteps,
          filled: totalFilled,
          log: getLog(),
          stats: pipeline.stats,
        });
      }

      logger.push(`✓ Step ${step + 1} — filled ${filledThisStep}/${fields.length}`);
    }

    const blockers = scanBlockingFields(fields);
    if (blockers.hasBlocking) {
      logger.push(`⚠ Blocking fields remain: ${summarizeBlockingFields(blockers)}`);
    }

    const continueBtn = findContinueButton() || await findAnyNavigationButtonWithRetry();
    if (!continueBtn) {
      logger.failed(stepName, 'No Continue button found');
      reportProgress({ status: 'error', step: step + 1, maxSteps, filled: totalFilled, message: 'No Continue button found', log: getLog() });
      return { ok: false, error: 'No Continue button', totalFilled, submitted: false };
    }

    logger.push('→ Clicking Continue');
    await safeNavigate(continueBtn, beforeSnapshot.text);
    const moved = await waitForNavigation(beforeSnapshot);
    if (!moved) {
      const maybeReview = classifyCurrentPage();
      if (maybeReview.type === PAGE_TYPES.REVIEW_PAGE) {
        logger.push('🏁 Review page detected after navigation');
        return { ok: true, stoppedAtSubmit: true, totalFilled, submitted: false };
      }
      logger.failed(stepName, 'Navigation stuck after clicking Continue');
      return { ok: false, error: `Navigation stuck on step ${stepName}`, totalFilled, submitted: false };
    }
  }

  return { ok: false, error: 'Max steps reached', totalFilled, submitted: false };
}

Object.assign(globalThis, {
  runSmartApplyFlow,
});

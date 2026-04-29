'use strict';

const PAGE_TYPES = {
  RESUME_SELECTION: 'RESUME_SELECTION',
  QUESTION_PAGE: 'QUESTION_PAGE',
  REQUIREMENT_WARNING: 'REQUIREMENT_WARNING',
  WHY_APPLYING: 'WHY_APPLYING',
  RELEVANT_EXPERIENCE_JOB: 'RELEVANT_EXPERIENCE_JOB',
  REVIEW_PAGE: 'REVIEW_PAGE',
  CAPTCHA_OR_BLOCKED: 'CAPTCHA_OR_BLOCKED',
  UNKNOWN_PAGE: 'UNKNOWN_PAGE',
};

const FLOW_STATES = {
  SCAN_PAGE: 'SCAN_PAGE',
  CLASSIFY_PAGE: 'CLASSIFY_PAGE',
  BUILD_FIELD_MODELS: 'BUILD_FIELD_MODELS',
  ANSWER_FIELDS: 'ANSWER_FIELDS',
  APPLY_FIELDS: 'APPLY_FIELDS',
  VERIFY_FIELDS: 'VERIFY_FIELDS',
  CHECK_ERRORS: 'CHECK_ERRORS',
  NAVIGATE: 'NAVIGATE',
  WAIT_FOR_PAGE_CHANGE: 'WAIT_FOR_PAGE_CHANGE',
  DONE: 'DONE',
  BLOCKED: 'BLOCKED',
};

function isSmartApplyPage() {
  return getCurrentStep().platform === 'smartapply';
}

function getSmartApplyStep() {
  const route = getCurrentStep();
  const legacyStepMap = {
    RESUME_SELECTION: 'resume-selection',
    QUAL_QUESTIONS: 'qual-questions',
    EMP_QUESTIONS: 'emp-questions',
    CONTACT_INFO: 'contact-info',
    LOCATION: 'location',
    REVIEW: 'review',
    PRIVACY: 'privacy',
    EXPERIENCE: 'experience',
    RESUME_UPLOAD: 'resume',
    REDIRECT: 'redirect',
    UNKNOWN: 'unknown',
  };
  return legacyStepMap[route.step] || 'unknown';
}

function isIndeedPage() {
  return /indeed\.com/i.test(location.hostname);
}

function shouldSkipCurrentPage(text) {
  return (
    text.includes('enter a job that shows relevant experience') ||
    text.includes('we share one job title with the employer to introduce you as a candidate')
  );
}

function isEmployerRequirementsWarningPage(text) {
  return (
    text.includes("it looks like you don't meet these employer requirements") ||
    text.includes('you may not hear back from the employer based on your responses to their questions') ||
    text.includes('you may not hear back from the employer based on your responses')
  );
}

function isReasonForApplyingPage(text) {
  return (
    text.includes("help indeed better understand why you're applying") ||
    text.includes('reason for applying')
  );
}

function isCaptchaOrBlockedPage(text) {
  const bodyText = String(text || '').toLowerCase();
  const hasCaptchaWidget = !!document.querySelector(
    'iframe[src*="captcha"], iframe[src*="recaptcha"], .g-recaptcha, .h-captcha, [data-sitekey], textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"]'
  );
  const hasExplicitBlockText = /verify you are human|security check|access denied|temporarily blocked|unusual traffic|complete the captcha|solve the captcha/i.test(bodyText);
  const hasOnlyLegalNotice = /protected by recaptcha|google.?s privacy policy|terms of service apply/i.test(bodyText) && !hasExplicitBlockText;
  if (hasExplicitBlockText) return true;
  if (!hasCaptchaWidget || hasOnlyLegalNotice) return false;
  return getVisibleQuestionControlCount() === 0;
}

function isResumeSelectionPage(text) {
  return getCurrentStep().step === 'RESUME_SELECTION' ||
    /add a resume for the employer|resume selection|choose a resume|select a resume|upload a resume|existing resume/i.test(text || '');
}

function isReviewPage(text) {
  if (getCurrentStep().step === 'REVIEW') return true;
  if (/please review your application|review your application|application review|before submitting/i.test(text || '')) return true;

  const hasEditableQuestions = getVisibleQuestionControlCount() > 0;
  if (hasEditableQuestions) return false;

  return /submit your application/i.test(text || '') || !!findSubmitButton();
}

function getVisibleQuestionControlCount() {
  const selectors = [
    'input:not([type="hidden"]):not([type="button"]):not([type="submit"])',
    'textarea',
    'select',
    '[role="radiogroup"]',
    '[role="combobox"]',
  ];
  return selectors.reduce((count, selector) => {
    return count + Array.from(document.querySelectorAll(selector)).filter(isVisible).length;
  }, 0);
}

function classifyCurrentPage(pageText = getPageText()) {
  const text = String(pageText || '').toLowerCase();
  const route = getCurrentStep();
  const step = route.step;

  if (isCaptchaOrBlockedPage(text)) {
    return { type: PAGE_TYPES.CAPTCHA_OR_BLOCKED, step, reason: 'captcha_or_blocked' };
  }
  if (isEmployerRequirementsWarningPage(text)) {
    return { type: PAGE_TYPES.REQUIREMENT_WARNING, step, reason: 'requirements_warning' };
  }
  if (isReasonForApplyingPage(text)) {
    return { type: PAGE_TYPES.WHY_APPLYING, step, reason: 'why_applying' };
  }
  if (shouldSkipCurrentPage(text)) {
    return { type: PAGE_TYPES.RELEVANT_EXPERIENCE_JOB, step, reason: 'relevant_experience_job' };
  }
  if (isResumeSelectionPage(text)) {
    return { type: PAGE_TYPES.RESUME_SELECTION, step, reason: 'resume_selection' };
  }
  if (isReviewPage(text)) {
    return { type: PAGE_TYPES.REVIEW_PAGE, step, reason: 'review' };
  }
  if (
    step === 'QUAL_QUESTIONS' ||
    step === 'EMP_QUESTIONS' ||
    step === 'CONTACT_INFO' ||
    step === 'LOCATION' ||
    step === 'EXPERIENCE' ||
    step === 'ATS_FORM' ||
    getVisibleQuestionControlCount() > 0
  ) {
    return { type: PAGE_TYPES.QUESTION_PAGE, step, reason: 'question_controls' };
  }
  return { type: PAGE_TYPES.UNKNOWN_PAGE, step, reason: 'unclassified' };
}

Object.assign(globalThis, {
  PAGE_TYPES,
  FLOW_STATES,
  isSmartApplyPage,
  getSmartApplyStep,
  isIndeedPage,
  shouldSkipCurrentPage,
  isEmployerRequirementsWarningPage,
  isReasonForApplyingPage,
  isCaptchaOrBlockedPage,
  isResumeSelectionPage,
  isReviewPage,
  getVisibleQuestionControlCount,
  classifyCurrentPage,
});

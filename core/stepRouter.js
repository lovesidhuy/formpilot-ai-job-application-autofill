'use strict';

const SMARTAPPLY_STEPS = {
  'resume-selection-module': 'RESUME_SELECTION',
  'contact-info': 'CONTACT_INFO',
  'profile-location': 'LOCATION',
  'qualification-questions-module': 'QUAL_QUESTIONS',
  'questions-module': 'EMP_QUESTIONS',
  'experience': 'EXPERIENCE',
  'privacy': 'PRIVACY',
  'resume': 'RESUME_UPLOAD',
  'review': 'REVIEW',
  'applybyapplyablejobid': 'REDIRECT',
};

function detectAtsPlatform(domain = location.hostname) {
  const normalized = String(domain || '').toLowerCase();
  if (normalized.includes('greenhouse.io')) return 'greenhouse';
  if (normalized.includes('workday.com')) return 'workday';
  if (normalized.includes('myworkdayjobs.com')) return 'workday';
  if (normalized.includes('lever.co')) return 'lever';
  if (normalized.includes('jobvite.com')) return 'jobvite';
  if (normalized.includes('icims.com')) return 'icims';
  if (normalized.includes('taleo.net')) return 'taleo';
  if (normalized.includes('smartrecruiters.com')) return 'smartrecruiters';
  if (normalized.includes('ashbyhq.com')) return 'ashby';
  if (normalized.includes('bamboohr.com')) return 'bamboohr';
  if (normalized.includes('rippling.com')) return 'rippling';
  if (normalized.includes('linkedin.com')) return 'linkedin';
  return 'generic';
}

function getCurrentStep() {
  const url = location.href.toLowerCase();
  const domain = location.hostname.toLowerCase();

  if (domain.includes('smartapply.indeed.com')) {
    for (const [fragment, step] of Object.entries(SMARTAPPLY_STEPS)) {
      if (url.includes(fragment)) return { platform: 'smartapply', step };
    }
    return { platform: 'smartapply', step: 'UNKNOWN' };
  }

  if (domain.includes('indeed.com')) {
    return { platform: 'indeed', step: 'JOB_PAGE' };
  }

  return {
    platform: detectAtsPlatform(domain),
    step: 'ATS_FORM',
  };
}

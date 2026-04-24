// QuickFill AI – rules.js v3.3
// Fix over v3.2:
//   - resolveDirectField: salary/compensation early-exit guard added before
//     headline rule. Prevents "position" in salary labels from matching the
//     headline regex and returning the job title as a salary answer.
//   - resolveDirectField: headline rule now also excludes labels containing
//     salary/compensation/expectations/annual/indicate/range keywords.
//   - estimateExperienceYears: final fallback now returns '0' instead of
//     defaultExp when the question names a tool not found in profile skills.
//     Fixes JD Edwards / unknown ERP tools being answered with profile years.

'use strict';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fieldText(field) {
  return [
    field.label       || '',
    field.name        || '',
    field.placeholder || '',
    field.id          || '',
    field.type        || '',
  ].join(' ').toLowerCase();
}

function fieldControlType(field) {
  return String(field.type || field.tag || '').toLowerCase();
}

function optionText(option) {
  if (typeof option === 'string') return option;
  if (option && typeof option === 'object') return String(option.label || option.value || '').trim();
  return String(option || '').trim();
}

function optionList(field) {
  return (field.options || []).map(optionText).filter(Boolean);
}

function looksLikeCountryOptionList(options) {
  const opts = (options || []).map(o => String(o || '').trim().toLowerCase()).filter(Boolean);
  return (
    opts.length >= 20 &&
    opts.includes('canada') &&
    opts.includes('united states') &&
    opts.includes('afghanistan')
  );
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function inferFieldOfStudy(profile) {
  const explicit = String(profile.fieldOfStudy || '').trim();
  if (explicit) return explicit;

  const education = String(profile.education || '').trim();
  if (!education) return '';

  const matched = firstMatch(education, [
    /\b(?:bachelor|master|masters|doctorate|phd|diploma|certificate|associate(?:'s)?|b\.?\s*tech|b\.?\s*sc)\s+(?:of|in)\s+([^,()]+)/i,
    /\bmajor(?:ed)?\s+in\s+([^,()]+)/i,
    /\bfield\s+of\s+study[:\s]+([^,()]+)/i,
  ]);

  return matched || education;
}

function inferGradYear(profile) {
  const explicit = String(profile.gradYear || '').trim();
  if (/^(19|20)\d{2}$/.test(explicit)) return explicit;

  const education = String(profile.education || '').trim();
  const matched = education.match(/\b(19|20)\d{2}\b/);
  return matched ? matched[0] : '';
}

function inferSchoolName(profile) {
  const education = String(profile.education || '').trim();
  if (!education) return '';

  const bySplit = education.split(/[-|,()]/).map(part => part.trim()).filter(Boolean);
  const schoolish = bySplit.find(part => /\b(university|college|institute|polytechnic|school)\b/i.test(part));
  return schoolish || education;
}

function inferDegreeText(profile) {
  const education = String(profile.education || '').trim();
  if (!education) return '';

  const bySplit = education.split(/[-|,()]/).map(part => part.trim()).filter(Boolean);
  const degreeish = bySplit.find(part => /\b(bachelor|master|masters|doctorate|phd|diploma|certificate|associate|b\.?\s*tech|b\.?\s*sc|m\.?\s*sc)\b/i.test(part));
  return degreeish || education;
}

function inferShortHeadline(profile) {
  const headline = String(profile.headline || '').trim();
  if (!headline) return '';

  const cleaned = headline
    .replace(/\.$/, '')
    .replace(/\s+speciali[sz]ing\s+in.*$/i, '')
    .replace(/\s+with\s+a?\s*focus\s+on.*$/i, '')
    .trim();

  return cleaned || headline;
}

function scoreEducationOption(option) {
  const text = String(option || '').trim().toLowerCase();
  if (!text) return -1;
  if (/no diploma|none|no degree/i.test(text)) return 0;
  if (/doctor|phd|doctorate|md\b|juris doctor/i.test(text)) return 90;
  if (/master|mba\b|m\.sc|ma\b/i.test(text)) return 80;
  if (/bachelor|b\.sc|bsc\b|b\.tech|ba\b|bs\b/i.test(text)) return 70;
  if (/dcs|dec|associate/i.test(text)) return 60;
  if (/aec|dep|trade certificate|certificate|diploma/i.test(text)) return 50;
  if (/secondary|high school/i.test(text)) return 20;
  return 10;
}

function normalizeEducationLevel(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (/no diploma|none|no degree/.test(text)) return 'none';
  if (/doctor|phd|doctorate|juris doctor|md\b/.test(text)) return 'doctorate';
  if (/master|mba\b|m\.sc|ma\b/.test(text)) return 'masters';
  if (/bachelor|b\.sc|bsc\b|b\.tech|ba\b|bs\b|undergraduate|university/.test(text)) return 'bachelors';
  if (/associate|dec|dcs/.test(text)) return 'associate';
  if (/certificate|diploma|trade|aec|dep/.test(text)) return 'certificate';
  if (/secondary|high school/.test(text)) return 'secondary';
  return '';
}

function pickEducationLevelAnswer(field, profile) {
  const opts = optionList(field);
  if (!opts.length) return null;

  const explicitLevel = normalizeEducationLevel(profile.educationLevel || '');
  const inferredLevel = normalizeEducationLevel(inferDegreeText(profile));
  const degreeText = inferDegreeText(profile).toLowerCase();
  const level = explicitLevel || inferredLevel;

  const explicitLevelMatchers = [
    level === 'doctorate' ? /\b(doctor|phd|doctorate|juris doctor)\b/i : null,
    level === 'masters' ? /\bmaster\b|mba\b|m\.sc|ma\b/i : null,
    level === 'bachelors' ? /\bbachelor\b|\bb\.?tech\b|\bb\.?sc\b|\bbs\b|\bba\b/i : null,
    level === 'associate' ? /\bassociate\b|\bdcs\b|\bdec\b/i : null,
    level === 'certificate' ? /\bcertificate\b|\bdiploma\b|\bdep\b|\baec\b|\btrade\b/i : null,
    level === 'secondary' ? /\bsecondary\b|high school/i : null,
    level === 'none' ? /\bno diploma\b|\bno degree\b|\bnone\b/i : null,
  ].filter(Boolean);

  for (const matcher of explicitLevelMatchers) {
    const match = opts.find(o => matcher.test(o));
    if (match) return { answer: match, source: 'rule' };
  }

  const rankedMatchers = [
    degreeText.includes('doctor') || degreeText.includes('phd') ? /\b(doctor|phd|doctorate|juris doctor)\b/i : null,
    degreeText.includes('master') ? /\bmaster\b/i : null,
    degreeText.includes('bachelor') || degreeText.includes('b.tech') || degreeText.includes('technology') ? /\bbachelor\b|\bb\.?tech\b/i : null,
    degreeText.includes('associate') || degreeText.includes('dec') || degreeText.includes('dcs') ? /\bassociate\b|\bdcs\b|\bdec\b/i : null,
    degreeText.includes('diploma') ? /\bdiploma\b/i : null,
    degreeText.includes('certificate') ? /\bcertificate\b|\bdep\b|\baec\b/i : null,
  ].filter(Boolean);

  for (const matcher of rankedMatchers) {
    const match = opts.find(o => matcher.test(o));
    if (match) return { answer: match, source: 'rule' };
  }

  if (profile.education) {
    const sorted = [...opts]
      .map(option => ({ option, score: scoreEducationOption(option) }))
      .sort((a, b) => b.score - a.score);
    const best = sorted.find(item => item.score >= 50) || sorted.find(item => item.score > 0);
    if (best) return { answer: best.option, source: 'rule' };
  }

  return null;
}

function isGenericFieldLabel(field) {
  const text = String(field.label || field.name || field.id || '').trim().toLowerCase();
  return (
    !text ||
    /^q_[a-f0-9]{8,}$/i.test(text) ||
    text === 'unknown field' ||
    text === 'select one option' ||
    text === 'select an option'
  );
}

function isDescriptiveTextField(field) {
  const type = fieldControlType(field);
  const text = fieldText(field);
  return (
    type === 'textarea' ||
    field.multiline === true ||
    /describe|please\s+describe|tell\s+us\s+about|explain|details|detail|elaborate/.test(text)
  );
}

function isCheckboxGroupField(field) {
  const type = fieldControlType(field);
  return type === 'checkbox_group' || type === 'checkbox-group' || type === 'consent_checkbox_group';
}

function isChoiceField(field) {
  const type = fieldControlType(field);
  return ['radio', 'checkbox', 'checkbox_group', 'checkbox-group', 'consent_checkbox_group', 'select', 'aria-radio'].includes(type);
}

function getAnswerMode(field) {
  const type = fieldControlType(field);
  if (isDescriptiveTextField(field)) return 'descriptive_assist';
  if (isCheckboxGroupField(field)) return 'helpful_default';
  if (['radio', 'select', 'checkbox', 'checkbox-group', 'checkbox_group', 'consent_checkbox_group', 'aria-radio'].includes(type)) {
    return 'helpful_default';
  }
  if (isNumericExperienceField(field) || ['number', 'date'].includes(type)) return 'scalar';
  return 'profile_strict';
}

function profileValueOrSkip(value, fallback = '__SKIP__') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function phoneDigitsOrSkip(value, fallback = '__SKIP__') {
  let digits = String(value ?? '').replace(/\D+/g, '').trim();
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits || fallback;
}

function pickYesNo(field, wantYes) {
  const trueish  = ['yes', 'true', 'oui', '1'];
  const falseish = ['no', 'false', 'non', '0'];
  const opts = optionList(field);

  if (opts.length) {
    const pool = wantYes ? trueish : falseish;

    const exact = opts.find(o => pool.includes(o.trim().toLowerCase()));
    if (exact) return { answer: exact, source: 'rule' };

    const starts = opts.find(o =>
      pool.some(p => o.trim().toLowerCase().startsWith(p))
    );
    if (starts) return { answer: starts, source: 'rule' };

    const target   = wantYes ? 'yes' : 'no';
    const antiStr  = wantYes ? 'no'  : 'yes';
    const contains = opts.find(o => {
      const l = o.trim().toLowerCase();
      return l.includes(target) && !l.startsWith(antiStr);
    });
    if (contains) return { answer: contains, source: 'rule' };
  }

  return { answer: wantYes ? 'Yes' : 'No', source: 'rule' };
}

function pickDisclosureOption(field) {
  const opts = optionList(field);
  if (opts.length) {
    const rankedMatchers = [
      /prefer\s+not\s+to\s+(say|answer|disclose|self-?identify)/i,
      /choose\s+not\s+to\s+(say|answer|disclose|self-?identify)/i,
      /decline\s+to\s+(say|answer|disclose|self-?identify)/i,
      /do\s+not\s+wish\s+to\s+(say|answer|disclose|self-?identify)/i,
      /not\s+disclos/i,
      /not\s+specified/i,
      /\bunknown\b/i,
    ];

    for (const matcher of rankedMatchers) {
      const match = opts.find(o => matcher.test(o));
      if (match) return { answer: match, source: 'rule' };
    }
  }

  return { answer: 'Prefer not to disclose', source: 'rule' };
}

function resolveHardRules(field, profile) {
  const text = fieldText(field);
  if (isDescriptiveTextField(field) && !isChoiceField(field)) return null;
  if (isNumericExperienceField(field)) return null;

  if (/\bgpa\b|\bgrade point average\b/.test(text)) {
    return { answer: '__SKIP__', source: 'rule' };
  }

  const workEligibility = resolveWorkEligibility(field, profile);
  if (workEligibility) return workEligibility;

  if (
    /currently\s+(employed|working)|presently\s+(employed|working)|are\s+you\s+currently\s+employed|current\s+employment\s+status/i.test(text) &&
    !/previous|ever|history|most\s+recent|current employer|current company|current title/i.test(text)
  ) {
    if (field.options && field.options.length) return pickYesNo(field, false);
    return { answer: 'No', source: 'rule' };
  }

  if (
    /relocat|commute|commuting|able\s+to\s+travel\s+to\s+work|make\s+the\s+commute|work\s+on-?site|work\s+from\s+the\s+office/i.test(text) &&
    isChoiceField(field)
  ) {
    if (field.options && field.options.length) return pickYesNo(field, true);
    return { answer: 'Yes', source: 'rule' };
  }

  if (
    /(background\s+check|drug\s+test|drug\s+screen|screening|pre-?employment\s+testing|reference\s+check|education\s+verification)/i.test(text) &&
    /(consent|agree|authorize|willing|able|comfortable|complete|submit|pass|participate|proceed|undergo|requirement)/i.test(text)
  ) {
    if (field.options && field.options.length) return pickYesNo(field, true);
    return { answer: 'Yes', source: 'rule' };
  }

  if (
    /(understand|accept|acknowledge|confirm)/i.test(text) &&
    /(equal employment opportunity|eeo|diversity and inclusion|non-?discrimination|harassment)/i.test(text)
  ) {
    if (field.options && field.options.length) return pickYesNo(field, true);
    return { answer: 'Yes', source: 'rule' };
  }

  if (/driver'?s\s+licen[cs]e|valid\s+licen[cs]e|hold\s+a\s+licen[cs]e/.test(text)) {
    if (field.options && field.options.length) return pickYesNo(field, true);
    return { answer: 'Yes', source: 'rule' };
  }

  if (/own\s+(a|your)\s+(computer|laptop)|access\s+to\s+(a|your)\s+(computer|laptop)|have\s+(a|your)\s+(computer|laptop)/i.test(text)) {
    if (field.options && field.options.length) return pickYesNo(field, true);
    return { answer: 'Yes', source: 'rule' };
  }

  if (/speak\s+english|english\s+(speaker|fluency|fluent|proficiency)|proficient\s+in\s+english/i.test(text)) {
    if (field.options && field.options.length) return pickYesNo(field, true);
    return { answer: 'Yes', source: 'rule' };
  }

  if (/\b(referred\s+by(\s*\(|\b)|(an?\s+)?employee\s+referral|internal\s+referral|referred\s+by\s+(a\s+)?current\s+employee)\b/i.test(text)) {
    if (field.options && field.options.length) return pickYesNo(field, false);
    return { answer: 'No', source: 'rule' };
  }

  if (/\bhow\s+did\s+you\s+hear\s+about\s+(us|this role|this position|this job)\b|\bsource\b.*\bapplication\b/i.test(text)) {
    if (field.options && field.options.length) {
      const indeed = optionList(field).find(o => /\bindeed\b/i.test(o));
      if (indeed) return { answer: indeed, source: 'rule' };
    }
    return { answer: 'Indeed', source: 'rule' };
  }

  if (/worked\s+(for|with|here|at)\s+(us|this\s+company)|previously\s+work(?:ed)?\s+(here|for\s+us)|have\s+you\s+ever\s+(?:worked|been\s+employed)|have\s+you\s+ever\s+been\s+employed\s+by|been\s+employed\s+by\s+(infosys|us|this\s+company)|previous.*employee|former.*employee|rehire|re-?hire/i.test(text)) {
    if (field.options && field.options.length) return pickYesNo(field, false);
    return { answer: 'No', source: 'rule' };
  }

  if (/at\s+least\s+18|over\s+18|18\s+years?\s+of\s+age|be\s+18|minimum\s+age/i.test(text) &&
      isChoiceField(field)) {
    return pickYesNo(field, true);
  }

  if (/drug\s+test|substance\s+test|substance\s+screen/i.test(text) &&
      isChoiceField(field)) {
    return pickYesNo(field, true);
  }

  if (/convicted|felony|criminal\s+charge|criminal\s+offence|pending\s+charge/i.test(text) &&
      isChoiceField(field) &&
      !/background\s+check|screening|consent/i.test(text)) {
    return pickYesNo(field, false);
  }

  if (/work\s+for\s+any\s+of|ever\s+work(?:ed)?\s+at\s+any/i.test(text) &&
      isChoiceField(field)) {
    return pickYesNo(field, false);
  }

  if (/lgbtq|sexual\s+orientation|sexual\s+identity/i.test(text) &&
      isChoiceField(field)) {
    return pickDisclosureOption(field);
  }

  if (/\b(gender|sex|pronouns?|ethnicity|race|racial|disability|disabled|veteran|aboriginal|indigenous|visible\s+minority|self-?identify)\b/i.test(text)) {
    return pickDisclosureOption(field);
  }

  return null;
}

function pickAvailabilityAnswer(field) {
  const opts = optionList(field);
  const text = fieldText(field);

  if (/notice\s+period|serve.*current organization/i.test(text) && /\bmonths?\b/i.test(text)) {
    if (opts.length) {
      const ranked = [
        /\b0\b|\bimmediate\b|less than 1 month/i,
        /\b1\b|\bone month\b/i,
      ];
      for (const matcher of ranked) {
        const match = opts.find(o => matcher.test(String(o).trim()));
        if (match) return { answer: match, source: 'rule' };
      }
      const numericMonth = opts.find(o => /\b\d+(\.\d+)?\b/.test(String(o)));
      if (numericMonth) return { answer: numericMonth, source: 'rule' };
    }
    return { answer: '0', source: 'rule' };
  }

  if (opts.length) {
    const rankedMatchers = [
      /\b2\s*weeks?\b/i,
      /\btwo\s*weeks?\b/i,
      /\b14\s*days?\b/i,
      /\b15\s*days?\b/i,
      /\b0\s*months?\b/i,
      /\bimmediate(?:ly)?\b/i,
      /\basap\b/i,
      /\bright\s+away\b/i,
      /\b1\s*week\b/i,
      /\bone\s*week\b/i,
      /\bwithin\s+2\s+weeks?\b/i,
    ];

    for (const matcher of rankedMatchers) {
      const match = opts.find(o => matcher.test(String(o).trim()));
      if (match) return { answer: match, source: 'rule' };
    }

    const shortNotice = opts.find(o => {
      const t = String(o).trim().toLowerCase();
      return (
        /week|day|immediate|asap/.test(t) &&
        !/month|30\s*day|60\s*day|90\s*day|3\s*month/.test(t)
      );
    });
    if (shortNotice) return { answer: shortNotice, source: 'rule' };
  }

  return { answer: '2 weeks', source: 'rule' };
}

function pickCountryOptionAnswer(field, profile) {
  const opts = optionList(field);
  if (!opts.length) return null;
  const preferred = normalizeCountryName(profile.country || '');
  if (!preferred) return null;

  const exact = opts.find(o => normalizeCountryName(o) === preferred);
  if (exact) return { answer: exact, source: 'profile' };

  const aliases = preferred === 'canada'
    ? ['canada']
    : preferred === 'united states'
      ? ['united states', 'usa']
      : [preferred];

  const aliasMatch = opts.find(o => {
    const normalized = normalizeCountryName(o);
    return aliases.some(alias => normalized === alias || normalized.includes(alias));
  });
  if (aliasMatch) return { answer: aliasMatch, source: 'profile' };

  if (!looksLikeCountryOptionList(opts)) return null;

  const partial = opts.find(o => {
    const normalized = normalizeCountryName(o);
    return preferred.length >= 5 && normalized.includes(preferred);
  });
  if (partial) return { answer: partial, source: 'profile' };
  return null;
}

function pickDialCodeOptionAnswer(field, profile) {
  const opts = optionList(field);
  if (!opts.length) return null;

  const normalized = opts.map(option => ({
    raw: option,
    lower: String(option || '').trim().toLowerCase(),
  }));

  const looksLikeDialCodeSelect = normalized.filter(({ lower }) => /\+\d+/.test(lower)).length >= Math.min(3, normalized.length);
  if (!looksLikeDialCodeSelect) return null;

  const preferredCountry = String(profile.country || '').trim().toLowerCase();
  const countryAliases = preferredCountry === 'canada'
    ? ['canada', 'ca', 'north america']
    : preferredCountry
      ? [preferredCountry]
      : [];

  for (const alias of countryAliases) {
    const exactCountry = normalized.find(option => option.lower.includes(alias));
    if (exactCountry) return { answer: exactCountry.raw, source: 'profile' };
  }

  const northAmerica = normalized.find(option =>
    /\(\+1\)/.test(option.lower) && /\b(canada|united states|usa|us)\b/.test(option.lower)
  );
  if (northAmerica) return { answer: northAmerica.raw, source: 'profile' };

  const canadaOnly = normalized.find(option => /\bcanada\b/.test(option.lower));
  if (canadaOnly) return { answer: canadaOnly.raw, source: 'profile' };

  return null;
}

function isAvailabilityOrStartQuestion(text) {
  return /\b(start|available|availability|join|joining|notice|date)\b/i.test(text);
}

function isAvailabilityWindowQuestion(text) {
  return /\bavailable\s+to\s+start\b.*\bwithin\b.*\b\d+\s*days?\b/i.test(text) ||
    /\bcan\s+you\s+start\b.*\bwithin\b.*\b\d+\s*days?\b/i.test(text) ||
    /\bstart\b.*\bwithin\b.*\b\d+\s*days?\b/i.test(text) ||
    /\bavailable\s+within\s+the\s+next\b.*\b\d+\s*days?\b/i.test(text);
}

function pickTransportationAnswer(field) {
  const opts = optionList(field);
  if (opts.length) {
    const rankedMatchers = [
      /\bcar\b/i,
      /\bown\s+vehicle\b/i,
      /\bpersonal\s+vehicle\b/i,
      /\bdrive\b/i,
      /\btransit\b/i,
      /\bpublic\s+transport/i,
      /\bbus\b/i,
      /\btrain\b/i,
    ];
    for (const matcher of rankedMatchers) {
      const match = opts.find(o => matcher.test(String(o).trim()));
      if (match) return { answer: match, source: 'rule' };
    }
  }
  return { answer: 'Car', source: 'rule' };
}

function pickCommuteNumericAnswer(field) {
  const opts = optionList(field);
  const preferred = ['45', '30', '60'];

  if (opts.length) {
    for (const value of preferred) {
      const exact = opts.find(o => new RegExp(`\\b${value}\\b`).test(String(o)));
      if (exact) return { answer: exact, source: 'rule' };
    }

    const minuteOption = opts.find(o => /\b\d+\b/.test(String(o)));
    if (minuteOption) return { answer: minuteOption, source: 'rule' };
  }

  return { answer: '45', source: 'rule' };
}

function pickSalaryRangeAnswer(field, profile) {
  const opts = optionList(field);
  const salary = parseInt(String(profile.salary || '').replace(/[^\d]/g, ''), 10);
  if (!opts.length) return null;
  if (!Number.isFinite(salary)) return { answer: opts[0], source: 'rule' };

  let best = null;
  let bestDistance = Infinity;
  for (const opt of opts) {
    const nums = (opt.match(/\d[\d,]*/g) || []).map(n => parseInt(n.replace(/,/g, ''), 10)).filter(Number.isFinite);
    if (!nums.length) continue;
    const lo = nums[0];
    const hi = nums.length > 1 ? nums[1] : nums[0];
    if (salary >= Math.min(lo, hi) && salary <= Math.max(lo, hi)) {
      return { answer: opt, source: 'rule' };
    }
    const midpoint = nums.length > 1 ? (lo + hi) / 2 : lo;
    const distance = Math.abs(salary - midpoint);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = opt;
    }
  }
  return best ? { answer: best, source: 'rule' } : { answer: opts[0], source: 'rule' };
}

function pickExperienceOptionAnswer(field, profile) {
  const opts = optionList(field);
  if (!opts.length) return null;

  const estimate = String(estimateExperienceYears(field, profile) || '0').trim();
  const estimateNum = parseFloat(estimate);

  const noneLike = opts.find(o => /\bnone\b|no experience|not applicable|n\/a/i.test(o));
  if ((estimate === '0' || estimateNum === 0) && noneLike) {
    return { answer: noneLike, source: 'rule' };
  }

  for (const opt of opts) {
    const label = opt.trim().toLowerCase();
    if (label === estimate.toLowerCase()) return { answer: opt, source: 'rule' };
    if (/less\s+than\s+1|under\s+1|0\s*[-–]\s*1|fewer\s+than\s+1/.test(label) && estimateNum < 1) {
      return { answer: opt, source: 'rule' };
    }
    const nums = (label.match(/\d+/g) || []).map(Number);
    if (nums.length >= 2) {
      const lo = Math.min(...nums);
      const hi = Math.max(...nums);
      if (estimateNum >= lo && estimateNum <= hi) return { answer: opt, source: 'rule' };
    } else if (nums.length === 1 && /\+|or more|more than/.test(label) && estimateNum >= nums[0]) {
      return { answer: opt, source: 'rule' };
    }
  }

  return { answer: opts[0], source: 'rule' };
}

function pickCheckboxGroupAnswers(field, preferredMatchers, fallbackMatchers = []) {
  const opts = (field.options || []).map(o =>
    typeof o === 'string' ? o : String(o?.label || o?.value || '')
  ).filter(Boolean);
  const chosen = [];
  const seen = new Set();

  for (const matcher of preferredMatchers) {
    const match = opts.find(o => matcher.test(o.trim()));
    if (match && !seen.has(match)) {
      seen.add(match);
      chosen.push(match);
    }
  }

  if (!chosen.length) {
    for (const matcher of fallbackMatchers) {
      const match = opts.find(o => matcher.test(o.trim()));
      if (match && !seen.has(match)) {
        seen.add(match);
        chosen.push(match);
      }
    }
  }

  return chosen.length ? { answer: chosen, source: 'rule' } : null;
}

function pickAvailabilityCheckboxAnswers(field) {
  const opts = (field.options || []).map(o =>
    typeof o === 'string' ? o : String(o?.label || o?.value || '')
  ).filter(Boolean);
  const chosen = [];
  const seen = new Set();

  const weekdayMatchers = [
    /\bmonday\b/i,
    /\btuesday\b/i,
    /\bwednesday\b/i,
    /\bthursday\b/i,
    /\bfriday\b/i,
  ];

  for (const matcher of weekdayMatchers) {
    const match = opts.find(o => matcher.test(o.trim()));
    if (match && !seen.has(match)) {
      seen.add(match);
      chosen.push(match);
    }
  }

  if (chosen.length) return { answer: chosen, source: 'rule' };

  return pickCheckboxGroupAnswers(
    field,
    [/\bmonday\b.*\bfriday\b/i, /\bmon(?:day)?\s*-\s*fri(?:day)?\b/i, /\bweekdays?\b/i, /\bdays?\b/i],
    [/\bmorning\b/i, /\bday\b/i, /\bafternoon\b/i]
  );
}

function pickOfficeLocationCheckboxAnswers(field, profile) {
  const opts = optionList(field);
  if (!opts.length) return null;

  const normalized = opts.map(option => ({
    raw: option,
    lower: String(option || '').trim().toLowerCase(),
  }));

  const profileCity = String(profile.city || '').trim().toLowerCase();
  const profileProvince = String(profile.province || '').trim().toLowerCase();
  const profileCountry = normalizeCountryName(profile.country || '');

  if (profileCity) {
    const exactCity = normalized.find(option => option.lower === profileCity);
    if (exactCity) return { answer: [exactCity.raw], source: 'profile' };

    const partialCity = normalized.find(option =>
      option.lower.includes(profileCity) || profileCity.includes(option.lower)
    );
    if (partialCity) return { answer: [partialCity.raw], source: 'profile' };
  }

  const provinceOfficePreference = {
    bc: ['vancouver', 'surrey', 'burnaby', 'richmond', 'victoria', 'kelowna', 'kamloops'],
    'british columbia': ['vancouver', 'surrey', 'burnaby', 'richmond', 'victoria', 'kelowna', 'kamloops'],
    ab: ['calgary', 'edmonton'],
    alberta: ['calgary', 'edmonton'],
    on: ['toronto', 'ottawa', 'mississauga', 'waterloo'],
    ontario: ['toronto', 'ottawa', 'mississauga', 'waterloo'],
    qc: ['montreal', 'québec', 'quebec'],
    quebec: ['montreal', 'québec', 'quebec'],
  };

  const preferredCities = provinceOfficePreference[profileProvince] || [];
  for (const city of preferredCities) {
    const match = normalized.find(option => option.lower === city || option.lower.includes(city));
    if (match) return { answer: [match.raw], source: 'profile' };
  }

  if (profileCountry === 'canada') {
    const canadianFallbacks = ['vancouver', 'toronto', 'calgary', 'ottawa', 'montreal'];
    for (const city of canadianFallbacks) {
      const match = normalized.find(option => option.lower === city || option.lower.includes(city));
      if (match) return { answer: [match.raw], source: 'profile' };
    }
  }

  return null;
}

function normalizeCountryName(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (/\b(us|u\.s\.|u\.s\.a\.|usa|united states|america)\b/.test(text)) return 'united states';
  if (/\b(canada|ca)\b/.test(text)) return 'canada';
  if (/\b(united kingdom|uk|u\.k\.|great britain|britain|england)\b/.test(text)) return 'united kingdom';
  return text;
}

function detectQuestionCountry(text) {
  if (/\b(us|u\.s\.|u\.s\.a\.|usa|united states|america|american visa)\b/.test(text)) return 'united states';
  if (/\b(canada|canadian visa|reside in canada|work in canada)\b/.test(text)) return 'canada';
  if (/\b(united kingdom|uk|u\.k\.|great britain|britain|england)\b/.test(text)) return 'united kingdom';
  return '';
}

function isSponsorshipQuestion(text) {
  return /sponsor|sponsorship|visa|work permit|employment authorization document|ead|h-1b|h1b|opt|cpt|tn visa/i.test(text);
}

function isWorkAuthQuestion(text) {
  return /authorized to work|right to work|legally authorized|eligible to work|able to work|permit to work|work authorization|legally eligible to work in canada|authorized to work in canada|legally able to work in this country|verify you reside in canada and can legally work|reside in canada.*legally work/i.test(text);
}

function isExplicitSponsorshipRequirementQuestion(text) {
  return /require(?:s|d)?\s+(?:visa\s+)?sponsor(?:ship)?|need(?:s|ed)?\s+(?:visa\s+)?sponsor(?:ship)?|will\s+you\s+(?:now\s+or\s+in\s+the\s+future\s+)?require\s+(?:visa\s+)?sponsor(?:ship)?|do\s+you\s+need\s+(?:visa\s+)?sponsor(?:ship)?/i.test(text);
}

function isExplicitWorkAuthorizationQuestion(text) {
  return /authorized to work|right to work|legally authorized|eligible to work|able to work|work authorization|legally eligible to work|legally able to work|can legally work/i.test(text);
}

function resolveWorkEligibility(field, profile) {
  const text = fieldText(field);
  const mainCountry = normalizeCountryName(profile.country || 'Canada');
  const questionCountry = detectQuestionCountry(text);
  const foreignCountryQuestion = questionCountry && mainCountry && questionCountry !== mainCountry;
  const opts = (field.options || []).map(o => typeof o === 'string' ? o : String(o?.label || o?.value || '')).filter(Boolean);
  const sponsorshipQuestion = isSponsorshipQuestion(text);
  const workAuthQuestion = isWorkAuthQuestion(text);

  if (!workAuthQuestion && !sponsorshipQuestion) return null;

  if (foreignCountryQuestion) {
    if (field.options && field.options.length) return pickYesNo(field, false);
    return { answer: 'No', source: 'rule' };
  }

  // Some labels contain both concepts, e.g. "legally authorized to work in Canada"
  // plus a sponsorship disclaimer. Prefer work authorization unless the question
  // explicitly asks whether sponsorship is required.
  const preferWorkAuth =
    workAuthQuestion &&
    (!sponsorshipQuestion || isExplicitWorkAuthorizationQuestion(text)) &&
    !isExplicitSponsorshipRequirementQuestion(text);

  if (preferWorkAuth) {
    if (opts.length && /citizen|permanent resident|open work permit|foreign national|authorization to work in canada/i.test(opts.join(' '))) {
      const positive =
        opts.find(o => /citizen|permanent resident/i.test(o)) ||
        opts.find(o => /open work permit/i.test(o)) ||
        opts.find(o => /authorized|eligible/i.test(o)) ||
        null;
      if (profile.workAuth !== false && positive) return { answer: positive, source: 'rule' };
      const negative = opts.find(o => /foreign national|seeking authorization|need sponsor|not authorized/i.test(o));
      if (negative) return { answer: negative, source: 'rule' };
    }
    if (field.options && field.options.length) return pickYesNo(field, profile.workAuth !== false);
    return { answer: profile.workAuth !== false ? 'Yes' : 'No', source: 'rule' };
  }

  if (sponsorshipQuestion) {
    if (field.options && field.options.length) return pickYesNo(field, profile.sponsorship === true);
    return { answer: profile.sponsorship === true ? 'Yes' : 'No', source: 'rule' };
  }

  return null;
}

// ─── Numeric experience detector ─────────────────────────────────────────────

function isNumericExperienceField(field) {
  const text = fieldText(field);
  const type = fieldControlType(field);

  if (isDescriptiveTextField(field)) return false;
  if (isCheckboxGroupField(field)) return false;
  if (['radio', 'checkbox', 'checkbox-group', 'checkbox_group', 'consent_checkbox_group'].includes(type)) return false;

  if (/salary|compensation|\bpay\b|ctc|wage|remuneration|expected.*gross|current.*gross|gross.*salary/i.test(text)) return false;

  const isYearOrDate =
    /\b(graduation|graduate|grad)\b/.test(text) ||
    (/\byear\b/.test(text) && !/\byears?\s+of\b/.test(text)) ||
    /\bstart\s*year\b|\bend\s*year\b|\bbirth\b|\bborn\b/.test(text);

  if (isYearOrDate) return false;

  return (
    field.type === 'number'             ||
    /\byears?\s+of\b/.test(text)        ||
    /\bhow\s+many\s+years\b/.test(text) ||
    /\bexperience\b/.test(text)         ||
    /\bhow\s+many\b/.test(text)         ||
    /\byrs?\b/.test(text)
  );
}

// ─── Experience estimator ─────────────────────────────────────────────────────

function estimateExperienceYears(field, profile) {
  const text       = fieldText(field);
  const profileYrs = parseInt(profile.experienceYears || '0', 10);
  const defaultExp = String(profile.experienceYears || '0');
  const profileSkills = (profile.skills || []).map(s => String(s).toLowerCase());
  const matchesSkill  = profileSkills.some(skill =>
    skill && text.includes(skill.split(/\s+/)[0].toLowerCase())
  );
  const clearlyNonProfileTool = /autocad|revit|civil\s*3d|solidworks|catia|creo|microstation|archicad|sage|quickbooks|jd\s*edwards|oracle\s*ebs|netsuite|workday|peoplesoft|epicor|xero|adp\s+workforce|kronos|ultiPro|paychex|dynamics\s*365(?!.*developer)|crm(?!.*developer)|erp\b|bookkeep/i.test(text);
  const broadItTool = /\baws\b|amazon\s+web|ec2|s3\b|iam\b|vpc\b|cloudformation|cloud\s+infra|cyber.?security|information\s+security|infosec|splunk|wazuh|siem|endpoint|hids|ossec|forensic|incident\s+response|\blinux\b|\bubuntu\b|\bcentos\b|\bbash\b|\bshell\s+script|windows\s+server|active\s+directory|\bad\s+ds\b|\bgpo\b|group\s+policy|nps\b|\bgit\b|version\s+control|source\s+control|it\s+support|helpdesk|help\s+desk|ticketing|sysadmin|system\s+admin|desktop\s+support|\bpython\b|\bansible\b|\bjava\b(?!\s*script)|\bsql\b|\bmysql\b|\bpostgres\b|\bmongodb\b|\bdatabase|\bdocker\b|\bvmware\b|\bhyper-?v\b|\bvirtuali|terraform|infrastructure.as.code|iac|spring\s+boot|rest\s+api|api\s+development|javascript|typescript|\bphp\b|\bhtml\b|\bcss\b|\bc\+\+\b|\bembedded\b|\barduino\b|network|ospf|bgp|routing|switching|vlan|firewall|vpn|802\.1x|wpa|wi-?fi|radius|nmap|wireshark|software|programming|development|technical|it\b/i.test(text);

  if (field.options && field.options.length) {
    let bestOpt = null;
    let bestMax = -Infinity;

    for (const opt of field.options) {
      const lower = opt.trim().toLowerCase();

      if (/less\s+than\s+1|under\s+1|0[\s–-]+1\s+year|fewer\s+than\s+1/.test(lower)) {
        if (profileYrs < 1) return opt;
        continue;
      }

      const moreThan = lower.match(/more\s+than\s+(\d+)|(\d+)\s*\+\s*years?/);
      if (moreThan) {
        const threshold = parseInt(moreThan[1] || moreThan[2], 10);
        if (profileYrs > threshold && threshold > bestMax) {
          bestMax = threshold;
          bestOpt = opt;
        }
        continue;
      }

      const nums = (opt.match(/\d+/g) || []).map(Number);
      if (!nums.length) continue;

      if (nums.length === 1) {
        if (nums[0] <= profileYrs) {
          if (nums[0] > bestMax) { bestMax = nums[0]; bestOpt = opt; }
        }
      } else {
        const lo = Math.min(...nums);
        const hi = Math.max(...nums);
        if (lo <= profileYrs && profileYrs <= hi) return opt;
        if (hi < profileYrs && hi > bestMax) { bestMax = hi; bestOpt = opt; }
      }
    }

    if (bestOpt) return bestOpt;
    if (field.options[0]) return field.options[0];
  }

  if (/salesforce|google\s+ads?|facebook\s+ads?|meta\s+ads?|ad\s+manager|hubspot|adobe\s+creative|illustrator|photoshop|indesign|tableau|power\s+bi|fcp|final\s+cut|premiere/.test(text))
    return '0';
  if (clearlyNonProfileTool)
    return '0';
  if (matchesSkill)
    return defaultExp;
  if (broadItTool)
    return defaultExp;

  // Use the saved profile experience as total academic/project/practical IT exposure
  // for broad IT questions, but keep unrelated niche business/design tools at 0.
  if (/\bit\b|technology|technical|programming|development|software|hardware/.test(text)) {
    return defaultExp;
  }

  return matchesSkill ? defaultExp : '0';
}

// ─── Direct profile resolver ──────────────────────────────────────────────────

function resolveProfileBoundField(field, profile) {
  const text = fieldText(field);
  const type = (field.type || field.tag || '').toLowerCase();
  const hasStructuredOptions = Array.isArray(field.options) && field.options.length > 0;

  if (type === 'select' || type === 'aria-radio') {
    const dialCodePick = pickDialCodeOptionAnswer(field, profile);
    if (dialCodePick) return dialCodePick;
  }

  if (/salary|compensation|ctc|wage|remuneration|\bpay\b|annual.*salary|salary.*annual|expected.*salary|salary.*expect|desired.*salary|salary.*desired|salary.*range|indicate.*salary/i.test(text))
    return { answer: profileValueOrSkip(profile.salary), source: 'profile' };

  if (/\byears?\s+of\s+experience\b|\bhow\s+many\s+years\b|\bexperience\s+years?\b|\byrs?\s+of\s+experience\b/i.test(text))
    return { answer: profileValueOrSkip(profile.experienceYears, '0'), source: 'profile' };

  if (type === 'email' || /\bemail\b/.test(text))
    return { answer: profileValueOrSkip(profile.email), source: 'profile' };

  if (type === 'tel' || /\b(phone|mobile|cell|telephone)\b/.test(text))
    return { answer: phoneDigitsOrSkip(profile.phone), source: 'profile' };

  if (/first[\s._-]?name|given[\s._-]?name|fname/.test(text))
    return { answer: profile.firstName || null, source: 'profile' };

  if (/last[\s._-]?name|family[\s._-]?name|surname|lname/.test(text))
    return { answer: profile.lastName || null, source: 'profile' };

  if (
    /\bfull[\s._-]?name\b|\byour\s+name\b/.test(text) &&
    !/first|last|given|family|surname/.test(text)
  ) {
    const fn   = (profile.firstName || '').trim();
    const ln   = (profile.lastName  || '').trim();
    const full = fn && ln && !fn.endsWith(ln) ? `${fn} ${ln}` : fn || ln;
    return { answer: full || null, source: 'profile' };
  }

  if (/legal\s+age|at\s+least\s+18|over\s+18|18\s+years?\s+of\s+age/.test(text))
    return null;

  if (/completed\s+this\s+application\s+yourself|did\s+you\s+complete\s+this\s+application|filled\s+out\s+this\s+application\s+yourself/.test(text))
    return null;

  if (/driver'?s\s+licen[cs]e|valid\s+licen[cs]e|hold\s+a\s+licen[cs]e/.test(text))
    return null;

  // ── FIX B-3: Additional comments textarea → "Not applicable" ───────────
  if (
    /additional.*comment|anything.*else.*add|other.*comment|comments?\s*(\(optional\))?$|is\s+there\s+anything\s+else|please\s+provide\s+any\s+(additional|other|further)/i.test(text) &&
    (type === 'textarea' || field.tag === 'textarea' || field.multiline)
  )
    return null;

  // ── FIX C: Travel percentage — pick lowest bucket ──────────────────────
  const optionsHavePercent =
    field.options && field.options.some(o => o.includes('%'));

  if (
    field.options && field.options.length &&
    (/\btravel\b/.test(text) || optionsHavePercent) &&
    (/\bpercent|%|how\s+much.*travel|willing.*travel|travel.*requir|travel.*expectation/i.test(text) || optionsHavePercent)
  ) {
    return null;
  }

  if (/means?\s+of\s+transportation|transportation\s+to\s+work|transport\s+to\s+work|how\s+will\s+you\s+get\s+to\s+work/i.test(text)) {
    return null;
  }

  if (/how\s+far.*commute|commute.*minutes?|travel\s+time|distance\s+to\s+work|minutes?\s+to\s+work/i.test(text)) {
    return null;
  }

  if (
    /shift\s*work|day\s*(?:and|&)\s*afternoon\s*shifts?|able\s+to\s+commute|commute\s+to\s+work|work\s+setting|schedule\s+flexib|flexible\s+schedule|shift\s+schedule|day\s+shift|afternoon\s+shift/i.test(text)
  ) {
    return null;
  }

  // ── City / location helpers ─────────────────────────────────────────────
  if (/do\s+you\s+live\s+in|are\s+you\s+(located|based)\s+in|currently\s+(live|reside|located)\s+in/.test(text)) {
    const profileCity = (profile.city || '').toLowerCase();
    const cityMatch   = profileCity && text.includes(profileCity);
    return { answer: cityMatch ? 'Yes' : 'No', source: 'rule' };
  }

  if (/\bcity\b/.test(text) && !/province|state|country|postal|zip/.test(text))
    return { answer: profileValueOrSkip(profile.city), source: 'profile' };

  if (/\b(province|state)\b/.test(text) && !/\bcountry\b/.test(text))
    return { answer: profileValueOrSkip(profile.province), source: 'profile' };

  if (/\b(country|pays)\b/.test(text))
    return { answer: profileValueOrSkip(profile.country, 'Canada'), source: 'profile' };

  if (field.options && field.options.length && (/\bcountry\b/.test(text) || isGenericFieldLabel(field))) {
    const countryPick = pickCountryOptionAnswer(field, profile);
    if (countryPick) return countryPick;
  }

  if (/\b(postal|zip)[\s_-]?(code)?\b/.test(text))
    return { answer: profileValueOrSkip(profile.postal), source: 'profile' };

  if (/\b(address\s*(line\s*)?1|address\s*1|street\s+address)\b/.test(text))
    return { answer: profileValueOrSkip(profile.address), source: 'profile' };

  if (/\b(address\s*(line\s*)?2|address\s*2|apartment|apt\.?|suite|unit)\b/.test(text))
    return null;

  if (/\b(referred\s+by(\s*\(|\b)|(an?\s+)?employee\s+referral|internal\s+referral|referred\s+by\s+(a\s+)?current\s+employee)\b/i.test(text)) {
    return null;
  }

  if (/\b(when\s+are\s+you\s+available\s+to\s+start|how\s+soon\s+can\s+you\s+join|start\s+date|joining\s+timeline|notice\s+period)\b/i.test(text)) {
    return null;
  }

  if (isAvailabilityWindowQuestion(text)) {
    return null;
  }

  if (/linkedin/.test(text))
    return { answer: profileValueOrSkip(profile.linkedin), source: 'profile' };

  if (/\b(field|area)\s+of\s+study\b|\bmajor\b|\bspeciali[sz]ation\b/.test(text)) {
    const fieldOfStudy = inferFieldOfStudy(profile);
    return { answer: profileValueOrSkip(fieldOfStudy), source: 'profile' };
  }

  if (/\bgraduation\s+year\b|\bgrad\s+year\b|\byear\s+of\s+graduation\b/.test(text)) {
    const gradYear = inferGradYear(profile);
    return { answer: profileValueOrSkip(gradYear), source: 'profile' };
  }

  if (/\bgpa\b|\bgrade point average\b/.test(text))
    return null;

  if (/\bmost\s+recent\s+school\b|\beducation\s+institution\b|\bschool\b/.test(text) && !/\b(field|area|graduation|degree)\b/.test(text)) {
    const schoolName = inferSchoolName(profile);
    return { answer: profileValueOrSkip(schoolName, profile.education || '__SKIP__'), source: 'profile' };
  }

  if (/\bmost\s+recent\s+job\s+title\b|\bcurrent\s+job\s+title\b/.test(text))
    return { answer: profileValueOrSkip(inferShortHeadline(profile), profile.headline || '__SKIP__'), source: 'profile' };

  if (/\bmost\s+recent\s+company\b|\bcurrent\s+company\b|\bemployer\b/.test(text))
    return null;

  if (/\bstart\s+year\b/.test(text))
    return null;

  if (/\bend\s+year\b/.test(text))
    return null;

  if (
    type === 'url' ||
    /portfolio|personal[\s_-]?site|personal[\s_-]?website|website[\s_-]?url|github|gitlab/.test(text)
  )
    return { answer: profileValueOrSkip(profile.portfolio), source: 'profile' };

  // FIX v3.3: Headline rule now excludes salary/compensation/expectations/
  // indicate/annual/range keywords so labels like "salary expectations for
  // this position" can never match here after the early-exit above.
  if (
    /\b(headline|current[\s._-]?title|job[\s._-]?title|position|role)\b/.test(text) &&
    !isChoiceField(field) &&
    !/salary|compensation|expectations|annual|indicate|range|\bpay\b/i.test(text) &&
    !isAvailabilityOrStartQuestion(text) &&
    !isNumericExperienceField(field) &&
    !/refer|referral|indicate the name|employee.*refer|refer.*employee|name of the|on.?site|onsite/.test(text) &&
    !(field.options && field.options.length &&
      field.options.every(o => /^(yes|no|true|false|oui|non)$/i.test(o.trim())))
  )
    return { answer: profile.headline || null, source: 'profile' };

  if (
    /\b(summary|about[\s_-]?(me|you|yourself)|bio|professional[\s_-]?summary|tell\s+us\s+about\s+(yourself|you))\b/.test(text) &&
    !/about\s+a\s+time|specific\s+example|give\s+us\s+an?\s+example|how\s+did\s+you|what\s+does|what'?s\s+one\s+thing/i.test(text) &&
    !isAvailabilityOrStartQuestion(text) &&
    !isNumericExperienceField(field)
  )
    return { answer: profile.summary || null, source: 'profile' };

  if (
    /\b(education|university|college|school|diploma|qualification)\b/.test(text) &&
    !/highest|level|degree\s+level/.test(text) &&
    !(field.options && field.options.length)
  )
    return { answer: profile.education || null, source: 'profile' };

  return null;
}

function resolveHelpfulDefaultField(field, profile) {
  const text = fieldText(field);
  const type = (field.type || field.tag || '').toLowerCase();
  const descriptiveText = isDescriptiveTextField(field);
  const choiceField = isChoiceField(field);

  if (isCheckboxGroupField(field)) {
    if (/location|located near one of our offices|which offices|office locations?|interested in.*locations?|geographically located near/i.test(text)) {
      const officeLocationPick = pickOfficeLocationCheckboxAnswers(field, profile);
      if (officeLocationPick) return officeLocationPick;
    }

    if (/preferred\s+employment|employment\s+type|type\s+of\s+employment|full[-\s]?time|part[-\s]?time|contract/.test(text)) {
      return pickCheckboxGroupAnswers(
        field,
        [/\bfull[-\s]?time\b/i],
        [/\bpermanent\b/i, /\bregular\b/i, /\bpart[-\s]?time\b/i, /\bcontract\b/i]
      );
    }

    if (/availability|available.*apply|days?\s+available|select\s+all.*apply.*availability/.test(text)) {
      return pickAvailabilityCheckboxAnswers(field);
    }
  }

  if (choiceField && /worked\s+(for|with|here|at)\s+(us|this\s+company|infosys|accenture|amazon|google|microsoft)|ever\s+(work(?:ed)?|employ(?:ed)?)\s+(for|at|by)\s+us|prev(?:ious)?.*employ|former.*employ|prior.*position.*this.*company|previously\s+work(?:ed)?\s+(here|for\s+us)|have\s+you\s+ever\s+work(?:ed|been employed)?|been\s+employed\s+by\s+(infosys|us|this\s+company)|employed\s+by\s+us|rehire|re-?hire|\bworked\.?here\b|\bprevious.*employee\b|\bformer.*employee\b/i.test(text))
    return pickYesNo(field, false);

  if (choiceField && /\bdegree\b|\beducation\s+level\b|\bhighest\s+level\s+of\s+education\b/.test(text)) {
    const educationMatch = pickEducationLevelAnswer(field, profile);
    if (educationMatch) return educationMatch;
  }

  if (choiceField) {
    const opts = optionList(field);

    if (opts.some(o => /\bindeed\b/i.test(o)) && /\b(source|hear about|how did you hear)\b/i.test(text)) {
      const indeed = opts.find(o => /\bindeed\b/i.test(o));
      if (indeed) return { answer: indeed, source: 'rule' };
    }

    if (/travel|open to travel|willing to travel/i.test(text)) {
      return pickYesNo(field, true);
    }

    if (
      /(understand|accept|acknowledge|confirm)/i.test(text) &&
      /(equal employment opportunity|eeo|diversity and inclusion|non-?discrimination|harassment)/i.test(text)
    ) {
      return pickYesNo(field, true);
    }

    if (
      opts.some(o => /\bbachelor/i.test(o)) &&
      opts.some(o => /\b(master|associate|certificate|diploma|no final certificate)\b/i.test(o))
    ) {
      const educationMatch = pickEducationLevelAnswer(field, profile);
      if (educationMatch) return educationMatch;
    }
  }

  if (choiceField && /criminal.*record|criminal.*conviction|criminal.*charge|convicted|been\s+arrested|pending\s+charge|pardon.*granted|pardon.*not\s+been\s+granted|felony|misdemeanor|background\s+check.*criminal|criminal\s+background\s+check|reference\s+check|education\s+verification|\boffence\b|\boffense\b/i.test(text))
    return pickYesNo(field, false);

  if (choiceField && /legal\s+age|at\s+least\s+18|over\s+18|18\s+years?\s+of\s+age/.test(text))
    return pickYesNo(field, true);

  if (choiceField && /completed\s+this\s+application\s+yourself|did\s+you\s+complete\s+this\s+application|filled\s+out\s+this\s+application\s+yourself/.test(text))
    return pickYesNo(field, true);

  if (choiceField && /driver'?s\s+licen[cs]e|valid\s+licen[cs]e|hold\s+a\s+licen[cs]e/.test(text))
    return pickYesNo(field, true);

  if (descriptiveText) return null;

  if (
    /additional.*comment|anything.*else.*add|other.*comment|comments?\s*(\(optional\))?$|is\s+there\s+anything\s+else|please\s+provide\s+any\s+(additional|other|further)/i.test(text) &&
    (type === 'textarea' || field.tag === 'textarea' || field.multiline)
  )
    return { answer: 'Not applicable.', source: 'rule' };

  if (field.options && field.options.length && /salary|compensation|ctc|wage|remuneration|\bpay\b|salary.*range|indicate.*salary/i.test(text)) {
    return pickSalaryRangeAnswer(field, profile);
  }

  if (field.options && field.options.length && isNumericExperienceField(field)) {
    return pickExperienceOptionAnswer(field, profile);
  }

  const optionsHavePercent = field.options && field.options.some(o => o.includes('%'));
  if (
    field.options && field.options.length &&
    (/\btravel\b/.test(text) || optionsHavePercent) &&
    (/\bpercent|%|how\s+much.*travel|willing.*travel|travel.*requir|travel.*expectation/i.test(text) || optionsHavePercent)
  ) {
    const lowest =
      field.options.find(o => /\b0\s*[-–%]|none|no\s+travel|\bnot\s+requir/i.test(o)) ||
      field.options.find(o => /\b0\b/.test(o)) ||
      field.options[0];
    return { answer: lowest, source: 'rule' };
  }

  if (/means?\s+of\s+transportation|transportation\s+to\s+work|transport\s+to\s+work|how\s+will\s+you\s+get\s+to\s+work/i.test(text))
    return pickTransportationAnswer(field);

  if (/pre-?employment testing|mandatory pre-?employment testing|willing and able to complete.*testing|participate in the mandatory pre-?employment testing|comfortable proceeding with this requirement|provide the necessary information to complete this step/i.test(text)) {
    if (field.options && field.options.length) return pickYesNo(field, true);
    return { answer: 'Yes', source: 'rule' };
  }

  if (/how\s+far.*commute|commute.*minutes?|travel\s+time|distance\s+to\s+work|minutes?\s+to\s+work/i.test(text))
    return pickCommuteNumericAnswer(field);

  if (/shift\s*work|day\s*(?:and|&)\s*afternoon\s*shifts?|able\s+to\s+commute|commute\s+to\s+work|work\s+setting|schedule\s+flexib|flexible\s+schedule|shift\s+schedule|day\s+shift|afternoon\s+shift|work\s+from\s+the\s+office|commute\s+reliably|after-hours|weekend|holiday\s+support|business\s+continuity|available\s+for\s+after-hours\s+support/i.test(text)) {
    if (field.options && field.options.length) return pickYesNo(field, true);
    return { answer: 'Yes', source: 'rule' };
  }

  if (/\b(referred\s+by(\s*\(|\b)|(an?\s+)?employee\s+referral|internal\s+referral|referred\s+by\s+(a\s+)?current\s+employee)\b/i.test(text)) {
    if (field.options && field.options.length) return pickYesNo(field, false);
    return { answer: 'No', source: 'rule' };
  }

  if (isAvailabilityWindowQuestion(text)) {
    if (field.options && field.options.length) return pickYesNo(field, true);
    return { answer: 'Yes', source: 'rule' };
  }

  if (/\b(when\s+are\s+you\s+available\s+to\s+start|how\s+soon\s+can\s+you\s+join|start\s+date|joining\s+timeline|notice\s+period)\b/i.test(text))
    return pickAvailabilityAnswer(field);

  return null;
}

function resolveDirectField(field, profile) {
  return resolveProfileBoundField(field, profile) || resolveHelpfulDefaultField(field, profile);
}

// ─── Answer cleaner ───────────────────────────────────────────────────────────

function cleanAnswer(answer, field, profile) {
  const raw       = (answer || '').trim();
  const labelText = [field.label || '', field.name || '', field.placeholder || ''].join(' ');
  const defaultExp = String(profile?.experienceYears || '0');

  if (!raw)
    return isNumericExperienceField(field) ? defaultExp : '__SKIP__';

  if (isNumericExperienceField(field)) {
    if (/__skip__/i.test(raw)) return defaultExp;
    const num = raw.match(/-?\d+/);
    if (num) return num[0];
    if (/zero|none|no experience|not familiar|do not have|don.?t have|n\/a|na/i.test(raw)) return '0';
    return defaultExp;
  }

  if (/^__skip__$/i.test(raw)) return '__SKIP__';

  const stripped = raw
    .replace(/^(based on (your |the |this )?(resume|profile|information|background)[,.]?\s*)/i, '')
    .replace(/^(as (an? )?(applicant|candidate|job seeker)[,.]?\s*)/i, '')
    .replace(/^(i would (say|suggest|recommend)[,.]?\s*)/i, '')
    .replace(/^(the answer (is|would be)[,.]?\s*)/i, '')
    .replace(/^(according to (the |your )?(resume|profile)[,.]?\s*)/i, '')
    .replace(/^(certainly[!,.]?\s*)/i, '')
    .replace(/^(sure[!,.]?\s*here('s| is)[,.]?\s*)/i, '')
    .replace(/^(of course[!,.]?\s*)/i, '')
    .trim();

  if (/why|reason|applying|motivation|interest/i.test(labelText))
    return stripped.slice(0, 450);

  if (stripped.length > 450) {
    const truncated  = stripped.slice(0, 450);
    const lastPeriod = Math.max(
      truncated.lastIndexOf('. '),
      truncated.lastIndexOf('! '),
      truncated.lastIndexOf('? ')
    );
    return lastPeriod > 100 ? truncated.slice(0, lastPeriod + 1) : truncated;
  }

  return stripped;
}

if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = {
    INDEED_RULE_PATTERNS: [],
    fieldText,
    fieldControlType,
    getAnswerMode,
    resolveHardRules,
    resolveProfileBoundField,
    resolveHelpfulDefaultField,
    resolveDirectField,
    isNumericExperienceField,
    isDescriptiveTextField,
    isCheckboxGroupField,
    estimateExperienceYears,
    pickYesNo,
    cleanAnswer,
  };
}

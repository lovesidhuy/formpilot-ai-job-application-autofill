// QuickFill AI – rules.js v2.3
// v2.3 fixes (from live-data analysis, April 2026):
// B18 — Pre-employment / medical / drug+alcohol combined testing → Yes
// B19 — Office availability regex extended: "work from the office", "two days", "three days a week", "onsite"
// B20 — Familiarity scale rule: never pick "Never heard of it", always pick ≥ second option
// B22 — Hallucinated niche skills: handled via system prompt (see buildSystemPrompt notes at bottom)
// B23 — "Anything else?" textarea echo: handled via system prompt
// B24 — Options echoed as answer: handled via system prompt
// B25 — City-from-question trap: "Do you live in [City]?" → compare to profile, return No if mismatch
// B26 — Compound basic-skills question ("PHP, HTML, CSS, JS, SQL") → Yes if profile has any
// B27 — "Would you say/consider yourself" indirect Yes/No → handled via system prompt
// FIX  — Remove related-to-anyone from INDEED_RULE_PATTERNS so No rule fires instead of Skip
// FIX  — Contract-to-fulltime → Yes rule added
// FIX  — Driver's licence now answers Yes/No for radio fields instead of always Skip
// FIX  — Extend sponsorship regex: "visa support", "immigration support"
// FIX  — Extend work-auth regex: "eligible to work for any employer"
// FIX  — JS/TS experience cap raised from 1 → 3 years
// FIX  — "Less than 1 year" / "0–1 year" range options now handled in estimateExperienceYears
// FIX  — Language proficiency (non-English) → "No" / "None" rule added

'use strict';

// ─── INDEED_RULE_PATTERNS ─────────────────────────────────────────────────────
// NOTE: "related-to-anyone" removed — the resolveRuleField rule now answers "No"
//       directly instead of letting isIndeedRuleHandled() skip the field.

const INDEED_RULE_PATTERNS = [
  /commute|reliably commute|relocat|willing to travel|commutable distance/,
  /sponsorship|visa sponsor|require sponsor|work permit|visa support|immigration support/,
  /eligible|authorized to work|legal right|legally authorized|work in canada|work in the us|eligible to work for any employer/,
  /speak english|english proficiency|proficient in english|fluent in english|english language|do you speak/,
  /background check|criminal record check|screening|consent to a check/,
  /drug test|substance test/,
  /pre.?employment\s+test|mandatory\s+test|medical\s+test|drug.*alcohol|health.*safety.*test/,
  /\bgender\b|\bpronoun/,
  /indigenous|aboriginal|first nation|m[eé]tis|inuit|status indian/,
  /disability|disabled|handicap|differently abled/,
  /visible minority|racial|racialized|race|ethnicity|ethnic origin/,
  /veteran|military service|armed forces|protected veteran/,
  /lgbtq|sexual orientation|sexual identity/,
  /convicted|felony|criminal charge|criminal offence/,
  /18 or above|over 18|at least 18|minimum age|18 years of age|age 18|be 18/,
  /ever worked for|previously worked for|have you worked at|ever been employed by|formerly employed by|worked at any of|previously employed by|ever employed by|work for any of|ever been an employee at|have you ever been.*employee|been an employee at/,
  ///related to anyone|related to any(one)? that works|family member.*work|know anyone that works|connected to anyone at this company|relationship to.*employee/,
  /available to work|work evenings|work weekends|work overtime|flexible schedule|work on weekends|work.*office|from the office|in office|in the office|office.*days|days.*per week|days a week|hybrid|3x per week|two days|three days|three times per week|tuesdays|wednesdays|thursdays|\bonsite\b|full.?time onsite|work.*on.?site/,
  /canadian citizen|permanent resident|pr holder|citizen of canada/,
  /currently enrolled|are you a student/,
  /are you at least|are you over/,
  /how many years|years of experience|amount of experience|years have you/,
  /contract.*full.?time|full.?time.*permanent|transition.*permanent/,
  /french|spanish|mandarin|cantonese|punjabi|hindi|arabic|portuguese|german|italian|korean|japanese|bilingual|multilingual/,
  /how familiar|familiarity with|proficiency with|experience level with/,
  /do you live in|are you located in|are you based in|currently live|currently reside/,
];

// ─── Safety patterns ──────────────────────────────────────────────────────────

const SAFETY_PATTERNS = [
  /work\s+auth|legally\s+auth|authorized\s+to\s+work|eligible\s+to\s+work|right\s+to\s+work|legal\s+right\s+to\s+work|eligible\s+to\s+work\s+for\s+any\s+employer/,
  /require\s+sponsor|need\s+sponsor|visa\s+sponsor|sponsorship\s+required|require\s+immigration\s+sponsor|visa\s+support|immigration\s+support/,
  /will\s+you.*require.*sponsorship|sponsorship.*now\s+or\s+in\s+the\s+future/,
  /criminal\s+(record|check|history|background)|felony|convicted|arrest/,
  /background\s+(check|screen|investigation)/,
  /work\s+permit|immigration\s+status|visa\s+status|citizenship\s+status/,
  /drug\s+test|substance\s+test|pre.?employment\s+test|mandatory\s+test|medical\s+test|drug.*alcohol|health.*safety.*test/,
  /lgbtq|sexual\s+orientation|sexual\s+identity/,
  /indigenous|aboriginal|first\s+nation|m[eé]tis|inuit/,
  /visible\s+minority|racial|racialized/,
];

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

function pickYesNo(field, wantYes) {
  const target = wantYes ? 'yes' : 'no';
  const anti   = wantYes ? 'no'  : 'yes';
  const opts   = field.options || [];

  if (opts.length) {
    const exact = opts.find(o => o.trim().toLowerCase() === target);
    if (exact) return { answer: exact, source: 'rule' };

    const starts = opts.find(o => o.trim().toLowerCase().startsWith(target));
    if (starts) return { answer: starts, source: 'rule' };

    const contains = opts.find(o => {
      const l = o.trim().toLowerCase();
      return l.includes(target) && !l.startsWith(anti);
    });
    if (contains) return { answer: contains, source: 'rule' };
  }

  return { answer: wantYes ? 'Yes' : 'No', source: 'rule' };
}

function matchYesOption(field, wantYes) {
  return pickYesNo(field, wantYes).answer;
}

// ─── Safety gate ──────────────────────────────────────────────────────────────

function isSafetyField(field) {
  const text = fieldText(field);
  return SAFETY_PATTERNS.some(p => p.test(text));
}

// ─── Numeric experience detector ─────────────────────────────────────────────

function isNumericExperienceField(field) {
  const text = fieldText(field);

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

  // Option-list range picker — runs first
  if (field.options && field.options.length) {
    let bestOpt = null;
    let bestMax = -Infinity;

    for (const opt of field.options) {
      const lower = opt.trim().toLowerCase();

      // Handle "Less than 1 year" / "0–1 year" / "Under 1 year" special cases
      if (/less\s+than\s+1|under\s+1|0[\s–-]+1\s+year|fewer\s+than\s+1/.test(lower)) {
        if (profileYrs < 1) return opt;
        // Don't pick this for anyone with ≥1 year
        continue;
      }

      // Handle "More than N years" / "N+ years" as a ceiling bucket
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
          if (nums[0] > bestMax) {
            bestMax = nums[0];
            bestOpt = opt;
          }
        }
      } else {
        const lo = Math.min(...nums);
        const hi = Math.max(...nums);
        if (lo <= profileYrs && profileYrs <= hi) return opt;
        if (hi < profileYrs && hi > bestMax) {
          bestMax = hi;
          bestOpt = opt;
        }
      }
    }

    if (bestOpt) return bestOpt;
    if (field.options[0]) return field.options[0];
  }

  // Plain numeric — skill-aware mapping
  if (/salesforce|google\s+ads?|facebook\s+ads?|meta\s+ads?|ad\s+manager|hubspot|adobe\s+creative|illustrator|photoshop|indesign|tableau|power\s+bi|fcp|final\s+cut|premiere/.test(text))
    return '0';

  if (/network|ospf|bgp|routing|switching|vlan|firewall|vpn|802\.1x|wpa|wi-?fi|radius|nmap|wireshark|rf\s+anal/.test(text))
    return String(Math.min(profileYrs, 4));

  if (/\baws\b|amazon\s+web|ec2|s3\b|iam\b|vpc\b|cloudformation|cloud\s+infra/.test(text))
    return String(Math.min(profileYrs, 3));

  if (/cyber.?security|information\s+security|infosec|splunk|wazuh|siem|endpoint|hids|ossec|forensic|incident\s+response/.test(text))
    return String(Math.min(profileYrs, 3));

  if (/\blinux\b|\bubuntu\b|\bcentos\b|\bbash\b|\bshell\s+script/.test(text))
    return String(Math.min(profileYrs, 3));

  if (/windows\s+server|active\s+directory|\bad\s+ds\b|\bgpo\b|group\s+policy|nps\b/.test(text))
    return String(Math.min(profileYrs, 3));

  if (/\bgit\b|version\s+control|source\s+control/.test(text))
    return String(Math.min(profileYrs, 3));

  if (/it\s+support|helpdesk|help\s+desk|ticketing|sysadmin|system\s+admin|desktop\s+support/.test(text))
    return String(Math.min(profileYrs, 3));

  if (/\bpython\b|\bansible\b/.test(text))
    return String(Math.min(profileYrs, 2));

  if (/\bjava\b(?!\s*script)/.test(text))
    return String(Math.min(profileYrs, 2));

  if (/\bsql\b|\bmysql\b|\bpostgres\b|\bmongodb\b|\bdatabase/.test(text))
    return String(Math.min(profileYrs, 2));

  if (/\bdocker\b|\bvmware\b|\bhyper-?v\b|\bvirtuali/.test(text))
    return String(Math.min(profileYrs, 2));

  if (/terraform|cloudformation|infrastructure.as.code|iac/.test(text))
    return String(Math.min(profileYrs, 1));

  if (/spring\s+boot|rest\s+api|api\s+development/.test(text))
    return String(Math.min(profileYrs, 1));

  // FIX: JS/TS cap raised from 1 → 3 (was undercounting significantly)
  if (/javascript|typescript|\bphp\b|\bhtml\b|\bcss\b/.test(text))
    return String(Math.min(profileYrs, 3));

  if (/\bc\+\+\b|\bembedded\b|\barduino\b/.test(text))
    return String(Math.min(profileYrs, 1));

  if (/\bit\b|technology|technical|programming|development|software|hardware/.test(text))
    return defaultExp;

  return defaultExp;
}

// ─── Direct profile resolver ──────────────────────────────────────────────────

function resolveDirectField(field, profile) {
  const text = fieldText(field);
  const type = (field.type || field.tag || '').toLowerCase();

  if (type === 'email' || /\bemail\b/.test(text))
    return { answer: profile.email || null, source: 'profile' };

  if (type === 'tel' || /\b(phone|mobile|cell|telephone)\b/.test(text))
    return { answer: profile.phone || null, source: 'profile' };

  if (/first[\s._-]?name|given[\s._-]?name|fname/.test(text))
    return { answer: profile.firstName || null, source: 'profile' };

  if (/last[\s._-]?name|family[\s._-]?name|surname|lname/.test(text))
    return { answer: profile.lastName || null, source: 'profile' };

  if (
    /\bfull[\s._-]?name\b|\byour\s+name\b/.test(text) &&
    !/first|last|given|family|surname/.test(text)
  ) {
    const full = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
    return { answer: full || null, source: 'profile' };
  }

  // FIX B25 — City-from-question trap
  // "Do you live in Edmonton?" must return Yes/No, NOT the city name.
  // This must run BEFORE the plain /\bcity\b/ rule below.
  if (/do\s+you\s+live\s+in|are\s+you\s+(located|based)\s+in|currently\s+(live|reside|located)\s+in/.test(text)) {
    const profileCity = (profile.city || '').toLowerCase();
    const cityMatch   = profileCity && text.includes(profileCity);
    return { answer: cityMatch ? 'Yes' : 'No', source: 'rule' };
  }

  if (/\bcity\b/.test(text) && !/province|state|country|postal|zip/.test(text))
    return { answer: profile.city || null, source: 'profile' };

  if (/\b(province|state)\b/.test(text) && !/\bcountry\b/.test(text))
    return { answer: profile.province || null, source: 'profile' };

  if (/\b(country|pays)\b/.test(text))
    return { answer: profile.country || 'Canada', source: 'profile' };

  if (/\b(postal|zip)[\s_-]?(code)?\b/.test(text))
    return { answer: profile.postal || '__SKIP__', source: 'profile' };

  if (/linkedin/.test(text))
    return { answer: profile.linkedin || '__SKIP__', source: 'profile' };

  if (
    type === 'url' ||
    /portfolio|personal[\s_-]?site|personal[\s_-]?website|website[\s_-]?url|github|gitlab/.test(text)
  )
    return { answer: profile.portfolio || '__SKIP__', source: 'profile' };

  if (/\b(headline|current[\s_-]?title|job[\s_-]?title|position|role)\b/.test(text))
    return { answer: profile.headline || null, source: 'profile' };

  if (/\b(summary|about[\s_-]?me|bio|professional[\s_-]?summary)\b/.test(text))
    return { answer: profile.summary || null, source: 'profile' };

  if (
    /\b(education|university|college|school|diploma|qualification)\b/.test(text) &&
    !/highest|level|degree\s+level/.test(text) &&
    !(field.options && field.options.length)
  )
    return { answer: profile.education || null, source: 'profile' };

  return null;
}

// ─── Rule-based resolver ──────────────────────────────────────────────────────

function resolveRuleField(field, profile) {
  const text = fieldText(field);

  if (isNumericExperienceField(field))
    return { answer: estimateExperienceYears(field, profile), source: 'rule' };

  if (/salary|compensation|pay\s+expectation|desired\s+pay|expected\s+pay|expected\s+salary/.test(text)) {
    if (!profile.salary) return null;
    const answer = field.type === 'number'
      ? (profile.salary.replace(/[^\d.]/g, '') || profile.salary)
      : profile.salary;
    return { answer, source: 'profile' };
  }

  // FIX B18 — Pre-employment / medical / drug+alcohol combined consent → Yes
  // Must run BEFORE individual drug-test rule so the broader pattern catches compound questions.
  if (/pre.?employment\s+test|mandatory\s+(pre.?employment\s+)?test|medical\s+test|drug.*alcohol.*test|health.*safety.*test|health.*medical.*test/.test(text))
    return pickYesNo(field, true);

  if (/work\s+auth|legally\s+auth|authorized\s+to\s+work|eligible\s+to\s+work|right\s+to\s+work|legal\s+right|eligible\s+to\s+work\s+for\s+any\s+employer/.test(text))
    return pickYesNo(field, profile.workAuth !== false);

  // FIX — Extend sponsorship to include "visa support" / "immigration support"
  if (/require\s+sponsor|need\s+sponsor|visa\s+sponsor|sponsorship\s+required|will\s+you.*require.*sponsor|sponsorship.*future|visa\s+support|immigration\s+support/.test(text))
    return pickYesNo(field, profile.sponsorship === true);

  if (/background\s+(check|screen)|criminal\s+(record|check|background)|consent\s+to\s+(background|check)/.test(text))
    return pickYesNo(field, true);

  if (/drug\s+test|substance\s+test/.test(text))
    return pickYesNo(field, true);

  if (/convicted|felony|criminal\s+charge|criminal\s+offence/.test(text))
    return pickYesNo(field, false);

  if (/ever\s+worked\s+for|previously\s+worked\s+for|have\s+you\s+worked\s+at|ever\s+been\s+employed\s+by|formerly\s+employed\s+by|worked\s+at\s+any\s+of|previously\s+employed\s+by|ever\s+employed\s+by|work\s+for\s+any\s+of/.test(text))
    return pickYesNo(field, false);

  if (/ever\s+been\s+an\s+employee|been\s+an\s+employee\s+at|have\s+you\s+ever\s+been.*employee/.test(text)) {
    const opts = field.options || [];
    const never = opts.find(o => /never\s+worked|never\s+been|i\s+have\s+never/i.test(o));
    if (never) return { answer: never, source: 'rule' };
    return pickYesNo(field, false);
  }

  // FIX — related-to-anyone now fires a No answer (was previously only in INDEED_RULE_PATTERNS = skip)
  if (/related\s+to\s+anyone|related\s+to\s+any(one)?\s+that\s+works|family\s+member.*work|know\s+anyone\s+that\s+works|connected\s+to\s+anyone\s+at\s+this\s+company|relationship\s+to.*employee/.test(text))
    return pickYesNo(field, false);

  if (/18\s+years?\s+of\s+age|at\s+least\s+18|over\s+18|18\s+or\s+above|minimum\s+age|age\s+18|be\s+18|are\s+you\s+at\s+least|are\s+you\s+over/.test(text))
    return pickYesNo(field, true);

  if (/canadian\s+citizen|permanent\s+resident|pr\s+holder|citizen\s+of\s+canada/.test(text))
    return pickYesNo(field, profile.workAuth !== false);

  if (/commute|reliably\s+commute|relocat|willing\s+to\s+travel|commutable\s+distance/.test(text))
    return pickYesNo(field, profile.preferences?.relocate !== false);

  // FIX B19 — Office availability regex extended to cover all observed failure patterns
  if (/available\s+to\s+work|work\s+evenings|work\s+weekends|work\s+overtime|flexible\s+schedule|work\s+on\s+weekends|work.*office|from\s+the\s+office|in\s+office|in\s+the\s+office|office.*days|days.*per\s+week|days\s+a\s+week|hybrid|3x\s+per\s+week|two\s+days|three\s+days|three\s+times\s+per\s+week|tuesdays|wednesdays|thursdays/.test(text))
    return pickYesNo(field, true);

  if (/\bonsite\b|full.?time\s+onsite|work.*on.?site|able\s+to\s+work.*onsite/.test(text)) {
    const opts = field.options || [];
    const local = opts.find(o => /locally\s+based|local(ly)?|no\s+reloc/i.test(o));
    if (local) return { answer: local, source: 'rule' };
    const hybrid = opts.find(o => /hybrid|remote/i.test(o));
    if (hybrid) return { answer: hybrid, source: 'rule' };
    return pickYesNo(field, true);
  }

  if (/remote\s+work|work\s+remotely|open\s+to\s+remote|prefer\s+remote/.test(text))
    return pickYesNo(field, profile.preferences?.remote !== false);

  if (/speak\s+english|english\s+proficiency|proficient\s+in\s+english|fluent\s+in\s+english|english\s+language|do\s+you\s+speak/.test(text)) {
    if (field.options && field.options.length) return pickYesNo(field, true);
    return null;
  }

  // FIX — Non-English language proficiency: French/Mandarin/Spanish/etc. → No / None
  if (/\bfrench\b|\bspanish\b|\bmandarin\b|\bcantonese\b|\bpunjabi\b|\bhindi\b|\barabic\b|\bportuguese\b|\bgerman\b|\bitalian\b|\bkorean\b|\bjapanese\b|\bbilingual\b|\bmultilingual\b/.test(text)) {
    // Don't catch English-language proficiency questions handled above
    if (/english/.test(text)) return null; // let the English rule handle it
    // Treat as a Yes/No proficiency question
    if (field.options && field.options.length) {
      // Look for "None", "No", "Not applicable", "N/A" options
      const noneOpt = field.options.find(o => /\bnone\b|^no$|not\s+applicable|n\/a|^0$/i.test(o.trim()));
      if (noneOpt) return { answer: noneOpt, source: 'rule' };
      return pickYesNo(field, false);
    }
    // For Yes/No radios
    return pickYesNo(field, false);
  }

  if (/currently\s+enrolled|are\s+you\s+a\s+student/.test(text))
    return pickYesNo(field, false);

  if (/highest.*education|education.*level|highest.*degree|degree.*level/.test(text)) {
    if (field.options && field.options.length) {
      const bachelor = field.options.find(o => /bachelor|b\.?sc|b\.?tech|undergraduate|4.year/i.test(o));
      if (bachelor) return { answer: bachelor, source: 'rule' };
    }
    return { answer: "Bachelor's Degree", source: 'rule' };
  }

  // FIX — Contract-to-fulltime / contract-to-permanent → Yes
  if (/contract.*full.?time|contract.*permanent|transition.*permanent|convert.*full.?time|full.?time.*permanent\s+position|go\s+from.*contract.*full.?time|contract\s+to\s+full.?time/.test(text))
    return pickYesNo(field, true);

  // FIX B20 — Familiarity / proficiency scale: never pick "Never heard of it"
  // Always pick at least the second-lowest option (e.g. "Studied/Read about it").
  if (/how\s+familiar|familiarity\s+with|proficiency\s+with|experience\s+level\s+with|how\s+would\s+you\s+rate\s+your/.test(text)) {
    const opts = field.options || [];
    if (opts.length) {
      // Prefer a "studied / read about / some knowledge / familiar" option
      const studied = opts.find(o => /studied|read\s+about|some\s+knowledge|somewhat\s+familiar|basic\s+knowledge|aware\s+of/i.test(o));
      if (studied) return { answer: studied, source: 'rule' };
      // Avoid index 0 if it looks like "Never heard of it" — pick index 1 as safe fallback
      if (opts.length >= 2) {
        const first = opts[0].toLowerCase();
        if (/never\s+heard|no\s+knowledge|no\s+experience|not\s+familiar/i.test(first)) {
          return { answer: opts[1], source: 'rule' };
        }
      }
      // Otherwise pick the first option (already filtered above)
      return { answer: opts[0], source: 'rule' };
    }
    return null; // no options — let AI handle it with system prompt guidance
  }

  // FIX B26 — Compound basic-skill Yes/No questions
  // "Are you proficient in PHP, HTML, CSS, JavaScript, and SQL basics?"
  // Answer Yes if profile.skills contains any of the listed common web/IT skills.
  if (/proficient in|familiar with|experience with|knowledge of/.test(text)) {
    const commonSkills = /php|html|css|javascript|typescript|sql|python|java|git|linux|bash|node|react|docker|rest\s+api/i;
    if (commonSkills.test(text)) {
      const profileSkills = (profile.skills || []).join(' ').toLowerCase();
      const hasSkill = commonSkills.source.split('|').some(skill => profileSkills.includes(skill));
      if (hasSkill) return pickYesNo(field, true);
      // Even without profile match, these are basic IT concepts — still say Yes
      return pickYesNo(field, true);
    }
  }

  if (/veteran|military\s+service|armed\s+forces|protected\s+veteran/.test(text)) {
    if (field.options && field.options.length) {
      const no = field.options.find(o => /not\s+a\s+veteran|i\s+am\s+not|\bno\b/i.test(o));
      if (no) return { answer: no, source: 'rule' };
      const decline = field.options.find(o => /prefer\s+not|decline|not\s+disclose/i.test(o));
      if (decline) return { answer: decline, source: 'rule' };
    }
    return { answer: '__SKIP__', source: 'rule' };
  }

  if (/disability|disabled|handicap|differently\s+abled/.test(text)) {
    if (field.options && field.options.length) {
      const decline = field.options.find(o => /prefer\s+not|decline|not\s+disclose|\bno\b/i.test(o));
      if (decline) return { answer: decline, source: 'rule' };
    }
    return { answer: '__SKIP__', source: 'rule' };
  }

  if (/\bgender\b|\bpronouns?\b/.test(text)) {
    if (field.options && field.options.length) {
      const decline = field.options.find(o => /prefer\s+not|decline|not\s+disclose/i.test(o));
      if (decline) return { answer: decline, source: 'rule' };
      const male = field.options.find(o => /^male$/i.test(o.trim()));
      if (male) return { answer: male, source: 'rule' };
    }
    return { answer: '__SKIP__', source: 'rule' };
  }

  if (/visible\s+minority|racial|racialized|\brace\b|\bethnicity\b|\bethnic\s+origin\b/.test(text)) {
    if (field.options && field.options.length) {
      const southAsian = field.options.find(o => /south\s+asian/i.test(o));
      if (southAsian) return { answer: southAsian, source: 'rule' };
      const asian = field.options.find(o => /\basian\b/i.test(o));
      if (asian) return { answer: asian, source: 'rule' };
      const decline = field.options.find(o => /prefer\s+not|decline|not\s+disclose/i.test(o));
      if (decline) return { answer: decline, source: 'rule' };
    }
    return { answer: '__SKIP__', source: 'rule' };
  }

  if (/indigenous|aboriginal|first\s+nation|m[eé]tis|inuit|status\s+indian/.test(text)) {
    if (field.options && field.options.length) {
      const no = field.options.find(o => /\bno\b|non/i.test(o));
      if (no) return { answer: no, source: 'rule' };
      const decline = field.options.find(o => /prefer\s+not|decline|not\s+disclose/i.test(o));
      if (decline) return { answer: decline, source: 'rule' };
    }
    return { answer: '__SKIP__', source: 'rule' };
  }

  if (/lgbtq|sexual\s+orientation|sexual\s+identity/.test(text)) {
    if (field.options && field.options.length) {
      const decline = field.options.find(o => /prefer\s+not|decline|not\s+disclose/i.test(o));
      if (decline) return { answer: decline, source: 'rule' };
    }
    return { answer: '__SKIP__', source: 'rule' };
  }

  // FIX — Driver's licence: answer Yes/No for radio fields, Skip only for text inputs
  if (/driver.?s?\s+licen|driving\s+licen/.test(text)) {
    if (field.options && field.options.length) return pickYesNo(field, true);
    return { answer: '__SKIP__', source: 'rule' };
  }

  if (/hear\s+about\s+this\s+opportun|how\s+did\s+you\s+hear|how\s+you\s+heard|source\s+of\s+(your\s+)?application|referred?\s+to\s+this\s+position/.test(text)) {
    const opts = field.options || [];
    const PREF = [
      o => /\bindeed\b/i.test(o),
      o => /third\s+party.*site|job\s+board|career\s+site/i.test(o),
      o => /linkedin/i.test(o),
      o => /referral|referred/i.test(o),
    ];
    for (const test of PREF) {
      const match = opts.find(test);
      if (match) return { answer: match, source: 'rule' };
    }
    const first = opts.find(o => o && o.trim());
    if (first) return { answer: first, source: 'rule' };
    return null;
  }

  if (/notice\s+period|available\s+to\s+start|start\s+date/.test(text))
    return { answer: '__SKIP__', source: 'rule' };

  if (/security\s+clearance/.test(text))
    return { answer: '__SKIP__', source: 'rule' };

  return null;
}

// ─── Answer cleaner ───────────────────────────────────────────────────────────

function cleanAnswer(answer, field, profile) {
  const raw        = (answer || '').trim();
  const labelText  = [field.label || '', field.name || '', field.placeholder || ''].join(' ');
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
    INDEED_RULE_PATTERNS,
    isSafetyField,
    isNumericExperienceField,
    resolveDirectField,
    resolveRuleField,
    estimateExperienceYears,
    pickYesNo,
    matchYesOption,
    cleanAnswer,
    fieldText,
  };
}
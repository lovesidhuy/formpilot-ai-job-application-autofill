'use strict';

function normalizePipelineText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizePipelineFieldType(fieldOrType) {
  const raw = typeof fieldOrType === 'string'
    ? fieldOrType
    : (fieldOrType?.type || fieldOrType?.tag || '');
  const type = String(raw || '').toLowerCase();
  return type === 'checkbox-group' ? 'checkbox_group' : type;
}

function buildPipelineQuestionKey(questionKey) {
  return normalizePipelineText(questionKey).toLowerCase().slice(0, 120);
}

function buildTypedMemoryKey(questionKey, fieldOrType) {
  const key = buildPipelineQuestionKey(questionKey);
  const type = normalizePipelineFieldType(fieldOrType) || 'unknown';
  return key ? `${type}::${key}` : '';
}

function isPipelineTextField(fieldOrType) {
  const type = normalizePipelineFieldType(fieldOrType);
  return ['text', 'textarea', 'email', 'tel', 'url'].includes(type);
}

function isPipelineStructuredField(fieldOrType) {
  const type = normalizePipelineFieldType(fieldOrType);
  return ['radio', 'select', 'aria-radio', 'checkbox_group', 'consent_checkbox_group', 'number'].includes(type);
}

function normalizePipelineOptionLabel(value) {
  return normalizePipelineText(value)
    .toLowerCase()
    .replace(/\*+/g, ' ')
    .replace(/\brequired\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getPipelineOptionLabels(fieldOrType) {
  return (fieldOrType?.options || [])
    .map(option => typeof option === 'string' ? option : (option?.label || option?.value || ''))
    .map(normalizePipelineText)
    .filter(Boolean);
}

function buildPipelineOptionsSignature(fieldOrType) {
  const labels = getPipelineOptionLabels(fieldOrType)
    .map(normalizePipelineOptionLabel)
    .filter(Boolean);
  return labels.length ? labels.join('||') : '';
}

function isCanonicalStructuredAnswerForField(fieldOrType, answer) {
  const type = normalizePipelineFieldType(fieldOrType);
  const canonicalAnswer = canonicalizeAnswerForField(fieldOrType, answer);

  if (type === 'number') {
    return /^-?\d+(?:\.\d+)?$/.test(String(canonicalAnswer || ''));
  }

  const optionLabels = getPipelineOptionLabels(fieldOrType).map(normalizePipelineOptionLabel);
  if (!optionLabels.length) return false;

  if (type === 'checkbox_group' || type === 'consent_checkbox_group') {
    return Array.isArray(canonicalAnswer) &&
      canonicalAnswer.length > 0 &&
      canonicalAnswer.every(value => optionLabels.includes(normalizePipelineOptionLabel(value)));
  }

  if (['radio', 'select', 'aria-radio'].includes(type)) {
    return optionLabels.includes(normalizePipelineOptionLabel(canonicalAnswer));
  }

  return false;
}

function getStructuredMemoryDecision(questionText, fieldOrType, entry) {
  const type = normalizePipelineFieldType(fieldOrType);
  const currentSignature = buildPipelineOptionsSignature(fieldOrType);
  const storedSignature = normalizePipelineText(entry?.optionsSignature || '');

  if (!entry?.answer) {
    return { allowed: false, reason: 'empty-memory-answer' };
  }

  if (type === 'number') {
    return /^-?\d+(?:\.\d+)?$/.test(String(canonicalizeAnswerForField(type, entry.answer) || ''))
      ? { allowed: true, reason: 'valid-numeric-memory' }
      : { allowed: false, reason: 'invalid-numeric-memory' };
  }

  if (!currentSignature) {
    return { allowed: false, reason: 'missing-current-options' };
  }

  if (storedSignature && storedSignature !== currentSignature) {
    return { allowed: false, reason: 'options-signature-mismatch' };
  }

  const sameQuestion = buildPipelineQuestionKey(questionText) === buildPipelineQuestionKey(entry?.questionText || entry?.questionKey || '');
  if (!sameQuestion) {
    return { allowed: false, reason: 'question-key-mismatch' };
  }

  return isCanonicalStructuredAnswerForField(fieldOrType, entry.answer)
    ? { allowed: true, reason: 'structured-answer-valid' }
    : { allowed: false, reason: 'structured-answer-invalid-for-options' };
}

function tokenizeQuestionText(value) {
  const stopWords = new Set([
    'a', 'an', 'and', 'are', 'about', 'at', 'be', 'by', 'did', 'do', 'for',
    'from', 'how', 'i', 'in', 'is', 'me', 'my', 'of', 'on', 'or', 'our',
    'that', 'the', 'this', 'to', 'us', 'we', 'what', 'why', 'you', 'your',
  ]);
  return normalizePipelineText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length >= 3 && !stopWords.has(token));
}

function computeQuestionSimilarity(a, b) {
  const aTokens = new Set(tokenizeQuestionText(a));
  const bTokens = new Set(tokenizeQuestionText(b));
  if (!aTokens.size || !bTokens.size) return 0;

  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap++;
  }

  const union = new Set([...aTokens, ...bTokens]).size || 1;
  return overlap / union;
}

function isRiskyTextareaQuestion(questionText) {
  const text = normalizePipelineText(questionText).toLowerCase();
  return (
    /\bwhy\b.*\b(role|position|job|company|work here)\b/.test(text) ||
    /\bwhat interests you\b/.test(text) ||
    /\bwhat separates you\b/.test(text) ||
    /\bwhy are you the best\b/.test(text) ||
    /\bwhat makes you\b.*\b(best|good fit|stand out)\b/.test(text) ||
    /\bwhy should we hire you\b/.test(text) ||
    /\btell us about a time\b/.test(text) ||
    /\bspecific example\b/.test(text) ||
    /\bhow did you handle it\b/.test(text) ||
    /\blearned the hard way\b/.test(text) ||
    /\bwhat does good .* leadership look like\b/.test(text) ||
    /\bwhere do you think .* fall short\b/.test(text) ||
    /\bhow do you decide what information to share\b/.test(text) ||
    /\bwhat'?s one thing\b/.test(text) ||
    /\bhow did it change your approach\b/.test(text) ||
    /\bcomplex project\b/.test(text)
  );
}

function isProfileSummaryStyleQuestion(questionText) {
  const text = normalizePipelineText(questionText).toLowerCase();
  return (
    /\babout (you|yourself|me)\b/.test(text) ||
    /\bprofessional summary\b/.test(text) ||
    /\bbio\b/.test(text) ||
    /\btell us about (you|yourself)\b/.test(text)
  );
}

function isPageChromeOrReviewText(questionText) {
  const text = normalizePipelineText(questionText).toLowerCase();
  if (!text) return false;

  const chromeFragments = [
    'start of main content',
    'please review your application',
    'you will not be able to make changes after you submit your application',
    'get email updates for the latest',
    'by creating a job alert',
    'by pressing apply',
    'having an issue with this application',
    'this site is protected by recaptcha',
    'google’s privacy policy',
    "google's privacy policy",
    'terms of service apply',
  ];

  if (chromeFragments.some(fragment => text.includes(fragment))) return true;

  return (
    text.length > 260 &&
    /terms|cookie|privacy|recaptcha|job alert|submit your application|review your application/i.test(text)
  );
}

function isStatementLikeTextareaPrompt(questionText) {
  const text = normalizePipelineText(questionText).toLowerCase();
  if (!text) return false;

  return (
    /^i\s+(understand|acknowledge|agree|confirm|certify|attest|know|can|am|have)\b/.test(text) ||
    /^my\s+(availability|understanding|consent|agreement)\b/.test(text) ||
    (
      /\b(commute|commuting|travel to work|work on site|work from the office|shift work|after hours|weekend|holiday support|background check|screening|testing|consent|acknowledge|authorize|agree|confirm|comfortable proceeding|able to commute)\b/.test(text) &&
      /\b(able|willing|comfortable|understand|acknowledge|agree|confirm|certify|know)\b/.test(text) &&
      !/\?$/.test(text)
    )
  );
}

function looksLikeProfileSummaryAnswer(answerText, profileSummary = '') {
  const answer = normalizePipelineText(answerText).toLowerCase();
  const summary = normalizePipelineText(profileSummary).toLowerCase();
  if (!answer || !summary) return false;
  if (answer === summary) return true;
  return answer.length >= 80 && (answer.includes(summary.slice(0, 80)) || summary.includes(answer.slice(0, 80)));
}

function getTextareaMemoryDecision(questionText, entry, profileSummary = '') {
  const storedQuestion = entry?.questionText || entry?.questionKey || '';
  const similarity = computeQuestionSimilarity(questionText, storedQuestion);
  const risky = isRiskyTextareaQuestion(questionText);
  const exact = buildPipelineQuestionKey(questionText) === buildPipelineQuestionKey(storedQuestion);
  const summaryLikeAnswer = looksLikeProfileSummaryAnswer(entry?.answer || '', profileSummary);

  if (risky) {
    return { allowed: false, similarity, reason: 'risky-textarea-question' };
  }

  if (summaryLikeAnswer && !isProfileSummaryStyleQuestion(questionText)) {
    return { allowed: false, similarity, reason: 'profile-summary-memory-blocked' };
  }

  if (exact) {
    return { allowed: true, similarity: 1, reason: 'exact-question-match' };
  }

  if (similarity >= 0.9) {
    return { allowed: true, similarity, reason: 'high-lexical-similarity' };
  }

  return { allowed: false, similarity, reason: 'low-question-similarity' };
}

function extractNumericToken(value) {
  const text = normalizePipelineText(Array.isArray(value) ? value[0] : value);
  const match = text.match(/-?\d+(?:\.\d+)?/);
  return match ? match[0] : '';
}

function condenseTextareaAnswer(answer) {
  const text = normalizePipelineText(Array.isArray(answer) ? answer.join(' ') : answer);
  if (!text) return '';

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map(sentence => normalizePipelineText(sentence))
    .filter(Boolean);

  let condensed = sentences.slice(0, 3).join(' ');
  if (!condensed) condensed = text;

  if (condensed.length > 220) {
    condensed = condensed.slice(0, 220).replace(/\s+\S*$/, '').trim();
  }

  if (sentences.length > 3 && /[a-z0-9]$/i.test(condensed)) {
    condensed += '...';
  }

  return condensed;
}

function canonicalizeAnswerForField(fieldOrType, answer) {
  const type = normalizePipelineFieldType(fieldOrType);

  if (type === 'number') {
    return extractNumericToken(answer);
  }

  if (type === 'checkbox_group' || type === 'consent_checkbox_group') {
    const values = Array.isArray(answer) ? answer : String(answer || '').split(',');
    return values.map(v => normalizePipelineText(v)).filter(Boolean);
  }

  if (['radio', 'select', 'aria-radio'].includes(type)) {
    return normalizePipelineText(Array.isArray(answer) ? answer[0] : answer);
  }

  if (type === 'textarea') {
    return condenseTextareaAnswer(answer);
  }

  return normalizePipelineText(Array.isArray(answer) ? answer.join(', ') : answer);
}

function shouldStorePipelineMemory(questionKey, fieldOrType, answer) {
  const type = normalizePipelineFieldType(fieldOrType);
  const key = buildPipelineQuestionKey(questionKey);
  if (!key || !type) return false;

  if (type === 'number') return /^-?\d+(?:\.\d+)?$/.test(String(answer || ''));
  if (type === 'checkbox_group' || type === 'consent_checkbox_group') {
    return isCanonicalStructuredAnswerForField(fieldOrType, answer);
  }
  if (['radio', 'select', 'aria-radio'].includes(type)) {
    return isCanonicalStructuredAnswerForField(fieldOrType, answer);
  }
  if (type === 'textarea' && isRiskyTextareaQuestion(questionKey)) return false;
  if (isPipelineTextField(type)) return normalizePipelineText(answer).split(/\s+/).filter(Boolean).length >= 3;
  return false;
}

function looksLikePipelineCountryField(questionText, options) {
  const text = String(questionText || '').trim().toLowerCase();
  if (/\bcountry\b|\bpays\b/.test(text)) return true;
  const opts = (options || []).map(option =>
    String(typeof option === 'string' ? option : (option?.label || option?.value || '')).trim().toLowerCase()
  ).filter(Boolean);
  return (
    opts.length >= 20 &&
    opts.includes('canada') &&
    opts.includes('united states') &&
    opts.includes('afghanistan')
  );
}

function describePipelineAnswerForLog(answer) {
  if (Array.isArray(answer)) return `[${answer.map(v => normalizePipelineText(v)).filter(Boolean).join(', ')}]`;
  return normalizePipelineText(answer) || '__EMPTY__';
}

function loadPipelineProfile() {
  return new Promise(resolve => {
    const keys = [
      'firstName', 'lastName', 'email', 'phone',
      'city', 'province', 'country', 'postal',
      'headline', 'summary', 'experienceYears', 'skills', 'portfolio', 'linkedin',
      'education', 'educationLevel', 'fieldOfStudy', 'gradYear', 'address', 'workAuth', 'sponsorship', 'salary',
      'pref_remote', 'pref_relocate', 'experience',
    ];

    chrome.storage.local.get(keys, data => {
      if (data.experience && !data.experienceYears) {
        data.experienceYears = data.experience;
      }

      let skills = [];
      try {
        const raw = data.skills;
        if (Array.isArray(raw)) skills = raw;
        else if (typeof raw === 'string' && raw.trim().startsWith('[')) skills = JSON.parse(raw);
        else if (typeof raw === 'string' && raw.trim()) skills = raw.split(',').map(s => s.trim()).filter(Boolean);
      } catch (_) {}

      resolve({
        firstName: data.firstName || '',
        lastName: data.lastName || '',
        email: data.email || '',
        phone: data.phone || '',
        city: data.city || '',
        province: data.province || '',
        country: data.country || '',
        postal: data.postal || '',
        headline: data.headline || '',
        summary: data.summary || '',
        experienceYears: String(data.experienceYears || '0'),
        skills,
        portfolio: data.portfolio || '',
        linkedin: data.linkedin || '',
        education: data.education || '',
        educationLevel: data.educationLevel || '',
        fieldOfStudy: data.fieldOfStudy || '',
        gradYear: String(data.gradYear || ''),
        address: data.address || '',
        workAuth: data.workAuth !== false,
        sponsorship: data.sponsorship === true,
        salary: String(data.salary || ''),
        preferences: {
          remote: data.pref_remote !== false,
          relocate: data.pref_relocate !== false,
        },
      });
    });
  });
}

function lookupPipelineMemory(questionKey, fieldOrType) {
  return new Promise(resolve => {
    const typedKey = buildTypedMemoryKey(questionKey, fieldOrType);
    const legacyKey = buildPipelineQuestionKey(questionKey);
    if (!typedKey) {
      resolve(null);
      return;
    }

    chrome.storage.local.get(['qf_memory'], data => {
      const memory = data.qf_memory || {};
      const typedEntry = memory[typedKey];
      if (typedEntry) {
        resolve(typedEntry);
        return;
      }

      if (!isPipelineTextField(fieldOrType)) {
        resolve(null);
        return;
      }

      const legacyEntry = memory[legacyKey];
      const legacyType = normalizePipelineFieldType(legacyEntry?.type || '');
      if (legacyEntry && (!legacyType || isPipelineTextField(legacyType))) {
        resolve(legacyEntry);
        return;
      }

      resolve(null);
    });
  });
}

function storePipelineMemory(questionKey, fieldOrType, answer, source = 'ai') {
  return new Promise(resolve => {
    const typedKey = buildTypedMemoryKey(questionKey, fieldOrType);
    const canonicalAnswer = canonicalizeAnswerForField(fieldOrType, answer);
    const type = normalizePipelineFieldType(fieldOrType);

    if (!typedKey || !shouldStorePipelineMemory(questionKey, type, canonicalAnswer)) {
      resolve(false);
      return;
    }

    chrome.storage.local.get(['qf_memory'], data => {
      const memory = data.qf_memory || {};
      memory[typedKey] = {
        questionKey: buildPipelineQuestionKey(questionKey),
        questionText: normalizePipelineText(questionKey),
        type,
        answer: canonicalAnswer,
        optionsSignature: buildPipelineOptionsSignature(fieldOrType),
        source,
        ts: Date.now(),
      };
      chrome.storage.local.set({ qf_memory: memory }, () => {
        void chrome.runtime.lastError;
        resolve(true);
      });
    });
  });
}

class AnswerPipeline {
  constructor(profile, registry, step, jobContext = '', logger = null) {
    this.profile = profile;
    this.registry = registry;
    this.step = step;
    this.jobContext = jobContext;
    this.logger = logger || new FlowLogger();
    this.stats = { profile: 0, rule: 0, ai: 0, memory: 0, skipped: 0 };
  }

  pushLog(msg) {
    this.logger.push(msg);
  }

  getLogs() {
    return this.logger.getAll();
  }

  async processField(field) {
    const entry = this.registry?.get(field.id);
    const options = entry?.options || (field.options || []).map(option =>
      typeof option === 'string' ? option : (option.label || option.value || '')
    ).filter(Boolean);
    const rawQuestionText = entry?.questionText || field.questionText || field.label || field.name || '';
    const questionText = looksLikePipelineCountryField(rawQuestionText, options)
      ? 'Country'
      : rawQuestionText;
    const normalizedField = {
      ...field,
      label: questionText,
      question: questionText,
      questionText,
      options,
    };

    this.logger.question(questionText, field.type, options);

    if (isPageChromeOrReviewText(questionText)) {
      this.pushLog(`[Guard] skipped page/review text that is not a field question: '${questionText.slice(0, 80)}'`);
      this.stats.skipped++;
      return { answer: '__SKIP__', originalAnswer: '__SKIP__', normalizedAnswer: '__SKIP__', source: 'skipped' };
    }

    const hardRule = resolveHardRules(normalizedField, this.profile);
    if (hardRule?.answer) {
      this.logger.ruleAnswer(hardRule.answer);
      this.stats.rule++;
      return { answer: hardRule.answer, source: 'rule' };
    }

    const profileBound = resolveProfileBoundField(normalizedField, this.profile);
    if (profileBound?.answer) {
      this.logger.profileAnswer(profileBound.answer);
      this.stats.profile++;
      return { answer: profileBound.answer, source: 'profile' };
    }

    const helpful = resolveHelpfulDefaultField(normalizedField, this.profile);
    if (helpful?.answer) {
      this.logger.ruleAnswer(helpful.answer);
      this.stats.rule++;
      return { answer: helpful.answer, source: 'rule' };
    }

    const fieldType = normalizePipelineFieldType(normalizedField);
    if (fieldType === 'textarea' && isStatementLikeTextareaPrompt(questionText)) {
      const affirmation = 'I understand and agree.';
      this.pushLog(`[Guard] statement-like textarea -> auto-affirm: '${questionText.slice(0, 50)}'`);
      this.stats.rule++;
      return {
        answer: affirmation,
        originalAnswer: affirmation,
        normalizedAnswer: canonicalizeAnswerForField(normalizedField, affirmation),
        source: 'rule',
      };
    }

    const memEntry = await lookupPipelineMemory(questionText, normalizedField);
    if (memEntry?.answer) {
      const normalizedMemoryAnswer = canonicalizeAnswerForField(normalizedField, memEntry.answer);
      const textareaDecision = fieldType === 'textarea'
        ? getTextareaMemoryDecision(questionText, memEntry, this.profile?.summary || '')
        : { allowed: true, similarity: 1, reason: 'non-textarea-field' };
      const structuredDecision = isPipelineStructuredField(normalizedField)
        ? getStructuredMemoryDecision(questionText, normalizedField, memEntry)
        : { allowed: true, reason: 'non-structured-field' };
      const isValidStructuredMemory =
        (isPipelineTextField(fieldType) && textareaDecision.allowed) ||
        (isPipelineStructuredField(fieldType) && structuredDecision.allowed);

      if (isValidStructuredMemory) {
        if (fieldType === 'textarea') {
          this.pushLog(`[Memory] textarea match reason=${textareaDecision.reason} score=${textareaDecision.similarity.toFixed(2)}`);
        }
        this.pushLog(`[Memory] chose: '${describePipelineAnswerForLog(normalizedMemoryAnswer)}'`);
        this.stats.memory++;
        return {
          answer: normalizedMemoryAnswer,
          originalAnswer: memEntry.answer,
          normalizedAnswer: normalizedMemoryAnswer,
          source: 'memory',
        };
      }

      if (fieldType === 'textarea') {
        this.pushLog(`[Memory] skipped textarea reuse reason=${textareaDecision.reason} score=${textareaDecision.similarity.toFixed(2)}`);
      } else {
        this.pushLog(`[Memory] skipped invalid cached answer for type=${fieldType} reason=${structuredDecision.reason}`);
      }
    }

    const aiAnswer = await this.askAi(questionText, options, field.type);
    if (aiAnswer && aiAnswer !== '__SKIP__') {
      this.logger.aiAnswer(questionText, aiAnswer);
      this.stats.ai++;
      return {
        answer: aiAnswer,
        originalAnswer: aiAnswer,
        normalizedAnswer: canonicalizeAnswerForField(field.type, aiAnswer),
        source: 'ai',
      };
    }

    if (fieldType === 'textarea') {
      const fallbackText = this.profile.summary || this.profile.headline || '';
      if (fallbackText && isProfileSummaryStyleQuestion(questionText)) {
        this.pushLog(`[Fallback] profile-summary textarea -> (${fallbackText.slice(0, 40)}...)`);
        this.stats.profile++;
        return { answer: fallbackText, source: 'profile' };
      }
    }

    if (['text', 'email', 'tel', 'url'].includes(fieldType)) {
      const profile = this.profile;
      const q = questionText.toLowerCase();
      const fallback =
        /name/.test(q) ? `${profile.firstName} ${profile.lastName}`.trim() :
        /email/.test(q) ? profile.email :
        /phone|tel/.test(q) ? profile.phone :
        /city/.test(q) ? profile.city :
        /postal|zip/.test(q) ? profile.postal : null;
      if (fallback) {
        this.pushLog('[Fallback] text field matched profile key');
        this.stats.profile++;
        return { answer: fallback, source: 'profile' };
      }
    }

    if (fieldType === 'number') {
      const q = questionText.toLowerCase();
      if (/salary|compensation|wage|pay|ctc|remuneration/i.test(q)) {
        const salaryNum = parseInt(String(this.profile.salary || '').replace(/[^\d]/g, ''), 10);
        if (salaryNum > 0) {
          this.pushLog(`[Fallback] number salary -> ${salaryNum}`);
          return { answer: String(salaryNum), source: 'profile' };
        }
      }

      this.pushLog('[Fallback] number -> experienceYears');
      return { answer: this.profile.experienceYears || '0', source: 'rule' };
    }

    this.logger.skipping(`no answer found for: '${questionText}'`);
    this.stats.skipped++;
    return { answer: '__SKIP__', originalAnswer: '__SKIP__', normalizedAnswer: '__SKIP__', source: 'skipped' };
  }

  async askAi(questionText, options, type) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({
        action: 'GET_SINGLE_FIELD_ANSWER',
        field: {
          label: questionText,
          questionText,
          options,
          type,
          jobContext: this.jobContext,
          _jobContext: this.jobContext,
        },
      }, res => {
        if (chrome.runtime.lastError || !res?.ok) {
          resolve('__SKIP__');
          return;
        }
        resolve(res.answer || '__SKIP__');
      });
    });
  }
}

// QuickFill AI – background.js v3.4
// Fixes over v3.3:
// - Removed "type":"module" conflict: importScripts() only works in classic SWs.
//   Remove "type":"module" from manifest.json background entry.
// - PING_OLLAMA: converted nested callback to async/await so sendResponse
//   always fires even if storage or pingOllama throws.
// - Keep-alive alarm guard: creates alarm on SW activation, not just onInstalled,
//   so dev reloads don't lose the alarm.
// - Minor: cancelCurrentAiCall forEach → for..of (avoids Set mutation edge case).

'use strict';

// ── Keep service worker alive ─────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
});

// Guard: re-create alarm on SW activation (dev reloads clear it)
chrome.alarms.get('keepAlive', alarm => {
  if (!alarm) chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') { /* wake SW */ }
});

// rules.js must export: resolveDirectField, resolveRuleField, isSafetyField,
//                       isNumericExperienceField, estimateExperienceYears, cleanAnswer
importScripts('rules.js');

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_OLLAMA_BASE  = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'gemma3:1b';
const AI_TIMEOUT_MS        = 15_000;

// ── URL helpers ───────────────────────────────────────────────────────────────

function normalizeBaseUrl(url) {
  let base = (url || DEFAULT_OLLAMA_BASE).trim();
  if (!base) base = DEFAULT_OLLAMA_BASE;
  base = base.replace(/\/+$/, '');
  base = base.replace(/\/v1\/chat\/completions$/i, '');
  base = base.replace(/\/api\/generate$/i,         '');
  base = base.replace(/\/api\/chat$/i,             '');
  base = base.replace(/\/v1$/i,                    '');
  if (base === 'http://localhost:11434') base = 'http://127.0.0.1:11434';
  return base;
}

const getV1ChatUrl   = b => `${normalizeBaseUrl(b)}/v1/chat/completions`;
const getGenerateUrl = b => `${normalizeBaseUrl(b)}/api/generate`;
const getTagsUrl     = b => `${normalizeBaseUrl(b)}/api/tags`;

// ── Profile loader ────────────────────────────────────────────────────────────

function loadFullProfile() {
  return new Promise((resolve) => {
    const keys = [
      'firstName', 'lastName', 'email', 'phone',
      'city', 'province', 'country', 'postal',
      'headline', 'summary', 'experienceYears', 'skills', 'portfolio',
      'education',
      'workAuth', 'sponsorship', 'salary',
      'pref_remote', 'pref_relocate',
      'ollamaModel', 'ollamaUrl',
      'experience',
    ];
    chrome.storage.local.get(keys, (data) => {
      if (data.experience && !data.experienceYears)
        data.experienceYears = data.experience;

      let skills = [];
      try {
        const raw = data.skills;
        if (Array.isArray(raw)) {
          skills = raw;
        } else if (typeof raw === 'string' && raw.trim().startsWith('[')) {
          skills = JSON.parse(raw);
        } else if (typeof raw === 'string' && raw.trim()) {
          skills = raw.split(',').map(s => s.trim()).filter(Boolean);
        }
      } catch (_) {}

      resolve({
        firstName:       data.firstName       || '',
        lastName:        data.lastName        || '',
        email:           data.email           || '',
        phone:           data.phone           || '',
        city:            data.city            || '',
        province:        data.province        || '',
        country:         data.country         || '',
        postal:          data.postal          || '',
        headline:        data.headline        || '',
        summary:         data.summary         || '',
        experienceYears: String(data.experienceYears || '0'),
        skills,
        portfolio:       data.portfolio       || '',
        education:       data.education       || '',
        workAuth:        data.workAuth  !== false,
        sponsorship:     data.sponsorship === true,
        salary:          String(data.salary   || ''),
        preferences: {
          remote:   data.pref_remote   !== false,
          relocate: data.pref_relocate !== false,
        },
        ollamaModel: data.ollamaModel || DEFAULT_OLLAMA_MODEL,
        ollamaUrl:   normalizeBaseUrl(data.ollamaUrl || DEFAULT_OLLAMA_BASE),
      });
    });
  });
}

// ── Abort controllers ─────────────────────────────────────────────────────────

const _activeAiControllers = new Set();

function createAiRequestController(timeoutMs = AI_TIMEOUT_MS) {
  const controller = new AbortController();
  controller._timer = setTimeout(() => {
    try { controller.abort(new Error(`Ollama timeout after ${timeoutMs}ms`)); }
    catch (_) { controller.abort(); }
  }, timeoutMs);
  _activeAiControllers.add(controller);

  const cleanup = () => {
    clearTimeout(controller._timer);
    _activeAiControllers.delete(controller);
  };
  return { controller, signal: controller.signal, cleanup };
}

function cancelCurrentAiCall() {
  for (const controller of [..._activeAiControllers]) {
    try { clearTimeout(controller._timer); controller.abort(new Error('Cancelled by user')); }
    catch (_) { try { controller.abort(); } catch (_) {} }
  }
  _activeAiControllers.clear();
}

// ── Session caches ────────────────────────────────────────────────────────────

const _sessionCache = new Map();
let _memoryCache    = null;

async function getMemoryCache() {
  if (_memoryCache !== null) return _memoryCache;
  _memoryCache = await new Promise(resolve =>
    chrome.storage.local.get(['qf_memory'], d => resolve(d.qf_memory || {}))
  );
  return _memoryCache;
}

function invalidateMemoryCache() { _memoryCache = null; }

let _ollamaKnownOnline = false;

async function cachedPingOllama(profile) {
  if (_ollamaKnownOnline) return true;
  const ok = await quickPingOllama(profile).catch(() => false);
  _ollamaKnownOnline = ok;
  return ok;
}

function getFieldCacheKey(field) {
  return JSON.stringify({
    label:       (field.label       || '').trim().toLowerCase(),
    name:        (field.name        || '').trim().toLowerCase(),
    placeholder: (field.placeholder || '').trim().toLowerCase(),
    type:        (field.type        || '').trim().toLowerCase(),
    options:     (field.options     || []).map(x => x.trim().toLowerCase()).sort(),
  });
}

// ── Indeed/SmartApply rule-handled radio detector ─────────────────────────────
// INDEED_RULE_PATTERNS is defined in rules.js (loaded via importScripts above).

function isIndeedRuleHandled(field) {
  if (field.type !== 'radio' && field.tag !== 'radio') return false;
  const q = (field.label || field.name || '').toLowerCase();
  return INDEED_RULE_PATTERNS.some(re => re.test(q));
}
// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(profile) {
  const today = new Date();

  function nextWeekdays(n) {
    const slots = [];
    const d = new Date(today);
    while (slots.length < n) {
      d.setDate(d.getDate() + 1);
      if (d.getDay() !== 0 && d.getDay() !== 6) {
        const y   = d.getFullYear();
        const mo  = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        slots.push(`${y}-${mo}-${day} 09:00–17:00`);
      }
    }
    return slots;
  }

  const availabilitySlots = nextWeekdays(3).join('\n');
  const skillList = Array.isArray(profile.skills) && profile.skills.length
    ? profile.skills.join(', ') : '';
  const education = profile.education || profile.headline || '';

  const profileLines = [
    `Applicant: ${profile.firstName} ${profile.lastName}`.trim(),
    profile.headline ? `Role: ${profile.headline}` : '',
    (profile.city || profile.province || profile.country)
      ? `Location: ${[profile.city, profile.province, profile.country].filter(Boolean).join(', ')}` : '',
    profile.summary  ? `Summary: ${profile.summary}`     : '',
    skillList        ? `Key skills: ${skillList}`         : '',
    education        ? `Education: ${education}`          : '',
    `Work auth: ${profile.workAuth !== false ? 'Authorized to work' : 'Not authorized'}`,
    `Sponsorship needed: ${profile.sponsorship === true ? 'Yes' : 'No'}`,
    profile.salary   ? `Expected salary: ${profile.salary}` : '',
  ].filter(Boolean).join('\n');

  return `You fill job application form fields. Output ONLY the field value — nothing else.

LANGUAGE: ALWAYS respond in English only, regardless of the language the question is written in.

Rules:
- No preamble, no explanation, no "Based on your resume", no AI self-references.
- Numeric experience fields → plain integer only.
- Yes/No fields → "Yes" or "No" only. This applies to ALL Yes/No questions including those
  phrased as "Would you say...", "Would you consider yourself...", "Do you consider yourself...",
  or "Would you describe yourself as...". NEVER answer a Yes/No question with a sentence or
  sentence fragment.
- Select/radio → exact text of one provided option.
- "Why applying" / motivation → 2–3 short natural sentences, max 420 chars, no cover-letter tone.
- All other open text → max 2–3 sentences, max 400 chars, factual and confident.
- Use __SKIP__ only if a non-numeric field truly cannot be answered.

- If a question asks for interview availability, scheduling, or dates/times:
  - Copy EXACTLY these pre-computed slots, one per line, no changes:
${availabilitySlots}
  - Do not reformat, do not invent new dates, do not change the time range.

FORMAT DISCIPLINE:
- NEVER repeat the question text in your answer.
- NEVER list or repeat the option choices as your answer.
- NEVER echo any part of the field label back as the answer.

OPTIONAL FIELDS:
- If a field asks "anything else", "additional comments", "other information", or
  "tell us more about yourself" and you have nothing specific to add → respond with __SKIP__.
- NEVER answer a textarea with a single word or a single short phrase.

SKILLS & TOOLS:
- NEVER claim experience, proficiency, or familiarity with any tool, technology, machine,
  hardware, software platform, or certification that is not explicitly listed in your profile's
  key skills. If asked about a niche or unfamiliar tool not in your skills list → answer "No".
- For compound questions listing multiple technologies (e.g. "Are you proficient in PHP, HTML,
  CSS, JavaScript, and SQL basics?") → answer "Yes" if you have experience with the majority
  of the listed technologies, even if not all.

FAMILIARITY SCALES:
- For familiarity or proficiency scale questions with options like "Never heard of it" /
  "Studied it" / "Used professionally" / "Expert":
  NEVER select "Never heard of it" or the lowest option.
  Select "Studied/Read about it" or the second-lowest option as the minimum.

CRITICAL:
- If asked about language proficiency, answer with proficiency level
  (e.g. "English: Full Professional Proficiency"), not CEFR levels or vague terms.
- NEVER invent personal identity details.
- NEVER generate names, phone numbers, email addresses, or contact information.
- ONLY use provided profile data for identity-related fields.
- If identity data is missing → return __SKIP__.
- If asked whether you have worked for this company before → answer "No".

INDEED / SMARTAPPLY NOTE:
- Radio/select questions about commute, visa, work authorization, background checks,
  drug tests, diversity, age, criminal history, and schedule are handled automatically
  by deterministic rules before reaching you. You will NOT see those fields.
- For any remaining radio/select, pick the EXACT text of one listed option.
- For open-text screener questions, be concise (2–3 sentences max).

${profileLines}`;
}

// ── User message builder ──────────────────────────────────────────────────────

function buildUserMessage(field) {
  let msg = `Question / label: "${field.label || ''}"`;
  if (field.name)        msg += `\nField name: "${field.name}"`;
  if (field.placeholder) msg += `\nPlaceholder: "${field.placeholder}"`;
  if (field.type)        msg += `\nField type: "${field.type}"`;
  if (field.options && field.options.length)
    msg += `\nAvailable options (choose ONE exactly): ${JSON.stringify(field.options)}`;
  if (field.currentValue)
    msg += `\nCurrent value (skip if already correct): "${field.currentValue}"`;
  return msg;
}

// ── Error classifiers ─────────────────────────────────────────────────────────

function isTimeoutError(e) {
  return (
    e.name === 'TimeoutError' ||
    e.name === 'AbortError'   ||
    /timeout|aborted/i.test(e.message || '')
  );
}

function isNetworkError(e) {
  const msg = String(e?.message || e || '').toLowerCase();
  return /failed to fetch|networkerror|network request failed|econnrefused|offline|load failed/.test(msg);
}

// ── Ollama callers ────────────────────────────────────────────────────────────

async function askOllamaV1(systemPrompt, field, model, baseUrl, profile) {
  const { signal, cleanup } = createAiRequestController();
  try {
    const resp = await fetch(getV1ChatUrl(baseUrl), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: buildUserMessage(field) },
        ],
        stream: false, temperature: 0.15,
      }),
      signal,
    });
    if (!resp.ok) throw new Error(`V1 chat HTTP ${resp.status}`);
    const data = await resp.json();
    return cleanAnswer(data?.choices?.[0]?.message?.content || '', field, profile);
  } finally { cleanup(); }
}

async function askOllamaGenerate(systemPrompt, field, model, baseUrl, profile) {
  const { signal, cleanup } = createAiRequestController();
  try {
    const resp = await fetch(getGenerateUrl(baseUrl), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: `${systemPrompt}\n\n${buildUserMessage(field)}\n\nAnswer only with the final field value.`,
        stream: false, options: { temperature: 0.15 },
      }),
      signal,
    });
    if (!resp.ok) throw new Error(`/api/generate HTTP ${resp.status}`);
    const data = await resp.json();
    return cleanAnswer(data?.response || '', field, profile);
  } finally { cleanup(); }
}

async function askOllama(systemPrompt, field, model, baseUrl, profile) {
  try {
    return await askOllamaV1(systemPrompt, field, model, baseUrl, profile);
  } catch (e) {
    console.warn('[QuickFill BG] v1 failed, trying generate:', e?.message || e);
  }
  return await askOllamaGenerate(systemPrompt, field, model, baseUrl, profile);
}

// ── Ollama ping helpers ───────────────────────────────────────────────────────

async function quickPingOllama(profile) {
  const controller = new AbortController();
  const timer = setTimeout(() => { try { controller.abort(); } catch (_) {} }, 5000);
  try {
    const r = await fetch(
      getTagsUrl(profile.ollamaUrl || DEFAULT_OLLAMA_BASE),
      { signal: controller.signal }
    );
    return r.ok;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function pingOllama(baseUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => { try { controller.abort(); } catch (_) {} }, 5000);
  try {
    const r = await fetch(getTagsUrl(baseUrl), { signal: controller.signal });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const data   = await r.json();
    const models = (data.models || []).map(m => m.name);
    _ollamaKnownOnline = true;
    return { ok: true, models };
  } catch (e) {
    _ollamaKnownOnline = false;
    return { ok: false, error: e?.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// ── Parallel AI executor ──────────────────────────────────────────────────────

async function runWithConcurrency(tasks, concurrency = 1) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) { const i = idx++; results[i] = await tasks[i](); }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

// ── Generate answers for a batch of fields ────────────────────────────────────

async function generateAnswers(fields, profile, basicMode) {
  const systemPrompt     = buildSystemPrompt(profile);
  const persistentMemory = await getMemoryCache();

  const classified = fields.map(field => {
    if (field.currentValue && field.currentValue.trim())
      return { field, answer: '__SKIP__', source: 'skipped', needsAi: false };

    const questionKey = (field.label || field.name || '').trim().toLowerCase().slice(0, 120);
    if (persistentMemory[questionKey]) {
      const m = persistentMemory[questionKey];
      return { field, answer: m.answer, source: m.source + '+memory', needsAi: false };
    }

    const cacheKey = getFieldCacheKey(field);
    if (_sessionCache.has(cacheKey)) {
      const c = _sessionCache.get(cacheKey);
      return { field, answer: c.answer, source: c.source, needsAi: false };
    }

    const direct = resolveDirectField(field, profile);
    if (direct !== null)
      return { field, answer: direct.answer, source: direct.source, needsAi: false };

    const rule = resolveRuleField(field, profile);
    if (rule !== null)
      return { field, answer: rule.answer, source: rule.source, needsAi: false };

    if (isIndeedRuleHandled(field))
      return { field, answer: '__SKIP__', source: 'rule', needsAi: false };

    if (isSafetyField(field)) {
      const a = isNumericExperienceField(field)
        ? estimateExperienceYears(field, profile) : '__SKIP__';
      return { field, answer: a, source: 'rule', needsAi: false };
    }

    return { field, answer: null, source: null, needsAi: true };
  });

  for (const c of classified) {
    if (!c.needsAi && c.answer && c.answer !== '__SKIP__' &&
        !['error', 'timeout', 'network_error'].includes(c.source || ''))
      _sessionCache.set(getFieldCacheKey(c.field), { answer: c.answer, source: c.source });
  }

  const aiFields = classified.filter(c => c.needsAi);

  if (!aiFields.length || basicMode) {
    if (basicMode) aiFields.forEach(c => { c.answer = '__SKIP__'; c.source = 'skipped'; });
    return classified.map(c => ({
      ...c.field, answer: c.answer || '__SKIP__', source: c.source || 'skipped',
    }));
  }

  const batchState   = { aiDisabled: false, ollamaOffline: false, aiFailureCount: 0 };
  const ollamaOnline = await cachedPingOllama(profile);

  if (!ollamaOnline) {
    batchState.aiDisabled = true; batchState.ollamaOffline = true; _ollamaKnownOnline = false;
    aiFields.forEach(c => { c.answer = '__SKIP__'; c.source = 'skipped'; });
  }

  if (!batchState.aiDisabled) {
    const model = profile.ollamaModel || DEFAULT_OLLAMA_MODEL;
    const url   = profile.ollamaUrl   || DEFAULT_OLLAMA_BASE;

    const tasks = aiFields.map(item => async () => {
      if (batchState.aiDisabled) { item.answer = '__SKIP__'; item.source = 'skipped'; return; }
      try {
        item.answer = await askOllama(systemPrompt, item.field, model, url, profile);
        item.source = 'ai';
        batchState.aiFailureCount = 0;
        _sessionCache.set(getFieldCacheKey(item.field), { answer: item.answer, source: 'ai' });
      } catch (e) {
        const timedOut  = isTimeoutError(e);
        const netFailed = isNetworkError(e);
        console.warn('[QuickFill BG] AI error:', {
          field: item.field?.label || item.field?.name, error: e?.message || e,
        });
        item.answer = isNumericExperienceField(item.field)
          ? estimateExperienceYears(item.field, profile) : '__SKIP__';
        item.source = timedOut ? 'timeout' : netFailed ? 'network_error' : 'error';
        batchState.aiFailureCount++;
        if (netFailed) {
          batchState.aiDisabled = true; batchState.ollamaOffline = true;
          _ollamaKnownOnline = false;
          console.warn('[QuickFill BG] Ollama marked OFFLINE (network failure)');
        } else if (batchState.aiFailureCount >= 3) {
          batchState.aiDisabled = true;
          console.warn('[QuickFill BG] AI disabled — repeated failures');
        }
      }
    });

    await runWithConcurrency(tasks, 1);
  }

  let memoryCacheUpdated = false;
  for (const item of aiFields) {
    if (item.source === 'ai' && item.answer && item.answer !== '__SKIP__') {
      const key = (item.field.label || item.field.name || '').trim().toLowerCase().slice(0, 120);
      if (key) { persistentMemory[key] = { answer: item.answer, source: 'ai', ts: Date.now() }; memoryCacheUpdated = true; }
    }
  }
  if (memoryCacheUpdated) chrome.storage.local.set({ qf_memory: persistentMemory }).catch?.(() => {});
  if (batchState.ollamaOffline && !basicMode)
    chrome.storage.local.set({ ollamaWentOffline: true }).catch?.(() => {});

  const aiMap = new Map(aiFields.map(c => [c.field, c]));
  return classified.map(c => {
    const resolved = c.needsAi ? (aiMap.get(c.field) || c) : c;
    return { ...resolved.field, answer: resolved.answer || '__SKIP__', source: resolved.source || 'skipped' };
  });
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.action === 'REPORT_FLOW_PROGRESS') {
    chrome.storage.local.set({ flowState: msg.state }, () => {
      chrome.runtime.sendMessage({ action: 'FLOW_STATE_UPDATED', state: msg.state }).catch?.(() => {});
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'CANCEL_FLOW') {
    cancelCurrentAiCall();
    chrome.storage.local.set({ flowCancelled: true });
    sendResponse({ ok: true });
    return true;
  }

  // ── PING_OLLAMA — fixed: async/await so sendResponse always fires ──────────
  if (msg.action === 'PING_OLLAMA') {
    (async () => {
      try {
        const cfg = await new Promise(resolve =>
          chrome.storage.local.get(['ollamaUrl'], resolve)
        );
        const result = await pingOllama(
          normalizeBaseUrl(cfg.ollamaUrl || DEFAULT_OLLAMA_BASE)
        );
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.action === 'CLEAR_MEMORY') {
    _sessionCache.clear();
    invalidateMemoryCache();
    chrome.storage.local.remove(['qf_memory'], () => sendResponse({ ok: true }));
    return true;
  }

  if (msg.action === 'GET_MEMORY_STATS') {
    chrome.storage.local.get(['qf_memory'], (data) => {
      const mem = data.qf_memory || {};
      sendResponse({ persistent: Object.keys(mem).length, session: _sessionCache.size });
    });
    return true;
  }

  if (msg.action === 'GET_AI_ANSWERS_ONLY') {
    const { fields } = msg;
    chrome.storage.local.get(['basicMode'], async (cfg) => {
      try {
        const profile   = await loadFullProfile();
        const basicMode = cfg.basicMode === true;
        const answers   = await generateAnswers(fields, profile, basicMode);
        sendResponse({ ok: true, answers });
      } catch (e) {
        console.error('[QuickFill BG] GET_AI_ANSWERS_ONLY error:', e);
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    });
    return true;
  }

  if (msg.action === 'FILL_WITH_AI') {
    const { fields, tabId } = msg;
    chrome.storage.local.get(['basicMode'], async (cfg) => {
      try {
        const profile   = await loadFullProfile();
        const basicMode = cfg.basicMode === true;
        const answers   = await generateAnswers(fields, profile, basicMode);
        chrome.tabs.sendMessage(tabId, { action: 'APPLY_ANSWERS', answers }, (res) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          sendResponse({ ok: true, filled: res?.filled || 0, answers });
        });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    });
    return true;
  }

  if (msg.action === 'RETRY_FIELD_ANSWER') {
    (async () => {
      try {
        const profile         = await loadFullProfile();
        const field           = msg.field           || {};
        const previousAnswer  = msg.previousAnswer  || '';
        const validationError = msg.validationError || '';

        let answer;

        if (isSafetyField(field) || isIndeedRuleHandled(field)) {
          const direct = resolveDirectField(field, profile);
          const rule   = resolveRuleField(field, profile);
          answer = direct?.answer ?? rule?.answer ?? '__SKIP__';
        } else {
          const model = profile.ollamaModel || DEFAULT_OLLAMA_MODEL;
          const url   = profile.ollamaUrl   || DEFAULT_OLLAMA_BASE;

          const retrySystemPrompt =
`You are correcting ONE job application field that failed validation.
Return ONLY the corrected answer text — no explanation, no quotes, no preamble.

Field type: ${field.type || field.tag || 'text'}
${field.options && field.options.length
  ? `Available options (pick ONE exactly): ${JSON.stringify(field.options)}`
  : ''}

Rules:
- Yes/No → exactly "Yes" or "No"
- Number/integer → digits only, no units
- Salary → digits only unless currency symbol explicitly required
- Select/radio → exact text of one listed option
- Text → short, valid, max 2 sentences
- Indeed radio (commute, work auth, background check, etc.) → "Yes"

Profile context:
- Work authorized: ${profile.workAuth !== false ? 'Yes' : 'No'}
- Sponsorship needed: ${profile.sponsorship === true ? 'Yes' : 'No'}
- Location: ${[profile.city, profile.province, profile.country].filter(Boolean).join(', ') || 'Not specified'}`;

          const retryUserMsg =
            `Field: "${field.label || field.name || ''}"\n` +
            `Previous answer: "${previousAnswer}"\n` +
            `Validation error: "${validationError}"\n\n` +
            `Return the corrected value only.`;

          const { signal, cleanup } = createAiRequestController(8000);
          try {
            const resp = await fetch(getGenerateUrl(url), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model,
                prompt:  `${retrySystemPrompt}\n\n${retryUserMsg}`,
                stream:  false,
                options: { temperature: 0.1 },
              }),
              signal,
            });
            if (!resp.ok) throw new Error(`Retry HTTP ${resp.status}`);
            const data = await resp.json();
            answer = cleanAnswer(data?.response || '', field, profile);
          } finally {
            cleanup();
          }
        }

        sendResponse({ ok: true, answer: answer || '__SKIP__' });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'OLLAMA_GENERATE') {
    (async () => {
      try {
        const { url, model, systemPrompt, userMsg } = msg.payload;
        const res = await fetch(`${url}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            prompt:  `${systemPrompt}\n\n${userMsg}\n\nReturn only JSON.`,
            stream:  false,
            options: { temperature: 0.1 },
          }),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status} ${text}`);
        const data = JSON.parse(text);
        sendResponse({ ok: true, text: data.response || '' });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true;
  }

});
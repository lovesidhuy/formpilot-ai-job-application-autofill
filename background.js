// QuickFill AI – background.js v4.0
// Major change over v3.5:
// - BATCH AI: All fields sent to Ollama in ONE prompt as JSON array.
//   AI returns JSON array of answers in same order.
//   Eliminates per-field timeout cascade (was 10 fields × 15s = 150s possible wait).
//   Reduces total AI time from 30-50s to 3-5s per page.
//   AI can reason about all questions together (e.g. English+French together).
// - trySetSessionCache: never caches __SKIP__, error, timeout, skipped.
// - radio/checkbox currentValue no longer causes skip (page pre-selection may be wrong).
// - salary fields excluded from experience estimator path.
// - AI timeout raised to 60s for batch (single round trip needs more time).

'use strict';

// ── Keep service worker alive ─────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
});
chrome.alarms.get('keepAlive', alarm => {
  if (!alarm) chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') { /* wake SW */ }
});

importScripts('rules.js');

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_OLLAMA_BASE  = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'phi3:mini';
const AI_TIMEOUT_MS        = 60_000; // batch needs more headroom than per-field

const MEMORY_BLACKLIST_PATTERNS = [
  /laptop|desktop|own.*computer|computer.*own/i,
  /currently employed/i,
  /notice period/i,
  /current.*salary|current.*ctc|current.*gross/i,
  /current.*compensation/i,
  /minimum.*expected|expected.*minimum/i,
  /date available|available.*start|start.*date/i,
  /today.?s date|current date/i,
  /interview.*availab|availab.*interview/i,
  /have you ever worked for|previously worked for/i,
  /relative.*work|family.*work/i,
  /why are you interested in this position|why do you want to work here/i,
  /cover letter|motivation|why should we hire you/i,
  /what makes you a good fit|why are you applying/i,
  /this position requires|are you comfortable proceeding with this requirement/i,
  /are you able to commute reliably|after-hours|holiday support|weekend support/i,
  /criminal background check|reference check|education verification/i,
  /salary expectation|expected salary|desired salary/i,
  /when can you start|how soon can you join/i,
];

function shouldCacheToMemory(questionKey) {
  return !MEMORY_BLACKLIST_PATTERNS.some(p => p.test(questionKey));
}

const MEMORY_ANSWER_BLACKLIST_PATTERNS = [
  /^(__skip__|n\/a|na|none|null|unknown)$/i,
  /not applicable/i,
  /i am excited to apply|i am very interested in this role/i,
  /thank you for your consideration/i,
  /please refer to my resume/i,
  /generated|example answer/i,
];

function normalizeMemoryText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function shouldCacheAnswer(questionKey, answer, field = null) {
  const q = normalizeMemoryText(questionKey).toLowerCase();
  const a = normalizeMemoryText(answer);
  const aLower = a.toLowerCase();
  if (!a) return false;
  if (MEMORY_ANSWER_BLACKLIST_PATTERNS.some(p => p.test(a))) return false;
  if (a.length < 8) return false;
  if (a.length > 500) return false;
  if (/^yes$|^no$/i.test(a)) return false;
  if (/^\d+$/.test(a)) return false;
  if (aLower === q) return false;
  if (aLower.includes('undefined') || aLower.includes('[object object]')) return false;
  if (/(.)\1{6,}/.test(a)) return false;

  const type = String(field?.type || field?.tag || '').toLowerCase();
  if (['radio', 'select', 'checkbox_group', 'checkbox-group', 'consent_checkbox_group', 'number', 'date'].includes(type)) {
    return false;
  }

  if (/^\b(yes|no)\b[.,!\s-]/i.test(a)) return false;
  if (/position|company|role|team/.test(q) && /this company|this role|your company|the position/i.test(aLower)) return false;
  if (/\b(why|motivation|interested|cover letter|fit)\b/.test(q)) return false;
  if (/\b(today|current date|availability|salary|compensation|start date|commute|background check|reference check)\b/.test(q)) return false;

  const wordCount = a.split(/\s+/).filter(Boolean).length;
  if (wordCount < 3) return false;

  return true;
}

function sanitizeMemoryStore(store = {}) {
  const cleaned = {};
  for (const [key, value] of Object.entries(store)) {
    const questionKey = normalizeMemoryText(key).toLowerCase().slice(0, 120);
    const answer = normalizeMemoryText(value?.answer || '');
    if (!questionKey) continue;
    if (isGenericQuestionKey(questionKey)) continue;
    if (!shouldCacheToMemory(questionKey)) continue;
    if (!shouldCacheAnswer(questionKey, answer)) continue;
    cleaned[questionKey] = {
      answer,
      source: value?.source || 'ai',
      ts: Number(value?.ts || Date.now()),
    };
  }
  return cleaned;
}

// ── URL helpers ───────────────────────────────────────────────────────────────

function normalizeBaseUrl(url) {
  let base = (url || DEFAULT_OLLAMA_BASE).trim();
  if (!base) base = DEFAULT_OLLAMA_BASE;
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
  base = base.replace(/\/+$/, '');
  base = base.replace(/\/v1\/chat\/completions$/i, '');
  base = base.replace(/\/api\/generate$/i,         '');
  base = base.replace(/\/api\/chat$/i,             '');
  base = base.replace(/\/v1$/i,                    '');
  if (base === 'http://localhost:11434') base = 'http://127.0.0.1:11434';
  return base;
}

const getV1ChatUrl   = b => `${normalizeBaseUrl(b)}/v1/chat/completions`;
const getApiChatUrl  = b => `${normalizeBaseUrl(b)}/api/chat`;
const getGenerateUrl = b => `${normalizeBaseUrl(b)}/api/generate`;
const getTagsUrl     = b => `${normalizeBaseUrl(b)}/api/tags`;

function extractJsonObjectsFromText(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return [];

  const objects = [];
  for (const line of text.split(/\r?\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      objects.push(JSON.parse(trimmed));
    } catch (_) {}
  }

  if (objects.length) return objects;

  try {
    return [JSON.parse(text)];
  } catch (_) {
    return [];
  }
}

async function readOllamaJsonResponse(resp) {
  const rawText = await resp.text();
  const parsedItems = extractJsonObjectsFromText(rawText);
  if (parsedItems.length) return parsedItems[parsedItems.length - 1];
  throw new Error(`Invalid JSON from Ollama: ${rawText.slice(0, 200)}`);
}

// ── Profile loader ────────────────────────────────────────────────────────────

function loadFullProfile() {
  return new Promise((resolve) => {
    const keys = [
      'firstName', 'lastName', 'email', 'phone',
      'city', 'province', 'country', 'postal',
      'headline', 'summary', 'experienceYears', 'skills', 'portfolio', 'linkedin',
      'education', 'workAuth', 'sponsorship', 'salary',
      'pref_remote', 'pref_relocate',
      'ollamaModel', 'ollamaUrl', 'experience',
    ];
    chrome.storage.local.get(keys, (data) => {
      if (data.experience && !data.experienceYears)
        data.experienceYears = data.experience;

      let skills = [];
      try {
        const raw = data.skills;
        if (Array.isArray(raw)) skills = raw;
        else if (typeof raw === 'string' && raw.trim().startsWith('[')) skills = JSON.parse(raw);
        else if (typeof raw === 'string' && raw.trim()) skills = raw.split(',').map(s => s.trim()).filter(Boolean);
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
        linkedin:        data.linkedin        || '',
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

// ── Session cache ─────────────────────────────────────────────────────────────

const _sessionCache = new Map();
let _memoryCache    = null;

async function getMemoryCache() {
  if (_memoryCache !== null) return _memoryCache;
  _memoryCache = await new Promise(resolve =>
    chrome.storage.local.get(['qf_memory'], d => {
      const original = d.qf_memory || {};
      const cleaned = sanitizeMemoryStore(original);
      if (JSON.stringify(original) !== JSON.stringify(cleaned)) {
        chrome.storage.local.set({ qf_memory: cleaned }).catch?.(() => {});
      }
      resolve(cleaned);
    })
  );
  return _memoryCache;
}

function invalidateMemoryCache() { _memoryCache = null; }

// KEY FIX: never cache failures — this was root cause of infinite loop on SPAs
function trySetSessionCache(key, answer, source) {
  if (!answer || answer === '__SKIP__') return;
  if (!source) return;
  const src = source.toLowerCase();
  if (['error', 'timeout', 'network_error', 'skipped'].includes(src)) return;
  if (normalizeMemoryText(answer).length > 500) return;
  _sessionCache.set(key, { answer, source });
}

function getFieldCacheKey(field) {
  return JSON.stringify({
    label:       (field.label       || '').trim().toLowerCase(),
    name:        (field.name        || '').trim().toLowerCase(),
    placeholder: (field.placeholder || '').trim().toLowerCase(),
    type:        (field.type        || '').trim().toLowerCase(),
    options:     (field.options     || []).map(x => x.trim().toLowerCase()).sort(),
    url:         (field._pageUrl    || '').slice(0, 60),
  });
}

function isGenericQuestionKey(text) {
  const key = String(text || '').trim().toLowerCase();
  if (!key) return true;
  return (
    /^q_[a-f0-9]{8,}$/i.test(key) ||
    key === 'yes/no question' ||
    key === 'select one option' ||
    key === 'unknown field'
  );
}

function isGenericFieldForAi(field) {
  const label = String(field?.label || field?.name || field?.placeholder || '').trim().toLowerCase();
  if (!label) return true;
  return /^q_[a-f0-9]{8,}$/i.test(label) || label === 'unknown field' || label === 'select one option';
}

let _ollamaKnownOnline = false;

async function cachedPingOllama(profile) {
  if (_ollamaKnownOnline) return true;
  const ok = await quickPingOllama(profile).catch(() => false);
  _ollamaKnownOnline = ok;
  return ok;
}

// ── Salary field guard ────────────────────────────────────────────────────────

function isSalaryField(field) {
  const text = [field.label || '', field.name || '', field.placeholder || ''].join(' ');
  return /salary|compensation|ctc|wage|remuneration|\bpay\b/i.test(text);
}

// ── Error classifiers ─────────────────────────────────────────────────────────

function isTimeoutError(e) {
  return e.name === 'TimeoutError' || e.name === 'AbortError' || /timeout|aborted/i.test(e.message || '');
}

function isNetworkError(e) {
  const msg = String(e?.message || e || '').toLowerCase();
  return /failed to fetch|networkerror|network request failed|econnrefused|offline|load failed/.test(msg);
}

// ── Debug session logger ──────────────────────────────────────────────────────

const SESSION_MAX = 3;
let _activeDbSession = null;

function _dbSiteFromUrl(url) {
  try { return new URL(url || '').hostname || 'unknown'; }
  catch (_) { return 'unknown'; }
}

function _dbLevel(text) {
  if (!text) return 'info';
  if (text.startsWith('✗') || text.startsWith('🛑')) return 'error';
  if (text.startsWith('⚠')) return 'warn';
  return 'info';
}

async function _dbPersist(session) {
  const d = await new Promise(r => chrome.storage.local.get(['fp_sessions'], r));
  const all = d.fp_sessions || {};
  all[session.id] = session;
  const trimmed = Object.fromEntries(
    Object.entries(all)
      .sort(([, a], [, b]) => (b.startTime || 0) - (a.startTime || 0))
      .slice(0, SESSION_MAX)
  );
  chrome.storage.local.set({ fp_sessions: trimmed }).catch?.(() => {});
}

function _dbTrackProgress(state, siteUrl) {
  if (!state) return;
  const { status, step = 0, filled = 0, log = [], startedAt } = state;

  if (status === 'running' && step === 0 && !_activeDbSession) {
    _activeDbSession = {
      id:        `fp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      site:      _dbSiteFromUrl(siteUrl),
      startTime: startedAt || Date.now(),
      endTime:   null,
      status:    'running',
      filled:    0,
      steps:     0,
      log:       [],
      hasErrors: false,
    };
  }

  if (!_activeDbSession) return;

  _activeDbSession.log       = log;
  _activeDbSession.filled    = filled;
  _activeDbSession.steps     = step;
  _activeDbSession.status    = status;
  _activeDbSession.hasErrors = log.some(t => _dbLevel(t) === 'error');

  if (status === 'done' || status === 'error' || status === 'stopped') {
    _activeDbSession.endTime = Date.now();
    _dbPersist({ ..._activeDbSession });
    _activeDbSession = null;
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(profile, jobContext) {
  const today = new Date();
  const mainCountry = profile.country || 'Canada';
  const mainCountryLower = String(mainCountry || '').trim().toLowerCase();
  const canadaAuthLines = mainCountryLower === 'canada'
    ? [
        'The answer to any work authorization question for Canada is YES. Do not deviate from this regardless of how the question is phrased.',
        'The answer to any sponsorship or visa question for Canada is NO. Do not deviate from this regardless of how the question is phrased.',
      ]
    : [];

  function nextWeekdays(n) {
    const slots = [];
    const d = new Date(today);
    while (slots.length < n) {
      d.setDate(d.getDate() + 1);
      if (d.getDay() !== 0 && d.getDay() !== 6) {
        const y  = d.getFullYear();
        const mo = String(d.getMonth() + 1).padStart(2, '0');
        const dy = String(d.getDate()).padStart(2, '0');
        slots.push(`${y}-${mo}-${dy} 09:00–17:00`);
      }
    }
    return slots;
  }

  const skillList = Array.isArray(profile.skills) && profile.skills.length
    ? profile.skills.join(', ') : 'not specified';

  const profileBlock = [
    `Name: ${profile.firstName} ${profile.lastName}`.trim(),
    `Email: ${profile.email || 'not set'}`,
    `Phone: ${profile.phone || 'not set'}`,
    `City: ${profile.city || 'not set'}`,
    `Province: ${profile.province || 'not set'}`,
    `Country: ${profile.country || 'Canada'}`,
    `Postal: ${profile.postal || 'not set'}`,
    `Job Title: ${profile.headline || 'not set'}`,
    `Summary: ${profile.summary || 'not set'}`,
    `Education: ${profile.education || 'not set'}`,
    `Years of experience: ${profile.experienceYears || '0'}`,
    `Skills: ${skillList}`,
    `Expected salary: ${profile.salary || 'negotiable'}`,
    `Portfolio: ${profile.portfolio || 'not set'}`,
    `Main authorization country: ${mainCountry}`,
    `Authorized to work in ${mainCountry} without sponsorship: ${profile.workAuth !== false ? 'YES' : 'NO'}`,
    `Requires visa sponsorship in ${mainCountry}: ${profile.sponsorship === true ? 'YES' : 'NO'}`,
    `Open to remote: ${profile.preferences?.remote !== false ? 'YES' : 'NO'}`,
    `Open to relocate: ${profile.preferences?.relocate !== false ? 'YES' : 'NO'}`,
  ].join('\n');

  const jobBlock = jobContext
    ? `\nJOB CONTEXT (use for motivation/fit/why-interested questions):\n${jobContext.slice(0, 1500)}\n`
    : '';

  const interviewSlots = nextWeekdays(3).join('\n');

  return `You are filling a job application form. You will receive a JSON array of form fields and must return a JSON array of answers in the exact same order and length.

APPLICANT PROFILE:
${profileBlock}
${jobBlock}
OUTPUT RULES — strictly follow:
- Return ONLY a valid JSON array of strings. No explanation, no markdown, no extra text.
- Array length must exactly match the number of input fields.
- Each element is the answer string for that field at the same index.
- Use "__SKIP__" only if a field is truly impossible to answer (e.g. file upload, signature).
${canadaAuthLines.map(line => `- ${line}`).join('\n')}

HOW TO ANSWER EACH FIELD TYPE:
- radio/select WITH options listed → return the EXACT text of the best matching option. Do not paraphrase.
- checkbox_group → comma-separated exact option labels that apply
- number → digits only, no units, no currency symbols
- text/textarea → concise, factual, 1-3 sentences, under 150 chars
- date → YYYY-MM-DD format

QUESTION ANSWERING LOGIC:
- Authorized to work in ${mainCountry}: ${profile.workAuth !== false ? 'YES' : 'NO'} | Needs sponsorship in ${mainCountry}: ${profile.sponsorship === true ? 'YES' : 'NO'} | Authorized to work in any other country besides ${mainCountry} (e.g. US): No
- If asked language proficiency, only answer that proficiency in "English", if asked French → "No" | if askedDEI/gender/ethnicity/disability/veteran → "Prefer not to disclose" |  If asked Previously employed/currently employed at this company/referred by employee/ relatives → Always answer No | If asked; whether you need any accomodation for interview or job → "No, I do not require any accommodations", if asked whtether you have any disability → "No"
- Salary / annual salary target / compensation → ${profile.salary || 'negotiable'}
-- Background check / drug test / any screening → fully consents, no restrictions | If asked "do you have any restrictions" → No
- Travel/relocation/hours/shifts/weekends/commute/overtime/night shifts → agrees and will comply | Driver's license → Yes | How did you hear about this role -> "Indeed""
- Today's date / current date → ${today.toISOString().slice(0, 10)}
- Interview availability → use these slots:
${interviewSlots}


You are this applicant's twin mind, embedded in their job application assistant. It's chrome extension that user uses to fill the application forms in their job applications. They want this job, thats why they are applying, they think they are a good fit — fill every field honestly, first-person, confidently, based on their profile and job context.
- Adjacent or learnable skills → Yes | Scenarios/projects → draw from experience naturally
- Never invent jobs, titles, or academic certifications
- "Anything else" → "No" or brief selling point, never __SKIP__
- __SKIP__ only if beyond AI's ability to answer based on profile + job context (e.g. file upload, signature, captcha, extremely vague question with no clues)
- Answer, Best to the ability, you know what the question is, what are the options, everything is given to you.
`;

}

function buildProfilePitch(profile) {
  const parts = [
    clean(profile.summary || ''),
    clean(profile.headline || ''),
    clean(profile.education || ''),
  ].filter(Boolean);

  const skills = Array.isArray(profile.skills)
    ? profile.skills.filter(Boolean).slice(0, 5).join(', ')
    : String(profile.skills || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 5).join(', ');

  if (skills) parts.push(`My relevant strengths include ${skills}.`);

  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 320);
  return 'I bring a strong technical foundation, clear communication, and a reliable approach to learning quickly and contributing wherever needed.';
}

function buildRequiredTextFallback(field, profile, jobContext = '') {
  const type = (field?.type || field?.tag || '').toLowerCase();
  if (!(field?.required) || !['text', 'textarea', 'email', 'tel', 'url'].includes(type)) return null;

  const label = clean([field?.label, field?.name, field?.placeholder].filter(Boolean).join(' ')).toLowerCase();
  const pitch = buildProfilePitch(profile);
  const jobHint = clean(String(jobContext || '').split(/\n+/).slice(0, 2).join(' ')).slice(0, 180);

  if (/productive week|outreach|business development|prospecting|pipeline|follow-?up|booking/i.test(label)) {
    return 'A productive week of outreach means staying consistent with research, personalized messages, follow-ups, and CRM updates while focusing on quality conversations and booked meetings. I work best when activity is organized, measurable, and adjusted based on what is getting responses.';
  }

  if (/experience|background|tell us about|describe|explain|about you/i.test(label)) {
    return `${pitch} I draw on coursework, projects, certifications, and hands-on problem solving, and I’m comfortable turning technical knowledge into clear communication and dependable execution.`.slice(0, 430);
  }

  if (/why|interest|motivation|applying|fit/i.test(label)) {
    const tail = jobHint ? ` What stands out to me is ${jobHint.toLowerCase()}.` : '';
    return `${pitch}${tail} I’m interested in opportunities where I can contribute, keep learning, and add value through strong communication and follow-through.`.slice(0, 430);
  }

  return `${pitch} I approach new responsibilities with curiosity, consistency, and a willingness to learn quickly while contributing wherever I can add value.`.slice(0, 430);
}

// ── Batch AI caller ───────────────────────────────────────────────────────────

/**
 * Send ALL ai-needed fields to Ollama in ONE prompt.
 * Returns string[] of answers in same order as fields input.
 */
async function askOllamaBatch(fields, profile, jobContext) {
  const systemPrompt = buildSystemPrompt(profile, jobContext);
  const model = profile.ollamaModel || DEFAULT_OLLAMA_MODEL;
  const url   = profile.ollamaUrl   || DEFAULT_OLLAMA_BASE;

  // Build clean descriptors — only what AI needs
  const descriptors = fields.map((f, i) => {
    const d = {
      index:    i,
      question: f.label || f.name || f.placeholder || `Field ${i}`,
      type:     f.type  || f.tag  || 'text',
    };
    if (f.answerMode) d.answerMode = f.answerMode;
    if (f.options && f.options.length) d.options = f.options.slice(0, 20);
    if (f.required) d.required = true;
    if (f.section)  d.section  = f.section;
    return d;
  });

  const userMsg =
    `Fill these ${fields.length} form fields for a job application.\n` +
    `Return a JSON array of exactly ${fields.length} strings, one answer per field, in order.\n\n` +
    `FIELDS:\n${JSON.stringify(descriptors, null, 2)}\n\n` +
    `Return ONLY the JSON array. Example: ["answer1", "answer2", "Yes", "0"]`;

  const { signal, cleanup } = createAiRequestController(AI_TIMEOUT_MS);

  try {
    let rawText = null;
    let lastError = null;
    const attemptErrors = [];

    const endpointAttempts = [
      {
        label: 'v1/chat/completions',
        url: getV1ChatUrl(url),
        buildBody: () => ({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMsg },
          ],
          stream: false,
          temperature: 0.1,
          format: 'json',
        }),
        readText: data => data?.choices?.[0]?.message?.content || '',
      },
      {
        label: 'api/chat',
        url: getApiChatUrl(url),
        buildBody: () => ({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMsg },
          ],
          stream: false,
          format: 'json',
          options: { temperature: 0.1 },
        }),
        readText: data => data?.message?.content || '',
      },
      {
        label: 'api/generate',
        url: getGenerateUrl(url),
        buildBody: () => ({
          model,
          prompt: `${systemPrompt}\n\n${userMsg}\n\nJSON array only:`,
          stream: false,
          format: 'json',
          options: { temperature: 0.1 },
        }),
        readText: data => data?.response || '',
      },
    ];

    for (const attempt of endpointAttempts) {
      try {
        const resp = await fetch(attempt.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(attempt.buildBody()),
          signal,
        });

        if (!resp.ok) {
          throw new Error(`${attempt.label} HTTP ${resp.status}`);
        }

        const data = await resp.json();
        rawText = attempt.readText(data);
        if (rawText) break;
        throw new Error(`${attempt.label} returned empty content`);
      } catch (e) {
        lastError = e;
        attemptErrors.push(`${attempt.label}: ${e?.message || e}`);
        console.warn(`[QuickFill BG] batch ${attempt.label} failed:`, e?.message || e);
      }
    }

    if (!rawText) {
      const summary = attemptErrors.length
        ? `No supported AI endpoint returned a response (${attemptErrors.join(' | ')})`
        : 'No supported AI endpoint returned a response';
      throw new Error(summary);
    }

    return parseBatchResponse(rawText, fields.length, fields, profile);

  } finally {
    cleanup();
  }
}

/**
 * Parse JSON array from Ollama batch response.
 * Handles markdown fences, extra prose, partial output.
 */
function parseBatchResponse(raw, expectedCount, fields, profile) {
  if (!raw) throw new Error('Empty batch response from Ollama');

  // Strip markdown
  let text = raw.replace(/```json/gi, '').replace(/```/g, '').trim();

  // Find outermost JSON array
  const start = text.indexOf('[');
  const end   = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`No JSON array in batch response. Got: ${text.slice(0, 200)}`);
  }

  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('Batch response parsed but is not an array');

  // Normalise to exactly expectedCount entries
  const answers = [];
  for (let i = 0; i < expectedCount; i++) {
    const raw = parsed[i];
    if (raw == null || raw === '') {
      answers.push(buildRequiredTextFallback(fields[i] || {}, profile) || '__SKIP__');
    } else {
      const field = fields[i] || {};
      const cleaned = cleanAnswer(String(raw).trim(), field, profile);
      if (isGenericFieldForAi(field) && cleaned !== '__SKIP__' && !(field.options && field.options.length)) {
        answers.push('__SKIP__');
        continue;
      }
      answers.push(cleaned === '__SKIP__' ? (buildRequiredTextFallback(fields[i] || {}, profile) || '__SKIP__') : cleaned);
    }
  }
  return answers;
}

// ── Ollama ping helpers ───────────────────────────────────────────────────────

async function quickPingOllama(profile) {
  const controller = new AbortController();
  const timer = setTimeout(() => { try { controller.abort(); } catch (_) {} }, 5000);
  try {
    const r = await fetch(getTagsUrl(profile.ollamaUrl || DEFAULT_OLLAMA_BASE), { signal: controller.signal });
    return r.ok;
  } catch (_) { return false; }
  finally { clearTimeout(timer); }
}

async function probeEndpoint(url, signal) {
  try {
    const r = await fetch(url, { method: 'OPTIONS', signal });
    return r.status !== 404;
  } catch (_) {
    return false;
  }
}

async function detectGenerationEndpointSupport(baseUrl, signal) {
  const [v1, apiChat, apiGenerate] = await Promise.all([
    probeEndpoint(getV1ChatUrl(baseUrl), signal),
    probeEndpoint(getApiChatUrl(baseUrl), signal),
    probeEndpoint(getGenerateUrl(baseUrl), signal),
  ]);
  return {
    v1,
    apiChat,
    apiGenerate,
    any: v1 || apiChat || apiGenerate,
  };
}

async function pingOllama(baseUrl, selectedModel = '') {
  const controller = new AbortController();
  const timer = setTimeout(() => { try { controller.abort(); } catch (_) {} }, 5000);
  try {
    const r = await fetch(getTagsUrl(baseUrl), { signal: controller.signal });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const data   = await r.json();
    const models = (data.models || []).map(m => m.name);
    const endpointSupport = await detectGenerationEndpointSupport(baseUrl, controller.signal);
    const normalizedSelectedModel = String(selectedModel || '').trim();
    const modelConfigured = !!normalizedSelectedModel;
    const modelAvailable = !modelConfigured || models.includes(normalizedSelectedModel);
    _ollamaKnownOnline = true;
    return {
      ok: true,
      models,
      selectedModel: normalizedSelectedModel,
      modelConfigured,
      modelAvailable,
      endpointSupport,
      warning: !endpointSupport.any
        ? 'Connected URL responds to /api/tags but not to any generation endpoint'
        : (!modelAvailable ? `Selected model "${normalizedSelectedModel}" is not available at this Ollama URL` : ''),
    };
  } catch (e) {
    _ollamaKnownOnline = false;
    return { ok: false, error: e?.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// ── Main answer generator ─────────────────────────────────────────────────────

async function generateAnswers(fields, profile, basicMode) {
  const persistentMemory = await getMemoryCache();

  // ── Phase 1: classify — what can we answer without AI? ──────────────────
  const classified = fields.map(field => {
    const fieldType = (field.type || field.tag || '').toLowerCase();
    const isChoiceField = ['radio', 'checkbox', 'checkbox_group', 'checkbox-group', 'aria-radio'].includes(fieldType);
    const answerMode = getAnswerMode(field);

    // Skip text/select with existing typed value — but NOT radios/checkboxes
    // (page may have pre-selected the wrong option)
    if (!isChoiceField && field.currentValue && field.currentValue.trim()) {
      return { field, answer: '__SKIP__', source: 'skipped', needsAi: false, answerMode };
    }

    const questionKey = (field.label || field.name || '').trim().toLowerCase().slice(0, 120);

    const hardRule = resolveHardRules(field, profile);
    if (hardRule !== null && hardRule.answer) {
      return { field, answer: hardRule.answer, source: hardRule.source, needsAi: false, answerMode };
    }

    const profileBound = resolveProfileBoundField(field, profile);
    if (profileBound !== null && profileBound.answer) {
      return { field, answer: profileBound.answer, source: profileBound.source, needsAi: false, answerMode };
    }

    const helpfulDefault = resolveHelpfulDefaultField(field, profile);
    if (helpfulDefault !== null && helpfulDefault.answer) {
      return { field, answer: helpfulDefault.answer, source: helpfulDefault.source, needsAi: false, answerMode };
    }

    // Scalar fallback only after shape-first routing has declined to answer.
    if (answerMode === 'scalar' && !isSalaryField(field) && isNumericExperienceField(field)) {
      return { field, answer: estimateExperienceYears(field, profile), source: 'rule', needsAi: false, answerMode };
    }

    // Persistent memory check after deterministic rules.
    if (!isGenericQuestionKey(questionKey) && persistentMemory[questionKey]) {
      const m = persistentMemory[questionKey];
      const MAX_MEMORY_AGE_MS = 7 * 24 * 60 * 60 * 1000;
      if ((Date.now() - (m.ts || 0)) < MAX_MEMORY_AGE_MS) {
        return { field, answer: m.answer, source: m.source + '+memory', needsAi: false, answerMode };
      }
      delete persistentMemory[questionKey];
    }

    // Session cache — safe: we never store failures here
    const cacheKey = getFieldCacheKey(field);
    if (_sessionCache.has(cacheKey)) {
      const c = _sessionCache.get(cacheKey);
      return { field, answer: c.answer, source: c.source, needsAi: false, answerMode };
    }

    return { field, answer: null, source: null, needsAi: true, answerMode };
  });

  // Cache profile/rule answers
  for (const c of classified) {
    if (!c.needsAi && c.answer && c.answer !== '__SKIP__') {
      trySetSessionCache(getFieldCacheKey(c.field), c.answer, c.source);
    }
  }

  const aiFields = classified.filter(c => c.needsAi);

  // Nothing needs AI
  if (!aiFields.length || basicMode) {
    if (basicMode) aiFields.forEach(c => { c.answer = '__SKIP__'; c.source = 'skipped'; });
    return classified.map(c => ({
      ...c.field, answer: c.answer || '__SKIP__', source: c.source || 'skipped',
    }));
  }

  // ── Phase 2: Ollama online check ─────────────────────────────────────────
  const ollamaOnline = await cachedPingOllama(profile);
  if (!ollamaOnline) {
    _ollamaKnownOnline = false;
    aiFields.forEach(c => { c.answer = '__SKIP__'; c.source = 'skipped'; });
    chrome.storage.local.set({ ollamaWentOffline: true }).catch?.(() => {});
    return classified.map(c => ({
      ...c.field, answer: c.answer || '__SKIP__', source: c.source || 'skipped',
    }));
  }

  // ── Phase 3: ONE batch prompt for all AI fields ──────────────────────────
  const jobContext = aiFields.find(c => c.field._jobContext)?.field._jobContext || '';

  // Strip internal/DOM-ref fields before sending to AI
  const cleanFields = aiFields.map(c => {
    const { _indeedOptions, _ariaOptions, _pageUrl, _jobContext, _originalType, ...rest } = c.field;
    return rest;
  });

  try {
    const batchAnswers = await askOllamaBatch(cleanFields, profile, jobContext);

    for (let i = 0; i < aiFields.length; i++) {
      const answer = batchAnswers[i] || buildRequiredTextFallback(aiFields[i].field, profile, jobContext) || '__SKIP__';
      aiFields[i].answer = answer;
      aiFields[i].source = (answer === '__SKIP__') ? 'skipped' : 'ai';
      if (answer && answer !== '__SKIP__') {
        trySetSessionCache(getFieldCacheKey(aiFields[i].field), answer, 'ai');
      }
    }

    // Persist to memory
    let memUpdated = false;
    for (const item of aiFields) {
      if (item.source === 'ai' && item.answer && item.answer !== '__SKIP__') {
        const key = (item.field.label || item.field.name || '').trim().toLowerCase().slice(0, 120);
        if (
          key &&
          !isGenericQuestionKey(key) &&
          shouldCacheToMemory(key) &&
          shouldCacheAnswer(key, item.answer, item.field)
        ) {
          persistentMemory[key] = {
            answer: normalizeMemoryText(item.answer),
            source: 'ai',
            ts: Date.now(),
          };
          memUpdated = true;
        }
      }
    }
    if (memUpdated) chrome.storage.local.set({ qf_memory: sanitizeMemoryStore(persistentMemory) }).catch?.(() => {});

  } catch (e) {
    console.error('[QuickFill BG] Batch AI error:', e?.message || e);
    const isNet  = isNetworkError(e);
    const isTime = isTimeoutError(e);

    if (isNet) {
      _ollamaKnownOnline = false;
      chrome.storage.local.set({ ollamaWentOffline: true }).catch?.(() => {});
    }

    for (const item of aiFields) {
      item.answer = (!isSalaryField(item.field) && isNumericExperienceField(item.field))
        ? estimateExperienceYears(item.field, profile)
        : (buildRequiredTextFallback(item.field, profile, jobContext) || '__SKIP__');
      item.source = isTime ? 'timeout' : isNet ? 'network_error' : 'error';
    }
  }

  // ── Assemble final ordered result ────────────────────────────────────────
  const aiMap = new Map(aiFields.map(c => [c.field, c]));
  return classified.map(c => {
    const resolved = c.needsAi ? (aiMap.get(c.field) || c) : c;
    return { ...resolved.field, answer: resolved.answer || '__SKIP__', source: resolved.source || 'skipped' };
  });
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.action === 'REPORT_FLOW_PROGRESS') {
    _dbTrackProgress(msg.state, sender.tab?.url || '');
    chrome.storage.local.set({ flowState: msg.state }, () => {
      chrome.runtime.sendMessage({ action: 'FLOW_STATE_UPDATED', state: msg.state }, () => {
        void chrome.runtime.lastError;
      });
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

  if (msg.action === 'PING_OLLAMA') {
    (async () => {
      try {
        const cfg = await new Promise(resolve => chrome.storage.local.get(['ollamaUrl', 'ollamaModel'], resolve));
        const result = await pingOllama(
          normalizeBaseUrl(cfg.ollamaUrl || DEFAULT_OLLAMA_BASE),
          String(cfg.ollamaModel || DEFAULT_OLLAMA_MODEL).trim() || DEFAULT_OLLAMA_MODEL
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

        // Debug session tracking
        if (_activeDbSession) {
          if (!_activeDbSession.profileSnapshot) {
            const _fn = (profile.firstName || '').trim();
            const _ln = (profile.lastName  || '').trim();
            const _snapshotName = _fn && _ln && !_fn.endsWith(_ln) ? `${_fn} ${_ln}` : _fn || _ln;
            const _locParts = [profile.city, profile.province, profile.country]
              .map(s => (s || '').trim()).filter(Boolean)
              .filter((v, i, arr) => arr.indexOf(v) === i);
            _activeDbSession.profileSnapshot = {
              name:            _snapshotName,
              email:           profile.email,
              phone:           profile.phone,
              location:        _locParts.join(', '),
              headline:        profile.headline,
              experienceYears: profile.experienceYears,
              workAuth:        profile.workAuth,
              sponsorship:     profile.sponsorship,
              salary:          profile.salary,
              skills:          Array.isArray(profile.skills) ? profile.skills.slice(0, 12).join(', ') : '',
            };
          }
          if (!_activeDbSession.fieldEntries) _activeDbSession.fieldEntries = [];
          const stepNum = _activeDbSession.steps || 0;
          for (let i = 0; i < fields.length; i++) {
            const f = fields[i] || {};
            const a = answers[i] || {};
            const optList = (f.options || [])
              .slice(0, 8)
              .map(o => typeof o === 'string' ? o : (o.label || o.value || ''))
              .filter(Boolean);
            _activeDbSession.fieldEntries.push({
              step:    stepNum,
              label:   String(f.label || f.name || '').slice(0, 120),
              type:    String(f.type || ''),
              options: optList,
              answer:  String(a.answer || '__SKIP__').slice(0, 200),
              source:  String(a.source || 'skipped'),
            });
          }
        }

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
        const profile = await loadFullProfile();
        const field   = msg.field || {};

        // Try direct profile resolution first
        const directRetry = resolveDirectField(field, profile);
        if (directRetry?.answer) {
          sendResponse({ ok: true, answer: directRetry.answer });
          return;
        }

        // Use batch infrastructure for single-field retry
        const batchAnswers = await askOllamaBatch([field], profile, '').catch(() => null);
        const answer = batchAnswers?.[0] || '__SKIP__';
        sendResponse({ ok: true, answer });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.action === 'GET_SESSIONS') {
    chrome.storage.local.get(['fp_sessions'], data => {
      const sessions = Object.values(data.fp_sessions || {})
        .sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
      sendResponse({ ok: true, sessions });
    });
    return true;
  }

  if (msg.action === 'CLEAR_SESSIONS') {
    chrome.storage.local.remove(['fp_sessions'], () => {
      _activeDbSession = null;
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'OLLAMA_GENERATE') {
    (async () => {
      try {
        const { url, model, systemPrompt, userMsg } = msg.payload;
        const endpointAttempts = [
          {
            label: 'v1/chat/completions',
            url: getV1ChatUrl(url),
            buildBody: () => ({
              model,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMsg },
              ],
              stream: false,
              temperature: 0.1,
              format: 'json',
            }),
            readText: data => data?.choices?.[0]?.message?.content || '',
          },
          {
            label: 'api/chat',
            url: getApiChatUrl(url),
            buildBody: () => ({
              model,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMsg },
              ],
              stream: false,
              format: 'json',
              options: { temperature: 0.1 },
            }),
            readText: data => data?.message?.content || '',
          },
          {
            label: 'api/generate',
            url: getGenerateUrl(url),
            buildBody: () => ({
              model,
              prompt: `${systemPrompt}\n\n${userMsg}\n\nReturn only JSON.`,
              stream: false,
              format: 'json',
              options: { temperature: 0.1 },
            }),
            readText: data => data?.response || '',
          },
        ];

        const attemptErrors = [];
        for (const attempt of endpointAttempts) {
          try {
            const res = await fetch(attempt.url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(attempt.buildBody()),
            });

            if (!res.ok) {
              const errorText = await res.text();
              throw new Error(`${attempt.label} HTTP ${res.status} ${errorText}`.trim());
            }

            const data = await readOllamaJsonResponse(res);
            const extractedText = String(attempt.readText(data) || '').trim();
            if (!extractedText) {
              throw new Error(`${attempt.label} returned empty content`);
            }

            sendResponse({ ok: true, text: extractedText });
            return;
          } catch (e) {
            attemptErrors.push(`${attempt.label}: ${e?.message || e}`);
            console.warn('[QuickFill BG] resume extraction attempt failed:', attempt.label, e?.message || e);
          }
        }

        throw new Error(
          attemptErrors.length
            ? `No supported AI endpoint returned valid resume JSON (${attemptErrors.join(' | ')})`
            : 'No supported AI endpoint returned valid resume JSON'
        );
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true;
  }

});

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

importScripts('rules.js', 'core/aiJson.js');

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

async function readOllamaJsonResponse(resp) {
  const rawText = await resp.text();
  try {
    const parsedItems = AiJson.parseJsonObjectSequence(rawText).parsedItems || [];
    if (parsedItems.length) {
      return parsedItems[parsedItems.length - 1];
    }
    throw new Error('No JSON object found in Ollama response body');
  } catch (error) {
    console.error('[QuickFill BG] Failed to parse structured Ollama response', {
      rawResponse: error?.rawResponse || rawText,
      cleanedResponse: error?.cleanedResponse || '',
      jsonText: error?.jsonText || '',
      error: error?.message || String(error),
    });
    throw new Error(`Invalid JSON from Ollama: ${(error?.rawResponse || rawText).slice(0, 200)}`);
  }
}

// ── Profile loader ────────────────────────────────────────────────────────────

function loadFullProfile() {
  return new Promise((resolve) => {
    const keys = [
      'firstName', 'lastName', 'email', 'phone',
      'city', 'province', 'country', 'postal',
      'headline', 'summary', 'experienceYears', 'skills', 'portfolio', 'linkedin',
      'education', 'educationLevel', 'fieldOfStudy', 'gradYear', 'address', 'workAuth', 'sponsorship', 'salary',
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
        educationLevel:  data.educationLevel  || '',
        fieldOfStudy:    data.fieldOfStudy    || '',
        gradYear:        String(data.gradYear || ''),
        address:         data.address         || '',
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
    `Address: ${profile.address || 'not set'}`,
    `Job Title: ${profile.headline || 'not set'}`,
    `Summary: ${profile.summary || 'not set'}`,
    `Education: ${profile.education || 'not set'}`,
    `Education level: ${profile.educationLevel || 'not set'}`,
    `Field of study: ${profile.fieldOfStudy || 'not set'}`,
    `Graduation year: ${profile.gradYear || 'not set'}`,
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
- text/textarea → concise, factual, max 2-3 short sentences, avoid fluff, ideally under 150 chars
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

function buildSingleFieldPrompt(profile, jobContext = '') {
  return buildSystemPrompt(profile, jobContext) + '\n\nYou are answering exactly one field, not a batch.';
}

function buildSingleFieldUserMessage(field) {
  const { label, options, type } = field || {};

  let msg = `Question: ${label || ''}\n`;
  msg += `Field type: ${type || 'text'}\n`;

  if (options?.length) {
    msg += `Available options: ${options.join(', ')}\n`;
    msg += '\nReturn ONLY the exact text of the best matching option. Nothing else.';
  } else {
    msg += '\nReturn a concise answer in at most 2-3 short sentences, ideally under 150 characters. Nothing else.';
  }

  return msg;
}

function isPageChromeOrReviewPrompt(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) return false;

  const fragments = [
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

  if (fragments.some(fragment => text.includes(fragment))) return true;
  return text.length > 260 && /terms|cookie|privacy|recaptcha|job alert|submit your application|review your application/i.test(text);
}

function isProfileSummaryPrompt(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return (
    /\babout (you|yourself|me)\b/.test(text) ||
    /\bprofessional summary\b/.test(text) ||
    /\bbio\b/.test(text) ||
    /\btell us about (you|yourself)\b/.test(text)
  );
}

function generateSingleFieldFallback(field, profile) {
  const question = String(field?.label || field?.questionText || '').trim();
  const text = question.toLowerCase();
  const headline = String(profile?.headline || 'IT student focused on network administration and security').trim();
  const summary = String(profile?.summary || '').trim();
  const years = String(profile?.experienceYears || '4').trim();
  const skillLead = Array.isArray(profile?.skills) && profile.skills.length
    ? profile.skills.slice(0, 3).join(', ')
    : 'cloud infrastructure, networking, and security';

  if (!question) return '__SKIP__';
  if (isPageChromeOrReviewPrompt(question)) return '__SKIP__';

  if (/push back on a decision|wrong call|how did you handle it/i.test(text)) {
    return `I push back respectfully with evidence, risks, and a clear alternative. In team projects, I explain the tradeoffs early, align on the outcome we need, and then support the final decision once the team agrees on the best path.`;
  }

  if (/what information to share|level of detail|with whom|complex project|specific example/i.test(text)) {
    return `I tailor detail to the audience: blockers, timelines, and decisions for stakeholders, and technical specifics for the team doing the work. On complex projects, I share concise status updates early, flag risks quickly, and give deeper technical context only to the people who need it.`;
  }

  if (/good delivery leadership|delivery leads fall short/i.test(text)) {
    return `Good delivery leadership means clear priorities, honest communication, and steady follow-through. Delivery leads usually fall short when they hide risks too long, overcomplicate status updates, or lose sight of the team’s actual constraints.`;
  }

  if (/learned the hard way|changed your approach|one thing about how you run a delivery/i.test(text)) {
    return `I learned the hard way that assumptions made early can create avoidable rework later. Now I validate scope, owners, and success criteria up front, document decisions clearly, and check for risks early so delivery stays predictable.`;
  }

  if (isDescriptiveTextField(field) && isProfileSummaryPrompt(question)) {
    if (summary) return summary.slice(0, 320);
    return `${headline}. I bring about ${years} years of hands-on experience across ${skillLead}, and I focus on clear communication, reliable execution, and learning quickly.`;
  }

  return '__SKIP__';
}

async function askOllamaSingle(systemPrompt, userMsg, profile, field) {
  const type = field?.type;
  const options = field?.options;
  const model = profile.ollamaModel || DEFAULT_OLLAMA_MODEL;
  const url = profile.ollamaUrl || DEFAULT_OLLAMA_BASE;
  const { signal, cleanup } = createAiRequestController(15_000);

  try {
    let rawText = '';
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
          options: { temperature: 0.1 },
        }),
        readText: data => data?.message?.content || '',
      },
      {
        label: 'api/generate',
        url: getGenerateUrl(url),
        buildBody: () => ({
          model,
          prompt: `${systemPrompt}\n\n${userMsg}\n\nReturn only the answer string:`,
          stream: false,
          options: { temperature: 0.1 },
        }),
        readText: data => data?.response || '',
      },
    ];

    let lastError = null;
    for (const attempt of endpointAttempts) {
      try {
        const resp = await fetch(attempt.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(attempt.buildBody()),
          signal,
        });

        if (!resp.ok) throw new Error(`${attempt.label} HTTP ${resp.status}`);
        const data = await resp.json();
        rawText = String(attempt.readText(data) || '').trim();
        if (rawText) break;
        throw new Error(`${attempt.label} returned empty content`);
      } catch (e) {
        lastError = e;
        console.warn(`[QuickFill BG] single ${attempt.label} failed:`, e?.message || e);
      }
    }

    if (!rawText) {
      const fallback = generateSingleFieldFallback(field, profile);
      if (fallback && fallback !== '__SKIP__') return fallback;
      throw lastError || new Error('No supported AI endpoint returned a response');
    }

    const cleaned = cleanAnswer(
      rawText.replace(/```/g, '').replace(/^"+|"+$/g, '').trim(),
      field || { type, options },
      profile
    );
    if (cleaned && cleaned !== '__SKIP__') return cleaned;

    const fallback = generateSingleFieldFallback(field, profile);
    return fallback || '__SKIP__';
  } finally {
    cleanup();
  }
}

// ── Ollama ping helpers ───────────────────────────────────────────────────────

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
    return { ok: false, error: e?.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'CANCEL_FLOW') {
    for (const controller of [..._activeAiControllers]) {
      try { clearTimeout(controller._timer); controller.abort(new Error('Cancelled by user')); }
      catch (_) { try { controller.abort(); } catch (_) {} }
    }
    _activeAiControllers.clear();
    chrome.storage.local.set({ flowCancelled: true }, () => sendResponse({ ok: true }));
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

  if (msg.action === 'GET_SINGLE_FIELD_ANSWER') {
    (async () => {
      try {
        const profile = await loadFullProfile();
        const { field = {} } = msg;
        const systemPrompt = buildSingleFieldPrompt(profile, field.jobContext || field._jobContext || '');
        const userMsg = buildSingleFieldUserMessage(field);
        const answer = await askOllamaSingle(
          systemPrompt,
          userMsg,
          profile,
          field
        );
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
              prompt: `${systemPrompt}\n\n${userMsg}\n\nReturn JSON only. Do not use markdown. Do not wrap in triple backticks. Do not include explanation text.`,
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

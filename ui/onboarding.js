// QuickFill AI – onboarding.js
// Fast onboarding flow:
//   - resume extraction overlays onto saved profile data
//   - one assistant review screen handles defaults + profile
//   - quick actions let the user keep the AI draft, apply helpful defaults,
//     or save immediately without retyping fields

'use strict';

const $ = id => document.getElementById(id);
const val = id => ($(id)?.value || '').trim();
const setVal = (id, v) => { const el = $(id); if (el) el.value = v || ''; };
const radioVal = name => document.querySelector(`input[name="${name}"]:checked`)?.value || '';
const DEFAULT_OLLAMA_MODEL = 'phi3:mini';

function inferEducationLevel(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (/no diploma|no degree|none/.test(text)) return 'No diploma';
  if (/doctor|phd|doctorate|juris doctor|md\b/.test(text)) return 'Doctorate';
  if (/master|mba\b|m\.sc|ma\b/.test(text)) return "Master's degree";
  if (/bachelor|b\.sc|bsc\b|b\.tech|ba\b|bs\b|undergraduate|university/.test(text)) return "Bachelor's degree";
  if (/associate|dec|dcs/.test(text)) return 'Associate degree / DEC / DCS';
  if (/certificate|diploma|trade|aec|dep/.test(text)) return 'Certificate / Diploma / Trade certificate';
  if (/secondary|high school/.test(text)) return 'Secondary School';
  return '';
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function toast(msg, type = 'ok', ms = 4000) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

function formatCountryLabel(value) {
  const country = String(value || '').trim();
  return country || 'your main country';
}

function updateEligibilityLabels(countryValue) {
  const country = formatCountryLabel(countryValue);
  const workAuthLabel = $('ob-workAuth-label');
  const sponsorshipLabel = $('ob-sponsorship-label');
  if (workAuthLabel) workAuthLabel.innerHTML = `Work authorization in ${country} <span class="safe-tag">never AI</span>`;
  if (sponsorshipLabel) sponsorshipLabel.innerHTML = `Visa sponsorship needed in ${country} <span class="safe-tag">never AI</span>`;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function parseSkillsLocal(raw) {
  try {
    if (Array.isArray(raw)) {
      return raw.map(s => String(s).trim()).filter(Boolean);
    }
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed) return [];
      if (trimmed.startsWith('[')) {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed)
          ? parsed.map(s => String(s).trim()).filter(Boolean)
          : [];
      }
      return trimmed
        .split(/[,\n]+/)
        .map(s => s.trim())
        .filter(Boolean);
    }
  } catch (_) {}
  return [];
}

function uniqueSkills(list) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const skill = String(item || '').trim();
    if (!skill) continue;
    const key = skill.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(skill);
  }
  return out.slice(0, 25);
}

function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') i++;
      if (i < text.length) out += '\n';
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }

    out += ch;
  }

  return out;
}

function stripTrailingJsonCommas(text) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }

    out += ch;
  }

  return out;
}

function normalizeJsonishText(raw) {
  return AiJson.stripMarkdownCodeFences(raw)
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();
}

function coerceJsonScalar(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text === 'null' || text === 'undefined') return '';
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    const quote = text[0];
    const inner = text.slice(1, -1);
    if (quote === '"') {
      try { return JSON.parse(text); } catch (_) {}
    }
    return inner.replace(/\\(["\\/bfnrt])/g, '$1');
  }
  return text.replace(/,$/, '').trim();
}

function extractBalancedBlock(text, startIndex, openChar, closeChar) {
  const src = String(text || '');
  if (startIndex < 0 || startIndex >= src.length || src[startIndex] !== openChar) return '';

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === openChar) {
      depth++;
      continue;
    }
    if (ch === closeChar) {
      depth--;
      if (depth === 0) return src.slice(startIndex, i + 1);
    }
  }

  return '';
}

function extractJsonishValueBlock(text, key) {
  const src = String(text || '');
  const quotedKey = `"${key}"`;
  const keyIdx = src.indexOf(quotedKey);
  if (keyIdx === -1) return '';

  let i = keyIdx + quotedKey.length;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] !== ':') return '';
  i++;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (i >= src.length) return '';

  const start = i;
  const ch = src[i];
  if (ch === '"') {
    let escaped = false;
    for (let j = i + 1; j < src.length; j++) {
      const cur = src[j];
      if (escaped) escaped = false;
      else if (cur === '\\') escaped = true;
      else if (cur === '"') return src.slice(start, j + 1);
    }
    return src.slice(start);
  }
  if (ch === '[') {
    return extractBalancedBlock(src, i, '[', ']') || src.slice(start);
  }
  if (ch === '{') {
    return extractBalancedBlock(src, i, '{', '}') || src.slice(start);
  }

  let inString = false;
  let escaped = false;
  for (let j = i; j < src.length; j++) {
    const cur = src[j];
    if (inString) {
      if (escaped) escaped = false;
      else if (cur === '\\') escaped = true;
      else if (cur === '"') inString = false;
      continue;
    }
    if (cur === '"') {
      inString = true;
      continue;
    }
    if (cur === ',') return src.slice(start, j);
    if (cur === '\n' || cur === '\r') return src.slice(start, j);
    if (cur === '}') return src.slice(start, j);
  }

  return src.slice(start);
}

function parseJsonishStringField(text, key) {
  const block = extractJsonishValueBlock(text, key);
  return coerceJsonScalar(block);
}

function parseJsonishSkillsField(text, key) {
  const block = extractJsonishValueBlock(text, key).trim();
  if (!block) return [];

  if (block.startsWith('[')) {
    const normalized = stripTrailingJsonCommas(stripJsonComments(block));
    try {
      const parsed = JSON.parse(normalized);
      if (Array.isArray(parsed)) return uniqueSkills(parsed);
    } catch (_) {}

    const items = [];
    const matcher = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^,\]\n\r]+)/g;
    let match;
    while ((match = matcher.exec(block))) {
      const rawItem = match[1] ?? match[2] ?? match[3] ?? '';
      const value = coerceJsonScalar(rawItem);
      if (value) items.push(value);
    }
    return uniqueSkills(items);
  }

  return uniqueSkills(parseSkillsLocal(block));
}

function salvageResumeProfileFromText(raw) {
  const text = normalizeJsonishText(raw);
  const fieldNames = [
    'firstName', 'lastName', 'email', 'phone', 'linkedin', 'headline',
    'summary', 'portfolio', 'github', 'education', 'educationLevel', 'fieldOfStudy',
    'gradYear', 'experienceYears', 'city', 'province', 'country',
    'postal', 'address', 'salary',
  ];
  const recovered = {};

  fieldNames.forEach(key => {
    recovered[key] = parseJsonishStringField(text, key);
  });
  recovered.skills = parseJsonishSkillsField(text, 'skills');

  const nonEmptyCount = fieldNames.reduce((count, key) => count + (recovered[key] ? 1 : 0), 0)
    + (recovered.skills.length ? 1 : 0);

  if (!nonEmptyCount) {
    throw new Error('No recoverable resume fields found in AI response');
  }

  return recovered;
}

function parseJsonObjectLenient(raw) {
  const cleaned = normalizeJsonishText(raw);

  try {
    const { jsonText } = AiJson.parseJsonObject(cleaned);
    const normalized = stripTrailingJsonCommas(stripJsonComments(jsonText));
    return JSON.parse(normalized);
  } catch (err) {
    console.error('[QuickFill Onboarding] JSON parse failed for AI resume extraction response', {
      rawResponse: err?.rawResponse || String(raw || ''),
      cleanedResponse: err?.cleanedResponse || cleaned,
      jsonText: err?.jsonText || '',
      error: err?.message || String(err),
    });
    const recovered = salvageResumeProfileFromText(cleaned);
    recovered._parseRecovered = true;
    recovered._parseError = err?.message || String(err);
    return recovered;
  }
}

function normalizeOllamaUrl(url) {
  let v = (url || '').trim();
  if (!v) return 'http://127.0.0.1:11434';
  // FIX: add protocol if missing (was absent in v1)
  if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
  v = v
    .replace(/\/+$/, '')
    .replace(/\/v1$/i, '')
    .replace(/\/api\/generate$/i, '')
    .replace(/\/api\/chat$/i, '')
    .replace(/\/v1\/chat\/completions$/i, '');
  if (v === 'http://localhost:11434') return 'http://127.0.0.1:11434';
  return v;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setRadioValue(name, value) {
  if (!value) return;
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
}

function fillIfEmpty(id, value) {
  if (!value) return false;
  const el = $(id);
  if (!el || String(el.value || '').trim()) return false;
  el.value = value;
  return true;
}

// ── Step navigation ───────────────────────────────────────────────────────────

let currentScreen = 1;

function goToScreen(n) {
  for (let i = 1; i <= 3; i++) {
    const s = $(`screen-${i}`);
    if (s) s.classList.toggle('active', i === n);

    const dot = $(`dot-${i}`);
    const lbl = $(`lbl-${i}`);
    if (dot) {
      dot.classList.remove('active', 'done');
      if (i < n) dot.classList.add('done');
      else if (i === n) dot.classList.add('active');
    }
    if (lbl) lbl.classList.toggle('active', i === n);

    if (i < 3) {
      const line = $(`line-${i}`);
      if (line) line.classList.toggle('done', i < n);
    }
  }
  currentScreen = n;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Skills tag editor ─────────────────────────────────────────────────────────

let _skills = [];

function renderSkills() {
  const wrap = $('skills-wrap');
  const inp  = $('skills-input');
  if (!wrap || !inp) return;

  Array.from(wrap.querySelectorAll('.skill-tag')).forEach(t => t.remove());

  _skills = uniqueSkills(_skills);

  _skills.forEach((skill, idx) => {
    const tag = document.createElement('div');
    tag.className = 'skill-tag';
    tag.innerHTML = `<span>${escapeHtml(skill)}</span><button type="button" data-idx="${idx}">×</button>`;
    tag.querySelector('button')?.addEventListener('click', () => {
      _skills.splice(idx, 1);
      renderSkills();
    });
    wrap.insertBefore(tag, inp);
  });
}

function addSkill(raw) {
  const additions = String(raw || '')
    .split(/[,\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && s.length < 60);

  _skills = uniqueSkills([...(Array.isArray(_skills) ? _skills : []), ...additions]);
  renderSkills();
}

function initSkillsEditor() {
  const wrap = $('skills-wrap');
  const inp  = $('skills-input');
  if (!inp || !wrap) return;

  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const v = inp.value.trim().replace(/,$/, '');
      if (v) {
        addSkill(v);
        inp.value = '';
      }
    } else if (e.key === 'Backspace' && !inp.value && _skills.length) {
      _skills.pop();
      renderSkills();
    }
  });

  inp.addEventListener('blur', () => {
    const v = inp.value.trim().replace(/,$/, '');
    if (v) {
      addSkill(v);
      inp.value = '';
    }
  });

  wrap.addEventListener('click', () => inp.focus());
}

// ── AI suggested banner ───────────────────────────────────────────────────────

/**
 * Show or hide the "AI suggested — please verify" banner on screen 1.
 * @param {boolean} show
 * @param {string[]} filledFields  list of field labels AI populated
 */
function setAiSuggestedBanner(show, filledFields = []) {
  const banner = $('ai-suggested-banner');
  if (!banner) return;

  if (!show || !filledFields.length) {
    banner.style.display = 'none';
    return;
  }

  banner.style.display = 'block';
  const list = $('ai-suggested-list');
  if (list) {
    list.textContent = filledFields.join(', ');
  }
}

// ── Ollama helpers ────────────────────────────────────────────────────────────

async function getOllamaSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(['ollamaUrl', 'ollamaModel'], data => {
      resolve({
        url:   normalizeOllamaUrl(data.ollamaUrl || 'http://127.0.0.1:11434'),
        model: (data.ollamaModel || '').trim() || DEFAULT_OLLAMA_MODEL,
      });
    });
  });
}

// ── AI resume extraction ──────────────────────────────────────────────────────

async function extractProfileFromResume(resumeText) {
  const { url, model } = await getOllamaSettings();

  // EXPANDED: now also extracts location + salary hint so screen 1 can be pre-filled
  const systemPrompt = `You are a resume parser. Extract structured data from the resume text and return ONLY a valid JSON object.
Return JSON only.
Do not use markdown.
Do not wrap in triple backticks.
Do not include explanation text.
Do not include any text outside the JSON.

Return exactly this structure:
{
  "firstName": "string",
  "lastName": "string",
  "email": "string",
  "phone": "string",
  "linkedin": "string — LinkedIn URL or empty string",
  "headline": "string — job title or professional headline",
  "summary": "string — 2-3 sentence professional summary, max 400 chars",
  "skills": ["skill1", "skill2", ...],
  "portfolio": "string — portfolio/website URL or empty string",
  "github": "string — GitHub URL or empty string",
  "education": "string — degree and institution, e.g. Bachelor of Science in Computer Science, MIT (2023)",
  "educationLevel": "string — one of: Doctorate, Master's degree, Bachelor's degree, Associate degree / DEC / DCS, Certificate / Diploma / Trade certificate, Secondary School, No diploma",
  "fieldOfStudy": "string — field/major only, e.g. Computer Science",
  "gradYear": "string — graduation year only, e.g. 2023",
  "experienceYears": "string — numeric string like '4'",
  "city": "string — city of residence or empty string",
  "province": "string — province or state abbreviation or empty string",
  "country": "string — country name or empty string",
  "postal": "string — postal or ZIP code or empty string",
  "address": "string — street address if present or empty string",
  "salary": "string — desired or current salary as a number string if mentioned, else empty string"
}

Rules:
- skills must be an array of strings, each under 50 chars, max 25 skills
- summary max 400 characters
- If a field cannot be determined, use empty string ""
- experienceYears: estimate total professional experience as a number string
- salary: only populate if explicitly stated in the resume, otherwise leave empty
- Never populate workAuth or sponsorship — those are always set by the user`;

  const userMsg = `Resume text:\n${String(resumeText || '').slice(0, 6000)}`;

  const raw = await new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      type: 'OLLAMA_GENERATE',
      payload: { url, model, systemPrompt, userMsg }
    }, (resp) => {
      if (!resp || !resp.ok) reject(new Error(resp?.error || 'Ollama failed'));
      else resolve(resp.text);
    });
  });

  console.log('[QuickFill Onboarding] Raw AI resume extraction response:', raw);

  let parsed;
  try {
    parsed = parseJsonObjectLenient(raw);
  } catch (error) {
    console.error('[QuickFill Onboarding] Failed to parse AI resume extraction response', {
      rawResponse: error?.rawResponse || raw,
      cleanedResponse: error?.cleanedResponse || '',
      jsonText: error?.jsonText || '',
      error: error?.message || String(error),
    });
    throw error;
  }

  return {
    _parseRecovered: !!parsed._parseRecovered,
    // Professional
    firstName:       String(parsed.firstName       || '').trim(),
    lastName:        String(parsed.lastName        || '').trim(),
    email:           String(parsed.email           || '').trim(),
    phone:           String(parsed.phone           || '').trim(),
    linkedin:        String(parsed.linkedin        || '').trim(),
    headline:        String(parsed.headline        || '').trim(),
    summary:         String(parsed.summary         || '').slice(0, 420).trim(),
    skills:          uniqueSkills(parsed.skills),
    portfolio:       String(parsed.portfolio       || '').trim(),
    github:          String(parsed.github          || '').trim(),
    education:       String(parsed.education       || '').trim(),
    educationLevel:  String(parsed.educationLevel  || inferEducationLevel(parsed.education) || '').trim(),
    fieldOfStudy:    String(parsed.fieldOfStudy    || '').trim(),
    gradYear:        String(parsed.gradYear        || '').trim(),
    experienceYears: String(parsed.experienceYears || '').trim(),
    // Location — new in v2.0
    city:            String(parsed.city            || '').trim(),
    province:        String(parsed.province        || '').trim(),
    country:         String(parsed.country         || '').trim(),
    postal:          String(parsed.postal          || '').trim(),
    address:         String(parsed.address         || '').trim(),
    // Compensation — new in v2.0 (only if explicitly in resume)
    salary:          String(parsed.salary          || '').trim(),
  };
}

// ── Pre-fill screen 1 from AI extraction ─────────────────────────────────────

/**
 * Pre-fill screen 1 required fields from AI-extracted data.
 * Returns a list of field labels that were actually populated so the
 * verify banner can tell the user what to check.
 *
 * Safety fields (workAuth, sponsorship) are NEVER touched here.
 *
 * @param {object} extracted
 * @returns {string[]} labels of fields AI populated
 */
function prefillScreen1FromAI(extracted) {
  const filled = [];

  const locationFields = [
    ['ob-city',     extracted.city,     'City'],
    ['ob-province', extracted.province, 'Province'],
    ['ob-country',  extracted.country,  'Country'],
    ['ob-postal',   extracted.postal,   'Postal code'],
    ['ob-address',  extracted.address,  'Street address'],
  ];

  locationFields.forEach(([id, value, label]) => {
    if (value) {
      setVal(id, value);
      filled.push(label);
    }
  });

  // Only pre-fill experience if the field is currently empty or 0
  const expEl = $('ob-experience');
  if (extracted.experienceYears && expEl && (!expEl.value || expEl.value === '0')) {
    setVal('ob-experience', extracted.experienceYears);
    filled.push('Years of experience');
  }

  // Only pre-fill salary if field is empty and AI found it in the resume
  const salaryEl = $('ob-salary');
  if (extracted.salary && salaryEl && !salaryEl.value) {
    setVal('ob-salary', extracted.salary);
    filled.push('Desired salary');
  }

  return filled;
}

// ── Populate / collect screen 2 ───────────────────────────────────────────────

function populateReviewForm(extracted) {
  if (extracted.firstName)      setVal('ob2-firstName', extracted.firstName);
  if (extracted.lastName)       setVal('ob2-lastName', extracted.lastName);
  if (extracted.email)          setVal('ob2-email', extracted.email);
  if (extracted.phone)          setVal('ob2-phone', extracted.phone);
  if (extracted.linkedin)       setVal('ob2-linkedin', extracted.linkedin);
  if (extracted.headline)       setVal('ob2-headline', extracted.headline);
  if (extracted.summary)        setVal('ob2-summary', extracted.summary);
  if (extracted.portfolio)      setVal('ob2-portfolio', extracted.portfolio);
  if (extracted.github)         setVal('ob2-github', extracted.github);
  if (extracted.education)      setVal('ob2-education', extracted.education);
  if (extracted.educationLevel) setVal('ob2-education-level', extracted.educationLevel);
  if (extracted.fieldOfStudy)   setVal('ob2-field-of-study', extracted.fieldOfStudy);
  if (extracted.gradYear)       setVal('ob2-grad-year', extracted.gradYear);

  if (Array.isArray(extracted.skills) && extracted.skills.length) {
    _skills = uniqueSkills([...(Array.isArray(_skills) ? _skills : []), ...extracted.skills]);
  }
  renderSkills();
}

function collectReviewForm() {
  return {
    firstName:    val('ob2-firstName'),
    lastName:     val('ob2-lastName'),
    email:        val('ob2-email'),
    phone:        val('ob2-phone'),
    linkedin:     val('ob2-linkedin'),
    headline:     val('ob2-headline'),
    summary:      val('ob2-summary'),
    portfolio:    val('ob2-portfolio'),
    github:       val('ob2-github'),
    education:    val('ob2-education'),
    educationLevel: val('ob2-education-level') || inferEducationLevel(val('ob2-education')),
    fieldOfStudy: val('ob2-field-of-study'),
    gradYear:     val('ob2-grad-year'),
    skills:       uniqueSkills(_skills),
  };
}

function collectRequiredFields() {
  return {
    workAuth:        radioVal('workAuth') !== 'no',
    sponsorship:     radioVal('sponsorship') === 'yes',
    city:            val('ob-city'),
    province:        val('ob-province'),
    country:         val('ob-country'),
    postal:          val('ob-postal'),
    address:         val('ob-address'),
    salary:          val('ob-salary'),
    experienceYears: val('ob-experience'),
    prefRemote:      radioVal('prefRemote') !== 'no',
    prefRelocate:    radioVal('prefRelocate') !== 'no',
  };
}

function applyHelpfulDefaults() {
  setRadioValue('workAuth', 'yes');
  setRadioValue('sponsorship', 'no');
  setRadioValue('prefRemote', 'yes');
  setRadioValue('prefRelocate', 'yes');
}

function applyAiDraft(extracted = _extractedData) {
  const aiFilledFields = prefillScreen1FromAI(extracted || {});
  populateReviewForm(extracted || {});
  applyHelpfulDefaults();
  if (aiFilledFields.length > 0) {
    setAiSuggestedBanner(true, aiFilledFields);
  }
  return aiFilledFields;
}

async function saveCurrentProfile(buttonId = 'btn-save-profile') {
  if (!validateScreen2()) return false;

  _requiredFields = collectRequiredFields();
  const reviewed = collectReviewForm();
  const btn = $(buttonId);
  btn?.classList.add('loading');

  try {
    await saveFullProfile(reviewed, _requiredFields, _extractedData.experienceYears);
    goToScreen(3);
    return true;
  } catch (e) {
    toast('Failed to save profile: ' + (e?.message || String(e)), 'warn');
    return false;
  } finally {
    btn?.classList.remove('loading');
  }
}

// ── Save full profile ─────────────────────────────────────────────────────────

function saveFullProfile(reviewed, required, extractedExperience) {
  return new Promise(resolve => {
    const expYears = String(required.experienceYears || extractedExperience || '0').trim() || '0';

    const data = {
      // Personal
      firstName:     reviewed.firstName,
      lastName:      reviewed.lastName,
      email:         reviewed.email,
      phone:         reviewed.phone,
      linkedin:      reviewed.linkedin,

      // Professional
      headline:      reviewed.headline,
      summary:       reviewed.summary,
      skills:        JSON.stringify(uniqueSkills(reviewed.skills)),
      portfolio:     reviewed.portfolio,
      github:        reviewed.github,

      // Education
      education:     reviewed.education,
      educationLevel: reviewed.educationLevel,
      fieldOfStudy:  reviewed.fieldOfStudy,
      gradYear:      reviewed.gradYear,

      // Location
      city:          required.city,
      province:      required.province,
      country:       required.country,
      postal:        required.postal,
      address:       required.address,

      // Compensation
      salary:        required.salary,
      experienceYears: expYears,

      // Safety — NEVER AI
      workAuth:      required.workAuth,
      sponsorship:   required.sponsorship,

      // Preferences
      pref_remote:   required.prefRemote,
      pref_relocate: required.prefRelocate,

      // Flag
      onboardingDone: true,
    };

    chrome.storage.local.set(data, resolve);
  });
}

// ── Pre-fill screen 1 from existing storage ───────────────────────────────────

function prefillFromStorage() {
  const keys = [
    'city', 'province', 'country', 'postal', 'address',
    'salary', 'experienceYears',
    'workAuth', 'sponsorship', 'pref_remote', 'pref_relocate',
    'firstName', 'lastName', 'email', 'phone', 'linkedin',
    'headline', 'summary', 'skills', 'portfolio', 'github',
    'education', 'educationLevel', 'fieldOfStudy', 'gradYear',
    'experience',
  ];

  chrome.storage.local.get(keys, data => {
    if (data.experience && !data.experienceYears) data.experienceYears = data.experience;

    if (data.city)            setVal('ob-city', data.city);
    if (data.province)        setVal('ob-province', data.province);
    if (data.country)         setVal('ob-country', data.country);
    updateEligibilityLabels(data.country || '');
    if (data.postal)          setVal('ob-postal', data.postal);
    if (data.address)         setVal('ob-address', data.address);
    if (data.salary)          setVal('ob-salary', String(data.salary));
    if (data.experienceYears) setVal('ob-experience', String(data.experienceYears));

    if (data.workAuth === false)      setRadioValue('workAuth', 'no');
    else                              setRadioValue('workAuth', 'yes');

    if (data.sponsorship === true)    setRadioValue('sponsorship', 'yes');
    else                              setRadioValue('sponsorship', 'no');

    if (data.pref_remote === false)   setRadioValue('prefRemote', 'no');
    else                              setRadioValue('prefRemote', 'yes');

    if (data.pref_relocate === false) setRadioValue('prefRelocate', 'no');
    else                              setRadioValue('prefRelocate', 'yes');

    if (data.firstName)    setVal('ob2-firstName', data.firstName);
    if (data.lastName)     setVal('ob2-lastName', data.lastName);
    if (data.email)        setVal('ob2-email', data.email);
    if (data.phone)        setVal('ob2-phone', data.phone);
    if (data.linkedin)     setVal('ob2-linkedin', data.linkedin);
    if (data.headline)     setVal('ob2-headline', data.headline);
    if (data.summary)      setVal('ob2-summary', data.summary);
    if (data.portfolio)    setVal('ob2-portfolio', data.portfolio);
    if (data.github)       setVal('ob2-github', data.github);
    if (data.education)    setVal('ob2-education', data.education);
    if (data.educationLevel) setVal('ob2-education-level', data.educationLevel);
    if (data.fieldOfStudy) setVal('ob2-field-of-study', data.fieldOfStudy);
    if (data.gradYear)     setVal('ob2-grad-year', data.gradYear);
    _skills = uniqueSkills(parseSkillsLocal(data.skills));
    renderSkills();
  });
}

// ── Extract status ────────────────────────────────────────────────────────────

function showExtractStatus(msg) {
  const box = $('extract-status');
  const txt = $('extract-msg');
  if (box) box.classList.add('show');
  if (txt) txt.textContent = msg;
}

function hideExtractStatus() {
  const box = $('extract-status');
  if (box) box.classList.remove('show');
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateScreen1() {
  const cityEl   = $('ob-city');
  const salaryEl = $('ob-salary');
  const expEl    = $('ob-experience');

  if (!val('ob-city')) {
    toast('Please enter your city', 'warn');
    cityEl?.focus();
    return false;
  }
  if (!val('ob-salary')) {
    toast('Please enter your desired salary', 'warn');
    salaryEl?.focus();
    return false;
  }
  if (!val('ob-experience')) {
    toast('Please enter your years of experience', 'warn');
    expEl?.focus();
    return false;
  }
  return true;
}

function validateScreen2() {
  const cityEl = $('ob-city');
  const salaryEl = $('ob-salary');
  const expEl = $('ob-experience');
  const firstEl = $('ob2-firstName');
  const lastEl  = $('ob2-lastName');
  const emailEl = $('ob2-email');
  const phoneEl = $('ob2-phone');

  if (!val('ob-city')) {
    toast('City is required', 'warn');
    cityEl?.focus();
    return false;
  }
  if (!val('ob-salary')) {
    toast('Desired salary is required', 'warn');
    salaryEl?.focus();
    return false;
  }
  if (!val('ob-experience')) {
    toast('Years of experience is required', 'warn');
    expEl?.focus();
    return false;
  }
  if (!val('ob2-firstName')) {
    toast('First name is required', 'warn');
    firstEl?.focus();
    return false;
  }
  if (!val('ob2-lastName')) {
    toast('Last name is required', 'warn');
    lastEl?.focus();
    return false;
  }
  if (!val('ob2-email')) {
    toast('Email is required', 'warn');
    emailEl?.focus();
    return false;
  }
  if (!val('ob2-phone')) {
    toast('Phone number is required', 'warn');
    phoneEl?.focus();
    return false;
  }
  return true;
}

function seedManualAssistantDraft() {
  applyHelpfulDefaults();
}

// ── State ─────────────────────────────────────────────────────────────────────

let _extractedData  = {};
let _requiredFields = {};

// ── Button: Generate Profile ──────────────────────────────────────────────────

$('btn-generate')?.addEventListener('click', async () => {
  const resumeText = val('resumeText');

  if (resumeText.length <= 50) {
    // No resume — go straight to the single assistant review screen
    toast('No resume pasted — opening the profile assistant so you can fill it manually', 'warn', 5000);
    _extractedData  = {};
    _requiredFields = {};
    setAiSuggestedBanner(false);
    seedManualAssistantDraft();
    goToScreen(2);
    return;
  }

  const btn = $('btn-generate');
  btn?.classList.add('loading');
  showExtractStatus('Asking AI to extract your profile from the resume…');

  try {
    _extractedData = await extractProfileFromResume(resumeText);

    hideExtractStatus();

    // Pre-fill screen 1 required fields from AI extraction
    const aiFilledFields = applyAiDraft(_extractedData);

    if (aiFilledFields.length > 0) {
      toast(
        _extractedData._parseRecovered
          ? '✓ AI extraction recovered from malformed output — please verify the highlighted fields'
          : '✓ AI extracted profile — please verify the highlighted fields below'
      );
    } else {
      setAiSuggestedBanner(false);
      toast('✓ Profile extracted — review and confirm');
    }
    goToScreen(2);

  } catch (e) {
    hideExtractStatus();
    const errMsg = e?.message || String(e);
    const isOffline = /fetch|connect|ECONNREFUSED|offline|network|timeout/i.test(errMsg);

    toast(
      isOffline
        ? 'Ollama is offline — fill in the fields manually.'
        : 'AI extraction failed: ' + errMsg.slice(0, 80),
      'warn',
      6000
    );

    _extractedData = {};
    setAiSuggestedBanner(false);
  } finally {
    btn?.classList.remove('loading');
  }
});

// ── Button: Skip AI ───────────────────────────────────────────────────────────

$('btn-skip-ai')?.addEventListener('click', () => {
  _extractedData  = {};
  _requiredFields = {};
  setAiSuggestedBanner(false);

  chrome.storage.local.get(
    [
      'firstName', 'lastName', 'email', 'phone', 'linkedin',
      'headline', 'summary', 'skills', 'portfolio', 'github',
      'education', 'educationLevel', 'fieldOfStudy', 'gradYear'
    ],
    data => {
      _extractedData = {
        firstName:    data.firstName    || '',
        lastName:     data.lastName     || '',
        email:        data.email        || '',
        phone:        data.phone        || '',
        linkedin:     data.linkedin     || '',
        headline:     data.headline     || '',
        summary:      data.summary      || '',
        skills:       parseSkillsLocal(data.skills),
        portfolio:    data.portfolio    || '',
        github:       data.github       || '',
        education:    data.education    || '',
        educationLevel: data.educationLevel || '',
        fieldOfStudy: data.fieldOfStudy || '',
        gradYear:     data.gradYear     || '',
        city:         '', province: '', country: '',
        postal:       '', address:  '', salary: '',
        experienceYears: '',
      };

      populateReviewForm(_extractedData);
      applyHelpfulDefaults();
      goToScreen(2);
      hideExtractStatus();
    }
  );
});

// ── Button: Back (screen 2 → screen 1) ───────────────────────────────────────

$('btn-back')?.addEventListener('click', () => goToScreen(1));

$('btn-apply-ai-defaults')?.addEventListener('click', () => {
  const aiFilledFields = applyAiDraft(_extractedData);
  if (aiFilledFields.length > 0) {
    toast(`Applied AI draft for ${aiFilledFields.join(', ')}`, 'ok');
  } else {
    toast('No new AI draft values were available to apply', 'warn');
  }
});

$('btn-apply-safe-defaults')?.addEventListener('click', () => {
  applyHelpfulDefaults();
  toast('Helpful defaults applied for authorization and work preferences', 'ok');
});

$('btn-save-draft-fast')?.addEventListener('click', async () => {
  await saveCurrentProfile('btn-save-draft-fast');
});

// ── Button: Save Profile ──────────────────────────────────────────────────────

$('btn-save-profile')?.addEventListener('click', async () => {
  await saveCurrentProfile('btn-save-profile');
});

// ── Success screen ────────────────────────────────────────────────────────────

$('btn-open-ext')?.addEventListener('click', () => window.close());
$('btn-edit-profile')?.addEventListener('click', () => goToScreen(2));

// ── Init ──────────────────────────────────────────────────────────────────────

initSkillsEditor();
prefillFromStorage();
updateEligibilityLabels(val('ob-country'));
$('ob-country')?.addEventListener('input', e => updateEligibilityLabels(e.target.value));

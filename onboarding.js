// QuickFill AI – onboarding.js v2.0
// Changes from v1:
//   - extractProfileFromResume now also extracts location + experienceYears
//   - Screen 1 required fields are pre-filled from AI extraction
//   - "AI suggested — please verify" banner shown when fields are pre-filled
//   - Safety fields (workAuth, sponsorship) remain always-manual
//   - btn-generate flow: extract → pre-fill screen 1 → navigate to screen 1 review
//     → user confirms → screen 2 review → save
//   - New screen flow: 1 (resume paste) → 1b (verify required fields, pre-filled by AI)
//     → 2 (review professional info) → 3 (done)
//     NOTE: We keep the same 3 screen structure but pre-fill screen 1 fields
//     before advancing, and show a verify banner when AI populated them.

'use strict';

const $ = id => document.getElementById(id);
const val = id => ($(id)?.value || '').trim();
const setVal = (id, v) => { const el = $(id); if (el) el.value = v || ''; };
const radioVal = name => document.querySelector(`input[name="${name}"]:checked`)?.value || '';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function toast(msg, type = 'ok', ms = 4000) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
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
        model: data.ollamaModel || 'gemma3:1b',
      });
    });
  });
}

// ── AI resume extraction ──────────────────────────────────────────────────────

async function extractProfileFromResume(resumeText) {
  const { url, model } = await getOllamaSettings();

  // EXPANDED: now also extracts location + salary hint so screen 1 can be pre-filled
  const systemPrompt = `You are a resume parser. Extract structured data from the resume text and return ONLY a valid JSON object.
Do not include any explanation, markdown code blocks, or text outside the JSON.

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

  const cleaned = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end   = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON found in response');

  const parsed = JSON.parse(cleaned.slice(start, end + 1));

  return {
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
  setVal('ob2-firstName',       extracted.firstName);
  setVal('ob2-lastName',        extracted.lastName);
  setVal('ob2-email',           extracted.email);
  setVal('ob2-phone',           extracted.phone);
  setVal('ob2-linkedin',        extracted.linkedin);
  setVal('ob2-headline',        extracted.headline);
  setVal('ob2-summary',         extracted.summary);
  setVal('ob2-portfolio',       extracted.portfolio);
  setVal('ob2-github',          extracted.github);
  setVal('ob2-education',       extracted.education);
  setVal('ob2-field-of-study',  extracted.fieldOfStudy);
  setVal('ob2-grad-year',       extracted.gradYear);

  _skills = uniqueSkills(extracted.skills || []);
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
    'experience',
  ];

  chrome.storage.local.get(keys, data => {
    if (data.experience && !data.experienceYears) data.experienceYears = data.experience;

    if (data.city)            setVal('ob-city', data.city);
    if (data.province)        setVal('ob-province', data.province);
    if (data.country)         setVal('ob-country', data.country);
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
  const firstEl = $('ob2-firstName');
  const lastEl  = $('ob2-lastName');
  const emailEl = $('ob2-email');
  const phoneEl = $('ob2-phone');

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

// ── State ─────────────────────────────────────────────────────────────────────

let _extractedData  = {};
let _requiredFields = {};

// ── Button: Generate Profile ──────────────────────────────────────────────────

$('btn-generate')?.addEventListener('click', async () => {
  const resumeText = val('resumeText');

  if (resumeText.length <= 50) {
    // No resume — skip AI, go straight to screen 1 required fields
    toast('No resume pasted — fill in the fields manually', 'warn', 5000);
    _extractedData  = {};
    _requiredFields = {};
    setAiSuggestedBanner(false);
    goToScreen(2);
    populateReviewForm(_extractedData);
    return;
  }

  const btn = $('btn-generate');
  btn?.classList.add('loading');
  showExtractStatus('Asking AI to extract your profile from the resume…');

  try {
    _extractedData = await extractProfileFromResume(resumeText);

    hideExtractStatus();

    // Pre-fill screen 1 required fields from AI extraction
    const aiFilledFields = prefillScreen1FromAI(_extractedData);

    if (aiFilledFields.length > 0) {
      setAiSuggestedBanner(true, aiFilledFields);
      toast(`✓ AI extracted profile — please verify the highlighted fields below`);
    } else {
      setAiSuggestedBanner(false);
      toast('✓ Profile extracted — review and confirm');
    }

    // Go to screen 1 required fields so user can verify AI-suggested location/experience
    // (Screen 1 is now the verify step before moving to professional review)
    goToScreen(1);

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

// ── Button: Next (screen 1 → screen 2) ───────────────────────────────────────
// Replaces the old direct jump. User confirms required fields then moves to
// professional info review.

$('btn-next-to-review')?.addEventListener('click', () => {
  if (!validateScreen1()) return;

  _requiredFields = collectRequiredFields();

  // If we have extracted professional data, populate screen 2
  populateReviewForm(_extractedData);
  goToScreen(2);
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
      'education', 'fieldOfStudy', 'gradYear'
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
        fieldOfStudy: data.fieldOfStudy || '',
        gradYear:     data.gradYear     || '',
        city:         '', province: '', country: '',
        postal:       '', address:  '', salary: '',
        experienceYears: '',
      };

      // Go to screen 1 required fields first (user fills manually)
      goToScreen(1);
      hideExtractStatus();
    }
  );
});

// ── Button: Back (screen 2 → screen 1) ───────────────────────────────────────

$('btn-back')?.addEventListener('click', () => goToScreen(1));

// ── Button: Save Profile ──────────────────────────────────────────────────────

$('btn-save-profile')?.addEventListener('click', async () => {
  if (!validateScreen2()) return;

  // Collect required fields from screen 1 in case user went back and edited
  _requiredFields = collectRequiredFields();

  const reviewed = collectReviewForm();
  const btn = $('btn-save-profile');
  btn?.classList.add('loading');

  try {
    await saveFullProfile(reviewed, _requiredFields, _extractedData.experienceYears);
    goToScreen(3);
  } catch (e) {
    toast('Failed to save profile: ' + (e?.message || String(e)), 'warn');
  } finally {
    btn?.classList.remove('loading');
  }
});

// ── Success screen ────────────────────────────────────────────────────────────

$('btn-open-ext')?.addEventListener('click', () => window.close());
$('btn-edit-profile')?.addEventListener('click', () => goToScreen(2));

// ── Init ──────────────────────────────────────────────────────────────────────

initSkillsEditor();
prefillFromStorage();
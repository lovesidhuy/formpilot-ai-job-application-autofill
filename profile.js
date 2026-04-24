// QuickFill AI – profile.js v2.0
// Canonical profile schema, storage helpers, and validation.
// Used by background.js (importScripts), onboarding.js, and popup.js.
//
// v2.0 changes (aligned with background.js v3.2 + rules.js v2.0):
//
// SCHEMA:
//   - Added `linkedin`     — rules.js resolveDirectField now references profile.linkedin
//   - Added `educationLevel` — explicit highest education level for dropdown questions
//   - Added `ollamaModel` / `ollamaUrl` — single source of truth; background.js
//     loadFullProfile() previously duplicated these reads outside of profile.js
//
// FLATTEN / UNFLATTEN:
//   - `linkedin` round-trips correctly through chrome.storage
//   - `ollamaModel` / `ollamaUrl` included in both directions
//   - Skills serialization path consolidated; background.js loadFullProfile()
//     used its own parser — now both call unflattenProfile() for consistency
//
// PROFILE_STORAGE_KEYS:
//   - Added `linkedin`, `ollamaModel`, `ollamaUrl`
//
// loadProfile():
//   - Includes ollamaModel / ollamaUrl + normalizeBaseUrl so the returned
//     object is drop-in compatible with background.js profile usage
//   - Legacy 'experience' → 'experienceYears' migration preserved
//
// validateProfile():
//   - Added warnings for missing summary, education, skills (AI quality)
//
// isProfileUsable():
//   - Unchanged — firstName + lastName + email minimum bar
//
// UNCHANGED:
//   - Memory helpers (loadMemory, saveMemoryEntry, lookupMemory, clearMemory)
//   - normalizeQuestion()
//   - STORAGE_KEY / MEMORY_KEY constants

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'qf_profile'; // unused directly but kept for external callers
const MEMORY_KEY  = 'qf_memory';

const DEFAULT_OLLAMA_BASE  = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'phi3:mini';

// ─── URL normalizer (mirrors background.js exactly) ──────────────────────────
// Kept here so loadProfile() can return a ready-to-use ollamaUrl without
// requiring background.js to post-process it.

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

// ─── Canonical schema / defaults ─────────────────────────────────────────────

const PROFILE_SCHEMA = {
  // Personal
  firstName:       '',
  lastName:        '',
  email:           '',
  phone:           '',
  // Location
  city:            '',
  province:        '',
  country:         '',
  postal:          '',
  // Professional
  headline:        '',          // current job title
  summary:         '',          // professional summary / about me
  education:       '',          // degree, institution, graduation year
  educationLevel:  '',          // explicit highest education level for dropdown questions
  experienceYears: '0',
  skills:          [],          // string[]
  portfolio:       '',          // personal site / GitHub / portfolio URL
  linkedin:        '',          // LinkedIn profile URL  ← new in v2.0
  // Work eligibility — NEVER set by AI
  workAuth:        true,        // legally authorized to work
  sponsorship:     false,       // requires visa sponsorship
  // Compensation
  salary:          '',
  // Preferences
  preferences: {
    remote:   true,
    relocate: true,
  },
  // AI backend (stored flat, not nested)
  ollamaModel: DEFAULT_OLLAMA_MODEL,
  ollamaUrl:   DEFAULT_OLLAMA_BASE,
  // Custom saved Q&A pairs (persistent memory — managed by background.js)
  customAnswers: {},
};

// ─── All storage keys owned by this module ────────────────────────────────────

const PROFILE_STORAGE_KEYS = [
  // Personal
  'firstName', 'lastName', 'email', 'phone',
  // Location
  'city', 'province', 'country', 'postal',
  // Professional
  'headline', 'summary', 'education',
  'educationLevel',
  'experienceYears', 'skills', 'portfolio', 'linkedin',
  // Eligibility
  'workAuth', 'sponsorship',
  // Compensation
  'salary',
  // Preferences (stored flat)
  'pref_remote', 'pref_relocate',
  // AI backend
  'ollamaModel', 'ollamaUrl',
  // Memory / custom answers
  'customAnswers',
  // Legacy migration
  'experience',
];

// ─── Skills parser ────────────────────────────────────────────────────────────
// Single implementation used by both flattenProfile/unflattenProfile and any
// other caller — eliminates the duplicate parser that lived in background.js.

function parseSkills(raw) {
  if (Array.isArray(raw)) return raw.filter(s => typeof s === 'string' && s.trim());
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try { return JSON.parse(trimmed).filter(s => typeof s === 'string' && s.trim()); }
      catch (_) {}
    }
    // Comma-separated plain string fallback
    if (trimmed) return trimmed.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

// ─── Flatten / unflatten for chrome.storage ───────────────────────────────────

/**
 * Flatten a structured profile object into a flat key-value bag
 * suitable for chrome.storage.local.set().
 *
 * FIX v2.0.1: customAnswers is now included so saveProfile() no longer
 * silently wipes persistent memory on every call.
 */
function flattenProfile(profile) {
  return {
    // Personal
    firstName:       profile.firstName       || '',
    lastName:        profile.lastName        || '',
    email:           profile.email           || '',
    phone:           profile.phone           || '',
    // Location
    city:            profile.city            || '',
    province:        profile.province        || '',
    country:         profile.country         || '',
    postal:          profile.postal          || '',
    // Professional
    headline:        profile.headline        || '',
    summary:         profile.summary         || '',
    education:       profile.education       || '',
    educationLevel:  profile.educationLevel  || '',
    fieldOfStudy:    profile.fieldOfStudy    || '',
    gradYear:        String(profile.gradYear || ''),
    experienceYears: String(profile.experienceYears || '0'),
    skills:          JSON.stringify(parseSkills(profile.skills)),
    portfolio:       profile.portfolio       || '',
    linkedin:        profile.linkedin        || '',
    address:         profile.address         || '',
    // Eligibility
    workAuth:        profile.workAuth  !== false,   // default true
    sponsorship:     profile.sponsorship === true,  // default false
    // Compensation
    salary:          String(profile.salary   || ''),
    // Preferences
    pref_remote:     profile.preferences?.remote   !== false,
    pref_relocate:   profile.preferences?.relocate !== false,
    // AI backend
    ollamaModel:     profile.ollamaModel || DEFAULT_OLLAMA_MODEL,
    ollamaUrl:       normalizeBaseUrl(profile.ollamaUrl || DEFAULT_OLLAMA_BASE),
    // Custom answers — preserved so saveProfile() doesn't wipe memory
    customAnswers:   profile.customAnswers || {},
  };
}

/**
 * Unflatten chrome.storage.local data back into a structured profile object.
 * This is the single authoritative parser — background.js loadFullProfile()
 * should delegate here rather than duplicating field-by-field reads.
 */
function unflattenProfile(data) {
  // Legacy migration: 'experience' → 'experienceYears'
  if (data.experience && !data.experienceYears) {
    data.experienceYears = data.experience;
  }

  return {
    // Personal
    firstName:       data.firstName       || '',
    lastName:        data.lastName        || '',
    email:           data.email           || '',
    phone:           data.phone           || '',
    // Location
    city:            data.city            || '',
    province:        data.province        || '',
    country:         data.country         || '',
    postal:          data.postal          || '',
    // Professional
    headline:        data.headline        || '',
    summary:         data.summary         || '',
    education:       data.education       || '',
    educationLevel:  data.educationLevel  || '',
    fieldOfStudy:    data.fieldOfStudy    || '',
    gradYear:        String(data.gradYear || ''),
    experienceYears: String(data.experienceYears || '0'),
    skills:          parseSkills(data.skills),
    portfolio:       data.portfolio       || '',
    linkedin:        data.linkedin        || '',
    address:         data.address         || '',
    // Eligibility
    workAuth:        data.workAuth  !== false,
    sponsorship:     data.sponsorship === true,
    // Compensation
    salary:          String(data.salary   || ''),
    // Preferences
    preferences: {
      remote:   data.pref_remote   !== false,
      relocate: data.pref_relocate !== false,
    },
    // AI backend
    ollamaModel: data.ollamaModel || DEFAULT_OLLAMA_MODEL,
    ollamaUrl:   normalizeBaseUrl(data.ollamaUrl || DEFAULT_OLLAMA_BASE),
    // Custom answers
    customAnswers: data.customAnswers || {},
  };
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

/**
 * Load profile from chrome.storage.local.
 * Returns a fully structured profile object ready for use by background.js,
 * popup.js, and onboarding.js — no post-processing required.
 *
 * @returns {Promise<object>}
 */
function loadProfile() {
  return new Promise((resolve) => {
    chrome.storage.local.get(PROFILE_STORAGE_KEYS, (data) => {
      resolve(unflattenProfile(data));
    });
  });
}

/**
 * Save a profile object to chrome.storage.local.
 *
 * @param {object} profile  Structured profile (will be flattened internally)
 * @returns {Promise<void>}
 */
function saveProfile(profile) {
  return new Promise((resolve) => {
    chrome.storage.local.set(flattenProfile(profile), resolve);
  });
}

// ─── Memory helpers ───────────────────────────────────────────────────────────
// These are single-entry utilities for popup.js / onboarding.js.
// background.js manages the full memory cache via its own getMemoryCache()
// in-memory Map for performance — these helpers do individual storage reads.

/**
 * Normalize a question string into a stable storage key (max 120 chars).
 */
function normalizeQuestion(q) {
  return (q || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/**
 * Load the entire persistent memory store.
 * @returns {Promise<object>} { normalizedQuestion: { answer, source, ts } }
 */
function loadMemory() {
  return new Promise((resolve) => {
    chrome.storage.local.get([MEMORY_KEY], (data) => {
      resolve(data[MEMORY_KEY] || {});
    });
  });
}

/**
 * Save one entry to persistent memory.
 * No-op if answer is blank or '__SKIP__'.
 *
 * @param {string} question  Raw question label
 * @param {string} answer
 * @param {string} source    'profile' | 'rule' | 'ai'
 * @returns {Promise<void>}
 */
function saveMemoryEntry(question, answer, source) {
  const key = normalizeQuestion(question);
  if (!key || !answer || answer === '__SKIP__') return Promise.resolve();
  return new Promise((resolve) => {
    chrome.storage.local.get([MEMORY_KEY], (data) => {
      const mem = data[MEMORY_KEY] || {};
      mem[key] = { answer, source, ts: Date.now() };
      chrome.storage.local.set({ [MEMORY_KEY]: mem }, resolve);
    });
  });
}

/**
 * Look up a single question in persistent memory.
 * @param {string} question
 * @returns {Promise<{ answer, source, ts }|null>}
 */
function lookupMemory(question) {
  const key = normalizeQuestion(question);
  if (!key) return Promise.resolve(null);
  return new Promise((resolve) => {
    chrome.storage.local.get([MEMORY_KEY], (data) => {
      const mem = data[MEMORY_KEY] || {};
      resolve(mem[key] || null);
    });
  });
}

/**
 * Delete all persistent memory entries.
 * @returns {Promise<void>}
 */
function clearMemory() {
  return new Promise((resolve) => {
    chrome.storage.local.remove([MEMORY_KEY], resolve);
  });
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Returns an array of warning strings for missing or incomplete fields.
 * Used by popup.js to warn users before starting a fill run.
 *
 * Critical (blocks accurate form-filling):
 *   firstName, lastName, email, phone, city, salary, experienceYears, headline
 *
 * Quality (degrades AI answer quality if missing):
 *   summary, education, skills
 */
function validateProfile(profile) {
  const warnings = [];

  // Critical fields
  if (!profile.firstName)
    warnings.push('First name is missing');
  if (!profile.lastName)
    warnings.push('Last name is missing');
  if (!profile.email)
    warnings.push('Email is missing');
  if (!profile.phone)
    warnings.push('Phone is missing');
  if (!profile.city)
    warnings.push('City is missing');
  if (!profile.salary)
    warnings.push('Desired salary is missing — salary fields will be skipped');
  if (!profile.experienceYears || profile.experienceYears === '0')
    warnings.push('Years of experience is 0 or missing');
  if (!profile.headline)
    warnings.push('Job title / headline is missing');

  // AI quality fields
  if (!profile.summary)
    warnings.push('Professional summary is missing — "why applying" answers will be generic');
  if (!profile.education)
    warnings.push('Education is missing — education fields will be skipped');
  if (!profile.skills || profile.skills.length === 0)
    warnings.push('Skills list is empty — skill-experience fields will use defaults');

  return warnings;
}

/**
 * Returns true if the minimum required fields are present to start filling.
 * Less strict than validateProfile — just enough to not submit blank critical fields.
 */
function isProfileUsable(profile) {
  return !!(profile.firstName && profile.lastName && profile.email);
}

// ─── Exports (Node.js / Jest testing) ────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PROFILE_SCHEMA,
    PROFILE_STORAGE_KEYS,
    STORAGE_KEY,
    MEMORY_KEY,
    DEFAULT_OLLAMA_BASE,
    DEFAULT_OLLAMA_MODEL,
    normalizeBaseUrl,
    parseSkills,
    flattenProfile,
    unflattenProfile,
    loadProfile,
    saveProfile,
    normalizeQuestion,
    loadMemory,
    saveMemoryEntry,
    lookupMemory,
    clearMemory,
    validateProfile,
    isProfileUsable,
  };
}

'use strict';

const FLOW_SESSION_MAX = 3;
let _activeFlowSession = null;

function buildFlowSessionUpdate(state) {
  if (!state) return null;

  if (state.status === 'running' && state.step === 0 && !_activeFlowSession) {
    let site = 'unknown';
    try {
      site = new URL(location.href).hostname || 'unknown';
    } catch (_) {}

    _activeFlowSession = {
      id: `fp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      site,
      startTime: state.startedAt || Date.now(),
      endTime: null,
      status: 'running',
      filled: 0,
      steps: 0,
      log: [],
      hasErrors: false,
    };
  }

  if (!_activeFlowSession) return null;

  _activeFlowSession = {
    ..._activeFlowSession,
    status: state.status || _activeFlowSession.status,
    filled: Number(state.filled || 0),
    steps: Number(state.step || 0),
    log: Array.isArray(state.log) ? state.log.slice(-500) : [],
    hasErrors: Array.isArray(state.log) && state.log.some(text => /^[\u2717\u26A0]/.test(String(text || ''))),
  };

  if (state.status === 'done' || state.status === 'error' || state.status === 'stopped') {
    _activeFlowSession.endTime = Date.now();
    const completed = { ..._activeFlowSession };
    _activeFlowSession = null;
    return completed;
  }

  return null;
}

function persistCompletedFlowSession(session) {
  if (!session) return;
  chrome.storage.local.get(['fp_sessions'], data => {
    const all = data.fp_sessions || {};
    all[session.id] = session;
    const trimmed = Object.fromEntries(
      Object.entries(all)
        .sort(([, a], [, b]) => (b.startTime || 0) - (a.startTime || 0))
        .slice(0, FLOW_SESSION_MAX)
    );
    chrome.storage.local.set({ fp_sessions: trimmed }, () => void chrome.runtime.lastError);
  });
}

function reportProgress(state) {
  try {
    const completedSession = buildFlowSessionUpdate(state);
    chrome.storage.local.set({ flowState: state }, () => {
      void chrome.runtime.lastError;
      if (completedSession) persistCompletedFlowSession(completedSession);
    });
  } catch (_) {}
}

function isCancelledInStorage() {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get(['flowCancelled'], data => resolve(!!data.flowCancelled));
    } catch (_) {
      resolve(false);
    }
  });
}

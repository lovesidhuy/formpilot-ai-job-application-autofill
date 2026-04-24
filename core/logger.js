'use strict';

class FlowLogger {
  constructor() {
    this.entries = [];
  }

  question(questionText, type, options = []) {
    this.push(`[Questions] ${type}: '${String(questionText || '').slice(0, 70)}'  opts=[${(options || []).slice(0, 4).join(', ')}]`);
  }

  aiAnswer(questionText, answer) {
    this.push(`[AI] Q: ${String(questionText || '').slice(0, 60)}…  →  ${answer}`);
  }

  ruleAnswer(answer) {
    this.push(`[Rule] chose: '${answer}'`);
  }

  profileAnswer(answer) {
    this.push(`[Profile] chose: '${answer}'`);
  }

  selected(answer) {
    this.push(`✓ Selected: '${answer}'`);
  }

  failed(questionText, reason) {
    this.push(`✗ Failed: ${String(questionText || '').slice(0, 60)} — ${reason}`);
  }

  applied(title, url) {
    this.push(`✓ Applied: ${title}  → ${url}`);
  }

  skipping(reason) {
    this.push(`✗ Skipping — ${reason}`);
  }

  step(stepName) {
    this.push(`📍 ${stepName}`);
  }

  push(msg) {
    this.entries.push(msg);
    console.log('[FormPilot]', msg);
    if (this.entries.length > 500) {
      this.entries = this.entries.slice(-500);
    }
  }

  getAll() {
    return [...this.entries];
  }
}

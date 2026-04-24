'use strict';

class QuestionRegistry {
  constructor() {
    this.entries = new Map();
  }

  register(fieldId, data) {
    this.entries.set(fieldId, {
      ...data,
      resolvedAt: Date.now(),
    });
  }

  get(fieldId) {
    return this.entries.get(fieldId) || null;
  }

  buildFromFields(fields, step) {
    for (const field of fields || []) {
      const element = this.resolveFieldElement(field);
      const questionText = resolveQuestionText(
        element,
        step,
        field.name || field.dom?.name || field.targets?.[0]?.name || ''
      );

      this.register(field.id, {
        questionText: questionText || field.question || field.label || field.name || '',
        options: (field.options || []).map(option =>
          typeof option === 'string' ? option : (option.label || option.value || '')
        ).filter(Boolean),
        type: field.type,
        step,
        element,
      });
    }
    return this;
  }

  logEntry(fieldId) {
    const entry = this.get(fieldId);
    if (!entry) return '';
    const opts = (entry.options || []).slice(0, 4).join(', ');
    return `[Questions] ${entry.type}: '${entry.questionText}'  opts=[${opts}]`;
  }

  resolveFieldElement(field) {
    if (field?._element instanceof Element) return field._element;

    const firstTarget = field?.targets?.[0];
    if (firstTarget?.selector) {
      try {
        const bySelector = document.querySelector(firstTarget.selector);
        if (bySelector) return bySelector;
      } catch (_) {}
    }

    if (field?.dom?.selector) {
      try {
        const byDomSelector = document.querySelector(field.dom.selector);
        if (byDomSelector) return byDomSelector;
      } catch (_) {}
    }

    if (firstTarget?.id) {
      const byId = document.getElementById(firstTarget.id);
      if (byId) return byId;
    }

    return null;
  }
}

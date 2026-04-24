'use strict';

function _readCachedJobDescription() {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(''), 1500);
    const finish = (job) => {
      clearTimeout(timer);
      if (!job) {
        resolve('');
        return;
      }

      const parts = [
        job.title ? `Job Title: ${job.title}` : '',
        job.company ? `Company: ${job.company}` : '',
        job.desc ? `Job Description:\n${job.desc}` : '',
      ].filter(Boolean);

      resolve(parts.join('\n\n'));
    };

    try {
      chrome.storage.local.get(['qf_cachedJob'], data => {
        void chrome.runtime.lastError;
        const job = data?.qf_cachedJob;
        if (job) {
          finish(job);
          return;
        }

        try {
          chrome.storage.session.get(['qf_cachedJob'], sessionData => {
            void chrome.runtime.lastError;
            finish(sessionData?.qf_cachedJob || null);
          });
        } catch (_) {
          finish(null);
        }
      });
    } catch (_) {
      finish(null);
    }
  });
}

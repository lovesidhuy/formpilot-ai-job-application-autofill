'use strict';

function harvestWorkdayFields(pageType) {
  if (typeof harvestGenericAtsForm === 'function') {
    return harvestGenericAtsForm(pageType);
  }
  if (typeof collectBaseFields === 'function') {
    return collectBaseFields(pageType);
  }
  return [];
}


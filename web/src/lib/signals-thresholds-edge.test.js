import test from 'node:test';
import assert from 'node:assert';

import { normalizeThresholds } from './signals.js';

test('normalizeThresholds rejects non-integer queue warning inputs', () => {
  const result = normalizeThresholds({
    queueWarningLots: '13.5',
  });

  assert.equal(result.queueWarningLots, 500);
  assert.equal(result.queueCriticalLots, 1000);
});

test('normalizeThresholds normalizes negative and zero queue thresholds', () => {
  const result = normalizeThresholds({
    queueWarningLots: '0',
    queueCriticalLots: '-5',
  });

  assert.equal(result.queueWarningLots, 500);
  assert.equal(result.queueCriticalLots, 1000);
});

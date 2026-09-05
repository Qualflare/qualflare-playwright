import { expect, test } from '@playwright/test';

import { qualflare } from '../../dist/index.js';

// The baseline. If the reporter emits nothing at all, this is what tells the
// difference between "no report" and "a report that lost its cases".
test('reports a plain passing test', async () => {
  expect(1 + 1).toBe(2);
});

test('records the author-facing metadata API', async () => {
  qualflare.label('team', 'platform');
  qualflare.link('https://github.com/Qualflare/qualflare-playwright', {
    type: 'custom',
    name: 'repository',
  });
  qualflare.tag('dogfood');
  qualflare.description('Exercises every metadata call the README documents.');
  qualflare.priority('high');
  qualflare.parameter('plan', 'enterprise');

  expect(true).toBe(true);
});

test('nests steps', async () => {
  await qualflare.step('outer', async () => {
    qualflare.parameter('scope', 'outer');
    await qualflare.step('inner', async () => {
      expect('nested').toHaveLength(6);
    });
  });
});

// A masked parameter is redacted AT SOURCE — the value never reaches the
// report at all. verify-report.mjs asserts the secret is absent from the whole
// payload, which is the only assertion that can prove that.
test('redacts a masked parameter', async () => {
  qualflare.parameter('apiKey', 'qf-dogfood-secret-value', { masked: true });
  expect(true).toBe(true);
});

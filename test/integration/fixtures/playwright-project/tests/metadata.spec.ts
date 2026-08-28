import { test, expect } from '@playwright/test';
import { qualflare } from '../../../../../dist/index.js';

test('exercises the author-facing metadata calls @smoke', async () => {
  qualflare.label('epic', 'Integration Testing');
  qualflare.link('https://example.com/issue/1', { type: 'issue', name: 'example issue' });
  qualflare.tag('qualflare-playwright-self-test');
  qualflare.description('Exercises the qualflare.* metadata API end to end.');
  qualflare.priority('high');
  qualflare.parameter('outside-step-param', 'outside-value');
  qualflare.attachment('note', 'hello from an attachment', { mimeType: 'text/plain' });

  await qualflare.step('a manual step', async () => {
    qualflare.parameter('inside-step-param', 'inside-value');
    expect(true).toBe(true);
  });
});

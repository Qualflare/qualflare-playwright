import type { ReporterDescription } from '@playwright/test';

import type { QualflarePlaywrightOptions } from './config/resolve-config.js';

export { qualflare } from './runtime/qualflare-api.js';

export type { QualflarePlaywrightOptions, ResolvedReporterConfig } from './config/resolve-config.js';

export type {
  Attachment,
  Case,
  CasePriority,
  CaseStatus,
  Collect,
  FrameworkCategory,
  Label,
  Link,
  LinkType,
  Metadata,
  NanosecondDuration,
  Parameter,
  Platform,
  Step,
  Suite,
} from './shared/types.js';

/**
 * Typed helper for registering the reporter.
 *
 * Playwright types a reporter's options as `any` (`ReporterDescription` ends
 * in `[string, any]`), so writing the tuple by hand gives no autocomplete and
 * silently accepts typos. This returns the same tuple with the options
 * checked:
 *
 * ```ts
 * import { defineConfig } from '@playwright/test';
 * import { qualflareReporter } from '@qualflare/playwright';
 *
 * export default defineConfig({
 *   reporter: [['list'], qualflareReporter({ environment: 'staging' })],
 * });
 * ```
 */
export function qualflareReporter(options: QualflarePlaywrightOptions = {}): ReporterDescription {
  return ['@qualflare/playwright/reporter', options];
}

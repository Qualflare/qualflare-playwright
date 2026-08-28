# qualflare-playwright basic example

A minimal, standalone Playwright project showing typical `@qualflare/playwright` usage: reporter
registration via the typed `qualflareReporter()` helper, and the `qualflare.*` metadata API
(`label`, `link`, `description`, `priority`, `parameter`, `step`).

## Running it against a real Qualflare account

The reporter never uploads anything itself: `playwright test` writes a report directory, and
`qualflare-cli` uploads it as a separate step. That split is what lets sharded CI jobs each write
into the same directory and be merged into one Launch by a single `collect`.

```sh
cd examples/basic
npm install
npx playwright install chromium

# 1. Run the tests. Writes ./qualflare-results, no network calls.
npm test

# 2. Upload. Requires @qualflare/cli >= v0.1.17 — https://github.com/Qualflare/qualflare-cli
qf <your-project-identifier> collect ./qualflare-results
```

`qf login <your-project-identifier> <token>` stores the credential once; there is no
`QUALFLARE_TOKEN` env var in this model — the reporter has no token because it makes no requests.

Set `environment` in `playwright.config.ts` (or `QUALFLARE_ENVIRONMENT`) to an environment that
exists in your Qualflare project — see [`../../docs/CONFIGURATION.md`](../../docs/CONFIGURATION.md).

Once `collect` finishes, check your Qualflare project — you should see one new Launch with two
Suites (`login.spec.ts`, `checkout.spec.ts`), the login case carrying its labels/link/steps, and two
Cases for the parameterized checkout tests.

The specs use `data:` URLs rather than a real site, so the example runs offline and fast.

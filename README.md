# billing-automate

Internal tool that drives billing-provider websites with Playwright: look up a bill,
verify the amount, pay it with a debit/prepaid card, and leave behind an audit trail
that proves what happened.

This repo is a **runnable skeleton with a working engine** — not a finished product.
It ships one reference provider (a bundled fake biller), the payment engine, a ledger,
a CLI, and 11 tests that run in ~5 seconds without touching a real biller.

---

## The design in one paragraph

A biller is an *adapter*; the engine owns everything dangerous. Adapters only know
how to read a bill and how to fill a payment form — they never retry, never decide
idempotency, never touch card storage. Reading a bill is retryable, paying it is not,
so the engine splits the flow at exactly that line: retries, backoff and re-reads all
live before the submit click; after the submit click there are no retries, only
outcomes (`paid`, `declined`, `needs-human`, `unknown`, `aborted`). A SQLite ledger
with a UNIQUE constraint on the payment intent is what makes "pay twice" impossible.

## Stack (versions verified 2026-11-01)

| Layer | Choice | Why this one |
| --- | --- | --- |
| Runtime | **Node.js 26.13.0** (LTS since 2026-10-28) | Current LTS. Runs `.ts` directly, so there is no build step. |
| Language | **TypeScript 7.0.2** | The native compiler: same checks, far faster. Pin `typescript@5.9` if a tool lags. |
| Browser | **Playwright 1.64.1** | Auto-waiting locators, persistent profiles, trace viewer, multi-browser. |
| Tests | **@playwright/test 1.64.1** | Same browser plumbing as production; trace on failure for free. |
| Storage | **`node:sqlite`** (built in) | Zero-dependency, transactional ledger. Postgres when this becomes a service. |
| Logging | **pino 10.4.0** | Structured JSON, redaction paths, logs to stderr so stdout stays parseable. |
| CLI | **commander 15.0.0** | Boring and stable. |

Deliberately *not* here: no ORM (the ledger is 4 tables' worth of SQL one day),
no job queue (a cron entry is enough until you run two providers in parallel),
no LLM in the payment path (see `docs/ARCHITECTURE.md` for where AI does help).

## Quickstart

```bash
npm install
npx playwright install chromium      # ~120 MB, once

# Terminal 1 — the fake biller (never touches real money)
node src/providers/demo/site/server.ts --port 4600

# Terminal 2
export DEMO_BILL_URL=http://127.0.0.1:4600
export CARD_FP_SALT=$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")
export BILLING_CARD_DEMO_NUMBER=4111111111111111
export BILLING_CARD_DEMO_EXPIRY=12/30
export BILLING_CARD_DEMO_CVV=123
export BILLING_CARD_DEMO_NAME="Ada Lovelace"
export BILLING_CARD_DEMO_KIND=debit

node src/cli.ts providers
node src/cli.ts lookup --provider demo-bill --customer 100200      # read-only
node src/cli.ts pay    --provider demo-bill --customer 100200 --card demo   # dry-run
node src/cli.ts pay    --provider demo-bill --customer 100200 --card demo --live
node src/cli.ts pay    --provider demo-bill --customer 100200 --card demo --live  # refuses: duplicate
node src/cli.ts ledger
```

Customer numbers starting with `9` trigger the OTP branch — the run stops and returns
`needs-human` unless you pass `--interactive`.

```bash
npm test        # 11 tests: adapter contract, engine, ledger, money
npm run typecheck
```

If `~/.cache` is read-only (containers, Nix, some sandboxes), set
`PLAYWRIGHT_BROWSERS_PATH=.playwright-browsers` before installing and running.

## Layout

```
src/
  core/                 # provider-agnostic. Nothing here knows a biller exists.
    types.ts            # Bill, Card, PaymentOutcome union, BillingProvider contract
    runner.ts           # lookup -> guards -> claim -> submit -> settle
    ledger.ts           # SQLite state machine + UNIQUE idempotency key
    browser.ts          # persistent profile per provider, tracing always on
    secrets.ts          # card loading by reference, Luhn, PAN redaction, fingerprint
    evidence.ts         # masked screenshots as audit proof
    money.ts            # integer minor units, never floats
    log.ts, human.ts    # redacted logging, human-in-the-loop port
  providers/
    registry.ts         # provider id -> adapter instance
    demo/               # reference adapter + the fake biller it drives
  cli.ts                # lookup / pay / ledger / providers
test/                   # adapter + engine tests against the bundled fake biller
docs/
  ARCHITECTURE.md       # invariants, state machine, extension points
  RISK-AND-COMPLIANCE.md# authorization, ToS, PCI scope, 3DS, India-specific rails
```

## The rules the code enforces

| Rule | Where |
| --- | --- |
| A bill is read twice: once for the quote, once immediately before submit. A mismatch aborts. | `demo/provider.ts` (`payBill`) |
| Money is `{ amountMinor, currency }`. No float ever touches an amount. | `core/money.ts` |
| Every payment is claimed in the ledger *before* the adapter can click Pay; the UNIQUE key makes a second claim throw. | `core/runner.ts`, `core/ledger.ts` |
| "submitting" is written before control is handed over. A crash means "unknown", not "retry". | `core/runner.ts` |
| An adapter that throws after submit is reported `unknown`, never retried. | `core/runner.ts` |
| Every bill has a ceiling; a bill above it never reaches the ledger. | `--max-amount` |
| Screenshots mask card number, expiry and CVV. | `core/evidence.ts` + `mask:` |
| The PAN is never logged, never persisted, and only addressed by reference (`--card demo`). | `core/secrets.ts`, `core/log.ts` |
| Dry-run is the default. `--live` is deliberate. | `src/cli.ts` |

## Adding a real provider

1. Copy `src/providers/demo/` to `src/providers/<biller>/`.
2. Replace selectors with accessible ones — `getByRole`, `getByLabel`, `getByTestId`.
   Never CSS paths generated by the browser devtools; they break weekly.
3. Keep `version` honest: bump it whenever a selector changes, it lands in the ledger.
4. Write the adapter tests first, against a saved page (see `docs/ARCHITECTURE.md` §Testing).
5. Register it in `src/providers/registry.ts`, then run `lookup` — read-only — in `--headed`
   mode until it is boring. Only then try `--live` with a ₹1 bill.

Rules for adapters: they must be idempotent for lookups, must never call
`page.waitForTimeout`, must not swallow errors into a generic message, and must return
`needs-human` rather than guessing when the page does something unexpected.

## 2026 Playwright features worth adopting

| Feature | Release | Use here |
| --- | --- | --- |
| `locator.or()` races | 1.33 | Post-submit, race receipt/decline/OTP instead of sleeping. |
| Persistent browser context | long-standing | Keeps biller device trust, so most runs skip login. |
| `mask` on screenshots | 1.18 | Keeps PAN/CVV out of artifacts. Non-negotiable. |
| Trace viewer + `trace.start({sources})` | long-standing | The only sane way to debug a biller that changed. |
| `page.screencast` ("video receipts") | 1.59 | Next step: attach a short video to every paid record. |
| `frameLocator()` with no selector | 1.63 | Gateway card iframes and 3-D Secure challenge frames. |
| `test(..., { lock: 'biller-x' })` | 1.63 | Serialise tests/runs that share one biller account. |
| WebMCP inspection (`page.webmcp`) | 1.64 | If a biller ever ships an agent interface, drive that instead. |
| Playwright Agents (`npx playwright init-agents`) | 1.56 | Planner/generator/healer loops for maintaining adapter tests. |

## Where to start, in order

1. **Two real providers, read-only.** `lookup` against your actual billers, run by hand,
   `--headed`. Prove you can extract amount + reference reliably for 30 consecutive days.
2. **Then one live payment**, small amount, prepaid card, at a desk, with `--interactive`.
3. **Then a nightly canary**: `lookup` for every provider, alert on failure. This is what
   catches a biller redesign before it catches you mid-payment.
4. **Then scheduling**: systemd timer or cron, one process per provider, never two.
5. Only after all of that: a queue, a web UI, Postgres.

See `docs/RISK-AND-COMPLIANCE.md` before step 2 — the fastest way to lose this whole
project is a biller deciding your tool violates their terms.

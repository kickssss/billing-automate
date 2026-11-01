# billing-automate

Drives a biller's website with Playwright: read a bill, pay it with a debit/prepaid
card, record what happened. One adapter per provider; one engine for all of them.

## Stack

| Layer | Choice | Version |
| --- | --- | --- |
| Runtime | Node.js | 26.13.0 (LTS) |
| Language | TypeScript | 7.0.2 |
| Browser | Playwright | 1.64.1 |
| Tests | @playwright/test | 1.64.1 |
| Store | `node:sqlite` | built in |
| CLI | commander | 15.0.0 |

No build step: Node 26 runs `.ts` directly.

## Quickstart

```bash
npm install
npx playwright install chromium
cp config/cards.example.json config/cards.json

# terminal 1
node src/providers/demo/site/server.ts --port 4600

# terminal 2
export DEMO_BILL_URL=http://127.0.0.1:4600

node src/cli.ts providers
node src/cli.ts lookup --provider demo-bill --customer 100200
node src/cli.ts pay --provider demo-bill --customer 100200 --card demo            # dry-run
node src/cli.ts pay --provider demo-bill --customer 100200 --card demo --live
node src/cli.ts ledger
```

Demo customer prefixes pick the branch:

| Customer starts with | Branch |
| --- | --- |
| `1` (or anything else) | pays straight through |
| `8` | captcha step |
| `9` | OTP step |

Tests: `npm test` — 14 tests, ~6s, no network, no money.

## Commands

```
providers                                  list registered providers
lookup   --provider --customer [--headed]  read a bill, never pays
pay      --provider --customer --card      dry-run by default
         [--live] [--max-amount N] [--attempts N] [--headed]
ledger   [--limit N]                       recent attempts
```

## Layout

```
src/
  core/
    runner.ts      the flow: read -> guard -> claim -> attempt -> settle
    types.ts       Bill, Card, PaymentOutcome, BillingProvider, ChallengeSolver
    ledger.ts      SQLite state machine, UNIQUE idempotency key
    challenge.ts   captcha port: none / fixed / http solver
    browser.ts     persistent profile per provider, tracing on
    cards.ts       config/cards.json + Luhn/expiry checks
    money.ts       integer minor units
    evidence.ts    screenshots per step
    logger.ts      JSON logs on stderr
  providers/
    registry.ts    provider id -> adapter, solver from env
    demo/          reference adapter + the fake biller it drives
  tools/record.ts  record a human doing the flow -> trace + HAR
  cli.ts
config/cards.example.json
docs/FLOW.md       the flow, one page
docs/PLAYBOOK.md   how to build an adapter for a new provider
```

## Captcha solving

Set both env vars and `httpSolver` is used:

```bash
export SOLVER_URL=https://api.capsolver.com
export SOLVER_KEY=...
```

Without them the run returns `failed` after `--attempts` tries, with the reason in the
ledger. The request shape lives entirely in `src/core/challenge.ts`; adjust the JSON
keys for the service you pick.

## Cards

`config/cards.json`, plain JSON, one entry per card:

```json
{ "demo": { "number": "4111111111111111", "expiry": "12/30", "cvv": "123",
            "nameOnCard": "Ada", "kind": "debit" } }
```

`config/cards.json` is gitignored so the example file stays the one in the repo.

## Environment

| Var | Default | Use |
| --- | --- | --- |
| `DATA_DIR` | `.data` | profiles, artifacts, ledger |
| `DEMO_BILL_URL` | `http://127.0.0.1:4600` | demo provider base url |
| `CARDS_FILE` | `config/cards.json` | card store |
| `SOLVER_URL` / `SOLVER_KEY` | unset | enable captcha solving |
| `HEADED` | unset | `1` shows the browser |
| `LOG_LEVEL` | info | `silent` or `debug` |

# billing-automate

Drives a provider's website with Playwright: read the charge, confirm the amount,
pay with a debit/prepaid card, record what happened. One adapter per provider;
one engine for all of them.

**One provider today: Jio mobility recharge.**

---

## Start here

You do not write the flow from scratch. You record it, then transcribe it.

### 1. Record the flow from the person who knows it

```bash
node src/tools/record.ts --provider <id> --url <start-url>
```

Hand over the mouse. They do the whole flow once. Press Enter.

```bash
npx playwright show-trace .data/recordings/<id>/<stamp>/trace.zip
```

Writes `trace.zip` (every page, network call, DOM snapshot), `recording.har`
(every request/response) and `steps.md` (the URL trail).

### 2. Read the trace, not the human

The HAR is where the real protocol lives. Filter it by host, pull the JSON
bodies, and you get the exact API sequence, the plan ids, the field names.

### 3. Copy the Jio adapter

```bash
cp -r src/providers/jio src/providers/<id>
```

Rewrite `src/providers/<id>/provider.ts`. Two methods:

```ts
lookupBill(ctx, { customerNumber, targetAmountMinor })  ->  Bill
payBill(ctx, { bill, card })                             ->  PaymentOutcome
```

### 4. Register it

One line in `src/providers/registry.ts`:

```ts
const acme = createAcmeProvider();
map.set(acme.id, acme);
```

### 5. Read-only until it is boring

```bash
node src/cli.ts lookup --provider <id> --customer <number> --amount <rupees> --headed
```

Repeat until it works 10 times in a row. Moves no money.

### 6. Then one live payment

```bash
node src/cli.ts pay --provider <id> --customer <number> --card primary --amount <rupees> --live
```

---

## Jio, specifically

```bash
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.playwright-browsers"
cp config/cards.example.json config/cards.json

# read the plan catalogue (safe, no money)
node src/cli.ts lookup --provider jio-mobility --customer <jio-number> --amount 349
```

Verified working on 2026-11-01: number validated, 216 plans loaded, ₹349 plan
selected, bill returned with its planKey.

The recorded flow and the API sequence it relies on are documented at the top of
[src/providers/jio/provider.ts](src/providers/jio/provider.ts).

**Where the recording ends:** the trace stops at the Paytm currency page
(`securegw.paytmpayments.in/theia/selectCurrencyPage`). JioPay's card form was
never captured, so `CARD_FIELDS` in the adapter is a best-effort list. When it
misses, the run stops with `needs-human` and a screenshot instead of guessing.
That is the one branch left to fill in.

---

## Read these three files, in this order

| # | File | Why |
| --- | --- | --- |
| 1 | `src/core/runner.ts` | the whole flow, ~60 lines |
| 2 | `src/providers/jio/provider.ts` | the real adapter |
| 3 | `src/core/types.ts` | every type, one file |

Then `docs/FLOW.md` (one page) and `docs/PLAYBOOK.md` (how to build the next one).

---

## Tests

```bash
npm test
```

10 tests, ~1s, no browser, no network, no money. They cover the engine: ledger
claims, retry budget, guards, terminal outcomes.

---

## Stack

| Layer | Choice | Version |
| --- | --- | --- |
| Runtime | Node.js | 26.13.0 (LTS) |
| Language | TypeScript | 7.0.2 |
| Browser | Playwright | 1.64.1 |
| Tests | @playwright/test | 1.64.1 |
| Store | `node:sqlite` | built in |
| CLI | commander | 15.0.0 |

Two runtime dependencies. No build step: Node 26 runs `.ts` directly.

---

## Layout

```
src/
  core/
    runner.ts      read -> guard -> claim -> attempt -> settle
    types.ts       Bill, Card, PaymentOutcome, BillingProvider, ChallengeSolver
    ledger.ts      SQLite state machine, UNIQUE idempotency key
    challenge.ts   captcha port: none / fixed / http solver
    browser.ts     persistent profile per provider, tracing on
    cards.ts       config/cards.json + Luhn/expiry checks
    money.ts       integer minor units
    evidence.ts    one screenshot per decisive step
    logger.ts      JSON logs on stderr
  providers/
    registry.ts    provider id -> adapter; solver from env
    jio/           Jio mobility recharge, transcribed from a recording
  tools/record.ts  record a human doing the flow -> trace + HAR + steps.md
  cli.ts
scripts/
  inspect-jio.ts      step inspector: dumps plans, then whatever page you stop on
config/cards.example.json
docs/FLOW.md       the flow, one page
docs/PLAYBOOK.md   how to build an adapter for a new provider
```

---

## Commands

```
providers                                  list registered providers
lookup   --provider --customer             read the charge, never pays
         [--amount N] [--headed]
pay      --provider --customer --card      dry-run by default
         [--live] [--amount N] [--max-amount N] [--attempts N] [--headed]
ledger   [--limit N]                       recent attempts
```

## Captcha solving

Jio showed no captcha. If a provider does, set both vars and `httpSolver` is used:

```bash
export SOLVER_URL=https://api.capsolver.com
export SOLVER_KEY=...
```

Without them, a captcha ends as `failed` after `--attempts` tries, with the reason
in the ledger.

## Environment

| Var | Default | Use |
| --- | --- | --- |
| `DATA_DIR` | `.data` | profiles, artifacts, ledger |
| `CARDS_FILE` | `config/cards.json` | card store |
| `SOLVER_URL` / `SOLVER_KEY` | unset | enable captcha solving |
| `HEADED` | unset | `1` shows the browser |
| `LOG_LEVEL` | info | `silent` or `debug` |

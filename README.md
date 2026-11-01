# billing-automate

Drives a biller's website with Playwright: read a bill, pay it with a debit/prepaid
card, record what happened. One adapter per provider; one engine for all of them.

---

## Start here

You do not write the flow from scratch. You record it, then transcribe it.

### 1. Record the flow from the person who knows it

```bash
node src/tools/record.ts --provider acme --url https://acme.example/login
```

Hand over the mouse. They do the whole payment once. Press Enter when done.

```bash
npx playwright show-trace .data/recordings/acme/<stamp>/trace.zip
```

The trace has every click, every page, every redirect, every gateway iframe. That is
your spec — not what someone remembers.

### 2. Copy the reference adapter

```bash
cp -r src/providers/demo src/providers/acme
```

Rewrite `src/providers/acme/provider.ts`. Two methods:

```ts
lookupBill(ctx, { customerNumber })  ->  Bill
payBill(ctx, { bill, card })         ->  PaymentOutcome
```

Delete the demo site folder from the copy (`src/providers/acme/site/`).

### 3. Register it

One line in `src/providers/registry.ts`:

```ts
const acme = createAcmeProvider({ baseUrl: env.ACME_URL ?? "https://acme.example" });
map.set(acme.id, acme);
```

### 4. Run read-only until it is boring

```bash
node src/cli.ts lookup --provider acme --customer 12345 --headed
```

`--headed` so you can watch. Repeat until it works 10 times in a row. This step moves
no money and cannot hurt anything.

### 5. Then one live payment

```bash
node src/cli.ts pay --provider acme --customer 12345 --card demo --live --max-amount 1
```

---

## Read these three files, in this order

| # | File | Why |
| --- | --- | --- |
| 1 | `src/core/runner.ts` | the whole flow, ~60 lines |
| 2 | `src/providers/demo/provider.ts` | what an adapter looks like |
| 3 | `src/core/types.ts` | every type, one file |

Then `docs/FLOW.md` (one page) and `docs/PLAYBOOK.md` (how to build the next adapter).

---

## Run the demo first

```bash
npm install
npx playwright install chromium
cp config/cards.example.json config/cards.json

node src/providers/demo/site/server.ts --port 4600    # terminal 1
```

```bash
export DEMO_BILL_URL=http://127.0.0.1:4600

node src/cli.ts lookup --provider demo-bill --customer 100200
node src/cli.ts pay --provider demo-bill --customer 100200 --card demo           # dry-run
node src/cli.ts pay --provider demo-bill --customer 100200 --card demo --live
node src/cli.ts ledger
```

The fake biller picks a branch from the customer number:

| Prefix | Branch |
| --- | --- |
| anything else | pays straight through |
| `8` | captcha step |
| `9` | OTP step |

`npm test` — 14 tests, ~6s, no network, no money.

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
    demo/          reference adapter + the fake biller it drives
  tools/record.ts  record a human doing the flow -> trace + HAR
  cli.ts
config/cards.example.json
docs/FLOW.md       the flow, one page
docs/PLAYBOOK.md   how to build an adapter for a new provider
```

---

## Commands

```
providers                                  list registered providers
lookup   --provider --customer [--headed]  read a bill, never pays
pay      --provider --customer --card      dry-run by default
         [--live] [--max-amount N] [--attempts N] [--headed]
ledger   [--limit N]                       recent attempts
```

## Cards

`config/cards.json`, plain JSON:

```json
{ "demo": { "number": "4111111111111111", "expiry": "12/30", "cvv": "123",
            "nameOnCard": "Ada", "kind": "debit" } }
```

Gitignored so only `cards.example.json` is in the repo.

## Captcha solving

Set both vars and `httpSolver` is used:

```bash
export SOLVER_URL=https://api.capsolver.com
export SOLVER_KEY=...
```

Without them, a captcha ends as `failed` after `--attempts` tries, with the reason in
the ledger. Request/response mapping lives only in `src/core/challenge.ts`.

## Environment

| Var | Default | Use |
| --- | --- | --- |
| `DATA_DIR` | `.data` | profiles, artifacts, ledger |
| `DEMO_BILL_URL` | `http://127.0.0.1:4600` | demo provider base url |
| `CARDS_FILE` | `config/cards.json` | card store |
| `SOLVER_URL` / `SOLVER_KEY` | unset | enable captcha solving |
| `HEADED` | unset | `1` shows the browser |
| `LOG_LEVEL` | info | `silent` or `debug` |

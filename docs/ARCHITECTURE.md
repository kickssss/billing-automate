# Architecture

## Shape

```
             cli.ts / future HTTP + queue
                       |
                 core/runner.ts            <- retries, guards, exactly-once, evidence
                   |          |
          core/ledger.ts    BillingProvider  <- adapter: only knows how to read & pay
          (SQLite)            |
                        core/browser.ts     <- persistent profile, tracing
                              |
                          Playwright
```

The engine is written once and is the only code allowed to make a decision about
money. An adapter is a description of one website, and nothing more. If you find
yourself adding a retry, a timeout policy or an idempotency check inside an adapter,
it belongs in the engine.

## Invariants

| # | Invariant | Consequence if broken |
| --- | --- | --- |
| 1 | Only read-only steps are retried. | Double payment, or a card charged twice with one receipt. |
| 2 | A payment intent is claimed in the ledger before the adapter can submit. | The same bill gets paid again on the next run. |
| 3 | `unknown` is a terminal outcome requiring a human. | Silent double payment or a lost payment you cannot prove. |
| 4 | Amount is re-read and compared immediately before submit. | Paying a bill that changed since the quote. |
| 5 | Money is integer minor units. | Rounding drift, off-by-one-cent mismatches. |
| 6 | Every payment has a hard ceiling. | A typo'd bill or a compromised biller page emptying an account. |
| 7 | Card material never leaves memory; artifacts are masked. | PAN in a screenshot that gets synced to a laptop and a backup. |

## Payment state machine

```
                 claim() (UNIQUE key)
        claimed ──────────────► submitting ──► paid
           │                        │      ──► declined
           │                        │      ──► needs-human
           │                        │      ──► unknown      (terminal, human required)
           └──► aborted (pre-submit guard tripped; nothing was submitted)
```

Transitions are validated in `core/ledger.ts`; an illegal move throws instead of
silently overwriting history. `submitting` is written *before* `payBill()` is called,
because the adapter can click Pay at any moment inside it. A process that dies
mid-flow therefore leaves a record that refuses to run again — failing closed is
correct when the alternative is paying twice.

## Provider contract

```ts
interface BillingProvider {
  readonly id: string;               // "acme-electric"
  readonly displayName: string;
  readonly version: string;          // bump on every selector change; stored in the ledger
  lookupBill(ctx, query): Promise<Bill>;
  payBill(ctx, { bill, card }): Promise<PaymentOutcome>;
}
```

`PaymentOutcome` is closed on purpose. `unknown` exists so that "the page did something
I did not expect after I clicked Pay" has a place to go that is not an exception and
not a lie. Adapters return `needs-human` instead of guessing.

## Evidence and audit

Each run produces, under `<DATA_DIR>/artifacts/<provider>/<runId>/`:

* timestamped screenshots for `before-submit`, `receipt`, `declined`, `otp-required`;
* `*-trace.zip` — the Playwright trace (DOM snapshots + network + sources).

The ledger stores the receipt id and the screenshot path, so a payment can be proven
later without keeping the trace forever. A receipt screenshot plus the biller's own
receipt number is usually enough evidence for a finance team.

## Human in the loop

`HumanGate` is a port, deliberately tiny: `ask({kind, prompt}) => string | null`.
Implementations:

* `noHuman` — batch runs; gates return `needs-human`.
* `readlineHumanGate()` — `--interactive` on a terminal.
* future: a row in a `todo` table + a tiny web page with a screenshot and a text box,
  or a chat message. Same port, same adapter code.

Never store OTPs. If the account still uses TOTP and you own the seed, `otplib`
computes it — but that is a credentials decision, not an automation one.

## Testing

Three layers, cheapest first:

1. **Unit** (`test/money.test.ts`) — parsing, rounding, redaction, Luhn.
2. **Adapter contract** (`test/demo-provider.test.ts`) — drive the adapter against a
   bundled fake biller. Fast, deterministic, no money. Copy this file per provider and
   point it at saved HTML/route fixtures later.
3. **Canary** — a nightly read-only `lookup` against the real biller. Not in CI, because
   CI egress is a fingerprint of its own. It is the only test that catches a redesign.

Recorded-HTML replay: `page.route('**/*', ...)` fulfilling from a saved HAR or HTML file
makes adapter tests survive without a network. Add it when a provider starts flaking.

Use `test(..., { lock: 'biller-acme' })` (Playwright 1.63+) for anything that shares one
biller account, so two workers cannot interleave a login.

## Operations

* One process per provider; never two runs against the same account concurrently.
* systemd timer or cron for scheduling; `flock` is a fine mutex at this scale.
* Headless by default; `--headed` when you are developing or when a biller's challenge
  needs a real window.
* Keep the profile directory: it is the login. Backing it up is backing up a session
  cookie — treat it like a credential.
* Rotate card material via env/vault; never in the repo, never on a command line.

## Where AI helps (and where it must not)

Good uses: generating the first draft of an adapter from a recorded trace, healing
tests (`npx playwright test --update-snapshots`-style review, Playwright Agents),
summarising a failed run, proposing selector repairs.

Not allowed: deciding an outcome after submit, retrying, or any step between
`submitting` and `settle`. Determinism is the product here.

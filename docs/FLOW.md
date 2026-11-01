# The flow

One page. Read this to review the design.

## Everything runs through one function

`src/core/runner.ts` → `runPayment()`

```
1  read bill            provider.lookupBill()      retried 3x  (safe)
2  guards               amount > 0, <= ceiling                  (throws)
3  dry-run?             stop here, return bill
4  claim                ledger.claim()              UNIQUE key  (throws on duplicate)
5  mark submitting      ledger.markSubmitting()     written BEFORE the adapter runs
6  attempt              provider.payBill()          up to 3x, only if nothing was submitted
7  settle               ledger.settle()             one of six states
```

Everything else in the repo exists to support those seven lines.

---

## The attempt loop (step 6)

```
attempt 1 ──► paid / declined / failed  ──► stop, settle
          └─► retry (nothing was submitted) ──► attempt 2 ──► ... ──► attempt N
                                                                      └─► settle as FAILED
```

`retry` is the only outcome that loops. An adapter returns it **only** when it knows
the card was not charged — process failed before the submit click, page never loaded.

Anything that could have touched the card returns `paid`, `declined` or `failed`,
which all stop the loop immediately.

---

## Five outcomes, and who produces them

| Outcome | Meaning | Produced when | Ledger state |
| --- | --- | --- | --- |
| `paid` | biller confirmed | success marker on the page | `paid` |
| `declined` | processor said no | decline marker on the page | `declined` |
| `failed` | did not pay | any other end: gateway never loaded, card form missing, bank challenge, no marker in time | `failed` |
| `retry` | nothing submitted | pre-submit step broke | `failed` (after last attempt) |
| `aborted` | guard tripped | amount changed between read and pay | `aborted` |

Every run ends in **paid** or **failed**. There is no state that waits for a person:
an OTP or 3-D Secure challenge is a `failed` run with the challenge page captured,
not a pause.

---

## State machine (SQLite)

```
claimed ──► submitting ──► paid
   │            │      ──► declined
   │            │      ──► failed
   └────────────┴──────► aborted
```

Terminal states accept nothing. A second run for the same
`provider|customer|billRef|amount` throws `DuplicatePaymentError` before any browser
work happens.

---

## The captcha path

```
submit ──► captcha page appears
             │
             ├─ solver wired ──► get token ──► fill ──► submit ──► paid / declined / captcha again
             │                                                  └─ still captcha ──► retry
             └─ no solver ─────────────────────────────────────────────────────────► retry
```

`solver` is a port (`src/core/challenge.ts`). Three implementations ship:

| Solver | Use |
| --- | --- |
| `noSolver` | default; captcha becomes `retry` → `failed` after N attempts |
| `fixedSolver(token)` | tests |
| `httpSolver({endpoint, apiKey})` | CapSolver / 2Captcha / any REST solver |

Retry count is `--attempts` (default 3). After that the attempt is `failed` and the
row stays in the ledger with the reason.

---

## Where a provider plugs in

```ts
interface BillingProvider {
  id: string; version: string;
  lookupBill(ctx, { customerNumber }): Promise<Bill>;
  payBill(ctx, { bill, card }): Promise<PaymentOutcome>;
}
```

Two methods. No retry logic, no ledger, no capture — those live in the runner so every
provider gets them identically.

One provider ships today: `src/providers/jio/`. Copy that folder for the next biller,
change the selectors, add one line to `src/providers/registry.ts`.

---

## Deliberately not here yet

| Not built | Why |
| --- | --- |
| Queue / worker | one process, one provider, cron is enough |
| Web UI | CLI prints JSON; a human reads it |
| Postgres | SQLite is the audit trail until there are several machines |
| Retry after submit | that is how you pay twice |
| LLM anywhere in the payment path | the flow is deterministic or it is wrong |

---

## Files worth reading, in order

1. `src/core/runner.ts` — the flow (60 lines)
2. `src/core/types.ts` — the domain, all in one file
3. `src/core/ledger.ts` — the state machine
4. `src/providers/jio/provider.ts` — the real adapter, transcribed from a trace
5. `src/core/challenge.ts` — captcha port and the HTTP solver

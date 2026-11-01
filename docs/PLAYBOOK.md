# Per-provider automation playbook

How to turn "only the human knows the flow" into a working, maintainable adapter.
Written 2026-11-01 against Playwright 1.64, Node 26 LTS, TypeScript 7.

---

## The one decision that shapes everything

**Automate the deterministic part. Hand off the adversarial part.**

A bill payment is two different problems stapled together:

| Part of the flow | Nature | Strategy |
| --- | --- | --- |
| Login, find customer, read bill, open payment page, fill card | Deterministic, same every time | Automate. Should be boring. |
| CAPTCHA | Puzzle with a token at the end | **Solve via service, inject token, retry 2x, then fail** |
| Device OTP, bank 3-D Secure | Needs a phone or a bank app | **Stop. Report `needs-human`.** |

Teams lose months trying to make row 2 behave like row 1. It does not, it will not,
and the month it "works" is the month it silently breaks a card payment.

Note the ordering trap: a solver returns a *token*, not a *pass*. If the risk score was
already bad, a valid token still gets you challenged again on the next submit. That is
why the retry budget is 2, not 20.

Practical consequence: the success metric is **"attempts that end `paid` on the first or
second try, with nothing ambiguous pending"** — not "captchas beaten".

---

## The loop, per provider

Five stages. Do not skip to the next one because stage N "works on my machine".

| Stage | Output | Exit criterion | Effort |
| --- | --- | --- | --- |
| 1. Discovery | Trace + branch table | You can describe every branch in one page | 20–60 min |
| 2. Skeleton | Adapter that reads the bill | `lookup` succeeds 3× in a row | 1–3 h |
| 3. Lock-in | Fixtures + contract tests | Tests pass offline, no network | 1–2 h |
| 4. Hardening | Payment path + challenge handling | One live ₹1 payment, receipt recorded | 2–4 h |
| 5. Canary | Nightly read-only probe | 30 green days | 15 min + waiting |

First provider: **6–10 h**. Second provider: **3–4 h**. Tenth: **1 h**.
If provider #3 still takes a day, the engine is wrong, not the provider.

---

## Stage 1 — Discovery

The human who knows the flow is the bottleneck. Do not interview them; **record them**.

```bash
node src/tools/record.ts --provider acme-electric --url https://acme.example/login
```

Hand over the mouse. They do the whole thing once, including a payment if they are
comfortable. Come back, press Enter. You now have:

- `trace.zip` — every click, DOM snapshot, network call, and the source line that made it
- `recording.har` — every request and response
- `final-state.png`

```bash
npx playwright show-trace .data/recordings/acme-electric/<stamp>/trace.zip
```

Read the trace, not the human. The trace cannot misremember, and it hands you the
selectors, the redirect chain, and the gateway URL for free.

### The branch table (the actual deliverable of stage 1)

Fill this in before writing code. One row per thing that can happen. This table is the
adapter's spec, its test list, and its backlog.

| # | Screen | Trigger | What it means | Our action |
| --- | --- | --- | --- | --- |
| 1 | Bill page | normal | amount + reference visible | read, continue |
| 2 | Login | session expired | cookies gone | log in, retry once |
| 3 | "No dues" | already paid | nothing to do | exit `planned`, no payment |
| 4 | OTP screen | new device / high amount | bank or biller challenge | `needs-human` |
| 5 | Captcha | suspicious traffic | risk score too high | `needs-human`; fix the cause |
| 6 | 3-D Secure iframe | issuer wants SCA | nested frame appears | `needs-human` |
| 7 | Decline page | card rejected | processor said no | `declined` + code |
| 8 | Timeout after submit | unknown | we clicked, no proof | `unknown`, never retry |

A provider with 8 rows is normal. A provider where you cannot fill this table is a
provider you should not automate yet.

---

## Stage 2 — Skeleton

Build `lookupBill` only. No payment code. This is the safest, fastest, most reusable
half, and it is the half that finds out whether the site fights you.

### Selector strategy, ranked

1. `getByRole` with a name — survives redesigns, mirrors what a human sees
2. `getByLabel` / `getByPlaceholder` — form fields
3. `getByTestId` — if the site has them, use them first
4. `getByText` — stable for receipts and amounts
5. CSS/XPath — **last resort**; never paste a devtools-generated path

Never select by frame index (`page.frames()[2]`) — it shifts the moment analytics or a
captcha iframe loads. Never select by nth-child. Both are how adapters rot.

### Waiting, ranked

1. `expect(locator).toBeVisible()` — assertion, retries, best error messages
2. `locator.waitFor({ state })` — when you only need presence
3. `locator.or(other).first()` — **race branches**; this is how you handle "after submit
   the page could be a receipt, a decline, or an OTP form"
4. `page.waitForResponse()` — when the UI lags the network
5. `page.waitForTimeout()` — **never**. It is the number one source of flake in every
   codebase that has it.

```ts
const paid = page.getByTestId("receipt-reference");
const declined = page.getByTestId("decline-code");
const otp = page.getByTestId("otp-input");
await paid.or(declined).or(otp).first().waitFor({ timeout: 30_000 });
```

### Gateways live in iframes

Any time the card fields appear, assume an iframe, and assume it is nested.

| Layer | What you see | How to reach it |
| --- | --- | --- |
| Biller page | `<iframe src="gateway...">` | `page.frameLocator('iframe[src*="gateway"]')` |
| Gateway modal | `<iframe id="challengeFrame">` inside above | chain a second `frameLocator()` |
| 3-D Secure ACS | another frame, cross-origin | `getByRole('button', { name: /complete|authorize/i })` |

Playwright 1.63+ can also search all frames with `page.frameLocator()` called without a
selector — useful for finding a frame you cannot name, less precise for production.

Symptom of getting this wrong: the locator **silently matches nothing** and the run
times out 30 s later with a confusing error. When a card field is invisible to your
locator, it is in a frame, 95% of the time.

---

## Stage 3 — Lock-in

Freeze the flow so a redesign shows up as a failing test, not a failed payment.

1. Save the recorded HAR and the key HTML snapshots into `test/fixtures/<provider>/`
2. Replay them with `page.route('**/*', route => ...)` — tests run offline, deterministic
3. Assert on the contract, not the pixels: amount, currency, reference, state
4. Bump `version` in the adapter on every selector change; it lands in the ledger

Then delete the "it worked when I ran it" memory and trust the suite.

---

## Stage 4 — Hardening (the payment path)

Order of operations, and why:

1. Re-enter the flow and **re-read the bill** in the same session you will pay from
2. Compare to the quoted bill; abort on mismatch
3. Claim the intent in the ledger (UNIQUE key = no double payment)
4. Fill the card, take a **masked** screenshot
5. Click submit **once**
6. Race the outcome markers
7. Settle: `paid` | `declined` | `needs-human` | `unknown`

Challenges, and what to actually do:

| Challenge | Frequency | Automate? | Reality in 2026 |
| --- | --- | --- | --- |
| Captcha / Turnstile / reCAPTCHA | Occasional | **Yes — solver** | Returns a token; inject it, submit again, retry max 2 |
| Biller OTP | Common | No | Only a phone finishes this. `needs-human` |
| 3-D Secure challenge | Common on new devices | No | Bank-owned. `needs-human` |
| Device fingerprint check | Occasional | Yes | Persistent profile solves most of it |
| Duplicate-payment block | Rare | Yes — read the message | Report `aborted`, not `paid` |

The solver is a port (`src/core/challenge.ts` → `ChallengeSolver`): `noSolver` by default,
`fixedSolver` for tests, `httpSolver` for CapSolver/2Captcha/any REST service. Swapping
providers is one function, not a refactor.
A gate that returns `null` is a `needs-human` outcome, which is a **correct result**,
not a failure. Batch runs finish with a work queue of humans needing to act, and that is
the intended design.

---

## Stage 5 — Canary

A nightly **read-only** `lookup` for every provider, alert on failure.

This is the only test that catches a site redesign before it catches you mid-payment.
It costs nothing, moves no money, and is the single highest-return thing in this repo.

Do not run the canary from CI. CI egress IPs are themselves a fingerprint; run it from
the same machine/network the real payments come from.

---

## Detection: what actually matters in 2026

Ranked by impact, based on how risk engines score (Cloudflare publishes its bot score
bands: 1 = certain bot, 30–99 = likely human):

1. **IP reputation and ASN** — datacenter IPs are the biggest single signal. Run from
   your home/office connection. This alone beats every stealth patch.
2. **A real browser profile** — persistent context with history, cookies, saved state.
   A fresh incognito context every run is the loudest possible signal.
3. **Human cadence** — one login per month, a few seconds between fields. You are paying
   a bill, not scraping 25,000 pages; volume is a choice you are making wrong.
4. **Headless vs headed** — headless matters less than it did, but headed removes an
   entire class of checks for free. Use `--headed` in production if it is a desktop tool.
5. **Stealth patches** — `patchright` (1.64.2), `camoufox` (0.13.0), `rebrowser-patches`
   exist and do work for scraping at scale. For a monthly bill payment they are
   unnecessary complexity with a real downside: they lag Playwright releases and change
   behaviour you then have to debug on a payment run.

Rule: **fix items 1–4 before touching item 5.** Most teams do the reverse.

---

## Do not

1. **Do not retry after the submit click.** Ever. `unknown` + a human is the correct answer.
2. **Do not put an LLM between "click pay" and "record the receipt".** Agents are fine for
   *discovery* ("find me the pay button"), fatal for *decision* ("did this succeed?").
3. **Do not retry a captcha more than twice.** Two failures mean the score is bad, not
   the token. Looping turns a soft challenge into a hard block.
4. **Do not scrape the biller's internal API to "simplify" the flow** unless you have
   confirmed it is sanctioned. Same authorization question, worse optics.
5. **Do not treat `failed` as "try again later".** It means the attempt exhausted its
   budget. Read the ledger reason first.

---

## Before you build: is the browser even the right tool?

Check in this order, stop at the first yes:

1. Does the biller have a documented **API** or partner integration?
2. Does it support **autopay / e-mandate / saved card**?
3. In India: is the biller reachable via **BBPS / Bharat Connect** through a licensed
   aggregator, or **UPI AutoPay** / **NACH** for recurring?
4. Is there an **email bill + payment link** flow you can drive instead?
5. Only then: browser automation.

Any of 1–4 is cheaper to run, more reliable, and easier to defend than a Playwright
script that must survive a redesign every quarter. Browser automation is the correct
answer only when the biller offers nothing else.

---

## Definition of done, per provider

- [ ] Branch table filled in, every row mapped to an outcome
- [ ] `lookup` succeeds 3× consecutively, headless, no manual step
- [ ] Offline contract tests pass
- [ ] One live payment, receipt id stored, screenshot masked
- [ ] Duplicate payment attempt is refused by the ledger
- [ ] Canary running nightly for the last 7 days
- [ ] `version` bumped and stamped in the ledger
- [ ] Someone knows what to do when it returns `needs-human`

---

## Sources

- Playwright — [Authentication / persistent state](https://playwright.dev/docs/auth), [3-D Secure nested frames](https://github.com/petrkindlmann/qa-skills/blob/main/skills/payment-testing/references/playwright-3ds.md)
- Cloudflare — [bot scores and bands](https://developers.cloudflare.com/bots/concepts/bot-score/)
- BrowserStack — [Bypassing CAPTCHA with Playwright in 2026](https://www.browserstack.com/guide/playwright-captcha) (detection-before-challenge, legal risk)
- TestChimp — [Stripe 3DS + webhooks in Playwright, 2026](https://docs.testchimp.io/guides/flows/testing-stripe-payments/), Hyperping — [Stripe Checkout iframes and 3DS](https://hyperping.com/blog/test-stripe-checkout-playwright)
- Anti-detect tooling — [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright), [camoufox](https://github.com/daijro/camoufox), [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches)
- r/webscraping threads on detection: [25k pages](https://www.reddit.com/r/webscraping/comments/1amyqly/playwright_browser_getting_detected_after/), [antibot basics](https://www.reddit.com/r/webscraping/comments/149czf4/how_i_can_bypass_antibot_in_playwright_or_seleium/), [r/Playwright captcha thread](https://www.reddit.com/r/Playwright/comments/1ckvngn/how_to_bypass_captchas/)
- India rails — [Bharat Connect developers](https://www.bharat-connect.com/developers/), [UPI AutoPay 2026 guide](https://razorpay.com/blog/master-recurring-payments-upi-autopay-guide/)
- 3DS friction data — [Ravelin 3DS rates 2026](https://www.ravelin.com/blog/3d-secure-rates-2026)

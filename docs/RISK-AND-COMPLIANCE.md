# Risk, legality and compliance

Automating a payment on someone else's website is a legal and operational decision
before it is a technical one. Read this before the first live payment.

## 1. Authorization

Automate only accounts you own or are explicitly authorized to operate. If this tool
ever pays bills for other people (family, customers, employees), you need written
authorization and a clear answer to "who is liable when a payment is wrong?".

## 2. Terms of service and bot policies

Most billers do not forbid *a customer* acting through a browser; some forbid
automated access, and a few actively detect and lock accounts. Practical stance:

* Check the ToS and `robots.txt` for the paths you use. Note the date and the text you
  checked in the repo.
* Prefer, in this order: official API -> biller autopay -> BBPS/UPI-NACH mandate ->
  browser automation. Automation is the last resort, not the first.
* Keep the volume human-shaped. One run per bill, once a month, is a customer paying a
  bill. Fifty lookups an hour looks like scraping, and gets treated like it.
* Use the persistent profile: it is the same device the customer already uses, which is
  both more reliable and more honest than an incognito browser pretending to be one.

If a biller tells you to stop, stop. The cost of building a second adapter is small;
the cost of an account suspension and a missed payment is not.

## 3. PCI DSS

If this tool handles *your own* consumer card, PCI DSS does not apply to you
personally. The moment it handles a company card, a customer's card, or runs on a
shared server, it becomes a cardholder-data environment, and PCI DSS v4.0.1 applies.
The rule that matters most for an automation tool:

* **Never store the PAN.** Read it from a vault at the moment of use, keep it in memory,
  let it die with the process.
* **Never store or log the CVV** — not even encrypted, not even briefly.
* **Mask artifacts.** Screenshots on a payment page are a card-data leak waiting to
  happen: `page.screenshot({ mask })` is implemented in `core/evidence.ts` for this
  reason, and trace files are equally sensitive — a trace contains DOM snapshots.
* **Tokenise where you can.** If the biller's gateway supports saved cards or network
  tokens (RBI CoFT tokenisation in India), use them instead of raw PANs.
* Scope creep is the real risk: the moment you add a web UI, a database of accounts,
  or a second operator, you inherit policy, access control and logging duties.

A useful smell test: if you would not be comfortable publishing every file in
`<DATA_DIR>/artifacts` to a colleague, your masking is incomplete.

## 4. Card network and issuer rules

* Do not use automation to test cards, discover BINs, or probe declines — that is card
  testing and it gets merchants terminated.
* Prepaid and virtual cards are frequently rejected by billers and gateways (BIN
  blocks, no recurring support, lower limits). Support it as a capability, not as a
  default: record `kind` on the card and expect declines to be normal, not exceptional.
* Debit cards with 3-D Secure: the bank's challenge is the moment to stop and ask a
  human. Automating around a bank's SCA challenge is both brittle and likely a
  contractual problem.

## 5. Money movement hygiene

* Ceiling per payment, ceiling per day, and an alert when either is approached.
* One receipt, one bill. If a receipt is missing but you clicked submit, the only safe
  state is `unknown` and a manual reconciliation against the card statement.
* Keep the biller's own receipt reference. It is the only identifier the biller's
  support desk will accept.
* Log the decision, not just the result: amount, card fingerprint (salted hash), bill
  reference, adapter version.

## 6. India-specific rails worth checking first

If the biller is Indian, browser automation may be the wrong tool:

* **BBPS** (Bharat Bill Payment System, NPCI) covers most utilities, telecom, DTH and
  insurance billers through licensed aggregators that expose APIs.
* **UPI Autopay** and **NACH e-mandate** handle recurring payments without a browser.
* **Biller autopay / e-mandate** on the biller's own site is usually a checkbox.

Any of those is more reliable, more compliant, and cheaper to run than a Playwright
script that has to survive a redesign every quarter. Reach for the browser when the
biller offers nothing else.

## 7. Data retention

Keep the ledger forever (it is the audit trail), screenshots for as long as finance
needs proof, and traces for days, not months — traces are bulky and contain DOM that
may include personal data. Never retain card data at all.

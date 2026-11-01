/**
 * Fake biller used two ways:
 *   1. the reference site the demo adapter drives;
 *   2. an offline fixture so tests never touch a real biller or real money.
 *
 * Customer numbers pick the branch:
 *   ...9xxxxx  -> OTP step
 *   ...8xxxxx  -> captcha step (token must be "demo-human-token")
 *   anything else -> straight to receipt
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export const DEMO_CAPTCHA_TOKEN = "demo-human-token";
export const DEMO_CAPTCHA_SITEKEY = "demo-sitekey-6Lc";

const money = (minor: number): string =>
  new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100);

const period = (): string => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

export function amountFor(customer: string): number {
  let h = 0;
  for (const ch of customer) h = (h * 31 + ch.charCodeAt(0)) % 1_000_000;
  return 10_000 + (h % 490_000);
}

const shell = (title: string, body: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.5 system-ui;margin:3rem auto;max-width:34rem;padding:0 1rem}
input{display:block;width:100%;padding:.5rem;margin:.25rem 0 1rem}
label{font-weight:600}button{padding:.6rem 1.2rem;font-size:1rem}
.captcha{border:1px solid #ccc;padding:1rem;margin:1rem 0}</style></head>
<body><h1>${title}</h1>${body}</body></html>`;

const pageForm = (): string =>
  shell("Demo Biller", `<form method="post" action="/bill">
    <label for="customerNumber">Customer number</label>
    <input id="customerNumber" name="customerNumber" required autocomplete="off">
    <button type="submit">View bill</button></form>`);

const pageBill = (customer: string, ref: string, minor: number): string =>
  shell("Your bill", `<dl>
    <dt>Customer number</dt><dd data-testid="bill-customer">${customer}</dd>
    <dt>Billing period</dt><dd data-testid="bill-period">${period()}</dd>
    <dt>Invoice reference</dt><dd data-testid="bill-reference">${ref}</dd>
    <dt>Amount due</dt><dd><span data-testid="bill-amount">${money(minor)}</span>
      <span data-testid="bill-currency">INR</span></dd></dl>
    <form method="post" action="/pay">
      <input type="hidden" name="customerNumber" value="${customer}">
      <input type="hidden" name="reference" value="${ref}">
      <input type="hidden" name="amountMinor" value="${minor}">
      <button type="submit">Pay now</button></form>`);

const hidden = (c: string, r: string, m: number): string =>
  `<input type="hidden" name="customerNumber" value="${c}">
   <input type="hidden" name="reference" value="${r}">
   <input type="hidden" name="amountMinor" value="${m}">`;

const pageCard = (customer: string, ref: string, minor: number): string =>
  shell("Card payment", `<p>Paying <strong data-testid="pay-amount">${money(minor)}</strong> INR for ${ref}</p>
    <form method="post" action="/confirm">${hidden(customer, ref, minor)}
      <label for="nameOnCard">Name on card</label>
      <input id="nameOnCard" name="nameOnCard" required autocomplete="off">
      <label for="cardNumber">Card number</label>
      <input id="cardNumber" name="cardNumber" inputmode="numeric" required autocomplete="off">
      <label for="expiry">Expiry (MM/YY)</label>
      <input id="expiry" name="expiry" placeholder="MM/YY" required autocomplete="off">
      <label for="cvv">CVV</label>
      <input id="cvv" name="cvv" inputmode="numeric" required autocomplete="off">
      <button type="submit">Confirm payment</button></form>`);

const pageCaptcha = (customer: string, ref: string, minor: number, error = ""): string =>
  shell("Security check", `${error ? `<p data-testid="captcha-error">${error}</p>` : ""}
    <p>Confirm you are human before we charge your card.</p>
    <form method="post" action="/captcha">${hidden(customer, ref, minor)}
      <div class="captcha" data-testid="captcha-widget" data-sitekey="${DEMO_CAPTCHA_SITEKEY}">
        I am human (demo token: ${DEMO_CAPTCHA_TOKEN})</div>
      <input id="captchaToken" name="captchaToken" data-testid="captcha-token" autocomplete="off">
      <button type="submit">Continue</button></form>`);

const pageOtp = (customer: string, ref: string, minor: number): string =>
  shell("Verification code", `<p>Enter the code sent to the mobile number on customer ${customer}.</p>
    <form method="post" action="/otp">${hidden(customer, ref, minor)}
      <label for="otp">One-time password</label>
      <input id="otp" name="otp" data-testid="otp-input" inputmode="numeric" required autocomplete="one-time-code">
      <button type="submit">Verify</button></form>`);

const pageDecline = (code: string, message: string): string =>
  shell("Payment declined", `<h2 data-testid="decline-code">${code}</h2>
    <p data-testid="decline-message">${message}</p><p>No amount was debited.</p>`);

const pageReceipt = (ref: string, invoice: string, minor: number): string =>
  shell("Payment successful", `<dl>
    <dt>Receipt reference</dt><dd data-testid="receipt-reference">${ref}</dd>
    <dt>Invoice</dt><dd data-testid="receipt-invoice">${invoice}</dd>
    <dt>Amount paid</dt><dd data-testid="receipt-amount">${money(minor)}</dd></dl>`);

const pageInvalid = (why: string): string =>
  shell("Invalid request", `<p data-testid="error">${why}</p>`);

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

const send = (res: ServerResponse, body: string, status = 200): void => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
};

const luhn = (pan: string): boolean => {
  const d = pan.replace(/\D/g, "");
  if (d.length < 12) return false;
  let sum = 0, dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (dbl) { n *= 2; if (n > 9) n -= 9; }
    sum += n; dbl = !dbl;
  }
  return sum % 10 === 0;
};

const ctxOf = (f: URLSearchParams) => ({
  customer: f.get("customerNumber") ?? "",
  ref: f.get("reference") ?? "",
  minor: Number(f.get("amountMinor") ?? 0),
});

export function createDemoServer(): ReturnType<typeof createServer> {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (req.method === "GET" && url.pathname === "/") return send(res, pageForm());
      if (req.method === "GET" && url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" }).end("ok");
        return;
      }
      if (req.method === "POST" && url.pathname === "/bill") {
        const { customer } = ctxOf(await readForm(req));
        if (!customer) return send(res, pageForm());
        return send(res, pageBill(customer, `INV-${customer}-${period()}`, amountFor(customer)));
      }
      if (req.method === "POST" && url.pathname === "/pay") {
        const { customer, ref, minor } = ctxOf(await readForm(req));
        if (!customer || !minor) return send(res, pageInvalid("missing bill context"), 400);
        return send(res, pageCard(customer, ref, minor));
      }
      if (req.method === "POST" && url.pathname === "/confirm") {
        const f = await readForm(req);
        const { customer, ref, minor } = ctxOf(f);
        const pan = (f.get("cardNumber") ?? "").replace(/\s+/g, "");
        if (!luhn(pan)) return send(res, pageDecline("14", "Invalid card number"));
        if (!/^\d{3,4}$/.test(f.get("cvv") ?? "")) return send(res, pageDecline("55", "Invalid CVV"));
        if (customer.startsWith("8")) return send(res, pageCaptcha(customer, ref, minor));
        if (customer.startsWith("9")) return send(res, pageOtp(customer, ref, minor));
        return send(res, pageReceipt(`RCPT-${randomUUID().slice(0, 8).toUpperCase()}`, ref, minor));
      }
      if (req.method === "POST" && url.pathname === "/captcha") {
        const f = await readForm(req);
        const { customer, ref, minor } = ctxOf(f);
        if ((f.get("captchaToken") ?? "").trim() !== DEMO_CAPTCHA_TOKEN) {
          return send(res, pageCaptcha(customer, ref, minor, "That token is not valid."));
        }
        return send(res, pageReceipt(`RCPT-${randomUUID().slice(0, 8).toUpperCase()}`, ref, minor));
      }
      if (req.method === "POST" && url.pathname === "/otp") {
        const f = await readForm(req);
        const { customer, ref, minor } = ctxOf(f);
        if ((f.get("otp") ?? "").trim() !== "123456") return send(res, pageDecline("65", "Incorrect one-time password"));
        return send(res, pageReceipt(`RCPT-${randomUUID().slice(0, 8).toUpperCase()}`, ref, minor));
      }
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" }).end(`server error: ${(err as Error).message}`);
    }
  });
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const i = process.argv.indexOf("--port");
  const port = i > -1 ? Number(process.argv[i + 1]) : 4600;
  createDemoServer().listen(port, "127.0.0.1", () => console.log(`demo biller on http://127.0.0.1:${port}`));
}

/**
 * A deliberately boring biller, used two ways:
 *   1. as the reference implementation new adapters are modelled on;
 *   2. as an offline fixture so adapter tests never touch a real biller.
 *
 * Card validation is local and fake. Nothing here is a real payment gateway.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

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
label{font-weight:600}button{padding:.6rem 1.2rem;font-size:1rem}</style></head>
<body><h1>${title}</h1>${body}</body></html>`;

const pageForm = (): string =>
  shell(
    "Demo Biller",
    `<form method="post" action="/bill">
       <label for="customerNumber">Customer number</label>
       <input id="customerNumber" name="customerNumber" required autocomplete="off">
       <button type="submit">View bill</button>
     </form>`,
  );

const pageBill = (customer: string, ref: string, minor: number): string =>
  shell(
    "Your bill",
    `<dl>
       <dt>Customer number</dt><dd data-testid="bill-customer">${customer}</dd>
       <dt>Billing period</dt><dd data-testid="bill-period">${period()}</dd>
       <dt>Invoice reference</dt><dd data-testid="bill-reference">${ref}</dd>
       <dt>Amount due</dt>
       <dd><span data-testid="bill-amount">${money(minor)}</span>
           <span data-testid="bill-currency">INR</span></dd>
     </dl>
     <form method="post" action="/pay">
       <input type="hidden" name="customerNumber" value="${customer}">
       <input type="hidden" name="reference" value="${ref}">
       <input type="hidden" name="amountMinor" value="${minor}">
       <button type="submit">Pay now</button>
     </form>`,
  );

const pageCard = (customer: string, ref: string, minor: number): string =>
  shell(
    "Card payment",
    `<p>Paying <strong data-testid="pay-amount">${money(minor)}</strong> INR for invoice ${ref}</p>
     <form method="post" action="/confirm">
       <input type="hidden" name="customerNumber" value="${customer}">
       <input type="hidden" name="reference" value="${ref}">
       <input type="hidden" name="amountMinor" value="${minor}">
       <label for="nameOnCard">Name on card</label>
       <input id="nameOnCard" name="nameOnCard" required autocomplete="off">
       <label for="cardNumber">Card number</label>
       <input id="cardNumber" name="cardNumber" inputmode="numeric" required autocomplete="off">
       <label for="expiry">Expiry (MM/YY)</label>
       <input id="expiry" name="expiry" placeholder="MM/YY" required autocomplete="off">
       <label for="cvv">CVV</label>
       <input id="cvv" name="cvv" inputmode="numeric" required autocomplete="off">
       <button type="submit">Confirm payment</button>
     </form>`,
  );

const pageOtp = (customer: string, ref: string, minor: number): string =>
  shell(
    "Verify payment",
    `<p>Enter the one-time password sent to the mobile number registered
       with customer ${customer}.</p>
     <form method="post" action="/otp">
       <input type="hidden" name="customerNumber" value="${customer}">
       <input type="hidden" name="reference" value="${ref}">
       <input type="hidden" name="amountMinor" value="${minor}">
       <label for="otp">One-time password</label>
       <input id="otp" name="otp" data-testid="otp-input" inputmode="numeric" required autocomplete="one-time-code">
       <button type="submit">Verify</button>
     </form>`,
  );

const pageDecline = (code: string, message: string): string =>
  shell(
    "Payment declined",
    `<h2 data-testid="decline-code">${code}</h2><p data-testid="decline-message">${message}</p>
     <p>No amount was debited.</p>`,
  );

const pageReceipt = (ref: string, invoiceRef: string, minor: number): string =>
  shell(
    "Payment successful",
    `<dl>
       <dt>Receipt reference</dt><dd data-testid="receipt-reference">${ref}</dd>
       <dt>Invoice</dt><dd data-testid="receipt-invoice">${invoiceRef}</dd>
       <dt>Amount paid</dt><dd data-testid="receipt-amount">${money(minor)}</dd>
       <dt>Paid at</dt><dd data-testid="receipt-time">${new Date().toISOString()}</dd>
     </dl>`,
  );

const pageInvalid = (why: string): string =>
  shell("Invalid request", `<p data-testid="error">${why}</p><p><a href="/">Start again</a></p>`);

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function sendHtml(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

const luhn = (pan: string): boolean => {
  const digits = pan.replace(/\D/g, "");
  if (digits.length < 12) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
};

export function createDemoServer(): ReturnType<typeof createServer> {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (req.method === "GET" && url.pathname === "/") return sendHtml(res, pageForm());
      if (req.method === "GET" && url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" }).end("ok");
        return;
      }
      if (req.method === "POST" && url.pathname === "/bill") {
        const form = await readForm(req);
        const customer = (form.get("customerNumber") ?? "").trim();
        if (!customer) return sendHtml(res, pageForm());
        return sendHtml(res, pageBill(customer, `INV-${customer}-${period()}`, amountFor(customer)));
      }
      if (req.method === "POST" && url.pathname === "/pay") {
        const form = await readForm(req);
        const customer = form.get("customerNumber") ?? "";
        const ref = form.get("reference") ?? "";
        const minor = Number(form.get("amountMinor") ?? 0);
        if (!customer || !minor) return sendHtml(res, pageInvalid("missing bill context"), 400);
        return sendHtml(res, pageCard(customer, ref, minor));
      }
      if (req.method === "POST" && url.pathname === "/confirm") {
        const form = await readForm(req);
        const customer = form.get("customerNumber") ?? "";
        const ref = form.get("reference") ?? "";
        const minor = Number(form.get("amountMinor") ?? 0);
        const number = (form.get("cardNumber") ?? "").replace(/\s+/g, "");
        if (!luhn(number)) return sendHtml(res, pageDecline("14", "Invalid card number"));
        if (!/^\d{3,4}$/.test(form.get("cvv") ?? "")) return sendHtml(res, pageDecline("55", "Invalid CVV"));
        // Customers whose number starts with 9 hit the step-up branch.
        if (customer.startsWith("9")) return sendHtml(res, pageOtp(customer, ref, minor));
        return sendHtml(res, pageReceipt(`RCPT-${randomUUID().slice(0, 8).toUpperCase()}`, ref, minor));
      }
      if (req.method === "POST" && url.pathname === "/otp") {
        const form = await readForm(req);
        const code = (form.get("otp") ?? "").trim();
        const customer = form.get("customerNumber") ?? "";
        const ref = form.get("reference") ?? "";
        const minor = Number(form.get("amountMinor") ?? 0);
        if (code !== "123456") return sendHtml(res, pageDecline("65", "Incorrect one-time password"));
        return sendHtml(res, pageReceipt(`RCPT-${randomUUID().slice(0, 8).toUpperCase()}`, ref, minor));
      }
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" }).end(`server error: ${(err as Error).message}`);
    }
  });
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const portArg = process.argv.indexOf("--port");
  const port = portArg > -1 ? Number(process.argv[portArg + 1]) : 4600;
  createDemoServer().listen(port, "127.0.0.1", () => {
    console.log(`demo biller listening on http://127.0.0.1:${port}`);
  });
}

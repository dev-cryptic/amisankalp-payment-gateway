// Razorpay payment gateway (no database): create order -> pay -> confirm -> "successful" -> certificate (one time)
// npm i express razorpay cors dotenv puppeteer-core @sparticuz/chromium
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const Razorpay = require('razorpay');

const app = express();
// CLIENT_ORIGIN can hold several addresses separated by commas
const origins = (process.env.CLIENT_ORIGIN || '*').split(',').map((o) => o.trim());
app.use(cors({ origin: origins.includes('*') ? '*' : origins }));
app.use(express.json());

const rzp = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

app.get('/', (_, res) => res.json({ ok: true, service: 'payment-server' }));

app.get('/api/payments/config', (_, res) => res.json({ keyId: process.env.RAZORPAY_KEY_ID }));

// 1) Create order
app.post('/api/payments/create-order', async (req, res) => {
  try {
    const { amount, programme, name, email } = req.body; // amount in rupees
    const rupees = Number(amount);
    if (!Number.isFinite(rupees) || rupees < 1) return res.status(400).json({ error: 'Minimum amount is ₹1' });

    const paise = Math.round(rupees * 100);
    const order = await rzp.orders.create({
      amount: paise,
      currency: 'INR',
      receipt: `don_${Date.now()}`,
      notes: { programme: programme || '', name: name || '', email: email || '' },
    });
    res.json({ orderId: order.id, amount: paise, currency: 'INR' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not create order' });
  }
});

// 2) Payment done -> server asks Razorpay if it really succeeded, then returns "successful"
app.post('/api/payments/success', async (req, res) => {
  try {
    const { paymentId } = req.body;
    if (!paymentId) return res.status(400).json({ error: 'paymentId required' });

    const pay = await rzp.payments.fetch(paymentId);
    if (pay.status !== 'captured') return res.status(400).json({ error: 'Payment not successful' });

    res.json({ status: 'successful' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not confirm payment' });
  }
});

// 3) Certificate: built in memory, never saved to disk, and can be downloaded only once per payment.
//    "Already downloaded" is remembered in the payment's notes on Razorpay (no database needed).
const TEMPLATE_PATH = path.join(__dirname, 'templates', 'amisankalp_donation_certificate.html');
const inProgress = new Set(); // blocks two requests for the same payment at the same moment

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fillTemplate = (values) =>
  Object.entries(values).reduce(
    (html, [k, v]) => html.split(`{{${k}}}`).join(escapeHtml(v)),
    fs.readFileSync(TEMPLATE_PATH, 'utf8') // read only when a certificate is requested
  );

// Chrome is loaded only here, so the payment routes keep working even if the certificate fails
async function htmlToPdf(html) {
  const chromium = (await import('@sparticuz/chromium')).default;
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless ?? 'shell',
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return await page.pdf({ preferCSSPageSize: true, printBackground: true }); // returns a buffer, no file
  } finally {
    await browser.close();
  }
}

// Put your DSC signing here (node-signpdf with a .pfx, or your provider's signing API).
async function signPdf(pdfBuffer) {
  return pdfBuffer;
}

app.get('/api/certificates/:paymentId', async (req, res) => {
  const { paymentId } = req.params;
  if (inProgress.has(paymentId)) return res.status(429).json({ error: 'Certificate is being prepared.' });
  inProgress.add(paymentId);

  try {
    const pay = await rzp.payments.fetch(paymentId);
    if (pay.status !== 'captured') return res.status(403).json({ error: 'Payment not successful' });

    const notes = pay.notes || {};
    if (notes.certificate_downloaded === 'yes') {
      return res.status(410).json({ error: 'This certificate has already been downloaded.' });
    }

    const html = fillTemplate({
      donor_name: notes.name || 'Respected Donor',
      date: new Date(pay.created_at * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }),
      transaction_id: pay.id,
      reg_number: process.env.FOUNDATION_REG_NO || '',
      g80_number: process.env.FOUNDATION_80G_NO || '',
      pan_number: process.env.FOUNDATION_PAN || '',
      signatory_name: process.env.SIGNATORY_NAME || '',
    });

    const pdf = await signPdf(await htmlToPdf(html));

    // Mark as downloaded BEFORE sending, so a second download is never possible
    await rzp.payments.edit(paymentId, { notes: { ...notes, certificate_downloaded: 'yes' } });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="Amisankalp-Certificate-${pay.id}.pdf"`,
      'Cache-Control': 'no-store',
    });
    res.send(Buffer.from(pdf));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not create the certificate.' });
  } finally {
    inProgress.delete(paymentId);
  }
});

module.exports = app;

if (require.main === module) {
  const port = process.env.PORT || 5000;
  app.listen(port, () => console.log(`Payment server running on port ${port}`));
}
// Razorpay payment gateway (no database): create order -> pay -> confirm -> "successful"
// npm i express razorpay cors dotenv
require('dotenv').config();
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

module.exports = app;

if (require.main === module) {
  const port = process.env.PORT || 5000;
  app.listen(port, () => console.log(`Payment server running on port ${port}`));
}

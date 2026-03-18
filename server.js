require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');

const app = express();
const PORT = process.env.PORT || 3000;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors());
app.use(express.json());

// Config endpoint
app.get('/api/config', (req, res) => {
  res.json({
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    currency: process.env.CURRENCY || 'gbp',
    clinicName: process.env.CLINIC_NAME || 'LOSIC',
  });
});

// Create a Stripe PaymentIntent
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { amount, treatment, duration } = req.body;
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount),
      currency: process.env.CURRENCY || 'gbp',
      automatic_payment_methods: { enabled: true },
      metadata: { treatment: treatment || '', duration: String(duration || '') },
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('PaymentIntent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'LOSIC backend' }));

app.listen(PORT, () => {
  console.log(`LOSIC backend running on port ${PORT}`);
});

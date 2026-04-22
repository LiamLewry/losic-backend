require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const PORT = process.env.PORT || 3000;

// ─── Raw body for Stripe webhook MUST come before express.json() ────────────
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));

// ─── Standard middleware ─────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── Helpers ─────────────────────────────────────────────────────────────────

function to24Hour(time12) {
  const [timePart, ampm] = time12.trim().split(' ');
  let [hours, minutes] = timePart.split(':').map(Number);
  if (ampm === 'PM' && hours !== 12) hours += 12;
  if (ampm === 'AM' && hours === 12) hours = 0;
  return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
}

function clinikoUrl(path) {
  const shard = process.env.CLINIKO_SHARD || 'uk1';
  return 'https://' + shard + '.api.cliniko.com/v1' + path;
}

function clinikoHeaders() {
  const encoded = Buffer.from(process.env.CLINIKO_API_KEY + ':').toString('base64');
  return {
    Authorization: 'Basic ' + encoded,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'LOSIC Booking App (info@losic.co.uk)',
  };
}

async function findOrCreatePatient(name, email, phone) {
  const searchResp = await fetch(
    clinikoUrl('/patients?q=' + encodeURIComponent(email)),
    { headers: clinikoHeaders() }
  );
  if (!searchResp.ok) throw new Error('Cliniko patient search failed: ' + searchResp.status);
  const searchData = await searchResp.json();
  if (searchData.patients && searchData.patients.length > 0) return searchData.patients[0].id;
  const nameParts = name.trim().split(' ');
  const firstName = nameParts[0] || 'Unknown';
  const lastName = nameParts.slice(1).join(' ') || '-';
  const createResp = await fetch(clinikoUrl('/patients'), {
    method: 'POST',
    headers: clinikoHeaders(),
    body: JSON.stringify({
      first_name: firstName,
      last_name: lastName,
      email,
      phone_numbers: phone ? [{ number: phone, phone_type: 'Mobile' }] : [],
    }),
  });
  if (!createResp.ok) {
    const err = await createResp.json().catch(() => ({}));
    throw new Error('Cliniko patient creation failed: ' + createResp.status + ' ' + JSON.stringify(err));
  }
  const patient = await createResp.json();
  return patient.id;
}

async function sendConfirmationEmails({ patientName, patientEmail, treatment, duration, date, time, bookingRef, price }) {
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) { console.warn('RESEND_API_KEY not set - skipping emails'); return; }
  const clinicName = process.env.CLINIC_NAME || 'LOSIC';
  const clinicEmail = process.env.CLINIC_EMAIL || 'info@losic.co.uk';
  const fromAddress = clinicName + ' <bookings@losic.co.uk>';
  const patientHtml = '<h2>Booking Confirmed</h2><p>Dear ' + patientName + ',</p><p>Your appointment at ' + clinicName + ' is confirmed.</p><ul><li>Treatment: ' + treatment + '</li><li>Duration: ' + duration + '</li><li>Date: ' + date + '</li><li>Time: ' + time + '</li><li>Amount: \u00a3' + price + '</li><li>Ref: ' + bookingRef + '</li></ul><p>Location: 5 Inkerman Street, Luton, LU1 1JE</p><p>Please arrive 10 minutes early. Cancellations: 01582 575045</p>';
  const clinicHtml = '<h2>New Booking</h2><ul><li>Patient: ' + patientName + ' (' + patientEmail + ')</li><li>Treatment: ' + treatment + '</li><li>Duration: ' + duration + '</li><li>Date: ' + date + '</li><li>Time: ' + time + '</li><li>Amount: \u00a3' + price + '</li><li>Ref: ' + bookingRef + '</li></ul>';
  const sendEmail = async (to, subject, html) => {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + resendApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromAddress, to: [to], subject, html }),
    });
    if (!resp.ok) console.error('Resend error (' + to + '):', await resp.text());
  };
  await Promise.all([
    sendEmail(patientEmail, 'Booking Confirmed - ' + treatment + ' on ' + date, patientHtml),
    sendEmail(clinicEmail, 'New Booking: ' + patientName + ' - ' + treatment + ' on ' + date + ' at ' + time, clinicHtml),
  ]);
}

// Routes
app.get('/health', (req, res) => { res.json({ status: 'ok', clinic: process.env.CLINIC_NAME || 'LOSIC' }); });

app.get('/api/config', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY, currency: process.env.CURRENCY || 'gbp', clinicName: process.env.CLINIC_NAME || 'LOSIC' });
});

app.get('/api/appointment-types', async (req, res) => {
  try { const resp = await fetch(clinikoUrl('/appointment_types'), { headers: clinikoHeaders() }); res.json(await resp.json()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/practitioners', async (req, res) => {
  try { const resp = await fetch(clinikoUrl('/practitioners'), { headers: clinikoHeaders() }); res.json(await resp.json()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/available-times', async (req, res) => {
  try {
    const { date, appointment_type_id, practitioner_id } = req.query;
    if (!date) return res.status(400).json({ error: 'date is required' });
    const params = new URLSearchParams({ from: date });
    if (appointment_type_id) params.append('appointment_type_id', appointment_type_id);
    if (practitioner_id) params.append('practitioner_id', practitioner_id);
    const resp = await fetch(clinikoUrl('/availability/next_available?' + params.toString()), { headers: clinikoHeaders() });
    res.json(await resp.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/create-checkout', async (req, res) => {
  try {
    const { treatment, duration, price, date, time, patient_name, patient_email, patient_phone = '', notes = '' } = req.body;
    if (!treatment || price == null || !patient_email || !patient_name) return res.status(400).json({ error: 'Missing required fields' });
    const amountPence = Math.round(Number(price) * 100);
    if (amountPence <= 0) return res.status(400).json({ error: 'Price must be greater than 0' });
    const clinicName = process.env.CLINIC_NAME || 'LOSIC';
    const clinicWebsite = process.env.CLINIC_WEBSITE || 'https://losic.co.uk';
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: patient_email,
      line_items: [{ price_data: { currency: process.env.CURRENCY || 'gbp', unit_amount: amountPence, product_data: { name: treatment + ' - ' + duration, description: clinicName + ' appointment on ' + date + ' at ' + time } }, quantity: 1 }],
      metadata: { treatment, duration, date: date || '', time: time || '', patient_name, patient_email, patient_phone, notes, price: String(price) },
      success_url: clinicWebsite + '/booking-success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: clinicWebsite + '/booking-cancelled',
    });
    res.json({ checkout_url: session.url, session_id: session.id });
  } catch (err) { console.error('create-checkout error:', err); res.status(500).json({ error: err.message }); }
});

app.get('/api/check-session', async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: 'session_id required' });
    const session = await stripe.checkout.sessions.retrieve(session_id);
    res.json({ paid: session.payment_status === 'paid', status: session.payment_status, customer_email: session.customer_email });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.post('/api/stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET); }
  catch (err) { console.error('Webhook error:', err.message); return res.status(400).send('Webhook Error: ' + err.message); }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const meta = session.metadata;
    console.log('Payment completed:', meta.patient_name, meta.treatment, meta.date, meta.time);
    try {
      if (process.env.CLINIKO_API_KEY) {
        const patientId = await findOrCreatePatient(meta.patient_name, meta.patient_email, meta.patient_phone);
        const time24 = to24Hour(meta.time);
        const apptResp = await fetch(clinikoUrl('/individual_appointments'), {
          method: 'POST', headers: clinikoHeaders(),
          body: JSON.stringify({ appointment_start: meta.date + 'T' + time24 + ':00', notes: meta.notes || '', patient_id: patientId }),
        });
        if (!apptResp.ok) console.error('Cliniko appt failed:', await apptResp.json().catch(() => ({})));
        else console.log('Cliniko appointment created');
      }
      const bookingRef = 'LOSIC-' + session.id.slice(-8).toUpperCase();
      await sendConfirmationEmails({ patientName: meta.patient_name, patientEmail: meta.patient_email, treatment: meta.treatment, duration: meta.duration, date: meta.date, time: meta.time, bookingRef, price: meta.price });
      console.log('Booking processed. Ref:', bookingRef);
    } catch (err) { console.error('Post-payment error:', err); }
  }
  res.json({ received: true });
});

app.listen(PORT, () => { console.log('LOSIC backend running on port ' + PORT); });

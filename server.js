require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const PORT = process.env.PORT || 3000;

// âââ Raw body for Stripe webhook MUST come before express.json() ââââââââââ
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));

// âââ Standard middleware âââââââââââââââââââââââââââââââââââââââââââââââââââ
app.use(cors());
app.use(express.json());

// âââ Helpers âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

/** Convert "2:30 PM" â "14:30" for Cliniko */
function to24Hour(time12) {
  const [timePart, ampm] = time12.trim().split(' ');
  let [hours, minutes] = timePart.split(':').map(Number);
  if (ampm === 'PM' && hours !== 12) hours += 12;
  if (ampm === 'AM' && hours === 12) hours = 0;
  return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
}

/** Build a Cliniko API URL using the configured shard */
function clinikoUrl(path) {
  const shard = process.env.CLINIKO_SHARD || 'uk1';
  return 'https://' + shard + '.api.cliniko.com/v1' + path;
}

/** Standard headers for all Cliniko requests */
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
  if (!resendApiKey) {
    console.warn('RESEND_API_KEY not set â skipping emails');
    return;
  }
  const clinicName = process.env.CLINIC_NAME || 'LOSIC';
  const clinicEmail = process.env.CLINIC_EMAIL || 'info@losic.co.uk';
  const fromAddress = 'LOSIC <onboarding@resend.dev>';

  const patientHtml = '<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111827;">'
    + '<h2 style="color:#7c3aed;">Booking Confirmed</h2>'
    + '<p>Dear ' + patientName + ',</p>'
    + '<p>Your appointment at <strong>' + clinicName + '</strong> has been confirmed and your payment processed.</p>'
    + '<table style="width:100%;border-collapse:collapse;margin:16px 0;">'
    + '<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb;color:#6b7280;">Treatment</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;font-weight:600;">' + treatment + '</td></tr>'
    + '<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb;color:#6b7280;">Duration</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;font-weight:600;">' + duration + '</td></tr>'
    + '<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb;color:#6b7280;">Date</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;font-weight:600;">' + date + '</td></tr>'
    + '<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb;color:#6b7280;">Time</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;font-weight:600;">' + time + '</td></tr>'
    + '<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb;color:#6b7280;">Amount Paid</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;font-weight:600;">Â£' + price + '</td></tr>'
    + '<tr><td style="padding:8px;color:#6b7280;">Reference</td><td style="padding:8px;font-weight:600;color:#7c3aed;">' + bookingRef + '</td></tr>'
    + '</table>'
    + '<div style="background:#f3f4f6;padding:16px;border-radius:8px;margin:16px 0;"><p style="margin:0 0 8px;font-weight:600;">Location</p><p style="margin:0;color:#4b5563;">5 Inkerman Street, Luton, LU1 1JE</p></div>'
    + '<p style="color:#4b5563;">Please arrive <strong>10 minutes early</strong>. Free cancellation up to 24 hours before.</p>'
    + '</body></html>';

  const clinicHtml = '<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111827;">'
    + '<h2 style="color:#7c3aed;">New Booking â ' + clinicName + '</h2>'
    + '<table style="width:100%;border-collapse:collapse;margin:16px 0;">'
    + '<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb;color:#6b7280;">Patient</td><td style="padding:8px;font-weight:600;">' + patientName + '</td></tr>'
    + '<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb;color:#6b7280;">Email</td><td style="padding:8px;">' + patientEmail + '</td></tr>'
    + '<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb;color:#6b7280;">Treatment</td><td style="padding:8px;font-weight:600;">' + treatment + '</td></tr>'
    + '<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb;color:#6b7280;">Date</td><td style="padding:8px;font-weight:600;">' + date + '</td></tr>'
    + '<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb;color:#6b7280;">Time</td><td style="padding:8px;font-weight:600;">' + time + '</td></tr>'
    + '<tr><td style="padding:8px;color:#6b7280;">Reference</td><td style="padding:8px;font-weight:600;color:#7c3aed;">' + bookingRef + '</td></tr>'
    + '</table></body></html>';

  const sendEmail = async (to, subject, html) => {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + resendApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromAddress, to: [to], subject, html }),
    });
    if (!resp.ok) console.error('Resend error (' + to + '):', await resp.text());
  };

  await Promise.all([
    sendEmail(patientEmail, 'Booking Confirmed â ' + treatment + ' on ' + date, patientHtml),
    sendEmail(clinicEmail, 'New Booking: ' + patientName + ' â ' + treatment + ' on ' + date + ' at ' + time, clinicHtml),
  ]);
}

// âââ Routes ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

app.get('/health', (req, res) => {
  res.json({ status: 'ok', clinic: process.env.CLINIC_NAME || 'LOSIC' });
});

app.get('/api/config', (req, res) => {
  res.json({
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    currency: process.env.CURRENCY || 'gbp',
    clinicName: process.env.CLINIC_NAME || 'LOSIC',
  });
});

app.get('/api/appointment-types', async (req, res) => {
  try {
    const resp = await fetch(clinikoUrl('/appointment_types'), { headers: clinikoHeaders() });
    res.json(await resp.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/practitioners', async (req, res) => {
  try {
    const resp = await fetch(clinikoUrl('/practitioners'), { headers: clinikoHeaders() });
    res.json(await resp.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/available-times', async (req, res) => {
  try {
    const { date, appointment_type_id, practitioner_id } = req.query;
    if (!date) return res.status(400).json({ error: 'date is required' });
    const params = new URLSearchParams({ from: date });
    if (appointment_type_id) params.append('appointment_type_id', appointment_type_id);
    if (practitioner_id) params.append('practitioner_id', practitioner_id);
    const resp = await fetch(clinikoUrl('/availability/next_available?' + params), { headers: clinikoHeaders() });
    res.json(await resp.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/create-checkout', async (req, res) => {
  try {
    const {
      treatment, duration, price, date, time,
      patient_name, patient_email, patient_phone = '', notes = ''
    } = req.body;

    if (!treatment || price == null || !patient_email || !patient_name) {
      return res.status(400).json({ error: 'Missing required fields: treatment, price, patient_name, patient_email' });
    }

    const amountPence = Math.round(Number(price) * 100);
    if (amountPence <= 0) return res.status(400).json({ error: 'Price must be greater than 0' });

    const clinicName = process.env.CLINIC_NAME || 'LOSIC';
    const clinicWebsite = process.env.CLINIC_WEBSITE || 'https://losic.co.uk';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: patient_email,
      line_items: [{
        price_data: {
          currency: process.env.CURRENCY || 'gbp',
          unit_amount: amountPence,
          product_data: {
            name: treatment + ' â ' + duration,
            description: clinicName + ' appointment on ' + date + ' at ' + time,
          },
        },
        quantity: 1,
      }],
      metadata: {
        treatment, duration,
        date: date || '', time: time || '',
        patient_name, patient_email, patient_phone,
        notes, price: String(price)
      },
      success_url: clinicWebsite + '/?booking=confirmed',
      cancel_url: clinicWebsite + '/booking-cancelled',
    });

    res.json({ checkout_url: session.url, session_id: session.id });
  } catch (err) {
    console.error('create-checkout error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/check-session', async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: 'session_id required' });

    const session = await stripe.checkout.sessions.retrieve(session_id);

    // If paid, also trigger Cliniko + email (in case webhook was missed)
    if (session.payment_status === 'paid' && !session.metadata._processed) {
      const meta = session.metadata;
      const bookingRef = 'LOSIC-' + session.id.slice(-8).toUpperCase();
      try {
        if (process.env.CLINIKO_API_KEY) {
          const patientId = await findOrCreatePatient(meta.patient_name, meta.patient_email, meta.patient_phone);
          const time24 = to24Hour(meta.time);
          const apptBody = {
            appointment_start: meta.date + 'T' + time24 + ':00',
            notes: meta.notes || '',
            patient_id: patientId
          };
          await fetch(clinikoUrl('/individual_appointments'), {
            method: 'POST',
            headers: clinikoHeaders(),
            body: JSON.stringify(apptBody)
          });
        }
        await sendConfirmationEmails({
          patientName: meta.patient_name,
          patientEmail: meta.patient_email,
          treatment: meta.treatment,
          duration: meta.duration,
          date: meta.date,
          time: meta.time,
          bookingRef,
          price: meta.price
        });
      } catch (e) {
        console.error('Post-payment processing error:', e);
      }
    }

    res.json({
      paid: session.payment_status === 'paid',
      status: session.payment_status,
      customer_email: session.customer_email
    });
  } catch (err) {
    console.error('check-session error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const meta = session.metadata;
    console.log('Webhook: payment completed for', meta.patient_name, meta.treatment, meta.date);
    try {
      if (process.env.CLINIKO_API_KEY) {
        const patientId = await findOrCreatePatient(meta.patient_name, meta.patient_email, meta.patient_phone);
        const time24 = to24Hour(meta.time);
        const apptBody = {
          appointment_start: meta.date + 'T' + time24 + ':00',
          notes: meta.notes || '',
          patient_id: patientId
        };
        if (meta.appointment_type_id) apptBody.appointment_type_id = Number(meta.appointment_type_id);
        if (meta.practitioner_id) apptBody.practitioner_id = Number(meta.practitioner_id);
        const apptResp = await fetch(clinikoUrl('/individual_appointments'), {
          method: 'POST',
          headers: clinikoHeaders(),
          body: JSON.stringify(apptBody)
        });
        if (!apptResp.ok) console.error('Cliniko appt failed:', await apptResp.json().catch(() => ({})));
        else console.log('Cliniko appointment created');
      }

      const bookingRef = 'LOSIC-' + session.id.slice(-8).toUpperCase();
      await sendConfirmationEmails({
        patientName: meta.patient_name,
        patientEmail: meta.patient_email,
        treatment: meta.treatment,
        duration: meta.duration,
        date: meta.date,
        time: meta.time,
        bookingRef,
        price: meta.price
      });
      console.log('Booking processed. Ref:', bookingRef);
    } catch (err) {
      console.error('Post-payment error:', err);
    }
  }

  res.json({ received: true });
});

// âââ Start (local only â Vercel handles its own serving) âââââââââââââââââââââ
if (require.main === module) {
  app.listen(PORT, () => console.log('LOSIC backend running on port ' + PORT));
}

module.exports = app;

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');

const app = express();
const PORT = process.env.PORT || 3000;

// =====================================================================
// STRIPE — GO-LIVE CHECKLIST
// =====================================================================
// The keys below are pulled from Vercel environment variables. To switch
// from Stripe Test mode to Live mode when the app launches on the App
// Store / Play Store:
//
//   1. In the Stripe Dashboard, toggle to "Live mode" (top-right).
//   2. Developers → API keys → reveal the LIVE secret key (sk_live_…)
//      and the LIVE publishable key (pk_live_…).
//   3. In Vercel → Project → Settings → Environment Variables, update:
//        STRIPE_SECRET_KEY        →  sk_live_… (Production env)
//        STRIPE_PUBLISHABLE_KEY   →  pk_live_… (Production env)
//        STRIPE_WEBHOOK_SECRET    →  whsec_…   (from the LIVE webhook
//                                   endpoint configured to hit
//                                   https://losic-backend.vercel.app
//                                   /api/stripe-webhook)
//   4. Redeploy the Vercel project (trigger from the UI or push a new
//      commit) so the new env vars take effect.
//   5. Do a real £5 test transaction from your own card. Refund it in
//      Stripe Dashboard → Payments.
//   6. Confirm the booking appears in Cliniko, confirmation email
//      arrives via Resend, and the booking-ref matches.
//
// DO NOT paste live keys into this file or into .env in the repo.
// All Stripe credentials must be loaded from env vars only.
// =====================================================================

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const CLINIKO_API_KEY = process.env.CLINIKO_API_KEY;
const CLINIKO_SHARD = process.env.CLINIKO_SHARD || 'uk1';
const CLINIKO_BASE_URL = `https://api.${CLINIKO_SHARD}.cliniko.com/v1`;

// ============================================
// MIDDLEWARE
// ============================================

app.use(cors());
// NOTE: express.static removed — the backend no longer serves any static
// files. The old single-page PWA was retired when the Flutter app shipped,
// and serving the whole repo root publicly was a security risk.

// Raw body needed for Stripe webhook — must come BEFORE express.json()
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ============================================
// BASIC IN-MEMORY RATE LIMITER
// ============================================
// Prevents casual Stripe-charge abuse from a single IP.
// Best-effort only — in-memory state resets on Vercel cold starts.
// For real abuse protection at scale, point REDIS_URL at Upstash and
// swap this for a redis-backed limiter (TODO).
const _rateBuckets = new Map();
const _rateBucketCap = 5_000; // cap map size so a botnet can't OOM us
function rateLimit({ windowMs = 60_000, max = 5 } = {}) {
    return (req, res, next) => {
        const ip =
            req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
            req.socket?.remoteAddress ||
            'unknown';
        const now = Date.now();

        // Lazy GC: when the map gets oversized, drop everything that's
        // already past its window. Cheap and good enough for a single
        // serverless instance.
        if (_rateBuckets.size > _rateBucketCap) {
            for (const [k, v] of _rateBuckets) {
                if (now > v.resetAt) _rateBuckets.delete(k);
            }
        }

        const bucket = _rateBuckets.get(ip);
        if (!bucket || now > bucket.resetAt) {
            _rateBuckets.set(ip, { count: 1, resetAt: now + windowMs });
            return next();
        }
        bucket.count++;
        if (bucket.count > max) {
            return res.status(429).json({
                error: 'Too many requests — please wait a moment and try again.',
            });
        }
        next();
    };
}

// Clamp user-supplied strings (protects Stripe metadata limits + email garbage)
function clampStr(v, max) {
    if (v == null) return '';
    const s = String(v);
    return s.length > max ? s.slice(0, max) : s;
}

// HTML-escape every patient-controlled field before it goes into an
// email template. Without this, a patient called `<script>...</script>`
// or notes containing markup would inject HTML into our outbound emails.
function escapeHtml(v) {
    if (v == null) return '';
    return String(v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Reject prices that aren't a sensible positive GBP amount.
// Cliniko/Stripe both choke (or worse, accept) on NaN/Infinity/negatives.
function isValidPrice(p) {
    const n = Number(p);
    return Number.isFinite(n) && n > 0 && n < 10_000;
}

// YYYY-MM-DD format guard for query params we forward to Cliniko.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Numeric ID guard for Cliniko query params (appointment_type_id,
// practitioner_id) — prevents arbitrary string injection into the URL.
const NUMERIC_ID_RE = /^\d{1,12}$/;

// Mask an email for logs so we can correlate without writing PII.
function maskEmail(e) {
    if (!e || typeof e !== 'string' || !e.includes('@')) return '<no-email>';
    const [user, domain] = e.split('@');
    const u = user.length <= 2 ? user[0] + '*' : user[0] + '***' + user.slice(-1);
    return `${u}@${domain}`;
}

// Send a safe 500 to the client (never leak Stripe/Cliniko internals or
// stack traces) while still logging the full error for ourselves.
function safeError(res, where, err, status = 500) {
    console.error(`${where}:`, err?.message || err);
    res.status(status).json({
        error: 'The booking service had a problem. Please try again, or call the clinic.',
    });
}

// ============================================
// CLINIKO HELPER
// ============================================

async function clinikoFetch(endpoint, options = {}) {
    if (!CLINIKO_API_KEY || CLINIKO_API_KEY === 'your_cliniko_api_key_here') {
        throw new Error('CLINIKO_API_KEY not configured in .env');
    }
    const auth = Buffer.from(`${CLINIKO_API_KEY}:`).toString('base64');
    const response = await fetch(`${CLINIKO_BASE_URL}${endpoint}`, {
        ...options,
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'LOSICBookingApp/1.0 (lutonosteo@gmail.com)',
            ...options.headers,
        },
    });
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Cliniko ${response.status}: ${err}`);
    }
    return response.json();
}

// Convert "10:30 AM" → "10:30"  /  "1:00 PM" → "13:00"
function to24h(time12) {
    if (!time12) return '09:00';
    const [timePart, modifier] = time12.trim().split(' ');
    let [hours, minutes] = timePart.split(':').map(Number);
    if (modifier === 'AM' && hours === 12) hours = 0;
    if (modifier === 'PM' && hours !== 12) hours += 12;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

// ============================================
// CREATE OR FIND CLINIKO PATIENT
// ============================================

async function findOrCreatePatient(name, email, phone) {
    // Try to find by email first
    if (email) {
        try {
            const result = await clinikoFetch(`/patients?q=${encodeURIComponent(email)}`);
            if (result.patients?.length > 0) return result.patients[0];
        } catch (_) {}
    }

    // Create new patient
    const parts = (name || 'Unknown Patient').trim().split(' ');
    const firstName = parts[0];
    const lastName = parts.slice(1).join(' ') || firstName;

    return clinikoFetch('/patients', {
        method: 'POST',
        body: JSON.stringify({
            first_name: firstName,
            last_name: lastName,
            email: email || '',
            patient_phone_numbers: phone
                ? [{ phone_type: 'Mobile', number: phone }]
                : [],
        }),
    });
}

// ============================================
// CREATE CLINIKO APPOINTMENT AFTER PAYMENT
// ============================================

async function createClinikoAppointmentFromSession(session) {
    const {
        treatment,
        appointment_date,
        appointment_time,
        patient_name,
        patient_phone,
        notes,
        patient_email,
    } = session.metadata || {};

    console.log(`Creating Cliniko appointment | ${treatment} | ${appointment_date} ${appointment_time}`);

    try {
        const patient = await findOrCreatePatient(patient_name, patient_email || session.customer_email, patient_phone);
        console.log(`Patient ready: id=${patient.id}`);

        if (!appointment_date || !appointment_time) {
            console.warn('No date/time in metadata — skipping Cliniko appointment creation');
            return;
        }

        const startTime = `${appointment_date}T${to24h(appointment_time)}:00`;

        const appt = await clinikoFetch('/individual_appointments', {
            method: 'POST',
            body: JSON.stringify({
                appointment_start: startTime,
                patient_id: patient.id,
                notes: notes || '',
            }),
        });

        console.log('Cliniko appointment created:', appt.id);
        return appt;
    } catch (err) {
        console.error('Cliniko appointment creation failed:', err.message);
        // Payment already succeeded — don't throw, but escalate so the
        // booking doesn't silently disappear. The clinic gets an alert
        // email with the patient details so they can add it manually.
        await sendClinicAlert({
            subject: `⚠ MANUAL BOOKING NEEDED — ${patient_name} (${treatment})`,
            reason: 'Cliniko appointment creation failed after a successful payment.',
            error: err.message,
            session,
        }).catch((alertErr) => {
            console.error('Cliniko-failure alert email also failed:', alertErr.message);
        });
    }
}

// ============================================
// CLINIC ALERT EMAIL (failure escalation)
// ============================================
// Sends a high-priority email to the clinic inbox when something has
// gone wrong AFTER payment succeeded — so a paid booking can't silently
// fall on the floor. Uses Resend (already wired) so no new dep.
async function sendClinicAlert({ subject, reason, error, session }) {
    const key = process.env.RESEND_API_KEY;
    if (!key || key === 're_your_resend_api_key_here') {
        console.warn('RESEND_API_KEY not set — cannot send clinic alert');
        return;
    }
    const clinicInbox = process.env.CLINIC_EMAIL || 'lutonosteo@gmail.com';
    const from = process.env.RESEND_FROM || 'LOSIC Bookings <bookings@losic.co.uk>';
    const m = (session && session.metadata) || {};
    const html = `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;border:2px solid #dc2626;border-radius:12px;background:#fef2f2;">
  <h2 style="color:#dc2626;margin:0 0 8px;">⚠ Action required</h2>
  <p style="color:#7f1d1d;margin:0 0 16px;font-weight:600;">${escapeHtml(reason)}</p>
  <p style="color:#7f1d1d;margin:0 0 20px;">A patient has paid in Stripe but the booking did not land in Cliniko automatically. Please add it manually.</p>
  <div style="background:#fff;border-radius:8px;padding:16px;margin:16px 0;">
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:6px 0;color:#6b7280;width:40%;">Patient</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(m.patient_name || '—')}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Email</td><td style="padding:6px 0;">${escapeHtml(m.patient_email || (session && session.customer_email) || '—')}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Phone</td><td style="padding:6px 0;">${escapeHtml(m.patient_phone || '—')}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Treatment</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(m.treatment || '—')}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Duration</td><td style="padding:6px 0;">${escapeHtml(m.duration || '—')}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Date</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(m.appointment_date || '—')}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Time</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(m.appointment_time || '—')}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Paid</td><td style="padding:6px 0;font-weight:600;">£${escapeHtml(m.price || '0')}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Booking Ref</td><td style="padding:6px 0;">${escapeHtml(m.booking_ref || '—')}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Stripe Session</td><td style="padding:6px 0;font-family:monospace;font-size:11px;">${escapeHtml((session && session.id) || '—')}</td></tr>
      ${m.notes ? `<tr><td style="padding:6px 0;color:#6b7280;">Notes</td><td style="padding:6px 0;">${escapeHtml(m.notes)}</td></tr>` : ''}
    </table>
  </div>
  <p style="color:#7f1d1d;margin:16px 0 0;font-size:12px;"><strong>Underlying error:</strong> ${escapeHtml(error || 'unknown')}</p>
</div>`;

    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [clinicInbox], subject, html }),
    });
    if (!r.ok) {
        console.error('Clinic alert email failed:', await r.text());
    } else {
        console.log(`Clinic alert email sent → ${maskEmail(clinicInbox)}`);
    }
}

// ============================================
// SEND CONFIRMATION EMAIL (Resend)
// ============================================

async function sendConfirmationEmails({ name, email, treatment, duration, price, date, time, notes, bookingRef }) {
    const key = process.env.RESEND_API_KEY;
    if (!key || key === 're_your_resend_api_key_here') {
        console.warn('RESEND_API_KEY not set — skipping emails');
        return;
    }

    // Every interpolated field is HTML-escaped because patient_name and
    // notes are user-controlled (Stripe metadata is just a string store —
    // no schema validation on what we put in).
    const safeName     = escapeHtml(name || 'Patient');
    const safeEmail    = escapeHtml(email);
    const safeTreatmt  = escapeHtml(treatment || 'N/A');
    const safeDuration = escapeHtml(duration || 'N/A');
    const safeTime     = escapeHtml(time || 'TBC');
    const safePrice    = escapeHtml(price != null ? String(price) : '0');
    const safeNotes    = notes ? escapeHtml(notes) : '';
    const safeRef      = bookingRef ? escapeHtml(bookingRef) : '';
    const formattedDate = date
        ? new Date(date).toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
        : 'TBC';

    // Brand teal colours (match the Flutter AppColors palette):
    //   #248B9A primary, #ECF3F4 pale, #45B5C6 light, #175A64 dark.
    const patientHtml = `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px;">
  <h1 style="color:#248B9A;margin:0 0 4px;">LOSIC Clinic</h1>
  <p style="color:#6b7280;margin:0 0 20px;">Luton Osteopathic &amp; Sports Injury Clinic</p>
  <h2 style="color:#111827;">Booking Confirmed ✓</h2>
  <p>Dear ${safeName},</p>
  <p>Thank you for booking with LOSIC. Your appointment is confirmed and payment has been received.</p>
  ${safeRef ? `<div style="background:#ECF3F4;border:1px solid #45B5C6;border-radius:8px;padding:12px 16px;margin:16px 0;text-align:center;">
    <div style="font-size:12px;color:#6b7280;">Booking Reference</div>
    <div style="font-size:18px;font-weight:700;color:#248B9A;letter-spacing:1.5px;margin-top:2px;">${safeRef}</div>
  </div>` : ''}
  <div style="background:#f9fafb;border-radius:8px;padding:16px;margin:20px 0;">
    <table style="width:100%;border-collapse:collapse;">
      <tr><td style="padding:8px 0;color:#6b7280;width:40%;">Treatment</td><td style="padding:8px 0;font-weight:600;">${safeTreatmt}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280;">Duration</td><td style="padding:8px 0;font-weight:600;">${safeDuration}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280;">Date</td><td style="padding:8px 0;font-weight:600;">${formattedDate}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280;">Time</td><td style="padding:8px 0;font-weight:600;">${safeTime}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280;">Amount Paid</td><td style="padding:8px 0;font-weight:600;color:#248B9A;">£${safePrice}</td></tr>
    </table>
  </div>
  ${safeNotes ? `<p style="color:#6b7280;font-size:14px;"><strong>Notes:</strong> ${safeNotes}</p>` : ''}
  <div style="background:#ECF3F4;border-radius:8px;padding:16px;margin:20px 0;">
    <p style="margin:0;font-size:14px;color:#175A64;">📍 577 Dunstable Road, Luton, Bedfordshire, LU4 8QW</p>
    <p style="margin:8px 0 0;font-size:14px;color:#175A64;">⏰ Please arrive 10 minutes early</p>
    <p style="margin:8px 0 0;font-size:14px;color:#175A64;">❌ Free cancellation up to 24 hours before</p>
  </div>
  <p style="color:#6b7280;font-size:14px;">Questions? <a href="mailto:lutonosteo@gmail.com">lutonosteo@gmail.com</a> or <a href="tel:01582575045">01582 575 045</a></p>
</div>`;

    const clinicHtml = `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;">
  <h2 style="color:#248B9A;">New Booking — Payment Received</h2>
  <table style="width:100%;border-collapse:collapse;">
    ${safeRef ? `<tr><td style="padding:8px 0;color:#6b7280;width:40%;">Ref</td><td style="padding:8px 0;font-weight:700;color:#248B9A;letter-spacing:1px;">${safeRef}</td></tr>` : ''}
    <tr><td style="padding:8px 0;color:#6b7280;width:40%;">Patient</td><td style="padding:8px 0;font-weight:600;">${safeName}</td></tr>
    <tr><td style="padding:8px 0;color:#6b7280;">Email</td><td style="padding:8px 0;">${safeEmail || '—'}</td></tr>
    <tr><td style="padding:8px 0;color:#6b7280;">Treatment</td><td style="padding:8px 0;font-weight:600;">${safeTreatmt}</td></tr>
    <tr><td style="padding:8px 0;color:#6b7280;">Duration</td><td style="padding:8px 0;font-weight:600;">${safeDuration}</td></tr>
    <tr><td style="padding:8px 0;color:#6b7280;">Date</td><td style="padding:8px 0;font-weight:600;">${formattedDate}</td></tr>
    <tr><td style="padding:8px 0;color:#6b7280;">Time</td><td style="padding:8px 0;font-weight:600;">${safeTime}</td></tr>
    <tr><td style="padding:8px 0;color:#6b7280;">Paid</td><td style="padding:8px 0;font-weight:600;color:#248B9A;">£${safePrice}</td></tr>
    ${safeNotes ? `<tr><td style="padding:8px 0;color:#6b7280;">Notes</td><td style="padding:8px 0;">${safeNotes}</td></tr>` : ''}
  </table>
</div>`;

    // TODO: Confirm 'bookings@losic.co.uk' is verified in the Resend dashboard.
    // If it isn't, set RESEND_FROM=onboarding@resend.dev in Vercel env vars as a fallback.
    const from = process.env.RESEND_FROM || 'LOSIC Bookings <bookings@losic.co.uk>';

    const send = async (to, subject, html) => {
        const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from, to: [to], subject, html }),
        });
        if (!r.ok) console.error(`Email to ${to} failed:`, await r.text());
    };

    // Clinic notification email — goes to the live clinic inbox. The
    // hardcoded fallback is a safety net so emails don't silently
    // disappear, but it's a personal address — make the fallback loud
    // in logs so misconfiguration is caught quickly.
    let clinicInbox = process.env.CLINIC_EMAIL;
    if (!clinicInbox) {
        clinicInbox = 'lutonosteo@gmail.com';
        console.warn(
            'CLINIC_EMAIL env var not set — falling back to lutonosteo@gmail.com. ' +
            'Set CLINIC_EMAIL in Vercel to silence this warning.'
        );
    }

    await Promise.allSettled([
        email ? send(email, 'Your LOSIC Booking Confirmation', patientHtml) : Promise.resolve(),
        send(clinicInbox, `New Booking: ${displayName} — ${treatment} on ${formattedDate}`, clinicHtml),
    ]);
}

// ============================================
// STRIPE WEBHOOK
// ============================================

app.post('/api/stripe-webhook', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch (err) {
        console.error('Webhook signature error:', err.message);
        // Stripe sees the 400 and retries; we don't echo the error
        // back over the wire because the body is internet-visible.
        return res.status(400).send('Webhook signature verification failed');
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        console.log('Payment succeeded — session:', session.id);

        // Create Cliniko appointment
        await createClinikoAppointmentFromSession(session);

        // Send confirmation emails
        const m = session.metadata || {};
        await sendConfirmationEmails({
            name: m.patient_name,
            email: m.patient_email || session.customer_email,
            treatment: m.treatment,
            duration: m.duration,
            price: m.price,
            date: m.appointment_date,
            time: m.appointment_time,
            notes: m.notes,
            bookingRef: m.booking_ref,
        });
    }

    res.json({ received: true });
});

// ============================================
// STRIPE CHECKOUT SESSION  ← THE MAIN ENDPOINT
// ============================================

app.post('/api/create-checkout', rateLimit({ windowMs: 60_000, max: 5 }), async (req, res) => {
    try {
        const {
            treatment, duration, price,
            date, time,
            patient_name, patient_email, patient_phone,
            notes,
            booking_ref,
            success_url: clientSuccessUrl,
            cancel_url:  clientCancelUrl,
        } = req.body;

        if (!price) return res.status(400).json({ error: 'price is required' });
        if (!isValidPrice(price)) {
            return res.status(400).json({ error: 'price must be a positive number under £10,000' });
        }
        if (!treatment) return res.status(400).json({ error: 'treatment is required' });

        // Cap each metadata field so nobody can stuff garbage into Stripe.
        const m_treatment     = clampStr(treatment,    120);
        const m_duration      = clampStr(duration,      40);
        const m_date          = clampStr(date,          20);
        const m_time          = clampStr(time,          20);
        const m_patient_name  = clampStr(patient_name, 120);
        const m_patient_email = clampStr(patient_email,180);
        const m_patient_phone = clampStr(patient_phone, 40);
        const m_notes         = clampStr(notes,        400);
        const m_booking_ref   = clampStr(booking_ref,   40);

        // Deep-link return URLs — app passes its own losic:// scheme so the
        // Chrome Custom Tab closes automatically after payment. Allow-list
        // only our schemes; never trust an arbitrary URL from the client.
        const isAllowed = (u) =>
            typeof u === 'string' &&
            (u.startsWith('losic://') ||
             u.startsWith('https://losic.co.uk/') ||
             u.startsWith('https://www.losic.co.uk/'));
        const successBase = isAllowed(clientSuccessUrl) ? clientSuccessUrl : 'losic://payment/confirmed';
        const cancelBase  = isAllowed(clientCancelUrl)  ? clientCancelUrl  : 'losic://payment/cancelled';
        const appendParam = (url, key, value) =>
            url.includes('?') ? `${url}&${key}=${value}` : `${url}?${key}=${value}`;
        const successUrl  = appendParam(successBase, 'session_id', '{CHECKOUT_SESSION_ID}');
        const cancelUrl   = cancelBase;

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'gbp',
                    product_data: {
                        name: `${m_treatment}${m_duration ? ' — ' + m_duration : ''}`,
                        description: `LOSIC Clinic · ${m_date || 'TBC'} at ${m_time || 'TBC'}`,
                    },
                    unit_amount: Math.round(Number(price) * 100),
                },
                quantity: 1,
            }],
            mode: 'payment',
            customer_email: m_patient_email || undefined,
            success_url: successUrl,
            cancel_url: cancelUrl,
            metadata: {
                treatment:        m_treatment,
                duration:         m_duration,
                price:            String(price),
                appointment_date: m_date,
                appointment_time: m_time,
                patient_name:     m_patient_name,
                patient_email:    m_patient_email,
                patient_phone:    m_patient_phone,
                notes:            m_notes,
                booking_ref:      m_booking_ref,
            },
        });

        // Mask PII in logs — email gets partial masking, name dropped.
        // Vercel logs are visible to anyone with project access, and
        // we don't want patient identifiers sitting there in plaintext.
        console.log(`Checkout session ${session.id} | ${m_treatment} £${price} | ${maskEmail(m_patient_email)}`);
        res.json({ checkout_url: session.url, session_id: session.id });

    } catch (error) {
        return safeError(res, 'create-checkout', error);
    }
});

// ============================================
// CHECK IF STRIPE SESSION WAS PAID
// ============================================

async function _checkSessionHandler(req, res) {
    try {
        const { session_id } = req.query;
        if (!session_id) return res.status(400).json({ error: 'session_id is required' });
        // Stripe session IDs look like `cs_test_a1...` or `cs_live_...`.
        // Reject anything that doesn't match before hitting Stripe.
        if (!/^cs_(test|live)_[A-Za-z0-9]{1,200}$/.test(String(session_id))) {
            return res.status(400).json({ error: 'session_id is not a valid Stripe checkout id' });
        }

        const session = await stripe.checkout.sessions.retrieve(session_id);
        const paid = session.payment_status === 'paid';
        res.json({ paid, status: session.payment_status });
    } catch (error) {
        return safeError(res, 'check-session', error);
    }
}
app.get('/api/check-session',  _checkSessionHandler);
app.get('/api/session-status', _checkSessionHandler); // alias for future use

// ============================================
// BOOKED SLOTS (used by the app to grey-out taken times)
// ============================================
// GET /api/booked-slots?date=YYYY-MM-DD  ->  { booked: ["9:00 AM", ...] }
function _formatClinicTime(isoString) {
    const date = new Date(isoString);
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
    }).formatToParts(date);
    const hour24 = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const minute = parts.find(p => p.type === 'minute').value;
    const hour12 = hour24 === 0 ? 12 : (hour24 > 12 ? hour24 - 12 : hour24);
    const ampm = hour24 >= 12 ? 'PM' : 'AM';
    return `${hour12}:${minute} ${ampm}`;
}

app.get('/api/booked-slots', async (req, res) => {
    try {
        const { date } = req.query;
        if (!date) return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });
        if (!DATE_RE.test(String(date))) {
            return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
        }
        const from = `${date}T00:00:00`;
        const to   = `${date}T23:59:59`;
        const endpoint =
            `/individual_appointments` +
            `?q[]=${encodeURIComponent('appointment_start:>=' + from)}` +
            `&q[]=${encodeURIComponent('appointment_start:<=' + to)}` +
            `&per_page=100`;
        const data = await clinikoFetch(endpoint);
        const list = data.individual_appointments || [];
        const booked = list
            .filter((a) => !a.cancelled_at && !a.did_not_arrive)
            .map((a) => _formatClinicTime(a.appointment_start));
        res.json({ booked: Array.from(new Set(booked)) });
    } catch (error) {
        console.error('booked-slots error:', error.message);
        res.json({ booked: [] }); // non-fatal — app treats empty as "all open"
    }
});

// ============================================
// CLINIKO — GET APPOINTMENT TYPES
// ============================================

app.get('/api/appointment-types', async (req, res) => {
    try {
        const data = await clinikoFetch('/appointment_types');
        res.json(data.appointment_types || []);
    } catch (error) {
        return safeError(res, 'appointment-types', error);
    }
});

// ============================================
// CLINIKO — GET AVAILABLE TIMES
// ============================================

app.get('/api/available-times', async (req, res) => {
    try {
        const { date, appointment_type_id, practitioner_id } = req.query;
        if (!date) return res.status(400).json({ error: 'date is required' });
        if (!DATE_RE.test(String(date))) {
            return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
        }
        if (appointment_type_id && !NUMERIC_ID_RE.test(String(appointment_type_id))) {
            return res.status(400).json({ error: 'appointment_type_id must be numeric' });
        }
        if (practitioner_id && !NUMERIC_ID_RE.test(String(practitioner_id))) {
            return res.status(400).json({ error: 'practitioner_id must be numeric' });
        }

        let endpoint = `/available_times?from=${date}&to=${date}`;
        if (appointment_type_id) endpoint += `&appointment_type_id=${appointment_type_id}`;
        if (practitioner_id) endpoint += `&practitioner_id=${practitioner_id}`;

        const data = await clinikoFetch(endpoint);
        res.json(data.available_times || []);
    } catch (error) {
        return safeError(res, 'available-times', error);
    }
});

// ============================================
// CONFIG (Stripe publishable key for front-end)
// ============================================

app.get('/api/config', (req, res) => {
    // Lightweight integration health flags — booleans only, never the
    // actual keys. Useful to confirm what's wired in production
    // without having to grep Vercel env vars.
    const isReal = (v) => Boolean(v && !String(v).includes('your_') && !String(v).includes('placeholder'));
    res.json({
        stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
        clinicName: process.env.CLINIC_NAME || 'LOSIC',
        integrations: {
            stripe:  isReal(process.env.STRIPE_SECRET_KEY),
            stripeWebhook: isReal(process.env.STRIPE_WEBHOOK_SECRET),
            cliniko: isReal(process.env.CLINIKO_API_KEY),
            resend:  isReal(process.env.RESEND_API_KEY),
            resendFromConfigured: Boolean(process.env.RESEND_FROM),
            clinicEmailConfigured: Boolean(process.env.CLINIC_EMAIL),
        },
    });
});

// ============================================
// PRACTITIONERS
// ============================================

app.get('/api/practitioners', async (req, res) => {
    try {
        const data = await clinikoFetch('/practitioners');
        res.json(data.practitioners || []);
    } catch (error) {
        return safeError(res, 'practitioners', error);
    }
});

// ============================================
// START SERVER
// ============================================

// Start server locally (not on Vercel — Vercel uses the export below)
if (require.main === module) {
    app.listen(PORT, () => {
        console.log('');
        console.log('  LOSIC Booking Server running on http://localhost:' + PORT);
        console.log('');
        console.log('  Cliniko: ' + (CLINIKO_API_KEY && CLINIKO_API_KEY !== 'your_cliniko_api_key_here' ? '✓ Connected' : '✗ Add CLINIKO_API_KEY to .env'));
        console.log('  Stripe:  ' + (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY.includes('your_') ? '✓ Connected' : '✗ Add STRIPE_SECRET_KEY to .env'));
        console.log('  Resend:  ' + (process.env.RESEND_API_KEY && !process.env.RESEND_API_KEY.includes('your_') ? '✓ Connected' : '✗ Add RESEND_API_KEY to .env'));
        console.log('');
    });
}

// Export for Vercel serverless
module.exports = app;

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
// Cliniko IDs are 64-bit ints rendered as up to 19 digits, so the regex
// has to allow that full range; trimming to 12 silently rejected real
// IDs from /api/booked-slots.
const NUMERIC_ID_RE = /^\d{1,20}$/;

// LOSIC-specific Cliniko IDs. Captured from the live /api/cliniko-businesses
// endpoint and the practitioner list in lib/config/cliniko_mapping.dart on
// 29 Apr 2026. Both are 64-bit integers — see buildClinikoApptBody for why
// they're stored as strings rather than JS numbers.
const LOSIC_BUSINESS_ID    = '447416504502195880'; // Luton Osteopathic & Sports Injury Clinic Ltd
const LOSIC_PRACTITIONER_ID = '447416501566182462'; // David Leach (head osteopath)

// Build a Cliniko `/individual_appointments` POST body without ever
// running the 64-bit IDs through JS Number — values over 2^53 lose
// precision, which would make Cliniko reject the request as "no such
// appointment_type". Each ID is embedded as a raw JSON numeric literal
// straight from a string. Notes/start_time go through JSON.stringify so
// quotes and unicode escape correctly.
function buildClinikoApptBody({ apptStart, patientId, apptTypeId, businessId, practitionerId, notes }) {
    const safeStart = JSON.stringify(String(apptStart));
    const safeNotes = JSON.stringify(String(notes || ''));
    return '{' +
        `"appointment_start":${safeStart},` +
        `"patient_id":${String(patientId)},` +
        `"appointment_type_id":${String(apptTypeId)},` +
        `"business_id":${String(businessId)},` +
        `"practitioner_id":${String(practitionerId)},` +
        `"notes":${safeNotes}` +
    '}';
}

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

// Returns true if Cliniko already has a non-cancelled appointment for
// our practitioner at the exact start time. Used as a pre-flight check
// in the webhook so a paid booking that lands on an already-taken slot
// triggers the rebook + auto-refund flow instead of a silent
// double-booking. `time12h` is the same "9:00 AM"-style string the
// front-end posts in metadata, matched against the formatted Cliniko
// timestamps so we don't have to juggle timezones manually.
async function isSlotAlreadyBooked(date, time12h, practitionerId = LOSIC_PRACTITIONER_ID) {
    const from = `${date}T00:00:00Z`;
    const to   = `${date}T23:59:59Z`;
    const endpoint =
        `/individual_appointments` +
        `?q[]=${encodeURIComponent('starts_at:>=' + from)}` +
        `&q[]=${encodeURIComponent('starts_at:<=' + to)}` +
        `&per_page=100`;
    const data = await clinikoFetch(endpoint);
    const list = data.individual_appointments || [];
    return list.some((a) => {
        if (a.cancelled_at) return false;
        if (a.did_not_arrive) return false;
        // Cliniko sometimes returns practitioner as a numeric id and
        // sometimes as a sub-object — handle both.
        const apptPractId = String(a.practitioner_id ?? a.practitioner?.id ?? '');
        if (practitionerId && apptPractId && apptPractId !== String(practitionerId)) {
            return false;
        }
        return _formatClinicTime(a.starts_at) === time12h;
    });
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
        appointment_type_id,
    } = session.metadata || {};

    console.log(`Creating Cliniko appointment | ${treatment} | ${appointment_date} ${appointment_time}`);

    try {
        if (!appointment_date || !appointment_time) {
            throw new Error('appointment_date / appointment_time missing from session metadata');
        }
        // Cliniko rejects /individual_appointments without an
        // appointment_type_id, so bail early to a clinic alert email
        // instead of producing a half-booking.
        if (!appointment_type_id || !NUMERIC_ID_RE.test(String(appointment_type_id))) {
            throw new Error(
                `appointment_type_id missing or invalid in metadata (got: ${appointment_type_id || 'none'})`
            );
        }

        // Pre-flight conflict check. If two patients race for the same
        // slot, the second one's webhook lands here AFTER the first
        // booking is already in Cliniko. Detect it and trigger the
        // refund + rebook-email flow instead of silently double-booking.
        // Failure of the check itself is non-fatal: we log and proceed
        // so a transient Cliniko hiccup doesn't block real bookings.
        try {
            const conflict = await isSlotAlreadyBooked(appointment_date, appointment_time);
            if (conflict) {
                console.warn(
                    `[webhook] DOUBLE-BOOKING detected for ${appointment_date} ${appointment_time}` +
                    ` — refunding session ${session.id}`
                );
                await handleRebookFlow(session, 'slot already taken in Cliniko');
                return null; // signals: appointment NOT created — skip confirmation email
            }
        } catch (preErr) {
            console.error('[webhook] conflict pre-check failed (continuing):', preErr.message);
        }

        const patient = await findOrCreatePatient(patient_name, patient_email || session.customer_email, patient_phone);
        console.log(`Patient ready: id=${patient.id}`);

        const startTime = `${appointment_date}T${to24h(appointment_time)}:00`;

        const appt = await clinikoFetch('/individual_appointments', {
            method: 'POST',
            body: buildClinikoApptBody({
                apptStart: startTime,
                patientId: patient.id,
                apptTypeId: appointment_type_id,
                businessId: LOSIC_BUSINESS_ID,
                practitionerId: LOSIC_PRACTITIONER_ID,
                notes,
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
// REBOOK FLOW — auto-refund + patient email + clinic alert
// ============================================
// Fires when a paid Stripe session can't actually be booked into Cliniko
// (typically because two patients picked the same slot in the same race
// window). Refund is idempotency-keyed so a Stripe webhook retry is
// safe; emails are best-effort and logged on failure.

async function refundCheckoutSession(session) {
    if (!session?.payment_intent) {
        throw new Error('Cannot refund — Stripe session has no payment_intent');
    }
    return stripe.refunds.create(
        { payment_intent: session.payment_intent },
        { idempotencyKey: `rebook_refund_${session.id}` },
    );
}

async function sendPatientRebookEmail({ name, email, treatment, date, time, price, bookingRef }) {
    const key = process.env.RESEND_API_KEY;
    if (!key || key === 're_your_resend_api_key_here') {
        console.warn('RESEND_API_KEY not set — cannot send patient rebook email');
        return;
    }
    if (!email) {
        console.warn('[rebook-email] no patient email on session — cannot notify patient');
        return;
    }
    const safeName    = escapeHtml(name || 'Patient');
    const safeTreatmt = escapeHtml(treatment || 'your appointment');
    const safeTime    = escapeHtml(time || 'TBC');
    const safePrice   = escapeHtml(price != null ? String(price) : '');
    const safeRef     = bookingRef ? escapeHtml(bookingRef) : '';
    const formattedDate = date
        ? new Date(date).toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
        : 'TBC';

    const html = `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px;">
  <h1 style="color:#248B9A;margin:0 0 4px;">LOSIC Clinic</h1>
  <p style="color:#6b7280;margin:0 0 20px;">Luton Osteopathic &amp; Sports Injury Clinic</p>
  <h2 style="color:#b91c1c;margin-top:0;">Sorry — that slot was just taken</h2>
  <p>Dear ${safeName},</p>
  <p>You tried to book <strong>${safeTreatmt}</strong> on <strong>${formattedDate}</strong> at <strong>${safeTime}</strong>, but unfortunately another patient booked the same slot at the same time.</p>
  <div style="background:#ECF3F4;border:1px solid #45B5C6;border-radius:8px;padding:16px;margin:20px 0;">
    <h3 style="margin:0 0 8px;color:#175A64;">✓ Your money has been refunded automatically</h3>
    <p style="margin:0;color:#175A64;">A full refund${safePrice ? ' of <strong>£' + safePrice + '</strong>' : ''} has been sent back to your card. It usually arrives within 5&ndash;10 working days, depending on your bank.</p>
  </div>
  <p>To pick a different time, please open the LOSIC app and book again. We're sorry for the inconvenience.</p>
  ${safeRef ? `<p style="color:#6b7280;font-size:13px;">Original booking reference: <strong>${safeRef}</strong></p>` : ''}
  <div style="background:#f9fafb;border-radius:8px;padding:14px;margin:20px 0;">
    <p style="margin:0;font-size:14px;color:#374151;">Need help? <a href="mailto:lutonosteo@gmail.com" style="color:#248B9A;">lutonosteo@gmail.com</a> · <a href="tel:01582575045" style="color:#248B9A;">01582 575 045</a></p>
  </div>
</div>`;

    const from = process.env.RESEND_FROM || 'LOSIC Bookings <bookings@losic.co.uk>';
    console.log(`[rebook-email] sending → ${maskEmail(email)} | from=${from}`);
    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from,
            to: [email],
            subject: 'Booking unavailable — refund processed · LOSIC Clinic',
            html,
        }),
    });
    if (!r.ok) {
        console.error(`[rebook-email] FAILED → ${maskEmail(email)}:`, await r.text());
    } else {
        console.log(`[rebook-email] sent ok → ${maskEmail(email)}`);
    }
}

// Shared rebook flow used by both the webhook (automatic, on slot
// conflict) and the /api/rebook-email endpoint (manual). Refunds the
// Stripe charge, emails the patient, and alerts the clinic. Each step
// is wrapped in try/catch so one failure doesn't suppress the others.
async function handleRebookFlow(session, reason = 'slot already taken') {
    const m = session.metadata || {};
    const patientEmail = m.patient_email || session.customer_email;
    const patientName  = m.patient_name;
    const treatment    = m.treatment;
    const date         = m.appointment_date;
    const time         = m.appointment_time;
    const price        = m.price;
    const bookingRef   = m.booking_ref;

    console.log(`[rebook] triggered for session=${session.id} reason="${reason}"`);

    let refundOk = false;
    try {
        const refund = await refundCheckoutSession(session);
        refundOk = refund?.status === 'succeeded' || refund?.status === 'pending';
        console.log(`[rebook] refund ${refund?.id} status=${refund?.status}`);
    } catch (err) {
        console.error(`[rebook] refund FAILED: ${err.message}`);
    }

    try {
        await sendPatientRebookEmail({
            name: patientName,
            email: patientEmail,
            treatment, date, time, price,
            bookingRef,
        });
    } catch (err) {
        console.error(`[rebook] patient email FAILED: ${err.message}`);
    }

    try {
        await sendClinicAlert({
            subject: `⚠ Double-booking — auto-refunded ${patientName || 'patient'} (${treatment || 'unknown treatment'})`,
            reason: `${reason}. Patient was auto-refunded and emailed to rebook.`,
            error: refundOk ? 'Refund OK' : 'Refund attempt FAILED — manual refund may be required.',
            session,
        });
    } catch (err) {
        console.error(`[rebook] clinic alert FAILED: ${err.message}`);
    }

    return { refundOk };
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
    const displayName  = name || 'Patient';
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
        // Log both attempt and outcome so silent email failures
        // (Resend domain unverified, key invalid, account paused) are
        // visible in Vercel logs without needing a debugger attached.
        console.log(`[email] sending → ${maskEmail(to)} | from=${from} | subject="${subject}"`);
        const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from, to: [to], subject, html }),
        });
        if (!r.ok) {
            console.error(`[email] FAILED → ${maskEmail(to)}:`, await r.text());
        } else {
            console.log(`[email] sent ok → ${maskEmail(to)}`);
        }
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

    // Both the patient and the clinic get a LOSIC-branded confirmation.
    // Cliniko itself also sends its own confirmation/SMS to the patient,
    // but having a clear branded email from the booking app gives the
    // patient an immediate "yes — your money was taken and the booking
    // is confirmed" receipt independent of Cliniko's queue.
    if (email) {
        await send(
            email,
            `Booking Confirmed — ${treatment} on ${formattedDate} · LOSIC Clinic`,
            patientHtml,
        );
    } else {
        console.warn('[email] no patient email available — skipping patient confirmation');
    }
    await send(
        clinicInbox,
        `New Booking: ${displayName} — ${treatment} on ${formattedDate}`,
        clinicHtml,
    );
}

// ============================================
// STRIPE WEBHOOK
// ============================================

app.post('/api/stripe-webhook', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    // Loud, specific log when the secret is missing — otherwise the
    // failure looked identical to a forged request and you couldn't
    // tell from Vercel logs that Stripe was actually delivering events.
    if (!secret) {
        console.error(
            '[webhook] STRIPE_WEBHOOK_SECRET is NOT SET in Vercel env. ' +
            'Stripe will keep retrying and emails/Cliniko bookings will ' +
            'never fire until you add it.'
        );
        return res.status(500).send('Server misconfigured');
    }

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch (err) {
        console.error('[webhook] signature verification failed:', err.message);
        // Stripe sees the 400 and retries; we don't echo the error
        // back over the wire because the body is internet-visible.
        return res.status(400).send('Webhook signature verification failed');
    }

    console.log(`[webhook] received ${event.type} (event ${event.id})`);

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        console.log('Payment succeeded — session:', session.id);

        // Create Cliniko appointment. Returns null if a rebook flow
        // fired (double-booking → patient was auto-refunded + emailed)
        // so we skip the standard confirmation email below.
        const result = await createClinikoAppointmentFromSession(session);

        if (result === null) {
            console.log(`[webhook] rebook flow handled session=${session.id} — skipping confirmation email`);
        } else {
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
    }

    res.json({ received: true });
});

// ============================================
// /api/rebook-email — manual refund + rebook trigger
// ============================================
// Same flow the webhook fires automatically on a double-booking, but
// exposed as a POST endpoint so the clinic can manually rebook a
// patient (e.g. if a slot has to be cancelled by the practitioner
// after payment). Body: { session_id: "cs_test_..." }.
//
// Optional bearer-token gate: if ADMIN_TOKEN is set in Vercel env, the
// caller must send `Authorization: Bearer <token>`. If the env var is
// not set, the endpoint relies on rate limiting + the unguessability of
// Stripe session IDs, matching the security posture of the other
// admin-adjacent endpoints in this file.
app.post('/api/rebook-email', rateLimit({ windowMs: 60_000, max: 10 }), async (req, res) => {
    try {
        const adminToken = process.env.ADMIN_TOKEN;
        if (adminToken) {
            const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
            if (provided !== adminToken) {
                return res.status(401).json({ error: 'unauthorized' });
            }
        }

        const { session_id } = req.body || {};
        if (!session_id || !/^cs_(test|live)_[A-Za-z0-9]{1,200}$/.test(String(session_id))) {
            return res.status(400).json({ error: 'session_id is required and must be a Stripe checkout session id' });
        }

        const session = await stripe.checkout.sessions.retrieve(session_id);
        const { refundOk } = await handleRebookFlow(session, 'manual rebook trigger');
        res.json({ ok: true, refundOk });
    } catch (error) {
        return safeError(res, 'rebook-email', error);
    }
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
            appointment_type_id,
            success_url: clientSuccessUrl,
            cancel_url:  clientCancelUrl,
        } = req.body;

        if (!price) return res.status(400).json({ error: 'price is required' });
        if (!isValidPrice(price)) {
            return res.status(400).json({ error: 'price must be a positive number under £10,000' });
        }
        if (!treatment) return res.status(400).json({ error: 'treatment is required' });
        if (!patient_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(patient_email).trim())) {
            return res.status(400).json({ error: 'A valid email address is required.' });
        }
        if (!patient_name || !String(patient_name).trim()) {
            return res.status(400).json({ error: 'Your name is required.' });
        }
        if (!date || !time || !String(date).trim() || !String(time).trim()) {
            return res.status(400).json({ error: 'Please pick a date and time before paying.' });
        }
        // appointment_type_id is required so the webhook can create the
        // matching Cliniko appointment type. Reject before charging the
        // card if it's missing or not a positive integer.
        if (!appointment_type_id || !NUMERIC_ID_RE.test(String(appointment_type_id))) {
            return res.status(400).json({
                error: 'This treatment is not bookable online yet. Please call the clinic.',
            });
        }

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
        const m_appt_type_id  = clampStr(appointment_type_id, 24);

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
                treatment:           m_treatment,
                duration:            m_duration,
                price:               String(price),
                appointment_date:    m_date,
                appointment_time:    m_time,
                patient_name:        m_patient_name,
                patient_email:       m_patient_email,
                patient_phone:       m_patient_phone,
                notes:               m_notes,
                booking_ref:         m_booking_ref,
                appointment_type_id: m_appt_type_id,
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

app.get('/api/booked-slots', rateLimit({ windowMs: 60_000, max: 30 }), async (req, res) => {
    try {
        const { date } = req.query;
        if (!date) return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });
        if (!DATE_RE.test(String(date))) {
            return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
        }
        // Cliniko's GET /individual_appointments uses `starts_at` for the
        // schedule field, NOT `appointment_start` (that name only exists on
        // POST /individual_appointments when CREATING a record). Filter
        // values also need the `Z` UTC suffix — Cliniko silently returns
        // zero results for naïve datetimes. Without these two corrections
        // every slot was returned as available, which is why nothing was
        // greyed out in the app.
        const from = `${date}T00:00:00Z`;
        const to   = `${date}T23:59:59Z`;
        const endpoint =
            `/individual_appointments` +
            `?q[]=${encodeURIComponent('starts_at:>=' + from)}` +
            `&q[]=${encodeURIComponent('starts_at:<=' + to)}` +
            `&per_page=100`;
        const data = await clinikoFetch(endpoint);
        const list = data.individual_appointments || [];
        const booked = list
            .filter((a) => !a.cancelled_at && !a.did_not_arrive)
            .map((a) => _formatClinicTime(a.starts_at));
        res.json({ booked: Array.from(new Set(booked)) });
    } catch (error) {
        console.error('booked-slots error:', error.message);
        res.json({ booked: [] }); // non-fatal — app treats empty as "all open"
    }
});

// ============================================
// CLINIKO — GET AVAILABLE TIMES
// ============================================
// Rate-limited so a bot can't hammer Cliniko's request quota through us.

app.get('/api/available-times', rateLimit({ windowMs: 60_000, max: 30 }), async (req, res) => {
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

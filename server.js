require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const { google } = require('googleapis');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Config ---
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_TEXML_APP_ID = process.env.TELNYX_TEXML_APP_ID;
const TELNYX_FROM = process.env.TELNYX_FROM_NUMBER;
const ASSISTANT_GENERAL = process.env.TELNYX_ASSISTANT_GENERAL;
const ASSISTANT_SCHEDULER = process.env.TELNYX_ASSISTANT_SCHEDULER;
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;

// --- Google Calendar ---
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/calendar'],
});
const calendar = google.calendar({ version: 'v3', auth });

// In-memory call log
const callLog = [];

// --- API: Start a call ---
app.post('/api/call', async (req, res) => {
  const { to, assistantType, naam, context } = req.body;
  const assistantId = assistantType === 'scheduler' ? ASSISTANT_SCHEDULER : ASSISTANT_GENERAL;

  try {
    const response = await fetch(`https://api.telnyx.com/v2/texml/ai_calls/${TELNYX_TEXML_APP_ID}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TELNYX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        From: TELNYX_FROM,
        To: to,
        AIAssistantId: assistantId,
        AIAssistantDynamicVariables: {
          naam: naam || 'onbekend',
          context: context || 'Geen specifieke context.',
        },
        StatusCallback: `https://voice-assistant-production-3c25.up.railway.app/webhook/telnyx`,
        StatusCallbackEvent: 'initiated ringing answered completed',
      }),
    });

    const data = await response.json();
    console.log('Telnyx API response:', JSON.stringify(data));

    if (!response.ok) {
      const errorMsg = data.errors?.[0]?.detail || data.message || JSON.stringify(data);
      callLog.unshift({
        id: null,
        to,
        assistantType,
        naam,
        context,
        status: 'failed',
        startedAt: new Date().toISOString(),
        error: errorMsg,
      });
      return res.status(response.status).json({ ok: false, error: errorMsg });
    }

    const logEntry = {
      id: data.call_sid,
      to,
      assistantType,
      naam,
      context,
      status: data.status || 'queued',
      startedAt: new Date().toISOString(),
      transcript: null,
    };
    callLog.unshift(logEntry);
    res.json({ ok: true, call: logEntry });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- API: Check agenda (for Telnyx webhook) ---
app.post('/api/check-agenda', async (req, res) => {
  const datum = req.body.datum || req.body.date;
  const tijdVan = req.body.tijd_van || req.body.time_from || '08:00';
  const tijdTot = req.body.tijd_tot || req.body.time_to || '18:00';

  try {
    const result = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: `${datum}T${tijdVan}:00+02:00`,
      timeMax: `${datum}T${tijdTot}:00+02:00`,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = result.data.items || [];
    if (events.length === 0) {
      return res.json({
        beschikbaar: true,
        bericht: `Hans Guido is beschikbaar op ${datum} tussen ${tijdVan} en ${tijdTot}.`,
      });
    }

    const afspraken = events.map(e => ({
      titel: e.summary,
      start: new Date(e.start.dateTime || e.start.date).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }),
      eind: new Date(e.end.dateTime || e.end.date).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }),
    }));

    res.json({
      beschikbaar: false,
      afspraken,
      bericht: `Hans Guido heeft ${events.length} afspraak(en): ${afspraken.map(a => `${a.titel} (${a.start}-${a.eind})`).join(', ')}.`,
    });
  } catch (err) {
    console.error('Calendar error:', err.message);
    res.json({ beschikbaar: false, bericht: 'Kon de agenda niet ophalen.', error: err.message });
  }
});

// --- API: Create appointment (for Telnyx webhook) ---
app.post('/api/create-appointment', async (req, res) => {
  const datum = req.body.datum || req.body.date;
  const tijdVan = req.body.tijd_van || req.body.time_from;
  const tijdTot = req.body.tijd_tot || req.body.time_to;
  const titel = req.body.titel || req.body.title || 'Afspraak';
  const beschrijving = req.body.beschrijving || req.body.description || '';

  try {
    const result = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: {
        summary: titel,
        description: beschrijving,
        start: { dateTime: `${datum}T${tijdVan}:00+02:00`, timeZone: 'Europe/Amsterdam' },
        end: { dateTime: `${datum}T${tijdTot}:00+02:00`, timeZone: 'Europe/Amsterdam' },
      },
    });

    res.json({ succes: true, eventId: result.data.id, bericht: `Afspraak "${titel}" ingepland op ${datum} van ${tijdVan} tot ${tijdTot}.` });
  } catch (err) {
    console.error('Create event error:', err.message);
    res.json({ succes: false, bericht: 'Kon de afspraak niet inplannen.', error: err.message });
  }
});

// --- API: Dynamic variables for Telnyx ---
app.post('/api/dynamic-vars', (req, res) => {
  console.log('Dynamic vars request:', JSON.stringify(req.body));
  res.json({ naam: 'Jan Willem', context: '' });
});

// --- API: Get call log ---
app.get('/api/calls', (req, res) => {
  res.json(callLog);
});

// --- API: Get agenda for a day ---
app.get('/api/agenda/:datum', async (req, res) => {
  const datum = req.params.datum;
  try {
    const result = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: `${datum}T00:00:00+02:00`,
      timeMax: `${datum}T23:59:59+02:00`,
      singleEvents: true,
      orderBy: 'startTime',
    });
    res.json(result.data.items || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Telnyx webhook (call events, transcripts) ---
app.post('/webhook/telnyx', (req, res) => {
  console.log('Telnyx webhook:', JSON.stringify(req.body).substring(0, 1000));

  // TeXML events komen als form-encoded of JSON met CallSid/CallStatus
  const callSid = req.body?.CallSid || req.body?.data?.payload?.call_control_id || req.body?.data?.payload?.call_sid;
  const callStatus = req.body?.CallStatus || req.body?.data?.event_type;

  if (callSid) {
    const entry = callLog.find(c => c.id === callSid);
    if (entry) {
      if (callStatus === 'completed' || callStatus === 'call.hangup') {
        entry.status = 'completed';
      } else if (callStatus === 'in-progress' || callStatus === 'call.answered') {
        entry.status = 'in-progress';
      } else if (callStatus === 'busy' || callStatus === 'no-answer' || callStatus === 'failed') {
        entry.status = 'failed';
      }
    }
  }

  // Match op telefoonnummer als fallback (voor TeXML status callbacks)
  const to = req.body?.To || req.body?.Called;
  if (!callSid && to && callStatus) {
    const entry = callLog.find(c => c.to === to && c.status === 'queued');
    if (entry) {
      if (callStatus === 'completed') entry.status = 'completed';
      else if (callStatus === 'in-progress') entry.status = 'in-progress';
      else if (callStatus === 'busy' || callStatus === 'no-answer' || callStatus === 'failed') entry.status = 'failed';
    }
  }

  res.json({ ok: true });
});

// --- Start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Voice Assistant server draait op poort ${PORT}`);
});

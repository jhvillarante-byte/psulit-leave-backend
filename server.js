// Psulit Leave Request — approval backend
// Receives leave slip submissions, posts them to Telegram (Jen + group) with
// tappable Approve/Decline buttons, then auto-forwards the memo to the
// employee's own Telegram chat once Jen taps a button (or types a reply).

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const BOT_TOKEN = process.env.BOT_TOKEN;
const JEN_CHAT_ID = process.env.JEN_CHAT_ID || '1761414251';
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || '-5459473400';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Same Supabase project used by the other Psulit apps (payroll, kiosk, time clock).
// Set these two in Render's environment variables.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
if (!supabase) {
  console.error('Missing SUPABASE_URL / SUPABASE_KEY environment variables — approved leaves will NOT be saved for payroll.');
}

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN environment variable. Set it in Render before deploying.');
}

// Employee name -> their personal Telegram chat ID (from Psulit Payroll bot delivery list)
const EMPLOYEE_CHAT_IDS = {
  'Jazelle Espiritu': '6196732232',
  'Cristina Mirang': '6016568327',
  'Irene Maligat': '5582524994',
  'Angelica Besid': '329576744',
  'Joan Legaspi': '6274133553'
};

// Jazelle handles attendance updates — tagged in the group, and messaged directly, whenever a leave is approved
const JAZELLE_CHAT_ID = '6196732232';
const ATTENDANCE_TAG = `<a href="tg://user?id=${JAZELLE_CHAT_ID}">Jazelle</a>`;

// In-memory store: requestId -> request record. Also indexed by Jen's message_id
// so a typed reply (not just a button tap) can still resolve the same request.
// Note: this resets if the server restarts — approve promptly after submission,
// or ping Claude to add persistent storage if same-day gaps become an issue.
const pendingRequests = new Map();      // requestId -> record
const messageIdIndex = new Map();       // jenMessageId -> requestId

// Basic CORS so the Netlify-hosted form can call this backend
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

app.get('/', (req, res) => {
  res.send('Psulit Leave Request backend is running.');
});

// ---- Submit a new leave slip ----
// Expects multipart/form-data: photo (PNG blob), employee, branch, type, fromFmt, toFmt,
// reason, contact, slipNo, dayCount
app.post('/submit-leave', upload.single('photo'), async (req, res) => {
  try {
    const { employee, coverBy, branch, type, fromFmt, toFmt, dayCount, reason, contact, slipNo } = req.body;

    if (!req.file) return res.status(400).json({ ok: false, error: 'Missing photo' });
    if (!employee || !branch || !type) return res.status(400).json({ ok: false, error: 'Missing required fields' });

    const typeEmoji = { Sick: '🤒', Vacation: '🌴', 'Emergency/Other': '⚠️', 'Change Off': '🔄', 'Offset Request': '🔁' }[type] || '📋';
    const caption = `${typeEmoji} <b>${escapeHtml(type)} Leave Request</b> — ${escapeHtml(employee)} (${escapeHtml(branch)})`;

    const requestId = crypto.randomUUID();
    const approveButtons = {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `appr:${requestId}` },
        { text: '❌ Decline', callback_data: `decl:${requestId}` }
      ]]
    };

    // Send to Jen privately with tappable buttons — capture message_id as a fallback
    // matcher in case she prefers to type a reply instead of tapping.
    const jenResult = await sendPhoto(JEN_CHAT_ID, req.file.buffer, caption, approveButtons);
    // Send to the group for visibility (no buttons there — only Jen approves)
    await sendPhoto(GROUP_CHAT_ID, req.file.buffer, caption);

    if (!jenResult.ok) {
      console.error('Failed to send to Jen:', jenResult);
      return res.status(502).json({ ok: false, error: 'Telegram send failed' });
    }

    const jenMessageId = jenResult.result.message_id;
    const employeeChatId = EMPLOYEE_CHAT_IDS[employee] || null;
    const coverByChatId = EMPLOYEE_CHAT_IDS[coverBy] || null;

    const record = {
      employee, coverBy, coverByChatId, branch, type, fromFmt, toFmt, dayCount, reason, contact, slipNo,
      employeeChatId,
      jenMessageId,
      createdAt: Date.now(),
      status: 'pending'
    };

    pendingRequests.set(requestId, record);
    messageIdIndex.set(jenMessageId, requestId);

    res.json({ ok: true });
  } catch (err) {
    console.error('submit-leave error:', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ---- Telegram webhook: handles button taps and typed replies ----
app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200); // ack immediately, Telegram expects a fast response

  try {
    const update = req.body;

    // --- Button tap ---
    if (update.callback_query) {
      const cq = update.callback_query;
      const data = cq.data || '';
      const [action, requestId] = data.split(':');
      if (!requestId || (action !== 'appr' && action !== 'decl')) {
        return answerCallback(cq.id, 'Unrecognized action');
      }

      const record = pendingRequests.get(requestId);
      if (!record) {
        return answerCallback(cq.id, 'This request is no longer pending.');
      }

      const decision = action === 'appr' ? 'approved' : 'declined';
      await resolveRequest(requestId, record, decision);

      await answerCallback(cq.id, decision === 'approved' ? 'Approved ✅' : 'Declined ❌');

      // Update her message: remove buttons, show the outcome in the caption
      const decisionLine = decision === 'approved' ? '\n\n✅ <b>APPROVED</b>' : '\n\n❌ <b>DECLINED</b>';
      const typeEmoji = { Sick: '🤒', Vacation: '🌴', 'Emergency/Other': '⚠️', 'Change Off': '🔄', 'Offset Request': '🔁' }[record.type] || '📋';
      const baseCaption = `${typeEmoji} <b>${escapeHtml(record.type)} Leave Request</b> — ${escapeHtml(record.employee)} (${escapeHtml(record.branch)})`;
      await editCaption(JEN_CHAT_ID, cq.message.message_id, baseCaption + decisionLine);

      return;
    }

    // --- Typed reply (fallback for custom notes, or if she prefers typing) ---
    const msg = update.message;
    if (!msg) return;
    if (String(msg.chat.id) !== String(JEN_CHAT_ID)) return;
    if (!msg.reply_to_message) return;

    const requestId = messageIdIndex.get(msg.reply_to_message.message_id);
    const record = requestId ? pendingRequests.get(requestId) : null;
    if (!record) return; // not a reply to a tracked leave slip

    const replyText = (msg.text || '').trim();
    if (!replyText) return;

    const lower = replyText.toLowerCase();
    let decision = 'custom';
    if (lower.includes('approve') || replyText === '✅') decision = 'approved';
    else if (lower.includes('declin') || lower.includes('reject') || lower.includes('not approved') || replyText === '❌') decision = 'declined';

    await resolveRequest(requestId, record, decision, decision === 'custom' ? replyText : null);
  } catch (err) {
    console.error('telegram-webhook error:', err);
  }
});

// ---- Shared resolution logic for both button taps and typed replies ----
async function resolveRequest(requestId, record, decision, customText) {
  let memo;
  if (decision === 'approved') {
    memo = `✅ <b>APPROVED — Leave Request</b>\n\n${escapeHtml(record.employee)}, your ${escapeHtml(record.type)} leave from ${escapeHtml(record.fromFmt)} to ${escapeHtml(record.toFmt)} has been approved.\n\nPlease coordinate handover with your shift lead before your leave starts.\n\n— Jen, Psulit Money Changer`;
  } else if (decision === 'declined') {
    memo = `❌ <b>NOT APPROVED — Leave Request</b>\n\n${escapeHtml(record.employee)}, your ${escapeHtml(record.type)} leave request for ${escapeHtml(record.fromFmt)} to ${escapeHtml(record.toFmt)} was not approved at this time.\n\nMessage Jen directly if you'd like to discuss.\n\n— Jen, Psulit Money Changer`;
  } else {
    memo = `📋 <b>Update on your Leave Request</b>\n\n${escapeHtml(record.employee)}, regarding your ${escapeHtml(record.type)} leave (${escapeHtml(record.fromFmt)} to ${escapeHtml(record.toFmt)}):\n\n${escapeHtml(customText || '')}\n\n— Jen, Psulit Money Changer`;
  }

  if (decision === 'approved') {
    await saveApprovedLeaveToSupabase(record);
  }

  if (record.employeeChatId) {
    await sendMessage(record.employeeChatId, memo);
    await sendMessage(JEN_CHAT_ID, `✅ Sent to ${record.employee}.`);
  } else {
    await sendMessage(JEN_CHAT_ID, `⚠️ No Telegram chat ID on file for ${record.employee} — couldn't auto-send. Please message them directly.`);
  }

  const coverTag = record.coverByChatId
    ? `<a href="tg://user?id=${record.coverByChatId}">${escapeHtml(record.coverBy)}</a>`
    : escapeHtml(record.coverBy || '');

  const groupLine = decision === 'approved'
    ? `✅ ${record.employee}'s ${record.type} leave (${record.fromFmt} – ${record.toFmt}) — Approved\n\nShift covered by: ${coverTag}\n\n${ATTENDANCE_TAG}, please adjust schedule accordingly. Thank you!`
    : decision === 'declined'
      ? `❌ ${record.employee}'s ${record.type} leave (${record.fromFmt} – ${record.toFmt}) — Not approved`
      : `📋 Update posted on ${record.employee}'s ${record.type} leave request (${record.fromFmt} – ${record.toFmt})`;
  await sendMessage(GROUP_CHAT_ID, groupLine);

  if (decision === 'approved') {
    const jazelleMemo = `📋 <b>Schedule Adjustment Needed</b>\n\n${escapeHtml(record.employee)}'s ${escapeHtml(record.type)} leave (${escapeHtml(record.branch)}) was just approved:\n\n${escapeHtml(record.fromFmt)} – ${escapeHtml(record.toFmt)}\n\nShift covered by: ${escapeHtml(record.coverBy || 'TBD')}\n\nPlease adjust the schedule accordingly.\n\n— Jen`;
    await sendMessage(JAZELLE_CHAT_ID, jazelleMemo);

    if (record.coverByChatId) {
      const coverMemo = `📋 <b>Shift Coverage — ${escapeHtml(record.branch)}</b>\n\nYou're covering for ${escapeHtml(record.employee)} while they're on ${escapeHtml(record.type)} leave:\n\n${escapeHtml(record.fromFmt)} – ${escapeHtml(record.toFmt)}\n\nThanks for covering!\n\n— Jen, Psulit Money Changer`;
      await sendMessage(record.coverByChatId, coverMemo);
    } else if (record.coverBy) {
      await sendMessage(JEN_CHAT_ID, `⚠️ No Telegram chat ID on file for ${record.coverBy} (covering shift) — couldn't auto-send. Please notify them directly.`);
    }
  }

  record.status = decision;
  pendingRequests.delete(requestId);
  messageIdIndex.delete(record.jenMessageId);
}

// ---- Helpers ----
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Parses a display-formatted date like "August 24, 2026" into "2026-08-24".
// Falls back to null if it can't be parsed, so a bad date never crashes the save.
function toISODate(fmtStr) {
  if (!fmtStr) return null;
  const d = new Date(fmtStr);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// Saves an approved leave into Supabase so the Payroll app can automatically
// deduct leave credits and mark the days as leave — no manual re-entry needed.
async function saveApprovedLeaveToSupabase(record) {
  if (!supabase) {
    console.error('Supabase not configured — could not save approved leave for', record.employee);
    return;
  }
  const dateFrom = toISODate(record.fromFmt);
  const dateTo = toISODate(record.toFmt);
  if (!dateFrom || !dateTo) {
    console.error('Could not parse leave dates for', record.employee, record.fromFmt, record.toFmt);
    return;
  }
  try {
    const { error } = await supabase.from('leave_records').insert({
      employee_name: record.employee,
      leave_type: record.type,
      date_from: dateFrom,
      date_to: dateTo,
      day_count: parseFloat(record.dayCount) || 0,
      branch: record.branch,
      reason: record.reason || null,
      status: 'approved'
    });
    if (error) console.error('Could not save approved leave to Supabase:', error.message);
  } catch (err) {
    console.error('Could not save approved leave to Supabase:', err.message);
  }
}

async function sendPhoto(chatId, buffer, caption, replyMarkup) {
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
  form.append('photo', new Blob([buffer], { type: 'image/png' }), 'leave-slip.png');
  const resp = await fetch(`${TELEGRAM_API}/sendPhoto`, { method: 'POST', body: form });
  return resp.json();
}

async function sendMessage(chatId, text) {
  const resp = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
  return resp.json();
}

async function editCaption(chatId, messageId, caption) {
  const resp = await fetch(`${TELEGRAM_API}/editMessageCaption`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      caption,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] }
    })
  });
  return resp.json();
}

async function answerCallback(callbackQueryId, text) {
  const resp = await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false })
  });
  return resp.json();
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Leave request backend listening on port ${PORT}`));

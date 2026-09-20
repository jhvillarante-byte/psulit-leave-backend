const { createClient } = require('@supabase/supabase-js');

const BOT_TOKEN = process.env.BOT_TOKEN;
const JEN_CHAT_ID = process.env.JEN_CHAT_ID || '1761414251';
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || '-5459473400';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Leave-request project: holds pending approval state for this app
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

// Payroll project: holds leave_records, which Payroll sums to compute
// remaining leave credits. Approved leaves are written here so balances
// update automatically — there is no separate balance field to maintain.
const PAYROLL_SUPABASE_URL = process.env.PAYROLL_SUPABASE_URL;
const PAYROLL_SUPABASE_SECRET_KEY = process.env.PAYROLL_SUPABASE_SECRET_KEY;
const payrollSupabase = (PAYROLL_SUPABASE_URL && PAYROLL_SUPABASE_SECRET_KEY)
  ? createClient(PAYROLL_SUPABASE_URL, PAYROLL_SUPABASE_SECRET_KEY)
  : null;

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

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

// Shared resolution logic for both button taps and typed replies.
// `record` here uses the Supabase column names (snake_case).
async function resolveRequest(requestId, record, decision, customText) {
  let memo;
  if (decision === 'approved') {
    memo = `✅ <b>APPROVED — Leave Request</b>\n\n${escapeHtml(record.employee)}, your ${escapeHtml(record.type)} leave from ${escapeHtml(record.from_fmt)} to ${escapeHtml(record.to_fmt)} has been approved.\n\n— Jen, Psulit Money Changer`;
  } else if (decision === 'declined') {
    memo = `❌ <b>NOT APPROVED — Leave Request</b>\n\n${escapeHtml(record.employee)}, your ${escapeHtml(record.type)} leave request for ${escapeHtml(record.from_fmt)} to ${escapeHtml(record.to_fmt)} was not approved at this time.\n\nMessage Jen directly if you'd like to discuss.\n\n— Jen, Psulit Money Changer`;
  } else {
    memo = `📋 <b>Update on your Leave Request</b>\n\n${escapeHtml(record.employee)}, regarding your ${escapeHtml(record.type)} leave (${escapeHtml(record.from_fmt)} to ${escapeHtml(record.to_fmt)}):\n\n${escapeHtml(customText || '')}\n\n— Jen, Psulit Money Changer`;
  }

  if (record.employee_chat_id) {
    await sendMessage(record.employee_chat_id, memo);
    await sendMessage(JEN_CHAT_ID, `✅ Sent to ${record.employee}.`);
  } else {
    await sendMessage(JEN_CHAT_ID, `⚠️ No Telegram chat ID on file for ${record.employee} — couldn't auto-send. Please message them directly.`);
  }

  const coverTag = record.cover_by_chat_id
    ? `<a href="tg://user?id=${record.cover_by_chat_id}">${escapeHtml(record.cover_by)}</a>`
    : escapeHtml(record.cover_by || '');

  const groupLine = decision === 'approved'
    ? `✅ ${record.employee}'s ${record.type} leave (${record.from_fmt} – ${record.to_fmt}) — Approved\n\nShift covered by: ${coverTag}\n\n${ATTENDANCE_TAG}, please adjust schedule accordingly. Thank you!`
    : decision === 'declined'
      ? `❌ ${record.employee}'s ${record.type} leave (${record.from_fmt} – ${record.to_fmt}) — Not approved`
      : `📋 Update posted on ${record.employee}'s ${record.type} leave request (${record.from_fmt} – ${record.to_fmt})`;
  await sendMessage(GROUP_CHAT_ID, groupLine);

  if (decision === 'approved') {
    // Write into Payroll's leave_records — this is what deducts the credit,
    // since Payroll computes remaining balances by summing these rows.
    await recordLeaveInPayroll(record);

    const jazelleMemo = `📋 <b>Schedule Adjustment Needed</b>\n\n${escapeHtml(record.employee)}'s ${escapeHtml(record.type)} leave (${escapeHtml(record.branch)}) was just approved:\n\n${escapeHtml(record.from_fmt)} – ${escapeHtml(record.to_fmt)}\n\nShift covered by: ${escapeHtml(record.cover_by || 'TBD')}\n\nPlease adjust the schedule accordingly.\n\n— Jen`;
    await sendMessage(JAZELLE_CHAT_ID, jazelleMemo);

    if (record.cover_by_chat_id) {
      const coverMemo = `📋 <b>Shift Coverage — ${escapeHtml(record.branch)}</b>\n\nYou're covering for ${escapeHtml(record.employee)} while they're on ${escapeHtml(record.type)} leave:\n\n${escapeHtml(record.from_fmt)} – ${escapeHtml(record.to_fmt)}\n\nThanks for covering!\n\n— Jen, Psulit Money Changer`;
      await sendMessage(record.cover_by_chat_id, coverMemo);
    } else if (record.cover_by) {
      await sendMessage(JEN_CHAT_ID, `⚠️ No Telegram chat ID on file for ${record.cover_by} (covering shift) — couldn't auto-send. Please notify them directly.`);
    }
  }

  await supabase.from('leave_requests').update({ status: decision }).eq('request_id', requestId);
}

// Writes an approved leave into Payroll's leave_records table.
// Payroll derives remaining credits by summing this table, so inserting here
// IS the deduction. Offset Requests are tracked in hours rather than whole
// days, matching how existing offset rows are stored (day_count 0 + hours).
async function recordLeaveInPayroll(record) {
  if (!payrollSupabase) {
    console.error('Payroll Supabase not configured — skipping leave_records insert');
    await sendMessage(JEN_CHAT_ID, `⚠️ ${record.employee}'s leave was approved, but the payroll connection isn't configured, so credits were NOT deducted. Please record it manually.`);
    return;
  }

  const isOffset = record.type === 'Offset Request';
  const hours = record.hours_requested ? Number(record.hours_requested) : null;

  const row = {
    employee_name: record.employee,
    leave_type: record.type,
    date_from: record.date_from,
    date_to: record.date_to,
    day_count: isOffset ? 0 : Number(record.day_count || 0),
    branch: record.branch,
    reason: record.reason,
    status: 'approved',
    hours_requested: isOffset ? hours : null
  };

  const { error } = await payrollSupabase.from('leave_records').insert(row);

  if (error) {
    console.error('Payroll leave_records insert failed:', error);
    await sendMessage(JEN_CHAT_ID, `⚠️ ${record.employee}'s leave was approved, but recording it to payroll failed — credits were NOT deducted. Please add it manually.`);
  }
}

module.exports = {
  BOT_TOKEN, JEN_CHAT_ID, GROUP_CHAT_ID, TELEGRAM_API,
  supabase, payrollSupabase, EMPLOYEE_CHAT_IDS, JAZELLE_CHAT_ID, ATTENDANCE_TAG,
  escapeHtml, sendPhoto, sendMessage, editCaption, answerCallback, resolveRequest,
  recordLeaveInPayroll
};

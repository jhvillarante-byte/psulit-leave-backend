const { createClient } = require('@supabase/supabase-js');

const BOT_TOKEN = process.env.BOT_TOKEN;
const JEN_CHAT_ID = process.env.JEN_CHAT_ID || '1761414251';
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || '-5459473400';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Supabase is no longer used to store leave requests. This optional connection
// is ONLY to the existing Payroll project, where approved leave deductions are recorded.
const PAYROLL_SUPABASE_URL = process.env.PAYROLL_SUPABASE_URL;
const PAYROLL_SUPABASE_SECRET_KEY = process.env.PAYROLL_SUPABASE_SECRET_KEY;
const payrollSupabase = (PAYROLL_SUPABASE_URL && PAYROLL_SUPABASE_SECRET_KEY)
  ? createClient(PAYROLL_SUPABASE_URL, PAYROLL_SUPABASE_SECRET_KEY)
  : null;

const EMPLOYEE_CHAT_IDS = {
  'Jazelle Espiritu': '6196732232',
  'Cristina Mirang': '6016568327',
  'Irene Maligat': '5582524994',
  'Angelica Besid': '329576744',
  'Joan Legaspi': '6274133553'
};
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
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
  return resp.json();
}

async function sheetRequest(action, payload = {}) {
  const url = process.env.GOOGLE_SHEETS_SYNC_URL;
  const secret = process.env.GOOGLE_SHEETS_SYNC_SECRET;
  if (!url || !secret) throw new Error('Google Sheets connection is not configured');
  const resp = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ secret, action, ...payload })
  });
  let data = {};
  try { data = await resp.json(); } catch (_) {}
  if (!resp.ok || data.ok !== true) throw new Error(data.error || `Google Sheets request failed (HTTP ${resp.status})`);
  return data;
}

async function createPendingRequest(record) {
  return sheetRequest('create', { record });
}
async function getRequestById(requestId) {
  const data = await sheetRequest('get', { request_id: requestId });
  return data.record || null;
}
async function getPendingByMessageId(messageId) {
  const data = await sheetRequest('getByMessage', { message_id: String(messageId) });
  return data.record || null;
}
async function updateRequest(requestId, patch) {
  return sheetRequest('update', { request_id: requestId, patch });
}

async function editCaption(chatId, messageId, caption) {
  const resp = await fetch(`${TELEGRAM_API}/editMessageCaption`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, caption, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } })
  });
  return resp.json();
}
async function answerCallback(callbackQueryId, text) {
  const resp = await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false })
  });
  return resp.json();
}

async function resolveRequest(requestId, record, decision, customText) {
  if (decision === 'custom') {
    if (record.employee_chat_id) await sendMessage(record.employee_chat_id,
      `📋 <b>Update on your Leave Request</b>\n\n${escapeHtml(record.employee)}, regarding your ${escapeHtml(record.type)} leave (${escapeHtml(record.from_fmt)} to ${escapeHtml(record.to_fmt)}):\n\n${escapeHtml(customText || '')}\n\n— Jen, Psulit Money Changer`);
    return { ok: true, custom: true };
  }
  if (decision !== 'approved' && decision !== 'declined') throw new Error('Invalid leave decision');

  // Apps Script claims the pending -> approved/declined transition under a lock.
  // Only the first successful transition triggers notifications and payroll write.
  const resolved = await sheetRequest('resolve', {
    request_id: requestId, decision, approved_by: 'Jen', decided_at: new Date().toISOString()
  });
  if (resolved.alreadyProcessed) return { ok: false, alreadyProcessed: true };
  record = resolved.record || record;

  const memo = decision === 'approved'
    ? `✅ <b>APPROVED — Leave Request</b>\n\n${escapeHtml(record.employee)}, your ${escapeHtml(record.type)} leave from ${escapeHtml(record.from_fmt)} to ${escapeHtml(record.to_fmt)} has been approved.\n\n— Jen, Psulit Money Changer`
    : `❌ <b>NOT APPROVED — Leave Request</b>\n\n${escapeHtml(record.employee)}, your ${escapeHtml(record.type)} leave request for ${escapeHtml(record.from_fmt)} to ${escapeHtml(record.to_fmt)} was not approved at this time.\n\nMessage Jen directly if you'd like to discuss.\n\n— Jen, Psulit Money Changer`;
  if (record.employee_chat_id) await sendMessage(record.employee_chat_id, memo);
  else await sendMessage(JEN_CHAT_ID, `⚠️ No Telegram chat ID on file for ${escapeHtml(record.employee)} — couldn't auto-send the decision.`);

  if (decision === 'approved') {
    const coverTag = record.cover_by_chat_id
      ? `<a href="tg://user?id=${record.cover_by_chat_id}">${escapeHtml(record.cover_by)}</a>`
      : escapeHtml(record.cover_by || 'TBD');
    const groupLine = `✅ <b>${escapeHtml(record.employee)}'s ${escapeHtml(record.type)} leave APPROVED</b>\n\n${escapeHtml(record.from_fmt)} – ${escapeHtml(record.to_fmt)} (${escapeHtml(record.day_count || '')} day/s)\nBranch: ${escapeHtml(record.branch)}\nShift covered by: ${coverTag}\n\n${ATTENDANCE_TAG}, please adjust the schedule accordingly. Thank you!`;
    await sendMessage(GROUP_CHAT_ID, groupLine);

    await recordLeaveInPayroll(record);

    const jazelleMemo = `📋 <b>Schedule Adjustment Needed</b>\n\n${escapeHtml(record.employee)}'s ${escapeHtml(record.type)} leave (${escapeHtml(record.branch)}) was just approved:\n\n${escapeHtml(record.from_fmt)} – ${escapeHtml(record.to_fmt)}\n\nShift covered by: ${escapeHtml(record.cover_by || 'TBD')}\n\nPlease adjust the schedule accordingly.\n\n— Jen`;
    await sendMessage(JAZELLE_CHAT_ID, jazelleMemo);
    if (record.cover_by_chat_id) {
      const coverMemo = `📋 <b>Shift Coverage — ${escapeHtml(record.branch)}</b>\n\nYou're covering for ${escapeHtml(record.employee)} while they're on ${escapeHtml(record.type)} leave:\n\n${escapeHtml(record.from_fmt)} – ${escapeHtml(record.to_fmt)}\n\nThanks for covering!\n\n— Jen, Psulit Money Changer`;
      await sendMessage(record.cover_by_chat_id, coverMemo);
    } else if (record.cover_by) {
      await sendMessage(JEN_CHAT_ID, `⚠️ No Telegram chat ID on file for ${escapeHtml(record.cover_by)} (covering shift) — please notify them directly.`);
    }
  }
  return { ok: true, status: decision };
}

// Keep the existing Payroll integration only. This does not store leave requests.
async function recordLeaveInPayroll(record) {
  if (!payrollSupabase) {
    console.error('Payroll Supabase is not configured; leave request itself remains safely stored in Google Sheets.');
    await sendMessage(JEN_CHAT_ID, `⚠️ ${escapeHtml(record.employee)}'s leave was approved, but the payroll database connection is not configured. Please check the payroll deduction.`);
    return;
  }
  const isOffset = record.type === 'Offset Request';
  const hours = record.hours_requested ? Number(record.hours_requested) : null;
  const row = {
    employee_name: record.employee,
    leave_type: record.type,
    date_from: record.date_from || null,
    date_to: record.date_to || null,
    day_count: isOffset ? 0 : Number(record.day_count || 0),
    branch: record.branch,
    reason: record.reason,
    status: 'approved',
    hours_requested: isOffset ? hours : null
  };
  const { error } = await payrollSupabase.from('leave_records').insert(row);
  if (error) {
    console.error('Payroll leave_records insert failed:', error);
    await sendMessage(JEN_CHAT_ID, `⚠️ ${escapeHtml(record.employee)}'s leave was approved and saved to Google Sheets, but the payroll deduction write failed. Please check payroll before the next cutoff.`);
  }
}

module.exports = {
  BOT_TOKEN, JEN_CHAT_ID, GROUP_CHAT_ID, TELEGRAM_API,
  EMPLOYEE_CHAT_IDS, JAZELLE_CHAT_ID, ATTENDANCE_TAG,
  escapeHtml, sendPhoto, sendMessage, editCaption, answerCallback,
  createPendingRequest, getRequestById, getPendingByMessageId, updateRequest,
  resolveRequest, recordLeaveInPayroll
};

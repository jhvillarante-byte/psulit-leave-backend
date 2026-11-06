const crypto = require('crypto');
const multipart = require('parse-multipart-data');
const {
  JEN_CHAT_ID, GROUP_CHAT_ID, supabase, EMPLOYEE_CHAT_IDS,
  escapeHtml, sendPhoto
} = require('./_lib/shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const contentType = event.headers['content-type'] || event.headers['Content-Type'];
    if (!contentType || !contentType.includes('multipart/form-data')) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Expected multipart/form-data' }) };
    }
    const boundary = multipart.getBoundary(contentType);
    const bodyBuffer = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
    const parts = multipart.parse(bodyBuffer, boundary);

    const fields = {};
    let photoBuffer = null;
    for (const part of parts) {
      if (part.filename) {
        photoBuffer = part.data;
      } else if (part.name) {
        fields[part.name] = part.data.toString('utf8');
      }
    }

    const { employee, coverBy, branch, type, fromFmt, toFmt, dateFrom, dateTo, dayCount, hoursRequested, reason, contact, slipNo } = fields;

    if (!photoBuffer) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing photo' }) };
    if (!employee || !branch || !type) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing required fields' }) };

    const typeEmoji = { Sick: '🤒', Vacation: '🌴', 'Emergency/Other': '⚠️' }[type] || '📋';
    const caption = `${typeEmoji} <b>${escapeHtml(type)} Leave Request</b> — ${escapeHtml(employee)} (${escapeHtml(branch)})`;

    const requestId = crypto.randomUUID();
    const approveButtons = {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `appr:${requestId}` },
        { text: '❌ Decline', callback_data: `decl:${requestId}` }
      ]]
    };

    // Create the pending database record before notifying Jen, so an immediate
    // button tap can always find the request. Pending requests stay private.
    const employeeChatId = EMPLOYEE_CHAT_IDS[employee] || null;
    const coverByChatId = EMPLOYEE_CHAT_IDS[coverBy] || null;

    const { error: insertError } = await supabase.from('leave_requests').insert({
      request_id: requestId,
      employee, cover_by: coverBy || null, cover_by_chat_id: coverByChatId,
      branch, type, from_fmt: fromFmt, to_fmt: toFmt,
      date_from: dateFrom || null, date_to: dateTo || null,
      day_count: dayCount, hours_requested: hoursRequested ? Number(hoursRequested) : null,
      reason, contact, slip_no: slipNo,
      employee_chat_id: employeeChatId,
      status: 'pending'
    });

    if (insertError) {
      console.error('Supabase insert error:', insertError);
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Database error' }) };
    }

    const jenResult = await sendPhoto(JEN_CHAT_ID, photoBuffer, caption, approveButtons);
    if (!jenResult.ok) {
      console.error('Failed to send to Jen:', jenResult);
      await supabase.from('leave_requests').update({ status: 'notification_failed' }).eq('request_id', requestId);
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'Telegram send failed' }) };
    }

    await supabase.from('leave_requests')
      .update({ jen_message_id: jenResult.result.message_id })
      .eq('request_id', requestId);

    // No Google Sheets write or staff-group post here: only approved requests
    // are entered in the leave ledger and announced to the group.

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('submit-leave error:', err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Server error' }) };
  }
};

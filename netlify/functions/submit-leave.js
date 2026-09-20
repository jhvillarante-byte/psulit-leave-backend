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

    const jenResult = await sendPhoto(JEN_CHAT_ID, photoBuffer, caption, approveButtons);
    await sendPhoto(GROUP_CHAT_ID, photoBuffer, caption);

    if (!jenResult.ok) {
      console.error('Failed to send to Jen:', jenResult);
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'Telegram send failed' }) };
    }

    const jenMessageId = jenResult.result.message_id;
    const employeeChatId = EMPLOYEE_CHAT_IDS[employee] || null;
    const coverByChatId = EMPLOYEE_CHAT_IDS[coverBy] || null;

    const { error } = await supabase.from('leave_requests').insert({
      request_id: requestId,
      employee, cover_by: coverBy || null, cover_by_chat_id: coverByChatId,
      branch, type, from_fmt: fromFmt, to_fmt: toFmt,
      date_from: dateFrom || null, date_to: dateTo || null,
      day_count: dayCount, hours_requested: hoursRequested ? Number(hoursRequested) : null,
      reason, contact, slip_no: slipNo,
      employee_chat_id: employeeChatId,
      jen_message_id: jenMessageId,
      status: 'pending'
    });

    if (error) {
      console.error('Supabase insert error:', error);
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Database error' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('submit-leave error:', err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Server error' }) };
  }
};

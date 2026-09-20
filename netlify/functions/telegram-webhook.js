const {
  JEN_CHAT_ID, supabase, escapeHtml,
  editCaption, answerCallback, resolveRequest
} = require('./_lib/shared');

exports.handler = async (event) => {
  try {
    const update = JSON.parse(event.body || '{}');

    // --- Button tap ---
    if (update.callback_query) {
      const cq = update.callback_query;
      const data = cq.data || '';
      const [action, requestId] = data.split(':');

      if (!requestId || (action !== 'appr' && action !== 'decl')) {
        await answerCallback(cq.id, 'Unrecognized action');
        return { statusCode: 200, body: 'ok' };
      }

      const { data: rows } = await supabase
        .from('leave_requests')
        .select('*')
        .eq('request_id', requestId)
        .limit(1);
      const record = rows && rows[0];

      if (!record || record.status !== 'pending') {
        await answerCallback(cq.id, 'This request is no longer pending.');
        return { statusCode: 200, body: 'ok' };
      }

      const decision = action === 'appr' ? 'approved' : 'declined';
      await resolveRequest(requestId, record, decision);
      await answerCallback(cq.id, decision === 'approved' ? 'Approved ✅' : 'Declined ❌');

      const decisionLine = decision === 'approved' ? '\n\n✅ <b>APPROVED</b>' : '\n\n❌ <b>DECLINED</b>';
      const typeEmoji = { Sick: '🤒', Vacation: '🌴', 'Emergency/Other': '⚠️' }[record.type] || '📋';
      const baseCaption = `${typeEmoji} <b>${escapeHtml(record.type)} Leave Request</b> — ${escapeHtml(record.employee)} (${escapeHtml(record.branch)})`;
      await editCaption(JEN_CHAT_ID, cq.message.message_id, baseCaption + decisionLine);

      return { statusCode: 200, body: 'ok' };
    }

    // --- Typed reply (fallback for custom notes, or if she prefers typing) ---
    const msg = update.message;
    if (!msg) return { statusCode: 200, body: 'ok' };
    if (String(msg.chat.id) !== String(JEN_CHAT_ID)) return { statusCode: 200, body: 'ok' };
    if (!msg.reply_to_message) return { statusCode: 200, body: 'ok' };

    const { data: rows } = await supabase
      .from('leave_requests')
      .select('*')
      .eq('jen_message_id', msg.reply_to_message.message_id)
      .eq('status', 'pending')
      .limit(1);
    const record = rows && rows[0];
    if (!record) return { statusCode: 200, body: 'ok' };

    const replyText = (msg.text || '').trim();
    if (!replyText) return { statusCode: 200, body: 'ok' };

    const lower = replyText.toLowerCase();
    let decision = 'custom';
    if (lower.includes('approve') || replyText === '✅') decision = 'approved';
    else if (lower.includes('declin') || lower.includes('reject') || lower.includes('not approved') || replyText === '❌') decision = 'declined';

    await resolveRequest(record.request_id, record, decision, decision === 'custom' ? replyText : null);

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('telegram-webhook error:', err);
    return { statusCode: 200, body: 'ok' }; // still ack Telegram so it doesn't retry forever
  }
};

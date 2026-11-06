const {
  JEN_CHAT_ID, escapeHtml, editCaption, answerCallback,
  getRequestById, getPendingByMessageId, resolveRequest
} = require('./_lib/shared');

exports.handler = async (event) => {
  try {
    const update = JSON.parse(event.body || '{}');

    // Temporary admin diagnostic: ask the bot for the numeric ID of its group.
    // The command is answered privately to Jen and does not affect leave decisions.
    const incomingMessage = update.message;
    if (incomingMessage && incomingMessage.chat &&
        ['group', 'supergroup'].includes(incomingMessage.chat.type) &&
        /^\/groupid(?:@\w+)?$/i.test((incomingMessage.text || '').trim())) {
      const { sendMessage } = require('./_lib/shared');
      await sendMessage(JEN_CHAT_ID,
        `PSulit Leave Requests group ID: <code>${incomingMessage.chat.id}</code>`);
      return { statusCode: 200, body: 'ok' };
    }
    if (update.callback_query) {
      const cq = update.callback_query;
      if (!cq.message || String(cq.message.chat.id) !== String(JEN_CHAT_ID)) {
        await answerCallback(cq.id, 'Only the designated approver can decide this request.');
        return { statusCode: 200, body: 'ok' };
      }
      const [action, requestId] = String(cq.data || '').split(':');
      if (!requestId || (action !== 'appr' && action !== 'decl')) {
        await answerCallback(cq.id, 'Unrecognized action');
        return { statusCode: 200, body: 'ok' };
      }
      const record = await getRequestById(requestId);
      if (!record || record.status !== 'pending' || String(record.jen_message_id) !== String(cq.message.message_id)) {
        await answerCallback(cq.id, 'This request is no longer pending.');
        return { statusCode: 200, body: 'ok' };
      }
      const decision = action === 'appr' ? 'approved' : 'declined';
      const result = await resolveRequest(requestId, record, decision);
      await answerCallback(cq.id, result && result.alreadyProcessed ? 'This request was already processed.' : (decision === 'approved' ? 'Approved ✅' : 'Declined ❌'));
      const decisionLine = decision === 'approved' ? '\n\n✅ <b>APPROVED</b>' : '\n\n❌ <b>DECLINED</b>';
      const typeEmoji = { Sick: '🤒', Vacation: '🌴', 'Emergency/Other': '⚠️' }[record.type] || '📋';
      const baseCaption = `${typeEmoji} <b>${escapeHtml(record.type)} Leave Request</b> — ${escapeHtml(record.employee)} (${escapeHtml(record.branch)})`;
      await editCaption(JEN_CHAT_ID, cq.message.message_id, baseCaption + decisionLine);
      return { statusCode: 200, body: 'ok' };
    }

    const msg = update.message;
    if (!msg || String(msg.chat.id) !== String(JEN_CHAT_ID) || !msg.reply_to_message) return { statusCode: 200, body: 'ok' };
    const record = await getPendingByMessageId(msg.reply_to_message.message_id);
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
    return { statusCode: 200, body: 'ok' };
  }
};

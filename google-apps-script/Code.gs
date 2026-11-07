/**
 * PSulit Leave Request — Google Sheets storage API
 * Spreadsheet: 1Ylf4gkC426ZY4n4u8ZL9BfpjafQijjTV_Txb2YWz70k
 * Deploy this as a SEPARATE standalone Apps Script project; do not replace the PSulit Payroll Code.gs.
 * Deploy as Web App: Execute as Me; access: Anyone (the shared secret protects requests).
 * Set Script Property LEAVE_SYNC_SECRET to the same value as Netlify's GOOGLE_SHEETS_SYNC_SECRET.
 */
const SPREADSHEET_ID = '1Ylf4gkC426ZY4n4u8ZL9BfpjafQijjTV_Txb2YWz70k';
const REQUESTS_TAB = '_LEAVE_REQUESTS';
const APPROVED_TAB = 'LEAVE';
const REQUEST_HEADERS = ['request_id', 'status', 'record_json', 'jen_message_id', 'created_at', 'updated_at'];
const APPROVED_HEADERS = [
  'request_id', 'employee', 'cover_by', 'branch', 'type', 'from_fmt', 'to_fmt',
  'date_from', 'date_to', 'day_count', 'hours_requested', 'reason', 'contact',
  'slip_no', 'status', 'created_at', 'updated_at', 'approved_by', 'decided_at'
];

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const expected = PropertiesService.getScriptProperties().getProperty('LEAVE_SYNC_SECRET');
    if (!expected || body.secret !== expected) return json({ ok: false, error: 'Unauthorized' });
    const lock = LockService.getScriptLock();
    const action = String(body.action || '');
    if (action === 'get' || action === 'getByMessage') {
      const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
      const tab = getRequestsTab_(ss);
      const row = findRequestRow_(tab, action === 'get' ? body.request_id : null, action === 'getByMessage' ? body.message_id : null);
      return json({ ok: true, record: row ? readRequest_(tab, row) : null });
    }
    if (action === 'listApproved') {
      const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
      const tab = getApprovedTab_(ss);
      const lastRow = tab.getLastRow();
      if (lastRow < 2) return json({ ok: true, records: [] });
      const values = tab.getRange(1, 1, lastRow, tab.getLastColumn()).getValues();
      const headers = values.shift().map(String);
      const start = String(body.start || '');
      const end = String(body.end || '');
      const records = values.map(row => {
        const item = {};
        headers.forEach((h, i) => item[h] = row[i] instanceof Date
          ? Utilities.formatDate(row[i], Session.getScriptTimeZone(), 'yyyy-MM-dd')
          : row[i]);
        return item;
      }).filter(item => String(item.status || '').toLowerCase() === 'approved'
        && (!start || String(item.date_from || '') <= end)
        && (!end || String(item.date_to || '') >= start));
      return json({ ok: true, records });
    }
    lock.waitLock(15000);
    try {
      const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
      const tab = getRequestsTab_(ss);
      if (action === 'create') {
        const record = body.record || {};
        if (!record.request_id) throw new Error('Missing request_id');
        if (findRequestRow_(tab, record.request_id, null)) return json({ ok: false, error: 'Duplicate request_id' });
        const now = new Date().toISOString();
        record.status = 'pending';
        record.created_at = record.created_at || now;
        record.updated_at = now;
        tab.appendRow([record.request_id, 'pending', JSON.stringify(record), '', record.created_at, now]);
        return json({ ok: true, record });
      }
      if (action === 'update') {
        const row = findRequestRow_(tab, body.request_id, null);
        if (!row) throw new Error('Request not found');
        const record = readRequest_(tab, row);
        Object.assign(record, body.patch || {});
        record.updated_at = record.updated_at || new Date().toISOString();
        writeRequest_(tab, row, record);
        return json({ ok: true, record });
      }
      if (action === 'resolve') {
        const row = findRequestRow_(tab, body.request_id, null);
        if (!row) throw new Error('Request not found');
        const record = readRequest_(tab, row);
        if (record.status !== 'pending') return json({ ok: true, alreadyProcessed: true, record });
        const decision = String(body.decision || '');
        if (decision !== 'approved' && decision !== 'declined') throw new Error('Invalid decision');
        record.status = decision;
        record.approved_by = body.approved_by || 'Jen';
        record.decided_at = body.decided_at || new Date().toISOString();
        record.updated_at = record.decided_at;
        if (decision === 'approved') appendApprovedIfMissing_(ss, record);
        writeRequest_(tab, row, record);
        return json({ ok: true, record });
      }
      throw new Error('Unsupported action');
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

function getRequestsTab_(ss) {
  // Ensure another visible tab exists before hiding the internal request store.
  getApprovedTab_(ss);
  let tab = ss.getSheetByName(REQUESTS_TAB);
  if (!tab) tab = ss.insertSheet(REQUESTS_TAB);
  if (tab.getLastRow() === 0) tab.appendRow(REQUEST_HEADERS);
  if (!tab.isSheetHidden()) tab.hideSheet();
  return tab;
}

function getApprovedTab_(ss) {
  let tab = ss.getSheetByName(APPROVED_TAB);
  if (!tab) tab = ss.insertSheet(APPROVED_TAB);
  if (tab.getLastRow() === 0) tab.appendRow(APPROVED_HEADERS);
  const headers = tab.getRange(1, 1, 1, Math.max(tab.getLastColumn(), 1)).getValues()[0].map(String);
  APPROVED_HEADERS.forEach(h => {
    if (headers.indexOf(h) === -1) {
      tab.getRange(1, tab.getLastColumn() + 1).setValue(h);
      headers.push(h);
    }
  });
  return tab;
}

function findRequestRow_(tab, requestId, messageId) {
  const last = tab.getLastRow();
  if (last < 2) return 0;
  const rows = tab.getRange(2, 1, last - 1, REQUEST_HEADERS.length).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (requestId && String(rows[i][0]) === String(requestId)) return i + 2;
    if (messageId && String(rows[i][3]) === String(messageId)) return i + 2;
  }
  return 0;
}

function readRequest_(tab, row) {
  const values = tab.getRange(row, 1, 1, REQUEST_HEADERS.length).getValues()[0];
  let record = {};
  try { record = JSON.parse(values[2] || '{}'); } catch (_) {}
  record.request_id = String(values[0] || record.request_id || '');
  record.status = String(values[1] || record.status || 'pending');
  record.jen_message_id = String(values[3] || record.jen_message_id || '');
  record.created_at = String(values[4] || record.created_at || '');
  record.updated_at = String(values[5] || record.updated_at || '');
  return record;
}

function writeRequest_(tab, row, record) {
  tab.getRange(row, 1, 1, REQUEST_HEADERS.length).setValues([[
    record.request_id, record.status, JSON.stringify(record), record.jen_message_id || '',
    record.created_at || '', record.updated_at || new Date().toISOString()
  ]]);
}

function appendApprovedIfMissing_(ss, record) {
  const tab = getApprovedTab_(ss);
  const headers = tab.getRange(1, 1, 1, tab.getLastColumn()).getValues()[0].map(String);
  const idCol = headers.indexOf('request_id') + 1;
  if (idCol > 0 && tab.getLastRow() >= 2) {
    const ids = tab.getRange(2, idCol, tab.getLastRow() - 1, 1).getValues().flat();
    if (ids.some(id => String(id) === String(record.request_id))) return;
  }
  const values = headers.map(h => record[h] == null ? '' : record[h]);
  tab.appendRow(values);
}

function json(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

/** Run once manually after setting LEAVE_SYNC_SECRET to initialize the tabs. */
function initializeLeaveSheets() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  getRequestsTab_(ss);
  getApprovedTab_(ss);
}
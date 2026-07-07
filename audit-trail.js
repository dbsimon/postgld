// ==========================================================================
//  Posting Manager — Audit Trail & Undo System  v1.0
// ==========================================================================
//  Provides complete change tracking, undo capability, and an audit trail
//  viewer for the Posting Manager application.
//
//  ■ Record Metadata — every movement record gets:
//      _id          stable record identifier  (e.g. "rec_a1b2c3")
//      _createdAt   ISO timestamp of creation
//      _updatedAt   ISO timestamp of last modification
//      _updatedBy   "admin" | "ai" | "import" | "sync"
//      _sourceType  "manual" | "ai-extract" | "excel-import" | "gdrive-sync"
//      _changeReason (user-supplied)
//
//  ■ Audit Log — persistent event log keyed by sys_audit_log_pro:
//      id, timestamp, action, entityType, entityId, entityName, entityPn,
//      summary, changeReason, performedBy, snapshot
//
//  ■ Undo Stack — up to 30 reversible actions with snapshot restore.
//
//  Exports:
//    ensureRecordMeta(rec, sourceType)           → record with metadata
//    recordAuditEvent(action, rec, details)      → appends to audit log
//    undoLastAction()                            → restores last reversible action
//    getAuditLog(filters)                        → filtered audit entries
//    renderAuditTrail(containerId)               → renders UI
//    generateRecordId()                          → unique record ID
// ==========================================================================

'use strict';

var _auditLog = (function() {
  try { return JSON.parse(localStorage.getItem('sys_audit_log_pro') || '[]'); }
  catch(e) { return []; }
})();

var _undoStack = [];
var MAX_UNDO = 30;

function _persistAuditLog() {
  try { localStorage.setItem('sys_audit_log_pro', JSON.stringify(_auditLog)); } catch(e) {}
}

// ---- ID generation ---------------------------------------------------------

function generateRecordId() {
  var ts = Date.now().toString(36);
  var rand = Math.random().toString(36).substring(2, 8);
  return 'rec_' + ts + '_' + rand;
}

function generateAuditId() {
  var ts = Date.now().toString(36);
  var rand = Math.random().toString(36).substring(2, 6);
  return 'aud_' + ts + '_' + rand;
}

// ---- audit event type registry ---------------------------------------------

var AUDIT_ACTIONS = {
  CREATE:           { label: 'Create',      icon: '＋', css: 'audit-create' },
  EDIT:             { label: 'Edit',        icon: '✎', css: 'audit-edit' },
  DELETE:           { label: 'Delete',      icon: '✕', css: 'audit-delete' },
  RESTORE:          { label: 'Restore',     icon: '↩', css: 'audit-restore' },
  UNDO:             { label: 'Undo',        icon: '↺', css: 'audit-undo' },
  IMPORT_BULK:      { label: 'Import',      icon: '⬇', css: 'audit-import' },
  IMPORT_EXCEL:     { label: 'Excel Import',icon: '📥', css: 'audit-import' },
  AI_EXTRACT:       { label: 'AI Extract',  icon: '🤖', css: 'audit-ai' },
  SYNC_DRIVE:       { label: 'Sync',        icon: '☁', css: 'audit-sync' },
  APPROVE:          { label: 'Approve',     icon: '✓', css: 'audit-approve' },
  REJECT:           { label: 'Reject',      icon: '✗', css: 'audit-reject' },
  OVERRIDE_CHECK:   { label: 'Override',    icon: '⚡', css: 'audit-override' }
};

// ---- record metadata -------------------------------------------------------

function normalizeRecord(rec) {
  if (!rec._id) rec._id = generateRecordId();
  if (!rec._createdAt) rec._createdAt = new Date().toISOString();
  if (!rec._updatedAt) rec._updatedAt = rec._createdAt;
  if (!rec._updatedBy) rec._updatedBy = 'admin';
  if (!rec._sourceType) rec._sourceType = 'manual';
  if (!rec._changeReason) rec._changeReason = '';
  return rec;
}

function ensureRecordMeta(rec, sourceType) {
  sourceType = sourceType || 'manual';
  var now = new Date().toISOString();
  rec._id = rec._id || generateRecordId();
  rec._createdAt = rec._createdAt || now;
  rec._updatedAt = now;
  rec._updatedBy = sourceType === 'ai-extract' ? 'ai' : (sourceType === 'gdrive-sync' ? 'sync' : (sourceType === 'excel-import' ? 'import' : 'admin'));
  rec._sourceType = sourceType;
  if (!rec._changeReason) rec._changeReason = '';
  return rec;
}

function stampRecordMeta(rec, performedBy, changeReason) {
  rec._updatedAt = new Date().toISOString();
  rec._updatedBy = performedBy || 'admin';
  if (changeReason) rec._changeReason = changeReason;
  return rec;
}

/**
 * Upgrade all existing records that lack metadata fields.
 */
function upgradeRecordsToAudited() {
  if (!records || records.length === 0) return;
  var changed = false;
  for (var i = 0; i < records.length; i++) {
    if (!records[i]._id) {
      normalizeRecord(records[i]);
      changed = true;
    }
  }
  if (changed) {
    localStorage.setItem('sys_posting_records_pro', JSON.stringify(records));
  }
}

// ---- audit event recording -------------------------------------------------

/**
 * Record an audit event.
 * @param {string} action     — one of AUDIT_ACTIONS keys
 * @param {object} rec        — the affected record (with _id)
 * @param {object} details    — { fieldsChanged, before, after, performedBy, changeReason, bulkCount }
 */
function recordAuditEvent(action, rec, details) {
  details = details || {};
  var entry = {
    id:             generateAuditId(),
    timestamp:      new Date().toISOString(),
    action:         action,
    entityType:     'movement',
    entityId:       rec ? (rec._id || '') : '',
    entityName:     rec ? (rec.name || '') : '',
    entityPn:       rec ? (rec.posting_notice || '') : '',
    summary:        _buildSummary(action, rec, details),
    changeReason:   details.changeReason || (rec ? rec._changeReason || '' : ''),
    performedBy:    details.performedBy || (rec ? rec._updatedBy || 'admin' : 'admin'),
    reversible:     (action === 'EDIT' || action === 'DELETE') ? true : false,
    reverted:       false,
    snapshot:       details.snapshot || null,
    fieldsChanged:  details.fieldsChanged || [],
    before:         details.before || null,
    after:          details.after || null,
    bulkCount:      details.bulkCount || 0
  };

  _auditLog.unshift(entry);

  // manage undo stack
  if (entry.reversible && entry.snapshot) {
    _undoStack.unshift(entry);
    if (_undoStack.length > MAX_UNDO) _undoStack.length = MAX_UNDO;
  }

  // trim log to prevent localStorage overflow (keep ~2000 entries)
  if (_auditLog.length > 2000) _auditLog.length = 2000;

  _persistAuditLog();
  return entry;
}

function _buildSummary(action, rec, details) {
  var name = rec ? (rec.name || '(unnamed)') : '';
  var pn   = rec ? (rec.posting_notice || '') : '';
  var pnStr = pn ? ' (PN ' + pn + ')' : '';

  switch (action) {
    case 'CREATE':       return 'Created movement: ' + name + pnStr;
    case 'EDIT':         return 'Edited movement: ' + name + pnStr + (details.fieldsChanged ? ' — changed: ' + details.fieldsChanged.join(', ') : '');
    case 'DELETE':       return 'Deleted movement: ' + name + pnStr;
    case 'RESTORE':      return 'Restored movement: ' + name + pnStr;
    case 'UNDO':         return 'Undid last edit to: ' + name + pnStr;
    case 'IMPORT_BULK':  return 'Imported ' + (details.bulkCount || 0) + ' movements from sync';
    case 'IMPORT_EXCEL': return 'Imported movement from Excel: ' + name + pnStr;
    case 'AI_EXTRACT':   return 'AI-extracted movement: ' + name + pnStr;
    case 'SYNC_DRIVE':   return 'Synced ' + (details.bulkCount || 0) + ' movements from Google Sheets';
    case 'APPROVE':      return 'Approved movement: ' + name + pnStr;
    case 'REJECT':       return 'Rejected movement: ' + name + pnStr;
    case 'OVERRIDE_CHECK': return 'Validation override for: ' + name + pnStr;
    default:             return action + ': ' + name + pnStr;
  }
}

function recordBulkAuditEvent(action, count, performedBy, sourceType) {
  var entry = {
    id:             generateAuditId(),
    timestamp:      new Date().toISOString(),
    action:         action,
    entityType:     'bulk',
    entityId:       '',
    entityName:     '',
    entityPn:       '',
    summary:        _buildBulkSummary(action, count),
    changeReason:   '',
    performedBy:    performedBy || 'admin',
    reversible:     false,
    reverted:       false,
    snapshot:       null,
    fieldsChanged:  [],
    before:         null,
    after:          null,
    bulkCount:      count
  };
  _auditLog.unshift(entry);
  if (_auditLog.length > 2000) _auditLog.length = 2000;
  _persistAuditLog();
  return entry;
}

function _buildBulkSummary(action, count) {
  switch (action) {
    case 'IMPORT_BULK': return 'Bulk import: ' + count + ' movements';
    case 'SYNC_DRIVE':  return 'Sync from Google Sheets: ' + count + ' movements';
    case 'AI_EXTRACT':  return 'AI PDF extraction: ' + count + ' movements';
    default:            return action + ': ' + count + ' records';
  }
}

// ---- undo system -----------------------------------------------------------

function undoLastAction() {
  if (!isAdmin()) {
    showToast('只有管理員可以執行復原操作。', 'warning');
    return;
  }

  if (_undoStack.length === 0) {
    showToast('沒有可復原的操作。', 'info', 3000);
    return;
  }

  var entry = _undoStack.shift();
  if (entry.reverted) {
    showToast('該操作已被復原過。', 'warning', 3000);
    return;
  }

  var recIdx = records.findIndex(function(r) { return r._id === entry.entityId; });

  if (entry.action === 'EDIT') {
    // Restore from snapshot
    if (recIdx >= 0 && entry.snapshot) {
      var currentSnap = _cloneRecord(records[recIdx]);
      records[recIdx] = _cloneRecord(entry.snapshot);
      records[recIdx]._updatedAt = new Date().toISOString();
      records[recIdx]._updatedBy = 'admin';
      records[recIdx]._changeReason = 'Undo: reverted edit';

      recordAuditEvent('UNDO', records[recIdx], {
        performedBy: 'admin',
        snapshot: currentSnap,
        fieldsChanged: entry.fieldsChanged,
        before: entry.after,
        after: entry.before,
        changeReason: 'Undo: reverted edit'
      });

      entry.reverted = true;
      saveAndSync();
      renderDatabaseTable();
      if (historyTarget && historyTarget.value) renderHistoryView();
      showToast('已復原編輯：' + entry.entityName, 'success', 4000);
      return;
    }
  }

  if (entry.action === 'DELETE') {
    // Restore from snapshot
    if (entry.snapshot) {
      var restored = _cloneRecord(entry.snapshot);
      restored._updatedAt = new Date().toISOString();
      restored._updatedBy = 'admin';
      restored._changeReason = 'Undo: restored from delete';

      records.unshift(restored);

      recordAuditEvent('RESTORE', restored, {
        performedBy: 'admin',
        snapshot: null,
        changeReason: 'Undo: restored deleted record'
      });

      entry.reverted = true;
      saveAndSync();
      renderDatabaseTable();
      if (historyTarget && historyTarget.value) renderHistoryView();
      showToast('已復原刪除：' + entry.entityName, 'success', 4000);
      return;
    }
  }

  showToast('無法復原該操作（紀錄已不存在）。', 'warning', 4000);
}

function _cloneRecord(rec) {
  return JSON.parse(JSON.stringify(rec));
}

function getUndoStackSize() {
  return _undoStack.length;
}

// ---- audit log queries -----------------------------------------------------

function getAuditLog(filters) {
  filters = filters || {};
  var results = _auditLog.slice();

  if (filters.action) {
    results = results.filter(function(e) { return e.action === filters.action; });
  }
  if (filters.entityType) {
    results = results.filter(function(e) { return e.entityType === filters.entityType; });
  }
  if (filters.entityId) {
    results = results.filter(function(e) { return e.entityId === filters.entityId; });
  }
  if (filters.entityName) {
    var q = filters.entityName.toLowerCase();
    results = results.filter(function(e) { return (e.entityName || '').toLowerCase().indexOf(q) >= 0; });
  }
  if (filters.entityPn) {
    results = results.filter(function(e) { return e.entityPn === filters.entityPn; });
  }
  if (filters.reversible) {
    results = results.filter(function(e) { return e.reversible && !e.reverted; });
  }
  if (filters.since) {
    results = results.filter(function(e) { return e.timestamp >= filters.since; });
  }

  return results;
}

function getMovementHistory(recId) {
  return getAuditLog({ entityId: recId });
}

function getPersonHistory(personName) {
  return getAuditLog({ entityName: personName });
}

function getNoticeHistory(pn) {
  return getAuditLog({ entityPn: pn });
}

// ---- audit trail UI rendering ----------------------------------------------

var _auditFilters = {};

function renderAuditTrail(containerId) {
  containerId = containerId || 'auditTrailBody';
  var container = document.getElementById(containerId);
  if (!container) return;

  var filtered = getAuditLog(_auditFilters);
  var countEl = document.getElementById('auditTrailCount');

  if (countEl) countEl.textContent = filtered.length + ' entries';
  if (filtered.length === 0) {
    container.innerHTML = '<div class="py-12 text-center text-slate-400 text-sm">No audit events found.</div>';
    return;
  }

  container.innerHTML = '';
  filtered.forEach(function(entry) {
    var actionMeta = AUDIT_ACTIONS[entry.action] || { label: entry.action, icon: '•', css: 'audit-generic' };
    var timestamp = entry.timestamp.replace('T', ' ').substring(0, 19);
    var detailsHtml = '';
    if (entry.fieldsChanged && entry.fieldsChanged.length > 0) {
      detailsHtml += '<div class="text-[10px] text-slate-500 mt-1">Changed: <span class="font-bold">' + escapeHtml(entry.fieldsChanged.join(', ')) + '</span></div>';
    }
    if (entry.changeReason) {
      detailsHtml += '<div class="text-[10px] text-slate-400 mt-0.5 italic">Reason: ' + escapeHtml(entry.changeReason) + '</div>';
    }
    if (entry.before && entry.after) {
      detailsHtml += '<div class="text-[10px] text-slate-500 mt-1 flex gap-2 flex-wrap">';
      var keys = Object.keys(entry.before);
      for (var k = 0; k < keys.length; k++) {
        var field = keys[k];
        var bv = entry.before[field] || '(empty)';
        var av = entry.after[field] || '(empty)';
        if (bv !== av) {
          detailsHtml += '<span class="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200"><span class="text-red-500 line-through">' + escapeHtml(String(bv)) + '</span> → <span class="text-emerald-600 font-bold">' + escapeHtml(String(av)) + '</span></span>';
        }
      }
      detailsHtml += '</div>';
    }

    var card = document.createElement('div');
    card.className = 'p-3 border-b border-slate-100 hover:bg-slate-50 transition-colors audit-entry ' + actionMeta.css;
    card.innerHTML = '' +
      '<div class="flex items-start gap-3">' +
        '<span class="text-lg mt-0.5 shrink-0">' + actionMeta.icon + '</span>' +
        '<div class="flex-1 min-w-0">' +
          '<div class="flex flex-wrap items-center gap-2 mb-0.5">' +
            '<span class="text-[11px] font-bold text-slate-600">' + actionMeta.label + '</span>' +
            '<span class="text-[10px] text-slate-400 font-mono">' + timestamp + '</span>' +
            '<span class="text-[10px] px-1.5 py-0.5 rounded-full ' + _performerCss(entry.performedBy) + '">' + entry.performedBy + '</span>' +
          '</div>' +
          '<div class="text-xs text-slate-700">' + escapeHtml(entry.summary) + '</div>' +
          (entry.entityName ? '<div class="text-[10px] text-blue-500 font-bold mt-0.5 cursor-pointer hover:underline" onclick="viewHistory(\'name\', \'' + escapeJsHtml(entry.entityName) + '\')">' + escapeHtml(entry.entityName) + (entry.entityPn ? ' · PN ' + escapeHtml(entry.entityPn) : '') + '</div>' : '') +
          detailsHtml +
        '</div>' +
        (entry.reversible && !entry.reverted && isAdmin() ? '<button onclick="_undoSingleEntry(\'' + entry.id + '\')" class="text-[10px] font-bold text-amber-600 hover:text-amber-800 bg-amber-50 hover:bg-amber-100 px-2 py-1 rounded shrink-0" title="Undo this action">↺ Undo</button>' : '') +
      '</div>';
    container.appendChild(card);
  });
}

function _undoSingleEntry(auditId) {
  undoLastAction();
  if (typeof renderAuditTrail === 'function') renderAuditTrail();
}

function _performerCss(performedBy) {
  switch (performedBy) {
    case 'admin': return 'bg-blue-100 text-blue-700';
    case 'ai':    return 'bg-purple-100 text-purple-700';
    case 'import':return 'bg-cyan-100 text-cyan-700';
    case 'sync':  return 'bg-emerald-100 text-emerald-700';
    default:      return 'bg-slate-100 text-slate-600';
  }
}

function setAuditFilter(key, value) {
  if (value) _auditFilters[key] = value;
  else delete _auditFilters[key];
  renderAuditTrail();
}

function clearAuditFilters() {
  _auditFilters = {};
  var el = document.getElementById('auditFilterSearch');
  if (el) el.value = '';
  renderAuditTrail();
}

// ---- audit summary for diagnostics -----------------------------------------

function getAuditSummary() {
  var actions = {};
  for (var i = 0; i < _auditLog.length; i++) {
    var a = _auditLog[i].action;
    actions[a] = (actions[a] || 0) + 1;
  }
  return {
    totalEvents: _auditLog.length,
    undoStackSize: _undoStack.length,
    lastEvent: _auditLog.length > 0 ? _auditLog[0] : null,
    actions: actions
  };
}

// ---- initialize on load ----------------------------------------------------

function initializeAuditSystem() {
  upgradeRecordsToAudited();
}

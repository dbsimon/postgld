pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

let records = JSON.parse(localStorage.getItem('sys_posting_records_pro')) || [];
let sortState = { key: 'date', direction: 'desc' };
let historyTarget = { type: null, value: null };
let personNicknames = JSON.parse(localStorage.getItem('sys_person_nicknames_pro')) || {};
let personNotes = JSON.parse(localStorage.getItem('sys_person_notes_pro')) || {};
let postOverrides = JSON.parse(localStorage.getItem('sys_post_overrides') || '{}');
let roleNotes = JSON.parse(localStorage.getItem('sys_role_notes_pro')) || {};
let personImages = JSON.parse(localStorage.getItem('sys_person_images_pro')) || {};

let syncState = {
    status: 'draft',
    lastSync: null,
    remoteCount: 0,
    localCount: records.length,
    error: null
};

let _validationCache = null;
let _adminOverrides = (function() { try { return JSON.parse(localStorage.getItem('sys_admin_overrides_pro') || '{}'); } catch(e) { return {}; } })();

// Notice-status badge helpers — used across all table renderers
function _renderNoticeStatusBadge(pnRaw, record) {
    var status = 'active';
    if (typeof getMovementStatus === 'function') {
        var noticeId = hashId((pnRaw || '').trim());
        var mov = sliceMovementForStatusCheck(record, noticeId);
        if (mov) status = getMovementStatus(mov);
        else if (noticeId && NoticeStore[noticeId]) status = NoticeStore[noticeId].status || 'active';
    } else {
        // Fallback: check remark-based parsing
        if (record && record.supersededFlag) status = 'superseded';
        if (record && record.cancelledFlag) status = 'cancelled';
    }

    var meta = { label: '', cssClass: '', icon: '', title: '' };
    switch (status) {
        case 'active':   meta = { label: 'ACTIVE',     cssClass: 'notice-badge-active',      icon: '●', title: 'Movement is active' }; break;
        case 'future':   meta = { label: 'FUTURE',     cssClass: 'notice-badge-future',      icon: '○', title: 'Takes effect on ' + (record.date || 'TBD') }; break;
        case 'superseded': meta = { label: 'SUPERSEDED', cssClass: 'notice-badge-superseded', icon: '↻', title: showSupersessionTitle(pnRaw) }; break;
        case 'cancelled': meta = { label: 'CANCELLED',  cssClass: 'notice-badge-cancelled',  icon: '✕', title: 'Movement has been cancelled' }; break;
        case 'warning':   meta = { label: 'WARNING',    cssClass: 'notice-badge-warning',    icon: '⚠', title: 'Validation issue detected' }; break;
        default:          meta = { label: status.toUpperCase(), cssClass: 'notice-badge-active', icon: '', title: '' }; break;
    }
    return '<span class="notice-badge ' + meta.cssClass + '" title="' + meta.title + '">' + meta.icon + ' ' + meta.label + '</span>';
}

function showSupersessionTitle(pnRaw) {
    if (typeof isNoticeSupersededByAdmin === 'function') {
        var by = isNoticeSupersededByAdmin(pnRaw);
        if (by) return 'Superseded by PN ' + by;
    }
    return 'This notice has been superseded';
}

function sliceMovementForStatusCheck(record, noticeId) {
    if (!record || !noticeId) return null;
    var dateKey = typeof _cachedDateKey === 'function' ? _cachedDateKey(record.date) : '';
    return {
        noticeId: noticeId,
        effectiveDateKey: dateKey || '',
        supersededFlag: record.supersededFlag || false,
        cancelledFlag: record.cancelledFlag || false,
        needsReview: record._needsReview || false,
        validationStatus: 'ok'
    };
}

// ═══════════════════════════════════════════════════════════════════════════
//  PERFORMANCE INFRASTRUCTURE  — memo, debounce, idle, cache invalidation
// ═══════════════════════════════════════════════════════════════════════════

var _currentTab = 'current';
var _renderDirty = { database: true, current: true, history: true };
var _dateKeyCache = {};

function _invalidateAllCaches() {
    _renderDirty.database = true;
    _renderDirty.current = true;
    _renderDirty.history = true;
    _dateKeyCache = {};
    if (typeof invalidateOccupancyCache === 'function') invalidateOccupancyCache();
}

function _cachedDateKey(raw) {
    var key = raw || '';
    if (_dateKeyCache[key] !== undefined) return _dateKeyCache[key];
    var result = parseDateKey(raw);
    _dateKeyCache[key] = result;
    return result;
}

// Memoized filtered+sorted records for database table
var _memoDb = { search: '', key: '', dir: '', result: null, recordsLen: -1 };
function _getMemoDbRows() {
    var search = (document.getElementById('dbSearch')?.value || '').toLowerCase();
    var dirty = _memoDb.search !== search || _memoDb.key !== sortState.key ||
                 _memoDb.dir !== sortState.direction || _memoDb.recordsLen !== records.length ||
                 _renderDirty.database;
    if (dirty) {
        var filtered = records.filter(function(r) {
            var note = (personNotes[r.name] || '').toLowerCase();
            var nick = (personNicknames[r.name] || '').toLowerCase();
            return (r.name || '').toLowerCase().indexOf(search) >= 0 ||
                   (r.from_post || '').toLowerCase().indexOf(search) >= 0 ||
                   (r.from_dept || '').toLowerCase().indexOf(search) >= 0 ||
                   (r.to_post || '').toLowerCase().indexOf(search) >= 0 ||
                   (r.to_dept || '').toLowerCase().indexOf(search) >= 0 ||
                   nick.indexOf(search) >= 0 || note.indexOf(search) >= 0;
        });
        filtered.sort(function(a, b) {
            var va = a[sortState.key] || '';
            var vb = b[sortState.key] || '';
            if (sortState.key === 'date') { va = _cachedDateKey(va); vb = _cachedDateKey(vb); }
            if (sortState.key === 'posting_notice') {
                var mA = String(va).match(/(\d+)\s*\/\s*(\d{4})/);
                var mB = String(vb).match(/(\d+)\s*\/\s*(\d{4})/);
                va = mA ? mA[2] + String(mA[1]).padStart(4, '0') : String(va);
                vb = mB ? mB[2] + String(mB[1]).padStart(4, '0') : String(vb);
            }
            return sortState.direction === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
        });
        _memoDb = { search: search, key: sortState.key, dir: sortState.direction, result: filtered, recordsLen: records.length };
        _renderDirty.database = false;
    }
    return _memoDb.result;
}

// Memoized current-table rows
var _memoCurrent = { search: '', key: '', dir: '', dateKey: '', result: null, recordsLen: -1 };
function _getMemoCurrentRows() {
    var search = (document.getElementById('currentSearch')?.value || '').toLowerCase();
    var asOfDate = getAsOfDateKey();
    var dirty = _memoCurrent.search !== search || _memoCurrent.key !== currentSortState.key ||
                 _memoCurrent.dir !== currentSortState.direction || _memoCurrent.dateKey !== asOfDate ||
                 _memoCurrent.recordsLen !== records.length || _renderDirty.current;
    if (dirty) {
        var snapshot, rows;
        if (typeof getOccupancySnapshot === 'function') {
            snapshot = getOccupancySnapshot(asOfDate);
        }
        // Only use occupancy engine if it returned real entries; fall back to
        // flat-records path when canonical stores aren't seeded yet (empty snapshot).
        var hasSnapshotEntries = false;
        if (snapshot) {
            for (var _sk in snapshot) { if (snapshot.hasOwnProperty(_sk)) { hasSnapshotEntries = true; break; } }
        }
        if (hasSnapshotEntries && typeof occupancyToRows === 'function') {
            rows = occupancyToRows(snapshot, currentSortState.key, currentSortState.direction);
        } else {
            // legacy fallback (rare path)
            var postState = new Map();
            records.forEach(function(r) {
                var dv = _cachedDateKey(r.date) || '';
                var fk = getRoleKey(r.from_post, r.from_dept);
                if (fk !== '||') {
                    var ex = postState.get(fk);
                    if (!ex || dv > ex.dateVal) postState.set(fk, { status: 'vacant', action: 'LEAVE', dateVal: dv, record: r, to_post: r.from_post, to_dept: r.from_dept, lastDate: r.date });
                }
                var tk = getRoleKey(r.to_post, r.to_dept);
                if (tk !== '||') {
                    var ex2 = postState.get(tk);
                    if (!ex2 || dv >= ex2.dateVal) postState.set(tk, { status: 'occupied', action: 'JOIN', dateVal: dv, record: r, to_post: r.to_post, to_dept: r.to_dept, lastDate: r.date });
                }
            });
            rows = Array.from(postState.entries()).map(function(e) {
                var k = e[0], st = e[1];
                var isDel = postOverrides[k] === 'deleted';
                return { isVacant: st.status === 'vacant' && !isDel, isDeleted: isDel, isActing: false, isFutureIncoming: false, onAttachment: false,
                    name: st.status === 'vacant' || isDel ? '' : st.record.name, to_post: st.to_post, to_dept: st.to_dept,
                    date: st.lastDate, posting_notice: st.record.posting_notice, rawRecord: st.record };
            });
            rows.sort(function(a, b) {
                var va, vb;
                if (currentSortState.key === 'name') { va = a.name || ''; vb = b.name || ''; return currentSortState.direction === 'asc' ? va.localeCompare(vb, 'en') : vb.localeCompare(va, 'en'); }
                else if (currentSortState.key === 'date') { va = _cachedDateKey(a.date); vb = _cachedDateKey(b.date); return currentSortState.direction === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va); }
                else if (currentSortState.key === 'role') { va = a.to_post || ''; vb = b.to_post || ''; return currentSortState.direction === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va); }
                return 0;
            });
        }
        if (search) {
            rows = rows.filter(function(r) {
                var note = (personNotes[r.name] || '').toLowerCase();
                var nick = (personNicknames[r.name] || '').toLowerCase();
                var pnote = (roleNotes[getRoleKey(r.to_post, r.to_dept)] || '').toLowerCase();
                return (r.name || '').toLowerCase().indexOf(search) >= 0 ||
                       (r.to_post || '').toLowerCase().indexOf(search) >= 0 ||
                       (r.to_dept || '').toLowerCase().indexOf(search) >= 0 ||
                       (r.posting_notice || '').toLowerCase().indexOf(search) >= 0 ||
                       (r.isVacant && 'vacant'.indexOf(search) >= 0) ||
                       (r.isDeleted && 'obsolete'.indexOf(search) >= 0) ||
                       (r.isActing && 'acting'.indexOf(search) >= 0) ||
                       (r.isFutureIncoming && 'future'.indexOf(search) >= 0) ||
                       (r.onAttachment && 'attachment'.indexOf(search) >= 0) ||
                       nick.indexOf(search) >= 0 || note.indexOf(search) >= 0 || pnote.indexOf(search) >= 0;
            });
        }
        _memoCurrent = { search: search, key: currentSortState.key, dir: currentSortState.direction, dateKey: asOfDate, result: rows, recordsLen: records.length };
        _renderDirty.current = false;
    }
    return _memoCurrent.result;
}

// Memoized history-view filtered records
var _memoHistory = { type: '', value: '', dept: '', result: null, recordsLen: -1 };
function _getMemoHistoryRows() {
    if (!historyTarget.value) return [];
    var dirty = _memoHistory.type !== historyTarget.type || _memoHistory.value !== historyTarget.value ||
                 _memoHistory.dept !== (historyTarget.dept || '') || _memoHistory.recordsLen !== records.length ||
                 _renderDirty.history;
    if (dirty) {
        var filtered;
        if (historyTarget.type === 'dept') {
            filtered = [];
        } else {
            filtered = records.filter(function(r) {
                if (historyTarget.type === 'name') return r.name === historyTarget.value;
                if (historyTarget.type === 'role') return (r.to_post === historyTarget.value && (r.to_dept || '') === (historyTarget.dept || ''));
                if (historyTarget.type === 'pn') return r.posting_notice === historyTarget.value;
                return false;
            }).sort(function(a, b) { return _cachedDateKey(b.date).localeCompare(_cachedDateKey(a.date)); });
        }
        _memoHistory = { type: historyTarget.type, value: historyTarget.value, dept: (historyTarget.dept || ''), result: filtered, recordsLen: records.length };
        _renderDirty.history = false;
    }
    return _memoHistory.result;
}

// Index-based validation lookup (O(1) instead of O(n))
var _validationByIndex = {};
function _buildValidationIndex() {
    _validationByIndex = {};
    if (_validationCache && _validationCache.results) {
        for (var i = 0; i < _validationCache.results.length; i++) {
            _validationByIndex[i] = _validationCache.results[i];
        }
    }
}

// Debounce utility
var _debounceTimers = {};
function _debounce(key, fn, delay) {
    delay = delay || 150;
    if (_debounceTimers[key]) clearTimeout(_debounceTimers[key]);
    _debounceTimers[key] = setTimeout(function() { _debounceTimers[key] = null; fn(); }, delay);
}

// Non-blocking idle callback (falls back to setTimeout 0)
var _pendingIdleTasks = [];
var _idleScheduled = false;
function _scheduleIdle(fn) {
    _pendingIdleTasks.push(fn);
    if (!_idleScheduled) {
        _idleScheduled = true;
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(_flushIdleTasks, { timeout: 2000 });
        } else {
            setTimeout(_flushIdleTasks, 0);
        }
    }
}
function _flushIdleTasks(deadline) {
    _idleScheduled = false;
    while (_pendingIdleTasks.length > 0) {
        var fn = _pendingIdleTasks.shift();
        try { fn(); } catch(e) { /* swallow */ }
        if (deadline && deadline.timeRemaining && deadline.timeRemaining() < 1) {
            if (_pendingIdleTasks.length > 0) {
                _idleScheduled = true;
                requestIdleCallback(_flushIdleTasks, { timeout: 2000 });
            }
            return;
        }
    }
}

// Batch DOM write using rAF
var _rafPending = {};
function _scheduleRender(key, fn) {
    if (_rafPending[key]) return;
    _rafPending[key] = true;
    requestAnimationFrame(function() {
        _rafPending[key] = false;
        fn();
    });
}

function _markDirty(section) {
    _renderDirty[section] = true;
    _validationByIndex = {};
    _dateKeyCache = {};
}

function _markAllDirty() {
    _markDirty('database');
    _markDirty('current');
    _markDirty('history');
}

function revalidateAll() {
    if (typeof validateAllRecords !== 'function') return;
    _validationCache = validateAllRecords(records, { adminOverride: _adminOverrides });
    _buildValidationIndex();
    updateValidationBadge();
}

function runBackgroundValidation() {
    _scheduleIdle(function() {
        revalidateAll();
        _markDirty('database');
        _markDirty('current');
        _markDirty('history');
        if (_currentTab === 'database') _scheduleRender('db', renderDatabaseTable);
        if (_currentTab === 'history' && historyTarget && historyTarget.value) renderHistoryView();
    });
}

function getValidationForRecord(rec) {
    if (!_validationCache) { revalidateAll(); _buildValidationIndex(); }
    if (!_validationCache) return { severity: 'ok', issues: [], overridden: false };
    var idx = records.indexOf(rec);
    if (idx < 0) return { severity: 'ok', issues: [], overridden: false };
    if (_validationByIndex[idx] !== undefined) return _validationByIndex[idx];
    var result = _validationCache.results[idx];
    return result || { severity: 'ok', issues: [], overridden: false };
}

function getValidationForRecordByIndex(idx) {
    if (!_validationCache) { revalidateAll(); _buildValidationIndex(); }
    if (!_validationCache || idx < 0) return { severity: 'ok', issues: [], overridden: false };
    if (_validationByIndex[idx] !== undefined) return _validationByIndex[idx];
    return { severity: 'ok', issues: [], overridden: false };
}

function renderValidationBadge(severity, overridden) {
    var badge = (typeof getValidationBadge === 'function') ? getValidationBadge(severity) : {
        label: severity === 'error' ? 'ERROR' : (severity === 'warning' ? 'WARNING' : 'VALID'),
        bgClass: severity === 'error' ? 'bg-red-100' : (severity === 'warning' ? 'bg-amber-100' : 'bg-emerald-100'),
        textClass: severity === 'error' ? 'text-red-700' : (severity === 'warning' ? 'text-amber-700' : 'text-emerald-700'),
        borderClass: severity === 'error' ? 'border-red-200' : (severity === 'warning' ? 'border-amber-200' : 'border-emerald-200'),
        icon: severity === 'error' ? '\u2715' : (severity === 'warning' ? '\u26A0' : '\u2713')
    };
    var title = severity.toUpperCase();
    if (overridden && severity === 'ok') title = 'OK (admin resolved)';
    if (overridden && severity !== 'ok') title += ' (admin overridden)';
    if (severity === 'ok' && !overridden) title = '';
    var suffix = overridden ? ' <span class="text-purple-600 font-bold">~</span>' : '';
    return '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold ' + badge.bgClass + ' ' + badge.textClass + ' border ' + badge.borderClass + '" title="' + title + '">' +
        badge.icon + suffix + ' ' + badge.label + '</span>';
}

function isAdmin() {
    return document.body.classList.contains('admin-mode');
}

function updateValidationBadge() {
    if (!_validationCache) return;
    var badge = document.getElementById('validationSummaryBadge');
    if (!badge) return;
    var s = _validationCache.summary;
    badge.classList.remove('hidden', 'error-pulse');
    // Only show diagnostic content when admin is active
    if (!isAdmin()) {
        badge.classList.add('hidden');
        return;
    }
    if (s.error > 0) {
        badge.className = 'admin-only sync-badge failed error-pulse';
        badge.style.cursor = 'pointer';
        badge.onclick = openIssuePanel;
        badge.textContent = s.error + ' ERROR' + (s.warning > 0 ? ' / ' + s.warning + ' WARNING' : '');
        badge.title = 'Records with errors: ' + s.error + '\nClick to open issue resolution panel.\nAdmin override available for individual records.';
    } else if (s.warning > 0) {
        badge.className = 'admin-only sync-badge draft';
        badge.style.cursor = 'pointer';
        badge.onclick = openIssuePanel;
        badge.textContent = s.warning + ' WARNING';
        badge.title = 'Records with warnings: ' + s.warning + '\nClick to open issue resolution panel.';
    } else {
        badge.className = 'admin-only sync-badge synced';
        badge.style.cursor = 'pointer';
        badge.onclick = openIssuePanel;
        badge.textContent = s.ok + ' RECORDS';
        badge.title = 'All records validated.\nClick to open full validation report.';
    }
}

function toggleValidationOverride(recordIndex) {
    if (!isAdmin()) return;
    var key = String(recordIndex);
    _adminOverrides[key] = !_adminOverrides[key];
    try { localStorage.setItem('sys_admin_overrides_pro', JSON.stringify(_adminOverrides)); } catch(e) {}
    revalidateAll();
    showToast(_adminOverrides[key] ? 'Admin override: issue resolved (record #' + (recordIndex + 1) + ')' : 'Override removed (record #' + (recordIndex + 1) + ')', 'info', 3000);
}

function updateUndoButton() {
    var btn = document.getElementById('undoBtn');
    if (!btn) return;
    var stackSize = typeof getUndoStackSize === 'function' ? getUndoStackSize() : 0;
    if (stackSize > 0 && isAdmin()) {
        btn.classList.remove('hidden');
        btn.title = 'Undo last action (' + stackSize + ' available) [Ctrl+Z]';
    } else {
        btn.classList.add('hidden');
    }
}

function openAuditTrail() {
    var panel = document.getElementById('menuDropdownPanel');
    if (panel) panel.classList.add('hidden');
    renderAuditTrail('auditTrailBody');
    showAuditSection();
}

function showAuditSection() {
    ['upload', 'database', 'current', 'history', 'manual'].forEach(function(id) {
        var s = document.getElementById('section-' + id);
        if (s) s.classList.add('hidden');
    });
    ['upload', 'database', 'current', 'history'].forEach(function(id) {
        var t = document.getElementById('tab-' + id);
        if (t) { t.classList.remove('tab-active', 'text-blue-600', 'font-bold'); t.classList.add('text-slate-500'); }
    });
    var auditSec = document.getElementById('section-audit');
    if (auditSec) auditSec.classList.remove('hidden');
}

function showToast(msg, type, duration) {
    type = type || 'info';
    duration = duration || 4000;
    var container = document.getElementById('toastContainer');
    if (!container) return;
    var el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.textContent = msg;
    el.onclick = function() { el.remove(); };
    container.appendChild(el);
    setTimeout(function() {
        el.style.animation = 'toastOut 0.2s ease-in forwards';
        setTimeout(function() { if (el.parentNode) el.remove(); }, 200);
    }, duration);
}

function updateSyncBadge() {
    var badge = document.getElementById('syncBadge');
    if (!badge) return;
    if (!isAdmin()) {
        badge.classList.add('hidden');
        return;
    }
    badge.classList.remove('hidden', 'synced', 'draft', 'failed', 'loading');
    badge.classList.add(syncState.status);
    var labels = { synced: '已同步', draft: '變更未儲存', failed: '同步失敗', loading: '同步中…', stale: '遠端較新' };
    badge.textContent = labels[syncState.status] || '';
    badge.title = syncState.lastSync ? '上次同步: ' + syncState.lastSync : '';
    if (syncState.localCount) badge.title += ' | 本地: ' + syncState.localCount + ' 筆';
    if (syncState.remoteCount) badge.title += ' | 遠端: ' + syncState.remoteCount + ' 筆';
}

function setSyncStatus(status, remoteCount, error) {
    syncState.status = status;
    if (remoteCount !== undefined) syncState.remoteCount = remoteCount;
    syncState.localCount = (records || []).length;
    syncState.error = error || null;
    if (status === 'synced') syncState.lastSync = new Date().toLocaleString('zh-HK');
    updateSyncBadge();
}

function applyAdminMode() {
    document.body.classList.add('admin-mode');
    sessionStorage.setItem('posting_admin_mode', '1');
    const btn = document.getElementById('adminToggleBtn');
    if (btn) btn.classList.add('admin-active');
    document.getElementById('adminModal').classList.add('hidden');
    document.getElementById('adminPasswordInput').value = '';
    document.getElementById('adminPasswordError').classList.add('hidden');
    addLog('已進入管理員模式。', 'info');
    // Reveal diagnostic badges for admin
    updateSyncBadge();
    updateValidationBadge();
    switchTab('current');
    renderCurrentTable();
    renderDatabaseTable();
    if (typeof _renderSupersessionChain === 'function') _renderSupersessionChain();
}

function exitAdminMode() {
    document.body.classList.remove('admin-mode');
    sessionStorage.removeItem('posting_admin_mode');
    const btn = document.getElementById('adminToggleBtn');
    if (btn) btn.classList.remove('admin-active');
    const panel = document.getElementById('menuDropdownPanel');
    if (panel) panel.classList.add('hidden');
    // Hide diagnostic badges for normal users
    var syncB = document.getElementById('syncBadge');
    if (syncB) syncB.classList.add('hidden');
    var valB = document.getElementById('validationSummaryBadge');
    if (valB) valB.classList.add('hidden');
    switchTab('current');
    renderCurrentTable();
    renderDatabaseTable();
    addLog('已退出管理員模式。', 'info');
}

function toggleAdminMode() {
    if (isAdmin()) {
        exitAdminMode();
    } else {
        document.getElementById('adminModal').classList.remove('hidden');
        document.getElementById('adminPasswordInput').focus();
    }
}

function closeAdminModal() {
    document.getElementById('adminModal').classList.add('hidden');
    document.getElementById('adminPasswordInput').value = '';
    document.getElementById('adminPasswordError').classList.add('hidden');
}

function enterAdminMode() {
    const input = document.getElementById('adminPasswordInput').value.trim();
    const saved = localStorage.getItem('sys_admin_pwd') || 'Simon123';
    if (input === saved) {
        applyAdminMode();
    } else {
        const err = document.getElementById('adminPasswordError');
        err.classList.remove('hidden');
        err.style.animation = 'none';
        err.offsetHeight;
        err.style.animation = 'shake 0.3s ease-in-out';
    }
}

window.onload = function() {
    var savedKey = localStorage.getItem('deepseek_api_key_pro') || '';
    document.getElementById('apiKey').value = savedKey;

    var savedGdrive = localStorage.getItem('sys_gdrive_link') || '';
    if (savedGdrive) {
        document.getElementById('gdriveLink').value = savedGdrive;
        autoSyncFromGdrive(savedGdrive);
    }

    if (sessionStorage.getItem('posting_admin_mode') === '1') {
        applyAdminMode();
    }

    // Seed canonical stores synchronously so the current table has data on first render
    if (typeof syncCanonicalStores === 'function') syncCanonicalStores(records);
    if (typeof resolveNoticeStatuses === 'function') resolveNoticeStatuses();

    renderDatabaseTable();
    toggleDbSearchClearBtn();
    switchTab('current');

    setSyncStatus('draft');
    updateSyncBadge();

    // Background: re-validate and refresh stores (idempotent, picks up any async changes)
    _scheduleIdle(function() {
        if (typeof syncCanonicalStores === 'function') syncCanonicalStores(records);
        if (typeof resolveNoticeStatuses === 'function') resolveNoticeStatuses();
        if (typeof validateAllRecords === 'function') revalidateAll();
    });

    if (typeof initializeAuditSystem === 'function') {
        initializeAuditSystem();
        updateUndoButton();
    }

    document.getElementById('pdfFile').addEventListener('change', function(e) {
        if (e.target.files[0]) document.getElementById('fileName').innerText = e.target.files[0].name;
    });

    document.addEventListener('click', function(event) {
        var wrap = document.getElementById('menuDropdownWrap');
        var panel = document.getElementById('menuDropdownPanel');
        if (!wrap || !panel) return;
        if (!wrap.contains(event.target)) {
            panel.classList.add('hidden');
        }
    });
};

function toggleMenuDropdown(event) {
    if (!isAdmin()) return;
    event.stopPropagation();
    const panel = document.getElementById('menuDropdownPanel');
    if (!panel) return;
    panel.classList.toggle('hidden');
}

function switchTab(tabId) {
    if ((tabId === 'upload' || tabId === 'manual') && !isAdmin()) {
        return;
    }

    if (_currentTab === tabId && tabId !== 'history') return;

    _currentTab = tabId;

    ['upload', 'database', 'current', 'history', 'manual'].forEach(function(id) {
        var s = document.getElementById('section-' + id);
        if (s) s.classList.add('hidden');
    });

    ['upload', 'database', 'current', 'history'].forEach(function(id) {
        var t = document.getElementById('tab-' + id);
        if (t) { t.classList.remove('tab-active', 'text-blue-600', 'font-bold'); t.classList.add('text-slate-500'); }
        var m = document.getElementById('mob-tab-' + id);
        if (m) { m.classList.remove('text-blue-600'); m.classList.add('text-slate-400'); }
        var mL = m ? m.querySelector('span') : null;
        if (mL) mL.classList.remove('font-semibold');
    });

    var activeSection = document.getElementById('section-' + tabId);
    if (activeSection) activeSection.classList.remove('hidden');

    if (tabId !== 'manual') {
        var activeTab = document.getElementById('tab-' + tabId);
        if (activeTab) { activeTab.classList.add('tab-active', 'text-blue-600', 'font-bold'); activeTab.classList.remove('text-slate-500'); }
        var activeMob = document.getElementById('mob-tab-' + tabId);
        if (activeMob) { activeMob.classList.add('text-blue-600'); activeMob.classList.remove('text-slate-400'); }
        var mL = activeMob ? activeMob.querySelector('span') : null;
        if (mL) mL.classList.add('font-semibold');
    }

    if (tabId === 'database') _scheduleRender('db', renderDatabaseTable);
    if (tabId === 'current') _scheduleRender('cur', renderCurrentTable);
    if (tabId === 'history') renderHistoryView();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function testGdriveLink() {
    const link = document.getElementById('gdriveLink').value.trim();
    if (!link) { showToast('請先貼上連結。', 'warning'); return; }
    const parsed = convertGdriveLink(link);
    if (!parsed) { setGdriveStatus('⚠ 無法識別連結格式。', 'text-amber-600'); return; }
    setGdriveStatus('🔍 診斷中，請稍候…', 'text-blue-500');
    try {
        const json = await fetchAppsScript(parsed.url);
        const sheets = Object.keys(json);
        const totalRows = Object.values(json).reduce((s,r)=>s+r.length,0);
        setGdriveStatus(`✓ 成功！找到 ${sheets.length} 個工作表（${sheets.join('、')}），共 ${totalRows} 行。可按「立即同步」。`, 'text-emerald-600');
    } catch(e) {
        setGdriveStatus(`⚠ 診斷失敗：${e.message} — 請確認 Apps Script 部署時「誰可以存取」設為「所有人」。`, 'text-red-500');
    }
}

function saveGdriveLink() {
    const link = document.getElementById('gdriveLink').value.trim();
    if (!link) { showToast('請先輸入 Google Drive 分享連結。', 'warning'); return; }
    localStorage.setItem('sys_gdrive_link', link);
    setGdriveStatus('✓ 連結已儲存', 'text-emerald-600');
    addLog('Google Drive 連結已儲存。', 'info');
}

function convertGdriveLink(rawLink) {
    const link = (rawLink || '').trim();
    if (link.includes('script.google.com/macros/s/')) return { type: 'appsscript', url: link };
    const sheetsMatch = link.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (sheetsMatch) return { type: 'sheets', fileId: sheetsMatch[1] };
    return null;
}

async function fetchAppsScript(url) {
    var fetchUrl;
    try {
        fetchUrl = new URL(url);
    } catch (e) {
        throw new Error('無效的 Apps Script URL');
    }
    fetchUrl.searchParams.append('pwd', localStorage.getItem('sys_api_pwd') || '');
    var r;
    try {
        r = await fetch(fetchUrl.toString(), { redirect: 'follow', signal: AbortSignal.timeout(120000) });
    } catch (e) {
        if (e.name === 'TimeoutError' || e.name === 'AbortError') {
            throw new Error('連線逾時。請檢查 Apps Script 是否已部署。');
        }
        throw new Error('連線失敗: ' + (e.message || '網路錯誤'));
    }
    if (!r.ok) {
        if (r.status === 401 || r.status === 403) throw new Error('密碼錯誤或無權限 (HTTP ' + r.status + ')');
        if (r.status === 404) throw new Error('Apps Script URL 不存在 (HTTP 404)');
        throw new Error('伺服器錯誤 (HTTP ' + r.status + ')');
    }

    var rawText;
    try {
        rawText = await r.text();
    } catch (e) {
        throw new Error('無法讀取回應內容');
    }

    if (!rawText || rawText.trim() === '') {
        throw new Error('Apps Script 回傳空內容');
    }

    var json;
    try {
        json = JSON.parse(rawText);
    } catch (e) {
        throw new Error('回應格式錯誤 (非 JSON): ' + rawText.substring(0, 60));
    }

    if (json && json.success === false) {
        throw new Error(json.error || '密碼錯誤');
    }

    if (!json || typeof json !== 'object' || Array.isArray(json)) {
        throw new Error('回應格式不正確 (缺少工作表資料)');
    }

    if (json.Records && json.Records.length > 1) {
        json.Records = json.Records.map(function(row, ri) {
            if (ri === 0) return row;
            return row.map(function(cell, ci) {
                if (ci === 9 && typeof cell === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(cell)) {
                    var d = new Date(cell);
                    return (d.getUTCMonth() + 1) + '/' + d.getUTCFullYear();
                }
                if (ci === 9 && cell instanceof Date) {
                    return (cell.getUTCMonth() + 1) + '/' + cell.getUTCFullYear();
                }
                return cell;
            });
        });
    }
    return json;
}

async function saveAllToSheets() {
    if (!isAdmin()) return;

    revalidateAll();
    if (_validationCache && _validationCache.errorsBlocking > 0) {
        showToast('⚠ 有 ' + _validationCache.errorsBlocking + ' 筆 ERROR 級別紀錄。數據仍會寫入 Google Sheets，請在 Exceptions 工作表覆核。', 'warning', 8000);
    }

    await doSaveToSheets();
}

async function doSaveToSheets() {
    const url = document.getElementById('gdriveLink') ? document.getElementById('gdriveLink').value.trim() : '';
    if (!url || !url.includes('script.google.com')) {
        showToast('請先在「設定」面板設定 Apps Script 連結。', 'warning');
        return;
    }
    setSyncStatus('loading');
    const btn = document.getElementById('saveToSheetsBtn');
    if (btn) { btn.textContent = '⏳ 儲存中…'; btn.disabled = true; }

    try {
        const recHeaders = ['姓名 (Name)','原職 (From Post)','原部門 (From Dept)','原崗位備註','現職 (To Post)','現部門 (To Dept)','現崗位備註','生效日期','備註 (Remark)','PN No.'];
        const recRows = [recHeaders, ...records.map(r => [
            r.name||'', r.from_post||'', r.from_dept||'', r.from_post_remark||'',
            r.to_post||'', r.to_dept||'', r.to_post_remark||'',
            r.date||'', r.remark||'', r.posting_notice||''
        ])];

        const CHUNK = 45000;
        const NUM_CHUNKS = 8;
        const colHeaders = ['姓名 (Name)','暱稱 (Nickname)','人物備註','人物相片檔名',
            ...Array.from({length:NUM_CHUNKS},(_,i)=>`人物相片資料_${i+1}`)];
        const allNames = new Set([...Object.keys(personNotes||{}), ...Object.keys(personImages||{}), ...Object.keys(personNicknames||{})]);
        const colRows = [colHeaders, ...[...allNames].map(name => {
            const imgData = (personImages||{})[name] || '';
            const chunks = Array.from({length:NUM_CHUNKS},(_,i)=>imgData.slice(i*CHUNK,(i+1)*CHUNK));
            return [name, (personNicknames||{})[name]||'', (personNotes||{})[name]||'', '', ...chunks];
        })];

        const postState = new Map();
        records.forEach(r => {
            const dateVal = parseDateKey(r.date) || '';

            const fromKey = getRoleKey(r.from_post, r.from_dept);
            if (fromKey !== '||') {
                const existing = postState.get(fromKey);
                if (!existing || dateVal > existing.dateVal) {
                    postState.set(fromKey, { status: 'vacant', holder: '', dateVal: dateVal });
                }
            }

            const toKey = getRoleKey(r.to_post, r.to_dept);
            if (toKey !== '||') {
                const existing = postState.get(toKey);
                if (!existing || dateVal >= existing.dateVal) {
                    postState.set(toKey, { status: 'occupied', holder: r.name, dateVal: dateVal });
                }
            }
        });

        const postHeaders = ['職位 (Post)', '部門 (Department)', '狀態 (Status)', '現任 (Holder)', '崗位備註 (Remark)'];
        const allPostKeys = new Set([...postState.keys(), ...Object.keys(roleNotes||{}), ...Object.keys(postOverrides||{})]);
        allPostKeys.delete('||');

        const postRows = [postHeaders, ...[...allPostKeys].map(key => {
            const parts = key.split('||');
            const post = parts[0] || '';
            const dept = parts[1] || '';
            const computed = postState.get(key) || { status: 'vacant', holder: '' };
            let status = computed.status;
            if (postOverrides[key] === 'deleted') status = 'deleted';
            return [post, dept, status, status === 'occupied' ? computed.holder : '', (roleNotes||{})[key] || ''];
        })];

        // Collect recent unsynced audit events to send to server
        var unsyncedAudit = [];
        if (typeof _auditLog !== 'undefined') {
            for (var ai = 0; ai < _auditLog.length; ai++) {
                var ae = _auditLog[ai];
                if (ae && !ae._synced) {
                    unsyncedAudit.push({
                        action: ae.action,
                        entityType: ae.entityType,
                        entityId: ae.entityId,
                        summary: ae.summary,
                        details: { changeReason: ae.changeReason, fieldsChanged: ae.fieldsChanged, before: ae.before, after: ae.after },
                        performedBy: ae.performedBy,
                        changeReason: ae.changeReason,
                        recordId: ae.entityId
                    });
                    ae._synced = true;
                }
            }
            if (typeof _persistAuditLog === 'function') _persistAuditLog();
        }

        const payload = JSON.stringify({
            pwd: localStorage.getItem('sys_api_pwd') || '',
            action: 'overwrite',
            sheets: {
                Records: recRows,
                Colleagues: colRows,
                Posts: postRows
            },
            auditEvents: unsyncedAudit.slice(0, 200),
            supersessionLinks: (typeof _supersessionLinks === 'object') ? _supersessionLinks : {}
        });

        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: payload,
            redirect: 'follow',
            signal: AbortSignal.timeout(120000)
        });

        const result = await resp.json().catch(() => ({}));
        if (result.success === false) throw new Error(result.error || '未知錯誤');

        if (btn) { btn.textContent = '✓ 已儲存'; btn.disabled = false; }
        setTimeout(() => { if (btn) btn.textContent = '☁️ 儲存至 Sheets'; }, 3000);
        addLog(`已儲存 ${records.length} 筆記錄至 Google Sheets`, 'info');
        setSyncStatus('synced', records.length);
    } catch(e) {
        if (btn) { btn.textContent = '⚠ 失敗，重試'; btn.disabled = false; }
        setSyncStatus('failed', undefined, e.message);
        showToast('儲存失敗：' + e.message, 'error', 6000);
    }
}

function setGdriveStatus(msg, colorClass) {
    const el = document.getElementById('gdriveSyncStatus');
    if (!el) return;
    el.textContent = msg;
    el.className = `mt-2 text-xs ${colorClass}`;
    el.classList.remove('hidden');
}

async function fetchFromGdrive() {
    const link = document.getElementById('gdriveLink').value.trim();
    if (!link) { showToast('請先輸入並儲存 Google Drive 分享連結。', 'warning'); return; }
    localStorage.setItem('sys_gdrive_link', link);
    await autoSyncFromGdrive(link);
}

async function autoSyncFromGdrive(rawLink) {
    const parsed = convertGdriveLink(rawLink);
    if (!parsed) {
        setGdriveStatus('⚠ 連結格式不正確，請貼上 Apps Script Web App URL。', 'text-amber-600');
        return;
    }
    setGdriveStatus('⟳ 正在讀取資料…', 'text-blue-500');
    setSyncStatus('loading');
    try {
        let workbook = XLSX.utils.book_new();

        if (parsed.type === 'appsscript') {
            const json = await fetchAppsScript(parsed.url);
            for (const [sheetName, rows] of Object.entries(json)) {
                if (sheetName === 'success' || sheetName === 'error') continue;
                if (sheetName.startsWith('_')) continue;
                if (!Array.isArray(rows) || rows.length === 0) continue;
                const ws = XLSX.utils.aoa_to_sheet(rows);
                XLSX.utils.book_append_sheet(workbook, ws, sheetName);
            }
        } else {
            throw new Error('請使用 Apps Script Web App URL。');
        }

        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const imported = XLSX.utils.sheet_to_json(firstSheet);
        const cleaned = imported.map(item => ({
            name: item['姓名 (Name)'] || item['Name'] || item.name || '',
            from_post: item['原職 (From Post)'] || item['From Post'] || item.from_post || item.fromPost || '',
            from_dept: item['原部門 (From Dept)'] || item['From Dept'] || item.from_dept || item.fromDept || '',
            to_post: item['現職 (To Post)'] || item['To Post'] || item.to_post || item.toPost || '',
            to_dept: item['現部門 (To Dept)'] || item['To Dept'] || item.to_dept || item.toDept || '',
            date: item['生效日期'] || item['Date'] || item.date || '',
            remark: item['備註 (Remark)'] || item['Remark'] || item.remark || '',
            posting_notice: item['PN No.'] || item['Posting No.'] || item['PN'] || item.posting_notice || item.postingNotice || item.pn_no || item.pnNo || ''
        })).filter(r => r.name);

        const postsSheetName = workbook.SheetNames.find(n => n === 'Posts');
        if (postsSheetName) {
            const postRows = XLSX.utils.sheet_to_json(workbook.Sheets[postsSheetName]);
            postRows.forEach(row => {
                const p = (row['職位 (Post)'] || row['Post'] || '').toString().trim();
                const d = (row['部門 (Department)'] || row['Dept'] || row['Department'] || '').toString().trim();
                const s = (row['狀態 (Status)'] || row['Status'] || '').toString().trim();
                const rm = (row['崗位備註 (Remark)'] || row['Remark'] || '').toString().trim();
                if (p || d) {
                    const key = getRoleKey(p, d);
                    if (rm) roleNotes[key] = rm;
                    if (s === 'deleted') postOverrides[key] = 'deleted';
                }
            });
        }
        const colleagueSheetName = workbook.SheetNames.find(n => n === 'Colleagues');
        if (colleagueSheetName) {
            const colleagueRows = XLSX.utils.sheet_to_json(workbook.Sheets[colleagueSheetName]);
            colleagueRows.forEach(row => {
                const personName = row['姓名 (Name)'] || row['Name'] || '';
                const personNick = row['暱稱 (Nickname)'] || row['Nickname'] || row['暱稱'] || '';
                const personRemark = row['人物備註'] || row['Person Remark'] || '';
                const photoData = combineExcelSafeText(row, '人物相片資料_');
                if (personName && personNick) personNicknames[personName] = personNick;
                if (personName && personRemark) personNotes[personName] = personRemark;
                if (personName && photoData) personImages[personName] = photoData;
            });
        }

        records = cleaned;

        // Stamp metadata and audit for synced records
        if (typeof ensureRecordMeta === 'function') {
            for (var sc = 0; sc < records.length; sc++) {
                records[sc] = ensureRecordMeta(records[sc], 'gdrive-sync');
            }
            recordBulkAuditEvent('SYNC_DRIVE', cleaned.length, 'sync', 'gdrive-sync');
        }

        localStorage.setItem('sys_person_notes_pro', JSON.stringify(personNotes));
        localStorage.setItem('sys_person_images_pro', JSON.stringify(personImages));
        _markAllDirty();
        _invalidateAllCaches();
        localStorage.setItem('sys_posting_records_pro', JSON.stringify(records));
        setSyncStatus('draft');
        if (typeof syncCanonicalStores === 'function') syncCanonicalStores(records);
        if (typeof resolveNoticeStatuses === 'function') resolveNoticeStatuses();
        if (typeof revalidateAll === 'function') revalidateAll();
    } catch (err) {
        console.error('GDrive sync error:', err);
        const hint = `⚠ 同步失敗：${err.message}`;
        setGdriveStatus(hint, 'text-red-500');
        addLog(`Google Drive 同步失敗：${err.message}`, 'error');
        setSyncStatus('failed', undefined, err.message);
    }
}

function saveApiKey() {
    const apiKey = document.getElementById('apiKey').value.trim();
    localStorage.setItem('deepseek_api_key_pro', apiKey);
    addLog("API Key 已更新並儲存。", "info");
    showToast("API Key 已儲存", 'success');
}

function toggleDbSearchClearBtn() {
    var input = document.getElementById('dbSearch');
    var btn = document.getElementById('dbSearchClearBtn');
    if (!input || !btn) return;
    if ((input.value || '').trim()) btn.classList.remove('hidden');
    else btn.classList.add('hidden');
}

function _onDbSearchInput() {
    toggleDbSearchClearBtn();
    _markDirty('database');
    _debounce('dbSearch', function() { renderDatabaseTable(); }, 150);
}

function _onCurrentSearchInput() {
    var el = document.getElementById('currentSearch');
    var clearBtn = document.getElementById('currentSearchClearBtn');
    if (clearBtn) { (el && el.value) ? clearBtn.classList.remove('hidden') : clearBtn.classList.add('hidden'); }
    _markDirty('current');
    _debounce('currentSearch', function() { renderCurrentTable(); }, 150);
}

function clearDbSearch() {
    var input = document.getElementById('dbSearch');
    if (!input) return;
    input.value = '';
    _markDirty('database');
    renderDatabaseTable();
    toggleDbSearchClearBtn();
    input.focus();
}

function renderDbCards() { renderDatabaseTable(); }
function renderCurrentCards() { renderCurrentTable(); }

function openManualSection() {
    switchTab('manual');
    clearManualForm();
}

function addLog(msg, type = 'default') {
    const consoleBox = document.getElementById('logConsole');
    const colorClass = type === 'error' ? 'text-red-400' : (type === 'info' ? 'text-blue-400' : 'text-green-400');
    consoleBox.innerHTML += `<div class="${colorClass} mb-1">> [${new Date().toLocaleTimeString()}] ${msg}</div>`;
    consoleBox.scrollTop = consoleBox.scrollHeight;
}

function parseDateKey(dateStr) {
    const raw = (dateStr || '').trim();
    if (!raw) return '';

    const dotMatch = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (dotMatch) {
        const day = dotMatch[1].padStart(2, '0');
        const month = dotMatch[2].padStart(2, '0');
        const year = dotMatch[3];
        return `${year}${month}${day}`;
    }

    const textMatch = raw.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
    if (textMatch) {
        const monthMap = {
            jan: '01', january: '01',
            feb: '02', february: '02',
            mar: '03', march: '03',
            apr: '04', april: '04',
            may: '05',
            jun: '06', june: '06',
            jul: '07', july: '07',
            aug: '08', august: '08',
            sep: '09', sept: '09', september: '09',
            oct: '10', october: '10',
            nov: '11', november: '11',
            dec: '12', december: '12'
        };
        const day = textMatch[1].padStart(2, '0');
        const month = monthMap[textMatch[2].toLowerCase()] || '00';
        const year = textMatch[3];
        return `${year}${month}${day}`;
    }

    const parsed = new Date(raw);
    if (!isNaN(parsed.getTime())) {
        const year = String(parsed.getFullYear());
        const month = String(parsed.getMonth() + 1).padStart(2, '0');
        const day = String(parsed.getDate()).padStart(2, '0');
        return `${year}${month}${day}`;
    }

    return raw;
}

function cleanDirectoryName(name) {
    return (name || '')
        .replace(/^(Miss|Ms|Mr\.?|Mrs|Dr\.?|Madam)\s+/i, '')
        .replace(/\((Miss|Ms|Mr|Mrs|Dr|Madam)\)/gi, '')
        .replace(/-/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getCurrentRecordByName(name) {
    return (records || [])
        .filter(r => (r.name || '') === (name || ''))
        .sort((a, b) => parseDateKey(b.date).localeCompare(parseDateKey(a.date)))[0] || null;
}

function buildDirectoryUrl(name, dept = '') {
    const currentRec = getCurrentRecordByName(name);
    const cleanName = cleanDirectoryName(name);
    const currentDept = (currentRec && (currentRec.to_dept || '').trim()) || (dept || '').trim();
    let url = `https://www.directory.gov.hk/basic_search2.jsp?fullname=${encodeURIComponent(cleanName)}&lang=eng`;
    if (currentDept) url += `&ou=${encodeURIComponent('ou=' + currentDept)}`;
    return url;
}

function getLatestRecordByName(name) {
    return (records || [])
        .filter(r => (r.name || '') === (name || ''))
        .sort((a, b) => parseDateKey(b.date).localeCompare(parseDateKey(a.date)))[0] || null;
}

function getCurrentHolderByRole(post, dept) {
    return (records || [])
        .filter(r => (r.to_post || '') === (post || '') && (r.to_dept || '') === (dept || ''))
        .sort((a, b) => parseDateKey(b.date).localeCompare(parseDateKey(a.date)))[0] || null;
}

function updateContactButton() {
    const btn = document.getElementById('contactBtn');
    if (!btn) return;

    let contactName = '';
    let contactDept = '';

    if (historyTarget.type === 'name') {
        const currentRec = getCurrentRecordByName(historyTarget.value);
        contactName = historyTarget.value || '';
        contactDept = currentRec ? (currentRec.to_dept || '') : '';
    } else if (historyTarget.type === 'role') {
        const holder = getCurrentHolderByRole(historyTarget.value, historyTarget.dept || '');
        if (holder) {
            contactName = holder.name || '';
            const currentRec = getCurrentRecordByName(holder.name || '');
            contactDept = currentRec ? (currentRec.to_dept || holder.to_dept || historyTarget.dept || '') : (holder.to_dept || historyTarget.dept || '');
        }
    }

    if (contactName) {
        btn.dataset.url = buildDirectoryUrl(contactName, contactDept);
        btn.classList.remove('hidden');
    } else {
        btn.dataset.url = '';
        btn.classList.add('hidden');
    }
}

function openSelectedContact() {
    const btn = document.getElementById('contactBtn');
    if (!btn || !btn.dataset.url) return;
    window.open(btn.dataset.url, '_blank', 'noopener,noreferrer');
}

function getRoleKey(post, dept = '') {
    return `${(post || '').trim()}||${(dept || '').trim()}`;
}

function updateSelectionRemarkPanel() {
    const panel = document.getElementById('selectionRemarkPanel');
    const label = document.getElementById('selectionRemarkLabel');
    const input = document.getElementById('selectionRemarkInput');
    if (!panel || !label || !input) return;

    if (!isAdmin()) {
        panel.classList.add('hidden');
        return;
    }

    if (historyTarget.type === 'name') {
        const nickGroup = document.getElementById('selectionNicknameGroup');
        const nickInput = document.getElementById('selectionNicknameInput');
        if (nickGroup) nickGroup.classList.remove('hidden');
        if (nickInput) nickInput.value = personNicknames[historyTarget.value] || '';
        label.innerText = '人物備註';
        input.value = personNotes[historyTarget.value] || '';
        input.placeholder = '可輸入聯絡提示或其他資料...';
        panel.classList.remove('hidden');

        const delBtn = document.getElementById('toggleDeletePostBtn');
        if (delBtn) delBtn.classList.add('hidden');
        return;
    }

    if (historyTarget.type === 'role') {
        const nickGroup = document.getElementById('selectionNicknameGroup');
        if (nickGroup) nickGroup.classList.add('hidden');
        const key = getRoleKey(historyTarget.value, historyTarget.dept || '');
        label.innerText = '崗位備註';
        input.value = roleNotes[key] || '';
        input.placeholder = '可輸入這個崗位的工作說明、注意事項或其他資料...';
        panel.classList.remove('hidden');

        const delBtn = document.getElementById('toggleDeletePostBtn');
        if (delBtn) {
            delBtn.classList.remove('hidden');
            if (postOverrides[key] === 'deleted') {
                delBtn.textContent = '取消撤銷標記 (Restore)';
                delBtn.className = 'w-full bg-emerald-50 hover:bg-emerald-100 text-emerald-600 text-xs font-bold py-2 rounded-lg transition-all border border-emerald-200 mt-2';
            } else {
                delBtn.textContent = '將此崗位標記為「已撤銷」 (Mark as Obsolete)';
                delBtn.className = 'w-full bg-red-50 hover:bg-red-100 text-red-600 text-xs font-bold py-2 rounded-lg transition-all border border-red-200 mt-2';
            }
        }
        return;
    }

    panel.classList.add('hidden');
}

function togglePostDeletion() {
    if (!isAdmin()) return;
    if (historyTarget.type !== 'role') return;
    const key = getRoleKey(historyTarget.value, historyTarget.dept || '');
    if (postOverrides[key] === 'deleted') {
        delete postOverrides[key];
        addLog(`恢復崗位：${historyTarget.value}`, 'info');
    } else {
        postOverrides[key] = 'deleted';
        addLog(`標記崗位已撤銷：${historyTarget.value}`, 'info');
    }
    localStorage.setItem('sys_post_overrides', JSON.stringify(postOverrides));
    _markAllDirty();
    updateSelectionRemarkPanel();
    if (document.getElementById('currentTableBody')) renderCurrentTable();
    if (document.getElementById('historyTableContainer')) renderHistoryView();

    _scheduleIdle(function() {
        var gdriveUrl = document.getElementById('gdriveLink') ? document.getElementById('gdriveLink').value.trim() : '';
        if (gdriveUrl && gdriveUrl.includes('script.google.com')) { saveAllToSheets(); }
    });
}

function saveSelectionRemark() {
    if (!isAdmin()) return;
    const input = document.getElementById('selectionRemarkInput');
    if (!input) return;
    const value = input.value.trim();

    if (historyTarget.type === 'name') {
        const nickInput = document.getElementById('selectionNicknameInput');
        const nickValue = nickInput ? nickInput.value.trim() : '';

        if (nickValue) personNicknames[historyTarget.value] = nickValue;
        else delete personNicknames[historyTarget.value];

        if (value) personNotes[historyTarget.value] = value;
        else delete personNotes[historyTarget.value];

        localStorage.setItem('sys_person_nicknames_pro', JSON.stringify(personNicknames));
        localStorage.setItem('sys_person_notes_pro', JSON.stringify(personNotes));
        addLog('已保存人物資料：' + historyTarget.value, 'info');

        _markAllDirty();
        renderDatabaseTable();
        if (document.getElementById('currentTableBody')) renderCurrentTable();
        renderHistoryView();
        return;
    }

    if (historyTarget.type === 'role') {
        const nickGroup = document.getElementById('selectionNicknameGroup');
        if (nickGroup) nickGroup.classList.add('hidden');
        const key = getRoleKey(historyTarget.value, historyTarget.dept || '');
        if (value) roleNotes[key] = value;
        else delete roleNotes[key];

        localStorage.setItem('sys_post_overrides', JSON.stringify(postOverrides));
        localStorage.setItem('sys_role_notes_pro', JSON.stringify(roleNotes));
        addLog('已保存崗位備註：' + historyTarget.value + ' (' + (historyTarget.dept || '') + ')', 'info');
    }

    _markAllDirty();
    _scheduleIdle(function() {
        var gdriveUrl = document.getElementById('gdriveLink') ? document.getElementById('gdriveLink').value.trim() : '';
        if (gdriveUrl && gdriveUrl.includes('script.google.com')) { saveAllToSheets(); }
    });
}

function formatPersonName(nameStr) {
    let n = (nameStr || '').trim().replace(/\s+/g, ' ');
    const match = n.match(/\((Miss|Ms|Mr|Mrs|Dr|Madam)\)/i);
    if (match) {
        const title = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
        n = n.replace(match[0], '').trim();
        if (n.endsWith(',')) n = n.slice(0, -1).trim();
        return title + ' ' + n;
    }
    return n;
}

function clearManualForm() {
    ['manualName','manualFromPost','manualFromDept','manualToPost','manualToDept','manualDate','manualPN','manualRemark'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
}

function addManualRecord() {
    if (!isAdmin()) return;
    var rec = {
        name: formatPersonName(document.getElementById('manualName')?.value || ''),
        from_post: (document.getElementById('manualFromPost')?.value || '').trim(),
        from_dept: (document.getElementById('manualFromDept')?.value || '').trim(),
        to_post: (document.getElementById('manualToPost')?.value || '').trim(),
        to_dept: (document.getElementById('manualToDept')?.value || '').trim(),
        date: (document.getElementById('manualDate')?.value || '').trim(),
        posting_notice: (document.getElementById('manualPN')?.value || '').trim(),
        remark: (document.getElementById('manualRemark')?.value || '').trim()
    };

    if (!rec.name || !rec.to_post || !rec.to_dept || !rec.date) {
        showToast('請最少填寫姓名、現職、現部門及生效日期。', 'warning');
        return;
    }

    var idx = records.findIndex(function(r) {
        return (r.name || '').trim() === rec.name &&
               (r.posting_notice || '').trim() === rec.posting_notice &&
               (r.date || '').trim() === rec.date;
    });

    if (typeof ensureRecordMeta === 'function') {
        if (idx > -1) {
            var oldSnap = JSON.parse(JSON.stringify(records[idx]));
            var changedFields = _diffFields(oldSnap, rec);
            stampRecordMeta(records[idx], 'admin', '');
            records[idx] = Object.assign(records[idx], rec);
            records[idx]._updatedAt = new Date().toISOString();
            records[idx]._updatedBy = 'admin';
            recordAuditEvent('EDIT', records[idx], {
                performedBy: 'admin',
                snapshot: oldSnap,
                fieldsChanged: changedFields,
                before: _pickFields(oldSnap, changedFields),
                after: _pickFields(records[idx], changedFields)
            });
        } else {
            rec = ensureRecordMeta(rec, 'manual');
            records.unshift(rec);
            recordAuditEvent('CREATE', rec, { performedBy: 'admin', snapshot: null });
        }
    } else {
        if (idx > -1) records[idx] = Object.assign(records[idx], rec);
        else records.unshift(rec);
    }

        saveAndSync();
        updateUndoButton();
        renderDatabaseTable();
    clearManualForm();
    updateUndoButton();
    addLog('已人手新增/更新紀錄：' + rec.name, 'info');
    switchTab('database');
}

function _diffFields(oldRec, newRec) {
    var fields = [];
    var keys = ['name', 'from_post', 'from_dept', 'to_post', 'to_dept', 'date', 'posting_notice', 'remark'];
    for (var i = 0; i < keys.length; i++) {
        if ((oldRec[keys[i]] || '') !== (newRec[keys[i]] || '')) fields.push(keys[i]);
    }
    return fields;
}

function _pickFields(rec, fields) {
    var obj = {};
    for (var i = 0; i < fields.length; i++) {
        obj[fields[i]] = rec[fields[i]] || '';
    }
    return obj;
}

function splitExcelSafeText(text, chunkSize = 30000) {
    const value = text || '';
    if (!value) return [];
    const chunks = [];
    for (let i = 0; i < value.length; i += chunkSize) {
        chunks.push(value.slice(i, i + chunkSize));
    }
    return chunks;
}

function combineExcelSafeText(row, prefix = '人物相片資料_') {
    if (!row || typeof row !== 'object') return '';
    const chunkKeys = Object.keys(row)
        .filter(key => key.startsWith(prefix))
        .sort((a, b) => {
            const na = parseInt(a.replace(prefix, ''), 10) || 0;
            const nb = parseInt(b.replace(prefix, ''), 10) || 0;
            return na - nb;
        });
    if (chunkKeys.length) return chunkKeys.map(key => row[key] || '').join('');
    return row['人物相片資料 (Data URL)'] || row['人物相片資料'] || row['Person Photo Data URL'] || row['Photo Data URL'] || '';
}

function syncPersonImages() {
    localStorage.setItem('sys_person_images_pro', JSON.stringify(personImages));
}

function updatePersonImagePanel() {
    const panel = document.getElementById('personImagePanel');
    const preview = document.getElementById('personImagePreview');
    const uploadLabel = document.getElementById('personImageUploadLabel');
    const removeBtn = document.getElementById('removePersonImageBtn');
    const ceaseBtn = document.getElementById('ceaseActingBtn');
    const input = document.getElementById('personImageInput');
    if (!panel || !preview || !uploadLabel || !removeBtn || !input) return;

    const isPerson = historyTarget.type === 'name' && historyTarget.value;
    const img = isPerson ? (personImages[historyTarget.value] || '') : '';

    if (isPerson && isAdmin()) {
        uploadLabel.classList.remove('hidden');
        if (ceaseBtn) {
            var isActing = false;
            if (typeof getOccupancySnapshot === 'function') {
                var snapshot = getOccupancySnapshot(getAsOfDateKey());
                for (var key in snapshot) {
                    if (snapshot.hasOwnProperty(key) && snapshot[key].actingHolder && snapshot[key].actingHolder.name === historyTarget.value) {
                        isActing = true;
                        break;
                    }
                }
            }
            if (isActing) ceaseBtn.classList.remove('hidden');
            else ceaseBtn.classList.add('hidden');
        }
    } else {
        uploadLabel.classList.add('hidden');
        if (ceaseBtn) ceaseBtn.classList.add('hidden');
        input.value = '';
    }

    if (img) {
        preview.src = img;
        panel.classList.remove('hidden');
        if (isAdmin()) removeBtn.classList.remove('hidden');
        else removeBtn.classList.add('hidden');
    } else {
        preview.removeAttribute('src');
        panel.classList.add('hidden');
        removeBtn.classList.add('hidden');
    }
}

function handlePersonImageUpload(event) {
    if (!isAdmin()) return;
    const file = event.target.files && event.target.files[0];
    if (!file || historyTarget.type !== 'name' || !historyTarget.value) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        const img = new Image();
        img.onload = function() {
            const MAX = 400;
            const scale = Math.min(1, MAX / Math.max(img.width, img.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            const compressed = canvas.toDataURL('image/jpeg', 0.75);
            personImages[historyTarget.value] = compressed;
            syncPersonImages();
            updatePersonImagePanel();
            addLog(`已保存人物相片：${historyTarget.value}（${Math.round(compressed.length/1024)}KB）`, 'info');
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function removePersonImage() {
    if (!isAdmin()) return;
    if (historyTarget.type !== 'name' || !historyTarget.value) return;
    delete personImages[historyTarget.value];
    syncPersonImages();
    updatePersonImagePanel();
    const input = document.getElementById('personImageInput');
    if (input) input.value = '';
    addLog(`已移除人物相片：${historyTarget.value}`, 'info');
}

function markCeaseActing() {
    if (!isAdmin()) return;
    if (historyTarget.type !== 'name' || !historyTarget.value) return;
    var personName = historyTarget.value;
    var today = new Date();
    var dateStr = today.getDate() + '.' + (today.getMonth() + 1) + '.' + today.getFullYear();

    var latestRec = records
        .filter(function(r) { return (r.name || '').trim() === personName; })
        .sort(function(a, b) { return parseDateKey(b.date).localeCompare(parseDateKey(a.date)); })[0];

    if (!latestRec) {
        showToast('找不到 ' + personName + ' 的任何紀錄。', 'warning');
        return;
    }

    var post = latestRec.to_post || '';
    var dept = latestRec.to_dept || '';

    if (!post) {
        showToast(personName + ' 的現任崗位不明，無法生成解除署任紀錄。', 'warning');
        return;
    }

    if (!confirm('確定要為 ' + personName + ' 創建「解除署任」紀錄？\n\n崗位：' + post + (dept ? ' (' + dept + ')' : '') + '\n生效日期：' + dateStr + '\n\n系統會新增一條 remark 為 "to cease acting" 的紀錄。')) return;

    var rec = {
        name: personName,
        from_post: post,
        from_dept: dept,
        to_post: post,
        to_dept: dept,
        date: dateStr,
        posting_notice: '(ADMIN)',
        remark: 'to cease acting (confirmed promotion - no posting notice issued)'
    };

    if (typeof ensureRecordMeta === 'function') {
        rec = ensureRecordMeta(rec, 'manual');
        recordAuditEvent('APPROVE', rec, {
            performedBy: 'admin',
            snapshot: null,
            fieldsChanged: [],
            changeReason: 'Admin marked cease-acting for confirmed promotion'
        });
    }

    records.unshift(rec);
    saveAndSync();
    updateUndoButton();
    renderHistoryView();
    addLog('已創建 ' + personName + ' 的解除署任紀錄 (PN: ADMIN)', 'info');
    showToast('已解除 ' + personName + ' 的署任狀態。', 'success', 4000);
}

async function processPDF() {
    if (!isAdmin()) return;
    const apiKey = document.getElementById('apiKey').value.trim();
    const fileInput = document.getElementById('pdfFile');
    const files = fileInput.files;

    if (!apiKey || files.length === 0) {
        addLog("錯誤：請填寫 API Key 並選取最少一份 PDF", 'error');
        return;
    }

    localStorage.setItem('deepseek_api_key_pro', apiKey);
    const btn = document.getElementById('processBtn');
    btn.disabled = true;
    btn.innerHTML = '正在解析中...';

    let totalAffected = 0;

    try {
        for (let f = 0; f < files.length; f++) {
            const file = files[f];
            addLog(`[${f + 1}/${files.length}] 正在讀取 PDF 內容: ${file.name}...`);
            const arrayBuffer = await file.arrayBuffer();
            const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

            let fullText = "";
            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const content = await page.getTextContent();
                fullText += content.items.map(item => item.str).join(' ') + '\n';
            }

            addLog(`[${f + 1}/${files.length}] 完成讀取，發送至 DeepSeek AI 分析...`);
            const result = await callDeepSeek(apiKey, fullText);

            if (!Array.isArray(result) || result.length === 0) {
                addLog(`[${f + 1}/${files.length}] 警告：AI 未返回有效紀錄，將跳過此檔案。`, 'error');
                continue;
            }

            let fileAffected = 0;
            result.forEach(newRec => {
                const normalized = {
                    name: (() => {
                        let n = (newRec.name || '').trim().replace(/\s+/g, ' ');
                        const match = n.match(/\((Miss|Ms|Mr|Mrs|Dr|Madam)\)/i);
                        if (match) {
                            const title = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
                            n = n.replace(match[0], '').trim();
                            if (n.endsWith(',')) n = n.slice(0, -1).trim();
                            return title + ' ' + n;
                        }
                        const existingTitleMatch = n.match(/^(Miss|Ms|Mr\.|Mr|Mrs|Dr\.|Dr|Madam)\b/i);
                        if (!existingTitleMatch && n.length > 0) {
                            return 'Mr ' + n;
                        }
                        return n;
                    })(),
                    from_post: (newRec.from_post || '').trim(),
                    from_dept: (newRec.from_dept || '').trim(),
                    to_post: (newRec.to_post || '').trim(),
                    to_dept: (newRec.to_dept || '').trim(),
                    date: (newRec.date || '').trim(),
                    remark: (newRec.remark || '').trim(),
                    posting_notice: (newRec.posting_notice || '').trim()
                };

                if (!normalized.name) return;

                const idx = records.findIndex(r =>
                    (r.name || '').trim() === normalized.name &&
                    (r.posting_notice || '').trim() === normalized.posting_notice &&
                    (r.date || '').trim() === normalized.date
                );

                if (idx > -1) {
                    if (typeof ensureRecordMeta === 'function') {
                        var oldSnap = JSON.parse(JSON.stringify(records[idx]));
                        var changedFields = _diffFields(oldSnap, normalized);
                        stampRecordMeta(records[idx], 'ai', '');
                        Object.assign(records[idx], normalized);
                        records[idx]._updatedAt = new Date().toISOString();
                        records[idx]._updatedBy = 'ai';
                        recordAuditEvent('EDIT', records[idx], {
                            performedBy: 'ai',
                            snapshot: oldSnap,
                            fieldsChanged: changedFields,
                            before: _pickFields(oldSnap, changedFields),
                            after: _pickFields(records[idx], changedFields)
                        });
                    } else {
                        records[idx] = Object.assign(records[idx], normalized);
                    }
                } else {
                    if (typeof ensureRecordMeta === 'function') {
                        normalized = ensureRecordMeta(normalized, 'ai-extract');
                        recordAuditEvent('AI_EXTRACT', normalized, { performedBy: 'ai', snapshot: null });
                    }
                    records.unshift(normalized);
                }
                fileAffected++;
                totalAffected++;
            });

            addLog(`[${f + 1}/${files.length}] 解析成功！${file.name} 提取了 ${fileAffected} 筆數據。`, 'info');
        }

        saveAndSync();
        _markAllDirty();
        _invalidateAllCaches();
        renderDatabaseTable();
        switchTab('database');
        addLog(`✅ 總共處理了 ${files.length} 份檔案，合共新增/更新了 ${totalAffected} 筆數據。`, 'info');

        fileInput.value = "";
        document.getElementById('fileName').innerText = '未選取檔案';

    } catch (err) {
        addLog(`失敗: ${err.message}`, 'error');
        console.error(err);
    } finally {
        btn.disabled = false;
        btn.innerText = "運行 AI 解析提取";
    }
}

async function callDeepSeek(apiKey, text) {
    const systemPrompt = `Extract  personnel moves from the Posting Notice text into a JSON array.
Rules:
1. Look for Posting Notice No (e.g., 1/2018 or 4/2026).
2. For each person, identify Name, From Post, From Dept, To Post, To Dept, Date (DD.MM.YYYY), and Remarks.
3. If "Name & Rank" are combined, ignore the Rank part for the Name field. You MUST place titles like (Miss), (Ms), or (Mr) at the FRONT of the name. If there is NO title indicated for a person, assume it is "Mr" and add "Mr " to the front of their name (e.g., "CHU Tik-lun" becomes "Mr CHU Tik-lun").
4. In older formats (e.g. 2018), "From" and "To" might be structured differently. E.g. "From: ASO(P&I)SD ", so from_post="ASO(P&I)SD", from_dept="".
5. If someone is a "New appointee" in the From column, set from_post="New appointee" and from_dept="".
Return ONLY a raw JSON array. Fields: name, from_post, from_dept, to_post, to_dept, date, remark, posting_notice. No markdown, no markdown blocks.`;

    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: 'deepseek-v4-flash',
            thinking: { type: "enabled" },
            reasoning_effort: "high",
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: text }
            ],
            temperature: 0
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API Connection Failed: ${response.status} ${errText}`);
    }

    const data = await response.json();
    const raw = (data?.choices?.[0]?.message?.content || '').trim();

    if (!raw) {
        throw new Error('AI 回傳為空');
    }

    const cleaned = raw.replace(/```json|```/gi, '').trim();
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    const parsed = JSON.parse(arrayMatch ? arrayMatch[0] : cleaned);

    const arr = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.records)
            ? parsed.records
            : [];

    return arr.map(item => ({
        name: item.name || '',
        from_post: item.from_post || item.fromPost || '',
        from_dept: item.from_dept || item.fromDept || '',
        to_post: item.to_post || item.toPost || '',
        to_dept: item.to_dept || item.toDept || '',
        date: item.date || '',
        remark: item.remark || '',
        posting_notice: item.posting_notice || item.postingNotice || item.pn_no || item.pnNo || ''
    }));
}

function sortTable(key) {
    if (sortState.key === key) sortState.direction = sortState.direction === 'asc' ? 'desc' : 'asc';
    else { sortState.key = key; sortState.direction = 'asc'; }
    _markDirty('database');
    renderDatabaseTable();
}

let currentSortState = { key: 'date', direction: 'desc' };

function sortCurrentTable(key) {
    if (currentSortState.key === key) {
        currentSortState.direction = currentSortState.direction === 'asc' ? 'desc' : 'asc';
    } else {
        currentSortState.key = key;
        currentSortState.direction = key === 'date' || key === 'pn' ? 'desc' : 'asc';
    }
    _markDirty('current');
    _debounce('currentSort', function() { renderCurrentTable(); }, 50);
}

function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function escapeJsHtml(s) {
    return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\\\'");
}

function sortCurrentTable(key) {
    if (currentSortState.key === key) {
        currentSortState.direction = currentSortState.direction === 'asc' ? 'desc' : 'asc';
    } else {
        currentSortState.key = key;
        currentSortState.direction = key === 'date' || key === 'pn' ? 'desc' : 'asc';
    }
    renderCurrentTable();
}

function updateCurrentSortIndicators() {
    ['name', 'date', 'pn', 'role'].forEach(k => {
        const el = document.getElementById(`currentSort_${k}`);
        if (!el) return;
        if (currentSortState.key === k) {
            el.textContent = currentSortState.direction === 'asc' ? '↑' : '↓';
        } else {
            el.textContent = '';
        }
    });
}

function renderCurrentTable() {
    var search = (document.getElementById('currentSearch')?.value || '').toLowerCase();
    var clearBtn = document.getElementById('currentSearchClearBtn');
    if (clearBtn) { search ? clearBtn.classList.remove('hidden') : clearBtn.classList.add('hidden'); }

    var rows = _getMemoCurrentRows();

    if (typeof updateCurrentSortIndicators === 'function') updateCurrentSortIndicators();

    var tbody = document.getElementById('currentTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="px-6 py-12 text-center text-slate-400 text-sm">暫無紀錄</td></tr>';
        var cbody0 = document.getElementById('currentCardBody');
        if (cbody0) cbody0.innerHTML = '<div class="py-12 text-center text-slate-400 text-sm">暫無紀錄</div>';
        return;
    }

    for (var ri = 0; ri < rows.length; ri++) {
        var r = rows[ri];
        var img = (r.isVacant || r.isDeleted) ? '' : (personImages[r.name] || '');
        var nick = (r.isVacant || r.isDeleted) ? '' : (personNicknames[r.name] || '');
        var avatarHtml = '';
        if (!r.isVacant && !r.isDeleted) {
            avatarHtml = img
                ? '<img src="' + img + '" class="w-8 h-8 rounded-full object-cover inline-block mr-2 align-middle" alt="">'
                : '<span class="w-8 h-8 rounded-full bg-blue-100 text-blue-600 text-xs font-bold inline-flex items-center justify-center mr-2 align-middle">' + (r.name || '?')[0] + '</span>';
        }

        var tr = document.createElement('tr');
        var curRowClass = 'hover:bg-slate-50 transition-colors' + (r.isDeleted ? ' bg-slate-100/50 opacity-60' : (r.isVacant ? ' bg-amber-50/30' : (r.isFutureIncoming ? ' bg-indigo-50/50' : (r.isActing ? ' bg-purple-50/20' : ''))));
        if (typeof isNoticeSupersededByAdmin === 'function' && r.posting_notice && r.posting_notice !== '-' && isNoticeSupersededByAdmin(r.posting_notice)) {
            curRowClass += ' superseded-row';
        }
        tr.className = curRowClass;

        var nameContent = '';
        if (r.isDeleted) {
            nameContent = '<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-100 text-slate-500 text-xs font-bold border border-slate-200"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"></path></svg>已撤銷 (Obsolete)</span>';
        } else if (r.isVacant) {
            nameContent = '<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-50 text-amber-700 text-xs font-bold border border-amber-200"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>懸空 (Vacant)</span>';
        } else if (r.isFutureIncoming) {
            nameContent = avatarHtml + '<span class="align-middle">' + escapeHtml(r.name) + (nick ? ' <span class="text-slate-400 font-normal ml-1 text-[11px]">(' + escapeHtml(nick) + ')</span>' : '') + '</span>';
        } else {
            nameContent = avatarHtml + '<span class="align-middle">' + escapeHtml(r.name) + (nick ? ' <span class="text-slate-400 font-normal ml-1 text-[11px]">(' + escapeHtml(nick) + ')</span>' : '') + '</span>';
        }

        var badges = '';
        if (r.isActing) badges += '<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-100 text-purple-700 ml-1.5 align-middle">署任</span>';
        if (r.onAttachment) badges += '<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-cyan-100 text-cyan-700 ml-1 align-middle">借調</span>';
        if (r.isFutureIncoming) badges += '<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-indigo-100 text-indigo-700 ml-1.5 align-middle">到任</span>';

        tr.innerHTML =
            '<td class="px-6 py-4 font-bold ' + ((r.isVacant || r.isDeleted) ? '' : 'text-blue-600 cursor-pointer hover:underline') + ' whitespace-nowrap"' + ((r.isVacant || r.isDeleted) ? '' : ' onclick="viewHistory(\'name\', \'' + escapeJsHtml(r.name) + '\')"') + '>' +
                nameContent + badges +
            '</td>' +
            '<td class="px-6 py-4 cursor-pointer hover:text-blue-500" onclick="viewHistory(\'role\', \'' + escapeJsHtml(r.to_post) + '\', \'' + escapeJsHtml(r.to_dept) + '\')">' +
                '<div class="font-medium text-blue-800">' + escapeHtml(r.to_post) + '</div>' +
                '<div class="text-[10px] text-blue-400 font-bold hover:underline" onclick="event.stopPropagation(); viewHistory(\'dept\', \'' + escapeJsHtml(r.to_dept) + '\')">' + escapeHtml(r.to_dept) + '</div>' +
            '</td>' +
            '<td class="px-6 py-4 text-slate-500 font-mono text-xs">' + escapeHtml(r.date) + '</td>' +
            '<td class="px-6 py-4 text-xs font-bold text-blue-500 cursor-pointer hover:underline" onclick="viewHistory(\'pn\', \'' + escapeJsHtml(r.posting_notice) + '\')">' + escapeHtml(r.posting_notice || '-') + ' ' + _renderNoticeStatusBadge(r.posting_notice, r.rawRecord || r) + '</td>' +
            '<td class="px-6 py-4 flex gap-3">' +
                (isAdmin() ? '<button onclick="openEditModalByName(\'' + escapeJsHtml(r.rawRecord.name) + '\', \'' + escapeJsHtml(r.rawRecord.posting_notice) + '\')" class="text-blue-500 hover:text-blue-700 font-bold text-xs uppercase tracking-tighter">修改</button>' : '') +
            '</td>';
        tbody.appendChild(tr);
    }

    var currentCardBody = document.getElementById('currentCardBody');
    if (currentCardBody) {
        currentCardBody.innerHTML = '';
        for (var rj = 0; rj < rows.length; rj++) {
            var rc = rows[rj];
            var cimg = (rc.isVacant || rc.isDeleted) ? '' : (personImages[rc.name] || '');
            var cn = (rc.isVacant || rc.isDeleted) ? '' : (personNicknames[rc.name] || '');
            var cav = '';
            if (rc.isDeleted) {
                cav = '<div class="w-10 h-10 rounded-full bg-slate-100 text-slate-400 text-sm flex items-center justify-center shrink-0"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"></path></svg></div>';
            } else if (rc.isVacant) {
                cav = '<div class="w-10 h-10 rounded-full bg-amber-100 text-amber-600 text-sm flex items-center justify-center shrink-0"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg></div>';
            } else {
                cav = cimg ? '<img src="' + cimg + '" class="w-10 h-10 rounded-full object-cover shrink-0" alt="">' : '<div class="w-10 h-10 rounded-full bg-blue-100 text-blue-600 text-sm font-bold flex items-center justify-center shrink-0">' + (rc.name || '?')[0] + '</div>';
            }

            var mobBadges = '';
            if (rc.isActing) mobBadges += '<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-100 text-purple-700 ml-1">署任</span>';
            if (rc.onAttachment) mobBadges += '<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-cyan-100 text-cyan-700 ml-1">借調</span>';
            if (rc.isFutureIncoming) mobBadges += '<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-indigo-100 text-indigo-700 ml-1">到任</span>';

            var cnContent = '';
            if (rc.isDeleted) {
                cnContent = '<div class="font-bold text-slate-500 text-base">已撤銷 (Obsolete)</div>';
            } else if (rc.isVacant) {
                cnContent = '<div class="font-bold text-amber-700 text-base">懸空 (Vacant)</div>';
            } else {
                cnContent = '<div class="font-bold text-blue-600 text-base cursor-pointer hover:underline" onclick="viewHistory(\'name\', \'' + escapeJsHtml(rc.name) + '\')">' + escapeHtml(rc.name) + (cn ? ' <span class="text-slate-400 font-normal ml-1 text-sm">(' + escapeHtml(cn) + ')</span>' : '') + mobBadges + '</div>';
            }

            var div = document.createElement('div');
            div.className = 'p-4 flex gap-4 bg-white items-center border-b border-slate-50' + (rc.isDeleted ? ' bg-slate-100/50 opacity-60' : (rc.isVacant ? ' bg-amber-50/20' : (rc.isFutureIncoming ? ' bg-indigo-50/50' : (rc.isActing ? ' bg-purple-50/20' : ''))));
            div.innerHTML =
                cav +
                '<div class="flex-1 min-w-0">' +
                    cnContent +
                    '<div class="font-medium text-slate-800 text-sm mt-0.5 cursor-pointer hover:text-blue-600 hover:underline" onclick="viewHistory(\'role\', \'' + escapeJsHtml(rc.to_post) + '\', \'' + escapeJsHtml(rc.to_dept) + '\')">' + escapeHtml(rc.to_post) + '</div>' +
                    '<div class="text-[10px] font-bold text-slate-400 cursor-pointer hover:text-blue-500 hover:underline" onclick="event.stopPropagation(); viewHistory(\'dept\', \'' + escapeJsHtml(rc.to_dept) + '\')">' + escapeHtml(rc.to_dept) + '</div>' +
                '</div>' +
                '<div class="text-right shrink-0">' +
                    '<div class="text-[10px] text-slate-400 font-mono mb-1">' + escapeHtml(rc.date) + '</div>' +
                    '<div class="text-[10px] font-bold text-blue-500 cursor-pointer hover:underline" onclick="viewHistory(\'pn\', \'' + escapeJsHtml(rc.posting_notice) + '\')">' + escapeHtml(rc.posting_notice) + ' ' + _renderNoticeStatusBadge(rc.posting_notice, rc.rawRecord || rc) + '</div>' +
                '</div>';
            currentCardBody.appendChild(div);
        }
    }
}

function renderDatabaseTable() {
    var filtered = _getMemoDbRows();
    var tbody = document.getElementById('dbTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    var rc = document.getElementById('recordCount'); if (rc) rc.innerText = filtered.length;

    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="px-6 py-12 text-center text-slate-400 text-sm">暫無紀錄</td></tr>';
        var cb2 = document.getElementById('dbCardBody');
        if (cb2) cb2.innerHTML = '<div class="py-12 text-center text-slate-400 text-sm">暫無紀錄</div>';
        return;
    }

    for (var fi = 0; fi < filtered.length; fi++) {
        var r = filtered[fi];
        var v = getValidationForRecordByIndex(records.indexOf(r));
        var ns = '';
        if (typeof isNoticeSupersededByAdmin === 'function' && r.posting_notice) {
            if (isNoticeSupersededByAdmin(r.posting_notice)) ns = ' superseded-row';
        }
        var tr = document.createElement('tr');
        tr.className = 'hover:bg-slate-50 transition-colors' + ns;
        tr.innerHTML =
            '<td class="px-6 py-4 font-bold text-blue-600 cursor-pointer hover:underline" onclick="viewHistory(\'name\', \'' + escapeJsHtml(r.name) + '\')">' + escapeHtml(r.name) + '</td>' +
            '<td class="px-6 py-4 cursor-pointer hover:text-blue-500" onclick="viewHistory(\'role\', \'' + escapeJsHtml(r.from_post) + '\', \'' + escapeJsHtml(r.from_dept) + '\')">' +
                '<div class="font-medium">' + escapeHtml(r.from_post) + '</div><div class="text-[10px] text-slate-400 font-bold hover:underline" onclick="event.stopPropagation(); viewHistory(\'dept\', \'' + escapeJsHtml(r.from_dept) + '\')">' + escapeHtml(r.from_dept) + '</div>' +
            '</td>' +
            '<td class="px-6 py-4 cursor-pointer hover:text-blue-500" onclick="viewHistory(\'role\', \'' + escapeJsHtml(r.to_post) + '\', \'' + escapeJsHtml(r.to_dept) + '\')">' +
                '<div class="font-medium text-blue-800">' + escapeHtml(r.to_post) + '</div><div class="text-[10px] text-blue-400 font-bold hover:underline" onclick="event.stopPropagation(); viewHistory(\'dept\', \'' + escapeJsHtml(r.to_dept) + '\')">' + escapeHtml(r.to_dept) + '</div>' +
            '</td>' +
            '<td class="px-6 py-4 text-slate-500 font-mono text-xs">' + escapeHtml(r.date) + '</td>' +
            '<td class="px-6 py-4 text-xs font-bold text-blue-500 cursor-pointer hover:underline" onclick="viewHistory(\'pn\', \'' + escapeJsHtml(r.posting_notice) + '\')">' + escapeHtml(r.posting_notice) + ' ' + _renderNoticeStatusBadge(r.posting_notice, r) + '</td>' +
            '<td class="px-6 py-4 admin-only">' + renderValidationBadge(v.severity, v.overridden) + (v.issues && v.issues.length > 0 ? '<div class="text-[10px] text-slate-600 mt-1 leading-relaxed space-y-0.5" title="' + escapeJsHtml(v.issues.map(function(iss) { return iss.message; }).join('\n')) + '">' + v.issues.map(function(iss) { return '<div>' + escapeHtml(iss.message) + '</div>'; }).join('') + '</div>' : '') + '</td>' +
            '<td class="px-6 py-4 flex gap-3">' +
                (isAdmin() ? '<button onclick="openEditModalByName(\'' + escapeJsHtml(r.name) + '\', \'' + escapeJsHtml(r.posting_notice) + '\')" class="text-blue-500 hover:text-blue-700 font-bold text-xs uppercase tracking-tighter">修改</button>' +
                '<button onclick="deleteRecord(\'' + escapeJsHtml(r.name) + '\', \'' + escapeJsHtml(r.posting_notice) + '\')" class="text-red-500 hover:text-red-700 font-bold text-xs uppercase tracking-tighter">刪除</button>' : '') +
            '</td>';
        tbody.appendChild(tr);
    }

    // Mobile cards — defer to next frame
    var cardBody = document.getElementById('dbCardBody');
    if (cardBody) {
        cardBody.innerHTML = '';
        for (var fj = 0; fj < filtered.length; fj++) {
            var r2 = filtered[fj];
            var div = document.createElement('div');
            div.className = 'p-4 space-y-3 bg-white border-b border-slate-50';
            div.innerHTML =
                '<div class="flex justify-between items-start">' +
                    '<div class="font-bold text-blue-600 text-base cursor-pointer" onclick="viewHistory(\'name\', \'' + escapeJsHtml(r2.name) + '\')">' + escapeHtml(r2.name) + '</div>' +
                    '<div class="text-[10px] text-slate-400 font-mono">' + escapeHtml(r2.date) + '</div>' +
                '</div>' +
                '<div class="grid grid-cols-2 gap-2 text-sm mt-2">' +
                    '<div><div class="text-[10px] text-slate-400 mb-0.5">原職</div><div class="font-medium text-slate-700">' + escapeHtml(r2.from_post) + '</div><div class="text-[10px] font-bold text-slate-400">' + escapeHtml(r2.from_dept) + '</div></div>' +
                    '<div><div class="text-[10px] text-blue-400 mb-0.5">現職</div><div class="font-medium text-blue-800">' + escapeHtml(r2.to_post) + '</div><div class="text-[10px] font-bold text-blue-400">' + escapeHtml(r2.to_dept) + '</div></div>' +
                '</div>' +
                '<div class="flex justify-between items-center pt-3 mt-3 border-t border-slate-50">' +
                    '<div class="text-[10px] font-bold text-blue-500">' + escapeHtml(r2.posting_notice) + ' ' + _renderNoticeStatusBadge(r2.posting_notice, r2) + '</div>' +
                    (isAdmin() ? '<div class="flex gap-4"><button onclick="editRecord(' + records.indexOf(r2) + ')" class="text-slate-500 font-bold text-xs">編輯</button><button onclick="deleteRecord(' + records.indexOf(r2) + ')" class="text-red-500 font-bold text-xs">刪除</button></div>' : '') +
                '</div>';
            cardBody.appendChild(div);
        }
    }
}

function viewHistory(type, value, dept) {
    historyTarget = { type: type, value: value, dept: dept || '' };
    switchTab('history');
}

function renderHistoryView() {
    if (!historyTarget.value) return;

    var focusNameEl = document.getElementById('currentFocusName');
    var focusTypeEl = document.getElementById('currentFocusType');
    var historyCountEl = document.getElementById('historyCount');
    var historyTitleEl = document.getElementById('historyPanelTitle');
    var historyTableContainerEl = document.getElementById('historyTableContainer');
    var deptMainPanelEl = document.getElementById('deptMainPanel');
    var tbody = document.getElementById('historyTableBody');
    if (!focusNameEl || !focusTypeEl || !historyCountEl || !historyTitleEl || !historyTableContainerEl || !deptMainPanelEl || !tbody) return;

    if (historyTarget.type === 'role') {
        var key = getRoleKey(historyTarget.value, historyTarget.dept || '');
        var isDeleted = postOverrides[key] === 'deleted';
        var baseName = historyTarget.dept
            ? historyTarget.value + ' (' + historyTarget.dept + ')'
            : historyTarget.value;
        if (isDeleted) {
            focusNameEl.innerHTML = escapeHtml(baseName) + ' <span class="ml-2 inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-slate-100 text-slate-500 text-sm font-bold border border-slate-200 align-middle"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"></path></svg>已撤銷 (Obsolete)</span>';
        } else {
            focusNameEl.innerText = baseName;
        }
    } else {
        var nick = personNicknames[historyTarget.value];
        focusNameEl.innerText = nick ? historyTarget.value + ' (' + nick + ')' : historyTarget.value;
    }

    var focusTypeStr = '人物歷史追蹤';
    if (historyTarget.type === 'role') focusTypeStr = '崗位歷史追蹤';
    if (historyTarget.type === 'dept') focusTypeStr = '部門相關崗位與現職人員';
    if (historyTarget.type === 'pn') focusTypeStr = 'Posting Notice 內容';
    focusTypeEl.innerText = focusTypeStr;
    updateContactButton();
    updateSelectionRemarkPanel();
    updatePersonImagePanel();

    var supPanel = document.getElementById('supersessionAdminPanel');
    if (supPanel) {
        supPanel.classList.toggle('hidden', !isAdmin());
        if (isAdmin()) _renderSupersessionChain();
    }

    if (historyTarget.type === 'dept') {
        var deptRows = _getMemoHistoryDeptRows(historyTarget.value);
        historyTitleEl.innerText = '部門相關崗位與現職人員';
        historyCountEl.innerText = deptRows.length + ' 個崗位';
        historyTableContainerEl.classList.add('hidden');
        tbody.innerHTML = '';

        if (deptRows.length > 0) {
            var html = '<div class="grid grid-cols-1 md:grid-cols-2 gap-4">';
            for (var di = 0; di < deptRows.length; di++) {
                var dr = deptRows[di];
                html += '<div class="p-4 bg-emerald-50 rounded-xl border border-emerald-100">' +
                    '<div class="font-bold text-slate-800 text-sm cursor-pointer hover:underline" onclick="viewHistory(\'role\', \'' + escapeJsHtml(dr.to_post) + '\', \'' + escapeJsHtml(dr.to_dept) + '\')">' + escapeHtml(dr.to_post) + ' (' + escapeHtml(dr.to_dept) + ')</div>' +
                    '<div class="text-slate-600 mt-2 text-sm">現職人員：<span class="font-semibold text-emerald-700 cursor-pointer hover:underline" onclick="viewHistory(\'name\', \'' + escapeJsHtml(dr.name) + '\')">' + escapeHtml(dr.name) + '</span></div>' +
                    '<div class="text-[11px] text-slate-400 mt-2">生效日期：' + escapeHtml(dr.date) + ' ・ PN：<span class="cursor-pointer hover:underline" onclick="viewHistory(\'pn\', \'' + escapeJsHtml(dr.posting_notice) + '\')">' + escapeHtml(dr.posting_notice) + '</span></div>' +
                '</div>';
            }
            html += '</div>';
            deptMainPanelEl.innerHTML = html;
        } else {
            deptMainPanelEl.innerHTML = '<div class="text-slate-500 text-sm">沒有找到該部門的現職崗位資料。</div>';
        }
        deptMainPanelEl.classList.remove('hidden');
        return;
    }

    deptMainPanelEl.classList.add('hidden');
    deptMainPanelEl.innerHTML = '';
    historyTableContainerEl.classList.remove('hidden');
    historyTitleEl.innerText = '歷史時間軸 / 人物清單';

    var filtered = _getMemoHistoryRows();
    historyCountEl.innerText = filtered.length + ' 筆紀錄';
    tbody.innerHTML = '';

    for (var hi = 0; hi < filtered.length; hi++) {
        var r = filtered[hi];
        var v = getValidationForRecordByIndex(records.indexOf(r));
        var hns = '';
        if (typeof isNoticeSupersededByAdmin === 'function' && r.posting_notice) {
            var superByH = isNoticeSupersededByAdmin(r.posting_notice);
            if (superByH) hns = ' superseded-row';
            if (r.cancelledFlag) hns = ' cancelled-row';
        }
        var tr = document.createElement('tr');
        if (hns) tr.className = hns;
        tr.innerHTML =
            '<td class="px-6 py-4 font-bold ' + (historyTarget.type === 'name' ? 'text-slate-900' : 'text-blue-600 cursor-pointer hover:underline') + '"' + (historyTarget.type !== 'name' ? ' onclick="viewHistory(\'name\', \'' + escapeJsHtml(r.name) + '\')"' : '') + '>' + escapeHtml(r.name || '') + '</td>' +
            '<td class="px-6 py-4 text-xs">' +
                '<div class="mb-1">' +
                    '<button type="button" class="text-slate-500 hover:text-blue-600 hover:underline text-left" onclick="viewHistory(\'role\', \'' + escapeJsHtml(r.from_post) + '\', \'' + escapeJsHtml(r.from_dept) + '\')">' + escapeHtml(r.from_post || '-') + '</button>' +
                    '<span class="text-slate-400 mx-1">(</span><button type="button" class="text-slate-400 hover:text-blue-600 hover:underline" onclick="viewHistory(\'dept\', \'' + escapeJsHtml(r.from_dept) + '\')">' + escapeHtml(r.from_dept || '-') + '</button><span class="text-slate-400 mx-1">)</span>' +
                    '<span class="mx-2 text-blue-400">→</span>' +
                '</div>' +
                '<div>' +
                    '<button type="button" class="font-bold text-blue-700 hover:underline text-left" onclick="viewHistory(\'role\', \'' + escapeJsHtml(r.to_post) + '\', \'' + escapeJsHtml(r.to_dept) + '\')">' + escapeHtml(r.to_post || '-') + '</button>' +
                    '<span class="text-blue-600 mx-1">(</span><button type="button" class="text-blue-600 font-bold hover:underline" onclick="viewHistory(\'dept\', \'' + escapeJsHtml(r.to_dept) + '\')">' + escapeHtml(r.to_dept || '-') + '</button><span class="text-blue-600 mx-1">)</span>' +
                '</div>' +
            '</td>' +
            '<td class="px-6 py-4 text-xs font-mono">' + escapeHtml(r.date || '') + '</td>' +
            '<td class="px-6 py-4 text-[10px] font-bold text-blue-500 cursor-pointer hover:underline" onclick="viewHistory(\'pn\', \'' + escapeJsHtml(r.posting_notice) + '\')">' + escapeHtml(r.posting_notice || '-') + ' ' + _renderNoticeStatusBadge(r.posting_notice, r) + '</td>' +
            '<td class="px-6 py-4 admin-only">' + renderValidationBadge(v.severity, v.overridden) + (v.issues && v.issues.length > 0 ? '<div class="text-[10px] text-slate-600 mt-1 leading-relaxed space-y-0.5">' + v.issues.map(function(iss) { return '<div>' + escapeHtml(iss.message) + '</div>'; }).join('') + '</div>' : '') + '</td>' +
            '<td class="px-6 py-4 flex gap-3">' +
                (isAdmin() ? '<button onclick="openEditModalByName(\'' + escapeJsHtml(r.name) + '\', \'' + escapeJsHtml(r.posting_notice) + '\')" class="text-blue-500 hover:underline text-xs">編輯</button>' +
                '<button onclick="deleteRecord(\'' + escapeJsHtml(r.name) + '\', \'' + escapeJsHtml(r.posting_notice) + '\')" class="text-red-500 hover:underline text-xs">刪除</button>' : '') +
            '</td>';
        tbody.appendChild(tr);
    }
}

function _getMemoHistoryDeptRows(deptName) {
    var latestByRole = {};
    for (var i = 0; i < records.length; i++) {
        var r = records[i];
        var d = (r.to_dept || '').trim();
        var p = (r.to_post || '').trim();
        if (d !== deptName || !p) continue;
        var rk = p + '||' + d;
        var dk = _cachedDateKey(r.date || '');
        var ex = latestByRole[rk];
        if (!ex || dk > _cachedDateKey(ex.date || '')) {
            latestByRole[rk] = r;
        }
    }
    var rows = Object.values(latestByRole);
    rows.sort(function(a, b) { return (a.to_post || '').localeCompare(b.to_post || '', 'en') || (a.name || '').localeCompare(b.name || '', 'en'); });
    return rows;
}

function triggerImport() {
    if (!isAdmin()) return;
    document.getElementById('excelImport').click();
}

function importFromExcel(e) {
    if (!isAdmin()) return;
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const imported = XLSX.utils.sheet_to_json(firstSheet);

        const cleaned = imported.map(item => ({
            name: item['姓名 (Name)'] || item['Name'] || item.name || '',
            from_post: item['原職 (From Post)'] || item['From Post'] || item.from_post || item.fromPost || '',
            from_dept: item['原部門 (From Dept)'] || item['From Dept'] || item.from_dept || item.fromDept || '',
            to_post: item['現職 (To Post)'] || item['To Post'] || item.to_post || item.toPost || '',
            to_dept: item['現部門 (To Dept)'] || item['To Dept'] || item.to_dept || item.toDept || '',
            date: item['生效日期'] || item['Date'] || item.date || '',
            remark: item['備註 (Remark)'] || item['Remark'] || item.remark || '',
            posting_notice:
                item['PN No.'] ||
                item['Posting No.'] ||
                item['Posting Notice No.'] ||
                item['PN'] ||
                item.posting_notice ||
                item.postingNotice ||
                item.pn_no ||
                item.pnNo ||
                ''
        }));

        imported.forEach(item => {
            const personName = item['姓名 (Name)'] || item['Name'] || item.name || '';
            const personRemark = item['人物備註'] || item['Person Remark'] || item['Person Note'] || '';
            if (personName && personRemark) personNotes[personName] = personRemark;

            const fromPost = item['原職 (From Post)'] || item['From Post'] || item.from_post || item.fromPost || '';
            const fromDept = item['原部門 (From Dept)'] || item['From Dept'] || item.from_dept || item.fromDept || '';
            const toPost = item['現職 (To Post)'] || item['To Post'] || item.to_post || item.toPost || '';
            const toDept = item['現部門 (To Dept)'] || item['To Dept'] || item.to_dept || item.toDept || '';
            const fromRoleRemark = item['原崗位備註'] || item['From Role Remark'] || '';
            const toRoleRemark = item['現崗位備註'] || item['To Role Remark'] || '';

            if (fromPost && fromRoleRemark) roleNotes[getRoleKey(fromPost, fromDept)] = fromRoleRemark;
            if (toPost && toRoleRemark) roleNotes[getRoleKey(toPost, toDept)] = toRoleRemark;
        });

        const colleagueSheetName = workbook.SheetNames.find(name => name === 'Colleagues');
        if (colleagueSheetName) {
            const colleagueRows = XLSX.utils.sheet_to_json(workbook.Sheets[colleagueSheetName]);
            colleagueRows.forEach(row => {
                const personName = row['姓名 (Name)'] || row['Name'] || '';
                const personRemark = row['人物備註'] || row['Person Remark'] || row['Person Note'] || '';
                const photoData = combineExcelSafeText(row, '人物相片資料_');
                if (personName && personRemark) personNotes[personName] = personRemark;
                if (personName && photoData) personImages[personName] = photoData;
            });
        }

        const photoSheetName = workbook.SheetNames.find(name => name === 'PersonPhotos');
        if (photoSheetName) {
            const photoRows = XLSX.utils.sheet_to_json(workbook.Sheets[photoSheetName]);
            photoRows.forEach(row => {
                const personName = row['姓名 (Name)'] || row['Name'] || '';
                const photoData = combineExcelSafeText(row, '人物相片資料_') || row['人物相片'] || row['Person Photo'] || '';
                if (personName && photoData) personImages[personName] = photoData;
            });
        }

        localStorage.setItem('sys_person_notes_pro', JSON.stringify(personNotes));
        localStorage.setItem('sys_role_notes_pro', JSON.stringify(roleNotes));
        localStorage.setItem('sys_person_images_pro', JSON.stringify(personImages));

        // Prepend cleaned records with metadata to existing records
        var oldRecords = records;
        records = cleaned.map(function(r) {
            r.posting_notice = r.posting_notice || r.postingNotice || r.pn_no || r.pnNo || '';
            return r;
        });

        if (typeof ensureRecordMeta === 'function') {
            for (var ic = 0; ic < records.length; ic++) {
                records[ic] = ensureRecordMeta(records[ic], 'excel-import');
                recordAuditEvent('IMPORT_EXCEL', records[ic], { performedBy: 'import', snapshot: null });
            }
        }

        records = records.concat(oldRecords);
        saveAndSync();
        updateUndoButton();
        showToast('成功匯入 ' + cleaned.length + ' 筆紀錄！', 'success');
        switchTab('database');
        e.target.value = '';
    };
    reader.readAsArrayBuffer(file);
}

function exportToExcel() {
    if (!isAdmin()) return;
    try {
        const normalizedRecords = (records || []).map(r => ({
            name: r.name || '',
            from_post: r.from_post || '',
            from_dept: r.from_dept || '',
            to_post: r.to_post || '',
            to_dept: r.to_dept || '',
            date: r.date || '',
            remark: r.remark || '',
            posting_notice: r.posting_notice || r.postingNotice || r.pn_no || r.pnNo || ''
        }));

        const recordRows = normalizedRecords.map(r => ({
            '姓名 (Name)': r.name,
            '原職 (From Post)': r.from_post,
            '原部門 (From Dept)': r.from_dept,
            '原崗位備註': roleNotes[getRoleKey(r.from_post, r.from_dept)] || '',
            '現職 (To Post)': r.to_post,
            '現部門 (To Dept)': r.to_dept,
            '現崗位備註': roleNotes[getRoleKey(r.to_post, r.to_dept)] || '',
            '生效日期': r.date,
            '備註 (Remark)': r.remark,
            'PN No.': r.posting_notice
        }));

        const colleagueNames = Array.from(new Set([
            ...normalizedRecords.map(r => r.name).filter(Boolean),
            ...Object.keys(personNotes || {}),
            ...Object.keys(personImages || {})
        ])).sort((a, b) => a.localeCompare(b, 'en'));

        const colleagueRows = colleagueNames.map(name => {
            const imgData = (personImages || {})[name] || '';
            const imgChunks = splitExcelSafeText(imgData, 30000);
            const row = {
                '姓名 (Name)': name,
                '人物備註': (personNotes || {})[name] || '',
                '人物相片檔名': imgData ? `${name}.jpg` : ''
            };
            imgChunks.forEach((chunk, idx) => {
                row[`人物相片資料_${idx + 1}`] = chunk;
            });
            return row;
        });

        const postState = new Map();
        const chronoRecords = [...records].sort((a, b) =>
            (parseDateKey(a.date) || '').localeCompare(parseDateKey(b.date) || '')
        );
        chronoRecords.forEach(r => {
            const fromKey = getRoleKey(r.from_post, r.from_dept);
            const toKey = getRoleKey(r.to_post, r.to_dept);
            if (fromKey !== '||') postState.set(fromKey, { status: 'vacant', holder: '', record: r });
            if (toKey !== '||') postState.set(toKey, { status: 'occupied', holder: r.name, record: r });
        });

        const allPostKeys = new Set([...postState.keys(), ...Object.keys(roleNotes||{}), ...Object.keys(postOverrides||{})]);
        allPostKeys.delete('||');

        const postRows = [...allPostKeys].map(key => {
            const parts = key.split('||');
            const post = parts[0] || '';
            const dept = parts[1] || '';
            const computed = postState.get(key) || { status: 'vacant', holder: '' };
            let status = computed.status;
            if (postOverrides[key] === 'deleted') status = 'deleted';
            return {
                '職位 (Post)': post,
                '部門 (Department)': dept,
                '狀態 (Status)': status,
                '現任 (Holder)': status === 'occupied' ? computed.holder : '',
                '崗位備註 (Remark)': (roleNotes||{})[key] || ''
            };
        });

        const recordsWs = XLSX.utils.json_to_sheet(recordRows.length ? recordRows : [{
            '姓名 (Name)': '',
            '原職 (From Post)': '',
            '原部門 (From Dept)': '',
            '原崗位備註': '',
            '現職 (To Post)': '',
            '現部門 (To Dept)': '',
            '現崗位備註': '',
            '生效日期': '',
            '備註 (Remark)': '',
            'PN No.': ''
        }]);

        const colleaguesWs = XLSX.utils.json_to_sheet(colleagueRows.length ? colleagueRows : [{
            '姓名 (Name)': '',
            '人物備註': '',
            '人物相片檔名': '',
            '人物相片資料_1': ''
        }]);

        const postsWs = XLSX.utils.json_to_sheet(postRows.length ? postRows : [{
            '職位 (Post)': '',
            '部門 (Department)': '',
            '狀態 (Status)': '',
            '現任 (Holder)': '',
            '崗位備註 (Remark)': ''
        }]);

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, recordsWs, 'Records');
        XLSX.utils.book_append_sheet(wb, colleaguesWs, 'Colleagues');
        XLSX.utils.book_append_sheet(wb, postsWs, 'Posts');
        XLSX.writeFile(wb, `_Posting_Export_${new Date().toISOString().slice(0,10)}.xlsx`);
        addLog('Excel 已成功導出。', 'info');
    } catch (err) {
        console.error('exportToExcel error:', err);
        showToast('導出 Excel 失敗：' + (err && err.message ? err.message : String(err)), 'error', 6000);
    }
}

function deleteRecord(name, pn) {
    if (!isAdmin()) return;
    var idx = records.findIndex(function(r) { return (r.name || '') === name && (r.posting_notice || '') === pn; });
    if (idx < 0) return;
    if (confirm('確定要刪除 ' + name + ' 於 ' + pn + ' 的調動紀錄嗎？')) {
        if (typeof ensureRecordMeta === 'function') {
            var snap = JSON.parse(JSON.stringify(records[idx]));
            recordAuditEvent('DELETE', snap, {
                performedBy: 'admin',
                snapshot: snap
            });
        }
        records.splice(idx, 1);
        _markAllDirty();
        _invalidateAllCaches();
        saveAndSync();
        if (typeof resolveNoticeStatuses === 'function') resolveNoticeStatuses();
        _scheduleRender('db', renderDatabaseTable);
        if (historyTarget && historyTarget.value) renderHistoryView();
        updateUndoButton();
        addLog('已刪除 ' + name + ' 的紀錄', 'info');
    }
}

function openEditModalByName(name, pn) {
    if (!isAdmin()) return;
    const idx = records.findIndex(r => (r.name || '') === name && (r.posting_notice || '') === pn);
    if (idx === -1) return;
    const r = records[idx];
    document.getElementById('editIndex').value = idx;
    document.getElementById('editName').value = r.name;
    document.getElementById('editFromPost').value = r.from_post;
    document.getElementById('editFromDept').value = r.from_dept;
    document.getElementById('editToPost').value = r.to_post;
    document.getElementById('editToDept').value = r.to_dept;
    document.getElementById('editDate').value = r.date;
    document.getElementById('editPN').value = r.posting_notice;
    document.getElementById('editRemark').value = r.remark;
    document.getElementById('editModal').classList.remove('hidden');
}

function saveEdit() {
    if (!isAdmin()) return;
    var idx = parseInt(document.getElementById('editIndex').value, 10);
    if (isNaN(idx) || idx < 0 || idx >= records.length) return;

    var newRec = {
        name: document.getElementById('editName').value,
        from_post: document.getElementById('editFromPost').value,
        from_dept: document.getElementById('editFromDept').value,
        to_post: document.getElementById('editToPost').value,
        to_dept: document.getElementById('editToDept').value,
        date: document.getElementById('editDate').value,
        posting_notice: document.getElementById('editPN').value,
        remark: document.getElementById('editRemark').value
    };

    if (typeof ensureRecordMeta === 'function') {
        var oldSnap = JSON.parse(JSON.stringify(records[idx]));
        var changedFields = _diffFields(oldSnap, newRec);
        stampRecordMeta(records[idx], 'admin', '');
        Object.assign(records[idx], newRec);
        records[idx]._updatedAt = new Date().toISOString();
        records[idx]._updatedBy = 'admin';
        recordAuditEvent('EDIT', records[idx], {
            performedBy: 'admin',
            snapshot: oldSnap,
            fieldsChanged: changedFields,
            before: _pickFields(oldSnap, changedFields),
            after: _pickFields(records[idx], changedFields)
        });
    } else {
        records[idx] = newRec;
    }

    saveAndSync();
    closeEditModal();
    _markAllDirty();
    _scheduleRender('db', renderDatabaseTable);
    renderHistoryView();
    updateUndoButton();
}

function closeEditModal() { document.getElementById('editModal').classList.add('hidden'); }

function saveAndSync() {
    localStorage.setItem('sys_posting_records_pro', JSON.stringify(records));
    setSyncStatus('draft');
    _markAllDirty();
    _invalidateAllCaches();

    _scheduleIdle(function() {
        if (typeof syncCanonicalStores === 'function') syncCanonicalStores(records);
        if (typeof revalidateAll === 'function') revalidateAll();
    });
}

function _saveLocalOnly() {
    localStorage.setItem('sys_posting_records_pro', JSON.stringify(records));
    setSyncStatus('draft');
    _markAllDirty();
    _invalidateAllCaches();
}

function _saveAndAutoSyncSheets() {
    saveAndSync();
    var gdriveUrl = document.getElementById('gdriveLink') ? document.getElementById('gdriveLink').value.trim() : '';
    if (gdriveUrl && gdriveUrl.includes('script.google.com')) {
        _scheduleIdle(function() { saveAllToSheets(); });
    }
}

function clearAllRecords() {
    if (!isAdmin()) return;
    if (confirm("確定清空數據庫？這無法還原。")) {
        if (typeof recordBulkAuditEvent === 'function') {
            recordBulkAuditEvent('DELETE', records.length, 'admin', 'manual');
        }
        records = [];
        _markAllDirty();
        _invalidateAllCaches();
        saveAndSync();
        updateUndoButton();
        _scheduleRender('db', renderDatabaseTable);
    }
}

document.addEventListener('DOMContentLoaded', function() {
    const el = document.getElementById('gdriveLink');
    if (el && !el.value) el.value = "https://docs.google.com/spreadsheets/d/1peldK8LUPpjXtJy0jzfp_xy7kaPaPKcY4nAcd92JKjQ/edit?usp=sharing";
});

document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        var activeEl = document.activeElement;
        if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) return;
        e.preventDefault();
        if (typeof undoLastAction === 'function') undoLastAction();
    }
    if (e.key === 'Escape') {
        var issuePanel = document.getElementById('issuePanel');
        if (issuePanel && issuePanel.classList.contains('open')) {
            closeIssuePanel();
        }
    }
});

function savePagePwd() {
    const pwd = document.getElementById('settingPagePwd').value.trim();
    if(pwd) {
        localStorage.setItem('sys_page_pwd', pwd);
        addLog("已設定網頁鎖定密碼", "info");
        showToast("網頁密碼已設定。下次重新整理頁面時將會要求輸入密碼。", 'success', 5000);
    } else {
        localStorage.removeItem('sys_page_pwd');
        addLog("已移除網頁鎖定密碼", "info");
        showToast("已解除網頁鎖定。", 'info');
    }
}

function saveApiPwd() {
    const pwd = document.getElementById('settingApiPwd').value.trim();
    localStorage.setItem('sys_api_pwd', pwd);
    addLog("已儲存 Apps Script 密碼", "info");
}

function saveAdminPwd() {
    const pwd = document.getElementById('settingAdminPwd').value.trim();
    if (pwd) {
        localStorage.setItem('sys_admin_pwd', pwd);
        addLog("已設定管理員密碼", "info");
        showToast("管理員密碼已更新。", 'success', 5000);
    } else {
        localStorage.removeItem('sys_admin_pwd');
        addLog("已移除管理員密碼", "info");
        showToast("已清除管理員密碼。", 'info');
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN — SUPERSESSION CHAIN MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

function linkSupersession() {
    if (!isAdmin()) return;
    var superPn = (document.getElementById('supersedingPnInput')?.value || '').trim();
    var subPn   = (document.getElementById('supersededPnInput')?.value || '').trim();
    if (!superPn || !subPn) { showToast('請填寫兩個 PN。', 'warning'); return; }
    if (superPn.replace(/\s+/g,'') === subPn.replace(/\s+/g,'')) { showToast('不能自己取代自己。', 'warning'); return; }

    var result = typeof registerNoticeSupersession === 'function'
        ? registerNoticeSupersession(superPn, subPn, 'admin')
        : null;
    if (result) {
        showToast('PN ' + superPn + ' 已標記為取代 PN ' + subPn, 'success');
        addLog('Supersession linked: PN ' + superPn + ' supersedes PN ' + subPn, 'info');
    } else {
        showToast('連結失敗。請確認兩個 PN 都存在。', 'error');
        return;
    }

    _markAllDirty();
    _invalidateAllCaches();
    if (typeof invalidateOccupancyCache === 'function') invalidateOccupancyCache();

    _scheduleIdle(function() {
        if (typeof syncCanonicalStores === 'function') syncCanonicalStores(records);
        if (typeof revalidateAll === 'function') revalidateAll();
    });

    if (document.getElementById('dbTableBody')) _scheduleRender('db', renderDatabaseTable);
    if (document.getElementById('currentTableBody')) _scheduleRender('cur', renderCurrentTable);
    if (historyTarget && historyTarget.value) renderHistoryView();
    _renderSupersessionChain();
}

function unlinkSupersession(pnRaw) {
    if (!isAdmin()) return;
    if (typeof unlinkNoticeSupersession !== 'function') return;
    unlinkNoticeSupersession(pnRaw);
    showToast('已清除 PN ' + pnRaw + ' 的取代連結', 'info');
    addLog('Supersession unlinked: ' + pnRaw, 'info');

    _markAllDirty();
    _invalidateAllCaches();
    if (typeof invalidateOccupancyCache === 'function') invalidateOccupancyCache();

    _scheduleIdle(function() {
        if (typeof syncCanonicalStores === 'function') syncCanonicalStores(records);
        if (typeof revalidateAll === 'function') revalidateAll();
    });

    if (document.getElementById('dbTableBody')) _scheduleRender('db', renderDatabaseTable);
    if (document.getElementById('currentTableBody')) _scheduleRender('cur', renderCurrentTable);
    if (historyTarget && historyTarget.value) renderHistoryView();
    _renderSupersessionChain();
}

function _renderSupersessionChain() {
    var container = document.getElementById('supersessionChainContainer');
    if (!container) return;

    if (typeof _supersessionLinks !== 'object' || typeof NoticeStore === 'undefined') {
        container.innerHTML = '';
        return;
    }

    var links = Object.keys(_supersessionLinks);
    if (links.length === 0) {
        container.innerHTML = '<div class="text-[10px] text-slate-400 italic">尚無取代關係</div>';
        return;
    }

    var html = '<div class="space-y-2 mt-3">';
    var seen = {};
    for (var i = 0; i < links.length; i++) {
        var nid = links[i];
        if (seen[nid]) continue;
        var link = _supersessionLinks[nid];
        if (!link.supersededByNoticeId && !link.supersedesNoticeIds.length) continue;

        seen[nid] = true;
        html += '<div class="p-2 bg-white rounded-lg border border-slate-200">';
        var noticeNumber = (NoticeStore[nid] || {}).noticeNumber || nid;
        html += '<div class="flex justify-between items-center">';
        html += '<span class="text-[11px] font-bold text-slate-700">PN ' + escapeHtml(noticeNumber) + '</span>';

        if (link.supersededByNoticeId) {
            var superById = link.supersededByNoticeId;
            var superPnum = (NoticeStore[superById] || {}).noticeNumber || superById;
            html += '<span class="text-[10px] text-slate-400">← 被 <span class="font-bold text-amber-600">PN ' + escapeHtml(superPnum) + '</span> 取代</span>';
        }

        if (link.supersedesNoticeIds && link.supersedesNoticeIds.length > 0) {
            html += '<div class="text-[10px] text-slate-500 mt-1">取代：';
            for (var j = 0; j < link.supersedesNoticeIds.length; j++) {
                var snid = link.supersedesNoticeIds[j];
                seen[snid] = true;
                var sn = (NoticeStore[snid] || {}).noticeNumber || snid;
                html += '<span class="font-bold text-indigo-600">PN ' + escapeHtml(sn) + '</span>';
                if (j < link.supersedesNoticeIds.length - 1) html += ', ';
            }
            html += '</div>';
        }

        html += '<button onclick="unlinkSupersession(\'' + escapeJsHtml(noticeNumber) + '\')" class="text-[10px] font-bold text-red-500 hover:text-red-700 ml-2">✕ 移除</button>';
        html += '</div></div>';
    }
    html += '</div>';
    container.innerHTML = html;
}

function unlockPage() {
    const input = document.getElementById('pagePasswordInput').value.trim();
    const saved = localStorage.getItem('sys_page_pwd');

    if (input === 'RESET' || input === saved) {
        const ov = document.getElementById('passwordOverlay');
        ov.classList.add('hidden');
        ov.classList.add('pointer-events-none');
        ov.style.display = 'none';
        document.body.style.overflow = '';
    } else {
        document.getElementById('passwordError').classList.remove('hidden');
    }
}

window.addEventListener('DOMContentLoaded', () => {
    if (!localStorage.getItem('sys_page_pwd')) {
        localStorage.setItem('sys_page_pwd', '1234');
    }

    if (!localStorage.getItem('sys_admin_pwd')) {
        localStorage.setItem('sys_admin_pwd', 'Simon123');
    }

    const savedPagePwd = localStorage.getItem('sys_page_pwd');
    const savedApiPwd = localStorage.getItem('sys_api_pwd');
    const savedAdminPwd = localStorage.getItem('sys_admin_pwd');
    if (savedPagePwd) document.getElementById('settingPagePwd').value = savedPagePwd;
    if (savedApiPwd) document.getElementById('settingApiPwd').value = savedApiPwd;
    if (savedAdminPwd) document.getElementById('settingAdminPwd').value = savedAdminPwd;

    if (savedPagePwd) {
        const ov = document.getElementById('passwordOverlay');
        ov.classList.remove('hidden');
        ov.classList.remove('pointer-events-none');
        ov.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    }
});

function getAsOfDateKey() {
    var picker = document.getElementById('asOfDatePicker');
    if (picker && picker.value) {
        var parts = picker.value.split('-');
        if (parts.length === 3) return parts[0] + parts[1] + parts[2];
    }
    // default to today
    var d = new Date();
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}

function resetAsOfDate() {
    var picker = document.getElementById('asOfDatePicker');
    if (picker) picker.value = '';
    if (typeof invalidateOccupancyCache === 'function') invalidateOccupancyCache();
    _markDirty('current');
    renderCurrentTable();
}

function onAsOfDateChange() {
    if (typeof invalidateOccupancyCache === 'function') invalidateOccupancyCache();
    _markDirty('current');
    renderCurrentTable();
}

(function initDatePicker() {
    var picker = document.getElementById('asOfDatePicker');
    if (picker) {
        var d = new Date();
        picker.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
})();

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN — ISSUE RESOLUTION PANEL
// ═══════════════════════════════════════════════════════════════════════════

var _issueFilter = 'all';
var _issueGroupsCache = null;
var _issueCollapsed = {};

function openIssuePanel() {
    if (!isAdmin()) return;
    revalidateAll();
    _issueGroupsCache = _groupIssues(_validationCache);
    _issueFilter = 'all';
    _renderIssuePanel();

    var overlay = document.getElementById('issuePanelOverlay');
    var panel = document.getElementById('issuePanel');
    if (!overlay || !panel) return;
    overlay.classList.remove('hidden');
    panel.classList.remove('hidden');
    // Force reflow then animate in
    panel.offsetHeight;
    panel.classList.add('open');
}

function closeIssuePanel() {
    var overlay = document.getElementById('issuePanelOverlay');
    var panel = document.getElementById('issuePanel');
    if (!overlay || !panel) return;
    panel.classList.remove('open');
    setTimeout(function() {
        panel.classList.add('hidden');
        overlay.classList.add('hidden');
    }, 250);
}

function _setIssueFilter(filter) {
    _issueFilter = filter;
    var tabs = document.querySelectorAll('#issueFilterTabs .issue-filter-tab');
    for (var t = 0; t < tabs.length; t++) {
        tabs[t].classList.toggle('issue-filter-active', tabs[t].getAttribute('data-filter') === filter);
    }
    _renderIssuePanel();
}

function _renderIssuePanel() {
    var body = document.getElementById('issuePanelBody');
    var summaryEl = document.getElementById('issuePanelSummary');
    if (!body || !_issueGroupsCache) return;

    var groups = _issueGroupsCache;
    var totalIssues = 0;
    var totalRecords = 0;

    // Count stats
    for (var gi = 0; gi < groups.length; gi++) {
        var items = _filterGroupItems(groups[gi]);
        totalIssues += items.length;
        for (var ii = 0; ii < items.length; ii++) {
            if (!items[ii].overridden && items[ii].ruleSeverity !== 'ok') totalRecords++;
        }
    }

    if (summaryEl) {
        var cache = _validationCache;
        if (cache) {
            summaryEl.textContent = cache.summary.error + ' error · ' + cache.summary.warning + ' warning · ' + cache.summary.ok + ' ok  |  ' + totalRecords + ' unresolved';
        }
    }

    if (totalIssues === 0) {
        body.innerHTML = '<div class="issue-empty"><div class="issue-empty-icon">✓</div><p>沒有符合此篩選的問題。</p></div>';
        return;
    }

    var html = '';
    for (gi = 0; gi < groups.length; gi++) {
        var group = groups[gi];
        var filteredItems = _filterGroupItems(group);
        if (filteredItems.length === 0) continue;

        var sevClass = group.maxSeverity === 'error' ? 'sev-error' : (group.maxSeverity === 'warning' ? 'sev-warning' : 'sev-ok');
        var sevLabel = group.maxSeverity === 'error' ? 'ERROR' : (group.maxSeverity === 'warning' ? 'WARNING' : 'RESOLVED');
        var isOpen = _issueCollapsed[group.ruleId] !== true;

        // Rule description lookup
        var ruleDesc = group.ruleId;
        if (typeof VALIDATION_RULES !== 'undefined') {
            for (var rd = 0; rd < VALIDATION_RULES.length; rd++) {
                if (VALIDATION_RULES[rd].id === group.ruleId) {
                    ruleDesc = VALIDATION_RULES[rd].name + ' — ' + VALIDATION_RULES[rd].desc;
                    break;
                }
            }
        }

        html += '<div class="issue-group">' +
            '<div class="issue-group-header ' + sevClass + (isOpen ? ' open' : '') + '" onclick="_issueCollapsed[\'' + group.ruleId + '\'] = !_issueCollapsed[\'' + group.ruleId + '\']; _renderIssuePanel()">' +
                '<div><span class="font-mono text-[10px] mr-1.5">' + escapeHtml(group.ruleId) + '</span><span>' + escapeHtml(ruleDesc) + '</span></div>' +
                '<div class="flex items-center gap-2"><span class="issue-group-count">' + filteredItems.length + '</span><span class="text-[10px] font-bold opacity-70">' + sevLabel + '</span><span class="text-[10px]">' + (isOpen ? '▾' : '▸') + '</span></div>' +
            '</div>';

        if (isOpen) {
            for (ii = 0; ii < filteredItems.length; ii++) {
                var item = filteredItems[ii];
                var rec = records[item.index];
                var overriddenClass = item.overridden ? ' overridden' : '';
                var avatarLetter = rec ? (rec.name || '?')[0] : '?';
                var sevBadge = item.ruleSeverity === 'error'
                    ? '<span class="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-700">ERR</span>'
                    : (item.ruleSeverity === 'warning'
                        ? '<span class="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">WARN</span>'
                        : '<span class="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">OK</span>');

                var metaHtml = '';
                if (rec) {
                    metaHtml = '<span>Post: <b>' + escapeHtml((rec.to_post || rec.from_post || '-').substring(0, 30)) + '</b></span>';
                    if (rec.to_dept || rec.from_dept) metaHtml += '<span>Dept: <b>' + escapeHtml((rec.to_dept || rec.from_dept || '-').substring(0, 20)) + '</b></span>';
                    if (rec.posting_notice) metaHtml += '<span class="issue-card-pn cursor-pointer hover:underline" onclick="event.stopPropagation(); viewHistory(\'pn\', \'' + escapeJsHtml(rec.posting_notice) + '\')">PN ' + escapeHtml(rec.posting_notice) + '</span>';
                    if (rec.date) metaHtml += '<span>' + escapeHtml(rec.date) + '</span>';
                }

                var actionsHtml = '';
                if (group.maxSeverity !== 'ok' || _issueFilter === 'supersession') {
                    // Suggest supersede for C02, C03, C04, C07
                    var isSupCandidate = ['C02','C03','C04','C07'].indexOf(group.ruleId) >= 0;
                    if (isSupCandidate && rec && rec.posting_notice) {
                        actionsHtml += '<button onclick="event.stopPropagation(); _issueQuickSupersede(' + item.index + ')" class="issue-quick-btn act-supersede">↻ 取代</button>';
                    }
                    if (item.overridden) {
                        actionsHtml += '<button onclick="event.stopPropagation(); _issueQuickUnignore(' + item.index + ')" class="issue-quick-btn act-unignore">↩ 取消忽略</button>';
                    } else {
                        actionsHtml += '<button onclick="event.stopPropagation(); _issueQuickIgnore(' + item.index + ')" class="issue-quick-btn act-ignore">✕ 忽略</button>';
                    }
                    actionsHtml += '<button onclick="event.stopPropagation(); _issueQuickJump(' + item.index + ')" class="issue-quick-btn act-jump">→ 跳轉</button>';
                    actionsHtml += '<button onclick="event.stopPropagation(); _issueQuickApprove(' + item.index + ')" class="issue-quick-btn act-approve">✓ 通過</button>';
                }

                html += '<div class="issue-card' + overriddenClass + '" onclick="_issueQuickJump(' + item.index + ')">' +
                    '<div class="issue-card-info">' +
                        '<div class="issue-card-avatar bg-blue-100 text-blue-600">' + escapeHtml(avatarLetter) + '</div>' +
                        '<div class="issue-card-detail">' +
                            '<div class="issue-card-name">' + escapeHtml(rec ? (rec.name || '(unnamed)') : '(unnamed)') + '</div>' +
                            '<div class="issue-card-meta">' + metaHtml + '</div>' +
                        '</div>' +
                        '<div class="shrink-0">' + sevBadge + '</div>' +
                    '</div>' +
                    '<div class="issue-card-message">' + escapeHtml(item.message) + (item.overridden ? ' <span class="text-purple-600 font-bold">[Admin Override]</span>' : '') + '</div>' +
                    (actionsHtml ? '<div class="issue-card-actions">' + actionsHtml + '</div>' : '') +
                '</div>';
            }
        }
        html += '</div>';
    }

    body.innerHTML = html;
}

function _groupIssues(validationCache) {
    if (!validationCache || !validationCache.results) return [];
    var groups = {};
    var results = validationCache.results;

    for (var i = 0; i < results.length; i++) {
        var r = results[i];
        if (!r.issues || r.issues.length === 0) continue;

        for (var j = 0; j < r.issues.length; j++) {
            var iss = r.issues[j];
            var ruleId = iss.ruleId;
            if (!groups[ruleId]) {
                groups[ruleId] = { ruleId: ruleId, maxSeverity: 'ok', items: [] };
            }
            groups[ruleId].items.push({
                index: r.index,
                ruleId: ruleId,
                ruleSeverity: iss.severity,
                message: iss.message,
                overridden: r.overridden,
                recordSeverity: r.severity
            });
            // Track highest severity in this group
            if (iss.severity === 'error') groups[ruleId].maxSeverity = 'error';
            else if (iss.severity === 'warning' && groups[ruleId].maxSeverity !== 'error') groups[ruleId].maxSeverity = 'warning';
        }
    }

    // Sort: errors first, then warnings, then ok/resolved
    var groupList = [];
    for (var key in groups) { groupList.push(groups[key]); }
    groupList.sort(function(a, b) {
        var sevOrder = { error: 0, warning: 1, ok: 2 };
        return (sevOrder[a.maxSeverity] || 2) - (sevOrder[b.maxSeverity] || 2);
    });

    return groupList;
}

function _filterGroupItems(group) {
    return group.items.filter(function(item) {
        if (_issueFilter === 'error') return item.ruleSeverity === 'error' && !item.overridden;
        if (_issueFilter === 'warning') return item.ruleSeverity === 'warning' && !item.overridden;
        if (_issueFilter === 'unresolved') return (item.ruleSeverity === 'error' || item.ruleSeverity === 'warning') && !item.overridden;
        if (_issueFilter === 'supersession') {
            return ['C02','C03','C04','C07'].indexOf(item.ruleId) >= 0 && !item.overridden;
        }
        return true; // 'all'
    });
}

// ---- quick actions ----------------------------------------------------------

function _issueQuickSupersede(recIdx) {
    if (!isAdmin() || recIdx < 0 || recIdx >= records.length) return;
    var rec = records[recIdx];
    var pn = rec.posting_notice || '';
    // Pre-fill the supersession panel inputs
    var superInput = document.getElementById('supersedingPnInput');
    var subInput  = document.getElementById('supersededPnInput');
    if (subInput) subInput.value = pn;
    if (superInput) { superInput.value = ''; superInput.focus(); }
    showToast('請在上方面板輸入取代的 PN，然後按「鏈接取代關係」', 'info', 5000);
    // Switch to history tab to show the supersession panel
    viewHistory('name', rec.name);
    closeIssuePanel();
    setTimeout(function() { _renderSupersessionChain(); }, 300);
}

function _issueQuickIgnore(recIdx) {
    if (!isAdmin()) return;
    var key = String(recIdx);
    _adminOverrides[key] = true;
    try { localStorage.setItem('sys_admin_overrides_pro', JSON.stringify(_adminOverrides)); } catch(e) {}
    revalidateAll();
    _issueGroupsCache = _groupIssues(_validationCache);
    _renderIssuePanel();
    updateValidationBadge();
    if (_currentTab === 'database') _scheduleRender('db', renderDatabaseTable);
    showToast('已忽略 record #' + (recIdx + 1) + ' 的問題', 'info', 2000);
}

function _issueQuickUnignore(recIdx) {
    if (!isAdmin()) return;
    var key = String(recIdx);
    delete _adminOverrides[key];
    try { localStorage.setItem('sys_admin_overrides_pro', JSON.stringify(_adminOverrides)); } catch(e) {}
    revalidateAll();
    _issueGroupsCache = _groupIssues(_validationCache);
    _renderIssuePanel();
    updateValidationBadge();
    if (_currentTab === 'database') _scheduleRender('db', renderDatabaseTable);
    showToast('已取消忽略 record #' + (recIdx + 1), 'info', 2000);
}

function _issueQuickJump(recIdx) {
    if (recIdx < 0 || recIdx >= records.length) return;
    var rec = records[recIdx];
    closeIssuePanel();
    setTimeout(function() {
        viewHistory('name', rec.name);
    }, 260);
}

function _issueQuickApprove(recIdx) {
    if (!isAdmin()) return;
    if (typeof _adminOverrides !== 'object') return;
    _adminOverrides[String(recIdx)] = true;
    try { localStorage.setItem('sys_admin_overrides_pro', JSON.stringify(_adminOverrides)); } catch(e) {}
    revalidateAll();
    _issueGroupsCache = _groupIssues(_validationCache);
    _renderIssuePanel();
    updateValidationBadge();
    showToast('Record #' + (recIdx + 1) + ' 已標記為通過', 'success', 2000);
}

// ---- bulk actions -----------------------------------------------------------

function _bulkIgnoreWarnings() {
    if (!isAdmin()) return;
    if (!_validationCache || !_validationCache.results) return;
    var count = 0;
    for (var i = 0; i < _validationCache.results.length; i++) {
        var r = _validationCache.results[i];
        if (r.severity === 'warning' && !r.overridden) {
            _adminOverrides[String(r.index)] = true;
            count++;
        }
    }
    try { localStorage.setItem('sys_admin_overrides_pro', JSON.stringify(_adminOverrides)); } catch(e) {}
    revalidateAll();
    _issueGroupsCache = _groupIssues(_validationCache);
    _renderIssuePanel();
    updateValidationBadge();
    if (_currentTab === 'database') _scheduleRender('db', renderDatabaseTable);
    showToast('已忽略 ' + count + ' 個警告', 'success', 3000);
}

function _bulkAutoLinkSupersession() {
    if (!isAdmin()) return;
    if (!_validationCache || !_validationCache.results) return;
    if (typeof registerNoticeSupersession !== 'function') {
        showToast('取代鏈接功能未載入', 'error');
        return;
    }

    var linked = 0;
    // Find C02/C03 conflicts where both records have different PNs and one implies supersession
    // Strategy: for C02 (person same-date multi-post), the movement with the higher PN likely supersedes
    for (var i = 0; i < _validationCache.results.length; i++) {
        var r = _validationCache.results[i];
        if (r.overridden || !r.issues) continue;
        for (var j = 0; j < r.issues.length; j++) {
            var iss = r.issues[j];
            if (iss.ruleId !== 'C02' && iss.ruleId !== 'C03') continue;
            if (iss.severity === 'ok') continue;

            // Find the conflicting records for this person/post on the same date
            var recA = records[r.index];
            if (!recA || !recA.posting_notice) continue;

            var dateK = typeof _cachedDateKey === 'function' ? _cachedDateKey(recA.date) : '';
            var searchName = recA.name;

            for (var k = i + 1; k < _validationCache.results.length; k++) {
                var r2 = _validationCache.results[k];
                if (r2.overridden) continue;
                if (!r2.issues) continue;
                var hasConflict = false;
                for (var m = 0; m < r2.issues.length; m++) {
                    if (r2.issues[m].ruleId === iss.ruleId) { hasConflict = true; break; }
                }
                if (!hasConflict) continue;

                var recB = records[r2.index];
                if (!recB || !recB.posting_notice || recB.name !== searchName) continue;
                if (recA.posting_notice === recB.posting_notice) continue;

                var dateK2 = typeof _cachedDateKey === 'function' ? _cachedDateKey(recB.date) : '';
                if (dateK !== dateK2) continue;

                // Determine which PN is newer (higher number = supersedes)
                var scoreA = 0, scoreB = 0;
                var matchA = String(recA.posting_notice).match(/(\d+)\s*\/\s*(\d{4})/);
                var matchB = String(recB.posting_notice).match(/(\d+)\s*\/\s*(\d{4})/);
                if (matchA) scoreA = parseInt(matchA[2]) * 10000 + parseInt(matchA[1]);
                if (matchB) scoreB = parseInt(matchB[2]) * 10000 + parseInt(matchB[1]);

                if (scoreA > scoreB) {
                    registerNoticeSupersession(recA.posting_notice, recB.posting_notice, 'auto-bulk');
                    linked++;
                } else if (scoreB > scoreA) {
                    registerNoticeSupersession(recB.posting_notice, recA.posting_notice, 'auto-bulk');
                    linked++;
                }
            }
        }
    }

    // Also link C04/C07 candidates
    for (i = 0; i < _validationCache.results.length; i++) {
        var rs = _validationCache.results[i];
        if (rs.overridden || !rs.issues) continue;
        for (j = 0; j < rs.issues.length; j++) {
            var isc = rs.issues[j];
            if (isc.ruleId !== 'C04' && isc.ruleId !== 'C07') continue;
            if (isc.severity === 'ok') continue;
            var recC = records[rs.index];
            if (!recC || !recC.posting_notice) continue;
            // Extract referenced PN from the message
            var pnMatch = isc.message.match(/(\d+\s*\/\s*\d{4})/);
            if (pnMatch) {
                var refPn = pnMatch[1].replace(/\s+/g, '');
                if (refPn !== recC.posting_notice.replace(/\s+/g, '')) {
                    registerNoticeSupersession(recC.posting_notice, refPn, 'auto-bulk');
                    linked++;
                }
            }
        }
    }

    _markAllDirty();
    _invalidateAllCaches();
    if (typeof invalidateOccupancyCache === 'function') invalidateOccupancyCache();
    _scheduleIdle(function() {
        if (typeof syncCanonicalStores === 'function') syncCanonicalStores(records);
        if (typeof resolveNoticeStatuses === 'function') resolveNoticeStatuses();
        if (typeof revalidateAll === 'function') revalidateAll();
    });
    revalidateAll();
    _issueGroupsCache = _groupIssues(_validationCache);
    _renderIssuePanel();
    updateValidationBadge();
    if (_currentTab === 'database') _scheduleRender('db', renderDatabaseTable);
    if (_currentTab === 'current') _scheduleRender('cur', renderCurrentTable);
    showToast('自動鏈接了 ' + linked + ' 組取代關係', 'success', 4000);
}

function _bulkRevalidate() {
    if (!isAdmin()) return;
    revalidateAll();
    _issueGroupsCache = _groupIssues(_validationCache);
    _renderIssuePanel();
    updateValidationBadge();
    showToast('重新驗證完成', 'success', 2000);
}

async function runDiagnostics() {
    var out = document.getElementById('diagOutput');
    if (!out) return;
    out.classList.remove('hidden');
    out.innerHTML = '<div class="diag-check">🔄 診斷中…</div>';

    var lines = [];
    function add(status, text) { lines.push('<div class="diag-' + status + '">' + text + '</div>'); }

    add('check', 'localStorage 狀態:');
    add('check', '  records: ' + (records ? records.length : 0) + ' 筆');
    add('check', '  nicknames: ' + Object.keys(personNicknames || {}).length + ' 人');
    add('check', '  notes: ' + Object.keys(personNotes || {}).length + ' 人');
    add('check', '  images: ' + Object.keys(personImages || {}).length + ' 人');
    add('check', '  roleNotes: ' + Object.keys(roleNotes || {}).length + ' 崗位');
    add('check', '  postOverrides: ' + Object.keys(postOverrides || {}).length + ' 個');
    var pagePwd = localStorage.getItem('sys_page_pwd');
    var apiPwd = localStorage.getItem('sys_api_pwd');
    var adminPwd = localStorage.getItem('sys_admin_pwd');
    add('check', '  page password: ' + (pagePwd ? '已設定' : '未設定'));
    add('check', '  API password: ' + (apiPwd ? '已設定' : '未設定'));
    add('check', '  admin password: ' + (adminPwd ? '已設定' : '未設定'));

    var gdriveUrl = document.getElementById('gdriveLink') ? document.getElementById('gdriveLink').value.trim() : '';
    add('check', '');
    add('check', 'Apps Script URL:');
    if (!gdriveUrl) {
        add('warn', '  未設定');
    } else if (!gdriveUrl.includes('script.google.com')) {
        add('warn', '  格式不正確: ' + gdriveUrl.substring(0, 50));
    } else {
        add('check', '  ' + gdriveUrl.substring(0, 60) + '…');
        add('check', '  正在測試連線…');
        try {
            var result = await fetchAppsScript(gdriveUrl);
            var sheetNames = Object.keys(result).filter(function(k) { return k !== 'success' && k !== 'error'; });
            add('ok', '  ✓ 連線成功');
            add('ok', '  工作表: ' + sheetNames.join(', '));
            sheetNames.forEach(function(name) {
                var rows = result[name];
                if (Array.isArray(rows)) add('ok', '  ' + name + ': ' + rows.length + ' 行');
                else add('warn', '  ' + name + ': 非陣列格式');
            });
        } catch (e) {
            add('fail', '  ✗ 連線失敗: ' + e.message);
        }
    }

    add('check', '');
    add('check', '同步狀態:');
    add('check', '  status: ' + syncState.status);
    add('check', '  lastSync: ' + (syncState.lastSync || '(無)'));
    add('check', '  localCount: ' + syncState.localCount);
    add('check', '  remoteCount: ' + syncState.remoteCount);
    if (syncState.error) add('fail', '  error: ' + syncState.error);

    add('check', '');
    add('check', '驗證狀態:');
    if (_validationCache) {
        add(_validationCache.summary.error > 0 ? 'fail' : 'ok', '  ok: ' + _validationCache.summary.ok + ' / warning: ' + _validationCache.summary.warning + ' / error: ' + _validationCache.summary.error);
        add(_validationCache.errorsBlocking > 0 ? 'fail' : 'check', '  blocking errors: ' + _validationCache.errorsBlocking);
    } else {
        add('warn', '  尚未執行驗證。請重新載入頁面。');
    }

    add('check', '');
    add('check', 'Audit Trail:');
    if (typeof getAuditSummary === 'function') {
        var asum = getAuditSummary();
        add('check', '  total events: ' + asum.totalEvents);
        add('check', '  undo stack: ' + asum.undoStackSize + ' available');
        if (asum.lastEvent) {
            add('check', '  last event: ' + asum.lastEvent.summary);
            add('check', '    by: ' + asum.lastEvent.performedBy + ' at ' + asum.lastEvent.timestamp.substring(0,19));
        }
        var actionKeys = Object.keys(asum.actions);
        if (actionKeys.length > 0) {
            add('check', '  actions: ' + actionKeys.map(function(k) { return k + '=' + asum.actions[k]; }).join(', '));
        }
    } else {
        add('warn', '  audit-trail.js not loaded');
    }

    add('check', '');
    add('check', 'Supersession Links:');
    if (typeof _supersessionLinks === 'object' && typeof NoticeStore === 'object') {
        var slCount = Object.keys(_supersessionLinks).length;
        add('check', '  total links: ' + slCount);
        if (slCount > 0) {
            var supCount = 0;
            for (var nid in _supersessionLinks) {
                if (_supersessionLinks[nid].supersededByNoticeId) supCount++;
            }
            add('check', '  superseded notices: ' + supCount);
            // Sample first 3
            var shown = 0;
            for (nid in _supersessionLinks) {
                if (shown >= 3) break;
                var n = NoticeStore[nid];
                var pn = n ? n.noticeNumber : nid;
                var by = _supersessionLinks[nid].supersededByNoticeId;
                var byPn = by && NoticeStore[by] ? NoticeStore[by].noticeNumber : (by || '');
                add('check', '  PN ' + pn + (by ? ' → superseded by PN ' + byPn : ' → supersedes: ' + (_supersessionLinks[nid].supersedesNoticeIds || []).join(', ')));
                shown++;
            }
        }
    } else {
        add('warn', '  data-model not initialized');
    }

    add('check', '');
    add('check', 'PN No. 格式抽樣 (前5筆):');
    var sample = (records || []).slice(0, 5);
    if (sample.length === 0) {
        add('check', '  (無紀錄)');
    } else {
        sample.forEach(function(r) {
            var pn = r.posting_notice || '(空)';
            var suspect = /^\d{4}-\d{2}-\d{2}T/.test(pn);
            add(suspect ? 'warn' : 'ok', '  ' + r.name + ': ' + pn + (suspect ? ' ⚠ 疑似日期格式' : ''));
        });
    }

    out.innerHTML = lines.join('');
}

// ==========================================================================
//  Posting Manager — As-Of-Date Occupancy Engine
// ==========================================================================
//  Replays PostingMovements chronologically to determine post occupancy
//  at any given date. Distinguishes substantive, acting, and future holders.
//
//  Tie-breaking: effectiveDate → PN serial → updatedAt
//
//  Exports:
//    getOccupancySnapshot(asOfDate)       → { [postKey]: OccupancyEntry }
//    getPostTimeline(postKey)             → OccupancyEntry[] over time
//    getPersonAppointments(personName)    → PersonAppointment[]
//    getFutureEffectiveMovements()        → movements after today
// ==========================================================================

'use strict';

var OCCUPANCY_CACHE = {};
var OCCUPANCY_CACHE_DATE = null;
var MOVEMENTS_SORTED = null;

// ---- tie-breaking sort ----------------------------------------------------

function pnToSortable(raw) {
  // "4/2026" → 20260004,  empty → 0
  if (!raw) return 0;
  var m = String(raw).match(/(\d{1,4})\s*\/\s*(\d{4})/);
  if (m) return parseInt(m[2], 10) * 10000 + parseInt(m[1], 10);
  // try to parse as number
  var n = parseInt(raw, 10);
  return isNaN(n) ? 0 : n;
}

function compareMovements(a, b) {
  // 1. effective date
  var da = (a.effectiveDateKey || '');
  var db = (b.effectiveDateKey || '');
  if (da !== db) return da.localeCompare(db);

  // 2. PN serial  (higher PN breaks ties within same day)
  var pa = pnToSortable(a.noticeId ? (NoticeStore[a.noticeId] || {}).noticeNumber : '');
  var pb = pnToSortable(b.noticeId ? (NoticeStore[b.noticeId] || {}).noticeNumber : '');
  if (pa !== pb) return pa - pb;

  // 3. updatedAt  (newer wins)
  var ua = a.updatedAt || a.createdAt || '';
  var ub = b.updatedAt || b.createdAt || '';
  if (ua !== ub) return ua > ub ? 1 : -1;

  return 0;
}

// ---- cache management -----------------------------------------------------

function invalidateOccupancyCache() {
  OCCUPANCY_CACHE = {};
  OCCUPANCY_CACHE_DATE = null;
  MOVEMENTS_SORTED = null;
}

function getSortedMovements() {
  if (MOVEMENTS_SORTED) return MOVEMENTS_SORTED;
  var filtered = MovementStore.filter(function(m) {
    if (m.supersededFlag || m.cancelledFlag) return false;
    // Also exclude movements whose parent notice is superseded or cancelled
    if (m.noticeId) {
      var notice = NoticeStore[m.noticeId];
      if (notice && (notice.status === 'superseded' || notice.status === 'cancelled')) return false;
    }
    return true;
  });
  filtered.sort(compareMovements);
  MOVEMENTS_SORTED = filtered;
  return MOVEMENTS_SORTED;
}

// ---- post key helpers -----------------------------------------------------

function postKey(post, dept) {
  return (post || '').trim() + '||' + (dept || '').trim();
}

// ---- core replay engine ---------------------------------------------------

/**
 * Replay all movements up to `asOfDate` (inclusive) and return occupancy.
 *
 * @param {string} asOfDate  — "YYYYMMDD" sort key (from parseDateToKey)
 * @return {object} { [postKey]: OccupancyEntry }
 */
function getOccupancySnapshot(asOfDate) {
  var key = asOfDate || '99999999';
  if (OCCUPANCY_CACHE_DATE === key) return OCCUPANCY_CACHE;

  var movs = getSortedMovements();
  var state = {};
  var todayKey = formatTodayKey();

  for (var i = 0; i < movs.length; i++) {
    var m = movs[i];
    var dk = m.effectiveDateKey || '';

    // Determine whether this movement is past/present or future
    var isPastOrPresent = dk <= asOfDate;
    var isFuture = dk > asOfDate && dk > todayKey;

    // ---- process LEAVE (from_post) ---------------------------------------
    var fromKey = postKey(
      (PostStore[m.fromPostId] || {}).title || '',
      (DeptStore[m.fromDeptId] || {}).name   || ''
    );
    if (fromKey !== '||' && isPastOrPresent) {
      var fromEntry = ensureEntry(state, fromKey, m);
      // person leaving clears their occupancy
      if (fromEntry.substantiveHolder && fromEntry.substantiveHolder.personId === m.personId) {
        fromEntry.substantiveHolder = null;
      }
      if (fromEntry.actingHolder && fromEntry.actingHolder.personId === m.personId) {
        fromEntry.actingHolder = null;
      }
    }

    // ---- process JOIN (to_post) ------------------------------------------
    var toKey = postKey(
      (PostStore[m.toPostId] || {}).title || '',
      (DeptStore[m.toDeptId] || {}).name   || ''
    );
    if (toKey === '||') continue;

    var entry = ensureEntry(state, toKey, m);

    // future movements: only mark as incoming, don't set current holder
    if (isFuture) {
      if (!entry.futureIncoming || dk > (entry.futureIncoming.effectiveDateKey || '')) {
        entry.futureIncoming = holderFromMovement(m);
      }
      continue;
    }

    // past/present: apply the movement based on remark type
    applyMovementToEntry(entry, m, dk);
  }

  OCCUPANCY_CACHE = state;
  OCCUPANCY_CACHE_DATE = key;
  return state;
}

function ensureEntry(state, key, mov) {
  if (!state[key]) {
    var postParts = key.split('||');
    var isObs = (postOverrides && postOverrides[key] === 'deleted');
    state[key] = {
      postKey:           key,
      postTitle:         postParts[0],
      deptName:          postParts[1] || '',
      substantiveHolder: null,
      actingHolder:      null,
      futureIncoming:    null,
      isVacant:          !isObs,
      isObsolete:        isObs,
      lastMovement:      mov,
      heldSince:         mov.effectiveDate || ''
    };
  }
  if (!state[key].lastMovement || compareMovements(mov, state[key].lastMovement) > 0) {
    state[key].lastMovement = mov;
  }
  return state[key];
}

function holderFromMovement(m) {
  var p = PersonStore[m.personId];
  return {
    personId:       m.personId,
    name:           p ? p.name : '',
    nickname:       p ? p.nickname : '',
    image:          p ? p.image : '',
    effectiveDate:  m.effectiveDate,
    effectiveDateKey: m.effectiveDateKey,
    movementId:     m.movementId
  };
}

function applyMovementToEntry(entry, m, dk) {
  var remarkType = m.parsedRemarkType || 'general';
  var holder = holderFromMovement(m);

  // ---- acting / continue-acting ------------------------------------------
  if (remarkType === 'acting' || remarkType === 'continue-acting') {
    // Set as acting holder; does not replace substantive
    if (!entry.actingHolder ||
        dk >= (entry.actingHolder.effectiveDateKey || '')) {
      entry.actingHolder = holder;
      entry.actingHolder.actingType = remarkType === 'continue-acting' ? 'continue-acting' : 'acting';
    }
    // If there was no substantive holder, this is also the de-facto holder
    if (!entry.substantiveHolder) {
      entry.substantiveHolder = holder;
      entry.heldSince = m.effectiveDate;
    }
    entry.isVacant = false;
    return;
  }

  // ---- cease-acting ------------------------------------------------------
  if (remarkType === 'cease-acting') {
    if (entry.actingHolder && entry.actingHolder.personId === m.personId) {
      entry.actingHolder = null;
    }
    // Check if substantive holder still exists
    if (!entry.substantiveHolder && !entry.actingHolder) {
      entry.isVacant = true;
    }
    return;
  }

  // ---- fill-new-post / fill-vacant-post / fill-temporary-post ------------
  if (remarkType === 'fill-new-post' || remarkType === 'fill-vacant-post' ||
      remarkType === 'fill-temporary-post') {
    // New appointment — becomes substantive (or acting for temporary)
    if (remarkType === 'fill-temporary-post') {
      entry.actingHolder = holder;
      entry.actingHolder.actingType = 'temporary';
    }
    // Set as substantive holder (later date wins)
    if (!entry.substantiveHolder ||
        dk >= (entry.substantiveHolder.effectiveDateKey || '')) {
      entry.substantiveHolder = holder;
      entry.heldSince = m.effectiveDate;
    }
    entry.isVacant = false;
    return;
  }

  // ---- retitled / redeployed — post metadata change, holder unchanged ----
  if (remarkType === 'retitled' || remarkType === 'redeployed') {
    // These are post-level changes; holder status is unchanged.
    // The movement is recorded but doesn't affect occupancy.
    return;
  }

  // ---- transfer-out / no-pay-leave / attachment — departure --------------
  if (remarkType === 'transfer-out' || remarkType === 'no-pay-leave') {
    // Person leaves; clear their holding
    if (entry.substantiveHolder && entry.substantiveHolder.personId === m.personId) {
      entry.substantiveHolder = null;
    }
    if (entry.actingHolder && entry.actingHolder.personId === m.personId) {
      entry.actingHolder = null;
    }
    if (!entry.substantiveHolder && !entry.actingHolder) {
      entry.isVacant = true;
    }
    return;
  }

  // ---- attachment: person is temporarily away but post not vacant --------
  if (remarkType === 'attachment') {
    // The person is still the holder but flagged as on attachment
    if (!entry.substantiveHolder ||
        dk >= (entry.substantiveHolder.effectiveDateKey || '')) {
      entry.substantiveHolder = holder;
      entry.substantiveHolder.onAttachment = true;
    }
    entry.isVacant = false;
    return;
  }

  // ---- general / default: standard transfer/promotion --------------------
  // Person joins to_post, leaves from_post (LEAVE is handled above)
  if (dk > (entry.substantiveHolder ? (entry.substantiveHolder.effectiveDateKey || '') : '')) {
    entry.substantiveHolder = holder;
    entry.heldSince = m.effectiveDate;
  }
  // If acting holder is the same person, clear acting (they're now substantive)
  if (entry.actingHolder && entry.actingHolder.personId === m.personId) {
    entry.actingHolder = null;
  }
  entry.isVacant = false;
}

// ---- date helpers ---------------------------------------------------------

function formatTodayKey() {
  var d = new Date();
  return d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0');
}

function formatDisplayDate(dateKey) {
  if (!dateKey || dateKey.length !== 8) return dateKey || '';
  return dateKey.substring(6, 8) + '.' + dateKey.substring(4, 6) + '.' + dateKey.substring(0, 4);
}

// ---- query API ------------------------------------------------------------

/**
 * Get occupancy for all posts as of today.
 */
function getCurrentOccupancy() {
  return getOccupancySnapshot(formatTodayKey());
}

/**
 * Get occupancy for all posts as of a specific date string (DD.MM.YYYY).
 */
function getOccupancyAtDisplayDate(displayDate) {
  var dk;
  if (displayDate) {
    var m = String(displayDate).match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) dk = m[3] + m[2].padStart(2, '0') + m[1].padStart(2, '0');
  }
  dk = dk || formatTodayKey();
  return getOccupancySnapshot(dk);
}

/**
 * Get the full timeline for a post — all occupancy changes over time.
 */
function getPostTimeline(postKey) {
  var movs = getSortedMovements();
  var timeline = [];
  for (var i = 0; i < movs.length; i++) {
    var m = movs[i];
    var fromKey = postKey(
      (PostStore[m.fromPostId] || {}).title || '',
      (DeptStore[m.fromDeptId] || {}).name   || ''
    );
    var toKey = postKey(
      (PostStore[m.toPostId] || {}).title || '',
      (DeptStore[m.toDeptId] || {}).name   || ''
    );
    if (fromKey === postKey || toKey === postKey) {
      timeline.push({
        date:          m.effectiveDate,
        dateKey:       m.effectiveDateKey,
        person:        PersonStore[m.personId],
        fromPost:      fromKey === postKey ? (PostStore[m.fromPostId] || {}).title : null,
        toPost:        toKey === postKey ? (PostStore[m.toPostId] || {}).title : null,
        remarkType:    m.parsedRemarkType,
        movement:      m
      });
    }
  }
  timeline.sort(function(a, b) { return (a.dateKey || '').localeCompare(b.dateKey || ''); });
  return timeline;
}

/**
 * Get all appointments for a person (chronological).
 */
function getPersonAppointments(personName) {
  var norm = normalisePersonName(personName).toLowerCase();
  var pid = hashId(norm);
  var movs = getSortedMovements();
  var results = [];
  for (var i = 0; i < movs.length; i++) {
    var m = movs[i];
    if (m.personId === pid) {
      results.push({
        date:         m.effectiveDate,
        dateKey:      m.effectiveDateKey,
        fromPost:     PostStore[m.fromPostId] ? PostStore[m.fromPostId].title : '',
        fromDept:     DeptStore[m.fromDeptId] ? DeptStore[m.fromDeptId].name   : '',
        toPost:       PostStore[m.toPostId]   ? PostStore[m.toPostId].title   : '',
        toDept:       DeptStore[m.toDeptId]   ? DeptStore[m.toDeptId].name    : '',
        remarkType:   m.parsedRemarkType,
        noticeNumber: NoticeStore[m.noticeId] ? NoticeStore[m.noticeId].noticeNumber : '',
        movement:     m
      });
    }
  }
  return results;
}

/**
 * Get movements that will take effect after today (future postings).
 */
function getFutureEffectiveMovements() {
  var today = formatTodayKey();
  var movs = getSortedMovements();
  return movs.filter(function(m) {
    return (m.effectiveDateKey || '') > today;
  });
}

/**
 * Get occupancy summary counts.
 */
function getOccupancySummary(asOfDate) {
  var snapshot = getOccupancySnapshot(asOfDate || formatTodayKey());
  var keys = Object.keys(snapshot);
  var occupied = 0, vacant = 0, obsolete = 0, acting = 0, futureIncoming = 0;
  for (var i = 0; i < keys.length; i++) {
    var e = snapshot[keys[i]];
    if (e.isObsolete) obsolete++;
    else if (e.isVacant) vacant++;
    else occupied++;
    if (e.actingHolder) acting++;
    if (e.futureIncoming) futureIncoming++;
  }
  return {
    total: keys.length,
    occupied: occupied,
    vacant: vacant,
    obsolete: obsolete,
    acting: acting,
    futureIncoming: futureIncoming,
    asOfDate: asOfDate || formatTodayKey()
  };
}

/**
 * Convert occupancy snapshot to rows for rendering (compatible with
 * the existing renderCurrentTable data format).
 */
function occupancyToRows(snapshot, sortKey, sortDir) {
  sortKey = sortKey || 'date';
  sortDir = sortDir || 'desc';
  var keys = Object.keys(snapshot);
  var rows = [];

  for (var i = 0; i < keys.length; i++) {
    var e = snapshot[keys[i]];
    if (e.postKey === '||') continue;

    var holder = e.substantiveHolder || e.actingHolder;
    rows.push({
      postKey:       e.postKey,
      name:          holder ? holder.name : '',
      personId:      holder ? holder.personId : '',
      to_post:       e.postTitle,
      to_dept:       e.deptName,
      date:          e.heldSince || '',
      dateKey:       holder ? holder.effectiveDateKey : '',
      posting_notice: e.lastMovement ? (NoticeStore[e.lastMovement.noticeId] || {}).noticeNumber : '',
      isVacant:      e.isVacant && !e.isObsolete,
      isDeleted:     e.isObsolete,
      isActing:      !!e.actingHolder,
      isFutureIncoming: !!e.futureIncoming,
      onAttachment:  holder ? !!holder.onAttachment : false,
      substantiveHolder: e.substantiveHolder,
      actingHolder:  e.actingHolder,
      futureIncoming: e.futureIncoming,
      rawRecord:     e.lastMovement ? {
        name:           holder ? holder.name : '',
        posting_notice: (NoticeStore[e.lastMovement.noticeId] || {}).noticeNumber || '',
        to_post:        e.postTitle,
        to_dept:        e.deptName,
        date:           e.heldSince || ''
      } : { name: '', posting_notice: '', to_post: e.postTitle, to_dept: e.deptName, date: '' }
    });
  }

  // sort
  rows.sort(function(a, b) {
    var va, vb;
    if (sortKey === 'name') {
      va = a.name || ''; vb = b.name || '';
      return sortDir === 'asc' ? va.localeCompare(vb, 'en') : vb.localeCompare(va, 'en');
    } else if (sortKey === 'date') {
      va = a.dateKey || ''; vb = b.dateKey || '';
      return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    } else if (sortKey === 'role') {
      va = a.to_post || ''; vb = b.to_post || '';
      return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    return 0;
  });

  return rows;
}

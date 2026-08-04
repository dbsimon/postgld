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
    if (typeof isMovementActiveForOccupancy === 'function') {
      return isMovementActiveForOccupancy(m);
    }
    // Fallback: filter at movement level only (no notice-level cascade)
    if (m.supersededFlag || m.cancelledFlag) return false;
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
  var key = asOfDate || formatTodayKey();

  if (!/^\d{8}$/.test(key)) {
    key = formatTodayKey();
  }

  if (OCCUPANCYCACHEDATE === key) {
    return OCCUPANCYCACHE;
  }

  var movs = getSortedMovements();
  var state = {};

  /*
   * Each person's current substantive post.
   * Rule: one person may hold only one substantive post.
   * When a later movement appoints the same person to another post,
   * the earlier substantive post becomes vacant.
   */
  var substantivePostByPerson = {};

  /*
   * Each person's acting post.
   * Acting is tracked separately because it may coexist with a
   * substantive appointment.
   */
  var actingPostByPerson = {};

  for (var i = 0; i < movs.length; i++) {
    var m = movs[i];
    var dk = m.effectiveDateKey || '';

    // Critical: movements after the selected as-of date do not exist yet.
    if (!/^\d{8}$/.test(dk) || dk > key) {
      continue;
    }

    var person = PersonStore[m.personId];
    var personName = person ? person.name : '';

    var fromPost = PostStore[m.fromPostId];
    var fromDept = DeptStore[m.fromDeptId];
    var toPost = PostStore[m.toPostId];
    var toDept = DeptStore[m.toDeptId];

    var fromKey = (fromPost && fromDept)
      ? postKey(fromPost.title, fromDept.name)
      : '';

    var toKey = (toPost && toDept)
      ? postKey(toPost.title, toDept.name)
      : '';

    var remarkType = String(m.parsedRemarkType || 'general')
      .toLowerCase();

    /*
     * A movement away from a source post vacates it only when that
     * person is genuinely recorded as its holder.
     */
    if (fromKey) {
      var fromEntry = ensureEntry(state, fromKey, m);

      if (fromEntry.substantiveHolder &&
          fromEntry.substantiveHolder.personId === m.personId) {
        fromEntry.substantiveHolder = null;
        fromEntry.isVacant = !fromEntry.isObsolete;

        if (substantivePostByPerson[m.personId] === fromKey) {
          delete substantivePostByPerson[m.personId];
        }
      }

      if (fromEntry.actingHolder &&
          fromEntry.actingHolder.personId === m.personId) {
        fromEntry.actingHolder = null;

        if (actingPostByPerson[m.personId] === fromKey) {
          delete actingPostByPerson[m.personId];
        }
      }
    }

    /*
     * Some movements only end/alter an existing appointment and do
     * not appoint the person to a new post.
     */
    if (!toKey) {
      continue;
    }

    var entry = ensureEntry(state, toKey, m);
    var holder = holderFromMovement(m);

    // These change post metadata only; they do not assign a holder.
    if (remarkType === 'retitled' || remarkType === 'redeployed') {
      continue;
    }

    /*
     * End of acting: remove this person only from the acting holder
     * of the target post. Their substantive appointment remains.
     */
    if (remarkType === 'cease-acting') {
      if (entry.actingHolder &&
          entry.actingHolder.personId === m.personId) {
        entry.actingHolder = null;

        if (actingPostByPerson[m.personId] === toKey) {
          delete actingPostByPerson[m.personId];
        }
      }

      entry.isVacant = !entry.isObsolete &&
        !entry.substantiveHolder &&
        !entry.actingHolder;

      continue;
    }

    /*
     * Transfer-out / no-pay leave removes the person from the target
     * post if it is their current post. It does not appoint them here.
     */
    if (remarkType === 'transfer-out' || remarkType === 'no-pay-leave') {
      if (entry.substantiveHolder &&
          entry.substantiveHolder.personId === m.personId) {
        entry.substantiveHolder = null;

        if (substantivePostByPerson[m.personId] === toKey) {
          delete substantivePostByPerson[m.personId];
        }
      }

      if (entry.actingHolder &&
          entry.actingHolder.personId === m.personId) {
        entry.actingHolder = null;

        if (actingPostByPerson[m.personId] === toKey) {
          delete actingPostByPerson[m.personId];
        }
      }

      entry.isVacant = !entry.isObsolete &&
        !entry.substantiveHolder &&
        !entry.actingHolder;

      continue;
    }

    /*
     * Acting assignments do not displace a substantive post.
     * A person can have one substantive post and one acting post.
     */
    if (remarkType === 'acting' ||
        remarkType === 'continue-acting' ||
        remarkType === 'fill-temporary-post') {

      var priorActingKey = actingPostByPerson[m.personId];

      if (priorActingKey && priorActingKey !== toKey && state[priorActingKey]) {
        var priorActingEntry = state[priorActingKey];

        if (priorActingEntry.actingHolder &&
            priorActingEntry.actingHolder.personId === m.personId) {
          priorActingEntry.actingHolder = null;
          priorActingEntry.isVacant = !priorActingEntry.isObsolete &&
            !priorActingEntry.substantiveHolder;
        }
      }

      entry.actingHolder = holder;
      entry.actingHolder.actingType =
        remarkType === 'fill-temporary-post'
          ? 'temporary'
          : remarkType;

      actingPostByPerson[m.personId] = toKey;

      /*
       * If there is no substantive holder, show the acting holder as
       * the operational holder of the vacant post.
       */
      entry.isVacant = !entry.isObsolete && !entry.substantiveHolder;
      entry.heldSince = m.effectiveDate;

      continue;
    }

    /*
     * Attachment keeps the person as substantive holder while marking
     * the appointment as attached. It must still obey one-post rule.
     */
    if (remarkType === 'attachment') {
      assignSubstantiveHolder(
        state,
        substantivePostByPerson,
        toKey,
        entry,
        holder,
        m
      );

      entry.substantiveHolder.onAttachment = true;
      continue;
    }

    /*
     * Standard appointment, promotion, transfer, fill-vacant-post,
     * and fill-new-post. Latest eligible movement prevails.
     */
    assignSubstantiveHolder(
      state,
      substantivePostByPerson,
      toKey,
      entry,
      holder,
      m
    );
  }

  /*
   * Include posts that exist only in postOverrides.
   * This ensures an obsoleted post appears even where there is no
   * movement on/before the chosen date.
   */
  for (var overrideKey in postOverrides) {
    if (!postOverrides.hasOwnProperty(overrideKey)) {
      continue;
    }

    if (!state[overrideKey]) {
      var parts = overrideKey.split('||');

      state[overrideKey] = {
        postKey: overrideKey,
        postTitle: parts[0] || '',
        deptName: parts[1] || '',
        substantiveHolder: null,
        actingHolder: null,
        futureIncoming: null,
        isVacant: postOverrides[overrideKey] !== 'deleted',
        isObsolete: postOverrides[overrideKey] === 'deleted',
        lastMovement: null,
        heldSince: ''
      };
    }
  }

  OCCUPANCYCACHE = state;
  OCCUPANCYCACHEDATE = key;

  return state;
}
function assignSubstantiveHolder(
  state,
  substantivePostByPerson,
  newPostKey,
  newEntry,
  holder,
  movement
) {
  var personId = holder.personId;
  var oldPostKey = substantivePostByPerson[personId];

  /*
   * One colleague, one substantive post:
   * remove the same person from any earlier substantive post before
   * assigning the newer post.
   */
  if (oldPostKey && oldPostKey !== newPostKey && state[oldPostKey]) {
    var oldEntry = state[oldPostKey];

    if (oldEntry.substantiveHolder &&
        oldEntry.substantiveHolder.personId === personId) {
      oldEntry.substantiveHolder = null;
      oldEntry.isVacant = !oldEntry.isObsolete &&
        !oldEntry.actingHolder;
    }
  }

  newEntry.substantiveHolder = holder;
  newEntry.isVacant = false;
  newEntry.heldSince = movement.effectiveDate;

  /*
   * A substantive appointment replaces an acting appointment by the
   * same person at that particular post.
   */
  if (newEntry.actingHolder &&
      newEntry.actingHolder.personId === personId) {
    newEntry.actingHolder = null;
  }

  substantivePostByPerson[personId] = newPostKey;
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
  return getOccupancyAtDate(displayDate);
}

function getOccupancyAtDate(inputDate) {
  var dk;
  try { dk = effectiveDateToKey(inputDate); } catch (e) { dk = formatTodayKey(); }
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
    if (!e || e.postKey === '||') continue;

    var holder = e.substantiveHolder || e.actingHolder;
    var notice = e.lastMovement && NoticeStore[e.lastMovement.noticeId]
      ? NoticeStore[e.lastMovement.noticeId].noticeNumber
      : '';

    rows.push({
      postKey: e.postKey,
      name: holder ? holder.name : '',
      personId: holder ? holder.personId : '',

      // These names must match app.js exactly.
      topost: e.postTitle || '',
      todept: e.deptName || '',
      date: e.heldSince || '',
      dateKey: holder ? holder.effectiveDateKey : '',
      postingnotice: notice,

      isVacant: !!e.isVacant && !e.isObsolete,
      isDeleted: !!e.isObsolete,
      isActing: !!e.actingHolder,
      isFutureIncoming: !!e.futureIncoming,
      onAttachment: holder ? !!holder.onAttachment : false,

      substantiveHolder: e.substantiveHolder,
      actingHolder: e.actingHolder,
      futureIncoming: e.futureIncoming,

      rawRecord: {
        name: holder ? holder.name : '',
        postingnotice: notice,
        topost: e.postTitle || '',
        todept: e.deptName || '',
        date: e.heldSince || ''
      }
    });
  }

  rows.sort(function(a, b) {
    var va, vb;

    if (sortKey === 'name') {
      va = a.name || '';
      vb = b.name || '';
      return sortDir === 'asc'
        ? va.localeCompare(vb, 'en')
        : vb.localeCompare(va, 'en');
    }

    if (sortKey === 'date') {
      va = a.dateKey || '';
      vb = b.dateKey || '';
      return sortDir === 'asc'
        ? va.localeCompare(vb)
        : vb.localeCompare(va);
    }

    if (sortKey === 'role') {
      va = a.topost || '';
      vb = b.topost || '';
      return sortDir === 'asc'
        ? va.localeCompare(vb)
        : vb.localeCompare(va);
    }

    return 0;
  });

  return rows;
}

// ==========================================================================
// Posting Manager — As-Of-Date Occupancy Engine
// ==========================================================================
// Reconstructs post occupancy at any selected date by replaying active
// posting movements chronologically.
//
// Dependencies, loaded before this file:
//   - data-model-4.js
//   - MovementStore, PersonStore, PostStore, DeptStore, NoticeStore
//   - isMovementActiveForOccupancy()
//   - normalisePersonName(), hashId() where available
//
// Required script order:
//   remark-parser.js
//   data-model-4.js
//   validation-engine-6.js
//   as-of-date-engine.js
//   audit-trail.js
//   app.js
// ==========================================================================

'use strict';

// ---- cache ----------------------------------------------------------------

var OCCUPANCY_CACHE = {};
var OCCUPANCY_CACHE_DATE = '';
var MOVEMENTS_SORTED = null;

function invalidateOccupancyCache() {
  OCCUPANCY_CACHE = {};
  OCCUPANCY_CACHE_DATE = '';
  MOVEMENTS_SORTED = null;
}

// ---- date and sorting helpers ---------------------------------------------

function formatTodayKey() {
  var date = new Date();

  return String(date.getFullYear()) +
    String(date.getMonth() + 1).padStart(2, '0') +
    String(date.getDate()).padStart(2, '0');
}

function formatDisplayDate(dateKey) {
  var key = String(dateKey || '');

  if (!/^\d{8}$/.test(key)) {
    return key;
  }

  return key.substring(6, 8) + '.' +
    key.substring(4, 6) + '.' +
    key.substring(0, 4);
}

function pnToSortable(raw) {
  if (!raw) {
    return 0;
  }

  var match = String(raw).match(/(\d{1,4})\s*\/\s*(\d{4})/);

  if (match) {
    return parseInt(match[2], 10) * 10000 + parseInt(match[1], 10);
  }

  var numeric = parseInt(raw, 10);
  return isNaN(numeric) ? 0 : numeric;
}

function compareMovements(a, b) {
  var dateA = a.effectiveDateKey || '';
  var dateB = b.effectiveDateKey || '';

  if (dateA !== dateB) {
    return dateA.localeCompare(dateB);
  }

  var noticeA = a.noticeId && NoticeStore[a.noticeId]
    ? NoticeStore[a.noticeId].noticeNumber
    : '';

  var noticeB = b.noticeId && NoticeStore[b.noticeId]
    ? NoticeStore[b.noticeId].noticeNumber
    : '';

  var pnA = pnToSortable(noticeA);
  var pnB = pnToSortable(noticeB);

  if (pnA !== pnB) {
    return pnA - pnB;
  }

  var updatedA = a.updatedAt || a.createdAt || '';
  var updatedB = b.updatedAt || b.createdAt || '';

  if (updatedA !== updatedB) {
    return updatedA > updatedB ? 1 : -1;
  }

  return 0;
}

function getSortedMovements() {
  if (MOVEMENTS_SORTED) {
    return MOVEMENTS_SORTED;
  }

  var source = Array.isArray(MovementStore)
    ? MovementStore
    : [];

  MOVEMENTS_SORTED = source.filter(function(movement) {
    if (typeof isMovementActiveForOccupancy === 'function') {
      return isMovementActiveForOccupancy(movement);
    }

    return !movement.cancelledFlag && !movement.supersededFlag;
  });

  MOVEMENTS_SORTED.sort(compareMovements);

  return MOVEMENTS_SORTED;
}

// ---- post helpers ----------------------------------------------------------

function postKey(post, dept) {
  return String(post || '').trim() + '||' + String(dept || '').trim();
}

function getPostPair(movement, direction) {
  var postId = direction === 'from'
    ? movement.fromPostId
    : movement.toPostId;

  var deptId = direction === 'from'
    ? movement.fromDeptId
    : movement.toDeptId;

  var post = PostStore[postId];
  var dept = DeptStore[deptId];

  if (!post || !dept) {
    return null;
  }

  return {
    key: postKey(post.title, dept.name),
    postTitle: post.title || '',
    deptName: dept.name || ''
  };
}

function getCurrentOverrideStatus(key, selectedDateKey) {
  /*
   * postOverrides contains only present-state instructions and does not
   * contain an effective date. Therefore it is applied only to today.
   */
  if (selectedDateKey !== formatTodayKey()) {
    return '';
  }

  if (
    typeof postOverrides !== 'undefined' &&
    postOverrides &&
    postOverrides[key] === 'deleted'
  ) {
    return 'deleted';
  }

  return '';
}

function ensureEntry(state, key, movement, selectedDateKey) {
  if (!state[key]) {
    var parts = key.split('||');
    var isObsolete = getCurrentOverrideStatus(key, selectedDateKey) === 'deleted';

    state[key] = {
      postKey: key,
      postTitle: parts[0] || '',
      deptName: parts[1] || '',
      substantiveHolder: null,
      actingHolder: null,
      futureIncoming: null,
      isVacant: !isObsolete,
      isObsolete: isObsolete,
      lastMovement: movement || null,
      heldSince: ''
    };
  }

  if (
    movement &&
    (
      !state[key].lastMovement ||
      compareMovements(movement, state[key].lastMovement) > 0
    )
  ) {
    state[key].lastMovement = movement;
  }

  return state[key];
}

function holderFromMovement(movement) {
  var person = PersonStore[movement.personId];

  return {
    personId: movement.personId || '',
    name: person ? person.name || '' : '',
    nickname: person ? person.nickname || '' : '',
    image: person ? person.image || '' : '',
    effectiveDate: movement.effectiveDate || '',
    effectiveDateKey: movement.effectiveDateKey || '',
    movementId: movement.movementId || '',
    onAttachment: false
  };
}

function refreshVacancy(entry) {
  entry.isVacant = !entry.isObsolete &&
    !entry.substantiveHolder &&
    !entry.actingHolder;
}

function removeSubstantiveHolder(entry, personId) {
  if (
    entry.substantiveHolder &&
    entry.substantiveHolder.personId === personId
  ) {
    entry.substantiveHolder = null;
    refreshVacancy(entry);
  }
}

function removeActingHolder(entry, personId) {
  if (
    entry.actingHolder &&
    entry.actingHolder.personId === personId
  ) {
    entry.actingHolder = null;
    refreshVacancy(entry);
  }
}

function assignSubstantiveHolder(
  state,
  substantivePostByPerson,
  destinationKey,
  entry,
  holder,
  movement
) {
  var personId = holder.personId;
  var previousKey = substantivePostByPerson[personId];

  /*
   * A person holds only one substantive post. A later substantive posting
   * automatically vacates their earlier substantive post.
   */
  if (
    previousKey &&
    previousKey !== destinationKey &&
    state[previousKey]
  ) {
    removeSubstantiveHolder(state[previousKey], personId);
  }

  entry.substantiveHolder = holder;
  entry.isVacant = false;
  entry.heldSince = movement.effectiveDate || '';

  /*
   * The substantive appointment supersedes the person's acting appointment
   * only when both appointments are for the same post.
   */
  if (
    entry.actingHolder &&
    entry.actingHolder.personId === personId
  ) {
    entry.actingHolder = null;
  }

  substantivePostByPerson[personId] = destinationKey;
}

function assignActingHolder(
  state,
  actingPostByPerson,
  destinationKey,
  entry,
  holder,
  movement,
  actingType
) {
  var personId = holder.personId;
  var previousKey = actingPostByPerson[personId];

  /*
   * A person holds one acting appointment at a time. Their substantive
   * appointment remains untouched.
   */
  if (
    previousKey &&
    previousKey !== destinationKey &&
    state[previousKey]
  ) {
    removeActingHolder(state[previousKey], personId);
  }

  holder.actingType = actingType;
  entry.actingHolder = holder;
  entry.isVacant = false;
  entry.heldSince = movement.effectiveDate || '';

  actingPostByPerson[personId] = destinationKey;
}

// ---- snapshot replay ------------------------------------------------------

function getOccupancySnapshot(asOfDate) {
  var selectedDateKey = String(asOfDate || formatTodayKey());

  if (!/^\d{8}$/.test(selectedDateKey)) {
    selectedDateKey = formatTodayKey();
  }

  if (OCCUPANCY_CACHE_DATE === selectedDateKey) {
    return OCCUPANCY_CACHE;
  }

  var movements = getSortedMovements();
  var state = {};

  /*
   * Tracks each person's currently held substantive and acting appointments.
   */
  var substantivePostByPerson = {};
  var actingPostByPerson = {};

  for (var i = 0; i < movements.length; i++) {
    var movement = movements[i];
    var movementDateKey = movement.effectiveDateKey || '';

    /*
     * Future movements do not exist in a historical snapshot.
     */
    if (
      !/^\d{8}$/.test(movementDateKey) ||
      movementDateKey > selectedDateKey
    ) {
      continue;
    }

    var fromPair = getPostPair(movement, 'from');
    var toPair = getPostPair(movement, 'to');

    var fromKey = fromPair ? fromPair.key : '';
    var toKey = toPair ? toPair.key : '';

    var remarkType = String(
      movement.parsedRemarkType || 'general'
    ).toLowerCase();

    /*
     * The source post is vacated only when the moving person is its
     * recorded substantive or acting holder.
     */
    if (fromKey) {
      var fromEntry = ensureEntry(
        state,
        fromKey,
        movement,
        selectedDateKey
      );

      removeSubstantiveHolder(fromEntry, movement.personId);
      removeActingHolder(fromEntry, movement.personId);

      if (substantivePostByPerson[movement.personId] === fromKey) {
        delete substantivePostByPerson[movement.personId];
      }

      if (actingPostByPerson[movement.personId] === fromKey) {
        delete actingPostByPerson[movement.personId];
      }
    }

    /*
     * A departure-only movement has no destination appointment.
     */
    if (!toKey) {
      continue;
    }

    var entry = ensureEntry(
      state,
      toKey,
      movement,
      selectedDateKey
    );

    var holder = holderFromMovement(movement);

    /*
     * Retitling and redeployment establish post metadata but do not assign
     * the named person as a holder.
     */
    if (
      remarkType === 'retitled' ||
      remarkType === 'redeployed'
    ) {
      continue;
    }

    /*
     * Ending acting removes only the acting assignment. A substantive
     * appointment at the same post remains in place.
     */
    if (remarkType === 'cease-acting') {
      removeActingHolder(entry, movement.personId);

      if (actingPostByPerson[movement.personId] === toKey) {
        delete actingPostByPerson[movement.personId];
      }

      continue;
    }

    /*
     * These movement types end a holding but do not appoint the colleague
     * to the stated destination.
     */
    if (
      remarkType === 'transfer-out' ||
      remarkType === 'no-pay-leave'
    ) {
      removeSubstantiveHolder(entry, movement.personId);
      removeActingHolder(entry, movement.personId);

      if (substantivePostByPerson[movement.personId] === toKey) {
        delete substantivePostByPerson[movement.personId];
      }

      if (actingPostByPerson[movement.personId] === toKey) {
        delete actingPostByPerson[movement.personId];
      }

      continue;
    }

    /*
     * Acting/temporary appointments are operational holders but do not
     * replace the person's substantive appointment.
     */
    if (
      remarkType === 'acting' ||
      remarkType === 'continue-acting' ||
      remarkType === 'fill-temporary-post'
    ) {
      assignActingHolder(
        state,
        actingPostByPerson,
        toKey,
        entry,
        holder,
        movement,
        remarkType === 'fill-temporary-post'
          ? 'temporary'
          : remarkType
      );

      continue;
    }

    /*
     * Attachment retains the substantive appointment and adds a display
     * marker for the existing current-table UI.
     */
    if (remarkType === 'attachment') {
      holder.onAttachment = true;

      assignSubstantiveHolder(
        state,
        substantivePostByPerson,
        toKey,
        entry,
        holder,
        movement
      );

      continue;
    }

    /*
     * General posting, promotion, transfer, fill-new-post and
     * fill-vacant-post become substantive appointments.
     */
    assignSubstantiveHolder(
      state,
      substantivePostByPerson,
      toKey,
      entry,
      holder,
      movement
    );
  }

  /*
   * Include every post that was known on or before the selected date.
   * This includes vacant historical posts but excludes posts that first
   * occur only in future movements.
   */
  for (var j = 0; j < movements.length; j++) {
    var knownMovement = movements[j];
    var knownDateKey = knownMovement.effectiveDateKey || '';

    if (
      !/^\d{8}$/.test(knownDateKey) ||
      knownDateKey > selectedDateKey
    ) {
      continue;
    }

    var pairs = [
      getPostPair(knownMovement, 'from'),
      getPostPair(knownMovement, 'to')
    ];

    for (var p = 0; p < pairs.length; p++) {
      if (!pairs[p]) {
        continue;
      }

      ensureEntry(
        state,
        pairs[p].key,
        null,
        selectedDateKey
      );
    }
  }

  /*
   * Legacy overrides have no historical date, so apply them only in the
   * present-day view. They deliberately do not alter past snapshots.
   */
  if (
    selectedDateKey === formatTodayKey() &&
    typeof postOverrides !== 'undefined' &&
    postOverrides
  ) {
    for (var overrideKey in postOverrides) {
      if (
        !Object.prototype.hasOwnProperty.call(
          postOverrides,
          overrideKey
        )
      ) {
        continue;
      }

      if (!state[overrideKey]) {
        ensureEntry(
          state,
          overrideKey,
          null,
          selectedDateKey
        );
      }

      if (postOverrides[overrideKey] === 'deleted') {
        state[overrideKey].isObsolete = true;
        state[overrideKey].isVacant = false;
        state[overrideKey].substantiveHolder = null;
        state[overrideKey].actingHolder = null;
      } else {
        state[overrideKey].isObsolete = false;
        refreshVacancy(state[overrideKey]);
      }
    }
  }

  OCCUPANCY_CACHE = state;
  OCCUPANCY_CACHE_DATE = selectedDateKey;

  return state;
}

// ---- public query functions ----------------------------------------------

function getCurrentOccupancy() {
  return getOccupancySnapshot(formatTodayKey());
}

function getOccupancyAtDate(inputDate) {
  var dateKey = formatTodayKey();

  if (typeof effectiveDateToKey === 'function') {
    try {
      dateKey = effectiveDateToKey(inputDate);
    } catch (error) {
      dateKey = formatTodayKey();
    }
  } else if (typeof parseDateToKey === 'function') {
    dateKey = parseDateToKey(inputDate) || formatTodayKey();
  }

  return getOccupancySnapshot(dateKey);
}

function getOccupancyAtDisplayDate(displayDate) {
  return getOccupancyAtDate(displayDate);
}

function getFutureEffectiveMovements() {
  var todayKey = formatTodayKey();

  return getSortedMovements().filter(function(movement) {
    return (movement.effectiveDateKey || '') > todayKey;
  });
}

function getPostTimeline(targetPostKey) {
  var movements = getSortedMovements();
  var timeline = [];

  for (var i = 0; i < movements.length; i++) {
    var movement = movements[i];
    var fromPair = getPostPair(movement, 'from');
    var toPair = getPostPair(movement, 'to');

    var isSource = fromPair && fromPair.key === targetPostKey;
    var isDestination = toPair && toPair.key === targetPostKey;

    if (!isSource && !isDestination) {
      continue;
    }

    timeline.push({
      date: movement.effectiveDate || '',
      dateKey: movement.effectiveDateKey || '',
      person: PersonStore[movement.personId] || null,
      fromPost: isSource ? fromPair.postTitle : null,
      fromDept: isSource ? fromPair.deptName : null,
      toPost: isDestination ? toPair.postTitle : null,
      toDept: isDestination ? toPair.deptName : null,
      remarkType: movement.parsedRemarkType || '',
      movement: movement
    });
  }

  timeline.sort(function(a, b) {
    return (a.dateKey || '').localeCompare(b.dateKey || '');
  });

  return timeline;
}

function getPersonAppointments(personName) {
  var normalisedName = typeof normalisePersonName === 'function'
    ? normalisePersonName(personName).toLowerCase()
    : String(personName || '').trim().toLowerCase();

  var personId = typeof hashId === 'function'
    ? hashId(normalisedName)
    : '';

  var movements = getSortedMovements();
  var appointments = [];

  for (var i = 0; i < movements.length; i++) {
    var movement = movements[i];

    if (movement.personId !== personId) {
      continue;
    }

    var fromPair = getPostPair(movement, 'from');
    var toPair = getPostPair(movement, 'to');

    appointments.push({
      date: movement.effectiveDate || '',
      dateKey: movement.effectiveDateKey || '',
      fromPost: fromPair ? fromPair.postTitle : '',
      fromDept: fromPair ? fromPair.deptName : '',
      toPost: toPair ? toPair.postTitle : '',
      toDept: toPair ? toPair.deptName : '',
      remarkType: movement.parsedRemarkType || '',
      noticeNumber: NoticeStore[movement.noticeId]
        ? NoticeStore[movement.noticeId].noticeNumber
        : '',
      movement: movement
    });
  }

  appointments.sort(function(a, b) {
    return (a.dateKey || '').localeCompare(b.dateKey || '');
  });

  return appointments;
}

function getOccupancySummary(asOfDate) {
  var selectedDateKey = asOfDate || formatTodayKey();
  var snapshot = getOccupancySnapshot(selectedDateKey);
  var keys = Object.keys(snapshot);

  var occupied = 0;
  var vacant = 0;
  var obsolete = 0;
  var acting = 0;
  var futureIncoming = 0;

  for (var i = 0; i < keys.length; i++) {
    var entry = snapshot[keys[i]];

    if (entry.isObsolete) {
      obsolete++;
    } else if (entry.isVacant) {
      vacant++;
    } else {
      occupied++;
    }

    if (entry.actingHolder) {
      acting++;
    }

    if (entry.futureIncoming) {
      futureIncoming++;
    }
  }

  return {
    total: keys.length,
    occupied: occupied,
    vacant: vacant,
    obsolete: obsolete,
    acting: acting,
    futureIncoming: futureIncoming,
    asOfDate: selectedDateKey
  };
}

// ---- adapter for renderCurrentTable() ------------------------------------

function occupancyToRows(snapshot, sortKey, sortDir) {
  sortKey = sortKey || 'date';
  sortDir = sortDir || 'desc';

  var keys = Object.keys(snapshot || {});
  var rows = [];

  for (var i = 0; i < keys.length; i++) {
    var entry = snapshot[keys[i]];

    if (!entry || entry.postKey === '||') {
      continue;
    }

    var holder = entry.substantiveHolder || entry.actingHolder;

    var notice = entry.lastMovement &&
      NoticeStore[entry.lastMovement.noticeId]
      ? NoticeStore[entry.lastMovement.noticeId].noticeNumber
      : '';

    rows.push({
      postKey: entry.postKey,

      name: holder ? holder.name : '',
      personId: holder ? holder.personId : '',

      /*
       * Required compatibility fields:
       * - app.js legacy/current renderer: to_post, to_dept, posting_notice
       * - earlier occupancy renderer: topost, todept, postingnotice
       */
      to_post: entry.postTitle || '',
      to_dept: entry.deptName || '',
      topost: entry.postTitle || '',
      todept: entry.deptName || '',

      date: entry.heldSince || '',
      dateKey: holder ? (holder.effectiveDateKey || '') : '',

      posting_notice: notice,
      postingnotice: notice,

      isVacant: !!entry.isVacant && !entry.isObsolete,
      isDeleted: !!entry.isObsolete,
      isActing: !!entry.actingHolder,
      isFutureIncoming: !!entry.futureIncoming,
      onAttachment: holder ? !!holder.onAttachment : false,

      substantiveHolder: entry.substantiveHolder,
      actingHolder: entry.actingHolder,
      futureIncoming: entry.futureIncoming,

      rawRecord: {
        name: holder ? holder.name : '',

        to_post: entry.postTitle || '',
        to_dept: entry.deptName || '',
        topost: entry.postTitle || '',
        todept: entry.deptName || '',

        date: entry.heldSince || '',

        posting_notice: notice,
        postingnotice: notice
      }
    });
  }

  rows.sort(function(a, b) {
    var valueA;
    var valueB;

    if (sortKey === 'name') {
      valueA = a.name || '';
      valueB = b.name || '';

      return sortDir === 'asc'
        ? valueA.localeCompare(valueB, 'en')
        : valueB.localeCompare(valueA, 'en');
    }

    if (sortKey === 'role') {
      valueA = a.to_post || a.topost || '';
      valueB = b.to_post || b.topost || '';

      return sortDir === 'asc'
        ? valueA.localeCompare(valueB, 'en')
        : valueB.localeCompare(valueA, 'en');
    }

    valueA = a.dateKey || '';
    valueB = b.dateKey || '';

    return sortDir === 'asc'
      ? valueA.localeCompare(valueB)
      : valueB.localeCompare(valueA);
  });

  return rows;
}
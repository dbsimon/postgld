// ==========================================================================
//  Posting Manager — Canonical Data Model
//  Version 2.0  (migration layer preserves flat-record compatibility)
// ==========================================================================
//
//  Entity inventory:
//    Person           — uniquely identified by normalized full name
//    Post             — job title, normalised; tied to a Department
//    Department       — organisational unit, normalised name
//    PostingMovement  — one person moving between posts (core event)
//    PostingNotice    — source document (PDF) that contains movements
//
//  All IDs are deterministic 6-char base-36 hashes so they are stable
//  across page reloads and survive Excel export/re-import round-trips.
// ==========================================================================

'use strict';

// ---- stable ID generator ------------------------------------------------

/**
 * djb2 hash → "000000"-"zzzzzz"  (6-char base-36, zero-padded).
 * Collisions are unlikely with the small data sets we handle.
 */
function hashId(str) {
  var h = 5381;
  for (var i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  if (h < 0) h = -h;
  // 6 base-36 digits wraps at ~2.1e9; fine for a few thousand entities.
  return ('000000' + h.toString(36)).slice(-6);
}

// ---- normalisation helpers -----------------------------------------------

function normalisePersonName(name) {
  var n = (name || '').trim().replace(/\s+/g, ' ');
  // Move trailing title to front: "CHU Tik-lun, Mr" → "Mr CHU Tik-lun"
  var m = n.match(/^(.+),\s*(Miss|Ms|Mr\.?|Mrs|Dr\.?|Madam)\s*$/i);
  if (m) {
    var title = m[2].replace(/\.$/, '');
    return title.charAt(0).toUpperCase() + title.slice(1).toLowerCase() + ' ' + m[1].trim();
  }
  return n;
}

function normaliseDeptName(name) {
  return (name || '').trim().replace(/\s+/g, ' ');
}

function normalisePostTitle(title) {
  return (title || '').trim().replace(/\s+/g, ' ');
}

function extractNoticeNumber(raw) {
  // "4/2026" → { number: 4, year: 2026, serial: "0004/2026" }
  var s = (raw || '').trim();
  var m = s.match(/^(\d{1,4})\s*\/\s*(\d{4})$/);
  if (m) {
    var num = parseInt(m[1], 10);
    var yr = parseInt(m[2], 10);
    return {
      number: num,
      year: yr,
      serial: String(num).padStart(4, '0') + '/' + yr
    };
  }
  return { number: 0, year: 0, serial: s || '' };
}

function parseDateToKey(dateStr) {
  // Returns "YYYYMMDD" sort key from DD.MM.YYYY or similar.
  var raw = (dateStr || '').trim();
  if (!raw) return '';

  var dm = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dm) return dm[3] + dm[2].padStart(2, '0') + dm[1].padStart(2, '0');

  var tm = raw.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (tm) {
    var mm = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',
               jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };
    return tm[3] + (mm[tm[2].toLowerCase()] || '00') + tm[1].padStart(2, '0');
  }

  var p = new Date(raw);
  if (!isNaN(p.getTime())) {
    return p.getFullYear() + String(p.getMonth() + 1).padStart(2, '0') + String(p.getDate()).padStart(2, '0');
  }
  return raw;
}

// ---- canonical stores ----------------------------------------------------

var PersonStore   = {};   // personId  → Person entity
var PostStore     = {};   // postId    → Post entity
var DeptStore     = {};   // deptId    → Department entity
var MovementStore = [];   // array of PostingMovement entities
var NoticeStore   = {};   // noticeId  → PostingNotice entity

// ---- supersession links (admin-managed) ------------------------------------

/**
 * _supersessionLinks: "noticeId" → { supersededByNoticeId, supersedesNoticeIds[], linkedAt, linkedBy }
 *
 * This is the authoritative source for notice-level supersession relationships.
 * It is persisted to localStorage as sys_supersession_links_pro.
 *
 * When a notice is superseded, its status becomes 'superseded'. All movements
 * within that notice inherit the superseded status unless they explicitly
 * reference the supersession in their remark.
 */
var _supersessionLinks = (function() {
  try { return JSON.parse(localStorage.getItem('sys_supersession_links_pro') || '{}'); }
  catch(e) { return {}; }
})();

function _persistSupersessionLinks() {
  try { localStorage.setItem('sys_supersession_links_pro', JSON.stringify(_supersessionLinks)); } catch(e) {}
}

/**
 * Register that notice A supersedes notice B.
 * Both are identified by their raw noticeNumber strings.
 * Returns the created link entry or null if self-reference.
 */
function registerNoticeSupersession(supersedingPn, supersededPn, linkedBy) {
  supersedingPn = (supersedingPn || '').trim();
  supersededPn  = (supersededPn || '').trim();
  if (!supersedingPn || !supersededPn || supersedingPn.replace(/\s+/g,'') === supersededPn.replace(/\s+/g,'')) return null;

  var sid = hashId(supersedingPn);
  var did = hashId(supersededPn);

  // Create/update superseding entry
  if (!_supersessionLinks[sid]) {
    _supersessionLinks[sid] = { supersededByNoticeId: '', supersedesNoticeIds: [], linkedAt: '', linkedBy: '' };
  }
  if (_supersessionLinks[sid].supersedesNoticeIds.indexOf(did) < 0) {
    _supersessionLinks[sid].supersedesNoticeIds.push(did);
  }
  _supersessionLinks[sid].linkedAt = new Date().toISOString();
  _supersessionLinks[sid].linkedBy = linkedBy || 'admin';

  // Create/update superseded entry
  if (!_supersessionLinks[did]) {
    _supersessionLinks[did] = { supersededByNoticeId: '', supersedesNoticeIds: [], linkedAt: '', linkedBy: '' };
  }
  _supersessionLinks[did].supersededByNoticeId = sid;
  _supersessionLinks[did].linkedAt = new Date().toISOString();
  _supersessionLinks[did].linkedBy = linkedBy || 'admin';

  _persistSupersessionLinks();
  resolveNoticeStatuses();

  return { supersedingId: sid, supersededId: did };
}

/**
 * Remove a supersession link. If noticeIdToRemove is provided, only that
 * specific edge is removed. Otherwise all links involving noticeId are cleared.
 */
function unlinkNoticeSupersession(noticePn, noticeIdToRemove) {
  var nid = hashId((noticePn || '').trim());
  if (!_supersessionLinks[nid]) return;

  if (noticeIdToRemove) {
    // Remove specific edge
    var idx = (_supersessionLinks[nid].supersedesNoticeIds || []).indexOf(noticeIdToRemove);
    if (idx >= 0) _supersessionLinks[nid].supersedesNoticeIds.splice(idx, 1);
    if (_supersessionLinks[noticeIdToRemove] && _supersessionLinks[noticeIdToRemove].supersededByNoticeId === nid) {
      _supersessionLinks[noticeIdToRemove].supersededByNoticeId = '';
    }
  } else {
    // Clear all links involving this notice
    var nids = Object.keys(_supersessionLinks);
    for (var i = 0; i < nids.length; i++) {
      var k = nids[i];
      if (_supersessionLinks[k].supersededByNoticeId === nid) {
        _supersessionLinks[k].supersededByNoticeId = '';
      }
      var sidx = (_supersessionLinks[k].supersedesNoticeIds || []).indexOf(nid);
      if (sidx >= 0) _supersessionLinks[k].supersedesNoticeIds.splice(sidx, 1);
    }
    delete _supersessionLinks[nid];
  }

  _persistSupersessionLinks();
  resolveNoticeStatuses();
}

/**
 * Check if a notice (by raw PN string) is superseded according to admin links.
 */
function isNoticeSupersededByAdmin(pnRaw) {
  var nid = hashId((pnRaw || '').trim());
  if (_supersessionLinks[nid] && _supersessionLinks[nid].supersededByNoticeId) {
    var superById = _supersessionLinks[nid].supersededByNoticeId;
    return NoticeStore[superById] ? NoticeStore[superById].noticeNumber : superById;
  }
  return null;
}

/**
 * Get the full supersession chain for a notice (returns array of notice IDs
 * ordered from oldest superseded to newest superseding).
 */
function getSupersessionChain(pnRaw) {
  var nid = hashId((pnRaw || '').trim());
  var chain = [nid];

  // Walk forward (what supersedes this)
  var cur = nid;
  while (_supersessionLinks[cur] && _supersessionLinks[cur].supersededByNoticeId) {
    cur = _supersessionLinks[cur].supersededByNoticeId;
    if (chain.indexOf(cur) >= 0) break; // cycle guard
    chain.push(cur);
  }

  // Walk backward (what does this supersede)
  cur = nid;
  var prefix = [];
  var visited = {};
  while (_supersessionLinks[cur]) {
    var supers = _supersessionLinks[cur].supersedesNoticeIds || [];
    for (var i = 0; i < supers.length; i++) {
      if (visited[supers[i]]) continue;
      visited[supers[i]] = true;
      prefix.unshift(supers[i]);
      // walk further back from each superseded notice
      var sub = supers[i];
      while (_supersessionLinks[sub]) {
        var subSupers = _supersessionLinks[sub].supersedesNoticeIds || [];
        for (var j = 0; j < subSupers.length; j++) {
          if (visited[subSupers[j]]) continue;
          visited[subSupers[j]] = true;
          prefix.unshift(subSupers[j]);
        }
        sub = _supersessionLinks[sub].supersededByNoticeId || '';
        if (!sub || chain.indexOf(sub) >= 0) break;
      }
    }
    break;
  }

  return prefix.concat(chain);
}

/**
 * Recompute notice.status for all notices in NoticeStore based on
 * _supersessionLinks and remark-based supersession parsing.
 * Also sets notice.supersededByNoticeId and notice.supersedesNoticeIds.
 */
function resolveNoticeStatuses() {
  var noticeIds = Object.keys(NoticeStore);

  // Reset all to active first
  for (var i = 0; i < noticeIds.length; i++) {
    NoticeStore[noticeIds[i]].status = 'active';
    NoticeStore[noticeIds[i]].supersededByNoticeId = '';
    NoticeStore[noticeIds[i]].supersedesNoticeIds = [];
  }

  // Apply admin links
  for (i = 0; i < noticeIds.length; i++) {
    var nid = noticeIds[i];
    if (_supersessionLinks[nid]) {
      var sl = _supersessionLinks[nid];
      if (sl.supersededByNoticeId && NoticeStore[sl.supersededByNoticeId]) {
        NoticeStore[nid].status = 'superseded';
        NoticeStore[nid].supersededByNoticeId = sl.supersededByNoticeId;
        NoticeStore[nid].supersededByNoticeNumber = NoticeStore[sl.supersededByNoticeId].noticeNumber;
      }
      // Note supersedes links
      var supers = sl.supersedesNoticeIds || [];
      for (var j = 0; j < supers.length; j++) {
        if (NoticeStore[supers[j]]) {
          NoticeStore[nid].supersedesNoticeIds.push(supers[j]);
        }
      }
    }
  }

  // Apply cancelled flags from movement-level data
  for (i = 0; i < MovementStore.length; i++) {
    var m = MovementStore[i];
    if (m.cancelledFlag && m.noticeId) {
      var notice = NoticeStore[m.noticeId];
      if (notice && notice.status !== 'superseded') {
        notice.status = 'cancelled';
      }
    }
  }
}

/**
 * Get the computed status of a movement, taking into account its
 * own flags and its parent notice's status.
 *
 * Returns: 'active' | 'superseded' | 'cancelled' | 'future' | 'warning'
 */
function getMovementStatus(movement) {
  if (!movement) return 'active';

  // Future movements
  var todayKey = (function() {
    var d = new Date();
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  })();
  if (movement.effectiveDateKey && movement.effectiveDateKey > todayKey) {
    return 'future';
  }

  // Cancelled at movement level
  if (movement.cancelledFlag) return 'cancelled';

  // Superseded — check parent notice status first
  if (movement.noticeId) {
    var notice = NoticeStore[movement.noticeId];
    if (notice && (notice.status === 'superseded' || notice.status === 'cancelled')) {
      return notice.status;
    }
  }

  // Superseded at movement level
  if (movement.supersededFlag) return 'superseded';

  // Warning: superseded by notice but movement not yet flagged
  if (movement.needsReview && movement.validationStatus === 'warning') return 'warning';

  return 'active';
}

/**
 * Check if a movement should be excluded from active occupancy calculations.
 */
function isMovementActiveForOccupancy(movement) {
  if (!movement) return false;
  if (movement.supersededFlag || movement.cancelledFlag) return false;
  if (movement.noticeId) {
    var notice = NoticeStore[movement.noticeId];
    if (notice && (notice.status === 'superseded' || notice.status === 'cancelled')) return false;
  }
  return true;
}

/**
 * Dump all supersession links for diagnostics.
 */
function dumpSupersessionLinks() {
  console.log('=== Supersession Links ===');
  console.log('Raw links:', _supersessionLinks);
  console.log('Notice statuses:');
  var nids = Object.keys(NoticeStore);
  for (var i = 0; i < nids.length; i++) {
    var n = NoticeStore[nids[i]];
    console.log('  ' + n.noticeNumber + ' → ' + n.status + (n.supersededByNoticeNumber ? ' (superseded by ' + n.supersededByNoticeNumber + ')' : ''));
  }
}

// ---- entity constructors -------------------------------------------------

/**
 * Person
 * @param {string} name  — raw name from record
 * @param {object} meta  — existing metadata for this person (optional)
 */
function createPerson(name, meta) {
  meta = meta || {};
  var norm = normalisePersonName(name);
  var id = hashId(norm.toLowerCase());
  if (PersonStore[id]) {
    // merge metadata
    if (meta.nickname)  PersonStore[id].nickname  = meta.nickname;
    if (meta.notes)     PersonStore[id].notes     = meta.notes;
    if (meta.image)     PersonStore[id].image     = meta.image;
    return PersonStore[id];
  }
  var rank = deduceRankFromName(norm);
  PersonStore[id] = {
    personId:  id,
    name:      norm,
    nameRaw:   name,
    nickname:  meta.nickname  || '',
    notes:     meta.notes     || '',
    image:     meta.image     || '',
    contactUrl: buildDirectoryUrlForPerson(norm, ''),
    inferredRank:  rank,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  return PersonStore[id];
}

function buildDirectoryUrlForPerson(name, dept) {
  var clean = (name || '').replace(/^(Miss|Ms|Mr\.?|Mrs|Dr\.?|Madam)\s+/i, '')
    .replace(/\((Miss|Ms|Mr|Mrs|Dr|Madam)\)/gi, '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  var url = 'https://www.directory.gov.hk/basic_search2.jsp?fullname=' + encodeURIComponent(clean) + '&lang=eng';
  if (dept) url += '&ou=' + encodeURIComponent('ou=' + dept);
  return url;
}

function deduceRankFromName(name) {
  var m = (name || '').match(/^(Miss|Ms|Mr\.?|Mr|Mrs|Dr\.?|Dr|Madam)\b/i);
  return m ? m[1].replace(/\.$/, '') : 'Unknown';
}

/**
 * Post  (job title)
 */
function createPost(title) {
  var norm = normalisePostTitle(title);
  if (!norm) return null;
  var id = hashId(norm.toLowerCase());
  if (PostStore[id]) return PostStore[id];
  PostStore[id] = {
    postId:      id,
    title:       norm,
    titleRaw:    title,
    rankGroup:   classifyRank(norm),
    roleNote:    '',
    createdAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString()
  };
  return PostStore[id];
}

var RANK_ORDER = ['C', 'PSO', 'CSO', 'SSO', 'SO', 'ASO'];

function classifyRank(title) {
  var s = (title || '').trim();
  for (var i = 0; i < RANK_ORDER.length; i++) {
    if (s === RANK_ORDER[i] || s.indexOf(RANK_ORDER[i] + '(') === 0 || s.indexOf(RANK_ORDER[i] + ' ') === 0) {
      return RANK_ORDER[i];
    }
  }
  return 'OTHER';
}

/**
 * Department
 */
function createDept(name) {
  var norm = normaliseDeptName(name);
  if (!norm) return null;
  var id = hashId(norm.toLowerCase());
  if (DeptStore[id]) return DeptStore[id];
  DeptStore[id] = {
    deptId:      id,
    name:        norm,
    nameRaw:     name,
    parentDeptId: '',
    createdAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString()
  };
  return DeptStore[id];
}

/**
 * PostingNotice
 */
function createNotice(pnRaw, sourceFile) {
  var parsed = extractNoticeNumber(pnRaw);
  var id = parsed.serial ? hashId(parsed.serial) : hashId(pnRaw || 'unknown');
  if (NoticeStore[id]) {
    if (sourceFile && !NoticeStore[id].sourceFile) NoticeStore[id].sourceFile = sourceFile;
    return NoticeStore[id];
  }
  NoticeStore[id] = {
    noticeId:    id,
    noticeNumber: pnRaw,
    serial:      parsed.serial,
    issuedMonth: parsed.number,
    issuedYear:  parsed.year,
    sourceFile:  sourceFile || '',
    status:      'active',        // active | superseded | cancelled | withdrawn
    reviewStatus:'unreviewed',    // unreviewed | reviewed | flagged
    supersededByNoticeId:   '',
    supersededByNoticeNumber:'',
    supersedesNoticeIds:    [],
    createdAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString()
  };
  return NoticeStore[id];
}

/**
 * PostingMovement  — the core event entity
 */
function createMovement(flatRec, sourceType) {
  sourceType = sourceType || 'manual';

  var person     = createPerson(flatRec.name,  { nickname: personNicknames[flatRec.name], notes: personNotes[flatRec.name], image: personImages[flatRec.name] });
  var fromPost   = flatRec.from_post ? createPost(flatRec.from_post) : null;
  var fromDept   = flatRec.from_dept ? createDept(flatRec.from_dept) : null;
  var toPost     = flatRec.to_post   ? createPost(flatRec.to_post)   : null;
  var toDept     = flatRec.to_dept   ? createDept(flatRec.to_dept)   : null;
  var notice     = createNotice(flatRec.posting_notice, '');

  var dateKey = parseDateToKey(flatRec.date);
  var seed = person.personId + (fromPost ? fromPost.postId : '') + (toPost ? toPost.postId : '') + dateKey + notice.noticeId;
  var movementId = hashId(seed);

  // check for duplicates
  for (var i = 0; i < MovementStore.length; i++) {
    if (MovementStore[i].movementId === movementId) {
      // update existing
      return updateMovementFromFlat(MovementStore[i], flatRec, sourceType);
    }
  }

  var remarkMeta = typeof parsePostingRemark === 'function'
    ? parsePostingRemark(flatRec.remark || '')
    : parseRemark(flatRec.remark || '');
  var validation = validateMovement(flatRec);

  var valStatus = 'ok';
  if (validation.hasErrors) {
    valStatus = 'error';
  } else if (!validation.valid) {
    valStatus = 'warning';
  }

  var mov = {
    movementId:           movementId,
    personId:             person.personId,
    fromPostId:           fromPost ? fromPost.postId : '',
    fromDeptId:           fromDept ? fromDept.deptId : '',
    toPostId:             toPost ? toPost.postId : '',
    toDeptId:             toDept ? toDept.deptId : '',
    effectiveDate:        flatRec.date || '',
    effectiveDateKey:     dateKey,
    noticeId:             notice.noticeId,
    remark:               flatRec.remark || '',
    parsedRemarkType:     remarkMeta.primaryRemarkType || remarkMeta.type || 'general',
    parsedFlags:          remarkMeta.parsedFlags || remarkMeta.flags || [],
    linkedViceName:       remarkMeta.linkedViceName       || '',
    linkedPnReference:    remarkMeta.linkedPnReference    || '',
    attachmentFlag:       remarkMeta.attachmentFlag       || false,
    temporaryPostFlag:    remarkMeta.temporaryPostFlag    || false,
    redeployedFlag:       remarkMeta.redeployedFlag       || false,
    retitledFlag:         remarkMeta.retitledFlag         || false,
    supersededFlag:       remarkMeta.supersededFlag       || false,
    cancelledFlag:        remarkMeta.cancelledFlag        || false,
    parserConfidence:     remarkMeta.parserConfidence     || 'low',
    needsReview:          remarkMeta.needsReview          || false,
    supersedesMovementId: '',
    supersededByMovementId: '',
    sourceType:           sourceType,
    reviewStatus:         'unreviewed',
    validationStatus:     valStatus,
    validationIssues:     validation.issues,
    createdAt:            new Date().toISOString(),
    updatedAt:            new Date().toISOString()
  };

  MovementStore.push(mov);
  return mov;
}

function updateMovementFromFlat(existing, flatRec, sourceType) {
  existing.remark = flatRec.remark || existing.remark;
  var meta = typeof parsePostingRemark === 'function'
    ? parsePostingRemark(flatRec.remark || '')
    : parseRemark(flatRec.remark || '');
  existing.parsedRemarkType  = meta.primaryRemarkType || meta.type || existing.parsedRemarkType;
  existing.parsedFlags       = meta.parsedFlags       || meta.flags || existing.parsedFlags;
  existing.linkedViceName    = meta.linkedViceName    || existing.linkedViceName    || '';
  existing.linkedPnReference = meta.linkedPnReference || existing.linkedPnReference || '';
  existing.attachmentFlag    = meta.attachmentFlag    || existing.attachmentFlag    || false;
  existing.temporaryPostFlag = meta.temporaryPostFlag || existing.temporaryPostFlag || false;
  existing.redeployedFlag    = meta.redeployedFlag    || existing.redeployedFlag    || false;
  existing.retitledFlag      = meta.retitledFlag      || existing.retitledFlag      || false;
  existing.supersededFlag    = meta.supersededFlag    || existing.supersededFlag    || false;
  existing.cancelledFlag     = meta.cancelledFlag     || existing.cancelledFlag     || false;
  existing.parserConfidence  = meta.parserConfidence  || existing.parserConfidence  || 'low';
  existing.needsReview       = meta.needsReview       || existing.needsReview       || false;
  existing.sourceType = sourceType || existing.sourceType;
  existing.updatedAt = new Date().toISOString();
  return existing;
}

// ---- remark parser -------------------------------------------------------

/**
 * Parse structured information from the free-text remark field.
 *
 * Delegates to the robust remark-parser.js and maps
 * the rich output back to the legacy { type, flags } format
 * for backward compatibility within the canonical model.
 *
 * For full structured output use parsePostingRemark() directly.
 */
function parseRemark(remark) {
  if (typeof parsePostingRemark === 'function') {
    var parsed = parsePostingRemark(remark);
    return {
      type:  parsed.primaryRemarkType || 'general',
      flags: parsed.parsedFlags || []
    };
  }
  // fallback if remark-parser.js is not loaded
  var text = (remark || '').trim().toLowerCase();
  var result = { type: 'general', flags: [] };
  if (!text) return result;
  if (/\bacting\b|\(acting\)/.test(text)) result.type = 'acting';
  if (/\bpromotion\b|升職/.test(text))   result.flags.push('promotion');
  if (/\btransfer\b|調任/.test(text))    result.flags.push('transfer');
  return result;
}

// ---- admin override tracking ----------------------------------------------

var adminOverrides = (function() {
  try { return JSON.parse(localStorage.getItem('sys_admin_overrides_pro') || '{}'); }
  catch(e) { return {}; }
})();

function setAdminOverride(index, value) {
  adminOverrides[index] = value;
  try { localStorage.setItem('sys_admin_overrides_pro', JSON.stringify(adminOverrides)); } catch(e) {}
}

function clearAdminOverrides() {
  adminOverrides = {};
  try { localStorage.setItem('sys_admin_overrides_pro', '{}'); } catch(e) {}
}

// ---- movement validator ---------------------------------------------------

/**
 * Enterprise-grade validation of a movement record.
 * Delegates to validation-engine.js if available, otherwise uses built-in logic.
 * Returns { valid: boolean, issues: string[], severity: string, hasErrors: boolean }.
 */
function validateMovement(rec) {
  var allRecords = typeof records !== 'undefined' ? records : [];
  if (typeof validateMovementV2 === 'function') {
    return validateMovementV2(rec, allRecords);
  }

  // built-in fallback validation (single-record only)
  var issues = [];
  if (!rec.name || rec.name.trim() === '')           issues.push('[R01] missing name');
  if (!rec.to_post || rec.to_post.trim() === '')     issues.push('[R04] missing to_post');
  if (!rec.to_dept || rec.to_dept.trim() === '')     issues.push('[R05] missing to_dept');
  if (!rec.date || rec.date.trim() === '')           issues.push('[R02] missing date');
  if (!rec.posting_notice || rec.posting_notice.trim() === '') issues.push('[R03] missing posting_notice');
  if (rec.posting_notice && /^\d{4}-\d{2}-\d{2}T/.test(rec.posting_notice))
    issues.push('[S01] PN No. may be a date (ISO format detected)');
  var dk = parseDateToKey(rec.date);
  if (dk && (dk < '20000101' || dk > '21000101'))
    issues.push('[S02] date out of plausible range: ' + rec.date);

  var hasErrors = issues.some(function(s) { return s.indexOf('[R0') === 0 || s.indexOf('[S01]') === 0; });
  return { valid: issues.length === 0, issues: issues, severity: hasErrors ? 'error' : (issues.length > 0 ? 'warning' : 'ok'), hasErrors: hasErrors };
}

// ---- migration layer: flat ↔ canonical -----------------------------------

/**
 * Seed canonical stores from the flat records array.
 * Called once on page load (idempotent).
 */
function seedCanonicalFromFlat(recordsArray) {
  if (!recordsArray) return;
  PersonStore = {}; PostStore = {}; DeptStore = {}; MovementStore = []; NoticeStore = {};
  for (var i = 0; i < recordsArray.length; i++) {
    createMovement(recordsArray[i], 'import');
  }
  resolveNoticeStatuses();
  applyMetadata();
}

/**
 * Apply existing metadata (nicknames, notes, images, roleNotes, postOverrides)
 * to the canonical stores after seeding.
 */
function applyMetadata() {
  // person nicknames, notes, images
  var allNames = new Set();
  for (var id in PersonStore) { allNames.add(PersonStore[id].name); }
  allNames.forEach(function(name) {
    if (personNicknames[name]) {
      var pid = hashId(normalisePersonName(name).toLowerCase());
      if (PersonStore[pid]) PersonStore[pid].nickname = personNicknames[name];
    }
    if (personNotes[name]) {
      var pid2 = hashId(normalisePersonName(name).toLowerCase());
      if (PersonStore[pid2]) PersonStore[pid2].notes = personNotes[name];
    }
    if (personImages[name]) {
      var pid3 = hashId(normalisePersonName(name).toLowerCase());
      if (PersonStore[pid3]) PersonStore[pid3].image = personImages[name];
    }
  });

  // role notes and post overrides
  for (var key in roleNotes) {
    var parts = key.split('||');
    var pid = hashId(normalisePostTitle(parts[0]).toLowerCase());
    if (PostStore[pid]) PostStore[pid].roleNote = roleNotes[key];
  }
}

/**
 * Export canonical movement store back to flat records array.
 * This is the inverse of seedCanonicalFromFlat.
 */
function exportCanonicalToFlat() {
  var flat = [];
  for (var i = 0; i < MovementStore.length; i++) {
    var m = MovementStore[i];
    var person     = PersonStore[m.personId];
    var fromPost   = PostStore[m.fromPostId];
    var fromDept   = DeptStore[m.fromDeptId];
    var toPost     = PostStore[m.toPostId];
    var toDept     = DeptStore[m.toDeptId];
    var notice     = NoticeStore[m.noticeId];

    flat.push({
      name:           person ? person.name : '',
      from_post:      fromPost ? fromPost.title : '',
      from_dept:      fromDept ? fromDept.name  : '',
      to_post:        toPost   ? toPost.title   : '',
      to_dept:        toDept   ? toDept.name    : '',
      date:           m.effectiveDate,
      remark:         m.remark,
      posting_notice: notice ? notice.noticeNumber : ''
    });
  }
  return flat;
}

/**
 * Sync canonical metadata back to the legacy global variables.
 */
function syncMetadataToLegacy() {
  for (var id in PersonStore) {
    var p = PersonStore[id];
    if (p.nickname) personNicknames[p.name] = p.nickname;
    if (p.notes)    personNotes[p.name]    = p.notes;
    if (p.image)    personImages[p.name]   = p.image;
  }
  localStorage.setItem('sys_person_nicknames_pro', JSON.stringify(personNicknames));
  localStorage.setItem('sys_person_notes_pro',     JSON.stringify(personNotes));
  localStorage.setItem('sys_person_images_pro',    JSON.stringify(personImages));

  for (var pid in PostStore) {
    var po = PostStore[pid];
    if (po.roleNote) {
      // roleNotes key is "post||dept" — we don't have dept info here,
      // so only sync if we can reconstruct the key.
      // For now, store by post-only key.
      if (po.title) roleNotes[po.title + '||'] = po.roleNote;
    }
  }
  localStorage.setItem('sys_role_notes_pro', JSON.stringify(roleNotes));
}

// ---- lookup / query helpers -----------------------------------------------

/**
 * Find movements by person name (case-insensitive).
 */
function findMovementsByPersonName(name) {
  var norm = normalisePersonName(name).toLowerCase();
  var pid = hashId(norm);
  return MovementStore.filter(function(m) { return m.personId === pid; });
}

/**
 * Find movements by role (to_post + to_dept).
 */
function findMovementsByRole(post, dept) {
  var pid = post ? hashId(normalisePostTitle(post).toLowerCase()) : '';
  var did = dept ? hashId(normaliseDeptName(dept).toLowerCase()) : '';
  return MovementStore.filter(function(m) {
    if (pid && m.toPostId !== pid) return false;
    if (did && m.toDeptId !== did) return false;
    return true;
  });
}

/**
 * Find movements by notice number.
 */
function findMovementsByNotice(pnRaw) {
  var parsed = extractNoticeNumber(pnRaw);
  var nid = parsed.serial ? hashId(parsed.serial) : hashId(pnRaw || '');
  return MovementStore.filter(function(m) { return m.noticeId === nid; });
}

/**
 * Get current post holder  (latest movement for a role).
 */
function getCurrentHolder(post, dept) {
  var movs = findMovementsByRole(post, dept)
    .filter(function(m) { return m.toPostId && m.toDeptId; })
    .sort(function(a, b) { return b.effectiveDateKey.localeCompare(a.effectiveDateKey); });
  if (movs.length === 0) return null;
  var latest = movs[0];
  return {
    person: PersonStore[latest.personId] || null,
    movement: latest
  };
}

/**
 * Get all unique departments as an array.
 */
function getAllDepts() {
  return Object.values(DeptStore).sort(function(a, b) { return a.name.localeCompare(b.name, 'en'); });
}

/**
 * Get all unique persons as an array.
 */
function getAllPersons() {
  return Object.values(PersonStore).sort(function(a, b) { return a.name.localeCompare(b.name, 'en'); });
}

/**
 * Get validation summary (uses full engine when available).
 */
function getValidationSummary() {
  if (typeof validateAllRecords === 'function' && typeof records !== 'undefined') {
    var full = validateAllRecords(records);
    var total   = full.summary.total;
    var ok      = full.summary.ok;
    var warn    = full.summary.warning;
    var err     = full.summary.error;
    var issues  = [];
    full.results.forEach(function(r) {
      if (r.issues && r.issues.length) {
        issues.push({
          index: r.index,
          person: records[r.index] ? records[r.index].name : '',
          issues: r.issues.map(function(i) { return '[' + i.ruleId + '] ' + i.message; }),
          severity: r.severity,
          overridden: r.overridden
        });
      }
    });
    return { total: total, ok: ok, warning: warn, error: err, errorsBlocking: full.errorsBlocking, unreviewed: MovementStore.filter(function(m) { return m.reviewStatus === 'unreviewed'; }).length, issues: issues };
  }

  var total   = MovementStore.length;
  var ok      = MovementStore.filter(function(m) { return m.validationStatus === 'ok'; }).length;
  var warn    = MovementStore.filter(function(m) { return m.validationStatus === 'warning'; }).length;
  var err     = MovementStore.filter(function(m) { return m.validationStatus === 'error'; }).length;
  var unreviewed = MovementStore.filter(function(m) { return m.reviewStatus === 'unreviewed'; }).length;
  var issues  = [];
  MovementStore.forEach(function(m) {
    if (m.validationIssues && m.validationIssues.length) {
      issues.push({ movementId: m.movementId, person: (PersonStore[m.personId]||{}).name, issues: m.validationIssues, severity: m.validationStatus });
    }
  });
  return { total: total, ok: ok, warning: warn, error: err, unreviewed: unreviewed, issues: issues, errorsBlocking: err };
}

// ---- lifecycle ------------------------------------------------------------

/**
 * Call after records array is loaded/changed to keep canonical stores in sync.
 * Pass the current records array.
 */
function syncCanonicalStores(recordsArray) {
  seedCanonicalFromFlat(recordsArray);
  syncMetadataToLegacy();
}

/**
 * Debug: dump all canonical stores to console.
 */
function dumpCanonical() {
  console.log('=== Canonical Data Model Dump ===');
  console.log('Persons:',     Object.keys(PersonStore).length,  PersonStore);
  console.log('Posts:',       Object.keys(PostStore).length,    PostStore);
  console.log('Departments:', Object.keys(DeptStore).length,    DeptStore);
  console.log('Movements:',   MovementStore.length,             MovementStore);
  console.log('Notices:',     Object.keys(NoticeStore).length,  NoticeStore);
  console.log('Validation:',  getValidationSummary());
}

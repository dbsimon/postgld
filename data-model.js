// ==========================================================================
//  Posting Manager — Canonical Data Model
// ==========================================================================

'use strict';

// ---- stable ID generator ------------------------------------------------

function hashId(str) {
  var h = 5381;
  for (var i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  if (h < 0) h = -h;
  return ('000000' + h.toString(36)).slice(-6);
}

// ---- normalisation helpers -----------------------------------------------

function normalisePersonName(name) {
  var n = (name || '').trim().replace(/\s+/g, ' ');
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
  var s = (raw || '').trim();
  var m = s.match(/^(\d{1,4})\s*\/\s*(\d{4})$/);
  if (m) {
    var num = parseInt(m[1], 10);
    var yr = parseInt(m[2], 10);
    return { number: num, year: yr, serial: String(num).padStart(4, '0') + '/' + yr };
  }
  return { number: 0, year: 0, serial: s || '' };
}

function parseDateToKey(dateStr) {
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

var PersonStore   = {};
var PostStore     = {};
var DeptStore     = {};
var MovementStore = [];
var NoticeStore   = {};

// ---- supersession links (admin-managed, notice-level legacy) --------------

var _supersessionLinks = (function() {
  try { return JSON.parse(localStorage.getItem('sys_supersession_links_pro') || '{}'); }
  catch(e) { return {}; }
})();

function _persistSupersessionLinks() {
  try { localStorage.setItem('sys_supersession_links_pro', JSON.stringify(_supersessionLinks)); } catch(e) {}
}

function _pnToNoticeId(pnRaw) {
  var parsed = extractNoticeNumber(pnRaw);
  return parsed.serial ? hashId(parsed.serial) : hashId((pnRaw || '').trim());
}

function registerNoticeSupersession(supersedingPn, supersededPn, linkedBy) {
  supersedingPn = (supersedingPn || '').trim();
  supersededPn  = (supersededPn || '').trim();
  if (!supersedingPn || !supersededPn || supersedingPn.replace(/\s+/g,'') === supersededPn.replace(/\s+/g,'')) return null;

  var sid = _pnToNoticeId(supersedingPn);
  var did = _pnToNoticeId(supersededPn);

  if (!_supersessionLinks[sid]) {
    _supersessionLinks[sid] = { supersededByNoticeId: '', supersedesNoticeIds: [], linkedAt: '', linkedBy: '' };
  }
  if (_supersessionLinks[sid].supersedesNoticeIds.indexOf(did) < 0) {
    _supersessionLinks[sid].supersedesNoticeIds.push(did);
  }
  _supersessionLinks[sid].linkedAt = new Date().toISOString();
  _supersessionLinks[sid].linkedBy = linkedBy || 'admin';

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

function unlinkNoticeSupersession(noticePn, noticeIdToRemove) {
  var nid = _pnToNoticeId(noticePn);
  if (!_supersessionLinks[nid]) return { deleted: false, removedEdges: 0, removedNoticeIds: [] };

  var removedEdges = 0;
  var removedNoticeIds = [];

  if (noticeIdToRemove) {
    var targetId = _pnToNoticeId(typeof noticeIdToRemove === 'string' ? noticeIdToRemove : '');
    var idx = (_supersessionLinks[nid].supersedesNoticeIds || []).indexOf(targetId);
    if (idx >= 0) {
      _supersessionLinks[nid].supersedesNoticeIds.splice(idx, 1);
      removedEdges++;
    }
    if (_supersessionLinks[targetId] && _supersessionLinks[targetId].supersededByNoticeId === nid) {
      _supersessionLinks[targetId].supersededByNoticeId = '';
      removedEdges++;
    }
  } else {
    var nids = Object.keys(_supersessionLinks);
    for (var i = 0; i < nids.length; i++) {
      var k = nids[i];
      if (_supersessionLinks[k].supersededByNoticeId === nid) {
        _supersessionLinks[k].supersededByNoticeId = '';
        removedEdges++;
        removedNoticeIds.push(k);
      }
      var sidx = (_supersessionLinks[k].supersedesNoticeIds || []).indexOf(nid);
      if (sidx >= 0) {
        _supersessionLinks[k].supersedesNoticeIds.splice(sidx, 1);
        removedEdges++;
      }
    }
    delete _supersessionLinks[nid];
    removedNoticeIds.push(nid);
    removedEdges++;
  }

  var allKeys = Object.keys(_supersessionLinks);
  for (var j = 0; j < allKeys.length; j++) {
    var k2 = allKeys[j];
    var link = _supersessionLinks[k2];
    if (!link.supersededByNoticeId && (!link.supersedesNoticeIds || link.supersedesNoticeIds.length === 0)) {
      delete _supersessionLinks[k2];
    }
  }

  _persistSupersessionLinks();
  resolveNoticeStatuses();

  return { deleted: true, removedEdges: removedEdges, removedNoticeIds: removedNoticeIds };
}

function isNoticeSupersededByAdmin(pnRaw) {
  var nid = _pnToNoticeId(pnRaw);
  if (_supersessionLinks[nid] && _supersessionLinks[nid].supersededByNoticeId) {
    var superById = _supersessionLinks[nid].supersededByNoticeId;
    return NoticeStore[superById] ? NoticeStore[superById].noticeNumber : superById;
  }
  return null;
}

function getSupersessionChain(pnRaw) {
  var nid = _pnToNoticeId(pnRaw);
  var chain = [nid];
  var cur = nid;
  while (_supersessionLinks[cur] && _supersessionLinks[cur].supersededByNoticeId) {
    cur = _supersessionLinks[cur].supersededByNoticeId;
    if (chain.indexOf(cur) >= 0) break;
    chain.push(cur);
  }
  cur = nid;
  var prefix = [];
  var visited = {};
  while (_supersessionLinks[cur]) {
    var supers = _supersessionLinks[cur].supersedesNoticeIds || [];
    for (var i = 0; i < supers.length; i++) {
      if (visited[supers[i]]) continue;
      visited[supers[i]] = true;
      prefix.unshift(supers[i]);
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

// ==========================================================================
//  Movement-level supersession (authoritative)
// ==========================================================================

var _movementSupersessionLinks = (function() {
  try { return JSON.parse(localStorage.getItem('sys_movement_supersession_links_pro') || '{}'); }
  catch(e) { return {}; }
})();

function _persistMovementSupersessionLinks() {
  try { localStorage.setItem('sys_movement_supersession_links_pro', JSON.stringify(_movementSupersessionLinks)); } catch(e) {}
}

function registerMovementSupersession(supersedingMovId, supersededMovId, linkedBy, note) {
  supersedingMovId = (supersedingMovId || '').trim();
  supersededMovId  = (supersededMovId  || '').trim();
  if (!supersedingMovId || !supersededMovId || supersedingMovId === supersededMovId) return null;

  var entry = _movementSupersessionLinks[supersededMovId] || {};
  entry.supersededByMovementId = supersedingMovId;
  entry.linkedAt = new Date().toISOString();
  entry.linkedBy = linkedBy || 'admin';
  entry.note = note || '';
  _movementSupersessionLinks[supersededMovId] = entry;

  _persistMovementSupersessionLinks();
  return { supersedingMovId: supersedingMovId, supersededMovId: supersededMovId };
}

function unlinkMovementSupersession(movementId) {
  movementId = (movementId || '').trim();
  if (_movementSupersessionLinks[movementId]) {
    delete _movementSupersessionLinks[movementId];
    _persistMovementSupersessionLinks();
    return true;
  }
  return false;
}

function isMovementSupersededByLink(movementId) {
  movementId = (movementId || '').trim();
  var link = _movementSupersessionLinks[movementId];
  if (link && link.supersededByMovementId) return link.supersededByMovementId;
  return null;
}

function migrateNoticeSupersessionToMovement() {
  var linksCreated = 0;
  var nids = Object.keys(_supersessionLinks);
  for (var i = 0; i < nids.length; i++) {
    var nid = nids[i];
    var sl = _supersessionLinks[nid];
    if (!sl.supersededByNoticeId) continue;
    var superNid = sl.supersededByNoticeId;
    var supersededMovs = MovementStore.filter(function(m) { return m.noticeId === nid; });
    var supersedingMovs = MovementStore.filter(function(m) { return m.noticeId === superNid; });
    for (var sm = 0; sm < supersededMovs.length; sm++) {
      var subMov = supersededMovs[sm];
      for (var sp = 0; sp < supersedingMovs.length; sp++) {
        var superMov = supersedingMovs[sp];
        if (subMov.toPostId === superMov.toPostId && subMov.toDeptId === superMov.toDeptId) {
          registerMovementSupersession(superMov.movementId, subMov.movementId, 'migration', 'Migrated from notice-level supersession');
          linksCreated++;
        }
      }
    }
  }
  if (linksCreated > 0) _persistMovementSupersessionLinks();
  return linksCreated;
}

function resolveNoticeStatuses() {
  var noticeIds = Object.keys(NoticeStore);

  for (var i = 0; i < noticeIds.length; i++) {
    NoticeStore[noticeIds[i]].status = 'valid';
    NoticeStore[noticeIds[i]].supersededByNoticeId = '';
    NoticeStore[noticeIds[i]].supersedesNoticeIds = [];
  }

  for (i = 0; i < noticeIds.length; i++) {
    var nid = noticeIds[i];
    var movs = MovementStore.filter(function(m) { return m.noticeId === nid; });
    if (movs.length === 0) continue;

    var totalCount = movs.length;
    var cancelledCount = 0, supersededCount = 0;

    for (var j = 0; j < movs.length; j++) {
      var m = movs[j];
      if (m.cancelledFlag) cancelledCount++;
      else if (m.supersededFlag || isMovementSupersededByLink(m.movementId)) supersededCount++;
    }

    var nonCancelledCount = totalCount - cancelledCount;

    if (cancelledCount === totalCount) {
      NoticeStore[nid].status = 'cancelled';
    } else if (nonCancelledCount > 0 && supersededCount === nonCancelledCount) {
      NoticeStore[nid].status = 'superseded';
    }
  }

  for (i = 0; i < noticeIds.length; i++) {
    var nnid = noticeIds[i];
    if (_supersessionLinks[nnid]) {
      var sl = _supersessionLinks[nnid];
      if (sl.supersededByNoticeId && NoticeStore[sl.supersededByNoticeId]) {
        NoticeStore[nnid].supersededByNoticeId = sl.supersededByNoticeId;
        NoticeStore[nnid].supersededByNoticeNumber = NoticeStore[sl.supersededByNoticeId].noticeNumber;
      }
      var supers = sl.supersedesNoticeIds || [];
      for (var k = 0; k < supers.length; k++) {
        if (NoticeStore[supers[k]] && NoticeStore[nnid].supersedesNoticeIds.indexOf(supers[k]) < 0) {
          NoticeStore[nnid].supersedesNoticeIds.push(supers[k]);
        }
      }
    }
  }
}

function getMovementStatus(movement) {
  if (!movement) return 'valid';

  var todayKey = (function() {
    var d = new Date();
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  })();
  if (movement.effectiveDateKey && movement.effectiveDateKey > todayKey) {
    return 'future';
  }

  if (movement.cancelledFlag) return 'cancelled';

  if (movement.movementId && isMovementSupersededByLink(movement.movementId)) {
    return 'superseded';
  }

  if (movement.supersededFlag) return 'superseded';

  if (movement.noticeId) {
    var notice = NoticeStore[movement.noticeId];
    if (notice && (notice.status === 'superseded' || notice.status === 'cancelled')) {
      return notice.status;
    }
  }

  if (movement.needsReview && movement.validationStatus === 'warning') return 'warning';

  return 'valid';
}

function isMovementActiveForOccupancy(movement) {
  if (!movement) return false;
  if (movement.supersededFlag || movement.cancelledFlag) return false;
  if (movement.movementId && isMovementSupersededByLink(movement.movementId)) return false;
  if (movement.noticeId) {
    var notice = NoticeStore[movement.noticeId];
    if (notice && (notice.status === 'superseded' || notice.status === 'cancelled')) return false;
  }
  return true;
}

function dumpSupersessionLinks() {
  console.log('=== Supersession Links ===');
  console.log('Raw links:', _supersessionLinks);
  console.log('Movement links:', _movementSupersessionLinks);
  console.log('Notice statuses:');
  var nids = Object.keys(NoticeStore);
  for (var i = 0; i < nids.length; i++) {
    var n = NoticeStore[nids[i]];
    console.log('  ' + n.noticeNumber + ' → ' + n.status);
  }
}

// ---- entity constructors -------------------------------------------------

function createPerson(name, meta) {
  meta = meta || {};
  var norm = normalisePersonName(name);
  var id = hashId(norm.toLowerCase());
  if (PersonStore[id]) {
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
    status:      'valid',
    reviewStatus:'unreviewed',
    supersededByNoticeId:   '',
    supersededByNoticeNumber:'',
    supersedesNoticeIds:    [],
    createdAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString()
  };
  return NoticeStore[id];
}

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

  for (var i = 0; i < MovementStore.length; i++) {
    if (MovementStore[i].movementId === movementId) {
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

function parseRemark(remark) {
  if (typeof parsePostingRemark === 'function') {
    var parsed = parsePostingRemark(remark);
    return { type:  parsed.primaryRemarkType || 'general', flags: parsed.parsedFlags || [] };
  }
  var text = (remark || '').trim().toLowerCase();
  var result = { type: 'general', flags: [] };
  if (!text) return result;
  if (/\bacting\b|\(acting\)/.test(text)) result.type = 'acting';
  if (/\bpromotion\b/.test(text))   result.flags.push('promotion');
  if (/\btransfer\b/.test(text))    result.flags.push('transfer');
  return result;
}

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

function validateMovement(rec) {
  var allRecords = typeof records !== 'undefined' ? records : [];
  if (typeof validateMovementV2 === 'function') {
    return validateMovementV2(rec, allRecords);
  }
  var issues = [];
  if (!rec.name || rec.name.trim() === '')           issues.push('[R01] missing name');
  if (!rec.to_post || rec.to_post.trim() === '')     issues.push('[R04] missing to_post');
  if (!rec.to_dept || rec.to_dept.trim() === '')     issues.push('[R05] missing to_dept');
  if (!rec.date || rec.date.trim() === '')           issues.push('[R02] missing date');
  if (!rec.posting_notice || rec.posting_notice.trim() === '') issues.push('[R03] missing posting_notice');
  if (rec.posting_notice && /^\d{4}-\d{2}-\d{2}T/.test(rec.posting_notice))
    issues.push('[S01] PN No. may be a date');
  var dk = parseDateToKey(rec.date);
  if (dk && (dk < '20000101' || dk > '21000101'))
    issues.push('[S02] date out of plausible range: ' + rec.date);
  var hasErrors = issues.some(function(s) { return s.indexOf('[R0') === 0 || s.indexOf('[S01]') === 0; });
  return { valid: issues.length === 0, issues: issues, severity: hasErrors ? 'error' : (issues.length > 0 ? 'warning' : 'ok'), hasErrors: hasErrors };
}

// ---- migration layer ----------------------------------------------------

function seedCanonicalFromFlat(recordsArray) {
  if (!recordsArray) return;
  PersonStore = {}; PostStore = {}; DeptStore = {}; MovementStore = []; NoticeStore = {};
  for (var i = 0; i < recordsArray.length; i++) {
    createMovement(recordsArray[i], 'import');
  }
  resolveNoticeStatuses();
  applyMetadata();
}

function applyMetadata() {
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
  for (var key in roleNotes) {
    var parts = key.split('||');
    var pid = hashId(normalisePostTitle(parts[0]).toLowerCase());
    if (PostStore[pid]) PostStore[pid].roleNote = roleNotes[key];
  }
}

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
    if (po.roleNote && po.title) roleNotes[po.title + '||'] = po.roleNote;
  }
  localStorage.setItem('sys_role_notes_pro', JSON.stringify(roleNotes));
}

function findMovementsByPersonName(name) {
  var norm = normalisePersonName(name).toLowerCase();
  var pid = hashId(norm);
  return MovementStore.filter(function(m) { return m.personId === pid; });
}

function findMovementsByRole(post, dept) {
  var pid = post ? hashId(normalisePostTitle(post).toLowerCase()) : '';
  var did = dept ? hashId(normaliseDeptName(dept).toLowerCase()) : '';
  return MovementStore.filter(function(m) {
    if (pid && m.toPostId !== pid) return false;
    if (did && m.toDeptId !== did) return false;
    return true;
  });
}

function findMovementsByNotice(pnRaw) {
  var parsed = extractNoticeNumber(pnRaw);
  var nid = parsed.serial ? hashId(parsed.serial) : hashId(pnRaw || '');
  return MovementStore.filter(function(m) { return m.noticeId === nid; });
}

function getCurrentHolder(post, dept) {
  var movs = findMovementsByRole(post, dept)
    .filter(function(m) { return m.toPostId && m.toDeptId; })
    .sort(function(a, b) { return b.effectiveDateKey.localeCompare(a.effectiveDateKey); });
  if (movs.length === 0) return null;
  var latest = movs[0];
  return { person: PersonStore[latest.personId] || null, movement: latest };
}

function getAllDepts() {
  return Object.values(DeptStore).sort(function(a, b) { return a.name.localeCompare(b.name, 'en'); });
}

function getAllPersons() {
  return Object.values(PersonStore).sort(function(a, b) { return a.name.localeCompare(b.name, 'en'); });
}

function getValidationSummary() {
  if (typeof validateAllRecords === 'function' && typeof records !== 'undefined') {
    var full = validateAllRecords(records, { adminOverride: adminOverrides });
    var total   = full.summary.total;
    var ok      = full.summary.ok;
    var warn    = full.summary.warning;
    var err     = full.summary.error;
    var issues  = [];
    full.results.forEach(function(r) {
      if (r.issues && r.issues.length) {
        issues.push({ index: r.index, person: records[r.index] ? records[r.index].name : '', issues: r.issues.map(function(i) { return '[' + i.ruleId + '] ' + i.message; }), severity: r.severity, overridden: r.overridden });
      }
    });
    return { total: total, ok: ok, warning: warn, error: err, errorsBlocking: full.errorsBlocking, unreviewed: MovementStore.filter(function(m) { return m.reviewStatus === 'unreviewed'; }).length, issues: issues };
  }
  var total   = MovementStore.length;
  var ok      = MovementStore.filter(function(m) { return m.validationStatus === 'ok'; }).length;
  var warn    = MovementStore.filter(function(m) { return m.validationStatus === 'warning'; }).length;
  var err     = MovementStore.filter(function(m) { return m.validationStatus === 'error'; }).length;
  var unreviewed = MovementStore.filter(function(m) { return m.reviewStatus === 'unreviewed'; }).length;
  return { total: total, ok: ok, warning: warn, error: err, unreviewed: unreviewed, issues: [], errorsBlocking: err };
}

function syncCanonicalStores(recordsArray) {
  seedCanonicalFromFlat(recordsArray);
  syncMetadataToLegacy();
  _persistMovementSupersessionLinks();
}

function dumpCanonical() {
  console.log('=== Canonical Data Model Dump ===');
  console.log('Persons:',     Object.keys(PersonStore).length,  PersonStore);
  console.log('Posts:',       Object.keys(PostStore).length,    PostStore);
  console.log('Departments:', Object.keys(DeptStore).length,    DeptStore);
  console.log('Movements:',   MovementStore.length,             MovementStore);
  console.log('Notices:',     Object.keys(NoticeStore).length,  NoticeStore);
  console.log('Validation:',  getValidationSummary());
}

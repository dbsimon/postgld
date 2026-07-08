// ==========================================================================
//  Posting Manager — Enterprise Validation Engine  v1.0
// ==========================================================================
//  Provides comprehensive single-record and cross-record validation for
//  Posting Movements. Three-tier severity: ok | warning | error
//
//  Exports:
//    validateAllRecords(recordsArray) → { summary, results, errorsBlocking }
//    validateSingleInContext(rec, allRecords, indexInArray)
//    getValidationBadge(status) → { label, cssClass, icon }
//    VALIDATION_RULES  → array of rule descriptors (documentation)
// ==========================================================================

'use strict';

var VALIDATION_SEVERITY = { OK: 'ok', WARNING: 'warning', ERROR: 'error' };

// ---- validation rule registry (documentation) ------------------------------

var VALIDATION_RULES = [
  { id: 'R01', name: 'Required Name',       severity: 'error',   desc: 'Person name must be present and non-empty.' },
  { id: 'R02', name: 'Required Date',       severity: 'error',   desc: 'Effective date must be present and parseable.' },
  { id: 'R03', name: 'Required PN No.',     severity: 'error',   desc: 'Posting Notice number must be present.' },
  { id: 'R04', name: 'Required To Post',    severity: 'error',   desc: 'Destination post (To Post) must be present.' },
  { id: 'R05', name: 'Required To Dept',    severity: 'error',   desc: 'Destination department (To Dept) must be present.' },
  { id: 'S01', name: 'PN Date Lookalike',   severity: 'error',   desc: 'PN No. appears to be an ISO date string instead of a notice number.' },
  { id: 'S02', name: 'Date Plausibility',   severity: 'warning', desc: 'Effective date is outside plausible range (1997-01-01 to 2100-12-31).' },
  { id: 'S03', name: 'Date Format',          severity: 'warning', desc: 'Date does not follow DD.MM.YYYY format.' },
  { id: 'S04', name: 'PN Format',           severity: 'warning', desc: 'PN No. does not follow N/YYYY format.' },
  { id: 'C01', name: 'Duplicate Movement',  severity: 'error',   desc: 'Same person, same to-post, same date, same PN already exists.' },
  { id: 'C02', name: 'Person Same-Date Conflict', severity: 'error', desc: 'Same person has two or more movements on the same effective date.' },
  { id: 'C03', name: 'Post Multi-Holder Conflict', severity: 'error', desc: 'More than one person assigned to the same post on the same effective date.' },
  { id: 'C04', name: 'Supersession Chain',  severity: 'warning', desc: 'PN supersedes a prior PN that cannot be found in records.' },
  { id: 'C05', name: 'Circular Supersession', severity: 'error', desc: 'A PN supersedes another PN that in turn supersedes it (circular reference).' },
  { id: 'C06', name: 'Self-Superseding PN',  severity: 'error',  desc: 'A PN references itself as superseding.' },
  { id: 'C07', name: 'Superseded PN Still Active', severity: 'warning', desc: 'A PN marked as superseded still has non-superseded movements.' },
  { id: 'P01', name: 'Suspicious Name',     severity: 'warning', desc: 'Person name appears to contain only numeric or very short text.' }
];

// ---- helper: parse date key (mirrors parseDateToKey in data-model.js) ------

function valParseDateKey(dateStr) {
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

// ---- helper: normalize names / posts for dedup -----------------------------

function normalizeKey(str) {
  return (str || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// ---- single-record validation ----------------------------------------------

/**
 * Validate a single movement record in isolation (no cross-record checks).
 * @param {object} rec — flat record { name, from_post, from_dept, to_post, to_dept, date, remark, posting_notice }
 * @return {{ severity: string, issues: Array<{ ruleId, message, severity }> }}
 */
function validateSingleRecord(rec) {
  var issues = [];
  var highestSev = VALIDATION_SEVERITY.OK;

  function add(ruleId, message, severity) {
    issues.push({ ruleId: ruleId, message: message, severity: severity });
    if (severity === VALIDATION_SEVERITY.ERROR) highestSev = VALIDATION_SEVERITY.ERROR;
    else if (severity === VALIDATION_SEVERITY.WARNING && highestSev !== VALIDATION_SEVERITY.ERROR) highestSev = VALIDATION_SEVERITY.WARNING;
  }

  var name = (rec.name || '').trim();
  var date = (rec.date || '').trim();
  var pn   = (rec.posting_notice || '').trim();
  var toPost = (rec.to_post || '').trim();
  var toDept = (rec.to_dept || '').trim();
  var remark = (rec.remark || '').trim();

  // ---- R01: Required name -------------------------------------------------
  if (!name) {
    add('R01', 'Missing person name', VALIDATION_SEVERITY.ERROR);
  } else if (/^[\d\s.,;:]+$/.test(name) || name.length < 2) {
    add('P01', 'Suspicious person name: "' + name + '"', VALIDATION_SEVERITY.WARNING);
  }

  // ---- R02: Required date -------------------------------------------------
  if (!date) {
    add('R02', 'Missing effective date', VALIDATION_SEVERITY.ERROR);
  } else {
    var dk = valParseDateKey(date);
    if (!dk || dk.length < 8) {
      add('S03', 'Date format not recognized (expect DD.MM.YYYY): "' + date + '"', VALIDATION_SEVERITY.WARNING);
    } else if (!/^\d{8}$/.test(dk)) {
      add('S03', 'Date could not be parsed to YYYYMMDD: "' + date + '"', VALIDATION_SEVERITY.WARNING);
    } else {
      if (dk < '19970101' || dk > '21001231') {
        add('S02', 'Date out of plausible range (1997–2100): "' + date + '"', VALIDATION_SEVERITY.WARNING);
      }
    }
  }

  // ---- R03: Required PN No. -----------------------------------------------
  if (!pn) {
    add('R03', 'Missing PN No.', VALIDATION_SEVERITY.ERROR);
  } else if (/^\d{4}-\d{2}-\d{2}T/.test(pn)) {
    add('S01', 'PN No. appears to be an ISO date string instead of a notice number: "' + pn + '"', VALIDATION_SEVERITY.ERROR);
  } else if (!/^\d{1,4}\s*\/\s*\d{4}$/.test(pn)) {
    add('S04', 'PN No. does not follow N/YYYY format: "' + pn + '"', VALIDATION_SEVERITY.WARNING);
  }

  // ---- R04/R05: Required destination --------------------------------------
  if (!toPost) {
    add('R04', 'Missing destination post (To Post)', VALIDATION_SEVERITY.ERROR);
  }
  if (!toDept) {
    add('R05', 'Missing destination department (To Dept)', VALIDATION_SEVERITY.ERROR);
  }

  return { severity: highestSev, issues: issues };
}

// ---- cross-record validation helpers ---------------------------------------

/**
 * Build an index of records for fast lookup.
 */
function buildRecordIndex(records) {
  var idx = {
    byPersonDate: {},      // "normalizedName||dateKey" → [record indices]
    byPostDate: {},         // "normalizedPost||normalizedDept||dateKey" → [record indices]
    bySignature: {},        // "normalizedName||normalizedPost||normalizedDept||dateKey||pn" → record index
    pnSet: {},              // pn → { records: [indices], supersededBy: [], supersedes: [] }
    all: records
  };

  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    var nk = normalizeKey(r.name || '');
    var pk = normalizeKey(r.to_post || '');
    var dk = normalizeKey(r.to_dept || '');
    var dateK = valParseDateKey(r.date || '');
    var pn  = (r.posting_notice || '').trim();

    // by person + date
    var pdKey = nk + '||' + dateK;
    if (!idx.byPersonDate[pdKey]) idx.byPersonDate[pdKey] = [];
    idx.byPersonDate[pdKey].push(i);

    // by post + date
    var pdKey2 = pk + '||' + dk + '||' + dateK;
    if (!idx.byPostDate[pdKey2]) idx.byPostDate[pdKey2] = [];
    idx.byPostDate[pdKey2].push(i);

    // by signature
    var sig = nk + '||' + pk + '||' + dk + '||' + dateK + '||' + pn.toLowerCase();
    idx.bySignature[sig] = i;

    // by PN
    if (pn && !idx.pnSet[pn]) idx.pnSet[pn] = { records: [], supersededBy: [], supersedes: [] };
    if (pn) idx.pnSet[pn].records.push(i);
  }

  // index supersession references from remarks
  for (i = 0; i < records.length; i++) {
    var rec = records[i];
    var rem = (rec.remark || '').trim().toLowerCase();
    var pn = (rec.posting_notice || '').trim();
    if (!pn) continue;

    // extract PN references from remark (e.g. "supersedes PN 3/2026")
    var pnRefs = [];
    var pnRE = /(\d{1,4}\s*\/\s*\d{4})/g;
    var match;
    while ((match = pnRE.exec(rem)) !== null) {
      var refPn = match[1].replace(/\s+/g, '');
      if (refPn !== pn.replace(/\s+/g, '')) pnRefs.push(refPn);
    }

    if (pnRefs.length > 0) {
      var isSuper = /\bsupersede|replaced\s+by|amended\s+by|cancels?\b/i.test(rem);
      var isSuperBy = /\bsupersede\b/i.test(rem) && /\bby\b/i.test(rem);

      for (var j = 0; j < pnRefs.length; j++) {
        var ref = pnRefs[j];
        if (!idx.pnSet[ref]) idx.pnSet[ref] = { records: [], supersededBy: [], supersedes: [] };
        if (isSuper || isSuperBy) {
          idx.pnSet[pn].supersedes.push(ref);
          idx.pnSet[ref].supersededBy.push(pn);
        }
      }
    }

    // Also incorporate admin-defined supersession links from data-model.js
    if (typeof _supersessionLinks === 'object' && _supersessionLinks[pn.replace(/\s+/g, '')]) {
      var pnClean = pn.replace(/\s+/g, '');
      var link = _supersessionLinks[pnClean];
      if (link.supersededByNoticeId && NoticeStore[link.supersededByNoticeId]) {
        var superByPn = NoticeStore[link.supersededByNoticeId].noticeNumber.replace(/\s+/g, '');
        if (!idx.pnSet[pnClean]) idx.pnSet[pnClean] = { records: [], supersededBy: [], supersedes: [] };
        if (idx.pnSet[pnClean].supersededBy.indexOf(superByPn) < 0) {
          idx.pnSet[pnClean].supersededBy.push(superByPn);
        }
        if (!idx.pnSet[superByPn]) idx.pnSet[superByPn] = { records: [], supersededBy: [], supersedes: [] };
        if (idx.pnSet[superByPn].supersedes.indexOf(pnClean) < 0) {
          idx.pnSet[superByPn].supersedes.push(pnClean);
        }
      }
      if (link.supersedesNoticeIds && link.supersedesNoticeIds.length > 0) {
        for (var sk = 0; sk < link.supersedesNoticeIds.length; sk++) {
          var sNid = link.supersedesNoticeIds[sk];
          if (NoticeStore[sNid]) {
            var sPn = NoticeStore[sNid].noticeNumber.replace(/\s+/g,'');
            if (!idx.pnSet[pnClean]) idx.pnSet[pnClean] = { records: [], supersededBy: [], supersedes: [] };
            if (idx.pnSet[pnClean].supersedes.indexOf(sPn) < 0) {
              idx.pnSet[pnClean].supersedes.push(sPn);
            }
            if (!idx.pnSet[sPn]) idx.pnSet[sPn] = { records: [], supersededBy: [], supersedes: [] };
            if (idx.pnSet[sPn].supersededBy.indexOf(pnClean) < 0) {
              idx.pnSet[sPn].supersededBy.push(pnClean);
            }
          }
        }
      }
    }
  }

  return idx;
}

/**
 * Validate all records including cross-record conflict detection.
 * @param {Array} records — flat records array
 * @param {Object} options — { adminOverride: Set of record indices to skip }
 * @return {{ summary: object, results: Array<{ index, severity, issues }>, errorsBlocking: int }}
 */
function validateAllRecords(records, options) {
  options = options || {};
  var adminOverrideRaw = options.adminOverride || {};

  // Normalize override keys to strings for bulletproof access
  var adminOverride = {};
  var overrideKeys = Object.keys(adminOverrideRaw);
  for (var oi = 0; oi < overrideKeys.length; oi++) {
    var ok = overrideKeys[oi];
    if (adminOverrideRaw[ok]) adminOverride[String(ok)] = true;
  }

  if (!records || records.length === 0) {
    return { summary: { total: 0, ok: 0, warning: 0, error: 0 }, results: [], errorsBlocking: 0 };
  }

  var idx = buildRecordIndex(records);
  var results = [];
  var summary = { total: records.length, ok: 0, warning: 0, error: 0 };
  var errorsBlocking = 0;
  var supersededPns = {};

  for (var i = 0; i < records.length; i++) {
    var rec = records[i];
    var single = validateSingleRecord(rec);
    var issues = single.issues.slice();

    // if adminOverride is set for this index, downgrade errors to warnings
    var isOverridden = adminOverride[i] === true;

    // ---- C01: Duplicate movement detection --------------------------------
    // Check if another record has the same signature
    var nk = normalizeKey(rec.name || '');
    var pk = normalizeKey(rec.to_post || '');
    var dk = normalizeKey(rec.to_dept || '');
    var dateK = valParseDateKey(rec.date || '');
    var pn  = (rec.posting_notice || '').trim().toLowerCase();
    var sig = nk + '||' + pk + '||' + dk + '||' + dateK + '||' + pn;

    if (idx.bySignature[sig] !== undefined && idx.bySignature[sig] !== i) {
      issues.push({ ruleId: 'C01', message: 'Duplicate movement: same person, post, date, and PN as record #' + (idx.bySignature[sig] + 1), severity: VALIDATION_SEVERITY.ERROR });
    }

    // ---- C02: Person same-date conflict -----------------------------------
    var pdKey = nk + '||' + dateK;
    var sameDayRecs = idx.byPersonDate[pdKey] || [];
    if (sameDayRecs.length > 1) {
      var postsOnDate = {};
      for (var s = 0; s < sameDayRecs.length; s++) {
        var si = sameDayRecs[s];
        var sp = normalizeKey(records[si].to_post || '') + '||' + normalizeKey(records[si].to_dept || '');
        postsOnDate[sp] = true;
      }
      if (Object.keys(postsOnDate).length > 1) {
        // Check if this is a supersession — one PN supersedes another with same person+date
        var isSupersessionConflict = _isSupersessionResolution(sameDayRecs, idx, records);
        if (isSupersessionConflict) {
          issues.push({ ruleId: 'C02', message: 'Person "' + rec.name + '" has ' + sameDayRecs.length + ' movements on ' + rec.date + ' to different posts — resolved by supersession', severity: VALIDATION_SEVERITY.WARNING, resolvedBy_ver: 'supersession' });
        } else {
          issues.push({ ruleId: 'C02', message: 'Person "' + rec.name + '" has ' + sameDayRecs.length + ' movements on ' + rec.date + ' to different posts', severity: VALIDATION_SEVERITY.ERROR });
        }
      }
    }

    // ---- C03: Post multi-holder conflict ----------------------------------
    var postDK = pk + '||' + dk + '||' + dateK;
    if (pk && dateK) {
      var postDayRecs = idx.byPostDate[postDK] || [];
      if (postDayRecs.length > 1) {
        var holdersOnDate = {};
        for (var p = 0; p < postDayRecs.length; p++) {
          var pi = postDayRecs[p];
          holdersOnDate[normalizeKey(records[pi].name || '')] = true;
        }
        if (Object.keys(holdersOnDate).length > 1) {
          // Check if this is a supersession — one PN supersedes another
          var isSupConflict = _isSupersessionResolution(postDayRecs, idx, records);
          if (isSupConflict) {
            issues.push({ ruleId: 'C03', message: 'Multiple persons assigned to "' + rec.to_post + '" (' + rec.to_dept + ') on ' + rec.date + ' — resolved by supersession', severity: VALIDATION_SEVERITY.WARNING, resolvedBy_ver: 'supersession' });
          } else {
            issues.push({ ruleId: 'C03', message: 'Multiple persons assigned to "' + rec.to_post + '" (' + rec.to_dept + ') on ' + rec.date, severity: VALIDATION_SEVERITY.ERROR });
          }
        }
      }
    }

    // ---- C04/C05/C06: Supersession chain validation -----------------------
    if (pn) {
      var pnData = idx.pnSet[pn.replace(/\s+/g, '')] || {};

      // Self-superseding check
      if (pnData.supersedes && pnData.supersedes.indexOf(pn.replace(/\s+/g, '')) >= 0) {
        issues.push({ ruleId: 'C06', message: 'PN ' + pn + ' references itself as superseding', severity: VALIDATION_SEVERITY.ERROR });
      }

      // Check if superseded PNs exist in records
      if (pnData.supersedes && pnData.supersedes.length > 0) {
        for (var sp = 0; sp < pnData.supersedes.length; sp++) {
          var sPn = pnData.supersedes[sp];
          if (!idx.pnSet[sPn] || idx.pnSet[sPn].records.length === 0) {
            issues.push({ ruleId: 'C04', message: 'PN ' + pn + ' supersedes PN ' + sPn + ' which is not in records', severity: VALIDATION_SEVERITY.WARNING });
          }
          // Mark the superseded PN
          supersededPns[sPn] = true;
        }
      }
    }

    // ---- Determine final severity -----------------------------------------
    var hasError = false;
    var hasWarning = false;
    for (var iss = 0; iss < issues.length; iss++) {
      if (issues[iss].severity === VALIDATION_SEVERITY.ERROR) hasError = true;
      if (issues[iss].severity === VALIDATION_SEVERITY.WARNING) hasWarning = true;
    }

    var finalSeverity;
    if (isOverridden) {
      finalSeverity = VALIDATION_SEVERITY.OK;
    } else if (hasError) {
      finalSeverity = VALIDATION_SEVERITY.ERROR;
    } else if (hasWarning) {
      finalSeverity = VALIDATION_SEVERITY.WARNING;
    } else {
      finalSeverity = VALIDATION_SEVERITY.OK;
    }

    // ---- C07: Superseded PN still active (second pass flag) ---------------
    if (pn && supersededPns[pn.replace(/\s+/g, '')]) {
      var isAdminResolved = (typeof isNoticeSupersededByAdmin === 'function') ? !!isNoticeSupersededByAdmin(pn) : false;
      var remarkMentions = /supersede|cancel|withdraw/i.test(rec.remark || '');
      if (remarkMentions) {
        issues.push({ ruleId: 'C07', message: 'PN ' + pn + ' is superseded — status acknowledged in remark', severity: VALIDATION_SEVERITY.OK });
      } else if (isAdminResolved) {
        var superBy = isNoticeSupersededByAdmin(pn);
        issues.push({ ruleId: 'C07', message: 'PN ' + pn + ' has been superseded by PN ' + superBy + ' (admin-confirmed)', severity: VALIDATION_SEVERITY.OK });
      } else {
        issues.push({ ruleId: 'C07', message: 'PN ' + pn + ' is superseded but movement has no supersession remark', severity: VALIDATION_SEVERITY.WARNING });
        if (!isOverridden && finalSeverity === VALIDATION_SEVERITY.OK) finalSeverity = VALIDATION_SEVERITY.WARNING;
      }
    }

    // Count — overridden records always count as ok regardless of finalSeverity
    if (isOverridden) {
      summary.ok++;
    } else if (finalSeverity === VALIDATION_SEVERITY.ERROR) {
      summary.error++;
      errorsBlocking++;
    } else if (finalSeverity === VALIDATION_SEVERITY.WARNING) {
      summary.warning++;
    } else {
      summary.ok++;
    }

    results.push({ index: i, severity: finalSeverity, issues: issues, overridden: isOverridden });
  }

  return { summary: summary, results: results, errorsBlocking: errorsBlocking };
}

/**
 * Validate a single record in context of all records.
 */
function validateSingleInContext(rec, allRecords, indexInArray) {
  if (indexInArray === undefined) indexInArray = allRecords ? allRecords.indexOf(rec) : -1;
  var result = validateAllRecords(allRecords);
  if (indexInArray >= 0 && indexInArray < result.results.length) {
    return result.results[indexInArray];
  }
  // fallback: just single-record validation
  return { index: indexInArray, severity: validateSingleRecord(rec).severity, issues: validateSingleRecord(rec).issues, overridden: false };
}

/**
 * Build a combined issues string for storage (semicolon-delimited).
 */
function formatValidationIssues(issues) {
  if (!issues || issues.length === 0) return '';
  return issues.map(function(iss) { return '[' + iss.ruleId + '] ' + iss.message; }).join('; ');
}

function _countableActiveIssues(issues) {
  if (!issues || issues.length === 0) return { error: 0, warning: 0 };
  var e = 0, w = 0;
  for (var i = 0; i < issues.length; i++) {
    if (issues[i].severity === VALIDATION_SEVERITY.ERROR) e++;
    else if (issues[i].severity === VALIDATION_SEVERITY.WARNING) w++;
  }
  return { error: e, warning: w };
}

/**
 * Get a human-readable badge descriptor for a validation status.
 */
function getValidationBadge(status) {
  if (status === VALIDATION_SEVERITY.ERROR) {
    return { label: 'ERROR', cssClass: 'val-err', icon: '✕', bgClass: 'bg-red-100', textClass: 'text-red-700', borderClass: 'border-red-200' };
  }
  if (status === VALIDATION_SEVERITY.WARNING) {
    return { label: 'WARNING', cssClass: 'val-warn', icon: '⚠', bgClass: 'bg-amber-100', textClass: 'text-amber-700', borderClass: 'border-amber-200' };
  }
  return { label: 'VALID', cssClass: 'val-ok', icon: '✓', bgClass: 'bg-emerald-100', textClass: 'text-emerald-700', borderClass: 'border-emerald-200' };
}

// ---- re-validate a single record within its movement store (for app.js) ----

/**
 * Quick function: re-validate a flat record against all records,
 * using the validation engine but returning the legacy { valid, issues, severity } shape.
 */
function validateMovementV2(rec, allRecords) {
  allRecords = allRecords || (typeof records !== 'undefined' ? records : []);
  var idx = allRecords.indexOf(rec);
  var result;
  if (idx >= 0) {
    var full = validateAllRecords(allRecords);
    result = full.results[idx];
  }
  if (!result || !result.issues) {
    var single = validateSingleRecord(rec);
    result = { index: idx, severity: single.severity, issues: single.issues, overridden: false };
  }
  var hasError = false;
  for (var i = 0; i < result.issues.length; i++) {
    if (result.issues[i].severity === VALIDATION_SEVERITY.ERROR) hasError = true;
  }
  return {
    valid: result.severity === VALIDATION_SEVERITY.OK,
    issues: result.issues ? result.issues.map(function(iss) { return '[' + iss.ruleId + '] ' + iss.message; }) : [],
    severity: result.severity,
    hasErrors: hasError
  };
}

// ---- supersession conflict resolution helper -------------------------------

/**
 * Check whether a list of conflicting record indices represents a
 * supersession relationship (one PN supersedes another), which
 * means the conflict is resolved and not a real data error.
 */
function _isSupersessionResolution(recordIndices, idx, records) {
  var hasAdminLink = false;
  var hasRemarkLink = false;

  // Collect PNs from the conflicting records
  var pns = [];
  for (var i = 0; i < recordIndices.length; i++) {
    var ri = recordIndices[i];
    var r = records[ri];
    var pn = (r.posting_notice || '').trim();
    if (pn) pns.push(pn);
  }

  // Check admin-defined links: does one PN supersede another?
  for (var a = 0; a < pns.length; a++) {
    var pa = pns[a].replace(/\s+/g, '');
    for (var b = a + 1; b < pns.length; b++) {
      var pb = pns[b].replace(/\s+/g, '');
      // Check data-model admin links
      if (typeof _supersessionLinks === 'object') {
        if (_supersessionLinks[pa] && _supersessionLinks[pa].supersedesNoticeIds.indexOf(hashId(pns[b])) >= 0) hasAdminLink = true;
        if (_supersessionLinks[pb] && _supersessionLinks[pb].supersedesNoticeIds.indexOf(hashId(pns[a])) >= 0) hasAdminLink = true;
        if (_supersessionLinks[pa] && _supersessionLinks[pa].supersededByNoticeId) {
          if (_supersessionLinks[pa].supersededByNoticeId === hashId(pns[b])) hasAdminLink = true;
        }
        if (_supersessionLinks[pb] && _supersessionLinks[pb].supersededByNoticeId) {
          if (_supersessionLinks[pb].supersededByNoticeId === hashId(pns[a])) hasAdminLink = true;
        }
      }
      // Check remark-based PN references
      var pnDataA = idx.pnSet[pa] || {};
      var pnDataB = idx.pnSet[pb] || {};
      if ((pnDataA.supersedes || []).indexOf(pb) >= 0) hasRemarkLink = true;
      if ((pnDataB.supersedes || []).indexOf(pa) >= 0) hasRemarkLink = true;
      if ((pnDataA.supersededBy || []).indexOf(pb) >= 0) hasRemarkLink = true;
      if ((pnDataB.supersededBy || []).indexOf(pa) >= 0) hasRemarkLink = true;
    }
  }

  return hasAdminLink || hasRemarkLink;
}

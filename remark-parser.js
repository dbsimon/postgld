// ==========================================================================
//  Posting Manager — Robust Remark Parser  v2.0
// ==========================================================================
//  Converts free-text posting remarks into structured business logic.
//
//  Input:   raw remark string from a Posting Notice
//  Output:  { primaryRemarkType, parsedFlags, linkedViceName,
//             linkedPnReference, attachmentFlag, temporaryPostFlag,
//             redeployedFlag, retitledFlag, supersededFlag,
//             cancelledFlag, parserConfidence, needsReview, rawRemark }
//
//  Usage:   var result = parsePostingRemark(remarkText);
// ==========================================================================

'use strict';

var REMARK_PATTERNS = {

  // ---- document-level overrides (check FIRST) ----------------------------

  superseded: [
    /\bsuperseded\b/i,
    /\bsupersedes\b/i,
    /\breplaced\s+by\b/i,
    /\bamended\s+by\b/i,
    /\bcancels?\b/i
  ],

  cancelled: [
    /\bcancelled\b/i,
    /\bcanceled\b/i,
    /\bwithdrawn\b/i,
    /\brescinded\b/i,
    /\bnull\s*and\s*void\b/i
  ],

  // ---- post-level mutations ----------------------------------------------

  retitled: [
    /\bpost\s+retitled\b/i,
    /\bretitled\b/i,
    /\brenamed\s+to\b/i,
    /\btitle\s+changed\b/i
  ],

  redeployed: [
    /\bpost\s+redeployed\b/i,
    /\bredeployed\b/i,
    /\bredeployment\b/i,
    /\btransferred\s+out\s+of\s+establishment\b/i
  ],

  // ---- explicit departures -----------------------------------------------

  transferOut: [
    /\btransfer\s+out\b/i,
    /\btransferred\s+out\b/i,
    /\bposted\s+out\b/i,
    /\btransferred\s+to\b/i,
    /\btransfer\s+to\b/i
  ],

  noPayLeave: [
    /\bno\s+pay\s+leave\b/i,
    /\bleave\s+without\s+pay\b/i,
    /\bnpl\b/i,
    /\bstudy\s+leave\b/i,
    /\bmaternity\s+leave\b/i,
    /\bsabbatical\b/i
  ],

  attachment: [
    /\bon\s+attachment\b/i,
    /\battachment\b/i,
    /\battached\s+to\b/i,
    /\bseconded\s+to\b/i,
    /\bsecondment\b/i,
    /\bon\s+secondment\b/i
  ],

  // ---- acting arrangements -----------------------------------------------

  ceaseActing: [
    /\bto\s+cease\s+acting\b/i,
    /\bcease\s+acting\b/i,
    /\bceases\s+to\s+act\b/i,
    /\bcease\s+to\s+act\b/i,
    /\brevert(?:s|ing)?\s+to\b/i,
    /\bno\s+longer\s+acting\b/i,
    /\brelinquish(?:es|ing)?\s+(?:the\s+)?acting\b/i
  ],

  continueActing: [
    /\bto\s+continue\s+acting\b/i,
    /\bcontinue\s+acting\b/i,
    /\bcontinues\s+to\s+act\b/i,
    /\bcontinue\s+to\s+act\b/i,
    /\bextension\s+of\s+acting\b/i,
    /\bprolong(?:ed|ing)?\s+acting\b/i
  ],

  acting: [
    /\bto\s+act\s+as\b/i,
    /\bacting\s+as\b/i,
    /\bacting\b/i,
    /\bto\s+act\b/i,
    /\b\(acting\)\b/i,
    /\bactg\b/i,
    /\bag\.\s*(?:appointment|post|capacity)\b/i
  ],

  // ---- filling posts -----------------------------------------------------

  fillNewPost: [
    /\bto\s+fill\s+(?:a\s+)?new\s+post\b/i,
    /\bfill\s+(?:a\s+)?new\s+post\b/i,
    /\bnew\s+post\b/i,
    /\bnewly\s+created\b/i,
    /\bnew\s+appointee\b/i
  ],

  fillVacantPost: [
    /\bto\s+fill\s+(?:a\s+)?vacant\s+post\b/i,
    /\bfill\s+(?:a\s+)?vacant\s+post\b/i,
    /\bvacant\s+post\b/i,
    /\bfill\s+(?:a\s+)?vacancy\b/i
  ],

  fillTemporaryPost: [
    /\bto\s+fill\s+(?:a\s+)?temporary\s+post\b/i,
    /\bfill\s+(?:a\s+)?temporary\s+post\b/i,
    /\btemporary\s+post\b/i,
    /\btemp\s+post\b/i
  ],

  // ---- vice ---------------------------------------------------------------

  vice: [
    /\bvice\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/,
    /\bvice\b/i,
    /\(vice\b/i,
    /\bfor\s+vice\b/i
  ],

  // ---- secondary flags ----------------------------------------------------

  promotion: [
    /\bpromotion\b/i,
    /\bpromoted\b/i,
    /\b升職\b/
  ],

  transfer: [
    /\btransfer\b/i,
    /\b調任\b/
  ],

  newAppointee: [
    /\bnew\s+appointee\b/i,
    /\bfirst\s+appointment\b/i,
    /\binitial\s+appointment\b/i
  ],

  retirement: [
    /\bretirement\b/i,
    /\bretire[sd]?\b/i,
    /\b退休\b/
  ],

  leave: [
    /\bleave\b/i,
    /\b休假\b/
  ],

  substantive: [
    /\bsubstantive\b/i,
    /\b實任\b/
  ],

  temporary: [
    /\btemporary\b/i,
    /\b暫任\b/
  ]
};

// ---- primary-type detection (checked in priority order) --------------------

var TYPE_DETECTORS = [
  { type: 'superseded',         pattern: REMARK_PATTERNS.superseded         },
  { type: 'cancelled',          pattern: REMARK_PATTERNS.cancelled          },
  { type: 'retitled',           pattern: REMARK_PATTERNS.retitled           },
  { type: 'redeployed',         pattern: REMARK_PATTERNS.redeployed         },
  { type: 'transfer-out',       pattern: REMARK_PATTERNS.transferOut        },
  { type: 'no-pay-leave',       pattern: REMARK_PATTERNS.noPayLeave         },
  { type: 'attachment',         pattern: REMARK_PATTERNS.attachment         },
  { type: 'cease-acting',       pattern: REMARK_PATTERNS.ceaseActing        },
  { type: 'continue-acting',    pattern: REMARK_PATTERNS.continueActing     },
  { type: 'acting',             pattern: REMARK_PATTERNS.acting             },
  { type: 'fill-new-post',      pattern: REMARK_PATTERNS.fillNewPost        },
  { type: 'fill-vacant-post',   pattern: REMARK_PATTERNS.fillVacantPost     },
  { type: 'fill-temporary-post',pattern: REMARK_PATTERNS.fillTemporaryPost  }
];

// ---- flag detectors (multiple flags can match) ----------------------------

var FLAG_DETECTORS = [
  { flag: 'vice',             pattern: REMARK_PATTERNS.vice             },
  { flag: 'promotion',        pattern: REMARK_PATTERNS.promotion        },
  { flag: 'transfer',         pattern: REMARK_PATTERNS.transfer         },
  { flag: 'new-appointee',    pattern: REMARK_PATTERNS.newAppointee     },
  { flag: 'retirement',       pattern: REMARK_PATTERNS.retirement       },
  { flag: 'leave',            pattern: REMARK_PATTERNS.leave            },
  { flag: 'substantive',      pattern: REMARK_PATTERNS.substantive      },
  { flag: 'temporary',        pattern: REMARK_PATTERNS.temporary        }
];

// ---- main parser ----------------------------------------------------------

/**
 * Parse a free-text posting remark into structured fields.
 *
 * @param {string} rawRemark  — original remark text from a Posting Notice
 * @return {object}           — structured parse result
 */
function parsePostingRemark(rawRemark) {
  var result = {
    rawRemark:           rawRemark || '',
    primaryRemarkType:   'general',
    parsedFlags:         [],
    linkedViceName:      '',
    linkedPnReference:   '',
    attachmentFlag:      false,
    temporaryPostFlag:   false,
    redeployedFlag:      false,
    retitledFlag:        false,
    supersededFlag:      false,
    cancelledFlag:       false,
    parserConfidence:    'low',
    needsReview:         false,
    matchedPatterns:     []
  };

  var text = (rawRemark || '').trim();
  if (!text) {
    result.needsReview = false;
    return result;
  }

  // ---- 1. Detect primary type --------------------------------------------
  for (var i = 0; i < TYPE_DETECTORS.length; i++) {
    var detector = TYPE_DETECTORS[i];
    for (var j = 0; j < detector.pattern.length; j++) {
      if (detector.pattern[j].test(text)) {
        result.primaryRemarkType = detector.type;
        result.matchedPatterns.push(detector.type);
        // map to the boolean flags
        if (detector.type === 'superseded')          result.supersededFlag = true;
        if (detector.type === 'cancelled')           result.cancelledFlag  = true;
        if (detector.type === 'retitled')            result.retitledFlag   = true;
        if (detector.type === 'redeployed')          result.redeployedFlag = true;
        if (detector.type === 'fill-temporary-post') result.temporaryPostFlag = true;
        if (detector.type === 'attachment')          result.attachmentFlag = true;
        break;  // first type wins (priority order)
      }
    }
    if (result.primaryRemarkType !== 'general') break;
  }

  // ---- 2. Extract secondary flags ----------------------------------------
  for (var k = 0; k < FLAG_DETECTORS.length; k++) {
    var fd = FLAG_DETECTORS[k];
    for (var m = 0; m < fd.pattern.length; m++) {
      if (fd.pattern[m].test(text)) {
        if (result.parsedFlags.indexOf(fd.flag) === -1) {
          result.parsedFlags.push(fd.flag);
          result.matchedPatterns.push(fd.flag);
        }
        // secondary boolean mapping
        if (fd.flag === 'temporary')    result.temporaryPostFlag = true;
        if (fd.flag === 'leave')         result.leaveFlag         = true;  // internal
        break;
      }
    }
  }

  // ---- 3. Extract Vice nominee name --------------------------------------
  if (result.parsedFlags.indexOf('vice') !== -1) {
    result.linkedViceName = extractViceName(text);
  }

  // ---- 4. Extract linked PN reference ------------------------------------
  result.linkedPnReference = extractPnReference(text);

  // ---- 5. Compute confidence ---------------------------------------------
  result.parserConfidence = computeConfidence(result);

  // ---- 6. Determine if manual review is needed ---------------------------
  result.needsReview = determineReviewNeed(result);

  return result;
}

// ---- extraction helpers ---------------------------------------------------

function extractViceName(text) {
  // "Vice CHAN Tai-man" or "for Vice YAU Ho-yin" or "(Vice LAM Siu-ling)"
  var patterns = [
    /vice\s+((?:[A-Z][a-z]+(?:[- ][A-Z][a-z]+)*))/,
    /vice\s+((?:[A-Z]+(?:\s+[A-Z]+)*))/,
    /vice\s+((?:Miss|Ms|Mr\.?|Mrs|Dr\.?|Madam)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?:[- ][A-Z][a-z]+)*)/i
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = text.match(patterns[i]);
    if (m && m[1]) {
      return m[1].trim().replace(/\s+/g, ' ');
    }
  }
  return '';
}

function extractPnReference(text) {
  // "supersedes PN 3/2025" or "replaced by PN 8/2024" or "cancels PN 12/2023"
  var patterns = [
    /(?:supersedes?|replaced\s+by|amended\s+by|cancels?|see)\s+(?:PN|Posting\s+Notice)\s+(?:No\.?\s*)?(\d{1,4}\s*\/\s*\d{4})/i,
    /PN\s+(?:No\.?\s*)?(\d{1,4}\s*\/\s*\d{4})/i,
    /(?:supersedes?|replaced\s+by|amended\s+by|cancels?)\s+(\d{1,4}\s*\/\s*\d{4})/i
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = text.match(patterns[i]);
    if (m && m[1]) {
      // normalise to "3/2025" format (no spaces around /)
      return m[1].replace(/\s*\/\s*/, '/');
    }
  }
  return '';
}

// ---- confidence scoring ---------------------------------------------------

function computeConfidence(result) {
  var score = 0;

  // multiple matched patterns = higher confidence
  if (result.matchedPatterns.length >= 3) score += 3;
  else if (result.matchedPatterns.length >= 2) score += 2;
  else if (result.matchedPatterns.length >= 1) score += 1;

  // specific patterns are more reliable than generic ones
  var specificTypes = ['superseded', 'cancelled', 'retitled', 'redeployed',
                       'cease-acting', 'continue-acting', 'fill-new-post',
                       'fill-vacant-post', 'no-pay-leave'];
  if (specificTypes.indexOf(result.primaryRemarkType) !== -1) score += 2;

  // generic "acting" without specifics is lower confidence
  if (result.primaryRemarkType === 'acting' && result.parsedFlags.length === 0) score -= 1;

  // vice name extracted = strong signal
  if (result.linkedViceName) score += 1;

  // PN reference extracted = strong signal
  if (result.linkedPnReference) score += 1;

  if (score >= 4) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

function determineReviewNeed(result) {
  if (result.parserConfidence === 'low') return true;
  if (result.parserConfidence === 'medium' && result.primaryRemarkType === 'general') return true;

  // ambiguous combos: acting + promotion without clear primary type
  if (result.primaryRemarkType === 'acting' &&
      result.parsedFlags.indexOf('promotion') !== -1 &&
      result.matchedPatterns.length <= 2) return true;

  // vice without name extracted
  if (result.parsedFlags.indexOf('vice') !== -1 && !result.linkedViceName) return true;

  return false;
}

// ---- public helpers -------------------------------------------------------

/**
 * Returns human-readable label for a primary remark type.
 */
function labelForRemarkType(type) {
  var labels = {
    'superseded':          'Superseded',
    'cancelled':           'Cancelled',
    'retitled':            'Post Retitled',
    'redeployed':          'Post Redeployed',
    'transfer-out':        'Transfer Out',
    'no-pay-leave':        'No-Pay Leave',
    'attachment':          'On Attachment',
    'cease-acting':        'Cease Acting',
    'continue-acting':     'Continue Acting',
    'acting':              'Acting',
    'fill-new-post':       'Fill New Post',
    'fill-vacant-post':    'Fill Vacant Post',
    'fill-temporary-post': 'Fill Temporary Post',
    'general':             'General'
  };
  return labels[type] || type;
}

/**
 * Returns whether a parsed remark indicates the movement is "non-substantive"
 * (acting, temporary, attachment, etc.).
 */
function isNonSubstantive(parsed) {
  var nonSubTypes = ['acting', 'cease-acting', 'continue-acting',
                     'fill-temporary-post', 'attachment', 'no-pay-leave'];
  return nonSubTypes.indexOf(parsed.primaryRemarkType) !== -1 ||
         parsed.temporaryPostFlag ||
         parsed.attachmentFlag;
}

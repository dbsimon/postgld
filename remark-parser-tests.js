// ==========================================================================
//  Remark Parser — Test Suite
// ==========================================================================
//  Run in browser console or Node.js:
//    node remark-parser-tests.js     (if using Node)
//    or paste into console after loading remark-parser.js
// ==========================================================================

var TEST_CASES = [
  // ---- superseded / cancelled ----
  {
    remark: 'superseded by PN 3/2025',
    expected: { primaryRemarkType: 'superseded', supersededFlag: true, linkedPnReference: '3/2025', cancelledFlag: false }
  },
  {
    remark: 'This Notice supersedes PN 8/2024 with amendments.',
    expected: { primaryRemarkType: 'superseded', supersededFlag: true, linkedPnReference: '8/2024' }
  },
  {
    remark: 'Cancelled – position abolished.',
    expected: { primaryRemarkType: 'cancelled', cancelledFlag: true, supersededFlag: false }
  },
  {
    remark: 'Posting Notice is hereby withdrawn and null and void.',
    expected: { primaryRemarkType: 'cancelled', cancelledFlag: true }
  },
  {
    remark: 'This posting is rescinded effective immediately.',
    expected: { primaryRemarkType: 'cancelled', cancelledFlag: true }
  },

  // ---- post retitled / redeployed ----
  {
    remark: 'Post retitled from ASO(S)1 to ASO(S&P)1.',
    expected: { primaryRemarkType: 'retitled', retitledFlag: true, redeployedFlag: false }
  },
  {
    remark: 'Post redeployed to Establishment Division.',
    expected: { primaryRemarkType: 'redeployed', redeployedFlag: true, retitledFlag: false }
  },
  {
    remark: 'This position has been renamed to Senior Executive Officer (IT).',
    expected: { primaryRemarkType: 'retitled', retitledFlag: true }
  },

  // ---- transfer out ----
  {
    remark: 'Transfer out to Home Affairs Bureau.',
    expected: { primaryRemarkType: 'transfer-out', parsedFlags: ['transfer'] }
  },
  {
    remark: 'Transferred out of this department effective 1.7.2024.',
    expected: { primaryRemarkType: 'transfer-out' }
  },
  {
    remark: 'Posted out to the Civil Service Bureau on promotion.',
    expected: { primaryRemarkType: 'transfer-out', parsedFlags: ['transfer', 'promotion'] }
  },

  // ---- no-pay leave ----
  {
    remark: 'On no pay leave from 1.4.2024 to 30.9.2024.',
    expected: { primaryRemarkType: 'no-pay-leave', leaveFlag: true }
  },
  {
    remark: 'Leave without pay for personal reasons.',
    expected: { primaryRemarkType: 'no-pay-leave' }
  },
  {
    remark: 'Study leave (NPL) for one academic year.',
    expected: { primaryRemarkType: 'no-pay-leave' }
  },

  // ---- attachment / secondment ----
  {
    remark: 'On attachment to the Security Bureau.',
    expected: { primaryRemarkType: 'attachment', attachmentFlag: true }
  },
  {
    remark: 'Seconded to the Home and Youth Affairs Bureau.',
    expected: { primaryRemarkType: 'attachment', attachmentFlag: true }
  },
  {
    remark: 'On secondment to the Hong Kong Police Force.',
    expected: { primaryRemarkType: 'attachment', attachmentFlag: true }
  },

  // ---- cease acting ----
  {
    remark: 'To cease acting as Senior Executive Officer.',
    expected: { primaryRemarkType: 'cease-acting' }
  },
  {
    remark: 'Ceases to act as ASO(P&I) and reverts to ASO(S)1.',
    expected: { primaryRemarkType: 'cease-acting' }
  },
  {
    remark: 'Relinquishing the acting appointment of PSO.',
    expected: { primaryRemarkType: 'cease-acting'}
  },

  // ---- continue acting ----
  {
    remark: 'To continue acting as Chief Systems Manager.',
    expected: { primaryRemarkType: 'continue-acting' }
  },
  {
    remark: 'Extension of acting appointment of SEO for 6 months.',
    expected: { primaryRemarkType: 'continue-acting' }
  },

  // ---- acting (generic) ----
  {
    remark: 'To act as Assistant Director of Immigration.',
    expected: { primaryRemarkType: 'acting' }
  },
  {
    remark: 'Acting appointment of Mr CHAN Tai-man as SSO.',
    expected: { primaryRemarkType: 'acting' }
  },
  {
    remark: 'ag. capacity as SEO(IT).',
    expected: { primaryRemarkType: 'acting' }
  },

  // ---- vice ----
  {
    remark: 'To act as Vice CHAN Tai-man.',
    expected: { primaryRemarkType: 'acting', parsedFlags: ['vice'], linkedViceName: 'CHAN Tai-man' }
  },
  {
    remark: 'Acting for Vice YAU Ho-yin during her leave.',
    expected: { primaryRemarkType: 'acting', parsedFlags: ['vice', 'leave'], linkedViceName: 'YAU Ho-yin' }
  },
  {
    remark: '(Vice LAM Siu-ling) Acting appointment.',
    expected: { primaryRemarkType: 'acting', parsedFlags: ['vice'], linkedViceName: 'LAM Siu-ling' }
  },
  {
    remark: 'Vice Miss CHAN Mei-ling — acting as CSO.',
    expected: { primaryRemarkType: 'acting', parsedFlags: ['vice'], linkedViceName: 'Miss CHAN Mei-ling' }
  },

  // ---- fill new post ----
  {
    remark: 'To fill a new post of ASO in the IT Branch.',
    expected: { primaryRemarkType: 'fill-new-post', parsedFlags: ['new-appointee'] }
  },
  {
    remark: 'Newly created post under the Establishment Plan.',
    expected: { primaryRemarkType: 'fill-new-post' }
  },
  {
    remark: 'New appointee — first appointment to the Civil Service.',
    expected: { primaryRemarkType: 'fill-new-post', parsedFlags: ['new-appointee'] }
  },

  // ---- fill vacant post ----
  {
    remark: 'To fill a vacant post of Executive Officer.',
    expected: { primaryRemarkType: 'fill-vacant-post' }
  },
  {
    remark: 'Filling a vacancy left by the previous incumbent.',
    expected: { primaryRemarkType: 'fill-vacant-post' }
  },

  // ---- fill temporary post ----
  {
    remark: 'To fill a temporary post of ASO for project duties.',
    expected: { primaryRemarkType: 'fill-temporary-post', temporaryPostFlag: true, parsedFlags: ['temporary'] }
  },
  {
    remark: 'Temp post — duration 12 months.',
    expected: { primaryRemarkType: 'fill-temporary-post', temporaryPostFlag: true }
  },

  // ---- promotion ----
  {
    remark: 'Promotion from ASO to EO.',
    expected: { primaryRemarkType: 'acting', parsedFlags: ['promotion'] }
  },
  {
    remark: 'Transferred on promotion to SSO.',
    expected: { primaryRemarkType: 'transfer-out', parsedFlags: ['transfer', 'promotion'] }
  },

  // ---- retirement ----
  {
    remark: 'Retirement of Mr WONG after 30 years of service.',
    expected: { parsedFlags: ['retirement'] }
  },
  {
    remark: 'To fill a vacant post arising from the retirement of SEO.',
    expected: { primaryRemarkType: 'fill-vacant-post', parsedFlags: ['retirement'] }
  },

  // ---- substantive / temporary ----
  {
    remark: 'Substantive appointment of ASO.',
    expected: { parsedFlags: ['substantive'] }
  },
  {
    remark: 'Temporary posting until a permanent replacement is found.',
    expected: { primaryRemarkType: 'fill-temporary-post', temporaryPostFlag: true, parsedFlags: ['temporary'] }
  },

  // ---- general / low confidence ----
  {
    remark: 'Routine posting under the annual exercise.',
    expected: { primaryRemarkType: 'general', parserConfidence: 'low' }
  },
  {
    remark: '',
    expected: { primaryRemarkType: 'general', parserConfidence: 'low', needsReview: false }
  },
  {
    remark: 'Effective from 1.4.2024.',
    expected: { primaryRemarkType: 'general', parserConfidence: 'low' }
  },

  // ---- mixed / complex ----
  {
    remark: 'Acting promotion to PSO to fill temporary vacancy.',
    expected: { primaryRemarkType: 'fill-temporary-post', parsedFlags: ['promotion', 'temporary'], temporaryPostFlag: true }
  },
  {
    remark: 'To cease acting as SSO and revert to substantive rank of ASO.',
    expected: { primaryRemarkType: 'cease-acting', parsedFlags: ['substantive'] }
  },
  {
    remark: 'Transferred out on secondment to the Security Bureau.',
    expected: { primaryRemarkType: 'transfer-out', parsedFlags: ['transfer'], attachmentFlag: false }
  }
];

// ---- test runner ----------------------------------------------------------

function runRemarkParserTests() {
  var passed = 0;
  var failed = 0;
  var warnings = 0;

  function assert(condition, msg) {
    if (!condition) {
      console.error('  ✗ FAIL: ' + msg);
    }
    return condition;
  }

  for (var i = 0; i < TEST_CASES.length; i++) {
    var tc = TEST_CASES[i];
    var result = parsePostingRemark(tc.remark);
    var exp = tc.expected;
    var ok = true;

    console.log('[' + (i + 1) + '] "' + tc.remark.substring(0, 60) + (tc.remark.length > 60 ? '…' : '') + '"');
    console.log('    → type: ' + result.primaryRemarkType + '  confidence: ' + result.parserConfidence + '  review: ' + result.needsReview);

    if (exp.primaryRemarkType !== undefined) {
      if (!assert(result.primaryRemarkType === exp.primaryRemarkType,
        'primaryRemarkType: expected "' + exp.primaryRemarkType + '", got "' + result.primaryRemarkType + '"')) ok = false;
    }

    if (exp.parsedFlags !== undefined) {
      for (var f = 0; f < exp.parsedFlags.length; f++) {
        if (!assert(result.parsedFlags.indexOf(exp.parsedFlags[f]) !== -1,
          'parsedFlags: expected "' + exp.parsedFlags[f] + '" to be present')) ok = false;
      }
    }

    if (exp.supersededFlag !== undefined) {
      if (!assert(result.supersededFlag === exp.supersededFlag,
        'supersededFlag: expected ' + exp.supersededFlag + ', got ' + result.supersededFlag)) ok = false;
    }
    if (exp.cancelledFlag !== undefined) {
      if (!assert(result.cancelledFlag === exp.cancelledFlag,
        'cancelledFlag: expected ' + exp.cancelledFlag + ', got ' + result.cancelledFlag)) ok = false;
    }
    if (exp.retitledFlag !== undefined) {
      if (!assert(result.retitledFlag === exp.retitledFlag,
        'retitledFlag: expected ' + exp.retitledFlag + ', got ' + result.retitledFlag)) ok = false;
    }
    if (exp.redeployedFlag !== undefined) {
      if (!assert(result.redeployedFlag === exp.redeployedFlag,
        'redeployedFlag: expected ' + exp.redeployedFlag + ', got ' + result.redeployedFlag)) ok = false;
    }
    if (exp.attachmentFlag !== undefined) {
      if (!assert(result.attachmentFlag === exp.attachmentFlag,
        'attachmentFlag: expected ' + exp.attachmentFlag + ', got ' + result.attachmentFlag)) ok = false;
    }
    if (exp.temporaryPostFlag !== undefined) {
      if (!assert(result.temporaryPostFlag === exp.temporaryPostFlag,
        'temporaryPostFlag: expected ' + exp.temporaryPostFlag + ', got ' + result.temporaryPostFlag)) ok = false;
    }
    if (exp.linkedViceName !== undefined) {
      if (!assert(result.linkedViceName === exp.linkedViceName,
        'linkedViceName: expected "' + exp.linkedViceName + '", got "' + result.linkedViceName + '"')) ok = false;
    }
    if (exp.linkedPnReference !== undefined) {
      if (!assert(result.linkedPnReference === exp.linkedPnReference,
        'linkedPnReference: expected "' + exp.linkedPnReference + '", got "' + result.linkedPnReference + '"')) ok = false;
    }
    if (exp.parserConfidence !== undefined) {
      if (!assert(result.parserConfidence === exp.parserConfidence,
        'parserConfidence: expected "' + exp.parserConfidence + '", got "' + result.parserConfidence + '"')) ok = false;
    }
    if (exp.needsReview !== undefined) {
      if (!assert(result.needsReview === exp.needsReview,
        'needsReview: expected ' + exp.needsReview + ', got ' + result.needsReview)) ok = false;
    }

    if (ok) {
      passed++;
      console.log('    ✓ PASS');
    } else {
      failed++;
    }
    console.log('');
  }

  console.log('========================================');
  console.log('Results: ' + passed + ' passed, ' + failed + ' failed, ' + TEST_CASES.length + ' total');
  console.log('========================================');
  return { passed: passed, failed: failed, total: TEST_CASES.length };
}

// Auto-run if loaded directly (for Node.js: node remark-parser.js --test)
if (typeof require !== 'undefined' && require.main === module) {
  runRemarkParserTests();
}

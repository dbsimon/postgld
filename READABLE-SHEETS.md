# Posting Manager — Readable Operational Sheets

*Business-facing workbook design  ·  2026-07-05*

---

## Design Principles

1.  **Read-only for humans.**  All five sheets are regenerated from master sheets after every sync.  Manual edits are overwritten — add a note in the master sheet instead.
2.  **Frozen header row on every sheet.**  Staff can scroll without losing column context.
3.  **Default filters pre-applied.**  Each sheet opens with the most useful view already selected.
4.  **Conditional formatting for at-a-glance scanning.**  Colours signal status without reading every cell.
5.  **Bilingual-friendly.**  Headers use English; status values use short English codes.  Chinese aliases are shown in filter dropdowns where space permits.
6.  **Wrappable notes.**  Longer text columns use text wrapping so staff can read full remarks without horizontal scroll.

---

## 1. Current View

### Purpose

*Answer the question:*  **"Who holds which post right now?"**

A snapshot of every post in the establishment, showing its current holder (if any), status, effective date, and PN reference.  This is the sheet most staff will open first.

### Columns (left to right)

| # | Header | Width | Wrap | Source | Description |
|---|---|---|---|---|---|
| A | **Post** | 180 px | No | Posts!B | Job title, e.g. `ASO(P&I)SD` |
| B | **Department** | 160 px | No | Posts!C | Organisational unit, e.g. `Security Bureau` |
| C | **Holder** | 190 px | No | Movements!B | Full name with title; empty if vacant |
| D | **Nickname** | 130 px | No | Colleagues!C | Display nickname, e.g. `阿Man` |
| E | **Status** | 100 px | No | computed | `Occupied` / `Vacant` / `Acting` / `Obsolete` |
| F | **Since** | 105 px | No | computed | DD.MM.YYYY — date the current holder took the post |
| G | **PN No.** | 95 px | No | Movements!H | Posting Notice reference, e.g. `4/2026` |
| H | **Holder Type** | 110 px | No | computed | `Substantive` / `Acting` / `Temporary` / *(empty)* |
| I | **On Attachment** | 100 px | No | computed | `Yes` or *(empty)* — holder is seconded elsewhere |
| J | **Future Incoming** | 160 px | No | computed | Name of person arriving after today (if any) |
| K | **Notes** | 280 px | Yes | Posts!F + Colleagues!E | Combined role note and person note |

### Default Sort Order

1.  **Department** ascending (A→Z)
2.  **Post** ascending (A→Z)

*Rationale:*  Staff browse by department first, then scan posts within each department.

### Default Filters

| Column | Filter | Purpose |
|---|---|---|
| **E (Status)** | Show: `Occupied`, `Acting`, `Vacant` (hide `Obsolete`) | Exclude abolished posts from daily view |
| **I (On Attachment)** | *(no pre-filter)* | — |

### Conditional Formatting

| Range | Rule | Style | Purpose |
|---|---|---|---|
| E2:E | `=E2="Vacant"` | Amber background (#FEF3C7), amber bold text | Highlight gaps needing attention |
| E2:E | `=E2="Acting"` | Purple background (#F3E8FF), purple bold text | Distinguish temporary arrangements |
| E2:E | `=E2="Obsolete"` | Grey background (#F1F5F9), grey strikethrough text | Visually deprecate abolished posts |
| I2:I | `=I2="Yes"` | Cyan background (#ECFEFF) | Flag seconded holders |
| J2:J | `=J2<>""` | Indigo background (#E0E7FF) | Highlight posts with future incumbents already known |
| G2:G | *(all)* | Blue text (#2563EB) | PN references stand out as hyperlink-style |

### Frozen / Hidden

- **Row 1 frozen.**
- All columns visible.  No hidden columns.

### Editable?

**No.**  Regenerated on every POST sync.  To correct data, edit the Movements or Posts master sheet, then re-sync.

---

## 2. Future Movements

### Purpose

*Answer the question:*  **"What posting changes are coming?"**

Lists every movement whose effective date is after today.  Sorted by how soon it takes effect.  Used by HR staff to prepare onboarding, office moves, and IT provisioning.

### Columns (left to right)

| # | Header | Width | Wrap | Source | Description |
|---|---|---|---|---|---|
| A | **Person** | 190 px | No | Movements!B | Name of the person moving |
| B | **To Post** | 180 px | No | Movements!E | Destination job title |
| C | **To Dept** | 160 px | No | Movements!F | Destination department |
| D | **Effective Date** | 110 px | No | Movements!G | DD.MM.YYYY |
| E | **PN No.** | 95 px | No | Movements!H | Posting Notice reference |
| F | **Remark Type** | 145 px | No | Movements!I | Parsed type: `Transfer-Out`, `Fill New Post`, `Acting`, etc. |
| G | **Days Until** | 85 px | No | computed | `=D2-TODAY()` — how many days until effective |

### Default Sort Order

1.  **Days Until** ascending (soonest first)

*Rationale:*  The most urgent change is at the top.

### Default Filters

| Column | Filter | Purpose |
|---|---|---|
| *(none pre-applied)* | — | Staff may add their own, e.g. filter by department |

### Conditional Formatting

| Range | Rule | Style | Purpose |
|---|---|---|---|
| G2:G | `=G2<=7` | Red background (#FEE2E2), red bold text | Imminent: within one week |
| G2:G | `=AND(G2>7, G2<=30)` | Amber background (#FEF3C7) | Soon: within one month |
| G2:G | `=G2>30` | Green background (#ECFDF5) | Distant: more than one month |
| D2:D | *(all)* | Bold text | Effective dates stand out |

### Frozen / Hidden

- **Row 1 frozen.**
- All columns visible.

### Editable?

**No.**  Regenerated on every POST sync.

---

## 3. Notice Review

### Purpose

*Answer the question:*  **"Which posting notices have been processed, and which need review?"**

A dashboard for tracking the lifecycle of each Posting Notice document.  Used by the processing team to see which notices are active, superseded, or flagged.

### Columns (left to right)

| # | Header | Width | Wrap | Source | Description |
|---|---|---|---|---|---|
| A | **PN No.** | 100 px | No | Notices!B | e.g. `4/2026` |
| B | **Year** | 65 px | No | Notices!E | Issued year (e.g. `2026`) |
| C | **Status** | 105 px | No | Notices!F | `Active` / `Superseded` / `Withdrawn` |
| D | **Movements** | 90 px | No | Notices!I | How many people moved in this notice |
| E | **Superseded By** | 120 px | No | Notices!J | PN No. of the notice that replaces this one |
| F | **Review Status** | 115 px | No | Notices!G | `Unreviewed` / `Reviewed` / `Flagged` |
| G | **Source File** | 220 px | No | Notices!H | Original PDF filename, e.g. `PN_4_2026.pdf` |

### Default Sort Order

1.  **Year** descending (newest first)
2.  **PN No.** numeric descending (higher PN number first within same year)

*Rationale:*  Staff want to see the latest notices first.

### Default Filters

| Column | Filter | Purpose |
|---|---|---|
| **C (Status)** | Show: `Active`, `Superseded` (hide `Withdrawn`) | Focus on current notices |
| **F (Review Status)** | Show: `Unreviewed`, `Flagged` (hide `Reviewed`) | Show only items needing attention |

### Conditional Formatting

| Range | Rule | Style | Purpose |
|---|---|---|---|
| C2:C | `=C2="Superseded"` | Grey text, strikethrough | Visually deprecate old notices |
| C2:C | `=C2="Withdrawn"` | Grey background (#F1F5F9), grey text | Fully deprecated |
| F2:F | `=F2="Flagged"` | Red background (#FEE2E2), bold text | Needs immediate attention |
| F2:F | `=F2="Unreviewed"` | Amber background (#FEF3C7) | Needs review |
| F2:F | `=F2="Reviewed"` | Green text (#065F46) | Done |
| A2:A | *(all)* | Blue text (#2563EB) | PN references stand out |

### Frozen / Hidden

- **Row 1 frozen.**
- All columns visible.

### Editable?

**No.**  Regenerated on every POST sync.  To update review status, edit the Notices master sheet.

---

## 4. Department Summary

### Purpose

*Answer the question:*  **"How healthy is each department's staffing?"**

An aggregate view showing, per department, how many posts exist and how many are filled, vacant, acting-covered, or awaiting a future incumbent.  Used by senior management for workforce planning.

### Columns (left to right)

| # | Header | Width | Wrap | Source | Description |
|---|---|---|---|---|---|
| A | **Department** | 200 px | No | Posts!C | Organisational unit name |
| B | **Total Posts** | 95 px | No | COUNT | All posts in this department (including obsolete) |
| C | **Occupied** | 90 px | No | computed | Posts with a substantive holder |
| D | **Vacant** | 80 px | No | computed | Posts with no holder |
| E | **Acting** | 80 px | No | computed | Posts covered by acting arrangements only |
| F | **Future Incoming** | 100 px | No | computed | Vacant posts with a known future holder |
| G | **Obsolete** | 85 px | No | computed | Posts marked deleted |

### Default Sort Order

1.  **Total Posts** descending (largest departments first)

*Rationale:*  Management focuses on the biggest departments.

### Default Filters

| Column | Filter | Purpose |
|---|---|---|
| *(none pre-applied)* | — | Staff may filter to specific departments |

### Conditional Formatting

| Range | Rule | Style | Purpose |
|---|---|---|---|
| D2:D | `=D2>0` | Amber background (#FEF3C7) for cells > 0 | Highlight departments with vacancies |
| E2:E | `=E2>0` | Purple background (#F3E8FF) for cells > 0 | Highlight departments relying on acting |
| G2:G | `=G2>0` | Grey background (#F1F5F9) for cells > 0 | Highlight departments with abolished posts |
| B2:G | Gradient colour scale (white → blue) | Quick visual of relative sizes |

### Frozen / Hidden

- **Row 1 frozen.**
- All columns visible.

### Editable?

**No.**  Regenerated on every POST sync.

---

## 5. Exceptions

### Purpose

*Answer the question:*  **"Which records have problems that need fixing?"**

Lists every movement that fails validation or is flagged for manual review.  This is the **action list** for data-quality staff.

### Columns (left to right)

| # | Header | Width | Wrap | Source | Description |
|---|---|---|---|---|---|
| A | **Movement ID** | 100 px | No | Movements!A | Unique identifier for the problematic record |
| B | **Person** | 190 px | No | Movements!B | Person name |
| C | **Issue** | 320 px | Yes | Movements!U | Description of what's wrong (semi-colon separated) |
| D | **Date** | 105 px | No | Movements!G | Effective date of the movement |
| E | **PN No.** | 95 px | No | Movements!H | Posting Notice reference |
| F | **Needs Review** | 105 px | No | computed | `Yes` if flagged or confidence is low |
| G | **Validation** | 105 px | No | Movements!T | `ok` / `warning` / `error` |

### Default Sort Order

1.  **Validation** custom order: `error` first, then `warning`, then `ok`
2.  **Date** descending (newest problems first)

*Rationale:*  Most severe issues at the top, sorted by recency.

### Default Filters

| Column | Filter | Purpose |
|---|---|---|
| **G (Validation)** | Show: `error`, `warning` (hide `ok`) | Only show problems, not informational rows |

### Conditional Formatting

| Range | Rule | Style | Purpose |
|---|---|---|---|
| G2:G | `=G2="error"` | Red background (#FEE2E2), bold red text | Critical: missing required fields, bad PN format |
| G2:G | `=G2="warning"` | Amber background (#FEF3C7), bold amber text | Caution: date range issues, needs review |
| F2:F | `=F2="Yes"` | Bold red text | Flagged for manual attention |
| C2:C | Text wrap enabled; max height 3 lines | Long issue descriptions are readable |

### Frozen / Hidden

- **Row 1 frozen.**
- All columns visible.

### Editable?

**No.**  Regenerated on every POST sync.  Fix the underlying data in the Movements master sheet; the exception disappears on next regeneration.

---

## Regeneration Schedule

All five readable sheets are regenerated **every time the workbook receives a POST request** (i.e. when the front-end syncs data).  The regeneration sequence is:

1.  Clear all readable sheet contents (preserve headers and formatting).
2.  Replay all movements through the occupancy engine.
3.  Populate Current View from occupancy snapshot.
4.  Filter movements with future effective dates → Future Movements.
5.  Map Notices master data → Notice Review.
6.  Aggregate Posts by department → Department Summary.
7.  Filter movements with validation issues → Exceptions.
8.  Re-apply conditional formatting rules and alternating row colours.

**Manual regeneration:**  Run `regenerateReadableSheets()` from the Apps Script editor, or call the `setup()` function.

---

## Quick-Reference: Colour Legend

| Colour | Meaning | Appears On |
|---|---|---|
| 🔴 Red | Critical / Error / Imminent | Exceptions (error), Future Movements (≤7 days), Notice Review (flagged) |
| 🟠 Amber | Warning / Vacant / Needs Review | Current View (vacant), Future Movements (≤30 days), Exceptions (warning), Notice Review (unreviewed), Dept Summary (vacancies) |
| 🟣 Purple | Acting | Current View (acting), Dept Summary (acting count) |
| 🔵 Indigo | Future Incoming | Current View (future holder exists) |
| 🩵 Cyan | On Attachment | Current View (seconded holder) |
| 🟢 Green | OK / Distant / Done | Future Movements (>30 days), Notice Review (reviewed) |
| ⚪ Grey | Obsolete / Superseded / Withdrawn | Current View (obsolete), Notice Review (superseded/withdrawn) |

# Posting Manager — Google Sheets Workbook Specification

## Architecture

```
┌─────────────────────────────────────────────┐
│  Master Sheets  (canonical, machine-read)   │
│  Movements · Notices · Colleagues · Posts   │
│  Config · Audit Log                         │
└──────────────┬──────────────────────────────┘
               │  Apps Script regenerates on
               │  every POST / scheduled trigger
               ▼
┌─────────────────────────────────────────────┐
│  Readable Sheets  (human-readable, frozen   │
│  headers, filter views, alternating colors) │
│  Current View · Future Movements            │
│  Notice Review · Department Summary         │
│  Exceptions                                 │
└─────────────────────────────────────────────┘
```

**Rule**:  Master sheets are the **source of truth**.  Readable sheets are **derived** and may be regenerated at any time.  Never edit readable sheets manually — changes would be overwritten.

---

## 1.  Master: Movements

*Stable row schema.  One row = one posting event (person moves between posts).*

### Business columns (A–K) — always visible

| Col | Header             | Type     | Description                                      |
|-----|--------------------|----------|--------------------------------------------------|
| A   | Movement ID        | text     | 6-char base-36 hash, stable across syncs         |
| B   | Name               | text     | Full person name with title                      |
| C   | From Post          | text     | Previous job title (empty for new appointees)    |
| D   | From Dept          | text     | Previous department                              |
| E   | To Post            | text     | New job title                                    |
| F   | To Dept            | text     | New department                                   |
| G   | Effective Date     | text     | DD.MM.YYYY  (plain-text format)                  |
| H   | PN No.             | text     | e.g. 4/2026  (**plain-text format, never date**) |
| I   | Remark Type        | text     | Primary parsed type (acting, transfer-out, etc.) |
| J   | Remark Flags       | text     | Comma-separated flags                            |
| K   | Raw Remark         | text     | Original free-text remark                        |

### Technical columns (L–V) — hidden by default

| Col | Header              | Type     | Description                                     |
|-----|---------------------|----------|-------------------------------------------------|
| L   | Person ID           | text     | hashId(normalised name)                         |
| M   | From Post ID        | text     | hashId(normalised from_post)                    |
| N   | From Dept ID        | text     | hashId(normalised from_dept)                    |
| O   | To Post ID          | text     | hashId(normalised to_post)                      |
| P   | To Dept ID          | text     | hashId(normalised to_dept)                      |
| Q   | Notice ID           | text     | hashId(PN serial)                               |
| R   | Source Type         | text     | pdf-ai / manual / import / gdrive-sync          |
| S   | Review Status       | text     | unreviewed / accepted / flagged                 |
| T   | Validation Status   | text     | ok / warning / error                            |
| U   | Validation Issues   | text     | Semi-colon separated                            |
| V   | Superseded          | boolean  | TRUE if superseded                              |
| W   | Cancelled           | boolean  | TRUE if cancelled                               |
| X   | Acting Flag         | boolean  | TRUE if acting/continue-acting                  |
| Y   | Created At          | datetime | ISO 8601                                        |
| Z   | Updated At          | datetime | ISO 8601                                        |

### Formatting

- Row 1 frozen
- Columns G, H: number format `@` (plain text)
- Alternating row colours: white / #F8FAFC
- Filter view on all columns
- Column widths: A=90px, B=180px, C–F=140px, G=110px, H=90px, I=130px, J=180px, K=250px

---

## 2.  Master: Notices

*One row per Posting Notice document.*

### Columns

| Col | Header           | Type     | Description                                  |
|-----|------------------|----------|----------------------------------------------|
| A   | Notice ID        | text     | 6-char hash                                  |
| B   | PN No.           | text     | e.g. 4/2026  (plain-text)                    |
| C   | Serial           | text     | e.g. 0004/2026  (sortable)                   |
| D   | Issued Month     | number   | 1–12                                         |
| E   | Issued Year      | number   | 2024–2030                                    |
| F   | Status           | text     | active / superseded / withdrawn              |
| G   | Review Status    | text     | unreviewed / reviewed / flagged              |
| H   | Source File      | text     | Original PDF filename                        |
| I   | Movement Count   | number   | How many movements in this notice            |
| J   | Superseded By    | text     | PN No. that supersedes this one              |
| K   | Created At       | datetime | ISO 8601                                     |
| L   | Updated At       | datetime | ISO 8601                                     |

### Formatting

- Row 1 frozen
- Column B: number format `@`
- Alternating row colours
- Filter view

---

## 3.  Master: Colleagues

*One row per unique person.  Stores biographical data and images.*

### Columns

| Col | Header            | Type     | Description                                |
|-----|-------------------|----------|--------------------------------------------|
| A   | Person ID         | text     | 6-char hash                                |
| B   | Name              | text     | Full normalised name                       |
| C   | Nickname          | text     | Optional display nickname                  |
| D   | Inferred Rank     | text     | Mr / Miss / Ms / Mrs / Dr / Madam          |
| E   | Notes             | text     | Free-text notes                            |
| F   | Contact URL       | text     | directory.gov.hk link                      |
| G   | Image Filename    | text     | e.g. CHAN_Tai_man.jpg  (empty if none)     |
| H–O | Image Data 1…8    | text     | Base64 chunks (45 kB each) — **hidden**    |
| P   | Created At        | datetime | ISO 8601                                   |
| Q   | Updated At        | datetime | ISO 8601                                   |

### Formatting

- Row 1 frozen
- Columns H–O hidden by default
- Alternating row colours

---

## 4.  Master: Posts

*Registry of every unique post+department combination.*

### Columns

| Col | Header           | Type     | Description                               |
|-----|------------------|----------|-------------------------------------------|
| A   | Post ID          | text     | hashId(post\|\|dept)                      |
| B   | Post Title       | text     | e.g. ASO(P&I)SD                           |
| C   | Department       | text     | e.g. Security Bureau                      |
| D   | Rank Group       | text     | ASO / SO / SSO / CSO / PSO / C / OTHER   |
| E   | Status           | text     | active / deleted                           |
| F   | Role Note        | text     | Admin note about this role                |
| G   | Current Holder   | text     | Computed person name (refreshed)          |
| H   | Current Since    | text     | DD.MM.YYYY                                |
| I   | Created At       | datetime | ISO 8601                                  |
| J   | Updated At       | datetime | ISO 8601                                  |

### Formatting

- Row 1 frozen
- Column F: wrap text
- Alternating row colours

---

## 5.  Master: Config

*Key-value store for app settings.  Survives workbook rebuilds.*

| Col | Header           | Type     | Description                               |
|-----|------------------|----------|-------------------------------------------|
| A   | Key              | text     | e.g. APP_PASSWORD, SCHEMA_VERSION         |
| B   | Value            | text     |                                           |
| C   | Description      | text     | Human-readable note                       |
| D   | Updated At       | datetime | ISO 8601                                  |

**Default rows:**
```
APP_PASSWORD     | 1234          | API password for web-app authentication
SCHEMA_VERSION   | 2             | Workbook schema version
ADMIN_PASSWORD   | Simon123      | Admin mode password (front-end only)
PAGE_PASSWORD    | 1234          | Page lock password (front-end only)
```

---

## 6.  Master: Audit Log

*Append-only log of every mutation.  Never truncated automatically.*

| Col | Header           | Type     | Description                               |
|-----|------------------|----------|-------------------------------------------|
| A   | Timestamp        | datetime | When the action occurred                  |
| B   | Action           | text     | create / update / delete / overwrite      |
| C   | Entity Type      | text     | movement / notice / colleague / post      |
| D   | Entity ID        | text     | Affected entity ID                        |
| E   | Summary          | text     | Human-readable description                |
| F   | Details          | text     | JSON diff or payload snippet              |

---

## 7.  Readable: Current View

*Generated snapshot of current post occupancy.  Regenerated after every sync.*

| Col | Header              | Source                                      |
|-----|---------------------|---------------------------------------------|
| A   | Post                | Posts!B                                     |
| B   | Department          | Posts!C                                     |
| C   | Holder              | Movements!B  (latest substantive/acting)    |
| D   | Nickname            | Colleagues!C                                |
| E   | Status              | Occupied / Vacant / Acting / Obsolete       |
| F   | Since               | Movements!G                                 |
| G   | PN No.              | Movements!H                                 |
| H   | Holder Type         | Substantive / Acting / Temporary            |
| I   | On Attachment       | Yes / No                                    |
| J   | Future Incoming     | Person name (if any)                        |
| K   | Notes               | Posts!F  +  Colleagues!E                    |

**Formatting:**
- Row 1 frozen, bold, background #E2E8F0
- Alternating rows white / #F1F5F9
- Filter view on Status column
- Status conditional formatting: Vacant=amber bg, Obsolete=grey bg, Acting=purple bg
- Column widths: A=160px, B=140px, C=180px, D=120px, E=100px, F=100px, G=90px

---

## 8.  Readable: Future Movements

*Movements with effective date > today.  Sorted by date ascending.*

| Col | Header              | Source                        |
|-----|---------------------|-------------------------------|
| A   | Person              | Movements!B                   |
| B   | To Post             | Movements!E                   |
| C   | To Dept             | Movements!F                   |
| D   | Effective Date      | Movements!G                   |
| E   | PN No.              | Movements!H                   |
| F   | Remark Type         | Movements!I                   |
| G   | Days Until          | =D2-TODAY()                   |

**Formatting:**
- Row 1 frozen
- Column G: conditional — red if ≤7, amber if ≤30
- Alternating row colours

---

## 9.  Readable: Notice Review

*Dashboard for reviewing notice processing status.*

| Col | Header              | Source                        |
|-----|---------------------|-------------------------------|
| A   | PN No.              | Notices!B                     |
| B   | Issued              | Notices!E  (year only)       |
| C   | Status              | Notices!F                     |
| D   | Movements           | Notices!I                     |
| E   | Superseded By       | Notices!J                     |
| F   | Review Status       | Notices!G                     |
| G   | Source File         | Notices!H                     |

**Formatting:**
- Row 1 frozen
- Filter view on Status + Review Status
- Conditional: superseded=grey text, flagged=red bg
- Alternating row colours

---

## 10. Readable: Department Summary

*Aggregated counts per department.*

| Col | Header              | Description                   |
|-----|---------------------|-------------------------------|
| A   | Department          | Dept name                     |
| B   | Total Posts         | COUNT of posts in this dept   |
| C   | Occupied            | Posts with holder             |
| D   | Vacant              | Posts without holder          |
| E   | Acting              | Posts with acting holder only |
| F   | Future Incoming     | Posts with future holder      |
| G   | Obsolete            | Posts marked deleted          |

**Formatting:**
- Row 1 frozen
- Columns B–G: centered, numeric
- Alternating row colours
- Sorted by Total Posts descending

---

## 11. Readable: Exceptions

*Rows that failed validation or are flagged for manual review.*

| Col | Header              | Source                       |
|-----|---------------------|------------------------------|
| A   | Movement ID         | Movements!A                  |
| B   | Person              | Movements!B                  |
| C   | Issue               | Movements!U                  |
| D   | Date                | Movements!G                  |
| E   | PN No.              | Movements!H                  |
| F   | Needs Review        | Movements!S = flagged        |
| G   | Validation Status   | Movements!T                  |

**Formatting:**
- Row 1 frozen
- Alternating row colours
- Conditional: Validation Status = error → red bg

---

## Migration Notes

### From old structure (Records / Colleagues / Posts)

| Old Sheet  | New Sheet(s)                     | Mapping Notes                                   |
|------------|----------------------------------|-------------------------------------------------|
| Records    | Movements                        | Direct mapping + added ID/parsed columns        |
| Colleagues | Colleagues                       | Added Person ID, inferred rank, contact URL     |
| Posts      | Posts                            | Added Post ID, rank group, current holder       |
| —          | Notices                          | New — extracted from PN No. column              |
| —          | Config                           | New — replaces Script Properties for passwords  |
| —          | Audit Log                        | New — append-only                               |
| —          | Current View, Future Movements,  | New — auto-generated from Masters               |
|            | Notice Review, Dept Summary,     |                                                 |
|            | Exceptions                       |                                                 |

### Backward Compatibility

The Apps Script `doGet` response should continue to return `Records`, `Colleagues`, and `Posts` keys so the front-end `autoSyncFromGdrive` function still works.  The front-end will receive the legacy-shaped data while the workbook internally has the richer schema.

When the front-end POSTs an `overwrite` payload, the Apps Script should:
1. Accept the old `Records`/`Colleagues`/`Posts` flat arrays
2. Parse them into the new master sheet structure
3. Write master sheets
4. Regenerate readable sheets
5. Append to Audit Log

### Schema Version

The Config sheet stores `SCHEMA_VERSION`.  On first migration:
- If Config sheet does not exist → create all sheets fresh (version 2)
- If Config sheet has version 1 → migrate Records→Movements, keep others

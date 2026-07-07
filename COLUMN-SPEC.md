# Posting Manager — Master Sheet Column Specifications

Version 2.0  ·  2026-07-05

---

## Legend

| Label | Meaning |
|---|---|
| **R** | Required — must be present for row validity |
| **O** | Optional — may be empty |
| **B** | Business-visible — shown to end users in readable sheets / front-end |
| **T** | Technical — hidden by default, used by engine / GAS / front-end logic |
| **PK** | Part of the natural primary key (deterministic ID seed) |

**Format codes:**

| Code | Google Sheets format | Notes |
|---|---|---|
| `text` | `@` (plain text) | Prevents auto-conversion (dates, numbers) |
| `date` | `@` (plain text) + `DD.MM.YYYY` | Stored as text to avoid locale issues; sorted via sort key |
| `enum` | `@` | Constrained values listed in spec |
| `bool` | `@` + `TRUE`/`FALSE` | Plain-text booleans for cross-platform safety |
| `note` | `@` + wrap | Free-text, human-readable |
| `id` | `@` | 6-char base-36 hash, stable |
| `iso` | Automatic (datetime) | ISO 8601, set programmatically only |

---

## 1. Movements

*One row = one person moving between posts.  The core event entity.*

| # | Column | R/O | B/T | PK | Format | Front-End Usage | Readable Sheets | GAS Usage |
|---|---|---|---|---|---|---|---|---|
| A | **Movement ID** | R | T | ✓ | `id` | dedup key; edit/delete target | Exceptions A | hash seed: personId + toPostId + dateKey + noticeId |
| B | **Name** | R | B | ✓ | `text` | primary display; hyperlink to history | Current View C; Future Movements A; Exceptions B | person lookup; creates Person entity |
| C | **From Post** | O | B | — | `text` | shown in Database table "原職" column | — | creates/links Post entity; vacancy trigger on LEAVE |
| D | **From Dept** | O | B | — | `text` | shown in Database table | — | creates/links Department entity |
| E | **To Post** | R | B | ✓ | `text` | shown in Current/Database/History views | Current View A; Future Movements B | creates/links Post entity; occupancy JOIN |
| F | **To Dept** | R | B | — | `text` | shown in Current/Database/History views | Current View B; Department Summary A | creates/links Department entity |
| G | **Effective Date** | R | B | ✓ | `date` | sort key; shown in all tables | Current View F; Future Movements D; Exceptions D | parsed to `YYYYMMDD` sort key; occupancy ordering |
| H | **PN No.** | R | B | ✓ | `text` | hyperlink to notice history; shown in all tables | Current View G; Notice Review A; Future Movements E | creates/links Notice entity; **must be @ format to prevent "4/2026" → date** |
| I | **Remark Type** | O | B | — | `enum` | labelForRemarkType() in UI; acting badge trigger | Future Movements F; occupancy type dispatch | drives occupancy engine: acting/cease-acting/fill-new-post/etc. |
| J | **Remark Flags** | O | T | — | `enum` | parsedFlags array in UI (promotion, vice, etc.) | — | merged into parsedFlags on Movement entity |
| K | **Raw Remark** | O | B | — | `note` | shown in detail views; editable in modal | — | stored verbatim; fed to remark-parser.js on load |
| L | **Person ID** | R | T | — | `id` | used internally by data-model.js for lookups | — | joins to Colleagues; dedup key for Person entity |
| M | **From Post ID** | O | T | — | `id` | — | — | joins to Posts; from-side occupancy clearance |
| N | **From Dept ID** | O | T | — | `id` | — | — | joins to Department entity |
| O | **To Post ID** | R | T | — | `id` | — | — | joins to Posts; to-side occupancy set |
| P | **To Dept ID** | R | T | — | `id` | — | — | joins to Department entity |
| Q | **Notice ID** | R | T | — | `id` | — | — | joins to Notices; tie-breaking sort key |
| R | **Source Type** | O | T | — | `enum` | — | — | `pdf-ai` / `manual` / `import` / `gdrive-sync` |
| S | **Review Status** | O | T | — | `enum` | — | Notice Review F; Exceptions F | `unreviewed` / `accepted` / `flagged` |
| T | **Validation Status** | O | T | — | `enum` | — | Exceptions G | `ok` / `warning` / `error` |
| U | **Validation Issues** | O | T | — | `note` | — | Exceptions C | semi-colon delimited list from validateMovement() |
| V | **Superseded** | O | T | — | `bool` | excluded from occupancy in renderCurrentTable | excluded from Current View | occupancy engine skips row if TRUE |
| W | **Cancelled** | O | T | — | `bool` | excluded from occupancy | excluded from Current View | occupancy engine skips row if TRUE |
| X | **Acting Flag** | O | T | — | `bool` | triggers 署任 badge in Current View | Current View E/H | occupancy engine sets actingHolder vs substantiveHolder |
| Y | **Created At** | O | T | — | `iso` | — | — | set on first insert; never modified |
| Z | **Updated At** | O | T | — | `iso` | — | — | set on every update; tie-breaker after date+PN |

**Enum values for I (Remark Type):**
`acting` | `cease-acting` | `continue-acting` | `fill-new-post` | `fill-vacant-post` | `fill-temporary-post` | `transfer-out` | `no-pay-leave` | `attachment` | `superseded` | `cancelled` | `retitled` | `redeployed` | `general`

---

## 2. Notices

*One row = one Posting Notice document.  Derived from PN No. values in Movements.*

| # | Column | R/O | B/T | PK | Format | Front-End Usage | Readable Sheets | GAS Usage |
|---|---|---|---|---|---|---|---|---|
| A | **Notice ID** | R | T | ✓ | `id` | — | — | hash(serial); joins to Movements.Q |
| B | **PN No.** | R | B | ✓ | `text` | shown in all views; hyperlinked to notice history | Notice Review A | **plain-text @ format**; extracted from Movements |
| C | **Serial** | O | T | — | `text` | sort key in tie-breaking | — | e.g. `0004/2026`; stable sort across years |
| D | **Issued Month** | O | T | — | `text` | — | — | parsed from PN No.; 1–12 |
| E | **Issued Year** | O | B | — | `text` | — | Notice Review B | parsed from PN No. |
| F | **Status** | O | B | — | `enum` | colours in Notice Review sheet | Notice Review C | `active` / `superseded` / `withdrawn` |
| G | **Review Status** | O | B | — | `enum` | — | Notice Review F | `unreviewed` / `reviewed` / `flagged` |
| H | **Source File** | O | B | — | `text` | — | Notice Review G | original PDF filename; set by AI extraction |
| I | **Movement Count** | O | B | — | `text` | — | Notice Review D | COUNT of Movements with this noticeId |
| J | **Superseded By** | O | B | — | `text` | linkedPnReference in remark parser | Notice Review E | PN No. that supersedes this notice |
| K | **Created At** | O | T | — | `iso` | — | — | programmatic |
| L | **Updated At** | O | T | — | `iso` | — | — | programmatic |

---

## 3. Colleagues

*One row = one unique person.  Stores biography, notes, and photo data.*

| # | Column | R/O | B/T | PK | Format | Front-End Usage | Readable Sheets | GAS Usage |
|---|---|---|---|---|---|---|---|---|
| A | **Person ID** | R | T | ✓ | `id` | — | — | hash(normalised name); joins to Movements.L |
| B | **Name** | R | B | ✓ | `text` | displays in all name fields | Current View C | normalised full name with title prefix |
| C | **Nickname** | O | B | — | `text` | shown after name in parens: `CHAN Tai-man (阿Man)` | Current View D | sourced from personNicknames localStorage |
| D | **Inferred Rank** | O | T | — | `text` | — | — | `Mr` / `Miss` / `Ms` / `Mrs` / `Dr` / `Madam` from name parse |
| E | **Notes** | O | B | — | `note` | shown in history sidebar detail panel | Current View K (appended) | sourced from personNotes localStorage; editable via saveSelectionRemark |
| F | **Contact URL** | O | T | — | `text` | contactBtn → opens directory.gov.hk | — | built from name + current dept |
| G | **Image Filename** | O | T | — | `text` | — | — | e.g. `CHAN_Tai_man.jpg`; empty if no image |
| H | **Image Data 1** | O | T | — | `text` | rendered as avatar in Current/Database/History views | — | base64 chunk 1 of 8; 45 kB each; hidden column |
| I | **Image Data 2** | O | T | — | `text` | same as above | — | base64 chunk 2 |
| J | **Image Data 3** | O | T | — | `text` | same as above | — | base64 chunk 3 |
| K | **Image Data 4** | O | T | — | `text` | same as above | — | base64 chunk 4 |
| L | **Image Data 5** | O | T | — | `text` | same as above | — | base64 chunk 5 |
| M | **Image Data 6** | O | T | — | `text` | same as above | — | base64 chunk 6 |
| N | **Image Data 7** | O | T | — | `text` | same as above | — | base64 chunk 7 |
| O | **Image Data 8** | O | T | — | `text` | same as above | — | base64 chunk 8 |
| P | **Created At** | O | T | — | `iso` | — | — | programmatic |
| Q | **Updated At** | O | T | — | `iso` | — | — | programmatic |

**Image chunk consolidation (front-end):**  `combineExcelSafeText(row, 'Image Data')` concatenates H–O into a single base64 data URL.

---

## 4. Posts

*One row = one unique post-title + department combination.  Registry of all positions.*

| # | Column | R/O | B/T | PK | Format | Front-End Usage | Readable Sheets | GAS Usage |
|---|---|---|---|---|---|---|---|---|
| A | **Post ID** | R | T | ✓ | `id` | — | — | hash(post\|\|dept); joins to Movements.O/P |
| B | **Post Title** | R | B | ✓ | `text` | displayed in Current/Database/History; hyperlinked to role history | Current View A; Department Summary (via dept grouping) | e.g. `ASO(P&I)SD` |
| C | **Department** | R | B | — | `text` | displayed under post title; hyperlinked to dept view | Current View B; Department Summary A | dept grouping key |
| D | **Rank Group** | O | T | — | `enum` | used by sortCurrentTable for rank-order sort | — | `ASO` / `SO` / `SSO` / `CSO` / `PSO` / `C` / `OTHER`; derived from post title prefix |
| E | **Status** | O | B | — | `enum` | drives Obsolete badge and row styling | Current View E | `active` / `deleted`; maps to postOverrides in front-end |
| F | **Role Note** | O | B | — | `note` | shown in history sidebar as 崗位備註; editable via saveSelectionRemark | Current View K (appended) | sourced from roleNotes localStorage |
| G | **Current Holder** | O | B | — | `text` | populated by occupancy engine; shown in Current View | Current View C | computed by computeOccupancy() |
| H | **Current Since** | O | B | — | `date` | populated by occupancy engine | Current View F | effective date of holder's most recent JOIN |
| I | **Created At** | O | T | — | `iso` | — | — | programmatic |
| J | **Updated At** | O | T | — | `iso` | — | — | programmatic |

---

## 5. Config

*Key-value configuration store.  Survives workbook rebuilds.*

| # | Column | R/O | B/T | PK | Format | Front-End Usage | Readable Sheets | GAS Usage |
|---|---|---|---|---|---|---|---|---|
| A | **Key** | R | B | ✓ | `text` | — | — | e.g. `APP_PASSWORD`, `SCHEMA_VERSION`, `ADMIN_PASSWORD`, `PAGE_PASSWORD` |
| B | **Value** | R | B | — | `text` | — | — | plain-text value |
| C | **Description** | O | B | — | `text` | — | — | human-readable note explaining the key's purpose |
| D | **Updated At** | O | T | — | `iso` | — | — | last modified timestamp |

**Default rows seeded by `ensureAllMasterSheets()`:**
```
APP_PASSWORD    | 1234       | API password for web-app authentication
SCHEMA_VERSION  | 2          | Workbook schema version (used for migration detection)
ADMIN_PASSWORD  | Simon123   | Admin mode unlock password (front-end only, stored for reference)
PAGE_PASSWORD   | 1234       | Page lock overlay password (front-end only, stored for reference)
```

**Front-end notes:**  The front-end does NOT read Config directly.  Passwords are stored in browser localStorage (`sys_page_pwd`, `sys_admin_pwd`, `sys_api_pwd`).  The Config sheet's `APP_PASSWORD` is the **server-side** password checked by `doGet`/`doPost`.  The other rows are documentation/reference only on the GAS side.

---

## 6. Audit Log

*Append-only log of every mutation.  Never truncated automatically.*

| # | Column | R/O | B/T | PK | Format | Front-End Usage | Readable Sheets | GAS Usage |
|---|---|---|---|---|---|---|---|---|
| A | **Timestamp** | R | B | — | `iso` | — | — | set by `new Date().toISOString()` on append |
| B | **Action** | R | B | — | `enum` | — | — | `create` / `update` / `delete` / `overwrite` |
| C | **Entity Type** | R | B | — | `enum` | — | — | `movement` / `notice` / `colleague` / `post` / `config` / `workbook` |
| D | **Entity ID** | O | T | — | `id` | — | — | affected Movement ID / Notice ID / Person ID / Post ID |
| E | **Summary** | O | B | — | `note` | — | — | human-readable description, e.g. "Updated PN 4/2026 movements" |
| F | **Details** | O | T | — | `note` | — | — | JSON diff or payload snippet (truncated to 5000 chars) |

**Write semantics:**  Only `appendRow()`.  Never update or delete existing rows.  Manual pruning is acceptable for disk space (GAS has cell limits).

---

## Cross-Sheet Join Map

```
Movements.L (Person ID)     ────► Colleagues.A (Person ID)
Movements.M (From Post ID)  ────► Posts.A      (Post ID)
Movements.N (From Dept ID)  ────► (composite: Post Title + Department in Posts)
Movements.O (To Post ID)    ────► Posts.A      (Post ID)
Movements.P (To Dept ID)    ────► (composite: Post Title + Department in Posts)
Movements.Q (Notice ID)     ────► Notices.A    (Notice ID)
Movements.K (Raw Remark)    ────► remark-parser.js  →  Movements.I (Remark Type), Movements.J (Remark Flags)

Posts.B + Posts.C           ────► Current View A+B; Department Summary A
Colleagues.B                ────► Current View C
Notices.B                   ────► Notice Review A
```

---

## Formatting Enforcement (GAS)

Applied automatically by `ensureSheet()` and `writeMasterSheet()`:

| Rule | Applies To |
|---|---|
| Row 1 frozen | All sheets |
| Row 1 bold, background #E2E8F0 | All sheets |
| Alternating row colours: white / #F8FAFC | All sheets rows 2+ |
| Number format `@` on PN No. columns | Movements H, Notices B |
| Number format `@` on Effective Date columns | Movements G, Posts H |
| Technical columns hidden by default | Movements L–Z, Notices K–L, Colleagues H–Q, Posts I–J |
| Wrap text on note columns | Movements K, Colleagues E, Posts F, Audit Log E–F |
| Text format `@` on ID columns | All ID fields (prevents numeric interpretation) |

---

## Migration Notes (v1 → v2)

| v1 Sheet | v2 Master | Column Mapping |
|---|---|---|
| Records | Movements | A→A(gen), B→B, C→C, D→D, E→E, F→F, G→G(date), H→H(PN), I→I(parsed), J→J(flags), K→K(raw) |
| Records (PN col) | Notices | Extracted from H; deduped; Movement Count computed |
| Colleagues | Colleagues | Direct mapping + inferred rank + contact URL |
| Posts | Posts | Direct mapping + Post ID + rank group + current holder/since |
| *(none)* | Config | New; seeded with defaults |
| *(none)* | Audit Log | New; append-only |

**Backward-compatible GET:**  `doGet` returns `Records`, `Colleagues`, `Posts` with the same shape as v1 so the front-end `autoSyncFromGdrive` needs **zero changes**.

**Backward-compatible POST:**  `doPost` accepts the old `sheets.Records` / `sheets.Colleagues` / `sheets.Posts` flat arrays and transparently writes them into the v2 master structure.  No front-end payload changes required.

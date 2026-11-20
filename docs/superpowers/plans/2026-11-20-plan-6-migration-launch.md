# Plan 6: Migration and Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Book Clarity's existing clients into the portal and switch it on safely.
- Every existing client is linked to its package.
- The commission spreadsheet sets who earns on each client and how many commission months are already used.
- Past ACE batches and each ACE client's real start date are entered without paying commission twice.
- A go-live checklist keeps client notices and the 3% card fee off until everything it depends on is in place.

**Architecture:**
- **Package linking:** a pure matcher links each Stripe subscription to a portal Package, by price ID first and then by product name. It runs in the existing client sync.
- **Spreadsheet import:** CSV → pure parse and match → preview → idempotent apply, on an Owner page. Rows that don't match are listed and left alone.
- **Historical ACE batches:** a `historical` flag on the batch suppresses the ACE months 1–6 lump-sum commission, which was already paid outside the portal.
- **Launch settings:** one `launch` Setting holds the manual checklist ticks and the "client notices on" switch. `sendNotice` and the card-fee switch read it.

**Spec:**
- `docs/superpowers/specs/2026-11-19-client-portal-design.md` §14 (migration), §17, §18 D2 (historical ACE, gating), §7.3 (card-fee launch items), §8.
- Read-only Stripe sync and history: done in Plans 1 and 5.

## Global Constraints

- **Read-only against Stripe:** nothing in this plan changes a Stripe subscription, customer or price.
- **No double commission:**
  - Imported "months already earned" go into `commissionMonthsBeforePortal`.
  - Historical ACE batches never post `ACE_PREPAID` lines.
  - Invoices loaded from history never earn (Plan 5).
- **Gating (spec §18 D2, §7.3, §14):**
  - **Client notices** (emails and texts through GHL) are **off** until a Super Admin turns them on on the Launch page. That is allowed only when:
    - every ACE client has a start date;
    - GHL is configured;
    - `PORTAL_BASE_URL` is set;
    - the checklist item "Stripe's own reminder emails are off" is ticked.

    Staff-only alerts (to Owners and Admins) are also held while notices are off, because nothing should go out before launch.
  - **The card fee** can be turned on only when:
    - every ACE client has a start date;
    - "Surcharge registration / state rules confirmed" is ticked;
    - "Existing card clients given notice" is ticked.

    The rate is capped at 3%. Excluded states are editable.
- **Access:**
  - The import and historical batches: Owners and Super Admin (`ace.manage`).
  - The Launch page and its switches: Super Admin only (`settings.manage`).
- **Matching** spreadsheet rows to clients, in order:
  1. Stripe customer ID (`cus_…`);
  2. email (case-insensitive);
  3. exact name (case- and space-insensitive).

  A row that matches zero clients, or more than one, is reported and not applied.

## Review Focus

1. **Running the import twice gives the same state.** Re-importing the same date replaces that split version and never adds a second one. Covered by a Task 2 test.
2. **Historical ACE slots post no lump-sum commission,** not even when a slot is assigned later. Covered by a Task 3 test.
3. **Every send is blocked while notices are off,** including the daily run's reminders. Covered by a Task 4 test.
4. **An import with a bad rate or an unknown executive** never half-applies a row. Covered by a Task 2 test.

---

### Task 1: Link clients to packages

`matchPackage(items, packages)` in `src/domain/packageMatch.ts`, pure:
- An item's price ID equal to `Package.stripePriceId` wins.
- Otherwise `classifyProduct(productName)` gives a package name, matched case-insensitively against `Package.name`.
- Card-fee and onboarding items are ignored.

The live snapshot row carries the subscription's package price IDs and product names. `syncClientsFromSnapshot` sets `packageId` only when it is empty, and never overwrites one set by hand.

The Packages page shows "N clients not linked to a package", with names.

Tests:
- match by price, then by name;
- the Enterprise vs Enterprise Custom distinction;
- an existing link is never overwritten;
- the 6-month variants map to the same package.

### Task 2: Commission spreadsheet import

`src/migration/commissionImport.ts`:
- **`parseCsv(text)`:** RFC 4180, header aliases, trims cells.
- **`planImport(rows)`:** returns `{ ready: Row[], problems: { line, client, error }[] }`.
- **`applyImport(ready, actor)`:** one transaction per row.

**Template columns** (download link on the page):

| Column | Contents |
|---|---|
| `client` | name, email or `cus_…` |
| `type` | Direct or ACE |
| `executive_1`, `rate_1` | rate as a % |
| `executive_2`, `rate_2` | optional |
| `months_already_earned` | 0–12 |
| `effective_from` | optional, YYYY-MM-DD, default 2000-01-01 |
| `ace_batch` | optional, the batch name or note |
| `ace_start_date` | optional |

Each applied row:
- sets the client's type and `commissionMonthsBeforePortal`;
- saves the split with the existing `saveSplit` rules (it is replaced on the same date);
- creates a missing executive by name only when the "create missing executives" box is ticked; otherwise the row is a problem;
- for ACE rows with `ace_batch` and `ace_start_date`, assigns a free slot of the client's package in that batch with that start date.

Page `/settings/import` (`ace.manage`): upload → preview (ready rows, problems) → Apply → result.

Tests:
- every matching path, plus ambiguous and unmatched rows;
- rate validation (a total over 30% is refused);
- an unknown executive;
- idempotent re-apply;
- ACE slot assignment;
- an ACE row whose batch has no free slot of the package is a problem.

### Task 3: Historical ACE batches

- `AceBatch.historical Boolean @default(false)`. The existing "already paid" batch form gets a "Historical (before the portal; commission already settled)" box, which needs the already-paid fields.
- `postAceCommission` skips historical batches.
- The batch page shows "Historical" and explains why no lump-sum commission was posted.

Tests: assigning a slot in a historical batch posts no `ACE_PREPAID` lines, and paying or reassigning later still posts none; normal batches are unchanged.

### Task 4: Launch gating and checklist

**Settings:** `src/settings/launch.ts` has `getLaunch()` → `{ noticesOn, checks: Record<CheckKey, { done, by, at }> }` and `launchStatus()`, which adds the automatic checks:
- **Stripe:** the key is live, the webhook secret is set, and the last webhook arrived less than 48 hours ago.
- **Base setup:** `CRON_SECRET` and `PORTAL_BASE_URL` are set, and GHL is configured.
- **Packages:** every active package has a Stripe price and a contract.
- **Clients:**
  - every active client has a package;
  - every active Direct client has a commission owner (unassigned count);
  - every ACE client has a start date.
- **Onboarding settings:** the countersigner and the booking link are set.

**Manual items** (Super Admin ticks them; each records who and when):
- surcharge registration and state rules confirmed (§7.3);
- existing card clients given notice of the fee;
- Stripe's own reminder emails turned off (§14.4);
- Stripe customer portal configured (card + ACH, no cancel);
- the webhook endpoint has all events;
- a test-mode onboarding run done (card + ACH);
- invoice history loaded (backfill run).

**Switches:**
- **Client notices on/off,** with the gates in Global Constraints. When it's off, `sendNotice` records the notice as SKIPPED "notices are off until launch".
- **Card fee on/off,** plus the rate and excluded states, with its gates.

The page is `/settings/launch`, Super Admin only.

Tests:
- `sendNotice` is skipped while notices are off, including through `runDaily`;
- each switch refuses while a gate is unmet and records the reason;
- turning the card fee on writes the `cardFee` Setting.
- The test helper turns notices on after each reset, so existing tests keep their meaning.

### Task 5: Runbook and smoke

- **Deploy guide, new "Go-live" section:** the order of steps:
  1. sync;
  2. backfill;
  3. packages and prices;
  4. historical ACE batches;
  5. spreadsheet import;
  6. fix unmatched rows;
  7. checklist;
  8. notices on;
  9. card fee on, after client notice.
- **Smoke:**
  - an Owner previews and applies a small CSV;
  - the Launch page loads for the Super Admin and refuses an Owner;
  - with notices off, an onboarding invite is recorded as SKIPPED.

## Done when

- CI is green, the smoke test covers the import and Launch page, and the final review is clean.
- The owner has a template to fill in with their spreadsheet.

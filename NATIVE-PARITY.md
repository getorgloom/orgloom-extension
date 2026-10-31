# Native canvas parity — desktop 0.9.0

The target is the current native canvas, excluding managed canvas saving, sharing and Upload Recall. No managed package, package Apex, package custom objects, license service, or Org Loom server is required. API calls execute in the local extension host with the connected user's Salesforce credentials. The webview never receives credentials.

## Available

| Area | Desktop implementation |
| --- | --- |
| Canvas rendering, records, relationships, editor, comparison, find/replace, undo, schema exploration | Pinned shared canvas runtime, refreshed from canonical commit d6fc41d0635b |
| Browse, SOQL, find related, refresh, lookup search | Direct Salesforce REST queries; user permissions apply |
| Record types, layouts, dependent picklists | Direct Salesforce UI API with accessible describe fallback |
| Validation-rule previews | Tooling metadata when the connected user has access; Salesforce validates actual uploads |
| Auto-fill and bulk editing | Shared tools; local capability checks now permit these actions |
| Scripts | Restricted local worker with preview/apply and guarded Undo |
| CSV and JSON import/export | Native file dialogs, bounded local files, shared parsers and mapping UI |
| Migration | Native app's file workflow and shared reconciliation engine; destination matches use direct, validated SOQL |
| Record-link paste | Connected-org Lightning or record URL pasted into blank canvas; existing cards retain their edits |
| Uploads | Direct sObject REST/Composite Graph, External ID upserts, explicit duplicate-alert retries, ordered deletes |
| Circular draft relationships | Nullable, updateable references can be deferred to a PATCH in the same atomic Graph |
| Recovery | Existing encrypted local checkpoints scoped by org and user, keys in VS Code SecretStorage |
| Onboarding | Dismiss/completion preferences persist by org/user; no record data in those preferences |

## Deliberate exclusions and differences

- Canvas save/load and sharing are disabled and hidden in connected mode. Local JSON export and encrypted crash recovery remain available.
- AI and MCP remain disabled by the previous product decision. Shared record requests and administration of teammates are excluded with sharing.
- Upload Recall remains native-only by user decision. Browsable activity history is not implemented. Interrupted-upload review is available locally; it is not a Recall ledger.
- Native org-wide Activity and administrator feature-grant tabs have no equivalent org-wide service here. This extension acts as one connected Salesforce user; it does not install configuration objects or administrative permissions.
- Migration uses a file, not simultaneous org connections. Export, disconnect, connect to the destination, then import. Reconciliation reads destination metadata and records; Apply changes the canvas only. Upload still requires review and native confirmation.
- Source identities, source lookup values and sharing assignments are stripped during migration. Explicit matches and canvas relationships rebuild destination references. Unknown origins cannot silently import record data. Native migration files are interoperable, including their `nativeMigrationObjects` metadata key.
- Uploads retain Salesforce Graph limits (including depth and object/operation limits), and deletes are separate transactions. Native Apex transaction boundaries differ. Successful independent groups can remain committed after another group fails; see UPLOADS.md.
- Lookup-filter-aware suggestions are not implemented in the reviewed native adapter either. Both use accessible searches and Salesforce enforces required lookup filters during writes. The desktop adapter excludes the edited record before applying the suggestion limit.
- Shared frontend JS is imported byte-for-byte. `webview/migration.js`, `import-guard.js`, `record-paste.js` and `excluded-features.js` were ported from the canonical native web adapters; desktop identity, file picker and REST routes replace native services. No Apex is bundled or invoked. Future updates should compare these adapter copies with the native equivalents.

## 0.9.0 recovery and read parity

- Recovery checks fresh object, field and record access before passing a checkpoint to the webview. Inaccessible content and cached labels/metadata are removed from the restored view and encrypted checkpoint. Network/authentication failures block restoration without overwriting saved work. Original accessible baselines are preserved for conflict checking.
- Every webview reload performs a host handshake and reads the latest checkpoint. Per-document tokens and monotonically increasing checkpoint sequences reject stale writers. The connected panel registers a VS Code serializer for window restart; serialized panel state contains org/user identifiers only.
- Expired recovery files and keys are cleaned on extension activation and daily while VS Code runs, including identities never reopened. No OS background service is installed; cleanup catches up at the next launch after VS Code is closed. Loading always enforces the seven-day age limit. Interrupted-upload journals are separate and retained until resolved/reviewed to avoid unsafe retries.
- Refresh returns independent unavailable-record results while preserving successful records. Authentication, throttling and transport errors abort without advancing baselines.
- SOQL accepts semi/anti-joins and up to 20,000 characters. Child projections still become cards; filter subqueries do not. Results are capped at 500 distinct records across levels with explicit truncation reporting.
- Unknown upload outcomes remain blocked from automatic retry. There is no separate interrupted-upload review workflow.

## 0.9.8 migration fixes

- Refreshed the pinned shared canvas runtime with migration exclusions, stable editable field-mapping rows, destination lookup-target validation/remapping, explicit checkbox conversion, and clearer upload errors.
- Migration preparation and JSON import show loading progress. Outside clicks and Escape do not dismiss the migration review; the close button remains explicit.
- Matched records retain destination LastModifiedDate metadata through import for updates and deletions. Source timestamps never become destination baselines for new drafts.
- Desktop upload comparisons treat equivalent datetime offsets as the same instant while retaining millisecond precision and rejecting stale or invalid concurrency timestamps. Text fields still use literal comparisons.
- Picklist dependencies remain handled through the record editor and Salesforce upload validation. The migration planner does not query additional records to resolve dependent values.
- Recall remains managed-package-only. The Apex Recall correction is not bundled or invoked by the extension, which continues to use direct Salesforce APIs without a package dependency.

## Verification

- `npm test`: regression coverage includes existing APIs, migration, origin guards, cyclic uploads, recovery permission changes, stale writers, cleanup, partial refresh and duplicate-write protection.
- `npm run test:extension`: actual VS Code webview tests using controlled Salesforce responses. Includes editing, recovery, Browse/SOQL, CSV/JSON, scripts, uploads, upsert/duplicate retry, migration, and the actual VS Code webview reload command with changed permissions. Full VS Code process restart is not yet automated by this suite.
- `ORGLOOM_READ_TEST_ALIAS=orgloom-uat node tests/live-parity-acceptance.cjs`: live read-only checks passed for destination matching, record-link import, self-exclusion, validation rules, semi-joins, partial refresh and recovery access validation. 29 requests, zero writes and zero package endpoints. Actual permission revocation is covered by controlled tests. This does not assert that the test org has no package installed.
- Windows desktop is tested. macOS, Linux, remote hosts and browser VS Code remain unverified. No Marketplace publication is performed.

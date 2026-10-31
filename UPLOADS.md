# Desktop uploads — v0.9.18

## No managed-package dependency

All desktop upload operations go from the local VS Code extension host directly to Salesforce using the connected user's OAuth token. They do not require an Org Loom managed-package install, Org Loom Apex, package objects, a hosted Org Loom account, ContentVersion storage, or the hosted key service.

| Operation | Implementation |
| --- | --- |
| Object/field permissions | Native REST describe; Salesforce enforces permissions again on write |
| Existing-record access | Native UserRecordAccess queries under the connected user |
| Stale-record checks | Imported or host-owned original values, with fresh Salesforce checks during planning and immediately before writing |
| Conflict review | Returns loaded/current/proposed values for fields being overwritten; Upload anyway approves only the displayed current field values. Later changes to those fields require another review. |
| Single update | Native sObject PATCH with If-Unmodified-Since |
| Multi-record creates/updates | Native Composite Graph; connected groups roll back separately, up to 75 graphs per request |
| External ID upsert | Native External ID PATCH inside Composite Graph; returned ID and created flag determine the result |
| Duplicate alerts | Explicit retry with `Sforce-Duplicate-Rule-Header: allowSave=true`; the canvas Upload anyway action confirms this choice |
| New-parent relationships | Native Composite references to the created record's ID |
| Deletes | Separate native sObject DELETE requests, awaiting each selected child before its selected parent |
| Upload intent and recovery | Local VS Code SecretStorage; no Salesforce package ledger |
| Completed-attempt receipts | Local SecretStorage, scoped by Salesforce org, user and attempt ID |

This intentionally differs from the hosted implementation, which stores its upload history/Recall ledger in encrypted Salesforce files and uses hosted wrapped-key metadata plus package-backed key handling. That storage code is not imported by the extension. Saved canvases, upload history browsing, and Upload Recall remain disabled; their existing package-dependent implementations are not silently called after a successful write.

## Behavior

Exported snapshots can be uploaded after reconnecting/importing without a host comparison cache. The extension reads current Salesforce values without changing the imported canvas. Updates retain only edits relative to the imported original values, so unrelated Salesforce changes are preserved. Timestamp-only differences do not trigger update conflicts; timestamps are never submitted as field edits. Deletions retain a full-record version check. Comparison reads do not replace the saved original values.

Version 0.9.13 fixes empty conflict dialogs and repeated Upload anyway prompts. Comparison treats blank values, numeric/checkbox representations and equivalent Salesforce ID/date-time forms consistently, using the field type so text remains literal. Invalid or unavailable timestamps require a reload instead of offering an overwrite. Existing access checks and the final concurrency check remain in place.

Use **Add records → Add a blank record** to create a draft, or load existing records with Browse/SOQL/Find related. Edit fields, connect or disconnect lookups, or mark loaded records for deletion. Review the canvas upload selection and choose **Upload**. That is the upload confirmation; version 0.9.18 removes the additional native VS Code dialog. Standard and custom objects are supported when Salesforce metadata permits the operation.

Create/update records are grouped by their relationships and submitted through Composite Graph. Each connected group is its own transaction. A failed group rolls back while unrelated groups can commit. A lone update retains a conditional native PATCH. Deletions run afterward using the same child-first scheduler as the hosted app. A failed child blocks its selected ancestors; unrelated deletions can continue. If all create/update groups fail, deletions are skipped. Successful earlier groups and deletions are not rolled back by a later failure. Native validation rules, triggers, flows and deletion cascades still apply.

On success, results reconcile new IDs and refresh records from Salesforce. A refresh failure does not misreport a confirmed write as failed. Replaying the same completed attempt returns its stored receipt without another write. Reusing an attempt ID with different content is rejected.

## External ID upserts and duplicate alerts

Import CSV, select **Upsert**, and choose the External ID field. The extension queries that key to identify an existing destination or a new record during upload planning, then rechecks immediately before writing. Ambiguous matches, repeated keys within one upload, inaccessible fields, and keys that no longer identify a loaded record are rejected before writes. Known matches use Salesforce's `updateOnly=true` option to prevent accidental recreation if deleted. Successful upserts reconcile Salesforce's actual returned ID and created/updated flag, including relationship references.

External ID fields must be filterable, createable and updateable. An unmatched row also requires both create and update permission for the object and supplied fields, because an upsert could match a newly created record. These are deliberately conservative desktop limits. Matching and version checks are optimistic, not locks: another transaction can change the key or create a match after the final check. Lost upsert responses remain blocked; an External ID is not used as justification for an automatic retry.

When Salesforce returns a duplicate alert, **Upload anyway** explicitly confirms a retry allowing duplicate alerts. The override is limited to that attempt; blocking duplicate rules and other Salesforce validation still apply. Successful rows from the earlier attempt are skipped rather than inserted again.

The inherited CSV upsert UI uses its bulk-upload route. The local adapter provides the completion event that UI expects but performs native Composite Graph requests, not Salesforce Bulk API ingestion. The normal 500-record upload cap and per-group transaction behavior apply.

## Local recovery data

Upload tracking is stored in VS Code SecretStorage before sending writes. Pending entries contain attempt identifiers, a request hash, timestamp, selected object/record identifiers, operation types, and confirmed or in-flight status. They do not store submitted field values or original-value snapshots. Each Graph result and individual deletion is checkpointed before further writes. After the entire attempt is confirmed, the pending marker is removed. Completed receipts contain IDs, operation results and a request hash. Salesforce error messages may include values. Receipts currently remain in that local VS Code profile; there is no expiry or history-management UI yet.

Older pending field payloads are removed when their connection is reopened or their tracking entry is read, while preserving the unknown-outcome guard. A single-record update is no longer treated as confirmed merely because current Salesforce values match the attempted values. Lost responses remain unknown unless a confirmed result was recorded.

Neither REST nor Composite write requests are automatically retried, including after authentication errors. Unknown outcomes remain blocked to prevent duplicate writes. Confirmed receipts and known results can still be reconciled automatically. There is no separate interrupted-upload review command or workflow. Lost create responses cannot be conclusively resolved without a server-side receipt. The upload journal is separate from encrypted draft recovery and does not provide Upload Recall.

## Limits and remaining work

- Sandboxes/Developer Edition and explicitly confirmed production connections are supported. Test with disposable records in a sandbox first.
- At most 500 submitted canvas records, including deletions. There is no longer a 25-operation restriction. Graph requests are split at 75 groups; earlier committed groups and deletions remain committed on later failures.
- Composite Graph additionally limits dependency depth to 15 and distinct object/operation combinations to 15. The planner checks these before writing. Cycles can be resolved when the deferred references are nullable and updateable. The planner adds follow-up PATCH requests inside the same Graph, preserving atomicity; required/non-updateable cycles still block planning. These extra operations count toward the 500-operation budget. Cyclic delete groups are skipped while unrelated deletions can proceed.
- Existing records must have a host-owned loaded baseline and LastModifiedDate; matched upserts establish that baseline during preflight. Read-only/encrypted/compound containers and specialized objects are not enabled. Clearing an ordinary writable field uses an explicit null value.
- A single update uses Salesforce's weak time-based conditional headers. Deletes and Graph uploads use optimistic preflight checks; Salesforce does not provide equivalent conditional Graph subrequests, and DELETE conditional headers are unsupported. A concurrent change between the last check and the write is still possible. This is not strict record locking.
- Rollback applies within a Graph group, not across the entire upload. Salesforce automation and cascade behavior still follow Salesforce's rules.
- Salesforce canvas save/load and Recall are deliberately excluded. Browsable activity history and Bulk API ingestion are not implemented. Interrupted-upload review is implemented with the limitations described above.

## Verification

Controlled tests cover linked creates, custom-object/multiple updates, reparenting, clearing lookups, child-first deletes, 76 independent creates, rollback, permission rejection, stale records after confirmation, invalid dependencies, cycles, size limits, receipt replay, unknown outcomes and local-journal failures. They forbid package/Apex/file-storage endpoints.

`tests/live-upload-acceptance.cjs` is opt-in via `ORGLOOM_WRITE_TEST_ALIAS`. It creates uniquely named disposable Account/Contact fixtures in a verified test org, tests native writes and recovery, and deletes only its own fixtures afterward. On 2026-10-22, the UAT test passed conditional updates, related creates, multi-record updates, reparenting, lookup clearing, completed-attempt replay, validation rollback and child-first deletion. The test blocked package, Apex and canvas/key storage endpoints. It ran in an org that already has the package installed; the evidence is that no package service or artifact was used, not a claim that the package was uninstalled. Report: `test-results/live-upload-acceptance.json`.

Earlier live tests exposed two Salesforce behaviors: independent Graph deletes do not establish the required child-first ordering, and conditional DELETE headers fail. Version 0.7.1 therefore uses the hosted app's sequential deletion scheduler and plain native DELETE requests. The hosted deletion suite also passed all 13 tests, including awaiting children, ancestor blocking, cycles and all three route integrations.

Version 0.7.1 live UAT acceptance passed connected-group rollback, independent-group partial success, child-first native deletions, conditional updates, relationships and receipt replay. All disposable fixtures were deleted. Controlled extension coverage also verifies 26 deletes, lost delete responses, per-operation journal failures, the skip-deletes-after-total-Graph-failure guard and retention of partial results.

Primary references: [Composite requests](https://developer.salesforce.com/docs/platform/api-rest/guide/requests-composite.html), [Composite limits](https://developer.salesforce.com/docs/platform/api-rest/guide/resources-composite-composite-post.html), [Graph limits](https://developer.salesforce.com/docs/platform/api-rest/guide/resources-composite-graph-limits.html), and [conditional headers](https://developer.salesforce.com/docs/platform/api-rest/guide/intro-rest-conditional-requests.html).

Version 0.7.2 verification adds controlled tests for External ID matching, typed/escaped keys, permission rejection, changed matches, linked and skipped parents, lost responses, duplicate alerts, blocking rules and cancellation. The actual VS Code webview imports a CSV as upsert, updates a matching record, displays a duplicate alert and retries the remaining row after review. Live UAT acceptance (`tests/live-upsert-acceptance.cjs`) uses the existing `OLQA_Project__c.Seed_Key__c` QA field to insert and update disposable records through Graph, verifies IDs and values, and verifies receipt replay. All disposable fixtures were removed. Salesforce accepted the duplicate-rule header in that live request; alert-versus-block behavior is covered by controlled tests, not a live rule change. Neither the original app nor pinned frontend source is modified.

Additional references: [External ID upserts](https://developer.salesforce.com/docs/platform/api-rest/guide/dome-upsert.html) and [duplicate-rule header](https://developer.salesforce.com/docs/platform/api-rest/guide/headers-duplicaterules.html).

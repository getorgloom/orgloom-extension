> Archived design notes. As of 0.9.39, the extension supports Salesforce CLI authentication only. Direct OAuth setup and commands described below have been removed; use [README.md](README.md) for current setup.

> Historical phase-two setup notes. Current behavior and command names are in README.md and DESKTOP-FEATURES.md. Version 0.7.0 adds encrypted draft recovery and explicitly confirmed production connections; the original test-only and memory-only constraints below no longer describe the current build.

# Phase two: direct Salesforce connection

## Status

The connection adapter supports direct OAuth and Salesforce CLI authentication. CLI authentication, Salesforce identity verification, Account metadata reads, restored connections, and recovery after a simulated expired access token passed against a real Developer Edition org on 2026-10-21 using Salesforce CLI 2.130.9 on Windows. Those initial authentication tests were read-only. **Version 0.5.0 live upload acceptance now passes on disposable records.** See [UPLOADS.md](UPLOADS.md) for the package-independent upload architecture, limits and evidence. The phase-two exit gate is not yet complete: managed-package canvas save/reopen compatibility also remains unimplemented.

The original integration repository, package source, production OAuth application, and production settings are unchanged. All adapters live in this separate repository. The pinned canvas snapshot is unchanged and verified by the build.

## Salesforce CLI authentication

Install version 0.5.0, reload VS Code, and run **Org Loom: Connect with Salesforce CLI**. Select an existing CLI org or choose **Sign in to another test org…** to authorize through the CLI's browser flow. This route does not need the separate desktop ECA below. It uses the locally installed `sf` CLI; an old installation with only the `sfdx` executable must install the current Salesforce CLI. Org policies still control access.

The CLI is the sole owner of its refresh tokens. Org Loom obtains an access token through CLI commands, verifies the user/org and sandbox/Developer Edition status, and calls Salesforce directly from the extension host. The persisted connection contains only a username and verified identity. Reopening obtains another access token from the CLI. A 401 triggers a serialized CLI renewal, followed by fresh identity verification before retrying once. A different org, user, or host is rejected. Raw CLI stdout/stderr is never shown in notifications.

Disconnecting Org Loom removes its selected connection without logging other CLI tools out. The default CLI org is never changed. Existing CLI authorizations may appear in the picker even when expired; reconnect through the browser if verification fails. This integration is not a claim of Salesforce partner/security-review approval.

## Create a separate test External Client App (optional alternative)

Do this in a disposable Developer Edition org or sandbox. Keep the existing hosted Org Loom app unchanged. For this spike, creating the local External Client App in the same test org avoids introducing cross-org distribution requirements.

1. Open Salesforce Setup → External Client App Manager → New External Client App. Use a distinct name such as **Org Loom Desktop Test** and your contact email.
2. Enable OAuth and register this exact callback: `http://localhost:1718/oauth/callback`.
3. Enable **Require Proof Key for Code Exchange (PKCE) extension for Supported Authorization Flows**.
4. For this separate public desktop client, deselect **Require secret for Web Server Flow**. Do not put a consumer secret in the extension. If the settings expose **Require secret for Refresh Token Flow**, the desktop client must also be allowed to refresh without a secret.
5. Grant `api`, `refresh_token` / `offline_access`, and identity (`id`, shown as basic identity access) scopes. This prototype verifies the signed-in user and org through Salesforce userinfo.
6. Keep refresh token rotation enabled if available. Authorize only your test user under the org's policies. Do not copy the hosted service's Render-only IP allowlist: desktop requests originate from the user's machine and must satisfy the test org's own network policies.
7. Copy the **Consumer Key**. Do not copy the Consumer Secret into chat, settings, source code, or a VSIX.

This follows the public-client PKCE pattern in Salesforce's [Data Loader External Client App guide](https://developer.salesforce.com/docs/platform/data-loader-impl/guide/loader-eca-oauth-pkce.html). It is a test configuration, not a claim of Salesforce partner/security-review approval.

## Open it in your local VS Code

1. Install `orgloom-vscode-0.5.0.vsix` using Extensions → … → Install from VSIX. Reload VS Code if prompted. The next two steps apply to direct OAuth; CLI users can follow the section above and continue at step 4.
2. Use View → Command Palette and run **Org Loom: Configure Test Org**. Enter the separate app's Consumer Key and the test org's My Domain HTTPS origin (or `https://test.salesforce.com` for sandbox login).
3. Run **Org Loom: Connect Test Org**. Sign in through the system browser. The callback listener binds only to 127.0.0.1, accepts the expected OAuth state, and closes on completion, cancellation, or timeout.
4. On success, **Org Loom · Test Org** opens with a blank canvas. The banner identifies the test org and warns that unsaved edits are memory-only.
5. Use **+ Add records → Browse records** or **Import via SOQL query**. Example: `SELECT Id, Name FROM Account LIMIT 1`. Standard and custom objects come from the connected org’s queryable object directory; queries load at most 50 records. Filtered browse and subqueries are not yet ported. You can also add blank records and select an object to create drafts.
6. Double-click an existing record and edit a writable field. Only test records should be used. Saving the draft changes the canvas; it does not write Salesforce.
7. Select the records to create, update or delete, review the canvas upload selection, and choose **Upload**. This confirms the write; there is no additional native VS Code upload dialog. See [Desktop uploads](UPLOADS.md) for limits and recovery behavior.
8. Confirm the field in Salesforce. **Org Loom: Disconnect Test Org** removes Org Loom's local connection. For direct OAuth, it removes locally stored tokens; use Salesforce OAuth Usage to revoke the app's authorization if desired. For CLI authentication, the CLI login remains available to other tools.

The prototype rejects production orgs after verifying Organization.IsSandbox / OrganizationType. A Developer Edition org is still capable of containing meaningful data; use disposable test records.

## Original phase-two data path and safeguards (upload details superseded by UPLOADS.md)

- Webview → validated message adapter → local extension host → Salesforce HTTPS APIs. No Org Loom hosted service is involved.
- PKCE S256, random OAuth state, fixed loopback callback, timeout, no embedded client secret. Login and instance origins are restricted to supported Salesforce domains. Redirects are not followed with credentials.
- Direct OAuth access/refresh tokens stay in extension memory and VS Code SecretStorage. CLI credentials remain owned by the CLI: Org Loom keeps only an access token in extension-host memory, and persists a username/identity selection. Tokens are never passed into HTML, webview messages, globalState, diagnostics, or the source tree. See [VS Code SecretStorage](https://code.visualstudio.com/api/references/vscode-api#SecretStorage).
- A process lease prevents two windows in the same profile from concurrently using rotating tokens. Concurrent requests share one refresh. Ambiguous refresh failures remove the local session and require reauthorization; the same refresh token is not retried.
- The connected webview substitutes memory-only Storage objects for browser storage. It has no direct network access. It does not use sample checkpoints. Closing the connected tab loses unsaved work; no serializer silently restores sensitive records.
- Salesforce handles permissions under the current user's OAuth token. The adapter additionally checks object/field updateability and UserRecordAccess before a write. It uses a host-owned loaded baseline and rechecks LastModifiedDate. The PATCH includes [If-Unmodified-Since](https://developer.salesforce.com/docs/platform/api-rest/guide/intro-rest-conditional-requests.html); this is Salesforce's weak time-based concurrency control, not a claim of perfect transaction isolation.
- Originally only one existing record could be updated. Version 0.5.0 replaces that implementation with native create/update/delete and relationship uploads; see [Desktop uploads](UPLOADS.md). Upsert, encrypted fields and Bulk API remain unsupported. Host checks remain authoritative.
- Before PATCH, an intent marker is saved in SecretStorage, including the target and proposed values. An unknown outcome blocks later writes across restarts. **Check Last Test Upload** compares Salesforce values and clears the marker only if all attempted values match. If they differ, the marker stays blocked for manual investigation. This is not the hosted upload ledger or Upload Recall.
- Version 0.3.0 uses REST describe and UI API for field permissions, page-layout sections and ordering, available record types, and record-type/dependent picklist values. Unsupported UI API objects explicitly fall back to describe fields. Metadata stays in memory per connection; reopen the canvas after metadata changes. Lightning components, Dynamic Forms conditions, lookup filters and validation-rule definitions are not reproduced. Salesforce enforces validation on write.

## Tests and evidence

`npm test` exercises origin validation, real loopback callback state/PKCE/timeout handling, production-org rejection, refresh concurrency and rotation, changed identity, message boundaries, baseline conflict, permission denial, cancelled uploads, unsupported writes, and unknown outcomes. CLI tests cover both token-output formats, shell-free process invocation, redacted errors, safe org lists, selection-only persistence, restore, identity changes, and disconnect/refresh races. All network responses other than local OAuth callbacks in this suite are controlled fixtures.

`npm run test:extension` runs the original sample smoke test and a connected-mode UI test in desktop VS Code. The latter loads an Account through SOQL, edits through the original form, opens the upload review, and verifies one PATCH via the adapter. Its confirmation callback is controlled by the test; it does not authorize any real Salesforce write. Evidence is in `test-results/connected-adapter-report.json` and `04-connected-adapter.png`.

Do not interpret these tests as live Salesforce acceptance, comprehensive field compatibility, or CA/ECA compliance certification.

For an opt-in live, read-only desktop CLI smoke test, set `ORGLOOM_TEST_CLI_ALIAS` to an already-authorized sandbox/Developer Edition alias before running `npm run test:extension`. It drives the actual CLI command and org picker, reads metadata through the connected webview, imports one custom-object record and opens its editor, and disconnects while confirming the CLI login remains. The live test requires a populated custom object (preferring OLQA_Project__c in UAT). Its report and screenshot are `test-results/cli-connection-report.json` and `05-cli-connected.png`. It never writes Salesforce records. Leave the variable unset for the regular controlled test suite.

## Required live acceptance and remaining work

### Version 0.4.0 related records

The local adapter now implements single/batched relationship counts, full-field child loads, and related-record search. Existing parent retrieval is retained. Find related uses the original canvas UI to add records and their lookup edges, including custom objects. Relationship fields must be accessible, reference-typed and filterable. Counts support up to 200 probes per request; repeated probes share work and descriptions within a batch. A shared queue limits active relationship operations to four. Child loads default to 50 records and cap explicit requests at 200, matching the frontend confirmation. Salesforce query continuations are validated and followed when full-field responses span pages.

Background reads do not overwrite existing upload baselines. Unsupported relationship counts are marked skipped individually; authentication and transport errors are not reported as successful counts. The inherited frontend caches counts for the lifetime of the canvas, including its handling of failed counts. Reopen the canvas to retry failed counts or refresh external changes. These read operations do not broaden upload permissions or enable saved canvases.

Six new controlled tests cover reference/field validation, search escaping, count deduplication, query continuation safety, concurrency, disconnect, and baseline preservation. The desktop adapter test also loads a Contact from an Account through Find related before its controlled edit/upload flow. The opt-in live CLI test now checks populated custom-child counts/search and loads those records through the actual Find related menu; it remains read-only.

On 2026-10-22, all 42 automated tests and the desktop UI suite passed. The live orgloom-uat CLI test imported an OLQA_Project__c record, opened its actual editor, counted/searched its OLQA_Issue__c children through Project__c, and loaded two issues with their relationship edges using Find related. No Salesforce records were written. Evidence: `test-results/cli-connection-report.json` and `test-results/06-cli-related.png`. The first UI attempt used an incorrect Cancel-button selector in the new test; correcting that selector produced the passing run.

### Version 0.3.0 metadata verification

The packaged extension passed the desktop sample and controlled edit/upload flows, followed by a read-only CLI session against orgloom-uat. The connected directory returned 1,085 queryable objects. OLQA_Project__c exposed 30 fields (18 custom), its actual Salesforce layout, two picklists and 50 schema relationships. One existing custom record was imported and opened in the actual editor. No Salesforce writes were performed. The live object has one master record type; multiple record types, switching layouts, dependent picklists and field-permission projection were validated with controlled fixtures rather than claimed as live acceptance. Unsupported UI API fallback was also exercised in the desktop editor.

### Saved-canvas portability finding

The existing `storage/canvas-store.js` saves an OLE2 encrypted body in Salesforce ContentVersion and calls `database/canvas-keys.js` to persist the wrapped per-canvas data key in the application database. The protected key-encryption key itself is held by the managed package and accessed through Apex. Having access to the Salesforce file therefore does not by itself give this standalone extension the wrapped-key metadata required to decrypt it.

A compatible server-independent design needs a reviewed way to transfer existing wrapped-key metadata or store it with appropriate authorization in Salesforce. Simply minting a new local key would not make hosted canvases readable and could create incompatible saves. This prototype does not change the package, hosted key storage, or canvas format. Resolve that boundary before enabling Save; it is not merely an unported button handler.

### Acceptance checklist

1. Authorize through Salesforce CLI or the separate test app; confirm the displayed user/org. CLI identity/metadata/restore/401 recovery is verified; direct OAuth live acceptance is separate.
2. Load a disposable record, edit a field, confirm one upload, and verify the value in Salesforce.
3. Test stale-record rejection, denied field/record permissions with a limited user, token refresh/rotation, and sign-in recovery. Inspect outbound destinations without logging tokens or record values.
4. Superseded by the October 22 product decision: Salesforce canvas save/load, sharing and Upload Recall stay exclusive to the managed-package version. They are not extension parity requirements.
5. Narrow and expanded live upload acceptance passed in v0.5.0. Use BACKLOG.md for the current implementation order; Browse/SOQL is implemented in v0.6.0.

Live acceptance can use an authorized CLI test org or the dedicated OAuth app. Package compatibility is outside the current extension scope. The key-portability findings above are retained for historical context.

### Version 0.6.0 Browse/SOQL

See BROWSE-SOQL.md for implementation details and BACKLOG.md for remaining work. Live read-only acceptance on October 22 verified Browse pagination across 177 Accounts, exact-ID search, overlap counts, selected-ID import, a nested Account/Contact query (12 records, 7 links), and custom-object import. All 33 native REST requests were reads; writes were blocked by the test transport.

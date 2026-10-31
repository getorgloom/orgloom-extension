> Archived design notes. As of 0.9.39, the extension supports Salesforce CLI authentication only. Direct OAuth setup and commands described below have been removed; use [README.md](README.md) for current setup.

# Phase one: isolated local canvas feasibility

## Goal

Prove that the existing Org Loom canvas can run inside a local VS Code webview with fictional data and no Org Loom server dependency, without changing the existing web application.

## Implementation boundary

The frontend snapshot is pinned to integration-repository commit `1c14d66c35afe85e091a88946ca198a0e9e0df84`. Only tracked canvas browser assets, the source shell, and the canvas license were exported. Runtime adaptations live outside the snapshot. A checked-in source manifest verifies its hashes at build time.

The existing standalone Node server was deliberately not started. It currently assumes HTTP sessions, OAuth redirects, a port listener, database initialization, and native SQLite support. None of those are needed to establish canvas UI feasibility. A local service remains an option for a later phase, but must not be added merely to make the frontend prototype work.

## Decisions

1. Use the real Cytoscape canvas, record forms, and existing mock Salesforce adapter, rather than rebuilding the UI.
2. Bundle assets into a webview with no network permissions. Do not embed orgloom.com.
3. Keep extension messaging limited to sample-state persistence and a confirmed sample reset. No generic command executor, filesystem bridge, or arbitrary URL proxy.
4. Retain the original snapshot verbatim. Use an extension-specific shell and startup adapter.
5. Keep build and test tools out of the VSIX. Package only the extension host code, required browser assets, documentation, provenance, and licenses.
6. Use a separate VS Code test installation and user-data directory. The installed VS Code copy was locked by its updater during the first attempt; no changes were made to that installation.

## Remaining architectural work

- Inventory the real API routes the canvas needs and define a narrow, validated message protocol to local Salesforce operations. The mock adapter is not that implementation.
- Design and validate desktop Salesforce OAuth using a separate test External Client App. Never embed the hosted client secret or alter production policies for this prototype.
- Keep access tokens and refresh tokens out of webview messages, sample-state persistence, diagnostics, and logs.
- Choose production record-recovery storage and retention behavior. Sample global-state persistence is not suitable as the final policy for sensitive records.
- Evaluate reuse of core backend services without loading the existing top-level server. Test runtime compatibility and native dependencies before choosing a helper-process strategy.
- Reassess script execution isolation before enabling Run Script. A desktop port must not elevate canvas scripts to extension-host privileges.
- Establish saved-canvas compatibility using disposable test canvases and the existing managed package before touching user work.
- Keep licensing independent of Salesforce record processing. Defer collaboration and AI until their data paths are explicitly defined.

## Release gate for phase two

Complete direct authentication to a test org, read records, edit a disposable record, explicitly upload, save a disposable canvas, and reopen it. Verify failure/reconnect behavior and trace network traffic. Do this entirely in this repository with test credentials and storage; propose any shared-core changes separately.

## Verification

Automated tests and screenshots are generated in `test-results/`. The test suite exercises the extension inside desktop VS Code 1.140.0, not only in a standalone browser.

Observed on Windows on 2026-10-21:

- Real canvas displays five fictional records and their connections.
- Actual card dragging works.
- Actual record editor opens, accepts a changed Account name, and changes the card to modified.
- Unsaved edits survive disposing and recreating the VS Code tab through extension-local checkpoint storage.
- Mock SOQL responds locally; an attempted outbound fetch is rejected.
- No requests to Org Loom, Salesforce, PostHog, or Sentry were observed in the workbench network capture during the scenario. Local webview assets use VS Code's resource scheme; VS Code itself may contact Microsoft services independently of the extension.
- Three focused boundary tests pass: network-denying shell, safe embedded checkpoint data, and bounded/validated persistence messages.
- The same desktop smoke scenario passes against the extracted VSIX contents, independently of the development tree. The package contains 111 entries (about 1.9 MiB), including provenance and licenses, with no node_modules, test profiles, test results, or environment files.
- npm audit reports zero vulnerabilities after updating the packaging tool to its current major version. Runtime dependencies are only the two rendering libraries; no native database is needed for this phase.

Limitations found during the spike:

- The original app requires presence and AI proposal module interfaces even in fictional-data mode. Omitting them stops startup. Keep them locally available while blocking remote transports; separate their interfaces from their transports in a later adapter design.
- Website URL-based canvas launch cannot be relied on in the webview. The prototype bootstraps via the existing recovery-state format, with a small extension-owned sample fixture adapter.
- The website initially centers its first card, which crops lower records in an editor tab. An extension-owned renderer wrapper supplies initial fitting and an explicit Fit canvas button.
- Mock API coverage is incomplete for workspaces, record-access checks, and validation-rule metadata. These return local 501 responses. The tested editing flow still works; this is not evidence about production authorization or Salesforce validation behavior.
- VS Code 1.140.0's own webview focus-tracking code can emit a `contentDocument.body.classList` error while a frame is being created. The location matches line 66 of VS Code's `webview/browser/pre/index.html`; it does not originate in the canvas. Keep this visible in the report rather than claiming an error-free console.
- Real Salesforce calls, token handling, durable production recovery, simulated-upload correctness, full keyboard coverage, multiple windows, and other operating systems are not validated by this phase.

## Assessment

The UI feasibility milestone is achieved without changes to upstream canvas source, a local server, or a database runtime. The next uncertainty is adapting authenticated backend operations and desktop OAuth, not recreating the canvas interface. The earlier overall estimate should remain provisional until that next milestone is tested.

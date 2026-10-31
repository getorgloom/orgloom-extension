# Desktop features through 0.9.0

This development build adds native files, encrypted local recovery, restricted scripts and confirmed production connections. It is not a Marketplace release or full hosted-app parity. See BACKLOG.md for unfinished work.

## Import and export

Use Add records to import CSV or JSON. The extension opens a native file picker; it accepts at most 20 local files totaling 10 MiB. Existing field-mapping and linked-CSV screens run locally. Version 0.7.2 supports CSV upsert with an accessible, writable External ID field; review its matching, permission and transaction limits in UPLOADS.md.

The Export menu can export a portable JSON canvas or record CSV through a native save dialog. Exported files contain plaintext record values and are saved wherever you choose. They are separate from managed-package saved canvases. The webview cannot supply arbitrary file paths. File drag/drop is disabled; use the picker. Native save cancellation does not write a file even if an inherited download toast appears.

## Local recovery

Recovery is off by default. On first opening a connected canvas, choose **Enable recovery** or **Not now**; dismissing the prompt also leaves it off. The prompt is not repeated. Use the user-level VS Code setting **Org Loom: Local Recovery: Enabled** (`orgloom.localRecovery.enabled`) to change your choice later. Workspace settings cannot enable it. Turning it off deletes checkpoints and keys across the extension's stored org/user identities without clearing the open canvas. Existing checkpoints from earlier versions are removed when recovery is off. Enabling recovery starts saving as the canvas next writes its recovery state.

Connected-canvas autosave checkpoints and loaded-record baselines are encrypted with AES-256-GCM in the extension's local storage directory. Each org/user identity has a separate snapshot and encryption key stored in VS Code SecretStorage. These are local recovery copies of Salesforce data, not Org Loom server storage. Restoring a canvas does not bypass upload conflict checks or Salesforce permissions.

Reopening or reloading prompts to Restore or Discard. Current Salesforce object, field and record access is checked before rendering restored data. Removed access strips that content from the checkpoint and view; authentication/network failures block restore and preserve the file. Closing a tab keeps its checkpoint; disconnecting discards local recovery for that identity. Snapshots older than seven days cannot be loaded. Expired files and keys are cleaned on activation and daily while VS Code is running, including identities never reopened. Cleanup cannot run while VS Code is closed and catches up at next launch. A missing key or damaged snapshot is reported instead of silently loading an empty canvas. Clearing VS Code's credentials can make recovery unreadable.

Every webview document receives a fresh writer token only after recovery completes. Old documents and out-of-order checkpoints cannot replace newer state. The connected canvas registers for VS Code panel restoration; only org/user identifiers are serialized in VS Code panel state. Upload baselines retain their original timestamps after restoration, so intervening Salesforce edits still trigger conflict checks.

Recovery is best effort: the upstream autosave is debounced, so a crash can lose the latest edits before a checkpoint. The banner reports recovery failures. Snapshots allow 4 MiB of canvas state and 12 MiB including baselines. Export JSON for an intentional portable copy. This is one recovery snapshot per identity, not a library of locally saved canvases.

## Run Script

Tools → Script opens the existing restricted record language, interpreted in a separate local worker. It supports the canvas scripting helpers rather than unrestricted JavaScript. Scripts cannot access Node.js, the filesystem, network, shell or credentials. Limits include 500 records, 20,000 source characters, a 2 MiB input/output budget, a two-second wall-clock timeout, the interpreter's step limit and a bounded worker heap.

Preview computes changes without applying them. Apply requires that the canvas still matches the preview input. Cancel or an error leaves the canvas unchanged. Undo also refuses to overwrite later record/relationship edits. Scripts change scalar record values; they cannot create/delete records or change record identity. Upload remains a separate confirmed action.

## Production and navigation

Org identity/type is verified directly with Salesforce. A production org requires a native confirmation for the org/user on every new extension-host session. Its tab, banner and upload button say PRODUCTION; uploads are confirmed in the canvas review without a second native dialog. CLI login remains owned by the Salesforce CLI. Command titles now say Salesforce rather than Test; internal command IDs remain compatible.

Explicit record links open the browser only for the connected Salesforce origin and a record path. Documentation links are restricted to orgloom.com/docs. Arbitrary external URLs and command/file links are rejected. Normal canvas API calls still go directly to Salesforce, not Org Loom.

## Metadata and remaining scope

Validation-rule definitions use native Tooling API reads with four concurrent detail requests and a 200-rule cap. Restricted/unsupported access returns unavailable rather than an empty rules list. Salesforce remains authoritative on upload. Lookup filters are not yet reproduced in suggestion lists.

AI and MCP are disabled by user decision. Sharing, Upload Recall and Salesforce canvas save/load remain native-only. File-based migration is implemented. Version 0.7.1 resolved delete batching by adopting hosted Graph groups followed by sequential deletions; 0.7.2 added External ID upserts and explicit duplicate-alert retries. Unknown uploads are not automatically retried. Production confirmation is covered with fixtures; this build has not written to a production org.

# Org Loom for VS Code

Org Loom is a visual workspace for creating, editing, and reviewing related Salesforce records in VS Code. Work with individual record forms on one canvas, see their relationships, and review your changes before uploading them to Salesforce.

## Features

- Find existing records with Browse records or SOQL, then use **Find related** to bring related records onto the canvas.
- Create drafts, edit existing records, and mark records for deletion. Review validation results before uploading.
- Import and export local CSV and JSON files, including migration files with record matching and field mapping.
- Transform canvas records with scripts, with optional preview and undo.
- Restore work from encrypted local recovery checkpoints.

Saving canvases in Salesforce, sharing canvases, and Upload Recall are available in the separate [Org Loom managed package](https://orgloom.com/install).

## Requirements and supported platforms

- **VS Code desktop 1.100.0 or later.** Use a trusted workspace; untrusted and virtual workspaces are not supported.
- A Salesforce org that supports API access and a user with the permissions listed below.
- The current **Salesforce CLI (`sf`)** for sign-in. The Salesforce VS Code extensions and a Salesforce project are not required.

| Environment | Support status |
| --- | --- |
| Windows desktop | Tested with Salesforce connection, canvas, and upload workflows. |
| macOS and Linux desktop | Not yet validated end to end. Automated tests alone do not establish full platform support. |
| Remote SSH, WSL, Dev Containers, and Codespaces | Not yet validated. The extension requests execution in the local desktop UI host, so a CLI installed only on the remote host is insufficient. |
| Browser VS Code, including vscode.dev and github.dev | Not supported. The extension requires a desktop extension host. |

## Install and connect

### 1. Install the extension and Salesforce CLI

To install a downloaded `.vsix`, open the Command Palette and run **Extensions: Install from VSIX…**, select the file, and reload VS Code when prompted.

Install [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli), then fully quit and reopen VS Code so it picks up the updated PATH. In a local terminal, verify the installation:

```sh
sf --version
```

### 2. Authorize your org

Run **Org Loom: Connect with Salesforce CLI** from the Command Palette. Select an already authorized org or choose **Sign in to another org…** to authorize one in your browser.

You can also authorize an org from a terminal, even outside a Salesforce project:

```sh
# Sandbox
sf org login web --instance-url https://test.salesforce.com --alias orgloom-sandbox

# Production or Developer Edition
sf org login web --instance-url https://login.salesforce.com --alias orgloom-org
```

For an org that requires My Domain or SSO, replace the instance URL with its Salesforce My Domain login URL. See Salesforce's [browser authorization documentation](https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-dev-auth-web-flow.html).

Return to **Org Loom: Connect with Salesforce CLI** and select the authorized account. Production connections require an explicit confirmation. Org Loom does not change your default CLI org.

### 3. Work with your records

Use **Add records** to browse or query Salesforce, and **Find related** to add parents or children. Edit records or create drafts, then select **Upload to Salesforce** to review and submit changes.

Use **Org Loom: Open Salesforce Canvas** to reopen the remembered connection. **Org Loom: Disconnect Salesforce Org** disconnects Org Loom but leaves the CLI authorization intact. To remove that authorization separately:

```sh
sf org logout --target-org <username-or-alias>
```

## Required Salesforce permissions

A System Administrator profile is not required. Ask your Salesforce administrator to grant only the access needed for your work.

| Task | Required access |
| --- | --- |
| Connect | An API-enabled Salesforce org, **API Enabled**, and **View Setup and Configuration**. Org Loom reads org information to verify the connection. |
| View records | **Read** on the object, readable fields through field-level security, and access to the individual records through Salesforce sharing and ownership rules. |
| Create records | **Create** on the object and permission to populate the submitted fields. |
| Update records | **Edit** on the object, edit access to the record, and writable fields. |
| Delete records | **Delete** on the object and permission to delete the individual records. |
| Authorize a connection | Any additional OAuth app approval or access required by your org's policies. |

Org Loom managed-package permission sets are not required for the extension. The extension uses the connected user's access and does not bypass object permissions, field-level security, record sharing, validation rules, or blocking duplicate rules.

### Connection troubleshooting

- **CLI not found:** confirm `sf --version` works on the computer running VS Code, then fully restart VS Code.
- **Your org is missing from the chooser:** authorize it with the same operating-system account and local CLI installation that VS Code uses.
- **Connection rejected or `INVALID_TYPE`:** confirm API access and **View Setup and Configuration**, then reconnect. If the error persists, include the failing operation when reporting it; this Salesforce error can have more than one cause.
- **Missing records or fields:** check object permissions, field-level security, record sharing, and the selected org/user. Reconnect after metadata or permission changes.

### Available commands

- **Org Loom: Connect with Salesforce CLI** — select an authorized org or sign in through the CLI.
- **Org Loom: Open Salesforce Canvas** — reopen your remembered CLI connection.
- **Org Loom: Disconnect Salesforce Org** — disconnect Org Loom while leaving CLI authorization intact.

The extension connects only through Salesforce CLI. It does not require an Org Loom External Client App or Consumer Key. If you previously used direct OAuth, reconnect through **Org Loom: Connect with Salesforce CLI**; the old saved connection is removed when you try to reopen it.

## Data handling and limits

Salesforce requests run in the extension host. The canvas webview does not receive Salesforce access tokens. Salesforce CLI manages authorization, and the extension uses access tokens in memory. Only the selected username and verified org/user identity are remembered in VS Code SecretStorage; CLI tokens are not copied there. No Org Loom hosted service is required.

Local recovery is off by default. The first time you open a connected canvas, choose **Enable recovery** or **Not now**. Your choice is remembered. You can change it in VS Code Settings under **Org Loom: Local Recovery: Enabled** (`orgloom.localRecovery.enabled`). Enabling it stores encrypted canvas checkpoints locally, with keys in VS Code SecretStorage. Disabling it deletes existing recovery copies and keys for all Org Loom connections in this VS Code profile, while keeping your open canvas intact. Older automatic checkpoints are also removed when recovery is off.

When enabled, checkpoints are saved after a delay and may not include the most recent edits after a crash. Export a CSV or JSON file when you need a durable copy. **Exported files are plaintext** in the location you choose.

Uploads support up to **500 submitted records**. Connected create/update groups commit separately, and deletes run afterward in child-first order. Successful changes can remain saved when another group fails. Upload Recall is not available in the extension.

Salesforce UI API does not support every object or screen customization. Where necessary, Org Loom falls back to accessible REST describe fields. Lightning components, Dynamic Forms visibility, and lookup filters are not reproduced. Salesforce validates submitted changes.

See [upload behavior and limits](UPLOADS.md), [Browse and SOQL](BROWSE-SOQL.md), and [files, scripts, and recovery](DESKTOP-FEATURES.md) for details.

## Build from source

Use Node.js 24 and npm:

```sh
npm ci
npm run build
npm test
npm run package
```

The package command produces a local `.vsix`; it does not publish to the Marketplace. To build a Marketplace pre-release artifact after building the extension:

```sh
npx vsce package --no-dependencies --pre-release
```

This repository receives verified source snapshots from the canonical Org Loom repository, where development takes place in `orgloom-extension/`. The build verifies the pinned canvas source against `vendor/source-manifest.json` before producing bundled assets.

## Support and license

Report bugs through [GitHub Issues](https://github.com/j-orgloom/orgloom-extension/issues). Do not include credentials or sensitive Salesforce data. Report security concerns privately to security@orgloom.com.

See [CHANGELOG.md](CHANGELOG.md) for release notes. Org Loom extension code uses the [PolyForm Internal Use License 1.0.0](LICENSE), matching the canvas license. Third-party dependencies retain their own licenses.

# Org Loom for VS Code

Org Loom is a visual workspace for your Salesforce records. It allows you to bring existing records and new drafts onto one canvas, see how they relate, and prepare changes together without switching between record pages and spreadsheets. When you are ready, upload your changes to Salesforce. Explore the [documentation](https://orgloom.com/docs) to learn more.

## Features

- Bring records onto the canvas through existing records search, CSV, JSON or SOQL
- Create draft records or update existing ones through the canvas interface
- Bulk update through a point and click field replacement interface or your own JavaScript
- Export to CSV or JSON
- Automatically populate test data
- Search all canvas records for specific data
- Export and migrate to another org while reconciling org metadata differences

Saving canvases in Salesforce, sharing canvases, and Upload Recall are available in the separate [Org Loom managed package](https://orgloom.com/install).

## Requirements and supported platforms

- **VS Code desktop 1.100.0 or later.** Use a trusted workspace; untrusted and virtual workspaces are not supported.
- A Salesforce org that supports API access and a user with the permissions listed below.
- The current **Salesforce CLI (`sf`)** for sign-in. The Salesforce VS Code extensions and a Salesforce project are not required.

## Install and connect

### 1. Install the extension and Salesforce CLI

Choose one of these installation options:

1. **Install from terminal**

   ```sh
   code --install-extension GreyloopCodingLLC.orgloom-vscode
   ```

   VS Code must be installed with the `code` command available in your terminal.

2. **Download and install a `.vsix` file**

   Org Loom is listed on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=GreyloopCodingLLC.orgloom-vscode). To download its `.vsix` file:

   - In VS Code, open **View → Extensions** and search for **Org Loom**.
   - Right-click the Org Loom result from **GreyloopCodingLLC** and select **Download VSIX**. Save the file to your computer.
   - Open **View → Command Palette…** and run **Extensions: Install from VSIX…**.
   - Select the downloaded `.vsix` file and reload VS Code if prompted.

3. **Install through VS Code's Extensions panel**

   - Open VS Code and select **View → Extensions**.
   - Search for **Org Loom**.
   - Select the extension from **GreyloopCodingLLC** and click **Install**. Confirm publisher trust if prompted.
   - Reload VS Code if prompted.

**Then install Salesforce CLI:**

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

Return to **Org Loom: Connect with Salesforce CLI** and select the authorized account. Production connections require an explicit confirmation. Org Loom does not change your default CLI org.

### 3. Work with your records

Use **Add records** to browse or query Salesforce, and **Find related** to add parents or children. Edit records or create drafts, then select **Upload to Salesforce** to review and submit changes.

Use **Org Loom: Open Salesforce Canvas** to reopen the remembered connection. **Org Loom: Disconnect Salesforce Org** disconnects Org Loom but leaves the CLI authorization intact.

## Required Salesforce permissions

Ask your Salesforce administrator to grant only the access needed for your work.

| Task | Required access |
| --- | --- |
| Connect | An API-enabled Salesforce org, **API Enabled**, and **View Setup and Configuration**. Org Loom reads org information to verify the connection. |
| View records | **Read** on the object, readable fields through field-level security, and access to the individual records through Salesforce sharing and ownership rules. |
| Create records | **Create** on the object and permission to populate the submitted fields. |
| Update records | **Edit** on the object, edit access to the record, and writable fields. |
| Delete records | **Delete** on the object and permission to delete the individual records. |
| Authorize a connection | Any additional OAuth app approval or access required by your org's policies. |

The extension uses the connected user's access and does not bypass object permissions, field-level security, record sharing, validation rules, or blocking duplicate rules.

### Connection troubleshooting

- **CLI not found:** confirm `sf --version` works on the computer running VS Code, then fully restart VS Code.
- **Your org is missing from the chooser:** authorize it with the same operating-system account and local CLI installation that VS Code uses.
- **Connection rejected or `INVALID_TYPE`:** confirm API access and **View Setup and Configuration**, then reconnect. If the error persists, include the failing operation when reporting it; this Salesforce error can have more than one cause.
- **Missing records or fields:** check object permissions, field-level security, record sharing, and the selected org/user. Reconnect after metadata or permission changes.

### Available commands

- **Org Loom: Connect with Salesforce CLI** — select an authorized org or sign in through the CLI.
- **Org Loom: Open Salesforce Canvas** — reopen your remembered CLI connection.
- **Org Loom: Disconnect Salesforce Org** — disconnect Org Loom while leaving CLI authorization intact.

## Support and license

Report bugs through [GitHub Issues](https://github.com/j-orgloom/orgloom-extension/issues). Do not include credentials or sensitive Salesforce data. Report security concerns privately to security@orgloom.com.

Learn how the extension protects your connection and handles your data in the [extension security guide](https://orgloom.com/docs/security-and-data?version=vscode).

See [CHANGELOG.md](CHANGELOG.md) for release notes. Org Loom extension code uses the [PolyForm Internal Use License 1.0.0](LICENSE), matching the canvas license. Third-party dependencies retain their own licenses.

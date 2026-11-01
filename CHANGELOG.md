# Changelog

## 0.9.44

- Updated the README platform table. No runtime changes.

## 0.9.43

- Released the current extension as a stable Marketplace build, without the pre-release flag. Includes opt-in encrypted recovery and minimized upload tracking.

## 0.9.42

- Repackaged the current extension for installation, including opt-in encrypted recovery and minimized upload tracking from 0.9.40–0.9.41. No additional runtime changes.

## 0.9.41

- Removed submitted field values from pending upload tracking; retained identifiers, request hashes, operation types, and outcome tracking.
- Removed value-based inference of success for uncertain single-record updates. Unknown outcomes remain blocked from automatic replay.
- Strip older pending field payloads when reopening the connection or reading tracking entries, without clearing their unknown-outcome protection.

## 0.9.40

- Made local canvas recovery opt-in with a one-time prompt when a connected canvas first opens.
- Added a user-level setting to enable or disable encrypted recovery. Disabling removes stored recovery copies and keys while keeping the open canvas intact.
- Prevented queued writes and restore results from surviving a change to the recovery preference.

## 0.9.39

- Made Salesforce CLI the only connection method. Removed direct OAuth commands, settings, and desktop token exchange/refresh.
- Old direct OAuth connections now clear their saved credentials and prompt for CLI sign-in when reopened.
- Retained CLI account selection, browser sign-in through the CLI, connection restore, and disconnect.

## 0.9.38

- Added the Org Loom PNG icon and website/support metadata for the extension listing.
- Reworked the README with Salesforce CLI setup, required permissions, supported-platform status, and user-facing workflow documentation.
- Made the native file-picker test use host-platform paths so it runs consistently on Windows and Linux.

## 0.9.37

- Updated the Upload Recall message to explain how to install the managed package for reviewing and reversing eligible uploads.

## 0.9.36

- Fixed script Apply so it works without running Preview first, while preserving undo and checks for changes made while the script runs.

## 0.9.35

- Removed the script editor's Cancel run button and updated button styling.
- Restored the Opportunity example with an object-type condition.

## 0.9.34

- Removed the CSV export explanation about empty-field markers. Exported files continue to preserve explicit blanks on re-import.

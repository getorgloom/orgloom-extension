'use strict';

const SETTING = 'orgloom.localRecovery.enabled';
const PROMPTED = 'localRecovery.prompted';

class RecoveryPreference {
  constructor(vscode, context, purge) {
    this.vscode = vscode;
    this.context = context;
    this.purge = purge;
    this.enabled = this.selection() === true;
    this.revision = 0;
    this.queue = Promise.resolve();
  }

  selection() {
    // Consent belongs to this user's application settings, never a workspace.
    return this.vscode.workspace.getConfiguration('orgloom').inspect('localRecovery.enabled')?.globalValue;
  }

  refresh() {
    this.enabled = this.selection() === true;
    ++this.revision;
    const enabled = this.enabled;
    const job = this.queue.then(() => enabled ? undefined : this.purge());
    this.queue = job.catch(() => {});
    return job;
  }

  async choose() {
    if (typeof this.selection() === 'boolean' || this.context.globalState.get(PROMPTED, false)) return;
    await this.context.globalState.update(PROMPTED, true);
    const choice = await this.vscode.window.showInformationMessage('Enable local canvas recovery?', {
      modal: true,
      detail: 'Save an encrypted copy of your canvas on this computer so you can restore your work after a restart or crash. You can change this later in Settings: Org Loom › Local Recovery: Enabled.',
    }, 'Enable recovery', 'Not now');
    // A dismissal also leaves recovery off without prompting again.
    if (choice !== 'Enable recovery') return;
    await this.vscode.workspace.getConfiguration('orgloom').update('localRecovery.enabled', true, this.vscode.ConfigurationTarget.Global);
    await this.refresh();
  }

  run(work, fallback) {
    const revision = this.revision;
    const active = () => this.enabled && revision === this.revision;
    const job = this.queue.then(async () => {
      if (!active()) return fallback;
      const result = await work(active);
      return active() ? result : fallback;
    });
    this.queue = job.catch(() => {});
    return job;
  }
}

module.exports = { RecoveryPreference, SETTING };

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { RecoveryPreference } = require('../src/recovery-preference.cjs');
const { RecoveryStore, cleanupRecovery } = require('../src/recovery.cjs');

function setup(choice, initial) {
  const state = new Map();
  let setting = initial, prompts = 0, purges = 0;
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    workspace: { getConfiguration: () => ({
      inspect: () => ({ globalValue: setting, workspaceValue: true }),
      update: async (key, value, target) => {
        assert.equal(key, 'localRecovery.enabled');
        assert.equal(target, 1);
        setting = value;
      },
    }) },
    window: { showInformationMessage: async (title, options, ...buttons) => {
      prompts++;
      assert.equal(title, 'Enable local canvas recovery?');
      assert.equal(options.modal, true);
      assert.deepEqual(buttons, ['Enable recovery', 'Not now']);
      return choice;
    } },
  };
  const context = { globalState: { get: (key, fallback) => state.get(key) ?? fallback, update: async (key, value) => state.set(key, value) } };
  const create = purge => new RecoveryPreference(vscode, context, purge || (async () => { purges++; }));
  return { create, set: value => { setting = value; }, prompts: () => prompts, purges: () => purges };
}

for (const answer of ['Not now', undefined]) {
  test(`Recovery stays off and remembers first-use choice: ${answer}`, async () => {
    const f = setup(answer), policy = f.create();
    await policy.refresh();
    await policy.choose();
    await policy.choose();
    const reopened = f.create();
    await reopened.choose();
    assert.equal(f.prompts(), 1);
    assert.equal(policy.enabled, false, 'Workspace setting cannot opt in');
    assert.equal(f.purges(), 1);
    assert.equal(await policy.run(() => { throw Error('Disk access while disabled'); }, 'off'), 'off');
  });
}

test('First-use opt-in is persisted in user settings; explicit settings skip prompt', async () => {
  const f = setup('Enable recovery'), policy = f.create();
  await policy.refresh();
  await policy.choose();
  assert.equal(policy.enabled, true);
  assert.equal(await policy.run(() => 'saved'), 'saved');
  await f.create().choose();
  assert.equal(f.prompts(), 1);
  const disabled = setup('Enable recovery', false);
  await disabled.create().choose();
  assert.equal(disabled.prompts(), 0);
});

test('Disabling drains an in-flight write, rejects queued writes and restore results, and removes files and keys across identities', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orgloom-recovery-choice-'));
  const keys = new Map(), secrets = { get: async k => keys.get(k), store: async (k,v) => keys.set(k,v), delete: async k => keys.delete(k) };
  const first = new RecoveryStore(root, secrets, { orgId: 'org1', userId: 'user1' });
  const second = new RecoveryStore(root, secrets, { orgId: 'org2', userId: 'user2' });
  const state = { version: 1, local: {}, session: {} };
  try {
    await second.save(state, new Map());
    const f = setup(undefined, true);
    const policy = f.create(() => cleanupRecovery(root, secrets, Date.now(), true));
    let finish, started;
    const began = new Promise(resolve => { started = resolve; });
    const wait = new Promise(resolve => { finish = resolve; });
    const inFlight = policy.run(async () => { started(); await wait; await first.save(state, new Map()); return 'cached private values'; }, null);
    await began;
    let queuedRan = false;
    const queued = policy.run(() => { queuedRan = true; });
    f.set(false);
    const cleared = policy.refresh();
    finish();
    assert.equal(await inFlight, null, 'A disabled restore cannot deliver cached values');
    await Promise.all([queued, cleared]);
    assert.equal(queuedRan, false);
    assert.equal(await first.load(), null);
    assert.equal(await second.load(), null);
    assert.equal(keys.size, 0);
    await policy.run(() => first.save(state, new Map()));
    assert.equal(await first.load(), null);
    f.set(true); await policy.refresh();
    await policy.run(() => first.save(state, new Map()));
    assert.ok(await first.load(), 'Setting can enable recovery later');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

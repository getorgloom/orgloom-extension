(() => {
  'use strict';
  if (!window.ORGLOOM_DESKTOP_LIVE) return;
  window.OrgLoom = window.OrgLoom || {};
  window.OrgLoom.platform = {
    recordRequests: false,
    upload: { deferredReferences: true },
    onboarding: {
      completeOnFirstRecord: true,
      getFlag: flag => !!window.ORGLOOM_DESKTOP_PREFERENCES?.[flag],
      setFlag: flag => window.OrgLoomDesktopPreference(flag),
    },
    migration: {
      label: 'Export for migration…',
      description: 'Export a migration file, connect to the destination org, then import it to review mappings and matches.',
      start: ({ exportForMigration }) => exportForMigration(),
    },
    clipboard: {
      usesEvents: true,
      mount: context => window.OrgLoomDesktopPaste.mount({ ...context, loading: () => false }),
    },
  };
})();

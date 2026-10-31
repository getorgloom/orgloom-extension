import { scrubErrorEvent } from './error-telemetry.js';

(function () {
	'use strict';
	if (typeof window.Sentry === 'undefined') {
		return;
	}
	if (!window.ORGLOOM_SENTRY_DSN) {
		return;
	}

	window.Sentry.init({
		dsn: window.ORGLOOM_SENTRY_DSN,
		environment: window.ORGLOOM_ENV || 'production',
		release: window.ORGLOOM_RELEASE || undefined,
		tracesSampleRate: 0,
		sendDefaultPii: false,
		enableLogs: false,
		autoSessionTracking: false,
		sendClientReports: false,
		beforeSendTransaction: function () {
			return null;
		},
		replaysSessionSampleRate: 0,
		replaysOnErrorSampleRate: 0,
		beforeSend: scrubErrorEvent,
		beforeBreadcrumb: function () {
			return null;
		},
	});

	if (window.ORGLOOM_ACCOUNT_ID_HASH) {
		window.Sentry.setUser({ id: 'acct:' + window.ORGLOOM_ACCOUNT_ID_HASH });
	}
})();

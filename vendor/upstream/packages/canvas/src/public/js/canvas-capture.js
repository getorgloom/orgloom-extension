(function () {
	'use strict';

	function safeWarn(err, context) {
		try {
			var msg = (err && (err.stack || err.message)) || String(err);
			console.warn('[canvas] ' + msg, context || '');
		} catch (_) {
			/* console itself failed; nothing more to do */
		}
	}

	window.ORGLOOM_capture = function (err, context) {
		safeWarn(err, context);
		if (window.Sentry && typeof window.Sentry.captureException === 'function') {
			try {
				window.Sentry.captureException(err, {
					tags: { source: 'canvas' },
					extra: context || {},
				});
			} catch (_) {
				/* Sentry call failed; console.warn above is the fallback */
			}
		}
	};
})();

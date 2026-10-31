(function () {
	'use strict';
	window.OrgLoom = window.OrgLoom || {};
	if (window.OrgLoom.recoveryStorage) return;

	const RECOVERY_TTL_MS = 2 * 60 * 60 * 1000;
	const HANDOFF_TTL_MS = 10 * 60 * 1000;
	const recordPrefixes = [
		'orgloom:canvas-draft',
		'orgloom:draftValues:',
		'orgloom:org-switch-stash:',
		'orgloom:migration:',
		'orgloom:reauth-fallback:',
	];
	function isRecoveryKey(key) {
		return recordPrefixes.some((prefix) => key.startsWith(prefix));
	}
	function removeItem(key) {
		try {
			window.sessionStorage.removeItem(key);
		} catch (_) {}
	}
	function getItem(key) {
		try {
			if (window.OrgLoom.sessionEnded) return null;
			const raw = window.sessionStorage.getItem(key);
			if (!raw) return null;
			if (key.startsWith('orgloom:canvas-draft-active:')) {
				if (!raw.startsWith('orgloom:canvas-draft:') || !getItem(raw)) {
					removeItem(key);
					return null;
				}
			} else if (isRecoveryKey(key) && !key.startsWith('orgloom:reauth-fallback:')) {
				const payload = JSON.parse(raw);
				const age = Date.now() - payload.ts;
				const ttl = key.startsWith('orgloom:org-switch-stash:') ? HANDOFF_TTL_MS : RECOVERY_TTL_MS;
				// Legacy undated drafts and invalid/future timestamps are not recoverable.
				if (!Number.isFinite(payload.ts) || age < 0 || age >= ttl) {
					removeItem(key);
					return null;
				}
			}
			return raw;
		} catch (_) {
			removeItem(key);
			return null;
		}
	}
	function setItem(key, value) {
		// Includes pending timers and pagehide writes after a confirmed logout.
		if (window.OrgLoom.sessionEnded) return;
		try {
			window.sessionStorage.setItem(key, value);
		} catch (_) {}
	}
	function eachKey(storage, visit) {
		for (let i = storage.length - 1; i >= 0; i--) {
			const key = storage.key(i);
			if (key) visit(key);
		}
	}
	function clear() {
		try {
			eachKey(window.sessionStorage, (key) => {
				if (
					isRecoveryKey(key) ||
					key.startsWith('orgloom:upload-attempts:') ||
					key.startsWith('orgloom-describe-') ||
					key === 'orgloom:sfOfflineMode'
				) {
					removeItem(key);
				}
			});
		} catch (_) {}
		// Clean up copies left by older versions too; leave preferences/demo data alone.
		try {
			eachKey(window.localStorage, (key) => {
				if (isRecoveryKey(key)) window.localStorage.removeItem(key);
			});
		} catch (_) {}
	}
	function prune() {
		try {
			eachKey(window.sessionStorage, (key) => {
				if (isRecoveryKey(key)) getItem(key);
			});
		} catch (_) {}
	}
	window.OrgLoom.recoveryStorage = { getItem, setItem, removeItem, clear, prune };
	prune();
	if (typeof window.setInterval === 'function') window.setInterval(prune, 60 * 1000);
	if (typeof window.addEventListener === 'function') {
		window.addEventListener('pageshow', prune);
		window.addEventListener('orgloom:session-ended', clear);
	}
	if (typeof document !== 'undefined') document.addEventListener('visibilitychange', prune);
})();

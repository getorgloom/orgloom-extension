(function () {
	'use strict';
	// Wraps same-origin fetch to add CSRF protection and surface expired Salesforce connections once.

	if (typeof window === 'undefined' || !window.fetch) {
		return;
	}
	if (window.__sfFetchInstalled) {
		return;
	}
	window.__sfFetchInstalled = true;

	const REAUTH_URL = '/auth/login';

	const _originalFetch = window.fetch.bind(window);

	const _OFFLINE_KEY = 'orgloom:sfOfflineMode';
	function _persistOffline() {
		try {
			window.sessionStorage.setItem(_OFFLINE_KEY, '1');
		} catch (_) {}
	}
	function _clearOfflinePersistence() {
		try {
			window.sessionStorage.removeItem(_OFFLINE_KEY);
		} catch (_) {}
	}
	try {
		if (window.sessionStorage.getItem(_OFFLINE_KEY) === '1') {
			window.__sfOfflineMode = true;
		}
	} catch (_) {}

	const _csrfMeta = document.querySelector('meta[name="csrf-token"]');
	const _csrfToken = _csrfMeta ? _csrfMeta.getAttribute('content') || '' : '';

	function _shouldStampCsrf(input, init) {
		// Never attach the app CSRF token to cross-origin requests.
		if (!_csrfToken) {
			return false;
		}
		const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
		if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
			return false;
		}
		let url;
		try {
			const raw = typeof input === 'string' ? input : (input && input.url) || '';
			url = new URL(raw, window.location.origin);
		} catch (_) {
			return false;
		}
		return url.origin === window.location.origin;
	}

	function _handleReauthNeeded() {
		if (window.__sfReauthPromptOpen) {
			return;
		}
		if (window.__sfOfflineMode) {
			return;
		}
		try {
			window.__sfReauthPromptOpen = true;
		} catch (_) {}
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', _showReauthPromptModal, { once: true });
			return;
		}
		_showReauthPromptModal();
	}

	function _showReauthPromptModal() {
		try {
			window.__sfReauthPromptOpen = true;
		} catch (_) {}
		const ret = encodeURIComponent(window.location.pathname + window.location.search);
		const signInUrl = REAUTH_URL + '?return=' + ret;
		const overlay = document.createElement('div');
		overlay.className = 'modal sf-reauth-prompt';
		overlay.innerHTML =
			'<div class="modal-overlay"></div>' +
			'<div class="modal-body" style="max-width:400px">' +
			'<div class="modal-header">' +
			'<h3>Your Salesforce session ended</h3>' +
			'</div>' +
			'<div class="modal-content">' +
			'<div class="sf-reauth-options">' +
			'<button type="button" class="sf-reauth-card is-highlighted" data-rap-action="signin">' +
			'<span class="sf-reauth-card-title">Sign in again</span>' +
			'</button>' +
			'<button type="button" class="sf-reauth-card" data-rap-action="switch">' +
			'<span class="sf-reauth-card-title">Sign in to a different org</span>' +
			'</button>' +
			'<button type="button" class="sf-reauth-card" data-rap-action="offline">' +
			'<span class="sf-reauth-card-title">Keep working offline</span>' +
			'</button>' +
			'</div>' +
			'</div>' +
			'</div>';
		document.body.appendChild(overlay);
		const options = overlay.querySelectorAll('.sf-reauth-card');
		options.forEach((option) => {
			const highlight = () => {
				options.forEach((other) => other.classList.toggle('is-highlighted', other === option));
			};
			option.addEventListener('pointerenter', highlight);
			option.addEventListener('focus', highlight);
		});
		const cleanup = () => {
			try {
				overlay.remove();
			} catch (_) {}
			try {
				window.__sfReauthPromptOpen = false;
			} catch (_) {}
		};
		const prepareReauth = () => {
			try {
				const navigation = window.Orgloom && window.Orgloom.canvasNavigation;
				if (navigation && typeof navigation.prepareSalesforceReauth === 'function') {
					navigation.prepareSalesforceReauth();
					return;
				}
			} catch (_) {}
			try {
				window.__sfRedirectingToReauth = true;
			} catch (_) {}
		};
		overlay.querySelector('[data-rap-action="signin"]').addEventListener('click', () => {
			cleanup();
			_clearOfflinePersistence();
			const connectionsModal = window.Orgloom && window.Orgloom.sfConnectionsModal;
			if (connectionsModal && typeof connectionsModal.reauth === 'function') {
				connectionsModal.reauth(signInUrl);
				return;
			}
			prepareReauth();
			window.location.assign(signInUrl);
		});
		overlay.querySelector('[data-rap-action="switch"]').addEventListener('click', () => {
			cleanup();
			_clearOfflinePersistence();
			if (
				window.Orgloom &&
				window.Orgloom.sfConnectionsModal &&
				typeof window.Orgloom.sfConnectionsModal.open === 'function'
			) {
				try {
					window.Orgloom.sfConnectionsModal.open();
					return;
				} catch (_) {}
			}
			prepareReauth();
			window.location.assign(REAUTH_URL);
		});
		overlay.querySelector('[data-rap-action="offline"]').addEventListener('click', () => {
			cleanup();
			try {
				window.__sfOfflineMode = true;
			} catch (_) {}
			_persistOffline();
			try {
				document.dispatchEvent(new CustomEvent('orgloom:sf-offline'));
			} catch (_) {}
			_markChipOffline();
		});
	}

	async function _isExpiredSfResponse(res) {
		if (!res || res.status !== 401) {
			return false;
		}
		const ct = res.headers && res.headers.get && res.headers.get('content-type');
		if (!ct || ct.indexOf('application/json') === -1) {
			return false;
		}
		try {
			const clone = res.clone();
			const data = await clone.json();
			return data && data.error === 'sf-session-expired';
		} catch (_) {
			return false;
		}
	}

	async function _isMissingConnectionResponse(res) {
		if (!res || res.status !== 409) {
			return false;
		}
		const ct = res.headers && res.headers.get && res.headers.get('content-type');
		if (!ct || ct.indexOf('application/json') === -1) {
			return false;
		}
		try {
			const clone = res.clone();
			const data = await clone.json();
			return data && data.error === 'no-active-connection';
		} catch (_) {
			return false;
		}
	}

	async function _isMissingOrgloomPermissionSetResponse(res) {
		if (!res || res.status !== 403) {
			return false;
		}
		const ct = res.headers && res.headers.get && res.headers.get('content-type');
		if (!ct || ct.indexOf('application/json') === -1) {
			return false;
		}
		try {
			const data = await res.clone().json();
			return data && data.error === 'orgloom-permission-set-required';
		} catch (_) {
			return false;
		}
	}

	function _preparePermissionRequiredNavigation() {
		try {
			const navigation = window.Orgloom && window.Orgloom.canvasNavigation;
			if (navigation && typeof navigation.prepareSalesforceReauth === 'function') {
				navigation.prepareSalesforceReauth();
				return;
			}
		} catch (_) {}
		// Keep the redirect automatic if this runs before app.js mounts, while
		// suppressing the unsaved-work unload prompt.
		try {
			window.__sfRedirectingToReauth = true;
		} catch (_) {}
	}

	function _stampCsrfHeader(init) {
		const next = { ...(init || {}) };
		const h = new Headers(next.headers || {});
		if (!h.has('x-csrf-token')) {
			h.set('x-csrf-token', _csrfToken);
		}
		next.headers = h;
		return next;
	}

	function _markChipOffline() {
		try {
			const chip = document.getElementById('app-sf-chip');
			if (!chip) {
				return;
			}
			chip.classList.add('app-sf-chip--disconnected');
			chip.classList.add('app-sf-chip--offline');
			const label = chip.querySelector('.app-sf-chip-label');
			if (label) {
				label.textContent = 'Reconnect';
			}
			chip.setAttribute('title', 'Working offline: click to reconnect to Salesforce');
		} catch (_) {}
	}

	document.addEventListener(
		'click',
		function (e) {
			if (!window.__sfOfflineMode) {
				return;
			}
			const chip = e.target && e.target.closest ? e.target.closest('#app-sf-chip') : null;
			if (!chip) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			if (e.stopImmediatePropagation) {
				e.stopImmediatePropagation();
			}
			try {
				window.__sfOfflineMode = false;
			} catch (_) {}
			_clearOfflinePersistence();
			_handleReauthNeeded();
		},
		true,
	);

	if (window.__sfOfflineMode) {
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', _markChipOffline, { once: true });
		} else {
			_markChipOffline();
		}
	}

	window.fetch = async function patchedFetch(input, init) {
		const initWithCsrf = _shouldStampCsrf(input, init) ? _stampCsrfHeader(init) : init;
		const res = await _originalFetch(input, initWithCsrf);
		if (await _isMissingOrgloomPermissionSetResponse(res)) {
			if (!window.__orgloomPermsetRedirecting) {
				window.__orgloomPermsetRedirecting = true;
				_preparePermissionRequiredNavigation();
				window.location.assign('/permset-required');
			}
			return res;
		}
		if (window.__sfOfflineMode) {
			return res;
		}
		if (await _isMissingConnectionResponse(res)) {
			if (window.ORGLOOM_SF_CONNECTED === false) {
				return res;
			}
			window.ORGLOOM_SF_CONNECTED = false;
			_handleReauthNeeded();
			return res;
		}
		if (!(await _isExpiredSfResponse(res))) {
			return res;
		}

		if (window.ORGLOOM_SF_CONNECTED === false) {
			return res;
		}

		window.ORGLOOM_SF_CONNECTED = false;
		_handleReauthNeeded();
		return res;
	};
})();

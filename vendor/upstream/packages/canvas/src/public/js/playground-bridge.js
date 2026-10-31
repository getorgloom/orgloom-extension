(function () {
	'use strict';
	// Moves explicitly requested playground state into the authenticated app with short-lived handoff keys.

	const HANDOFF_KEY = 'orgloom.playground.handoff';
	const AUTOSAVE_KEY_PREFIX = 'orgloom:canvas-draft:v1';
	const FIRST_ACTION_KEY = 'orgloom.playground.firstActionFired';
	const NAGGED_SAVE_KEY = 'orgloom.playground.naggedSave';
	const NAGGED_UPLOAD_KEY = 'orgloom.playground.naggedUpload';

	function capture(eventName, props) {
		try {
			if (window.posthog && window.posthog.capture) {
				window.posthog.capture(eventName, props || {});
			}
		} catch (_) {}
	}
	function referrerOrigin() {
		try {
			return document.referrer ? new URL(document.referrer).origin : '';
		} catch (_) {
			return '';
		}
	}

	function safeReadLocalStorage(key) {
		try {
			return window.localStorage.getItem(key);
		} catch (_) {
			return null;
		}
	}
	function safeWriteLocalStorage(key, value) {
		try {
			window.localStorage.setItem(key, value);
		} catch (_) {}
	}
	function safeRemoveLocalStorage(key) {
		try {
			window.localStorage.removeItem(key);
		} catch (_) {}
	}

	function installSendSide() {
		capture('playground_started', {
			referrer_origin: referrerOrigin(),
			source: 'mock',
		});

		document.addEventListener(
			'click',
			(ev) => {
				const target = ev.target;
				if (!target || !target.closest) {
					return;
				}
				const aiSubmitBtn = target.closest('#ai-gen-submit');
				if (aiSubmitBtn) {
					ev.preventDefault();
					ev.stopPropagation();
					showAiGenConversionPrompt();
					return;
				}
				const migrateBtn = target.closest('[data-bulk-op="migrate-org"]');
				if (migrateBtn) {
					ev.preventDefault();
					ev.stopPropagation();
					document.querySelectorAll('.fill-menu-popup').forEach((el) => el.remove());
					showMigrationConversionPrompt();
					return;
				}
				const saveBtn = target.closest('[data-bulk-save]');
				if (saveBtn && !sessionFlag(NAGGED_SAVE_KEY)) {
					ev.preventDefault();
					ev.stopPropagation();
					setSessionFlag(NAGGED_SAVE_KEY);
					showConversionPrompt({
						kind: 'save',
						title: 'Save this canvas for real?',
						body: 'You’re in demo mode, so saved canvases only stick to this browser. Join the open beta to save them to your account and pick up where you left off on any device.',
						primary: 'Join the open beta →',
						secondary: 'Save in demo only',
						captureEvent: 'playground_save_attempted',
						onProceed: () => clickThroughOriginal(saveBtn),
					});
					return;
				}
				const uploadBtn = target.closest('[data-bulk-upload]');
				if (uploadBtn && !sessionFlag(NAGGED_UPLOAD_KEY)) {
					ev.preventDefault();
					ev.stopPropagation();
					setSessionFlag(NAGGED_UPLOAD_KEY);
					showConversionPrompt({
						kind: 'upload',
						title: 'Push to a real Salesforce org?',
						body: 'You’re in demo mode, so uploads don’t reach a real org. Join the open beta to connect Salesforce and upload these records for real.',
						primary: 'Sign up & connect SF →',
						secondary: 'Run demo upload',
						captureEvent: 'playground_upload_attempted',
						onProceed: () => clickThroughOriginal(uploadBtn),
					});
					return;
				}
				const signupCta = target.closest('.app-playground-signup-cta');
				if (signupCta) {
					ev.preventDefault();
					capture('playground_signup_clicked', {
						source: 'top-strip',
						record_count: countCurrentRecords(),
					});
					stashHandoffAndRedirect();
					return;
				}
				const cta = target.closest('.app-playground-banner-cta');
				if (cta) {
					ev.preventDefault();
					capture('playground_save_attempted', { record_count: countCurrentRecords() });
					stashHandoffAndRedirect();
				}
			},
			true,
		);

		function sessionFlag(key) {
			try {
				return !!window.sessionStorage.getItem(key);
			} catch (_) {
				return false;
			}
		}
		function setSessionFlag(key) {
			try {
				window.sessionStorage.setItem(key, '1');
			} catch (_) {}
		}
		function clickThroughOriginal(el) {
			el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		}
		function stashHandoffAndRedirect() {
			safeRemoveLocalStorage(HANDOFF_KEY);
			window.location.href = '/signup?from=playground';
		}
		function showConversionPrompt(opts) {
			capture(opts.captureEvent, { record_count: countCurrentRecords() });
			document.querySelectorAll('.playground-convert-modal').forEach((el) => el.remove());
			const modal = document.createElement('div');
			modal.className = 'modal playground-convert-modal';
			modal.innerHTML =
				'<div class="modal-overlay" data-pg-convert-close></div>' +
				'<div class="modal-body" style="max-width:520px">' +
				'<div class="modal-header">' +
				'<h3>' +
				escapeText(opts.title) +
				'</h3>' +
				'<button class="modal-close" data-pg-convert-close>&times;</button>' +
				'</div>' +
				'<div class="modal-content">' +
				'<p>' +
				escapeText(opts.body) +
				'</p>' +
				'</div>' +
				'<div class="modal-footer">' +
				'<button class="button secondary" data-pg-convert-cancel>' +
				escapeText(opts.secondary) +
				'</button>' +
				'<button class="button" data-pg-convert-go>' +
				escapeText(opts.primary) +
				'</button>' +
				'</div>' +
				'</div>';
			document.body.appendChild(modal);
			const close = () => {
				modal.remove();
				document.removeEventListener('keydown', onEsc);
			};
			const onEsc = (e) => {
				if (e.key === 'Escape') {
					close();
					opts.onProceed();
				}
			};
			document.addEventListener('keydown', onEsc);
			modal.querySelectorAll('[data-pg-convert-close], [data-pg-convert-cancel]').forEach((el) => {
				el.addEventListener('click', () => {
					close();
					opts.onProceed();
				});
			});
			modal.querySelector('[data-pg-convert-go]').addEventListener('click', () => {
				close();
				stashHandoffAndRedirect();
			});
		}
		function escapeText(s) {
			return String(s == null ? '' : s)
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;');
		}

		function showAiGenConversionPrompt() {
			let scopeCount = 0;
			let promptLen = 0;
			try {
				const cbs = document.querySelectorAll('[data-ai-obj]:checked');
				scopeCount = cbs ? cbs.length : 0;
				const ta = document.getElementById('ai-gen-prompt');
				promptLen = ta ? (ta.value || '').length : 0;
			} catch (_) {}
			capture('playground_ai_gen_attempted', {
				scope_object_count: scopeCount,
				prompt_length: promptLen,
				record_count: countCurrentRecords(),
			});
			document.querySelectorAll('.playground-convert-modal').forEach((el) => el.remove());
			const modal = document.createElement('div');
			modal.className = 'modal playground-convert-modal';
			modal.innerHTML =
				'<div class="modal-overlay" data-pg-ai-close></div>' +
				'<div class="modal-body" style="max-width:520px">' +
				'<div class="modal-header">' +
				'<h3>Sign up to generate with Claude</h3>' +
				'<button class="modal-close" data-pg-ai-close>&times;</button>' +
				'</div>' +
				'<div class="modal-content">' +
				'<p>AI generation uses your selected schema to draft records and apply them to your canvas. The demo doesn’t include this feature. Join the open beta to run real generations against your own Salesforce org.</p>' +
				'</div>' +
				'<div class="modal-footer">' +
				'<button class="button secondary" data-pg-ai-close>Close</button>' +
				'<button class="button" data-pg-ai-go>Sign up free →</button>' +
				'</div>' +
				'</div>';
			document.body.appendChild(modal);
			const closeAiGenModalIfOpen = () => {
				try {
					document.querySelectorAll('.modal').forEach((m) => {
						if (m === modal) {
							return;
						}
						if (m.querySelector('#ai-gen-content')) {
							m.classList.add('hidden');
						}
					});
				} catch (_) {}
			};
			const close = () => {
				modal.remove();
				document.removeEventListener('keydown', onEsc);
			};
			const onEsc = (e) => {
				if (e.key === 'Escape') {
					close();
					closeAiGenModalIfOpen();
				}
			};
			document.addEventListener('keydown', onEsc);
			modal.querySelectorAll('[data-pg-ai-close]').forEach((el) => {
				el.addEventListener('click', () => {
					close();
					closeAiGenModalIfOpen();
				});
			});
			modal.querySelector('[data-pg-ai-go]').addEventListener('click', () => {
				close();
				stashHandoffAndRedirect();
			});
		}

		function showMigrationConversionPrompt() {
			capture('playground_migration_attempted', { record_count: countCurrentRecords() });
			document.querySelectorAll('.playground-convert-modal').forEach((el) => el.remove());
			const modal = document.createElement('div');
			modal.className = 'modal playground-convert-modal';
			modal.innerHTML =
				'<div class="modal-overlay" data-pg-migration-close></div>' +
				'<div class="modal-body" style="max-width:520px">' +
				'<div class="modal-header">' +
				'<h3>Sign up to migrate between Salesforce orgs</h3>' +
				'<button class="modal-close" data-pg-migration-close>&times;</button>' +
				'</div>' +
				'<div class="modal-content">' +
				'<p>Cross-org migration carries canvas records into another Salesforce org. You can match destination records, resolve field differences, and review the migration before uploading. The playground cannot connect real Salesforce orgs. Sign up free to run a migration with your own orgs.</p>' +
				'</div>' +
				'<div class="modal-footer">' +
				'<button class="button secondary" data-pg-migration-close>Close</button>' +
				'<button class="button" data-pg-migration-go>Sign up free &rarr;</button>' +
				'</div>' +
				'</div>';
			document.body.appendChild(modal);
			const close = () => {
				modal.remove();
				document.removeEventListener('keydown', onEsc);
			};
			const onEsc = (event) => {
				if (event.key === 'Escape') {
					close();
				}
			};
			document.addEventListener('keydown', onEsc);
			modal.querySelectorAll('[data-pg-migration-close]').forEach((el) => {
				el.addEventListener('click', close);
			});
			modal.querySelector('[data-pg-migration-go]').addEventListener('click', () => {
				close();
				stashHandoffAndRedirect();
			});
		}

		const alreadyFired = (function () {
			try {
				return window.sessionStorage.getItem(FIRST_ACTION_KEY);
			} catch (_) {
				return null;
			}
		})();
		if (!alreadyFired) {
			const interval = setInterval(() => {
				if (countCurrentRecords() > 0) {
					capture('playground_first_action', {
						record_count: countCurrentRecords(),
					});
					try {
						window.sessionStorage.setItem(FIRST_ACTION_KEY, '1');
					} catch (_) {}
					clearInterval(interval);
				}
			}, 1500);
			setTimeout(() => clearInterval(interval), 5 * 60 * 1000);
		}
	}

	function countCurrentRecords() {
		try {
			if (
				window.Orgloom &&
				window.Orgloom.canvasState &&
				typeof window.Orgloom.canvasState.snapshot === 'function'
			) {
				const s = window.Orgloom.canvasState.snapshot();
				const drafts = (s && s.payload && s.payload.drafts) || [];
				const loaded = (s && s.payload && s.payload.loadedRecords) || [];
				return drafts.length + loaded.length;
			}
		} catch (_) {}
		try {
			const ss = window.sessionStorage;
			let raw = null;
			for (let i = 0; i < ss.length; i++) {
				const k = ss.key(i);
				if (k && k.indexOf(AUTOSAVE_KEY_PREFIX) === 0) {
					raw = ss.getItem(k);
					break;
				}
			}
			if (!raw) {
				return 0;
			}
			const parsed = JSON.parse(raw);
			const list = (parsed && parsed.state && parsed.state.bulkRecords) || [];
			return list.length;
		} catch (_) {}
		return 0;
	}

	function installReceiveSide() {
		safeRemoveLocalStorage(HANDOFF_KEY);
	}

	if (window.ORGLOOM_MOCK) {
		installSendSide();
	} else if (window.ORGLOOM_ACCOUNT_ID) {
		installReceiveSide();
	}
})();

(function () {
	'use strict';
	// Shared accessible toasts, confirmations, and hydrate-choice dialogs.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.uiFeedback = {
		mount: function mount(deps) {
			if (!deps || !deps.escapeHtml || !deps.getGraph) {
				throw new Error('ui-feedback.mount: missing required deps');
			}
			const escapeHtml = deps.escapeHtml;
			function _toastHost() {
				return document.body || null;
			}

			function showBulkToast(message, variant) {
				const canvas = _toastHost();
				if (!canvas) {
					return;
				}
				canvas.querySelectorAll('.bulk-toast').forEach((t) => t.remove());
				const toast = document.createElement('div');
				toast.className = 'bulk-toast' + (variant ? ' ' + variant : '');
				toast.innerHTML =
					'<button type="button" class="bulk-toast-close" title="Dismiss">\u00D7</button>' +
					escapeHtml(message);
				canvas.appendChild(toast);
				const dismiss = () => {
					toast.classList.add('fade-out');
					setTimeout(() => {
						if (toast.parentNode) {
							toast.remove();
						}
					}, 260);
				};
				toast.querySelector('.bulk-toast-close').addEventListener('click', dismiss);
				setTimeout(dismiss, 4000);
			}

			function showBulkToastWithAction(message, actionLabel, onAction, variant) {
				const canvas = _toastHost();
				if (!canvas) {
					return;
				}
				canvas.querySelectorAll('.bulk-toast').forEach((t) => t.remove());
				const toast = document.createElement('div');
				toast.className = 'bulk-toast has-action' + (variant ? ' ' + variant : '');
				toast.innerHTML =
					'<span class="bulk-toast-msg">' +
					escapeHtml(message) +
					'</span>' +
					'<button type="button" class="bulk-toast-action">' +
					escapeHtml(actionLabel) +
					'</button>' +
					'<button type="button" class="bulk-toast-close" title="Dismiss">\u00D7</button>';
				canvas.appendChild(toast);
				const dismiss = () => {
					toast.classList.add('fade-out');
					setTimeout(() => {
						if (toast.parentNode) {
							toast.remove();
						}
					}, 260);
				};
				toast.querySelector('.bulk-toast-action').addEventListener('click', () => {
					try {
						onAction();
					} catch (e) {
						console.warn(e);
					}
					dismiss();
				});
				toast.querySelector('.bulk-toast-close').addEventListener('click', dismiss);
				// Action toasts can appear while a modal is open; leave enough time to review the result and undo.
				setTimeout(dismiss, 30000);
			}

			function showConfirmDialog({ title, message, confirmLabel, cancelLabel, danger }) {
				return new Promise((resolve) => {
					document.querySelectorAll('.app-confirm-modal').forEach((el) => el.remove());
					const modal = document.createElement('div');
					modal.className = 'modal app-confirm-modal';
					const confirmClass = danger ? 'button danger' : 'button';
					modal.innerHTML =
						'<div class="modal-overlay" data-cf-close></div>' +
						'<div class="modal-body" style="max-width:440px">' +
						'<div class="modal-header">' +
						'<h3>' +
						escapeHtml(title || 'Confirm') +
						'</h3>' +
						'<button class="modal-close" data-cf-close>&times;</button>' +
						'</div>' +
						'<div class="modal-content">' +
						'<p style="white-space:pre-line">' +
						escapeHtml(message || '') +
						'</p>' +
						'</div>' +
						'<div class="modal-footer">' +
						'<button class="button secondary" data-cf-cancel>' +
						escapeHtml(cancelLabel || 'Cancel') +
						'</button>' +
						'<button class="' +
						confirmClass +
						'" data-cf-confirm>' +
						escapeHtml(confirmLabel || 'Confirm') +
						'</button>' +
						'</div>' +
						'</div>';
					document.body.appendChild(modal);
					let settled = false;
					const finish = (value) => {
						if (settled) {
							return;
						}
						settled = true;
						document.removeEventListener('keydown', onKey);
						modal.remove();
						resolve(value);
					};
					const onKey = (e) => {
						if (e.key === 'Escape') {
							finish(false);
						} else if (e.key === 'Enter') {
							finish(true);
						}
					};
					document.addEventListener('keydown', onKey);
					modal
						.querySelectorAll('[data-cf-close], [data-cf-cancel]')
						.forEach((el) => el.addEventListener('click', () => finish(false)));
					modal.querySelector('[data-cf-confirm]').addEventListener('click', () => finish(true));
					setTimeout(() => modal.querySelector('[data-cf-confirm]').focus(), 0);
				});
			}

			function confirmHydrateChoice({ placeholderLabel, currentValues, incoming, fieldLabelLookup }) {
				return new Promise((resolve) => {
					document.querySelectorAll('.hydrate-confirm-modal').forEach((el) => el.remove());
					const modal = document.createElement('div');
					modal.className = 'modal hydrate-confirm-modal';
					const allKeys = new Set([...Object.keys(currentValues || {}), ...Object.keys(incoming || {})]);
					const diffRows = [];
					for (const k of allKeys) {
						if (k === 'attributes' || k === 'Id') {
							continue;
						}
						const a = currentValues && currentValues[k];
						const b = incoming && incoming[k];
						const aS = a == null ? '' : String(a);
						const bS = b == null ? '' : String(b);
						if (aS === bS) {
							continue;
						}
						diffRows.push({ field: k, current: aS, incoming: bS });
					}
					const shown = diffRows.slice(0, 10);
					const moreCount = diffRows.length - shown.length;
					const trim = (s) => (s.length > 60 ? s.slice(0, 57) + '\u2026' : s);
					const rowsHtml =
						shown.length === 0
							? '<div class="hc-empty">No field-value differences: only the Salesforce id will be linked.</div>'
							: shown
									.map((r) => {
										const flabel = fieldLabelLookup
											? fieldLabelLookup(r.field) || r.field
											: r.field;
										return (
											'<div class="hc-row">' +
											'<div class="hc-field"><strong>' +
											escapeHtml(flabel) +
											'</strong> <code>' +
											escapeHtml(r.field) +
											'</code></div>' +
											'<div class="hc-current"><span class="hc-tag">your value</span> ' +
											(r.current === '' ? '<em>(empty)</em>' : escapeHtml(trim(r.current))) +
											'</div>' +
											'<div class="hc-incoming"><span class="hc-tag">salesforce</span> ' +
											(r.incoming === '' ? '<em>(empty)</em>' : escapeHtml(trim(r.incoming))) +
											'</div>' +
											'</div>'
										);
									})
									.join('') +
								(moreCount > 0
									? '<div class="hc-more">\u2026 and ' +
										moreCount +
										' more field' +
										(moreCount === 1 ? '' : 's') +
										'.</div>'
									: '');
					modal.innerHTML =
						'<div class="modal-overlay" data-hc-close></div>' +
						'<div class="modal-body" style="max-width:620px">' +
						'<div class="modal-header">' +
						'<h3>Replace canvas record with loaded data?</h3>' +
						'<button class="modal-close" data-hc-close>&times;</button>' +
						'</div>' +
						'<div class="modal-content">' +
						'<p><strong>' +
						escapeHtml(placeholderLabel) +
						'</strong> already has values you entered. Loading the related Salesforce record would overwrite them.</p>' +
						'<div class="hc-diff">' +
						rowsHtml +
						'</div>' +
						'<p class="tag">You can undo this from the toast that appears after.</p>' +
						'</div>' +
						'<div class="modal-footer">' +
						'<button class="button secondary" data-hc-skip>Skip this load</button>' +
						'<button class="button" data-hc-replace>Replace with Salesforce data</button>' +
						'</div>' +
						'</div>';
					document.body.appendChild(modal);
					const close = (decision) => {
						modal.remove();
						document.removeEventListener('keydown', onEsc);
						resolve(decision);
					};
					const onEsc = (ev) => {
						if (ev.key === 'Escape') {
							close('skip');
						}
					};
					modal
						.querySelectorAll('[data-hc-close]')
						.forEach((el) => el.addEventListener('click', () => close('skip')));
					modal.querySelector('[data-hc-skip]').addEventListener('click', () => close('skip'));
					modal.querySelector('[data-hc-replace]').addEventListener('click', () => close('replace'));
					document.addEventListener('keydown', onEsc);
				});
			}

			return {
				showBulkToast: showBulkToast,
				showBulkToastWithAction: showBulkToastWithAction,
				showConfirmDialog: showConfirmDialog,
				confirmHydrateChoice: confirmHydrateChoice,
			};
		},
	};
})();

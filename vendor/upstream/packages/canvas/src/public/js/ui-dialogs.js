(function () {
	if (window.olConfirm) {
		return;
	} // idempotent if included twice

	function esc(s) {
		return String(s == null ? '' : s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	let _toastHost = null;
	function _ensureToastHost() {
		if (_toastHost && document.body.contains(_toastHost)) {
			return _toastHost;
		}
		_toastHost = document.createElement('div');
		_toastHost.className = 'ol-toast-host';
		_toastHost.style.cssText =
			'position:fixed;bottom:1.25rem;left:50%;transform:translateX(-50%);z-index:100000;display:flex;flex-direction:column;gap:0.5rem;align-items:center;pointer-events:none;max-width:min(92vw,560px)';
		document.body.appendChild(_toastHost);
		return _toastHost;
	}
	function olToast(message, variant) {
		try {
			const host = _ensureToastHost();
			const t = document.createElement('div');
			const bg = variant === 'error' ? '#b3261e' : variant === 'success' ? '#2e7d32' : '#2a2a2a';
			t.setAttribute('role', variant === 'error' ? 'alert' : 'status');
			t.style.cssText =
				'pointer-events:auto;background:' +
				bg +
				';color:#fff;padding:0.6rem 0.9rem;border-radius:6px;font-size:0.9rem;box-shadow:0 4px 14px rgba(0,0,0,0.3);display:flex;gap:0.6rem;align-items:flex-start;max-width:100%;line-height:1.35;cursor:default';
			const span = document.createElement('span');
			span.textContent = String(message == null ? '' : message);
			const x = document.createElement('button');
			x.type = 'button';
			x.textContent = '✕';
			x.setAttribute('aria-label', 'Dismiss');
			x.style.cssText =
				'background:none;border:none;color:#fff;opacity:0.8;cursor:pointer;font-size:0.95em;line-height:1;padding:0;margin-left:auto';
			const remove = () => {
				t.remove();
				if (_toastHost && !_toastHost.children.length) {
					_toastHost.remove();
					_toastHost = null;
				}
			};
			x.addEventListener('click', remove);
			t.appendChild(span);
			t.appendChild(x);
			host.appendChild(t);
			setTimeout(remove, variant === 'error' ? 8000 : 4500);
		} catch (e) {
			/* last-resort: never throw from a notice */
		}
	}

	function _modal(
		{
			title,
			message,
			confirmLabel,
			cancelLabel,
			danger,
			withInput,
			inputValue,
			placeholder,
			showCancel,
			showConfirm,
		},
		done,
	) {
		document.querySelectorAll('.ol-dialog-modal').forEach((el) => el.remove());
		const modal = document.createElement('div');
		modal.className = 'modal ol-dialog-modal';
		const confirmClass = danger ? 'button danger' : 'button';
		const inputHtml = withInput
			? '<input type="text" class="ol-dialog-input" value="' +
				esc(inputValue || '') +
				'" placeholder="' +
				esc(placeholder || '') +
				'" autocomplete="off" style="width:100%;margin-top:0.6em;padding:0.5em 0.65em;border:1px solid var(--border,#444);border-radius:4px;background:var(--bg-inset,#1c1c1c);color:var(--ink,#eee);font-size:0.95rem">'
			: '';
		const cancelBtn =
			showCancel === false
				? ''
				: '<button class="button secondary" data-ol-cancel>' + esc(cancelLabel || 'Cancel') + '</button>';
		const confirmBtn =
			showConfirm === false
				? ''
				: '<button class="' +
					confirmClass +
					'" data-ol-confirm>' +
					esc(confirmLabel || 'Confirm') +
					'</button>';
		const footerHtml =
			cancelBtn || confirmBtn ? '<div class="modal-footer">' + cancelBtn + confirmBtn + '</div>' : '';
		modal.innerHTML =
			'<div class="modal-overlay" data-ol-cancel></div>' +
			'<div class="modal-body" style="max-width:460px">' +
			'<div class="modal-header">' +
			'<h3>' +
			esc(title || 'Confirm') +
			'</h3>' +
			'<button class="modal-close" data-ol-cancel aria-label="Close">&times;</button>' +
			'</div>' +
			'<div class="modal-content">' +
			(message ? '<p>' + esc(message) + '</p>' : '') +
			inputHtml +
			'</div>' +
			footerHtml +
			'</div>';
		document.body.appendChild(modal);
		const input = modal.querySelector('.ol-dialog-input');
		const confirmButton = modal.querySelector('[data-ol-confirm]');
		let settled = false;
		const finish = (value) => {
			if (settled) {
				return;
			}
			settled = true;
			document.removeEventListener('keydown', onKey, true);
			modal.remove();
			done(value);
		};
		const onConfirm = () => finish(withInput ? (input ? input.value : '') : true);
		const onCancel = () => finish(withInput ? null : false);
		const onKey = (e) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				onCancel();
			} else if (confirmButton && e.key === 'Enter' && (!withInput || document.activeElement === input)) {
				e.preventDefault();
				onConfirm();
			}
		};
		document.addEventListener('keydown', onKey, true);
		modal.querySelectorAll('[data-ol-cancel]').forEach((el) => el.addEventListener('click', onCancel));
		if (confirmButton) {
			confirmButton.addEventListener('click', onConfirm);
		}
		setTimeout(() => {
			(input || confirmButton || modal.querySelector('.modal-close')).focus();
			if (input) {
				input.select();
			}
		}, 0);
	}

	function olConfirm(opts) {
		const o = typeof opts === 'string' ? { message: opts } : opts || {};
		return new Promise((resolve) => _modal({ ...o, withInput: false }, resolve));
	}
	function olPrompt(opts) {
		const o = typeof opts === 'string' ? { message: opts } : opts || {};
		return new Promise((resolve) =>
			_modal({ confirmLabel: 'OK', ...o, withInput: true, inputValue: o.defaultValue || o.value || '' }, resolve),
		);
	}
	function olAlert(message, opts) {
		const o = opts || {};
		return new Promise((resolve) =>
			_modal(
				{
					title: o.title || 'Heads up',
					message,
					confirmLabel: o.confirmLabel || 'OK',
					showCancel: false,
					showConfirm: o.showConfirm !== false,
				},
				() => resolve(),
			),
		);
	}

	function olConfirmSubmit(ev, message, opts) {
		if (!ev) {
			return false;
		}
		ev.preventDefault();
		const form = ev.target && ev.target.closest ? ev.target.closest('form') : ev.target;
		olConfirm({ message: message, danger: true, ...(opts || {}) }).then((ok) => {
			if (ok && form) {
				form.submit();
			}
		});
		return false;
	}

	window.olToast = olToast;
	window.olConfirm = olConfirm;
	window.olPrompt = olPrompt;
	window.olAlert = olAlert;
	window.olConfirmSubmit = olConfirmSubmit;

	function _wireConfirmForms(root) {
		(root || document).querySelectorAll('form[data-confirm-message]:not([data-confirm-wired])').forEach((form) => {
			form.dataset.confirmWired = '1';
			form.addEventListener('submit', (ev) => {
				olConfirmSubmit(ev, form.dataset.confirmMessage, {
					title: form.dataset.confirmTitle,
					confirmLabel: form.dataset.confirmLabel,
				});
			});
		});
	}
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', () => _wireConfirmForms());
	} else {
		_wireConfirmForms();
	}
	window.olWireConfirmForms = _wireConfirmForms;
})();

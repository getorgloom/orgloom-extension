(function () {
	'use strict';
	// Polls for AI clarification requests and submits user answers for the current saved canvas.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.aiClarifications = {
		mount: function mount(deps) {
			const _required = ['canvasState', 'csrfFetch', 'escapeHtml', 'showBulkToast'];
			for (const k of _required) {
				if (deps == null || deps[k] == null) {
					throw new Error('ai-clarifications.mount: missing required dep: ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			const showBulkToast = deps.showBulkToast;

			let _pollTimer = null;
			let _lastCanvasId = null;
			let _currentClarificationId = null;

			const _banner = document.createElement('div');
			_banner.className = 'clarifications-banner';
			_banner.hidden = true;
			document.body.appendChild(_banner);

			function _pollCanvasId() {
				if (canvasState.currentCanvas && canvasState.currentCanvas.id) {
					return canvasState.currentCanvas.id;
				}
				const cs = window.Orgloom && window.Orgloom.canvasState;
				if (cs && typeof cs.getCurrentCanvas === 'function') {
					const c = cs.getCurrentCanvas();
					return (c && c.canvasId) || null;
				}
				return null;
			}

			function _renderBanner(clar) {
				_currentClarificationId = clar.id;
				const optionsHtml =
					Array.isArray(clar.options) && clar.options.length > 0
						? '<div class="clar-options">' +
							clar.options
								.map(
									(o, i) =>
										'<button type="button" class="button secondary clar-option" data-clar-option-idx="' +
										i +
										'">' +
										escapeHtml(o) +
										'</button>',
								)
								.join('') +
							'</div>'
						: '';
				_banner.innerHTML =
					'<div class="clar-row">' +
					'<span class="clar-icon" aria-hidden="true">?</span>' +
					'<div class="clar-body">' +
					'<div class="clar-question">' +
					escapeHtml(clar.question) +
					'</div>' +
					optionsHtml +
					'<div class="clar-text-row">' +
					'<input type="text" class="clar-text-input" placeholder="Type a response…" maxlength="2000">' +
					'<button type="button" class="button clar-send-btn">Send</button>' +
					'</div>' +
					'</div>' +
					'<button type="button" class="clar-dismiss" aria-label="Dismiss until next poll">&times;</button>' +
					'</div>';
				_banner.hidden = false;

				const textInput = _banner.querySelector('.clar-text-input');
				const sendBtn = _banner.querySelector('.clar-send-btn');
				const dismissBtn = _banner.querySelector('.clar-dismiss');

				dismissBtn.addEventListener('click', () => {
					_banner.hidden = true;
				});

				const optionButtons = _banner.querySelectorAll('.clar-option');
				optionButtons.forEach((btn) => {
					btn.addEventListener('click', () => {
						const idx = parseInt(btn.getAttribute('data-clar-option-idx'), 10);
						if (Number.isNaN(idx)) {
							return;
						}
						const optionText = clar.options[idx];
						_submit(clar.canvasId, clar.id, {
							responseOption: optionText,
						});
					});
				});

				sendBtn.addEventListener('click', () => {
					const text = (textInput.value || '').trim();
					if (!text) {
						textInput.focus();
						return;
					}
					_submit(clar.canvasId, clar.id, { responseText: text });
				});

				textInput.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						sendBtn.click();
					}
				});
			}

			async function _submit(canvasId, clarificationId, body) {
				try {
					const r = await csrfFetch(
						'/api/canvas/' +
							encodeURIComponent(canvasId) +
							'/clarifications/' +
							encodeURIComponent(clarificationId) +
							'/respond',
						{
							method: 'POST',
							credentials: 'same-origin',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify(body),
						},
					);
					if (!r.ok) {
						const data = await r.json().catch(() => ({}));
						showBulkToast(
							(data && data.message) ||
								(data && data.error) ||
								'Could not send response (HTTP ' + r.status + ')',
							'error',
						);
						return;
					}
					_banner.hidden = true;
					_currentClarificationId = null;
					_refreshClarifications();
				} catch (e) {
					showBulkToast('Could not send response: ' + (e.message || e), 'error');
				}
			}

			async function _refreshClarifications() {
				if (window.ORGLOOM_MCP_ACTIVE !== true) {
					_banner.hidden = true;
					_lastCanvasId = null;
					return;
				}
				const id = _pollCanvasId();
				if (!id) {
					_banner.hidden = true;
					return;
				}
				try {
					const r = await csrfFetch('/api/canvas/' + encodeURIComponent(id) + '/clarifications', {
						credentials: 'same-origin',
					});
					if (!r.ok) {
						_banner.hidden = true;
						return;
					}
					const data = await r.json();
					const list = data && Array.isArray(data.clarifications) ? data.clarifications : [];
					if (list.length === 0) {
						_banner.hidden = true;
						_currentClarificationId = null;
						return;
					}
					const next = list[list.length - 1];
					if (_currentClarificationId === next.id && !_banner.hidden) {
						return;
					}
					_renderBanner(next);
				} catch (_e) {}
			}

			function _watchClarificationsForCurrentCanvas() {
				if (window.ORGLOOM_MCP_ACTIVE !== true) {
					_banner.hidden = true;
					_lastCanvasId = null;
					if (_pollTimer) {
						clearInterval(_pollTimer);
						_pollTimer = null;
					}
					return;
				}
				const id = _pollCanvasId();
				if (id !== _lastCanvasId) {
					_lastCanvasId = id;
					_refreshClarifications();
				}
				if (_pollTimer) {
					clearInterval(_pollTimer);
				}
				_pollTimer = setInterval(_refreshClarifications, 5000);
			}

			_watchClarificationsForCurrentCanvas();

			document.addEventListener('visibilitychange', () => {
				if (document.visibilityState === 'visible') {
					_refreshClarifications();
				}
			});
			window.addEventListener('focus', () => {
				_refreshClarifications();
			});
			window.addEventListener('orgloom:mcp-availability', () => {
				_watchClarificationsForCurrentCanvas();
			});

			return {
				refreshClarifications: _refreshClarifications,
				watchClarificationsForCurrentCanvas: _watchClarificationsForCurrentCanvas,
			};
		},
	};
})();

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.findObjectPopover = {
		mount: function mount(deps) {
			if (
				!deps ||
				!deps.canvasState ||
				!deps.escapeHtml ||
				!deps.showBulkToast ||
				!deps.addToSelection ||
				!deps.renderAll
			) {
				throw new Error('find-object-popover.mount: missing required deps');
			}
			const canvasState = deps.canvasState;
			const escapeHtml = deps.escapeHtml;
			const showBulkToast = deps.showBulkToast;
			const addToSelection = deps.addToSelection;
			const renderAll = deps.renderAll;

			let _activeCleanup = null;

			function showFindObjectPopover(triggerEl, opts) {
				opts = opts || {};
				const onPick =
					opts.onPick ||
					(async (name) => {
						await addToSelection(name);
						renderAll();
					});
				const isAdded = opts.isAdded || ((name) => canvasState.selectedObjects.some((s) => s.name === name));
				const objectFilter = typeof opts.objectFilter === 'function' ? opts.objectFilter : () => true;
				const emptyText = opts.emptyText || 'No matching objects.';
				const headerText = opts.header || 'Find an object';
				const subText =
					opts.sub ??
					'Adds any object to the schema, related or not. Use this to pick standalone objects alongside selections based on relationships.';
				if (_activeCleanup) {
					try {
						_activeCleanup();
					} catch (_) {
						/* already gone */
					}
				}
				document.querySelectorAll('.find-object-popup').forEach((el) => el.remove());
				const pop = document.createElement('div');
				pop.className = 'find-object-popup';
				const rect = triggerEl.getBoundingClientRect();
				const viewportW = window.innerWidth;
				const viewportH = window.innerHeight;
				const width = Math.min(360, viewportW - 16);
				const left = Math.min(rect.left, viewportW - width - 8);
				pop.style.left = Math.max(8, left) + 'px';
				pop.style.width = width + 'px';
				pop.style.top = '0px';
				pop.innerHTML =
					'<div class="fop-header">' +
					escapeHtml(headerText) +
					'</div>' +
					(subText ? '<div class="fop-sub">' + escapeHtml(subText) + '</div>' : '') +
					'<input type="search" class="fop-search" id="fop-search" placeholder="Filter by label or API name\u2026" autocomplete="off">' +
					'<div class="fop-filter-row">' +
					'<div class="segmented fop-types" id="fop-types">' +
					'<button type="button" data-fop-type="all" class="active">All</button>' +
					'<button type="button" data-fop-type="standard">Standard</button>' +
					'<button type="button" data-fop-type="custom">Custom</button>' +
					'</div>' +
					'</div>' +
					'<div class="fop-list" id="fop-list"><div class="fop-empty">Loading objects…</div></div>';
				pop.insertAdjacentHTML(
					'beforeend',
					'<div class="fop-sub" id="fop-summary" role="status" aria-live="polite"></div>',
				);
				document.body.appendChild(pop);
				{
					const popH = Math.min(480, viewportH * 0.7) + 22;
					const gap = 12;
					const aboveExtraGap = 12;
					const aboveExtraLeft = 100;
					const below = rect.bottom + gap;
					const fitsBelow = below + popH <= viewportH - 8;
					const above = rect.top - gap - aboveExtraGap - popH;
					const fitsAbove = above >= 8;
					let top;
					if (fitsBelow) {
						top = below;
					} else if (fitsAbove) {
						top = above;
					} else {
						top = Math.max(8, viewportH - popH - 8);
					}
					pop.style.top = top + 'px';
					if (!fitsBelow && fitsAbove) {
						const shifted = Math.min(rect.left + aboveExtraLeft, viewportW - width - 8);
						pop.style.left = Math.max(8, shifted) + 'px';
					}
				}

				let typeFilter = 'all';
				const search = pop.querySelector('#fop-search');
				const list = pop.querySelector('#fop-list');
				const summary = pop.querySelector('#fop-summary');

				const renderList = () => {
					const q = (search.value || '').toLowerCase().trim();
					const all = Array.isArray(canvasState.allObjects) ? canvasState.allObjects : [];
					const matchesType = (o) => {
						if (typeFilter === 'standard' && o.custom) {
							return false;
						}
						if (typeFilter === 'custom' && !o.custom) {
							return false;
						}
						return true;
					};
					const matchesQuery = (o) => {
						if (!q) {
							return true;
						}
						return (
							(o.name && o.name.toLowerCase().includes(q)) ||
							(o.label && o.label.toLowerCase().includes(q))
						);
					};
					const filtered = all.filter((o) => objectFilter(o) && matchesType(o) && matchesQuery(o));
					const capped = filtered.slice(0, 60);
					if (canvasState.allObjects === null) {
						list.innerHTML = '<div class="fop-empty">Loading objects\u2026</div>';
						if (summary) {
							summary.textContent = '';
						}
						return;
					}
					if (canvasState.allObjects.length === 0 && canvasState._allObjectsError) {
						var errMsg =
							canvasState._allObjectsError.status === 409 ||
							canvasState._allObjectsError.bodyError === 'no-active-connection'
								? 'Salesforce session lost - reconnect from the SF chip above.'
								: 'Couldn\u2019t load the Salesforce schema. Refresh to try again.';
						list.innerHTML = '<div class="fop-empty">' + errMsg + '</div>';
						return;
					}
					if (capped.length === 0) {
						list.innerHTML = '<div class="fop-empty">' + escapeHtml(emptyText) + '</div>';
					} else {
						list.innerHTML = capped
							.map((o) => {
								const already = isAdded(o.name);
								const onCanvas = canvasState.selectedObjects.some((s) => s.name === o.name);
								const tag =
									(o.custom ? 'Custom' : 'Standard') + (o.queryable ? '' : ' \u00b7 not queryable');
								return (
									'<button type="button" class="fop-item' +
									(already ? ' is-already' : '') +
									'" data-fop-pick="' +
									escapeHtml(o.name) +
									'"' +
									(already
										? ' disabled title="Already on the canvas"'
										: onCanvas
											? ' title="Already on the canvas - pick again to add another"'
											: '') +
									'>' +
									'<span class="fop-label">' +
									escapeHtml(o.label) +
									'</span>' +
									'<span class="fop-name">' +
									escapeHtml(o.name) +
									'</span>' +
									'<span class="fop-tag">' +
									tag +
									'</span>' +
									'</button>'
								);
							})
							.join('');
					}
					if (summary) {
						summary.textContent =
							filtered.length > capped.length
								? 'Showing ' +
									capped.length +
									' of ' +
									filtered.length +
									' matching objects. Search to find the rest.'
								: 'Showing ' + capped.length + ' of ' + all.length + ' objects.';
					}
				};

				renderList();
				setTimeout(() => search.focus(), 0);

				let _lastSnap = canvasState.allObjects;
				const _refreshTimer = setInterval(() => {
					if (canvasState.allObjects !== _lastSnap) {
						_lastSnap = canvasState.allObjects;
						renderList();
					}
				}, 200);

				search.addEventListener('input', renderList);
				pop.querySelectorAll('[data-fop-type]').forEach((btn) => {
					btn.addEventListener('click', () => {
						typeFilter = btn.dataset.fopType;
						pop.querySelectorAll('[data-fop-type]').forEach((b) =>
							b.classList.toggle('active', b.dataset.fopType === typeFilter),
						);
						renderList();
					});
				});
				list.addEventListener('click', async (ev) => {
					const btn = ev.target.closest('[data-fop-pick]');
					if (!btn || btn.disabled) {
						return;
					}
					const name = btn.dataset.fopPick;
					cleanup();
					try {
						await onPick(name);
					} catch (err) {
						showBulkToast('Failed to add ' + name + ': ' + (err.message || err), 'error');
					}
				});

				const cleanup = () => {
					if (pop.parentNode) {
						pop.remove();
					}
					document.removeEventListener('mousedown', outside, true);
					document.removeEventListener('keydown', onEsc, true);
					clearInterval(_refreshTimer);
					if (_activeCleanup === cleanup) {
						_activeCleanup = null;
					}
				};
				_activeCleanup = cleanup;
				const outside = (ev) => {
					if (!pop.contains(ev.target) && ev.target !== triggerEl) {
						cleanup();
					}
				};
				const onEsc = (ev) => {
					if (ev.key === 'Escape') {
						cleanup();
					}
				};
				setTimeout(() => {
					document.addEventListener('mousedown', outside, true);
					document.addEventListener('keydown', onEsc, true);
				}, 0);
			}

			return {
				showFindObjectPopover: showFindObjectPopover,
			};
		},
	};
})();

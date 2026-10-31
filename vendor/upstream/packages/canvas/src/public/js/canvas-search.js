(function () {
	'use strict';
	// Searches canvas values and selects matching records by object.

	window.OrgLoom = window.OrgLoom || {};

	const SYSTEM_FIELDS = new Set([
		'Id',
		'CreatedDate',
		'CreatedById',
		'LastModifiedDate',
		'LastModifiedById',
		'SystemModstamp',
		'LastReferencedDate',
		'LastViewedDate',
		'IsDeleted',
	]);

	window.OrgLoom.canvasSearch = {
		mount: function mount(deps) {
			const required = ['canvasState', 'getCyInstance', 'escapeHtml', 'setSelection'];
			if (!deps) {
				throw new Error('canvas-search.mount: missing deps object');
			}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('canvas-search.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const getCyInstance = deps.getCyInstance;
			const escapeHtml = deps.escapeHtml;
			let activeObject = null;
			let activeRecords = [];
			const SELECTED_TAB = Symbol('selected');

			const modal = document.createElement('div');
			modal.className = 'modal canvas-search-modal hidden';
			modal.innerHTML =
				'<div class="modal-overlay" data-csr-close></div>' +
				'<div class="modal-body" style="max-width:640px">' +
				'<div class="modal-header">' +
				'<h3>Search canvas</h3>' +
				'<button class="modal-close" data-csr-close>&times;</button>' +
				'</div>' +
				'<div class="modal-content">' +
				'<input type="search" id="csr-input" class="csr-input" ' +
				'placeholder="Search field values across all cards on the canvas…" ' +
				'autocomplete="off" spellcheck="false">' +
				'<div class="csr-stats" id="csr-stats"></div>' +
				'<div class="csr-tabs" id="csr-tabs"></div>' +
				'<div class="csr-results" id="csr-results" role="region" aria-label="Search results"></div>' +
				'</div>' +
				'<div class="modal-footer">' +
				'<button class="button secondary" data-csr-close>Close</button>' +
				'</div>' +
				'</div>';
			document.body.appendChild(modal);

			const input = modal.querySelector('#csr-input');
			const statsEl = modal.querySelector('#csr-stats');
			const resultsEl = modal.querySelector('#csr-results');
			const tabsEl = modal.querySelector('#csr-tabs');

			function closeModal() {
				modal.classList.add('hidden');
				input.blur();
			}
			function openModal(initialQuery) {
				modal.classList.remove('hidden');
				if (typeof initialQuery === 'string' && initialQuery.length > 0) {
					input.value = initialQuery;
				}
				renderResults();
				requestAnimationFrame(() => {
					input.focus();
					input.select();
				});
			}

			modal.querySelectorAll('[data-csr-close]').forEach((el) => {
				el.addEventListener('click', closeModal);
			});
			document.addEventListener('keydown', (e) => {
				if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
					e.preventDefault();
					closeModal();
				}
			});

			function recordLabel(rec) {
				const v = (rec && rec.values) || {};
				if (v.Name) {
					return String(v.Name);
				}
				const fn = v.FirstName || '';
				const ln = v.LastName || '';
				if (fn || ln) {
					return (fn + ' ' + ln).trim();
				}
				if (v.Subject) {
					return String(v.Subject);
				}
				if (v.Title) {
					return String(v.Title);
				}
				if (v.CaseNumber) {
					return String(v.CaseNumber);
				}
				return rec && rec.objectName ? '(unnamed ' + rec.objectName + ')' : '(unnamed)';
			}

			function search(query) {
				const q = String(query || '')
					.trim()
					.toLowerCase();
				if (!q) {
					return { matches: [], recordsScanned: 0 };
				}
				const recs = Array.isArray(canvasState.bulkRecords) ? canvasState.bulkRecords : [];
				const matches = [];
				let recordsScanned = 0;
				for (const rec of recs) {
					if (!rec || rec.isTypeNode || rec.isPending) {
						continue;
					}
					recordsScanned++;
					const label = recordLabel(rec);
					const labelLower = label.toLowerCase();
					const labelHit = labelLower.indexOf(q) !== -1;
					let perRecordFieldHits = 0;
					const values = (rec && rec.values) || {};
					for (const k of Object.keys(values)) {
						if (!k || k.startsWith('_')) {
							continue;
						}
						if (SYSTEM_FIELDS.has(k)) {
							continue;
						}
						const v = values[k];
						if (v == null || v === '') {
							continue;
						}
						const sv = String(v);
						const svLower = sv.toLowerCase();
						const idx = svLower.indexOf(q);
						if (idx === -1) {
							continue;
						}
						matches.push({
							recordId: rec.id,
							objectName: rec.objectName,
							label,
							fieldName: k,
							value: sv,
							matchStart: idx,
							matchLen: q.length,
							kind: 'field',
						});
						perRecordFieldHits++;
					}
					if (perRecordFieldHits === 0) {
						if (labelHit) {
							matches.push({
								recordId: rec.id,
								objectName: rec.objectName,
								label,
								fieldName: null,
								value: label,
								matchStart: labelLower.indexOf(q),
								matchLen: q.length,
								kind: 'label',
							});
						} else if (rec.loadedFromId) {
							const idStr = String(rec.loadedFromId);
							const idIdx = idStr.toLowerCase().indexOf(q);
							if (idIdx !== -1) {
								matches.push({
									recordId: rec.id,
									objectName: rec.objectName,
									label,
									fieldName: null,
									value: idStr,
									matchStart: idIdx,
									matchLen: q.length,
									kind: 'id',
								});
							}
						}
					}
				}
				return { matches, recordsScanned };
			}

			function renderMatchedValue(value, matchStart, matchLen) {
				if (matchStart < 0) {
					return escapeHtml(value);
				}
				const before = value.slice(0, matchStart);
				const hit = value.slice(matchStart, matchStart + matchLen);
				const after = value.slice(matchStart + matchLen);
				return escapeHtml(before) + '<mark class="csr-mark">' + escapeHtml(hit) + '</mark>' + escapeHtml(after);
			}

			function selectedRecords() {
				return (canvasState.bulkRecords || []).filter(
					(record) =>
						record &&
						!record.isTypeNode &&
						!record.isPending &&
						canvasState.bulkSelectedIds?.has(record.id),
				);
			}

			function renderResults() {
				const query = input.value || '';
				const { matches, recordsScanned } = search(query);
				const groups = new Map();
				for (const match of matches) {
					const object = match.objectName || 'Record';
					if (!groups.has(object)) groups.set(object, new Map());
					const records = groups.get(object);
					if (!records.has(match.recordId)) records.set(match.recordId, { ...match, hits: [] });
					records.get(match.recordId).hits.push(match);
				}
				const objects = Array.from(groups.keys()).sort();
				const selected = selectedRecords();
				if (activeObject !== SELECTED_TAB && !groups.has(activeObject)) activeObject = objects[0] || null;
				const showingSelected = activeObject === SELECTED_TAB;
				activeRecords = showingSelected
					? selected.map((record) => ({
							recordId: record.id,
							objectName: record.objectName || 'Record',
							label: recordLabel(record),
							hits: [],
						}))
					: Array.from(groups.get(activeObject)?.values() || []);
				statsEl.textContent =
					!showingSelected && query.trim() && !matches.length
						? 'No matches in ' + recordsScanned + ' record' + (recordsScanned === 1 ? '' : 's') + '.'
						: '';
				const tabs = [
					...objects.map((object) => ({ key: object, label: object + ' (' + groups.get(object).size + ')' })),
					{
						key: SELECTED_TAB,
						label: 'Selected (' + selected.length + ')',
						disabled: !selected.length && !showingSelected,
					},
				];
				tabsEl.setAttribute('role', 'tablist');
				tabsEl.setAttribute('aria-label', 'Search results and selection');
				tabsEl.innerHTML = tabs
					.map(
						(tab, i) =>
							'<button type="button" class="csr-tab" role="tab" id="csr-tab-' +
							i +
							'" aria-controls="csr-results" aria-selected="' +
							(tab.key === activeObject) +
							'" tabindex="' +
							(tab.key === activeObject || (activeObject === null && !tab.disabled) ? '0' : '-1') +
							'" data-csr-tab="' +
							i +
							'"' +
							(tab.key === SELECTED_TAB ? ' data-csr-selected-tab' : '') +
							(tab.disabled ? ' disabled' : '') +
							'>' +
							escapeHtml(tab.label) +
							'</button>',
					)
					.join('');
				const activeIndex = tabs.findIndex((tab) => tab.key === activeObject);
				resultsEl.setAttribute('role', activeIndex >= 0 ? 'tabpanel' : 'region');
				if (activeIndex >= 0) resultsEl.setAttribute('aria-labelledby', 'csr-tab-' + activeIndex);
				else resultsEl.removeAttribute('aria-labelledby');
				tabsEl.querySelectorAll('[data-csr-tab]').forEach((tab, i) => {
					tab.addEventListener('click', () => {
						activeObject = tabs[i].key;
						renderResults();
						tabsEl.querySelector('[aria-selected="true"]').focus();
					});
					tab.addEventListener('keydown', (event) => {
						const enabled = Array.from(tabsEl.querySelectorAll('[data-csr-tab]:not(:disabled)'));
						const index = enabled.indexOf(tab);
						const next =
							event.key === 'ArrowRight'
								? (index + 1) % enabled.length
								: event.key === 'ArrowLeft'
									? (index + enabled.length - 1) % enabled.length
									: event.key === 'Home'
										? 0
										: event.key === 'End'
											? enabled.length - 1
											: null;
						if (next === null) return;
						event.preventDefault();
						enabled[next].click();
					});
				});
				resultsEl.scrollTop = 0;
				if (!activeRecords.length) {
					resultsEl.innerHTML = showingSelected
						? '<div class="csr-empty">No records selected.</div>'
						: query.trim()
							? '<div class="csr-empty">No field values or record names contain that.</div>'
							: '';
					return;
				}
				resultsEl.innerHTML =
					'<table class="csr-table"><colgroup><col class="csr-checkbox-column"><col class="csr-record-column"><col></colgroup><thead><tr><th colspan="2" scope="colgroup"><label class="csr-select-all"><input type="checkbox" data-csr-all> Select all</label></th><th scope="col">' +
					(showingSelected ? 'Object' : 'Matches') +
					'</th></tr></thead><tbody>' +
					activeRecords
						.map(
							(record, i) =>
								'<tr><td class="csr-select-cell"><input type="checkbox" data-csr-select="' +
								i +
								'" aria-label="Select ' +
								escapeHtml(record.label) +
								'"></td><td><button type="button" class="csr-result" data-csr-idx="' +
								i +
								'">' +
								escapeHtml(record.label) +
								'</button></td><td>' +
								(showingSelected
									? escapeHtml(record.objectName)
									: record.hits
											.map(
												(m) =>
													'<div class="csr-result-body"><span class="csr-field">' +
													escapeHtml(
														m.fieldName || (m.kind === 'id' ? 'Salesforce Id' : 'Name'),
													) +
													'</span><span class="csr-result-value">' +
													renderMatchedValue(m.value, m.matchStart, m.matchLen) +
													'</span></div>',
											)
											.join('')) +
								'</td></tr>',
						)
						.join('') +
					'</tbody></table>';
				resultsEl.querySelector('[data-csr-all]').addEventListener('change', (event) => {
					const ids = new Set(canvasState.bulkSelectedIds || []);
					for (const record of activeRecords) {
						if (event.target.checked) ids.add(record.recordId);
						else ids.delete(record.recordId);
					}
					applySelection(Array.from(ids));
				});
				resultsEl.querySelectorAll('[data-csr-select]').forEach((checkbox, i) => {
					checkbox.addEventListener('change', () => {
						const ids = new Set(canvasState.bulkSelectedIds || []);
						if (checkbox.checked) ids.add(activeRecords[i].recordId);
						else ids.delete(activeRecords[i].recordId);
						applySelection(Array.from(ids));
					});
				});
				syncCheckboxes();
				resultsEl.querySelectorAll('[data-csr-idx]').forEach((button, i) => {
					button.addEventListener('click', () => {
						jumpToRecord(activeRecords[i].recordId);
						closeModal();
					});
				});
			}

			function applySelection(ids) {
				const liveIds = new Set(
					canvasState.bulkRecords
						.filter((record) => record && !record.isTypeNode && !record.isPending)
						.map((record) => record.id),
				);
				deps.setSelection(ids.filter((id) => liveIds.has(id)));
				if (activeObject === SELECTED_TAB || activeRecords.some((record) => !liveIds.has(record.recordId))) {
					const scrollTop = resultsEl.scrollTop;
					renderResults();
					resultsEl.scrollTop = scrollTop;
					return;
				}
				syncCheckboxes();
			}

			function syncCheckboxes() {
				const selectedCount = selectedRecords().length;
				const selectedTab = tabsEl.querySelector('[data-csr-selected-tab]');
				selectedTab.textContent = 'Selected (' + selectedCount + ')';
				selectedTab.disabled = selectedCount === 0 && activeObject !== SELECTED_TAB;
				const selected = activeRecords.filter((record) =>
					canvasState.bulkSelectedIds?.has(record.recordId),
				).length;
				resultsEl.querySelectorAll('[data-csr-select]').forEach((checkbox, i) => {
					checkbox.checked = !!canvasState.bulkSelectedIds?.has(activeRecords[i].recordId);
					checkbox.closest('tr').classList.toggle('csr-selected', checkbox.checked);
				});
				const all = resultsEl.querySelector('[data-csr-all]');
				if (all) {
					all.checked = activeRecords.length > 0 && selected === activeRecords.length;
					all.indeterminate = selected > 0 && selected < activeRecords.length;
				}
			}

			let _debounce = null;
			input.addEventListener('input', () => {
				if (_debounce) {
					clearTimeout(_debounce);
				}
				_debounce = setTimeout(renderResults, 60);
			});
			input.addEventListener('keydown', (e) => {
				if (e.key !== 'Enter') {
					return;
				}
				const first = resultsEl.querySelector('[data-csr-idx]');
				if (first) {
					first.click();
				}
			});

			function jumpToRecord(recordId) {
				const cy = getCyInstance && getCyInstance();
				if (!cy) {
					return;
				}
				const node = cy.getElementById('r' + recordId);
				if (!node || !node.length) {
					return;
				}
				cy.animate({
					center: { eles: node },
					duration: 380,
					easing: 'ease-out',
				});
				try {
					node.addClass('csr-flash');
				} catch (_) {}
				setTimeout(() => {
					try {
						node.removeClass('csr-flash');
					} catch (_) {}
				}, 1400);
			}

			return { openModal: openModal };
		},
	};
})();

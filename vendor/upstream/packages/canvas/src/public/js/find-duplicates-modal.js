(function () {
	'use strict';
	// Finds likely duplicates with filterable keys and leaves ambiguous matches for user review.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.findDuplicatesModal = {
		mount: function mount(deps) {
			const required = [
				'canvasState',
				'escapeHtml',
				'recordOrdinal',
				'renderBulkView',
				'deleteRecord',
				'markPendingDelete',
				'isRecordPendingDelete',
				'showBulkToast',
				'getCyInstance',
			];
			if (!deps) {
				throw new Error('find-duplicates-modal.mount: missing deps object');
			}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('find-duplicates-modal.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const escapeHtml = deps.escapeHtml;
			const recordOrdinal = deps.recordOrdinal;
			const renderBulkView = deps.renderBulkView;
			const deleteRecord = deps.deleteRecord;
			const markPendingDelete = deps.markPendingDelete;
			const isRecordPendingDelete = deps.isRecordPendingDelete;
			const showBulkToast = deps.showBulkToast;
			const getCyInstance = deps.getCyInstance;
			const showBulkToastWithAction =
				typeof deps.showBulkToastWithAction === 'function' ? deps.showBulkToastWithAction : null;
			const undoStackSize = typeof deps.undoStackSize === 'function' ? deps.undoStackSize : null;
			const trimUndoStack = typeof deps.trimUndoStack === 'function' ? deps.trimUndoStack : null;

			function _jumpToRecord(recordId) {
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
				const overlay = document.querySelector('.fdm-overlay');
				if (overlay) {
					overlay.classList.add('fdm-peek');
				}
				setTimeout(() => {
					try {
						node.removeClass('csr-flash');
					} catch (_) {}
					if (overlay) {
						overlay.classList.remove('fdm-peek');
					}
				}, 1400);
			}

			const MATCH_RULES = {
				Contact: [['Email'], ['FirstName', 'LastName']],
				Lead: [['Email'], ['FirstName', 'LastName', 'Company']],
				User: [['Email'], ['Username'], ['FirstName', 'LastName']],
				Account: [['Name']],
				Asset: [['Name']],
				Opportunity: [['Name']],
				Case: [['Subject']],
			};
			const DEFAULT_RULE = [['Name']];

			function _matchRulesFor(objectName) {
				return MATCH_RULES[objectName] || DEFAULT_RULE;
			}

			function _normalize(v) {
				// Matching is intentionally conservative: trim, case-fold, and collapse whitespace only.
				if (v === null || v === undefined) {
					return '';
				}
				return String(v).trim().toLowerCase().replace(/\s+/g, ' ');
			}

			function _matchKey(rec, rules) {
				const v = rec.values || {};
				for (const fieldSet of rules) {
					const parts = [];
					let full = true;
					for (const f of fieldSet) {
						const norm = _normalize(v[f]);
						if (!norm) {
							full = false;
							break;
						}
						parts.push(f + ':' + norm);
					}
					if (full) {
						return { fields: fieldSet, key: parts.join('||') };
					}
				}
				return null;
			}

			function _displayName(rec) {
				const v = rec.values || {};
				const guess =
					v.Name ||
					(v.FirstName || v.LastName ? [v.FirstName, v.LastName].filter(Boolean).join(' ') : '') ||
					v.Subject ||
					v.CaseNumber ||
					v.Email ||
					'';
				return String(guess).trim() || rec.objectName + ' #' + recordOrdinal(rec);
			}

			function _matchExcerpt(rec, fields) {
				const v = rec.values || {};
				return fields
					.map((f) => f + ': ' + (v[f] || ''))
					.filter((s) => s.endsWith(': ') === false)
					.join(' · ');
			}

			function _sortGroupRecords(arr) {
				arr.sort((a, b) => {
					const aLoaded = !!a.loadedFromId,
						bLoaded = !!b.loadedFromId;
					if (aLoaded !== bLoaded) {
						return aLoaded ? -1 : 1;
					}
					return recordOrdinal(a) - recordOrdinal(b);
				});
			}

			function _scanForObject(objectName, fields, op) {
				if (!objectName || !Array.isArray(fields) || fields.length === 0) {
					return null;
				}
				op = op === 'or' ? 'or' : 'and';
				const recs = canvasState.bulkRecords.filter(
					(r) => r && !r.isTypeNode && !isRecordPendingDelete(r) && r.objectName === objectName,
				);
				if (recs.length < 2) {
					return null;
				}

				if (op === 'and') {
					const buckets = new Map();
					for (const rec of recs) {
						const v = rec.values || {};
						const parts = [];
						let full = true;
						for (const f of fields) {
							const norm = _normalize(v[f]);
							if (!norm) {
								full = false;
								break;
							}
							parts.push(f + ':' + norm);
						}
						if (!full) {
							continue;
						}
						const k = parts.join('||');
						if (!buckets.has(k)) {
							buckets.set(k, []);
						}
						buckets.get(k).push(rec);
					}
					const groups = [];
					for (const bucket of buckets.values()) {
						if (bucket.length < 2) {
							continue;
						}
						_sortGroupRecords(bucket);
						groups.push({ fields, records: bucket });
					}
					if (groups.length === 0) {
						return null;
					}
					return { objectName, groups, defaultFields: fields, op };
				}

				const parent = recs.map((_, i) => i);
				const find = (i) => {
					while (parent[i] !== i) {
						parent[i] = parent[parent[i]]; // path halving
						i = parent[i];
					}
					return i;
				};
				const union = (i, j) => {
					const ri = find(i),
						rj = find(j);
					if (ri !== rj) {
						parent[ri] = rj;
					}
				};
				for (const f of fields) {
					const byValue = new Map();
					for (let i = 0; i < recs.length; i++) {
						const v = (recs[i].values || {})[f];
						const norm = _normalize(v);
						if (!norm) {
							continue;
						}
						if (!byValue.has(norm)) {
							byValue.set(norm, []);
						}
						byValue.get(norm).push(i);
					}
					for (const idxs of byValue.values()) {
						if (idxs.length < 2) {
							continue;
						}
						for (let k = 1; k < idxs.length; k++) {
							union(idxs[0], idxs[k]);
						}
					}
				}
				const componentMap = new Map();
				for (let i = 0; i < recs.length; i++) {
					const root = find(i);
					if (!componentMap.has(root)) {
						componentMap.set(root, []);
					}
					componentMap.get(root).push(recs[i]);
				}
				const groups = [];
				for (const component of componentMap.values()) {
					if (component.length < 2) {
						continue;
					}
					_sortGroupRecords(component);
					groups.push({ fields, records: component });
				}
				if (groups.length === 0) {
					return null;
				}
				return { objectName, groups, defaultFields: fields, op };
			}

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

			function _availableFieldsForObject(objectName) {
				const recs = canvasState.bulkRecords.filter(
					(r) => r && !r.isTypeNode && !isRecordPendingDelete(r) && r.objectName === objectName,
				);
				const counts = new Map();
				for (const rec of recs) {
					const v = rec.values || {};
					for (const k of Object.keys(v)) {
						if (!k || k.startsWith('_')) {
							continue;
						}
						if (SYSTEM_FIELDS.has(k)) {
							continue;
						}
						const val = v[k];
						if (val === null || val === undefined || val === '') {
							continue;
						}
						counts.set(k, (counts.get(k) || 0) + 1);
					}
				}
				return Array.from(counts.entries())
					.map(([name, populated]) => ({ name, populated, total: recs.length }))
					.sort((a, b) => a.name.localeCompare(b.name));
			}

			function _defaultFieldsFor(objectName, availableFields) {
				const rules = _matchRulesFor(objectName);
				const availSet = new Set(availableFields.map((f) => f.name));
				for (const fieldSet of rules) {
					if (fieldSet.every((f) => availSet.has(f))) {
						return fieldSet.slice();
					}
				}
				return null;
			}

			function _eligibleObjects() {
				const counts = new Map();
				for (const r of canvasState.bulkRecords) {
					if (!r || r.isTypeNode) {
						continue;
					}
					if (isRecordPendingDelete(r)) {
						continue;
					}
					counts.set(r.objectName, (counts.get(r.objectName) || 0) + 1);
				}
				return Array.from(counts.entries())
					.filter(([, n]) => n >= 2)
					.map(([objectName, recordCount]) => ({ objectName, recordCount }))
					.sort((a, b) => a.objectName.localeCompare(b.objectName));
			}

			function _selectedActions(sections) {
				const selected = new Map();
				sections.forEach((section) => {
					section.groups.forEach((group) => {
						group.records.forEach((record) => {
							const action = section.actions && section.actions.get(record.id);
							if (action === 'remove' || (action === 'delete' && record.loadedFromId)) {
								selected.set(record.id, { record, action });
							}
						});
					});
				});
				return Array.from(selected.values());
			}

			function _applyLabel(sections) {
				const count = _selectedActions(sections).length;
				return count ? 'Apply changes (' + count + ')' : 'Apply changes';
			}

			function _renderBody(overlay, sections) {
				const body = overlay.querySelector('.fdm-body');
				if (!body) {
					return;
				}
				const expandedGroups = new Set(
					Array.from(
						body.querySelectorAll('[data-fdm-details][aria-expanded="true"]'),
						(toggle) => toggle.dataset.groupKey,
					),
				);
				let html = '';
				sections.forEach((section) => {
					html +=
						'<div class="fdm-section">' +
						'<div class="fdm-section-head">' +
						escapeHtml(section.objectName) +
						'</div>';
					section.groups.forEach((group, gi) => {
						const groupKey = section.objectName + ':' + gi;
						const showDetails = expandedGroups.has(groupKey);
						html +=
							'<div class="fdm-group">' +
							'<div class="fdm-group-head"><span>' +
							group.records.length +
							' records match</span>' +
							'<button type="button" class="fdm-details-toggle" data-fdm-details data-group-key="' +
							escapeHtml(groupKey) +
							'" aria-expanded="' +
							showDetails +
							'">' +
							(showDetails ? 'Hide details' : 'Show details') +
							'</button></div>' +
							'<ul class="fdm-rows">';
						group.records.forEach((rec) => {
							const action = (section.actions && section.actions.get(rec.id)) || '';
							const rowClass = 'fdm-row' + (action ? ' fdm-row--remove' : '');
							const badge = rec.loadedFromId
								? '<span class="fdm-badge fdm-badge--loaded" title="Existing Salesforce record">existing</span>'
								: '<span class="fdm-badge fdm-badge--draft" title="Draft record, not yet in Salesforce">draft</span>';
							const gotoBtn =
								'<button type="button" class="fdm-row-goto" data-fdm-goto="' +
								rec.id +
								'" title="Pan the canvas to this record and flash it" aria-label="Go to this record on the canvas">' +
								'<span aria-hidden="true">&#8689;</span>' +
								'</button>';
							html +=
								'<li class="' +
								rowClass +
								'">' +
								'<div class="fdm-row-label">' +
								'<span class="fdm-row-identity"><span class="fdm-row-name">' +
								escapeHtml(_displayName(rec)) +
								'</span>' +
								badge +
								'</span>' +
								'<select class="fdm-row-action" data-fdm-action="' +
								rec.id +
								'" data-object="' +
								escapeHtml(section.objectName) +
								'" aria-label="Action for ' +
								escapeHtml(_displayName(rec)) +
								'">' +
								'<option value=""' +
								(!action ? ' selected' : '') +
								'>No change</option>' +
								(rec.loadedFromId
									? '<option value="delete"' +
										(action === 'delete' ? ' selected' : '') +
										'>Mark for delete</option>'
									: '') +
								'<option value="remove"' +
								(action === 'remove' ? ' selected' : '') +
								'>Remove from canvas</option>' +
								'</select></div>' +
								gotoBtn +
								'<div class="fdm-row-excerpt"' +
								(showDetails ? '' : ' hidden') +
								'>' +
								escapeHtml(_matchExcerpt(rec, group.fields)) +
								'</div>' +
								'</li>';
						});
						html += '</ul></div>';
					});
					html += '</div>';
				});
				body.innerHTML = html;
				body.querySelectorAll('[data-fdm-details]').forEach((toggle) => {
					toggle.addEventListener('click', () => {
						const expanded = toggle.getAttribute('aria-expanded') !== 'true';
						toggle.setAttribute('aria-expanded', String(expanded));
						toggle.textContent = expanded ? 'Hide details' : 'Show details';
						toggle
							.closest('.fdm-group')
							.querySelectorAll('.fdm-row-excerpt')
							.forEach((excerpt) => {
								excerpt.hidden = !expanded;
							});
					});
				});
				const applyBtn = overlay.querySelector('.fdm-apply');
				if (applyBtn) {
					applyBtn.disabled = _selectedActions(sections).length === 0;
					applyBtn.textContent = _applyLabel(sections);
				}
				body.querySelectorAll('[data-fdm-action]').forEach((select) => {
					select.addEventListener('change', () => {
						const section = sections.find((entry) => entry.objectName === select.dataset.object);
						if (!section) return;
						if (!section.actions) section.actions = new Map();
						section.actions.set(Number(select.dataset.fdmAction), select.value);
						select.closest('.fdm-row').classList.toggle('fdm-row--remove', !!select.value);
						const applyBtn = overlay.querySelector('.fdm-apply');
						if (applyBtn) {
							applyBtn.disabled = _selectedActions(sections).length === 0;
							applyBtn.textContent = _applyLabel(sections);
						}
					});
				});
				body.querySelectorAll('[data-fdm-goto]').forEach((btn) => {
					btn.addEventListener('click', (e) => {
						e.preventDefault();
						e.stopPropagation();
						const recordId = parseInt(btn.dataset.fdmGoto, 10);
						if (Number.isFinite(recordId)) {
							_jumpToRecord(recordId);
						}
					});
				});
			}

			function _renderEmpty(overlay) {
				const body = overlay.querySelector('.fdm-body');
				if (body) {
					body.innerHTML =
						'<div class="fdm-empty">' + '<div class="fdm-empty-title">No duplicates found</div>' + '</div>';
				}
				const applyBtn = overlay.querySelector('.fdm-apply');
				if (applyBtn) {
					applyBtn.disabled = true;
					applyBtn.textContent = 'No duplicates selected';
				}
			}

			function _apply(sections) {
				// Only explicit row actions are applied; Salesforce deletions remain staged until upload.
				const actions = _selectedActions(sections).filter(
					({ record }) => canvasState.bulkRecords.includes(record) && !isRecordPendingDelete(record),
				);
				const _snapBulk = canvasState.bulkRecords.slice();
				const _snapAssoc = canvasState.bulkAssociations.slice();
				const _snapSelected = new Set(canvasState.bulkSelectedIds);
				const _undoSizeBefore = undoStackSize ? undoStackSize() : 0;
				const _markedRecordIds = [];
				let removed = 0,
					marked = 0,
					skipped = 0;
				actions.forEach(({ record: rec, action }) => {
					if (action === 'delete') {
						if (markPendingDelete(rec.id, { allowModified: true })) {
							marked++;
							_markedRecordIds.push(rec.id);
						} else {
							skipped++;
						}
					}
				});
				actions.forEach(({ record: rec, action }) => {
					if (action === 'remove') {
						deleteRecord(rec.id);
						if (!canvasState.bulkRecords.includes(rec)) removed++;
						else skipped++;
					}
				});
				if (trimUndoStack && undoStackSize) {
					trimUndoStack(undoStackSize() - _undoSizeBefore);
				}
				renderBulkView();
				const parts = [];
				if (removed > 0) {
					parts.push(removed + ' record' + (removed === 1 ? '' : 's') + ' removed from canvas');
				}
				if (marked > 0) {
					parts.push(
						marked +
							' existing record' +
							(marked === 1 ? '' : 's') +
							' marked for delete on the next upload',
					);
				}
				if (skipped) parts.push(skipped + ' skipped; check delete access');
				const msg = parts.length === 0 ? 'No duplicates changed.' : parts.join(' · ');
				const _postBulk = canvasState.bulkRecords;
				const _postAssoc = canvasState.bulkAssociations;
				const _postFingerprint = JSON.stringify({
					records: canvasState.bulkRecords,
					associations: canvasState.bulkAssociations,
				});
				const _undo = () => {
					// Do not restore an old snapshot after unrelated canvas edits.
					let currentFingerprint = null;
					try {
						currentFingerprint = JSON.stringify({
							records: canvasState.bulkRecords,
							associations: canvasState.bulkAssociations,
						});
					} catch (_e) {}
					if (
						canvasState.bulkRecords !== _postBulk ||
						canvasState.bulkAssociations !== _postAssoc ||
						currentFingerprint !== _postFingerprint
					) {
						showBulkToast('Can’t undo duplicate changes because the canvas was edited afterward.', 'info');
						return;
					}
					canvasState.bulkRecords = _snapBulk;
					canvasState.bulkAssociations = _snapAssoc;
					canvasState.bulkSelectedIds = _snapSelected;
					_markedRecordIds.forEach((id) => {
						const r = canvasState.bulkRecords.find((x) => x.id === id);
						if (r) {
							r.pendingDelete = false;
						}
					});
					renderBulkView();
					showBulkToast('Undid duplicate changes.');
				};
				if (removed + marked > 0 && showBulkToastWithAction) {
					showBulkToastWithAction(msg, 'Undo', _undo);
				} else {
					showBulkToast(msg);
				}
			}

			function openFindDuplicatesModal() {
				document.querySelectorAll('.fdm-overlay').forEach((el) => el.remove());
				const overlay = document.createElement('div');
				overlay.className = 'modal fdm-overlay';
				overlay.innerHTML =
					'<div class="modal-overlay" data-fdm-close></div>' +
					'<div class="modal-body fdm-body-wrap">' +
					'<div class="modal-header">' +
					'<h3>Find duplicates</h3>' +
					'<button class="modal-close" data-fdm-close>&times;</button>' +
					'</div>' +
					'<div class="modal-content fdm-content">' +
					'<div class="fdm-body"></div>' +
					'</div>' +
					'<div class="modal-footer fdm-footer"></div>' +
					'</div>';
				document.body.appendChild(overlay);
				const cleanup = () => overlay.remove();
				overlay.querySelectorAll('[data-fdm-close]').forEach((el) => el.addEventListener('click', cleanup));
				const onEsc = (ev) => {
					if (ev.key === 'Escape') {
						cleanup();
						document.removeEventListener('keydown', onEsc, true);
					}
				};
				document.addEventListener('keydown', onEsc, true);

				const _fieldMemory = new Map();
				const _modeRef = { op: 'and' };

				const eligible = _eligibleObjects();
				if (eligible.length === 0) {
					_renderNoEligible(overlay);
					return;
				}
				const initial = eligible[0].objectName;
				_renderConfig(overlay, initial, eligible, _fieldMemory, _modeRef, cleanup);
			}

			function _renderNoEligible(overlay) {
				const body = overlay.querySelector('.fdm-body');
				const footer = overlay.querySelector('.fdm-footer');
				if (body) {
					body.innerHTML =
						'<div class="fdm-empty">' +
						'<div class="fdm-empty-title">Nothing to scan</div>' +
						'<div class="fdm-empty-hint">Find duplicates needs at least 2 records of the same object type. Add more records to the canvas, then come back.</div>' +
						'</div>';
				}
				if (footer) {
					footer.innerHTML = '<button class="button secondary" data-fdm-close>Close</button>';
					footer
						.querySelectorAll('[data-fdm-close]')
						.forEach((el) => el.addEventListener('click', () => overlay.remove()));
				}
			}

			function _renderConfig(overlay, objectName, eligible, fieldMemory, modeRef, cleanup) {
				const body = overlay.querySelector('.fdm-body');
				const footer = overlay.querySelector('.fdm-footer');

				const available = _availableFieldsForObject(objectName);
				let selected;
				if (fieldMemory.has(objectName)) {
					selected = new Set(fieldMemory.get(objectName));
				} else {
					const defaults = _defaultFieldsFor(objectName, available);
					if (defaults && defaults.length > 0) {
						selected = new Set(defaults);
					} else {
						const top = available.slice().sort((a, b) => b.populated - a.populated)[0];
						selected = new Set(top ? [top.name] : []);
					}
				}

				const objectOptions = eligible
					.map(
						(e) =>
							'<option value="' +
							escapeHtml(e.objectName) +
							'"' +
							(e.objectName === objectName ? ' selected' : '') +
							'>' +
							escapeHtml(e.objectName) +
							' (' +
							e.recordCount +
							')' +
							'</option>',
					)
					.join('');

				const defaultsSet = new Set(_defaultFieldsFor(objectName, available) || []);
				const fieldRows =
					available.length === 0
						? '<div class="fdm-fields-empty">None of the records of this object type have any field values yet. Fill some fields first, then come back.</div>'
						: available
								.map((f) => {
									const checked = selected.has(f.name) ? ' checked' : '';
									const isDefault = defaultsSet.has(f.name);
									return (
										'<label class="fdm-field-row">' +
										'<input type="checkbox" data-fdm-field value="' +
										escapeHtml(f.name) +
										'"' +
										checked +
										'>' +
										'<span class="fdm-field-name"><code>' +
										escapeHtml(f.name) +
										'</code></span>' +
										(isDefault ? '<span class="fdm-field-tag">suggested</span>' : '') +
										'<span class="fdm-field-pop">' +
										f.populated +
										' of ' +
										f.total +
										' populated</span>' +
										'</label>'
									);
								})
								.join('');

				if (body) {
					const andSelected = modeRef.op === 'and' ? ' selected' : '';
					const orSelected = modeRef.op === 'or' ? ' selected' : '';
					body.innerHTML =
						'<div class="fdm-config">' +
						'<label class="fdm-config-row">' +
						'<span class="fdm-config-label">Object</span>' +
						'<select id="fdm-object">' +
						objectOptions +
						'</select>' +
						'</label>' +
						'<div class="fdm-config-row fdm-config-row--match">' +
						'<label class="fdm-config-label" for="fdm-op">Match when</label>' +
						'<select id="fdm-op">' +
						'<option value="and"' +
						andSelected +
						'>All selected fields match</option>' +
						'<option value="or"' +
						orSelected +
						'>Any selected field matches</option>' +
						'</select>' +
						'</div>' +
						'<div class="fdm-config-row fdm-config-row--block">' +
						'<span class="fdm-config-label">Match fields</span>' +
						'<div class="fdm-fields">' +
						fieldRows +
						'</div>' +
						'</div>' +
						'</div>';
				}
				if (footer) {
					footer.innerHTML =
						'<button class="button secondary" data-fdm-close>Cancel</button>' +
						'<button class="button fdm-scan" id="fdm-scan">Scan for matches</button>';
					footer.querySelectorAll('[data-fdm-close]').forEach((el) => el.addEventListener('click', cleanup));
				}

				const updateScanEnabled = () => {
					const scanBtn = footer && footer.querySelector('#fdm-scan');
					if (scanBtn) {
						scanBtn.disabled = selected.size === 0;
					}
				};
				updateScanEnabled();

				const objSel = body && body.querySelector('#fdm-object');
				if (objSel) {
					objSel.addEventListener('change', () => {
						fieldMemory.set(objectName, Array.from(selected));
						_renderConfig(overlay, objSel.value, eligible, fieldMemory, modeRef, cleanup);
					});
				}
				if (body) {
					body.querySelectorAll('[data-fdm-field]').forEach((cb) => {
						cb.addEventListener('change', () => {
							if (cb.checked) {
								selected.add(cb.value);
							} else {
								selected.delete(cb.value);
							}
							updateScanEnabled();
						});
					});
					const modeSelect = body.querySelector('#fdm-op');
					if (modeSelect) {
						modeSelect.addEventListener('change', () => {
							modeRef.op = modeSelect.value === 'or' ? 'or' : 'and';
						});
					}
				}
				const scanBtn = footer && footer.querySelector('#fdm-scan');
				if (scanBtn) {
					scanBtn.addEventListener('click', () => {
						if (scanBtn.disabled) {
							return;
						}
						const fields = Array.from(selected);
						fieldMemory.set(objectName, fields);
						const section = _scanForObject(objectName, fields, modeRef.op);
						if (!section) {
							_renderEmpty(overlay);
							_renderResultsFooter(overlay, [], objectName, eligible, fieldMemory, modeRef, cleanup);
							return;
						}
						_renderBody(overlay, [section]);
						_renderResultsFooter(overlay, [section], objectName, eligible, fieldMemory, modeRef, cleanup);
					});
				}
			}

			function _renderResultsFooter(overlay, sections, objectName, eligible, fieldMemory, modeRef, cleanup) {
				const footer = overlay.querySelector('.fdm-footer');
				if (!footer) {
					return;
				}
				const selectedCount = _selectedActions(sections).length;
				footer.innerHTML =
					'<button class="button secondary" id="fdm-back">&larr; Back</button>' +
					'<button class="button secondary" data-fdm-close>Cancel</button>' +
					'<button class="button fdm-apply"' +
					(selectedCount === 0 ? ' disabled' : '') +
					'>' +
					_applyLabel(sections) +
					'</button>';
				footer.querySelectorAll('[data-fdm-close]').forEach((el) => el.addEventListener('click', cleanup));
				const backBtn = footer.querySelector('#fdm-back');
				if (backBtn) {
					backBtn.addEventListener('click', () =>
						_renderConfig(overlay, objectName, eligible, fieldMemory, modeRef, cleanup),
					);
				}
				const applyBtn = footer.querySelector('.fdm-apply');
				if (applyBtn) {
					applyBtn.addEventListener('click', () => {
						if (applyBtn.disabled) {
							return;
						}
						_apply(sections);
						cleanup();
					});
				}
			}

			return {
				openFindDuplicatesModal: openFindDuplicatesModal,
				_test: { apply: _apply, applyLabel: _applyLabel, renderBody: _renderBody },
			};
		},
	};
})();

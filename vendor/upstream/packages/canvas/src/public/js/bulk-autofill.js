(function () {
	'use strict';
	// Fills empty writable fields with type-aware samples and guards undo with value revisions.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.bulkAutofill = {
		mount: function mount(deps) {
			const required = [
				'canvasState',
				'csrfFetch',
				'ensureDescribe',
				'fieldTypeFilter',
				'getSmartDefault',
				'renderBulkView',
				'sampleValueForField',
				'showBulkToast',
				'showConfirmDialog',
				'loadSmartDefaults',
				'refreshCapabilities',
			];
			if (!deps) {
				throw new Error('bulk-autofill.mount: missing deps object');
			}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('bulk-autofill.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const ensureDescribe = deps.ensureDescribe;
			const fieldTypeFilter = deps.fieldTypeFilter;
			const getSmartDefault = deps.getSmartDefault;
			const renderBulkView = deps.renderBulkView;
			const sampleValueForField = deps.sampleValueForField;
			const showBulkToast = deps.showBulkToast;
			const showConfirmDialog = deps.showConfirmDialog;
			const loadSmartDefaults = deps.loadSmartDefaults;
			const refreshCapabilities = deps.refreshCapabilities;
			const showBulkToastWithAction =
				typeof deps.showBulkToastWithAction === 'function' ? deps.showBulkToastWithAction : null;

			function _replaceValues(rec, values) {
				rec.values = values;
				rec._valuesRevision = (Number(rec._valuesRevision) || 0) + 1;
			}

			function canFillField(record, field) {
				return (
					!!field &&
					!field.calculated &&
					!field.autoNumber &&
					(record.loadedFromId ? field.updateable === true : field.createable === true)
				);
			}

			function _valuesFingerprint(values) {
				try {
					return JSON.stringify(values || {});
				} catch (_e) {
					return null;
				}
			}

			function _captureValuesUndo(records) {
				// Undo is valid only while every affected record still matches the post-fill revision.
				const priorByRecord = new Map(records.map((r) => [r, r.values]));
				return function arm(touchedRecords) {
					const entries = touchedRecords.map((rec) => ({
						rec: rec,
						priorValues: priorByRecord.get(rec),
						expectedRevision: Number(rec._valuesRevision) || 0,
						expectedValues: rec.values,
						expectedFingerprint: _valuesFingerprint(rec.values),
					}));
					return function restore() {
						const stale = entries.some(
							(p) =>
								(Number(p.rec._valuesRevision) || 0) !== p.expectedRevision ||
								p.rec.values !== p.expectedValues ||
								_valuesFingerprint(p.rec.values) !== p.expectedFingerprint,
						);
						if (stale) {
							showBulkToast(
								'Can\u2019t undo Auto-fill because one or more affected records were edited afterward.',
								'info',
							);
							return;
						}
						entries.forEach((p) => _replaceValues(p.rec, p.priorValues));
						renderBulkView();
						showBulkToast('Restored the previous field values.');
					};
				};
			}

			function summarizeAutoFillTargets(records, scope, fieldType) {
				const linkedFieldsByRecord = new Map();
				(canvasState.bulkAssociations || []).forEach((association) => {
					if (!association || association.fromId == null || !association.fieldName) {
						return;
					}
					let linked = linkedFieldsByRecord.get(association.fromId);
					if (!linked) {
						linked = new Set();
						linkedFieldsByRecord.set(association.fromId, linked);
					}
					linked.add(association.fieldName);
				});

				let fillableFields = 0;
				let unresolvedRelationships = 0;
				const relationshipLabels = new Set();
				const typePick = fieldTypeFilter(fieldType || 'both');
				for (const rec of records || []) {
					const describe = canvasState.describeCache[rec.objectName];
					if (!describe || !Array.isArray(describe.fields)) {
						return null;
					}
					const values = rec.values || {};
					const linkedFields = linkedFieldsByRecord.get(rec.id) || new Set();
					for (const f of describe.fields) {
						if (
							!f ||
							!f.name ||
							!canFillField(rec, f) ||
							(scope === 'required' && !f.required) ||
							!typePick(f)
						) {
							continue;
						}
						const existing = values[f.name];
						const hasValue = existing !== undefined && existing !== '' && existing !== null;
						if (hasValue || (f.type === 'reference' && linkedFields.has(f.name))) {
							continue;
						}
						if (f.type === 'reference' && !getSmartDefault(rec.objectName, f.name)) {
							unresolvedRelationships++;
							relationshipLabels.add(f.label || f.name);
							continue;
						}
						fillableFields++;
					}
				}
				return {
					fillableFields,
					unresolvedRelationships,
					relationshipLabels: Array.from(relationshipLabels),
				};
			}

			async function bulkAutoFill(scope, fieldType, opts) {
				const operationCanvas = canvasState.currentCanvas;
				const operationRecords = canvasState.bulkRecords;
				const canCommit = () =>
					operationCanvas === canvasState.currentCanvas &&
					operationRecords === canvasState.bulkRecords &&
					(!deps.canCommit || deps.canCommit());
				// Relationship fields need real canvas links, so autofill reports rather than fabricates them.
				opts = opts || {};
				const onlyIds = Array.isArray(opts.tempIds) && opts.tempIds.length > 0 ? new Set(opts.tempIds) : null;
				const selectionScope = opts.selectionScope !== undefined ? !!opts.selectionScope : !!onlyIds;
				const silent = !!opts.silent;
				const skipConfirm = !!opts.skipConfirm;
				const includeLoaded = !!opts.includeLoaded;
				if (canvasState.bulkRecords.length === 0) {
					if (!silent) {
						showBulkToast('No records to fill.');
					}
					return;
				}
				let draftRecords = canvasState.bulkRecords.filter((r) => {
					if (r.isTypeNode || r.isPending) {
						return false;
					}
					if (r.loadedFromId && !includeLoaded) {
						return false;
					}
					return true;
				});
				const skippedLoaded = includeLoaded
					? 0
					: canvasState.bulkRecords.filter((r) => r.loadedFromId && !r.isTypeNode).length;
				if (onlyIds) {
					draftRecords = draftRecords.filter((r) => onlyIds.has(r.id));
				}
				if (draftRecords.length === 0) {
					const msg =
						skippedLoaded > 0
							? 'No draft records to fill. Seed only applies to new records; loaded-existing records keep their Salesforce values.'
							: 'No records to fill.';
					if (!silent) {
						showBulkToast(msg);
					}
					return;
				}
				const objectNames = Array.from(new Set(draftRecords.map((r) => r.objectName)));

				if (!silent && !skipConfirm) {
					const objCounts = new Map();
					draftRecords.forEach((r) => {
						objCounts.set(r.objectName, (objCounts.get(r.objectName) || 0) + 1);
					});
					const objSummary = Array.from(objCounts.entries())
						.sort((a, b) => b[1] - a[1])
						.slice(0, 3)
						.map(([name, n]) => n + ' ' + name)
						.join(', ');
					const moreObjs = objCounts.size > 3 ? ' + ' + (objCounts.size - 3) + ' more' : '';
					const recordWord = draftRecords.length === 1 ? 'record' : 'records';
					const scopeNoun = scope === 'required' ? 'required' : 'all';
					const scopeLine =
						scope === 'required'
							? '• Adds sample data to empty required fields. Required relationships still need canvas connections.'
							: '• Adds sample data to empty fields. Relationship fields still need canvas connections.';
					const skipLine = selectionScope
						? '• Only draft records in your selection are changed.'
						: skippedLoaded > 0
							? '• Skips ' +
								skippedLoaded +
								' loaded Salesforce record' +
								(skippedLoaded === 1 ? '' : 's') +
								' on the canvas; only draft records are changed.'
							: '• Only draft records on the canvas are changed.';
					const scopeQualifier = selectionScope ? ' selected' : '';
					const message =
						'Fill ' +
						scopeNoun +
						' fields on ' +
						draftRecords.length +
						scopeQualifier +
						' draft ' +
						recordWord +
						' (' +
						objSummary +
						moreObjs +
						').\n\n' +
						'What this does:\n' +
						scopeLine +
						'\n' +
						skipLine +
						'\n\n' +
						'Sample data is fictional (e.g. "Acme Corp", "name@example.com"). You can edit any field afterward.';
					const ok = await showConfirmDialog({
						title: scope === 'required' ? 'Fill required fields?' : 'Fill all fields?',
						message: message,
						confirmLabel: scope === 'required' ? 'Fill required' : 'Fill all',
					});
					if (!ok) {
						return;
					}
				}
				const access = await verifyAutoFillPermission();
				if (!access.allowed) {
					_showAutoFillAccessError(access.message);
					return false;
				}
				return Promise.all([loadSmartDefaults(), ...objectNames.map((n) => ensureDescribe(n))])
					.then(() => {
						if (!canCommit()) {
							showBulkToast('The canvas or editing session changed. No records were changed.', 'error');
							return false;
						}
						const _undo = _captureValuesUndo(draftRecords);
						let touchedCount = 0;
						const touchedRecords = [];
						draftRecords.forEach((rec) => {
							const describe = canvasState.describeCache[rec.objectName];
							if (!describe || !describe.fields) {
								return;
							}
							const values = Object.assign({}, rec.values || {});
							if (
								rec.objectName === 'User' &&
								canFillField(
									rec,
									describe.fields.find((field) => field.name === 'IsActive'),
								) &&
								(values.IsActive === undefined || values.IsActive === '' || values.IsActive === null)
							) {
								values.IsActive = false;
							}
							const recRtId = values.RecordTypeId || describe.defaultRecordTypeId || null;
							let touched = false;
							const ordered = [
								...describe.fields.filter((f) => !f.controllerName),
								...describe.fields.filter((f) => f.controllerName),
							];
							const typePick = fieldTypeFilter(fieldType);
							ordered.forEach((f) => {
								if (!canFillField(rec, f)) return;
								if (scope === 'required' && !f.required) {
									return;
								}
								if (!typePick(f)) {
									return;
								}
								const existing = values[f.name];
								if (existing === undefined || existing === '' || existing === null) {
									if (f.type === 'reference') {
										const smartId = getSmartDefault(rec.objectName, f.name);
										if (smartId) {
											values[f.name] = smartId;
											touched = true;
											return;
										}
									}
									const sample = sampleValueForField(
										f,
										describe.fields,
										values,
										recRtId,
										rec.objectName,
									);
									if (sample !== undefined && sample !== '' && sample !== null) {
										values[f.name] = sample;
										touched = true;
									}
								}
							});
							if (rec.objectName === 'User' && rec.values && rec.values.IsActive !== values.IsActive) {
								touched = true;
							}
							if (touched) {
								_replaceValues(rec, values);
								touchedRecords.push(rec);
								touchedCount++;
							}
						});
						renderBulkView();
						const label = scope === 'required' ? 'required fields' : 'all fields';
						const skipNote =
							skippedLoaded > 0
								? ' Skipped ' +
									skippedLoaded +
									' loaded record' +
									(skippedLoaded === 1 ? '' : 's') +
									' (Seed only applies to drafts).'
								: '';
						const recNoun = includeLoaded ? 'record' : 'draft record';
						const scopeNote = selectionScope ? ' selected' : '';
						const remaining = summarizeAutoFillTargets(draftRecords, scope, fieldType);
						const relationshipCount = remaining ? remaining.unresolvedRelationships : 0;
						const relationshipNote =
							relationshipCount > 0
								? ' ' +
									relationshipCount +
									(scope === 'required' ? ' required' : '') +
									' relationship' +
									(relationshipCount === 1 ? '' : 's') +
									' still need' +
									(relationshipCount === 1 ? 's' : '') +
									' a canvas connection.'
								: '';
						const _msg =
							'Pre-filled ' +
							label +
							' on ' +
							touchedCount +
							scopeNote +
							' ' +
							recNoun +
							(touchedCount === 1 ? '' : 's') +
							'.' +
							relationshipNote +
							skipNote;
						if (!silent) {
							if (touchedCount > 0 && showBulkToastWithAction) {
								showBulkToastWithAction(_msg, 'Undo', _undo(touchedRecords));
							} else {
								showBulkToast(_msg);
							}
						}
						return true;
					})
					.catch((err) => {
						if (!silent) {
							showBulkToast('Failed to load field metadata: ' + (err.message || err), 'error');
						}
						return false;
					});
			}

			async function bulkClearAllFields(opts) {
				const operationCanvas = canvasState.currentCanvas;
				const operationRecords = canvasState.bulkRecords;
				const canCommit = () =>
					operationCanvas === canvasState.currentCanvas &&
					operationRecords === canvasState.bulkRecords &&
					(!deps.canCommit || deps.canCommit());
				opts = opts || {};
				const onlyIds = Array.isArray(opts.tempIds) && opts.tempIds.length > 0 ? new Set(opts.tempIds) : null;
				const selectionScope = opts.selectionScope !== undefined ? !!opts.selectionScope : !!onlyIds;
				const includeLoaded = !!opts.includeLoaded;
				const skipConfirm = !!opts.skipConfirm;
				if (canvasState.bulkRecords.length === 0) {
					showBulkToast('No records to clear.');
					return;
				}
				let draftRecords = canvasState.bulkRecords.filter((r) => {
					if (r.isTypeNode || r.isPending) {
						return false;
					}
					if (r.loadedFromId && !includeLoaded) {
						return false;
					}
					return true;
				});
				const skippedLoaded = includeLoaded
					? 0
					: canvasState.bulkRecords.filter((r) => r.loadedFromId && !r.isTypeNode).length;
				if (onlyIds) {
					draftRecords = draftRecords.filter((r) => onlyIds.has(r.id));
				}
				if (draftRecords.length === 0) {
					const msg = onlyIds
						? 'No draft records in the selection. Clear only applies to drafts; loaded-existing records keep their Salesforce values.'
						: skippedLoaded > 0
							? 'No draft records to clear. Clear only applies to drafts; loaded-existing records keep their Salesforce values.'
							: 'No records to clear.';
					showBulkToast(msg);
					return;
				}
				const loadedInScope = includeLoaded ? draftRecords.filter((r) => r.loadedFromId).length : 0;
				if (!skipConfirm) {
					const ok = await showConfirmDialog({
						title: 'Clear fields?',
						message:
							'The next upload will clear field values for ' +
							loadedInScope +
							' Salesforce record' +
							(loadedInScope === 1 ? '.' : 's.'),
						confirmLabel: 'Clear fields',
						danger: true,
					});
					if (!ok) {
						return;
					}
				}
				const access = await verifyAutoFillPermission();
				if (!access.allowed) {
					_showAutoFillAccessError(access.message);
					return false;
				}
				if (!canCommit()) {
					showBulkToast('The canvas or editing session changed. No records were changed.', 'error');
					return false;
				}
				const _undo = _captureValuesUndo(draftRecords);
				let touchedCount = 0;
				const touchedRecords = [];
				draftRecords.forEach((rec) => {
					const hadValues = rec.values && Object.keys(rec.values).length > 0;
					if (hadValues) {
						_replaceValues(rec, {});
						touchedRecords.push(rec);
						touchedCount++;
					}
				});
				renderBulkView();
				const skipNote = selectionScope
					? ''
					: skippedLoaded > 0
						? ' Skipped ' +
							skippedLoaded +
							' loaded record' +
							(skippedLoaded === 1 ? '' : 's') +
							' (Clear only applies to drafts).'
						: '';
				const scopeNote = selectionScope ? ' selected' : '';
				const recNoun = includeLoaded ? 'record' : 'draft record';
				const _msg =
					'Cleared all fields on ' +
					touchedCount +
					scopeNote +
					' ' +
					recNoun +
					(touchedCount === 1 ? '' : 's') +
					'.' +
					skipNote;
				if (touchedCount > 0 && showBulkToastWithAction) {
					showBulkToastWithAction(_msg, 'Undo', _undo(touchedRecords));
				} else {
					showBulkToast(_msg);
				}
				return true;
			}

			async function verifyAutoFillPermission() {
				let response;
				let data = {};
				try {
					response = await csrfFetch('/api/capabilities/auto-fill-records/check', {
						method: 'POST',
						credentials: 'same-origin',
					});
					data = await response.json().catch(() => ({}));
				} catch (_error) {
					return {
						allowed: false,
						message:
							'Org Loom could not confirm your Auto-fill access. No records were changed. Try again.',
					};
				}
				if (response.ok) {
					return { allowed: true, message: '' };
				}
				if (response.status === 403) {
					await Promise.resolve(refreshCapabilities()).catch(() => {});
				}
				return {
					allowed: false,
					message: data.message || 'You no longer have permission to use Auto-fill. No records were changed.',
				};
			}

			function _showAutoFillAccessError(message) {
				if (typeof document === 'undefined' || !document.createElement) {
					showBulkToast(message, 'error');
					return;
				}
				document.querySelectorAll('.auto-fill-access-error-modal').forEach((el) => el.remove());
				const modal = document.createElement('div');
				modal.className = 'modal auto-fill-access-error-modal';
				modal.innerHTML =
					'<div class="modal-overlay" data-af-access-close></div>' +
					'<div class="modal-body" style="max-width:460px">' +
					'<div class="modal-header">' +
					'<h3>Unable to use Auto-fill</h3>' +
					'<button class="modal-close" data-af-access-close>&times;</button>' +
					'</div>' +
					'<div class="modal-content">' +
					'<p data-af-access-message></p>' +
					'<p class="tag" style="margin-top:0.65em">No records were changed.</p>' +
					'</div>' +
					'<div class="modal-footer">' +
					'<button class="button" data-af-access-close>Close</button>' +
					'</div>' +
					'</div>';
				document.body.appendChild(modal);
				const messageEl = modal.querySelector('[data-af-access-message]');
				if (messageEl) {
					messageEl.textContent = message;
				}
				const close = () => {
					document.removeEventListener('keydown', onKey);
					modal.remove();
				};
				const onKey = (event) => {
					if (event.key === 'Escape') {
						close();
					}
				};
				document.addEventListener('keydown', onKey);
				modal.querySelectorAll('[data-af-access-close]').forEach((el) => {
					el.addEventListener('click', close);
				});
			}

			return {
				bulkAutoFill: bulkAutoFill,
				bulkClearAllFields: bulkClearAllFields,
				summarizeAutoFillTargets: summarizeAutoFillTargets,
			};
		},
	};
})();

(function () {
	'use strict';
	// Applies one field edit across selected records while respecting per-object field permissions.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.bulkEditModal = {
		mount: function mount(deps) {
			if (
				!deps ||
				!deps.canvasState ||
				!deps.csrfFetch ||
				!deps.ensureDescribe ||
				!deps.escapeHtml ||
				!deps.renderBulkView ||
				!deps.showBulkToast ||
				!deps.refreshCapabilities
			) {
				throw new Error('bulk-edit-modal.mount: missing required deps');
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const ensureDescribe = deps.ensureDescribe;
			const escapeHtml = deps.escapeHtml;
			const renderBulkView = deps.renderBulkView;
			const showBulkToast = deps.showBulkToast;
			const refreshCapabilities = deps.refreshCapabilities;
			const showBulkToastWithAction =
				typeof deps.showBulkToastWithAction === 'function' ? deps.showBulkToastWithAction : null;

			function _replaceValues(rec, values) {
				rec.values = values;
				rec._valuesRevision = (Number(rec._valuesRevision) || 0) + 1;
			}

			function _valuesFingerprint(values) {
				try {
					return JSON.stringify(values || {});
				} catch (_e) {
					return null;
				}
			}

			function _captureValuesUndo(records, relationshipField) {
				// Arm undo after apply so revisions describe the exact state eligible for restoration.
				const priorByRecord = new Map(records.map((r) => [r, r.values]));
				const linksFor = (rec) =>
					relationshipField
						? (canvasState.bulkAssociations || []).filter(
								(a) => a.fromId === rec.id && a.fieldName === relationshipField,
							)
						: [];
				const priorLinks = new Map(records.map((r) => [r, linksFor(r).map((a) => ({ ...a }))]));
				return function arm(touchedRecords) {
					const entries = touchedRecords.map((rec) => ({
						rec: rec,
						priorValues: priorByRecord.get(rec),
						expectedRevision: Number(rec._valuesRevision) || 0,
						expectedValues: rec.values,
						expectedFingerprint: _valuesFingerprint(rec.values),
						expectedLinks: _valuesFingerprint(linksFor(rec)),
					}));
					return function restore() {
						const stale = entries.some(
							(p) =>
								!canvasState.bulkRecords.includes(p.rec) ||
								(Number(p.rec._valuesRevision) || 0) !== p.expectedRevision ||
								p.rec.values !== p.expectedValues ||
								_valuesFingerprint(p.rec.values) !== p.expectedFingerprint ||
								_valuesFingerprint(linksFor(p.rec)) !== p.expectedLinks ||
								priorLinks
									.get(p.rec)
									.some(
										(link) =>
											!canvasState.bulkRecords.some((r) => r.id === link.toId) ||
											(canvasState.bulkAssociations || []).some((a) => a.id === link.id),
									),
						);
						if (stale) {
							showBulkToast(
								'Can\u2019t undo Bulk edit because affected records or relationships changed afterward.',
								'info',
							);
							return;
						}
						entries.forEach((p) => _replaceValues(p.rec, p.priorValues));
						if (relationshipField) {
							const ids = new Set(entries.map((p) => p.rec.id));
							canvasState.bulkAssociations = (canvasState.bulkAssociations || [])
								.filter((a) => !(ids.has(a.fromId) && a.fieldName === relationshipField))
								.concat(entries.flatMap((p) => priorLinks.get(p.rec)));
						}
						renderBulkView();
						showBulkToast('Restored the previous field values.');
					};
				};
			}

			const bulkEditModal = document.createElement('div');
			bulkEditModal.className = 'modal bulk-edit-modal hidden';
			bulkEditModal.innerHTML =
				'<div class="modal-overlay" data-be-close></div>' +
				'<div class="modal-body" style="max-width:560px">' +
				'<div class="modal-header">' +
				'<h3>Bulk edit</h3>' +
				'<button class="modal-close" data-be-close>&times;</button>' +
				'</div>' +
				'<div class="modal-content" id="bulk-edit-content"></div>' +
				'<div class="bulk-edit-access-error" id="bulk-edit-access-error" role="alert" hidden></div>' +
				'<div class="modal-footer">' +
				'<span class="be-count" id="be-preview" role="status" aria-live="polite"></span>' +
				'<button class="button secondary" data-be-close>Cancel</button>' +
				'<button class="button" id="bulk-edit-apply">Apply</button>' +
				'</div>' +
				'</div>';
			document.body.appendChild(bulkEditModal);
			bulkEditModal
				.querySelectorAll('[data-be-close]')
				.forEach((el) => el.addEventListener('click', closeBulkEditModal));
			document.addEventListener('keydown', (e) => {
				if (e.key === 'Escape' && !bulkEditModal.classList.contains('hidden')) {
					closeBulkEditModal();
				}
			});

			let _beState = null; // { action, objectName, scope, fieldName, find, replace, caseSensitive, wholeField, value }
			let _checkingAccess = false;

			function openBulkEditModal() {
				if (canvasState.bulkRecords.length === 0) {
					showBulkToast('Add some records first.', 'error');
					return;
				}
				const objCounts = new Map();
				canvasState.bulkRecords.forEach((r) =>
					objCounts.set(r.objectName, (objCounts.get(r.objectName) || 0) + 1),
				);
				const activeObj =
					canvasState.selectedObjects[canvasState.activeIndex] &&
					objCounts.has(canvasState.selectedObjects[canvasState.activeIndex].name)
						? canvasState.selectedObjects[canvasState.activeIndex].name
						: Array.from(objCounts.keys())[0];
				_beState = {
					action: 'set',
					objectName: activeObj,
					scope: canvasState.bulkSelectedIds.size > 0 ? 'selected' : 'all',
					fieldName: null,
					find: '',
					replace: '',
					caseSensitive: false,
					wholeField: false,
					value: '',
				};
				_checkingAccess = false;
				const accessError = bulkEditModal.querySelector('#bulk-edit-access-error');
				if (accessError) {
					accessError.hidden = true;
					accessError.textContent = '';
				}
				ensureDescribe(activeObj)
					.then(() => {
						renderBulkEditModal();
					})
					.catch(() => renderBulkEditModal());
				bulkEditModal.classList.remove('hidden');
			}
			function closeBulkEditModal() {
				bulkEditModal.classList.add('hidden');
				_beState = null;
			}

			function _isStringLikeField(f) {
				if (!f) {
					return false;
				}
				return (
					[
						'string',
						'textarea',
						'email',
						'phone',
						'url',
						'encryptedstring',
						'picklist',
						'multipicklist',
						'combobox',
						'reference',
						'id',
					].indexOf(f.type) !== -1
				);
			}

			function _renderSetValueInput(field, current) {
				const cur = current == null ? '' : String(current);
				if (!field) {
					return (
						'<input type="text" id="be-value" value="' +
						escapeHtml(cur) +
						'" placeholder="Pick a field first">'
					);
				}
				switch (field.type) {
					case 'boolean': {
						const opt = (v, label) =>
							'<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + label + '</option>';
						return (
							'<select id="be-value">' +
							'<option value=""' +
							(cur === '' ? ' selected' : '') +
							'>(unset)</option>' +
							opt('true', 'True') +
							opt('false', 'False') +
							'</select>'
						);
					}
					case 'picklist':
					case 'combobox': {
						const opts = (Array.isArray(field.picklistValues) ? field.picklistValues : [])
							.filter((p) => p && p.active !== false)
							.map(
								(p) =>
									'<option value="' +
									escapeHtml(p.value) +
									'"' +
									(cur === p.value ? ' selected' : '') +
									'>' +
									escapeHtml(p.label || p.value) +
									'</option>',
							)
							.join('');
						return (
							'<select id="be-value"><option value=""' +
							(cur === '' ? ' selected' : '') +
							'>(clear)</option>' +
							opts +
							'</select>'
						);
					}
					case 'multipicklist': {
						const cur2 = cur ? cur.split(';') : [];
						const opts = (Array.isArray(field.picklistValues) ? field.picklistValues : [])
							.filter((p) => p && p.active !== false)
							.map(
								(p) =>
									'<option value="' +
									escapeHtml(p.value) +
									'"' +
									(cur2.indexOf(p.value) !== -1 ? ' selected' : '') +
									'>' +
									escapeHtml(p.label || p.value) +
									'</option>',
							)
							.join('');
						return (
							'<select id="be-value" multiple size="6" style="height:auto">' +
							opts +
							'</select>' +
							'<p class="tag" style="margin-top:0.3em">Hold Ctrl/Cmd to select multiple values.</p>'
						);
					}
					case 'date':
						return '<input type="date" id="be-value" value="' + escapeHtml(cur) + '">';
					case 'datetime':
						return '<input type="datetime-local" id="be-value" value="' + escapeHtml(cur) + '">';
					case 'int':
					case 'double':
					case 'currency':
					case 'percent': {
						const stepAttr = field.type === 'int' ? ' step="1"' : ' step="any"';
						return (
							'<input type="number" id="be-value" value="' +
							escapeHtml(cur) +
							'"' +
							stepAttr +
							' placeholder="Number">'
						);
					}
					case 'email':
						return (
							'<input type="email" id="be-value" value="' +
							escapeHtml(cur) +
							'" placeholder="name@example.com">'
						);
					case 'url':
						return (
							'<input type="text" inputmode="url" id="be-value" value="' +
							escapeHtml(cur) +
							'" placeholder="https://\u2026">'
						);
					case 'phone':
						return (
							'<input type="tel" id="be-value" value="' + escapeHtml(cur) + '" placeholder="+1 555 0100">'
						);
					case 'reference':
						return (
							'<input type="text" id="be-value" value="' +
							escapeHtml(cur) +
							'" placeholder="Salesforce Id (15 or 18 chars)">'
						);
					case 'textarea':
						return (
							'<textarea id="be-value" rows="3" placeholder="(leave blank to clear)">' +
							escapeHtml(cur) +
							'</textarea>'
						);
					default:
						return (
							'<input type="text" id="be-value" value="' +
							escapeHtml(cur) +
							'" placeholder="(leave blank to clear)">'
						);
				}
			}

			function _readSetValueFromInput(field, container) {
				if (!field) {
					return '';
				}
				if (field.type === 'multipicklist') {
					const sel = container.querySelector('#be-value');
					if (!sel) {
						return '';
					}
					return Array.from(sel.selectedOptions || [])
						.map((o) => o.value)
						.filter(Boolean)
						.join(';');
				}
				const el = container.querySelector('#be-value');
				return el ? String(el.value || '') : '';
			}

			function renderBulkEditModal() {
				if (!_beState) {
					return;
				}
				const content = bulkEditModal.querySelector('#bulk-edit-content');
				const describe = canvasState.describeCache[_beState.objectName];
				const fields =
					describe && Array.isArray(describe.fields)
						? describe.fields
								.filter((f) => f.createable)
								.slice()
								.sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name))
						: [];
				if (!_beState.fieldName && fields.length > 0) {
					_beState.fieldName = fields[0].name;
				}
				const currentField = fields.find((f) => f.name === _beState.fieldName) || null;
				const stringLike = _isStringLikeField(currentField);
				if (_beState.action === 'replace' && !stringLike && currentField) {
					_beState.action = 'set';
				}

				const objCounts = new Map();
				canvasState.bulkRecords.forEach((r) =>
					objCounts.set(r.objectName, (objCounts.get(r.objectName) || 0) + 1),
				);
				const objOptions = Array.from(objCounts.keys())
					.map((name) => {
						const sel = canvasState.selectedObjects.find((s) => s.name === name);
						const label = (sel && sel.label) || name;
						const sel2 = name === _beState.objectName ? ' selected' : '';
						return (
							'<option value="' +
							escapeHtml(name) +
							'"' +
							sel2 +
							'>' +
							escapeHtml(label) +
							' (' +
							objCounts.get(name) +
							')</option>'
						);
					})
					.join('');

				const fieldOptions =
					fields.length === 0
						? '<option value="">No editable fields available</option>'
						: fields
								.map((f) => {
									const sel = f.name === _beState.fieldName ? ' selected' : '';
									return (
										'<option value="' +
										escapeHtml(f.name) +
										'"' +
										sel +
										'>' +
										escapeHtml(f.label || f.name) +
										' (' +
										escapeHtml(f.name) +
										')</option>'
									);
								})
								.join('');

				const selectedScopeCount = canvasState.bulkRecords.filter(
					(r) => canvasState.bulkSelectedIds.has(r.id) && r.objectName === _beState.objectName,
				).length;
				const allScopeCount = objCounts.get(_beState.objectName) || 0;
				const scopeOptions =
					'<option value="all"' +
					(_beState.scope === 'all' ? ' selected' : '') +
					'>All records (' +
					allScopeCount +
					')</option>' +
					'<option value="selected"' +
					(_beState.scope === 'selected' ? ' selected' : '') +
					(selectedScopeCount === 0 ? ' disabled' : '') +
					'>Selected records (' +
					selectedScopeCount +
					')</option>';

				const actionOptions =
					'<option value="replace"' +
					(_beState.action === 'replace' ? ' selected' : '') +
					(stringLike ? '' : ' disabled') +
					'>Find &amp; replace</option>' +
					'<option value="set"' +
					(_beState.action === 'set' ? ' selected' : '') +
					'>Set value</option>';

				const actionPanel =
					_beState.action === 'replace'
						? '<div class="be-panel">' +
							'<div class="field"><div class="be-find-heading"><label for="be-find">Find</label>' +
							'<div class="be-match-options">' +
							'<label class="be-opt"><input type="checkbox" id="be-cs"' +
							(_beState.caseSensitive ? ' checked' : '') +
							'> Case sensitive</label>' +
							'<label class="be-opt"><input type="checkbox" id="be-whole"' +
							(_beState.wholeField ? ' checked' : '') +
							'> Match entire field</label>' +
							'</div>' +
							'</div><input type="text" id="be-find" value="' +
							escapeHtml(_beState.find) +
							'" placeholder="Text to search for"></div>' +
							'<div class="field"><label for="be-replace">Replace with</label><input type="text" id="be-replace" value="' +
							escapeHtml(_beState.replace) +
							'" placeholder="Replacement text"></div>' +
							'</div>'
						: '<div class="be-panel">' +
							'<div class="field"><label for="be-value">New value</label>' +
							_renderSetValueInput(currentField, _beState.value) +
							'</div>' +
							'</div>';

				content.innerHTML =
					'<div class="be-row"><label for="be-object">Object</label><select id="be-object">' +
					objOptions +
					'</select></div>' +
					'<div class="be-row"><label for="be-field">Field</label><select id="be-field">' +
					fieldOptions +
					'</select></div>' +
					'<div class="be-row"><label for="be-scope">Apply to</label><select id="be-scope">' +
					scopeOptions +
					'</select></div>' +
					'<div class="be-row"><label for="be-action">Action</label><select id="be-action">' +
					actionOptions +
					'</select></div>' +
					actionPanel;

				const objSel = content.querySelector('#be-object');
				objSel.addEventListener('change', () => {
					_beState.objectName = objSel.value;
					_beState.fieldName = null;
					ensureDescribe(_beState.objectName).then(renderBulkEditModal).catch(renderBulkEditModal);
				});
				const fldSel = content.querySelector('#be-field');
				if (fldSel) {
					fldSel.addEventListener('change', () => {
						_beState.fieldName = fldSel.value;
						renderBulkEditModal();
					});
				}
				const scopeSelect = content.querySelector('#be-scope');
				scopeSelect.addEventListener('change', () => {
					_beState.scope = scopeSelect.value;
					updateBulkEditPreview();
				});
				const actionSelect = content.querySelector('#be-action');
				actionSelect.addEventListener('change', () => {
					_beState.action = actionSelect.value;
					renderBulkEditModal();
					content.querySelector('#be-action').focus();
				});
				const findEl = content.querySelector('#be-find');
				if (findEl) {
					findEl.addEventListener('input', () => {
						_beState.find = findEl.value;
						updateBulkEditPreview();
					});
				}
				const repEl = content.querySelector('#be-replace');
				if (repEl) {
					repEl.addEventListener('input', () => {
						_beState.replace = repEl.value;
					});
				}
				const csEl = content.querySelector('#be-cs');
				if (csEl) {
					csEl.addEventListener('change', () => {
						_beState.caseSensitive = csEl.checked;
						updateBulkEditPreview();
					});
				}
				const wholeEl = content.querySelector('#be-whole');
				if (wholeEl) {
					wholeEl.addEventListener('change', () => {
						_beState.wholeField = wholeEl.checked;
						updateBulkEditPreview();
					});
				}
				const valEl = content.querySelector('#be-value');
				if (valEl) {
					const sync = () => {
						_beState.value = _readSetValueFromInput(currentField, content);
					};
					valEl.addEventListener('input', sync);
					valEl.addEventListener('change', sync);
				}

				updateBulkEditPreview();
			}

			function bulkEditAffectedRecords() {
				if (!_beState) {
					return [];
				}
				const recs = canvasState.bulkRecords.filter(
					(r) => r.objectName === _beState.objectName && !r.isTypeNode && !r.isPending,
				);
				if (_beState.scope === 'selected') {
					return recs.filter((r) => canvasState.bulkSelectedIds.has(r.id));
				}
				return recs;
			}

			function bulkEditMatchCount() {
				if (!_beState) {
					return 0;
				}
				if (_beState.action === 'set') {
					return bulkEditAffectedRecords().length;
				}
				const affected = bulkEditAffectedRecords();
				const f = _beState.find || '';
				if (f === '') {
					return 0;
				}
				let n = 0;
				affected.forEach((r) => {
					const v = r.values && r.values[_beState.fieldName];
					if (v == null || v === '') {
						return;
					}
					if (recordMatchesFind(String(v), f, _beState)) {
						n++;
					}
				});
				return n;
			}

			function recordMatchesFind(value, find, opts) {
				const cs = !!opts.caseSensitive;
				const whole = !!opts.wholeField;
				if (whole) {
					return cs ? value === find : value.toLowerCase() === find.toLowerCase();
				}
				return cs ? value.includes(find) : value.toLowerCase().includes(find.toLowerCase());
			}

			function updateBulkEditPreview() {
				const el = bulkEditModal.querySelector('#be-preview');
				const apply = bulkEditModal.querySelector('#bulk-edit-apply');
				if (!el || !_beState) {
					return;
				}
				if (!_beState.fieldName) {
					el.textContent = '';
					if (apply) {
						apply.disabled = true;
					}
					return;
				}
				const replacing = _beState.action === 'replace';
				const n = replacing ? bulkEditMatchCount() : bulkEditAffectedRecords().length;
				el.textContent =
					replacing && _beState.find === ''
						? ''
						: n + (replacing ? ' matching record' : ' record') + (n === 1 ? '' : 's');
				if (apply) {
					apply.disabled = (replacing && _beState.find === '') || n === 0;
				}
			}

			function _coerceForField(field, raw) {
				if (raw === '' || raw == null) {
					return null;
				}
				if (!field) {
					return raw;
				}
				switch (field.type) {
					case 'boolean':
						return raw === 'true' || raw === true;
					case 'int':
						return parseInt(raw, 10);
					case 'double':
					case 'currency':
					case 'percent':
						return Number(raw);
					case 'datetime': {
						const api = window.OrgLoom && window.OrgLoom.datetime;
						return api && typeof api.fromDateTimeLocal === 'function' ? api.fromDateTimeLocal(raw) : raw;
					}
					default:
						return raw;
				}
			}

			async function applyBulkEdit() {
				if (!_beState || !_beState.fieldName || _checkingAccess) {
					return;
				}
				const applyButton = bulkEditModal.querySelector('#bulk-edit-apply');
				const accessError = bulkEditModal.querySelector('#bulk-edit-access-error');
				_checkingAccess = true;
				if (applyButton) {
					applyButton.disabled = true;
					applyButton.textContent = 'Checking access…';
				}
				if (accessError) {
					accessError.hidden = true;
					accessError.textContent = '';
				}
				const access = await verifyBulkEditPermission();
				if (!_beState) {
					return;
				}
				_checkingAccess = false;
				if (applyButton) {
					applyButton.textContent = 'Apply';
				}
				if (!access.allowed) {
					if (accessError) {
						accessError.textContent = access.message;
						accessError.hidden = false;
					}
					updateBulkEditPreview();
					return;
				}
				const describe = canvasState.describeCache[_beState.objectName];
				const field =
					describe && Array.isArray(describe.fields)
						? describe.fields.find((f) => f.name === _beState.fieldName)
						: null;
				// Recompute the affected set at apply time rather than trusting the preview count.
				const affected = bulkEditAffectedRecords();
				const relationshipField = field && field.type === 'reference' ? field.name : null;
				const _undo = _captureValuesUndo(affected, relationshipField);
				let updatedCount = 0;
				const touchedRecords = [];
				if (_beState.action === 'replace') {
					const find = _beState.find;
					if (find === '') {
						return;
					}
					affected.forEach((r) => {
						const v = (r.values || {})[_beState.fieldName];
						if (v == null || v === '') {
							return;
						}
						const sv = String(v);
						if (!recordMatchesFind(sv, find, _beState)) {
							return;
						}
						let nv;
						if (_beState.wholeField) {
							nv = _beState.replace;
						} else if (_beState.caseSensitive) {
							nv = sv.split(find).join(_beState.replace);
						} else {
							const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
							const rep = _beState.replace;
							nv = sv.replace(new RegExp(escaped, 'gi'), () => rep);
						}
						_replaceValues(r, Object.assign({}, r.values || {}, { [_beState.fieldName]: nv }));
						touchedRecords.push(r);
						updatedCount++;
					});
				} else {
					const coerced = _coerceForField(field, _beState.value);
					if (field && field.type === 'datetime' && _beState.value && !coerced) {
						showBulkToast('Enter a time that exists in your Salesforce time zone.', 'warning');
						updateBulkEditPreview();
						return;
					}
					affected.forEach((r) => {
						const next = Object.assign({}, r.values || {});
						// Omitted fields are not uploaded. Keep an explicit null when the
						// user clears a value so Salesforce receives the field clear.
						next[_beState.fieldName] = coerced;
						_replaceValues(r, next);
						touchedRecords.push(r);
						updatedCount++;
					});
				}
				if (relationshipField) {
					// An explicit canvas link overrides its lookup on upload. A direct field
					// edit replaces that link; rendering derives any new edge from the new ID.
					const ids = new Set(touchedRecords.map((r) => r.id));
					canvasState.bulkAssociations = (canvasState.bulkAssociations || []).filter((a) => {
						if (!ids.has(a.fromId) || a.fieldName !== relationshipField) return true;
						if (canvasState.bulkSelectedEdgeId === a.id) canvasState.bulkSelectedEdgeId = null;
						return false;
					});
				}
				closeBulkEditModal();
				renderBulkView();
				const _msg = 'Updated ' + updatedCount + ' record' + (updatedCount === 1 ? '' : 's') + '.';
				if (updatedCount > 0 && showBulkToastWithAction) {
					showBulkToastWithAction(_msg, 'Undo', _undo(touchedRecords));
				} else {
					showBulkToast(_msg);
				}
			}

			async function verifyBulkEditPermission() {
				let response;
				let data = {};
				try {
					response = await csrfFetch('/api/capabilities/bulk-edit-records/check', {
						method: 'POST',
						credentials: 'same-origin',
					});
					data = await response.json().catch(() => ({}));
				} catch (_error) {
					return {
						allowed: false,
						message:
							'Org Loom could not confirm your Bulk edit access. No records were changed. Try again.',
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
					message: data.message || 'You no longer have permission to use Bulk edit. No records were changed.',
				};
			}
			bulkEditModal.querySelector('#bulk-edit-apply').onclick = applyBulkEdit;

			return {
				openModal: openBulkEditModal,
			};
		},
	};
})();

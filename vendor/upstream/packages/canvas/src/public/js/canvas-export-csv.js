(function () {
	'use strict';
	// Exports current record values, excluding encrypted and inaccessible data.

	window.OrgLoom = window.OrgLoom || {};

	const SYSTEM_FIELDS = new Set([
		'CreatedDate',
		'CreatedById',
		'LastModifiedDate',
		'LastModifiedById',
		'SystemModstamp',
		'LastReferencedDate',
		'LastViewedDate',
		'IsDeleted',
	]);

	const FIELD_PRIORITY = ['Id', 'Name', 'FirstName', 'LastName', 'Subject', 'Title', 'CaseNumber', 'Email', 'Phone'];
	const FORMULA_PREFIX = /^[=+\-@\t\r]/;

	window.OrgLoom.canvasExportCsv = {
		mount: function mount(deps) {
			const required = ['canvasState', 'csrfFetch', 'escapeHtml', 'showBulkToast', 'refreshCapabilities'];
			if (!deps) {
				throw new Error('canvas-export-csv.mount: missing deps object');
			}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('canvas-export-csv.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			const showBulkToast = deps.showBulkToast;
			const refreshCapabilities = deps.refreshCapabilities;

			function sanitizeFilename(s) {
				return (
					String(s || 'canvas')
						.replace(/[^a-zA-Z0-9_\-. ]+/g, '_')
						.slice(0, 80) || 'canvas'
				);
			}

			function csvEscape(v) {
				if (v == null) {
					return '';
				}
				let s = typeof v === 'string' ? v : String(v);
				// Neutralize spreadsheet formulas before quoting the CSV cell.
				if (FORMULA_PREFIX.test(s)) {
					s = "'" + s;
				}
				if (/[",\r\n]/.test(s)) {
					return '"' + s.replace(/"/g, '""') + '"';
				}
				return s;
			}

			function orderFields(names) {
				const set = new Set(names);
				const head = FIELD_PRIORITY.filter((f) => set.has(f));
				const headSet = new Set(head);
				const tail = Array.from(set)
					.filter((f) => !headSet.has(f))
					.sort();
				return head.concat(tail);
			}

			function selectScopedRecords(scope) {
				const all = (canvasState.bulkRecords || []).filter(
					(r) => r && !r.isTypeNode && !r.isPending && !r._permissionHidden && !r._inaccessible,
				);
				if (scope === 'selected') {
					const sel = canvasState.bulkSelectedIds;
					return all.filter((r) => sel && sel.has(r.id));
				}
				return all;
			}

			function collectFieldUnion(records) {
				const set = new Set();
				records.forEach((r) => {
					const v = (r && r.values) || {};
					Object.keys(v).forEach((k) => {
						if (!k || k.startsWith('_')) {
							return;
						}
						if (SYSTEM_FIELDS.has(k)) {
							return;
						}
						set.add(k);
					});
				});
				return Array.from(set);
			}

			function buildCsv(records, fields, leadingColumns) {
				const lead = Array.isArray(leadingColumns) ? leadingColumns : [];
				// Record exact escaped cells so import never has to guess whether an apostrophe is real data.
				const escapedCells = records.map((r) =>
					fields.flatMap((field) => {
						const value = r.values?.[field];
						return value != null && FORMULA_PREFIX.test(String(value))
							? [[field, "'" + String(value)]]
							: [];
					}),
				);
				const hasEscapes = escapedCells.some((cells) => cells.length);
				const headerCells = lead.map((c) => csvEscape(c.header)).concat(fields.map((f) => csvEscape(f)));
				if (hasEscapes) headerCells.push('__OrgLoom_EscapedCells');
				const lines = [headerCells.join(',')];
				records.forEach((r, index) => {
					const values = (r && r.values) || {};
					const leadCells = lead.map((c) => csvEscape(c.get(r)));
					const fieldCells = fields.map((f) => csvEscape(values[f]));
					if (hasEscapes)
						fieldCells.push(
							escapedCells[index].length
								? csvEscape(JSON.stringify({ version: 1, cells: escapedCells[index] }))
								: '',
						);
					lines.push(leadCells.concat(fieldCells).join(','));
				});
				return '﻿' + lines.join('\r\n');
			}

			function exportRows(records) {
				return records
					.filter((record) => !record._inaccessible && !record._permissionHidden)
					.map((record) => {
						const values = window.OrgLoom.valueCompare.exportRecordValues(record, canvasState);
						const clears = record.loadedFromId
							? Object.keys(values).filter(
									(field) =>
										field !== 'Id' &&
										!SYSTEM_FIELDS.has(field) &&
										(values[field] == null || values[field] === ''),
								)
							: [];
						return { values, clears };
					});
			}

			function triggerDownload(filename, csvText) {
				const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = filename;
				document.body.appendChild(a);
				a.click();
				setTimeout(() => {
					URL.revokeObjectURL(url);
					a.remove();
				}, 0);
			}

			const modal = document.createElement('div');
			modal.className = 'modal canvas-export-csv-modal hidden';
			modal.innerHTML =
				'<div class="modal-overlay" data-cec-close></div>' +
				'<div class="modal-body" style="max-width:540px">' +
				'<div class="modal-header">' +
				'<h3>Export canvas to CSV</h3>' +
				'<button class="modal-close" data-cec-close>&times;</button>' +
				'</div>' +
				'<div class="modal-content" id="cec-content"></div>' +
				'<div class="modal-footer" id="cec-footer"></div>' +
				'</div>';
			document.body.appendChild(modal);
			modal.querySelectorAll('[data-cec-close]').forEach((el) => {
				el.addEventListener('click', closeModal);
			});
			document.addEventListener('keydown', (e) => {
				if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
					closeModal();
				}
			});

			let _state = null;
			let _checkingAccess = false;

			function closeModal() {
				modal.classList.add('hidden');
				_state = null;
				_checkingAccess = false;
			}

			function openModal() {
				if (deps.canSaveOrExport?.() === false) return;
				const selectedCount = (canvasState.bulkRecords || []).filter(
					(r) =>
						r &&
						!r.isTypeNode &&
						!r.isPending &&
						canvasState.bulkSelectedIds &&
						canvasState.bulkSelectedIds.has(r.id),
				).length;
				const allCount = (canvasState.bulkRecords || []).filter(
					(r) => r && !r.isTypeNode && !r.isPending,
				).length;
				_state = {
					scope: selectedCount > 0 ? 'selected' : 'all',
					filename: defaultFilename(),
					selectedCount,
					allCount,
				};
				_checkingAccess = false;
				renderForm();
				modal.classList.remove('hidden');
			}

			function defaultFilename() {
				const title = canvasState.currentCanvas && canvasState.currentCanvas.title;
				const stem = sanitizeFilename(title || 'canvas-' + new Date().toISOString().slice(0, 10));
				return stem;
			}

			function renderForm() {
				if (!_state) {
					return;
				}
				const body = modal.querySelector('#cec-content');
				const footer = modal.querySelector('#cec-footer');
				const objectCounts = {};
				selectScopedRecords(_state.scope).forEach((r) => {
					const k = r.objectName || '(unknown)';
					objectCounts[k] = (objectCounts[k] || 0) + 1;
				});
				const objectNames = Object.keys(objectCounts).sort();
				const objectChips =
					objectNames.length === 0
						? '<span class="cec-empty">No records in scope.</span>'
						: objectNames
								.map(
									(n) =>
										'<span class="cec-obj-chip"><code>' +
										escapeHtml(n) +
										'</code> &middot; ' +
										objectCounts[n] +
										'</span>',
								)
								.join('');
				const scopeAllDisabled = _state.allCount === 0 ? ' disabled' : '';
				const scopeSelectedDisabled = _state.selectedCount === 0 ? ' disabled' : '';
				body.innerHTML =
					'<p class="tag">Downloads current record values, one CSV per object type. Encrypted fields, inaccessible records, and system-managed fields are excluded.</p>' +
					'<div class="cec-section">' +
					'<label class="cec-section-head">Scope</label>' +
					'<label class="cec-opt"><input type="radio" name="cec-scope" value="all"' +
					(_state.scope === 'all' ? ' checked' : '') +
					scopeAllDisabled +
					'> All records <span class="cec-meta">(' +
					_state.allCount +
					')</span></label>' +
					'<label class="cec-opt"><input type="radio" name="cec-scope" value="selected"' +
					(_state.scope === 'selected' ? ' checked' : '') +
					scopeSelectedDisabled +
					'> Selected only <span class="cec-meta">(' +
					_state.selectedCount +
					')</span></label>' +
					'</div>' +
					'<div class="cec-section">' +
					'<label class="cec-section-head" for="cec-filename">Filename</label>' +
					'<input type="text" id="cec-filename" value="' +
					escapeHtml(_state.filename) +
					'" maxlength="80">' +
					'<div class="cec-meta">' +
					(objectNames.length > 1
						? 'One file per object: <code>' + escapeHtml(_state.filename) + '-&lt;ObjectName&gt;.csv</code>'
						: '<code>' + escapeHtml(_state.filename) + '.csv</code>') +
					'</div>' +
					'</div>' +
					'<div class="cec-section">' +
					'<label class="cec-section-head">Included objects</label>' +
					'<div class="cec-objects">' +
					objectChips +
					'</div>' +
					'</div>' +
					'<div class="cec-access-error" role="alert" hidden></div>';
				const downloadDisabled = objectNames.length === 0 ? ' disabled aria-disabled="true"' : '';
				footer.innerHTML =
					'<button class="button secondary" data-cec-close>Cancel</button>' +
					'<button class="button" id="cec-download"' +
					downloadDisabled +
					'>Download</button>';
				footer.querySelectorAll('[data-cec-close]').forEach((el) => {
					el.addEventListener('click', closeModal);
				});
				body.querySelectorAll('input[name="cec-scope"]').forEach((el) => {
					el.addEventListener('change', () => {
						if (el.checked) {
							_state.scope = el.value;
							renderForm();
						}
					});
				});
				const filenameEl = body.querySelector('#cec-filename');
				if (filenameEl) {
					filenameEl.addEventListener('input', () => {
						_state.filename = filenameEl.value;
						const preview = body.querySelector('.cec-section .cec-meta code');
						if (preview) {
							preview.textContent =
								objectNames.length > 1
									? _state.filename + '-<ObjectName>.csv'
									: _state.filename + '.csv';
						}
					});
				}
				const downloadBtn = footer.querySelector('#cec-download');
				if (downloadBtn && !downloadBtn.disabled) {
					downloadBtn.addEventListener('click', runDownload);
				}
			}

			async function runDownload() {
				// Emit one file per object type so each CSV has a coherent Salesforce schema.
				if (!_state || _checkingAccess) {
					return;
				}
				const records = selectScopedRecords(_state.scope);
				if (records.length === 0) {
					showBulkToast('No records in the selected scope.', 'error');
					return;
				}
				const downloadButton = modal.querySelector('#cec-download');
				const errorBox = modal.querySelector('.cec-access-error');
				_checkingAccess = true;
				if (downloadButton) {
					downloadButton.disabled = true;
					downloadButton.textContent = 'Checking access…';
				}
				if (errorBox) {
					errorBox.hidden = true;
					errorBox.textContent = '';
				}
				const access = await verifyCsvExportPermission();
				if (!_state) {
					return;
				}
				_checkingAccess = false;
				if (!access.allowed) {
					if (errorBox) {
						errorBox.textContent = access.message;
						errorBox.hidden = false;
					}
					if (downloadButton) {
						downloadButton.disabled = false;
						downloadButton.textContent = 'Download';
					}
					return;
				}
				let projected;
				try {
					projected = exportRows(records);
				} catch (error) {
					showBulkToast(error.message, 'error');
					if (downloadButton) {
						downloadButton.disabled = false;
						downloadButton.textContent = 'Download';
					}
					return;
				}
				const stem = sanitizeFilename(_state.filename || 'canvas');
				const byObject = new Map();
				records.forEach((r, index) => {
					const key = r.objectName || 'Unknown';
					if (!byObject.has(key)) {
						byObject.set(key, []);
					}
					byObject.get(key).push(projected[index]);
				});
				const entries = Array.from(byObject.entries()).sort((a, b) => a[0].localeCompare(b[0]));
				const single = entries.length === 1;
				let i = 0;
				const fireNext = () => {
					if (i >= entries.length) {
						showBulkToast(
							'Exported ' +
								records.length +
								' record' +
								(records.length === 1 ? '' : 's') +
								' across ' +
								entries.length +
								' file' +
								(entries.length === 1 ? '' : 's') +
								'.',
						);
						closeModal();
						return;
					}
					const [objName, recs] = entries[i++];
					const fields = orderFields(collectFieldUnion(recs));
					const extra = recs.some((r) => r.clears.length)
						? [
								{
									header: '__OrgLoom_ClearFields',
									get: (r) => (r.clears.length ? JSON.stringify(r.clears) : ''),
								},
							]
						: [];
					const csv = buildCsv(recs, fields, extra);
					const name = single ? stem + '.csv' : stem + '-' + sanitizeFilename(objName) + '.csv';
					triggerDownload(name, csv);
					setTimeout(fireNext, 120);
				};
				fireNext();
			}

			async function verifyCsvExportPermission() {
				if (deps.canSaveOrExport?.() === false)
					return { allowed: false, message: 'Only the canvas owner or an editor can export this canvas.' };
				let response;
				let data = {};
				try {
					response = await csrfFetch('/api/capabilities/export-canvas/check', {
						method: 'POST',
						credentials: 'same-origin',
					});
					data = await response.json().catch(() => ({}));
					if (deps.canSaveOrExport?.() === false)
						return { allowed: false, message: 'Your canvas access changed. No file was downloaded.' };
				} catch (_error) {
					return {
						allowed: false,
						message:
							'Org Loom could not confirm your CSV export access. No files were downloaded. Try again.',
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
					message:
						data.message ||
						'You no longer have permission to export records as CSV. No files were downloaded.',
				};
			}

			return {
				openModal: openModal,
				_test: {
					csvEscape: csvEscape,
					buildCsv: buildCsv,
					exportRows: exportRows,
					orderFields: orderFields,
					collectFieldUnion: collectFieldUnion,
					sanitizeFilename: sanitizeFilename,
				},
			};
		},
	};
})();

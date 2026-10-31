(function () {
	'use strict';
	// Imports CSV record values while preserving Salesforce identity and field access rules.

	window.OrgLoom = window.OrgLoom || {};

	function csvDataColumns(file) {
		// Keep original indexes: the hidden metadata still drives explicit clears during import.
		return (file.headers || [])
			.map((name, index) => ({ name, index }))
			.filter((column) => column.name !== '__OrgLoom_ClearFields');
	}

	function exportedClearFields(file, row) {
		const index = (file.headers || []).indexOf('__OrgLoom_ClearFields');
		if (index < 0 || !row[index]) return new Set();
		try {
			const fields = JSON.parse(row[index]);
			return new Set(
				Array.isArray(fields) ? fields.filter((field) => typeof field === 'string' && field !== 'Id') : [],
			);
		} catch (_) {
			return new Set();
		}
	}
	window.OrgLoom.exportedClearFields = exportedClearFields;

	function csvFieldDisposition(field, operation) {
		if (!field) {
			return 'write';
		}
		if (field.type === 'address' || field.type === 'location' || field.calculated || field.autoNumber) {
			return 'context';
		}
		if (operation === 'update') {
			return field.updateable ? 'write' : 'context';
		}
		if (operation === 'upsert') {
			return field.createable || field.updateable ? 'write' : 'warn';
		}
		return field.createable ? 'write' : 'warn';
	}

	function csvRowOperation(file, sfId, idResolution) {
		if (file && file.operation === 'upsert') {
			return 'upsert';
		}
		if (sfId && idResolution && idResolution.liveById.has(String(sfId).slice(0, 15))) {
			return 'update';
		}
		return 'create';
	}

	function csvFieldAccessSuffix(field) {
		if (!field || field.name === 'Id') {
			return '';
		}
		const canCreate = field.createable === true;
		const canUpdate = field.updateable === true;
		if (canCreate && canUpdate) {
			return '';
		}
		if (!canCreate && !canUpdate) {
			return ' - read only';
		}
		return canCreate ? ' - new records only' : ' - existing records only';
	}

	function csvFieldOptionLabel(field) {
		if (field && field.name === 'Id') {
			return 'Salesforce ID';
		}
		return field && (field.label || field.name) ? field.label || field.name : '';
	}

	function isSalesforceId(value) {
		return /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(String(value || '').trim());
	}

	function isExternalKeyReferenceField(field) {
		return !!(
			field &&
			field.type === 'reference' &&
			(field.referenceTargetField ||
				(Array.isArray(field.referenceTo) &&
					field.referenceTo.some((target) => typeof target === 'string' && /__x$/i.test(target))))
		);
	}

	function csvImportCanceled(state, currentState) {
		return !state || state.cancelRequested === true || currentState !== state;
	}

	function linkedCsvReady(state) {
		if (!state || state.processingFiles || state.hasRejectedFileErrors) {
			return false;
		}
		if (
			state.files.some(
				(file) =>
					(file && Array.isArray(file.lookupErrors) && file.lookupErrors.length > 0) ||
					duplicateDirectFieldMappings(file).length > 0,
			)
		) {
			return false;
		}
		return (
			state.files.some(
				(file) =>
					file &&
					file.objectName &&
					Array.isArray(file.headers) &&
					file.headers.length > 0 &&
					Array.isArray(file.rows) &&
					file.rows.length > 0 &&
					Object.values(file.mapping || {}).some(Boolean),
			) &&
			!state.files.some((file) => file && Array.isArray(file.blockingErrors) && file.blockingErrors.length > 0)
		);
	}

	function duplicateDirectFieldMappings(file) {
		if (!file) {
			return [];
		}
		const columnsByField = new Map();
		Object.keys(file.mapping || {}).forEach((columnIdx) => {
			const fieldName = file.mapping[columnIdx];
			if (!fieldName) {
				return;
			}
			if (!columnsByField.has(fieldName)) {
				columnsByField.set(fieldName, []);
			}
			columnsByField.get(fieldName).push(Number(columnIdx));
		});
		return Array.from(columnsByField.entries())
			.filter(([, columnIdxs]) => columnIdxs.length > 1)
			.map(([fieldName, columnIdxs]) => ({
				fieldName,
				columnIdxs,
				headers: columnIdxs.map((columnIdx) => (file.headers || [])[columnIdx] || String(columnIdx + 1)),
			}));
	}

	function uniqueDirectFieldMapping(mapping) {
		const uniqueMapping = {};
		const usedFields = new Set();
		Object.keys(mapping || {}).forEach((columnIdx) => {
			const fieldName = mapping[columnIdx];
			if (!fieldName || usedFields.has(fieldName)) {
				return;
			}
			usedFields.add(fieldName);
			uniqueMapping[columnIdx] = fieldName;
		});
		return uniqueMapping;
	}

	function syncDuplicateFileNameNotice(state) {
		if (!state) {
			return;
		}
		state.notices = (state.notices || []).filter((notice) => notice.code !== 'duplicate-file-name');
		const counts = new Map();
		(state.files || []).forEach((file) => {
			const name = String((file && file.name) || '');
			if (name) {
				counts.set(name, (counts.get(name) || 0) + 1);
			}
		});
		const duplicates = Array.from(counts.entries())
			.filter(([, count]) => count > 1)
			.map(([name]) => name)
			.sort((left, right) => left.localeCompare(right));
		if (duplicates.length === 0) {
			return;
		}
		const list = duplicates.map((name) => '"' + name + '"').join(', ');
		state.notices.push({
			kind: 'warn',
			code: 'duplicate-file-name',
			text:
				duplicates.length === 1
					? 'Two or more files share the name ' +
						list +
						' - suffixed "(2)" etc. in the file list for clarity. Rename if you want a clearer distinction.'
					: 'Multiple files share names (' +
						list +
						') - suffixed "(2)" etc. in the file list. Rename if you want clearer labels.',
		});
	}

	window.OrgLoom.linkedCsv = {
		_test: {
			csvDataColumns,
			csvFieldDisposition,
			csvRowOperation,
			csvFieldAccessSuffix,
			csvFieldOptionLabel,
			isSalesforceId,
			isExternalKeyReferenceField,
			csvImportCanceled,
			linkedCsvReady,
			duplicateDirectFieldMappings,
			uniqueDirectFieldMapping,
			syncDuplicateFileNameNotice,
		},
		mount: function mount(deps) {
			if (
				!deps ||
				!deps.canvasState ||
				!deps.showBulkToast ||
				!deps.escapeHtml ||
				!deps.ensureDescribe ||
				!deps.csrfFetch ||
				!deps.renderBulkView ||
				!deps.getGraph ||
				!deps.parseCsv ||
				!deps.csvGuessObjectFromFilename ||
				!deps.csvAutoMapHeaders ||
				!deps.csvNormalizeKey ||
				!deps.pingAuditEvent ||
				!deps.addToSelection ||
				!deps.showConfirmDialog ||
				!deps.showPromptModal ||
				!deps.showReplaceOrMergeDialog ||
				!deps.canvasCapBlockReason ||
				!deps.allObjectsReady ||
				!deps.setSkipNextCyAutoPan ||
				!deps.relayoutNewRecords ||
				!deps.clearEmptyStarterCard
			) {
				throw new Error('linked-csv.mount: missing required deps');
			}
			const canvasState = deps.canvasState;
			const showBulkToast = deps.showBulkToast;
			const escapeHtml = deps.escapeHtml;
			const ensureDescribe = deps.ensureDescribe;
			const csrfFetch = deps.csrfFetch;
			const renderBulkView = deps.renderBulkView;
			const getGraph = deps.getGraph;
			const parseCsv = deps.parseCsv;
			const csvGuessObjectFromFilename = deps.csvGuessObjectFromFilename;
			const csvAutoMapHeaders = deps.csvAutoMapHeaders;
			const csvNormalizeKey = deps.csvNormalizeKey;
			const pingAuditEvent = deps.pingAuditEvent;
			const addToSelection = deps.addToSelection;
			const showConfirmDialog = deps.showConfirmDialog;
			const showPromptModal = deps.showPromptModal;
			const showReplaceOrMergeDialog = deps.showReplaceOrMergeDialog;
			const _canvasCapBlockReason = deps.canvasCapBlockReason;
			const _allObjectsReady = deps.allObjectsReady;
			const setSkipNextCyAutoPan = deps.setSkipNextCyAutoPan;
			const relayoutNewRecords = deps.relayoutNewRecords;
			const clearEmptyStarterCard = deps.clearEmptyStarterCard;
			const openRecordDiffModal =
				typeof deps.openRecordDiffModal === 'function' ? deps.openRecordDiffModal : null;
			const canvasCapCheck = typeof deps.canvasCapCheck === 'function' ? deps.canvasCapCheck : null;
			const captureUndoSnapshot =
				typeof deps.captureUndoSnapshot === 'function' ? deps.captureUndoSnapshot : null;
			const showBulkToastWithAction =
				typeof deps.showBulkToastWithAction === 'function' ? deps.showBulkToastWithAction : null;

			const linkedCsvModal = document.createElement('div');
			linkedCsvModal.id = 'linked-csv-modal';
			linkedCsvModal.className = 'modal hidden';
			linkedCsvModal.innerHTML =
				'<div class="modal-overlay" data-lcsv-close></div>' +
				'<div class="modal-body" style="max-width:920px">' +
				'<div class="modal-header">' +
				'<h3>Import from CSV</h3>' +
				'<button type="button" class="modal-close" data-lcsv-close aria-label="Close importer">&times;</button>' +
				'</div>' +
				'<div class="modal-content" id="linked-csv-content"></div>' +
				'<div class="modal-footer"></div>' +
				'</div>';
			document.body.appendChild(linkedCsvModal);
			linkedCsvModal
				.querySelectorAll('[data-lcsv-close]')
				.forEach((el) => el.addEventListener('click', () => closeLinkedCsvModal()));
			document.addEventListener('keydown', (e) => {
				if (e.key === 'Escape' && !linkedCsvModal.classList.contains('hidden')) {
					closeLinkedCsvModal();
				}
			});
			let linkedCsvState = null;

			function openLinkedCsvModal() {
				const footer = linkedCsvModal.querySelector('.modal-footer');
				footer.innerHTML =
					'<button class="button secondary" id="linked-csv-replace" disabled title="Drop everything currently on the canvas, then load this file onto a fresh canvas.">Replace canvas</button>' +
					'<button class="button" id="linked-csv-confirm" disabled title="Load records onto the canvas alongside what is already there. Use Upload from the canvas toolbar to push them to Salesforce.">Add to canvas</button>';
				footer.querySelector('#linked-csv-replace').onclick = confirmLinkedCsvReplace;
				footer.querySelector('#linked-csv-confirm').onclick = () =>
					runLinkedCsvAction('add', () => linkedCsvConfirm());
				const header = linkedCsvModal.querySelector('.modal-header h3');
				if (header) {
					header.textContent = 'Import from CSV';
				}

				linkedCsvState = {
					files: [],
					notices: [],
					processingFiles: false,
					hasRejectedFileErrors: false,
				};
				linkedCsvModal.classList.remove('hidden');
				linkedCsvRender();
				if (canvasState.allObjects === null) {
					_allObjectsReady.then(() => {
						if (linkedCsvState && !linkedCsvModal.classList.contains('hidden')) {
							linkedCsvRender();
						}
					});
				}
			}

			function closeLinkedCsvModal(force) {
				if (!force && linkedCsvState && linkedCsvState.importing) {
					linkedCsvState.cancelRequested = true;
				}
				linkedCsvModal.classList.add('hidden');
				linkedCsvState = null;
			}

			async function confirmLinkedCsvReplace() {
				const state = linkedCsvState;
				if (!state || state.importing || state.confirmingReplace) {
					return;
				}
				state.confirmingReplace = true;
				linkedCsvModal.classList.add('hidden');
				let confirmed = false;
				try {
					confirmed = await showConfirmDialog({
						title: 'Replace canvas?',
						message:
							'Replace all records on the current canvas with this import? Unsaved changes will be lost.',
						confirmLabel: 'Replace canvas',
						cancelLabel: 'Cancel',
						danger: true,
					});
				} finally {
					state.confirmingReplace = false;
					if (linkedCsvState === state) {
						linkedCsvModal.classList.remove('hidden');
						linkedCsvModal.querySelector('#linked-csv-replace').focus();
					}
				}
				if (confirmed && linkedCsvState === state) {
					await runLinkedCsvAction('replace', () => linkedCsvConfirm({ replaceCanvas: true }));
				}
			}

			async function runLinkedCsvAction(mode, action) {
				const state = linkedCsvState;
				if (!state || state.importing) {
					return;
				}
				state.importing = true;
				state.cancelRequested = false;
				linkedCsvModal.classList.add('lcsv-is-preparing');
				const buttons = linkedCsvModal.querySelectorAll('#linked-csv-replace, #linked-csv-confirm');
				buttons.forEach((button) => {
					button.disabled = true;
				});
				const activeButton = linkedCsvModal.querySelector(
					mode === 'replace' ? '#linked-csv-replace' : '#linked-csv-confirm',
				);
				if (activeButton) {
					activeButton.setAttribute('aria-busy', 'true');
					activeButton.innerHTML =
						'<span class="busy-spinner" aria-hidden="true"></span>' +
						(mode === 'replace' ? 'Replacing…' : 'Adding…');
				}
				try {
					await action();
				} finally {
					if (linkedCsvState === state) {
						state.importing = false;
						linkedCsvModal.classList.remove('lcsv-is-preparing');
						openLinkedCsvActionButtons();
						linkedCsvRender();
					}
				}
			}

			function openLinkedCsvActionButtons() {
				const replaceButton = linkedCsvModal.querySelector('#linked-csv-replace');
				const addButton = linkedCsvModal.querySelector('#linked-csv-confirm');
				if (replaceButton) {
					replaceButton.removeAttribute('aria-busy');
					replaceButton.textContent = 'Replace canvas';
				}
				if (addButton) {
					addButton.removeAttribute('aria-busy');
					addButton.textContent = 'Add to canvas';
				}
			}
			function guessObjectForFile(headers) {
				const candidates = [];
				for (const objectName of Object.keys(canvasState.describeCache)) {
					const describe = canvasState.describeCache[objectName];
					if (!describe || !Array.isArray(describe.fields)) {
						continue;
					}
					const fields = describe.fields.filter((f) => f.createable);
					if (fields.length === 0) {
						continue;
					}
					const byKey = new Map();
					fields.forEach((f) => {
						byKey.set(csvNormalizeKey(f.name), f.name);
						if (f.label) {
							byKey.set(csvNormalizeKey(f.label), f.name);
						}
					});
					let hits = 0;
					headers.forEach((h) => {
						if (byKey.has(csvNormalizeKey(h))) {
							hits++;
						}
					});
					if (hits > 0) {
						candidates.push({ name: objectName, hits, total: fields.length });
					}
				}
				candidates.sort((a, b) => b.hits - a.hits || a.total - b.total);
				return candidates[0] ? candidates[0].name : null;
			}

			function analyzeLinkedCsvs() {
				if (!linkedCsvState) {
					return;
				}
				const state = linkedCsvState;
				state.files.forEach((file) => {
					file.lookupErrors = [];
					if (!file.objectName || !file.describe) {
						return;
					}
					const directLookupByName = new Map(
						file.describe.fields
							.filter(
								(field) =>
									field.type === 'reference' &&
									Array.isArray(field.referenceTo) &&
									field.referenceTo.length > 0,
							)
							.map((field) => [field.name, field]),
					);
					Object.keys(file.mapping || {}).forEach((idxStr) => {
						const fieldName = file.mapping[idxStr];
						const lookupField = directLookupByName.get(fieldName);
						if (!lookupField || isExternalKeyReferenceField(lookupField)) {
							return;
						}
						const invalid = file.rows
							.map((row) => String(row[Number(idxStr)] || '').trim())
							.filter((value) => value && !isSalesforceId(value));
						if (invalid.length > 0) {
							file.lookupErrors.push({
								header: file.headers[Number(idxStr)],
								fieldName,
								count: invalid.length,
							});
						}
					});
				});
			}

			function linkedCsvHandleFiles(fileList) {
				const state = linkedCsvState;
				if (!state) {
					return;
				}
				const files = Array.from(fileList || []);
				state.notices = [];
				state.processingFiles = true;
				state.hasRejectedFileErrors = false;
				linkedCsvRender();
				const _shared = window.OrgLoom.importShared;
				const _CSV_GATE = {
					extRe: /\.csv$/i,
					extLabel: '.csv',
					maxBytes: 50 * 1024 * 1024,
					flowLabel: 'Import from CSV',
				};
				Promise.all(
					files.map(
						(f) =>
							new Promise((resolve) => {
								const _gateMsg = _shared.gateImportFile(f, _CSV_GATE);
								if (_gateMsg) {
									const _isCsvName = /\.csv$/i.test(String(f.name || ''));
									resolve({
										__rejected: true,
										name: f.name,
										reason: _isCsvName ? 'toolarge' : 'wrongtype',
										gateMsg: _gateMsg,
									});
									return;
								}
								const reader = new FileReader();
								reader.onerror = () =>
									resolve({ __rejected: true, name: f.name, reason: 'unreadable' });
								reader.onload = () => {
									if (String(reader.result || '').trim() === '') {
										resolve({ __rejected: true, name: f.name, reason: 'norows' });
										return;
									}
									let parsed;
									try {
										parsed = parseCsv(String(reader.result || ''));
									} catch (e) {
										resolve({ __rejected: true, name: f.name, reason: 'unreadable' });
										return;
									}
									if (String(reader.result || '').indexOf(String.fromCharCode(0)) !== -1) {
										resolve({ __rejected: true, name: f.name, reason: 'notcsv' });
										return;
									}
									if (!parsed.headers.length) {
										resolve({ __rejected: true, name: f.name, reason: 'notcsv' });
										return;
									}
									if (!parsed.rows.length) {
										resolve({ __rejected: true, name: f.name, reason: 'norows' });
										return;
									}
									const raggedRows = parsed.rows.filter(
										(r) => r.length !== parsed.headers.length,
									).length;
									const blankDataHeaders = parsed.headers.reduce((out, header, idx) => {
										if (
											!header &&
											parsed.rows.some((row) => String(row[idx] || '').trim() !== '')
										) {
											out.push(idx + 1);
										}
										return out;
									}, []);
									const blockingErrors = (parsed.errors || []).slice();
									if (raggedRows > 0) {
										blockingErrors.push(
											raggedRows +
												' row' +
												(raggedRows === 1 ? ' has' : 's have') +
												' a different column count than the header.',
										);
									}
									if (blankDataHeaders.length > 0) {
										blockingErrors.push(
											'Data appears under blank header column' +
												(blankDataHeaders.length === 1 ? '' : 's') +
												' ' +
												blankDataHeaders.join(', ') +
												'.',
										);
									}
									if (blockingErrors.length > 0) {
										resolve({
											__rejected: true,
											name: f.name,
											reason: 'structure',
											blockingErrors,
										});
										return;
									}
									resolve({
										name: f.name,
										headers: parsed.headers,
										rows: parsed.rows,
										raggedRows,
										blockingErrors,
										objectName: null,
										describe: null,
										mapping: {},
									});
								};
								reader.readAsText(f);
							}),
					),
				).then(async (parsedFiles) => {
					state.processingFiles = false;
					const valid = parsedFiles.filter((f) => f && !f.__rejected);
					const rejected = parsedFiles.filter((f) => f && f.__rejected);
					const structural = rejected.filter((f) => f.reason === 'structure');
					state.hasRejectedFileErrors = rejected.length > 0;
					state.files = state.files.concat(valid);
					syncDuplicateFileNameNotice(state);
					if (structural.length > 0) {
						const list = structural.map((f) => '"' + f.name + '": ' + f.blockingErrors.join(' ')).join(' ');
						state.notices.push({
							kind: 'error',
							text:
								'Import blocked because the CSV structure is unsafe. ' +
								list +
								' Fix the file and try again; no rows were imported.',
						});
					}
					if (rejected.length > 0) {
						const _sized = rejected.filter((f) => f.reason === 'toolarge');
						_sized.forEach((f) => state.notices.push({ kind: 'error', text: f.gateMsg }));
						const _rest = rejected.filter((f) => f.reason !== 'toolarge' && f.reason !== 'structure');
						_rest.forEach((f) => {
							const name = '"' + f.name + '"';
							const text =
								f.reason === 'wrongtype'
									? name + " isn't a CSV file - Import from CSV only accepts .csv files."
									: f.reason === 'norows'
										? name + ' has no data rows - nothing to import.'
										: name +
											" couldn't be read as a CSV and was skipped - drop a .csv file with a header row.";
							state.notices.push({ kind: 'error', text });
						});
						rejected.forEach((f) =>
							_shared.captureImportFailure(
								'csv',
								f.reason === 'wrongtype' ? 'type' : f.reason === 'toolarge' ? 'size' : f.reason,
							),
						);
					}
					for (const file of valid) {
						let guessed = csvGuessObjectFromFilename(file.name, canvasState.allObjects || []);
						if (!guessed) {
							guessed = guessObjectForFile(file.headers);
						}
						if (guessed) {
							file.objectName = guessed;
							if (canvasState.describeCache[guessed]) {
								file.describe = canvasState.describeCache[guessed];
							} else {
								try {
									file.describe = await ensureDescribe(guessed);
								} catch (e) {
									file.describe = null;
								}
							}
							if (file.describe) {
								file.mapping = uniqueDirectFieldMapping(
									csvAutoMapHeaders(file.headers, file.describe.fields || []),
								);
							}
						}
					}
					analyzeLinkedCsvs();
					linkedCsvRender();
				});
			}

			async function linkedCsvSetObject(fileIdx, objectName) {
				const state = linkedCsvState;
				if (!state || !state.files[fileIdx]) {
					return;
				}
				const file = state.files[fileIdx];
				file.objectName = objectName || null;
				if (objectName) {
					try {
						file.describe = await ensureDescribe(objectName);
						file.mapping = uniqueDirectFieldMapping(
							csvAutoMapHeaders(file.headers, file.describe.fields || []),
						);
					} catch (e) {
						file.describe = null;
						file.mapping = {};
					}
				} else {
					file.describe = null;
					file.mapping = {};
				}
				analyzeLinkedCsvs();
				linkedCsvRender();
			}

			function linkedCsvRemoveFile(fileIdx) {
				const state = linkedCsvState;
				if (!state) {
					return;
				}
				state.files.splice(fileIdx, 1);
				syncDuplicateFileNameNotice(state);
				analyzeLinkedCsvs();
				linkedCsvRender();
			}

			function linkedCsvUpdateColumn(fileIdx, columnIdx, fieldName) {
				const state = linkedCsvState;
				if (!state || !state.files[fileIdx]) {
					return;
				}
				const file = state.files[fileIdx];
				if (file.headers[columnIdx] === '__OrgLoom_ClearFields') return;
				if (!file.mapping) {
					file.mapping = {};
				}
				if (fieldName) {
					const existingColumnIdx = Object.keys(file.mapping).find(
						(otherColumnIdx) =>
							Number(otherColumnIdx) !== columnIdx && file.mapping[otherColumnIdx] === fieldName,
					);
					if (existingColumnIdx != null) {
						showBulkToast(
							fieldName +
								' is already mapped from ' +
								(file.headers[Number(existingColumnIdx)] || 'another CSV column') +
								'. Choose a different field or skip this column.',
							'error',
						);
						linkedCsvRender();
						return;
					}
				}
				if (fieldName) {
					file.mapping[columnIdx] = fieldName;
				} else {
					delete file.mapping[columnIdx];
				}
				analyzeLinkedCsvs();
				linkedCsvRender();
			}

			function linkedCsvUpdateOperation(fileIdx, operation) {
				const state = linkedCsvState;
				if (!state || !state.files[fileIdx]) {
					return;
				}
				const file = state.files[fileIdx];
				file.operation = operation;
				if (operation === 'upsert') {
					// External-ID upserts require a writable, filterable field that is present in the CSV.
					const eligible =
						file.describe && Array.isArray(file.describe.fields)
							? file.describe.fields.filter(
									(f) => f && f.externalId && f.filterable === true && f.createable,
								)
							: [];
					const mapped = new Set(Object.values(file.mapping || {}).filter(Boolean));
					const pick = eligible.find((f) => mapped.has(f.name));
					file.externalIdFieldName = pick ? pick.name : null;
				} else {
					file.externalIdFieldName = null;
				}
				linkedCsvRender();
			}

			function linkedCsvUpdateExternalIdField(fileIdx, fieldName) {
				const state = linkedCsvState;
				if (!state || !state.files[fileIdx]) {
					return;
				}
				state.files[fileIdx].externalIdFieldName = fieldName || null;
				linkedCsvRender();
			}

			function _buildFileDisplayNames(files) {
				const counts = new Map();
				const labels = [];
				for (const f of files) {
					const n = (f && f.name) || '(unnamed)';
					const c = (counts.get(n) || 0) + 1;
					counts.set(n, c);
					labels.push(c === 1 ? n : n + ' (' + c + ')');
				}
				return labels;
			}

			function linkedCsvRender() {
				const body = linkedCsvModal.querySelector('#linked-csv-content');
				const state = linkedCsvState;
				if (!body || !state) {
					return;
				}
				const allObjOptions = (canvasState.allObjects || [])
					.slice()
					.sort((a, b) => String(a.label || a.name).localeCompare(String(b.label || b.name)));
				const displayNames = _buildFileDisplayNames(state.files);
				const filesHtml =
					state.files.length === 0
						? '<p class="tag center">Drop CSVs above or click to choose.</p>'
						: state.files
								.map((file, i) => {
									const opts =
										'<option value=""> - Pick object - </option>' +
										allObjOptions
											.map(
												(o) =>
													'<option value="' +
													escapeHtml(o.name) +
													'"' +
													(o.name === file.objectName ? ' selected' : '') +
													'>' +
													escapeHtml(o.label || o.name) +
													(o.label && o.label !== o.name
														? ' (' + escapeHtml(o.name) + ')'
														: '') +
													'</option>',
											)
											.join('');
									const dataColumns = csvDataColumns(file);
									const unmappedCount = dataColumns.filter(
										({ index }) => !file.mapping?.[index],
									).length;
									let permWarn = '';
									if (file.objectName && file.describe) {
										const hasIdCol = Object.values(file.mapping || {}).some((f) => f === 'Id');
										if (hasIdCol && file.describe.updateable === false) {
											permWarn =
												'<div class="lcsv-perm-warn">⚠ Your Salesforce user can read ' +
												escapeHtml(file.objectName) +
												' but can’t update its records - this upload will fail. Ask your admin for Edit access.</div>';
										} else if (!hasIdCol && file.describe.createable === false) {
											permWarn =
												'<div class="lcsv-perm-warn">⚠ Your Salesforce user can read ' +
												escapeHtml(file.objectName) +
												' but can’t create new records - this upload will fail. Ask your admin for Create access on ' +
												escapeHtml(file.objectName) +
												'.</div>';
										}
									}
									const mappingErrors = [];
									(file.lookupErrors || []).forEach((issue) => {
										mappingErrors.push(
											'<strong>' +
												escapeHtml(issue.header) +
												'</strong> → <code>' +
												escapeHtml(issue.fieldName) +
												'</code>: ' +
												issue.count +
												' value' +
												(issue.count === 1 ? '' : 's') +
												(issue.count === 1 ? ' is' : ' are') +
												' not Salesforce IDs.',
										);
									});
									duplicateDirectFieldMappings(file).forEach((issue) => {
										const field = (file.describe.fields || []).find(
											(candidate) => candidate.name === issue.fieldName,
										);
										mappingErrors.push(
											'<strong>' +
												issue.headers.map(escapeHtml).join(' and ') +
												'</strong> are both mapped to <code>' +
												escapeHtml((field && (field.label || field.name)) || issue.fieldName) +
												' (' +
												escapeHtml(issue.fieldName) +
												')</code>. Choose one source column.',
										);
									});
									const mappingErrorsHtml = mappingErrors
										.map(
											(message) =>
												'<div class="lcsv-perm-warn lcsv-map-error">' + message + '</div>',
										)
										.join('');
									let columnsHtml = '';
									if (file.objectName && file.describe && Array.isArray(file.describe.fields)) {
										const fieldOpts = file.describe.fields.slice().sort((a, b) => {
											if (a.name === 'Id') {
												return -1;
											}
											if (b.name === 'Id') {
												return 1;
											}
											return String(a.label || a.name).localeCompare(String(b.label || b.name));
										});
										const rows = dataColumns
											.map(({ name: h, index: ci }) => {
												const current = file.mapping[ci] || '';
												const opts =
													'<option value="">Skip column</option>' +
													fieldOpts
														.map((f) => {
															const mappedFromColumnIdx = Object.keys(
																file.mapping || {},
															).find(
																(columnIdx) =>
																	Number(columnIdx) !== ci &&
																	file.mapping[columnIdx] === f.name,
															);
															const mappedElsewhere = mappedFromColumnIdx != null;
															const mappedElsewhereSuffix = mappedElsewhere
																? ' - already mapped from ' +
																	(file.headers[Number(mappedFromColumnIdx)] ||
																		'another CSV column')
																: '';
															return (
																'<option value="' +
																escapeHtml(f.name) +
																'"' +
																(f.name === current ? ' selected' : '') +
																(mappedElsewhere ? ' disabled' : '') +
																'>' +
																escapeHtml(csvFieldOptionLabel(f)) +
																' (' +
																escapeHtml(f.name) +
																')' +
																escapeHtml(mappedElsewhereSuffix) +
																csvFieldAccessSuffix(f) +
																'</option>'
															);
														})
														.join('');
												const status = current
													? '<span class="lcsv-col-status mapped" title="Mapped">\u2713</span>'
													: '<span class="lcsv-col-status unmapped" title="Skipped; not imported">\u25CB</span>';
												return (
													'<div class="lcsv-col-row">' +
													status +
													'<code class="lcsv-col-name">' +
													escapeHtml(h) +
													'</code>' +
													'<select class="lcsv-col-map" data-lcsv-col="' +
													i +
													':' +
													ci +
													'">' +
													opts +
													'</select>' +
													'</div>'
												);
											})
											.join('');
										columnsHtml =
											'<details class="lcsv-cols" data-lcsv-cols="' +
											i +
											'"' +
											(file.columnsOpen ? ' open' : '') +
											'>' +
											'<summary>Columns ' +
											'<span class="lcsv-cols-summary">' +
											(unmappedCount > 0
												? unmappedCount +
													' column' +
													(unmappedCount === 1 ? '' : 's') +
													' unmapped'
												: 'All mapped') +
											'</span>' +
											'</summary>' +
											'<div class="lcsv-col-list">' +
											rows +
											'</div>' +
											'</details>';
									}
									const fileLabel = displayNames[i] || file.name;
									const dupSuffixTitle =
										fileLabel !== file.name
											? ' title="Original filename: ' +
												escapeHtml(file.name) +
												' (suffix added because another file with this name is also loaded)"'
											: '';
									const eligibleExtIdFields =
										file.describe && Array.isArray(file.describe.fields)
											? file.describe.fields.filter(
													(f) => f && f.externalId && f.filterable === true && f.createable,
												)
											: [];
									const mappedFieldNames = new Set(Object.values(file.mapping || {}).filter(Boolean));
									const mappedExtIdFields = eligibleExtIdFields.filter((f) =>
										mappedFieldNames.has(f.name),
									);
									const opPicker =
										file.objectName && mappedExtIdFields.length > 0
											? (() => {
													const currentOp = file.operation || 'insert';
													const currentExt = file.externalIdFieldName || '';
													const extOpts = mappedExtIdFields
														.map(
															(f) =>
																'<option value="' +
																escapeHtml(f.name) +
																'"' +
																(f.name === currentExt ? ' selected' : '') +
																'>' +
																escapeHtml(f.label || f.name) +
																' (' +
																escapeHtml(f.name) +
																')' +
																'</option>',
														)
														.join('');
													return (
														'<div class="lcsv-op-row">' +
														'<label class="lcsv-op-label">Operation:</label>' +
														'<select class="lcsv-op" data-lcsv-op="' +
														i +
														'">' +
														'<option value="insert"' +
														(currentOp === 'insert' ? ' selected' : '') +
														'>Insert new records</option>' +
														'<option value="upsert"' +
														(currentOp === 'upsert' ? ' selected' : '') +
														'>Upsert by external id</option>' +
														'</select>' +
														(currentOp === 'upsert'
															? '<label class="lcsv-op-label">Key:</label>' +
																'<select class="lcsv-op-key" data-lcsv-op-key="' +
																i +
																'">' +
																extOpts +
																'</select>'
															: '') +
														'</div>'
													);
												})()
											: '';
									return (
										'<div class="lcsv-file">' +
										'<div class="lcsv-file-head">' +
										'<span class="lcsv-name"' +
										dupSuffixTitle +
										'>' +
										escapeHtml(fileLabel) +
										'</span>' +
										'<span class="lcsv-meta">' +
										file.rows.length +
										' row' +
										(file.rows.length === 1 ? '' : 's') +
										'</span>' +
										'<button type="button" class="lcsv-remove" data-lcsv-remove="' +
										i +
										'" title="Remove this file">\u00D7</button>' +
										'</div>' +
										'<div class="lcsv-file-body">' +
										'<label class="lcsv-object-label" for="lcsv-object-' +
										i +
										'">Object</label>' +
										'<select id="lcsv-object-' +
										i +
										'" class="lcsv-obj" data-lcsv-obj="' +
										i +
										'">' +
										opts +
										'</select>' +
										'</div>' +
										permWarn +
										mappingErrorsHtml +
										(unmappedCount > 0
											? '<p class="tag">Unmapped columns won&rsquo;t be imported.</p>'
											: '') +
										opPicker +
										columnsHtml +
										'</div>'
									);
								})
								.join('');
				const _validForSummary = state.files.filter(
					(f) => f.objectName && Object.values(f.mapping).filter(Boolean).length > 0,
				);
				const _totalRowsForSummary = _validForSummary.reduce((n, f) => n + f.rows.length, 0);
				const _filesSummary =
					_validForSummary.length > 0
						? _totalRowsForSummary +
							' record' +
							(_totalRowsForSummary === 1 ? '' : 's') +
							' from ' +
							_validForSummary.length +
							' file' +
							(_validForSummary.length === 1 ? '' : 's') +
							' ready'
						: 'map at least one file';
				const dropzoneHtml = state.processingFiles
					? '<div class="lcsv-dropzone is-loading" tabindex="-1" aria-busy="true" aria-live="polite">' +
						'<span class="busy-spinner" aria-hidden="true"></span>' +
						'<strong>Reading CSV files…</strong>' +
						'<span class="tag">Checking rows and preparing field mappings.</span>' +
						'</div>'
					: canvasState.allObjects === null
						? '<div class="lcsv-dropzone is-loading" tabindex="-1" aria-busy="true">' +
							'<strong>Loading object catalog…</strong>' +
							'<span class="tag">First load can take 30+ seconds in a fresh org.</span>' +
							'</div>'
						: '<div class="lcsv-dropzone' +
							(state.files.length ? ' is-compact' : '') +
							'" id="lcsv-dropzone" role="button" tabindex="0">' +
							(state.files.length
								? '<span>+ Add CSV files</span>'
								: '<strong>Drop CSV files here</strong><span class="tag">or click to select</span>') +
							'<input type="file" id="lcsv-file-input" accept=".csv,text/csv,text/plain" multiple style="display:none">' +
							'</div>';
				const _noticesHtml =
					state.notices && state.notices.length
						? '<div class="lcsv-notices">' +
							state.notices
								.map(
									(n) =>
										'<div class="banner ' +
										(n.kind === 'error' ? 'error' : 'warn') +
										'" style="margin:0 0 0.5em">' +
										escapeHtml(n.text) +
										'</div>',
								)
								.join('') +
							'</div>'
						: '';
				body.innerHTML =
					_noticesHtml +
					'<div class="lcsv-step">' +
					dropzoneHtml +
					'</div>' +
					(state.files.length > 0
						? '<div class="lcsv-step">' +
							'<div class="lcsv-files-header"><strong>Files</strong><span class="tag lcsv-files-summary">' +
							_filesSummary +
							'</span></div>' +
							'<div class="lcsv-files">' +
							filesHtml +
							'</div>' +
							'</div>'
						: '');
				const dz = body.querySelector('#lcsv-dropzone');
				const fileInput = body.querySelector('#lcsv-file-input');
				if (dz && fileInput) {
					dz.addEventListener('click', (e) => {
						if (e.target !== fileInput) fileInput.click();
					});
					dz.addEventListener('keydown', (e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							fileInput.click();
						}
					});
					dz.addEventListener('dragover', (e) => {
						e.preventDefault();
						dz.classList.add('drag');
					});
					dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
					dz.addEventListener('drop', (e) => {
						e.preventDefault();
						dz.classList.remove('drag');
						linkedCsvHandleFiles(e.dataTransfer && e.dataTransfer.files);
					});
					fileInput.addEventListener('change', (e) => linkedCsvHandleFiles(e.target.files));
				}
				body.querySelectorAll('[data-lcsv-obj]').forEach((sel) => {
					sel.addEventListener('change', (e) =>
						linkedCsvSetObject(Number(e.target.dataset.lcsvObj), e.target.value),
					);
				});
				body.querySelectorAll('[data-lcsv-remove]').forEach((btn) => {
					btn.addEventListener('click', () => linkedCsvRemoveFile(Number(btn.dataset.lcsvRemove)));
				});
				body.querySelectorAll('[data-lcsv-cols]').forEach((details) => {
					details.addEventListener('toggle', () => {
						const fileIdx = Number(details.dataset.lcsvCols);
						if (state.files[fileIdx]) {
							state.files[fileIdx].columnsOpen = details.open;
						}
					});
				});
				body.querySelectorAll('[data-lcsv-col]').forEach((sel) => {
					sel.addEventListener('change', (e) => {
						const [fileIdx, colIdx] = e.target.dataset.lcsvCol.split(':').map(Number);
						const details = e.target.closest('[data-lcsv-cols]');
						if (details && state.files[fileIdx]) {
							state.files[fileIdx].columnsOpen = details.open;
						}
						linkedCsvUpdateColumn(fileIdx, colIdx, e.target.value);
					});
				});
				body.querySelectorAll('[data-lcsv-op]').forEach((sel) => {
					sel.addEventListener('change', (e) => {
						linkedCsvUpdateOperation(Number(e.target.dataset.lcsvOp), e.target.value);
					});
				});
				body.querySelectorAll('[data-lcsv-op-key]').forEach((sel) => {
					sel.addEventListener('change', (e) => {
						linkedCsvUpdateExternalIdField(Number(e.target.dataset.lcsvOpKey), e.target.value);
					});
				});
				const replaceBtn = linkedCsvModal.querySelector('#linked-csv-replace');
				const confirmBtn = linkedCsvModal.querySelector('#linked-csv-confirm');
				const ready = linkedCsvReady(state);
				if (confirmBtn) {
					confirmBtn.disabled = !ready;
				}
				if (replaceBtn) {
					replaceBtn.disabled = !ready;
				}
			}

			function _planMappedFieldWrites(files, state, idResolution, cellKey) {
				// Keep readable-but-unwritable values as context, but never send them to Salesforce.
				const groups = new Map();
				const omittedByRow = new Map();
				const affectedRows = new Set();
				for (const file of files) {
					if (!file.describe || !Array.isArray(file.describe.fields)) {
						continue;
					}
					const fromFileIdx = state.files.indexOf(file);
					const mapping = file.mapping || {};
					const idColIdxStr = Object.keys(mapping).find((iStr) => mapping[Number(iStr)] === 'Id');
					const idColIdx = idColIdxStr != null ? Number(idColIdxStr) : null;
					const fieldByName = new Map();
					file.describe.fields.forEach((field) => {
						if (field && field.name) {
							fieldByName.set(field.name, field);
						}
					});
					file.rows.forEach((row, rowIdx) => {
						const rawId = idColIdx != null ? row[idColIdx] : null;
						const sfId = rawId != null && String(rawId).trim() !== '' ? String(rawId).trim() : null;
						const operation = csvRowOperation(file, sfId, idResolution);
						const rowKey = cellKey(fromFileIdx, rowIdx);
						Object.keys(mapping).forEach((colIdxStr) => {
							const colIdx = Number(colIdxStr);
							const fieldName = mapping[colIdx];
							if (!fieldName || fieldName === 'Id') {
								return;
							}
							const field = fieldByName.get(fieldName);
							const disposition = csvFieldDisposition(field, operation);
							if (disposition === 'write') {
								return;
							}
							if (!omittedByRow.has(rowKey)) {
								omittedByRow.set(rowKey, new Set());
							}
							omittedByRow.get(rowKey).add(fieldName);
							const value = row[colIdx];
							if (disposition !== 'warn' || value == null || String(value).trim() === '') {
								return;
							}
							const groupKey = fromFileIdx + '::' + file.objectName;
							if (!groups.has(groupKey)) {
								groups.set(groupKey, {
									fileName: file.name,
									objectName: file.objectName,
									fields: new Map(),
								});
							}
							const reason = operation === 'upsert' ? 'No create or edit access' : 'No create access';
							const issueKey = fieldName + '::' + colIdx + '::' + reason;
							const fieldIssues = groups.get(groupKey).fields;
							if (!fieldIssues.has(issueKey)) {
								fieldIssues.set(issueKey, {
									csvHeader: (file.headers && file.headers[colIdx]) || '(blank)',
									fieldName,
									fieldLabel: field && field.label ? field.label : fieldName,
									reason,
									rows: new Set(),
								});
							}
							fieldIssues.get(issueKey).rows.add(rowKey);
							affectedRows.add(rowKey);
						});
					});
				}
				const issues = Array.from(groups.values()).map((group) => ({
					fileName: group.fileName,
					objectName: group.objectName,
					fields: Array.from(group.fields.values()).map((field) => ({
						csvHeader: field.csvHeader,
						fieldName: field.fieldName,
						fieldLabel: field.fieldLabel,
						reason: field.reason,
						affectedRows: field.rows.size,
					})),
				}));
				return { issues, omittedByRow, affectedRowCount: affectedRows.size };
			}

			async function csvResolveExistingIds(validFiles, state, cellKey) {
				const liveById = new Map();
				const idRows = [];
				validFiles.forEach((file) => {
					const fromFileIdx = state.files.indexOf(file);
					const mapping = file.mapping || {};
					const idColIdxStr = Object.keys(mapping).find((iStr) => mapping[Number(iStr)] === 'Id');
					if (idColIdxStr == null) {
						return;
					}
					const idColIdx = Number(idColIdxStr);
					const nameColIdxStr = Object.keys(mapping).find((iStr) => mapping[Number(iStr)] === 'Name');
					const nameColIdx = nameColIdxStr != null ? Number(nameColIdxStr) : null;
					file.rows.forEach((row, rowIdx) => {
						const raw = row[idColIdx];
						const sfId = raw != null && String(raw).trim() !== '' ? String(raw).trim() : null;
						if (!sfId) {
							return;
						}
						const nm = nameColIdx != null ? String(row[nameColIdx] || '').trim() : '';
						idRows.push({
							key: cellKey(fromFileIdx, rowIdx),
							sfId,
							objectName: file.objectName,
							label: (nm ? nm + ' · ' : '') + file.objectName + ' · ' + sfId,
						});
					});
				});
				if (idRows.length === 0) {
					return { liveById, draftKeys: new Set(), canceled: false };
				}
				const byObj = new Map();
				idRows.forEach((r) => {
					if (!byObj.has(r.objectName)) {
						byObj.set(r.objectName, new Set());
					}
					byObj.get(r.objectName).add(r.sfId);
				});
				for (const [obj, idset] of byObj) {
					const ids = Array.from(idset);
					for (let i = 0; i < ids.length; i += 200) {
						const chunk = ids.slice(i, i + 200);
						const inList = chunk.map((x) => "'" + String(x).replace(/'/g, '') + "'").join(',');
						try {
							const resp = await csrfFetch('/api/query', {
								method: 'POST',
								headers: { 'content-type': 'application/json' },
								credentials: 'same-origin',
								body: JSON.stringify({
									soql: 'SELECT Id FROM ' + obj + ' WHERE Id IN (' + inList + ')',
									fullFields: true,
								}),
							});
							if (resp.ok) {
								const data = await resp.json();
								(data.records || []).forEach((rec) => {
									if (rec && rec.loadedFromId) {
										liveById.set(String(rec.loadedFromId).slice(0, 15), rec.values || {});
									}
								});
							}
						} catch (e) {
							/* network/query error → rows treated as not-found */
						}
					}
				}
				const missing = idRows.filter((r) => !liveById.has(r.sfId.slice(0, 15)));
				if (missing.length === 0) {
					return { liveById, draftKeys: new Set(), canceled: false };
				}
				const choice = await showMissingIdChecklist(missing);
				if (choice === null) {
					return { liveById, draftKeys: new Set(), canceled: true };
				}
				return { liveById, draftKeys: choice, canceled: false };
			}

			function showMissingIdChecklist(items) {
				return new Promise((resolve) => {
					document.querySelectorAll('.missing-id-modal').forEach((el) => el.remove());
					const modal = document.createElement('div');
					modal.className = 'modal missing-id-modal';
					const rows = items
						.map(
							(it, i) =>
								'<label class="missing-id-row" style="display:flex;align-items:center;gap:8px;padding:4px 0;">' +
								'<input type="checkbox" data-mid="' +
								i +
								'" checked>' +
								'<span>' +
								escapeHtml(it.label) +
								'</span>' +
								'</label>',
						)
						.join('');
					modal.innerHTML =
						'<div class="modal-overlay" data-mid-close></div>' +
						'<div class="modal-body" style="max-width:520px">' +
						'<div class="modal-header"><h3>Some Id rows weren’t found</h3>' +
						'<button class="modal-close" data-mid-close>&times;</button></div>' +
						'<div class="modal-content">' +
						'<p style="white-space:pre-line">' +
						items.length +
						' row' +
						(items.length === 1 ? '' : 's') +
						(items.length === 1 ? ' references' : ' reference') +
						' a Salesforce Id that doesn’t exist in this org (deleted, wrong org, or a typo). ' +
						'Pick which to add as new draft records - unchecked rows are skipped. ' +
						'Rows whose Id WAS found import as existing records regardless.</p>' +
						'<div style="display:flex;gap:12px;margin:6px 0;">' +
						'<button type="button" class="button secondary" data-mid-all>Select all</button>' +
						'<button type="button" class="button secondary" data-mid-none>Select none</button>' +
						'</div>' +
						'<div class="missing-id-list" style="max-height:280px;overflow:auto;border:1px solid var(--border);border-radius:4px;padding:8px;">' +
						rows +
						'</div>' +
						'</div>' +
						'<div class="modal-footer">' +
						'<button class="button secondary" data-mid-cancel>Cancel import</button>' +
						'<button class="button" data-mid-confirm>Import</button>' +
						'</div>' +
						'</div>';
					document.body.appendChild(modal);
					let settled = false;
					const finish = (val) => {
						if (settled) {
							return;
						}
						settled = true;
						document.removeEventListener('keydown', onKey);
						modal.remove();
						resolve(val);
					};
					const onKey = (e) => {
						if (e.key === 'Escape') {
							finish(null);
						}
					};
					document.addEventListener('keydown', onKey);
					modal
						.querySelectorAll('[data-mid-close], [data-mid-cancel]')
						.forEach((el) => el.addEventListener('click', () => finish(null)));
					modal.querySelector('[data-mid-all]').addEventListener('click', () =>
						modal.querySelectorAll('input[data-mid]').forEach((cb) => {
							cb.checked = true;
						}),
					);
					modal.querySelector('[data-mid-none]').addEventListener('click', () =>
						modal.querySelectorAll('input[data-mid]').forEach((cb) => {
							cb.checked = false;
						}),
					);
					modal.querySelector('[data-mid-confirm]').addEventListener('click', () => {
						const chosen = new Set();
						modal.querySelectorAll('input[data-mid]').forEach((cb) => {
							if (cb.checked) {
								chosen.add(items[Number(cb.dataset.mid)].key);
							}
						});
						finish(chosen);
					});
					setTimeout(() => {
						const b = modal.querySelector('[data-mid-confirm]');
						if (b) {
							b.focus();
						}
					}, 0);
				});
			}

			function showFieldWriteReview(plan) {
				return new Promise((resolve) => {
					document.querySelectorAll('.lcsv-field-review-modal').forEach((el) => el.remove());
					const fieldCount = plan.issues.reduce((count, issue) => count + issue.fields.length, 0);
					const groups = plan.issues
						.map((issue) => {
							const fields = issue.fields
								.map(
									(field) =>
										'<div class="lcsv-field-review-row">' +
										'<div class="lcsv-field-review-name">' +
										'<strong>' +
										escapeHtml(field.fieldLabel) +
										'</strong>' +
										'<code>' +
										escapeHtml(field.fieldName) +
										'</code>' +
										'<span>CSV column: ' +
										escapeHtml(field.csvHeader) +
										'</span>' +
										'</div>' +
										'<div class="lcsv-field-review-status">' +
										'<span class="tag warn">' +
										escapeHtml(field.reason) +
										'</span>' +
										'<span>' +
										field.affectedRows +
										' row' +
										(field.affectedRows === 1 ? '' : 's') +
										'</span>' +
										'</div>' +
										'</div>',
								)
								.join('');
							return (
								'<section class="lcsv-field-review-group">' +
								'<div class="lcsv-field-review-group-head">' +
								'<strong>' +
								escapeHtml(issue.fileName || 'CSV file') +
								'</strong>' +
								'<span>' +
								escapeHtml(issue.objectName) +
								'</span>' +
								'</div>' +
								fields +
								'</section>'
							);
						})
						.join('');
					const modal = document.createElement('div');
					modal.className = 'modal lcsv-field-review-modal';
					modal.innerHTML =
						'<div class="modal-overlay" data-lcsv-field-review-cancel></div>' +
						'<div class="modal-body" role="dialog" aria-modal="true" aria-labelledby="lcsv-field-review-title">' +
						'<div class="modal-header">' +
						'<h3 id="lcsv-field-review-title">Review fields that will be left out</h3>' +
						'<button class="modal-close" aria-label="Close" data-lcsv-field-review-cancel>&times;</button>' +
						'</div>' +
						'<div class="modal-content">' +
						'<p>Salesforce will not accept some CSV values for these rows. You can continue with the remaining values or go back and change the mapping.</p>' +
						'<div class="lcsv-field-review-summary">' +
						'<strong>' +
						fieldCount +
						' field' +
						(fieldCount === 1 ? '' : 's') +
						'</strong>' +
						'<span>across ' +
						plan.affectedRowCount +
						' row' +
						(plan.affectedRowCount === 1 ? '' : 's') +
						'</span>' +
						'</div>' +
						'<div class="lcsv-field-review-list">' +
						groups +
						'</div>' +
						'<p class="lcsv-field-review-note"><strong>Existing Salesforce values are not cleared.</strong> Continuing leaves only the listed CSV values out.</p>' +
						'</div>' +
						'<div class="modal-footer">' +
						'<button class="button secondary" data-lcsv-field-review-cancel>Back to mapping</button>' +
						'<button class="button" data-lcsv-field-review-confirm>Continue without these values</button>' +
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
					const onKey = (event) => {
						if (event.key === 'Escape') {
							finish(false);
						}
					};
					document.addEventListener('keydown', onKey);
					modal
						.querySelectorAll('[data-lcsv-field-review-cancel]')
						.forEach((el) => el.addEventListener('click', () => finish(false)));
					modal
						.querySelector('[data-lcsv-field-review-confirm]')
						.addEventListener('click', () => finish(true));
					setTimeout(() => modal.querySelector('button[data-lcsv-field-review-cancel]').focus(), 0);
				});
			}

			async function linkedCsvConfirm(opts) {
				if (!opts?.replaceCanvas) return applyLinkedCsv(opts);
				const finish = deps.beginCanvasLoad?.();
				let success = false;
				try {
					if (finish?.ready) await finish.ready;
					const result = await applyLinkedCsv(opts);
					success = true;
					return result;
				} finally {
					finish?.(success);
				}
			}

			async function applyLinkedCsv(opts) {
				opts = opts || {};
				const state = linkedCsvState;
				if (!state) {
					return;
				}
				const validFiles = state.files.filter(
					(f) => f.objectName && Object.values(f.mapping).filter(Boolean).length > 0,
				);
				if (validFiles.length !== state.files.length) {
					showBulkToast(
						'Choose an available Salesforce object and map at least one field for every CSV file, or remove the files you do not want to import. No files have been imported.',
						'warning',
					);
					return;
				}
				if (validFiles.length === 0) {
					return;
				}
				if (validFiles.some((f) => Array.isArray(f.blockingErrors) && f.blockingErrors.length > 0)) {
					showBulkToast('Fix the blocked CSV structure errors before importing.', 'error');
					return;
				}
				if (!linkedCsvReady(state)) {
					showBulkToast('Fix the CSV mapping errors before importing.', 'error');
					linkedCsvRender();
					return;
				}
				const cellKey = (fi, ri) => fi + '|' + ri;
				const _idResolution = await csvResolveExistingIds(validFiles, state, cellKey);
				if (csvImportCanceled(state, linkedCsvState) || _idResolution.canceled) {
					return;
				}
				const fieldPlan = _planMappedFieldWrites(validFiles, state, _idResolution, cellKey);
				const continueWithWritableFields =
					fieldPlan.issues.length === 0 || (await showFieldWriteReview(fieldPlan));
				if (csvImportCanceled(state, linkedCsvState) || !continueWithWritableFields) {
					return;
				}
				const shouldReplace = !!opts.replaceCanvas;
				const canvas = getGraph().querySelector('#bulk-canvas');
				const W = canvas ? canvas.clientWidth : 1200;
				const startX = 80;
				const startY = 80;
				const stepX = 220;
				const stepY = 180;
				const perRow = Math.max(1, Math.floor((W - startX) / stepX));
				const existingCanvasById = new Map();
				const mergeQueue = [];
				let mergeSkippedNoModal = 0;
				let unchangedCount = 0;
				if (!shouldReplace) {
					canvasState.bulkRecords.forEach((rec) => {
						if (!rec || rec.isTypeNode) {
							return;
						}
						const key = rec.loadedFromId || (rec.values && rec.values.Id);
						if (key) {
							existingCanvasById.set(rec.objectName + '::' + String(key).slice(0, 15), rec);
						}
					});
				}
				let plannedNewCards = 0;
				validFiles.forEach((file) => {
					const fromFileIdx = state.files.indexOf(file);
					const mapping = file.mapping || {};
					const idColIdxStr = Object.keys(mapping).find((iStr) => mapping[Number(iStr)] === 'Id');
					const idColIdx = idColIdxStr != null ? Number(idColIdxStr) : null;
					file.rows.forEach((row, rowIdx) => {
						const raw = idColIdx != null ? row[idColIdx] : null;
						const sfId = raw != null && String(raw).trim() !== '' ? String(raw).trim() : null;
						if (sfId && existingCanvasById.has(file.objectName + '::' + sfId.slice(0, 15))) {
							return; // collision → merges onto the existing card
						}
						if (
							sfId &&
							!_idResolution.liveById.has(sfId.slice(0, 15)) &&
							!_idResolution.draftKeys.has(cellKey(fromFileIdx, rowIdx))
						) {
							return; // not found + not drafted → row skipped
						}
						plannedNewCards++;
					});
				});
				const _capProbe = canvasCapCheck ? canvasCapCheck(plannedNewCards) : null;
				const blocked = _capProbe
					? shouldReplace
						? plannedNewCards > _capProbe.cap
							? _capProbe.reason
							: null
						: _capProbe.reason
					: _canvasCapBlockReason(plannedNewCards);
				if (blocked) {
					showBulkToast(blocked, 'error');
					return;
				}
				const _undoImport = captureUndoSnapshot ? captureUndoSnapshot() : null;
				const selByName = new Map();
				for (const file of validFiles) {
					let sel = canvasState.selectedObjects.find((s) => s.name === file.objectName);
					if (!sel) {
						try {
							sel = await addToSelection(file.objectName);
						} catch (e) {
							console.warn('addToSelection failed for', file.objectName, e);
							continue;
						}
						if (csvImportCanceled(state, linkedCsvState)) {
							return;
						}
					}
					selByName.set(file.objectName, sel);
				}
				if (csvImportCanceled(state, linkedCsvState)) {
					return;
				}
				if (shouldReplace) {
					deps.onCanvasReplace?.();
					canvasState.bulkRecords = [];
					canvasState.bulkAssociations = [];
					canvasState.currentCanvas = null;
					if (window.Orgloom && window.Orgloom.canvasState && window.Orgloom.canvasState.clearDraft) {
						window.Orgloom.canvasState.clearDraft();
					}
				} else {
					clearEmptyStarterCard();
				}
				let slot = canvasState.bulkRecords.length;
				const newRecIds = new Set();
				validFiles.forEach((file, vfi) => {
					const fromFileIdx = state.files.indexOf(file);
					const sel = selByName.get(file.objectName);
					if (!sel) {
						return;
					}
					const mappedIdxs = Object.keys(file.mapping).filter((i) => file.mapping[i]);
					const idColIdxStr = mappedIdxs.find((iStr) => file.mapping[Number(iStr)] === 'Id');
					const idColIdx = idColIdxStr != null ? Number(idColIdxStr) : null;
					file.rows.forEach((row, rowIdx) => {
						const values = {};
						const clearFields = exportedClearFields(file, row);
						const omittedFields = fieldPlan.omittedByRow.get(cellKey(fromFileIdx, rowIdx));
						mappedIdxs.forEach((iStr) => {
							const i = Number(iStr);
							const field = file.mapping[i];
							if (file.headers[i] === '__OrgLoom_ClearFields') return;
							if (omittedFields && omittedFields.has(field)) {
								return;
							}
							if (i === idColIdx) {
								return;
							}
							const v = row[i];
							if (clearFields.has(file.headers[i]) && (v == null || v === '')) {
								values[field] = null;
							} else if (v !== undefined && v !== '') {
								values[field] = v;
							}
						});
						const rawId = idColIdx != null ? row[idColIdx] : null;
						const sfId = rawId != null && String(rawId).trim() !== '' ? String(rawId).trim() : null;
						if (sfId) {
							const _hit = existingCanvasById.get(sel.name + '::' + sfId.slice(0, 15));
							if (_hit) {
								const _vc = window.OrgLoom && window.OrgLoom.valueCompare;
								const _d =
									_vc && typeof _vc.computeRecordDiff === 'function'
										? _vc.computeRecordDiff(_hit, { objectName: _hit.objectName, values: values })
										: null;
								const _changes = _d ? _d.differing.length + _d.bOnly.length : 1;
								if (_changes > 0) {
									if (openRecordDiffModal) {
										mergeQueue.push({ existing: _hit, values: values, label: sel.label });
									} else {
										mergeSkippedNoModal++;
									}
								} else {
									unchangedCount++;
								}
								return;
							}
						}
						const id = canvasState.bulkIdSeq++;
						const col = slot % perRow;
						const r = Math.floor(slot / perRow);
						slot++;
						const rec = {
							id,
							objectName: sel.name,
							label: sel.label,
							x: startX + col * stepX,
							y: startY + r * stepY,
							values,
							fromSelectionId: sel.id,
						};
						if (sfId) {
							const _live = _idResolution.liveById.get(sfId.slice(0, 15));
							if (_live) {
								rec.loadedFromId = sfId;
								rec.loadedValues = Object.assign({}, _live);
								rec.values = Object.assign({}, _live, rec.values);
							} else if (!_idResolution.draftKeys.has(cellKey(fromFileIdx, rowIdx))) {
								slot--;
								return;
							}
						}
						if (file.operation === 'upsert' && file.externalIdFieldName) {
							rec._csvOperation = 'upsert';
							rec._csvExternalIdField = file.externalIdFieldName;
						}
						canvasState.bulkRecords.push(rec);
						newRecIds.add(id);
					});
				});
				const totalRecords = validFiles.reduce((n, f) => n + f.rows.length, 0);
				const fileCount = validFiles.length;
				closeLinkedCsvModal(true);
				if (totalRecords > 0) {
					setSkipNextCyAutoPan(true);
				}
				renderBulkView();
				if (totalRecords > 0) {
					relayoutNewRecords(newRecIds);
				}
				const _mergeTotal = mergeQueue.length + mergeSkippedNoModal;
				const _mergeNote =
					_mergeTotal > 0
						? ' · ' +
							_mergeTotal +
							' matched a card already on the canvas' +
							(mergeQueue.length > 0 ? ' - review the merge' : ' - skipped')
						: '';
				const _unchangedNote =
					unchangedCount > 0 ? ' · ' + unchangedCount + ' already on the canvas, unchanged' : '';
				const _toastMsg =
					'Imported ' +
					totalRecords +
					' record' +
					(totalRecords === 1 ? '' : 's') +
					' from ' +
					fileCount +
					' file' +
					(fileCount === 1 ? '' : 's') +
					_mergeNote +
					_unchangedNote +
					'.' +
					(validFiles.some((file) =>
						file.headers.some((name, index) => name !== '__OrgLoom_ClearFields' && !file.mapping[index]),
					)
						? ' Unmapped columns were skipped.'
						: '');
				if (_undoImport && showBulkToastWithAction) {
					if (typeof _undoImport.arm === 'function') {
						_undoImport.arm();
					}
					showBulkToastWithAction(_toastMsg, 'Undo', _undoImport);
				} else {
					showBulkToast(_toastMsg);
				}
				pingAuditEvent('csv_import', {
					recordCount: totalRecords,
					payload: {
						mode: 'records',
						fileCount,
						merged: mergeQueue.length,
						unchanged: unchangedCount,
					},
				});
				if (mergeQueue.length && openRecordDiffModal) {
					let qi = 0;
					const nextMerge = () => {
						if (qi >= mergeQueue.length) {
							return;
						}
						const item = mergeQueue[qi++];
						const importedRec = {
							id: -1 - qi, // synthetic, off-canvas id
							objectName: item.existing.objectName,
							label: item.label || item.existing.label,
							values: item.values,
						};
						openRecordDiffModal(item.existing, importedRec, {
							incoming: true,
							labelB: 'Imported row ' + qi + ' of ' + mergeQueue.length,
							onClose: nextMerge,
						});
					};
					nextMerge();
				}
			}

			return {
				openModal: openLinkedCsvModal,
				closeModal: closeLinkedCsvModal,
			};
		},
	};
})();

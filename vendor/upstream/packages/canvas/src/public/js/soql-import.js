(function () {
	'use strict';
	// Imports query results through the server's read-only SOQL validation boundary.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.soqlImport = {
		mount: function mount(deps) {
			if (
				!deps ||
				!deps.canvasState ||
				!deps.showBulkToast ||
				!deps.escapeHtml ||
				!deps.csrfFetch ||
				!deps.addToSelection ||
				!deps.renderBulkView ||
				!deps.getGraph ||
				!deps.clearBulkUserDeleted ||
				!deps.relayoutNewRecords ||
				!deps.setSkipNextCyAutoPan ||
				!deps.clearEmptyStarterCard
			) {
				throw new Error('soql-import.mount: missing required deps');
			}
			const canvasState = deps.canvasState;
			const showBulkToast = deps.showBulkToast;
			const escapeHtml = deps.escapeHtml;
			const csrfFetch = deps.csrfFetch;
			const canvasCapCheck =
				typeof deps.canvasCapCheck === 'function'
					? deps.canvasCapCheck
					: function () {
							return { ok: true, blocked: false, reason: null };
						};
			const addToSelection = deps.addToSelection;
			const renderBulkView = deps.renderBulkView;
			const getGraph = deps.getGraph;
			const clearBulkUserDeleted = deps.clearBulkUserDeleted;
			const relayoutNewRecords = deps.relayoutNewRecords;
			const setSkipNextCyAutoPan = deps.setSkipNextCyAutoPan;
			const clearEmptyStarterCard = deps.clearEmptyStarterCard;
			const captureUndoSnapshot =
				typeof deps.captureUndoSnapshot === 'function' ? deps.captureUndoSnapshot : null;
			const showBulkToastWithAction =
				typeof deps.showBulkToastWithAction === 'function' ? deps.showBulkToastWithAction : null;
			const _shared = window.OrgLoom.importShared;
			const reconcileLoadedRecordAssociations =
				_shared && typeof _shared.reconcileLoadedRecordAssociations === 'function'
					? _shared.reconcileLoadedRecordAssociations
					: null;

			function formatQueryError(body, status) {
				const code = body && body.error ? String(body.error) : '';
				const msg = body && body.message ? String(body.message) : '';
				if (msg && code && code !== 'query-failed' && code !== 'member-grant-required') {
					return '<strong>' + escapeHtml(code) + '</strong> &middot; ' + escapeHtml(msg);
				}
				if (msg) {
					return escapeHtml(msg);
				}
				if (code) {
					return escapeHtml(code);
				}
				return 'HTTP ' + status;
			}

			const PLAYGROUND_PRESET_SOQL =
				'SELECT Id, Name, Industry, Phone, Type,\n' +
				'       (SELECT Id, FirstName, LastName, Email, Title FROM Contacts)\n' +
				'FROM Account\n' +
				"WHERE Industry = 'Technology'\n" +
				'LIMIT 5';
			function openSoqlImportModal(opts) {
				opts = opts || {};
				document.querySelectorAll('.soql-import-modal').forEach((el) => el.remove());
				const isPlayground = !!window.ORGLOOM_MOCK;
				const presetSoql =
					typeof opts.presetSoql === 'string' && opts.presetSoql.trim() ? opts.presetSoql.trim() : null;
				const modal = document.createElement('div');
				modal.className = 'modal soql-import-modal';
				const headerCopy =
					isPlayground && !presetSoql
						? '<p class="tag">Demo query. Connect Salesforce to run your own.</p>'
						: '';
				const textareaAttrs =
					isPlayground && !presetSoql
						? ' readonly aria-readonly="true" style="width:100%;font-family:monospace;font-size:13px;background:var(--bg-elev);color:var(--ink-soft);cursor:not-allowed;"'
						: ' autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="SELECT Id, Name FROM Account WHERE CreatedDate = LAST_N_DAYS:30 LIMIT 50" style="width:100%;font-family:monospace;font-size:13px;"';
				const textareaValue = presetSoql || (isPlayground ? PLAYGROUND_PRESET_SOQL : '');
				modal.innerHTML =
					'<div class="modal-overlay" data-soql-close></div>' +
					'<div class="modal-body" style="max-width:720px">' +
					'<div class="modal-header">' +
					'<h3>Import via SOQL query</h3>' +
					'<button class="modal-close" data-soql-close>&times;</button>' +
					'</div>' +
					'<div class="modal-content">' +
					headerCopy +
					'<textarea id="soql-query" aria-label="SOQL query" rows="8"' +
					textareaAttrs +
					'>' +
					escapeHtml(textareaValue) +
					'</textarea>' +
					'<details class="soql-query-help"><summary>Query help</summary>' +
					'<p>Use a read-only SELECT query and include <code>Id</code>. You can import up to 500 records, including related records from child subqueries. All accessible fields are loaded, including fields not listed in your query.</p>' +
					'<pre><code>SELECT Id, Name,\n  (SELECT Id, FirstName FROM Contacts)\nFROM Account\nLIMIT 5</code></pre>' +
					'</details>' +
					'<div id="soql-preview" class="soql-preview"></div>' +
					'</div>' +
					'<div class="modal-footer">' +
					'<button class="button secondary" data-soql-close>Cancel</button>' +
					'<button class="button secondary" id="soql-preview-btn">Preview</button>' +
					'<button class="button" id="soql-commit-btn">Add to canvas</button>' +
					'</div>' +
					'</div>';
				document.body.appendChild(modal);
				const close = () => {
					modal.remove();
					document.removeEventListener('keydown', onEsc);
				};
				const onEsc = (e) => {
					if (e.key === 'Escape') {
						close();
					}
				};
				document.addEventListener('keydown', onEsc);
				modal.querySelectorAll('[data-soql-close]').forEach((el) => el.addEventListener('click', close));

				const textarea = modal.querySelector('#soql-query');
				const previewPane = modal.querySelector('#soql-preview');
				const previewBtn = modal.querySelector('#soql-preview-btn');
				const commitBtn = modal.querySelector('#soql-commit-btn');
				let lastResult = null;
				let showRecordIds = false;
				previewPane.addEventListener('click', (event) => {
					const toggle = event.target.closest('[data-soql-toggle-ids]');
					if (!toggle) {
						return;
					}
					showRecordIds = !showRecordIds;
					toggle.setAttribute('aria-pressed', String(showRecordIds));
					previewPane
						.querySelector('.soql-preview-tablewrap')
						.classList.toggle('soql-show-ids', showRecordIds);
				});
				setTimeout(() => textarea.focus(), 0);

				let lastResultSoql = null;

				async function runQuery(soql) {
					// The server parses and enforces the read-only SOQL subset before querying Salesforce.
					const fullFields = true;
					const r = await csrfFetch('/api/query', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						credentials: 'same-origin',
						body: JSON.stringify({ soql, fullFields }),
					});
					const body = await r.json().catch(() => ({}));
					return { ok: r.ok, status: r.status, body };
				}

				function renderPreview(body) {
					const byObject = {};
					for (const rec of body.records) {
						byObject[rec.objectName] = (byObject[rec.objectName] || 0) + 1;
					}
					const breakdown = Object.entries(byObject)
						.map(([n, c]) => escapeHtml(n) + ': ' + c)
						.join(' \u00b7 ');
					const truncationNote = body.capped
						? '<div class="banner">Hit the ' +
							(body.cap || 500) +
							'-record import cap; showing the first ' +
							body.returned +
							'. There may be more; add a WHERE clause or a smaller LIMIT to narrow.</div>'
						: body.truncated
							? '<div class="banner">Query matches ' +
								body.totalSize +
								' records; showing the first ' +
								body.returned +
								'. Add a WHERE clause or LIMIT to narrow.</div>'
							: '';
					const sfBase = (window.SF_INSTANCE_URL || '').replace(/[/]+$/, '');
					const ID_PRIORITY = [
						'Name',
						'CaseNumber',
						'Subject',
						'Title',
						'Label',
						'DeveloperName',
						'Username',
						'Email',
						'FullName',
						'LastName',
					];
					function pickIdentifier(values) {
						if (!values) {
							return null;
						}
						for (const k of ID_PRIORITY) {
							const v = values[k];
							if (v != null && typeof v !== 'object' && String(v).trim() !== '') {
								return { field: k, value: String(v) };
							}
						}
						for (const k of Object.keys(values)) {
							if (k === 'Id' || k === 'attributes') {
								continue;
							}
							const v = values[k];
							if (v != null && typeof v !== 'object' && String(v).trim() !== '') {
								return { field: k, value: String(v) };
							}
						}
						return null;
					}
					const MAX_PREVIEW_ROWS = 200;
					const decorated = body.records.map((rec) => {
						const id = rec.loadedFromId || (rec.values && rec.values.Id) || '';
						const ident = pickIdentifier(rec.values);
						return { rec: rec, id: id, ident: ident, sortName: ident ? ident.value : id };
					});
					const COLLATE = { numeric: true, sensitivity: 'base' };
					decorated.sort((a, b) => {
						const byObj = String(a.rec.objectName || '').localeCompare(
							String(b.rec.objectName || ''),
							undefined,
							COLLATE,
						);
						if (byObj !== 0) {
							return byObj;
						}
						return String(a.sortName || '').localeCompare(String(b.sortName || ''), undefined, COLLATE);
					});
					const shownRows = decorated.slice(0, MAX_PREVIEW_ROWS);
					const moreCount = decorated.length - shownRows.length;
					const rowsHtml = shownRows
						.map((row) => {
							const rec = row.rec,
								id = row.id,
								ident = row.ident;
							const identText = ident ? ident.value : id || '—';
							let nameCell;
							if (sfBase && id) {
								const url =
									sfBase +
									'/lightning/r/' +
									encodeURIComponent(rec.objectName) +
									'/' +
									encodeURIComponent(id) +
									'/view';
								nameCell =
									'<a class="soql-id-link" href="' +
									escapeHtml(url) +
									'" target="_blank" rel="noopener" title="Open in Salesforce">' +
									escapeHtml(identText) +
									'</a>';
							} else {
								nameCell = escapeHtml(identText);
							}
							return (
								'<tr><td class="soql-col-obj"><span class="tag">' +
								escapeHtml(rec.objectName) +
								'</span></td>' +
								'<td class="soql-col-id">' +
								escapeHtml(id) +
								'</td>' +
								'<td class="soql-col-name">' +
								nameCell +
								'</td></tr>'
							);
						})
						.join('');
					const moreNote =
						moreCount > 0
							? '<div class="soql-more-note">…and ' +
								moreCount +
								' more not shown · all ' +
								body.records.length +
								' will be added.</div>'
							: '';
					const tableHtml = body.records.length
						? '<div class="soql-preview-tablewrap' +
							(showRecordIds ? ' soql-show-ids' : '') +
							'"><table class="soql-preview-table">' +
							'<thead><tr><th>Object</th><th class="soql-col-id">ID</th><th>Name</th></tr></thead><tbody>' +
							rowsHtml +
							'</tbody></table></div>' +
							moreNote
						: '';
					previewPane.innerHTML =
						truncationNote +
						'<div class="soql-preview-heading"><div class="soql-summary"><strong>' +
						body.records.length +
						' record' +
						(body.records.length === 1 ? '' : 's') +
						'</strong> ready to add' +
						(breakdown ? ' (' + breakdown + ')' : '') +
						'.</div>' +
						(body.records.length
							? '<button type="button" class="soql-toggle-ids" data-soql-toggle-ids aria-pressed="' +
								showRecordIds +
								'">Show IDs</button>'
							: '') +
						'</div>' +
						tableHtml;
				}

				async function runPreview() {
					const soql = (textarea.value || '').trim();
					if (!soql) {
						previewPane.innerHTML = '<div class="banner">Type a SOQL query first.</div>';
						return;
					}
					previewBtn.disabled = true;
					commitBtn.disabled = true;
					previewPane.innerHTML = '<p class="tag center">Running query\u2026</p>';
					lastResult = null;
					lastResultSoql = null;
					try {
						const { ok, status, body } = await runQuery(soql);
						if (!ok) {
							previewPane.innerHTML =
								'<div class="banner error">' + formatQueryError(body, status) + '</div>';
							return;
						}
						lastResult = body;
						lastResultSoql = soql;
						renderPreview(body);
					} catch (err) {
						previewPane.innerHTML =
							'<div class="banner error">' + escapeHtml(err.message || String(err)) + '</div>';
					} finally {
						previewBtn.disabled = false;
						commitBtn.disabled = false;
					}
				}

				async function commit() {
					const soql = (textarea.value || '').trim();
					if (!soql) {
						previewPane.innerHTML = '<div class="banner">Type a SOQL query first.</div>';
						return;
					}
					commitBtn.disabled = true;
					previewBtn.disabled = true;
					const originalLabel = commitBtn.textContent;
					commitBtn.textContent = 'Adding\u2026';
					let _undo = null;
					try {
						let result = lastResult;
						const cacheStale = !result || lastResultSoql !== soql;
						if (cacheStale) {
							previewPane.innerHTML = '<p class="tag center">Running query\u2026</p>';
							const { ok, status, body } = await runQuery(soql);
							if (!ok) {
								_shared.captureImportFailure('soql', 'query');
								previewPane.innerHTML =
									'<div class="banner error">' + formatQueryError(body, status) + '</div>';
								return;
							}
							result = body;
							lastResult = body;
							lastResultSoql = soql;
						}
						if (!result.records || result.records.length === 0) {
							previewPane.innerHTML =
								'<div class="banner">Query returned 0 records; nothing to add.</div>';
							return;
						}
						_undo = captureUndoSnapshot ? captureUndoSnapshot() : null;
						const summary = await soqlImportCommitToCanvas(result, { focusImported: true });
						if (summary.blocked) {
							previewPane.innerHTML =
								'<div class="banner error">' +
								escapeHtml(summary.capReason || 'Canvas is at the record limit.') +
								'</div>';
							return;
						}
						const addedNote = summary.added + ' record' + (summary.added === 1 ? '' : 's');
						const skippedNote =
							summary.skipped > 0 ? ' \u00b7 ' + summary.skipped + ' already on canvas (skipped)' : '';
						if (summary.added === 0) {
							previewPane.innerHTML =
								'<div class="banner">All ' +
								summary.skipped +
								' record' +
								(summary.skipped === 1 ? '' : 's') +
								' from this query are already on the canvas; nothing new to add.</div>';
							return;
						}
						const fkNote =
							summary.associationsSkippedFk > 0
								? ' · ' +
									summary.associationsSkippedFk +
									' link' +
									(summary.associationsSkippedFk === 1 ? '' : 's') +
									' skipped (lookup already set)'
								: '';
						const _msg = 'Added ' + addedNote + ' from SOQL.' + skippedNote + fkNote;
						if (_undo && showBulkToastWithAction) {
							showBulkToastWithAction(_msg, 'Undo', _undo);
						} else {
							showBulkToast(_msg);
						}
						close();
					} catch (err) {
						if (_undo) {
							_undo();
						}
						_shared.captureImportFailure('soql', 'commit');
						previewPane.innerHTML =
							'<div class="banner error">Could not add to canvas: ' +
							escapeHtml(err.message || String(err)) +
							(_undo ? ' The canvas was restored; nothing changed.' : '') +
							'</div>';
					} finally {
						commitBtn.disabled = false;
						previewBtn.disabled = false;
						commitBtn.textContent = originalLabel;
					}
				}

				previewBtn.addEventListener('click', runPreview);
				commitBtn.addEventListener('click', commit);
				textarea.addEventListener('keydown', (e) => {
					if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
						e.preventDefault();
						runPreview();
					}
				});
			}

			async function soqlImportCommitToCanvas(result, opts) {
				// De-duplicate by Salesforce object and ID before counting against the canvas cap.
				const records = Array.isArray(result.records) ? result.records : [];
				const associations = Array.isArray(result.associations) ? result.associations : [];
				if (records.length === 0) {
					return { added: 0, skipped: 0 };
				}

				const existingByKey = new Map();
				canvasState.bulkRecords.forEach((br) => {
					if (br.isTypeNode || !br.loadedFromId) {
						return;
					}
					existingByKey.set(br.objectName + '::' + br.loadedFromId, br.id);
				});

				const dupTempIds = new Set();
				const newRecords = [];
				records.forEach((rec) => {
					const key = rec.objectName + '::' + rec.loadedFromId;
					if (existingByKey.has(key)) {
						dupTempIds.add(rec.tempId);
					} else {
						newRecords.push(rec);
					}
				});

				const knownTotal = opts && typeof opts.knownTotal === 'number' ? opts.knownTotal : 0;
				const reportedTotal = typeof result.totalSize === 'number' ? result.totalSize : records.length;
				const totalMatch = Math.max(knownTotal, reportedTotal, records.length);
				const capAttempt = totalMatch > records.length ? totalMatch : newRecords.length;
				const _cap = canvasCapCheck(capAttempt);
				if (_cap.blocked) {
					return { added: 0, skipped: dupTempIds.size, blocked: true, capReason: _cap.reason };
				}

				const orderedObjectNames = [];
				const seenObjects = new Set();
				if (result.objectName && newRecords.some((r) => r.objectName === result.objectName)) {
					orderedObjectNames.push(result.objectName);
					seenObjects.add(result.objectName);
				}
				for (const rec of newRecords) {
					if (!seenObjects.has(rec.objectName)) {
						orderedObjectNames.push(rec.objectName);
						seenObjects.add(rec.objectName);
					}
				}
				const selByName = {};
				for (const objName of orderedObjectNames) {
					let sel = canvasState.selectedObjects.find((s) => s.name === objName);
					if (!sel) {
						const parentSel = selByName[result.objectName] || null;
						sel = await addToSelection(
							objName,
							parentSel && parentSel.name !== objName ? parentSel.id : null,
							null,
							null,
						);
					}
					selByName[objName] = sel;
				}

				if (opts?.canCommit && !opts.canCommit()) {
					throw new Error('The canvas changed while loading. Try importing the records again.');
				}
				clearEmptyStarterCard();
				const canvasEl = getGraph().querySelector('#bulk-canvas');
				const startX = (canvasEl ? canvasEl.clientWidth / 2 : 600) - 220;
				const existingMaxY = canvasState.bulkRecords.reduce((m, r) => Math.max(m, r.y || 0), 0);
				const startY = canvasState.bulkRecords.length === 0 ? 120 : existingMaxY + 220;
				const colStep = 240;
				const rowStep = 180;
				const cols = 4;

				const clientIdByTempId = {};
				records.forEach((rec) => {
					const key = rec.objectName + '::' + rec.loadedFromId;
					const existingId = existingByKey.get(key);
					if (existingId != null) {
						clientIdByTempId[rec.tempId] = existingId;
					}
				});
				const isCompact = result && result.fullFields === false;
				const newBulkIds = new Set();
				newRecords.forEach((rec, idx) => {
					const sel = selByName[rec.objectName];
					const col = idx % cols;
					const row = Math.floor(idx / cols);
					const newRec = {
						id: canvasState.bulkIdSeq++,
						objectName: rec.objectName,
						label: sel ? sel.label : rec.objectName,
						x: startX + col * colStep,
						y: startY + row * rowStep,
						values: Object.assign({}, rec.values || {}),
						loadedFromId: rec.loadedFromId,
						loadedValues: Object.assign({}, rec.values || {}),
						fromSelectionId: sel ? sel.id : null,
					};
					if (isCompact) {
						newRec._loadedFieldNames = Object.keys(rec.values || {});
					}
					canvasState.bulkRecords.push(newRec);
					clientIdByTempId[rec.tempId] = newRec.id;
					newBulkIds.add(newRec.id);
				});

				const existingAssocKey = new Set(
					canvasState.bulkAssociations.map((a) => a.fromId + '->' + a.toId + '::' + a.fieldName),
				);
				const _admitAssociation = window.OrgLoom.importShared.admitAssociation;
				const _usedFk = new Set();
				canvasState.bulkAssociations.forEach((a) => {
					_usedFk.add(a.fromId + '::' + a.fieldName);
				});
				let assocsAdded = 0;
				let assocsSkippedFk = 0;
				for (const a of associations) {
					const fromId = clientIdByTempId[a.fromTempId];
					const toId = clientIdByTempId[a.toTempId];
					if (fromId == null || toId == null) {
						continue;
					}
					const key = fromId + '->' + toId + '::' + a.fieldName;
					if (existingAssocKey.has(key)) {
						continue;
					}
					if (!_admitAssociation(_usedFk, fromId, toId, a.fieldName)) {
						assocsSkippedFk++;
						continue;
					}
					canvasState.bulkAssociations.push({
						id: canvasState.bulkIdSeq++,
						fromId,
						toId,
						fieldName: a.fieldName,
					});
					existingAssocKey.add(key);
					assocsAdded++;
				}
				if (reconcileLoadedRecordAssociations) {
					assocsAdded += reconcileLoadedRecordAssociations(canvasState).added;
				}
				clearBulkUserDeleted();
				if (newBulkIds.size > 0) {
					setSkipNextCyAutoPan(true);
					if (opts && opts.focusImported) {
						canvasState.bulkSelectedIds = new Set(newBulkIds);
						canvasState.bulkSelectedEdgeId = null;
						if (typeof deps.setSelectedDerivedEdge === 'function') {
							deps.setSelectedDerivedEdge(null);
						}
					}
				}
				if (typeof renderBulkView === 'function') {
					renderBulkView();
				}
				if (newBulkIds.size > 0) {
					relayoutNewRecords(newBulkIds, { focusImported: !!(opts && opts.focusImported) });
				}
				return {
					added: newRecords.length,
					skipped: dupTempIds.size,
					associationsAdded: assocsAdded,
					associationsSkippedFk: assocsSkippedFk,
				};
			}

			async function runAndCommitSoql(soql, opts) {
				opts = opts || {};
				const fullFields = true;
				const r = await csrfFetch('/api/query', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					credentials: 'same-origin',
					body: JSON.stringify({ soql, fullFields }),
				});
				const body = await r.json().catch(() => ({}));
				if (!r.ok) {
					const err = new Error((body && body.message) || (body && body.error) || 'HTTP ' + r.status);
					err.body = body;
					err.status = r.status;
					throw err;
				}
				if (!body.records || body.records.length === 0) {
					return { added: 0, skipped: 0, totalSize: body.totalSize || 0, body };
				}
				const summary = await soqlImportCommitToCanvas(body, opts);
				return Object.assign({ totalSize: body.totalSize || 0, body }, summary);
			}

			return {
				openModal: openSoqlImportModal,
				runAndCommitSoql: runAndCommitSoql,
				commitRecords: soqlImportCommitToCanvas,
			};
		},
	};
})();

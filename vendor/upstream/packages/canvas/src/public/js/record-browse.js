(function () {
	'use strict';
	// Browses Salesforce records using describe-approved fields, filters, and pagination.

	window.OrgLoom = window.OrgLoom || {};

	const STRING_TYPES = new Set(['string', 'textarea', 'phone', 'url', 'email', 'encryptedstring']);
	const NUMERIC_TYPES = new Set(['int', 'double', 'currency', 'percent']);
	const PICKLIST_TYPES = new Set(['picklist', 'combobox']);
	function _operatorsFor(field) {
		if (!field) {
			return [{ op: 'equals', label: 'equals' }];
		}
		const t = field.type;
		if (STRING_TYPES.has(t)) {
			return [
				{ op: 'equals', label: 'equals' },
				{ op: 'notEquals', label: 'does not equal' },
				{ op: 'contains', label: 'contains' },
				{ op: 'startsWith', label: 'starts with' },
				{ op: 'isNull', label: 'is empty' },
				{ op: 'isNotNull', label: 'is not empty' },
			];
		}
		if (NUMERIC_TYPES.has(t)) {
			return [
				{ op: 'equals', label: '=' },
				{ op: 'notEquals', label: '≠' },
				{ op: 'gt', label: '>' },
				{ op: 'gte', label: '≥' },
				{ op: 'lt', label: '<' },
				{ op: 'lte', label: '≤' },
				{ op: 'isNull', label: 'is empty' },
				{ op: 'isNotNull', label: 'is not empty' },
			];
		}
		if (PICKLIST_TYPES.has(t)) {
			return [
				{ op: 'equals', label: 'equals' },
				{ op: 'notEquals', label: 'does not equal' },
				{ op: 'in', label: 'is any of' },
				{ op: 'isNull', label: 'is empty' },
				{ op: 'isNotNull', label: 'is not empty' },
			];
		}
		if (t === 'reference' || t === 'id') {
			return [
				{ op: 'equals', label: 'equals' },
				{ op: 'notEquals', label: 'does not equal' },
				{ op: 'isNull', label: 'is empty' },
				{ op: 'isNotNull', label: 'is not empty' },
			];
		}
		if (t === 'date' || t === 'datetime') {
			return [
				{ op: 'equals', label: 'equals' },
				{ op: 'notEquals', label: 'does not equal' },
				{ op: 'before', label: 'before' },
				{ op: 'after', label: 'after' },
				{ op: 'isNull', label: 'is empty' },
				{ op: 'isNotNull', label: 'is not empty' },
			];
		}
		if (t === 'boolean') {
			return [{ op: 'equals', label: 'equals' }];
		}
		return [{ op: 'equals', label: 'equals' }];
	}

	function _opTakesValue(op) {
		return op !== 'isNull' && op !== 'isNotNull';
	}

	function _browsePageWindow(count, limit, requestedOffset, returnedRecordCount) {
		const safeCount = Math.max(0, Number(count) || 0);
		const safeLimit = Math.max(1, Number(limit) || 1);
		const requested = Math.max(0, Number(requestedOffset) || 0);
		const lastOffset = safeCount > 0 ? Math.floor((safeCount - 1) / safeLimit) * safeLimit : 0;
		const offset = Math.min(requested, lastOffset);
		const available = Math.max(0, safeCount - offset);
		const returned = Math.max(0, Number(returnedRecordCount) || 0);
		const pageLength = Math.min(returned, safeLimit, available);
		return {
			offset,
			start: safeCount === 0 ? 0 : offset + 1,
			end: offset + pageLength,
			hasPrev: offset > 0,
			hasMore: offset + pageLength < safeCount,
		};
	}

	function _datetimeLocalToIso(value) {
		const raw = String(value == null ? '' : value).trim();
		if (!raw) {
			return raw;
		}
		const parsed = new Date(raw);
		return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
	}

	function _updateFilterValueFromInput(filter, control) {
		if (!control.classList.contains('rb-filter-value')) {
			return false;
		}
		filter.value = control.classList.contains('rb-filter-value-multi')
			? Array.from(control.selectedOptions).map((option) => option.value)
			: control.value;
		return true;
	}

	const SALESFORCE_ID_RE = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
	function _salesforceIdInList(ids) {
		return Array.from(ids || [])
			.map((id) => String(id))
			.map((id) => {
				if (!SALESFORCE_ID_RE.test(id)) {
					throw new Error(
						'Browse selection contains an invalid Salesforce ID. Refresh the results and try again.',
					);
				}
				return "'" + id + "'";
			})
			.join(', ');
	}

	window.OrgLoom.recordBrowse = {
		mount: function mount(deps) {
			const required = [
				'canvasState',
				'csrfFetch',
				'escapeHtml',
				'ensureDescribe',
				'showBulkToast',
				'runAndCommitSoql',
				'canvasCapCheck',
			];
			if (!deps) {
				throw new Error('record-browse.mount: missing deps object');
			}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('record-browse.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			const ensureDescribe = deps.ensureDescribe;
			const showBulkToast = deps.showBulkToast;
			const runAndCommitSoql = deps.runAndCommitSoql;
			const canvasCapCheck = deps.canvasCapCheck;
			const captureUndoSnapshot =
				typeof deps.captureUndoSnapshot === 'function' ? deps.captureUndoSnapshot : null;
			const showBulkToastWithAction =
				typeof deps.showBulkToastWithAction === 'function' ? deps.showBulkToastWithAction : null;
			const pingAuditEvent = typeof deps.pingAuditEvent === 'function' ? deps.pingAuditEvent : null;
			const _shared = window.OrgLoom.importShared;

			let _objectsCache = null;
			async function _loadObjects() {
				if (_objectsCache) {
					return _objectsCache;
				}
				const r = await csrfFetch('/api/objects', { credentials: 'same-origin' });
				const data = await r.json().catch(() => null);
				if (!r.ok) {
					throw new Error((data && data.error) || 'HTTP ' + r.status);
				}
				const list = Array.isArray(data) ? data : data && Array.isArray(data.objects) ? data.objects : [];
				_objectsCache = list.filter((o) => o && o.queryable !== false);
				return _objectsCache;
			}

			let _state = null;
			let _fetchTimer = null;
			let _fetchSeq = 0;
			function _newState(initialObjectName) {
				return {
					objectName: initialObjectName || null,
					filters: [], // [{ id, field, op, value }]
					search: '',
					sort: null, // { field, direction }
					limit: 25,
					offset: 0,
					filterIdSeq: 1,
					lastResult: null, // { count, records, hasMore, previewFields, loadSoql }
					basket: new Map(),
				};
			}
			const SELECTION_CAP = 500;

			function _currentSel() {
				if (!_state.objectName) {
					return new Set();
				}
				if (!_state.basket.has(_state.objectName)) {
					_state.basket.set(_state.objectName, new Set());
				}
				return _state.basket.get(_state.objectName);
			}
			function _basketTotal() {
				let n = 0;
				for (const set of _state.basket.values()) {
					n += set.size;
				}
				return n;
			}
			function _basketEntries() {
				const out = [];
				for (const [name, set] of _state.basket) {
					if (set.size > 0) {
						out.push({ objectName: name, ids: set, count: set.size });
					}
				}
				return out;
			}
			function _objectLabel(name) {
				const list = _objectsCache || [];
				const o = list.find((x) => x && x.name === name);
				return (o && o.label) || name;
			}

			function _availableFilterFields(objectName) {
				// Never offer a WHERE field Salesforce describe marks as non-filterable.
				const desc = canvasState.describeCache[objectName];
				if (!desc || !Array.isArray(desc.fields)) {
					return [];
				}
				const UNUSABLE_TYPES = new Set(['base64', 'address', 'location', 'anyType', 'complexvalue']);
				return desc.fields
					.filter((f) => f && f.name && f.type && f.filterable === true && !UNUSABLE_TYPES.has(f.type))
					.slice()
					.sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name));
			}
			function _fieldByName(objectName, fieldName) {
				const desc = canvasState.describeCache[objectName];
				if (!desc || !Array.isArray(desc.fields)) {
					return null;
				}
				return desc.fields.find((f) => f && f.name === fieldName) || null;
			}

			function _renderValueInput(filter, field) {
				const id = 'filter-' + filter.id + '-value';
				if (!_opTakesValue(filter.op)) {
					return '<span class="rb-filter-value-disabled" id="' + id + '" data-no-value>(no value)</span>';
				}
				const v = filter.value;
				if (
					field &&
					(field.type === 'picklist' || field.type === 'combobox') &&
					Array.isArray(field.picklistValues) &&
					filter.op !== 'in'
				) {
					const opts = field.picklistValues
						.filter((p) => p && p.active !== false)
						.map(
							(p) =>
								'<option value="' +
								escapeHtml(p.value) +
								'"' +
								(String(v) === p.value ? ' selected' : '') +
								'>' +
								escapeHtml(p.label || p.value) +
								'</option>',
						)
						.join('');
					return (
						'<select class="rb-filter-value" id="' +
						id +
						'" data-filter-id="' +
						filter.id +
						'">' +
						'<option value="">(pick)</option>' +
						opts +
						'</select>'
					);
				}
				if (field && (field.type === 'picklist' || field.type === 'combobox') && filter.op === 'in') {
					const selected = Array.isArray(v) ? new Set(v) : new Set();
					const opts = (field.picklistValues || [])
						.filter((p) => p && p.active !== false)
						.map(
							(p) =>
								'<option value="' +
								escapeHtml(p.value) +
								'"' +
								(selected.has(p.value) ? ' selected' : '') +
								'>' +
								escapeHtml(p.label || p.value) +
								'</option>',
						)
						.join('');
					return (
						'<select multiple class="rb-filter-value rb-filter-value-multi" id="' +
						id +
						'" data-filter-id="' +
						filter.id +
						'" size="4">' +
						opts +
						'</select>'
					);
				}
				if (field && field.type === 'boolean') {
					return (
						'<select class="rb-filter-value" id="' +
						id +
						'" data-filter-id="' +
						filter.id +
						'">' +
						'<option value="">(pick)</option>' +
						'<option value="true"' +
						(String(v) === 'true' ? ' selected' : '') +
						'>Yes</option>' +
						'<option value="false"' +
						(String(v) === 'false' ? ' selected' : '') +
						'>No</option>' +
						'</select>'
					);
				}
				if (field && field.type === 'date') {
					return (
						'<input type="date" class="rb-filter-value" id="' +
						id +
						'" data-filter-id="' +
						filter.id +
						'" value="' +
						escapeHtml(v || '') +
						'">'
					);
				}
				if (field && field.type === 'datetime') {
					return (
						'<input type="datetime-local" class="rb-filter-value" id="' +
						id +
						'" data-filter-id="' +
						filter.id +
						'" value="' +
						escapeHtml(v || '') +
						'">'
					);
				}
				if (field && NUMERIC_TYPES.has(field.type)) {
					return (
						'<input type="number" class="rb-filter-value" id="' +
						id +
						'" data-filter-id="' +
						filter.id +
						'" value="' +
						escapeHtml(v == null ? '' : String(v)) +
						'" placeholder="0">'
					);
				}
				return (
					'<input type="text" class="rb-filter-value" id="' +
					id +
					'" data-filter-id="' +
					filter.id +
					'" value="' +
					escapeHtml(v == null ? '' : String(v)) +
					'" placeholder="value">'
				);
			}

			function _renderFilterChip(filter) {
				const fields = _availableFilterFields(_state.objectName);
				const fieldOptions = fields
					.map(
						(f) =>
							'<option value="' +
							escapeHtml(f.name) +
							'"' +
							(filter.field === f.name ? ' selected' : '') +
							'>' +
							escapeHtml(f.label || f.name) +
							'</option>',
					)
					.join('');
				const fieldDef = filter.field ? _fieldByName(_state.objectName, filter.field) : null;
				const ops = _operatorsFor(fieldDef);
				const opOptions = ops
					.map(
						(o) =>
							'<option value="' +
							escapeHtml(o.op) +
							'"' +
							(filter.op === o.op ? ' selected' : '') +
							'>' +
							escapeHtml(o.label) +
							'</option>',
					)
					.join('');
				return (
					'<div class="rb-filter-chip" data-filter-id="' +
					filter.id +
					'">' +
					'<select class="rb-filter-field" data-filter-id="' +
					filter.id +
					'">' +
					'<option value="">(field)</option>' +
					fieldOptions +
					'</select>' +
					'<select class="rb-filter-op" data-filter-id="' +
					filter.id +
					'">' +
					opOptions +
					'</select>' +
					_renderValueInput(filter, fieldDef) +
					'<button type="button" class="rb-filter-remove" data-filter-remove="' +
					filter.id +
					'" title="Remove this filter">×</button>' +
					'</div>'
				);
			}

			function _onCanvasIds() {
				const set = new Set();
				const recs = (canvasState && canvasState.bulkRecords) || [];
				for (const r of recs) {
					if (r && !r.isTypeNode && r.loadedFromId && r.objectName === _state.objectName) {
						set.add(r.loadedFromId);
					}
				}
				return set;
			}

			function _renderPreviewTable(result) {
				if (!result || result.count === 0) {
					return '<p class="rb-empty">No records match your filters.</p>';
				}
				const fields = result.previewFields || ['Id'];
				const pageRecords = result.records || [];
				const pageIds = pageRecords.map((r) => r.Id).filter(Boolean);
				const onCanvas = _onCanvasIds();
				const sel = _currentSel();
				const sfBase = (window.SF_INSTANCE_URL || '').replace(/\/+$/, '');
				const _desc = canvasState.describeCache[_state.objectName];
				const _nameField =
					_desc && Array.isArray(_desc.fields) ? _desc.fields.find((fl) => fl && fl.nameField) || null : null;
				const linkField =
					_nameField && _nameField.name && fields.indexOf(_nameField.name) !== -1 ? _nameField.name : 'Id';
				const selectablePageIds = pageIds.filter((id) => !onCanvas.has(id));
				const allPageSelected = selectablePageIds.length > 0 && selectablePageIds.every((id) => sel.has(id));
				const head =
					'<tr>' +
					'<th class="rb-th-select">' +
					'<input type="checkbox" class="rb-select-all" data-rb-select-page' +
					(allPageSelected ? ' checked' : '') +
					' title="Select all records on this page">' +
					'</th>' +
					fields.map((f) => '<th>' + escapeHtml(f) + '</th>').join('') +
					'</tr>';
				const rows = pageRecords
					.map((rec) => {
						const isOnCanvas = rec.Id && onCanvas.has(rec.Id);
						const checked = isOnCanvas || (rec.Id && sel.has(rec.Id)) ? ' checked' : '';
						const idAttr = rec.Id ? ' data-rb-row-id="' + escapeHtml(rec.Id) + '"' : '';
						const cells = fields
							.map((f) => {
								const v = rec[f];
								const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
								if (f === linkField && s && rec.Id && sfBase) {
									const url =
										sfBase +
										'/lightning/r/' +
										encodeURIComponent(_state.objectName) +
										'/' +
										encodeURIComponent(rec.Id) +
										'/view';
									return (
										'<td><a class="rb-id-link" href="' +
										escapeHtml(url) +
										'" target="_blank" rel="noopener" title="Open in Salesforce">' +
										escapeHtml(s) +
										'</a></td>'
									);
								}
								return '<td>' + escapeHtml(s) + '</td>';
							})
							.join('');
						return (
							'<tr' +
							idAttr +
							(isOnCanvas ? ' class="rb-row--on-canvas"' : '') +
							'>' +
							'<td class="rb-td-select">' +
							(rec.Id
								? '<input type="checkbox" class="rb-row-select" data-rb-row-checkbox="' +
									escapeHtml(rec.Id) +
									'"' +
									checked +
									(isOnCanvas ? ' disabled title="Already on the canvas"' : '') +
									'>'
								: '') +
							'</td>' +
							cells +
							'</tr>'
						);
					})
					.join('');
				return (
					'<table class="rb-preview-table">' +
					'<thead>' +
					head +
					'</thead>' +
					'<tbody>' +
					rows +
					'</tbody>' +
					'</table>'
				);
			}

			async function _fetchResults(content) {
				// Sequence each request so a slower, older response cannot replace newer filter results.
				const validFilters = _state.filters.filter(
					(f) =>
						f.field &&
						f.op &&
						(!_opTakesValue(f.op)
							? true
							: f.value != null && f.value !== '' && !(Array.isArray(f.value) && f.value.length === 0)),
				);
				const requestFilters = validFilters.map((filter) => {
					const field = _fieldByName(_state.objectName, filter.field);
					return field && field.type === 'datetime'
						? { ...filter, value: _datetimeLocalToIso(filter.value) }
						: filter;
				});
				const statusEl = content.querySelector('.rb-count');
				statusEl.textContent = 'Counting…';
				statusEl.classList.remove('rb-count-error');
				const _seq = ++_fetchSeq;
				try {
					const r = await csrfFetch('/api/browse', {
						method: 'POST',
						credentials: 'same-origin',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							objectName: _state.objectName,
							filters: requestFilters,
							search: _state.search,
							sort: _state.sort,
							limit: _state.limit,
							offset: _state.offset,
							onCanvasIds: Array.from(_onCanvasIds()),
						}),
					});
					const body = await r.json().catch(() => ({}));
					if (_seq !== _fetchSeq) {
						return;
					}
					if (!r.ok) {
						throw new Error((body && (body.message || body.error)) || 'HTTP ' + r.status);
					}
					const count = body.count || 0;
					const pageWindow = _browsePageWindow(
						count,
						_state.limit,
						_state.offset,
						(body.records || []).length,
					);
					if (pageWindow.offset !== _state.offset) {
						_state.offset = pageWindow.offset;
						_state.lastResult = null;
						return _fetchResults(content);
					}
					_state.lastResult = body;
					const loadable = typeof body.loadableCount === 'number' ? body.loadableCount : count;
					const onCanvasInMatch = Math.max(0, count - loadable);
					statusEl.textContent = count + ' record' + (count === 1 ? '' : 's') + ' match';
					if (onCanvasInMatch > 0) {
						const onCanvasNote = document.createElement('span');
						onCanvasNote.className = 'rb-count-secondary';
						onCanvasNote.textContent = ' · ' + onCanvasInMatch + ' already on canvas';
						statusEl.appendChild(onCanvasNote);
					}
					content.querySelector('.rb-preview').innerHTML = _renderPreviewTable(body);
					_renderSelectionSummary(content);
					_updateLoadButton(content);
					const pageInfo = content.querySelector('.rb-page-info');
					if (body.count > _state.limit) {
						pageInfo.innerHTML =
							'Showing ' +
							pageWindow.start +
							'–' +
							pageWindow.end +
							' of ' +
							body.count +
							' · ' +
							'<button type="button" class="rb-page-btn" data-rb-prev' +
							(!pageWindow.hasPrev ? ' disabled' : '') +
							'>Prev</button> ' +
							'<button type="button" class="rb-page-btn" data-rb-next' +
							(!pageWindow.hasMore ? ' disabled' : '') +
							'>Next</button>';
					} else {
						pageInfo.innerHTML = '';
					}
				} catch (e) {
					if (_seq !== _fetchSeq) {
						return;
					}
					_shared.captureImportFailure('browse', 'count');
					statusEl.textContent = 'Error: ' + (e.message || String(e));
					statusEl.classList.add('rb-count-error');
					content.querySelector('.rb-preview').innerHTML = '';
					content.querySelector('.rb-page-info').innerHTML = '';
					_state.lastResult = null;
					_updateLoadButton(content);
				}
			}

			function _scheduleFetch(content) {
				if (_fetchTimer) {
					clearTimeout(_fetchTimer);
				}
				_fetchSeq += 1;
				_state.lastResult = null;
				_updateLoadButton(content);
				_fetchTimer = setTimeout(() => _fetchResults(content), 300);
			}

			function _updateLoadButton(content) {
				const overlay = content.closest('.record-browse-modal');
				const loadBtn = overlay && overlay.querySelector('.rb-load-btn');
				if (!loadBtn) {
					return;
				}
				const count = (_state.lastResult && _state.lastResult.count) || 0;
				const loadable =
					_state.lastResult && typeof _state.lastResult.loadableCount === 'number'
						? _state.lastResult.loadableCount
						: count;
				const basketTotal = _basketTotal();
				const basketObjects = _basketEntries().length;
				const hasBasket = basketTotal > 0;
				loadBtn.disabled = hasBasket ? false : !_state.objectName || loadable === 0;
				if (hasBasket) {
					loadBtn.textContent =
						basketObjects > 1
							? 'Load ' + basketTotal + ' selected (' + basketObjects + ' objects) to canvas'
							: 'Load ' + basketTotal + ' selected to canvas';
				} else if (loadable > 0) {
					loadBtn.textContent = 'Load all ' + loadable + ' to canvas';
				} else if (count > 0) {
					loadBtn.textContent = 'All ' + count + ' already on canvas';
				} else {
					loadBtn.textContent = 'Load to canvas';
				}
			}

			function _renderSelectionSummary(content) {
				const summary = content.querySelector('.rb-selection-summary');
				if (!summary) {
					return;
				}
				const n = _basketTotal();
				const entries = _basketEntries();
				if (n === 0) {
					summary.innerHTML = '';
					return;
				}
				const items = entries
					.map(
						(e) =>
							'<li class="rb-basket-item' +
							(e.objectName === _state.objectName ? ' rb-basket-item--current' : '') +
							'">' +
							'<button type="button" class="rb-basket-goto" data-rb-goto-object="' +
							escapeHtml(e.objectName) +
							'" title="Show this object">' +
							escapeHtml(_objectLabel(e.objectName)) +
							'</button>' +
							'<span class="rb-basket-count">' +
							e.count +
							'</span>' +
							'<button type="button" class="rb-basket-drop" data-rb-clear-object="' +
							escapeHtml(e.objectName) +
							'" title="Remove these from the basket">&times;</button>' +
							'</li>',
					)
					.join('');
				summary.innerHTML =
					'<div class="rb-basket">' +
					'<div class="rb-basket-head">' +
					'<span class="rb-basket-total">' +
					n +
					' selected' +
					(entries.length > 1 ? ' across ' + entries.length + ' objects' : '') +
					'</span>' +
					'<button type="button" class="rb-clear-selection" data-rb-clear-all>Clear all</button>' +
					'</div>' +
					'<ul class="rb-basket-list">' +
					items +
					'</ul>' +
					'</div>';
			}

			function _renderNoConnection(content) {
				content.innerHTML =
					'<div class="rb-empty-state">' +
					'<p class="rb-empty-title">No Salesforce org connected</p>' +
					'<p class="tag">Connect a Salesforce org to browse and load its records onto the canvas.</p>' +
					'<button type="button" class="button rb-connect-btn">Connect a Salesforce org</button>' +
					'</div>';
				const btn = content.querySelector('.rb-connect-btn');
				if (btn) {
					btn.addEventListener('click', () => {
						if (
							window.Orgloom &&
							window.Orgloom.sfConnectionsModal &&
							typeof window.Orgloom.sfConnectionsModal.open === 'function'
						) {
							window.Orgloom.sfConnectionsModal.open();
						} else {
							window.location.assign('/connect');
						}
					});
				}
			}

			function _renderBody(content) {
				const objectPicker = content.querySelector('.rb-object-picker');
				const searchInput = content.querySelector('.rb-search');
				searchInput.disabled = !_state.objectName;
				searchInput.value = _state.search;
				searchInput.placeholder =
					_state.objectName === 'Case' ? 'Case number, subject, or record ID' : 'Name or record ID';
				const filterArea = content.querySelector('.rb-filters');
				if (!objectPicker.dataset.populated) {
					_loadObjects()
						.then((objs) => {
							const opts = objs
								.map(
									(o) =>
										'<option value="' +
										escapeHtml(o.name) +
										'"' +
										(_state.objectName === o.name ? ' selected' : '') +
										'>' +
										escapeHtml(o.label || o.name) +
										(o.label && o.label !== o.name ? ' (' + escapeHtml(o.name) + ')' : '') +
										'</option>',
								)
								.join('');
							objectPicker.innerHTML =
								'<option value="" disabled' +
								(!_state.objectName ? ' selected' : '') +
								'>Select an object</option>' +
								opts;
							objectPicker.dataset.populated = '1';
						})
						.catch((e) => {
							const msg = (e && e.message) || String(e);
							if (/no-active-connection|not-connected/i.test(msg)) {
								_renderNoConnection(content);
								return;
							}
							objectPicker.innerHTML = '<option value="">' + escapeHtml('Error: ' + msg) + '</option>';
						});
				}
				filterArea.innerHTML = _state.objectName
					? _state.filters.map(_renderFilterChip).join('') +
						'<button type="button" class="rb-add-filter" data-rb-add-filter>+ Add filter</button>'
					: '';
				const resultsHead = content.querySelector('.rb-results-head');
				if (resultsHead) {
					resultsHead.style.display = _state.objectName ? '' : 'none';
				}
				_updateLoadButton(content);
			}

			function _wireBodyHandlers(content) {
				content.querySelector('.rb-search').addEventListener('input', (ev) => {
					_state.search = ev.target.value;
					_state.offset = 0;
					_scheduleFetch(content);
				});
				content.querySelector('.rb-object-picker').addEventListener('change', async (ev) => {
					clearTimeout(_fetchTimer);
					_fetchSeq += 1;
					const name = ev.target.value;
					_state.objectName = name || null;
					_state.filters = [];
					_state.search = '';
					_state.sort = null;
					content.querySelector('.rb-search').value = '';
					content.querySelector('.rb-search').disabled = true;
					_state.offset = 0;
					_state.lastResult = null;
					content.querySelector('.rb-count').textContent = name ? 'Loading describe…' : '';
					content.querySelector('.rb-preview').innerHTML = '';
					content.querySelector('.rb-page-info').innerHTML = '';
					_renderSelectionSummary(content);
					_updateLoadButton(content);
					if (!name) {
						_renderBody(content);
						return;
					}
					try {
						await ensureDescribe(name);
					} catch (e) {
						content.querySelector('.rb-count').textContent =
							'Describe load failed: ' + (e.message || String(e));
						return;
					}
					if (_state.objectName !== name) {
						return;
					}
					_renderBody(content);
					content.querySelector('.rb-count').textContent = '';
					_scheduleFetch(content);
				});

				content.querySelector('.rb-filters').addEventListener('input', (ev) => {
					const t = ev.target;
					if (!t || !t.dataset || !t.dataset.filterId) {
						return;
					}
					const filterId = Number(t.dataset.filterId);
					const filt = _state.filters.find((f) => f.id === filterId);
					if (!filt) {
						return;
					}
					if (!_updateFilterValueFromInput(filt, t)) {
						return;
					}
					_state.offset = 0;
					_scheduleFetch(content);
				});
				content.querySelector('.rb-filters').addEventListener('change', (ev) => {
					const t = ev.target;
					if (!t || !t.dataset || !t.dataset.filterId) {
						return;
					}
					const filterId = Number(t.dataset.filterId);
					const filt = _state.filters.find((f) => f.id === filterId);
					if (!filt) {
						return;
					}
					if (t.classList.contains('rb-filter-field')) {
						filt.field = t.value;
						const fieldDef = _fieldByName(_state.objectName, filt.field);
						const ops = _operatorsFor(fieldDef);
						if (!ops.find((o) => o.op === filt.op)) {
							filt.op = ops[0] ? ops[0].op : 'equals';
						}
						filt.value = '';
						_renderBody(content);
						_state.offset = 0;
						_scheduleFetch(content);
					} else if (t.classList.contains('rb-filter-op')) {
						filt.op = t.value;
						_renderBody(content);
						_state.offset = 0;
						_scheduleFetch(content);
					} else if (t.classList.contains('rb-filter-value-multi')) {
						filt.value = Array.from(t.selectedOptions).map((o) => o.value);
						_state.offset = 0;
						_scheduleFetch(content);
					}
				});
				content.querySelector('.rb-filters').addEventListener('click', (ev) => {
					if (ev.target && ev.target.dataset && ev.target.dataset.rbAddFilter !== undefined) {
						_state.filters.push({
							id: _state.filterIdSeq++,
							field: null,
							op: 'equals',
							value: '',
						});
						_renderBody(content);
					} else if (ev.target && ev.target.dataset && ev.target.dataset.filterRemove) {
						const removeId = Number(ev.target.dataset.filterRemove);
						_state.filters = _state.filters.filter((f) => f.id !== removeId);
						_renderBody(content);
						_state.offset = 0;
						_scheduleFetch(content);
					}
				});

				content.querySelector('.rb-page-info').addEventListener('click', (ev) => {
					if (ev.target.disabled || !_state.lastResult) {
						return;
					}
					const pageWindow = _browsePageWindow(
						_state.lastResult.count,
						_state.limit,
						_state.offset,
						(_state.lastResult.records || []).length,
					);
					if (ev.target.dataset && ev.target.dataset.rbPrev !== undefined) {
						if (!pageWindow.hasPrev) {
							return;
						}
						_state.offset = Math.max(0, _state.offset - _state.limit);
					} else if (ev.target.dataset && ev.target.dataset.rbNext !== undefined) {
						if (!pageWindow.hasMore) {
							return;
						}
						_state.offset += _state.limit;
					} else {
						return;
					}
					_state.lastResult = null;
					content.querySelectorAll('.rb-page-btn').forEach((button) => {
						button.disabled = true;
					});
					_fetchResults(content);
				});

				content.querySelector('.rb-preview').addEventListener('change', (ev) => {
					const t = ev.target;
					if (!t || t.type !== 'checkbox') {
						return;
					}
					const _capNotice = (msg) => {
						const statusEl = content.querySelector('.rb-count');
						if (statusEl) {
							statusEl.classList.add('rb-count-error');
							statusEl.textContent = msg;
						}
					};
					const sel = _currentSel();
					if (t.dataset && t.dataset.rbRowCheckbox) {
						const id = t.dataset.rbRowCheckbox;
						if (t.checked) {
							if (_basketTotal() >= SELECTION_CAP) {
								t.checked = false;
								_capNotice(
									'Selection cap is ' +
										SELECTION_CAP +
										' records. Load these first, then come back to pick more.',
								);
								return;
							}
							sel.add(id);
						} else {
							sel.delete(id);
						}
						_renderSelectionSummary(content);
						_updateLoadButton(content);
						const headerCb = content.querySelector('.rb-select-all');
						if (headerCb) {
							const pageRecords = (_state.lastResult && _state.lastResult.records) || [];
							const onCanvas = _onCanvasIds();
							const selectableIds = pageRecords.map((r) => r.Id).filter((id) => id && !onCanvas.has(id));
							headerCb.checked = selectableIds.length > 0 && selectableIds.every((rid) => sel.has(rid));
						}
					} else if (t.dataset && t.dataset.rbSelectPage !== undefined) {
						const pageRecords = (_state.lastResult && _state.lastResult.records) || [];
						const onCanvas = _onCanvasIds();
						const pageIds = pageRecords.map((r) => r.Id).filter((id) => id && !onCanvas.has(id));
						if (t.checked) {
							for (const id of pageIds) {
								if (_basketTotal() >= SELECTION_CAP) {
									_capNotice(
										'Selection cap is ' +
											SELECTION_CAP +
											' records. Some rows on this page were not added.',
									);
									break;
								}
								sel.add(id);
							}
						} else {
							for (const id of pageIds) {
								sel.delete(id);
							}
						}
						content.querySelector('.rb-preview').innerHTML = _renderPreviewTable(_state.lastResult);
						_renderSelectionSummary(content);
						_updateLoadButton(content);
					}
				});

				content.querySelector('.rb-selection-summary').addEventListener('click', (ev) => {
					const t = ev.target;
					if (!t || !t.dataset) {
						return;
					}
					if (t.dataset.rbClearAll !== undefined) {
						_state.basket.clear();
						content.querySelector('.rb-preview').innerHTML = _renderPreviewTable(_state.lastResult);
						_renderSelectionSummary(content);
						_updateLoadButton(content);
					} else if (t.dataset.rbClearObject) {
						_state.basket.delete(t.dataset.rbClearObject);
						content.querySelector('.rb-preview').innerHTML = _renderPreviewTable(_state.lastResult);
						_renderSelectionSummary(content);
						_updateLoadButton(content);
					} else if (t.dataset.rbGotoObject) {
						const obj = t.dataset.rbGotoObject;
						if (obj === _state.objectName) {
							return;
						}
						const picker = content.querySelector('.rb-object-picker');
						if (picker) {
							picker.value = obj;
							picker.dispatchEvent(new Event('change', { bubbles: true }));
						}
					}
				});

				const overlay = content.closest('.record-browse-modal');
				const loadBtn = overlay && overlay.querySelector('.rb-load-btn');
				if (loadBtn) {
					loadBtn.addEventListener('click', async () => {
						const entries = _basketEntries();
						const basketTotal = _basketTotal();
						const originalLabel = loadBtn.textContent;
						const statusEl = content.querySelector('.rb-count');
						const showErr = (msg) => {
							loadBtn.disabled = false;
							loadBtn.textContent = originalLabel;
							if (statusEl) {
								statusEl.classList.add('rb-count-error');
								statusEl.textContent = msg;
							}
						};
						let jobs;
						if (basketTotal > 0) {
							try {
								jobs = entries.map((e) => ({
									objectName: e.objectName,
									count: e.count,
									soql:
										'SELECT Id FROM ' +
										e.objectName +
										' WHERE Id IN (' +
										_salesforceIdInList(e.ids) +
										')',
								}));
							} catch (error) {
								showErr(
									error && error.message
										? error.message
										: 'Browse selection contains an invalid record ID.',
								);
								return;
							}
						} else {
							if (!_state.lastResult || !_state.lastResult.loadSoql) {
								return;
							}
							jobs = [
								{
									objectName: _state.objectName,
									count:
										typeof _state.lastResult.loadableCount === 'number'
											? _state.lastResult.loadableCount
											: _state.lastResult.count || 0,
									soql: _state.lastResult.loadSoql,
								},
							];
						}
						const attempt = jobs.reduce((sum, j) => sum + j.count, 0);
						const cap = canvasCapCheck(attempt);
						if (cap.blocked) {
							showErr(cap.reason || 'Canvas is at the record limit.');
							showBulkToast(cap.reason || 'Canvas is at the record limit.', 'error');
							return;
						}
						loadBtn.disabled = true;
						loadBtn.textContent = 'Loading…';
						const _undo = captureUndoSnapshot ? captureUndoSnapshot() : null;
						let added = 0;
						let skipped = 0;
						try {
							for (const job of jobs) {
								const summary = await runAndCommitSoql(job.soql, { knownTotal: job.count });
								if (summary.blocked) {
									const rolledBack = added > 0 && _undo;
									if (rolledBack) {
										_undo();
									}
									const reason = summary.capReason || 'Canvas is at the record limit.';
									const msg =
										reason +
										(rolledBack
											? ' (rolled back the ' +
												added +
												' record' +
												(added === 1 ? '' : 's') +
												' already added; nothing changed).'
											: '');
									showErr(msg);
									showBulkToast(msg, 'error');
									return;
								}
								added += summary.added || 0;
								skipped += summary.skipped || 0;
							}
						} catch (err) {
							const rolledBack = added > 0 && _undo;
							if (rolledBack) {
								_undo();
							}
							const _msg =
								'Load failed: ' +
								(err.message || String(err)) +
								(rolledBack
									? ' (rolled back the ' +
										added +
										' record' +
										(added === 1 ? '' : 's') +
										' already added; nothing changed).'
									: '');
							_shared.captureImportFailure('browse', 'load');
							showErr(_msg);
							showBulkToast(_msg, 'error');
							return;
						}
						if (pingAuditEvent && (added > 0 || skipped > 0)) {
							pingAuditEvent('canvas_browse_load', {
								recordCount: added,
								payload: {
									objects: jobs.map((j) => j.objectName),
									added,
									skipped,
									mode: basketTotal > 0 ? 'basket' : 'all-matches',
								},
							});
						}
						const objCount = jobs.length;
						const acrossNote = objCount > 1 ? ' across ' + objCount + ' objects' : '';
						const skippedNote = skipped > 0 ? ' · ' + skipped + ' already on canvas (skipped)' : '';
						if (added === 0 && skipped > 0) {
							showBulkToast(
								'All ' +
									skipped +
									' record' +
									(skipped === 1 ? '' : 's') +
									' from your selection are already on the canvas.',
							);
						} else if (added === 0) {
							showBulkToast('Nothing to add.');
						} else {
							const _msg =
								'Added ' +
								added +
								' record' +
								(added === 1 ? '' : 's') +
								acrossNote +
								' from Browse.' +
								skippedNote;
							if (_undo && showBulkToastWithAction) {
								showBulkToastWithAction(_msg, 'Undo', _undo);
							} else {
								showBulkToast(_msg);
							}
						}
						_state.basket.clear();
						overlay.remove();
					});
				}
			}

			function openBrowseModal(initialObjectName) {
				document.querySelectorAll('.record-browse-modal').forEach((el) => el.remove());
				_state = _newState(initialObjectName);
				const overlay = document.createElement('div');
				overlay.className = 'modal record-browse-modal';
				overlay.innerHTML =
					'<div class="modal-overlay" data-rb-close></div>' +
					'<div class="modal-body" style="max-width:880px">' +
					'<div class="modal-header">' +
					'<h3>Browse records</h3>' +
					'<button class="modal-close" data-rb-close>&times;</button>' +
					'</div>' +
					'<div class="modal-content rb-content">' +
					'<div class="rb-toolbar">' +
					'<label class="rb-label" for="rb-object-picker">Object</label>' +
					'<select id="rb-object-picker" class="rb-object-picker"><option value="">Loading objects…</option></select>' +
					'</div>' +
					'<div class="rb-toolbar">' +
					'<label class="rb-label" for="rb-search">Search</label>' +
					'<input id="rb-search" type="search" class="rb-search" placeholder="Name or record ID" maxlength="200" autocomplete="off" disabled>' +
					'</div>' +
					'<div class="rb-filters"></div>' +
					'<div class="rb-results-head">' +
					'<span class="rb-count"></span>' +
					'<span class="rb-page-info"></span>' +
					'</div>' +
					'<div class="rb-selection-summary"></div>' +
					'<div class="rb-preview"></div>' +
					'</div>' +
					'<div class="modal-footer">' +
					'<button class="button secondary" data-rb-close>Cancel</button>' +
					'<button class="button rb-load-btn" disabled>Load to canvas</button>' +
					'</div>' +
					'</div>';
				document.body.appendChild(overlay);
				const content = overlay.querySelector('.rb-content');
				const cleanup = () => {
					document.removeEventListener('keydown', onEsc, true);
					if (_fetchTimer) {
						clearTimeout(_fetchTimer);
						_fetchTimer = null;
					}
					if (overlay.parentNode) {
						overlay.remove();
					}
				};
				const onEsc = (e) => {
					if (e.key === 'Escape') {
						cleanup();
					}
				};
				document.addEventListener('keydown', onEsc, true);
				overlay.querySelectorAll('[data-rb-close]').forEach((el) => el.addEventListener('click', cleanup));

				_renderBody(content);
				_wireBodyHandlers(content);

				if (initialObjectName) {
					ensureDescribe(initialObjectName)
						.then(() => {
							_renderBody(content);
							_scheduleFetch(content);
						})
						.catch(() => {});
				}
			}

			return {
				openBrowseModal: openBrowseModal,
			};
		},
	};
})();

(function () {
	'use strict';
	// Compares records field-by-field while excluding Salesforce compound container artifacts.

	window.OrgLoom = window.OrgLoom || {};

	function _isCompoundContainerField(field) {
		return !!field && (field.type === 'address' || field.type === 'location');
	}

	function _filterComparableDiff(diff, fieldDefForA, fieldDefForB) {
		// Compare component fields; compound address/location containers duplicate structured values.
		function keep(fieldName) {
			return (
				!_isCompoundContainerField(fieldDefForA(fieldName)) &&
				!_isCompoundContainerField(fieldDefForB(fieldName))
			);
		}
		return Object.assign({}, diff, {
			shared: diff.shared.filter(keep),
			differing: diff.differing.filter(keep),
			aOnly: diff.aOnly.filter(keep),
			bOnly: diff.bOnly.filter(keep),
		});
	}

	window.OrgLoom.recordDiffModal = {
		filterComparableDiff: _filterComparableDiff,
		mount: function mount(deps) {
			const required = ['canvasState', 'escapeHtml', 'computeRecordDiff', 'recordOrdinal', 'renderBulkView'];
			if (!deps) {
				throw new Error('record-diff-modal.mount: missing deps object');
			}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('record-diff-modal.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const escapeHtml = deps.escapeHtml;
			const computeRecordDiff = deps.computeRecordDiff;
			const recordOrdinal = deps.recordOrdinal;
			const renderBulkView = deps.renderBulkView;
			const pushUndo = typeof deps.pushUndo === 'function' ? deps.pushUndo : null;
			const showBulkToast = typeof deps.showBulkToast === 'function' ? deps.showBulkToast : function () {};

			function _snapField(rec, fieldName) {
				const had = !!(rec.values && Object.prototype.hasOwnProperty.call(rec.values, fieldName));
				return { had: had, prev: had ? rec.values[fieldName] : undefined };
			}
			function _restoreField(rec, fieldName, snap) {
				if (!rec.values) {
					rec.values = {};
				}
				if (snap.had) {
					rec.values[fieldName] = snap.prev;
				} else {
					delete rec.values[fieldName];
				}
				rec._valuesRevision = (Number(rec._valuesRevision) || 0) + 1;
			}
			function _writeField(rec, fieldName, value) {
				rec.values[fieldName] = value;
				rec._valuesRevision = (Number(rec._valuesRevision) || 0) + 1;
			}
			function _fieldUndoIsCurrent(rec, revision, fieldName, expected) {
				// Refuse undo after any subsequent edit to avoid overwriting newer user work.
				return (
					(Number(rec._valuesRevision) || 0) === revision && rec.values && rec.values[fieldName] === expected
				);
			}

			function _pairKey(idA, idB) {
				const a = Number(idA),
					b = Number(idB);
				return a < b ? a + '|' + b : b + '|' + a;
			}
			function _readSuppressedSet(idA, idB) {
				const store = canvasState.diffSuppressions || {};
				const arr = store[_pairKey(idA, idB)];
				return new Set(Array.isArray(arr) ? arr : []);
			}
			function _writeSuppressedSet(idA, idB, set) {
				// Ignore choices are scoped to this unordered record pair, not the underlying field globally.
				if (!canvasState.diffSuppressions) {
					canvasState.diffSuppressions = {};
				}
				const key = _pairKey(idA, idB);
				if (set.size === 0) {
					delete canvasState.diffSuppressions[key];
				} else {
					canvasState.diffSuppressions[key] = Array.from(set);
				}
			}
			function _suppressField(idA, idB, fieldName) {
				const set = _readSuppressedSet(idA, idB);
				set.add(fieldName);
				_writeSuppressedSet(idA, idB, set);
			}
			function _unsuppressField(idA, idB, fieldName) {
				const set = _readSuppressedSet(idA, idB);
				set.delete(fieldName);
				_writeSuppressedSet(idA, idB, set);
			}

			function _titleFor(rec) {
				if (!rec) {
					return '(missing record)';
				}
				if (rec._inaccessible) {
					return 'No access';
				}
				if (rec.values) {
					const fn = rec.values.FirstName,
						ln = rec.values.LastName;
					if (fn != null || ln != null) {
						const composed = ((fn || '') + ' ' + (ln || '')).trim();
						if (composed) {
							return composed;
						}
					}
					const desc = canvasState.describeCache[rec.objectName];
					if (desc && Array.isArray(desc.fields)) {
						const nf = desc.fields.find((f) => f.nameField);
						if (nf && rec.values[nf.name]) {
							return String(rec.values[nf.name]);
						}
					}
					const generic = rec.values.Name || rec.values.CaseNumber || rec.values.Subject || rec.values.Title;
					if (generic) {
						return String(generic);
					}
				}
				return rec.loadedFromId ? '(no title)' : '(no name yet)';
			}

			function _fieldLabel(objectName, fieldName) {
				const desc = objectName && canvasState.describeCache[objectName];
				if (desc && Array.isArray(desc.fields)) {
					const f = desc.fields.find((x) => x && x.name === fieldName);
					if (f && f.label) {
						return f.label;
					}
				}
				return fieldName;
			}
			function _fieldDef(objectName, fieldName) {
				const desc = objectName && canvasState.describeCache[objectName];
				if (!desc || !Array.isArray(desc.fields)) {
					return null;
				}
				return desc.fields.find((x) => x && x.name === fieldName) || null;
			}

			function _isFieldWritable(field, targetRec) {
				if (!field) {
					return true;
				}
				if (_isCompoundContainerField(field)) {
					return false;
				}
				if (field.calculated || field.autoNumber) {
					return false;
				}
				if (targetRec && targetRec.loadedFromId) {
					return field.updateable !== false;
				}
				return field.createable !== false;
			}

			function _isEmptyValue(value) {
				return value == null || (typeof value === 'string' && value.trim() === '');
			}

			function _canClearField(field) {
				return !field || (field.nillable !== false && field.required !== true);
			}

			function _buildFkResolver() {
				const m = new Map();
				for (const r of canvasState.bulkRecords) {
					if (!r || !r.loadedFromId) {
						continue;
					}
					const key = String(r.loadedFromId).slice(0, 15);
					m.set(key, _titleFor(r));
				}
				return m;
			}

			function _renderTypedValue(v, fieldDef, fkResolver) {
				if (v == null || v === '') {
					return '<span class="rdm-empty">—</span>';
				}
				const type = fieldDef && fieldDef.type;
				if ((type === 'picklist' || type === 'combobox') && Array.isArray(fieldDef.picklistValues)) {
					const p = fieldDef.picklistValues.find((x) => x && x.value === v);
					if (p && p.label && p.label !== p.value) {
						return (
							escapeHtml(p.label) + ' <code class="rdm-val-suffix">' + escapeHtml(String(v)) + '</code>'
						);
					}
				}
				if (type === 'multipicklist' && Array.isArray(fieldDef.picklistValues)) {
					const parts = String(v)
						.split(';')
						.map((s) => s.trim())
						.filter(Boolean);
					const labels = parts.map((part) => {
						const p = fieldDef.picklistValues.find((x) => x && x.value === part);
						return p && p.label ? p.label : part;
					});
					return escapeHtml(labels.join(' · '));
				}
				if (type === 'reference' && fkResolver) {
					const key = String(v).slice(0, 15);
					const title = fkResolver.get(key);
					if (title) {
						return escapeHtml(title) + ' <code class="rdm-val-suffix">' + escapeHtml(String(v)) + '</code>';
					}
					return '<code>' + escapeHtml(String(v)) + '</code>';
				}
				if (type === 'boolean' || typeof v === 'boolean') {
					const b = v === true || v === 'true' || v === 1 || v === '1';
					return b ? '<span class="rdm-val-bool">Yes</span>' : '<span class="rdm-val-bool">No</span>';
				}
				if (type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
					const t = Date.parse(v);
					if (!isNaN(t)) {
						const d = new Date(t);
						return escapeHtml(d.toLocaleDateString());
					}
				}
				if (type === 'datetime' && typeof v === 'string') {
					const api = window.OrgLoom && window.OrgLoom.datetime;
					if (api && typeof api.formatDateTime === 'function') {
						return escapeHtml(api.formatDateTime(v));
					}
				}
				if (typeof v === 'string') {
					return escapeHtml(v);
				}
				if (typeof v === 'number') {
					return escapeHtml(String(v));
				}
				try {
					return '<code>' + escapeHtml(JSON.stringify(v)) + '</code>';
				} catch (_) {
					return '<code>(unserializable)</code>';
				}
			}

			function _renderRow(fieldName, recA, recB, variant, ctx) {
				const objectName = recA.objectName || recB.objectName;
				const label = _fieldLabel(objectName, fieldName);
				const a = recA && recA.values ? recA.values[fieldName] : undefined;
				const b = recB && recB.values ? recB.values[fieldName] : undefined;
				const isResolvable = variant === 'diff' || variant === 'a-only' || variant === 'b-only';
				const isSuppressed = variant === 'suppressed';

				const fieldDefForA = ctx.fieldDefForA(fieldName);
				const fieldDefForB = ctx.fieldDefForB(fieldName);
				const aIsWritable = _isFieldWritable(fieldDefForA, recA);
				const bIsWritable = _isFieldWritable(fieldDefForB, recB);
				const readOnlyReason = (def) => {
					if (!def) {
						return '';
					}
					if (def.calculated) {
						return 'formula';
					}
					if (def.autoNumber) {
						return 'auto-number';
					}
					return 'read-only';
				};

				let leftBtn = ''; // ◀ copies B → A
				if (isResolvable) {
					if (!ctx.aIsTargetable) {
						leftBtn =
							'<button type="button" class="rdm-copy-btn rdm-copy-btn-left" disabled aria-disabled="true" title="The left record cannot receive values">◀</button>';
					} else if (!aIsWritable) {
						leftBtn =
							'<button type="button" class="rdm-copy-btn rdm-copy-btn-left" disabled aria-disabled="true" title="Field is ' +
							readOnlyReason(fieldDefForA) +
							' on the left record, so Salesforce won’t accept the write">◀</button>';
					} else if (_isEmptyValue(b) && !_canClearField(fieldDefForA)) {
						leftBtn =
							'<button type="button" class="rdm-copy-btn rdm-copy-btn-left" disabled aria-disabled="true" aria-label="Cannot clear a required field on the left record">◀</button>';
					} else {
						leftBtn =
							'<button type="button" class="rdm-copy-btn rdm-copy-btn-left" data-rdm-copy="b-to-a" data-rdm-field="' +
							escapeHtml(fieldName) +
							'" aria-label="Copy this value to the left record"' +
							(_isEmptyValue(b) ? '' : ' title="Copy this value to the left record"') +
							'>◀</button>';
					}
				}
				let rightBtn = ''; // ▶ copies A → B
				if (!ctx.incoming && isResolvable) {
					if (!ctx.bIsTargetable) {
						rightBtn =
							'<button type="button" class="rdm-copy-btn rdm-copy-btn-right" disabled aria-disabled="true" title="The right record cannot receive values">▶</button>';
					} else if (!bIsWritable) {
						rightBtn =
							'<button type="button" class="rdm-copy-btn rdm-copy-btn-right" disabled aria-disabled="true" title="Field is ' +
							readOnlyReason(fieldDefForB) +
							' on the right record, so Salesforce won’t accept the write">▶</button>';
					} else if (_isEmptyValue(a) && !_canClearField(fieldDefForB)) {
						rightBtn =
							'<button type="button" class="rdm-copy-btn rdm-copy-btn-right" disabled aria-disabled="true" aria-label="Cannot clear a required field on the right record">▶</button>';
					} else {
						rightBtn =
							'<button type="button" class="rdm-copy-btn rdm-copy-btn-right" data-rdm-copy="a-to-b" data-rdm-field="' +
							escapeHtml(fieldName) +
							'" aria-label="Copy this value to the right record"' +
							(_isEmptyValue(a) ? '' : ' title="Copy this value to the right record"') +
							'>▶</button>';
					}
				}
				const midActionsContent =
					leftBtn || rightBtn
						? '<div class="rdm-mid-actions">' + leftBtn + rightBtn + '</div>'
						: '<div class="rdm-mid-actions rdm-mid-actions-empty"></div>';

				const rowAction = ctx.incoming
					? ''
					: isResolvable
						? '<button type="button" class="rdm-ignore-btn" data-rdm-ignore data-rdm-field="' +
							escapeHtml(fieldName) +
							'" title="Ignore this field: stop flagging it as a difference for this pair">⊘</button>'
						: isSuppressed
							? '<button type="button" class="rdm-restore-btn" data-rdm-restore data-rdm-field="' +
								escapeHtml(fieldName) +
								'" title="Restore: flag this field as a difference again">↶</button>'
							: '';
				const rowActionsContent = rowAction
					? '<div class="rdm-row-actions">' + rowAction + '</div>'
					: '<div class="rdm-row-actions rdm-row-actions-empty"></div>';

				let readOnlyBadge = '';
				if (isResolvable && (!aIsWritable || !bIsWritable)) {
					const tag =
						!aIsWritable && !bIsWritable
							? 'read-only'
							: !aIsWritable
								? 'read-only on left'
								: 'read-only on right';
					readOnlyBadge =
						'<span class="rdm-readonly-badge" title="Salesforce won’t accept writes to this field on the marked side(s)">' +
						escapeHtml(tag) +
						'</span>';
				}

				const searchKey = (label + ' ' + fieldName).toLowerCase();

				return (
					'<div class="rdm-row rdm-row-' +
					variant +
					'" data-rdm-row-field="' +
					escapeHtml(fieldName) +
					'" data-rdm-search-key="' +
					escapeHtml(searchKey) +
					'">' +
					'<div class="rdm-field">' +
					'<div class="rdm-field-text">' +
					'<div class="rdm-field-label" title="API name: ' +
					escapeHtml(fieldName) +
					'">' +
					escapeHtml(label) +
					readOnlyBadge +
					'</div>' +
					'</div>' +
					'</div>' +
					'<div class="rdm-value rdm-value-a">' +
					'<div class="rdm-value-inner">' +
					_renderTypedValue(a, fieldDefForA, ctx.fkResolver) +
					'</div>' +
					'</div>' +
					midActionsContent +
					'<div class="rdm-value rdm-value-b">' +
					'<div class="rdm-value-inner">' +
					_renderTypedValue(b, fieldDefForB, ctx.fkResolver) +
					'</div>' +
					'</div>' +
					rowActionsContent +
					'</div>'
				);
			}

			function _renderBody(content, recA, recB) {
				const previousTable = content && content.querySelector('.rdm-table');
				const scroll = previousTable ? previousTable.scrollTop : 0;
				const overlay = content && content.closest('.record-diff-modal');
				const incoming = !!(overlay && overlay.dataset.rdmIncoming === '1');
				const labelB = (overlay && overlay.dataset.rdmLabelB) || 'Imported';
				const existingSearch = overlay && overlay.querySelector('.rdm-search');
				const searchQuery = existingSearch ? existingSearch.value : '';
				const titleA = _titleFor(recA);
				const titleB = _titleFor(recB);
				const subtitleA = (recA.label || recA.objectName) + ' #' + recordOrdinal(recA);
				const subtitleB = incoming ? labelB : (recB.label || recB.objectName) + ' #' + recordOrdinal(recB);
				const fkResolver = _buildFkResolver();
				const fieldDefForA = (name) => _fieldDef(recA.objectName, name);
				const fieldDefForB = (name) => _fieldDef(recB.objectName, name);
				const diff = _filterComparableDiff(computeRecordDiff(recA, recB), fieldDefForA, fieldDefForB);

				const suppressedSet = _readSuppressedSet(recA.id, recB.id);
				function _partitionBySuppressed(arr) {
					const kept = [];
					const suppressed = [];
					for (const f of arr) {
						if (suppressedSet.has(f)) {
							suppressed.push(f);
						} else {
							kept.push(f);
						}
					}
					return { kept, suppressed };
				}
				const _pDiff = _partitionBySuppressed(diff.differing);
				const _pAOnly = _partitionBySuppressed(diff.aOnly);
				const _pBOnly = _partitionBySuppressed(diff.bOnly);
				const differing = _pDiff.kept;
				const aOnly = incoming ? [] : _pAOnly.kept;
				const bOnly = _pBOnly.kept;
				const suppressed = _pDiff.suppressed.concat(_pAOnly.suppressed).concat(_pBOnly.suppressed);
				const diffCount = differing.length;
				const aOnlyCount = aOnly.length;
				const bOnlyCount = bOnly.length;
				const sharedCount = diff.shared.length;
				const suppressedCount = suppressed.length;
				const aIsTargetable = !recA._inaccessible;
				const bIsTargetable = !recB._inaccessible;
				const rowCtx = {
					fieldDefForA,
					fieldDefForB,
					fkResolver,
					aIsTargetable,
					bIsTargetable,
					incoming,
				};

				const filterChips =
					'<div class="rdm-filter-chips">' +
					'<button type="button" class="rdm-filter-chip" data-rdm-filter="diffs">' +
					'Only differences ' +
					'<span class="rdm-chip-count">' +
					(diffCount + aOnlyCount + bOnlyCount) +
					'</span>' +
					'</button>' +
					'<button type="button" class="rdm-filter-chip" data-rdm-filter="all">' +
					'All ' +
					'<span class="rdm-chip-count">' +
					(diffCount + aOnlyCount + bOnlyCount + sharedCount + suppressedCount) +
					'</span>' +
					'</button>' +
					(suppressedCount > 0
						? '<button type="button" class="rdm-filter-chip" data-rdm-filter="suppressed">' +
							'Ignored ' +
							'<span class="rdm-chip-count">' +
							suppressedCount +
							'</span>' +
							'</button>'
						: '') +
					'</div>';

				const _isWritableTo = (fieldName, targetRec, getFieldDef) =>
					_isFieldWritable(getFieldDef(fieldName), targetRec);
				const aToBCount =
					differing.filter((f) => _isWritableTo(f, recB, fieldDefForB)).length +
					aOnly.filter((f) => _isWritableTo(f, recB, fieldDefForB)).length;
				const bToACount =
					differing.filter((f) => _isWritableTo(f, recA, fieldDefForA)).length +
					bOnly.filter((f) => _isWritableTo(f, recA, fieldDefForA)).length;
				const aToBDisabled = aToBCount === 0 || !bIsTargetable;
				const bToADisabled = bToACount === 0 || !aIsTargetable;
				const aToBTitle = !bIsTargetable
					? 'The right record cannot receive values'
					: aToBCount === 0
						? 'No values to copy to the right record'
						: 'Copy all ' +
							aToBCount +
							' values to the right record: ' +
							titleB +
							'. Replaces differing values and fills blanks.';
				const bToATitle = !aIsTargetable
					? 'The left record cannot receive values'
					: bToACount === 0
						? 'No values to copy to the left record'
						: 'Copy all ' +
							bToACount +
							' values to the left record: ' +
							titleA +
							'. Replaces differing values and fills blanks.';
				const bulkActions =
					'<div class="rdm-header-copy">' +
					'<button type="button" class="rdm-bulk-btn" data-rdm-bulk="b-to-a"' +
					(bToADisabled ? ' disabled aria-disabled="true"' : '') +
					' title="' +
					escapeHtml(bToATitle) +
					'" aria-label="' +
					escapeHtml(bToATitle) +
					'">◀</button>' +
					(incoming
						? ''
						: '<button type="button" class="rdm-bulk-btn" data-rdm-bulk="a-to-b"' +
							(aToBDisabled ? ' disabled aria-disabled="true"' : '') +
							' title="' +
							escapeHtml(aToBTitle) +
							'" aria-label="' +
							escapeHtml(aToBTitle) +
							'">▶</button>') +
					'</div>';

				const rowsHtml =
					differing.map((f) => _renderRow(f, recA, recB, 'diff', rowCtx)).join('') +
					aOnly.map((f) => _renderRow(f, recA, recB, 'a-only', rowCtx)).join('') +
					bOnly.map((f) => _renderRow(f, recA, recB, 'b-only', rowCtx)).join('') +
					suppressed.map((f) => _renderRow(f, recA, recB, 'suppressed', rowCtx)).join('') +
					diff.shared.map((f) => _renderRow(f, recA, recB, 'shared', rowCtx)).join('');

				const totalRows = diffCount + aOnlyCount + bOnlyCount + suppressedCount + sharedCount;
				const emptyState =
					totalRows === 0
						? '<p class="rdm-empty-state">No fields with values on either record. There’s nothing to diff yet.</p>'
						: diffCount + aOnlyCount + bOnlyCount === 0
							? suppressedCount > 0
								? '<p class="rdm-empty-state">These records agree on every field that isn’t ignored. ' +
									suppressedCount +
									' field' +
									(suppressedCount === 1 ? '' : 's') +
									' marked as intentionally different.</p>'
								: '<p class="rdm-empty-state">These records are identical on every field they share.</p>'
							: '';

				const tableHead =
					'<div class="rdm-table-head">' +
					'<div class="rdm-th rdm-th-field">' +
					'<div class="rdm-th-title">Field</div>' +
					'</div>' +
					'<div class="rdm-th rdm-th-a">' +
					'<div class="rdm-th-title">' +
					escapeHtml(titleA) +
					'</div>' +
					'<div class="rdm-th-sub">' +
					escapeHtml(subtitleA) +
					'</div>' +
					'</div>' +
					'<div class="rdm-th rdm-th-mid">' +
					bulkActions +
					'</div>' +
					'<div class="rdm-th rdm-th-b">' +
					'<div class="rdm-th-title">' +
					escapeHtml(titleB) +
					'</div>' +
					'<div class="rdm-th-sub">' +
					escapeHtml(subtitleB) +
					'</div>' +
					'</div>' +
					'<div class="rdm-th rdm-th-row-actions"></div>' +
					'</div>';

				const incomingBanner = incoming
					? '<div class="rdm-banner">' +
						'<strong>This imported row matches a record already on the canvas.</strong> ' +
						'Imported CSV values are on the right; the canvas record is on the left. ' +
						'Use a row’s ◀ to copy one value, or the header’s ◀ to copy all eligible values onto the canvas record. ' +
						'Closing without copying keeps the canvas record unchanged.' +
						'</div>'
					: '';
				content.innerHTML =
					incomingBanner +
					'<div class="rdm-toolbar">' +
					filterChips +
					'<input type="search" class="rdm-search" placeholder="Search fields…" autocomplete="off" spellcheck="false" value="' +
					escapeHtml(searchQuery || '') +
					'">' +
					'</div>' +
					(emptyState
						? emptyState
						: '<div class="rdm-table">' +
							tableHead +
							'<div class="rdm-rows">' +
							rowsHtml +
							'</div></div>') +
					'<p class="rdm-search-empty" style="display:none">No fields match your search.</p>';

				const table = content.querySelector('.rdm-table');
				if (table) {
					table.scrollTop = scroll;
				}
			}

			function _applyCopy(side, fieldName, recA, recB, content) {
				const source = side === 'a-to-b' ? recA : recB;
				const target = side === 'a-to-b' ? recB : recA;
				if (!source || !target) {
					return;
				}
				if (target._inaccessible) {
					return;
				}
				if (!target.values) {
					target.values = {};
				}
				const newValue = source.values ? source.values[fieldName] : undefined;
				const targetField = _fieldDef(target.objectName, fieldName);
				if (
					!_isFieldWritable(targetField, target) ||
					(_isEmptyValue(newValue) && !_canClearField(targetField))
				) {
					return;
				}
				const _snap = pushUndo ? _snapField(target, fieldName) : null;
				_writeField(target, fieldName, _isEmptyValue(newValue) ? '' : newValue);
				if (pushUndo && _snap) {
					const _tgt = target,
						_fn = fieldName,
						_s = _snap;
					const _expectedRevision = Number(target._valuesRevision) || 0;
					const _expectedValue = target.values[fieldName];
					pushUndo('Undo diff copy', () => {
						if (!_fieldUndoIsCurrent(_tgt, _expectedRevision, _fn, _expectedValue)) {
							showBulkToast(
								'Can’t undo the diff copy because the target record was edited afterward.',
								'info',
							);
							return;
						}
						_restoreField(_tgt, _fn, _s);
						renderBulkView();
						showBulkToast('Reverted the copied field.');
					});
				}
				try {
					renderBulkView();
				} catch (e) {
					console.warn('[diff] renderBulkView after copy failed:', e);
				}
				_renderBody(content, recA, recB);
				_wireBodyHandlers(content, recA, recB);
			}

			function _applyBulkCopy(direction, recA, recB, content) {
				const source = direction === 'a-to-b' ? recA : recB;
				const target = direction === 'a-to-b' ? recB : recA;
				if (!source || !target) {
					return;
				}
				if (target._inaccessible) {
					return;
				}
				const diff = _filterComparableDiff(
					computeRecordDiff(recA, recB),
					(name) => _fieldDef(recA.objectName, name),
					(name) => _fieldDef(recB.objectName, name),
				);
				const suppressedSet = _readSuppressedSet(recA.id, recB.id);
				const eligible = [];
				const getTargetFieldDef = (name) => _fieldDef(target.objectName, name);
				for (const f of diff.differing) {
					if (suppressedSet.has(f)) {
						continue;
					}
					if (!_isFieldWritable(getTargetFieldDef(f), target)) {
						continue;
					}
					eligible.push(f);
				}
				for (const f of direction === 'a-to-b' ? diff.aOnly : diff.bOnly) {
					if (suppressedSet.has(f)) {
						continue;
					}
					if (!_isFieldWritable(getTargetFieldDef(f), target)) {
						continue;
					}
					eligible.push(f);
				}
				if (eligible.length === 0) {
					return;
				}
				if (!target.values) {
					target.values = {};
				}
				const _snaps = pushUndo ? eligible.map((f) => ({ f: f, snap: _snapField(target, f) })) : null;
				for (const f of eligible) {
					const v = source.values ? source.values[f] : undefined;
					_writeField(target, f, v == null ? '' : v);
				}
				if (pushUndo && _snaps) {
					const _tgt = target,
						_all = _snaps,
						_n = eligible.length;
					const _expectedRevision = Number(target._valuesRevision) || 0;
					const _expectedValues = new Map(eligible.map((f) => [f, target.values[f]]));
					pushUndo('Undo diff apply-all', () => {
						const stale =
							(Number(_tgt._valuesRevision) || 0) !== _expectedRevision ||
							eligible.some((f) => !_tgt.values || _tgt.values[f] !== _expectedValues.get(f));
						if (stale) {
							showBulkToast(
								'Can’t undo the diff copy because the target record was edited afterward.',
								'info',
							);
							return;
						}
						_all.forEach((e) => _restoreField(_tgt, e.f, e.snap));
						renderBulkView();
						showBulkToast('Reverted ' + _n + ' copied field' + (_n === 1 ? '' : 's') + '.');
					});
				}
				try {
					renderBulkView();
				} catch (e) {
					console.warn('[diff] renderBulkView after bulk copy failed:', e);
				}
				_renderBody(content, recA, recB);
				_wireBodyHandlers(content, recA, recB);
			}

			function _applyIgnore(fieldName, recA, recB, content) {
				_suppressField(recA.id, recB.id, fieldName);
				_renderBody(content, recA, recB);
				_wireBodyHandlers(content, recA, recB);
			}
			function _applyRestore(fieldName, recA, recB, content) {
				_unsuppressField(recA.id, recB.id, fieldName);
				_renderBody(content, recA, recB);
				_wireBodyHandlers(content, recA, recB);
			}

			function _applySearchFilter(content, query) {
				const q = String(query || '')
					.trim()
					.toLowerCase();
				const rowsContainer = content.querySelector('.rdm-rows');
				const emptyMsg = content.querySelector('.rdm-search-empty');
				let anyVisible = false;
				content.querySelectorAll('.rdm-row').forEach((row) => {
					if (!q) {
						row.classList.remove('rdm-row-hidden-by-search');
						anyVisible = true;
						return;
					}
					const key = row.dataset.rdmSearchKey || '';
					if (key.indexOf(q) !== -1) {
						row.classList.remove('rdm-row-hidden-by-search');
						anyVisible = true;
					} else {
						row.classList.add('rdm-row-hidden-by-search');
					}
				});
				if (emptyMsg && rowsContainer) {
					if (!q || anyVisible) {
						emptyMsg.style.display = 'none';
						rowsContainer.style.display = '';
					} else {
						emptyMsg.style.display = '';
						rowsContainer.style.display = 'none';
					}
				}
			}

			function _wireBodyHandlers(content, recA, recB) {
				const overlay = content.closest('.record-diff-modal');
				if (!overlay) {
					return;
				}
				const activeFilter = overlay.dataset.rdmFilter || 'diffs';
				content.querySelectorAll('[data-rdm-filter]').forEach((btn) => {
					btn.classList.toggle('is-active', btn.dataset.rdmFilter === activeFilter);
					btn.addEventListener('click', () => {
						overlay.dataset.rdmFilter = btn.dataset.rdmFilter;
						content.querySelectorAll('.rdm-filter-chip').forEach((c) => {
							c.classList.toggle('is-active', c.dataset.rdmFilter === btn.dataset.rdmFilter);
						});
					});
				});
				content.querySelectorAll('[data-rdm-copy]').forEach((btn) => {
					if (btn.disabled) {
						return;
					}
					btn.addEventListener('click', () => {
						const side = btn.dataset.rdmCopy;
						const fieldName = btn.dataset.rdmField;
						if (!side || !fieldName) {
							return;
						}
						_applyCopy(side, fieldName, recA, recB, content);
					});
				});
				content.querySelectorAll('[data-rdm-ignore]').forEach((btn) => {
					btn.addEventListener('click', () => {
						const fieldName = btn.dataset.rdmField;
						if (!fieldName) {
							return;
						}
						_applyIgnore(fieldName, recA, recB, content);
					});
				});
				content.querySelectorAll('[data-rdm-restore]').forEach((btn) => {
					btn.addEventListener('click', () => {
						const fieldName = btn.dataset.rdmField;
						if (!fieldName) {
							return;
						}
						_applyRestore(fieldName, recA, recB, content);
					});
				});
				content.querySelectorAll('[data-rdm-bulk]').forEach((btn) => {
					if (btn.disabled) {
						return;
					}
					btn.addEventListener('click', () => {
						const direction = btn.dataset.rdmBulk;
						if (!direction) {
							return;
						}
						_applyBulkCopy(direction, recA, recB, content);
					});
				});
				const searchInput = content.querySelector('.rdm-search');
				if (searchInput) {
					searchInput.addEventListener('input', () => {
						_applySearchFilter(content, searchInput.value);
					});
					_applySearchFilter(content, searchInput.value);
				}
			}

			function openRecordDiffModal(recA, recB, opts) {
				if (!recA || !recB) {
					return;
				}
				if (recA.objectName !== recB.objectName) {
					showBulkToast('Choose two records of the same object type.');
					return;
				}
				opts = opts || {};
				const incoming = !!opts.incoming;
				document.querySelectorAll('.record-diff-modal').forEach((el) => el.remove());
				const overlay = document.createElement('div');
				overlay.className = 'modal record-diff-modal';
				overlay.dataset.rdmFilter = 'diffs';
				if (incoming) {
					overlay.dataset.rdmIncoming = '1';
					overlay.dataset.rdmLabelB = opts.labelB || 'Imported';
				}
				const heading = incoming ? 'Review imported changes' : 'Diff records';
				overlay.innerHTML =
					'<div class="modal-overlay" data-rdm-close></div>' +
					'<div class="modal-body" style="max-width:960px">' +
					'<div class="modal-header">' +
					'<h3>' +
					escapeHtml(heading) +
					'</h3>' +
					'<button class="modal-close" data-rdm-close>&times;</button>' +
					'</div>' +
					'<div class="modal-content rdm-content"></div>' +
					'</div>';
				document.body.appendChild(overlay);
				const content = overlay.querySelector('.rdm-content');

				let closed = false;
				const onEsc = (e) => {
					if (e.key === 'Escape') {
						cleanup();
					}
				};
				const cleanup = () => {
					if (closed) {
						return;
					}
					closed = true;
					document.removeEventListener('keydown', onEsc, true);
					if (overlay.parentNode) {
						overlay.remove();
					}
					if (typeof opts.onClose === 'function') {
						try {
							opts.onClose();
						} catch (e) {
							console.warn('[diff] onClose failed:', e);
						}
					}
				};
				document.addEventListener('keydown', onEsc, true);
				overlay.querySelectorAll('[data-rdm-close]').forEach((el) => el.addEventListener('click', cleanup));

				_renderBody(content, recA, recB);
				_wireBodyHandlers(content, recA, recB);
			}

			return {
				openRecordDiffModal: openRecordDiffModal,
			};
		},
	};
})();

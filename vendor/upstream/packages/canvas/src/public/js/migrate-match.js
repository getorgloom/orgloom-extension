(function () {
	'use strict';
	// Guides destination matching and field mapping without mutating Salesforce until upload.

	window.OrgLoom = window.OrgLoom || {};

	// Match keys must also be marked filterable by the destination describe response.
	const KEYABLE_TYPES = new Set([
		'string',
		'email',
		'phone',
		'url',
		'textarea',
		'int',
		'double',
		'currency',
		'percent',
	]);

	function _distinctObjects(canvasState) {
		const map = new Map(); // objectName -> records[]
		(canvasState.bulkRecords || []).forEach((r) => {
			if (!r || r.isTypeNode || !r.objectName) {
				return;
			}
			if (!map.has(r.objectName)) {
				map.set(r.objectName, []);
			}
			map.get(r.objectName).push(r);
		});
		return map;
	}

	function _recordPlanCounts(records) {
		const counts = { updates: 0, deletes: 0, creates: 0, unresolved: 0, explicitNew: 0, excluded: 0, total: 0 };
		records.forEach((record) => {
			if (record._migrateExcluded) {
				counts.excluded++;
				return;
			}
			counts.total++;
			if (record._migrateMatchResolution === 'new') {
				counts.creates++;
				counts.explicitNew++;
			} else if (record._migrateMatchedId) {
				counts[record.pendingDelete ? 'deletes' : 'updates']++;
			} else if (record.pendingDelete || (record._migrateMatchAmbiguous && !record._migrateMatchResolution)) {
				counts.unresolved++;
			} else {
				counts.creates++;
			}
		});
		return counts;
	}

	function _keyCandidates(describe) {
		const fields = ((describe && describe.fields) || []).filter(
			(f) => f && f.name && f.filterable === true && KEYABLE_TYPES.has(f.type),
		);
		function rank(f) {
			if (f.externalId || f.idLookup) {
				return 0;
			}
			if (f.unique) {
				return 1;
			}
			if (f.nameField) {
				return 2;
			}
			return 3;
		}
		return fields
			.slice()
			.sort((a, b) => rank(a) - rank(b) || String(a.label || a.name).localeCompare(String(b.label || b.name)));
	}

	function _tierLabel(f) {
		if (f.externalId || f.idLookup) {
			return ' (external id)';
		}
		if (f.unique) {
			return ' (unique)';
		}
		if (f.nameField) {
			return ' (name)';
		}
		return '';
	}

	function _preferredKeyCandidate(describe, rec) {
		return (
			_keyCandidates(describe).find((field) => {
				const value = _lookup(rec && rec.values, field.name);
				return value !== null && value !== undefined && String(value) !== '';
			}) || null
		);
	}

	function _lookup(values, fieldName) {
		if (!values || !fieldName) {
			return undefined;
		}
		if (Object.prototype.hasOwnProperty.call(values, fieldName)) {
			return values[fieldName];
		}
		const lk = String(fieldName).toLowerCase();
		const keys = Object.keys(values);
		for (let i = 0; i < keys.length; i++) {
			if (keys[i].toLowerCase() === lk) {
				return values[keys[i]];
			}
		}
		return undefined;
	}

	function _matchValue(rec, keyField) {
		return keyField === 'Id'
			? rec._wasLoadedFromId || _lookup(rec.values, 'Id') || rec.loadedFromId
			: _lookup(rec.values, keyField);
	}

	function _clearMatchState(rec) {
		if (rec._migrateMatchedId) {
			delete rec.loadedFromId;
		}
		delete rec._migrateMatchedId;
		delete rec._migrateMatchKey;
		delete rec._migrateMatchValue;
		delete rec._migrateMatchAmbiguous;
		delete rec._migrateMatchResolution;
		delete rec._migrateMatchIntent;
		delete rec._migrateMatchCandidates;
		delete rec._migrateMatchSearched;
		delete rec._migrateMatchSearchError;
	}

	function _clone(value) {
		if (value === undefined) {
			return undefined;
		}
		return JSON.parse(JSON.stringify(value));
	}

	function _displayValue(value) {
		if (value === null || value === undefined || value === '') {
			return '(empty)';
		}
		if (typeof value === 'object') {
			try {
				return JSON.stringify(value, null, 2);
			} catch (_e) {
				return '(structured value)';
			}
		}
		return String(value);
	}

	function _dateTimeForInput(value) {
		const api = window.OrgLoom && window.OrgLoom.datetime;
		return api && typeof api.toDateTimeLocal === 'function' ? api.toDateTimeLocal(value) : String(value || '');
	}

	function _dateTimeFromInput(value) {
		const api = window.OrgLoom && window.OrgLoom.datetime;
		return api && typeof api.fromDateTimeLocal === 'function' ? api.fromDateTimeLocal(value) : String(value || '');
	}

	function _meaningfulRecordLabel(rec, describe) {
		const canvasTitle = window.OrgLoom.recordsCanvas && window.OrgLoom.recordsCanvas.recordValueTitle;
		const valueTitle = canvasTitle && canvasTitle(rec, describe);
		if (valueTitle) return valueTitle;
		const objectLabel = (describe && describe.label) || (rec && rec.objectName) || 'Record';
		const nameField = ((describe && describe.fields) || []).find((field) => field && field.nameField);
		const nameValue = nameField && _lookup(rec && rec.values, nameField.name);
		let recordLabel = rec && rec.label ? String(rec.label) : '';
		if (
			!recordLabel ||
			recordLabel.toLowerCase() === String(objectLabel).toLowerCase() ||
			recordLabel.toLowerCase() === String(objectLabel + ' record').toLowerCase()
		) {
			recordLabel = nameValue == null ? '' : String(nameValue);
		}
		return recordLabel && recordLabel.toLowerCase() !== String(objectLabel).toLowerCase() ? recordLabel : '';
	}

	function _recordDisplayLabel(rec, describe, allRecords, ordinal) {
		const objectLabel = (describe && describe.label) || (rec && rec.objectName) || 'Record';
		const recordLabel = _meaningfulRecordLabel(rec, describe);
		if (recordLabel) {
			return objectLabel + ' \u00b7 ' + recordLabel;
		}
		if (Number.isSafeInteger(ordinal) && ordinal > 0) {
			return objectLabel + ' #' + ordinal;
		}
		const unnamedSiblings = (allRecords || []).filter(
			(candidate) =>
				candidate && candidate.objectName === rec.objectName && !_meaningfulRecordLabel(candidate, describe),
		);
		const fallbackOrdinal = unnamedSiblings.indexOf(rec);
		return unnamedSiblings.length > 1 && fallbackOrdinal >= 0
			? objectLabel + ' #' + (fallbackOrdinal + 1)
			: String(objectLabel);
	}

	function _picklistValuesForRecordType(field, recordTypeId) {
		const byRecordType = field && field.picklistValuesByRecordType;
		if (recordTypeId && byRecordType && Object.prototype.hasOwnProperty.call(byRecordType, recordTypeId)) {
			return Array.isArray(byRecordType[recordTypeId]) ? byRecordType[recordTypeId] : [];
		}
		if (recordTypeId && byRecordType && Object.keys(byRecordType).length > 0) {
			return [];
		}
		return field && Array.isArray(field.picklistValues) ? field.picklistValues : [];
	}

	function _supportsCustomPicklistValue(field) {
		return Boolean(
			field &&
				(field.type === 'combobox' ||
					((field.type === 'picklist' || field.type === 'multipicklist') &&
						field.restrictedPicklist === false)),
		);
	}

	function _activePicklistValues(field, recordTypeId) {
		return _picklistValuesForRecordType(field, recordTypeId)
			.filter((entry) => entry && entry.active !== false && entry.value !== undefined)
			.map((entry) => String(entry.value));
	}

	function _fieldMapDisposition(raw, field, recordTypeId) {
		if (!field || !field.name || raw === null || raw === undefined || typeof raw === 'object') {
			return 'incompatible';
		}
		const type = String(field.type || 'string').toLowerCase();
		if (['reference', 'address', 'location', 'base64', 'complexvalue', 'anytype'].includes(type)) {
			return 'incompatible';
		}
		if (type === 'picklist') {
			if (_supportsCustomPicklistValue(field)) {
				return 'direct';
			}
			const allowed = _activePicklistValues(field, recordTypeId);
			if (!allowed.length) {
				return 'incompatible';
			}
			return allowed.includes(String(raw)) ? 'direct' : 'choice';
		}
		if (type === 'multipicklist') {
			if (_supportsCustomPicklistValue(field)) {
				return 'direct';
			}
			const allowed = new Set(_activePicklistValues(field, recordTypeId));
			const values = String(raw)
				.split(';')
				.map((value) => value.trim())
				.filter(Boolean);
			return values.length > 0 && values.every((value) => allowed.has(value)) ? 'direct' : 'incompatible';
		}
		if (['int', 'double', 'currency', 'percent'].includes(type)) {
			if (typeof raw === 'string' && raw.trim() === '') {
				return 'incompatible';
			}
			const number = Number(raw);
			return Number.isFinite(number) && (type !== 'int' || Number.isInteger(number)) ? 'direct' : 'incompatible';
		}
		if (type === 'boolean') {
			return typeof raw === 'boolean' || /^(true|false)$/i.test(String(raw)) ? 'direct' : 'incompatible';
		}
		if (type === 'date') {
			const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw));
			if (!match) {
				return 'incompatible';
			}
			const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
			return date.getUTCFullYear() === Number(match[1]) &&
				date.getUTCMonth() === Number(match[2]) - 1 &&
				date.getUTCDate() === Number(match[3])
				? 'direct'
				: 'incompatible';
		}
		if (type === 'datetime') {
			return Number.isFinite(Date.parse(String(raw))) ? 'direct' : 'incompatible';
		}
		if (type === 'time') {
			return /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z)?$/.test(String(raw))
				? 'direct'
				: 'incompatible';
		}
		if (
			Number.isFinite(Number(field.length)) &&
			Number(field.length) >= 0 &&
			String(raw).length > Number(field.length)
		) {
			return 'incompatible';
		}
		return 'direct';
	}

	function _fieldIdentity(value, apiName) {
		let normalized = String(value || '')
			.trim()
			.toLowerCase();
		if (apiName) {
			normalized = normalized.replace(/__(?:c|pc)$/i, '');
			// Compare only the field portion of namespaced custom fields so packaged and
			// unpackaged destination fields can match each other.
			if (normalized.includes('__')) {
				normalized = normalized.slice(normalized.lastIndexOf('__') + 2);
			}
		}
		return normalized.replace(/[^a-z0-9]/g, '');
	}

	function _automaticFieldCandidate(sourceField, raw, fields, recordTypeId) {
		const sourceName = String(sourceField || '').toLowerCase();
		const sourceIdentity = _fieldIdentity(sourceField, true);
		if (!sourceIdentity) {
			return null;
		}
		const ranked = (fields || [])
			.map((field) => {
				if (!field || !field.name) {
					return null;
				}
				const disposition = _fieldMapDisposition(raw, field, recordTypeId);
				if (disposition === 'incompatible') {
					return null;
				}
				let score = 0;
				if (String(field.name).toLowerCase() === sourceName) {
					score = 3;
				} else if (_fieldIdentity(field.name, true) === sourceIdentity) {
					score = 2;
				} else if (_fieldIdentity(field.label, false) === sourceIdentity) {
					score = 1;
				}
				return score ? { field: field, disposition: disposition, score: score } : null;
			})
			.filter(Boolean)
			.sort((a, b) => b.score - a.score);
		if (!ranked.length || (ranked[1] && ranked[1].score === ranked[0].score)) {
			return null;
		}
		return ranked[0];
	}

	function _candidateList(candidatesByValue, value) {
		if (!candidatesByValue || value === null || value === undefined) {
			return [];
		}
		const exact = candidatesByValue[String(value)];
		if (Array.isArray(exact)) {
			return exact;
		}
		const wanted = String(value).toLowerCase();
		const key = Object.keys(candidatesByValue).find((k) => k.toLowerCase() === wanted);
		return key && Array.isArray(candidatesByValue[key]) ? candidatesByValue[key] : [];
	}

	function _searchCandidate(record) {
		if (!record || typeof record.id !== 'string' || !record.id) {
			return null;
		}
		return {
			id: record.id,
			label: record.name == null ? '' : String(record.name),
			lastModifiedDate: null,
			matchField: null,
			matchValue: null,
			details: record.details || [],
		};
	}

	function _candidateDetailLines(candidate, candidates) {
		const peers = candidates.filter((item) => item.label === candidate.label);
		const details = (candidate.details || []).filter(
			(detail) => detail && detail.value != null && detail.value !== '',
		);
		const distinct = (detail) =>
			peers.some(
				(peer) =>
					String((peer.details || []).find((item) => item.name === detail.name)?.value ?? '') !==
					String(detail.value),
			);
		const ordered =
			peers.length > 1
				? [...details.filter(distinct), ...details.filter((detail) => !distinct(detail))]
				: details;
		const chosen = ordered.slice(0, 2);
		const lines = chosen.map((detail) => (detail.label || detail.name) + ': ' + detail.value);
		// If the human-readable details still collide, expose the stable record ID.
		if (
			!lines.length ||
			peers.some(
				(peer) =>
					peer.id !== candidate.id &&
					chosen.every(
						(detail) =>
							String((peer.details || []).find((item) => item.name === detail.name)?.value ?? '') ===
							String(detail.value),
					),
			)
		) {
			lines.push('ID: ' + candidate.id);
		}
		return lines;
	}

	function _applyMatchResponse(recs, keyField, data) {
		const candidatesByValue = (data && data.candidatesByValue) || {};
		const byValue = new Map();
		recs.forEach((rec) => {
			const raw = _matchValue(rec, keyField);
			rec._migrateMatchKey = keyField;
			rec._migrateMatchValue = raw == null ? '' : String(raw);
			if (raw === null || raw === undefined || String(raw) === '') {
				return;
			}
			const value = String(raw);
			if (!byValue.has(value)) {
				byValue.set(value, []);
			}
			byValue.get(value).push(rec);
		});

		let matched = 0;
		let unresolved = 0;
		byValue.forEach((sourceRecords, value) => {
			const candidates = _candidateList(candidatesByValue, value).filter((c) => c && typeof c.id === 'string');
			if (candidates.length === 1 && sourceRecords.length === 1) {
				const rec = sourceRecords[0];
				rec.loadedFromId = candidates[0].id;
				rec._migrateMatchedId = candidates[0].id;
				rec._migrateMatchCandidates = candidates.map((c) => ({
					id: c.id,
					label: c.label == null ? '' : String(c.label),
					lastModifiedDate: c.lastModifiedDate || null,
					details: c.details || [],
					matchField: keyField,
					matchValue: value,
				}));
				rec._migrateMatchResolution = 'automatic';
				matched++;
				return;
			}
			if (candidates.length > 1 || (candidates.length === 1 && sourceRecords.length > 1)) {
				sourceRecords.forEach((rec) => {
					rec._migrateMatchAmbiguous = true;
					rec._migrateMatchCandidates = candidates.map((c) => ({
						id: c.id,
						label: c.label == null ? '' : String(c.label),
						lastModifiedDate: c.lastModifiedDate || null,
						details: c.details || [],
						matchField: keyField,
						matchValue: value,
					}));
					unresolved++;
				});
			}
		});
		return { matched: matched, unresolved: unresolved };
	}

	function _resolveRecord(rec, choice, allRecords) {
		if (!rec) {
			return { ok: false, error: 'not-matchable' };
		}
		if (rec._migrateMatchedId) {
			delete rec.loadedFromId;
			delete rec._migrateMatchedId;
		}
		if (choice === 'new') {
			rec._migrateMatchAmbiguous = true;
			rec._migrateMatchResolution = 'new';
			rec._migrateMatchIntent = 'new';
			return { ok: true };
		}
		if (choice === 'update') {
			rec._migrateMatchAmbiguous = true;
			delete rec._migrateMatchResolution;
			rec._migrateMatchIntent = 'existing';
			return { ok: true, pending: true };
		}
		if (!Array.isArray(rec._migrateMatchCandidates) || rec._migrateMatchCandidates.length === 0) {
			return { ok: false, error: 'not-matchable' };
		}
		const candidate = (rec._migrateMatchCandidates || []).find((c) => c.id === choice);
		if (!candidate) {
			delete rec._migrateMatchResolution;
			rec._migrateMatchIntent = 'existing';
			return { ok: false, error: 'unknown-candidate' };
		}
		const claimed = (allRecords || []).some(
			(other) => other && other !== rec && other._migrateMatchedId === candidate.id,
		);
		// One destination row may satisfy only one canvas record in a migration plan.
		if (claimed) {
			delete rec._migrateMatchResolution;
			rec._migrateMatchIntent = 'existing';
			return { ok: false, error: 'candidate-already-used' };
		}
		rec.loadedFromId = candidate.id;
		rec._migrateMatchedId = candidate.id;
		rec._migrateMatchResolution = 'existing';
		rec._migrateMatchIntent = 'existing';
		return { ok: true };
	}

	window.OrgLoom.migrateMatch = {
		mount: function mount(deps) {
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			const showBulkToast = deps.showBulkToast || function () {};
			const ensureDescribe = deps.ensureDescribe;
			const renderBulkView = deps.renderBulkView || function () {};
			const onApplied = deps.onApplied || function () {};
			const onCommitPlan = deps.onCommitPlan || onApplied;
			const recordOrdinal = typeof deps.recordOrdinal === 'function' ? deps.recordOrdinal : null;
			function open(opts) {
				opts = opts || {};
				const onClose = typeof opts.onClose === 'function' ? opts.onClose : null;
				document.querySelectorAll('.migrate-match-modal').forEach((el) => el.remove());
				const objects = _distinctObjects(canvasState);
				const snapshotFields = [
					'_migrateExcluded',
					'values',
					'loadedFromId',
					'_migrateMatchedId',
					'_migrateMatchKey',
					'_migrateMatchValue',
					'_migrateMatchAmbiguous',
					'_migrateMatchResolution',
					'_migrateMatchIntent',
					'_migrateMatchCandidates',
					'_migrateRecordTypeId',
					'_migrateClearRecordType',
					'_migratePicklistRemap',
					'_migrateFieldResolutions',
					'_migrateMatchSearched',
					'_migrateMatchSearchError',
				];
				const matchSnapshot = new Map();
				objects.forEach((recs) =>
					recs.forEach((rec) => {
						const state = {};
						snapshotFields.forEach((field) => {
							if (Object.prototype.hasOwnProperty.call(rec, field)) {
								state[field] = _clone(rec[field]);
							}
						});
						matchSnapshot.set(rec, state);
					}),
				);
				let committed = false;
				let closed = false;
				let applying = false;
				const overlay = document.createElement('div');
				overlay.className = 'modal migrate-match-modal';
				overlay.innerHTML =
					'<div class="modal-overlay"></div>' +
					'<div class="modal-body mm-modal-body">' +
					'<div class="modal-header">' +
					'<h3>Prepare migration</h3>' +
					'<button class="modal-close" data-mm-close aria-label="Close">&times;</button>' +
					'</div>' +
					'<div class="modal-content mm-content">' +
					'<div class="mm-stepper" aria-label="Migration progress">' +
					'<button type="button" class="mm-step is-active" data-mm-step="matches"><span>1</span><strong>Records</strong></button>' +
					'<span class="mm-step-line" aria-hidden="true"></span>' +
					'<button type="button" class="mm-step" data-mm-step="differences"><span>2</span><strong>Fields</strong></button>' +
					'<span class="mm-step-line" aria-hidden="true"></span>' +
					'<button type="button" class="mm-step" data-mm-step="review"><span>3</span><strong>Summary</strong></button>' +
					'</div>' +
					'<div class="mm-summary"></div>' +
					'<section class="mm-panel" data-mm-panel="matches">' +
					'<div class="mm-decision-intro"><div><strong>Choose what happens to each canvas record</strong></div></div>' +
					'<div class="mm-record-decisions"></div>' +
					'</section>' +
					'<section class="mm-panel" data-mm-panel="differences" hidden>' +
					'<div class="mm-differences"></div>' +
					'</section>' +
					'<section class="mm-panel" data-mm-panel="review" hidden>' +
					'<div class="mm-final-review"></div>' +
					'</section>' +
					'</div>' +
					'<div class="modal-footer mm-footer">' +
					'<button type="button" class="button secondary mm-back" data-mm-back hidden>Back</button>' +
					'<span class="mm-footer-spacer"></span>' +
					'<button type="button" class="button mm-primary" data-mm-primary disabled>Loading fields…</button>' +
					'</div>' +
					'</div>';
				document.body.appendChild(overlay);

				const cleanup = () => {
					if (closed || (applying && !committed)) {
						return;
					}
					closed = true;
					document.removeEventListener('keydown', onEsc, true);
					pendingMatches.clear();
					destinationSearches.forEach((state) => clearTimeout(state.timer));
					destinationSearches.clear();
					reviewedRequiredFields.clear();
					pendingFieldMaps.clear();
					resolvedFieldMaps.clear();
					if (!committed) {
						matchSnapshot.forEach((state, rec) => {
							snapshotFields.forEach((field) => delete rec[field]);
							Object.keys(state).forEach((field) => {
								rec[field] = _clone(state[field]);
							});
						});
						renderBulkView();
						onApplied();
					}
					if (overlay.parentNode) {
						overlay.remove();
					}
					if (onClose) {
						onClose();
					}
				};
				const onEsc = (e) => {
					if (e.key === 'Escape') {
						// Dismissing a migration discards its review choices; require the close button.
						e.preventDefault();
						e.stopImmediatePropagation();
					}
				};
				document.addEventListener('keydown', onEsc, true);
				overlay.querySelector('button[data-mm-close]').addEventListener('click', cleanup);

				const summaryEl = overlay.querySelector('.mm-summary');
				const decisionsEl = overlay.querySelector('.mm-record-decisions');
				const differencesEl = overlay.querySelector('.mm-differences');
				const finalReviewEl = overlay.querySelector('.mm-final-review');
				const primaryBtn = overlay.querySelector('[data-mm-primary]');
				const backBtn = overlay.querySelector('[data-mm-back]');
				const pendingMatches = new Map();
				const destinationSearches = new Map();
				const reviewedRequiredFields = new Map();
				const pendingFieldMaps = new Map();
				const resolvedFieldMaps = new Map();
				const reviewedChoiceIssues = new Map();
				const differenceOrder = new Map();
				_allRecords().forEach((rec, recordIndex) => {
					const stored = rec && rec._migrateFieldResolutions;
					if (!stored || typeof stored !== 'object') {
						return;
					}
					Object.keys(stored).forEach((key) => {
						const resolution = _clone(stored[key]);
						if (!resolution || !resolution.sourceField || !resolution.sourceKey || !resolution.resolution) {
							return;
						}
						resolution.recordIndex = recordIndex;
						resolvedFieldMaps.set(_fieldMapKey(recordIndex, resolution.sourceField), resolution);
					});
				});
				const stepOrder = ['matches', 'differences', 'review'];
				let currentStep = 'matches';
				let describesReady = false;
				let automaticFieldMappingsApplied = false;

				const names = Array.from(objects.keys());
				Promise.all(
					names.map((n) =>
						(ensureDescribe ? ensureDescribe(n, { force: true }) : Promise.resolve(null)).catch(() => null),
					),
				).then(() => {
					describesReady = true;
					_initializeRecordDecisions();
					_renderRecordDecisions();
				});

				overlay.querySelectorAll('[data-mm-step]').forEach((stepBtn) => {
					stepBtn.addEventListener('click', () => {
						if (closed || applying || !describesReady || pendingMatches.size > 0) {
							return;
						}
						const requested = stepBtn.getAttribute('data-mm-step');
						const counts = _statusCounts();
						const differences = _differenceCounts();
						if (requested !== 'matches' && counts.unresolved > 0) {
							showBulkToast('Choose an action and destination for each record.', 'warning');
							return;
						}
						if (
							requested === 'review' &&
							(differences.blocked > 0 || differences.pending > 0 || pendingFieldMaps.size > 0)
						) {
							showBulkToast(
								pendingFieldMaps.size > 0
									? 'Choose a destination value for each pending field mapping before reviewing the migration.'
									: 'Resolve the blocked destination differences before reviewing the migration.',
								'warning',
							);
							return;
						}
						_setStep(requested);
					});
				});
				backBtn.addEventListener('click', () => {
					const index = stepOrder.indexOf(currentStep);
					_setStep(stepOrder[Math.max(0, index - 1)]);
				});
				primaryBtn.addEventListener('click', async () => {
					if (closed || applying || primaryBtn.disabled) {
						return;
					}
					if (currentStep === 'matches') {
						_setStep('differences');
						return;
					}
					if (currentStep === 'differences') {
						_setStep('review');
						return;
					}
					if (!primaryBtn.disabled) {
						applying = true;
						_updateFooter();
						try {
							await Promise.resolve(onCommitPlan());
							committed = true;
							cleanup();
						} catch (error) {
							showBulkToast(
								(error && error.message) || 'Could not apply the migration to the canvas.',
								'error',
							);
						} finally {
							applying = false;
							if (!closed) {
								_recomputeSummary();
							}
						}
					}
				});
				function _setStep(step) {
					if (closed || applying || !stepOrder.includes(step)) {
						return;
					}
					currentStep = step;
					overlay.querySelectorAll('[data-mm-panel]').forEach((panel) => {
						panel.hidden = panel.getAttribute('data-mm-panel') !== step;
					});
					overlay.querySelectorAll('[data-mm-step]').forEach((stepBtn) => {
						const active = stepBtn.getAttribute('data-mm-step') === step;
						stepBtn.classList.toggle('is-active', active);
						if (active) {
							stepBtn.setAttribute('aria-current', 'step');
						} else {
							stepBtn.removeAttribute('aria-current');
						}
					});
					backBtn.hidden = step === 'matches';
					summaryEl.hidden = step === 'review';
					if (step === 'matches') {
						_renderRecordDecisions();
					} else if (step === 'differences') {
						if (!automaticFieldMappingsApplied) {
							_applyAutomaticFieldMappings();
							automaticFieldMappingsApplied = true;
						}
						_renderDifferences();
					} else if (step === 'review') {
						_renderFinalReview();
					}
					_recomputeSummary();
					overlay.querySelector('.modal-content').scrollTop = 0;
				}

				function _preferredKeyForRecord(rec) {
					const describe = rec && canvasState.describeCache[rec.objectName];
					return _preferredKeyCandidate(describe, rec);
				}

				async function _requestMatches(objectName, keyField, values) {
					let resp;
					try {
						resp = await csrfFetch('/api/migrate/match', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ objectName: objectName, keyField: keyField, values: values }),
						});
					} catch (_err) {
						return { ok: false, error: 'Could not search Salesforce. Try again.' };
					}
					if (!resp.ok) {
						let message = resp.statusText || 'Salesforce search failed';
						try {
							const body = await resp.json();
							message = body.message || body.error || message;
						} catch (_e) {}
						return { ok: false, error: message };
					}
					return { ok: true, data: await resp.json() };
				}

				function _destinationSearchState(rec) {
					if (!destinationSearches.has(rec)) {
						const selectedCandidate = (rec._migrateMatchCandidates || []).find(
							(candidate) => candidate && candidate.id === rec._migrateMatchedId,
						);
						const selectedLabel = selectedCandidate && (selectedCandidate.label || selectedCandidate.id);
						destinationSearches.set(rec, {
							query: selectedLabel || rec._migrateMatchedId || '',
							results: [],
							open: !rec._migrateMatchedId,
							attempted: false,
							loading: false,
							error: '',
							sequence: 0,
							timer: null,
						});
					}
					return destinationSearches.get(rec);
				}

				function _collapseDestinationSearch(rec, candidate) {
					const state = _destinationSearchState(rec);
					clearTimeout(state.timer);
					state.sequence++;
					state.loading = false;
					state.error = '';
					state.attempted = false;
					state.results = [];
					state.query = (candidate && candidate.label) || (candidate && candidate.id) || '';
					state.open = false;
				}

				async function _searchDestinationRecords(rec) {
					const state = _destinationSearchState(rec);
					const query = state.query.trim();
					const sequence = ++state.sequence;
					if (!query) {
						state.results = [];
						state.attempted = false;
						state.loading = false;
						state.error = '';
						_renderDestinationSearchResults(rec);
						return;
					}
					state.loading = true;
					state.error = '';
					state.attempted = false;
					_renderDestinationSearchResults(rec);
					try {
						const resp = await csrfFetch(
							'/api/objects/' +
								encodeURIComponent(rec.objectName) +
								'/search?q=' +
								encodeURIComponent(query) +
								'&migrationDetails=1',
							{ credentials: 'same-origin' },
						);
						if (!resp.ok) {
							const body = await resp.json().catch(() => ({}));
							throw new Error(body.message || body.error || resp.statusText || 'Search failed.');
						}
						const data = await resp.json();
						if (closed || state.sequence !== sequence) {
							return;
						}
						state.results = ((data && data.records) || []).map(_searchCandidate).filter(Boolean);
						state.attempted = true;
					} catch (error) {
						if (closed || state.sequence !== sequence) {
							return;
						}
						state.results = [];
						state.attempted = true;
						state.error = error && error.message ? error.message : 'Search failed.';
					} finally {
						if (!closed && state.sequence === sequence) {
							state.loading = false;
							_renderDestinationSearchResults(rec);
						}
					}
				}

				function _markCreate(rec) {
					rec._migrateMatchCandidates = [];
					rec._migrateMatchResolution = 'new';
					rec._migrateMatchIntent = 'new';
					delete rec._migrateMatchAmbiguous;
					delete rec._migrateMatchSearchError;
				}

				function _markUpdateWithoutMatch(rec) {
					rec._migrateMatchCandidates = [];
					delete rec.loadedFromId;
					delete rec._migrateMatchedId;
					delete rec._migrateMatchResolution;
					delete rec._migrateMatchSearchError;
					rec._migrateMatchAmbiguous = true;
					rec._migrateMatchIntent = 'existing';
				}

				function _initializeRecordDecisions() {
					_allRecords()
						.filter(
							(rec) =>
								!rec._migrateMatchSearched &&
								!rec._migrateMatchedId &&
								!rec._migrateMatchResolution &&
								!rec._migrateMatchAmbiguous,
						)
						.forEach((rec) => {
							_clearMatchState(rec);
							if (rec.pendingDelete) {
								_markUpdateWithoutMatch(rec);
								void _initializeDeleteMatch(rec);
							} else {
								_markCreate(rec);
							}
						});
					_recomputeSummary();
				}

				async function _initializeDeleteMatch(rec) {
					const describe = canvasState.describeCache[rec.objectName];
					const idField = ((describe && describe.fields) || []).find(
						(field) => field.name === 'Id' && field.filterable,
					);
					if (idField && _matchValue(rec, 'Id')) {
						await _runMatchForRecord(rec, 'Id');
						if (
							closed ||
							rec._migrateMatchedId ||
							rec._migrateMatchSearchError ||
							rec._migrateMatchResolution === 'new'
						)
							return;
					}
					const key = _preferredKeyCandidate(describe, rec);
					if (key) await _runMatchForRecord(rec, key.name);
				}

				function _allRecords() {
					const out = [];
					objects.forEach((recs) => recs.forEach((rec) => out.push(rec)));
					return out;
				}

				function _annotationFor(rec) {
					if (rec && rec._migrateExcluded) {
						return { status: 'excluded', issues: [] };
					}
					const engine = window.Orgloom && window.Orgloom.migrateAnnotate;
					const describe = rec && canvasState.describeCache[rec.objectName];
					if (!engine || !engine.computeMigrationStatus || !describe) {
						return { status: 'pending', issues: [], resolvedRecordTypeId: null };
					}
					const annotation = engine.computeMigrationStatus(rec, describe);
					const dependencies = engine.exclusionIssues(
						rec,
						_allRecords(),
						engine.resolvedAssociations(_allRecords(), canvasState.bulkAssociations),
						canvasState.describeCache,
					);
					dependencies.push(
						...engine.relationshipIssues(
							rec,
							_allRecords(),
							canvasState.bulkAssociations,
							canvasState.describeCache,
						),
					);
					return dependencies.length
						? { ...annotation, status: 'blocked', issues: annotation.issues.concat(dependencies) }
						: annotation;
				}

				function _effectiveRecordTypeId(rec) {
					const describe = rec && canvasState.describeCache[rec.objectName];
					const annotation = _annotationFor(rec);
					return (
						(annotation && annotation.resolvedRecordTypeId) ||
						(describe && describe.defaultRecordTypeId) ||
						null
					);
				}

				function _differenceCounts() {
					const counts = {
						blocked: 0,
						requiredFields: 0,
						warnings: 0,
						pending: 0,
						unavailableValues: 0,
						omittedPicklistValues: 0,
					};
					_allRecords().forEach((rec, recordIndex) => {
						const annotation = _annotationFor(rec);
						if (annotation.status === 'pending') {
							counts.pending++;
						}
						(annotation.issues || []).forEach((issue) => {
							if (
								issue.kind === 'missing-field' &&
								resolvedFieldMaps.has(_fieldMapKey(recordIndex, issue.field))
							) {
								return;
							}
							if (issue.severity === 'blocked') {
								counts.blocked++;
								if (issue.kind === 'required-unfilled') {
									counts.requiredFields++;
								}
							} else if (issue.severity === 'warning') {
								counts.warnings++;
							}
							if (issue.kind === 'missing-field') {
								counts.unavailableValues++;
							} else if (issue.kind === 'picklist-mismatch') {
								counts.omittedPicklistValues += Array.isArray(issue.invalidValues)
									? issue.invalidValues.length
									: 1;
							}
						});
					});
					resolvedFieldMaps.forEach((resolved) => {
						if (
							!_allRecords()[resolved.recordIndex]?._migrateExcluded &&
							resolved.resolution === '__omit__'
						) {
							counts.unavailableValues++;
						}
					});
					return counts;
				}

				function _fieldFor(rec, fieldName) {
					const describe = rec && canvasState.describeCache[rec.objectName];
					return (
						((describe && describe.fields) || []).find(
							(field) =>
								field &&
								field.name &&
								String(field.name).toLowerCase() === String(fieldName).toLowerCase(),
						) || null
					);
				}

				function _valueKey(rec, fieldName) {
					return (
						(rec &&
							rec.values &&
							Object.keys(rec.values).find(
								(key) => key.toLowerCase() === String(fieldName).toLowerCase(),
							)) ||
						null
					);
				}

				function _writableFields(rec, excludedField) {
					const describe = rec && canvasState.describeCache[rec.objectName];
					return ((describe && describe.fields) || [])
						.filter((field) => {
							if (
								!field ||
								!field.name ||
								String(field.name).toLowerCase() === String(excludedField).toLowerCase() ||
								field.calculated ||
								field.autoNumber
							) {
								return false;
							}
							if (field.compoundFieldName || field.type === 'address' || field.type === 'location') {
								return false;
							}
							return rec.loadedFromId ? field.updateable !== false : field.createable !== false;
						})
						.sort((a, b) => String(a.label || a.name).localeCompare(String(b.label || b.name)));
				}

				function _writableFieldOptions(rec, excludedField, raw, selectedTarget) {
					return _writableFields(rec, excludedField)
						.map((field) => ({
							field: field,
							disposition: _fieldMapDisposition(raw, field, _effectiveRecordTypeId(rec)),
						}))
						.filter((entry) => entry.disposition !== 'incompatible')
						.map(
							(entry) =>
								'<option value="' +
								escapeHtml(entry.field.name) +
								'"' +
								(entry.field.name === selectedTarget ? ' selected' : '') +
								'>' +
								'Map to ' +
								escapeHtml(entry.field.label || entry.field.name) +
								' (' +
								escapeHtml(entry.field.name) +
								')' +
								(entry.disposition === 'choice' ? ' (value selection required)' : '') +
								'</option>',
						)
						.join('');
				}

				function _fieldMapKey(recordIndex, sourceField) {
					return recordIndex + ':' + String(sourceField).toLowerCase();
				}

				function _resolvedFieldMapsForRecord(recordIndex) {
					return Array.from(resolvedFieldMaps.entries()).filter(
						(entry) => entry[1].recordIndex === recordIndex,
					);
				}

				function _persistResolvedFieldMap(rec, resolved) {
					if (!rec || !resolved || !resolved.sourceField) {
						return;
					}
					const stored = _clone(resolved);
					delete stored.recordIndex;
					// Store the decision on the record so closing the guide does not erase user choices.
					rec._migrateFieldResolutions = rec._migrateFieldResolutions || {};
					rec._migrateFieldResolutions[String(resolved.sourceField).toLowerCase()] = stored;
				}

				function _removePersistedFieldMap(rec, sourceField) {
					if (!rec || !rec._migrateFieldResolutions || !sourceField) {
						return;
					}
					delete rec._migrateFieldResolutions[String(sourceField).toLowerCase()];
					if (!Object.keys(rec._migrateFieldResolutions).length) {
						delete rec._migrateFieldResolutions;
					}
				}

				function _restoreResolvedFieldMap(rec, mapKey) {
					const resolved = resolvedFieldMaps.get(mapKey);
					if (!rec || !resolved) {
						return null;
					}
					if (resolved.targetField) {
						const currentTargetKey = _valueKey(rec, resolved.targetField);
						const currentTargetValue = currentTargetKey ? rec.values[currentTargetKey] : undefined;
						if (currentTargetKey && currentTargetValue === resolved.mappedValue) {
							if (resolved.targetHadValue) {
								rec.values[resolved.targetKey] = _clone(resolved.targetPreviousValue);
							} else {
								delete rec.values[currentTargetKey];
							}
						}
					}
					rec.values[resolved.sourceKey] = _clone(resolved.sourceValue);
					resolvedFieldMaps.delete(mapKey);
					_removePersistedFieldMap(rec, resolved.sourceField);
					return resolved;
				}

				function _commitFieldResolution(
					recordIndex,
					rec,
					sourceField,
					sourceKey,
					resolution,
					mappedValue,
					options,
				) {
					if (!rec || !sourceKey || !resolution) {
						return false;
					}
					const mapKey = _fieldMapKey(recordIndex, sourceField);
					const sourceValue = rec.values[sourceKey];
					const resolved = {
						recordIndex: recordIndex,
						sourceField: sourceField,
						sourceKey: sourceKey,
						sourceValue: _clone(sourceValue),
						resolution: resolution,
						targetField: null,
						targetKey: null,
						targetHadValue: false,
						targetPreviousValue: undefined,
						mappedValue: undefined,
					};
					if (options && options.automatic) {
						resolved.automatic = true;
					}
					if (resolution !== '__omit__') {
						const targetField = _fieldFor(rec, resolution);
						if (!targetField) {
							return false;
						}
						const targetKey = _valueKey(rec, targetField.name);
						const writeKey = targetKey || targetField.name;
						const targetValue = mappedValue === undefined ? sourceValue : mappedValue;
						resolved.targetField = targetField.name;
						resolved.targetKey = writeKey;
						resolved.targetHadValue = Boolean(targetKey);
						resolved.targetPreviousValue = targetKey ? _clone(rec.values[targetKey]) : undefined;
						resolved.mappedValue = _clone(targetValue);
						rec.values[writeKey] = targetValue;
					}
					delete rec.values[sourceKey];
					pendingFieldMaps.delete(mapKey);
					resolvedFieldMaps.set(mapKey, resolved);
					_persistResolvedFieldMap(rec, resolved);
					return true;
				}

				function _applyAutomaticFieldMappings() {
					const all = _allRecords();
					const reservedTargets = new Map();
					resolvedFieldMaps.forEach((resolved) => {
						if (resolved && resolved.targetField) {
							const reserved = reservedTargets.get(resolved.recordIndex) || new Set();
							reserved.add(String(resolved.targetField).toLowerCase());
							reservedTargets.set(resolved.recordIndex, reserved);
						}
					});
					all.forEach((rec, recordIndex) => {
						const reserved = reservedTargets.get(recordIndex) || new Set();
						(_annotationFor(rec).issues || []).forEach((issue) => {
							if (issue.kind !== 'missing-field') {
								return;
							}
							const mapKey = _fieldMapKey(recordIndex, issue.field);
							const sourceKey = _valueKey(rec, issue.field);
							if (!sourceKey || resolvedFieldMaps.has(mapKey) || pendingFieldMaps.has(mapKey)) {
								return;
							}
							const raw = rec.values[sourceKey];
							const candidate = _automaticFieldCandidate(
								issue.field,
								raw,
								_writableFields(rec, issue.field),
								_effectiveRecordTypeId(rec),
							);
							if (!candidate) {
								return;
							}
							const targetName = String(candidate.field.name);
							if (reserved.has(targetName.toLowerCase())) {
								return;
							}
							const targetKey = _valueKey(rec, targetName);
							const targetValue = targetKey ? rec.values[targetKey] : undefined;
							if (
								targetValue !== null &&
								targetValue !== undefined &&
								targetValue !== '' &&
								String(targetValue) !== String(raw)
							) {
								return;
							}
							reserved.add(targetName.toLowerCase());
							if (candidate.disposition === 'choice') {
								pendingFieldMaps.set(mapKey, { targetField: targetName, automatic: true });
								return;
							}
							_commitFieldResolution(recordIndex, rec, issue.field, sourceKey, targetName, undefined, {
								automatic: true,
							});
						});
						reservedTargets.set(recordIndex, reserved);
					});
				}

				function _fieldMapValueControl(field, rec, recordIndex, sourceField, selectedValue) {
					const options = _picklistValuesForRecordType(field, _effectiveRecordTypeId(rec))
						.filter((entry) => entry && entry.active !== false && entry.value !== undefined)
						.map(
							(entry) =>
								'<option value="' +
								escapeHtml(entry.value) +
								'"' +
								(String(entry.value) === String(selectedValue) ? ' selected' : '') +
								'>' +
								escapeHtml(entry.label || entry.value) +
								'</option>',
						)
						.join('');
					return (
						'<select aria-label="Destination value for ' +
						escapeHtml(sourceField) +
						'" data-mm-map-value data-mm-map-record="' +
						recordIndex +
						'" data-mm-map-source="' +
						escapeHtml(sourceField) +
						'" data-mm-map-target="' +
						escapeHtml(field.name) +
						'">' +
						'<option value=""' +
						(selectedValue ? '' : ' selected') +
						'>Choose a destination value...</option>' +
						options +
						'</select>'
					);
				}

				function _requiredFieldControl(rec, issue, recordIndex) {
					const field = _fieldFor(rec, issue.field) || {
						name: issue.field,
						label: issue.field,
						type: 'string',
					};
					const attrs =
						' data-mm-required-record="' +
						recordIndex +
						'" data-mm-required-field="' +
						escapeHtml(field.name) +
						'"';
					const currentValue = _lookup(rec.values, field.name);
					const displayedValue =
						field.type === 'datetime' && currentValue ? _dateTimeForInput(currentValue) : currentValue;
					if (field.type === 'picklist' || field.type === 'multipicklist') {
						const options = _picklistValuesForRecordType(field, _effectiveRecordTypeId(rec))
							.filter((value) => value && value.active !== false)
							.map(
								(value) =>
									'<option value="' +
									escapeHtml(value.value) +
									'"' +
									(String(value.value) === String(currentValue) ? ' selected' : '') +
									'>' +
									escapeHtml(value.label || value.value) +
									'</option>',
							)
							.join('');
						return (
							'<select class="mm-difference-input"' +
							attrs +
							'><option value="">Select a value...</option>' +
							options +
							'</select>'
						);
					}
					if (field.type === 'textarea') {
						return (
							'<textarea class="mm-difference-input" rows="2" placeholder="Enter ' +
							escapeHtml(field.label || field.name) +
							'"' +
							attrs +
							'>' +
							escapeHtml(currentValue == null ? '' : String(currentValue)) +
							'</textarea>'
						);
					}
					const numeric = ['int', 'double', 'currency', 'percent'].includes(field.type);
					const inputType = numeric
						? 'number'
						: field.type === 'date'
							? 'date'
							: field.type === 'datetime'
								? 'datetime-local'
								: 'text';
					return (
						'<input class="mm-difference-input" type="' +
						inputType +
						'"' +
						(numeric ? ' step="any"' : '') +
						(displayedValue == null || displayedValue === ''
							? ''
							: ' value="' + escapeHtml(String(displayedValue)) + '"') +
						' placeholder="Enter ' +
						escapeHtml(field.label || field.name) +
						'"' +
						attrs +
						'>'
					);
				}

				function _fieldDifferenceRow(
					label,
					value,
					reason,
					control,
					resolved,
					attributes = '',
					destinationField = escapeHtml(label),
				) {
					return (
						'<tr class="mm-field-row' +
						(resolved ? ' is-resolved' : ' needs-attention') +
						'"' +
						attributes +
						'>' +
						'<th scope="row">' +
						escapeHtml(label) +
						'</th><td class="mm-field-source"><span>' +
						escapeHtml(value === null || value === undefined || value === '' ? '—' : _displayValue(value)) +
						'</span><small>' +
						escapeHtml(reason) +
						'</small></td><td class="mm-field-destination">' +
						destinationField +
						'</td><td class="mm-field-destination mm-destination-value">' +
						control +
						'</td></tr>'
					);
				}

				function _differenceIssueHtml(rec, issue, recordIndex) {
					const fieldLabel = (_fieldFor(rec, issue.field) || {}).label || issue.field || 'Destination field';
					if (issue.kind === 'boolean-mismatch') {
						const value = _lookup(rec.values, issue.field);
						const resolved = typeof value === 'boolean';
						return _fieldDifferenceRow(
							fieldLabel,
							issue.sourceValue,
							resolved ? 'Checkbox value selected' : issue.message,
							'<select data-mm-boolean-record="' +
								recordIndex +
								'" data-mm-boolean-field="' +
								escapeHtml(issue.field) +
								'" aria-label="Destination checkbox value for ' +
								escapeHtml(fieldLabel) +
								'">' +
								'<option value="">Choose True or False...</option>' +
								'<option value="true"' +
								(value === true ? ' selected' : '') +
								'>True (checked)</option>' +
								'<option value="false"' +
								(value === false ? ' selected' : '') +
								'>False (unchecked)</option></select>',
							resolved,
						);
					}
					if (issue.kind === 'relationship-mismatch') {
						const mappings = rec._migrateRelationshipRemap || {};
						const selected = Object.prototype.hasOwnProperty.call(mappings, issue.field)
							? mappings[issue.field]
							: '__original__';
						const fields = (canvasState.describeCache[rec.objectName] || {}).fields || [];
						const candidates = fields.filter(
							(field) =>
								field.type === 'reference' &&
								(field.referenceTo || []).includes(issue.parentObject) &&
								(rec._migrateMatchedId ? field.updateable : field.createable) !== false,
						);
						const problem = _annotationFor(rec).issues.find(
							(item) => item.kind === issue.kind && item.field === issue.field,
						);
						const parent = _allRecords().find((item) => String(item.id) === String(issue.parentId));
						const control =
							'<select data-mm-relationship-record="' +
							recordIndex +
							'" data-mm-relationship-field="' +
							escapeHtml(issue.field) +
							'" aria-label="Destination lookup for ' +
							escapeHtml(issue.field) +
							'">' +
							'<option value="__original__">Choose destination lookup...</option>' +
							'<option value=""' +
							(selected === '' ? ' selected' : '') +
							">Don't map (destination unchanged)</option>" +
							candidates
								.map(
									(field) =>
										'<option value="' +
										escapeHtml(field.name) +
										'"' +
										(selected === field.name ? ' selected' : '') +
										'>' +
										escapeHtml(field.label || field.name) +
										'</option>',
								)
								.join('') +
							'</select>';
						return _fieldDifferenceRow(
							fieldLabel,
							parent ? _differenceRecordLabel(parent) : issue.parentObject,
							problem ? problem.message : 'Relationship reviewed',
							selected === '' ? 'Not mapped' : escapeHtml(issue.parentObject),
							!problem,
							'',
							control,
						);
					}
					if (issue.kind === 'missing-field') {
						const mapKey = _fieldMapKey(recordIndex, issue.field);
						const resolvedMap = resolvedFieldMaps.get(mapKey);
						const sourceKey = resolvedMap ? resolvedMap.sourceKey : _valueKey(rec, issue.field);
						const raw = resolvedMap
							? resolvedMap.sourceValue
							: sourceKey
								? rec.values[sourceKey]
								: undefined;
						const pendingMap = pendingFieldMaps.get(mapKey);
						let selectedTarget =
							(resolvedMap && resolvedMap.targetField) || (pendingMap && pendingMap.targetField);
						let selectedField = selectedTarget && _fieldFor(rec, selectedTarget);
						if (
							!resolvedMap &&
							selectedTarget &&
							_fieldMapDisposition(raw, selectedField, _effectiveRecordTypeId(rec)) !== 'choice'
						) {
							pendingFieldMaps.delete(mapKey);
							selectedTarget = '';
							selectedField = null;
						}
						const mapOptions = _writableFieldOptions(rec, issue.field, raw, selectedTarget);
						const valueControl =
							selectedField &&
							_fieldMapDisposition(raw, selectedField, _effectiveRecordTypeId(rec)) === 'choice'
								? _fieldMapValueControl(
										selectedField,
										rec,
										recordIndex,
										issue.field,
										resolvedMap && resolvedMap.mappedValue,
									)
								: selectedField
									? '<span class="mm-destination-plain">' +
										escapeHtml(_displayValue(resolvedMap ? resolvedMap.mappedValue : raw)) +
										'</span>'
									: '<span class="mm-destination-inactive">' +
										(resolvedMap && resolvedMap.resolution === '__omit__' ? 'Not mapped' : '—') +
										'</span>';
						const control =
							'<select data-mm-field-resolution aria-label="How to handle ' +
							escapeHtml(issue.field) +
							'">' +
							'<option value=""' +
							(!resolvedMap && !pendingMap ? ' selected' : '') +
							'>Choose destination field...</option>' +
							'<option value="__omit__"' +
							(resolvedMap && resolvedMap.resolution === '__omit__' ? ' selected' : '') +
							">Don't map (destination unchanged)</option>" +
							(mapOptions
								? '<optgroup label="Map to a destination field">' + mapOptions + '</optgroup>'
								: '') +
							'</select>';
						return _fieldDifferenceRow(
							fieldLabel,
							raw,
							resolvedMap
								? resolvedMap.automatic
									? 'Auto-matched'
									: 'Reviewed mapping'
								: 'Field missing',
							valueControl,
							Boolean(resolvedMap),
							' data-mm-missing-record="' +
								recordIndex +
								'" data-mm-missing-field="' +
								escapeHtml(issue.field) +
								'"',
							control,
						);
					}
					if (issue.kind === 'required-unfilled' || issue.kind === 'required-reviewed') {
						return _fieldDifferenceRow(
							fieldLabel,
							_lookup(rec.values, issue.field),
							issue.kind === 'required-reviewed' ? 'Required field completed' : 'Required in destination',
							_requiredFieldControl(rec, issue, recordIndex),
							issue.kind === 'required-reviewed',
						);
					}
					if (issue.kind === 'recordtype-unresolved') {
						const selectedType = rec._migrateClearRecordType ? '__clear__' : rec._migrateRecordTypeId;
						const describe = canvasState.describeCache[rec.objectName] || {};
						const options = (describe.recordTypes || [])
							.map(
								(type) =>
									'<option value="' +
									escapeHtml(type.id) +
									'"' +
									(selectedType === type.id ? ' selected' : '') +
									'>' +
									escapeHtml(type.label || type.name || type.developerName) +
									'</option>',
							)
							.join('');
						return _fieldDifferenceRow(
							'Record type',
							issue.developerName,
							selectedType ? 'Record type selected' : 'Record type unavailable',
							'<select class="mm-difference-input" aria-label="Destination record type" data-mm-recordtype-record="' +
								recordIndex +
								'"><option value="">Choose a destination record type...</option>' +
								options +
								'<option value="__clear__"' +
								(selectedType === '__clear__' ? ' selected' : '') +
								'>No record type</option></select>',
							Boolean(selectedType),
						);
					}
					if (issue.kind === 'picklist-mismatch') {
						const field = _fieldFor(rec, issue.field) || {};
						const optionsFor = (selected) =>
							_picklistValuesForRecordType(field, _effectiveRecordTypeId(rec))
								.filter((value) => value && value.active !== false)
								.map(
									(value) =>
										'<option value="' +
										escapeHtml(value.value) +
										'"' +
										(selected === value.value ? ' selected' : '') +
										'>' +
										escapeHtml(value.label || value.value) +
										'</option>',
								)
								.join('');
						return (issue.invalidValues || [])
							.map((sourceValue) => {
								const remap = rec._migratePicklistRemap?.[issue.field] || {};
								const resolved = Object.prototype.hasOwnProperty.call(remap, sourceValue);
								const selected = resolved ? remap[sourceValue] : undefined;
								return _fieldDifferenceRow(
									fieldLabel,
									sourceValue,
									resolved ? 'Value reviewed' : 'Value unavailable',
									'<select class="mm-difference-input" aria-label="Destination value for ' +
										escapeHtml(fieldLabel) +
										' (' +
										escapeHtml(sourceValue) +
										')" data-mm-picklist-record="' +
										recordIndex +
										'" data-mm-picklist-field="' +
										escapeHtml(issue.field) +
										'" data-mm-picklist-source="' +
										escapeHtml(sourceValue) +
										'">' +
										'<option value="__unresolved__">Omit on upload</option>' +
										optionsFor(selected) +
										'<option value="__drop__"' +
										(selected === '' ? ' selected' : '') +
										">Don't map this value</option></select>",
									resolved,
								);
							})
							.join('');
					}
					return '';
				}

				function _renderDifferences() {
					const all = _allRecords();
					const activeMissingFields = new Set();
					all.forEach((rec, recordIndex) => {
						(_annotationFor(rec).issues || []).forEach((issue) => {
							if (issue.kind === 'missing-field') {
								activeMissingFields.add(_fieldMapKey(recordIndex, issue.field));
							}
						});
					});
					pendingFieldMaps.forEach((_value, key) => {
						if (!activeMissingFields.has(key)) {
							pendingFieldMaps.delete(key);
						}
					});
					resolvedFieldMaps.forEach((resolved, key) => {
						if (!all[resolved.recordIndex]) {
							resolvedFieldMaps.delete(key);
						}
					});
					const recordGroups = [];
					all.forEach((rec, recordIndex) => {
						const annotation = _annotationFor(rec);
						const currentIssues = annotation.issues || [];
						const order = differenceOrder.get(rec) || new Map();
						const issueKey = (issue) =>
							(issue.kind === 'required-reviewed' ? 'required-unfilled' : issue.kind) +
							':' +
							String(issue.field || '').toLowerCase();
						currentIssues.forEach((issue) => {
							const key = issueKey(issue);
							if (!order.has(key)) order.set(key, order.size);
						});
						differenceOrder.set(rec, order);
						const remembered = reviewedChoiceIssues.get(rec) || new Map();
						currentIssues.forEach((issue) => {
							if (
								![
									'picklist-mismatch',
									'recordtype-unresolved',
									'relationship-mismatch',
									'boolean-mismatch',
								].includes(issue.kind)
							)
								return;
							const key = issue.kind + ':' + issue.field;
							const previous = remembered.get(key);
							remembered.set(key, {
								...issue,
								invalidValues: Array.from(
									new Set([...(previous?.invalidValues || []), ...(issue.invalidValues || [])]),
								),
							});
						});
						// Keep editable choices after annotation stops reporting them as problems.
						reviewedChoiceIssues.set(rec, remembered);
						const issues = currentIssues.filter(
							(issue) =>
								![
									'picklist-mismatch',
									'recordtype-unresolved',
									'relationship-mismatch',
									'boolean-mismatch',
								].includes(issue.kind),
						);
						issues.push(...remembered.values());
						_resolvedFieldMapsForRecord(recordIndex).forEach(([, resolved]) => {
							if (
								!issues.some(
									(issue) =>
										issue.kind === 'missing-field' &&
										_fieldMapKey(recordIndex, issue.field) ===
											_fieldMapKey(recordIndex, resolved.sourceField),
								)
							) {
								issues.push({
									kind: 'missing-field',
									field: resolved.sourceField,
									severity: 'resolved',
								});
							}
						});
						reviewedRequiredFields.forEach((reviewed) => {
							const value = _lookup(rec.values, reviewed.field);
							if (
								reviewed.recordIndex === recordIndex &&
								!rec._migrateMatchedId &&
								value != null &&
								value !== '' &&
								!issues.some(
									(issue) =>
										issue.kind === 'required-unfilled' &&
										issue.field.toLowerCase() === reviewed.field.toLowerCase(),
								)
							) {
								issues.push({ kind: 'required-reviewed', field: reviewed.field, severity: 'resolved' });
							}
						});
						issues.forEach((issue) => {
							const key = issueKey(issue);
							if (!order.has(key)) order.set(key, order.size);
						});
						issues.sort((a, b) => order.get(issueKey(a)) - order.get(issueKey(b)));
						const rows = [];
						let attentionCount = 0;
						if (rec._migrateExcluded) {
							rows.push(
								_fieldDifferenceRow(
									'Record',
									null,
									'Excluded from this migration. The saved source canvas is unchanged.',
									'<button type="button" class="button secondary" data-mm-include="' +
										recordIndex +
										'">Include again</button>',
									true,
								),
							);
						} else if (annotation.status === 'pending') {
							attentionCount++;
							rows.push(
								_fieldDifferenceRow(
									'Object',
									rec.objectName,
									'This object is unavailable through the destination connection. It may not exist in that org, your Salesforce user may not have access, or its fields could not be loaded.',
									'<button type="button" class="button secondary" data-mm-exclude-object="' +
										escapeHtml(rec.objectName) +
										'">Exclude object from migration</button> ' +
										'<button type="button" class="button secondary" data-mm-retry-schema="' +
										escapeHtml(rec.objectName) +
										'">Retry</button>',
									false,
								),
							);
						} else {
							issues.forEach((issue) => {
								if (issue.kind === 'excluded-relationship') {
									attentionCount++;
									rows.push(
										_fieldDifferenceRow(
											issue.field || 'Relationship',
											null,
											issue.message,
											'<button type="button" class="button secondary" data-mm-exclude-record="' +
												recordIndex +
												'">Exclude this record too</button>',
											false,
										),
									);
									return;
								}
								const key =
									issue.kind === 'missing-field' ? _fieldMapKey(recordIndex, issue.field) : null;
								const markup = _differenceIssueHtml(rec, issue, recordIndex);
								if (markup) {
									rows.push(markup);
									if (
										(!key || !resolvedFieldMaps.has(key)) &&
										currentIssues.some(
											(active) => active.kind === issue.kind && active.field === issue.field,
										)
									)
										attentionCount++;
								}
							});
						}
						if (!rows.length) return;
						const describe = canvasState.describeCache[rec.objectName];
						const title = _meaningfulRecordLabel(rec, describe) || _differenceRecordLabel(rec);
						const objectLabel = (describe && describe.label) || rec.objectName;
						recordGroups.push(
							'<tbody><tr class="mm-field-record-heading"><th colspan="4" scope="rowgroup"><div><strong>' +
								escapeHtml(title) +
								'</strong><span>' +
								escapeHtml(objectLabel) +
								'</span><span class="mm-field-record-status">' +
								(attentionCount
									? attentionCount + ' to review'
									: rec._migrateExcluded
										? 'Excluded'
										: 'Reviewed') +
								'</span></div></th></tr>' +
								rows.join('') +
								'</tbody>',
						);
					});
					differencesEl.innerHTML = recordGroups.length
						? '<div class="mm-field-table-wrap"><table class="mm-field-table" aria-label="Migration field choices"><colgroup><col class="mm-field-name-col"><col class="mm-field-source-col"><col class="mm-field-target-col"><col></colgroup><thead><tr><th scope="col">Source field</th><th scope="col">Source value</th><th scope="col">Destination field</th><th scope="col">Destination value</th></tr></thead>' +
							recordGroups.join('') +
							'</table></div>'
						: '<div class="mm-difference-empty"><strong>No destination differences need attention.</strong></div>';

					differencesEl.querySelectorAll('[data-mm-retry-schema]').forEach((button) => {
						button.addEventListener('click', async () => {
							const objectName = button.getAttribute('data-mm-retry-schema');
							button.disabled = true;
							button.textContent = 'Retrying...';
							try {
								await ensureDescribe(objectName, { force: true });
								await Promise.resolve(onApplied()).catch(() => null);
							} catch (_err) {
								showBulkToast(
									'This object is still unavailable through the destination connection. You can exclude it from this migration.',
									'warning',
								);
							}
							if (!closed) {
								_renderDifferences();
								_recomputeSummary();
							}
						});
					});

					differencesEl
						.querySelectorAll('[data-mm-exclude-object], [data-mm-exclude-record], [data-mm-include]')
						.forEach((button) => {
							button.addEventListener('click', () => {
								const objectName = button.getAttribute('data-mm-exclude-object');
								if (objectName !== null) {
									all.filter((rec) => rec.objectName === objectName).forEach((rec) => {
										rec._migrateExcluded = true;
									});
								} else {
									const include = button.hasAttribute('data-mm-include');
									const rec =
										all[
											Number(
												button.getAttribute(
													include ? 'data-mm-include' : 'data-mm-exclude-record',
												),
											)
										];
									if (rec) {
										rec._migrateExcluded = !include;
									}
								}
								_afterDifferenceDecision();
							});
						});

					differencesEl.querySelectorAll('[data-mm-relationship-record]').forEach((select) => {
						select.addEventListener('change', () => {
							if (applying) return;
							const rec = all[Number(select.getAttribute('data-mm-relationship-record'))];
							const field = select.getAttribute('data-mm-relationship-field');
							if (!rec || !field) return;
							rec._migrateRelationshipRemap = rec._migrateRelationshipRemap || {};
							if (select.value === '__original__') delete rec._migrateRelationshipRemap[field];
							else rec._migrateRelationshipRemap[field] = select.value;
							_afterDifferenceDecision();
						});
					});
					differencesEl.querySelectorAll('[data-mm-field-resolution]').forEach((select) => {
						select.addEventListener('change', () => {
							const row = select.closest('[data-mm-missing-record]');
							const recordIndex = Number(row.getAttribute('data-mm-missing-record'));
							const rec = all[recordIndex];
							const sourceField = row.getAttribute('data-mm-missing-field');
							const mapKey = _fieldMapKey(recordIndex, sourceField);
							if (resolvedFieldMaps.has(mapKey)) {
								_restoreResolvedFieldMap(rec, mapKey);
							}
							const sourceKey = _valueKey(rec, sourceField);
							if (!select.value) {
								pendingFieldMaps.delete(mapKey);
								_afterDifferenceDecision();
								return;
							}
							if (!rec || !sourceKey) {
								pendingFieldMaps.delete(mapKey);
								_renderDifferences();
								_recomputeSummary();
								return;
							}
							if (select.value === '__omit__') {
								_commitFieldResolution(recordIndex, rec, sourceField, sourceKey, '__omit__');
								_afterDifferenceDecision();
								return;
							}
							const raw = rec.values[sourceKey];
							const targetField = _fieldFor(rec, select.value);
							const disposition = _fieldMapDisposition(raw, targetField, _effectiveRecordTypeId(rec));
							if (disposition === 'choice') {
								pendingFieldMaps.set(mapKey, { targetField: targetField.name });
								_renderDifferences();
								_recomputeSummary();
								return;
							}
							if (disposition === 'incompatible') {
								pendingFieldMaps.delete(mapKey);
								showBulkToast(
									'That destination field cannot safely accept this source value.',
									'warning',
								);
								_renderDifferences();
								_recomputeSummary();
								return;
							}
							pendingFieldMaps.delete(mapKey);
							_commitFieldResolution(recordIndex, rec, sourceField, sourceKey, targetField.name);
							_afterDifferenceDecision();
						});
					});
					differencesEl.querySelectorAll('[data-mm-map-value]').forEach((select) => {
						select.addEventListener('change', () => {
							const recordIndex = Number(select.getAttribute('data-mm-map-record'));
							const rec = all[recordIndex];
							const sourceField = select.getAttribute('data-mm-map-source');
							const targetField = select.getAttribute('data-mm-map-target');
							const mapKey = _fieldMapKey(recordIndex, sourceField);
							if (resolvedFieldMaps.has(mapKey)) {
								_restoreResolvedFieldMap(rec, mapKey);
							}
							const sourceKey = _valueKey(rec, sourceField);
							if (!rec || !sourceKey || !targetField) {
								pendingFieldMaps.delete(mapKey);
								_renderDifferences();
								_recomputeSummary();
								return;
							}
							if (!select.value) {
								pendingFieldMaps.set(mapKey, { targetField: targetField });
								_afterDifferenceDecision();
								return;
							}
							_commitFieldResolution(recordIndex, rec, sourceField, sourceKey, targetField, select.value);
							_afterDifferenceDecision();
						});
					});
					differencesEl.querySelectorAll('[data-mm-boolean-record]').forEach((control) => {
						control.addEventListener('change', () => {
							if (applying) return;
							const rec = all[Number(control.getAttribute('data-mm-boolean-record'))];
							const field = control.getAttribute('data-mm-boolean-field');
							const issue = reviewedChoiceIssues.get(rec)?.get('boolean-mismatch:' + field);
							if (!rec || !issue) return;
							rec.values[field] = control.value === '' ? issue.sourceValue : control.value === 'true';
							_afterDifferenceDecision();
						});
					});
					differencesEl.querySelectorAll('[data-mm-required-record]').forEach((control) => {
						control.addEventListener('change', () => {
							const recordIndex = Number(control.getAttribute('data-mm-required-record'));
							const rec = all[recordIndex];
							const field = control.getAttribute('data-mm-required-field');
							if (!rec || !field) {
								return;
							}
							if (control.value === '') {
								delete rec.values[field];
								reviewedRequiredFields.delete(_fieldMapKey(recordIndex, field));
							} else {
								const fieldDef = _fieldFor(rec, field);
								const value =
									fieldDef && fieldDef.type === 'datetime'
										? _dateTimeFromInput(control.value)
										: control.value;
								if (!value) {
									showBulkToast('Enter a time that exists in your Salesforce time zone.', 'warning');
									return;
								}
								rec.values[field] = value;
								reviewedRequiredFields.set(_fieldMapKey(recordIndex, field), {
									recordIndex: recordIndex,
									field: field,
								});
							}
							_afterDifferenceDecision();
						});
					});
					differencesEl.querySelectorAll('[data-mm-recordtype-record]').forEach((select) => {
						select.addEventListener('change', () => {
							const rec = all[Number(select.getAttribute('data-mm-recordtype-record'))];
							if (!rec || !select.value) {
								return;
							}
							if (select.value === '__clear__') {
								rec._migrateClearRecordType = true;
								delete rec._migrateRecordTypeId;
							} else {
								rec._migrateRecordTypeId = select.value;
								delete rec._migrateClearRecordType;
							}
							_afterDifferenceDecision();
						});
					});
					differencesEl.querySelectorAll('[data-mm-picklist-record]').forEach((select) => {
						select.addEventListener('change', () => {
							const rec = all[Number(select.getAttribute('data-mm-picklist-record'))];
							const field = select.getAttribute('data-mm-picklist-field');
							const sourceValue = select.getAttribute('data-mm-picklist-source');
							if (!rec || !field) {
								return;
							}
							rec._migratePicklistRemap = rec._migratePicklistRemap || {};
							rec._migratePicklistRemap[field] = rec._migratePicklistRemap[field] || {};
							if (select.value === '__unresolved__') {
								delete rec._migratePicklistRemap[field][sourceValue];
							} else {
								rec._migratePicklistRemap[field][sourceValue] =
									select.value === '__drop__' ? '' : select.value;
							}
							_afterDifferenceDecision();
						});
					});
				}

				function _afterDifferenceDecision() {
					onApplied();
					renderBulkView();
					_renderDifferences();
					_recomputeSummary();
				}

				function _renderFinalReview() {
					// Applying compiles the reviewed plan into ordinary canvas records; Upload remains separate.
					const status = _statusCounts();
					const differences = _differenceCounts();
					const omitted = differences.unavailableValues + differences.omittedPicklistValues;
					const omissionItem =
						omitted > 0
							? '<li class="is-warn"><strong>' +
								omitted +
								' field value' +
								(omitted === 1 ? '' : 's') +
								' will be omitted.</strong> Return to Fields if you want to map them. Unmapped values do not clear or overwrite destination data.</li>'
							: '';
					finalReviewEl.innerHTML =
						'<div class="mm-plan-summary" aria-label="Migration record plan">' +
						'<div><strong>' +
						status.updates +
						'</strong><span>Existing record' +
						(status.updates === 1 ? '' : 's') +
						' to update</span></div>' +
						'<div><strong>' +
						status.creates +
						'</strong><span>New record' +
						(status.creates === 1 ? '' : 's') +
						' to create</span></div>' +
						(status.deletes
							? '<div><strong>' +
								status.deletes +
								'</strong><span>Existing record' +
								(status.deletes === 1 ? '' : 's') +
								' to delete</span></div>'
							: '') +
						'</div>' +
						'<div class="mm-before-upload"><strong>Apply to canvas</strong><ul>' +
						'<li>The plan will only apply your choices to your canvas. Nothing will be written to Salesforce.</li>' +
						(status.deletes
							? '<li>Deletions are staged on the canvas. Records are only deleted in Salesforce when you upload and confirm deletion.</li>'
							: '') +
						omissionItem +
						(status.excluded
							? '<li><strong>' +
								status.excluded +
								(status.excluded === 1 ? ' record excluded.' : ' records excluded.') +
								'</strong> Excluded records and their canvas links will not be added to the destination canvas or uploaded. Optional relationships to them are omitted; the saved source canvas is unchanged.</li>'
							: '') +
						'</ul></div>';
				}

				function _differenceRecordLabel(rec) {
					const describe = canvasState.describeCache[rec.objectName];
					return _recordDisplayLabel(rec, describe, _allRecords(), recordOrdinal ? recordOrdinal(rec) : null);
				}

				function _recordOpenUrl(rec, id = rec._migrateMatchedId) {
					const sfBase = (window.SF_INSTANCE_URL || '').replace(/\/+$/, '');
					return id && sfBase
						? sfBase +
								'/lightning/r/' +
								encodeURIComponent(rec.objectName) +
								'/' +
								encodeURIComponent(id) +
								'/view'
						: '';
				}

				function _canvasIdentity(rec, index) {
					const describe = canvasState.describeCache[rec.objectName];
					const objectLabel = (describe && describe.label) || rec.objectName;
					const title = _meaningfulRecordLabel(rec, describe) || _differenceRecordLabel(rec);
					const fields = (describe && describe.fields) || [];
					const details = Object.entries(rec.values || {})
						.filter(([name, value]) => {
							const field = fields.find((item) => item.name === name);
							return (
								!rec._inaccessible &&
								value !== null &&
								value !== undefined &&
								value !== '' &&
								!(field && (field.encrypted || field.type === 'encryptedstring'))
							);
						})
						.map(([name, value]) => {
							const field = fields.find((item) => item.name === name);
							return (
								'<dt>' +
								escapeHtml((field && field.label) || name) +
								'</dt><dd>' +
								escapeHtml(_displayValue(value)) +
								'</dd>'
							);
						})
						.join('');
					return (
						'<div class="mm-record-name-line"><strong class="mm-record-identity">' +
						escapeHtml(title) +
						'</strong><button type="button" class="mm-inspect-record" aria-label="Inspect ' +
						escapeHtml(title) +
						'" aria-expanded="false" aria-controls="mm-record-preview-' +
						index +
						'">ⓘ</button></div>' +
						'<span class="mm-record-object">' +
						escapeHtml(objectLabel) +
						'</span>' +
						'<div class="mm-record-preview" id="mm-record-preview-' +
						index +
						'" popover="auto" role="dialog" aria-label="Record details: ' +
						escapeHtml(title) +
						'">' +
						'<strong>' +
						escapeHtml(title) +
						'</strong><dl>' +
						details +
						'</dl>' +
						(details ? '' : '<p>No populated fields.</p>') +
						'</div>'
					);
				}

				function _destinationCandidates(rec) {
					const state = _destinationSearchState(rec);
					const source = state.query.trim() ? state.results : rec._migrateMatchCandidates || [];
					const byId = new Map();
					(rec._migrateMatchCandidates || []).forEach((candidate) => {
						if (candidate && candidate.id === rec._migrateMatchedId) {
							byId.set(candidate.id, candidate);
						}
					});
					source.forEach((candidate) => {
						if (candidate && candidate.id && !byId.has(candidate.id)) {
							byId.set(candidate.id, candidate);
						}
					});
					return Array.from(byId.values());
				}

				function _destinationResultsMarkup(rec, all) {
					const state = _destinationSearchState(rec);
					if (state.loading) {
						return '<div class="mm-search-status">Searching Salesforce...</div>';
					}
					if (state.error) {
						return (
							'<div class="mm-search-status mm-search-status--error">' +
							escapeHtml(state.error) +
							'</div>'
						);
					}
					const candidates = _destinationCandidates(rec);
					if (!candidates.length) {
						return state.query.trim()
							? '<div class="mm-search-status">No destination records found.</div>'
							: '';
					}
					return candidates
						.map((candidate) => {
							const selected = candidate.id === rec._migrateMatchedId;
							const claimedByOther = all.some(
								(other) => other && other !== rec && other._migrateMatchedId === candidate.id,
							);
							const openUrl = _recordOpenUrl(rec, candidate.id);
							const details = _candidateDetailLines(candidate, candidates)
								.map((line) => '<small>' + escapeHtml(line) + '</small>')
								.join('');
							return (
								'<div class="mm-candidate-row" role="listitem"><button type="button" class="mm-search-result' +
								(selected ? ' is-selected' : '') +
								'" data-mm-destination-id="' +
								escapeHtml(candidate.id) +
								'" aria-pressed="' +
								(selected ? 'true' : 'false') +
								'"' +
								' title="' +
								escapeHtml(candidate.id) +
								'"' +
								(claimedByOther ? ' disabled' : '') +
								'><span><strong>' +
								escapeHtml(candidate.label || '(no name)') +
								'</strong>' +
								details +
								(claimedByOther ? '<small>Already selected for another canvas record</small>' : '') +
								'</span>' +
								(selected ? '<span class="mm-search-selected">Selected</span>' : '') +
								'</button>' +
								(openUrl
									? '<a class="mm-preview-destination" href="' +
										escapeHtml(openUrl) +
										'" target="_blank" rel="noopener" aria-label="Open ' +
										escapeHtml(candidate.label || candidate.id) +
										' in Salesforce (' +
										escapeHtml(candidate.id) +
										')" title="Open in Salesforce">↗</a>'
									: '') +
								'</div>'
							);
						})
						.join('');
				}

				function _renderDestinationSearchResults(rec) {
					const index = _allRecords().indexOf(rec);
					const card = decisionsEl.querySelector('[data-mm-record-index="' + index + '"]');
					const results = card && card.querySelector('.mm-search-results');
					if (results) {
						results.hidden = !_destinationSearchState(rec).open;
						results.innerHTML = _destinationResultsMarkup(rec, _allRecords());
					}
					const matchOptions = card && card.querySelector('.mm-match-options');
					if (matchOptions) {
						matchOptions.hidden = !_showAdvancedMatchOptions(rec);
					}
				}

				function _showAdvancedMatchOptions(rec) {
					const state = _destinationSearchState(rec);
					return Boolean(
						rec._migrateMatchSearchError ||
							(state.attempted && !state.loading && (state.error || state.results.length === 0)),
					);
				}

				function _decisionRow(rec, index, all) {
					const destinationSearch = _destinationSearchState(rec);
					const pending = pendingMatches.has(rec);
					const action = rec._migrateExcluded
						? 'exclude'
						: rec._migrateMatchedId || rec._migrateMatchIntent === 'existing'
							? 'existing'
							: 'new';
					const needsDecision = action === 'existing' && !rec._migrateMatchedId;
					let badge = '';
					if (pending) {
						badge = '<span class="mm-plan-badge">Searching...</span>';
					} else if (rec._migrateMatchSearchError) {
						badge = '<span class="mm-plan-badge mm-plan-badge--warn">Search failed</span>';
					}
					const describe = canvasState.describeCache[rec.objectName];
					const objectLabel =
						(describe && describe.labelPlural) || (describe && describe.label) || rec.objectName;
					const searchControl =
						'<div class="mm-search-input-wrap"><input id="mm-destination-search-' +
						index +
						'" aria-label="Search destination ' +
						escapeHtml(objectLabel) +
						'" class="mm-destination-search" type="search" autocomplete="off" aria-controls="mm-search-results-' +
						index +
						'" aria-expanded="' +
						(destinationSearch.open ? 'true' : 'false') +
						'" placeholder="Search..." value="' +
						escapeHtml(destinationSearch.query) +
						'"></div><div id="mm-search-results-' +
						index +
						'" class="mm-search-results" role="list" aria-label="Destination records"' +
						(destinationSearch.open ? '' : ' hidden') +
						'>' +
						_destinationResultsMarkup(rec, all) +
						'</div>';
					const keyFields = _keyCandidates(canvasState.describeCache[rec.objectName]).filter((field) => {
						const value = _lookup(rec.values, field.name);
						return value !== null && value !== undefined && String(value) !== '';
					});
					const keyOptions = keyFields
						.map(
							(field) =>
								'<option value="' +
								escapeHtml(field.name) +
								'"' +
								(rec._migrateMatchKey === field.name ? ' selected' : '') +
								'>' +
								escapeHtml(field.label || field.name) +
								' (' +
								escapeHtml(field.name) +
								')' +
								escapeHtml(_tierLabel(field)) +
								'</option>',
						)
						.join('');
					const searchMessage =
						action === 'existing' && rec._migrateMatchSearchError
							? '<div class="mm-search-error"><span>' +
								escapeHtml(rec._migrateMatchSearchError) +
								'</span><button type="button" class="link-button" data-mm-retry-search>Retry</button></div>'
							: '';
					const showMatchOptions = _showAdvancedMatchOptions(rec);
					const matchOptions =
						action === 'existing'
							? '<details class="mm-match-options"' +
								(showMatchOptions ? '' : ' hidden') +
								(rec._migrateMatchSearchError ? ' open' : '') +
								'><summary>Try another identifying field</summary>' +
								(keyOptions
									? '<label>Identifying field for this record</label><select class="mm-record-key-select"><option value="">Choose a field...</option>' +
										keyOptions +
										'</select>'
									: '<p>No populated, queryable identifying fields are available on this record.</p>') +
								'<small>This changes suggestions for this record only.</small></details>'
							: '';
					const openUrl = _recordOpenUrl(rec);
					const selectedCandidate = _destinationCandidates(rec).find(
						(candidate) => candidate.id === rec._migrateMatchedId,
					);
					const targetControl =
						openUrl && !destinationSearch.open
							? '<div class="mm-selected-destination"><a class="mm-open-record" href="' +
								escapeHtml(openUrl) +
								'" target="_blank" rel="noopener" title="Open in Salesforce">' +
								escapeHtml((selectedCandidate && selectedCandidate.label) || rec._migrateMatchedId) +
								'</a><button type="button" class="link-button" data-mm-change-destination>Change</button></div>'
							: searchControl;
					return (
						'<tr class="mm-decision-card' +
						(needsDecision || rec._migrateMatchSearchError ? ' mm-decision-card--needs' : '') +
						'" data-mm-record-index="' +
						index +
						'">' +
						'<td><div class="mm-decision-head">' +
						_canvasIdentity(rec, index) +
						badge +
						'</div></td><td><fieldset class="mm-action-segments" aria-label="Action for ' +
						escapeHtml(_differenceRecordLabel(rec)) +
						'"' +
						(pending ? ' disabled' : '') +
						'><label><input class="mm-action-radio" type="radio" name="mm-action-' +
						index +
						'" value="new"' +
						(action === 'new' ? ' checked' : '') +
						'><span>Create new</span></label>' +
						'<label><input class="mm-action-radio" type="radio" name="mm-action-' +
						index +
						'" value="existing"' +
						(action === 'existing' ? ' checked' : '') +
						'><span>' +
						(rec.pendingDelete ? 'Delete existing' : 'Update existing') +
						'</span></label>' +
						'<label><input class="mm-action-radio" type="radio" name="mm-action-' +
						index +
						'" value="exclude"' +
						(action === 'exclude' ? ' checked' : '') +
						'><span>Exclude</span></label>' +
						'</fieldset></td><td>' +
						searchMessage +
						(action === 'exclude'
							? '<span class="mm-new-destination">Not included in this migration</span>'
							: '') +
						(action === 'new' ? '<span class="mm-new-destination">New record</span>' : '') +
						'<fieldset class="mm-target-controls"' +
						(pending ? ' disabled' : '') +
						'>' +
						'<div class="mm-target-choice"' +
						(action === 'existing' ? '' : ' hidden') +
						'>' +
						targetControl +
						'</div>' +
						'</fieldset>' +
						matchOptions +
						'</td></tr>'
					);
				}

				function _renderRecordDecisions() {
					const all = _allRecords();
					decisionsEl.innerHTML = all.length
						? '<table class="mm-record-table" aria-label="Migration record choices"><thead><tr><th scope="col">Record</th><th scope="col">Action</th><th scope="col">Destination record</th></tr></thead><tbody>' +
							all.map((rec, index) => _decisionRow(rec, index, all)).join('') +
							'</tbody></table>'
						: '<div class="mm-empty-differences"><strong>No records to migrate</strong><span>Add records to the canvas before starting a migration.</span></div>';
					decisionsEl.querySelectorAll('.mm-decision-card').forEach((card) => {
						const rec = all[Number(card.getAttribute('data-mm-record-index'))];
						const inspect = card.querySelector('.mm-inspect-record');
						const preview = card.querySelector('.mm-record-preview');
						if (inspect && preview) {
							let pinned = false;
							const showPreview = () => {
								preview.showPopover();
								const anchor = inspect.getBoundingClientRect();
								const rect = preview.getBoundingClientRect();
								preview.style.left =
									Math.max(8, Math.min(anchor.left, window.innerWidth - rect.width - 8)) + 'px';
								preview.style.top =
									Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - rect.height - 8)) +
									'px';
							};
							const hidePreview = () => {
								if (
									!pinned &&
									!preview.matches(':hover') &&
									document.activeElement !== inspect &&
									!preview.contains(document.activeElement)
								)
									preview.hidePopover();
							};
							inspect.addEventListener('mouseenter', showPreview);
							inspect.addEventListener('focus', showPreview);
							inspect.addEventListener('mouseleave', () => setTimeout(hidePreview, 150));
							preview.addEventListener('mouseleave', hidePreview);
							inspect.addEventListener('blur', () => setTimeout(hidePreview, 0));
							inspect.addEventListener('click', () => {
								pinned = !pinned;
								if (pinned) showPreview();
								else preview.hidePopover();
							});
							preview.addEventListener('toggle', () => {
								const open = preview.matches(':popover-open');
								inspect.setAttribute('aria-expanded', String(open));
								if (!open) pinned = false;
							});
						}
						card.querySelectorAll('.mm-action-radio').forEach((radio) => {
							radio.addEventListener('change', () => {
								if (!radio.checked) return;
								if (applying) return;
								const restoreActionFocus = () =>
									decisionsEl
										.querySelector(
											'[data-mm-record-index="' +
												card.getAttribute('data-mm-record-index') +
												'"] .mm-action-radio:checked',
										)
										?.focus({ preventScroll: true });
								rec._migrateExcluded = radio.value === 'exclude';
								if (rec._migrateExcluded) {
									delete rec._migrateMatchedId;
									delete rec.loadedFromId;
									_afterRecordDecision();
									restoreActionFocus();
									return;
								}
								if (radio.value === 'new') {
									_resolveRecord(rec, 'new', all);
									delete rec._migrateMatchSearchError;
								} else {
									const available = (rec._migrateMatchCandidates || []).filter(
										(candidate) =>
											!all.some(
												(other) =>
													other && other !== rec && other._migrateMatchedId === candidate.id,
											),
									);
									let searchField = '';
									if (available.length === 1) {
										_resolveRecord(rec, available[0].id, all);
										_collapseDestinationSearch(rec, available[0]);
									} else {
										_resolveRecord(rec, 'update', all);
										if (available.length === 0 && !rec._migrateMatchSearched) {
											searchField = (_preferredKeyForRecord(rec) || {}).name || '';
											if (!searchField) {
												rec._migrateMatchSearched = true;
											}
										}
									}
									_afterRecordDecision();
									restoreActionFocus();
									if (searchField) {
										_runMatchForRecord(rec, searchField);
									}
									return;
								}
								_afterRecordDecision();
								restoreActionFocus();
							});
						});
						const changeDestination = card.querySelector('[data-mm-change-destination]');
						if (changeDestination) {
							changeDestination.addEventListener('click', () => {
								_destinationSearchState(rec).open = true;
								_renderRecordDecisions();
								const input = decisionsEl.querySelector(
									'[data-mm-record-index="' + all.indexOf(rec) + '"] .mm-destination-search',
								);
								if (input) {
									input.focus();
									input.select();
								}
							});
						}
						const destinationInput = card.querySelector('.mm-destination-search');
						if (destinationInput) {
							destinationInput.addEventListener('input', () => {
								const state = _destinationSearchState(rec);
								state.query = destinationInput.value;
								state.open = true;
								state.error = '';
								state.sequence++;
								clearTimeout(state.timer);
								if (!state.query.trim()) {
									state.results = [];
									state.attempted = false;
									state.loading = false;
									_renderDestinationSearchResults(rec);
									return;
								}
								state.loading = true;
								_renderDestinationSearchResults(rec);
								state.timer = setTimeout(() => _searchDestinationRecords(rec), 250);
							});
						}
						const destinationResults = card.querySelector('.mm-search-results');
						if (destinationResults) {
							destinationResults.addEventListener('click', (event) => {
								const button = event.target.closest('[data-mm-destination-id]');
								if (!button || button.disabled) {
									return;
								}
								const id = button.getAttribute('data-mm-destination-id');
								const candidate = _destinationCandidates(rec).find((item) => item.id === id);
								if (candidate && !(rec._migrateMatchCandidates || []).some((item) => item.id === id)) {
									rec._migrateMatchCandidates = (rec._migrateMatchCandidates || []).concat([
										candidate,
									]);
								}
								const result = _resolveRecord(rec, id, all);
								if (!result.ok && result.error === 'candidate-already-used') {
									showBulkToast(
										'That Salesforce record is already matched to another canvas record.',
										'warning',
									);
								}
								if (result.ok) {
									_collapseDestinationSearch(rec, candidate);
								}
								_afterRecordDecision();
							});
						}
						const keySelect = card.querySelector('.mm-record-key-select');
						if (keySelect) {
							keySelect.addEventListener('change', () => {
								if (keySelect.value) {
									_runMatchForRecord(rec, keySelect.value);
								}
							});
						}
						const retry = card.querySelector('[data-mm-retry-search]');
						if (retry) {
							retry.addEventListener('click', () => {
								const preferred = rec._migrateMatchKey || (_preferredKeyForRecord(rec) || {}).name;
								if (preferred) {
									_runMatchForRecord(rec, preferred);
								}
							});
						}
					});
					_recomputeSummary();
				}

				async function _runMatchForRecord(rec, keyField) {
					const all = _allRecords();
					const value = _matchValue(rec, keyField);
					const token = {};
					_clearMatchState(rec);
					rec._migrateMatchSearched = true;
					rec._migrateMatchKey = keyField;
					rec._migrateMatchValue = value == null ? '' : String(value);
					rec._migrateMatchAmbiguous = true;
					rec._migrateMatchIntent = 'existing';
					pendingMatches.set(rec, token);
					_renderRecordDecisions();
					if (value === null || value === undefined || String(value) === '') {
						_markUpdateWithoutMatch(rec);
					} else {
						const result = await _requestMatches(rec.objectName, keyField, [String(value)]);
						if (closed || pendingMatches.get(rec) !== token) {
							return;
						}
						if (!result.ok) {
							rec._migrateMatchCandidates = [];
							rec._migrateMatchSearchError = result.error;
							rec._migrateMatchAmbiguous = true;
							rec._migrateMatchIntent = 'existing';
							delete rec._migrateMatchResolution;
						} else {
							delete rec._migrateMatchAmbiguous;
							_applyMatchResponse([rec], keyField, result.data);
							if (!rec._migrateMatchedId && !rec._migrateMatchAmbiguous) {
								_markUpdateWithoutMatch(rec);
							} else if (
								rec._migrateMatchedId &&
								all.some(
									(other) =>
										other && other !== rec && other._migrateMatchedId === rec._migrateMatchedId,
								)
							) {
								delete rec.loadedFromId;
								delete rec._migrateMatchedId;
								delete rec._migrateMatchResolution;
								rec._migrateMatchAmbiguous = true;
								rec._migrateMatchIntent = 'existing';
							}
							if (rec._migrateMatchedId) {
								_collapseDestinationSearch(
									rec,
									(rec._migrateMatchCandidates || []).find(
										(candidate) => candidate.id === rec._migrateMatchedId,
									),
								);
							}
						}
					}
					if (pendingMatches.get(rec) === token) {
						pendingMatches.delete(rec);
					}
					_afterRecordDecision();
				}

				function _afterRecordDecision() {
					_renderRecordDecisions();
					_recomputeSummary();
					renderBulkView();
					onApplied();
				}

				function _statusCounts() {
					return _recordPlanCounts(_allRecords());
				}

				function _updateFooter(counts) {
					overlay.setAttribute('aria-busy', String(applying));
					overlay.querySelector('button[data-mm-close]').disabled = applying;
					backBtn.disabled = applying;
					overlay.querySelectorAll('[data-mm-step]').forEach((stepBtn) => {
						stepBtn.disabled = applying;
					});
					if (applying) {
						primaryBtn.disabled = true;
						primaryBtn.textContent = 'Applying to canvas…';
						return;
					}
					counts = counts || _statusCounts();
					const pending = pendingMatches.size;
					const pendingFieldMapCount = pendingFieldMaps.size;
					const differences = _differenceCounts();
					const differencesStep = overlay.querySelector('[data-mm-step="differences"]');
					const reviewStep = overlay.querySelector('[data-mm-step="review"]');
					differencesStep.disabled = !describesReady || pending > 0 || counts.unresolved > 0;
					reviewStep.disabled =
						differencesStep.disabled ||
						counts.total === 0 ||
						differences.blocked > 0 ||
						differences.pending > 0 ||
						pendingFieldMapCount > 0;
					if (currentStep === 'matches') {
						primaryBtn.disabled = !describesReady || pending > 0 || counts.unresolved > 0;
						primaryBtn.textContent = !describesReady
							? 'Loading fields…'
							: pending > 0
								? 'Searching for ' + pending + ' record' + (pending === 1 ? '' : 's') + '…'
								: counts.unresolved > 0
									? 'Resolve ' +
										counts.unresolved +
										' record decision' +
										(counts.unresolved === 1 ? '' : 's')
									: 'Continue to fields';
						return;
					}
					if (currentStep === 'differences') {
						primaryBtn.disabled =
							counts.total === 0 ||
							differences.blocked > 0 ||
							differences.pending > 0 ||
							pendingFieldMapCount > 0;
						primaryBtn.textContent =
							counts.total === 0
								? 'No records included'
								: differences.pending > 0
									? 'Resolve unavailable objects'
									: differences.blocked > 0
										? differences.requiredFields === differences.blocked
											? 'Complete ' +
												differences.requiredFields +
												' required field' +
												(differences.requiredFields === 1 ? '' : 's')
											: 'Resolve ' +
												differences.blocked +
												' required item' +
												(differences.blocked === 1 ? '' : 's')
										: pendingFieldMapCount > 0
											? 'Choose ' +
												pendingFieldMapCount +
												' destination value' +
												(pendingFieldMapCount === 1 ? '' : 's')
											: 'View summary';
						return;
					}
					primaryBtn.disabled = reviewStep.disabled;
					primaryBtn.textContent = 'Apply migration to canvas';
				}

				function _recomputeSummary() {
					const counts = _statusCounts();
					const differences = _differenceCounts();
					const attention =
						counts.unresolved + differences.blocked + differences.warnings + differences.pending;
					summaryEl.innerHTML =
						'<div class="mm-summary-line"><span><strong>' +
						counts.updates +
						'</strong> existing record' +
						(counts.updates === 1 ? '' : 's') +
						' to update</span><i>\u00b7</i><span><strong>' +
						counts.creates +
						'</strong> new record' +
						(counts.creates === 1 ? '' : 's') +
						' to create</span>' +
						(counts.deletes
							? '<i>\u00b7</i><span><strong>' +
								counts.deletes +
								'</strong> existing record' +
								(counts.deletes === 1 ? '' : 's') +
								' to delete</span>'
							: '') +
						'<i>\u00b7</i><span class="' +
						(attention ? 'is-warn' : 'is-ready') +
						'">' +
						(attention ? attention + ' need' + (attention === 1 ? 's' : '') + ' attention' : 'Ready') +
						'</span></div>';
					_updateFooter(counts);
				}
			}

			return { open: open };
		},
		_test: {
			recordPlanCounts: _recordPlanCounts,
			applyMatchResponse: _applyMatchResponse,
			resolveRecord: _resolveRecord,
			clearMatchState: _clearMatchState,
			keyCandidates: _keyCandidates,
			preferredKeyCandidate: _preferredKeyCandidate,
			fieldMapDisposition: _fieldMapDisposition,
			automaticFieldCandidate: _automaticFieldCandidate,
			recordDisplayLabel: _recordDisplayLabel,
			searchCandidate: _searchCandidate,
			candidateDetailLines: _candidateDetailLines,
		},
	};
})();

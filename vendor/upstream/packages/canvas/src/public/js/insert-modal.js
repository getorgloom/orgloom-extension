(function () {
	'use strict';
	// Builds the record editor from live Salesforce describe data and enforces FLS in the UI.

	window.OrgLoom = window.OrgLoom || {};

	// Keep only edited fields in memory. File-export projections are not undo snapshots.
	function registerFieldEditUndo(deps, record, previousValues, fields, previousAssociations) {
		if (!deps.pushUndo || !fields.length) return;
		const state = deps.canvasState;
		const copy = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
		const before = {};
		const after = {};
		for (const field of fields) {
			if (Object.hasOwn(previousValues, field)) before[field] = copy(previousValues[field]);
			after[field] = copy(record.values[field]);
		}
		const relevant = (a) => a.fromId === record.id && fields.includes(a.fieldName);
		const oldLinks = copy(previousAssociations.filter(relevant));
		const savedLinks = JSON.stringify(state.bulkAssociations.filter(relevant));
		const baseline = record.loadedValues;
		const baselineData = JSON.stringify(fields.map((field) => baseline?.[field]));
		const loadedId = record.loadedFromId;
		const canvasId = state.currentCanvas?.id;
		deps.pushUndo('Undo record edit', async (isCurrent = () => true) => {
			const assertCurrent = (committed = false) => {
				if (
					!isCurrent() ||
					state.currentCanvas?.id !== canvasId ||
					!state.bulkRecords.includes(record) ||
					record._inaccessible ||
					record._permissionHidden ||
					record.pendingDelete ||
					record.loadedFromId !== loadedId ||
					record.loadedValues !== baseline ||
					JSON.stringify(fields.map((field) => record.loadedValues?.[field])) !== baselineData ||
					!deps.canUndoFields(record, fields) ||
					fields.some(
						(field) =>
							!window.OrgLoom.valueCompare.valuesEquivalent(record.values[field], after[field]) &&
							!(
								committed &&
								window.OrgLoom.valueCompare.valuesEquivalent(record.values[field], restored[field])
							),
					) ||
					JSON.stringify(state.bulkAssociations.filter(relevant)) !== savedLinks ||
					oldLinks.some((a) => !state.bulkRecords.some((r) => r.id === a.toId))
				) {
					const error = new Error(
						'This edit can no longer be undone because the record, its access, or its saved values changed.',
					);
					error.undoDiscard = true;
					throw error;
				}
			};
			assertCurrent();
			const restored = Object.fromEntries(
				fields.map((field) => [field, before[field] === undefined ? null : copy(before[field])]),
			);
			// Linked fields can omit their literal ID locally; peers still need the actual target ID.
			for (const link of oldLinks) {
				const target = state.bulkRecords.find((r) => r.id === link.toId);
				if (target?.loadedFromId) restored[link.fieldName] = target.loadedFromId;
			}
			try {
				await deps.commitRecordFields(record, restored, {
					relationshipFields: fields.filter((field) => oldLinks.some((a) => a.fieldName === field)),
					beforeCommit: assertCurrent,
				});
				assertCurrent(true);
				for (const field of fields) {
					if (Object.hasOwn(before, field)) record.values[field] = copy(before[field]);
					else delete record.values[field];
				}
				state.bulkAssociations = state.bulkAssociations.filter((a) => !relevant(a)).concat(copy(oldLinks));
				record._valuesRevision = (Number(record._valuesRevision) || 0) + 1;
				deps.onFieldsUndone?.(record, restored);
				deps.renderChips();
				deps.renderBulkView();
				deps.showBulkToast('Undid record changes.');
			} finally {
				deps.releaseRecordFieldLocks(record);
			}
		});
	}

	function dateTimeForInput(value) {
		const api = window.OrgLoom && window.OrgLoom.datetime;
		if (api && typeof api.toDateTimeLocal === 'function') {
			return api.toDateTimeLocal(value);
		}
		const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
		return match ? match[1] : '';
	}

	function dateTimeFromInput(value) {
		const api = window.OrgLoom && window.OrgLoom.datetime;
		if (api && typeof api.fromDateTimeLocal === 'function') {
			return api.fromDateTimeLocal(value);
		}
		const parsed = new Date(value);
		return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
	}

	function applyLoadedRecordUnlink(canvasState, targetRecord) {
		if (!canvasState || !targetRecord || !targetRecord.loadedFromId) return;
		const originalId = targetRecord.loadedFromId;
		const fields = canvasState.describeCache?.[targetRecord.objectName]?.fields || [];
		const excludedFields = new Set(
			fields
				.filter((field) => field.createable === false || field.calculated || field.autoNumber)
				.map((field) => field.name),
		);
		// An unlinked record becomes a new draft. Do not carry fields Salesforce
		// only returns on existing records into that draft's create payload.
		for (const name of Object.keys(targetRecord.values || {})) {
			if (name === 'Id' || name === 'attributes' || excludedFields.has(name)) delete targetRecord.values[name];
		}
		const recordsById = new Map((canvasState.bulkRecords || []).map((record) => [record.id, record]));
		canvasState.bulkAssociations = (canvasState.bulkAssociations || []).filter((association) => {
			if (association?.fromId === targetRecord.id && excludedFields.has(association.fieldName)) return false;
			if (!association || association.toId !== targetRecord.id) return true;
			const holder = recordsById.get(association.fromId);
			// Preserve the lookup after removing the canvas link, including association-only values.
			if (holder && !holder.isTypeNode && !holder.isPending && association.fieldName) {
				holder.values = holder.values || {};
				holder.values[association.fieldName] = originalId;
			}
			return false;
		});
		targetRecord.loadedFromId = null;
	}

	function formatCarryoverValue(value) {
		if (value === null || value === undefined || value === '') {
			return '';
		}
		if (typeof value !== 'object') {
			return String(value);
		}
		try {
			const serialized = JSON.stringify(value, null, 2);
			return serialized === undefined ? '(structured value)' : serialized;
		} catch (_error) {
			return '(structured value)';
		}
	}

	function isSalesforceTrue(value) {
		if (value === true || value === 1) {
			return true;
		}
		if (typeof value !== 'string') {
			return false;
		}
		const normalized = value.trim().toLowerCase();
		return normalized === 'true' || normalized === '1';
	}

	function formatReadOnlyFieldValue(value, fieldType) {
		if (value === null || value === undefined || value === '') {
			return '';
		}
		if (fieldType === 'boolean') {
			return isSalesforceTrue(value) ? 'Yes' : 'No';
		}
		if (fieldType === 'time') {
			return formatTimeChoice(value) || formatCarryoverValue(value);
		}
		if (fieldType === 'datetime') {
			const api = window.OrgLoom && window.OrgLoom.datetime;
			if (api && typeof api.formatDateTime === 'function') {
				return api.formatDateTime(value);
			}
		}
		if (Array.isArray(value)) {
			return value.join('; ');
		}
		return formatCarryoverValue(value);
	}

	// Salesforce returns rich text as HTML. Parse only the pieces needed for a plain-text
	// textarea; never feed the Salesforce value back through a browser HTML sink.
	const richTextBlockEndTags = new Set(['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr']);
	const richTextNamedEntities = Object.freeze({
		amp: '&',
		apos: "'",
		bull: '\u2022',
		copy: '\u00a9',
		gt: '>',
		hellip: '\u2026',
		ldquo: '\u201c',
		lsquo: '\u2018',
		lt: '<',
		mdash: '\u2014',
		middot: '\u00b7',
		nbsp: '\u00a0',
		ndash: '\u2013',
		quot: '"',
		rdquo: '\u201d',
		reg: '\u00ae',
		rsquo: '\u2019',
		trade: '\u2122',
	});

	function isAsciiLetter(character) {
		return !!character && /[A-Za-z]/.test(character);
	}

	function richTextTagAt(markup, start) {
		if (markup.startsWith('<!--', start)) {
			const commentEnd = markup.indexOf('-->', start + 4);
			return commentEnd < 0 ? null : { end: commentEnd + 2, lineBreak: false };
		}
		let nameStart = start + 1;
		let closing = false;
		if (markup[nameStart] === '/') {
			closing = true;
			nameStart += 1;
		}
		const declaration = markup[nameStart] === '!' || markup[nameStart] === '?';
		if (!declaration && !isAsciiLetter(markup[nameStart])) {
			return null;
		}
		let quote = null;
		let end = nameStart;
		for (; end < markup.length; end += 1) {
			const character = markup[end];
			if (quote) {
				if (character === quote) {
					quote = null;
				}
				continue;
			}
			if (character === '"' || character === "'") {
				quote = character;
				continue;
			}
			if (character === '>') {
				break;
			}
		}
		if (end >= markup.length) {
			return null;
		}
		let nameEnd = nameStart;
		while (nameEnd < end && /[A-Za-z0-9]/.test(markup[nameEnd])) {
			nameEnd += 1;
		}
		const name = declaration ? '' : markup.slice(nameStart, nameEnd).toLowerCase();
		return {
			end,
			lineBreak: (!closing && name === 'br') || (closing && richTextBlockEndTags.has(name)),
		};
	}

	function richTextEntityAt(markup, start) {
		const end = markup.indexOf(';', start + 1);
		if (end < 0 || end - start > 32) {
			return null;
		}
		const encoded = markup.slice(start + 1, end);
		const named = richTextNamedEntities[encoded.toLowerCase()];
		if (named !== undefined) {
			return { end, text: named };
		}
		let digits = '';
		let radix = 10;
		if (encoded.startsWith('#x') || encoded.startsWith('#X')) {
			digits = encoded.slice(2);
			radix = 16;
		} else if (encoded.startsWith('#')) {
			digits = encoded.slice(1);
		}
		if (!digits || !(radix === 16 ? /^[0-9a-f]+$/i : /^\d+$/).test(digits)) {
			return null;
		}
		const codePoint = Number.parseInt(digits, radix);
		if (!Number.isSafeInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
			return { end, text: '\ufffd' };
		}
		if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
			return { end, text: '\ufffd' };
		}
		return { end, text: String.fromCodePoint(codePoint) };
	}

	function richTextForEditor(value) {
		if (value === null || value === undefined || value === '') {
			return '';
		}
		const markup = String(value);
		let text = '';
		for (let index = 0; index < markup.length; index += 1) {
			if (markup[index] === '<') {
				const tag = richTextTagAt(markup, index);
				if (tag) {
					if (tag.lineBreak) {
						text += '\n';
					}
					index = tag.end;
					continue;
				}
			}
			if (markup[index] === '&') {
				const entity = richTextEntityAt(markup, index);
				if (entity) {
					text += entity.text;
					index = entity.end;
					continue;
				}
			}
			text += markup[index];
		}
		return text.endsWith('\n') ? text.slice(0, -1) : text;
	}

	function recordRichTextForEditor(record, fieldName, value) {
		const isSalesforceBaseline = !!(
			record &&
			record.loadedFromId &&
			record.loadedValues &&
			Object.prototype.hasOwnProperty.call(record.loadedValues, fieldName) &&
			record.loadedValues[fieldName] === value
		);
		if (isSalesforceBaseline) {
			return richTextForEditor(value);
		}
		return value == null ? '' : String(value);
	}

	function isGuidedFieldComplete(fieldType, state) {
		if (!state || !state.touched || state.valid === false) {
			return false;
		}
		if (fieldType === 'boolean') {
			return true;
		}
		if (fieldType === 'multipicklist') {
			return Array.isArray(state.values) && state.values.some((value) => value !== '');
		}
		if (state.value === null || state.value === undefined) {
			return false;
		}
		return typeof state.value === 'string' ? state.value.trim() !== '' : true;
	}

	function sharedRecordEditAccess(role, record, assignmentState) {
		if (!role || role === 'editor') {
			return true;
		}
		if (role !== 'contributor') {
			return false;
		}
		const hasRecipientRequest = !!(record && record._recipientSlot && record.slot && record.slot.slotId != null);
		return hasRecipientRequest && assignmentState !== 'other';
	}

	function canTakeOverField(peerLock, configuredReadOnly) {
		return !!(peerLock && !peerLock.owned && !configuredReadOnly);
	}

	function resolveSharedDraftDescribe(ensureDescribe, objectName, sharedSnapshot) {
		return ensureDescribe(objectName).catch((error) => {
			if (sharedSnapshot) {
				return sharedSnapshot;
			}
			throw error;
		});
	}

	function sharedDraftLayoutMode(role, record, assignmentState) {
		if (!role || !record || record.loadedFromId) {
			return null;
		}
		return sharedRecordEditAccess(role, record, assignmentState) ? 'Create' : 'View';
	}

	function fieldsForLayoutCell(fields, apiName) {
		const available = Array.isArray(fields) ? fields : [];
		const apiNames = Array.isArray(apiName) ? apiName : [apiName];
		const result = [];
		const rendered = new Set();
		apiNames.forEach((name) => {
			const components = available.filter((field) => field && field.name && field.compoundFieldName === name);
			const matches =
				components.length > 0 ? components : available.filter((field) => field && field.name === name);
			matches.forEach((field) => {
				if (!rendered.has(field.name)) {
					rendered.add(field.name);
					result.push(field);
				}
			});
		});
		return result;
	}

	function visibleRecordFields({
		modalEditMode,
		recipientFieldRequest,
		recipientCanEdit,
		sharedReadOnly,
		regular,
		writable,
		salesforceFieldWritable,
	}) {
		if (modalEditMode !== 'new') {
			return regular;
		}
		if (recipientFieldRequest || sharedReadOnly) {
			return regular;
		}
		return recipientCanEdit ? writable : regular.filter(salesforceFieldWritable);
	}

	function contributorRequestedFieldNames(role, record) {
		if (
			role !== 'contributor' ||
			!record ||
			!record._recipientSlot ||
			!record.slot ||
			(record.slot.kind || 'whole-record') !== 'fields'
		) {
			return null;
		}
		return new Set(Array.isArray(record.slot.fields) ? record.slot.fields : []);
	}

	function shouldShowRecipientSlotAccessNotice(role, record, requestedFields) {
		return !!(
			(role === 'contributor' || role === 'editor') &&
			record &&
			record._recipientSlot &&
			requestedFields &&
			requestedFields.size > 0
		);
	}

	function mergeSubmittedFieldValues(previousValues, payload, changedFields) {
		const nextValues = Object.assign({}, previousValues || {});
		for (const fieldName of changedFields || []) {
			if (Object.prototype.hasOwnProperty.call(payload || {}, fieldName)) {
				nextValues[fieldName] = payload[fieldName];
			} else {
				nextValues[fieldName] = null;
			}
		}
		return nextValues;
	}

	function formSelectValue(fieldType, rawValue) {
		if (fieldType === 'multipicklist') {
			const values = (Array.isArray(rawValue) ? rawValue : []).filter(Boolean);
			return values.length > 0 ? values.join(';') : null;
		}
		return rawValue === '' || rawValue == null ? null : rawValue;
	}

	function formInputValue(fieldType, rawValue) {
		if (fieldType === 'reference' || fieldType === 'picklist' || fieldType === 'combobox') {
			return rawValue === '' || rawValue == null ? null : rawValue;
		}
		if (fieldType === 'multipicklist') {
			const values = String(rawValue == null ? '' : rawValue)
				.split(';')
				.map((value) => value.trim())
				.filter(Boolean);
			return values.length > 0 ? values.join(';') : null;
		}
		return rawValue === '' || rawValue == null ? undefined : rawValue;
	}

	function encryptedControlValue(clearSelected, inputValue) {
		if (clearSelected) {
			return null;
		}
		return inputValue == null || String(inputValue) === '' ? undefined : String(inputValue);
	}

	function encryptedControlState(hadIntent, clearSelected, inputValue) {
		const value = encryptedControlValue(clearSelected, inputValue);
		return {
			tracked: value !== undefined || !!hadIntent,
			value,
		};
	}

	function canChangeEncryptedField(shareRole, configuredReadOnly) {
		return !shareRole && !configuredReadOnly;
	}

	function encryptedActionForField(
		existing,
		hasIntent,
		hasProposal,
		proposal,
		locallyTouched,
		localValue,
		locallyDismissed,
	) {
		if (locallyDismissed) {
			return 'unchanged';
		}
		if (locallyTouched) {
			return localValue === null ? 'clear' : 'replace';
		}
		if (hasProposal) {
			return proposal === null ? 'clear' : 'replace';
		}
		return hasIntent || !existing ? 'replace' : 'unchanged';
	}

	function timeForInput(value) {
		if (value == null || value === '') {
			return '';
		}
		const match = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z)?$/.exec(String(value).trim());
		return match ? match[0].replace(/Z$/, '') : '';
	}

	function formatTimeChoice(value) {
		const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?/.exec(timeForInput(value));
		if (!match) {
			return '';
		}
		const milliseconds = Number((match[4] || '').padEnd(3, '0'));
		const includesSeconds = Number(match[3] || 0) !== 0 || milliseconds !== 0;
		return new Intl.DateTimeFormat(undefined, {
			hour: 'numeric',
			minute: '2-digit',
			...(includesSeconds ? { second: '2-digit' } : {}),
			...(milliseconds !== 0 ? { fractionalSecondDigits: 3 } : {}),
			timeZone: 'UTC',
		}).format(
			new Date(Date.UTC(2000, 0, 1, Number(match[1]), Number(match[2]), Number(match[3] || 0), milliseconds)),
		);
	}

	function timeForChoice(value) {
		const normalized = timeForInput(value);
		const match = /^(\d{2}:\d{2})(?::00(?:\.0{1,3})?)?$/.exec(normalized);
		return match ? match[1] : normalized;
	}

	function timeChoiceOptions(currentValue) {
		const current = timeForChoice(currentValue);
		const values = Array.from({ length: 96 }, (_unused, index) => {
			const hour = Math.floor(index / 4);
			const minute = (index % 4) * 15;
			return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
		});
		const options = values.map((value) => ({ value, label: formatTimeChoice(value), current: false }));
		if (current && !values.includes(current)) {
			options.unshift({ value: current, label: formatTimeChoice(current) + ' (current value)', current: true });
		}
		return options;
	}

	function setTimeSelectValue(select, value) {
		if (!select) {
			return;
		}
		const current = timeForChoice(value);
		select.querySelectorAll('option[data-current-time-value]').forEach((option) => option.remove());
		if (current && !Array.from(select.options || []).some((option) => option.value === current)) {
			const option = select.ownerDocument.createElement('option');
			option.value = current;
			option.textContent = formatTimeChoice(current) + ' (current value)';
			option.dataset.currentTimeValue = 'true';
			select.insertBefore(option, select.options[1] || null);
		}
		select.value = current;
	}

	function fieldControlsDependentPicklist(fields, fieldName) {
		return (
			!!fieldName && Array.isArray(fields) && fields.some((field) => field && field.controllerName === fieldName)
		);
	}

	function recordTypePicklistValues(field, recordTypeId) {
		const byRecordType = field && field.picklistValuesByRecordType;
		if (recordTypeId && byRecordType && Object.prototype.hasOwnProperty.call(byRecordType, recordTypeId)) {
			return Array.isArray(byRecordType[recordTypeId]) ? byRecordType[recordTypeId] : [];
		}
		if (recordTypeId && byRecordType && Object.keys(byRecordType).length > 0) {
			return [];
		}
		return field && Array.isArray(field.picklistValues) ? field.picklistValues : [];
	}

	function recordTypePicklistAvailable(field, recordTypeId) {
		const byRecordType = field && field.picklistValuesByRecordType;
		return !(
			recordTypeId &&
			byRecordType &&
			Object.keys(byRecordType).length > 0 &&
			!Object.prototype.hasOwnProperty.call(byRecordType, recordTypeId)
		);
	}

	function retainCurrentRecordType(recordTypes, currentRecordTypeId) {
		const result = (Array.isArray(recordTypes) ? recordTypes : []).map((recordType) =>
			Object.assign({}, recordType, { available: recordType.available !== false }),
		);
		if (currentRecordTypeId && !result.some((recordType) => recordType.id === currentRecordTypeId)) {
			result.unshift({
				id: currentRecordTypeId,
				name: 'Unavailable record type',
				label: 'Unavailable record type (current Salesforce value)',
				available: false,
			});
		}
		return result;
	}

	function inferReferenceTarget(referenceTo, recordId, allObjects) {
		const targets = Array.isArray(referenceTo) ? referenceTo.filter(Boolean) : [];
		if (targets.length === 1) {
			return targets[0];
		}
		const prefix = String(recordId || '').slice(0, 3);
		if (!prefix) {
			return null;
		}
		const targetSet = new Set(targets);
		const match = (Array.isArray(allObjects) ? allObjects : []).find(
			(object) => object && targetSet.has(object.name) && object.keyPrefix === prefix,
		);
		return match ? match.name : null;
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

	function picklistSelectionForContext(field, recordTypeId, controllerValue, currentValue, recordTypeAvailable) {
		if (
			!field ||
			recordTypeAvailable === false ||
			supportsCustomPicklistValue(field) ||
			!recordTypePicklistAvailable(field, recordTypeId)
		) {
			return { known: false, value: currentValue };
		}
		const values = recordTypePicklistValues(field, recordTypeId);
		let allowedValues = values;
		if (field.controllerName) {
			const byRecordType = field.controllerValuesByRecordType;
			const controllerMap =
				(byRecordType && recordTypeId && byRecordType[recordTypeId]) || field.controllerValues || null;
			if (!controllerMap) {
				return { known: false, value: currentValue };
			}
			const controllerKey = controllerValue == null ? '' : String(controllerValue);
			if (!controllerKey || !Object.prototype.hasOwnProperty.call(controllerMap, controllerKey)) {
				return { known: true, value: null };
			}
			const controllerIndex = controllerMap[controllerKey];
			allowedValues = values.filter(
				(entry) => Array.isArray(entry.validFor) && entry.validFor.includes(controllerIndex),
			);
		}
		const allowed = new Set(allowedValues.map((entry) => String(entry.value)));
		if (field.type === 'multipicklist') {
			const retained = String(currentValue == null ? '' : currentValue)
				.split(';')
				.map((value) => value.trim())
				.filter((value) => value && allowed.has(value));
			return { known: true, value: retained.length > 0 ? retained.join(';') : null };
		}
		return {
			known: true,
			value: currentValue != null && allowed.has(String(currentValue)) ? currentValue : null,
		};
	}

	function retainCurrentPicklistValues(values, currentValue, fieldType, loadedValue) {
		const result = (Array.isArray(values) ? values : []).map((value) => Object.assign({}, value));
		const currentValues =
			fieldType === 'multipicklist'
				? String(currentValue == null ? '' : currentValue)
						.split(';')
						.map((value) => value.trim())
						.filter(Boolean)
				: currentValue == null || currentValue === ''
					? []
					: [String(currentValue)];
		const loadedValues =
			fieldType === 'multipicklist'
				? String(loadedValue == null ? '' : loadedValue)
						.split(';')
						.map((value) => value.trim())
						.filter(Boolean)
				: loadedValue == null || loadedValue === ''
					? []
					: [String(loadedValue)];
		const loaded = new Set(loadedValues);
		const known = new Set(result.map((value) => String(value && value.value)));
		currentValues.forEach((value) => {
			if (!known.has(value) && loaded.has(value)) {
				result.unshift({
					value,
					label: value + ' (current value)',
					active: false,
					retainedCurrent: true,
				});
				known.add(value);
			}
		});
		return result;
	}

	function applyLayoutPicklistFallback(fields, layoutPicklistValues, recordTypeId) {
		if (!Array.isArray(fields) || !layoutPicklistValues) {
			return;
		}
		fields.forEach((field) => {
			const layoutField = field && layoutPicklistValues[field.name];
			if (!layoutField || !Array.isArray(layoutField.values)) {
				return;
			}
			const values = layoutField.values.map((value) => ({
				value: value.value,
				label: value.label,
				active: true,
				defaultValue: layoutField.defaultValue === value.value,
				validFor: value.validFor || null,
			}));
			if (recordTypeId) {
				field.picklistValuesByRecordType = field.picklistValuesByRecordType || {};
				field.picklistValuesByRecordType[recordTypeId] = values;
				// UI API layouts can carry record-type-specific dependent-picklist indexes.
				if (layoutField.controllerValues) {
					field.controllerValuesByRecordType = field.controllerValuesByRecordType || {};
					field.controllerValuesByRecordType[recordTypeId] = layoutField.controllerValues;
				}
				return;
			}
			if (!Array.isArray(field.picklistValues) || field.picklistValues.length === 0) {
				field.picklistValues = values;
			}
		});
	}

	function supportsCustomPicklistValue(field) {
		return !!(field && field.type === 'combobox');
	}

	function numericFieldStep(field, fallback) {
		const scale = field && typeof field.scale === 'number' && field.scale >= 0 ? field.scale : null;
		return scale == null ? fallback : scale > 0 ? Math.pow(10, -scale) : 1;
	}

	function geolocationCoordinateKind(field, fields) {
		if (!field || !field.name || !field.compoundFieldName) {
			return null;
		}
		const container = (Array.isArray(fields) ? fields : []).find(
			(candidate) => candidate && candidate.name === field.compoundFieldName && candidate.type === 'location',
		);
		if (!container) {
			return null;
		}
		if (/Latitude(?:__s)?$/i.test(field.name)) {
			return 'latitude';
		}
		if (/Longitude(?:__s)?$/i.test(field.name)) {
			return 'longitude';
		}
		return null;
	}

	function groupGeolocationFields(fields, allFields) {
		const groups = [];
		const locations = new Map();
		for (const field of Array.isArray(fields) ? fields : []) {
			const coordinateKind = geolocationCoordinateKind(field, allFields);
			if (!coordinateKind) {
				groups.push({ kind: 'field', field });
				continue;
			}
			let group = locations.get(field.compoundFieldName);
			if (!group) {
				const container = (Array.isArray(allFields) ? allFields : []).find(
					(candidate) => candidate && candidate.name === field.compoundFieldName,
				);
				group = {
					kind: 'geolocation',
					name: field.compoundFieldName,
					label: (container && (container.label || container.name)) || field.compoundFieldName,
					fields: [],
				};
				locations.set(field.compoundFieldName, group);
				groups.push(group);
			}
			group.fields.push(field);
		}
		return groups;
	}

	function truncateDecimalScale(rawValue, scale) {
		if (rawValue === null || rawValue === undefined || rawValue === '') {
			return rawValue;
		}
		if (!Number.isInteger(scale) || scale < 0) {
			return String(rawValue);
		}
		const text = String(rawValue).trim();
		const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(text);
		if (!match) {
			return text;
		}
		if (scale === 0) {
			return match[1] + match[2];
		}
		const fraction = match[3] || '';
		if (fraction.length <= scale) {
			return text;
		}
		return match[1] + match[2] + '.' + fraction.slice(0, scale);
	}

	function geolocationValidationMessage(kind, rawValue, badInput) {
		if (!kind || (!badInput && (rawValue === null || rawValue === undefined || rawValue === ''))) {
			return '';
		}
		const label = kind === 'latitude' ? 'Latitude' : 'Longitude';
		const min = kind === 'latitude' ? -90 : -180;
		const max = kind === 'latitude' ? 90 : 180;
		const value = Number(rawValue);
		return badInput || !Number.isFinite(value) || value < min || value > max
			? label + ' should be a decimal number in a range [' + min + ', ' + max + '].'
			: '';
	}

	function browserSafeNumericBounds(bounds) {
		if (!bounds) {
			return null;
		}
		const step = Number(bounds.step);
		const min = Number(bounds.min);
		const max = Number(bounds.max);
		const safeStepGrid =
			Number.isFinite(step) &&
			step > 0 &&
			Number.isFinite(min) &&
			Number.isFinite(max) &&
			Math.abs(min / step) <= Number.MAX_SAFE_INTEGER &&
			Math.abs(max / step) <= Number.MAX_SAFE_INTEGER;
		return safeStepGrid ? bounds : { step: bounds.step };
	}

	function plainDecimalInputValue(value) {
		const text = String(value == null ? '' : value);
		const match = /^(-?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(text);
		if (!match) return text;
		const exponent = Number(match[4]);
		// Native number inputs produce finite values. Bound expansion defensively.
		if (!Number.isFinite(Number(text)) || Math.abs(exponent) > 1000) return text;
		const digits = match[2] + (match[3] || '');
		const decimalIndex = match[2].length + exponent;
		// Shift the decimal point as text: no rounding or floating-point conversion.
		if (decimalIndex <= 0) return match[1] + '0.' + '0'.repeat(-decimalIndex) + digits;
		if (decimalIndex >= digits.length) return match[1] + digits + '0'.repeat(decimalIndex - digits.length);
		return match[1] + digits.slice(0, decimalIndex) + '.' + digits.slice(decimalIndex);
	}

	function stepNumericInput(input, direction) {
		if (!input || (direction !== 1 && direction !== -1)) {
			return false;
		}
		const previousValue = String(input.value == null ? '' : input.value);
		try {
			if (direction > 0) {
				input.stepUp();
			} else {
				input.stepDown();
			}
		} catch (_err) {
			return false;
		}
		input.value = plainDecimalInputValue(input.value);
		if (String(input.value == null ? '' : input.value) === previousValue) {
			return false;
		}
		const EventCtor =
			input.ownerDocument && input.ownerDocument.defaultView && input.ownerDocument.defaultView.Event;
		if (EventCtor && typeof input.dispatchEvent === 'function') {
			input.dispatchEvent(new EventCtor('input', { bubbles: true }));
		}
		return true;
	}

	function wireNumericInputSteppers(root) {
		if (!root || typeof root.querySelectorAll !== 'function') {
			return;
		}
		root.querySelectorAll('input[type="number"]').forEach((input) => {
			input.value = plainDecimalInputValue(input.value);
			input.addEventListener('keydown', (event) => {
				if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
					return;
				}
				event.preventDefault();
				stepNumericInput(input, event.key === 'ArrowUp' ? 1 : -1);
			});
			input.addEventListener('pointerdown', (event) => {
				if (event.button !== 0) {
					return;
				}
				const bounds = input.getBoundingClientRect();
				if (event.clientX < bounds.right - Math.min(24, bounds.width / 4)) {
					return;
				}
				event.preventDefault();
				input.focus({ preventScroll: true });
				stepNumericInput(input, event.clientY < bounds.top + bounds.height / 2 ? 1 : -1);
			});
		});
	}

	function intentionalChangedFieldNames(changedFields, touchedFields, existingRecord, previousValues) {
		const touched = touchedFields instanceof Set ? touchedFields : new Set(touchedFields || []);
		return (Array.isArray(changedFields) ? changedFields : []).filter(
			(fieldName) =>
				touched.has(fieldName) ||
				(!existingRecord && !Object.prototype.hasOwnProperty.call(previousValues || {}, fieldName)),
		);
	}

	function shouldValidateEditorField(fieldName, touchedFields, existingRecord) {
		if (!existingRecord || !fieldName) {
			return true;
		}
		const touched = touchedFields instanceof Set ? touchedFields : new Set(touchedFields || []);
		return touched.has(fieldName);
	}

	function firstInvalidEditorControl(form, touchedFields, existingRecord) {
		if (!form || typeof form.querySelectorAll !== 'function') {
			return null;
		}
		return (
			Array.from(form.querySelectorAll('input, textarea, select')).find((control) => {
				const field = control && control.closest ? control.closest('.field[data-field]') : null;
				const fieldName = field && field.dataset ? field.dataset.field : null;
				return (
					shouldValidateEditorField(fieldName, touchedFields, existingRecord) &&
					typeof control.checkValidity === 'function' &&
					!control.checkValidity()
				);
			}) || null
		);
	}

	function editorFieldValueControl(fieldElement, fieldType) {
		if (!fieldElement || typeof fieldElement.querySelector !== 'function') {
			return null;
		}
		if (fieldType === 'reference') {
			const lookupValue = fieldElement.querySelector('.lookup-picker input[type="hidden"]');
			if (lookupValue) {
				return lookupValue;
			}
		}
		return fieldElement.querySelector('input, textarea, select');
	}

	function linkedRecordControlHtml(field, lock, description, canUnlink, escapeHtml) {
		const target = lock.target;
		const values = target.values || {};
		const recordName =
			values.Name ||
			values.Subject ||
			values.Title ||
			[values.FirstName, values.LastName].filter(Boolean).join(' ') ||
			description;
		const tooltip = field.name + ' · ' + description;
		return (
			'<div class="assoc-control">' +
			'<input type="hidden" name="' +
			escapeHtml(field.name) +
			'" value="' +
			escapeHtml(description) +
			'" data-locked-assoc="' +
			escapeHtml(String(lock.association.id)) +
			'">' +
			'<button type="button" class="assoc-record-link" id="f_' +
			escapeHtml(field.name) +
			'" data-open-assoc-field="' +
			escapeHtml(field.name) +
			'" title="' +
			escapeHtml(tooltip) +
			'" aria-label="' +
			escapeHtml('Open linked record: ' + recordName) +
			'"' +
			(target._inaccessible ? ' disabled' : '') +
			'>' +
			'<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2"/></svg>' +
			'<span>' +
			escapeHtml(String(recordName)) +
			'</span></button>' +
			(canUnlink
				? '<button type="button" class="link-button assoc-unlink" data-disconnect-assoc="' +
					escapeHtml(String(lock.association.id)) +
					'" title="Remove this canvas link to enter a value manually.">Unlink</button>'
				: '') +
			'</div>'
		);
	}

	// Field labels, datalists and ARIA references must resolve inside their own editor.
	function scopeEditorIds(root, prefix) {
		if (!prefix) return;
		const ids = new Map();
		root.querySelectorAll('[id]').forEach((el) => {
			ids.set(el.id, prefix + el.id);
			el.id = prefix + el.id;
		});
		for (const attribute of ['for', 'list', 'aria-controls', 'aria-describedby', 'aria-labelledby']) {
			root.querySelectorAll('[' + attribute + ']').forEach((el) => {
				el.setAttribute(
					attribute,
					el
						.getAttribute(attribute)
						.split(/\s+/)
						.map((id) => ids.get(id) || id)
						.join(' '),
				);
			});
		}
	}

	let nextEditorId = 0;
	function mountMultiple(deps, mountEditor = window.OrgLoom.insertModal.mount) {
		const editors = new Map();
		let active = null;
		let helper = null;
		function getHelper() {
			if (!helper)
				helper = mountEditor({
					...deps,
					canvasState: Object.assign(Object.create(deps.canvasState), { currentRecordRef: null }),
					editorId: 'record-editor-helper-',
					helperOnly: true,
				});
			return helper;
		}
		function activate(entry) {
			active = entry;
			deps.canvasState.currentRecordRef = entry.record;
			for (const other of editors.values()) other.api.setActive(other === entry);
		}
		function createEditor(record, key) {
			let currentRecordRef = null;
			// All canvas data stays shared, but an editor never borrows another editor's record.
			const localState = new Proxy(deps.canvasState, {
				get(target, name) {
					return name === 'currentRecordRef' ? currentRecordRef : target[name];
				},
				set(target, name, value) {
					if (name === 'currentRecordRef') currentRecordRef = value;
					else target[name] = value;
					return true;
				},
			});
			const entry = { record, api: null };
			entry.api = mountEditor({
				...deps,
				canvasState: localState,
				editorId: 'record-editor-' + ++nextEditorId + '-',
				keepOpen: true,
				openLinkedRecord: (record) => api.openInsertModal(record.objectName, { record }),
				onActivate: () => activate(entry),
				pushPresenceFocus: (focus) => {
					if (active === entry) deps.pushPresenceFocus(focus);
				},
				onClose: () => {
					editors.delete(key);
					entry.api.destroy();
					if (active === entry) {
						active = null;
						deps.canvasState.currentRecordRef = null;
						const remaining = Array.from(editors.values()).pop();
						if (remaining) remaining.api.activate();
					}
				},
			});
			editors.set(key, entry);
			return entry;
		}
		function closeAll() {
			for (const entry of Array.from(editors.values())) entry.api.closeModal();
		}
		const api = {
			openInsertModal(objectName, options = {}) {
				const record = options.record || null;
				objectName = objectName || (record && record.objectName);
				if (typeof objectName !== 'string' || !objectName.trim()) {
					deps.showBulkToast(
						'This record is missing its Salesforce object type. Reload the canvas and try again.',
						'error',
					);
					return;
				}
				const key = record ? record.id : 'new:' + objectName;
				let entry = editors.get(key);
				if (entry && entry.record !== record) {
					entry.api.closeModal();
					entry = null;
				}
				if (entry) {
					entry.api.activate(options);
					return;
				}
				entry = createEditor(record, key);
				activate(entry);
				entry.api.openInsertModal(objectName, options);
			},
			closeModal: () => {
				if (active) active.api.closeModal();
			},
			closeAll,
			unlinkRecord(record) {
				const entry = record && editors.get(record.id);
				if (entry && entry.record === record) {
					return entry.api.unlinkRecord(record);
				}
				return getHelper().unlinkRecord(record, deps.canvasState);
			},
			updateUploadFixFields(recordId, fields) {
				for (const entry of editors.values()) {
					if (entry.record && String(entry.record.id) === String(recordId))
						entry.api.updateUploadFixFields(fields);
				}
			},
			syncOpenRecords() {
				for (const entry of Array.from(editors.values())) {
					if (entry.record && !(deps.canvasState.bulkRecords || []).includes(entry.record))
						entry.api.closeModal();
				}
			},
			hasPendingEncryptedUploadValues: () =>
				getHelper().hasPendingEncryptedUploadValues() ||
				Array.from(editors.values()).some((entry) => entry.api.hasPendingEncryptedUploadValues()),
			showModalToast: (...args) => active && active.api.showModalToast(...args),
		};
		for (const method of ['refreshCurrentRecordAccess', 'refreshCurrentFieldLocks', 'refreshCurrentRecordValues']) {
			api[method] = (...args) => {
				for (const entry of editors.values()) entry.api[method](...args);
			};
		}
		for (const method of [
			'_prefetchLayoutForRecord',
			'tryParseRule',
			'tryFixValidationRules',
			'fieldTypeFilter',
			'sampleValueForField',
		]) {
			api[method] = (...args) => {
				return getHelper()[method](...args);
			};
		}
		return api;
	}

	window.OrgLoom.insertModal = {
		mountMultiple,
		_test: {
			registerFieldEditUndo,
			mountMultiple,
			scopeEditorIds,
			linkedRecordControlHtml,
			applyLoadedRecordUnlink,
			formatCarryoverValue,
			formatReadOnlyFieldValue,
			isSalesforceTrue,
			isGuidedFieldComplete,
			sharedRecordEditAccess,
			canTakeOverField,
			resolveSharedDraftDescribe,
			sharedDraftLayoutMode,
			fieldsForLayoutCell,
			visibleRecordFields,
			contributorRequestedFieldNames,
			shouldShowRecipientSlotAccessNotice,
			mergeSubmittedFieldValues,
			formSelectValue,
			formInputValue,
			encryptedControlValue,
			encryptedControlState,
			canChangeEncryptedField,
			encryptedActionForField,
			timeForInput,
			formatTimeChoice,
			timeForChoice,
			timeChoiceOptions,
			setTimeSelectValue,
			dateTimeForInput,
			dateTimeFromInput,
			fieldControlsDependentPicklist,
			recordTypePicklistValues,
			recordTypePicklistAvailable,
			retainCurrentRecordType,
			retainCurrentPicklistValues,
			applyLayoutPicklistFallback,
			supportsCustomPicklistValue,
			numericFieldStep,
			geolocationCoordinateKind,
			groupGeolocationFields,
			truncateDecimalScale,
			geolocationValidationMessage,
			browserSafeNumericBounds,
			stepNumericInput,
			wireNumericInputSteppers,
			inferReferenceTarget,
			isExternalKeyReferenceField,
			picklistSelectionForContext,
			intentionalChangedFieldNames,
			shouldValidateEditorField,
			firstInvalidEditorControl,
			editorFieldValueControl,
			richTextForEditor,
			recordRichTextForEditor,
		},
		mount: function mount(deps) {
			if (
				!deps ||
				!deps.canvasState ||
				!deps.csrfFetch ||
				!deps.escapeHtml ||
				!deps.ensureDescribe ||
				!deps.ensureRules ||
				!deps.showBulkToast ||
				!deps.changedFieldNames ||
				!deps.deleteAssociation ||
				!deps.renderChips ||
				!deps.renderBulkView ||
				!deps.getCanvasShareRole ||
				!deps._slotProgress ||
				!deps._slotProgressClass ||
				!deps.recordOrdinal ||
				!deps._slotAssignmentState ||
				!deps.unmarkPendingDelete ||
				!deps.showConfirmDialog ||
				!deps.pushPresenceFocus ||
				!deps.publishPresenceLayout
			) {
				throw new Error('insert-modal.mount: missing required deps');
			}
			const canvasState = deps.canvasState;
			const lifecycle = new AbortController();
			let formLifecycle = new AbortController();
			let openVersion = 0;
			let editorActive = !deps.keepOpen;
			const interactionCleanups = new Set();
			const encryptedFields = window.OrgLoom && window.OrgLoom.encryptedFields;
			if (!encryptedFields) {
				throw new Error('encrypted-fields.js must load before insert-modal.js');
			}
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			const ensureDescribe = deps.ensureDescribe;
			const ensureRules = deps.ensureRules;
			const showBulkToast = deps.showBulkToast;
			const changedFieldNames = deps.changedFieldNames;
			const deleteAssociation = deps.deleteAssociation;
			const renderChips = deps.renderChips;
			const renderBulkView = deps.renderBulkView;
			const getCanvasShareRole = deps.getCanvasShareRole;
			const _slotProgress = deps._slotProgress;
			const _slotProgressClass = deps._slotProgressClass;
			const recordOrdinal = deps.recordOrdinal;
			const _slotAssignmentState = deps._slotAssignmentState;
			const unmarkPendingDelete = deps.unmarkPendingDelete;
			const showConfirmDialog = deps.showConfirmDialog;
			const pushPresenceFocus = deps.pushPresenceFocus;
			const publishPresenceLayout = deps.publishPresenceLayout;
			const configureRequest = typeof deps.configureRequest === 'function' ? deps.configureRequest : null;
			const fieldLockFor =
				typeof deps.fieldLockFor === 'function'
					? deps.fieldLockFor
					: function () {
							return null;
						};
			const acquireFieldLock =
				typeof deps.acquireFieldLock === 'function'
					? deps.acquireFieldLock
					: async function () {
							return { ok: true, localOnly: true };
						};
			const commitRecordFields =
				typeof deps.commitRecordFields === 'function'
					? deps.commitRecordFields
					: async function () {
							return { ok: true, localOnly: true };
						};
			const releaseFieldLock =
				typeof deps.releaseFieldLock === 'function' ? deps.releaseFieldLock : function () {};
			const releaseRecordFieldLocks =
				typeof deps.releaseRecordFieldLocks === 'function' ? deps.releaseRecordFieldLocks : function () {};
			const canEditCanvasStructure = () => {
				const role = getCanvasShareRole();
				return !role || role === 'editor';
			};
			const salesforceRecordIsReadOnly = (record) =>
				!!(
					record &&
					record.loadedFromId &&
					record._recordAccess &&
					record._recordAccess.checked === true &&
					record._recordAccess.hasEditAccess === false
				);
			const canEditCurrentRecord = () =>
				!salesforceRecordIsReadOnly(canvasState.currentRecordRef) &&
				sharedRecordEditAccess(
					getCanvasShareRole(),
					canvasState.currentRecordRef,
					_slotAssignmentState(canvasState.currentRecordRef),
				);
			const _getCyInstance = typeof deps.getCyInstance === 'function' ? deps.getCyInstance : null;
			const _getCyContainer = typeof deps.getCyContainer === 'function' ? deps.getCyContainer : null;
			const _getCyPendingEdge = typeof deps.getCyPendingEdge === 'function' ? deps.getCyPendingEdge : null;

			function _presenceFocusForRecord(record) {
				if (!record) {
					return null;
				}
				let focus;
				if (record.slot && record.slot.slotId != null) {
					focus = { kind: 'record', refKind: 'slot', ref: String(record.slot.slotId) };
				} else if (record.loadedFromId) {
					focus = { kind: 'record', refKind: 'loaded', ref: String(record.loadedFromId) };
				} else {
					const ref =
						record._persistedTempId != null ? record._persistedTempId : record._collabId || record.id;
					if (ref == null) {
						return null;
					}
					focus = { kind: 'record', refKind: 'draft', ref: String(ref) };
				}
				const collabRef =
					record._canvasRecordId != null
						? record._canvasRecordId
						: record._collabId != null
							? record._collabId
							: null;
				if (collabRef != null) {
					focus.collabRef = String(collabRef);
				}
				return focus;
			}

			const modal = document.createElement('div');
			modal.className = 'modal record-editor-modal hidden';
			modal.innerHTML =
				'<div class="modal-overlay" data-close></div>' +
				'<div class="modal-body">' +
				'<div class="record-editor-drag-handle" aria-hidden="true"></div>' +
				'<div class="modal-header">' +
				'<div class="record-editor-heading"><div class="record-editor-title-row">' +
				'<h3 data-editor-element="modal-title">New record</h3>' +
				'</div>' +
				'<div class="modal-subtitle" data-editor-element="modal-subtitle"></div>' +
				'<div class="record-editor-header-id" data-editor-element="record-id" hidden></div></div>' +
				'<button class="modal-close" data-close title="Collapse to card" aria-label="Collapse to card">' +
				'<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">' +
				'<path d="M2 6h4V2M12 8H8v4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
				'</svg>' +
				'</button>' +
				'</div>' +
				'<div class="modal-content" data-editor-element="modal-content"><p class="center">Loading…</p></div>' +
				'<div class="modal-toast" data-editor-element="modal-toast" hidden></div>' +
				'<div class="modal-footer">' +
				'<button class="button secondary" data-editor-element="modal-configure-request" hidden>Configure request</button>' +
				'<button class="button secondary" data-close>Cancel</button>' +
				'<button class="button" data-editor-element="modal-submit" disabled>Save draft</button>' +
				'</div>' +
				'</div>';
			if (!deps.helperOnly) document.body.appendChild(modal);
			function activate(options = {}) {
				if (typeof deps.onActivate === 'function') deps.onActivate();
				const focus = _presenceFocusForRecord(canvasState.currentRecordRef);
				if (focus) pushPresenceFocus(focus);
				if (Array.isArray(options.uploadFixFields)) uploadFixFields = options.uploadFixFields;
				if (options.focusField) focusTaskField(options.focusField);
			}
			modal.addEventListener('mousedown', () => activate(), { signal: lifecycle.signal });
			modal.addEventListener('focusin', () => activate(), { signal: lifecycle.signal });
			function cancelEncryptedTooltipHide() {
				if (encryptedTooltipHideTimer) {
					clearTimeout(encryptedTooltipHideTimer);
					encryptedTooltipHideTimer = null;
				}
			}

			function closeEncryptedTooltip() {
				cancelEncryptedTooltipHide();
				if (!activeEncryptedTooltip) {
					return;
				}
				const { trigger, content, fallbackParent, fallbackNextSibling } = activeEncryptedTooltip;
				try {
					if (typeof content.hidePopover === 'function' && content.matches(':popover-open')) {
						content.hidePopover();
					}
				} catch (_) {
					/* Popover API is unavailable in this browser. */
				}
				if (fallbackParent && content.parentNode !== fallbackParent) {
					fallbackParent.insertBefore(content, fallbackNextSibling);
				}
				content.classList.remove('is-open');
				content.style.removeProperty('left');
				content.style.removeProperty('top');
				trigger.setAttribute('aria-expanded', 'false');
				activeEncryptedTooltip = null;
			}

			function positionEncryptedTooltip(trigger, content) {
				const edge = 8;
				const gap = 8;
				const triggerRect = trigger.getBoundingClientRect();
				const tooltipRect = content.getBoundingClientRect();
				const left = Math.min(
					window.innerWidth - edge - tooltipRect.width,
					Math.max(edge, triggerRect.right - tooltipRect.width),
				);
				let top = triggerRect.bottom + gap;
				if (top + tooltipRect.height > window.innerHeight - edge) {
					top = Math.max(edge, triggerRect.top - gap - tooltipRect.height);
				}
				content.style.left = Math.round(Math.max(edge, left)) + 'px';
				content.style.top = Math.round(top) + 'px';
			}

			function openEncryptedTooltip(trigger) {
				const tooltipId = trigger && trigger.getAttribute('aria-describedby');
				const content = tooltipId ? document.getElementById(tooltipId) : null;
				if (!content) {
					return;
				}
				cancelEncryptedTooltipHide();
				if (activeEncryptedTooltip && activeEncryptedTooltip.trigger !== trigger) {
					closeEncryptedTooltip();
				}
				if (!activeEncryptedTooltip) {
					const fallbackParent = content.parentNode;
					const fallbackNextSibling = content.nextSibling;
					let shownInTopLayer = false;
					try {
						if (typeof content.showPopover === 'function') {
							content.showPopover();
							shownInTopLayer = true;
						}
					} catch (_) {
						/* Fall back to a body-level fixed element below. */
					}
					if (!shownInTopLayer) {
						document.body.appendChild(content);
					}
					activeEncryptedTooltip = { trigger, content, fallbackParent, fallbackNextSibling };
					content.classList.add('is-open');
					content.addEventListener('pointerenter', cancelEncryptedTooltipHide, { once: true });
					content.addEventListener('pointerleave', scheduleEncryptedTooltipHide, { once: true });
					trigger.setAttribute('aria-expanded', 'true');
				}
				positionEncryptedTooltip(trigger, content);
			}

			function scheduleEncryptedTooltipHide() {
				cancelEncryptedTooltipHide();
				encryptedTooltipHideTimer = setTimeout(closeEncryptedTooltip, 120);
			}
			modal.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeModal));
			modal
				.querySelector('[data-editor-element="modal-content"]')
				.addEventListener('scroll', closeEncryptedTooltip, {
					passive: true,
				});
			window.addEventListener('resize', closeEncryptedTooltip, { passive: true, signal: lifecycle.signal });
			document.addEventListener(
				'keydown',
				(e) => {
					if (
						e.key === 'Escape' &&
						!e.defaultPrevented &&
						editorActive &&
						!modal.classList.contains('hidden')
					) {
						e.preventDefault();
						closeEncryptedTooltip();
						closeModal();
					}
				},
				{ signal: lifecycle.signal },
			);

			function _syncSubmitButtonAccess(options) {
				const submitBtn = modal.querySelector('[data-editor-element="modal-submit"]');
				const configureBtn = modal.querySelector('[data-editor-element="modal-configure-request"]');
				const record = canvasState.currentRecordRef;
				const configurableRecordRequest = !!(
					canEditCanvasStructure() &&
					record &&
					record.slot &&
					record.slot.slotId != null &&
					(record.slot.kind || 'whole-record') === 'whole-record'
				);
				const canSubmit = canEditCurrentRecord();
				submitBtn.hidden = !canSubmit;
				submitBtn.disabled = !canSubmit || !!(options && options.loading);
				submitBtn.textContent =
					options && options.loading
						? 'Saving...'
						: getCanvasShareRole() === 'contributor'
							? 'Save changes'
							: 'Save draft';
				submitBtn.title = canSubmit
					? ''
					: salesforceRecordIsReadOnly(record)
						? 'This record is read-only for your Salesforce user.'
						: 'This record is read-only for your canvas role.';
				if (configureBtn) {
					configureBtn.hidden = !configurableRecordRequest || !configureRequest;
				}
				return submitBtn;
			}

			const _configureRequestBtn = modal.querySelector('[data-editor-element="modal-configure-request"]');
			if (_configureRequestBtn) {
				_configureRequestBtn.addEventListener('click', () => {
					const record = canvasState.currentRecordRef;
					if (!record || !configureRequest) {
						return;
					}
					closeModal();
					void configureRequest(record);
				});
			}

			(function _installResizeHandles() {
				const body = modal.querySelector('.modal-body');
				if (!body) {
					return;
				}
				const handle = document.createElement('div');
				handle.className = 'inline-resize-handle inline-resize-handle--se';
				handle.dataset.resizeDir = 'se';
				handle.title = 'Drag to resize editor';
				handle.setAttribute('aria-hidden', 'true');
				handle.addEventListener('mousedown', (ev) => _startResize(ev, 'se', body));
				body.appendChild(handle);
			})();
			function _startResize(ev, dir, body) {
				ev.preventDefault();
				ev.stopPropagation();
				const startX = ev.clientX;
				const startY = ev.clientY;
				const startW = body.offsetWidth;
				const startH = body.offsetHeight;
				modal.classList.add('is-resizing');
				const onMove = (mev) => {
					const dx = mev.clientX - startX;
					const dy = mev.clientY - startY;
					const bounds = _getInlineUsableBounds(_getCyContainer && _getCyContainer());
					const maxW = bounds.width;
					const maxH = bounds.height;
					const minW = Math.min(320, maxW);
					const minH = Math.min(280, maxH);
					let newW = startW;
					let newH = startH;
					if (dir.indexOf('e') >= 0) {
						newW = startW + dx;
					}
					if (dir.indexOf('w') >= 0) {
						newW = startW - dx;
					}
					if (dir.indexOf('s') >= 0) {
						newH = startH + dy;
					}
					if (dir.indexOf('n') >= 0) {
						newH = startH - dy;
					}
					newW = Math.max(minW, Math.min(maxW, newW));
					newH = Math.max(minH, Math.min(maxH, newH));
					modal.style.setProperty('--inline-width', newW + 'px');
					modal.style.setProperty('--inline-height', newH + 'px');
					_syncCyNodeSizeToModal();
					if (_inlineCyNode && _getCyInstance && _getCyContainer) {
						_inlinePinToNode(_getCyInstance(), _inlineCyNode, _getCyContainer());
					}
				};
				const onUp = () => {
					interactionCleanups.delete(onUp);
					modal.classList.remove('is-resizing');
					document.removeEventListener('mousemove', onMove);
					document.removeEventListener('mouseup', onUp);
					if (_inlineRenderHandler) {
						_inlineRenderHandler();
					}
				};
				document.addEventListener('mousemove', onMove);
				document.addEventListener('mouseup', onUp);
				interactionCleanups.add(onUp);
			}

			let _inlineRecId = null; // record id currently pinned
			let _inlineOutsideClickHandler = null; // doc-level click-outside listener (inline mode only)
			let _inlineRenderHandler = null; // cy render listener ref for un-binding
			let _inlineSelectObserver = null; // MutationObserver mirroring card.selected → modal.is-selected
			let _inlineBoundsObserver = null;
			let _inlineViewportHandler = null;

			function _getInlineUsableBounds(container) {
				const margin = 10;
				const viewportRight = Math.max(margin + 1, window.innerWidth - margin);
				const viewportBottom = Math.max(margin + 1, window.innerHeight - margin);
				const rect = container && container.getBoundingClientRect ? container.getBoundingClientRect() : null;
				let left = Math.max(margin, rect && rect.width > 0 ? rect.left + margin : margin);
				let top = Math.max(margin, rect && rect.height > 0 ? rect.top + margin : margin);
				let right = Math.min(viewportRight, rect && rect.width > 0 ? rect.right - margin : viewportRight);
				let bottom = Math.min(viewportBottom, rect && rect.height > 0 ? rect.bottom - margin : viewportBottom);
				if (right <= left) {
					left = margin;
					right = viewportRight;
				}
				if (bottom <= top) {
					top = margin;
					bottom = viewportBottom;
				}
				return {
					left,
					top,
					right,
					bottom,
					width: Math.max(1, right - left),
					height: Math.max(1, bottom - top),
				};
			}

			function _fitInlineModalToBounds(body, container) {
				if (!body) {
					return;
				}
				const bounds = _getInlineUsableBounds(container);
				const width = Math.max(Math.min(320, bounds.width), Math.min(body.offsetWidth || 460, bounds.width));
				const height = Math.max(
					Math.min(280, bounds.height),
					Math.min(body.offsetHeight || 600, bounds.height),
				);
				modal.style.setProperty('--inline-max-width', Math.floor(bounds.width) + 'px');
				modal.style.setProperty('--inline-max-height', Math.floor(bounds.height) + 'px');
				modal.style.setProperty('--inline-width', Math.floor(width) + 'px');
				modal.style.setProperty('--inline-height', Math.floor(height) + 'px');
			}

			function _refreshInlineBounds() {
				if (!modal.classList.contains('is-inline') || !_inlineCyNode || !_getCyInstance || !_getCyContainer) {
					return;
				}
				const cy = _getCyInstance();
				const container = _getCyContainer();
				if (!cy || !container) {
					return;
				}
				_fitInlineModalToBounds(modal.querySelector('.modal-body'), container);
				_syncCyNodeSizeToModal();
				_inlinePinToNode(cy, _inlineCyNode, container);
			}

			function _enterInlineMode(rec) {
				if (!_getCyInstance || !_getCyContainer) {
					return false;
				}
				const cy = _getCyInstance();
				const container = _getCyContainer();
				if (!cy || !container) {
					return false;
				}
				const cyNode = cy.getElementById('r' + rec.id);
				if (!cyNode || cyNode.length === 0) {
					return false;
				}
				modal.classList.add('is-inline');
				_inlineRecId = rec.id;
				_inlineCyNode = cyNode;
				const _body = modal.querySelector('.modal-body');
				if (_body) {
					_body.setAttribute('data-inline-rec-id', String(rec.id));
					_fitInlineModalToBounds(_body, container);
				}
				cyNode.data('_inlineLocked', true);
				_syncCyNodeSizeToModal();
				_inlinePinToNode(cy, cyNode, container);
				const _syncSelected = () => {
					const card = container.querySelector('.cy-card-shell .record-card[data-rec-id="' + rec.id + '"]');
					modal.classList.toggle('is-selected', !!card && card.classList.contains('selected'));
				};
				_inlineRenderHandler = () => _inlinePinToNode(cy, cyNode, container);
				cy.on('render position', _inlineRenderHandler);
				_inlineSelectObserver = new MutationObserver(_syncSelected);
				_inlineSelectObserver.observe(container, {
					subtree: true,
					childList: true,
					attributes: true,
					attributeFilter: ['class'],
				});
				_inlineViewportHandler = _refreshInlineBounds;
				window.addEventListener('resize', _inlineViewportHandler);
				if (typeof ResizeObserver === 'function') {
					_inlineBoundsObserver = new ResizeObserver(_refreshInlineBounds);
					_inlineBoundsObserver.observe(container);
				}
				_syncSelected();
				const header = modal.querySelector('.record-editor-drag-handle');
				if (header) {
					_attachInlineDrag(header, cy, cyNode, container);
				}
				_inlineOutsideClickHandler = (ev) => {
					if (deps.keepOpen) return;
					if (!modal.classList.contains('is-inline')) {
						return;
					}
					if (_getCyPendingEdge && _getCyPendingEdge()) {
						return;
					}
					const t = ev.target;
					if (!t || !t.closest) {
						return;
					}
					if (t.closest('.modal-body[data-inline-rec-id]')) {
						return;
					}
					if (t.closest('.fill-menu-popup, .find-object-popup, .anchored-popup')) {
						return;
					}
					if (t.closest('.modal') && !t.closest('.modal').classList.contains('hidden')) {
						const closestModal = t.closest('.modal');
						if (closestModal !== modal) {
							return;
						}
					}
					closeModal();
				};
				setTimeout(() => {
					if (_inlineOutsideClickHandler && modal.classList.contains('is-inline')) {
						document.addEventListener('mousedown', _inlineOutsideClickHandler, true);
					}
				}, 0);
				return true;
			}
			let _inlineCyNode = null;
			function _syncCyNodeSizeToModal() {
				if (!_inlineCyNode) {
					return;
				}
				const body = modal.querySelector('.modal-body');
				if (!body) {
					return;
				}
				const w = body.offsetWidth;
				const h = body.offsetHeight;
				if (!w || !h) {
					return;
				}
				if (_inlineCyNode.data('boxW') !== w) {
					_inlineCyNode.data('boxW', w);
				}
				if (_inlineCyNode.data('boxH') !== h) {
					_inlineCyNode.data('boxH', h);
				}
			}
			function _inlinePinToNode(cy, cyNode, container) {
				if (!modal.classList.contains('is-inline')) {
					return;
				}
				const rp = cyNode.renderedPosition();
				const rect = container.getBoundingClientRect();
				let left = rect.left + rp.x;
				let top = rect.top + rp.y;
				const body = modal.querySelector('.modal-body');
				const bodyW = body ? body.offsetWidth : 460;
				const bodyH = body ? body.offsetHeight : 600;
				const bounds = _getInlineUsableBounds(container);
				const halfW = bodyW / 2;
				const halfH = bodyH / 2;
				const minLeft = bounds.left + halfW;
				const maxLeft = bounds.right - halfW;
				const minTop = bounds.top + halfH;
				const maxTop = bounds.bottom - halfH;
				left =
					minLeft <= maxLeft ? Math.max(minLeft, Math.min(maxLeft, left)) : (bounds.left + bounds.right) / 2;
				top = minTop <= maxTop ? Math.max(minTop, Math.min(maxTop, top)) : (bounds.top + bounds.bottom) / 2;
				modal.style.setProperty('--inline-left', left + 'px');
				modal.style.setProperty('--inline-top', top + 'px');
			}
			function _attachInlineDrag(header, cy, cyNode, container) {
				let dragging = false;
				let didMove = false;
				let startClientX = 0;
				let startClientY = 0;
				let startNodeX = 0;
				let startNodeY = 0;
				const onDown = (ev) => {
					if (ev.button !== 0) {
						return;
					}
					if (
						ev.target &&
						ev.target.closest &&
						ev.target.closest(
							'button, a, input, select, textarea, [contenteditable="true"], [role="button"]',
						)
					) {
						return;
					}
					dragging = true;
					didMove = false;
					startClientX = ev.clientX;
					startClientY = ev.clientY;
					const pos = cyNode.position();
					startNodeX = pos.x;
					startNodeY = pos.y;
					modal.classList.add('is-dragging');
					interactionCleanups.add(onUp);
					document.addEventListener('mousemove', onMove);
					document.addEventListener('mouseup', onUp);
					ev.preventDefault();
				};
				const onMove = (ev) => {
					if (!dragging) {
						return;
					}
					const zoom = cy.zoom() || 1;
					const dx = (ev.clientX - startClientX) / zoom;
					const dy = (ev.clientY - startClientY) / zoom;
					didMove = didMove || dx !== 0 || dy !== 0;
					cyNode.position({ x: startNodeX + dx, y: startNodeY + dy });
					const rec = canvasState.bulkRecords.find((r) => r.id === _inlineRecId);
					if (rec) {
						rec.x = startNodeX + dx;
						rec.y = startNodeY + dy;
					}
				};
				const onUp = () => {
					interactionCleanups.delete(onUp);
					const movedRec = didMove && canvasState.bulkRecords.find((record) => record.id === _inlineRecId);
					dragging = false;
					didMove = false;
					modal.classList.remove('is-dragging');
					document.removeEventListener('mousemove', onMove);
					document.removeEventListener('mouseup', onUp);
					if (movedRec) {
						publishPresenceLayout([movedRec]);
					}
				};
				header.addEventListener('mousedown', onDown);
				header._inlineDragOnDown = onDown;
			}
			function _exitInlineMode() {
				if (!modal.classList.contains('is-inline')) {
					return;
				}
				modal.classList.remove('is-inline');
				modal.classList.remove('is-dragging');
				modal.style.removeProperty('--inline-left');
				modal.style.removeProperty('--inline-top');
				modal.style.removeProperty('--inline-width');
				modal.style.removeProperty('--inline-height');
				modal.style.removeProperty('--inline-max-width');
				modal.style.removeProperty('--inline-max-height');
				if (_inlineRenderHandler && _getCyInstance) {
					const cy = _getCyInstance();
					try {
						if (cy) {
							cy.off('render position', _inlineRenderHandler);
						}
					} catch (_) {}
					_inlineRenderHandler = null;
				}
				if (_inlineSelectObserver) {
					try {
						_inlineSelectObserver.disconnect();
					} catch (_) {}
					_inlineSelectObserver = null;
				}
				if (_inlineBoundsObserver) {
					try {
						_inlineBoundsObserver.disconnect();
					} catch (_) {}
					_inlineBoundsObserver = null;
				}
				if (_inlineViewportHandler) {
					window.removeEventListener('resize', _inlineViewportHandler);
					_inlineViewportHandler = null;
				}
				modal.classList.remove('is-selected');
				const header = modal.querySelector('.record-editor-drag-handle');
				if (header && header._inlineDragOnDown) {
					header.removeEventListener('mousedown', header._inlineDragOnDown);
					header._inlineDragOnDown = null;
				}
				if (_inlineOutsideClickHandler) {
					document.removeEventListener('mousedown', _inlineOutsideClickHandler, true);
					_inlineOutsideClickHandler = null;
				}
				const _body2 = modal.querySelector('.modal-body');
				if (_body2) {
					_body2.removeAttribute('data-inline-rec-id');
				}
				modal.classList.remove('is-edge-link');
				if (_inlineCyNode && _inlineRecId != null) {
					_inlineCyNode.removeData('_inlineLocked');
					const card = document.querySelector(
						'.cy-card-shell .record-card[data-rec-id="' + _inlineRecId + '"]',
					);
					if (card) {
						const w = card.offsetWidth;
						const h = card.offsetHeight;
						if (w && h) {
							_inlineCyNode.data('boxW', w);
							_inlineCyNode.data('boxH', h);
						}
					}
				}
				_inlineCyNode = null;
				_inlineRecId = null;
			}

			let _modalToastTimer = null;
			function showModalToast(message, variant) {
				const toastEl = modal.querySelector('[data-editor-element="modal-toast"]');
				if (!toastEl) {
					return;
				}
				if (_modalToastTimer) {
					clearTimeout(_modalToastTimer);
					_modalToastTimer = null;
				}
				toastEl.className = 'modal-toast' + (variant ? ' ' + variant : '');
				toastEl.textContent = message;
				toastEl.hidden = false;
				void toastEl.offsetWidth;
				toastEl.classList.add('is-visible');
				_modalToastTimer = setTimeout(() => {
					toastEl.classList.remove('is-visible');
					setTimeout(() => {
						if (!toastEl.classList.contains('is-visible')) {
							toastEl.hidden = true;
						}
					}, 280);
				}, 2800);
			}

			let currentObject = null;
			let currentFields = [];
			let currentRules = [];
			let currentRecordTypes = []; // [{ id, name, label, isDefault }] for the open object
			let currentRecordTypeId = null; // selected record type id; filters picklist values
			let currentLayout = null; // { sections: [...], available: bool } from /api/objects/:name/layout
			let currentLayoutMode = null;
			const layoutCache = {}; // keyed by `${objectName}|${recordTypeId || ''}|${recordId || 'new'}`
			const _prefetchedLayoutKeys = new Set();
			function _layoutCacheKey(objectName, recordTypeId, recordId, mode) {
				return objectName + '|' + (recordTypeId || '') + '|' + (recordId || 'new') + '|' + (mode || '');
			}
			function _prefetchLayoutForRecord(rec) {
				if (!rec || !rec.objectName || rec.isTypeNode) {
					return;
				}
				const rt = (rec.values && rec.values.RecordTypeId) || null;
				const recId = rec.loadedFromId || null;
				const role = getCanvasShareRole();
				const mode = sharedDraftLayoutMode(role, rec, _slotAssignmentState(rec));
				const key = _layoutCacheKey(rec.objectName, rt, recId, mode);
				if (_prefetchedLayoutKeys.has(key)) {
					return;
				}
				_prefetchedLayoutKeys.add(key);
				fetchEditLayout(rec.objectName, rt, recId, mode).catch(() => {});
			}
			async function fetchEditLayout(objectName, recordTypeId, recordId, mode) {
				const key = _layoutCacheKey(objectName, recordTypeId, recordId, mode);
				if (!recordId && layoutCache[key]) {
					return layoutCache[key];
				}
				const params = new URLSearchParams();
				if (recordTypeId) {
					params.set('recordTypeId', recordTypeId);
				}
				if (recordId) {
					params.set('recordId', recordId);
				}
				if (mode) {
					params.set('mode', mode);
				}
				const url =
					'/api/objects/' +
					encodeURIComponent(objectName) +
					'/layout' +
					(params.toString() ? '?' + params.toString() : '');
				try {
					const r = await csrfFetch(url, { credentials: 'same-origin' });
					if (!r.ok) {
						return { sections: [], available: false };
					}
					const data = await r.json();
					const result = data && data.sections ? data : { sections: [], available: false };
					if (!recordId && result.available) {
						layoutCache[key] = result;
					}
					return result;
				} catch (_error) {
					return { sections: [], available: false };
				}
			}
			let currentFormValues = {};
			let currentEncryptedFormValues = new Map();
			let currentEncryptedDraftValues = new Map();
			let currentEncryptedDismissedFields = new Set();
			const editorTouchedFields = new Set();
			const sectionCollapsed = { optional: true };
			let modalEditMode = 'new';
			const guidedTouchedFields = new Set();
			const guidedCompletedFields = new Set();
			let guidedAdvanceTimer = null;
			let uploadFixFields = [];
			let activeEncryptedTooltip = null;
			let encryptedTooltipHideTimer = null;

			var _formula = (window.OrgLoom && window.OrgLoom.formula) || null;
			if (!_formula) {
				throw new Error('formula.js must load before app.js');
			}
			var parseFormula = _formula.parseFormula;
			var evalNode = _formula.evalNode;
			function tryFixValidationRules(values, fieldList, rules) {
				if (!Array.isArray(rules) || rules.length === 0) {
					return;
				}
				const opts = {
					currentFields: fieldList,
					savedRecords: canvasState.savedRecords,
					describeCache: canvasState.describeCache,
					currentRecord: canvasState.currentRecordRef,
					bulkRecords: canvasState.bulkRecords,
					bulkAssociations: canvasState.bulkAssociations,
				};
				const MAX_ITER = 6;
				for (let iter = 0; iter < MAX_ITER; iter++) {
					let changed = false;
					for (const rule of rules) {
						if (!rule._tree) {
							continue;
						}
						let fires;
						try {
							fires = evalNode(rule._tree, values, opts) === true;
						} catch (e) {
							continue;
						}
						if (!fires) {
							continue;
						}
						if (tryMakeRuleFalse(rule._tree, values, fieldList)) {
							changed = true;
						}
					}
					if (!changed) {
						break;
					}
				}
			}

			function flipCmpOp(op) {
				switch (op) {
					case '>':
						return '<';
					case '>=':
						return '<=';
					case '<':
						return '>';
					case '<=':
						return '>=';
					default:
						return op;
				}
			}

			function extendStringTo(s, targetLen, cap) {
				let out = s || '';
				while (out.length < targetLen) {
					out += 'x';
				}
				if (cap && cap > 0 && out.length > cap) {
					out = out.slice(0, cap);
				}
				return out;
			}

			function tryMakeRuleFalse(node, values, fieldList) {
				if (!node) {
					return false;
				}
				if (node.k === 'call' && node.name === 'NOT') {
					return tryMakeRuleTrue(node.args[0], values, fieldList);
				}
				if (node.k === 'call' && node.name === 'AND') {
					for (const arg of node.args) {
						if (tryMakeRuleFalse(arg, values, fieldList)) {
							return true;
						}
					}
					return false;
				}
				if (node.k === 'call' && node.name === 'OR') {
					let any = false;
					for (const arg of node.args) {
						if (tryMakeRuleFalse(arg, values, fieldList)) {
							any = true;
						}
					}
					return any;
				}
				if (node.k === 'call' && (node.name === 'ISBLANK' || node.name === 'ISNULL')) {
					const arg = node.args[0];
					if (arg && arg.k === 'field') {
						const f = fieldList.find((ff) => ff.name === arg.name);
						if (f) {
							const sample = sampleValueForField(f, fieldList, values);
							values[arg.name] = sample != null && sample !== '' ? sample : 'x';
							return true;
						}
					}
				}
				if (node.k === 'cmp') {
					const fixed = tryFixComparison(node, values, fieldList);
					if (fixed) {
						return true;
					}
				}
				return false;
			}

			function tryMakeRuleTrue(node, values, fieldList) {
				if (!node) {
					return false;
				}
				if (node.k === 'call' && (node.name === 'ISBLANK' || node.name === 'ISNULL')) {
					const arg = node.args[0];
					if (arg && arg.k === 'field' && values[arg.name]) {
						delete values[arg.name];
						return true;
					}
				}
				return false;
			}

			function tryFixComparison(node, values, fieldList) {
				const { left, right, op } = node;
				const isLen = (n) => n.k === 'call' && n.name === 'LEN' && n.args[0] && n.args[0].k === 'field';
				const lenSide = isLen(left) ? left : isLen(right) ? right : null;
				const litSide = left.k === 'lit' ? left : right.k === 'lit' ? right : null;
				if (lenSide && litSide && typeof litSide.v === 'number') {
					const fieldName = lenSide.args[0].name;
					const field = fieldList.find((ff) => ff.name === fieldName);
					if (!field) {
						return false;
					}
					const target = litSide.v;
					const lenOnLeft = lenSide === left;
					const effOp = lenOnLeft ? op : flipCmpOp(op);
					const cur = String(values[fieldName] == null ? '' : values[fieldName]);
					const cap = field.length || 0;
					let next = cur;
					if (effOp === '>' || effOp === '>=') {
						next = cur.slice(0, Math.max(0, effOp === '>' ? target : target - 1));
					} else if (effOp === '<' || effOp === '<=') {
						next = extendStringTo(cur, effOp === '<' ? target : target + 1, cap);
					} else if (effOp === '=' || effOp === '==') {
						next = cur.length === target ? extendStringTo(cur, target + 1, cap) : cur;
					} else if (effOp === '<>' || effOp === '!=') {
						next = extendStringTo(cur.slice(0, target), target, cap);
					}
					if (next !== cur) {
						values[fieldName] = next;
						return true;
					}
					return false;
				}
				const fieldNode = left.k === 'field' ? left : right.k === 'field' ? right : null;
				const literalNode = left.k === 'lit' ? left : right.k === 'lit' ? right : null;
				if (fieldNode && literalNode) {
					const fieldOnLeft = fieldNode === left;
					const effOp = fieldOnLeft ? op : flipCmpOp(op);
					const lv = literalNode.v;
					switch (effOp) {
						case '=':
						case '==':
							if (typeof lv === 'string') {
								values[fieldNode.name] = lv + 'x';
							} else if (typeof lv === 'number') {
								values[fieldNode.name] = lv + 1;
							} else {
								return false;
							}
							return true;
						case '<>':
						case '!=':
							values[fieldNode.name] = lv;
							return true;
						case '>':
							values[fieldNode.name] = typeof lv === 'number' ? lv : 0;
							return true;
						case '<':
							values[fieldNode.name] = typeof lv === 'number' ? lv : 0;
							return true;
						case '>=':
							values[fieldNode.name] = typeof lv === 'number' ? lv - 1 : 0;
							return true;
						case '<=':
							values[fieldNode.name] = typeof lv === 'number' ? lv + 1 : 0;
							return true;
					}
				}
				return false;
			}

			function tryParseRule(rule) {
				try {
					const tree = parseFormula(rule.formula || 'FALSE');
					return { tree, error: null };
				} catch (e) {
					return { tree: null, error: e.message };
				}
			}

			function _guidedRequestedFieldNames() {
				if (uploadFixFields.length) {
					return uploadFixFields;
				}
				const record = canvasState.currentRecordRef;
				const shareRole = getCanvasShareRole();
				if (
					(shareRole !== 'contributor' && shareRole !== 'editor') ||
					!record ||
					!record._recipientSlot ||
					!record.slot ||
					(record.slot.kind || 'whole-record') !== 'fields' ||
					_slotAssignmentState(record) === 'other'
				) {
					return [];
				}
				return Array.isArray(record.slot.fields) ? record.slot.fields : [];
			}

			function _guidedFieldControl(field) {
				if (!field) {
					return null;
				}
				return field.querySelector(
					'input:not([type="hidden"]):not([disabled]):not([hidden]), ' +
						'textarea:not([disabled]):not([hidden]), ' +
						'select:not([disabled]):not([hidden]), ' +
						'.lookup-clear:not([disabled]):not([hidden])',
				);
			}

			function _guidedFieldState(field) {
				if (!field) {
					return null;
				}
				const fieldName = field.dataset.field;
				const fieldType = field.dataset.type;
				const touched = guidedTouchedFields.has(fieldName);
				if (fieldType === 'boolean') {
					const control = field.querySelector('input[type="checkbox"]');
					return {
						touched,
						valid: !control || typeof control.checkValidity !== 'function' || control.checkValidity(),
						value: control ? control.checked : false,
					};
				}
				if (fieldType === 'multipicklist') {
					const control = field.querySelector('select');
					return {
						touched,
						valid: !control || typeof control.checkValidity !== 'function' || control.checkValidity(),
						values: control
							? Array.from(control.selectedOptions)
									.map((option) => option.value)
									.filter(Boolean)
							: [],
					};
				}
				const control =
					fieldType === 'reference'
						? field.querySelector('input[type="hidden"]')
						: field.querySelector('input:not([type="hidden"]), textarea, select');
				return {
					touched,
					valid: !control || typeof control.checkValidity !== 'function' || control.checkValidity(),
					value: control ? control.value : '',
				};
			}

			function _uploadFixFieldReady(field) {
				const record = canvasState.currentRecordRef;
				const name = field.dataset.field;
				const control = _guidedFieldControl(field);
				if (!currentFields.some((candidate) => candidate.name === name)) {
					return false;
				}
				if (
					!record ||
					record._inaccessible ||
					field.dataset.readonly === 'true' ||
					!control ||
					control.readOnly ||
					(typeof control.checkValidity === 'function' && !control.checkValidity())
				) {
					return false;
				}
				const encrypted = field.dataset.type === 'encryptedstring';
				if (encrypted ? !currentEncryptedFormValues.has(name) : !_fieldHasUnsavedChange(name)) {
					return false;
				}
				// Validate a temporary copy, never save the form or mark Salesforce errors
				// verified just to advance focus. Empty optional fields can be valid fixes.
				const values = { ...record.values, ...collectFormValues() };
				for (const [fieldName, value] of currentEncryptedFormValues) {
					values[fieldName] = value;
				}
				try {
					const check = window.OrgLoom.preflight
						.mount({
							canvasState: {
								bulkRecords: [{ ...record, values }],
								bulkAssociations: canvasState.bulkAssociations,
								describeCache: {
									[record.objectName]: {
										...canvasState.describeCache[record.objectName],
										fields: currentFields,
									},
								},
							},
							isRecordModified: () => true,
							recordOrdinal: () => 1,
						})
						.validateBulkRecords();
					return (
						!check.missingDescribes.size &&
						!check.issues.some((issue) => issue.field === name && issue.severity === 'error')
					);
				} catch (_) {
					return false;
				}
			}

			function _updateGuidedFieldCompletion(field) {
				if (!field) {
					return false;
				}
				const fieldName = field.dataset.field;
				if (!_guidedRequestedFieldNames().includes(fieldName)) {
					return false;
				}
				guidedTouchedFields.add(fieldName);
				const complete = uploadFixFields.length
					? _uploadFixFieldReady(field)
					: isGuidedFieldComplete(field.dataset.type, _guidedFieldState(field));
				if (complete) {
					guidedCompletedFields.add(fieldName);
				} else {
					guidedCompletedFields.delete(fieldName);
				}
				return complete;
			}

			function _fieldHasUnsavedChange(fieldName) {
				const record = canvasState.currentRecordRef;
				if (!record || !fieldName) {
					return false;
				}
				const values = collectFormValues();
				const baseline = record.values || {};
				const currentField = Object.prototype.hasOwnProperty.call(values, fieldName)
					? { [fieldName]: values[fieldName] }
					: {};
				const baselineField = Object.prototype.hasOwnProperty.call(baseline, fieldName)
					? { [fieldName]: baseline[fieldName] }
					: {};
				return changedFieldNames(currentField, baselineField).includes(fieldName);
			}

			function _scrollTaskFieldIntoView(field) {
				const scroller = modal.querySelector('[data-editor-element="modal-content"]');
				const reduceMotion =
					typeof window.matchMedia === 'function' &&
					window.matchMedia('(prefers-reduced-motion: reduce)').matches;
				if (!scroller || typeof scroller.scrollTo !== 'function') {
					field.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
					return;
				}
				const fieldRect = field.getBoundingClientRect();
				const scrollerRect = scroller.getBoundingClientRect();
				const targetTop =
					scroller.scrollTop +
					fieldRect.top -
					scrollerRect.top -
					Math.max(0, (scroller.clientHeight - fieldRect.height) / 2);
				scroller.scrollTo({
					top: Math.max(0, targetTop),
					behavior: reduceMotion ? 'auto' : 'smooth',
				});
			}

			function focusTaskField(fieldName) {
				if (!fieldName) {
					return;
				}
				window.requestAnimationFrame(() => {
					const field = modal.querySelector('.field[data-field="' + CSS.escape(fieldName) + '"]');
					if (!field) {
						return;
					}
					const section = field.closest('.field-section.collapsible');
					let expandedSection = false;
					if (section && section.classList.contains('collapsed')) {
						section.classList.remove('collapsed');
						expandedSection = true;
						const key = section.dataset.section;
						if (key && key in sectionCollapsed) {
							sectionCollapsed[key] = false;
						}
					}
					const revealField = () => {
						field.classList.add('field--task-focus');
						_scrollTaskFieldIntoView(field);
						const control = _guidedFieldControl(field);
						if (control) {
							control.focus({ preventScroll: true });
						}
						setTimeout(() => field.classList.remove('field--task-focus'), 1800);
					};
					if (expandedSection) {
						window.requestAnimationFrame(revealField);
					} else {
						revealField();
					}
				});
			}

			function _nextIncompleteGuidedField(fieldName) {
				const requested = new Set(_guidedRequestedFieldNames());
				const ordered = Array.from(modal.querySelectorAll('.field[data-field]')).filter((field) => {
					const name = field.dataset.field;
					const control = _guidedFieldControl(field);
					return requested.has(name) && !!control && field.dataset.readonly !== 'true' && !control.readOnly;
				});
				const currentIndex = ordered.findIndex((field) => field.dataset.field === fieldName);
				if (currentIndex < 0) {
					return null;
				}
				const afterCurrent = ordered.slice(currentIndex + 1).concat(ordered.slice(0, currentIndex));
				return afterCurrent.find((field) => !guidedCompletedFields.has(field.dataset.field)) || null;
			}

			function _scheduleGuidedAdvance(fieldName, sourceControl, allowSourceFocus) {
				if (guidedAdvanceTimer) {
					clearTimeout(guidedAdvanceTimer);
				}
				guidedAdvanceTimer = setTimeout(() => {
					guidedAdvanceTimer = null;
					if (modal.classList.contains('hidden') || !guidedCompletedFields.has(fieldName)) {
						return;
					}
					const active = document.activeElement;
					if (active === sourceControl && !allowSourceFocus) {
						return;
					}
					const activeRequestedField =
						active && active.closest
							? active.closest(uploadFixFields.length ? '.field[data-field]' : '.field.is-slot-field')
							: null;
					if (activeRequestedField && activeRequestedField.dataset.field !== fieldName) {
						return;
					}
					const next = _nextIncompleteGuidedField(fieldName);
					if (next) {
						focusTaskField(next.dataset.field);
					}
				}, 0);
			}

			function openInsertModal(objectName, opts) {
				const version = ++openVersion;
				const stillOpen = () => version === openVersion && !modal.classList.contains('hidden');
				opts = opts || {};
				uploadFixFields = Array.isArray(opts.uploadFixFields)
					? Array.from(
							new Set(
								opts.uploadFixFields.filter(
									(name) => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(name),
								),
							),
						)
					: [];
				objectName = objectName || (opts.record && opts.record.objectName);
				objectName = typeof objectName === 'string' ? objectName.trim() : '';
				if (!objectName) {
					showBulkToast(
						'This record is missing its Salesforce object type. Reload the canvas and try again.',
						'error',
					);
					return;
				}
				guidedTouchedFields.clear();
				guidedCompletedFields.clear();
				if (guidedAdvanceTimer) {
					clearTimeout(guidedAdvanceTimer);
					guidedAdvanceTimer = null;
				}
				currentObject = objectName;
				canvasState.currentRecordRef = opts.record || null;
				currentFields = [];
				currentRules = [];
				currentFormValues = {};
				currentEncryptedFormValues = new Map();
				currentEncryptedDraftValues = new Map();
				currentEncryptedDismissedFields = new Set();
				editorTouchedFields.clear();
				sectionCollapsed.optional = true;
				modalEditMode =
					canvasState.currentRecordRef && canvasState.currentRecordRef.loadedFromId ? 'existing' : 'new';
				updateRecordHeaderIdentity();
				currentLayoutMode = sharedDraftLayoutMode(
					getCanvasShareRole(),
					canvasState.currentRecordRef,
					_slotAssignmentState(canvasState.currentRecordRef),
				);
				_exitInlineMode();
				modal.classList.remove('hidden');
				const presenceFocus = _presenceFocusForRecord(canvasState.currentRecordRef);
				if (presenceFocus) {
					try {
						pushPresenceFocus(presenceFocus);
					} catch (_) {
						/* presence is best-effort */
					}
				}
				if (opts.record) {
					_enterInlineMode(opts.record);
				}
				modal.querySelector('[data-editor-element="modal-title"]').textContent = 'Loading ' + objectName + '…';
				_syncSubmitButtonAccess({ loading: true });
				modal.querySelector('[data-editor-element="modal-content"]').innerHTML =
					'<p class="center">Loading fields…</p>';

				// Keep rules available for rule-aware sample autofill, but present object metadata in the schema builder.
				const sharedDraft = !!(
					getCanvasShareRole() &&
					canvasState.currentRecordRef &&
					!canvasState.currentRecordRef.loadedFromId
				);
				const sharedSnapshot =
					sharedDraft && canvasState.draftDescribeCache && canvasState.draftDescribeCache[objectName];
				const describePromise = sharedDraft
					? resolveSharedDraftDescribe(ensureDescribe, objectName, sharedSnapshot)
					: ensureDescribe(objectName);
				const rulesPromise = sharedDraft
					? Promise.resolve({ rules: [], unavailable: null })
					: ensureRules(objectName);
				Promise.all([describePromise, rulesPromise])
					.then(([describe, rulesResult]) => {
						if (!stillOpen()) return;
						// Describe metadata, not hard-coded object rules, determines what this user may edit.
						currentFields = (describe.fields || []).map((field) =>
							Object.assign({}, field, {
								picklistValues: Array.isArray(field.picklistValues)
									? field.picklistValues.map((value) => Object.assign({}, value))
									: [],
								picklistValuesByRecordType: Object.assign({}, field.picklistValuesByRecordType || {}),
							}),
						);
						currentRecordTypes = describe.recordTypes || [];
						if (canvasState.currentRecordRef) {
							encryptedFields.adoptRuntimeValues(canvasState.currentRecordRef, canvasState);
						}
						const draftRt =
							canvasState.currentRecordRef &&
							((canvasState.currentRecordRef.values &&
								canvasState.currentRecordRef.values.RecordTypeId) ||
								canvasState.currentRecordRef._recordTypeId);
						const savedRt =
							!canvasState.currentRecordRef &&
							canvasState.savedRecords[currentObject] &&
							canvasState.savedRecords[currentObject].RecordTypeId;
						const hasExplicitRecordTypeId = !!(draftRt || savedRt);
						currentRecordTypeId =
							draftRt ||
							savedRt ||
							describe.defaultRecordTypeId ||
							(currentRecordTypes[0] && currentRecordTypes[0].id) ||
							null;
						currentRules = Array.isArray(rulesResult && rulesResult.rules) ? rulesResult.rules : [];
						const _resolveTitle = () => {
							if (!canvasState.currentRecordRef || !canvasState.currentRecordRef.values) {
								return null;
							}
							const v = canvasState.currentRecordRef.values;
							if (v.FirstName != null || v.LastName != null) {
								const composed = ((v.FirstName || '') + ' ' + (v.LastName || '')).trim();
								if (composed) {
									return composed;
								}
							}
							const fields = describe && Array.isArray(describe.fields) ? describe.fields : [];
							const nf = fields.find((f) => f.nameField);
							if (nf && v[nf.name]) {
								return String(v[nf.name]);
							}
							return (
								v.Name ||
								v.CaseNumber ||
								v.OrderNumber ||
								v.WorkOrderNumber ||
								v.Subject ||
								v.Title ||
								null
							);
						};
						let titlePrefix;
						let subtitleText;
						if (canvasState.currentRecordRef) {
							const resolvedName = _resolveTitle();
							titlePrefix =
								resolvedName || describe.label + ' #' + recordOrdinal(canvasState.currentRecordRef);
							subtitleText = describe.label;
						} else {
							titlePrefix = 'New ' + describe.label;
							subtitleText = describe.label;
						}
						modal.querySelector('[data-editor-element="modal-title"]').textContent = titlePrefix;
						updateRecordHeaderIdentity();
						const subtitleEl = modal.querySelector('[data-editor-element="modal-subtitle"]');
						if (subtitleEl) {
							subtitleEl.textContent = subtitleText;
						}
						const recId = canvasState.currentRecordRef && canvasState.currentRecordRef.loadedFromId;
						return fetchEditLayout(currentObject, currentRecordTypeId, recId, currentLayoutMode)
							.then(async (layout) => {
								if (!stillOpen()) return;
								currentLayout = layout;
								let picklistLayout = layout;
								if (layout && layout.recordTypeId && !hasExplicitRecordTypeId) {
									currentRecordTypeId = layout.recordTypeId;
									if (canvasState.currentRecordRef) {
										Object.defineProperty(canvasState.currentRecordRef, '_recordTypeId', {
											value: layout.recordTypeId,
											writable: true,
											configurable: true,
										});
									}
									if (layout.picklistValuesRecordTypeId !== currentRecordTypeId) {
										picklistLayout = await fetchEditLayout(
											currentObject,
											currentRecordTypeId,
											recId,
											currentLayoutMode,
										);
									}
								}
								if (!stillOpen()) return;
								if (canvasState.currentRecordRef && layout && layout.recordAccess) {
									Object.defineProperty(canvasState.currentRecordRef, '_recordAccess', {
										value: layout.recordAccess,
										writable: true,
										configurable: true,
									});
									Object.defineProperty(canvasState.currentRecordRef, '_recordAccessCheckedAt', {
										value: Date.now(),
										writable: true,
										configurable: true,
									});
									renderBulkView();
								}
								if (
									picklistLayout &&
									picklistLayout.picklistValuesRecordTypeId === currentRecordTypeId
								) {
									applyLayoutPicklistFallback(
										currentFields,
										picklistLayout.picklistValues,
										currentRecordTypeId,
									);
								}
							})
							.catch(() => {
								currentLayout = null;
							})
							.then(() => {
								if (!stillOpen()) return;
								let initialValues = canvasState.currentRecordRef
									? canvasState.currentRecordRef.values
									: canvasState.savedRecords[currentObject];
								const hasExplicit = initialValues && Object.keys(initialValues).length > 0;
								if (!hasExplicit && currentLayout && currentLayout.defaults) {
									initialValues = currentLayout.defaults;
								}
								// Build dependent options from the record, before reading any empty form controls.
								currentFormValues = Object.assign({}, initialValues || {});
								renderForm('');
								wireLiveValidation();
								_syncSubmitButtonAccess();
								if (initialValues && Object.keys(initialValues).length > 0) {
									populateForm(initialValues);
									refreshEditorValidation();
								}
								focusTaskField(opts.focusField);
							});
					})
					.catch((err) => {
						if (!stillOpen()) return;
						modal.querySelector('[data-editor-element="modal-content"]').innerHTML =
							'<div class="banner error">Failed to load fields: ' + escapeHtml(err.message) + '</div>';
					});
			}

			function closeModal() {
				if (modal.classList.contains('hidden')) return;
				openVersion += 1;
				for (const cleanup of Array.from(interactionCleanups)) cleanup();
				formLifecycle.abort();
				uploadFixFields = [];
				closeEncryptedTooltip();
				if (guidedAdvanceTimer) {
					clearTimeout(guidedAdvanceTimer);
					guidedAdvanceTimer = null;
				}
				const closingRecord = canvasState.currentRecordRef;
				_exitInlineMode();
				modal.classList.add('hidden');
				currentObject = null;
				currentFields = [];
				canvasState.currentRecordRef = null;
				releaseRecordFieldLocks(closingRecord);
				currentRecordTypes = [];
				currentRecordTypeId = null;
				currentLayoutMode = null;
				currentEncryptedFormValues.clear();
				currentEncryptedDraftValues.clear();
				currentEncryptedDismissedFields.clear();
				try {
					pushPresenceFocus(null);
				} catch (_) {
					/* best-effort */
				}
				if (typeof deps.onClose === 'function') deps.onClose();
			}

			async function unlinkRecord(record, targetState = canvasState) {
				if (!canEditCanvasStructure()) {
					showBulkToast('Only the canvas owner or an editor can unlink records.', 'info');
					return false;
				}
				if (!record || !record.loadedFromId || record._inaccessible || record.isTypeNode || record.isPending) {
					return false;
				}
				if (!targetState.bulkRecords.includes(record)) return false;
				if (record.pendingDelete) {
					unmarkPendingDelete(record.id);
				}
				applyLoadedRecordUnlink(targetState, record);
				if (canvasState.currentRecordRef === record) {
					modalEditMode = 'new';
					rerenderFormPreservingValues();
				}
				if (targetState.graphView === 'bulk') {
					renderBulkView();
				}
				return true;
			}

			function updateRecordHeaderIdentity() {
				const loadedId = canvasState.currentRecordRef && canvasState.currentRecordRef.loadedFromId;
				const existing = modalEditMode === 'existing' && !!loadedId;
				const recordId = modal.querySelector('[data-editor-element="record-id"]');
				recordId.textContent = existing ? loadedId : '';
				recordId.hidden = !existing;
				const title = modal.querySelector('[data-editor-element="modal-title"]');
				const recordName = title.textContent;
				title.textContent = recordName;
				if (!existing) {
					return;
				}
				const sfBase = (window.SF_INSTANCE_URL || '').replace(/\/+$/, '');
				const recordUrl = sfBase
					? sfBase +
						'/lightning/r/' +
						encodeURIComponent(currentObject) +
						'/' +
						encodeURIComponent(loadedId) +
						'/view'
					: null;
				if (recordUrl) {
					title.innerHTML =
						'<a href="' +
						escapeHtml(recordUrl) +
						'" target="_blank" rel="noopener" title="View in Salesforce">' +
						escapeHtml(recordName) +
						'</a>';
				}
			}

			function renderForm(banner) {
				formLifecycle.abort();
				formLifecycle = new AbortController();
				closeEncryptedTooltip();
				const byLabel = (a, b) => a.label.localeCompare(b.label);
				const hasLoadedSalesforceRecord = !!(
					canvasState.currentRecordRef && canvasState.currentRecordRef.loadedFromId
				);
				const recordTypeChoices = retainCurrentRecordType(
					currentRecordTypes,
					hasLoadedSalesforceRecord ? currentRecordTypeId : null,
				);
				const showRecordTypeField =
					recordTypeChoices.length > 1 ||
					recordTypeChoices.some((recordType) => recordType.available === false);
				const isCompound = (f) => f && (f.type === 'address' || f.type === 'location');
				const recipientRecord = canvasState.currentRecordRef;
				const recipientSlot = recipientRecord && recipientRecord._recipientSlot ? recipientRecord.slot : null;
				const recipientSlotFields =
					recipientSlot && (recipientSlot.kind || 'whole-record') === 'fields'
						? new Set(Array.isArray(recipientSlot.fields) ? recipientSlot.fields : [])
						: null;
				const shareRole = getCanvasShareRole();
				const recipientCanEdit = canEditCurrentRecord();
				const salesforceFieldWritable = (field) =>
					modalEditMode === 'new' ? !!field.createable : !!field.updateable;
				const contributorCanPropose = (field) => {
					if (shareRole !== 'contributor' || !recipientCanEdit || !recipientSlot || !field || !field.name) {
						return false;
					}
					const requested = !recipientSlotFields || recipientSlotFields.has(field.name);
					if (!requested) {
						return false;
					}
					return salesforceFieldWritable(field);
				};
				const isWritable = (field) => {
					if (shareRole === 'viewer') {
						return false;
					}
					if (shareRole === 'contributor') {
						return contributorCanPropose(field);
					}
					return salesforceFieldWritable(field);
				};
				const partialFieldSet =
					canvasState.currentRecordRef && Array.isArray(canvasState.currentRecordRef._loadedFieldNames)
						? new Set(canvasState.currentRecordRef._loadedFieldNames)
						: null;
				const isPartialLoad = !!partialFieldSet;
				const inPartial = (name) => !partialFieldSet || partialFieldSet.has(name);
				const isStateCountryTextLegacy = (f) => {
					if (!f || f.type !== 'string') {
						return false;
					}
					return currentFields.some((cf) => cf.name === f.name + 'Code' && isPicklistLikeField(cf));
				};
				const regular = currentFields.filter(
					(f) =>
						!(f.name === 'RecordTypeId' && showRecordTypeField) &&
						!isCompound(f) &&
						!isStateCountryTextLegacy(f) &&
						inPartial(f.name),
				);
				const writable = regular.filter(isWritable);
				const visibleFields = visibleRecordFields({
					modalEditMode,
					recipientFieldRequest: !!recipientSlotFields,
					recipientCanEdit,
					sharedReadOnly: !!shareRole && !recipientCanEdit,
					regular,
					writable,
					salesforceFieldWritable,
				});
				const visibleFieldNames = new Set(visibleFields.map((field) => field.name));
				const slotFieldNames = (() => {
					const rec = canvasState.currentRecordRef;
					if (!rec || !rec.slot) {
						return null;
					}
					const kind = rec.slot.kind || 'whole-record';
					if (kind !== 'fields') {
						return null;
					}
					return new Set(Array.isArray(rec.slot.fields) ? rec.slot.fields : []);
				})();
				const slotLockNonSlot = !!(
					shareRole === 'contributor' &&
					slotFieldNames &&
					canvasState.currentRecordRef &&
					canvasState.currentRecordRef._recipientSlot
				);
				const showRecipientSlotAccessNotice = shouldShowRecipientSlotAccessNotice(
					shareRole,
					canvasState.currentRecordRef,
					slotFieldNames,
				);
				const slotFieldsInaccessible = (() => {
					if (!slotFieldNames || slotFieldNames.size === 0) {
						return 0;
					}
					const writableNames = new Set(currentFields.filter(isWritable).map((f) => f.name));
					let n = 0;
					for (const nm of slotFieldNames) {
						if (!writableNames.has(nm)) {
							n++;
						}
					}
					return n;
				})();
				const projectedUnavailableFieldCount = (() => {
					const unavailable = Number(
						canvasState.currentRecordRef &&
							canvasState.currentRecordRef.slot &&
							canvasState.currentRecordRef.slot.unavailableFieldCount,
					);
					return Number.isSafeInteger(unavailable) && unavailable > 0 ? unavailable : 0;
				})();
				const slotAssignedToOther = !!(
					shareRole === 'contributor' &&
					canvasState.currentRecordRef &&
					canvasState.currentRecordRef._recipientSlot &&
					_slotAssignmentState(canvasState.currentRecordRef) === 'other'
				);
				const viewerReadOnly = shareRole === 'viewer';
				const forceReadOnly = !recipientCanEdit || slotAssignedToOther;

				let html = banner ? banner : '';
				if (salesforceRecordIsReadOnly(canvasState.currentRecordRef)) {
					html +=
						canvasState.currentRecordRef._recordAccess.hasReadAccess === false
							? '<div class="banner info" style="margin-bottom:0.7em"><strong>Unavailable in Salesforce.</strong> ' +
								'This record may have been deleted, or your Salesforce user no longer has access. Your local changes are preserved.</div>'
							: '<div class="banner info" style="margin-bottom:0.7em"><strong>Read-only in Salesforce.</strong> ' +
								'Your Salesforce user can view this record but cannot update it. Its fields are locked in Org Loom.</div>';
				}
				if (isPartialLoad) {
					const n = partialFieldSet.size;
					html +=
						'<div class="banner info" style="margin-bottom:0.7em">' +
						'<strong>Showing ' +
						n +
						' loaded field' +
						(n === 1 ? '' : 's') +
						'.</strong> ' +
						"This record was imported via SOQL with a focused SELECT: fields you didn't query aren't shown here. " +
						"They're preserved on Salesforce; an Update only sends the fields below. " +
						'To edit other fields, remove this record from the canvas and import it again.' +
						'</div>';
				}
				if (!viewerReadOnly) {
					if (slotAssignedToOther) {
						const who =
							(canvasState.currentRecordRef.slot &&
								(canvasState.currentRecordRef.slot.assigneeName ||
									canvasState.currentRecordRef.slot.assigneeEmail)) ||
							'another teammate';
						html +=
							'<div class="banner info slot-banner">' +
							'<strong>Reserved for ' +
							escapeHtml(who) +
							'.</strong> ' +
							'Only the assigned teammate can complete this field request; everything is read-only for you.' +
							'</div>';
					} else if (slotLockNonSlot || showRecipientSlotAccessNotice) {
						const count = slotFieldNames.size + projectedUnavailableFieldCount;
						const inaccessible = slotFieldsInaccessible + projectedUnavailableFieldCount;
						const fillable = count - inaccessible;
						const hiddenNote =
							inaccessible > 0
								? ' <strong>' +
									inaccessible +
									' requested field' +
									(inaccessible === 1 ? '' : 's') +
									' ' +
									(inaccessible === 1 ? 'isn’t' : 'aren’t') +
									' shown</strong>: ' +
									(inaccessible === 1 ? "it's" : "they're") +
									' hidden by field-level security or read-only for your Salesforce user, so ' +
									(inaccessible === 1 ? "it can't" : "they can't") +
									' be filled here.'
								: '';
						if (fillable <= 0) {
							html +=
								'<div class="banner warn slot-banner">' +
								'<strong>The field(s) marked for you aren’t available to your Salesforce user.</strong> ' +
								(count === 1 ? "It's" : "They're") +
								' hidden by field-level security or read-only for you, so this field request can’t be completed. ' +
								'Ask the sender or your Salesforce admin for access.' +
								'</div>';
						} else if (inaccessible > 0) {
							html += '<div class="banner warn slot-banner">' + hiddenNote + '</div>';
						}
					}
				}
				html += '<form data-editor-element="insert-form" autocomplete="off">';

				updateRecordHeaderIdentity();
				if (
					modalEditMode === 'existing' &&
					canvasState.currentRecordRef &&
					canvasState.currentRecordRef.loadedFromId
				) {
					const accessNotice = !sharedRecordEditAccess(
						shareRole,
						canvasState.currentRecordRef,
						_slotAssignmentState(canvasState.currentRecordRef),
					)
						? 'Read-only on this shared canvas.'
						: recipientCanEdit && shareRole === 'contributor'
							? 'Your changes will be submitted to the canvas owner for review.'
							: '';
					if (accessNotice) {
						html += '<p class="record-editor-access-notice">' + accessNotice + '</p>';
					}
				}

				if (showRecordTypeField) {
					html +=
						'<div class="field-section">' +
						'<div class="field-section-header">Record Type</div>' +
						'<div class="fields">' +
						'<div class="field" data-field="RecordTypeId" data-type="recordtype">' +
						'<label for="f_RecordTypeId">Record Type <span class="meta">picklist filtering</span></label>' +
						'<select id="f_RecordTypeId" name="RecordTypeId" data-record-type-select>' +
						recordTypeChoices
							.map(
								(rt) =>
									'<option value="' +
									escapeHtml(rt.id) +
									'"' +
									(rt.id === currentRecordTypeId ? ' selected' : '') +
									(rt.available === false ? ' disabled' : '') +
									'>' +
									escapeHtml(rt.label || rt.name) +
									'</option>',
							)
							.join('') +
						'</select>' +
						'<div class="help">Switching record type updates the available choices without clearing current values.</div>' +
						'</div>' +
						'</div>' +
						'</div>';
				}

				const useLayout =
					currentLayout &&
					currentLayout.available &&
					Array.isArray(currentLayout.sections) &&
					currentLayout.sections.length > 0;
				if (useLayout) {
					const renderedNames = new Set(showRecordTypeField ? ['RecordTypeId'] : []);
					currentLayout.sections.forEach((section) => {
						const rowsHtml = section.rows
							.map((row) => {
								const cells = row
									.map((cell) => {
										const cellFields = fieldsForLayoutCell(
											currentFields,
											cell.apiNames || cell.apiName,
										).filter(
											(f) =>
												!renderedNames.has(f.name) &&
												visibleFieldNames.has(f.name) &&
												!isCompound(f) &&
												!isStateCountryTextLegacy(f) &&
												inPartial(f.name) &&
												!(f.name === 'RecordTypeId' && showRecordTypeField),
										);
										const locationCompounds = new Set(
											cellFields
												.filter((field) => geolocationCoordinateKind(field, currentFields))
												.map((field) => field.compoundFieldName),
										);
										if (locationCompounds.size > 0) {
											currentFields.forEach((field) => {
												if (
													locationCompounds.has(field.compoundFieldName) &&
													geolocationCoordinateKind(field, currentFields) &&
													!cellFields.includes(field) &&
													!renderedNames.has(field.name) &&
													visibleFieldNames.has(field.name) &&
													inPartial(field.name)
												) {
													cellFields.push(field);
												}
											});
										}
										cellFields.forEach((field) => renderedNames.add(field.name));
										const fieldsHtml = renderFieldCollection(cellFields, (f) => {
											const isSlotField = !!(slotFieldNames && slotFieldNames.has(f.name));
											const readOnly =
												!isWritable(f) || forceReadOnly || (slotLockNonSlot && !isSlotField);
											return { readOnly, isSlotField };
										});
										if (!fieldsHtml) {
											return '';
										}
										return '<div class="layout-cell">' + fieldsHtml + '</div>';
									})
									.join('');
								if (!cells) {
									return '';
								}
								return (
									'<div class="layout-row" style="--cols:' +
									Math.max(1, row.length) +
									'">' +
									cells +
									'</div>'
								);
							})
							.filter(Boolean)
							.join('');
						if (!rowsHtml) {
							return;
						}
						html +=
							'<div class="field-section layout-section">' +
							(section.heading
								? '<div class="field-section-header">' + escapeHtml(section.heading) + '</div>'
								: '') +
							'<div class="layout-rows">' +
							rowsHtml +
							'</div>' +
							'</div>';
					});
					const remaining = visibleFields.filter((f) => !renderedNames.has(f.name));
					if (remaining.length > 0) {
						const optClass = sectionCollapsed.optional ? ' collapsed' : '';
						html +=
							'<div class="field-section collapsible' +
							optClass +
							'" data-section="optional">' +
							'<div class="field-section-header" data-toggle>Additional fields <span class="count">(' +
							remaining.length +
							')</span>' +
							'<span class="chevron">\u25BC</span>' +
							'</div>' +
							'<div class="fields">' +
							renderFieldCollection(remaining.sort(byLabel), (f) => {
								const isSlotField = !!(slotFieldNames && slotFieldNames.has(f.name));
								const readOnly = !isWritable(f) || forceReadOnly || !!(slotLockNonSlot && !isSlotField);
								return { readOnly, isSlotField };
							}) +
							'</div>' +
							'</div>';
					}
				} else if (shareRole && !recipientCanEdit) {
					html +=
						'<div class="field-section">' +
						'<div class="field-section-header">Fields <span class="count">(' +
						visibleFields.length +
						')</span></div>' +
						'<div class="fields">' +
						renderFieldCollection(visibleFields.sort(byLabel), () => ({
							readOnly: true,
							isSlotField: false,
						})) +
						'</div>' +
						'</div>';
				} else if (visibleFields.length > 0) {
					const optClass = sectionCollapsed.optional ? ' collapsed' : '';
					html +=
						'<div class="field-section collapsible' +
						optClass +
						'" data-section="optional">' +
						'<div class="field-section-header" data-toggle>Additional fields <span class="count">(' +
						visibleFields.length +
						')</span>' +
						'<span class="chevron">\u25BC</span>' +
						'</div>' +
						'<div class="fields">' +
						renderFieldCollection(visibleFields.sort(byLabel), (f) => {
							const isSlotField = !!(slotFieldNames && slotFieldNames.has(f.name));
							const readOnly = !isWritable(f) || forceReadOnly || !!(slotLockNonSlot && !isSlotField);
							return { readOnly, isSlotField };
						}) +
						'</div>' +
						'</div>';
				}

				const _SYSTEM_FIELDS = new Set([
					'attributes',
					'Id',
					'CreatedDate',
					'CreatedById',
					'LastModifiedDate',
					'LastModifiedById',
					'SystemModstamp',
					'LastReferencedDate',
					'LastViewedDate',
					'IsDeleted',
					'OwnerId',
					'RecordTypeId',
					'MasterRecordId',
				]);
				const _orphanRecord = canvasState.currentRecordRef;
				const _isCrossOrgCarryover = !!(_orphanRecord && _orphanRecord._wasLoadedFromOrgId);
				const _canvasMigration = window.Orgloom && window.Orgloom.canvasMigrate;
				const _guidedMigrationActive = !!(
					_canvasMigration &&
					_canvasMigration.isActive &&
					_canvasMigration.isActive() &&
					_canvasMigration.usesGuidedResolution &&
					_canvasMigration.usesGuidedResolution()
				);
				const _orphanValues = (_orphanRecord && _orphanRecord.values) || {};
				const _orphanFieldSet = new Set(currentFields.map((f) => f.name));
				const _orphanNames =
					!_isCrossOrgCarryover || _guidedMigrationActive
						? []
						: Object.keys(_orphanValues)
								.filter((k) => {
									if (!k || k.startsWith('_')) {
										return false;
									}
									if (_SYSTEM_FIELDS.has(k)) {
										return false;
									}
									return !_orphanFieldSet.has(k);
								})
								.sort();
				if (_orphanNames.length > 0) {
					const _orphanWritableOptions = currentFields
						.filter((f) => isWritable(f) && !isCompound(f))
						.sort(byLabel)
						.map(
							(f) =>
								'<option value="' +
								escapeHtml(f.name) +
								'">' +
								escapeHtml(f.label || f.name) +
								' (' +
								escapeHtml(f.name) +
								')</option>',
						)
						.join('');
					html +=
						'<div class="field-section field-section--orphans" data-section="orphans">' +
						'<div class="field-section-header">' +
						'Fields unavailable in destination <span class="count">(' +
						_orphanNames.length +
						')</span>' +
						'</div>' +
						'<div class="orphan-banner banner warn">' +
						'These values traveled with the record when you switched Salesforce orgs. ' +
						'These fields are not available through your current Salesforce connection. ' +
						'They may not exist on <code>' +
						escapeHtml(currentObject) +
						'</code> in this org, or your Salesforce permissions may hide them. ' +
						'Salesforce cannot accept them through this connection. Ask an admin if you expected access. ' +
						'Otherwise, <strong>drop</strong> values you do not need or <strong>copy</strong> ' +
						'each value to an available destination field.' +
						'<div><button type="button" class="button secondary orphan-refresh" data-orphan-refresh>' +
						'Refresh Salesforce fields</button></div>' +
						'</div>' +
						'<div class="orphan-fields">' +
						_orphanNames
							.map((name) => {
								const val = _orphanValues[name];
								const valDisplay =
									val == null || val === ''
										? '<span class="orphan-empty">(empty)</span>'
										: '<code>' + escapeHtml(formatCarryoverValue(val)) + '</code>';
								return (
									'<div class="orphan-row" data-orphan-field="' +
									escapeHtml(name) +
									'">' +
									'<div class="orphan-meta">' +
									'<div class="orphan-name"><code>' +
									escapeHtml(name) +
									'</code></div>' +
									'<div class="orphan-value">' +
									valDisplay +
									'</div>' +
									'</div>' +
									'<div class="orphan-actions">' +
									'<select class="orphan-target" data-orphan-target="' +
									escapeHtml(name) +
									'">' +
									'<option value="">Copy to…</option>' +
									_orphanWritableOptions +
									'</select>' +
									'<button type="button" class="button secondary orphan-copy" data-orphan-copy="' +
									escapeHtml(name) +
									'" disabled>Copy</button>' +
									'<button type="button" class="button secondary danger orphan-drop" data-orphan-drop="' +
									escapeHtml(name) +
									'">Drop</button>' +
									'</div>' +
									'</div>'
								);
							})
							.join('') +
						'</div>' +
						'</div>';
				}

				const _migApi = window.Orgloom && window.Orgloom.canvasMigrate;
				const _migRec = canvasState.currentRecordRef;
				if (_migApi && _migApi.isActive() && _migRec && !_guidedMigrationActive) {
					const _ann = _migApi.annotationFor(_migRec.id);
					const _annIssues = (_ann && _ann.issues) || [];
					const _rtIssue = _annIssues.find((i) => i.kind === 'recordtype-unresolved');
					const _plIssues = _annIssues.filter((i) => i.kind === 'picklist-mismatch');
					const _rtResolved = !!(_migRec._migrateRecordTypeId || _migRec._migrateClearRecordType);
					if (_rtIssue || _plIssues.length || _rtResolved) {
						let _migRows = '';
						if (_rtIssue || _rtResolved) {
							const _rtOpts = (currentRecordTypes || [])
								.map(
									(rt) =>
										'<option value="' +
										escapeHtml(rt.id) +
										'"' +
										(_migRec._migrateRecordTypeId === rt.id ? ' selected' : '') +
										'>' +
										escapeHtml(rt.label || rt.name) +
										'</option>',
								)
								.join('');
							const _srcDev =
								(_rtIssue && _rtIssue.developerName) || _migRec._sourceRecordTypeDeveloperName || '';
							_migRows +=
								'<div class="migrate-row">' +
								'<div class="migrate-meta">' +
								'<div class="migrate-label">Record type</div>' +
								'<div class="migrate-sub">Source: <code>' +
								escapeHtml(_srcDev) +
								'</code>' +
								(_rtIssue ? ' (not in this org)' : '') +
								'</div>' +
								'</div>' +
								'<select class="migrate-select" data-migrate-rt-select>' +
								'<option value="">Pick a record type…</option>' +
								_rtOpts +
								'<option value="__clear__"' +
								(_migRec._migrateClearRecordType ? ' selected' : '') +
								'>No record type</option>' +
								'</select>' +
								'</div>';
						}
						_plIssues.forEach((iss) => {
							const _tf = (currentFields || []).find(
								(f) => f.name && String(f.name).toLowerCase() === String(iss.field).toLowerCase(),
							);
							const _plOpts = (
								_tf
									? picklistValuesForField(
											_tf,
											_migRec.values || {},
											_migRec._migrateRecordTypeId || currentRecordTypeId,
										).values
									: []
							)
								.map(
									(v) =>
										'<option value="' +
										escapeHtml(v.value) +
										'">' +
										escapeHtml(v.label || v.value) +
										'</option>',
								)
								.join('');
							(iss.invalidValues || []).forEach((sv) => {
								_migRows +=
									'<div class="migrate-row">' +
									'<div class="migrate-meta">' +
									'<div class="migrate-label">' +
									escapeHtml(iss.field) +
									'</div>' +
									'<div class="migrate-sub">Value <code>' +
									escapeHtml(sv) +
									'</code> isn’t valid here</div>' +
									'</div>' +
									'<select class="migrate-select" data-migrate-pl-field="' +
									escapeHtml(iss.field) +
									'" data-migrate-pl-source="' +
									escapeHtml(sv) +
									'">' +
									'<option value="__keep__">Keep as-is (will warn)</option>' +
									_plOpts +
									'<option value="">Drop value</option>' +
									'</select>' +
									'</div>';
							});
						});
						const _migCount =
							(_rtIssue ? 1 : 0) +
							_plIssues.reduce((n, i) => n + (i.invalidValues ? i.invalidValues.length : 0), 0);
						const _migBannerCls = _migCount > 0 ? 'banner warn' : 'banner';
						const _migBanner =
							_migCount > 0
								? 'Resolve these so the record can be recreated in the destination org.'
								: 'All migration issues on this record are resolved.';
						html +=
							'<div class="field-section field-section--migrate" data-section="migrate">' +
							'<div class="field-section-header">Migration fixes' +
							(_migCount > 0 ? ' <span class="count">(' + _migCount + ')</span>' : '') +
							'</div>' +
							'<div class="orphan-banner ' +
							_migBannerCls +
							'">' +
							_migBanner +
							'</div>' +
							'<div class="migrate-fixes">' +
							_migRows +
							'</div>' +
							'</div>';
					}
				}

				html += '</form>';

				modal.querySelector('[data-editor-element="modal-content"]').innerHTML = html;
				scopeEditorIds(modal.querySelector('[data-editor-element="modal-content"]'), deps.editorId);

				modal.querySelectorAll('[data-toggle]').forEach((h) => {
					h.addEventListener('click', () => {
						const section = h.parentElement;
						section.classList.toggle('collapsed');
						const key = section.dataset.section;
						if (key && key in sectionCollapsed) {
							sectionCollapsed[key] = section.classList.contains('collapsed');
						}
					});
				});
				modal.querySelectorAll('[data-open-assoc-field]').forEach((btn) => {
					btn.addEventListener('click', () => {
						const lock = associationLockForField(btn.dataset.openAssocField);
						if (!lock || !lock.target || lock.target._inaccessible) {
							return;
						}
						if (
							!deps.openLinkedRecord &&
							(editorTouchedFields.size > 0 || currentEncryptedDraftValues.size > 0)
						) {
							showBulkToast('Save or cancel your edits before opening the linked record.', 'info');
							return;
						}
						const target = lock.target;
						if (deps.openLinkedRecord) {
							deps.openLinkedRecord(target);
						} else {
							closeModal();
							openInsertModal(target.objectName, { record: target });
						}
					});
				});
				modal.querySelectorAll('[data-disconnect-assoc]').forEach((btn) => {
					btn.addEventListener('click', (e) => {
						e.preventDefault();
						if (!canEditCanvasStructure()) {
							btn.remove();
							showBulkToast(
								'Only the canvas owner or an editor can change record relationships.',
								'info',
							);
							return;
						}
						const assocId = parseInt(btn.dataset.disconnectAssoc, 10);
						deleteAssociation(assocId);
						rerenderFormPreservingValues();
					});
				});
				modal.querySelectorAll('.lookup-picker').forEach(_wireLookupPicker);
				const rtSelect = modal.querySelector('[data-record-type-select]');
				if (rtSelect) {
					rtSelect.addEventListener('change', () => {
						currentRecordTypeId = rtSelect.value;
						const recId = canvasState.currentRecordRef && canvasState.currentRecordRef.loadedFromId;
						fetchEditLayout(currentObject, currentRecordTypeId, recId, currentLayoutMode)
							.then((layout) => {
								currentLayout = layout;
								if (layout && layout.picklistValuesRecordTypeId === currentRecordTypeId) {
									applyLayoutPicklistFallback(
										currentFields,
										layout.picklistValues,
										currentRecordTypeId,
									);
								}
							})
							.catch(() => {
								currentLayout = null;
							})
							.then(() =>
								rerenderFormPreservingValues(
									[],
									picklistContextOverrides(currentFields, { restoreLoadedValues: true }),
								),
							);
					});
				}
				const orphanRefresh = modal.querySelector('[data-orphan-refresh]');
				if (orphanRefresh) {
					orphanRefresh.addEventListener('click', async () => {
						orphanRefresh.disabled = true;
						orphanRefresh.textContent = 'Refreshing...';
						try {
							const refreshedDescribe = await ensureDescribe(currentObject, { force: true });
							currentFields = refreshedDescribe.fields || [];
							currentRecordTypes = refreshedDescribe.recordTypes || [];
							const migrate = window.Orgloom && window.Orgloom.canvasMigrate;
							if (migrate && migrate.recompute) {
								await migrate.recompute();
							}
							rerenderFormPreservingValues();
							if (canvasState.graphView === 'bulk') {
								renderBulkView();
							}
							showBulkToast('Salesforce fields refreshed.');
						} catch (error) {
							orphanRefresh.disabled = false;
							orphanRefresh.textContent = 'Refresh Salesforce fields';
							showBulkToast(
								'Could not refresh Salesforce fields. Check the connection and try again.',
								'error',
							);
						}
					});
				}
				modal.querySelectorAll('[data-orphan-target]').forEach((sel) => {
					sel.addEventListener('change', () => {
						const rec = canvasState.currentRecordRef;
						if (!rec) {
							return;
						}
						const fieldName = sel.getAttribute('data-orphan-target');
						const btn = modal.querySelector('[data-orphan-copy="' + fieldName.replace(/"/g, '') + '"]');
						if (btn) {
							btn.disabled = !sel.value;
						}
					});
				});
				modal.querySelectorAll('[data-orphan-copy]').forEach((btn) => {
					btn.addEventListener('click', () => {
						const rec = canvasState.currentRecordRef;
						if (!rec || !rec.values) {
							return;
						}
						const sourceName = btn.getAttribute('data-orphan-copy');
						const sel = modal.querySelector('[data-orphan-target="' + sourceName.replace(/"/g, '') + '"]');
						const targetName = sel ? sel.value : '';
						if (!targetName) {
							return;
						}
						const rawSourceVal = rec.values[sourceName];
						const sourceVal =
							rawSourceVal && typeof rawSourceVal === 'object'
								? formatCarryoverValue(rawSourceVal)
								: rawSourceVal;
						rec.values[targetName] = sourceVal;
						delete rec.values[sourceName];
						rerenderFormPreservingValues();
						if (canvasState.graphView === 'bulk') {
							renderBulkView();
						}
					});
				});
				modal.querySelectorAll('[data-orphan-drop]').forEach((btn) => {
					btn.addEventListener('click', () => {
						const rec = canvasState.currentRecordRef;
						if (!rec || !rec.values) {
							return;
						}
						const sourceName = btn.getAttribute('data-orphan-drop');
						delete rec.values[sourceName];
						rerenderFormPreservingValues();
						if (canvasState.graphView === 'bulk') {
							renderBulkView();
						}
					});
				});

				function _afterMigrateRemap() {
					const _m = window.Orgloom && window.Orgloom.canvasMigrate;
					if (_m && _m.recompute) {
						_m.recompute();
					}
					rerenderFormPreservingValues();
					if (canvasState.graphView === 'bulk') {
						renderBulkView();
					}
				}
				modal.querySelectorAll('[data-migrate-rt-select]').forEach((sel) => {
					sel.addEventListener('change', () => {
						const rec = canvasState.currentRecordRef;
						if (!rec) {
							return;
						}
						const v = sel.value;
						if (v === '__clear__') {
							rec._migrateClearRecordType = true;
							delete rec._migrateRecordTypeId;
						} else if (v) {
							rec._migrateRecordTypeId = v;
							delete rec._migrateClearRecordType;
						} else {
							delete rec._migrateRecordTypeId;
							delete rec._migrateClearRecordType;
						}
						_afterMigrateRemap();
					});
				});
				modal.querySelectorAll('[data-migrate-pl-field]').forEach((sel) => {
					sel.addEventListener('change', () => {
						const rec = canvasState.currentRecordRef;
						if (!rec) {
							return;
						}
						const field = sel.getAttribute('data-migrate-pl-field');
						const source = sel.getAttribute('data-migrate-pl-source');
						const v = sel.value;
						rec._migratePicklistRemap = rec._migratePicklistRemap || {};
						rec._migratePicklistRemap[field] = rec._migratePicklistRemap[field] || {};
						if (v === '__keep__') {
							delete rec._migratePicklistRemap[field][source];
						} else {
							rec._migratePicklistRemap[field][source] = v;
						}
						_afterMigrateRemap();
					});
				});
			}

			function markEditorFieldTouched(target) {
				const field = target && target.closest ? target.closest('.field[data-field]') : null;
				if (field && field.dataset.readonly !== 'true' && field.dataset.field) {
					editorTouchedFields.add(field.dataset.field);
				}
			}

			function encryptedFieldNameForControl(target) {
				const field = target && target.closest ? target.closest('.field[data-type="encryptedstring"]') : null;
				return field && field.dataset ? field.dataset.field : null;
			}

			function captureEncryptedFormValue(target) {
				if (getCanvasShareRole()) {
					return false;
				}
				const fieldName = encryptedFieldNameForControl(target);
				if (!fieldName) {
					return false;
				}
				const field = target.closest('.field');
				const input = field.querySelector('[data-encrypted-proposal]');
				const selectedAction = field.querySelector('[data-encrypted-action]:checked');
				const action = selectedAction ? selectedAction.value : 'unchanged';
				const record = canvasState.currentRecordRef;
				const hadIntent = !!(record && encryptedFields.intentNames(record, canvasState).includes(fieldName));
				if (input && target.matches('[data-encrypted-proposal]')) {
					currentEncryptedDraftValues.set(fieldName, input.value);
				}
				const replacement = input ? input.value : currentEncryptedDraftValues.get(fieldName) || '';
				if (action === 'unchanged') {
					currentEncryptedFormValues.delete(fieldName);
					if (hadIntent) {
						currentEncryptedDismissedFields.add(fieldName);
					} else {
						currentEncryptedDismissedFields.delete(fieldName);
					}
				} else if (action === 'clear') {
					currentEncryptedDismissedFields.delete(fieldName);
					currentEncryptedFormValues.set(fieldName, null);
				} else {
					currentEncryptedDismissedFields.delete(fieldName);
					currentEncryptedFormValues.set(fieldName, replacement ? replacement : undefined);
				}
				const replacementRow = field.querySelector('[data-encrypted-replacement-row]');
				const clearWarning = field.querySelector('[data-encrypted-clear-warning]');
				if (replacementRow) {
					replacementRow.hidden = action !== 'replace';
				}
				if (input) {
					input.disabled = action !== 'replace';
				}
				if (clearWarning) {
					clearWarning.hidden = action !== 'clear';
				}
				const decision = field.querySelector('[data-encrypted-decision]');
				if (decision) {
					const replacementReady = action === 'replace' && !!replacement;
					decision.textContent =
						action === 'clear'
							? ''
							: action === 'replace'
								? replacementReady
									? 'Ready for upload in this tab. If you reopen the canvas, you’ll need to enter it again. This value is not saved during a canvas save.'
									: 'Enter a replacement value before uploading.'
								: 'Salesforce will keep its current value.';
					decision.classList.toggle('is-ready', replacementReady);
					decision.classList.remove('is-clear');
					decision.classList.toggle('is-needed', action === 'replace' && !replacementReady);
				}
				if (action !== 'unchanged') {
					editorTouchedFields.add(fieldName);
				} else {
					editorTouchedFields.delete(fieldName);
				}
				return true;
			}

			function updateDateTimeValidity(target) {
				const field = target && target.closest ? target.closest('.field[data-type="datetime"]') : null;
				if (!field || !target || typeof target.setCustomValidity !== 'function') {
					return;
				}
				const value = String(target.value || '');
				target.setCustomValidity(
					value && !dateTimeFromInput(value) ? 'Enter a time that exists in your Salesforce time zone.' : '',
				);
			}

			function updateGeolocationValidity(target) {
				const field = target && target.closest ? target.closest('.field[data-coordinate-kind]') : null;
				if (!field || !target || typeof target.setCustomValidity !== 'function') {
					return;
				}
				const badInput = !!(target.validity && target.validity.badInput);
				target.setCustomValidity(
					geolocationValidationMessage(field.dataset.coordinateKind, target.value, badInput),
				);
			}

			function normalizeGeolocationControl(target) {
				const field = target && target.closest ? target.closest('.field[data-coordinate-kind]') : null;
				if (!field || !target) {
					return;
				}
				const scale = Number(field.dataset.coordinateScale);
				const normalized = truncateDecimalScale(target.value, scale);
				if (normalized !== target.value) {
					target.value = normalized;
				}
				updateGeolocationValidity(target);
			}

			function picklistContextOverrides(fields, options) {
				const formValues = collectFormValues();
				const overrides = {};
				const restoreLoadedValues = !!(options && options.restoreLoadedValues);
				(fields || []).forEach((field) => {
					if (!field || !isPicklistLikeField(field)) {
						return;
					}
					const currentValue = Object.prototype.hasOwnProperty.call(formValues, field.name)
						? formValues[field.name]
						: currentValueForField(field.name);
					const controllerValue = field.controllerName
						? Object.prototype.hasOwnProperty.call(formValues, field.controllerName)
							? formValues[field.controllerName]
							: currentValueForField(field.controllerName)
						: null;
					const selection = picklistSelectionForContext(
						field,
						currentRecordTypeId,
						controllerValue,
						currentValue,
						recordTypeMetadataAvailable(currentRecordTypeId),
					);
					if (!selection.known) {
						return;
					}
					const currentComparable = currentValue == null || currentValue === '' ? null : String(currentValue);
					let nextValue = selection.value;
					if (restoreLoadedValues && currentComparable !== null && nextValue == null) {
						const loaded = loadedSalesforceValueForField(field.name);
						if (loaded.known) {
							nextValue = loaded.value;
						}
					}
					const nextComparable = nextValue == null || nextValue === '' ? null : String(nextValue);
					if (currentComparable !== nextComparable) {
						overrides[field.name] = nextValue;
						editorTouchedFields.add(field.name);
					}
				});
				return overrides;
			}

			function wireLiveValidation() {
				const form = modal.querySelector('[data-editor-element="insert-form"]');
				if (!form) {
					return;
				}
				wireNumericInputSteppers(form);
				form.addEventListener('pointerover', (e) => {
					const trigger = e.target.closest && e.target.closest('[data-encrypted-tooltip-trigger]');
					if (trigger && !trigger.contains(e.relatedTarget)) {
						openEncryptedTooltip(trigger);
					}
				});
				form.addEventListener('pointerout', (e) => {
					const trigger = e.target.closest && e.target.closest('[data-encrypted-tooltip-trigger]');
					if (trigger && !trigger.contains(e.relatedTarget)) {
						scheduleEncryptedTooltipHide();
					}
				});
				form.addEventListener('click', async (e) => {
					const loadEncryptedButton = e.target.closest && e.target.closest('[data-encrypted-load-current]');
					if (loadEncryptedButton) {
						const record = canvasState.currentRecordRef;
						const fieldName = loadEncryptedButton.dataset.encryptedLoadCurrent;
						const encryptedField = currentFields.find(
							(field) =>
								field &&
								field.name === fieldName &&
								String(field.type || '').toLowerCase() === 'encryptedstring',
						);
						if (!record || !record.loadedFromId || !encryptedField) {
							return;
						}
						loadEncryptedButton.disabled = true;
						loadEncryptedButton.textContent = 'Loadingâ€¦';
						try {
							const response = await csrfFetch(
								'/api/objects/' +
									encodeURIComponent(record.objectName) +
									'/records/' +
									encodeURIComponent(record.loadedFromId),
								{ credentials: 'same-origin' },
							);
							if (!response.ok) {
								const body = await response.json().catch(() => ({}));
								throw new Error(body.message || body.error || 'Could not load this Salesforce value.');
							}
							const salesforceRecord = await response.json();
							if (canvasState.currentRecordRef !== record || modal.classList.contains('hidden')) {
								return;
							}
							if (!Object.prototype.hasOwnProperty.call(salesforceRecord, fieldName)) {
								throw new Error('Salesforce did not return this field for your user.');
							}
							record.loadedValues = Object.assign({}, record.loadedValues || {}, {
								[fieldName]: salesforceRecord[fieldName],
							});
							record.values = Object.assign({}, record.values || {}, {
								[fieldName]: salesforceRecord[fieldName],
							});
							rerenderFormPreservingValues();
							showModalToast('Loaded from Salesforce for this tab only.', 'info');
						} catch (error) {
							loadEncryptedButton.disabled = false;
							loadEncryptedButton.textContent = 'Load from Salesforce';
							showModalToast(error.message || 'Could not load this Salesforce value.', 'error');
						}
						return;
					}
					const actionToggle = e.target.closest && e.target.closest('[data-encrypted-action-toggle]');
					if (actionToggle) {
						closeEncryptedTooltip();
						const panelId = actionToggle.getAttribute('aria-controls');
						const panel = panelId ? document.getElementById(panelId) : null;
						if (panel) {
							const expanded = actionToggle.getAttribute('aria-expanded') === 'true';
							actionToggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
							panel.hidden = expanded;
						}
						return;
					}
					const tooltipTrigger = e.target.closest && e.target.closest('[data-encrypted-tooltip-trigger]');
					if (tooltipTrigger) {
						openEncryptedTooltip(tooltipTrigger);
						return;
					}
					closeEncryptedTooltip();
					const dismissButton = e.target.closest && e.target.closest('[data-encrypted-dismiss]');
					if (dismissButton) {
						const record = canvasState.currentRecordRef;
						const fieldName = dismissButton.dataset.encryptedDismiss;
						encryptedFields.dismissIntent(record, fieldName);
						currentEncryptedFormValues.delete(fieldName);
						editorTouchedFields.delete(fieldName);
						rerenderFormPreservingValues();
						showModalToast('This encrypted field will be left unchanged.', 'info');
						return;
					}
					const takeoverButton = e.target.closest && e.target.closest('[data-field-takeover]');
					if (!takeoverButton) {
						return;
					}
					if (takeoverButton.dataset.fieldTakeoverAllowed !== 'true') {
						return;
					}
					const record = canvasState.currentRecordRef;
					const fieldName = takeoverButton.dataset.fieldTakeover;
					const lock = record && fieldName ? fieldLockFor(record, fieldName) : null;
					if (!record || !fieldName || !lock || lock.owned) {
						return;
					}
					const editorName = lock.displayName || 'Another user';
					const confirmed = await showConfirmDialog({
						title: 'Take over this field?',
						message:
							editorName +
							(lock.active
								? ' is editing this field now. '
								: ' has this field reserved while editing the record. ') +
							'Taking over unlocks it for you and prevents their unsaved value from being accepted.',
						confirmLabel: 'Take over',
						cancelLabel: 'Keep waiting',
						danger: false,
					});
					if (!confirmed) {
						return;
					}
					const result = await acquireFieldLock(record, fieldName, { takeover: true }).catch(() => null);
					if (!result || !result.ok) {
						showBulkToast(
							(result && result.message) || 'This field could not be taken over. Reload and try again.',
							'error',
						);
						return;
					}
					rerenderFormPreservingValues();
					window.requestAnimationFrame(() => {
						const field = modal.querySelector('.field[data-field="' + CSS.escape(fieldName) + '"]');
						const control = _guidedFieldControl(field);
						if (control) {
							control.focus({ preventScroll: true });
						}
					});
				});
				form.addEventListener('input', (e) => {
					if (!captureEncryptedFormValue(e.target)) {
						markEditorFieldTouched(e.target);
					}
					updateDateTimeValidity(e.target);
					updateGeolocationValidity(e.target);
					const div = e.target.closest && e.target.closest('.field[data-type="reference"]');
					if (div) {
						div.classList.remove('field-invalid-ref');
					}
					const guidedField = e.target.closest && e.target.closest('.field[data-field]');
					if (guidedField) {
						_updateGuidedFieldCompletion(guidedField);
					}
					refreshEditorValidation();
				});
				form.addEventListener('focusin', (e) => {
					const tooltipTrigger = e.target.closest && e.target.closest('[data-encrypted-tooltip-trigger]');
					if (tooltipTrigger) {
						openEncryptedTooltip(tooltipTrigger);
						return;
					}
					closeEncryptedTooltip();
					const field = e.target.closest && e.target.closest('.field[data-field]');
					const record = canvasState.currentRecordRef;
					if (!field || !record || field.dataset.readonly === 'true') {
						return;
					}
					if (field.dataset.type === 'encryptedstring') {
						return;
					}
					const fieldName = field.dataset.field;
					acquireFieldLock(record, fieldName)
						.then((result) => {
							if (result && result.ok) {
								const activeField =
									document.activeElement &&
									document.activeElement.closest &&
									document.activeElement.closest('.field[data-field]');
								if (activeField !== field) {
									if (!_fieldHasUnsavedChange(fieldName)) {
										releaseFieldLock(record, fieldName);
									}
									return;
								}
								const focus = _presenceFocusForRecord(record);
								if (focus) {
									focus.fieldName = fieldName;
									pushPresenceFocus(focus);
								}
								return;
							}
							rerenderFormPreservingValues();
							showBulkToast((result && result.message) || 'Another user is editing this field.', 'info');
						})
						.catch(() => {});
				});
				form.addEventListener('change', (e) => {
					normalizeGeolocationControl(e.target);
					if (!captureEncryptedFormValue(e.target)) {
						markEditorFieldTouched(e.target);
					}
					const guidedField = e.target.closest && e.target.closest('.field[data-field]');
					const guidedComplete = guidedField && _updateGuidedFieldCompletion(guidedField);
					if (guidedComplete) {
						_scheduleGuidedAdvance(guidedField.dataset.field, e.target, true);
					}
					refreshEditorValidation();
					if (e.target.tagName !== 'SELECT') {
						return;
					}
					const fieldDiv = e.target.closest('.field');
					const changedName = fieldDiv && fieldDiv.dataset.field;
					if (changedName === 'RecordTypeId' || !fieldControlsDependentPicklist(currentFields, changedName)) {
						return;
					}
					const dependentFields = currentFields.filter((field) => field.controllerName === changedName);
					rerenderFormPreservingValues([], picklistContextOverrides(dependentFields));
				});
				form.addEventListener('focusout', (e) => {
					normalizeGeolocationControl(e.target);
					const blurredField = e.target.closest && e.target.closest('.field[data-field]');
					const blurredFieldName = blurredField && blurredField.dataset.field;
					const blurredRecord = canvasState.currentRecordRef;
					setTimeout(() => {
						if (modal.classList.contains('hidden') || !canvasState.currentRecordRef) {
							return;
						}
						const activeField =
							document.activeElement &&
							document.activeElement.closest &&
							document.activeElement.closest('.field[data-field]');
						if (
							blurredRecord &&
							blurredFieldName &&
							activeField !== blurredField &&
							!_fieldHasUnsavedChange(blurredFieldName)
						) {
							releaseFieldLock(blurredRecord, blurredFieldName);
						}
						if (activeField && form.contains(activeField)) {
							return;
						}
						const focus = _presenceFocusForRecord(canvasState.currentRecordRef);
						if (focus) {
							pushPresenceFocus(focus);
						}
					}, 0);
				});
				refreshEditorValidation();
			}

			function rerenderFormPreservingValues(discardFields, overrideValues) {
				const discarded = new Set(Array.isArray(discardFields) ? discardFields : []);
				const activeControl =
					document.activeElement && modal.contains(document.activeElement) ? document.activeElement : null;
				const activeField =
					activeControl && activeControl.closest ? activeControl.closest('.field[data-field]') : null;
				const activeFieldName = activeField ? activeField.dataset.field : null;
				const activeControlId = activeControl && activeControl.id ? activeControl.id : null;
				const selection =
					activeControl &&
					typeof activeControl.selectionStart === 'number' &&
					typeof activeControl.selectionEnd === 'number'
						? {
								start: activeControl.selectionStart,
								end: activeControl.selectionEnd,
								direction: activeControl.selectionDirection,
							}
						: null;
				const recValues = (canvasState.currentRecordRef && canvasState.currentRecordRef.values) || {};
				const localValues = collectFormValues();
				for (const fieldName of discarded) {
					delete localValues[fieldName];
				}
				currentFormValues = Object.assign({}, recValues, localValues, overrideValues || {});
				renderForm();
				wireLiveValidation();
				populateForm(currentFormValues);
				refreshEditorValidation();
				if (!activeFieldName || discarded.has(activeFieldName)) {
					return;
				}
				const escapedFieldName = CSS.escape(activeFieldName);
				const nextField = modal.querySelector('.field[data-field="' + escapedFieldName + '"]');
				const nextControl =
					(activeControlId && modal.querySelector('#' + CSS.escape(activeControlId))) ||
					(nextField && nextField.querySelector('input, textarea, select, button'));
				if (!nextControl || nextControl.disabled) {
					return;
				}
				nextControl.focus({ preventScroll: true });
				if (selection && typeof nextControl.setSelectionRange === 'function') {
					try {
						nextControl.setSelectionRange(selection.start, selection.end, selection.direction);
					} catch (_) {}
				}
			}

			function refreshCurrentRecordAccess(record) {
				if (
					!record ||
					canvasState.currentRecordRef !== record ||
					modal.classList.contains('hidden') ||
					currentFields.length === 0
				) {
					return;
				}
				const nextLayoutMode = sharedDraftLayoutMode(
					getCanvasShareRole(),
					record,
					_slotAssignmentState(record),
				);
				const layoutModeChanged = nextLayoutMode !== currentLayoutMode;
				const layoutNeedsRefresh = layoutModeChanged || !currentLayout || !currentLayout.available;
				currentLayoutMode = nextLayoutMode;
				rerenderFormPreservingValues();
				_syncSubmitButtonAccess();
				if (!layoutNeedsRefresh) {
					return;
				}
				const recId = record.loadedFromId || null;
				fetchEditLayout(currentObject, currentRecordTypeId, recId, currentLayoutMode)
					.then((layout) => {
						if (
							canvasState.currentRecordRef !== record ||
							modal.classList.contains('hidden') ||
							currentLayoutMode !== nextLayoutMode
						) {
							return;
						}
						currentLayout = layout;
						rerenderFormPreservingValues();
						_syncSubmitButtonAccess();
					})
					.catch(() => {});
			}

			function refreshCurrentFieldLocks(_reference, fieldName) {
				if (modal.classList.contains('hidden') || !canvasState.currentRecordRef) {
					return;
				}
				const currentLock = fieldName ? fieldLockFor(canvasState.currentRecordRef, fieldName) : null;
				if (currentLock && currentLock.owned) {
					return;
				}
				const displacedFields = currentLock && !currentLock.owned ? [fieldName] : [];
				rerenderFormPreservingValues(displacedFields);
			}

			function refreshCurrentRecordValues(record, fields) {
				if (
					!record ||
					canvasState.currentRecordRef !== record ||
					modal.classList.contains('hidden') ||
					!fields ||
					typeof fields !== 'object'
				) {
					return;
				}
				currentFormValues = Object.assign({}, collectFormValues(), fields);
				renderForm();
				wireLiveValidation();
				populateForm(currentFormValues);
				refreshEditorValidation();
			}

			function updateRequiredFieldStyles() {
				const form = modal.querySelector('[data-editor-element="insert-form"]');
				if (!form) {
					return;
				}
				form.querySelectorAll('.field.required').forEach((div) => {
					const type = div.dataset.type;
					let empty = false;
					if (type === 'boolean') {
						empty = false;
					} else if (type === 'multipicklist') {
						const sel = div.querySelector('select');
						empty = !sel || !Array.from(sel.selectedOptions).some((o) => o.value);
					} else {
						const el = div.querySelector('input, textarea, select');
						empty = !el || el.value == null || String(el.value).trim() === '';
					}
					div.classList.toggle('is-empty', empty);
				});
			}

			function refreshEditorValidation() {
				updateRequiredFieldStyles();
			}

			function renderFieldCollection(fields, optionsForField) {
				return groupGeolocationFields(fields, currentFields)
					.map((entry) => {
						if (entry.kind === 'field') {
							return renderFieldHtml(entry.field, optionsForField(entry.field));
						}
						const components = entry.fields
							.slice()
							.sort((a, b) => {
								const rank = (field) =>
									geolocationCoordinateKind(field, currentFields) === 'latitude' ? 0 : 1;
								return rank(a) - rank(b);
							})
							.map((field) => renderFieldHtml(field, optionsForField(field)))
							.join('');
						return (
							'<fieldset class="geolocation-field-group" data-geolocation-field="' +
							escapeHtml(entry.name) +
							'"><legend>' +
							escapeHtml(entry.label) +
							' <span class="meta">geolocation</span></legend>' +
							'<div class="geolocation-field-components">' +
							components +
							'</div></fieldset>'
						);
					})
					.join('');
			}

			function renderFieldHtml(f, opts) {
				const fieldLock = fieldLockFor(canvasState.currentRecordRef, f.name);
				const peerLock = fieldLock && !fieldLock.owned ? fieldLock : null;
				const externalKeyReference = isExternalKeyReferenceField(f);
				const configuredReadOnly = !!(opts && opts.readOnly);
				const takeoverAllowed = canTakeOverField(peerLock, configuredReadOnly);
				const readOnly = configuredReadOnly || !!peerLock;
				const isSlotField = !!(opts && opts.isSlotField);
				const req = f.required ? '<span class="req" title="Required">*</span>' : '';
				const slotBadge = isSlotField
					? ' <span class="meta meta-slot" title="The author requested that a contributor complete this field.">requested</span>'
					: '';
				const roBadge = configuredReadOnly
					? ' <span class="meta meta-readonly" title="Read-only in Salesforce for your profile or because the field is system-managed">read-only</span>'
					: '';
				const editableAssociation =
					!readOnly && f.type === 'reference' && !externalKeyReference
						? editableContributorAssociation(f.name)
						: null;
				const lock =
					!readOnly && f.type === 'reference' && !externalKeyReference && !editableAssociation
						? associationLockForField(f.name)
						: null;
				const linked = !!(lock && lock.target);
				const meta =
					'<span class="meta">' +
					(externalKeyReference
						? 'external lookup'
						: escapeHtml(f.type) +
							(f.referenceTo && f.referenceTo.length
								? ' &rarr; ' + escapeHtml(f.referenceTo.join(', '))
								: '')) +
					'</span>';
				const labelInner =
					escapeHtml(linked ? f.label.replace(/\s+ID$/i, '') : f.label) +
					req +
					(linked ? '' : ' ' + meta) +
					slotBadge +
					roBadge;
				const labelBlock =
					'<div class="field-head">' +
					'<label for="f_' +
					escapeHtml(f.name) +
					'" title="' +
					escapeHtml(f.name) +
					'">' +
					labelInner +
					'</label>' +
					'</div>';
				const help =
					(externalKeyReference
						? '<div class="help">Enter the external record’s External ID. Org Loom cannot verify that the external record exists.</div>'
						: '') + (f.helpText ? '<div class="help">' + escapeHtml(f.helpText) + '</div>' : '');
				const encrypted = String(f.type || '').toLowerCase() === 'encryptedstring';
				const input = encrypted
					? encryptedInputForField(f, readOnly)
					: readOnly
						? readOnlyInputForField(f)
						: inputForField(f, { editableAssociation: editableAssociation });
				const takeoverAction = takeoverAllowed
					? ' <button type="button" class="link-button" data-field-takeover="' +
						escapeHtml(f.name) +
						'" data-field-takeover-allowed="true">Take over</button>'
					: '';
				const lockHelp = peerLock
					? '<div class="field-lock-help">' +
						escapeHtml(
							peerLock.active
								? (peerLock.displayName || 'Another user') + ' is editing this field now.'
								: 'Reserved by ' +
										(peerLock.displayName || 'another user') +
										' because they have unsaved changes.',
						) +
						takeoverAction +
						'</div>'
					: '';
				const coordinateKind = geolocationCoordinateKind(f, currentFields);
				const fullWidth = f.type === 'textarea' || f.type === 'multipicklist';
				const classes =
					'field' +
					(f.required ? ' required' : '') +
					(fullWidth ? ' full-width' : '') +
					(readOnly ? ' is-readonly' : '') +
					(peerLock ? ' is-peer-locked' : '') +
					(peerLock ? (peerLock.active ? ' is-peer-active' : ' is-peer-reserved') : '') +
					(externalKeyReference ? ' is-external-lookup' : '') +
					(isSlotField ? ' is-slot-field' : '') +
					(coordinateKind ? ' is-geolocation-coordinate' : '');
				const roAttr = readOnly ? ' data-readonly="true"' : '';
				const htmlFormattedAttr = f.htmlFormatted ? ' data-html-formatted="true"' : '';
				const coordinateAttr = coordinateKind
					? ' data-coordinate-kind="' +
						coordinateKind +
						'" data-coordinate-scale="' +
						(typeof f.scale === 'number' && f.scale >= 0 ? f.scale : 6) +
						'"'
					: '';
				return (
					'<div class="' +
					classes +
					'" data-field="' +
					escapeHtml(f.name) +
					'" data-type="' +
					escapeHtml(f.type) +
					'"' +
					htmlFormattedAttr +
					coordinateAttr +
					roAttr +
					'>' +
					labelBlock +
					input +
					help +
					lockHelp +
					'</div>'
				);
			}

			function encryptedInputForField(f, readOnly) {
				const record = canvasState.currentRecordRef;
				const shareRole = getCanvasShareRole();
				const existing = !!(record && record.loadedFromId);
				const locallyTouched = currentEncryptedFormValues.has(f.name);
				const locallyDismissed = currentEncryptedDismissedFields.has(f.name);
				const hasIntent = !!(
					locallyTouched ||
					(record && encryptedFields.intentNames(record, canvasState).includes(f.name))
				);
				const storedHasProposal = !!(record && encryptedFields.hasProposal(record, f.name));
				const storedProposal = storedHasProposal ? encryptedFields.proposal(record, f.name) : undefined;
				const localProposal = locallyTouched ? currentEncryptedFormValues.get(f.name) : undefined;
				const action = encryptedActionForField(
					existing,
					hasIntent,
					storedHasProposal,
					storedProposal,
					locallyTouched,
					localProposal,
					locallyDismissed,
				);
				const retainedDraft = currentEncryptedDraftValues.has(f.name)
					? currentEncryptedDraftValues.get(f.name)
					: null;
				const proposalValue =
					retainedDraft != null
						? String(retainedDraft)
						: storedProposal == null
							? ''
							: String(storedProposal);
				const hasReplacement = action === 'replace' && proposalValue !== '';
				const statusId = 'encrypted_status_' + f.name;
				const tooltipId = 'encrypted_help_' + f.name;
				const actionPanelId = 'encrypted_actions_' + f.name;
				const actionPanelOpen = false;
				const tooltipText =
					'Encrypted values are sensitive, so Org Loom cannot safely treat the current value like a normal editable field. A replacement stays in this browser tab until upload, but it is not included when the canvas is saved or shared.';
				const decisionText =
					action === 'clear'
						? ''
						: action === 'replace'
							? hasReplacement
								? 'Ready for upload in this tab. If you reopen the canvas, you’ll need to enter it again. This value is not saved during a canvas save.'
								: 'Enter a replacement value before uploading.'
							: 'Salesforce will keep its current value.';
				const current = existing ? loadedSalesforceValueForField(f.name) : { known: false, value: null };
				const currentValueHtml = current.known
					? current.value == null || current.value === ''
						? ''
						: '<code>' + escapeHtml(String(current.value)) + '</code>'
					: '<span class="encrypted-field-unavailable">Not loaded in this tab</span>' +
						'<button type="button" class="link-button encrypted-field-load-current" data-encrypted-load-current="' +
						escapeHtml(f.name) +
						'">Load from Salesforce</button>';
				let html = '<div class="encrypted-field-control">';
				if (canChangeEncryptedField(shareRole, readOnly)) {
					html += '<div class="encrypted-field-change">';
					if (existing) {
						html +=
							'<div class="encrypted-field-current" aria-label="Current Salesforce value">' +
							currentValueHtml +
							'<span class="encrypted-field-locked" aria-hidden="true">Read only</span></div>';
					}
					html +=
						'<div class="encrypted-field-action-disclosure"><div class="encrypted-field-action-heading"><button type="button" class="encrypted-field-action-toggle" data-encrypted-action-toggle aria-expanded="' +
						(actionPanelOpen ? 'true' : 'false') +
						'" aria-controls="' +
						escapeHtml(actionPanelId) +
						'"><span>What should happen on the next upload?</span><span class="encrypted-field-action-chevron" aria-hidden="true">&#9662;</span></button><span class="encrypted-field-tooltip"><button type="button" class="encrypted-field-tooltip-trigger" aria-label="Why encrypted fields work differently" aria-describedby="' +
						escapeHtml(tooltipId) +
						'" data-encrypted-tooltip-trigger aria-expanded="false">?</button><span class="encrypted-field-tooltip-content" id="' +
						escapeHtml(tooltipId) +
						'" role="tooltip" popover="manual">' +
						escapeHtml(tooltipText) +
						'</span></span></div><div class="encrypted-field-action-panel" id="' +
						escapeHtml(actionPanelId) +
						'" data-encrypted-action-panel' +
						(actionPanelOpen ? '' : ' hidden') +
						'><fieldset class="encrypted-field-actions" aria-label="Encrypted field upload action">' +
						'<label><input type="radio" name="encrypted_action_' +
						escapeHtml(f.name) +
						'" value="unchanged" data-encrypted-action' +
						(action === 'unchanged' ? ' checked' : '') +
						'> Leave unchanged</label>' +
						'<label><input type="radio" name="encrypted_action_' +
						escapeHtml(f.name) +
						'" value="replace" data-encrypted-action' +
						(action === 'replace' ? ' checked' : '') +
						'> Replace</label>' +
						'<label><input type="radio" name="encrypted_action_' +
						escapeHtml(f.name) +
						'" value="clear" data-encrypted-action' +
						(action === 'clear' ? ' checked' : '') +
						'> Clear from Salesforce</label></fieldset>' +
						'<div class="encrypted-field-replacement" data-encrypted-replacement-row' +
						(action === 'replace' ? '' : ' hidden') +
						'><div class="encrypted-field-input-row"><input type="text" id="f_' +
						escapeHtml(f.name) +
						'" name="' +
						escapeHtml(f.name) +
						'" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Enter replacement value" aria-describedby="' +
						escapeHtml(tooltipId) +
						' ' +
						escapeHtml(statusId) +
						'" data-encrypted-proposal="true" value="' +
						escapeHtml(proposalValue) +
						'"' +
						(action === 'replace' ? '' : ' disabled') +
						(f.length ? ' maxlength="' + Number(f.length) + '"' : '') +
						'></div></div>' +
						'<div class="encrypted-field-clear-warning" data-encrypted-clear-warning' +
						(action === 'clear' ? '' : ' hidden') +
						'><strong>Will be cleared from Salesforce on the next upload.</strong> This cannot be undone by Org Loom.</div>' +
						'<div id="' +
						escapeHtml(statusId) +
						'" class="encrypted-field-decision' +
						(hasReplacement ? ' is-ready' : action === 'replace' ? ' is-needed' : '') +
						'" data-encrypted-decision role="status">' +
						escapeHtml(decisionText) +
						'</div></div></div>';
					html += '</div>';
				} else {
					if (existing) {
						html +=
							'<div class="encrypted-field-current" aria-label="Current Salesforce value">' +
							currentValueHtml +
							'<span class="encrypted-field-locked">Canvas owner managed</span></div>';
					}
					if (hasIntent && !storedHasProposal && !shareRole) {
						html +=
							'<div class="encrypted-field-decision is-needed"><strong>Replacement needed to change this field.</strong> The canvas records an intent to change it, but Org Loom does not save or share encrypted values. If you upload without entering a replacement, this Salesforce field will be left unchanged.</div>';
					}
				}
				return html + '</div>';
			}

			function readOnlyInputForField(f) {
				const id = 'f_' + escapeHtml(f.name);
				const name = escapeHtml(f.name);
				if (f.type === 'boolean') {
					return (
						'<input type="checkbox" class="readonly-checkbox" id="' +
						id +
						'" name="' +
						name +
						'" disabled aria-readonly="true" tabindex="-1">'
					);
				}
				let targetAttr = '';
				if (f.type === 'reference' && !isExternalKeyReferenceField(f)) {
					const targetObject = inferReferenceTarget(
						f.referenceTo,
						currentValueForField(f.name),
						canvasState.allObjects,
					);
					if (targetObject) {
						targetAttr = ' data-target-object="' + escapeHtml(targetObject) + '"';
					}
				}
				return (
					'<input type="text" id="' +
					id +
					'" name="' +
					name +
					'" disabled aria-readonly="true" tabindex="-1" value=""' +
					targetAttr +
					'>'
				);
			}

			function picklistValuesForField(f, ctxValues, rtIdOverride) {
				const rtId = rtIdOverride || currentRecordTypeId;
				let values = recordTypePicklistValues(f, rtId);
				let state =
					recordTypePicklistAvailable(f, rtId) && recordTypeMetadataAvailable(rtId)
						? 'ok'
						: 'record-type-unavailable';
				if (state === 'record-type-unavailable') {
					return { values: [], state };
				}
				if (f.controllerName) {
					const controllerVal =
						ctxValues && Object.prototype.hasOwnProperty.call(ctxValues, f.controllerName)
							? ctxValues[f.controllerName]
							: currentFormValues &&
								  Object.prototype.hasOwnProperty.call(currentFormValues, f.controllerName)
								? currentFormValues[f.controllerName]
								: getControllerFieldValue(f.controllerName);
					const mapsByRecordType = f.controllerValuesByRecordType;
					const ctrlMap =
						mapsByRecordType && rtId && Object.prototype.hasOwnProperty.call(mapsByRecordType, rtId)
							? mapsByRecordType[rtId]
							: f.controllerValues || null;
					const controllerKey = controllerVal == null ? '' : String(controllerVal);
					if (ctrlMap && controllerKey && Object.prototype.hasOwnProperty.call(ctrlMap, controllerKey)) {
						const idx = ctrlMap[controllerKey];
						const hasValidFor = values.some((v) => Array.isArray(v.validFor) && v.validFor.length > 0);
						if (hasValidFor) {
							values = values.filter((v) => Array.isArray(v.validFor) && v.validFor.includes(idx));
						}
						if (values.length === 0) {
							state = 'not-applicable';
						}
					} else if (ctrlMap) {
						values = [];
						state = controllerKey ? 'not-applicable' : 'controller-missing';
					}
				}
				return { values, state };
			}

			function recordTypeMetadataAvailable(recordTypeId) {
				const record = canvasState.currentRecordRef;
				if (!recordTypeId || !record || !record.loadedFromId) {
					return true;
				}
				return currentRecordTypes.some((recordType) => recordType && recordType.id === recordTypeId);
			}

			function loadedSalesforceValueForField(fieldName) {
				const record = canvasState.currentRecordRef;
				const loadedValues = record && record.loadedFromId && record.loadedValues;
				if (!loadedValues || !Object.prototype.hasOwnProperty.call(loadedValues, fieldName)) {
					return { known: false, value: null };
				}
				return { known: true, value: loadedValues[fieldName] };
			}

			function currentValueForField(fieldName) {
				if (Object.prototype.hasOwnProperty.call(currentFormValues || {}, fieldName)) {
					return currentFormValues[fieldName];
				}
				const recordValues =
					canvasState.currentRecordRef && canvasState.currentRecordRef.values
						? canvasState.currentRecordRef.values
						: null;
				if (recordValues && Object.prototype.hasOwnProperty.call(recordValues, fieldName)) {
					return recordValues[fieldName];
				}
				const savedValues = canvasState.savedRecords && canvasState.savedRecords[currentObject];
				return savedValues && Object.prototype.hasOwnProperty.call(savedValues, fieldName)
					? savedValues[fieldName]
					: null;
			}

			function getControllerFieldValue(fieldName) {
				const div = modal.querySelector('.field[data-field="' + CSS.escape(fieldName) + '"]');
				if (!div) {
					return null;
				}
				const el = div.querySelector('select, input, textarea');
				if (!el) {
					return null;
				}
				return el.value || null;
			}

			function associationLockForField(fieldName) {
				if (!canvasState.currentRecordRef) {
					return null;
				}
				const assoc = canvasState.bulkAssociations.find(
					(a) => a.fromId === canvasState.currentRecordRef.id && a.fieldName === fieldName,
				);
				if (!assoc) {
					return null;
				}
				const target = canvasState.bulkRecords.find((r) => r.id === assoc.toId);
				return { association: assoc, target };
			}

			function editableContributorAssociation(fieldName) {
				const record = canvasState.currentRecordRef;
				if (
					getCanvasShareRole() !== 'contributor' ||
					!record ||
					!record._recipientSlot ||
					!record.slot ||
					(record.slot.kind || 'whole-record') !== 'fields' ||
					!Array.isArray(record.slot.fields) ||
					!record.slot.fields.includes(fieldName)
				) {
					return null;
				}
				const lock = associationLockForField(fieldName);
				return lock && lock.target && lock.target.loadedFromId ? lock : null;
			}

			function reconcileContributorRelationships(payload) {
				const changed = new Set();
				const record = canvasState.currentRecordRef;
				if (getCanvasShareRole() !== 'contributor' || !record || !record._recipientSlot || !record.slot) {
					return changed;
				}
				const requested = new Set(Array.isArray(record.slot.fields) ? record.slot.fields : []);
				currentFields
					.filter(
						(field) =>
							field &&
							field.type === 'reference' &&
							!isExternalKeyReferenceField(field) &&
							requested.has(field.name),
					)
					.forEach((field) => {
						const lock = editableContributorAssociation(field.name);
						if (!lock) {
							return;
						}
						const picker = modal.querySelector(
							'.field[data-field="' + CSS.escape(field.name) + '"] .lookup-picker',
						);
						const control = picker && picker.querySelector('input[type="hidden"]');
						if (!control) {
							return;
						}
						const currentId = String(lock.target.loadedFromId || '');
						const nextId = String(control.value || '');
						if (currentId.slice(0, 15) === nextId.slice(0, 15)) {
							if (Object.prototype.hasOwnProperty.call(record.values || {}, field.name)) {
								payload[field.name] = record.values[field.name];
							} else {
								delete payload[field.name];
							}
							return;
						}
						canvasState.bulkAssociations = (canvasState.bulkAssociations || []).filter(
							(association) =>
								association &&
								association !== lock.association &&
								!(
									association.id != null &&
									lock.association.id != null &&
									String(association.id) === String(lock.association.id)
								),
						);
						payload[field.name] = nextId || null;
						if (!(record._slotChangedRelationshipFields instanceof Set)) {
							record._slotChangedRelationshipFields = new Set();
						}
						record._slotChangedRelationshipFields.add(field.name);
						changed.add(field.name);
					});
				return changed;
			}

			function describeLinkedTarget(target) {
				if (!target) {
					return '';
				}
				const nameVal = target.values && (target.values.Name || target.values.Subject || target.values.Title);
				return nameVal
					? String(nameVal) + ' \u00b7 ' + target.label + ' #' + recordOrdinal(target)
					: target.label + ' #' + recordOrdinal(target);
			}

			const _lookupSearchCache = new Map(); // 'src|field|q' -> records
			function _wireLookupPicker(picker) {
				if (!picker || picker.dataset._wired === '1') {
					return;
				}
				picker.dataset._wired = '1';
				const sourceObject = picker.dataset.sourceObject;
				const fieldName = picker.dataset.fieldName;
				let targetObject = picker.dataset.targetObject;
				const targetSelect = picker.querySelector('.lookup-target');
				const hidden = picker.querySelector('input[type="hidden"]');
				const searchInput = picker.querySelector('.lookup-search');
				const resultsBox = picker.querySelector('.lookup-results');
				const selectedBox = picker.querySelector('.lookup-selected');
				const selectedLabel = picker.querySelector('.lookup-selected-label');
				const clearBtn = picker.querySelector('.lookup-clear');
				if (!hidden || !searchInput || !resultsBox || !selectedBox) {
					return;
				}

				function _showSearchMode() {
					selectedBox.hidden = true;
					searchInput.hidden = false;
					searchInput.disabled = !targetObject;
					searchInput.placeholder = targetObject ? 'Search ' + targetObject + '…' : 'Choose a type first';
					resultsBox.hidden = true;
					resultsBox.innerHTML = '';
				}
				function _showSelectedMode(displayText, apiName) {
					const selectedType = apiName || targetObject;
					selectedLabel.textContent =
						(selectedType ? selectedType + ' · ' : '') + (displayText || hidden.value || '(linked)');
					selectedBox.hidden = false;
					searchInput.hidden = true;
					resultsBox.hidden = true;
					resultsBox.innerHTML = '';
				}
				if (hidden.value) {
					_showSelectedMode(hidden.value);
					_resolveLookupDisplay(targetObject, hidden.value)
						.then((name) => {
							if (hidden.value && selectedBox && !selectedBox.hidden) {
								_showSelectedMode(name || hidden.value);
							}
						})
						.catch(() => {});
				}
				if (targetSelect) {
					targetSelect.addEventListener('change', () => {
						targetObject = targetSelect.value || '';
						picker.dataset.targetObject = targetObject;
						searchInput.value = '';
						if (hidden.value) {
							hidden.value = '';
							hidden.dispatchEvent(new Event('change', { bubbles: true }));
						}
						_showSearchMode();
						if (targetObject) {
							searchInput.focus();
						}
					});
				}

				clearBtn.addEventListener('click', () => {
					hidden.value = '';
					hidden.dispatchEvent(new Event('change', { bubbles: true }));
					_showSearchMode();
					setTimeout(() => searchInput.focus(), 0);
				});

				const MIN_QUERY_LEN = 2;
				let _searchTimer = null;
				searchInput.addEventListener('input', () => {
					const q = searchInput.value.trim();
					if (_searchTimer) {
						clearTimeout(_searchTimer);
					}
					if (q.length === 0) {
						resultsBox.hidden = true;
						resultsBox.innerHTML = '';
						return;
					}
					if (q.length < MIN_QUERY_LEN) {
						resultsBox.innerHTML =
							'<div class="lookup-result lookup-result--empty">Type at least ' +
							MIN_QUERY_LEN +
							' characters to search</div>';
						resultsBox.hidden = false;
						return;
					}
					_searchTimer = setTimeout(() => _runLookupSearch(q), 200);
				});
				searchInput.addEventListener('focus', () => {
					const q = searchInput.value.trim();
					if (q.length >= MIN_QUERY_LEN) {
						_runLookupSearch(q);
					}
				});

				async function _runLookupSearch(q) {
					if (!targetObject) {
						resultsBox.innerHTML =
							'<div class="lookup-result lookup-result--empty">Choose a record type first</div>';
						resultsBox.hidden = false;
						return;
					}
					const editing = canvasState.currentRecordRef;
					const sourceRecordId =
						editing && editing.loadedFromId && /^[a-zA-Z0-9]{15,18}$/.test(editing.loadedFromId)
							? editing.loadedFromId
							: null;
					const cacheKey =
						sourceObject + '|' + fieldName + '|' + targetObject + '|' + q + '|' + (sourceRecordId || '');
					if (_lookupSearchCache.has(cacheKey)) {
						_renderResults(_lookupSearchCache.get(cacheKey));
						return;
					}
					try {
						const url =
							'/api/objects/' +
							encodeURIComponent(sourceObject) +
							'/lookup?fieldName=' +
							encodeURIComponent(fieldName) +
							'&q=' +
							encodeURIComponent(q) +
							'&targetApiName=' +
							encodeURIComponent(targetObject) +
							(currentRecordTypeId ? '&recordTypeId=' + encodeURIComponent(currentRecordTypeId) : '') +
							(sourceRecordId ? '&sourceRecordId=' + encodeURIComponent(sourceRecordId) : '');
						const r = await csrfFetch(url, { credentials: 'same-origin' });
						if (!r.ok) {
							_renderResults([]);
							return;
						}
						const data = await r.json();
						const records = data && Array.isArray(data.records) ? data.records : [];
						_lookupSearchCache.set(cacheKey, records);
						_renderResults(records);
					} catch (e) {
						_renderResults([]);
					}
				}

				function _renderResults(records) {
					if (!records || records.length === 0) {
						resultsBox.innerHTML = '<div class="lookup-result lookup-result--empty">No matches</div>';
						resultsBox.hidden = false;
						return;
					}
					resultsBox.innerHTML = records
						.map((rec) => {
							const subtitleParts = [rec.apiName, rec.subtitle].filter(Boolean);
							const sub = subtitleParts.length
								? '<span class="lookup-result-sub">' + escapeHtml(subtitleParts.join(' · ')) + '</span>'
								: '';
							return (
								'<button type="button" class="lookup-result" data-pick-id="' +
								escapeHtml(rec.id) +
								'" data-pick-title="' +
								escapeHtml(rec.title || '') +
								'" data-pick-object="' +
								escapeHtml(rec.apiName || targetObject) +
								'">' +
								'<span class="lookup-result-title">' +
								escapeHtml(rec.title || rec.id) +
								'</span>' +
								sub +
								'</button>'
							);
						})
						.join('');
					resultsBox.hidden = false;
					resultsBox.querySelectorAll('.lookup-result[data-pick-id]').forEach((btn) => {
						btn.addEventListener('click', () => {
							const pickedObject = btn.getAttribute('data-pick-object') || targetObject;
							if (pickedObject) {
								targetObject = pickedObject;
								picker.dataset.targetObject = pickedObject;
								if (targetSelect) {
									targetSelect.value = pickedObject;
								}
							}
							hidden.value = btn.getAttribute('data-pick-id') || '';
							_showSelectedMode(btn.getAttribute('data-pick-title') || hidden.value, pickedObject);
							hidden.dispatchEvent(new Event('change', { bubbles: true }));
						});
					});
				}

				document.addEventListener(
					'mousedown',
					(ev) => {
						if (!picker.contains(ev.target)) {
							resultsBox.hidden = true;
						}
					},
					{ signal: formLifecycle.signal },
				);
				searchInput.addEventListener('keydown', (ev) => {
					if (ev.key === 'Escape') {
						resultsBox.hidden = true;
					}
				});
			}

			const _lookupDisplayCache = new Map();
			async function _resolveLookupDisplay(targetObject, recordId) {
				if (!targetObject || !recordId) {
					return null;
				}
				const key = targetObject + '|' + recordId;
				if (_lookupDisplayCache.has(key)) {
					return _lookupDisplayCache.get(key);
				}
				try {
					const r = await csrfFetch(
						'/api/objects/' + encodeURIComponent(targetObject) + '/records/' + encodeURIComponent(recordId),
						{ credentials: 'same-origin' },
					);
					if (!r.ok) {
						_lookupDisplayCache.set(key, null);
						return null;
					}
					const rec = await r.json();
					const name = rec && (rec.Name || rec.Subject || rec.Title || rec.CaseNumber || null);
					_lookupDisplayCache.set(key, name);
					return name;
				} catch (e) {
					_lookupDisplayCache.set(key, null);
					return null;
				}
			}

			function fieldBounds(f, fields = currentFields) {
				if (!f) {
					return null;
				}
				// Address coordinates and custom location components can be present
				// without their read-only compound container in writable metadata.
				const coordinateMatch =
					f.type === 'double' &&
					(f.compoundFieldName
						? /(?:Latitude|Longitude)(?:__s)?$/i.exec(f.name)
						: /^(?:(?:Mailing|Other|Billing|Shipping|PersonMailing|PersonOther)?(?:Latitude|Longitude)|.+__(?:Latitude|Longitude)__s)$/i.exec(
								f.name,
							));
				const coordinateKind = coordinateMatch
					? /Latitude(?:__s)?$/i.test(coordinateMatch[0])
						? 'latitude'
						: 'longitude'
					: geolocationCoordinateKind(f, fields);
				if (coordinateKind === 'latitude') {
					return { min: -90, max: 90, step: numericFieldStep(f, 0.000001) };
				}
				if (coordinateKind === 'longitude') {
					return { min: -180, max: 180, step: numericFieldStep(f, 0.000001) };
				}
				if (f.type === 'percent') {
					return { min: -100, max: 100, step: numericFieldStep(f, 0.01) };
				}
				if (typeof f.precision === 'number' && f.precision > 0) {
					const scale = typeof f.scale === 'number' && f.scale >= 0 ? f.scale : 0;
					const intDigits = f.precision - scale;
					const maxAbs = intDigits > 0 ? Math.pow(10, intDigits) - (scale > 0 ? Math.pow(10, -scale) : 1) : 0;
					return { min: -maxAbs, max: maxAbs, step: numericFieldStep(f, 1) };
				}
				if (f.type === 'int') {
					return { min: -2147483648, max: 2147483647, step: 1 };
				}
				return null;
			}

			function isPicklistLikeField(f) {
				if (f.type === 'picklist' || f.type === 'multipicklist' || f.type === 'combobox') {
					return true;
				}
				if (Array.isArray(f.picklistValues) && f.picklistValues.length > 0) {
					return true;
				}
				if (f.picklistValuesByRecordType) {
					for (const k in f.picklistValuesByRecordType) {
						if (
							Array.isArray(f.picklistValuesByRecordType[k]) &&
							f.picklistValuesByRecordType[k].length > 0
						) {
							return true;
						}
					}
				}
				return false;
			}

			function inputForField(f, opts) {
				opts = opts || {};
				const id = 'f_' + escapeHtml(f.name);
				const name = escapeHtml(f.name);
				const def = f.defaultValue != null ? ' value="' + escapeHtml(f.defaultValue) + '"' : '';
				const pvResult = picklistValuesForField(f);
				const picklistValues = retainCurrentPicklistValues(
					pvResult.values,
					currentValueForField(f.name),
					f.type,
					loadedSalesforceValueForField(f.name).value,
				);
				if (supportsCustomPicklistValue(f)) {
					const listId = id + '_options';
					const suggestions = picklistValues
						.filter((value) => !value.retainedCurrent)
						.map(
							(value) =>
								'<option value="' +
								escapeHtml(value.value) +
								'">' +
								escapeHtml(value.label || value.value) +
								'</option>',
						)
						.join('');
					const placeholder =
						f.type === 'multipicklist' ? 'Separate values with semicolons' : 'Select or enter a value';
					return (
						'<input type="text" class="picklist-combobox" id="' +
						id +
						'" name="' +
						name +
						'" list="' +
						listId +
						'" placeholder="' +
						escapeHtml(placeholder) +
						'"' +
						def +
						'><datalist id="' +
						listId +
						'">' +
						suggestions +
						'</datalist>'
					);
				}
				if (f.type === 'multipicklist') {
					const opts = picklistValues
						.map(
							(pv) =>
								'<option value="' +
								escapeHtml(pv.value) +
								'"' +
								(pv.defaultValue ? ' selected' : '') +
								'>' +
								escapeHtml(pv.label) +
								'</option>',
						)
						.join('');
					return '<select multiple size="4" id="' + id + '" name="' + name + '">' + opts + '</select>';
				}
				if (isPicklistLikeField(f)) {
					const controllerField = f.controllerName
						? currentFields.find((cf) => cf.name === f.controllerName)
						: null;
					const controllerLabel = controllerField ? controllerField.label : f.controllerName;
					let placeholder = '-- Select --';
					let disabled = false;
					if (pvResult.state === 'controller-missing') {
						placeholder = 'Select ' + controllerLabel + ' first';
						disabled = true;
					} else if (pvResult.state === 'not-applicable') {
						placeholder = 'Not applicable for this ' + controllerLabel;
						disabled = true;
					} else if (pvResult.state === 'record-type-unavailable') {
						placeholder = 'Options unavailable for this record type';
						disabled = true;
					}
					const opts = ['<option value="">' + escapeHtml(placeholder) + '</option>']
						.concat(
							picklistValues.map(
								(pv) =>
									'<option value="' +
									escapeHtml(pv.value) +
									'"' +
									(pv.defaultValue ? ' selected' : '') +
									'>' +
									escapeHtml(pv.label) +
									'</option>',
							),
						)
						.join('');
					const dAttr = disabled ? ' disabled' : '';
					return '<select id="' + id + '" name="' + name + '"' + dAttr + '>' + opts + '</select>';
				}
				const maxlenAttr = f.length ? ' maxlength="' + f.length + '"' : '';
				switch (f.type) {
					case 'boolean':
						return (
							'<input type="checkbox" id="' +
							id +
							'" name="' +
							name +
							'"' +
							(f.defaultValue ? ' checked' : '') +
							'>'
						);
					case 'int':
					case 'double':
					case 'currency':
					case 'percent': {
						const coordinateKind = geolocationCoordinateKind(f, currentFields);
						const b = coordinateKind ? fieldBounds(f) : browserSafeNumericBounds(fieldBounds(f));
						const rangeAttrs = b
							? (b.min == null || b.max == null ? '' : ' min="' + b.min + '" max="' + b.max + '"') +
								' step="' +
								b.step +
								'"'
							: ' step="' + numericFieldStep(f, f.type === 'int' ? 1 : 0.01) + '"';
						return '<input type="number"' + rangeAttrs + ' id="' + id + '" name="' + name + '"' + def + '>';
					}
					case 'date':
						return '<input type="date" id="' + id + '" name="' + name + '"' + def + '>';
					case 'datetime':
						return '<input type="datetime-local" id="' + id + '" name="' + name + '">';
					case 'time': {
						const timeDefault = timeForChoice(f.defaultValue);
						const options = timeChoiceOptions(timeDefault)
							.map(
								(option) =>
									'<option value="' +
									escapeHtml(option.value) +
									'"' +
									(option.value === timeDefault ? ' selected' : '') +
									(option.current ? ' data-current-time-value="true"' : '') +
									'>' +
									escapeHtml(option.label) +
									'</option>',
							)
							.join('');
						return (
							'<select class="time-select" id="' +
							id +
							'" name="' +
							name +
							'"><option value="">-- Select --</option>' +
							options +
							'</select>'
						);
					}
					case 'email':
						return '<input type="email" id="' + id + '" name="' + name + '"' + maxlenAttr + def + '>';
					case 'phone':
						return (
							'<input type="tel" id="' +
							id +
							'" name="' +
							name +
							'"' +
							' placeholder="(555) 555-1234"' +
							' pattern=".*\\d.*"' +
							' title="Enter a phone number containing at least one digit."' +
							maxlenAttr +
							def +
							'>'
						);
					case 'url':
						return (
							'<input type="text" inputmode="url" id="' +
							id +
							'" name="' +
							name +
							'"' +
							maxlenAttr +
							def +
							'>'
						);
					case 'textarea':
						return (
							'<textarea id="' +
							id +
							'" name="' +
							name +
							'"' +
							maxlenAttr +
							'>' +
							escapeHtml(f.htmlFormatted ? richTextForEditor(f.defaultValue) : f.defaultValue || '') +
							'</textarea>'
						);
					case 'reference': {
						if (isExternalKeyReferenceField(f)) {
							return (
								'<input type="text" id="' +
								id +
								'" name="' +
								name +
								'" autocomplete="off" placeholder="Enter external record ID"' +
								maxlenAttr +
								def +
								'>'
							);
						}
						const lock = associationLockForField(f.name);
						const editableAssociation = opts.editableAssociation;
						if (lock && lock.target && !editableAssociation) {
							return linkedRecordControlHtml(
								f,
								lock,
								describeLinkedTarget(lock.target),
								canEditCanvasStructure(),
								escapeHtml,
							);
						}
						const referenceTargets = Array.isArray(f.referenceTo) ? f.referenceTo.filter(Boolean) : [];
						const initialReferenceValue =
							editableAssociation && editableAssociation.target
								? editableAssociation.target.loadedFromId || ''
								: f.defaultValue || '';
						const inferredTarget = inferReferenceTarget(
							referenceTargets,
							initialReferenceValue || currentValueForField(f.name),
							canvasState.allObjects,
						);
						const polymorphic = referenceTargets.length > 1;
						const targetObject =
							inferredTarget || (referenceTargets.length === 1 ? referenceTargets[0] : '') || '';
						const targetSelect = polymorphic
							? '<select class="lookup-target" aria-label="Record type">' +
								'<option value=""' +
								(targetObject ? '' : ' selected') +
								'>Choose type</option>' +
								referenceTargets
									.map(
										(target) =>
											'<option value="' +
											escapeHtml(target) +
											'"' +
											(target === targetObject ? ' selected' : '') +
											'>' +
											escapeHtml(target) +
											'</option>',
									)
									.join('') +
								'</select>'
							: '';
						const sourceObject =
							currentObject ||
							(canvasState.currentRecordRef && canvasState.currentRecordRef.objectName) ||
							'';
						return (
							'<div class="lookup-picker' +
							(polymorphic ? ' lookup-picker--polymorphic' : '') +
							'"' +
							' data-source-object="' +
							escapeHtml(sourceObject) +
							'"' +
							' data-field-name="' +
							escapeHtml(f.name) +
							'"' +
							' data-target-object="' +
							escapeHtml(targetObject) +
							'">' +
							targetSelect +
							'<input type="hidden" id="' +
							id +
							'" name="' +
							name +
							'" value="' +
							escapeHtml(initialReferenceValue) +
							'">' +
							'<input type="text" class="lookup-search" autocomplete="off"' +
							(targetObject ? '' : ' disabled') +
							' placeholder="Search ' +
							escapeHtml(targetObject || 'records') +
							'…" aria-label="Search ' +
							escapeHtml(targetObject || 'records') +
							'">' +
							'<div class="lookup-results" hidden role="listbox"></div>' +
							'<div class="lookup-selected" hidden>' +
							'<span class="lookup-selected-label"></span>' +
							'<button type="button" class="lookup-clear" aria-label="Clear">×</button>' +
							'</div>' +
							'</div>'
						);
					}
					default:
						return '<input type="text" id="' + id + '" name="' + name + '"' + maxlenAttr + def + '>';
				}
			}

			function sampleValueForField(f, fieldList, ctxValues, rtIdOverride, objectName) {
				const randomDigits = String(Math.floor(Math.random() * 1e10)).padStart(10, '0');
				const longSample = 'Auto-filled sample value ' + randomDigits;
				const capped = (s) => (f.length && f.length > 0 && s.length > f.length ? s.slice(0, f.length) : s);
				const list =
					Array.isArray(fieldList) && fieldList.length > 0
						? fieldList
						: Array.isArray(currentFields)
							? currentFields
							: [];
				if (f.type === 'string' && list.length > 0) {
					const codeSibling = list.find((cf) => cf.name === f.name + 'Code' && isPicklistLikeField(cf));
					if (codeSibling) {
						return null;
					}
				}
				const pv = picklistValuesForField(f, ctxValues, rtIdOverride).values;
				if (Array.isArray(pv) && pv.length > 0) {
					const def = pv.find((v) => v.defaultValue) || pv[0];
					return def ? def.value : '';
				}
				if (f.controllerName && isPicklistLikeField(f)) {
					return null;
				}
				const clamped = (n) => {
					const b = fieldBounds(f, list);
					if (!b) {
						return n;
					}
					let v = Math.max(b.min, Math.min(b.max, n));
					if (b.step >= 1) {
						v = Math.trunc(v);
					}
					return v;
				};
				switch (f.type) {
					case 'boolean':
						return f.defaultValue === true;
					case 'int':
						return clamped(100);
					case 'double':
					case 'currency':
					case 'percent':
						return clamped(100);
					case 'date':
						return new Date().toISOString().slice(0, 10);
					case 'datetime':
						return new Date().toISOString();
					case 'time':
						return '12:00';
					case 'email':
						return capped('autofill' + randomDigits + '@example' + randomDigits + '.com');
					case 'phone':
						return '+15555551234';
					case 'url':
						return capped('https://example' + randomDigits + '.com');
					case 'textarea':
						return capped(longSample);
					case 'picklist':
					case 'multipicklist': {
						const list = f.picklistValues || [];
						const def = list.find((v) => v.defaultValue) || list[0];
						return def ? def.value : '';
					}
					case 'reference':
						return null;
					case 'string':
					default:
						return capped(longSample);
				}
			}

			function isCustomField(f) {
				if (!f) {
					return false;
				}
				if (f.custom === true) {
					return true;
				}
				return typeof f.name === 'string' && f.name.endsWith('__c');
			}

			function fieldTypeFilter(fieldType) {
				if (fieldType === 'standard') {
					return (f) => !isCustomField(f);
				}
				if (fieldType === 'custom') {
					return (f) => isCustomField(f);
				}
				return () => true;
			}

			function showSeedMenu(triggerEl, onPick) {
				document.querySelectorAll('.fill-menu-popup').forEach((el) => el.remove());
				const pop = document.createElement('div');
				pop.className = 'fill-menu-popup';
				const rect = triggerEl.getBoundingClientRect();
				const viewportW = window.innerWidth;
				const left = Math.min(rect.left, viewportW - 240);
				pop.style.left = Math.max(8, left) + 'px';
				pop.style.top = rect.bottom + 6 + 'px';
				const item = (scope, fieldType, label, isDefault) =>
					'<button type="button" data-seed-scope="' +
					scope +
					'" data-seed-type="' +
					fieldType +
					'">' +
					escapeHtml(label) +
					(isDefault ? ' <span class="fm-tag">default</span>' : '') +
					'</button>';
				pop.innerHTML =
					'<div class="fm-subheader">Applies to draft records only; loaded-existing records are not touched.</div>' +
					'<div class="fm-header">Required fields only</div>' +
					item('required', 'both', 'Required fields', true) +
					item('required', 'standard', 'Required, standard only', false) +
					item('required', 'custom', 'Required, custom only', false) +
					'<div class="fm-header">All empty fields</div>' +
					item('all', 'both', 'All empty fields', false) +
					item('all', 'standard', 'All empty, standard only', false) +
					item('all', 'custom', 'All empty, custom only', false);
				document.body.appendChild(pop);
				const cleanup = () => {
					interactionCleanups.delete(cleanup);
					if (pop.parentNode) {
						pop.remove();
					}
					document.removeEventListener('mousedown', outside, true);
					document.removeEventListener('keydown', onEsc, true);
				};
				interactionCleanups.add(cleanup);
				pop.querySelectorAll('button[data-seed-scope]').forEach((b) => {
					b.addEventListener('click', () => {
						cleanup();
						onPick(b.dataset.seedScope, b.dataset.seedType);
					});
				});
				const outside = (ev) => {
					if (!pop.contains(ev.target) && ev.target !== triggerEl) {
						cleanup();
					}
				};
				const onEsc = (ev) => {
					if (ev.key === 'Escape') {
						cleanup();
					}
				};
				setTimeout(() => {
					if (!pop.isConnected) return;
					document.addEventListener('mousedown', outside, true);
					document.addEventListener('keydown', onEsc, true);
				}, 0);
			}

			function showFillScopeMenu(triggerEl, onPick) {
				document.querySelectorAll('.fill-menu-popup').forEach((el) => el.remove());
				const pop = document.createElement('div');
				pop.className = 'fill-menu-popup';
				const rect = triggerEl.getBoundingClientRect();
				const viewportW = window.innerWidth;
				const left = Math.min(rect.left, viewportW - 220);
				pop.style.left = Math.max(8, left) + 'px';
				pop.style.top = rect.bottom + 6 + 'px';
				pop.innerHTML =
					'<div class="fm-header">Include fields</div>' +
					'<button type="button" data-fill-type="both">Standard + Custom</button>' +
					'<button type="button" data-fill-type="standard">Standard only</button>' +
					'<button type="button" data-fill-type="custom">Custom only</button>';
				document.body.appendChild(pop);
				const cleanup = () => {
					interactionCleanups.delete(cleanup);
					if (pop.parentNode) {
						pop.remove();
					}
					document.removeEventListener('mousedown', outside, true);
					document.removeEventListener('keydown', onEsc, true);
				};
				interactionCleanups.add(cleanup);
				pop.querySelectorAll('button[data-fill-type]').forEach((b) => {
					b.addEventListener('click', () => {
						cleanup();
						onPick(b.dataset.fillType);
					});
				});
				const outside = (ev) => {
					if (!pop.contains(ev.target) && ev.target !== triggerEl) {
						cleanup();
					}
				};
				const onEsc = (ev) => {
					if (ev.key === 'Escape') {
						cleanup();
					}
				};
				setTimeout(() => {
					if (!pop.isConnected) return;
					document.addEventListener('mousedown', outside, true);
					document.addEventListener('keydown', onEsc, true);
				}, 0);
			}

			function autoFillFields(scope, fieldType) {
				const pick =
					scope === 'required' ? (f) => f.required : scope === 'optional' ? (f) => !f.required : () => true;
				const typePick = fieldTypeFilter(fieldType);
				const ordered = [
					...currentFields.filter((f) => !f.controllerName),
					...currentFields.filter((f) => f.controllerName),
				];
				const values = {};
				const writableFields = currentFields.filter(
					(field) =>
						!field.calculated &&
						!field.autoNumber &&
						(modalEditMode === 'new' ? field.createable === true : field.updateable === true),
				);
				ordered
					.filter((field) => writableFields.includes(field))
					.filter(pick)
					.filter(typePick)
					.forEach((f) => {
						const sample = sampleValueForField(f, currentFields, values);
						if (sample === null || sample === undefined || sample === '') {
							return;
						}
						values[f.name] = sample;
					});
				tryFixValidationRules(values, writableFields, currentRules);
				for (const name of Object.keys(values)) {
					if (!writableFields.some((field) => field.name === name)) delete values[name];
				}
				Object.keys(values).forEach((fieldName) => editorTouchedFields.add(fieldName));
				populateForm(values);
				refreshEditorValidation();
			}

			modal.querySelector('[data-editor-element="modal-submit"]').addEventListener('click', async () => {
				const submitVersion = openVersion;
				try {
					if (!currentObject) {
						showModalToast('This record is no longer open. Close the editor and try again.', 'error');
						return;
					}
					if (!canEditCurrentRecord()) {
						_syncSubmitButtonAccess();
						showModalToast(
							salesforceRecordIsReadOnly(canvasState.currentRecordRef)
								? 'This record is read-only for your Salesforce user.'
								: 'You can no longer complete this request. Ask the canvas owner to confirm your contributor access.',
							'error',
						);
						return;
					}
					const form = modal.querySelector('[data-editor-element="insert-form"]');
					const existingRecord = !!(
						canvasState.currentRecordRef && canvasState.currentRecordRef.loadedFromId
					);
					if (form) {
						form.querySelectorAll('.field[data-coordinate-kind] input').forEach((control) => {
							normalizeGeolocationControl(control);
						});
						form.querySelectorAll('.field[data-type="datetime"] input').forEach((control) => {
							const field = control.closest('.field[data-field]');
							const fieldName = field && field.dataset ? field.dataset.field : null;
							if (shouldValidateEditorField(fieldName, editorTouchedFields, existingRecord)) {
								updateDateTimeValidity(control);
							}
						});
					}
					const invalidControl = firstInvalidEditorControl(form, editorTouchedFields, existingRecord);
					if (invalidControl) {
						const invalidField = invalidControl && invalidControl.closest('.field[data-field]');
						const invalidLabel = invalidField && invalidField.querySelector('label');
						const section = invalidField && invalidField.closest('.field-section.collapsed');
						if (section) {
							section.classList.remove('collapsed');
						}
						showModalToast(
							'Review ' +
								(invalidLabel
									? invalidLabel.textContent.replace(/\*/g, '').trim()
									: 'the highlighted field') +
								' before saving.',
							'error',
						);
						if (invalidControl && typeof invalidControl.focus === 'function') {
							invalidControl.focus({ preventScroll: false });
						}
						if (typeof invalidControl.reportValidity === 'function') {
							invalidControl.reportValidity();
						}
						return;
					}
					const SF_ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
					const refErrors = [];
					modal.querySelectorAll('.field[data-type="reference"]').forEach((div) => {
						div.classList.remove('field-invalid-ref');
						if (div.dataset.readonly === 'true' || div.classList.contains('is-external-lookup')) {
							return;
						}
						if (!shouldValidateEditorField(div.dataset.field, editorTouchedFields, existingRecord)) {
							return;
						}
						const el = div.querySelector('input');
						if (!el || el.dataset.lockedAssoc) {
							return;
						}
						const v = (el.value || '').trim();
						if (!v) {
							return;
						}
						if (!SF_ID_RE.test(v)) {
							const labelEl = div.querySelector('label');
							refErrors.push({
								name: div.dataset.field,
								label: labelEl ? labelEl.textContent.replace(/\*$/, '').trim() : div.dataset.field,
								el,
								div,
							});
							div.classList.add('field-invalid-ref');
						}
					});
					if (refErrors.length) {
						const first = refErrors[0];
						first.el.focus();
						first.el.select();
						const which = refErrors.map((e) => e.label || e.name).join(', ');
						const msg =
							refErrors.length === 1
								? 'Invalid Salesforce ID in "' + which + '". Expected 15 or 18 alphanumeric characters.'
								: refErrors.length +
									' reference fields have invalid IDs: ' +
									which +
									'. Each must be 15 or 18 alphanumeric characters.';
						if (typeof showBulkToast === 'function') {
							showBulkToast(msg, 'error');
						}
						return;
					}
					let payload = collectFormValues();
					const previousAssociations = canvasState.bulkAssociations.slice();
					const relationshipChanges = reconcileContributorRelationships(payload);
					const record = canvasState.currentRecordRef;
					let encryptedChangedCount = 0;
					if (record && !getCanvasShareRole()) {
						const restoreEncryptedBaseline = (fieldName) => {
							record.values = record.values || {};
							if (
								record.loadedValues &&
								Object.prototype.hasOwnProperty.call(record.loadedValues, fieldName)
							) {
								record.values[fieldName] = record.loadedValues[fieldName];
							} else {
								delete record.values[fieldName];
							}
						};
						for (const fieldName of currentEncryptedDismissedFields) {
							encryptedFields.dismissIntent(record, fieldName);
							restoreEncryptedBaseline(fieldName);
							encryptedChangedCount += 1;
						}
						for (const [fieldName, value] of currentEncryptedFormValues) {
							if (value === undefined) {
								encryptedFields.markIntent(record, fieldName);
							} else {
								encryptedFields.setProposal(record, fieldName, value);
							}
							restoreEncryptedBaseline(fieldName);
							encryptedChangedCount += 1;
						}
					}
					let target;
					let msg;
					let toastVariant = 'success';
					if (canvasState.currentRecordRef) {
						target =
							canvasState.currentRecordRef.label + ' #' + recordOrdinal(canvasState.currentRecordRef);
						const isLoaded = !!canvasState.currentRecordRef.loadedFromId;
						if (isLoaded && canvasState.currentRecordRef.loadedValues) {
							const formFields = new Set();
							modal.querySelectorAll('.field').forEach((div) => {
								if (div.dataset.field) {
									formFields.add(div.dataset.field);
								}
							});
							const hidden = {};
							Object.keys(canvasState.currentRecordRef.loadedValues || {}).forEach((k) => {
								if (!formFields.has(k)) {
									hidden[k] = canvasState.currentRecordRef.loadedValues[k];
								} else {
									const div = modal.querySelector('.field[data-field="' + CSS.escape(k) + '"]');
									if (!div) {
										return;
									}
									if (div.dataset.readonly === 'true' && !(k in payload)) {
										hidden[k] = canvasState.currentRecordRef.loadedValues[k];
										return;
									}
									const el = div.querySelector('input, textarea, select');
									if (el && el.dataset.lockedAssoc && !(k in payload)) {
										hidden[k] = canvasState.currentRecordRef.loadedValues[k];
									}
								}
							});
							payload = Object.assign({}, hidden, payload);
						}
						const previousValues = canvasState.currentRecordRef.values || {};
						const requestedFieldNames = contributorRequestedFieldNames(
							getCanvasShareRole(),
							canvasState.currentRecordRef,
						);
						let changed = intentionalChangedFieldNames(
							changedFieldNames(payload, previousValues),
							editorTouchedFields,
							isLoaded,
							previousValues,
						);
						const encryptedFieldNames = encryptedFields.fieldNames(
							canvasState,
							canvasState.currentRecordRef.objectName,
						);
						changed = changed.filter((fieldName) => !encryptedFieldNames.has(fieldName));
						if (requestedFieldNames) {
							changed = changed.filter((fieldName) => requestedFieldNames.has(fieldName));
						}
						relationshipChanges.forEach((fieldName) => {
							if (
								(!requestedFieldNames || requestedFieldNames.has(fieldName)) &&
								!changed.includes(fieldName)
							) {
								changed.push(fieldName);
							}
						});
						if (changed.length === 0 && encryptedChangedCount === 0) {
							toastVariant = 'info';
							msg = 'No changes to save for ' + target + '.';
						} else {
							if (changed.length > 0) {
								const changedValues = {};
								changed.forEach((fieldName) => {
									changedValues[fieldName] = Object.prototype.hasOwnProperty.call(payload, fieldName)
										? payload[fieldName]
										: null;
								});
								const submitButton = _syncSubmitButtonAccess({ loading: true });
								try {
									await commitRecordFields(canvasState.currentRecordRef, changedValues, {
										relationshipFields: Array.from(relationshipChanges),
									});
									if (submitVersion !== openVersion) return;
								} catch (error) {
									_syncSubmitButtonAccess();
									showModalToast(
										(error && error.message) ||
											'Another user changed or is editing one of these fields. Review the current values and try again.',
										'error',
									);
									return;
								}
								if (submitButton) {
									submitButton.disabled = false;
								}
								canvasState.currentRecordRef.values = mergeSubmittedFieldValues(
									previousValues,
									payload,
									changed,
								);
								canvasState.currentRecordRef._valuesRevision =
									(Number(canvasState.currentRecordRef._valuesRevision) || 0) + 1;
								registerFieldEditUndo(
									{
										...deps,
										commitRecordFields,
										releaseRecordFieldLocks,
										canUndoFields: (targetRecord, names) => {
											const role = getCanvasShareRole();
											if (
												salesforceRecordIsReadOnly(targetRecord) ||
												!sharedRecordEditAccess(
													role,
													targetRecord,
													_slotAssignmentState(targetRecord),
												)
											)
												return false;
											const requested = contributorRequestedFieldNames(role, targetRecord);
											const describe =
												canvasState.describeCache[targetRecord.objectName] ||
												canvasState.draftDescribeCache?.[targetRecord.objectName];
											return names.every((name) => {
												const field = describe?.fields?.find((f) => f.name === name);
												return (
													field &&
													!field.calculated &&
													field.type !== 'encryptedstring' &&
													(targetRecord.loadedFromId ? field.updateable : field.createable) &&
													(!requested || requested.has(name))
												);
											});
										},
									},
									canvasState.currentRecordRef,
									previousValues,
									changed,
									previousAssociations,
								);
							}
							const savedCount = changed.length + encryptedChangedCount;
							msg =
								'Saved ' +
								savedCount +
								' changed field' +
								(savedCount === 1 ? '' : 's') +
								' for ' +
								target +
								(encryptedChangedCount > 0
									? '. Canvas saved. Encrypted upload choices remain only in this tab and will be lost if it closes.'
									: getCanvasShareRole() === 'contributor'
										? ' and shared the update with the owner.'
										: ' locally.');
						}
					} else {
						target = currentObject;
						const previousValues = canvasState.savedRecords[currentObject] || {};
						const changed = changedFieldNames(payload, previousValues);
						if (changed.length === 0) {
							toastVariant = 'info';
							msg = 'No changes to save for ' + target + '.';
						} else {
							canvasState.savedRecords[currentObject] = payload;
							msg =
								'Saved ' +
								changed.length +
								' changed field' +
								(changed.length === 1 ? '' : 's') +
								' for ' +
								target +
								' locally.';
						}
					}
					if (canvasState.currentRecordRef) {
						editorTouchedFields.clear();
						if (typeof renderChips === 'function') {
							renderChips();
						}
						if (canvasState.graphView === 'bulk') {
							renderBulkView();
						}
						closeModal();
						if (typeof showBulkToast === 'function') {
							showBulkToast(msg, toastVariant);
						}
					} else {
						renderForm();
						showModalToast(msg, toastVariant);
						populateForm(payload);
						refreshEditorValidation();
						if (typeof renderChips === 'function') {
							renderChips();
						}
						if (canvasState.graphView === 'bulk') {
							renderBulkView();
						}
					}
				} catch (error) {
					_syncSubmitButtonAccess();
					showModalToast(
						(error && error.message) || 'This request could not be saved. Review the fields and try again.',
						'error',
					);
				}
			});

			function populateForm(values) {
				if (!values) {
					return;
				}
				Object.keys(values).forEach((field) => {
					const div = modal.querySelector('.field[data-field="' + CSS.escape(field) + '"]');
					if (!div) {
						return;
					}
					const ftype = div.dataset.type;
					if (ftype === 'encryptedstring') {
						return;
					}
					const val = values[field];
					if (div.dataset.readonly === 'true' && ftype !== 'reference') {
						const display = div.querySelector('input');
						if (display) {
							if (ftype === 'boolean') {
								display.checked = isSalesforceTrue(val);
							} else {
								display.value = formatReadOnlyFieldValue(
									ftype === 'textarea' && div.dataset.htmlFormatted === 'true'
										? recordRichTextForEditor(canvasState.currentRecordRef, field, val)
										: val,
									ftype,
								);
							}
						}
						return;
					}
					if (ftype === 'boolean') {
						const cb = div.querySelector('input[type="checkbox"]');
						if (cb) {
							cb.checked = isSalesforceTrue(val);
						}
					} else if (ftype === 'multipicklist') {
						const sel = div.querySelector('select');
						if (sel) {
							const vals = val == null || val === '' ? [] : String(val).split(';');
							Array.from(sel.options).forEach((opt) => {
								opt.selected = vals.indexOf(opt.value) !== -1;
							});
						} else {
							const input = div.querySelector('input');
							if (input) {
								input.value = val == null ? '' : String(val);
							}
						}
					} else if (ftype === 'reference') {
						const picker = div.querySelector('.lookup-picker');
						if (!picker) {
							const lockedEl = div.querySelector('input[data-locked-assoc]');
							if (lockedEl) {
								return;
							} // association lock owns the display
							const fallbackEl = div.querySelector('input, textarea, select');
							if (!fallbackEl) {
								return;
							}
							const initial = val == null ? '' : val;
							fallbackEl.value = initial;
							const targetObject = fallbackEl.dataset && fallbackEl.dataset.targetObject;
							if (targetObject && initial) {
								_resolveLookupDisplay(targetObject, initial)
									.then((name) => {
										if (name && fallbackEl.value === initial) {
											fallbackEl.value = name;
										}
									})
									.catch(() => {});
							}
							return;
						}
						const hidden = picker.querySelector('input[type="hidden"]');
						const selectedBox = picker.querySelector('.lookup-selected');
						const selectedLabel = picker.querySelector('.lookup-selected-label');
						const searchInput = picker.querySelector('.lookup-search');
						const resultsBox = picker.querySelector('.lookup-results');
						const targetSelect = picker.querySelector('.lookup-target');
						if (!hidden) {
							return;
						}
						hidden.value = val == null ? '' : val;
						const fieldMetadata = currentFields.find((candidate) => candidate.name === field);
						const inferredTarget = inferReferenceTarget(
							fieldMetadata && fieldMetadata.referenceTo,
							hidden.value,
							canvasState.allObjects,
						);
						if (inferredTarget) {
							picker.dataset.targetObject = inferredTarget;
							if (targetSelect) {
								targetSelect.value = inferredTarget;
							}
						}
						if (!hidden.value) {
							if (selectedBox) {
								selectedBox.hidden = true;
							}
							if (searchInput) {
								searchInput.hidden = false;
							}
							if (resultsBox) {
								resultsBox.hidden = true;
								resultsBox.innerHTML = '';
							}
							return;
						}
						const targetObject = picker.dataset.targetObject || '';
						if (selectedLabel) {
							selectedLabel.textContent = (targetObject ? targetObject + ' \u00b7 ' : '') + hidden.value;
						}
						if (selectedBox) {
							selectedBox.hidden = false;
						}
						if (searchInput) {
							searchInput.hidden = true;
						}
						if (resultsBox) {
							resultsBox.hidden = true;
						}
						_resolveLookupDisplay(targetObject, hidden.value)
							.then((name) => {
								if (name && selectedLabel && hidden.value === val) {
									selectedLabel.textContent = (targetObject ? targetObject + ' \u00b7 ' : '') + name;
								}
							})
							.catch(() => {});
					} else {
						const el = div.querySelector('input, textarea, select');
						if (el && el.dataset.lockedAssoc) {
							return;
						}
						if (el) {
							const display =
								ftype === 'datetime'
									? dateTimeForInput(val)
									: ftype === 'textarea' && div.dataset.htmlFormatted === 'true'
										? recordRichTextForEditor(canvasState.currentRecordRef, field, val)
										: val;
							if (ftype === 'time') {
								setTimeSelectValue(el, val);
							} else {
								el.value = display == null ? '' : display;
							}
						}
					}
				});
			}

			function collectFormValues() {
				const out = {};
				modal.querySelectorAll('.field').forEach((div) => {
					if (div.dataset.readonly === 'true') {
						return;
					}
					const fname = div.dataset.field;
					const ftype = div.dataset.type;
					if (ftype === 'encryptedstring') {
						return;
					}
					if (ftype === 'boolean') {
						const cb = div.querySelector('input[type="checkbox"]');
						out[fname] = !!cb.checked;
						return;
					}
					if (ftype === 'multipicklist') {
						const sel = div.querySelector('select');
						if (sel) {
							const vals = Array.from(sel.selectedOptions)
								.map((o) => o.value)
								.filter(Boolean);
							out[fname] = formSelectValue(ftype, vals);
						} else {
							const input = div.querySelector('input');
							out[fname] = formInputValue(ftype, input ? input.value : '');
						}
						return;
					}
					const el = editorFieldValueControl(div, ftype);
					if (!el) {
						return;
					}
					if (el.dataset.lockedAssoc) {
						return;
					}
					let v = el.value;
					if (div.dataset.coordinateKind) {
						v = truncateDecimalScale(v, Number(div.dataset.coordinateScale));
						if (v !== el.value) {
							el.value = v;
						}
					}
					if (ftype === 'datetime' && typeof v === 'string' && v) {
						v = dateTimeFromInput(v);
					}
					if (el.tagName === 'SELECT') {
						out[fname] = formSelectValue(ftype, v);
						return;
					}
					const inputValue = formInputValue(ftype, v);
					if (inputValue !== undefined) {
						out[fname] = inputValue;
					}
				});
				return out;
			}

			function hasPendingEncryptedUploadValues() {
				if (getCanvasShareRole()) {
					return false;
				}
				const records = Array.isArray(canvasState.bulkRecords) ? canvasState.bulkRecords : [];
				if (
					records.some((record) =>
						encryptedFields
							.intentNames(record, canvasState)
							.some((fieldName) => encryptedFields.hasProposal(record, fieldName)),
					)
				) {
					return true;
				}
				return Array.from(currentEncryptedFormValues.values()).some(
					(value) => value === null || (typeof value === 'string' && value !== ''),
				);
			}

			return {
				activate,
				updateUploadFixFields(fields) {
					uploadFixFields = fields.slice();
					if (guidedAdvanceTimer) {
						clearTimeout(guidedAdvanceTimer);
						guidedAdvanceTimer = null;
					}
				},
				setActive(value) {
					editorActive = value;
					modal.classList.toggle('is-active-editor', value);
				},
				destroy() {
					openVersion += 1;
					lifecycle.abort();
					formLifecycle.abort();
					closeEncryptedTooltip();
					_exitInlineMode();
					if (_modalToastTimer) clearTimeout(_modalToastTimer);
					modal.remove();
				},
				unlinkRecord,
				openInsertModal: openInsertModal,
				closeModal: closeModal,
				showModalToast: showModalToast,
				refreshCurrentRecordAccess: refreshCurrentRecordAccess,
				refreshCurrentFieldLocks: refreshCurrentFieldLocks,
				refreshCurrentRecordValues: refreshCurrentRecordValues,
				_prefetchLayoutForRecord: _prefetchLayoutForRecord,
				tryParseRule: tryParseRule,
				tryFixValidationRules: tryFixValidationRules,
				fieldTypeFilter: fieldTypeFilter,
				sampleValueForField: sampleValueForField,
				hasPendingEncryptedUploadValues: hasPendingEncryptedUploadValues,
			};
		},
	};
})();

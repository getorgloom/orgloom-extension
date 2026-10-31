(function () {
	'use strict';
	// Serializes schema templates or canvas snapshots and validates them before changing state.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.templates = {
		mount: function mount(deps) {
			const _required = [
				'canvasState',
				'showBulkToast',
				'escapeHtml',
				'csrfFetch',
				'ensureDescribe',
				'addToSelection',
				'setGraphView',
				'renderAll',
				'showReplaceOrMergeDialog',
				'pingAuditEvent',
				'getCanvasRecordCap',
				'realRecordCount',
				'runSlotPreflight',
				'clearEmptyStarterCard',
				'getSlotIdSeq',
				'setSlotIdSeq',
			];
			for (const k of _required) {
				if (deps == null || deps[k] == null) {
					throw new Error('templates.mount: missing required dep: ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const showBulkToast = deps.showBulkToast;
			const escapeHtml = deps.escapeHtml;
			const csrfFetch = deps.csrfFetch;
			const ensureDescribe = deps.ensureDescribe;
			const addToSelection = deps.addToSelection;
			const setGraphView = deps.setGraphView;
			const renderAll = deps.renderAll;
			const showReplaceOrMergeDialog = deps.showReplaceOrMergeDialog;
			const pingAuditEvent = deps.pingAuditEvent;
			const _getCanvasRecordCap = deps.getCanvasRecordCap;
			const _realRecordCount = deps.realRecordCount;
			const _runSlotPreflight = deps.runSlotPreflight;
			const clearEmptyStarterCard = deps.clearEmptyStarterCard;
			const getSlotIdSeq = deps.getSlotIdSeq;
			const setSlotIdSeq = deps.setSlotIdSeq;
			const encryptedFields = window.OrgLoom && window.OrgLoom.encryptedFields;
			if (!encryptedFields) {
				throw new Error('encrypted-fields.js must load before templates.js');
			}
			const _observeSlotId = (slotId) => {
				setSlotIdSeq(Math.max(getSlotIdSeq(), Number(slotId) + 1));
			};
			const canvasCapCheck =
				typeof deps.canvasCapCheck === 'function'
					? deps.canvasCapCheck
					: function () {
							return { ok: true, blocked: false, reason: null };
						};
			const showBulkToastWithAction =
				typeof deps.showBulkToastWithAction === 'function' ? deps.showBulkToastWithAction : null;

			const _CANVAS_RECORD_CAP_get = () => _getCanvasRecordCap();

			const TEMPLATE_VERSION = 2;
			const TEMPLATE_RECORD_CAP = 500;
			try {
				localStorage.removeItem('sf-loader-templates-v1');
			} catch (_) {}

			function serializeObjects(includeIdx) {
				const idxById = new Map();
				canvasState.selectedObjects.forEach((s, i) => idxById.set(s.id, i));
				return canvasState.selectedObjects.map((s, idx) => {
					const o = {
						name: s.name,
						label: s.label || s.name,
						addedFromIdx: s.addedFrom != null ? idxById.get(s.addedFrom) : null,
						addedVia: s.addedVia || null,
						worldPos: s.worldPos || null,
					};
					if (includeIdx) {
						o.idx = idx;
					}
					return o;
				});
			}

			function _serializedEncryptedIntents(record) {
				const encrypted = encryptedFields.fieldNames(canvasState, record && record.objectName);
				const intents = new Set(encryptedFields.intentNames(record, canvasState));
				if (record && record.loadedFromId) {
					const vc = window.OrgLoom && window.OrgLoom.valueCompare;
					const changed =
						vc && typeof vc.changedFieldNames === 'function'
							? vc.changedFieldNames(record.values || {}, record.loadedValues || {})
							: [];
					changed.forEach((fieldName) => {
						if (encrypted.has(fieldName)) {
							intents.add(fieldName);
						}
					});
				} else if (record) {
					for (const fieldName of Object.keys(record.values || {})) {
						if (encrypted.has(fieldName)) {
							intents.add(fieldName);
						}
					}
				}
				return Array.from(intents).sort();
			}

			function uploadRecoveryMarker(value) {
				if (
					!value ||
					!/^[a-zA-Z0-9-]{16,64}$/.test(value.attemptId || '') ||
					!value.orgId ||
					!value.userId ||
					value.tempId == null
				) {
					return undefined;
				}
				return { attemptId: value.attemptId, tempId: value.tempId, orgId: value.orgId, userId: value.userId };
			}
			function recordCommonParts(r) {
				const out = {};
				const uploadRecovery = uploadRecoveryMarker(r._uploadRecovery);
				if (uploadRecovery) {
					out.uploadRecovery = uploadRecovery;
				}
				if (r.slot) {
					out.slot = r.slot;
				}
				if (r.pendingDelete) {
					out.pendingDelete = true;
				}
				const encryptedFieldIntents = _serializedEncryptedIntents(r);
				if (encryptedFieldIntents.length > 0) {
					out.encryptedFieldIntents = encryptedFieldIntents;
				}
				return out;
			}

			async function checkImportedRecords(records) {
				const real = records.filter((record) => record && !record.isTypeNode && !record._permissionHidden);
				const descriptions = new Map();
				await Promise.all(
					[...new Set(real.map((record) => record.objectName))].map(async (name) => {
						try {
							descriptions.set(name, await ensureDescribe(name, { force: true }));
						} catch (_) {
							descriptions.set(name, null);
						}
					}),
				);
				let objectsUnavailable = 0;
				let fieldsUnavailable = 0;
				real.forEach((record) => {
					const describe = descriptions.get(record.objectName);
					const fieldNames = new Set((describe?.fields || []).map((field) => field.name.toLowerCase()));
					const missingFields = describe
						? Object.keys(record.values || {}).filter(
								(name) =>
									name !== 'attributes' &&
									!name.startsWith('_') &&
									!fieldNames.has(name.toLowerCase()),
							)
						: [];
					delete record._importSchemaWarning;
					if (!describe) {
						objectsUnavailable++;
					}
					fieldsUnavailable += missingFields.length;
					if (!describe || missingFields.length) {
						record._importSchemaWarning = { objectUnavailable: !describe, fields: missingFields };
					}
				});
				return (
					(objectsUnavailable
						? ' ' +
							objectsUnavailable +
							(objectsUnavailable === 1 ? ' record uses' : ' records use') +
							' an unavailable object. Kept on the canvas, but cannot be uploaded through this connection.'
						: '') +
					(fieldsUnavailable
						? ' ' +
							fieldsUnavailable +
							(fieldsUnavailable === 1 ? ' field value is' : ' field values are') +
							' unavailable through this connection. Kept in the imported data and JSON export, but not available in the normal field editor or included in Salesforce writes.'
						: '')
				);
			}

			function _mintCanvasRecordId() {
				try {
					if (window.crypto && typeof window.crypto.randomUUID === 'function') {
						return window.crypto.randomUUID();
					}
				} catch (_) {}
				return 'card_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
			}

			function _ensureCanvasRecordId(record) {
				if (
					record._canvasRecordId != null &&
					String(record._canvasRecordId) &&
					String(record._canvasRecordId).length <= 128
				) {
					return String(record._canvasRecordId);
				}
				record._canvasRecordId = _mintCanvasRecordId();
				return record._canvasRecordId;
			}

			function loadedEditDelta(r) {
				// Preserve only edits relative to the loaded Salesforce baseline when requested.
				if (!r.loadedValues) {
					return null;
				}
				const vc = (window.OrgLoom && window.OrgLoom.valueCompare) || null;
				if (!vc || typeof vc.changedFieldNames !== 'function') {
					return null;
				}
				const encrypted = encryptedFields.fieldNames(canvasState, r.objectName);
				const changed = vc
					.changedFieldNames(r.values || {}, r.loadedValues || {})
					.filter((fieldName) => !encrypted.has(fieldName));
				if (!changed.length) {
					return null;
				}
				const changes = {};
				changed.forEach((f) => {
					const value = (r.values || {})[f];
					changes[f] = value === undefined ? null : value;
				});
				return changes;
			}

			function draftFieldMetadata(objects, draftRecords) {
				const namesByObject = new Map();
				const wholeRecordRequests = new Set();
				for (const record of draftRecords) {
					if (!record || !record.objectName) {
						continue;
					}
					if (!namesByObject.has(record.objectName)) {
						namesByObject.set(record.objectName, new Set());
					}
					Object.keys(record.values || {}).forEach((name) => namesByObject.get(record.objectName).add(name));
					(Array.isArray(record.encryptedFieldIntents) ? record.encryptedFieldIntents : []).forEach((name) =>
						namesByObject.get(record.objectName).add(name),
					);
					if (record.slot && record.slot.kind === 'fields') {
						(record.slot.fields || []).forEach((name) => namesByObject.get(record.objectName).add(name));
					} else if (record.slot) {
						wholeRecordRequests.add(record.objectName);
					}
				}
				return objects.map((object) => {
					const describe =
						canvasState.describeCache[object.name] ||
						(canvasState.draftDescribeCache && canvasState.draftDescribeCache[object.name]);
					const requested = namesByObject.get(object.name) || new Set();
					const sourceFields = describe && Array.isArray(describe.fields) ? describe.fields : [];
					if (wholeRecordRequests.has(object.name)) {
						sourceFields
							.filter((field) => field && field.createable)
							.forEach((field) => requested.add(field.name));
					}
					const fields = sourceFields
						.filter((field) => field && requested.has(field.name))
						.map((field) => ({
							name: field.name,
							label: field.label || field.name,
							type: field.type || 'string',
							createable: wholeRecordRequests.has(object.name) ? !!field.createable : true,
							updateable: !!field.updateable,
							required: !!field.required,
							nillable: field.nillable !== false,
							defaultedOnCreate: !!field.defaultedOnCreate,
							calculated: !!field.calculated,
							autoNumber: !!field.autoNumber,
							nameField: !!field.nameField,
							compoundFieldName: field.compoundFieldName || null,
							length: field.length,
							precision: field.precision,
							scale: field.scale,
							referenceTo: Array.isArray(field.referenceTo) ? field.referenceTo.slice() : [],
							relationshipName: field.relationshipName || null,
							picklistValues: Array.isArray(field.picklistValues)
								? field.picklistValues
										.filter((value) => value && value.active !== false)
										.map((value) => ({
											label: value.label,
											value: value.value,
											active: true,
											defaultValue: !!value.defaultValue,
										}))
								: [],
						}));
					for (const name of requested) {
						if (!fields.some((field) => field.name === name)) {
							fields.push({ name, label: name, type: 'string', createable: true, updateable: false });
						}
					}
					return fields.length > 0 ? Object.assign({}, object, { draftFields: fields }) : object;
				});
			}

			async function ensureDraftSlotMetadata() {
				const objectNames = Array.from(
					new Set(
						(canvasState.bulkRecords || [])
							.filter(
								(record) =>
									record &&
									!record.isTypeNode &&
									!record.isPending &&
									!record.loadedFromId &&
									record.slot &&
									(record.slot.kind || 'whole-record') === 'whole-record' &&
									record.objectName,
							)
							.map((record) => record.objectName),
					),
				);
				for (const objectName of objectNames) {
					let describe = canvasState.describeCache && canvasState.describeCache[objectName];
					const mayReuseSharedSnapshot =
						canvasState.currentCanvas && canvasState.currentCanvas.ownedByMe === false;
					if (
						(!describe || !Array.isArray(describe.fields) || describe.fields.length === 0) &&
						mayReuseSharedSnapshot
					) {
						describe = canvasState.draftDescribeCache && canvasState.draftDescribeCache[objectName];
					}
					if (!describe || !Array.isArray(describe.fields) || describe.fields.length === 0) {
						try {
							describe = await ensureDescribe(objectName, { force: true });
						} catch (error) {
							throw new Error(
								'Could not prepare the ' +
									objectName +
									' record request for sharing. Reconnect Salesforce and try again. ' +
									(error && error.message ? error.message : ''),
							);
						}
					}
					if (
						!describe ||
						!Array.isArray(describe.fields) ||
						!describe.fields.some((field) => field && field.createable)
					) {
						throw new Error(
							'Could not prepare the ' +
								objectName +
								' record request because no createable fields are available.',
						);
					}
					if (!mayReuseSharedSnapshot || describe !== canvasState.draftDescribeCache?.[objectName]) {
						canvasState.describeCache[objectName] = describe;
					}
				}
				return objectNames;
			}

			function buildTemplate(opts) {
				opts = opts || {};
				const schemaOnly = !!opts.schemaOnly;
				const objects = serializeObjects(false);
				let records;
				let associations;
				let includesLoadedData = false;
				if (schemaOnly) {
					records = [];
					associations = [];
				} else {
					const base = canvasState.bulkRecords.filter(
						(r) => !r.isTypeNode && !r.isPending && !r._permissionHidden && !r._inaccessible,
					);
					const excludedIds = new Set(
						canvasState.bulkRecords.filter((r) => !base.includes(r)).map((r) => r.id),
					);
					const links = canvasState.bulkAssociations.filter(
						(a) => !excludedIds.has(a.fromId) && !excludedIds.has(a.toId),
					);
					validateRecordGraph(base, links);
					includesLoadedData = base.some((r) => !!r.loadedFromId);
					records = base.map((r) => {
						const rec = Object.assign(
							{
								id: r.id,
								objectName: r.objectName,
								label: r.label,
								x: r.x,
								y: r.y,
							},
							recordCommonParts(r),
						);
						const values = window.OrgLoom.valueCompare.exportRecordValues(r, canvasState);
						rec.values = values;
						if (r.loadedFromId) {
							rec.loadedFromId = r.loadedFromId;
							if (r.loadedValues) {
								const baseline = window.OrgLoom.valueCompare.exportRecordValues(
									{ ...r, values: r.loadedValues },
									canvasState,
								);
								// Only changed fields need old values to restore dirty status, not a second full snapshot.
								rec.originalValues = {};
								for (const field of window.OrgLoom.valueCompare.changedFieldNames(values, baseline)) {
									if (field === 'Id') continue;
									rec.originalValues[field] = baseline[field] === undefined ? null : baseline[field];
									if (!Object.hasOwn(values, field)) values[field] = null;
								}
							}
						}
						return rec;
					});
					if (records.length > TEMPLATE_RECORD_CAP) {
						throw new Error(
							'Template exceeds the ' +
								TEMPLATE_RECORD_CAP +
								'-record cap (found ' +
								records.length +
								').',
						);
					}
					associations = links.map((a) => ({ fromId: a.fromId, toId: a.toId, fieldName: a.fieldName }));
				}
				return {
					_meta: {
						app: 'Org Loom',
						version: TEMPLATE_VERSION,
						recordData: 'snapshot-with-changes',
						exportedFrom: window.SF_ORG_ID || null,
						exportedBy: window.SF_USER_ID || null,
						exportedByName: window.SF_USER_NAME || null,
						exportedAt: new Date().toISOString(),
						schemaOnly,
						includesLoadedData,
						preservesLoadedLinks: includesLoadedData,
						includedLoadedObjects: includesLoadedData
							? Array.from(
									new Set(
										canvasState.bulkRecords
											.filter((r) => !r.isTypeNode && r.loadedFromId)
											.map((r) => r.objectName),
									),
								)
							: [],
						recordCount: records.length,
					},
					schema: { objects },
					records,
					associations,
				};
			}

			function sanitizeFilename(s) {
				return (
					String(s || 'orgloom-template')
						.replace(/[^a-zA-Z0-9_\-. ]+/g, '_')
						.slice(0, 80) || 'orgloom-template'
				);
			}

			function buildCanvasPayload() {
				let objects = serializeObjects(true);
				const real = canvasState.bulkRecords.filter(
					(r) => !r.isTypeNode && !r.isPending && !r._permissionHidden,
				);
				const stableDraftRef = (record) => {
					// Saving and live sharing must use the same draft identity from the first save.
					if (record._persistedTempId == null) {
						record._persistedTempId = record._collabId || _ensureCanvasRecordId(record);
					}
					return record._persistedTempId;
				};
				const loadedRecords = real
					.filter((r) => !!r.loadedFromId)
					.map((r) => {
						const base = Object.assign(
							{
								loadedFromId: r.loadedFromId,
								canvasRecordId: _ensureCanvasRecordId(r),
								objectName: r.objectName,
								x: r.x,
								y: r.y,
							},
							recordCommonParts(r),
						);
						const changes = loadedEditDelta(r);
						if (changes) {
							base.changes = changes;
						}
						return base;
					});
				const drafts = real
					.filter((r) => !r.loadedFromId)
					.map((r) =>
						Object.assign(
							{
								tempId: stableDraftRef(r),
								canvasRecordId: _ensureCanvasRecordId(r),
								objectName: r.objectName,
								x: r.x,
								y: r.y,
								values: encryptedFields.stripValues(canvasState, r.objectName, r.values),
							},
							recordCommonParts(r),
						),
					);
				objects = draftFieldMetadata(objects, drafts);
				const resolveRefKey = (rec) => {
					if (!rec) {
						return null;
					}
					if (rec.slot && rec.slot.slotId != null) {
						return { kind: 'slot', ref: rec.slot.slotId };
					}
					if (rec.loadedFromId) {
						return { kind: 'loaded', ref: rec.loadedFromId };
					}
					return { kind: 'draft', ref: stableDraftRef(rec) };
				};
				const draftIds = new Set(drafts.filter((d) => !d.slot).map((d) => d.tempId));
				const loadedSet = new Set(loadedRecords.filter((l) => !l.slot).map((l) => l.loadedFromId));
				const slotIds = new Set(real.filter((r) => r.slot).map((r) => r.slot.slotId));
				const associations = canvasState.bulkAssociations
					.map((a) => {
						const fromRec = real.find((r) => r.id === a.fromId);
						const toRec = real.find((r) => r.id === a.toId);
						if (!fromRec || !toRec) {
							return null;
						}
						const fromKey = resolveRefKey(fromRec);
						const toKey = resolveRefKey(toRec);
						if (!fromKey || !toKey) {
							return null;
						}
						const inSet = (k) =>
							k.kind === 'loaded'
								? loadedSet.has(k.ref)
								: k.kind === 'draft'
									? draftIds.has(k.ref)
									: slotIds.has(k.ref);
						if (!inSet(fromKey) || !inSet(toKey)) {
							return null;
						}
						return { from: fromKey, to: toKey, fieldName: a.fieldName };
					})
					.filter(Boolean);
				return {
					_meta: {
						app: 'Org Loom',
						version: 1,
						savedFrom: window.SF_ORG_ID || null,
						savedBy: window.SF_USER_ID || null,
						savedByName: window.SF_USER_NAME || null,
					},
					schema: { objects },
					loadedRecords,
					drafts,
					associations,
				};
			}

			function downloadTemplate(name, schemaOnly) {
				let payload;
				try {
					payload = buildTemplate({ schemaOnly });
				} catch (e) {
					showBulkToast(e.message, 'error');
					return;
				}
				const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = sanitizeFilename(name) + '.orgloom.json';
				document.body.appendChild(a);
				a.click();
				setTimeout(() => {
					URL.revokeObjectURL(url);
					a.remove();
				}, 0);
				const msg = schemaOnly
					? 'Downloaded schema (' +
						payload.schema.objects.length +
						' object' +
						(payload.schema.objects.length === 1 ? '' : 's') +
						').'
					: 'Downloaded ' + payload.records.length + '-record template.';
				showBulkToast(msg);
				pingAuditEvent('canvas_export_file', {
					recordCount: payload.records.length,
					payload: {
						name,
						schemaOnly: !!schemaOnly,
						objectCount: payload.schema.objects.length,
						includesLoadedData: !!(payload._meta && payload._meta.includesLoadedData),
					},
				});
			}

			async function saveTemplateRemote(name, scope) {
				let payload;
				try {
					payload = buildTemplate({ schemaOnly: true });
				} catch (e) {
					showBulkToast(e.message, 'error');
					return;
				}
				try {
					const r = await csrfFetch('/api/templates', {
						method: 'POST',
						credentials: 'same-origin',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ name, scope: scope === 'team' ? 'team' : 'personal', payload }),
					});
					const data = await r.json().catch(() => ({}));
					if (!r.ok) {
						throw new Error((data && data.error) || 'HTTP ' + r.status);
					}
					const where = scope === 'team' ? 'team workspace' : 'your personal workspace';
					showBulkToast('Saved schema \u201c' + name + '\u201d to ' + where + '.');
				} catch (e) {
					showBulkToast('Save failed: ' + (e.message || e), 'error');
				}
			}

			const ACCEPTED_APP_TAGS = ['Orgloom', 'Org Loom', 'Seedsmith'];

			function _checkFileVersion(meta) {
				const v = meta && meta.version;
				if (v != null && Number(v) > TEMPLATE_VERSION) {
					throw new Error(
						'This file was exported by a newer version of Org Loom (file format v' +
							v +
							', this app reads v' +
							TEMPLATE_VERSION +
							'). Refresh the app and try again.',
					);
				}
			}

			function _isRecordEntry(r) {
				return !!(r && typeof r === 'object' && typeof r.objectName === 'string' && r.objectName);
			}

			function _cleanValues(v) {
				return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
			}

			function _savedCoordinate(value, fallback) {
				const number = Number(value);
				return Number.isFinite(number) ? number : fallback;
			}

			function _payloadCanvasRecordIds(loadedRecords, drafts) {
				const ids = new Map();
				const counts = new Map();
				const assign = (record, kind, naturalRef) => {
					if (
						record &&
						record.canvasRecordId != null &&
						String(record.canvasRecordId) &&
						String(record.canvasRecordId).length <= 128
					) {
						ids.set(record, String(record.canvasRecordId));
						return;
					}
					const base = kind + ':' + String(naturalRef || 'unknown');
					const occurrence = (counts.get(base) || 0) + 1;
					counts.set(base, occurrence);
					ids.set(record, 'legacy:' + base + ':' + occurrence);
				};
				for (const record of loadedRecords) {
					const naturalRef =
						record && record.slot && record.slot.slotId != null
							? 'slot:' + record.slot.slotId
							: record && record.loadedFromId;
					assign(record, 'loaded', naturalRef);
				}
				for (const record of drafts) {
					const naturalRef =
						record && record.slot && record.slot.slotId != null
							? 'slot:' + record.slot.slotId
							: record && record.tempId;
					assign(record, 'draft', naturalRef);
				}
				return ids;
			}

			function _restoreSlot(slot) {
				const restored = {
					slotId: slot.slotId,
					createdAt: Number.isFinite(Number(slot.createdAt)) ? Number(slot.createdAt) : null,
					label: slot.label,
					description: slot.description || null,
					kind: slot.kind || 'whole-record',
					origin: slot.origin || null,
					assigneeSfUserId: slot.assigneeSfUserId || null,
					assigneeName: slot.assigneeName || null,
					assigneeEmail: slot.assigneeEmail || null,
				};
				if (restored.kind === 'fields' && Array.isArray(slot.fields)) {
					restored.fields = slot.fields.slice();
				}
				const unavailableFieldCount = Number(slot.unavailableFieldCount);
				if (Number.isSafeInteger(unavailableFieldCount) && unavailableFieldCount > 0) {
					restored.unavailableFieldCount = unavailableFieldCount;
				}
				return restored;
			}

			const _admitAssociation = window.OrgLoom.importShared.admitAssociation;
			const _skipSuffix = window.OrgLoom.importShared.skipSuffix;

			function _summaryToast(msg, variant, opts) {
				if (opts && typeof opts.undo === 'function' && showBulkToastWithAction) {
					if (typeof opts.undo.arm === 'function') {
						opts.undo.arm();
					}
					showBulkToastWithAction(msg, 'Undo', opts.undo, variant);
				} else {
					showBulkToast(msg, variant);
				}
			}

			function _mergeOffsetY(merge, incomingYs) {
				if (!merge || !incomingYs.length) {
					return 0;
				}
				const existing = canvasState.bulkRecords.filter((r) => !r.isTypeNode);
				if (!existing.length) {
					return 0;
				}
				const maxY = Math.max.apply(
					null,
					existing.map((r) => Number(r.y) || 0),
				);
				const minIncoming = Math.min.apply(null, incomingYs);
				return maxY + 260 - minIncoming;
			}

			function validateTemplate(t) {
				// Treat imported JSON as untrusted input even when it was exported by Org Loom.
				if (!t || typeof t !== 'object') {
					throw new Error('Invalid template: not an object.');
				}
				if (!t._meta || !ACCEPTED_APP_TAGS.includes(t._meta.app)) {
					throw new Error('Not an Orgloom template file.');
				}
				_checkFileVersion(t._meta);
				if (!t.schema || !Array.isArray(t.schema.objects)) {
					throw new Error('Invalid template: missing schema.objects.');
				}
				if (!Array.isArray(t.records)) {
					throw new Error('Invalid template: missing records.');
				}
				if (!Array.isArray(t.associations)) {
					throw new Error('Invalid template: missing associations.');
				}
				if (t.records.length > TEMPLATE_RECORD_CAP) {
					throw new Error('Template exceeds the ' + TEMPLATE_RECORD_CAP + '-record cap.');
				}
				validateRecordGraph(t.records, t.associations);
				if (t._meta.recordData === 'snapshot-with-changes') {
					for (const r of t.records) {
						if (
							r.originalValues != null &&
							(typeof r.originalValues !== 'object' ||
								Array.isArray(r.originalValues) ||
								Object.hasOwn(r.originalValues, 'Id'))
						)
							throw new Error('Invalid original field values.');
					}
				}
				if (t._meta.recordData === 'references-and-changes') {
					for (const r of t.records) {
						if (r.loadedFromId && !/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(r.loadedFromId))
							throw new Error('Invalid Salesforce record ID.');
						if (
							r.changes != null &&
							(typeof r.changes !== 'object' ||
								Array.isArray(r.changes) ||
								Object.hasOwn(r.changes, 'Id'))
						)
							throw new Error('Invalid record changes.');
					}
				}
			}

			// Never guess which duplicate record or lookup target an imported/exported ID means.
			function validateRecordGraph(records, associations) {
				const byId = new Map();
				for (const record of records) {
					if (
						!_isRecordEntry(record) ||
						!(
							(typeof record.id === 'number' && Number.isSafeInteger(record.id)) ||
							(typeof record.id === 'string' && record.id.trim())
						)
					) {
						throw new Error('Invalid canvas snapshot: a record is missing a valid ID.');
					}
					const key = String(record.id);
					if (byId.has(key))
						throw new Error(
							'Invalid canvas snapshot: duplicate record ID ' + key + '. No records were changed.',
						);
					byId.set(key, record);
				}
				const usedFields = new Set();
				for (const link of associations) {
					const from = byId.get(String(link?.fromId));
					const to = byId.get(String(link?.toId));
					if (!from || !to || typeof link.fieldName !== 'string' || !link.fieldName.trim()) {
						throw new Error('Invalid canvas snapshot: a relationship has a missing record or field.');
					}
					const key = JSON.stringify([String(from.id), link.fieldName.toLowerCase()]);
					if (usedFields.has(key))
						throw new Error(
							'Invalid canvas snapshot: more than one connection uses ' +
								link.fieldName +
								' on record ' +
								from.id +
								'.',
						);
					usedFields.add(key);
					const value = (from.changes || from.values)?.[link.fieldName];
					if (
						to.loadedFromId &&
						value != null &&
						value !== '' &&
						String(value).slice(0, 15) !== String(to.loadedFromId).slice(0, 15)
					) {
						throw new Error(
							'Invalid canvas snapshot: ' + link.fieldName + ' disagrees with its connected record.',
						);
					}
				}
			}

			function validateCanvasPayload(p) {
				if (!p || typeof p !== 'object') {
					throw new Error('Invalid canvas file: not an object.');
				}
				if (!p._meta || !ACCEPTED_APP_TAGS.includes(p._meta.app)) {
					throw new Error('Not an Orgloom canvas file.');
				}
				_checkFileVersion(p._meta);
				if (!p.schema || !Array.isArray(p.schema.objects)) {
					throw new Error('Invalid canvas file: missing schema.objects.');
				}
				if (!Array.isArray(p.associations)) {
					throw new Error('Invalid canvas file: missing associations.');
				}
			}

			async function applyTemplate(t, opts) {
				opts = opts || {};
				const beforeImport = new Set(canvasState.bulkRecords);
				const schemaOnly = !!opts.schemaOnly;
				const merge = !!opts.merge;
				validateTemplate(t);
				if (
					!schemaOnly &&
					t._meta.recordData === 'references-and-changes' &&
					t.records.some((r) => r.loadedFromId)
				) {
					if (!window.SF_ORG_ID || t._meta.exportedFrom !== window.SF_ORG_ID) {
						throw new Error(
							'Connect to the Salesforce org this file was exported from to reload its existing records.',
						);
					}
					// Fetch before replacing anything, and never fall back to partial drafts on failure.
					const records = new Array(t.records.length);
					let next = 0;
					const worker = async () => {
						while (next < t.records.length) {
							const index = next++;
							const r = t.records[index];
							if (
								!r.loadedFromId ||
								(merge &&
									canvasState.bulkRecords.some(
										(existing) =>
											existing.objectName === r.objectName &&
											existing.loadedFromId === r.loadedFromId,
									))
							) {
								records[index] = r;
								continue;
							}
							const response = await csrfFetch(
								'/api/objects/' +
									encodeURIComponent(r.objectName) +
									'/records/' +
									encodeURIComponent(r.loadedFromId),
								{ credentials: 'same-origin' },
							);
							if (!response.ok)
								throw new Error(
									'Could not reload an existing ' +
										r.objectName +
										' record from Salesforce. No records were imported.',
								);
							const fresh = await response.json();
							if (!fresh || !fresh.Id)
								throw new Error('Salesforce returned an incomplete record. No records were imported.');
							records[index] = { ...r, loadedValues: fresh, values: { ...fresh, ...(r.changes || {}) } };
						}
					};
					await Promise.all(Array.from({ length: Math.min(6, t.records.length) }, worker));
					t = { ...t, records };
				}
				const sameOrg = !!t._meta.exportedFrom && t._meta.exportedFrom === window.SF_ORG_ID;
				const honorLoadedLinks = !!t._meta.preservesLoadedLinks && sameOrg;
				const loadedKey = (r) =>
					r.loadedFromId ? r.objectName + '::' + String(r.loadedFromId).slice(0, 15) : null;
				const existingLoaded = new Map();
				if (merge && honorLoadedLinks) {
					canvasState.bulkRecords
						.filter((r) => !r.isTypeNode && r.loadedFromId)
						.forEach((r) => existingLoaded.set(loadedKey(r), r.id));
				}
				{
					const seen = new Set(existingLoaded.keys());
					const incoming = schemaOnly
						? 0
						: t.records.filter((r) => {
								const key = merge && honorLoadedLinks && loadedKey(r);
								if (key && seen.has(key)) return false;
								if (key) seen.add(key);
								return true;
							}).length;
					const existingCount = merge ? _realRecordCount() : 0;
					if (existingCount + incoming > _CANVAS_RECORD_CAP_get()) {
						throw new Error(
							'Loading this template would put the canvas over the ' +
								_CANVAS_RECORD_CAP_get() +
								'-record cap (' +
								(existingCount + incoming) +
								'). Remove some records or reset the canvas first.',
						);
					}
				}
				// Cross-org imports remain drafts unless the destination matching flow resolves them.
				const _crossOrg = !!(
					t._meta.exportedFrom &&
					window.SF_ORG_ID &&
					t._meta.exportedFrom !== window.SF_ORG_ID
				);
				clearEmptyStarterCard();
				if (!merge) {
					deps.onCanvasReplace?.();
					// Replacing from a file creates a local canvas, not edits to the previous shared canvas.
					canvasState.currentCanvas = null;
					canvasState.selectedObjects = [];
					canvasState.selectedIdSeq = 1;
					canvasState.activeIndex = 0;
					canvasState.hiddenObjects.clear();
					canvasState.bulkRecords = [];
					canvasState.bulkAssociations = [];
					canvasState.bulkIdSeq = 1;
					canvasState.bulkSelectedIds = new Set();
					canvasState.bulkSelectedEdgeId = null;
					canvasState.bulkInitialized = false;
					canvasState._bulkUserDeleted = false;
					canvasState._lastBulkZoomSig = null;
					canvasState._bulkSeenIds = null;
					canvasState._prefetchedTypeNodeKeys.clear();
					canvasState._renderedRecIds.clear();
				}
				const idByIdx = [];
				for (let i = 0; i < t.schema.objects.length; i++) {
					const obj = t.schema.objects[i];
					const parentId = obj.addedFromIdx != null ? idByIdx[obj.addedFromIdx] : null;
					try {
						const entry = await addToSelection(
							obj.name,
							parentId,
							obj.addedVia || null,
							obj.worldPos || null,
						);
						idByIdx.push(entry.id);
					} catch (e) {
						console.warn('Template apply: failed to re-add', obj.name, e);
						idByIdx.push(null);
					}
				}
				let skippedRecords = 0;
				let reusedRecords = 0;
				let skippedAssoc = 0;
				let demotedToDrafts = 0;
				if (!schemaOnly) {
					const idMap = new Map();
					const _offY = _mergeOffsetY(
						merge,
						t.records.filter(_isRecordEntry).map((r) => Number(r.y) || 200),
					);
					t.records.forEach((r) => {
						if (!_isRecordEntry(r)) {
							skippedRecords += 1;
							return;
						}
						const key = merge && honorLoadedLinks && loadedKey(r);
						if (key && existingLoaded.has(key)) {
							idMap.set(String(r.id), existingLoaded.get(key));
							reusedRecords++;
							return;
						}
						const newId = canvasState.bulkIdSeq++;
						idMap.set(String(r.id), newId);
						if (key) existingLoaded.set(key, newId);
						const matchingSel = canvasState.selectedObjects.find((s) => s.name === r.objectName);
						const rec = {
							id: newId,
							objectName: r.objectName,
							label: (matchingSel && matchingSel.label) || r.label || r.objectName,
							x: _savedCoordinate(r.x, 200),
							y: _savedCoordinate(r.y, 200) + _offY,
							values: JSON.parse(JSON.stringify(_cleanValues(r.values))),
						};
						encryptedFields.hydrateIntents(rec, r.encryptedFieldIntents, canvasState);
						if (r.loadedFromId) {
							if (honorLoadedLinks) {
								rec.loadedFromId = r.loadedFromId;
								if (r.loadedValues && typeof r.loadedValues === 'object') {
									rec.loadedValues = Object.assign({}, r.loadedValues);
								}
								if (t._meta.recordData === 'snapshot-with-changes' && r.originalValues) {
									rec.loadedValues = { ...rec.values, ...r.originalValues };
								}
								if (r.pendingDelete) {
									rec.pendingDelete = true;
								}
							} else {
								demotedToDrafts += 1;
							}
						}
						if (r.slot && r.slot.slotId != null) {
							rec.slot = r.slot;
							_observeSlotId(r.slot.slotId);
						}
						canvasState.bulkRecords.push(rec);
					});
					const usedFk = new Set(canvasState.bulkAssociations.map((a) => a.fromId + '::' + a.fieldName));
					t.associations.forEach((a) => {
						const from = idMap.get(String(a && a.fromId));
						const to = idMap.get(String(a && a.toId));
						if (
							canvasState.bulkAssociations.some(
								(link) => link.fromId === from && link.toId === to && link.fieldName === a.fieldName,
							)
						)
							return;
						// A merge must not overwrite a reused card's locally edited lookup.
						const holder = canvasState.bulkRecords.find((r) => r.id === from);
						const target = canvasState.bulkRecords.find((r) => r.id === to);
						if (
							beforeImport.has(holder) &&
							(!target?.loadedFromId ||
								!holder.values?.[a.fieldName] ||
								String(holder.values[a.fieldName]).slice(0, 15) !==
									String(target.loadedFromId).slice(0, 15))
						) {
							skippedAssoc++;
							return;
						}
						if (!_admitAssociation(usedFk, from, to, a && a.fieldName)) {
							skippedAssoc += 1;
							return;
						}
						canvasState.bulkAssociations.push({
							id: canvasState.bulkIdSeq++,
							fromId: from,
							toId: to,
							fieldName: a.fieldName,
						});
					});
				}
				canvasState.bulkInitialized = true;
				canvasState.activeIndex = 0;
				if (typeof setGraphView === 'function') {
					setGraphView(schemaOnly ? 'schema' : 'bulk');
				}
				const importWarning = !schemaOnly
					? await checkImportedRecords(canvasState.bulkRecords.filter((record) => !beforeImport.has(record)))
					: '';
				renderAll();
				const _objectCount = (t.schema.objects || []).length;
				if (schemaOnly) {
					_summaryToast(
						'Imported schema: ' +
							_objectCount +
							' object' +
							(_objectCount === 1 ? '' : 's') +
							'. Records were not included.',
						undefined,
						opts,
					);
					if (opts.importFileName) {
						pingAuditEvent('canvas_load_file', {
							recordCount: 0,
							payload: {
								name: opts.importFileName || null,
								mode: merge ? 'merge' : 'replace',
								schemaOnly: true,
								objectCount: _objectCount,
							},
						});
					}
				} else {
					const totalRecords = t.records.length;
					const importedCount = totalRecords - skippedRecords - reusedRecords;
					let msg =
						'Imported ' +
						importedCount +
						' of ' +
						totalRecords +
						' record' +
						(totalRecords === 1 ? '' : 's') +
						'.';
					msg += _skipSuffix(skippedRecords, skippedAssoc);
					if (reusedRecords) msg += ' ' + reusedRecords + ' already on the canvas (kept unchanged).';
					if (demotedToDrafts > 0) {
						msg +=
							' ' +
							demotedToDrafts +
							' loaded record' +
							(demotedToDrafts === 1 ? '' : 's') +
							' re-imported as draft' +
							(demotedToDrafts === 1 ? '' : 's') +
							' (exported from a different org).';
					} else if (_crossOrg) {
						msg += ' Exported from a different org; Salesforce id references may not match here.';
					}
					const _caveats = skippedRecords > 0 || skippedAssoc > 0 || demotedToDrafts > 0 || _crossOrg;
					_summaryToast(
						msg + importWarning,
						importWarning ? 'warning' : _caveats ? 'error' : undefined,
						opts,
					);
					if (opts.importFileName) {
						pingAuditEvent('canvas_load_file', {
							recordCount: importedCount,
							payload: {
								name: opts.importFileName || null,
								mode: merge ? 'merge' : 'replace',
								schemaOnly: false,
								objectCount: _objectCount,
								skippedRecords,
								skippedAssoc,
							},
						});
					}
				}
			}

			async function applyCanvasPayload(payload, opts) {
				const sequenceFloor = Number(window.OrgLoom.platform?.requestSequenceFloor?.(payload));
				if (Number.isSafeInteger(sequenceFloor) && sequenceFloor > 0) {
					setSlotIdSeq(Math.max(getSlotIdSeq(), sequenceFloor));
				}
				opts = opts || {};
				const beforeImport = new Set(canvasState.bulkRecords);
				const merge = !!opts.merge;
				const loadingCanvasShareRole = opts.ownedByMe === false ? opts.recipientRole || 'viewer' : null;
				const loadingCanvasIdentity =
					opts.canvasIdentity && typeof opts.canvasIdentity === 'object'
						? Object.assign({}, opts.canvasIdentity)
						: null;
				if (!payload || typeof payload !== 'object') {
					showBulkToast('Empty payload: nothing to load.', 'error');
					return;
				}
				const schemaObjects = (payload.schema && payload.schema.objects) || [];
				const loadedRefs = Array.isArray(payload.loadedRecords) ? payload.loadedRecords : [];
				const drafts = Array.isArray(payload.drafts) ? payload.drafts : [];
				const hiddenRecords = Array.isArray(payload.hiddenRecords) ? payload.hiddenRecords : [];
				const associations = Array.isArray(payload.associations) ? payload.associations : [];
				const canvasRecordIds = _payloadCanvasRecordIds(loadedRefs, drafts);
				const recipientUsesSavedMetadata =
					loadingCanvasShareRole === 'viewer' || loadingCanvasShareRole === 'contributor';

				const incomingCount = loadedRefs.length + drafts.length + hiddenRecords.length;
				let _cap;
				if (merge) {
					_cap = canvasCapCheck(incomingCount);
				} else {
					const _probe = canvasCapCheck(incomingCount);
					_cap =
						incomingCount > _probe.cap
							? { blocked: true, reason: _probe.reason }
							: { blocked: false, reason: null };
				}
				if (_cap.blocked) {
					showBulkToast(_cap.reason, 'error');
					return;
				}
				canvasState._renderCanvasShareRole = loadingCanvasShareRole;
				clearEmptyStarterCard();
				if (!merge) {
					deps.onCanvasReplace?.();
					canvasState.selectedObjects = [];
					canvasState.selectedIdSeq = 1;
					canvasState.activeIndex = 0;
					canvasState.hiddenObjects.clear();
					canvasState.currentCanvas = loadingCanvasIdentity;
					if (window.Orgloom && window.Orgloom.canvasState && window.Orgloom.canvasState.clearDraft) {
						window.Orgloom.canvasState.clearDraft();
					}
					canvasState.bulkRecords = [];
					canvasState.bulkAssociations = [];
					canvasState.bulkIdSeq = 1;
					canvasState.bulkSelectedIds = new Set();
					canvasState.bulkSelectedEdgeId = null;
					canvasState.bulkInitialized = false;
					canvasState._bulkUserDeleted = false;
					canvasState._lastBulkZoomSig = null;
					canvasState._bulkSeenIds = null;
					canvasState._prefetchedTypeNodeKeys.clear();
					canvasState._renderedRecIds.clear();
					canvasState._autoSpawnedPending = true; // suppress auto-spawn after load
					canvasState.draftDescribeCache = {};
				}
				for (const object of schemaObjects) {
					if (!object || !object.name || !Array.isArray(object.draftFields)) {
						continue;
					}
					canvasState.draftDescribeCache[object.name] = {
						name: object.name,
						label: object.label || object.name,
						fields: object.draftFields.map((field) => Object.assign({}, field)),
						recordTypes: [],
						_canvasSnapshot: true,
					};
				}
				for (const draft of drafts) {
					if (!draft || !draft.objectName || canvasState.draftDescribeCache[draft.objectName]) {
						continue;
					}
					canvasState.draftDescribeCache[draft.objectName] = {
						name: draft.objectName,
						label: draft.objectName,
						fields: Object.keys(draft.values || {}).map((name) => ({
							name,
							label: name,
							type: 'string',
							createable: true,
							updateable: false,
						})),
						recordTypes: [],
						_canvasSnapshot: true,
					};
				}

				const idByIdx = [];
				for (let i = 0; i < schemaObjects.length; i++) {
					const obj = schemaObjects[i];
					const parentId = obj.addedFromIdx != null ? idByIdx[obj.addedFromIdx] : null;
					if (recipientUsesSavedMetadata) {
						const entry = {
							id: canvasState.selectedIdSeq++,
							name: obj.name,
							label: obj.label || obj.name,
							data: null,
							addedFrom: parentId != null ? parentId : null,
							addedVia: obj.addedVia || null,
							worldPos: obj.worldPos || { x: 0, y: i * 260 },
						};
						canvasState.selectedObjects.push(entry);
						canvasState.activeIndex = canvasState.selectedObjects.length - 1;
						idByIdx.push(entry.id);
						continue;
					}
					try {
						const entry = await addToSelection(
							obj.name,
							parentId,
							obj.addedVia || null,
							obj.worldPos || null,
						);
						idByIdx.push(entry.id);
					} catch (e) {
						console.warn('Canvas apply: failed to re-add', obj.name, e);
						idByIdx.push(null);
					}
				}

				const loadedById = new Map(); // loadedFromId → bulkId
				const slotById = new Map(); // slotId → bulkId
				let droppedFromAccess = 0;
				let skippedRecords = 0;
				const _offY = _mergeOffsetY(
					merge,
					loadedRefs
						.filter(_isRecordEntry)
						.map((r) => _savedCoordinate(r.y, 200))
						.concat(drafts.filter(_isRecordEntry).map((d) => _savedCoordinate(d.y, 200)))
						.concat(hiddenRecords.map((record) => _savedCoordinate(record && record.y, 200))),
				);
				const pushInaccessiblePlaceholder = (ref, isSlot) => {
					droppedFromAccess++;
					const hideMetadata = !!loadingCanvasShareRole;
					const matchingSel = hideMetadata
						? null
						: canvasState.selectedObjects.find((s) => s.name === ref.objectName);
					const newId = canvasState.bulkIdSeq++;
					if (ref.loadedFromId) {
						loadedById.set(ref.loadedFromId, newId);
					}
					const recObj = {
						id: newId,
						objectName: hideMetadata ? null : ref.objectName,
						label: hideMetadata
							? 'Hidden Salesforce content'
							: (matchingSel && matchingSel.label) || ref.objectName,
						fromSelectionId: matchingSel ? matchingSel.id : null,
						loadedFromId: hideMetadata ? null : ref.loadedFromId || null,
						x: _savedCoordinate(ref.x, 200),
						y: _savedCoordinate(ref.y, 200) + _offY,
						values: {},
						...(hideMetadata ? {} : { _canvasRecordId: canvasRecordIds.get(ref) }),
						_inaccessible: true,
						_permissionHidden: hideMetadata,
					};
					if (!hideMetadata && isSlot && ref.slot && ref.slot.slotId != null) {
						recObj.slot = _restoreSlot(ref.slot);
						slotById.set(ref.slot.slotId, newId);
						_observeSlotId(ref.slot.slotId);
					}
					canvasState.bulkRecords.push(recObj);
				};
				for (let hiddenIndex = 0; hiddenIndex < hiddenRecords.length; hiddenIndex++) {
					const hidden = hiddenRecords[hiddenIndex];
					if (!hidden || typeof hidden !== 'object') {
						continue;
					}
					droppedFromAccess++;
					canvasState.bulkRecords.push({
						id: -(hiddenIndex + 1),
						objectName: null,
						label: 'Hidden Salesforce content',
						x: _savedCoordinate(hidden.x, 200),
						y: _savedCoordinate(hidden.y, 200) + _offY,
						values: {},
						_inaccessible: true,
						_permissionHidden: true,
						_permissionHiddenId: hidden.hiddenId || 'hidden-' + (hiddenIndex + 1),
					});
				}
				const mergeExistingByKey = new Map();
				if (merge) {
					canvasState.bulkRecords.forEach((br) => {
						if (br.isTypeNode || !br.loadedFromId) {
							return;
						}
						mergeExistingByKey.set(br.objectName + '::' + br.loadedFromId, br.id);
					});
				}
				let skippedExistingMerge = 0;
				const _fetchJobs = [];
				for (const ref of loadedRefs) {
					if (!_isRecordEntry(ref)) {
						skippedRecords += 1;
						continue;
					}
					const isSlot = ref.slot && ref.slot.slotId != null;
					const hasLoadedId = !!ref.loadedFromId;
					if (merge && hasLoadedId) {
						const existingId = mergeExistingByKey.get(ref.objectName + '::' + ref.loadedFromId);
						if (existingId != null) {
							loadedById.set(ref.loadedFromId, existingId);
							skippedExistingMerge++;
							continue;
						}
					}
					if (isSlot && !hasLoadedId) {
						const matchingSel = canvasState.selectedObjects.find((s) => s.name === ref.objectName);
						const newId = canvasState.bulkIdSeq++;
						slotById.set(ref.slot.slotId, newId);
						_observeSlotId(ref.slot.slotId);
						canvasState.bulkRecords.push({
							id: newId,
							objectName: ref.objectName,
							label: (matchingSel && matchingSel.label) || ref.objectName,
							fromSelectionId: matchingSel ? matchingSel.id : null,
							x: _savedCoordinate(ref.x, 200),
							y: _savedCoordinate(ref.y, 200) + _offY,
							values: {},
							_canvasRecordId: canvasRecordIds.get(ref),
							slot: _restoreSlot(ref.slot),
							_recipientSlot: true,
						});
						continue;
					}
					_fetchJobs.push({ ref: ref, isSlot: isSlot });
				}
				const _fetchResults = new Array(_fetchJobs.length);
				{
					let _next = 0;
					const _fetchWorker = async () => {
						for (;;) {
							const idx = _next++;
							if (idx >= _fetchJobs.length) {
								return;
							}
							const job = _fetchJobs[idx];
							try {
								const r = await csrfFetch(
									'/api/objects/' +
										encodeURIComponent(job.ref.objectName) +
										'/records/' +
										encodeURIComponent(job.ref.loadedFromId),
									{ credentials: 'same-origin' },
								);
								_fetchResults[idx] = r.ok ? { ok: true, sf: await r.json() } : { ok: false };
							} catch (e) {
								_fetchResults[idx] = { ok: false };
							}
						}
					};
					await Promise.all(Array.from({ length: Math.min(6, _fetchJobs.length) }, _fetchWorker));
				}
				_fetchJobs.forEach((job, jobIdx) => {
					const ref = job.ref;
					const isSlot = job.isSlot;
					const _result = _fetchResults[jobIdx];
					if (!_result || !_result.ok) {
						pushInaccessiblePlaceholder(ref, isSlot);
						return;
					}
					const matchingSel = canvasState.selectedObjects.find((s) => s.name === ref.objectName);
					const newId = canvasState.bulkIdSeq++;
					loadedById.set(ref.loadedFromId, newId);
					const _fresh = _result.sf || {};
					const recObj = {
						id: newId,
						objectName: ref.objectName,
						label: (matchingSel && matchingSel.label) || ref.objectName,
						fromSelectionId: matchingSel ? matchingSel.id : null,
						loadedFromId: ref.loadedFromId,
						x: _savedCoordinate(ref.x, 200),
						y: _savedCoordinate(ref.y, 200) + _offY,
						_canvasRecordId: canvasRecordIds.get(ref),
						_uploadRecovery: uploadRecoveryMarker(ref.uploadRecovery),
						loadedValues: Object.assign({}, _fresh),
						values:
							ref.changes && typeof ref.changes === 'object'
								? Object.assign({}, _fresh, ref.changes)
								: _fresh,
					};
					encryptedFields.hydrateIntents(recObj, ref.encryptedFieldIntents, canvasState);
					if (ref.pendingDelete) {
						recObj.pendingDelete = true;
					}
					if (isSlot) {
						recObj.slot = _restoreSlot(ref.slot);
						if (recObj.slot.kind === 'fields') {
							if (!opts.ownedByMe) {
								recObj._recipientSlot = true;
							}
						}
						slotById.set(ref.slot.slotId, newId);
						_observeSlotId(ref.slot.slotId);
					}
					canvasState.bulkRecords.push(recObj);
				});

				const draftById = new Map(); // payload tempId → bulkId
				drafts.forEach((d) => {
					if (!_isRecordEntry(d)) {
						skippedRecords += 1;
						return;
					}
					const newId = canvasState.bulkIdSeq++;
					draftById.set(d.tempId, newId);
					const matchingSel = canvasState.selectedObjects.find((s) => s.name === d.objectName);
					const recObj = {
						id: newId,
						objectName: d.objectName,
						label: (matchingSel && matchingSel.label) || d.objectName,
						fromSelectionId: matchingSel ? matchingSel.id : null,
						x: _savedCoordinate(d.x, 200),
						y: _savedCoordinate(d.y, 200) + _offY,
						values: _cleanValues(d.values),
						_persistedTempId: d.tempId,
						_canvasRecordId: canvasRecordIds.get(d),
						_uploadRecovery: uploadRecoveryMarker(d.uploadRecovery),
					};
					encryptedFields.hydrateIntents(recObj, d.encryptedFieldIntents, canvasState);
					if (d.slot && d.slot.slotId != null) {
						recObj.slot = _restoreSlot(d.slot);
						slotById.set(d.slot.slotId, newId);
						_observeSlotId(d.slot.slotId);
						if (!opts.ownedByMe) {
							recObj._recipientSlot = true;
						}
					}
					canvasState.bulkRecords.push(recObj);
				});

				const resolveEndpoint = (e) => {
					if (!e) {
						return null;
					}
					if (e.kind === 'loaded') {
						return loadedById.get(e.ref);
					}
					if (e.kind === 'draft') {
						return draftById.get(e.ref);
					}
					if (e.kind === 'slot') {
						return slotById.get(e.ref);
					}
					return null;
				};
				const existingAssocKey = new Set();
				const usedFk = new Set();
				canvasState.bulkAssociations.forEach((a) => {
					if (merge) {
						existingAssocKey.add(a.fromId + '->' + a.toId + '::' + a.fieldName);
					}
					usedFk.add(a.fromId + '::' + a.fieldName);
				});
				let skippedAssoc = 0;
				associations.forEach((a) => {
					if (!a || typeof a !== 'object') {
						skippedAssoc += 1;
						return;
					}
					const fromId = resolveEndpoint(a.from);
					const toId = resolveEndpoint(a.to);
					if (loadingCanvasShareRole) {
						const fromRecord = canvasState.bulkRecords.find((record) => record && record.id === fromId);
						const toRecord = canvasState.bulkRecords.find((record) => record && record.id === toId);
						if ((fromRecord && fromRecord._inaccessible) || (toRecord && toRecord._inaccessible)) {
							skippedAssoc += 1;
							return;
						}
					}
					const key = fromId + '->' + toId + '::' + a.fieldName;
					if (merge && existingAssocKey.has(key)) {
						return;
					}
					if (!_admitAssociation(usedFk, fromId, toId, a.fieldName)) {
						skippedAssoc += 1;
						return;
					}
					canvasState.bulkAssociations.push({
						id: canvasState.bulkIdSeq++,
						fromId,
						toId,
						fieldName: a.fieldName,
					});
					if (merge) {
						existingAssocKey.add(key);
					}
				});

				canvasState.bulkInitialized = true;
				if (typeof setGraphView === 'function') {
					setGraphView('bulk');
				}
				const shouldPreflight = !recipientUsesSavedMetadata || loadingCanvasShareRole === 'contributor';
				if (shouldPreflight && loadingCanvasShareRole) {
					try {
						await _runSlotPreflight();
					} catch (error) {
						console.warn('slot preflight failed:', error);
					}
				}
				const importWarning = opts.importFileName
					? await checkImportedRecords(canvasState.bulkRecords.filter((record) => !beforeImport.has(record)))
					: '';
				renderAll();
				if (shouldPreflight && !loadingCanvasShareRole) {
					_runSlotPreflight().catch((e) => console.warn('slot preflight failed:', e));
				}
				let msg =
					'Loaded canvas: ' +
					loadedById.size +
					' existing record' +
					(loadedById.size === 1 ? '' : 's') +
					', ' +
					draftById.size +
					' draft' +
					(draftById.size === 1 ? '' : 's') +
					'.';
				if (droppedFromAccess > 0) {
					msg +=
						' (' +
						droppedFromAccess +
						' item' +
						(droppedFromAccess === 1 ? '' : 's') +
						' hidden by your Salesforce permissions.)';
				}
				if (skippedExistingMerge > 0) {
					msg +=
						' Skipped ' +
						skippedExistingMerge +
						' record' +
						(skippedExistingMerge === 1 ? '' : 's') +
						' already on the canvas.';
				}
				const _skips = _skipSuffix(skippedRecords, skippedAssoc);
				msg += _skips;
				const pendingEncrypted = canvasState.bulkRecords.flatMap((record) =>
					encryptedFields.unresolvedIntentNames(record, canvasState).map((fieldName) => {
						const describe = canvasState.describeCache && canvasState.describeCache[record.objectName];
						const field =
							describe && Array.isArray(describe.fields)
								? describe.fields.find((candidate) => candidate && candidate.name === fieldName)
								: null;
						return (record.label || record.objectName) + ' · ' + ((field && field.label) || fieldName);
					}),
				);
				if (pendingEncrypted.length > 0) {
					msg +=
						' Encrypted field changes without a replacement will be left unchanged on upload: ' +
						pendingEncrypted.slice(0, 4).join(', ') +
						(pendingEncrypted.length > 4 ? ', and ' + (pendingEncrypted.length - 4) + ' more.' : '.');
				}
				_summaryToast(msg + importWarning, importWarning ? 'warning' : _skips ? 'error' : undefined, opts);
				if (opts.importFileName) {
					pingAuditEvent('canvas_load_file', {
						recordCount: loadedById.size + draftById.size,
						payload: {
							name: opts.importFileName || null,
							mode: merge ? 'merge' : 'replace',
							shape: 'saved-canvas',
							loadedCount: loadedById.size,
							draftCount: draftById.size,
							droppedFromAccess,
							skippedExistingMerge,
							skippedRecords,
							skippedAssoc,
						},
					});
				}
			}

			function withCanvasLoad(apply) {
				return async function (payload, opts) {
					// Merges are intentional edits. Live snapshots have their own synchronization gate.
					const finish = opts && (opts.merge || opts.presenceSnapshot) ? null : deps.beginCanvasLoad?.();
					const finishImport = opts?.importFileName
						? deps.beginImportLoad?.(opts.merge ? 'Adding records to canvas…' : 'Loading canvas…')
						: null;
					let success = false;
					try {
						if (finish?.ready) await finish.ready;
						const result = await apply(payload, opts);
						success = true;
						return result;
					} finally {
						try {
							finish?.(success);
						} finally {
							finishImport?.();
						}
					}
				};
			}

			return {
				checkImportedRecords: checkImportedRecords,
				buildTemplate: buildTemplate,
				sanitizeFilename: sanitizeFilename,
				buildCanvasPayload: buildCanvasPayload,
				ensureDraftSlotMetadata: ensureDraftSlotMetadata,
				downloadTemplate: downloadTemplate,
				saveTemplateRemote: saveTemplateRemote,
				validateTemplate: validateTemplate,
				validateCanvasPayload: validateCanvasPayload,
				applyTemplate: withCanvasLoad(applyTemplate),
				applyCanvasPayload: withCanvasLoad(applyCanvasPayload),
			};
		},
	};
})();

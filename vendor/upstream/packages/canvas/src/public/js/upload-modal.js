(function () {
	'use strict';
	// Freezes a validated canvas snapshot, submits it, and reconciles only confirmed successes.

	window.OrgLoom = window.OrgLoom || {};
	function createUploadRecoveryJournal(storage, orgId, userId, newId) {
		const key = 'orgloom:upload-attempts:' + orgId + ':' + userId;
		const read = () => JSON.parse(storage.getItem(key) || '{}');
		const write = (entries) => storage.setItem(key, JSON.stringify(entries));
		const matches = (entry) => entry && entry.orgId === orgId;
		return {
			entries(records) {
				const saved = read();
				return records.flatMap((record) => {
					const entry = saved[record._canvasRecordId] || record._uploadRecovery;
					return matches(entry) ? [{ record, entry }] : [];
				});
			},
			track(records, attemptId) {
				const saved = read();
				for (const record of records) {
					if (!record._canvasRecordId) {
						record._canvasRecordId = newId();
					}
					const entry = { attemptId, tempId: record.id, orgId, userId };
					saved[record._canvasRecordId] = entry;
					record._uploadRecovery = entry;
				}
				// Deliberately do not swallow storage failures before a write is sent.
				write(saved);
			},
			clear(records) {
				const saved = read();
				for (const record of records) {
					delete saved[record._canvasRecordId];
					delete record._uploadRecovery;
				}
				write(saved);
			},
		};
	}
	const UPLOAD_SYSTEM_FIELDS = new Set([
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
		'MasterRecordId',
	]);

	function shouldStripUploadField(fieldName, knownFields) {
		// OwnerId is editable relationship data; write permissions are enforced by the upload backend.
		if (UPLOAD_SYSTEM_FIELDS.has(fieldName)) {
			return true;
		}
		// RecordTypeId is editable Salesforce data even when a reduced describe omits it.
		return fieldName !== 'RecordTypeId' && !knownFields.has(fieldName);
	}

	function hasUploadableRecordValue(record) {
		return Object.entries((record && record.values) || {}).some(
			([fieldName, value]) =>
				fieldName !== 'Id' &&
				fieldName !== 'attributes' &&
				!fieldName.startsWith('_') &&
				value != null &&
				value !== '',
		);
	}

	function uploadIneligibilityReason(record) {
		if (!record || typeof record !== 'object') {
			return 'not-a-record';
		}
		if (record.isTypeNode) {
			return 'schema-node';
		}
		if (record.isPending) {
			return 'loading-placeholder';
		}
		if (record._inaccessible) {
			return 'inaccessible-placeholder';
		}
		if (!record.objectName) {
			return 'not-a-record';
		}
		if (
			record.slot &&
			(record.slot.kind || 'whole-record') === 'whole-record' &&
			!record.loadedFromId &&
			!hasUploadableRecordValue(record)
		) {
			return 'unfinished-record-request';
		}
		return null;
	}

	function isUploadEligibleRecord(record) {
		return uploadIneligibilityReason(record) === null;
	}

	// Presentation only: group the scoped records without changing dependency order.
	function summarizeUploadRecords(records, skippedIds, deleteIds, describeCache) {
		const groups = new Map();
		for (const record of records) {
			if (!isUploadEligibleRecord(record) || skippedIds.has(record.id)) {
				continue;
			}
			let group = groups.get(record.objectName);
			if (!group) {
				group = {
					objectName: record.objectName,
					label: describeCache[record.objectName]?.label || record.objectName,
					creates: 0,
					updates: 0,
					upserts: 0,
					deletes: 0,
				};
				groups.set(record.objectName, group);
			}
			if (deleteIds.has(record.id)) {
				group.deletes += 1;
			} else if (record._csvOperation === 'upsert') {
				group.upserts += 1;
			} else if (record.loadedFromId) {
				group.updates += 1;
			} else {
				group.creates += 1;
			}
		}
		return Array.from(groups.values());
	}

	function recordAccessWriteReason(record, modified) {
		const access = record && record._recordAccess;
		if (!record || !record.loadedFromId || !access || access.checked !== true) {
			return null;
		}
		if (record.pendingDelete && access.hasDeleteAccess === false) {
			return 'no-delete-access';
		}
		if (!record.pendingDelete && modified && access.hasEditAccess === false) {
			return 'no-edit-access';
		}
		return null;
	}

	function cloneUploadValues(values) {
		try {
			return JSON.parse(JSON.stringify(values || {}));
		} catch (_error) {
			return Object.assign({}, values || {});
		}
	}

	function uploadValuesEquivalent(a, b) {
		if (a === b) {
			return true;
		}
		if (a && b && typeof a === 'object' && typeof b === 'object') {
			try {
				return JSON.stringify(a) === JSON.stringify(b);
			} catch (_error) {
				return false;
			}
		}
		const sa = a == null ? '' : String(a).trim();
		const sb = b == null ? '' : String(b).trim();
		if (sa === sb) {
			return true;
		}
		if (sa === '' || sb === '') {
			return false;
		}
		const na = Number(sa);
		const nb = Number(sb);
		if (!isNaN(na) && !isNaN(nb) && na === nb) {
			return true;
		}
		if (/\d{4}-\d{2}-\d{2}/.test(sa) && /\d{4}-\d{2}-\d{2}/.test(sb)) {
			const ta = Date.parse(sa);
			const tb = Date.parse(sb);
			if (!isNaN(ta) && !isNaN(tb) && ta === tb) {
				return true;
			}
		}
		return false;
	}

	function snapshotUploadRecords(records, canvasRecords, associations) {
		const snapshots = new Map();
		const canvasRecordById = new Map(
			(canvasRecords || []).filter((record) => record && record.id != null).map((record) => [record.id, record]),
		);
		for (const record of records || []) {
			if (!record || record.tempId == null) {
				continue;
			}
			const canvasRecord = canvasRecordById.get(record.tempId);
			snapshots.set(record.tempId, {
				loadedFromId: record.loadedFromId || null,
				values: cloneUploadValues(record.values),
				canvasValues: cloneUploadValues((canvasRecord && canvasRecord.values) || record.values),
				loadedValues: cloneUploadValues(record.loadedValues),
				associations:
					associations &&
					(associations || [])
						.filter((link) => link.fromId === record.tempId)
						.map((link) => ({ fieldName: link.fieldName, toId: link.toId })),
			});
		}
		return snapshots;
	}

	function reconcileSyncedRecords(records, synced, canonicalValues, submittedSnapshots, associations) {
		const realIdByTempId = new Map((synced || []).map((result) => [result.tempId, result.id]));
		const unchangedIds = new Set(
			(synced || []).filter((result) => result.mode === 'unchanged').map((result) => result.tempId),
		);
		const salesforceIdByCanvasRef = new Map();
		for (const [tempId, sfId] of realIdByTempId) {
			if (tempId != null && sfId) {
				salesforceIdByCanvasRef.set(String(tempId), sfId);
			}
		}
		for (const record of records || []) {
			if (record && record.id != null && record.loadedFromId) {
				salesforceIdByCanvasRef.set(String(record.id), record.loadedFromId);
			}
		}
		const canonicalMap = canonicalValues && typeof canonicalValues === 'object' ? canonicalValues : {};
		// Resolve the current canvas links, including links on children not included in this upload.
		for (const link of associations || []) {
			const child = (records || []).find((record) => record.id === link.fromId);
			const parentId = salesforceIdByCanvasRef.get(String(link.toId));
			if (child && link.fieldName && parentId) {
				child.values = child.values || {};
				const current = child.values[link.fieldName];
				const submitted =
					submittedSnapshots &&
					(typeof submittedSnapshots.get === 'function'
						? submittedSnapshots.get(child.id)
						: submittedSnapshots[child.id]);
				const original = submitted && (submitted.canvasValues || submitted.values || {})[link.fieldName];
				if ((current == null && original == null) || String(current) === String(link.toId))
					child.values[link.fieldName] = parentId;
			}
		}
		for (const record of records || []) {
			if (!record || !realIdByTempId.has(record.id)) {
				continue;
			}
			const wasDraft = !record.loadedFromId;
			const snapshot =
				submittedSnapshots && typeof submittedSnapshots.get === 'function'
					? submittedSnapshots.get(record.id)
					: submittedSnapshots && submittedSnapshots[record.id];
			if (wasDraft) {
				const draftRef =
					record._persistedTempId != null ? record._persistedTempId : record._collabId || record.id;
				const promotedFrom =
					record.slot && record.slot.slotId != null
						? {
								refKind: 'slot',
								ref: String(record.slot.slotId),
								...(draftRef != null ? { sourceRefKind: 'draft', sourceRef: String(draftRef) } : {}),
							}
						: draftRef != null
							? { refKind: 'draft', ref: String(draftRef) }
							: null;
				if (promotedFrom) {
					if (record._canvasRecordId != null) {
						promotedFrom.collabRef = String(record._canvasRecordId);
					}
					record._presencePromotedFrom = promotedFrom;
				}
			}
			// A successful upload fulfills any request attached to this record.
			if (!unchangedIds.has(record.id)) {
				delete record.slot;
				delete record._recipientSlot;
			}
			record.loadedFromId = realIdByTempId.get(record.id);
			record.values = record.values || {};
			record.values.Id = record.loadedFromId;
			const canonical = canonicalMap[record.id];
			if (!snapshot) {
				if (canonical && typeof canonical === 'object') {
					for (const fieldName of Object.keys(canonical)) {
						if (fieldName && !fieldName.startsWith('_')) {
							record.values[fieldName] = canonical[fieldName];
						}
					}
				}
				record.loadedValues = Object.assign({}, record.values);
				continue;
			}

			const submittedValues = snapshot.values || {};
			const submittedCanvasValues = snapshot.canvasValues || submittedValues;
			const submittedLoadedValues = snapshot.loadedValues || {};
			// New responses contain a complete retrieve snapshot; tolerate older in-flight responses too.
			const fullRefresh = canonical && Object.prototype.hasOwnProperty.call(canonical, 'Id');
			const nextLoadedValues = fullRefresh || wasDraft ? {} : cloneUploadValues(submittedLoadedValues);
			for (const fieldName of Object.keys(submittedValues)) {
				if (wasDraft || !uploadValuesEquivalent(submittedValues[fieldName], submittedLoadedValues[fieldName])) {
					const submittedValue = submittedValues[fieldName];
					const resolvedReference =
						submittedValue != null ? salesforceIdByCanvasRef.get(String(submittedValue)) : null;
					nextLoadedValues[fieldName] =
						resolvedReference && uploadValuesEquivalent(record.values[fieldName], resolvedReference)
							? resolvedReference
							: submittedValue;
				}
			}
			if (canonical && typeof canonical === 'object') {
				const unchangedSinceSubmit = (fieldName) => {
					const original = submittedCanvasValues[fieldName];
					const association = (associations || []).find(
						(link) => link.fromId === record.id && link.fieldName === fieldName,
					);
					const submittedAssociation =
						snapshot.associations && snapshot.associations.find((link) => link.fieldName === fieldName);
					if (snapshot.associations && submittedAssociation?.toId !== association?.toId) return false;
					const resolved =
						association &&
						(original == null || String(original) === String(association.toId)) &&
						salesforceIdByCanvasRef.get(String(association.toId));
					return (
						uploadValuesEquivalent(record.values[fieldName], original) ||
						(resolved && uploadValuesEquivalent(record.values[fieldName], resolved))
					);
				};
				if (fullRefresh) {
					for (const fieldName of Object.keys(nextLoadedValues)) delete nextLoadedValues[fieldName];
					for (const fieldName of Object.keys(record.values)) {
						if (
							!fieldName.startsWith('_') &&
							!Object.prototype.hasOwnProperty.call(canonical, fieldName) &&
							unchangedSinceSubmit(fieldName)
						) {
							delete record.values[fieldName];
						}
					}
				}
				for (const fieldName of Object.keys(canonical)) {
					if (fieldName && !fieldName.startsWith('_')) {
						nextLoadedValues[fieldName] = canonical[fieldName];
						if (fieldName === 'Id' || unchangedSinceSubmit(fieldName)) {
							record.values[fieldName] = canonical[fieldName];
						}
					}
				}
			}
			for (const association of fullRefresh ? [] : snapshot.associations || associations || []) {
				if (
					!association ||
					(!snapshot.associations && association.fromId !== record.id) ||
					!association.fieldName
				) {
					continue;
				}
				const parentSfId = salesforceIdByCanvasRef.get(String(association.toId));
				if (
					parentSfId &&
					(snapshot.associations || uploadValuesEquivalent(record.values[association.fieldName], parentSfId))
				) {
					nextLoadedValues[association.fieldName] = parentSfId;
				}
			}
			nextLoadedValues.Id = record.loadedFromId;
			record.loadedValues = nextLoadedValues;
		}
		// A server-side lookup change invalidates the old explicit link. The renderer derives
		// the replacement edge from the refreshed value if its target is on the canvas.
		for (let index = (associations || []).length - 1; index >= 0; index--) {
			const link = associations[index];
			const canonical = canonicalMap[link.fromId];
			if (!canonical || !Object.prototype.hasOwnProperty.call(canonical, 'Id')) continue;
			const child = (records || []).find((record) => record.id === link.fromId);
			const parentId = salesforceIdByCanvasRef.get(String(link.toId));
			const value = child && child.values && child.values[link.fieldName];
			if (
				parentId &&
				String(value) !== String(link.toId) &&
				String(value || '').slice(0, 15) !== String(parentId).slice(0, 15)
			)
				associations.splice(index, 1);
		}
		return realIdByTempId;
	}

	function postUploadRefreshWarning(synced, canonicalValues) {
		const missing = (synced || []).filter((row) => !canonicalValues || !canonicalValues[row.tempId]).length;
		return missing
			? missing +
					(missing === 1 ? ' record was' : ' records were') +
					' saved, but could not be refreshed from Salesforce. Use Refresh from Salesforce to see the latest values; do not upload again just to refresh.'
			: '';
	}

	function scopeUploadExclusions(records, selectedIds, selectedOnly) {
		return (records || [])
			.filter((record) => !selectedOnly || (selectedIds && selectedIds.has(record && record.id)))
			.map((record) => ({ record, reason: uploadIneligibilityReason(record) }))
			.filter((entry) => entry.reason && entry.reason !== 'schema-node' && entry.reason !== 'not-a-record');
	}

	function incompleteFieldRequests(records) {
		return (records || []).filter((record) => {
			if (
				!isUploadEligibleRecord(record) ||
				!record.slot ||
				record.slot.kind !== 'fields' ||
				!Array.isArray(record.slot.fields) ||
				record.slot.fields.length === 0
			) {
				return false;
			}
			const values = record.values || {};
			return record.slot.fields.some((fieldName) => values[fieldName] == null || values[fieldName] === '');
		});
	}

	function unresolvedEncryptedUploadIssue(record, field) {
		const canLeaveUnchanged = !!(record && record.loadedFromId);
		const canOmitOnCreate = !!(field && (!field.required || field.defaultedOnCreate));
		if (canLeaveUnchanged) {
			return {
				severity: 'warning',
				message:
					'No replacement is available in this tab. Org Loom will leave this Salesforce field unchanged if you continue.',
			};
		}
		if (canOmitOnCreate) {
			return {
				severity: 'warning',
				message:
					'No replacement is available in this tab. Org Loom will omit this field from the new record if you continue.',
			};
		}
		return {
			severity: 'error',
			message: 'Enter a value for this required encrypted field before creating the record.',
		};
	}

	function uploadExclusionSummary(exclusions) {
		const counts = new Map();
		(exclusions || []).forEach((entry) => {
			if (entry && entry.reason) {
				counts.set(entry.reason, (counts.get(entry.reason) || 0) + 1);
			}
		});
		const labels = {
			'unfinished-record-request': 'unfinished record request',
			'loading-placeholder': 'record still loading',
			'inaccessible-placeholder': 'unavailable record placeholder',
		};
		return Array.from(counts.entries())
			.filter(([reason]) => labels[reason])
			.map(([reason, count]) => count + ' ' + labels[reason] + (count === 1 ? '' : 's'));
	}

	function scopeUploadRecords(records, selectedIds, selectedOnly) {
		const real = (records || []).filter(isUploadEligibleRecord);
		if (!selectedOnly || !selectedIds || selectedIds.size === 0) {
			return real;
		}
		// "Selected only" is literal; related drafts are never silently added to the upload.
		return real.filter((r) => selectedIds.has(r.id));
	}

	function excludedDraftParentLinks(records, associations, scopedIds, _selectedOnly) {
		if (!scopedIds || scopedIds.size === 0) {
			return [];
		}
		const realById = new Map((records || []).filter((r) => r && !r.isTypeNode).map((r) => [r.id, r]));
		return (associations || []).filter((a) => {
			if (!a || !scopedIds.has(a.fromId) || scopedIds.has(a.toId)) {
				return false;
			}
			const parent = realById.get(a.toId);
			return !!(parent && !parent.loadedFromId);
		});
	}

	function scopeUploadAssociations(associations, scopedIds) {
		if (!scopedIds || scopedIds.size === 0) {
			return [];
		}
		return (associations || []).filter((a) => a && scopedIds.has(a.fromId) && scopedIds.has(a.toId));
	}

	function requiredExcludedDraftParentLinks(records, links, describeCache) {
		const realById = new Map((records || []).filter((r) => r && !r.isTypeNode).map((r) => [r.id, r]));
		return (links || []).filter((link) => {
			const child = realById.get(link.fromId);
			if (!child || child.loadedFromId) {
				return false;
			}
			const describe = describeCache && describeCache[child.objectName];
			const field =
				describe && Array.isArray(describe.fields)
					? describe.fields.find((f) => f && f.name === link.fieldName)
					: null;
			return !!(
				field &&
				field.type === 'reference' &&
				field.createable !== false &&
				field.required &&
				!field.defaultedOnCreate
			);
		});
	}

	function scopeUploadValues(record, values, excludedDraftLinks) {
		const scopedValues = Object.assign({}, values || {});
		if (!record) {
			return scopedValues;
		}
		(excludedDraftLinks || []).forEach((link) => {
			if (link && link.fromId === record.id && link.fieldName) {
				delete scopedValues[link.fieldName];
			}
		});
		return scopedValues;
	}

	function formatUploadProgress(records, describeCache) {
		const uploading = (records || []).filter(isUploadEligibleRecord);
		const count = uploading.length;
		if (count === 0) {
			return 'Uploading…';
		}

		const objectNames = new Set(uploading.map((record) => record.objectName).filter(Boolean));
		if (objectNames.size !== 1) {
			return 'Uploading ' + count + ' records…';
		}

		const objectName = Array.from(objectNames)[0];
		const describe = describeCache && describeCache[objectName];
		const objectLabel =
			count === 1
				? (describe && describe.label) || objectName
				: (describe && describe.labelPlural) ||
					(describe && describe.label ? describe.label + 's' : objectName + 's');
		return 'Uploading ' + count + ' ' + objectLabel + '…';
	}

	function describeLoadFailureSummary(failures, missingDescribes) {
		const failed = Array.isArray(failures) ? failures : [];
		const missing = Array.from(missingDescribes || []).filter(Boolean);
		const connectionFailure = failed.some(
			(failure) => failure && (failure.code === 'no-active-connection' || failure.code === 'sf-session-expired'),
		);
		if (connectionFailure) {
			return {
				kind: 'connection',
				heading: 'Salesforce needs to be reconnected.',
				message:
					'Org Loom could not use its Salesforce connection to check these records. Reconnect Salesforce, then reopen Upload.',
				action: 'Reconnect Salesforce',
			};
		}
		return {
			kind: 'retry',
			heading: 'Salesforce field information could not be loaded.',
			message:
				'Org Loom could not pre-flight check ' +
				(missing.length > 0 ? missing.join(', ') : 'these records') +
				'. Retry the check before uploading. If it continues, reconnect Salesforce.',
			action: 'Retry pre-flight checks',
		};
	}

	function approvalRequiredMessage(body) {
		if (body && body.message) {
			return body.message;
		}
		if (body && body.approvalStatus === 'pending') {
			return 'Org Loom automatically created an access request for this Salesforce org. Any workspace admin can approve it in Workspace settings. After approval, retry this action.';
		}
		return 'This Salesforce org requires workspace approval. Any workspace admin can review and approve access in Workspace settings, then you can retry this action.';
	}

	function uploadResultIdentity(
		result,
		records,
		describeCache,
		canonicalValues,
		submittedSnapshots,
		ordinalForRecord,
	) {
		const resultKey = result && result.tempId;
		const resultSfId = result && (result.id || result.sfId);
		const record = (records || []).find(
			(candidate) =>
				candidate &&
				((resultKey != null && String(candidate.id) === String(resultKey)) ||
					(resultSfId && candidate.loadedFromId && String(candidate.loadedFromId) === String(resultSfId))),
		);
		const objectName = (result && result.objectName) || (record && record.objectName) || 'Record';
		const describe = describeCache && describeCache[objectName];
		const objectLabel = (describe && describe.label) || (record && record.label) || objectName;
		const snapshot =
			resultKey != null && submittedSnapshots && typeof submittedSnapshots.get === 'function'
				? submittedSnapshots.get(resultKey)
				: resultKey != null && submittedSnapshots
					? submittedSnapshots[resultKey]
					: null;
		const canonical =
			resultKey != null && canonicalValues && typeof canonicalValues === 'object'
				? canonicalValues[resultKey]
				: null;
		const values = Object.assign(
			{},
			(record && record.values) || {},
			(snapshot && (snapshot.canvasValues || snapshot.values)) || {},
			canonical && typeof canonical === 'object' ? canonical : {},
		);
		const fullName = ((values.FirstName || '') + ' ' + (values.LastName || '')).trim();
		const nameField =
			describe && Array.isArray(describe.fields)
				? describe.fields.find((field) => field && field.nameField)
				: null;
		const displayName =
			fullName ||
			(nameField && values[nameField.name]) ||
			values.Name ||
			values.CaseNumber ||
			values.OrderNumber ||
			values.WorkOrderNumber ||
			values.Subject ||
			values.Title;
		let cardNumber = null;
		if (!displayName && record && typeof ordinalForRecord === 'function') {
			try {
				cardNumber = ordinalForRecord(record);
			} catch (_error) {}
		}
		return {
			name: displayName ? String(displayName) : 'Unnamed ' + objectLabel,
			objectLabel: String(objectLabel),
			cardNumber: cardNumber == null ? null : String(cardNumber),
		};
	}

	function isRolledBackUploadResult(result) {
		return (
			!!result &&
			(result.errorCode === 'ALL_OR_NONE_OPERATION_ROLLED_BACK' ||
				/^The transaction was rolled back since another operation in the same transaction failed\.?$/i.test(
					String(result.error || '').trim(),
				))
		);
	}

	window.OrgLoom.uploadModal = {
		isRolledBackUploadResult,
		summarizeUploadRecords,
		uploadIneligibilityReason: uploadIneligibilityReason,
		isUploadEligibleRecord: isUploadEligibleRecord,
		recordAccessWriteReason: recordAccessWriteReason,
		reconcileSyncedRecords: reconcileSyncedRecords,
		snapshotUploadRecords: snapshotUploadRecords,
		createUploadRecoveryJournal: createUploadRecoveryJournal,
		scopeUploadExclusions: scopeUploadExclusions,
		incompleteFieldRequests: incompleteFieldRequests,
		unresolvedEncryptedUploadIssue: unresolvedEncryptedUploadIssue,
		uploadExclusionSummary: uploadExclusionSummary,
		scopeUploadRecords: scopeUploadRecords,
		excludedDraftParentLinks: excludedDraftParentLinks,
		scopeUploadAssociations: scopeUploadAssociations,
		requiredExcludedDraftParentLinks: requiredExcludedDraftParentLinks,
		scopeUploadValues: scopeUploadValues,
		postUploadRefreshWarning: postUploadRefreshWarning,
		formatUploadProgress: formatUploadProgress,
		describeLoadFailureSummary: describeLoadFailureSummary,
		approvalRequiredMessage: approvalRequiredMessage,
		uploadResultIdentity: uploadResultIdentity,
		shouldStripUploadField: shouldStripUploadField,
		mount: function mount(deps) {
			const required = [
				'canvasState',
				'csrfFetch',
				'escapeHtml',
				'showBulkToast',
				'showConfirmDialog',
				'showBulkSwitchWarning',
				'validateBulkRecords',
				'computeUploadOrder',
				'isRecordModified',
				'isRecordPendingDelete',
				'recordOrdinal',
				'renderBulkView',
				'startElapsedTicker',
				'ensureDescribe',
				'getMeInfo',
			];
			if (!deps) {
				throw new Error('upload-modal.mount: missing deps object');
			}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('upload-modal.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			const safeLoginHref = (u) => {
				if (typeof u === 'string' && /^\/(?![/\\])/.test(u)) {
					return escapeHtml(u);
				}
				return '/auth/login';
			};
			const showBulkToast = deps.showBulkToast;
			const showConfirmDialog = deps.showConfirmDialog;
			const showBulkSwitchWarning = deps.showBulkSwitchWarning;
			const validateBulkRecords = deps.validateBulkRecords;
			const computeUploadOrder = deps.computeUploadOrder;
			const isRecordModified = deps.isRecordModified;
			const isRecordPendingDelete = deps.isRecordPendingDelete;
			const recordOrdinal = deps.recordOrdinal;
			const renderBulkView = deps.renderBulkView;
			const startElapsedTicker = deps.startElapsedTicker;
			const ensureDescribe = deps.ensureDescribe;
			const getMeInfo = deps.getMeInfo;
			const encryptedFields = window.OrgLoom && window.OrgLoom.encryptedFields;
			if (!encryptedFields) {
				throw new Error('encrypted-fields.js must load before upload-modal.js');
			}
			const publishPresenceChanges =
				typeof deps.publishPresenceChanges === 'function' ? deps.publishPresenceChanges : function () {};
			const flushAutosave = typeof deps.flushAutosave === 'function' ? deps.flushAutosave : function () {};
			const pingAuditEvent = typeof deps.pingAuditEvent === 'function' ? deps.pingAuditEvent : function () {};
			const markCanvasGuideUploadComplete =
				typeof deps.markCanvasGuideUploadComplete === 'function'
					? deps.markCanvasGuideUploadComplete
					: function () {};

			let _describeLoadFailures = [];
			let _recordAccessLoadFailure = null;
			let _recordAccessSignature = null;

			function _accessSignature(records) {
				return (records || [])
					.filter((record) => record && record.loadedFromId)
					.map((record) => {
						const access = record._recordAccess || {};
						return [
							record.loadedFromId,
							access.checked === true ? '1' : '0',
							access.hasEditAccess === true ? '1' : '0',
							access.hasDeleteAccess === true ? '1' : '0',
						].join(':');
					})
					.sort()
					.join('|');
			}

			async function _refreshRecordAccess(records) {
				const loaded = (records || []).filter((record) => record && record.loadedFromId);
				for (let offset = 0; offset < loaded.length; offset += 200) {
					const chunk = loaded.slice(offset, offset + 200);
					const response = await csrfFetch('/api/records/access', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							records: chunk.map((record) => ({ tempId: record.id, sfId: record.loadedFromId })),
						}),
						credentials: 'same-origin',
					});
					const body = await response.json().catch(() => ({}));
					if (!response.ok || !Array.isArray(body.results)) {
						throw new Error(
							(body && (body.message || body.error)) ||
								'Org Loom could not verify Salesforce record access.',
						);
					}
					const byTempId = new Map(body.results.map((result) => [String(result.tempId), result.access]));
					for (const record of chunk) {
						const access = byTempId.get(String(record.id));
						if (!access || access.checked !== true) {
							throw new Error('Org Loom could not verify Salesforce record access.');
						}
						Object.defineProperty(record, '_recordAccess', {
							value: access,
							writable: true,
							configurable: true,
						});
						Object.defineProperty(record, '_recordAccessCheckedAt', {
							value: Date.now(),
							writable: true,
							configurable: true,
						});
					}
				}
				_recordAccessLoadFailure = null;
				return _accessSignature(loaded);
			}

			function _recordAccessExclusions(records) {
				return (records || [])
					.map((record) => ({ record, reason: recordAccessWriteReason(record, isRecordModified(record)) }))
					.filter((entry) => entry.reason);
			}
			const uploadModal = document.createElement('div');
			uploadModal.className = 'modal hidden';
			uploadModal.innerHTML =
				'<div class="modal-overlay"></div>' +
				'<div class="modal-body">' +
				'<div class="modal-header">' +
				'<div class="upload-modal-heading"><h3 id="upload-modal-title">Upload records to Salesforce</h3>' +
				'<div id="upload-result-summary" class="upload-result-summary" hidden></div></div>' +
				'<button class="modal-close" data-upload-close>&times;</button>' +
				'</div>' +
				'<div class="modal-content" id="upload-modal-content"></div>' +
				'<div class="modal-footer">' +
				'<button class="button secondary" id="upload-cancel" data-upload-close>Cancel</button>' +
				'<span class="upload-confirm-tip" id="upload-confirm-tip">' +
				'<button class="button" id="upload-confirm">Upload</button>' +
				'</span>' +
				'</div>' +
				'</div>';
			document.body.appendChild(uploadModal);
			const _fixTasks = window.OrgLoom.uploadFixesSidebar.mount({
				canvasState,
				escapeHtml,
				getContext: () => ({
					canvas: canvasState.currentCanvas?.id || null,
					connection: JSON.stringify([
						window.SF_ORG_ID,
						window.SF_USER_ID,
						getMeInfo()?.connection?.id,
						getMeInfo()?.workspace?.id,
					]),
				}),
				validateLocal: (recordIds) => _renderUploadModalSummary({ checkOnly: true, recordIds }),
				hasUnsubmittedChanges: (record) => isRecordModified(record),
				openRecord: (record, options) => deps.openRecordForCurrentUser(record, options),
				recordTitle: (record) => {
					const identity = uploadResultIdentity(
						{ tempId: record.id, objectName: record.objectName },
						canvasState.bulkRecords,
						canvasState.describeCache,
						null,
						null,
						recordOrdinal,
					);
					return identity.objectLabel + ' · ' + identity.name;
				},
				onChange: () => renderBulkView(),
				onDismiss: (recordId, fields) => deps.updateUploadFixFields?.(recordId, fields),
			});
			uploadModal
				.querySelectorAll('[data-upload-close]')
				.forEach((el) => el.addEventListener('click', closeUploadModal));
			document.addEventListener('keydown', (e) => {
				if (e.key === 'Escape' && !uploadModal.classList.contains('hidden')) {
					closeUploadModal();
				}
			});
			uploadModal.querySelector('#upload-confirm').onclick = confirmUpload;

			function renderApprovalRequired(contentEl, confirmBtn, body) {
				_uploadAttemptId = null;
				clearUploadPermissionLock(confirmBtn);
				contentEl.innerHTML =
					'<div class="banner error"><strong>Salesforce org is not allowed.</strong> ' +
					escapeHtml(
						(body && body.message) ||
							'Ask a workspace administrator to add this org in Workspace settings.',
					) +
					'</div><p class="tag center">No Salesforce records were written.</p>';
				confirmBtn.disabled = false;
				confirmBtn.textContent = 'Retry';
			}

			function isOrgAccessBlocked(body) {
				return !!(body && (body.error === 'org-not-allowed' || body.error === 'approval-required'));
			}

			function isUploadPermissionDenied(body) {
				return !!(
					body &&
					body.capability === 'upload-records' &&
					(body.error === 'member-grant-required' || body.error === 'permission-denied')
				);
			}

			function renderUploadPermissionRequired(contentEl, confirmBtn, body) {
				_uploadAttemptId = null;
				const message =
					(body && body.message) || 'Ask a workspace admin to grant you the Upload to Salesforce permission.';
				contentEl.innerHTML =
					'<div class="banner error"><strong>Upload permission required.</strong> ' +
					escapeHtml(message) +
					'</div><p class="tag center">No Salesforce records were written.</p>';
				lockUploadConfirmButton(confirmBtn, message);
			}

			function lockUploadConfirmButton(confirmBtn, message) {
				const tip = uploadModal.querySelector('#upload-confirm-tip');
				const title = message || 'Ask a workspace admin to grant you the Upload to Salesforce permission.';
				confirmBtn.disabled = true;
				confirmBtn.innerHTML = '<span aria-hidden="true">🔒</span> Upload unavailable';
				confirmBtn.onclick = null;
				if (tip) {
					tip.classList.add('is-locked');
					tip.setAttribute('tabindex', '0');
					tip.setAttribute('title', title);
					tip.setAttribute('aria-label', 'Upload unavailable. ' + title);
				}
			}

			function clearUploadPermissionLock() {
				const tip = uploadModal.querySelector('#upload-confirm-tip');
				if (!tip) {
					return;
				}
				tip.classList.remove('is-locked');
				tip.removeAttribute('tabindex');
				tip.removeAttribute('title');
				tip.removeAttribute('aria-label');
			}

			function renderActiveOrgChanged(contentEl, confirmBtn, body) {
				_uploadAttemptId = null;
				clearUploadPermissionLock();
				contentEl.innerHTML =
					'<div class="banner error"><strong>Salesforce org changed.</strong> ' +
					escapeHtml(
						(body && body.message) ||
							'Nothing was uploaded. Reconnect to the intended Salesforce org, then reopen this upload.',
					) +
					'</div>';
				confirmBtn.disabled = true;
				confirmBtn.textContent = 'Upload';
			}

			function baselineValue(value) {
				if (value == null || value === '') {
					return 'blank';
				}
				const text = typeof value === 'string' ? value : JSON.stringify(value);
				return String(text == null ? value : text).slice(0, 240);
			}

			function renderBaselineConflicts(contentEl, confirmBtn, body) {
				const conflicts = Array.isArray(body && body.conflicts) ? body.conflicts : [];
				const sfBase = String(window.SF_INSTANCE_URL || '').replace(/\/+$/, '');
				_baselineConfirmations = conflicts.map((record) => ({
					sfId: record.sfId,
					fields: (record.fields || []).map((field) => ({
						fieldName: field.fieldName,
						expectedCurrent: field.current == null ? null : field.current,
					})),
				}));
				const recordHtml = conflicts
					.map((record) => {
						const describe = canvasState.describeCache && canvasState.describeCache[record.objectName];
						const recordUrl =
							sfBase && record.objectName && record.sfId
								? sfBase +
									'/lightning/r/' +
									encodeURIComponent(record.objectName) +
									'/' +
									encodeURIComponent(record.sfId) +
									'/view'
								: null;
						const fieldsByName = new Map(
							((describe && describe.fields) || []).map((field) => [field.name, field]),
						);
						const fieldHtml = (record.fields || [])
							.map((field) => {
								const described = fieldsByName.get(field.fieldName);
								const label = (described && described.label) || field.fieldName;
								return (
									'<div class="upload-conflict-field">' +
									'<div class="upload-conflict-field-name"><strong>' +
									escapeHtml(label) +
									'</strong><span class="tag">' +
									escapeHtml(field.fieldName) +
									'</span></div>' +
									'<div class="upload-conflict-values">' +
									'<div class="upload-conflict-value"><span class="upload-conflict-value-label">Value when loaded</span><code>' +
									escapeHtml(baselineValue(field.loaded)) +
									'</code></div>' +
									'<div class="upload-conflict-value"><span class="upload-conflict-value-label">Current Salesforce value</span><code>' +
									escapeHtml(baselineValue(field.current)) +
									'</code></div>' +
									'<div class="upload-conflict-value upload-conflict-value--after"><span class="upload-conflict-value-label">Value after upload</span><code>' +
									escapeHtml(baselineValue(field.canvas)) +
									'</code></div>' +
									'</div></div>'
								);
							})
							.join('');
						return (
							'<div class="upload-conflict-record"><div class="upload-conflict-record-head">' +
							uploadResultIdentityHtml(
								{ tempId: record.tempId, sfId: record.sfId, objectName: record.objectName },
								null,
								null,
								record.label || record.objectName || 'Record',
							) +
							(recordUrl
								? '<a class="upload-result-link" href="' +
									escapeHtml(recordUrl) +
									'" target="_blank" rel="noopener">View in Salesforce</a>'
								: '') +
							'</div><div class="upload-conflict-fields">' +
							fieldHtml +
							'</div></div>'
						);
					})
					.join('');
				contentEl.innerHTML =
					'<div class="banner warning upload-conflict-banner"><strong>Salesforce changed since this canvas was loaded.</strong></div>' +
					'<div class="upload-conflict-list">' +
					recordHtml +
					'</div>';
				confirmBtn.disabled = false;
				confirmBtn.textContent = 'Upload anyway';
				confirmBtn.classList.add('confirm-anyway');
				confirmBtn.onclick = confirmUpload;
			}

			async function openUploadModal(opts) {
				resetSampleFailureActions();
				uploadModal.querySelector('#upload-result-summary').hidden = true;
				if (canvasState.bulkRecords.length === 0) {
					showBulkToast('No records to upload.');
					return;
				}
				_bulkSwitchAcknowledged = false;
				_baselineConfirmations = [];
				_accessExcludedTempIds = new Set();
				const _allCanvasRecordCount = canvasState.bulkRecords.filter(
					(r) => r && !r.isTypeNode && !r.isPending,
				).length;
				const _selectedCanvasRecordCount = canvasState.bulkRecords.filter(
					(r) => r && !r.isTypeNode && !r.isPending && canvasState.bulkSelectedIds.has(r.id),
				).length;
				const _wantSelected =
					opts &&
					opts.initialScope === 'selected' &&
					_selectedCanvasRecordCount > 0 &&
					_selectedCanvasRecordCount < _allCanvasRecordCount;
				_uploadScopeSelected = !!_wantSelected;
				const confirmBtn = uploadModal.querySelector('#upload-confirm');
				clearUploadPermissionLock();
				confirmBtn.disabled = false;
				confirmBtn.textContent = 'Upload';
				confirmBtn.classList.remove('confirm-anyway');
				confirmBtn.style.display = '';
				confirmBtn.onclick = confirmUpload;
				const cancelBtn = uploadModal.querySelector('#upload-cancel');
				if (cancelBtn) {
					cancelBtn.style.display = '';
					cancelBtn.textContent = 'Cancel';
				}

				const content = uploadModal.querySelector('#upload-modal-content');
				content.innerHTML = '<p class="center tag">Running pre-flight checks\u2026</p>';
				uploadModal.classList.remove('hidden');
				confirmBtn.disabled = true;
				try {
					if (await recoverPendingUploads(_scopedRealRecords())) {
						return;
					}
				} catch (_) {
					renderAttemptIncomplete({
						message: 'Upload recovery could not be checked. Please reconnect and try again.',
					});
					return;
				}
				confirmBtn.disabled = false;
				const uniqObjs = Array.from(
					new Set(
						_scopedRealRecords()
							.filter((record) => record.objectName)
							.map((record) => record.objectName),
					),
				);
				_describeLoadFailures = (
					await Promise.all(
						uniqObjs.map(async (name) => {
							try {
								await ensureDescribe(name);
								return null;
							} catch (error) {
								return {
									name,
									code: error && error.code,
									status: error && error.status,
								};
							}
						}),
					)
				).filter(Boolean);
				_recordAccessLoadFailure = null;
				try {
					_recordAccessSignature = await _refreshRecordAccess(canvasState.bulkRecords);
					renderBulkView();
				} catch (error) {
					_recordAccessLoadFailure = error;
					_recordAccessSignature = null;
				}

				_renderUploadModalSummary();
			}

			function _renderUploadModalSummary(options = {}) {
				if (!options.checkOnly) {
					resetSampleFailureActions();
				}
				const content = uploadModal.querySelector('#upload-modal-content');
				if (!content) {
					return;
				}
				const confirmBtn = uploadModal.querySelector('#upload-confirm');
				const cancelBtn = uploadModal.querySelector('#upload-cancel');

				const allCanvasRecords = canvasState.bulkRecords.filter((r) => r && !r.isTypeNode && !r.isPending);
				const selectedCanvasRecordCount = allCanvasRecords.filter((r) =>
					canvasState.bulkSelectedIds.has(r.id),
				).length;
				const canScope = selectedCanvasRecordCount > 0 && selectedCanvasRecordCount < allCanvasRecords.length;
				if (!options.checkOnly && !canScope) {
					_uploadScopeSelected = false;
				}
				const scopedRecords = options.recordIds
					? canvasState.bulkRecords.filter(
							(record) => options.recordIds.has(record.id) && isUploadEligibleRecord(record),
						)
					: _scopedRealRecords();
				const accessExclusions = _recordAccessExclusions(scopedRecords);
				const accessExcludedIds = new Set(accessExclusions.map((entry) => entry.record.id));
				const scopedExclusions = scopeUploadExclusions(
					canvasState.bulkRecords,
					canvasState.bulkSelectedIds,
					_uploadScopeSelected,
				);
				const scopedIds = new Set(scopedRecords.map((r) => r.id));
				const excludedDraftLinks = options.checkOnly
					? excludedDraftParentLinks(canvasState.bulkRecords, canvasState.bulkAssociations, scopedIds, true)
					: _scopedExcludedDraftParentLinks();
				const requiredExcludedDraftLinks = requiredExcludedDraftParentLinks(
					canvasState.bulkRecords,
					excludedDraftLinks,
					canvasState.describeCache,
				);
				const optionalExcludedDraftLinkCount = excludedDraftLinks.length - requiredExcludedDraftLinks.length;

				const _mig = window.Orgloom && window.Orgloom.canvasMigrate;
				const _migActive = !!(_mig && _mig.isActive());
				const migrateBanner = _migActive
					? '<div class="preflight has-warnings">' +
						'<span class="pf-icon">i</span>' +
						'<span class="pf-msg"><strong>Apply the migration first.</strong> Review the plan to turn its choices into normal canvas records before uploading. ' +
						'<button type="button" class="link-button" data-migrate-review>Review and apply…</button>' +
						'</span></div>'
					: '';

				const {
					issues: rawIssues,
					byRecordId: rawByRecordId,
					missingDescribes: allMissingDescribes,
				} = validateBulkRecords();
				// The shared validator checks the whole canvas; metadata blockers must match this upload's scope.
				const scopedObjectNames = new Set(scopedRecords.map((record) => record.objectName));
				const missingDescribes = new Set(
					[...allMissingDescribes].filter((name) => scopedObjectNames.has(name)),
				);
				const resolvedByEncryptedProposal = (issue) => {
					const record =
						issue && canvasState.bulkRecords.find((candidate) => candidate.id === issue.recordId);
					if (!record || !issue.field || !encryptedFields.hasProposal(record, issue.field)) {
						return false;
					}
					const value = encryptedFields.proposal(record, issue.field);
					return value != null && String(value) !== '';
				};
				const issues = rawIssues.filter(
					(issue) =>
						!resolvedByEncryptedProposal(issue) &&
						(!issue.recordId || (scopedIds.has(issue.recordId) && !accessExcludedIds.has(issue.recordId))),
				);
				const byRecordId = new Map();
				rawByRecordId.forEach((rIssues, rid) => {
					if (scopedIds.has(rid) && !accessExcludedIds.has(rid)) {
						byRecordId.set(
							rid,
							rIssues.filter((issue) => !resolvedByEncryptedProposal(issue)),
						);
					}
				});
				scopedRecords.forEach((record) => {
					if (!record || accessExcludedIds.has(record.id)) {
						return;
					}
					const describe = canvasState.describeCache && canvasState.describeCache[record.objectName];
					for (const fieldName of encryptedFields.unresolvedIntentNames(record, canvasState)) {
						const field =
							describe && Array.isArray(describe.fields)
								? describe.fields.find((candidate) => candidate && candidate.name === fieldName)
								: null;
						const unresolvedIssue = unresolvedEncryptedUploadIssue(record, field);
						const recordIssues = byRecordId.get(record.id) || [];
						if (
							unresolvedIssue.severity === 'error' &&
							recordIssues.some(
								(candidate) =>
									candidate && candidate.field === fieldName && candidate.severity === 'error',
							)
						) {
							continue;
						}
						const issue = {
							recordId: record.id,
							objectName: record.objectName,
							recordLabel: (record.label || record.objectName) + ' #' + recordOrdinal(record),
							field: fieldName,
							fieldLabel: (field && field.label) || fieldName,
							severity: unresolvedIssue.severity,
							message: unresolvedIssue.message,
						};
						issues.push(issue);
						recordIssues.push(issue);
						byRecordId.set(record.id, recordIssues);
					}
				});
				requiredExcludedDraftLinks.forEach((link) => {
					const rec = scopedRecords.find((r) => r.id === link.fromId);
					if (!rec || accessExcludedIds.has(rec.id)) {
						return;
					}
					const describe = canvasState.describeCache[rec.objectName];
					const field =
						describe && Array.isArray(describe.fields)
							? describe.fields.find((f) => f && f.name === link.fieldName)
							: null;
					const issue = {
						recordId: rec.id,
						objectName: rec.objectName,
						recordLabel: (rec.label || rec.objectName) + ' #' + recordOrdinal(rec),
						field: link.fieldName,
						fieldLabel: (field && field.label) || link.fieldName,
						severity: 'error',
						message:
							'This required relationship points to an unselected draft and won’t be included. Select the related draft too.',
					};
					issues.push(issue);
					const recordIssues = byRecordId.get(rec.id) || [];
					recordIssues.push(issue);
					byRecordId.set(rec.id, recordIssues);
				});
				const errorCount = issues.filter((i) => i.severity === 'error').length;
				const warningCount = issues.filter((i) => i.severity === 'warning').length;

				const realRecordsForCount = scopedRecords;
				const deleteIdSet = new Set(
					realRecordsForCount
						.filter((record) => isRecordPendingDelete(record) && !accessExcludedIds.has(record.id))
						.map((record) => record.id),
				);
				const unchangedTempIds = realRecordsForCount
					.filter((r) => r.loadedFromId && !isRecordModified(r) && !r.pendingDelete)
					.map((r) => r.id);
				const unchangedOnlySet = new Set(unchangedTempIds);
				const unchangedSet = new Set(unchangedTempIds.concat(Array.from(accessExcludedIds)));
				const willUploadCount =
					realRecordsForCount.length - unchangedOnlySet.size - deleteIdSet.size - accessExcludedIds.size;
				const willDeleteCount = deleteIdSet.size;
				const objectSummary = summarizeUploadRecords(
					scopedRecords,
					unchangedSet,
					deleteIdSet,
					canvasState.describeCache,
				);
				const objectSummaryRows = objectSummary
					.filter((group) => group.creates || group.updates || group.upserts)
					.map((group) => {
						const counts = [];
						if (group.creates) {
							counts.push(group.creates + ' new');
						}
						if (group.updates) {
							counts.push(group.updates + (group.updates === 1 ? ' update' : ' updates'));
						}
						if (group.upserts) {
							counts.push(group.upserts + ' insert or update by external ID');
						}
						return (
							'<div class="us-label">' +
							escapeHtml(group.label) +
							'</div><div class="us-count">' +
							escapeHtml(counts.join(' · ')) +
							'</div>'
						);
					})
					.join('');

				const orderResult = computeUploadOrder(unchangedSet, scopedIds, deleteIdSet);
				const cycleIds = orderResult.cycleIds || new Set();
				const totalRecords = willUploadCount + willDeleteCount;

				const describeFailure =
					missingDescribes.size > 0 || _describeLoadFailures.length > 0
						? describeLoadFailureSummary(_describeLoadFailures, missingDescribes)
						: null;
				let preflightHtml = '';
				if (options.checkOnly) {
					return {
						issues: issues
							.filter((issue) => issue.severity === 'error')
							.concat(
								Array.from(cycleIds, (recordId) => ({
									recordId,
									severity: 'error',
									message:
										'This record is part of a reference cycle. Remove or change a relationship to break the cycle.',
								})),
							),
						missingDescribes,
						accessExcludedIds,
						blocked: !!(_migActive || describeFailure || _recordAccessLoadFailure),
					};
				}
				if (
					!_migActive &&
					!describeFailure &&
					!_recordAccessLoadFailure &&
					(errorCount > 0 || cycleIds.size > 0)
				) {
					const blockers = issues.filter((issue) => issue.severity === 'error');
					cycleIds.forEach((recordId) =>
						blockers.push({
							recordId,
							severity: 'error',
							message:
								'This record is part of a reference cycle. Remove or change a relationship to break the cycle.',
						}),
					);
					renderBlockingUploadIssues(blockers);
					return false;
				}
				if (issues.length === 0 && !describeFailure && !_recordAccessLoadFailure) {
					preflightHtml = '';
				} else if (issues.length > 0) {
					const recordSections = Array.from(byRecordId.entries())
						.map(([rid, rIssues]) => {
							const first = rIssues[0];
							const errs = rIssues.filter((x) => x.severity === 'error').length;
							const warns = rIssues.filter((x) => x.severity === 'warning').length;
							const summaryParts = [];
							if (errs > 0) {
								summaryParts.push(errs + ' error' + (errs === 1 ? '' : 's'));
							}
							if (warns > 0) {
								summaryParts.push(warns + ' warning' + (warns === 1 ? '' : 's'));
							}
							const items = rIssues
								.map(
									(iss) =>
										'<li class="pf-item pf-' +
										iss.severity +
										'">' +
										'<span class="pf-field">' +
										escapeHtml(iss.fieldLabel) +
										' (<code>' +
										escapeHtml(iss.field) +
										'</code>)</span> ' +
										'<span class="pf-msg-text">' +
										escapeHtml(iss.message) +
										'</span>' +
										'</li>',
								)
								.join('');
							return (
								'<details class="pf-record"' +
								(errs > 0 ? ' open' : '') +
								'>' +
								'<summary>' +
								'<span class="pf-rec-label">' +
								escapeHtml(first.recordLabel) +
								'</span>' +
								'<span class="pf-rec-counts">' +
								summaryParts.join(' \u00b7 ') +
								'</span>' +
								'</summary>' +
								'<ul class="pf-issues">' +
								items +
								'</ul>' +
								'</details>'
							);
						})
						.join('');
					preflightHtml =
						'<div class="preflight ' +
						(errorCount > 0 ? 'has-errors' : 'has-warnings') +
						'">' +
						'<div class="pf-head">' +
						'<span class="pf-icon">' +
						(errorCount > 0 ? '\u26A0' : 'i') +
						'</span>' +
						'<span class="pf-msg">' +
						'<strong>Pre-flight: ' +
						(errorCount > 0 ? errorCount + ' error' + (errorCount === 1 ? '' : 's') : '') +
						(errorCount > 0 && warningCount > 0 ? ', ' : '') +
						(warningCount > 0 ? warningCount + ' warning' + (warningCount === 1 ? '' : 's') : '') +
						'.</strong> ' +
						(errorCount > 0
							? 'Fix these errors on the canvas before uploading.'
							: 'These look fixable but should still upload. Review or proceed.') +
						'</span>' +
						'</div>' +
						'<div class="pf-body">' +
						recordSections +
						'</div>' +
						'</div>';
				}
				if (_migActive) {
					confirmBtn.style.display = '';
					confirmBtn.disabled = true;
					confirmBtn.textContent = 'Apply migration first';
					confirmBtn.classList.remove('confirm-anyway');
					confirmBtn.classList.remove('confirm-danger');
					if (cancelBtn) {
						cancelBtn.textContent = 'Close';
					}
				} else if (describeFailure) {
					preflightHtml +=
						'<div class="preflight has-errors">' +
						'<span class="pf-icon">\u26A0</span>' +
						'<span class="pf-msg"><strong>' +
						escapeHtml(describeFailure.heading) +
						'</strong> ' +
						escapeHtml(describeFailure.message) +
						'</span>' +
						'</div>';
				}
				if (_recordAccessLoadFailure) {
					preflightHtml +=
						'<div class="preflight has-errors"><span class="pf-icon">\u26A0</span>' +
						'<span class="pf-msg"><strong>Could not verify record access.</strong> ' +
						escapeHtml(_recordAccessLoadFailure.message || String(_recordAccessLoadFailure)) +
						' No records will be uploaded until this check succeeds.</span></div>';
				}
				if (cycleIds.size > 0) {
					preflightHtml =
						'<div class="preflight has-errors">' +
						'<span class="pf-icon">⚠</span>' +
						'<span class="pf-msg"><strong>Reference cycle detected.</strong> ' +
						cycleIds.size +
						' record' +
						(cycleIds.size === 1 ? '' : 's') +
						' depend on each other. Break the cycle on the canvas before uploading; no records have been sent to Salesforce.</span>' +
						'</div>';
				}

				const exclusionSummary = uploadExclusionSummary(scopedExclusions);
				const excludedRecordNote =
					exclusionSummary.length > 0
						? '<div class="preflight has-warnings">' +
							'<span class="pf-icon">i</span>' +
							'<span class="pf-msg"><strong>Not included:</strong> ' +
							escapeHtml(exclusionSummary.join(', ')) +
							'. Finish or remove these canvas items before uploading them.</span>' +
							'</div>'
						: '';
				const incompleteFieldRequestCount = incompleteFieldRequests(
					scopedRecords.filter((record) => !accessExcludedIds.has(record.id)),
				).length;
				const incompleteFieldRequestNote =
					incompleteFieldRequestCount > 0
						? '<div class="preflight has-warnings">' +
							'<span class="pf-icon">i</span>' +
							'<span class="pf-msg"><strong>Requested fields are still incomplete.</strong> ' +
							incompleteFieldRequestCount +
							' record' +
							(incompleteFieldRequestCount === 1 ? '' : 's') +
							' will still be included. Review the requested fields before uploading.</span>' +
							'</div>'
						: '';
				const excludedDraftLinkNote =
					optionalExcludedDraftLinkCount > 0
						? '<div class="preflight has-warnings">' +
							'<span class="pf-icon">i</span>' +
							'<span class="pf-msg"><strong>Some relationships won’t be included.</strong> ' +
							optionalExcludedDraftLinkCount +
							' relationship' +
							(optionalExcludedDraftLinkCount === 1 ? '' : 's') +
							' point' +
							(optionalExcludedDraftLinkCount === 1 ? 's' : '') +
							' to an unselected draft. Only the selected ' +
							'record' +
							(scopedRecords.length === 1 ? '' : 's') +
							' will upload. Select the related draft' +
							(optionalExcludedDraftLinkCount === 1 ? '' : 's') +
							' too if you want Salesforce to preserve ' +
							(optionalExcludedDraftLinkCount === 1 ? 'that relationship' : 'those relationships') +
							'.</span>' +
							'</div>'
						: '';
				const accessExclusionRows = accessExclusions
					.map((entry) => {
						const record = entry.record;
						const identity = uploadResultIdentity(
							{ tempId: record.id, sfId: record.loadedFromId, objectName: record.objectName },
							canvasState.bulkRecords,
							canvasState.describeCache,
							null,
							null,
							recordOrdinal,
						);
						const sfBase = String(window.SF_INSTANCE_URL || '').replace(/\/+$/, '');
						const url =
							sfBase && record.loadedFromId
								? sfBase +
									'/lightning/r/' +
									encodeURIComponent(record.objectName) +
									'/' +
									encodeURIComponent(record.loadedFromId) +
									'/view'
								: null;
						const heading = escapeHtml(identity.objectLabel + ' - ' + identity.name);
						return (
							'<div class="upload-access-exclusion-row"><span>' +
							(url
								? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + heading + '</a>'
								: heading) +
							'</span><span class="tag">' +
							(record._recordAccess && record._recordAccess.hasReadAccess === false
								? '<span title="This record may have been deleted, or your Salesforce user no longer has access.">Unavailable in Salesforce</span>'
								: entry.reason === 'no-delete-access'
									? 'No delete access'
									: 'Read-only in Salesforce') +
							'</span></div>'
						);
					})
					.join('');
				const accessExclusionBlock = accessExclusionRows
					? '<div class="upload-section-head upload-section-head--muted">Won\u2019t upload (' +
						accessExclusions.length +
						')</div><p class="upload-access-exclusion-lead">These changes are excluded because the records are unavailable or your Salesforce user lacks permission.</p>' +
						'<div class="upload-access-exclusions">' +
						accessExclusionRows +
						'</div>'
					: '';
				const deletesBlock =
					willDeleteCount > 0
						? '<div class="upload-delete-summary"><span class="upload-ready-count"><strong>' +
							willDeleteCount +
							'</strong> ' +
							(willDeleteCount === 1 ? 'record ready' : 'records ready') +
							' to delete</span><span class="upload-delete-badge">Irreversible</span></div>'
						: '';
				const systemBlocked = !!(_migActive || describeFailure || _recordAccessLoadFailure);
				uploadModal.querySelector('#upload-modal-title').textContent = systemBlocked
					? 'Fix before uploading'
					: 'Upload to Salesforce';
				uploadModal.classList.add('upload-ready-state');
				const writeSummary = systemBlocked
					? ''
					: !willUploadCount && !willDeleteCount
						? '<div class="upload-ready-count">No changes to upload.</div>'
						: (willUploadCount
								? '<div class="upload-ready-count"><strong>' +
									willUploadCount +
									'</strong> ' +
									(willUploadCount === 1 ? 'record ready' : 'records ready') +
									' to write</div>'
								: '') +
							(objectSummaryRows
								? '<div class="upload-summary upload-summary--objects upload-ready-objects">' +
									objectSummaryRows +
									'</div>'
								: '') +
							deletesBlock;
				content.innerHTML =
					migrateBanner +
					excludedRecordNote +
					incompleteFieldRequestNote +
					excludedDraftLinkNote +
					preflightHtml +
					accessExclusionBlock +
					writeSummary;
				const _matchBtn = content.querySelector('[data-migrate-review]');
				if (_matchBtn) {
					_matchBtn.addEventListener('click', () => {
						const mm = window.Orgloom && window.Orgloom.migrateMatch;
						if (mm && mm.open) {
							mm.open({ onClose: () => _renderUploadModalSummary() });
						}
					});
				}

				const hasWork = totalRecords > 0;
				if (_migActive) {
					confirmBtn.disabled = true;
					confirmBtn.textContent = 'Apply migration first';
					confirmBtn.onclick = null;
				} else if (_recordAccessLoadFailure) {
					confirmBtn.style.display = '';
					confirmBtn.disabled = false;
					confirmBtn.textContent = 'Retry access check';
					confirmBtn.classList.remove('confirm-anyway');
					confirmBtn.classList.remove('confirm-danger');
					confirmBtn.onclick = () =>
						openUploadModal({ initialScope: _uploadScopeSelected ? 'selected' : 'all' });
					if (cancelBtn) {
						cancelBtn.textContent = 'Close';
					}
				} else if (describeFailure) {
					confirmBtn.style.display = '';
					confirmBtn.disabled = false;
					confirmBtn.textContent = describeFailure.action;
					confirmBtn.classList.remove('confirm-anyway');
					confirmBtn.classList.remove('confirm-danger');
					confirmBtn.onclick = () => {
						if (describeFailure.kind === 'connection') {
							const chip = document.getElementById('app-sf-chip');
							if (chip) {
								chip.click();
							}
							return;
						}
						openUploadModal({ initialScope: _uploadScopeSelected ? 'selected' : 'all' });
					};
					if (cancelBtn) {
						cancelBtn.textContent = 'Close';
					}
				} else if (cycleIds.size > 0) {
					confirmBtn.style.display = '';
					confirmBtn.disabled = true;
					confirmBtn.textContent = 'Break reference cycle';
					confirmBtn.classList.remove('confirm-anyway');
					confirmBtn.classList.remove('confirm-danger');
					if (cancelBtn) {
						cancelBtn.textContent = 'Cancel';
					}
				} else if (!hasWork) {
					confirmBtn.style.display = 'none';
					confirmBtn.disabled = false;
					if (cancelBtn) {
						cancelBtn.textContent = 'Close';
					}
				} else {
					confirmBtn.disabled = false;
					confirmBtn.style.display = '';
					if (cancelBtn) {
						cancelBtn.textContent = 'Cancel';
					}
					confirmBtn.onclick = confirmUpload;
					const deletesOnly = willUploadCount === 0 && willDeleteCount > 0;
					if (errorCount > 0) {
						confirmBtn.disabled = false;
						confirmBtn.textContent = 'Fix errors before upload';
						confirmBtn.onclick = closeUploadModal;
						confirmBtn.classList.remove('confirm-anyway');
						confirmBtn.classList.remove('confirm-danger');
					} else if (deletesOnly) {
						confirmBtn.textContent =
							'Delete ' + willDeleteCount + ' record' + (willDeleteCount === 1 ? '' : 's');
						confirmBtn.classList.remove('confirm-anyway');
						confirmBtn.classList.add('confirm-danger');
					} else {
						confirmBtn.textContent = willDeleteCount ? 'Upload & delete ' + willDeleteCount : 'Upload';
						confirmBtn.classList.remove('confirm-anyway');
						confirmBtn.classList.toggle('confirm-danger', willDeleteCount > 0);
					}
				}
				return !systemBlocked && hasWork;
			}

			function closeUploadModal() {
				uploadModal.classList.add('hidden');
			}

			let _bulkSwitchAcknowledged = false;
			let _uploadScopeSelected = false;
			let _accessExcludedTempIds = new Set();
			function _scopedRealRecords() {
				return scopeUploadRecords(canvasState.bulkRecords, canvasState.bulkSelectedIds, _uploadScopeSelected);
			}

			function _scopedExcludedDraftParentLinks() {
				const scopedIds = new Set(_scopedRealRecords().map((r) => r.id));
				return excludedDraftParentLinks(
					canvasState.bulkRecords,
					canvasState.bulkAssociations,
					scopedIds,
					_uploadScopeSelected,
				);
			}

			let _uploadAttemptId = null;
			const recoveryJournal = createUploadRecoveryJournal(
				window.sessionStorage,
				window.SF_ORG_ID,
				window.SF_USER_ID,
				() => crypto.randomUUID(),
			);
			async function recoverPendingUploads(records, snapshots) {
				const entries = recoveryJournal.entries(records);
				if (!entries.length) {
					return false;
				}
				let recovered = 0;
				for (const attemptId of new Set(entries.map(({ entry }) => entry.attemptId))) {
					const response = await csrfFetch('/api/upload-attempts/' + encodeURIComponent(attemptId));
					if (!response.ok) {
						continue;
					}
					const body = await response.json();
					const group = entries.filter(({ entry }) => entry.attemptId === attemptId);
					const resolved = new Map();
					const safe = [];
					for (const { record, entry } of group) {
						const result = (body.results || []).find(
							(r) => r.tempId === entry.tempId && r.objectName === record.objectName,
						);
						if (
							(result && result.success && result.mode === 'unchanged') ||
							(!result && body.unreportedRecordsNotSubmitted === true)
						) {
							// No write occurred. Keep local edits and simply release the attempt marker.
							safe.push(record);
						} else if (result && result.success && result.id) {
							resolved.set(record.id, result.id);
							safe.push(record);
						} else if ((body.retryableTempIds || []).includes(entry.tempId)) {
							safe.push(record);
						}
					}
					if (resolved.size) {
						const rows = records.filter((r) => resolved.has(r.id));
						const canonical = {};
						for (let offset = 0; offset < rows.length; offset += 200) {
							const chunk = rows.slice(offset, offset + 200);
							try {
								const refresh = await csrfFetch('/api/records/refresh', {
									method: 'POST',
									headers: { 'Content-Type': 'application/json' },
									body: JSON.stringify({
										records: chunk.map((r) => ({
											objectName: r.objectName,
											sfId: resolved.get(r.id),
										})),
									}),
								});
								if (refresh.ok) {
									for (const row of (await refresh.json()).results || []) {
										const record = chunk.find(
											(r) => r.objectName === row.objectName && resolved.get(r.id) === row.sfId,
										);
										if (record && row.ok && row.values) {
											canonical[record.id] = row.values;
										}
									}
								}
							} catch (_) {
								/* Confirmed IDs remain useful even when refresh is unavailable. */
							}
						}
						// After a reload, preserve draft edits instead of pretending they were submitted.
						const recoverySnapshots =
							snapshots ||
							new Map(
								rows.map((r) => [
									r.id,
									{
										values: {},
										canvasValues: {},
										loadedValues: r.loadedValues || {},
									},
								]),
							);
						_applyRecoveredIds(resolved, canonical, recoverySnapshots);
						recovered += resolved.size;
					}
					recoveryJournal.clear(safe);
				}
				_uploadAttemptId = null;
				flushAutosave();
				const unresolved = recoveryJournal.entries(records).length;
				if (!unresolved && !recovered) {
					return false;
				}
				renderAttemptIncomplete({
					recoveryComplete: unresolved === 0,
					message:
						(recovered ? recovered + ' confirmed records restored to the canvas. ' : '') +
						(unresolved
							? unresolved +
								' records still have an unknown outcome. Check Salesforce before uploading these drafts again.'
							: entries.length > recovered
								? 'The remaining records were not saved. Close this message and upload again to retry them safely.'
								: 'All records from this attempt have been recovered.'),
				});
				return true;
			}
			let _allowDuplicates = false;
			let _baselineConfirmations = [];
			async function confirmUpload() {
				resetSampleFailureActions();
				if (_renderUploadModalSummary() === false) {
					return;
				}
				resetSampleFailureActions();
				uploadModal.querySelector('#upload-result-summary').hidden = true;
				const realRecords = _scopedRealRecords();
				if (realRecords.length === 0) {
					return;
				}
				try {
					if (await recoverPendingUploads(realRecords)) {
						return;
					}
				} catch (_) {
					renderAttemptIncomplete({
						message: 'Upload recovery could not be checked. Please reconnect and try again.',
					});
					return;
				}
				const migrateApi = window.Orgloom && window.Orgloom.canvasMigrate;
				if (migrateApi && migrateApi.isActive()) {
					showBulkToast('Apply the migration plan to the canvas before uploading.', 'warning');
					_renderUploadModalSummary();
					return;
				}
				const unavailableObjects = [
					...new Set(
						realRecords
							.filter((record) => record._importSchemaWarning?.objectUnavailable)
							.map((record) => record.objectName),
					),
				];
				for (const objectName of unavailableObjects) {
					try {
						await ensureDescribe(objectName, { force: true });
						realRecords
							.filter((record) => record.objectName === objectName)
							.forEach((record) => {
								delete record._importSchemaWarning;
							});
					} catch (_) {
						showBulkToast(
							objectName +
								' is unavailable through this Salesforce connection. Remove its records from the upload selection or use a connection with access to this object.',
							'warning',
						);
						return;
					}
				}
				const currentCanvas = canvasState.currentCanvas;
				if (currentCanvas && currentCanvas.id && !currentCanvas.ownedByMe) {
					showBulkToast(
						'Only the canvas owner can upload this shared canvas to Salesforce. Submit your contribution instead.',
						'error',
					);
					return;
				}
				const unresolvedEncrypted = realRecords.flatMap((record) =>
					encryptedFields.unresolvedIntentNames(record, canvasState).map((fieldName) => ({
						record,
						fieldName,
					})),
				);
				if (unresolvedEncrypted.length > 0) {
					unresolvedEncrypted.forEach(({ record, fieldName }) => {
						encryptedFields.dismissIntent(record, fieldName);
					});
					showBulkToast(
						unresolvedEncrypted.length +
							' encrypted field' +
							(unresolvedEncrypted.length === 1 ? ' was' : 's were') +
							' left unchanged for this upload.',
						'warning',
					);
					renderBulkView();
					publishPresenceChanges();
					flushAutosave();
				}
				const accessCheckButton = uploadModal.querySelector('#upload-confirm');
				const accessCheckContent = uploadModal.querySelector('#upload-modal-content');
				accessCheckButton.disabled = true;
				accessCheckContent.innerHTML =
					'<p class="center busy-row" style="justify-content:center"><span class="busy-spinner lg"></span>' +
					'<span>Checking record access&hellip;</span></p>';
				let refreshedAccessSignature;
				try {
					refreshedAccessSignature = await _refreshRecordAccess(canvasState.bulkRecords);
					renderBulkView();
				} catch (error) {
					_recordAccessLoadFailure = error;
					_recordAccessSignature = null;
					_renderUploadModalSummary();
					return;
				}
				if (_recordAccessSignature !== null && refreshedAccessSignature !== _recordAccessSignature) {
					_recordAccessSignature = refreshedAccessSignature;
					_renderUploadModalSummary();
					showBulkToast('Salesforce record access changed. Review the updated upload plan.', 'warning');
					return;
				}
				_recordAccessSignature = refreshedAccessSignature;
				const publishCanvasId = currentCanvas && currentCanvas.id ? currentCanvas.id : null;
				const meInfo = getMeInfo();
				const userRecords = realRecords.filter((r) => r.objectName === 'User' && !r.loadedFromId);
				if (userRecords.length > 0) {
					const orgLabel =
						meInfo && meInfo.orgType === 'production'
							? 'PRODUCTION'
							: (meInfo && meInfo.orgType) || 'this org';
					const msg =
						"You're about to create " +
						userRecords.length +
						' User record' +
						(userRecords.length === 1 ? '' : 's') +
						' in ' +
						orgLabel +
						'.\n\n' +
						'\u2022 Each new User consumes a Salesforce license.\n' +
						"\u2022 Users CAN'T be deleted, only deactivated; these stay in the org forever.\n" +
						'\u2022 Salesforce sends a welcome email on insert (suppressed when IsActive=false).\n\n' +
						'Proceed?';
					if (
						!(await showConfirmDialog({
							title: 'Create User records?',
							message: msg,
							confirmLabel: 'Create users',
							cancelLabel: 'Cancel',
							danger: true,
						}))
					) {
						return;
					}
				}
				const confirmBtn = uploadModal.querySelector('#upload-confirm');
				const cancelBtn = uploadModal.querySelector('[data-upload-close]');
				const content = uploadModal.querySelector('#upload-modal-content');
				confirmBtn.disabled = true;
				content.innerHTML =
					'<p class="center busy-row" style="justify-content:center">' +
					'<span class="busy-spinner lg"></span>' +
					'<span>Checking Salesforce access&hellip;</span>' +
					'</p>';
				const accessController = new AbortController();
				const accessTimeout = setTimeout(() => accessController.abort(), 5000);
				try {
					const accessResponse = await csrfFetch('/api/upload/access-check', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ canvasId: publishCanvasId }),
						credentials: 'same-origin',
						signal: accessController.signal,
					});
					const accessBody = await accessResponse.json().catch(() => ({}));
					if (!accessResponse.ok) {
						if (isUploadPermissionDenied(accessBody)) {
							renderUploadPermissionRequired(content, confirmBtn, accessBody);
							return;
						}
						if (isOrgAccessBlocked(accessBody)) {
							renderApprovalRequired(content, confirmBtn, accessBody);
							return;
						}
						throw new Error(
							(accessBody && (accessBody.message || accessBody.error)) ||
								'Org Loom could not verify upload access.',
						);
					}
					if (meInfo && meInfo.connection) {
						meInfo.connection.approval = { required: false, status: 'approved' };
					}
				} catch (error) {
					const timedOut = accessController.signal.aborted;
					content.innerHTML =
						'<div class="banner error"><strong>' +
						(timedOut ? 'Salesforce access check took too long.' : 'Could not verify upload access.') +
						'</strong> ' +
						(timedOut
							? 'No records were written. Retry, or open Workspace settings to review whether this Salesforce org is awaiting approval.'
							: escapeHtml(error.message || String(error))) +
						'</div>' +
						(timedOut
							? '<p class="center"><a class="button secondary" href="/workspace#workspace" target="_blank" rel="noopener">Open Workspace settings</a></p>'
							: '');
					confirmBtn.disabled = false;
					confirmBtn.textContent = 'Retry';
					return;
				} finally {
					clearTimeout(accessTimeout);
				}

				const accessExclusions = _recordAccessExclusions(realRecords);
				const accessExcludedIds = new Set(accessExclusions.map((entry) => entry.record.id));
				_accessExcludedTempIds = new Set(accessExcludedIds);
				const skipTempIds = realRecords
					.filter((r) => r.loadedFromId && !isRecordModified(r) && !r.pendingDelete)
					.map((r) => r.id)
					.concat(Array.from(accessExcludedIds));
				const recordsForPayload = realRecords.filter(
					(record) => !record.pendingDelete || accessExcludedIds.has(record.id),
				);
				const deletesForPayload = realRecords.filter(
					(record) => isRecordPendingDelete(record) && !accessExcludedIds.has(record.id),
				);
				const excludedDraftLinksForPayload = _scopedExcludedDraftParentLinks();

				// Build one immutable request snapshot so later canvas edits cannot change this attempt.
				const scopedIds = new Set(recordsForPayload.map((r) => r.id));
				const payload = {
					canvasId: publishCanvasId,
					records: recordsForPayload.map((r) => ({
						tempId: r.id,
						objectName: r.objectName,
						values: scopeUploadValues(
							r,
							encryptedFields.uploadValues(r, canvasState, r.values),
							excludedDraftLinksForPayload,
						),
						explicitFields: encryptedFields.intentNames(r, canvasState),
						loadedFromId: r.loadedFromId || null,
						loadedValues:
							r.loadedFromId && r.loadedValues
								? encryptedFields.stripValues(canvasState, r.objectName, r.loadedValues)
								: undefined,
						_csvOperation: r._csvOperation || undefined,
						_csvExternalIdField: r._csvExternalIdField || undefined,
					})),
					deletes: deletesForPayload.map((r) => ({
						tempId: r.id,
						sfId: r.loadedFromId,
						objectName: r.objectName,
					})),
					associations: scopeUploadAssociations(canvasState.bulkAssociations, scopedIds).map((a) => ({
						fromId: a.fromId,
						toId: a.toId,
						fieldName: a.fieldName,
					})),
					skipTempIds,
					expectedSfOrgId: window.SF_ORG_ID || null,
					baselineConfirmations: _baselineConfirmations,
				};
				// Retries reuse this ID so the server can distinguish a retry from a new transaction.
				if (!_uploadAttemptId) {
					_uploadAttemptId =
						window.crypto && typeof crypto.randomUUID === 'function'
							? crypto.randomUUID()
							: 'att-' + Date.now() + '-' + Math.random().toString(36).slice(2);
				}
				payload.attemptId = _uploadAttemptId;
				if (_allowDuplicates) {
					payload.allowDuplicates = true;
				}

				const uploadingCountForGate = recordsForPayload.length - skipTempIds.length;
				// 75 limits graphs per request, not records in a connected component.
				const PER_COMPONENT_CAP = 500;
				const TOTAL_NODES_CAP = 500;
				const BYTE_CAP = 5 * 1024 * 1024; // 5 MB, leaves room under the 6 MB hard ceiling
				const components = (() => {
					const submitted = new Set(
						recordsForPayload
							.filter((r) => !(r.loadedFromId && skipTempIds.indexOf(r.id) !== -1))
							.map((r) => r.id),
					);
					const adj = new Map();
					submitted.forEach((id) => adj.set(id, new Set()));
					canvasState.bulkAssociations.forEach((a) => {
						if (!a) {
							return;
						}
						if (!submitted.has(a.fromId) || !submitted.has(a.toId)) {
							return;
						}
						adj.get(a.fromId).add(a.toId);
						adj.get(a.toId).add(a.fromId);
					});
					const seen = new Set();
					const groups = [];
					for (const seed of submitted) {
						if (seen.has(seed)) {
							continue;
						}
						const group = [];
						const queue = [seed];
						while (queue.length) {
							const cur = queue.shift();
							if (seen.has(cur)) {
								continue;
							}
							seen.add(cur);
							group.push(cur);
							for (const n of adj.get(cur) || []) {
								if (!seen.has(n)) {
									queue.push(n);
								}
							}
						}
						groups.push(group);
					}
					return groups;
				})();
				const maxComponentSize = components.reduce((m, g) => Math.max(m, g.length), 0);
				let _orphanStrippedCount = 0;
				let _orphanStrippedRecordCount = 0;
				if (Array.isArray(payload.records)) {
					payload.records.forEach((r) => {
						if (!r || !r.values || !r.objectName) {
							return;
						}
						const desc = canvasState.describeCache && canvasState.describeCache[r.objectName];
						if (!desc || !Array.isArray(desc.fields)) {
							return;
						}
						const known = new Set(desc.fields.map((f) => f.name));
						const isCrossOrgCarryover = !!r._wasLoadedFromOrgId;
						let stripped = 0;
						Object.keys(r.values).forEach((k) => {
							if (!k || k.startsWith('_')) {
								return;
							}
							if (shouldStripUploadField(k, known)) {
								delete r.values[k];
								if (!known.has(k) && isCrossOrgCarryover) {
									stripped++;
								}
								return;
							}
						});
						if (stripped > 0) {
							_orphanStrippedCount += stripped;
							_orphanStrippedRecordCount++;
						}
					});
				}
				if (_orphanStrippedCount > 0 && typeof window.olToast === 'function') {
					window.olToast(
						'Skipped ' +
							_orphanStrippedCount +
							' unavailable field value' +
							(_orphanStrippedCount === 1 ? '' : 's') +
							' across ' +
							_orphanStrippedRecordCount +
							' record' +
							(_orphanStrippedRecordCount === 1 ? '' : 's') +
							'. They may not exist in the destination org, or Salesforce permissions may hide them.',
						'warn',
					);
				}

				const submittedSnapshots = snapshotUploadRecords(
					payload.records,
					recordsForPayload,
					canvasState.bulkAssociations,
				);
				const payloadJson = JSON.stringify(payload);
				const hasUpsert = realRecords.some((r) => r._csvOperation === 'upsert');
				const fitsGraph =
					uploadingCountForGate > 0 &&
					maxComponentSize <= PER_COMPONENT_CAP &&
					uploadingCountForGate <= TOTAL_NODES_CAP &&
					payloadJson.length <= BYTE_CAP;
				if (!fitsGraph && uploadingCountForGate > 0) {
					confirmBtn.disabled = false;
					confirmBtn.textContent = 'Upload';
					const reasons = [];
					if (maxComponentSize > PER_COMPONENT_CAP) {
						reasons.push(
							'one connected cluster has ' +
								maxComponentSize +
								' records (canvas cap is ' +
								PER_COMPONENT_CAP +
								' per cluster)',
						);
					}
					if (uploadingCountForGate > TOTAL_NODES_CAP) {
						reasons.push(uploadingCountForGate + ' total records (canvas cap is ' + TOTAL_NODES_CAP + ')');
					}
					if (payloadJson.length > BYTE_CAP) {
						reasons.push(
							'payload is ' +
								(payloadJson.length / 1024 / 1024).toFixed(1) +
								' MB (canvas cap is ' +
								(BYTE_CAP / 1024 / 1024).toFixed(0) +
								' MB)',
						);
					}
					content.innerHTML =
						'<div class="banner error">' +
						'<strong>Upload too large for the canvas path.</strong> ' +
						(reasons.length
							? '<ul style="margin:0.4em 0 0 1.2em">' +
								reasons.map((r) => '<li>' + escapeHtml(r) + '</li>').join('') +
								'</ul>'
							: '') +
						'<p style="margin-top:0.5em">Split this upload into smaller canvas batches.</p>' +
						'</div>';
					return;
				}
				if (fitsGraph && !hasUpsert) {
					confirmBtn.disabled = true;
					confirmBtn.textContent = 'Uploading\u2026';
					const uploadingRecords = recordsForPayload.filter(
						(record) => skipTempIds.indexOf(record.id) === -1,
					);
					content.innerHTML =
						'<p class="center busy-row" style="justify-content:center">' +
						'<span class="busy-spinner lg"></span>' +
						'<span>' +
						escapeHtml(formatUploadProgress(uploadingRecords, canvasState.describeCache)) +
						'</span>' +
						'</p>';
					let body;
					try {
						recoveryJournal.track(uploadingRecords, _uploadAttemptId);
						renderBulkView();
						flushAutosave();
						const r = await csrfFetch('/api/upload/graph', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: payloadJson,
							credentials: 'same-origin',
						});
						body = await r.json().catch(() => ({}));
						if (r.ok && !Array.isArray(body.results)) {
							throw new Error('The upload response was incomplete.');
						}
						if (
							!r.ok &&
							([400, 401, 402, 403].includes(r.status) ||
								[
									'salesforce-records-changed',
									'active-org-changed',
									'upload-ledger-unavailable',
									'salesforce-field-metadata-unavailable',
								].includes(body.error))
						) {
							// These responses reject the request before Salesforce business writes.
							recoveryJournal.clear(uploadingRecords);
							flushAutosave();
						}
						if (r.status === 401) {
							content.innerHTML =
								'<div class="banner error">Your Salesforce session expired. ' +
								'<a href="' +
								safeLoginHref(body && body.loginUrl) +
								'" data-sf-oauth-popup>Sign in again</a> ' +
								'and retry the upload.' +
								'</div>';
							confirmBtn.disabled = true;
							return;
						}
						if (r.status === 402 && body && body.code === 'upload_cap_reached') {
							content.innerHTML =
								'<div class="banner error">' +
								escapeHtml(body.error || 'Upload cap reached.') +
								'</div>' +
								(body.uploadsUsed != null && body.uploadCap != null
									? '<p class="tag" style="margin-top:0.4em">Used <strong>' +
										body.uploadsUsed +
										'</strong> of ' +
										body.uploadCap +
										' uploads this month.</p>'
									: '') +
								'<div style="display:flex;gap:0.5em;align-items:center;margin-top:0.7em;flex-wrap:wrap">' +
								'<a class="button" href="/workspace/upgrade">Upgrade to Pro &rarr;</a>' +
								'<a class="tag" href="/pricing" target="_blank" rel="noopener">Compare plans</a>' +
								'</div>';
							confirmBtn.disabled = true;
							return;
						}
						if (r.status === 409 && body && body.error === 'upload-attempt-incomplete') {
							// The server owns recovery guidance when an earlier attempt has an uncertain outcome.
							await recoverPendingUploads(realRecords, submittedSnapshots);
							return;
						}
						if (r.status === 409 && body && body.error === 'salesforce-records-changed') {
							renderBaselineConflicts(content, confirmBtn, body);
							return;
						}
						if (r.status === 409 && body && body.error === 'active-org-changed') {
							renderActiveOrgChanged(content, confirmBtn, body);
							return;
						}
						if (!r.ok && isOrgAccessBlocked(body)) {
							renderApprovalRequired(content, confirmBtn, body);
							return;
						}
						if (!r.ok && isUploadPermissionDenied(body)) {
							renderUploadPermissionRequired(content, confirmBtn, body);
							return;
						}
						if (!r.ok && body && body.error === 'salesforce-field-metadata-unavailable') {
							content.innerHTML =
								'<div class="banner error">' +
								escapeHtml(body.message || 'Salesforce field information could not be loaded.') +
								'</div>';
							confirmBtn.disabled = false;
							confirmBtn.textContent = 'Retry';
							return;
						}
						if (!r.ok) {
							throw new Error((body && (body.message || body.error)) || 'Upload failed');
						}
						const allResults = (body && body.results) || [];
						const hasCommitted = allResults.some((r) => r && r.success && r.mode !== 'unchanged');
						if (body && (body.atomicSuccess || hasCommitted)) {
							displayUploadResults(
								allResults,
								body.instanceUrl || '',
								body.deletes || [],
								body.canonicalValues || {},
								submittedSnapshots,
							);
							return;
						}
						if (body && body.retryWithoutGraph === true && !hasCommitted) {
							recoveryJournal.clear(uploadingRecords);
							_uploadAttemptId =
								window.crypto && typeof crypto.randomUUID === 'function'
									? crypto.randomUUID()
									: 'att-' + Date.now() + '-' + Math.random().toString(36).slice(2);
							payload.attemptId = _uploadAttemptId;
						} else {
							// This was an actual upload attempt, even when every graph rolled back.
							displayUploadResults(
								allResults,
								body.instanceUrl || '',
								body.deletes || [],
								body.canonicalValues || {},
								submittedSnapshots,
							);
							return;
						}
					} catch (err) {
						console.warn('[graph upload] interrupted:', err);
						try {
							if (!(await recoverPendingUploads(realRecords, submittedSnapshots))) {
								content.innerHTML =
									'<div class="banner error">' +
									escapeHtml(err.message || 'Upload failed.') +
									'</div>';
								confirmBtn.disabled = false;
								confirmBtn.textContent = 'Retry';
							}
						} catch (_e) {
							renderAttemptIncomplete({});
						}
						return;
					}
				}

				if (!_bulkSwitchAcknowledged && !fitsGraph && realRecords.length > BULK_THRESHOLD) {
					const reasons = [];
					if (maxComponentSize > PER_COMPONENT_CAP) {
						reasons.push(
							'one connected group has ' +
								maxComponentSize +
								' records (Composite Graph caps a group at ' +
								PER_COMPONENT_CAP +
								')',
						);
					}
					if (uploadingCountForGate > TOTAL_NODES_CAP) {
						reasons.push(
							uploadingCountForGate +
								' total records (Composite Graph caps total at ' +
								TOTAL_NODES_CAP +
								')',
						);
					}
					if (payloadJson.length > BYTE_CAP) {
						reasons.push(
							'payload is ' +
								(payloadJson.length / 1024 / 1024).toFixed(1) +
								' MB (Composite Graph caps payload at ' +
								(BYTE_CAP / 1024 / 1024).toFixed(0) +
								' MB)',
						);
					}
					const ok = await showBulkSwitchWarning({
						recordCount: uploadingCountForGate,
						reasons,
					});
					if (!ok) {
						confirmBtn.disabled = false;
						confirmBtn.textContent = 'Upload';
						content.innerHTML = '<p class="center tag">Upload cancelled.</p>';
						return;
					}
					_bulkSwitchAcknowledged = true;
				}

				confirmBtn.disabled = true;
				confirmBtn.textContent = 'Uploading\u2026';

				const useBulk = hasUpsert || realRecords.length > BULK_THRESHOLD;
				if (useBulk) {
					try {
						await runBulkUploadSSE(payload, content, submittedSnapshots);
					} catch (err) {
						let recovered = 0;
						try {
							recovered = await reconcileLostUpload(payload.records, submittedSnapshots);
						} catch (_e) {
							recovered = 0;
						}
						if (recovered > 0) {
							content.innerHTML =
								'<div class="banner">Connection dropped mid-upload, but ' +
								recovered +
								' record' +
								(recovered === 1 ? '' : 's') +
								' had already saved to Salesforce. ' +
								(recovered === 1 ? 'It\u2019s' : 'They\u2019re') +
								' now marked as uploaded, so retrying won\u2019t create duplicates. Click Retry to finish any records that didn\u2019t save.</div>';
						} else {
							content.innerHTML =
								'<div class="banner error">Upload failed: ' +
								escapeHtml(err.message || String(err)) +
								'</div>';
						}
						confirmBtn.disabled = false;
						confirmBtn.textContent = 'Retry';
					}
					return;
				}

				const uploadingCount = recordsForPayload.length - skipTempIds.length;
				const deleteCount = deletesForPayload.length;
				const skippedNote =
					skipTempIds.length > 0
						? '<p class="tag center">' +
							skipTempIds.length +
							' unchanged record' +
							(skipTempIds.length === 1 ? '' : 's') +
							' skipped.</p>'
						: '';
				const headerMsg =
					uploadingCount === 0 && deleteCount > 0
						? 'Deleting ' +
							deleteCount +
							' record' +
							(deleteCount === 1 ? '' : 's') +
							' in Salesforce\u2026'
						: 'Uploading ' +
							uploadingCount +
							' record' +
							(uploadingCount === 1 ? '' : 's') +
							(deleteCount > 0 ? ' (and deleting ' + deleteCount + ')' : '') +
							' to Salesforce\u2026';
				content.innerHTML =
					'<p class="center busy-row" style="justify-content:center">' +
					'<span class="busy-spinner lg"></span>' +
					'<span>' +
					headerMsg +
					'</span>' +
					'<span class="busy-elapsed" id="rest-elapsed"></span>' +
					'</p>' +
					skippedNote;
				const stopElapsed = startElapsedTicker(content.querySelector('#rest-elapsed'));
				try {
					const r = await csrfFetch('/api/upload', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(payload),
						credentials: 'same-origin',
					});
					const body = await r.json().catch(() => ({}));
					stopElapsed();
					if (r.status === 401) {
						content.innerHTML =
							'<div class="banner error">Your Salesforce session expired. ' +
							'<a href="' +
							safeLoginHref(body && body.loginUrl) +
							'" data-sf-oauth-popup>Sign in again</a> ' +
							'and retry the upload.' +
							'</div>';
						confirmBtn.disabled = true;
						return;
					}
					if (r.status === 409 && body && body.error === 'upload-attempt-incomplete') {
						renderAttemptIncomplete(body);
						return;
					}
					if (r.status === 409 && body && body.error === 'salesforce-records-changed') {
						renderBaselineConflicts(content, confirmBtn, body);
						return;
					}
					if (r.status === 409 && body && body.error === 'active-org-changed') {
						renderActiveOrgChanged(content, confirmBtn, body);
						return;
					}
					if (!r.ok) {
						if (isOrgAccessBlocked(body)) {
							renderApprovalRequired(content, confirmBtn, body);
							return;
						}
						throw new Error((body && (body.message || body.error)) || 'Upload failed');
					}
					displayUploadResults(
						body.results || [],
						body.instanceUrl || '',
						body.deletes || [],
						body.canonicalValues || {},
						submittedSnapshots,
					);
				} catch (err) {
					stopElapsed();
					let recovered = 0;
					try {
						recovered = await reconcileLostUpload(payload.records, submittedSnapshots);
					} catch (_e) {
						recovered = 0;
					}
					if (recovered > 0) {
						content.innerHTML =
							'<div class="banner">Connection dropped mid-upload, but ' +
							recovered +
							' record' +
							(recovered === 1 ? '' : 's') +
							' had already saved to Salesforce. ' +
							(recovered === 1 ? 'It\u2019s' : 'They\u2019re') +
							' now marked as uploaded, so retrying won\u2019t create duplicates. Click Retry to finish any records that didn\u2019t save.</div>';
					} else {
						content.innerHTML =
							'<div class="banner error">Upload failed: ' +
							escapeHtml(err.message || String(err)) +
							'</div>';
					}
					confirmBtn.disabled = false;
					confirmBtn.textContent = 'Retry';
				}
			}

			const BULK_THRESHOLD = 150;

			function humanizeState(s) {
				if (!s) {
					return '';
				}
				const out = String(s).replace(/([a-z])([A-Z])/g, '$1 $2');
				return out.charAt(0).toUpperCase() + out.slice(1).toLowerCase();
			}

			async function runBulkUploadSSE(payload, contentEl, submittedSnapshots) {
				contentEl.innerHTML =
					'<div class="bulk-progress">' +
					'<div class="bp-head">' +
					'<span class="busy-row"><span class="busy-spinner"></span><strong>Bulk upload</strong></span> ' +
					'<span class="tag" id="bp-summary">starting\u2026</span>' +
					'<span class="busy-elapsed" id="bp-elapsed"></span>' +
					'</div>' +
					'<div class="bp-levels" id="bp-levels"></div>' +
					'</div>';
				const summaryEl = contentEl.querySelector('#bp-summary');
				const levelsEl = contentEl.querySelector('#bp-levels');
				const stopElapsed = startElapsedTicker(contentEl.querySelector('#bp-elapsed'));

				let plan = null; // start-event payload
				const jobState = new Map();
				function jobKey(level, operation, objectName) {
					return level + '|' + operation + '|' + objectName;
				}

				function renderLevels() {
					if (!plan) {
						return;
					}
					const html = plan.levels
						.map((lvl) => {
							const groups = lvl.groups
								.map((g) => {
									const k = jobKey(lvl.level, g.operation, g.objectName);
									const st = jobState.get(k) || {};
									const processed = st.processed || 0;
									const failed = st.failed || 0;
									const total = g.count;
									const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
									const rawState = st.state || st.phase || 'queued';
									const stateLabel = humanizeState(rawState);
									const terminal =
										rawState === 'JobComplete' ||
										rawState === 'Failed' ||
										rawState === 'Aborted' ||
										rawState === 'done';
									const active = !terminal && rawState !== 'queued';
									const indeterminate = active && processed === 0;
									const spinnerHtml = active ? '<span class="busy-spinner"></span>' : '';
									return (
										'<div class="bp-job">' +
										'<div class="bp-job-head">' +
										'<span class="bp-obj">' +
										escapeHtml(g.objectName) +
										'</span> ' +
										'<span class="tag">' +
										escapeHtml(g.operation) +
										' \u00b7 ' +
										total +
										'</span>' +
										'<span class="bp-state tag">' +
										spinnerHtml +
										escapeHtml(stateLabel) +
										'</span>' +
										'</div>' +
										'<div class="bp-bar' +
										(indeterminate ? ' indeterminate' : '') +
										'"><div class="bp-bar-fill" style="width:' +
										pct +
										'%"></div></div>' +
										'<div class="bp-counts"><span>' +
										processed +
										' / ' +
										total +
										' processed</span>' +
										(failed > 0 ? '<span class="bp-failed">' + failed + ' failed</span>' : '') +
										'</div>' +
										'</div>'
									);
								})
								.join('');
							return (
								'<div class="bp-level">' +
								'<div class="bp-level-head">Level ' +
								(lvl.level + 1) +
								' of ' +
								plan.totalLevels +
								'</div>' +
								groups +
								'</div>'
							);
						})
						.join('');
					levelsEl.innerHTML = html;
				}

				const resp = await csrfFetch('/api/upload/bulk', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
					body: JSON.stringify(payload),
					credentials: 'same-origin',
				});
				if (resp.status === 401) {
					const body = await resp.json().catch(() => ({}));
					contentEl.innerHTML =
						'<div class="banner error">Your Salesforce session expired. ' +
						'<a href="' +
						safeLoginHref(body && body.loginUrl) +
						'" data-sf-oauth-popup>Sign in again</a> ' +
						'and retry the upload.' +
						'</div>';
					return;
				}
				if (resp.status === 402) {
					const body = await resp.json().catch(() => ({}));
					contentEl.innerHTML =
						'<div class="banner error">' +
						escapeHtml((body && body.error) || 'Upload cap reached.') +
						'</div>' +
						(body && body.uploadsUsed != null && body.uploadCap != null
							? '<p class="tag" style="margin-top:0.4em">Used <strong>' +
								body.uploadsUsed +
								'</strong> of ' +
								body.uploadCap +
								' uploads this month.</p>'
							: '') +
						'<div style="display:flex;gap:0.5em;align-items:center;margin-top:0.7em;flex-wrap:wrap">' +
						'<a class="button" href="/workspace/upgrade">Upgrade to Pro &rarr;</a>' +
						'<a class="tag" href="/pricing" target="_blank" rel="noopener">Compare plans</a>' +
						'</div>';
					return;
				}
				if (resp.status === 403) {
					const body = await resp.json().catch(() => ({}));
					if (isOrgAccessBlocked(body)) {
						renderApprovalRequired(contentEl, uploadModal.querySelector('#upload-confirm'), body);
						return;
					}
					throw new Error((body && (body.message || body.error)) || 'HTTP 403');
				}
				if (resp.status === 409) {
					const body = await resp.json().catch(() => ({}));
					if (body && body.error === 'salesforce-records-changed') {
						renderBaselineConflicts(contentEl, uploadModal.querySelector('#upload-confirm'), body);
						return;
					}
					if (body && body.error === 'active-org-changed') {
						renderActiveOrgChanged(contentEl, uploadModal.querySelector('#upload-confirm'), body);
						return;
					}
					throw new Error((body && (body.message || body.error)) || 'HTTP 409');
				}
				if (!resp.ok || !resp.body) {
					const t = await resp.text().catch(() => '');
					throw new Error(t || 'HTTP ' + resp.status);
				}

				const reader = resp.body.getReader();
				const decoder = new TextDecoder();
				let buffer = '';
				let finalResults = null;
				let finalDeletes = [];
				let finalInstanceUrl = '';
				let finalCanonicalValues = {};
				let streamErr = null;
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}
					buffer += decoder.decode(value, { stream: true });
					let sep;
					while ((sep = buffer.indexOf('\n\n')) !== -1) {
						const raw = buffer.slice(0, sep);
						buffer = buffer.slice(sep + 2);
						if (!raw.trim()) {
							continue;
						}
						let evName = 'message';
						let dataStr = '';
						raw.split('\n').forEach((line) => {
							if (line.startsWith('event: ')) {
								evName = line.slice(7).trim();
							} else if (line.startsWith('data: ')) {
								dataStr += (dataStr ? '\n' : '') + line.slice(6);
							}
						});
						let data;
						try {
							data = JSON.parse(dataStr);
						} catch (e) {
							continue;
						}
						if (evName === 'start') {
							plan = data;
							const willUpload = data.willUploadCount != null ? data.willUploadCount : data.totalRecords;
							let txt =
								willUpload +
								' record' +
								(willUpload === 1 ? '' : 's') +
								' across ' +
								data.totalLevels +
								' level' +
								(data.totalLevels === 1 ? '' : 's');
							if (data.unchangedCount > 0) {
								txt += ' \u00b7 ' + data.unchangedCount + ' unchanged (skipped)';
							}
							summaryEl.textContent = txt;
							renderLevels();
						} else if (evName === 'level-start') {
							renderLevels();
						} else if (evName === 'job-event') {
							if (plan) {
								for (const lvl of plan.levels) {
									const match = lvl.groups.find(
										(g) => g.objectName === data.objectName && g.operation === data.operation,
									);
									if (match) {
										const k = jobKey(lvl.level, data.operation, data.objectName);
										const st = jobState.get(k) || {};
										if (data.phase) {
											st.phase = data.phase;
										}
										if (data.state) {
											st.state = data.state;
										}
										if (data.processed != null) {
											st.processed = data.processed;
										}
										if (data.failed != null) {
											st.failed = data.failed;
										}
										jobState.set(k, st);
										break;
									}
								}
								renderLevels();
							}
						} else if (evName === 'level-done') {
							renderLevels();
						} else if (evName === 'complete') {
							finalResults = data.results || [];
							finalDeletes = data.deletes || [];
							finalInstanceUrl = data.instanceUrl || '';
							finalCanonicalValues = data.canonicalValues || {};
						} else if (evName === 'error') {
							streamErr = new Error(data.message || 'Bulk upload failed');
						}
					}
				}
				stopElapsed();
				if (streamErr) {
					throw streamErr;
				}
				if (!finalResults) {
					throw new Error('Bulk upload ended without results.');
				}
				displayUploadResults(
					finalResults,
					finalInstanceUrl,
					finalDeletes,
					finalCanonicalValues,
					submittedSnapshots,
				);
			}

			function uploadResultIdentityHtml(result, canonicalValues, submittedSnapshots, fallbackLabel) {
				const identity = uploadResultIdentity(
					result,
					canvasState.bulkRecords,
					canvasState.describeCache,
					canonicalValues,
					submittedSnapshots,
					recordOrdinal,
				);
				const hasRecordIdentity =
					result && (result.tempId != null || result.id || result.sfId || result.objectName);
				const heading = hasRecordIdentity
					? identity.objectLabel + ' - ' + identity.name
					: fallbackLabel || 'Unknown record';
				return (
					'<div class="upload-result-identity"><strong class="upload-result-name">' +
					escapeHtml(heading) +
					'</strong></div>'
				);
			}

			function uploadResultEditAttributes(result) {
				const canOpen =
					typeof deps.openRecordForCurrentUser === 'function' &&
					result &&
					canvasState.bulkRecords.some(
						(record) => String(record.id) === String(result.tempId) && !record._inaccessible,
					);
				return canOpen
					? ' role="button" tabindex="0" data-upload-edit-record="' +
							escapeHtml(String(result.tempId)) +
							'" title="Open this record on the canvas to review and edit it"'
					: '';
			}

			function bindUploadResultCards(content) {
				content.querySelectorAll('[data-upload-edit-record]').forEach((button) => {
					const openRecord = () => {
						const record = canvasState.bulkRecords.find(
							(candidate) => String(candidate.id) === button.dataset.uploadEditRecord,
						);
						if (!record || record._inaccessible) {
							showBulkToast('This record is no longer available on the canvas.', 'info');
							return;
						}
						closeUploadModal();
						if (_fixTasks && button.dataset.uploadFix === 'true') {
							_fixTasks.start(record.id, button.dataset.uploadFocusField);
							return;
						}
						deps.openRecordForCurrentUser(record, {
							focusField: button.dataset.uploadFocusField || undefined,
						});
					};
					button.addEventListener('click', () => {
						const selection = window.getSelection && window.getSelection();
						if (selection && !selection.isCollapsed && button.contains(selection.anchorNode)) {
							return;
						}
						openRecord();
					});
					button.addEventListener('keydown', (event) => {
						if (event.target === button && (event.key === 'Enter' || event.key === ' ')) {
							event.preventDefault();
							openRecord();
						}
					});
				});
			}

			function resetSampleFailureActions() {
				uploadModal.classList.remove('upload-review-state');
				uploadModal.classList.remove('upload-fix-state', 'upload-ready-state', 'upload-results-state');
				uploadModal.querySelector('#upload-modal-title').textContent = 'Upload records to Salesforce';
				uploadModal.querySelector('#upload-result-summary').hidden = true;
				const confirmBtn = uploadModal.querySelector('#upload-confirm');
				const cancelBtn = uploadModal.querySelector('#upload-cancel');
				confirmBtn.classList.remove('secondary');
				confirmBtn.removeAttribute('title');
				cancelBtn.classList.add('secondary');
				cancelBtn.textContent = 'Cancel';
			}

			function uploadIssueGroupsHtml(issues) {
				const groups = new Map();
				issues.forEach((issue) => {
					const message = issue.message || 'Salesforce rejected this record.';
					let heading = message;
					if (
						/Required field is empty|REQUIRED_FIELD_MISSING/.test(message + ' ' + (issue.errorCode || ''))
					) {
						heading = 'Required field is empty';
					} else if (
						/not an active picklist option|INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST/.test(
							message + ' ' + (issue.errorCode || ''),
						)
					) {
						heading =
							issue.errorCode === 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST'
								? 'Salesforce rejected a picklist value'
								: 'Value isn’t an active picklist option';
					} else if (issue.field === '(cascade)') {
						heading = 'Drafts depend on a record you’re deleting';
					} else if (/reference cycle/.test(message)) {
						heading = 'Records depend on each other';
					} else if (issue.errorCode) {
						heading =
							issue.errorCode === 'FIELD_CUSTOM_VALIDATION_EXCEPTION'
								? 'Salesforce validation rule failed'
								: 'Salesforce rejected a record';
					}
					const key = heading + (issue.errorCode || '');
					if (!groups.has(key)) {
						groups.set(key, { heading, issues: [] });
					}
					groups.get(key).issues.push(issue);
				});
				return Array.from(groups.values())
					.map((group) => {
						const recordCount = new Set(
							group.issues.map((issue) =>
								issue.recordId == null ? issue.recordLabel : String(issue.recordId),
							),
						).size;
						const rows = group.issues
							.map((issue) => {
								const identity = uploadResultIdentity(
									{ tempId: issue.recordId, objectName: issue.objectName },
									canvasState.bulkRecords,
									canvasState.describeCache,
									null,
									null,
									recordOrdinal,
								);
								const fieldName = issue.field || (issue.fields && issue.fields[0]) || '';
								const describe =
									canvasState.describeCache && canvasState.describeCache[issue.objectName];
								const field =
									describe &&
									describe.fields &&
									describe.fields.find((item) => item.name === fieldName);
								const fieldLabel = issue.fieldLabel || (field && field.label) || fieldName;
								const controller = field && field.controllerName;
								const controllerField =
									controller && describe.fields.find((item) => item.name === controller);
								const picklistGuidance =
									issue.errorCode === 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST'
										? controller
											? 'Review ' +
												(controllerField?.label || controller) +
												', then choose an available ' +
												fieldLabel +
												' value in the record editor and retry.'
											: 'Choose a picklist value available for this record in the record editor, then retry.'
										: '';
								const record = canvasState.bulkRecords.find(
									(item) => String(item.id) === String(issue.recordId),
								);
								const editAttributes = uploadResultEditAttributes({ tempId: issue.recordId });
								const apiNames = (issue.fields || [issue.field]).filter(
									(name) => name && /^[A-Za-z]/.test(name),
								);
								return (
									'<div class="upload-fix-row"><div class="upload-fix-copy"><div>' +
									'<span class="upload-fix-object">' +
									escapeHtml(identity.objectLabel) +
									' · </span><strong>' +
									escapeHtml(identity.name) +
									(identity.cardNumber ? ' #' + escapeHtml(identity.cardNumber) : '') +
									'</strong>' +
									(record && record.pendingDelete
										? ' — marked for delete'
										: fieldLabel
											? ' — <strong>' + escapeHtml(fieldLabel) + '</strong>'
											: '') +
									(apiNames.length
										? ' <code>' + apiNames.map(escapeHtml).join(', ') + '</code>'
										: '') +
									'</div>' +
									'<div class="upload-fix-message">' +
									escapeHtml(issue.message || 'Salesforce rejected this record.') +
									'</div>' +
									(picklistGuidance
										? '<div class="upload-fix-message">' + escapeHtml(picklistGuidance) + '</div>'
										: '') +
									(issue.errorCode
										? '<div class="upload-error-details">' + escapeHtml(issue.errorCode) + '</div>'
										: '') +
									'</div>' +
									(editAttributes
										? '<button type="button" class="button upload-fix-button" data-upload-fix="true"' +
											editAttributes +
											(/^[A-Za-z]/.test(fieldName)
												? ' data-upload-focus-field="' + escapeHtml(fieldName) + '"'
												: '') +
											'>Fix <span aria-hidden="true">→</span></button>'
										: '') +
									'</div>'
								);
							})
							.join('');
						return (
							'<details class="upload-fix-group" open><summary><span class="upload-fix-dot" aria-hidden="true"></span><strong>' +
							escapeHtml(group.heading) +
							'</strong><span class="upload-fix-group-count">' +
							recordCount +
							(recordCount === 1 ? ' record' : ' records') +
							'</span></summary>' +
							rows +
							'</details>'
						);
					})
					.join('');
			}

			function renderBlockingUploadIssues(issues) {
				_fixTasks?.present(
					issues,
					'local',
					_scopedRealRecords().map((record) => record.id),
				);
				resetSampleFailureActions();
				uploadModal.classList.add('upload-fix-state');
				uploadModal.querySelector('#upload-modal-title').textContent = 'Fix before uploading';
				const content = uploadModal.querySelector('#upload-modal-content');
				content.innerHTML =
					'<div class="upload-fix-banner" role="status"><span aria-hidden="true">!</span><strong>' +
					issues.length +
					(issues.length === 1 ? ' issue blocks' : ' issues block') +
					' this upload</strong></div>' +
					'<div class="upload-fix-section">Must fix <span>' +
					issues.length +
					'</span></div>' +
					uploadIssueGroupsHtml(issues);
				bindUploadResultCards(content);
				const confirmBtn = uploadModal.querySelector('#upload-confirm');
				confirmBtn.disabled = true;
				confirmBtn.style.display = '';
				confirmBtn.textContent = 'Fix ' + issues.length + ' to continue';
				confirmBtn.onclick = null;
				confirmBtn.classList.remove('confirm-anyway', 'confirm-danger');
			}

			function _clearCommittedMigrationMatch(rec) {
				delete rec._migrateMatchedId;
				delete rec._migrateMatchKey;
				delete rec._migrateMatchValue;
				delete rec._migrateMatchAmbiguous;
				delete rec._migrateMatchResolution;
				delete rec._migrateMatchIntent;
				delete rec._migrateMatchCandidates;
				delete rec._migrateFieldResolutions;
			}

			function _clearSubmittedEncryptedValues(synced, submittedSnapshots, canonicalValues) {
				for (const result of synced || []) {
					const record = canvasState.bulkRecords.find(
						(candidate) => candidate && candidate.id === result.tempId,
					);
					const submitted =
						submittedSnapshots && typeof submittedSnapshots.get === 'function'
							? submittedSnapshots.get(result.tempId)
							: submittedSnapshots && submittedSnapshots[result.tempId];
					if (!record || !submitted) {
						continue;
					}
					const encryptedNames = encryptedFields.fieldNames(canvasState, record.objectName);
					const submittedEncrypted = Object.keys(submitted.values || {}).filter((fieldName) =>
						encryptedNames.has(fieldName),
					);
					encryptedFields.clearSubmitted(record, submittedEncrypted);
					const canonical = canonicalValues && canonicalValues[result.tempId];
					for (const fieldName of submittedEncrypted) {
						if (canonical && Object.prototype.hasOwnProperty.call(canonical, fieldName)) {
							continue;
						}
						if (record.values) {
							delete record.values[fieldName];
						}
						if (record.loadedValues) {
							delete record.loadedValues[fieldName];
						}
					}
				}
			}

			function _applyRecoveredIds(realIdByTempId, canonicalValues, submittedSnapshots) {
				reconcileSyncedRecords(
					canvasState.bulkRecords,
					Array.from(realIdByTempId, ([tempId, id]) => ({ tempId, id })),
					canonicalValues,
					submittedSnapshots,
					canvasState.bulkAssociations,
				);
				_clearSubmittedEncryptedValues(
					Array.from(realIdByTempId, ([tempId, id]) => ({ tempId, id })),
					submittedSnapshots,
					canonicalValues,
				);
				canvasState.bulkRecords.forEach((rec) => {
					if (realIdByTempId.has(rec.id)) {
						_clearCommittedMigrationMatch(rec);
					}
				});
				if (typeof renderBulkView === 'function') {
					renderBulkView();
				}
				publishPresenceChanges();
			}

			async function reconcileLostUpload(attemptedRecords, submittedSnapshots) {
				// Recover a committed response lost to navigation or transport failure without re-uploading.
				try {
					const wantObjByTempId = new Map();
					(attemptedRecords || []).forEach((r) => {
						if (r && r.tempId != null && !r.loadedFromId) {
							wantObjByTempId.set(r.tempId, r.objectName);
						}
					});
					if (wantObjByTempId.size === 0) {
						return 0;
					}
					const listR = await csrfFetch('/api/upload-batches?limit=5', { credentials: 'same-origin' });
					if (!listR.ok) {
						return 0;
					}
					const listBody = await listR.json().catch(() => ({}));
					const batches = Array.isArray(listBody.batches) ? listBody.batches : [];
					const cutoff = Date.now() - 15 * 60 * 1000;
					const tokenMatches = _uploadAttemptId
						? batches.filter((b) => b && b.id && b.attemptId === _uploadAttemptId)
						: [];
					const byToken = tokenMatches.length > 0;
					const candidates = byToken
						? tokenMatches
						: batches.filter((b) => b && b.id && !(b.createdAt && b.createdAt < cutoff));
					const realIdByTempId = new Map();
					for (const b of candidates) {
						const detR = await csrfFetch('/api/upload-batches/' + encodeURIComponent(b.id), {
							credentials: 'same-origin',
						});
						if (!detR.ok) {
							continue;
						}
						const detBody = await detR.json().catch(() => ({}));
						const inserted =
							detBody.batch && Array.isArray(detBody.batch.insertedIds) ? detBody.batch.insertedIds : [];
						if (inserted.length === 0) {
							continue;
						}
						if (
							!byToken &&
							!inserted.every(
								(ins) =>
									ins && ins.tempId != null && wantObjByTempId.get(ins.tempId) === ins.objectName,
							)
						) {
							continue;
						}
						inserted.forEach((ins) => {
							if (ins.sfId) {
								realIdByTempId.set(ins.tempId, ins.sfId);
							}
						});
					}
					if (realIdByTempId.size === 0) {
						return 0;
					}
					const canonicalValues = {};
					const recoveredRecords = Array.from(realIdByTempId, ([tempId, sfId]) => ({
						tempId,
						sfId,
						objectName: wantObjByTempId.get(tempId),
					}));
					for (let offset = 0; offset < recoveredRecords.length; offset += 200) {
						const chunk = recoveredRecords.slice(offset, offset + 200);
						try {
							const response = await csrfFetch('/api/records/refresh', {
								method: 'POST',
								credentials: 'same-origin',
								headers: { 'Content-Type': 'application/json' },
								body: JSON.stringify({
									records: chunk.map(({ objectName, sfId }) => ({ objectName, sfId })),
								}),
							});
							if (!response.ok) continue;
							const body = await response.json();
							for (const row of body.results || []) {
								const record = chunk.find(
									(candidate) =>
										candidate.objectName === row.objectName && candidate.sfId === row.sfId,
								);
								if (record && row.ok && row.values) canonicalValues[record.tempId] = row.values;
							}
						} catch (_) {
							// Recovery of a committed write must not depend on a successful follow-up read.
						}
					}
					_applyRecoveredIds(realIdByTempId, canonicalValues, submittedSnapshots);
					const warning = postUploadRefreshWarning(recoveredRecords, canonicalValues);
					if (warning) showBulkToast(warning, 'warning');
					(attemptedRecords || []).forEach((r) => {
						if (r && r.tempId != null && !r.loadedFromId && realIdByTempId.has(r.tempId)) {
							r.loadedFromId = realIdByTempId.get(r.tempId);
							if (r.values && typeof r.values === 'object') {
								r.values.Id = realIdByTempId.get(r.tempId);
							}
						}
					});
					return realIdByTempId.size;
				} catch (_e) {
					return 0;
				}
			}

			function renderAttemptIncomplete(body) {
				const content = uploadModal.querySelector('#upload-modal-content');
				const confirmBtn = uploadModal.querySelector('#upload-confirm');
				if (content) {
					content.innerHTML =
						'<div class="banner">' +
						(body && body.recoveryComplete
							? '<strong>Upload interrupted.</strong> '
							: window.ORGLOOM_DESKTOP_LIVE
								? '<strong>Upload result could not be confirmed.</strong> '
								: '<strong>Upload paused to prevent duplicate records.</strong> ') +
						escapeHtml(
							(body && body.message) ||
								'Org Loom could not confirm whether Salesforce saved the previous attempt.',
						) +
						'</div>' +
						(window.ORGLOOM_DESKTOP_LIVE || (body && body.recoveryComplete)
							? ''
							: '<div style="margin-top:0.75em">' +
								'<strong>Before uploading these drafts again:</strong>' +
								'<ol style="margin:0.45em 0 0 1.3em;padding:0">' +
								'<li>Open <strong>Upload History</strong> using the ↻ toolbar button and find the entry marked <strong>Outcome unknown</strong>.</li>' +
								'<li>Check Salesforce to see whether the affected records were saved.</li>' +
								'<li>Replace saved drafts with their existing Salesforce records. Unresolved records remain blocked from another upload.</li>' +
								'</ol>' +
								'</div>');
				}
				if (confirmBtn) {
					confirmBtn.disabled = false;
					confirmBtn.textContent = 'Close';
					confirmBtn.onclick = closeUploadModal;
				}
			}

			function displayUploadResults(results, instanceUrl, deletesResults, canonicalValues, submittedSnapshots) {
				const completedIds = new Set(results.map((r) => r.tempId));
				recoveryJournal.clear(canvasState.bulkRecords.filter((r) => completedIds.has(r.id)));
				// Only successful rows become existing records; failed rows remain editable drafts.
				_uploadAttemptId = null;
				_allowDuplicates = false;
				_baselineConfirmations = [];
				const content = uploadModal.querySelector('#upload-modal-content');
				const confirmBtn = uploadModal.querySelector('#upload-confirm');
				const accessExcluded = results.filter((r) => r.success && _accessExcludedTempIds.has(r.tempId));
				const synced = results.filter(
					(r) => r.success && r.mode !== 'unchanged' && !_accessExcludedTempIds.has(r.tempId),
				);
				const unchanged = results.filter(
					(r) => r.success && r.mode === 'unchanged' && !_accessExcludedTempIds.has(r.tempId),
				);
				const failed = results.filter((r) => !r.success);
				const deletesArr = Array.isArray(deletesResults) ? deletesResults : [];
				const deleted = deletesArr.filter((d) => d && d.success);
				const deleteFailed = deletesArr.filter((d) => d && !d.success);
				const rolledBack = failed.filter(isRolledBackUploadResult);
				const actionableFailed = failed.filter((result) => !isRolledBackUploadResult(result));
				const hasFailures = failed.length > 0 || deleteFailed.length > 0;
				uploadModal.classList.toggle('upload-results-state', hasFailures);
				uploadModal.querySelector('#upload-modal-title').textContent = 'Upload results';
				if (synced.length > 0) {
					markCanvasGuideUploadComplete();
				}
				const sfBase = (instanceUrl || '').replace(/\/+$/, '');
				const recordUrl = (objectName, id) =>
					sfBase
						? sfBase +
							'/lightning/r/' +
							encodeURIComponent(objectName) +
							'/' +
							encodeURIComponent(id) +
							'/view'
						: null;
				const identityHtml = (result) => uploadResultIdentityHtml(result, canonicalValues, submittedSnapshots);
				const recordCountText = (count, singular, plural) => count + ' ' + (count === 1 ? singular : plural);

				let html = '';
				const resultSummary = uploadModal.querySelector('#upload-result-summary');
				resultSummary.hidden = true;
				resultSummary.textContent = '';
				if (!hasFailures) {
					if (synced.length > 0) {
						html +=
							'<div class="banner success"><strong>' +
							recordCountText(synced.length, 'record', 'records') +
							' uploaded to Salesforce.</strong></div>';
					} else if (deleted.length > 0) {
						html +=
							'<div class="banner success"><strong>' +
							recordCountText(deleted.length, 'record', 'records') +
							' deleted in Salesforce.</strong></div>';
					} else if (accessExcluded.length > 0) {
						html +=
							'<div class="banner"><strong>No records were uploaded.</strong> Read-only changes remain on the canvas.</div>';
					} else {
						html +=
							'<div class="banner" style="border-left:0">No records needed updating in Salesforce.</div>';
					}
				}
				const refreshWarning = postUploadRefreshWarning(synced, canonicalValues);
				if (refreshWarning) html += '<div class="banner warning">' + escapeHtml(refreshWarning) + '</div>';
				const summaryHtml = html;
				html = '';
				if (accessExcluded.length > 0) {
					html +=
						'<div class="upload-section-head upload-section-head--muted">Won\u2019t upload (' +
						accessExcluded.length +
						')</div>' +
						'<p class="tag" style="margin-top:-0.4em">Your local changes are preserved. These records are unavailable or your Salesforce user lacks permission to make these changes.</p>' +
						'<div class="upload-results-list">' +
						accessExcluded
							.map((result) => {
								const url = recordUrl(result.objectName, result.id);
								const linkHtml = url
									? '<a class="upload-result-link" href="' +
										escapeHtml(url) +
										'" target="_blank" rel="noopener">View in Salesforce</a>'
									: '';
								return '<div class="upload-result-row">' + identityHtml(result) + linkHtml + '</div>';
							})
							.join('') +
						'</div>';
				}
				if (synced.length > 0) {
					html +=
						'<details class="upload-result-details"><summary>Uploaded (' +
						synced.length +
						')</summary>' +
						'<div class="upload-results-list">' +
						synced
							.map((r) => {
								const url = recordUrl(r.objectName, r.id);
								const linkHtml = url
									? '<a class="upload-result-link" href="' +
										escapeHtml(url) +
										'" target="_blank" rel="noopener">View in Salesforce</a>'
									: '';
								const modeLabel = r.mode === 'update' ? 'Updated' : 'Created';
								return (
									'<div class="upload-result-row">' +
									identityHtml(r) +
									linkHtml +
									'<div class="tag">' +
									modeLabel +
									'</div></div>'
								);
							})
							.join('') +
						'</div></details>';
				}
				if (unchanged.length > 0) {
					html +=
						'<details class="upload-result-details"><summary>Skipped (' +
						unchanged.length +
						')</summary>' +
						'<div class="upload-results-list">' +
						unchanged
							.map((r) => {
								const url = recordUrl(r.objectName, r.id);
								const linkHtml = url
									? '<a class="upload-result-link" href="' +
										escapeHtml(url) +
										'" target="_blank" rel="noopener">View in Salesforce</a>'
									: '';
								return '<div class="upload-result-row">' + identityHtml(r) + linkHtml + '</div>';
							})
							.join('') +
						'</div></details>';
				}
				const secondaryHtml = html;
				html = '';
				const dupFailed = failed.filter((r) => r && r.errorCode === 'DUPLICATES_DETECTED');
				const fixIssues = [...actionableFailed, ...deleteFailed].map((result) => ({
					recordId: result.tempId,
					operation: deleteFailed.includes(result) ? 'delete' : 'write',
					objectName: result.objectName,
					fields: result.fields,
					errorCode: result.errorCode,
					message:
						(result.error || 'Unknown error') +
						(result.errorCode === 'DUPLICATES_DETECTED'
							? ': a Salesforce duplicate rule matched an existing record.'
							: ''),
				}));
				_fixTasks?.present(
					fixIssues,
					'salesforce',
					_scopedRealRecords().map((record) => record.id),
				);
				if (fixIssues.length > 0) {
					html +=
						'<div class="upload-fix-banner" role="status"><span aria-hidden="true">!</span><strong>' +
						fixIssues.length +
						(fixIssues.length === 1 ? ' issue needs attention' : ' issues need attention') +
						'</strong></div><details class="upload-result-details" open><summary>Failed (' +
						fixIssues.length +
						')</summary>' +
						uploadIssueGroupsHtml(fixIssues);
					if (dupFailed.length > 0) {
						html +=
							'<div class="banner" style="margin-top:0.6em;border-left:0">' +
							'<strong>' +
							dupFailed.length +
							' record' +
							(dupFailed.length === 1 ? '' : 's') +
							' blocked by Salesforce duplicate rules.</strong> ' +
							'<button type="button" class="button secondary" id="upload-allow-dups" style="margin-left:0.4em;font-size:0.82rem;padding:0.2em 0.6em">Upload anyway</button>' +
							'</div>';
					}
					html += '</details>';
				}
				if (rolledBack.length > 0) {
					html +=
						'<details class="upload-result-details"><summary>Rolled back (' +
						rolledBack.length +
						')</summary><p>These records were not saved because another operation in the same transaction failed.</p>' +
						rolledBack
							.map(
								(result) =>
									'<div class="upload-rollback-record"' +
									uploadResultEditAttributes(result) +
									'>' +
									identityHtml(result) +
									'</div>',
							)
							.join('') +
						'</details>';
				}
				const failuresHtml = html;
				html = '';
				if (deleted.length > 0) {
					html +=
						'<div class="upload-results-list">' +
						deleted
							.map((d) => {
								return (
									'<div class="upload-result-row">' +
									identityHtml(d) +
									'<div class="tag">Deleted</div></div>'
								);
							})
							.join('') +
						'</div>';
				}
				const deletedHtml = html;
				html = '';
				content.innerHTML = summaryHtml + failuresHtml + html + deletedHtml + secondaryHtml;
				bindUploadResultCards(content);

				const _allowDupsBtn = content.querySelector('#upload-allow-dups');
				if (_allowDupsBtn) {
					_allowDupsBtn.onclick = () => {
						_allowDuplicates = true;
						const _cb = uploadModal.querySelector('#upload-confirm');
						if (_cb) {
							_cb.onclick = confirmUpload;
						}
						confirmUpload();
					};
				}

				if (deleted.length > 0) {
					const deletedTempIds = new Set(deleted.map((d) => d.tempId));
					canvasState.bulkRecords = canvasState.bulkRecords.filter((r) => !deletedTempIds.has(r.id));
					canvasState.bulkAssociations = canvasState.bulkAssociations.filter(
						(a) => !deletedTempIds.has(a.fromId) && !deletedTempIds.has(a.toId),
					);
					deletedTempIds.forEach((id) => canvasState.bulkSelectedIds.delete(id));
				}

				const realIdByTempId = new Map(synced.map((r) => [r.tempId, r.id]));
				// Salesforce canonical values win over submitted values after a successful write.
				reconcileSyncedRecords(
					canvasState.bulkRecords,
					synced,
					canonicalValues,
					submittedSnapshots,
					canvasState.bulkAssociations,
				);
				_clearSubmittedEncryptedValues(synced, submittedSnapshots, canonicalValues);
				// Only clear a skipped record's stale baseline when Salesforce supplied
				// a full snapshot for that same record. Preserve edits made in flight.
				reconcileSyncedRecords(
					canvasState.bulkRecords,
					unchanged.filter((row) => canonicalValues?.[row.tempId]?.Id === row.id),
					canonicalValues,
					submittedSnapshots,
					canvasState.bulkAssociations,
				);
				_fixTasks?.recordResults([...synced, ...failed], deletesArr);
				canvasState.bulkRecords.forEach((rec) => {
					if (realIdByTempId.has(rec.id)) {
						_clearCommittedMigrationMatch(rec);
					}
				});
				renderBulkView();
				publishPresenceChanges();
				flushAutosave();

				try {
					const _mig = window.Orgloom && window.Orgloom.canvasMigrate;
					if (_mig && _mig.isActive() && failed.length === 0 && deleteFailed.length === 0) {
						const _remaining = canvasState.bulkRecords.some(
							(r) => isUploadEligibleRecord(r) && !r.pendingDelete && !r.loadedFromId,
						);
						if (!_remaining) {
							if (window.Orgloom.canvasOrgSwitch && window.Orgloom.canvasOrgSwitch.migrationClear) {
								window.Orgloom.canvasOrgSwitch.migrationClear();
							}
							if (_mig.exit) {
								_mig.exit();
							}
							const _n = synced.length;
							const _doneMsg =
								_n > 0
									? 'Migration complete: ' +
										_n +
										' record' +
										(_n === 1 ? '' : 's') +
										' now live in this org. You’re back to a normal canvas.'
									: 'Migration complete: everything was already up to date. You’re back to a normal canvas.';
							showBulkToast(_doneMsg);
						}
					}
				} catch (_e) {}

				confirmBtn.disabled = false;
				confirmBtn.textContent = hasFailures ? 'Retry failed' : 'Close';
				confirmBtn.onclick = hasFailures
					? () => {
							confirmBtn.onclick = confirmUpload;
							confirmUpload();
						}
					: closeUploadModal;
				const cancelBtn = uploadModal.querySelector('#upload-cancel');
				if (cancelBtn) {
					cancelBtn.textContent = 'Close';
					cancelBtn.style.display = hasFailures ? '' : 'none';
				}
			}

			return {
				openUploadModal: openUploadModal,
				closeUploadModal: closeUploadModal,
				confirmUpload: confirmUpload,
				renderUploadFixes: () => _fixTasks.render(),
				clearUploadFixes: () => _fixTasks.clear(),
			};
		},
	};
})();

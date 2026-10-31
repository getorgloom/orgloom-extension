(function () {
	'use strict';
	// Debounces saves for persisted canvases and keeps unsaved work in session storage only.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.canvasAutosave = {
		mount: function mount(deps) {
			const required = ['canvasState', 'encryptedFields'];
			if (!deps) {
				throw new Error('canvas-autosave.mount: missing deps object');
			}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('canvas-autosave.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const encryptedFields = deps.encryptedFields;
			const sessionStorage = window.OrgLoom.recoveryStorage;
			if (!sessionStorage) throw new Error('canvas-autosave.mount: missing recoveryStorage');

			function _recordsForStorage(records) {
				return (records || []).map((record) => {
					if (!record || typeof record !== 'object') {
						return record;
					}
					const copy = Object.assign({}, record);
					copy.values = encryptedFields.stripValues(canvasState, record.objectName, record.values);
					if (record.loadedValues) {
						copy.loadedValues = encryptedFields.stripValues(
							canvasState,
							record.objectName,
							record.loadedValues,
						);
					}
					const intents = encryptedFields.intentNames(record, canvasState);
					if (intents.length > 0) {
						copy.encryptedFieldIntents = intents;
					}
					return copy;
				});
			}

			function _recordsFromStorage(records) {
				return _recordsForStorage(records).map((record) => {
					if (record && typeof record === 'object') {
						encryptedFields.hydrateIntents(record, record.encryptedFieldIntents, canvasState);
					}
					return record;
				});
			}

			const _CANVAS_DRAFT_KEY = 'orgloom:canvas-draft:v1';
			const _CANVAS_DRAFT_ACTIVE_KEY = 'orgloom:canvas-draft-active:v1';
			const _ORGSWITCH_STASH_KEY = 'orgloom:org-switch-stash:v1';
			const _REAUTH_FALLBACK_KEY = 'orgloom:reauth-fallback:v1';
			const _MIGRATION_KEY = 'orgloom:migration:v1';
			const _salesforceIdKey = (value) =>
				String(value || '')
					.slice(0, 15)
					.toLowerCase();
			try {
				window.localStorage.removeItem(_ORGSWITCH_STASH_KEY);
				window.localStorage.removeItem(_MIGRATION_KEY);
			} catch (_e) {}

			const SYSTEM_FIELDS_TO_STRIP = [
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
			];

			function _applyRestoredState(s, sourceOrg, targetOrg) {
				// Salesforce IDs are org-specific, so cross-org loaded records return as drafts.
				const isCrossOrg = !!sourceOrg && !!targetOrg && sourceOrg !== targetOrg;
				let convertedCount = 0;
				const converted = _recordsFromStorage(s.bulkRecords || []).map((rec) => {
					if (!rec || typeof rec !== 'object') {
						return rec;
					}
					if (isCrossOrg && rec.loadedFromId && !rec._migrateMatchedId) {
						convertedCount++;
						const encryptedIntents = encryptedFields.intentNames(rec, canvasState);
						const out = Object.assign({}, rec);
						out._wasLoadedFromOrgId = sourceOrg;
						out._wasLoadedFromId = rec.loadedFromId;
						delete out.loadedFromId;
						delete out.hasExisting;
						delete out.hasModified;
						if (out.values && typeof out.values === 'object') {
							const cleanedValues = Object.assign({}, out.values);
							for (const k of SYSTEM_FIELDS_TO_STRIP) {
								delete cleanedValues[k];
							}
							out.values = cleanedValues;
						}
						encryptedFields.hydrateIntents(out, encryptedIntents, canvasState);
						return out;
					}
					return rec;
				});
				if (isCrossOrg && Array.isArray(s.bulkAssociations)) {
					const byId = new Map(converted.filter(Boolean).map((r) => [r.id, r]));
					s.bulkAssociations.forEach((a) => {
						const child = a && byId.get(a.fromId);
						if (!child || !child.values || !a.fieldName) {
							return;
						}
						const key = Object.keys(child.values).find(
							(k) => k.toLowerCase() === String(a.fieldName).toLowerCase(),
						);
						if (key) {
							delete child.values[key];
						}
					});
				}
				if (Array.isArray(s.selectedObjects)) {
					canvasState.selectedObjects = isCrossOrg
						? s.selectedObjects.map((sel) => {
								if (!sel || typeof sel !== 'object' || !('data' in sel)) {
									return sel;
								}
								const out = Object.assign({}, sel);
								delete out.data;
								return out;
							})
						: s.selectedObjects;
				}
				if (typeof s.selectedIdSeq === 'number') {
					canvasState.selectedIdSeq = s.selectedIdSeq;
				}
				if (typeof s.activeIndex === 'number') {
					canvasState.activeIndex = s.activeIndex;
				}
				canvasState.bulkRecords = converted;
				if (Array.isArray(s.bulkAssociations)) {
					canvasState.bulkAssociations = s.bulkAssociations;
				}
				if (typeof s.bulkIdSeq === 'number') {
					canvasState.bulkIdSeq = s.bulkIdSeq;
				}
				if (Array.isArray(s.hiddenObjects)) {
					canvasState.hiddenObjects = new Set(s.hiddenObjects);
				}
				if (s.graphView) {
					canvasState.graphView = s.graphView;
				}
				if (!isCrossOrg && s.currentCanvas) {
					canvasState.currentCanvas = s.currentCanvas;
				}
				if (!isCrossOrg && s._draftCanvasId) {
					canvasState._draftCanvasId = s._draftCanvasId;
				}
				if (typeof s.bulkZoom === 'number') {
					canvasState.bulkZoom = s.bulkZoom;
				}
				if (s.diffSuppressions && typeof s.diffSuppressions === 'object') {
					canvasState.diffSuppressions = s.diffSuppressions;
				}
				if (!isCrossOrg && s._presenceCanvasId) {
					canvasState._presenceCanvasId = s._presenceCanvasId;
				}
				if (!isCrossOrg && Number.isSafeInteger(s._presenceRevision)) {
					canvasState._presenceRevision = s._presenceRevision;
				}
				canvasState._autoSpawnedPending = true;
				return { convertedCount: convertedCount, isCrossOrg: isCrossOrg };
			}

			function _orgSwitchStash(options) {
				// A short-lived, account-bound session snapshot bridges the OAuth org switch.
				options = options || {};
				const preserveState = options.preserveState !== false;
				const sourceCanvasId = (canvasState.currentCanvas && canvasState.currentCanvas.id) || null;
				try {
					const payload = {
						v: 1,
						ts: Date.now(),
						intent: options.intent || 'switch',
						preserveState: preserveState,
						hadUnsavedChanges: options.hadUnsavedChanges === true,
						sourceSfOrgId: window.SF_ORG_ID || null,
						sourceSfUserId: window.SF_USER_ID || null,
						sourceAccountId: window.ORGLOOM_ACCOUNT_ID || null,
						sourceCanvasId: sourceCanvasId,
						state: preserveState
							? {
									selectedObjects: canvasState.selectedObjects,
									selectedIdSeq: canvasState.selectedIdSeq,
									activeIndex: canvasState.activeIndex,
									bulkRecords: _recordsForStorage(canvasState.bulkRecords),
									bulkAssociations: canvasState.bulkAssociations,
									bulkIdSeq: canvasState.bulkIdSeq,
									hiddenObjects: Array.from(canvasState.hiddenObjects || []),
									graphView: canvasState.graphView,
									currentCanvas: canvasState.currentCanvas,
									_draftCanvasId: canvasState._draftCanvasId,
									bulkZoom: canvasState.bulkZoom,
									diffSuppressions: canvasState.diffSuppressions || {},
									_presenceCanvasId: canvasState._presenceCanvasId || null,
									_presenceRevision: Number.isSafeInteger(canvasState._presenceRevision)
										? canvasState._presenceRevision
										: null,
								}
							: null,
					};
					sessionStorage.setItem(_ORGSWITCH_STASH_KEY, JSON.stringify(payload));
					return true;
				} catch (_e) {
					// If the full snapshot cannot be serialized, retain enough context to reopen
					// the latest saved version after Salesforce returns.
					try {
						sessionStorage.setItem(
							_ORGSWITCH_STASH_KEY,
							JSON.stringify({
								v: 1,
								ts: Date.now(),
								intent: options.intent || 'switch',
								preserveState: preserveState,
								hadUnsavedChanges: options.hadUnsavedChanges === true,
								sourceSfOrgId: window.SF_ORG_ID || null,
								sourceSfUserId: window.SF_USER_ID || null,
								sourceAccountId: window.ORGLOOM_ACCOUNT_ID || null,
								sourceCanvasId: sourceCanvasId,
								state: null,
							}),
						);
						return true;
					} catch (_fallbackError) {}
				}
				return false;
			}

			function _consumeUserSwitchCanvasId() {
				let raw;
				try {
					raw = sessionStorage.getItem(_ORGSWITCH_STASH_KEY);
				} catch (_e) {
					return null;
				}
				if (!raw) {
					return null;
				}
				let payload;
				try {
					payload = JSON.parse(raw);
				} catch (_e) {
					return null;
				}
				const currentAccountId = window.ORGLOOM_ACCOUNT_ID || null;
				const currentOrgId = window.SF_ORG_ID || null;
				const currentUserId = window.SF_USER_ID || null;
				const sameAccount = payload && payload.sourceAccountId === currentAccountId;
				const sameOrg =
					!!payload.sourceSfOrgId &&
					!!currentOrgId &&
					_salesforceIdKey(payload.sourceSfOrgId) === _salesforceIdKey(currentOrgId);
				const sameUser =
					!!payload.sourceSfUserId &&
					!!currentUserId &&
					_salesforceIdKey(payload.sourceSfUserId) === _salesforceIdKey(currentUserId);
				const discardedIntentionalSwitch =
					payload.intent === 'switch' &&
					payload.preserveState === false &&
					sameAccount &&
					sameOrg &&
					sameUser;
				const reauthNeedsFallback =
					payload.intent === 'reauth' && sameAccount && sameOrg && sameUser && !_snapshotHasContent(payload);
				if (!sameAccount || !sameOrg || (!discardedIntentionalSwitch && !reauthNeedsFallback)) {
					return null;
				}
				try {
					sessionStorage.removeItem(_ORGSWITCH_STASH_KEY);
				} catch (_e) {}
				if (typeof payload.ts === 'number' && Date.now() - payload.ts > 10 * 60 * 1000) {
					return null;
				}
				const canvasId = String(payload.sourceCanvasId || '');
				if (reauthNeedsFallback && /^[a-zA-Z0-9]{15,18}$/.test(canvasId)) {
					try {
						sessionStorage.setItem(_REAUTH_FALLBACK_KEY, canvasId);
					} catch (_e) {}
				}
				return /^[a-zA-Z0-9]{15,18}$/.test(canvasId) ? canvasId : null;
			}

			function _consumeReauthFallbackCanvasId() {
				try {
					const canvasId = String(sessionStorage.getItem(_REAUTH_FALLBACK_KEY) || '');
					sessionStorage.removeItem(_REAUTH_FALLBACK_KEY);
					return /^[a-zA-Z0-9]{15,18}$/.test(canvasId) ? canvasId : null;
				} catch (_e) {
					return null;
				}
			}

			function _orgSwitchRestore() {
				let raw;
				try {
					raw = sessionStorage.getItem(_ORGSWITCH_STASH_KEY);
				} catch (_e) {
					return false;
				}
				if (!raw) {
					return false;
				}
				try {
					sessionStorage.removeItem(_ORGSWITCH_STASH_KEY);
				} catch (_e) {}
				let payload;
				try {
					payload = JSON.parse(raw);
				} catch (_e) {
					return false;
				}
				if (!payload || payload.v !== 1) {
					return false;
				}
				if (typeof payload.ts === 'number' && Date.now() - payload.ts > 10 * 60 * 1000) {
					return false;
				}
				const currentAccountId = window.ORGLOOM_ACCOUNT_ID || null;
				if (payload.sourceAccountId !== currentAccountId) {
					return false;
				}
				const targetOrg = window.SF_ORG_ID || null;
				const sourceOrg = payload.sourceSfOrgId || null;
				const targetUser = window.SF_USER_ID || null;
				const sourceUser = payload.sourceSfUserId || null;
				const sameOrg =
					!!sourceOrg && !!targetOrg && _salesforceIdKey(sourceOrg) === _salesforceIdKey(targetOrg);
				const sameUser =
					!!sourceUser && !!targetUser && _salesforceIdKey(sourceUser) === _salesforceIdKey(targetUser);
				if ((payload.intent === 'switch' || payload.intent === 'reauth') && (!sameOrg || !sameUser)) {
					setTimeout(() => {
						try {
							window.olToast('Started a blank canvas for the new Salesforce connection.', 'info');
						} catch (_e) {}
					}, 0);
					// Returning true marks this handoff as deliberately handled and
					// prevents an older autosave for the target identity from appearing.
					return true;
				}
				if (payload.preserveState === false) {
					return false;
				}
				if (payload.intent === 'reauth') {
					if (!sameOrg || !sameUser) {
						return false;
					}
				}
				const s = payload.state || {};
				if (
					!s ||
					(!s.currentCanvas &&
						(!Array.isArray(s.bulkRecords) || s.bulkRecords.length === 0) &&
						(!Array.isArray(s.selectedObjects) || s.selectedObjects.length === 0))
				) {
					return false;
				}
				const applied = _applyRestoredState(s, sourceOrg, targetOrg);
				setTimeout(() => {
					try {
						if (applied.isCrossOrg) {
							window.olToast(
								applied.convertedCount > 0
									? 'Canvas restored. ' +
											applied.convertedCount +
											' loaded record' +
											(applied.convertedCount === 1 ? '' : 's') +
											' converted to draft' +
											(applied.convertedCount === 1 ? '' : 's') +
											" (target org doesn't share the source org's record Ids)."
									: 'Canvas restored from the previous org.',
								'info',
							);
						} else {
							window.olToast('Canvas restored.', 'info');
						}
					} catch (_e) {}
				}, 0);
				return true;
			}

			function _stampSourceRecordTypeDevNames() {
				const cache = canvasState.describeCache || {};
				(canvasState.bulkRecords || []).forEach((rec) => {
					if (!rec || rec.isTypeNode || rec._sourceRecordTypeDeveloperName) {
						return;
					}
					const v = rec.values || {};
					const rtId = v.RecordTypeId || v.recordTypeId;
					if (!rtId) {
						return;
					}
					const d = cache[rec.objectName];
					const rts = (d && d.recordTypes) || [];
					for (let i = 0; i < rts.length; i++) {
						if (rts[i] && String(rts[i].id) === String(rtId)) {
							if (rts[i].developerName) {
								rec._sourceRecordTypeDeveloperName = rts[i].developerName;
							}
							break;
						}
					}
				});
			}

			function _hasMigrationRecordValue(record) {
				return Object.entries((record && record.values) || {}).some(
					([fieldName, value]) =>
						fieldName !== 'Id' &&
						fieldName !== 'attributes' &&
						!fieldName.startsWith('_') &&
						value != null &&
						value !== '',
				);
			}

			function _prepareMigrationState() {
				// Migration copies data rather than the source collaboration session; retain values
				// while dropping requests, restricted placeholders, and links to omitted records.
				const preparation = {
					recordCount: 0,
					excludedRecordRequestCount: 0,
					removedRequestMetadataCount: 0,
					excludedArtifactCount: 0,
					excludedAssociationCount: 0,
				};
				const keptIds = new Set();
				const keptById = new Map();
				const bulkRecords = [];
				(canvasState.bulkRecords || []).forEach((record) => {
					if (!record || typeof record !== 'object') {
						return;
					}
					if (
						record.isPending ||
						record._inaccessible ||
						record._permissionHidden ||
						record.canvasArtifact === true
					) {
						preparation.excludedArtifactCount++;
						return;
					}
					const slot = record.slot && record.slot.slotId != null ? record.slot : null;
					const wholeRecordRequest = slot && (slot.kind || 'whole-record') === 'whole-record';
					if (wholeRecordRequest && !record.loadedFromId && !_hasMigrationRecordValue(record)) {
						preparation.excludedRecordRequestCount++;
						return;
					}

					const copy = _recordsForStorage([record])[0];
					if (copy.values && typeof copy.values === 'object') {
						copy.values = Object.assign({}, copy.values);
					}
					if (slot) {
						preparation.removedRequestMetadataCount++;
						delete copy.slot;
					}
					delete copy._recipientSlot;
					delete copy._slotChangedRelationshipFields;
					delete copy._presencePromotedFrom;
					bulkRecords.push(copy);
					if (copy.id != null) {
						keptIds.add(copy.id);
						keptById.set(copy.id, copy);
					}
					if (!copy.isTypeNode) {
						preparation.recordCount++;
					}
				});

				const bulkAssociations = (canvasState.bulkAssociations || []).filter((association) => {
					const keep = association && keptIds.has(association.fromId) && keptIds.has(association.toId);
					if (!keep) {
						preparation.excludedAssociationCount++;
						const child = association && keptById.get(association.fromId);
						if (child && child.values && association.fieldName) {
							const fieldName = Object.keys(child.values).find(
								(key) => key.toLowerCase() === String(association.fieldName).toLowerCase(),
							);
							if (fieldName) {
								delete child.values[fieldName];
							}
						}
					}
					return keep;
				});
				return { bulkRecords, bulkAssociations, preparation };
			}

			function _migrationPreparation() {
				return _prepareMigrationState().preparation;
			}

			function _migrationStash(opts) {
				// Migration state stays in session storage and is bound to the initiating account.
				opts = opts || {};
				_stampSourceRecordTypeDevNames();
				const prepared = _prepareMigrationState();
				if (prepared.preparation.recordCount === 0) {
					return false;
				}
				try {
					const payload = {
						v: 1,
						ts: Date.now(),
						status: opts.status || 'in-progress',
						sourceSfOrgId: window.SF_ORG_ID || null,
						sourceAccountId: window.ORGLOOM_ACCOUNT_ID || null,
						sourceCanvasId: (canvasState.currentCanvas && canvasState.currentCanvas.id) || null,
						targetSfOrgId: opts.targetSfOrgId || null,
						preparation: prepared.preparation,
						state: {
							selectedObjects: canvasState.selectedObjects,
							selectedIdSeq: canvasState.selectedIdSeq,
							activeIndex: canvasState.activeIndex,
							bulkRecords: prepared.bulkRecords,
							bulkAssociations: prepared.bulkAssociations,
							bulkIdSeq: canvasState.bulkIdSeq,
							hiddenObjects: Array.from(canvasState.hiddenObjects || []),
							graphView: canvasState.graphView,
							bulkZoom: canvasState.bulkZoom,
						},
					};
					sessionStorage.setItem(_MIGRATION_KEY, JSON.stringify(payload));
					return true;
				} catch (_e) {
					return false;
				}
			}

			function _migrationSyncIfActive() {
				// Keep destination decisions recoverable while the guided migration remains active.
				const existing = _peekMigration();
				if (!existing || existing.status !== 'in-progress') {
					return;
				}
				if (!canvasState.migrateMode || !canvasState.migrateMode.active) {
					return;
				}
				const currentOrg = window.SF_ORG_ID || null;
				if (existing.targetSfOrgId && currentOrg !== existing.targetSfOrgId) {
					return;
				}
				try {
					existing.ts = Date.now();
					existing.state = {
						selectedObjects: canvasState.selectedObjects,
						selectedIdSeq: canvasState.selectedIdSeq,
						activeIndex: canvasState.activeIndex,
						bulkRecords: _recordsForStorage(canvasState.bulkRecords),
						bulkAssociations: canvasState.bulkAssociations,
						bulkIdSeq: canvasState.bulkIdSeq,
						hiddenObjects: Array.from(canvasState.hiddenObjects || []),
						graphView: canvasState.graphView,
						bulkZoom: canvasState.bulkZoom,
					};
					sessionStorage.setItem(_MIGRATION_KEY, JSON.stringify(existing));
				} catch (_e) {}
			}

			function _peekMigration() {
				let raw;
				try {
					raw = sessionStorage.getItem(_MIGRATION_KEY);
				} catch (_e) {
					return null;
				}
				if (!raw) {
					return null;
				}
				let payload;
				try {
					payload = JSON.parse(raw);
				} catch (_e) {
					return null;
				}
				if (!payload || payload.v !== 1) {
					return null;
				}
				const currentAccountId = window.ORGLOOM_ACCOUNT_ID || null;
				if (payload.sourceAccountId !== currentAccountId) {
					return null;
				}
				return payload;
			}

			function _migrationRestore() {
				const payload = _peekMigration();
				if (!payload) {
					return false;
				}
				const s = payload.state || {};
				if (!Array.isArray(s.bulkRecords) || s.bulkRecords.length === 0) {
					return false;
				}
				const targetOrg = window.SF_ORG_ID || null;
				const sourceOrg = payload.sourceSfOrgId || null;
				const applied = _applyRestoredState(s, sourceOrg, targetOrg);
				return {
					restored: true,
					convertedCount: applied.convertedCount,
					isCrossOrg: applied.isCrossOrg,
					sourceSfOrgId: sourceOrg,
					targetSfOrgId: payload.targetSfOrgId || null,
					preparation: payload.preparation || null,
				};
			}

			function _migrationClear() {
				try {
					sessionStorage.removeItem(_MIGRATION_KEY);
				} catch (_e) {}
			}

			function _hasPendingMigration() {
				return !!_peekMigration();
			}

			function _migrationResume() {
				const payload = _peekMigration();
				if (!payload) {
					return false;
				}
				const currentOrg = window.SF_ORG_ID || null;
				const sourceOrg = payload.sourceSfOrgId || null;
				const status = payload.status || 'in-progress';

				const isArrival = status === 'awaiting-target' && !!currentOrg && currentOrg !== sourceOrg;
				const isRecovery =
					status === 'in-progress' && !!currentOrg && currentOrg === (payload.targetSfOrgId || currentOrg);

				if (!isArrival && !isRecovery) {
					return false;
				}
				const result = _migrationRestore();
				if (!result) {
					return false;
				}
				if (isArrival) {
					try {
						payload.status = 'in-progress';
						payload.targetSfOrgId = currentOrg;
						sessionStorage.setItem(_MIGRATION_KEY, JSON.stringify(payload));
					} catch (_e) {}
				}
				result.justArrived = isArrival;
				return result;
			}

			function _autosaveIdentityKey() {
				return [
					window.ORGLOOM_ACCOUNT_ID || 'anon',
					window.SF_ORG_ID || 'no-org',
					window.SF_USER_ID || 'no-user',
				].join(':');
			}

			function _autosaveScopeKey() {
				return [
					_autosaveIdentityKey(),
					(canvasState.currentCanvas && canvasState.currentCanvas.id) || 'new',
				].join(':');
			}

			function _scopedDraftKey() {
				return _CANVAS_DRAFT_KEY + '|' + _autosaveScopeKey();
			}

			function _activeDraftPointerKey() {
				return _CANVAS_DRAFT_ACTIVE_KEY + '|' + _autosaveIdentityKey();
			}

			function _snapshotHasContent(payload) {
				const state = payload && payload.state;
				return !!(
					state &&
					((state.currentCanvas && state.currentCanvas.id) ||
						(Array.isArray(state.bulkRecords) && state.bulkRecords.length > 0) ||
						(Array.isArray(state.selectedObjects) && state.selectedObjects.length > 0))
				);
			}

			function _autosaveSnapshot() {
				try {
					const payload = {
						v: 1,
						identity: _autosaveIdentityKey(),
						scope: _autosaveScopeKey(),
						ts: Date.now(),
						state: {
							selectedObjects: canvasState.selectedObjects,
							selectedIdSeq: canvasState.selectedIdSeq,
							activeIndex: canvasState.activeIndex,
							bulkRecords: _recordsForStorage(canvasState.bulkRecords),
							bulkAssociations: canvasState.bulkAssociations,
							bulkIdSeq: canvasState.bulkIdSeq,
							hiddenObjects: Array.from(canvasState.hiddenObjects || []),
							graphView: canvasState.graphView,
							currentCanvas: canvasState.currentCanvas,
							_draftCanvasId: canvasState._draftCanvasId,
							bulkZoom: canvasState.bulkZoom,
							diffSuppressions: canvasState.diffSuppressions || {},
							_presenceCanvasId: canvasState._presenceCanvasId || null,
							_presenceRevision: Number.isSafeInteger(canvasState._presenceRevision)
								? canvasState._presenceRevision
								: null,
						},
					};
					const draftKey = _scopedDraftKey();
					sessionStorage.setItem(draftKey, JSON.stringify(payload));
					sessionStorage.setItem(_activeDraftPointerKey(), draftKey);
				} catch (_e) {}
				_migrationSyncIfActive();
			}

			let _autosaveTimer = null;
			function _autosaveSchedule() {
				if (_autosaveTimer) {
					clearTimeout(_autosaveTimer);
				}
				_autosaveTimer = setTimeout(_autosaveSnapshot, 500);
			}

			function _autosaveFlush() {
				if (_autosaveTimer) {
					clearTimeout(_autosaveTimer);
					_autosaveTimer = null;
				}
				_autosaveSnapshot();
			}

			function _autosaveClear() {
				if (_autosaveTimer) {
					clearTimeout(_autosaveTimer);
					_autosaveTimer = null;
				}
				try {
					const draftKey = _scopedDraftKey();
					const pointerKey = _activeDraftPointerKey();
					sessionStorage.removeItem(draftKey);
					if (sessionStorage.getItem(pointerKey) === draftKey) {
						sessionStorage.removeItem(pointerKey);
					}
				} catch (_e) {}
			}

			function _autosaveRestore() {
				try {
					const expectedKey = _scopedDraftKey();
					const draftKey = sessionStorage.getItem(_activeDraftPointerKey());
					if (!draftKey || draftKey.indexOf(_CANVAS_DRAFT_KEY + '|') !== 0) {
						return false;
					}
					const raw = sessionStorage.getItem(draftKey);
					if (!raw) {
						return false;
					}
					const payload = JSON.parse(raw);
					if (!payload || payload.v !== 1) {
						return false;
					}
					const identity = _autosaveIdentityKey();
					const isExactScope = payload.scope === _autosaveScopeKey();
					const isActiveSavedCanvas =
						draftKey !== expectedKey &&
						(!payload.identity || payload.identity === identity) &&
						payload.state &&
						payload.state.currentCanvas &&
						payload.state.currentCanvas.id &&
						payload.scope === identity + ':' + payload.state.currentCanvas.id;
					if (!isExactScope && !isActiveSavedCanvas) {
						return false;
					}
					const s = payload.state || {};
					if (!_snapshotHasContent(payload)) {
						return false;
					}
					if (Array.isArray(s.selectedObjects)) {
						canvasState.selectedObjects = s.selectedObjects;
					}
					if (typeof s.selectedIdSeq === 'number') {
						canvasState.selectedIdSeq = s.selectedIdSeq;
					}
					if (typeof s.activeIndex === 'number') {
						canvasState.activeIndex = s.activeIndex;
					}
					if (Array.isArray(s.bulkRecords)) {
						canvasState.bulkRecords = _recordsFromStorage(s.bulkRecords);
					}
					if (Array.isArray(s.bulkAssociations)) {
						canvasState.bulkAssociations = s.bulkAssociations;
					}
					if (typeof s.bulkIdSeq === 'number') {
						canvasState.bulkIdSeq = s.bulkIdSeq;
					}
					if (Array.isArray(s.hiddenObjects)) {
						canvasState.hiddenObjects = new Set(s.hiddenObjects);
					}
					if (s.graphView) {
						canvasState.graphView = s.graphView;
					}
					if (s.currentCanvas) {
						canvasState.currentCanvas = s.currentCanvas;
					}
					if (s._draftCanvasId) {
						canvasState._draftCanvasId = s._draftCanvasId;
					}
					if (typeof s.bulkZoom === 'number') {
						canvasState.bulkZoom = s.bulkZoom;
					}
					if (s.diffSuppressions && typeof s.diffSuppressions === 'object') {
						canvasState.diffSuppressions = s.diffSuppressions;
					}
					if (s._presenceCanvasId) {
						canvasState._presenceCanvasId = s._presenceCanvasId;
					}
					if (Number.isSafeInteger(s._presenceRevision)) {
						canvasState._presenceRevision = s._presenceRevision;
					}
					return true;
				} catch (_e) {
					return false;
				}
			}

			if (typeof window.addEventListener === 'function') {
				window.addEventListener('pagehide', _autosaveFlush);
			}

			window.Orgloom = window.Orgloom || {};
			window.Orgloom.canvasOrgSwitch = {
				stash: _orgSwitchStash,
				restore: _orgSwitchRestore,
				consumeUserSwitchCanvasId: _consumeUserSwitchCanvasId,
				consumeReauthFallbackCanvasId: _consumeReauthFallbackCanvasId,
				migrationStash: _migrationStash,
				migrationPreparation: _migrationPreparation,
				migrationResume: _migrationResume,
				migrationRestore: _migrationRestore,
				migrationClear: _migrationClear,
				hasPendingMigration: _hasPendingMigration,
				migrationSyncIfActive: _migrationSyncIfActive,
			};

			return {
				orgSwitchStash: _orgSwitchStash,
				orgSwitchRestore: _orgSwitchRestore,
				consumeUserSwitchCanvasId: _consumeUserSwitchCanvasId,
				consumeReauthFallbackCanvasId: _consumeReauthFallbackCanvasId,
				autosaveSchedule: _autosaveSchedule,
				autosaveFlush: _autosaveFlush,
				autosaveClear: _autosaveClear,
				autosaveRestore: _autosaveRestore,
				migrationStash: _migrationStash,
				migrationPreparation: _migrationPreparation,
				migrationResume: _migrationResume,
				migrationRestore: _migrationRestore,
				migrationClear: _migrationClear,
				hasPendingMigration: _hasPendingMigration,
				migrationSyncIfActive: _migrationSyncIfActive,
			};
		},
	};
})();

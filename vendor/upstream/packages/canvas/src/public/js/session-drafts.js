(function () {
	'use strict';
	// Keeps unsaved draft values in org- and canvas-scoped session storage only.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.sessionDrafts = {
		mount: function mount(deps) {
			if (!deps || !deps.canvasState || !deps.encryptedFields) {
				throw new Error('session-drafts.mount: missing canvasState');
			}
			const canvasState = deps.canvasState;
			const encryptedFields = deps.encryptedFields;
			const storage = window.OrgLoom.recoveryStorage;
			if (!storage) throw new Error('session-drafts.mount: missing recoveryStorage');

			function _storageKey(canvasId) {
				return 'orgloom:draftValues:' + canvasId;
			}

			function _readMap(canvasId) {
				if (!canvasId) {
					return {};
				}
				try {
					const raw = storage.getItem(_storageKey(canvasId));
					if (!raw) {
						return {};
					}
					const parsed = JSON.parse(raw);
					return parsed && parsed.v === 1 && parsed.values && typeof parsed.values === 'object'
						? parsed.values
						: {};
				} catch (_) {
					return {};
				}
			}

			function _writeMap(canvasId, map) {
				if (!canvasId) {
					return;
				}
				try {
					if (!map || Object.keys(map).length === 0) {
						storage.removeItem(_storageKey(canvasId));
					} else {
						storage.setItem(_storageKey(canvasId), JSON.stringify({ v: 1, ts: Date.now(), values: map }));
					}
				} catch (_) {}
			}

			function persistDraftValues(canvasId) {
				if (!canvasId) {
					return;
				}
				if (!Array.isArray(canvasState.bulkRecords)) {
					return;
				}
				const map = {};
				for (const r of canvasState.bulkRecords) {
					if (!r) {
						continue;
					}
					if (r.isTypeNode) {
						continue;
					}
					if (r.loadedFromId) {
						continue;
					} // SF record, not a draft
					const tid = _persistedTempIdOf(r);
					if (tid == null) {
						continue;
					}
					const values = encryptedFields.stripValues(canvasState, r.objectName, r.values);
					if (Object.keys(values).length === 0) {
						continue;
					}
					const safe = {};
					for (const k of Object.keys(values)) {
						const v = values[k];
						if (v == null) {
							continue;
						}
						const t = typeof v;
						if (t === 'string' || t === 'number' || t === 'boolean') {
							safe[k] = v;
						}
					}
					if (Object.keys(safe).length > 0) {
						map[String(tid)] = safe;
					}
				}
				_writeMap(canvasId, map);
			}

			function rehydrateDraftValues(canvasId) {
				if (!canvasId) {
					return 0;
				}
				if (!Array.isArray(canvasState.bulkRecords)) {
					return 0;
				}
				const map = _readMap(canvasId);
				if (!map || Object.keys(map).length === 0) {
					return 0;
				}
				let restored = 0;
				for (const r of canvasState.bulkRecords) {
					if (!r) {
						continue;
					}
					if (r.isTypeNode || r.loadedFromId) {
						continue;
					}
					const tid = _persistedTempIdOf(r);
					if (tid == null) {
						continue;
					}
					const stored = map[String(tid)];
					if (!stored || typeof stored !== 'object') {
						continue;
					}
					r.values = encryptedFields.stripValues(
						canvasState,
						r.objectName,
						Object.assign({}, r.values || {}, stored),
					);
					restored++;
				}
				return restored;
			}

			function clearDraftValues(canvasId, tempId) {
				if (!canvasId || tempId == null) {
					return;
				}
				const map = _readMap(canvasId);
				if (!map || !map[String(tempId)]) {
					return;
				}
				delete map[String(tempId)];
				_writeMap(canvasId, map);
			}

			function clearAllForCanvas(canvasId) {
				if (!canvasId) {
					return;
				}
				try {
					storage.removeItem(_storageKey(canvasId));
				} catch (_) {}
			}

			function _persistedTempIdOf(rec) {
				if (rec._persistedTempId != null) {
					return rec._persistedTempId;
				}
				if (rec.id != null) {
					return rec.id;
				}
				return null;
			}

			return {
				persistDraftValues: persistDraftValues,
				rehydrateDraftValues: rehydrateDraftValues,
				clearDraftValues: clearDraftValues,
				clearAllForCanvas: clearAllForCanvas,
			};
		},
	};
})();

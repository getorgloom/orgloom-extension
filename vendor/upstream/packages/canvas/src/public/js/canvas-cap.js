(function () {
	'use strict';
	// Applies the shared record cap consistently across import, AI, browse, and manual add flows.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.canvasCap = {
		mount: function mount(deps) {
			const required = ['canvasState', 'isRecordModified', 'getShareCountByCanvasId', 'renderBulkToolbar'];
			if (!deps) {
				throw new Error('canvas-cap.mount: missing deps object');
			}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('canvas-cap.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const isRecordModified = deps.isRecordModified;
			const getShareCountByCanvasId = deps.getShareCountByCanvasId;
			const renderBulkToolbar = deps.renderBulkToolbar;

			const _CANVAS_RECORD_CAP = 500;
			let _caps = {};

			function setCaps(caps) {
				_caps = caps || {};
			}
			function _hasCap(name) {
				return !!(_caps && _caps[name]);
			}
			function _canAuthorSlots() {
				const supported = window.OrgLoom.platform?.recordRequests;
				if (supported === false) return false;
				return _hasCap('create-slot-canvas');
			}
			function _canRunScripts() {
				return _hasCap('run-script');
			}

			function _realRecordCount() {
				return canvasState.bulkRecords.filter((r) => !r.isTypeNode).length;
			}
			function canvasCapCheck(addCount) {
				const current = _realRecordCount();
				const n = Math.max(0, addCount || 0);
				const headroom = Math.max(0, _CANVAS_RECORD_CAP - current);
				if (current + n > _CANVAS_RECORD_CAP) {
					const reason =
						n <= 1
							? 'Canvas is full (' +
								_CANVAS_RECORD_CAP +
								' records). Remove some records or split the import into smaller canvas batches.'
							: 'Loading ' +
								n +
								' records would exceed the ' +
								_CANVAS_RECORD_CAP +
								'-record canvas limit (' +
								headroom +
								' slot' +
								(headroom === 1 ? '' : 's') +
								' left). Narrow your selection or filter, or split the import into smaller canvas batches.';
					return {
						ok: false,
						blocked: true,
						attempted: n,
						headroom: headroom,
						cap: _CANVAS_RECORD_CAP,
						reason: reason,
					};
				}
				return {
					ok: true,
					blocked: false,
					attempted: n,
					headroom: headroom,
					cap: _CANVAS_RECORD_CAP,
					reason: null,
				};
			}
			function _canvasCapBlockReason(addCount) {
				return canvasCapCheck(addCount).reason;
			}
			function _modifiedLoadedCount() {
				return canvasState.bulkRecords.filter((r) => !r.isTypeNode && isRecordModified(r)).length;
			}
			function getCanvasRecordCap() {
				return _CANVAS_RECORD_CAP;
			}

			function _invalidateShareCountForCanvas(canvasId) {
				if (!canvasId) {
					return;
				}
				getShareCountByCanvasId().delete(canvasId);
				if (
					typeof canvasState.graphView !== 'undefined' &&
					canvasState.graphView === 'bulk' &&
					typeof renderBulkToolbar === 'function'
				) {
					renderBulkToolbar();
				}
			}

			return {
				setCaps: setCaps,
				_hasCap: _hasCap,
				_canAuthorSlots: _canAuthorSlots,
				_canRunScripts: _canRunScripts,
				_realRecordCount: _realRecordCount,
				canvasCapCheck: canvasCapCheck,
				_canvasCapBlockReason: _canvasCapBlockReason,
				_modifiedLoadedCount: _modifiedLoadedCount,
				getCanvasRecordCap: getCanvasRecordCap,
				_invalidateShareCountForCanvas: _invalidateShareCountForCanvas,
			};
		},
	};
})();

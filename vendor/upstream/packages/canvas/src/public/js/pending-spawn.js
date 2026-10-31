(function () {
	'use strict';
	// Materializes pending relationship placeholders after the required object metadata arrives.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.pendingSpawn = {
		mount: function mount(deps) {
			const required = [
				'canvasState',
				'canEditCanvasStructure',
				'hasCapability',
				'showBulkToast',
				'_canvasCapBlockReason',
				'addToSelection',
				'ensureDescribe',
				'cloneRecord',
				'pickRecordForFreeTypeNode',
				'renderBulkView',
				'getGraph',
			];
			if (!deps) {
				throw new Error('pending-spawn.mount: missing deps object');
			}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('pending-spawn.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const canEditCanvasStructure = deps.canEditCanvasStructure;
			const hasCapability = deps.hasCapability;
			const showBulkToast = deps.showBulkToast;
			const pushUndo = deps.pushUndo;
			const _canvasCapBlockReason = deps._canvasCapBlockReason;
			const addToSelection = deps.addToSelection;
			const ensureDescribe = deps.ensureDescribe;
			const cloneRecord = deps.cloneRecord;
			const pickRecordForFreeTypeNode = deps.pickRecordForFreeTypeNode;
			const renderBulkView = deps.renderBulkView;
			const getGraph = deps.getGraph;

			async function requireCreateAccess(objectName) {
				const listedObject = Array.isArray(canvasState.allObjects)
					? canvasState.allObjects.find((object) => object && object.name === objectName)
					: null;
				if (listedObject && listedObject.createable === true) {
					// Materialize the card immediately, then replace any stale field permissions.
					ensureDescribe(objectName, { force: true })
						.then(() => renderBulkView())
						.catch(() => {
							showBulkToast(
								'Could not refresh Salesforce field access. Reconnect and try again.',
								'error',
							);
						});
					return true;
				}
				try {
					// Fall back to a direct check when the object list is not ready.
					const describe = await ensureDescribe(objectName, { force: true });
					if (describe && describe.createable === true) {
						return true;
					}
				} catch (_error) {
					showBulkToast('Could not verify Salesforce create access. Reconnect and try again.', 'error');
					return false;
				}
				showBulkToast('Salesforce does not allow this user to create ' + objectName + ' records.', 'info');
				return false;
			}

			async function spawnDraftRecord(objectName) {
				if (!canEditCanvasStructure()) {
					showBulkToast('Only the canvas owner or an editor can add records.', 'info');
					return;
				}
				const blocked = _canvasCapBlockReason(1);
				if (blocked) {
					showBulkToast(blocked);
					return;
				}
				if (!(await requireCreateAccess(objectName))) {
					return;
				}
				let s = canvasState.selectedObjects.find((so) => so.name === objectName);
				if (!s) {
					try {
						s = await addToSelection(objectName);
					} catch (e) {
						showBulkToast('Failed to add ' + objectName + ': ' + (e.message || e), 'error');
						return;
					}
				}
				cloneRecord(objectName);
			}

			function spawnPendingRecord(worldX, worldY) {
				if (!canEditCanvasStructure()) {
					showBulkToast('Only the canvas owner or an editor can add records.', 'info');
					return;
				}
				let x, y;
				if (typeof worldX === 'number' && typeof worldY === 'number') {
					x = worldX;
					y = worldY;
				} else {
					const canvas = getGraph().querySelector('#bulk-canvas');
					const cw = (canvas && canvas.clientWidth) || 800;
					const ch = (canvas && canvas.clientHeight) || 600;
					const sl = (canvas && canvas.scrollLeft) || 0;
					const st = (canvas && canvas.scrollTop) || 0;
					const baseX = sl + cw / 2;
					const baseY = st + ch / 2;
					const STEP_X = 260;
					const STEP_Y = 170;
					const PER_ROW = 5;
					const pendingSiblings = canvasState.bulkRecords.filter((r) => r && r.isPending);
					if (pendingSiblings.length === 0) {
						x = baseX;
						y = baseY;
					} else {
						const anchor = pendingSiblings[0];
						const idx = pendingSiblings.length;
						const col = idx % PER_ROW;
						const r = Math.floor(idx / PER_ROW);
						x = anchor.x + col * STEP_X;
						y = anchor.y + r * STEP_Y;
					}
				}
				const _newId = canvasState.bulkIdSeq++;
				canvasState.bulkRecords.push({
					id: _newId,
					isTypeNode: true,
					isPending: true,
					x,
					y,
				});
				renderBulkView();
				if (typeof pushUndo === 'function') {
					pushUndo('Add record', function () {
						const i = canvasState.bulkRecords.findIndex((r) => r && r.id === _newId);
						if (i !== -1) {
							canvasState.bulkRecords.splice(i, 1);
						}
						canvasState.bulkAssociations = canvasState.bulkAssociations.filter(
							(a) => a && a.fromId !== _newId && a.toId !== _newId,
						);
						renderBulkView();
					});
				}
			}

			async function resolvePendingRecord(recId, objectName) {
				const rec = canvasState.bulkRecords.find((r) => r.id === recId);
				if (!rec || !rec.isPending) {
					return;
				}
				const blocked = _canvasCapBlockReason(1);
				if (blocked) {
					showBulkToast(blocked);
					return;
				}
				if (!(await requireCreateAccess(objectName))) {
					return;
				}
				let s = canvasState.selectedObjects.find((so) => so.name === objectName);
				if (!s) {
					try {
						s = await addToSelection(objectName);
					} catch (e) {
						showBulkToast('Failed to add ' + objectName + ': ' + (e.message || e), 'error');
						return;
					}
				}
				rec.isPending = false;
				rec.isTypeNode = false;
				rec.objectName = s.name;
				rec.label = s.label;
				rec.fromSelectionId = s.id;
				rec.values = {};
				renderBulkView();
			}

			async function resolvePendingRecordToLoad(recId, objectName) {
				const rec = canvasState.bulkRecords.find((r) => r.id === recId);
				if (!rec || !rec.isPending) {
					return;
				}
				if (!hasCapability('browse-records')) {
					showBulkToast(
						'Your workspace access does not include loading existing Salesforce records.',
						'info',
					);
					return;
				}
				const blocked = _canvasCapBlockReason(1);
				if (blocked) {
					showBulkToast(blocked);
					return;
				}
				let s = canvasState.selectedObjects.find((so) => so.name === objectName);
				if (!s) {
					try {
						s = await addToSelection(objectName);
					} catch (e) {
						showBulkToast('Failed to add ' + objectName + ': ' + (e.message || e), 'error');
						return;
					}
				}
				const cardEl = getGraph().querySelector('[data-rec-id="' + rec.id + '"]');
				const loadBtn = cardEl && cardEl.querySelector('[data-pending-pick-load]');
				pickRecordForFreeTypeNode(
					{
						id: rec.id,
						x: rec.x,
						y: rec.y,
						objectName: s.name,
						label: s.label,
					},
					loadBtn || cardEl || null,
				);
			}

			return {
				spawnDraftRecord: spawnDraftRecord,
				spawnPendingRecord: spawnPendingRecord,
				resolvePendingRecord: resolvePendingRecord,
				resolvePendingRecordToLoad: resolvePendingRecordToLoad,
			};
		},
	};
})();

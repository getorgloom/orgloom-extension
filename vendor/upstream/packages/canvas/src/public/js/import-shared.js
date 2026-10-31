(function () {
	'use strict';
	// Shared import caps, association admission, summaries, and stale-safe undo capture.

	window.OrgLoom = window.OrgLoom || {};

	function gateImportFile(file, opts) {
		const extRe = opts.extRe;
		if (!extRe.test(String(file.name || ''))) {
			return (
				'"' +
				file.name +
				'" isn\'t a ' +
				opts.extLabel +
				' file: ' +
				opts.flowLabel +
				' only accepts ' +
				opts.extLabel +
				' files.'
			);
		}
		if (file.size > opts.maxBytes) {
			return (
				'"' +
				file.name +
				'" is ' +
				(file.size / (1024 * 1024)).toFixed(1) +
				' MB, over the ' +
				Math.round(opts.maxBytes / (1024 * 1024)) +
				' MB limit for ' +
				opts.flowLabel +
				'. Was this the right file?'
			);
		}
		return null;
	}

	function captureImportFailure(flow, reason) {
		try {
			if (window.posthog && window.posthog.capture) {
				window.posthog.capture('canvas_import_failed', {
					flow: flow,
					reason: reason,
				});
			}
		} catch (_e) {}
	}

	function admitAssociation(usedFk, fromId, toId, fieldName) {
		if (fromId == null || toId == null) {
			return false;
		}
		if (typeof fieldName !== 'string' || !fieldName) {
			return false;
		}
		const fkKey = fromId + '::' + fieldName;
		if (usedFk.has(fkKey)) {
			return false;
		}
		usedFk.add(fkKey);
		return true;
	}

	function reconcileLoadedRecordAssociations(canvasState) {
		const state = canvasState || {};
		const records = Array.isArray(state.bulkRecords) ? state.bulkRecords : [];
		const selectedObjects = Array.isArray(state.selectedObjects) ? state.selectedObjects : [];
		const associations = Array.isArray(state.bulkAssociations) ? state.bulkAssociations : [];
		const idKey = (id) => (id == null ? '' : String(id).trim().slice(0, 15));
		const recordBySalesforceId = new Map();
		records.forEach((record) => {
			if (!record || record.isTypeNode || record.isPending || !record.objectName || !record.loadedFromId) {
				return;
			}
			recordBySalesforceId.set(record.objectName + '::' + idKey(record.loadedFromId), record);
		});
		const selectionById = new Map();
		const selectionByObject = new Map();
		selectedObjects.forEach((selection) => {
			if (!selection || !selection.name) {
				return;
			}
			selectionById.set(selection.id, selection);
			if (!selectionByObject.has(selection.name)) {
				selectionByObject.set(selection.name, selection);
			}
		});
		const usedFk = new Set();
		associations.forEach((association) => {
			if (association && association.fromId != null && association.fieldName) {
				usedFk.add(association.fromId + '::' + association.fieldName);
			}
		});
		let added = 0;
		records.forEach((record) => {
			if (!record || record.isTypeNode || record.isPending || !record.loadedFromId || !record.values) {
				return;
			}
			const selection = selectionById.get(record.fromSelectionId) || selectionByObject.get(record.objectName);
			const parents =
				selection && selection.data && Array.isArray(selection.data.parents) ? selection.data.parents : [];
			parents.forEach((parent) => {
				if (!parent || !parent.field || !parent.object || usedFk.has(record.id + '::' + parent.field)) {
					return;
				}
				const parentId = idKey(record.values[parent.field]);
				if (!parentId) {
					return;
				}
				const target = recordBySalesforceId.get(parent.object + '::' + parentId);
				if (
					!target ||
					target.id === record.id ||
					!admitAssociation(usedFk, record.id, target.id, parent.field)
				) {
					return;
				}
				associations.push({
					id: state.bulkIdSeq++,
					fromId: record.id,
					toId: target.id,
					fieldName: parent.field,
				});
				added++;
			});
		});
		return { added: added };
	}

	function skipSuffix(skippedRecords, skippedAssoc) {
		const dropped = [];
		if (skippedRecords > 0) {
			dropped.push(skippedRecords + ' record' + (skippedRecords === 1 ? '' : 's'));
		}
		if (skippedAssoc > 0) {
			dropped.push(skippedAssoc + ' association' + (skippedAssoc === 1 ? '' : 's'));
		}
		return dropped.length ? ' Skipped ' + dropped.join(' and ') + " that couldn't be read or resolved." : '';
	}

	function summarizeCanvasContent(canvasState) {
		const state = canvasState || {};
		const records = Array.isArray(state.bulkRecords)
			? state.bulkRecords.filter((record) => record && !record.isTypeNode && !record.isPending)
			: [];
		const selectedObjects = Array.isArray(state.selectedObjects) ? state.selectedObjects : [];
		const objectNames = new Set();
		records.forEach((record) => {
			if (record.objectName) {
				objectNames.add(record.objectName);
			}
		});
		selectedObjects.forEach((entry) => {
			if (entry && entry.name) {
				objectNames.add(entry.name);
			}
		});
		const recordCount = records.length;
		const schemaSelectionCount = selectedObjects.length;
		const deletedToEmpty = recordCount === 0 && state._bulkUserDeleted === true;
		const schemaOnly = recordCount === 0 && schemaSelectionCount > 0 && !deletedToEmpty;
		return {
			hasContent: recordCount > 0 || schemaOnly,
			recordCount,
			existingCount: records.filter((record) => !!record.loadedFromId).length,
			draftCount: records.filter((record) => !record.loadedFromId).length,
			pendingDeleteCount: records.filter((record) => !!record.pendingDelete).length,
			associationCount: Array.isArray(state.bulkAssociations) ? state.bulkAssociations.length : 0,
			objectCount: objectNames.size,
			schemaSelectionCount,
			schemaOnly,
			title: state.currentCanvas && state.currentCanvas.title ? state.currentCanvas.title : null,
		};
	}

	function makeUndoCapture(deps) {
		const canvasState = deps.canvasState;
		const renderAll = deps.renderAll;
		const showBulkToast = deps.showBulkToast;
		return function captureUndoSnapshot() {
			const snap = {
				selectedObjects: canvasState.selectedObjects.slice(),
				selectedIdSeq: canvasState.selectedIdSeq,
				activeIndex: canvasState.activeIndex,
				hiddenObjects: new Set(canvasState.hiddenObjects),
				bulkRecords: canvasState.bulkRecords.slice(),
				bulkAssociations: canvasState.bulkAssociations.slice(),
				bulkInitialized: canvasState.bulkInitialized,
				currentCanvas: canvasState.currentCanvas,
			};
			let armed = null;
			function fingerprint() {
				try {
					return JSON.stringify({
						records: (canvasState.bulkRecords || []).map((r) => ({
							id: r.id,
							objectName: r.objectName,
							loadedFromId: r.loadedFromId || null,
							pendingDelete: !!r.pendingDelete,
							values: r.values || {},
						})),
						associations: (canvasState.bulkAssociations || []).map((a) => ({
							fromId: a.fromId,
							toId: a.toId,
							fieldName: a.fieldName,
						})),
						selected: (canvasState.selectedObjects || []).map((s) => s && s.name),
						hidden: Array.from(canvasState.hiddenObjects || []),
						currentCanvasId: canvasState.currentCanvas && canvasState.currentCanvas.id,
					});
				} catch (_e) {
					return null;
				}
			}
			function restore() {
				if (
					armed &&
					(canvasState.bulkRecords !== armed.records ||
						canvasState.bulkAssociations !== armed.associations ||
						fingerprint() !== armed.fingerprint)
				) {
					showBulkToast('Can’t undo the import because the canvas was edited afterward.', 'info');
					return;
				}
				deps.onCanvasReplace?.();
				canvasState.selectedObjects = snap.selectedObjects;
				canvasState.selectedIdSeq = snap.selectedIdSeq;
				canvasState.activeIndex = snap.activeIndex;
				canvasState.hiddenObjects.clear();
				snap.hiddenObjects.forEach(function (v) {
					canvasState.hiddenObjects.add(v);
				});
				canvasState.bulkRecords = snap.bulkRecords;
				canvasState.bulkAssociations = snap.bulkAssociations;
				canvasState.bulkInitialized = snap.bulkInitialized;
				canvasState.currentCanvas = snap.currentCanvas;
				canvasState.bulkSelectedIds = new Set();
				canvasState.bulkSelectedEdgeId = null;
				canvasState._renderedRecIds.clear();
				renderAll();
				showBulkToast('Import undone.');
			}
			restore.arm = function () {
				armed = {
					records: canvasState.bulkRecords,
					associations: canvasState.bulkAssociations,
					fingerprint: fingerprint(),
				};
				return restore;
			};
			return restore;
		};
	}

	window.OrgLoom.importShared = {
		gateImportFile: gateImportFile,
		captureImportFailure: captureImportFailure,
		admitAssociation: admitAssociation,
		reconcileLoadedRecordAssociations: reconcileLoadedRecordAssociations,
		skipSuffix: skipSuffix,
		summarizeCanvasContent: summarizeCanvasContent,
		makeUndoCapture: makeUndoCapture,
	};
})();

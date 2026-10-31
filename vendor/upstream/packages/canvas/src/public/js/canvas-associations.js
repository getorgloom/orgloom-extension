(function () {
	'use strict';
	// Creates one canvas edge per writable Salesforce lookup and keeps lookup values synchronized.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.canvasAssociations = {
		mount: function mount(deps) {
			const required = [
				'canvasState',
				'canEditCanvasStructure',
				'renderBulkView',
				'showBulkToast',
				'ensureDescribe',
				'pushUndo',
				'showFieldPicker',
				'getSelectedDerivedEdge',
				'setSelectedDerivedEdge',
				'_sfIdValue',
				'_sfIdMatch',
			];
			if (!deps) {
				throw new Error('canvas-associations.mount: missing deps object');
			}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('canvas-associations.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const canEditCanvasStructure = deps.canEditCanvasStructure;
			const renderBulkView = deps.renderBulkView;
			const showBulkToast = deps.showBulkToast;
			const ensureDescribe = deps.ensureDescribe;
			const pushUndo = deps.pushUndo;
			const showFieldPicker = deps.showFieldPicker;
			const getSelectedDerivedEdge = deps.getSelectedDerivedEdge;
			const setSelectedDerivedEdge = deps.setSelectedDerivedEdge;
			const _sfIdValue = deps._sfIdValue;
			const _sfIdMatch = deps._sfIdMatch;

			function inferRefFromGraphData(fromName, toName) {
				const fromObj = canvasState.selectedObjects.find((s) => s.name === fromName);
				if (fromObj && fromObj.data) {
					const p = (fromObj.data.parents || []).find((pp) => pp.object === toName);
					if (p) {
						return { direction: 'fwd', fieldName: p.field };
					}
				}
				const toObj = canvasState.selectedObjects.find((s) => s.name === toName);
				if (toObj && toObj.data) {
					const p = (toObj.data.parents || []).find((pp) => pp.object === fromName);
					if (p) {
						return { direction: 'rev', fieldName: p.field };
					}
				}
				return null;
			}

			function inferAllReferences(fromName, toName) {
				const seen = new Set();
				const out = [];
				const isExternalKeyReference = (field) =>
					!!(
						field &&
						(field.referenceTargetField ||
							(Array.isArray(field.referenceTo) &&
								field.referenceTo.some(
									(target) => typeof target === 'string' && /__x$/i.test(target),
								)) ||
							(typeof field.object === 'string' && /__x$/i.test(field.object)))
					);
				const fkWritable = (field) =>
					!isExternalKeyReference(field) &&
					((field.createable === undefined && field.updateable === undefined) ||
						!!field.createable ||
						!!field.updateable);
				const add = (direction, fieldName) => {
					const key = direction + '|' + fieldName;
					if (seen.has(key)) {
						return;
					}
					seen.add(key);
					out.push({ direction, fieldName });
				};
				const fromDesc = canvasState.describeCache[fromName];
				if (fromDesc) {
					(fromDesc.fields || []).forEach((f) => {
						if (f.type === 'reference' && (f.referenceTo || []).includes(toName) && fkWritable(f)) {
							add('fwd', f.name);
						}
					});
				}
				const toDesc = canvasState.describeCache[toName];
				if (toDesc) {
					(toDesc.fields || []).forEach((f) => {
						if (f.type === 'reference' && (f.referenceTo || []).includes(fromName) && fkWritable(f)) {
							add('rev', f.name);
						}
					});
				}

				const fromObj = canvasState.selectedObjects.find((s) => s.name === fromName);
				if (fromObj && fromObj.data) {
					(fromObj.data.parents || []).forEach((p) => {
						if (p.object === toName && fkWritable(p)) {
							add('fwd', p.field);
						}
					});
				}
				const toObj = canvasState.selectedObjects.find((s) => s.name === toName);
				if (toObj && toObj.data) {
					(toObj.data.parents || []).forEach((p) => {
						if (p.object === fromName && fkWritable(p)) {
							add('rev', p.field);
						}
					});
				}
				return out;
			}

			function createAssociation(srcRec, targetRec, direction, fieldName) {
				// A lookup field may point to only one target, even if duplicate edges are attempted.
				const fromId = direction === 'fwd' ? srcRec.id : targetRec.id;
				const toId = direction === 'fwd' ? targetRec.id : srcRec.id;
				const holderRec = canvasState.bulkRecords.find((r) => r.id === fromId);
				const targetEndRec = canvasState.bulkRecords.find((r) => r.id === toId);
				if (
					!holderRec ||
					!targetEndRec ||
					!fieldName ||
					holderRec !== (direction === 'fwd' ? srcRec : targetRec) ||
					targetEndRec !== (direction === 'fwd' ? targetRec : srcRec) ||
					canvasState.bulkAssociations.some((a) => a.fromId === fromId && a.fieldName === fieldName)
				) {
					return false;
				}
				const hadValue = Object.prototype.hasOwnProperty.call(holderRec.values || {}, fieldName);
				const previousValue = (holderRec.values || {})[fieldName];
				const link = {
					id: canvasState.bulkIdSeq++,
					fromId,
					toId,
					fieldName,
				};
				canvasState.bulkAssociations.push(link);

				if (holderRec && targetEndRec) {
					holderRec.values = holderRec.values || {};
					if (targetEndRec.loadedFromId) {
						holderRec.values[fieldName] = targetEndRec.loadedFromId;
					} else {
						delete holderRec.values[fieldName];
					}
				}
				const linkedValue = holderRec.values[fieldName];
				pushUndo('Undo connection', () => {
					if (!canvasState.bulkRecords.includes(holderRec) || !canvasState.bulkAssociations.includes(link))
						return false;
					canvasState.bulkAssociations = canvasState.bulkAssociations.filter((a) => a !== link);
					if (
						!canvasState.bulkAssociations.some((a) => a.fromId === fromId && a.fieldName === fieldName) &&
						holderRec.values[fieldName] === linkedValue
					) {
						if (hadValue) holderRec.values[fieldName] = previousValue;
						else delete holderRec.values[fieldName];
					}
					renderBulkView();
					showBulkToast('Undid connection.');
				});
				renderBulkView();
			}

			function finalizeAssociation(srcRec, targetRec, clientX, clientY) {
				if (!canEditCanvasStructure()) {
					showBulkToast('Only the canvas owner or an editor can change record relationships.', 'info');
					return false;
				}
				Promise.all([ensureDescribe(srcRec.objectName), ensureDescribe(targetRec.objectName)])
					.then(() => {
						const all = inferAllReferences(srcRec.objectName, targetRec.objectName);
						if (all.length === 0) {
							showBulkToast(
								'No reference field connects ' + srcRec.label + ' and ' + targetRec.label + '.',
								'error',
							);
							renderBulkView();
							return;
						}

						const remaining = all.filter((o) => {
							const holderId = o.direction === 'fwd' ? srcRec.id : targetRec.id;
							const occupied = canvasState.bulkAssociations.some(
								(a) => a.fromId === holderId && a.fieldName === o.fieldName,
							);
							return !occupied;
						});
						if (remaining.length === 0) {
							const fieldSubject =
								all.length === 1
									? 'A matching relationship field connects '
									: 'Matching relationship fields connect ';
							const occupiedSubject = all.length === 1 ? 'that field is' : 'those fields are';
							showBulkToast(
								fieldSubject +
									srcRec.label +
									' and ' +
									targetRec.label +
									', but ' +
									occupiedSubject +
									' already in use on this record. Each relationship field can point to only one record.',
							);
							renderBulkView();
							return;
						}
						if (remaining.length === 1) {
							createAssociation(srcRec, targetRec, remaining[0].direction, remaining[0].fieldName);
							return;
						}

						showFieldPicker(clientX, clientY, remaining, srcRec, targetRec, (opt) => {
							createAssociation(srcRec, targetRec, opt.direction, opt.fieldName);
						});
					})
					.catch((err) => {
						showBulkToast('Failed to resolve relationship: ' + err.message, 'error');
						renderBulkView();
					});
			}

			function deleteAssociation(id) {
				if (!canEditCanvasStructure()) {
					showBulkToast('Only the canvas owner or an editor can change record relationships.', 'info');
					return false;
				}
				const killed = canvasState.bulkAssociations.find((a) => a.id === id);
				const wasSelectedEdge = canvasState.bulkSelectedEdgeId === id;

				let clrId = null,
					clrField = null,
					clrHadValue = false,
					clrVal;
				if (killed) {
					const holderRec = canvasState.bulkRecords.find((r) => r.id === killed.fromId);
					const targetRec = canvasState.bulkRecords.find((r) => r.id === killed.toId);
					const tgtLoaded = targetRec && targetRec.loadedFromId;
					if (
						holderRec &&
						killed.fieldName &&
						(holderRec.values?.[killed.fieldName] == null ||
							(tgtLoaded &&
								String(holderRec.values[killed.fieldName]).slice(0, 15) ===
									String(tgtLoaded).slice(0, 15)))
					) {
						holderRec.values = holderRec.values || {};
						clrId = holderRec.id;
						clrField = killed.fieldName;
						clrHadValue = Object.prototype.hasOwnProperty.call(holderRec.values, clrField);
						clrVal = holderRec.values[killed.fieldName];
						// Omission means leave unchanged on upload; null explicitly clears the lookup.
						holderRec.values[killed.fieldName] = null;
					}
					const afterDeleteValue = holderRec?.values?.[killed.fieldName];
					pushUndo('Restore deleted connection', () => {
						if (
							!canvasState.bulkRecords.includes(holderRec) ||
							!canvasState.bulkRecords.includes(targetRec)
						)
							return false;
						if (
							canvasState.bulkAssociations.some(
								(a) => a.fromId === killed.fromId && a.fieldName === killed.fieldName,
							) ||
							holderRec.values?.[killed.fieldName] !== afterDeleteValue
						) {
							showBulkToast('Cannot restore this connection because the lookup has changed.', 'info');
							return;
						}
						canvasState.bulkAssociations.push(killed);
						if (clrId != null) {
							const hr = canvasState.bulkRecords.find((r) => r.id === clrId);
							if (hr) {
								hr.values = hr.values || {};
								if (clrHadValue) {
									hr.values[clrField] = clrVal;
								} else {
									delete hr.values[clrField];
								}
							}
						}
						if (wasSelectedEdge) {
							canvasState.bulkSelectedEdgeId = id;
						}
						renderBulkView();
						showBulkToast('Restored connection.');
					});
				}
				canvasState.bulkAssociations = canvasState.bulkAssociations.filter((a) => a.id !== id);
				if (canvasState.bulkSelectedEdgeId === id) {
					canvasState.bulkSelectedEdgeId = null;
				}
				renderBulkView();
				return true;
			}

			function deleteDerivedFkEdge(recId, fieldName) {
				if (!canEditCanvasStructure()) {
					showBulkToast('Only the canvas owner or an editor can change record relationships.', 'info');
					return false;
				}
				const rec = canvasState.bulkRecords.find((r) => r.id === recId);
				if (!rec || !rec.values || rec.values[fieldName] == null) {
					return;
				}
				const prev = rec.values[fieldName];
				pushUndo('Restore deleted connection', () => {
					const r2 = canvasState.bulkRecords.find((r) => r.id === recId);
					if (r2 !== rec) return false;
					if (
						r2.values?.[fieldName] != null ||
						canvasState.bulkAssociations.some((a) => a.fromId === recId && a.fieldName === fieldName)
					) {
						showBulkToast('Cannot restore this connection because the lookup has changed.', 'info');
						return;
					}
					if (r2) {
						r2.values = r2.values || {};
						r2.values[fieldName] = prev;
					}
					renderBulkView();
					showBulkToast('Restored connection.');
				});
				rec.values[fieldName] = null;
				const sde = getSelectedDerivedEdge();
				if (sde && sde.recId === recId && sde.fieldName === fieldName) {
					setSelectedDerivedEdge(null);
				}
				renderBulkView();
			}

			function inferAssociationsForRecord(newRec, targetSel) {
				if (!newRec || !targetSel || !targetSel.data) {
					return 0;
				}
				let added = 0;
				const ensureAssoc = (fromId, toId, fieldName) => {
					const exists = canvasState.bulkAssociations.some(
						(a) => a.fromId === fromId && a.toId === toId && a.fieldName === fieldName,
					);
					if (!exists) {
						canvasState.bulkAssociations.push({
							id: canvasState.bulkIdSeq++,
							fromId,
							toId,
							fieldName,
						});
						added++;
					}
				};
				(targetSel.data.parents || []).forEach((p) => {
					if (!p.field || !p.object) {
						return;
					}
					const parentId = newRec.values && newRec.values[p.field];
					if (!_sfIdValue(parentId)) {
						return;
					}
					const match = canvasState.bulkRecords.find(
						(r) =>
							!r.isTypeNode &&
							r.objectName === p.object &&
							_sfIdMatch(r.loadedFromId, parentId) &&
							r.id !== newRec.id,
					);
					if (match) {
						ensureAssoc(newRec.id, match.id, p.field);
					}
				});
				(targetSel.data.children || []).forEach((c) => {
					if (!c.field || !c.object) {
						return;
					}
					canvasState.bulkRecords.forEach((r) => {
						if (r.isTypeNode || r.objectName !== c.object || r.id === newRec.id) {
							return;
						}
						const ref = r.values && r.values[c.field];
						if (_sfIdMatch(ref, newRec.loadedFromId)) {
							ensureAssoc(r.id, newRec.id, c.field);
						}
					});
				});
				return added;
			}

			return {
				inferRefFromGraphData: inferRefFromGraphData,
				inferAllReferences: inferAllReferences,
				createAssociation: createAssociation,
				finalizeAssociation: finalizeAssociation,
				deleteAssociation: deleteAssociation,
				deleteDerivedFkEdge: deleteDerivedFkEdge,
				inferAssociationsForRecord: inferAssociationsForRecord,
			};
		},
	};
})();

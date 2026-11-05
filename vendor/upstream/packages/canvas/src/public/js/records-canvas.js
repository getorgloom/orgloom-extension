(function () {
	'use strict';
	// Renders record cards and relationships in Cytoscape while keeping canvas state authoritative.

	window.OrgLoom = window.OrgLoom || {};

	function reconcileExistingEdge(cy, existing, desired) {
		const desiredData = desired && desired.data;
		if (!existing || !desiredData) {
			return false;
		}
		const endpointsChanged =
			existing.data('source') !== desiredData.source || existing.data('target') !== desiredData.target;
		if (endpointsChanged) {
			existing.remove();
			cy.add(desired);
			return true;
		}
		for (const [key, value] of Object.entries(desiredData)) {
			if (key !== 'id' && key !== 'source' && key !== 'target' && existing.data(key) !== value) {
				existing.data(key, value);
			}
		}
		return false;
	}

	function canRenderDerivedRecordLink(sourceRecord, targetRecord) {
		return !!(sourceRecord && targetRecord && !sourceRecord._inaccessible && !targetRecord._inaccessible);
	}

	function migrationMatchLabel(record) {
		if (!record || !record._migrateMatchedId || !Array.isArray(record._migrateMatchCandidates)) {
			return '';
		}
		const candidate = record._migrateMatchCandidates.find((item) => item && item.id === record._migrateMatchedId);
		return candidate && candidate.label ? String(candidate.label) : '';
	}

	function recordObjectLabel(record, escapeHtml) {
		const objectName = String(record.objectName || 'Record');
		const label = String(record.label || objectName);
		return '<span class="record-type-tag" title="' + escapeHtml(label) + '">' + escapeHtml(label) + '</span>';
	}

	function recordValueTitle(rec, describe) {
		const values = (rec && rec.values) || {};
		const fullName = ((values.FirstName || '') + ' ' + (values.LastName || '')).trim();
		if (fullName) return fullName;
		const nameField = ((describe && describe.fields) || []).find((field) => field.nameField);
		const value =
			(nameField && values[nameField.name]) ||
			values.Name ||
			values.CaseNumber ||
			values.OrderNumber ||
			values.WorkOrderNumber ||
			values.Subject ||
			values.Title;
		return value ? String(value) : '';
	}

	window.OrgLoom.recordsCanvas = {
		recordValueTitle,
		_test: { reconcileExistingEdge, canRenderDerivedRecordLink, migrationMatchLabel, recordObjectLabel },
		mount: function mount(deps) {
			const required = [
				'canvasState',
				'escapeHtml',
				'showBulkToast',
				'isRecordModified',
				'recordOrdinal',
				'attachCyEdgeMarkers',
				'redrawCyEdgeMarkers',
				'attachCyMarqueeSelect',
				'attachCyMiddleClickPan',
				'attachCySpacePan',
				'attachCyWheelZoom',
				'openRecord',
				'getCanvasShareRole',
				'hasCapability',
				'isCapabilityReady',
				'publishPresenceLayout',
				'notifyCanvasContentChanged',
				'showFindObjectPopover',
				'renderBulkView',
				'renderCanvas',
				'_runAfterSchemaTransition',
				'_isEmptySlot',
				'_slotAssignmentState',
				'_slotRequestBadgeHtml',
				'_slotAssignmentCardClass',
				'_isSlotLockedForCurrentUser',
				'_slotPreflightWarn',
				'_slotProgress',
				'_slotProgressClass',
				'_ensureChipProbed',
				'_relInfoForRec',
				'_showStaleRefMenu',
				'_isRecordStale',
				'fillSlotWithBlank',
				'fillSlotWithLoad',
				'deleteRecord',
				'onRecordClick',
				'finalizeAssociation',
				'openTypeNode',
				'resolvePendingRecord',
				'resolvePendingRecordToLoad',
				'showCardMoreMenu',
				'showRelatedPopover',
				'getGraph',
				'getCyInstance',
				'setCyInstance',
				'getObjectFilterHidden',
				'getSelectedDerivedEdge',
				'setSelectedDerivedEdge',
				'getCyPendingEdge',
				'setCyPendingEdge',
				'getCySchemaInstance',
				'getSkipNextCyAutoPan',
				'setSkipNextCyAutoPan',
				'unmarkPendingDelete',
			];
			if (!deps) {
				throw new Error('records-canvas.mount: missing deps object');
			}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('records-canvas.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const escapeHtml = deps.escapeHtml;
			const showBulkToast = deps.showBulkToast;
			const isRecordModified = deps.isRecordModified;
			const recordOrdinal = deps.recordOrdinal;
			const attachCyEdgeMarkers = deps.attachCyEdgeMarkers;
			const redrawCyEdgeMarkers = deps.redrawCyEdgeMarkers;
			const attachCyMarqueeSelect = deps.attachCyMarqueeSelect;
			const attachCyMiddleClickPan = deps.attachCyMiddleClickPan;
			const attachCySpacePan = deps.attachCySpacePan;
			const attachCyWheelZoom = deps.attachCyWheelZoom;
			const openRecord = deps.openRecord;
			const getCanvasShareRole = deps.getCanvasShareRole;
			const hasCapability = deps.hasCapability;
			const isCapabilityReady = deps.isCapabilityReady;
			const publishPresenceLayout = deps.publishPresenceLayout;
			const notifyCanvasContentChanged = deps.notifyCanvasContentChanged;
			const showFindObjectPopover = deps.showFindObjectPopover;
			const renderBulkView = deps.renderBulkView;
			const renderCanvas = deps.renderCanvas;
			const _runAfterSchemaTransition = deps._runAfterSchemaTransition;
			const _isEmptySlot = deps._isEmptySlot;
			const _slotAssignmentState = deps._slotAssignmentState;
			const _slotRequestBadgeHtml = deps._slotRequestBadgeHtml;
			const _slotAssignmentCardClass = deps._slotAssignmentCardClass;
			const _isSlotLockedForCurrentUser = deps._isSlotLockedForCurrentUser;
			const _slotPreflightWarn = deps._slotPreflightWarn;
			const _slotProgress = deps._slotProgress;
			const _slotProgressClass = deps._slotProgressClass;
			const _ensureChipProbed = deps._ensureChipProbed;
			const _relInfoForRec = deps._relInfoForRec;
			const _showStaleRefMenu = deps._showStaleRefMenu;
			const _isRecordStale = deps._isRecordStale;
			const fillSlotWithBlank = deps.fillSlotWithBlank;
			const fillSlotWithLoad = deps.fillSlotWithLoad;
			const deleteRecord = deps.deleteRecord;
			const onRecordClick = deps.onRecordClick;
			const finalizeAssociation = deps.finalizeAssociation;
			const openTypeNode = deps.openTypeNode;
			const resolvePendingRecord = deps.resolvePendingRecord;
			const resolvePendingRecordToLoad = deps.resolvePendingRecordToLoad;
			const showCardMoreMenu = deps.showCardMoreMenu;
			const showRelatedPopover = deps.showRelatedPopover;
			const getGraph = deps.getGraph;
			const getCyInstance = deps.getCyInstance;
			const setCyInstance = deps.setCyInstance;
			const getObjectFilterHidden = deps.getObjectFilterHidden;
			const getSelectedDerivedEdge = deps.getSelectedDerivedEdge;
			const setSelectedDerivedEdge = deps.setSelectedDerivedEdge;
			const getCyPendingEdge = deps.getCyPendingEdge;
			const setCyPendingEdge = deps.setCyPendingEdge;
			const getCySchemaInstance = deps.getCySchemaInstance;
			const getSkipNextCyAutoPan = deps.getSkipNextCyAutoPan;
			const setSkipNextCyAutoPan = deps.setSkipNextCyAutoPan;
			const unmarkPendingDelete = deps.unmarkPendingDelete;
			const canArrangeCanvas = () => {
				const role = getCanvasShareRole();
				return !role || role === 'editor';
			};
			const restoreNodeGrabState = () => {
				const cy = getCyInstance();
				if (!cy) {
					return;
				}
				cy.nodes().forEach((node) => {
					if (canArrangeCanvas()) {
						node.grabify();
					} else {
						node.ungrabify();
					}
				});
			};
			const pendingLoadControl = () => {
				if (!isCapabilityReady()) {
					return (
						'<button type="button" class="record-pending-cta record-pending-cta-load" disabled>' +
						'Checking access&hellip;</button>'
					);
				}
				if (!hasCapability('browse-records')) {
					return (
						'<button type="button" class="record-pending-cta record-pending-cta-load" disabled ' +
						'title="Ask a workspace admin to grant Browse records access">Browse access required</button>'
					);
				}
				return (
					'<button type="button" class="record-pending-cta record-pending-cta-load" ' +
					'data-pending-pick-load title="Search and load an existing record from Salesforce">' +
					'Load from Salesforce</button>'
				);
			};

			function handleRecordContextMenu(event, container) {
				if (!canArrangeCanvas()) {
					return;
				}
				const target = event.target;
				if (
					target &&
					target.closest &&
					target.closest('input, textarea, select, [contenteditable="true"], .modal')
				) {
					return;
				}
				let card = target && target.closest && target.closest('.record-card[data-rec-id]');
				if (!card) {
					// HTML labels can pass pointer events through to Cytoscape's drawing layer.
					const cards = Array.from(container.querySelectorAll('.record-card[data-rec-id]'));
					card = cards.reverse().find((candidate) => {
						const rect = candidate.getBoundingClientRect();
						return (
							rect.width > 0 &&
							rect.height > 0 &&
							event.clientX >= rect.left &&
							event.clientX <= rect.right &&
							event.clientY >= rect.top &&
							event.clientY <= rect.bottom
						);
					});
				}
				const trigger = card && card.querySelector('[data-card-more]');
				if (!trigger) {
					return;
				}
				const recordId = Number(card.getAttribute('data-rec-id'));
				const record = canvasState.bulkRecords.find((candidate) => candidate.id === recordId);
				if (!record) {
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				showCardMoreMenu(trigger, record);
			}

			function renderBulkCanvasCy() {
				const container = getGraph().querySelector('#bulk-canvas-cy');
				if (!container) {
					return;
				}
				container.removeAttribute('title');
				if (!container._recordContextMenuInstalled) {
					container._recordContextMenuInstalled = true;
					container.addEventListener(
						'contextmenu',
						(event) => handleRecordContextMenu(event, container),
						true,
					);
				}
				if (typeof cytoscape !== 'function') {
					container.innerHTML =
						'<div class="bulk-empty" style="padding:1em">Cytoscape failed to load (check /vendor/cytoscape route).</div>';
					return;
				}

				const _cyCardHtml = (rec) => {
					if (rec.isPending) {
						let pcls = 'record-card record-card-pending';
						if (canvasState.bulkSelectedIds.has(rec.id)) {
							pcls += ' selected';
						}
						return (
							'<div class="cy-card-shell"><div class="' +
							pcls +
							'" data-rec-id="' +
							rec.id +
							'">' +
							(canArrangeCanvas()
								? '<button type="button" class="record-delete" data-record-delete title="Cancel adding a record" aria-label="Cancel adding a record">\u00D7</button>'
								: '') +
							'<div class="record-pending-title">Add a record</div>' +
							(canArrangeCanvas()
								? '<div class="record-pending-ctas">' +
									'<button type="button" class="record-pending-cta record-pending-cta-blank" data-pending-pick-blank>Create new record</button>' +
									pendingLoadControl() +
									'</div>'
								: '') +
							'</div></div>'
						);
					}
					if (rec._inaccessible) {
						let ncls = 'record-card record-card-noaccess';
						if (canvasState.bulkSelectedIds.has(rec.id)) {
							ncls += ' selected';
						}
						const objLabel = rec.label || rec.objectName;
						return (
							'<div class="cy-card-shell"><div class="' +
							ncls +
							'" data-rec-id="' +
							rec.id +
							'" ' +
							'title="This record may have been deleted, or your Salesforce access may have changed.">' +
							'<div class="record-noaccess-tag">\uD83D\uDD12 Unavailable</div>' +
							'<div class="record-noaccess-type">' +
							escapeHtml(objLabel) +
							'</div>' +
							'<div class="record-noaccess-note">This record may have been deleted, or your Salesforce access may have changed.</div>' +
							'</div></div>'
						);
					}
					if (_isEmptySlot(rec)) {
						let scls = 'record-card record-card-slot record-card--record-request';
						if (canvasState.bulkSelectedIds.has(rec.id)) {
							scls += ' selected';
						}
						scls += _slotAssignmentCardClass(rec);
						const objLabel = rec.label || rec.objectName;
						const objectNoun = String(objLabel || 'record')
							.trim()
							.toLocaleLowerCase();
						const article =
							/^(?:[aeiou]|honest|hour|heir)/i.test(objectNoun) && !/^user\b/i.test(objectNoun)
								? 'an'
								: 'a';
						const requestTitle = 'Create ' + article + ' ' + objectNoun;
						const blockedByAccess = _slotPreflightWarn(rec);
						const isLocked = _isSlotLockedForCurrentUser(rec);
						const shareRole = getCanvasShareRole();
						const contributorTask =
							(shareRole === 'contributor' || shareRole === 'editor') && rec._recipientSlot;
						const requestBadge = shareRole === 'viewer' ? '' : _slotRequestBadgeHtml(rec);
						const canEditStructure = !shareRole || shareRole === 'editor';
						const canCompleteRequest = !shareRole || shareRole === 'editor' || contributorTask;
						const accessNotice = blockedByAccess
							? '<div class="record-request-access-warning" role="note">' +
								'<strong>Cannot complete</strong>' +
								'<span>You can\u2019t complete this request with your current Salesforce permissions. Ask the canvas owner to reassign it or ask your Salesforce admin for access.</span>' +
								'</div>'
							: '';
						const ctas = !canCompleteRequest
							? ''
							: isLocked
								? ''
								: blockedByAccess
									? accessNotice +
										'<div class="record-slot-ctas"><button class="record-slot-cta" disabled>Cannot complete</button></div>'
									: '<div class="record-slot-ctas">' +
										'<button class="record-slot-cta record-slot-cta-blank" data-slot-fill-blank title="Complete this ' +
										escapeHtml(objLabel) +
										' request">Fill request</button>' +
										'</div>';
						return (
							'<div class="cy-card-shell"><div class="' +
							scls +
							'" data-rec-id="' +
							rec.id +
							'">' +
							(canEditStructure
								? '<button class="record-delete" data-record-delete title="Remove">\u00D7</button>'
								: '') +
							'<div class="record-slot-tag">RECORD REQUEST' +
							(requestBadge ? '<span class="slot-assignee-wrap">' + requestBadge + '</span>' : '') +
							'</div>' +
							'<div class="record-slot-title">' +
							escapeHtml(requestTitle) +
							'</div>' +
							ctas +
							'</div></div>'
						);
					}
					const isExisting = !!rec.loadedFromId;
					const isModified = isExisting && isRecordModified(rec);
					const isPendingDelete = isExisting && !!rec.pendingDelete;
					const shareRole = getCanvasShareRole();
					const slotKind = rec.slot && rec.slot.slotId != null ? rec.slot.kind || 'whole-record' : null;
					const showRequestContext = shareRole !== 'viewer';
					let cls = 'record-card';
					if (isPendingDelete) {
						cls += ' has-pending-delete';
					} else if (isModified) {
						cls += ' has-modified';
					} else if (isExisting) {
						cls += ' has-existing';
					} else {
						cls += ' has-draft';
					}
					if (canvasState.bulkSelectedIds.has(rec.id)) {
						cls += ' selected';
					}
					if (getCyPendingEdge() && getCyPendingEdge().srcRec && getCyPendingEdge().srcRec.id === rec.id) {
						cls += ' connect-source';
					}
					if (getCyPendingEdge() && getCyPendingEdge().hoverTargetId === rec.id) {
						cls += ' connect-target';
					}
					if (rec._refreshPulse) {
						cls += ' record-card-just-refreshed';
					}
					if (rec._deletedInSf && !rec._staleAck) {
						cls += ' record-card-deleted-in-sf';
					}
					const salesforceReadOnly = !!(
						isExisting &&
						rec._recordAccess &&
						rec._recordAccess.checked === true &&
						rec._recordAccess.hasEditAccess === false
					);
					if (salesforceReadOnly) {
						cls += ' record-card-salesforce-readonly';
					}
					cls += _slotAssignmentCardClass(rec);
					if (rec.slot && rec.slot.slotId != null && showRequestContext) {
						cls +=
							rec.slot.kind === 'fields' ? ' record-card--field-request' : ' record-card--record-request';
					}
					const titleText =
						recordValueTitle(rec, canvasState.describeCache[rec.objectName]) ||
						migrationMatchLabel(rec) ||
						(isExisting ? '(no title)' : '(no name yet)');
					let badge;
					if (isPendingDelete) {
						badge =
							'<span class="record-pending-delete-badge" title="Staged for deletion on next upload. Click Cancel deletion to undo.">delete on upload</span>';
					} else if (isModified) {
						badge =
							'<span class="record-modified-badge" title="Unsaved changes since load: Upload to Salesforce will push them">modified</span>';
					} else if (isExisting) {
						badge =
							'<span class="record-existing-badge" title="Loaded from Salesforce id ' +
							escapeHtml(rec.loadedFromId) +
							'">existing</span>';
					} else {
						badge = '<span class="record-draft-badge">draft</span>';
					}
					if (rec._importSchemaWarning) {
						const warning = rec._importSchemaWarning;
						const title = warning.objectUnavailable
							? 'This object is unavailable through the connected org. The imported record is kept, but cannot be uploaded here.'
							: 'Imported values kept but unavailable through this connection: ' +
								warning.fields.join(', ') +
								'. These fields are not uploaded.';
						badge +=
							'<span class="record-stale-badge" title="' +
							escapeHtml(title) +
							'">' +
							(warning.objectUnavailable ? 'object unavailable' : 'fields unavailable') +
							'</span>';
					}
					if (_isRecordStale(rec)) {
						badge +=
							'<span class="record-stale-badge" title="This record is unavailable in Salesforce. It may have been deleted, or your access may have changed.">unavailable in SF</span>';
						if (canArrangeCanvas()) {
							badge +=
								'<button type="button" class="record-stale-action" data-stale-menu="' +
								rec.id +
								'" title="Choose how to handle this stale reference">fix ▾</button>';
						}
					}
					if (Array.isArray(rec._loadedFieldNames)) {
						const n = rec._loadedFieldNames.length;
						badge +=
							'<span class="record-partial-badge" title="Loaded with ' +
							n +
							' field' +
							(n === 1 ? '' : 's') +
							' only; the rest are preserved on Salesforce, not editable here. Remove this record from the canvas and import it again to load all accessible fields.">partial</span>';
					}
					if (salesforceReadOnly) {
						badge +=
							rec._recordAccess.hasReadAccess === false
								? '<span class="record-readonly-badge" title="This record may have been deleted, or your Salesforce user no longer has access.">unavailable</span>'
								: '<span class="record-readonly-badge" title="Your Salesforce user can view this record but cannot update it.">read-only</span>';
					}
					const requestBadge = slotKind && showRequestContext ? _slotRequestBadgeHtml(rec) : '';
					const requestBadges = requestBadge
						? '<div class="record-request-badges">' + requestBadge + '</div>'
						: '';
					badge += requestBadges;
					const sfBase = (window.SF_INSTANCE_URL || '').replace(/\/+$/, '');
					const lightningUrl =
						isExisting && rec.loadedFromId && sfBase
							? sfBase +
								'/lightning/r/' +
								encodeURIComponent(rec.objectName) +
								'/' +
								encodeURIComponent(rec.loadedFromId) +
								'/view'
							: null;
					const titleInner = lightningUrl
						? '<a class="record-title-link" href="' +
							escapeHtml(lightningUrl) +
							'" target="_blank" rel="noopener" title="' +
							escapeHtml(titleText + ' — Open in Salesforce \u2197') +
							'">' +
							escapeHtml(titleText) +
							'</a>'
						: escapeHtml(titleText);
					let chipHtml = '';
					if (isExisting && canArrangeCanvas()) {
						chipHtml =
							'<button class="record-related-chip" data-related-pick title="See records related to this one">' +
							'\u2194 Find related' +
							'</button>';
					}
					const moreBtn = canArrangeCanvas()
						? '<button class="record-more" data-card-more title="More actions">\u22EE</button>'
						: '';
					const keepBtn =
						isPendingDelete && canArrangeCanvas()
							? '<button class="record-keep" data-card-keep title="Cancel the planned Salesforce deletion">Cancel deletion</button>'
							: '';
					return (
						'<div class="cy-card-shell"><div class="' +
						cls +
						'" data-rec-id="' +
						rec.id +
						'">' +
						badge +
						keepBtn +
						moreBtn +
						'<div class="record-title" title="' +
						escapeHtml(titleText) +
						'">' +
						titleInner +
						'</div>' +
						'<div class="record-type">' +
						recordObjectLabel(rec, escapeHtml) +
						'<span class="record-ordinal">#' +
						recordOrdinal(rec) +
						'</span>' +
						'</div>' +
						chipHtml +
						'</div></div>'
					);
				};

				const titleFor = (rec) => {
					if (rec.isPending) {
						return 'Blank record';
					}
					if (rec._inaccessible) {
						return 'No access';
					}
					if (rec.isTypeNode) {
						return rec.label || rec.objectName;
					}
					if (rec.values) {
						const fn = rec.values.FirstName,
							ln = rec.values.LastName;
						if (fn != null || ln != null) {
							const composed = ((fn || '') + ' ' + (ln || '')).trim();
							if (composed) {
								return composed;
							}
						}
						const desc = canvasState.describeCache[rec.objectName];
						if (desc && Array.isArray(desc.fields)) {
							const nf = desc.fields.find((f) => f.nameField);
							if (nf && rec.values[nf.name]) {
								return String(rec.values[nf.name]);
							}
						}
						const generic = rec.values.Name || rec.values.Subject || rec.values.Title;
						if (generic) {
							return String(generic);
						}
					}
					const matchedLabel = migrationMatchLabel(rec);
					if (matchedLabel) {
						return matchedLabel;
					}
					return rec.loadedFromId ? '(no title)' : '(no name yet)';
				};
				const labelFor = (rec) => {
					if (rec.isPending) {
						return 'Blank record';
					}
					if (rec._inaccessible) {
						if (rec._permissionHidden) {
							return 'Hidden content\nSalesforce permissions';
						}
						return 'No access\n' + (rec.label || rec.objectName);
					}
					if (rec.isTypeNode) {
						return rec.label || rec.objectName;
					}
					const title = titleFor(rec);
					const tag = (rec.label || rec.objectName) + ' #' + recordOrdinal(rec);
					return title + '\n' + tag;
				};

				const _hiddenRecIds = new Set();
				if (getObjectFilterHidden() && getObjectFilterHidden().size > 0) {
					canvasState.bulkRecords.forEach((r) => {
						if (r && r.isTypeNode && r.objectName && getObjectFilterHidden().has(r.objectName)) {
							_hiddenRecIds.add(r.id);
						}
					});
				}

				const elements = [];
				canvasState.bulkRecords.forEach((r) => {
					if (_hiddenRecIds.has(r.id)) {
						return;
					}
					if (r._chipLoader) {
						return;
					}
					let kind;
					if (r.isPending) {
						kind = 'card-pending';
					} else if (r._inaccessible) {
						kind = 'card-noaccess';
					} else if (_isEmptySlot(r)) {
						kind = 'card-slot';
					} else if (r.isTypeNode) {
						if (r.isFreeTypeNode) {
							kind = 'tn-free';
						} else if (r.direction === 'child') {
							kind = 'tn-child';
						} else {
							kind = 'tn-parent';
						}
					} else if (r.loadedFromId) {
						kind = isRecordModified(r) ? 'card-modified' : 'card-existing';
					} else {
						kind = 'card-draft';
					}
					// Persisted canvas coordinates are the source of truth for Cytoscape placement.
					elements.push({
						group: 'nodes',
						data: {
							id: 'r' + r.id,
							recId: r.id,
							kind,
							label: labelFor(r),
							boxW: 220,
							boxH: 110,
							pendingDelete: r.pendingDelete ? 1 : 0,
						},
						position: { x: typeof r.x === 'number' ? r.x : 0, y: typeof r.y === 'number' ? r.y : 0 },
						grabbable: canArrangeCanvas(),
						selectable: !r.isTypeNode || r.isPending,
					});
				});
				canvasState.bulkAssociations.forEach((a) => {
					if (_hiddenRecIds.has(a.fromId) || _hiddenRecIds.has(a.toId)) {
						return;
					}
					elements.push({
						group: 'edges',
						data: {
							id: 'a' + a.id,
							source: 'r' + a.fromId,
							target: 'r' + a.toId,
							label: a.fieldName || '',
							kind: 'fk',
						},
					});
				});
				{
					const idKey15 = (i) => (i ? String(i).slice(0, 15) : '');
					const assocKeys = new Set();
					canvasState.bulkAssociations.forEach((a) =>
						assocKeys.add(a.fromId + '->' + a.toId + '::' + (a.fieldName || '')),
					);
					const recByLoadedId = new Map();
					canvasState.bulkRecords.forEach((r) => {
						if (r.isTypeNode || !r.loadedFromId) {
							return;
						}
						recByLoadedId.set(idKey15(r.loadedFromId), r);
					});
					const derivedKeys = new Set();
					canvasState.bulkRecords.forEach((r) => {
						if (r.isTypeNode || _hiddenRecIds.has(r.id) || !r.values) {
							return;
						}
						for (const fieldName in r.values) {
							const val = r.values[fieldName];
							if (typeof val !== 'string' || val.length < 15) {
								continue;
							}
							const tgt = recByLoadedId.get(idKey15(val));
							if (
								!tgt ||
								tgt.id === r.id ||
								_hiddenRecIds.has(tgt.id) ||
								!canRenderDerivedRecordLink(r, tgt)
							) {
								continue;
							}
							const k = r.id + '->' + tgt.id + '::' + fieldName;
							if (assocKeys.has(k) || derivedKeys.has(k)) {
								continue;
							}
							derivedKeys.add(k);
							elements.push({
								group: 'edges',
								data: {
									id: 'd' + r.id + '_' + fieldName,
									source: 'r' + r.id,
									target: 'r' + tgt.id,
									label: fieldName,
									kind: 'fk',
									holderRecId: r.id,
									fkFieldName: fieldName,
								},
							});
						}
					});
				}
				canvasState.bulkRecords.forEach((r) => {
					if (_hiddenRecIds.has(r.id)) {
						return;
					}
					if (r._chipLoader) {
						return;
					}
					if (r.hostRecordId != null && _hiddenRecIds.has(r.hostRecordId)) {
						return;
					}
					if (r.isTypeNode && r.hostRecordId != null) {
						const fieldName = r.fieldOnOther || r.fieldOnThis || '';
						const manyIsTypeNode = r.direction === 'child';
						const sourceId = manyIsTypeNode ? 'r' + r.id : 'r' + r.hostRecordId;
						const targetId = manyIsTypeNode ? 'r' + r.hostRecordId : 'r' + r.id;
						elements.push({
							group: 'edges',
							data: {
								id: 'h' + r.id,
								source: sourceId,
								target: targetId,
								kind: 'host',
								label: fieldName,
							},
						});
					}
				});

				const isFirstRender = !getCyInstance();
				const newRealNodeIds = []; // Tracked across the diff path
				if (!getCyInstance()) {
					container.classList.add('cy-initializing');
					setCyInstance(
						cytoscape({
							container,
							elements,
							style: [
								{
									selector: 'core',
									style: {
										'selection-box-color': '#d68b3c',
										'selection-box-border-color': '#d68b3c',
										'selection-box-border-width': 1,
										'selection-box-opacity': 0.12,
										'active-bg-opacity': 0,
									},
								},
								{
									selector: 'node',
									style: {
										label: 'data(label)',
										'text-valign': 'center',
										'text-halign': 'center',
										'text-wrap': 'wrap',
										'font-family': 'system-ui, sans-serif',
										color: '#e8e6e1',
										'overlay-opacity': 0,
									},
								},
								{
									selector: 'node[kind ^= "card"]',
									style: {
										shape: 'round-rectangle',
										width: 'data(boxW)',
										height: 'data(boxH)',
										'background-opacity': 0,
										'border-opacity': 0,
										label: '',
									},
								},
								{
									selector: 'node[kind ^= "tn-"]',
									style: {
										shape: 'ellipse',
										width: 80,
										height: 80,
										'background-color': '#1c2226',
										'border-width': 2,
										'text-max-width': 66,
										'font-size': 10,
										color: '#cfd6df',
									},
								},
								{ selector: 'node[kind = "tn-parent"]', style: { 'border-color': '#7ac96a' } },
								{ selector: 'node[kind = "tn-child"]', style: { 'border-color': '#6fa9d6' } },
								{
									selector: 'node[kind = "tn-free"]',
									style: { 'border-color': '#d68b3c', 'border-style': 'dashed' },
								},
								{ selector: 'node:selected', style: { 'border-color': '#d68b3c', 'border-width': 3 } },
								{
									selector: 'node.csr-flash',
									style: {
										'border-color': '#f0c244',
										'border-width': 4,
										'overlay-color': '#f0c244',
										'overlay-opacity': 0.18,
										'overlay-padding': 12,
									},
								},
								{
									selector: 'edge',
									style: {
										width: 1.5,
										'line-color': '#5a6068',
										'curve-style': 'bezier',
										'target-arrow-shape': 'triangle',
										'target-arrow-color': '#5a6068',
										label: 'data(label)',
										'font-size': 10,
										color: '#9aa0a8',
										'text-rotation': 'autorotate',
										'text-background-color': '#15171b',
										'text-background-opacity': 0.85,
										'text-background-padding': 2,
										'overlay-padding': 8,
										'overlay-opacity': 0,
									},
								},
								{
									selector: 'edge[kind = "fk"]',
									style: { 'target-arrow-shape': 'none' },
								},
								{
									selector: 'edge[kind = "fk"].edge-picked',
									style: {
										'line-color': '#f0a050',
										width: 2,
										color: '#f0a050',
										'font-weight': 600,
									},
								},
								{
									selector: 'edge[kind = "host"]',
									style: {
										'line-color': '#3a3f47',
										'line-style': 'dashed',
										'target-arrow-shape': 'none',
									},
								},
							],
							layout: { name: 'preset' },
							userZoomingEnabled: false,
							userPanningEnabled: false,
							boxSelectionEnabled: false,
							autounselectify: true,
						}),
					);

					attachCyMiddleClickPan(getCyInstance(), container);
					attachCySpacePan(getCyInstance(), container);
					attachCyEdgeMarkers(getCyInstance(), container);

					attachCyWheelZoom(getCyInstance(), container);

					// Draft labels are pointer-transparent so dragging still reaches Cytoscape.
					// Put their full-name tooltip on the canvas surface instead of intercepting input.
					getCyInstance().on('mouseover', 'node', (evt) => {
						const recId = evt.target.data('recId');
						const rec = canvasState.bulkRecords.find((r) => r.id === recId);
						const title =
							rec && !rec._inaccessible && !rec.isTypeNode && !rec.isPending
								? container.querySelector('.record-card[data-rec-id="' + rec.id + '"] .record-title')
								: null;
						if (title) {
							container.title = title.getAttribute('title') || '';
						} else {
							container.removeAttribute('title');
						}
					});
					getCyInstance().on('mouseout grab', 'node', () => container.removeAttribute('title'));
					getCyInstance().on('pan zoom', () => container.removeAttribute('title'));

					getCyInstance().on('tap', 'node', (evt) => {
						const recId = evt.target.data('recId');
						const rec = canvasState.bulkRecords.find((r) => r.id === recId);
						if (!rec) {
							return;
						}
						if (_isEmptySlot(rec)) {
							const oe = evt.originalEvent;
							const cardEl = container.querySelector('.record-card[data-rec-id="' + rec.id + '"]');
							const _hits = (el) => {
								if (!el || !oe) {
									return false;
								}
								const r = el.getBoundingClientRect();
								return (
									oe.clientX >= r.left &&
									oe.clientX <= r.right &&
									oe.clientY >= r.top &&
									oe.clientY <= r.bottom
								);
							};
							const delBtn = cardEl && cardEl.querySelector('[data-record-delete]');
							if (_hits(delBtn)) {
								deleteRecord(rec.id);
								return;
							}
							const loadBtn = cardEl && cardEl.querySelector('[data-slot-fill-load]');
							if (_hits(loadBtn)) {
								fillSlotWithLoad(rec, loadBtn);
								return;
							}
							const blankBtn = cardEl && cardEl.querySelector('[data-slot-fill-blank]');
							if (_hits(blankBtn)) {
								fillSlotWithBlank(rec);
								return;
							}
							const additive = !!(oe && (oe.metaKey || oe.ctrlKey || oe.shiftKey));
							onRecordClick(rec, { additive });
							return;
						}
						if (rec.isPending) {
							const oe = evt.originalEvent;
							const cardEl = container.querySelector(
								'.record-card-pending[data-rec-id="' + rec.id + '"]',
							);
							const hitInRect = (el) => {
								if (!el || !oe) {
									return false;
								}
								const r = el.getBoundingClientRect();
								return (
									oe.clientX >= r.left &&
									oe.clientX <= r.right &&
									oe.clientY >= r.top &&
									oe.clientY <= r.bottom
								);
							};
							const blankBtn = cardEl && cardEl.querySelector('[data-pending-pick-blank]');
							const loadBtn = cardEl && cardEl.querySelector('[data-pending-pick-load]');
							const deleteBtn = cardEl && cardEl.querySelector('[data-record-delete]');
							if (hitInRect(deleteBtn)) {
								deleteRecord(rec.id);
								return;
							}
							if (hitInRect(blankBtn)) {
								showFindObjectPopover(blankBtn, {
									header: 'Create new record',
									sub: '',
									objectFilter: (object) => object && object.createable === true,
									emptyText: 'This Salesforce user cannot create any available record types.',
									isAdded: () => false,
									onPick: (name) => resolvePendingRecord(rec.id, name),
								});
								return;
							}
							if (hitInRect(loadBtn)) {
								if (!hasCapability('browse-records')) {
									showBulkToast(
										'Your workspace access does not include loading existing Salesforce records.',
										'info',
									);
									return;
								}
								showFindObjectPopover(loadBtn, {
									header: 'Load existing record',
									sub: '',
									isAdded: () => false,
									onPick: (name) => resolvePendingRecordToLoad(rec.id, name),
								});
								return;
							}
							const additive = !!(oe && (oe.metaKey || oe.ctrlKey || oe.shiftKey));
							onRecordClick(rec, { additive });
							return;
						}
						if (rec.isTypeNode) {
							if (!rec._loading) {
								openTypeNode(rec);
							}
							return;
						}
						{
							const oe = evt.originalEvent;
							const cardEl = container.querySelector('.record-card[data-rec-id="' + rec.id + '"]');
							const _hitsRect = (el) => {
								if (!el || !oe) {
									return false;
								}
								const r = el.getBoundingClientRect();
								return (
									oe.clientX >= r.left &&
									oe.clientX <= r.right &&
									oe.clientY >= r.top &&
									oe.clientY <= r.bottom
								);
							};
							const moreBtn = cardEl && cardEl.querySelector('[data-card-more]');
							if (_hitsRect(moreBtn)) {
								showCardMoreMenu(moreBtn, rec);
								return;
							}
							const staleBtn = cardEl && cardEl.querySelector('[data-stale-menu]');
							if (_hitsRect(staleBtn)) {
								_showStaleRefMenu(staleBtn, rec);
								return;
							}
							if (rec.loadedFromId) {
								const chip = cardEl && cardEl.querySelector('[data-related-pick]');
								if (_hitsRect(chip)) {
									showRelatedPopover(chip, rec);
									return;
								}
							}
						}
						const oe = evt.originalEvent || {};
						const additive = !!(oe.metaKey || oe.ctrlKey || oe.shiftKey);
						onRecordClick(rec, { additive });
					});
					getCyInstance().on('dbltap', 'node', (evt) => {
						const recId = evt.target.data('recId');
						const rec = canvasState.bulkRecords.find((r) => r.id === recId);
						if (!rec || rec.isTypeNode || rec.isPending) {
							return;
						}
						if (rec._inaccessible) {
							showBulkToast(
								'This record isn’t available to your Salesforce user, so there’s nothing to open.',
								'info',
							);
							return;
						}
						if (_isSlotLockedForCurrentUser(rec) && rec.slot.kind !== 'fields') {
							const who = rec.slot.assigneeName || rec.slot.assigneeEmail || 'another teammate';
							showBulkToast('Reserved for ' + who + ': only they can fill this slot.', 'info');
							return;
						}
						openRecord(rec);
					});
					getCyInstance().on('tap', 'edge', (evt) => {
						const edge = evt.target;
						if (edge.data('kind') !== 'fk') {
							return;
						}
						const eid = edge.id();
						if (!eid) {
							return;
						}
						canvasState.bulkSelectedIds.clear();
						if (eid[0] === 'a') {
							const assocId = parseInt(eid.slice(1), 10);
							if (!Number.isFinite(assocId)) {
								return;
							}
							canvasState.bulkSelectedEdgeId = assocId;
							setSelectedDerivedEdge(null);
							renderBulkView();
							const a = canvasState.bulkAssociations.find((x) => x.id === assocId);
							const fieldLabel = a && a.fieldName ? a.fieldName : 'connection';
							showBulkToast('Selected ' + fieldLabel + ': press Delete to unlink.');
						} else if (eid[0] === 'd') {
							const recId = edge.data('holderRecId');
							const fieldName = edge.data('fkFieldName');
							if (recId == null || !fieldName) {
								return;
							}
							canvasState.bulkSelectedEdgeId = null;
							setSelectedDerivedEdge({ recId: recId, fieldName: fieldName });
							renderBulkView();
							showBulkToast('Selected ' + fieldName + ': press Delete to unlink.');
						}
					});
					getCyInstance().on('tap', (evt) => {
						if (evt.target === getCyInstance()) {
							canvasState.bulkSelectedIds.clear();
							canvasState.bulkSelectedEdgeId = null;
							setSelectedDerivedEdge(null);
							renderBulkView();
						}
					});
					let _cyDragGroup = null;
					getCyInstance().on('grab', 'node', (evt) => {
						const anchor = evt.target;
						const akind = anchor.data('kind') || '';
						const arecId = anchor.data('recId');
						if (akind.indexOf('card') !== 0 || arecId == null || !canvasState.bulkSelectedIds.has(arecId)) {
							_cyDragGroup = null;
							return;
						}
						const others = [];
						getCyInstance()
							.nodes()
							.forEach((n) => {
								if (n.id() === anchor.id()) {
									return;
								}
								const kind = n.data('kind') || '';
								if (kind.indexOf('card') !== 0) {
									return;
								}
								const recId = n.data('recId');
								if (recId == null || !canvasState.bulkSelectedIds.has(recId)) {
									return;
								}
								const p = n.position();
								others.push({ node: n, start: { x: p.x, y: p.y } });
							});
						if (others.length === 0) {
							_cyDragGroup = null;
							return;
						}
						const ap = anchor.position();
						_cyDragGroup = {
							anchorId: anchor.id(),
							anchorStart: { x: ap.x, y: ap.y },
							others,
						};
						others.forEach((o) => {
							try {
								o.node.scratch('_dragFollower', true);
							} catch (_) {}
						});
					});
					// Move selected cards as a rigid group while preserving each record's coordinates.
					getCyInstance().on('drag', 'node', (evt) => {
						if (!_cyDragGroup) {
							return;
						}
						if (evt.target.id() !== _cyDragGroup.anchorId) {
							return;
						}
						const cur = evt.target.position();
						const dx = cur.x - _cyDragGroup.anchorStart.x;
						const dy = cur.y - _cyDragGroup.anchorStart.y;
						_cyDragGroup.others.forEach((o) => {
							o.node.position({ x: o.start.x + dx, y: o.start.y + dy });
						});
					});
					getCyInstance().on('free', 'node', (evt) => {
						const movedRecords = [];
						const recId = evt.target.data('recId');
						const rec = canvasState.bulkRecords.find((r) => r.id === recId);
						if (rec) {
							const p = evt.target.position();
							rec.x = p.x;
							rec.y = p.y;
							movedRecords.push(rec);
						}
						if (_cyDragGroup && evt.target.id() === _cyDragGroup.anchorId) {
							_cyDragGroup.others.forEach((o) => {
								const oid = o.node.data('recId');
								const orec = canvasState.bulkRecords.find((r) => r.id === oid);
								if (!orec) {
									return;
								}
								const op = o.node.position();
								orec.x = op.x;
								orec.y = op.y;
								movedRecords.push(orec);
								try {
									o.node.scratch('_dragFollower', false);
								} catch (_) {}
							});
							_cyDragGroup = null;
						}
						if (movedRecords.length > 0) {
							notifyCanvasContentChanged();
							if (canArrangeCanvas()) {
								publishPresenceLayout(movedRecords);
							}
						}
					});

					attachCyMarqueeSelect(getCyInstance(), container, (hits, additive) => {
						const next = additive ? new Set(canvasState.bulkSelectedIds) : new Set();
						hits.forEach((node) => {
							const recId = node.data('recId');
							if (recId != null) {
								next.add(recId);
							}
						});
						canvasState.bulkSelectedIds = next;
						canvasState.bulkSelectedEdgeId = null;
						renderBulkView();
					});

					if (!container._ctaInterceptInstalled) {
						container._ctaInterceptInstalled = true;
						const _CTA_SELECTOR =
							'[data-record-delete], [data-card-more], [data-card-keep], ' +
							'[data-related-pick], [data-pending-pick-blank], [data-pending-pick-load], ' +
							'[data-slot-fill-load], [data-slot-fill-blank], [data-stale-menu]';
						container.addEventListener(
							'mousedown',
							(ev) => {
								if (ev.target && ev.target.closest && ev.target.closest(_CTA_SELECTOR)) {
									ev.stopPropagation();
								}
							},
							true /* capture */,
						);
						container.addEventListener('click', (ev) => {
							const t = ev.target;
							if (!t || !t.closest) {
								return;
							}
							const cta = t.closest(_CTA_SELECTOR);
							if (!cta) {
								return;
							}
							const cardEl = cta.closest('[data-rec-id]');
							const recId = cardEl && Number(cardEl.getAttribute('data-rec-id'));
							if (!Number.isFinite(recId)) {
								return;
							}
							const rec = canvasState.bulkRecords.find((r) => r.id === recId);
							if (!rec) {
								return;
							}
							ev.stopPropagation();
							if (
								!canArrangeCanvas() &&
								cta.matches(
									'[data-record-delete], [data-card-more], [data-card-keep], [data-related-pick], [data-pending-pick-blank], [data-pending-pick-load], [data-stale-menu]',
								)
							) {
								showBulkToast(
									'Only the canvas owner or an editor can change canvas structure.',
									'info',
								);
								return;
							}
							if (cta.matches('[data-record-delete]')) {
								deleteRecord(rec.id);
								return;
							}
							if (cta.matches('[data-card-more]')) {
								showCardMoreMenu(cta, rec);
								return;
							}
							if (cta.matches('[data-card-keep]')) {
								unmarkPendingDelete(rec.id);
								return;
							}
							if (cta.matches('[data-pending-pick-blank]')) {
								showFindObjectPopover(cta, {
									header: 'Create new record',
									sub: '',
									objectFilter: (object) => object && object.createable === true,
									emptyText: 'This Salesforce user cannot create any available record types.',
									isAdded: () => false,
									onPick: (name) => resolvePendingRecord(rec.id, name),
								});
								return;
							}
							if (cta.matches('[data-pending-pick-load]')) {
								if (!hasCapability('browse-records')) {
									showBulkToast(
										'Your workspace access does not include loading existing Salesforce records.',
										'info',
									);
									return;
								}
								showFindObjectPopover(cta, {
									header: 'Load existing record',
									sub: '',
									isAdded: () => false,
									onPick: (name) => resolvePendingRecordToLoad(rec.id, name),
								});
								return;
							}
							if (cta.matches('[data-slot-fill-blank]')) {
								fillSlotWithBlank(rec);
								return;
							}
							if (cta.matches('[data-slot-fill-load]')) {
								fillSlotWithLoad(rec, cta);
								return;
							}
							if (cta.matches('[data-related-pick]')) {
								if (rec.loadedFromId) {
									showRelatedPopover(cta, rec);
								}
								return;
							}
						});

						container.addEventListener('dblclick', (ev) => {
							const stack = document.elementsFromPoint(ev.clientX, ev.clientY);
							let cardEl = null;
							for (const el of stack) {
								if (el && el.matches && el.matches('[data-rec-id]')) {
									cardEl = el;
									break;
								}
								const a = el && el.closest && el.closest('[data-rec-id]');
								if (a) {
									cardEl = a;
									break;
								}
							}
							if (!cardEl) {
								return;
							}
							const recId = Number(cardEl.getAttribute('data-rec-id'));
							if (!Number.isFinite(recId)) {
								return;
							}
							const rec = canvasState.bulkRecords.find((r) => r.id === recId);
							if (!rec || rec.isTypeNode || rec.isPending) {
								return;
							}
							if (rec._inaccessible) {
								showBulkToast(
									'This record isn’t available to your Salesforce user, so there’s nothing to open.',
									'info',
								);
								return;
							}
							if (_isSlotLockedForCurrentUser(rec) && rec.slot.kind !== 'fields') {
								const who = rec.slot.assigneeName || rec.slot.assigneeEmail || 'another teammate';
								showBulkToast('Reserved for ' + who + ': only they can fill this slot.', 'info');
								return;
							}
							openRecord(rec);
						});
					}

					if (typeof getCyInstance().nodeHtmlLabel === 'function') {
						getCyInstance().nodeHtmlLabel([
							{
								query: 'node[kind ^= "card"]',
								valign: 'center',
								halign: 'center',
								valignBox: 'center',
								halignBox: 'center',
								tpl: function (data) {
									const rec = canvasState.bulkRecords.find((r) => r.id === data.recId);
									return rec ? _cyCardHtml(rec) : '';
								},
							},
							{
								query: 'node[kind ^= "tn-"]',
								valign: 'center',
								halign: 'center',
								valignBox: 'center',
								halignBox: 'center',
								tpl: function (data) {
									const rec = canvasState.bulkRecords.find((r) => r.id === data.recId);
									if (!rec || !rec._loading) {
										return '';
									}
									const dir = rec.isFreeTypeNode
										? 'tn-free'
										: rec.direction === 'parent'
											? 'tn-parent'
											: 'tn-child';
									return (
										'<div class="cy-tn-loading ' +
										dir +
										'"><span class="cy-tn-spinner"></span></div>'
									);
								},
							},
						]);
					}

					const CARD_EDGE_THRESHOLD = 10;
					const CARD_EDGE_OUTSET = 15;
					const _setConnectClass = (on) => {
						if (container) {
							container.classList.toggle('cy-connecting', !!on);
						}
					};
					const _ns = 'http://www.w3.org/2000/svg';
					const _updatePendingLine = () => {
						const pe = getCyPendingEdge();
						if (!pe || !pe.line) {
							return;
						}
						const rp = pe.srcCyNode.renderedPosition();
						const ox = typeof pe.anchorOffsetX === 'number' ? pe.anchorOffsetX : 0;
						const oy = typeof pe.anchorOffsetY === 'number' ? pe.anchorOffsetY : 0;
						pe.line.setAttribute('x1', rp.x + ox);
						pe.line.setAttribute('y1', rp.y + oy);
					};
					const _CTA_EDGE_SKIP_SEL =
						'[data-record-delete], [data-card-more], ' +
						'[data-related-pick], [data-pending-pick-blank], [data-pending-pick-load], ' +
						'[data-slot-fill-load], [data-slot-fill-blank], [data-stale-menu]';
					const _findEdgeTargetAt = (x, y) => {
						const containerRect = container.getBoundingClientRect();
						const inContainer =
							x >= containerRect.left &&
							x <= containerRect.right &&
							y >= containerRect.top &&
							y <= containerRect.bottom;
						if (inContainer) {
							const cards = container.querySelectorAll('.record-card[data-rec-id]');
							for (let i = cards.length - 1; i >= 0; i--) {
								const el = cards[i];
								const r = el.getBoundingClientRect();
								if (r.width === 0 || r.height === 0) {
									continue;
								}
								if (x < r.left - CARD_EDGE_OUTSET || x > r.right + CARD_EDGE_OUTSET) {
									continue;
								}
								if (y < r.top - CARD_EDGE_OUTSET || y > r.bottom + CARD_EDGE_OUTSET) {
									continue;
								}
								return { kind: 'card', el, rect: r, recId: Number(el.getAttribute('data-rec-id')) };
							}
						}
						return null;
					};
					const _isOnRectEdge = (rect, x, y) => {
						const insideX = x >= rect.left && x <= rect.right;
						const insideY = y >= rect.top && y <= rect.bottom;
						if (insideX && insideY) {
							const d = Math.min(x - rect.left, rect.right - x, y - rect.top, rect.bottom - y);
							return d <= CARD_EDGE_THRESHOLD;
						}
						const cx = Math.max(rect.left, Math.min(x, rect.right));
						const cy = Math.max(rect.top, Math.min(y, rect.bottom));
						const dx = x - cx;
						const dy = y - cy;
						return Math.hypot(dx, dy) <= CARD_EDGE_OUTSET;
					};
					const _setEdgeHoverCard = (recId) => {
						document
							.querySelectorAll('.record-card.is-edge-link')
							.forEach((el) => el.classList.remove('is-edge-link'));
						if (recId == null) {
							return;
						}
						const card = container.querySelector('.record-card[data-rec-id="' + recId + '"]');
						if (card) {
							card.classList.add('is-edge-link');
						}
					};
					document.addEventListener('mousemove', (ev) => {
						if (!canArrangeCanvas()) {
							container.classList.remove('cy-edge-hover');
							_setEdgeHoverCard(null);
							return;
						}
						if (ev.target && ev.target.closest && ev.target.closest('.modal.is-inline')) {
							container.classList.remove('cy-edge-hover');
							_setEdgeHoverCard(null);
							return;
						}
						if (getCyPendingEdge()) {
							return;
						}
						const hit = _findEdgeTargetAt(ev.clientX, ev.clientY);
						if (!hit) {
							if (container.classList.contains('cy-edge-hover')) {
								container.classList.remove('cy-edge-hover');
							}
							_setEdgeHoverCard(null);
							return;
						}
						const rec = canvasState.bulkRecords.find((r) => r.id === hit.recId);
						if (!rec || rec.isTypeNode) {
							container.classList.remove('cy-edge-hover');
							_setEdgeHoverCard(null);
							return;
						}
						const onEdge = _isOnRectEdge(hit.rect, ev.clientX, ev.clientY);
						container.classList.toggle('cy-edge-hover', onEdge);
						_setEdgeHoverCard(onEdge ? hit.recId : null);
					});
					document.addEventListener(
						'mousedown',
						(ev) => {
							if (!canArrangeCanvas()) {
								return;
							}
							if (ev.button !== 0) {
								return;
							}
							if (ev.target && ev.target.closest && ev.target.closest('.modal.is-inline')) {
								return;
							}
							if (getCyPendingEdge()) {
								return;
							}
							if (ev.target && ev.target.closest && ev.target.closest(_CTA_EDGE_SKIP_SEL)) {
								return;
							}
							if (
								ev.target &&
								ev.target.closest &&
								ev.target.closest('input, textarea, select, button, a, [contenteditable="true"]')
							) {
								return;
							}
							const hit = _findEdgeTargetAt(ev.clientX, ev.clientY);
							if (!hit) {
								return;
							}
							if (!Number.isFinite(hit.recId)) {
								return;
							}
							const rec = canvasState.bulkRecords.find((r) => r.id === hit.recId);
							if (!rec || rec.isTypeNode) {
								return;
							}
							if (!_isOnRectEdge(hit.rect, ev.clientX, ev.clientY)) {
								return;
							}
							const cyNode = getCyInstance().getElementById('r' + hit.recId);
							if (!cyNode || cyNode.length === 0) {
								return;
							}
							const svg = document.createElementNS(_ns, 'svg');
							svg.setAttribute('class', 'cy-pending-edge-svg');
							const line = document.createElementNS(_ns, 'line');
							line.setAttribute('class', 'cy-pending-edge-line');
							const _containerRect = container.getBoundingClientRect();
							const _r = hit.rect;
							const _cx = Math.max(_r.left, Math.min(ev.clientX, _r.right));
							const _cy = Math.max(_r.top, Math.min(ev.clientY, _r.bottom));
							let _clientAnchorX = _cx;
							let _clientAnchorY = _cy;
							if (_cx === ev.clientX && _cy === ev.clientY) {
								const dLeft = ev.clientX - _r.left;
								const dRight = _r.right - ev.clientX;
								const dTop = ev.clientY - _r.top;
								const dBottom = _r.bottom - ev.clientY;
								const dMin = Math.min(dLeft, dRight, dTop, dBottom);
								if (dMin === dLeft) {
									_clientAnchorX = _r.left;
								} else if (dMin === dRight) {
									_clientAnchorX = _r.right;
								} else if (dMin === dTop) {
									_clientAnchorY = _r.top;
								} else {
									_clientAnchorY = _r.bottom;
								}
							}
							const _anchorX = _clientAnchorX - _containerRect.left;
							const _anchorY = _clientAnchorY - _containerRect.top;
							const _srcRP = cyNode.renderedPosition();
							const _anchorOffsetX = _anchorX - _srcRP.x;
							const _anchorOffsetY = _anchorY - _srcRP.y;
							line.setAttribute('x1', _anchorX);
							line.setAttribute('y1', _anchorY);
							line.setAttribute('x2', _anchorX);
							line.setAttribute('y2', _anchorY);
							svg.appendChild(line);
							container.appendChild(svg);
							setCyPendingEdge({
								srcRec: rec,
								srcCyNode: cyNode,
								svg: svg,
								line: line,
								anchorOffsetX: _anchorOffsetX,
								anchorOffsetY: _anchorOffsetY,
							});
							_setConnectClass(true);
							cyNode.ungrabify();
							getCyInstance().userPanningEnabled(false);
							ev.preventDefault();
							ev.stopPropagation();
							cyNode.data('rev', (cyNode.data('rev') || 0) + 1);
						},
						true /* capture, runs before cy */,
					);
					document.addEventListener('mousemove', (ev) => {
						const pe = getCyPendingEdge();
						if (!pe || !pe.line) {
							return;
						}
						const rect = container.getBoundingClientRect();
						const px = ev.clientX - rect.left;
						const py = ev.clientY - rect.top;
						pe.line.setAttribute('x2', px);
						pe.line.setAttribute('y2', py);
						const hit = _findEdgeTargetAt(ev.clientX, ev.clientY);
						let hoverId = null;
						if (hit && hit.recId !== pe.srcRec.id) {
							const candidate = canvasState.bulkRecords.find((r) => r.id === hit.recId);
							if (candidate && !candidate.isTypeNode) {
								hoverId = hit.recId;
							}
						}
						if (hoverId !== pe.hoverTargetId) {
							const prev = pe.hoverTargetId;
							pe.hoverTargetId = hoverId;
							_bumpRev(prev);
							_bumpRev(hoverId);
						}
					});
					document.addEventListener('mouseup', (ev) => {
						const pe = getCyPendingEdge();
						if (!pe) {
							return;
						}
						let tgtRec = null;
						const hit = _findEdgeTargetAt(ev.clientX, ev.clientY);
						if (hit && hit.recId !== pe.srcRec.id) {
							const candidate = canvasState.bulkRecords.find((r) => r.id === hit.recId);
							if (candidate && !candidate.isTypeNode) {
								tgtRec = candidate;
							}
						}
						const srcRec = pe.srcRec;
						const srcId = srcRec.id;
						const hoverTargetId = pe.hoverTargetId;
						if (pe.svg && pe.svg.parentNode) {
							pe.svg.parentNode.removeChild(pe.svg);
						}
						setCyPendingEdge(null);
						_setConnectClass(false);
						container.classList.remove('cy-edge-hover');
						getCyInstance().userPanningEnabled(false);
						restoreNodeGrabState();
						const srcCyNode = getCyInstance().getElementById('r' + srcId);
						if (srcCyNode && srcCyNode.length) {
							srcCyNode.data('rev', (srcCyNode.data('rev') || 0) + 1);
						}
						if (hoverTargetId != null) {
							const tgtCyNode = getCyInstance().getElementById('r' + hoverTargetId);
							if (tgtCyNode && tgtCyNode.length) {
								tgtCyNode.data('rev', (tgtCyNode.data('rev') || 0) + 1);
							}
						}
						if (tgtRec) {
							finalizeAssociation(srcRec, tgtRec, ev.clientX, ev.clientY);
						}
					});
					const _bumpRev = (id) => {
						if (id == null) {
							return;
						}
						const n = getCyInstance().getElementById('r' + id);
						if (n && n.length) {
							n.data('rev', (n.data('rev') || 0) + 1);
						}
					};
					getCyInstance().on('mousemove', (evt) => {
						if (!getCyPendingEdge() || !getCyPendingEdge().line) {
							return;
						}
						const oe = evt.originalEvent;
						if (!oe) {
							return;
						}
						const rect = container.getBoundingClientRect();
						const px = oe.clientX - rect.left;
						const py = oe.clientY - rect.top;
						getCyPendingEdge().line.setAttribute('x2', px);
						getCyPendingEdge().line.setAttribute('y2', py);
						_updatePendingLine();
						let hit = null;
						getCyInstance()
							.nodes('node[kind ^= "card"]')
							.forEach((n) => {
								if (hit) {
									return;
								}
								const recId = n.data('recId');
								if (recId == null || recId === getCyPendingEdge().srcRec.id) {
									return;
								}
								const bb = n.renderedBoundingBox();
								if (px >= bb.x1 && px <= bb.x2 && py >= bb.y1 && py <= bb.y2) {
									hit = recId;
								}
							});
						if (hit !== getCyPendingEdge().hoverTargetId) {
							const prev = getCyPendingEdge().hoverTargetId;
							getCyPendingEdge().hoverTargetId = hit;
							_bumpRev(prev);
							_bumpRev(hit);
						}
					});
					getCyInstance().on('render', _updatePendingLine);
					getCyInstance().on('mouseup tap', (evt) => {
						if (!getCyPendingEdge()) {
							return;
						}
						let tgtRec = null;
						if (evt.target !== getCyInstance()) {
							const recId = evt.target.data && evt.target.data('recId');
							if (recId != null) {
								const candidate = canvasState.bulkRecords.find((r) => r.id === recId);
								if (
									candidate &&
									!candidate.isTypeNode &&
									candidate.id !== getCyPendingEdge().srcRec.id
								) {
									tgtRec = candidate;
								}
							}
						}
						const srcRec = getCyPendingEdge().srcRec;
						const srcId = srcRec.id;
						const hoverTargetId = getCyPendingEdge().hoverTargetId;
						if (getCyPendingEdge().svg && getCyPendingEdge().svg.parentNode) {
							getCyPendingEdge().svg.parentNode.removeChild(getCyPendingEdge().svg);
						}
						setCyPendingEdge(null);
						_setConnectClass(false);
						container.classList.remove('cy-edge-hover');
						getCyInstance().userPanningEnabled(false);
						restoreNodeGrabState();
						const srcCyNode = getCyInstance().getElementById('r' + srcId);
						if (srcCyNode && srcCyNode.length) {
							srcCyNode.data('rev', (srcCyNode.data('rev') || 0) + 1);
						}
						if (hoverTargetId != null) {
							const tgtCyNode = getCyInstance().getElementById('r' + hoverTargetId);
							if (tgtCyNode && tgtCyNode.length) {
								tgtCyNode.data('rev', (tgtCyNode.data('rev') || 0) + 1);
							}
						}
						if (tgtRec) {
							const rect = container.getBoundingClientRect();
							const oe = evt.originalEvent;
							const cx = oe ? oe.clientX : rect.left + rect.width / 2;
							const cyy = oe ? oe.clientY : rect.top + rect.height / 2;
							finalizeAssociation(srcRec, tgtRec, cx, cyy);
						}
					});
				} else {
					const wantedIds = new Set(elements.map((e) => e.data.id));
					getCyInstance()
						.elements()
						.forEach((el) => {
							if (!wantedIds.has(el.id())) {
								el.remove();
							}
						});
					const haveIds = new Set(
						getCyInstance()
							.elements()
							.map((el) => el.id()),
					);
					elements.forEach((el) => {
						if (!haveIds.has(el.data.id)) {
							getCyInstance().add(el);
							if (el.group === 'nodes' && el.data.kind && el.data.kind.indexOf('card') === 0) {
								newRealNodeIds.push(el.data.id);
							}
							return;
						}
						const existing = getCyInstance().getElementById(el.data.id);
						if (el.group === 'edges') {
							reconcileExistingEdge(getCyInstance(), existing, el);
							return;
						}
						if (el.group !== 'nodes') {
							return;
						}
						if (el.grabbable) {
							existing.grabify();
						} else {
							existing.ungrabify();
						}
						if (el.data.label !== existing.data('label')) {
							existing.data('label', el.data.label);
						}
						if (el.data.kind !== existing.data('kind')) {
							existing.data('kind', el.data.kind);
						}
						if (el.position) {
							if (!existing.grabbed() && !existing.scratch('_dragFollower')) {
								const p = existing.position();
								if (Math.abs(p.x - el.position.x) > 0.5 || Math.abs(p.y - el.position.y) > 0.5) {
									existing.position(el.position);
								}
							}
						}
						if (el.data.kind && (el.data.kind.indexOf('card') === 0 || el.data.kind.indexOf('tn-') === 0)) {
							existing.data('rev', (existing.data('rev') || 0) + 1);
						}
					});
				}

				getCyInstance().elements('node:selected').unselect();
				canvasState.bulkSelectedIds.forEach((id) => {
					const n = getCyInstance().getElementById('r' + id);
					if (n && n.length) {
						n.select();
					}
				});
				getCyInstance().edges('.edge-picked').removeClass('edge-picked');
				if (canvasState.bulkSelectedEdgeId != null) {
					const e = getCyInstance().getElementById('a' + canvasState.bulkSelectedEdgeId);
					if (e && e.length) {
						e.addClass('edge-picked');
					}
				} else if (getSelectedDerivedEdge()) {
					const e = getCyInstance().getElementById(
						'd' + getSelectedDerivedEdge().recId + '_' + getSelectedDerivedEdge().fieldName,
					);
					if (e && e.length) {
						e.addClass('edge-picked');
					}
				}

				requestAnimationFrame(() =>
					requestAnimationFrame(() => {
						if (!getCyInstance() || !container) {
							return;
						}
						const cards = container.querySelectorAll('.record-card[data-rec-id]');
						cards.forEach((el) => {
							const w = el.offsetWidth;
							const h = el.offsetHeight;
							if (!w || !h) {
								return;
							}
							const recId = parseInt(el.getAttribute('data-rec-id'), 10);
							if (!Number.isFinite(recId)) {
								return;
							}
							const node = getCyInstance().getElementById('r' + recId);
							if (!node || !node.length) {
								return;
							}
							if (node.data('_inlineLocked')) {
								return;
							}
							if (node.data('boxW') !== w) {
								node.data('boxW', w);
							}
							if (node.data('boxH') !== h) {
								node.data('boxH', h);
							}
						});
					}),
				);

				if (isFirstRender) {
					requestAnimationFrame(() => {
						const cy = getCyInstance();
						if (cy && cy.elements().length > 0) {
							cy.resize();
							const baseCard = cy.nodes('[kind ^= "card"]').first();
							if (baseCard && baseCard.length) {
								cy.zoom(1);
								cy.center(baseCard);
							} else {
								cy.fit(undefined, 60);
								if (cy.zoom() > 1) {
									cy.zoom(1);
									cy.center();
								}
							}
						}
						requestAnimationFrame(() => {
							const settledCy = getCyInstance();
							if (settledCy) {
								settledCy.resize();
								redrawCyEdgeMarkers(settledCy, container);
							}
							container.classList.remove('cy-initializing');
						});
					});
				} else if (newRealNodeIds.length > 0 && !getSkipNextCyAutoPan()) {
					const newNodes = getCyInstance().collection(
						newRealNodeIds.map((id) => getCyInstance().getElementById(id)).filter((n) => n && n.length),
					);
					if (newNodes.length > 0) {
						getCyInstance().animate({ center: { eles: newNodes }, duration: 500, easing: 'ease-out' });
					}
				}
				setSkipNextCyAutoPan(false);
			}

			return {
				renderBulkCanvasCy: renderBulkCanvasCy,
			};
		},
	};
})();

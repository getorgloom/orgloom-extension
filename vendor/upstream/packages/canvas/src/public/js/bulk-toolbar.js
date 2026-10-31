(function () {
	'use strict';
	// Renders canvas actions from current selection, plan entitlements, and save state.

	window.OrgLoom = window.OrgLoom || {};

	function toolbarCanvasAccess(currentCanvas, shareRole) {
		const currentIsRecipient = !!(currentCanvas && currentCanvas.id && !currentCanvas.ownedByMe);
		const resolvedRole = shareRole || (currentIsRecipient ? currentCanvas.recipientRole || 'viewer' : null);
		const isRecipient = !!resolvedRole;
		return {
			isRecipient,
			canPersistCanvas: !isRecipient || resolvedRole === 'editor',
		};
	}

	window.OrgLoom.bulkToolbar = {
		_test: { toolbarCanvasAccess },
		mount: function mount(deps) {
			const required = [
				'canvasState',
				'canEditCanvasStructure',
				'isRecordModified',
				'_aggregateSlotProgress',
				'_slotProgressClass',
				'showSaveMenu',
				'promptCanvasSave',
				'showAddRecordsMenu',
				'showBulkOperationsMenu',
				'openUploadModal',
				'getGraph',
				'getReadOnlyMode',
				'hasCapability',
				'isCapabilityReady',
				'getWorkspacePlan',
				'_wireCanvasFloatingAdd',
				'getCanvasShareCount',
				'openCanvasEmailLinkModal',
				'openRecordDiffModal',
				'getCanvasSaveState',
				'getCanvasShareRole',
				'saveExistingCanvas',
			];
			if (!deps) {
				throw new Error('bulk-toolbar.mount: missing deps object');
			}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('bulk-toolbar.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const canEditCanvasStructure = deps.canEditCanvasStructure;
			const isRecordModified = deps.isRecordModified;
			const _aggregateSlotProgress = deps._aggregateSlotProgress;
			const _slotProgressClass = deps._slotProgressClass;
			const showSaveMenu = deps.showSaveMenu;
			const _getCanvasShareCount = deps.getCanvasShareCount;
			const openCanvasEmailLinkModal = deps.openCanvasEmailLinkModal;
			const promptCanvasSave = deps.promptCanvasSave;
			const showAddRecordsMenu = deps.showAddRecordsMenu;
			const showBulkOperationsMenu = deps.showBulkOperationsMenu;
			const openUploadModal = deps.openUploadModal;
			const getGraph = deps.getGraph;
			const getReadOnlyMode = deps.getReadOnlyMode;
			const hasCapability = deps.hasCapability;
			const isCapabilityReady = deps.isCapabilityReady;
			const getWorkspacePlan = deps.getWorkspacePlan;
			const _wireCanvasFloatingAdd = deps._wireCanvasFloatingAdd;
			const openRecordDiffModal = deps.openRecordDiffModal;
			const getCanvasSaveState = deps.getCanvasSaveState;
			const getCanvasShareRole = deps.getCanvasShareRole;
			const saveExistingCanvas = deps.saveExistingCanvas;

			function saveStateLabel(saveState) {
				const phase = (saveState && saveState.phase) || 'new';
				if (phase === 'clean') {
					return saveState.savedAt
						? 'Saved at ' +
								new Date(saveState.savedAt).toLocaleTimeString([], {
									hour: 'numeric',
									minute: '2-digit',
								})
						: 'Saved';
				}
				if (phase === 'dirty') {
					return 'Unsaved changes';
				}
				if (phase === 'saving') {
					return 'Saving\u2026';
				}
				if (phase === 'error') {
					return 'Save failed \u00B7 Try again';
				}
				if (phase === 'shared') {
					return 'Changes shared live';
				}
				return 'Not saved';
			}

			function renderCanvasName(titleOverride) {
				const canvasName = getGraph().querySelector('#canvas-name-text');
				const canvasNameOverlay = getGraph().querySelector('#canvas-name-overlay');
				const saveStatus = getGraph().querySelector('#canvas-save-status-overlay');
				if (!canvasName || !canvasNameOverlay) {
					return;
				}
				const currentCanvas = canvasState.currentCanvas;
				const canvasTitle =
					typeof titleOverride === 'string' && titleOverride.trim()
						? titleOverride.trim()
						: currentCanvas && typeof currentCanvas.title === 'string' && currentCanvas.title.trim()
							? currentCanvas.title.trim()
							: 'New canvas';
				canvasName.textContent = canvasTitle;
				const state = getCanvasSaveState();
				const phase = (state && state.phase) || 'new';
				const stateLabel = saveStateLabel(state);
				if (saveStatus) {
					saveStatus.textContent = stateLabel;
					saveStatus.className = 'canvas-save-status-overlay canvas-save-status-overlay--' + phase;
				}
				canvasNameOverlay.title = 'Current canvas: ' + canvasTitle;
				canvasNameOverlay.setAttribute('aria-label', 'Current canvas: ' + canvasTitle);
			}

			function renderBulkToolbar() {
				const cloneBar = getGraph().querySelector('#subbar-clone-btns');
				const recordsBar = getGraph().querySelector('#subbar-records');
				if (!cloneBar || !recordsBar) {
					return;
				}
				renderCanvasName();
				cloneBar.innerHTML = '';
				const addMenuBtn = canEditCanvasStructure()
					? '<button type="button" class="batch-btn" data-bulk-add-menu title="Add, request, or import records">+ Add records</button>'
					: '';
				const draftCountForToolbar = canvasState.bulkRecords.filter(
					(r) => !r.loadedFromId && !r.isTypeNode,
				).length;
				const _uploadEmpty = canvasState.bulkRecords.filter((r) => !r.isTypeNode).length === 0;
				const bulkOpsBtn =
					'<button type="button" class="batch-btn" data-bulk-ops title="Generate records with AI, auto-fill drafts, bulk edit fields, run a script, or compare records">Tools ▾</button>';
				const _allRealCount = canvasState.bulkRecords.filter((r) => !r.isTypeNode).length;
				const _selectedRealCount = canvasState.bulkRecords.filter(
					(r) => !r.isTypeNode && canvasState.bulkSelectedIds.has(r.id),
				).length;
				const _hasPartialSelection = _selectedRealCount > 0 && _selectedRealCount < _allRealCount;
				const cc = canvasState.currentCanvas;
				const canvasAccess = toolbarCanvasAccess(cc, getCanvasShareRole());
				const isRecipient = canvasAccess.isRecipient;
				const uploadCapabilityReady = isCapabilityReady();
				const uploadAllowed = uploadCapabilityReady && hasCapability('upload-records');
				const uploadBtn = isRecipient
					? ''
					: getReadOnlyMode()
						? '<button type="button" class="upload-btn upload-btn--locked" disabled title="Read-only mode is on; turn it off in the org banner above to upload">\uD83D\uDD12 Read-only</button>'
						: !uploadCapabilityReady
							? '<button type="button" class="upload-btn" disabled aria-disabled="true" aria-busy="true" title="Checking Upload to Salesforce access">Upload to Salesforce</button>'
							: !uploadAllowed
								? '<button type="button" class="upload-btn upload-btn--locked" disabled title="Ask a workspace admin to grant you the Upload to Salesforce permission">\uD83D\uDD12 Upload to Salesforce</button>'
								: _uploadEmpty
									? '<button type="button" class="upload-btn" data-bulk-upload disabled title="Add records to the canvas to enable upload">Upload to Salesforce</button>'
									: _hasPartialSelection
										? '<button type="button" class="upload-btn upload-btn--scoped" data-bulk-upload data-upload-scope-default="selected" title="Review and upload only the ' +
											_selectedRealCount +
											' selected record' +
											(_selectedRealCount === 1 ? '' : 's') +
											'">Upload ' +
											_selectedRealCount +
											' selected</button>'
										: '<button type="button" class="upload-btn" data-bulk-upload title="Review and upload all records to Salesforce">Upload to Salesforce</button>';
				const saveState = getCanvasSaveState();
				const canPersistCanvas = canvasAccess.canPersistCanvas;
				const saveCapabilityReady = isCapabilityReady();
				const saveAllowed = saveCapabilityReady && hasCapability('save-canvas');
				let saveCanvasBtn = '';
				if (canPersistCanvas) {
					const phase = (saveState && saveState.phase) || 'new';
					const savePending = !saveCapabilityReady;
					const saveLocked = saveCapabilityReady && !saveAllowed;
					const primaryDisabled = savePending || saveLocked || phase === 'clean' || phase === 'saving';
					saveCanvasBtn =
						'<span class="batch-btn-split canvas-save-control canvas-save-control--' +
						phase +
						'">' +
						'<button type="button" class="batch-btn batch-btn-split-main canvas-save-primary' +
						(saveLocked ? ' canvas-save-primary--locked' : '') +
						'" data-bulk-save-primary' +
						(primaryDisabled ? ' disabled aria-disabled="true"' : '') +
						(savePending ? ' aria-busy="true"' : '') +
						' title="' +
						(savePending
							? 'Checking Save canvas access'
							: saveLocked
								? 'Ask a workspace admin to grant you the Save canvases permission'
								: primaryDisabled
									? phase === 'saving'
										? 'Saving this canvas to Salesforce'
										: 'This canvas is saved'
									: 'Save this canvas to Salesforce') +
						'">' +
						(saveLocked ? '\uD83D\uDD12 ' : '') +
						'Save canvas' +
						'</button>' +
						'<button type="button" class="batch-btn batch-btn-split-arrow" data-bulk-save title="More save and export options" aria-label="More save and export options">\u25BE</button>' +
						'</span>';
				} else if (isRecipient) {
					saveCanvasBtn =
						'<button type="button" class="batch-btn" data-bulk-save title="Save a copy or export this shared canvas">Save / export \u25BC</button>';
				}
				const exportBtn = '';
				const helpBtn = '';
				const _shareIconSvg =
					'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:0.4em;display:inline-block" aria-hidden="true">' +
					'<circle cx="18" cy="5" r="3"/>' +
					'<circle cx="6" cy="12" r="3"/>' +
					'<circle cx="18" cy="19" r="3"/>' +
					'<line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>' +
					'<line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>' +
					'</svg>';

				const isSavedOwned = !!(cc && cc.id && cc.ownedByMe);
				const _hasRealRecords = canvasState.bulkRecords.filter((r) => !r.isTypeNode).length > 0;
				const shareCapabilityReady = isCapabilityReady();
				const shareAllowed = shareCapabilityReady && hasCapability('share-canvas');
				let shareState = 'owned-saved';
				let shareDisabled = false;
				let shareLocked = false;
				let shareTitle = 'Share this canvas with teammates';
				if (isRecipient) {
					shareState = 'recipient';
					shareDisabled = true;
					shareTitle = 'Only the canvas owner can share. Save a copy to share your version.';
				} else if (!shareCapabilityReady) {
					shareState = 'checking-access';
					shareDisabled = true;
					shareTitle = 'Checking Share canvases access';
				} else if (!shareAllowed) {
					const workspacePlan = String(getWorkspacePlan() || '').toLowerCase();
					shareState = 'permission-required';
					shareDisabled = true;
					shareLocked = true;
					shareTitle = workspacePlan
						? workspacePlan === 'pro' || workspacePlan === 'team'
							? 'Ask a workspace admin to enable Share canvases'
							: 'Upgrade this workspace to Pro or Team to share canvases'
						: 'Share canvases is not available for your account';
				} else if (!_hasRealRecords && !isSavedOwned) {
					shareState = 'empty';
					shareDisabled = true;
					shareTitle = 'Add a record to start a canvas, then share it';
				} else if (!isSavedOwned) {
					shareState = 'owned-unsaved';
					shareTitle = 'Save this canvas and share it with teammates';
				}
				const shareCount = isSavedOwned ? _getCanvasShareCount(cc.id) : null;
				const shareButton =
					'<button type="button" class="batch-btn batch-btn-accent canvas-share-btn' +
					(shareLocked ? ' canvas-share-btn--locked' : '') +
					'" data-bulk-share data-share-state="' +
					shareState +
					'"' +
					(shareDisabled ? ' disabled aria-disabled="true"' : ' title="' + shareTitle + '"') +
					(!shareCapabilityReady ? ' aria-busy="true"' : '') +
					'>' +
					(shareLocked ? '\uD83D\uDD12 ' : _shareIconSvg) +
					'Share' +
					(isSavedOwned && shareCount && shareCount > 0
						? ' <span class="canvas-share-btn-count">' + shareCount + '</span>'
						: '') +
					'</button>';
				const shareBtn = shareDisabled
					? '<span class="canvas-toolbar-disabled-tip" tabindex="0" title="' +
						shareTitle +
						'" aria-label="' +
						shareTitle +
						'">' +
						shareButton +
						'</span>'
					: shareButton;
				const playgroundResetBtn = window.ORGLOOM_MOCK
					? '<button type="button" class="batch-btn" data-playground-reset title="Clear your demo changes and start over">Reset demo</button>'
					: '';
				const _historyIconSvg =
					'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
					'<path d="M3 12a9 9 0 1 0 9-9 9.74 9.74 0 0 0-6.74 2.74L3 8"/>' +
					'<path d="M3 3v5h5"/>' +
					'<path d="M12 7v5l4 2"/>' +
					'</svg>';
				const historyBtn =
					'<button type="button" class="batch-btn batch-btn-icon" data-app-history title="Recent uploads: recall a previous batch" aria-label="Upload history">' +
					_historyIconSvg +
					'</button>';
				const canvasesBtn = window.OrgLoom.platform?.toolbar?.showCanvasesMenu
					? '<button type="button" class="batch-btn" data-app-canvases title="Open saved canvases" aria-haspopup="menu">Canvases ▾</button>'
					: '';
				recordsBar.innerHTML =
					addMenuBtn +
					bulkOpsBtn +
					'<span class="bulk-hint-spacer"></span>' +
					playgroundResetBtn +
					shareBtn +
					canvasesBtn +
					saveCanvasBtn +
					uploadBtn +
					historyBtn;

				const bulkOpsTrigger = getGraph().querySelector('[data-bulk-ops]');
				if (bulkOpsTrigger) {
					bulkOpsTrigger.addEventListener('click', (e) => {
						e.stopPropagation();
						showBulkOperationsMenu(bulkOpsTrigger);
					});
				}
				const addMenuTrigger = getGraph().querySelector('[data-bulk-add-menu]');
				if (addMenuTrigger) {
					addMenuTrigger.addEventListener('click', (e) => {
						e.stopPropagation();
						showAddRecordsMenu(addMenuTrigger);
					});
				}
				const shareTrigger = getGraph().querySelector('[data-bulk-share]');
				const playgroundResetTrigger = getGraph().querySelector('[data-playground-reset]');
				if (playgroundResetTrigger) {
					playgroundResetTrigger.addEventListener('click', () => {
						window.location.assign('/playground?reset=1');
					});
				}
				if (shareTrigger) {
					shareTrigger.addEventListener('click', (e) => {
						e.stopPropagation();
						if (shareTrigger.disabled) {
							return;
						}
						const cc2 = canvasState.currentCanvas;
						const state = shareTrigger.dataset.shareState;
						if (state === 'owned-saved' && cc2 && cc2.id) {
							openCanvasEmailLinkModal(cc2.id, cc2.title || '');
						} else if (state === 'owned-unsaved') {
							promptCanvasSave({
								title: 'Name this canvas to share it',
								submitText: 'Save & share',
								afterSave: function (saved) {
									if (saved && saved.id) {
										openCanvasEmailLinkModal(saved.id, saved.title || '');
									}
								},
							});
						}
					});
				}
				const saveCanvasTrigger = getGraph().querySelector('[data-bulk-save]');
				if (saveCanvasTrigger) {
					saveCanvasTrigger.addEventListener('click', () => {
						showSaveMenu(saveCanvasTrigger);
					});
				}
				const primarySaveTrigger = getGraph().querySelector('[data-bulk-save-primary]');
				if (primarySaveTrigger) {
					primarySaveTrigger.addEventListener('click', () => {
						if (primarySaveTrigger.disabled) {
							return;
						}
						const current = canvasState.currentCanvas;
						if (current && current.id) {
							saveExistingCanvas();
						} else {
							promptCanvasSave();
						}
					});
				}
				const uploadTrigger = getGraph().querySelector('[data-bulk-upload]');
				if (uploadTrigger) {
					uploadTrigger.addEventListener('click', () => {
						const scope = uploadTrigger.dataset.uploadScopeDefault === 'selected' ? 'selected' : 'all';
						openUploadModal({ initialScope: scope });
					});
				}
				_wireCanvasFloatingAdd();
			}

			function renderBulkCountChip() {
				const chip = getGraph().querySelector('#bulk-count-chip');
				if (!chip) {
					return;
				}
				let total = 0;
				let drafts = 0;
				let modified = 0;
				let existing = 0;
				canvasState.bulkRecords.forEach((r) => {
					if (!r || r.isTypeNode) {
						return;
					}
					total++;
					if (!r.loadedFromId) {
						drafts++;
					} else if (isRecordModified(r)) {
						modified++;
					} else {
						existing++;
					}
				});
				if (total === 0) {
					chip.style.display = 'none';
					chip.innerHTML = '';
					return;
				}
				chip.style.display = '';
				chip.innerHTML =
					'<span class="bcc-total" title="Total records on the canvas">' +
					total +
					' record' +
					(total === 1 ? '' : 's') +
					'</span>' +
					'<span class="bcc-sep" aria-hidden="true">·</span>' +
					'<span class="bcc-state bcc-draft" title="Drafts: new records that will be inserted">' +
					'<span class="bcc-dot" aria-hidden="true"></span>' +
					drafts +
					' draft' +
					'</span>' +
					'<span class="bcc-state bcc-modified" title="Modified: loaded from Salesforce, edited locally; will be updated on upload">' +
					'<span class="bcc-dot" aria-hidden="true"></span>' +
					modified +
					' modified' +
					'</span>' +
					'<span class="bcc-state bcc-existing" title="Existing: loaded from Salesforce, unchanged; will be skipped on upload">' +
					'<span class="bcc-dot" aria-hidden="true"></span>' +
					existing +
					' existing' +
					'</span>' +
					(() => {
						const sp = _aggregateSlotProgress();
						if (sp.total === 0 || sp.recipientMode) {
							return '';
						}
						const label = sp.recordCount + ' request' + (sp.recordCount === 1 ? '' : 's');
						return (
							'<span class="bcc-sep" aria-hidden="true">·</span>' +
							'<span class="slot-progress slot-progress-configured" ' +
							'title="' +
							sp.recordCount +
							' contributor request' +
							(sp.recordCount === 1 ? '' : 's') +
							(sp.recipientMode ? ' available to complete.' : ' configured on this canvas.') +
							'">' +
							label +
							'</span>'
						);
					})();
			}

			function renderBulkSelectionChip() {
				const chip = getGraph().querySelector('#bulk-selection-chip');
				if (!chip) {
					return;
				}
				const n = canvasState.bulkSelectedIds.size;
				if (n === 0) {
					chip.style.display = 'none';
					chip.innerHTML = '';
					return;
				}
				const selectedReal = canvasState.bulkRecords.filter(
					(r) => !r.isTypeNode && !r.isPending && canvasState.bulkSelectedIds.has(r.id),
				);
				let diffBtn = '';
				const differentObjects =
					selectedReal.length === 2 && selectedReal[0].objectName !== selectedReal[1].objectName;
				if (selectedReal.length === 2 && !differentObjects) {
					diffBtn =
						'<button type="button" class="bsc-diff" data-sel-diff title="Compare these two records field-by-field">Diff</button>';
				} else if (selectedReal.length >= 1) {
					const diffHint = differentObjects
						? 'different object types'
						: selectedReal.length === 1
							? 'need 1 more'
							: 'select only 2 (' + selectedReal.length + ' selected)';
					const diffTitle = 'Select two records of the same object type to compare.';
					diffBtn =
						'<button type="button" class="bsc-diff" data-sel-diff title="' +
						diffTitle +
						'" disabled aria-disabled="true">Diff <span class="bsc-diff-hint">\u00b7 ' +
						diffHint +
						'</span></button>';
				}
				chip.style.display = '';
				chip.innerHTML =
					'<span class="bsc-count">' +
					n +
					' selected</span>' +
					diffBtn +
					'<button type="button" data-sel-copy title="Ctrl+C">Copy</button>' +
					(canvasState.bulkClipboard
						? '<button type="button" data-sel-paste title="Ctrl+Shift+V">Clone\u2026</button>'
						: '') +
					'<button type="button" class="bsc-deselect" data-sel-clear>Deselect</button>';
				chip.querySelector('[data-sel-copy]').addEventListener('click', () => {
					copySelectionToClipboard();
					renderBulkSelectionChip();
				});
				const pasteBtn = chip.querySelector('[data-sel-paste]');
				if (pasteBtn) {
					pasteBtn.addEventListener('click', () => openPasteCountPrompt());
				}
				const diffTrigger = chip.querySelector('[data-sel-diff]');
				if (diffTrigger) {
					diffTrigger.addEventListener('click', () => {
						const pair = canvasState.bulkRecords.filter(
							(r) => !r.isTypeNode && !r.isPending && canvasState.bulkSelectedIds.has(r.id),
						);
						if (pair.length === 2) {
							openRecordDiffModal(pair[0], pair[1]);
						}
					});
				}
				chip.querySelector('[data-sel-clear]').addEventListener('click', () => {
					canvasState.bulkSelectedIds = new Set();
					renderBulkView();
				});
			}

			return {
				renderBulkToolbar: renderBulkToolbar,
				renderCanvasName: renderCanvasName,
				renderBulkCountChip: renderBulkCountChip,
				renderBulkSelectionChip: renderBulkSelectionChip,
			};
		},
	};
})();

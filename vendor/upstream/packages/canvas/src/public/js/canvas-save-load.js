(function () {
	'use strict';
	// Saves encrypted canvases to Salesforce and restores them into the current browser session.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.canvasSaveLoad = {
		mount: function mount(deps) {
			const required = [
				'canvasState',
				'csrfFetch',
				'escapeHtml',
				'showBulkToast',
				'showConfirmDialog',
				'showPromptModal',
				'_openAnchoredPopup',
				'_formatRelativeTime',
				'_setStaleRefsFromLoad',
				'_watchProposalsForCurrentCanvas',
				'applyCanvasPayload',
				'buildCanvasPayload',
				'ensureDraftSlotMetadata',
				'downloadTemplate',
				'openCanvasEmailLinkModal',
				'pingAuditEvent',
				'getCurrentTeam',
				'openExportCsvModal',
				'renderBulkView',
				'summarizeCanvasContent',
				'notePresenceLocalSave',
				'rehydrateSessionDraftValues',
				'_hasCap',
				'isCapabilityReady',
				'refreshCapabilities',
			];
			if (!deps) {
				throw new Error('canvas-save-load.mount: missing deps object');
			}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('canvas-save-load.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			const beginCanvasReplacementLoad =
				typeof deps.beginCanvasReplacementLoad === 'function'
					? deps.beginCanvasReplacementLoad
					: function () {
							return function () {};
						};
			const showBulkToast = deps.showBulkToast;
			const showConfirmDialog = deps.showConfirmDialog;
			const showPromptModal = deps.showPromptModal;
			const _openAnchoredPopup = deps._openAnchoredPopup;
			const _formatRelativeTime = deps._formatRelativeTime;
			const _setStaleRefsFromLoad = deps._setStaleRefsFromLoad;
			const _watchProposalsForCurrentCanvas = deps._watchProposalsForCurrentCanvas;
			const applyCanvasPayload = deps.applyCanvasPayload;
			const buildCanvasPayload = deps.buildCanvasPayload;
			const ensureDraftSlotMetadata = deps.ensureDraftSlotMetadata;
			const downloadTemplate = deps.downloadTemplate;
			const openCanvasEmailLinkModal = deps.openCanvasEmailLinkModal;
			const pingAuditEvent = deps.pingAuditEvent;
			const getCurrentTeam = deps.getCurrentTeam;
			const openExportCsvModal = deps.openExportCsvModal;
			const renderBulkView = deps.renderBulkView;
			const summarizeCanvasContent = deps.summarizeCanvasContent;
			const notePresenceLocalSave = deps.notePresenceLocalSave;
			const getAcknowledgedContributionIds =
				typeof deps.getAcknowledgedContributionIds === 'function'
					? deps.getAcknowledgedContributionIds
					: function () {
							return [];
						};
			const markContributionIdsSaved =
				typeof deps.markContributionIdsSaved === 'function' ? deps.markContributionIdsSaved : function () {};
			const rehydrateSessionDraftValues = deps.rehydrateSessionDraftValues;
			const _hasCap = deps._hasCap;
			const isCapabilityReady = deps.isCapabilityReady;
			const refreshCapabilities = deps.refreshCapabilities;
			const onCanvasLoaded = typeof deps.onCanvasLoaded === 'function' ? deps.onCanvasLoaded : function () {};
			const clearAutosave = typeof deps.clearAutosave === 'function' ? deps.clearAutosave : function () {};
			const startNewCanvas = typeof deps.startNewCanvas === 'function' ? deps.startNewCanvas : function () {};
			const previewCanvasName =
				typeof deps.previewCanvasName === 'function' ? deps.previewCanvasName : function () {};
			const chooseNewCanvasAction =
				typeof deps.chooseNewCanvasAction === 'function' ? deps.chooseNewCanvasAction : showNewCanvasDialog;
			const canvasSaveState = deps.canvasSaveState || {
				getState: () => ({ phase: 'new', dirty: false }),
				hasUnsavedChanges: () => true,
				canPersistCurrentCanvas: () => true,
				markSaving: () => true,
				markDirty: () => {},
				markFailed: () => {},
				captureSaved: () => {},
				refresh: () => {},
			};

			function capabilityActionState(capability, label) {
				if (deps.canSaveOrExport?.() === false) {
					return {
						allowed: false,
						title: 'Only the canvas owner or an editor can save or export this canvas',
					};
				}
				if (!isCapabilityReady()) {
					return { allowed: false, title: 'Checking ' + label + ' access' };
				}
				if (!_hasCap(capability)) {
					return {
						allowed: false,
						title: 'Ask a workspace admin to grant you the ' + label + ' permission',
					};
				}
				return { allowed: true, title: '' };
			}

			function actionAttributes(access, otherwiseDisabled, otherwiseTitle) {
				if (!access.allowed) {
					return ' disabled aria-disabled="true" title="' + escapeHtml(access.title) + '"';
				}
				if (otherwiseDisabled) {
					return ' disabled aria-disabled="true" title="' + escapeHtml(otherwiseTitle) + '"';
				}
				return '';
			}

			function requireCapability(capability, label) {
				const access = capabilityActionState(capability, label);
				if (access.allowed) {
					return true;
				}
				showBulkToast(access.title + '.', 'error');
				return false;
			}

			function showSaveMenu(triggerEl) {
				if (deps.canSaveOrExport?.() === false) return;
				const { pop, cleanup } = _openAnchoredPopup(triggerEl, 380);
				const hasAny = canvasState.selectedObjects.length > 0;
				const _hasRecords = canvasState.bulkRecords.some((r) => !r.isTypeNode);
				const saveAccess = capabilityActionState('save-canvas', 'Save canvases');
				const exportCanvasAccess = capabilityActionState('export-canvas', 'Export Canvases (CSV/JSON)');
				const exportRecordsAccess = exportCanvasAccess;
				const saveAttrs = actionAttributes(saveAccess, !hasAny, 'Add records to the canvas before saving');
				const exportCanvasAttrs = actionAttributes(
					exportCanvasAccess,
					!_hasRecords,
					'Add records to the canvas before exporting',
				);
				const exportRecordsAttrs = actionAttributes(
					exportRecordsAccess,
					!_hasRecords,
					'Add records to the canvas before exporting',
				);
				const hasCurrent = !!(canvasState.currentCanvas && canvasState.currentCanvas.id);
				const ownsCurrent = !!(canvasState.currentCanvas && canvasState.currentCanvas.ownedByMe);
				const editsCurrent =
					hasCurrent && (ownsCurrent || canvasState.currentCanvas.recipientRole === 'editor');
				const safeTitle = hasCurrent ? escapeHtml(canvasState.currentCanvas.title || '(untitled)') : '';
				let primarySaveBtn = '';
				if (editsCurrent) {
					primarySaveBtn =
						'<button type="button" class="tpl-action" data-tpl-action="save-existing"' +
						saveAttrs +
						'>' +
						(saveAccess.allowed ? '' : '\uD83D\uDD12 ') +
						'Save changes <span class="tpl-action-sub">overwrite \u201c' +
						safeTitle +
						'\u201d in Salesforce Files</span>' +
						'</button>';
				} else if (hasCurrent) {
					primarySaveBtn =
						'<button type="button" class="tpl-action" data-tpl-action="save-copy"' +
						saveAttrs +
						'>' +
						(saveAccess.allowed ? '' : '\uD83D\uDD12 ') +
						'Save a copy <span class="tpl-action-sub">create your own editable canvas in your Salesforce org</span>' +
						'</button>';
				}
				const saveAsNewBtn =
					!hasCurrent || editsCurrent
						? '<button type="button" class="tpl-action" data-tpl-action="save-new"' +
							saveAttrs +
							'>' +
							(saveAccess.allowed ? '' : '\uD83D\uDD12 ') +
							'Save as new canvas <span class="tpl-action-sub">a fresh saved canvas in your Salesforce org</span></button>'
						: '';
				const _exportJsonBtn =
					'<button type="button" class="tpl-action" data-tpl-action="export-file"' +
					exportCanvasAttrs +
					'>' +
					(exportCanvasAccess.allowed ? '' : '\uD83D\uDD12 ') +
					'Export canvas (JSON) <span class="tpl-action-sub">lossless, re-import to restore exactly</span></button>';
				const _exportCsvBtn =
					'<button type="button" class="tpl-action" data-tpl-action="export-csv"' +
					exportRecordsAttrs +
					'>' +
					(exportRecordsAccess.allowed ? '' : '\uD83D\uDD12 ') +
					'Export records (CSV) <span class="tpl-action-sub">Records only; links to draft records aren&rsquo;t included.</span></button>';
				const _downloadHeader = '<div class="tpl-header">Download to your machine</div>';
				pop.innerHTML =
					'<div class="tpl-header">Save this canvas</div>' +
					primarySaveBtn +
					saveAsNewBtn +
					_downloadHeader +
					_exportJsonBtn +
					_exportCsvBtn;
				pop.querySelectorAll('[data-tpl-action]').forEach((b) => {
					b.addEventListener('click', () => {
						if (b.disabled) {
							return;
						}
						const action = b.dataset.tplAction;
						cleanup();
						if (action === 'save-existing') {
							saveExistingCanvas();
						} else if (action === 'save-copy') {
							saveCanvasCopy();
						} else if (action === 'save-new') {
							promptCanvasSave();
						} else if (action === 'export-file') {
							promptFileExport();
						} else if (action === 'export-csv') {
							if (requireCapability('export-canvas', 'Export Canvases (CSV/JSON)')) {
								openExportCsvModal();
							}
						}
					});
				});
			}

			async function promptCanvasSave(opts = {}) {
				if (!requireCapability('save-canvas', 'Save canvases')) {
					return false;
				}
				// The browser sends plaintext over TLS; the server encrypts before writing Salesforce Files.
				const name = await showPromptModal({
					title: opts.title || 'Name this canvas',
					label: opts.label || 'Name',
					hideLabel: true,
					placeholder: 'e.g. QA seed for Order flow',
					defaultValue: opts.defaultName || '',
					submitText: opts.submitText || 'Save',
					helpText: opts.helpText || '',
				});
				if (!name) {
					return false;
				}
				const previousCanvasTitle =
					canvasState.currentCanvas &&
					typeof canvasState.currentCanvas.title === 'string' &&
					canvasState.currentCanvas.title.trim()
						? canvasState.currentCanvas.title.trim()
						: 'New canvas';
				const restoreCanvasName = () => previewCanvasName(previousCanvasTitle);
				previewCanvasName(name);
				let payload;
				try {
					await ensureDraftSlotMetadata();
					payload = buildCanvasPayload();
				} catch (e) {
					restoreCanvasName();
					showBulkToast(e.message || 'Build failed', 'error');
					return false;
				}
				try {
					canvasSaveState.markSaving();
					const r = await csrfFetch('/api/canvas', {
						method: 'POST',
						credentials: 'same-origin',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ name, payload }),
					});
					const data = await r.json().catch(() => ({}));
					if (!r.ok) {
						if (r.status === 403 && data && data.error === 'sf-content-version-create-denied') {
							restoreCanvasName();
							canvasSaveState.markFailed(data.message || data.error);
							await _showContentPermDeniedDialog(data.message || '', data.sfError || '');
							return false;
						}
						if (r.status === 402 && data && data.error === 'saved-canvas-cap-reached') {
							restoreCanvasName();
							canvasSaveState.markFailed(data.message || data.error);
							await _showSavedCanvasCapDialog(data);
							return false;
						}
						if (r.status === 403 && data && data.message && data.error) {
							restoreCanvasName();
							canvasSaveState.markFailed(data.message || data.error);
							showBulkToast(data.message, 'error');
							return false;
						}
						throw new Error((data && (data.message || data.error)) || 'HTTP ' + r.status);
					}
					showBulkToast('Saved canvas \u201c' + name + '\u201d to your Salesforce Files.');
					clearAutosave();
					if (data && data.id) {
						canvasState.currentCanvas = {
							id: data.id,
							title: name,
							ownedByMe: true,
							versionId: data.versionId || null,
						};
						canvasSaveState.captureSaved({ payload, savedAt: Date.now() });
						renderBulkView();
						_watchProposalsForCurrentCanvas();
						if (window.Orgloom && window.Orgloom.canvasState && window.Orgloom.canvasState.clearDraft) {
							window.Orgloom.canvasState.clearDraft();
						}
					}
					pingAuditEvent('canvas_save_sf', {
						recordCount: (payload.loadedRecords || []).length + (payload.drafts || []).length,
						payload: { name, contentDocumentId: data.id },
					});
					if (typeof opts.afterSave === 'function' && data && data.id) {
						try {
							opts.afterSave({ id: data.id, title: name });
						} catch (cbErr) {
							/* noop: save succeeded */
						}
					}
					return !!(data && data.id);
				} catch (e) {
					restoreCanvasName();
					canvasSaveState.markFailed(e.message || e);
					showBulkToast('Save failed: ' + (e.message || e), 'error');
					return false;
				}
			}

			async function saveCanvasCopy() {
				const sourceTitle = (canvasState.currentCanvas && canvasState.currentCanvas.title) || '';
				await promptCanvasSave({
					title: 'Save a copy',
					defaultName: sourceTitle ? 'Copy of ' + sourceTitle : '',
					submitText: 'Save copy',
				});
			}

			async function saveExistingCanvas() {
				if (!requireCapability('save-canvas', 'Save canvases')) {
					return false;
				}
				if (!canvasState.currentCanvas || !canvasState.currentCanvas.id) {
					showBulkToast('No canvas open to save changes to. Use \u201cSave as new canvas\u201d.', 'error');
					return false;
				}
				if (!canvasState.currentCanvas.ownedByMe && canvasState.currentCanvas.recipientRole !== 'editor') {
					showBulkToast('Only the canvas owner or an Editor can save this canvas.', 'error');
					return false;
				}
				if (canvasState.selectedObjects.length === 0) {
					showBulkToast('Nothing to save: canvas is empty.', 'error');
					return false;
				}
				const canvasToSave = canvasState.currentCanvas;
				const confirmed = await showConfirmDialog({
					title: 'Overwrite saved canvas?',
					message:
						'This will replace the previous save of \u201c' +
						(canvasToSave.title || 'Untitled canvas') +
						'\u201d in Salesforce Files with your current canvas.',
					confirmLabel: 'Overwrite',
					cancelLabel: 'Cancel',
				});
				if (!confirmed || canvasState.currentCanvas !== canvasToSave) {
					return false;
				}
				let payload;
				try {
					await ensureDraftSlotMetadata();
					payload = buildCanvasPayload();
				} catch (e) {
					showBulkToast(e.message || 'Build failed', 'error');
					return false;
				}
				try {
					canvasSaveState.markSaving();
					// Optimistic version IDs prevent one collaborator from silently overwriting another.
					try {
						notePresenceLocalSave();
					} catch (_) {}
					const acknowledgedContributionIds = getAcknowledgedContributionIds();
					const r = await csrfFetch('/api/canvas/' + encodeURIComponent(canvasState.currentCanvas.id), {
						method: 'PUT',
						credentials: 'same-origin',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							payload,
							expectedVersionId: canvasState.currentCanvas.versionId || null,
							acknowledgedContributionIds,
						}),
					});
					const data = await r.json().catch(() => ({}));
					if (
						r.status === 409 &&
						data &&
						(data.error === 'version-mismatch' || data.code === 'version_mismatch')
					) {
						canvasSaveState.markDirty();
						handleCanvasVersionMismatch(data, payload, acknowledgedContributionIds);
						return false;
					}
					if (
						r.status === 403 &&
						data &&
						(data.error === 'sf-content-version-create-denied' ||
							data.error === 'sf-content-document-edit-denied')
					) {
						canvasSaveState.markFailed(data.message || data.error);
						await _showContentPermDeniedDialog(data.message || '', data.sfError || '');
						return false;
					}
					if (r.status === 403 && data && data.message && data.error) {
						canvasSaveState.markFailed(data.message || data.error);
						showBulkToast(data.message, 'error');
						return false;
					}
					if (!r.ok) {
						throw new Error((data && (data.message || data.error)) || 'HTTP ' + r.status);
					}
					const titleForToast = (data && data.title) || canvasState.currentCanvas.title || 'canvas';
					if (data && data.versionId) {
						canvasState.currentCanvas = Object.assign({}, canvasState.currentCanvas, {
							versionId: data.versionId,
						});
					}
					try {
						notePresenceLocalSave(data);
					} catch (_) {}
					markContributionIdsSaved(data && data.mergedContributionIds);
					canvasSaveState.captureSaved({ payload, savedAt: Date.now() });
					showBulkToast('Updated \u201c' + titleForToast + '\u201d.');
					clearAutosave();
					pingAuditEvent('canvas_save_sf', {
						recordCount: (payload.loadedRecords || []).length + (payload.drafts || []).length,
						payload: {
							name: titleForToast,
							contentDocumentId: canvasState.currentCanvas.id,
							mode: 'update',
						},
					});
					return true;
				} catch (e) {
					canvasSaveState.markFailed(e.message || e);
					showBulkToast('Save failed: ' + (e.message || e), 'error');
					return false;
				}
			}

			function showNewCanvasDialog(opts) {
				opts = opts || {};
				return new Promise((resolve) => {
					document.querySelectorAll('.new-canvas-dialog').forEach((el) => el.remove());
					const modal = document.createElement('div');
					modal.className = 'modal new-canvas-dialog';
					const saveButton = opts.canSave
						? '<button type="button" class="button" data-new-canvas-choice="save">' +
							escapeHtml(opts.saveLabel || 'Save and start new') +
							'</button>'
						: '';
					const message = opts.message
						? '<div class="modal-content"><p>' + escapeHtml(opts.message) + '</p></div>'
						: '';
					modal.innerHTML =
						'<div class="modal-overlay" data-new-canvas-choice="cancel"></div>' +
						'<div class="modal-body" role="dialog" aria-modal="true" aria-labelledby="new-canvas-title">' +
						'<div class="modal-header">' +
						'<h3 id="new-canvas-title">' +
						escapeHtml(opts.title || 'Start a new canvas?') +
						'</h3>' +
						'<button type="button" class="modal-close" data-new-canvas-choice="cancel" aria-label="Cancel">&times;</button>' +
						'</div>' +
						message +
						'<div class="modal-footer">' +
						'<button type="button" class="button secondary" data-new-canvas-choice="cancel">Cancel</button>' +
						'<button type="button" class="button secondary" data-new-canvas-choice="discard">' +
						(opts.discardLabel || 'Start without saving') +
						'</button>' +
						saveButton +
						'</div>' +
						'</div>';
					document.body.appendChild(modal);
					let settled = false;
					function finish(choice) {
						if (settled) {
							return;
						}
						settled = true;
						document.removeEventListener('keydown', onKey);
						modal.remove();
						resolve(choice);
					}
					function onKey(event) {
						if (event.key === 'Escape') {
							finish('cancel');
						}
					}
					modal.querySelectorAll('[data-new-canvas-choice]').forEach((button) => {
						button.addEventListener('click', () => finish(button.dataset.newCanvasChoice));
					});
					document.addEventListener('keydown', onKey);
					setTimeout(() => {
						const preferred = modal.querySelector(
							opts.canSave ? '[data-new-canvas-choice="save"]' : '[data-new-canvas-choice="discard"]',
						);
						if (preferred) {
							preferred.focus();
						}
					}, 0);
				});
			}

			function isFreshBlankCanvas() {
				const hasLoadedCanvas = !!(canvasState.currentCanvas && canvasState.currentCanvas.id);
				const hasRecords =
					Array.isArray(canvasState.bulkRecords) &&
					canvasState.bulkRecords.some((record) => record && !record.isTypeNode && !record.isPending);
				return !hasLoadedCanvas && !hasRecords;
			}

			async function confirmCanvasReplacement(nextTitle, options) {
				options = options || {};
				if (nextTitle && typeof nextTitle === 'object') {
					nextTitle = null;
				}
				if (!canvasSaveState.hasUnsavedChanges()) {
					return true;
				}
				const current = canvasState.currentCanvas;
				const choice = await chooseNewCanvasAction({
					title: options.title || 'Load another canvas?',
					canSave: canvasSaveState.canPersistCurrentCanvas(),
					message:
						options.saveMessage ||
						'Your latest changes to this canvas have not been saved to Salesforce. ' +
							(nextTitle
								? 'Save them before loading \u201c' + nextTitle + '\u201d.'
								: 'Save them before leaving.'),
					saveLabel: 'Save and continue',
					discardLabel: 'Continue without saving',
				});
				if (choice === 'cancel') {
					return false;
				}
				if (choice === 'save') {
					const saved = current && current.id ? await saveExistingCanvas() : await promptCanvasSave();
					if (!saved) {
						return false;
					}
				}
				return true;
			}

			async function beginNewCanvas() {
				if (isFreshBlankCanvas()) {
					return false;
				}
				const currentSummary = summarizeCanvasContent(canvasState);
				const hasContent = !!(currentSummary && currentSummary.hasContent);
				const current = canvasState.currentCanvas;
				if (!hasContent || !canvasSaveState.hasUnsavedChanges()) {
					await startNewCanvas();
					return true;
				}

				const canSave = canvasSaveState.canPersistCurrentCanvas();
				const choice = await chooseNewCanvasAction({
					canSave,
					saveLabel: 'Save current and start new',
					discardLabel: canSave ? 'Start without saving' : 'Start new canvas',
				});
				if (choice === 'cancel') {
					return false;
				}
				if (choice === 'save') {
					const saved =
						current && current.id
							? await saveExistingCanvas()
							: await promptCanvasSave({
									title: 'Save your current canvas',
									label: 'Current canvas name',
									helpText: 'Org Loom will save this canvas, then open a new blank canvas.',
									submitText: 'Save and start new',
								});
					if (!saved) {
						return false;
					}
				}
				await startNewCanvas();
				return true;
			}

			function handleCanvasVersionMismatch(serverPayload, originalPayload, acknowledgedContributionIds) {
				// Keep both safe paths explicit: reload the latest version or deliberately overwrite it.
				document.querySelectorAll('.canvas-version-conflict').forEach((el) => el.remove());
				const overlay = document.createElement('div');
				overlay.className = 'modal canvas-version-conflict';
				overlay.innerHTML =
					'<div class="modal-overlay" data-vc-close></div>' +
					'<div class="modal-body" style="max-width:520px">' +
					'<div class="modal-header">' +
					'<h3>Canvas was edited elsewhere</h3>' +
					'<button class="modal-close" data-vc-close>&times;</button>' +
					'</div>' +
					'<div class="modal-content">' +
					'<p>Another user updated this canvas after you opened it.</p>' +
					'<p class="tag" style="margin-top:0.5em">Saving now would overwrite their changes. Reload to see the latest version, or save anyway to overwrite.</p>' +
					'</div>' +
					'<div class="modal-footer">' +
					'<button class="button secondary" data-vc-close>Cancel</button>' +
					'<button class="button secondary" data-vc-save-anyway>Save anyway</button>' +
					'<button class="button" data-vc-reload>Reload</button>' +
					'</div>' +
					'</div>';
				document.body.appendChild(overlay);
				const cleanup = () => overlay.remove();
				overlay.querySelectorAll('[data-vc-close]').forEach((el) => el.addEventListener('click', cleanup));
				overlay.querySelector('[data-vc-reload]').addEventListener('click', async () => {
					cleanup();
					const finishCanvasLoad = beginCanvasReplacementLoad('Reloading canvas\u2026');
					try {
						const r = await csrfFetch('/api/canvas/' + encodeURIComponent(canvasState.currentCanvas.id), {
							credentials: 'same-origin',
						});
						const data = await r.json().catch(() => null);
						if (!r.ok) {
							throw new Error((data && data.error) || 'HTTP ' + r.status);
						}
						await applyCanvasPayload(data.payload || {}, {
							merge: false,
							ownedByMe: !!data.ownedByMe,
							recipientRole: data.recipientRole || null,
							canvasIdentity: {
								id: canvasState.currentCanvas.id,
								title: data.title || canvasState.currentCanvas.title || '',
								ownedByMe: !!data.ownedByMe,
								versionId: data.versionId || null,
								recipientRole: data.recipientRole || null,
							},
						});
						_setStaleRefsFromLoad(data.staleRefs);
						canvasState.currentCanvas = Object.assign({}, canvasState.currentCanvas, {
							versionId: data.versionId || null,
							title: data.title || canvasState.currentCanvas.title,
							ownedByMe: !!data.ownedByMe,
						});
						canvasSaveState.captureSaved({
							savedAt: data.updatedAt,
						});
						try {
							rehydrateSessionDraftValues(canvasState.currentCanvas.id);
						} catch (err) {
							window.ORGLOOM_capture &&
								window.ORGLOOM_capture(err, { where: 'canvas-save-load.js/reload/rehydrateSession' });
						}
						canvasSaveState.refresh();
						renderBulkView();
						showBulkToast('Reloaded the latest version from Salesforce.');
					} catch (err) {
						showBulkToast('Reload failed: ' + (err.message || err), 'error');
					} finally {
						finishCanvasLoad();
					}
				});
				overlay.querySelector('[data-vc-save-anyway]').addEventListener('click', async () => {
					cleanup();
					try {
						canvasSaveState.markSaving();
						const r = await csrfFetch('/api/canvas/' + encodeURIComponent(canvasState.currentCanvas.id), {
							method: 'PUT',
							credentials: 'same-origin',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								payload: originalPayload,
								acknowledgedContributionIds: acknowledgedContributionIds || [],
							}),
						});
						const data = await r.json().catch(() => ({}));
						if (!r.ok) {
							throw new Error((data && data.error) || 'HTTP ' + r.status);
						}
						if (data && data.versionId) {
							canvasState.currentCanvas = Object.assign({}, canvasState.currentCanvas, {
								versionId: data.versionId,
							});
						}
						try {
							notePresenceLocalSave(data);
						} catch (_) {}
						markContributionIdsSaved(data && data.mergedContributionIds);
						canvasSaveState.captureSaved({ payload: originalPayload, savedAt: Date.now() });
						showBulkToast('Saved over the elsewhere-edits.');
					} catch (err) {
						canvasSaveState.markFailed(err.message || err);
						showBulkToast('Save failed: ' + (err.message || err), 'error');
					}
				});
				setTimeout(() => overlay.querySelector('[data-vc-reload]').focus(), 0);
			}

			async function beginMigration() {
				const real = canvasState.bulkRecords.filter((r) => !r.isTypeNode);
				if (real.length === 0) {
					showBulkToast('Add or load records before migrating to another org.', 'error');
					return;
				}
				const os = window.Orgloom && window.Orgloom.canvasOrgSwitch;
				const preparation =
					os && typeof os.migrationPreparation === 'function' ? os.migrationPreparation() : null;
				if (preparation && preparation.recordCount === 0) {
					showBulkToast(
						'This canvas has no records ready to migrate. Complete or remove its record requests first.',
						'error',
					);
					return;
				}
				const ok = await showConfirmDialog({
					title: 'Migrate this canvas to another Salesforce org?',
					message:
						'Save this canvas, then connect to the destination org. ' +
						'You’ll review which records to create or match before anything is uploaded.',
					confirmLabel: 'Save and choose destination',
					cancelLabel: 'Cancel',
				});
				if (!ok) {
					return;
				}
				const stashed =
					os && typeof os.migrationStash === 'function'
						? os.migrationStash({ status: 'awaiting-target' })
						: false;
				if (!stashed) {
					showBulkToast(
						'Couldn’t save this canvas for migration: it may be too large for this browser’s storage. Export it to a file instead, then re-import after switching orgs.',
						'error',
					);
					return;
				}
				if (
					window.Orgloom &&
					window.Orgloom.sfConnectionsModal &&
					typeof window.Orgloom.sfConnectionsModal.open === 'function'
				) {
					window.Orgloom.sfConnectionsModal.open();
				} else {
					window.location.assign('/connect');
				}
			}

			async function promptFileExport() {
				if (!requireCapability('export-canvas', 'Export Canvases (CSV/JSON)')) {
					return false;
				}
				const real = canvasState.bulkRecords.filter((r) => !r.isTypeNode);
				if (real.length === 0) {
					showBulkToast('Add records to the canvas before exporting.', 'error');
					return;
				}
				const access = await verifyFileExportPermission();
				if (!access.allowed) return false;
				const name =
					canvasState.currentCanvas && canvasState.currentCanvas.title
						? canvasState.currentCanvas.title
						: 'orgloom-canvas-' + new Date().toISOString().slice(0, 10);
				downloadTemplate(name, false);
				return true;
			}

			async function verifyFileExportPermission(options = {}) {
				if (deps.canSaveOrExport?.() === false)
					return { allowed: false, message: 'Only the canvas owner or an editor can export this canvas.' };
				const showError = options.showError !== false;
				let response;
				let data = {};
				try {
					response = await csrfFetch('/api/capabilities/export-canvas/check', {
						method: 'POST',
						credentials: 'same-origin',
					});
					data = await response.json().catch(() => ({}));
					if (deps.canSaveOrExport?.() === false)
						return { allowed: false, message: 'Your canvas access changed. No file was downloaded.' };
				} catch (_error) {
					const message =
						'Org Loom could not confirm your file export access. No file was downloaded. Try again.';
					if (showError) {
						_showFileExportDeniedDialog(message);
					}
					return { allowed: false, message };
				}
				if (response.ok) {
					return { allowed: true, message: '' };
				}
				const message =
					data.message || 'You no longer have permission to export this canvas. No file was downloaded.';
				if (showError) {
					_showFileExportDeniedDialog(message);
				}
				if (response.status === 403) {
					await Promise.resolve(refreshCapabilities()).catch(() => {});
				}
				return { allowed: false, message };
			}

			function _showFileExportDeniedDialog(message) {
				document.querySelectorAll('.app-export-denied-modal').forEach((el) => el.remove());
				const modal = document.createElement('div');
				if (!modal || typeof modal.querySelectorAll !== 'function') {
					showBulkToast(message, 'error');
					return;
				}
				modal.className = 'modal app-export-denied-modal';
				modal.innerHTML =
					'<div class="modal-overlay" data-export-denied-close></div>' +
					'<div class="modal-body" style="max-width:460px">' +
					'<div class="modal-header">' +
					'<h3>Unable to export canvas</h3>' +
					'<button class="modal-close" data-export-denied-close>&times;</button>' +
					'</div>' +
					'<div class="modal-content">' +
					'<p>' +
					escapeHtml(message) +
					'</p>' +
					'<p class="tag" style="margin-top:0.65em">No file was downloaded.</p>' +
					'</div>' +
					'<div class="modal-footer">' +
					'<button class="button" data-export-denied-close>Close</button>' +
					'</div>' +
					'</div>';
				document.body.appendChild(modal);
				const close = () => {
					document.removeEventListener('keydown', onKey);
					modal.remove();
				};
				const onKey = (event) => {
					if (event.key === 'Escape') {
						close();
					}
				};
				document.addEventListener('keydown', onKey);
				modal.querySelectorAll('[data-export-denied-close]').forEach((el) => {
					el.addEventListener('click', close);
				});
			}

			async function _showContentPermDeniedDialog(actionableMessage, sfError) {
				document.querySelectorAll('.modal.content-perm-modal').forEach((el) => el.remove());
				const modal = document.createElement('div');
				modal.className = 'modal content-perm-modal';
				const sfErrorSnippet = sfError
					? '<details style="margin-top:0.8em"><summary class="tag">Raw Salesforce error</summary><pre style="margin:0.4em 0 0;font-size:0.78rem;color:var(--ink-faint);white-space:pre-wrap">' +
						escapeHtml(String(sfError).slice(0, 600)) +
						'</pre></details>'
					: '';
				modal.innerHTML =
					'<div class="modal-overlay" data-cp-close></div>' +
					'<div class="modal-body" style="max-width:540px">' +
					'<div class="modal-header">' +
					'<h3>Salesforce won’t accept this save</h3>' +
					'<button class="modal-close" data-cp-close>&times;</button>' +
					'</div>' +
					'<div class="modal-content">' +
					'<p>' +
					escapeHtml(actionableMessage || 'Your Salesforce user can’t create files in this org.') +
					'</p>' +
					'<p class="tag" style="margin-top:0.8em">Ask your Salesforce admin to do one of:</p>' +
					'<ul style="margin:0.4em 0 0.8em 1.2em;font-size:0.88rem">' +
					'<li>Enable the <strong>Salesforce CRM Content User</strong> checkbox on your user record (User → Edit), OR</li>' +
					'<li>Assign you the <strong>Salesforce Standard</strong> permission set (Setup → Permission Sets), OR</li>' +
					'<li>Grant your profile <strong>Create</strong> on the <strong>ContentVersion</strong> object.</li>' +
					'</ul>' +
					'<p class="tag" style="margin-top:0.8em">In the meantime, you can <strong>export this canvas to a JSON file</strong> and re-import it next session; your work won’t be lost. Records you upload directly to Salesforce don’t need Content permissions, so the rest of Org Loom keeps working.</p>' +
					sfErrorSnippet +
					'</div>' +
					'<div class="modal-footer" style="justify-content:flex-end;gap:0.5em">' +
					'<button class="button secondary" data-cp-close>Close</button>' +
					'<button class="button" data-cp-export>Export to JSON</button>' +
					'</div>' +
					'</div>';
				document.body.appendChild(modal);
				return new Promise((resolve) => {
					function cleanup() {
						modal.remove();
						document.removeEventListener('keydown', onKey);
						resolve();
					}
					function onKey(e) {
						if (e.key === 'Escape') {
							cleanup();
						}
					}
					modal.querySelectorAll('[data-cp-close]').forEach((el) => el.addEventListener('click', cleanup));
					const exportBtn = modal.querySelector('[data-cp-export]');
					if (exportBtn) {
						exportBtn.addEventListener('click', () => {
							try {
								promptFileExport();
							} catch (e) {
								/* swallow */
							}
							cleanup();
						});
					}
					document.addEventListener('keydown', onKey);
				});
			}

			async function _showSavedCanvasCapDialog(data) {
				document.querySelectorAll('.modal.saved-cap-modal').forEach((el) => el.remove());
				const used = data && data.savedCount != null ? data.savedCount : '?';
				const cap = data && data.savedCap != null ? data.savedCap : '?';
				const planLabel =
					data && data.currentPlan === 'free' ? 'Inactive' : (data && data.currentPlan) || 'your';
				const modal = document.createElement('div');
				modal.className = 'modal saved-cap-modal';
				modal.innerHTML =
					'<div class="modal-overlay" data-sc-close></div>' +
					'<div class="modal-body" style="max-width:520px">' +
					'<div class="modal-header">' +
					'<h3>You’ve hit the ' +
					escapeHtml(String(planLabel)) +
					' plan’s saved-canvas limit</h3>' +
					'<button class="modal-close" data-sc-close>&times;</button>' +
					'</div>' +
					'<div class="modal-content">' +
					'<p>You have <strong>' +
					escapeHtml(String(used)) +
					' of ' +
					escapeHtml(String(cap)) +
					'</strong> saved canvases on the ' +
					escapeHtml(String(planLabel)) +
					' plan.</p>' +
					'<p class="tag" style="margin-top:0.6em">Open <strong>Save → Browse saved</strong> from the toolbar to delete one you no longer need, export this canvas as JSON to re-import next session, or upgrade to <strong>Pro</strong> for unlimited saves.</p>' +
					'</div>' +
					'<div class="modal-footer" style="justify-content:flex-end;gap:0.5em">' +
					'<button class="button secondary" data-sc-export>Export to JSON</button>' +
					'<a class="button" href="/workspace/upgrade">Upgrade to Pro →</a>' +
					'</div>' +
					'</div>';
				document.body.appendChild(modal);
				return new Promise((resolve) => {
					function cleanup() {
						modal.remove();
						document.removeEventListener('keydown', onKey);
						resolve();
					}
					function onKey(e) {
						if (e.key === 'Escape') {
							cleanup();
						}
					}
					modal.querySelectorAll('[data-sc-close]').forEach((el) => el.addEventListener('click', cleanup));
					const exportBtn = modal.querySelector('[data-sc-export]');
					if (exportBtn) {
						exportBtn.addEventListener('click', () => {
							try {
								promptFileExport();
							} catch (e) {
								/* swallow */
							}
							cleanup();
						});
					}
					document.addEventListener('keydown', onKey);
				});
			}

			function showTemplatesMenu(triggerEl) {
				showSaveMenu(triggerEl);
			}

			async function showBrowseSavedMenu(triggerEl) {
				const { pop, cleanup } = _openAnchoredPopup(triggerEl, 440);
				const teamName = (getCurrentTeam() && getCurrentTeam().name) || '';
				const headerLabel = teamName ? 'Saved canvases in ' + escapeHtml(teamName) : 'Saved canvases';
				const freshBlankCanvas = isFreshBlankCanvas();
				pop.innerHTML =
					'<button type="button" class="tpl-action tpl-new-canvas" data-new-canvas' +
					(freshBlankCanvas
						? ' disabled aria-disabled="true" title="You are already on a new blank canvas"'
						: '') +
					'>' +
					'<strong>+ New canvas</strong>' +
					'</button>' +
					'<div class="tpl-header">' +
					headerLabel +
					'</div>' +
					'<div class="tpl-access-note" id="browse-sf-access-note" hidden></div>' +
					'<div class="tpl-local-list" id="browse-sf-list"><div class="tpl-empty">Loading\u2026</div></div>';
				const newCanvasButton = pop.querySelector('[data-new-canvas]');
				if (newCanvasButton) {
					newCanvasButton.addEventListener('click', async () => {
						cleanup();
						await beginNewCanvas();
					});
				}
				const list = pop.querySelector('#browse-sf-list');
				try {
					const r = await csrfFetch('/api/canvas', { credentials: 'same-origin' });
					const data = await r.json();
					if (!r.ok) {
						throw new Error((data && (data.message || data.error)) || 'Please try again.');
					}
					const items = (data && data.items) || [];
					const canOpenOwnedCanvases = data && data.canOpenOwnedCanvases !== false;
					if (!canOpenOwnedCanvases) {
						const header = pop.querySelector('.tpl-header');
						if (header) {
							header.textContent = 'Canvases shared with you';
						}
						const accessNote = pop.querySelector('#browse-sf-access-note');
						if (accessNote) {
							accessNote.hidden = false;
							accessNote.textContent =
								'Your own saved canvases are hidden because your current plan does not include opening saved canvases.';
						}
					}
					if (items.length === 0) {
						list.innerHTML = canOpenOwnedCanvases
							? '<div class="tpl-empty">No saved canvases in ' +
								escapeHtml(teamName || 'this workspace') +
								' yet. Use Save &rarr; "Save as new canvas" to put one here. <a href="/docs/walkthroughs/saving-canvases" target="_blank" rel="noopener" class="empty-doclink">How saving works &rarr;</a></div>'
							: '<div class="tpl-empty">No canvases are currently shared with you.</div>';
						return;
					}

					const inWorkspace = items.slice();
					const other = [];

					function _renderSavedRow(t, opts) {
						const showWsBadge = !!(opts && opts.showWsBadge);
						const date = t.updatedAt ? new Date(t.updatedAt).toLocaleString() : '';
						const isActive = !!(canvasState.currentCanvas && canvasState.currentCanvas.id === t.id);
						const activeTag = isActive
							? '<span class="tpl-scope-tag tpl-scope-tag--active" title="This is the canvas you currently have open">ACTIVE</span>'
							: '';
						const activeSaveState = isActive ? canvasSaveState.getState() : null;
						const unsavedTag =
							isActive &&
							activeSaveState &&
							(activeSaveState.phase === 'dirty' || activeSaveState.phase === 'error')
								? '<span class="tpl-scope-tag tpl-scope-tag--unsaved">UNSAVED</span>'
								: '';
						let ownTag;
						if (t.ownedByMe) {
							ownTag = '<span class="tpl-scope-tag tpl-scope-tag--personal">MINE</span>';
						} else if (t.role === 'editor') {
							ownTag = '<span class="tpl-scope-tag tpl-scope-tag--editor">EDITOR</span>';
						} else if (t.role === 'contributor') {
							ownTag = '<span class="tpl-scope-tag tpl-scope-tag--template">CONTRIBUTOR</span>';
						} else {
							ownTag = '<span class="tpl-scope-tag tpl-scope-tag--template">VIEWER</span>';
						}
						let fillTag = '';
						const activity = t.lastActivity || t.lastFillActivity;
						if (t.ownedByMe && activity && activity.at) {
							const rel = _formatRelativeTime(activity.at);
							const who =
								activity.byName ||
								activity.recipientName ||
								activity.byEmail ||
								activity.recipientEmail ||
								'a teammate';
							const verb = activity.kind === 'edit' ? 'Last edited' : 'Last filled';
							fillTag =
								'<div class="tpl-last-fill" title="' +
								escapeHtml(new Date(activity.at).toLocaleString()) +
								'">' +
								escapeHtml(verb + ' ' + rel + ' by ' + who) +
								'</div>';
						}
						const wsBadge =
							showWsBadge && t.ownerBoundTeamName
								? '<span class="tpl-ws-badge" title="This canvas is bound to ' +
									escapeHtml(t.ownerBoundTeamName) +
									'. Loading it will switch your view to that workspace.">' +
									escapeHtml(t.ownerBoundTeamName) +
									'</span>'
								: '';
						return (
							'<div class="tpl-item' +
							(isActive ? ' tpl-item--active' : '') +
							'">' +
							'<div class="tpl-info">' +
							'<div class="tpl-name">' +
							escapeHtml(t.title) +
							' ' +
							activeTag +
							unsavedTag +
							ownTag +
							wsBadge +
							'</div>' +
							'<div class="tpl-meta">' +
							(date ? 'Last saved ' + escapeHtml(date) : '') +
							'</div>' +
							fillTag +
							'</div>' +
							(t.ownedByMe
								? '<button type="button" class="tpl-share" data-tpl-link="' +
									escapeHtml(t.id) +
									'" data-tpl-name="' +
									escapeHtml(t.title) +
									'" title="Email a magic-link share to a teammate">Share\u2026</button>'
								: '') +
							'<button type="button" class="tpl-load" data-tpl-load="' +
							escapeHtml(t.id) +
							'" data-tpl-title="' +
							escapeHtml(t.title) +
							'"' +
							(isActive ? ' title="Reload this canvas from Salesforce"' : '') +
							'>' +
							(isActive ? 'Reload' : 'Load') +
							'</button>' +
							(t.ownedByMe
								? '<button type="button" class="tpl-del" data-tpl-del="' +
									escapeHtml(t.id) +
									'" title="Delete">\u00D7</button>'
								: '') +
							'</div>'
						);
					}

					const inWsHtml =
						inWorkspace.length > 0
							? inWorkspace.map((t) => _renderSavedRow(t, { showWsBadge: false })).join('')
							: '<div class="tpl-empty">No canvases in ' +
								escapeHtml(teamName || 'this workspace') +
								' yet. Use Export &rarr; "Save canvas" to put one here.</div>';

					let otherHtml = '';
					if (other.length > 0) {
						const openByDefault = inWorkspace.length === 0;
						const otherRows = other.map((t) => _renderSavedRow(t, { showWsBadge: true })).join('');
						const summary =
							other.length + ' canvas' + (other.length === 1 ? '' : 'es') + ' in other workspaces';
						otherHtml =
							'<details class="tpl-other"' +
							(openByDefault ? ' open' : '') +
							'>' +
							'<summary class="tpl-other-summary">' +
							escapeHtml(summary) +
							'</summary>' +
							'<p class="tpl-other-tag">Loading one of these will switch your view to its workspace.</p>' +
							'<div class="tpl-other-list">' +
							otherRows +
							'</div>' +
							'</details>';
					}

					list.innerHTML = inWsHtml + otherHtml;
					pop.querySelectorAll('[data-tpl-load]').forEach((b) => {
						b.addEventListener('click', async () => {
							cleanup();
							const currentSummary = summarizeCanvasContent(canvasState);
							if (currentSummary.hasContent || canvasSaveState.hasUnsavedChanges()) {
								const shouldReplace = await confirmCanvasReplacement(
									b.dataset.tplTitle || 'this saved canvas',
									{
										title: 'Load saved canvas?',
										message:
											'Replace the current working canvas with “' +
											(b.dataset.tplTitle || 'this saved canvas') +
											'”? Unsaved changes on the current canvas will be cleared.',
									},
								);
								if (!shouldReplace) {
									return;
								}
							}
							const finishCanvasLoad = beginCanvasReplacementLoad('Loading canvas\u2026');
							let canvasLoadFinished = false;
							const finishCanvasLoadOnce = () => {
								if (canvasLoadFinished) {
									return;
								}
								canvasLoadFinished = true;
								finishCanvasLoad();
							};
							try {
								const id = b.dataset.tplLoad;
								const tr = await csrfFetch('/api/canvas/' + encodeURIComponent(id), {
									credentials: 'same-origin',
								});
								const td = await tr.json();
								if (!tr.ok) {
									const loadError = new Error(
										(td && (td.message || td.error)) || 'HTTP ' + tr.status,
									);
									loadError.code = td && td.error;
									loadError.status = tr.status;
									throw loadError;
								}
								await applyCanvasPayload(td.payload || {}, {
									merge: false,
									ownedByMe: !!td.ownedByMe,
									recipientRole: td.recipientRole || null,
									canvasIdentity: {
										id,
										title: td.title || '',
										ownedByMe: !!td.ownedByMe,
										versionId: td.versionId || null,
										recipientRole: td.recipientRole || null,
									},
								});
								try {
									rehydrateSessionDraftValues(id);
								} catch (err) {
									window.ORGLOOM_capture &&
										window.ORGLOOM_capture(err, {
											where: 'canvas-save-load.js/loadFromList/rehydrateSession',
										});
								}
								_setStaleRefsFromLoad(td.staleRefs);
								canvasState.currentCanvas = {
									id,
									title: td.title || '',
									ownedByMe: !!td.ownedByMe,
									versionId: td.versionId || null,
									recipientRole: td.recipientRole || null,
								};
								onCanvasLoaded(td, id);
								_watchProposalsForCurrentCanvas();
								pingAuditEvent('canvas_load_sf', {
									recordCount:
										((td.payload && td.payload.drafts) || []).length +
										((td.payload && td.payload.loadedRecords) || []).length,
									payload: { contentDocumentId: id, ownedByMe: !!td.ownedByMe, mode: 'replace' },
								});
							} catch (e) {
								// Remove the full-page loading mask before showing an error. Otherwise
								// alerts and toasts can be obscured by the replacement-load overlay.
								finishCanvasLoadOnce();
								const unavailable = e && (e.status === 404 || e.code === 'canvas-not-accessible');
								const planDenied = e && (e.status === 403 || e.code === 'plan-insufficient');
								const keyMissing = e && e.code === 'canvas-key-missing';
								if ((unavailable || planDenied || keyMissing) && typeof window.olAlert === 'function') {
									let message;
									let title = 'Canvas unavailable';
									if (keyMissing) {
										title = 'Canvas could not be opened';
										message =
											(e.message || "Org Loom couldn't locate the key for this canvas.") +
											' The canvas you already had open has not changed.';
									} else {
										message = planDenied
											? 'Your current plan does not include opening saved canvases. The canvas you already had open has not changed.'
											: 'This canvas is unavailable or is no longer shared with you. The canvas you already had open has not changed.';
									}
									await window.olAlert(message, { title, showConfirm: false });
								} else {
									showBulkToast('Load failed: ' + (e.message || e), 'error');
								}
							} finally {
								finishCanvasLoadOnce();
							}
						});
					});
					pop.querySelectorAll('[data-tpl-link]').forEach((b) => {
						b.addEventListener('click', (ev) => {
							ev.stopPropagation();
							const canvasId = b.dataset.tplLink;
							const canvasName = b.dataset.tplName || '';
							openCanvasEmailLinkModal(canvasId, canvasName);
						});
					});
					pop.querySelectorAll('[data-tpl-del]').forEach((b) => {
						b.addEventListener('click', async (ev) => {
							ev.stopPropagation();
							const id = b.dataset.tplDel;
							const row = b.closest('.tpl-item');
							const shareBtn = row && row.querySelector('[data-tpl-name]');
							let title = shareBtn ? shareBtn.getAttribute('data-tpl-name') : null;
							if (!title) {
								const titleEl = row && row.querySelector('.tpl-name');
								title = titleEl
									? titleEl.textContent
											.replace(/\s+(MINE|EDITOR|CONTRIBUTOR|YOUR|SHARED)(\s+\S+)?$/, '')
											.trim()
									: null;
							}
							const ok = await showConfirmDialog({
								title: 'Delete saved canvas',
								message: title
									? 'Delete "' +
										title +
										'"? This removes the canvas from Salesforce. Anyone you shared it with will lose access.'
									: 'Delete this saved canvas? This removes it from Salesforce. Anyone you shared it with will lose access.',
								confirmLabel: 'Delete',
								cancelLabel: 'Cancel',
								danger: true,
							});
							if (!ok) {
								return;
							}
							try {
								const dr = await csrfFetch('/api/canvas/' + encodeURIComponent(id), {
									method: 'DELETE',
									credentials: 'same-origin',
								});
								const dd = await dr.json().catch(() => ({}));
								if (!dr.ok) {
									throw new Error((dd && dd.error) || 'HTTP ' + dr.status);
								}
								if (row && row.parentNode) {
									row.parentNode.removeChild(row);
								}
								const listEl = pop.querySelector('.tpl-local-list');
								if (listEl && listEl.querySelectorAll('.tpl-item').length === 0) {
									listEl.innerHTML =
										'<div class="tpl-empty">No saved canvases in ' +
										escapeHtml(teamName || 'this workspace') +
										' yet. Use Save &rarr; "Save as new canvas" to put one here. <a href="/docs/walkthroughs/saving-canvases" target="_blank" rel="noopener" class="empty-doclink">How saving works &rarr;</a></div>';
								}
							} catch (e) {
								showBulkToast('Delete failed: ' + (e.message || e), 'error');
							}
						});
					});
				} catch (e) {
					list.innerHTML =
						'<div class="tpl-empty">Unable to load saved canvases. ' +
						escapeHtml(e.message || String(e)) +
						'</div>';
				}
			}

			return {
				showSaveMenu: showSaveMenu,
				promptCanvasSave: promptCanvasSave,
				saveCanvasCopy: saveCanvasCopy,
				saveExistingCanvas: saveExistingCanvas,
				handleCanvasVersionMismatch: handleCanvasVersionMismatch,
				promptFileExport: promptFileExport,
				beginMigration: beginMigration,
				_showSavedCanvasCapDialog: _showSavedCanvasCapDialog,
				_showContentPermDeniedDialog: _showContentPermDeniedDialog,
				showTemplatesMenu: showTemplatesMenu,
				showBrowseSavedMenu: showBrowseSavedMenu,
				beginNewCanvas: beginNewCanvas,
				confirmCanvasReplacement: confirmCanvasReplacement,
			};
		},
	};
})();

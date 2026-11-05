// Coordinates shared canvas state while feature modules own their behavior.
function csrfFetch(url, options) {
	options = options || {};
	const method = (options.method || 'GET').toUpperCase();
	if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
		// The server renders this token into the page; mutating requests fail closed without it.
		const meta = document.querySelector('meta[name="csrf-token"]');
		const token = meta ? meta.getAttribute('content') : '';
		options.headers = Object.assign({}, options.headers || {}, {
			'x-csrf-token': token,
		});
	}
	if (!('credentials' in options)) {
		options.credentials = 'same-origin';
	}
	if (window.OrgLoom && window.OrgLoom.workspaceContext) {
		options = window.OrgLoom.workspaceContext.apply(url, options);
	}
	return globalThis.fetch(url, options);
}

(function () {
	// Trusted platform integration, installed before bootstrap; never sourced from a canvas file.
	const platform = window.OrgLoom.platform || {};
	const canCommitLocalChanges = () => _canEditCanvasStructure() && (!platform.canEdit || platform.canEdit());
	const canvasState = {
		allObjects: null,
		_allObjectsError: null,
		selectedObjects: [],
		selectedIdSeq: 1,
		activeIndex: 0,
		bulkRecords: [],
		bulkAssociations: [],
		bulkIdSeq: 1,
		bulkSelectedIds: new Set(),
		bulkSelectedEdgeId: null,
		bulkMarquee: null,
		bulkInitialized: true,
		_bulkUserDeleted: false,
		_bulkSeenIds: null,
		_lastBulkZoomSig: null,
		bulkZoom: 1,
		currentRecordRef: null,
		savedRecords: {},
		describeCache: {},
		draftDescribeCache: {},
		describeRequests: {},
		_renderedRecIds: new Set(),
		_prefetchedTypeNodeKeys: new Set(),
		hiddenObjects: new Set(),
		graphView: 'schema',
		graphZoom: 1,
		currentCanvas: null, // { id, title, ownedByMe }
		_draftCanvasId: null,
		graphFilterText: '',
		graphRelFilter: 'parent', // 'both' | 'parent' | 'child'
		_suppressNextViewTransition: false,
		_userZoomOverride: false,
		_lastZoomSig: null,
		_bulkUserZoomOverride: false,
		bulkClipboard: null,
		graphCache: {},
		_systemFieldsFilter: true,
		_pendingPan: null,
		_cySchemaSig: null,
		_schemaViewObject: null,
		_schemaViewPath: [],
		_schemaViewPathEdges: [],
		_lastSchemaFocusRecId: null,
		_pendingNavOriginPos: null,
		_autoSpawnedPending: false,
		diffSuppressions: {},
		migrateMode: {
			active: false,
			sourceSfOrgId: null,
			targetSfOrgId: null,
			preparation: null,
			annotationsById: {},
			summary: null,
		},
	};
	const _canvasLaunchParamsAtLoad = new URLSearchParams(window.location.search || '');
	let _hasCanvasLaunchRequest = !!(
		_canvasLaunchParamsAtLoad.get('openCanvas') || _canvasLaunchParamsAtLoad.get('share')
	);

	function _canEditCanvasStructure() {
		return _canvasActionAccess().canPersistCanvas;
	}
	function _canvasActionAccess() {
		return window.OrgLoom.bulkToolbar.canvasAccess(canvasState.currentCanvas, _getCanvasShareRole());
	}

	const _canvasGuideScope =
		typeof window.ORGLOOM_ACCOUNT_ID_HASH === 'string' && window.ORGLOOM_ACCOUNT_ID_HASH
			? window.ORGLOOM_ACCOUNT_ID_HASH
			: 'anonymous';
	const _canvasGuideDismissKey = 'orgloom:emptyCardDismissed:' + _canvasGuideScope;
	const _canvasGuideCompleteKey = 'orgloom:canvasGuideCompleted:' + _canvasGuideScope;
	let _canvasGuideDismissedThisPage = false;
	let _canvasGuideCompletedThisPage = false;

	function _canvasGuideHas(key, runtimeValue) {
		if (runtimeValue) {
			return true;
		}
		try {
			if (platform.onboarding?.getFlag) {
				return platform.onboarding.getFlag(key === _canvasGuideDismissKey ? 'dismissed' : 'completed');
			}
			return localStorage.getItem(key) === '1';
		} catch (_) {
			return false;
		}
	}

	function _dismissCanvasGuide() {
		_canvasGuideDismissedThisPage = true;
		try {
			if (platform.onboarding?.setFlag) {
				platform.onboarding.setFlag('dismissed');
				return;
			}
			localStorage.setItem(_canvasGuideDismissKey, '1');
		} catch (_) {
			/* private mode: runtime flag still hides it */
		}
	}

	function _completeCanvasGuide() {
		_canvasGuideCompletedThisPage = true;
		try {
			if (platform.onboarding?.setFlag) {
				platform.onboarding.setFlag('completed');
				return;
			}
			localStorage.setItem(_canvasGuideCompleteKey, '1');
		} catch (_) {
			/* private mode: runtime flag still hides it */
		}
	}

	const _autosave = window.OrgLoom.canvasAutosave.mount({
		canvasState: canvasState,
		encryptedFields: window.OrgLoom.encryptedFields,
	});
	const _userSwitchCanvasId = _autosave.consumeUserSwitchCanvasId();
	const _reauthFallbackCanvasId = _autosave.consumeReauthFallbackCanvasId();
	if (_userSwitchCanvasId && !_hasCanvasLaunchRequest) {
		_canvasLaunchParamsAtLoad.set('openCanvas', _userSwitchCanvasId);
		const query = _canvasLaunchParamsAtLoad.toString();
		window.history.replaceState(
			{},
			'',
			window.location.pathname + (query ? '?' + query : '') + window.location.hash,
		);
		_hasCanvasLaunchRequest = true;
	}
	const _canvasSaveState = window.OrgLoom.canvasSaveState.mount({
		canvasState: canvasState,
	});
	const _orgSwitchStash = _autosave.orgSwitchStash;
	const _orgSwitchRestore = _autosave.orgSwitchRestore;
	const _autosaveSchedule = _autosave.autosaveSchedule;
	const _autosaveFlush = _autosave.autosaveFlush;
	const _autosaveClear = _autosave.autosaveClear;
	const _autosaveRestore = _autosave.autosaveRestore;
	const _migrationResume = _autosave.migrationResume;
	const _migrationClear = _autosave.migrationClear;
	const _migrationSyncIfActive = _autosave.migrationSyncIfActive;

	const _uif = window.OrgLoom.uiFeedback.mount({
		escapeHtml: escapeHtml,
		getGraph: function () {
			return graph;
		},
	});
	const showBulkToast = _uif.showBulkToast;
	const _rawToastWithAction = _uif.showBulkToastWithAction;
	const showBulkToastWithAction = (message, actionLabel, action, variant) => {
		if (typeof action === 'function' && /undo/i.test(String(actionLabel || ''))) {
			const once = pushUndo(actionLabel, action);
			return _rawToastWithAction(message, actionLabel, once, variant);
		}
		return _rawToastWithAction(message, actionLabel, action, variant);
	};
	const showConfirmDialog = _uif.showConfirmDialog;
	const confirmHydrateChoice = _uif.confirmHydrateChoice;

	const _aiGen = window.OrgLoom.aiGenerate.mount({
		csrfFetch: csrfFetch,
		escapeHtml: escapeHtml,
		showBulkToast: showBulkToast,
		pushUndo: pushUndo,
		canvasState: canvasState,
		canvasCapCheck: function () {
			return canvasCapCheck.apply(null, arguments);
		},
		addToSelection: addToSelection,
		renderBulkView: renderBulkView,
		getGraph: function () {
			return graph;
		},
		startElapsedTicker: startElapsedTicker,
		hasCapability: function () {
			return _hasCap.apply(null, arguments);
		},
		isCapabilityReady: function () {
			return _capsLoaded;
		},
		refreshCapabilities: function () {
			return _loadCaps();
		},
		getWorkspacePlan: function () {
			return _meInfo && _meInfo.workspace ? _meInfo.workspace.plan : null;
		},
		showBulkToastWithAction: function () {
			return showBulkToastWithAction.apply(null, arguments);
		},
	});
	const openAiGenModal = _aiGen.openModal;
	async function checkAiStatus(force) {
		return _aiGen.checkStatus(force);
	}

	function clearEmptyStarterCard() {
		if (canvasState.bulkRecords.length !== 1) {
			return;
		}
		const r = canvasState.bulkRecords[0];
		if (!r) {
			return;
		}
		const isEmptyDraft =
			!r.loadedFromId &&
			Object.keys(r.values || {}).length === 0 &&
			!canvasState.bulkAssociations.some((a) => a.fromId === r.id || a.toId === r.id);
		if (!r.isTypeNode && !isEmptyDraft) {
			return;
		}
		canvasState.bulkRecords = [];
		if (canvasState.bulkSelectedIds && canvasState.bulkSelectedIds.delete) {
			canvasState.bulkSelectedIds.delete(r.id);
		}
		canvasState.bulkSelectedEdgeId = null;
	}

	const _csvi = window.OrgLoom.csvImport.mount({
		canvasState: canvasState,
		showBulkToast: showBulkToast,
		canvasCapCheck: function () {
			return canvasCapCheck.apply(null, arguments);
		},
		escapeHtml: escapeHtml,
		ensureDescribe: ensureDescribe,
		csrfFetch: csrfFetch,
		renderBulkView: renderBulkView,
		getGraph: function () {
			return graph;
		},
		clearEmptyStarterCard: clearEmptyStarterCard,
	});
	const parseCsv = _csvi.parseCsv;
	const csvNormalizeKey = _csvi.csvNormalizeKey;
	const csvGuessObjectFromFilename = _csvi.csvGuessObjectFromFilename;
	const csvAutoMapHeaders = _csvi.csvAutoMapHeaders;
	const pingAuditEvent = _csvi.pingAuditEvent;

	let basePickerFilter = {
		text: '',
		type: 'all',
	};
	(function showUpgradeStatus() {
		function run() {
			const params = new URLSearchParams(window.location.search || '');
			const upgrade = params.get('upgrade');
			if (!upgrade) {
				return;
			}
			window.history.replaceState({}, '', window.location.pathname + window.location.hash);
			if (upgrade === 'success') {
				return;
			}
			if (upgrade === 'pending') {
				const bar = document.createElement('div');
				bar.className = 'upgrade-status-banner';
				bar.setAttribute('role', 'status');
				bar.style.cssText =
					'position:fixed;top:0;left:0;right:0;z-index:9999;background:var(--warn,#d29a00);color:#1a1a1a;padding:0.6em 1em;font-size:0.9em;display:flex;align-items:center;justify-content:center;gap:0.75em;box-shadow:0 1px 4px rgba(0,0,0,0.25)';
				const m = document.createElement('span');
				m.innerHTML =
					'<strong>Payment processing.</strong> We’ll upgrade your workspace once your bank confirms (usually 3–5 business days). You can keep using Org Loom on your current plan in the meantime.';
				const x = document.createElement('button');
				x.type = 'button';
				x.textContent = '✕';
				x.setAttribute('aria-label', 'Dismiss');
				x.style.cssText =
					'background:none;border:none;color:#1a1a1a;font-size:1.1em;cursor:pointer;line-height:1';
				const dismiss = () => {
					if (bar.parentNode) {
						bar.remove();
					}
				};
				const timer = setTimeout(dismiss, 12000);
				x.addEventListener('click', () => {
					clearTimeout(timer);
					dismiss();
				});
				bar.appendChild(m);
				bar.appendChild(x);
				document.body.appendChild(bar);
				return;
			}
			const errs = {
				'apply-failed': 'We couldn’t finish applying your upgrade. If you were charged, contact support.',
				'session-mismatch': 'That checkout link was for a different account.',
				'session-lookup-failed':
					'We couldn’t verify your checkout session. If you were charged, contact support.',
			};
			if (errs[upgrade] && typeof showBulkToast === 'function') {
				showBulkToast(errs[upgrade], 'error');
			}
		}
		if (document.body) {
			run();
		} else {
			document.addEventListener('DOMContentLoaded', run);
		}
	})();

	let _cyInstance = null;
	let _cySchemaInstance = null;
	const SCHEMA_SYSTEM_FK_FIELDS = new Set(['CreatedById', 'LastModifiedById', 'OwnerId']);
	let _skipNextCyAutoPan = false;
	let _cyPendingEdge = null;

	let _objectFilterHidden = new Set();

	let _canvasSpaceHeld = false;
	let _canvasZHeld = false;
	let _canvasMiddleMousePanning = false;

	function _canvasZoomBy(factor) {
		if (canvasState.graphView === 'bulk' && _cyInstance) {
			const container = _cyInstance.container && _cyInstance.container();
			if (!container) {
				return;
			}
			const rect = container.getBoundingClientRect();
			const next = Math.max(0.1, Math.min(5, _cyInstance.zoom() * factor));
			_cyInstance.zoom({
				level: next,
				renderedPosition: { x: rect.width / 2, y: rect.height / 2 },
			});
			return;
		}
		if (canvasState.graphView === 'schema' && _cySchemaInstance) {
			const container = _cySchemaInstance.container && _cySchemaInstance.container();
			if (!container) {
				return;
			}
			const rect = container.getBoundingClientRect();
			const next = Math.max(0.1, Math.min(5, _cySchemaInstance.zoom() * factor));
			_cySchemaInstance.zoom({
				level: next,
				renderedPosition: { x: rect.width / 2, y: rect.height / 2 },
			});
			return;
		}
		if (canvasState.graphView === 'schema') {
			const next = Math.max(GRAPH_ZOOM_MIN, Math.min(GRAPH_ZOOM_MAX, canvasState.graphZoom * factor));
			if (next === canvasState.graphZoom) {
				return;
			}
			canvasState.graphZoom = next;
			canvasState._userZoomOverride = true;
			applyGraphZoom();
		}
	}
	function _canvasPanBy(dx, dy) {
		if (!_cyInstance) {
			return;
		}
		_cyInstance.panBy({ x: dx, y: dy });
	}

	const _allObjectsAbort = typeof AbortController === 'function' ? new AbortController() : null;
	const _allObjectsTimer = _allObjectsAbort
		? setTimeout(() => {
				try {
					_allObjectsAbort.abort();
				} catch (_) {}
			}, 12000)
		: null;
	const _allObjectsReady =
		window.ORGLOOM_SF_CONNECTED === false
			? (function () {
					if (_allObjectsTimer) {
						clearTimeout(_allObjectsTimer);
					}
					canvasState.allObjects = [];
					canvasState._allObjectsError = null;
					return Promise.resolve();
				})()
			: csrfFetch('/api/objects', _allObjectsAbort ? { signal: _allObjectsAbort.signal } : undefined)
					.then(async (r) => {
						if (_allObjectsTimer) {
							clearTimeout(_allObjectsTimer);
						}
						if (!r.ok) {
							let bodyErr = null;
							try {
								const ct = r.headers.get('content-type') || '';
								if (ct.indexOf('application/json') !== -1) {
									const body = await r.clone().json();
									bodyErr = body && body.error;
								}
							} catch (_) {}
							const e = new Error('HTTP ' + r.status + (bodyErr ? ' (' + bodyErr + ')' : ''));
							e.status = r.status;
							e.bodyError = bodyErr;
							throw e;
						}
						return r.json();
					})
					.then((data) => {
						canvasState.allObjects = Array.isArray(data) ? data : [];
						canvasState._allObjectsError = null;
					})
					.catch((err) => {
						if (_allObjectsTimer) {
							clearTimeout(_allObjectsTimer);
						}
						canvasState.allObjects = [];
						canvasState._allObjectsError = err;
						if (window.__sfRedirectingToReauth) {
							return;
						}
						if (window.__sfReauthPromptOpen) {
							return;
						}
						if (window.__sfOfflineMode) {
							return;
						}
						if (window.ORGLOOM_SF_CONNECTED === false) {
							return;
						}
						const isAborted = err && (err.name === 'AbortError' || err.code === 20);
						console.warn('Failed to load /api/objects:', isAborted ? 'aborted (timeout)' : err.message);
						if (typeof window.olToast === 'function') {
							var msg = isAborted
								? 'Salesforce is taking too long to respond. Check the SF chip in the top strip and refresh once your connection looks healthy.'
								: err.status === 409 || err.bodyError === 'no-active-connection'
									? 'Salesforce session lost. Click the SF chip in the top strip to reconnect.'
									: err.status === 403
										? 'Salesforce schema is blocked by workspace policy. Ask an admin to approve this org.'
										: 'Couldn’t load Salesforce schema (' +
											(err.message || 'unknown error') +
											'). Try refreshing the page.';
							try {
								window.olToast(msg, 'error');
							} catch (_) {}
						}
					});

	_aiGen.checkStatus(false).then(() => {
		if (
			typeof canvasState.graphView !== 'undefined' &&
			canvasState.graphView === 'bulk' &&
			typeof renderBulkView === 'function'
		) {
			renderBulkView();
		}
	});

	let _capsLoaded = false;

	const _cc = window.OrgLoom.canvasCap.mount({
		canvasState: canvasState,
		isRecordModified: function () {
			return isRecordModified.apply(null, arguments);
		},
		getShareCountByCanvasId: function () {
			return _shareCountByCanvasId;
		},
		renderBulkToolbar: function () {
			return renderBulkToolbar.apply(null, arguments);
		},
	});
	const setCaps = _cc.setCaps;
	const _hasCap = _cc._hasCap;
	const _canAuthorSlots = _cc._canAuthorSlots;
	const _canRunScripts = _cc._canRunScripts;
	const _realRecordCount = _cc._realRecordCount;
	const canvasCapCheck = _cc.canvasCapCheck;
	const _canvasCapBlockReason = _cc._canvasCapBlockReason;
	const _modifiedLoadedCount = _cc._modifiedLoadedCount;
	const _CANVAS_RECORD_CAP_GET = _cc.getCanvasRecordCap;
	const _invalidateShareCountForCanvas = _cc._invalidateShareCountForCanvas;

	const _sr = window.OrgLoom.staleRef.mount({
		canvasState: canvasState,
		encryptedFields: window.OrgLoom.encryptedFields,
		renderBulkView: function () {
			return renderBulkView();
		},
		deleteRecord: function () {
			return deleteRecord.apply(null, arguments);
		},
		getBulkRecords: function () {
			return canvasState.bulkRecords;
		},
		ensureDescribe: ensureDescribe,
		showBulkToast: showBulkToast,
	});
	const _isRecordStale = _sr._isRecordStale;
	const _setStaleRefsFromLoad = _sr._setStaleRefsFromLoad;
	const _addStaleRefIds = _sr._addStaleRefIds;
	const _markRecordUnavailable = _sr._markRecordUnavailable;
	const _showStaleRefMenu = _sr._showStaleRefMenu;
	const _staleIdKey = _sr._staleIdKey;

	const _csr = window.OrgLoom.canvasSearch.mount({
		canvasState: canvasState,
		setSelection: function (ids) {
			canvasState.bulkSelectedIds = new Set(ids);
			canvasState.bulkSelectedEdgeId = null;
			canvasState._schemaViewObject = null;
			canvasState._schemaViewPath = [];
			canvasState._schemaViewPathEdges = [];
			renderBulkView();
			renderCanvas();
		},
		getCyInstance: function () {
			return _cyInstance;
		},
		escapeHtml: escapeHtml,
	});
	const openCanvasSearchModal = _csr.openModal;

	const _cec = window.OrgLoom.canvasExportCsv.mount({
		canSaveOrExport: _canEditCanvasStructure,
		canvasState: canvasState,
		csrfFetch: csrfFetch,
		escapeHtml: escapeHtml,
		showBulkToast: showBulkToast,
		refreshCapabilities: function () {
			return _loadCaps().then(() => renderBulkToolbar());
		},
	});
	const openExportCsvModal = _cec.openModal;

	const _ap = window.OrgLoom.anchoredPopup.mount();
	const _openAnchoredPopup = _ap._openAnchoredPopup;

	const _bt = window.OrgLoom.bulkToolbar.mount({
		canvasState: canvasState,
		canEditCanvasStructure: _canEditCanvasStructure,
		isRecordModified: function () {
			return isRecordModified.apply(null, arguments);
		},
		_aggregateSlotProgress: function () {
			return _aggregateSlotProgress.apply(null, arguments);
		},
		_slotProgressClass: function () {
			return _slotProgressClass.apply(null, arguments);
		},
		showSaveMenu: function () {
			return showSaveMenu.apply(null, arguments);
		},
		promptCanvasSave: function () {
			return promptCanvasSave.apply(null, arguments);
		},
		showAddRecordsMenu: function () {
			return showAddRecordsMenu.apply(null, arguments);
		},
		showBulkOperationsMenu: function () {
			return showBulkOperationsMenu.apply(null, arguments);
		},
		openUploadModal: function () {
			return openUploadModal.apply(null, arguments);
		},
		getGraph: function () {
			return graph;
		},
		getReadOnlyMode: function () {
			return _readOnlyMode;
		},
		hasCapability: function () {
			return _hasCap.apply(null, arguments);
		},
		isCapabilityReady: function () {
			return _capsLoaded;
		},
		getWorkspacePlan: function () {
			if (_meInfo && _meInfo.workspace) {
				return _meInfo.workspace.plan;
			}
			return _currentTeam ? _currentTeam.plan : null;
		},
		_wireCanvasFloatingAdd: function () {
			return _wireCanvasFloatingAdd.apply(null, arguments);
		},
		getCanvasShareCount: function () {
			return _getCanvasShareCount.apply(null, arguments);
		},
		openCanvasEmailLinkModal: function () {
			return openCanvasEmailLinkModal.apply(null, arguments);
		},
		openRecordDiffModal: function () {
			return openRecordDiffModal.apply(null, arguments);
		},
		getCanvasSaveState: function () {
			return _canvasSaveState.getState();
		},
		getCanvasShareRole: function () {
			return _getCanvasShareRole();
		},
		saveExistingCanvas: function () {
			return saveExistingCanvas.apply(null, arguments);
		},
	});
	const renderBulkToolbar = _bt.renderBulkToolbar;
	const renderCanvasName = _bt.renderCanvasName;
	const renderBulkCountChip = _bt.renderBulkCountChip;
	const renderBulkSelectionChip = _bt.renderBulkSelectionChip;
	window.addEventListener('orgloom:canvas-save-state', () => renderBulkToolbar());

	function _loadCaps() {
		return csrfFetch('/api/me/capabilities', { credentials: 'same-origin' })
			.then((r) => (r.ok ? r.json() : null))
			.then((data) => {
				setCaps((data && data.capabilities) || {});
				_capsLoaded = true;
			})
			.catch(() => {
				setCaps({});
				_capsLoaded = true;
			})
			.finally(() => {
				if (canvasState.graphView === 'bulk' && typeof renderBulkView === 'function') {
					renderBulkView();
				}
			});
	}
	_loadCaps();
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') {
			_loadCaps();
			_refreshOrgApprovalState();
		}
	});

	let _canvasShareCanvasId = null;
	let _canvasShareRole = null;
	let _shareRecipientSubmitState = 'idle';
	let _shareRecipientSubmitResetTimer = null;
	let _renderSharedTaskSidebar = function () {
		return false;
	};
	let _renderUploadFixes = () => false;
	let _clearUploadFixes = () => {};
	let _ins = null;
	function closeRecordEditors() {
		if (_ins) _ins.closeAll();
	}

	function _getCanvasShareRole() {
		if (canvasState._renderCanvasShareRole) {
			return canvasState._renderCanvasShareRole;
		}
		if (_canvasShareRole) {
			return _canvasShareRole;
		}
		const current = canvasState.currentCanvas;
		if (current && current.id && !current.ownedByMe) {
			return current.recipientRole || 'viewer';
		}
		return null;
	}

	const _shareCountByCanvasId = new Map();
	const _shareCountFetching = new Set();
	function _getCanvasShareCount(canvasId) {
		if (!canvasId) {
			return null;
		}
		if (_shareCountByCanvasId.has(canvasId)) {
			return _shareCountByCanvasId.get(canvasId);
		}
		if (!_shareCountFetching.has(canvasId)) {
			_shareCountFetching.add(canvasId);
			csrfFetch('/api/canvas/' + encodeURIComponent(canvasId) + '/share-links', { credentials: 'same-origin' })
				.then((r) => (r.ok ? r.json() : null))
				.then((data) => {
					const linkCount = data && Array.isArray(data.shares) ? data.shares.length : 0;
					const directCount = data && Array.isArray(data.directShares) ? data.directShares.length : 0;
					const count = linkCount + directCount;
					_shareCountByCanvasId.set(canvasId, count);
					window.dispatchEvent(
						new CustomEvent('orgloom:canvas-share-count', { detail: { canvasId, count } }),
					);
					_shareCountFetching.delete(canvasId);
					if (
						typeof canvasState.graphView !== 'undefined' &&
						canvasState.graphView === 'bulk' &&
						typeof renderBulkToolbar === 'function'
					) {
						renderBulkToolbar();
					}
				})
				.catch((err) => {
					console.warn('[share-count] fetch failed for', canvasId, err.message || err);
					_shareCountFetching.delete(canvasId);
					_shareCountByCanvasId.set(canvasId, 0);
					window.dispatchEvent(
						new CustomEvent('orgloom:canvas-share-count', { detail: { canvasId, count: 0 } }),
					);
				});
		}
		return null;
	}

	function announceMergedContributions(data) {
		if (data && data.contributionsApplied > 0) {
			showBulkToast(
				'Merged ' +
					data.contributionsApplied +
					' submitted contribution' +
					(data.contributionsApplied === 1 ? '' : 's') +
					' into this canvas.',
			);
		}
		if (data && data.contributionMergeWarning) {
			showBulkToast(data.contributionMergeWarning, 'error');
		}
	}

	let _canvasReplacementLoads = 0;
	let _beginPresenceCanvasLoad = () => () => {};
	function beginCanvasReplacementLoad(message) {
		const finishPresenceLoad = _beginPresenceCanvasLoad();
		_canvasReplacementLoads += 1;
		let mask = document.getElementById('canvas-replacement-loading');
		if (!mask) {
			mask = document.createElement('div');
			mask.id = 'canvas-replacement-loading';
			mask.className = 'canvas-replacement-loading';
			mask.setAttribute('role', 'status');
			mask.setAttribute('aria-live', 'polite');
			mask.innerHTML =
				'<span class="canvas-replacement-loading-spinner" aria-hidden="true"></span>' +
				'<strong class="canvas-replacement-loading-label"></strong>';
			document.body.appendChild(mask);
		}
		const label = mask.querySelector('.canvas-replacement-loading-label');
		if (label) {
			label.textContent = message || 'Loading canvas\u2026';
		}
		mask.hidden = false;
		document.body.setAttribute('aria-busy', 'true');

		let finished = false;
		return function finishCanvasReplacementLoad() {
			if (finished) {
				return;
			}
			finished = true;
			finishPresenceLoad();
			_canvasReplacementLoads = Math.max(0, _canvasReplacementLoads - 1);
			if (_canvasReplacementLoads > 0) {
				return;
			}
			mask.hidden = true;
			document.body.removeAttribute('aria-busy');
		};
	}

	(function autoOpenSharedCanvas() {
		const params = new URLSearchParams(window.location.search || '');
		const shareCanvasId = params.get('share');
		if (!shareCanvasId || !/^[a-zA-Z0-9]{15,18}$/.test(shareCanvasId)) {
			return;
		}
		const finishCanvasLoad = beginCanvasReplacementLoad('Opening shared canvas\u2026');
		_allObjectsReady.then(async () => {
			try {
				if (await platform.recovery?.ready?.()) return;
				const r = await csrfFetch('/api/canvas/' + encodeURIComponent(shareCanvasId), {
					credentials: 'same-origin',
				});
				const data = await r.json().catch(() => null);
				if (!r.ok) {
					if (r.status === 401) {
						showCanvasLaunchError('Session expired. Reload the share link from your email.');
						return;
					}
					showCanvasLaunchError(
						(data && (data.message || data.error)) ||
							'Could not open the shared canvas (HTTP ' + r.status + ').',
					);
					return;
				}
				document.body.classList.add('canvas-share-banner-active');
				document.body.classList.add('canvas-recipient-mode');
				await applyCanvasPayload(data.payload || {}, {
					merge: false,
					ownedByMe: !!data.ownedByMe,
					recipientRole: data.recipientRole || null,
					canvasIdentity: {
						id: shareCanvasId,
						title: data.title || '',
						ownedByMe: !!data.ownedByMe,
						versionId: data.versionId || null,
						recipientRole: data.recipientRole || null,
					},
				});
				_setStaleRefsFromLoad(data.staleRefs);
				canvasState.currentCanvas = {
					id: shareCanvasId,
					title: data.title || '',
					ownedByMe: !!data.ownedByMe,
					versionId: data.versionId || null,
					recipientRole: data.recipientRole || null,
				};
				_canvasSaveState.captureSaved({ savedAt: data.updatedAt });
				announceMergedContributions(data);
				_watchProposalsForCurrentCanvas();
				_canvasShareCanvasId = shareCanvasId;
				_canvasShareRole = data.recipientRole || 'contributor';
				renderShareRecipientBanner();
				renderBulkView();
				renderBulkToolbar();
			} catch (err) {
				console.warn('[canvas-share] auto-open failed:', err);
				showCanvasLaunchError(
					'Could not open the shared canvas: ' +
						(err.message || err) +
						'. Your current canvas has not changed.',
				);
			} finally {
				clearCanvasLaunchParam('share');
				finishCanvasLoad();
			}
		});
	})();

	function clearCanvasLaunchParam(name) {
		const params = new URLSearchParams(window.location.search || '');
		if (!params.has(name)) {
			return;
		}
		params.delete(name);
		const query = params.toString();
		window.history.replaceState(
			{},
			'',
			window.location.pathname + (query ? '?' + query : '') + window.location.hash,
		);
	}

	function showCanvasLaunchError(message) {
		if (typeof window.olAlert === 'function') {
			void window.olAlert(message, {
				title: 'Canvas unavailable',
				showConfirm: false,
			});
			return;
		}
		if (typeof window.olToast === 'function') {
			window.olToast(message, 'error');
			return;
		}
		showBulkToast(message, 'error');
	}

	(function autoOpenLinkedCanvas() {
		const params = new URLSearchParams(window.location.search || '');
		const openId = params.get('openCanvas');
		if (!openId) {
			return;
		}
		if (params.get('share')) {
			return;
		} // share flow takes precedence
		if (!/^[a-zA-Z0-9]{15,18}$/.test(openId)) {
			clearCanvasLaunchParam('openCanvas');
			showCanvasLaunchError('This canvas link is invalid. Your current canvas has not changed.');
			return;
		}
		const finishCanvasLoad = beginCanvasReplacementLoad('Opening canvas\u2026');
		_allObjectsReady.then(async () => {
			try {
				if (await platform.recovery?.ready?.()) return;
				const r = await csrfFetch('/api/canvas/' + encodeURIComponent(openId), { credentials: 'same-origin' });
				const data = await r.json().catch(() => null);
				if (!r.ok) {
					const unavailable = r.status === 404 || (data && data.error === 'canvas-not-accessible');
					showCanvasLaunchError(
						unavailable
							? 'Org Loom could not open this canvas. It may have been deleted, or it may not be shared with your current Salesforce user. Your current canvas has not changed.'
							: (data && (data.message || data.error)) ||
									'Could not open the canvas (HTTP ' + r.status + ').',
					);
					return;
				}
				await applyCanvasPayload(data.payload || {}, {
					merge: false,
					ownedByMe: !!data.ownedByMe,
					recipientRole: data.recipientRole || null,
					canvasIdentity: {
						id: openId,
						title: data.title || '',
						ownedByMe: !!data.ownedByMe,
						versionId: data.versionId || null,
						recipientRole: data.recipientRole || null,
					},
				});
				_setStaleRefsFromLoad(data.staleRefs);
				canvasState.currentCanvas = {
					id: openId,
					title: data.title || '',
					ownedByMe: !!data.ownedByMe,
					versionId: data.versionId || null,
					recipientRole: data.recipientRole || null,
				};
				_canvasSaveState.captureSaved({ savedAt: data.updatedAt });
				if (
					_reauthFallbackCanvasId &&
					String(_reauthFallbackCanvasId).slice(0, 15) === String(openId).slice(0, 15)
				) {
					showBulkToast(
						'Reconnected to Salesforce. Org Loom opened the last saved version because the unsaved canvas could not be restored.',
						'warning',
					);
				}
				announceMergedContributions(data);
				try {
					const restored = rehydrateSessionDraftValues(openId);
					if (restored > 0) {
						renderBulkView();
					}
				} catch (err) {
					window.ORGLOOM_capture &&
						window.ORGLOOM_capture(err, {
							where: 'app.js/loadCanvas/rehydrateSession',
						});
				}
				_watchProposalsForCurrentCanvas();
				if (!data.ownedByMe && data.recipientRole) {
					_canvasShareCanvasId = openId;
					_canvasShareRole = data.recipientRole;
					renderShareRecipientBanner();
				}
				renderBulkView();
				renderBulkToolbar();
			} catch (err) {
				console.warn('[canvas open-deep-link] failed:', err);
				showCanvasLaunchError(
					'Could not open the canvas: ' + (err.message || err) + '. Your current canvas has not changed.',
				);
			} finally {
				clearCanvasLaunchParam('openCanvas');
				finishCanvasLoad();
			}
		});
	})();

	function renderShareRecipientBanner() {
		if (!_canvasShareCanvasId) {
			return;
		}
		renderOrgBanner();
		const isEditor = _canvasShareRole === 'editor';
		const isViewer = _canvasShareRole === 'viewer';
		document.body.classList.add('canvas-share-banner-active');
		if (isEditor) {
			document.body.classList.remove('canvas-recipient-mode');
		} else {
			document.body.classList.add('canvas-recipient-mode');
		}
		let host = document.getElementById('share-recipient-banner');
		if (!host) {
			host = document.createElement('div');
			host.id = 'share-recipient-banner';
		}
		const subbar = document.getElementById('graph-subbar');
		if (subbar && host.previousElementSibling !== subbar) {
			subbar.insertAdjacentElement('afterend', host);
		} else if (!host.parentElement) {
			document.body.appendChild(host);
		}
		host.className = isEditor
			? 'share-recipient-banner share-recipient-banner--editor'
			: isViewer
				? 'share-recipient-banner share-recipient-banner--viewer'
				: 'share-recipient-banner';
		if (isEditor) {
			host.innerHTML =
				'<span class="share-recipient-banner-text">' +
				'<strong>Editor mode.</strong> ' +
				'You’re co-authoring a canvas owned by someone else. You can save canvas changes, but only the owner can upload them to Salesforce.' +
				'</span>';
		} else if (isViewer) {
			host.innerHTML =
				'<span class="share-recipient-banner-text">' +
				'<strong>View only.</strong> ' +
				'You can explore this shared canvas, but you can’t make changes. Ask the owner for contributor access if you need to complete requests.' +
				'</span>';
		} else {
			host.innerHTML =
				'<span class="share-recipient-banner-text">' +
				"<strong>Contributor mode.</strong> Use Your tasks to complete the owner's requests. Open a task, add the requested information, then choose <strong>Save changes</strong>. Your changes are shared with the canvas owner and are not uploaded to Salesforce." +
				'</span>';
		}
	}

	function setShareRecipientSubmitState(state) {
		_shareRecipientSubmitState = state;
		if (_shareRecipientSubmitResetTimer) {
			clearTimeout(_shareRecipientSubmitResetTimer);
			_shareRecipientSubmitResetTimer = null;
		}
		renderShareRecipientBanner();
		if (state === 'success') {
			_shareRecipientSubmitResetTimer = setTimeout(() => {
				_shareRecipientSubmitResetTimer = null;
				if (_shareRecipientSubmitState === 'success') {
					_shareRecipientSubmitState = 'idle';
					renderShareRecipientBanner();
				}
			}, 2500);
		}
	}

	async function submitShareRecipientFills() {
		if (_shareRecipientSubmitState === 'pending') {
			return;
		}
		if (!_canvasShareCanvasId) {
			showBulkToast('No active share session to submit to.', 'error');
			return;
		}
		const fills = [];
		for (const r of canvasState.bulkRecords) {
			if (!r || r.isTypeNode || r.isPending) {
				continue;
			}
			if (!r.slot || r.slot.slotId == null) {
				continue;
			}
			const values = r.values && typeof r.values === 'object' ? r.values : {};
			const requestedFields =
				r.slot.kind === 'fields' && Array.isArray(r.slot.fields) ? new Set(r.slot.fields) : null;
			const submittedValues = {};
			for (const fieldName of Object.keys(values)) {
				if (!requestedFields || requestedFields.has(fieldName)) {
					submittedValues[fieldName] = values[fieldName];
				}
			}
			const relationshipFields =
				r._slotChangedRelationshipFields instanceof Set
					? Array.from(r._slotChangedRelationshipFields).filter(
							(fieldName) =>
								(!requestedFields || requestedFields.has(fieldName)) &&
								Object.prototype.hasOwnProperty.call(submittedValues, fieldName),
						)
					: [];
			fills.push({
				slotId: r.slot.slotId,
				values: submittedValues,
				...(relationshipFields.length > 0 ? { relationshipFields } : {}),
			});
		}
		if (fills.length === 0) {
			showBulkToast('No contributor requests to submit. Complete a highlighted request first.', 'error');
			return;
		}
		setShareRecipientSubmitState('pending');
		let succeeded = false;
		try {
			const resp = await csrfFetch('/api/canvas/' + encodeURIComponent(_canvasShareCanvasId) + '/slot-fill', {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ fills }),
			});
			const data = await resp.json().catch(() => null);
			if (!resp.ok) {
				const msg = (data && (data.message || data.error)) || 'HTTP ' + resp.status;
				showBulkToast('Submit failed: ' + msg, 'error');
				return;
			}
			const submitted = Number(data && data.submitted) || 0;
			if (submitted === 0) {
				showBulkToast('No contributor requests were submitted. Reload the canvas and try again.', 'error');
				return;
			}
			succeeded = true;
			if (platform.afterRequestsSubmitted) {
				await platform.afterRequestsSubmitted({
					role: _canvasShareRole,
					fills,
					response: data,
					canvasState,
					reload: _reloadCanvasFromServer,
					render: renderBulkView,
				});
			}
			setShareRecipientSubmitState('success');
			showBulkToast(
				'Submitted ' +
					submitted +
					' request' +
					(submitted === 1 ? '' : 's') +
					' to the canvas owner. Nothing was uploaded to Salesforce.',
				data && data.skipped && data.skipped.length > 0 ? 'warn' : undefined,
			);
		} catch (err) {
			showBulkToast('Submit failed: ' + (err.message || err), 'error');
		} finally {
			if (!succeeded) {
				setShareRecipientSubmitState('idle');
			}
		}
	}

	let _currentTeam = null;
	function refreshCurrentTeam() {
		return Promise.all([
			window.OrgLoom && typeof window.OrgLoom.fetchMe === 'function'
				? window.OrgLoom.fetchMe()
				: csrfFetch('/api/me', { credentials: 'same-origin' })
						.then((r) => (r.ok ? r.json() : null))
						.catch(() => null),
			csrfFetch('/api/workspaces', { credentials: 'same-origin' })
				.then((r) => (r.ok ? r.json() : null))
				.catch(() => null),
		]).then(([me, list]) => {
			if (me && me.workspace) {
				_currentTeam = {
					id: me.workspace.id,
					name: me.workspace.name,
					role: me.workspace.role || 'member',
					plan: me.workspace.plan || 'free',
					teams: list && Array.isArray(list.workspaces) ? list.workspaces : [],
					members: [],
					settings: Object.assign({}, DEFAULT_TEAM_SETTINGS),
				};
			} else {
				_currentTeam = null;
			}
			return _currentTeam;
		});
	}
	refreshCurrentTeam();

	let _meInfo = null;
	let _workspaceAccessEventSource = null;
	const DEFAULT_TEAM_SETTINGS = Object.freeze({
		salesforce_org_filter_mode: 'none',
		invite_approval_required: 0,
	});
	const isTeamAdmin = () => !!(_currentTeam && _currentTeam.role === 'admin');
	const _isOnPaidPlan = () => !!(_currentTeam && (_currentTeam.plan === 'pro' || _currentTeam.plan === 'team'));
	const teamFlag = (name) => !!(_currentTeam && _currentTeam.settings && _currentTeam.settings[name]);
	let _readOnlyMode = false;
	function readOnlyKey() {
		return 'sf-loader-readonly:' + (window.SF_ORG_ID || 'anon');
	}
	function loadReadOnlyState() {
		try {
			return localStorage.getItem(readOnlyKey()) === '1';
		} catch (e) {
			return false;
		}
	}
	function saveReadOnlyState(v) {
		try {
			if (v) {
				localStorage.setItem(readOnlyKey(), '1');
			} else {
				localStorage.removeItem(readOnlyKey());
			}
		} catch (e) {}
	}

	(window.OrgLoom && typeof window.OrgLoom.fetchMe === 'function'
		? window.OrgLoom.fetchMe()
		: csrfFetch('/api/me', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null))
	)
		.then(async (me) => {
			if (!me) {
				return;
			}
			_meInfo = me;
			if (me.workspace && me.workspace.id && window.OrgLoom && window.OrgLoom.workspaceContext) {
				window.OrgLoom.workspaceContext.set(me.workspace.id);
			}
			_subscribeWorkspaceAccessEvents();
			const orgType = me.orgType || 'unknown';

			if (me.workspace && me.workspace.id) {
				try {
					const r = await csrfFetch('/api/workspaces/' + encodeURIComponent(me.workspace.id), {
						credentials: 'same-origin',
					});
					if (r.ok) {
						const data = await r.json();
						_currentTeam = Object.assign({}, _currentTeam || {}, {
							id: data.workspace.id,
							name: data.workspace.name,
							role: data.role,
							members: data.members || [],
							settings: Object.assign({}, DEFAULT_TEAM_SETTINGS, data.settings || {}),
						});
					}
				} catch (_) {}
			}

			if (typeof renderBulkView === 'function' && canvasState.graphView === 'bulk') {
				renderBulkView();
			}

			const stored = (function () {
				try {
					return localStorage.getItem(readOnlyKey());
				} catch (e) {
					return null;
				}
			})();
			if (stored === null && orgType === 'production') {
				_readOnlyMode = true;
				saveReadOnlyState(true);
			} else {
				_readOnlyMode = stored === '1';
			}
			renderOrgBanner();
			if (typeof renderBulkView === 'function' && canvasState.graphView === 'bulk') {
				renderBulkView();
			}
		})
		.catch(() => {});

	function _subscribeWorkspaceAccessEvents() {
		if (
			window.ORGLOOM_MOCK ||
			_workspaceAccessEventSource ||
			!window.EventSource ||
			!_meInfo ||
			!_meInfo.workspace ||
			!_meInfo.workspace.id
		) {
			return;
		}
		_workspaceAccessEventSource = new EventSource(
			'/api/workspaces/' + encodeURIComponent(_meInfo.workspace.id) + '/access-events',
		);
		_workspaceAccessEventSource.addEventListener('open', () => {
			_refreshOrgApprovalState();
		});
		_workspaceAccessEventSource.addEventListener('access-change', (event) => {
			try {
				const change = JSON.parse(event.data);
				if (change.capability === 'workspace-membership' && change.status === 'removed') {
					_handleWorkspaceMembershipRemoved();
					return;
				}
				if (
					change.capability === 'connect-sf-org' &&
					change.target === '*' &&
					change.status === 'policy-changed'
				) {
					_refreshOrgApprovalState();
					return;
				}
				const connection = _meInfo && _meInfo.connection;
				if (
					!connection ||
					change.capability !== 'connect-sf-org' ||
					String(change.target || '').slice(0, 15) !== String(connection.sfOrgId || '').slice(0, 15)
				) {
					return;
				}
				_refreshOrgApprovalState();
			} catch (error) {
				window.ORGLOOM_capture && window.ORGLOOM_capture(error, { where: 'app.js/workspace-access-event' });
			}
		});
		_workspaceAccessEventSource.addEventListener('error', () => {
			_verifyWorkspaceMembershipAfterAccessStreamError();
		});
	}

	function _handleWorkspaceMembershipRemoved() {
		if (
			window.OrgLoom &&
			window.OrgLoom.workspaceContext &&
			typeof window.OrgLoom.workspaceContext.handleMembershipRemoved === 'function'
		) {
			window.OrgLoom.workspaceContext.handleMembershipRemoved();
			return;
		}
		window.OrgLoom = window.OrgLoom || {};
		window.OrgLoom.workspaceMembershipTransition = true;
		window.location.replace('/workspace?membership=removed#account');
	}

	let _workspaceMembershipVerification = null;
	function _verifyWorkspaceMembershipAfterAccessStreamError() {
		if (
			_workspaceMembershipVerification ||
			!_meInfo ||
			!_meInfo.workspace ||
			!_meInfo.workspace.id ||
			(window.OrgLoom && window.OrgLoom.workspaceMembershipTransition)
		) {
			return;
		}
		const workspaceId = _meInfo.workspace.id;
		_workspaceMembershipVerification = csrfFetch(
			'/api/workspaces/' + encodeURIComponent(workspaceId) + '/permissions/me',
			{ credentials: 'same-origin' },
		)
			.then(async (response) => {
				if (response.status !== 403) {
					return;
				}
				let body = null;
				try {
					body = await response.json();
				} catch (_) {}
				if (body && body.error === 'not-a-member') {
					_handleWorkspaceMembershipRemoved();
				}
			})
			.catch(() => {})
			.finally(() => {
				_workspaceMembershipVerification = null;
			});
	}

	async function _refreshOrgApprovalState() {
		try {
			const response = await csrfFetch('/api/me', { credentials: 'same-origin' });
			const latest = response.ok ? await response.json() : null;
			if (!latest || !_meInfo) {
				return;
			}
			if (latest.connection && _meInfo.connection && latest.connection.id !== _meInfo.connection.id) {
				return;
			}
			_meInfo.connection = latest.connection;
			_meInfo.orgApproval = latest.orgApproval || null;
			_meInfo.orgType = latest.orgType || (latest.connection && latest.connection.orgType) || _meInfo.orgType;
			renderOrgBanner();
		} catch (_) {}
	}

	function renderOrgBanner() {
		const banner = graph.querySelector('#org-banner');
		if (!banner || !_meInfo) {
			return;
		}
		const orgAccess = _meInfo.orgApproval || { blocked: false };
		const blocked = orgAccess.blocked === true;
		const current = canvasState.currentCanvas;
		const params = new URLSearchParams(window.location.search || '');
		const openingSharedCanvas = (!current || !current.id) && params.has('share');
		if (!blocked && ((current && current.id && current.ownedByMe === false) || openingSharedCanvas)) {
			banner.classList.add('hidden');
			banner.innerHTML = '';
			return;
		}
		if (_meInfo.orgType !== 'production' && !_readOnlyMode && !blocked) {
			banner.classList.add('hidden');
			banner.innerHTML = '';
			return;
		}
		banner.classList.remove('hidden');
		banner.classList.toggle('org-banner--prod', _meInfo.orgType === 'production');
		banner.classList.toggle('org-banner--readonly', _readOnlyMode && _meInfo.orgType !== 'production');
		banner.classList.toggle('org-banner--blocked', blocked);
		let icon, headline, controls;
		if (blocked) {
			const orgTypeLabel =
				_meInfo.orgType === 'production'
					? 'production org'
					: _meInfo.orgType === 'sandbox' || _meInfo.orgType === 'developer'
						? 'non-production org'
						: 'Salesforce org';
			icon = '\u2717';
			const orgLabel = orgAccess.sfOrgLabel ? ' <code>' + escapeHtml(orgAccess.sfOrgLabel) + '</code>' : '';
			headline =
				'This ' +
				orgTypeLabel +
				orgLabel +
				' is <strong>not on the workspace allowlist</strong>. Org Loom cannot use this connection. Ask a workspace administrator to add its Current My Domain URL in Workspace settings.';
			controls = '<a class="button secondary ob-request" href="/connect">Open Salesforce connections</a>';
		} else {
			icon = _meInfo.orgType === 'production' ? '\u26A0' : '\uD83D\uDD12';
			headline =
				_meInfo.orgType === 'production'
					? 'Connected to a <strong>production org</strong>. Uploads write to live data.'
					: 'Read-only mode is on. Uploads are disabled until you turn it off.';
			controls =
				'<label class="ob-toggle">' +
				'<input type="checkbox" data-readonly-toggle' +
				(_readOnlyMode ? ' checked' : '') +
				'>' +
				'<span>Read-only mode</span>' +
				'</label>';
		}
		banner.innerHTML =
			'<span class="ob-icon">' + icon + '</span>' + '<span class="ob-msg">' + headline + '</span>' + controls;
		const cb = banner.querySelector('[data-readonly-toggle]');
		if (cb) {
			cb.addEventListener('change', () => {
				_readOnlyMode = !!cb.checked;
				saveReadOnlyState(_readOnlyMode);
				renderOrgBanner();
				if (typeof renderBulkView === 'function' && canvasState.graphView === 'bulk') {
					renderBulkView();
				}
			});
		}
	}

	function escapeHtml(s) {
		return String(s == null ? '' : s).replace(
			/[&<>"']/g,
			(c) =>
				({
					'&': '&amp;',
					'<': '&lt;',
					'>': '&gt;',
					'"': '&quot;',
					"'": '&#39;',
				})[c],
		);
	}

	const _progressBar = document.createElement('div');
	_progressBar.className = 'top-progress';
	document.body.appendChild(_progressBar);
	let _activeFetches = 0;
	const _origFetch = window.fetch;
	window.fetch = function (...args) {
		_activeFetches++;
		_progressBar.classList.add('active');
		return _origFetch
			.apply(this, args)
			.then((res) => {
				return res;
			})
			.finally(() => {
				_activeFetches = Math.max(0, _activeFetches - 1);
				if (_activeFetches === 0) {
					_progressBar.classList.remove('active');
				}
			});
	};

	const GRAPH_ZOOM_MIN = 0.3;
	const GRAPH_ZOOM_MAX = 1.5;
	let _bulkRenderShiftX = 0;
	let _bulkRenderShiftY = 0;
	const RECORDS_WORLD_SCALE = 1.4;
	let _highlightedRingKey = null;
	let _highlightedSelId = null;
	let _ringClickTimer = null;
	const RING_CLICK_DEBOUNCE_MS = 280;
	const PAN_DURATION_MS = 850;
	let _skipNextAutoFit = false;

	let slotIdSeq = 1;
	let _selectedDerivedEdge = null;

	const _userDeletedSelectionIds = new Set();
	const BULK_ZOOM_MIN = 0.3;
	const BULK_ZOOM_MAX = 1.5;

	const graph = document.createElement('div');
	graph.className = 'graph-overlay schema-collapsed cy-mode';
	graph.innerHTML =
		'<div class="org-banner hidden" id="org-banner"></div>' +
		'<div class="migrate-mode-bar hidden" id="migrate-mode-bar"></div>' +
		'<div class="graph-subbar bulk-toolbar" id="graph-subbar">' +
		'<span class="subbar-clone-mount" id="subbar-clone-btns"></span>' +
		'<span class="subbar-records" id="subbar-records"></span>' +
		'</div>' +
		'<div class="graph-split" id="graph-split">' +
		'<div class="schema-controls-overlay" id="schema-controls-overlay">' +
		'<button type="button" class="batch-btn schema-find-object" id="schema-find-object" title="Center the schema on any object">+ Find object</button>' +
		'<div class="graph-filter" id="graph-filter-wrap">' +
		'<input id="graph-filter-input" type="search" placeholder="Filter objects…" autocomplete="off">' +
		'<button class="graph-filter-clear" data-graph-filter-clear title="Clear filter" style="display:none">clear</button>' +
		'<div class="segmented" id="graph-rel-filter" title="Show parents, children, or both">' +
		'<button type="button" data-rel-filter="both">Both</button>' +
		'<button type="button" data-rel-filter="parent" class="active">Parents</button>' +
		'<button type="button" data-rel-filter="child">Children</button>' +
		'</div>' +
		'<button type="button" class="batch-btn schema-system-chip" id="schema-system-fields-chip">System fields filter: \u2026</button>' +
		'</div>' +
		'</div>' +
		'<div class="graph-canvas" id="graph-canvas">' +
		'<div class="graph-content" id="graph-content">' +
		'<svg class="graph-edges" id="graph-edges"></svg>' +
		'<div class="graph-nodes" id="graph-nodes"></div>' +
		'</div>' +
		'<div class="base-picker hidden" id="base-picker"></div>' +
		'<div class="graph-zoom-hud" id="graph-zoom-hud" style="display:none"></div>' +
		'</div>' +
		'<div class="graph-canvas-cy" id="graph-canvas-cy"></div>' +
		'<div class="graph-split-resizer" id="graph-split-resizer" role="separator" aria-orientation="vertical" title="Drag to resize the schema canvas">' +
		'<button type="button" class="graph-split-collapse" id="graph-split-collapse" title="Open schema explorer" aria-label="Open schema explorer"><span class="gsc-arrow" aria-hidden="true">\u276E</span></button>' +
		'</div>' +
		'<div class="graph-bulk" id="graph-bulk">' +
		'<div class="bulk-user-warning" id="bulk-user-warning" hidden>' +
		'<span class="buw-icon" aria-hidden="true">\u26A0</span>' +
		'<span class="buw-msg">' +
		'<strong>User records on this canvas.</strong> ' +
		"Each new User consumes a license, can't be deleted (only deactivated), and triggers a Salesforce welcome email. " +
		'Seed sets <code>IsActive=false</code> by default to suppress the email until you review.' +
		'</span>' +
		'</div>' +
		'<div class="bulk-canvas" id="bulk-canvas">' +
		'<div class="bulk-content" id="bulk-content">' +
		'<svg class="bulk-edges" id="bulk-edges"></svg>' +
		'<div class="bulk-nodes" id="bulk-nodes"></div>' +
		'</div>' +
		'<div class="bulk-empty" id="bulk-empty">No records yet.</div>' +
		'<div class="bulk-first-hint" id="bulk-first-hint" style="display:none">' +
		'<span>Double-click a card to fill its fields, or use <strong>Seed required fields</strong> to populate them all at once.</span>' +
		'<button type="button" data-dismiss-first-hint aria-label="Dismiss">&times;</button>' +
		'</div>' +
		'<div class="graph-zoom-hud" id="bulk-zoom-hud" style="display:none"></div>' +
		'</div>' +
		'<div class="bulk-canvas-cy" id="bulk-canvas-cy"></div>' +
		(function _renderEmptyPlaceholder() {
			var _sfOff = window.ORGLOOM_SF_CONNECTED === false;
			var _step0 = _sfOff
				? '<li class="bec-step bec-step--active">' +
					'<div class="bec-step-num">0</div>' +
					'<div class="bec-step-body">' +
					'<div class="bec-step-title">Connect Salesforce</div>' +
					'<div class="bec-step-hint">Pick an org to pull records from. Everything else unlocks once you\'re connected.</div>' +
					'<div class="bec-step-quick-actions">' +
					'<button type="button" class="bec-quick bec-quick--primary" data-bec-action="connect" title="Open the Salesforce connections modal">Connect Salesforce &rarr;</button>' +
					'</div>' +
					'</div>' +
					'</li>'
				: '';
			var _step1Cls = _sfOff ? 'bec-step bec-step--locked' : 'bec-step bec-step--active';
			var _qDis = _sfOff ? ' disabled aria-disabled="true"' : '';
			return (
				'<div class="bulk-empty-placeholder" id="bulk-empty-placeholder" style="display:none">' +
				'<div class="bulk-empty-card' +
				(_sfOff ? ' bulk-empty-card--with-step0' : '') +
				'">' +
				'<button type="button" class="bec-dismiss" data-bec-dismiss title="Hide this onboarding card" aria-label="Dismiss">&times;</button>' +
				'<h3 class="bec-title">Start building your canvas</h3>' +
				'<p class="bec-subtitle">A canvas is a working set of Salesforce records you can preview, edit, and upload as a batch.</p>' +
				'<ol class="bec-steps">' +
				_step0 +
				'<li class="' +
				_step1Cls +
				'">' +
				'<div class="bec-step-num">1</div>' +
				'<div class="bec-step-body">' +
				'<div class="bec-step-title">Add records</div>' +
				'<div class="bec-step-quick-actions">' +
				'<button type="button" class="bec-quick" data-bec-action="browse"' +
				_qDis +
				' title="Browse and pick records from Salesforce to load onto the canvas">Browse records</button>' +
				'<button type="button" class="bec-quick" data-bec-action="blank" data-bulk-empty-add' +
				_qDis +
				' title="Pick an object type and drop an empty draft on the canvas">Add a blank record</button>' +
				(window.OrgLoom.platform?.recordRequests === false
					? ''
					: '<button type="button" class="bec-quick" data-bec-action="request"' +
						_qDis +
						' title="Ask a teammate to create or choose a record">Request a record</button>') +
				'<button type="button" class="bec-quick" data-bec-action="csv"' +
				_qDis +
				' title="Upload one or more CSV files">Import CSV</button>' +
				'<button type="button" class="bec-quick" data-bec-action="soql"' +
				_qDis +
				' title="Write a SOQL SELECT to pull records into the canvas">Import via SOQL</button>' +
				'</div>' +
				'</div>' +
				'</li>'
			);
		})() +
		'<li class="bec-step">' +
		'<div class="bec-step-num">2</div>' +
		'<div class="bec-step-body">' +
		'<div class="bec-step-title">Save your canvas <span class="bec-step-optional">(optional)</span></div>' +
		'<div class="bec-step-hint">Come back to it later, or share it with a teammate.</div>' +
		'</div>' +
		'</li>' +
		'<li class="bec-step">' +
		'<div class="bec-step-num">3</div>' +
		'<div class="bec-step-body">' +
		'<div class="bec-step-title">Upload to Salesforce</div>' +
		'<div class="bec-step-hint">Push some or all records in one batch when you’re ready.</div>' +
		'</div>' +
		'</li>' +
		'</ol>' +
		'<a class="bec-doclink" href="/docs/walkthroughs/quick-start" target="_blank" rel="noopener">Follow the Quick start &rarr;</a>' +
		'</div>' + // .bulk-empty-card
		'</div>' + // .bulk-empty-placeholder
		'<div class="canvas-name-overlay" id="canvas-name-overlay" aria-label="Current canvas: New canvas">' +
		'<strong id="canvas-name-text">New canvas</strong>' +
		'</div>' +
		'<div class="canvas-save-status-overlay canvas-save-status-overlay--new" id="canvas-save-status-overlay" aria-live="polite">Not saved</div>' +
		'<div class="canvas-top-left-overlays">' +
		'<div class="canvas-status-strip" id="canvas-status-strip">' +
		'<div class="bulk-count-chip" id="bulk-count-chip"></div>' +
		'</div>' +
		'<aside class="shared-task-sidebar" id="shared-task-sidebar" hidden aria-live="polite"></aside>' +
		'<aside class="shared-task-sidebar upload-fixes-sidebar" id="upload-fixes-sidebar" hidden aria-live="polite"></aside>' +
		'<aside class="canvas-onboarding-progress" id="canvas-onboarding-progress" hidden aria-label="Getting started">' +
		'<button type="button" class="cog-dismiss" data-cog-dismiss title="Hide this guide" aria-label="Dismiss getting started guide">&times;</button>' +
		'<h3 class="cog-title">Getting started</h3>' +
		'<ol class="cog-steps">' +
		'<li class="cog-step cog-step--done"><span class="cog-step-num" aria-hidden="true">&#10003;</span><span>Add records</span></li>' +
		'<li class="cog-step" data-cog-save-step><span class="cog-step-num" aria-hidden="true">2</span><span>Save your canvas <small>(optional)</small></span></li>' +
		'<li class="cog-step" data-cog-upload-step><span class="cog-step-num" aria-hidden="true">3</span><span>Upload to Salesforce</span></li>' +
		'</ol>' +
		'<a class="cog-doclink" href="/docs/walkthroughs/quick-start" target="_blank" rel="noopener">Quick start &rarr;</a>' +
		'</aside>' +
		'</div>' +
		'<div class="bulk-canvas-hint" id="bulk-canvas-hint" style="display:none">' +
		'<span class="bch-icon" aria-hidden="true">⊞</span>' +
		'<span class="bch-text">Right-click to add a record</span>' +
		'</div>' +
		'<div class="object-filter-panel" id="object-filter-panel" hidden></div>' +
		'<div class="bulk-selection-chip" id="bulk-selection-chip" style="display:none"></div>' +
		'</div>' +
		'</div>' +
		'<div class="canvas-shortcut-hint" id="canvas-shortcut-hint" title="Open shortcuts reference">' +
		'Press <kbd class="canvas-shortcut-hint-key">?</kbd> for shortcuts' +
		'</div>';
	document.body.appendChild(graph);
	const _shortcutHintEl = graph.querySelector('#canvas-shortcut-hint');
	if (_shortcutHintEl) {
		_shortcutHintEl.addEventListener('click', () => {
			if (
				window.Orgloom &&
				window.Orgloom.canvasHelp &&
				typeof window.Orgloom.canvasHelp.openShortcuts === 'function'
			) {
				try {
					window.Orgloom.canvasHelp.openShortcuts(_shortcutHintEl);
				} catch (err) {
					window.ORGLOOM_capture &&
						window.ORGLOOM_capture(err, {
							where: 'app.js/shortcutHint/openShortcuts',
						});
				}
			}
		});
	}

	graph.addEventListener('click', (e) => {
		const card = e.target.closest('.record-card-pending[data-rec-id]');
		if (!card) {
			return;
		}
		const recId = parseInt(card.getAttribute('data-rec-id'), 10);
		if (!Number.isFinite(recId)) {
			return;
		}
		const rec = canvasState.bulkRecords.find((r) => r.id === recId);
		if (!rec || !rec.isPending) {
			return;
		}
		if (e.target.closest('[data-record-delete]')) {
			e.stopPropagation();
			deleteRecord(recId);
			return;
		}
		const blankBtn = e.target.closest('[data-pending-pick-blank]');
		if (blankBtn) {
			e.stopPropagation();
			showFindObjectPopover(blankBtn, {
				header: 'Create new record',
				sub: '',
				objectFilter: (object) => object && object.createable === true,
				emptyText: 'This Salesforce user cannot create any available record types.',
				isAdded: () => false,
				onPick: (name) => resolvePendingRecord(recId, name),
			});
			return;
		}
		const loadBtn = e.target.closest('[data-pending-pick-load]');
		if (loadBtn) {
			e.stopPropagation();
			if (!_hasCap('browse-records')) {
				showBulkToast('Your workspace access does not include loading existing Salesforce records.', 'info');
				return;
			}
			showFindObjectPopover(loadBtn, {
				header: 'Load existing record',
				sub: '',
				isAdded: () => false,
				onPick: (name) => resolvePendingRecordToLoad(recId, name),
			});
			return;
		}
	});

	(function wireSplitResizer() {
		const resizer = graph.querySelector('#graph-split-resizer');
		const split = graph.querySelector('#graph-split');
		const canvasLegacy = graph.querySelector('#graph-canvas');
		const canvasCy = graph.querySelector('#graph-canvas-cy');
		const collapseBtn = graph.querySelector('#graph-split-collapse');
		const MIN_CANVAS = 280;
		const MIN_BULK = 0;
		resizer.addEventListener('pointerdown', (e) => {
			if (e.button !== 0) {
				return;
			}
			if (e.target && e.target.closest('.graph-split-collapse')) {
				return;
			}
			if (graph.classList.contains('schema-collapsed')) {
				return;
			}
			e.preventDefault();
			resizer.setPointerCapture(e.pointerId);
			resizer.classList.add('dragging');
			split.classList.add('resizing');
			const splitRect = split.getBoundingClientRect();
			const applyWidth = (w) => {
				split.style.setProperty('--schema-pane-width', w + 'px');
				[canvasLegacy, canvasCy].forEach((c) => {
					if (!c) {
						return;
					}
					c.style.flex = '0 0 ' + w + 'px';
					c.style.maxWidth = 'none';
					c.style.minWidth = '0';
				});
				if (_cySchemaInstance) {
					_cySchemaInstance.resize();
				}
				if (_cyInstance) {
					_cyInstance.resize();
				}
			};
			const onMove = (ev) => {
				const maxCanvas = splitRect.width - MIN_BULK - resizer.offsetWidth;
				const w = Math.max(MIN_CANVAS, Math.min(maxCanvas, splitRect.right - ev.clientX));
				applyWidth(w);
			};
			const onUp = () => {
				resizer.classList.remove('dragging');
				split.classList.remove('resizing');
				resizer.removeEventListener('pointermove', onMove);
				resizer.removeEventListener('pointerup', onUp);
				resizer.removeEventListener('pointercancel', onUp);
			};
			resizer.addEventListener('pointermove', onMove);
			resizer.addEventListener('pointerup', onUp);
			resizer.addEventListener('pointercancel', onUp);
		});

		if (collapseBtn) {
			collapseBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				const collapsed = graph.classList.toggle('schema-collapsed');
				const arrow = collapseBtn.querySelector('.gsc-arrow');
				if (arrow) {
					arrow.textContent = collapsed ? '\u276E' : '\u276F';
				}
				collapseBtn.title = collapsed ? 'Open schema explorer' : 'Hide schema explorer';
				collapseBtn.setAttribute('aria-label', collapsed ? 'Open schema explorer' : 'Hide schema explorer');
				if (!collapsed) {
					if (typeof renderCanvas === 'function') {
						renderCanvas();
					}
					_runAfterSchemaTransition(() => {
						if (_cySchemaInstance) {
							_cySchemaInstance.resize();
							_cySchemaInstance.fit(undefined, 60);
							if (_cySchemaInstance.zoom() > 1) {
								_cySchemaInstance.zoom(1);
							}
						}
					});
				}
			});
		}
	})();

	graph.querySelector('#graph-canvas').addEventListener(
		'wheel',
		(e) => {
			if (e.defaultPrevented) return;
			if (!e.ctrlKey) {
				return;
			}
			if (e.deltaY === 0) {
				return;
			}
			e.preventDefault();
			const canvas = graph.querySelector('#graph-canvas');
			const content = graph.querySelector('#graph-content');
			const rect = canvas.getBoundingClientRect();
			const mx = e.clientX - rect.left + canvas.scrollLeft;
			const my = e.clientY - rect.top + canvas.scrollTop;
			const contentX = mx / canvasState.graphZoom;
			const contentY = my / canvasState.graphZoom;
			const step = window.OrgLoom.cyInteractions.wheelZoomFactor(e);
			const next = Math.max(GRAPH_ZOOM_MIN, Math.min(GRAPH_ZOOM_MAX, canvasState.graphZoom * step));
			if (next === canvasState.graphZoom) {
				return;
			}
			canvasState.graphZoom = next;
			canvasState._userZoomOverride = true;
			applyGraphZoom();
			canvas.scrollLeft = contentX * canvasState.graphZoom - (e.clientX - rect.left);
			canvas.scrollTop = contentY * canvasState.graphZoom - (e.clientY - rect.top);
		},
		{ passive: false },
	);

	(function wireMiddlePan() {
		let panState = null;
		const beginPan = (canvas, e) => {
			panState = {
				canvas,
				startX: e.clientX,
				startY: e.clientY,
				startScrollLeft: canvas.scrollLeft,
				startScrollTop: canvas.scrollTop,
				prevCursor: canvas.style.cursor,
			};
			canvas.style.cursor = 'grabbing';
			e.preventDefault();
		};
		const onMouseDown = (e) => {
			if (e.button !== 1) {
				return;
			}
			const canvas = e.target.closest('#graph-canvas, #bulk-canvas');
			if (!canvas) {
				return;
			}
			beginPan(canvas, e);
		};
		const onMouseMove = (e) => {
			if (!panState) {
				return;
			}
			const dx = e.clientX - panState.startX;
			const dy = e.clientY - panState.startY;
			panState.canvas.scrollLeft = panState.startScrollLeft - dx;
			panState.canvas.scrollTop = panState.startScrollTop - dy;
			e.preventDefault();
		};
		const endPan = () => {
			if (!panState) {
				return;
			}
			panState.canvas.style.cursor = panState.prevCursor || '';
			panState = null;
		};
		graph.addEventListener('mousedown', onMouseDown);
		document.addEventListener('mousemove', onMouseMove);
		document.addEventListener('mouseup', (e) => {
			if (e.button === 1) {
				endPan();
			}
		});
		window.addEventListener('blur', endPan);
		graph.addEventListener('auxclick', (e) => {
			if (e.button !== 1) {
				return;
			}
			if (e.target.closest('#graph-canvas, #bulk-canvas')) {
				e.preventDefault();
			}
		});
	})();

	graph.addEventListener(
		'wheel',
		(e) => {
			if (e.defaultPrevented) return;
			if (canvasState.graphView !== 'bulk') {
				return;
			}
			const canvas = graph.querySelector('#bulk-canvas');
			if (!canvas || !canvas.contains(e.target)) {
				return;
			}
			if (e.deltaY === 0) {
				return;
			}
			e.preventDefault();
			const rect = canvas.getBoundingClientRect();
			const mx = e.clientX - rect.left + canvas.scrollLeft;
			const my = e.clientY - rect.top + canvas.scrollTop;
			const contentX = mx / canvasState.bulkZoom;
			const contentY = my / canvasState.bulkZoom;
			const step = window.OrgLoom.cyInteractions.wheelZoomFactor(e);
			const next = Math.max(BULK_ZOOM_MIN, Math.min(BULK_ZOOM_MAX, canvasState.bulkZoom * step));
			if (next === canvasState.bulkZoom) {
				return;
			}
			canvasState.bulkZoom = next;
			canvasState._bulkUserZoomOverride = true;
			applyBulkZoom();
			canvas.scrollLeft = contentX * canvasState.bulkZoom - (e.clientX - rect.left);
			canvas.scrollTop = contentY * canvasState.bulkZoom - (e.clientY - rect.top);
		},
		{ passive: false },
	);

	function applyGraphZoom() {
		const content = graph.querySelector('#graph-content');
		if (!content) {
			return;
		}
		content.style.zoom = canvasState.graphZoom;
		const hud = graph.querySelector('#graph-zoom-hud');
		if (hud) {
			if (canvasState.graphZoom !== 1) {
				hud.textContent =
					'Zoom ' + Math.round(canvasState.graphZoom * 100) + '%  \u00b7  ctrl+scroll to adjust';
				hud.style.display = '';
			} else {
				hud.style.display = 'none';
			}
		}
	}
	graph.querySelector('#graph-filter-input').addEventListener('input', (e) => {
		canvasState.graphFilterText = e.target.value.trim();
		graph.querySelector('[data-graph-filter-clear]').style.display = canvasState.graphFilterText ? '' : 'none';
		renderCanvas();
	});
	graph.querySelector('[data-graph-filter-clear]').addEventListener('click', () => {
		canvasState.graphFilterText = '';
		const input = graph.querySelector('#graph-filter-input');
		input.value = '';
		input.focus();
		graph.querySelector('[data-graph-filter-clear]').style.display = 'none';
		renderCanvas();
	});
	graph.querySelectorAll('[data-rel-filter]').forEach((btn) => {
		btn.addEventListener('click', () => {
			canvasState.graphRelFilter = btn.dataset.relFilter;
			graph.querySelectorAll('[data-rel-filter]').forEach((b) => {
				b.classList.toggle('active', b.dataset.relFilter === canvasState.graphRelFilter);
			});
			renderCanvas();
		});
	});

	const _schemaFindBtn = graph.querySelector('#schema-find-object');
	if (_schemaFindBtn) {
		_schemaFindBtn.addEventListener('click', () => {
			showFindObjectPopover(_schemaFindBtn, {
				header: 'Find any object',
				sub: 'Centers the schema on the chosen object. Any current schema view is replaced; from there, click ring peers to navigate.',
				isAdded: () => false,
				onPick: (name) => {
					const apply = () => {
						canvasState._schemaViewObject = name;
						canvasState._schemaViewPath = [];
						canvasState._schemaViewPathEdges = [];
						canvasState._pendingNavOriginPos = null;
						if (typeof renderCanvas === 'function') {
							renderCanvas();
						}
					};
					const cached = canvasState.graphCache && canvasState.graphCache[name];
					if (cached) {
						apply();
						return;
					}
					if (typeof fetchGraphData === 'function') {
						fetchGraphData(name)
							.then(apply)
							.catch((err) => {
								showBulkToast(
									'Couldn’t load schema for ' +
										name +
										': ' +
										((err && err.message) || 'unknown error'),
									'error',
								);
							});
					} else {
						apply();
					}
				},
			});
		});
	}

	function _updateSchemaSystemFieldsChip() {
		const btn = graph.querySelector('#schema-system-fields-chip');
		if (!btn) {
			return;
		}
		const fieldList = Array.from(SCHEMA_SYSTEM_FK_FIELDS).join(', ');
		btn.textContent = 'System fields filter: ' + (canvasState._systemFieldsFilter ? 'on' : 'off');
		btn.title = canvasState._systemFieldsFilter
			? 'Hiding audit relationship lines (' + fieldList + '). Click to show them.'
			: 'Showing audit relationship lines (' + fieldList + '). Click to hide them.';
		btn.classList.toggle('is-on', canvasState._systemFieldsFilter);
	}
	_updateSchemaSystemFieldsChip();
	const _schemaSystemFieldsChipBtn = graph.querySelector('#schema-system-fields-chip');
	if (_schemaSystemFieldsChipBtn) {
		_schemaSystemFieldsChipBtn.addEventListener('click', () => {
			canvasState._systemFieldsFilter = !canvasState._systemFieldsFilter;
			_updateSchemaSystemFieldsChip();
			renderCanvas();
		});
	}

	document.addEventListener('keydown', (e) => {
		if (graph.classList.contains('hidden')) {
			return;
		}
		// Modal interactions belong to the dialog/browser, not the canvas behind it.
		if (
			e.defaultPrevented ||
			Array.from(document.querySelectorAll('.modal:not(.hidden)')).some(
				(modal) => modal.getClientRects().length > 0,
			)
		) {
			return;
		}
		if (e.key === 'Escape') {
			return;
		}
		{
			const cmd = e.ctrlKey || e.metaKey;
			const isInputTarget =
				e.target && (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable);
			if (cmd && !isInputTarget && (e.key === '+' || e.key === '=')) {
				_canvasZoomBy(1.2);
				e.preventDefault();
				return;
			}
			if (cmd && !isInputTarget && e.key === '-') {
				_canvasZoomBy(1 / 1.2);
				e.preventDefault();
				return;
			}
			if (!isInputTarget && e.key === '?') {
				if (
					window.Orgloom &&
					window.Orgloom.canvasHelp &&
					typeof window.Orgloom.canvasHelp.openShortcuts === 'function'
				) {
					try {
						window.Orgloom.canvasHelp.openShortcuts();
					} catch (err) {
						window.ORGLOOM_capture &&
							window.ORGLOOM_capture(err, {
								where: 'app.js/keyboard/openShortcuts',
							});
					}
					e.preventDefault();
					return;
				}
			}
			const recordEditorOpen = Boolean(document.querySelector('.record-editor-modal:not(.hidden)'));
			if (!recordEditorOpen && cmd && (e.key === 's' || e.key === 'S')) {
				e.preventDefault();
				const saveState = _canvasSaveState.getState();
				if (saveState.phase === 'clean' || saveState.phase === 'saving') {
					return;
				}
				const current = canvasState.currentCanvas;
				if (current && current.id) {
					saveExistingCanvas();
				} else {
					promptCanvasSave();
				}
				return;
			}
			if (!isInputTarget && !recordEditorOpen && cmd && (e.key === 'f' || e.key === 'F')) {
				e.preventDefault();
				try {
					openCanvasSearchModal();
				} catch (err) {
					window.ORGLOOM_capture &&
						window.ORGLOOM_capture(err, {
							where: 'app.js/keyboard/openCanvasSearchModal',
						});
				}
				return;
			}
		}
		if (canvasState.graphView === 'bulk') {
			if (e.target && (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable)) {
				return;
			}
			if (e.key === 'Delete' || e.key === 'Backspace') {
				if (canvasState.bulkSelectedIds.size > 0) {
					Array.from(canvasState.bulkSelectedIds).forEach((id) => deleteRecord(id));
					e.preventDefault();
				} else if (canvasState.bulkSelectedEdgeId != null) {
					deleteAssociation(canvasState.bulkSelectedEdgeId);
					e.preventDefault();
				} else if (_selectedDerivedEdge) {
					deleteDerivedFkEdge(_selectedDerivedEdge.recId, _selectedDerivedEdge.fieldName);
					e.preventDefault();
				}
				return;
			}
			const cmd = e.ctrlKey || e.metaKey;
			if (cmd && (e.key === 'c' || e.key === 'C')) {
				const selection = window.getSelection();
				if (selection && !selection.isCollapsed && selection.toString()) {
					return;
				}
				if (!platform.clipboard?.usesEvents && copySelectionToClipboard()) {
					e.preventDefault();
				}
				return;
			}
			if (cmd && (e.key === 'v' || e.key === 'V')) {
				if (platform.clipboard?.usesEvents && !e.shiftKey) {
					return;
				}
				if (e.shiftKey) {
					openPasteCountPrompt();
				} else {
					pasteFromClipboard(1);
				}
				e.preventDefault();
				return;
			}
			if (
				_canvasZHeld &&
				(e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')
			) {
				const step = 50;
				const dx = e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0;
				const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0;
				_canvasPanBy(dx, dy);
				e.preventDefault();
				return;
			}
			if (cmd && (e.key === 'a' || e.key === 'A')) {
				canvasState.bulkSelectedIds = new Set(
					canvasState.bulkRecords.filter((r) => !r.isTypeNode).map((r) => r.id),
				);
				canvasState.bulkSelectedEdgeId = null;
				renderBulkView();
				e.preventDefault();
			}
		}
	});

	async function addToSelection(objectName, addedFromId, addedVia, worldPos) {
		const data = await fetchGraphData(objectName);
		const entry = {
			id: canvasState.selectedIdSeq++,
			name: data.name,
			label: data.label || data.name,
			data,
			addedFrom: addedFromId != null ? addedFromId : null,
			addedVia: addedVia || null,
			worldPos: worldPos || _defaultWorldPosFor(addedFromId),
		};
		canvasState.selectedObjects.push(entry);
		canvasState.activeIndex = canvasState.selectedObjects.length - 1;
		canvasState._bulkUserDeleted = false;
		if (data && data.name) {
			ensureDescribe(data.name).catch(() => {});
		}
		return entry;
	}

	function _defaultWorldPosFor(parentId) {
		if (parentId != null) {
			const parent = canvasState.selectedObjects.find((s) => s.id === parentId);
			if (parent && parent.worldPos) {
				return { x: parent.worldPos.x + 240, y: parent.worldPos.y };
			}
		}
		if (canvasState.selectedObjects.length === 0) {
			return { x: 0, y: 0 };
		}
		const active = canvasState.selectedObjects[canvasState.activeIndex] || canvasState.selectedObjects[0];
		if (active && active.worldPos) {
			return { x: active.worldPos.x, y: active.worldPos.y + 260 };
		}
		return { x: 0, y: 0 };
	}

	function addToSelectionOptimistic(objectName, label, addedFromId, addedVia, worldPos) {
		const cached = canvasState.graphCache[objectName];
		const entry = {
			id: canvasState.selectedIdSeq++,
			name: cached ? cached.name : objectName,
			label: cached ? cached.label || cached.name : label || objectName,
			data: cached || null,
			addedFrom: addedFromId != null ? addedFromId : null,
			addedVia: addedVia || null,
			worldPos: worldPos || _defaultWorldPosFor(addedFromId),
			_loading: !cached,
		};
		canvasState.selectedObjects.push(entry);
		canvasState.activeIndex = canvasState.selectedObjects.length - 1;
		canvasState._bulkUserDeleted = false;
		if (entry.name) {
			ensureDescribe(entry.name).catch(() => {});
		}
		if (cached) {
			return entry;
		} // full data already - no background work
		fetchGraphData(objectName)
			.then((data) => {
				entry.data = data;
				entry.name = data.name || entry.name;
				entry.label = data.label || data.name || entry.label;
				entry._loading = false;
				renderAll();
			})
			.catch((err) => {
				console.warn('graph fetch failed for', objectName, err);
				const i = canvasState.selectedObjects.findIndex((s) => s.id === entry.id);
				if (i !== -1) {
					canvasState.selectedObjects.splice(i, 1);
					if (canvasState.activeIndex >= canvasState.selectedObjects.length) {
						canvasState.activeIndex = Math.max(0, canvasState.selectedObjects.length - 1);
					}
				}
				renderAll();
				showBulkToast && showBulkToast('Failed to load ' + objectName + ': ' + (err.message || err), 'error');
			});
		return entry;
	}

	function buildSelectionTree() {
		const adj = {};
		canvasState.selectedObjects.forEach((s) => {
			adj[s.id] = [];
		});
		canvasState.selectedObjects.forEach((s) => {
			if (s.addedFrom != null && adj[s.addedFrom] !== undefined) {
				adj[s.id].push(s.addedFrom);
				adj[s.addedFrom].push(s.id);
			}
		});
		const active = canvasState.selectedObjects[canvasState.activeIndex];
		const depths = {},
			parents = {};
		if (!active) {
			return { depths, parents, levels: [] };
		}
		depths[active.id] = 0;
		parents[active.id] = null;
		const queue = [active.id];
		while (queue.length) {
			const id = queue.shift();
			(adj[id] || []).forEach((n) => {
				if (depths[n] === undefined) {
					depths[n] = depths[id] + 1;
					parents[n] = id;
					queue.push(n);
				}
			});
		}
		let orphanLevel = Object.values(depths).reduce((m, d) => Math.max(m, d), 0) + 1;
		canvasState.selectedObjects.forEach((s) => {
			if (depths[s.id] === undefined) {
				depths[s.id] = orphanLevel;
				parents[s.id] = null;
			}
		});
		const levels = [];
		Object.keys(depths).forEach((idStr) => {
			const id = Number(idStr);
			const d = depths[idStr];
			if (!levels[d]) {
				levels[d] = [];
			}
			levels[d].push(id);
		});
		return { depths, parents, levels };
	}

	function removeFromSelection(index) {
		const removed = canvasState.selectedObjects[index];
		canvasState.selectedObjects.splice(index, 1);
		if (removed) {
			_userDeletedSelectionIds.delete(removed.id);
		}
		if (canvasState.selectedObjects.length === 0) {
			resetToBasePicker();
			return;
		}
		if (removed) {
			const stillNamed = canvasState.selectedObjects.some((s) => s.name === removed.name);
			const removedRecIds = new Set();
			canvasState.bulkRecords.forEach((r) => {
				const tieToRemoved = r.fromSelectionId === removed.id;
				const collateral = !stillNamed && r.objectName === removed.name;
				if (tieToRemoved || collateral) {
					removedRecIds.add(r.id);
				}
			});
			if (removedRecIds.size > 0) {
				const removedRecs = canvasState.bulkRecords.filter((r) => removedRecIds.has(r.id));
				const removedAssocs = canvasState.bulkAssociations.filter(
					(a) => removedRecIds.has(a.fromId) || removedRecIds.has(a.toId),
				);
				canvasState.bulkRecords = canvasState.bulkRecords.filter((r) => !removedRecIds.has(r.id));
				canvasState.bulkAssociations = canvasState.bulkAssociations.filter(
					(a) => !removedRecIds.has(a.fromId) && !removedRecIds.has(a.toId),
				);
				removedRecIds.forEach((id) => canvasState.bulkSelectedIds.delete(id));
				if (
					canvasState.bulkSelectedEdgeId != null &&
					removedAssocs.some((a) => a.id === canvasState.bulkSelectedEdgeId)
				) {
					canvasState.bulkSelectedEdgeId = null;
				}
				const removedHostIds = new Set();
				removedRecs.forEach((r) => {
					if (r.loadedFromId) {
						removedHostIds.add(r.loadedFromId);
					}
				});
				for (const k of [..._relatedCountCache.keys()]) {
					const parts = k.split('|');
					if (removedHostIds.has(parts[2]) || parts[0] === removed.name) {
						_relatedCountCache.delete(k);
					}
				}
				for (const k of [..._byRefCache.keys()]) {
					const parts = k.split('|');
					if (removedHostIds.has(parts[2]) || parts[0] === removed.name) {
						_byRefCache.delete(k);
					}
				}
				canvasState._prefetchedTypeNodeKeys.clear();
				removedRecIds.forEach((id) => canvasState._renderedRecIds.delete(id));
				canvasState._bulkSeenIds = null;
				canvasState._bulkUserDeleted = false;
				if (typeof pushUndo === 'function') {
					pushUndo('Restore severed records', () => {
						removedRecs.forEach((r) => canvasState.bulkRecords.push(r));
						removedAssocs.forEach((a) => canvasState.bulkAssociations.push(a));
						renderBulkView();
					});
				}
			}
		}
		if (canvasState.activeIndex >= canvasState.selectedObjects.length) {
			canvasState.activeIndex = canvasState.selectedObjects.length - 1;
		}
		if (canvasState.activeIndex < 0) {
			canvasState.activeIndex = 0;
		}
		renderAll();
	}

	function _spreadExactlyStackedRecords() {
		const placed = [];
		const gapX = 260;
		const gapY = 180;
		const isOpen = (candidate) =>
			!placed.some(
				(position) => Math.abs(position.x - candidate.x) < gapX && Math.abs(position.y - candidate.y) < gapY,
			);
		for (const record of canvasState.bulkRecords || []) {
			if (!record || record.isTypeNode) {
				continue;
			}
			const origin = {
				x: Number.isFinite(record.x) ? record.x : 200,
				y: Number.isFinite(record.y) ? record.y : 200,
			};
			const stacked = placed.some(
				(position) => Math.abs(position.x - origin.x) < 1 && Math.abs(position.y - origin.y) < 1,
			);
			if (stacked) {
				for (let ring = 1; ring <= 100; ring++) {
					const candidates = [
						{ x: origin.x, y: origin.y + ring * gapY },
						{ x: origin.x + ring * gapX, y: origin.y },
						{ x: origin.x - ring * gapX, y: origin.y },
						{ x: origin.x, y: origin.y - ring * gapY },
						{ x: origin.x + ring * gapX, y: origin.y + ring * gapY },
						{ x: origin.x - ring * gapX, y: origin.y + ring * gapY },
						{ x: origin.x + ring * gapX, y: origin.y - ring * gapY },
						{ x: origin.x - ring * gapX, y: origin.y - ring * gapY },
					];
					const open = candidates.find(isOpen);
					if (open) {
						record.x = open.x;
						record.y = open.y;
						break;
					}
				}
			} else {
				record.x = origin.x;
				record.y = origin.y;
			}
			placed.push({ x: record.x, y: record.y });
		}
	}

	function renderAll() {
		_spreadExactlyStackedRecords();
		canvasState.graphView = 'bulk';
		const split = graph.querySelector('#graph-split');
		if (split) {
			split.classList.add('has-base');
		}
		renderChips();
		renderBaseChip();
		const doRender = () => {
			renderCanvas();
			renderBulkView();
		};
		const isPanRender = !!canvasState._pendingPan;
		if (document.startViewTransition && !canvasState._suppressNextViewTransition && !isPanRender) {
			document.startViewTransition(doRender);
		} else {
			canvasState._suppressNextViewTransition = false;
			doRender();
		}
		if (isPanRender) {
			const pan = canvasState._pendingPan;
			canvasState._pendingPan = null;
			let dx = pan.dx || 0;
			let dy = pan.dy || 0;
			if (pan.fromClient && pan.targetSelId != null) {
				const canvas = graph.querySelector('#graph-canvas');
				const newEl = canvas && canvas.querySelector('[data-sel-id="' + pan.targetSelId + '"]');
				if (newEl && canvas) {
					const newRect = newEl.getBoundingClientRect();
					const newCx = newRect.left + newRect.width / 2;
					const newCy = newRect.top + newRect.height / 2;
					dx = pan.fromClient.x - newCx;
					dy = pan.fromClient.y - newCy;
				}
			}
			_runPanAnimation(dx, dy);
		}
		if (_skipNextAutoFit) {
			_skipNextAutoFit = false;
		}
	}

	let _currentPanAnim = null;
	function _runPanAnimation(dx, dy) {
		const content = graph.querySelector('#graph-content');
		if (!content) {
			return;
		}
		if (typeof content.animate !== 'function') {
			return;
		}
		if (_currentPanAnim) {
			try {
				_currentPanAnim.cancel();
			} catch (e) {}
			_currentPanAnim = null;
		}
		content.style.transformOrigin = '0 0';
		content.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)';
		void content.offsetWidth; // force layout flush so the inline transform commits before any paint
		const anim = content.animate(
			[{ transform: 'translate(' + dx + 'px, ' + dy + 'px)' }, { transform: 'translate(0, 0)' }],
			{
				duration: PAN_DURATION_MS,
				easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
			},
		);
		_currentPanAnim = anim;
		const cleanup = () => {
			if (_currentPanAnim === anim) {
				_currentPanAnim = null;
			}
			content.style.transform = '';
			if (typeof renderCanvas === 'function') {
				renderCanvas();
			}
		};
		anim.onfinish = cleanup;
		anim.oncancel = cleanup;
	}

	function navigateToSelection(targetIdx, fromActiveId, fromClient) {
		if (targetIdx < 0 || targetIdx >= canvasState.selectedObjects.length) {
			return;
		}
		const fromId =
			fromActiveId != null
				? fromActiveId
				: canvasState.selectedObjects[canvasState.activeIndex] &&
					canvasState.selectedObjects[canvasState.activeIndex].id;
		const fromEntry = canvasState.selectedObjects.find((s) => s.id === fromId);
		const toEntry = canvasState.selectedObjects[targetIdx];
		if (!fromEntry || !toEntry || !fromEntry.worldPos || !toEntry.worldPos) {
			canvasState.activeIndex = targetIdx;
			renderAll();
			return;
		}
		canvasState._pendingPan = {
			dx: toEntry.worldPos.x - fromEntry.worldPos.x,
			dy: toEntry.worldPos.y - fromEntry.worldPos.y,
			fromClient: fromClient || null,
			targetSelId: toEntry.id,
		};
		_skipNextAutoFit = true;
		canvasState.activeIndex = targetIdx;
		renderAll();
	}

	function renderStepper() {}
	function renderBaseChip() {}

	function resetToBasePicker() {
		_clearUploadFixes();
		closeRecordEditors();
		canvasState.selectedObjects = [];
		canvasState.selectedIdSeq = 1;
		canvasState.activeIndex = 0;
		canvasState.hiddenObjects.clear();
		canvasState.graphFilterText = '';
		canvasState.graphRelFilter = 'parent';
		canvasState.bulkRecords = [];
		canvasState.bulkAssociations = [];
		canvasState.bulkIdSeq = 1;
		canvasState.bulkSelectedIds = new Set();
		canvasState.bulkSelectedEdgeId = null;
		canvasState.bulkClipboard = null;
		canvasState.bulkInitialized = true;
		canvasState._bulkUserDeleted = false;
		canvasState._lastBulkZoomSig = null;
		canvasState._bulkSeenIds = null;
		canvasState._prefetchedTypeNodeKeys.clear();
		canvasState._renderedRecIds.clear();
		basePickerFilter = {
			text: '',
			type: 'all',
		};
		_highlightedRingKey = null;
		_highlightedSelId = null;
		_basePickerWired = false;
		renderAll();
	}

	const DESCRIBE_TTL_MS = 10 * 60 * 1000;
	// Bump when projected field metadata changes so a prior tab cannot reuse an
	// incomplete describe shape (for example, playground fields without filterable).
	const DESCRIBE_STORAGE_PREFIX = 'orgloom-describe-v8';
	const DESCRIBE_STORAGE_ORG = window.SF_ORG_ID || 'unknown';
	const DESCRIBE_STORAGE_USER = window.SF_USER_ID || 'unknown';
	// Field permissions can differ between users connected to the same org.
	function _describeStorageKey(name) {
		return DESCRIBE_STORAGE_PREFIX + '|' + DESCRIBE_STORAGE_ORG + '|' + DESCRIBE_STORAGE_USER + '|' + name;
	}
	function _loadDescribeFromStorage(name) {
		try {
			const raw = sessionStorage.getItem(_describeStorageKey(name));
			if (!raw) {
				return null;
			}
			const obj = JSON.parse(raw);
			if (
				!obj ||
				!obj.savedAt ||
				Date.now() - obj.savedAt > DESCRIBE_TTL_MS ||
				!obj.describe ||
				typeof obj.describe.deletable !== 'boolean'
			) {
				return null;
			}
			return obj.describe;
		} catch (e) {
			return null;
		}
	}
	function _saveDescribeToStorage(name, describe) {
		try {
			sessionStorage.setItem(_describeStorageKey(name), JSON.stringify({ savedAt: Date.now(), describe }));
		} catch (e) {}
	}
	function ensureDescribe(name, options) {
		if (!name || typeof name !== 'string') {
			return Promise.reject(
				new Error('This record is missing its Salesforce object type. Reload the canvas and try again.'),
			);
		}
		const force = !!(options && options.force);
		if (force && canvasState.describeRequests[name]) {
			return canvasState.describeRequests[name]
				.catch(() => null)
				.then(() => ensureDescribe(name, { force: true }));
		}
		if (force) {
			// Keep the last complete metadata available to synchronous permission checks
			// until its replacement arrives. A concurrent refresh must not look like denial.
			try {
				sessionStorage.removeItem(_describeStorageKey(name));
			} catch (e) {}
		}
		// Share in-flight requests so concurrent panels see one consistent describe response.
		if (canvasState.describeRequests[name]) {
			return canvasState.describeRequests[name];
		}
		if (!force && canvasState.describeCache[name]) {
			return Promise.resolve(canvasState.describeCache[name]);
		}
		const cached = !force && _loadDescribeFromStorage(name);
		if (cached) {
			canvasState.describeCache[name] = cached;
			return Promise.resolve(cached);
		}
		const request = csrfFetch('/api/objects/' + encodeURIComponent(name) + '/describe')
			.then((r) => {
				if (!r.ok) {
					return r
						.clone()
						.json()
						.catch(() => null)
						.then((body) => {
							const error = new Error(
								(body && body.message) || r.statusText || 'Could not load Salesforce fields.',
							);
							error.status = r.status;
							error.code = body && body.error ? body.error : null;
							throw error;
						});
				}
				return r.json();
			})
			.then((d) => {
				canvasState.describeCache[name] = d;
				_saveDescribeToStorage(name, d);
				return d;
			})
			.catch((error) => {
				// A failed refresh must not leave old permissions available as current metadata.
				delete canvasState.describeCache[name];
				throw error;
			})
			.finally(() => {
				delete canvasState.describeRequests[name];
			});
		canvasState.describeRequests[name] = request;
		return request;
	}

	function enterMigrateMode(opts) {
		opts = opts || {};
		// Migration mode only annotates the local canvas; Salesforce changes happen during upload.
		canvasState.migrateMode.active = true;
		canvasState.migrateMode.sourceSfOrgId = opts.sourceSfOrgId || null;
		canvasState.migrateMode.targetSfOrgId = opts.targetSfOrgId || window.SF_ORG_ID || null;
		canvasState.migrateMode.preparation = opts.preparation || null;
		return refreshMigrationAnnotations();
	}

	function exitMigrateMode() {
		canvasState.migrateMode.active = false;
		canvasState.migrateMode.sourceSfOrgId = null;
		canvasState.migrateMode.targetSfOrgId = null;
		canvasState.migrateMode.preparation = null;
		canvasState.migrateMode.annotationsById = {};
		canvasState.migrateMode.summary = null;
		(canvasState.bulkRecords || []).forEach((record) => {
			if (record) {
				delete record._migrateFieldResolutions;
			}
		});
		if (typeof renderBulkView === 'function') {
			renderBulkView();
		}
	}

	function _renderMigrateBar() {
		const bar = graph.querySelector('#migrate-mode-bar');
		if (!bar) {
			return;
		}
		const mm = canvasState.migrateMode;
		if (!mm.active) {
			bar.classList.add('hidden');
			bar.innerHTML = '';
			return;
		}
		const total =
			(mm.summary && mm.summary.total) ||
			(canvasState.bulkRecords || []).filter((record) => record && !record.isTypeNode).length;
		const preparation = mm.preparation || {};
		const preparationNotes = [];
		if (preparation.excludedRecordRequestCount > 0) {
			preparationNotes.push(
				preparation.excludedRecordRequestCount +
					' incomplete record request' +
					(preparation.excludedRecordRequestCount === 1 ? '' : 's') +
					' excluded',
			);
		}
		if (preparation.excludedArtifactCount > 0) {
			preparationNotes.push(
				preparation.excludedArtifactCount +
					' canvas-only item' +
					(preparation.excludedArtifactCount === 1 ? '' : 's') +
					' excluded',
			);
		}
		if (preparation.removedRequestMetadataCount > 0) {
			preparationNotes.push(
				'collaboration requests removed from ' +
					preparation.removedRequestMetadataCount +
					' record' +
					(preparation.removedRequestMetadataCount === 1 ? '' : 's'),
			);
		}
		bar.innerHTML =
			'<span class="mmb-label"><span class="mmb-dot" aria-hidden="true"></span>Migration mode</span>' +
			'<span class="mmb-sub"><strong>' +
			total +
			' record' +
			(total === 1 ? '' : 's') +
			'</strong> prepared for the destination.' +
			(preparationNotes.length ? ' ' + preparationNotes.join('; ') + '.' : '') +
			' Review the migration plan, then apply it to the canvas.</span>' +
			'<span class="mmb-actions">' +
			'<button type="button" class="mmb-btn" data-mmb-review>Review and apply</button>' +
			'<button type="button" class="mmb-btn mmb-btn--ghost" data-mmb-discard>Discard</button>' +
			'</span>';
		bar.classList.remove('hidden');
		const reviewBtn = bar.querySelector('[data-mmb-review]');
		if (reviewBtn) {
			reviewBtn.onclick = () => {
				if (window.Orgloom.migrateMatch && window.Orgloom.migrateMatch.open) {
					window.Orgloom.migrateMatch.open();
				}
			};
		}
		const discardBtn = bar.querySelector('[data-mmb-discard]');
		if (discardBtn) {
			discardBtn.onclick = () => {
				try {
					if (window.Orgloom.canvasOrgSwitch && window.Orgloom.canvasOrgSwitch.migrationClear) {
						window.Orgloom.canvasOrgSwitch.migrationClear();
					}
				} catch (_e) {}
				exitMigrateMode();
				if (typeof window.olToast === 'function') {
					window.olToast('Migration discarded. The canvas stays as-is.', 'info');
				}
			};
		}
	}

	function recomputeMigrationAnnotationsSync() {
		const engine = window.Orgloom && window.Orgloom.migrateAnnotate;
		if (!engine || !canvasState.migrateMode.active) {
			return;
		}
		const recs = canvasState.bulkRecords || [];
		const describeByObject = {};
		recs.forEach((r) => {
			if (r && !r.isTypeNode && r.objectName && canvasState.describeCache[r.objectName]) {
				describeByObject[r.objectName] = canvasState.describeCache[r.objectName];
			}
		});
		const anns = engine.annotateRecords(recs, describeByObject);
		const byId = {};
		recs.forEach((r, i) => {
			if (r && r.id != null && anns[i]) {
				byId[r.id] = anns[i];
			}
		});
		canvasState.migrateMode.annotationsById = byId;
		canvasState.migrateMode.summary = engine.summarize(anns);
	}

	function refreshMigrationAnnotations() {
		const engine = window.Orgloom && window.Orgloom.migrateAnnotate;
		if (!engine) {
			return Promise.resolve(null);
		}
		const recs = canvasState.bulkRecords || [];
		const objectNames = {};
		recs.forEach((r) => {
			if (r && !r.isTypeNode && r.objectName) {
				objectNames[r.objectName] = 1;
			}
		});
		const names = Object.keys(objectNames);
		return Promise.all(names.map((n) => ensureDescribe(n).catch(() => null))).then(() => {
			recomputeMigrationAnnotationsSync();
			if (typeof renderBulkView === 'function') {
				renderBulkView();
			}
			return canvasState.migrateMode.summary;
		});
	}

	let _smartDefaults = null;
	function loadSmartDefaults() {
		if (_smartDefaults) {
			return Promise.resolve(_smartDefaults);
		}
		_smartDefaults = {};
		return Promise.resolve(_smartDefaults);
	}
	function getSmartDefault(objectName, fieldName) {
		if (!_smartDefaults) {
			return null;
		}
		return _smartDefaults[objectName + '.' + fieldName] || null;
	}

	const rulesCache = {};
	function rulesCacheKey(name) {
		return String(window.SF_ORG_ID || 'unknown') + '|' + name;
	}
	function ensureRules(name) {
		const key = rulesCacheKey(name);
		if (rulesCache[key]) {
			return rulesCache[key];
		}
		const request = csrfFetch('/api/objects/' + encodeURIComponent(name) + '/validation-rules')
			.then((r) => {
				if (!r.ok) {
					return {
						unavailable: true,
						reason: 'Salesforce validation rules could not be loaded.',
					};
				}
				return r.json();
			})
			.then((data) => {
				if (data && data.unavailable) {
					return { rules: [], unavailable: data.reason || 'Could not load validation rules.' };
				}
				const parsed = (Array.isArray(data) ? data : []).map((r) => {
					const p = tryParseRule(r);
					return Object.assign({}, r, {
						_tree: p.tree,
						_parseError: p.error,
					});
				});
				return { rules: parsed, unavailable: null };
			})
			.catch((error) => {
				return {
					rules: [],
					unavailable: (error && error.message) || 'Could not load validation rules.',
				};
			})
			.then((result) => {
				if (result.unavailable) {
					delete rulesCache[key];
				}
				return result;
			});
		rulesCache[key] = request;
		return request;
	}

	const _assoc = window.OrgLoom.canvasAssociations.mount({
		canvasState: canvasState,
		canEditCanvasStructure: _canEditCanvasStructure,
		renderBulkView: function () {
			return renderBulkView();
		},
		showBulkToast: showBulkToast,
		ensureDescribe: function (name) {
			return ensureDescribe(name);
		},
		pushUndo: function (label, fn) {
			return pushUndo(label, fn);
		},
		showFieldPicker: function (cx, cy, options, src, tgt, onPick) {
			return showFieldPicker(cx, cy, options, src, tgt, onPick);
		},
		getSelectedDerivedEdge: function () {
			return _selectedDerivedEdge;
		},
		setSelectedDerivedEdge: function (v) {
			_selectedDerivedEdge = v;
		},
		_sfIdValue: function (v) {
			return _sfIdValue(v);
		},
		_sfIdMatch: function (a, b) {
			return _sfIdMatch(a, b);
		},
	});
	const inferRefFromGraphData = _assoc.inferRefFromGraphData;
	const inferAllReferences = _assoc.inferAllReferences;
	const createAssociation = _assoc.createAssociation;
	const finalizeAssociation = _assoc.finalizeAssociation;
	const deleteAssociation = _assoc.deleteAssociation;
	const deleteDerivedFkEdge = _assoc.deleteDerivedFkEdge;
	const inferAssociationsForRecord = _assoc.inferAssociationsForRecord;

	function seedBulkRecords() {
		if (canvasState.selectedObjects.length === 0) {
			return;
		}
		const canvas = graph.querySelector('#bulk-canvas');
		const W = Math.max(canvas.clientWidth, 500);
		const H = Math.max(canvas.clientHeight, 500);
		const baseSel = canvasState.selectedObjects[0];
		const baseWorld = baseSel && baseSel.worldPos ? baseSel.worldPos : { x: 0, y: 0 };
		const anchorX = Math.max(W / 2, 320);
		const anchorY = Math.max(H / 2, 240);
		const recBySelId = {};
		canvasState.selectedObjects.forEach((s) => {
			const sw = s.worldPos || { x: 0, y: 0 };
			const x = anchorX + (sw.x - baseWorld.x) * RECORDS_WORLD_SCALE;
			const y = anchorY + (sw.y - baseWorld.y) * RECORDS_WORLD_SCALE;
			const rec = {
				id: canvasState.bulkIdSeq++,
				objectName: s.name,
				label: s.label,
				x,
				y,
				values: canvasState.savedRecords[s.name] ? Object.assign({}, canvasState.savedRecords[s.name]) : {},
				fromSelectionId: s.id,
			};
			canvasState.bulkRecords.push(rec);
			recBySelId[s.id] = rec;
		});
		const tree = buildSelectionTree();
		canvasState.selectedObjects.forEach((s) => {
			if (recBySelId[s.id]) {
				return;
			}
			const rec = {
				id: canvasState.bulkIdSeq++,
				objectName: s.name,
				label: s.label,
				x: W / 2,
				y: H / 2,
				values: canvasState.savedRecords[s.name] ? Object.assign({}, canvasState.savedRecords[s.name]) : {},
				fromSelectionId: s.id,
			};
			canvasState.bulkRecords.push(rec);
			recBySelId[s.id] = rec;
		});

		canvasState.selectedObjects.forEach((s) => {
			if (s.addedFrom == null) {
				return;
			}
			const from = canvasState.selectedObjects.find((so) => so.id === s.addedFrom);
			if (!from) {
				return;
			}
			const sRec = recBySelId[s.id];
			const fromRec = recBySelId[from.id];
			if (!sRec || !fromRec) {
				return;
			}
			let holder = null,
				target = null,
				fieldName = null;
			if (s.addedVia && s.addedVia.fieldName) {
				if (s.addedVia.direction === 'parent') {
					holder = fromRec;
					target = sRec;
				} else if (s.addedVia.direction === 'child') {
					holder = sRec;
					target = fromRec;
				}
				fieldName = s.addedVia.fieldName;
			}
			if (!holder || !target || !fieldName) {
				const info = inferRefFromGraphData(s.name, from.name);
				if (!info) {
					return;
				}
				holder = info.direction === 'fwd' ? sRec : fromRec;
				target = info.direction === 'fwd' ? fromRec : sRec;
				fieldName = info.fieldName;
			}
			canvasState.bulkAssociations.push({
				id: canvasState.bulkIdSeq++,
				fromId: holder.id,
				toId: target.id,
				fieldName,
			});
		});
	}

	function recordOrdinal(rec) {
		if (!rec) {
			return 0;
		}
		let n = 0;
		for (let i = 0; i < canvasState.bulkRecords.length; i++) {
			const r = canvasState.bulkRecords[i];
			if (r.isTypeNode) {
				continue;
			}
			if (r.objectName !== rec.objectName) {
				continue;
			}
			n++;
			if (r.id === rec.id) {
				return n;
			}
		}
		return n;
	}

	let _recordAccessRefreshTimer = null;
	let _recordAccessRefreshRunning = false;
	function scheduleRecordAccessRefresh() {
		if (_recordAccessRefreshRunning || _recordAccessRefreshTimer) {
			return;
		}
		const candidates = canvasState.bulkRecords.filter(
			(record) =>
				record &&
				record.loadedFromId &&
				(!record._recordAccess ||
					record._recordAccess.checked !== true ||
					!record._recordAccessCheckedAt ||
					Date.now() - record._recordAccessCheckedAt > 60000) &&
				(!record._recordAccessAttemptedAt || Date.now() - record._recordAccessAttemptedAt > 10000),
		);
		if (candidates.length === 0) {
			return;
		}
		_recordAccessRefreshTimer = setTimeout(async () => {
			_recordAccessRefreshTimer = null;
			_recordAccessRefreshRunning = true;
			try {
				for (let offset = 0; offset < candidates.length; offset += 200) {
					const chunk = candidates.slice(offset, offset + 200);
					chunk.forEach((record) =>
						Object.defineProperty(record, '_recordAccessAttemptedAt', {
							value: Date.now(),
							writable: true,
							configurable: true,
						}),
					);
					const response = await csrfFetch('/api/records/access', {
						method: 'POST',
						credentials: 'same-origin',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							records: chunk.map((record) => ({ tempId: record.id, sfId: record.loadedFromId })),
						}),
					});
					const body = await response.json().catch(() => ({}));
					if (!response.ok || !Array.isArray(body.results)) {
						continue;
					}
					const byTempId = new Map(body.results.map((result) => [String(result.tempId), result.access]));
					chunk.forEach((record) => {
						const access = byTempId.get(String(record.id));
						if (access && access.checked === true) {
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
					});
				}
			} finally {
				_recordAccessRefreshRunning = false;
				renderBulkView();
			}
		}, 120);
	}

	function renderBulkView() {
		if (_ins) _ins.syncOpenRecords();
		_autosaveSchedule();
		_canvasSaveState.refresh();
		recomputeMigrationAnnotationsSync();
		_renderMigrateBar();
		const container = graph.querySelector('#graph-bulk');
		if (!canvasState.bulkInitialized) {
			canvasState.bulkInitialized = true;
			seedBulkRecords();
			const shareRole = _getCanvasShareRole();
			if (shareRole !== 'viewer' && shareRole !== 'contributor') {
				canvasState.selectedObjects.forEach((s) => {
					ensureDescribe(s.name).catch(() => {});
				});
			}
		}
		if (!canvasState._autoSpawnedPending) {
			canvasState._autoSpawnedPending = true;
		}
		renderBulkToolbar();
		scheduleRecordAccessRefresh();
		if (canvasState.bulkRecords.length > 0) {
			renderBulkCanvasCy();
		} else {
			if (_cyInstance) {
				_cyInstance.destroy();
				_cyInstance = null;
			}
			canvasState._bulkSeenIds = null;
			canvasState._lastBulkZoomSig = null;
			canvasState._renderedRecIds.clear();
			const nodesRoot = graph.querySelector('#bulk-nodes');
			const edges = graph.querySelector('#bulk-edges');
			if (nodesRoot) {
				nodesRoot.innerHTML = '';
			}
			if (edges) {
				edges.innerHTML = '';
			}
			const cyContainer = graph.querySelector('#bulk-canvas-cy');
			if (cyContainer) {
				cyContainer.innerHTML = '';
			}
			const empty = graph.querySelector('#bulk-empty');
			if (empty) {
				empty.style.display = '';
			}
		}
		const emptyPh = graph.querySelector('#bulk-empty-placeholder');
		const progressGuide = graph.querySelector('#canvas-onboarding-progress');
		const canvasHint = graph.querySelector('#bulk-canvas-hint');
		const shortcutHint = graph.querySelector('#canvas-shortcut-hint');
		const showingUploadFixes = _renderUploadFixes();
		const showingSharedTasks = showingUploadFixes || _renderSharedTaskSidebar();
		if (showingUploadFixes) {
			const sharedTasks = document.getElementById('shared-task-sidebar');
			if (sharedTasks) {
				sharedTasks.hidden = true;
			}
		}
		if (emptyPh) {
			const realCount = canvasState.bulkRecords.filter((r) => r && (!r.isTypeNode || r.isPending)).length;
			if (realCount > 0 && platform.onboarding?.completeOnFirstRecord && !_canvasGuideCompletedThisPage) {
				_completeCanvasGuide();
			}
			const _dismissed = _canvasGuideHas(_canvasGuideDismissKey, _canvasGuideDismissedThisPage);
			const _completed = _canvasGuideHas(_canvasGuideCompleteKey, _canvasGuideCompletedThisPage);
			const showPh = realCount === 0 && !_dismissed && !_completed;
			const showProgress = realCount > 0 && !_dismissed && !_completed && !showingSharedTasks;
			emptyPh.style.display = showPh ? '' : 'none';
			if (progressGuide) {
				progressGuide.hidden = !showProgress;
				const saveStep = progressGuide.querySelector('[data-cog-save-step]');
				const uploadStep = progressGuide.querySelector('[data-cog-upload-step]');
				const hasSavedCanvas = !!(canvasState.currentCanvas && canvasState.currentCanvas.id);
				if (saveStep) {
					saveStep.classList.toggle('cog-step--done', hasSavedCanvas);
					saveStep.classList.toggle('cog-step--active', !hasSavedCanvas);
					const saveNum = saveStep.querySelector('.cog-step-num');
					if (saveNum) {
						saveNum.innerHTML = hasSavedCanvas ? '&#10003;' : '2';
					}
				}
				if (uploadStep) {
					uploadStep.classList.toggle('cog-step--active', hasSavedCanvas);
				}
			}
			if (canvasHint) {
				canvasHint.style.display = showPh ? 'none' : '';
			}
			if (shortcutHint) {
				shortcutHint.style.display = showPh ? 'none' : '';
			}

			const dismissBtn = emptyPh.querySelector('[data-bec-dismiss]');
			if (dismissBtn && !dismissBtn.dataset.wired) {
				dismissBtn.dataset.wired = '1';
				dismissBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					_dismissCanvasGuide();
					emptyPh.style.display = 'none';
					if (canvasHint) {
						canvasHint.style.display = '';
					}
					if (shortcutHint) {
						shortcutHint.style.display = '';
					}
				});
			}

			const progressDismiss = progressGuide && progressGuide.querySelector('[data-cog-dismiss]');
			if (progressDismiss && !progressDismiss.dataset.wired) {
				progressDismiss.dataset.wired = '1';
				progressDismiss.addEventListener('click', (e) => {
					e.stopPropagation();
					_dismissCanvasGuide();
					progressGuide.hidden = true;
				});
			}

			emptyPh.querySelectorAll('[data-bec-action]').forEach((btn) => {
				if (btn.dataset.wired) {
					return;
				}
				btn.dataset.wired = '1';
				btn.addEventListener('click', (e) => {
					e.stopPropagation();

					if (btn.disabled) {
						return;
					}
					const action = btn.dataset.becAction;
					if (action === 'browse') {
						openBrowseModal();
					} else if (action === 'csv') {
						openLinkedCsvModal();
					} else if (action === 'soql') {
						openSoqlImportModal();
					} else if (action === 'blank') {
						spawnPendingRecord();
					} else if (action === 'request') {
						openStandaloneRecordRequestPicker(btn);
					} else if (action === 'connect') {
						if (
							window.Orgloom &&
							window.Orgloom.sfConnectionsModal &&
							typeof window.Orgloom.sfConnectionsModal.open === 'function'
						) {
							try {
								window.Orgloom.sfConnectionsModal.open();
							} catch (err) {
								window.ORGLOOM_capture &&
									window.ORGLOOM_capture(err, {
										where: 'app.js/sfConnectionsModal.open',
									});
							}
						}
					}
				});
			});
		}

		renderObjectFilterPanel();
		renderStepper();
		renderBulkCountChip();
	}

	function renderObjectFilterPanel() {
		const panel = graph.querySelector('#object-filter-panel');
		if (!panel) {
			return;
		}
		if (!Array.isArray(canvasState.bulkRecords) || canvasState.bulkRecords.length === 0) {
			_objectFilterHidden = new Set();
			panel.hidden = true;
			panel.innerHTML = '';
			return;
		}

		const counts = new Map();
		canvasState.bulkRecords.forEach((r) => {
			if (!r || !r.isTypeNode) {
				return;
			}
			if (r._chipLoader) {
				return;
			}
			const name = r.objectName;
			if (!name) {
				return;
			}
			counts.set(name, (counts.get(name) || 0) + 1);
		});
		if (counts.size === 0) {
			panel.hidden = true;
			panel.innerHTML = '';
			return;
		}
		const sorted = [...counts.keys()].sort((a, b) => a.localeCompare(b));
		const headerRow =
			'<div class="ofp-header">' +
			'<span class="ofp-title">Filter objects</span>' +
			'<button type="button" class="ofp-collapse" data-ofp-collapse aria-label="Collapse">\u2013</button>' +
			'</div>';
		const allChecked = sorted.every((n) => !_objectFilterHidden.has(n));
		const noneChecked = sorted.every((n) => _objectFilterHidden.has(n));
		const bulkRow =
			'<div class="ofp-bulk">' +
			'<button type="button" class="ofp-bulk-btn" data-ofp-all' +
			(allChecked ? ' disabled' : '') +
			'>Show all</button>' +
			'<button type="button" class="ofp-bulk-btn" data-ofp-none' +
			(noneChecked ? ' disabled' : '') +
			'>Hide all</button>' +
			'</div>';
		const items = sorted
			.map((name) => {
				const checked = !_objectFilterHidden.has(name);
				const labelObj = canvasState.selectedObjects.find((s) => s.name === name);
				const labelText = (labelObj && labelObj.label) || name;
				return (
					'<label class="ofp-row" title="' +
					escapeHtml(name) +
					'">' +
					'<input type="checkbox" data-ofp-name="' +
					escapeHtml(name) +
					'"' +
					(checked ? ' checked' : '') +
					' />' +
					'<span class="ofp-row-label">' +
					escapeHtml(labelText) +
					'</span>' +
					'<span class="ofp-row-count">' +
					counts.get(name) +
					'</span>' +
					'</label>'
				);
			})
			.join('');
		panel.hidden = false;
		panel.innerHTML = headerRow + bulkRow + '<div class="ofp-list">' + items + '</div>';

		panel.querySelectorAll('input[type="checkbox"][data-ofp-name]').forEach((cb) => {
			cb.addEventListener('change', () => {
				const name = cb.dataset.ofpName;
				if (!name) {
					return;
				}
				if (cb.checked) {
					_objectFilterHidden.delete(name);
				} else {
					_objectFilterHidden.add(name);
				}
				rerenderForObjectFilter();
			});
		});
		const allBtn = panel.querySelector('[data-ofp-all]');
		if (allBtn) {
			allBtn.addEventListener('click', () => {
				_objectFilterHidden = new Set();
				rerenderForObjectFilter();
			});
		}
		const noneBtn = panel.querySelector('[data-ofp-none]');
		if (noneBtn) {
			noneBtn.addEventListener('click', () => {
				_objectFilterHidden = new Set(sorted);
				rerenderForObjectFilter();
			});
		}
		const collapseBtn = panel.querySelector('[data-ofp-collapse]');
		if (collapseBtn) {
			collapseBtn.addEventListener('click', () => {
				panel.classList.toggle('collapsed');
			});
		}
	}

	function rerenderForObjectFilter() {
		renderBulkCanvasCy();
		renderObjectFilterPanel();
	}

	function isBulkPristine() {
		if (canvasState._bulkUserDeleted) {
			return false;
		}
		if (!Array.isArray(canvasState.bulkRecords) || canvasState.bulkRecords.length === 0) {
			return true;
		}
		return canvasState.bulkRecords.every(
			(r) => r.isTypeNode || (!r.loadedFromId && (!r.values || Object.keys(r.values).length === 0)),
		);
	}

	function _missingSelectionEntries() {
		if (canvasState.selectedObjects.length === 0) {
			return [];
		}
		const counts = {};
		canvasState.selectedObjects.forEach((s) => {
			counts[s.name] = (counts[s.name] || 0) + 1;
		});
		const recsByName = {};
		const recsBySelId = new Set();
		canvasState.bulkRecords.forEach((r) => {
			recsByName[r.objectName] = (recsByName[r.objectName] || 0) + 1;
			if (r.fromSelectionId != null) {
				recsBySelId.add(r.fromSelectionId);
			}
		});
		return canvasState.selectedObjects.filter((s) => {
			if (_userDeletedSelectionIds.has(s.id)) {
				return false;
			}
			if (counts[s.name] > 1) {
				return !recsBySelId.has(s.id);
			}
			return !recsByName[s.name];
		});
	}

	function hasUnmirroredSchemaTypes() {
		return _missingSelectionEntries().length > 0;
	}

	const ADD_MISSING_FANOUT_CAP = 3;

	function addMissingSchemaTypes(opts) {
		opts = opts || {};
		const missing = _missingSelectionEntries();
		if (missing.length === 0) {
			return;
		}
		const worstCaseAdd = missing.length * (1 + ADD_MISSING_FANOUT_CAP);
		if (_canvasCapBlockReason(worstCaseAdd)) {
			return;
		}

		const canvas = graph.querySelector('#bulk-canvas');
		const W = Math.max(canvas.clientWidth, 500);
		const baseSel = canvasState.selectedObjects[0];
		const baseRec = baseSel ? canvasState.bulkRecords.find((r) => r.fromSelectionId === baseSel.id) : null;
		const baseRecX = baseRec ? baseRec.x : W / 2;
		const baseRecY = baseRec ? baseRec.y : 200;
		const baseWorldX = baseSel && baseSel.worldPos ? baseSel.worldPos.x : 0;
		const baseWorldY = baseSel && baseSel.worldPos ? baseSel.worldPos.y : 0;
		const maxY = canvasState.bulkRecords.reduce((m, r) => Math.max(m, r.y || 0), 200);
		const fallbackY = maxY + 200;
		const colStep = 200;
		const totalW = (missing.length - 1) * colStep;
		const fallbackStartX = Math.max(120, W / 2 - totalW / 2);

		const createdRecordIds = [];
		const createdAssociationIds = [];
		let fanoutCount = 0;

		missing.forEach((s, missingIdx) => {
			let parentSel = null;
			let parentRecs = [];
			if (s.addedFrom != null) {
				parentSel = canvasState.selectedObjects.find((so) => so.id === s.addedFrom);
				if (parentSel) {
					parentRecs = canvasState.bulkRecords.filter((r) => r.fromSelectionId === parentSel.id);
					if (parentRecs.length === 0) {
						parentRecs = canvasState.bulkRecords.filter((r) => r.objectName === parentSel.name);
					}
					parentRecs = parentRecs.slice(0, ADD_MISSING_FANOUT_CAP);
				}
			}
			const childCount = Math.max(1, parentRecs.length);
			if (parentRecs.length > 1) {
				fanoutCount += parentRecs.length - 1;
			}

			const sw = s.worldPos;
			let mirrorX, mirrorY;
			if (sw) {
				mirrorX = baseRecX + (sw.x - baseWorldX) * RECORDS_WORLD_SCALE;
				mirrorY = baseRecY + (sw.y - baseWorldY) * RECORDS_WORLD_SCALE;
			}

			for (let k = 0; k < childCount; k++) {
				const parentRec = parentRecs[k] || null;
				let childX, childY;
				if (parentRecs.length > 1 && parentRec) {
					childX = parentRec.x + 60 * (k > 0 ? 1 : 0);
					childY = parentRec.y + 200;
				} else if (sw) {
					childX = mirrorX;
					childY = mirrorY;
				} else if (parentRec) {
					childX = parentRec.x;
					childY = parentRec.y + 200;
				} else {
					childX = fallbackStartX + missingIdx * colStep;
					childY = fallbackY;
				}
				const childRec = {
					id: canvasState.bulkIdSeq++,
					objectName: s.name,
					label: s.label,
					x: childX,
					y: childY,
					values: {},
					fromSelectionId: s.id,
				};
				canvasState.bulkRecords.push(childRec);
				createdRecordIds.push(childRec.id);

				if (parentRec && parentSel) {
					let holder = null,
						target = null,
						fieldName = null;
					if (s.addedVia && s.addedVia.fieldName) {
						if (s.addedVia.direction === 'parent') {
							holder = parentRec;
							target = childRec;
						} else if (s.addedVia.direction === 'child') {
							holder = childRec;
							target = parentRec;
						}
						fieldName = s.addedVia.fieldName;
					}
					if (!holder || !target || !fieldName) {
						const info = inferRefFromGraphData(s.name, parentSel.name);
						if (info) {
							holder = info.direction === 'fwd' ? childRec : parentRec;
							target = info.direction === 'fwd' ? parentRec : childRec;
							fieldName = info.fieldName;
						}
					}
					if (holder && target && fieldName) {
						const assoc = {
							id: canvasState.bulkIdSeq++,
							fromId: holder.id,
							toId: target.id,
							fieldName,
						};
						canvasState.bulkAssociations.push(assoc);
						createdAssociationIds.push(assoc.id);
					}
				}
			}
		});

		if (createdRecordIds.length > 0) {
			const recIds = new Set(createdRecordIds);
			const assocIds = new Set(createdAssociationIds);
			pushUndo('Undo schema add', () => {
				canvasState.bulkRecords = canvasState.bulkRecords.filter((r) => !recIds.has(r.id));
				canvasState.bulkAssociations = canvasState.bulkAssociations.filter((a) => !assocIds.has(a.id));
				renderBulkView();
			});
		}

		renderBulkView();

		const totalCreated = createdRecordIds.length;
		const verb = totalCreated === 1 ? 'record' : 'records';
		if (fanoutCount > 0) {
			const prefix = opts.silent ? 'Auto-added' : 'Added';
			showBulkToast(prefix + ' ' + totalCreated + ' ' + verb + ' (one per existing parent). Ctrl+Z to undo.');
		} else if (!opts.silent) {
			showBulkToast('Added ' + totalCreated + ' ' + verb + ' from your schema.');
		}
	}

	function _secureDraftUuid(cryptoApi) {
		if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
			return cryptoApi.randomUUID();
		}
		if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
			throw new Error('Secure browser randomness is required to create a draft canvas.');
		}
		const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
		bytes[6] = (bytes[6] & 0x0f) | 0x40;
		bytes[8] = (bytes[8] & 0x3f) | 0x80;
		const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
		return (
			hex.slice(0, 8) +
			'-' +
			hex.slice(8, 12) +
			'-' +
			hex.slice(12, 16) +
			'-' +
			hex.slice(16, 20) +
			'-' +
			hex.slice(20)
		);
	}

	function _ensureDraftCanvasId() {
		if (canvasState._draftCanvasId) {
			return canvasState._draftCanvasId;
		}
		const cryptoApi = typeof crypto !== 'undefined' ? crypto : null;
		const uuid = _secureDraftUuid(cryptoApi);
		canvasState._draftCanvasId = 'draft-' + uuid;
		return canvasState._draftCanvasId;
	}
	function _clearDraftCanvasId() {
		canvasState._draftCanvasId = null;
	}
	window.Orgloom.canvasState = {
		getCurrentCanvas: () => {
			if (canvasState.currentCanvas && canvasState.currentCanvas.id) {
				return {
					canvasId: canvasState.currentCanvas.id,
					meta: {
						title: canvasState.currentCanvas.title || null,
						ownerSfUserId: window.SF_USER_ID || null,
					},
				};
			}

			return {
				canvasId: _ensureDraftCanvasId(),
				meta: { title: null, ownerSfUserId: window.SF_USER_ID || null },
			};
		},
		snapshot: ({ canvasId } = {}) => {
			const myId = (canvasState.currentCanvas && canvasState.currentCanvas.id) || canvasState._draftCanvasId;
			if (!myId) {
				return null;
			}
			if (canvasId && canvasId !== myId) {
				return null;
			}
			const payload = buildCanvasPayload();
			if (payload && Array.isArray(payload.loadedRecords)) {
				const valuesByLoadedFromId = new Map();
				for (const r of canvasState.bulkRecords) {
					if (r && r.loadedFromId && r.values && !r.isTypeNode && !r.isPending) {
						valuesByLoadedFromId.set(String(r.loadedFromId), r.values);
					}
				}
				payload.loadedRecords = payload.loadedRecords.map((lr) => {
					const values = lr && lr.loadedFromId ? valuesByLoadedFromId.get(String(lr.loadedFromId)) : null;
					if (!values) {
						return lr;
					}
					return Object.assign({}, lr, {
						values: Object.assign({}, values),
					});
				});
			}
			if (payload && Array.isArray(payload.schema && payload.schema.objects)) {
				payload.schema = Object.assign({}, payload.schema, {
					objects: payload.schema.objects.map((o) => {
						const d = canvasState.describeCache[o.name];
						if (!d || !Array.isArray(d.fields)) {
							return o;
						}
						const referenceFields = d.fields
							.filter(
								(f) =>
									f &&
									f.type === 'reference' &&
									Array.isArray(f.referenceTo) &&
									f.referenceTo.length > 0,
							)
							.map((f) => ({
								name: f.name,
								label: f.label || f.name,
								relationshipName: f.relationshipName || null,
								referenceTo: f.referenceTo.slice(),
							}));
						const requiredFields = d.fields
							.filter((f) => f && f.required && !f.defaultedOnCreate && !f.calculated && !f.autoNumber)
							.map((f) => f.name);
						return Object.assign({}, o, {
							referenceFields,
							requiredFields,
						});
					}),
				});
			}
			return {
				id: myId,
				title: (canvasState.currentCanvas && canvasState.currentCanvas.title) || null,
				ownerSfUserId: window.SF_USER_ID || null,
				versionId: (canvasState.currentCanvas && canvasState.currentCanvas.versionId) || null,
				isDraft: !canvasState.currentCanvas || !canvasState.currentCanvas.id,
				payload,
			};
		},
		clearDraft: _clearDraftCanvasId,
		describeObject: ({ objectName, fields } = {}) => {
			if (!objectName) {
				return { cacheMiss: true };
			}
			const d = canvasState.describeCache[objectName];
			if (!d) {
				return { cacheMiss: true };
			}
			if (!Array.isArray(fields) || fields.length === 0) {
				return d;
			}
			const requested = new Set(fields.map((f) => String(f)));
			const requestedLower = new Set(Array.from(requested).map((f) => f.toLowerCase()));
			const slicedFields = (Array.isArray(d.fields) ? d.fields : []).filter((f) => {
				if (!f || typeof f.name !== 'string') {
					return false;
				}
				return requested.has(f.name) || requestedLower.has(f.name.toLowerCase());
			});
			return Object.assign({}, d, {
				fields: slicedFields,
				_slicedTo: fields,
			});
		},
	};

	window.Orgloom.canvasMigrate = {
		isActive: () => !!canvasState.migrateMode.active,
		usesGuidedResolution: () => true,
		annotationFor: (recId) => canvasState.migrateMode.annotationsById[recId] || null,
		summary: () => canvasState.migrateMode.summary,
		recompute: () => recomputeMigrationAnnotationsSync(),
		refresh: () => refreshMigrationAnnotations(),
		exit: () => exitMigrateMode(),
	};

	async function applyMigrationPlanToCanvas() {
		const engine = window.Orgloom && window.Orgloom.migrateAnnotate;
		if (!engine || typeof engine.applyMigrationPlan !== 'function') {
			throw new Error('The migration planner is unavailable. Reload the page and try again.');
		}
		await refreshMigrationAnnotations();
		const matched = (canvasState.bulkRecords || []).filter(
			(record) => record && !record.isTypeNode && !record._migrateExcluded && record._migrateMatchedId,
		);
		const baselines = {};
		const CHUNK = 200;
		for (let i = 0; i < matched.length; i += CHUNK) {
			const chunk = matched.slice(i, i + CHUNK);
			const response = await csrfFetch('/api/records/refresh', {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					records: chunk.map((record) => ({
						objectName: record.objectName,
						sfId: record._migrateMatchedId,
					})),
				}),
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || data.error || 'Could not load the selected destination records.');
			}
			const data = await response.json().catch(() => ({}));
			const results = data && Array.isArray(data.results) ? data.results : [];
			for (const result of results) {
				if (!result || !result.ok) {
					const reason = result && result.error ? ' (' + result.error + ')' : '';
					throw new Error('Could not load one of the selected destination records' + reason + '.');
				}
				baselines[result.objectName + '::' + result.sfId] = result.values || {};
			}
		}

		const result = engine.applyMigrationPlan(
			canvasState.bulkRecords,
			canvasState.bulkAssociations,
			canvasState.migrateMode.annotationsById,
			baselines,
			canvasState.describeCache,
		);
		_migrationClear();
		exitMigrateMode();
		_autosaveFlush();
		_canvasSaveState.markDirty();
		_announceCanvasChange();
		showBulkToast(
			'Migration applied to the canvas: ' +
				result.updates +
				' to update, ' +
				result.creates +
				' to create' +
				(result.deletes ? ', ' + result.deletes + ' to delete' : '') +
				(result.excluded ? ', ' + result.excluded + ' excluded' : '') +
				'. Review the records, then upload when ready.',
			'success',
		);
		return result;
	}

	if (window.OrgLoom && window.OrgLoom.migrateMatch && window.OrgLoom.migrateMatch.mount) {
		const _mm = window.OrgLoom.migrateMatch.mount({
			canvasState: canvasState,
			csrfFetch: csrfFetch,
			escapeHtml: escapeHtml,
			showBulkToast: showBulkToast,
			ensureDescribe: ensureDescribe,
			renderBulkView: renderBulkView,
			recordOrdinal: recordOrdinal,
			onCommitPlan: applyMigrationPlanToCanvas,
			onApplied: () => {
				_migrationSyncIfActive();
				return refreshMigrationAnnotations();
			},
		});
		window.Orgloom.migrateMatch = { open: _mm.open };
	}

	function _announceCanvasChange() {
		try {
			const state = window.Orgloom.canvasState.getCurrentCanvas();
			if (state && state.canvasId) {
				window.dispatchEvent(new CustomEvent('orgloom:canvas-loaded', { detail: state }));
			} else {
				window.dispatchEvent(new CustomEvent('orgloom:canvas-unloaded', { detail: {} }));
			}
		} catch (e) {}
	}
	window.Orgloom.canvasState._announceChange = _announceCanvasChange;

	function _nextRecordPosition(objectName, preferredPosition) {
		if (preferredPosition && Number.isFinite(preferredPosition.x) && Number.isFinite(preferredPosition.y)) {
			return { x: preferredPosition.x, y: preferredPosition.y };
		}
		const canvas = graph.querySelector('#bulk-canvas');
		const STEP_X = 260;
		const STEP_Y = 170;
		const PER_ROW = 5;
		const siblings = canvasState.bulkRecords.filter((r) => r.objectName === objectName);
		let x;
		let y;
		if (siblings.length === 0) {
			const cw = (canvas && canvas.clientWidth) || 0;
			const ch = (canvas && canvas.clientHeight) || 0;
			x = cw > 0 ? cw / 2 : 600;
			y = ch > 0 ? ch / 2 : 400;
		} else {
			const anchor = siblings[0];
			const idx = siblings.length; // 0-indexed slot for the new clone
			const col = idx % PER_ROW;
			const r = Math.floor(idx / PER_ROW);
			x = anchor.x + col * STEP_X;
			y = anchor.y + r * STEP_Y;
		}
		return { x, y };
	}

	function cloneRecord(objectName) {
		const s = canvasState.selectedObjects.find((so) => so.name === objectName);
		if (!s) {
			return;
		}
		const position = _nextRecordPosition(objectName);
		const _newId = canvasState.bulkIdSeq++;
		canvasState.bulkRecords.push({
			id: _newId,
			objectName: s.name,
			label: s.label,
			x: position.x,
			y: position.y,
			values: {},
			fromSelectionId: s.id,
		});
		renderBulkView();
		pushUndo('Add record', () => {
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

	function _importFileSummary(parsed, isSavedCanvas) {
		const meta = parsed._meta || {};
		let recordCount = 0;
		let schemaObjectCount = 0;
		let kind = 'canvas';
		if (isSavedCanvas) {
			recordCount =
				(Array.isArray(parsed.loadedRecords) ? parsed.loadedRecords.length : 0) +
				(Array.isArray(parsed.drafts) ? parsed.drafts.length : 0);
		} else if (meta.schemaOnly) {
			kind = 'schema';
			schemaObjectCount = ((parsed.schema && parsed.schema.objects) || []).length;
		} else {
			recordCount = Array.isArray(parsed.records) ? parsed.records.length : 0;
		}
		const fileOrg = meta.exportedFrom || meta.savedFrom || null;
		return {
			kind,
			recordCount,
			associationCount: Array.isArray(parsed.associations) ? parsed.associations.length : 0,
			schemaObjectCount,
			crossOrg: !!(fileOrg && window.SF_ORG_ID && fileOrg !== window.SF_ORG_ID),
		};
	}

	const _importShared = window.OrgLoom.importShared;
	const _JSON_IMPORT_GATE = {
		extRe: /\.json$/i,
		extLabel: '.orgloom.json',
		maxBytes: 10 * 1024 * 1024,
		flowLabel: 'Import saved canvas',
	};
	function _captureImportFailure(reason) {
		_importShared.captureImportFailure('json', reason);
	}
	function _gateCanvasImportFile(file) {
		return _importShared.gateImportFile(file, _JSON_IMPORT_GATE);
	}
	const _captureCanvasUndoSnapshot = _importShared.makeUndoCapture({
		onCanvasReplace: () => {
			_clearUploadFixes();
			closeRecordEditors();
		},
		canvasState: canvasState,
		renderAll: function () {
			renderAll();
		},
		showBulkToast: function (m, v) {
			showBulkToast(m, v);
		},
	});

	function _processImportedCanvasFile(file, opts, lifecycle) {
		if (!file) {
			return;
		}
		lifecycle = lifecycle || {};
		const reader = new FileReader();
		reader.onload = async () => {
			try {
				const parsed = JSON.parse(String(reader.result || ''));
				const isSavedCanvas = parsed && (Array.isArray(parsed.loadedRecords) || Array.isArray(parsed.drafts));
				if (isSavedCanvas) {
					validateCanvasPayload(parsed);
				} else {
					validateTemplate(parsed);
				}
				if (typeof lifecycle.onReady === 'function') {
					lifecycle.onReady();
				}
				const applyImport = async (_mode) => {
					const _undoImport = _captureCanvasUndoSnapshot();
					const _opts = Object.assign(
						{
							importFileName: file.name,
							merge: _mode === 'merge',
							undo: _undoImport,
						},
						opts || {},
					);
					if (!isSavedCanvas && parsed._meta && parsed._meta.schemaOnly && _opts.schemaOnly == null) {
						_opts.schemaOnly = true;
					}
					if (isSavedCanvas) {
						await applyCanvasPayload(parsed, _opts);
					} else {
						await applyTemplate(parsed, _opts);
					}
				};
				const currentSummary = _importShared.summarizeCanvasContent(canvasState);
				if (currentSummary.hasContent) {
					await showReplaceOrMergeDialog({
						currentSummary,
						importSummary: Object.assign(
							{ fileName: file.name },
							_importFileSummary(parsed, isSavedCanvas),
						),
						onChoose: applyImport,
					});
					return;
				}
				await applyImport('replace');
			} catch (e) {
				if (typeof lifecycle.onError === 'function') {
					lifecycle.onError();
				}
				_captureImportFailure('invalid');
				showBulkToast('Could not load file: ' + (e && e.message ? e.message : String(e)), 'error');
			}
		};
		reader.onerror = () => {
			if (typeof lifecycle.onError === 'function') {
				lifecycle.onError();
			}
			_captureImportFailure('unreadable');
			showBulkToast('Could not read file "' + file.name + '" - the file may be locked or unavailable.', 'error');
		};
		reader.readAsText(file);
	}

	function triggerTemplateFileInput(opts) {
		opts = opts || {};
		const overlay = document.createElement('div');
		overlay.className = 'modal import-canvas-modal';
		overlay.innerHTML =
			'<div class="modal-overlay" data-ici-close></div>' +
			'<div class="modal-body" style="max-width:460px">' +
			'<div class="modal-header">' +
			'<h3>Import saved canvas</h3>' +
			'<button type="button" class="modal-close" data-ici-close aria-label="Close">×</button>' +
			'</div>' +
			'<div class="modal-content">' +
			'<div class="lcsv-dropzone" id="ici-dropzone" tabindex="0">' +
			'<strong>Drop a saved-canvas JSON file here</strong>' +
			'<span class="tag">or click to select</span>' +
			'</div>' +
			'</div>' +
			'</div>';
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.json,application/json';
		input.style.display = 'none';
		overlay.appendChild(input);
		document.body.appendChild(overlay);

		const dz = overlay.querySelector('#ici-dropzone');
		let readingFile = false;
		function close() {
			if (readingFile) {
				return;
			}
			try {
				overlay.remove();
			} catch (_e) {}
			document.removeEventListener('keydown', onKey);
		}
		function onKey(e) {
			if (e.key === 'Escape') {
				close();
			}
		}
		function handleFile(file) {
			if (!file || readingFile) {
				return;
			}
			const gateError = _gateCanvasImportFile(file);
			if (gateError) {
				showBulkToast(gateError, 'error');
				_captureImportFailure(/\.json$/i.test(String(file.name || '')) ? 'size' : 'type');
				input.value = '';
				return;
			}
			readingFile = true;
			dz.classList.add('is-loading');
			dz.setAttribute('aria-busy', 'true');
			dz.innerHTML =
				'<span class="busy-spinner" aria-hidden="true"></span>' +
				'<strong>Reading saved canvas…</strong>' +
				'<span class="tag">Checking the file before import.</span>';
			_processImportedCanvasFile(file, opts, {
				onReady: function () {
					readingFile = false;
					close();
				},
				onError: function () {
					readingFile = false;
					dz.classList.remove('is-loading');
					dz.removeAttribute('aria-busy');
					dz.innerHTML =
						'<strong>Drop a saved-canvas JSON file here</strong>' +
						'<span class="tag">or click to select</span>';
					input.value = '';
				},
			});
		}
		dz.addEventListener('click', () => input.click());
		dz.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				input.click();
			}
		});
		input.addEventListener('change', () => handleFile(input.files && input.files[0]));
		dz.addEventListener('dragover', (e) => {
			e.preventDefault();
			dz.classList.add('drag');
		});
		dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
		dz.addEventListener('drop', (e) => {
			e.preventDefault();
			dz.classList.remove('drag');
			const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
			handleFile(f);
		});
		overlay.querySelectorAll('[data-ici-close]').forEach((el) => el.addEventListener('click', close));
		document.addEventListener('keydown', onKey);
		setTimeout(() => {
			try {
				dz.focus();
			} catch (_e) {}
		}, 0);
	}

	(function _mountCanvasFileDrop() {
		const host = document.getElementById('graph-bulk');
		if (!host) {
			return;
		}
		const _isFileDrag = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
		host.addEventListener('dragover', (e) => {
			if (_isFileDrag(e)) {
				e.preventDefault();
			}
		});
		host.addEventListener('drop', (e) => {
			if (!_isFileDrag(e)) {
				return;
			}
			e.preventDefault();
			const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
			if (!f) {
				return;
			}
			const gateError = _gateCanvasImportFile(f);
			if (gateError) {
				showBulkToast(gateError, 'error');
				_captureImportFailure(/\.json$/i.test(String(f.name || '')) ? 'size' : 'type');
				return;
			}
			_processImportedCanvasFile(f, {});
		});
	})();

	var _vc = (window.OrgLoom && window.OrgLoom.valueCompare) || null;
	if (!_vc) {
		throw new Error('value-compare.js must load before app.js');
	}
	var valuesEquivalent = _vc.valuesEquivalent;
	var valuesDiffer = _vc.valuesDiffer;
	var changedFieldNames = _vc.changedFieldNames;
	var _isRecordValueModified = _vc.isRecordModified;
	var relationshipChangesRecord = _vc.relationshipChangesRecord;
	var _encryptedFields = window.OrgLoom && window.OrgLoom.encryptedFields;
	if (!_encryptedFields) {
		throw new Error('encrypted-fields.js must load before app.js');
	}
	function isRecordModified(rec) {
		return (
			_isRecordValueModified(rec) ||
			_encryptedFields.hasPending(rec, canvasState) ||
			relationshipChangesRecord(rec, canvasState.bulkAssociations, canvasState.bulkRecords)
		);
	}
	var isRecordPendingDelete = _vc.isRecordPendingDelete;
	var isRecordPendingCreate = _vc.isRecordPendingCreate;
	var hasPendingChange = _vc.hasPendingChange;
	var computeRecordDiff = _vc.computeRecordDiff;

	function _hasUnsavedCanvasWork() {
		return _canvasSaveState.hasUnsavedChanges();
	}
	function _hasPendingEncryptedUploadValues() {
		return !!(
			_ins &&
			typeof _ins.hasPendingEncryptedUploadValues === 'function' &&
			_ins.hasPendingEncryptedUploadValues()
		);
	}
	function _confirmEncryptedValueLoss(title) {
		return showConfirmDialog({
			title: title || 'Leave with encrypted changes?',
			message:
				'Encrypted replacements and clear choices exist only in this tab. Leaving now will discard them, even if the canvas has been saved.',
			confirmLabel: 'Leave and discard',
			cancelLabel: 'Stay',
			danger: true,
		});
	}

	let _confirmSaveBeforeNavigation = null;
	let _migrationOAuthHandoffAllowed = false;
	function _hasPendingMigrationOAuthHandoff() {
		try {
			const orgSwitch = window.Orgloom && window.Orgloom.canvasOrgSwitch;
			if (!orgSwitch || typeof orgSwitch.hasPendingMigration !== 'function' || !orgSwitch.hasPendingMigration()) {
				return false;
			}
		} catch (_e) {
			return false;
		}
		return true;
	}
	function _allowMigrationOAuthHandoff() {
		if (!_hasPendingMigrationOAuthHandoff()) {
			return false;
		}
		_migrationOAuthHandoffAllowed = true;
		window.setTimeout(() => {
			_migrationOAuthHandoffAllowed = false;
		}, 5000);
		return true;
	}
	function _salesforceSwitchNeedsConfirmation() {
		return (
			!_hasPendingMigrationOAuthHandoff() &&
			window.ORGLOOM_SF_CONNECTED !== false &&
			_hasUnsavedCanvasWork() &&
			typeof _confirmSaveBeforeNavigation === 'function'
		);
	}
	function _prepareSalesforceReauth() {
		const hadUnsavedChanges = _hasUnsavedCanvasWork();
		const hasPendingEncryptedValues = _hasPendingEncryptedUploadValues();
		_autosaveFlush();
		_orgSwitchStash({
			intent: 'reauth',
			preserveState: true,
			hadUnsavedChanges: hadUnsavedChanges,
		});
		// Keep the native leave-page warning active when tab-local encrypted choices
		// cannot survive the OAuth round trip.
		window.__sfRedirectingToReauth = !hasPendingEncryptedValues;
		return true;
	}
	async function _prepareSalesforceSwitch() {
		if (_allowMigrationOAuthHandoff()) {
			window.__sfRedirectingToReauth = true;
			return true;
		}

		if (_hasPendingEncryptedUploadValues()) {
			const discardEncrypted = await _confirmEncryptedValueLoss('Switch Salesforce user?');
			if (!discardEncrypted) {
				return false;
			}
		}

		const hadUnsavedChanges = _hasUnsavedCanvasWork();
		const connectionUnavailable = window.ORGLOOM_SF_CONNECTED === false;
		if (hadUnsavedChanges && !connectionUnavailable && typeof _confirmSaveBeforeNavigation === 'function') {
			const shouldContinue = await _confirmSaveBeforeNavigation(null, {
				title: 'Switch Salesforce user?',
				saveMessage: 'You have unsaved canvas changes. Save them before signing in as another Salesforce user.',
			});
			if (!shouldContinue) {
				return false;
			}
		}

		// If Salesforce is disconnected, preserve the local canvas snapshot and resume
		// the switch after OAuth instead of offering a save that cannot complete.
		const preserveState = connectionUnavailable || !hadUnsavedChanges || !_hasUnsavedCanvasWork();
		if (preserveState) {
			_autosaveFlush();
		}
		_orgSwitchStash({
			intent: 'switch',
			preserveState: preserveState,
			hadUnsavedChanges: hadUnsavedChanges,
		});
		window.__sfRedirectingToReauth = true;
		return true;
	}
	window.Orgloom = window.Orgloom || {};
	window.Orgloom.canvasNavigation = Object.assign({}, window.Orgloom.canvasNavigation || {}, {
		allowMigrationOAuthHandoff: _allowMigrationOAuthHandoff,
		prepareSalesforceReauth: _prepareSalesforceReauth,
		prepareSalesforceSwitch: _prepareSalesforceSwitch,
		salesforceSwitchNeedsConfirmation: _salesforceSwitchNeedsConfirmation,
	});

	window.addEventListener('beforeunload', (ev) => {
		if (
			(window.OrgLoom && window.OrgLoom.sessionEnded) ||
			(window.OrgLoom && window.OrgLoom.workspaceMembershipTransition) ||
			_migrationOAuthHandoffAllowed ||
			window.__sfRedirectingToReauth
		) {
			_migrationOAuthHandoffAllowed = false;
			return;
		}
		const hasPendingEncryptedValues = _hasPendingEncryptedUploadValues();
		if (!_hasUnsavedCanvasWork() && !hasPendingEncryptedValues) {
			return;
		}
		ev.preventDefault();
		ev.returnValue = ''; // legacy browser support
	});

	document.addEventListener(
		'click',
		(ev) => {
			const link = ev.target && ev.target.closest && ev.target.closest('a[href^="/workspace"]');
			if (!link) {
				return;
			}
			if (ev.defaultPrevented) {
				return;
			}
			if (ev.button !== 0) {
				return;
			}
			if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) {
				return;
			}
			if (link.target && link.target !== '' && link.target !== '_self') {
				return;
			}
			const hasPendingEncryptedValues = _hasPendingEncryptedUploadValues();
			if (!_hasUnsavedCanvasWork() && !hasPendingEncryptedValues) {
				return;
			}
			ev.preventDefault();
			const href = link.getAttribute('href') || '/workspace';
			if (hasPendingEncryptedValues) {
				_confirmEncryptedValueLoss('Leave this canvas?').then((ok) => {
					if (ok) {
						window.location.href = href;
					}
				});
				return;
			}
			const modCount = _modifiedLoadedCount();
			const message =
				modCount > 0
					? modCount +
						' loaded record' +
						(modCount === 1 ? '' : 's') +
						' on this canvas ' +
						(modCount === 1 ? 'has' : 'have') +
						' been edited locally. Edits to loaded records aren’t saved with the canvas - leaving without uploading will discard them.'
					: 'This canvas has records that aren’t saved to Salesforce yet. Leaving will discard them - use “Save as new canvas” first to keep your work.';
			_confirmSaveBeforeNavigation(null, {
				title: 'Leave this canvas?',
				saveMessage:
					'Your latest canvas changes have not been saved to Salesforce. Save them before opening Workspace settings.',
			}).then((ok) => {
				if (ok) {
					window.location.href = href;
				}
			});
		},
		true,
	);

	document.addEventListener(
		'submit',
		(ev) => {
			const form = ev.target;
			if (
				!form ||
				!form.action ||
				!form.action.endsWith('/auth/logout') ||
				form.dataset.canvasSaveConfirmed === 'true' ||
				(!_hasUnsavedCanvasWork() && !_hasPendingEncryptedUploadValues())
			) {
				return;
			}
			ev.preventDefault();
			if (_hasPendingEncryptedUploadValues()) {
				_confirmEncryptedValueLoss('Sign out?').then((ok) => {
					if (!ok) {
						return;
					}
					form.dataset.canvasSaveConfirmed = 'true';
					if (typeof form.requestSubmit === 'function') {
						form.requestSubmit();
					} else {
						form.submit();
					}
				});
				return;
			}
			_confirmSaveBeforeNavigation(null, {
				title: 'Sign out?',
				saveMessage:
					'Your latest canvas changes have not been saved to Salesforce. Save them before signing out.',
			}).then((ok) => {
				if (!ok) {
					return;
				}
				form.dataset.canvasSaveConfirmed = 'true';
				if (typeof form.requestSubmit === 'function') {
					form.requestSubmit();
				} else {
					form.submit();
				}
			});
		},
		true,
	);

	async function loadRelatedForRecord(rec) {
		if (!rec.loadedFromId) {
			showBulkToast('Load an existing record first.');
			return;
		}
		const thisObj = canvasState.selectedObjects.find((s) => s.name === rec.objectName);
		if (!thisObj || !thisObj.data) {
			showBulkToast('No schema data available for ' + rec.objectName + '.', 'error');
			return;
		}
		const selectedNames = new Set(canvasState.selectedObjects.map((s) => s.name));
		const labelForName = (n) => {
			const hit = canvasState.selectedObjects.find((s) => s.name === n);
			return hit ? hit.label : n;
		};
		const tasks = [];
		(thisObj.data.children || []).forEach((c) => {
			if (!c.field || !selectedNames.has(c.object)) {
				return;
			}
			tasks.push({
				direction: 'child',
				otherType: c.object,
				fieldOnOther: c.field,
			});
		});
		(thisObj.data.parents || []).forEach((p) => {
			if (!p.field || !selectedNames.has(p.object)) {
				return;
			}
			const parentId = rec.values && rec.values[p.field];
			if (!parentId || typeof parentId !== 'string') {
				return;
			}
			tasks.push({
				direction: 'parent',
				otherType: p.object,
				fieldOnThis: p.field,
				parentId,
			});
		});
		if (tasks.length === 0) {
			showBulkToast('No related types in the schema to load from.');
			return;
		}
		showBulkToast('Loading related records\u2026');

		const recToValues = (r) => {
			const v = {};
			Object.keys(r).forEach((k) => {
				if (k === 'attributes' || r[k] == null) {
					return;
				}
				v[k] = r[k];
			});
			return v;
		};
		const findOrNull = (objectName, loadedId) =>
			canvasState.bulkRecords.find((br) => br.objectName === objectName && br.loadedFromId === loadedId);
		const ensureAssociation = (fromId, toId, fieldName) => {
			const dup = canvasState.bulkAssociations.some(
				(a) => a.fromId === fromId && a.toId === toId && a.fieldName === fieldName,
			);
			if (!dup) {
				canvasState.bulkAssociations.push({
					id: canvasState.bulkIdSeq++,
					fromId,
					toId,
					fieldName,
				});
			}
		};

		const hydrateSnapshots = [];
		const hydrate = (placeholder, r, v) => {
			hydrateSnapshots.push({
				id: placeholder.id,
				prevValues: Object.assign({}, placeholder.values || {}),
				prevLoadedFromId: placeholder.loadedFromId || null,
				prevLoadedValues: placeholder.loadedValues ? Object.assign({}, placeholder.loadedValues) : null,
			});
			placeholder.loadedFromId = r.Id;
			placeholder.loadedValues = Object.assign({}, v);
			placeholder.values = Object.assign({}, placeholder.values || {}, v);
			return placeholder;
		};

		const fieldLabelLookup = (objectName) => (apiName) => {
			const d = canvasState.describeCache[objectName];
			if (!d || !Array.isArray(d.fields)) {
				return apiName;
			}
			const f = d.fields.find((x) => x.name === apiName);
			return (f && f.label) || apiName;
		};

		let created = 0;
		let reused = 0;
		let hydrated = 0;
		let skipped = 0;
		let offset = 0;
		for (const t of tasks) {
			try {
				let records;
				if (t.direction === 'child') {
					const url =
						'/api/objects/' +
						encodeURIComponent(t.otherType) +
						'/by-ref?field=' +
						encodeURIComponent(t.fieldOnOther) +
						'&id=' +
						encodeURIComponent(rec.loadedFromId);
					const resp = await csrfFetch(url);
					if (!resp.ok) {
						throw new Error((await resp.json().catch(() => ({}))).error || resp.statusText);
					}
					const body = await resp.json();
					records = body.records || [];
				} else {
					const url =
						'/api/objects/' +
						encodeURIComponent(t.otherType) +
						'/records/' +
						encodeURIComponent(t.parentId);
					const resp = await csrfFetch(url);
					if (!resp.ok) {
						throw new Error(resp.statusText);
					}
					const single = await resp.json();
					records = single ? [single] : [];
				}
				let parentPlaceholderId = null;
				if (t.direction === 'parent') {
					const existingAssoc = canvasState.bulkAssociations.find(
						(a) => a.fromId === rec.id && a.fieldName === t.fieldOnThis,
					);
					if (existingAssoc) {
						const existingTarget = canvasState.bulkRecords.find((br) => br.id === existingAssoc.toId);
						if (existingTarget && existingTarget.objectName === t.otherType) {
							parentPlaceholderId = existingTarget.id;
						}
					}
				}
				const childPlaceholderQueue = [];
				if (t.direction === 'child') {
					canvasState.bulkAssociations.forEach((a) => {
						if (a.toId !== rec.id || a.fieldName !== t.fieldOnOther) {
							return;
						}
						const candidate = canvasState.bulkRecords.find((br) => br.id === a.fromId);
						if (!candidate) {
							return;
						}
						if (candidate.objectName !== t.otherType) {
							return;
						}
						if (candidate.loadedFromId) {
							return;
						}
						childPlaceholderQueue.push(candidate);
					});
				}
				for (const r of records) {
					const v = recToValues(r);
					let targetRec;
					let didCreateOrLink = true;
					const existingByLoadedId = findOrNull(t.otherType, r.Id);
					if (existingByLoadedId) {
						targetRec = existingByLoadedId;
						reused++;
					} else {
						let placeholder = null;
						if (t.direction === 'parent' && parentPlaceholderId != null) {
							placeholder = canvasState.bulkRecords.find((br) => br.id === parentPlaceholderId);
							parentPlaceholderId = null; // consume regardless of decision
						} else if (t.direction === 'child' && childPlaceholderQueue.length > 0) {
							placeholder = childPlaceholderQueue.shift();
						}
						if (placeholder) {
							const filledKeys = Object.keys(placeholder.values || {}).filter((k) => {
								const val = placeholder.values[k];
								return val !== '' && val != null;
							});
							let decision = 'replace';
							if (filledKeys.length > 0) {
								try {
									await ensureDescribe(t.otherType);
								} catch (eDescribe) {}
								decision = await confirmHydrateChoice({
									placeholderLabel:
										(placeholder.label || placeholder.objectName) +
										' #' +
										recordOrdinal(placeholder),
									currentValues: placeholder.values || {},
									incoming: v,
									fieldLabelLookup: fieldLabelLookup(t.otherType),
								});
							}
							if (decision === 'replace') {
								targetRec = hydrate(placeholder, r, v);
								hydrated++;
							} else {
								skipped++;
								didCreateOrLink = false;
							}
						} else {
							targetRec = {
								id: canvasState.bulkIdSeq++,
								objectName: t.otherType,
								label: labelForName(t.otherType),
								x: rec.x + 260 * Math.cos(offset * (Math.PI / 6)),
								y: rec.y + 260 * Math.sin(offset * (Math.PI / 6)),
								values: v,
								loadedFromId: r.Id,
								loadedValues: Object.assign({}, v),
							};
							canvasState.bulkRecords.push(targetRec);
							created++;
							offset++;
						}
					}
					if (!didCreateOrLink) {
						continue;
					}
					const fromId = t.direction === 'child' ? targetRec.id : rec.id;
					const toId = t.direction === 'child' ? rec.id : targetRec.id;
					const fieldName = t.direction === 'child' ? t.fieldOnOther : t.fieldOnThis;
					ensureAssociation(fromId, toId, fieldName);
				}
			} catch (e) {
				showBulkToast('Load related failed for ' + t.otherType + ': ' + (e.message || e), 'error');
			}
		}
		renderBulkView();
		const parts = [];
		if (created > 0) {
			parts.push('added ' + created);
		}
		if (hydrated > 0) {
			parts.push('hydrated ' + hydrated + ' placeholder' + (hydrated === 1 ? '' : 's'));
		}
		if (reused > 0) {
			parts.push('linked ' + reused + ' already loaded');
		}
		if (skipped > 0) {
			parts.push('skipped ' + skipped);
		}
		const msg = parts.length > 0 ? 'Loaded related: ' + parts.join(', ') + '.' : 'No related records found.';
		if (hydrateSnapshots.length > 0) {
			showBulkToastWithAction(msg, 'Undo hydrate', () => {
				hydrateSnapshots.forEach((snap) => {
					const target = canvasState.bulkRecords.find((b) => b.id === snap.id);
					if (!target) {
						return;
					}
					target.values = snap.prevValues;
					if (snap.prevLoadedFromId == null) {
						delete target.loadedFromId;
					} else {
						target.loadedFromId = snap.prevLoadedFromId;
					}
					if (snap.prevLoadedValues == null) {
						delete target.loadedValues;
					} else {
						target.loadedValues = snap.prevLoadedValues;
					}
				});
				renderBulkView();
				showBulkToast(
					'Reverted ' +
						hydrateSnapshots.length +
						' hydrate' +
						(hydrateSnapshots.length === 1 ? '' : 's') +
						'.',
				);
			});
		} else {
			showBulkToast(msg);
		}
	}

	const _marquee = window.OrgLoom.canvasMarquee.mount({
		canvasState: canvasState,
		getGraph: function () {
			return graph;
		},
		clientToCanvasCoords: function (cx, cy) {
			return clientToCanvasCoords(cx, cy);
		},
		renderBulkView: function () {
			return renderBulkView();
		},
		_canvasCapBlockReason: _canvasCapBlockReason,
		showBulkToast: showBulkToast,
		pushUndo: pushUndo,
		showPromptModal: function (opts) {
			return showPromptModal(opts);
		},
		ensureDescribe: ensureDescribe,
	});
	const startMarquee = _marquee.startMarquee;
	const updateMarqueeElement = _marquee.updateMarqueeElement;
	const clearMarqueeElement = _marquee.clearMarqueeElement;
	const finalizeMarqueeSelection = _marquee.finalizeMarqueeSelection;
	const copySelectionToClipboard = _marquee.copySelectionToClipboard;
	const pasteFromClipboard = _marquee.pasteFromClipboard;
	const openPasteCountPrompt = _marquee.openPasteCountPrompt;

	const undoStack = [];
	let undoGeneration = 0;
	let undoInProgress = false;
	function clearUndoHistory() {
		undoStack.length = 0;
		undoGeneration++;
	}
	function pushUndo(label, fn) {
		const generation = undoGeneration;
		let spent = false;
		const once = () => {
			if (spent || generation !== undoGeneration) return false;
			spent = true;
			try {
				const result = fn(() => generation === undoGeneration);
				if (result && typeof result.then === 'function') {
					return result.catch((error) => {
						spent = false;
						throw error;
					});
				}
				return result;
			} catch (error) {
				spent = false;
				throw error;
			}
		};
		undoStack.push({ label, fn: once });
		if (undoStack.length > 20) {
			undoStack.shift();
		}
		return once;
	}
	function trimUndoStack(n) {
		for (let i = 0; i < n && undoStack.length > 0; i++) {
			undoStack.pop();
		}
	}
	function undoStackSize() {
		return undoStack.length;
	}

	function deleteRecord(id) {
		if (!_canEditCanvasStructure()) {
			showBulkToast('Only the canvas owner or an editor can remove records.', 'info');
			return false;
		}
		const rec = canvasState.bulkRecords.find((r) => r.id === id);
		const killedAssocs = canvasState.bulkAssociations.filter((a) => a.fromId === id || a.toId === id);
		const wasSelected = canvasState.bulkSelectedIds.has(id);
		const sidWasMarked = rec && rec.fromSelectionId != null && !_userDeletedSelectionIds.has(rec.fromSelectionId);
		if (rec && rec.fromSelectionId != null) {
			_userDeletedSelectionIds.add(rec.fromSelectionId);
		}
		if (rec) {
			pushUndo('Restore deleted record', () => {
				if (
					canvasState.bulkRecords.some(
						(r) =>
							r.id === rec.id ||
							(rec.loadedFromId &&
								r.objectName === rec.objectName &&
								r.loadedFromId &&
								String(r.loadedFromId).slice(0, 15) === String(rec.loadedFromId).slice(0, 15)),
					)
				) {
					showBulkToast('This record is already on the canvas.', 'info');
					return;
				}
				canvasState.bulkRecords.push(rec);
				killedAssocs.forEach((a) => {
					const holder = canvasState.bulkRecords.find((r) => r.id === a.fromId);
					const target = canvasState.bulkRecords.find((r) => r.id === a.toId);
					const value = holder?.values?.[a.fieldName];
					if (
						holder &&
						target &&
						(!target.loadedFromId ||
							value == null ||
							value === '' ||
							String(value).slice(0, 15) === String(target.loadedFromId).slice(0, 15)) &&
						!canvasState.bulkAssociations.some(
							(link) => link.fromId === a.fromId && link.fieldName === a.fieldName,
						)
					) {
						canvasState.bulkAssociations.push(a);
					}
				});
				if (wasSelected) {
					canvasState.bulkSelectedIds.add(id);
				}

				if (sidWasMarked && rec.fromSelectionId != null) {
					_userDeletedSelectionIds.delete(rec.fromSelectionId);
				}
				renderBulkView();
				showBulkToast('Restored ' + (rec.label || rec.objectName) + '.');
			});
		}
		canvasState.bulkRecords = canvasState.bulkRecords.filter((r) => r.id !== id);

		canvasState.bulkRecords = canvasState.bulkRecords.filter((r) => !(r.isTypeNode && r.hostRecordId === id));
		canvasState.bulkAssociations = canvasState.bulkAssociations.filter((a) => a.fromId !== id && a.toId !== id);
		canvasState.bulkSelectedIds.delete(id);
		canvasState._bulkUserDeleted = true;
		renderBulkView();
		return true;
	}

	function markPendingDelete(id, opts) {
		if (!_canEditCanvasStructure()) {
			showBulkToast('Only the canvas owner or an editor can mark records for deletion.', 'info');
			return false;
		}
		const rec = canvasState.bulkRecords.find((r) => r.id === id);
		if (!rec) {
			return false;
		}
		if (!rec.loadedFromId) {
			console.warn(
				'markPendingDelete: refusing - record',
				id,
				'is a draft (use deleteRecord to remove drafts from canvas)',
			);
			return false;
		}
		if (rec.isTypeNode) {
			console.warn('markPendingDelete: refusing - record', id, 'is a type-node placeholder');
			return false;
		}
		if (rec._inaccessible) {
			console.warn('markPendingDelete: refusing - record', id, 'is a no-access placeholder');
			return false;
		}
		if (rec._recordAccess && rec._recordAccess.checked === true && rec._recordAccess.hasDeleteAccess === false) {
			showBulkToast('Your Salesforce user cannot delete this record.', 'error');
			return false;
		}
		const describe = rec.objectName && canvasState.describeCache[rec.objectName];
		if (!describe || describe.deletable !== true) {
			showBulkToast(
				'Your Salesforce user does not have permission to delete ' +
					(rec.label || rec.objectName || 'this object') +
					' records.',
				'error',
			);
			return false;
		}
		if (rec.pendingDelete) {
			return true;
		}
		const prevValues = rec.values;
		const discardingEdits = isRecordModified(rec) && opts && opts.discardEdits;
		if (isRecordModified(rec) && !(opts && (opts.discardEdits || opts.allowModified))) {
			console.warn(
				'markPendingDelete: refusing - record',
				id,
				'has unsaved edits; explicitly preserve or discard them when marking for delete',
			);
			return false;
		}
		rec.pendingDelete = true;
		if (discardingEdits) {
			rec.values = Object.assign({}, rec.loadedValues || {});
		}
		pushUndo('Restore from delete', () => {
			const r = canvasState.bulkRecords.find((x) => x.id === id);
			if (!r) {
				return;
			}
			r.pendingDelete = false;
			if (discardingEdits) {
				r.values = prevValues;
			}
			renderBulkView();
			showBulkToast('Unmarked: ' + (r.label || r.objectName) + ' will not be deleted.');
		});
		renderBulkView();
		showBulkToast('Marked for delete: ' + (rec.label || rec.objectName) + '. Will delete on next upload.');
		return true;
	}

	function unmarkPendingDelete(id) {
		if (!_canEditCanvasStructure()) {
			showBulkToast('Only the canvas owner or an editor can change deletion status.', 'info');
			return false;
		}
		const rec = canvasState.bulkRecords.find((r) => r.id === id);
		if (!rec || !rec.pendingDelete) {
			return false;
		}
		rec.pendingDelete = false;
		renderBulkView();
		return true;
	}

	async function refreshRecordFromSf(rec) {
		if (!rec || !rec.loadedFromId || !rec.objectName || rec.isPending || rec.pendingDelete) {
			return;
		}
		if (isRecordModified(rec)) {
			const ok = await showConfirmDialog({
				title: 'Discard unsaved edits?',
				message:
					'This record has unsaved local edits. Refreshing will replace them with the current Salesforce values. To compare side-by-side, cancel and use Diff records from the Tools menu instead.',
				confirmLabel: 'Refresh anyway',
				cancelLabel: 'Cancel',
				danger: true,
			});
			if (!ok) {
				return;
			}
		}
		let resp;
		try {
			resp = await csrfFetch('/api/records/refresh', {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					records: [{ objectName: rec.objectName, sfId: rec.loadedFromId }],
				}),
			});
		} catch (err) {
			showBulkToast("Couldn't reach the server: " + (err.message || err), 'error');
			return;
		}
		if (!resp.ok) {
			const data = await resp.json().catch(() => ({}));
			showBulkToast(data.message || data.error || 'Refresh failed (HTTP ' + resp.status + ')', 'error');
			return;
		}
		const data = await resp.json().catch(() => ({}));
		const result = (data && Array.isArray(data.results) && data.results[0]) || null;
		if (!result) {
			showBulkToast('Refresh returned no result.', 'error');
			return;
		}
		if (!result.ok) {
			if (result.error === 'not-found' || result.error === 'no-access') {
				_markRecordUnavailable(rec);
				showBulkToast(
					'This record is unavailable. It may have been deleted, or your Salesforce access may have changed.',
					'warn',
				);
			} else {
				showBulkToast('Refresh failed: ' + result.error, 'error');
			}
			renderBulkView();
			return;
		}
		rec.values = Object.assign({}, result.values);
		rec.loadedValues = Object.assign({}, result.values);
		rec._deletedInSf = false;
		rec._inaccessible = false;
		rec._lastRefreshedAt = Date.now();
		rec._refreshPulse = true;
		renderBulkView();
		showBulkToast('Refreshed ' + (rec.objectName || 'record') + '.');
		setTimeout(() => {
			if (rec._refreshPulse) {
				rec._refreshPulse = false;
			}
		}, 1600);
	}

	async function refreshLoadedCanvasRecords(candidates, options) {
		const opts = options || {};
		const records = Array.isArray(candidates) ? candidates : [];
		if (records.length === 0) {
			return { okCount: 0, failCount: 0 };
		}
		const CHUNK = 200;
		let okCount = 0;
		let failCount = 0;
		const byIdRec = new Map(records.map((r) => [r.objectName + '::' + r.loadedFromId, r]));
		const progressToast =
			opts.showProgress === false ? null : showBulkToast('Refreshing 0 / ' + records.length + '…', 'info');
		const updateProgress = (n) => {
			if (progressToast && typeof progressToast.update === 'function') {
				progressToast.update('Refreshing ' + n + ' / ' + records.length + '…');
			}
		};
		for (let i = 0; i < records.length; i += CHUNK) {
			const chunk = records.slice(i, i + CHUNK);
			const resp = await csrfFetch('/api/records/refresh', {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					records: chunk.map((r) => ({ objectName: r.objectName, sfId: r.loadedFromId })),
				}),
			});
			if (!resp.ok) {
				const data = await resp.json().catch(() => ({}));
				throw new Error(data.message || data.error || 'Refresh failed (HTTP ' + resp.status + ')');
			}
			const data = await resp.json().catch(() => ({}));
			const results = data && Array.isArray(data.results) ? data.results : [];
			for (const result of results) {
				const rec = byIdRec.get(result.objectName + '::' + result.sfId);
				if (!rec) {
					continue;
				}
				if (result.ok) {
					rec.values = Object.assign({}, result.values);
					rec.loadedValues = Object.assign({}, result.values);
					rec._deletedInSf = false;
					rec._inaccessible = false;
					rec._lastRefreshedAt = Date.now();
					rec._refreshPulse = true;
					okCount++;
					setTimeout(() => {
						if (rec._refreshPulse) {
							rec._refreshPulse = false;
						}
					}, 1600);
				} else {
					if (result.error === 'not-found' || result.error === 'no-access') {
						_markRecordUnavailable(rec);
					}
					failCount++;
				}
			}
			renderBulkView();
			updateProgress(Math.min(i + chunk.length, records.length));
		}
		return { okCount, failCount };
	}

	async function refreshCanvasAfterRecall() {
		const loaded = canvasState.bulkRecords.filter(
			(r) => r && !r.isTypeNode && !r.isPending && !r.pendingDelete && r.loadedFromId,
		);
		const dirty = loaded.filter((r) => isRecordModified(r));
		const clean = loaded.filter((r) => !isRecordModified(r));
		if (clean.length === 0) {
			if (dirty.length > 0) {
				showBulkToast(
					'Recall completed. ' +
						dirty.length +
						' canvas record' +
						(dirty.length === 1 ? ' was' : 's were') +
						' left unchanged because ' +
						(dirty.length === 1 ? 'it has' : 'they have') +
						' unsaved edits.',
					'warn',
				);
			}
			return { okCount: 0, failCount: 0, skippedDirtyCount: dirty.length };
		}
		const result = await refreshLoadedCanvasRecords(clean);
		let message =
			'Recall completed. Refreshed ' +
			result.okCount +
			' canvas record' +
			(result.okCount === 1 ? '' : 's') +
			'.';
		if (result.failCount > 0) {
			message += ' ' + result.failCount + ' could not be refreshed.';
		}
		if (dirty.length > 0) {
			message +=
				' ' +
				dirty.length +
				' with unsaved edits ' +
				(dirty.length === 1 ? 'was' : 'were') +
				' left unchanged.';
		}
		showBulkToast(message, result.failCount > 0 || dirty.length > 0 ? 'warn' : 'info');
		return Object.assign({}, result, { skippedDirtyCount: dirty.length });
	}

	function bulkDeleteCandidates() {
		const selected = canvasState.bulkSelectedIds;
		return canvasState.bulkRecords.filter(
			(record) =>
				record &&
				(!selected?.size || selected.has(record.id)) &&
				record.loadedFromId &&
				!record.isTypeNode &&
				!record.isPending &&
				!record._inaccessible &&
				!record.pendingDelete &&
				canvasState.describeCache[record.objectName]?.deletable === true &&
				!(record._recordAccess?.checked === true && record._recordAccess.hasDeleteAccess === false),
		);
	}

	async function openBulkDeleteFlow() {
		if (!_canEditCanvasStructure()) {
			return;
		}
		const records = bulkDeleteCandidates();
		if (!records.length) {
			showBulkToast('No eligible Salesforce records to mark for deletion.', 'info');
			return;
		}
		const canvas = canvasState.currentCanvas;
		const collection = canvasState.bulkRecords;
		const orgId = window.SF_ORG_ID;
		const identities = new Map(records.map((record) => [record, record.loadedFromId]));
		const approved = await showConfirmDialog({
			title: 'Mark ' + records.length + ' record' + (records.length === 1 ? '' : 's') + ' for deletion?',
			message:
				'These records will be deleted from Salesforce on your next upload. Local edits are kept, and you can undo the marks before uploading.',
			confirmLabel: 'Mark for deletion',
			cancelLabel: 'Cancel',
			danger: true,
		});
		if (!approved || !_canEditCanvasStructure()) {
			return;
		}
		if (
			canvasState.currentCanvas !== canvas ||
			canvasState.bulkRecords !== collection ||
			window.SF_ORG_ID !== orgId
		) {
			showBulkToast('The canvas changed. Choose the records again.', 'info');
			return;
		}
		const eligible = new Set(bulkDeleteCandidates());
		const marked = records.filter(
			(record) => eligible.has(record) && record.loadedFromId === identities.get(record),
		);
		if (!marked.length) {
			return;
		}
		marked.forEach((record) => {
			record.pendingDelete = true;
		});
		pushUndo('Unmark records for deletion', () => {
			marked.forEach((record) => {
				if (canvasState.bulkRecords.includes(record) && record.loadedFromId === identities.get(record)) {
					record.pendingDelete = false;
				}
			});
			renderBulkView();
		});
		renderBulkView();
		showBulkToast(
			'Marked ' + marked.length + ' record' + (marked.length === 1 ? '' : 's') + ' for deletion on next upload.',
		);
	}

	async function openBulkRefreshFlow() {
		const selectedIds = canvasState.bulkSelectedIds;
		const allCandidates = canvasState.bulkRecords.filter(
			(r) => r && !r.isTypeNode && !r.isPending && !r.pendingDelete && r.loadedFromId,
		);
		const haveSelection = selectedIds && selectedIds.size > 0;
		const candidates = haveSelection ? allCandidates.filter((r) => selectedIds.has(r.id)) : allCandidates;
		if (candidates.length === 0) {
			showBulkToast(
				haveSelection
					? 'None of the selected records are loaded from Salesforce.'
					: 'No loaded records on the canvas to refresh.',
				'warn',
			);
			return;
		}
		const dirty = candidates.filter((r) => isRecordModified(r));
		if (dirty.length > 0) {
			const ok = await showConfirmDialog({
				title: 'Discard unsaved edits?',
				message:
					dirty.length +
					' of these records have unsaved local edits. Refreshing will replace those edits with current Salesforce values. To pick which fields to keep, cancel and use Diff records from the Tools menu instead.',
				confirmLabel: 'Refresh anyway',
				cancelLabel: 'Cancel',
				danger: true,
			});
			if (!ok) {
				return;
			}
		}
		try {
			const result = await refreshLoadedCanvasRecords(candidates);
			const objectNames = Array.from(new Set(candidates.map((record) => record.objectName).filter(Boolean)));
			await Promise.all(
				objectNames.map((objectName) => ensureDescribe(objectName, { force: true }).catch(() => null)),
			);
			const msg =
				result.failCount === 0
					? 'Refreshed ' + result.okCount + ' record' + (result.okCount === 1 ? '' : 's') + '.'
					: 'Refreshed ' + result.okCount + '. ' + result.failCount + ' no longer accessible in Salesforce.';
			showBulkToast(msg, result.failCount === 0 ? 'info' : 'warn');
		} catch (err) {
			showBulkToast('Refresh failed: ' + (err.message || err), 'error');
		}
	}

	document.addEventListener('keydown', async (e) => {
		if (!(e.key === 'z' || e.key === 'Z')) {
			return;
		}
		if (!(e.ctrlKey || e.metaKey)) {
			return;
		}
		if (e.shiftKey) {
			return;
		}
		const tag = (e.target && e.target.tagName) || '';
		if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) {
			return;
		}
		if (canvasState.graphView !== 'bulk') {
			return;
		}
		if (undoStack.length === 0) {
			return;
		}
		e.preventDefault();
		if (undoInProgress) return;
		undoInProgress = true;
		const generation = undoGeneration;
		try {
			while (undoStack.length > 0 && generation === undoGeneration) {
				const op = undoStack.pop();
				let ran = true;
				try {
					ran = (await op.fn()) !== false;
				} catch (err) {
					if (generation === undoGeneration && !err.undoDiscard) undoStack.push(op);
					showBulkToast('Undo failed: ' + (err.message || err), 'error');
					ran = true;
				}
				if (ran) {
					break;
				}
			}
		} finally {
			undoInProgress = false;
		}
	});

	function onRecordClick(rec, opts) {
		opts = opts || {};
		if (opts.additive) {
			if (canvasState.bulkSelectedIds.has(rec.id)) {
				canvasState.bulkSelectedIds.delete(rec.id);
			} else {
				canvasState.bulkSelectedIds.add(rec.id);
			}
		} else {
			canvasState.bulkSelectedIds = new Set([rec.id]);
		}
		canvasState.bulkSelectedEdgeId = null;
		canvasState._schemaViewObject = null;
		canvasState._schemaViewPath = [];
		canvasState._schemaViewPathEdges = [];

		if (!rec.isTypeNode) {
			let selIdx = -1;
			if (rec.fromSelectionId != null) {
				selIdx = canvasState.selectedObjects.findIndex((s) => s.id === rec.fromSelectionId);
			}
			if (selIdx === -1) {
				selIdx = canvasState.selectedObjects.findIndex((s) => s.name === rec.objectName);
			}
			if (selIdx !== -1) {
				canvasState.activeIndex = selIdx;
			}
		}
		renderBulkView();
		renderCanvas();
	}

	function applyBulkZoom() {
		const content = graph.querySelector('#bulk-content');
		if (!content) {
			return;
		}
		content.style.zoom = canvasState.bulkZoom;
		const hud = graph.querySelector('#bulk-zoom-hud');
		if (hud) {
			if (canvasState.bulkZoom !== 1) {
				hud.textContent = 'Zoom ' + Math.round(canvasState.bulkZoom * 100) + '%  \u00b7  ctrl+scroll to adjust';
				hud.style.display = '';
			} else {
				hud.style.display = 'none';
			}
		}
	}

	let _bulkScrollTweenId = null;
	function _smoothScrollCanvas(canvas, targetLeft, targetTop, duration) {
		if (!canvas) {
			return;
		}
		if (_bulkScrollTweenId != null) {
			cancelAnimationFrame(_bulkScrollTweenId);
			_bulkScrollTweenId = null;
		}
		const startLeft = canvas.scrollLeft;
		const startTop = canvas.scrollTop;
		const dx = targetLeft - startLeft;
		const dy = targetTop - startTop;
		if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
			canvas.scrollLeft = targetLeft;
			canvas.scrollTop = targetTop;
			return;
		}
		const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (reduceMotion) {
			canvas.scrollLeft = targetLeft;
			canvas.scrollTop = targetTop;
			return;
		}
		const dur = Math.max(120, Math.min(900, duration || 520));
		const start = performance.now();
		const ease = (t) => 1 - Math.pow(1 - t, 3);
		const step = (now) => {
			const t = Math.min(1, (now - start) / dur);
			const k = ease(t);
			canvas.scrollLeft = startLeft + dx * k;
			canvas.scrollTop = startTop + dy * k;
			if (t < 1) {
				_bulkScrollTweenId = requestAnimationFrame(step);
			} else {
				_bulkScrollTweenId = null;
			}
		};
		_bulkScrollTweenId = requestAnimationFrame(step);
	}

	let bulkLastClickTime = 0;
	let bulkLastClickRecId = null;
	const BULK_DBLCLICK_MS = 350;

	function clientToCanvasCoords(clientX, clientY) {
		const canvas = graph.querySelector('#bulk-canvas');
		const rect = canvas.getBoundingClientRect();
		return {
			x: (clientX - rect.left + canvas.scrollLeft) / canvasState.bulkZoom,
			y: (clientY - rect.top + canvas.scrollTop) / canvasState.bulkZoom,
		};
	}

	function findRecordAtClient(clientX, clientY) {
		const nodesRoot = graph.querySelector('#bulk-nodes');
		for (const rec of canvasState.bulkRecords) {
			const el = nodesRoot.querySelector('[data-rec-id="' + rec.id + '"]');
			if (!el) {
				continue;
			}
			const r = el.getBoundingClientRect();
			if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
				return rec;
			}
		}
		return null;
	}

	document.addEventListener('mousemove', (e) => {
		if (!canvasState.bulkMarquee) {
			return;
		}
		const pt = clientToCanvasCoords(e.clientX, e.clientY);
		canvasState.bulkMarquee.currentX = pt.x;
		canvasState.bulkMarquee.currentY = pt.y;
		if (
			Math.abs(pt.x - canvasState.bulkMarquee.startX) > 3 ||
			Math.abs(pt.y - canvasState.bulkMarquee.startY) > 3
		) {
			canvasState.bulkMarquee.moved = true;
		}
		updateMarqueeElement();
	});
	document.addEventListener('mouseup', () => {
		if (!canvasState.bulkMarquee) {
			return;
		}
		if (canvasState.bulkMarquee.moved) {
			finalizeMarqueeSelection();
		} else {
			if (canvasState.bulkSelectedIds.size > 0 || canvasState.bulkSelectedEdgeId != null) {
				canvasState.bulkSelectedIds = new Set();
				canvasState.bulkSelectedEdgeId = null;
				renderBulkView();
			}
		}
		clearMarqueeElement();
		canvasState.bulkMarquee = null;
	});

	const _cm = window.OrgLoom.canvasCardMenu.mount({
		promptCanvasSave: function (opts) {
			return promptCanvasSave(opts);
		},
		ensureDescribe: ensureDescribe,
		canvasState: canvasState,
		csrfFetch: csrfFetch,
		escapeHtml: escapeHtml,
		renderBulkView: function () {
			return renderBulkView();
		},
		recordOrdinal: function (r) {
			return recordOrdinal(r);
		},
		showBulkToast: showBulkToast,
		showConfirmDialog: showConfirmDialog,
		canEditCanvasStructure: _canEditCanvasStructure,
		_canAuthorSlots: function () {
			return _canAuthorSlots();
		},
		canDeleteRecord: function (record) {
			if (
				record &&
				record.loadedFromId &&
				record._recordAccess &&
				record._recordAccess.checked === true &&
				record._recordAccess.hasDeleteAccess === false
			) {
				return false;
			}
			const describe = record && record.objectName && canvasState.describeCache[record.objectName];
			return !!(describe && describe.deletable === true);
		},
		_hasCap: function (name) {
			return _hasCap(name);
		},
		openInsertModal: function () {
			return openRecordForCurrentUser.apply(null, arguments);
		},
		convertRecordToFieldSlot: function () {
			return convertRecordToFieldSlot.apply(null, arguments);
		},
		configureExistingSlot: function () {
			return configureExistingSlot.apply(null, arguments);
		},
		convertSlotBackToRecord: function () {
			return convertSlotBackToRecord.apply(null, arguments);
		},
		unlinkRecord: function (record) {
			return _ins.unlinkRecord(record);
		},
		refreshRecordFromSf: function () {
			return refreshRecordFromSf.apply(null, arguments);
		},
		deleteRecord: function () {
			return deleteRecord.apply(null, arguments);
		},
		markPendingDelete: function () {
			return markPendingDelete.apply(null, arguments);
		},
		unmarkPendingDelete: function () {
			return unmarkPendingDelete.apply(null, arguments);
		},
		attachSfUserPicker: function () {
			return attachSfUserPicker.apply(null, arguments);
		},
		_fillSlotWithSfRecord: function () {
			return _fillSlotWithSfRecord.apply(null, arguments);
		},
	});
	const showFieldPicker = _cm.showFieldPicker;
	const showCardMoreMenu = _cm.showCardMoreMenu;
	const showSlotConfigurationPicker = _cm.showSlotConfigurationPicker;
	const _openSlotRecordPicker = _cm._openSlotRecordPicker;

	function renderChips() {
		const bar = graph.querySelector('#graph-chips');
		if (!bar) {
			return;
		}
		if (canvasState.selectedObjects.length === 0) {
			bar.innerHTML = '';
			return;
		}

		const nameCounts = {};
		canvasState.selectedObjects.forEach((s) => {
			nameCounts[s.name] = (nameCounts[s.name] || 0) + 1;
		});
		const nameSeen = {};
		bar.innerHTML = canvasState.selectedObjects
			.map((s, i) => {
				nameSeen[s.name] = (nameSeen[s.name] || 0) + 1;
				const suffix = nameCounts[s.name] > 1 ? ' #' + nameSeen[s.name] : '';
				const hasDraft =
					canvasState.savedRecords[s.name] && Object.keys(canvasState.savedRecords[s.name]).length > 0;
				return (
					'<div class="chip' +
					(i === canvasState.activeIndex ? ' active' : '') +
					(hasDraft ? ' has-draft' : '') +
					'" data-chip="' +
					i +
					'"' +
					(hasDraft ? ' title="Has saved draft"' : '') +
					'>' +
					(hasDraft ? '<span class="chip-check">\u2713</span>' : '') +
					escapeHtml(s.label + suffix) +
					'<button class="chip-remove" data-chip-remove="' +
					i +
					'" title="Remove">&times;</button>' +
					'</div>'
				);
			})
			.join('');
		bar.querySelectorAll('[data-chip]').forEach((el) => {
			el.addEventListener('click', (e) => {
				if (e.target.closest('[data-chip-remove]')) {
					return;
				}
				const i = parseInt(el.dataset.chip, 10);
				if (i >= 0 && i < canvasState.selectedObjects.length) {
					canvasState.activeIndex = i;
					renderAll();
				}
			});
		});
		bar.querySelectorAll('[data-chip-remove]').forEach((btn) => {
			btn.addEventListener('click', (e) => {
				e.stopPropagation();
				removeFromSelection(parseInt(btn.dataset.chipRemove, 10));
			});
		});
	}

	let _basePickerWired = false;
	function renderBasePicker() {
		const picker = graph.querySelector('#base-picker');
		const nodesRoot = graph.querySelector('#graph-nodes');
		const edges = graph.querySelector('#graph-edges');
		const subbar = graph.querySelector('#graph-subbar');
		if (subbar) {
			subbar.classList.add('hidden');
		}
		nodesRoot.innerHTML = '';
		edges.innerHTML = '';
		picker.classList.remove('hidden');

		if (canvasState.allObjects === null) {
			picker.innerHTML = '<p class="tag center" style="margin-top:3em">Loading objects\u2026</p>';
			_basePickerWired = false;
			return;
		}

		if (!_basePickerWired) {
			picker.innerHTML =
				'<div class="base-picker-head">' +
				'<div class="base-picker-eyebrow">Get started</div>' +
				'<h1 class="base-picker-title">What\u2019s the main thing you\u2019re doing?</h1>' +
				'<p class="base-picker-sub" id="base-picker-sub">Pick the object that represents the records you want to create or edit. You can add related objects in the next step.</p>' +
				'</div>' +
				'<div class="base-picker-search">' +
				'<input id="base-picker-q" type="search" placeholder="Filter by label or API name\u2026" autocomplete="off">' +
				'</div>' +
				'<div class="base-picker-filters">' +
				'<div class="segmented" role="tablist" id="base-picker-types">' +
				'<button type="button" data-bp-type="all" class="active">All</button>' +
				'<button type="button" data-bp-type="standard">Standard</button>' +
				'<button type="button" data-bp-type="custom">Custom</button>' +
				'</div>' +
				'<span class="tag" id="base-picker-summary"></span>' +
				'</div>' +
				'<div class="base-picker-grid" id="base-picker-grid"></div>';

			const input = picker.querySelector('#base-picker-q');
			input.value = basePickerFilter.text || '';
			input.addEventListener('input', () => {
				basePickerFilter.text = input.value.trim();
				updateBasePickerResults();
			});
			picker.querySelectorAll('[data-bp-type]').forEach((btn) => {
				btn.addEventListener('click', () => {
					basePickerFilter.type = btn.dataset.bpType;
					picker
						.querySelectorAll('[data-bp-type]')
						.forEach((b) => b.classList.toggle('active', b.dataset.bpType === basePickerFilter.type));
					updateBasePickerResults();
				});
			});
			picker.querySelector('#base-picker-grid').addEventListener('click', async (e) => {
				const card = e.target.closest('[data-base-pick]');
				if (!card) {
					return;
				}
				const name = card.dataset.basePick;
				if (subbar) {
					subbar.classList.remove('hidden');
				}
				picker.classList.add('hidden');
				_basePickerWired = false; // force fresh frame on next mount
				nodesRoot.innerHTML = '<div class="graph-empty">Loading\u2026</div>';
				try {
					await addToSelection(name);
					renderAll();
				} catch (err) {
					picker.classList.remove('hidden');
					picker.querySelector('#base-picker-grid').innerHTML =
						'<div class="base-picker-empty">Failed to load: ' + escapeHtml(err.message) + '</div>';
				}
			});
			_basePickerWired = true;
			setTimeout(() => {
				const i = picker.querySelector('#base-picker-q');
				if (i) {
					i.focus();
				}
			}, 0);
		}

		updateBasePickerResults();
	}

	function purgeRedundantTypeNodes() {
		const toRemove = [];
		const _ensureAssoc = (fromId, toId, fieldName) => {
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
			}
		};
		canvasState.bulkRecords.forEach((tn) => {
			if (!tn.isTypeNode || tn.isFreeTypeNode) {
				return;
			}
			const host = canvasState.bulkRecords.find((r) => r.id === tn.hostRecordId);
			if (!host || !host.loadedFromId) {
				return;
			}
			if (tn.direction === 'parent') {
				const parentId = host.values && host.values[tn.fieldOnThis];
				if (!_sfIdValue(parentId)) {
					return;
				}
				const match = canvasState.bulkRecords.find(
					(r) => !r.isTypeNode && r.objectName === tn.objectName && _sfIdMatch(r.loadedFromId, parentId),
				);
				if (match) {
					_ensureAssoc(host.id, match.id, tn.fieldOnThis);
					toRemove.push(tn.id);
				}
			} else if (tn.direction === 'child') {
				const cacheKey = _countCacheKey(tn.objectName, tn.fieldOnOther, host.loadedFromId);
				if (!_relatedCountCache.has(cacheKey)) {
					return;
				}
				const sfCount = _relatedCountCache.get(cacheKey) || 0;
				if (sfCount === 0) {
					return;
				}
				const canvasMatches = canvasState.bulkRecords.filter(
					(r) =>
						!r.isTypeNode &&
						r.objectName === tn.objectName &&
						r.values &&
						_sfIdMatch(r.values[tn.fieldOnOther], host.loadedFromId),
				);
				if (canvasMatches.length >= sfCount) {
					canvasMatches.forEach((m) => _ensureAssoc(m.id, host.id, tn.fieldOnOther));
					toRemove.push(tn.id);
				}
			}
		});
		if (toRemove.length === 0) {
			return 0;
		}
		const remIds = new Set(toRemove);
		canvasState.bulkRecords = canvasState.bulkRecords.filter((r) => !remIds.has(r.id));
		return toRemove.length;
	}

	let _requestSaveQueue = Promise.resolve();
	function _saveRequestChange(rec) {
		const canvas = canvasState.currentCanvas;
		if (!canvas?.id) return promptCanvasSave({ title: 'Save this canvas to save request changes' });
		const save = async () => {
			if (!canvas?.id || canvasState.currentCanvas !== canvas || !canvasState.bulkRecords.includes(rec))
				return false;
			try {
				const payload = buildCanvasPayload();
				const record = [...payload.loadedRecords, ...payload.drafts].find(
					(row) => row.canvasRecordId === rec._canvasRecordId,
				);
				if (!record) throw new Error('This record is no longer available.');
				const result = await platform.saveRequestChange({
					canvas,
					record,
					schemaObject: payload.schema.objects.find((object) => object.name === rec.objectName),
					csrfFetch,
				});
				if (canvasState.currentCanvas !== canvas) return false;
				canvas.versionId = result.versionId;
				_canvasSaveState.captureRequest(result.record, result.schemaObject);
				await platform.recovery?.requestSaved?.();
				return true;
			} catch (error) {
				showBulkToastWithAction(
					'Request changes could not be saved. Your changes are still on this canvas. ' +
						(error.message || error),
					'Retry',
					async () => {
						if (await _saveRequestChange(rec)) showBulkToast('Request changes saved.');
					},
					'error',
				);
				return false;
			} finally {
				await platform.recovery?.saved?.(false);
			}
		};
		const pending = _requestSaveQueue.then(save);
		_requestSaveQueue = pending.catch(() => false);
		return pending;
	}

	async function _saveNewRequestCanvas(config, rec) {
		if (platform.saveRequestChange) return _saveRequestChange(rec);
		if (!config.savedCanvasForRequest) return true;
		if (!canvasState.currentCanvas || canvasState.currentCanvas.id !== config.savedCanvasForRequest) return false;
		if (await saveExistingCanvas()) return true;
		showBulkToast('The request is on your canvas but could not be saved. Save the canvas to publish it.', 'error');
		return false;
	}

	async function convertRecordToFieldSlot(rec) {
		if (!rec || rec.isTypeNode || rec.isPending) {
			return;
		}
		if (!_canAuthorSlots()) {
			showBulkToast('You do not have access to create record or field requests.', 'error');
			return;
		}
		let describe;
		try {
			describe = await ensureDescribe(rec.objectName);
		} catch (e) {
			showBulkToast('Failed to load fields: ' + (e.message || e), 'error');
			return;
		}
		const writable = _slotConfigurationFields(rec, describe);
		if (writable.length === 0) {
			showBulkToast('No writable fields on ' + rec.objectName + '.', 'error');
			return;
		}
		const config = await showSlotConfigurationPicker({
			title: 'Request fields on ' + _slotRecordDisplayName(rec),
			objectName: rec.objectName,
			objectLabel: rec.label || rec.objectName,
			contextLabel: _slotRecordDisplayName(rec),
			kind: 'fields',
			fields: writable,
			initial: { fields: [] },
		});
		if (!config) {
			return;
		}
		rec.slot = {
			slotId: slotIdSeq++,
			kind: 'fields',
			createdAt: Date.now(),
			fields: config.fields,
			label: config.label,
			description: config.description,
			assigneeSfUserId: config.assigneeSfUserId || null,
			assigneeName: config.assigneeName || null,
			assigneeEmail: config.assigneeEmail || null,
		};
		renderBulkView();
		if (!(await _saveNewRequestCanvas(config, rec))) return;
		const _assigneeBit = config.assigneeName
			? ' (assigned to ' + config.assigneeName + ')'
			: ' (open to any recipient)';
		showBulkToast(
			'Marked ' +
				config.fields.length +
				' field' +
				(config.fields.length === 1 ? '' : 's') +
				' requested on this record' +
				_assigneeBit +
				'.',
		);
	}

	async function createStandaloneRecordRequest(objectName, preferredPosition) {
		if (!_canAuthorSlots()) {
			showBulkToast('You do not have access to create record or field requests.', 'error');
			return false;
		}
		const blocked = _canvasCapBlockReason(1);
		if (blocked) {
			showBulkToast(blocked, 'error');
			return false;
		}
		let describe;
		try {
			describe = await ensureDescribe(objectName);
			if (
				!describe ||
				!Array.isArray(describe.fields) ||
				!describe.fields.some((field) => field && field.createable)
			) {
				throw new Error('No createable fields are available.');
			}
		} catch (error) {
			showBulkToast(
				'Could not load the fields needed for this record request. Reconnect Salesforce and try again. ' +
					(error && error.message ? error.message : ''),
				'error',
			);
			return false;
		}
		const objectLabel = describe.label || objectName;
		const config = await showSlotConfigurationPicker({
			title: 'Request a new ' + objectLabel,
			objectName,
			objectLabel,
			kind: 'whole-record',
			initial: {},
		});
		if (!config) {
			return false;
		}
		let selection = canvasState.selectedObjects.find((entry) => entry.name === objectName);
		if (!selection) {
			try {
				selection = await addToSelection(objectName);
			} catch (error) {
				showBulkToast('Failed to add ' + objectLabel + ': ' + (error.message || error), 'error');
				return false;
			}
		}
		const position = _nextRecordPosition(objectName, preferredPosition);
		const recordId = canvasState.bulkIdSeq++;
		const slotId = slotIdSeq++;
		canvasState.bulkRecords.push({
			id: recordId,
			objectName,
			label: selection.label || objectLabel,
			fromSelectionId: selection.id,
			x: position.x,
			y: position.y,
			values: {},
			slot: {
				slotId,
				kind: 'whole-record',
				createdAt: Date.now(),
				origin: 'standalone',
				label: config.label,
				description: config.description,
				assigneeSfUserId: config.assigneeSfUserId || null,
				assigneeName: config.assigneeName || null,
				assigneeEmail: config.assigneeEmail || null,
			},
		});
		renderBulkView();
		pushUndo('Add record request', () => {
			canvasState.bulkRecords = canvasState.bulkRecords.filter((record) => record && record.id !== recordId);
			canvasState.bulkAssociations = canvasState.bulkAssociations.filter(
				(association) => association && association.fromId !== recordId && association.toId !== recordId,
			);
			renderBulkView();
		});
		if (
			!(await _saveNewRequestCanvas(
				config,
				canvasState.bulkRecords.find((record) => record.id === recordId),
			))
		)
			return false;
		const _slotAssigneeBit = config.assigneeName
			? ' (assigned to ' + config.assigneeName + ')'
			: ' (open to any recipient)';
		showBulkToast('Record request created' + _slotAssigneeBit + '.');
		return true;
	}

	function openStandaloneRecordRequestPicker(triggerEl, preferredPosition) {
		if (!_canAuthorSlots()) {
			showBulkToast('You do not have access to create record or field requests.', 'error');
			return false;
		}
		showFindObjectPopover(triggerEl, {
			header: 'Request a record',
			sub: 'Choose the type of record a teammate should create or select.',
			isAdded: () => false,
			onPick: (name) => createStandaloneRecordRequest(name, preferredPosition),
		});
		return true;
	}

	function _slotRecordDisplayName(rec) {
		if (!rec) {
			return 'this record';
		}
		const values = rec.values || {};
		const fullName = ((values.FirstName || '') + ' ' + (values.LastName || '')).trim();
		if (fullName) {
			return fullName;
		}
		const describe = canvasState.describeCache[rec.objectName];
		const nameField =
			describe && Array.isArray(describe.fields) && describe.fields.find((field) => field.nameField);
		const display =
			(nameField && values[nameField.name]) ||
			values.Name ||
			values.Subject ||
			values.Title ||
			values.CaseNumber ||
			values.OrderNumber;
		return display ? String(display) : rec.label || rec.objectName || 'this record';
	}

	function _slotConfigurationFields(rec, describe) {
		const permissionName = rec && rec.loadedFromId ? 'updateable' : 'createable';
		const writable = (describe.fields || []).filter(
			(field) =>
				field[permissionName] &&
				field.name !== 'Id' &&
				field.name !== 'RecordTypeId' &&
				field.type !== 'address' &&
				field.type !== 'location' &&
				String(field.type || '').toLowerCase() !== 'encryptedstring',
		);
		const byName = new Set(writable.map((field) => field.name));
		const encryptedNames = new Set(
			(describe.fields || [])
				.filter((field) => field && String(field.type || '').toLowerCase() === 'encryptedstring')
				.map((field) => field.name),
		);
		const current = rec && rec.slot && Array.isArray(rec.slot.fields) ? rec.slot.fields : [];
		current.forEach((name) => {
			if (name !== 'Id' && !encryptedNames.has(name) && !byName.has(name)) {
				writable.push({ name, label: name, type: null, unavailable: true });
			}
		});
		return writable;
	}

	async function configureExistingSlot(rec) {
		if (!rec || !rec.slot || rec.slot.slotId == null) {
			return;
		}
		if (!_canAuthorSlots()) {
			showBulkToast('You do not have access to create record or field requests.', 'error');
			return;
		}
		if (!_canEditCanvasStructure()) {
			showBulkToast('Only the canvas owner or an editor can change contributor requests.', 'error');
			return;
		}
		const kind = rec.slot.kind === 'fields' ? 'fields' : 'whole-record';
		let fields = [];
		if (kind === 'fields') {
			try {
				fields = _slotConfigurationFields(rec, await ensureDescribe(rec.objectName));
			} catch (error) {
				showBulkToast('Failed to load fields: ' + (error.message || error), 'error');
				return;
			}
		}
		const config = await showSlotConfigurationPicker({
			title:
				kind === 'fields'
					? 'Request fields on ' + _slotRecordDisplayName(rec)
					: 'Request a new ' + (rec.label || rec.objectName),
			objectName: rec.objectName,
			objectLabel: rec.label || rec.objectName,
			contextLabel: _slotRecordDisplayName(rec),
			kind,
			fields,
			initial: rec.slot,
		});
		if (!config) {
			return;
		}
		const slotId = rec.slot.slotId;
		rec.slot = {
			slotId,
			kind: config.kind,
			createdAt: rec.slot.createdAt || Date.now(),
			...(config.kind === 'whole-record' ? { origin: rec.slot.origin || 'standalone' } : {}),
			label: config.label,
			description: config.description,
			assigneeSfUserId: config.assigneeSfUserId || null,
			assigneeName: config.assigneeName || null,
			assigneeEmail: config.assigneeEmail || null,
		};
		if (config.kind === 'fields') {
			rec.slot.fields = config.fields.slice();
		}
		renderBulkView();
		_publishPresenceChanges();
		if (!(await _saveNewRequestCanvas(config, rec))) return;
		showBulkToast(
			(kind === 'fields' ? 'Field request' : 'Record request') + ' updated for everyone viewing this canvas.',
		);
	}

	async function convertSlotBackToRecord(rec, options) {
		if (!rec || !rec.slot) {
			return;
		}
		delete rec.slot;
		delete rec._recipientSlot;
		renderBulkView();
		if (platform.saveRequestChange && !(await _saveRequestChange(rec))) return;
		showBulkToast(
			options && options.convertedToDraft ? 'Record request converted to a draft.' : 'Removed request.',
		);
	}

	async function openRecordForCurrentUser(rec, options) {
		if (!rec) {
			return false;
		}
		const shareRole = _getCanvasShareRole();
		if ((shareRole === 'contributor' || shareRole === 'editor') && rec.slot && rec.slot.slotId != null) {
			const permissionBlock = await _refreshSlotPermission(rec);
			if (permissionBlock) {
				renderBulkView();
				if (_slotInaccessibleObjects.has(rec.objectName)) {
					showBulkToast(permissionBlock, 'error');
					return false;
				}
			}
		}
		const wholeRecordRequest = !!(
			rec.slot &&
			rec.slot.slotId != null &&
			(rec.slot.kind || 'whole-record') === 'whole-record'
		);
		if (wholeRecordRequest) {
			if (shareRole && shareRole !== 'contributor' && shareRole !== 'editor') {
				showBulkToast(
					'Only the canvas owner can configure this request, and only a contributor can fill it.',
					'info',
				);
				return false;
			}
			if (_isSlotLockedForCurrentUser(rec)) {
				const who = rec.slot.assigneeName || rec.slot.assigneeEmail || 'another teammate';
				showBulkToast('Reserved for ' + who + ': only they can fill this request.', 'info');
				return false;
			}
		}
		openInsertModal(rec.objectName, Object.assign({ record: rec }, options || {}));
		return true;
	}

	function _slotNoAccessMessage(rec, e) {
		const label = (rec && (rec.label || rec.objectName)) || 'this request';
		if (e && e.code === 'object-no-access') {
			return (
				'You don’t have access to the “' +
				label +
				'” object (' +
				rec.objectName +
				') in Salesforce, so you can’t complete this request. Ask the sender or your Salesforce admin for access.'
			);
		}
		return 'Couldn’t open “' + label + '”: ' + ((e && e.message) || e);
	}

	async function _refreshSlotPermission(rec) {
		if (!rec || !rec.objectName) {
			return null;
		}
		try {
			const response = await csrfFetch('/api/objects/' + encodeURIComponent(rec.objectName) + '/describe', {
				credentials: 'same-origin',
			});
			_slotDescribeAccessByObject.set(rec.objectName, response.ok ? await response.json() : null);
			if (!response.ok) {
				_slotInaccessibleObjects.add(rec.objectName);
			} else {
				_slotInaccessibleObjects.delete(rec.objectName);
			}
		} catch (_error) {
			_slotDescribeAccessByObject.set(rec.objectName, null);
			_slotInaccessibleObjects.add(rec.objectName);
		}
		return _slotPermissionBlockReason(rec);
	}

	async function fillSlotWithLoad(rec, anchorEl) {
		if (!rec || !_isEmptySlot(rec)) {
			return;
		}
		const blocked = _canvasCapBlockReason(1);
		if (blocked) {
			showBulkToast(blocked);
			return;
		}

		if (_slotInaccessibleObjects.has(rec.objectName)) {
			showBulkToast(_slotNoAccessMessage(rec, { code: 'object-no-access' }), 'error');
			return;
		}
		let s = canvasState.selectedObjects.find((so) => so.name === rec.objectName);
		if (!s) {
			try {
				s = await addToSelection(rec.objectName);
			} catch (e) {
				showBulkToast(_slotNoAccessMessage(rec, e), 'error');
				return;
			}
		}
		_openSlotRecordPicker(rec, anchorEl);
	}

	async function _runSlotPreflight() {
		_slotInaccessibleObjects.clear();
		_slotDescribeAccessByObject.clear();
		const slotObjects = new Set();
		canvasState.bulkRecords.forEach((r) => {
			if (r && r.slot && r.slot.slotId != null && r.objectName) {
				slotObjects.add(r.objectName);
			}
		});
		if (slotObjects.size === 0) {
			return;
		}
		const probes = await Promise.all(
			[...slotObjects].map(async (name) => {
				try {
					const r = await csrfFetch('/api/objects/' + encodeURIComponent(name) + '/describe', {
						credentials: 'same-origin',
					});
					return { name, ok: r.ok, describe: r.ok ? await r.json() : null };
				} catch (e) {
					return { name, ok: false, describe: null };
				}
			}),
		);
		probes.forEach((probe) => _slotDescribeAccessByObject.set(probe.name, probe.describe));
		const inaccessible = probes.filter((p) => !p.ok).map((p) => p.name);
		inaccessible.forEach((n) => _slotInaccessibleObjects.add(n));
		if (inaccessible.length > 0) {
			const list =
				inaccessible.slice(0, 3).join(', ') +
				(inaccessible.length > 3 ? ', +' + (inaccessible.length - 3) + ' more' : '');
			showBulkToast(
				'Some slots may not be fillable with your current permissions: ' +
					list +
					'. Ask your admin for read access if you need to fill them.',
				'error',
			);
		}
		renderBulkView();
	}

	async function _fillSlotWithSfRecord(rec, sfRecord) {
		if (!sfRecord || !sfRecord.Id) {
			showBulkToast('Record could not be loaded.', 'error');
			return;
		}
		const dup = canvasState.bulkRecords.find(
			(b) =>
				!b.isTypeNode && b.id !== rec.id && b.objectName === rec.objectName && b.loadedFromId === sfRecord.Id,
		);
		if (dup) {
			canvasState.bulkAssociations.forEach((a) => {
				if (a.fromId === rec.id) {
					a.fromId = dup.id;
				}
				if (a.toId === rec.id) {
					a.toId = dup.id;
				}
			});
			const i = canvasState.bulkRecords.findIndex((b) => b.id === rec.id);
			if (i !== -1) {
				canvasState.bulkRecords.splice(i, 1);
			}
			canvasState.bulkSelectedIds.clear();
			canvasState.bulkSelectedIds.add(dup.id);
			renderBulkView();
			showBulkToast('That record was already on the canvas - the slot now points at it.');
			return;
		}
		let targetSel = canvasState.selectedObjects.find((s) => s.name === rec.objectName);
		if (!targetSel) {
			try {
				targetSel = await addToSelection(rec.objectName);
			} catch (e) {
				console.warn('addToSelection failed', e);
			}
		}
		const values = {};
		Object.keys(sfRecord).forEach((k) => {
			if (k === 'attributes' || sfRecord[k] == null) {
				return;
			}
			values[k] = sfRecord[k];
		});
		rec.loadedFromId = sfRecord.Id;
		rec.values = values;
		rec.loadedValues = Object.assign({}, values);
		rec.label = targetSel ? targetSel.label : rec.objectName;
		rec.fromSelectionId = targetSel ? targetSel.id : null;
		delete rec.slot;
		renderBulkView();
		showBulkToast('Loaded ' + (rec.label || rec.objectName) + ' into slot.');
	}

	async function fillSlotWithBlank(rec) {
		if (!rec || !_isEmptySlot(rec)) {
			return;
		}
		const shareRole = _getCanvasShareRole();
		const canCompleteRequest =
			!shareRole ||
			shareRole === 'editor' ||
			(shareRole === 'contributor' && rec._recipientSlot && !_isSlotLockedForCurrentUser(rec));
		if (!canCompleteRequest) {
			showBulkToast(
				'Only the canvas owner, an editor, or the eligible contributor can fill this request.',
				'info',
			);
			return;
		}
		const blocked = _canvasCapBlockReason(1);
		if (blocked) {
			showBulkToast(blocked);
			return;
		}
		const permissionBlock = await _refreshSlotPermission(rec);
		if (permissionBlock) {
			showBulkToast(permissionBlock, 'error');
			renderBulkView();
			return;
		}
		const matchingSel = canvasState.selectedObjects.find((s) => s.name === rec.objectName);
		rec.fromSelectionId = matchingSel ? matchingSel.id : null;
		rec.label = (matchingSel && matchingSel.label) || rec.objectName;
		rec.values = {};
		openInsertModal(rec.objectName, { record: rec });
	}

	async function runWithConcurrency(tasks, limit) {
		const queue = tasks.slice();
		const workers = new Array(Math.min(limit, queue.length)).fill(0).map(async () => {
			while (queue.length > 0) {
				const t = queue.shift();
				try {
					await t();
				} catch (e) {}
			}
		});
		await Promise.all(workers);
	}
	if (
		typeof window !== 'undefined' &&
		typeof window.location !== 'undefined' &&
		/[?&]test=1/.test(window.location.search)
	) {
		window.__orgloomTest = {
			deleteRecord: (id) => deleteRecord(id),
			seedDraftRecord: ({ objectName, values }) => {
				const id = canvasState.bulkIdSeq++;
				canvasState.bulkRecords.push({
					id,
					objectName,
					values: Object.assign({}, values || {}),
				});
				renderBulkView();
				return id;
			},
			getRecords: () =>
				canvasState.bulkRecords.map((r) => ({
					id: r.id,
					objectName: r.objectName,
					loadedFromId: r.loadedFromId || null,
					isPending: !!r.isPending,
					isTypeNode: !!r.isTypeNode,
					x: r.x,
					y: r.y,
					values: Object.assign({}, r.values || {}),
					loadedValues: r.loadedValues ? Object.assign({}, r.loadedValues) : undefined,
					slot: r.slot
						? Object.assign({}, r.slot, {
								fields: Array.isArray(r.slot.fields) ? r.slot.fields.slice() : undefined,
							})
						: undefined,
					_recipientSlot: !!r._recipientSlot,
				})),

			setSelection: (ids) => {
				canvasState.bulkSelectedIds = new Set(Array.isArray(ids) ? ids : [ids]);
				renderBulkView();
			},
			getAssociations: () =>
				canvasState.bulkAssociations.map((a) => ({
					id: a.id,
					fromId: a.fromId,
					toId: a.toId,
					fieldName: a.fieldName,
				})),
			getRenderedEdges: () =>
				_cyInstance
					? _cyInstance.edges().map((edge) => ({
							id: edge.id(),
							source: edge.data('source'),
							target: edge.data('target'),
							fieldName: edge.data('label') || '',
							kind: edge.data('kind') || '',
						}))
					: [],

			getSchemaViewObject: () => canvasState._schemaViewObject || null,

			setRecordValue: (id, field, value) => {
				const rec = canvasState.bulkRecords.find((r) => r.id === id);
				if (!rec) {
					return false;
				}
				rec.values = Object.assign({}, rec.values || {}, {
					[field]: value,
				});
				rec._valuesRevision = (Number(rec._valuesRevision) || 0) + 1;
				renderBulkView();
				return true;
			},
			setRecordSlot: (id, slot, recipientSlot) => {
				const rec = canvasState.bulkRecords.find((r) => r.id === id);
				if (!rec) {
					return false;
				}
				rec.slot = slot
					? Object.assign({}, slot, {
							fields: Array.isArray(slot.fields) ? slot.fields.slice() : undefined,
						})
					: null;
				rec._recipientSlot = !!recipientSlot;
				renderBulkView();
				return true;
			},
			setSharedCanvasRole: (role) => {
				canvasState.currentCanvas = {
					id: 'test-shared-canvas',
					title: 'Test shared canvas',
					ownedByMe: false,
					versionId: null,
					recipientRole: role,
				};
				_canvasShareCanvasId = canvasState.currentCanvas.id;
				_canvasShareRole = role;
				canvasState._renderCanvasShareRole = role;
				renderShareRecipientBanner();
				renderBulkView();
			},
			addAssociation: (fromId, toId, fieldName) => {
				canvasState.bulkAssociations.push({
					id: canvasState.bulkIdSeq++,
					fromId,
					toId,
					fieldName,
				});
				renderBulkView();
			},
			getCyZoom: () => (_cyInstance ? _cyInstance.zoom() : null),
			getCyPan: () => (_cyInstance ? Object.assign({}, _cyInstance.pan()) : null),
			getModifiedLoadedCount: () => _modifiedLoadedCount(),

			seedLoadedRecord: ({ objectName, sfId, loadedValues, currentValues }) => {
				const id = canvasState.bulkIdSeq++;
				canvasState.bulkRecords.push({
					id,
					objectName,
					loadedFromId: sfId,
					loadedValues: Object.assign({}, loadedValues || {}),
					values: Object.assign({}, currentValues || loadedValues || {}),
				});
				renderBulkView();
				return id;
			},

			bulkSeedLoadedRecords: (records) => {
				const ids = [];
				(records || []).forEach((r) => {
					const id = canvasState.bulkIdSeq++;
					canvasState.bulkRecords.push({
						id,
						objectName: r.objectName,
						loadedFromId: r.sfId,
						loadedValues: Object.assign({}, r.loadedValues || {}),
						values: Object.assign({}, r.currentValues || r.loadedValues || {}),
					});
					ids.push(id);
				});
				renderBulkView();
				return ids;
			},

			openEditModal: (id) => {
				const rec = canvasState.bulkRecords.find((r) => r.id === id);
				if (!rec || rec.isTypeNode || rec.isPending || rec._inaccessible) {
					return false;
				}
				return openRecordForCurrentUser(rec);
			},

			confirmAndRecall: async (batchId) => _uh_testConfirmAndRecall(batchId),

			createAssociation: (fromRecId, toRecId, fieldName) => {
				const src = canvasState.bulkRecords.find((r) => r.id === fromRecId);
				const tgt = canvasState.bulkRecords.find((r) => r.id === toRecId);
				if (!src || !tgt) {
					return false;
				}
				createAssociation(src, tgt, 'fwd', fieldName);
				return true;
			},
			deleteAssociation: (assocId) => {
				deleteAssociation(assocId);
				return true;
			},
		};
	}

	function updateBasePickerResults() {
		const picker = graph.querySelector('#base-picker');
		if (!picker || picker.classList.contains('hidden') || !canvasState.allObjects) {
			return;
		}
		const grid = picker.querySelector('#base-picker-grid');
		const summary = picker.querySelector('#base-picker-summary');
		const q = (basePickerFilter.text || '').toLowerCase();
		const filtered = canvasState.allObjects.filter((o) => {
			if (basePickerFilter.type === 'standard' && o.custom) {
				return false;
			}
			if (basePickerFilter.type === 'custom' && !o.custom) {
				return false;
			}
			if (!q) {
				return true;
			}
			return (
				(o.name && o.name.toLowerCase().includes(q)) ||
				(o.label && o.label.toLowerCase().includes(q)) ||
				(o.keyPrefix && o.keyPrefix.toLowerCase() === q)
			);
		});
		const capped = filtered.slice(0, 60);
		grid.innerHTML =
			capped.length === 0
				? '<div class="base-picker-empty">No matching objects.</div>'
				: capped
						.map(
							(o) =>
								'<button type="button" class="base-picker-card" data-base-pick="' +
								escapeHtml(o.name) +
								'" title="Start with ' +
								escapeHtml(o.label) +
								'">' +
								'<span class="bp-label">' +
								escapeHtml(o.label) +
								'</span>' +
								'<span class="bp-name">' +
								escapeHtml(o.name) +
								'</span>' +
								'<span class="bp-tag">' +
								(o.custom ? 'Custom' : 'Standard') +
								(o.queryable ? '' : ' \u00b7 not queryable') +
								'</span>' +
								'</button>',
						)
						.join('');
		if (summary) {
			summary.textContent =
				filtered.length === capped.length
					? 'Showing ' + capped.length + ' / ' + canvasState.allObjects.length
					: 'Showing ' + capped.length + ' of ' + filtered.length + ' / ' + canvasState.allObjects.length;
		}
	}

	function _schemaActiveFromBulkSelection() {
		if (canvasState.bulkSelectedIds.size !== 1) {
			return null;
		}
		const onlyId = canvasState.bulkSelectedIds.values().next().value;
		const rec = canvasState.bulkRecords.find((r) => r.id === onlyId);
		if (!rec || rec.isTypeNode) {
			return null;
		}
		let focusedSel = null;
		if (rec.fromSelectionId != null) {
			focusedSel = canvasState.selectedObjects.find((s) => s.id === rec.fromSelectionId) || null;
		}
		if (!focusedSel) {
			focusedSel = canvasState.selectedObjects.find((s) => s.name === rec.objectName) || null;
		}
		if (!focusedSel) {
			return null;
		}
		const componentRecIds = new Set();
		const recQueue = [rec.id];
		while (recQueue.length) {
			const id = recQueue.shift();
			if (componentRecIds.has(id)) {
				continue;
			}
			componentRecIds.add(id);
			canvasState.bulkAssociations.forEach((a) => {
				if (a.fromId === id && !componentRecIds.has(a.toId)) {
					recQueue.push(a.toId);
				}
				if (a.toId === id && !componentRecIds.has(a.fromId)) {
					recQueue.push(a.fromId);
				}
			});
		}
		const componentSelIds = new Set();
		componentSelIds.add(focusedSel.id);
		canvasState.bulkRecords.forEach((r) => {
			if (!componentRecIds.has(r.id)) {
				return;
			}
			if (r.fromSelectionId != null) {
				componentSelIds.add(r.fromSelectionId);
			}
		});

		const _selHasAnyRecord = (selId) =>
			canvasState.bulkRecords.some((r) => !r.isTypeNode && r.fromSelectionId === selId);
		let grew = true;
		while (grew) {
			grew = false;
			canvasState.selectedObjects.forEach((s) => {
				if (componentSelIds.has(s.id)) {
					return;
				}
				if (_selHasAnyRecord(s.id)) {
					return;
				}
				if (s.addedFrom != null && componentSelIds.has(s.addedFrom)) {
					componentSelIds.add(s.id);
					grew = true;
				}
			});
			canvasState.selectedObjects.forEach((s) => {
				if (!componentSelIds.has(s.id)) {
					return;
				}
				if (s.addedFrom == null) {
					return;
				}
				if (componentSelIds.has(s.addedFrom)) {
					return;
				}
				if (_selHasAnyRecord(s.addedFrom)) {
					return;
				}
				componentSelIds.add(s.addedFrom);
				grew = true;
			});
		}
		let active = focusedSel;
		const candidate = canvasState.selectedObjects[canvasState.activeIndex];
		if (candidate && componentSelIds.has(candidate.id)) {
			active = candidate;
		}
		return { active, componentSelIds };
	}

	const _bs = window.OrgLoom.bulkScript.mount({
		canCommit: canCommitLocalChanges,
		canvasState: canvasState,
		csrfFetch: csrfFetch,
		refreshCapabilities: function () {
			return _loadCaps().then(() => renderBulkToolbar());
		},
		showBulkToast: showBulkToast,
		showBulkToastWithAction: showBulkToastWithAction,
		renderBulkView: renderBulkView,
		showConfirmDialog: showConfirmDialog,
	});
	const openBulkScriptModal = _bs.openModal;

	const _rc = window.OrgLoom.relatedCounts.mount({
		canvasState: canvasState,
		csrfFetch: csrfFetch,
		fetchGraphData: function (name) {
			return fetchGraphData(name);
		},
	});
	const _RELATED_SOFT_THRESHOLD = _rc._RELATED_SOFT_THRESHOLD;
	const _RELATED_HARD_THRESHOLD = _rc._RELATED_HARD_THRESHOLD;
	const _RELATED_BULK_LOAD_CAP = _rc._RELATED_BULK_LOAD_CAP;
	const PREFETCH_COUNT_CAP = _rc.PREFETCH_COUNT_CAP;
	const AUDIT_FK_FIELDS = _rc.AUDIT_FK_FIELDS;
	const _relatedCountCache = _rc._relatedCountCache;
	const _byRefCache = _rc._byRefCache;
	const _countCacheKey = _rc._countCacheKey;
	const fetchRelatedCount = _rc.fetchRelatedCount;
	const fetchRelatedCountsBatch = _rc.fetchRelatedCountsBatch;
	const fetchByRefCached = _rc.fetchByRefCached;
	const prefetchTypeNodeOneLevel = _rc.prefetchTypeNodeOneLevel;
	const _fop = window.OrgLoom.findObjectPopover.mount({
		canvasState: canvasState,
		escapeHtml: escapeHtml,
		showBulkToast: showBulkToast,
		addToSelection: addToSelection,
		renderAll: renderAll,
	});
	const showFindObjectPopover = _fop.showFindObjectPopover;
	const _pf = window.OrgLoom.preflight.mount({
		canvasState: canvasState,
		isRecordModified: isRecordModified,
		recordOrdinal: recordOrdinal,
	});
	const validateBulkRecords = _pf.validateBulkRecords;
	const computeUploadOrder = _pf.computeUploadOrder;

	const _sg = window.OrgLoom.schemaGraph.mount({
		canvasState: canvasState,
		csrfFetch: csrfFetch,
		escapeHtml: escapeHtml,
		addToSelection: addToSelection,
		renderAll: renderAll,
		renderBulkView: renderBulkView,
		renderCanvas: function () {
			return renderCanvas();
		},
		getGraph: function () {
			return graph;
		},
	});
	const openGraph = _sg.openGraph;
	const closeGraph = _sg.closeGraph;
	const fetchGraphData = _sg.fetchGraphData;
	const setGraphView = _sg.setGraphView;
	const _runAfterSchemaTransition = _sg._runAfterSchemaTransition;

	const _cyi = window.OrgLoom.cyInteractions.mount({
		getCanvasSpaceHeld: function () {
			return _canvasSpaceHeld;
		},
		setCanvasMiddleMousePanning: function (v) {
			_canvasMiddleMousePanning = v;
		},
	});
	const attachCyEdgeMarkers = _cyi.attachCyEdgeMarkers;
	const redrawCyEdgeMarkers = _cyi.redrawCyEdgeMarkers;
	const attachCyMarqueeSelect = _cyi.attachCyMarqueeSelect;
	const attachCySpacePan = _cyi.attachCySpacePan;
	const attachCyWheelZoom = _cyi.attachCyWheelZoom;
	const attachCyMiddleClickPan = _cyi.attachCyMiddleClickPan;

	const _su = window.OrgLoom.slotUser.mount({
		canvasState: canvasState,
		csrfFetch: csrfFetch,
		escapeHtml: escapeHtml,
		getCanvasShareRole: function () {
			return _getCanvasShareRole();
		},
	});
	const _isEmptySlot = _su._isEmptySlot;
	const _slotAssignmentState = _su._slotAssignmentState;
	const _isSlotLockedForCurrentUser = _su._isSlotLockedForCurrentUser;
	const _slotRequestBadgeHtml = _su._slotRequestBadgeHtml;
	const _slotAssignmentCardClass = _su._slotAssignmentCardClass;
	const _slotProgress = _su._slotProgress;
	const _aggregateSlotProgress = _su._aggregateSlotProgress;
	const _slotProgressClass = _su._slotProgressClass;
	const _resolveUserName = _su._resolveUserName;
	const _formatRelativeTime = _su._formatRelativeTime;
	const _slotPreflightWarn = _su._slotPreflightWarn;
	const _slotPermissionBlockReason = _su._slotPermissionBlockReason;
	const _slotInaccessibleObjects = _su._slotInaccessibleObjects;
	const _slotDescribeAccessByObject = _su._slotDescribeAccessByObject;

	const _rdm = window.OrgLoom.recordDiffModal.mount({
		canvasState: canvasState,
		escapeHtml: escapeHtml,
		computeRecordDiff: computeRecordDiff,
		recordOrdinal: function () {
			return recordOrdinal.apply(null, arguments);
		},
		renderBulkView: function () {
			return renderBulkView();
		},
		isRecordPendingDelete: function (r) {
			return isRecordPendingDelete(r);
		},
		pushUndo: pushUndo,
		showBulkToast: showBulkToast,
	});
	const openRecordDiffModal = _rdm.openRecordDiffModal;

	const _fdm = window.OrgLoom.findDuplicatesModal.mount({
		canvasState: canvasState,
		escapeHtml: escapeHtml,
		recordOrdinal: function () {
			return recordOrdinal.apply(null, arguments);
		},
		renderBulkView: function () {
			return renderBulkView();
		},
		deleteRecord: function () {
			return deleteRecord.apply(null, arguments);
		},
		markPendingDelete: function () {
			return markPendingDelete.apply(null, arguments);
		},
		isRecordPendingDelete: function (r) {
			return isRecordPendingDelete(r);
		},
		showBulkToast: function () {
			return showBulkToast.apply(null, arguments);
		},
		showBulkToastWithAction: showBulkToastWithAction,
		undoStackSize: undoStackSize,
		trimUndoStack: trimUndoStack,
		getCyInstance: function () {
			return _cyInstance;
		},
	});
	const openFindDuplicatesModal = _fdm.openFindDuplicatesModal;

	const _bom = window.OrgLoom.bulkOpsMenu.mount({
		canvasState: canvasState,
		canEditCanvasStructure: _canEditCanvasStructure,
		_hasCap: _hasCap,
		isCapabilityReady: function () {
			return _capsLoaded;
		},
		bulkAutoFill: function () {
			return bulkAutoFill.apply(null, arguments);
		},
		bulkClearAllFields: function () {
			return bulkClearAllFields.apply(null, arguments);
		},
		summarizeAutoFillTargets: function () {
			return summarizeAutoFillTargets.apply(null, arguments);
		},
		openLinkedCsvModal: function () {
			return openLinkedCsvModal.apply(null, arguments);
		},
		openAiGenModal: function () {
			return openAiGenModal.apply(null, arguments);
		},
		getAiGen: function () {
			return _aiGen;
		},
		openSoqlImportModal: function () {
			return openSoqlImportModal.apply(null, arguments);
		},
		openBrowseModal: function () {
			return openBrowseModal.apply(null, arguments);
		},
		openBulkEditModal: function () {
			return openBulkEditModal.apply(null, arguments);
		},
		openBulkScriptModal: function () {
			return openBulkScriptModal.apply(null, arguments);
		},
		openRecordDiffModal: function () {
			return openRecordDiffModal.apply(null, arguments);
		},
		openCanvasSearchModal: function () {
			return openCanvasSearchModal.apply(null, arguments);
		},
		openFindDuplicatesModal: function () {
			return openFindDuplicatesModal.apply(null, arguments);
		},
		openBulkRefreshFlow: function () {
			return openBulkRefreshFlow.apply(null, arguments);
		},
		bulkDeleteCandidates: bulkDeleteCandidates,
		openBulkDeleteFlow: openBulkDeleteFlow,
		beginMigration: function () {
			if (platform.migration?.start) {
				return platform.migration.start({
					exportForMigration: () =>
						downloadTemplate(canvasState.currentCanvas?.title || 'canvas', false, true),
				});
			}
			return beginMigration.apply(null, arguments);
		},
		openStandaloneRecordRequestPicker: function () {
			return openStandaloneRecordRequestPicker.apply(null, arguments);
		},
		spawnPendingRecord: function () {
			return spawnPendingRecord.apply(null, arguments);
		},
		triggerTemplateFileInput: function () {
			return triggerTemplateFileInput.apply(null, arguments);
		},
		getGraph: function () {
			return graph;
		},
		getCyInstance: function () {
			return _cyInstance;
		},
		getCanvasSpaceHeld: function () {
			return _canvasSpaceHeld;
		},
		setCanvasSpaceHeld: function (v) {
			_canvasSpaceHeld = v;
		},
		getCanvasZHeld: function () {
			return _canvasZHeld;
		},
		setCanvasZHeld: function (v) {
			_canvasZHeld = v;
		},
		_isOnPaidPlan: _isOnPaidPlan,
	});
	const _wireCanvasFloatingAdd = _bom._wireCanvasFloatingAdd;
	const _showCanvasContextMenu = _bom._showCanvasContextMenu;
	const showAddRecordsMenu = _bom.showAddRecordsMenu;
	const showBulkOperationsMenu = _bom.showBulkOperationsMenu;
	const showBulkHelpPopover = _bom.showBulkHelpPopover;

	const _baf = window.OrgLoom.bulkAutofill.mount({
		canCommit: canCommitLocalChanges,
		canvasState: canvasState,
		csrfFetch: csrfFetch,
		ensureDescribe: ensureDescribe,
		fieldTypeFilter: function () {
			return fieldTypeFilter.apply(null, arguments);
		},
		getSmartDefault: getSmartDefault,
		renderBulkView: function () {
			return renderBulkView();
		},
		sampleValueForField: function () {
			return sampleValueForField.apply(null, arguments);
		},
		showBulkToast: showBulkToast,
		showBulkToastWithAction: showBulkToastWithAction,
		showConfirmDialog: showConfirmDialog,
		loadSmartDefaults: function () {
			return loadSmartDefaults();
		},
		refreshCapabilities: function () {
			return _loadCaps().then(() => renderBulkToolbar());
		},
	});
	const bulkAutoFill = _baf.bulkAutoFill;
	const bulkClearAllFields = _baf.bulkClearAllFields;
	const summarizeAutoFillTargets = _baf.summarizeAutoFillTargets;

	const _sb = window.OrgLoom.schemaBuilder.mount({
		canvasState: canvasState,
		escapeHtml: escapeHtml,
		showBulkToast: showBulkToast,
		addToSelection: addToSelection,
		renderBulkView: renderBulkView,
		fetchGraphData: fetchGraphData,
		ensureDescribe: ensureDescribe,
		ensureRules: ensureRules,
		RECORDS_WORLD_SCALE: RECORDS_WORLD_SCALE,
		_canvasCapBlockReason: _canvasCapBlockReason,
		pushUndo: pushUndo,
		attachCyEdgeMarkers: attachCyEdgeMarkers,
		attachCyMiddleClickPan: attachCyMiddleClickPan,
		attachCyWheelZoom: attachCyWheelZoom,
		redrawCyEdgeMarkers: redrawCyEdgeMarkers,
		SCHEMA_SYSTEM_FK_FIELDS: SCHEMA_SYSTEM_FK_FIELDS,
		getGraph: function () {
			return graph;
		},
		getCySchemaInstance: function () {
			return _cySchemaInstance;
		},
		setCySchemaInstance: function (v) {
			_cySchemaInstance = v;
		},
	});
	const renderCanvas = _sb.renderCanvas;
	const makeNode = _sb.makeNode;

	let _publishPresenceLayout = function () {};
	let _publishPresenceChanges = function () {};
	const _rcv = window.OrgLoom.recordsCanvas.mount({
		canvasState: canvasState,
		escapeHtml: escapeHtml,
		showBulkToast: showBulkToast,
		isRecordModified: isRecordModified,
		recordOrdinal: recordOrdinal,
		attachCyEdgeMarkers: attachCyEdgeMarkers,
		redrawCyEdgeMarkers: redrawCyEdgeMarkers,
		attachCyMarqueeSelect: attachCyMarqueeSelect,
		attachCyMiddleClickPan: attachCyMiddleClickPan,
		attachCySpacePan: attachCySpacePan,
		attachCyWheelZoom: attachCyWheelZoom,
		openRecord: function () {
			return openRecordForCurrentUser.apply(null, arguments);
		},
		hasCapability: _hasCap,
		isCapabilityReady: function () {
			return _capsLoaded;
		},
		getCanvasShareRole: function () {
			return _getCanvasShareRole();
		},
		publishPresenceLayout: function (records) {
			return _publishPresenceLayout(records);
		},
		notifyCanvasContentChanged: function () {
			return _canvasSaveState.refresh();
		},
		showFindObjectPopover: function () {
			return showFindObjectPopover.apply(null, arguments);
		},
		renderBulkView: function () {
			return renderBulkView();
		},
		renderCanvas: function () {
			return renderCanvas();
		},
		_runAfterSchemaTransition: _runAfterSchemaTransition,
		_isEmptySlot: function (r) {
			return _isEmptySlot(r);
		},
		_slotAssignmentState: function (r) {
			return _slotAssignmentState(r);
		},
		_slotRequestBadgeHtml: function (r) {
			return _slotRequestBadgeHtml(r);
		},
		_slotAssignmentCardClass: function (r) {
			return _slotAssignmentCardClass(r);
		},
		_slotAssignmentState: function (r) {
			return _slotAssignmentState(r);
		},
		_isSlotLockedForCurrentUser: function (r) {
			return _isSlotLockedForCurrentUser(r);
		},
		_slotPreflightWarn: function (r) {
			return _slotPreflightWarn(r);
		},
		_slotProgress: function (r) {
			return _slotProgress(r);
		},
		_slotProgressClass: function (p) {
			return _slotProgressClass(p);
		},
		_ensureChipProbed: function (r) {
			return _ensureChipProbed(r);
		},
		_relInfoForRec: function (r) {
			return _relInfoForRec(r);
		},
		_showStaleRefMenu: function () {
			return _showStaleRefMenu.apply(null, arguments);
		},
		_isRecordStale: function (r) {
			return _isRecordStale(r);
		},
		fillSlotWithBlank: function () {
			return fillSlotWithBlank.apply(null, arguments);
		},
		fillSlotWithLoad: function () {
			return fillSlotWithLoad.apply(null, arguments);
		},
		deleteRecord: function (id) {
			return deleteRecord(id);
		},
		unmarkPendingDelete: function (id) {
			return unmarkPendingDelete(id);
		},
		onRecordClick: function () {
			return onRecordClick.apply(null, arguments);
		},
		finalizeAssociation: function () {
			return finalizeAssociation.apply(null, arguments);
		},
		openTypeNode: function () {
			return openTypeNode.apply(null, arguments);
		},
		resolvePendingRecord: function () {
			return resolvePendingRecord.apply(null, arguments);
		},
		resolvePendingRecordToLoad: function () {
			return resolvePendingRecordToLoad.apply(null, arguments);
		},
		showCardMoreMenu: function () {
			return showCardMoreMenu.apply(null, arguments);
		},
		showRelatedPopover: function () {
			return showRelatedPopover.apply(null, arguments);
		},
		getGraph: function () {
			return graph;
		},
		getCyInstance: function () {
			return _cyInstance;
		},
		setCyInstance: function (v) {
			_cyInstance = v;
		},
		getObjectFilterHidden: function () {
			return _objectFilterHidden;
		},
		getSelectedDerivedEdge: function () {
			return _selectedDerivedEdge;
		},
		setSelectedDerivedEdge: function (v) {
			_selectedDerivedEdge = v;
		},
		getCyPendingEdge: function () {
			return _cyPendingEdge;
		},
		setCyPendingEdge: function (v) {
			_cyPendingEdge = v;
		},
		getCySchemaInstance: function () {
			return _cySchemaInstance;
		},
		getSkipNextCyAutoPan: function () {
			return _skipNextCyAutoPan;
		},
		setSkipNextCyAutoPan: function (v) {
			_skipNextCyAutoPan = v;
		},
	});
	const renderBulkCanvasCy = _rcv.renderBulkCanvasCy;

	async function startNewCanvas() {
		await platform.recovery?.discard?.();
		_clearUploadFixes();
		const previousCanvasId =
			canvasState.currentCanvas && canvasState.currentCanvas.id ? canvasState.currentCanvas.id : null;

		// Clear the old scope before changing its identity so it cannot be restored on refresh.
		_autosaveClear();
		if (previousCanvasId) {
			try {
				clearAllSessionDraftsForCanvas(previousCanvasId);
			} catch (_) {}
		}
		try {
			_presence.unsubscribe();
		} catch (_) {}

		closeRecordEditors();
		canvasState.currentCanvas = null;
		_canvasSaveState.reset();
		canvasState.currentRecordRef = null;
		canvasState.savedRecords = {};
		canvasState.diffSuppressions = {};
		canvasState.bulkZoom = 1;
		canvasState.graphZoom = 1;
		canvasState._pendingPan = null;
		canvasState._suppressNextViewTransition = false;
		canvasState._userZoomOverride = false;
		canvasState._bulkUserZoomOverride = false;
		canvasState._schemaViewObject = null;
		canvasState._schemaViewPath = [];
		canvasState._schemaViewPathEdges = [];
		canvasState._lastSchemaFocusRecId = null;
		canvasState._pendingNavOriginPos = null;
		canvasState._autoSpawnedPending = false;
		_selectedDerivedEdge = null;
		_cyPendingEdge = null;
		clearUndoHistory();
		_setStaleRefsFromLoad([]);
		exitMigrateMode();

		_canvasShareCanvasId = null;
		_canvasShareRole = null;
		canvasState._renderCanvasShareRole = null;
		_shareRecipientSubmitState = 'idle';
		if (_shareRecipientSubmitResetTimer) {
			clearTimeout(_shareRecipientSubmitResetTimer);
			_shareRecipientSubmitResetTimer = null;
		}
		document.body.classList.remove('canvas-share-banner-active', 'canvas-recipient-mode');
		const shareBanner = document.getElementById('share-recipient-banner');
		if (shareBanner) {
			shareBanner.remove();
		}

		_clearDraftCanvasId();
		_ensureDraftCanvasId();
		resetToBasePicker();
		renderOrgBanner();
		renderBulkToolbar();
		_watchProposalsForCurrentCanvas();
		showBulkToast('Started a new canvas. Your saved canvases are unchanged.');
	}

	const _csl = window.OrgLoom.canvasSaveLoad.mount({
		canSaveOrExport: _canEditCanvasStructure,
		canvasState: canvasState,
		csrfFetch: csrfFetch,
		escapeHtml: escapeHtml,
		showBulkToast: showBulkToast,
		showConfirmDialog: showConfirmDialog,
		showPromptModal: function () {
			return showPromptModal.apply(null, arguments);
		},
		_openAnchoredPopup: _openAnchoredPopup,
		_formatRelativeTime: _formatRelativeTime,
		_setStaleRefsFromLoad: _setStaleRefsFromLoad,
		_watchProposalsForCurrentCanvas: function () {
			return _watchProposalsForCurrentCanvas.apply(null, arguments);
		},
		beginCanvasReplacementLoad: beginCanvasReplacementLoad,
		applyCanvasPayload: function () {
			return applyCanvasPayload.apply(null, arguments);
		},
		buildCanvasPayload: function () {
			return buildCanvasPayload.apply(null, arguments);
		},
		ensureDraftSlotMetadata: function () {
			return ensureDraftSlotMetadata.apply(null, arguments);
		},
		downloadTemplate: function () {
			return downloadTemplate.apply(null, arguments);
		},
		openCanvasEmailLinkModal: function () {
			return openCanvasEmailLinkModal.apply(null, arguments);
		},
		pingAuditEvent: function () {
			return pingAuditEvent.apply(null, arguments);
		},
		getCurrentTeam: function () {
			return _currentTeam;
		},
		openExportCsvModal: function () {
			return openExportCsvModal.apply(null, arguments);
		},
		renderBulkView: function () {
			return renderBulkView();
		},
		previewCanvasName: function (name) {
			return renderCanvasName(name);
		},
		summarizeCanvasContent: function () {
			return _importShared.summarizeCanvasContent(canvasState);
		},
		notePresenceLocalSave: function () {
			return _presence.noteLocalSave();
		},
		getAcknowledgedContributionIds: function () {
			return _presence.acknowledgedContributionIds();
		},
		markContributionIdsSaved: function (ids) {
			return _presence.markContributionIdsSaved(ids);
		},
		rehydrateSessionDraftValues: function () {
			return rehydrateSessionDraftValues.apply(null, arguments);
		},
		onCanvasLoaded: function (data, id) {
			_canvasSaveState.captureSaved({
				savedAt: data && data.updatedAt,
			});
			announceMergedContributions(data);
			if (data && !data.ownedByMe) {
				_canvasShareCanvasId = id;
				_canvasShareRole = data.recipientRole || 'viewer';
				canvasState._renderCanvasShareRole = _canvasShareRole;
				renderShareRecipientBanner();
			} else {
				_canvasShareCanvasId = null;
				_canvasShareRole = null;
				canvasState._renderCanvasShareRole = null;
				document.body.classList.remove('canvas-share-banner-active', 'canvas-recipient-mode');
				const banner = document.getElementById('share-recipient-banner');
				if (banner) {
					banner.remove();
				}
			}
			renderOrgBanner();
			renderBulkView();
			renderBulkToolbar();
		},
		_hasCap: function (name) {
			return _hasCap(name);
		},
		isCapabilityReady: function () {
			return _capsLoaded;
		},
		refreshCapabilities: function () {
			return _loadCaps().then(() => renderBulkToolbar());
		},
		canvasSaveState: _canvasSaveState,
		clearAutosave: _autosaveClear,
		startNewCanvas: startNewCanvas,
	});
	const showSaveMenu = _csl.showSaveMenu;
	const promptCanvasSave = _csl.promptCanvasSave;
	const saveExistingCanvas = _csl.saveExistingCanvas;
	const handleCanvasVersionMismatch = _csl.handleCanvasVersionMismatch;
	const promptFileExport = _csl.promptFileExport;
	const beginMigration = _csl.beginMigration;
	const _showSavedCanvasCapDialog = _csl._showSavedCanvasCapDialog;
	const _showContentPermDeniedDialog = _csl._showContentPermDeniedDialog;
	const showTemplatesMenu = _csl.showTemplatesMenu;
	const showBrowseSavedMenu = _csl.showBrowseSavedMenu;
	_confirmSaveBeforeNavigation = _csl.confirmCanvasReplacement;

	const _csh = window.OrgLoom.canvasShare.mount({
		canvasState: canvasState,
		csrfFetch: csrfFetch,
		escapeHtml: escapeHtml,
		showBulkToast: showBulkToast,
		showConfirmDialog: showConfirmDialog,
		_hasCap: _hasCap,
		getWorkspacePlan: function () {
			if (_meInfo && _meInfo.workspace) {
				return _meInfo.workspace.plan;
			}
			return _currentTeam ? _currentTeam.plan : null;
		},
		refreshCapabilities: function () {
			return _loadCaps().then(() => renderBulkToolbar());
		},
		_invalidateShareCountForCanvas: _invalidateShareCountForCanvas,
	});
	const openCanvasEmailLinkModal = _csh.openCanvasEmailLinkModal;
	const attachSfUserPicker = _csh.attachSfUserPicker;

	const _um = window.OrgLoom.uploadModal.mount({
		updateUploadFixFields: (recordId, fields) => _ins?.updateUploadFixFields(recordId, fields),
		openRecordForCurrentUser: function (record, options) {
			try {
				const node = _cyInstance && record && _cyInstance.getElementById('r' + record.id);
				if (node && node.length) {
					_cyInstance.animate({ center: { eles: node }, duration: 380, easing: 'ease-out' });
				}
			} catch (_) {
				// A viewport animation failure must not prevent opening the record editor.
			}
			return openRecordForCurrentUser(record, options);
		},
		canvasState: canvasState,
		csrfFetch: csrfFetch,
		escapeHtml: escapeHtml,
		showBulkToast: showBulkToast,
		showConfirmDialog: showConfirmDialog,
		showBulkSwitchWarning: function () {
			return showBulkSwitchWarning.apply(null, arguments);
		},
		validateBulkRecords: validateBulkRecords,
		computeUploadOrder: computeUploadOrder,
		isRecordModified: function () {
			return isRecordModified.apply(null, arguments);
		},
		isRecordPendingDelete: function () {
			return isRecordPendingDelete.apply(null, arguments);
		},
		recordOrdinal: function () {
			return recordOrdinal.apply(null, arguments);
		},
		renderBulkView: function () {
			return renderBulkView();
		},
		startElapsedTicker: function () {
			return startElapsedTicker.apply(null, arguments);
		},
		ensureDescribe: ensureDescribe,
		getMeInfo: function () {
			return _meInfo;
		},
		publishPresenceChanges: function () {
			return _publishPresenceChanges();
		},
		flushAutosave: function () {
			platform.recovery?.uploadStateApplied?.();
			return _autosaveFlush();
		},
		pingAuditEvent: pingAuditEvent,
		markCanvasGuideUploadComplete: _completeCanvasGuide,
	});
	const openUploadModal = _um.openUploadModal;
	const closeUploadModal = _um.closeUploadModal;
	const confirmUpload = _um.confirmUpload;
	_renderUploadFixes = _um.renderUploadFixes;
	_clearUploadFixes = _um.clearUploadFixes;

	const _rr = window.OrgLoom.relatedRecords.mount({
		canvasState: canvasState,
		escapeHtml: escapeHtml,
		showBulkToast: showBulkToast,
		renderBulkView: function () {
			return renderBulkView();
		},
		openTypeNode: function () {
			return openTypeNode.apply(null, arguments);
		},
		fetchRelatedCountsBatch: fetchRelatedCountsBatch,
		_countCacheKey: _countCacheKey,
		_relatedCountCache: _relatedCountCache,
	});
	const showRelatedPopover = _rr.showRelatedPopover;
	const loadRelatedFromChip = _rr.loadRelatedFromChip;
	const seedEditModeTypeNodes = _rr.seedEditModeTypeNodes;
	const _ensureChipProbed = _rr._ensureChipProbed;
	const _relInfoForRec = _rr._relInfoForRec;
	const _isSystemChildRelationship = _rr._isSystemChildRelationship;
	const _isSystemParentField = _rr._isSystemParentField;
	const _sfIdValue = _rr._sfIdValue;
	const _sfIdMatch = _rr._sfIdMatch;

	const _tn = window.OrgLoom.typeNode.mount({
		pushUndo: pushUndo,
		canvasState: canvasState,
		csrfFetch: csrfFetch,
		refreshCapabilities: _loadCaps,
		escapeHtml: escapeHtml,
		showBulkToast: showBulkToast,
		showBulkToastWithAction: function () {
			return showBulkToastWithAction.apply(null, arguments);
		},
		_canvasCapBlockReason: _canvasCapBlockReason,
		canvasCapCheck: canvasCapCheck,
		_smoothScrollCanvas: function () {
			return _smoothScrollCanvas.apply(null, arguments);
		},
		addToSelection: addToSelection,
		inferAssociationsForRecord: function () {
			return inferAssociationsForRecord.apply(null, arguments);
		},
		purgeRedundantTypeNodes: function () {
			return purgeRedundantTypeNodes.apply(null, arguments);
		},
		renderBulkView: function () {
			return renderBulkView();
		},
		showLargeRelatedConfirm: function () {
			return showLargeRelatedConfirm.apply(null, arguments);
		},
		showRelatedSearchModal: function () {
			return showRelatedSearchModal.apply(null, arguments);
		},
		seedEditModeTypeNodes: seedEditModeTypeNodes,
		fetchRelatedCount: fetchRelatedCount,
		fetchByRefCached: fetchByRefCached,
		_countCacheKey: _countCacheKey,
		_sfIdMatch: _sfIdMatch,
		_relatedCountCache: _relatedCountCache,
		_byRefCache: _byRefCache,
		_RELATED_BULK_LOAD_CAP: _RELATED_BULK_LOAD_CAP,
		_RELATED_SOFT_THRESHOLD: _RELATED_SOFT_THRESHOLD,
		getGraph: function () {
			return graph;
		},
		getBulkRenderShiftX: function () {
			return _bulkRenderShiftX;
		},
		getBulkRenderShiftY: function () {
			return _bulkRenderShiftY;
		},
	});
	const openTypeNode = _tn.openTypeNode;
	const spawnFreeTypeNode = _tn.spawnFreeTypeNode;
	const pickRecordForFreeTypeNode = _tn.pickRecordForFreeTypeNode;
	const loadRecordIntoFreeTypeNode = _tn.loadRecordIntoFreeTypeNode;
	const openRelatedSearchFlow = _tn.openRelatedSearchFlow;

	const _ps = window.OrgLoom.pendingSpawn.mount({
		canvasState: canvasState,
		canEditCanvasStructure: _canEditCanvasStructure,
		hasCapability: _hasCap,
		showBulkToast: showBulkToast,
		pushUndo: pushUndo,
		_canvasCapBlockReason: _canvasCapBlockReason,
		addToSelection: addToSelection,
		ensureDescribe: ensureDescribe,
		cloneRecord: function () {
			return cloneRecord.apply(null, arguments);
		},
		pickRecordForFreeTypeNode: pickRecordForFreeTypeNode,
		renderBulkView: function () {
			return renderBulkView();
		},
		getGraph: function () {
			return graph;
		},
	});
	const spawnDraftRecord = _ps.spawnDraftRecord;
	const spawnPendingRecord = _ps.spawnPendingRecord;
	const resolvePendingRecord = _ps.resolvePendingRecord;
	const resolvePendingRecordToLoad = _ps.resolvePendingRecordToLoad;

	const _sm = window.OrgLoom.supportModals.mount({
		escapeHtml: escapeHtml,
		csrfFetch: csrfFetch,
		relatedHardThreshold: _RELATED_HARD_THRESHOLD,
		relatedBulkLoadCap: _RELATED_BULK_LOAD_CAP,
	});
	const showPromptModal = _sm.showPromptModal;
	const showReplaceOrMergeDialog = _sm.showReplaceOrMergeDialog;
	const showLargeRelatedConfirm = _sm.showLargeRelatedConfirm;
	const showRelatedSearchModal = _sm.showRelatedSearchModal;
	const showBulkSwitchWarning = _sm.showBulkSwitchWarning;

	const _uh = window.OrgLoom.uploadHistory.mount({
		canUseHistory: () => _canvasActionAccess().canManageCanvas,
		csrfFetch: csrfFetch,
		escapeHtml: escapeHtml,
		showBulkToast: showBulkToast,
		refreshCanvasAfterRecall: refreshCanvasAfterRecall,
		hasCapability: _hasCap,
		isCapabilityReady: function () {
			return _capsLoaded;
		},
		refreshCapabilities: function () {
			return _loadCaps().then(() => renderBulkToolbar());
		},
	});
	const showUploadHistoryModal = _uh.openModal;
	const _uh_testConfirmAndRecall = _uh._testConfirmAndRecall;

	const _treeLayout = window.OrgLoom.treeLayout.mount({
		canvasState: canvasState,
		getCyInstance: function () {
			return _cyInstance;
		},
	});
	const relayoutNewRecords = _treeLayout.relayoutNewRecords;

	const _lcsv = window.OrgLoom.linkedCsv.mount({
		beginCanvasLoad: () => _beginPresenceCanvasLoad(),
		onCanvasReplace: () => {
			clearUndoHistory();
			_clearUploadFixes();
			closeRecordEditors();
		},
		canvasState: canvasState,
		showBulkToast: showBulkToast,
		escapeHtml: escapeHtml,
		ensureDescribe: ensureDescribe,
		csrfFetch: csrfFetch,
		renderBulkView: renderBulkView,
		getGraph: function () {
			return graph;
		},
		parseCsv: parseCsv,
		csvGuessObjectFromFilename: csvGuessObjectFromFilename,
		csvAutoMapHeaders: csvAutoMapHeaders,
		csvNormalizeKey: csvNormalizeKey,
		pingAuditEvent: pingAuditEvent,
		addToSelection: addToSelection,
		showConfirmDialog: showConfirmDialog,
		showPromptModal: showPromptModal,
		showReplaceOrMergeDialog: showReplaceOrMergeDialog,
		canvasCapBlockReason: _canvasCapBlockReason,
		canvasCapCheck: canvasCapCheck,
		captureUndoSnapshot: _captureCanvasUndoSnapshot,
		showBulkToastWithAction: showBulkToastWithAction,
		allObjectsReady: _allObjectsReady,
		setSkipNextCyAutoPan: function (v) {
			_skipNextCyAutoPan = !!v;
		},
		relayoutNewRecords: relayoutNewRecords,
		clearEmptyStarterCard: clearEmptyStarterCard,
		openRecordDiffModal: openRecordDiffModal,
	});
	const openLinkedCsvModal = _lcsv.openModal;
	const closeLinkedCsvModal = _lcsv.closeModal;

	const _soql = window.OrgLoom.soqlImport.mount({
		canvasState: canvasState,
		setSelectedDerivedEdge: function (value) {
			_selectedDerivedEdge = value;
		},
		showBulkToast: showBulkToast,
		showBulkToastWithAction: showBulkToastWithAction,
		escapeHtml: escapeHtml,
		csrfFetch: csrfFetch,
		canvasCapCheck: canvasCapCheck,
		captureUndoSnapshot: _captureCanvasUndoSnapshot,
		addToSelection: addToSelection,
		renderBulkView: renderBulkView,
		getGraph: function () {
			return graph;
		},
		clearBulkUserDeleted: function () {
			canvasState._bulkUserDeleted = false;
		},
		relayoutNewRecords: relayoutNewRecords,
		setSkipNextCyAutoPan: function (v) {
			_skipNextCyAutoPan = !!v;
		},
		clearEmptyStarterCard: clearEmptyStarterCard,
	});
	const openSoqlImportModal = _soql.openModal;
	const runAndCommitSoql = _soql.runAndCommitSoql;

	const _rb = window.OrgLoom.recordBrowse.mount({
		canvasState: canvasState,
		csrfFetch: csrfFetch,
		escapeHtml: escapeHtml,
		ensureDescribe: ensureDescribe,
		showBulkToast: showBulkToast,
		showBulkToastWithAction: showBulkToastWithAction,
		canvasCapCheck: canvasCapCheck,
		captureUndoSnapshot: _captureCanvasUndoSnapshot,
		pingAuditEvent: pingAuditEvent,
		runAndCommitSoql: function (soql, opts) {
			return runAndCommitSoql(soql, opts);
		},
	});
	const openBrowseModal = _rb.openBrowseModal;

	const _tpl = window.OrgLoom.templates.mount({
		beginCanvasLoad: () => _beginPresenceCanvasLoad(),
		beginImportLoad: beginCanvasReplacementLoad,
		onCanvasReplace: () => {
			clearUndoHistory();
			_clearUploadFixes();
			closeRecordEditors();
		},
		canvasState: canvasState,
		showBulkToast: showBulkToast,
		canvasCapCheck: canvasCapCheck,
		escapeHtml: escapeHtml,
		csrfFetch: csrfFetch,
		ensureDescribe: ensureDescribe,
		addToSelection: addToSelection,
		setGraphView: setGraphView,
		renderAll: renderAll,
		showReplaceOrMergeDialog: showReplaceOrMergeDialog,
		pingAuditEvent: pingAuditEvent,
		getCanvasRecordCap: _CANVAS_RECORD_CAP_GET,
		realRecordCount: _realRecordCount,
		runSlotPreflight: _runSlotPreflight,
		clearEmptyStarterCard: clearEmptyStarterCard,
		getSlotIdSeq: function () {
			return slotIdSeq;
		},
		setSlotIdSeq: function (next) {
			slotIdSeq = next;
		},
		showBulkToastWithAction: showBulkToastWithAction,
	});
	const buildTemplate = _tpl.buildTemplate;
	const sanitizeFilename = _tpl.sanitizeFilename;
	const buildCanvasPayload = _tpl.buildCanvasPayload;
	const ensureDraftSlotMetadata = _tpl.ensureDraftSlotMetadata;
	const downloadTemplate = _tpl.downloadTemplate;
	const saveTemplateRemote = _tpl.saveTemplateRemote;
	const validateTemplate = _tpl.validateTemplate;
	const validateCanvasPayload = _tpl.validateCanvasPayload;
	const applyTemplate = _tpl.applyTemplate;
	const applyCanvasPayload = _tpl.applyCanvasPayload;
	_canvasSaveState.setPayloadProvider(() => buildCanvasPayload());

	const _sd = window.OrgLoom.sessionDrafts.mount({
		canvasState: canvasState,
		encryptedFields: window.OrgLoom.encryptedFields,
	});
	const persistSessionDraftValues = _sd.persistDraftValues;
	const rehydrateSessionDraftValues = _sd.rehydrateDraftValues;
	const clearSessionDraftValue = _sd.clearDraftValues;
	const clearAllSessionDraftsForCanvas = _sd.clearAllForCanvas;

	setInterval(() => {
		try {
			const cur = canvasState.currentCanvas;
			if (cur && cur.id) {
				persistSessionDraftValues(cur.id);
			}
		} catch (err) {
			window.ORGLOOM_capture &&
				window.ORGLOOM_capture(err, {
					where: 'app.js/draftAutoPersistTick',
				});
		}
	}, 5000);

	window.addEventListener('beforeunload', () => {
		try {
			const cur = canvasState.currentCanvas;
			if (cur && cur.id) {
				persistSessionDraftValues(cur.id);
			}
		} catch (err) {
			window.ORGLOOM_capture &&
				window.ORGLOOM_capture(err, {
					where: 'app.js/draftPersistOnUnload',
				});
		}
	});

	function _isCanvasDirty() {
		if (canvasState.currentRecordRef) {
			return true;
		}
		if (!Array.isArray(canvasState.bulkRecords)) {
			return false;
		}
		for (const r of canvasState.bulkRecords) {
			if (!r) {
				continue;
			}
			if (r.isTypeNode) {
				continue;
			}
			if (r.pendingDelete) {
				return true;
			}
			if (!r.loadedFromId) {
				return true;
			}
			try {
				if (isRecordModified(r)) {
					return true;
				}
			} catch (err) {
				window.ORGLOOM_capture &&
					window.ORGLOOM_capture(err, {
						where: 'app.js/hasUnsavedWork/isRecordModified',
					});
			}
		}
		return false;
	}

	async function _reloadCanvasFromServer() {
		const cur = canvasState.currentCanvas;
		if (!cur || !cur.id) {
			return false;
		}
		const finishCanvasLoad = beginCanvasReplacementLoad('Reloading canvas\u2026');
		try {
			const r = await csrfFetch('/api/canvas/' + encodeURIComponent(cur.id), { credentials: 'same-origin' });
			if (!r.ok) {
				return false;
			}
			const data = await r.json().catch(() => null);
			if (!data) {
				return false;
			}
			await applyCanvasPayload(data.payload || {}, {
				merge: false,
				ownedByMe: !!data.ownedByMe,
				recipientRole: data.recipientRole || null,
				canvasIdentity: {
					id: cur.id,
					title: data.title || cur.title || '',
					ownedByMe: !!data.ownedByMe,
					versionId: data.versionId || null,
					recipientRole: data.recipientRole || null,
				},
			});
			_setStaleRefsFromLoad(data.staleRefs);
			canvasState.currentCanvas = {
				id: cur.id,
				title: data.title || cur.title || '',
				ownedByMe: !!data.ownedByMe,
				versionId: data.versionId || null,
				recipientRole: data.recipientRole || null,
			};
			_canvasSaveState.captureSaved({ savedAt: data.updatedAt });
			announceMergedContributions(data);
			if (!data.ownedByMe) {
				_canvasShareCanvasId = cur.id;
				_canvasShareRole = data.recipientRole || 'viewer';
				renderShareRecipientBanner();
			}

			try {
				rehydrateSessionDraftValues(cur.id);
			} catch (err) {
				window.ORGLOOM_capture &&
					window.ORGLOOM_capture(err, {
						where: 'app.js/reloadCanvas/rehydrateSession',
					});
			}
			renderBulkView();
			renderBulkToolbar();
			return true;
		} catch (e) {
			console.warn('[presence] live-sync reload failed:', e && e.message);
			return false;
		} finally {
			finishCanvasLoad();
		}
	}
	const _presence = window.OrgLoom.presence.mount({
		canvasState: canvasState,
		csrfFetch: csrfFetch,
		escapeHtml: escapeHtml,
		getGraph: function () {
			return graph;
		},
		getCyInstance: function () {
			return _cyInstance;
		},
		isCanvasDirty: _isCanvasDirty,
		reloadCanvasFromServer: _reloadCanvasFromServer,
		showBulkToast: showBulkToast,
		renderBulkView: function () {
			return renderBulkView();
		},
		setSkipNextCyAutoPan: function (value) {
			_skipNextCyAutoPan = !!value;
		},
		addToSelection: function () {
			return addToSelection.apply(null, arguments);
		},
		buildCanvasPayload: function () {
			return buildCanvasPayload.apply(null, arguments);
		},
		applyLiveSnapshot: async function (payload) {
			const current = canvasState.currentCanvas ? Object.assign({}, canvasState.currentCanvas) : null;
			canvasState._suppressNextViewTransition = true;
			await applyCanvasPayload(payload || {}, {
				presenceSnapshot: true,
				merge: false,
				ownedByMe: current ? !!current.ownedByMe : true,
				recipientRole: current ? current.recipientRole || null : null,
				canvasIdentity: current,
			});
			canvasState.currentCanvas = current;
			renderBulkView();
			renderBulkToolbar();
		},
		onSlotUpdated: function (record) {
			if (_ins) {
				_ins.refreshCurrentRecordAccess(record);
			}
		},
		onFieldLocksChanged: function (reference, fieldName) {
			if (_ins) {
				_ins.refreshCurrentFieldLocks(reference, fieldName);
			}
		},
		onFieldValuesChanged: function (record, fields) {
			if (_ins) {
				_ins.refreshCurrentRecordValues(record, fields);
			}
		},
		onAccessChanged: function (detail) {
			const current = canvasState.currentCanvas;
			if (!current || current.ownedByMe) {
				return;
			}
			if (detail && detail.change === 'increased') {
				return;
			}
			const role = detail && detail.role ? detail.role : 'viewer';
			current.recipientRole = role;
			_canvasShareRole = role;
			canvasState._renderCanvasShareRole = role;
			if (detail && (detail.revoked || detail.change === 'decreased')) {
				_clearUploadFixes();
				closeRecordEditors();
				canvasState.bulkSelectedIds.clear();
				canvasState.bulkSelectedEdgeId = null;
			}
			if (detail && detail.revoked) {
				_autosaveClear();
				canvasState.bulkRecords = [];
				canvasState.bulkAssociations = [];
				canvasState.currentCanvas = null;
				_canvasShareCanvasId = null;
				_canvasShareRole = null;
				canvasState._renderCanvasShareRole = null;
				_presence.unsubscribe();
			}
			renderShareRecipientBanner();
			renderBulkView();
			renderBulkToolbar();
		},
	});
	_publishPresenceLayout = _presence.publishLayout;
	_beginPresenceCanvasLoad = _presence.beginCanvasLoad;
	_publishPresenceChanges = _presence.publishChanges;
	const pushPresenceFocus = _presence.pushFocus;

	const _aip = window.OrgLoom.aiProposals.mount({
		canvasState: canvasState,
		csrfFetch: csrfFetch,
		escapeHtml: escapeHtml,
		showBulkToast: showBulkToast,
		canvasCapCheck: canvasCapCheck,
		showConfirmDialog: showConfirmDialog,
		addToSelection: addToSelection,
		bulkAutoFill: bulkAutoFill,
		ensureDescribe: ensureDescribe,
		renderBulkView: renderBulkView,
		pushUndo: pushUndo,
	});
	const _proposalsPollCanvasId = _aip.getPollCanvasId;
	const _openProposalsReview = _aip.openProposalsReview;
	const _refreshProposals = _aip.refreshProposals;
	const _watchProposalsForCurrentCanvas = _aip.watchProposalsForCurrentCanvas;

	if (window.OrgLoom.aiClarifications) {
		window.OrgLoom.aiClarifications.mount({
			canvasState: canvasState,
			csrfFetch: csrfFetch,
			escapeHtml: escapeHtml,
			showBulkToast: showBulkToast,
		});
	}

	const _bem = window.OrgLoom.bulkEditModal.mount({
		canvasState: canvasState,
		csrfFetch: csrfFetch,
		ensureDescribe: ensureDescribe,
		escapeHtml: escapeHtml,
		renderBulkView: renderBulkView,
		showBulkToast: showBulkToast,
		showBulkToastWithAction: showBulkToastWithAction,
		refreshCapabilities: function () {
			return _loadCaps().then(() => renderBulkToolbar());
		},
	});
	const openBulkEditModal = _bem.openModal;

	_ins = window.OrgLoom.insertModal.mountMultiple({
		pushUndo: pushUndo,
		onFieldsUndone: (record, fields) => _ins.refreshCurrentRecordValues(record, fields),
		canvasState: canvasState,
		csrfFetch: csrfFetch,
		escapeHtml: escapeHtml,
		ensureDescribe: ensureDescribe,
		ensureRules: ensureRules,
		showBulkToast: showBulkToast,
		changedFieldNames: changedFieldNames,
		isRecordModified: isRecordModified,
		deleteAssociation: deleteAssociation,
		renderChips: renderChips,
		renderBulkView: renderBulkView,
		getCanvasShareRole: function () {
			return _getCanvasShareRole();
		},
		_slotProgress: _slotProgress,
		_slotProgressClass: _slotProgressClass,
		recordOrdinal: recordOrdinal,
		_slotAssignmentState: _slotAssignmentState,
		markPendingDelete: markPendingDelete,
		canDeleteRecord: function (record) {
			if (
				record &&
				record.loadedFromId &&
				record._recordAccess &&
				record._recordAccess.checked === true &&
				record._recordAccess.hasDeleteAccess === false
			) {
				return false;
			}
			const describe = record && record.objectName && canvasState.describeCache[record.objectName];
			return !!(describe && describe.deletable === true);
		},
		unmarkPendingDelete: unmarkPendingDelete,
		showConfirmDialog: showConfirmDialog,
		pushPresenceFocus: pushPresenceFocus,
		publishPresenceLayout: function (records) {
			return _publishPresenceLayout(records);
		},
		fieldLockFor: _presence.fieldLockFor,
		acquireFieldLock: _presence.acquireFieldLock,
		commitRecordFields: _presence.commitRecordFields,
		releaseFieldLock: _presence.releaseFieldLock,
		releaseRecordFieldLocks: _presence.releaseRecordFieldLocks,
		configureRequest: function (record) {
			return configureExistingSlot(record);
		},

		getCyInstance: function () {
			return _cyInstance;
		},
		getCyContainer: function () {
			return _cyInstance && typeof _cyInstance.container === 'function' ? _cyInstance.container() : null;
		},
		getCyPendingEdge: function () {
			return _cyPendingEdge;
		},
	});
	const openInsertModal = _ins.openInsertModal;
	const closeModal = _ins.closeModal;
	const showModalToast = _ins.showModalToast;
	const _prefetchLayoutForRecord = _ins._prefetchLayoutForRecord;
	const tryParseRule = _ins.tryParseRule;
	const tryFixValidationRules = _ins.tryFixValidationRules;
	const fieldTypeFilter = _ins.fieldTypeFilter;
	const sampleValueForField = _ins.sampleValueForField;

	const _sharedTasks = window.OrgLoom.sharedTaskSidebar.mount({
		canvasState: canvasState,
		escapeHtml: escapeHtml,
		getCanvasShareRole: function () {
			return _getCanvasShareRole();
		},
		getCyInstance: function () {
			return _cyInstance;
		},
		openInsertModal: function () {
			const objectName = arguments[0];
			const options = arguments[1] || {};
			return options.record
				? openRecordForCurrentUser(options.record, { focusField: options.focusField })
				: openInsertModal(objectName, options);
		},
		slotAssignmentState: _slotAssignmentState,
		slotProgress: _slotProgress,
		slotPreflightWarn: _slotPreflightWarn,
	});
	_renderSharedTaskSidebar = _sharedTasks.render;

	function startElapsedTicker(el) {
		if (!el) {
			return () => {};
		}
		const t0 = Date.now();
		const fmt = (ms) => {
			const s = Math.floor(ms / 1000);
			const m = Math.floor(s / 60);
			return m + ':' + String(s % 60).padStart(2, '0');
		};
		el.textContent = '0:00';
		const id = setInterval(() => {
			el.textContent = fmt(Date.now() - t0);
		}, 500);
		return () => clearInterval(id);
	}

	try {
		Object.defineProperty(window, '__orgloom', {
			value: Object.freeze({
				get bulkRecords() {
					return canvasState.bulkRecords;
				},
				get bulkAssociations() {
					return canvasState.bulkAssociations;
				},
				get selectedObjects() {
					return canvasState.selectedObjects;
				},
				get describeCache() {
					return canvasState.describeCache;
				},
				get linkedCsvState() {
					return linkedCsvState;
				},
			}),
			writable: false,
			configurable: true,
		});
	} catch (e) {}

	const _migrationResumed = _migrationResume ? _migrationResume() : false;
	if (_migrationResumed) {
		const _migrationGuideReady = enterMigrateMode({
			sourceSfOrgId: _migrationResumed.sourceSfOrgId || null,
			targetSfOrgId: _migrationResumed.targetSfOrgId || window.SF_ORG_ID || null,
			preparation: _migrationResumed.preparation || null,
		});
		if (_migrationResumed.justArrived) {
			Promise.resolve(_migrationGuideReady).then(() => {
				setTimeout(() => {
					if (
						canvasState.migrateMode.active &&
						window.Orgloom.migrateMatch &&
						window.Orgloom.migrateMatch.open
					) {
						window.Orgloom.migrateMatch.open({ autoOpened: true });
					}
				}, 0);
			});
		}
		const _msg = _migrationResumed.justArrived
			? 'Migration canvas restored - review and apply the migration, then upload when ready.'
			: 'Resumed your in-progress migration.';
		if (typeof showBulkToastWithAction === 'function') {
			showBulkToastWithAction(
				_msg,
				'Discard migration',
				function () {
					try {
						if (
							window.Orgloom &&
							window.Orgloom.canvasOrgSwitch &&
							window.Orgloom.canvasOrgSwitch.migrationClear
						) {
							window.Orgloom.canvasOrgSwitch.migrationClear();
						}
						exitMigrateMode();
						if (typeof window.olToast === 'function') {
							window.olToast('Migration discarded. The canvas stays as-is.', 'info');
						}
					} catch (_e) {}
				},
				'info',
			);
		} else if (typeof window.olToast === 'function') {
			window.olToast(_msg, 'info');
		}
	}
	const _orgSwitchRestored =
		!_migrationResumed && window.Orgloom && window.Orgloom.canvasOrgSwitch && window.Orgloom.canvasOrgSwitch.restore
			? window.Orgloom.canvasOrgSwitch.restore()
			: false;
	const _restored = _migrationResumed || _orgSwitchRestored || _autosaveRestore();
	if (_restored) {
		_canvasSaveState.markRestored();
	}
	if (
		_restored &&
		canvasState.currentCanvas &&
		canvasState.currentCanvas.id &&
		!canvasState.currentCanvas.ownedByMe
	) {
		_canvasShareCanvasId = canvasState.currentCanvas.id;
		_canvasShareRole = canvasState.currentCanvas.recipientRole || 'viewer';
		canvasState._renderCanvasShareRole = _canvasShareRole;
		renderShareRecipientBanner();
	}
	if (
		_restored &&
		!_migrationResumed &&
		!_orgSwitchRestored &&
		!_hasCanvasLaunchRequest &&
		typeof window.olToast === 'function'
	) {
		window.olToast('Restored your unsaved canvas from this tab.', 'info');
	}

	renderStepper();
	renderAll();

	document.addEventListener('click', (e) => {
		const trigger = e.target && e.target.closest && e.target.closest('[data-app-history]');
		if (!trigger) {
			return;
		}
		e.preventDefault();
		showUploadHistoryModal();
	});

	document.addEventListener('click', (e) => {
		const trigger = e.target && e.target.closest && e.target.closest('[data-app-canvases]');
		if (!trigger) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		showBrowseSavedMenu(trigger);
	});
	// The host owns durable recovery; the canvas owns serialization and rendering.
	// Nothing in an imported file can register or replace this integration.
	platform.recovery?.mount?.({
		ready: _allObjectsReady,
		snapshot: () => {
			window.Orgloom.canvasState.getCurrentCanvas();
			return window.Orgloom.canvasState.snapshot();
		},
		busy: () => _canvasReplacementLoads > 0 || canvasState.migrateMode.active,
		readOnly: () => canvasState.currentCanvas?.recipientRole === 'viewer',
		restore: async (data, options = {}) => {
			const current = data.id
				? {
						id: data.id,
						title: data.title,
						ownedByMe: !!data.ownedByMe,
						versionId: data.versionId,
						recipientRole: data.recipientRole || null,
					}
				: null;
			await applyCanvasPayload(data.payload, {
				presenceSnapshot: true,
				merge: false,
				canvasIdentity: current,
				ownedByMe: current ? current.ownedByMe : true,
				recipientRole: current?.recipientRole || null,
			});
			canvasState.currentCanvas = current;
			_canvasShareCanvasId = current && !current.ownedByMe ? current.id : null;
			_canvasShareRole = current?.recipientRole || null;
			canvasState._renderCanvasShareRole = _canvasShareRole;
			if (options.saved) _canvasSaveState.captureSaved();
			else _canvasSaveState.markRestored();
			renderShareRecipientBanner();
			renderBulkView();
			renderBulkToolbar();
		},
		confirm: (options) => showConfirmDialog(options),
		toast: showBulkToast,
	});
	platform.clipboard?.mount?.({
		canvasState,
		canEdit: canCommitLocalChanges,
		commit: _soql.commitRecords,
		render: renderBulkView,
		toast: showBulkToast,
		graph: () => graph,
		canvas: () => canvasState.currentCanvas,
		copyCards: copySelectionToClipboard,
		pasteCards: () => pasteFromClipboard(1),
	});
})();

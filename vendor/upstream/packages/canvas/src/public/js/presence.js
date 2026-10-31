(function () {
	'use strict';
	// Synchronizes ephemeral collaborator state; persisted canvas data still flows through save/load.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.presence = {
		mount: function mount(deps) {
			const _required = [
				'canvasState',
				'csrfFetch',
				'escapeHtml',
				'getGraph',
				'getCyInstance',
				'isCanvasDirty',
				'reloadCanvasFromServer',
				'showBulkToast',
				'renderBulkView',
				'addToSelection',
				'buildCanvasPayload',
				'applyLiveSnapshot',
			];
			for (const k of _required) {
				if (deps == null || deps[k] == null) {
					throw new Error('presence.mount: missing required dep: ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			const getGraph = deps.getGraph;
			const getCyInstance = deps.getCyInstance;
			const isCanvasDirty = deps.isCanvasDirty;
			const reloadCanvasFromServer = deps.reloadCanvasFromServer;
			const showBulkToast = deps.showBulkToast;
			const renderBulkView = deps.renderBulkView;
			const addToSelection = deps.addToSelection;
			const buildCanvasPayload = deps.buildCanvasPayload;
			const applyLiveSnapshot = deps.applyLiveSnapshot;
			const encryptedFields = window.OrgLoom && window.OrgLoom.encryptedFields;
			if (!encryptedFields) {
				throw new Error('encrypted-fields.js must load before presence.js');
			}
			const onAccessChanged = typeof deps.onAccessChanged === 'function' ? deps.onAccessChanged : function () {};
			const onSlotUpdated = typeof deps.onSlotUpdated === 'function' ? deps.onSlotUpdated : function () {};
			const onFieldLocksChanged =
				typeof deps.onFieldLocksChanged === 'function' ? deps.onFieldLocksChanged : function () {};
			const onFieldValuesChanged =
				typeof deps.onFieldValuesChanged === 'function' ? deps.onFieldValuesChanged : function () {};
			const setSkipNextCyAutoPan =
				typeof deps.setSkipNextCyAutoPan === 'function' ? deps.setSkipNextCyAutoPan : function () {};

			let _eventSource = null;
			let _myConnectionId = null;
			let _connectionHealthy = false;
			let _presenceReadyWaiters = [];
			let _currentCanvasId = null;
			let _outboundSequence = 0;
			let _localCanEdit = true;
			let _localRole = null;
			let _localAccessRevoked = false;
			let _latestAppliedRevision = 0;
			let _durableRevision = 0;
			let _serverRevision = 0;
			let _hasRevisionGap = false;
			let _serverInstanceId = null;
			let _recoverOwnerStateAfterSnapshot = false;
			let _resumeCanvasRevision = null;
			let _resumeCanvasWasDirty = false;
			const _fieldLocks = new Map();
			const _ownedFieldLeases = new Map();
			const _acknowledgedContributionIds = new Set();
			let _acknowledgedContributionCanvasId = null;
			let _snapshotApplyPromise = null;
			let _applyingSnapshot = false;
			let _subscriptionGeneration = 0;
			let _canvasLoadDepth = 0;
			let _canvasLoadFailed = false;
			let _canvasLoadReady = null;
			let _awaitingLayoutSnapshot = false;
			const _queuedSnapshotEvents = [];
			// Monotonic per-connection sequence numbers let the server reject stale collaboration events.
			function _nextSequence() {
				_outboundSequence += 1;
				return _outboundSequence;
			}
			function _observeRevision(value) {
				if (!Number.isSafeInteger(value) || value < 0) {
					return;
				}
				if (_latestAppliedRevision > 0 && value > _latestAppliedRevision + 1) {
					_hasRevisionGap = true;
				}
				_latestAppliedRevision = Math.max(_latestAppliedRevision, value);
				_serverRevision = Math.max(_serverRevision, value);
				if (_currentCanvasId) {
					canvasState._presenceCanvasId = _currentCanvasId;
					canvasState._presenceRevision = _latestAppliedRevision;
				}
			}
			function _fieldLockKey(reference, fieldName) {
				if (!reference || reference.ref == null || !fieldName) {
					return null;
				}
				return JSON.stringify([
					reference.refKind,
					String(reference.ref),
					reference.collabRef == null ? null : String(reference.collabRef),
					String(fieldName),
				]);
			}
			function _rememberFieldLock(lock) {
				if (!lock || !lock.targetRef || !lock.fieldName) {
					return;
				}
				const key = _fieldLockKey(lock.targetRef, lock.fieldName);
				if (!key) {
					return;
				}
				_fieldLocks.set(key, lock);
				if (lock.connectionId === _myConnectionId) {
					_ownedFieldLeases.set(key, lock);
				} else {
					_ownedFieldLeases.delete(key);
				}
			}
			function _canonicalSnapshot(value, isRoot, depth) {
				depth = depth || 0;
				if (depth > 64) {
					throw new Error('canvas snapshot exceeds the supported nesting depth');
				}
				if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
					return undefined;
				}
				if (value === null || typeof value === 'string' || typeof value === 'boolean') {
					return value;
				}
				if (typeof value === 'number') {
					return Number.isFinite(value) ? value : null;
				}
				if (Array.isArray(value)) {
					return value.map((item) => {
						const normalized = _canonicalSnapshot(item, false, depth + 1);
						return normalized === undefined ? null : normalized;
					});
				}
				if (typeof value === 'object') {
					const out = {};
					Object.keys(value)
						.sort()
						.forEach((key) => {
							if (isRoot && key === '_meta') {
								return;
							}
							const normalized = _canonicalSnapshot(value[key], false, depth + 1);
							if (normalized !== undefined) {
								out[key] = normalized;
							}
						});
					return out;
				}
				return undefined;
			}
			async function _currentSnapshotHash() {
				try {
					if (
						!window.crypto ||
						!window.crypto.subtle ||
						typeof window.crypto.subtle.digest !== 'function' ||
						typeof TextEncoder === 'undefined'
					) {
						return null;
					}
					const payload = buildCanvasPayload();
					const canonical = JSON.stringify(_canonicalSnapshot(payload || {}, true, 0));
					const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
					return Array.from(new Uint8Array(digest))
						.map((byte) => byte.toString(16).padStart(2, '0'))
						.join('');
				} catch (_) {
					return null;
				}
			}
			const _mutationInFlight = new Map();
			const _mutationQueue = [];
			let _activeMutation = null;
			const _mutationRetry = new Map();
			const _failedMutationKeys = new Set();
			let _mutationFailureCount = 0;
			let _syncWarningShown = false;
			let _mutationGeneration = 0;
			const MUTATION_RETRY_MAX_MS = 30_000;

			function _mutationCanSend(key) {
				if (_canvasLoadDepth || _canvasLoadFailed || _applyingSnapshot || _awaitingLayoutSnapshot) return false;
				if (_mutationInFlight.has(key)) {
					return false;
				}
				const retry = _mutationRetry.get(key);
				return !retry || Date.now() >= retry.nextAt;
			}

			function _mutationFailure(key) {
				const previous = _mutationRetry.get(key);
				const attempts = (previous ? previous.attempts : 0) + 1;
				const delay = Math.min(MUTATION_RETRY_MAX_MS, 1000 * Math.pow(2, attempts - 1));
				_mutationRetry.set(key, { attempts, nextAt: Date.now() + delay });
				_failedMutationKeys.add(key);
				_mutationFailureCount += 1;
				if (_mutationFailureCount >= 3 && !_syncWarningShown) {
					_syncWarningShown = true;
					showBulkToast(
						'Some changes have not synced yet. Your changes remain on this canvas, but collaborators may not see them yet. Org Loom will keep retrying.',
						'error',
					);
				}
			}

			function _mutationAccepted(key) {
				_mutationRetry.delete(key);
				_failedMutationKeys.delete(key);
				if (_failedMutationKeys.size > 0) {
					return;
				}
				_mutationFailureCount = 0;
				if (_syncWarningShown) {
					_syncWarningShown = false;
					showBulkToast('Previously delayed changes have synced.', 'info');
				}
			}

			function _forgetObsoleteMutation(key) {
				_mutationRetry.delete(key);
				_failedMutationKeys.delete(key);
				if (_failedMutationKeys.size === 0) {
					_mutationFailureCount = 0;
					// Obsolete work was discarded, not successfully synchronized.
					_syncWarningShown = false;
				}
			}

			function _resetMutationTracking() {
				_mutationGeneration += 1;
				_mutationInFlight.clear();
				_mutationQueue.length = 0;
				_activeMutation = null;
				_mutationRetry.clear();
				_failedMutationKeys.clear();
				_mutationFailureCount = 0;
				_syncWarningShown = false;
			}

			function _sendDesiredMutation(key, requestFactory, onAccepted) {
				if (!_mutationCanSend(key)) {
					return false;
				}
				const token = { generation: _mutationGeneration };
				_mutationInFlight.set(key, token);
				_mutationQueue.push({ key, token, requestFactory, onAccepted });
				_drainMutationQueue();
				return true;
			}

			function _drainMutationQueue() {
				if (_activeMutation || _mutationQueue.length === 0) {
					return;
				}
				// Assign sequence numbers when sending, not when queued. Only one
				// structural request may be in flight so independent HTTP requests
				// cannot overtake each other at the server.
				const { key, token, requestFactory, onAccepted } = _mutationQueue.shift();
				_activeMutation = token;
				function finished() {
					if (_mutationInFlight.get(key) === token) {
						_mutationInFlight.delete(key);
					}
					if (_activeMutation === token) {
						_activeMutation = null;
						_drainMutationQueue();
					}
					if (key !== 'layout' && token.generation === _mutationGeneration) {
						_flushPendingLayouts();
					}
				}
				let request;
				try {
					request = requestFactory();
				} catch (_error) {
					_mutationFailure(key);
					finished();
					return;
				}
				// A queued desired state can become obsolete before dispatch.
				if (request === null) {
					finished();
					return;
				}
				Promise.resolve(request)
					.then(async (response) => {
						if (!response || response.ok === false) {
							throw new Error('live mutation was not accepted');
						}
						let data = null;
						const readable = response && typeof response.clone === 'function' ? response.clone() : response;
						if (readable && typeof readable.json === 'function') {
							data = await readable.json().catch(() => null);
						}
						if (token.generation !== _mutationGeneration) {
							return;
						}
						_observeRevision(data && data.revision);
						onAccepted(data);
						_mutationAccepted(key);
					})
					.catch(() => {
						if (token.generation === _mutationGeneration) {
							_mutationFailure(key);
						}
					})
					.finally(finished);
			}
			const _peers = new Map();
			const _shareCounts = new Map();

			let _cursorLayer = null;
			let _cursorHost = null;
			let _mouseTrackingHost = null;
			let _presenceChips = null;

			let _lastCursorPostAt = 0;
			const CURSOR_THROTTLE_MS = 100;
			let _cursorRequest = null;
			let _pendingCursorPosition = null;
			let _cursorSendTimer = null;
			let _cursorPublished = false;
			let _hasLocalFocus = false;
			let _lastLocalFocus = null;

			function _savedCanvasId(value) {
				const id = String(value || '');
				return /^[a-zA-Z0-9]{15,18}$/.test(id) ? id : null;
			}

			function _resolveCanvasId() {
				if (canvasState.currentCanvas && canvasState.currentCanvas.id) {
					const current = canvasState.currentCanvas;
					if (current.ownedByMe && !(_shareCounts.get(current.id) > 0)) {
						return null;
					}
					return _savedCanvasId(current.id);
				}
				const cs = window.Orgloom && window.Orgloom.canvasState;
				if (cs && typeof cs.getCurrentCanvas === 'function') {
					const c = cs.getCurrentCanvas();
					return _savedCanvasId(c && c.canvasId);
				}
				return null;
			}

			window.addEventListener('orgloom:canvas-share-count', (event) => {
				const detail = event.detail || {};
				if (!detail.canvasId) {
					return;
				}
				_shareCounts.set(detail.canvasId, Number(detail.count) || 0);
				if (detail.count > 0) {
					subscribeToCanvas(detail.canvasId);
				} else if (_currentCanvasId === detail.canvasId) {
					unsubscribe();
				}
			});

			function _canvasHost() {
				const graph = getGraph();
				return graph && graph.querySelector
					? graph.querySelector('#graph-bulk') || graph.querySelector('#bulk-canvas')
					: null;
			}

			function _ensureCursorLayer() {
				const host = _canvasHost();
				if (!host) {
					return null;
				}
				if (_cursorLayer && _cursorHost === host && _cursorLayer.parentNode === host) {
					return _cursorLayer;
				}
				if (_cursorLayer && typeof _cursorLayer.remove === 'function') {
					_cursorLayer.remove();
				}
				_cursorLayer = document.createElement('div');
				_cursorLayer.className = 'presence-cursor-layer';
				_cursorLayer.setAttribute('aria-hidden', 'true');
				host.appendChild(_cursorLayer);
				_cursorHost = host;
				return _cursorLayer;
			}

			function _ensurePresenceChips() {
				if (_presenceChips) {
					return _presenceChips;
				}
				_presenceChips = document.createElement('div');
				_presenceChips.className = 'presence-chip-strip';
				const strip = document.getElementById('canvas-status-strip');
				if (strip) {
					strip.appendChild(_presenceChips);
				} else {
					_presenceChips.classList.add('presence-chip-strip--detached');
					document.body.appendChild(_presenceChips);
				}
				return _presenceChips;
			}

			function _initials(name) {
				if (!name) {
					return '?';
				}
				const parts = String(name).trim().split(/\s+/);
				if (parts.length >= 2) {
					return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
				}
				return (parts[0][0] || '?').toUpperCase();
			}

			function _renderCursor(peer) {
				const layer = _ensureCursorLayer();
				if (!layer) {
					return;
				}
				let el = layer.querySelector('[data-conn="' + peer.connectionId + '"]');
				if (!peer.cursor) {
					if (el) {
						el.remove();
					}
					return;
				}
				if (!el) {
					el = document.createElement('div');
					el.className = 'presence-cursor';
					el.setAttribute('data-conn', peer.connectionId);
					el.innerHTML =
						'<svg width="18" height="22" viewBox="0 0 18 22" aria-hidden="true">' +
						'<path d="M2 2 L16 11 L9 12 L6 19 Z" fill="currentColor" stroke="white" stroke-width="1.2" stroke-linejoin="round"/>' +
						'</svg>' +
						'<span class="presence-cursor-label"></span>';
					layer.appendChild(el);
				}
				el.style.color = peer.color;
				let localX, localY;
				if (peer.cursor.world) {
					const local = _worldToLayerLocal(peer.cursor.x, peer.cursor.y);
					if (local) {
						localX = local.x;
						localY = local.y;
					} else {
						el.style.display = 'none';
						return;
					}
				} else {
					const layerRect = layer.getBoundingClientRect();
					localX = peer.cursor.x - layerRect.left;
					localY = peer.cursor.y - layerRect.top;
				}
				el.style.display = '';
				el.style.transform = 'translate(' + localX + 'px, ' + localY + 'px)';
				const label = el.querySelector('.presence-cursor-label');
				if (label) {
					label.textContent = peer.displayName;
					label.style.backgroundColor = peer.color;
				}
			}

			function _positionChipStrip() {}

			function _renderChips() {
				const strip = _ensurePresenceChips();
				if (!strip) {
					return;
				}
				const peersArr = Array.from(_peers.values());
				if (peersArr.length === 0) {
					strip.innerHTML = '';
					strip.style.display = 'none';
					return;
				}
				strip.style.display = '';
				strip.innerHTML = peersArr
					.map(
						(p) =>
							'<span class="presence-chip" title="' +
							escapeHtml(p.displayName) +
							' is on this canvas" style="background:' +
							p.color +
							'">' +
							escapeHtml(_initials(p.displayName)) +
							'</span>',
					)
					.join('');
				_positionChipStrip();
			}

			function _clearPeerVisuals() {
				for (const connectionId of _peers.keys()) {
					if (_cursorLayer) {
						const cursor = _cursorLayer.querySelector('[data-conn="' + connectionId + '"]');
						if (cursor) {
							cursor.remove();
						}
					}
					_clearPeerFocus(connectionId);
				}
			}

			function _onPresenceInit(data) {
				_resetCursorPublishing();
				const nextServerInstanceId =
					typeof data.serverInstanceId === 'string' && data.serverInstanceId ? data.serverInstanceId : null;
				const serverRestarted = !!(
					_serverInstanceId &&
					nextServerInstanceId &&
					_serverInstanceId !== nextServerInstanceId
				);
				_serverInstanceId = nextServerInstanceId || _serverInstanceId;
				_myConnectionId = data.you && data.you.connectionId;
				_connectionHealthy = !!_myConnectionId;
				const readyWaiters = _presenceReadyWaiters;
				_presenceReadyWaiters = [];
				readyWaiters.forEach((resolve) => resolve(_connectionHealthy));
				_localCanEdit = !(data.you && data.you.canEdit === false);
				_localRole = (data.you && data.you.role) || (_localCanEdit ? 'editor' : 'viewer');
				_recoverOwnerStateAfterSnapshot = serverRestarted && _localRole === 'owner';
				_localAccessRevoked = false;
				_durableRevision = Number.isSafeInteger(data.durableRevision) ? data.durableRevision : 0;
				_latestAppliedRevision = _durableRevision;
				_serverRevision = Number.isSafeInteger(data.revision) ? data.revision : _durableRevision;
				_hasRevisionGap = _serverRevision > _durableRevision;
				_awaitingLayoutSnapshot = !!data.hasLiveSnapshot;
				_seedLoadedRecordBaselines();
				_clearPeerVisuals();
				_peers.clear();
				_fieldLocks.clear();
				_ownedFieldLeases.clear();
				(Array.isArray(data.fieldLocks) ? data.fieldLocks : []).forEach(_rememberFieldLock);
				if (Array.isArray(data.peers)) {
					for (const p of data.peers) {
						_peers.set(p.connectionId, p);
						if (p.cursor) {
							_renderCursor(p);
						}
						if (p.focus) {
							_renderPeerFocus(p);
						}
					}
				}
				_renderChips();
				onFieldLocksChanged();
				_publishLocalFocus();
				_flushPendingLayouts();
			}

			async function _applyLiveSnapshotEvent(data) {
				const generation = _subscriptionGeneration;
				// Discard queued intentions based on the old snapshot before rebuilding records.
				_resetMutationTracking();
				_applyingSnapshot = true;
				try {
					const serverPayload = data.payload || {};
					const recoverOwnerState = _recoverOwnerStateAfterSnapshot && _localRole === 'owner';
					const snapshotRevision = Number.isSafeInteger(data.revision) ? data.revision : _serverRevision;
					const durableRevision = Number.isSafeInteger(data.durableRevision)
						? data.durableRevision
						: _durableRevision;
					const legacyDirtySnapshotIsCurrent =
						_localRole === 'owner' &&
						!Number.isSafeInteger(_resumeCanvasRevision) &&
						_resumeCanvasWasDirty &&
						snapshotRevision <= durableRevision;
					const serverHasUnsavedChanges = snapshotRevision > durableRevision;
					const resumeLocalState =
						_localRole === 'owner' &&
						!serverHasUnsavedChanges &&
						(recoverOwnerState ||
							(_resumeCanvasWasDirty &&
								Number.isSafeInteger(_resumeCanvasRevision) &&
								_resumeCanvasRevision >= snapshotRevision) ||
							legacyDirtySnapshotIsCurrent);
					let nextPayload = serverPayload;
					if (resumeLocalState) {
						try {
							nextPayload = buildCanvasPayload();
						} catch (_) {}
					}
					setSkipNextCyAutoPan(true);
					await applyLiveSnapshot(nextPayload, {
						revision: data.revision,
						durableRevision: data.durableRevision,
					});
					if (generation !== _subscriptionGeneration) return;
					_applyingSnapshot = false;
					_recoverOwnerStateAfterSnapshot = false;
					_durableRevision = Number.isSafeInteger(data.durableRevision)
						? data.durableRevision
						: _durableRevision;
					_latestAppliedRevision = Number.isSafeInteger(data.revision)
						? data.revision
						: _latestAppliedRevision;
					_serverRevision = Math.max(_serverRevision, _latestAppliedRevision);
					_hasRevisionGap = false;
					_resumeCanvasRevision = null;
					_resumeCanvasWasDirty = false;
					canvasState._presenceCanvasId = _currentCanvasId;
					canvasState._presenceRevision = _latestAppliedRevision;
					_awaitingLayoutSnapshot = false;
					if (resumeLocalState && nextPayload !== serverPayload) {
						_seedMutationTrackingFromSnapshot(serverPayload);
						_broadcastDraftDeltas();
						publishLayout(canvasState.bulkRecords);
					} else {
						// The authoritative snapshot replaces local layout intentions.
						_pendingLayoutPositions.clear();
						_forgetObsoleteMutation('layout');
						_seedLoadedRecordBaselines();
					}
					_flushPendingDraftLinks();
					_reapplyAllFocus();
				} catch (error) {
					if (generation !== _subscriptionGeneration) return;
					_hasRevisionGap = true;
					_awaitingLayoutSnapshot = true;
					window.ORGLOOM_capture && window.ORGLOOM_capture(error, { where: 'presence.js/applyLiveSnapshot' });
					try {
						showBulkToast(
							'Current live changes could not be synchronized. Reload the canvas before editing.',
							'error',
						);
					} catch (_) {}
				} finally {
					if (generation === _subscriptionGeneration) {
						_applyingSnapshot = false;
						_snapshotApplyPromise = null;
						const queued = _queuedSnapshotEvents.splice(0);
						queued.sort((left, right) => (left.revision || 0) - (right.revision || 0));
						for (const event of queued) {
							await _onPresenceEvent(event);
						}
						_flushPendingLayouts();
					}
				}
			}

			async function _onPresenceEvent(data) {
				if (!data || !data.type) {
					return;
				}
				if (_snapshotApplyPromise) {
					_queuedSnapshotEvents.push(data);
					return;
				}
				if (data.type === 'live-snapshot') {
					_snapshotApplyPromise = _applyLiveSnapshotEvent(data);
					await _snapshotApplyPromise;
					return;
				}
				if (data.type === 'live-snapshot-unavailable') {
					_hasRevisionGap = true;
					try {
						showBulkToast(
							'Current live changes could not be synchronized. Reload the canvas before editing.',
							'error',
						);
					} catch (_) {}
					return;
				}
				if (data.type === 'canvas-saved') {
					_onCanvasSaved(data);
					return;
				}
				if (data.type === 'access-changed') {
					_onAccessChanged(data);
					return;
				}
				if (data.type === 'field-lock') {
					const reference = data.lock ? data.lock.targetRef : data.targetRef;
					const fieldName = data.lock ? data.lock.fieldName : data.fieldName;
					const key = _fieldLockKey(reference, fieldName);
					if (key) {
						if (data.lock) {
							_rememberFieldLock(data.lock);
						} else {
							_fieldLocks.delete(key);
							_ownedFieldLeases.delete(key);
						}
						onFieldLocksChanged(reference, fieldName, data.lock || null);
					}
					return;
				}
				if (data.type === 'field-update') {
					_observeRevision(data.revision);
					_applyPeerFieldUpdate(data);
					return;
				}
				if (data.type === 'hidden-record') {
					_observeRevision(data.revision);
					_applyPeerHiddenRecord(data);
					return;
				}
				if (data.type === 'draft-update') {
					_observeRevision(data.revision);
					_applyPeerDraftUpdate(data);
					return;
				}
				if (data.type === 'loaded-record') {
					_observeRevision(data.revision);
					_applyPeerLoadedRecord(data);
					return;
				}
				if (data.type === 'loaded-removed') {
					_observeRevision(data.revision);
					_applyPeerLoadedRemoved(data);
					return;
				}
				if (data.type === 'slot-update') {
					_observeRevision(data.revision);
					_applyPeerSlotUpdate(data);
					return;
				}
				if (data.type === 'draft-link') {
					_observeRevision(data.revision);
					_applyPeerDraftLink(data);
					return;
				}
				if (data.type === 'record-layout') {
					_observeRevision(data.revision);
					_applyPeerLayout(data);
					return;
				}
				if (data.type === 'join' && data.peer) {
					const wasAlone = _peers.size === 0;
					_peers.set(data.peer.connectionId, data.peer);
					_renderChips();
					if (wasAlone) {
						_publishLocalFocus();
					}
					if (data.peer.focus) {
						_renderPeerFocus(data.peer);
					}
				} else if (data.type === 'leave' && data.connectionId) {
					_peers.delete(data.connectionId);
					_renderChips();
					if (_cursorLayer) {
						const el = _cursorLayer.querySelector('[data-conn="' + data.connectionId + '"]');
						if (el) {
							el.remove();
						}
					}
					_clearPeerFocus(data.connectionId);
					if (_peers.size === 0) {
						_clearPublishedCursor();
					}
				} else if (data.type === 'cursor' && data.connectionId) {
					const peer = _peers.get(data.connectionId);
					if (peer) {
						peer.cursor = data.cursor;
						_renderCursor(peer);
					}
				} else if (data.type === 'focus' && data.connectionId) {
					const peer = _peers.get(data.connectionId);
					if (peer) {
						peer.focus = data.focus;
						_renderPeerFocus(peer);
						onFieldLocksChanged();
					}
				}
			}

			function _clearPeerFocus(connectionId) {
				document
					.querySelectorAll('.presence-focus-label[data-presence-focus="' + connectionId + '"]')
					.forEach((el) => el.remove());
				document.querySelectorAll('[data-presence-focus-by="' + connectionId + '"]').forEach((el) => {
					el.removeAttribute('data-presence-focus-by');
					el.style.removeProperty('--presence-focus-color');
				});
			}
			function _recordForRef(reference) {
				if (!reference || reference.ref == null || !Array.isArray(canvasState.bulkRecords)) {
					return null;
				}
				const ref = String(reference.ref);
				const collabRef = reference.collabRef == null ? null : String(reference.collabRef);
				const matchesPrimaryRef = (record) => {
					if (reference.refKind === 'slot') {
						return record.slot && record.slot.slotId != null && String(record.slot.slotId) === ref;
					}
					if (reference.refKind === 'draft') {
						const draftRef =
							record._persistedTempId != null ? record._persistedTempId : record._collabId || record.id;
						return !record.loadedFromId && draftRef != null && String(draftRef) === ref;
					}
					return record.loadedFromId && String(record.loadedFromId) === ref;
				};
				const matchingRecords = canvasState.bulkRecords.filter((record) => record && matchesPrimaryRef(record));
				if (collabRef != null) {
					const exact = matchingRecords.find(
						(record) =>
							(record._canvasRecordId != null && String(record._canvasRecordId) === collabRef) ||
							(record._collabId != null && String(record._collabId) === collabRef),
					);
					if (exact) {
						return exact;
					}
					const cardMatches = canvasState.bulkRecords.filter(
						(record) =>
							record &&
							((record._canvasRecordId != null && String(record._canvasRecordId) === collabRef) ||
								(record._collabId != null && String(record._collabId) === collabRef)),
					);
					if (cardMatches.length === 1) {
						return cardMatches[0];
					}
					// A pre-card-identity payload is safe to resolve by its natural reference only when unique.
					if (matchingRecords.length === 1) {
						return matchingRecords[0];
					}
				}
				if (matchingRecords.length === 1) {
					return matchingRecords[0];
				}
				const sourceRefKind = reference.sourceRefKind;
				const sourceRef = reference.sourceRef == null ? null : String(reference.sourceRef);
				if (['loaded', 'draft'].includes(sourceRefKind) && sourceRef) {
					const sourceMatches = canvasState.bulkRecords.filter((record) => {
						if (!record) {
							return false;
						}
						if (sourceRefKind === 'loaded') {
							return record.loadedFromId && String(record.loadedFromId) === sourceRef;
						}
						const draftRef =
							record._persistedTempId != null ? record._persistedTempId : record._collabId || record.id;
						return !record.loadedFromId && draftRef != null && String(draftRef) === sourceRef;
					});
					if (sourceMatches.length === 1) {
						return sourceMatches[0];
					}
				}
				return null;
			}
			function _applyPeerFieldUpdate(data) {
				const record = data && _recordForRef(data.targetRef);
				if (!record) {
					return;
				}
				if (_localRole === 'owner') {
					for (const contributionId of Array.isArray(data.contributionIds) ? data.contributionIds : []) {
						if (/^[a-zA-Z0-9]{15,18}$/.test(String(contributionId))) {
							_acknowledgedContributionIds.add(String(contributionId));
						}
					}
				}
				const relationshipFields = new Set(
					Array.isArray(data.relationshipFields) ? data.relationshipFields : [],
				);
				if (relationshipFields.size > 0) {
					canvasState.bulkAssociations = (canvasState.bulkAssociations || []).filter(
						(association) =>
							!(
								association &&
								association.fromId === record.id &&
								relationshipFields.has(association.fieldName)
							),
					);
					for (const [key, link] of _lastBroadcastLinks) {
						if (link && relationshipFields.has(link.fieldName) && _recordForRef(link.fromRef) === record) {
							_lastBroadcastLinks.delete(key);
						}
					}
					for (let index = _pendingDraftLinks.length - 1; index >= 0; index--) {
						const link = _pendingDraftLinks[index];
						if (link && relationshipFields.has(link.fieldName) && _recordForRef(link.fromRef) === record) {
							_pendingDraftLinks.splice(index, 1);
						}
					}
				}
				record.values = record.values && typeof record.values === 'object' ? record.values : {};
				for (const [fieldName, value] of Object.entries(data.fields || {})) {
					if (value === null && !record.loadedFromId) {
						delete record.values[fieldName];
					} else {
						record.values[fieldName] = value;
					}
				}
				record._valuesRevision = (Number(record._valuesRevision) || 0) + 1;
				_seedLoadedRecordBaselines();
				renderBulkView();
				onFieldValuesChanged(record, data.fields || {});
			}
			function _ensureCanvasRecordId(record) {
				if (!record || record._permissionHidden || record._inaccessible) {
					return null;
				}
				if (record._canvasRecordId != null && String(record._canvasRecordId)) {
					return String(record._canvasRecordId);
				}
				if (record._collabId != null && String(record._collabId)) {
					record._canvasRecordId = String(record._collabId);
					return record._canvasRecordId;
				}
				record._canvasRecordId = _mintCollabId();
				if (!record.loadedFromId && record._persistedTempId == null) {
					record._collabId = record._canvasRecordId;
				}
				return record._canvasRecordId;
			}
			function _recordReference(record) {
				if (record && record._permissionHidden && record._permissionHiddenId) {
					return { hiddenId: String(record._permissionHiddenId) };
				}
				if (!record || record.isTypeNode || record.isPending || record._inaccessible) {
					return null;
				}
				let out;
				if (record.slot && record.slot.slotId != null) {
					out = { refKind: 'slot', ref: String(record.slot.slotId) };
					if (record.loadedFromId) {
						out.sourceRefKind = 'loaded';
						out.sourceRef = String(record.loadedFromId);
					} else {
						const sourceRef =
							record._persistedTempId != null ? record._persistedTempId : record._collabId || record.id;
						if (sourceRef != null) {
							out.sourceRefKind = 'draft';
							out.sourceRef = String(sourceRef);
						}
					}
				} else if (record.loadedFromId) {
					out = { refKind: 'loaded', ref: String(record.loadedFromId) };
				} else {
					const ref =
						record._persistedTempId != null ? record._persistedTempId : record._collabId || record.id;
					if (ref == null) {
						return null;
					}
					out = { refKind: 'draft', ref: String(ref) };
				}
				out.collabRef = _ensureCanvasRecordId(record);
				return out;
			}
			function _underlyingRecordReference(record) {
				if (
					!record ||
					record.isTypeNode ||
					record.isPending ||
					record._permissionHidden ||
					record._inaccessible
				) {
					return null;
				}
				let out;
				if (record.loadedFromId) {
					out = { refKind: 'loaded', ref: String(record.loadedFromId) };
				} else {
					const ref =
						record._persistedTempId != null ? record._persistedTempId : record._collabId || record.id;
					if (ref == null) {
						return null;
					}
					out = { refKind: 'draft', ref: String(ref) };
				}
				out.collabRef = _ensureCanvasRecordId(record);
				return out;
			}
			function _renderPeerFocus(peer) {
				if (!peer || !peer.connectionId) {
					return;
				}
				_clearPeerFocus(peer.connectionId);
				const focus = peer.focus;
				if (!focus || focus.kind !== 'record' || !focus.ref) {
					return;
				}
				const cs = canvasState;
				if (!cs || !Array.isArray(cs.bulkRecords)) {
					return;
				}
				const rec = _recordForRef(focus);
				if (!rec) {
					return;
				}
				const card = document.querySelector('[data-rec-id="' + rec.id + '"]');
				if (!card) {
					return;
				}
				card.setAttribute('data-presence-focus-by', peer.connectionId);
				card.style.setProperty('--presence-focus-color', peer.color);
				const label = document.createElement('div');
				label.className = 'presence-focus-label';
				label.setAttribute('data-presence-focus', peer.connectionId);
				label.textContent = (peer.displayName || 'Someone') + ' viewing';
				label.style.backgroundColor = peer.color;
				card.appendChild(label);
			}
			function _reapplyAllFocus() {
				for (const peer of _peers.values()) {
					if (peer && peer.focus) {
						_renderPeerFocus(peer);
					}
				}
			}

			function _applyPeerLayout(data) {
				if (!data || !Array.isArray(data.positions)) {
					return;
				}
				const cy = getCyInstance && getCyInstance();
				for (const position of data.positions) {
					const record = position.hiddenId
						? canvasState.bulkRecords.find(
								(candidate) => candidate && candidate._permissionHiddenId === String(position.hiddenId),
							)
						: _recordForRef(position);
					if (!record || typeof position.x !== 'number' || typeof position.y !== 'number') {
						continue;
					}
					record.x = position.x;
					record.y = position.y;
					if (cy && typeof cy.getElementById === 'function') {
						const node = cy.getElementById('r' + record.id);
						if (node && node.length && !node.grabbed()) {
							node.position({ x: position.x, y: position.y });
						}
					}
				}
			}

			const _lastBroadcastDraftValues = new Map();
			const _lastBroadcastLoadedRefs = new Map();
			const _lastBroadcastLoadedRecords = new Map();
			const _lastBroadcastSlots = new Map();
			const _lastBroadcastLinks = new Map();
			const _pendingLayoutPositions = new Map();
			const DRAFT_BROADCAST_INTERVAL_MS = 2000;

			function _linkKey(fromRef, toRef, fieldName) {
				const canonicalRef = (reference) => {
					if (!reference || reference.refKind == null || reference.ref == null) {
						return null;
					}
					return {
						refKind: String(reference.refKind),
						ref: String(reference.ref),
						...(reference.collabRef != null ? { collabRef: String(reference.collabRef) } : {}),
					};
				};
				return JSON.stringify([canonicalRef(fromRef), canonicalRef(toRef), String(fieldName || '')]);
			}

			function _syncIdOf(rec) {
				if (!rec) {
					return null;
				}
				if (rec._persistedTempId != null) {
					return String(rec._persistedTempId);
				}
				if (rec._collabId) {
					return String(rec._collabId);
				}
				return null;
			}
			function _mintCollabId() {
				try {
					if (window.crypto && typeof window.crypto.randomUUID === 'function') {
						return window.crypto.randomUUID();
					}
				} catch (_) {}
				return 'collab_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
			}
			function _safeValueCopy(values, objectName) {
				const out = {};
				if (!values || typeof values !== 'object') {
					return out;
				}
				for (const k of Object.keys(values)) {
					const v = values[k];
					if (v == null) {
						continue;
					}
					const t = typeof v;
					if (t === 'string' || t === 'number' || t === 'boolean') {
						out[k] = v;
					}
				}
				return objectName ? encryptedFields.stripValues(canvasState, objectName, out) : out;
			}

			function _loadedRecordSnapshot(record) {
				return {
					fields: _safeValueCopy(record && record.values, record && record.objectName),
					baseline: _safeValueCopy(record && record.loadedValues, record && record.objectName),
					pendingDelete: !!(record && record.pendingDelete),
				};
			}

			function _valueMapsEqual(left, right) {
				const leftKeys = Object.keys(left || {});
				const rightKeys = Object.keys(right || {});
				return (
					leftKeys.length === rightKeys.length &&
					leftKeys.every(
						(key) =>
							Object.prototype.hasOwnProperty.call(right || {}, key) &&
							JSON.stringify(left[key]) === JSON.stringify(right[key]),
					)
				);
			}

			function _safeSlotCopy(slot) {
				if (!slot || slot.slotId == null) {
					return null;
				}
				const copy = {
					slotId: slot.slotId,
					kind: slot.kind === 'fields' ? 'fields' : 'whole-record',
					createdAt: Number.isFinite(Number(slot.createdAt)) ? Number(slot.createdAt) : null,
					label: slot.label || null,
					description: slot.description || null,
					assigneeSfUserId: slot.assigneeSfUserId || null,
					assigneeName: slot.assigneeName || null,
					assigneeEmail: slot.assigneeEmail || null,
				};
				if (copy.kind === 'fields') {
					copy.fields = Array.isArray(slot.fields) ? slot.fields.slice() : [];
				} else if (slot.origin === 'standalone') {
					copy.origin = 'standalone';
				}
				return copy;
			}

			function _safeRecordReferenceCopy(reference) {
				if (!reference || !['loaded', 'draft', 'slot'].includes(reference.refKind)) {
					return null;
				}
				const ref = reference.ref == null ? '' : String(reference.ref);
				if (!ref || ref.length > 128) {
					return null;
				}
				const copy = { refKind: reference.refKind, ref };
				for (const key of ['collabRef', 'sourceRef']) {
					if (reference[key] != null && String(reference[key])) {
						copy[key] = String(reference[key]);
					}
				}
				if (['loaded', 'draft'].includes(reference.sourceRefKind)) {
					copy.sourceRefKind = reference.sourceRefKind;
				}
				return copy;
			}

			function _incomingSlotCopy(slot) {
				const copy = _safeSlotCopy(slot);
				const unavailable = Number(slot && slot.unavailableFieldCount);
				if (copy && Number.isSafeInteger(unavailable) && unavailable > 0) {
					copy.unavailableFieldCount = unavailable;
				}
				return copy;
			}

			function _seedLoadedRecordBaselines() {
				_lastBroadcastDraftValues.clear();
				_lastBroadcastLoadedRecords.clear();
				_lastBroadcastLoadedRefs.clear();
				_lastBroadcastSlots.clear();
				_lastBroadcastLinks.clear();
				if (!Array.isArray(canvasState.bulkRecords)) {
					return;
				}
				for (const record of canvasState.bulkRecords) {
					if (!record || record.isTypeNode || record._permissionHidden || record._inaccessible) {
						continue;
					}
					if (record.loadedFromId) {
						const sfId = String(record.loadedFromId);
						const cardRef = _ensureCanvasRecordId(record);
						_lastBroadcastLoadedRefs.set(cardRef, sfId);
						_lastBroadcastLoadedRecords.set(cardRef, _loadedRecordSnapshot(record));
					} else {
						const syncId = _syncIdOf(record);
						if (syncId != null) {
							_lastBroadcastDraftValues.set(syncId, {
								values: _safeValueCopy(record.values, record.objectName),
								x: typeof record.x === 'number' ? record.x : null,
								y: typeof record.y === 'number' ? record.y : null,
								canvasRecordId: _ensureCanvasRecordId(record),
							});
						}
					}
				}
				for (const record of canvasState.bulkRecords) {
					if (!record || record._permissionHidden || record._inaccessible) {
						continue;
					}
					const targetRef = _underlyingRecordReference(record);
					if (!targetRef) {
						continue;
					}
					_lastBroadcastSlots.set(JSON.stringify(targetRef), JSON.stringify(_safeSlotCopy(record.slot)));
				}
				const recordsByRuntimeId = new Map(
					canvasState.bulkRecords
						.filter((record) => record && record.id != null)
						.map((record) => [record.id, record]),
				);
				for (const association of Array.isArray(canvasState.bulkAssociations)
					? canvasState.bulkAssociations
					: []) {
					const fromRef = _recordReference(recordsByRuntimeId.get(association && association.fromId));
					const toRef = _recordReference(recordsByRuntimeId.get(association && association.toId));
					if (!fromRef || !toRef || !association.fieldName) {
						continue;
					}
					const key = _linkKey(fromRef, toRef, association.fieldName);
					_lastBroadcastLinks.set(key, {
						fromRef,
						toRef,
						fieldName: association.fieldName,
					});
				}
			}

			function _seedMutationTrackingFromSnapshot(payload) {
				_resetMutationTracking();
				_lastBroadcastDraftValues.clear();
				_lastBroadcastLoadedRefs.clear();
				_lastBroadcastLoadedRecords.clear();
				_lastBroadcastSlots.clear();
				_lastBroadcastLinks.clear();
				const drafts = Array.isArray(payload && payload.drafts) ? payload.drafts : [];
				const loadedRecords = Array.isArray(payload && payload.loadedRecords) ? payload.loadedRecords : [];
				const records = loadedRecords.concat(drafts).filter(Boolean);
				const cardRef = (record) =>
					record.canvasRecordId != null
						? String(record.canvasRecordId)
						: String(record.loadedFromId != null ? record.loadedFromId : record.tempId);
				const underlyingRef = (record) => {
					if (!record) {
						return null;
					}
					const ref = record.loadedFromId != null ? record.loadedFromId : record.tempId;
					if (ref == null) {
						return null;
					}
					return {
						refKind: record.loadedFromId != null ? 'loaded' : 'draft',
						ref: String(ref),
						collabRef: cardRef(record),
					};
				};
				const associationRef = (endpoint) => {
					if (!endpoint || !['loaded', 'draft', 'slot'].includes(endpoint.kind) || endpoint.ref == null) {
						return null;
					}
					const ref = String(endpoint.ref);
					const record = records.find((candidate) => {
						if (endpoint.kind === 'loaded') {
							return candidate.loadedFromId != null && String(candidate.loadedFromId) === ref;
						}
						if (endpoint.kind === 'draft') {
							return candidate.tempId != null && String(candidate.tempId) === ref;
						}
						return candidate.slot && candidate.slot.slotId != null && String(candidate.slot.slotId) === ref;
					});
					const reference = { refKind: endpoint.kind, ref };
					if (record) {
						reference.collabRef = cardRef(record);
						if (endpoint.kind === 'slot') {
							reference.sourceRefKind = record.loadedFromId != null ? 'loaded' : 'draft';
							reference.sourceRef = String(
								record.loadedFromId != null ? record.loadedFromId : record.tempId,
							);
						}
					}
					return reference;
				};

				for (const draft of drafts) {
					if (draft.tempId == null) {
						continue;
					}
					_lastBroadcastDraftValues.set(String(draft.tempId), {
						values: _safeValueCopy(draft.values, draft.objectName),
						x: Number.isFinite(draft.x) ? draft.x : null,
						y: Number.isFinite(draft.y) ? draft.y : null,
						canvasRecordId: cardRef(draft),
					});
				}
				for (const record of loadedRecords) {
					if (record.loadedFromId == null) {
						continue;
					}
					const recordCardRef = cardRef(record);
					_lastBroadcastLoadedRefs.set(recordCardRef, String(record.loadedFromId));
					_lastBroadcastLoadedRecords.set(recordCardRef, {
						fields: _safeValueCopy(record.values || record.changes, record.objectName),
						baseline: _safeValueCopy(record.loadedValues, record.objectName),
						pendingDelete: !!record.pendingDelete,
					});
				}
				for (const record of records) {
					const reference = underlyingRef(record);
					if (reference) {
						_lastBroadcastSlots.set(JSON.stringify(reference), JSON.stringify(_safeSlotCopy(record.slot)));
					}
				}
				for (const association of Array.isArray(payload && payload.associations) ? payload.associations : []) {
					const fromRef = associationRef(association && association.from);
					const toRef = associationRef(association && association.to);
					if (!fromRef || !toRef || !association.fieldName) {
						continue;
					}
					const key = _linkKey(fromRef, toRef, association.fieldName);
					_lastBroadcastLinks.set(key, { fromRef, toRef, fieldName: association.fieldName });
				}
			}

			function _postLoadedRecord(key, payload, onAccepted) {
				return _sendDesiredMutation(
					key,
					() => {
						payload.connectionId = _myConnectionId;
						payload.sequence = _nextSequence();
						return csrfFetch(
							'/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/loaded-record',
							{
								method: 'POST',
								credentials: 'same-origin',
								headers: { 'Content-Type': 'application/json' },
								body: JSON.stringify(payload),
							},
						);
					},
					onAccepted,
				);
			}

			async function _applyPeerLoadedRecord(data) {
				if (!data || !data.sfId || !Array.isArray(canvasState.bulkRecords)) {
					return;
				}
				const sfId = String(data.sfId);
				const loadedTarget = _recordForRef({
					refKind: 'loaded',
					ref: sfId,
					collabRef: data.collabRef,
				});
				const promotionTarget =
					data.kind === 'create' && data.promotedFrom ? _recordForRef(data.promotedFrom) : null;
				let target = promotionTarget || loadedTarget;
				let created = false;
				const redactedFields = new Set(
					(Array.isArray(data.redactedFields) ? data.redactedFields : []).filter(
						(name) => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(name),
					),
				);
				const preserveRedacted = (nextValues, priorValues) => {
					const next = _safeValueCopy(nextValues, data.objectName);
					for (const name of redactedFields) {
						if (Object.prototype.hasOwnProperty.call(priorValues || {}, name)) {
							next[name] = priorValues[name];
						}
					}
					return next;
				};
				if (promotionTarget && loadedTarget && promotionTarget !== loadedTarget) {
					for (const association of canvasState.bulkAssociations || []) {
						if (association.fromId === loadedTarget.id) {
							association.fromId = promotionTarget.id;
						}
						if (association.toId === loadedTarget.id) {
							association.toId = promotionTarget.id;
						}
					}
					canvasState.bulkRecords = canvasState.bulkRecords.filter((record) => record !== loadedTarget);
				}
				if (promotionTarget) {
					promotionTarget.loadedFromId = sfId;
					promotionTarget.objectName = data.objectName || promotionTarget.objectName;
					promotionTarget.values = preserveRedacted(data.fields, promotionTarget.values);
					promotionTarget.loadedValues = preserveRedacted(
						data.baseline || data.fields,
						promotionTarget.loadedValues,
					);
					delete promotionTarget._persistedTempId;
					delete promotionTarget._collabId;
				}
				if (!target && data.kind === 'create' && data.collabRef != null) {
					target = canvasState.bulkRecords.find(
						(record) =>
							record &&
							!record.loadedFromId &&
							!record._permissionHidden &&
							String(record._canvasRecordId || '') === String(data.collabRef),
					);
					if (target) {
						target.loadedFromId = sfId;
						target.objectName = data.objectName || target.objectName;
						target.values = preserveRedacted(data.fields, target.values);
						target.loadedValues = preserveRedacted(data.baseline || data.fields, target.loadedValues);
						delete target._persistedTempId;
						delete target._collabId;
					}
				}
				if (!target && data.kind === 'create') {
					if (!data.objectName || typeof data.objectName !== 'string') {
						return;
					}
					let selected = canvasState.selectedObjects.find((entry) => entry.name === data.objectName);
					if (!selected) {
						try {
							selected = await addToSelection(data.objectName);
						} catch (_) {
							selected = null;
						}
					}
					target = {
						id: canvasState.bulkIdSeq++,
						objectName: data.objectName,
						label: (selected && selected.label) || data.objectName,
						fromSelectionId: selected ? selected.id : null,
						loadedFromId: sfId,
						_canvasRecordId: data.collabRef || _mintCollabId(),
						x: Number.isFinite(data.x) ? data.x : 200,
						y: Number.isFinite(data.y) ? data.y : 200,
						loadedValues: _safeValueCopy(data.baseline, data.objectName),
						values: {},
					};
					if (data.slot && typeof data.slot === 'object') {
						target.slot = _incomingSlotCopy(data.slot);
						if (_localRole && _localRole !== 'owner') {
							target._recipientSlot = true;
						}
					}
					canvasState.bulkRecords.push(target);
					created = true;
				}
				if (!target) {
					return;
				}
				if (data.kind === 'create' && data.slot !== undefined) {
					if (data.slot && typeof data.slot === 'object') {
						target.slot = _incomingSlotCopy(data.slot);
					} else {
						delete target.slot;
						delete target._recipientSlot;
					}
				}
				if (data.kind === 'create') {
					target.loadedFromId = sfId;
					delete target._persistedTempId;
					delete target._collabId;
					// Retire old draft aliases of this same card, preserving their links.
					for (const alias of canvasState.bulkRecords.slice()) {
						if (
							alias === target ||
							alias.loadedFromId ||
							alias.objectName !== target.objectName ||
							!target._canvasRecordId ||
							alias._canvasRecordId !== target._canvasRecordId
						)
							continue;
						for (const link of canvasState.bulkAssociations || []) {
							if (link.fromId === alias.id) link.fromId = target.id;
							if (link.toId === alias.id) link.toId = target.id;
						}
						canvasState.bulkRecords = canvasState.bulkRecords.filter((record) => record !== alias);
						canvasState.bulkSelectedIds?.delete(alias.id);
					}
					target.loadedValues = preserveRedacted(data.baseline || data.fields, target.loadedValues);
					target.values = preserveRedacted(data.fields, target.values);
					if (Number.isFinite(data.x)) {
						target.x = data.x;
					}
					if (Number.isFinite(data.y)) {
						target.y = data.y;
					}
				} else if (data.baseline && typeof data.baseline === 'object') {
					target.loadedValues = preserveRedacted(data.baseline, target.loadedValues);
					target.values = preserveRedacted(data.fields, target.values);
				}
				const values = (target.values = target.values || {});
				for (const key of Object.keys(data.fields || {})) {
					if (data.fields[key] === null) {
						delete values[key];
					} else {
						values[key] = data.fields[key];
					}
				}
				if (typeof data.pendingDelete === 'boolean') {
					target.pendingDelete = data.pendingDelete;
				}
				const cardRef = _ensureCanvasRecordId(target);
				_lastBroadcastLoadedRefs.set(cardRef, sfId);
				_lastBroadcastLoadedRecords.set(cardRef, _loadedRecordSnapshot(target));
				if (created) {
					setSkipNextCyAutoPan(true);
				}
				renderBulkView();
				if (created) {
					_flushPendingDraftLinks();
				}
			}

			function _postSlotUpdate(key, targetRef, slot, onAccepted) {
				return _sendDesiredMutation(
					key,
					() =>
						csrfFetch('/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/slot', {
							method: 'POST',
							credentials: 'same-origin',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								connectionId: _myConnectionId,
								sequence: _nextSequence(),
								targetRef,
								slot,
							}),
						}),
					onAccepted,
				);
			}

			function _applyPeerSlotUpdate(data) {
				if (!data || !data.targetRef || !Array.isArray(canvasState.bulkRecords)) {
					return;
				}
				const target = _recordForRef(data.targetRef);
				if (!target) {
					return;
				}
				if (data.slot === null) {
					delete target.slot;
					delete target._recipientSlot;
				} else if (data.slot && typeof data.slot === 'object') {
					target.slot = Object.assign({}, data.slot);
					if (Array.isArray(data.slot.fields)) {
						target.slot.fields = data.slot.fields.slice();
					}
					if (_localRole && _localRole !== 'owner') {
						target._recipientSlot = true;
					}
				}
				const targetRef = _underlyingRecordReference(target);
				if (targetRef) {
					_lastBroadcastSlots.set(JSON.stringify(targetRef), JSON.stringify(_safeSlotCopy(target.slot)));
				}
				renderBulkView();
				onSlotUpdated(target, target.slot || null);
				_flushPendingDraftLinks();
			}

			function _postDraftPayload(key, payload, onAccepted) {
				return _sendDesiredMutation(
					key,
					() => {
						payload.sequence = _nextSequence();
						return csrfFetch('/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/draft', {
							method: 'POST',
							credentials: 'same-origin',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify(payload),
						});
					},
					onAccepted,
				);
			}
			function _broadcastDraftDeltas() {
				if (_canvasLoadDepth || _canvasLoadFailed || _applyingSnapshot || _awaitingLayoutSnapshot) return;
				// Never compare a newly selected canvas against the previous subscription's baselines.
				if (canvasState.currentCanvas && canvasState.currentCanvas.id !== _currentCanvasId) return;
				if (!_localCanEdit || !_currentCanvasId || !_myConnectionId) {
					return;
				}
				if (!Array.isArray(canvasState.bulkRecords)) {
					return;
				}
				_flushPendingDraftLinks();
				const seenIds = new Set();
				// Only drafts are co-edited here; existing Salesforce records retain their own write flow.
				for (const r of canvasState.bulkRecords) {
					if (!r || r._permissionHidden || r._inaccessible) {
						continue;
					}
					if (r.isTypeNode) {
						continue;
					}
					if (r.loadedFromId) {
						continue;
					}
					let syncId = _syncIdOf(r);
					if (syncId == null) {
						r._collabId = _ensureCanvasRecordId(r);
						syncId = r._collabId;
					}
					const isFirstBroadcast = !_lastBroadcastDraftValues.has(syncId);
					if (isFirstBroadcast) {
						const initialValues = _safeValueCopy(r.values, r.objectName);
						const initX = typeof r.x === 'number' ? r.x : 200;
						const initY = typeof r.y === 'number' ? r.y : 200;
						const sentEntry = {
							values: initialValues,
							x: initX,
							y: initY,
							canvasRecordId: _ensureCanvasRecordId(r),
						};
						_postDraftPayload(
							'draft:' + syncId,
							{
								connectionId: _myConnectionId,
								tempId: syncId,
								canvasRecordId: _ensureCanvasRecordId(r),
								kind: 'create',
								objectName: r.objectName || null,
								x: initX,
								y: initY,
								fields: initialValues,
								slot: _safeSlotCopy(r.slot),
							},
							() => _lastBroadcastDraftValues.set(syncId, sentEntry),
						);
						seenIds.add(syncId);
						continue;
					}
					seenIds.add(syncId);
					const cur = _safeValueCopy(r.values, r.objectName);
					const lastEntry = _lastBroadcastDraftValues.get(syncId) || { values: {}, x: null, y: null };
					const lastValues = lastEntry.values || {};
					const diff = {};
					let hasFieldsDiff = false;
					for (const k of Object.keys(cur)) {
						if (cur[k] !== lastValues[k]) {
							diff[k] = cur[k];
							hasFieldsDiff = true;
						}
					}
					for (const k of Object.keys(lastValues)) {
						if (!(k in cur)) {
							diff[k] = null;
							hasFieldsDiff = true;
						}
					}
					const curX = typeof r.x === 'number' ? r.x : null;
					const curY = typeof r.y === 'number' ? r.y : null;
					if (!hasFieldsDiff) {
						continue;
					}
					const payload = {
						connectionId: _myConnectionId,
						tempId: syncId,
						canvasRecordId: _ensureCanvasRecordId(r),
						fields: hasFieldsDiff ? diff : {},
					};
					const sentEntry = {
						values: cur,
						x: curX,
						y: curY,
						canvasRecordId: _ensureCanvasRecordId(r),
					};
					_postDraftPayload('draft:' + syncId, payload, () =>
						_lastBroadcastDraftValues.set(syncId, sentEntry),
					);
				}
				const toRemove = [];
				for (const k of _lastBroadcastDraftValues.keys()) {
					if (!seenIds.has(k)) {
						toRemove.push(k);
					}
				}
				for (const k of toRemove) {
					const previousDraft = _lastBroadcastDraftValues.get(k);
					const promotedInPlace =
						previousDraft &&
						previousDraft.canvasRecordId &&
						canvasState.bulkRecords.some(
							(record) =>
								record &&
								record.loadedFromId &&
								_ensureCanvasRecordId(record) === previousDraft.canvasRecordId,
						);
					if (promotedInPlace) {
						continue;
					}
					_postDraftPayload(
						'draft:' + k,
						{
							connectionId: _myConnectionId,
							tempId: k,
							canvasRecordId: previousDraft && previousDraft.canvasRecordId,
							kind: 'remove',
							fields: {},
						},
						() => _lastBroadcastDraftValues.delete(k),
					);
				}
				const currentLoadedRefs = new Map();
				for (const r of canvasState.bulkRecords) {
					if (!r || r.isTypeNode || !r.loadedFromId) {
						continue;
					}
					const sfId = String(r.loadedFromId);
					const cardRef = _ensureCanvasRecordId(r);
					currentLoadedRefs.set(cardRef, sfId);
					const current = _loadedRecordSnapshot(r);
					const previous = _lastBroadcastLoadedRecords.get(cardRef);
					if (!previous) {
						const promotedDraftIds = Array.from(_lastBroadcastDraftValues.entries())
							.filter(([, entry]) => entry && entry.canvasRecordId === cardRef)
							.map(([syncId]) => syncId);
						_postLoadedRecord(
							'loaded:' + cardRef,
							{
								kind: 'create',
								sfId,
								collabRef: cardRef,
								objectName: r.objectName,
								fields: current.fields,
								baseline: current.baseline,
								x: r.x,
								y: r.y,
								pendingDelete: current.pendingDelete,
								slot: _safeSlotCopy(r.slot),
								promotedFrom: _safeRecordReferenceCopy(r._presencePromotedFrom),
							},
							() => {
								_lastBroadcastLoadedRefs.set(cardRef, sfId);
								_lastBroadcastLoadedRecords.set(cardRef, current);
								promotedDraftIds.forEach((syncId) => _lastBroadcastDraftValues.delete(syncId));
								delete r._presencePromotedFrom;
							},
						);
						continue;
					}
					const diff = {};
					let changed = false;
					for (const key of Object.keys(current.fields)) {
						if (current.fields[key] !== previous.fields[key]) {
							diff[key] = current.fields[key];
							changed = true;
						}
					}
					for (const key of Object.keys(previous.fields)) {
						if (!(key in current.fields)) {
							diff[key] = null;
							changed = true;
						}
					}
					const deleteChanged = current.pendingDelete !== previous.pendingDelete;
					const baselineChanged = !_valueMapsEqual(current.baseline, previous.baseline);
					if (changed || deleteChanged || baselineChanged) {
						_postLoadedRecord(
							'loaded:' + cardRef,
							{
								kind: 'update',
								sfId,
								collabRef: cardRef,
								objectName: r.objectName,
								fields: baselineChanged ? current.fields : diff,
								...(baselineChanged ? { baseline: current.baseline } : {}),
								pendingDelete: current.pendingDelete,
							},
							() => _lastBroadcastLoadedRecords.set(cardRef, current),
						);
					}
				}
				const removedLoadedRefs = [];
				for (const [cardRef, sfId] of _lastBroadcastLoadedRefs) {
					if (!currentLoadedRefs.has(cardRef)) {
						removedLoadedRefs.push({ cardRef, sfId });
					}
				}
				for (const removed of removedLoadedRefs) {
					_sendDesiredMutation(
						'loaded:' + removed.cardRef,
						() =>
							csrfFetch(
								'/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/record-remove',
								{
									method: 'POST',
									credentials: 'same-origin',
									headers: { 'Content-Type': 'application/json' },
									body: JSON.stringify({
										connectionId: _myConnectionId,
										sequence: _nextSequence(),
										sfId: removed.sfId,
										collabRef: removed.cardRef,
									}),
								},
							),
						() => {
							_lastBroadcastLoadedRefs.delete(removed.cardRef);
							_lastBroadcastLoadedRecords.delete(removed.cardRef);
						},
					);
				}
				const currentSlotKeys = new Set();
				for (const record of canvasState.bulkRecords) {
					const targetRef = _underlyingRecordReference(record);
					if (!targetRef) {
						continue;
					}
					const key = JSON.stringify(targetRef);
					const sentSlot = _safeSlotCopy(record.slot);
					const serialized = JSON.stringify(sentSlot);
					currentSlotKeys.add(key);
					if (_lastBroadcastSlots.get(key) !== serialized) {
						_postSlotUpdate('slot:' + key, targetRef, sentSlot, () =>
							_lastBroadcastSlots.set(key, serialized),
						);
					}
				}
				for (const key of Array.from(_lastBroadcastSlots.keys())) {
					if (!currentSlotKeys.has(key)) {
						_lastBroadcastSlots.delete(key);
					}
				}
				const recordsByRuntimeId = new Map();
				for (const r of canvasState.bulkRecords) {
					if (r && r.id != null) {
						recordsByRuntimeId.set(r.id, r);
					}
				}
				const currentLinks = new Map(); // key → {fromSyncId, toSyncId, fieldName}
				if (Array.isArray(canvasState.bulkAssociations)) {
					for (const a of canvasState.bulkAssociations) {
						if (!a) {
							continue;
						}
						const fromRec = recordsByRuntimeId.get(a.fromId);
						const toRec = recordsByRuntimeId.get(a.toId);
						if (!fromRec || !toRec) {
							continue;
						}
						if (fromRec.isTypeNode || toRec.isTypeNode) {
							continue;
						}
						const fromRef = _recordReference(fromRec);
						const toRef = _recordReference(toRec);
						if (!fromRef || !toRef) {
							continue;
						}
						if (!a.fieldName) {
							continue;
						}
						const key = _linkKey(fromRef, toRef, a.fieldName);
						currentLinks.set(key, {
							fromRef,
							toRef,
							fieldName: a.fieldName,
						});
					}
				}
				for (const [key, link] of _lastBroadcastLinks) {
					if (currentLinks.has(key)) {
						continue;
					}
					_sendDesiredMutation(
						'link:' + key,
						() =>
							csrfFetch('/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/draft-link', {
								method: 'POST',
								credentials: 'same-origin',
								headers: { 'Content-Type': 'application/json' },
								body: JSON.stringify({
									connectionId: _myConnectionId,
									sequence: _nextSequence(),
									kind: 'remove',
									fromRef: link.fromRef,
									toRef: link.toRef,
									fieldName: link.fieldName,
								}),
							}),
						() => _lastBroadcastLinks.delete(key),
					);
				}
				for (const [key, link] of currentLinks) {
					if (_lastBroadcastLinks.has(key)) {
						continue;
					}
					_sendDesiredMutation(
						'link:' + key,
						() =>
							csrfFetch('/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/draft-link', {
								method: 'POST',
								credentials: 'same-origin',
								headers: { 'Content-Type': 'application/json' },
								body: JSON.stringify({
									connectionId: _myConnectionId,
									sequence: _nextSequence(),
									kind: 'add',
									fromRef: link.fromRef,
									toRef: link.toRef,
									fieldName: link.fieldName,
								}),
							}),
						() => _lastBroadcastLinks.set(key, link),
					);
				}
			}

			const _pendingDraftLinks = [];
			const PENDING_LINKS_CAP = 100;

			function _tryApplyPeerDraftLink(data) {
				if (!data || !data.kind || !data.fieldName) {
					return true;
				}
				if (!Array.isArray(canvasState.bulkRecords)) {
					return false;
				}
				const fromRef =
					data.fromRef ||
					(data.fromSyncId
						? { refKind: 'draft', ref: String(data.fromSyncId), collabRef: String(data.fromSyncId) }
						: null);
				const toRef =
					data.toRef ||
					(data.toSyncId
						? { refKind: 'draft', ref: String(data.toSyncId), collabRef: String(data.toSyncId) }
						: null);
				if (!fromRef || !toRef) {
					return true;
				}
				const fromRec = _recordForRef(fromRef);
				const toRec = _recordForRef(toRef);
				if (!fromRec || !toRec) {
					return false;
				}
				if (fromRec._inaccessible || toRec._inaccessible) {
					return true;
				}
				const key = _linkKey(fromRef, toRef, data.fieldName);
				if (data.kind === 'add') {
					const existing = canvasState.bulkAssociations.find(
						(a) => a && a.fromId === fromRec.id && a.toId === toRec.id && a.fieldName === data.fieldName,
					);
					if (!existing) {
						canvasState.bulkAssociations.push({
							id: canvasState.bulkIdSeq++,
							fromId: fromRec.id,
							toId: toRec.id,
							fieldName: data.fieldName,
						});
					}
					fromRec.values = fromRec.values || {};
					if (toRec.loadedFromId) {
						fromRec.values[data.fieldName] = toRec.loadedFromId;
					} else {
						delete fromRec.values[data.fieldName];
					}
					_lastBroadcastLinks.set(key, {
						fromRef,
						toRef,
						fieldName: data.fieldName,
					});
				} else if (data.kind === 'remove') {
					const before = canvasState.bulkAssociations.length;
					canvasState.bulkAssociations = canvasState.bulkAssociations.filter(
						(a) => !(a && a.fromId === fromRec.id && a.toId === toRec.id && a.fieldName === data.fieldName),
					);
					if (canvasState.bulkAssociations.length === before) {
						return true;
					} // nothing to do
					if (
						fromRec.values?.[data.fieldName] == null ||
						(toRec.loadedFromId &&
							String(fromRec.values[data.fieldName]).slice(0, 15) ===
								String(toRec.loadedFromId).slice(0, 15))
					) {
						fromRec.values = fromRec.values || {};
						fromRec.values[data.fieldName] = null;
					}
					_lastBroadcastLinks.delete(key);
				}
				try {
					renderBulkView();
				} catch (_) {}
				return true;
			}
			function _applyPeerDraftLink(data) {
				const ok = _tryApplyPeerDraftLink(data);
				if (!ok && data && data.kind === 'add') {
					if (_pendingDraftLinks.length < PENDING_LINKS_CAP) {
						_pendingDraftLinks.push(data);
					}
				}
			}
			function _flushPendingDraftLinks() {
				if (_pendingDraftLinks.length === 0) {
					return;
				}
				const queue = _pendingDraftLinks.slice();
				_pendingDraftLinks.length = 0;
				for (const data of queue) {
					const ok = _tryApplyPeerDraftLink(data);
					if (!ok && _pendingDraftLinks.length < PENDING_LINKS_CAP) {
						_pendingDraftLinks.push(data);
					}
				}
			}

			function _applyPeerLoadedRemoved(data) {
				if (!data || !data.sfId) {
					return;
				}
				const targetSfId = String(data.sfId);
				if (!Array.isArray(canvasState.bulkRecords)) {
					return;
				}
				const target = _recordForRef({
					refKind: 'loaded',
					ref: targetSfId,
					collabRef: data.collabRef,
				});
				if (!target) {
					if (data.collabRef) {
						_lastBroadcastLoadedRefs.delete(String(data.collabRef));
						_lastBroadcastLoadedRecords.delete(String(data.collabRef));
					}
					return;
				}
				let removedRuntimeId = null;
				const remaining = [];
				for (const r of canvasState.bulkRecords) {
					if (!r) {
						remaining.push(r);
						continue;
					}
					if (r.isTypeNode) {
						remaining.push(r);
						continue;
					}
					if (r === target) {
						removedRuntimeId = r.id;
						continue;
					}
					remaining.push(r);
				}
				if (removedRuntimeId == null) {
					return;
				}
				canvasState.bulkRecords = remaining;
				if (Array.isArray(canvasState.bulkAssociations)) {
					canvasState.bulkAssociations = canvasState.bulkAssociations.filter(
						(a) => a.fromId !== removedRuntimeId && a.toId !== removedRuntimeId,
					);
				}
				if (canvasState.bulkSelectedIds && typeof canvasState.bulkSelectedIds.delete === 'function') {
					canvasState.bulkSelectedIds.delete(removedRuntimeId);
				}
				const cardRef = _ensureCanvasRecordId(target);
				_lastBroadcastLoadedRefs.delete(cardRef);
				_lastBroadcastLoadedRecords.delete(cardRef);
				try {
					renderBulkView();
				} catch (_) {}
			}

			function _findDraftBySyncId(syncId) {
				if (!Array.isArray(canvasState.bulkRecords)) {
					return null;
				}
				const target = String(syncId);
				for (const r of canvasState.bulkRecords) {
					if (!r) {
						continue;
					}
					if (r.isTypeNode || r.loadedFromId) {
						continue;
					}
					if (_syncIdOf(r) === target) {
						return r;
					}
				}
				return null;
			}

			function _applyPeerHiddenRecord(data) {
				if (!data || !data.hiddenId || !Array.isArray(canvasState.bulkRecords)) {
					return;
				}
				const hiddenId = String(data.hiddenId);
				let target = canvasState.bulkRecords.find(
					(record) => record && record._permissionHiddenId === hiddenId,
				);
				if (data.kind === 'remove') {
					if (!target) {
						return;
					}
					canvasState.bulkRecords = canvasState.bulkRecords.filter((record) => record !== target);
					canvasState.bulkAssociations = (canvasState.bulkAssociations || []).filter(
						(association) => association.fromId !== target.id && association.toId !== target.id,
					);
					if (canvasState.bulkSelectedIds && typeof canvasState.bulkSelectedIds.delete === 'function') {
						canvasState.bulkSelectedIds.delete(target.id);
					}
					renderBulkView();
					return;
				}
				if (!target && data.kind === 'create') {
					const lowestId = canvasState.bulkRecords.reduce(
						(lowest, record) =>
							record && Number.isFinite(record.id) && record.id < lowest ? record.id : lowest,
						0,
					);
					target = {
						id: lowestId - 1,
						objectName: null,
						label: 'Hidden Salesforce content',
						x: Number.isFinite(data.x) ? data.x : 200,
						y: Number.isFinite(data.y) ? data.y : 200,
						values: {},
						_inaccessible: true,
						_permissionHidden: true,
						_permissionHiddenId: hiddenId,
					};
					canvasState.bulkRecords.push(target);
					setSkipNextCyAutoPan(true);
				}
				if (!target) {
					return;
				}
				if (Number.isFinite(data.x)) {
					target.x = data.x;
				}
				if (Number.isFinite(data.y)) {
					target.y = data.y;
				}
				renderBulkView();
			}

			async function _applyPeerDraftUpdate(data) {
				// Remote edits update local state without entering this user's undo stack or echoing immediately.
				if (!data || data.tempId == null) {
					return;
				}
				if (!Array.isArray(canvasState.bulkRecords)) {
					return;
				}
				const syncId = String(data.tempId);
				let target = _recordForRef({ refKind: 'draft', ref: syncId, collabRef: data.canvasRecordId });
				if (
					target &&
					data.canvasRecordId != null &&
					target._canvasRecordId != null &&
					String(data.canvasRecordId) !== String(target._canvasRecordId)
				)
					return;
				if (target && target.loadedFromId) return;
				let created = false;
				if (data.kind === 'remove') {
					if (target) {
						_lastBroadcastDraftValues.delete(_syncIdOf(target));
						const beforeLen = canvasState.bulkRecords.length;
						canvasState.bulkRecords = canvasState.bulkRecords.filter((r) => r !== target);
						if (canvasState.bulkRecords.length !== beforeLen) {
							if (
								canvasState.bulkSelectedIds &&
								typeof canvasState.bulkSelectedIds.delete === 'function'
							) {
								canvasState.bulkSelectedIds.delete(target.id);
							}
							try {
								renderBulkView();
							} catch (_) {}
						}
					}
					_lastBroadcastDraftValues.delete(syncId);
					return;
				}
				if (!target && data.kind === 'create') {
					const objName = data.objectName;
					if (!objName || typeof objName !== 'string') {
						return;
					}
					try {
						let sel = canvasState.selectedObjects.find((so) => so.name === objName);
						if (!sel) {
							sel = await addToSelection(objName);
						}
						if (!sel) {
							return;
						}
						const newRec = {
							id: canvasState.bulkIdSeq++,
							objectName: objName,
							label: sel.label || objName,
							x: typeof data.x === 'number' ? data.x : 200,
							y: typeof data.y === 'number' ? data.y : 200,
							values: {},
							fromSelectionId: sel.id,
							_collabId: syncId,
							_canvasRecordId: data.canvasRecordId || syncId,
						};
						if (data.slot && typeof data.slot === 'object') {
							newRec.slot = _incomingSlotCopy(data.slot);
							if (_localRole && _localRole !== 'owner') {
								newRec._recipientSlot = true;
							}
						}
						canvasState.bulkRecords.push(newRec);
						target = newRec;
						created = true;
					} catch (e) {
						console.warn('[presence draft-create] could not materialize peer draft:', e && e.message);
						return;
					}
				}
				if (!target) {
					return;
				}
				let touched = false;
				if (data.position && typeof data.position === 'object') {
					const px = typeof data.position.x === 'number' ? data.position.x : null;
					const py = typeof data.position.y === 'number' ? data.position.y : null;
					if (px != null && target.x !== px) {
						target.x = px;
						touched = true;
					}
					if (py != null && target.y !== py) {
						target.y = py;
						touched = true;
					}
				}
				if (data.fields && typeof data.fields === 'object') {
					const values = (target.values = target.values || {});
					for (const k of Object.keys(data.fields)) {
						const v = data.fields[k];
						if (v === null) {
							if (k in values) {
								delete values[k];
								touched = true;
							}
						} else if (values[k] !== v) {
							values[k] = v;
							touched = true;
						}
					}
				}
				_lastBroadcastDraftValues.set(_syncIdOf(target) || syncId, {
					values: _safeValueCopy(target.values, target.objectName),
					x: typeof target.x === 'number' ? target.x : null,
					y: typeof target.y === 'number' ? target.y : null,
					canvasRecordId: _ensureCanvasRecordId(target),
				});
				if (touched || created) {
					try {
						if (created) {
							setSkipNextCyAutoPan(true);
						}
						renderBulkView();
					} catch (_) {}
				}
				if (created) {
					_flushPendingDraftLinks();
				}
			}

			let _savedBanner = null;
			let _accessNotice = null;
			function _reloadCurrentCanvas() {
				const id = _currentCanvasId;
				if (id && /^[a-zA-Z0-9]{15,18}$/.test(id)) {
					window.location.href =
						(window.ORGLOOM_CANVAS_PATH || '/') + '?openCanvas=' + encodeURIComponent(id);
				} else {
					window.location.reload();
				}
			}

			function _clearAccessNotice() {
				if (!_accessNotice) {
					return;
				}
				try {
					_accessNotice.remove();
				} catch (_) {}
				_accessNotice = null;
			}

			function _showIncreasedAccess(role) {
				_clearAccessNotice();
				const label = role === 'editor' ? 'Editor' : 'Contributor';
				_accessNotice = document.createElement('div');
				_accessNotice.className = 'presence-saved-banner presence-access-banner';
				_accessNotice.setAttribute('role', 'status');
				_accessNotice.innerHTML =
					'<span class="presence-saved-icon" aria-hidden="true">&#8593;</span>' +
					'<span class="presence-saved-text"><strong>Your access is now ' +
					escapeHtml(label) +
					'.</strong> Reload to use your new permissions.</span>' +
					'<button type="button" class="presence-saved-btn" data-access-action="reload">Reload</button>' +
					'<button type="button" class="presence-saved-btn presence-saved-btn-secondary" data-access-action="dismiss">Later</button>';
				document.body.appendChild(_accessNotice);
				_accessNotice.addEventListener('click', (event) => {
					const button = event.target.closest && event.target.closest('[data-access-action]');
					if (!button) {
						return;
					}
					if (button.getAttribute('data-access-action') === 'reload') {
						_reloadCurrentCanvas();
					} else {
						_clearAccessNotice();
					}
				});
			}

			function _showRestrictedAccess({ role, revoked }) {
				_clearAccessNotice();
				_accessNotice = document.createElement('div');
				_accessNotice.className = 'modal presence-access-modal';
				_accessNotice.setAttribute('role', 'alertdialog');
				_accessNotice.setAttribute('aria-modal', 'true');
				const title = revoked ? 'Canvas access removed' : 'Your canvas access changed';
				const message = revoked
					? 'You no longer have access to this canvas.'
					: 'Your access is now ' +
						(role === 'contributor' ? 'Contributor' : 'View only') +
						'. Editing has stopped. Changes already shared may remain visible to collaborators. Changes that were not submitted or saved will not be applied.';
				_accessNotice.innerHTML =
					'<div class="modal-overlay"></div>' +
					'<div class="modal-body">' +
					'<div class="modal-header"><h3>' +
					escapeHtml(title) +
					'</h3></div>' +
					'<div class="modal-content"><p>' +
					escapeHtml(message) +
					'</p></div>' +
					'<div class="modal-footer"><button type="button" class="button" data-access-action="reload">' +
					(revoked ? 'Return to workspace' : 'Reload canvas') +
					'</button></div></div>';
				document.body.appendChild(_accessNotice);
				_accessNotice.addEventListener('click', (event) => {
					const button = event.target.closest && event.target.closest('[data-access-action="reload"]');
					if (!button) {
						return;
					}
					if (revoked) {
						window.location.href = '/workspace';
					} else {
						_reloadCurrentCanvas();
					}
				});
			}

			function _onAccessChanged(data) {
				const revoked = !!data.revoked || data.change === 'revoked';
				_localAccessRevoked = revoked;
				if (revoked || data.change === 'decreased') {
					_localCanEdit = false;
					_resetMutationTracking();
				}
				if (revoked) _resetCursorPublishing();
				onAccessChanged({
					role: data.role || null,
					previousRole: data.previousRole || null,
					change: data.change || null,
					revoked,
				});
				if (revoked || data.change === 'decreased') {
					_showRestrictedAccess({ role: data.role, revoked });
					return;
				}
				if (data.change === 'increased') {
					_showIncreasedAccess(data.role);
				}
			}

			async function _onCanvasSaved(data) {
				const meAcct = window.SF_ACCOUNT_ID || null;
				const yourSelfAcct = data.savedByAccountId || null;
				let isOwnSave = false;
				if (meAcct && yourSelfAcct) {
					isOwnSave = meAcct === yourSelfAcct;
				}
				if (!isOwnSave && _lastLocalSaveAt && Date.now() - _lastLocalSaveAt < 5000) {
					isOwnSave = true;
				}
				const savedRevision = Number.isSafeInteger(data.revision) ? data.revision : _serverRevision;
				_serverRevision = Math.max(_serverRevision, savedRevision);
				_durableRevision = Math.max(_durableRevision, savedRevision);
				if (isOwnSave) {
					if (
						canvasState.currentCanvas &&
						data.versionId &&
						_currentCanvasId === canvasState.currentCanvas.id
					) {
						canvasState.currentCanvas.versionId = data.versionId;
					}
					_latestAppliedRevision = Math.max(_latestAppliedRevision, savedRevision);
					_hasRevisionGap = false;
					return;
				}
				const name = data.savedByDisplayName || 'Someone';
				const currentHash = data.snapshotHash ? await _currentSnapshotHash() : null;
				if (currentHash && currentHash === data.snapshotHash) {
					if (
						canvasState.currentCanvas &&
						data.versionId &&
						_currentCanvasId === canvasState.currentCanvas.id
					) {
						canvasState.currentCanvas.versionId = data.versionId;
					}
					_latestAppliedRevision = Math.max(_latestAppliedRevision, savedRevision);
					_hasRevisionGap = false;
					_clearSavedBanner();
					try {
						showBulkToast(name + ' saved this canvas. Your view is current.', 'info');
					} catch (_) {}
					return;
				}
				if (_latestAppliedRevision > savedRevision && !_hasRevisionGap) {
					try {
						showBulkToast(name + ' saved this canvas. Newer live changes are still visible.', 'info');
					} catch (_) {}
					return;
				}
				if (!isCanvasDirty()) {
					const ok = await reloadCanvasFromServer();
					if (ok) {
						_refreshCurrentSubscription();
						_latestAppliedRevision = savedRevision;
						_hasRevisionGap = false;
						try {
							showBulkToast(name + ' saved this canvas, and your view updated.', 'info');
						} catch (_) {}
						return;
					}
				}
				_showSavedBanner({ name, at: data.at || Date.now() });
			}
			let _lastLocalSaveAt = 0;
			function noteLocalSave(result) {
				_lastLocalSaveAt = Date.now();
				if (result && Number.isSafeInteger(result.liveRevision)) {
					_latestAppliedRevision = Math.max(_latestAppliedRevision, result.liveRevision);
					_durableRevision = Math.max(_durableRevision, result.liveRevision);
					_serverRevision = Math.max(_serverRevision, result.liveRevision);
					_hasRevisionGap = false;
				}
			}

			function _clearSavedBanner() {
				if (!_savedBanner) {
					return;
				}
				try {
					_savedBanner.remove();
				} catch (_) {}
				_savedBanner = null;
			}

			function _showSavedBanner({ name, at }) {
				_clearSavedBanner();
				_savedBanner = document.createElement('div');
				_savedBanner.className = 'presence-saved-banner';
				_savedBanner.setAttribute('role', 'status');
				_savedBanner.innerHTML =
					'<span class="presence-saved-icon" aria-hidden="true">⟳</span>' +
					'<span class="presence-saved-text">' +
					'<strong>' +
					escapeHtml(name) +
					'</strong> just saved this canvas. ' +
					'Your view may be out of date.' +
					'</span>' +
					'<button type="button" class="presence-saved-btn" data-saved-action="reload">Reload</button>' +
					'<button type="button" class="presence-saved-btn presence-saved-btn-secondary" data-saved-action="dismiss">Keep editing</button>';
				document.body.appendChild(_savedBanner);
				_savedBanner.addEventListener('click', (ev) => {
					const btn = ev.target.closest('[data-saved-action]');
					if (!btn) {
						return;
					}
					const action = btn.getAttribute('data-saved-action');
					if (action === 'reload') {
						_reloadCurrentCanvas();
					} else if (action === 'dismiss') {
						try {
							_savedBanner.remove();
						} catch (_) {}
						_savedBanner = null;
					}
				});
			}

			function _viewportToWorld(clientX, clientY) {
				const cy = getCyInstance && getCyInstance();
				if (!cy || typeof cy.pan !== 'function' || typeof cy.zoom !== 'function') {
					return null;
				}
				const container = typeof cy.container === 'function' ? cy.container() : null;
				if (!container) {
					return null;
				}
				const rect = container.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) {
					return null;
				}
				const pan = cy.pan() || { x: 0, y: 0 };
				const zoom = cy.zoom();
				if (!zoom) {
					return null;
				}
				return {
					x: (clientX - rect.left - pan.x) / zoom,
					y: (clientY - rect.top - pan.y) / zoom,
				};
			}
			function _worldToLayerLocal(worldX, worldY) {
				const cy = getCyInstance && getCyInstance();
				if (!cy || typeof cy.pan !== 'function' || typeof cy.zoom !== 'function') {
					return null;
				}
				const container = typeof cy.container === 'function' ? cy.container() : null;
				if (!container || !_cursorLayer) {
					return null;
				}
				const containerRect = container.getBoundingClientRect();
				const layerRect = _cursorLayer.getBoundingClientRect();
				const pan = cy.pan() || { x: 0, y: 0 };
				const zoom = cy.zoom();
				if (!zoom) {
					return null;
				}
				const renderedX = worldX * zoom + pan.x;
				const renderedY = worldY * zoom + pan.y;
				return {
					x: renderedX + containerRect.left - layerRect.left,
					y: renderedY + containerRect.top - layerRect.top,
				};
			}

			function _resetCursorPublishing() {
				if (_cursorSendTimer !== null) clearTimeout(_cursorSendTimer);
				_cursorSendTimer = null;
				_pendingCursorPosition = null;
				const previous = _cursorRequest;
				_cursorRequest = null;
				// Cancel only when leaving a connection, never for ordinary movement.
				if (previous) previous.abort();
				_lastCursorPostAt = 0;
				_cursorPublished = false;
			}

			function _flushPendingCursor() {
				if (_localAccessRevoked || !_currentCanvasId || !_myConnectionId) return;
				if (!_pendingCursorPosition || _cursorRequest || _cursorSendTimer !== null) return;
				if (_peers.size === 0 && _pendingCursorPosition.x !== null) {
					_pendingCursorPosition = null;
					return;
				}
				const delay = CURSOR_THROTTLE_MS - (Date.now() - _lastCursorPostAt);
				if (delay > 0) {
					_cursorSendTimer = setTimeout(() => {
						_cursorSendTimer = null;
						_flushPendingCursor();
					}, delay);
					return;
				}
				const position = _pendingCursorPosition;
				_pendingCursorPosition = null;
				const controller = new AbortController();
				_cursorRequest = controller;
				_lastCursorPostAt = Date.now();
				async function send() {
					try {
						await csrfFetch('/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/cursor', {
							method: 'POST',
							credentials: 'same-origin',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								connectionId: _myConnectionId,
								sequence: _nextSequence(),
								...position,
							}),
							signal: controller.signal,
						});
					} catch (_) {
						// Cursor positions are ephemeral; send newer movement, not retries.
					} finally {
						if (_cursorRequest === controller) {
							_cursorRequest = null;
							_flushPendingCursor();
						}
					}
				}
				void send();
			}

			function _onMouseMove(ev) {
				if (_localAccessRevoked || !_currentCanvasId || !_myConnectionId || _peers.size === 0) {
					return;
				}
				const graph = getGraph();
				const host =
					graph && graph.querySelector
						? graph.querySelector('#graph-bulk') || graph.querySelector('#bulk-canvas')
						: null;
				if (!host) {
					return;
				}
				const rect = host.getBoundingClientRect();
				if (
					ev.clientX < rect.left ||
					ev.clientY < rect.top ||
					ev.clientX > rect.right ||
					ev.clientY > rect.bottom
				) {
					return;
				}
				const world = _viewportToWorld(ev.clientX, ev.clientY);
				let x, y, isWorld;
				if (world) {
					x = world.x;
					y = world.y;
					isWorld = true;
				} else {
					x = ev.clientX;
					y = ev.clientY;
					isWorld = false;
				}
				_cursorPublished = true;
				_pendingCursorPosition = { x, y, world: isWorld };
				_flushPendingCursor();
			}

			function _onMouseLeave() {
				_clearPublishedCursor();
			}

			function _clearPublishedCursor() {
				if (_localAccessRevoked || !_currentCanvasId || !_myConnectionId || !_cursorPublished) {
					return;
				}
				_cursorPublished = false;
				_pendingCursorPosition = { x: null, y: null };
				_flushPendingCursor();
			}

			function _attachMouseTracking() {
				const host = _canvasHost();
				if (!host) {
					return;
				}
				if (_mouseTrackingHost === host) {
					return;
				}
				if (_mouseTrackingHost && typeof _mouseTrackingHost.removeEventListener === 'function') {
					_mouseTrackingHost.removeEventListener('mousemove', _onMouseMove);
					_mouseTrackingHost.removeEventListener('mouseleave', _onMouseLeave);
				}
				host.addEventListener('mousemove', _onMouseMove);
				host.addEventListener('mouseleave', _onMouseLeave);
				_mouseTrackingHost = host;
			}

			// Loading is a read operation, not a sequence of shared record removals/additions.
			// Nesting covers the menu's fetch and the payload's asynchronous reconstruction.
			function beginCanvasLoad() {
				if (_canvasLoadDepth === 0) {
					_canvasLoadReady = _snapshotApplyPromise;
					_canvasLoadFailed = false;
					unsubscribe();
				}
				_canvasLoadDepth += 1;
				let finished = false;
				const finish = (success = true) => {
					if (finished) return;
					finished = true;
					if (!success) _canvasLoadFailed = true;
					_canvasLoadDepth -= 1;
					if (_canvasLoadDepth) return;
					if (_canvasLoadFailed) {
						showBulkToast(
							'Live sharing is paused because the canvas did not finish loading. Reload the canvas before editing.',
							'error',
						);
						return;
					}
					_canvasLoadReady = null;
					const id = _resolveCanvasId();
					if (id) subscribeToCanvas(id);
				};
				// Let an already-running snapshot finish before a replacement mutates local state.
				finish.ready = _canvasLoadReady;
				return finish;
			}

			function subscribeToCanvas(canvasId) {
				if (_canvasLoadDepth || _canvasLoadFailed) return;
				if (!canvasId) {
					return;
				}
				if (window.ORGLOOM_MOCK) {
					return;
				}
				if (canvasId === _currentCanvasId && _eventSource && _eventSource.readyState !== 2) {
					return;
				}
				if (
					_acknowledgedContributionCanvasId &&
					String(_acknowledgedContributionCanvasId) !== String(canvasId)
				) {
					_acknowledgedContributionIds.clear();
				}
				_acknowledgedContributionCanvasId = canvasId;
				const resumeCanvasRevision =
					String(canvasState._presenceCanvasId || '') === String(canvasId) &&
					Number.isSafeInteger(canvasState._presenceRevision)
						? canvasState._presenceRevision
						: null;
				const resumeCanvasWasDirty = !!isCanvasDirty();
				// Keep exactly one EventSource bound to the active saved canvas.
				unsubscribe();
				_resumeCanvasRevision = resumeCanvasRevision;
				_resumeCanvasWasDirty = resumeCanvasWasDirty;
				_currentCanvasId = canvasId;
				_outboundSequence = 0;
				_ensureCursorLayer();
				_attachMouseTracking();
				try {
					_eventSource = new EventSource(
						'/api/canvas/' + encodeURIComponent(canvasId) + '/presence/subscribe',
					);
				} catch (e) {
					console.warn('[presence] EventSource open failed:', e && e.message);
					return;
				}
				const source = _eventSource;
				source.addEventListener('presence-init', (e) => {
					if (_eventSource !== source) {
						return;
					}
					try {
						_onPresenceInit(JSON.parse(e.data));
					} catch (err) {
						window.ORGLOOM_capture && window.ORGLOOM_capture(err, { where: 'presence.js/sse/init' });
					}
				});
				source.addEventListener('presence', (e) => {
					if (_eventSource !== source) {
						return;
					}
					try {
						Promise.resolve(_onPresenceEvent(JSON.parse(e.data))).catch((err) => {
							window.ORGLOOM_capture && window.ORGLOOM_capture(err, { where: 'presence.js/sse/event' });
						});
					} catch (err) {
						window.ORGLOOM_capture && window.ORGLOOM_capture(err, { where: 'presence.js/sse/event' });
					}
				});
				source.addEventListener('error', () => {
					if (_eventSource !== source) {
						return;
					}
					_connectionHealthy = false;
					_myConnectionId = null;
					_fieldLocks.clear();
					_ownedFieldLeases.clear();
					onFieldLocksChanged();
				});
			}

			function _waitForPresenceReady(timeoutMs) {
				if (_connectionHealthy && _myConnectionId && _eventSource && _eventSource.readyState === 1) {
					return Promise.resolve(true);
				}
				return new Promise((resolve) => {
					let settled = false;
					const finish = (ready) => {
						if (settled) {
							return;
						}
						settled = true;
						resolve(ready);
					};
					_presenceReadyWaiters.push(finish);
					setTimeout(() => {
						_presenceReadyWaiters = _presenceReadyWaiters.filter((waiter) => waiter !== finish);
						finish(false);
					}, timeoutMs || 4000);
				});
			}

			async function _reconnectPresence() {
				const canvasId = _currentCanvasId;
				if (!canvasId) {
					return false;
				}
				_refreshCurrentSubscription();
				return _waitForPresenceReady(4000);
			}

			function _refreshCurrentSubscription() {
				const canvasId = _currentCanvasId;
				if (!canvasId) {
					return;
				}
				unsubscribe();
				subscribeToCanvas(canvasId);
			}

			function unsubscribe() {
				_subscriptionGeneration += 1;
				_resetCursorPublishing();
				if (_eventSource) {
					try {
						_eventSource.close();
					} catch (_) {}
					_eventSource = null;
				}
				_myConnectionId = null;
				_connectionHealthy = false;
				_currentCanvasId = null;
				_peers.clear();
				_cursorPublished = false;
				_hasLocalFocus = false;
				_lastLocalFocus = null;
				_localCanEdit = true;
				_localRole = null;
				_localAccessRevoked = false;
				_latestAppliedRevision = 0;
				_durableRevision = 0;
				_serverRevision = 0;
				_hasRevisionGap = false;
				_recoverOwnerStateAfterSnapshot = false;
				_resumeCanvasRevision = null;
				_resumeCanvasWasDirty = false;
				_snapshotApplyPromise = null;
				_applyingSnapshot = false;
				_queuedSnapshotEvents.length = 0;
				_awaitingLayoutSnapshot = false;
				_fieldLocks.clear();
				_ownedFieldLeases.clear();
				_lastBroadcastDraftValues.clear();
				_lastBroadcastLoadedRefs.clear();
				_lastBroadcastLoadedRecords.clear();
				_lastBroadcastSlots.clear();
				_lastBroadcastLinks.clear();
				_pendingLayoutPositions.clear();
				_resetMutationTracking();
				if (_cursorLayer) {
					_cursorLayer.innerHTML = '';
				}
				_renderChips();
			}

			function _publishLocalFocus() {
				if (
					_localAccessRevoked ||
					!_currentCanvasId ||
					!_myConnectionId ||
					_peers.size === 0 ||
					!_hasLocalFocus
				) {
					return;
				}
				csrfFetch('/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/focus', {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						connectionId: _myConnectionId,
						sequence: _nextSequence(),
						focus: _lastLocalFocus,
					}),
				}).catch(() => {});
			}

			function pushFocus(focus) {
				_hasLocalFocus = true;
				_lastLocalFocus = focus || null;
				_publishLocalFocus();
			}

			function fieldLockFor(record, fieldName) {
				const reference = _recordReference(record);
				const key = _fieldLockKey(reference, fieldName);
				const lock = key && _fieldLocks.get(key);
				if (!lock || lock.expiresAt <= Date.now()) {
					if (key) {
						_fieldLocks.delete(key);
						_ownedFieldLeases.delete(key);
					}
					return null;
				}
				const owned = lock.connectionId === _myConnectionId;
				const peer = !owned ? _peers.get(lock.connectionId) : null;
				const focus = peer && peer.focus;
				const active =
					!!focus &&
					focus.kind === 'record' &&
					focus.fieldName === fieldName &&
					focus.refKind === reference.refKind &&
					String(focus.ref) === String(reference.ref) &&
					(focus.collabRef == null ||
						reference.collabRef == null ||
						String(focus.collabRef) === String(reference.collabRef));
				return Object.assign({}, lock, { owned: owned, active: active });
			}

			async function acquireFieldLock(record, fieldName, options) {
				if (!_currentCanvasId) {
					return { ok: true, localOnly: true };
				}
				if (!_myConnectionId || !_connectionHealthy) {
					const ready = await _waitForPresenceReady(4000);
					if (!ready) {
						return {
							ok: false,
							reason: 'presence-not-ready',
							message: 'Live collaboration is reconnecting. Wait a moment and try this field again.',
						};
					}
				}
				const targetRef = _recordReference(record);
				const key = _fieldLockKey(targetRef, fieldName);
				if (!key) {
					return { ok: false, reason: 'field-lock-unavailable' };
				}
				const existing = _fieldLocks.get(key);
				if (existing && existing.connectionId === _myConnectionId && existing.expiresAt > Date.now()) {
					return { ok: true, lock: existing };
				}
				const response = await csrfFetch(
					'/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/field-lock',
					{
						method: 'POST',
						credentials: 'same-origin',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							connectionId: _myConnectionId,
							targetRef,
							fieldName,
							takeover: !!(options && options.takeover),
						}),
					},
				);
				const data = await response.json().catch(() => null);
				if (!response.ok || !data || !data.ok) {
					if (
						data &&
						(data.error === 'presence-connection-stale' || data.error === 'field-lock-rejected') &&
						!(options && options.connectionRetry)
					) {
						_connectionHealthy = false;
						_myConnectionId = null;
						_fieldLocks.clear();
						_ownedFieldLeases.clear();
						if (await _reconnectPresence()) {
							return acquireFieldLock(
								record,
								fieldName,
								Object.assign({}, options || {}, { connectionRetry: true }),
							);
						}
					}
					if (data && data.lock) {
						_rememberFieldLock(data.lock);
					}
					onFieldLocksChanged(targetRef, fieldName, data && data.lock);
					return {
						ok: false,
						reason: (data && data.error) || 'field-lock-unavailable',
						message: data && data.message,
						lock: data && data.lock,
					};
				}
				_rememberFieldLock(data.lock);
				onFieldLocksChanged(targetRef, fieldName, data.lock);
				return data;
			}

			async function commitRecordFields(record, fields, options) {
				options?.beforeCommit?.();
				const names = Object.keys(fields || {});
				if (names.length === 0 || !_currentCanvasId) {
					return { ok: true, localOnly: true };
				}
				if (!_myConnectionId) {
					throw new Error('Live collaboration is still connecting. Wait a moment and try again.');
				}
				const targetRef = _recordReference(record);
				const leases = {};
				for (const fieldName of names) {
					const acquired = await acquireFieldLock(record, fieldName);
					if (!acquired.ok) {
						throw new Error(
							acquired.message ||
								((acquired.lock && acquired.lock.displayName) || 'Another user') +
									' is editing ' +
									fieldName +
									'.',
						);
					}
					if (acquired.localOnly) {
						continue;
					}
					leases[fieldName] = {
						leaseId: acquired.lock.leaseId,
						baseVersion: acquired.lock.baseVersion,
					};
				}
				let endpoint = '/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/fields';
				let body = {
					connectionId: _myConnectionId,
					targetRef,
					fields,
					leases,
				};
				if (_localRole === 'contributor') {
					if (!record || !record.slot || record.slot.slotId == null) {
						throw new Error('This record is no longer an active contributor request.');
					}
					endpoint = '/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/slot-fill';
					body = {
						fills: [
							{
								slotId: record.slot.slotId,
								values: fields,
								...(options && Array.isArray(options.relationshipFields)
									? { relationshipFields: options.relationshipFields }
									: {}),
							},
						],
						liveCommit: { connectionId: _myConnectionId, targetRef, leases },
						notifyOwner: false,
					};
				}
				options?.beforeCommit?.();
				const response = await csrfFetch(endpoint, {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				});
				const data = await response.json().catch(() => null);
				if (!response.ok || !data || data.ok === false) {
					const conflict =
						data && Array.isArray(data.conflicts) && data.conflicts.length > 0 ? data.conflicts[0] : null;
					const actor =
						conflict && conflict.lock && conflict.lock.displayName
							? conflict.lock.displayName
							: 'Another user';
					throw new Error(
						(data && data.message) ||
							actor + ' changed or is editing this field. Review the current value and try again.',
					);
				}
				_observeRevision(data.revision);
				for (const fieldName of names) {
					const key = _fieldLockKey(targetRef, fieldName);
					if (key) {
						_fieldLocks.delete(key);
						_ownedFieldLeases.delete(key);
					}
				}
				setTimeout(_seedLoadedRecordBaselines, 0);
				return data;
			}

			function releaseRecordFieldLocks(record) {
				const reference = _recordReference(record);
				for (const [key, lock] of Array.from(_ownedFieldLeases.entries())) {
					if (
						!reference ||
						!lock.targetRef ||
						_fieldLockKey(reference, lock.fieldName) !== _fieldLockKey(lock.targetRef, lock.fieldName)
					) {
						continue;
					}
					_ownedFieldLeases.delete(key);
					_fieldLocks.delete(key);
					csrfFetch('/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/field-lock/release', {
						method: 'POST',
						credentials: 'same-origin',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							connectionId: _myConnectionId,
							leaseId: lock.leaseId,
						}),
					}).catch(() => {});
				}
			}

			function releaseFieldLock(record, fieldName) {
				const reference = _recordReference(record);
				const key = _fieldLockKey(reference, fieldName);
				const lock = key && _ownedFieldLeases.get(key);
				if (!lock || !_currentCanvasId || !_myConnectionId) {
					return false;
				}
				_ownedFieldLeases.delete(key);
				_fieldLocks.delete(key);
				csrfFetch('/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/field-lock/release', {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						connectionId: _myConnectionId,
						leaseId: lock.leaseId,
					}),
				}).catch(() => {});
				return true;
			}

			function acknowledgedContributionIds() {
				return Array.from(_acknowledgedContributionIds).slice(0, 500);
			}

			function markContributionIdsSaved(ids) {
				for (const contributionId of Array.isArray(ids) ? ids : []) {
					_acknowledgedContributionIds.delete(String(contributionId));
				}
			}

			function _layoutPositionKey(position) {
				if (position.hiddenId != null) {
					return 'hidden:' + String(position.hiddenId);
				}
				if (position.collabRef != null) {
					return 'card:' + String(position.collabRef);
				}
				return JSON.stringify([
					position.refKind,
					position.ref,
					position.collabRef == null ? null : position.collabRef,
				]);
			}

			function _currentPendingLayouts() {
				const records = new Map();
				for (const record of canvasState.bulkRecords || []) {
					const reference = _recordReference(record);
					if (reference) records.set(_layoutPositionKey(reference), { record, reference });
				}
				const ready = [];
				for (const [key, position] of _pendingLayoutPositions) {
					const current = records.get(key);
					if (!current) {
						_pendingLayoutPositions.delete(key);
						continue;
					}
					const { record, reference } = current;
					// Keep stable card identity, but refresh natural refs after save,
					// promotion or slot changes. Never fall back to a different card
					// displaying the same Salesforce record.
					const next = Object.assign({}, reference, { x: position.x, y: position.y });
					_pendingLayoutPositions.set(key, next);
					const known =
						reference.hiddenId != null ||
						(record.loadedFromId
							? _lastBroadcastLoadedRefs.get(reference.collabRef) === String(record.loadedFromId)
							: _lastBroadcastDraftValues.has(_syncIdOf(record)));
					if (known && ready.length < 500) ready.push([key, next]);
				}
				if (_pendingLayoutPositions.size === 0) _forgetObsoleteMutation('layout');
				return ready;
			}

			function _flushPendingLayouts() {
				if (_awaitingLayoutSnapshot || _snapshotApplyPromise) return;
				if (!_localCanEdit || !_currentCanvasId || !_myConnectionId || _pendingLayoutPositions.size === 0) {
					return;
				}
				if (_currentPendingLayouts().length === 0) return;
				let sent = [];
				_sendDesiredMutation(
					'layout',
					() => {
						// Recheck at dispatch as well as enqueue: earlier mutations may
						// have removed or replaced a card while this request waited.
						if (_awaitingLayoutSnapshot || _snapshotApplyPromise) return null;
						sent = _currentPendingLayouts();
						if (sent.length === 0) return null;
						return csrfFetch('/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/layout', {
							method: 'POST',
							credentials: 'same-origin',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								connectionId: _myConnectionId,
								sequence: _nextSequence(),
								positions: sent.map((entry) => entry[1]),
							}),
						});
					},
					() => {
						for (const [key, position] of sent) {
							const pending = _pendingLayoutPositions.get(key);
							if (
								pending &&
								pending.x === position.x &&
								pending.y === position.y &&
								pending.refKind === position.refKind &&
								pending.ref === position.ref &&
								pending.collabRef === position.collabRef
							) {
								_pendingLayoutPositions.delete(key);
							}
						}
					},
				);
			}

			function publishLayout(records) {
				if (_canvasLoadDepth || _canvasLoadFailed || _applyingSnapshot || _awaitingLayoutSnapshot) return;
				if (!_localCanEdit || !_currentCanvasId || !Array.isArray(records)) {
					return;
				}
				records
					.map((record) => {
						const reference = _recordReference(record);
						if (!reference || !Number.isFinite(record.x) || !Number.isFinite(record.y)) {
							return null;
						}
						return Object.assign(reference, { x: record.x, y: record.y });
					})
					.filter(Boolean)
					.forEach((position) => {
						_pendingLayoutPositions.set(_layoutPositionKey(position), position);
					});
				_flushPendingLayouts();
			}

			let _lastSeenId = null;
			setInterval(() => {
				if (_canvasLoadDepth || _canvasLoadFailed) return;
				const id = _resolveCanvasId();
				const sourceClosed = _eventSource && _eventSource.readyState === 2;
				if (id && (id !== _lastSeenId || sourceClosed)) {
					_lastSeenId = id;
					subscribeToCanvas(id);
				} else if (!id && _lastSeenId) {
					_lastSeenId = null;
					unsubscribe();
				}
				if (_currentCanvasId) {
					_ensureCursorLayer();
					_attachMouseTracking();
				}
				_reapplyAllFocus();
				for (const peer of _peers.values()) {
					if (peer && peer.cursor) {
						_renderCursor(peer);
					}
				}
				_positionChipStrip();
			}, 2000);

			setInterval(() => {
				_broadcastDraftDeltas();
				_flushPendingLayouts();
			}, DRAFT_BROADCAST_INTERVAL_MS);

			setInterval(() => {
				if (!_currentCanvasId || !_myConnectionId) {
					return;
				}
				for (const lock of _ownedFieldLeases.values()) {
					if (!lock || lock.expiresAt - Date.now() > 20_000) {
						continue;
					}
					csrfFetch('/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/field-lock/renew', {
						method: 'POST',
						credentials: 'same-origin',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							connectionId: _myConnectionId,
							leaseId: lock.leaseId,
						}),
					})
						.then((response) => (response.ok ? response.json() : null))
						.then((data) => {
							if (data && data.lock) {
								_rememberFieldLock(data.lock);
							}
						})
						.catch(() => {});
				}
			}, 15_000);

			window.addEventListener('beforeunload', unsubscribe);

			window.addEventListener('resize', () => {
				for (const peer of _peers.values()) {
					if (peer && peer.cursor) {
						_renderCursor(peer);
					}
				}
				_reapplyAllFocus();
				_positionChipStrip();
			});

			return {
				beginCanvasLoad: beginCanvasLoad,
				subscribeToCanvas: subscribeToCanvas,
				unsubscribe: unsubscribe,
				pushFocus: pushFocus,
				publishLayout: publishLayout,
				publishChanges: _broadcastDraftDeltas,
				noteLocalSave: noteLocalSave,
				fieldLockFor: fieldLockFor,
				acquireFieldLock: acquireFieldLock,
				commitRecordFields: commitRecordFields,
				releaseFieldLock: releaseFieldLock,
				releaseRecordFieldLocks: releaseRecordFieldLocks,
				acknowledgedContributionIds: acknowledgedContributionIds,
				markContributionIdsSaved: markContributionIdsSaved,
			};
		},
	};
})();

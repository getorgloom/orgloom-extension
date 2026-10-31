(function () {
	'use strict';
	// Represents pending record slots and materializes them into concrete drafts when filled.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.typeNode = {
		mount: function mount(deps) {
			const required = [
				'canvasState',
				'csrfFetch',
				'escapeHtml',
				'showBulkToast',
				'showBulkToastWithAction',
				'_canvasCapBlockReason',
				'_smoothScrollCanvas',
				'addToSelection',
				'inferAssociationsForRecord',
				'purgeRedundantTypeNodes',
				'renderBulkView',
				'showLargeRelatedConfirm',
				'showRelatedSearchModal',
				'seedEditModeTypeNodes',
				'fetchRelatedCount',
				'fetchByRefCached',
				'_countCacheKey',
				'_sfIdMatch',
				'_relatedCountCache',
				'_byRefCache',
				'_RELATED_BULK_LOAD_CAP',
				'_RELATED_SOFT_THRESHOLD',
				'getGraph',
				'getBulkRenderShiftX',
				'getBulkRenderShiftY',
			];
			if (!deps) {
				throw new Error('type-node.mount: missing deps object');
			}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('type-node.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const refreshCapabilities =
				typeof deps.refreshCapabilities === 'function' ? deps.refreshCapabilities : function () {};
			const escapeHtml = deps.escapeHtml;
			const showBulkToast = deps.showBulkToast;
			const showBulkToastWithAction = deps.showBulkToastWithAction;
			const _canvasCapBlockReason = deps._canvasCapBlockReason;
			const canvasCapCheck =
				typeof deps.canvasCapCheck === 'function'
					? deps.canvasCapCheck
					: function () {
							return { ok: true, blocked: false, reason: null };
						};
			const _smoothScrollCanvas = deps._smoothScrollCanvas;
			const addToSelection = deps.addToSelection;
			const inferAssociationsForRecord = deps.inferAssociationsForRecord;
			const purgeRedundantTypeNodes = deps.purgeRedundantTypeNodes;
			const renderBulkView = deps.renderBulkView;
			const showLargeRelatedConfirm = deps.showLargeRelatedConfirm;
			const showRelatedSearchModal = deps.showRelatedSearchModal;
			const seedEditModeTypeNodes = deps.seedEditModeTypeNodes;
			const fetchRelatedCount = deps.fetchRelatedCount;
			const fetchByRefCached = deps.fetchByRefCached;
			const _countCacheKey = deps._countCacheKey;
			const _sfIdMatch = deps._sfIdMatch;
			const _relatedCountCache = deps._relatedCountCache;
			const _byRefCache = deps._byRefCache;
			const _RELATED_BULK_LOAD_CAP = deps._RELATED_BULK_LOAD_CAP;
			const _RELATED_SOFT_THRESHOLD = deps._RELATED_SOFT_THRESHOLD;
			const getGraph = deps.getGraph;
			const getBulkRenderShiftX = deps.getBulkRenderShiftX;
			const getBulkRenderShiftY = deps.getBulkRenderShiftY;
			const responseError = async (response, fallback) => {
				const body = await response.json().catch(() => ({}));
				const error = new Error(body.message || response.statusText || fallback);
				error.status = response.status;
				error.code = body.error || null;
				return error;
			};
			const refreshAfterBrowseDenial = (error) => {
				if (!error || error.status !== 403) {
					return;
				}
				Promise.resolve(refreshCapabilities()).catch(() => {});
			};
			const relatedPlacementBounds = (record) => {
				const halfWidth = record.isTypeNode ? 65 : 120;
				const halfHeight = record.isTypeNode ? 65 : 90;
				return {
					left: record.x - halfWidth,
					right: record.x + halfWidth,
					top: record.y - halfHeight,
					bottom: record.y + halfHeight,
				};
			};
			const relatedPlacementsOverlap = (a, b) =>
				!(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
			const findOpenRelatedPosition = (preferredX, preferredY, originX, originY, ignoredRecordId) => {
				const angle = Math.atan2(preferredY - originY, preferredX - originX);
				let radius = Math.hypot(preferredX - originX, preferredY - originY);
				const probe = { x: preferredX, y: preferredY, isTypeNode: false };
				const pushStep = 30;
				const maxPushes = 30;

				for (let step = 0; step <= maxPushes; step++) {
					probe.x = originX + radius * Math.cos(angle);
					probe.y = originY + radius * Math.sin(angle);
					const bounds = relatedPlacementBounds(probe);
					const collision = canvasState.bulkRecords.some(
						(other) =>
							other.id !== ignoredRecordId &&
							relatedPlacementsOverlap(bounds, relatedPlacementBounds(other)),
					);
					if (!collision) {
						return { x: probe.x, y: probe.y };
					}
					radius += pushStep;
				}

				return { x: probe.x, y: probe.y };
			};

			function spawnFreeTypeNode(objectName) {
				const meta = (Array.isArray(canvasState.allObjects) ? canvasState.allObjects : []).find(
					(o) => o.name === objectName,
				);
				const label = (meta && meta.label) || objectName;
				const canvas = getGraph().querySelector('#bulk-canvas');
				const cw = (canvas && canvas.clientWidth) || 800;
				const ch = (canvas && canvas.clientHeight) || 600;
				const sl = (canvas && canvas.scrollLeft) || 0;
				const st = (canvas && canvas.scrollTop) || 0;
				const worldX = (sl + cw / 2) / canvasState.bulkZoom - getBulkRenderShiftX();
				const worldY = (st + ch / 2) / canvasState.bulkZoom - getBulkRenderShiftY();
				canvasState.bulkRecords.push({
					id: canvasState.bulkIdSeq++,
					isTypeNode: true,
					isFreeTypeNode: true,
					objectName,
					label,
					x: worldX,
					y: worldY,
				});
				renderBulkView();
				showBulkToast('Added ' + label + '; click "Pick record" to load one.');
			}

			function pickRecordForFreeTypeNode(rec, anchorEl) {
				document.querySelectorAll('.find-object-popup, .free-tn-picker').forEach((el) => el.remove());
				const pop = document.createElement('div');
				pop.className = 'find-object-popup free-tn-picker';
				pop.style.width = '320px';
				let left, top;
				if (anchorEl && typeof anchorEl.getBoundingClientRect === 'function') {
					const r = anchorEl.getBoundingClientRect();
					left = Math.min(r.left, window.innerWidth - 328);
					top = r.bottom + 6;
				} else {
					const canvas = getGraph().querySelector('#bulk-canvas');
					const canvasRect = canvas ? canvas.getBoundingClientRect() : { left: 8, top: 8 };
					const screenX =
						(rec.x + getBulkRenderShiftX()) * canvasState.bulkZoom - (canvas ? canvas.scrollLeft : 0);
					const screenY =
						(rec.y + getBulkRenderShiftY()) * canvasState.bulkZoom - (canvas ? canvas.scrollTop : 0);
					left = Math.min(canvasRect.left + screenX + 70, window.innerWidth - 328);
					top = Math.min(canvasRect.top + screenY - 20, window.innerHeight - 320);
				}
				pop.style.left = Math.max(8, left) + 'px';
				pop.style.top = Math.max(8, top) + 'px';
				pop.innerHTML =
					'<div class="fop-header">' +
					escapeHtml(rec.label || rec.objectName) +
					'</div>' +
					'<div class="fop-sub">' +
					(rec.objectName === 'Case'
						? 'Search by case number or subject, or paste a 15/18-character record ID.'
						: 'Search by record name or paste a 15/18-character record ID.') +
					'</div>' +
					'<input type="search" class="fop-search ftnp-search" placeholder="Search\u2026" autocomplete="off">' +
					'<div class="fop-list ftnp-list"></div>';
				document.body.appendChild(pop);
				const input = pop.querySelector('.ftnp-search');
				const list = pop.querySelector('.ftnp-list');
				let seq = 0;
				const fetchById = async (id) => {
					list.innerHTML = '<div class="fop-empty">Loading record\u2026</div>';
					try {
						const resp = await csrfFetch(
							'/api/objects/' + encodeURIComponent(rec.objectName) + '/records/' + encodeURIComponent(id),
							{ credentials: 'same-origin' },
						);
						if (!resp.ok) {
							throw await responseError(resp, 'Could not load this record.');
						}
						const single = await resp.json();
						cleanup();
						await loadRecordIntoFreeTypeNode(rec, single);
					} catch (e) {
						refreshAfterBrowseDenial(e);
						list.innerHTML =
							'<div class="fop-empty">' +
							escapeHtml(e.message || 'Could not load this record.') +
							'</div>';
					}
				};
				const runSearch = async () => {
					const q = (input.value || '').trim();
					if (/^[a-zA-Z0-9]{15,18}$/.test(q)) {
						fetchById(q);
						return;
					}
					if (!q) {
						list.innerHTML = '';
						return;
					}
					const mySeq = ++seq;
					list.innerHTML = '<div class="fop-empty">Searching\u2026</div>';
					try {
						const resp = await csrfFetch(
							'/api/objects/' + encodeURIComponent(rec.objectName) + '/search?q=' + encodeURIComponent(q),
							{ credentials: 'same-origin' },
						);
						if (!resp.ok) {
							throw await responseError(resp, 'Search failed.');
						}
						const data = await resp.json();
						if (mySeq !== seq) {
							return;
						}
						const records = (data && data.records) || [];
						if (records.length === 0) {
							list.innerHTML = '<div class="fop-empty">No matches.</div>';
							return;
						}
						const onCanvas = new Set(
							canvasState.bulkRecords
								.filter((b) => !b.isTypeNode && b.objectName === rec.objectName && b.loadedFromId)
								.map((b) => b.loadedFromId),
						);
						list.innerHTML = records
							.map((r) => {
								const already = onCanvas.has(r.id);
								return (
									'<button type="button" class="fop-item' +
									(already ? ' is-already' : '') +
									'" data-pick-id="' +
									escapeHtml(r.id) +
									'"' +
									(already ? ' disabled title="Already on the canvas"' : '') +
									'>' +
									'<span class="fop-label">' +
									escapeHtml(r.name || '(no name)') +
									'</span>' +
									'<span class="fop-name">' +
									escapeHtml(r.id) +
									(already ? ' \u00b7 already loaded' : '') +
									'</span>' +
									'</button>'
								);
							})
							.join('');
					} catch (e) {
						if (mySeq !== seq) {
							return;
						}
						refreshAfterBrowseDenial(e);
						const message =
							e && e.status === 403
								? e.message || 'Your workspace access does not include Browse records.'
								: 'Search failed: ' + (e.message || String(e));
						list.innerHTML = '<div class="fop-empty">' + escapeHtml(message) + '</div>';
					}
				};
				let timer;
				input.addEventListener('input', () => {
					clearTimeout(timer);
					timer = setTimeout(runSearch, 250);
				});
				list.addEventListener('click', (ev) => {
					const btn = ev.target.closest('[data-pick-id]');
					if (!btn || btn.disabled) {
						return;
					}
					fetchById(btn.dataset.pickId);
				});
				setTimeout(() => input.focus(), 0);
				const cleanup = () => {
					if (pop.parentNode) {
						pop.remove();
					}
					document.removeEventListener('mousedown', outside, true);
					document.removeEventListener('keydown', onEsc, true);
				};
				const outside = (ev) => {
					if (!pop.contains(ev.target)) {
						cleanup();
					}
				};
				const onEsc = (ev) => {
					if (ev.key === 'Escape') {
						cleanup();
					}
				};
				setTimeout(() => {
					document.addEventListener('mousedown', outside, true);
					document.addEventListener('keydown', onEsc, true);
				}, 0);
			}

			async function loadRecordIntoFreeTypeNode(typeNodeRec, sfRecord) {
				// Reuse an existing canvas record instead of creating a duplicate Salesforce identity.
				if (!sfRecord || !sfRecord.Id) {
					showBulkToast('Record could not be loaded.', 'error');
					return;
				}
				const dup = canvasState.bulkRecords.find(
					(r) => !r.isTypeNode && r.objectName === typeNodeRec.objectName && r.loadedFromId === sfRecord.Id,
				);
				if (dup) {
					const i = canvasState.bulkRecords.findIndex((b) => b.id === typeNodeRec.id);
					if (i !== -1) {
						canvasState.bulkRecords.splice(i, 1);
					}
					canvasState.bulkSelectedIds.clear();
					canvasState.bulkSelectedIds.add(dup.id);
					renderBulkView();
					const canvas = getGraph().querySelector('#bulk-canvas');
					if (canvas) {
						const targetLeft = Math.max(
							0,
							(dup.x + getBulkRenderShiftX()) * canvasState.bulkZoom - canvas.clientWidth / 2,
						);
						const targetTop = Math.max(
							0,
							(dup.y + getBulkRenderShiftY()) * canvasState.bulkZoom - canvas.clientHeight / 2,
						);
						if (typeof _smoothScrollCanvas === 'function') {
							_smoothScrollCanvas(canvas, targetLeft, targetTop, 600);
						} else {
							canvas.scrollLeft = targetLeft;
							canvas.scrollTop = targetTop;
						}
					}
					showBulkToast('That record is already on the canvas.');
					return;
				}
				const cap = canvasCapCheck(1);
				if (cap.blocked) {
					showBulkToast(cap.reason);
					return;
				}
				let targetSel = canvasState.selectedObjects.find((s) => s.name === typeNodeRec.objectName);
				if (!targetSel) {
					try {
						targetSel = await addToSelection(typeNodeRec.objectName);
					} catch (e) {
						console.warn('addToSelection failed for', typeNodeRec.objectName, e);
					}
				}
				const recToValues = (r) => {
					const v = {};
					Object.keys(r).forEach((k) => {
						if (k !== 'attributes' && r[k] != null) {
							v[k] = r[k];
						}
					});
					return v;
				};
				const values = recToValues(sfRecord);
				// Reuse the placeholder ID so edges already targeting the type node remain valid.
				const newRec = {
					id: typeNodeRec.id != null ? typeNodeRec.id : canvasState.bulkIdSeq++,
					objectName: typeNodeRec.objectName,
					label: targetSel ? targetSel.label : typeNodeRec.objectName,
					x: typeNodeRec.x,
					y: typeNodeRec.y,
					values,
					loadedFromId: sfRecord.Id,
					loadedValues: Object.assign({}, values),
					fromSelectionId: targetSel ? targetSel.id : null,
					_seedingTypes: !!targetSel,
				};
				const idx = canvasState.bulkRecords.findIndex((b) => b.id === typeNodeRec.id);
				if (idx !== -1) {
					canvasState.bulkRecords.splice(idx, 1);
				}
				canvasState.bulkRecords.push(newRec);
				const inferredLinks = inferAssociationsForRecord(newRec, targetSel);
				purgeRedundantTypeNodes();
				renderBulkView();
				if (targetSel) {
					const others = canvasState.bulkRecords.filter((r) => r.id !== newRec.id);
					let seedOpts = {};
					if (others.length > 0) {
						let cx = 0,
							cy = 0;
						others.forEach((r) => {
							cx += r.x;
							cy += r.y;
						});
						seedOpts = { outwardFrom: { x: cx / others.length, y: cy / others.length } };
					}
					seedEditModeTypeNodes(newRec, targetSel, seedOpts)
						.catch((e) => console.warn('seedEditModeTypeNodes (free) failed:', e))
						.finally(() => {
							newRec._seedingTypes = false;
							renderBulkView();
						});
				}
				const linkSuffix =
					inferredLinks > 0
						? ' (' + inferredLinks + ' link' + (inferredLinks === 1 ? '' : 's') + ' to existing records)'
						: '';
				showBulkToast('Loaded ' + (newRec.label || newRec.objectName) + linkSuffix + '.');
			}

			function openRelatedSearchFlow({ rec, base }) {
				const targetType = rec.objectName;
				const fkField = rec.fieldOnOther; // child-direction only; parent dir doesn't hit the threshold
				showRelatedSearchModal({
					targetType,
					targetLabel: rec.label || targetType,
					fkField,
					hostId: base.loadedFromId,
					hostLabel: base.label || base.objectName,
					onPick: async ({ id }) => {
						const resp = await csrfFetch(
							'/api/objects/' + encodeURIComponent(targetType) + '/records/' + encodeURIComponent(id),
							{ credentials: 'same-origin' },
						);
						if (!resp.ok) {
							throw new Error(resp.statusText);
						}
						const fullRec = await resp.json();
						if (!canvasState.bulkRecords.some((b) => b.id === rec.id)) {
							canvasState.bulkRecords.push(rec);
						}
						await openTypeNode(rec, { recordsOverride: [fullRec], preserveTypeNode: true });
					},
				});
			}

			async function openTypeNode(rec, opts) {
				opts = opts || {};
				if (!rec || !rec.isTypeNode) {
					return;
				}
				if (rec.isFreeTypeNode) {
					pickRecordForFreeTypeNode(rec);
					return;
				}
				const base = canvasState.bulkRecords.find((b) => b.id === rec.hostRecordId);
				if (!base || !base.loadedFromId) {
					showBulkToast('Base record is not loaded.', 'error');
					return;
				}
				const targetType = rec.objectName;
				if (!opts.recordsOverride) {
					let willAdd = 1;
					if (rec.direction === 'child') {
						const k = _countCacheKey(targetType, rec.fieldOnOther, base.loadedFromId);
						const cached = _relatedCountCache.get(k);
						willAdd = Math.min(typeof cached === 'number' ? cached : 50, _RELATED_BULK_LOAD_CAP);
					}
					const blocked = _canvasCapBlockReason(willAdd);
					if (blocked) {
						showBulkToast(blocked);
						return;
					}
				}
				if (!opts.recordsOverride && rec.direction === 'child') {
					const countKey = _countCacheKey(targetType, rec.fieldOnOther, base.loadedFromId);
					let cachedCount = _relatedCountCache.get(countKey);
					if (cachedCount == null) {
						rec._loading = true;
						renderBulkView();
						try {
							cachedCount = await fetchRelatedCount(targetType, rec.fieldOnOther, base.loadedFromId);
						} catch (_eCount) {
							cachedCount = null; // fall through; rare server fail shouldn't block load
						}
						rec._loading = false;
					}
					if (cachedCount != null && cachedCount > _RELATED_SOFT_THRESHOLD) {
						const choice = await showLargeRelatedConfirm({
							targetLabel: rec.label || targetType,
							count: cachedCount,
							hostLabel: base.label || base.objectName,
						});
						if (choice === 'cancel') {
							return;
						}
						if (choice === 'search') {
							openRelatedSearchFlow({ rec, base });
							return;
						}
					}
				}
				rec._loading = true;
				renderBulkView();
				try {
					let records = [];
					if (opts.recordsOverride) {
						records = opts.recordsOverride;
					} else if (rec.direction === 'child') {
						records = await fetchByRefCached(targetType, rec.fieldOnOther, base.loadedFromId, {
							forceRefresh: true,
						});
					} else {
						const cacheKey = _countCacheKey(targetType, 'Id', rec.parentId);
						const resp = await csrfFetch(
							'/api/objects/' +
								encodeURIComponent(targetType) +
								'/records/' +
								encodeURIComponent(rec.parentId),
						);
						if (!resp.ok) {
							throw new Error(resp.statusText);
						}
						const single = await resp.json();
						records = single ? [single] : [];
						_byRefCache.set(cacheKey, records);
					}
					if (records.length === 0) {
						rec._loading = false;
						if (!opts.preserveTypeNode) {
							const i = canvasState.bulkRecords.findIndex((b) => b.id === rec.id);
							if (i !== -1) {
								canvasState.bulkRecords.splice(i, 1);
							}
						}
						showBulkToast('No related records found.', 'info');
						renderBulkView();
						return;
					}
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
					let targetSel = canvasState.selectedObjects.find((s) => s.name === targetType);
					if (!targetSel) {
						try {
							targetSel = await addToSelection(targetType, base.fromSelectionId, {
								direction: rec.direction === 'child' ? 'child' : 'parent',
								fieldName: rec.direction === 'child' ? rec.fieldOnOther : rec.fieldOnThis,
							});
						} catch (e) {
							console.warn('addToSelection failed for', targetType, e);
						}
					}
					const targetSelId = targetSel ? targetSel.id : null;
					// A fetch can finish after the user has replaced the canvas or removed its host.
					if (!canvasState.bulkRecords.includes(base)) return;
					let added = 0;
					let reused = 0;
					const newRecs = [];
					const _hx = rec.x - base.x;
					const _hy = rec.y - base.y;
					const _outwardLen = Math.hypot(_hx, _hy);
					const _outwardAngle = _outwardLen > 0.5 ? Math.atan2(_hy, _hx) : -Math.PI / 2;
					const arcSpan = Math.PI * 0.95;
					const N = records.length;
					const _fkField = rec.direction === 'child' ? rec.fieldOnOther : rec.fieldOnThis;
					const _existingAttachedCount = canvasState.bulkAssociations.filter((a) => {
						if (a.fieldName !== _fkField) {
							return false;
						}
						return rec.direction === 'child' ? a.toId === base.id : a.fromId === base.id;
					}).length;
					const _newCount = records.filter(
						(r) =>
							!canvasState.bulkRecords.some(
								(br) =>
									!br.isTypeNode && br.objectName === targetType && _sfIdMatch(br.loadedFromId, r.Id),
							),
					).length;
					const _cap = canvasCapCheck(_newCount);
					if (_cap.blocked) {
						rec._loading = false;
						renderBulkView();
						showBulkToast(_cap.reason);
						return;
					}
					const beforeRecords = canvasState.bulkRecords.slice();
					const beforeLinks = new Set(canvasState.bulkAssociations.map((link) => link.id));
					const filledValues = [];
					records.forEach((r, i) => {
						const v = recToValues(r);
						const existing = canvasState.bulkRecords.find(
							(br) => !br.isTypeNode && br.objectName === targetType && _sfIdMatch(br.loadedFromId, r.Id),
						);
						let target;
						if (existing) {
							target = existing;
							reused++;
						} else {
							let _x;
							let _y;
							if (N === 1) {
								const slot = _existingAttachedCount + i;
								const PER_RING = 6;
								const ring = Math.floor(slot / PER_RING);
								const slotInRing = slot % PER_RING;
								const angleStep = arcSpan / Math.max(1, PER_RING - 1);
								const angle = _outwardAngle - arcSpan / 2 + angleStep * slotInRing;
								const radius = 170 + ring * 140;
								_x = rec.x + radius * Math.cos(angle);
								_y = rec.y + radius * Math.sin(angle);
							} else {
								const t = i / (N - 1);
								const angle = _outwardAngle - arcSpan / 2 + arcSpan * t;
								const radius = 150 + Math.min(60, N * 5);
								_x = rec.x + radius * Math.cos(angle);
								_y = rec.y + radius * Math.sin(angle);
							}
							const openPosition = findOpenRelatedPosition(_x, _y, rec.x, rec.y, rec.id);
							target = {
								id: canvasState.bulkIdSeq++,
								objectName: targetType,
								label: targetSel ? targetSel.label : targetType,
								x: openPosition.x,
								y: openPosition.y,
								values: v,
								loadedFromId: r.Id,
								loadedValues: Object.assign({}, v),
								fromSelectionId: targetSelId,
							};
							canvasState.bulkRecords.push(target);
							newRecs.push(target);
							added++;
						}
						const fromId = rec.direction === 'child' ? target.id : base.id;
						const toId = rec.direction === 'child' ? base.id : target.id;
						const fieldName = rec.direction === 'child' ? rec.fieldOnOther : rec.fieldOnThis;
						const dup = canvasState.bulkAssociations.some(
							(a) => a.fromId === fromId && a.toId === toId && a.fieldName === fieldName,
						);
						if (!dup) {
							canvasState.bulkAssociations.push({ id: canvasState.bulkIdSeq++, fromId, toId, fieldName });
						}
						const holderRec = canvasState.bulkRecords.find((b) => b.id === fromId);
						const targetRec = canvasState.bulkRecords.find((b) => b.id === toId);
						if (
							holderRec &&
							targetRec &&
							targetRec.loadedFromId &&
							(!holderRec.values || holderRec.values[fieldName] == null)
						) {
							holderRec.values = holderRec.values || {};
							if (!newRecs.includes(holderRec)) {
								filledValues.push({
									record: holderRec,
									fieldName,
									hadValue: Object.prototype.hasOwnProperty.call(holderRec.values, fieldName),
									value: holderRec.values[fieldName],
								});
							}
							holderRec.values[fieldName] = targetRec.loadedFromId;
						}
					});
					const cachedCountForRemoval =
						rec.direction === 'child'
							? _relatedCountCache.get(_countCacheKey(targetType, rec.fieldOnOther, base.loadedFromId))
							: null;
					const wasTruncated =
						!opts.recordsOverride &&
						cachedCountForRemoval != null &&
						cachedCountForRemoval > records.length;
					const preserveTypeNode = !!opts.preserveTypeNode || wasTruncated;
					if (!preserveTypeNode) {
						const i = canvasState.bulkRecords.findIndex((b) => b.id === rec.id);
						if (i !== -1) {
							canvasState.bulkRecords.splice(i, 1);
						}
					} else {
						rec._loading = false;
					}
					if (newRecs.length > 0 && targetSel) {
						newRecs.forEach((nr) => inferAssociationsForRecord(nr, targetSel));
						purgeRedundantTypeNodes();
					}
					const addedIds = new Set(newRecs.map((record) => record.id));
					const addedLinks = new Set(
						canvasState.bulkAssociations.filter((link) => !beforeLinks.has(link.id)).map((link) => link.id),
					);
					const removedTypes = beforeRecords.filter(
						(record) =>
							record.isTypeNode && !record._chipLoader && !canvasState.bulkRecords.includes(record),
					);
					if (addedIds.size || addedLinks.size || filledValues.length || removedTypes.length) {
						deps.pushUndo?.('Load related records', () => {
							// Preserve reused records and unrelated changes; do not rewind IDs or the whole canvas.
							canvasState.bulkRecords = canvasState.bulkRecords.filter(
								(record) =>
									!addedIds.has(record.id) &&
									!(record.isTypeNode && addedIds.has(record.hostRecordId)),
							);
							canvasState.bulkAssociations = canvasState.bulkAssociations.filter(
								(link) =>
									!addedLinks.has(link.id) && !addedIds.has(link.fromId) && !addedIds.has(link.toId),
							);
							addedIds.forEach((id) => canvasState.bulkSelectedIds.delete(id));
							if (addedLinks.has(canvasState.bulkSelectedEdgeId)) canvasState.bulkSelectedEdgeId = null;
							for (const previous of filledValues) {
								if (!canvasState.bulkRecords.includes(previous.record)) continue;
								if (previous.hadValue) previous.record.values[previous.fieldName] = previous.value;
								else delete previous.record.values[previous.fieldName];
							}
							for (const placeholder of removedTypes) {
								if (
									!canvasState.bulkRecords.some((record) => record.id === placeholder.id) &&
									canvasState.bulkRecords.some((record) => record.id === placeholder.hostRecordId)
								) {
									placeholder._loading = false;
									canvasState.bulkRecords.push(placeholder);
								}
							}
							renderBulkView();
							showBulkToast('Undid loading related records.');
						});
					}
					if (newRecs.length > 0 && targetSel) {
						newRecs.forEach((nr) => {
							nr._seedingTypes = true;
						});
					}
					renderBulkView();
					if (newRecs.length > 0 && targetSel) {
						const outwardFrom = { x: rec.x, y: rec.y };
						newRecs.forEach((nr) => {
							seedEditModeTypeNodes(nr, targetSel, { outwardFrom })
								.catch((e) => console.warn('seedEditModeTypeNodes (descendant) failed:', e))
								.finally(() => {
									nr._seedingTypes = false;
									renderBulkView();
								});
						});
					}
					const noun = targetSel ? targetSel.label : targetType;
					if (added === 0 && reused === 0) {
						showBulkToast('No related records found.', 'info');
					} else if (wasTruncated) {
						const remaining = cachedCountForRemoval - records.length;
						const ctx = { rec, base };
						showBulkToastWithAction(
							'Loaded ' +
								records.length +
								' of ' +
								cachedCountForRemoval.toLocaleString() +
								' ' +
								noun +
								' (' +
								remaining.toLocaleString() +
								' more available).',
							'Search for more',
							() => openRelatedSearchFlow(ctx),
						);
					} else {
						const parts = [];
						if (added) {
							parts.push('added ' + added);
						}
						if (reused) {
							parts.push('linked ' + reused + ' already on canvas');
						}
						showBulkToast('Opened ' + noun + ': ' + parts.join(', ') + '.');
					}
				} catch (err) {
					rec._loading = false;
					renderBulkView();
					showBulkToast(
						'Open ' + (rec.label || rec.objectName) + ' failed: ' + (err.message || err),
						'error',
					);
				}
			}

			return {
				openTypeNode: openTypeNode,
				spawnFreeTypeNode: spawnFreeTypeNode,
				pickRecordForFreeTypeNode: pickRecordForFreeTypeNode,
				loadRecordIntoFreeTypeNode: loadRecordIntoFreeTypeNode,
				openRelatedSearchFlow: openRelatedSearchFlow,
			};
		},
	};
})();

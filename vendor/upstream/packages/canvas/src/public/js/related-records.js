(function () {
	'use strict';
	// Imports related Salesforce records and preserves lookup direction on the canvas.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.relatedRecords = {
		mount: function mount(deps) {
			const required = [
				'canvasState',
				'escapeHtml',
				'showBulkToast',
				'renderBulkView',
				'openTypeNode',
				'fetchRelatedCountsBatch',
				'_countCacheKey',
				'_relatedCountCache',
			];
			if (!deps) {
				throw new Error('related-records.mount: missing deps object');
			}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('related-records.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const escapeHtml = deps.escapeHtml;
			const showBulkToast = deps.showBulkToast;
			const renderBulkView = deps.renderBulkView;
			const openTypeNode = deps.openTypeNode;
			const fetchRelatedCountsBatch = deps.fetchRelatedCountsBatch;
			const _countCacheKey = deps._countCacheKey;
			const _relatedCountCache = deps._relatedCountCache;

			const _chipProbeState = new Map();
			let _activeRelatedPopoverCleanup = null;

			const _RELCHIP_SYSTEM_CHILD_NAMES = new Set([
				'ContentDocumentLink',
				'AttachedContentDocument',
				'AttachedContentNote',
				'CombinedAttachment',
				'EntitySubscription',
				'TopicAssignment',
				'CollaborationGroupRecord',
				'RecordAction',
				'EmailMessageRelation',
				'ProcessInstance',
				'ProcessInstanceHistory',
				'ProcessInstanceStep',
				'ProcessInstanceWorkitem',
				'AccountCleanInfo',
				'LeadCleanInfo',
				'DuplicateRecordItem',
				'DuplicateRecordSet',
				'AIInsightValue',
				'AIRecordInsight',
				'AIInsightAction',
				'AIInsightReason',
				'AIInsightFeedback',
				'ContactPointAddress',
				'ContactPointEmail',
				'ContactPointPhone',
				'ContactPointTypeConsent',
				'AuthorizationFormConsent',
				'AuthorizationFormDataUse',
				'CommSubscriptionConsent',
				'PartyConsent',
				'IndividualHistory',
				'AssociatedLocation',
				'ServiceAppointment',
				'MessagingEndUser',
				'MessagingSession',
				'CartCoupon',
				'CartValidationOutput',
				'CartTax',
			]);
			const _RELCHIP_SYSTEM_CHILD_SUFFIXES = [
				'History', // <Object>History: read-only audit trail
				'Feed', // <Object>Feed: Chatter posts
				'Share', // <Object>Share: sharing rows
				'ChangeEvent', // <Object>ChangeEvent: CDC stream events
				'Tag', // <Object>Tag: folksonomy tags (legacy)
			];
			function _isSystemChildRelationship(objName) {
				if (!objName) {
					return false;
				}
				if (objName.endsWith('__c')) {
					return false;
				}
				if (_RELCHIP_SYSTEM_CHILD_NAMES.has(objName)) {
					return true;
				}
				return _RELCHIP_SYSTEM_CHILD_SUFFIXES.some((suf) => objName.endsWith(suf));
			}

			const _RELCHIP_SYSTEM_PARENT_FIELDS = new Set([
				'CreatedById',
				'LastModifiedById',
				'MasterRecordId',
				'RecordTypeId',
				'OwnerId',
			]);
			function _isSystemParentField(fieldName) {
				if (!fieldName) {
					return false;
				}
				if (fieldName.endsWith('__c')) {
					return false;
				}
				return _RELCHIP_SYSTEM_PARENT_FIELDS.has(fieldName);
			}

			function _normalizeRelatedTypeahead(value) {
				return String(value || '')
					.toLocaleLowerCase()
					.normalize('NFKD')
					.replace(/[\u0300-\u036f]/g, '')
					.replace(/[^a-z0-9]+/g, '');
			}

			function _findRelatedTypeaheadMatchIndex(items, query) {
				const normalizedQuery = _normalizeRelatedTypeahead(query);
				if (!normalizedQuery || !Array.isArray(items)) {
					return -1;
				}
				const candidates = items.map((item) => [
					_normalizeRelatedTypeahead(item && item.label),
					_normalizeRelatedTypeahead(item && item.objectName),
				]);
				let index = candidates.findIndex((values) => values.some((value) => value.startsWith(normalizedQuery)));
				if (index !== -1) {
					return index;
				}
				index = candidates.findIndex((values) => values.some((value) => value.includes(normalizedQuery)));
				return index;
			}

			function _jumpToRelatedTypeahead(rows, query) {
				const rowList = Array.from(rows || []);
				const items = rowList.map((row) => ({
					label: row.querySelector('.fop-label')?.textContent || '',
					objectName: row.dataset.relObject || '',
				}));
				let effectiveQuery = query;
				let index = _findRelatedTypeaheadMatchIndex(items, effectiveQuery);
				if (index === -1 && effectiveQuery.length > 1) {
					effectiveQuery = effectiveQuery.slice(-1);
					index = _findRelatedTypeaheadMatchIndex(items, effectiveQuery);
				}
				rowList.forEach((row) => row.classList.remove('is-typeahead-match'));
				if (index !== -1) {
					const match = rowList[index];
					match.classList.add('is-typeahead-match');
					match.focus({ preventScroll: true });
					match.scrollIntoView({ block: 'nearest' });
				}
				return { index, query: effectiveQuery };
			}

			function _selectionForRecord(rec) {
				if (!rec) {
					return null;
				}
				if (rec.fromSelectionId != null) {
					const exact = canvasState.selectedObjects.find((s) => s.id === rec.fromSelectionId);
					if (exact && exact.data) {
						return exact;
					}
				}
				return canvasState.selectedObjects.find((s) => s.name === rec.objectName && s.data) || null;
			}

			function _ensureChipProbed(rec) {
				if (!rec || !rec.loadedFromId) {
					return;
				}
				if (_chipProbeState.has(rec.id)) {
					return;
				}
				const sel = _selectionForRecord(rec);
				if (!sel) {
					return;
				}
				const children = (sel.data.children || [])
					.filter((c) => c && c.field && c.object)
					.filter((c) => !_isSystemChildRelationship(c.object));
				if (children.length === 0) {
					_chipProbeState.set(rec.id, 'done');
					return;
				}
				_chipProbeState.set(rec.id, 'probing');
				const probes = children.map((c) => ({
					objectName: c.object,
					field: c.field,
					id: rec.loadedFromId,
				}));
				fetchRelatedCountsBatch(probes).finally(() => {
					_chipProbeState.set(rec.id, 'done');
					renderBulkView();
				});
			}

			function _sfIdValue(x) {
				if (typeof x === 'string') {
					return x;
				}
				if (x && typeof x === 'object' && typeof x.Id === 'string') {
					return x.Id;
				}
				return null;
			}
			function _sfIdMatch(a, b) {
				const aId = _sfIdValue(a);
				const bId = _sfIdValue(b);
				if (!aId || !bId) {
					return false;
				}
				if (aId === bId) {
					return true;
				}
				return aId.slice(0, 15) === bId.slice(0, 15);
			}

			function _relInfoForRec(rec) {
				if (!rec) {
					return null;
				}
				const sel = _selectionForRecord(rec);
				if (!sel) {
					return null;
				}
				const allParents = (sel.data.parents || [])
					.filter((p) => p && p.field && p.object)
					.filter((p) => !_isSystemParentField(p.field));
				const allChildren = (sel.data.children || [])
					.filter((c) => c && c.field && c.object)
					.filter((c) => !_isSystemChildRelationship(c.object));
				const parents = [];
				allParents.forEach((p) => {
					const v = rec.values && rec.values[p.field];
					if (!_sfIdValue(v)) {
						return;
					}
					const onCanvas = canvasState.bulkRecords.some(
						(r) => !r.isTypeNode && r.objectName === p.object && _sfIdMatch(r.loadedFromId, v),
					);
					if (onCanvas) {
						return;
					}
					parents.push(p);
				});
				const children = [];
				let unprobed = 0;
				if (rec.loadedFromId) {
					allChildren.forEach((c) => {
						const k = _countCacheKey(c.object, c.field, rec.loadedFromId);
						if (!_relatedCountCache.has(k)) {
							unprobed++;
							return;
						}
						const sfCount = _relatedCountCache.get(k);
						if (sfCount <= 0) {
							return;
						}
						const onCanvasCount = canvasState.bulkRecords.filter(
							(r) =>
								!r.isTypeNode &&
								r.objectName === c.object &&
								r.values &&
								_sfIdMatch(r.values[c.field], rec.loadedFromId),
						).length;
						const remaining = sfCount - onCanvasCount;
						if (remaining <= 0) {
							return;
						}
						children.push(
							Object.assign({}, c, {
								count: remaining,
								sfCount,
								onCanvasCount,
							}),
						);
					});
				}
				return {
					parents,
					children,
					total: parents.length + children.length,
					unprobed,
					probing: _chipProbeState.get(rec.id) === 'probing',
				};
			}

			function showRelatedPopover(triggerEl, hostRec) {
				const sel = _selectionForRecord(hostRec);
				if (!sel) {
					showBulkToast(
						'Relationship details are still loading for this record. Try Find related again in a moment.',
						'info',
					);
					return;
				}
				const parents = [];
				(sel.data.parents || [])
					.filter((p) => p && p.field && p.object)
					.filter((p) => !_isSystemParentField(p.field))
					.forEach((p) => {
						const v = hostRec.values && hostRec.values[p.field];
						if (!_sfIdValue(v)) {
							return;
						}
						const onCanvas = canvasState.bulkRecords.some(
							(r) => !r.isTypeNode && r.objectName === p.object && _sfIdMatch(r.loadedFromId, v),
						);
						if (onCanvas) {
							return;
						}
						parents.push(p);
					});
				const children = (sel.data.children || [])
					.filter((c) => c && c.field && c.object)
					.filter((c) => !_isSystemChildRelationship(c.object));
				if (parents.length === 0 && children.length === 0) {
					showBulkToast('No related records found.', 'info');
					return;
				}
				if (_activeRelatedPopoverCleanup) {
					_activeRelatedPopoverCleanup();
				}
				const pop = document.createElement('div');
				pop.className = 'find-object-popup related-pop';
				pop.style.width = '320px';
				const rect = triggerEl.getBoundingClientRect();
				pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 328)) + 'px';
				pop.style.top = rect.bottom + 6 + 'px';
				const labelFor = (n) => {
					const fromAll =
						Array.isArray(canvasState.allObjects) && canvasState.allObjects.find((o) => o.name === n);
					return (fromAll && fromAll.label) || n;
				};
				const rowFor = (entry, direction) => {
					const objLabel = labelFor(entry.object);
					return (
						'<button type="button" class="fop-item" ' +
						'data-rel-direction="' +
						direction +
						'" ' +
						'data-rel-object="' +
						escapeHtml(entry.object) +
						'" ' +
						'data-rel-field="' +
						escapeHtml(entry.field) +
						'" ' +
						(entry.relationshipName ? 'data-rel-rship="' + escapeHtml(entry.relationshipName) + '" ' : '') +
						'>' +
						'<span class="fop-label">' +
						escapeHtml(objLabel) +
						'</span>' +
						'<span class="fop-name">' +
						(direction === 'parent' ? '\u2191 parent via ' : '\u2193 child via ') +
						escapeHtml(entry.field) +
						'</span>' +
						'</button>'
					);
				};
				const parentRows = parents.map((p) => rowFor(p, 'parent')).join('');
				const childRows = children.map((c) => rowFor(c, 'child')).join('');
				pop.innerHTML =
					'<div class="fop-header">Load related records</div>' +
					'<div class="fop-list">' +
					(parentRows || '') +
					(childRows || '') +
					'</div>';
				document.body.appendChild(pop);
				const cleanup = () => {
					if (typeaheadTimer) {
						clearTimeout(typeaheadTimer);
					}
					if (pop.parentNode) {
						pop.remove();
					}
					document.removeEventListener('mousedown', outside, true);
					document.removeEventListener('keydown', onKeydown, true);
					if (_activeRelatedPopoverCleanup === cleanup) {
						_activeRelatedPopoverCleanup = null;
					}
				};
				const outside = (ev) => {
					if (!pop.contains(ev.target)) {
						cleanup();
					}
				};
				let typeaheadBuffer = '';
				let typeaheadTimer = null;
				const clearTypeahead = () => {
					typeaheadBuffer = '';
					typeaheadTimer = null;
				};
				const jumpToTypedObject = () => {
					const rows = Array.from(pop.querySelectorAll('[data-rel-object]'));
					const result = _jumpToRelatedTypeahead(rows, typeaheadBuffer);
					typeaheadBuffer = result.query;
				};
				const onKeydown = (ev) => {
					if (ev.key === 'Escape') {
						cleanup();
						return;
					}
					if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.key.length !== 1 || /^\s$/.test(ev.key)) {
						return;
					}
					const target = ev.target;
					if (
						target &&
						target.matches &&
						target.matches('input, textarea, select, [contenteditable="true"]')
					) {
						return;
					}
					ev.preventDefault();
					typeaheadBuffer += ev.key;
					jumpToTypedObject();
					if (typeaheadTimer) {
						clearTimeout(typeaheadTimer);
					}
					typeaheadTimer = setTimeout(clearTypeahead, 900);
				};
				setTimeout(() => {
					document.addEventListener('mousedown', outside, true);
					document.addEventListener('keydown', onKeydown, true);
				}, 0);
				_activeRelatedPopoverCleanup = cleanup;
				pop.addEventListener('click', (ev) => {
					const btn = ev.target.closest('[data-rel-direction]');
					if (!btn) {
						return;
					}
					const direction = btn.dataset.relDirection;
					const objectName = btn.dataset.relObject;
					const fieldName = btn.dataset.relField;
					const relationshipName = btn.dataset.relRship || fieldName;
					cleanup();
					loadRelatedFromChip(hostRec, { direction, objectName, fieldName, relationshipName });
				});
			}

			async function loadRelatedFromChip(hostRec, rel) {
				// Preserve lookup direction so import recreates the correct relationship edge.
				if (!hostRec || !rel) {
					return;
				}
				const labelFor = (n) => {
					const fromAll =
						Array.isArray(canvasState.allObjects) && canvasState.allObjects.find((o) => o.name === n);
					return (fromAll && fromAll.label) || n;
				};
				const tn = {
					id: canvasState.bulkIdSeq++,
					isTypeNode: true,
					hostRecordId: hostRec.id,
					objectName: rel.objectName,
					label: labelFor(rel.objectName),
					direction: rel.direction,
					x: hostRec.x + (rel.direction === 'child' ? 0 : -160),
					y: hostRec.y + (rel.direction === 'child' ? 160 : -160),
					_chipLoader: true,
				};
				if (rel.direction === 'child') {
					tn.fieldOnOther = rel.fieldName;
				} else {
					tn.fieldOnThis = rel.fieldName;
					const fkValue = hostRec.values && hostRec.values[rel.fieldName];
					if (!fkValue) {
						showBulkToast('No ' + rel.fieldName + ' on this record: nothing to load.', 'error');
						return;
					}
					tn.parentId = fkValue;
				}
				canvasState.bulkRecords.push(tn);
				try {
					await openTypeNode(tn);
				} catch (e) {
					const i = canvasState.bulkRecords.findIndex((b) => b.id === tn.id);
					if (i !== -1) {
						canvasState.bulkRecords.splice(i, 1);
					}
					renderBulkView();
					showBulkToast('Load failed: ' + (e.message || e), 'error');
				}
			}

			async function seedEditModeTypeNodes(hostRec, hostSel, opts) {
				// This legacy eager-expansion path is intentionally disabled; related records load on demand.
				if (!hostSel || !hostSel.data || !hostRec.loadedFromId) {
					return;
				}
				opts = opts || {};
				return;
				const labelFor = (n) => {
					const fromAll =
						Array.isArray(canvasState.allObjects) && canvasState.allObjects.find((o) => o.name === n);
					return (fromAll && fromAll.label) || n;
				};
				const existingTypeKeys = new Set(
					canvasState.bulkRecords
						.filter((r) => r.isTypeNode && r.hostRecordId === hostRec.id)
						.map((r) => r.objectName + '|' + r.direction + '|' + (r.fieldOnOther || r.fieldOnThis || '')),
				);
				const auditOnly = !!opts.auditOnly;
				const includeAudit = !!auditOnly;
				const queryableNames = new Set(
					(canvasState.allObjects || []).filter((o) => o && o.queryable).map((o) => o.name),
				);
				const isQueryable = (name) => queryableNames.size === 0 || queryableNames.has(name);
				const childCandidates = [];
				(hostSel.data.children || []).forEach((c) => {
					if (!c.field || !c.object) {
						return;
					}
					if (!isQueryable(c.object)) {
						return;
					}
					const isAudit = AUDIT_FK_FIELDS.has(c.field);
					if (auditOnly && !isAudit) {
						return;
					}
					if (!includeAudit && isAudit) {
						return;
					}
					const key = c.object + '|child|' + c.field;
					if (existingTypeKeys.has(key)) {
						return;
					}
					childCandidates.push({
						direction: 'child',
						objectName: c.object,
						label: labelFor(c.object),
						fieldOnOther: c.field,
						relationshipName: c.relationshipName || c.field,
					});
				});
				const _ensureAssoc = (fromId, toId, fieldName) => {
					const exists = canvasState.bulkAssociations.some(
						(a) => a.fromId === fromId && a.toId === toId && a.fieldName === fieldName,
					);
					if (!exists) {
						canvasState.bulkAssociations.push({ id: canvasState.bulkIdSeq++, fromId, toId, fieldName });
					}
				};
				const parentNodes = [];
				(hostSel.data.parents || []).forEach((p) => {
					if (!p.field || !p.object) {
						return;
					}
					if (!isQueryable(p.object)) {
						return;
					}
					const isAudit = AUDIT_FK_FIELDS.has(p.field);
					if (auditOnly && !isAudit) {
						return;
					}
					if (!includeAudit && isAudit) {
						return;
					}
					const parentId = hostRec.values && hostRec.values[p.field];
					if (!parentId || typeof parentId !== 'string') {
						return;
					}
					const key = p.object + '|parent|' + p.field;
					if (existingTypeKeys.has(key)) {
						return;
					}
					const onCanvas = canvasState.bulkRecords.find(
						(r) => !r.isTypeNode && r.objectName === p.object && r.loadedFromId === parentId,
					);
					if (onCanvas) {
						_ensureAssoc(hostRec.id, onCanvas.id, p.field);
						return;
					}
					parentNodes.push({
						direction: 'parent',
						objectName: p.object,
						label: labelFor(p.object),
						fieldOnThis: p.field,
						parentId,
					});
				});
				const probes = childCandidates.map((n) => ({
					objectName: n.objectName,
					field: n.fieldOnOther,
					id: hostRec.loadedFromId,
				}));
				const counts = await fetchRelatedCountsBatch(probes);
				const childChecks = childCandidates.filter((n) => {
					const key = _countCacheKey(n.objectName, n.fieldOnOther, hostRec.loadedFromId);
					const sfCount = counts.get(key) || 0;
					if (sfCount === 0) {
						return false;
					}
					const canvasMatches = canvasState.bulkRecords.filter(
						(r) =>
							!r.isTypeNode &&
							r.objectName === n.objectName &&
							r.values &&
							r.values[n.fieldOnOther] === hostRec.loadedFromId,
					);
					if (canvasMatches.length >= sfCount) {
						canvasMatches.forEach((m) => _ensureAssoc(m.id, hostRec.id, n.fieldOnOther));
						return false;
					}
					return true;
				});
				const nodes = parentNodes.concat(childChecks);
				if (nodes.length === 0) {
					renderBulkView();
					return;
				}
				const isBase = !opts.outwardFrom && typeof hostRec._fanAngle !== 'number';
				const hasExisting = existingTypeKeys.size > 0;
				const fallbackRing = opts.ring || (isBase ? 220 : 180);
				const baseRing = hasExisting ? fallbackRing + 120 : fallbackRing;
				let baseAngle, span;
				if (isBase) {
					baseAngle = -Math.PI / 2;
					span = Math.PI * 2;
				} else {
					span = Math.PI * 0.95;
					if (typeof hostRec._fanAngle === 'number') {
						baseAngle = hostRec._fanAngle;
					} else {
						const odx = hostRec.x - opts.outwardFrom.x;
						const ody = hostRec.y - opts.outwardFrom.y;
						const parentBased = Math.atan2(ody, odx);
						const SAMPLES = 24;
						const probeR = Math.max(baseRing, 320);
						const offsets = [-span / 2, -span / 4, 0, span / 4, span / 2];
						let bestAngle = parentBased;
						let bestScore = -Infinity;
						for (let s = 0; s < SAMPLES; s++) {
							const cand = (s / SAMPLES) * Math.PI * 2;
							let sumMin = 0;
							for (let oi = 0; oi < offsets.length; oi++) {
								const ang = cand + offsets[oi];
								const px = hostRec.x + probeR * Math.cos(ang);
								const py = hostRec.y + probeR * Math.sin(ang);
								let minDist = Infinity;
								for (let k = 0; k < canvasState.bulkRecords.length; k++) {
									const other = canvasState.bulkRecords[k];
									if (other.id === hostRec.id) {
										continue;
									}
									const dx = px - other.x;
									const dy = py - other.y;
									const d = Math.hypot(dx, dy);
									if (d < minDist) {
										minDist = d;
									}
								}
								if (minDist === Infinity) {
									minDist = probeR;
								}
								sumMin += minDist;
							}
							const align = Math.cos(cand - parentBased);
							const score = sumMin / offsets.length + align * 30;
							if (score > bestScore) {
								bestScore = score;
								bestAngle = cand;
							}
						}
						baseAngle = bestAngle;
						hostRec._fanAngle = baseAngle;
					}
				}
				const n = nodes.length;
				const _MIN_SEP = 120;
				const angularStep = isBase ? (n > 1 ? span / n : 0) : n > 1 ? span / (n - 1) : 0;
				const intraRingMin = angularStep > 0 ? _MIN_SEP / (2 * Math.sin(angularStep / 2)) : 0;
				const ring = Math.max(baseRing, intraRingMin);
				const _halfExtents = (rec) => (rec.isTypeNode ? { hw: 65, hh: 65 } : { hw: 120, hh: 90 });
				const _bbox = (rec) => {
					const { hw, hh } = _halfExtents(rec);
					return { l: rec.x - hw, r: rec.x + hw, t: rec.y - hh, b: rec.y + hh };
				};
				const _hits = (a, b) => !(a.r <= b.l || a.l >= b.r || a.b <= b.t || a.t >= b.b);
				const radiusForIndex = (i) => {
					const cycle = i % 3;
					if (cycle === 1) {
						return ring * 1.32;
					}
					if (cycle === 2) {
						return ring * 1.14;
					}
					return ring;
				};
				const PUSH_STEP = 30;
				const PUSH_MAX = 20;
				const placedThisPass = [];
				nodes.forEach((node, i) => {
					const t = n === 1 ? 0.5 : i / (n - 1);
					const angle = isBase ? baseAngle + span * (i / n) : baseAngle - span / 2 + span * t;
					const ux = Math.cos(angle);
					const uy = Math.sin(angle);
					const probe = { isTypeNode: true, x: 0, y: 0 };
					let radius = radiusForIndex(i);
					for (let step = 0; step < PUSH_MAX; step++) {
						probe.x = hostRec.x + radius * ux;
						probe.y = hostRec.y + radius * uy;
						const bb = _bbox(probe);
						let collides = false;
						for (let k = 0; k < canvasState.bulkRecords.length; k++) {
							const other = canvasState.bulkRecords[k];
							if (other.id === hostRec.id) {
								continue;
							}
							if (_hits(bb, _bbox(other))) {
								collides = true;
								break;
							}
						}
						if (!collides) {
							for (let k = 0; k < placedThisPass.length; k++) {
								if (_hits(bb, _bbox(placedThisPass[k]))) {
									collides = true;
									break;
								}
							}
						}
						if (!collides) {
							break;
						}
						radius += PUSH_STEP;
					}
					const placed = {
						id: canvasState.bulkIdSeq++,
						isTypeNode: true,
						direction: node.direction,
						objectName: node.objectName,
						label: node.label,
						fieldOnOther: node.fieldOnOther || null,
						fieldOnThis: node.fieldOnThis || null,
						parentId: node.parentId || null,
						relationshipName: node.relationshipName || null,
						hostRecordId: hostRec.id,
						x: hostRec.x + radius * ux,
						y: hostRec.y + radius * uy,
					};
					canvasState.bulkRecords.push(placed);
					placedThisPass.push(placed);
				});
				renderBulkView();
			}

			return {
				showRelatedPopover: showRelatedPopover,
				loadRelatedFromChip: loadRelatedFromChip,
				seedEditModeTypeNodes: seedEditModeTypeNodes,
				_ensureChipProbed: _ensureChipProbed,
				_relInfoForRec: _relInfoForRec,
				_isSystemChildRelationship: _isSystemChildRelationship,
				_isSystemParentField: _isSystemParentField,
				_selectionForRecord: _selectionForRecord,
				_sfIdValue: _sfIdValue,
				_sfIdMatch: _sfIdMatch,
				_findRelatedTypeaheadMatchIndex: _findRelatedTypeaheadMatchIndex,
				_jumpToRelatedTypeahead: _jumpToRelatedTypeahead,
			};
		},
	};
})();

(function () {
	'use strict';
	// Projects Salesforce describe metadata into a navigable object-and-relationship graph.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.schemaBuilder = {
		mount: function mount(deps) {
			if (
				!deps ||
				!deps.canvasState ||
				!deps.escapeHtml ||
				!deps.showBulkToast ||
				!deps.addToSelection ||
				!deps.renderBulkView ||
				!deps.fetchGraphData ||
				!deps.ensureDescribe ||
				!deps.ensureRules ||
				!deps._canvasCapBlockReason ||
				!deps.attachCyEdgeMarkers ||
				!deps.attachCyMiddleClickPan ||
				!deps.attachCyWheelZoom ||
				!deps.redrawCyEdgeMarkers ||
				!deps.SCHEMA_SYSTEM_FK_FIELDS ||
				!deps.getGraph ||
				!deps.getCySchemaInstance ||
				!deps.setCySchemaInstance
			) {
				throw new Error('schema-builder.mount: missing required deps');
			}
			const canvasState = deps.canvasState;
			const escapeHtml = deps.escapeHtml;
			const showBulkToast = deps.showBulkToast;
			const addToSelection = deps.addToSelection;
			const renderBulkView = deps.renderBulkView;
			const fetchGraphData = deps.fetchGraphData;
			const ensureDescribe = deps.ensureDescribe;
			const ensureRules = deps.ensureRules;
			const RECORDS_WORLD_SCALE = typeof deps.RECORDS_WORLD_SCALE === 'number' ? deps.RECORDS_WORLD_SCALE : 1.4;
			const _canvasCapBlockReason = deps._canvasCapBlockReason;
			const pushUndo = deps.pushUndo;
			const attachCyEdgeMarkers = deps.attachCyEdgeMarkers;
			const attachCyMiddleClickPan = deps.attachCyMiddleClickPan;
			const attachCyWheelZoom = deps.attachCyWheelZoom;
			const redrawCyEdgeMarkers = deps.redrawCyEdgeMarkers;
			const SCHEMA_SYSTEM_FK_FIELDS = deps.SCHEMA_SYSTEM_FK_FIELDS;
			const getGraph = deps.getGraph;
			const getCySchemaInstance = deps.getCySchemaInstance;
			const setCySchemaInstance = deps.setCySchemaInstance;

			const SCHEMA_NODE_W = 160;
			const SCHEMA_NODE_H = 68;
			const SCHEMA_NODE_W_EXPANDED = 280;
			const SCHEMA_NODE_H_EXPANDED = 360;
			const SCHEMA_PANEL_MIN_W = 240;
			const SCHEMA_PANEL_MIN_H = 220;
			const SCHEMA_PANEL_VIEWPORT_GUTTER = 16;
			const SCHEMA_PANEL_NODE_INSET = 0;
			const SCHEMA_SPAWN_BTN_SIZE = 22;
			const SCHEMA_SATELLITE_INSET = 4;
			const SCHEMA_SPAWN_OFFSET_X = -(SCHEMA_NODE_W / 2 - SCHEMA_SPAWN_BTN_SIZE / 2 - SCHEMA_SATELLITE_INSET);
			const SCHEMA_SPAWN_OFFSET_Y = -(SCHEMA_NODE_H / 2 - SCHEMA_SPAWN_BTN_SIZE / 2 - SCHEMA_SATELLITE_INSET);
			const SCHEMA_EXPAND_BTN_SIZE = 22;
			const SCHEMA_EXPAND_OFFSET_X = SCHEMA_NODE_W / 2 - SCHEMA_EXPAND_BTN_SIZE / 2 - SCHEMA_SATELLITE_INSET;
			const SCHEMA_EXPAND_OFFSET_Y = -(SCHEMA_NODE_H / 2 - SCHEMA_EXPAND_BTN_SIZE / 2 - SCHEMA_SATELLITE_INSET);
			const SCHEMA_SPAWN_OFFSET_X_EXPANDED = SCHEMA_NODE_W_EXPANDED / 2 + SCHEMA_SPAWN_BTN_SIZE / 2 + 4;
			const SCHEMA_SPAWN_OFFSET_Y_EXPANDED = -(SCHEMA_NODE_H_EXPANDED / 2 + SCHEMA_SPAWN_BTN_SIZE / 2 + 4);
			const SCHEMA_EXPAND_OFFSET_X_EXPANDED = SCHEMA_NODE_W_EXPANDED / 2 + SCHEMA_EXPAND_BTN_SIZE / 2 + 4;
			const SCHEMA_EXPAND_OFFSET_Y_EXPANDED = -(SCHEMA_NODE_H_EXPANDED / 2 + SCHEMA_EXPAND_BTN_SIZE / 2 + 4);
			let _expandedObjectName = null;
			let _expandedPanelEl = null;
			let _expandedRenderHandler = null;
			let _expandedCyNode = null;
			let _expandedNeighborPositions = null;
			const _schemaPanelSizes = new Map();
			let _schemaPanelResizeMoveHandler = null;
			let _schemaPanelResizeEndHandler = null;
			function _stopSchemaPanelResize() {
				if (_schemaPanelResizeMoveHandler) {
					window.removeEventListener('pointermove', _schemaPanelResizeMoveHandler);
				}
				if (_schemaPanelResizeEndHandler) {
					window.removeEventListener('pointerup', _schemaPanelResizeEndHandler);
					window.removeEventListener('pointercancel', _schemaPanelResizeEndHandler);
				}
				_schemaPanelResizeMoveHandler = null;
				_schemaPanelResizeEndHandler = null;
			}
			function _boundedSchemaPanelSize(width, height) {
				const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
				const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
				const maxWidth = Math.max(1, viewportWidth - SCHEMA_PANEL_VIEWPORT_GUTTER);
				const maxHeight = Math.max(1, viewportHeight - SCHEMA_PANEL_VIEWPORT_GUTTER);
				const minWidth = Math.min(SCHEMA_PANEL_MIN_W, maxWidth);
				const minHeight = Math.min(SCHEMA_PANEL_MIN_H, maxHeight);
				return {
					width: Math.max(minWidth, Math.min(Number(width) || minWidth, maxWidth)),
					height: Math.max(minHeight, Math.min(Number(height) || minHeight, maxHeight)),
				};
			}
			function _setSchemaPanelSize(width, height) {
				if (!_expandedPanelEl || !_expandedObjectName || !_expandedCyNode) {
					return;
				}
				const size = _boundedSchemaPanelSize(width, height);
				_schemaPanelSizes.set(_expandedObjectName, size);
				const cy = getCySchemaInstance();
				if (!cy) {
					return;
				}
				const zoom = Math.max(0.001, Number(cy.zoom()) || 1);
				const nodeBox = _expandedCyNode.renderedBoundingBox();
				const nodeRenderedWidth = Math.max(0, nodeBox.x2 - nodeBox.x1);
				const nodeRenderedHeight = Math.max(0, nodeBox.y2 - nodeBox.y1);
				const currentModelWidth = Number(_expandedCyNode.data('expandedWidth')) || SCHEMA_NODE_W_EXPANDED;
				const currentModelHeight = Number(_expandedCyNode.data('expandedHeight')) || SCHEMA_NODE_H_EXPANDED;
				const horizontalChrome = Math.max(0, nodeRenderedWidth - currentModelWidth * zoom);
				const verticalChrome = Math.max(0, nodeRenderedHeight - currentModelHeight * zoom);
				cy.batch(() => {
					_expandedCyNode.data(
						'expandedWidth',
						Math.max(1, (size.width + SCHEMA_PANEL_NODE_INSET * 2 - horizontalChrome) / zoom),
					);
					_expandedCyNode.data(
						'expandedHeight',
						Math.max(1, (size.height + SCHEMA_PANEL_NODE_INSET * 2 - verticalChrome) / zoom),
					);
				});
				try {
					cy.style().update();
				} catch (_) {}
				_repositionExpandedSchemaNeighbors();
				_pinSchemaFieldsPanel();
				redrawCyEdgeMarkers(cy, cy.container());
			}
			function _wireSchemaPanelResize(panel) {
				const handle = panel && panel.querySelector('.schema-expand-resize-handle');
				if (!handle) {
					return;
				}
				handle.addEventListener('pointerdown', (event) => {
					if (event.button !== 0) {
						return;
					}
					event.preventDefault();
					event.stopPropagation();
					_stopSchemaPanelResize();
					const startRect = panel.getBoundingClientRect();
					const startX = event.clientX;
					const startY = event.clientY;
					panel.classList.add('is-resizing');
					_schemaPanelResizeMoveHandler = (moveEvent) => {
						moveEvent.preventDefault();
						_setSchemaPanelSize(
							startRect.width + 2 * (moveEvent.clientX - startX),
							startRect.height + 2 * (moveEvent.clientY - startY),
						);
					};
					_schemaPanelResizeEndHandler = () => {
						panel.classList.remove('is-resizing');
						_stopSchemaPanelResize();
					};
					window.addEventListener('pointermove', _schemaPanelResizeMoveHandler);
					window.addEventListener('pointerup', _schemaPanelResizeEndHandler);
					window.addEventListener('pointercancel', _schemaPanelResizeEndHandler);
				});
				handle.addEventListener('dblclick', (event) => event.stopPropagation());
				handle.addEventListener('keydown', (event) => {
					if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
						return;
					}
					event.preventDefault();
					event.stopPropagation();
					const rect = panel.getBoundingClientRect();
					const step = event.shiftKey ? 40 : 10;
					const widthDelta = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
					const heightDelta = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
					_setSchemaPanelSize(rect.width + 2 * widthDelta, rect.height + 2 * heightDelta);
				});
			}
			function _repositionExpandedSchemaNeighbors() {
				const cy = getCySchemaInstance();
				if (!cy || !_expandedCyNode || !_expandedNeighborPositions) {
					return;
				}
				const center = _expandedCyNode.position();
				const halfWC = SCHEMA_NODE_W / 2;
				const halfHC = SCHEMA_NODE_H / 2;
				const halfWE = (Number(_expandedCyNode.data('expandedWidth')) || SCHEMA_NODE_W_EXPANDED) / 2;
				const halfHE = (Number(_expandedCyNode.data('expandedHeight')) || SCHEMA_NODE_H_EXPANDED) / 2;
				_expandedNeighborPositions.forEach((originalPosition, id) => {
					const node = cy.getElementById(id);
					if (!node || !node.length) {
						return;
					}
					const dx = originalPosition.x - center.x;
					const dy = originalPosition.y - center.y;
					const distance = Math.hypot(dx, dy);
					if (distance < 0.5) {
						node.position(originalPosition);
						return;
					}
					const ux = dx / distance;
					const uy = dy / distance;
					const collapsedExtent = Math.min(
						halfWC / Math.max(0.001, Math.abs(ux)),
						halfHC / Math.max(0.001, Math.abs(uy)),
					);
					const expandedExtent = Math.min(
						halfWE / Math.max(0.001, Math.abs(ux)),
						halfHE / Math.max(0.001, Math.abs(uy)),
					);
					const shift = Math.max(0, expandedExtent - collapsedExtent);
					node.position({
						x: originalPosition.x + ux * shift,
						y: originalPosition.y + uy * shift,
					});
				});
			}
			function _syncExpandedSchemaNeighbors() {
				const cy = getCySchemaInstance();
				if (!cy || !_expandedCyNode || !_expandedNeighborPositions) {
					return;
				}
				const liveNeighborIds = new Set();
				cy.nodes().forEach((node) => {
					if (node.id() === _expandedCyNode.id()) {
						return;
					}
					const kind = node.data('kind');
					if (kind === 'spawn-btn' || kind === 'expand-btn') {
						return;
					}
					liveNeighborIds.add(node.id());
					if (!_expandedNeighborPositions.has(node.id())) {
						const position = node.position();
						_expandedNeighborPositions.set(node.id(), { x: position.x, y: position.y });
					}
				});
				Array.from(_expandedNeighborPositions.keys()).forEach((id) => {
					if (!liveNeighborIds.has(id)) {
						_expandedNeighborPositions.delete(id);
					}
				});
				_repositionExpandedSchemaNeighbors();
			}
			function _hideSchemaFieldsPanel() {
				_stopSchemaPanelResize();
				if (_expandedPanelEl && _expandedPanelEl.parentNode) {
					_expandedPanelEl.parentNode.removeChild(_expandedPanelEl);
				}
				if (_expandedRenderHandler && getCySchemaInstance()) {
					try {
						getCySchemaInstance().off('render position', _expandedRenderHandler);
					} catch (_) {}
				}
				if (_expandedCyNode && _expandedCyNode.length) {
					_expandedCyNode.removeData('expanded');
					const cy = getCySchemaInstance();
					if (cy) {
						try {
							cy.style().update();
						} catch (_) {}
						const objName = _expandedCyNode.data('objectName');
						const spawn = objName ? cy.getElementById('spawn_' + objName) : null;
						if (spawn && spawn.length) {
							spawn.removeData('expandedHidden');
						}
						const expand = objName ? cy.getElementById('expand_' + objName) : null;
						if (expand && expand.length) {
							expand.removeData('expandedHidden');
						}
						if (_expandedNeighborPositions) {
							_expandedNeighborPositions.forEach((pos, id) => {
								const n = cy.getElementById(id);
								if (n && n.length) {
									n.position(pos);
								}
							});
						}
					}
				}
				_expandedNeighborPositions = null;
				_expandedPanelEl = null;
				_expandedRenderHandler = null;
				_expandedCyNode = null;
				_expandedObjectName = null;
			}
			function _pinSchemaFieldsPanel() {
				if (!_expandedPanelEl || !_expandedCyNode || !getCySchemaInstance()) {
					return;
				}
				const cy = getCySchemaInstance();
				const container = cy.container();
				if (!container) {
					return;
				}
				const cRect = container.getBoundingClientRect();
				const bb = _expandedCyNode.renderedBoundingBox();
				const left = Math.ceil(cRect.left + bb.x1 + SCHEMA_PANEL_NODE_INSET);
				const top = Math.ceil(cRect.top + bb.y1 + SCHEMA_PANEL_NODE_INSET);
				const right = Math.floor(cRect.left + bb.x2 - SCHEMA_PANEL_NODE_INSET);
				const bottom = Math.floor(cRect.top + bb.y2 - SCHEMA_PANEL_NODE_INSET);
				_expandedPanelEl.style.left = left + 'px';
				_expandedPanelEl.style.top = top + 'px';
				_expandedPanelEl.style.width = right - left + 'px';
				_expandedPanelEl.style.height = bottom - top + 'px';
			}
			function _renderSchemaFieldsPanelBody(objectName) {
				const data = canvasState.describeCache && canvasState.describeCache[objectName];
				if (!data || !Array.isArray(data.fields)) {
					return '<div class="schema-expand-empty">Loading fields…</div>';
				}
				const fields = data.fields.slice().sort((a, b) => {
					const al = (a.label || a.name || '').toLowerCase();
					const bl = (b.label || b.name || '').toLowerCase();
					return al < bl ? -1 : al > bl ? 1 : 0;
				});
				const rows = fields
					.map((f) => {
						const labelRaw = f.label || f.name || '';
						const nameRaw = f.name || '';
						const typeRaw = f.type || '';
						const label = escapeHtml(labelRaw);
						const apiName = escapeHtml(nameRaw);
						const type = escapeHtml(typeRaw);
						const isPicklist =
							(typeRaw === 'picklist' || typeRaw === 'multipicklist') &&
							Array.isArray(f.picklistValues) &&
							f.picklistValues.length > 0;
						let searchRaw = (labelRaw + ' ' + nameRaw + ' ' + typeRaw).toLowerCase();
						if (isPicklist) {
							searchRaw +=
								' ' +
								f.picklistValues
									.map((pv) => (pv.label || '') + ' ' + (pv.value || ''))
									.join(' ')
									.toLowerCase();
						}
						const search = escapeHtml(searchRaw);
						const classes = 'schema-expand-field' + (isPicklist ? ' is-picklist' : '');
						let valuesHtml = '';
						if (isPicklist) {
							const items = f.picklistValues
								.map((pv) => {
									const pvLabel = escapeHtml(pv.label || pv.value || '');
									const pvValue = escapeHtml(pv.value || '');
									const showValue = (pv.label || '') !== (pv.value || '');
									return (
										'<li class="sxf-picklist-value">' +
										'<span class="sxf-pv-label">' +
										pvLabel +
										'</span>' +
										(showValue ? '<span class="sxf-pv-value">' + pvValue + '</span>' : '') +
										(pv.defaultValue ? '<span class="sxf-pv-default">default</span>' : '') +
										'</li>'
									);
								})
								.join('');
							valuesHtml = '<ul class="sxf-picklist-values" hidden>' + items + '</ul>';
						}
						return (
							'<li class="' +
							classes +
							'" data-search="' +
							search +
							'"' +
							(isPicklist ? ' data-picklist="1"' : '') +
							'>' +
							'<div class="sxf-row">' +
							(isPicklist
								? '<button type="button" class="sxf-disclose" aria-label="Show picklist values" aria-expanded="false">▸</button>'
								: '<span class="sxf-disclose-spacer"></span>') +
							'<div class="sxf-row-text">' +
							'<div class="sxf-label">' +
							label +
							'</div>' +
							'<div class="sxf-meta">' +
							'<span class="sxf-api">' +
							apiName +
							'</span>' +
							'<span class="sxf-type">' +
							type +
							'</span>' +
							(isPicklist ? '<span class="sxf-count">(' + f.picklistValues.length + ')</span>' : '') +
							'</div>' +
							'</div>' +
							'</div>' +
							valuesHtml +
							'</li>'
						);
					})
					.join('');
				return (
					'<div class="schema-expand-filter-row">' +
					'<input type="search" class="schema-expand-filter" placeholder="Filter fields…" autocomplete="off">' +
					'<span class="schema-expand-count" data-total="' +
					fields.length +
					'">' +
					fields.length +
					' fields</span>' +
					'</div>' +
					'<ul class="schema-expand-fields">' +
					rows +
					'</ul>'
				);
			}
			function _renderSchemaValidationRules(result) {
				if (result && result.unavailable) {
					return (
						'<div class="schema-rules-empty">Couldn\'t load validation rules: ' +
						escapeHtml(result.unavailable) +
						'</div>'
					);
				}
				const rules = result && Array.isArray(result.rules) ? result.rules : [];
				if (rules.length === 0) {
					return '<div class="schema-rules-empty">No active validation rules for this object.</div>';
				}
				return rules
					.map((rule) => {
						const displayField = rule.errorDisplayField
							? '<span class="schema-rule-field"><span class="schema-rule-label">Field:</span> ' +
								escapeHtml(rule.errorDisplayField) +
								'</span>'
							: '';
						const errorMessage = rule.errorMessage
							? '<div class="schema-rule-error"><span class="schema-rule-label">Error message:</span> ' +
								escapeHtml(rule.errorMessage) +
								'</div>'
							: '';
						const description = rule.description
							? '<div class="schema-rule-description"><span class="schema-rule-label">Description:</span> ' +
								escapeHtml(rule.description) +
								'</div>'
							: '';
						const formula = rule.formula
							? '<details class="schema-rule-formula"><summary>Show formula</summary><pre>' +
								escapeHtml(rule.formula) +
								'</pre></details>'
							: '';
						return (
							'<article class="schema-rule">' +
							'<div class="schema-rule-header"><span class="schema-rule-name"><span class="schema-rule-label">Name:</span> ' +
							escapeHtml(rule.name || '(unnamed)') +
							'</span>' +
							displayField +
							'</div>' +
							errorMessage +
							description +
							formula +
							'</article>'
						);
					})
					.join('');
			}
			function _wireSchemaValidationRules(panel, objectName) {
				const section = panel && panel.querySelector('.schema-validation-rules');
				const content = section && section.querySelector('[data-schema-rules-content]');
				const count = section && section.querySelector('[data-schema-rules-count]');
				if (!section || !content || !count) {
					return;
				}
				let loaded = false;
				section.addEventListener('schema-section-open', () => {
					if (loaded) {
						return;
					}
					loaded = true;
					content.innerHTML = '<div class="schema-rules-empty">Loading validation rules…</div>';
					ensureRules(objectName).then((result) => {
						if (_expandedObjectName !== objectName || !_expandedPanelEl || !section.isConnected) {
							return;
						}
						const rules = result && Array.isArray(result.rules) ? result.rules : [];
						count.textContent = result && result.unavailable ? 'Unavailable' : String(rules.length);
						content.innerHTML = _renderSchemaValidationRules(result);
						_pinSchemaFieldsPanel();
					});
				});
			}
			function _wireSchemaSections(panel) {
				if (!panel) {
					return;
				}
				panel.querySelectorAll('[data-schema-section-toggle]').forEach((button) => {
					button.addEventListener('click', (event) => {
						event.stopPropagation();
						const section = button.closest('.schema-fields-section, .schema-validation-rules');
						const content = section && section.querySelector('[data-schema-section-content]');
						if (!section || !content) {
							return;
						}
						const opening = !section.classList.contains('is-open');
						section.classList.toggle('is-open', opening);
						button.setAttribute('aria-expanded', opening ? 'true' : 'false');
						content.hidden = !opening;
						if (opening) {
							section.dispatchEvent(new Event('schema-section-open'));
						}
					});
				});
			}
			function _wireSchemaFieldsFilter(panel) {
				if (!panel) {
					return;
				}
				const input = panel.querySelector('.schema-expand-filter');
				const countEl = panel.querySelector('.schema-expand-count');
				if (!input || !countEl) {
					return;
				}
				const rows = panel.querySelectorAll('.schema-expand-field');
				const total = Number(countEl.getAttribute('data-total')) || rows.length;
				const apply = () => {
					const q = input.value.trim().toLowerCase();
					let shown = 0;
					rows.forEach((row) => {
						const s = row.getAttribute('data-search') || '';
						const match = !q || s.indexOf(q) !== -1;
						if (match) {
							row.removeAttribute('hidden');
							shown++;
						} else {
							row.setAttribute('hidden', '');
						}
					});
					countEl.textContent = q ? shown + ' of ' + total + ' fields' : total + ' fields';
				};
				input.addEventListener('input', apply);
				input.addEventListener('keydown', (e) => e.stopPropagation());
				input.addEventListener('keyup', (e) => e.stopPropagation());
				panel.addEventListener('click', (e) => {
					const row = e.target && e.target.closest && e.target.closest('.schema-expand-field.is-picklist');
					if (!row) {
						return;
					}
					if (e.target.closest('a, input, select, textarea')) {
						return;
					}
					const values = row.querySelector('.sxf-picklist-values');
					const disclose = row.querySelector('.sxf-disclose');
					if (!values) {
						return;
					}
					const isOpen = !values.hasAttribute('hidden');
					if (isOpen) {
						values.setAttribute('hidden', '');
						if (disclose) {
							disclose.setAttribute('aria-expanded', 'false');
							disclose.textContent = '▸';
						}
					} else {
						values.removeAttribute('hidden');
						if (disclose) {
							disclose.setAttribute('aria-expanded', 'true');
							disclose.textContent = '▾';
						}
					}
				});
			}
			function _updateSchemaFieldsCount(panel, objectName, unavailable) {
				const count = panel && panel.querySelector('[data-schema-fields-count]');
				if (!count) {
					return;
				}
				const data = canvasState.describeCache && canvasState.describeCache[objectName];
				count.textContent = unavailable
					? 'Unavailable'
					: data && Array.isArray(data.fields)
						? String(data.fields.length)
						: 'Loading';
			}
			function _showSchemaFieldsPanel(objectName, cyNode) {
				_hideSchemaFieldsPanel();
				_expandedObjectName = objectName;
				_expandedCyNode = cyNode;
				const cy = getCySchemaInstance();
				const savedSize = _schemaPanelSizes.get(objectName);
				const zoom = cy ? Math.max(0.001, Number(cy.zoom()) || 1) : 1;
				const collapsedBox = cyNode.renderedBoundingBox();
				const collapsedRenderedWidth = Math.max(0, collapsedBox.x2 - collapsedBox.x1);
				const collapsedRenderedHeight = Math.max(0, collapsedBox.y2 - collapsedBox.y1);
				const horizontalChrome = Math.max(0, collapsedRenderedWidth - SCHEMA_NODE_W * zoom);
				const verticalChrome = Math.max(0, collapsedRenderedHeight - SCHEMA_NODE_H * zoom);
				cyNode.data(
					'expandedWidth',
					savedSize
						? Math.max(1, (savedSize.width + SCHEMA_PANEL_NODE_INSET * 2 - horizontalChrome) / zoom)
						: SCHEMA_NODE_W_EXPANDED,
				);
				cyNode.data(
					'expandedHeight',
					savedSize
						? Math.max(1, (savedSize.height + SCHEMA_PANEL_NODE_INSET * 2 - verticalChrome) / zoom)
						: SCHEMA_NODE_H_EXPANDED,
				);
				cyNode.data('expanded', '1');
				if (cy) {
					try {
						cy.style().update();
					} catch (_) {}
				}
				const spawn = cy ? cy.getElementById('spawn_' + objectName) : null;
				if (spawn && spawn.length) {
					spawn.data('expandedHidden', '1');
				}
				const expand = cy ? cy.getElementById('expand_' + objectName) : null;
				if (expand && expand.length) {
					expand.data('expandedHidden', '1');
				}
				_expandedNeighborPositions = new Map();
				if (cy) {
					cy.nodes().forEach((n) => {
						if (n.id() === cyNode.id()) {
							return;
						}
						const kind = n.data('kind');
						if (kind === 'spawn-btn' || kind === 'expand-btn') {
							return;
						}
						const position = n.position();
						_expandedNeighborPositions.set(n.id(), { x: position.x, y: position.y });
					});
					_repositionExpandedSchemaNeighbors();
				}
				const objLabel =
					(canvasState.describeCache &&
						canvasState.describeCache[objectName] &&
						canvasState.describeCache[objectName].label) ||
					objectName;
				const panel = document.createElement('div');
				panel.className = 'schema-expand-panel';
				panel.innerHTML =
					'<div class="schema-expand-header">' +
					'<span class="schema-expand-title">' +
					escapeHtml(objLabel) +
					'</span>' +
					'<span class="schema-expand-api">' +
					escapeHtml(objectName) +
					'</span>' +
					'<button type="button" class="schema-expand-add" aria-label="Add record" title="Add a record of this type to the canvas">+ Add</button>' +
					'<button type="button" class="schema-expand-close" aria-label="Collapse" title="Collapse">⤡</button>' +
					'</div>' +
					'<section class="schema-fields-section">' +
					'<button type="button" class="schema-section-summary" data-schema-section-toggle aria-expanded="false"><span>Fields</span><span class="schema-fields-count" data-schema-fields-count>Loading</span></button>' +
					'<div class="schema-expand-body" data-schema-section-content hidden>' +
					_renderSchemaFieldsPanelBody(objectName) +
					'</div>' +
					'</section>' +
					'<section class="schema-validation-rules">' +
					'<button type="button" class="schema-section-summary" data-schema-section-toggle aria-expanded="false"><span>Validation rules</span><span class="schema-rules-count" data-schema-rules-count>Open to load</span></button>' +
					'<div class="schema-rules-content" data-schema-rules-content data-schema-section-content hidden></div>' +
					'</section>' +
					'<div class="schema-expand-resize-handle" role="separator" tabindex="0" aria-label="Resize schema card" title="Drag to resize. Use arrow keys when focused."></div>';
				panel.addEventListener('mousedown', (e) => e.stopPropagation());
				panel.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
				panel.addEventListener('dblclick', (e) => {
					e.stopPropagation();
					_hideSchemaFieldsPanel();
				});
				panel.querySelector('.schema-expand-close').addEventListener('click', _hideSchemaFieldsPanel);
				panel.querySelector('.schema-expand-add').addEventListener('click', () => {
					_spawnRecordFromSchemaObject(objectName);
				});
				document.body.appendChild(panel);
				_expandedPanelEl = panel;
				_updateSchemaFieldsCount(panel, objectName, false);
				_wireSchemaValidationRules(panel, objectName);
				_wireSchemaSections(panel);
				_wireSchemaFieldsFilter(panel);
				_wireSchemaPanelResize(panel);
				_pinSchemaFieldsPanel();
				_expandedRenderHandler = _pinSchemaFieldsPanel;
				cy.on('render position', _expandedRenderHandler);
				if (
					!canvasState.describeCache[objectName] ||
					!Array.isArray(canvasState.describeCache[objectName].fields)
				) {
					ensureDescribe(objectName)
						.then(() => {
							if (_expandedObjectName !== objectName || !_expandedPanelEl) {
								return;
							}
							const body = _expandedPanelEl.querySelector('.schema-expand-body');
							if (body) {
								body.innerHTML = _renderSchemaFieldsPanelBody(objectName);
							}
							_updateSchemaFieldsCount(_expandedPanelEl, objectName, false);
							_wireSchemaFieldsFilter(_expandedPanelEl);
							_pinSchemaFieldsPanel();
						})
						.catch((err) => {
							if (_expandedObjectName !== objectName || !_expandedPanelEl) {
								return;
							}
							const body = _expandedPanelEl.querySelector('.schema-expand-body');
							if (body) {
								body.innerHTML =
									'<div class="schema-expand-empty">Couldn’t load fields: ' +
									escapeHtml(err.message || 'unknown error') +
									'</div>';
							}
							_updateSchemaFieldsCount(_expandedPanelEl, objectName, true);
						});
				}
			}
			const SCHEMA_STYLE = [
				{
					selector: 'core',
					style: {
						'active-bg-opacity': 0,
						'active-bg-size': 0,
					},
				},
				{
					selector: 'node',
					style: {
						label: 'data(label)',
						'text-valign': 'center',
						'text-halign': 'center',
						'text-wrap': 'wrap',
						'text-max-width': SCHEMA_NODE_W - 16,
						color: '#e8e6e1',
						'font-family': 'system-ui, sans-serif',
						'font-size': 11,
						shape: 'round-rectangle',
						width: SCHEMA_NODE_W,
						height: SCHEMA_NODE_H,
						'background-color': '#1e2025',
						'border-width': 1,
						'border-color': '#3a3f47',
						'overlay-opacity': 0,
					},
				},
				{
					selector: 'node[kind = "sel-active"]',
					style: {
						'border-color': '#d68b3c',
						'border-width': 2,
					},
				},
				{
					selector: 'node[expanded = "1"]',
					style: {
						width: 'data(expandedWidth)',
						height: 'data(expandedHeight)',
						label: '',
						'background-color': '#262a31',
						'border-color': '#d68b3c',
						'border-width': 2,
					},
				},
				{
					selector: 'node[kind = "ring"]',
					style: {
						'background-color': '#16191d',
						'border-style': 'dashed',
						'border-color': '#4a5058',
						color: '#9aa0a8',
						width: SCHEMA_NODE_W - 20,
						height: SCHEMA_NODE_H - 10,
					},
				},
				{
					selector: 'node[kind = "spawn-btn"]',
					style: {
						shape: 'ellipse',
						width: SCHEMA_SPAWN_BTN_SIZE,
						height: SCHEMA_SPAWN_BTN_SIZE,
						'background-opacity': 0,
						'border-width': 0,
						label: '+',
						color: '#e8e6e1',
						'font-size': 16,
						'text-valign': 'center',
						'text-halign': 'center',
						opacity: 1,
						'overlay-opacity': 0,
					},
				},
				{
					selector: 'node[kind = "spawn-btn"]:active',
					style: {
						color: '#d68b3c',
					},
				},
				{
					selector: 'node[kind = "expand-btn"]',
					style: {
						shape: 'ellipse',
						width: SCHEMA_EXPAND_BTN_SIZE,
						height: SCHEMA_EXPAND_BTN_SIZE,
						'background-opacity': 0,
						'border-width': 0,
						label: 'data(label)',
						color: '#e8e6e1',
						'font-size': 14,
						'text-valign': 'center',
						'text-halign': 'center',
						opacity: 1,
						'overlay-opacity': 0,
					},
				},
				{
					selector: 'node[kind = "expand-btn"]:active',
					style: {
						color: '#d68b3c',
					},
				},
				{
					selector: 'node[?expandedHidden]',
					style: {
						display: 'none',
					},
				},
				{
					selector: 'edge[kind = "spawn-link"]',
					style: {
						'line-color': 'transparent',
						'target-arrow-shape': 'none',
						'source-arrow-shape': 'none',
						label: '',
						width: 0,
					},
				},
				{
					selector: 'node:selected',
					style: {
						'border-color': '#d68b3c',
						'border-width': 3,
					},
				},
				{
					selector: 'edge',
					style: {
						width: 1.5,
						'line-color': '#5a6068',
						'curve-style': 'bezier',
						'target-arrow-shape': 'none',
						'font-size': 10,
						color: '#9aa0a8',
						'text-background-color': '#1c2226',
						'text-background-opacity': 0.9,
						'text-background-padding': 2,
						'text-rotation': 'autorotate',
					},
				},
				{ selector: 'edge[label]', style: { label: 'data(label)' } },
				{
					selector: 'edge[kind = "fk"]',
					style: {
						'target-arrow-shape': 'none',
					},
				},
				{
					selector: 'edge[kind = "ring"]',
					style: {
						'line-style': 'dashed',
						'line-color': '#3a3f47',
						'target-arrow-shape': 'none',
						color: '#6a7078',
					},
				},
			];

			function _resolveDescribeData(name) {
				// Prefer the selected-object snapshot, then fall back to the shared graph cache.
				const sel = canvasState.selectedObjects.find((s) => s.name === name);
				if (sel && sel.data) {
					return sel.data;
				}
				if (canvasState.graphCache && canvasState.graphCache[name]) {
					return canvasState.graphCache[name];
				}
				return null;
			}

			function _findSpawnLinkTargets(spawningName, newId) {
				// Auto-link only through relationships already proven by the current schema path or component.
				const focusedRecId =
					canvasState.bulkSelectedIds.size === 1 ? canvasState.bulkSelectedIds.values().next().value : null;
				const focusedRec =
					focusedRecId != null ? canvasState.bulkRecords.find((r) => r.id === focusedRecId) : null;
				if (!focusedRec) {
					return [];
				}
				const componentRecIds = new Set();
				const queue = [focusedRec.id];
				while (queue.length) {
					const id = queue.shift();
					if (componentRecIds.has(id)) {
						continue;
					}
					componentRecIds.add(id);
					canvasState.bulkAssociations.forEach((a) => {
						if (a.fromId === id && !componentRecIds.has(a.toId)) {
							queue.push(a.toId);
						}
						if (a.toId === id && !componentRecIds.has(a.fromId)) {
							queue.push(a.fromId);
						}
					});
				}
				const findComponentRecs = (name) =>
					canvasState.bulkRecords.filter(
						(r) => !r.isTypeNode && r.objectName === name && r.id !== newId && componentRecIds.has(r.id),
					);
				const expandMatch = (otherRecs, fromSide, toSide, field) => {
					if (otherRecs.length === 0) {
						return [];
					}
					const newIsFrom = fromSide === spawningName;
					if (newIsFrom) {
						const otherRec = otherRecs[0];
						return [{ fromId: newId, toId: otherRec.id, field, otherRec }];
					}
					return otherRecs.map((otherRec) => ({
						fromId: otherRec.id,
						toId: newId,
						field,
						otherRec,
					}));
				};
				for (let i = canvasState._schemaViewPathEdges.length - 1; i >= 0; i--) {
					const step = canvasState._schemaViewPathEdges[i];
					let otherName = null;
					if (step.to === spawningName) {
						otherName = step.from;
					} else if (step.from === spawningName) {
						otherName = step.to;
					}
					if (!otherName || !step.field) {
						continue;
					}
					const otherRecs = findComponentRecs(otherName);
					if (otherRecs.length === 0) {
						continue;
					}
					const fromSide = step.direction === 'parent' ? step.from : step.to;
					const toSide = step.direction === 'parent' ? step.to : step.from;
					return expandMatch(otherRecs, fromSide, toSide, step.field);
				}
				if (focusedRec.objectName !== spawningName) {
					const byKey = new Map();
					for (const a of canvasState.bulkAssociations) {
						if (!componentRecIds.has(a.fromId) || !componentRecIds.has(a.toId)) {
							continue;
						}
						const fromRec = canvasState.bulkRecords.find((r) => r.id === a.fromId);
						const toRec = canvasState.bulkRecords.find((r) => r.id === a.toId);
						if (!fromRec || !toRec) {
							continue;
						}
						let fromSide, toSide, otherRec;
						if (fromRec.objectName === spawningName && toRec.objectName !== spawningName) {
							fromSide = spawningName;
							toSide = toRec.objectName;
							otherRec = toRec;
						} else if (toRec.objectName === spawningName && fromRec.objectName !== spawningName) {
							fromSide = fromRec.objectName;
							toSide = spawningName;
							otherRec = fromRec;
						} else {
							continue;
						}
						const key = otherRec.objectName + '|' + a.fieldName;
						if (!byKey.has(key)) {
							byKey.set(key, { fromSide, toSide, field: a.fieldName, others: [] });
						}
						byKey.get(key).others.push(otherRec);
					}
					for (const entry of byKey.values()) {
						const links = expandMatch(entry.others, entry.fromSide, entry.toSide, entry.field);
						if (links.length > 0) {
							return links;
						}
					}
				}
				return [];
			}

			function _nearestFreeSpotToViewportCenter() {
				// Search deterministic rings so new cards land near the viewport without covering existing cards.
				const canvasEl = getGraph().querySelector('#bulk-canvas');
				const cw = (canvasEl && canvasEl.clientWidth) || 800;
				const ch = (canvasEl && canvasEl.clientHeight) || 600;
				const cx0 = ((canvasEl && canvasEl.scrollLeft) || 0) + cw / 2;
				const cy0 = ((canvasEl && canvasEl.scrollTop) || 0) + ch / 2;
				const CARD_W = 230;
				const CARD_H = 90;
				const overlaps = (x, y) =>
					canvasState.bulkRecords.some(
						(r) =>
							r &&
							!r.isTypeNode &&
							!r._chipLoader &&
							typeof r.x === 'number' &&
							typeof r.y === 'number' &&
							Math.abs(r.x - x) < CARD_W &&
							Math.abs(r.y - y) < CARD_H,
					);
				if (!overlaps(cx0, cy0)) {
					return { x: cx0, y: cy0 };
				}
				for (let ring = 1; ring <= 40; ring++) {
					const rad = ring * 40;
					const pts = ring * 8;
					for (let i = 0; i < pts; i++) {
						const ang = (2 * Math.PI * i) / pts;
						const x = cx0 + rad * Math.cos(ang);
						const y = cy0 + rad * Math.sin(ang);
						if (!overlaps(x, y)) {
							return { x, y };
						}
					}
				}
				return { x: cx0, y: cy0 };
			}
			function _spawnRecordFromSchemaObject(objectName) {
				if (!objectName) {
					return;
				}
				const blocked = _canvasCapBlockReason(1);
				if (blocked) {
					showBulkToast(blocked);
					return;
				}
				const doSpawn = (selEntry) => {
					const focusedRecId =
						canvasState.bulkSelectedIds.size === 1
							? canvasState.bulkSelectedIds.values().next().value
							: null;
					const focusedRec =
						focusedRecId != null ? canvasState.bulkRecords.find((r) => r.id === focusedRecId) : null;
					let x, y;
					if (focusedRec && !focusedRec.isTypeNode) {
						const baseSchemaNode = getCySchemaInstance()
							? getCySchemaInstance().getElementById('o_' + focusedRec.objectName)
							: null;
						const objSchemaNode = getCySchemaInstance()
							? getCySchemaInstance().getElementById('o_' + selEntry.name)
							: null;
						const baseSchemaPos =
							baseSchemaNode && baseSchemaNode.length ? baseSchemaNode.position() : { x: 0, y: 0 };
						const objSchemaPos =
							objSchemaNode && objSchemaNode.length ? objSchemaNode.position() : baseSchemaPos;
						x = focusedRec.x + (objSchemaPos.x - baseSchemaPos.x) * RECORDS_WORLD_SCALE;
						y = focusedRec.y + (objSchemaPos.y - baseSchemaPos.y) * RECORDS_WORLD_SCALE;
					} else {
						const spot = _nearestFreeSpotToViewportCenter();
						x = spot.x;
						y = spot.y;
					}
					const SPAWN_CARD_W = 230;
					const SPAWN_CARD_H = 90;
					const SPAWN_STEP = 32;
					const SPAWN_MAX_STEPS = 80;
					const _overlaps = (cx, cy) =>
						canvasState.bulkRecords.some((r) => {
							if (!r || r.isTypeNode || r._chipLoader) {
								return false;
							}
							if (typeof r.x !== 'number' || typeof r.y !== 'number') {
								return false;
							}
							return Math.abs(r.x - cx) < SPAWN_CARD_W && Math.abs(r.y - cy) < SPAWN_CARD_H;
						});
					let steps = 0;
					while (_overlaps(x, y) && steps < SPAWN_MAX_STEPS) {
						x += SPAWN_STEP;
						y += SPAWN_STEP;
						steps++;
					}
					const newRec = {
						id: canvasState.bulkIdSeq++,
						objectName: selEntry.name,
						label: selEntry.label,
						x,
						y,
						values: {},
						fromSelectionId: selEntry.id,
					};
					canvasState.bulkRecords.push(newRec);
					const links = _findSpawnLinkTargets(selEntry.name, newRec.id);
					links.forEach((link) => {
						canvasState.bulkAssociations.push({
							id: canvasState.bulkIdSeq++,
							fromId: link.fromId,
							toId: link.toId,
							fieldName: link.field,
						});
					});
					if (typeof pushUndo === 'function') {
						const _spawnedId = newRec.id;
						const _spawnedFingerprint = JSON.stringify(newRec);
						const _linkFingerprint = JSON.stringify(
							canvasState.bulkAssociations.filter(
								(a) => a && (a.fromId === _spawnedId || a.toId === _spawnedId),
							),
						);
						pushUndo('Add record', function () {
							const current = canvasState.bulkRecords.find((r) => r && r.id === _spawnedId);
							const currentLinks = canvasState.bulkAssociations.filter(
								(a) => a && (a.fromId === _spawnedId || a.toId === _spawnedId),
							);
							if (
								!current ||
								JSON.stringify(current) !== _spawnedFingerprint ||
								JSON.stringify(currentLinks) !== _linkFingerprint
							) {
								showBulkToast(
									'Can’t undo the schema add because that record or its relationships were edited afterward.',
									'info',
								);
								return false;
							}
							canvasState.bulkRecords = canvasState.bulkRecords.filter((r) => !r || r.id !== _spawnedId);
							canvasState.bulkAssociations = canvasState.bulkAssociations.filter(
								(a) => a && a.fromId !== _spawnedId && a.toId !== _spawnedId,
							);
							renderBulkView();
						});
					}
					renderBulkView();
					const label = selEntry.label || selEntry.name;
					let toastMsg = 'Added ' + label + ' record.';
					if (links.length === 1) {
						const other = links[0].otherRec;
						toastMsg = 'Added ' + label + ' record (linked to ' + (other.label || other.objectName) + ').';
					} else if (links.length > 1) {
						toastMsg =
							'Added ' +
							label +
							' record (linked to ' +
							links.length +
							' ' +
							(links[0].otherRec.label || links[0].otherRec.objectName) +
							' record' +
							(links.length === 1 ? '' : 's') +
							').';
					}
					showBulkToast(toastMsg);
				};
				const existing = canvasState.selectedObjects.find((s) => s.name === objectName);
				if (existing) {
					doSpawn(existing);
				} else if (typeof addToSelection === 'function') {
					addToSelection(objectName)
						.then(doSpawn)
						.catch((err) => {
							console.warn('spawn from schema: addToSelection failed for', objectName, err);
							showBulkToast('Failed to load ' + objectName + ': ' + (err.message || err), 'error');
						});
				}
			}

			function _schemaViewFromSelection() {
				// A single selected record anchors the schema view; navigation may then override the focus object.
				let focusedRec = null;
				if (canvasState.bulkSelectedIds.size === 1) {
					const onlyId = canvasState.bulkSelectedIds.values().next().value;
					const r = canvasState.bulkRecords.find((rr) => rr.id === onlyId);
					if (r && !r.isTypeNode) {
						focusedRec = r;
					}
				}
				const overrideName = canvasState._schemaViewObject;
				if (!focusedRec && !overrideName) {
					return null;
				}

				const activeName = overrideName || focusedRec.objectName;
				if (!overrideName) {
					canvasState._schemaViewObject = activeName;
				}
				const isOverride = true;

				let componentRecIds;
				let objectNames;
				const seenNames = new Set();
				if (isOverride) {
					componentRecIds = new Set();
					objectNames = [activeName];
					seenNames.add(activeName);
					canvasState._schemaViewPath.forEach((name) => {
						if (seenNames.has(name)) {
							return;
						}
						seenNames.add(name);
						objectNames.push(name);
					});
				} else {
					componentRecIds = new Set();
					const queue = [focusedRec.id];
					while (queue.length) {
						const id = queue.shift();
						if (componentRecIds.has(id)) {
							continue;
						}
						componentRecIds.add(id);
						canvasState.bulkAssociations.forEach((a) => {
							if (a.fromId === id && !componentRecIds.has(a.toId)) {
								queue.push(a.toId);
							}
							if (a.toId === id && !componentRecIds.has(a.fromId)) {
								queue.push(a.fromId);
							}
						});
					}
					objectNames = [];
					componentRecIds.forEach((id) => {
						const r = canvasState.bulkRecords.find((x) => x.id === id);
						if (!r || r.isTypeNode) {
							return;
						}
						if (seenNames.has(r.objectName)) {
							return;
						}
						seenNames.add(r.objectName);
						objectNames.push(r.objectName);
					});
				}

				const labelFor = (name) => {
					const sel = canvasState.selectedObjects.find((s) => s.name === name);
					return (sel && sel.label) || name;
				};
				const elements = [];
				const nodeKindById = new Map();

				objectNames.forEach((name) => {
					const id = 'o_' + name;
					const kind = name === activeName ? 'sel-active' : 'sel';
					nodeKindById.set(id, kind);
					elements.push({
						group: 'nodes',
						data: { id, kind, label: labelFor(name), objectName: name },
					});
					const spawnId = 'spawn_' + name;
					nodeKindById.set(spawnId, 'spawn-btn');
					elements.push({
						group: 'nodes',
						data: { id: spawnId, kind: 'spawn-btn', label: '+', spawnFor: name },
						grabbable: false,
						selectable: false,
					});
					elements.push({
						group: 'edges',
						data: { id: 'spawnedge_' + name, source: id, target: spawnId, kind: 'spawn-link' },
					});
					const expandId = 'expand_' + name;
					nodeKindById.set(expandId, 'expand-btn');
					elements.push({
						group: 'nodes',
						data: { id: expandId, kind: 'expand-btn', label: '⤢', expandFor: name },
						grabbable: false,
						selectable: false,
					});
					elements.push({
						group: 'edges',
						data: { id: 'expandedge_' + name, source: id, target: expandId, kind: 'spawn-link' },
					});
				});

				const edgeKeys = [];
				const seenEdges = new Set();
				if (!isOverride) {
					canvasState.bulkAssociations.forEach((a) => {
						const fromRec = canvasState.bulkRecords.find((r) => r.id === a.fromId);
						const toRec = canvasState.bulkRecords.find((r) => r.id === a.toId);
						if (!fromRec || !toRec || fromRec.isTypeNode || toRec.isTypeNode) {
							return;
						}
						if (isOverride) {
							if (!seenNames.has(fromRec.objectName) || !seenNames.has(toRec.objectName)) {
								return;
							}
						} else {
							if (!componentRecIds.has(a.fromId) || !componentRecIds.has(a.toId)) {
								return;
							}
						}
						const fromObj = fromRec.objectName;
						const toObj = toRec.objectName;
						const field = a.fieldName || '';
						const key = fromObj + '|' + toObj + '|' + field;
						if (seenEdges.has(key)) {
							return;
						}
						seenEdges.add(key);
						edgeKeys.push(key);
						elements.push({
							group: 'edges',
							data: {
								id: 'e_' + key,
								source: 'o_' + fromObj,
								target: 'o_' + toObj,
								label: field,
								kind: 'fk',
							},
						});
					});
				}

				if (isOverride && canvasState._schemaViewPathEdges.length) {
					canvasState._schemaViewPathEdges.forEach((step) => {
						if (!seenNames.has(step.from) || !seenNames.has(step.to)) {
							return;
						}
						let source, target;
						if (step.direction === 'parent') {
							source = 'o_' + step.from;
							target = 'o_' + step.to;
						} else {
							source = 'o_' + step.to;
							target = 'o_' + step.from;
						}
						if (seenEdges.has(source.slice(2) + '|' + target.slice(2) + '|' + step.field)) {
							return;
						}
						const key = step.from + '|' + step.to + '|' + step.field + '|' + step.direction;
						if (seenEdges.has('pe_' + key)) {
							return;
						}
						seenEdges.add('pe_' + key);
						edgeKeys.push('pe_' + key);
						if (step.from === activeName || step.to === activeName) {
							seenEdges.add(step.from + '|' + step.to + '|' + step.field);
							seenEdges.add(step.to + '|' + step.from + '|' + step.field);
						}
						elements.push({
							group: 'edges',
							data: {
								id: 'pe_' + key,
								source,
								target,
								label: step.field,
								kind: 'fk',
							},
						});
					});
				}

				const allObjsByName = new Map(
					(Array.isArray(canvasState.allObjects) ? canvasState.allObjects : []).map((o) => [o.name, o]),
				);
				const relFilter = canvasState.graphRelFilter || 'both';
				const filterText = (canvasState.graphFilterText || '').trim().toLowerCase();
				const matchesFilterText = (name) => {
					if (!filterText) {
						return true;
					}
					const lower = (name || '').toLowerCase();
					if (lower.includes(filterText)) {
						return true;
					}
					const meta = allObjsByName.get(name);
					if (meta && meta.label && meta.label.toLowerCase().includes(filterText)) {
						return true;
					}
					return false;
				};
				const ringKeys = [];
				const activeData = _resolveDescribeData(activeName);
				if (activeData) {
					const ringSeen = new Set();
					const pushRing = (peerObj, fieldName, direction) => {
						if (!peerObj || !fieldName) {
							return;
						}
						if (peerObj === activeName) {
							return;
						} // self-refs collapse to a single node - skip
						const peerIsSel = seenNames.has(peerObj);
						if (!peerIsSel) {
							if (relFilter === 'parent' && direction !== 'parent') {
								return;
							}
							if (relFilter === 'child' && direction !== 'child') {
								return;
							}
						}
						if (canvasState._systemFieldsFilter && SCHEMA_SYSTEM_FK_FIELDS.has(fieldName) && !peerIsSel) {
							return;
						}
						if (!peerIsSel && !matchesFilterText(peerObj)) {
							return;
						}
						if (isOverride && peerIsSel) {
							return;
						}
						const ringKey = direction + '|' + peerObj + '|' + fieldName;
						if (ringSeen.has(ringKey)) {
							return;
						}
						ringSeen.add(ringKey);
						const relationshipKey =
							direction === 'parent'
								? activeName + '|' + peerObj + '|' + fieldName // Lookup on active points at peer
								: peerObj + '|' + activeName + '|' + fieldName; // Lookup on peer points at active
						if (seenEdges.has(relationshipKey)) {
							return;
						}
						ringKeys.push(ringKey);
						const nodeId = 'ring_' + activeName + '_' + ringKey;
						nodeKindById.set(nodeId, 'ring');
						elements.push({
							group: 'nodes',
							data: {
								id: nodeId,
								kind: 'ring',
								label: peerObj,
								ringObject: peerObj,
								ringField: fieldName,
								ringDirection: direction,
							},
						});
						const edgeId = 'redge_' + activeName + '_' + ringKey;
						const source = direction === 'parent' ? 'o_' + activeName : nodeId;
						const target = direction === 'parent' ? nodeId : 'o_' + activeName;
						elements.push({
							group: 'edges',
							data: { id: edgeId, source, target, label: fieldName, kind: 'ring' },
						});
					};
					(activeData.parents || []).forEach((p) => pushRing(p.object, p.field, 'parent'));
					(activeData.children || []).forEach((c) => pushRing(c.object, c.field, 'child'));
				}

				const sig = [
					[].concat(objectNames).sort().join(','),
					[].concat(edgeKeys).sort().join(','),
					[].concat(ringKeys).sort().join(','),
					activeName,
					canvasState._schemaViewPathEdges
						.map((e) => e.key)
						.sort()
						.join(','),
					canvasState._systemFieldsFilter ? 'sys:on' : 'sys:off',
				].join('||');
				return { activeName, elements, nodeKindById, sig };
			}

			function renderCanvas() {
				const subbar = getGraph().querySelector('#graph-subbar');
				if (subbar) {
					subbar.classList.remove('hidden');
				}
				const picker = getGraph().querySelector('#base-picker');
				if (picker) {
					picker.classList.add('hidden');
				}
				const container = getGraph().querySelector('#graph-canvas-cy');
				if (!container || typeof cytoscape !== 'function') {
					return;
				}

				const currentFocusId =
					canvasState.bulkSelectedIds.size === 1 ? canvasState.bulkSelectedIds.values().next().value : null;
				if (currentFocusId !== canvasState._lastSchemaFocusRecId) {
					canvasState._schemaViewPath = [];
					canvasState._schemaViewPathEdges = [];
				}
				canvasState._lastSchemaFocusRecId = currentFocusId;

				const view = _schemaViewFromSelection();
				if (!view) {
					_hideSchemaFieldsPanel();
					if (getCySchemaInstance()) {
						getCySchemaInstance().destroy();
						setCySchemaInstance(null);
					}
					canvasState._cySchemaSig = null;
					return;
				}
				if (typeof fetchGraphData === 'function' && !_resolveDescribeData(view.activeName)) {
					// Render cached structure immediately and refresh only the missing active-object metadata.
					const targetName = view.activeName;
					fetchGraphData(targetName)
						.then(() => {
							if (canvasState.graphCache && canvasState.graphCache[targetName]) {
								renderCanvas();
							}
						})
						.catch((err) => console.warn('schema render: fetchGraphData failed for', targetName, err));
				}

				const sigChanged = view.sig !== canvasState._cySchemaSig;
				canvasState._cySchemaSig = view.sig;
				const SPOKE_RADIUS = 1.67 * SCHEMA_NODE_W;

				const startAngle = -Math.PI / 2;
				const sortedSelNames = view.elements
					.filter((el) => el.group === 'nodes' && (el.data.kind === 'sel' || el.data.kind === 'sel-active'))
					.map((el) => el.data.objectName)
					.sort();
				const selN = sortedSelNames.length;
				const selPositionByName = new Map();
				sortedSelNames.forEach((name, i) => {
					if (selN === 1) {
						selPositionByName.set(name, { x: 0, y: 0 });
						return;
					}
					const angle = startAngle + (i / selN) * 2 * Math.PI;
					selPositionByName.set(name, {
						x: SPOKE_RADIUS * Math.cos(angle),
						y: SPOKE_RADIUS * Math.sin(angle),
					});
				});
				const navOrigin = canvasState._pendingNavOriginPos
					? { x: canvasState._pendingNavOriginPos.x, y: canvasState._pendingNavOriginPos.y }
					: null;
				let activePos;
				if (navOrigin) {
					activePos = navOrigin;
				} else if (getCySchemaInstance()) {
					const cyActive = getCySchemaInstance().getElementById('o_' + view.activeName);
					if (cyActive && cyActive.length) {
						activePos = cyActive.position();
					}
				}
				if (!activePos) {
					activePos = selPositionByName.get(view.activeName) || { x: 0, y: 0 };
				}
				const ringNodes = view.elements.filter((el) => el.group === 'nodes' && el.data.kind === 'ring');
				const ringN = ringNodes.length;
				view.elements.forEach((el) => {
					if (el.group !== 'nodes') {
						return;
					}
					if (el.data.kind === 'sel-active' && navOrigin) {
						el.position = { x: navOrigin.x, y: navOrigin.y };
						return;
					}
					if (el.data.kind === 'sel' || el.data.kind === 'sel-active') {
						const pos = selPositionByName.get(el.data.objectName);
						if (pos) {
							el.position = { x: pos.x, y: pos.y };
						}
					}
				});
				function _bestRingRotation(activePos, ringN, otherNodes) {
					if (ringN === 0) {
						return startAngle;
					}
					const blockedAngles = [];
					otherNodes.forEach((n) => {
						if (!n.position) {
							return;
						}
						const dx = n.position.x - activePos.x;
						const dy = n.position.y - activePos.y;
						if (dx === 0 && dy === 0) {
							return;
						}
						blockedAngles.push(Math.atan2(dy, dx));
					});
					if (blockedAngles.length === 0) {
						return startAngle;
					}
					let bestRotation = startAngle;
					let bestMinDist = -1;
					const TWO_PI = 2 * Math.PI;
					const angularDist = (a, b) => {
						const d = Math.abs((((a - b) % TWO_PI) + TWO_PI) % TWO_PI);
						return Math.min(d, TWO_PI - d);
					};
					const samples = 48;
					for (let s = 0; s < samples; s++) {
						const rot = startAngle + (s / samples) * TWO_PI;
						let minDist = Infinity;
						for (let i = 0; i < ringN; i++) {
							const slot = rot + (i / ringN) * TWO_PI;
							for (const blocked of blockedAngles) {
								const d = angularDist(slot, blocked);
								if (d < minDist) {
									minDist = d;
								}
							}
						}
						if (minDist > bestMinDist) {
							bestMinDist = minDist;
							bestRotation = rot;
						}
					}
					return bestRotation;
				}
				const otherPositionedNodes = [];
				view.elements.forEach((el) => {
					if (el.group !== 'nodes') {
						return;
					}
					if (el.data.kind === 'spawn-btn' || el.data.kind === 'ring') {
						return;
					}
					if (el.data.id === 'o_' + view.activeName) {
						return;
					}
					let position = null;
					if (getCySchemaInstance()) {
						const cyEl = getCySchemaInstance().getElementById(el.data.id);
						if (cyEl && cyEl.length) {
							position = cyEl.position();
						}
					}
					if (!position) {
						position = el.position;
					}
					if (position) {
						otherPositionedNodes.push({ position });
					}
				});
				const ringStartAngle = _bestRingRotation(activePos, ringN, otherPositionedNodes);
				ringNodes.forEach((node, i) => {
					const angle = ringN === 0 ? 0 : ringStartAngle + (i / ringN) * 2 * Math.PI;
					node.position = {
						x: activePos.x + SPOKE_RADIUS * Math.cos(angle),
						y: activePos.y + SPOKE_RADIUS * Math.sin(angle),
					};
				});
				view.elements.forEach((el) => {
					if (el.group !== 'nodes' || el.data.kind !== 'spawn-btn') {
						return;
					}
					const parentEl = view.elements.find(
						(p) => p.group === 'nodes' && p.data.id === 'o_' + el.data.spawnFor,
					);
					const parentPos = parentEl && parentEl.position ? parentEl.position : activePos;
					el.position = {
						x: parentPos.x + SCHEMA_SPAWN_OFFSET_X,
						y: parentPos.y + SCHEMA_SPAWN_OFFSET_Y,
					};
				});
				view.elements.forEach((el) => {
					if (el.group !== 'nodes' || el.data.kind !== 'expand-btn') {
						return;
					}
					const parentEl = view.elements.find(
						(p) => p.group === 'nodes' && p.data.id === 'o_' + el.data.expandFor,
					);
					const parentPos = parentEl && parentEl.position ? parentEl.position : activePos;
					el.position = {
						x: parentPos.x + SCHEMA_EXPAND_OFFSET_X,
						y: parentPos.y + SCHEMA_EXPAND_OFFSET_Y,
					};
				});

				let activeNodeIsNewlyAdded = false;
				let cyJustCreated = false;

				if (!getCySchemaInstance()) {
					activeNodeIsNewlyAdded = true;
					cyJustCreated = true;
					setCySchemaInstance(
						cytoscape({
							container,
							elements: view.elements,
							style: SCHEMA_STYLE,
							layout: { name: 'preset', fit: false },
							boxSelectionEnabled: false,
							userPanningEnabled: false,
							zoom: 0.7,
						}),
					);
					getCySchemaInstance()
						.nodes('[kind = "spawn-btn"], [kind = "expand-btn"]')
						.ungrabify()
						.unselectify();
					attachCyEdgeMarkers(getCySchemaInstance(), container);
					attachCyMiddleClickPan(getCySchemaInstance(), container);
					attachCyWheelZoom(getCySchemaInstance(), container);
					container.addEventListener('contextmenu', (e) => e.preventDefault());

					getCySchemaInstance().on('position', 'node', (evt) => {
						const target = evt.target;
						const dd = target.data();
						if (dd.kind !== 'sel' && dd.kind !== 'sel-active') {
							return;
						}
						const objName = dd.objectName;
						if (!objName) {
							return;
						}
						const cyInst = getCySchemaInstance();
						const p = target.position();
						const spawn = cyInst.getElementById('spawn_' + objName);
						if (spawn && spawn.length) {
							spawn.position({
								x: p.x + SCHEMA_SPAWN_OFFSET_X,
								y: p.y + SCHEMA_SPAWN_OFFSET_Y,
							});
						}
						const expand = cyInst.getElementById('expand_' + objName);
						if (expand && expand.length) {
							expand.position({
								x: p.x + SCHEMA_EXPAND_OFFSET_X,
								y: p.y + SCHEMA_EXPAND_OFFSET_Y,
							});
						}
					});

					getCySchemaInstance().on('dbltap', 'node', (evt) => {
						const d = evt.target.data();
						if (!d || (d.kind !== 'sel' && d.kind !== 'sel-active')) {
							return;
						}
						const objectName = d.objectName;
						if (!objectName) {
							return;
						}
						if (_expandedObjectName === objectName) {
							_hideSchemaFieldsPanel();
							return;
						}
						_showSchemaFieldsPanel(objectName, evt.target);
					});
					getCySchemaInstance().on('tap', (evt) => {
						if (evt.target === getCySchemaInstance()) {
							_hideSchemaFieldsPanel();
						}
					});

					getCySchemaInstance().on('tap', 'node', (evt) => {
						const d = evt.target.data();
						if (d && d.kind === 'spawn-btn') {
							if (d.spawnFor) {
								_spawnRecordFromSchemaObject(d.spawnFor);
							}
							return;
						}
						if (d && d.kind === 'expand-btn') {
							const objectName = d.expandFor;
							if (!objectName) {
								return;
							}
							const parent = getCySchemaInstance().getElementById('o_' + objectName);
							if (!parent || parent.length === 0) {
								return;
							}
							if (_expandedObjectName === objectName) {
								_hideSchemaFieldsPanel();
							} else {
								_showSchemaFieldsPanel(objectName, parent);
							}
							return;
						}
						const targetName = d && (d.objectName || d.ringObject);
						if (!targetName) {
							return;
						}
						const cyActive = getCySchemaInstance()
							.nodes()
							.filter((n) => n.data('kind') === 'sel-active')
							.first();
						const previousActive = cyActive && cyActive.length ? cyActive.data('objectName') || null : null;
						if (!previousActive || previousActive === targetName) {
							return;
						}
						const ringField = d.ringField || null;
						const ringDirection = d.ringDirection || null;
						const tappedPos = evt.target.position();
						canvasState._pendingNavOriginPos = { x: tappedPos.x, y: tappedPos.y };
						_hideSchemaFieldsPanel();
						const cached = _resolveDescribeData(targetName);
						const apply = () => {
							if (!canvasState._schemaViewPath.includes(previousActive)) {
								canvasState._schemaViewPath.push(previousActive);
							}
							if (ringField && ringDirection) {
								const stepKey =
									previousActive + '|' + targetName + '|' + ringField + '|' + ringDirection;
								if (!canvasState._schemaViewPathEdges.some((e) => e.key === stepKey)) {
									canvasState._schemaViewPathEdges.push({
										key: stepKey,
										from: previousActive,
										to: targetName,
										field: ringField,
										direction: ringDirection,
									});
								}
							}
							canvasState._schemaViewObject = targetName;
							renderCanvas();
						};
						if (cached) {
							apply();
						} else if (typeof fetchGraphData === 'function') {
							fetchGraphData(targetName)
								.then(apply)
								.catch((err) => {
									console.warn('schema nav: fetchGraphData failed for', targetName, err);
								});
						}
					});
				} else if (sigChanged) {
					canvasState._pendingNavOriginPos = null;
					const wantedIds = new Set(view.elements.map((e) => e.data.id));
					const obsolete = getCySchemaInstance()
						.elements()
						.filter((el) => !wantedIds.has(el.id()));
					if (obsolete.length) {
						obsolete.remove();
					}
					const activeId = 'o_' + view.activeName;
					view.elements.forEach((el) => {
						const cyEl = getCySchemaInstance().getElementById(el.data.id);
						if (!cyEl || !cyEl.length) {
							if (el.data.id === activeId) {
								activeNodeIsNewlyAdded = true;
							}
							getCySchemaInstance().add(el);
						}
					});
					view.nodeKindById.forEach((kind, id) => {
						const el = getCySchemaInstance().getElementById(id);
						if (el && el.length && el.data('kind') !== kind) {
							el.data('kind', kind);
						}
					});
					view.elements.forEach((element) => {
						if (element.group !== 'nodes' || element.data.kind !== 'ring' || !element.position) {
							return;
						}
						const ringNode = getCySchemaInstance().getElementById(element.data.id);
						if (!ringNode || !ringNode.length) {
							return;
						}
						const basePosition = { x: element.position.x, y: element.position.y };
						if (_expandedCyNode && _expandedNeighborPositions) {
							_expandedNeighborPositions.set(ringNode.id(), basePosition);
						} else {
							ringNode.position(basePosition);
						}
					});
					getCySchemaInstance()
						.nodes('[kind = "spawn-btn"], [kind = "expand-btn"]')
						.ungrabify()
						.unselectify();
					_syncExpandedSchemaNeighbors();
					if (typeof redrawCyEdgeMarkers === 'function') {
						redrawCyEdgeMarkers(getCySchemaInstance(), container);
					}
				} else {
					view.nodeKindById.forEach((kind, id) => {
						const el = getCySchemaInstance().getElementById(id);
						if (el && el.length && el.data('kind') !== kind) {
							el.data('kind', kind);
						}
					});
				}

				(function _parkAllSatellites() {
					const cyI = getCySchemaInstance();
					if (!cyI) {
						return;
					}
					cyI.nodes('[kind = "sel"], [kind = "sel-active"]').forEach((node) => {
						const objName = node.data('objectName');
						if (!objName) {
							return;
						}
						const p = node.position();
						const sp = cyI.getElementById('spawn_' + objName);
						if (sp && sp.length && !sp.data('expandedHidden')) {
							sp.position({ x: p.x + SCHEMA_SPAWN_OFFSET_X, y: p.y + SCHEMA_SPAWN_OFFSET_Y });
						}
						const ex = cyI.getElementById('expand_' + objName);
						if (ex && ex.length && !ex.data('expandedHidden')) {
							ex.position({ x: p.x + SCHEMA_EXPAND_OFFSET_X, y: p.y + SCHEMA_EXPAND_OFFSET_Y });
						}
					});
				})();

				requestAnimationFrame(() => {
					if (!getCySchemaInstance()) {
						return;
					}
					getCySchemaInstance().resize();
					const activeNode = getCySchemaInstance().getElementById('o_' + view.activeName);
					if (!activeNode || !activeNode.length) {
						getCySchemaInstance().fit(undefined, 60);
						return;
					}
					if (cyJustCreated) {
						const allNodes = getCySchemaInstance().nodes();
						if (allNodes.length <= 1) {
							getCySchemaInstance().zoom(0.7);
						} else {
							getCySchemaInstance().fit(undefined, 80);
							if (getCySchemaInstance().zoom() > 1) {
								getCySchemaInstance().zoom(1);
							}
						}
						getCySchemaInstance().center(activeNode);
					}
					getCySchemaInstance().elements().unselect();
					activeNode.select();
					if (activeNodeIsNewlyAdded) {
						const targetActiveId = 'o_' + view.activeName;
						setTimeout(() => {
							if (!getCySchemaInstance()) {
								return;
							}
							const node = getCySchemaInstance().getElementById(targetActiveId);
							if (!node || !node.length) {
								return;
							}
							getCySchemaInstance().animate(
								{ center: { eles: node } },
								{ duration: 800, easing: 'ease-out' },
							);
						}, 0);
					}
				});
			}

			function makeNode(label, name, relation, x, y, variant, onRemove, cloneOpts, loading) {
				const div = document.createElement('div');
				div.className = 'graph-node ' + (variant || '') + (loading ? ' loading' : '');
				div.style.left = x + 'px';
				div.style.top = y + 'px';
				const removable = typeof onRemove === 'function';
				const clonable = !!(cloneOpts && typeof cloneOpts.onClone === 'function');
				let html = '';
				if (removable) {
					const title = variant === 'unselected' ? 'Hide from view' : 'Remove from selection';
					html += '<button class="node-remove" data-node-remove title="' + title + '">\u00D7</button>';
				}
				html += '<div class="obj-label">' + escapeHtml(label) + '</div>';
				if (name && name !== label) {
					html += '<div class="obj-name">' + escapeHtml(name) + '</div>';
				}
				if (loading) {
					html +=
						'<div class="graph-node-loading" aria-label="Loading related objects">' +
						'<span class="graph-node-spinner"></span>' +
						'</div>';
				}
				if (clonable) {
					const count = Number(cloneOpts.count || 0);
					html +=
						'<button class="node-clone" data-node-clone title="Add a record of ' +
						escapeHtml(label) +
						' to the canvas">' +
						'+ record <span class="node-clone-count">' +
						count +
						'</span>' +
						'</button>';
				}
				div.innerHTML = html;
				if (relation) {
					div.title = (div.title ? div.title + ' -' : '') + relation;
				}
				if (loading) {
					div.title = (div.title ? div.title + ' -' : '') + 'Loading related objects\u2026';
				}
				if (removable) {
					const btn = div.querySelector('[data-node-remove]');
					btn.addEventListener('click', (e) => {
						e.stopPropagation();
						onRemove();
					});
				}
				if (clonable) {
					const cb = div.querySelector('[data-node-clone]');
					if (cb) {
						cb.addEventListener('click', (e) => {
							e.stopPropagation();
							cloneOpts.onClone();
						});
					}
				}
				return div;
			}

			return {
				renderCanvas: renderCanvas,
				makeNode: makeNode,
			};
		},
	};
})();

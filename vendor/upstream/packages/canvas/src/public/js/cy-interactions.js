(function () {
	'use strict';
	// Centralizes Cytoscape selection, panning, zooming, and relationship-edge affordances.

	window.OrgLoom = window.OrgLoom || {};

	function wheelZoomFactor(event) {
		// Normalize line/page units and preserve small high-resolution wheel deltas.
		const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1;
		const pixels = Number(event.deltaY) * unit;
		if (!Number.isFinite(pixels)) return 1;
		// Bound a single event, including accelerated mouse-wheel input.
		return Math.pow(0.9, Math.max(-100, Math.min(100, pixels)) / 100);
	}

	window.OrgLoom.cyInteractions = {
		wheelZoomFactor,
		mount: function mount(deps) {
			const required = ['getCanvasSpaceHeld', 'setCanvasMiddleMousePanning'];
			if (!deps) {
				throw new Error('cy-interactions.mount: missing deps object');
			}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('cy-interactions.mount: missing dep ' + k);
				}
			}
			const getCanvasSpaceHeld = deps.getCanvasSpaceHeld;
			const setCanvasMiddleMousePanning = deps.setCanvasMiddleMousePanning;

			const _CY_MARKER_COLOR = '#9aa0a8';
			const _CY_MARKER_COLOR_SEL = '#e09240';
			const _CY_MARKERS_DEFS =
				'<marker id="cy-crowfoot" viewBox="0 0 14 14" markerWidth="14" markerHeight="14" refX="14" refY="7" markerUnits="userSpaceOnUse" orient="auto-start-reverse">' +
				'<path d="M0,7 L14,0 M0,7 L14,14 M0,7 L14,7" fill="none" stroke="' +
				_CY_MARKER_COLOR +
				'" stroke-width="1.4"/>' +
				'</marker>' +
				'<marker id="cy-bar" viewBox="0 0 12 14" markerWidth="12" markerHeight="14" refX="10" refY="7" markerUnits="userSpaceOnUse" orient="auto-start-reverse">' +
				'<line x1="4" y1="0" x2="4" y2="14" stroke="' +
				_CY_MARKER_COLOR +
				'" stroke-width="1.6"/>' +
				'</marker>';
			function _ensureCyEdgeMarkersSvg(container) {
				let svg = container.querySelector(':scope > .cy-edge-markers-svg');
				if (svg) {
					return svg;
				}
				const ns = 'http://www.w3.org/2000/svg';
				svg = document.createElementNS(ns, 'svg');
				svg.setAttribute('class', 'cy-edge-markers-svg');
				svg.setAttribute('width', '100%');
				svg.setAttribute('height', '100%');
				const defs = document.createElementNS(ns, 'defs');
				defs.innerHTML = _CY_MARKERS_DEFS;
				svg.appendChild(defs);
				container.appendChild(svg);
				return svg;
			}
			function redrawCyEdgeMarkers(cy, container) {
				const svg = _ensureCyEdgeMarkersSvg(container);
				Array.from(svg.children).forEach((el) => {
					if (el.tagName.toLowerCase() !== 'defs') {
						svg.removeChild(el);
					}
				});
				const ns = 'http://www.w3.org/2000/svg';
				cy.edges('[kind = "fk"], [kind = "host"], [kind = "ring"]').forEach((edge) => {
					const r1 = edge.renderedSourceEndpoint();
					const r2 = edge.renderedTargetEndpoint();
					// During graph updates, endpoints may exist before their rendered
					// coordinates are ready. The next render will redraw these markers.
					if (!r1 || !r2 || ![r1.x, r1.y, r2.x, r2.y].every(Number.isFinite)) {
						return;
					}
					const dx = r2.x - r1.x,
						dy = r2.y - r1.y;
					const len = Math.hypot(dx, dy);
					if (!Number.isFinite(len) || len < 1) {
						return;
					}
					const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
					const markerColor = edge.hasClass('edge-picked') ? _CY_MARKER_COLOR_SEL : _CY_MARKER_COLOR;
					let crowAt = r1,
						barAt = r2,
						crowAngle = angleDeg,
						barAngle = angleDeg + 180;
					if (edge.data('kind') === 'ring') {
						const ringKind = edge.target().data('kind') || '';
						if (ringKind === 'ring-child') {
							crowAt = r2;
							barAt = r1;
							crowAngle = angleDeg + 180;
							barAngle = angleDeg;
						}
					}
					const crow = document.createElementNS(ns, 'g');
					crow.setAttribute(
						'transform',
						'translate(' + crowAt.x + ',' + crowAt.y + ') rotate(' + crowAngle + ')',
					);
					const crowPath = document.createElementNS(ns, 'path');
					crowPath.setAttribute('d', 'M14,0 L0,-7 M14,0 L0,7 M14,0 L0,0');
					crowPath.setAttribute('fill', 'none');
					crowPath.setAttribute('stroke', markerColor);
					crowPath.setAttribute('stroke-width', '1.4');
					crow.appendChild(crowPath);
					svg.appendChild(crow);
					const bar = document.createElementNS(ns, 'g');
					bar.setAttribute(
						'transform',
						'translate(' + barAt.x + ',' + barAt.y + ') rotate(' + barAngle + ')',
					);
					const barLine = document.createElementNS(ns, 'line');
					barLine.setAttribute('x1', '4');
					barLine.setAttribute('y1', '-7');
					barLine.setAttribute('x2', '4');
					barLine.setAttribute('y2', '7');
					barLine.setAttribute('stroke', markerColor);
					barLine.setAttribute('stroke-width', '1.6');
					bar.appendChild(barLine);
					svg.appendChild(bar);
				});
			}
			const _cyMarkersAttached = new WeakSet();
			function attachCyEdgeMarkers(cy, container) {
				if (!cy || !container || _cyMarkersAttached.has(cy)) {
					return;
				}
				_cyMarkersAttached.add(cy);
				const redraw = () => redrawCyEdgeMarkers(cy, container);
				cy.on('render', redraw);
				cy.on('add remove data', 'edge', redraw);
				cy.on('classChange', 'edge', redraw);
				redraw();
			}

			const _cyMarqueeAttached = new WeakSet();

			function attachCyMarqueeSelect(cy, container, onSelectionUpdate) {
				if (!cy || !container || _cyMarqueeAttached.has(cy)) {
					return;
				}
				_cyMarqueeAttached.add(cy);
				const EDGE = 32;
				const MAX_VEL = 14;
				let marquee = null;
				let autoPanRaf = null;
				const projectStart = () => {
					if (!marquee) {
						return { x: 0, y: 0 };
					}
					const pan = cy.pan();
					const zoom = cy.zoom();
					return {
						x: marquee.worldStart.x * zoom + pan.x,
						y: marquee.worldStart.y * zoom + pan.y,
					};
				};
				const update = () => {
					if (!marquee) {
						return;
					}
					const s = projectStart();
					const c = marquee.current;
					const left = Math.min(s.x, c.x);
					const top = Math.min(s.y, c.y);
					marquee.box.style.left = left + 'px';
					marquee.box.style.top = top + 'px';
					marquee.box.style.width = Math.abs(c.x - s.x) + 'px';
					marquee.box.style.height = Math.abs(c.y - s.y) + 'px';
				};
				const autoPanTick = () => {
					autoPanRaf = null;
					if (!marquee) {
						return;
					}
					const rect = container.getBoundingClientRect();
					const w = rect.width;
					const h = rect.height;
					const c = marquee.current;
					let vx = 0,
						vy = 0;
					if (c.x < EDGE) {
						vx = MAX_VEL * Math.min(1, (EDGE - c.x) / EDGE);
					} else if (c.x > w - EDGE) {
						vx = -MAX_VEL * Math.min(1, (c.x - (w - EDGE)) / EDGE);
					}
					if (c.y < EDGE) {
						vy = MAX_VEL * Math.min(1, (EDGE - c.y) / EDGE);
					} else if (c.y > h - EDGE) {
						vy = -MAX_VEL * Math.min(1, (c.y - (h - EDGE)) / EDGE);
					}
					if (vx !== 0 || vy !== 0) {
						cy.panBy({ x: vx, y: vy });
						update();
					}
					autoPanRaf = requestAnimationFrame(autoPanTick);
				};
				const scheduleAutoPan = () => {
					if (autoPanRaf != null) {
						return;
					}
					autoPanRaf = requestAnimationFrame(autoPanTick);
				};
				const stopAutoPan = () => {
					if (autoPanRaf != null) {
						cancelAnimationFrame(autoPanRaf);
						autoPanRaf = null;
					}
				};
				const finish = () => {
					if (!marquee) {
						return;
					}
					stopAutoPan();
					const s = projectStart();
					const c = marquee.current;
					const worldStart = marquee.worldStart;
					const additive = marquee.additive;
					const box = marquee.box;
					marquee = null;
					if (box && box.parentNode) {
						box.parentNode.removeChild(box);
					}
					const dx = Math.abs(c.x - s.x);
					const dy = Math.abs(c.y - s.y);
					if (dx < 3 && dy < 3) {
						if (typeof onSelectionUpdate === 'function') {
							onSelectionUpdate([], additive);
						}
						return;
					}
					const pan = cy.pan();
					const zoom = cy.zoom();
					const worldCurrent = {
						x: (c.x - pan.x) / zoom,
						y: (c.y - pan.y) / zoom,
					};
					const w = {
						x1: Math.min(worldStart.x, worldCurrent.x),
						y1: Math.min(worldStart.y, worldCurrent.y),
						x2: Math.max(worldStart.x, worldCurrent.x),
						y2: Math.max(worldStart.y, worldCurrent.y),
					};
					const hits = [];
					cy.elements('node[kind ^= "card"]').forEach((node) => {
						const bb = node.boundingBox();
						if (bb.x2 < w.x1 || bb.x1 > w.x2 || bb.y2 < w.y1 || bb.y1 > w.y2) {
							return;
						}
						hits.push(node);
					});
					if (typeof onSelectionUpdate === 'function') {
						onSelectionUpdate(hits, additive);
					}
				};
				// Cytoscape may miss tapend when a release happens outside its
				// iframe/webview. End the drag on document/window lifecycle events
				// too, preserving the selection and stopping edge auto-panning.
				const release = (event) => {
					if (event.button != null && event.button !== 0) return;
					if (marquee && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
						const rect = container.getBoundingClientRect();
						marquee.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
					}
					finish();
				};
				const recoverRelease = (event) => {
					if (event.buttons === 0) finish();
				};
				const visibilityChanged = () => {
					if (document.hidden) finish();
				};
				const leaveDocument = (event) => {
					if (
						!event.relatedTarget &&
						(event.target === document || event.target === document.documentElement)
					)
						finish();
				};
				const listeners = [
					[document, 'mouseup', release],
					[document, 'pointerup', release],
					[document, 'pointercancel', finish],
					[document, 'mousemove', recoverRelease],
					[document, 'pointermove', recoverRelease],
					[document, 'mouseleave', leaveDocument],
					[document, 'visibilitychange', visibilityChanged],
					[window, 'blur', finish],
					[window, 'pagehide', finish],
				];
				for (const [target, type, handler] of listeners) {
					target.addEventListener(type, handler, true);
				}
				cy.on('destroy', () => {
					stopAutoPan();
					if (marquee) marquee.box.remove();
					marquee = null;
					for (const [target, type, handler] of listeners) {
						target.removeEventListener(type, handler, true);
					}
				});
				cy.on('tapstart', (evt) => {
					if (evt.target !== cy) {
						return;
					} // background only
					const oe = evt.originalEvent;
					if (!oe) {
						return;
					}
					if (oe.button != null && oe.button !== 0) {
						return;
					} // left click only
					if (getCanvasSpaceHeld()) {
						return;
					}
					finish(); // A new gesture must never orphan an earlier box.
					const rect = container.getBoundingClientRect();
					const start = { x: oe.clientX - rect.left, y: oe.clientY - rect.top };
					const pan = cy.pan();
					const zoom = cy.zoom();
					const worldStart = {
						x: (start.x - pan.x) / zoom,
						y: (start.y - pan.y) / zoom,
					};
					const additive = !!(oe.shiftKey || oe.metaKey || oe.ctrlKey);
					const box = document.createElement('div');
					box.className = 'cy-marquee';
					container.appendChild(box);
					marquee = { worldStart, current: { x: start.x, y: start.y }, additive, box };
					update();
				});
				cy.on('tapdrag', (evt) => {
					if (!marquee) {
						return;
					}
					const oe = evt.originalEvent;
					if (!oe) {
						return;
					}
					const rect = container.getBoundingClientRect();
					marquee.current = { x: oe.clientX - rect.left, y: oe.clientY - rect.top };
					update();
					scheduleAutoPan();
				});
				cy.on('tapend', (evt) => {
					if (!marquee) {
						return;
					}
					const oe = evt.originalEvent;
					if (oe) {
						const rect = container.getBoundingClientRect();
						marquee.current = { x: oe.clientX - rect.left, y: oe.clientY - rect.top };
					}
					finish();
				});
			}

			const _cySpacePanAttached = new WeakSet();
			function attachCySpacePan(cy, container) {
				if (!cy || !container || _cySpacePanAttached.has(cy)) {
					return;
				}
				_cySpacePanAttached.add(cy);
				let active = false;
				let lastX = 0,
					lastY = 0;
				container.addEventListener(
					'pointerdown',
					(e) => {
						if (e.button !== 0) {
							return;
						} // left button only
						if (!getCanvasSpaceHeld()) {
							return;
						} // gate on Space
						active = true;
						lastX = e.clientX;
						lastY = e.clientY;
						try {
							container.setPointerCapture(e.pointerId);
						} catch (_) {}
						e.preventDefault();
						e.stopPropagation(); // suppress marquee fallback
					},
					true,
				); // capture phase: beat marquee
				container.addEventListener('pointermove', (e) => {
					if (!active) {
						return;
					}
					cy.panBy({ x: e.clientX - lastX, y: e.clientY - lastY });
					lastX = e.clientX;
					lastY = e.clientY;
				});
				const finish = (e) => {
					if (!active) {
						return;
					}
					active = false;
					try {
						container.releasePointerCapture(e.pointerId);
					} catch (_) {}
				};
				container.addEventListener('pointerup', finish);
				container.addEventListener('pointercancel', finish);
			}

			const _cyMmbAttached = new WeakSet();
			const _cyWheelAttached = new WeakMap();
			function attachCyWheelZoom(cy, container) {
				if (!cy || !container || cy.destroyed()) {
					return;
				}
				const previous = _cyWheelAttached.get(container);
				if (previous && previous.cy === cy) return;
				if (previous) previous.cleanup();
				const onWheel = (ev) => {
					if (cy.destroyed() || ev.defaultPrevented) return;
					if (!container.contains(ev.target)) {
						return;
					}
					const rect = container.getBoundingClientRect();
					if (
						ev.clientX < rect.left ||
						ev.clientX > rect.right ||
						ev.clientY < rect.top ||
						ev.clientY > rect.bottom
					) {
						return;
					}
					if (ev.ctrlKey) {
						ev.preventDefault();
					}
					if (ev.deltaY === 0) {
						return;
					}
					if (!ev.ctrlKey) {
						ev.preventDefault();
					}
					const rx = ev.clientX - rect.left;
					const ry = ev.clientY - rect.top;
					const step = wheelZoomFactor(ev);
					const cur = cy.zoom();
					const next = Math.max(0.2, Math.min(4, cur * step));
					if (next === cur) {
						return;
					}
					cy.zoom({ level: next, renderedPosition: { x: rx, y: ry } });
				};
				const cleanup = () => {
					document.removeEventListener('wheel', onWheel, true);
					cy.off('destroy', cleanup);
					if (_cyWheelAttached.get(container)?.cy === cy) _cyWheelAttached.delete(container);
				};
				_cyWheelAttached.set(container, { cy, cleanup });
				document.addEventListener('wheel', onWheel, { passive: false, capture: true });
				cy.on('destroy', cleanup);
			}

			function attachCyMiddleClickPan(cy, container) {
				if (!cy || !container || _cyMmbAttached.has(cy)) {
					return;
				}
				_cyMmbAttached.add(cy);
				let active = false;
				let lastX = 0,
					lastY = 0;
				document.addEventListener(
					'pointerdown',
					(e) => {
						if (e.button !== 1) {
							return;
						} // middle button only
						const rect = container.getBoundingClientRect();
						if (
							e.clientX < rect.left ||
							e.clientX > rect.right ||
							e.clientY < rect.top ||
							e.clientY > rect.bottom
						) {
							return;
						}
						active = true;
						lastX = e.clientX;
						lastY = e.clientY;
						setCanvasMiddleMousePanning(true);
						container.style.cursor = 'grabbing';
						e.preventDefault();
					},
					true,
				); // capture phase: beat the marquee handler
				document.addEventListener('pointermove', (e) => {
					if (!active) {
						return;
					}
					cy.panBy({ x: e.clientX - lastX, y: e.clientY - lastY });
					lastX = e.clientX;
					lastY = e.clientY;
				});
				const finish = () => {
					if (!active) {
						return;
					}
					active = false;
					setCanvasMiddleMousePanning(false);
					container.style.cursor = '';
				};
				document.addEventListener('pointerup', finish);
				document.addEventListener('pointercancel', finish);
				container.addEventListener('auxclick', (e) => {
					if (e.button === 1) {
						e.preventDefault();
					}
				});
			}

			return {
				attachCyEdgeMarkers: attachCyEdgeMarkers,
				redrawCyEdgeMarkers: redrawCyEdgeMarkers,
				attachCyMarqueeSelect: attachCyMarqueeSelect,
				attachCySpacePan: attachCySpacePan,
				attachCyWheelZoom: attachCyWheelZoom,
				attachCyMiddleClickPan: attachCyMiddleClickPan,
			};
		},
	};
})();

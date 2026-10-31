(function () {
	'use strict';
	// Computes deterministic canvas positions for connected record components.

	window.OrgLoom = window.OrgLoom || {};

	function componentLayoutName(nodeCount, edgeCount) {
		// Breadth-first is useful for a small hierarchy, but it creates extremely
		// wide levels for large or densely linked imports. A compact grid gives
		// those graphs a predictable, bounded starting footprint.
		if (nodeCount >= 30 || edgeCount > Math.max(1, nodeCount - 1)) {
			return 'grid';
		}
		return 'breadthfirst';
	}

	function compactGridColumns(nodeCount) {
		// Cards are roughly twice as wide as they are tall, so fewer columns than
		// rows produces a visually square component.
		return Math.max(1, Math.ceil(Math.sqrt(Math.max(1, nodeCount) / 2)));
	}

	function minimumOverviewZoom(cardCount) {
		return cardCount >= 100 ? 0 : 0.4;
	}

	function findImportSpace(width, height, obstacles, center, gap = 80) {
		const preferred = { x: center.x - width / 2, y: center.y - height / 2 };
		const candidates = [preferred];
		let right = preferred.x;
		for (const box of obstacles) {
			const leftX = box.x1 - gap - width;
			const rightX = box.x2 + gap;
			const topY = box.y1 - gap - height;
			const bottomY = box.y2 + gap;
			right = Math.max(right, rightX);
			for (const x of [leftX, rightX]) {
				for (const y of [preferred.y, topY, bottomY]) {
					candidates.push({ x, y });
				}
			}
			candidates.push({ x: preferred.x, y: topY }, { x: preferred.x, y: bottomY });
		}
		// Guaranteed fallback outside all occupied bounds, even for a crowded canvas.
		candidates.push({ x: right, y: preferred.y });
		candidates.sort(
			(a, b) =>
				(a.x - preferred.x) ** 2 +
				(a.y - preferred.y) ** 2 -
				((b.x - preferred.x) ** 2 + (b.y - preferred.y) ** 2),
		);
		return candidates.find((point) =>
			obstacles.every(
				(box) =>
					point.x + width <= box.x1 - gap ||
					point.x >= box.x2 + gap ||
					point.y + height <= box.y1 - gap ||
					point.y >= box.y2 + gap,
			),
		);
	}

	window.OrgLoom.treeLayout = {
		_test: {
			componentLayoutName: componentLayoutName,
			compactGridColumns: compactGridColumns,
			minimumOverviewZoom: minimumOverviewZoom,
			findImportSpace: findImportSpace,
		},
		mount: function mount(deps) {
			if (!deps || !deps.canvasState || !deps.getCyInstance) {
				throw new Error('tree-layout.mount: missing required deps (canvasState, getCyInstance)');
			}
			const canvasState = deps.canvasState;
			const getCyInstance = deps.getCyInstance;

			function relayoutNewRecords(newRecIds, options = {}) {
				const _cyInstance = getCyInstance();
				if (!_cyInstance || !newRecIds || newRecIds.size === 0) {
					return;
				}

				_cyInstance.stop(true, true);
				_cyInstance.elements().stop(true, true);
				_cyInstance.resize();
				const previousZoom = _cyInstance.zoom();
				const extent = _cyInstance.extent();
				const viewCenter = { x: (extent.x1 + extent.x2) / 2, y: (extent.y1 + extent.y2) / 2 };
				const occupied = options.focusImported
					? _cyInstance
							.elements()
							.filter((element) => {
								if (!element.visible()) {
									return false;
								}
								return element.isNode()
									? !newRecIds.has(element.data('recId'))
									: !newRecIds.has(element.source().data('recId')) &&
											!newRecIds.has(element.target().data('recId'));
							})
							.map((element) => element.boundingBox())
					: [];

				const newCyNodes = _cyInstance.nodes().filter((n) => newRecIds.has(n.data('recId')));
				const newCyEdges = _cyInstance
					.edges()
					.filter((e) => newRecIds.has(e.source().data('recId')) && newRecIds.has(e.target().data('recId')));
				const newEles = newCyNodes.union(newCyEdges);
				const EXISTING_GUTTER = 80;
				const existingCyNodes = _cyInstance.nodes().filter((n) => {
					const recId = n.data('recId');
					if (recId == null) {
						return false;
					}
					return !newRecIds.has(recId);
				});
				let existingMinX = Infinity,
					existingMaxX = -Infinity;
				let existingMinY = Infinity,
					existingMaxY = -Infinity;
				existingCyNodes.forEach((n) => {
					const bb = n.boundingBox();
					if (bb.x1 < existingMinX) {
						existingMinX = bb.x1;
					}
					if (bb.x2 > existingMaxX) {
						existingMaxX = bb.x2;
					}
					if (bb.y1 < existingMinY) {
						existingMinY = bb.y1;
					}
					if (bb.y2 > existingMaxY) {
						existingMaxY = bb.y2;
					}
				});
				const hasExisting = existingCyNodes.length > 0 && existingMaxX > -Infinity;
				const xStart = hasExisting ? existingMaxX + EXISTING_GUTTER : 0;
				const yStart = hasExisting ? existingMinY : 0;
				const hasEdges = newCyEdges.length > 0;
				let rootCyNodes = newCyNodes.filter((n) => n.outgoers('edge').length === 0);
				if (rootCyNodes.length === 0 && newCyNodes.length > 0) {
					const sorted = newCyNodes.toArray().sort((a, b) => b.degree() - a.degree());
					rootCyNodes = sorted.length > 0 ? _cyInstance.collection([sorted[0]]) : newCyNodes;
				}
				const useTreeLayout = newCyNodes.length >= 5 && hasEdges && rootCyNodes.length > 0;
				if (useTreeLayout) {
					const components = newEles.components();
					const compLaidOut = [];
					for (const comp of components) {
						const compNodes = comp.nodes();
						const compEdges = comp.edges();
						let compRoots = compNodes.filter((n) => n.outgoers('edge').length === 0);
						if (compRoots.length === 0 && compNodes.length > 0) {
							const sorted = compNodes.toArray().sort((a, b) => b.degree() - a.degree());
							compRoots = _cyInstance.collection([sorted[0]]);
						}
						const layoutName = componentLayoutName(compNodes.length, compEdges.length);
						const layoutOptions =
							layoutName === 'grid'
								? {
										name: 'grid',
										animate: false,
										fit: false,
										padding: 0,
										cols: compactGridColumns(compNodes.length),
										avoidOverlap: true,
										avoidOverlapPadding: 24,
										condense: true,
									}
								: {
										name: 'breadthfirst',
										animate: false,
										fit: false,
										padding: 0,
										directed: false,
										roots: compRoots.map((n) => n.id()),
										spacingFactor: 1.05,
										avoidOverlap: true,
										grid: true,
										maximalAdjustments: 5,
									};
						const compLayout = comp.layout(layoutOptions);
						compLayout.run();
						compLaidOut.push({ comp, bb: comp.boundingBox() });
					}
					const TREE_GUTTER = 40;
					const totalArea = compLaidOut.reduce((s, r) => s + r.bb.w * r.bb.h, 0);
					const targetRowWidth = Math.max(900, Math.sqrt(totalArea) * 1.15);
					let xCursor = xStart;
					let yCursor = yStart;
					let rowMaxH = 0;
					for (const { comp, bb } of compLaidOut) {
						if (xCursor > xStart && xCursor - xStart + bb.w > targetRowWidth) {
							xCursor = xStart;
							yCursor += rowMaxH + TREE_GUTTER;
							rowMaxH = 0;
						}
						const dx = xCursor - bb.x1;
						const dy = yCursor - bb.y1;
						comp.nodes().forEach((n) => {
							const p = n.position();
							n.position({ x: p.x + dx, y: p.y + dy });
						});
						xCursor += bb.w + TREE_GUTTER;
						if (bb.h > rowMaxH) {
							rowMaxH = bb.h;
						}
					}
				} else {
					const layout = newEles.layout(
						options.focusImported && !hasEdges
							? {
									name: 'grid',
									animate: false,
									fit: false,
									cols: compactGridColumns(newCyNodes.length),
									avoidOverlap: true,
									avoidOverlapPadding: 32,
									condense: true,
								}
							: {
									name: 'cose',
									animate: false,
									fit: false,
									padding: 60,
									nodeRepulsion: 400000,
									idealEdgeLength: 200,
									nodeOverlap: 30,
									randomize: false,
									numIter: 2500,
								},
					);
					layout.run();
					if (hasExisting && newCyNodes.length > 0) {
						const bb = newCyNodes.boundingBox();
						const dx = xStart - bb.x1;
						const dy = yStart - bb.y1;
						newCyNodes.forEach((n) => {
							const p = n.position();
							n.position({ x: p.x + dx, y: p.y + dy });
						});
					}
				}
				const cardSel = '[kind ^= "card"]';
				const allCards = _cyInstance.nodes(cardSel);
				const newCards = newCyNodes.filter(cardSel);
				if (options.focusImported && newCyNodes.length > 0) {
					const bounds = newEles.boundingBox();
					const space = findImportSpace(bounds.w, bounds.h, occupied, viewCenter);
					newCyNodes.shift({ x: space.x - bounds.x1, y: space.y - bounds.y1 });
					const target = newCards.length > 0 ? newCards : newCyNodes;
					_cyInstance.fit(target, 60);
					_cyInstance.zoom(Math.min(previousZoom, _cyInstance.zoom()));
					_cyInstance.center(target);
				} else {
					const fitTarget = allCards.length > 0 ? allCards : _cyInstance.elements();
					_cyInstance.fit(fitTarget, 60);
					const z = _cyInstance.zoom();
					const minZoom = minimumOverviewZoom(newCards.length);
					if (minZoom > 0 && z < minZoom) {
						_cyInstance.zoom(minZoom);
						_cyInstance.center(newCards.length > 0 ? newCards : fitTarget);
					} else if (z > 1) {
						_cyInstance.zoom(1);
						_cyInstance.center(fitTarget);
					}
				}
				_cyInstance.nodes().forEach((n) => {
					const recId = n.data('recId');
					if (recId == null) {
						return;
					}
					const rec = canvasState.bulkRecords.find((r) => r.id === recId);
					if (!rec) {
						return;
					}
					const p = n.position();
					rec.x = p.x;
					rec.y = p.y;
				});
			}

			return {
				relayoutNewRecords: relayoutNewRecords,
			};
		},
	};
})();

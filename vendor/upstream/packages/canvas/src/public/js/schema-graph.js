(function () {
	'use strict';
	// Converts describe relationships into schema nodes and directed lookup edges.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.schemaGraph = {
		mount: function mount(deps) {
			if (
				!deps ||
				!deps.canvasState ||
				!deps.csrfFetch ||
				!deps.escapeHtml ||
				!deps.addToSelection ||
				!deps.renderAll ||
				!deps.renderBulkView ||
				!deps.renderCanvas ||
				!deps.getGraph
			) {
				throw new Error('schema-graph.mount: missing required deps');
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			const addToSelection = deps.addToSelection;
			const renderAll = deps.renderAll;
			const renderBulkView = deps.renderBulkView;
			const renderCanvas = deps.renderCanvas;
			const getGraph = deps.getGraph;
			const graphRequests = new Map();

			function _runAfterSchemaTransition(cb) {
				const target =
					getGraph().querySelector('.graph-canvas-cy') || getGraph().querySelector('.graph-canvas');
				if (!target) {
					cb();
					return;
				}
				let fired = false;
				const fire = () => {
					if (fired) {
						return;
					}
					fired = true;
					target.removeEventListener('transitionend', handler);
					cb();
				};
				const handler = (ev) => {
					if (ev.target !== target) {
						return;
					}
					if (ev.propertyName !== 'flex-basis') {
						return;
					}
					fire();
				};
				target.addEventListener('transitionend', handler);
				setTimeout(fire, 280);
			}

			async function openGraph(objectName) {
				canvasState._suppressNextViewTransition = true;
				getGraph().classList.remove('hidden');
				canvasState.selectedObjects = [];
				canvasState.selectedIdSeq = 1;
				canvasState.activeIndex = 0;
				canvasState.hiddenObjects.clear();
				canvasState.graphFilterText = '';
				canvasState.graphRelFilter = 'parent';
				canvasState.graphZoom = 1;
				canvasState.bulkRecords = [];
				canvasState.bulkAssociations = [];
				canvasState.bulkIdSeq = 1;
				canvasState.bulkSelectedIds = new Set();
				canvasState.bulkSelectedEdgeId = null;
				canvasState.bulkClipboard = null;
				canvasState.bulkInitialized = false;
				canvasState._bulkUserDeleted = false;
				canvasState._lastBulkZoomSig = null;
				canvasState._bulkSeenIds = null;
				canvasState._prefetchedTypeNodeKeys.clear();
				canvasState._renderedRecIds.clear();
				canvasState.bulkZoom = 1;
				setGraphView('schema');
				const fi = getGraph().querySelector('#graph-filter-input');
				if (fi) {
					fi.value = '';
				}
				const fc = getGraph().querySelector('[data-graph-filter-clear]');
				if (fc) {
					fc.style.display = 'none';
				}
				getGraph().querySelector('#graph-nodes').innerHTML = '<div class="graph-empty">Loading…</div>';
				getGraph().querySelector('#graph-edges').innerHTML = '';
				try {
					await addToSelection(objectName);
					renderAll();
				} catch (err) {
					getGraph().querySelector('#graph-nodes').innerHTML =
						'<div class="graph-empty load-error">Failed to load: ' + escapeHtml(err.message) + '</div>';
				}
			}

			function closeGraph() {
				getGraph().classList.add('hidden');
				canvasState.selectedObjects = [];
				canvasState.selectedIdSeq = 1;
				canvasState.activeIndex = 0;
				canvasState.hiddenObjects.clear();
			}

			async function fetchGraphData(name) {
				if (canvasState.graphCache[name]) {
					return canvasState.graphCache[name];
				}
				if (graphRequests.has(name)) {
					return graphRequests.get(name);
				}
				const request = (async () => {
					const resp = await csrfFetch('/api/objects/' + encodeURIComponent(name) + '/graph');
					if (!resp.ok) {
						let serverMsg = '';
						try {
							const body = await resp.json();
							serverMsg = (body && body.message) || '';
						} catch (_) {}
						const noAccess =
							resp.status === 403 ||
							resp.status === 404 ||
							/does not exist|invalid_type|insufficient access|not accessible|no such sobject|is not supported/i.test(
								serverMsg,
							);
						const err = new Error(
							noAccess
								? 'your Salesforce user doesn’t have access to this object'
								: serverMsg || resp.statusText,
						);
						if (noAccess) {
							err.code = 'object-no-access';
						}
						throw err;
					}
					const data = await resp.json();
					canvasState.graphCache[name] = data;
					return data;
				})();
				graphRequests.set(name, request);
				try {
					return await request;
				} finally {
					graphRequests.delete(name);
				}
			}

			function setGraphView(view) {
				if (view === 'bulk' && canvasState.selectedObjects.length > 0) {
					renderBulkView();
				} else {
					renderCanvas();
				}
			}

			return {
				openGraph: openGraph,
				closeGraph: closeGraph,
				fetchGraphData: fetchGraphData,
				setGraphView: setGraphView,
				_runAfterSchemaTransition: _runAfterSchemaTransition,
			};
		},
	};
})();

(function () {
	'use strict';
	// Routes bulk actions through a shared selection model and permission-aware availability rules.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.bulkOpsMenu = {
		mount: function mount(deps) {
			const required = [
				'canvasState',
				'canEditCanvasStructure',
				'_hasCap',
				'isCapabilityReady',
				'bulkAutoFill',
				'bulkClearAllFields',
				'openLinkedCsvModal',
				'openAiGenModal',
				'getAiGen',
				'openSoqlImportModal',
				'openBrowseModal',
				'openBulkEditModal',
				'openBulkScriptModal',
				'openRecordDiffModal',
				'openCanvasSearchModal',
				'openFindDuplicatesModal',
				'openBulkRefreshFlow',
				'beginMigration',
				'openStandaloneRecordRequestPicker',
				'spawnPendingRecord',
				'triggerTemplateFileInput',
				'getGraph',
				'getCyInstance',
				'getCanvasSpaceHeld',
				'setCanvasSpaceHeld',
				'getCanvasZHeld',
				'setCanvasZHeld',
				'_isOnPaidPlan',
			];
			if (!deps) {
				throw new Error('bulk-ops-menu.mount: missing deps object');
			}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('bulk-ops-menu.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const escapeHtml = (value) =>
				String(value).replace(
					/[&<>"']/g,
					(character) =>
						({
							'&': '&amp;',
							'<': '&lt;',
							'>': '&gt;',
							'"': '&quot;',
							"'": '&#39;',
						})[character],
				);
			const canEditCanvasStructure = deps.canEditCanvasStructure;
			const _hasCap = deps._hasCap;
			const isCapabilityReady = deps.isCapabilityReady;
			const beginMigration = deps.beginMigration;
			const bulkAutoFill = deps.bulkAutoFill;
			const bulkClearAllFields = deps.bulkClearAllFields;
			const openLinkedCsvModal = deps.openLinkedCsvModal;
			const openAiGenModal = deps.openAiGenModal;
			const getAiGen = deps.getAiGen;
			const openSoqlImportModal = deps.openSoqlImportModal;
			const openBrowseModal = deps.openBrowseModal;
			const openBulkEditModal = deps.openBulkEditModal;
			const openBulkScriptModal = deps.openBulkScriptModal;
			const openRecordDiffModal = deps.openRecordDiffModal;
			const openCanvasSearchModal = deps.openCanvasSearchModal;
			const openFindDuplicatesModal = deps.openFindDuplicatesModal;
			const openBulkRefreshFlow = deps.openBulkRefreshFlow;
			const openStandaloneRecordRequestPicker = deps.openStandaloneRecordRequestPicker;
			const spawnPendingRecord = deps.spawnPendingRecord;
			const triggerTemplateFileInput = deps.triggerTemplateFileInput;
			const getGraph = deps.getGraph;
			const getCyInstance = deps.getCyInstance;
			const getCanvasSpaceHeld = deps.getCanvasSpaceHeld;
			const setCanvasSpaceHeld = deps.setCanvasSpaceHeld;
			const getCanvasZHeld = deps.getCanvasZHeld;
			const setCanvasZHeld = deps.setCanvasZHeld;
			const _isOnPaidPlan = deps._isOnPaidPlan;

			function _wireCanvasFloatingAdd() {
				if (getGraph().dataset.canvasWired === '1') {
					return;
				}
				getGraph().dataset.canvasWired = '1';
				const cyContainer = getGraph().querySelector('#bulk-canvas-cy');
				const legacyContainer = getGraph().querySelector('#bulk-canvas');
				const activeContainer = () => {
					if (cyContainer && cyContainer.offsetParent !== null) {
						return cyContainer;
					}
					if (legacyContainer && legacyContainer.offsetParent !== null) {
						return legacyContainer;
					}
					return cyContainer || legacyContainer;
				};
				const worldFromClient = (clientX, clientY) => {
					const container = activeContainer();
					if (!container) {
						return null;
					}
					const rect = container.getBoundingClientRect();
					if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
						return null;
					}
					const px = clientX - rect.left;
					const py = clientY - rect.top;
					if (getCyInstance() && container === cyContainer) {
						const pan = getCyInstance().pan();
						const zoom = getCyInstance().zoom() || 1;
						return { x: (px - pan.x) / zoom, y: (py - pan.y) / zoom };
					}
					return { x: container.scrollLeft + px, y: container.scrollTop + py };
				};
				const overInteractive = (target) =>
					!!(
						target &&
						target.closest &&
						target.closest(
							'.record-card, .record-card-pending, .record-related-chip, ' +
								'.bulk-empty-placeholder, ' +
								'.bulk-toast, .modal',
						)
					);

				document.addEventListener('contextmenu', (ev) => {
					const worldPos = worldFromClient(ev.clientX, ev.clientY);
					if (!worldPos) {
						return;
					} // outside canvas: let browser default fire
					if (!canEditCanvasStructure()) {
						return;
					}
					if (overInteractive(ev.target)) {
						return;
					}
					if (getCyInstance()) {
						const cont = activeContainer();
						if (cont) {
							const rect = cont.getBoundingClientRect();
							const px = ev.clientX - rect.left;
							const py = ev.clientY - rect.top;
							const nodes = getCyInstance().nodes();
							for (let i = 0; i < nodes.length; i++) {
								const bb = nodes[i].renderedBoundingBox();
								if (px >= bb.x1 && px <= bb.x2 && py >= bb.y1 && py <= bb.y2) {
									return;
								}
							}
						}
					}
					ev.preventDefault();
					_showCanvasContextMenu(ev.clientX, ev.clientY, worldPos);
				});

				document.addEventListener('keydown', (ev) => {
					const isInputTarget =
						ev.target &&
						(/^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName) || ev.target.isContentEditable);
					if (isInputTarget) {
						return;
					}
					if (ev.key === ' ' || ev.code === 'Space') {
						if (getCanvasSpaceHeld()) {
							return;
						}
						setCanvasSpaceHeld(true);
						getGraph().classList.add('canvas-pan-mode');
						ev.preventDefault(); // suppress page-down scroll
						return;
					}
					if (ev.key === 'z' || ev.key === 'Z') {
						if (ev.ctrlKey || ev.metaKey) {
							return;
						} // leave Ctrl/Cmd+Z (undo) alone
						setCanvasZHeld(true);
						return;
					}
				});
				document.addEventListener('keyup', (ev) => {
					if (ev.key === ' ' || ev.code === 'Space') {
						if (!getCanvasSpaceHeld()) {
							return;
						}
						setCanvasSpaceHeld(false);
						getGraph().classList.remove('canvas-pan-mode');
						getGraph().classList.remove('canvas-pan-mode-active');
						return;
					}
					if (ev.key === 'z' || ev.key === 'Z') {
						setCanvasZHeld(false);
						return;
					}
				});
				document.addEventListener('mousedown', () => {
					if (getCanvasSpaceHeld()) {
						getGraph().classList.add('canvas-pan-mode-active');
					}
				});
				document.addEventListener('mouseup', () => {
					getGraph().classList.remove('canvas-pan-mode-active');
				});
			}

			function _showCanvasContextMenu(clientX, clientY, worldPos) {
				if (!canEditCanvasStructure()) {
					return false;
				}
				document.querySelectorAll('.canvas-context-menu').forEach((el) => el.remove());
				const menu = document.createElement('div');
				menu.className = 'canvas-context-menu';
				const width = 220;
				const estHeight = 96;
				const left = Math.min(clientX, window.innerWidth - width - 8);
				const top = Math.min(clientY, window.innerHeight - estHeight - 8);
				menu.style.left = Math.max(8, left) + 'px';
				menu.style.top = Math.max(8, top) + 'px';
				menu.innerHTML =
					'<button type="button" class="ccm-item" data-ccm-action="spawn">' +
					'<span class="ccm-label">Add record here</span>' +
					'<span class="ccm-sub">Drop a pending placeholder at the click point</span>' +
					'</button>' +
					(window.OrgLoom.platform?.recordRequests === false
						? ''
						: '<button type="button" class="ccm-item" data-ccm-action="request">' +
							'<span class="ccm-label">Request record here</span>' +
							'<span class="ccm-sub">Ask a teammate to create or choose a record</span>' +
							'</button>');
				document.body.appendChild(menu);
				const cleanup = () => {
					if (menu.parentNode) {
						menu.remove();
					}
					document.removeEventListener('mousedown', outside, true);
					document.removeEventListener('keydown', onEsc, true);
				};
				const outside = (ev) => {
					if (!menu.contains(ev.target)) {
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
				menu.addEventListener('click', (ev) => {
					const btn = ev.target.closest('[data-ccm-action]');
					if (!btn) {
						return;
					}
					const action = btn.dataset.ccmAction;
					cleanup();
					if (action === 'spawn' && canEditCanvasStructure()) {
						spawnPendingRecord(worldPos.x, worldPos.y);
					} else if (action === 'request' && canEditCanvasStructure()) {
						openStandaloneRecordRequestPicker(
							{
								getBoundingClientRect: () => ({
									left: clientX,
									right: clientX,
									top: clientY,
									bottom: clientY,
								}),
							},
							worldPos,
						);
					}
				});
				return true;
			}

			function showAddRecordsMenu(triggerEl) {
				if (!canEditCanvasStructure()) {
					return false;
				}
				document.querySelectorAll('.fill-menu-popup').forEach((el) => el.remove());
				const pop = document.createElement('div');
				pop.className = 'fill-menu-popup';
				const rect = triggerEl.getBoundingClientRect();
				const viewportW = window.innerWidth;
				const left = Math.min(rect.left, viewportW - 280);
				pop.style.left = Math.max(8, left) + 'px';
				pop.style.top = rect.bottom + 6 + 'px';
				pop.innerHTML =
					'<div class="fm-header">On the canvas</div>' +
					'<button type="button" data-add-menu="blank" title="Add an empty draft and choose its object type">Add a blank record</button>' +
					(window.OrgLoom.platform?.recordRequests === false
						? ''
						: '<button type="button" data-add-menu="request" title="Ask a teammate to create or choose a record">Request a record</button>') +
					'<div class="fm-header">From Salesforce</div>' +
					'<button type="button" data-add-menu="browse" title="Filter records by field values, see live counts, then load matches onto the canvas, no SOQL knowledge required">Browse records</button>' +
					'<button type="button" data-add-menu="soql" title="Write a SOQL SELECT to pull records (and their related children via subqueries) into the canvas">Import via SOQL query</button>' +
					'<div class="fm-header">From a file</div>' +
					'<button type="button" data-add-menu="csv" title="Upload one or more CSV files; multi-file imports can detect relationships between rows">Import from CSV</button>' +
					'<button type="button" data-add-menu="fixture" title="Import a previously-saved canvas (with records) from a JSON file">Import saved canvas (JSON)</button>';
				document.body.appendChild(pop);
				const cleanup = () => {
					if (pop.parentNode) {
						pop.remove();
					}
					document.removeEventListener('mousedown', outside, true);
					document.removeEventListener('keydown', onEsc, true);
				};
				pop.querySelectorAll('button[data-add-menu]').forEach((b) => {
					b.addEventListener('click', () => {
						const action = b.dataset.addMenu;
						cleanup();
						if (!canEditCanvasStructure()) {
							return;
						}
						if (action === 'blank') {
							spawnPendingRecord();
						} else if (action === 'request') {
							openStandaloneRecordRequestPicker(triggerEl);
						} else if (action === 'csv') {
							openLinkedCsvModal();
						} else if (action === 'soql') {
							openSoqlImportModal();
						} else if (action === 'browse') {
							openBrowseModal();
						} else if (action === 'fixture') {
							triggerTemplateFileInput({});
						}
					});
				});
				const outside = (ev) => {
					if (!pop.contains(ev.target) && ev.target !== triggerEl) {
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
				return true;
			}

			function showBulkOperationsMenu(triggerEl) {
				document.querySelectorAll('.fill-menu-popup').forEach((el) => el.remove());
				const pop = document.createElement('div');
				pop.className = 'fill-menu-popup';
				const rect = triggerEl.getBoundingClientRect();
				const viewportW = window.innerWidth;
				const left = Math.min(rect.left, viewportW - 280);
				pop.style.left = Math.max(8, left) + 'px';
				pop.style.top = rect.bottom + 6 + 'px';
				const selectedDraftIds = canvasState.bulkRecords
					.filter((r) => !r.loadedFromId && !r.isTypeNode && canvasState.bulkSelectedIds.has(r.id))
					.map((r) => r.id);
				const allDraftCount = canvasState.bulkRecords.filter((r) => !r.loadedFromId && !r.isTypeNode).length;
				const scopeToSelected = selectedDraftIds.length > 0;
				const scopedDraftCount = scopeToSelected ? selectedDraftIds.length : allDraftCount;
				const draftHint =
					scopedDraftCount === 0
						? scopeToSelected
							? ' (selection has no draft records)'
							: ' (no draft records yet)'
						: ' on ' +
							scopedDraftCount +
							(scopeToSelected ? ' selected' : '') +
							' draft record' +
							(scopedDraftCount === 1 ? '' : 's');
				const fillLabelSuffix = scopeToSelected ? ' (selected)' : '';
				const aiAccess = getAiGen().getAccessState();
				const aiPending = !aiAccess.ready;
				const aiLocked = aiAccess.ready && !aiAccess.allowed;
				const aiUnavailable = aiPending || aiLocked;
				const aiLockTitle = aiPending
					? 'Checking Generate with AI access'
					: aiAccess.reason === 'plan-insufficient'
						? 'Upgrade this workspace to Pro or Team to use Generate with AI'
						: 'Ask a workspace admin to grant you the Generate with AI permission';
				const aiItem = !getAiGen().isEnabled()
					? ''
					: aiUnavailable
						? '<span class="fill-menu-disabled-tip" tabindex="0" title="' +
							aiLockTitle +
							'" aria-label="' +
							aiLockTitle +
							'">' +
							'<button type="button" disabled aria-disabled="true"' +
							(aiPending ? ' aria-busy="true"' : '') +
							'><span aria-hidden="true">' +
							(aiLocked ? '\uD83D\uDD12' : '\u2728') +
							'</span> Generate with AI</button></span>'
						: '<button type="button" data-bulk-op="generate-ai" title="Describe what you want and let Claude draft records and relationships"><span aria-hidden="true">\u2728</span> Generate with AI</button>';
				const scriptCapabilityReady = isCapabilityReady();
				const canRunScripts = scriptCapabilityReady && _hasCap('run-script');
				let scriptItem;
				if (canRunScripts) {
					scriptItem =
						'<button type="button" data-bulk-op="script" title="Run a JavaScript snippet against records on the canvas (no Salesforce calls)">Run script</button>';
				} else {
					const lockTitle = !scriptCapabilityReady
						? 'Checking Run script access'
						: _isOnPaidPlan()
							? 'Ask a workspace admin to grant you the Run script permission'
							: 'Upgrade this workspace to Pro or Team to use Run script';
					scriptItem =
						'<span class="fill-menu-disabled-tip" tabindex="0" title="' +
						lockTitle +
						'" aria-label="' +
						lockTitle +
						'">' +
						'<button type="button" disabled aria-disabled="true"><span aria-hidden="true">\uD83D\uDD12</span> Run script</button>' +
						'</span>';
				}
				const _selectedReal = canvasState.bulkRecords.filter(
					(r) => !r.isTypeNode && !r.isPending && canvasState.bulkSelectedIds.has(r.id),
				);
				const differentObjects =
					_selectedReal.length === 2 && _selectedReal[0].objectName !== _selectedReal[1].objectName;
				const diffEnabled = _selectedReal.length === 2 && !differentObjects;
				const diffStateHint = diffEnabled
					? ''
					: differentObjects
						? '<span class="fm-hint">different object types</span>'
						: _selectedReal.length === 0
							? '<span class="fm-hint">select 2 records</span>'
							: _selectedReal.length === 1
								? '<span class="fm-hint">select 1 more record</span>'
								: '<span class="fm-hint">select only 2 (' + _selectedReal.length + ' selected)</span>';
				const diffTitle = diffEnabled
					? 'Compare the two selected records field-by-field'
					: 'Select two records of the same object type to compare.';
				const diffLabel = 'Diff records' + (diffStateHint ? ' ' + diffStateHint : '');
				const diffItem = diffEnabled
					? '<button type="button" data-bulk-op="diff" title="' + diffTitle + '">' + diffLabel + '</button>'
					: '<button type="button" data-bulk-op="diff" title="' +
						diffTitle +
						'" disabled aria-disabled="true">' +
						diffLabel +
						'</button>';
				const _searchableCount = canvasState.bulkRecords.filter(
					(r) => r && !r.isTypeNode && !r.isPending,
				).length;
				const searchEnabled = _searchableCount > 0;
				const searchTitle = searchEnabled
					? 'Search field values and record names across all cards on the canvas (Cmd/Ctrl+F)'
					: 'Add records to the canvas first';
				const searchItem = searchEnabled
					? '<button type="button" data-bulk-op="search" title="' +
						searchTitle +
						'">Search canvas <span class="fm-tag">Cmd/Ctrl+F</span></button>'
					: '<button type="button" data-bulk-op="search" title="' +
						searchTitle +
						'" disabled aria-disabled="true">Search canvas</button>';
				let dupesEnabled = false;
				const _dupesCountsByObject = new Map();
				for (const r of canvasState.bulkRecords) {
					if (!r || r.isTypeNode || r.isPending) {
						continue;
					}
					_dupesCountsByObject.set(r.objectName, (_dupesCountsByObject.get(r.objectName) || 0) + 1);
				}
				for (const n of _dupesCountsByObject.values()) {
					if (n >= 2) {
						dupesEnabled = true;
						break;
					}
				}
				const dupesTitle = dupesEnabled
					? 'Group same-object records that look like duplicates so you can keep one and remove the rest'
					: _searchableCount < 2
						? 'Add at least 2 records to the canvas to find duplicates'
						: 'Find duplicates compares records of the same object type; add a second record of an existing type to enable.';
				const dupesItem = dupesEnabled
					? '<button type="button" data-bulk-op="find-dupes" title="' +
						dupesTitle +
						'">Find duplicates</button>'
					: '<button type="button" data-bulk-op="find-dupes" title="' +
						dupesTitle +
						'" disabled aria-disabled="true">Find duplicates</button>';
				const autoFillCapabilityReady = isCapabilityReady();
				const _canAutoFill = autoFillCapabilityReady && _hasCap('auto-fill-records');
				const bulkEditCapabilityReady = isCapabilityReady();
				const _canBulkEdit = bulkEditCapabilityReady && _hasCap('bulk-edit-records');
				let _autoFillItem;
				if (_canAutoFill) {
					_autoFillItem =
						'<button type="button" data-bulk-op="auto-fill" title="Fill empty required fields, fill all empty fields, or clear all values; pick the mode + scope in the modal that opens.">Auto-fill</button>';
				} else {
					const autoFillLockTitle = !autoFillCapabilityReady
						? 'Checking Auto-fill access'
						: _isOnPaidPlan()
							? 'Ask a workspace admin to grant you the Auto-fill permission'
							: 'Upgrade this workspace to Pro or Team to use Auto-fill';
					_autoFillItem =
						'<span class="fill-menu-disabled-tip" tabindex="0" title="' +
						autoFillLockTitle +
						'" aria-label="' +
						autoFillLockTitle +
						'">' +
						'<button type="button" disabled aria-disabled="true"><span aria-hidden="true">🔒</span> Auto-fill</button>' +
						'</span>';
				}
				let _bulkEditItem;
				if (_canBulkEdit) {
					_bulkEditItem =
						'<button type="button" data-bulk-op="bulk-edit" title="Find &amp; replace or set a value across many records at once">Bulk edit</button>';
				} else {
					const bulkEditLockTitle = !bulkEditCapabilityReady
						? 'Checking Bulk edit access'
						: _isOnPaidPlan()
							? 'Ask a workspace admin to grant you the Bulk edit records permission'
							: 'Upgrade this workspace to Pro or Team to use Bulk edit';
					_bulkEditItem =
						'<span class="fill-menu-disabled-tip" tabindex="0" title="' +
						bulkEditLockTitle +
						'" aria-label="' +
						bulkEditLockTitle +
						'">' +
						'<button type="button" disabled aria-disabled="true"><span aria-hidden="true">🔒</span> Bulk edit</button>' +
						'</span>';
				}
				const _canBrowseForRefresh = _hasCap('browse-records');
				let _refreshItem = '';
				if (_canBrowseForRefresh) {
					const _allLoaded = canvasState.bulkRecords.filter(
						(r) => r && !r.isTypeNode && !r.isPending && !r.pendingDelete && r.loadedFromId,
					);
					const _selectedLoaded =
						canvasState.bulkSelectedIds && canvasState.bulkSelectedIds.size > 0
							? _allLoaded.filter((r) => canvasState.bulkSelectedIds.has(r.id))
							: _allLoaded;
					const _refreshCount = _selectedLoaded.length;
					const _hasSelection = canvasState.bulkSelectedIds && canvasState.bulkSelectedIds.size > 0;
					const _refreshSubtitle =
						_refreshCount === 0
							? _hasSelection
								? 'No loaded records in selection'
								: 'No loaded records on canvas'
							: _hasSelection
								? _refreshCount + ' selected'
								: _refreshCount + ' loaded';
					const _refreshEmptyTitle = _hasSelection
						? 'Your selection has no loaded records; clear the selection to refresh every loaded record on the canvas.'
						: 'No loaded records on the canvas to refresh.';
					_refreshItem =
						_refreshCount === 0
							? '<button type="button" data-bulk-op="refresh-sf" disabled aria-disabled="true" title="' +
								_refreshEmptyTitle +
								'">Refresh from Salesforce <span class="tag">' +
								_refreshSubtitle +
								'</span></button>'
							: '<button type="button" data-bulk-op="refresh-sf" title="Pull current Salesforce values for loaded records. Dirty cards prompt for confirmation before being clobbered.">Refresh from Salesforce <span class="tag">' +
								_refreshSubtitle +
								'</span></button>';
				}
				let deleteItem = '';
				if (canEditCanvasStructure() && deps.bulkDeleteCandidates && deps.openBulkDeleteFlow) {
					const count = (deps.bulkDeleteCandidates() || []).length;
					const selected = canvasState.bulkSelectedIds?.size > 0;
					const subtitle = count
						? count + (selected ? ' selected' : ' loaded')
						: selected
							? 'No eligible records in selection'
							: 'No eligible records on canvas';
					deleteItem =
						'<button type="button" data-bulk-op="mark-delete"' +
						(count ? '' : ' disabled aria-disabled="true"') +
						' title="Mark loaded Salesforce records for deletion on the next upload.">Mark for deletion <span class="tag">' +
						subtitle +
						'</span></button>';
				}
				const _migrateHasRecords = canvasState.bulkRecords.some((r) => !r.isTypeNode);
				const migration = window.OrgLoom.platform?.migration || {};
				const migrationLabel = escapeHtml(migration.label || 'Migrate to another org…');
				const migrationDescription = escapeHtml(
					migration.description ||
						'Recreate these records in a different Salesforce org. Your canvas is saved first so the switch is safe.',
				);
				const _migrateItem = _migrateHasRecords
					? '<button type="button" data-bulk-op="migrate-org" title="' +
						migrationDescription +
						'">' +
						migrationLabel +
						'</button>'
					: '<button type="button" data-bulk-op="migrate-org" disabled aria-disabled="true" title="Add or load records before migrating to another org.">' +
						migrationLabel +
						'</button>';
				pop.innerHTML =
					(aiItem ? '<div class="fm-header">Create</div>' + aiItem : '') +
					'<div class="fm-header">Modify records</div>' +
					_autoFillItem +
					_bulkEditItem +
					scriptItem +
					'<div class="fm-header">Find</div>' +
					searchItem +
					dupesItem +
					'<div class="fm-header">Compare</div>' +
					diffItem +
					'<div class="fm-header">Salesforce</div>' +
					_refreshItem +
					deleteItem +
					_migrateItem;
				document.body.appendChild(pop);
				const cleanup = () => {
					if (pop.parentNode) {
						pop.remove();
					}
					document.removeEventListener('mousedown', outside, true);
					document.removeEventListener('keydown', onEsc, true);
				};
				pop.querySelectorAll('button[data-bulk-op]').forEach((b) => {
					b.addEventListener('click', () => {
						const op = b.dataset.bulkOp;
						cleanup();
						const liveSelectedIds = canvasState.bulkRecords
							.filter((r) => !r.loadedFromId && !r.isTypeNode && canvasState.bulkSelectedIds.has(r.id))
							.map((r) => r.id);
						const scopeOpts = liveSelectedIds.length > 0 ? { tempIds: liveSelectedIds } : undefined;
						if (op === 'generate-ai') {
							openAiGenModal();
						} else if (op === 'auto-fill') {
							_openAutoFillModal();
						} else if (op === 'bulk-edit') {
							openBulkEditModal();
						} else if (op === 'script') {
							openBulkScriptModal();
						} else if (op === 'search') {
							openCanvasSearchModal();
						} else if (op === 'find-dupes') {
							openFindDuplicatesModal();
						} else if (op === 'refresh-sf') {
							openBulkRefreshFlow();
						} else if (op === 'mark-delete') {
							deps.openBulkDeleteFlow();
						} else if (op === 'migrate-org') {
							beginMigration();
						} else if (op === 'diff') {
							const pair = canvasState.bulkRecords.filter(
								(r) => !r.isTypeNode && !r.isPending && canvasState.bulkSelectedIds.has(r.id),
							);
							if (pair.length === 2) {
								openRecordDiffModal(pair[0], pair[1]);
							}
						}
					});
				});
				const outside = (ev) => {
					if (!pop.contains(ev.target) && ev.target !== triggerEl) {
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

			function showBulkHelpPopover(triggerEl) {
				document.querySelectorAll('.bulk-help-popup').forEach((el) => el.remove());
				const pop = document.createElement('div');
				pop.className = 'bulk-help-popup';
				const rect = triggerEl.getBoundingClientRect();
				const viewportW = window.innerWidth;
				const viewportH = window.innerHeight;
				const width = 320;
				const left = Math.min(rect.right - width, viewportW - width - 8);
				pop.style.left = Math.max(8, left) + 'px';
				const estimatedHeight = 280;
				const wouldOverflowBelow = rect.bottom + 6 + estimatedHeight > viewportH - 8;
				if (wouldOverflowBelow) {
					pop.style.bottom = viewportH - rect.top + 6 + 'px';
					pop.style.top = 'auto';
				} else {
					pop.style.top = rect.bottom + 6 + 'px';
				}
				pop.innerHTML =
					'<div class="bhp-header">Canvas shortcuts</div>' +
					'<ul>' +
					'<li><strong>Right-click</strong> on empty canvas to add a record at that point.</li>' +
					'<li><strong>Double-click</strong> a card to edit its fields.</li>' +
					'<li><strong>Drag</strong> a card to move it. Select several to move as a group.</li>' +
					'<li><strong>Drag from a card\u2019s edge</strong> to another card to connect them.</li>' +
					'<li><strong>Click an edge</strong>, then \u00D7 on its badge to disconnect.</li>' +
					'<li><strong>Ctrl/Cmd+Z</strong> to undo the last canvas operation.</li>' +
					'</ul>';
				document.body.appendChild(pop);
				const cleanup = () => {
					if (pop.parentNode) {
						pop.remove();
					}
					document.removeEventListener('mousedown', outside, true);
					document.removeEventListener('keydown', onEsc, true);
				};
				const outside = (ev) => {
					if (!pop.contains(ev.target) && ev.target !== triggerEl) {
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

			window.Orgloom = window.Orgloom || {};
			window.Orgloom.canvasHelp = {
				openShortcuts: (anchorEl) => {
					if (anchorEl) {
						return showBulkHelpPopover(anchorEl);
					}
					const hint = document.getElementById('canvas-shortcut-hint');
					if (hint) {
						return showBulkHelpPopover(hint);
					}
					const synthetic = {
						getBoundingClientRect: () => {
							const w = 320;
							const x = (window.innerWidth - w) / 2;
							return { right: x + w, bottom: 80, left: x, top: 60, width: w, height: 20 };
						},
					};
					return showBulkHelpPopover(synthetic);
				},
			};

			function _openAutoFillModal() {
				// Freeze the scope when the modal opens so scope counts match the eventual action.
				const _realFilter = (r) => !r.isTypeNode && !r.isPending;
				const allRealRecords = canvasState.bulkRecords.filter(_realFilter);
				const allDrafts = allRealRecords.filter((r) => !r.loadedFromId);
				const allExisting = allRealRecords.filter((r) => r.loadedFromId);
				const allSelected = allRealRecords.filter((r) => canvasState.bulkSelectedIds.has(r.id));

				document.querySelectorAll('.auto-fill-modal').forEach((el) => el.remove());

				const overlay = document.createElement('div');
				overlay.className = 'modal auto-fill-modal';
				const scopeDraftCount = allDrafts.length;
				const scopeExistingCount = allExisting.length;
				const scopeSelCount = allSelected.length;
				const initialScope =
					scopeSelCount > 0
						? 'selected'
						: scopeDraftCount > 0
							? 'drafts'
							: scopeExistingCount > 0
								? 'existing'
								: null;
				const initialMode = 'all';

				function recordsForScope(scope) {
					if (scope === 'drafts') {
						return allDrafts;
					}
					if (scope === 'existing') {
						return allExisting;
					}
					if (scope === 'selected') {
						return allSelected;
					}
					return [];
				}
				function includeLoadedForScope(scope) {
					return recordsForScope(scope).some((record) => !!record.loadedFromId);
				}

				overlay.innerHTML =
					'<div class="modal-overlay" data-af-cancel></div>' +
					'<div class="modal-body" role="dialog" aria-modal="true" aria-labelledby="af-title" style="max-width:460px">' +
					'<div class="modal-header">' +
					'<h3 id="af-title">Fill or clear fields</h3>' +
					'<button class="modal-close" data-af-cancel aria-label="Close">&times;</button>' +
					'</div>' +
					'<div class="modal-content">' +
					'<div class="af-action-group">' +
					'<label class="af-label" for="af-action">Action</label>' +
					'<select id="af-action" class="af-select">' +
					'<option value="all" selected>Fill all empty fields</option>' +
					'<option value="required">Fill empty required fields</option>' +
					'<option value="clear">Clear fields</option>' +
					'</select>' +
					'</div>' +
					'<div class="af-scope">' +
					'<label class="af-label" for="af-scope">Apply to</label>' +
					'<select id="af-scope" class="af-select"' +
					(initialScope ? '' : ' disabled') +
					'>' +
					(initialScope ? '' : '<option value="">No records available</option>') +
					[
						['selected', 'Selected records', scopeSelCount],
						['drafts', 'All drafts', scopeDraftCount],
						['existing', 'All existing records', scopeExistingCount],
					]
						.map(
							([value, label, count]) =>
								'<option value="' +
								value +
								'"' +
								(initialScope === value ? ' selected' : '') +
								(count === 0 ? ' disabled' : '') +
								'>' +
								label +
								' (' +
								count +
								')</option>',
						)
						.join('') +
					'</select>' +
					'</div>' +
					'</div>' +
					'<div class="modal-footer">' +
					'<button class="button secondary" data-af-cancel>Cancel</button>' +
					'<button class="button" data-af-run>Fill empty fields</button>' +
					'</div>' +
					'</div>';
				document.body.appendChild(overlay);

				let _mode = initialMode;
				let _scope = initialScope;
				const runBtn = overlay.querySelector('[data-af-run]');
				const previousFocus = document.activeElement;
				function refreshControls() {
					runBtn.textContent =
						_mode === 'required'
							? 'Fill required fields'
							: _mode === 'all'
								? 'Fill empty fields'
								: 'Clear field values';
					runBtn.classList.toggle('danger', _mode === 'clear');
					runBtn.disabled = recordsForScope(_scope).length === 0;
				}

				function cleanup() {
					overlay.remove();
					document.removeEventListener('keydown', onKey, true);
					if (previousFocus && previousFocus.isConnected) previousFocus.focus();
				}
				function onKey(e) {
					if (e.key === 'Escape') {
						cleanup();
					}
				}
				document.addEventListener('keydown', onKey, true);

				overlay.querySelectorAll('[data-af-cancel]').forEach((el) => {
					el.addEventListener('click', cleanup);
				});

				const scopeSelect = overlay.querySelector('#af-scope');
				scopeSelect.addEventListener('change', () => {
					_scope = scopeSelect.value;
					refreshControls();
				});
				const actionSelect = overlay.querySelector('#af-action');
				actionSelect.addEventListener('change', () => {
					_mode = actionSelect.value;
					refreshControls();
				});

				function run() {
					const records = recordsForScope(_scope);
					if (records.length === 0) {
						return;
					}
					const includeLoaded = includeLoadedForScope(_scope);
					const scopeOpts = {
						tempIds: records.map((r) => r.id),
						includeLoaded: includeLoaded,
						selectionScope: _scope === 'selected',
					};
					cleanup();
					if (_mode === 'required') {
						bulkAutoFill('required', 'both', { ...scopeOpts, skipConfirm: true });
					} else if (_mode === 'all') {
						bulkAutoFill('all', 'both', { ...scopeOpts, skipConfirm: true });
					} else if (_mode === 'clear') {
						bulkClearAllFields({ ...scopeOpts, skipConfirm: !includeLoaded });
					}
				}
				overlay.querySelector('[data-af-run]').addEventListener('click', run);
				refreshControls();
				actionSelect.focus();
			}

			return {
				_wireCanvasFloatingAdd: _wireCanvasFloatingAdd,
				_showCanvasContextMenu: _showCanvasContextMenu,
				showAddRecordsMenu: showAddRecordsMenu,
				showBulkOperationsMenu: showBulkOperationsMenu,
				showBulkHelpPopover: showBulkHelpPopover,
			};
		},
	};
})();

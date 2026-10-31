(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.sharedTaskSidebar = {
		mount: function mount(deps) {
			if (
				!deps ||
				!deps.canvasState ||
				!deps.escapeHtml ||
				!deps.getCanvasShareRole ||
				!deps.getCyInstance ||
				!deps.openInsertModal ||
				!deps.slotAssignmentState ||
				!deps.slotProgress
			) {
				throw new Error('shared-task-sidebar.mount: missing required deps');
			}

			const canvasState = deps.canvasState;
			const escapeHtml = deps.escapeHtml;
			const getCanvasShareRole = deps.getCanvasShareRole;
			const getCyInstance = deps.getCyInstance;
			const openInsertModal = deps.openInsertModal;
			const slotAssignmentState = deps.slotAssignmentState;
			const slotProgress = deps.slotProgress;
			const slotPreflightWarn =
				deps.slotPreflightWarn ||
				function () {
					return false;
				};
			let renderedCanvasId = null;
			let previousAllComplete = false;
			let collapsed = false;

			function isEmpty(value) {
				return value == null || value === '';
			}

			function recordTitle(record) {
				if (!record || record._inaccessible) {
					return 'Unavailable record';
				}
				const values = record.values || {};
				const personName = ((values.FirstName || '') + ' ' + (values.LastName || '')).trim();
				const value =
					personName ||
					values.Name ||
					values.Subject ||
					values.Title ||
					values.CaseNumber ||
					values.OrderNumber ||
					values.WorkOrderNumber;
				return value ? String(value) : record.label || record.objectName || 'Record';
			}

			function taskForRecord(record, isOwner, role) {
				if (!record || record.isTypeNode || record.isPending || !record.slot || record.slot.slotId == null) {
					return null;
				}
				const assignment = slotAssignmentState(record);
				if (!isOwner && (!record._recipientSlot || assignment === 'other')) {
					return null;
				}

				const kind = record.slot.kind || 'whole-record';
				const progress = slotProgress(record) || { filled: 0, total: kind === 'fields' ? 0 : 1 };
				const unavailableFieldCount =
					kind === 'fields' && Number.isSafeInteger(Number(record.slot.unavailableFieldCount))
						? Math.max(0, Number(record.slot.unavailableFieldCount))
						: 0;
				const complete = unavailableFieldCount === 0 && progress.total > 0 && progress.filled >= progress.total;
				const inaccessible = !!record._inaccessible;
				const permissionBlocked = !inaccessible && !!slotPreflightWarn(record);
				const noAvailableFields = kind === 'fields' && progress.total === 0;
				const viewerBlocked = !isOwner && role === 'viewer';
				const fields = kind === 'fields' && Array.isArray(record.slot.fields) ? record.slot.fields : [];
				const firstIncompleteField =
					fields.find((name) => isEmpty((record.values || {})[name])) || fields[0] || null;
				const objectLabel = inaccessible ? 'record' : record.label || record.objectName || 'record';
				const kindLabel = inaccessible ? 'Request' : kind === 'fields' ? 'Fill in fields' : 'Add a record';
				const title = inaccessible ? 'Unavailable' : kind === 'fields' ? recordTitle(record) : objectLabel;
				const instructions =
					!inaccessible && record.slot.description ? String(record.slot.description).trim() : '';

				let status;
				if (inaccessible) {
					status = 'Blocked by Salesforce permissions';
				} else if (permissionBlocked) {
					status = 'Cannot complete with current Salesforce permissions';
				} else if (noAvailableFields) {
					status =
						'No requested fields are available' +
						(unavailableFieldCount > 0 ? ' (' + unavailableFieldCount + ' unavailable)' : '');
				} else if (viewerBlocked && !complete) {
					status = 'Contributor access required';
				} else if (complete) {
					status = 'Complete';
				} else if (kind === 'fields') {
					status =
						progress.filled +
						' of ' +
						progress.total +
						(unavailableFieldCount > 0
							? ' available fields complete · ' + unavailableFieldCount + ' unavailable'
							: ' fields complete');
				} else {
					status = 'Not started';
				}

				return {
					recordId: record.id,
					slotId: String(record.slot.slotId),
					kind,
					createdAt: Number.isFinite(Number(record.slot.createdAt)) ? Number(record.slot.createdAt) : 0,
					kindLabel,
					title,
					status,
					instructions,
					complete,
					blocked: inaccessible || permissionBlocked || noAvailableFields || viewerBlocked,
					inaccessible,
					permissionBlocked,
					firstIncompleteField,
					assignee:
						isOwner && record.slot.assigneeSfUserId
							? record.slot.assigneeName || record.slot.assigneeEmail || 'Assigned teammate'
							: '',
				};
			}

			function buildTasks() {
				const current = canvasState.currentCanvas;
				if (!current || !current.id) {
					return [];
				}
				const isOwner = !!current.ownedByMe;
				const role = getCanvasShareRole();
				if (!isOwner && !role) {
					return [];
				}
				return canvasState.bulkRecords
					.map((record) => taskForRecord(record, isOwner, role))
					.filter(Boolean)
					.sort((left, right) => {
						const kindOrder = (task) => (task.kind === 'fields' ? 1 : 0);
						const byKind = kindOrder(left) - kindOrder(right);
						if (byKind !== 0) {
							return byKind;
						}
						const byCreatedAt = left.createdAt - right.createdAt;
						if (byCreatedAt !== 0) {
							return byCreatedAt;
						}
						const byTitle = left.title.toLocaleLowerCase().localeCompare(right.title.toLocaleLowerCase());
						return byTitle !== 0 ? byTitle : left.slotId.localeCompare(right.slotId);
					});
			}

			function focusRecord(record) {
				const cy = getCyInstance();
				if (!cy || !record) {
					return;
				}
				const node = cy.$id('r' + record.id);
				if (!node || node.length === 0) {
					return;
				}
				node.addClass('csr-flash');
				try {
					cy.animate({ center: { eles: node }, duration: 240, easing: 'ease-out' });
				} catch (_) {
					cy.center(node);
				}
				setTimeout(() => {
					if (node && !node.removed()) {
						node.removeClass('csr-flash');
					}
				}, 1400);
			}

			function openTask(task) {
				const record = canvasState.bulkRecords.find(
					(candidate) => String(candidate.id) === String(task.recordId),
				);
				if (!record) {
					return;
				}
				focusRecord(record);
				if (task.inaccessible) {
					return;
				}
				if (task.kind === 'fields' || task.complete) {
					openInsertModal(record.objectName, {
						record,
						focusField: task.kind === 'fields' ? task.firstIncompleteField : null,
					});
				}
			}

			function taskHtml(task) {
				const stateClass = task.complete
					? ' shared-task--complete'
					: task.blocked
						? ' shared-task--blocked'
						: '';
				const kindClass = task.kind === 'fields' ? ' shared-task--fields' : ' shared-task--record';
				const icon = task.complete
					? '&#10003;'
					: task.inaccessible
						? '&#128274;'
						: task.kind === 'fields'
							? '&#9998;'
							: '&#43;';
				return (
					'<li class="shared-task' +
					stateClass +
					kindClass +
					'">' +
					'<button type="button" class="shared-task-button" data-shared-task-record="' +
					escapeHtml(String(task.recordId)) +
					'">' +
					'<span class="shared-task-icon" aria-hidden="true">' +
					icon +
					'</span>' +
					'<span class="shared-task-copy">' +
					'<strong>' +
					escapeHtml(task.title) +
					'</strong>' +
					'<span class="shared-task-status">' +
					escapeHtml(task.status) +
					'</span>' +
					(task.instructions
						? '<small class="shared-task-instructions">' + escapeHtml(task.instructions) + '</small>'
						: '') +
					(task.assignee ? '<small>Assigned to ' + escapeHtml(task.assignee) + '</small>' : '') +
					'</span>' +
					'</button>' +
					'</li>'
				);
			}

			function render() {
				const host = document.getElementById('shared-task-sidebar');
				if (!host) {
					return false;
				}
				const currentSections = host.querySelector('.shared-task-sections');
				const previousScrollTop = currentSections ? currentSections.scrollTop : 0;
				const tasks = buildTasks();
				if (tasks.length === 0) {
					host.hidden = true;
					host.innerHTML = '';
					renderedCanvasId = null;
					previousAllComplete = false;
					collapsed = false;
					return false;
				}

				const current = canvasState.currentCanvas;
				const isOwner = !!(current && current.ownedByMe);
				const completeCount = tasks.filter((task) => task.complete).length;
				const allComplete = completeCount === tasks.length;
				const canvasId = current && current.id ? String(current.id) : '';
				if (canvasId !== renderedCanvasId) {
					collapsed = allComplete;
				} else if (allComplete !== previousAllComplete) {
					// Completion gets out of the way automatically; a newly added or
					// reopened task becomes visible without another click.
					collapsed = allComplete;
				}
				renderedCanvasId = canvasId;
				previousAllComplete = allComplete;
				const sections = [
					{ kind: 'whole-record', label: 'Add records' },
					{ kind: 'fields', label: 'Fill in fields' },
				]
					.map((section) => {
						const sectionTasks = tasks.filter((task) =>
							section.kind === 'whole-record' ? task.kind !== 'fields' : task.kind === 'fields',
						);
						if (sectionTasks.length === 0) {
							return '';
						}
						const remaining = sectionTasks.filter((task) => !task.complete).length;
						return (
							'<section class="shared-task-section shared-task-section--' +
							(section.kind === 'fields' ? 'fields' : 'records') +
							'">' +
							'<div class="shared-task-section-header"><h4>' +
							escapeHtml(section.label) +
							'</h4><span>' +
							remaining +
							' remaining</span></div>' +
							'<ol class="shared-task-list">' +
							sectionTasks.map(taskHtml).join('') +
							'</ol></section>'
						);
					})
					.join('');
				host.hidden = false;
				host.classList.toggle('shared-task-sidebar--collapsed', collapsed);
				host.innerHTML =
					'<div class="shared-task-header">' +
					'<div><h3>' +
					(isOwner ? 'Requests' : 'Your tasks') +
					'</h3><p>' +
					(allComplete
						? 'All ' + tasks.length + ' complete'
						: completeCount + ' of ' + tasks.length + ' complete') +
					'</p></div>' +
					'<button type="button" class="shared-task-toggle" data-shared-task-toggle aria-expanded="' +
					String(!collapsed) +
					'" aria-controls="shared-task-sections">' +
					'<span aria-hidden="true">' +
					(collapsed ? '&#9656;' : '&#9662;') +
					'</span><span>' +
					(collapsed ? 'Show' : 'Hide') +
					'</span></button></div>' +
					'<div class="shared-task-sections" id="shared-task-sections"' +
					(collapsed ? ' hidden' : '') +
					'>' +
					sections +
					'</div>';
				const nextSections = host.querySelector('.shared-task-sections');
				if (nextSections && previousScrollTop > 0) {
					nextSections.scrollTop = previousScrollTop;
				}

				if (!host.dataset.wired) {
					host.dataset.wired = '1';
					host.addEventListener('click', (event) => {
						const toggle = event.target.closest('[data-shared-task-toggle]');
						if (toggle) {
							collapsed = !collapsed;
							render();
							return;
						}
						const trigger = event.target.closest('[data-shared-task-record]');
						if (!trigger) {
							return;
						}
						const task = buildTasks().find(
							(candidate) => String(candidate.recordId) === String(trigger.dataset.sharedTaskRecord),
						);
						if (task) {
							openTask(task);
						}
					});
				}
				return true;
			}

			return {
				render,
				buildTasks,
				openTask,
			};
		},
	};
})();

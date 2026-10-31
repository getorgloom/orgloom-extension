(function () {
	'use strict';
	window.OrgLoom = window.OrgLoom || {};
	window.OrgLoom.uploadFixesSidebar = {
		mount(deps) {
			const { canvasState, escapeHtml, getContext, validateLocal, openRecord, recordTitle } = deps;
			let tasks = [];
			let pending = null;
			let context = null;
			let scopeIds = new Set();
			let active = false;
			let collapsed = false;
			let sequence = 0;
			const recordFor = (id) => canvasState.bulkRecords.find((record) => String(record.id) === String(id));
			const fieldsFor = (issue) =>
				(issue.fields || [issue.field]).filter((field) => field && /^[A-Za-z]/.test(field));
			const keyFor = (issue, source) =>
				JSON.stringify([
					source,
					issue.operation || '',
					String(issue.recordId),
					issue.field || '',
					fieldsFor(issue),
					issue.errorCode || '',
					issue.message,
				]);
			function fingerprint(record, fields) {
				if (!record) {
					return null;
				}
				const values = record.values || {};
				return JSON.stringify({
					values: fields.length ? fields.map((field) => [field, values[field]]) : values,
					pendingDelete: !!record.pendingDelete,
					links: (canvasState.bulkAssociations || [])
						.filter(
							(link) =>
								String(link.fromId) === String(record.id) &&
								(!fields.length || fields.includes(link.fieldName)),
						)
						.map((link) => [link.fieldName, link.toId]),
				});
			}
			function clear() {
				tasks = [];
				pending = null;
				context = null;
				scopeIds = new Set();
				active = false;
				collapsed = false;
				const host = document.getElementById('upload-fixes-sidebar');
				if (host) {
					host.hidden = true;
					host.innerHTML = '';
				}
			}
			function validContext() {
				if (!context) {
					return true;
				}
				const next = getContext();
				// Saving an unsaved canvas doesn't switch its contents or discard its fix list.
				if (context.connection !== next.connection || (context.canvas && context.canvas !== next.canvas)) {
					clear();
					return false;
				}
				context = next;
				return true;
			}
			function merge(issues, source) {
				for (const issue of issues) {
					const key = keyFor(issue, source);
					let task = tasks.find((item) => item.key === key);
					const record = recordFor(issue.recordId);
					if (!task) {
						task = { ...issue, key, source, id: String(++sequence), fields: fieldsFor(issue) };
						tasks.push(task);
					}
					task.baseline = fingerprint(record, task.fields);
					task.confirmed = false;
					task.confirmedDelete = false;
				}
			}
			function present(issues, source, ids) {
				validContext();
				context = getContext();
				pending = { issues, source, ids: new Set(ids) };
				if (active) {
					for (const id of ids) {
						scopeIds.add(id);
					}
					merge(issues, source);
				}
			}
			function refresh() {
				if (!validContext() || !active) {
					return [];
				}
				let check;
				try {
					check = validateLocal(scopeIds);
				} catch (_) {
					check = null;
				}
				return tasks.map((task) => {
					const record = recordFor(task.recordId);
					const blocked = !record || record._inaccessible || check?.accessExcludedIds?.has(record.id);
					let complete = false;
					let changed = false;
					let status = 'Needs attention';
					if (task.confirmedDelete && !record) {
						complete = true;
						status = 'Check passed';
					} else if (!record) {
						status = 'Record removed from canvas';
					} else if (blocked) {
						status = 'Blocked by Salesforce permissions';
					} else if (task.source === 'local') {
						const metadataMissing =
							!check || check.blocked || check.missingDescribes?.has(record.objectName);
						const remains = check?.issues.some(
							(issue) =>
								keyFor(issue, 'local') === task.key ||
								(String(issue.recordId) === String(task.recordId) &&
									(issue.field || '') === (task.field || '')),
						);
						complete = !metadataMissing && !remains;
						status = complete
							? 'Check passed'
							: metadataMissing
								? 'Unable to verify yet'
								: 'Needs attention';
					} else {
						const current = fingerprint(record, task.fields);
						complete = task.confirmed && current === task.verified;
						changed = !complete && current !== task.baseline;
						status = complete ? 'Check passed' : changed ? 'Changed' : 'Needs attention';
					}
					return {
						...task,
						complete,
						changed,
						status,
						blocked,
						title: blocked ? 'Unavailable record' : recordTitle(record),
					};
				});
			}
			function openTask(id) {
				const list = refresh();
				const task = list.find((item) => item.id === String(id));
				if (!task || task.blocked) {
					return false;
				}
				const uploadFixFields = Array.from(
					new Set(
						list
							.filter(
								(item) =>
									String(item.recordId) === String(task.recordId) && !item.complete && !item.blocked,
							)
							.flatMap((item) => item.fields),
					),
				);
				return openRecord(recordFor(task.recordId), {
					focusField: task.fields[0] || undefined,
					uploadFixFields,
				});
			}
			function dismissTask(id) {
				if (!validContext() || !active) return false;
				const task = tasks.find((item) => item.id === String(id));
				if (!task) return false;
				tasks = tasks.filter((item) => item !== task);
				const fields = Array.from(
					new Set(
						refresh()
							.filter(
								(item) =>
									String(item.recordId) === String(task.recordId) && !item.complete && !item.blocked,
							)
							.flatMap((item) => item.fields),
					),
				);
				deps.onDismiss?.(task.recordId, fields);
				if (!tasks.length) clear();
				render();
				deps.onChange?.();
				return true;
			}
			function start(recordId, fieldName) {
				if (!validContext() || !pending) {
					return false;
				}
				if (!active) {
					scopeIds = new Set(pending.ids);
					merge(pending.issues, pending.source);
				}
				active = true;
				collapsed = false;
				deps.onChange?.();
				render();
				const task =
					tasks.find(
						(item) =>
							String(item.recordId) === String(recordId) &&
							(!fieldName || item.fields.includes(fieldName)),
					) || tasks.find((item) => String(item.recordId) === String(recordId));
				return task ? openTask(task.id) : false;
			}
			function recordResults(results, deletes) {
				if (!validContext() || !active) {
					return;
				}
				for (const task of tasks) {
					const deletion = (deletes || []).find((item) => String(item.tempId) === String(task.recordId));
					const result = (results || []).find((item) => String(item.tempId) === String(task.recordId));
					const deleted = deletion?.success === true;
					const failed =
						deletion?.success === false || (task.operation !== 'delete' && result?.success === false);
					if (failed) {
						task.confirmed = false;
						task.confirmedDelete = false;
						task.baseline = fingerprint(recordFor(task.recordId), task.fields);
					} else if (
						deleted ||
						(task.operation !== 'delete' && result?.success === true && result.mode !== 'unchanged')
					) {
						// A successful write cannot verify a failed DELETE, even on the same record.
						// Reconciliation preserves edits made while the upload was running. Those
						// newer values have not been verified by this successful response.
						const record = recordFor(task.recordId);
						task.confirmed = deleted || (!!record && !deps.hasUnsubmittedChanges?.(record));
						task.confirmedDelete = deleted;
						task.verified = fingerprint(recordFor(task.recordId), task.fields);
					}
				}
			}
			function render() {
				const host = document.getElementById('upload-fixes-sidebar');
				if (!host) {
					return false;
				}
				const list = refresh();
				if (!active || !list.length) {
					host.hidden = true;
					return false;
				}
				const remaining = list.filter((task) => !task.complete).length;
				const oldScroll = host.querySelector('.shared-task-sections')?.scrollTop || 0;
				const html =
					'<div class="shared-task-header"><div><h3>Upload fixes</h3><p>' +
					remaining +
					(remaining === 1 ? ' issue remaining' : ' issues remaining') +
					'</p></div>' +
					'<button type="button" class="shared-task-toggle" data-upload-fixes-toggle aria-expanded="' +
					!collapsed +
					'" aria-controls="upload-fixes-list">' +
					(collapsed ? 'Show' : 'Hide') +
					'</button>' +
					'<button type="button" class="shared-task-toggle" data-upload-fixes-dismiss aria-label="Dismiss upload fixes">×</button></div>' +
					'<div class="shared-task-sections" id="upload-fixes-list"' +
					(collapsed ? ' hidden' : '') +
					'><ol class="shared-task-list">' +
					list
						.map(
							(task) =>
								'<li class="' +
								(task.complete ? 'shared-task--complete' : task.changed ? 'upload-fix--changed' : '') +
								'"><button type="button" class="shared-task-button" data-upload-fix-task="' +
								task.id +
								'"' +
								(task.blocked ? ' disabled' : '') +
								'>' +
								'<span class="shared-task-icon" ' +
								(task.changed
									? 'role="img" aria-label="Edited, not yet verified" title="Edited, not yet verified"'
									: 'aria-hidden="true"') +
								'>' +
								(task.complete
									? '✓'
									: task.changed
										? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 3 5 5-13 13H3v-5Z"/><path d="m14 5 5 5"/></svg>'
										: '!') +
								'</span><span class="shared-task-copy"><strong>' +
								escapeHtml(task.title) +
								'</strong>' +
								(!task.blocked && task.fields.length
									? '<small>' + escapeHtml(task.fieldLabel || task.fields.join(', ')) + '</small>'
									: '') +
								(!task.blocked
									? '<span>' + escapeHtml(task.message || 'Review this record.') + '</span>'
									: '') +
								(task.changed
									? ''
									: '<small class="shared-task-status">' + escapeHtml(task.status) + '</small>') +
								'</span></button><button type="button" class="shared-task-toggle upload-fix-dismiss" data-upload-fix-dismiss="' +
								task.id +
								'" title="Dismiss this fix" aria-label="' +
								escapeHtml(
									'Dismiss fix for ' +
										task.title +
										(!task.blocked && task.fields.length
											? ': ' + (task.fieldLabel || task.fields.join(', '))
											: ''),
								) +
								'">×</button></li>',
						)
						.join('') +
					'</ol></div>';
				host.hidden = false;
				if (host.innerHTML !== html) {
					host.innerHTML = html;
					const sections = host.querySelector('.shared-task-sections');
					if (sections) {
						sections.scrollTop = oldScroll;
					}
				}
				if (!host.dataset.wired) {
					host.dataset.wired = '1';
					host.addEventListener('click', (event) => {
						const dismiss = event.target.closest('[data-upload-fix-dismiss]');
						if (dismiss) {
							dismissTask(dismiss.dataset.uploadFixDismiss);
							return;
						}
						if (event.target.closest('[data-upload-fixes-dismiss]')) {
							clear();
							deps.onChange?.();
							return;
						}
						if (event.target.closest('[data-upload-fixes-toggle]')) {
							collapsed = !collapsed;
							render();
							return;
						}
						const button = event.target.closest('[data-upload-fix-task]');
						if (button) {
							openTask(button.dataset.uploadFixTask);
						}
					});
				}
				return true;
			}
			return { present, start, render, refresh, recordResults, clear, openTask, dismissTask };
		},
	};
})();

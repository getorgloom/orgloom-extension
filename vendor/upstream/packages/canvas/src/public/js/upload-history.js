(function () {
	'use strict';
	// Displays upload batches and recall options derived from the server-side operation ledger.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.uploadHistory = {
		mount: function mount(deps) {
			if (
				!deps ||
				!deps.csrfFetch ||
				!deps.escapeHtml ||
				!deps.showBulkToast ||
				!deps.hasCapability ||
				!deps.isCapabilityReady ||
				!deps.refreshCapabilities
			) {
				throw new Error('upload-history.mount: missing required deps');
			}
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			const showBulkToast = deps.showBulkToast;
			const hasCapability = deps.hasCapability;
			const isCapabilityReady = deps.isCapabilityReady;
			const refreshCapabilities = deps.refreshCapabilities;
			const refreshCanvasAfterRecall =
				typeof deps.refreshCanvasAfterRecall === 'function' ? deps.refreshCanvasAfterRecall : null;
			const recallPermissionTitle = 'Ask a workspace admin to grant you the Recall uploads permission';
			const uploadHistoryPageSize = 15;

			function recallCapabilityState() {
				if (deps.canUseHistory?.() === false)
					return { allowed: false, title: 'Return to your own canvas to use upload history and Recall' };
				if (!isCapabilityReady()) {
					return { allowed: false, title: 'Checking Recall uploads access' };
				}
				if (!hasCapability('recall-upload')) {
					return { allowed: false, title: recallPermissionTitle };
				}
				return { allowed: true, title: '' };
			}

			function lockedRecallButton(label) {
				const access = recallCapabilityState();
				if (access.allowed) {
					return null;
				}
				return (
					'<span class="uh-recall-capability-tip" tabindex="0" title="' +
					escapeHtml(access.title) +
					'">' +
					'<button type="button" class="button secondary" disabled data-uh-recall-locked>' +
					'\uD83D\uDD12 ' +
					escapeHtml(label) +
					'</button>' +
					'</span>'
				);
			}

			function recallHelpHtml() {
				const icon = (paths, tone = 'muted') =>
					'<svg class="uh-recall-icon--' +
					tone +
					'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
					paths +
					'</svg>';
				const created = icon(
					'<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M12 8v8M8 12h8"/>',
					'success',
				);
				const updated = icon('<path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z"/>', 'warn');
				const deleted = icon('<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>', 'danger');
				const reset = icon('<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6M12 7v5l3 2"/>', 'info');
				const unchanged = icon('<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>');
				const arrow =
					'<span class="uh-recall-help-arrow">' + icon('<path d="M4 12h16m-6-6 6 6-6 6"/>') + '</span>';
				const row = (beforeIcon, before, afterIcon, after, detail) =>
					'<span class="uh-recall-help-row"><span class="uh-recall-help-step">' +
					beforeIcon +
					'<span>' +
					before +
					'</span></span>' +
					arrow +
					'<span class="uh-recall-help-step">' +
					afterIcon +
					'<span>' +
					after +
					(detail ? '<small>' + detail + '</small>' : '') +
					'</span></span></span>';
				return (
					'<span class="uh-info-tooltip uh-recall-help">' +
					'<button type="button" class="uh-info-tooltip-trigger" aria-label="How does recall work?" aria-describedby="uh-recall-help">?</button>' +
					'<span class="uh-info-tooltip-content uh-recall-help-panel" id="uh-recall-help" role="tooltip">' +
					'<strong class="uh-recall-help-title">What recall does</strong>' +
					row(created, 'Created', deleted, 'Deleted', '') +
					row(updated, 'Updated', reset, 'Value reset', 'To before upload') +
					row(deleted, 'Deleted', unchanged, 'No change', 'Stays deleted') +
					'</span></span>'
				);
			}

			function showUploadHistoryModal() {
				if (deps.canUseHistory?.() === false) return;
				document.querySelectorAll('.upload-history-modal').forEach((el) => el.remove());
				const overlay = document.createElement('div');
				overlay.className = 'modal upload-history-modal';
				overlay.innerHTML =
					'<div class="modal-overlay" data-uh-close></div>' +
					'<div class="modal-body" style="max-width:900px">' +
					'<div class="modal-header">' +
					'<div class="uh-heading"><h3 id="uh-header-title">Recent uploads</h3>' +
					recallHelpHtml() +
					'</div>' +
					'<button class="modal-close" data-uh-close>&times;</button>' +
					'</div>' +
					'<div class="modal-content" id="uh-content">' +
					'<p class="center tag">Loading…</p>' +
					'</div>' +
					'</div>';
				overlay.__uhHistoryState = { batches: [], nextOffset: 0, hasMore: false, loading: false };
				document.body.appendChild(overlay);
				const onEsc = (e) => {
					if (e.key === 'Escape') {
						cleanup();
					}
				};
				const cleanup = () => {
					document.removeEventListener('keydown', onEsc, true);
					if (overlay.parentNode) {
						overlay.remove();
					}
				};
				document.addEventListener('keydown', onEsc, true);
				overlay.querySelectorAll('[data-uh-close]').forEach((el) => el.addEventListener('click', cleanup));
				Promise.resolve(refreshCapabilities())
					.catch(() => null)
					.finally(() => _renderUploadHistoryList(overlay));
			}

			function _wireUploadHistoryListActions(content, overlay) {
				content.querySelectorAll('[data-uh-recall]').forEach((btn) => {
					btn.addEventListener('click', () => _confirmAndRecall(btn.dataset.uhRecall, overlay));
				});
				content.querySelectorAll('[data-uh-forget]').forEach((btn) => {
					btn.addEventListener('click', () => _forgetBatch(btn.dataset.uhForget, overlay));
				});
				const loadMoreButton = content.querySelector('[data-uh-load-more]');
				if (loadMoreButton) {
					loadMoreButton.addEventListener('click', () => _renderUploadHistoryList(overlay, { append: true }));
				}
			}

			async function _renderUploadHistoryList(overlay, options) {
				const content = overlay.querySelector('#uh-content');
				const title = overlay.querySelector('#uh-header-title');
				const append = !!(options && options.append);
				const state = overlay.__uhHistoryState || {
					batches: [],
					nextOffset: 0,
					hasMore: false,
					loading: false,
				};
				overlay.__uhHistoryState = state;
				if (state.loading) {
					return;
				}
				state.loading = true;
				const offset = append ? state.nextOffset : 0;
				if (title) {
					title.textContent = 'Recent uploads';
				}
				if (append) {
					const loadMoreButton = content.querySelector('[data-uh-load-more]');
					if (loadMoreButton) {
						loadMoreButton.disabled = true;
						loadMoreButton.textContent = 'Loading…';
					}
				}
				try {
					const r = await csrfFetch(
						'/api/upload-batches?limit=' + uploadHistoryPageSize + '&offset=' + offset,
						{ credentials: 'same-origin' },
					);
					const body = await r.json().catch(() => ({}));
					if (!r.ok) {
						const errorHtml =
							'<div class="banner error">' +
							escapeHtml(body.message || body.error || 'HTTP ' + r.status) +
							'</div>';
						if (append) {
							content.insertAdjacentHTML('beforeend', errorHtml);
						} else {
							content.innerHTML = errorHtml;
						}
						state.loading = false;
						return;
					}
					const pageBatches = (body && body.batches) || [];
					if (append) {
						const knownIds = new Set(state.batches.map((batch) => batch.id));
						state.batches = state.batches.concat(pageBatches.filter((batch) => !knownIds.has(batch.id)));
					} else {
						state.batches = pageBatches;
					}
					const pagination = (body && body.pagination) || {};
					state.nextOffset =
						typeof pagination.nextOffset === 'number' ? pagination.nextOffset : offset + pageBatches.length;
					state.hasMore =
						typeof pagination.hasMore === 'boolean'
							? pagination.hasMore
							: pageBatches.length === uploadHistoryPageSize;
					const batches = state.batches;
					const lockedRecallAction = lockedRecallButton('Recall');
					if (batches.length === 0) {
						content.innerHTML =
							'<p class="tag center">No uploads yet. Once you upload records, they’ll appear here so you can recall them later. <a href="/docs/walkthroughs/recall-upload" target="_blank" rel="noopener" class="empty-doclink">How recall works &rarr;</a></p>';
						state.loading = false;
						return;
					}
					const fmtDate = (ms) => {
						const d = new Date(ms);
						return (
							d.toLocaleDateString() +
							' ' +
							d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
						);
					};
					const statusBadge = (b) => {
						if (b.status === 'pending') {
							return '<span class="tag uh-status-partial">Outcome unknown</span>';
						}
						if (b.status === 'failed') {
							return '<span class="tag uh-status-failed">Not uploaded</span>';
						}
						if (b.status === 'recalled') {
							return '<span class="tag uh-status-recalled">Recalled</span>';
						}
						if (b.status === 'recall_failed') {
							return '<span class="tag uh-status-failed">Recall failed</span>';
						}
						if (b.status === 'recall_partial') {
							return '<span class="tag uh-status-partial">Partial recall</span>';
						}
						if (b.status === 'recalling') {
							return '<span class="tag uh-status-busy">Recalling…</span>';
						}
						return '';
					};
					const detailLine = (b) => {
						if (b.status === 'pending') {
							return b.recordCount + ' attempted, verify in Salesforce';
						}
						if (b.status === 'failed') {
							return b.recordCount + ' attempted, none saved';
						}
						const ins = typeof b.insertedCount === 'number' ? b.insertedCount : null;
						const del = typeof b.deletedCount === 'number' ? b.deletedCount : 0;
						if (ins == null) {
							return b.recordCount + ' record' + (b.recordCount === 1 ? '' : 's');
						}
						if (del === 0) {
							return ins + ' synced';
						}
						if (ins === 0) {
							return del + ' deleted';
						}
						return ins + ' synced · ' + del + ' deleted';
					};
					const hasRecallableInserts = (b) => {
						if (typeof b.insertedCount !== 'number') {
							return true;
						}
						return b.insertedCount > 0;
					};
					content.innerHTML =
						'<div class="uh-list">' +
						batches
							.map(
								(b) =>
									'<div class="uh-row" data-uh-batch="' +
									escapeHtml(b.id) +
									'">' +
									'<div class="uh-row-main">' +
									'<div class="uh-row-line1">' +
									'<span class="uh-when">' +
									escapeHtml(fmtDate(b.createdAt)) +
									'</span>' +
									'<span class="uh-sep">·</span>' +
									'<span class="uh-count">' +
									escapeHtml(detailLine(b)) +
									'</span>' +
									statusBadge(b) +
									'</div>' +
									(b.note ? '<div class="uh-note">' + escapeHtml(b.note) + '</div>' : '') +
									(b.status === 'pending'
										? '<div class="uh-note">Salesforce may have saved some or all of these records. Check Salesforce before retrying the same drafts.</div>'
										: '') +
									'</div>' +
									'<div class="uh-row-actions">' +
									(hasRecallableInserts(b) &&
									(b.status === 'uploaded' ||
										b.status === 'recall_partial' ||
										b.status === 'recall_failed')
										? lockedRecallAction ||
											'<button type="button" class="button secondary" data-uh-recall="' +
												escapeHtml(b.id) +
												'">Recall</button>'
										: '') +
									'<button type="button" class="link-button" data-uh-forget="' +
									escapeHtml(b.id) +
									'" title="Remove this row from the history (does NOT touch Salesforce)">Forget</button>' +
									'</div>' +
									'</div>',
							)
							.join('') +
						'</div>' +
						(state.hasMore
							? '<div class="center" style="margin-top:12px"><button type="button" class="button secondary" data-uh-load-more>Load more</button></div>'
							: '');
					_wireUploadHistoryListActions(content, overlay);
					state.loading = false;
				} catch (e) {
					const errorHtml =
						'<div class="banner error">Couldn’t load history: ' +
						escapeHtml(e.message || String(e)) +
						'</div>';
					if (append) {
						content.insertAdjacentHTML('beforeend', errorHtml);
					} else {
						content.innerHTML = errorHtml;
					}
					state.loading = false;
				}
			}

			async function _confirmAndRecall(batchId, overlay) {
				if (deps.canUseHistory?.() === false) return;
				const content = overlay.querySelector('#uh-content');
				const title = overlay.querySelector('#uh-header-title');
				const historyListHtml = content.innerHTML;
				const restoreHistoryList = (updatedStatus) => {
					if (title) {
						title.textContent = 'Recent uploads';
					}
					content.innerHTML = historyListHtml;
					if (typeof updatedStatus === 'string') {
						const state = overlay.__uhHistoryState;
						const stateBatch = state && state.batches.find((candidate) => candidate.id === batchId);
						if (stateBatch) {
							stateBatch.status = updatedStatus;
						}
						const row = Array.from(content.querySelectorAll('[data-uh-batch]')).find(
							(candidate) => candidate.dataset.uhBatch === batchId,
						);
						const statusViews = {
							recalled: { className: 'uh-status-recalled', label: 'Recalled' },
							recall_partial: { className: 'uh-status-partial', label: 'Partial recall' },
							recall_failed: { className: 'uh-status-failed', label: 'Recall failed' },
						};
						const statusView = statusViews[updatedStatus];
						if (row && statusView) {
							const line = row.querySelector('.uh-row-line1');
							let badge = line && line.querySelector('.tag');
							if (!badge && line) {
								badge = document.createElement('span');
								line.appendChild(badge);
							}
							if (badge) {
								badge.className = 'tag ' + statusView.className;
								badge.textContent = statusView.label;
							}
							if (updatedStatus === 'recalled') {
								const recallButton = row.querySelector('[data-uh-recall]');
								if (recallButton) {
									recallButton.remove();
								}
							}
						}
					}
					_wireUploadHistoryListActions(content, overlay);
				};
				if (title) {
					title.textContent = 'Recall this upload?';
				}
				content.innerHTML = '<p class="center tag">Checking which records have changed since upload…</p>';
				let batch;
				let preflight;
				try {
					// Recheck drift immediately before presenting destructive recall choices.
					const preflightResp = await csrfFetch(
						'/api/upload-batches/' + encodeURIComponent(batchId) + '/recall-preflight',
						{
							method: 'POST',
							credentials: 'same-origin',
							headers: { 'Content-Type': 'application/json' },
							body: '{}',
						},
					);
					preflight = await preflightResp.json();
					if (!preflightResp.ok) {
						throw new Error(preflight.message || preflight.error || 'Preflight failed');
					}
					batch = preflight.batch || {};
				} catch (e) {
					content.innerHTML = '<div class="banner error">' + escapeHtml(e.message || String(e)) + '</div>';
					return;
				}
				const cleanList = preflight.clean || [];
				const driftedList = preflight.drifted || [];
				const alreadyDeletedList = preflight.alreadyDeleted || [];
				const unverifiedList = preflight.unverified || [];
				const cascadeConflicts = preflight.cascadeConflicts || [];
				const preUploadCapturedAt = Number(batch && batch.preUploadCapturedAt);
				const authoritativePreUploadTime =
					Number.isFinite(preUploadCapturedAt) && preUploadCapturedAt > 0 ? preUploadCapturedAt : null;
				const baselineTooltipText = authoritativePreUploadTime
					? 'Updated fields return to the Salesforce values captured immediately before this upload on ' +
						escapeHtml(new Date(authoritativePreUploadTime).toLocaleString()) +
						'.'
					: 'This older upload restores updated fields to the Salesforce values held by the canvas when the upload began.';

				const sfBase = String((batch && batch.instanceUrl) || '').replace(/\/+$/, '');
				function recordUrl(record) {
					if (!sfBase || !record || !record.objectName || !record.sfId) {
						return null;
					}
					return (
						sfBase +
						'/lightning/r/' +
						encodeURIComponent(record.objectName) +
						'/' +
						encodeURIComponent(record.sfId) +
						'/view'
					);
				}
				function recordIdentityHtml(record) {
					const objectLabel = (record && (record.objectLabel || record.objectName)) || 'Record';
					const recordName = (record && (record.recordName || record.sfId)) || 'Unknown record';
					const url = recordUrl(record);
					return (
						'<div class="upload-result-identity uh-record-identity"><strong class="upload-result-name">' +
						escapeHtml(objectLabel) +
						' - ' +
						(url
							? '<a href="' +
								escapeHtml(url) +
								'" target="_blank" rel="noopener" title="View in Salesforce">' +
								escapeHtml(recordName) +
								'</a>'
							: escapeHtml(recordName)) +
						'</strong></div>'
					);
				}
				const cleanRecordRows = cleanList
					.map((record) => {
						const name =
							(record.objectLabel || record.objectName || 'Record') +
							' - ' +
							(record.recordName || record.sfId);
						return (
							'<li class="uh-delete-choice">' +
							'<input type="checkbox" data-uh-delete-record="' +
							escapeHtml(record.sfId) +
							'" checked aria-label="Delete ' +
							escapeHtml(name) +
							'">' +
							'<div class="uh-delete-choice-copy">' +
							recordIdentityHtml(record) +
							'</div></li>'
						);
					})
					.join('');
				const driftedRows = driftedList
					.map((record) => {
						const when = record.lastModifiedDate
							? new Date(record.lastModifiedDate).toLocaleString()
							: null;
						const status =
							record.driftReason === 'missing_upload_baseline'
								? 'Change tracking unavailable'
								: 'Changed since upload';
						const tooltip =
							record.driftReason === 'missing_upload_baseline'
								? 'Uploaded before exact change tracking was available.'
								: when
									? 'Modified since upload on ' + when
									: 'Modified since this upload.';
						const name =
							(record.objectLabel || record.objectName || 'Record') +
							' - ' +
							(record.recordName || record.sfId);
						return (
							'<li class="uh-delete-choice">' +
							'<input type="checkbox" data-uh-delete-record="' +
							escapeHtml(record.sfId) +
							'" data-uh-force-delete-record="' +
							escapeHtml(record.sfId) +
							'" aria-label="Delete ' +
							escapeHtml(name) +
							'">' +
							'<div class="uh-delete-choice-copy">' +
							recordIdentityHtml(record) +
							'<span class="uh-delete-change-status" tabindex="0" title="' +
							escapeHtml(tooltip) +
							'">' +
							escapeHtml(status) +
							'</span></div></li>'
						);
					})
					.join('');

				const valueDrift = (preflight && preflight.valueDrift) || { records: [], summary: {} };
				const valueReviewRecords = (valueDrift.records || []).filter(
					(r) => r && !r.notFound && ((r.clean && r.clean.length > 0) || (r.drifted && r.drifted.length > 0)),
				);
				const hasAnyRevertCandidate = valueReviewRecords.length > 0;
				function fmtVal(v) {
					if (v == null || v === '') {
						return '<span class="uh-revert-empty">(empty)</span>';
					}
					return '<code>' + escapeHtml(String(v)) + '</code>';
				}
				function valueCellsHtml(field, restoreInitially) {
					return (
						'<td>' +
						fmtVal(field.prior) +
						'</td>' +
						'<td>' +
						fmtVal(field.uploaded) +
						'</td>' +
						'<td>' +
						fmtVal(field.current) +
						(!restoreInitially ? '<span class="uh-revert-field-status">Changed since upload</span>' : '') +
						'</td>' +
						'<td class="uh-after-value" data-uh-after-mode="selected">' +
						'<span data-uh-after-original' +
						(restoreInitially ? '' : ' hidden') +
						'>' +
						fmtVal(field.prior) +
						'</span>' +
						'<span data-uh-after-current' +
						(restoreInitially ? ' hidden' : '') +
						'>' +
						fmtVal(field.current) +
						'</span></td>'
					);
				}
				const valueRevertSections = valueReviewRecords
					.map((rec) => {
						const recIdAttr = escapeHtml(rec.sfId);
						function fieldRowHtml(field, changed) {
							const fieldName = escapeHtml(field.fieldName);
							const recordAttr = changed ? 'data-uh-force-revert-record' : 'data-uh-revert-record';
							const fieldAttr = changed ? 'data-uh-force-revert-field' : 'data-uh-revert-field';
							return (
								'<tr class="uh-revert-row ' +
								(changed ? 'uh-revert-row--drifted' : 'uh-revert-row--clean') +
								'" data-uh-field-row>' +
								'<th scope="row"><label class="uh-revert-field-choice">' +
								'<input type="checkbox" ' +
								recordAttr +
								'="' +
								recIdAttr +
								'" ' +
								fieldAttr +
								'="' +
								fieldName +
								'"' +
								(changed ? '' : ' checked') +
								'>' +
								'<code>' +
								fieldName +
								'</code></label>' +
								'</th>' +
								valueCellsHtml(field, !changed) +
								'</tr>'
							);
						}
						return (
							'<div class="uh-revert-record">' +
							'<div class="uh-revert-record-title">' +
							recordIdentityHtml(rec) +
							'</div>' +
							'<div class="uh-revert-table-wrap" tabindex="0" role="region" aria-label="Field changes for ' +
							escapeHtml(rec.recordName || rec.sfId) +
							'">' +
							'<table class="uh-revert-table"><thead><tr>' +
							'<th scope="col">Field</th><th scope="col">Original value</th>' +
							'<th scope="col">Uploaded value</th><th scope="col">Current value</th>' +
							'<th scope="col">After recall</th></tr></thead><tbody>' +
							(rec.clean || []).map((field) => fieldRowHtml(field, false)).join('') +
							(rec.drifted || []).map((field) => fieldRowHtml(field, true)).join('') +
							'</tbody></table></div></div>'
						);
					})
					.join('');
				const totalDriftedFieldCount = (valueDrift.summary && valueDrift.summary.driftedFieldCount) || 0;
				const fieldRecallTooltipText =
					baselineTooltipText +
					(totalDriftedFieldCount > 0
						? ' ' +
							totalDriftedFieldCount +
							' field' +
							(totalDriftedFieldCount === 1 ? ' has' : 's have') +
							' changed again since the upload. They are unchecked by default; select an individual field to return it to its original value.'
						: '');
				const valueRevertSection =
					valueReviewRecords.length > 0
						? '<div class="uh-operation-section uh-operation-section--revert">' +
							'<div class="uh-operation-title-row"><h5 class="uh-operation-title">Revert field values</h5>' +
							'<span class="uh-info-tooltip">' +
							'<button type="button" class="uh-info-tooltip-trigger" aria-label="How does field recall work?" aria-describedby="uh-field-recall-tooltip">?</button>' +
							'<span class="uh-info-tooltip-content" id="uh-field-recall-tooltip" role="tooltip">' +
							fieldRecallTooltipText +
							'</span></span></div>' +
							valueRevertSections +
							'</div>'
						: '';

				const unverifiedRows = unverifiedList
					.map((r) => {
						const reason = r.probeError ? r.probeError : 'reason unknown';
						return (
							'<li class="uh-record-item">' +
							recordIdentityHtml(r) +
							'<span class="tag">(' +
							escapeHtml(reason) +
							')</span>' +
							'</li>'
						);
					})
					.join('');
				const unverifiedSection =
					unverifiedList.length > 0
						? '<div class="uh-drifted-block">' +
							'<h5 class="uh-drifted-title">' +
							unverifiedList.length +
							' record' +
							(unverifiedList.length === 1 ? '' : 's') +
							' couldn’t be verified</h5>' +
							'<p class="tag">Salesforce returned an error when we tried to look up the current state of ' +
							(unverifiedList.length === 1 ? 'this record' : 'these records') +
							'. Recall is skipping ' +
							(unverifiedList.length === 1 ? 'it' : 'them') +
							' by default. Common cause: your Salesforce user lost read access to the object since upload; ask your admin to check.</p>' +
							'<ul class="uh-drifted-list">' +
							unverifiedRows +
							'</ul>' +
							'</div>'
						: '';

				const cascadeRows = cascadeConflicts
					.map((c) => {
						const bucketLabel =
							c.childBucket === 'updates' ? 'updated by this batch' : 'modified since upload';
						return (
							'<li>' +
							'<code>' +
							escapeHtml(c.childObjectName) +
							' ' +
							escapeHtml(c.childSfId) +
							'</code> ' +
							'<span class="tag">(' +
							bucketLabel +
							')</span>' +
							'</li>'
						);
					})
					.join('');
				const cascadeHasUpdates = cascadeConflicts.some((c) => c.childBucket === 'updates');
				const cascadeHasDrifted = cascadeConflicts.some((c) => c.childBucket !== 'updates');
				const cascadeChildLabel =
					cascadeHasUpdates && cascadeHasDrifted
						? 'preserved record'
						: cascadeHasUpdates
							? 'updated record'
							: 'drifted record';
				const cascadeSection =
					cascadeConflicts.length > 0
						? '<div class="uh-cascade-block">' +
							'<h5 class="uh-cascade-title">⚠ Master-detail cascade conflict</h5>' +
							'<p class="tag">' +
							cascadeConflicts.length +
							' ' +
							cascadeChildLabel +
							(cascadeConflicts.length === 1 ? '' : 's') +
							' will be deleted ANYWAY because their parent records are being recalled. ' +
							'Salesforce cascade-deletes master-detail children when their parents go; we can’t skip them.' +
							'</p>' +
							'<ul class="uh-cascade-list">' +
							cascadeRows +
							'</ul>' +
							'<label class="uh-cascade-ack">' +
							'<input type="checkbox" data-uh-cascade-ack> ' +
							'I understand: these records will be deleted by cascade.' +
							'</label>' +
							'</div>'
						: '';

				const initiallySelectedRevertIds = new Set(
					valueReviewRecords
						.filter((record) => record && Array.isArray(record.clean) && record.clean.length > 0)
						.map((record) => record.sfId)
						.filter(Boolean),
				);
				const initialActionCount = cleanList.length + initiallySelectedRevertIds.size;
				const hasPotentialRecallWork = cleanList.length > 0 || driftedList.length > 0 || hasAnyRevertCandidate;
				const availableRecallCount = new Set(
					[...cleanList, ...driftedList, ...valueReviewRecords].map((record) => record.sfId),
				).size;
				const createRecallSummary =
					cleanList.length > 0 || driftedList.length > 0
						? '<div class="uh-operation-section uh-operation-section--delete uh-operation-section--selectable">' +
							'<div class="uh-operation-title-row"><h5 class="uh-operation-title">Delete from Salesforce</h5></div>' +
							'<ul class="uh-recall-record-list">' +
							cleanRecordRows +
							driftedRows +
							'</ul>' +
							'</div>'
						: '';
				const nothingToRecallNote = !hasPotentialRecallWork ? '<p class="tag">Nothing to recall here</p>' : '';
				const initialLabelCount = initialActionCount || availableRecallCount;
				const initialActionLabel =
					'Recall ' + initialLabelCount + ' record' + (initialLabelCount === 1 ? '' : 's');
				const recallAction = hasPotentialRecallWork
					? '<button type="button" class="button danger" data-uh-do-recall' +
						(initialActionCount === 0 ? ' disabled' : '') +
						'>' +
						'<span data-uh-recall-label>' +
						initialActionLabel +
						'</span>' +
						'</button>'
					: '';
				content.innerHTML =
					'<div class="uh-confirm">' +
					createRecallSummary +
					nothingToRecallNote +
					unverifiedSection +
					valueRevertSection +
					cascadeSection +
					'<div class="uh-confirm-actions">' +
					'<button type="button" class="button secondary" data-uh-back>Back</button>' +
					recallAction +
					'</div>' +
					'</div>';

				const deleteBoxes = Array.from(content.querySelectorAll('[data-uh-delete-record]'));
				const selectedDeleteIds = () =>
					new Set(
						deleteBoxes
							.filter((box) => box.checked)
							.map((box) => box.getAttribute('data-uh-delete-record')),
					);
				const cascadeAckBox = content.querySelector('[data-uh-cascade-ack]');
				const recallBtn = content.querySelector('[data-uh-do-recall]');
				const recallLabel = content.querySelector('[data-uh-recall-label]');
				function updateAfterRecallValues() {
					content.querySelectorAll('[data-uh-after-mode]').forEach((flow) => {
						const row = flow.closest('[data-uh-field-row]');
						const fieldBox =
							row && row.querySelector('input[data-uh-revert-field], input[data-uh-force-revert-field]');
						const willRestore = !!(fieldBox && fieldBox.checked);
						const originalValue = flow.querySelector('[data-uh-after-original]');
						const currentValue = flow.querySelector('[data-uh-after-current]');
						if (originalValue) {
							originalValue.hidden = !willRestore;
						}
						if (currentValue) {
							currentValue.hidden = willRestore;
						}
						if (row) {
							row.classList.toggle('uh-revert-row--will-restore', willRestore);
						}
					});
				}
				function updateRecallCount() {
					const selectedDeletes = selectedDeleteIds();
					const selectedFieldBoxes = Array.from(
						content.querySelectorAll(
							'input[data-uh-revert-field]:checked, input[data-uh-force-revert-field]:checked',
						),
					);
					const checkedRevertRecordIds = new Set(
						selectedFieldBoxes
							.map(
								(checkbox) =>
									checkbox.getAttribute('data-uh-revert-record') ||
									checkbox.getAttribute('data-uh-force-revert-record'),
							)
							.filter(Boolean),
					);
					const total = new Set([...selectedDeletes, ...checkedRevertRecordIds]).size;
					if (recallLabel) {
						const labelCount = total || availableRecallCount;
						recallLabel.textContent = 'Recall ' + labelCount + ' record' + (labelCount === 1 ? '' : 's');
					}
					const cascadeAckRequired = cascadeConflicts.some(
						(conflict) =>
							selectedDeletes.has(conflict.parentSfId) && !selectedDeletes.has(conflict.childSfId),
					);
					const cascadeAckSatisfied = !cascadeAckRequired || (cascadeAckBox && cascadeAckBox.checked);
					if (recallBtn) {
						recallBtn.disabled = total === 0 || !cascadeAckSatisfied;
					}
					updateAfterRecallValues();
				}
				deleteBoxes.forEach((box) => box.addEventListener('change', updateRecallCount));
				if (cascadeAckBox) {
					cascadeAckBox.addEventListener('change', updateRecallCount);
				}
				content
					.querySelectorAll('input[data-uh-revert-field], input[data-uh-force-revert-field]')
					.forEach((cb) => {
						cb.addEventListener('change', updateRecallCount);
					});
				updateRecallCount();

				content.querySelector('[data-uh-back]').addEventListener('click', restoreHistoryList);
				if (!recallBtn) {
					return;
				}
				recallBtn.addEventListener('click', () => {
					const selectedDeletes = selectedDeleteIds();
					const skipSfIds = [];
					const forceDeleteSfIds = [];
					cleanList.forEach((record) => {
						if (record.sfId && !selectedDeletes.has(record.sfId)) {
							skipSfIds.push(record.sfId);
						}
					});
					driftedList.forEach((record) => {
						if (record.sfId) {
							(selectedDeletes.has(record.sfId) ? forceDeleteSfIds : skipSfIds).push(record.sfId);
						}
					});
					alreadyDeletedList.forEach((r) => {
						if (r.sfId) {
							skipSfIds.push(r.sfId);
						}
					});
					const revertByRecord = new Map();
					content.querySelectorAll('input[data-uh-revert-field]:checked').forEach((cb) => {
						const sfId = cb.getAttribute('data-uh-revert-record');
						const fieldName = cb.getAttribute('data-uh-revert-field');
						if (!sfId || !fieldName) {
							return;
						}
						if (!revertByRecord.has(sfId)) {
							revertByRecord.set(sfId, []);
						}
						revertByRecord.get(sfId).push(fieldName);
					});
					const revertSelections = Array.from(revertByRecord.entries()).map(([sfId, fields]) => ({
						sfId,
						fields,
					}));
					const forceRevertByRecord = new Map();
					content.querySelectorAll('input[data-uh-force-revert-field]:checked').forEach((cb) => {
						const sfId = cb.getAttribute('data-uh-force-revert-record');
						const fieldName = cb.getAttribute('data-uh-force-revert-field');
						const record = valueReviewRecords.find((candidate) => candidate && candidate.sfId === sfId);
						const field =
							record &&
							Array.isArray(record.drifted) &&
							record.drifted.find((candidate) => candidate && candidate.fieldName === fieldName);
						if (!record || !field) {
							return;
						}
						if (!forceRevertByRecord.has(sfId)) {
							forceRevertByRecord.set(sfId, []);
						}
						forceRevertByRecord.get(sfId).push({
							fieldName,
							expectedCurrent: field.current,
						});
					});
					const forceRevertSelections = Array.from(forceRevertByRecord.entries()).map(([sfId, fields]) => ({
						sfId,
						fields,
					}));
					_executeRecall(
						batchId,
						overlay,
						skipSfIds,
						forceDeleteSfIds,
						revertSelections,
						forceRevertSelections,
						restoreHistoryList,
					);
				});
			}

			async function _executeRecall(
				batchId,
				overlay,
				skipSfIds,
				forceDeleteSfIds,
				revertSelections,
				forceRevertSelections,
				restoreHistoryList,
			) {
				// The server revalidates selections; client-side preflight is advisory, not authorization.
				const content = overlay.querySelector('#uh-content');
				content.innerHTML =
					'<p class="center busy-row" style="justify-content:center"><span class="busy-spinner lg"></span><span>Checking recall permission…</span></p>';
				try {
					await refreshCapabilities();
					if (deps.canUseHistory?.() === false) {
						overlay.remove();
						return;
					}
					if (!hasCapability('recall-upload')) {
						content.innerHTML =
							'<div class="banner error"><strong>Recall permission required.</strong> ' +
							escapeHtml(recallPermissionTitle) +
							'. No Salesforce records were changed.</div>' +
							'<div class="uh-confirm-actions">' +
							'<button type="button" class="button" data-uh-list>Back to history</button>' +
							'</div>';
						content.querySelector('[data-uh-list]').addEventListener('click', restoreHistoryList);
						return;
					}
					content.innerHTML =
						'<p class="center busy-row" style="justify-content:center"><span class="busy-spinner lg"></span><span>Recalling…</span></p>';
					const r = await csrfFetch('/api/upload-batches/' + encodeURIComponent(batchId) + '/recall', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						credentials: 'same-origin',
						body: JSON.stringify({
							skipSfIds: Array.isArray(skipSfIds) ? skipSfIds : [],
							forceDeleteSfIds: Array.isArray(forceDeleteSfIds) ? forceDeleteSfIds : [],
							revertSelections: Array.isArray(revertSelections) ? revertSelections : [],
							forceRevertSelections: Array.isArray(forceRevertSelections) ? forceRevertSelections : [],
						}),
					});
					const body = await r.json();
					if (!r.ok) {
						throw new Error(body.message || body.error || 'Recall failed');
					}
					const allResults = body.results || [];
					const alreadyDeleted = allResults.filter(
						(x) => x && x.success && x.note === 'Already deleted',
					).length;
					const succeeded = allResults.filter((x) => x && x.success && x.note !== 'Already deleted').length;
					const failures = allResults.filter((x) => x && !x.success);
					const failed = failures.length;
					const preservedUpdates = body.preservedUpdatesCount || 0;

					const deletedSfIds = allResults.filter((x) => x && x.success && x.sfId).map((x) => x.sfId);
					if (deletedSfIds.length > 0) {
						try {
							document.dispatchEvent(
								new CustomEvent('orgloom:records-deleted', {
									detail: { sfIds: deletedSfIds },
								}),
							);
						} catch (_) {
							/* CustomEvent unsupported: skip live update */
						}
					}
					if (refreshCanvasAfterRecall) {
						// Rehydrate records from Salesforce so the canvas reflects deletes and reverted values.
						try {
							await refreshCanvasAfterRecall(body);
						} catch (refreshError) {
							showBulkToast(
								'Recall completed, but the canvas could not be refreshed. Use Tools > Refresh from Salesforce to reconcile it: ' +
									(refreshError && refreshError.message ? refreshError.message : refreshError),
								'warn',
							);
						}
					}
					const revertedFields = body.revertedFieldCount || 0;
					const forcedRevertedFields = body.forcedRevertedFieldCount || 0;
					const normallyRevertedFields = Math.max(0, revertedFields - forcedRevertedFields);
					const alreadyRestoredFields = body.alreadyRestoredFieldCount || 0;
					const failedFields = body.revertFailedFieldCount || 0;
					const preservedAtExecution = body.revertDriftSkippedCount || 0;
					const outcomeParts = [];
					if (succeeded > 0) {
						outcomeParts.push(succeeded + ' record' + (succeeded === 1 ? '' : 's') + ' deleted');
					}
					if (alreadyDeleted > 0) {
						outcomeParts.push(
							alreadyDeleted +
								' record' +
								(alreadyDeleted === 1 ? ' was' : 's were') +
								' already deleted',
						);
					}
					if (normallyRevertedFields > 0) {
						outcomeParts.push(
							normallyRevertedFields +
								' field value' +
								(normallyRevertedFields === 1 ? '' : 's') +
								' restored',
						);
					}
					if (forcedRevertedFields > 0) {
						outcomeParts.push(
							forcedRevertedFields +
								' changed field value' +
								(forcedRevertedFields === 1 ? '' : 's') +
								' restored by override',
						);
					}
					if (alreadyRestoredFields > 0) {
						outcomeParts.push(
							alreadyRestoredFields +
								' field value' +
								(alreadyRestoredFields === 1 ? ' was' : 's were') +
								' already restored',
						);
					}
					if (preservedAtExecution > 0) {
						outcomeParts.push(
							preservedAtExecution +
								' field value' +
								(preservedAtExecution === 1 ? '' : 's') +
								' preserved after changing during recall',
						);
					}
					if (failed > 0) {
						outcomeParts.push(failed + ' record delete' + (failed === 1 ? '' : 's') + ' failed');
					}
					if (failedFields > 0) {
						outcomeParts.push(
							failedFields + ' field restoration' + (failedFields === 1 ? '' : 's') + ' failed',
						);
					}
					if (outcomeParts.length === 0 && preservedUpdates > 0) {
						outcomeParts.push('No selected field values needed restoration');
					}
					const revertFailures = (body.revertResults || []).filter((x) => x && !x.success);
					const allFailures = failures.concat(revertFailures);
					// A batch can remain partially recalled because the user left changes unselected.
					// Judge this action by its selected operations, not the whole batch's status.
					const hasRecallIssues = allFailures.length > 0 || failedFields > 0 || preservedAtExecution > 0;
					const retryCopy = hasRecallIssues ? '. Remaining changes can be retried from upload history.' : '';
					const bannerClass = hasRecallIssues ? 'banner error' : 'banner success';
					const banner =
						'<div class="' +
						bannerClass +
						'">' +
						escapeHtml(outcomeParts.join('; ') || 'Nothing needed to be changed') +
						retryCopy +
						'</div>';
					const failureRows =
						allFailures.length === 0
							? ''
							: '<div class="upload-section-head upload-section-head--err">Failures</div>' +
								'<div class="upload-summary" style="grid-template-columns: auto 1fr 2fr;">' +
								allFailures
									.map(
										(f) =>
											'<div>' +
											escapeHtml(f.objectName) +
											'</div>' +
											'<div><code>' +
											escapeHtml(f.sfId) +
											'</code></div>' +
											'<div>' +
											escapeHtml(
												(f.fieldsFailed && f.fieldsFailed.length
													? f.fieldsFailed.join(', ') + ': '
													: '') + (f.error || ''),
											) +
											'</div>',
									)
									.join('') +
								'</div>';
					content.innerHTML =
						banner +
						failureRows +
						'<div class="uh-confirm-actions">' +
						'<button type="button" class="button" data-uh-list>Back to history</button>' +
						'</div>';
					content
						.querySelector('[data-uh-list]')
						.addEventListener('click', () => restoreHistoryList(body.status));
				} catch (e) {
					content.innerHTML =
						'<div class="banner error">' +
						escapeHtml(e.message || String(e)) +
						'</div>' +
						'<div class="uh-confirm-actions">' +
						'<button type="button" class="button" data-uh-list>Back to history</button>' +
						'</div>';
					content.querySelector('[data-uh-list]').addEventListener('click', restoreHistoryList);
				}
			}

			async function _forgetBatch(batchId, overlay) {
				try {
					const r = await csrfFetch('/api/upload-batches/' + encodeURIComponent(batchId), {
						method: 'DELETE',
						credentials: 'same-origin',
					});
					const body = await r.json().catch(() => ({}));
					if (!r.ok) {
						throw new Error(body.message || body.error || 'Forget failed');
					}
					_renderUploadHistoryList(overlay);
				} catch (e) {
					showBulkToast('Couldn’t forget batch: ' + (e.message || e), 'error');
				}
			}

			return {
				openModal: showUploadHistoryModal,
				_testConfirmAndRecall: function (batchId) {
					const overlay = document.querySelector('.upload-history-modal');
					if (!overlay) {
						return Promise.resolve(false);
					}
					return _confirmAndRecall(batchId, overlay).then(() => true);
				},
			};
		},
	};
})();

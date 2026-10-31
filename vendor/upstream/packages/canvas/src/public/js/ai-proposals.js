(function () {
	'use strict';
	// Previews AI-suggested draft changes and applies only choices explicitly accepted by the user.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.aiProposals = {
		mount: function mount(deps) {
			const _required = [
				'canvasState',
				'csrfFetch',
				'escapeHtml',
				'showBulkToast',
				'showConfirmDialog',
				'addToSelection',
				'bulkAutoFill',
				'ensureDescribe',
				'renderBulkView',
			];
			for (const k of _required) {
				if (deps == null || deps[k] == null) {
					throw new Error('ai-proposals.mount: missing required dep: ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			const showBulkToast = deps.showBulkToast;
			const showConfirmDialog = deps.showConfirmDialog;
			const addToSelection = deps.addToSelection;
			const bulkAutoFill = deps.bulkAutoFill;
			const ensureDescribe = deps.ensureDescribe;
			const renderBulkView = deps.renderBulkView;
			const pushUndo = typeof deps.pushUndo === 'function' ? deps.pushUndo : null;
			const canvasCapCheck =
				typeof deps.canvasCapCheck === 'function'
					? deps.canvasCapCheck
					: function () {
							return { ok: true, blocked: false, reason: null };
						};
			let _proposalsLastCanvasId = null;
			function _upsertSingleLookupAssociation(associations, nextAssociation) {
				const current = Array.isArray(associations) ? associations : [];
				const sameLookup = current.filter(
					(association) =>
						association.fromId === nextAssociation.fromId &&
						association.fieldName === nextAssociation.fieldName,
				);
				const exact = sameLookup.find((association) => association.toId === nextAssociation.toId);
				if (sameLookup.length === 1 && exact) {
					return { associations: current, changed: false, inserted: false };
				}
				const withoutLookup = current.filter(
					(association) =>
						association.fromId !== nextAssociation.fromId ||
						association.fieldName !== nextAssociation.fieldName,
				);
				withoutLookup.push(exact || nextAssociation);
				return { associations: withoutLookup, changed: true, inserted: !exact };
			}
			function _syncLookupFieldValue(records, fromId, toId, fieldName) {
				const holder = records.find((record) => record && record.id === fromId);
				const target = records.find((record) => record && record.id === toId);
				if (!holder || !target || !fieldName) {
					return false;
				}
				holder.values = holder.values || {};
				const targetSalesforceId = target.loadedFromId || (target.values && target.values.Id) || null;
				if (targetSalesforceId) {
					if (String(holder.values[fieldName] || '') === String(targetSalesforceId)) {
						return false;
					}
					holder.values[fieldName] = targetSalesforceId;
					return true;
				}
				if (Object.prototype.hasOwnProperty.call(holder.values, fieldName)) {
					delete holder.values[fieldName];
					return true;
				}
				return false;
			}

			function _stableConflictValue(value) {
				if (value == null || typeof value !== 'object') {
					return JSON.stringify(value);
				}
				if (Array.isArray(value)) {
					return '[' + value.map(_stableConflictValue).join(',') + ']';
				}
				return (
					'{' +
					Object.keys(value)
						.sort()
						.map((key) => JSON.stringify(key) + ':' + _stableConflictValue(value[key]))
						.join(',') +
					'}'
				);
			}

			function _proposalEndpointKey(endpoint, proposalId) {
				if (!endpoint || endpoint.ref == null) {
					return null;
				}
				const kind = String(endpoint.kind || '').toLowerCase();
				if (kind === 'loaded') {
					return 'record:' + String(endpoint.ref).toLowerCase();
				}
				if (kind === 'draft') {
					return 'draft:' + String(endpoint.ref);
				}
				if (kind === 'tempref') {
					return 'new-draft:' + String(proposalId) + ':' + String(endpoint.ref);
				}
				return null;
			}

			function _proposalConflictEntries(proposal) {
				const entries = [];
				const proposalId = String((proposal && proposal.id) || '');
				const changes = proposal && Array.isArray(proposal.changes) ? proposal.changes : [];
				changes.forEach((change, changeIndex) => {
					if (!change || typeof change !== 'object') {
						return;
					}
					let targetKey = null;
					if (change.kind === 'record' && change.recordId != null) {
						targetKey = 'record:' + String(change.recordId).toLowerCase();
					} else if (change.kind === 'draft' && change.tempId != null) {
						targetKey = 'draft:' + String(change.tempId);
					}
					if (
						(change.kind === 'delete-record' && change.recordId != null) ||
						(change.kind === 'delete-draft' && change.tempId != null)
					) {
						targetKey =
							change.kind === 'delete-record'
								? 'record:' + String(change.recordId).toLowerCase()
								: 'draft:' + String(change.tempId);
						entries.push({
							key: targetKey + '|delete',
							targetKey,
							label: (change.objectName || 'Record') + ' · record removal',
							proposalId,
							changeIndex,
							valueKey: change.kind,
							deletesTarget: true,
						});
						return;
					}
					if (targetKey && change.fields && typeof change.fields === 'object') {
						Object.keys(change.fields).forEach((fieldName) => {
							entries.push({
								key: targetKey + '|field:' + fieldName.toLowerCase(),
								targetKey,
								label: (change.objectName || 'Record') + ' · ' + fieldName,
								proposalId,
								changeIndex,
								valueKey: 'value:' + _stableConflictValue(change.fields[fieldName]),
							});
						});
						return;
					}
					if (change.kind === 'new-association' || change.kind === 'delete-association') {
						targetKey = _proposalEndpointKey(change.from, proposalId);
						if (!targetKey || !change.fieldName) {
							return;
						}
						const destination =
							change.kind === 'delete-association'
								? 'unlinked'
								: _proposalEndpointKey(change.to, proposalId) || 'unknown';
						entries.push({
							key: targetKey + '|field:' + String(change.fieldName).toLowerCase(),
							targetKey,
							label: (change.objectName || 'Record') + ' · ' + change.fieldName,
							proposalId,
							changeIndex,
							valueKey: change.kind + ':' + destination,
						});
					}
				});
				return entries;
			}

			function _proposalConflictGroups(proposals) {
				const byKey = new Map();
				const byTarget = new Map();
				(Array.isArray(proposals) ? proposals : []).forEach((proposal) => {
					_proposalConflictEntries(proposal).forEach((entry) => {
						if (!byKey.has(entry.key)) {
							byKey.set(entry.key, []);
						}
						byKey.get(entry.key).push(entry);
						if (entry.targetKey) {
							if (!byTarget.has(entry.targetKey)) {
								byTarget.set(entry.targetKey, []);
							}
							byTarget.get(entry.targetKey).push(entry);
						}
					});
				});
				const groups = [];
				for (const [key, entries] of byKey.entries()) {
					if (
						new Set(entries.map((entry) => entry.proposalId)).size > 1 &&
						new Set(entries.map((entry) => entry.valueKey)).size > 1
					) {
						groups.push({
							key,
							label: entries[0].label,
							entries,
						});
					}
				}
				for (const [targetKey, entries] of byTarget.entries()) {
					if (
						entries.some((entry) => entry.deletesTarget) &&
						entries.some((entry) => !entry.deletesTarget) &&
						new Set(entries.map((entry) => entry.proposalId)).size > 1
					) {
						groups.push({
							key: targetKey + '|record-lifecycle',
							label: entries.find((entry) => entry.deletesTarget).label,
							entries,
						});
					}
				}
				return groups;
			}

			const _proposalsBanner = document.createElement('div');
			_proposalsBanner.className = 'proposals-banner';
			_proposalsBanner.hidden = true;
			const _proposalsBannerText = document.createElement('span');
			_proposalsBannerText.className = 'proposals-banner-text';
			const _proposalsReviewBtn = document.createElement('button');
			_proposalsReviewBtn.type = 'button';
			_proposalsReviewBtn.className = 'button';
			_proposalsReviewBtn.id = 'proposals-banner-review';
			_proposalsReviewBtn.textContent = 'Review';
			const _proposalsCloseBtn = document.createElement('button');
			_proposalsCloseBtn.type = 'button';
			_proposalsCloseBtn.className = 'proposals-banner-close';
			_proposalsCloseBtn.id = 'proposals-banner-close';
			_proposalsCloseBtn.setAttribute('aria-label', 'Dismiss');
			_proposalsCloseBtn.textContent = '×';
			_proposalsBanner.innerHTML = '<span class="proposals-banner-icon" aria-hidden="true">✨</span>';
			_proposalsBanner.appendChild(_proposalsBannerText);
			_proposalsBanner.appendChild(_proposalsReviewBtn);
			_proposalsBanner.appendChild(_proposalsCloseBtn);
			const _proposalsBannerHost =
				(typeof document.querySelector === 'function' && document.querySelector('#graph-bulk')) ||
				document.body;
			_proposalsBannerHost.appendChild(_proposalsBanner);
			_proposalsReviewBtn.addEventListener('click', () => {
				const cur = _proposalsPollCanvasId();
				if (cur) {
					_openProposalsReview(cur);
				}
			});
			_proposalsCloseBtn.addEventListener('click', () => {
				_proposalsBanner.hidden = true;
			});

			function _proposalsPollCanvasId() {
				if (canvasState.currentCanvas && canvasState.currentCanvas.id) {
					return canvasState.currentCanvas.id;
				}
				const cs = window.Orgloom && window.Orgloom.canvasState;
				if (cs && typeof cs.getCurrentCanvas === 'function') {
					const c = cs.getCurrentCanvas();
					return (c && c.canvasId) || null;
				}
				return null;
			}
			async function _refreshProposals() {
				if (window.ORGLOOM_MCP_ACTIVE !== true) {
					_proposalsBanner.hidden = true;
					_proposalsLastCanvasId = null;
					return;
				}
				const id = _proposalsPollCanvasId();
				if (!id) {
					_proposalsBanner.hidden = true;
					return;
				}
				try {
					const r = await csrfFetch('/api/canvas/' + encodeURIComponent(id) + '/proposals', {
						credentials: 'same-origin',
					});
					if (!r.ok) {
						_proposalsBanner.hidden = true;
						return;
					}
					const data = await r.json();
					const proposals =
						data && Array.isArray(data.proposals)
							? data.proposals
									.slice()
									.sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0))
							: [];
					if (proposals.length === 0) {
						_proposalsBanner.hidden = true;
						return;
					}

					if (_isAutoApplyEnabled(id)) {
						_proposalsBanner.hidden = true;

						for (const p of proposals) {
							try {
								await _applyProposal(id, p.id, null, {
									skipConfirm: true,
									silentToast: true,
								});
							} catch (_) {}
						}
						return;
					}
					const totalChanges = proposals.reduce(
						(sum, p) => sum + (Array.isArray(p.changes) ? p.changes.length : 0),
						0,
					);

					_proposalsBannerText.innerHTML =
						'<strong>' +
						proposals.length +
						'</strong> AI proposal' +
						(proposals.length === 1 ? '' : 's') +
						' pending (<strong>' +
						totalChanges +
						'</strong> change' +
						(totalChanges === 1 ? '' : 's') +
						')';
					if (_proposalsBanner.hidden && window.posthog && window.posthog.capture) {
						try {
							window.posthog.capture('ai_proposal_received', {
								proposal_count: proposals.length,
								change_count: totalChanges,
								canvas_id_kind:
									typeof id === 'string' && id.indexOf('draft-') === 0 ? 'draft' : 'saved',
							});
						} catch (_) {}
					}
					_proposalsBanner.hidden = false;
				} catch (e) {}
			}

			function _watchProposalsForCurrentCanvas() {
				if (window.ORGLOOM_MCP_ACTIVE !== true) {
					_proposalsBanner.hidden = true;
					_proposalsLastCanvasId = null;
					return;
				}
				const id = _proposalsPollCanvasId();
				if (id !== _proposalsLastCanvasId) {
					_proposalsLastCanvasId = id;
					_refreshProposals();
				}
			}

			_watchProposalsForCurrentCanvas();

			document.addEventListener('visibilitychange', () => {
				if (document.visibilityState === 'visible') {
					_refreshProposals();
				}
			});
			window.addEventListener('focus', () => {
				_refreshProposals();
			});
			window.addEventListener('orgloom:mcp-availability', () => {
				_watchProposalsForCurrentCanvas();
			});
			window.addEventListener('orgloom:ai-proposals-changed', (event) => {
				const detail = event.detail || {};
				if (detail.canvasId && detail.canvasId === _proposalsPollCanvasId()) {
					_refreshProposals();
				}
			});

			function _autoApplyStorageKey(canvasId) {
				return 'orgloom:aiAutoApply:' + canvasId;
			}
			function _isAutoApplyEnabled(canvasId) {
				if (!canvasId) {
					return false;
				}
				try {
					return window.localStorage.getItem(_autoApplyStorageKey(canvasId)) === '1';
				} catch (_) {
					return false;
				}
			}
			function _setAutoApplyEnabled(canvasId, on) {
				if (!canvasId) {
					return;
				}
				try {
					if (on) {
						window.localStorage.setItem(_autoApplyStorageKey(canvasId), '1');
					} else {
						window.localStorage.removeItem(_autoApplyStorageKey(canvasId));
					}
				} catch (_) {}
			}

			async function _openProposalsReview(canvasId) {
				document.querySelectorAll('.proposals-review-modal').forEach((el) => el.remove());
				const modal = document.createElement('div');
				modal.className = 'modal proposals-review-modal';
				modal.setAttribute('data-canvas-id', canvasId);
				modal.innerHTML =
					'<div class="modal-overlay" data-pr-close></div>' +
					'<div class="modal-body" style="max-width:780px">' +
					'<div class="modal-header">' +
					'<h3>AI proposals</h3>' +
					'<button class="modal-close" data-pr-close>&times;</button>' +
					'</div>' +
					'<div class="proposals-autoapply-row">' +
					'<label class="proposals-autoapply-label">' +
					'<input type="checkbox" class="proposals-autoapply-toggle"' +
					(_isAutoApplyEnabled(canvasId) ? ' checked' : '') +
					'>' +
					'<span><strong>Auto-apply AI proposals to this canvas</strong>: future proposals land on the canvas without opening this review. Each change still echoes into the canvas state as if you clicked Apply; Salesforce uploads still require a separate Save + Upload. Per-canvas, browser-only.</span>' +
					'</label>' +
					'</div>' +
					'<div class="proposal-conflict-summary" id="proposal-conflict-summary" hidden></div>' +
					'<div class="modal-content" id="proposals-review-content">' +
					'<p class="center tag">Loading…</p>' +
					'</div>' +
					'<div class="modal-actions proposal-batch-actions" id="proposal-batch-actions" hidden>' +
					'<span class="proposal-batch-status" id="proposal-batch-status"></span>' +
					'<button type="button" class="button proposal-batch-apply" id="proposal-batch-apply">Apply reviewed changes</button>' +
					'</div>' +
					'</div>';
				document.body.appendChild(modal);
				modal
					.querySelectorAll('[data-pr-close]')
					.forEach((el) => el.addEventListener('click', () => modal.remove()));
				document.addEventListener('keydown', function _onEsc(ev) {
					if (ev.key === 'Escape') {
						modal.remove();
						document.removeEventListener('keydown', _onEsc);
					}
				});
				const autoToggle = modal.querySelector('.proposals-autoapply-toggle');
				if (autoToggle) {
					autoToggle.addEventListener('change', async () => {
						_setAutoApplyEnabled(canvasId, autoToggle.checked);

						if (autoToggle.checked) {
							await _refreshProposals();
							modal.remove();
						}
					});
				}

				try {
					const r = await csrfFetch('/api/canvas/' + encodeURIComponent(canvasId) + '/proposals', {
						credentials: 'same-origin',
					});
					if (!r.ok) {
						modal.querySelector('#proposals-review-content').innerHTML =
							'<div class="banner error">Could not load proposals (HTTP ' + r.status + ').</div>';
						return;
					}
					const data = await r.json();
					const proposals =
						data && Array.isArray(data.proposals)
							? data.proposals
									.slice()
									.sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0))
							: [];
					if (proposals.length === 0) {
						modal.querySelector('#proposals-review-content').innerHTML =
							'<p class="acct-empty">No pending proposals.</p>';
						return;
					}
					const html = proposals
						.map((proposal, index) =>
							_renderProposalCard(proposal, {
								batch: true,
								position: index + 1,
								total: proposals.length,
							}),
						)
						.join('');
					modal.querySelector('#proposals-review-content').innerHTML = html;

					const cards = Array.from(modal.querySelectorAll('.proposal-card'));
					const conflictGroups = _proposalConflictGroups(proposals);
					const conflictSummary = modal.querySelector('#proposal-conflict-summary');
					const batchActions = modal.querySelector('#proposal-batch-actions');
					const batchStatus = modal.querySelector('#proposal-batch-status');
					const batchApply = modal.querySelector('#proposal-batch-apply');
					let batchBusy = false;

					const indexesFor = (checkbox) =>
						String(checkbox.getAttribute('data-change-indexes') || '')
							.split(',')
							.map((value) => Number(value))
							.filter((value) => Number.isInteger(value));
					const controlForEntry = (entry) => {
						const card = cards.find(
							(item) => String(item.getAttribute('data-proposal-id')) === String(entry.proposalId),
						);
						if (!card) {
							return null;
						}
						return Array.from(card.querySelectorAll('.proposal-change-checkbox')).find((checkbox) =>
							indexesFor(checkbox).includes(entry.changeIndex),
						);
					};
					const conflictControls = conflictGroups.map((group) => ({
						group,
						controls: Array.from(
							new Set(group.entries.map((entry) => controlForEntry(entry)).filter(Boolean)),
						),
					}));

					if (conflictSummary && conflictGroups.length > 0) {
						conflictSummary.hidden = false;
						conflictSummary.innerHTML =
							'<strong>Resolve overlapping changes</strong>' +
							'<p>More than one proposal changes the same field or relationship. Deselect alternatives until only one remains for each item.</p>' +
							'<ul>' +
							conflictGroups.map((group) => '<li>' + escapeHtml(group.label) + '</li>').join('') +
							'</ul>';
					}

					const updateBatchState = () => {
						let selectedTotal = 0;
						let rowTotal = 0;
						cards.forEach((card) => {
							const checkboxes = Array.from(card.querySelectorAll('.proposal-change-checkbox'));
							const selected = checkboxes.filter((checkbox) => checkbox.checked).length;
							selectedTotal += selected;
							rowTotal += checkboxes.length;
							const countEl = card.querySelector('.proposal-selected-count');
							if (countEl) {
								countEl.textContent = selected + ' of ' + checkboxes.length + ' selected';
							}
						});

						let unresolved = 0;
						conflictControls.forEach(({ controls }) => {
							const selected = controls.filter((control) => control.checked);
							const isUnresolved = selected.length > 1;
							if (isUnresolved) {
								unresolved++;
							}
							controls.forEach((control) => {
								const row = control.closest('.proposal-change-row');
								if (row) {
									row.classList.add('proposal-change-row--conflict');
									row.classList.toggle(
										'proposal-change-row--conflict-active',
										isUnresolved && control.checked,
									);
									row.classList.toggle('proposal-change-row--conflict-resolved', !isUnresolved);
								}
							});
						});

						if (batchStatus) {
							batchStatus.textContent =
								unresolved > 0
									? unresolved + ' conflict' + (unresolved === 1 ? '' : 's') + ' still need a choice'
									: selectedTotal +
										' of ' +
										rowTotal +
										' proposal item' +
										(rowTotal === 1 ? '' : 's') +
										' selected';
						}
						if (batchApply) {
							batchApply.disabled = batchBusy || unresolved > 0;
							batchApply.textContent =
								selectedTotal === 0 ? 'Discard all proposals' : 'Apply reviewed changes';
						}
						return { selectedTotal, rowTotal, unresolved };
					};

					cards.forEach((card) => {
						const checkboxes = Array.from(card.querySelectorAll('.proposal-change-checkbox'));
						checkboxes.forEach((checkbox) => checkbox.addEventListener('change', updateBatchState));
						const selAll = card.querySelector('.proposal-select-all');
						if (selAll) {
							selAll.addEventListener('click', () => {
								checkboxes.forEach((checkbox) => {
									checkbox.checked = true;
								});
								updateBatchState();
							});
						}
						const selNone = card.querySelector('.proposal-select-none');
						if (selNone) {
							selNone.addEventListener('click', () => {
								checkboxes.forEach((checkbox) => {
									checkbox.checked = false;
								});
								updateBatchState();
							});
						}
					});

					if (batchActions) {
						batchActions.hidden = false;
					}
					updateBatchState();

					if (batchApply) {
						batchApply.addEventListener('click', async () => {
							const state = updateBatchState();
							if (batchBusy || state.unresolved > 0) {
								return;
							}
							const plans = cards.map((card) => {
								const checkboxes = Array.from(card.querySelectorAll('.proposal-change-checkbox'));
								const skipChangeIndexes = [];
								checkboxes.forEach((checkbox) => {
									if (!checkbox.checked) {
										indexesFor(checkbox).forEach((index) => skipChangeIndexes.push(index));
									}
								});
								return {
									proposalId: card.getAttribute('data-proposal-id'),
									selectedCount: checkboxes.filter((checkbox) => checkbox.checked).length,
									skipItemCount:
										checkboxes.length - checkboxes.filter((checkbox) => checkbox.checked).length,
									skipChangeIndexes: Array.from(new Set(skipChangeIndexes)),
								};
							});
							const discarded = plans.filter((plan) => plan.selectedCount === 0).length;
							const ok = await showConfirmDialog({
								title:
									state.selectedTotal === 0 ? 'Discard these proposals?' : 'Apply this review batch?',
								message:
									state.selectedTotal === 0
										? 'All pending proposals in this review will be discarded. Salesforce records will not be modified.'
										: state.selectedTotal +
											' selected proposal item' +
											(state.selectedTotal === 1 ? '' : 's') +
											' will land on the canvas' +
											(discarded > 0
												? '; ' +
													discarded +
													' proposal' +
													(discarded === 1 ? '' : 's') +
													' with no selected changes will be discarded'
												: '') +
											'. Nothing is written to Salesforce yet.',
								confirmLabel: state.selectedTotal === 0 ? 'Discard proposals' : 'Apply to canvas',
								cancelLabel: 'Cancel',
								danger: false,
							});
							if (!ok) {
								return;
							}

							batchBusy = true;
							updateBatchState();
							const batchUndoSnapshot = _captureProposalUndoSnapshot();
							const closeProgress = _showProposalApplyProgress(modal, {
								title: 'Applying proposal batch',
								message: 'Applying the reviewed changes to the canvas…',
							});
							let completed = 0;
							let succeeded = true;
							try {
								for (const plan of plans) {
									const settled =
										plan.selectedCount === 0
											? await _rejectProposal(canvasId, plan.proposalId, null, {
													skipConfirm: true,
													silentToast: true,
												})
											: await _applyProposal(canvasId, plan.proposalId, null, {
													skipConfirm: true,
													silentToast: true,
													skipUndo: true,
													skipChangeIndexes: plan.skipChangeIndexes,
													skipItemCount: plan.skipItemCount,
												});
									if (!settled) {
										succeeded = false;
										break;
									}
									completed++;
								}
							} finally {
								closeProgress();
							}

							if (completed > 0 && state.selectedTotal > 0) {
								_registerProposalUndo(
									batchUndoSnapshot,
									'AI proposal batch apply',
									'AI proposal batch undone.',
								);
							}
							modal.remove();
							await _refreshProposals();
							if (succeeded) {
								showBulkToast(
									state.selectedTotal === 0
										? 'Proposal batch discarded.'
										: state.selectedTotal +
												' reviewed proposal item' +
												(state.selectedTotal === 1 ? '' : 's') +
												' applied to the canvas.',
									'success',
								);
							} else if (completed > 0) {
								showBulkToast(
									'The batch stopped after ' +
										completed +
										' proposal' +
										(completed === 1 ? '' : 's') +
										'. Reopen the remaining proposals and review them again.',
									'error',
								);
							} else {
								showBulkToast(
									'The proposal batch could not be applied. Reopen the review and try again.',
									'error',
								);
							}
						});
					}
				} catch (e) {
					modal.querySelector('#proposals-review-content').innerHTML =
						'<div class="banner error">' + escapeHtml(e.message || String(e)) + '</div>';
				}
			}

			function _renderProposalCard(p, options) {
				options = options || {};
				const summary = p.summary ? '<p class="proposal-card-summary">' + escapeHtml(p.summary) + '</p>' : '';
				const ts = p.createdAt ? new Date(p.createdAt).toLocaleString() : '';
				const changes = Array.isArray(p.changes) ? p.changes : [];
				const _fmt = (v) => {
					if (v == null) {
						return '';
					}
					if (typeof v === 'object') {
						try {
							return JSON.stringify(v);
						} catch (_) {
							return String(v);
						}
					}
					return String(v);
				};

				const _newDraftRefIndex = new Map();
				for (const ch of changes) {
					if (ch && ch.kind === 'new-draft' && ch.tempRef) {
						_newDraftRefIndex.set(String(ch.tempRef), ch);
					}
				}
				const _canvasRecords = Array.isArray(canvasState.bulkRecords) ? canvasState.bulkRecords : [];
				const _salesforceIdsMatch = (left, right) => {
					if (left == null || right == null) {
						return false;
					}
					const a = String(left);
					const b = String(right);
					return a === b || (a.length >= 15 && b.length >= 15 && a.slice(0, 15) === b.slice(0, 15));
				};
				const _recordValues = (record) =>
					Object.assign({}, (record && record.loadedValues) || {}, (record && record.values) || {});
				const _canvasRecordForEndpoint = (ep) => {
					if (!ep || ep.ref == null) {
						return null;
					}
					if (ep.kind === 'loaded') {
						return (
							_canvasRecords.find(
								(record) =>
									record &&
									(_salesforceIdsMatch(record.loadedFromId, ep.ref) ||
										_salesforceIdsMatch(_recordValues(record).Id, ep.ref)),
							) || null
						);
					}
					if (ep.kind === 'draft') {
						return (
							_canvasRecords.find(
								(record) => record && !record.loadedFromId && String(record.id) === String(ep.ref),
							) || null
						);
					}
					return null;
				};
				const _recordDisplayName = (values, objectName) => {
					values = values && typeof values === 'object' ? values : {};
					const personName = [values.FirstName, values.LastName]
						.filter((value) => value != null && String(value).trim())
						.map((value) => String(value).trim())
						.join(' ');
					if (personName) {
						return personName;
					}
					const describe = canvasState.describeCache && canvasState.describeCache[objectName];
					const nameField =
						describe && Array.isArray(describe.fields)
							? describe.fields.find((field) => field && field.nameField)
							: null;
					if (nameField && values[nameField.name] != null && String(values[nameField.name]).trim()) {
						return String(values[nameField.name]).trim();
					}
					for (const field of ['Name', 'CaseNumber', 'OrderNumber', 'WorkOrderNumber', 'Subject', 'Title']) {
						if (values[field] != null && String(values[field]).trim()) {
							return String(values[field]).trim();
						}
					}
					return '';
				};
				const _recordIdentity = ({ objectName, values, id, idPrefix }) => {
					const name = _recordDisplayName(values, objectName);
					return (
						(objectName ? '<code class="proposal-object-type">' + escapeHtml(objectName) + '</code>' : '') +
						(name ? ' <strong class="proposal-record-name">' + escapeHtml(name) + '</strong>' : '') +
						(id != null && String(id)
							? ' <code class="tag">' + escapeHtml((idPrefix || '') + String(id)) + '</code>'
							: '')
					);
				};
				const _recordHeadingForEndpoint = (ep) => {
					const record = _canvasRecordForEndpoint(ep);
					if (record) {
						return _recordIdentity({
							objectName: record.objectName,
							values: _recordValues(record),
							id: ep.ref,
							idPrefix: ep.kind === 'draft' ? 'Draft #' : '',
						});
					}
					if (ep && ep.kind === 'tempRef') {
						const draft = _newDraftRefIndex.get(String(ep.ref));
						if (draft) {
							return _recordIdentity({
								objectName: draft.objectName,
								values: draft.fields,
								id: 'New record',
							});
						}
					}
					return '';
				};
				const _recordHeadingForChange = (change) => {
					if (!change) {
						return '';
					}
					if (change.kind === 'new-draft') {
						return _recordIdentity({ objectName: change.objectName, values: change.fields });
					}
					const isDraft = change.kind === 'draft' || change.kind === 'delete-draft';
					const id = isDraft ? change.tempId : change.recordId;
					const endpoint = id == null ? null : { kind: isDraft ? 'draft' : 'loaded', ref: id };
					const record = _canvasRecordForEndpoint(endpoint);
					return _recordIdentity({
						objectName: change.objectName || (record && record.objectName),
						values: record && _recordValues(record),
						id,
						idPrefix: isDraft ? 'Draft #' : '',
					});
				};
				const _epLabel = (ep) => {
					if (!ep) {
						return '?';
					}
					const identity = _recordHeadingForEndpoint(ep);
					if (identity) {
						return identity;
					}
					if (ep.kind === 'loaded') {
						return '<code>' + escapeHtml(String(ep.ref)) + '</code>';
					}
					if (ep.kind === 'draft') {
						return 'Draft #<code>' + escapeHtml(String(ep.ref)) + '</code>';
					}
					if (ep.kind === 'tempRef') {
						const draft = _newDraftRefIndex.get(String(ep.ref));
						return draft
							? 'New <code>' + escapeHtml(draft.objectName || 'record') + '</code> (this proposal)'
							: 'New record (this proposal)';
					}
					return escapeHtml(JSON.stringify(ep));
				};
				const _endpointKey = (ep) => {
					if (!ep || ep.ref == null) {
						return null;
					}
					if (ep.kind === 'loaded') {
						return 'record:' + String(ep.ref);
					}
					if (ep.kind === 'draft') {
						return 'draft:' + String(ep.ref);
					}
					if (ep.kind === 'tempRef') {
						return 'tempRef:' + String(ep.ref);
					}
					return null;
				};
				const _changeTargetKey = (change) => {
					if (!change) {
						return null;
					}
					if (change.kind === 'new-draft' && change.tempRef != null) {
						return 'tempRef:' + String(change.tempRef);
					}
					if (change.kind === 'draft' && change.tempId != null) {
						return 'draft:' + String(change.tempId);
					}
					if ((change.kind === 'record' || change.kind === 'load-record') && change.recordId != null) {
						return 'record:' + String(change.recordId);
					}
					return null;
				};

				const _wrapChangeRow = (indexes, innerHtml) =>
					'<label class="proposal-change-row">' +
					'<input type="checkbox" class="proposal-change-checkbox" ' +
					'data-change-indexes="' +
					indexes.join(',') +
					'" checked>' +
					'<div class="proposal-change-body">' +
					innerHtml +
					'</div>' +
					'</label>';
				const basePlanByTarget = new Map();
				const rowPlans = [];
				changes.forEach((change, index) => {
					if (change.kind === 'new-association' || change.kind === 'delete-association') {
						return;
					}
					const plan = { baseIndex: index, relationshipIndexes: [] };
					rowPlans.push(plan);
					const targetKey = _changeTargetKey(change);
					if (targetKey && !basePlanByTarget.has(targetKey)) {
						basePlanByTarget.set(targetKey, plan);
					}
				});

				const relationshipOnlyPlans = new Map();
				changes.forEach((change, index) => {
					if (change.kind !== 'new-association' && change.kind !== 'delete-association') {
						return;
					}
					const childKey = _endpointKey(change.from);
					const basePlan = childKey ? basePlanByTarget.get(childKey) : null;
					if (basePlan) {
						basePlan.relationshipIndexes.push(index);
						return;
					}
					const groupKey = childKey || 'association:' + index;
					let plan = relationshipOnlyPlans.get(groupKey);
					if (!plan) {
						plan = { baseIndex: null, relationshipIndexes: [], child: change.from };
						relationshipOnlyPlans.set(groupKey, plan);
						rowPlans.push(plan);
					}
					plan.relationshipIndexes.push(index);
				});
				const _currentRelationshipParentLabel = (relationship) => {
					const child = _canvasRecordForEndpoint(relationship && relationship.from);
					if (!child || !Array.isArray(canvasState.bulkAssociations)) {
						return '';
					}
					const association = canvasState.bulkAssociations.find(
						(candidate) =>
							candidate &&
							candidate.fromId === child.id &&
							candidate.fieldName === relationship.fieldName,
					);
					if (!association) {
						return '';
					}
					const parent = _canvasRecords.find((record) => record && record.id === association.toId);
					if (!parent) {
						return '<code>' + escapeHtml(String(association.toId)) + '</code>';
					}
					return _recordIdentity({
						objectName: parent.objectName,
						values: _recordValues(parent),
						id: parent.loadedFromId || (parent.values && parent.values.Id) || parent.id,
						idPrefix: parent.loadedFromId || (parent.values && parent.values.Id) ? '' : 'Draft #',
					});
				};

				const _relationshipFieldRows = (relationshipIndexes, isNewDraft) =>
					relationshipIndexes
						.map((index) => {
							const relationship = changes[index];
							const isAdd = relationship.kind === 'new-association';
							const fieldCell =
								'<td><code>' +
								escapeHtml(relationship.fieldName || '') +
								'</code> <span class="tag">relationship</span></td>';
							const parentCell = _epLabel(relationship.to);
							if (isNewDraft) {
								return '<tr>' + fieldCell + '<td class="proposal-new">' + parentCell + '</td></tr>';
							}
							const currentParentCell = isAdd
								? _currentRelationshipParentLabel(relationship)
								: parentCell;
							return (
								'<tr>' +
								fieldCell +
								(isAdd
									? (currentParentCell
											? '<td class="proposal-old">' + currentParentCell + '</td>'
											: '<td class="proposal-old proposal-old--empty">—</td>') +
										'<td class="proposal-new">' +
										parentCell +
										'</td>'
									: '<td class="proposal-old">' +
										parentCell +
										'</td><td class="proposal-new proposal-old--empty">Not linked</td>') +
								'</tr>'
							);
						})
						.join('');

				const changeRows = rowPlans
					.map((plan) => {
						const idx = plan.baseIndex;
						const c = idx == null ? null : changes[idx];
						const changeIndexes =
							idx == null ? [...plan.relationshipIndexes] : [idx, ...plan.relationshipIndexes];
						if (!c) {
							return _wrapChangeRow(
								changeIndexes,
								'<div class="proposal-record">' +
									'<div class="proposal-record-head">' +
									_epLabel(plan.child) +
									'</div>' +
									'<table class="proposal-fields">' +
									'<thead><tr><th>Field</th><th>Old value</th><th>New value</th></tr></thead>' +
									'<tbody>' +
									_relationshipFieldRows(plan.relationshipIndexes, false) +
									'</tbody></table></div>',
							);
						}
						if (c.kind === 'delete-draft' || c.kind === 'delete-record') {
							const isDraftDel = c.kind === 'delete-draft';
							const chip =
								'<span class="proposal-kind-chip proposal-kind-chip--record" title="Remove from the canvas. Salesforce records are NOT deleted; this only removes the canvas reference.">− remove</span>';
							const target = _recordHeadingForChange(c);
							const note = isDraftDel
								? 'The draft is removed from the canvas; any associations touching it are dropped too.'
								: 'The reference is removed from the canvas + its associations are dropped. The Salesforce record itself is NOT deleted.';
							return _wrapChangeRow(
								changeIndexes,
								'<div class="proposal-record">' +
									'<div class="proposal-record-head">' +
									target +
									' ' +
									chip +
									'</div>' +
									'<p class="tag" style="margin:0.2em 0 0">' +
									note +
									'</p>' +
									'</div>',
							);
						}
						if (c.kind === 'autofill-required') {
							const ids = Array.isArray(c.tempIds) ? c.tempIds : [];
							const scope =
								ids.length === 0
									? 'every draft on the canvas'
									: ids.length +
										' draft' +
										(ids.length === 1 ? '' : 's') +
										' (tempIds: ' +
										ids.join(', ') +
										')';
							const chip =
								'<span class="proposal-kind-chip proposal-kind-chip--new" title="Fill required fields with sample values on the listed drafts. Same logic as the Bulk Operations → Fill required fields button.">✨ autofill</span>';
							return _wrapChangeRow(
								changeIndexes,
								'<div class="proposal-record">' +
									'<div class="proposal-record-head">' +
									chip +
									'</div>' +
									'<p class="tag" style="margin:0.2em 0 0">Auto-fill required fields on ' +
									escapeHtml(scope) +
									'. Picklists pick a real option; lookups use smart defaults where known. Fields already populated are left untouched.</p>' +
									'</div>',
							);
						}
						if (c.kind === 'load-record') {
							const chip =
								'<span class="proposal-kind-chip proposal-kind-chip--new" title="Load an existing Salesforce record onto the canvas. Triggers a Salesforce read on apply via your active connection.">↓ load</span>';
							const fieldsNote =
								Array.isArray(c.fields) && c.fields.length > 0
									? ' Loading just these fields: <code>' +
										escapeHtml(c.fields.join(', ')) +
										'</code>.'
									: '';
							return _wrapChangeRow(
								changeIndexes,
								'<div class="proposal-record">' +
									'<div class="proposal-record-head">' +
									_recordHeadingForChange(c) +
									' ' +
									chip +
									'</div>' +
									'<p class="tag" style="margin:0.2em 0 0">Fetch this record from Salesforce via your active connection and add it to the canvas.' +
									fieldsNote +
									'</p>' +
									(plan.relationshipIndexes.length
										? '<table class="proposal-fields"><thead><tr><th>Field</th><th>Old value</th><th>New value</th></tr></thead><tbody>' +
											_relationshipFieldRows(plan.relationshipIndexes, false) +
											'</tbody></table>'
										: '') +
									'</div>',
							);
						}
						const fields = c.fields && typeof c.fields === 'object' ? c.fields : {};
						const oldValues = c.oldValues && typeof c.oldValues === 'object' ? c.oldValues : {};
						const fieldKeys = Object.keys(fields).filter((k) => _fmt(oldValues[k]) !== _fmt(fields[k]));
						const fieldRows = fieldKeys
							.map((k) => {
								const oldRaw = oldValues[k];
								const oldStr = _fmt(oldRaw);
								const newStr = _fmt(fields[k]);
								const oldCell =
									oldStr === ''
										? '<td class="proposal-old proposal-old--empty">—</td>'
										: '<td class="proposal-old">' + escapeHtml(oldStr) + '</td>';
								const newCell = '<td class="proposal-new">' + escapeHtml(newStr) + '</td>';
								return (
									'<tr>' + '<td><code>' + escapeHtml(k) + '</code></td>' + oldCell + newCell + '</tr>'
								);
							})
							.join('');

						const isNewDraft = c.kind === 'new-draft';
						const kind = isNewDraft ? 'new-draft' : c.kind === 'draft' ? 'draft' : 'record';
						const kindChip = isNewDraft
							? '<span class="proposal-kind-chip proposal-kind-chip--new" title="Brand-new draft record. On Apply, a fresh draft appears on the canvas with these field values.">+ new draft</span>'
							: kind === 'draft'
								? '<span class="proposal-kind-chip proposal-kind-chip--draft" title="Draft on the canvas, not yet uploaded to Salesforce">draft</span>'
								: '<span class="proposal-kind-chip proposal-kind-chip--record" title="Loaded Salesforce record on the canvas; Apply updates the canvas, not Salesforce">SF record</span>';

						const tableHeaders = isNewDraft
							? '<thead><tr><th>Field</th><th>Value</th></tr></thead>'
							: '<thead><tr><th>Field</th><th>Old value</th><th>New value</th></tr></thead>';
						const tableBody = isNewDraft
							? Object.keys(fields)
									.map(
										(k) =>
											'<tr>' +
											'<td><code>' +
											escapeHtml(k) +
											'</code></td>' +
											'<td class="proposal-new">' +
											escapeHtml(_fmt(fields[k])) +
											'</td>' +
											'</tr>',
									)
									.join('') + _relationshipFieldRows(plan.relationshipIndexes, true)
							: fieldRows + _relationshipFieldRows(plan.relationshipIndexes, false);
						return _wrapChangeRow(
							changeIndexes,
							'<div class="proposal-record">' +
								'<div class="proposal-record-head">' +
								_recordHeadingForChange(c) +
								' ' +
								kindChip +
								'</div>' +
								'<table class="proposal-fields">' +
								tableHeaders +
								'<tbody>' +
								tableBody +
								'</tbody>' +
								'</table>' +
								'</div>',
						);
					})
					.join('');
				return (
					'<div class="proposal-card" data-proposal-id="' +
					escapeHtml(p.id) +
					'">' +
					'<div class="proposal-card-head">' +
					'<div>' +
					'<strong>Proposal' +
					(options.total > 1 ? ' ' + options.position + ' of ' + options.total : '') +
					'</strong> ' +
					'<span class="tag">' +
					escapeHtml(ts) +
					'</span> ' +
					'<span class="tag proposal-selected-count">' +
					rowPlans.length +
					' of ' +
					rowPlans.length +
					' selected' +
					'</span>' +
					'</div>' +
					'<div class="proposal-card-actions">' +
					'<button type="button" class="link-button proposal-select-all">Select all</button>' +
					'<button type="button" class="link-button proposal-select-none">None</button>' +
					(options.batch
						? ''
						: '<button type="button" class="button secondary proposal-card-reject" data-proposal-id="' +
							escapeHtml(p.id) +
							'">Reject</button>' +
							'<button type="button" class="button proposal-card-apply" data-proposal-id="' +
							escapeHtml(p.id) +
							'">Apply selected</button>') +
					'</div>' +
					'</div>' +
					summary +
					'<div class="proposal-card-changes">' +
					changeRows +
					'</div>' +
					'</div>'
				);
			}

			function _captureProposalUndoSnapshot() {
				if (!pushUndo) {
					return null;
				}
				const snapshot = {
					selectedObjects: structuredClone(canvasState.selectedObjects || []),
					selectedIdSeq: canvasState.selectedIdSeq,
					activeIndex: canvasState.activeIndex,
					hiddenObjects: new Set(canvasState.hiddenObjects || []),
					bulkRecords: structuredClone(canvasState.bulkRecords || []),
					bulkAssociations: structuredClone(canvasState.bulkAssociations || []),
					bulkIdSeq: canvasState.bulkIdSeq,
					bulkInitialized: canvasState.bulkInitialized,
				};
				snapshot.fingerprint = _proposalCanvasFingerprint();
				return snapshot;
			}

			function _proposalCanvasFingerprint() {
				return JSON.stringify({
					selectedObjects: canvasState.selectedObjects || [],
					hiddenObjects: Array.from(canvasState.hiddenObjects || []).sort(),
					bulkRecords: canvasState.bulkRecords || [],
					bulkAssociations: canvasState.bulkAssociations || [],
				});
			}

			function _registerProposalUndo(snapshot, label, successMessage) {
				if (!snapshot || !pushUndo) {
					return;
				}
				const appliedFingerprint = _proposalCanvasFingerprint();
				if (snapshot.fingerprint === appliedFingerprint) {
					return;
				}
				pushUndo(label, function () {
					if (_proposalCanvasFingerprint() !== appliedFingerprint) {
						showBulkToast('Can’t undo the AI proposal because the canvas was edited afterward.', 'info');
						return false;
					}
					canvasState.selectedObjects = snapshot.selectedObjects;
					canvasState.selectedIdSeq = snapshot.selectedIdSeq;
					canvasState.activeIndex = snapshot.activeIndex;
					canvasState.hiddenObjects.clear();
					snapshot.hiddenObjects.forEach((value) => canvasState.hiddenObjects.add(value));
					canvasState.bulkRecords = snapshot.bulkRecords;
					canvasState.bulkAssociations = snapshot.bulkAssociations;
					canvasState.bulkIdSeq = snapshot.bulkIdSeq;
					canvasState.bulkInitialized = snapshot.bulkInitialized;
					canvasState.bulkSelectedIds = new Set();
					canvasState.bulkSelectedEdgeId = null;
					renderBulkView();
					showBulkToast(successMessage);
				});
			}

			function _showProposalApplyProgress(reviewModal, options) {
				options = options || {};
				if (reviewModal) {
					reviewModal.setAttribute('aria-hidden', 'true');
					reviewModal.setAttribute('inert', '');
				}
				const progressModal = document.createElement('div');
				progressModal.className = 'modal app-confirm-modal proposal-apply-progress-modal';
				progressModal.innerHTML =
					'<div class="modal-overlay"></div>' +
					'<div class="modal-body" style="max-width:440px" aria-busy="true">' +
					'<div class="modal-header"><h3>' +
					escapeHtml(options.title || 'Applying proposal') +
					'</h3></div>' +
					'<div class="modal-content" role="status" aria-live="polite">' +
					'<p class="center busy-row" style="justify-content:center">' +
					'<span class="busy-spinner" aria-hidden="true"></span>' +
					'<span>' +
					escapeHtml(options.message || 'Applying the selected changes to the canvas…') +
					'</span>' +
					'</p>' +
					'</div>' +
					'</div>';
				document.body.appendChild(progressModal);
				return function closeProgress() {
					progressModal.remove();
					if (reviewModal && reviewModal.isConnected) {
						reviewModal.removeAttribute('aria-hidden');
						reviewModal.removeAttribute('inert');
					}
				};
			}

			async function _applyProposal(canvasId, proposalId, modal, opts) {
				opts = opts || {};
				const skipChangeIndexes = Array.isArray(opts.skipChangeIndexes) ? opts.skipChangeIndexes : [];
				const skipCount = Number.isInteger(opts.skipItemCount) ? opts.skipItemCount : skipChangeIndexes.length;
				let closeProgress = null;
				let settled = false;

				if (!opts.skipConfirm) {
					const ok = await showConfirmDialog({
						title: 'Apply this proposal to the canvas?',
						message:
							skipCount > 0
								? skipCount +
									' change' +
									(skipCount === 1 ? '' : 's') +
									' will be skipped. The rest will land on the canvas; nothing is written to Salesforce yet.'
								: 'The proposed values will land on the canvas; nothing is written to Salesforce yet. To push to Salesforce, save and upload the canvas as you would any other change.',
						confirmLabel: skipCount > 0 ? 'Apply selected' : 'Apply to canvas',
						cancelLabel: 'Cancel',
						danger: false,
					});
					if (!ok) {
						return false;
					}
					closeProgress = _showProposalApplyProgress(modal);
				}
				const undoSnapshot = opts.skipUndo ? null : _captureProposalUndoSnapshot();
				try {
					const r = await csrfFetch(
						'/api/canvas/' +
							encodeURIComponent(canvasId) +
							'/proposals/' +
							encodeURIComponent(proposalId) +
							'/apply',
						{
							method: 'POST',
							credentials: 'same-origin',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify(skipChangeIndexes.length ? { skipChangeIndexes } : {}),
						},
					);
					if (!r.ok) {
						const body = await r.json().catch(() => ({}));
						showBulkToast((body && body.error) || 'Could not apply (HTTP ' + r.status + ').', 'error');
						return false;
					}
					const data = await r.json();
					settled = true;
					const results = data && Array.isArray(data.results) ? data.results : [];
					const applied = results.filter((x) => x.status === 'applied').length;
					const failed = results.filter((x) => x.status === 'failed');
					const skipped = results.filter((x) => x.status === 'skipped').length;
					let msg = applied + ' applied';
					if (skipped) {
						msg += ', ' + skipped + ' skipped';
					}
					if (failed.length) {
						msg += ', ' + failed.length + ' failed';
					}

					if (failed.length || !opts.silentToast) {
						showBulkToast(msg, failed.length ? 'error' : 'success');
					}
					if (modal) {
						modal.remove();
					}
					_refreshProposals();

					const _localId =
						(canvasState.currentCanvas && canvasState.currentCanvas.id) || _proposalsPollCanvasId();
					// Apply results only when the proposal still belongs to the open canvas.
					if (canvasId && _localId === canvasId) {
						let touched = false;

						const STEP_X = 260;
						const STEP_Y = 170;
						const PER_ROW = 5;
						const _canvasEl = document.querySelector('#bulk-canvas');
						const _cw = (_canvasEl && _canvasEl.clientWidth) || 0;
						const _ch = (_canvasEl && _canvasEl.clientHeight) || 0;
						const _baseX = 80;
						let _baseY = 80;
						for (const rr of canvasState.bulkRecords) {
							if (typeof rr.y === 'number' && rr.y + STEP_Y > _baseY) {
								_baseY = rr.y + STEP_Y;
							}
						}

						if (canvasState.bulkRecords.length === 0) {
							_baseY = _ch > 0 ? _ch / 2 : 400;
						}
						let _newDraftSlot = 0;
						function _placeNewDraft(objectName) {
							const siblings = canvasState.bulkRecords.filter((r) => r.objectName === objectName);
							if (siblings.length > 0) {
								const anchor = siblings[0];
								const idx = siblings.length;
								const col = idx % PER_ROW;
								const r = Math.floor(idx / PER_ROW);
								return {
									x: anchor.x + col * STEP_X,
									y: anchor.y + r * STEP_Y,
								};
							}
							const slot = _newDraftSlot++;
							const col = slot % PER_ROW;
							const row = Math.floor(slot / PER_ROW);
							const baseX = _cw > 0 ? Math.max(_baseX, _cw / 2 - ((PER_ROW - 1) * STEP_X) / 2) : _baseX;
							return {
								x: baseX + col * STEP_X,
								y: _baseY + row * STEP_Y,
							};
						}

						const tempIdToRuntimeId = new Map();

						const _addResultCount = results.filter(
							(r) => r && r.status === 'applied' && (r.kind === 'new-draft' || r.kind === 'load-record'),
						).length;
						const _cap = canvasCapCheck(_addResultCount);
						if (_cap.blocked) {
							showBulkToast(_cap.reason, 'error');
							return true;
						}

						function _canonicalizeFields(objectName, fields) {
							// Normalize model-supplied field casing against the current Salesforce describe.
							if (!fields || typeof fields !== 'object') {
								return {};
							}
							const describe = canvasState.describeCache[objectName];
							const fieldList = describe && Array.isArray(describe.fields) ? describe.fields : null;
							if (!fieldList || fieldList.length === 0) {
								return Object.assign({}, fields);
							}
							const byLower = new Map();
							for (const f of fieldList) {
								if (f && typeof f.name === 'string') {
									byLower.set(f.name.toLowerCase(), f.name);
								}
							}
							const out = {};
							for (const k of Object.keys(fields)) {
								const canon = byLower.get(k.toLowerCase()) || k;
								out[canon] = fields[k];
							}
							return out;
						}

						for (const result of results) {
							if (result.status !== 'applied') {
								continue;
							}
							const rawFields = result.fields && typeof result.fields === 'object' ? result.fields : {};
							if (result.kind === 'new-draft') {
								try {
									let sel = canvasState.selectedObjects.find((so) => so.name === result.objectName);
									if (!sel) {
										sel = await addToSelection(result.objectName);
									}
									if (!sel) {
										continue;
									}

									try {
										await ensureDescribe(sel.name);
									} catch (_) {}
									const fields = _canonicalizeFields(sel.name, rawFields);
									const pos = _placeNewDraft(sel.name);
									const runtimeId = canvasState.bulkIdSeq++;
									canvasState.bulkRecords.push({
										id: runtimeId,
										objectName: sel.name,
										label: sel.label || result.objectName,
										x: pos.x,
										y: pos.y,
										values: Object.assign({}, fields),
										fromSelectionId: sel.id,
									});
									if (result.tempId != null) {
										tempIdToRuntimeId.set(result.tempId, runtimeId);
									}
									touched = true;
								} catch (addErr) {
									console.warn('[proposal-apply] could not add new-draft locally:', addErr);
								}
							} else if (result.kind === 'draft') {
								const tempId = result.tempId != null ? result.tempId : result.targetId;
								const runtimeId = tempIdToRuntimeId.has(tempId)
									? tempIdToRuntimeId.get(tempId)
									: tempId;
								const rec = canvasState.bulkRecords.find(
									(r) => String(r.id) === String(runtimeId) && !r.loadedFromId,
								);
								if (rec) {
									try {
										await ensureDescribe(rec.objectName);
									} catch (_) {}
									const fields = _canonicalizeFields(rec.objectName, rawFields);
									rec.values = Object.assign({}, rec.values || {}, fields);
									touched = true;
								}
							} else if (result.kind === 'record') {
								const recordId = result.recordId != null ? result.recordId : result.targetId;
								const key = recordId == null ? null : String(recordId);
								if (key) {
									const rec = canvasState.bulkRecords.find((r) => {
										const id = (r.values && r.values.Id) || r.loadedFromId;
										return id && String(id) === key;
									});
									if (rec) {
										try {
											await ensureDescribe(rec.objectName);
										} catch (_) {}
										const fields = _canonicalizeFields(rec.objectName, rawFields);
										rec.values = Object.assign({}, rec.values || {}, fields);
										touched = true;
									}
								}
							} else if (result.kind === 'delete-draft') {
								const tempId = result.tempId != null ? result.tempId : result.targetId;
								const before = canvasState.bulkRecords.length;
								canvasState.bulkRecords = canvasState.bulkRecords.filter(
									(r) => !(r.id === tempId && !r.loadedFromId),
								);

								canvasState.bulkAssociations = canvasState.bulkAssociations.filter(
									(a) => a.fromId !== tempId && a.toId !== tempId,
								);
								if (canvasState.bulkRecords.length !== before) {
									if (canvasState.bulkSelectedIds && canvasState.bulkSelectedIds.delete) {
										canvasState.bulkSelectedIds.delete(tempId);
									}
									touched = true;
								}
							} else if (result.kind === 'delete-record') {
								const recordId = result.recordId != null ? result.recordId : result.targetId;
								const key = recordId == null ? null : String(recordId);
								if (key) {
									const rec = canvasState.bulkRecords.find((r) => {
										const id = (r.values && r.values.Id) || r.loadedFromId;
										return id && String(id) === key;
									});
									if (rec) {
										const runtimeId = rec.id;
										canvasState.bulkRecords = canvasState.bulkRecords.filter((r) => r !== rec);
										canvasState.bulkAssociations = canvasState.bulkAssociations.filter(
											(a) => a.fromId !== runtimeId && a.toId !== runtimeId,
										);
										if (canvasState.bulkSelectedIds && canvasState.bulkSelectedIds.delete) {
											canvasState.bulkSelectedIds.delete(runtimeId);
										}
										touched = true;
									}
								}
							} else if (result.kind === 'autofill-required') {
								try {
									const requestedTempIds = Array.isArray(result.tempIds) ? result.tempIds : [];
									const didFill = await bulkAutoFill('required', 'both', {
										tempIds: requestedTempIds,
										silent: true,
									});
									if (didFill) {
										touched = true;
									}
								} catch (autofillErr) {
									console.warn('[proposal-apply] autofill failed:', autofillErr);
								}
							} else if (result.kind === 'load-record') {
								try {
									let sel = canvasState.selectedObjects.find((so) => so.name === result.objectName);
									if (!sel) {
										sel = await addToSelection(result.objectName);
									}
									if (!sel) {
										continue;
									}
									const values =
										result.values && typeof result.values === 'object' ? result.values : {};
									const pos = _placeNewDraft(sel.name);
									canvasState.bulkRecords.push({
										id: canvasState.bulkIdSeq++,
										objectName: sel.name,
										label: sel.label || result.objectName,
										x: pos.x,
										y: pos.y,
										values: Object.assign({}, values),
										loadedFromId: result.recordId,
										loadedValues: Object.assign({}, values),
										fromSelectionId: sel.id,
									});
									touched = true;
								} catch (loadErr) {
									console.warn('[proposal-apply] load-record failed:', loadErr);
								}
							}
						}

						function _resolveAssocEndpoint(ep) {
							if (!ep || typeof ep !== 'object') {
								return null;
							}
							if (ep.kind === 'loaded') {
								const key = String(ep.ref);
								const rec = canvasState.bulkRecords.find((r) => {
									const id = (r.values && r.values.Id) || r.loadedFromId;
									return id && String(id) === key;
								});
								return rec ? rec.id : null;
							}
							if (ep.kind === 'draft') {
								if (tempIdToRuntimeId.has(ep.ref)) {
									return tempIdToRuntimeId.get(ep.ref);
								}
								const rec = canvasState.bulkRecords.find((r) => r.id === ep.ref && !r.loadedFromId);
								return rec ? rec.id : null;
							}
							return null;
						}
						for (const result of results) {
							if (result.status !== 'applied') {
								continue;
							}
							if (result.kind === 'new-association') {
								const fromId = _resolveAssocEndpoint(result.from);
								const toId = _resolveAssocEndpoint(result.to);
								if (fromId == null || toId == null) {
									continue;
								}
								const fieldName = result.fieldName;
								const upsert = _upsertSingleLookupAssociation(canvasState.bulkAssociations, {
									id: canvasState.bulkIdSeq,
									fromId,
									toId,
									fieldName,
								});
								if (upsert.changed) {
									canvasState.bulkAssociations = upsert.associations;
									if (upsert.inserted) {
										canvasState.bulkIdSeq++;
									}
									touched = true;
								}
								if (_syncLookupFieldValue(canvasState.bulkRecords, fromId, toId, fieldName)) {
									touched = true;
								}
							} else if (result.kind === 'delete-association') {
								const fromId = _resolveAssocEndpoint(result.from);
								const toId = _resolveAssocEndpoint(result.to);
								if (fromId == null || toId == null) {
									continue;
								}
								const fieldName = result.fieldName;
								const before = canvasState.bulkAssociations.length;
								canvasState.bulkAssociations = canvasState.bulkAssociations.filter(
									(a) => !(a.fromId === fromId && a.toId === toId && a.fieldName === fieldName),
								);
								if (canvasState.bulkAssociations.length !== before) {
									touched = true;
								}
							}
						}
						if (touched) {
							_registerProposalUndo(undoSnapshot, 'AI proposal apply', 'AI proposal apply undone.');
							try {
								renderBulkView();
							} catch (renderErr) {
								console.warn('[proposal-apply] re-render failed:', renderErr);
							}
						}
					}
				} catch (e) {
					showBulkToast('Could not apply: ' + (e.message || e), 'error');
					return false;
				} finally {
					if (closeProgress) {
						closeProgress();
					}
				}
				return settled;
			}

			async function _rejectProposal(canvasId, proposalId, modal, options) {
				options = options || {};
				if (!options.skipConfirm) {
					const ok = await showConfirmDialog({
						title: 'Reject this proposal?',
						message: 'The proposed changes will be discarded. Salesforce records will not be modified.',
						confirmLabel: 'Reject',
						cancelLabel: 'Cancel',
						danger: false,
					});
					if (!ok) {
						return false;
					}
				}
				try {
					const r = await csrfFetch(
						'/api/canvas/' +
							encodeURIComponent(canvasId) +
							'/proposals/' +
							encodeURIComponent(proposalId) +
							'/reject',
						{ method: 'POST', credentials: 'same-origin' },
					);
					if (!r.ok) {
						const body = await r.json().catch(() => ({}));
						if (!options.silentToast) {
							showBulkToast((body && body.error) || 'Could not reject (HTTP ' + r.status + ').', 'error');
						}
						return false;
					}
					if (modal) {
						modal.remove();
					}
					_refreshProposals();
					return true;
				} catch (e) {
					if (!options.silentToast) {
						showBulkToast('Could not reject: ' + (e.message || e), 'error');
					}
					return false;
				}
			}

			return {
				getPollCanvasId: _proposalsPollCanvasId,
				openProposalsReview: _openProposalsReview,
				renderProposalCard: _renderProposalCard,
				proposalConflictGroups: _proposalConflictGroups,
				syncLookupFieldValue: _syncLookupFieldValue,
				upsertSingleLookupAssociation: _upsertSingleLookupAssociation,
				refreshProposals: _refreshProposals,
				watchProposalsForCurrentCanvas: _watchProposalsForCurrentCanvas,
			};
		},
	};
})();

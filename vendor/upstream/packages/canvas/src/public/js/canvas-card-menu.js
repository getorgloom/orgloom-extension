(function () {
	'use strict';
	// Hosts record-card actions, relationship field choices, and contributor slot configuration.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.canvasCardMenu = {
		mount: function mount(deps) {
			const required = [
				'canvasState',
				'csrfFetch',
				'escapeHtml',
				'renderBulkView',
				'recordOrdinal',
				'showBulkToast',
				'showConfirmDialog',
				'canEditCanvasStructure',
				'_canAuthorSlots',
				'_hasCap',
				'openInsertModal',
				'convertRecordToFieldSlot',
				'configureExistingSlot',
				'convertSlotBackToRecord',
				'refreshRecordFromSf',
				'deleteRecord',
				'markPendingDelete',
				'unmarkPendingDelete',
				'attachSfUserPicker',
				'_fillSlotWithSfRecord',
			];
			if (!deps) {
				throw new Error('canvas-card-menu.mount: missing deps object');
			}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('canvas-card-menu.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			const renderBulkView = deps.renderBulkView;
			const recordOrdinal = deps.recordOrdinal;
			const showBulkToast = deps.showBulkToast;
			const showConfirmDialog = deps.showConfirmDialog;
			const promptCanvasSave = deps.promptCanvasSave;
			const canEditCanvasStructure = deps.canEditCanvasStructure;
			const _canAuthorSlots = deps._canAuthorSlots;
			const canDeleteRecord =
				typeof deps.canDeleteRecord === 'function'
					? deps.canDeleteRecord
					: function () {
							return false;
						};
			const _hasCap = deps._hasCap;
			const openInsertModal = deps.openInsertModal;
			const convertRecordToFieldSlot = deps.convertRecordToFieldSlot;
			const configureExistingSlot = deps.configureExistingSlot;
			const convertSlotBackToRecord = deps.convertSlotBackToRecord;
			const refreshRecordFromSf = deps.refreshRecordFromSf;
			const deleteRecord = deps.deleteRecord;
			const markPendingDelete = deps.markPendingDelete;
			const unmarkPendingDelete = deps.unmarkPendingDelete;
			const attachSfUserPicker = deps.attachSfUserPicker;
			const _fillSlotWithSfRecord = deps._fillSlotWithSfRecord;

			function showFieldPicker(clientX, clientY, options, srcRec, targetRec, onPick) {
				document.querySelectorAll('.field-picker').forEach((el) => el.remove());
				const pop = document.createElement('div');
				pop.className = 'field-picker';
				const x = Math.min(clientX, window.innerWidth - 260);
				const y = Math.min(clientY, window.innerHeight - (options.length * 36 + 80));
				pop.style.left = Math.max(8, x) + 'px';
				pop.style.top = Math.max(8, y) + 'px';
				pop.innerHTML =
					'<div class="field-picker-header">Pick reference field</div>' +
					options
						.map((o, i) => {
							const holderRec = o.direction === 'fwd' ? srcRec : targetRec;
							const holderLabel = '#' + recordOrdinal(holderRec) + ' ' + holderRec.label;
							return (
								'<button type="button" data-idx="' +
								i +
								'">' +
								escapeHtml(o.fieldName) +
								'<span class="fp-hint">on ' +
								escapeHtml(holderLabel) +
								'</span>' +
								'</button>'
							);
						})
						.join('') +
					'<button type="button" class="fp-cancel">Cancel</button>';
				document.body.appendChild(pop);
				const cleanup = () => {
					pop.remove();
					document.removeEventListener('mousedown', outside, true);
					document.removeEventListener('keydown', onEsc, true);
				};
				pop.querySelectorAll('button[data-idx]').forEach((b) => {
					b.addEventListener('click', () => {
						const idx = parseInt(b.dataset.idx, 10);
						cleanup();
						onPick(options[idx]);
					});
				});
				pop.querySelector('.fp-cancel').addEventListener('click', () => {
					cleanup();
					renderBulkView();
				});
				const outside = (e) => {
					if (!pop.contains(e.target)) {
						cleanup();
						renderBulkView();
					}
				};
				const onEsc = (e) => {
					if (e.key === 'Escape') {
						e.stopPropagation();
						cleanup();
						renderBulkView();
					}
				};
				setTimeout(() => {
					document.addEventListener('mousedown', outside, true);
					document.addEventListener('keydown', onEsc, true);
				}, 0);
			}

			function showCardMoreMenu(triggerEl, rec) {
				if (!canEditCanvasStructure()) {
					showBulkToast('Only the canvas owner or an editor can manage card actions.', 'info');
					return false;
				}
				document.querySelectorAll('.card-more-popup').forEach((el) => el.remove());
				const pop = document.createElement('div');
				pop.className = 'find-object-popup card-more-popup';
				pop.style.width = '280px';
				const r = triggerEl.getBoundingClientRect();
				pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 288)) + 'px';
				pop.style.top = r.bottom + 6 + 'px';
				const isSlot = !!(rec.slot && rec.slot.slotId != null);
				const isLoaded = !!rec.loadedFromId;
				const isTypeNode = !!rec.isTypeNode;
				const isInaccessible = !!rec._inaccessible;
				const isPendingDelete = !!rec.pendingDelete;
				const isPending = !!rec.isPending;
				const slotKind = isSlot ? rec.slot.kind || 'whole-record' : null;
				const isWholeRecordRequest = isSlot && slotKind === 'whole-record';
				const canConfigureSlot = canEditCanvasStructure() && _canAuthorSlots();

				let editItem = '';
				if (!isTypeNode && !isInaccessible && !isPending && !isWholeRecordRequest) {
					editItem =
						'<button type="button" class="fop-item" data-card-action="edit">' +
						'<span class="fop-label">Edit</span>' +
						'</button>';
				}
				let refreshItem = '';
				if (
					isLoaded &&
					!isPendingDelete &&
					!isPending &&
					!isInaccessible &&
					!isTypeNode &&
					rec.loadedFromId &&
					_hasCap('browse-records')
				) {
					refreshItem =
						'<button type="button" class="fop-item" data-card-action="refresh-sf">' +
						'<span class="fop-label">Refresh from Salesforce</span>' +
						'</button>';
				}
				const unlinkItem =
					isLoaded && !isTypeNode && !isPending && !isInaccessible && typeof deps.unlinkRecord === 'function'
						? '<button type="button" class="fop-item" data-card-action="unlink"><span class="fop-label">Unlink</span></button>'
						: '';
				let slotItems = '';
				if (isSlot) {
					if (canConfigureSlot) {
						slotItems =
							'<button type="button" class="fop-item" data-card-action="configure-slot">' +
							'<span class="fop-label">Edit request&hellip;</span></button>' +
							'<button type="button" class="fop-item" data-card-action="unslot">' +
							'<span class="fop-label">' +
							(slotKind === 'whole-record' ? 'Convert to draft' : 'Remove request') +
							'</span></button>';
					} else {
						slotItems =
							'<button type="button" class="fop-item is-disabled" disabled aria-disabled="true" title="Only the canvas owner or an editor can change this request">' +
							'<span class="fop-label">Edit request&hellip;</span></button>';
					}
				} else if (_canAuthorSlots()) {
					slotItems =
						'<button type="button" class="fop-item" data-card-action="to-field-slot">' +
						'<span class="fop-label">Request fields&hellip;</span></button>';
				}
				let dangerItems = '';
				const markDeleteHtml =
					'<button type="button" class="fop-item fop-item-danger" data-card-action="mark-delete">' +
					'<span class="fop-label">Mark for delete</span>' +
					'<span class="fop-name">Deletes from Salesforce on upload</span></button>';
				const describe = canvasState.describeCache && canvasState.describeCache[rec.objectName];
				const needsDeletePermissions =
					isLoaded &&
					!isTypeNode &&
					!isInaccessible &&
					!isPendingDelete &&
					(!describe || typeof describe.deletable !== 'boolean') &&
					typeof deps.ensureDescribe === 'function';
				if (!isTypeNode) {
					dangerItems += '<div class="fop-divider"></div>';
					dangerItems +=
						'<button type="button" class="fop-item" data-card-action="remove-from-canvas">' +
						'<span class="fop-label">Remove from canvas</span>' +
						'</button>';
					if (isLoaded && !isInaccessible) {
						if (isPendingDelete) {
							dangerItems +=
								'<button type="button" class="fop-item fop-item-warn" data-card-action="unmark-delete">' +
								'<span class="fop-label">Cancel deletion</span>' +
								'</button>';
						} else if (needsDeletePermissions) {
							dangerItems +=
								'<div data-delete-permissions><button type="button" class="fop-item" disabled>Checking delete permissions…</button></div>';
						} else if (canDeleteRecord(rec)) {
							dangerItems += markDeleteHtml;
						}
					}
				}
				pop.innerHTML =
					editItem +
					refreshItem +
					unlinkItem +
					((editItem || refreshItem || unlinkItem) && slotItems ? '<div class="fop-divider"></div>' : '') +
					slotItems +
					dangerItems;
				document.body.appendChild(pop);
				if (needsDeletePermissions) {
					// Related-record browsing need not load object describe metadata; the editor does.
					// Load it here too, without treating unknown permissions as a denial or granting access.
					Promise.resolve()
						.then(() => deps.ensureDescribe(rec.objectName, describe ? { force: true } : undefined))
						.then(() => {
							if (!pop.isConnected) return;
							const currentDescribe =
								canvasState.describeCache && canvasState.describeCache[rec.objectName];
							if (!currentDescribe || typeof currentDescribe.deletable !== 'boolean') {
								throw new Error('Delete permissions unavailable');
							}
							const target = pop.querySelector('[data-delete-permissions]');
							if (target)
								target.innerHTML =
									canEditCanvasStructure() && !rec._inaccessible && canDeleteRecord(rec)
										? markDeleteHtml
										: '<button type="button" class="fop-item" disabled>Delete not permitted</button>';
						})
						.catch(() => {
							if (!pop.isConnected) return;
							const target = pop.querySelector('[data-delete-permissions]');
							if (target)
								target.innerHTML =
									'<button type="button" class="fop-item" disabled>Could not check delete permissions. Reopen this menu to retry.</button>';
						});
				}
				{
					const margin = 8;
					const menuH = pop.offsetHeight;
					const vpH = window.innerHeight;
					const spaceBelow = vpH - (r.bottom + 6) - margin;
					const spaceAbove = r.top - 6 - margin;
					if (menuH <= spaceBelow) {
					} else if (menuH <= spaceAbove) {
						pop.style.top = r.top - 6 - menuH + 'px';
					} else {
						pop.style.top = margin + 'px';
						pop.style.maxHeight = vpH - margin * 2 + 'px';
						pop.style.overflowY = 'auto';
					}
				}
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
				pop.addEventListener('click', async (ev) => {
					const btn = ev.target.closest('[data-card-action]');
					if (!btn) {
						return;
					}
					const action = btn.dataset.cardAction;
					cleanup();
					if (!canEditCanvasStructure()) {
						showBulkToast('Only the canvas owner or an editor can manage card actions.', 'info');
						return;
					}
					if (action === 'edit') {
						openInsertModal(rec.objectName, { record: rec });
					} else if (action === 'to-field-slot') {
						await convertRecordToFieldSlot(rec);
					} else if (action === 'configure-slot') {
						await configureExistingSlot(rec);
					} else if (action === 'unslot') {
						const convertingRecordRequest = slotKind === 'whole-record';
						const ok = await showConfirmDialog({
							title: convertingRecordRequest
								? 'Convert this record request to a draft?'
								: 'Remove this field request?',
							message:
								(convertingRecordRequest
									? 'The request will end and the placeholder will become a normal draft you can edit.'
									: 'The record stays on the canvas, but teammates will no longer be asked to complete these fields.') +
								(window.OrgLoom.platform?.saveRequestChange
									? ''
									: ' Save the canvas to publish the change.'),
							confirmLabel: convertingRecordRequest ? 'Convert to draft' : 'Remove request',
							cancelLabel: 'Cancel',
							danger: !convertingRecordRequest,
						});
						if (ok) {
							await convertSlotBackToRecord(rec, { convertedToDraft: convertingRecordRequest });
						}
					} else if (action === 'unlink') {
						if (typeof deps.unlinkRecord === 'function') {
							await deps.unlinkRecord(rec);
						}
					} else if (action === 'refresh-sf') {
						await refreshRecordFromSf(rec);
					} else if (action === 'remove-from-canvas') {
						deleteRecord(rec.id);
					} else if (action === 'mark-delete') {
						markPendingDelete(rec.id, { allowModified: true });
					} else if (action === 'unmark-delete') {
						unmarkPendingDelete(rec.id);
					}
				});
			}

			function showFieldSlotPicker(objectName, fields) {
				return new Promise((resolve) => {
					const overlay = document.createElement('div');
					overlay.className = 'modal';
					const fieldRows = fields
						.map(
							(f) =>
								'<label class="field-slot-pick-row">' +
								'<input type="checkbox" data-fname="' +
								escapeHtml(f.name) +
								'">' +
								'<span class="field-slot-pick-label">' +
								escapeHtml(f.label) +
								'</span>' +
								'<span class="meta">' +
								escapeHtml(f.name) +
								' · ' +
								escapeHtml(f.type) +
								'</span>' +
								'</label>',
						)
						.join('');
					overlay.innerHTML =
						'<div class="modal-overlay" data-cancel></div>' +
						'<div class="modal-body" style="max-width:520px">' +
						'<div class="modal-header">' +
						'<h3>Pick fields for the recipient to fill</h3>' +
						'<button class="modal-close" data-cancel>&times;</button>' +
						'</div>' +
						'<div class="modal-content">' +
						'<p class="tag">Recipient sees the live ' +
						escapeHtml(objectName) +
						' record; only the fields you check here are editable for them. Everything else stays read-only.</p>' +
						'<div class="field-slot-pick-list">' +
						fieldRows +
						'</div>' +
						'</div>' +
						'<div class="modal-footer">' +
						'<button class="button secondary" data-cancel>Cancel</button>' +
						'<button class="button" data-submit>Continue</button>' +
						'</div>' +
						'</div>';
					document.body.appendChild(overlay);
					const close = (val) => {
						overlay.remove();
						resolve(val);
					};
					overlay
						.querySelectorAll('[data-cancel]')
						.forEach((el) => el.addEventListener('click', () => close(null)));
					overlay.querySelector('[data-submit]').addEventListener('click', () => {
						const checked = Array.from(overlay.querySelectorAll('input[type="checkbox"]:checked')).map(
							(cb) => cb.dataset.fname,
						);
						close(checked);
					});
				});
			}

			function showSlotMetaPicker(opts) {
				const title = opts && opts.title;
				const initial = opts && opts.initial;
				const safeTitle = title || 'Slot configuration';
				return new Promise((resolve) => {
					document.querySelectorAll('.slot-meta-modal').forEach((el) => el.remove());
					const overlay = document.createElement('div');
					overlay.className = 'modal slot-meta-modal';
					overlay.innerHTML =
						'<div class="modal-overlay" data-sm-close></div>' +
						'<div class="modal-body" style="max-width:520px">' +
						'<div class="modal-header">' +
						'<h3>' +
						escapeHtml(safeTitle) +
						'</h3>' +
						'<button class="modal-close" data-sm-close>&times;</button>' +
						'</div>' +
						'<div class="modal-content">' +
						'<div class="field" style="margin-bottom:0.9em">' +
						'<label for="sm-label">Slot label <span class="meta">required</span></label>' +
						'<input type="text" id="sm-label" placeholder="e.g. Customer Account" autocomplete="off" value="' +
						escapeHtml((initial && initial.label) || '') +
						'">' +
						'</div>' +
						'<div class="field" style="margin-bottom:0.9em">' +
						'<label for="sm-desc">Description <span class="meta">optional</span></label>' +
						'<input type="text" id="sm-desc" placeholder="e.g. Your assigned territory account" autocomplete="off" value="' +
						escapeHtml((initial && initial.description) || '') +
						'">' +
						'</div>' +
						'<div class="field">' +
						'<label>Assign to <span class="meta">optional</span></label>' +
						'<div class="help" style="margin-bottom:0.4em">If assigned, only this teammate can fill the slot. Leave blank to let any recipient fill it.</div>' +
						'<div id="sm-assignee-picker"></div>' +
						'</div>' +
						'</div>' +
						'<div class="modal-footer">' +
						'<button class="button secondary" data-sm-close>Cancel</button>' +
						'<button class="button" data-sm-save>Save</button>' +
						'</div>' +
						'</div>';
					document.body.appendChild(overlay);

					const labelInput = overlay.querySelector('#sm-label');
					const descInput = overlay.querySelector('#sm-desc');
					const assigneeHost = overlay.querySelector('#sm-assignee-picker');
					const picker = attachSfUserPicker(assigneeHost, {
						placeholder: 'Search a teammate to assign…',
						excludeCurrentUser: true,
					});
					setTimeout(() => labelInput.focus(), 0);

					const cleanup = (result) => {
						overlay.remove();
						document.removeEventListener('keydown', onKey);
						resolve(result);
					};
					const onKey = (e) => {
						if (e.key === 'Escape') {
							cleanup(null);
						}
					};
					document.addEventListener('keydown', onKey);
					overlay
						.querySelectorAll('[data-sm-close]')
						.forEach((el) => el.addEventListener('click', () => cleanup(null)));
					overlay.querySelector('[data-sm-save]').addEventListener('click', () => {
						const label = (labelInput.value || '').trim();
						if (!label) {
							labelInput.focus();
							return;
						}
						const description = (descInput.value || '').trim() || null;
						const assignee = picker.getPicked();
						cleanup({
							label,
							description,
							assigneeSfUserId: assignee ? assignee.id : null,
							assigneeName: assignee ? assignee.name : null,
							assigneeEmail: assignee ? assignee.email : null,
						});
					});
					labelInput.addEventListener('keydown', (e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							descInput.focus();
						}
					});
				});
			}

			function showSlotConfigurationPicker(opts) {
				opts = opts || {};
				const initial = opts.initial || {};
				const fieldMode = opts.kind === 'fields';
				const objectLabel = opts.objectLabel || opts.objectName || 'record';
				const contextLabel = opts.contextLabel || objectLabel;
				const objectNoun = String(objectLabel).toLocaleLowerCase();
				const objectArticle =
					/^(?:[aeiou]|honest|hour|heir)/i.test(objectNoun) && !/^user\b/i.test(objectNoun) ? 'an' : 'a';
				const automaticLabel = fieldMode
					? 'Fill in fields for ' + contextLabel
					: 'Add ' + objectArticle + ' ' + objectNoun;
				const selectedFields = new Set(Array.isArray(initial.fields) ? initial.fields : []);
				const availableFields = (Array.isArray(opts.fields) ? opts.fields : []).filter(
					(field) => field && String(field.type || '').toLowerCase() !== 'encryptedstring',
				);
				const playgroundRecordRequest = !!window.ORGLOOM_MOCK && !fieldMode;
				const hasSavedAssignmentChoice = Object.prototype.hasOwnProperty.call(initial, 'assigneeSfUserId');
				const initialAssignmentMode = playgroundRecordRequest
					? 'any'
					: initial.assigneeSfUserId
						? 'specific'
						: hasSavedAssignmentChoice
							? 'any'
							: '';
				const specificAssignmentOption = playgroundRecordRequest
					? ''
					: '<label class="slot-assignment-option"><input type="radio" name="slot-assignment-mode" value="specific"' +
						(initialAssignmentMode === 'specific' ? ' checked' : '') +
						'><span><strong>Specific teammate</strong></span></label>';
				return new Promise((resolve) => {
					document.querySelectorAll('.slot-config-modal').forEach((el) => el.remove());
					const overlay = document.createElement('div');
					overlay.className = 'modal slot-config-modal';
					const fieldRows = fieldMode
						? availableFields
								.map((field) => {
									const checked = selectedFields.has(field.name) ? ' checked' : '';
									const unavailable = field.unavailable
										? '<span class="slot-config-field-warning">Unavailable through this connection</span>'
										: '';
									return (
										'<label class="field-slot-pick-row" data-slot-field-row data-search="' +
										escapeHtml((field.label || '') + ' ' + field.name) +
										'">' +
										'<input type="checkbox" data-fname="' +
										escapeHtml(field.name) +
										'"' +
										checked +
										'>' +
										'<span class="slot-config-field-copy"><span class="field-slot-pick-label">' +
										escapeHtml(field.label || field.name) +
										'</span><span class="meta">' +
										escapeHtml(field.name) +
										(field.type ? ' · ' + escapeHtml(field.type) : '') +
										'</span>' +
										unavailable +
										'</span></label>'
									);
								})
								.join('')
						: '';
					const fieldSection = fieldMode
						? '<div class="slot-config-section">' +
							'<div class="slot-config-section-heading"><strong>Fields to complete</strong></div>' +
							'<input type="search" class="slot-config-field-search" data-slot-field-search placeholder="Find a field" autocomplete="off">' +
							'<div class="field-slot-pick-list">' +
							fieldRows +
							'</div></div>'
						: '';
					overlay.innerHTML =
						'<div class="modal-overlay" data-slot-config-close></div>' +
						'<div class="modal-body slot-config-body">' +
						'<div class="modal-header"><div class="slot-config-title"><span class="slot-config-title-icon slot-config-title-icon--' +
						(fieldMode ? 'fields' : 'record') +
						'" aria-hidden="true">' +
						(fieldMode ? '&#9998;' : '&#43;') +
						'</span><h3>' +
						escapeHtml(opts.title || (fieldMode ? 'Request fields' : 'Request a new record')) +
						'</h3></div><button class="modal-close" data-slot-config-close>&times;</button></div>' +
						'<div class="modal-content slot-config-content">' +
						fieldSection +
						'<div class="slot-config-section"><div class="slot-config-section-heading"><div><strong>Who should complete this?</strong>' +
						(playgroundRecordRequest
							? '<div class="help">Demo record requests are available to any contributor.</div>'
							: '') +
						'</div></div>' +
						'<div class="slot-assignment-options" role="radiogroup" aria-label="Who should complete this request?">' +
						specificAssignmentOption +
						'<label class="slot-assignment-option"><input type="radio" name="slot-assignment-mode" value="any"' +
						(initialAssignmentMode === 'any' ? ' checked' : '') +
						'><span><strong>Any contributor</strong></span></label>' +
						'</div><div class="field slot-specific-assignee" data-slot-specific-assignee hidden><label>Teammate</label>' +
						'<div data-slot-assignee-picker></div>' +
						'<div class="slot-assignee-access" data-slot-assignee-access aria-live="polite" hidden></div></div></div>' +
						'<div class="field slot-config-instructions"><label for="slot-config-description">Instructions for the contributor <span class="meta">optional</span></label>' +
						'<textarea id="slot-config-description" rows="3" placeholder="Add context only if the request needs it.">' +
						escapeHtml(initial.description || '') +
						'</textarea></div>' +
						'<div class="slot-config-error" data-slot-config-error hidden></div>' +
						'</div><div class="modal-footer"><button class="button secondary" data-slot-config-close>Cancel</button>' +
						'<button class="button" data-slot-config-save>Save ' +
						(fieldMode ? 'field request' : 'record request') +
						'</button></div></div>';
					document.body.appendChild(overlay);

					const descriptionInput = overlay.querySelector('#slot-config-description');
					const errorEl = overlay.querySelector('[data-slot-config-error]');
					const accessEl = overlay.querySelector('[data-slot-assignee-access]');
					const specificAssignee = overlay.querySelector('[data-slot-specific-assignee]');
					const assignmentInputs = Array.from(overlay.querySelectorAll('input[name="slot-assignment-mode"]'));
					let accessCheckSequence = 0;
					let picker = null;
					const assignmentMode = () => {
						const selected = assignmentInputs.find((input) => input.checked);
						return selected ? selected.value : '';
					};

					const sameSfUser = (left, right) =>
						String(left || '')
							.slice(0, 15)
							.toLowerCase() ===
						String(right || '')
							.slice(0, 15)
							.toLowerCase();
					const currentCanvasId = () => {
						const current = canvasState.currentCanvas;
						return current && current.id && current.ownedByMe && /^[a-zA-Z0-9]{15,18}$/.test(current.id)
							? current.id
							: null;
					};
					const showAccessState = (kind, copy) => {
						accessEl.hidden = false;
						accessEl.className = 'slot-assignee-access slot-assignee-access--' + kind;
						accessEl.innerHTML = '<span class="slot-assignee-access-copy">' + escapeHtml(copy) + '</span>';
					};
					const grantContributorAccess = async (assignee) => {
						const canvasId = currentCanvasId();
						if (!canvasId || !assignee || !assignee.id) {
							throw new Error('Save the canvas before granting access.');
						}
						const response = await csrfFetch(
							'/api/canvas/' + encodeURIComponent(canvasId) + '/direct-share',
							{
								method: 'POST',
								headers: { 'Content-Type': 'application/json' },
								credentials: 'same-origin',
								body: JSON.stringify({
									recipientSfUserId: assignee.id,
									role: 'contributor',
								}),
							},
						);
						const data = await response.json().catch(() => null);
						if (!response.ok) {
							throw new Error((data && (data.message || data.error)) || 'HTTP ' + response.status);
						}
					};
					const checkAssigneeAccess = async (assignee) => {
						const sequence = ++accessCheckSequence;
						if (!assignee || !assignee.id) {
							accessEl.hidden = true;
							accessEl.textContent = '';
							return { ok: true, role: null };
						}
						const canvasId = currentCanvasId();
						if (!canvasId) {
							accessEl.hidden = true;
							accessEl.textContent = '';
							return { ok: true, role: null, unsavedCanvas: true };
						}
						if (window.SF_USER_ID && sameSfUser(window.SF_USER_ID, assignee.id)) {
							showAccessState(
								fieldMode ? 'success' : 'warning',
								fieldMode
									? 'You own this canvas and can complete these fields.'
									: 'A record request must be completed by another canvas recipient. Choose a teammate or select Any contributor.',
							);
							return { ok: true, role: 'owner' };
						}
						showAccessState('loading', 'Checking this teammate’s canvas access...');
						try {
							const response = await csrfFetch(
								'/api/canvas/' + encodeURIComponent(canvasId) + '/share-links',
								{ credentials: 'same-origin' },
							);
							const data = await response.json().catch(() => null);
							if (!response.ok) {
								throw new Error((data && (data.message || data.error)) || 'HTTP ' + response.status);
							}
							if (sequence !== accessCheckSequence) {
								return { ok: false, stale: true };
							}
							const currentPick = picker && picker.getPicked();
							if (!currentPick || !sameSfUser(currentPick.id, assignee.id)) {
								return { ok: false, stale: true };
							}
							const share = ((data && data.directShares) || []).find((item) =>
								sameSfUser(item.sfUserId, assignee.id),
							);
							const role =
								share && (share.role || (share.accessLevel === 'Collaborator' ? 'editor' : 'viewer'));
							if (role === 'contributor' || role === 'editor') {
								showAccessState(
									'success',
									(currentPick.name || 'This teammate') +
										' can complete this request with ' +
										(role === 'editor' ? 'Editor' : 'Contributor') +
										' access.',
								);
								return { ok: true, role };
							}
							if (role === 'viewer') {
								showAccessState(
									'warning',
									(currentPick.name || 'This teammate') +
										' currently has Viewer access. Contributor access is required to complete this request.',
								);
								return { ok: true, role };
							}
							showAccessState(
								'warning',
								(currentPick.name || 'This teammate') +
									' does not have access to this canvas. Contributor access is required to complete this request.',
							);
							return { ok: true, role: null };
						} catch (error) {
							if (sequence !== accessCheckSequence) {
								return { ok: false, stale: true };
							}
							showAccessState(
								'warning',
								'Canvas access could not be verified. Try again or manage access from Share.',
							);
							return { ok: false, error };
						}
					};
					const refreshAssigneeAccess = async () => {
						if (assignmentMode() !== 'specific') {
							accessCheckSequence += 1;
							accessEl.hidden = true;
							accessEl.textContent = '';
							return;
						}
						await checkAssigneeAccess(picker && picker.getPicked());
					};

					let assigneeSelectionVersion = 0;
					picker = attachSfUserPicker(overlay.querySelector('[data-slot-assignee-picker]'), {
						placeholder: 'Search a teammate to assign…',
						changeLabel: 'Change teammate',
						excludeCurrentUser: true,
						onPick: () => {
							assigneeSelectionVersion += 1;
							errorEl.hidden = true;
							refreshAssigneeAccess();
						},
					});
					const savedAssigneeName = String(initial.assigneeName || '').trim();
					const needsAssigneeName =
						initial.assigneeSfUserId &&
						(!savedAssigneeName ||
							/^assigned teammate$/i.test(savedAssigneeName) ||
							savedAssigneeName === initial.assigneeEmail);
					if (initial.assigneeSfUserId && !needsAssigneeName) {
						picker.setPicked({
							id: initial.assigneeSfUserId,
							name: savedAssigneeName,
							email: initial.assigneeEmail || '',
						});
					}
					const syncAssignmentUi = (focusPicker) => {
						const specific = assignmentMode() === 'specific';
						specificAssignee.hidden = !specific;
						errorEl.hidden = true;
						if (specific) {
							refreshAssigneeAccess();
							if (focusPicker && !picker.getPicked()) {
								picker.focus();
							}
						} else {
							accessEl.hidden = true;
							accessEl.textContent = '';
						}
					};
					assignmentInputs.forEach((input) => {
						input.addEventListener('change', () => {
							assigneeSelectionVersion += 1;
							syncAssignmentUi(input.value === 'specific');
						});
					});
					syncAssignmentUi(false);
					if (needsAssigneeName) {
						showAccessState('loading', 'Loading the assigned user’s name…');
						const version = assigneeSelectionVersion;
						const stillCurrent = () => overlay.isConnected && assigneeSelectionVersion === version;
						(async () => {
							try {
								const response = await csrfFetch(
									'/api/objects/User/records/' + encodeURIComponent(initial.assigneeSfUserId),
									{ credentials: 'same-origin' },
								);
								const user = await response.json();
								if (!stillCurrent()) return;
								if (!response.ok || !user.Name || !sameSfUser(user.Id, initial.assigneeSfUserId))
									throw new Error('Assignee unavailable');
								picker.setPicked({ id: user.Id, name: user.Name, email: user.Email || '' });
							} catch (_) {
								if (!stillCurrent()) return;
								accessEl.hidden = true;
								errorEl.textContent =
									'Could not load the assigned user’s name. Choose the teammate again, or cancel to keep the existing assignment.';
								errorEl.hidden = false;
							}
						})();
					}

					const search = overlay.querySelector('[data-slot-field-search]');
					if (search) {
						search.addEventListener('input', () => {
							const query = search.value.trim().toLowerCase();
							overlay.querySelectorAll('[data-slot-field-row]').forEach((row) => {
								row.hidden =
									!!query &&
									!String(row.dataset.search || '')
										.toLowerCase()
										.includes(query);
							});
						});
					}

					const cleanup = (result) => {
						overlay.remove();
						document.removeEventListener('keydown', onKey);
						resolve(result);
					};
					const onKey = (event) => {
						if (event.key === 'Escape' && !saving) {
							cleanup(null);
						}
					};
					document.addEventListener('keydown', onKey);
					overlay.querySelectorAll('[data-slot-config-close]').forEach((button) => {
						button.addEventListener('click', () => {
							if (!saving) cleanup(null);
						});
					});
					const saveButton = overlay.querySelector('[data-slot-config-save]');
					const saveButtonLabel = saveButton.textContent;
					let saving = false;
					let savedCanvasForRequest = null;
					saveButton.addEventListener('click', async () => {
						if (saving) {
							return;
						}
						const fields = fieldMode
							? Array.from(overlay.querySelectorAll('[data-slot-field-row] input:checked')).map(
									(input) => input.dataset.fname,
								)
							: undefined;
						if (fieldMode && fields.length === 0) {
							errorEl.hidden = false;
							errorEl.textContent = 'Select at least one field for the recipient.';
							search.focus();
							return;
						}
						const selectedAssignmentMode = assignmentMode();
						if (!selectedAssignmentMode) {
							errorEl.hidden = false;
							errorEl.textContent = 'Choose who should complete this request.';
							assignmentInputs[0].focus();
							return;
						}
						const assignee = selectedAssignmentMode === 'specific' ? picker.getPicked() : null;
						if (selectedAssignmentMode === 'specific' && !assignee) {
							errorEl.hidden = false;
							errorEl.textContent = 'Choose a teammate for this request.';
							picker.focus();
							return;
						}
						if (!fieldMode && assignee && window.SF_USER_ID && sameSfUser(window.SF_USER_ID, assignee.id)) {
							errorEl.hidden = false;
							errorEl.textContent =
								'Choose another teammate for this record request, or select Any contributor.';
							return;
						}
						saving = true;
						saveButton.disabled = true;
						saveButton.textContent = 'Checking access...';
						try {
							if (!window.ORGLOOM_MOCK && !(canvasState.currentCanvas && canvasState.currentCanvas.id)) {
								if (typeof promptCanvasSave !== 'function') {
									throw new Error('The canvas save dialog is unavailable. Refresh and try again.');
								}
								saveButton.textContent = 'Saving canvas...';
								overlay.classList.add('hidden');
								let saved;
								try {
									saved = await promptCanvasSave({
										title: 'Save canvas to continue',
										submitText: 'Save and continue',
									});
								} finally {
									overlay.classList.remove('hidden');
								}
								if (!saved || !currentCanvasId()) return;
								savedCanvasForRequest = currentCanvasId();
							}
							saveButton.textContent = 'Checking access...';
							if (
								assignee &&
								currentCanvasId() &&
								!(window.SF_USER_ID && sameSfUser(window.SF_USER_ID, assignee.id))
							) {
								const access = await checkAssigneeAccess(assignee);
								if (!access.ok) {
									if (!access.stale) {
										errorEl.hidden = false;
										errorEl.textContent =
											"Could not verify this teammate's canvas access. Try again or manage access from Share.";
									}
									return;
								}
								if (access.role !== 'contributor' && access.role !== 'editor') {
									const assigneeName = assignee.name || assignee.email || 'This teammate';
									const confirmed = await showConfirmDialog({
										title: 'Contributor access required',
										message:
											assigneeName +
											' needs Contributor access to complete this request. Grant access and assign the request?',
										confirmLabel: 'Grant access and assign',
										cancelLabel: 'Back',
									});
									if (!confirmed) {
										return;
									}
									saveButton.textContent = 'Granting access...';
									try {
										await grantContributorAccess(assignee);
									} catch (error) {
										errorEl.hidden = false;
										errorEl.textContent =
											'Canvas access could not be updated: ' +
											(error.message || String(error)) +
											'. Try again or manage access from Share.';
										return;
									}
								}
							}
							cleanup({
								savedCanvasForRequest,
								kind: fieldMode ? 'fields' : 'whole-record',
								fields,
								label: automaticLabel,
								description: descriptionInput.value.trim() || null,
								assigneeSfUserId: assignee ? assignee.id : null,
								assigneeName: assignee ? assignee.name : null,
								assigneeEmail: assignee ? assignee.email : null,
							});
						} catch (error) {
							errorEl.hidden = false;
							errorEl.textContent = error.message || 'Could not save the request. Try again.';
						} finally {
							saving = false;
							saveButton.disabled = false;
							saveButton.textContent = saveButtonLabel;
							if (overlay.isConnected) saveButton.focus();
						}
					});
					setTimeout(() => (fieldMode && search ? search : descriptionInput).focus(), 0);
				});
			}

			function _openSlotRecordPicker(rec, anchorEl) {
				document
					.querySelectorAll('.find-object-popup, .free-tn-picker, .slot-picker')
					.forEach((el) => el.remove());
				const pop = document.createElement('div');
				pop.className = 'find-object-popup slot-picker';
				pop.style.width = '320px';
				if (anchorEl && typeof anchorEl.getBoundingClientRect === 'function') {
					const r = anchorEl.getBoundingClientRect();
					pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 328)) + 'px';
					pop.style.top = r.bottom + 6 + 'px';
				} else {
					pop.style.left = '50%';
					pop.style.top = '20%';
					pop.style.transform = 'translateX(-50%)';
				}
				pop.innerHTML =
					'<div class="fop-header">Choose ' +
					escapeHtml(rec.label || rec.objectName) +
					' for this request' +
					'</div>' +
					'<div class="fop-sub">' +
					(rec.objectName === 'Case'
						? 'Search by case number or subject, or paste a 15/18-character record ID.'
						: 'Search by record name or paste a 15/18-character record ID.') +
					'</div>' +
					'<input type="search" class="fop-search slot-search" placeholder="Search…" autocomplete="off">' +
					'<div class="fop-list slot-list"></div>';
				document.body.appendChild(pop);
				const input = pop.querySelector('.slot-search');
				const list = pop.querySelector('.slot-list');
				let seq = 0;
				const cleanup = () => {
					if (pop.parentNode) {
						pop.remove();
					}
					document.removeEventListener('mousedown', outside, true);
					document.removeEventListener('keydown', onEsc, true);
				};
				const outside = (ev) => {
					if (!pop.contains(ev.target)) {
						cleanup();
					}
				};
				const onEsc = (ev) => {
					if (ev.key === 'Escape') {
						cleanup();
					}
				};
				const fetchById = async (id) => {
					list.innerHTML = '<div class="fop-empty">Loading record…</div>';
					try {
						const resp = await csrfFetch(
							'/api/objects/' + encodeURIComponent(rec.objectName) + '/records/' + encodeURIComponent(id),
							{ credentials: 'same-origin' },
						);
						if (!resp.ok) {
							const body = await resp.json().catch(() => ({}));
							throw new Error(body.message || resp.statusText || 'Could not load this record.');
						}
						const single = await resp.json();
						cleanup();
						await _fillSlotWithSfRecord(rec, single);
					} catch (e) {
						list.innerHTML =
							'<div class="fop-empty">' +
							escapeHtml(e.message || 'Could not load this record.') +
							'</div>';
					}
				};
				const runSearch = async () => {
					const q = (input.value || '').trim();
					if (/^[a-zA-Z0-9]{15,18}$/.test(q)) {
						fetchById(q);
						return;
					}
					if (!q) {
						list.innerHTML = '';
						return;
					}
					const mySeq = ++seq;
					list.innerHTML = '<div class="fop-empty">Searching…</div>';
					try {
						const resp = await csrfFetch(
							'/api/objects/' + encodeURIComponent(rec.objectName) + '/search?q=' + encodeURIComponent(q),
							{ credentials: 'same-origin' },
						);
						if (!resp.ok) {
							const body = await resp.json().catch(() => ({}));
							throw new Error(body.message || resp.statusText || 'Search failed.');
						}
						const data = await resp.json();
						if (mySeq !== seq) {
							return;
						}
						const records = (data && data.records) || [];
						if (records.length === 0) {
							list.innerHTML =
								'<div class="fop-empty">No matches. (Empty results may also mean limited sharing access; ask your admin if you expected to see this record.)</div>';
							return;
						}
						const onCanvas = new Set(
							canvasState.bulkRecords
								.filter(
									(b) =>
										!b.isTypeNode &&
										b.id !== rec.id &&
										b.objectName === rec.objectName &&
										b.loadedFromId,
								)
								.map((b) => b.loadedFromId),
						);
						list.innerHTML = records
							.map((r) => {
								const already = onCanvas.has(r.id);
								return (
									'<button type="button" class="fop-item' +
									(already ? ' is-already' : '') +
									'" data-pick-id="' +
									escapeHtml(r.id) +
									'"' +
									(already ? ' disabled title="Already on the canvas"' : '') +
									'>' +
									'<span class="fop-label">' +
									escapeHtml(r.name || '(no name)') +
									'</span>' +
									'<span class="fop-name">' +
									escapeHtml(r.id) +
									(already ? ' · already loaded' : '') +
									'</span>' +
									'</button>'
								);
							})
							.join('');
					} catch (e) {
						if (mySeq !== seq) {
							return;
						}
						list.innerHTML =
							'<div class="fop-empty">Search failed: ' + escapeHtml(e.message || String(e)) + '</div>';
					}
				};
				let timer;
				input.addEventListener('input', () => {
					clearTimeout(timer);
					timer = setTimeout(runSearch, 250);
				});
				list.addEventListener('click', (ev) => {
					const btn = ev.target.closest('[data-pick-id]');
					if (!btn || btn.disabled) {
						return;
					}
					fetchById(btn.dataset.pickId);
				});
				setTimeout(() => input.focus(), 0);
				setTimeout(() => {
					document.addEventListener('mousedown', outside, true);
					document.addEventListener('keydown', onEsc, true);
				}, 0);
			}

			return {
				showFieldPicker: showFieldPicker,
				showCardMoreMenu: showCardMoreMenu,
				showFieldSlotPicker: showFieldSlotPicker,
				showSlotConfigurationPicker: showSlotConfigurationPicker,
				_openSlotRecordPicker: _openSlotRecordPicker,
			};
		},
	};
})();

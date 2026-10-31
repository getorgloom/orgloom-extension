(function () {
	'use strict';
	// Computes contributor slot assignment and completion state without exposing unrelated fields.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.slotUser = {
		mount: function mount(deps) {
			if (!deps || !deps.canvasState || !deps.csrfFetch || !deps.escapeHtml) {
				throw new Error('slot-user.mount: missing required deps');
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			const getCanvasShareRole =
				typeof deps.getCanvasShareRole === 'function' ? deps.getCanvasShareRole : function () {};

			function _isEmptySlot(rec) {
				if (!rec || !rec.slot || rec.slot.slotId == null) {
					return false;
				}
				if ((rec.slot.kind || 'whole-record') !== 'whole-record') {
					return false;
				}
				if (rec.loadedFromId) {
					return false;
				}
				if (!rec._recipientSlot && rec.slot.origin !== 'standalone') {
					return false;
				}
				const v = rec.values || {};
				for (const k in v) {
					if (v[k] != null && v[k] !== '') {
						return false;
					}
				}
				return true;
			}

			function _slotAssignmentState(rec) {
				if (!rec || !rec.slot || rec.slot.slotId == null) {
					return null;
				}
				const assignee = rec.slot.assigneeSfUserId || null;
				if (!assignee) {
					return 'generic';
				}
				return window.SF_USER_ID && assignee === window.SF_USER_ID ? 'mine' : 'other';
			}

			function _isSlotLockedForCurrentUser(rec) {
				const currentCanvas = canvasState.currentCanvas;
				const ownsCanvas = !currentCanvas || !currentCanvas.id || !!currentCanvas.ownedByMe;
				const contributorAssignmentApplies = getCanvasShareRole() !== 'editor';
				return !ownsCanvas && contributorAssignmentApplies && _slotAssignmentState(rec) === 'other';
			}

			function _slotRequestBadgeHtml(rec) {
				const state = _slotAssignmentState(rec);
				if (!state) {
					return '';
				}
				const kind = rec.slot.kind || 'whole-record';
				const progress = _slotProgress(rec);
				const unavailableFieldCount =
					kind === 'fields' && Number.isSafeInteger(Number(rec.slot.unavailableFieldCount))
						? Math.max(0, Number(rec.slot.unavailableFieldCount))
						: 0;
				const complete =
					unavailableFieldCount === 0 && progress && progress.total > 0 && progress.filled >= progress.total;
				const count =
					kind === 'fields'
						? (Array.isArray(rec.slot.fields) ? rec.slot.fields.length : 0) + unavailableFieldCount
						: 1;
				const subject = kind === 'fields' ? count + ' field' + (count === 1 ? '' : 's') : 'Record';
				let target;
				if (state === 'mine') {
					target = 'you';
				} else if (state === 'other') {
					target = rec.slot.assigneeName || rec.slot.assigneeEmail || 'assigned teammate';
				} else {
					target = 'any contributor';
				}
				const text = complete ? subject + ' complete' : subject + ' for ' + target;
				const title = complete ? subject + ' completed.' : subject + ' assigned to ' + target + '.';
				return (
					'<span class="record-request-summary-badge record-request-summary-badge--' +
					(complete ? 'complete' : state) +
					'" title="' +
					escapeHtml(title) +
					'">' +
					escapeHtml(text) +
					'</span>'
				);
			}

			function _slotAssignmentCardClass(rec) {
				return _isSlotLockedForCurrentUser(rec) ? ' record-card--slot-locked' : '';
			}

			function _slotProgress(rec) {
				if (!rec || !rec.slot || rec.slot.slotId == null) {
					return null;
				}
				const kind = rec.slot.kind || 'whole-record';
				if (kind === 'fields') {
					const fields = Array.isArray(rec.slot.fields) ? rec.slot.fields : [];
					const total = fields.length;
					const v = rec.values || {};
					let filled = 0;
					for (const f of fields) {
						const x = v[f];
						if (x != null && x !== '') {
							filled++;
						}
					}
					return { filled, total };
				}
				const loaded = !!rec.loadedFromId;
				const hasValue = (() => {
					const v = rec.values || {};
					for (const k in v) {
						if (v[k] != null && v[k] !== '') {
							return true;
						}
					}
					return false;
				})();
				return { filled: loaded || hasValue ? 1 : 0, total: 1 };
			}

			function _aggregateSlotProgress() {
				let filled = 0,
					total = 0,
					recordCount = 0,
					recipientMode = false;
				for (const r of canvasState.bulkRecords) {
					if (r.isTypeNode || r.isPending) {
						continue;
					}
					const p = _slotProgress(r);
					if (!p) {
						continue;
					}
					filled += p.filled;
					total += p.total;
					recordCount++;
					recipientMode = recipientMode || !!r._recipientSlot;
				}
				return { filled, total, recordCount, recipientMode };
			}

			function _slotProgressClass(progress) {
				if (!progress || progress.total === 0) {
					return 'slot-progress-empty';
				}
				if (progress.filled >= progress.total) {
					return 'slot-progress-full';
				}
				if (progress.filled === 0) {
					return 'slot-progress-empty';
				}
				return 'slot-progress-partial';
			}

			const _userNameCache = new Map();
			async function _resolveUserName(userId) {
				if (!userId) {
					return null;
				}
				if (_userNameCache.has(userId)) {
					return _userNameCache.get(userId);
				}
				if (window.SF_USER_ID && userId === window.SF_USER_ID) {
					_userNameCache.set(userId, 'you');
					return 'you';
				}
				try {
					const r = await csrfFetch('/api/objects/User/records/' + encodeURIComponent(userId), {
						credentials: 'same-origin',
					});
					if (!r.ok) {
						return null;
					}
					const u = await r.json();
					const name = (u && (u.Name || ((u.FirstName || '') + ' ' + (u.LastName || '')).trim())) || null;
					if (name) {
						_userNameCache.set(userId, name);
					}
					return name;
				} catch (e) {
					return null;
				}
			}

			function _formatRelativeTime(iso) {
				if (!iso) {
					return '';
				}
				const t = new Date(iso).getTime();
				if (!isFinite(t)) {
					return '';
				}
				const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
				if (sec < 60) {
					return 'just now';
				}
				const min = Math.round(sec / 60);
				if (min < 60) {
					return min + ' minute' + (min === 1 ? '' : 's') + ' ago';
				}
				const hr = Math.round(min / 60);
				if (hr < 24) {
					return hr + ' hour' + (hr === 1 ? '' : 's') + ' ago';
				}
				const day = Math.round(hr / 24);
				if (day < 30) {
					return day + ' day' + (day === 1 ? '' : 's') + ' ago';
				}
				return new Date(iso).toLocaleDateString();
			}

			const _slotInaccessibleObjects = new Set();
			const _slotDescribeAccessByObject = new Map();
			const _permissionMessage =
				'You can\u2019t complete this request with your current Salesforce permissions. Ask the canvas owner to reassign it or ask your Salesforce admin for access.';

			function _slotPermissionBlockReason(rec) {
				if (!rec || !rec.objectName || !rec.slot || rec.slot.slotId == null) {
					return null;
				}
				if (_slotInaccessibleObjects.has(rec.objectName)) {
					return _permissionMessage;
				}
				if (!_slotDescribeAccessByObject.has(rec.objectName)) {
					return null;
				}
				const describe = _slotDescribeAccessByObject.get(rec.objectName);
				if (!describe || !Array.isArray(describe.fields)) {
					return _permissionMessage;
				}
				const kind = rec.slot.kind || 'whole-record';
				const existing = !!rec.loadedFromId;
				const objectWritable = existing ? describe.updateable === true : describe.createable === true;
				if (!objectWritable) {
					return _permissionMessage;
				}
				if (kind === 'fields') {
					const requested = new Set(Array.isArray(rec.slot.fields) ? rec.slot.fields : []);
					if (requested.size === 0) {
						return null;
					}
					const hasWritableRequestedField = describe.fields.some(
						(field) =>
							field &&
							requested.has(field.name) &&
							(existing ? field.updateable === true : field.createable === true),
					);
					return hasWritableRequestedField ? null : _permissionMessage;
				}
				return describe.fields.some((field) => field && field.createable === true) ? null : _permissionMessage;
			}

			function _slotPreflightWarn(rec) {
				return !!_slotPermissionBlockReason(rec);
			}

			return {
				_isEmptySlot: _isEmptySlot,
				_slotAssignmentState: _slotAssignmentState,
				_isSlotLockedForCurrentUser: _isSlotLockedForCurrentUser,
				_slotRequestBadgeHtml: _slotRequestBadgeHtml,
				_slotAssignmentCardClass: _slotAssignmentCardClass,
				_slotProgress: _slotProgress,
				_aggregateSlotProgress: _aggregateSlotProgress,
				_slotProgressClass: _slotProgressClass,
				_resolveUserName: _resolveUserName,
				_formatRelativeTime: _formatRelativeTime,
				_slotPreflightWarn: _slotPreflightWarn,
				_slotPermissionBlockReason: _slotPermissionBlockReason,
				_slotInaccessibleObjects: _slotInaccessibleObjects,
				_slotDescribeAccessByObject: _slotDescribeAccessByObject,
			};
		},
	};
})();

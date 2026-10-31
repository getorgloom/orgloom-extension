(function () {
	'use strict';
	// Tracks Salesforce records that changed since a saved canvas version was loaded.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.staleRef = {
		mount: function mount(deps) {
			const required = [
				'canvasState',
				'encryptedFields',
				'renderBulkView',
				'deleteRecord',
				'getBulkRecords',
				'ensureDescribe',
				'showBulkToast',
			];
			if (!deps) {
				throw new Error('stale-ref.mount: missing deps object');
			}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('stale-ref.mount: missing dep ' + k);
				}
			}
			const renderBulkView = deps.renderBulkView;
			const deleteRecord = deps.deleteRecord;
			const getBulkRecords = deps.getBulkRecords;
			const ensureDescribe = deps.ensureDescribe;
			const showBulkToast = deps.showBulkToast;
			const canvasState = deps.canvasState;
			const encryptedFields = deps.encryptedFields;

			function _stripEncryptedDraftValues(rec) {
				rec.values = encryptedFields.stripValues(canvasState, rec.objectName, rec.values);
				encryptedFields.clearSubmitted(rec, encryptedFields.intentNames(rec, canvasState));
			}

			const _staleSfIds = new Set();
			const _staleIdKey = (id) => (id ? String(id).slice(0, 15) : '');

			function _isRecordStale(rec) {
				if (!rec || !rec.loadedFromId || rec._staleAck) {
					return false;
				}
				if (rec._deletedInSf) {
					return true;
				}
				return _staleSfIds.has(_staleIdKey(rec.loadedFromId));
			}
			function _setStaleRefsFromLoad(staleRefs) {
				_staleSfIds.clear();
				(staleRefs || []).forEach((s) => {
					if (!s || !s.sfId) {
						return;
					}
					const reason = s.reason || 'unknown';
					if (reason === 'no-access') {
						return;
					}
					_staleSfIds.add(_staleIdKey(s.sfId));
				});
			}
			function _addStaleRefIds(sfIds) {
				if (!Array.isArray(sfIds) || sfIds.length === 0) {
					return;
				}
				let added = false;
				for (const id of sfIds) {
					const k = _staleIdKey(id);
					if (k && !_staleSfIds.has(k)) {
						_staleSfIds.add(k);
						added = true;
					}
				}
				if (added) {
					try {
						renderBulkView();
					} catch (_) {}
				}
			}

			function _markRecordUnavailable(rec) {
				if (!rec) {
					return false;
				}
				rec.values = {};
				delete rec.loadedValues;
				delete rec._loadedFieldNames;
				delete rec._recordAccess;
				delete rec._recordAccessCheckedAt;
				delete rec._recordAccessAttemptedAt;
				delete rec._lastRefreshedAt;
				delete rec._refreshPulse;
				rec._inaccessible = true;
				rec._deletedInSf = false;
				rec._staleAck = false;
				return true;
			}
			document.addEventListener('orgloom:records-deleted', (e) => {
				const ids = (e && e.detail && e.detail.sfIds) || [];
				if (!Array.isArray(ids) || ids.length === 0) {
					return;
				}
				const deletedKeys = new Set(ids.map(_staleIdKey).filter(Boolean));
				let recs;
				try {
					recs = getBulkRecords();
				} catch (_) {
					recs = null;
				}
				let converted = 0;
				if (Array.isArray(recs)) {
					recs.forEach((rec) => {
						if (!rec || !rec.loadedFromId) {
							return;
						}
						if (!deletedKeys.has(_staleIdKey(rec.loadedFromId))) {
							return;
						}
						rec._wasLoadedFromId = rec.loadedFromId;
						rec.loadedFromId = null;
						_stripEncryptedDraftValues(rec);
						rec._staleAck = false;
						delete rec.hasExisting;
						delete rec.hasModified;
						converted++;
					});
				}
				if (converted > 0) {
					try {
						renderBulkView();
					} catch (_) {}
				}
			});

			async function _convertStaleRecordToDraft(rec) {
				if (!rec || rec._inaccessible || !rec.values || Object.keys(rec.values).length === 0) {
					showBulkToast('No readable Salesforce values are available to turn into a draft.', 'info');
					return false;
				}
				let describe;
				try {
					describe = await ensureDescribe(rec.objectName, { force: true });
				} catch (_error) {
					showBulkToast('Could not verify Salesforce create access. Reconnect and try again.', 'error');
					return false;
				}
				if (!describe || describe.createable !== true) {
					showBulkToast(
						'Salesforce does not allow this user to create ' + rec.objectName + ' records.',
						'info',
					);
					return false;
				}
				rec.loadedFromId = null;
				delete rec.loadedValues;
				_stripEncryptedDraftValues(rec);
				rec._staleAck = false;
				rec._deletedInSf = false;
				renderBulkView();
				return true;
			}

			function _showStaleRefMenu(triggerEl, rec) {
				document.querySelectorAll('.stale-ref-popup').forEach((el) => el.remove());
				const pop = document.createElement('div');
				pop.className = 'find-object-popup stale-ref-popup';
				pop.style.width = '300px';
				const r = triggerEl.getBoundingClientRect();
				pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 308)) + 'px';
				pop.style.top = r.bottom + 6 + 'px';
				pop.innerHTML =
					'<div class="fop-header">' +
					'<div class="fop-title">Record is unavailable in Salesforce</div>' +
					'<div class="fop-sub">The record may have been deleted, or your Salesforce access may have changed.</div>' +
					'</div>' +
					'<button type="button" class="fop-item fop-item--primary" data-stale-action="convert">' +
					'<span class="fop-label">Create a new draft from this card</span>' +
					'<span class="fop-name">Uses only the values already loaded into this card; it does not retrieve the unavailable Salesforce record.</span>' +
					'</button>' +
					'<button type="button" class="fop-item" data-stale-action="remove">' +
					'<span class="fop-label">Remove from canvas</span>' +
					'<span class="fop-name">Delete this card and its edges. Salesforce isn’t touched.</span>' +
					'</button>' +
					'<button type="button" class="fop-item" data-stale-action="keep">' +
					'<span class="fop-label">Dismiss (won’t re-upload until fixed)</span>' +
					'<span class="fop-name">Hides the warning, but the card stays linked to a missing Id; uploads will skip it as "no changes."</span>' +
					'</button>';
				document.body.appendChild(pop);
				const cleanup = () => {
					pop.remove();
					document.removeEventListener('mousedown', onDocDown, true);
				};
				const onDocDown = (e) => {
					if (!pop.contains(e.target)) {
						cleanup();
					}
				};
				setTimeout(() => document.addEventListener('mousedown', onDocDown, true), 0);
				pop.querySelectorAll('[data-stale-action]').forEach((btn) => {
					btn.addEventListener('click', async () => {
						const action = btn.dataset.staleAction;
						cleanup();
						if (action === 'convert') {
							await _convertStaleRecordToDraft(rec);
							return;
						} else if (action === 'remove') {
							deleteRecord(rec.id);
							return;
						} else if (action === 'keep') {
							rec._staleAck = true;
						}
						renderBulkView();
					});
				});
			}

			return {
				_isRecordStale: _isRecordStale,
				_setStaleRefsFromLoad: _setStaleRefsFromLoad,
				_addStaleRefIds: _addStaleRefIds,
				_markRecordUnavailable: _markRecordUnavailable,
				_showStaleRefMenu: _showStaleRefMenu,
				_convertStaleRecordToDraft: _convertStaleRecordToDraft,
				_staleIdKey: _staleIdKey,
			};
		},
	};
})();

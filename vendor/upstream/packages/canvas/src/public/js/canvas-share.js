(function () {
	'use strict';
	// Manages canvas roles only; it never grants access to underlying Salesforce records.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.canvasShare = {
		mount: function mount(deps) {
			const required = [
				'canvasState',
				'csrfFetch',
				'escapeHtml',
				'showBulkToast',
				'showConfirmDialog',
				'_hasCap',
				'getWorkspacePlan',
				'refreshCapabilities',
				'_invalidateShareCountForCanvas',
			];
			if (!deps) {
				throw new Error('canvas-share.mount: missing deps object');
			}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('canvas-share.mount: missing dep ' + k);
				}
			}
			const platformShare = window.OrgLoom.platform?.share || {};
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			const showBulkToast = deps.showBulkToast;
			const showConfirmDialog = deps.showConfirmDialog;
			const _hasCap = deps._hasCap;
			const getWorkspacePlan = deps.getWorkspacePlan;
			const refreshCapabilities = deps.refreshCapabilities;
			const _invalidateShareCountForCanvas = deps._invalidateShareCountForCanvas;

			function attachSfUserPicker(
				hostEl,
				{
					onPick,
					placeholder = platformShare.searchPlaceholder || 'Search by name, email, or username…',
					changeLabel = 'Change',
					excludeCurrentUser = false,
				} = {},
			) {
				hostEl.classList.add('sf-user-picker');
				hostEl.innerHTML =
					'<input type="search" name="sf-user-search" class="sf-user-picker-input" ' +
					'placeholder="' +
					escapeHtml(placeholder) +
					'" ' +
					'autocomplete="off" spellcheck="false" ' +
					'data-bwignore="true" data-1p-ignore data-lpignore="true" data-form-type="other">' +
					'<div class="sf-user-picker-results" hidden></div>' +
					'<div class="sf-user-picker-selected" hidden></div>';
				const input = hostEl.querySelector('.sf-user-picker-input');
				const results = hostEl.querySelector('.sf-user-picker-results');
				const selected = hostEl.querySelector('.sf-user-picker-selected');

				let _seq = 0;
				let _picked = null;

				async function runSearch(q) {
					const mySeq = ++_seq;
					results.hidden = false;
					results.innerHTML = '<div class="sf-user-picker-empty">Searching…</div>';
					try {
						const url =
							'/api/sf/users/search?limit=20' +
							(excludeCurrentUser ? '&excludeCurrent=1' : '') +
							(q ? '&q=' + encodeURIComponent(q) : '');
						const r = await csrfFetch(url, { credentials: 'same-origin' });
						if (mySeq !== _seq) {
							return;
						}
						const data = await r.json().catch(() => null);
						if (!r.ok) {
							results.innerHTML =
								'<div class="sf-user-picker-empty">' +
								escapeHtml((data && data.error) || 'HTTP ' + r.status) +
								'</div>';
							return;
						}
						const currentUserKey = String(window.SF_USER_ID || '')
							.slice(0, 15)
							.toUpperCase();
						const users = ((data && data.users) || []).filter(
							(user) =>
								!excludeCurrentUser ||
								!currentUserKey ||
								String((user && user.id) || '')
									.slice(0, 15)
									.toUpperCase() !== currentUserKey,
						);
						if (users.length === 0) {
							results.innerHTML =
								'<div class="sf-user-picker-empty">No matching users in this Salesforce org. The recipient must be an active standard-license SF user with an Email on file.</div>';
							return;
						}
						results.innerHTML = users
							.map(
								(u) =>
									'<button type="button" class="sf-user-picker-row" data-user-id="' +
									escapeHtml(u.id) +
									'">' +
									'<span class="sf-user-picker-name">' +
									escapeHtml(u.name || '(no name)') +
									'</span>' +
									'<span class="sf-user-picker-email">' +
									escapeHtml(u.email || '') +
									'</span>' +
									'<span class="sf-user-picker-username">' +
									escapeHtml(u.username || '') +
									'</span>' +
									'</button>',
							)
							.join('');
						results.querySelectorAll('.sf-user-picker-row').forEach((btn) => {
							btn.addEventListener('click', () => {
								const userId = btn.dataset.userId;
								const u = users.find((x) => x.id === userId);
								if (!u) {
									return;
								}
								pick(u);
							});
						});
					} catch (err) {
						if (mySeq !== _seq) {
							return;
						}
						results.innerHTML =
							'<div class="sf-user-picker-empty">Search failed: ' +
							escapeHtml(err.message || String(err)) +
							'</div>';
					}
				}

				function pick(u) {
					_picked = u;
					input.value = '';
					input.hidden = true;
					results.hidden = true;
					selected.hidden = false;
					selected.innerHTML =
						'<span class="sf-user-picker-selected-name">' +
						escapeHtml(u.name) +
						'</span>' +
						'<span class="sf-user-picker-selected-email">' +
						escapeHtml(u.email || '') +
						'</span>' +
						'<button type="button" class="sf-user-picker-clear" title="Pick a different user" ' +
						'aria-label="' +
						escapeHtml(changeLabel) +
						'">' +
						escapeHtml(changeLabel) +
						'</button>';
					selected.querySelector('.sf-user-picker-clear').addEventListener('click', clear);
					if (typeof onPick === 'function') {
						onPick(u);
					}
				}

				function clear(options) {
					_picked = null;
					selected.hidden = true;
					selected.innerHTML = '';
					input.hidden = false;
					input.value = '';
					if (options && options.focus === false) {
						_seq += 1;
						clearTimeout(_debounce);
						results.hidden = true;
					} else {
						input.focus();
						runSearch('');
					}
					if (typeof onPick === 'function') {
						onPick(null);
					}
				}

				let _debounce;
				input.addEventListener('input', () => {
					clearTimeout(_debounce);
					const q = input.value.trim();
					_debounce = setTimeout(() => runSearch(q), 220);
				});
				input.addEventListener('focus', (event) => {
					if (_picked) {
						return;
					}
					if (results.innerHTML !== '') {
						results.hidden = false;
					} else if (event.isTrusted) {
						runSearch('');
					}
				});
				document.addEventListener('click', (ev) => {
					const eventPath = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
					if (!eventPath.includes(hostEl) && !hostEl.contains(ev.target)) {
						results.hidden = true;
					}
				});

				return {
					getPicked() {
						return _picked;
					},
					setPicked(user) {
						if (user && user.id) {
							pick(user);
						} else {
							clear();
						}
					},
					clear,
					focus() {
						if (input.hidden === false) {
							input.focus();
						}
					},
				};
			}

			function openCanvasEmailLinkModal(canvasId, canvasTitle) {
				// Sharing is deliberately progressive: choose a person and role before review appears.
				document.querySelectorAll('.canvas-share-modal').forEach((el) => el.remove());
				const modal = document.createElement('div');
				modal.className = 'modal canvas-share-modal';
				modal.innerHTML =
					'<div class="modal-overlay" data-cs-close></div>' +
					'<div class="modal-body" style="max-width:560px">' +
					'<div class="modal-header">' +
					'<h3>Share canvas - ' +
					escapeHtml(canvasTitle || 'this canvas') +
					'</h3>' +
					'<button class="modal-close" data-cs-close>&times;</button>' +
					'</div>' +
					'<div class="modal-content">' +
					'<div class="cs-form-row"><div class="cs-field-label" id="cs-teammate-label">Teammate</div>' +
					'<div id="cs-link-picker"></div></div>' +
					'<div class="cs-form-row cs-role-picker" hidden>' +
					'<div class="cs-role-label"><label class="cs-field-label" for="cs-role">Role</label>' +
					'<span class="cs-role-help"><button type="button" class="cs-role-help-trigger" aria-label="About canvas roles" aria-describedby="cs-role-description">?</button>' +
					'<span class="cs-role-tooltip" id="cs-role-description" role="tooltip">' +
					'<span><strong>Viewer</strong> — Can view the canvas.</span>' +
					'<span><strong>Contributor</strong> — Can complete requests and submit changes.</span>' +
					'<span><strong>Editor</strong> — Can edit and save the canvas.</span>' +
					'</span></span></div>' +
					'<div class="cs-role-controls">' +
					'<select id="cs-role" class="cs-access-role" aria-describedby="cs-role-description">' +
					'<option value="">Choose a role</option><option value="viewer">Viewer</option>' +
					'<option value="contributor">Contributor</option><option value="editor">Editor</option></select>' +
					'<span id="cs-share-review" hidden>' +
					'<button type="button" class="button" id="cs-link-send" disabled>Share</button>' +
					'</span></div></div>' +
					'<p class="cs-share-message" id="cs-link-msg" aria-live="polite"></p>' +
					'<section class="cs-access-section" aria-label="Existing canvas access">' +
					'<div id="cs-manage-list"><div class="tag">Loading...</div></div>' +
					'<div id="cs-access-msg" class="banner error cs-access-message" aria-live="polite" hidden></div>' +
					'</section>' +
					'</div>' +
					'<div class="modal-footer">' +
					'<button type="button" class="button secondary cs-copy-link" id="cs-share-url-copy">' +
					'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10 13a5 5 0 0 0 7 .5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>' +
					'<span class="cs-copy-label">Copy canvas link</span></button>' +
					'<button class="button secondary" data-cs-close>Close</button>' +
					'</div>' +
					'</div>';
				document.body.appendChild(modal);

				const cleanup = () => {
					modal.remove();
					document.removeEventListener('keydown', onKey);
					_invalidateShareCountForCanvas(canvasId);
				};
				const onKey = (e) => {
					if (e.key === 'Escape' && !sharing) {
						cleanup();
					}
				};
				document.addEventListener('keydown', onKey);
				modal.querySelectorAll('[data-cs-close]').forEach((el) =>
					el.addEventListener('click', () => {
						if (!sharing) cleanup();
					}),
				);

				const sendBtnEl = modal.querySelector('#cs-link-send');
				const reviewEl = modal.querySelector('#cs-share-review');
				const accessMsgEl = modal.querySelector('#cs-access-msg');
				const roleSelect = modal.querySelector('#cs-role');
				const rolePicker = modal.querySelector('.cs-role-picker');
				let sharing = false;
				let shareAccessBlocked = false;
				const selectedRole = () => roleSelect.value || null;
				function updateShareReview() {
					const picked = picker.getPicked();
					const role = selectedRole();
					const ready = !!(picked && role);
					rolePicker.hidden = !picked;
					reviewEl.hidden = !ready;
					sendBtnEl.disabled = !ready || sharing || shareAccessBlocked || !!window.ORGLOOM_MOCK;
				}
				const picker = attachSfUserPicker(modal.querySelector('#cs-link-picker'), {
					placeholder: platformShare.teammatePlaceholder || 'Pick a teammate by name, email, or username…',
					excludeCurrentUser: true,
					onPick() {
						const picked = picker.getPicked();
						const nameEl = modal.querySelector('.sf-user-picker-selected-name');
						if (nameEl && picked) nameEl.title = picked.email || '';
						msgEl.textContent = '';
						sendBtnEl.textContent = 'Share';
						updateShareReview();
					},
				});
				modal.querySelector('#cs-link-picker input').setAttribute('aria-labelledby', 'cs-teammate-label');
				roleSelect.addEventListener('change', () => {
					msgEl.textContent = '';
					updateShareReview();
				});
				if (window.ORGLOOM_MOCK) {
					const demoBanner = document.createElement('div');
					demoBanner.className = 'banner warn';
					demoBanner.style.cssText = 'margin:0 0 0.8em';
					demoBanner.innerHTML =
						'<strong>Demo mode.</strong> Sharing is disabled here: you can see what the share surface looks like, but no canvases or teammates are reachable. ' +
						'<a href="/signup?from=playground">Join the open beta</a> to share canvases with your real Salesforce teammates.';
					modal.querySelector('.modal-content').prepend(demoBanner);
					const pickerInput = modal.querySelector('#cs-link-picker .sf-user-picker-input');
					if (pickerInput) {
						pickerInput.disabled = true;
						pickerInput.placeholder = 'Sign up to share with teammates';
						pickerInput.title = 'Disabled in demo mode';
					}
					sendBtnEl.disabled = true;
					sendBtnEl.title =
						'Sharing is disabled in demo mode. Sign up to share canvases with your teammates.';
				}

				const msgEl = modal.querySelector('#cs-link-msg');
				const shareCapabilityErrors = new Set([
					'member-grant-required',
					'plan-insufficient',
					'workspace-toggle-off',
					'no-workspace',
					'not-a-member',
				]);
				function isShareCapabilityDenied(response, body) {
					return !!(response && response.status === 403 && body && shareCapabilityErrors.has(body.error));
				}
				async function handleShareCapabilityDenied(body) {
					shareAccessBlocked = true;
					const message =
						(body && (body.message || body.error)) ||
						'Sharing is no longer enabled for your account. Ask a workspace admin to restore access.';
					accessMsgEl.textContent = message;
					accessMsgEl.hidden = false;
					modal
						.querySelectorAll(
							'.cs-access-role, .cs-access-save, #cs-link-send, #cs-role, #cs-link-picker input, #cs-link-picker button',
						)
						.forEach((control) => {
							control.disabled = true;
						});
					await Promise.resolve(refreshCapabilities()).catch(() => {});
				}
				async function refreshAccessList() {
					const listEl = modal.querySelector('#cs-manage-list');
					if (!listEl) {
						return;
					}
					listEl.innerHTML = '<div class="tag">Loading...</div>';
					try {
						const response = await csrfFetch(
							'/api/canvas/' + encodeURIComponent(canvasId) + '/share-links',
							{ credentials: 'same-origin' },
						);
						const data = await response.json().catch(() => null);
						if (!response.ok) {
							throw new Error((data && data.error) || 'HTTP ' + response.status);
						}
						const directShares = (data && data.directShares) || [];
						if (directShares.length === 0) {
							listEl.innerHTML = '<div class="tag cs-manage-empty">Only you can open this canvas.</div>';
							return;
						}
						const roleOptions = (selectedRole) =>
							['viewer', 'contributor', 'editor', 'none']
								.map(
									(role) =>
										'<option value="' +
										role +
										'"' +
										(role === selectedRole ? ' selected' : '') +
										'>' +
										(role === 'none' ? 'No access' : role.charAt(0).toUpperCase() + role.slice(1)) +
										'</option>',
								)
								.join('');
						listEl.innerHTML = directShares
							.map((share) => {
								const role = share.role || (share.accessLevel === 'Collaborator' ? 'editor' : 'viewer');
								return (
									'<div class="cs-link-row" data-sf-user-id="' +
									escapeHtml(share.sfUserId) +
									'">' +
									'<div class="cs-link-person">' +
									'<span class="cs-link-person-name">' +
									escapeHtml(share.name || 'Salesforce user') +
									'</span>' +
									'</div>' +
									'<div class="cs-access-controls">' +
									'<select class="cs-access-role" aria-label="Access level for ' +
									escapeHtml(share.name || 'Salesforce user') +
									'" data-original-role="' +
									role +
									'">' +
									roleOptions(role) +
									'</select>' +
									'<button type="button" class="button cs-access-save" hidden>Save</button>' +
									'</div>' +
									'</div>'
								);
							})
							.join('');

						listEl.querySelectorAll('.cs-link-row').forEach((row) => {
							const roleSelect = row.querySelector('.cs-access-role');
							const saveButton = row.querySelector('.cs-access-save');
							const sfUserId = row.dataset.sfUserId;
							const showRoleActions = () => {
								const changed = roleSelect.value !== roleSelect.dataset.originalRole;
								saveButton.hidden = !changed;
								saveButton.classList.toggle('danger', roleSelect.value === 'none');
							};
							roleSelect.addEventListener('change', showRoleActions);
							saveButton.addEventListener('click', async () => {
								accessMsgEl.hidden = true;
								accessMsgEl.textContent = '';
								const nextRole = roleSelect.value;
								const revokeAccess = nextRole === 'none';
								if (
									revokeAccess &&
									!(await showConfirmDialog({
										title: 'Remove canvas access?',
										message:
											'This person will immediately lose access to the canvas. Their Salesforce record permissions will not change.',
										confirmLabel: 'Remove access',
										cancelLabel: 'Keep access',
										danger: true,
									}))
								) {
									return;
								}
								roleSelect.disabled = true;
								saveButton.disabled = true;
								try {
									const updateResponse = await csrfFetch(
										'/api/canvas/' +
											encodeURIComponent(canvasId) +
											'/direct-shares/' +
											encodeURIComponent(sfUserId),
										revokeAccess
											? {
													method: 'DELETE',
													credentials: 'same-origin',
												}
											: {
													method: 'PATCH',
													credentials: 'same-origin',
													headers: { 'Content-Type': 'application/json' },
													body: JSON.stringify({ role: nextRole }),
												},
									);
									const updateBody = await updateResponse.json().catch(() => ({}));
									if (!updateResponse.ok) {
										const updateError = new Error(
											(updateBody && (updateBody.message || updateBody.error)) ||
												'HTTP ' + updateResponse.status,
										);
										updateError.shareCapabilityDenied = isShareCapabilityDenied(
											updateResponse,
											updateBody,
										);
										updateError.responseBody = updateBody;
										throw updateError;
									}
									_invalidateShareCountForCanvas(canvasId);
									showBulkToast(
										revokeAccess
											? 'Canvas access removed.'
											: 'Access updated to ' +
													nextRole.charAt(0).toUpperCase() +
													nextRole.slice(1) +
													'.',
										'success',
									);
									await refreshAccessList();
								} catch (error) {
									roleSelect.value = roleSelect.dataset.originalRole;
									showRoleActions();
									if (error.shareCapabilityDenied) {
										await handleShareCapabilityDenied(error.responseBody);
									} else {
										roleSelect.disabled = false;
										saveButton.disabled = false;
										accessMsgEl.textContent = 'Access change failed: ' + (error.message || error);
										accessMsgEl.hidden = false;
									}
								}
							});
						});
					} catch (error) {
						listEl.innerHTML =
							'<div class="tag">Could not load access: ' +
							escapeHtml(error.message || String(error)) +
							'</div>';
					}
				}

				async function sendLink() {
					if (sharing || shareAccessBlocked || window.ORGLOOM_MOCK) {
						return;
					}
					const picked = picker.getPicked();
					const role = selectedRole();
					if (!picked || !role) {
						msgEl.textContent = 'Pick a teammate and choose a role first.';
						msgEl.style.color = 'var(--danger)';
						return;
					}
					sharing = true;
					sendBtnEl.disabled = true;
					try {
						modal.classList.add('hidden');
						let confirmed;
						try {
							confirmed = await showConfirmDialog({
								title: 'Grant ' + role + ' access?',
								message:
									'Give ' +
									(picked.name || picked.email || 'this teammate') +
									' ' +
									role +
									' access to this canvas.',
								confirmLabel: 'Grant access and continue',
								cancelLabel: 'Back',
							});
						} finally {
							modal.classList.remove('hidden');
						}
						if (!confirmed) return;
						msgEl.textContent = 'Sending…';
						msgEl.style.color = '';
						// The recipient is an existing workspace teammate identified by Salesforce user ID.
						const r = await csrfFetch('/api/canvas/' + encodeURIComponent(canvasId) + '/direct-share', {
							method: 'POST',
							credentials: 'same-origin',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								recipientSfUserId: picked.id,
								role,
							}),
						});
						const data = await r.json().catch(() => ({}));
						if (!r.ok) {
							if (isShareCapabilityDenied(r, data)) {
								await handleShareCapabilityDenied(data);
								msgEl.textContent = '';
								return;
							}
							if (r.status === 402) {
								msgEl.textContent = '';
								msgEl.style.color = 'var(--danger)';
								const msg = document.createElement('span');
								msg.textContent = (data && (data.message || data.error)) || 'Upgrade required.';
								const cta = document.createElement('a');
								cta.href = '/workspace/upgrade';
								cta.textContent = 'Upgrade to Pro →';
								cta.style.cssText = 'display:inline-block;margin-left:0.4em;font-weight:600';
								msgEl.appendChild(msg);
								msgEl.appendChild(cta);
								sendBtnEl.disabled = true;
								return;
							}
							throw new Error((data && (data.message || data.error)) || 'HTTP ' + r.status);
						}
						const r2 = data.recipient || {};
						const who = r2.name || r2.email || picked.email || picked.name || 'the recipient';
						roleSelect.value = '';
						picker.clear({ focus: false });
						msgEl.textContent =
							platformShare.notificationMessage?.(data) ??
							(data.emailDeliverFailed
								? 'Access granted, but the email to ' +
									who +
									' failed. Use Copy canvas link to share it.'
								: '');
						msgEl.style.color = data.emailDeliverFailed ? 'var(--warn)' : '';
						await refreshAccessList();
						modal.querySelector('#cs-share-url-copy').focus();
					} catch (err) {
						msgEl.textContent = err.message || String(err);
						msgEl.style.color = 'var(--danger)';
					} finally {
						sharing = false;
						updateShareReview();
						if (modal.isConnected && !sendBtnEl.disabled) sendBtnEl.focus();
					}
				}
				sendBtnEl.addEventListener('click', sendLink);
				const copyBtn = modal.querySelector('#cs-share-url-copy');
				const copyLabel = copyBtn.querySelector('.cs-copy-label');
				copyBtn.disabled = !!window.ORGLOOM_MOCK;
				copyBtn.addEventListener('click', async () => {
					const canvasUrl = platformShare.buildUrl
						? platformShare.buildUrl(canvasId)
						: window.location.origin +
							(window.ORGLOOM_CANVAS_PATH || '/') +
							'?openCanvas=' +
							encodeURIComponent(canvasId);
					try {
						if (navigator.clipboard && navigator.clipboard.writeText) {
							await navigator.clipboard.writeText(canvasUrl);
						} else {
							const input = document.createElement('textarea');
							input.value = canvasUrl;
							input.style.cssText = 'position:fixed;left:-9999px';
							document.body.appendChild(input);
							try {
								input.select();
								if (!document.execCommand('copy')) throw new Error('Copy failed');
							} finally {
								input.remove();
								copyBtn.focus();
							}
						}
						copyLabel.textContent = 'Copied';
						setTimeout(() => {
							copyLabel.textContent = 'Copy canvas link';
						}, 1500);
					} catch (_) {
						copyLabel.textContent = 'Copy failed';
					}
				});

				if (!_hasCap('share-canvas')) {
					const contentEl = modal.querySelector('.modal-content');
					const upgradeBanner = document.createElement('div');
					const workspacePlan = String(getWorkspacePlan() || '').toLowerCase();
					const planAllowsSharing = workspacePlan === 'pro' || workspacePlan === 'team';
					upgradeBanner.className = 'banner error';
					upgradeBanner.style.cssText = 'margin-bottom:0.8em';
					upgradeBanner.innerHTML = planAllowsSharing
						? '<strong>Sharing is not enabled for your account.</strong> ' +
							'Ask a workspace admin to enable Share canvases in Workspace settings. ' +
							'<a href="/workspace#team" style="display:inline-block;margin-top:0.4em;font-weight:600">Open Workspace settings &rarr;</a>'
						: '<strong>Sharing canvases is available on Pro and Team plans.</strong> ' +
							'Upgrade the active workspace to share canvases with teammates. ' +
							'<a href="/workspace/upgrade" style="display:inline-block;margin-top:0.4em;font-weight:600">Upgrade workspace &rarr;</a>' +
							' &middot; ' +
							'<a href="/pricing" target="_blank" rel="noopener">Compare plans</a>';
					contentEl.insertBefore(upgradeBanner, contentEl.firstChild);
					const lockTargets = [
						modal.querySelector('.cs-role-picker'),
						modal.querySelector('#cs-link-picker'),
					].filter(Boolean);
					lockTargets.forEach((el) => {
						el.style.pointerEvents = 'none';
						el.style.opacity = '0.5';
						el.querySelectorAll('input, button, textarea, select').forEach((c) => {
							c.disabled = true;
						});
					});
					const accessBtn = document.createElement('a');
					accessBtn.className = 'button';
					accessBtn.href = planAllowsSharing ? '/workspace#team' : '/workspace/upgrade';
					accessBtn.textContent = planAllowsSharing ? 'Open Workspace settings' : 'Upgrade workspace';
					sendBtnEl.replaceWith(accessBtn);
					const msgEl = modal.querySelector('#cs-link-msg');
					if (msgEl) {
						msgEl.textContent = '';
					}
				}
				if (window.ORGLOOM_MOCK) {
					const listEl = modal.querySelector('#cs-manage-list');
					if (listEl) {
						listEl.innerHTML =
							'<div class="tag cs-manage-empty">Shared access is unavailable in the demo.</div>';
					}
				} else {
					refreshAccessList();
				}
			}

			return {
				attachSfUserPicker: attachSfUserPicker,
				openCanvasEmailLinkModal: openCanvasEmailLinkModal,
			};
		},
	};
})();

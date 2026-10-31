(function () {
	'use strict';
	// Sends only selected object schema and creates new canvas drafts from accepted AI output.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.aiGenerate = {
		mount: function mount(deps) {
			if (
				!deps ||
				!deps.csrfFetch ||
				!deps.escapeHtml ||
				!deps.showBulkToast ||
				!deps.canvasState ||
				!deps.addToSelection ||
				!deps.renderBulkView ||
				!deps.getGraph ||
				!deps.startElapsedTicker
			) {
				throw new Error('ai-generate.mount: missing required deps');
			}
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			const showBulkToast = deps.showBulkToast;
			const canvasState = deps.canvasState;
			const addToSelection = deps.addToSelection;
			const renderBulkView = deps.renderBulkView;
			const pushUndo = deps.pushUndo;
			const getGraph = deps.getGraph;
			const startElapsedTicker = deps.startElapsedTicker;
			const hasCapability = typeof deps.hasCapability === 'function' ? deps.hasCapability : null;
			const isCapabilityReady = typeof deps.isCapabilityReady === 'function' ? deps.isCapabilityReady : null;
			const refreshCapabilities =
				typeof deps.refreshCapabilities === 'function' ? deps.refreshCapabilities : null;
			const getWorkspacePlan = typeof deps.getWorkspacePlan === 'function' ? deps.getWorkspacePlan : null;
			const showBulkToastWithAction =
				typeof deps.showBulkToastWithAction === 'function' ? deps.showBulkToastWithAction : null;
			const canvasCapCheck =
				typeof deps.canvasCapCheck === 'function'
					? deps.canvasCapCheck
					: function () {
							return { ok: true, blocked: false, reason: null };
						};

			let _aiEnabled = null;
			let _aiUsage = null;

			function getAccessState() {
				if (!hasCapability) {
					return { ready: true, allowed: true };
				}
				if (isCapabilityReady && !isCapabilityReady()) {
					return { ready: false, allowed: false };
				}
				const allowed = !!hasCapability('generate-records-with-ai');
				const plan = getWorkspacePlan ? getWorkspacePlan() : null;
				return {
					ready: true,
					allowed: allowed,
					reason: !allowed && plan && plan !== 'pro' && plan !== 'team' ? 'plan-insufficient' : null,
				};
			}

			function showAiAccessBlocked(access) {
				const planBlocked = access && access.reason === 'plan-insufficient';
				const message = planBlocked
					? 'Generate with AI is available on Pro and Team plans. Upgrade the active workspace to use it.'
					: 'Generate with AI is not enabled for your account in this workspace. Ask a workspace admin to grant the Generate with AI permission.';
				if (showBulkToastWithAction) {
					showBulkToastWithAction(
						message,
						planBlocked ? 'View plans' : 'Open workspace permissions',
						function () {
							window.location.href = planBlocked ? '/pricing' : '/workspace#team-members';
						},
						'error',
					);
					return;
				}
				showBulkToast(message, 'error');
			}

			async function checkAiStatus(force) {
				if (!force && _aiEnabled !== null) {
					return _aiEnabled;
				}
				try {
					const resp = await csrfFetch('/api/ai/status', {
						credentials: 'same-origin',
					});
					if (!resp.ok) {
						_aiEnabled = false;
						_aiUsage = null;
						return false;
					}
					const data = await resp.json();
					_aiEnabled = !!data.enabled;
					_aiUsage = data.usage || null;
				} catch (e) {
					_aiEnabled = false;
					_aiUsage = null;
				}
				return _aiEnabled;
			}

			const aiGenModal = document.createElement('div');
			aiGenModal.className = 'modal hidden';
			aiGenModal.innerHTML =
				'<div class="modal-overlay" data-ai-close></div>' +
				'<div class="modal-body" style="max-width:720px">' +
				'<div class="modal-header">' +
				'<h3>Generate records from description</h3>' +
				'<button class="modal-close" data-ai-close>&times;</button>' +
				'</div>' +
				'<div id="ai-gen-usage-banner"></div>' +
				'<div class="modal-content" id="ai-gen-content"></div>' +
				'<div class="modal-footer" id="ai-gen-footer"></div>' +
				'</div>';
			document.body.appendChild(aiGenModal);
			aiGenModal
				.querySelectorAll('[data-ai-close]')
				.forEach((el) => el.addEventListener('click', closeAiGenModal));
			document.addEventListener('keydown', (e) => {
				if (e.key === 'Escape' && !aiGenModal.classList.contains('hidden')) {
					closeAiGenModal();
				}
			});

			let aiGenState = null; // { step, scope, text, plan, warnings, usage }
			let _aiElapsedStop = null;

			function presentAiPlanError(resp, data) {
				const rawCode = data && (data.code || data.error);
				const code = typeof rawCode === 'string' ? rawCode.toLowerCase().replace(/_/g, '-') : '';
				const rawError = data && data.error;
				const humanError = typeof rawError === 'string' && /[\s.!?]/.test(rawError) ? rawError : '';
				const defaults = {
					'cap-reached':
						'This workspace has used its monthly AI allowance. Wait for it to reset or ask a workspace admin to review billing and AI credits.',
					'plan-insufficient':
						'Generate with AI is available on Pro and Team plans. Upgrade the active workspace to use it.',
					'member-grant-required':
						'Generate with AI is not enabled for your account in this workspace. Ask a workspace admin to grant the Generate with AI permission.',
					'workspace-toggle-off':
						'AI access is disabled for this workspace. A workspace admin can enable it in Workspace settings.',
					'no-workspace': 'Select or create a workspace before using Generate with AI.',
					'no-active-workspace': 'Select or create a workspace before using Generate with AI.',
					'not-a-member':
						'Your account is not a member of the active workspace. Switch workspaces or ask a workspace admin to add you.',
					'ai-disabled':
						'Generate with AI is temporarily unavailable. Try again later or contact Org Loom support if the problem continues.',
					'sf-session-expired':
						'Your Salesforce connection has expired. Reconnect the org, then try Generate with AI again.',
				};
				const message =
					(data && data.message) ||
					humanError ||
					defaults[code] ||
					(resp && resp.status >= 500
						? 'Generate with AI could not complete the request. Try again, and contact support if the problem continues.'
						: 'Generate with AI could not complete the request. Check your selections and try again.');

				let action = null;
				if (code === 'cap-reached') {
					action = { href: '/workspace#billing', label: 'Review AI usage', attr: ' data-ai-open-account' };
				} else if (code === 'plan-insufficient' || code === 'ai-not-included') {
					action = { href: '/pricing', label: 'View plans' };
				} else if (code === 'workspace-toggle-off') {
					action = { href: '/workspace#team-flags', label: 'Open workspace settings' };
				} else if (code === 'no-workspace' || code === 'no-active-workspace' || code === 'not-a-member') {
					action = { href: '/workspace', label: 'Choose a workspace' };
				} else if (code === 'sf-session-expired') {
					action = {
						href: window.ORGLOOM_CANVAS_PATH || '/',
						label: 'Return to canvas and reconnect',
					};
				}
				return { code, message, action };
			}

			async function openAiGenModal() {
				let access = getAccessState();
				if (!access.ready && refreshCapabilities) {
					await refreshCapabilities();
					access = getAccessState();
				}
				if (!access.allowed) {
					showAiAccessBlocked(access);
					return false;
				}
				aiGenState = { step: 'scope', scope: { objects: [] } };
				aiGenModal.classList.remove('hidden');
				renderAiUsageBanner();
				renderAiGenStepScope();

				try {
					await checkAiStatus(true);
					if (!aiGenModal.classList.contains('hidden')) {
						renderAiUsageBanner();
					}
				} catch (_) {}
				return true;
			}
			function closeAiGenModal() {
				aiGenModal.classList.add('hidden');
				aiGenState = null;
				if (_aiElapsedStop) {
					_aiElapsedStop();
					_aiElapsedStop = null;
				}
			}

			function renderAiUsageBanner() {
				const el = aiGenModal.querySelector('#ai-gen-usage-banner');
				if (!el) {
					return;
				}
				const u = _aiUsage;
				if (!u || !Number.isFinite(u.percentUsed) || u.percentUsed < 90) {
					el.innerHTML = '';
					return;
				}
				const planLabel = escapeHtml(u.planLabel || u.plan || '');
				const used = Number(u.tokensUsed || 0).toLocaleString();
				const cap = Number(u.tokenCap || 0).toLocaleString();
				if (u.atCap) {
					const fallback =
						u.creditsRemaining > 0
							? ' Next generation will draw from <strong>' +
								Number(u.creditsRemaining).toLocaleString() +
								'</strong> workspace credits.'
							: ' Next generation will fail until the 1st-of-month reset, or an admin tops up workspace credits.';
					el.innerHTML =
						'<div class="banner error" style="margin:0.6em 0.9em 0">' +
						'<strong>You’ve hit your ' +
						cap +
						'-token monthly AI cap on the ' +
						planLabel +
						' plan.</strong>' +
						fallback +
						'</div>';
					return;
				}
				el.innerHTML =
					'<div class="banner" style="margin:0.6em 0.9em 0;background:#fff4e0;color:#7a4500;border:1px solid #f0c277">' +
					'<strong>Heads up:</strong> you’ve used <strong>' +
					u.percentUsed +
					'%</strong> of your monthly AI tokens (' +
					used +
					' / ' +
					cap +
					' on the ' +
					planLabel +
					' plan). After the cap, generations fall back to workspace credits or wait for the 1st-of-month reset.' +
					'</div>';
			}

			function renderAiGenStepScope() {
				const body = aiGenModal.querySelector('#ai-gen-content');
				const footer = aiGenModal.querySelector('#ai-gen-footer');

				const scope = aiGenState.scope || { objects: [] };
				aiGenState.scope = scope;
				const isPicked = (name) => scope.objects.some((o) => o.name === name);

				body.innerHTML =
					'<p class="tag">Pick the objects you want the AI to generate. The AI sees all of each object’s createable fields and relationships.</p>' +
					'<div class="ai-scope-pane">' +
					'<input type="search" class="ai-scope-search" id="ai-scope-search" placeholder="Filter objects…" autocomplete="off">' +
					'<div class="ai-scope-list" id="ai-scope-objects"></div>' +
					'</div>';

				const objectsList = body.querySelector('#ai-scope-objects');
				const searchInput = body.querySelector('#ai-scope-search');

				const renderObjects = () => {
					const q = (searchInput.value || '').toLowerCase().trim();
					const all = Array.isArray(canvasState.allObjects) ? canvasState.allObjects : [];
					const filtered = all
						.filter((o) => o.queryable !== false)
						.filter(
							(o) =>
								!q ||
								(o.name || '').toLowerCase().includes(q) ||
								(o.label || '').toLowerCase().includes(q),
						)
						.slice(0, 200);
					if (canvasState.allObjects === null) {
						objectsList.innerHTML = '<div class="ai-scope-empty">Loading objects…</div>';
						return;
					}
					if (filtered.length === 0) {
						objectsList.innerHTML = '<div class="ai-scope-empty">No matching objects.</div>';
						return;
					}
					objectsList.innerHTML = filtered
						.map((o) => {
							const checked = isPicked(o.name) ? 'checked' : '';
							return (
								'<label class="ai-scope-row"><input type="checkbox" data-ai-obj="' +
								escapeHtml(o.name) +
								'" ' +
								checked +
								'>' +
								'<span class="ai-scope-row-label">' +
								escapeHtml(o.label || o.name) +
								'</span>' +
								'<span class="ai-scope-row-name">' +
								escapeHtml(o.name) +
								'</span>' +
								'</label>'
							);
						})
						.join('');
				};

				objectsList.addEventListener('change', (ev) => {
					const cb = ev.target.closest('[data-ai-obj]');
					if (!cb) {
						return;
					}
					const name = cb.dataset.aiObj;
					if (cb.checked) {
						if (!isPicked(name)) {
							scope.objects.push({ name });
						}
					} else {
						scope.objects = scope.objects.filter((o) => o.name !== name);
					}
					updateNextButton();
				});
				searchInput.addEventListener('input', renderObjects);

				footer.innerHTML =
					'<button class="button secondary" data-ai-close>Cancel</button>' +
					'<button class="button" id="ai-scope-next" disabled>Next: write prompt</button>';
				footer
					.querySelectorAll('[data-ai-close]')
					.forEach((el) => el.addEventListener('click', closeAiGenModal));
				const nextBtn = footer.querySelector('#ai-scope-next');
				const updateNextButton = () => {
					nextBtn.disabled = scope.objects.length === 0;
				};
				updateNextButton();
				nextBtn.addEventListener('click', () => {
					aiGenState.step = 'prompt';
					renderAiGenStepPrompt();
				});

				renderObjects();
				if (canvasState.allObjects === null) {
					const _arrival = setInterval(() => {
						if (!aiGenModal.contains(objectsList) || aiGenModal.classList.contains('hidden')) {
							clearInterval(_arrival);
							return;
						}
						if (canvasState.allObjects !== null) {
							clearInterval(_arrival);
							renderObjects();
						}
					}, 300);
				}
				setTimeout(() => searchInput.focus(), 0);
			}

			function renderAiGenStepPrompt() {
				const body = aiGenModal.querySelector('#ai-gen-content');
				const footer = aiGenModal.querySelector('#ai-gen-footer');
				const scope = aiGenState.scope || { objects: [] };
				const scopeSummary = scope.objects.map((o) => o.name).join(', ');
				const prevText = aiGenState.text || '';
				body.innerHTML =
					'<div class="field">' +
					'<label for="ai-gen-prompt">Description</label>' +
					'<textarea id="ai-gen-prompt" rows="5" placeholder="e.g. 5 retail customers in California, each with 2-3 contacts and a pending Opportunity">' +
					escapeHtml(prevText) +
					'</textarea>' +
					'</div>' +
					'<div class="tag">Scope: <span class="workspace-info-tooltip ai-scope-help">' +
					'<button type="button" class="workspace-info-tooltip-trigger" aria-label="About scope" aria-describedby="ai-scope-help-text">?</button>' +
					'<span class="workspace-info-tooltip-content" id="ai-scope-help-text" role="tooltip">The AI generates records only for the objects you picked.</span>' +
					'</span> <code>' +
					escapeHtml(scopeSummary) +
					'</code></div>';
				footer.innerHTML =
					'<button class="button secondary" data-ai-close>Cancel</button>' +
					'<button class="button secondary" id="ai-prompt-back">Back</button>' +
					'<button class="button" id="ai-gen-submit">Generate</button>';
				footer
					.querySelectorAll('[data-ai-close]')
					.forEach((el) => el.addEventListener('click', closeAiGenModal));
				footer.querySelector('#ai-prompt-back').addEventListener('click', () => {
					aiGenState.text = body.querySelector('#ai-gen-prompt').value || '';
					aiGenState.step = 'scope';
					renderAiGenStepScope();
				});
				footer.querySelector('#ai-gen-submit').addEventListener('click', submitAiGen);
				setTimeout(() => {
					const t = body.querySelector('#ai-gen-prompt');
					if (t) {
						t.focus();
					}
				}, 0);
			}

			async function submitAiGen() {
				if (window.ORGLOOM_MOCK) {
					return;
				}
				const text = (aiGenModal.querySelector('#ai-gen-prompt').value || '').trim();
				if (!text) {
					showBulkToast('Type a description first.', 'error');
					return;
				}
				aiGenState.text = text;
				const scope = aiGenState.scope || { objects: [] };
				const uniqNames = scope.objects.map((o) => o.name);

				for (const name of uniqNames) {
					if (!canvasState.selectedObjects.some((s) => s.name === name)) {
						try {
							await addToSelection(name);
						} catch (e) {}
					}
				}
				const body = aiGenModal.querySelector('#ai-gen-content');
				const footer = aiGenModal.querySelector('#ai-gen-footer');
				body.innerHTML =
					'<p class="center busy-row" style="justify-content:center">' +
					'<span class="busy-spinner lg"></span>' +
					'<span><strong>Generating…</strong></span>' +
					'<span class="busy-elapsed" id="ai-elapsed"></span>' +
					'</p>' +
					'<p class="tag center">Claude is reading your selected schema and drafting a plan. This usually takes 10–30 seconds; complex prompts can take longer.</p>';
				if (_aiElapsedStop) {
					_aiElapsedStop();
				}
				_aiElapsedStop = startElapsedTicker(body.querySelector('#ai-elapsed'));
				footer.innerHTML = '<button class="button secondary" data-ai-close>Cancel</button>';
				footer
					.querySelectorAll('[data-ai-close]')
					.forEach((el) => el.addEventListener('click', closeAiGenModal));

				// Send only the explicitly selected object names; the server supplies their permitted schema.
				const callOnce = () =>
					csrfFetch('/api/ai/plan', {
						method: 'POST',
						credentials: 'same-origin',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ text, objectNames: uniqNames }),
					});
				let resp;
				try {
					try {
						resp = await callOnce();
					} catch (e) {
						body.innerHTML = '<p class="center tag">Network hiccup, retrying…</p>';
						await new Promise((r) => setTimeout(r, 1500));
						try {
							resp = await callOnce();
						} catch (e2) {
							body.innerHTML =
								'<div class="banner error">Couldn’t reach the server. Check your connection and try again.<br><small>' +
								escapeHtml(e2.message || String(e2)) +
								'</small></div>';
							footer.innerHTML = '<button class="button secondary" data-ai-close>Close</button>';
							footer
								.querySelectorAll('[data-ai-close]')
								.forEach((el) => el.addEventListener('click', closeAiGenModal));
							return;
						}
					}
					let data;
					try {
						data = await resp.json();
					} catch (e) {
						data = null;
					}
					if (!resp.ok) {
						const presented = presentAiPlanError(resp, data);
						body.innerHTML =
							'<div class="banner error">' +
							escapeHtml(presented.message) +
							'</div>' +
							(presented.code === 'cap-reached' && data.tokensUsed != null && data.tokenCap != null
								? '<p class="tag" style="margin-top:0.4em">Used <strong>' +
									Number(data.tokensUsed).toLocaleString() +
									'</strong> of ' +
									Number(data.tokenCap).toLocaleString() +
									' tokens this month.</p>'
								: '');
						footer.innerHTML =
							(presented.action
								? '<a class="button" href="' +
									escapeHtml(presented.action.href) +
									'"' +
									(presented.action.attr || '') +
									'>' +
									escapeHtml(presented.action.label) +
									'</a>'
								: '') + '<button class="button secondary" data-ai-close>Close</button>';
						footer
							.querySelectorAll('[data-ai-close]')
							.forEach((el) => el.addEventListener('click', closeAiGenModal));
						return;
					}
					aiGenState = Object.assign({}, aiGenState, {
						text,
						plan: data,
					});
					renderAiGenStep2();
				} finally {
					if (_aiElapsedStop) {
						_aiElapsedStop();
						_aiElapsedStop = null;
					}
				}
			}

			function renderAiGenStep2() {
				if (!aiGenState) {
					return;
				}
				const { plan } = aiGenState;
				const body = aiGenModal.querySelector('#ai-gen-content');
				const footer = aiGenModal.querySelector('#ai-gen-footer');
				const records = plan.records || [];
				const associations = plan.associations || [];
				const warnings = plan.warnings || [];
				const countsByType = new Map();
				records.forEach((r) => {
					countsByType.set(r.objectName, (countsByType.get(r.objectName) || 0) + 1);
				});
				const chipsHtml = Array.from(countsByType.entries())
					.map(([n, c]) => `<span class="ai-gen-chip">${escapeHtml(n)} <b>×${c}</b></span>`)
					.join('');
				const recsHtml = records
					.map((r) => {
						const entries = Object.entries(r.values || {});
						const fieldsHtml = entries
							.slice(0, 5)
							.map(
								([k, v]) =>
									`<div class="ai-gen-rec-field"><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd></div>`,
							)
							.join('');
						const moreCount = entries.length - 5;
						const extraHtml =
							entries.length === 0
								? `<div class="ai-gen-rec-more">No fields set</div>`
								: moreCount > 0
									? `<div class="ai-gen-rec-more">+${moreCount} more field${moreCount === 1 ? '' : 's'}</div>`
									: '';
						return `<div class="ai-gen-rec"><div class="ai-gen-rec-head"><span class="ai-gen-rec-obj">${escapeHtml(r.objectName)}</span><span class="ai-gen-rec-id">#${escapeHtml(String(r.tempId))}</span></div><dl class="ai-gen-rec-fields">${fieldsHtml}</dl>${extraHtml}</div>`;
					})
					.join('');
				const warnItems = warnings
					.slice(0, 12)
					.map((w) => `<li>${escapeHtml(w)}</li>`)
					.join('');
				const warnMore =
					warnings.length > 12 ? `<li class="ai-gen-warns-more">… ${warnings.length - 12} more</li>` : '';
				const warningsHtml =
					warnings.length > 0
						? `<div class="ai-gen-warns"><button type="button" class="ai-gen-warns-toggle" id="ai-gen-warns-toggle" aria-expanded="false"><span class="ai-gen-warns-icon">⚠</span> ${warnings.length} adjustment${warnings.length === 1 ? '' : 's'} <span class="ai-gen-warns-caret">▸</span></button><ul class="ai-gen-warns-list" id="ai-gen-warns-list" hidden>${warnItems}${warnMore}</ul></div>`
						: '';
				const headlineHtml = `<div class="ai-gen-headline"><span class="ai-gen-check">✓</span><span class="ai-gen-headline-num">${records.length}</span><span class="ai-gen-headline-label">record${records.length === 1 ? '' : 's'} ready</span>${associations.length > 0 ? `<span class="ai-gen-headline-sub">· ${associations.length} link${associations.length === 1 ? '' : 's'}</span>` : ''}</div>`;
				body.innerHTML =
					records.length > 0
						? headlineHtml +
							`<div class="ai-gen-chips">${chipsHtml}</div>` +
							`<div class="ai-gen-preview-head">Preview</div>` +
							`<div class="ai-gen-recs">${recsHtml}</div>` +
							warningsHtml
						: `<div class="ai-gen-empty"><div class="ai-gen-empty-icon">✨</div><div class="ai-gen-empty-title">No records to add</div><div class="ai-gen-empty-hint">The AI couldn’t turn that into valid records; try rephrasing your description or adjusting the scope.</div></div>` +
							warningsHtml;
				const warnsToggle = body.querySelector('#ai-gen-warns-toggle');
				if (warnsToggle) {
					warnsToggle.addEventListener('click', () => {
						const list = body.querySelector('#ai-gen-warns-list');
						const open = warnsToggle.getAttribute('aria-expanded') === 'true';
						warnsToggle.setAttribute('aria-expanded', open ? 'false' : 'true');
						if (list) {
							list.hidden = open;
						}
					});
				}

				footer.innerHTML =
					'<button class="button secondary" data-ai-close>Cancel</button>' +
					'<button class="button ghost" id="ai-gen-regen">Regenerate</button>' +
					'<button class="button" id="ai-gen-apply"' +
					(records.length === 0 ? ' disabled' : '') +
					'>Apply ' +
					records.length +
					' to canvas</button>';
				footer
					.querySelectorAll('[data-ai-close]')
					.forEach((el) => el.addEventListener('click', closeAiGenModal));
				footer.querySelector('#ai-gen-regen').addEventListener('click', () => {
					const prev = aiGenState ? aiGenState.text : '';
					renderAiGenStepPrompt();
					const t = aiGenModal.querySelector('#ai-gen-prompt');
					if (t) {
						t.value = prev;
					}
				});
				const applyBtn = footer.querySelector('#ai-gen-apply');
				if (applyBtn) {
					applyBtn.addEventListener('click', () => {
						applyAiPlan(plan);
					});
				}
			}

			function applyAiPlan(plan) {
				// AI output is staged as new drafts. It never updates Salesforce or existing canvas records.
				const records = plan.records || [];
				const associations = plan.associations || [];
				const _aiCap = canvasCapCheck(records.length);
				if (_aiCap.blocked) {
					showBulkToast(_aiCap.reason);
					return;
				}
				// Preserve the complete pre-apply canvas so the plan can be undone as one action.
				const _preAi = {
					bulkRecords: canvasState.bulkRecords.slice(),
					bulkAssociations: canvasState.bulkAssociations.slice(),
					bulkSelectedIds: new Set(canvasState.bulkSelectedIds),
					bulkSelectedEdgeId: canvasState.bulkSelectedEdgeId,
					bulkInitialized: canvasState.bulkInitialized,
				};
				const adj = new Map();
				records.forEach((r) => adj.set(r.tempId, new Set()));
				associations.forEach((a) => {
					if (adj.has(a.fromTempId) && adj.has(a.toTempId)) {
						adj.get(a.fromTempId).add(a.toTempId);
						adj.get(a.toTempId).add(a.fromTempId);
					}
				});
				const visited = new Set();
				const clusters = [];
				records.forEach((r) => {
					if (visited.has(r.tempId)) {
						return;
					}
					const members = [];
					const queue = [r.tempId];
					visited.add(r.tempId);
					while (queue.length > 0) {
						const cur = queue.shift();
						members.push(cur);
						for (const n of adj.get(cur) || []) {
							if (!visited.has(n)) {
								visited.add(n);
								queue.push(n);
							}
						}
					}
					clusters.push(members);
				});

				const inDeg = new Map();
				records.forEach((r) => inDeg.set(r.tempId, 0));
				associations.forEach((a) => {
					if (inDeg.has(a.toTempId)) {
						inDeg.set(a.toTempId, (inDeg.get(a.toTempId) || 0) + 1);
					}
				});

				function layoutCluster(memberIds) {
					const memberSet = new Set(memberIds);
					let rootId = memberIds[0];
					let rootDeg = -1;
					for (const id of memberIds) {
						const d = inDeg.get(id) || 0;
						if (d > rootDeg) {
							rootDeg = d;
							rootId = id;
						}
					}
					const levels = [[rootId]];
					const seen = new Set([rootId]);
					while (true) {
						const last = levels[levels.length - 1];
						const next = [];
						for (const id of last) {
							for (const n of adj.get(id) || []) {
								if (!memberSet.has(n) || seen.has(n)) {
									continue;
								}
								seen.add(n);
								next.push(n);
							}
						}
						if (next.length === 0) {
							break;
						}
						levels.push(next);
					}

					memberIds.forEach((id) => {
						if (!seen.has(id)) {
							levels.push([id]);
						}
					});
					return levels;
				}
				const clusterLayouts = clusters.map(layoutCluster);
				const NODE_W = 200;
				const NODE_H = 140;
				const INTRA_GAP_X = 40;
				const INTRA_GAP_Y = 80;
				const CLUSTER_GAP_X = 90;
				const CLUSTER_GAP_Y = 90;

				const clusterSizes = clusterLayouts.map((levels) => {
					const maxLevelWidth = Math.max(...levels.map((L) => L.length));
					return {
						width: maxLevelWidth * (NODE_W + INTRA_GAP_X),
						height: levels.length * (NODE_H + INTRA_GAP_Y),
					};
				});

				const clustersPerRow = Math.max(1, Math.ceil(Math.sqrt(clusters.length)));

				const recordPositions = {};
				let startCurY = CLUSTER_GAP_Y;
				let maxBottom = 0;
				canvasState.bulkRecords.forEach((r) => {
					if (typeof r.x !== 'number' || typeof r.y !== 'number') {
						return;
					}
					const halfH = r.isTypeNode ? 65 : 90;
					const bottom = r.y + halfH;
					if (bottom > maxBottom) {
						maxBottom = bottom;
					}
				});
				if (maxBottom > 0) {
					startCurY = maxBottom + CLUSTER_GAP_Y;
				}
				let curX = CLUSTER_GAP_X;
				let curY = startCurY;
				let rowHeight = 0;
				clusterLayouts.forEach((levels, ci) => {
					const size = clusterSizes[ci];
					levels.forEach((levelIds, levelIdx) => {
						const levelPixelWidth = levelIds.length * (NODE_W + INTRA_GAP_X);
						const startInCluster = curX + (size.width - levelPixelWidth) / 2 + NODE_W / 2;
						levelIds.forEach((id, i) => {
							recordPositions[id] = {
								x: startInCluster + i * (NODE_W + INTRA_GAP_X),
								y: curY + levelIdx * (NODE_H + INTRA_GAP_Y) + NODE_H / 2,
							};
						});
					});
					rowHeight = Math.max(rowHeight, size.height);
					if ((ci + 1) % clustersPerRow === 0) {
						curX = CLUSTER_GAP_X;
						curY += rowHeight + CLUSTER_GAP_Y;
						rowHeight = 0;
					} else {
						curX += size.width + CLUSTER_GAP_X;
					}
				});

				const idMap = new Map();
				records.forEach((r) => {
					const newId = canvasState.bulkIdSeq++;
					idMap.set(r.tempId, newId);
					const matchingSel = canvasState.selectedObjects.find((s) => s.name === r.objectName);
					const pos = recordPositions[r.tempId] || { x: 200, y: 200 };
					canvasState.bulkRecords.push({
						id: newId,
						objectName: r.objectName,
						label: (matchingSel && matchingSel.label) || r.objectName,
						fromSelectionId: matchingSel ? matchingSel.id : null,
						x: pos.x,
						y: pos.y,
						values: r.values || {},
					});
				});
				const _importShared = window.OrgLoom.importShared;
				const _usedFk = new Set(canvasState.bulkAssociations.map((x) => x.fromId + '::' + x.fieldName));
				let _skippedAssoc = 0;
				associations.forEach((a) => {
					const from = idMap.get(a.fromTempId);
					const to = idMap.get(a.toTempId);
					if (!_importShared.admitAssociation(_usedFk, from, to, a && a.fieldName)) {
						_skippedAssoc += 1;
						return;
					}
					canvasState.bulkAssociations.push({
						id: canvasState.bulkIdSeq++,
						fromId: from,
						toId: to,
						fieldName: a.fieldName,
					});
				});
				canvasState.bulkInitialized = true;
				closeAiGenModal();
				renderBulkView();
				if (typeof pushUndo === 'function') {
					pushUndo('AI generate', function () {
						canvasState.bulkRecords = _preAi.bulkRecords;
						canvasState.bulkAssociations = _preAi.bulkAssociations;
						canvasState.bulkSelectedIds = _preAi.bulkSelectedIds;
						canvasState.bulkSelectedEdgeId = _preAi.bulkSelectedEdgeId;
						canvasState.bulkInitialized = _preAi.bulkInitialized;
						renderBulkView();
					});
				}

				const graph = getGraph();
				const canvasEl = graph && graph.querySelector ? graph.querySelector('#bulk-canvas') : null;
				if (canvasEl) {
					canvasEl.scrollLeft = 0;
					if (maxBottom === 0) {
						canvasEl.scrollTop = 0;
					} else {
						canvasEl.scrollTop = Math.max(0, startCurY - CLUSTER_GAP_Y);
					}
				}
				const n = records.length;
				const groupsMsg = clusters.length > 1 ? ' in ' + clusters.length + ' groups' : '';
				showBulkToast(
					'Added ' +
						n +
						' AI-generated record' +
						(n === 1 ? '' : 's') +
						' to the canvas' +
						groupsMsg +
						'.' +
						_importShared.skipSuffix(0, _skippedAssoc),
				);
			}

			return {
				openModal: openAiGenModal,
				checkStatus: checkAiStatus,
				getAccessState: getAccessState,
				isEnabled: function isEnabled() {
					return _aiEnabled;
				},
			};
		},
	};
})();

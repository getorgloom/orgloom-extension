(function () {
	'use strict';
	// Serves live canvas reads to the authenticated MCP relay without persisting canvas data there.

	if (!document.getElementById('app-root')) {
		return;
	}
	if (window.ORGLOOM_MOCK) {
		return;
	}

	function csrfFetch(url, options) {
		options = options || {};
		const method = (options.method || 'GET').toUpperCase();
		if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
			const meta = document.querySelector('meta[name="csrf-token"]');
			const token = meta ? meta.getAttribute('content') : '';
			options.headers = Object.assign({}, options.headers || {}, {
				'x-csrf-token': token,
				'content-type': 'application/json',
			});
		}
		if (!('credentials' in options)) {
			options.credentials = 'same-origin';
		}
		return globalThis.fetch(url, options);
	}

	let _connectionId = null;
	let _registeredCanvasId = null;
	let _eventSource = null;
	let _connectAttempts = 0;
	let _statusCheck = null;

	function _setMcpAvailability(active) {
		const next = active === true;
		window.ORGLOOM_MCP_ACTIVE = next;
		window.dispatchEvent(
			new CustomEvent('orgloom:mcp-availability', {
				detail: { active: next },
			}),
		);
		if (!next && _registeredCanvasId) {
			_unregister(_registeredCanvasId);
		}
	}

	function _log(...args) {
		try {
			if (localStorage.getItem('orgloomRelayDebug') === '1') {
				console.log('[mcp-relay]', ...args);
			}
		} catch (e) {
			/* private mode etc. */
		}
	}

	async function _connect() {
		if (_eventSource || _statusCheck) {
			return _statusCheck;
		}
		_statusCheck = csrfFetch('/api/mcp/relay/status', { credentials: 'same-origin' })
			.then((response) => (response.ok ? response.json() : null))
			.catch(() => null);
		const status = await _statusCheck;
		_statusCheck = null;
		if (!status || status.active !== true) {
			_setMcpAvailability(false);
			return;
		}
		_connectAttempts++;
		_log('opening SSE (attempt ' + _connectAttempts + ')');
		_eventSource = new EventSource('/api/mcp/relay/listen', { withCredentials: true });
		_eventSource.addEventListener('ready', (ev) => {
			try {
				const data = JSON.parse(ev.data);
				_connectionId = data.connectionId;
				_connectAttempts = 0;
				if (typeof data.mcpActive === 'boolean') {
					_setMcpAvailability(data.mcpActive);
				}
				_log('connected, connectionId=' + _connectionId);
				_maybeRegisterCurrent();
			} catch (e) {
				_log('bad ready payload:', e);
			}
		});
		_eventSource.addEventListener('mcp-availability', (ev) => {
			try {
				const data = JSON.parse(ev.data);
				_setMcpAvailability(data.active === true);
				if (data.active === true) {
					_maybeRegisterCurrent();
				}
			} catch (e) {
				_log('bad MCP availability payload:', e);
			}
		});
		_eventSource.addEventListener('request', (ev) => {
			let data;
			try {
				data = JSON.parse(ev.data);
			} catch (e) {
				_log('bad request payload:', e);
				return;
			}
			_handleRequest(data);
		});
		_eventSource.addEventListener('ai-proposals-changed', (ev) => {
			try {
				const data = JSON.parse(ev.data);
				window.dispatchEvent(
					new CustomEvent('orgloom:ai-proposals-changed', {
						detail: { canvasId: data.canvasId || null },
					}),
				);
			} catch (e) {
				_log('bad proposal-change payload:', e);
			}
		});
		_eventSource.onerror = (err) => {
			_log('SSE error, will auto-retry:', err);
			if (_eventSource && _eventSource.readyState === EventSource.CLOSED) {
				_eventSource = null;
				_connectionId = null;
			}
		};
	}

	async function _handleRequest({ requestId, method, canvasId, params }) {
		// Reject reads for canvases that are not registered in this visible browser session.
		_log('handle request:', method, canvasId, requestId);
		try {
			let result;
			if (method === 'read_canvas') {
				const snap = window.Orgloom && window.Orgloom.canvasState && window.Orgloom.canvasState.snapshot;
				if (typeof snap !== 'function') {
					return _postResponse(requestId, null, 'canvas-snapshot-not-available');
				}
				if (canvasId !== _registeredCanvasId) {
					return _postResponse(requestId, null, 'canvas-not-registered-here');
				}
				result = snap({ canvasId });
			} else if (method === 'describe_object') {
				const dsc = window.Orgloom && window.Orgloom.canvasState && window.Orgloom.canvasState.describeObject;
				if (typeof dsc !== 'function') {
					return _postResponse(requestId, null, 'describe-not-available');
				}
				result = dsc(params || {});
			} else {
				return _postResponse(requestId, null, 'unknown-method:' + method);
			}
			await _postResponse(requestId, result, null);
		} catch (err) {
			_log('request handler error:', err);
			await _postResponse(requestId, null, (err && err.message) || 'handler-error');
		}
	}

	async function _postResponse(requestId, result, error) {
		if (!_connectionId) {
			return;
		}
		try {
			await csrfFetch('/api/mcp/relay/respond', {
				method: 'POST',
				body: JSON.stringify({ connectionId: _connectionId, requestId, result, error }),
			});
		} catch (e) {
			_log('respond POST failed:', e);
		}
	}

	async function _register(canvasId, meta) {
		if (!_connectionId || window.ORGLOOM_MCP_ACTIVE !== true) {
			return;
		}
		_registeredCanvasId = canvasId;
		try {
			await csrfFetch('/api/mcp/relay/register', {
				method: 'POST',
				body: JSON.stringify({ connectionId: _connectionId, canvasId, meta: meta || {} }),
			});
			_log('registered canvas', canvasId);
		} catch (e) {
			_log('register POST failed:', e);
		}
	}

	async function _unregister(canvasId) {
		if (!_connectionId || !canvasId) {
			return;
		}
		if (_registeredCanvasId === canvasId) {
			_registeredCanvasId = null;
		}
		try {
			await csrfFetch('/api/mcp/relay/unregister', {
				method: 'POST',
				body: JSON.stringify({ connectionId: _connectionId, canvasId }),
			});
			_log('unregistered canvas', canvasId);
		} catch (e) {
			_log('unregister POST failed:', e);
		}
	}

	let _pendingLoad = null;
	function _maybeRegisterCurrent() {
		if (window.ORGLOOM_MCP_ACTIVE !== true) {
			return;
		}
		// Hidden tabs do not advertise a canvas as the active MCP client.
		if (document.visibilityState !== 'visible') {
			return;
		}
		if (_pendingLoad) {
			_register(_pendingLoad.canvasId, _pendingLoad.meta);
			_pendingLoad = null;
			return;
		}
		const cs = window.Orgloom && window.Orgloom.canvasState;
		if (cs && typeof cs.getCurrentCanvas === 'function') {
			const c = cs.getCurrentCanvas();
			if (c && c.canvasId) {
				_register(c.canvasId, c.meta || {});
			}
		}
	}

	window.addEventListener('orgloom:canvas-loaded', (ev) => {
		const detail = ev.detail || {};
		if (!detail.canvasId) {
			return;
		}
		_syncRegistration(detail.canvasId, detail.meta || {});
	});

	window.addEventListener('orgloom:canvas-unloaded', (ev) => {
		const detail = ev.detail || {};
		const cid = detail.canvasId || _registeredCanvasId;
		if (cid) {
			_unregister(cid);
		}
		_pendingLoad = null;
	});

	function _syncRegistration(canvasId, meta) {
		if (window.ORGLOOM_MCP_ACTIVE !== true) {
			_pendingLoad = { canvasId, meta: meta || {} };
			if (_registeredCanvasId) {
				_unregister(_registeredCanvasId);
			}
			return;
		}
		if (document.visibilityState !== 'visible') {
			if (_registeredCanvasId) {
				_unregister(_registeredCanvasId);
			}
			return;
		}
		if (_registeredCanvasId && _registeredCanvasId !== canvasId) {
			_unregister(_registeredCanvasId);
		}
		if (!_connectionId) {
			_pendingLoad = { canvasId, meta: meta || {} };
			return;
		}
		if (_registeredCanvasId !== canvasId) {
			_register(canvasId, meta || {});
		}
	}

	document.addEventListener('visibilitychange', () => {
		const cs = window.Orgloom && window.Orgloom.canvasState;
		if (!cs || typeof cs.getCurrentCanvas !== 'function') {
			return;
		}
		if (document.visibilityState === 'visible') {
			_connect();
			const current = cs.getCurrentCanvas();
			if (current && current.canvasId) {
				_syncRegistration(current.canvasId, current.meta);
			}
		} else if (_registeredCanvasId) {
			_unregister(_registeredCanvasId);
		}
	});

	setInterval(() => {
		if (!_eventSource && document.visibilityState === 'visible') {
			_connect();
		}
	}, 30000);

	setInterval(() => {
		if (window.ORGLOOM_MCP_ACTIVE !== true) {
			return;
		}
		const cs = window.Orgloom && window.Orgloom.canvasState;
		if (!cs || typeof cs.getCurrentCanvas !== 'function') {
			return;
		}
		if (document.visibilityState !== 'visible') {
			if (_registeredCanvasId) {
				_unregister(_registeredCanvasId);
			}
			return;
		}
		const current = cs.getCurrentCanvas();
		if (current && current.canvasId) {
			if (current.canvasId !== _registeredCanvasId) {
				_syncRegistration(current.canvasId, current.meta);
			}
		} else if (_registeredCanvasId) {
			_unregister(_registeredCanvasId);
		}
	}, 2000);

	_connect();
})();

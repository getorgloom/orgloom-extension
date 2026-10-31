(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	function stableValue(value) {
		if (Array.isArray(value)) {
			return value.map(stableValue);
		}
		if (!value || typeof value !== 'object') {
			return value;
		}
		const out = {};
		Object.keys(value)
			.sort()
			.forEach((key) => {
				if (value[key] !== undefined && typeof value[key] !== 'function') {
					out[key] = stableValue(value[key]);
				}
			});
		return out;
	}

	function fingerprint(payload) {
		return JSON.stringify(stableValue(payload || {}));
	}

	function payloadHasContent(payload) {
		const schemaObjects = payload && payload.schema && payload.schema.objects;
		return !!(
			(Array.isArray(payload && payload.loadedRecords) && payload.loadedRecords.length > 0) ||
			(Array.isArray(payload && payload.drafts) && payload.drafts.length > 0) ||
			(Array.isArray(payload && payload.associations) && payload.associations.length > 0) ||
			(Array.isArray(schemaObjects) && schemaObjects.length > 0)
		);
	}

	window.OrgLoom.canvasSaveState = {
		_test: { fingerprint, payloadHasContent },
		mount: function mount(deps) {
			if (!deps || !deps.canvasState) {
				throw new Error('canvas-save-state.mount: canvasState required');
			}
			const canvasState = deps.canvasState;
			let payloadProvider = null;
			let baseline = null;
			let state = {
				phase: 'new',
				dirty: false,
				savedAt: null,
				error: null,
			};

			function canPersistCurrentCanvas() {
				const current = canvasState.currentCanvas;
				return !!(!current || !current.id || current.ownedByMe || current.recipientRole === 'editor');
			}

			function currentPayload() {
				if (typeof payloadProvider !== 'function') {
					return null;
				}
				try {
					return payloadProvider();
				} catch (_error) {
					return null;
				}
			}

			function emit(next) {
				const changed =
					next.phase !== state.phase ||
					next.dirty !== state.dirty ||
					next.savedAt !== state.savedAt ||
					next.error !== state.error;
				state = next;
				canvasState.canvasSaveState = Object.assign({}, state);
				if (changed && typeof window.dispatchEvent === 'function' && typeof window.CustomEvent === 'function') {
					window.dispatchEvent(
						new window.CustomEvent('orgloom:canvas-save-state', {
							detail: Object.assign({}, state),
						}),
					);
				}
				return Object.assign({}, state);
			}

			function refresh() {
				const current = canvasState.currentCanvas;
				const payload = currentPayload();
				if (current && current.id && !canPersistCurrentCanvas()) {
					return emit({ phase: 'shared', dirty: false, savedAt: null, error: null });
				}
				if (!current || !current.id) {
					return emit({
						phase: 'new',
						dirty: payloadHasContent(payload),
						savedAt: null,
						error: null,
					});
				}
				if (state.phase === 'saving') {
					return Object.assign({}, state);
				}
				const dirty = baseline === null || (payload !== null && fingerprint(payload) !== baseline);
				return emit({
					phase: dirty ? 'dirty' : 'clean',
					dirty,
					savedAt: state.savedAt,
					error: null,
				});
			}

			function captureSaved(options) {
				options = options || {};
				const payload = options.payload || currentPayload();
				baseline = payload === null ? null : fingerprint(payload);
				window.OrgLoom.platform?.recovery?.captureSaved?.();
				return emit({
					phase: canPersistCurrentCanvas() ? 'clean' : 'shared',
					dirty: false,
					savedAt: options.savedAt ? new Date(options.savedAt).getTime() : Date.now(),
					error: null,
				});
			}

			function markRestored() {
				baseline = null;
				return refresh();
			}

			function markSaving() {
				if (!canPersistCurrentCanvas()) {
					return false;
				}
				emit({
					phase: 'saving',
					dirty: state.dirty,
					savedAt: state.savedAt,
					error: null,
				});
				return true;
			}

			function markFailed(error) {
				return emit({
					phase: 'error',
					dirty: true,
					savedAt: state.savedAt,
					error: error ? String(error) : 'Save failed',
				});
			}

			function markDirty() {
				return emit({
					phase: canvasState.currentCanvas && canvasState.currentCanvas.id ? 'dirty' : 'new',
					dirty: true,
					savedAt: state.savedAt,
					error: null,
				});
			}

			function reset() {
				baseline = null;
				return emit({ phase: 'new', dirty: false, savedAt: null, error: null });
			}

			function hasUnsavedChanges() {
				const current = canvasState.currentCanvas;
				const payload = currentPayload();
				if (!current || !current.id) {
					return payloadHasContent(payload);
				}
				if (!canPersistCurrentCanvas()) {
					return false;
				}
				if (state.phase === 'error' || state.phase === 'dirty') {
					return true;
				}
				if (baseline === null) {
					return true;
				}
				return payload !== null && fingerprint(payload) !== baseline;
			}

			function setPayloadProvider(provider) {
				payloadProvider = typeof provider === 'function' ? provider : null;
				return refresh();
			}

			canvasState.canvasSaveState = Object.assign({}, state);
			return {
				setPayloadProvider,
				refresh,
				captureSaved,
				markRestored,
				markSaving,
				markDirty,
				markFailed,
				reset,
				hasUnsavedChanges,
				canPersistCurrentCanvas,
				getState: function () {
					return Object.assign({}, state);
				},
			};
		},
	};
})();

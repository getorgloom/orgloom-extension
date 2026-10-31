// Shared by browser and server. Rebuild events rather than trusting new SDK
// fields to be safe. Never copy request headers, contexts, locals or breadcrumbs.
const ERROR_TYPES = new Set([
	'Error',
	'TypeError',
	'ReferenceError',
	'SyntaxError',
	'RangeError',
	'URIError',
	'EvalError',
	'AggregateError',
	'AssertionError',
	'AbortError',
]);
const ROUTES = new Set([
	'canvas',
	'api',
	'auth',
	'account',
	'workspace',
	'workspaces',
	'sign-in',
	'sign-up',
	'playground',
	'docs',
	'install-required',
]);
const REASONS = new Set([
	'dispatcher-loop-failed',
	'salesforce-record-rejected',
	'retry-exhausted',
	'enqueue-rejected',
	'dispatch-failed',
]);

function requestPath(value) {
	try {
		const path = new URL(value, 'https://redacted.invalid').pathname;
		if (path === '/') {
			return '/';
		}
		const parts = path.split('/').filter(Boolean);
		return ROUTES.has(parts[0]) ? '/' + parts[0] + (parts.length > 1 ? '/:path' : '') : '/:path';
	} catch {
		return '/:path';
	}
}

function stackFrame(frame) {
	const clean = {};
	// Keep code locations, not absolute host/filesystem paths or eval source.
	if (typeof frame.filename === 'string') {
		const path = frame.filename.split(/[?#]/)[0].replaceAll('\\', '/');
		const match = path.match(/(?:^|\/)((?:src|node_modules|js)\/[A-Za-z0-9_@./-]+\.(?:js|mjs|cjs))$/);
		if (match) {
			clean.filename = match[1];
		}
	}
	for (const key of ['lineno', 'colno']) {
		if (Number.isInteger(frame[key]) && frame[key] >= 0) {
			clean[key] = frame[key];
		}
	}
	if (typeof frame.function === 'string' && /^[A-Za-z0-9_$.[\] <>/-]{1,160}$/.test(frame.function)) {
		clean.function = frame.function;
	}
	if (typeof frame.in_app === 'boolean') {
		clean.in_app = frame.in_app;
	}
	return clean;
}

export function scrubErrorEvent(event) {
	if (!event || (event.type && event.type !== 'error')) {
		return null;
	}
	const clean = {};
	if (/^[a-f0-9]{32}$/i.test(event.event_id || '')) {
		clean.event_id = event.event_id;
	}
	if (Number.isFinite(event.timestamp)) {
		clean.timestamp = event.timestamp;
	}
	if (['fatal', 'error', 'warning', 'info', 'debug'].includes(event.level)) {
		clean.level = event.level;
	}
	if (['javascript', 'node'].includes(event.platform)) {
		clean.platform = event.platform;
	}
	if (['production', 'development', 'test', 'staging', 'uat'].includes(event.environment)) {
		clean.environment = event.environment;
	}
	if (typeof event.release === 'string' && /^[a-f0-9]{7,40}$/i.test(event.release)) {
		clean.release = event.release;
	}
	if (/^acct:[a-f0-9]{16}$/.test(event.user?.id || '')) {
		clean.user = { id: event.user.id };
	}
	if (event.request) {
		clean.request = {};
		if (typeof event.request.url === 'string') {
			clean.request.url = requestPath(event.request.url);
		}
		if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(event.request.method)) {
			clean.request.method = event.request.method;
		}
	}
	const status = event.contexts?.response?.status_code;
	if (Number.isInteger(status) && status >= 100 && status <= 599) {
		clean.contexts = { response: { status_code: status } };
	}
	if (event.message) {
		clean.message = '<redacted-error-message>';
	}
	if (Array.isArray(event.exception?.values)) {
		clean.exception = {
			values: event.exception.values
				.slice(0, 10)
				.filter(Boolean)
				.map((ex) => {
					const value = {
						type: ERROR_TYPES.has(ex.type) ? ex.type : 'Error',
						value: '<redacted-error-message>',
					};
					if (Array.isArray(ex.stacktrace?.frames)) {
						value.stacktrace = { frames: ex.stacktrace.frames.slice(-100).filter(Boolean).map(stackFrame) };
					}
					return value;
				}),
		};
	}
	// Preserve alert routing without accepting arbitrary tags/fingerprints.
	if (['canvas', 'audit-mirror'].includes(event.tags?.source)) {
		clean.tags = { source: event.tags.source };
		if (event.tags.source === 'audit-mirror' && REASONS.has(event.tags.reason)) {
			clean.tags.reason = event.tags.reason;
			clean.fingerprint = ['audit-mirror', event.tags.reason];
		}
	}
	return clean;
}

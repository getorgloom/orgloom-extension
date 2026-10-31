(function () {
	'use strict';

	function resolveTimeZone(timeZone) {
		const candidate = timeZone || (typeof window !== 'undefined' && window.SF_USER_TIME_ZONE);
		if (candidate) {
			try {
				new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(0);
				return candidate;
			} catch (_) {}
		}
		try {
			return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
		} catch (_) {
			return 'UTC';
		}
	}

	function _partsAt(instant, timeZone) {
		const parts = new Intl.DateTimeFormat('en-CA', {
			timeZone: resolveTimeZone(timeZone),
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hourCycle: 'h23',
		}).formatToParts(new Date(instant));
		const out = {};
		parts.forEach((part) => {
			if (part.type !== 'literal') {
				out[part.type] = Number(part.value);
			}
		});
		return out;
	}

	function _wallTime(parts) {
		return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
	}

	function _offsetAt(instant, timeZone) {
		const wholeSecond = Math.floor(instant / 1000) * 1000;
		return _wallTime(_partsAt(wholeSecond, timeZone)) - wholeSecond;
	}

	function toDateTimeLocal(value, timeZone) {
		const instant = Date.parse(String(value || ''));
		if (!Number.isFinite(instant)) {
			return '';
		}
		const parts = _partsAt(instant, timeZone);
		const pad = (value) => String(value).padStart(2, '0');
		return (
			String(parts.year).padStart(4, '0') +
			'-' +
			pad(parts.month) +
			'-' +
			pad(parts.day) +
			'T' +
			pad(parts.hour) +
			':' +
			pad(parts.minute)
		);
	}

	function fromDateTimeLocal(value, timeZone) {
		const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
			String(value || ''),
		);
		if (!match) {
			return null;
		}
		const wanted = {
			year: Number(match[1]),
			month: Number(match[2]),
			day: Number(match[3]),
			hour: Number(match[4]),
			minute: Number(match[5]),
			second: Number(match[6] || 0),
		};
		const milliseconds = Number(String(match[7] || '').padEnd(3, '0') || 0);
		const wallTime = _wallTime(wanted) + milliseconds;
		const zone = resolveTimeZone(timeZone);
		const offsets = new Set();
		[wallTime - 36 * 60 * 60 * 1000, wallTime, wallTime + 36 * 60 * 60 * 1000].forEach((instant) => {
			offsets.add(_offsetAt(instant, zone));
		});
		let candidate = wallTime - _offsetAt(wallTime, zone);
		offsets.add(_offsetAt(candidate, zone));
		candidate = wallTime - _offsetAt(candidate, zone);
		offsets.add(_offsetAt(candidate, zone));

		const matches = Array.from(offsets)
			.map((offset) => wallTime - offset)
			.filter((instant) => {
				const actual = _partsAt(instant, zone);
				return (
					actual.year === wanted.year &&
					actual.month === wanted.month &&
					actual.day === wanted.day &&
					actual.hour === wanted.hour &&
					actual.minute === wanted.minute &&
					actual.second === wanted.second
				);
			})
			.sort((a, b) => a - b);
		return matches.length ? new Date(matches[0]).toISOString() : null;
	}

	function formatDateTime(value, timeZone) {
		const instant = Date.parse(String(value || ''));
		if (!Number.isFinite(instant)) {
			return value == null ? '' : String(value);
		}
		return new Date(instant).toLocaleString([], { timeZone: resolveTimeZone(timeZone) });
	}

	const api = { resolveTimeZone, toDateTimeLocal, fromDateTimeLocal, formatDateTime };
	if (typeof window !== 'undefined') {
		window.OrgLoom = window.OrgLoom || {};
		window.OrgLoom.datetime = api;
	}
	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
})();

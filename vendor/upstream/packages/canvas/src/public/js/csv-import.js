(function () {
	'use strict';
	// Parses a single CSV file into draft records after object and field mapping.

	window.OrgLoom = window.OrgLoom || {};

	function parseCsv(text) {
		// Parse RFC-style quoting locally and report malformed input before mapping begins.
		const rows = [];
		let row = [];
		let cur = '';
		let inQuotes = false;
		let malformedQuotes = false;
		const n = text.length;
		let i = 0;
		while (i < n) {
			const c = text[i];
			if (inQuotes) {
				if (c === '"') {
					if (text[i + 1] === '"') {
						cur += '"';
						i += 2;
						continue;
					}
					inQuotes = false;
					i++;
					continue;
				}
				cur += c;
				i++;
				continue;
			}
			if (c === '"') {
				if (cur === '') {
					inQuotes = true;
					i++;
					continue;
				}
				malformedQuotes = true;
				cur += c;
				i++;
				continue;
			}
			if (c === ',') {
				row.push(cur);
				cur = '';
				i++;
				continue;
			}
			if (c === '\r' || c === '\n') {
				row.push(cur);
				cur = '';
				rows.push(row);
				row = [];
				if (c === '\r' && text[i + 1] === '\n') {
					i += 2;
				} else {
					i++;
				}
				continue;
			}
			cur += c;
			i++;
		}
		if (inQuotes) {
			malformedQuotes = true;
		}
		if (cur !== '' || row.length > 0) {
			row.push(cur);
			rows.push(row);
		}
		while (rows.length > 0 && rows[rows.length - 1].every((v) => v === '')) {
			rows.pop();
		}
		if (rows.length === 0) {
			return { headers: [], rows: [], errors: [] };
		}
		const headers = rows[0].map((h) => h.trim());
		if (headers.length > 0) {
			headers[0] = headers[0].replace(/^\uFEFF/, '');
		}
		const errors = [];
		if (malformedQuotes) {
			errors.push('Malformed or unclosed quoted field.');
		}
		const seenHeaders = new Set();
		headers.forEach((header) => {
			const key = String(header || '')
				.trim()
				.toLowerCase();
			if (!key) {
				return;
			}
			if (seenHeaders.has(key)) {
				errors.push('Duplicate header: "' + header + '".');
			}
			seenHeaders.add(key);
		});
		const dataRows = rows.slice(1);
		const escapeColumn = headers.indexOf('__OrgLoom_EscapedCells');
		if (escapeColumn !== -1 && errors.length === 0) {
			for (const [rowIndex, dataRow] of dataRows.entries()) {
				if (dataRow.length !== headers.length) {
					errors.push('Invalid Org Loom export row ' + (rowIndex + 2) + ': column count mismatch.');
					continue;
				}
				try {
					const raw = dataRow[escapeColumn];
					if (raw) {
						const metadata = JSON.parse(raw);
						if (!metadata || metadata.version !== 1 || !Array.isArray(metadata.cells))
							throw new Error('Invalid metadata');
						const seen = new Set();
						for (const cell of metadata.cells) {
							if (
								!Array.isArray(cell) ||
								cell.length !== 2 ||
								typeof cell[0] !== 'string' ||
								typeof cell[1] !== 'string' ||
								!/^'[=+\-@\t\r]/.test(cell[1])
							)
								throw new Error('Invalid escaped cell');
							const index = headers.indexOf(cell[0]);
							if (index < 0 || index === escapeColumn || seen.has(index))
								throw new Error('Invalid field');
							seen.add(index);
							// If a spreadsheet/user already changed it, leave the new value untouched.
							if (dataRow[index] === cell[1]) dataRow[index] = dataRow[index].slice(1);
						}
					}
				} catch (_) {
					errors.push('Invalid Org Loom escape metadata on row ' + (rowIndex + 2) + '.');
				}
				dataRow.splice(escapeColumn, 1);
			}
			headers.splice(escapeColumn, 1);
		}
		return { headers, rows: dataRows, errors };
	}

	function csvNormalizeKey(s) {
		return String(s || '')
			.toLowerCase()
			.replace(/[^a-z0-9]/g, '');
	}

	function csvGuessObjectFromFilename(filename, candidates) {
		if (!filename || !Array.isArray(candidates) || candidates.length === 0) {
			return null;
		}
		const base = String(filename)
			.split(/[\\/]/)
			.pop()
			.replace(/\.[^.]+$/, '');
		if (!base) {
			return null;
		}
		const tryMatch = (key) => {
			if (!key) {
				return null;
			}
			for (const obj of candidates) {
				if (obj && obj.name && csvNormalizeKey(obj.name) === key) {
					return obj.name;
				}
			}
			for (const obj of candidates) {
				if (obj && obj.label && csvNormalizeKey(obj.label) === key) {
					return obj.name;
				}
			}
			return null;
		};
		const variantsOf = (s) => {
			const out = new Set();
			if (!s) {
				return out;
			}
			out.add(s);
			if (s.endsWith('ies') && s.length > 3) {
				out.add(s.slice(0, -3) + 'y');
			}
			if (s.endsWith('es') && s.length > 2) {
				out.add(s.slice(0, -2));
			}
			if (s.endsWith('s') && s.length > 1) {
				out.add(s.slice(0, -1));
			}
			return out;
		};
		const fullKey = csvNormalizeKey(base);
		for (const v of variantsOf(fullKey)) {
			const hit = tryMatch(v);
			if (hit) {
				return hit;
			}
		}
		const tokens = base
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter(Boolean);
		for (let i = tokens.length - 1; i >= 0; i--) {
			const tk = csvNormalizeKey(tokens[i]);
			for (const v of variantsOf(tk)) {
				const hit = tryMatch(v);
				if (hit) {
					return hit;
				}
			}
		}
		return null;
	}

	function csvAutoMapHeaders(headers, fields) {
		// Prefer API-name matches, then labels; every guess remains editable in the import UI.
		const byName = {};
		const byLabel = {};
		byName[csvNormalizeKey('Id')] = 'Id';
		byLabel[csvNormalizeKey('Record Id')] = 'Id';
		fields.forEach((f) => {
			const nameKey = csvNormalizeKey(f.name);
			byName[nameKey] = f.name;
			const labelKey = f.label ? csvNormalizeKey(f.label) : '';
			if (labelKey) {
				byLabel[labelKey] = f.name;
			}
			if (f.type === 'reference') {
				if (nameKey.endsWith('id') && nameKey.length > 2) {
					const stripped = nameKey.slice(0, -2);
					if (!byName[stripped]) {
						byName[stripped] = f.name;
					}
				}
				if (labelKey.endsWith('id') && labelKey.length > 2) {
					const stripped = labelKey.slice(0, -2);
					if (!byLabel[stripped]) {
						byLabel[stripped] = f.name;
					}
				}
			}
		});
		const mapping = {};
		headers.forEach((h, i) => {
			if (h === '__OrgLoom_ClearFields') {
				mapping[i] = null;
				return;
			}
			const k = csvNormalizeKey(h);
			mapping[i] = byName[k] || byLabel[k] || null;
		});
		return mapping;
	}

	window.OrgLoom.csvImport = {
		mount: function mount(deps) {
			if (!deps || !deps.csrfFetch) {
				throw new Error('csv-import.mount: missing required dep csrfFetch');
			}
			const csrfFetch = deps.csrfFetch;

			function pingAuditEvent(action, fields) {
				try {
					csrfFetch('/api/audit-event', {
						method: 'POST',
						credentials: 'same-origin',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(Object.assign({ action }, fields || {})),
					}).catch(() => {});
				} catch (e) {
					/* ignore */
				}
			}

			return {
				parseCsv: parseCsv,
				csvNormalizeKey: csvNormalizeKey,
				csvGuessObjectFromFilename: csvGuessObjectFromFilename,
				csvAutoMapHeaders: csvAutoMapHeaders,
				pingAuditEvent: pingAuditEvent,
			};
		},
	};
})();

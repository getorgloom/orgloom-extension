// Adapted from Org Loom canvas core soql-import-results.js; PolyForm Internal Use 1.0.0.
// Preserve nested query structure instead of matching FROM clauses with a flat regex.
class SoqlImportError extends Error {
	constructor(error, message) {
		super(message || error);
		this.body = { error, ...(message ? { message } : {}) };
	}
}

function parseSoqlImportQuery(soql) {
	const root = { soql, children: [], filters: [], start: 0 };
	const queries = [root];
	const parentheses = [];
	let quoted = false;
	for (let i = 0; i < soql.length; i++) {
		const char = soql[i];
		if (quoted) {
			if (char === '\\') {
				i++;
			} else if (char === "'") {
				quoted = false;
			}
			continue;
		}
		if (char === "'") {
			quoted = true;
		} else if (char === '(') {
			let query = null;
			if (/^\s*SELECT\b/i.test(soql.slice(i + 1))) {
				if (queries.length >= 5) {
					throw new SoqlImportError(
						'query-too-deep',
						'SOQL import supports up to five object levels, including the root object.',
					);
				}
				const parent = queries.at(-1);
				// FROM at this query's top level separates selected child rows from
				// WHERE semi/anti-joins, which filter rows but never create cards.
				const prefix = require('./soql-policy.cjs').mask(soql.slice(parent.start, i));
				query = { children: [], filters: [], start: i + 1 };
				parent[/\bFROM\b/i.test(prefix) ? 'filters' : 'children'].push(query);
				queries.push(query);
			}
			parentheses.push({ start: i + 1, query });
		} else if (char === ')') {
			const frame = parentheses.pop();
			if (!frame) {
				throw new SoqlImportError('invalid-query', 'Query parentheses are not balanced.');
			}
			if (frame.query) {
				frame.query.soql = soql.slice(frame.start, i).trim();
				queries.pop();
			}
		}
	}
	if (quoted || parentheses.length) {
		throw new SoqlImportError('invalid-query', 'Query has an unclosed string or parenthesis.');
	}
	return root;
}

// Each plan node has already been resolved against its immediate parent's describe.
// Only scalar fields are copied; nested results become records and relationship edges.
function flattenSoqlImportResults(rows, plan, cap) {
	const records = [];
	const associations = [];
	const seen = new Map();
	let capped = false;
	function visit(row, node, parentTempId) {
		if (!row || !row.Id) {
			throw new SoqlImportError(parentTempId ? 'subquery-must-include-id' : 'must-include-id');
		}
		const identity = node.objectName + ':' + row.Id.slice(0,15);
		if (seen.has(identity)) {
			if (parentTempId && node.relationship.field) associations.push({ fromTempId: seen.get(identity), toTempId: parentTempId, fieldName: node.relationship.field });
			return;
		}
		if (records.length >= cap) { capped = true; return; }
		const tempId = 't' + (records.length + 1);
		seen.set(identity, tempId);
		const values = {};
		for (const [key, value] of Object.entries(row)) {
			if (key !== 'attributes' && node.fieldNames.has(key) && value !== null) {
				values[key] = value;
			}
		}
		records.push({ tempId, objectName: node.objectName, loadedFromId: row.Id, values });
		if (parentTempId && node.relationship.field) {
			associations.push({ fromTempId: tempId, toTempId: parentTempId, fieldName: node.relationship.field });
		}
		for (const [key, value] of Object.entries(row)) {
			if (key === 'attributes' || node.fieldNames.has(key) || value == null) {
				continue;
			}
			const child = node.children.find(
				(candidate) => candidate.relationship.relationshipName.toLowerCase() === key.toLowerCase(),
			);
			if (!child) {
				if (Array.isArray(value.records)) {
					throw new SoqlImportError(
						'unknown-subquery-relationship',
						'Unexpected child relationship ' + key + ' on ' + node.objectName + '.',
					);
				}
				continue;
			}
			if (!Array.isArray(value.records)) {
				throw new SoqlImportError('aggregate-subquery-not-supported');
			}
			if (value.done === false || value.nextRecordsUrl || value.totalSize > value.records.length) capped = true;
			for (const childRow of value.records) {
				visit(childRow, child, tempId);
			}
		}
	}
	for (const row of rows) {
		visit(row, plan, null);
	}
	return { records, associations, capped };
}

module.exports = { SoqlImportError, parseSoqlImportQuery, flattenSoqlImportResults };

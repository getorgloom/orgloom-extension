(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	function _describe(canvasState, objectName) {
		return (
			(canvasState && canvasState.describeCache && canvasState.describeCache[objectName]) ||
			(canvasState && canvasState.draftDescribeCache && canvasState.draftDescribeCache[objectName]) ||
			null
		);
	}

	function fieldNames(canvasState, objectName) {
		const describe = _describe(canvasState, objectName);
		return new Set(
			(describe && Array.isArray(describe.fields) ? describe.fields : [])
				.filter((field) => field && String(field.type || '').toLowerCase() === 'encryptedstring')
				.map((field) => field.name),
		);
	}

	function stripValues(canvasState, objectName, values) {
		const encrypted = fieldNames(canvasState, objectName);
		const safe = Object.assign({}, values || {});
		encrypted.forEach((fieldName) => delete safe[fieldName]);
		return safe;
	}

	function _intentSet(record) {
		if (!record) {
			return new Set();
		}
		if (record._encryptedFieldIntents instanceof Set) {
			return record._encryptedFieldIntents;
		}
		const initial = Array.isArray(record.encryptedFieldIntents) ? record.encryptedFieldIntents : [];
		const intents = new Set(initial.filter((name) => typeof name === 'string' && name));
		Object.defineProperty(record, '_encryptedFieldIntents', {
			value: intents,
			writable: true,
			configurable: true,
		});
		delete record.encryptedFieldIntents;
		return intents;
	}

	function _proposalBag(record) {
		if (!record) {
			return {};
		}
		if (record._encryptedFieldProposals && typeof record._encryptedFieldProposals === 'object') {
			return record._encryptedFieldProposals;
		}
		const proposals = {};
		Object.defineProperty(record, '_encryptedFieldProposals', {
			value: proposals,
			writable: true,
			configurable: true,
		});
		return proposals;
	}

	function hydrateIntents(record, serializedIntents, canvasState) {
		if (!record) {
			return [];
		}
		const encrypted = fieldNames(canvasState, record.objectName);
		const intents = _intentSet(record);
		for (const fieldName of Array.isArray(serializedIntents) ? serializedIntents : []) {
			if (encrypted.has(fieldName)) {
				intents.add(fieldName);
			}
		}
		return Array.from(intents);
	}

	function intentNames(record, canvasState) {
		const encrypted = fieldNames(canvasState, record && record.objectName);
		return Array.from(_intentSet(record)).filter((name) => encrypted.has(name));
	}

	function setProposal(record, fieldName, value) {
		if (!record || !fieldName) {
			return;
		}
		const proposals = _proposalBag(record);
		proposals[fieldName] = value;
		_intentSet(record).add(fieldName);
	}

	function markIntent(record, fieldName) {
		if (!record || !fieldName) {
			return;
		}
		_intentSet(record).add(fieldName);
		delete _proposalBag(record)[fieldName];
	}

	function dismissIntent(record, fieldName) {
		if (!record || !fieldName) {
			return;
		}
		_intentSet(record).delete(fieldName);
		delete _proposalBag(record)[fieldName];
	}

	function hasProposal(record, fieldName) {
		return !!(
			record &&
			record._encryptedFieldProposals &&
			Object.prototype.hasOwnProperty.call(record._encryptedFieldProposals, fieldName)
		);
	}

	function proposal(record, fieldName) {
		return hasProposal(record, fieldName) ? record._encryptedFieldProposals[fieldName] : undefined;
	}

	function unresolvedIntentNames(record, canvasState) {
		return intentNames(record, canvasState).filter((fieldName) => !hasProposal(record, fieldName));
	}

	function hasPending(record, canvasState) {
		return intentNames(record, canvasState).length > 0;
	}

	function uploadValues(record, canvasState, values) {
		const safe = stripValues(canvasState, record && record.objectName, values);
		for (const fieldName of intentNames(record, canvasState)) {
			if (hasProposal(record, fieldName)) {
				safe[fieldName] = proposal(record, fieldName);
			}
		}
		return safe;
	}

	function adoptRuntimeValues(record, canvasState) {
		if (!record || !record.values) {
			return;
		}
		const encrypted = fieldNames(canvasState, record.objectName);
		for (const fieldName of encrypted) {
			if (!Object.prototype.hasOwnProperty.call(record.values, fieldName)) {
				continue;
			}
			const value = record.values[fieldName];
			if (!record.loadedFromId) {
				setProposal(record, fieldName, value);
				delete record.values[fieldName];
				continue;
			}
			const loaded = record.loadedValues || {};
			if (
				!Object.prototype.hasOwnProperty.call(loaded, fieldName) ||
				String(value == null ? '' : value) !== String(loaded[fieldName] == null ? '' : loaded[fieldName])
			) {
				setProposal(record, fieldName, value);
			}
			if (Object.prototype.hasOwnProperty.call(loaded, fieldName)) {
				record.values[fieldName] = loaded[fieldName];
			} else {
				delete record.values[fieldName];
			}
		}
	}

	function clearSubmitted(record, fieldNamesToClear) {
		for (const fieldName of fieldNamesToClear || []) {
			dismissIntent(record, fieldName);
		}
	}

	window.OrgLoom.encryptedFields = {
		fieldNames,
		stripValues,
		hydrateIntents,
		intentNames,
		setProposal,
		markIntent,
		dismissIntent,
		hasProposal,
		proposal,
		unresolvedIntentNames,
		hasPending,
		uploadValues,
		adoptRuntimeValues,
		clearSubmitted,
	};
})();

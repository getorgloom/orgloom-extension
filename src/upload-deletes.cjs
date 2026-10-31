'use strict';
// Adapted from Org Loom canvas upload-deletes.js (PolyForm Internal Use 1.0.0).
// Keep the same dependency scheduling as the hosted app.
const formatUploadError = error => String(error?.message || 'Salesforce delete failed.').slice(0,1000);

const idKey = (id) => String(id).slice(0, 15);

function skipped(record, errorCode, error) {
	return {
		tempId: record?.tempId ?? null,
		sfId: record?.sfId || null,
		objectName: record?.objectName || null,
		success: false,
		errorCode,
		error,
	};
}

// Read persisted relationships, not staged canvas edits: a record being deleted
// never uploads those edits. Only records explicitly selected for deletion enter
// this graph; we never discover additional records to delete.
async function deleteDependencies(conn, getDescribe, records) {
	const children = new Map(records.map((record) => [record, new Set()]));
	const byId = new Map();
	const byObject = new Map();
	for (const record of records) {
		if (
			!/^[A-Za-z_][A-Za-z0-9_]*$/.test(record?.objectName || '') ||
			!/^([A-Za-z0-9]{15}|[A-Za-z0-9]{18})$/.test(record?.sfId || '')
		) {
			throw new Error('A record has an invalid Salesforce object or ID.');
		}
		byId.set(idKey(record.sfId), record);
		if (!byObject.has(record.objectName)) byObject.set(record.objectName, []);
		byObject.get(record.objectName).push(record);
	}
	for (const [objectName, group] of byObject) {
		const describe = await getDescribe(objectName);
		if (!Array.isArray(describe?.fields)) throw new Error('Salesforce relationship metadata is unavailable.');
		const fields = describe.fields.filter(
			(field) => field.type === 'reference' && field.referenceTo?.some((target) => byObject.has(target)),
		);
		if (!fields.length) continue;
		for (let offset = 0; offset < group.length; offset += 200) {
			const chunk = group.slice(offset, offset + 200);
			const response = await conn.sobject(objectName).retrieve(
				chunk.map((record) => record.sfId),
				{
					fields: ['Id', ...fields.map((field) => field.name)],
				},
			);
			const rows = new Map(
				(Array.isArray(response) ? response : [response])
					.filter((row) => row?.Id)
					.map((row) => [idKey(row.Id), row]),
			);
			for (const record of chunk) {
				const row = rows.get(idKey(record.sfId));
				if (!row || fields.some((field) => !Object.hasOwn(row, field.name))) {
					throw new Error(
						'Salesforce did not return the required record relationships. Refresh the canvas and retry.',
					);
				}
				for (const field of fields) {
					const parent = row[field.name] && byId.get(idKey(row[field.name]));
					if (parent && parent !== record && field.referenceTo.includes(parent.objectName)) {
						children.get(parent).add(record);
					}
				}
			}
		}
	}
	return children;
}

async function executeUploadDeletes({ conn, getDescribe, records, deleteRecord }) {
	if (!records.length) return [];
	if (records.length === 1) return [await deleteRecord(records[0])];
	let children;
	try {
		children = await deleteDependencies(conn, getDescribe, records);
	} catch (error) {
		return records.map((record) =>
			skipped(
				record,
				'DELETE_DEPENDENCIES_UNAVAILABLE',
				'Skipped: could not verify Salesforce relationships before deletion. ' + formatUploadError(error),
			),
		);
	}
	const pending = new Set(records);
	const completed = new Map();
	while (pending.size) {
		const ready = [...pending].filter((record) => [...children.get(record)].every((child) => completed.has(child)));
		if (!ready.length) {
			for (const record of pending) {
				completed.set(
					record,
					skipped(
						record,
						'DELETE_DEPENDENCY_CYCLE',
						'Skipped: circular Salesforce relationships prevent child-first deletion. Resolve the relationships and retry.',
					),
				);
			}
			break;
		}
		for (const record of ready) {
			const blocked = [...children.get(record)].some((child) => !completed.get(child).success);
			// Await each Salesforce delete before its parent can become ready.
			const result = blocked
				? skipped(
						record,
						'DELETE_DEPENDENCY_FAILED',
						'Skipped: a related record could not be deleted. Resolve its error and retry.',
					)
				: await deleteRecord(record);
			completed.set(record, result);
			pending.delete(record);
		}
	}
	return [...completed.values()];
}

module.exports = { executeUploadDeletes };

(function () {
	'use strict';

	if (!window.ORGLOOM_MOCK || !window.OrgLoomMock) {
		return;
	}

	const MOCK = window.OrgLoomMock;
	const _realFetch = window.fetch.bind(window);

	console.log(
		'[mock-sf] Installed for /playground demo. ' +
			MOCK.records.Account.length +
			' Accounts, ' +
			MOCK.records.Contact.length +
			' Contacts, ' +
			MOCK.records.Opportunity.length +
			' Opportunities loaded.',
	);

	function jsonResponse(body, init) {
		const status = (init && init.status) || 200;
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	function notImplemented(method, path) {
		console.warn(
			'[mock-sf] Unhandled ' +
				method +
				' ' +
				path +
				': returning 501. Add a handler if the canvas needs this surface.',
		);
		return jsonResponse(
			{
				error: 'mock-not-implemented',
				message: 'This action is disabled in the demo. Sign up to use it on your real Salesforce org.',
				method,
				path,
			},
			{ status: 501 },
		);
	}

	function blocked(reason) {
		return jsonResponse(
			{
				error: 'playground-blocked',
				message: reason || 'Sign up to use this on your real Salesforce org.',
			},
			{ status: 403 },
		);
	}

	function idMatches(a, b) {
		if (!a || !b) {
			return false;
		}
		return String(a).slice(0, 15) === String(b).slice(0, 15);
	}

	const STORAGE_KEY = {
		canvases: 'orgloom.playground.canvases',
		uploads: 'orgloom.playground.uploads',
		records: 'orgloom.playground.records',
		preseedDeleted: 'orgloom.playground.preseedDeleted',
		deletedSfIds: 'orgloom.playground.deletedSfIds',
	};
	const DATASET_VERSION_KEY = 'orgloom.playground.datasetVersion';
	const DATASET_VERSION = '3';
	const PRESEED_CANVAS_ID = '069PRESEED000000AAA';

	function storageKeys(storage) {
		const keys = [];
		for (let index = 0; index < storage.length; index += 1) {
			const key = storage.key(index);
			if (key) {
				keys.push(key);
			}
		}
		return keys;
	}

	function resetPlaygroundIfRequested() {
		let requested = false;
		try {
			requested = new URLSearchParams(window.location.search || '').get('reset') === '1';
		} catch (_) {}
		if (!requested) {
			return;
		}

		const canvasIds = new Set([PRESEED_CANVAS_ID]);
		try {
			const canvases = JSON.parse(window.localStorage.getItem(STORAGE_KEY.canvases) || '{}');
			Object.keys(canvases || {}).forEach((id) => canvasIds.add(id));
		} catch (_) {}

		try {
			storageKeys(window.localStorage)
				.filter((key) => key.indexOf('orgloom.playground.') === 0)
				.forEach((key) => window.localStorage.removeItem(key));
		} catch (_) {}

		try {
			storageKeys(window.sessionStorage).forEach((key) => {
				const isPlaygroundKey = key.indexOf('orgloom.playground.') === 0;
				const isPlaygroundCanvasDraft =
					key.indexOf('orgloom:canvas-draft') === 0 &&
					key.indexOf('playground:00DDEMO00000000AAA:005DEMO00000000AAA') !== -1;
				const isPlaygroundDescribe =
					key.indexOf('orgloom-describe-') === 0 &&
					key.indexOf('|00DDEMO00000000AAA|005DEMO00000000AAA|') !== -1;
				const isPlaygroundDraftValues =
					key.indexOf('orgloom:draftValues:') === 0 &&
					canvasIds.has(key.slice('orgloom:draftValues:'.length));
				let isPlaygroundTransfer = false;
				if (key === 'orgloom:org-switch-stash:v1' || key === 'orgloom:migration:v1') {
					const value = window.sessionStorage.getItem(key) || '';
					isPlaygroundTransfer =
						value.indexOf('00DDEMO00000000AAA') !== -1 || value.indexOf('005DEMO00000000AAA') !== -1;
				}
				if (
					isPlaygroundKey ||
					isPlaygroundCanvasDraft ||
					isPlaygroundDescribe ||
					isPlaygroundDraftValues ||
					isPlaygroundTransfer
				) {
					window.sessionStorage.removeItem(key);
				}
			});
		} catch (_) {}

		try {
			const cleanUrl = new URL(window.location.href);
			cleanUrl.searchParams.delete('reset');
			window.history.replaceState(null, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
		} catch (_) {}
	}

	resetPlaygroundIfRequested();

	// Reset disposable local fixtures when the published demo dataset changes.
	try {
		if (window.localStorage.getItem(DATASET_VERSION_KEY) !== DATASET_VERSION) {
			Object.values(STORAGE_KEY).forEach((key) => window.localStorage.removeItem(key));
			window.localStorage.removeItem('orgloom.playground.meta');
			window.localStorage.setItem(DATASET_VERSION_KEY, DATASET_VERSION);
		}
	} catch (_) {}

	const PRESEED_CANVAS_VERSION = '068PRESEED000000AAA';
	const PRESEED_CANVAS = {
		id: PRESEED_CANVAS_ID,
		versionId: PRESEED_CANVAS_VERSION,
		title: 'Alder Peak Analytics: sample canvas',
		ownerId: '005DEMO00000000AAA',
		ownedByMe: true,
		createdAt: Date.UTC(2025, 0, 15),
		updatedAt: Date.UTC(2025, 1, 3),
		payload: {
			_meta: {
				app: 'Org Loom',
				version: 1,
				savedFrom: '00DDEMO00000000AAA',
				savedBy: '005DEMO00000000AAA',
				savedByName: 'Demo User',
				preseed: true,
			},
			schema: {
				objects: [
					{
						idx: 0,
						name: 'Account',
						label: 'Account',
						addedFromIdx: null,
						addedVia: null,
						worldPos: { x: 0, y: 0 },
					},
					{
						idx: 1,
						name: 'Contact',
						label: 'Contact',
						addedFromIdx: 0,
						addedVia: 'children:Contacts',
						worldPos: { x: 0, y: 260 },
					},
					{
						idx: 2,
						name: 'Task',
						label: 'Task',
						addedFromIdx: 1,
						addedVia: 'children:Tasks',
						worldPos: { x: 0, y: 520 },
					},
				],
			},
			loadedRecords: [
				{ loadedFromId: '001000000000001AAA', objectName: 'Account', x: 400, y: 100 },
				{ loadedFromId: '003000000000001AAA', objectName: 'Contact', x: 200, y: 300 },
				{ loadedFromId: '003000000000002AAA', objectName: 'Contact', x: 600, y: 300 },
				{ loadedFromId: '00T000000000001AAA', objectName: 'Task', x: 200, y: 500 },
				{ loadedFromId: '00T000000000002AAA', objectName: 'Task', x: 600, y: 500 },
			],
			drafts: [],
			associations: [
				{
					from: { kind: 'loaded', ref: '003000000000001AAA' },
					to: { kind: 'loaded', ref: '001000000000001AAA' },
					fieldName: 'AccountId',
				},
				{
					from: { kind: 'loaded', ref: '003000000000002AAA' },
					to: { kind: 'loaded', ref: '001000000000001AAA' },
					fieldName: 'AccountId',
				},
				{
					from: { kind: 'loaded', ref: '00T000000000001AAA' },
					to: { kind: 'loaded', ref: '003000000000001AAA' },
					fieldName: 'WhoId',
				},
				{
					from: { kind: 'loaded', ref: '00T000000000002AAA' },
					to: { kind: 'loaded', ref: '003000000000002AAA' },
					fieldName: 'WhoId',
				},
			],
		},
	};

	function preseedSummary() {
		return {
			id: PRESEED_CANVAS.id,
			versionId: PRESEED_CANVAS.versionId,
			title: PRESEED_CANVAS.title,
			ownerId: PRESEED_CANVAS.ownerId,
			ownedByMe: true,
			size: 0,
			createdAt: PRESEED_CANVAS.createdAt,
			updatedAt: PRESEED_CANVAS.updatedAt,
		};
	}

	function preseedIsDeleted() {
		try {
			return window.localStorage.getItem(STORAGE_KEY.preseedDeleted) === '1';
		} catch (_) {
			return false;
		}
	}
	function markPreseedDeleted() {
		try {
			window.localStorage.setItem(STORAGE_KEY.preseedDeleted, '1');
		} catch (_) {}
	}

	function readStore(key) {
		try {
			const raw = window.localStorage.getItem(key);
			return raw ? JSON.parse(raw) : {};
		} catch (_) {
			return {};
		}
	}
	function writeStore(key, value) {
		try {
			window.localStorage.setItem(key, JSON.stringify(value));
		} catch (_) {}
	}

	function _readTombstones() {
		try {
			const raw = window.localStorage.getItem(STORAGE_KEY.deletedSfIds);
			if (!raw) {
				return new Set();
			}
			const arr = JSON.parse(raw);
			return new Set(Array.isArray(arr) ? arr : []);
		} catch (_) {
			return new Set();
		}
	}
	function _writeTombstones(set) {
		try {
			window.localStorage.setItem(STORAGE_KEY.deletedSfIds, JSON.stringify(Array.from(set)));
		} catch (_) {
			/* storage full / disabled */
		}
	}
	function _idKey15(id) {
		return id ? String(id).slice(0, 15) : '';
	}
	function isTombstoned(id) {
		if (!id) {
			return false;
		}
		return _readTombstones().has(_idKey15(id));
	}
	function tombstone(id) {
		if (!id) {
			return;
		}
		const set = _readTombstones();
		set.add(_idKey15(id));
		_writeTombstones(set);
	}

	function recordsFor(objectName) {
		const canned = MOCK.records[objectName] || [];
		const overlay = readStore(STORAGE_KEY.records)[objectName] || [];
		const tombstones = _readTombstones();
		const notDeleted = (rec) => !(rec && rec.Id && tombstones.has(_idKey15(rec.Id)));
		const liveCanned = canned.filter(notDeleted);
		const liveOverlay = overlay.filter(notDeleted);
		if (liveOverlay.length === 0) {
			return liveCanned;
		}
		const overlayById = new Map();
		for (const rec of liveOverlay) {
			if (rec && rec.Id) {
				overlayById.set(String(rec.Id), rec);
			}
		}
		const merged = liveCanned.map((rec) => {
			if (!rec || !rec.Id) {
				return rec;
			}
			const ov = overlayById.get(String(rec.Id));
			return ov || rec;
		});
		const cannedIds = new Set();
		for (const rec of liveCanned) {
			if (rec && rec.Id) {
				cannedIds.add(String(rec.Id));
			}
		}
		for (const rec of liveOverlay) {
			if (rec && rec.Id && !cannedIds.has(String(rec.Id))) {
				merged.push(rec);
			}
		}
		return merged;
	}

	function findRecord(objectName, id) {
		return recordsFor(objectName).find((r) => idMatches(r.Id, id)) || null;
	}

	async function handleRecordsRefresh(req) {
		const MAX_RECORDS = 200;
		const body = await req.json().catch(() => ({}));
		const records = Array.isArray(body.records) ? body.records : [];
		if (records.length === 0) {
			return jsonResponse({ error: 'records-required' }, { status: 400 });
		}
		if (records.length > MAX_RECORDS) {
			return jsonResponse(
				{
					error: 'too-many-records',
					message: `Refresh accepts up to ${MAX_RECORDS} records per request. Split the batch on the client.`,
					max: MAX_RECORDS,
				},
				{ status: 400 },
			);
		}

		const results = records.map((record) => {
			const objectName = String((record && record.objectName) || '').trim();
			const sfId = String((record && record.sfId) || '').trim();
			if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(objectName)) {
				return { objectName, sfId, ok: false, error: 'invalid-object' };
			}
			if (!/^[a-zA-Z0-9]{15,18}$/.test(sfId)) {
				return { objectName, sfId, ok: false, error: 'invalid-id' };
			}
			if (!Object.prototype.hasOwnProperty.call(MOCK.records, objectName)) {
				return { objectName, sfId, ok: false, error: 'invalid-object' };
			}
			const found = findRecord(objectName, sfId);
			if (!found) {
				return { objectName, sfId, ok: false, error: 'not-found' };
			}
			const values = {};
			for (const [field, value] of Object.entries(found)) {
				if (field !== 'attributes') {
					values[field] = value;
				}
			}
			return { objectName, sfId, ok: true, values };
		});
		return jsonResponse({ results });
	}

	function appendRecord(objectName, record) {
		const store = readStore(STORAGE_KEY.records);
		if (!store[objectName]) {
			store[objectName] = [];
		}
		store[objectName].push(record);
		writeStore(STORAGE_KEY.records, store);
	}

	function removeUserRecord(objectName, id) {
		const store = readStore(STORAGE_KEY.records);
		const list = store[objectName] || [];
		const before = list.length;
		store[objectName] = list.filter((r) => !idMatches(r.Id, id));
		writeStore(STORAGE_KEY.records, store);
		return store[objectName].length < before;
	}

	function nextUploadIdSuffix() {
		const meta = readStore('orgloom.playground.meta');
		const next = (meta.idCounter || 100000) + 1;
		meta.idCounter = next;
		writeStore('orgloom.playground.meta', meta);
		return next;
	}

	function mockNewId(objectName) {
		const desc = MOCK.describes[objectName];
		const prefix = (desc && desc.keyPrefix) || '001';
		const n = nextUploadIdSuffix();
		return prefix + String(n).padStart(12, '0') + 'AAA';
	}

	function findDescribe(objectName) {
		return MOCK.describes[objectName] || null;
	}

	function nameFieldFor(objectName) {
		const desc = findDescribe(objectName);
		if (!desc) {
			return 'Name';
		}
		const nf = (desc.fields || []).find((f) => f.nameField);
		return (nf && nf.name) || 'Name';
	}

	function handleMe() {
		return jsonResponse({
			account: {
				id: 'playground',
				email: 'demo@orgloom.local',
				displayName: 'Demo User',
				isSuperAdmin: false,
			},
			connection: {
				id: 'demo-connection',
				sfOrgId: MOCK.demoOrgId,
				sfUserId: MOCK.demoUserId,
				instanceUrl: MOCK.instanceUrl,
				displayUsername: 'demo@orgloom.local',
				displayName: 'Org Loom Demo Org',
				email: 'demo@orgloom.local',
				orgType: 'sandbox',
				sf_org_id: MOCK.demoOrgId,
				sf_user_id: MOCK.demoUserId,
				display_name: 'Org Loom Demo Org',
				instance_url: MOCK.instanceUrl,
				org_type: 'sandbox',
			},
			workspace: {
				id: 'demo-workspace',
				name: 'Demo Workspace',
				ownerAccountId: 'playground',
				kind: 'personal',
				plan: 'pro',
				paidSeats: 1,
				role: 'admin',
			},
			license: { tier: 'pro', label: 'Pro', rank: 1 },
			orgType: 'sandbox',
			capabilities: buildPlaygroundCapabilities(),
			playgroundMode: true,
		});
	}

	function handleMeCapabilities() {
		return jsonResponse({ capabilities: buildPlaygroundCapabilities() });
	}

	function handleCapabilityCheck(capability) {
		if (buildPlaygroundCapabilities()[capability] === true) {
			return jsonResponse({ ok: true });
		}
		return jsonResponse({ error: 'member-grant-required' }, { status: 403 });
	}

	function buildPlaygroundCapabilities() {
		return {
			'connect-sf-org': true,
			'create-slot-canvas': true,
			'run-script': true,
			'invite-members': true,
			'share-canvas': true,
			'browse-records': true,
			'soql-import': true,
			'open-saved-canvas': true,
			'save-canvas': true,
			'upload-records': true,
			'recall-upload': true,
			'bulk-edit-records': true,
			'auto-fill-records': true,
			'export-canvas': true,
			'receive-canvas': true,
			'filter-orgs': true,
			'generate-records-with-ai': false,
			'ai-edit-on-canvas': true,
		};
	}

	function handleObjectsList() {
		const list = MOCK.objects
			.map((o) => ({
				name: o.name,
				label: o.label,
				labelPlural: (MOCK.describes[o.name] && MOCK.describes[o.name].labelPlural) || o.label + 's',
				keyPrefix: o.keyPrefix,
				custom: !!o.custom,
				queryable: !!o.queryable,
				createable: !!(MOCK.describes[o.name] && MOCK.describes[o.name].createable),
			}))
			.sort((a, b) => a.label.localeCompare(b.label));
		return jsonResponse(list);
	}

	function handleDescribe(objectName) {
		const desc = findDescribe(objectName);
		if (!desc) {
			return jsonResponse(
				{ error: 'unknown-object', message: 'No describe for ' + objectName + ' in the demo dataset.' },
				{ status: 404 },
			);
		}
		return jsonResponse(desc);
	}

	function handleLayout(objectName, params) {
		const layout = MOCK.layouts && MOCK.layouts[objectName];
		const desc = (MOCK.describes && MOCK.describes[objectName]) || null;
		if (!layout) {
			return jsonResponse({
				sections: [],
				available: false,
				reason: 'No layout for ' + objectName + ' in the demo dataset.',
			});
		}
		const recordId = params && params.get ? params.get('recordId') : null;
		const recordTypeId = params && params.get ? params.get('recordTypeId') : null;
		const picklistValues = {};
		if (desc && Array.isArray(desc.fields)) {
			desc.fields.forEach((f) => {
				if (f.type !== 'picklist' || !Array.isArray(f.picklistValues) || f.picklistValues.length === 0) {
					return;
				}
				picklistValues[f.name] = {
					controllerValues: null,
					defaultValue: (f.picklistValues.find((v) => v.defaultValue) || {}).value || null,
					values: f.picklistValues.map((v) => ({
						label: v.label || v.value,
						value: v.value,
						validFor: v.validFor || [],
					})),
				};
			});
		}
		const defaults = {};
		if (recordId) {
			const rec = findRecord(objectName, recordId);
			if (rec) {
				Object.keys(rec).forEach((k) => {
					if (rec[k] !== null && rec[k] !== undefined) {
						defaults[k] = rec[k];
					}
				});
			}
		}
		const resolvedRecordTypeId =
			recordTypeId ||
			(desc &&
				Array.isArray(desc.recordTypeInfos) &&
				desc.recordTypeInfos[0] &&
				desc.recordTypeInfos[0].recordTypeId) ||
			null;
		return jsonResponse({
			sections: layout.sections,
			available: true,
			recordTypeId: resolvedRecordTypeId,
			columns: layout.columns || 2,
			defaults,
			fieldPerms: {},
			picklistValues,
		});
	}

	function handleGraph(objectName) {
		const desc = findDescribe(objectName);
		if (!desc) {
			return jsonResponse(
				{ error: 'unknown-object', message: 'No describe for ' + objectName + ' in the demo dataset.' },
				{ status: 404 },
			);
		}
		const parents = [];
		const parentSeen = new Set();
		for (const f of desc.fields || []) {
			if (f.type !== 'reference' || !Array.isArray(f.referenceTo)) {
				continue;
			}
			for (const target of f.referenceTo) {
				const key = target + '|' + f.name;
				if (parentSeen.has(key)) {
					continue;
				}
				parentSeen.add(key);
				if (!MOCK.describes[target]) {
					continue;
				}
				parents.push({
					object: target,
					field: f.name,
					label: f.label || f.name,
					required: !f.nillable && !f.defaultedOnCreate,
					createable: !!f.createable,
					updateable: !!f.updateable,
				});
			}
		}
		const children = [];
		const childSeen = new Set();
		for (const cr of desc.childRelationships || []) {
			if (!cr.childSObject || !MOCK.describes[cr.childSObject]) {
				continue;
			}
			const key = cr.childSObject + '|' + (cr.field || '');
			if (childSeen.has(key)) {
				continue;
			}
			childSeen.add(key);
			children.push({
				object: cr.childSObject,
				field: cr.field,
				relationshipName: cr.relationshipName,
			});
		}
		return jsonResponse({
			name: desc.name,
			label: desc.label || desc.name,
			parents,
			children,
		});
	}

	function searchFieldsFor(objectName) {
		return [nameFieldFor(objectName), ...(objectName === 'Case' ? ['Subject'] : [])];
	}
	function matchesSearch(record, objectName, query) {
		const q = String(query || '').trim();
		if (!q) {
			return true;
		}
		if (/^(?:[a-zA-Z0-9]{15}|[a-zA-Z0-9]{18})$/.test(q)) {
			return idMatches(record.Id, q);
		}
		return searchFieldsFor(objectName).some((name) =>
			String(record[name] || '')
				.toLowerCase()
				.includes(q.toLowerCase()),
		);
	}
	function handleSearch(objectName, query) {
		const list = recordsFor(objectName);
		if (!list.length) {
			return jsonResponse({ records: [], nameField: 'Name' });
		}
		const nameField = nameFieldFor(objectName);
		const matched = list.filter((r) => matchesSearch(r, objectName, query));
		return jsonResponse({
			nameField,
			searchFields: searchFieldsFor(objectName),
			records: matched.slice(0, 20).map((r) => ({
				id: r.Id,
				name: objectName === 'Case' && r.Subject ? r[nameField] + ' — ' + r.Subject : r[nameField],
			})),
		});
	}

	function handleLookup(objectName, params) {
		const fieldName = params.get('fieldName');
		const q = (params.get('q') || '').toLowerCase().trim();
		const sourceRecordId = params.get('sourceRecordId');
		const requestedTarget = params.get('targetApiName');

		const sourceDesc = findDescribe(objectName);
		if (!sourceDesc) {
			return jsonResponse({ records: [], available: false });
		}
		const fieldMeta = (sourceDesc.fields || []).find((f) => f.name === fieldName);
		if (!fieldMeta || !Array.isArray(fieldMeta.referenceTo) || fieldMeta.referenceTo.length === 0) {
			return jsonResponse({ records: [], available: true, source: 'mock' });
		}
		if (requestedTarget && !fieldMeta.referenceTo.includes(requestedTarget)) {
			return jsonResponse({ error: 'invalid-lookup-target' }, { status: 400 });
		}
		if (!requestedTarget && fieldMeta.referenceTo.length > 1) {
			return jsonResponse({ error: 'lookup-target-required' }, { status: 400 });
		}
		const targetObject = requestedTarget || fieldMeta.referenceTo[0];
		const list = recordsFor(targetObject);
		const nameField = nameFieldFor(targetObject);
		let matched = q
			? list.filter((r) =>
					String(r[nameField] || '')
						.toLowerCase()
						.includes(q),
				)
			: list.slice(0, 25);
		if (sourceRecordId) {
			matched = matched.filter((r) => !idMatches(r.Id, sourceRecordId));
		}
		return jsonResponse({
			records: matched.slice(0, 25).map((r) => ({
				id: r.Id,
				apiName: targetObject,
				icon: null,
				title: r[nameField] || r.Id,
				subtitle: null,
			})),
			available: true,
			source: 'mock',
		});
	}

	function handleRecord(objectName, id) {
		const rec = findRecord(objectName, id);
		if (!rec) {
			return jsonResponse({ error: 'not-found' }, { status: 404 });
		}
		return jsonResponse(rec);
	}

	function handleRelatedCount(objectName, params) {
		const field = params.get('field');
		const id = params.get('id');
		const count = recordsFor(objectName).filter((r) => idMatches(r[field], id)).length;
		return jsonResponse({ count });
	}

	function handleByRef(objectName, params) {
		const field = params.get('field');
		const id = params.get('id');
		const requested = Number(params.get('limit')) || 50;
		const limit = Math.max(1, Math.min(requested, 200));
		const records = recordsFor(objectName)
			.filter((r) => idMatches(r[field], id))
			.slice(0, limit);
		return jsonResponse({ records, skipped: false });
	}

	async function handleRelatedCountsPost(req) {
		const body = await req.json().catch(() => ({}));
		const probes = Array.isArray(body && body.probes) ? body.probes : [];
		const counts = probes.map((p) => {
			const count = recordsFor(p && p.name).filter((r) => idMatches(r[p.field], p.id)).length;
			return { name: p.name, field: p.field, id: p.id, count };
		});
		return jsonResponse({ counts });
	}

	function handleLimits() {
		return jsonResponse({
			DailyApiRequests: { Max: 15000, Remaining: 14987 },
			DataStorageMB: { Max: 1024, Remaining: 1018 },
		});
	}

	function handleAiStatus() {
		return jsonResponse({
			enabled: false,
			model: 'mock',
			usage: null,
			planLabel: 'Demo',
		});
	}

	function handleSfUsersSearch(params) {
		const q = (params && params.get && params.get('q')) || '';
		const demoUsers = [
			{ id: '005DEMO000000001', name: 'Alex Chen', email: 'alex@example.com', username: 'alex.chen@example.com' },
			{
				id: '005DEMO000000002',
				name: 'Priya Patel',
				email: 'priya@example.com',
				username: 'priya.patel@example.com',
			},
			{
				id: '005DEMO000000003',
				name: 'Sam Rivera',
				email: 'sam@example.com',
				username: 'sam.rivera@example.com',
			},
		];
		const ql = q.toLowerCase().trim();
		const users = ql
			? demoUsers.filter(
					(u) => u.name.toLowerCase().includes(ql) || u.email.includes(ql) || u.username.includes(ql),
				)
			: demoUsers;
		return jsonResponse({ users });
	}

	function handleCanvasShareLinks() {
		return jsonResponse({ shares: [], directShares: [] });
	}

	function handleCanvasList() {
		const store = readStore(STORAGE_KEY.canvases);
		const userItems = Object.values(store)
			.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
			.map((c) => ({
				id: c.id,
				versionId: c.versionId,
				title: c.title,
				ownerId: c.ownerId || MOCK.demoUserId,
				ownedByMe: true,
				size: 0,
				createdAt: c.createdAt,
				updatedAt: c.updatedAt,
			}));
		const userHasPreseed = !!store[PRESEED_CANVAS.id];
		const items = userItems.slice();
		if (!userHasPreseed && !preseedIsDeleted()) {
			items.push(preseedSummary());
		}
		return jsonResponse({ items });
	}

	async function handleCanvasCreate(req) {
		const body = await req.json().catch(() => ({}));
		const name = String(body.name || '').trim();
		if (!name) {
			return jsonResponse({ error: 'name-required' }, { status: 400 });
		}
		if (!body.payload || typeof body.payload !== 'object') {
			return jsonResponse({ error: 'payload-required' }, { status: 400 });
		}
		const id = '069' + String(nextUploadIdSuffix()).padStart(12, '0') + 'AAA';
		const versionId = '068' + String(nextUploadIdSuffix()).padStart(12, '0') + 'AAA';
		const now = Date.now();
		const store = readStore(STORAGE_KEY.canvases);
		store[id] = {
			id,
			versionId,
			title: name,
			ownerId: MOCK.demoUserId,
			ownedByMe: true,
			createdAt: now,
			updatedAt: now,
			payload: body.payload,
		};
		writeStore(STORAGE_KEY.canvases, store);
		return jsonResponse({ id, versionId });
	}

	async function handleCanvasUpdate(req, canvasId) {
		const body = await req.json().catch(() => ({}));
		const store = readStore(STORAGE_KEY.canvases);
		let existing = store[canvasId];
		if (!existing && canvasId === PRESEED_CANVAS.id && !preseedIsDeleted()) {
			existing = {
				id: PRESEED_CANVAS.id,
				versionId: PRESEED_CANVAS.versionId,
				title: PRESEED_CANVAS.title,
				ownerId: PRESEED_CANVAS.ownerId,
				ownedByMe: true,
				createdAt: PRESEED_CANVAS.createdAt,
				updatedAt: PRESEED_CANVAS.updatedAt,
				payload: PRESEED_CANVAS.payload,
			};
		}
		if (!existing) {
			return jsonResponse({ error: 'not-found' }, { status: 404 });
		}
		if (!body.payload || typeof body.payload !== 'object') {
			return jsonResponse({ error: 'payload-required' }, { status: 400 });
		}
		const versionId = '068' + String(nextUploadIdSuffix()).padStart(12, '0') + 'AAA';
		existing.payload = body.payload;
		existing.versionId = versionId;
		existing.updatedAt = Date.now();
		store[canvasId] = existing;
		writeStore(STORAGE_KEY.canvases, store);
		return jsonResponse({ ok: true, backend: 'mock', id: canvasId, versionId, title: existing.title });
	}

	function handleCanvasGet(canvasId) {
		const store = readStore(STORAGE_KEY.canvases);
		const c = store[canvasId] || (canvasId === PRESEED_CANVAS.id && !preseedIsDeleted() ? PRESEED_CANVAS : null);
		if (!c) {
			return jsonResponse({ error: 'not-found' }, { status: 404 });
		}
		return jsonResponse({
			id: c.id,
			versionId: c.versionId,
			title: c.title,
			ownerId: c.ownerId || MOCK.demoUserId,
			ownedByMe: true,
			createdAt: c.createdAt,
			updatedAt: c.updatedAt,
			payload: c.payload,
			recipientRole: 'owner',
			recipientHasAccount: true,
			staleRefs: [],
		});
	}

	function handleCanvasClarifications() {
		return jsonResponse({ clarifications: [] });
	}
	function handleCanvasProposals() {
		return jsonResponse({ proposals: [] });
	}
	function handleAuditEvent() {
		return jsonResponse({ ok: true });
	}
	function handleMcpRelay() {
		return jsonResponse({ ok: true });
	}

	function handleCanvasDelete(canvasId) {
		const store = readStore(STORAGE_KEY.canvases);
		const inStore = !!store[canvasId];
		const isPreseed = canvasId === PRESEED_CANVAS.id;
		if (!inStore && !isPreseed) {
			return jsonResponse({ error: 'not-found' }, { status: 404 });
		}
		if (inStore) {
			delete store[canvasId];
			writeStore(STORAGE_KEY.canvases, store);
		}
		if (isPreseed) {
			markPreseedDeleted();
		}
		return jsonResponse({ ok: true });
	}

	function processUploadedRecord(rec, idMap) {
		if (!rec || !rec.objectName) {
			return { tempId: rec && rec.tempId, success: false, error: 'no-object' };
		}
		const newId = rec.loadedFromId || mockNewId(rec.objectName);
		const resolved = {};
		Object.keys(rec.values || {}).forEach((k) => {
			const v = rec.values[k];
			if (typeof v === 'string' && /^@\{(.*?)\.id\}$/.test(v)) {
				const refTempId = v.match(/^@\{(.*?)\.id\}$/)[1];
				resolved[k] = idMap[refTempId] || v;
			} else if (idMap[v] != null) {
				resolved[k] = idMap[v];
			} else {
				resolved[k] = v;
			}
		});
		const overlay = Object.assign({}, resolved, {
			Id: newId,
			OwnerId: resolved.OwnerId || MOCK.demoUserId,
			CreatedById: MOCK.demoUserId,
			LastModifiedById: MOCK.demoUserId,
			CreatedDate: new Date().toISOString(),
			LastModifiedDate: new Date().toISOString(),
			SystemModstamp: new Date().toISOString(),
		});
		appendRecord(rec.objectName, overlay);
		idMap[rec.tempId] = newId;
		return {
			tempId: rec.tempId,
			success: true,
			id: newId,
			objectName: rec.objectName,
			mode: rec.loadedFromId ? 'update' : 'create',
		};
	}

	function processUploadRecords(records, skipTempIds, associations) {
		const skipped = new Set(Array.isArray(skipTempIds) ? skipTempIds : []);
		const idMap = {};
		for (const rec of records) {
			if (rec && rec.loadedFromId && skipped.has(rec.tempId)) {
				idMap[rec.tempId] = rec.loadedFromId;
			}
		}
		const results = records.map((rec) => {
			if (rec && rec.loadedFromId && skipped.has(rec.tempId)) {
				return {
					tempId: rec.tempId,
					success: true,
					id: rec.loadedFromId,
					objectName: rec.objectName,
					mode: 'unchanged',
				};
			}
			return processUploadedRecord(rec, idMap);
		});
		// Persist links before producing a refresh snapshot, just as the upload APIs do.
		for (const link of associations || []) {
			const child = results.find((row) => row.tempId === link.fromId && row.success && row.mode !== 'unchanged');
			const parentId = idMap[link.toId];
			if (!child || !parentId || !link.fieldName) continue;
			const record = findRecord(child.objectName, child.id);
			if (!record) continue;
			const updated = { ...record, [link.fieldName]: parentId };
			removeUserRecord(child.objectName, child.id);
			appendRecord(child.objectName, updated);
		}
		return results;
	}

	function processDelete(del) {
		if (!del || !del.sfId) {
			return { tempId: del && del.tempId, success: false, error: 'Missing sfId' };
		}
		tombstone(del.sfId);
		if (del.objectName) {
			removeUserRecord(del.objectName, del.sfId);
		}
		return {
			tempId: del.tempId,
			sfId: del.sfId,
			objectName: del.objectName,
			success: true,
			mode: 'delete',
		};
	}

	function recordBatch(records, associations, source, note, deletes) {
		const insertedIds = records
			.filter((r) => r.success && r.id && r.mode !== 'unchanged')
			.map((r) => ({
				tempId: r.tempId,
				sfId: r.id,
				objectName: r.objectName,
				mode: r.mode || 'create',
				label: null,
			}));
		const deletedIds = (deletes || [])
			.filter((d) => d && d.success && d.sfId)
			.map((d) => ({
				tempId: d.tempId || null,
				sfId: d.sfId,
				objectName: d.objectName || null,
			}));
		if (insertedIds.length === 0 && deletedIds.length === 0) {
			return null;
		}
		const batchId = 'ub_' + Date.now() + '_' + nextUploadIdSuffix();
		const externalId = '00B' + String(nextUploadIdSuffix()).padStart(12, '0') + 'AAA';
		const now = Date.now();
		const store = readStore(STORAGE_KEY.uploads);
		store[batchId] = {
			id: batchId,
			externalId,
			source: source || 'canvas',
			recordCount: insertedIds.length + deletedIds.length,
			note: note || null,
			status: 'uploaded',
			createdAt: now,
			recalledAt: null,
			recallResult: null,
			sfOrgId: MOCK.demoOrgId,
			insertedIds,
			deletedIds,
			associations: (associations || []).map((a) => ({
				fromTempId: a.fromId,
				toTempId: a.toId,
				fieldName: a.fieldName,
			})),
		};
		writeStore(STORAGE_KEY.uploads, store);
		return batchId;
	}

	function refreshedUploadValues(results) {
		const values = {};
		for (const result of results) {
			if (!result.success || result.mode === 'unchanged') continue;
			const record = findRecord(result.objectName, result.id);
			if (record)
				values[result.tempId] = Object.fromEntries(
					Object.entries(record).filter(([key]) => key !== 'attributes'),
				);
		}
		return values;
	}

	async function handleUpload(req) {
		const body = await req.json().catch(() => ({}));
		const records = Array.isArray(body.records) ? body.records : [];
		const associations = Array.isArray(body.associations) ? body.associations : [];
		const deletes = Array.isArray(body.deletes) ? body.deletes : [];
		const results = processUploadRecords(records, body.skipTempIds, associations);
		const deleteResults = deletes.map(processDelete);
		const batchId = recordBatch(results, associations, 'canvas', body.note, deleteResults);
		return jsonResponse({
			results,
			canonicalValues: refreshedUploadValues(results),
			deletes: deleteResults,
			instanceUrl: MOCK.instanceUrl,
			batchId,
		});
	}

	async function handleUploadGraph(req) {
		const body = await req.json().catch(() => ({}));
		const records = Array.isArray(body.records) ? body.records : [];
		const associations = Array.isArray(body.associations) ? body.associations : [];
		const deletes = Array.isArray(body.deletes) ? body.deletes : [];
		const results = processUploadRecords(records, body.skipTempIds, associations);
		const deleteResults = deletes.map(processDelete);
		const batchId = recordBatch(results, associations, 'canvas-graph', body.note, deleteResults);
		return jsonResponse({
			results,
			canonicalValues: refreshedUploadValues(results),
			deletes: deleteResults,
			instanceUrl: MOCK.instanceUrl,
			mode: 'graph',
			atomicSuccess: true,
			graphCount: 1,
			batchId,
		});
	}

	async function handleUploadBulk(req) {
		const body = await req.json().catch(() => ({}));
		const records = Array.isArray(body.records) ? body.records : [];
		const deletes = Array.isArray(body.deletes) ? body.deletes : [];
		const results = processUploadRecords(records, body.skipTempIds, body.associations);
		const deleteResults = deletes.map(processDelete);
		return jsonResponse({
			results,
			deletes: deleteResults,
			instanceUrl: MOCK.instanceUrl,
			mode: 'bulk',
			canonicalValues: refreshedUploadValues(results),
			batchId: recordBatch(results, body.associations || [], 'canvas-bulk', body.note, deleteResults),
		});
	}

	function handleBatchesList() {
		const store = readStore(STORAGE_KEY.uploads);
		const batches = Object.values(store)
			.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
			.map((b) => ({
				id: b.id,
				externalId: b.externalId,
				createdAt: b.createdAt,
				status: b.status,
				source: b.source,
				recordCount: b.recordCount,
				note: b.note,
				recalledAt: b.recalledAt,
				sfOrgId: b.sfOrgId,
				insertedCount: Array.isArray(b.insertedIds) ? b.insertedIds.length : 0,
				deletedCount: Array.isArray(b.deletedIds) ? b.deletedIds.length : 0,
			}));
		return jsonResponse({ batches });
	}

	function handleBatchGet(batchId) {
		const store = readStore(STORAGE_KEY.uploads);
		const b = store[batchId];
		if (!b) {
			return jsonResponse({ error: 'not-found' }, { status: 404 });
		}
		return jsonResponse({ batch: b });
	}

	async function handleBatchRecallPreflight(batchId) {
		const store = readStore(STORAGE_KEY.uploads);
		const b = store[batchId];
		if (!b) {
			return jsonResponse({ error: 'not-found' }, { status: 404 });
		}
		return jsonResponse({
			clean: b.insertedIds,
			drifted: [],
			alreadyDeleted: [],
			updates: [],
			unverified: [],
			cascadeConflicts: [],
			batch: { id: b.id, createdAt: b.createdAt, recordCount: b.recordCount, sfOrgId: b.sfOrgId },
		});
	}

	async function handleBatchRecall(batchId) {
		const store = readStore(STORAGE_KEY.uploads);
		const b = store[batchId];
		if (!b) {
			return jsonResponse({ error: 'not-found' }, { status: 404 });
		}
		if (b.recalledAt) {
			return jsonResponse({ error: 'already-recalled' }, { status: 409 });
		}
		const results = [];
		let succeeded = 0;
		for (const ins of b.insertedIds || []) {
			const removed = removeUserRecord(ins.objectName, ins.sfId);
			if (removed) {
				results.push({
					tempId: ins.tempId,
					sfId: ins.sfId,
					objectName: ins.objectName,
					label: ins.label || null,
					success: true,
				});
				succeeded++;
			} else {
				results.push({
					tempId: ins.tempId,
					sfId: ins.sfId,
					objectName: ins.objectName,
					label: ins.label || null,
					success: true,
					note: 'Already deleted',
				});
			}
		}
		const alreadyDeletedCount = results.length - succeeded;
		b.recalledAt = Date.now();
		b.status = 'recalled';
		b.recallResult = { succeeded, alreadyDeleted: alreadyDeletedCount, failed: 0, results };
		writeStore(STORAGE_KEY.uploads, store);
		return jsonResponse({
			ok: true,
			status: 'recalled',
			successCount: succeeded,
			alreadyDeletedCount,
			failureCount: 0,
			preservedUpdatesCount: 0,
			results,
		});
	}

	function handleBatchDelete(batchId) {
		const store = readStore(STORAGE_KEY.uploads);
		if (!store[batchId]) {
			return jsonResponse({ error: 'not-found' }, { status: 404 });
		}
		delete store[batchId];
		writeStore(STORAGE_KEY.uploads, store);
		return jsonResponse({ ok: true });
	}

	async function handleQuery(req) {
		const body = await req.json().catch(() => ({}));
		const fullFields = body.fullFields === false ? false : true;
		const soql = String(body.soql || '');

		function outerQueryObject(query) {
			let depth = 0;
			let quote = null;
			for (let i = 0; i < query.length; i++) {
				const char = query[i];
				if (quote) {
					if (char === '\\') {
						i++;
					} else if (char === quote) {
						quote = null;
					}
					continue;
				}
				if (char === "'" || char === '"') {
					quote = char;
					continue;
				}
				if (char === '(') {
					depth++;
					continue;
				}
				if (char === ')') {
					depth = Math.max(0, depth - 1);
					continue;
				}
				if (depth !== 0) {
					continue;
				}
				const match = query.slice(i).match(/^FROM\s+([A-Za-z][A-Za-z0-9_]*)\b/i);
				if (match && (i === 0 || !/[A-Za-z0-9_]/.test(query[i - 1]))) {
					return match[1];
				}
			}
			return null;
		}

		const queryObject = outerQueryObject(soql) || 'Account';
		const inMatch = soql.match(/WHERE\s+Id\s+IN\s*\(([^)]*)\)/i);
		const explicitIds = inMatch ? Array.from(inMatch[1].matchAll(/'([^']+)'/g)).map((m) => m[1]) : null;
		const hasContactsSubquery = /\(\s*SELECT[\s\S]*FROM\s+Contacts\s*\)/i.test(soql);

		function projectValues(source, fieldList) {
			if (fullFields) {
				const v = {};
				Object.keys(source).forEach((k) => {
					if (k === 'attributes') {
						return;
					}
					if (source[k] !== null && source[k] !== undefined) {
						v[k] = source[k];
					}
				});
				return v;
			}
			const v = { Id: source.Id };
			(fieldList || []).forEach((f) => {
				if (source[f] !== undefined) {
					v[f] = source[f];
				}
			});
			return v;
		}

		if (explicitIds) {
			const allRecords = recordsFor(queryObject);
			const wanted = new Set(explicitIds);
			const matching = allRecords.filter((r) => r && wanted.has(r.Id));
			const tempCounter = { n: 1 };
			const records = matching.map((rec) => ({
				tempId: tempCounter.n++,
				objectName: queryObject,
				loadedFromId: rec.Id,
				values: projectValues(rec, []),
			}));
			return jsonResponse({
				objectName: queryObject,
				records,
				associations: [],
				totalSize: matching.length,
				returned: matching.length,
				truncated: false,
				fullFields,
			});
		}

		if (hasContactsSubquery && queryObject === 'Account') {
			const PARENT_OBJECT = 'Account';
			const PARENT_FIELDS = ['Name', 'Industry', 'Phone', 'Type'];
			const CHILD_OBJECT = 'Contact';
			const CHILD_FK = 'AccountId';
			const CHILD_FIELDS = ['FirstName', 'LastName', 'Email', 'Title'];
			const PARENT_LIMIT = 5;
			const CHILDREN_PER_PARENT = 3;
			const allParents = recordsFor(PARENT_OBJECT);
			const techParents = allParents.filter((a) => a && a.Industry === 'Technology').slice(0, PARENT_LIMIT);
			const allChildren = recordsFor(CHILD_OBJECT);
			const tempCounter = { n: 1 };
			const records = [];
			const associations = [];
			for (const parent of techParents) {
				const parentTempId = tempCounter.n++;
				records.push({
					tempId: parentTempId,
					objectName: PARENT_OBJECT,
					loadedFromId: parent.Id,
					values: projectValues(parent, PARENT_FIELDS),
				});
				const childrenForParent = allChildren
					.filter((c) => c[CHILD_FK] === parent.Id)
					.slice(0, CHILDREN_PER_PARENT);
				for (const child of childrenForParent) {
					const childTempId = tempCounter.n++;
					records.push({
						tempId: childTempId,
						objectName: CHILD_OBJECT,
						loadedFromId: child.Id,
						values: projectValues(child, CHILD_FIELDS),
					});
					associations.push({
						fromTempId: childTempId,
						toTempId: parentTempId,
						fieldName: CHILD_FK,
					});
				}
			}
			return jsonResponse({
				objectName: PARENT_OBJECT,
				records,
				associations,
				totalSize: techParents.length,
				returned: techParents.length,
				truncated: false,
				fullFields,
			});
		}

		const allRecords = recordsFor(queryObject);
		const tempCounter = { n: 1 };
		const records = allRecords.map((rec) => ({
			tempId: tempCounter.n++,
			objectName: queryObject,
			loadedFromId: rec.Id,
			values: projectValues(rec, []),
		}));
		return jsonResponse({
			objectName: queryObject,
			records,
			associations: [],
			totalSize: allRecords.length,
			returned: allRecords.length,
			truncated: false,
			fullFields,
		});
	}

	async function handleBrowse(req) {
		const body = await req.json().catch(() => ({}));
		const objectName = String(body.objectName || '').trim();
		const filters = Array.isArray(body.filters) ? body.filters : [];
		const sort = body.sort || null;
		const limit = Math.max(1, Math.min(200, parseInt(body.limit, 10) || 25));
		const offset = Math.max(0, parseInt(body.offset, 10) || 0);
		if (!objectName) {
			return jsonResponse({ error: 'invalid-object-name' }, { status: 400 });
		}
		const allRecords = recordsFor(objectName);
		function _matches(rec, filt) {
			if (!filt || !filt.field) {
				return true;
			}
			const val = rec[filt.field];
			const v = filt.value;
			const has = val !== null && val !== undefined && val !== '';
			switch (filt.op) {
				case 'isNull':
					return !has;
				case 'isNotNull':
					return has;
				case 'equals':
					return String(val) === String(v);
				case 'notEquals':
					return String(val) !== String(v);
				case 'contains':
					return has && String(val).toLowerCase().includes(String(v).toLowerCase());
				case 'startsWith':
					return has && String(val).toLowerCase().startsWith(String(v).toLowerCase());
				case 'in':
					return Array.isArray(v) && v.some((x) => String(x) === String(val));
				case 'gt':
					return has && Number(val) > Number(v);
				case 'gte':
					return has && Number(val) >= Number(v);
				case 'lt':
					return has && Number(val) < Number(v);
				case 'lte':
					return has && Number(val) <= Number(v);
				case 'before':
					return has && new Date(val) < new Date(v);
				case 'after':
					return has && new Date(val) > new Date(v);
				case 'between':
					return (
						has &&
						Array.isArray(v) &&
						v.length === 2 &&
						new Date(val) >= new Date(v[0]) &&
						new Date(val) <= new Date(v[1])
					);
				default:
					return true;
			}
		}
		let matching = allRecords.filter(
			(rec) => matchesSearch(rec, objectName, body.search) && filters.every((f) => _matches(rec, f)),
		);
		if (sort && sort.field) {
			const dir = sort.direction === 'desc' ? -1 : 1;
			matching = matching.slice().sort((a, b) => {
				const av = a[sort.field],
					bv = b[sort.field];
				if (av == null && bv == null) {
					return 0;
				}
				if (av == null) {
					return 1;
				} // nulls last regardless of direction
				if (bv == null) {
					return -1;
				}
				if (typeof av === 'number' && typeof bv === 'number') {
					return dir * (av - bv);
				}
				return dir * String(av).localeCompare(String(bv));
			});
		}
		const count = matching.length;
		const onCanvasSet = new Set(Array.isArray(body.onCanvasIds) ? body.onCanvasIds : []);
		const loadableCount = onCanvasSet.size ? matching.filter((rec) => !onCanvasSet.has(rec.Id)).length : count;
		const page = matching.slice(offset, offset + limit);

		const previewFields = ['Id'];
		const sample = page[0] || matching[0] || {};
		const nameCandidate = ['Name', 'Subject', 'Title', 'CaseNumber'].find((n) => sample[n] !== undefined);
		if (nameCandidate) {
			previewFields.push(nameCandidate);
		}
		if (objectName === 'Case' && !previewFields.includes('CaseNumber')) {
			previewFields.push('CaseNumber');
		}
		for (const f of filters) {
			if (f && f.field && sample[f.field] !== undefined && !previewFields.includes(f.field)) {
				previewFields.push(f.field);
				if (previewFields.length >= 6) {
					break;
				}
			}
		}
		const projected = page.map((rec) => {
			const out = {};
			previewFields.forEach((fn) => {
				if (rec[fn] !== undefined) {
					out[fn] = rec[fn];
				}
			});
			return out;
		});

		const orderClause =
			sort && sort.field ? ' ORDER BY ' + sort.field + ' ' + (sort.direction === 'desc' ? 'DESC' : 'ASC') : '';
		// The demo query handler supports explicit IDs, not arbitrary WHERE expressions.
		// Carry all matching IDs (not just the preview page) into the canvas load.
		const loadSoql =
			'SELECT Id FROM ' +
			objectName +
			' WHERE Id IN (' +
			matching.map((rec) => "'" + rec.Id + "'").join(', ') +
			')' +
			orderClause;
		const previewSoql = loadSoql + ' LIMIT ' + limit + ' OFFSET ' + offset;
		return jsonResponse({
			count,
			loadableCount,
			records: projected,
			hasMore: count > offset + page.length,
			previewFields,
			previewSoql,
			loadSoql,
		});
	}

	const ROUTES = [
		{ method: 'GET', match: (u) => u.pathname === '/api/me' && handleMe() },

		{ method: 'GET', match: (u) => u.pathname === '/api/me/capabilities' && handleMeCapabilities() },
		{
			method: 'POST',
			match: (u) => {
				const m = u.pathname.match(
					/^\/api\/capabilities\/(run-script|bulk-edit-records|auto-fill-records)\/check$/,
				);
				return m && handleCapabilityCheck(m[1]);
			},
		},

		{ method: 'GET', match: (u) => u.pathname === '/api/objects' && handleObjectsList() },

		{
			method: 'GET',
			match: (u) => {
				const m = u.pathname.match(/^\/api\/objects\/([^/]+)\/describe$/);
				return m && handleDescribe(decodeURIComponent(m[1]));
			},
		},

		{
			method: 'GET',
			match: (u) => {
				const m = u.pathname.match(/^\/api\/objects\/([^/]+)\/graph$/);
				return m && handleGraph(decodeURIComponent(m[1]));
			},
		},

		{
			method: 'GET',
			match: (u) => {
				const m = u.pathname.match(/^\/api\/objects\/([^/]+)\/layout$/);
				return m && handleLayout(decodeURIComponent(m[1]), u.searchParams);
			},
		},

		{
			method: 'GET',
			match: (u) => {
				const m = u.pathname.match(/^\/api\/objects\/([^/]+)\/search$/);
				return m && handleSearch(decodeURIComponent(m[1]), u.searchParams.get('q'));
			},
		},

		{
			method: 'GET',
			match: (u) => {
				const m = u.pathname.match(/^\/api\/objects\/([^/]+)\/lookup$/);
				return m && handleLookup(decodeURIComponent(m[1]), u.searchParams);
			},
		},

		{
			method: 'GET',
			match: (u) => {
				const m = u.pathname.match(/^\/api\/objects\/([^/]+)\/records\/([^/]+)$/);
				return m && handleRecord(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
			},
		},

		{
			method: 'GET',
			match: (u) => {
				const m = u.pathname.match(/^\/api\/objects\/([^/]+)\/by-ref$/);
				return m && handleByRef(decodeURIComponent(m[1]), u.searchParams);
			},
		},

		{
			method: 'GET',
			match: (u) => {
				const m = u.pathname.match(/^\/api\/objects\/([^/]+)\/related-count$/);
				return m && handleRelatedCount(decodeURIComponent(m[1]), u.searchParams);
			},
		},

		{ method: 'POST', match: (u, req) => u.pathname === '/api/related-counts' && handleRelatedCountsPost(req) },
		{ method: 'POST', match: (u, req) => u.pathname === '/api/records/refresh' && handleRecordsRefresh(req) },

		{ method: 'GET', match: (u) => u.pathname === '/api/limits' && handleLimits() },

		{ method: 'GET', match: (u) => u.pathname === '/api/ai/status' && handleAiStatus() },

		{ method: 'GET', match: (u) => u.pathname === '/api/sf/users/search' && handleSfUsersSearch(u.searchParams) },
		{
			method: 'GET',
			match: (u) => {
				const m = u.pathname.match(/^\/api\/canvas\/[^/]+\/share-links$/);
				return m && handleCanvasShareLinks();
			},
		},

		{ method: 'GET', match: (u) => u.pathname === '/api/canvas' && handleCanvasList() },
		{ method: 'POST', match: (u, req) => u.pathname === '/api/canvas' && handleCanvasCreate(req) },
		{
			method: 'GET',
			match: (u) => {
				const m = u.pathname.match(/^\/api\/canvas\/([^/]+)$/);
				return m && handleCanvasGet(decodeURIComponent(m[1]));
			},
		},
		{
			method: 'PUT',
			match: (u, req) => {
				const m = u.pathname.match(/^\/api\/canvas\/([^/]+)$/);
				return m && handleCanvasUpdate(req, decodeURIComponent(m[1]));
			},
		},
		{
			method: 'DELETE',
			match: (u) => {
				const m = u.pathname.match(/^\/api\/canvas\/([^/]+)$/);
				return m && handleCanvasDelete(decodeURIComponent(m[1]));
			},
		},

		{
			method: 'GET',
			match: (u) => {
				const m = u.pathname.match(/^\/api\/canvas\/[^/]+\/clarifications$/);
				return m && handleCanvasClarifications();
			},
		},
		{
			method: 'GET',
			match: (u) => {
				const m = u.pathname.match(/^\/api\/canvas\/[^/]+\/proposals$/);
				return m && handleCanvasProposals();
			},
		},
		{ method: 'POST', match: (u) => u.pathname === '/api/audit-event' && handleAuditEvent() },
		{ method: 'POST', match: (u) => u.pathname === '/api/mcp/relay/register' && handleMcpRelay() },
		{ method: 'POST', match: (u) => u.pathname === '/api/mcp/relay/unregister' && handleMcpRelay() },

		{ method: 'POST', match: (u) => u.pathname === '/api/upload/access-check' && jsonResponse({ ok: true }) },
		{ method: 'POST', match: (u, req) => u.pathname === '/api/upload' && handleUpload(req) },
		{ method: 'POST', match: (u, req) => u.pathname === '/api/upload/graph' && handleUploadGraph(req) },
		{ method: 'POST', match: (u, req) => u.pathname === '/api/upload/bulk' && handleUploadBulk(req) },

		{ method: 'GET', match: (u) => u.pathname === '/api/upload-batches' && handleBatchesList() },
		{
			method: 'GET',
			match: (u) => {
				const m = u.pathname.match(/^\/api\/upload-batches\/([^/]+)$/);
				return m && handleBatchGet(decodeURIComponent(m[1]));
			},
		},
		{
			method: 'POST',
			match: (u) => {
				const m = u.pathname.match(/^\/api\/upload-batches\/([^/]+)\/recall-preflight$/);
				return m && handleBatchRecallPreflight(decodeURIComponent(m[1]));
			},
		},
		{
			method: 'POST',
			match: (u) => {
				const m = u.pathname.match(/^\/api\/upload-batches\/([^/]+)\/recall$/);
				return m && handleBatchRecall(decodeURIComponent(m[1]));
			},
		},
		{
			method: 'DELETE',
			match: (u) => {
				const m = u.pathname.match(/^\/api\/upload-batches\/([^/]+)$/);
				return m && handleBatchDelete(decodeURIComponent(m[1]));
			},
		},

		{ method: 'POST', match: (u, req) => u.pathname === '/api/query' && handleQuery(req) },

		{ method: 'POST', match: (u, req) => u.pathname === '/api/browse' && handleBrowse(req) },
	];

	window.fetch = function mockFetch(input, init) {
		const method = ((init && init.method) || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
		const urlStr = typeof input === 'string' ? input : input.url;
		let url;
		try {
			url = new URL(urlStr, window.location.origin);
		} catch (_) {
			return _realFetch(input, init);
		}

		if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) {
			return _realFetch(input, init);
		}

		for (const route of ROUTES) {
			if (route.method !== method) {
				continue;
			}
			let result;
			try {
				result = route.match(url, typeof input === 'object' ? input : new Request(urlStr, init));
			} catch (e) {
				console.error('[mock-sf] matcher threw on ' + method + ' ' + url.pathname + ':', e);
				continue;
			}
			if (result) {
				return Promise.resolve(result);
			}
		}

		return Promise.resolve(notImplemented(method, url.pathname));
	};
})();

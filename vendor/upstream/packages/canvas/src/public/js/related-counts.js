(function () {
	'use strict';
	// Batches and caches related-record counts used by relationship chips and type nodes.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.relatedCounts = {
		mount: function mount(deps) {
			if (!deps || !deps.canvasState || !deps.csrfFetch || !deps.fetchGraphData) {
				throw new Error('related-counts.mount: missing required deps');
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const fetchGraphData = deps.fetchGraphData;

			const AUDIT_FK_FIELDS = new Set(['CreatedById', 'LastModifiedById', 'OwnerId']);
			const _RELATED_SOFT_THRESHOLD = 50;
			const _RELATED_HARD_THRESHOLD = 5000;
			const _RELATED_BULK_LOAD_CAP = 200; // matches /by-ref server cap
			const _relatedCountCache = new Map(); // key: objName|field|recordId -> count
			const _byRefCache = new Map(); // key: objName|field|hostId -> records[]
			const _relatedCountInFlight = new Map();
			const _byRefInFlight = new Map();
			const PREFETCH_COUNT_CAP = 25;

			function _countCacheKey(objectName, field, id) {
				return objectName + '|' + field + '|' + id;
			}

			function fetchRelatedCount(objectName, field, id) {
				const key = _countCacheKey(objectName, field, id);
				if (_relatedCountCache.has(key)) {
					return Promise.resolve(_relatedCountCache.get(key));
				}
				if (_relatedCountInFlight.has(key)) {
					return _relatedCountInFlight.get(key);
				}
				const url =
					'/api/objects/' +
					encodeURIComponent(objectName) +
					'/related-count?field=' +
					encodeURIComponent(field) +
					'&id=' +
					encodeURIComponent(id);
				const p = csrfFetch(url, { credentials: 'same-origin' })
					.then(async (r) => {
						if (!r.ok) {
							_relatedCountCache.set(key, 0);
							return 0;
						}
						const body = await r.json();
						const c = body && typeof body.count === 'number' ? body.count : 0;
						_relatedCountCache.set(key, c);
						return c;
					})
					.catch(() => {
						_relatedCountCache.set(key, 0);
						return 0;
					})
					.finally(() => {
						_relatedCountInFlight.delete(key);
					});
				_relatedCountInFlight.set(key, p);
				return p;
			}

			async function fetchRelatedCountsBatch(probes) {
				const result = new Map();
				if (!probes || probes.length === 0) {
					return result;
				}
				const toFetch = [];
				const inflightWaits = [];
				for (const p of probes) {
					if (!p || !p.objectName || !p.field || !p.id) {
						continue;
					}
					const key = _countCacheKey(p.objectName, p.field, p.id);
					if (_relatedCountCache.has(key)) {
						result.set(key, _relatedCountCache.get(key));
						continue;
					}
					const inflight = _relatedCountInFlight.get(key);
					if (inflight) {
						inflightWaits.push({ key, promise: inflight });
						continue;
					}
					toFetch.push({ key, p });
				}
				if (toFetch.length > 0) {
					let resolveBatch;
					const batchPromise = new Promise((r) => {
						resolveBatch = r;
					});
					toFetch.forEach((x) => {
						_relatedCountInFlight.set(
							x.key,
							batchPromise.then(() => _relatedCountCache.get(x.key) || 0),
						);
					});
					const CHUNK = 200;
					const chunks = [];
					for (let i = 0; i < toFetch.length; i += CHUNK) {
						chunks.push(toFetch.slice(i, i + CHUNK));
					}
					try {
						const responses = await Promise.all(
							chunks.map(async (chunk) => {
								const resp = await csrfFetch('/api/related-counts', {
									method: 'POST',
									headers: { 'Content-Type': 'application/json' },
									credentials: 'same-origin',
									body: JSON.stringify({
										probes: chunk.map((x) => ({
											name: x.p.objectName,
											field: x.p.field,
											id: x.p.id,
										})),
									}),
								});
								if (!resp.ok) {
									return { counts: [] };
								}
								return resp.json().catch(() => ({ counts: [] }));
							}),
						);
						const allCounts = responses.flatMap((b) => (b && b.counts) || []);
						allCounts.forEach((c) => {
							const key = _countCacheKey(c.name, c.field, c.id);
							_relatedCountCache.set(key, c.count || 0);
							result.set(key, c.count || 0);
						});
						toFetch.forEach((x) => {
							if (!result.has(x.key)) {
								_relatedCountCache.set(x.key, 0);
								result.set(x.key, 0);
							}
						});
					} catch (e) {
						toFetch.forEach((x) => {
							_relatedCountCache.set(x.key, 0);
							result.set(x.key, 0);
						});
					} finally {
						toFetch.forEach((x) => _relatedCountInFlight.delete(x.key));
						resolveBatch();
					}
				}
				for (const w of inflightWaits) {
					const v = await w.promise.catch(() => 0);
					result.set(w.key, v);
				}
				return result;
			}

			function fetchByRefCached(objectName, field, hostId, options) {
				const key = _countCacheKey(objectName, field, hostId);
				const forceRefresh = !!(options && options.forceRefresh);
				// Explicit loads must match the amount offered by the confirmation dialog.
				// Background prefetch keeps the server's smaller default batch size.
				const limit = forceRefresh ? _RELATED_BULK_LOAD_CAP : 50;
				if (!forceRefresh && _byRefCache.has(key)) {
					return Promise.resolve(_byRefCache.get(key));
				}
				if (_byRefInFlight.has(key)) {
					const inFlight = _byRefInFlight.get(key);
					return forceRefresh
						? inFlight.catch(() => null).then(() => fetchByRefCached(objectName, field, hostId, options))
						: inFlight;
				}
				const url =
					'/api/objects/' +
					encodeURIComponent(objectName) +
					'/by-ref?field=' +
					encodeURIComponent(field) +
					'&id=' +
					encodeURIComponent(hostId) +
					'&limit=' +
					limit;
				const p = csrfFetch(url, { credentials: 'same-origin' })
					.then(async (r) => {
						if (!r.ok) {
							throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
						}
						const body = await r.json();
						const records = body.records || [];
						_byRefCache.set(key, records);
						return records;
					})
					.finally(() => {
						_byRefInFlight.delete(key);
					});
				_byRefInFlight.set(key, p);
				return p;
			}

			async function prefetchTypeNodeOneLevel(tn) {
				if (!tn || !tn.isTypeNode) {
					return;
				}
				const host = canvasState.bulkRecords.find((r) => r.id === tn.hostRecordId);
				if (!host || !host.loadedFromId) {
					return;
				}
				const dedupKey = tn.id + '|' + host.id;
				if (canvasState._prefetchedTypeNodeKeys.has(dedupKey)) {
					return;
				}
				canvasState._prefetchedTypeNodeKeys.add(dedupKey);
				try {
					let records;
					if (tn.direction === 'child') {
						const cacheKey = _countCacheKey(tn.objectName, tn.fieldOnOther, host.loadedFromId);
						const knownCount = _relatedCountCache.get(cacheKey);
						if (typeof knownCount === 'number' && knownCount > PREFETCH_COUNT_CAP) {
							return;
						}
						records = await fetchByRefCached(tn.objectName, tn.fieldOnOther, host.loadedFromId);
					} else {
						const cacheKey = _countCacheKey(tn.objectName, 'Id', tn.parentId);
						if (_byRefCache.has(cacheKey)) {
							records = _byRefCache.get(cacheKey);
						} else {
							const r = await csrfFetch(
								'/api/objects/' +
									encodeURIComponent(tn.objectName) +
									'/records/' +
									encodeURIComponent(tn.parentId),
								{ credentials: 'same-origin' },
							);
							if (!r.ok) {
								return;
							}
							const single = await r.json();
							records = single ? [single] : [];
							_byRefCache.set(cacheKey, records);
						}
					}
					if (!records || records.length === 0) {
						return;
					}
					let targetSel = canvasState.selectedObjects.find((s) => s.name === tn.objectName);
					if (!targetSel) {
						try {
							targetSel = await fetchGraphData(tn.objectName).then((data) => ({
								name: data.name,
								label: data.label || data.name,
								data,
							}));
						} catch (e) {
							return;
						}
					}
					const childFields = ((targetSel.data && targetSel.data.children) || []).filter((c) => {
						if (!c.field || !c.object) {
							return false;
						}
						if (AUDIT_FK_FIELDS.has(c.field)) {
							return false;
						}
						return true;
					});
					const validRecs = records.filter((r) => r && r.Id);
					const probes = [];
					for (let ci = 0; ci < childFields.length; ci++) {
						const c = childFields[ci];
						for (let ri = 0; ri < validRecs.length; ri++) {
							probes.push({ objectName: c.object, field: c.field, id: validRecs[ri].Id });
						}
					}
					const L2_CAP = 200;
					const probeSlice = probes.slice(0, L2_CAP);
					const counts = await fetchRelatedCountsBatch(probeSlice);
					const probeResults = probeSlice.map((p) => ({
						...p,
						count: counts.get(_countCacheKey(p.objectName, p.field, p.id)) || 0,
					}));
					const L3_CAP = 30;
					const l3Targets = probeResults
						.filter((p) => p.count > 0 && p.count <= PREFETCH_COUNT_CAP)
						.slice(0, L3_CAP);
					await Promise.all(
						l3Targets.map((p) => fetchByRefCached(p.objectName, p.field, p.id).catch(() => null)),
					);
				} catch (e) {
					console.warn('prefetchTypeNodeOneLevel:', e);
				}
			}

			return {
				_RELATED_SOFT_THRESHOLD: _RELATED_SOFT_THRESHOLD,
				_RELATED_HARD_THRESHOLD: _RELATED_HARD_THRESHOLD,
				_RELATED_BULK_LOAD_CAP: _RELATED_BULK_LOAD_CAP,
				PREFETCH_COUNT_CAP: PREFETCH_COUNT_CAP,
				AUDIT_FK_FIELDS: AUDIT_FK_FIELDS,
				_relatedCountCache: _relatedCountCache,
				_byRefCache: _byRefCache,
				_countCacheKey: _countCacheKey,
				fetchRelatedCount: fetchRelatedCount,
				fetchRelatedCountsBatch: fetchRelatedCountsBatch,
				fetchByRefCached: fetchByRefCached,
				prefetchTypeNodeOneLevel: prefetchTypeNodeOneLevel,
			};
		},
	};
})();

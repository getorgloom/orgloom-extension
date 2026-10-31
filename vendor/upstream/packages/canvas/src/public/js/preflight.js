(function () {
	'use strict';
	// Renders server-side upload validation without changing the canvas or Salesforce.

	window.OrgLoom = window.OrgLoom || {};

	function fallbackValuesEquivalent(a, b) {
		if (a === b) {
			return true;
		}
		const left = a == null ? '' : String(a).trim();
		const right = b == null ? '' : String(b).trim();
		if (left === right) {
			return true;
		}
		if (left === '' || right === '') {
			return false;
		}
		const leftNumber = Number(left);
		const rightNumber = Number(right);
		return !isNaN(leftNumber) && !isNaN(rightNumber) && leftNumber === rightNumber;
	}

	function picklistMetadataForRecordType(field, recordTypeId, recordTypeAvailable) {
		if (recordTypeAvailable === false) {
			return { values: [], authoritative: false };
		}
		const byRecordType = field && field.picklistValuesByRecordType;
		if (recordTypeId && byRecordType && Object.prototype.hasOwnProperty.call(byRecordType, recordTypeId)) {
			return {
				values: Array.isArray(byRecordType[recordTypeId]) ? byRecordType[recordTypeId] : [],
				authoritative: true,
			};
		}
		if (recordTypeId && byRecordType && Object.keys(byRecordType).length > 0) {
			return { values: [], authoritative: false };
		}
		const values = field && Array.isArray(field.picklistValues) ? field.picklistValues : [];
		return { values, authoritative: values.length > 0 };
	}

	function dependentPicklistMetadata(field, recordTypeId, controllerValue, recordTypeAvailable) {
		const metadata = picklistMetadataForRecordType(field, recordTypeId, recordTypeAvailable);
		if (!metadata.authoritative || !field || !field.controllerName) {
			return metadata;
		}
		const mapsByRecordType = field.controllerValuesByRecordType;
		let controllerMap = null;
		if (recordTypeId && mapsByRecordType && Object.prototype.hasOwnProperty.call(mapsByRecordType, recordTypeId)) {
			controllerMap = mapsByRecordType[recordTypeId];
		} else if (recordTypeId && mapsByRecordType && Object.keys(mapsByRecordType).length > 0) {
			return { values: [], authoritative: false };
		} else {
			controllerMap = field.controllerValues;
		}
		if (!controllerMap || typeof controllerMap !== 'object') {
			return { values: [], authoritative: false };
		}
		const key = controllerValue == null ? '' : String(controllerValue);
		if (!key || !Object.prototype.hasOwnProperty.call(controllerMap, key)) {
			return { values: [], authoritative: true };
		}
		const controllerIndex = controllerMap[key];
		return {
			values: metadata.values.filter(
				(value) => Array.isArray(value && value.validFor) && value.validFor.includes(controllerIndex),
			),
			authoritative: true,
		};
	}

	function recordTypeIdForRecord(record, describe) {
		const values = (record && record.values) || {};
		const loadedValues = (record && record.loadedValues) || {};
		return (
			values.RecordTypeId ||
			(record && record._recordTypeId) ||
			loadedValues.RecordTypeId ||
			(describe && describe.defaultRecordTypeId) ||
			null
		);
	}

	function shouldValidateField(record, fieldName, forceValidation, valuesEquivalent) {
		if (!record || !record.loadedFromId) {
			return true;
		}
		if (forceValidation) {
			return true;
		}
		const current = record.values && record.values[fieldName];
		const loaded = record.loadedValues && record.loadedValues[fieldName];
		return !valuesEquivalent(current, loaded);
	}

	function isExternalKeyReferenceField(field) {
		return !!(
			field &&
			field.type === 'reference' &&
			(field.referenceTargetField ||
				(Array.isArray(field.referenceTo) &&
					field.referenceTo.some((target) => typeof target === 'string' && /__x$/i.test(target))))
		);
	}

	window.OrgLoom.preflight = {
		_test: {
			dependentPicklistMetadata,
			fallbackValuesEquivalent,
			picklistMetadataForRecordType,
			recordTypeIdForRecord,
			shouldValidateField,
			isExternalKeyReferenceField,
		},
		mount: function mount(deps) {
			if (!deps || !deps.canvasState || !deps.isRecordModified || !deps.recordOrdinal) {
				throw new Error('preflight.mount: missing required deps');
			}
			const canvasState = deps.canvasState;
			const isRecordModified = deps.isRecordModified;
			const recordOrdinal = deps.recordOrdinal;
			const valuesEquivalent =
				deps.valuesEquivalent ||
				(window.OrgLoom.valueCompare && window.OrgLoom.valueCompare.valuesEquivalent) ||
				fallbackValuesEquivalent;

			function validateBulkRecords() {
				// Validate only records that would write; unchanged existing records are out of scope.
				const issues = [];
				const byRecordId = new Map();
				const missingDescribes = new Set();

				const assocByFrom = new Map();
				(canvasState.bulkAssociations || []).forEach((a) => {
					if (!a || a.fromId == null || !a.fieldName) {
						return;
					}
					let s = assocByFrom.get(a.fromId);
					if (!s) {
						s = new Set();
						assocByFrom.set(a.fromId, s);
					}
					s.add(a.fieldName);
				});

				(canvasState.bulkRecords || []).forEach((rec) => {
					if (!rec || !rec.objectName) {
						return;
					}
					if (rec.isTypeNode) {
						return;
					}
					if (rec.pendingDelete && rec.loadedFromId) {
						const describe = canvasState.describeCache[rec.objectName];
						if (!describe || !Array.isArray(describe.fields)) {
							missingDescribes.add(rec.objectName);
						} else if (describe.deletable !== true) {
							addIssue(
								rec,
								{ name: '(delete)', label: 'Delete' },
								'error',
								'Your Salesforce user does not have permission to delete this type of record.',
							);
						}
						return;
					}
					if (rec.loadedFromId && !isRecordModified(rec)) {
						return;
					}
					const describe = canvasState.describeCache[rec.objectName];
					if (!describe || !Array.isArray(describe.fields)) {
						missingDescribes.add(rec.objectName);
						return;
					}
					const recordLabel = (rec.label || rec.objectName) + ' #' + recordOrdinal(rec);
					const values = rec.values || {};
					const linkedFields = assocByFrom.get(rec.id) || new Set();
					const isUpdate = !!rec.loadedFromId;
					const recordTypeId = recordTypeIdForRecord(rec, describe);
					const recordTypeAvailable =
						!recordTypeId ||
						!Array.isArray(describe.recordTypes) ||
						describe.recordTypes.some((recordType) => recordType && recordType.id === recordTypeId);
					const loadedRecordTypeId = rec.loadedValues && rec.loadedValues.RecordTypeId;
					const recordTypeChanged =
						isUpdate && loadedRecordTypeId != null && !valuesEquivalent(recordTypeId, loadedRecordTypeId);

					describe.fields.forEach((f) => {
						if (!f || !f.name) {
							return;
						}
						if (isUpdate ? !f.updateable : !f.createable) {
							return;
						}

						const raw = values[f.name];
						const hasValue = raw !== undefined && raw !== null && !(typeof raw === 'string' && raw === '');
						const hasRelationship = f.type === 'reference' && linkedFields.has(f.name);
						const previous = rec.loadedValues && rec.loadedValues[f.name];
						const recordTypeAffectsField =
							recordTypeChanged &&
							(f.type === 'picklist' || f.type === 'multipicklist' || f.type === 'combobox');
						const controllerChanged =
							isUpdate &&
							!!f.controllerName &&
							!valuesEquivalent(
								values[f.controllerName],
								rec.loadedValues && rec.loadedValues[f.controllerName],
							);
						if (
							!shouldValidateField(
								rec,
								f.name,
								hasRelationship || recordTypeAffectsField || controllerChanged,
								valuesEquivalent,
							)
						) {
							return;
						}
						const previouslyHadValue =
							previous !== undefined &&
							previous !== null &&
							!(typeof previous === 'string' && previous === '');
						// Salesforce supplies Case business hours even though Describe reports
						// nillable=false and defaultedOnCreate=false. Only exempt missing values
						// on insert; explicit IDs and updates still use the normal validation.
						const caseBusinessHoursDefault = rec.objectName === 'Case' && f.name === 'BusinessHoursId';
						const requiredMissingOnCreate =
							!isUpdate &&
							!hasValue &&
							!hasRelationship &&
							!f.defaultedOnCreate &&
							!caseBusinessHoursDefault;
						const requiredClearedOnUpdate = isUpdate && previouslyHadValue && !hasValue && !hasRelationship;

						if (f.required && (requiredMissingOnCreate || requiredClearedOnUpdate)) {
							addIssue(rec, f, 'error', 'Required field is empty.');
							return; // no point checking further on an empty field
						}
						if (!hasValue) {
							return;
						}

						const picklistMetadata = dependentPicklistMetadata(
							f,
							recordTypeId,
							f.controllerName ? values[f.controllerName] : null,
							recordTypeAvailable,
						);
						const validatePicklist =
							f.type !== 'combobox' && f.restrictedPicklist !== false && picklistMetadata.authoritative;
						if ((f.type === 'picklist' || f.type === 'combobox') && validatePicklist) {
							const ok = picklistMetadata.values.some((p) => p && p.active !== false && p.value === raw);
							if (!ok) {
								addIssue(rec, f, 'error', 'Value "' + raw + '" is not an active picklist option.');
							}
						} else if (f.type === 'multipicklist' && validatePicklist) {
							const parts = String(raw)
								.split(';')
								.map((s) => s.trim())
								.filter(Boolean);
							const allowed = new Set(
								picklistMetadata.values.filter((p) => p && p.active !== false).map((p) => p.value),
							);
							parts.forEach((p) => {
								if (!allowed.has(p)) {
									addIssue(rec, f, 'error', 'Value "' + p + '" is not an active picklist option.');
								}
							});
						}

						if (typeof raw === 'string' && f.length && f.length > 0) {
							const stringTypes = new Set([
								'string',
								'textarea',
								'phone',
								'url',
								'email',
								'encryptedstring',
							]);
							if (stringTypes.has(f.type) && raw.length > f.length) {
								addIssue(
									rec,
									f,
									'error',
									'Value is ' + raw.length + ' chars, max is ' + f.length + '.',
								);
							}
						}

						const numericTypes = new Set(['int', 'double', 'currency', 'percent']);
						if (numericTypes.has(f.type)) {
							const n = Number(raw);
							if (!isFinite(n)) {
								addIssue(rec, f, 'error', 'Value isn\u2019t a valid number.');
							} else if (f.type === 'int' && !Number.isInteger(n)) {
								addIssue(rec, f, 'error', 'Value must be an integer.');
							} else if (Number.isInteger(f.precision) && f.precision > 0 && Number.isInteger(f.scale) && f.scale >= 0 && f.scale <= f.precision) {
								const integerDigits = f.precision - f.scale;
								if (Math.abs(n) >= Math.pow(10, integerDigits)) {
									addIssue(rec, f, 'error', 'Value exceeds the destination limit of ' + integerDigits + ' digits before the decimal point.');
								}
							}
						}

						if (f.type === 'date' && typeof raw === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
							addIssue(rec, f, 'error', 'Date must be YYYY-MM-DD.');
						}
						if (f.type === 'datetime' && typeof raw === 'string') {
							const looksOk = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) || !isNaN(Date.parse(raw));
							if (!looksOk) {
								addIssue(rec, f, 'error', 'Datetime is unparseable.');
							}
						}

						if (f.type === 'email' && typeof raw === 'string' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
							addIssue(rec, f, 'error', 'Doesn\u2019t look like a valid email address.');
						}
						if (
							f.type === 'url' &&
							typeof raw === 'string' &&
							raw.length > 0 &&
							!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
						) {
							addIssue(rec, f, 'warning', 'URL is missing a scheme (e.g. https://).');
						}

						if (
							f.type === 'reference' &&
							!isExternalKeyReferenceField(f) &&
							typeof raw === 'string' &&
							raw.length > 0 &&
							!/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(raw)
						) {
							addIssue(
								rec,
								f,
								'error',
								'Lookup value isn\u2019t a Salesforce ID and no relationship to another canvas record is set.',
							);
						}
					});
				});

				function addIssue(rec, field, severity, message) {
					const issue = {
						recordId: rec.id,
						objectName: rec.objectName,
						recordLabel: (rec.label || rec.objectName) + ' #' + recordOrdinal(rec),
						field: field.name,
						fieldLabel: field.label || field.name,
						severity,
						message,
					};
					issues.push(issue);
					let bucket = byRecordId.get(rec.id);
					if (!bucket) {
						bucket = [];
						byRecordId.set(rec.id, bucket);
					}
					bucket.push(issue);
				}

				const recordById = new Map();
				canvasState.bulkRecords.forEach((r) => {
					if (r && r.id != null) {
						recordById.set(r.id, r);
					}
				});
				const childrenOf = new Map(); // parentId -> [{ child, fieldName }]
				(canvasState.bulkAssociations || []).forEach((a) => {
					if (!a || a.fromId == null || a.toId == null) {
						return;
					}
					const child = recordById.get(a.fromId);
					if (!child || child.isTypeNode) {
						return;
					}
					if (!childrenOf.has(a.toId)) {
						childrenOf.set(a.toId, []);
					}
					childrenOf.get(a.toId).push({ child, fieldName: a.fieldName });
				});
				function pushCascadeIssue(parentRec, severity, fieldLabel, message) {
					const issue = {
						recordId: parentRec.id,
						objectName: parentRec.objectName,
						recordLabel: (parentRec.label || parentRec.objectName) + ' #' + recordOrdinal(parentRec),
						field: '(cascade)',
						fieldLabel,
						severity,
						message,
					};
					issues.push(issue);
					let bucket = byRecordId.get(parentRec.id);
					if (!bucket) {
						bucket = [];
						byRecordId.set(parentRec.id, bucket);
					}
					bucket.push(issue);
				}
				canvasState.bulkRecords.forEach((rec) => {
					if (!rec || rec.isTypeNode) {
						return;
					}
					if (!rec.loadedFromId || !rec.pendingDelete) {
						return;
					}
					const kids = childrenOf.get(rec.id) || [];
					if (kids.length === 0) {
						return;
					}
					const orphanedLoaded = kids.filter((k) => k.child.loadedFromId && !k.child.pendingDelete);
					const draftChildren = kids.filter((k) => !k.child.loadedFromId);
					if (orphanedLoaded.length > 0) {
						pushCascadeIssue(
							rec,
							'warning',
							'Cascade',
							'Deleting this record may cascade-delete ' +
								orphanedLoaded.length +
								' loaded child record' +
								(orphanedLoaded.length === 1 ? '' : 's') +
								' in Salesforce, or be refused if the relationship is a lookup. Mark them for delete too if cascade is the intent, or unmark this delete.',
						);
					}
					if (draftChildren.length > 0) {
						pushCascadeIssue(
							rec,
							'error',
							'Draft relationship',
							draftChildren.length +
								' draft record' +
								(draftChildren.length === 1 ? '' : 's') +
								' on this canvas are related to this record. Deleting it would leave those relationships unresolved during upload. Remove the drafts or unmark this delete.',
						);
					}
				});

				return { issues, byRecordId, missingDescribes };
			}

			function computeUploadOrder(unchangedSet, inScopeSet, deleteSet) {
				// Draft parents precede children; deletes later reverse this dependency on the server.
				const skip = unchangedSet || new Set();
				const deletes = deleteSet || new Set();
				const recordsById = new Map();
				canvasState.bulkRecords.forEach((r) => {
					if (!r || r.id == null) {
						return;
					}
					if (r.isTypeNode) {
						return;
					}
					if (inScopeSet && !inScopeSet.has(r.id)) {
						return;
					}
					recordsById.set(r.id, r);
				});
				const deps = new Map();
				const draftLinks = new Map();
				recordsById.forEach((_, id) => deps.set(id, new Set()));
				canvasState.bulkAssociations.forEach((a) => {
					if (!a || !deps.has(a.fromId)) {
						return;
					}
					const parent = recordsById.get(a.toId);
					if (!parent) {
						return;
					}
					if (parent.loadedFromId) {
						return;
					} // resolved up-front, no level cost
					deps.get(a.fromId).add(a.toId);
					if (!draftLinks.has(a.fromId)) {
						draftLinks.set(a.fromId, []);
					}
					draftLinks.get(a.fromId).push(a);
				});
				if (window.OrgLoom.platform?.upload?.deferredReferences === true) {
					// Match uploaders that can insert a nullable reference empty and
					// complete it inside the same transaction once its target exists.
					const pending = new Set(
						Array.from(recordsById.keys()).filter((id) => !skip.has(id) && !deletes.has(id)),
					);
					while (pending.size) {
						let ready = Array.from(pending).filter((id) =>
							Array.from(deps.get(id)).every((parent) => !pending.has(parent)),
						);
						if (!ready.length) {
							ready = Array.from(pending).filter((id) => {
								const record = recordsById.get(id);
								return (draftLinks.get(id) || [])
									.filter((link) => pending.has(link.toId))
									.every((link) => {
										const field = canvasState.describeCache[record.objectName]?.fields?.find(
											(candidate) => candidate.name === link.fieldName,
										);
										return (
											field?.type === 'reference' &&
											field.nillable === true &&
											field.updateable === true &&
											field.referenceTo?.includes(recordsById.get(link.toId).objectName)
										);
									});
							});
							for (const id of ready) {
								for (const parent of deps.get(id)) {
									if (pending.has(parent)) {
										deps.get(id).delete(parent);
									}
								}
							}
						}
						if (!ready.length) {
							break;
						}
						ready.forEach((id) => pending.delete(id));
					}
				}
				const levelById = new Map();
				const cycleIds = new Set();
				function lvl(id, stack, stackArr) {
					if (levelById.has(id)) {
						return levelById.get(id);
					}
					if (stack.has(id)) {
						// Record cycle members so preflight can block relationships Salesforce cannot resolve.
						const start = stackArr.indexOf(id);
						for (let i = Math.max(0, start); i < stackArr.length; i++) {
							cycleIds.add(stackArr[i]);
						}
						return 0;
					} // cycle short-circuit
					stack.add(id);
					stackArr.push(id);
					let m = 0;
					for (const p of deps.get(id) || []) {
						const v = lvl(p, stack, stackArr) + 1;
						if (v > m) {
							m = v;
						}
					}
					stack.delete(id);
					stackArr.pop();
					levelById.set(id, m);
					return m;
				}
				recordsById.forEach((_, id) => lvl(id, new Set(), []));
				const buckets = new Map();
				const deleteBuckets = new Map();
				recordsById.forEach((rec, id) => {
					const level = levelById.get(id) || 0;
					const sel = canvasState.selectedObjects.find((s) => s.name === rec.objectName);
					const label = (sel && sel.label) || rec.label || rec.objectName;
					if (deletes.has(id)) {
						const dkey = level + '|' + rec.objectName;
						let d = deleteBuckets.get(dkey);
						if (!d) {
							d = { level, objectName: rec.objectName, label, count: 0 };
							deleteBuckets.set(dkey, d);
						}
						d.count++;
						return;
					}
					const key = level + '|' + rec.objectName;
					let b = buckets.get(key);
					if (!b) {
						b = {
							level,
							objectName: rec.objectName,
							label,
							upload: 0,
							unchanged: 0,
						};
						buckets.set(key, b);
					}
					if (skip.has(id)) {
						b.unchanged++;
					} else {
						b.upload++;
					}
				});
				const creates = Array.from(buckets.values()).sort((a, b) => {
					if (a.level !== b.level) {
						return a.level - b.level;
					}
					return a.label.localeCompare(b.label);
				});
				const deletesLane = Array.from(deleteBuckets.values()).sort((a, b) => {
					if (a.level !== b.level) {
						return b.level - a.level;
					}
					return a.label.localeCompare(b.label);
				});
				return { creates, deletes: deletesLane, cycleIds };
			}

			return {
				validateBulkRecords: validateBulkRecords,
				computeUploadOrder: computeUploadOrder,
			};
		},
	};
})();

(function () {
	'use strict';
	// Compares source canvas values with destination describe metadata to identify migration gaps.

	var SYSTEM_KEYS = {
		attributes: 1,
		id: 1,
		createddate: 1,
		createdbyid: 1,
		lastmodifieddate: 1,
		lastmodifiedbyid: 1,
		systemmodstamp: 1,
		isdeleted: 1,
		ownerid: 1,
		recordtypeid: 1,
		masterrecordid: 1,
		lastreferenceddate: 1,
		lastvieweddate: 1,
	};

	function _isEmpty(v) {
		return v === null || v === undefined || v === '';
	}

	function _isIgnoredKey(key) {
		if (!key) {
			return true;
		}
		var lk = String(key).toLowerCase();
		return lk.charAt(0) === '_' || SYSTEM_KEYS[lk] === 1;
	}

	function _lookupValue(values, fieldName) {
		if (!values || !fieldName) {
			return undefined;
		}
		if (Object.prototype.hasOwnProperty.call(values, fieldName)) {
			return values[fieldName];
		}
		var lk = String(fieldName).toLowerCase();
		var keys = Object.keys(values);
		for (var i = 0; i < keys.length; i++) {
			if (keys[i].toLowerCase() === lk) {
				return values[keys[i]];
			}
		}
		return undefined;
	}

	function resolveTargetRecordTypeId(developerName, targetDescribe) {
		if (!developerName || !targetDescribe) {
			return null;
		}
		var rts = targetDescribe.recordTypes || [];
		var want = String(developerName).toLowerCase();
		for (var i = 0; i < rts.length; i++) {
			var rt = rts[i];
			if (!rt) {
				continue;
			}
			if (String(rt.developerName || '').toLowerCase() === want) {
				return rt.id || null;
			}
		}
		return null;
	}

	function picklistValuesForRecordType(field, recordTypeId) {
		var byRecordType = field && field.picklistValuesByRecordType;
		if (recordTypeId && byRecordType && Object.prototype.hasOwnProperty.call(byRecordType, recordTypeId)) {
			return Array.isArray(byRecordType[recordTypeId]) ? byRecordType[recordTypeId] : [];
		}
		if (recordTypeId && byRecordType && Object.keys(byRecordType).length > 0) {
			return [];
		}
		return field && Array.isArray(field.picklistValues) ? field.picklistValues : [];
	}

	function hasAuthoritativePicklistValues(field, recordTypeId) {
		var byRecordType = field && field.picklistValuesByRecordType;
		if (recordTypeId && byRecordType && Object.prototype.hasOwnProperty.call(byRecordType, recordTypeId)) {
			return true;
		}
		if (recordTypeId && byRecordType && Object.keys(byRecordType).length > 0) {
			return false;
		}
		return !!(field && Array.isArray(field.picklistValues) && field.picklistValues.length);
	}

	function supportsCustomPicklistValue(field) {
		return !!(
			field &&
			(field.type === 'combobox' ||
				((field.type === 'picklist' || field.type === 'multipicklist') && field.restrictedPicklist === false))
		);
	}

	function _picklistRemapFor(record, fieldName) {
		var remap = record && record._migratePicklistRemap;
		if (!remap || !fieldName) {
			return null;
		}
		if (Object.prototype.hasOwnProperty.call(remap, fieldName)) {
			return remap[fieldName];
		}
		var lk = String(fieldName).toLowerCase();
		var keys = Object.keys(remap);
		for (var i = 0; i < keys.length; i++) {
			if (keys[i].toLowerCase() === lk) {
				return remap[keys[i]];
			}
		}
		return null;
	}

	function isMigrationDelete(record) {
		return !!(
			record &&
			record.pendingDelete &&
			record._migrateMatchResolution !== 'new' &&
			record._migrateMatchIntent !== 'new'
		);
	}

	function computeMigrationStatus(record, targetDescribe) {
		// Deletions use only the selected destination identity, not source field values.
		if (isMigrationDelete(record) && targetDescribe) {
			return { status: 'ready', issues: [], resolvedRecordTypeId: null };
		}
		// Treat missing fields as ambiguous: they may not exist or may be hidden by destination FLS.
		var issues = [];
		var resolvedRecordTypeId = null;
		var values = (record && record.values) || {};
		var fields = (targetDescribe && targetDescribe.fields) || [];

		var fieldByName = {};
		for (var i = 0; i < fields.length; i++) {
			var f = fields[i];
			if (f && f.name) {
				fieldByName[String(f.name).toLowerCase()] = f;
			}
		}

		var valueKeys = Object.keys(values);
		for (var k = 0; k < valueKeys.length; k++) {
			var key = valueKeys[k];
			if (_isIgnoredKey(key)) {
				continue;
			}
			if (_isEmpty(values[key])) {
				continue; // nothing to migrate for this field
			}
			if (!fieldByName[String(key).toLowerCase()]) {
				issues.push({
					kind: 'missing-field',
					severity: 'warning',
					field: key,
					message:
						'“' +
						key +
						'” is unavailable through the destination connection and will be skipped. It may not exist in the destination org, or Salesforce permissions may hide it.',
				});
			}
		}

		var _isUpdate = !!(record && record.loadedFromId);
		for (var r = 0; !_isUpdate && r < fields.length; r++) {
			var tf = fields[r];
			if (!tf || tf.required !== true || tf.createable === false) {
				continue; // not required-on-create
			}
			if (_isIgnoredKey(tf.name)) {
				continue;
			}
			if (tf.type === 'reference') {
				continue; // lookups/master-detail handled elsewhere
			}
			if (_isEmpty(_lookupValue(values, tf.name))) {
				issues.push({
					kind: 'required-unfilled',
					severity: 'blocked',
					field: tf.name,
					message: '“' + (tf.label || tf.name) + '” is required in the destination org and isn’t set.',
				});
			}
		}

		var sourceRecordTypeDeveloperName =
			record &&
			(record._sourceRecordTypeDeveloperName || (record.values && record.values._sourceRecordTypeDeveloperName));
		var picklistRecordTypeId =
			(record && record._migrateRecordTypeId) ||
			resolveTargetRecordTypeId(sourceRecordTypeDeveloperName, targetDescribe) ||
			(targetDescribe && targetDescribe.defaultRecordTypeId) ||
			null;
		var picklistRecordTypeAvailable =
			!picklistRecordTypeId ||
			!targetDescribe ||
			!Array.isArray(targetDescribe.recordTypes) ||
			targetDescribe.recordTypes.some(function (recordType) {
				return recordType && recordType.id === picklistRecordTypeId;
			});
		for (var p = 0; p < valueKeys.length; p++) {
			var pkey = valueKeys[p];
			if (_isIgnoredKey(pkey)) {
				continue;
			}
			var pf = fieldByName[String(pkey).toLowerCase()];
			if (!pf) {
				continue; // missing-field already handled above
			}
			var pv = values[pkey];
			if (_isEmpty(pv)) {
				continue;
			}
			if (pf.type === 'boolean' && typeof pv !== 'boolean' && !/^(true|false)$/i.test(String(pv).trim())) {
				issues.push({
					kind: 'boolean-mismatch',
					severity: 'blocked',
					field: pf.name,
					sourceValue: pv,
					message: (pf.label || pf.name) + ' is a checkbox in the destination. Choose True or False.',
				});
			}
			if (
				(pf.type === 'picklist' || pf.type === 'multipicklist') &&
				!supportsCustomPicklistValue(pf) &&
				picklistRecordTypeAvailable &&
				hasAuthoritativePicklistValues(pf, picklistRecordTypeId)
			) {
				// Map unavailable values here; leave conflicts with controlling fields to upload validation.
				var picklistValues = picklistValuesForRecordType(pf, picklistRecordTypeId);
				var active = {};
				for (var a = 0; a < picklistValues.length; a++) {
					var opt = picklistValues[a];
					if (opt && opt.active !== false) {
						active[String(opt.value)] = 1;
					}
				}
				var parts = pf.type === 'multipicklist' ? String(pv).split(';') : [String(pv)];
				var fieldRemap = _picklistRemapFor(record, pkey);
				var bad = [];
				for (var b = 0; b < parts.length; b++) {
					var part = parts[b];
					if (part === '' || active[part] === 1) {
						continue; // empty or already valid
					}
					if (fieldRemap && Object.prototype.hasOwnProperty.call(fieldRemap, part)) {
						continue;
					}
					bad.push(part);
				}
				if (bad.length) {
					issues.push({
						kind: 'picklist-mismatch',
						severity: 'warning',
						field: pkey,
						invalidValues: bad,
						message:
							'“' + pkey + '”: ' + bad.join(', ') + ' not a valid picklist value in the destination org.',
					});
				}
			}
		}

		var srcRtDevName =
			record &&
			(record._sourceRecordTypeDeveloperName || (record.values && record.values._sourceRecordTypeDeveloperName));
		if (record && record._migrateClearRecordType) {
			resolvedRecordTypeId = null; // user chose to drop it
		} else if (record && record._migrateRecordTypeId) {
			resolvedRecordTypeId = record._migrateRecordTypeId; // user override
		} else if (srcRtDevName) {
			resolvedRecordTypeId = resolveTargetRecordTypeId(srcRtDevName, targetDescribe);
			if (!resolvedRecordTypeId) {
				issues.push({
					kind: 'recordtype-unresolved',
					severity: 'blocked',
					field: 'RecordTypeId',
					developerName: srcRtDevName,
					message:
						'Record type “' +
						srcRtDevName +
						'” doesn’t exist in the destination org. Pick a record type or clear it.',
				});
			}
		}

		var hasBlocked = false;
		var hasWarning = false;
		for (var z = 0; z < issues.length; z++) {
			if (issues[z].severity === 'blocked') {
				hasBlocked = true;
			} else if (issues[z].severity === 'warning') {
				hasWarning = true;
			}
		}
		var status = hasBlocked ? 'blocked' : hasWarning ? 'warning' : 'ready';

		return {
			status: status,
			issues: issues,
			resolvedRecordTypeId: resolvedRecordTypeId,
		};
	}

	function annotateRecords(records, describeByObject) {
		records = records || [];
		describeByObject = describeByObject || {};
		var out = [];
		for (var i = 0; i < records.length; i++) {
			var rec = records[i];
			if (!rec || rec.isTypeNode) {
				out.push(null);
				continue;
			}
			if (rec._migrateExcluded) {
				out.push({ status: 'excluded', issues: [], resolvedRecordTypeId: null });
				continue;
			}
			var describe = describeByObject[rec.objectName];
			if (!describe) {
				out.push({ status: 'pending', issues: [], resolvedRecordTypeId: null });
				continue;
			}
			out.push(computeMigrationStatus(rec, describe));
		}
		return out;
	}

	function summarize(annotations) {
		var counts = { ready: 0, warning: 0, blocked: 0, pending: 0, excluded: 0, total: 0 };
		annotations = annotations || [];
		for (var i = 0; i < annotations.length; i++) {
			var a = annotations[i];
			if (!a) {
				continue;
			}
			counts.total++;
			if (counts[a.status] !== undefined) {
				counts[a.status]++;
			}
		}
		return counts;
	}

	function badgeSummary(annotation) {
		if (!annotation || !annotation.status || annotation.status === 'ready') {
			return null;
		}
		if (annotation.status === 'pending') {
			return {
				status: 'pending',
				label: 'checking...',
				title: 'Checking this record against the destination org.',
			};
		}
		if (annotation.status === 'excluded') {
			return { status: 'warning', label: 'excluded', title: 'Excluded from this migration.' };
		}

		var issues = Array.isArray(annotation.issues) ? annotation.issues : [];
		var issueCount = issues.length;
		if (annotation.status === 'blocked') {
			return {
				status: 'blocked',
				label: 'fix required',
				title:
					'This record cannot be migrated yet. Open it to resolve ' +
					(issueCount === 1 ? '1 migration issue.' : issueCount + ' migration issues.'),
			};
		}

		var missing = issues.filter(function (issue) {
			return issue && issue.kind === 'missing-field';
		});
		if (missing.length === issueCount && issueCount > 0) {
			return {
				status: 'warning',
				label: issueCount === 1 ? '1 field unavailable' : issueCount + ' fields unavailable',
				title:
					'The current Salesforce connection cannot provide ' +
					(issueCount === 1 ? 'this field' : 'these fields') +
					(issueCount === 1
						? '. The field may not exist in the destination org, or Salesforce permissions may hide it. Open the record to map the value or leave it out of the migration.'
						: '. The fields may not exist in the destination org, or Salesforce permissions may hide them. Open the record to map the values or leave them out of the migration.'),
			};
		}

		var picklists = issues.filter(function (issue) {
			return issue && issue.kind === 'picklist-mismatch';
		});
		if (picklists.length === issueCount && issueCount > 0) {
			var valueCount = 0;
			for (var i = 0; i < picklists.length; i++) {
				var values = picklists[i].invalidValues;
				valueCount += Array.isArray(values) && values.length ? values.length : 1;
			}
			return {
				status: 'warning',
				label: valueCount === 1 ? '1 value needs mapping' : valueCount + ' values need mapping',
				title:
					'Open this record to map or leave out ' +
					(valueCount === 1
						? '1 destination-incompatible picklist value.'
						: valueCount + ' destination-incompatible picklist values.'),
			};
		}

		return {
			status: 'warning',
			label: issueCount === 1 ? '1 migration issue' : issueCount + ' migration issues',
			title:
				'Open this record to review ' +
				(issueCount === 1 ? '1 migration issue.' : issueCount + ' migration issues.'),
		};
	}

	function prepareMigrationValues(record, annotation) {
		// Apply reviewed omissions and remaps to an upload copy, leaving source canvas values intact.
		var out = Object.assign({}, (record && record.values) || {});
		// Updating a destination match is merge-like: a blank source field means there is
		// no value to migrate, not an instruction to erase the destination value.
		if (record && record._migrateMatchedId) {
			Object.keys(out).forEach(function (key) {
				var value = out[key];
				if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
					delete out[key];
				}
			});
		}
		var issues = (annotation && annotation.issues) || [];
		for (var i = 0; i < issues.length; i++) {
			var issue = issues[i];
			if (!issue || !issue.field) {
				continue;
			}
			var key = Object.keys(out).find(function (k) {
				return k.toLowerCase() === String(issue.field).toLowerCase();
			});
			if (!key) {
				continue;
			}
			if (issue.kind === 'missing-field') {
				delete out[key];
			} else if (issue.kind === 'picklist-mismatch') {
				var invalid = {};
				(issue.invalidValues || []).forEach(function (v) {
					invalid[String(v)] = true;
				});
				var parts = String(out[key])
					.split(';')
					.filter(function (v) {
						return !invalid[v];
					});
				if (parts.length) {
					out[key] = parts.join(';');
				} else {
					delete out[key];
				}
			}
		}
		if (annotation && annotation.resolvedRecordTypeId) {
			out.RecordTypeId = annotation.resolvedRecordTypeId;
		}
		var remap = record && record._migratePicklistRemap;
		if (remap) {
			Object.keys(remap).forEach(function (field) {
				var key = Object.keys(out).find(function (k) {
					return k.toLowerCase() === field.toLowerCase();
				});
				if (!key) {
					return;
				}
				var map = remap[field] || {};
				var parts = String(out[key])
					.split(';')
					.map(function (part) {
						return Object.prototype.hasOwnProperty.call(map, part) ? map[part] : part;
					})
					.filter(function (part, index, values) {
						// Several source choices can map to the same destination choice.
						return part !== '' && values.indexOf(part) === index;
					});
				if (parts.length) {
					out[key] = parts.join(';');
				} else {
					delete out[key];
				}
			});
		}
		return out;
	}

	var MIGRATION_RECORD_KEYS = [
		'_migrateExcluded',
		'_migrateMatchedId',
		'_migrateMatchKey',
		'_migrateMatchValue',
		'_migrateMatchAmbiguous',
		'_migrateMatchResolution',
		'_migrateMatchIntent',
		'_migrateMatchCandidates',
		'_migrateMatchSearched',
		'_migrateMatchSearchError',
		'_migrateRecordTypeId',
		'_migrateClearRecordType',
		'_migratePicklistRemap',
		'_migrateFieldResolutions',
		'_migrateRelationshipRemap',
		'_sourceRecordTypeDeveloperName',
		'_wasLoadedFromOrgId',
		'_wasLoadedFromId',
	];

	function _recordKey(objectName, sfId) {
		return String(objectName || '') + '::' + String(sfId || '');
	}

	function _valueKey(values, fieldName) {
		if (!values || !fieldName) {
			return null;
		}
		var wanted = String(fieldName).toLowerCase();
		var keys = Object.keys(values);
		for (var i = 0; i < keys.length; i++) {
			if (keys[i].toLowerCase() === wanted) {
				return keys[i];
			}
		}
		return null;
	}

	function resolvedAssociations(records, associations) {
		return (associations || []).flatMap(function (edge) {
			var child = (records || []).find(function (r) {
				return String(r.id) === String(edge.fromId);
			});
			var mappings = child && child._migrateRelationshipRemap;
			var mapped = mappings && Object.prototype.hasOwnProperty.call(mappings, edge.fieldName);
			return mapped && mappings[edge.fieldName] === ''
				? []
				: [
						Object.assign({}, edge, {
							fieldName: mapped ? mappings[edge.fieldName] : edge.fieldName,
						}),
					];
		});
	}

	function relationshipIssues(record, records, associations, describeByObject) {
		if (!record || record._migrateExcluded || isMigrationDelete(record)) return [];
		var fields = ((describeByObject || {})[record.objectName] || {}).fields || [];
		var occupied = new Set();
		var issues = [];
		(associations || []).forEach(function (edge) {
			if (String(edge.fromId) !== String(record.id)) return;
			var parent = (records || []).find(function (r) {
				return String(r.id) === String(edge.toId);
			});
			if (!parent || parent._migrateExcluded) return;
			var mappings = record._migrateRelationshipRemap || {};
			var name = Object.prototype.hasOwnProperty.call(mappings, edge.fieldName)
				? mappings[edge.fieldName]
				: edge.fieldName;
			var original = fields.find(function (f) {
				return f.name.toLowerCase() === edge.fieldName.toLowerCase();
			});
			var field = fields.find(function (f) {
				return f.name.toLowerCase() === name.toLowerCase();
			});
			var message;
			if (
				name !== edge.fieldName &&
				original &&
				!record._migrateMatchedId &&
				(original.required || (original.nillable === false && !original.defaultedOnCreate))
			) {
				message =
					'The destination still requires ' +
					original.name +
					'. Exclude this record or supply a compatible relationship before migrating.';
			} else if (!name) return;
			else if (field && field.type === 'reference' && record._migrateMatchedId && field.updateable === false)
				return;
			else if (!field || field.type !== 'reference')
				message = 'The destination has no lookup field named ' + name + '.';
			else if (!(field.referenceTo || []).includes(parent.objectName)) {
				message =
					name +
					' accepts ' +
					(field.referenceTo || []).join(', ') +
					' in the destination, but this link points to ' +
					parent.objectName +
					'.';
			} else if ((record._migrateMatchedId ? field.updateable : field.createable) === false) {
				message = name + ' is not writable in the destination.';
			} else if (occupied.has(name.toLowerCase()))
				message =
					'More than one relationship is mapped to ' +
					name +
					'. Choose a different lookup or omit one relationship.';
			if (name) occupied.add(name.toLowerCase());
			if (message)
				issues.push({
					kind: 'relationship-mismatch',
					severity: 'blocked',
					field: edge.fieldName,
					parentObject: parent.objectName,
					parentId: parent.id,
					message: message,
				});
		});
		return issues;
	}

	function exclusionIssues(record, records, associations, describeByObject) {
		if (!record || record._migrateExcluded || isMigrationDelete(record)) {
			return [];
		}
		var excluded = new Set(
			(records || [])
				.filter(function (r) {
					return r && r._migrateExcluded;
				})
				.map(function (r) {
					return String(r.id);
				}),
		);
		var fields = ((describeByObject || {})[record.objectName] || {}).fields || [];
		return (associations || [])
			.filter(function (a) {
				return a && String(a.fromId) === String(record.id) && excluded.has(String(a.toId));
			})
			.filter(function (a) {
				var field = fields.find(function (f) {
					return f.name.toLowerCase() === String(a.fieldName).toLowerCase();
				});
				return (
					field &&
					!(record._migrateMatchedId && field.updateable === false) &&
					(field.required === true || (field.nillable === false && !field.defaultedOnCreate))
				);
			})
			.map(function (a) {
				return {
					kind: 'excluded-relationship',
					severity: 'blocked',
					field: a.fieldName,
					message:
						'The required relationship ' +
						a.fieldName +
						' points to an excluded record. Include that record or exclude this dependent record too.',
				};
			});
	}

	function applyMigrationPlan(records, associations, annotationsById, baselinesByKey, describeByObject) {
		// Compile the entire plan before touching live records. A failed destination
		// refresh therefore leaves the reviewable migration state intact.
		var source = Array.isArray(records) ? records : [];
		var originalAssociations = associations;
		// Validate independently of UI annotations; a direct Apply must also fail closed.
		source.forEach(function (record) {
			var problems = relationshipIssues(record, source, associations, describeByObject);
			if (problems.length) throw new Error(problems[0].message);
		});
		associations = resolvedAssociations(source, associations);
		var annotations = annotationsById || {};
		var baselines = baselinesByKey || {};
		var plannedById = {};
		var planned = [];
		var relationshipTargets = new Map();
		var updates = 0;
		var deletes = 0;
		var creates = 0;
		var excludedIds = new Set(
			source
				.filter(function (r) {
					return r && r._migrateExcluded;
				})
				.map(function (r) {
					return String(r.id);
				}),
		);
		if (
			!source.some(function (r) {
				return r && !r.isTypeNode && !r._migrateExcluded;
			})
		) {
			throw new Error('Include at least one record in the migration.');
		}

		for (var i = 0; i < source.length; i++) {
			var record = source[i];
			if (!record || record.isTypeNode || record._migrateExcluded) {
				continue;
			}
			var annotation = annotations[record.id];
			var excludedIssues = exclusionIssues(record, source, associations, describeByObject);
			if (excludedIssues.length) {
				throw new Error(excludedIssues[0].message);
			}
			if (annotation && (annotation.status === 'pending' || annotation.status === 'blocked')) {
				throw new Error('Resolve unavailable objects and required fields before applying the migration.');
			}
			var matchedId = record._migrateMatchedId || null;
			var deleting = isMigrationDelete(record);
			if (deleting && !matchedId) {
				throw new Error('Select a destination record to delete, or choose Create new.');
			}
			var patch = deleting ? {} : prepareMigrationValues(record, annotations[record.id] || null);
			Object.keys(record._migrateRelationshipRemap || {}).forEach(function (name) {
				if (record._migrateRelationshipRemap[name] !== name) {
					var staleKey = _valueKey(patch, name);
					if (staleKey) delete patch[staleKey];
				}
			});
			delete patch.attributes;
			delete patch.Id;
			// Matched records keep destination relationships that Salesforce cannot update.
			// These can be present as either literal values or canvas associations.
			var fields = ((describeByObject || {})[record.objectName] || {}).fields || [];
			var preservedRelationships = fields.filter(function (field) {
				return matchedId && field.type === 'reference' && (deleting || field.updateable === false);
			});
			preservedRelationships.forEach(function (field) {
				Object.keys(patch).forEach(function (key) {
					if (key.toLowerCase() === field.name.toLowerCase()) {
						delete patch[key];
					}
				});
			});
			(associations || []).forEach(function (a) {
				if (a && String(a.fromId) === String(record.id) && excludedIds.has(String(a.toId))) {
					var key = _valueKey(patch, a.fieldName);
					if (key) {
						delete patch[key];
					}
				}
			});
			var next;
			if (matchedId) {
				var baseline = baselines[_recordKey(record.objectName, matchedId)];
				if (!baseline || typeof baseline !== 'object') {
					throw new Error(
						'Could not load the selected destination record for ' + (record.objectName || 'record') + '.',
					);
				}
				var loadedValues = Object.assign({}, baseline);
				if (!_valueKey(loadedValues, 'Id')) {
					loadedValues.Id = matchedId;
				}
				next = {
					record: record,
					loadedFromId: matchedId,
					loadedValues: loadedValues,
					values: Object.assign({}, loadedValues, patch),
				};
				if (deleting) {
					deletes++;
				} else {
					updates++;
				}
			} else {
				next = {
					record: record,
					loadedFromId: null,
					loadedValues: null,
					values: Object.assign({}, patch),
				};
				creates++;
			}
			planned.push(next);
			next.pendingDelete = deleting;
			next.preservedRelationships = preservedRelationships;
			plannedById[String(record.id)] = next;
		}

		(Array.isArray(associations) ? associations : []).forEach(function (association) {
			if (!association || !association.fieldName) {
				return;
			}
			var child = plannedById[String(association.fromId)];
			var parent = plannedById[String(association.toId)];
			var preservedField =
				child &&
				child.preservedRelationships.find(function (field) {
					return field.name.toLowerCase() === association.fieldName.toLowerCase();
				});
			if (preservedField || (child && child.pendingDelete)) {
				var destinationId = _lookupValue(
					child.loadedValues,
					preservedField ? preservedField.name : association.fieldName,
				);
				var destinationParent =
					destinationId &&
					planned.find(function (candidate) {
						return (
							candidate.loadedFromId &&
							candidate.loadedFromId.slice(0, 15) === String(destinationId).slice(0, 15)
						);
					});
				// Keep the line only when its actual destination parent is on this canvas.
				relationshipTargets.set(association, destinationParent ? destinationParent.record.id : null);
				return;
			}
			if (!child || !parent) {
				return;
			}
			var existingKey = _valueKey(child.values, association.fieldName);
			if (parent.loadedFromId) {
				child.values[existingKey || association.fieldName] = parent.loadedFromId;
			} else if (existingKey) {
				delete child.values[existingKey];
			}
		});

		planned.forEach(function (next) {
			var record = next.record;
			record.values = next.values;
			if (next.pendingDelete) {
				record.pendingDelete = true;
			} else {
				delete record.pendingDelete;
			}
			// Import warnings describe the old connection. Rebuild them from the
			// destination schema and the values that survived the migration plan.
			var describe = describeByObject && describeByObject[record.objectName];
			if (describe && Array.isArray(describe.fields)) {
				var availableFields = new Set(
					describe.fields.map(function (field) {
						return field.name.toLowerCase();
					}),
				);
				var missingFields = Object.keys(record.values || {}).filter(function (name) {
					return name !== 'attributes' && !name.startsWith('_') && !availableFields.has(name.toLowerCase());
				});
				delete record._importSchemaWarning;
				if (missingFields.length) {
					record._importSchemaWarning = { objectUnavailable: false, fields: missingFields };
				}
			}
			if (next.loadedFromId) {
				record.loadedFromId = next.loadedFromId;
				record.loadedValues = next.loadedValues;
				record._deletedInSf = false;
				record._inaccessible = false;
			} else {
				delete record.loadedFromId;
				delete record.loadedValues;
			}
			MIGRATION_RECORD_KEYS.forEach(function (key) {
				delete record[key];
			});
		});

		// Only the destination working copy changes; the saved source canvas is untouched.
		for (var j = source.length - 1; j >= 0; j--) {
			if (source[j] && excludedIds.has(String(source[j].id))) {
				source.splice(j, 1);
			}
		}
		for (var k = (associations || []).length - 1; k >= 0; k--) {
			var edge = associations[k];
			if (relationshipTargets.has(edge)) {
				var targetId = relationshipTargets.get(edge);
				if (targetId === null) {
					associations.splice(k, 1);
					continue;
				}
				edge.toId = targetId;
			}
			if (excludedIds.has(String(edge.fromId)) || excludedIds.has(String(edge.toId))) {
				associations.splice(k, 1);
			}
		}
		if (Array.isArray(originalAssociations))
			originalAssociations.splice(0, originalAssociations.length, ...associations);
		return {
			updates: updates,
			deletes: deletes,
			creates: creates,
			excluded: excludedIds.size,
			total: updates + deletes + creates,
		};
	}

	var api = {
		isMigrationDelete: isMigrationDelete,
		exclusionIssues: exclusionIssues,
		relationshipIssues: relationshipIssues,
		resolvedAssociations: resolvedAssociations,
		computeMigrationStatus: computeMigrationStatus,
		resolveTargetRecordTypeId: resolveTargetRecordTypeId,
		picklistValuesForRecordType: picklistValuesForRecordType,
		supportsCustomPicklistValue: supportsCustomPicklistValue,
		annotateRecords: annotateRecords,
		summarize: summarize,
		badgeSummary: badgeSummary,
		prepareMigrationValues: prepareMigrationValues,
		applyMigrationPlan: applyMigrationPlan,
	};

	if (typeof window !== 'undefined') {
		window.Orgloom = window.Orgloom || {};
		window.Orgloom.migrateAnnotate = api;
	}
	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
})();

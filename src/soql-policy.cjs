// Adapted from Org Loom canvas core canvas-routes.js; PolyForm Internal Use 1.0.0.
function _maskSoqlSkeleton(soql) {
	const out = String(soql).split('');
	const n = out.length;
	let i = 0;
	let inStr = false;
	while (i < n) {
		const c = out[i];
		if (!inStr) {
			if (c === "'") {
				inStr = true;
				out[i] = ' ';
			}
			i++;
			continue;
		}
		if (c === '\\') {
			out[i] = ' ';
			if (i + 1 < n) {
				out[i + 1] = ' ';
			}
			i += 2;
			continue;
		}
		if (c === "'") {
			inStr = false;
		}
		out[i] = ' ';
		i++;
	}
	let depth = 0;
	for (let j = 0; j < n; j++) {
		const c = out[j];
		if (c === '(') {
			depth++;
			out[j] = ' ';
			continue;
		}
		if (c === ')') {
			if (depth > 0) {
				depth--;
			}
			out[j] = ' ';
			continue;
		}
		if (depth > 0) {
			out[j] = ' ';
		}
	}
	return out.join('');
}

const SOQL_OBJECT_DENYLIST = new Set([
	'apexclass',
	'apextrigger',
	'apexcomponent',
	'apexpage',
	'apexlog',
	'apextestresult',
	'apexcodecoverage',
	'apexcodecoverageaggregate',
	'apextestqueueitem',
	'apexemailnotification',
	'apexpageinfo',
	'staticresource',
	'entitydefinition',
	'fielddefinition',
	'flowdefinitionview',
	'userlogin',
	'profile',
	'permissionset',
	'permissionsetassignment',
	'permissionsetgroup',
	'permissionsetlicense',
	'permissionsetlicenseassign',
	'objectpermissions',
	'fieldpermissions',
	'setupentityaccess',
	'organization',
	'authsession',
	'authconfig',
	'authconfigproviders',
	'authprovider',
	'oauthtoken',
	'connectedapplication',
	'samlssoconfig',
	'loginhistory',
	'loginip',
	'logingeo',
	'sessionpermsetactivation',
	'setupaudittrail',
	'apianomalyeventstore',
	'credentialstuffingeventstore',
]);


module.exports = { mask: _maskSoqlSkeleton, denied: SOQL_OBJECT_DENYLIST };

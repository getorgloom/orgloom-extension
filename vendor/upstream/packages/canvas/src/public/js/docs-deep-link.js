(function () {
	function openTarget() {
		var hash = location.hash ? location.hash.slice(1) : '';
		if (!hash) {
			return;
		}
		var el = document.getElementById(hash);
		if (!el || el.tagName !== 'DETAILS') {
			return;
		}
		el.open = true;
		setTimeout(function () {
			try {
				el.scrollIntoView({ block: 'start' });
			} catch (_) {}
		}, 0);
	}
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', openTarget);
	} else {
		openTarget();
	}
	window.addEventListener('hashchange', openTarget);
})();

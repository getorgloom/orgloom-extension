(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.anchoredPopup = {
		mount: function mount() {
			function _openAnchoredPopup(triggerEl, width) {
				document.querySelectorAll('.templates-popup').forEach((el) => el.remove());
				const pop = document.createElement('div');
				pop.className = 'templates-popup';
				const rect = triggerEl.getBoundingClientRect();
				const viewportW = window.innerWidth;
				const viewportH = window.innerHeight;
				const effectiveWidth = Math.min(width, viewportW - 16);
				pop.style.left = Math.max(8, Math.min(rect.left, viewportW - effectiveWidth - 8)) + 'px';
				pop.style.width = effectiveWidth + 'px';
				const below = rect.bottom + 6;
				const fitsBelow = below + 200 <= viewportH - 8;
				if (fitsBelow) {
					pop.style.top = below + 'px';
				} else if (rect.top - 6 >= 200) {
					pop.style.top = '8px';
					pop.style.maxHeight = rect.top - 14 + 'px';
				} else {
					pop.style.top = '8px';
				}
				const cleanup = () => {
					if (pop.parentNode) {
						pop.remove();
					}
					document.removeEventListener('mousedown', outside, true);
					document.removeEventListener('keydown', onEsc, true);
				};
				const outside = (ev) => {
					if (!pop.contains(ev.target) && ev.target !== triggerEl) {
						cleanup();
					}
				};
				const onEsc = (ev) => {
					if (ev.key === 'Escape') {
						cleanup();
					}
				};
				setTimeout(() => {
					document.addEventListener('mousedown', outside, true);
					document.addEventListener('keydown', onEsc, true);
				}, 0);
				document.body.appendChild(pop);
				return { pop: pop, cleanup: cleanup };
			}

			return { _openAnchoredPopup: _openAnchoredPopup };
		},
	};
})();

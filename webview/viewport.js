(() => {
  // Capture the renderer at construction without editing pinned canvas code.
  // The website centers the first record at startup; a smaller editor tab needs
  // an initial fit. All pan/zoom/drag interactions still belong to the real app.
  let canvas;
  function fit() {
    if (!canvas || canvas.destroyed() || !canvas.nodes().length) return;
    canvas.resize();
    canvas.fit(undefined, 70);
    if (canvas.zoom() > 1) { canvas.zoom(1); canvas.center(); }
  }
  window.cytoscape = new Proxy(window.cytoscape, {
    apply(target, receiver, args) {
      // Use the same explicit system font as the cards instead of Cytoscape's
      // platform-dependent Helvetica fallback for small, rotated relationship labels.
      if (args[0]?.container?.id === 'bulk-canvas-cy' && Array.isArray(args[0].style)) {
        args = [{ ...args[0], style: args[0].style.map(rule => rule.selector === 'edge'
          ? { ...rule, style: { ...rule.style, 'font-family': 'system-ui, sans-serif', 'font-size': 11, 'font-weight': 400, color: '#b8bec6' } }
          : rule) }, ...args.slice(1)];
      }
      const cy = Reflect.apply(target, receiver, args);
      if (args[0]?.container?.id === 'bulk-canvas-cy') {
        canvas = cy;
        setTimeout(fit, 200);
      }
      return cy;
    },
  });
  document.getElementById('prototype-fit').addEventListener('click', fit);
})();

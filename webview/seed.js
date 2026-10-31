(() => {
  // VS Code owns the webview URL, so use the existing canvas recovery format
  // rather than the website's ?openCanvas navigation. Values come exclusively
  // from the pinned fictional fixture. No test-only canvas APIs are enabled.
  if (window.__ORGLOOM_RESTORED_SAMPLE__) return;
  const objects = ['Account', 'Contact', 'Task'].map((name, index) => ({ id: index + 1, name, label: name }));
  const selection = [
    ['Account', 0, 400, -120], ['Contact', 0, 200, 60], ['Contact', 1, 600, 60],
    ['Task', 0, 200, 240], ['Task', 1, 600, 240],
  ];
  const records = selection.map(([objectName, index, x, y], i) => {
    const values = { ...window.OrgLoomMock.records[objectName][index] };
    return { id: i + 1, objectName, label: objectName, fromSelectionId: objects.find(o => o.name === objectName).id,
      loadedFromId: values.Id, values, loadedValues: { ...values }, x, y };
  });
  const identity = 'playground:00DDEMO00000000AAA:005DEMO00000000AAA';
  const scope = identity + ':new';
  const key = 'orgloom:canvas-draft:v1|' + scope;
  sessionStorage.setItem(key, JSON.stringify({ v: 1, identity, scope, ts: Date.now(), state: {
    selectedObjects: objects, selectedIdSeq: 4, activeIndex: 0, bulkRecords: records,
    bulkIdSeq: 6, bulkAssociations: [
      { id: 'sample-1', fromId: 2, toId: 1, fieldName: 'AccountId' },
      { id: 'sample-2', fromId: 3, toId: 1, fieldName: 'AccountId' },
      { id: 'sample-3', fromId: 4, toId: 2, fieldName: 'WhoId' },
      { id: 'sample-4', fromId: 5, toId: 3, fieldName: 'WhoId' },
    ], hiddenObjects: [], graphView: 'bulk', currentCanvas: null, bulkZoom: 1,
  } }));
  sessionStorage.setItem('orgloom:canvas-draft-active:v1|' + identity, key);
})();

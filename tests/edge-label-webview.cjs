const vscode=require('vscode');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
exports.run=async({workbench,until,output})=>{
 await vscode.commands.executeCommand('orgloom.openCanvas');
 await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
 await vscode.commands.executeCommand('notifications.hideToasts');
 const canvas=await until(async()=>{for(const f of workbench.frames())if(await f.locator('#prototype-reset').count().catch(()=>0))return f;},'sample canvas');
 await until(async()=>await canvas.locator('[data-rec-id]').count()>=5,'sample records');
 await canvas.locator('#prototype-fit').click();
 const report=await canvas.evaluate(()=>{const cy=document.getElementById('bulk-canvas-cy')._cyreg.cy;return {zoom:cy.zoom(),edges:cy.edges().map(e=>({label:e.data('label'),font:e.style('font-family'),weight:e.style('font-weight'),color:e.style('color'),size:e.style('font-size'),opacity:e.style('text-opacity'),box:e.boundingBox()}))};});
 fs.writeFileSync(path.join(output,'edge-label-report.json'),JSON.stringify(report,null,2));
 for(const edge of report.edges){assert.equal(edge.font,'system-ui, sans-serif');assert.equal(edge.size,'11px');assert.equal(edge.opacity,'1');assert.ok(edge.label);}
 for (const zoom of [0.65,1,1.4]) {
  await canvas.evaluate(zoom=>{const cy=document.getElementById('bulk-canvas-cy')._cyreg.cy;cy.edges().removeClass('edge-picked');cy.zoom(zoom);cy.center();},zoom);
  await new Promise(r=>setTimeout(r,250));
  await workbench.screenshot({path:path.join(output,'edge-labels-'+zoom+'.png')});
 }
 await canvas.evaluate(()=>{const cy=document.getElementById('bulk-canvas-cy')._cyreg.cy;cy.zoom(1);cy.center();cy.edges().addClass('edge-picked');});
 await new Promise(r=>setTimeout(r,250));
 const selected=await canvas.evaluate(()=>document.getElementById('bulk-canvas-cy')._cyreg.cy.edges().map(e=>({color:e.style('color'),weight:e.style('font-weight')})));
 for(const edge of selected){assert.equal(edge.color,'rgb(240,160,80)');assert.equal(edge.weight,'600');}
 await workbench.screenshot({path:path.join(output,'edge-labels-selected.png')});
};

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const context=vm.createContext({allData:[],DRIVER_ALLOWANCE:200});
vm.runInContext(html.slice(html.indexOf('function getDispatchWorkers('),html.indexOf('function nightFormWorkers(')),context);
vm.runInContext(html.match(/function employeeKey[^\r\n]+/)[0],context);
vm.runInContext(html.match(/function getEmployeeWageAtDate[^\r\n]+/)[0],context);
vm.runInContext(fs.readFileSync(path.join(root,'project-costs.js'),'utf8'),context);
const projects=[{id:1,type:'project',project_type:'contract',project_name:'合約'},{id:2,type:'project',project_type:'labor',project_name:'點工'},{id:3,type:'project',project_type:'labor'}];
const employee={id:10,type:'employee',employee_name:'甲',employee_id:'A',wage:2100,active:false};
const clock=(id,type,time)=>({id,type:'clock',employee_name:'甲',check_type:type,timestamp:time});
const clocks=[clock(20,'上班','2026-10-03T08:00:00'),clock(21,'下班','2026-10-03T19:30:00')];
const dispatch=(id,project,extra={})=>({id,type:'dispatch',employee_name:'甲',linked_project_id:project,timestamp:'2026-10-03T00:00:00',...extra});
const overtime={id:40,type:'overtime_pay',employee_name:'甲',date:'2026-10-03',amount:919};
let passed=0;
function run(label,rows,test){context.allData=JSON.parse(JSON.stringify(rows));const before=JSON.stringify(context.allData);test(context.buildProjectLaborCostMap(projects));assert.equal(JSON.stringify(context.allData),before,'Derived costs must not mutate source records');passed++;console.log('PASS '+label);}
run('labor project includes wages, overtime and driver; inactive employee retained',[employee,...clocks,dispatch(30,2,{drivers:'甲'}),overtime],r=>{
    const e=r.byProject[2].entries[0];assert.equal(e.basePay,2100);assert.equal(e.overtimePay,919);assert.equal(e.allowance,200);assert.equal(r.byProject[2].total,3219);assert.equal(r.unassigned.total,0);
});
run('contract and labor sharing has no rounding leakage',[employee,...clocks,dispatch(30,1),dispatch(31,2),dispatch(32,3),overtime],r=>{
    assert.equal(Object.values(r.byProject).reduce((s,p)=>s+p.total,0),3019);
    assert.equal(r.byProject[1].entries[0].overtimePay,307);
    assert.equal(r.byProject[2].entries[0].basePay,700);
});
run('duplicate same-day dispatch does not duplicate wage or overtime',[employee,...clocks,dispatch(30,2),dispatch(31,2),overtime],r=>assert.equal(r.byProject[2].total,3019));
run('night shift crosses midnight only once',[employee,clock(20,'上班','2026-10-03T22:00:00'),clock(21,'下班','2026-10-04T05:30:00'),dispatch(30,2,{night_shift:true,night_allowances:{'甲':300}})],r=>{
    assert.equal(r.byProject[2].total,2400);assert.equal(r.byProject[2].entries[0].hours,6.5);assert.equal(r.unassigned.total,0);
});
run('daily and night shifts on separate projects use payroll pairing',[employee,clock(18,'上班','2026-10-03T08:00:00'),clock(19,'下班','2026-10-03T17:00:00'),clock(20,'上班','2026-10-04T22:00:00'),clock(21,'下班','2026-10-05T05:30:00'),dispatch(30,1),dispatch(31,2,{timestamp:'2026-10-04T00:00:00',night_shift:true,night_allowances:{'甲':300}})],r=>{
    assert.equal(r.byProject[1].total,2100);assert.equal(r.byProject[2].total,2400);
});
run('missing checkout leaves wage zero but manual overtime retained',[employee,clocks[0],dispatch(30,2),overtime],r=>{assert.equal(r.byProject[2].total,919);assert.equal(r.byProject[2].entries[0].complete,false);});
run('historical wage change is respected',[employee,...clocks,dispatch(30,2),{type:'salary_change',employee_id:'A',effective_date:'2026-10-10',old_wage:1600,new_wage:2100}],r=>assert.equal(r.byProject[2].total,1600));
run('no dispatch stays unassigned',[employee,...clocks,overtime],r=>{assert.equal(Object.keys(r.byProject).length,0);assert.equal(r.unassigned.total,3019);});
run('unlinked second assignment preserves unassigned share',[employee,...clocks,dispatch(30,2),dispatch(31,null),overtime],r=>{
    assert.equal(r.byProject[2].total+r.unassigned.total,3019);assert.ok(r.unassigned.total>0);
});
run('edited dispatch moves cost; edited overtime recomputes',[employee,...clocks,dispatch(30,1),{...overtime,amount:700}],r=>{assert.equal(r.byProject[1].total,2800);assert.equal(r.byProject[2],undefined);});
run('billing and reimbursements never count as wages',[employee,...clocks,dispatch(30,2),{type:'proj_labor',project_id:2,amount:8400},{type:'reimbursement',employee_name:'甲',amount:500},{type:'payout_history',total_amount:9999}],r=>assert.equal(r.byProject[2].total,2100));
run('missing employee wage warns, overtime still kept',[...clocks,dispatch(30,2),overtime],r=>{assert.equal(r.byProject[2].total,919);assert.equal(r.byProject[2].entries[0].missingWage,true);});
run('half-day follows payroll rule',[employee,clocks[0],clock(21,'下班','2026-10-03T12:00:00'),dispatch(30,2)],r=>assert.equal(r.byProject[2].total,1050));

// Render a full project page using the real template; no network or production writes.
vm.runInContext(html.slice(html.indexOf('function getLaborWeekInfo('),html.indexOf('function renderProjectPage(')),context);
vm.runInContext(html.slice(html.indexOf('function renderProjectPage('),html.indexOf('function toggleProjTypeFields(')),context);
vm.runInContext(html.slice(html.indexOf('function calcTax('),html.indexOf('function calcLaborSubtotal(')),context);
context.esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const elements={'project-list':{innerHTML:''},'project-overall-summary':{innerHTML:''}};
context.document={getElementById:id=>elements[id]};
context.allData=[...projects.slice(0,2),employee,...clocks,dispatch(30,2),overtime,{type:'proj_labor',project_id:2,amount:8400,date:'2026-10-03',worker_count:3,daily_rate:2800},{type:'proj_expense',project_id:2,category:'薪資',amount:50,date:'2026-10-03'}];
context.renderProjectPage();
assert.ok(elements['project-list'].innerHTML.includes('自動人事成本'));
assert.ok(elements['project-list'].innerHTML.includes('已有手動「薪資」支出'));
assert.ok(elements['project-list'].innerHTML.includes('加班 $919'));
assert.ok(elements['project-list'].innerHTML.includes('8,400'));
assert.ok(elements['project-overall-summary'].innerHTML.includes('3,069'));
assert.ok(elements['project-overall-summary'].innerHTML.includes('8,400'));
console.log(`${passed} costing cases and full project rendering passed.`);

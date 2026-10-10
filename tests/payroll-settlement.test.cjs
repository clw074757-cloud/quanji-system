const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const ctx=vm.createContext({allData:[],DRIVER_ALLOWANCE:200});
const portion=(start,end)=>html.slice(html.indexOf(start),html.indexOf(end));
vm.runInContext(portion('function getDispatchWorkers(','function nightFormWorkers('),ctx);
vm.runInContext(html.match(/function employeeKey[^\r\n]+/)[0]+html.match(/function getEmployeeWageAtDate[^\r\n]+/)[0],ctx);
vm.runInContext(fs.readFileSync(path.join(root,'overtime.js'),'utf8'),ctx);
vm.runInContext(fs.readFileSync(path.join(root,'payroll-settlement.js'),'utf8'),ctx);
vm.runInContext(portion('function buildContractLaborCostMap(','function renderProjectPage('),ctx);
const emp={id:1,type:'employee',employee_name:'甲',employee_id:'A',wage:2100};
const project={id:2,type:'project',project_name:'工程',project_type:'contract'};
const dispatch={id:3,type:'dispatch',employee_name:'甲',timestamp:'2026-10-03T00:00:00',linked_project_id:2};
const clocks=[{id:4,type:'clock',employee_name:'甲',check_type:'上班',timestamp:'2026-10-03T08:00:00'},
    {id:5,type:'clock',employee_name:'甲',check_type:'下班',timestamp:'2026-10-03T19:30:00'}];
const weekly={startDate:'2026/09/28',endDate:'2026/10/04',total:3019,details:[{name:'甲',pay:3019,base_pay:2100,driver_allowance:0,night_allowance:0,overtime_pay:919,reimbursement:0}],reimbursementIds:[]};
const ot={id:6,type:'overtime_pay',employee_name:'甲',date:'2026-10-03',amount:919};
const base=[emp,project,dispatch,...clocks,ot];
let count=0;
function test(name,fn){fn();count++;console.log('PASS '+name);}
test('preview matches paid wages and does not mutate old data',()=>{
    ctx.allData=JSON.parse(JSON.stringify(base));const before=JSON.stringify(ctx.allData),r=ctx.buildPayrollPreview(weekly);
    assert.equal(r.lines.reduce((s,l)=>s+l.amount,0),3019);assert.ok(r.lines.every(l=>l.project_id===2));assert.equal(JSON.stringify(ctx.allData),before);
});
test('unassigned work requires project selection',()=>{ctx.allData=base.filter(r=>r.type!=='dispatch');assert.ok(ctx.buildPayrollPreview(weekly).lines.every(l=>l.project_id===0));});
test('multiple projects require confirmation, not guessed duplication',()=>{ctx.allData=[...base,{id:7,type:'project'},{...dispatch,id:8,linked_project_id:7}];const r=ctx.buildPayrollPreview(weekly);assert.ok(r.lines.every(l=>l.project_id===0));assert.equal(r.lines.reduce((s,l)=>s+l.amount,0),3019);});
const reim={id:10,type:'reimbursement',employee_name:'甲',amount:500,status:'approved',date:'2026-10-03',category:'加油',project_id:2};
const withReim={...weekly,total:3519,details:[{...weekly.details[0],pay:3519,reimbursement:500}],reimbursementIds:[10]};
test('existing reimbursement expense is reused',()=>{ctx.allData=[...base,reim,{id:11,type:'proj_expense',reimbursement_id:10,project_id:2,amount:500}];const r=ctx.buildPayrollPreview(withReim);assert.equal(r.reimbursements[0].existing_expense_id,11);assert.equal(r.lines.reduce((s,l)=>s+l.amount,0),3019);});
test('missing reimbursement expense flagged for creation',()=>{ctx.allData=[...base,{...reim,project_id:null}];const r=ctx.buildPayrollPreview(withReim).reimbursements[0];assert.equal(r.existing_expense_id,null);assert.equal(r.project_id,0);});
test('duplicate or inconsistent reimbursement stops settlement',()=>{
    const e={id:11,type:'proj_expense',reimbursement_id:10,project_id:2,amount:400};ctx.allData=[...base,reim,e];assert.throws(()=>ctx.buildPayrollPreview(withReim),/金額不符/);
    ctx.allData.push({...e,id:12});assert.throws(()=>ctx.buildPayrollPreview(withReim),/多筆/);
});
test('payroll mismatch fails closed',()=>{ctx.allData=base;assert.throws(()=>ctx.buildPayrollPreview({...weekly,total:9999}),/總額/);});
const payout={type:'payout_history',start_date:'2026/9/28',end_date:'2026/10/4',details:[{name:'甲'}]};
test('old payout prevents backfill but leaves old contract cost calculation',()=>{ctx.allData=[...base,payout];assert.equal(ctx.payrollPeriodSettled('2026-09-28','2026-10-04'),true);assert.equal(ctx.payrollCostAlreadyPosted('甲','2026-10-03'),false);assert.equal(ctx.buildContractLaborCostMap([project])[2].total,2100);});
test('new payout removes only its automatic legacy cost to prevent double count',()=>{ctx.allData=[...base,{...payout,settlement_version:1}];assert.equal(ctx.payrollCostAlreadyPosted('甲','2026-10-03'),true);assert.equal(ctx.payrollCostAlreadyPosted('甲','2026-10-05'),false);assert.equal(ctx.buildContractLaborCostMap([project])[2].total,0);});
test('historical pay and cross-midnight night shift retained',()=>{
    ctx.allData=[{...emp,active:false},project,{...dispatch,night_shift:true,night_allowances:{'甲':300}},
        {...clocks[0],timestamp:'2026-10-03T22:00:00'},{...clocks[1],timestamp:'2026-10-04T05:30:00'},
        {type:'salary_change',employee_id:'A',old_wage:1600,new_wage:2100,effective_date:'2026-10-05'}];
    const w={...weekly,total:1900,details:[{name:'甲',pay:1900,base_pay:1600,night_allowance:300,driver_allowance:0,overtime_pay:0,reimbursement:0}]};
    const r=ctx.buildPayrollPreview(w);assert.equal(r.lines.reduce((s,l)=>s+l.amount,0),1900);assert.ok(r.lines.every(l=>l.date==='2026-10-03'));
});
test('new-only edit guards leave legacy data available',()=>{
    assert.equal(ctx.isPostedPayrollRecord(payout),false);assert.equal(ctx.isPostedPayrollRecord({...payout,settlement_version:1}),true);
    assert.equal(ctx.isPostedPayrollRecord({type:'proj_expense',settlement_version:1}),true);
    ctx.allData.push({...payout,settlement_version:1,reimbursement_ids:[10]});
    assert.equal(ctx.isPostedPayrollRecord({type:'proj_expense',reimbursement_id:10}),true);
});
console.log(`${count} settlement tests passed; no live writes.`);

(async()=>{
    const elements=new Map(),messages=[],calls=[];
    const element=id=>{
        if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',disabled:false,classList:{add(){},remove(){}}});
        return elements.get(id);
    };
    ctx.document={getElementById:element,querySelector:()=>({value:'2'})};
    ctx.esc=s=>String(s??'').replaceAll('<','&lt;');
    ctx.currentUser={is_admin:true,employee_name:'測試管理員'};
    ctx.currentWeeklyData=JSON.parse(JSON.stringify(weekly));
    ctx.allData=JSON.parse(JSON.stringify(base));
    ctx.loadData=async()=>{};ctx.alert=s=>messages.push(s);ctx.confirm=()=>true;
    ctx.getAdminCredentials=()=>({id:'test-admin',password:'fixture-only'});
    ctx.callDatabaseFunction=async(name,payload)=>{calls.push({name,payload});return {ok:true};};
    await ctx.settleSalary();
    assert.ok(element('payroll-posting-rows').innerHTML.includes('基本工資'));
    assert.ok(element('payroll-posting-rows').innerHTML.includes('加班費'));
    assert.equal(calls.length,0,'Opening preview must never write');
    await ctx.confirmPayrollPosting();
    assert.equal(calls.length,1);assert.equal(calls[0].name,'settle_payroll_with_expenses_v1');
    assert.equal(calls[0].payload.p_payroll.total_amount,3019);
    assert.equal(calls[0].payload.p_lines.reduce((s,l)=>s+l.amount,0),3019);
    await ctx.confirmPayrollPosting();assert.equal(calls.length,1,'Double click cannot repeat a completed settlement');
    await ctx.settleSalary();ctx.document.querySelector=()=>({value:''});
    await ctx.confirmPayrollPosting();assert.equal(calls.length,1);assert.ok(messages.at(-1).includes('選擇對應案件'));
    ctx.document.querySelector=()=>({value:'2'});ctx.allData.push({...payout,settlement_version:1});
    await ctx.confirmPayrollPosting();assert.equal(calls.length,1);assert.ok(messages.at(-1).includes('期間已結算'));
    console.log('Preview/save UI flow, missing selection, and repeat guards passed (mock RPC only).');
})().catch(e=>{console.error(e);process.exitCode=1;});

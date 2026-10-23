process.env.TZ='Asia/Taipei';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const nodes={};
function node(id){return nodes[id]??={value:'',textContent:'',innerHTML:'',focus(){this.focused=true;},scrollIntoView(){this.scrolled=true;}};}
const context=vm.createContext({document:{getElementById:node},Date,console,allData:[],currentUser:{is_admin:true},currentWeeklyData:{total:0},currentViewDate:new Date('2026-10-21T12:00:00+08:00'),esc:s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),nav:p=>{context.page=p;},switchAdminSection:s=>{context.section=s;}});
function source(from,to){return html.slice(html.indexOf(from),html.indexOf(to,html.indexOf(from)));}
vm.runInContext(source('function getWeekRange(', 'async function loadData('),context);
vm.runInContext(source('function getDispatchDate(', 'function nightFormWorkers('),context);
vm.runInContext("function localDateKey(d){return getDispatchDate(d);} function isEmployeeAvailable(e){return !!e&&e.active!==false&&e.employment_status!=='unpaid_leave';}",context);
vm.runInContext(fs.readFileSync(path.join(root,'payroll-settlement.js'),'utf8'),context);
vm.runInContext(fs.readFileSync(path.join(root,'admin-todo.js'),'utf8'),context);
const now=new Date('2026-10-23T09:00:00+08:00');
let id=0;
const emp=(name,extra={})=>({id:++id,type:'employee',employee_name:name,...extra});
const clock=(name,date,time,check_type)=>({id:++id,type:'clock',employee_name:name,timestamp:date+'T'+time+':00+08:00',check_type});
context.allData=[emp('缺卡甲'),emp('超時乙'),emp('今日丙'),emp('夜班丁'),emp('已離職',{active:false}),emp('停薪',{employment_status:'unpaid_leave'}),
    clock('缺卡甲','2026-10-20','08:00','上班'),clock('超時乙','2026-10-21','08:00','上班'),clock('超時乙','2026-10-21','18:00','下班'),
    clock('今日丙','2026-10-23','08:00','上班'),clock('夜班丁','2026-10-22','22:00','上班'),
    {id:++id,type:'dispatch',employee_name:'夜班丁',timestamp:'2026-10-22T00:00:00+08:00',night_shift:true},
    clock('已離職','2026-10-20','08:00','上班'),clock('停薪','2026-10-20','08:00','上班'),
    {id:101,type:'reimbursement',employee_name:'已離職',date:'2026-08-01',status:'approved',amount:500},
    {id:102,type:'reimbursement',employee_name:'超時乙',date:'2026-10-20',status:'pending',amount:200},
    {id:103,type:'reimbursement',employee_name:'超時乙',date:'2026-10-20',status:'paid',amount:100}];
let before=JSON.stringify(context.allData),result=context.buildAdminTodos(now);
assert.equal(result.missing.length,1);assert.equal(result.missing[0].name,'缺卡甲');
assert.equal(result.overtime.length,1);assert.equal(result.overtime[0].minutes,60);
assert.equal(result.unpaid.length,1);assert.equal(result.pending.length,1);
assert.equal(JSON.stringify(context.allData),before);
console.log('Missing clocks, open day/night shifts, inactive staff, overtime, and all-period reimbursements PASS');
assert.equal(context.buildAdminTodos(new Date('2026-10-23T15:00:00+08:00')).missing.length,2);
context.allData.push(clock('夜班丁','2026-10-23','05:30','下班'));
assert.equal(context.buildAdminTodos(new Date('2026-10-23T15:00:00+08:00')).missing.length,1);
context.allData.push({type:'overtime_pay',employee_name:'超時乙',date:'2026-10-21',amount:350});
assert.equal(context.buildAdminTodos(now).overtime.length,0);
context.allData.push({type:'payout_history',start_date:'2026/10/19',end_date:'2026/10/25'});
result=context.buildAdminTodos(now);assert.equal(result.missing[0].settled,true);assert.equal(result.overtime.length,0);
console.log('Cross-midnight pairing, existing overtime, and settled periods PASS');
context.allData=context.allData.filter(r=>r.type!=='payout_history');
context.currentWeeklyData={total:100};
vm.runInContext("buildPayrollPreview=()=>({start:'2026-10-19',end:'2026-10-25',lines:[{employee_name:'甲',date:'2026-10-21',kind:'base_pay',amount:100,project_id:0}],reimbursements:[]});",context);
assert.equal(context.buildAdminTodos(now).projects.length,1);
vm.runInContext("buildPayrollPreview=()=>{throw new Error('金額不符');};",context);
assert.equal(context.buildAdminTodos(now).projectError,'金額不符');
context.currentWeeklyData={total:0};
context.renderAdminTodos();assert.ok(node('admin-todo-content').innerHTML.includes('待付款代墊'));
vm.runInContext("adminTodoActions=[{kind:'clock',name:'缺卡甲',date:'2026-10-20'},{kind:'overtime',name:'超時乙',date:'2026-10-21',minutes:60},{kind:'reimbursement',id:101,status:'approved'},{kind:'project'}];",context);
context.openAdminTodo(0);assert.equal(node('admin-clock-emp').value,'缺卡甲');assert.equal(node('admin-clock-time').value,'');assert.ok(node('admin-clock-todo-hint').textContent.includes('2026-10-20'));
context.openAdminTodo(1);assert.equal(node('overtime-date').value,'2026-10-21');assert.equal(node('overtime-amount').value,'');
context.openAdminTodo(2);assert.equal(context.page,'reimbursement');assert.equal(node('reimbursement-status-filter').value,'approved');assert.equal(node('reimbursement-record-101').scrolled,true);
context.openAdminTodo(3);assert.equal(node('btn-settle').scrolled,true);
context.currentUser.is_admin=false;context.page='clock';context.openAdminTodo(2);assert.equal(context.page,'clock');
console.log('Project warnings, navigation/prefill, admin guard PASS; no database writes or automatic settlement.');

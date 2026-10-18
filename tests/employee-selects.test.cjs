const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const overtime = fs.readFileSync(path.join(__dirname, '..', 'overtime.js'), 'utf8');
const data = [
    {type:'employee',employee_name:'在職甲',employee_code:'A01',active:true},
    {type:'employee',employee_name:'舊資料在職乙',employee_code:'A02'},
    {type:'employee',employee_name:'已離職丙',active:false},
    {type:'employee',employee_name:'停薪丁',active:true,employment_status:'unpaid_leave'},
    ...['在職甲','已離職丙','停薪丁','已刪除戊'].map(employee_name=>({type:'daily_rating',employee_name})),
    {type:'clock',employee_name:'已離職丙'},
    {type:'payout_history',details:[{name:'已離職丙',pay:1600}]}
];
const original = JSON.stringify(data);
const ctx = vm.createContext({allData:data,esc:s=>String(s??'')});
vm.runInContext(html.match(/function isEmployeeAvailable\(emp\) \{[\s\S]*?\n        \}/)[0],ctx);
const employeesExpr = "allData.filter(r=>r.type==='employee'&&isEmployeeAvailable(r))";
vm.runInContext('var employees='+employeesExpr+'; var emps=employees;',ctx);
function check(label, expression, allowed=['在職甲','舊資料在職乙']) {
    const result=vm.runInContext(expression,ctx);
    for(const name of allowed) assert.ok(result.includes(name),label+' missing '+name);
    for(const name of ['已離職丙','停薪丁','已刪除戊']) assert.ok(!result.includes(name),label+' includes '+name);
    console.log(label+': PASS');
}
check('加班費',overtime.match(/select.innerHTML = (.*);/)[1]);
check('薪資條',html.match(/select.innerHTML=(allData.filter\(r=>r.type==='employee'.*);/)[1]);
const reimbLine=html.split('\n').find(l=>l.includes('const employeeGroup='));
const reimbEmployees=reimbLine.match(/const employees=(.*?);employeeSelect/)[1];
vm.runInContext('employees='+reimbEmployees,ctx);
check('代墊員工',reimbLine.match(/employeeSelect.innerHTML=(.*?);if\(employees/)[1]);
const historyLine=html.split('\n').find(l=>l.includes('const empNames='));
vm.runInContext('var empNames='+historyLine.match(/const empNames=(.*?);historyFilter/)[1],ctx);
check('日常評分歷史',historyLine.match(/historyFilter.innerHTML=(.*?);if\(empNames/)[1],['在職甲']);
for(const id of ['dispatch-emp-select','admin-clock-emp']) {
    const expression=html.split('\n').find(l=>l.includes("getElementById('"+id+"').innerHTML =")).split('.innerHTML = ')[1].replace(/;\s*$/,'');
    check(id,expression);
}
// Filtering options must never remove former employees or their historical data.
assert.equal(JSON.stringify(data),original);
// Restoring employment makes the same employee eligible again.
data.find(e=>e.employee_name==='停薪丁').employment_status='active';
assert.equal(vm.runInContext("isEmployeeAvailable(allData.find(e=>e.employee_name==='停薪丁'))",ctx),true);
// No eligible employees is a valid empty list, not a fallback to former staff.
data.filter(e=>e.type==='employee').forEach(e=>e.active=false);
assert.equal(vm.runInContext(employeesExpr+'.length',ctx),0);
console.log('Historical data unchanged; reinstatement and empty-list cases PASS.');

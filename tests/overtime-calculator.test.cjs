process.env.TZ='Asia/Taipei';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const nodes={},get=id=>nodes[id]??={value:'',checked:false,disabled:false,textContent:'',classList:{add(){},remove(){}},scrollIntoView(){}};
let saves=[],messages=[],allowConfirm=true,settled=false;
const ctx=vm.createContext({Date,document:{getElementById:get},currentUser:{is_admin:true,employee_name:'管理員'},allData:[{type:'employee',employee_name:'測試員工',wage:1600}],
    alert:m=>messages.push(m),confirm:()=>allowConfirm,loadData:async()=>{},insertData:async(t,d)=>{saves.push({t,d});return true;},
    isEmployeeAvailable:e=>!!e&&e.active!==false,localDateKey:d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`,
    getWeekRange:()=>({startStr:'2026/10/12',endStr:'2026/10/18'}),payrollDateKey:s=>s.replaceAll('/','-'),payrollPeriodSettled:()=>settled,
    getEmployeeWageAtDate:e=>e.wage,attendanceGroups:()=>({'測試員工|2026-10-16':{start:new Date('2026-10-16T08:00:00+08:00').getTime(),end:new Date('2026-10-16T17:30:00+08:00').getTime()}})});
const root=path.join(__dirname,'..');
vm.runInContext(fs.readFileSync(path.join(root,'overtime-calculator.js'),'utf8'),ctx);
vm.runInContext(fs.readFileSync(path.join(root,'overtime.js'),'utf8'),ctx);
const base={start:'2026-10-16T08:00:00',end:'2026-10-16T17:30:00',breakMinutes:60,hourlyRate:200,dayType:'ordinary'};
for(const [end,rate,amount] of [['17:00:00',200,0],['17:30:00',200,134],['18:00:00',200,267],['19:00:00',200,534],['19:30:00',200,700],['19:30:00',262.5,919],['21:00:00',200,1200]]){
    assert.equal(ctx.calculateOrdinaryOvertime({...base,end:'2026-10-16T'+end,hourlyRate:rate}).amount,amount);
}
assert.equal(ctx.calculateOrdinaryOvertime({...base,start:'2026-10-16T22:00:00',end:'2026-10-17T08:00:00'}).amount,267);
for(const invalid of [{dayType:''},{dayType:'rest'},{dayType:'holiday'},{dayType:'regular_rest'},{end:'2026-10-16T07:00:00'},{end:'2026-10-16T22:00:00'},{start:''},{hourlyRate:0},{hourlyRate:'NaN'},{breakMinutes:-1},{breakMinutes:0.5},{breakMinutes:600}])assert.throws(()=>ctx.calculateOrdinaryOvertime({...base,...invalid}));
console.log('Ordinary day formulas, rounding, 0/2/4h boundaries, night shift, invalid inputs and unsupported day types PASS');
async function prepare(){
    get('overtime-employee').value='測試員工';get('overtime-date').value='2026-10-16';
    await ctx.openOvertimeCalculator();
    assert.equal(get('ot-calc-day').value,'');
    assert.equal(get('ot-calc-rate').value,200);assert.equal(get('ot-calc-start').value,'2026-10-16T08:00:00');
    get('ot-calc-day').value='ordinary';get('ot-calc-confirm').checked=true;ctx.updateOvertimeCalculation();assert.equal(get('ot-calc-apply').disabled,false);
    ctx.applyOvertimeCalculation();assert.equal(get('overtime-amount').value,134);
}
(async()=>{
    await prepare();assert.equal(saves.length,0); // applying never persists
    allowConfirm=false;await ctx.saveOvertime();assert.equal(saves.length,0);
    allowConfirm=true;await ctx.saveOvertime();assert.equal(saves.length,1);assert.equal(saves[0].d.amount,134);assert.equal(saves[0].d.calculation.suggested_amount,134);
    assert.equal(get('overtime-amount').value,'');
    await prepare();ctx.allData[0].wage=1700;await ctx.saveOvertime();assert.equal(saves.length,1);assert.ok(messages.at(-1).includes('已變更'));ctx.allData[0].wage=1600;
    await prepare();get('overtime-amount').value=150;await ctx.saveOvertime();assert.equal(saves.length,2);assert.equal(saves[1].d.amount,150);assert.equal(saves[1].d.calculation.suggested_amount,134);
    await prepare();settled=true;await ctx.saveOvertime();assert.equal(saves.length,2);settled=false;
    ctx.clearAppliedOvertimeEstimate();get('overtime-amount').value=500;await ctx.saveOvertime();assert.equal(saves.length,3);assert.equal(saves[2].d.calculation,undefined);
    await prepare();ctx.allData[0].active=false;await ctx.saveOvertime();assert.equal(saves.length,3);
    console.log('Prefill, explicit approval, no write on apply/cancel, manual override, stale wages, settlement and active staff guards PASS (mocked database).');
})().catch(e=>{console.error(e);process.exitCode=1;});

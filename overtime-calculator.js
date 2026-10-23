// Assistance only: ordinary workdays, 8 normal hours, no automatic payroll writes.
let overtimeEstimate=null, overtimeAppliedEstimate=null, overtimeCalculatorLoading=false;
function calculateOrdinaryOvertime({start,end,breakMinutes,hourlyRate,dayType}) {
    if(dayType!=='ordinary')throw new Error('請確認工作日類型。休息日、國定假日、例假及特殊工時須另行人工核算，不套用一般工作日公式。');
    const from=new Date(start).getTime(),to=new Date(end).getTime();
    if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from||to-from>24*36e5)throw new Error('請填正確的開始／結束日期時間，結束須晚於開始，且跨度不得超過24小時。');
    if(breakMinutes===''||!Number.isFinite(Number(breakMinutes))||Number(breakMinutes)<0||!Number.isInteger(Number(breakMinutes)))throw new Error('休息時間請填0以上的整數分鐘。');
    if(hourlyRate===''||!Number.isFinite(Number(hourlyRate))||Number(hourlyRate)<=0||Number(hourlyRate)>1000000)throw new Error('請填有效的平日每小時工資額。');
    const workMs=to-from-Number(breakMinutes)*60000;
    if(workMs<=0)throw new Error('扣除休息後的實際工作時間必須大於0。');
    if(workMs>12*36e5)throw new Error('淨工時超過12小時，超出本試算適用範圍，請先核對時間並人工確認適用規定。');
    const overtimeMs=Math.max(0,workMs-8*36e5),firstMs=Math.min(overtimeMs,2*36e5),secondMs=Math.max(0,overtimeMs-firstMs);
    // Integer micro-dollar arithmetic: exact 4/3 and 5/3, round up once at the end.
    const rateMicro=BigInt(Math.round(Number(hourlyRate)*1e6));
    const numerator=rateMicro*(BigInt(firstMs)*4n+BigInt(secondMs)*5n),denominator=10800000000000n;
    const amount=Number((numerator+denominator-1n)/denominator);
    return {workHours:workMs/36e5,overtimeHours:overtimeMs/36e5,firstHours:firstMs/36e5,secondHours:secondMs/36e5,hourlyRate:Number(hourlyRate),amount};
}
function overtimeCalculatorSource(name,date) {
    const emp=allData.find(e=>e.type==='employee'&&e.employee_name===name);
    if(!emp||!isEmployeeAvailable(emp))throw new Error('請選擇在職員工。');
    const range=getWeekRange(new Date(date+'T00:00:00'));
    const groups=Object.entries(attendanceGroups(range,name)).filter(([key])=>key.split('|')[1]===date).map(([key,g])=>({key,start:g.start,end:g.end}));
    return {name,date,wage:getEmployeeWageAtDate(emp,new Date(date+'T00:00:00')),groups};
}
function overtimeLocalInput(timestamp) {
    if(!timestamp)return '';
    const d=new Date(timestamp);d.setMinutes(d.getMinutes()-d.getTimezoneOffset());return d.toISOString().slice(0,19);
}
async function openOvertimeCalculator() {
    if(!currentUser?.is_admin||overtimeCalculatorLoading)return;
    const name=document.getElementById('overtime-employee').value,date=document.getElementById('overtime-date').value;
    if(!name||!/^\d{4}-\d{2}-\d{2}$/.test(date))return alert('請先選擇員工與加班日期。');
    overtimeCalculatorLoading=true;
    try {
        await loadData();
        if(!currentUser?.is_admin)return;
        if(overtimeLocked(date))throw new Error('此週期已結算，不能新增試算加班費。');
        const source=overtimeCalculatorSource(name,date);
        overtimeEstimate={source,sourceKey:JSON.stringify(source)};
        document.getElementById('ot-calc-label').textContent=name+'｜'+date+'｜當日日薪 $'+source.wage.toLocaleString();
        const group=source.groups.length===1?source.groups[0]:null;
        document.getElementById('ot-calc-start').value=overtimeLocalInput(group?.start);
        document.getElementById('ot-calc-end').value=overtimeLocalInput(group?.end);
        document.getElementById('ot-calc-rate').value=source.wage>0?source.wage/8:'';
        document.getElementById('ot-calc-break').value=group?.start&&group?.end?(group.end-group.start>5*36e5?60:0):60;
        document.getElementById('ot-calc-day').value='';
        document.getElementById('ot-calc-confirm').checked=false;
        const warnings=[];
        if(!group?.start||!group?.end)warnings.push('打卡不完整或同日多班：請人工確認時間；試算不會修補原始打卡，基本薪資仍依原出勤資料。');
        if(allData.some(r=>r.type==='overtime_pay'&&r.employee_name===name&&r.date===date))warnings.push('當日已有加班費。建議值是全日加班費，不是差額，請勿重複新增。');
        document.getElementById('ot-calc-warning').textContent=warnings.join(' ');
        document.getElementById('ot-calc-modal').classList.remove('hidden');
        updateOvertimeCalculation();
    }catch(e){alert(e.message);}finally{overtimeCalculatorLoading=false;}
}
function readOvertimeCalculator() {
    const read=id=>document.getElementById(id).value;
    return {start:read('ot-calc-start'),end:read('ot-calc-end'),breakMinutes:read('ot-calc-break'),hourlyRate:read('ot-calc-rate'),dayType:read('ot-calc-day')};
}
function updateOvertimeCalculation() {
    const output=document.getElementById('ot-calc-result'),button=document.getElementById('ot-calc-apply');button.disabled=true;
    try {
        const result=calculateOrdinaryOvertime(readOvertimeCalculator());
        output.textContent=`淨工時 ${result.workHours.toFixed(3)} 小時｜加班 ${result.overtimeHours.toFixed(3)} 小時\n前2小時：${result.firstHours.toFixed(3)}h × $${result.hourlyRate} × 4/3\n後2小時：${result.secondHours.toFixed(3)}h × $${result.hourlyRate} × 5/3\n建議加班費：$${result.amount.toLocaleString()}（合計後不足1元向上取整）`;
        button.disabled=result.amount<=0||!document.getElementById('ot-calc-confirm').checked;
    }catch(e){output.textContent=e.message;}
}
function applyOvertimeCalculation() {
    if(!currentUser?.is_admin||!overtimeEstimate)return;
    try {
        if(!document.getElementById('ot-calc-confirm').checked)throw new Error('請先核對工作日類型、實際工作時間、休息及時薪。');
        const inputs=readOvertimeCalculator(),result=calculateOrdinaryOvertime(inputs),source=overtimeEstimate.source;
        if(result.amount<=0)throw new Error('本次沒有可帶入的加班費。');
        if(localDateKey(new Date(inputs.start))!==source.date)throw new Error('開始日期須與所選加班日期相同；跨夜結束請選隔日。');
        if(overtimeLocked(source.date))throw new Error('此週期已結算。');
        if(JSON.stringify(overtimeCalculatorSource(source.name,source.date))!==overtimeEstimate.sourceKey)throw new Error('打卡或日薪已變更，請關閉後重新開啟試算。');
        document.getElementById('overtime-employee').value=source.name;
        document.getElementById('overtime-date').value=source.date;
        document.getElementById('overtime-amount').value=result.amount;
        const note=`一般工作日試算：${inputs.start}～${inputs.end}，休息${inputs.breakMinutes}分鐘，時薪${result.hourlyRate}元，加班${result.overtimeHours.toFixed(3)}小時；前2h×4/3、後2h×5/3，建議${result.amount}元（向上取整）。`;
        document.getElementById('overtime-note').value=note;
        overtimeAppliedEstimate={sourceKey:overtimeEstimate.sourceKey,employee_name:source.name,date:source.date,inputs,result};
        closeOvertimeCalculator();
        document.getElementById('overtime-save').scrollIntoView({block:'center'});
        alert('已帶入建議金額，尚未儲存。請核對後按「確認登錄加班費」。');
    }catch(e){alert(e.message);}
}
function closeOvertimeCalculator(){document.getElementById('ot-calc-modal').classList.add('hidden');overtimeEstimate=null;}
function clearAppliedOvertimeEstimate() {
    if(overtimeAppliedEstimate){document.getElementById('overtime-amount').value='';document.getElementById('overtime-note').value='';}
    overtimeAppliedEstimate=null;
}
function validateAppliedOvertimeEstimate(name,date) {
    if(!overtimeAppliedEstimate)return null;
    const applied=overtimeAppliedEstimate;
    if(applied.employee_name!==name||applied.date!==date)throw new Error('試算的員工或日期不同，請重新試算。');
    if(applied.sourceKey!==JSON.stringify(overtimeCalculatorSource(name,date)))throw new Error('打卡或日薪已變更，請重新試算，不沿用舊建議金額。');
    return {method:'ordinary_workday_v1',inputs:applied.inputs,suggested_amount:applied.result.amount,historical_daily_wage:JSON.parse(applied.sourceKey).wage};
}

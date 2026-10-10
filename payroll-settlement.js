// Only an explicit new settlement writes expenses. Loading/rendering never backfills old data.
function payrollDateKey(value) {
    const match=String(value||'').match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
    return match?`${match[1]}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}`:'';
}
function payrollPeriodSettled(start,end) {
    return allData.some(r=>r.type==='payout_history'&&payrollDateKey(r.start_date)<=end&&payrollDateKey(r.end_date)>=start&&payrollDateKey(r.start_date));
}
function payrollCostAlreadyPosted(name,date) {
    return allData.some(r=>r.type==='payout_history'&&r.settlement_version===1&&
        payrollDateKey(r.start_date)<=date&&payrollDateKey(r.end_date)>=date&&r.details?.some(d=>d.name===name));
}
function isPostedPayrollRecord(record) {
    if(record?.settlement_version===1 && ['payout_history','proj_expense'].includes(record.type))return true;
    return record?.type==='proj_expense'&&!!record.reimbursement_id&&allData.some(r=>r.type==='payout_history'&&r.settlement_version===1&&
        (r.reimbursement_ids||[]).map(Number).includes(Number(record.reimbursement_id)));
}
function buildPayrollPreview(weekly) {
    const start=payrollDateKey(weekly.startDate),end=payrollDateKey(weekly.endDate);
    if(!start||!end||start>end)throw new Error('結算期間不正確');
    const monday=new Date(start+'T00:00:00'),nextMonday=new Date(end+'T00:00:00');nextMonday.setDate(nextMonday.getDate()+1);
    const range={monday,nextMonday},projects=allData.filter(r=>r.type==='project');
    const valid=new Set(projects.map(p=>Number(p.id)));
    const dispatches=allData.filter(d=>d.type==='dispatch'&&new Date(d.timestamp)>=monday&&new Date(d.timestamp)<nextMonday);
    const lines=[],reimbursements=[];
    const target=(name,date,nightId)=>{
        const daily=dispatches.filter(d=>getDispatchDate(d.timestamp)===date&&getDispatchWorkers(d).includes(name)&&
            (nightId===undefined?true:nightId===null?d.night_shift!==true:String(d.id)===nightId));
        const ids=[...new Set(daily.map(d=>Number(d.linked_project_id)||0))];
        return ids.length===1&&valid.has(ids[0])?ids[0]:0;
    };
    const add=(name,date,kind,amount,project_id)=>{
        if(!Number.isSafeInteger(amount)||amount<0)throw new Error(name+' 的薪資金額異常，請先核對出勤');
        if(amount)lines.push({employee_name:name,date,kind,amount,project_id:valid.has(project_id)?project_id:0});
    };
    weekly.details.forEach(detail=>{
        const emp=allData.find(e=>e.type==='employee'&&e.employee_name===detail.name);
        if(!emp)throw new Error('找不到員工：'+detail.name);
        Object.entries(attendanceGroups(range,detail.name)).forEach(([key,g])=>{
            if(!g.start||!g.end)return;
            const parts=key.split('|'),date=parts[1],nightId=parts[2]==='night'?parts[3]:null;
            const hrs=(g.end-g.start)/36e5,work=hrs>5?hrs-1:hrs,wage=getEmployeeWageAtDate(emp,new Date(g.start));
            const base=work>=6?wage:work>=1?Math.floor(wage/2):Math.floor(work*wage/8);
            const pid=target(detail.name,date,nightId);
            add(detail.name,date,'base_pay',base,pid);
            add(detail.name,date,'night_allowance',parseInt(g.nightAllowance)||0,pid);
        });
        dispatches.forEach(d=>(d.drivers||'').split(',').map(s=>s.trim()).filter(n=>n===detail.name).forEach(()=>
            add(detail.name,getDispatchDate(d.timestamp),'driver_allowance',DRIVER_ALLOWANCE,Number(d.linked_project_id))));
        overtimeRows(detail.name,range).forEach(r=>add(detail.name,r.date,'overtime_pay',Number(r.amount)||0,target(detail.name,r.date)));
        for(const kind of ['base_pay','night_allowance','driver_allowance','overtime_pay']) {
            const actual=lines.filter(l=>l.employee_name===detail.name&&l.kind===kind).reduce((s,l)=>s+l.amount,0);
            if(actual!==(Number(detail[kind])||0))throw new Error(detail.name+' 的薪資與分配明細不一致，請更新數據再試');
        }
    });
    (weekly.reimbursementIds||[]).forEach(id=>{
        const r=allData.find(x=>x.type==='reimbursement'&&Number(x.id)===Number(id));
        if(!r||r.status!=='approved')throw new Error('代墊狀態已變更，請重新結算');
        const existing=allData.filter(x=>x.type==='proj_expense'&&Number(x.reimbursement_id)===Number(id));
        if(existing.length>1)throw new Error('代墊 #'+id+' 已有多筆案件支出，請先核對重複資料');
        if(existing.length&&Number(existing[0].amount)!==Number(r.amount))throw new Error('代墊 #'+id+' 與既有案件支出金額不符');
        reimbursements.push({id:Number(id),employee_name:r.employee_name,amount:Number(r.amount),date:r.date,category:r.category,notes:r.notes,
            project_id:existing.length?Number(existing[0].project_id):Number(r.project_id)||0,existing_expense_id:existing[0]?.id||null});
    });
    weekly.details.forEach(d=>{
        const total=reimbursements.filter(r=>r.employee_name===d.name).reduce((s,r)=>s+r.amount,0);
        if(total!==(Number(d.reimbursement)||0))throw new Error(d.name+' 的代墊明細不一致');
    });
    const assignedTotal=lines.reduce((s,l)=>s+l.amount,0)+reimbursements.reduce((s,r)=>s+r.amount,0);
    if(assignedTotal!==Number(weekly.total))throw new Error('薪資總額與明細不一致，請先更新');
    return {start,end,weekly:JSON.parse(JSON.stringify(weekly)),lines,reimbursements};
}
let payrollPreview=null,payrollBusy=false;
const payrollKinds={base_pay:'基本工資',driver_allowance:'駕駛津貼',night_allowance:'夜班津貼',overtime_pay:'加班費'};
function payrollSelection(id,attributes,locked=false) {
    return `<select ${attributes} class="input-box mb-0 text-sm" ${locked?'disabled':''}><option value="">請選擇案件</option>${allData.filter(p=>p.type==='project').map(p=>`<option value="${Number(p.id)}" ${Number(id)===Number(p.id)?'selected':''}>${esc(p.project_name)}</option>`).join('')}</select>`;
}
async function settleSalary() {
    if(!currentUser?.is_admin||payrollBusy)return;
    payrollBusy=true;
    try {
        await loadData();
        if(!currentWeeklyData?.total)return alert('目前沒有可結算的金額');
        payrollPreview=buildPayrollPreview(currentWeeklyData);
        if(payrollPeriodSettled(payrollPreview.start,payrollPreview.end))return alert('這個期間已結算，不會重複建立支出');
        const box=document.getElementById('payroll-posting-rows');
        box.innerHTML=payrollPreview.lines.map((l,i)=>`<div class="p-3 bg-[#262626] rounded mb-2"><div class="text-sm mb-2">${esc(l.date)} ${esc(l.employee_name)}｜${payrollKinds[l.kind]} <b>$${l.amount.toLocaleString()}</b></div>${payrollSelection(l.project_id,`data-payroll-line="${i}"`)}</div>`).join('')+
            payrollPreview.reimbursements.map((r,i)=>`<div class="p-3 bg-teal-950 rounded mb-2"><div class="text-sm mb-2">${esc(r.date)} ${esc(r.employee_name)}｜代墊：${esc(r.category)} <b>$${r.amount.toLocaleString()}</b></div><div class="text-xs mb-2">${esc(r.notes||'')}｜${r.existing_expense_id?'已有案件支出：沿用，不重複新增':'尚無案件支出：本次補登'}</div>${payrollSelection(r.project_id,`data-payroll-reimbursement="${i}"`,!!r.existing_expense_id)}</div>`).join('');
        document.getElementById('payroll-posting-summary').textContent=`${payrollPreview.start} ～ ${payrollPreview.end}｜實發 $${currentWeeklyData.total.toLocaleString()}（含代墊）`;
        document.getElementById('payroll-posting-modal').classList.remove('hidden');
    } catch(e){alert(e.message);} finally{payrollBusy=false;}
}
function closePayrollPosting(){if(!payrollBusy){document.getElementById('payroll-posting-modal').classList.add('hidden');payrollPreview=null;}}
async function confirmPayrollPosting() {
    if(!currentUser?.is_admin||payrollBusy||!payrollPreview)return;
    const preview=payrollPreview;
    const lines=preview.lines.map((l,i)=>({...l,project_id:Number(document.querySelector(`[data-payroll-line="${i}"]`).value)}));
    const reimbursements=preview.reimbursements.map((r,i)=>({...r,project_id:Number(document.querySelector(`[data-payroll-reimbursement="${i}"]`).value)}));
    if([...lines,...reimbursements].some(l=>!l.project_id))return alert('請先替每一筆工資與代墊選擇對應案件');
    const pids=new Set(lines.map(l=>l.project_id));
    const manual=allData.filter(r=>r.type==='proj_expense'&&r.category==='薪資'&&!r.settlement_version&&pids.has(Number(r.project_id))&&r.date>=preview.start&&r.date<=preview.end);
    const warning=manual.length?`\n⚠ 同期案件已有 ${manual.length} 筆手動薪資支出，請先確認不是同筆工資；舊紀錄不會刪除。`:'';
    if(!confirm(`確認結算 $${preview.weekly.total.toLocaleString()} 並建立案件支出？\n舊結算不補登；這次結算後的金額固定保存。${warning}`))return;
    payrollBusy=true;document.getElementById('payroll-posting-save').disabled=true;
    try {
        await loadData();
        if(payrollPeriodSettled(preview.start,preview.end))throw new Error('期間已結算，未重複新增');
        if(payrollDateKey(currentWeeklyData.startDate)!==preview.start||payrollDateKey(currentWeeklyData.endDate)!==preview.end||
            JSON.stringify(buildPayrollPreview(currentWeeklyData))!==JSON.stringify(preview))throw new Error('資料或檢視週期已變更，請關閉後重新結算');
        const admin=getAdminCredentials();
        const response=await callDatabaseFunction('settle_payroll_with_expenses_v1',{
            p_admin_id:admin.id,p_admin_password:admin.password,
            p_payroll:{start_date:preview.start,end_date:preview.end,total_amount:preview.weekly.total,details:preview.weekly.details},
            p_lines:lines,p_reimbursements:reimbursements.map(r=>({id:r.id,project_id:r.project_id}))
        });
        if(!response?.ok)throw new Error('結算未完成');
        document.getElementById('payroll-posting-modal').classList.add('hidden');payrollPreview=null;
        await loadData();
        alert(response.already_settled?'這期已結算，不會再次新增支出':'結算完成：工資已加入案件支出；代墊沿用既有支出，缺少的已補登。');
    } catch(e){alert('結算未確認完成：'+e.message+'\n若網路中斷，請先更新數據確認結果再試；同一期不會重複建立。');}
    finally{payrollBusy=false;document.getElementById('payroll-posting-save').disabled=false;}
}

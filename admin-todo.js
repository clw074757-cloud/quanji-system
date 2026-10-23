// Read-only reminders: never create clocks, overtime, payments or project expenses.
let adminTodoActions = [];
function buildAdminTodos(now = new Date()) {
    const range = getWeekRange(currentViewDate);
    const start = localDateKey(range.monday), end = localDateKey(new Date(range.nextMonday.getTime()-1));
    const today = localDateKey(now);
    const settled = payrollPeriodSettled(start,end);
    const result = {start,end,missing:[],overtime:[],pending:[],unpaid:[],projects:[],projectError:'',settled};
    for (const emp of allData.filter(r=>r.type==='employee'&&isEmployeeAvailable(r))) {
        for (const [key,g] of Object.entries(attendanceGroups(range,emp.employee_name))) {
            const parts=key.split('|'),date=parts[1],night=parts[2]==='night';
            if (date>today || (g.start && g.start>now.getTime())) continue;
            if (g.start && !g.end) {
                // Today's day shift and a night shift still inside its 16h window are not missing yet.
                if ((!night && date<today) || (night && now.getTime()-g.start>16*36e5))
                    result.missing.push({name:emp.employee_name,date,night,settled,kind:'clock'});
                continue;
            }
            if (!g.start || !g.end || g.end>now.getTime() || g.end<=g.start || settled) continue;
            const hours=(g.end-g.start)/36e5, work=hours>5?hours-1:hours;
            if (work<=8) continue;
            const recorded=allData.some(r=>r.type==='overtime_pay'&&r.employee_name===emp.employee_name&&r.date===date);
            if (!recorded) result.overtime.push({name:emp.employee_name,date,minutes:Math.ceil((work-8)*60),kind:'overtime'});
        }
    }
    for (const r of allData.filter(r=>r.type==='reimbursement')) {
        if (!['pending','approved'].includes(r.status)) continue;
        const item={id:r.id,name:r.employee_name,date:r.date||'',amount:Number(r.amount)||0,status:r.status,kind:'reimbursement'};
        result[r.status==='pending'?'pending':'unpaid'].push(item);
    }
    if (!settled && currentWeeklyData?.total>0) {
        try {
            const preview=buildPayrollPreview(currentWeeklyData);
            if(preview.start!==start || preview.end!==end)throw new Error('薪資週期尚未更新，請按更新數據');
            result.projects=[...preview.lines,...preview.reimbursements].filter(r=>!r.project_id).map(r=>({name:r.employee_name,date:r.date,amount:r.amount,component:r.kind?payrollKinds[r.kind]:'代墊',kind:'project'}));
        } catch(e) { result.projectError=e.message; }
    }
    for(const list of ['missing','overtime','pending','unpaid','projects'])result[list].sort((a,b)=>String(a.date).localeCompare(String(b.date))||String(a.name).localeCompare(String(b.name),'zh-TW'));
    return result;
}
function renderAdminTodos() {
    const root=document.getElementById('admin-todo-content');
    if(!root || !currentUser?.is_admin)return;
    const data=buildAdminTodos();adminTodoActions=[];
    document.getElementById('admin-todo-period').textContent=`${data.start} ～ ${data.end}｜出勤、加班與案件分配依此週期；代墊顯示全部未完成項目`;
    const card=(title,items,describe,empty)=>`<section class="card"><h3 class="text-lg font-black text-yellow-400 mb-3">${title} <span class="text-sm">${items.length} 筆</span></h3>${items.length?items.map(item=>{
        const index=adminTodoActions.push(item)-1;
        return `<div class="border-b border-gray-700 py-3"><div class="font-bold">${esc(item.name)} <span class="text-sm text-gray-400">${esc(item.date)}</span></div><p class="text-sm my-2">${describe(item)}</p><button type="button" onclick="openAdminTodo(${index})" class="bg-[#404040] border border-gray-600 rounded-lg px-4 py-2 font-bold">${item.settled?'查看出勤（已結算）':'前往處理'}</button></div>`;
    }).join(''):`<p class="text-sm text-gray-400">${empty}</p>`}</section>`;
    root.innerHTML=card('⏰ 缺下班卡',data.missing,r=>`${r.night?'夜班已超過16小時仍缺下班卡':'已有上班卡，尚未找到下班卡'}${r.settled?'；此期已結算，請先核對，勿直接補登。':''}`,'此週期未發現缺下班卡。今日尚在上班及未滿16小時的夜班不列入。')+
        card('⏱ 超時・待核對加班費',data.overtime,r=>`扣午休後超過8小時約 ${r.minutes} 分鐘，尚無加班費紀錄。僅提醒，須確認實際工時及工作日類型。`,'此週期沒有未登錄加班費的超時提醒（已結算週期不重列）。')+
        card('🧾 待核准代墊',data.pending,r=>`$${r.amount.toLocaleString()}｜開啟待審核清單`,'沒有待核准代墊。')+
        card('💸 待付款代墊',data.unpaid,r=>`$${r.amount.toLocaleString()}｜核准不代表已付款，請確認實際付款狀態`,'沒有待付款代墊。')+
        card('📁 結算前待指定案件',data.projects,r=>`${esc(r.component)} $${r.amount.toLocaleString()}｜沒有唯一可自動帶入的案件，需在結算預覽選擇`,'此週期未發現待指定案件的項目。')+
        (data.projectError?`<div class="card border-yellow-500">案件分配檢查未完成：${esc(data.projectError)}。請先至薪資頁核對，不能視為已全部確認。</div>`:'');
}
function openAdminTodo(index) {
    if(!currentUser?.is_admin)return;
    const item=adminTodoActions[index];if(!item)return;
    if(item.kind==='reimbursement') {
        document.getElementById('reimbursement-status-filter').value=item.status;
        nav('reimbursement');
        const row=document.getElementById('reimbursement-record-'+item.id);
        if(row)row.scrollIntoView({block:'center',behavior:'smooth'});
        return;
    }
    nav('admin');switchAdminSection(item.kind==='clock'?'attendance':'salary');
    if(item.kind==='clock') {
        if(item.settled){document.getElementById('admin-clock-list').scrollIntoView({block:'start'});return;}
        document.getElementById('admin-clock-emp').value=item.name;
        document.getElementById('admin-clock-type').value='下班';
        // Do not guess an actual end time. Keep the date visible while the administrator enters it.
        document.getElementById('admin-clock-time').value='';
        document.getElementById('admin-clock-todo-hint').textContent=`待補：${item.name} ${item.date}${item.night?' 夜班（下班日期可能為隔日）':''}，請填實際下班日期與時間。`;
        document.getElementById('admin-clock-time').focus();
    } else if(item.kind==='overtime') {
        document.getElementById('overtime-employee').value=item.name;
        document.getElementById('overtime-date').value=item.date;
        document.getElementById('overtime-amount').value='';
        document.getElementById('overtime-note').value='待核對：打卡淨工時超過8小時約'+item.minutes+'分鐘';
        document.getElementById('overtime-amount').scrollIntoView({block:'center'});
        document.getElementById('overtime-amount').focus();
    } else document.getElementById('btn-settle').scrollIntoView({block:'center'});
}

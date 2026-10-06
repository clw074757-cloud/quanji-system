// Manual overtime amounts are entered by administrators, never inferred from clocks.
function overtimeRows(name, range) {
    return allData.filter(r => r.type === 'overtime_pay' && (!name || r.employee_name === name))
        .filter(r => { const d = new Date(r.date + 'T00:00:00'); return d >= range.monday && d < range.nextMonday; })
        .sort((a,b) => a.date.localeCompare(b.date) || Number(a.id)-Number(b.id));
}
function overtimeTotal(name, range) {
    return overtimeRows(name, range).reduce((sum,r) => sum + (Number(r.amount)||0), 0);
}
function overtimeLocked(date) {
    const week = getWeekRange(new Date(date + 'T00:00:00'));
    return allData.some(r => r.type === 'payout_history' && r.start_date === week.startStr);
}
function renderOvertime() {
    if (!currentUser?.is_admin) return;
    const select = document.getElementById('overtime-employee');
    const previous = select.value;
    select.innerHTML = allData.filter(r=>r.type==='employee').map(e=>'<option value="'+esc(e.employee_name)+'">'+esc(e.employee_name)+(e.active===false?'（已離職）':'')+'</option>').join('');
    if ([...select.options].some(o=>o.value===previous)) select.value=previous;
    const date = document.getElementById('overtime-date');
    if (!date.value) date.value=localDateKey(new Date());
    const rows = overtimeRows(null, getWeekRange(currentViewDate));
    document.getElementById('overtime-list').innerHTML=rows.map(r=>'<div class="p-3 bg-[#262626] rounded mb-2"><div class="flex justify-between gap-2"><div>'+esc(r.date)+' '+esc(r.employee_name)+' <b class="text-yellow-400">$'+Number(r.amount).toLocaleString()+'</b></div>'+(overtimeLocked(r.date)?'<span>已結算</span>':'<button class="text-red-400" onclick="removeOvertime('+Number(r.id)+')">刪除</button>')+'</div><div class="text-sm text-gray-400">'+esc(r.notes||'')+'</div></div>').join('')||'<p class="text-gray-500">目前檢視週期無加班費紀錄</p>';
}
let overtimeSaving=false;
async function saveOvertime() {
    if (!currentUser?.is_admin || overtimeSaving) return;
    const employee_name=document.getElementById('overtime-employee').value;
    const date=document.getElementById('overtime-date').value;
    const amount=Number(document.getElementById('overtime-amount').value);
    const notes=document.getElementById('overtime-note').value.trim();
    if (!allData.some(r=>r.type==='employee'&&r.employee_name===employee_name)||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isSafeInteger(amount)||amount<=0) return alert('請選擇員工、日期，並輸入大於0的整數金額');
    overtimeSaving=true;
    const button=document.getElementById('overtime-save');button.disabled=true;
    try {
        await loadData();
        if (overtimeLocked(date)) return alert('該週已結算，不能直接追加加班費。請先核對原結算紀錄。');
        if (allData.some(r=>r.type==='overtime_pay'&&r.employee_name===employee_name&&r.date===date) && !confirm('這位員工當天已有加班費，確定另外新增一筆？')) return;
        if (!await insertData('overtime_pay',{employee_name,date,amount,notes,entered_by:currentUser.employee_name,timestamp:new Date().toISOString()})) throw new Error('加班費儲存失敗');
        document.getElementById('overtime-amount').value='';document.getElementById('overtime-note').value='';
        await loadData();alert('加班費已加入該日期所屬週的薪資');
    } catch(e) { alert(e.message); }
    finally { overtimeSaving=false;button.disabled=false; }
}
async function removeOvertime(id) {
    if (!currentUser?.is_admin || !confirm('確定刪除此筆加班費？')) return;
    try {
        await loadData();
        const r=allData.find(r=>r.id===id&&r.type==='overtime_pay');
        if (!r) return;
        if (overtimeLocked(r.date)) return alert('已結算的加班費不可刪除');
        if (!await deleteDataAPI(id)) throw new Error('刪除失敗');
        await loadData();
    } catch(e) { alert(e.message); }
}
function overtimeSlipHtml(name,range) {
    const rows=overtimeRows(name,range);
    return '<h4 class="font-black text-yellow-400 mb-2">加班費明細（管理員登錄）</h4><table class="w-full text-xs"><thead><tr><th>日期</th><th>備註</th><th>金額</th></tr></thead><tbody>'+ (rows.map(r=>'<tr><td>'+esc(r.date)+'</td><td>'+esc(r.notes||'')+'</td><td>$'+Number(r.amount).toLocaleString()+'</td></tr>').join('')||'<tr><td colspan="3">本期無加班費</td></tr>')+'</tbody></table><p class="my-4">加班費合計：$'+overtimeTotal(name,range).toLocaleString()+'</p>';
}

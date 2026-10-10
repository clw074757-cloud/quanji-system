// Derived costs only: never insert expense rows or alter customer billing records.
function splitProjectCost(amount, projectIds) {
    const ids = [...new Set(projectIds)].sort((a,b)=>a-b);
    if (!ids.length) ids.push(0); // 0 is explicitly unassigned, not a guessed project.
    const total = Math.max(0, Math.round(Number(amount)||0));
    const base = Math.floor(total / ids.length), remainder = total % ids.length;
    return ids.map((id,index)=>({id,amount:base+(index<remainder?1:0)}));
}

function buildProjectLaborCostMap(projects) {
    const validIds = new Set(projects.map(p=>Number(p.id)));
    const projectId = d => validIds.has(Number(d?.linked_project_id)) ? Number(d.linked_project_id) : 0;
    const dispatches = allData.filter(r=>r.type==='dispatch').sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp)||a.id-b.id);
    const employees = new Map(allData.filter(r=>r.type==='employee').map(e=>[e.employee_name,e]));
    const names = new Set(employees.keys());
    const assignments = new Map(), result = {}, index = new Map();
    dispatches.forEach(d=>getDispatchWorkers(d).forEach(name=>{
        names.add(name);
        const key = JSON.stringify([name,getDispatchDate(d.timestamp)]);
        if (!assignments.has(key)) assignments.set(key,[]);
        assignments.get(key).push(d);
    }));
    allData.filter(r=>r.type==='clock'||r.type==='overtime_pay').forEach(r=>names.add(r.employee_name));
    const ensure = (id,date,name) => {
        const key = JSON.stringify([id,date,name]);
        if (!index.has(key)) {
            const emp = employees.get(name);
            const entry = {date,name,wage:emp?getEmployeeWageAtDate(emp,new Date(date+'T12:00:00')):0,
                hours:null,dayCount:0,basePay:0,allowance:0,nightAllowance:0,overtimePay:0,
                driverCount:0,total:0,complete:false,missingWage:!emp,shared:false};
            index.set(key,entry);
            if (!result[id]) result[id]={total:0,entries:[]};
            result[id].entries.push(entry);
        }
        return index.get(key);
    };
    const targets = (name,date,nightId=null) => {
        const daily = assignments.get(JSON.stringify([name,date]))||[];
        const relevant = nightId===null ? daily.filter(d=>d.night_shift!==true) : daily.filter(d=>String(d.id)===nightId);
        return [...new Set(relevant.map(projectId))];
    };
    // Use the same attendance pairing as payroll, including cross-midnight night shifts.
    const times = allData.filter(r=>r.type==='clock'||r.type==='dispatch').map(r=>new Date(r.timestamp).getTime()).filter(Number.isFinite);
    if (times.length) {
        const monday = new Date(Math.min(...times)); monday.setHours(0,0,0,0);
        const nextMonday = new Date(Math.max(...times)); nextMonday.setHours(0,0,0,0); nextMonday.setDate(nextMonday.getDate()+1);
        names.forEach(name=>{
            Object.entries(attendanceGroups({monday,nextMonday},name)).forEach(([key,group])=>{
                const parts=key.split('|'), date=parts[1], nightId=parts[2]==='night'?parts[3]:null;
                const ids=targets(name,date,nightId);
                const emp=employees.get(name);
                const complete=!!(group.start&&group.end&&group.end>group.start);
                const wage=emp?getEmployeeWageAtDate(emp,new Date(group.start||date+'T12:00:00')):0;
                const elapsed=complete?(group.end-group.start)/36e5:0;
                const hours=complete?Math.max(0,elapsed>5?elapsed-1:elapsed):0;
                const days=hours>=6?1:hours>=1?0.5:parseFloat((hours/8).toFixed(1));
                const pay=hours>=6?wage:hours>=1?Math.floor(wage/2):Math.floor(hours*wage/8);
                const shares=splitProjectCost(pay,ids), nightShares=splitProjectCost(complete?group.nightAllowance:0,ids);
                shares.forEach((share,i)=>{
                    const entry=ensure(share.id,date,name);
                    entry.wage=wage;
                    entry.basePay+=share.amount;
                    entry.nightAllowance+=nightShares[i].amount;
                    entry.shared=entry.shared||shares.length>1;
                    entry.complete=entry.complete||complete;
                    if(complete){entry.hours=(entry.hours||0)+hours;entry.dayCount+=days;}
                });
            });
        });
    }
    // Driver allowance remains per dispatch, matching payroll rather than per project/day.
    dispatches.forEach(d=>{
        const date=getDispatchDate(d.timestamp), id=projectId(d);
        getDispatchWorkers(d).forEach(name=>ensure(id,date,name));
        (d.drivers||'').split(',').map(s=>s.trim()).filter(Boolean).forEach(name=>{
            const entry=ensure(id,date,name); entry.allowance+=DRIVER_ALLOWANCE; entry.driverCount++;
        });
    });
    allData.filter(r=>r.type==='overtime_pay').forEach(r=>{
        const daily=assignments.get(JSON.stringify([r.employee_name,r.date]))||[];
        const ids=[...new Set(daily.map(projectId))];
        splitProjectCost(r.amount,ids).forEach(share=>{
            const entry=ensure(share.id,r.date,r.employee_name);
            entry.overtimePay+=share.amount;entry.shared=entry.shared||ids.length>1;
        });
    });
    Object.values(result).forEach(project=>{
        project.entries.sort((a,b)=>b.date.localeCompare(a.date)||a.name.localeCompare(b.name,'zh-TW'));
        project.entries.forEach(e=>e.total=e.basePay+e.allowance+e.nightAllowance+e.overtimePay);
        project.total=project.entries.reduce((sum,e)=>sum+e.total,0);
    });
    const unassigned=result[0]||{total:0,entries:[]}; delete result[0];
    return {byProject:result,unassigned};
}

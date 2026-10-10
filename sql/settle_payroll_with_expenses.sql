-- Additive only: no backfill and no UPDATE/DELETE of existing business data.
create unique index if not exists payroll_settlement_v1_unique
on public.construction_records ((data->>'payroll_settlement_key'))
where type='payout_history' and data->>'settlement_version'='1';

create unique index if not exists payroll_expense_v1_unique
on public.construction_records ((data->>'payroll_settlement_key'), (data->>'project_id'))
where type='proj_expense' and data->>'settlement_version'='1' and data->>'category'='薪資';

create or replace function public.settle_payroll_with_expenses_v1(
    p_admin_id text, p_admin_password text, p_payroll jsonb, p_lines jsonb, p_reimbursements jsonb
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
    v_admin text; v_start date; v_end date; v_key text; v_id bigint; v_existing bigint;
    v_detail jsonb; v_line jsonb; v_reim jsonb; v_kind text; v_name text;
    v_total numeric:=0; v_reim_total numeric:=0; v_lines_total numeric:=0;
    v_actual numeric; v_expected numeric; v_amount numeric; v_project bigint;
    v_project_name text; v_count integer; v_expense_count integer:=0;
    v_record public.construction_records%rowtype; v_expense public.construction_records%rowtype;
    v_payload jsonb; v_now timestamptz:=now(); v_date text;
begin
    select data->>'employee_name' into v_admin from public.construction_records
    where type='employee' and (data->>'employee_id'=p_admin_id or data->>'employee_name'=p_admin_id or data->>'employee_code'=p_admin_id)
      and data->>'password'=p_admin_password and data->>'is_admin'='true' and coalesce(data->>'active','true')<>'false'
    limit 1;
    if v_admin is null then raise exception 'administrator verification failed'; end if;
    if jsonb_typeof(p_payroll->'details') is distinct from 'array' or jsonb_typeof(p_lines) is distinct from 'array'
       or jsonb_typeof(p_reimbursements) is distinct from 'array' then raise exception 'invalid payroll payload'; end if;
    v_start:=(p_payroll->>'start_date')::date; v_end:=(p_payroll->>'end_date')::date;
    if v_start is null or v_end is null or v_end<v_start or v_end-v_start>31 then raise exception 'invalid payroll dates'; end if;
    v_key:='payroll-v1:'||v_start::text||':'||v_end::text;
    v_date:=(v_now at time zone 'Asia/Taipei')::date::text;
    -- Serialize settlement across tabs/devices. Reimbursement changes share the transaction.
    perform pg_advisory_xact_lock(hashtext('quanji-payroll-settlement-v1'));
    select id into v_existing from public.construction_records
    where type='payout_history' and data->>'payroll_settlement_key'=v_key;
    if found then return jsonb_build_object('ok',true,'already_settled',true,'payout_id',v_existing); end if;
    if exists(select 1 from public.construction_records where type='payout_history'
       and replace(data->>'start_date','/','-')::date<=v_end and replace(data->>'end_date','/','-')::date>=v_start)
    then raise exception '此期間已有薪資結算，不能重複建立案件支出'; end if;
    if exists(select 1 from jsonb_array_elements(p_payroll->'details') d group by d->>'name' having count(*)>1)
       or exists(select 1 from jsonb_array_elements(p_reimbursements) r group by r->>'id' having count(*)>1)
    then raise exception 'duplicate employee or reimbursement'; end if;

    for v_detail in select value from jsonb_array_elements(p_payroll->'details') loop
        v_name:=v_detail->>'name'; v_actual:=0;
        if coalesce(v_name,'')='' then raise exception 'missing employee name'; end if;
        foreach v_kind in array array['base_pay','driver_allowance','night_allowance','overtime_pay','reimbursement'] loop
            v_amount:=coalesce((v_detail->>v_kind)::numeric,0);
            if v_amount<0 or v_amount<>trunc(v_amount) then raise exception 'invalid payroll amount'; end if;
            v_actual:=v_actual+v_amount;
            if v_kind<>'reimbursement' then
                select coalesce(sum((l->>'amount')::numeric),0) into v_expected from jsonb_array_elements(p_lines) l
                where l->>'employee_name'=v_name and l->>'kind'=v_kind;
                if v_expected<>v_amount then raise exception '薪資與案件分配不一致：%',v_name; end if;
            else v_reim_total:=v_reim_total+v_amount;
            end if;
        end loop;
        if v_actual is distinct from (v_detail->>'pay')::numeric then raise exception 'payroll detail sum mismatch'; end if;
        v_total:=v_total+v_actual;
    end loop;
    if v_total<=0 or v_total is distinct from (p_payroll->>'total_amount')::numeric then raise exception 'payroll total mismatch'; end if;
    for v_line in select value from jsonb_array_elements(p_lines) loop
        v_amount:=(v_line->>'amount')::numeric;v_project:=(v_line->>'project_id')::bigint;
        if v_amount is null or v_amount<=0 or v_amount<>trunc(v_amount)
           or (v_line->>'date') is null or (v_line->>'date')::date<v_start or (v_line->>'date')::date>v_end
           or coalesce(v_line->>'kind','') not in ('base_pay','driver_allowance','night_allowance','overtime_pay')
           or not exists(select 1 from jsonb_array_elements(p_payroll->'details') d where d->>'name'=v_line->>'employee_name')
           or not exists(select 1 from public.construction_records where id=v_project and type='project')
        then raise exception 'invalid payroll allocation'; end if;
        v_lines_total:=v_lines_total+v_amount;
    end loop;
    if v_lines_total+v_reim_total<>v_total then raise exception 'allocation total mismatch'; end if;

    -- Lock and validate reimbursement source records before writing anything.
    v_actual:=0;
    for v_reim in select value from jsonb_array_elements(p_reimbursements) loop
        select * into v_record from public.construction_records where type='reimbursement' and id=(v_reim->>'id')::bigint for update;
        if not found or v_record.data->>'status'<>'approved' then raise exception '代墊已付款或狀態已變更'; end if;
        if not exists(select 1 from public.construction_records where type='project' and id=(v_reim->>'project_id')::bigint)
        then raise exception '代墊尚未指定有效案件'; end if;
        v_actual:=v_actual+(v_record.data->>'amount')::numeric;
    end loop;
    if v_actual<>v_reim_total then raise exception 'reimbursement total mismatch'; end if;
    for v_detail in select value from jsonb_array_elements(p_payroll->'details') loop
        select coalesce(sum((r.data->>'amount')::numeric),0) into v_actual from public.construction_records r
        join jsonb_array_elements(p_reimbursements) j on r.id=(j->>'id')::bigint
        where r.type='reimbursement' and r.data->>'employee_name'=v_detail->>'name';
        if v_actual<>coalesce((v_detail->>'reimbursement')::numeric,0) then raise exception 'employee reimbursement mismatch'; end if;
    end loop;
    v_payload:=jsonb_build_object('start_date',to_char(v_start,'YYYY/MM/DD'),'end_date',to_char(v_end,'YYYY/MM/DD'),
        'total_amount',v_total,'details',p_payroll->'details','timestamp',v_now,'settled_by',v_admin,
        'settlement_version',1,'payroll_settlement_key',v_key,'project_cost_lines',p_lines,
        'reimbursement_ids',(select coalesce(jsonb_agg((r->>'id')::bigint),'[]'::jsonb) from jsonb_array_elements(p_reimbursements) r));
    insert into public.construction_records(type,data) values('payout_history',v_payload) returning id into v_id;
    for v_project in select distinct (l->>'project_id')::bigint from jsonb_array_elements(p_lines) l loop
        select data->>'project_name' into v_project_name from public.construction_records where id=v_project and type='project';
        select sum((l->>'amount')::numeric),jsonb_agg(l) into v_amount,v_line from jsonb_array_elements(p_lines) l where (l->>'project_id')::bigint=v_project;
        insert into public.construction_records(type,data) values('proj_expense',jsonb_build_object(
            'project_id',v_project,'project_name',v_project_name,'category','薪資','description','薪資結算 '||v_start||'～'||v_end,
            'amount',v_amount,'date',v_date,'notes','薪資結算自動建立（工資、駕駛／夜班津貼、加班費；代墊另列）',
            'timestamp',v_now,'settlement_version',1,'payroll_settlement_key',v_key,'payout_id',v_id,'payroll_lines',v_line));
        v_expense_count:=v_expense_count+1;
    end loop;
    for v_reim in select value from jsonb_array_elements(p_reimbursements) loop
        select * into v_record from public.construction_records where type='reimbursement' and id=(v_reim->>'id')::bigint;
        select count(*) into v_count from public.construction_records where type='proj_expense' and data->>'reimbursement_id'=v_record.id::text;
        if v_count>1 then raise exception '代墊已有重複支出，請先核對：%',v_record.id; end if;
        v_project:=(v_reim->>'project_id')::bigint;
        if v_count=1 then
            select * into v_expense from public.construction_records where type='proj_expense' and data->>'reimbursement_id'=v_record.id::text for update;
            if (v_expense.data->>'amount')::numeric is distinct from (v_record.data->>'amount')::numeric
               or (v_expense.data->>'project_id')::bigint is distinct from v_project
            then raise exception '代墊與既有支出不一致，未更動舊資料'; end if;
        else
            select data->>'project_name' into v_project_name from public.construction_records where id=v_project and type='project';
            insert into public.construction_records(type,data) values('proj_expense',jsonb_build_object(
                'project_id',v_project,'project_name',v_project_name,'category','員工代墊-'||coalesce(v_record.data->>'category','其他'),
                'description',(v_record.data->>'employee_name')||'代墊','amount',(v_record.data->>'amount')::numeric,
                'date',v_record.data->>'date','notes',v_record.data->>'notes','reimbursement_id',v_record.id,'timestamp',v_now,
                'settlement_version',1,'payroll_settlement_key',v_key,'payout_id',v_id));
            v_expense_count:=v_expense_count+1;
        end if;
        update public.construction_records set data=data||jsonb_build_object('status','paid','paid_date',v_date,'paid_at',v_now,
            'paid_by',v_admin,'payment_method','薪資併付','payout_start_date',to_char(v_start,'YYYY/MM/DD'),'payroll_settlement_key',v_key)
        where id=v_record.id;
    end loop;
    return jsonb_build_object('ok',true,'payout_id',v_id,'created_expenses',v_expense_count);
end;
$$;
revoke all on function public.settle_payroll_with_expenses_v1(text,text,jsonb,jsonb,jsonb) from public;
grant execute on function public.settle_payroll_with_expenses_v1(text,text,jsonb,jsonb,jsonb) to anon,authenticated;

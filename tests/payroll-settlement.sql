-- All fixtures and generated records are rolled back; never use real employees or money.
begin;
do $$ begin
    if exists(select 1 from public.construction_records where id between -8800100 and -8800000)
    then raise exception 'test ID collision'; end if;
end $$;
insert into public.construction_records(id,type,data) values
(-8800001,'employee','{"employee_name":"__payroll_test_admin__","employee_id":"__payroll_test_admin__","password":"temporary-rollback-fixture","is_admin":true}'),
(-8800002,'project','{"project_name":"__payroll_test_project__","project_type":"contract"}'),
(-8800003,'reimbursement','{"employee_name":"__payroll_test_employee__","amount":500,"category":"加油","date":"2090-01-03","project_id":-8800002,"status":"approved"}'),
(-8800004,'proj_expense','{"project_id":-8800002,"reimbursement_id":-8800003,"amount":500,"notes":"existing expense must remain unchanged"}'),
(-8800005,'reimbursement','{"employee_name":"__payroll_test_employee__","amount":300,"category":"停車費","date":"2090-01-03","status":"approved"}');
set local role anon;
do $$
declare
    p jsonb:='{"start_date":"2090-01-02","end_date":"2090-01-08","total_amount":3300,"details":[{"name":"__payroll_test_employee__","pay":3300,"base_pay":1600,"driver_allowance":200,"night_allowance":0,"overtime_pay":700,"reimbursement":800}]}';
    l jsonb:='[{"employee_name":"__payroll_test_employee__","date":"2090-01-03","kind":"base_pay","amount":1600,"project_id":-8800002},{"employee_name":"__payroll_test_employee__","date":"2090-01-03","kind":"driver_allowance","amount":200,"project_id":-8800002},{"employee_name":"__payroll_test_employee__","date":"2090-01-03","kind":"overtime_pay","amount":700,"project_id":-8800002}]';
    r jsonb:='[{"id":-8800003,"project_id":-8800002},{"id":-8800005,"project_id":-8800002}]';
    answer jsonb; before_count bigint; after_count bigint; expense_before jsonb; failed boolean:=false;
begin
    select count(*) into before_count from public.construction_records;
    select data into expense_before from public.construction_records where id=-8800004;
    begin
        perform public.settle_payroll_with_expenses_v1('not-a-real-admin','invalid',p,l,r);
    exception when others then
        if sqlerrm not like '%administrator verification failed%' then raise; end if;
        failed:=true;
    end;
    if not failed then raise exception 'unauthorized request accepted'; end if;
    answer:=public.settle_payroll_with_expenses_v1('__payroll_test_admin__','temporary-rollback-fixture',p,l,r);
    if answer->>'ok'<>'true' or (answer->>'created_expenses')::integer<>2 then raise exception 'wrong success result: %',answer; end if;
    select count(*) into after_count from public.construction_records;
    if after_count<>before_count+3 then raise exception 'must create one payroll and two expenses only'; end if;
    if (select data from public.construction_records where id=-8800004)<>expense_before then raise exception 'existing expense changed'; end if;
    if (select count(*) from public.construction_records where id in(-8800003,-8800005) and data->>'status'='paid')<>2 then raise exception 'reimbursements not paid'; end if;
    if (select (data->>'amount')::integer from public.construction_records where type='proj_expense' and data->>'payroll_settlement_key'='payroll-v1:2090-01-02:2090-01-08' and data->>'category'='薪資')<>2500 then raise exception 'wages include reimbursements twice'; end if;
    answer:=public.settle_payroll_with_expenses_v1('__payroll_test_admin__','temporary-rollback-fixture',p,l,r);
    if answer->>'already_settled'<>'true' or (select count(*) from public.construction_records)<>after_count then raise exception 'repeat request duplicated rows'; end if;

    -- Late reimbursement error must roll back the payout and wage expense inserted earlier in the function.
    update public.construction_records set data=jsonb_set(data,'{status}','"approved"') where id=-8800003;
    update public.construction_records set data=jsonb_set(data,'{amount}','499') where id=-8800004;
    p:='{"start_date":"2090-01-09","end_date":"2090-01-15","total_amount":2100,"details":[{"name":"__payroll_test_employee__","pay":2100,"base_pay":1600,"driver_allowance":0,"night_allowance":0,"overtime_pay":0,"reimbursement":500}]}';
    l:='[{"employee_name":"__payroll_test_employee__","date":"2090-01-10","kind":"base_pay","amount":1600,"project_id":-8800002}]';
    r:='[{"id":-8800003,"project_id":-8800002}]';
    failed:=false;
    begin
        perform public.settle_payroll_with_expenses_v1('__payroll_test_admin__','temporary-rollback-fixture',p,l,r);
    exception when others then
        if sqlerrm not like '%代墊與既有支出不一致%' then raise; end if;
        failed:=true;
    end;
    if not failed or (select count(*) from public.construction_records)<>after_count then raise exception 'partial settlement persisted'; end if;
    if (select data->>'status' from public.construction_records where id=-8800003)<>'approved' then raise exception 'failed settlement changed reimbursement'; end if;
end $$;
reset role;
select 'PASS: auth, atomic settlement, reimbursement reuse, retry idempotency, full rollback' as test_result;
rollback;

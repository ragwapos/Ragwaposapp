drop function if exists approve_branch_payment(uuid);
drop function if exists create_branch_for_tenant(uuid, text);

create or replace function create_branch(p_name text default null)
returns branches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := auth.uid();
  v_number integer;
  v_row branches;
begin
  if v_tenant is null or not exists (select 1 from tenants where id = v_tenant) then
    raise exception 'not_authorized';
  end if;
  perform 1 from tenants where id = v_tenant for update;
  perform ensure_main_branch(v_tenant);
  select coalesce(max(number), 0) + 1 into v_number from branches where tenant_id = v_tenant;
  insert into branches (tenant_id, number, name)
  values (v_tenant, v_number, coalesce(nullif(btrim(p_name), ''), 'فرع ' || v_number))
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function create_branch(text) from public, anon;
grant execute on function create_branch(text) to authenticated;

delete from payment_requests where plan = 'branch';
alter table payment_requests drop column if exists branch_name;
alter table payment_requests drop constraint if exists payment_requests_plan_check;
alter table payment_requests add constraint payment_requests_plan_check check (plan in ('annual'));

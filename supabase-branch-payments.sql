-- Extra branches are a paid add-on (200 SAR / year, pro-rated to the shop's
-- remaining subscription). The owner files a payment request with a bank
-- receipt (payment_requests, plan = 'branch'); the branch only comes into
-- existence when the platform admin approves it. Run on staging first.
--
-- IMPORTANT for production: code on `main` still calls create_branch() directly,
-- so apply this file together with the merge to main, never before.

alter table payment_requests drop constraint if exists payment_requests_plan_check;
alter table payment_requests add constraint payment_requests_plan_check check (plan in ('annual', 'branch'));
alter table payment_requests add column if not exists branch_name text not null default '';

-- Same numbering logic create_branch() had, minus the auth.uid() assumption.
-- Not granted to anyone: only approve_branch_payment() below calls it.
create or replace function create_branch_for_tenant(p_tenant uuid, p_name text)
returns branches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_number integer;
  v_row branches;
begin
  if p_tenant is null or not exists (select 1 from tenants where id = p_tenant) then
    raise exception 'not_authorized';
  end if;

  -- serialise concurrent adds for the same tenant
  perform 1 from tenants where id = p_tenant for update;
  perform ensure_main_branch(p_tenant);

  select coalesce(max(number), 0) + 1 into v_number from branches where tenant_id = p_tenant;
  insert into branches (tenant_id, number, name)
  values (p_tenant, v_number, coalesce(nullif(btrim(p_name), ''), 'فرع ' || v_number))
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function create_branch_for_tenant(uuid, text) from public, anon, authenticated;

-- The owner can no longer create branches by themselves.
drop function if exists create_branch(text);

create or replace function approve_branch_payment(p_request uuid)
returns branches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req payment_requests;
  v_row branches;
begin
  if not is_admin() then
    raise exception 'not_authorized';
  end if;

  select * into v_req from payment_requests where id = p_request for update;
  if not found or v_req.plan <> 'branch' or v_req.status <> 'pending' then
    raise exception 'invalid_request';
  end if;

  v_row := create_branch_for_tenant(v_req.user_id, v_req.branch_name);
  update payment_requests set status = 'approved', decided_at = now() where id = p_request;
  return v_row;
end;
$$;
revoke all on function approve_branch_payment(uuid) from public, anon;
grant execute on function approve_branch_payment(uuid) to authenticated;

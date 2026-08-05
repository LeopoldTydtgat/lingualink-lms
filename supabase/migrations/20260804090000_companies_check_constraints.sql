alter table companies
  add constraint companies_cancellation_policy_check
  check (cancellation_policy in ('24hr', '48hr'));

alter table companies
  add constraint companies_type_check
  check (type in ('b2b', 'enterprise', 'partner'));

alter table companies
  add constraint companies_status_check
  check (status in ('active', 'former'));

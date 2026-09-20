-- Run this once in your Supabase project's SQL Editor
-- (Dashboard → SQL Editor → New query → paste → Run)

create table if not exists leave_requests (
  request_id uuid primary key default gen_random_uuid(),
  employee text not null,
  cover_by text,
  cover_by_chat_id text,
  branch text not null,
  type text not null,
  from_fmt text,
  to_fmt text,
  date_from date,
  date_to date,
  day_count text,
  hours_requested numeric,
  reason text,
  contact text,
  slip_no text,
  employee_chat_id text,
  jen_message_id bigint,
  status text default 'pending',
  created_at timestamptz default now()
);

create index if not exists idx_leave_requests_jen_message_id on leave_requests (jen_message_id);
create index if not exists idx_leave_requests_status on leave_requests (status);

-- No RLS policies needed: the backend functions use the secret key,
-- which bypasses Row Level Security entirely. RLS stays off by default
-- for this table, which is fine since nothing public-facing reads it directly.

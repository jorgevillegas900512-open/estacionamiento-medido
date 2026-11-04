create table if not exists parking_sessions (
  id uuid primary key default gen_random_uuid(),
  plate text not null,
  driver_dni_hash text not null,
  entry_at timestamptz not null,
  temporary_until timestamptz,
  final_exit_at timestamptz,
  amount integer not null default 0,
  created_at timestamptz not null default now()
);

create unique index if not exists one_active_plate on parking_sessions (plate) where final_exit_at is null;

create table if not exists parking_audit (
  id uuid primary key default gen_random_uuid(),
  happened_at timestamptz not null default now(),
  operator_name text not null,
  action text not null,
  plate text not null,
  dni_last4 text,
  minutes integer,
  amount integer
);

alter table parking_sessions enable row level security;
alter table parking_audit enable row level security;

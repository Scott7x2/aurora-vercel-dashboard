create table if not exists feature_settings (
  bot_instance_id uuid primary key references bot_instances(id) on delete cascade,
  automations jsonb not null default '{}'::jsonb,
  protect jsonb not null default '{}'::jsonb,
  cloud jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists backup_snapshots (
  id bigserial primary key,
  bot_instance_id uuid not null references bot_instances(id) on delete cascade,
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table feature_settings enable row level security;
alter table backup_snapshots enable row level security;

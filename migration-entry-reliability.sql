create table if not exists member_welcome_deliveries (
  bot_instance_id uuid not null references bot_instances(id) on delete cascade,
  guild_id text not null,
  user_id text not null,
  welcomed_at timestamptz not null default now(),
  primary key (bot_instance_id, user_id)
);

alter table member_welcome_deliveries enable row level security;

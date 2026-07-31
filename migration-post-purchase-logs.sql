-- Aurora Zero - pos-compra, entrega, avaliacoes e logs

alter table bot_settings
  add column if not exists delivery_mode text not null default 'manual',
  add column if not exists delivery_title text not null default 'Compra aprovada',
  add column if not exists delivery_message text not null default 'Ola {user}, sua compra de {product} foi aprovada. O suporte enviara sua entrega em breve.',
  add column if not exists delivery_color text not null default '#58e39b',
  add column if not exists review_channel_id text,
  add column if not exists review_title text not null default 'Nova avaliacao',
  add column if not exists review_message text not null default '{user} avaliou {product} com {stars} estrelas.',
  add column if not exists review_color text not null default '#ffcc4d',
  add column if not exists review_gif_url text,
  add column if not exists log_channel_id text,
  add column if not exists stock_warn_threshold integer not null default 3;

alter table products
  add column if not exists stock integer,
  add column if not exists delivery_content text,
  add column if not exists low_stock_notified boolean not null default false;

alter table tickets
  add column if not exists purchase_status text not null default 'pending',
  add column if not exists approved_at timestamptz,
  add column if not exists rating integer,
  add column if not exists reviewed_at timestamptz;

create table if not exists bot_logs (
  id bigserial primary key,
  bot_instance_id uuid not null references bot_instances(id) on delete cascade,
  guild_id text,
  event_type text not null,
  actor_id text,
  target_id text,
  channel_id text,
  message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table bot_logs enable row level security;

select 'aurora-post-purchase-logs-ok' as status;

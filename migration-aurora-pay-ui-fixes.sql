-- Aurora Zero - Aurora Pay interno, organizacao de UI e fix de produtos

alter table payment_settings
  alter column provider set default 'aurora';

create table if not exists payment_orders (
  id uuid primary key default gen_random_uuid(),
  bot_instance_id uuid not null references bot_instances(id) on delete cascade,
  ticket_thread_id text,
  guild_id text not null,
  buyer_id text not null,
  product_id bigint references products(id) on delete set null,
  product_name text not null default 'Produto',
  product_variant jsonb,
  amount_text text not null default '',
  provider text not null default 'aurora',
  status text not null default 'pending',
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

alter table tickets
  add column if not exists payment_order_id uuid references payment_orders(id) on delete set null;

alter table payment_orders enable row level security;

select 'aurora-pay-ui-fixes-ok' as status;

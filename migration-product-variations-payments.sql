-- Aurora Zero - produtos com variacoes e configuracao segura de pagamento

alter table products
  add column if not exists product_type text not null default 'single',
  add column if not exists variations jsonb not null default '[]'::jsonb;

create table if not exists payment_settings (
  bot_instance_id uuid primary key references bot_instances(id) on delete cascade,
  provider text not null default 'manual',
  checkout_mode text not null default 'ticket',
  receiver_name text,
  public_instructions text,
  private_details_encrypted text,
  updated_at timestamptz not null default now()
);

alter table tickets
  add column if not exists product_variant jsonb;

alter table payment_settings enable row level security;

select 'aurora-product-variations-payments-ok' as status;

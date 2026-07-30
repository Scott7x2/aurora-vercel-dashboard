create extension if not exists pgcrypto;

create table if not exists dashboard_sessions (
  id text primary key,
  discord_id text not null,
  username text,
  avatar text,
  access_token text not null,
  refresh_token text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists bot_instances (
  id uuid primary key default gen_random_uuid(),
  owner_discord_id text not null,
  guild_id text not null,
  guild_name text not null default 'Servidor',
  bot_name text not null default 'Aurora Sales',
  token_encrypted text not null,
  enabled boolean not null default false,
  last_seen_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_discord_id, guild_id)
);

create table if not exists guild_resources (
  bot_instance_id uuid primary key references bot_instances(id) on delete cascade,
  channels jsonb not null default '[]'::jsonb,
  roles jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists bot_settings (
  bot_instance_id uuid primary key references bot_instances(id) on delete cascade,
  brand_name text not null default 'Aurora Store',
  brand_color text not null default '#5865f2',
  auto_role_id text,
  verified_role_id text,
  remove_auto_role_after_verify boolean not null default true,
  welcome_channel_id text,
  welcome_title text not null default 'Novo membro',
  welcome_message text not null default 'Bem-vindo, {user}, ao {server}!',
  auth_channel_id text,
  auth_title text not null default 'Autenticacao',
  auth_message text not null default 'Clique para verificar sua conta.',
  auth_button_label text not null default 'Verificar acesso',
  ticket_channel_id text,
  support_role_ids jsonb not null default '[]'::jsonb,
  ticket_title text not null default 'Atendimento',
  ticket_message text not null default 'Precisa de ajuda? Abra um ticket.',
  ticket_button_label text not null default 'Abrir ticket',
  sales_channel_id text,
  sales_title text not null default 'Vitrine',
  sales_message text not null default 'Escolha um produto para iniciar sua compra.',
  updated_at timestamptz not null default now()
);

create table if not exists products (
  id bigserial primary key,
  bot_instance_id uuid not null references bot_instances(id) on delete cascade,
  name text not null,
  price text not null,
  description text,
  image_url text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists tickets (
  thread_id text primary key,
  bot_instance_id uuid not null references bot_instances(id) on delete cascade,
  guild_id text not null,
  owner_id text not null,
  product_id bigint references products(id) on delete set null,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

alter table dashboard_sessions enable row level security;
alter table bot_instances enable row level security;
alter table guild_resources enable row level security;
alter table bot_settings enable row level security;
alter table products enable row level security;
alter table tickets enable row level security;

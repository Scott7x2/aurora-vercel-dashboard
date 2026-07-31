-- Aurora Zero: corrige bancos criados com versoes antigas do schema.
-- Seguro para rodar mais de uma vez. Nao apaga dados.

alter table bot_instances add column if not exists guild_name text not null default 'Servidor';
alter table bot_instances add column if not exists bot_name text not null default 'Aurora Sales';
alter table bot_instances add column if not exists bot_client_id text;
alter table bot_instances add column if not exists token_encrypted text;
alter table bot_instances add column if not exists enabled boolean not null default false;
alter table bot_instances add column if not exists last_seen_at timestamptz;
alter table bot_instances add column if not exists last_error text;
alter table bot_instances add column if not exists runtime_warning text;
alter table bot_instances add column if not exists created_at timestamptz not null default now();
alter table bot_instances add column if not exists updated_at timestamptz not null default now();

alter table guild_resources add column if not exists channels jsonb not null default '[]'::jsonb;
alter table guild_resources add column if not exists roles jsonb not null default '[]'::jsonb;
alter table guild_resources add column if not exists updated_at timestamptz not null default now();

alter table bot_settings add column if not exists brand_name text not null default 'Aurora Store';
alter table bot_settings add column if not exists brand_color text not null default '#5865f2';
alter table bot_settings add column if not exists auto_role_id text;
alter table bot_settings add column if not exists verified_role_id text;
alter table bot_settings add column if not exists remove_auto_role_after_verify boolean not null default true;
alter table bot_settings add column if not exists welcome_channel_id text;
alter table bot_settings add column if not exists welcome_mode text not null default 'embed';
alter table bot_settings add column if not exists welcome_color text not null default '#5865f2';
alter table bot_settings add column if not exists welcome_title text not null default 'Novo membro';
alter table bot_settings add column if not exists welcome_message text not null default 'Bem-vindo, {user}, ao {server}!';
alter table bot_settings add column if not exists auth_channel_id text;
alter table bot_settings add column if not exists auth_mode text not null default 'embed';
alter table bot_settings add column if not exists auth_color text not null default '#5865f2';
alter table bot_settings add column if not exists auth_title text not null default 'Autenticacao';
alter table bot_settings add column if not exists auth_message text not null default 'Clique para verificar sua conta.';
alter table bot_settings add column if not exists auth_button_label text not null default 'Verificar acesso';
alter table bot_settings add column if not exists ticket_channel_id text;
alter table bot_settings add column if not exists support_role_ids jsonb not null default '[]'::jsonb;
alter table bot_settings add column if not exists ticket_mode text not null default 'embed';
alter table bot_settings add column if not exists ticket_color text not null default '#5865f2';
alter table bot_settings add column if not exists ticket_title text not null default 'Atendimento';
alter table bot_settings add column if not exists ticket_message text not null default 'Precisa de ajuda? Abra um ticket.';
alter table bot_settings add column if not exists ticket_button_label text not null default 'Abrir ticket';
alter table bot_settings add column if not exists ticket_open_color text not null default '#5865f2';
alter table bot_settings add column if not exists ticket_open_title text not null default 'Novo atendimento de {user}';
alter table bot_settings add column if not exists ticket_open_message text not null default 'Ola {user}, obrigado por abrir um ticket.\n\nExplique aqui o que voce precisa e aguarde o suporte. {supportRoleMentions}';
alter table bot_settings add column if not exists ticket_open_purchase_title text not null default 'Novo pedido de {user}';
alter table bot_settings add column if not exists ticket_open_purchase_message text not null default 'ID do pedido: **gerando**\nProduto: **{product}**\nPreco: **{price}**\n\nAguarde o suporte aprovar sua compra.';
alter table bot_settings add column if not exists sales_channel_id text;
alter table bot_settings add column if not exists sales_mode text not null default 'embed';
alter table bot_settings add column if not exists sales_color text not null default '#5865f2';
alter table bot_settings add column if not exists sales_title text not null default 'Vitrine';
alter table bot_settings add column if not exists sales_message text not null default 'Escolha um produto para iniciar sua compra.';
alter table bot_settings add column if not exists delivery_mode text not null default 'manual';
alter table bot_settings add column if not exists delivery_title text not null default 'Compra aprovada';
alter table bot_settings add column if not exists delivery_message text not null default 'Ola {user}, sua compra de {product} foi aprovada. O suporte enviara sua entrega em breve.';
alter table bot_settings add column if not exists delivery_color text not null default '#58e39b';
alter table bot_settings add column if not exists review_channel_id text;
alter table bot_settings add column if not exists review_title text not null default 'Nova avaliacao';
alter table bot_settings add column if not exists review_message text not null default '{user} avaliou {product} com {stars} estrelas.';
alter table bot_settings add column if not exists review_color text not null default '#ffcc4d';
alter table bot_settings add column if not exists review_gif_url text;
alter table bot_settings add column if not exists log_channel_id text;
alter table bot_settings add column if not exists stock_warn_threshold integer not null default 3;
alter table bot_settings add column if not exists button_emoji text;
alter table bot_settings add column if not exists custom_emoji_id text;
alter table bot_settings add column if not exists custom_emoji_name text;
alter table bot_settings add column if not exists custom_emoji_animated boolean not null default false;
alter table bot_settings add column if not exists updated_at timestamptz not null default now();

alter table products add column if not exists price text not null default '';
alter table products add column if not exists product_type text not null default 'single';
alter table products add column if not exists variations jsonb not null default '[]'::jsonb;
alter table products add column if not exists stock integer;
alter table products add column if not exists delivery_content text;
alter table products add column if not exists low_stock_notified boolean not null default false;
alter table products add column if not exists description text;
alter table products add column if not exists image_url text;
alter table products add column if not exists active boolean not null default true;
alter table products add column if not exists created_at timestamptz not null default now();

create table if not exists payment_settings (
  bot_instance_id uuid primary key references bot_instances(id) on delete cascade,
  provider text not null default 'manual',
  checkout_mode text not null default 'ticket',
  receiver_name text,
  public_instructions text,
  private_details_encrypted text,
  updated_at timestamptz not null default now()
);
alter table payment_settings alter column provider set default 'aurora';
alter table payment_settings add column if not exists terms_text text not null default 'Ao confirmar, voce declara que revisou os produtos, valores e entende que a entrega ocorre apos aprovacao do pagamento.';
alter table payment_settings add column if not exists pix_city text not null default 'SAO PAULO';
alter table payment_settings enable row level security;

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
alter table payment_orders enable row level security;

alter table tickets add column if not exists status text not null default 'open';
alter table tickets add column if not exists product_variant jsonb;
alter table tickets add column if not exists payment_order_id uuid references payment_orders(id) on delete set null;
alter table tickets add column if not exists cart_message_id text;
alter table tickets add column if not exists terms_message_id text;
alter table tickets add column if not exists payment_message_id text;
alter table tickets add column if not exists cart_total_text text;
alter table tickets add column if not exists purchase_status text not null default 'pending';
alter table tickets add column if not exists approved_at timestamptz;
alter table tickets add column if not exists rating integer;
alter table tickets add column if not exists reviewed_at timestamptz;

create table if not exists cart_items (
  id bigserial primary key,
  thread_id text not null references tickets(thread_id) on delete cascade,
  product_id bigint references products(id) on delete set null,
  product_name text not null,
  variant jsonb,
  unit_price_text text not null default '',
  quantity integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table cart_items enable row level security;
alter table tickets add column if not exists created_at timestamptz not null default now();
alter table tickets add column if not exists closed_at timestamptz;

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

select 'Aurora Zero colunas corrigidas com sucesso' as status;

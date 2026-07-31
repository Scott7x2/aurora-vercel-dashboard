-- Aurora Zero: corrige relacoes antigas sem bot_instance_id.
-- Seguro para rodar mais de uma vez. Nao apaga dados.

alter table guild_resources add column if not exists bot_instance_id uuid;
alter table bot_settings add column if not exists bot_instance_id uuid;
alter table products add column if not exists bot_instance_id uuid;
alter table tickets add column if not exists bot_instance_id uuid;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='guild_resources' and column_name='guild_id'
  ) then
    update guild_resources gr
      set bot_instance_id = bi.id
      from bot_instances bi
      where gr.bot_instance_id is null and gr.guild_id = bi.guild_id;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='bot_settings' and column_name='guild_id'
  ) then
    update bot_settings bs
      set bot_instance_id = bi.id
      from bot_instances bi
      where bs.bot_instance_id is null and bs.guild_id = bi.guild_id;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='products' and column_name='guild_id'
  ) then
    update products p
      set bot_instance_id = bi.id
      from bot_instances bi
      where p.bot_instance_id is null and p.guild_id = bi.guild_id;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='tickets' and column_name='guild_id'
  ) then
    update tickets t
      set bot_instance_id = bi.id
      from bot_instances bi
      where t.bot_instance_id is null and t.guild_id = bi.guild_id;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'guild_resources_bot_instance_id_fkey'
  ) then
    alter table guild_resources
      add constraint guild_resources_bot_instance_id_fkey
      foreign key (bot_instance_id) references bot_instances(id) on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'bot_settings_bot_instance_id_fkey'
  ) then
    alter table bot_settings
      add constraint bot_settings_bot_instance_id_fkey
      foreign key (bot_instance_id) references bot_instances(id) on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'products_bot_instance_id_fkey'
  ) then
    alter table products
      add constraint products_bot_instance_id_fkey
      foreign key (bot_instance_id) references bot_instances(id) on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'tickets_bot_instance_id_fkey'
  ) then
    alter table tickets
      add constraint tickets_bot_instance_id_fkey
      foreign key (bot_instance_id) references bot_instances(id) on delete cascade;
  end if;
end $$;

create unique index if not exists guild_resources_bot_instance_unique on guild_resources(bot_instance_id);
create unique index if not exists bot_settings_bot_instance_unique on bot_settings(bot_instance_id);

select 'Aurora Zero relacoes corrigidas com sucesso' as status;

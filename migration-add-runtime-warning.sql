alter table bot_instances add column if not exists runtime_warning text;

select 'runtime_warning adicionado com sucesso' as status;

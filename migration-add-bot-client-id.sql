alter table bot_instances add column if not exists bot_client_id text;

select 'bot_client_id adicionado com sucesso' as status;

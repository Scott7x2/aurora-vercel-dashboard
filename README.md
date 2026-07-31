# Aurora Zero

Projeto refeito do zero com:

- Painel Vercel com login Discord.
- Um bot separado por servidor.
- Configuracao por Supabase.
- Runner Discord continuo para deixar bots online.
- `/painel` apenas para publicar paineis no canal escolhido.
- Autorole, verificacao, boas-vindas, tickets privados e vendas.

## Ordem correta

1. Rode `schema.sql` no SQL Editor do Supabase.
2. Suba `vercel-dashboard` no GitHub/Vercel.
3. Configure as variaveis do Vercel pelo painel de producao, nunca por `.env`.
4. Configure OAuth2 Redirect no Discord Developer Portal.
5. Rode `discord-runner` com PM2.
6. Entre no site, salve o token do bot por servidor, ative e configure.

## Gerar BOT_ENCRYPTION_KEY

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Use a mesma chave no Vercel e no runner.

## Seguranca de producao

Leia `PRODUCTION_ENV.md`. O frontend nao recebe chaves, tokens nem service role. Tudo sensivel fica no backend/API do Vercel ou no runner.

## Atualizacao de emoji e variaveis

Se o banco ja existe, rode `migration-emoji-variables.sql` no SQL Editor do Supabase. Ele adiciona as colunas de emoji sem apagar dados.

Variaveis aceitas em mensagens:

`{user}`, `{userMention}`, `{username}`, `{server}`, `{memberCount}`, `{channel}`, `{channelMention}`, `{owner}`, `{autoRole}`, `{autoRoleMention}`, `{verifiedRole}`, `{verifiedRoleMention}`, `{supportRoles}`, `{supportRoleMentions}`, `{product}`, `{price}`, `{emoji}`, `{date}`, `{time}`.

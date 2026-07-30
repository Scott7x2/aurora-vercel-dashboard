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
3. Configure as variaveis do Vercel.
4. Configure OAuth2 Redirect no Discord Developer Portal.
5. Rode `discord-runner` com PM2.
6. Entre no site, salve o token do bot por servidor, ative e configure.

## Gerar BOT_ENCRYPTION_KEY

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Use a mesma chave no Vercel e no runner.

# Aurora Zero Discord Runner

Roda continuamente os bots ativos salvos pelo painel Vercel.

## .env

```env
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sua_service_role_key
BOT_ENCRYPTION_KEY=mesma_chave_base64_do_vercel
```

## Windows com PM2

```powershell
cd C:\Users\Scott\Documents\Codex\2026-07-30\cod\outputs\aurora-zero\discord-runner
& "C:\Program Files\nodejs\npm.cmd" install
& "$env:APPDATA\npm\pm2.cmd" start src\runner.js --name aurora-zero-runner
& "$env:APPDATA\npm\pm2.cmd" save
& "$env:APPDATA\npm\pm2.cmd" status
```

Logs:

```powershell
& "$env:APPDATA\npm\pm2.cmd" logs aurora-zero-runner
```

## Permissoes do bot

Ative no Discord Developer Portal:

- Server Members Intent

Convide o bot com permissoes de:

- Manage Roles
- Manage Channels
- Create Private Threads
- Send Messages
- Use Slash Commands
- Embed Links

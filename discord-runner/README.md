# Aurora Zero Discord Runner

Roda continuamente todos os bots ativos salvos pelo painel Vercel.

Esse runner e a peca que deixa os bots online 24 horas. Os usuarios nao precisam baixar nada: eles entram no site, salvam o token do bot deles e clicam em ativar. Este processo hospedado por voce le o banco e inicia cada bot automaticamente.

## .env

```env
DATABASE_URL=postgresql://...
BOT_ENCRYPTION_KEY=mesma_chave_base64_do_vercel
RUNNER_NAME=aurora-zero-runner
POLL_INTERVAL_MS=8000
```

Use exatamente a mesma `BOT_ENCRYPTION_KEY` configurada no Vercel, senao o runner nao conseguira descriptografar os tokens salvos pelo site.

## Hospedagem 24h sem o usuario baixar nada

Hospede esta pasta `discord-runner` como um Worker/Background Service em uma plataforma que mantenha processos Node ligados continuamente.

Configuracao do servico:

- Root Directory: `discord-runner`
- Build Command: `npm ci --omit=dev`
- Start Command: `npm start`
- Variaveis: `DATABASE_URL`, `BOT_ENCRYPTION_KEY`, `RUNNER_NAME`, `POLL_INTERVAL_MS`

Se a plataforma aceitar Docker, use o `Dockerfile` desta pasta.

Importante: Vercel nao deve hospedar este runner, porque funcoes serverless nao ficam conectadas ao Gateway do Discord 24h. O Vercel fica apenas com o site/painel.

## Windows com PM2

```powershell
cd C:\Users\Scott\Documents\Codex\2026-07-30\cod\outputs\aurora-zero-completo\discord-runner
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
- Manage Expressions
- Create Private Threads
- Send Messages
- Use Slash Commands
- Embed Links

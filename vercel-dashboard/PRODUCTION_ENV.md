# Variaveis de producao do Aurora Zero

Configure no Vercel em:

`Project Settings > Environment Variables`

Nao envie `.env`, `.env.local` ou `.env.production` ao GitHub. Esses arquivos estao bloqueados por `.gitignore` e `.vercelignore`.

## Variaveis do Vercel

```env
CLIENT_ID=
CLIENT_SECRET=
REDIRECT_URI=
SESSION_SECRET=
DATABASE_URL=
BOT_ENCRYPTION_KEY=
```

`CLIENT_ID`

Discord Developer Portal > sua aplicacao > General Information > Application ID.

`CLIENT_SECRET`

Discord Developer Portal > sua aplicacao > OAuth2 > Client Secret.

`REDIRECT_URI`

Use exatamente:

```text
https://aurora-vercel-dashboard.vercel.app/auth/discord/callback
```

Cadastre o mesmo valor em Discord Developer Portal > OAuth2 > Redirects.

`SESSION_SECRET`

Gere no PowerShell:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`DATABASE_URL`

Supabase > Project Settings > Database > Connection string.
Use a URL do pooler/session pooler com senha do banco. No Vercel, essa URL fica apenas no backend.

`BOT_ENCRYPTION_KEY`

Gere no PowerShell:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Use a mesma chave no runner.

## Variaveis do runner

No host do runner, configure:

```env
DATABASE_URL=
BOT_ENCRYPTION_KEY=
```

## O que fica no backend

- Login OAuth Discord.
- `CLIENT_SECRET`.
- `SESSION_SECRET`.
- `DATABASE_URL`.
- `BOT_ENCRYPTION_KEY`.
- Criptografia do token dos bots.
- Sessao OAuth em cookie `HttpOnly` criptografado e assinado.
- Leitura/escrita no Supabase.

O frontend so chama endpoints `/api/*`.

# Variaveis de producao do Aurora Zero

Nenhuma chave deve ficar em `.env` no GitHub ou no Vercel. Configure variaveis pelo painel do provedor.

## Vercel Dashboard

No Vercel, use:

```env
CLIENT_ID=
CLIENT_SECRET=
REDIRECT_URI=
SESSION_SECRET=
DATABASE_URL=
BOT_ENCRYPTION_KEY=
```

## Discord Runner

No host/PC que roda o runner, use:

```env
DATABASE_URL=
BOT_ENCRYPTION_KEY=
```

## Onde pegar

`CLIENT_ID`: Discord Developer Portal > General Information > Application ID.

`CLIENT_SECRET`: Discord Developer Portal > OAuth2 > Client Secret.

`REDIRECT_URI`: exatamente `https://aurora-vercel-dashboard.vercel.app/auth/discord/callback`.

`SESSION_SECRET`:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`DATABASE_URL`: Supabase > Project Settings > Database > Connection string. Use a URL do pooler com senha do banco.

`BOT_ENCRYPTION_KEY`:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Use a mesma `BOT_ENCRYPTION_KEY` no Vercel e no runner.

## Nunca vai para frontend

- `CLIENT_SECRET`
- `SESSION_SECRET`
- `DATABASE_URL`
- `BOT_ENCRYPTION_KEY`
- token dos bots Discord
- token OAuth do usuario Discord

O frontend so chama endpoints `/api/*`.

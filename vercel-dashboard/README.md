# Aurora Zero Dashboard

Suba esta pasta no Vercel.

## Variaveis

```env
CLIENT_ID=seu_discord_application_id
CLIENT_SECRET=seu_discord_client_secret
REDIRECT_URI=https://seu-projeto.vercel.app/auth/discord/callback
SESSION_SECRET=gere_uma_chave_longa
DATABASE_URL=postgresql://...
BOT_ENCRYPTION_KEY=chave_base64_de_32_bytes
```

## Discord OAuth

No Discord Developer Portal > OAuth2 > Redirects:

```text
https://seu-projeto.vercel.app/auth/discord/callback
```

## Testes

Depois do deploy:

```text
/health
/health/db
```

`/health/db` deve responder `schema: "ready"`.

# Hospedagem 24h do Aurora Zero

## Como funciona

O site no Vercel serve para login, configuracao e salvamento dos bots no banco.

O bot do Discord precisa de um processo vivo 24 horas conectado ao Gateway do Discord. Por isso existe o `discord-runner`.

Fluxo final:

1. Voce hospeda o `vercel-dashboard` no Vercel.
2. Voce hospeda o `discord-runner` uma unica vez como Worker/Background Service.
3. A pessoa entra no site, faz login com Discord, escolhe o servidor, cola o token do bot dela e clica em salvar/ativar.
4. O runner central detecta esse bot no banco e inicia automaticamente.
5. A pessoa nao baixa nada.

## Onde hospedar o runner

Use qualquer plataforma que aceite processo Node continuo/worker/background service.

Nao use Vercel para o runner. Vercel e serverless e nao mantem bot do Discord online 24 horas.

## Configuracao do Worker

Pasta/root:

```txt
discord-runner
```

Build command:

```bash
npm ci --omit=dev
```

Start command:

```bash
npm start
```

Variaveis de ambiente:

```env
DATABASE_URL=postgresql://...
BOT_ENCRYPTION_KEY=mesma_chave_base64_do_vercel
RUNNER_NAME=aurora-zero-runner
POLL_INTERVAL_MS=8000
```

## Variaveis obrigatorias

### DATABASE_URL

E a URL Postgres do Supabase.

Use a connection string do banco. Normalmente fica em:

Supabase > Project Settings > Database > Connection string.

### BOT_ENCRYPTION_KEY

Tem que ser exatamente a mesma chave do Vercel.

Para gerar uma chave nova:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Se trocar essa chave depois de ja ter bot salvo, os tokens antigos nao abrem mais. Nesse caso, salve os tokens novamente no site.

### RUNNER_NAME

Nome apenas para logs.

### POLL_INTERVAL_MS

Tempo para o runner procurar bots novos no banco.

Recomendado:

```env
POLL_INTERVAL_MS=8000
```

## O que o usuario final faz

O usuario final so precisa:

1. Entrar no site.
2. Fazer login com Discord.
3. Criar um bot no Discord Developer Portal.
4. Colar o token no painel.
5. Clicar em salvar/ativar.
6. Adicionar o bot ao servidor pelo botao do painel.

Depois disso o runner central inicia esse bot automaticamente.

# Cheffya Print Agent

Agente local de impressão térmica para Windows.  
Roda em background, expõe HTTP em `localhost:9100`, imprime direto na porta serial sem depender do Chrome ou driver Windows.

---

## Desenvolvimento

```bash
npm install
npm start
```

## Build (.exe)

```bash
npm install
npm run build
# → dist/cheffya-print-agent.exe
```

## Configuração antes de publicar

1. Em `src/updater.js`, altere:
   ```js
   const GITHUB_OWNER = 'SEU_USUARIO_GITHUB'
   const GITHUB_REPO  = 'cheffya-print-agent'
   ```

2. Em `src/server.js` / `src/config.js`, adicione a origem do Vercel em `DEFAULTS.origins`:
   ```js
   origins: ['http://localhost:5173', 'https://SEU_APP.vercel.app'],
   ```

## Publicar atualização

1. `npm version patch` (ou minor/major)
2. `npm run build`
3. Criar GitHub Release com tag `v1.x.x`
4. Upload de `dist/cheffya-print-agent.exe`

## API

| Rota | Auth | Descrição |
|---|---|---|
| `GET /status` | ❌ | Status, versão, porta, conectada |
| `GET /portas` | ✅ | Lista portas COM |
| `POST /configurar` | ✅ | Salva porta COM |
| `POST /imprimir` | ✅ | Imprime pedido |
| `POST /testar` | ✅ | Imprime teste |

Auth: header `X-Agent-Token: <token>` (token exibido no log na primeira execução).

## Arquivos gerados

```
%APPDATA%\CheffyaPrintAgent\
  config.json   — porta COM, token, origens
  agent.log     — log atual
  agent.log.1   — log anterior (rotação)
```

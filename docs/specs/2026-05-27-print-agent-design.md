# Cheffya Print Agent — Design Spec
**Data:** 2026-05-27  
**Projeto:** `imprimircheffya`  
**Status:** Aprovado

---

## Problema

O Menu Control usa Web Serial API (Chrome) para imprimir em impressoras térmicas USB. Isso cria três limitações:
1. Só funciona no Chrome (não Edge, não Firefox)
2. O operador precisa selecionar a porta manualmente a cada sessão
3. O driver Windows (ZPrinter) interfere na impressão HTML fallback causando folha em branco

## Solução

Um agente local Windows (`.exe`) que roda em background, expõe uma API HTTP em `localhost:9100`, e imprime diretamente na porta serial sem passar pelo driver Windows.

---

## Arquitetura

### Stack
- **Runtime:** Node.js 20 LTS
- **Empacotamento:** `@yao-pkg/pkg` (fork mantido do pkg) → `.exe` único ~35MB
- **Distribuição:** GitHub Releases + link na app web

### Estrutura de arquivos

```
imprimircheffya/
├── src/
│   ├── index.js      — entrada: inicia server, tray, updater
│   ├── server.js     — HTTP Express na porta 9100
│   ├── printer.js    — serialport + ESC/POS
│   ├── tray.js       — ícone bandeja Windows
│   ├── updater.js    — auto-update via GitHub Releases
│   └── config.js     — lê/salva config em %APPDATA%
├── assets/
│   └── icon.ico
├── package.json
└── build.js          — script @yao-pkg/pkg
```

### Dependências principais
| Pacote | Uso |
|---|---|
| `express` | Servidor HTTP |
| `cors` | Middleware CORS configurável |
| `serialport` | Comunicação porta serial |
| `node-tray` | Ícone bandeja Windows (mantido) |
| `node-fetch` | Requisições GitHub API |
| `@yao-pkg/pkg` | Empacotamento .exe (fork mantido do pkg, suporta Node 20 + bindings nativos) |

---

## Caminhos de dados persistentes

Todos os arquivos do agente ficam em `%APPDATA%\CheffyaPrintAgent\`:
- `config.json` — configurações (porta COM, token, versão)
- `agent.log` — log rotativo (últimas 500 linhas) para debug

Nunca escreve na pasta do `.exe` — evita problemas de permissão em `Program Files`.

---

## API HTTP (porta 9100)

### CORS
A app web está hospedada no Vercel (origem `https://app.cheffya.com.br` ou similar) — **não é localhost**. O middleware CORS permite explicitamente:
- `http://localhost:*`
- `http://127.0.0.1:*`
- A origem de produção da app (configurável, salva em `config.json`)

### Autenticação
Um token aleatório é gerado na primeira execução e salvo em `config.json`. A app web recebe esse token na tela de configuração (exibido uma vez) e o envia como header `X-Agent-Token` em todas as requisições. Isso impede que outros processos na máquina acionem impressões.

### Rotas

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| GET | `/status` | ❌ | `{ ok, versao, porta, conectada, erro? }` |
| GET | `/portas` | ✅ | Lista portas COM disponíveis |
| POST | `/configurar` | ✅ | Salva porta COM em config.json |
| POST | `/imprimir` | ✅ | Recebe pedido JSON, imprime ESC/POS |
| POST | `/testar` | ✅ | Imprime notinha de teste |

`/status` sem auth para que a app web possa detectar o agente sem precisar do token.  
`erro` em `/status` informa se a porta COM está ocupada ou inacessível.

---

## ESC/POS e ciclo de vida da porta serial

Porta direta do `src/utils/impressora.js` da app web (`montarEscPos`).

**Ciclo por impressão (open/close):**
```
recebe POST /imprimir
  → abre porta COM
  → envia bytes ESC/POS
  → fecha porta COM
  → retorna { ok: true }
```

Abrir e fechar por impressão (não manter conexão persistente) evita o problema de porta travada. Se `serialport.open()` retornar `Access Denied` (porta em uso por outro app como o driver ZPrinter), o `/status` retorna `{ conectada: false, erro: "Porta COM3 em uso por outro programa" }`.

---

## Bandeja do Windows

Menu clique direito:
```
🖨 Cheffya Print Agent
─────────────────────
● Impressora: COM3
─────────────────────
  Alterar porta COM  → [lista dinâmica de portas]
─────────────────────
  Testar impressão
  Verificar atualização
─────────────────────
  v1.0.0
  Sair
```

**Iniciar com Windows:** cria atalho em  
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup` na primeira execução.  
**Sair:** remove o atalho da pasta Startup ao encerrar via menu "Sair" (evita atalho órfão se o .exe for deletado manualmente).

---

## Auto-update

Fluxo executado na inicialização (falha silenciosa se sem internet):

1. `GET https://api.github.com/repos/USUARIO/cheffya-print-agent/releases/latest`
2. Compara `tag_name` com versão atual
3. Se mais novo:
   - Baixa novo `.exe` para `%TEMP%\cheffya-agent-new.exe`
   - Gera script `.bat` com loop de retry (máx 10 tentativas):
     ```bat
     set /a tries=0
     :retry
     set /a tries+=1
     if %tries% gtr 10 exit /b 1
     ping -n 3 localhost > nul
     copy /Y "%TEMP%\cheffya-agent-new.exe" "%~dp0cheffya-print-agent.exe"
     if errorlevel 1 goto retry
     start "" "%~dp0cheffya-print-agent.exe"
     ```
   - Inicia o `.bat` e encerra o processo atual
4. Notificação Windows: *"Cheffya Print Agent — Atualizando para vX.X.X..."*

---

## Logging

`%APPDATA%\CheffyaPrintAgent\agent.log` — append de linhas no formato:
```
2026-05-27T18:30:00Z [INFO] Agente iniciado v1.0.0
2026-05-27T18:30:01Z [INFO] Porta serial: COM3
2026-05-27T18:31:22Z [INFO] Imprimiu pedido #ABC123
2026-05-27T18:32:00Z [ERROR] COM3: Access Denied
```
Rotação simples: ao atingir 500 linhas, renomeia para `agent.log.1` (sobrescreve anterior) e começa novo `agent.log`. Máximo 2 arquivos em disco.

---

## Integração com a app web

`DeliveryGerenciar.jsx` ao abrir a aba de impressora:
1. Tenta `GET localhost:9100/status` (sem token, sem CORS issue)
2. Se responder: mostra painel de configuração do agente
3. Se não responder: mostra botão "Baixar agente" + continua oferecendo Web Serial

**Primeira configuração (pairing):**
- Usuário clica "Conectar agente"
- App pede o token (exibido na bandeja: "Configurar → Copiar token")
- Token salvo no `localStorage` da app
- Todas as requisições seguintes usam o token no header

---

## Distribuição

1. `npm run build` → `@yao-pkg/pkg` → `dist/cheffya-print-agent.exe`
2. Criar GitHub Release com tag `v1.0.0` + upload do `.exe`
3. Link na app web aponta para URL estável do release

## Fluxo de instalação pelo cliente

```
1. App web: botão "Baixar agente de impressão"
2. Baixa cheffya-print-agent.exe (~35MB)
3. Clica duas vezes → ícone 🖨 aparece na bandeja
4. Clique direito → Alterar porta COM → seleciona a correta
5. Clique direito → Configurar → Copiar token
6. Na app web: cola o token em "Conectar agente"
7. Clique direito → Testar impressão → confirma ok
8. Pronto — inicia sozinho com o Windows
```

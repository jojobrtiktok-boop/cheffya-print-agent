// server.js — HTTP Express na porta 19100

const express = require('express')
const cors    = require('cors')
const { ler, salvar } = require('./config')
const { imprimir, testar, listarPortas, verificarPorta } = require('./printer')
const log = require('./logger')

const PORTA_HTTP = 19100

// ── CORS + Private Network Access ────────────────────────────────────────────
// O agente roda em http://127.0.0.1 (HTTP local), inacessível externamente.
// Segurança = binding em localhost apenas. Sem autenticação por token.
//
// Problemas resolvidos aqui:
// 1. Chrome bloqueia requisições de páginas HTTPS → HTTP 127.0.0.1 sem o header
//    Access-Control-Allow-Private-Network: true (Chrome Private Network Access).
// 2. Origens variadas (localhost, cheffya.com.br) precisam ser aceitas.
//
// Solução: aceitar TODAS as origens + responder o header de Private Network
// Access nos preflights OPTIONS.
function criarCors() {
  return cors({
    origin: true,   // qualquer origem — segurança via binding em 127.0.0.1
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Access-Control-Request-Private-Network'],
    exposedHeaders: ['Access-Control-Allow-Private-Network'],
    credentials: false,
  })
}

// Middleware para Chrome Private Network Access:
// Quando uma página HTTPS faz fetch para http://127.0.0.1, o Chrome envia um
// preflight OPTIONS com "Access-Control-Request-Private-Network: true".
// O servidor deve responder com "Access-Control-Allow-Private-Network: true".
function privateNetworkAccess(req, res, next) {
  if (req.headers['access-control-request-private-network']) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
  }
  next()
}

// Autenticação removida — agente escuta só em 127.0.0.1 (localhost),
// portanto inacessível de fora do PC. Segurança suficiente para uso local.

// ── Criar app Express ─────────────────────────────────────────────────────────
function criarServidor() {
  const app = express()
  app.use(privateNetworkAccess)
  app.use(criarCors())
  app.options('*', criarCors())   // responde preflights OPTIONS em todas as rotas
  app.use(express.json({ limit: '1mb' }))

  // ── GET /status — sem auth (detectar agente) ──────────────────────────────
  app.get('/status', async (req, res) => {
    const cfg = ler()
    let conectada = false
    let erro = null

    if (cfg.porta) {
      try {
        conectada = await verificarPorta(cfg.porta)
        if (!conectada) erro = `Porta ${cfg.porta} não acessível`
      } catch (e) {
        erro = e.message
      }
    }

    res.json({
      ok:           true,
      versao:       cfg.versao,
      porta:        cfg.porta || null,
      larguraPapel: cfg.larguraPapel || 58,
      conectada,
      erro,
    })
  })

  // ── GET /portas — lista portas COM ────────────────────────────────────────
  app.get('/portas', async (req, res) => {
    try {
      const portas = await listarPortas()
      res.json({ ok: true, portas })
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message })
    }
  })

  // ── POST /configurar — salva porta COM, larguraPapel e opcionalmente origins ─
  app.post('/configurar', (req, res) => {
    try {
      const { porta, origins, larguraPapel } = req.body
      const updates = {}
      if (porta)        updates.porta        = porta
      if (origins)      updates.origins      = origins
      if (larguraPapel) updates.larguraPapel = Number(larguraPapel)
      const cfg = salvar(updates)
      log.info(`Configurado: porta=${cfg.porta} papel=${cfg.larguraPapel}mm`)
      res.json({ ok: true, config: { porta: cfg.porta, larguraPapel: cfg.larguraPapel } })
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message })
    }
  })

  // ── Deduplicação de impressão ─────────────────────────────────────────────
  // Supabase Realtime pode disparar o mesmo INSERT duas vezes (reconexão WS).
  // O web app já tem dedup, mas este é um segundo layer de proteção no agente.
  const _printedIds = new Map()   // pedidoId → timestamp
  const DEDUP_MS    = 30_000      // 30 segundos

  // ── POST /imprimir ────────────────────────────────────────────────────────
  app.post('/imprimir', async (req, res) => {
    const { pedido, nomeLoja, forte, fonteGrande, larguraPapel: larguraReq } = req.body
    if (!pedido) return res.status(400).json({ ok: false, erro: 'pedido é obrigatório' })

    // Dedup: ignora se mesmo pedido já foi impresso nos últimos 30s
    const pid = pedido.id
    if (pid) {
      const last = _printedIds.get(pid)
      if (last && Date.now() - last < DEDUP_MS) {
        log.warn(`[dedup] Pedido ${pid} já impresso há ${Date.now() - last}ms — ignorando`)
        return res.json({ ok: true, duplicado: true })
      }
      _printedIds.set(pid, Date.now())
      setTimeout(() => _printedIds.delete(pid), DEDUP_MS)
    }

    const cfg = ler()
    if (!cfg.porta) return res.status(400).json({ ok: false, erro: 'Nenhuma porta COM configurada. Configure em Alterar porta COM.' })

    try {
      const modoVia = (nomeLoja || '').includes('COZINHA') ? 'cozinha' : 'completo'
      // Largura: prioriza a enviada pelo painel (sincronizada via banco) sobre a config local do agente
      const largura = Number(larguraReq) === 80 || Number(larguraReq) === 58 ? Number(larguraReq) : (cfg.larguraPapel || 58)
      await imprimir(pedido, nomeLoja || '', cfg.porta, largura, modoVia, !!forte, !!fonteGrande)
      res.json({ ok: true })
    } catch (e) {
      log.error(`Erro ao imprimir: ${e.message}`)
      res.status(500).json({ ok: false, erro: e.message })
    }
  })

  // ── POST /testar ──────────────────────────────────────────────────────────
  app.post('/testar', async (req, res) => {
    const cfg = ler()
    if (!cfg.porta) return res.status(400).json({ ok: false, erro: 'Nenhuma porta COM configurada.' })

    try {
      const { forte, fonteGrande, larguraPapel: larguraReq } = req.body || {}
      const largura = Number(larguraReq) === 80 || Number(larguraReq) === 58 ? Number(larguraReq) : (cfg.larguraPapel || 58)
      await testar(cfg.porta, largura, !!forte, !!fonteGrande)
      res.json({ ok: true })
    } catch (e) {
      log.error(`Erro no teste: ${e.message}`)
      res.status(500).json({ ok: false, erro: e.message })
    }
  })

  // ── Iniciar servidor ──────────────────────────────────────────────────────
  return new Promise((resolve, reject) => {
    const srv = app.listen(PORTA_HTTP, '127.0.0.1', () => {
      log.info(`Servidor HTTP rodando em http://127.0.0.1:${PORTA_HTTP}`)
      resolve(srv)
    })
    srv.on('error', err => {
      if (err.code === 'EADDRINUSE') {
        log.error(`Porta ${PORTA_HTTP} já está em uso. Outro agente rodando?`)
        reject(new Error(`Porta ${PORTA_HTTP} ocupada — outro agente já está rodando.`))
      } else {
        reject(err)
      }
    })
  })
}

module.exports = { criarServidor }

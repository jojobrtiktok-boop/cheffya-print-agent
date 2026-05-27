// server.js — HTTP Express na porta 9100

const express = require('express')
const cors    = require('cors')
const { ler, salvar } = require('./config')
const { imprimir, testar, listarPortas } = require('./printer')
const log = require('./logger')

const PORTA_HTTP = 9100

// ── CORS — permite localhost + origens configuradas ──────────────────────────
function criarCors() {
  const origens = [
    'http://localhost:5173',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:3000',
  ]
  // Adiciona origens salvas na config (produção Vercel, etc.)
  const cfg = ler()
  if (cfg.origins && Array.isArray(cfg.origins)) {
    cfg.origins.forEach(o => { if (!origens.includes(o)) origens.push(o) })
  }

  return cors({
    origin: (origin, cb) => {
      // Requisições sem origin (ex: curl, Postman, mesma página) → permitir
      if (!origin) return cb(null, true)
      if (origens.some(o => origin.startsWith(o))) return cb(null, true)
      log.warn(`CORS bloqueou origin: ${origin}`)
      cb(new Error('Origem não permitida'))
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Agent-Token'],
  })
}

// ── Middleware de autenticação ────────────────────────────────────────────────
function auth(req, res, next) {
  const cfg   = ler()
  const token = req.headers['x-agent-token']
  if (!token || token !== cfg.token) {
    return res.status(401).json({ ok: false, erro: 'Token inválido' })
  }
  next()
}

// ── Criar app Express ─────────────────────────────────────────────────────────
function criarServidor() {
  const app = express()
  app.use(criarCors())
  app.use(express.json({ limit: '1mb' }))

  // ── GET /status — sem auth (detectar agente) ──────────────────────────────
  app.get('/status', async (req, res) => {
    const cfg = ler()
    let conectada = false
    let erro = null

    if (cfg.porta) {
      try {
        const { SerialPort } = require('serialport')
        const p = new SerialPort({ path: cfg.porta, baudRate: 9600, autoOpen: false })
        await new Promise((resolve, reject) => {
          p.open(err => { p.close(() => {}); err ? reject(err) : resolve() })
        })
        conectada = true
      } catch (e) {
        erro = e.message
      }
    }

    res.json({
      ok:       true,
      versao:   cfg.versao,
      porta:    cfg.porta || null,
      conectada,
      erro,
    })
  })

  // ── GET /portas — lista portas COM ────────────────────────────────────────
  app.get('/portas', auth, async (req, res) => {
    try {
      const portas = await listarPortas()
      res.json({ ok: true, portas })
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message })
    }
  })

  // ── POST /configurar — salva porta COM (e opcionalmente origins) ──────────
  app.post('/configurar', auth, (req, res) => {
    try {
      const { porta, origins } = req.body
      const updates = {}
      if (porta)   updates.porta   = porta
      if (origins) updates.origins = origins
      const cfg = salvar(updates)
      log.info(`Configurado: porta=${cfg.porta}`)
      res.json({ ok: true, config: { porta: cfg.porta } })
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message })
    }
  })

  // ── POST /imprimir ────────────────────────────────────────────────────────
  app.post('/imprimir', auth, async (req, res) => {
    const { pedido, nomeLoja } = req.body
    if (!pedido) return res.status(400).json({ ok: false, erro: 'pedido é obrigatório' })

    const cfg = ler()
    if (!cfg.porta) return res.status(400).json({ ok: false, erro: 'Nenhuma porta COM configurada. Configure em Alterar porta COM.' })

    try {
      await imprimir(pedido, nomeLoja || '', cfg.porta)
      res.json({ ok: true })
    } catch (e) {
      log.error(`Erro ao imprimir: ${e.message}`)
      res.status(500).json({ ok: false, erro: e.message })
    }
  })

  // ── POST /testar ──────────────────────────────────────────────────────────
  app.post('/testar', auth, async (req, res) => {
    const cfg = ler()
    if (!cfg.porta) return res.status(400).json({ ok: false, erro: 'Nenhuma porta COM configurada.' })

    try {
      await testar(cfg.porta)
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

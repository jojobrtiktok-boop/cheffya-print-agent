// config.js — lê e salva configurações em %APPDATA%\CheffyaPrintAgent\config.json

const path = require('path')
const fs   = require('fs')
const os   = require('os')
const crypto = require('crypto')

const CONFIG_DIR  = path.join(os.homedir(), 'AppData', 'Roaming', 'CheffyaPrintAgent')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')

function versaoAtual() {
  try { return require('../package.json').version } catch { return '1.0.0' }
}

const DEFAULTS = {
  porta:   '',
  token:   crypto.randomBytes(20).toString('hex'),
  origins: ['http://localhost:5173', 'http://localhost:3000'],
  versao:  versaoAtual(),
}

function garantirDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })
}

function ler() {
  garantirDir()
  if (!fs.existsSync(CONFIG_PATH)) {
    const inicial = { ...DEFAULTS }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(inicial, null, 2))
    return inicial
  }
  try {
    const salvo = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    // Garante que novos campos defaults existam
    return { ...DEFAULTS, ...salvo }
  } catch {
    return { ...DEFAULTS }
  }
}

function salvar(dados) {
  garantirDir()
  const atual = ler()
  const novo  = { ...atual, ...dados }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(novo, null, 2))
  return novo
}

module.exports = { ler, salvar, CONFIG_DIR, CONFIG_PATH }

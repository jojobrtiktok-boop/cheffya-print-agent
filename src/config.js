// config.js — lê e salva configurações em %APPDATA%\CheffyaPrintAgent\config.json

const path = require('path')
const fs   = require('fs')
const os   = require('os')

const CONFIG_DIR  = path.join(os.homedir(), 'AppData', 'Roaming', 'CheffyaPrintAgent')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')

function versaoAtual() {
  try { return require('../package.json').version } catch { return '1.0.1' }
}

const DEFAULTS = {
  porta:        '',
  larguraPapel: 58,   // mm — 58 (32 colunas) ou 80 (42 colunas)
  versao:       versaoAtual(),
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
    // Garante que novos campos defaults existam.
    // versao sempre reflete o exe atual — nunca o valor salvo em disco.
    return { ...DEFAULTS, ...salvo, versao: versaoAtual() }
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

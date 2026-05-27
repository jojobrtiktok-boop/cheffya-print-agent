// logger.js — log em arquivo com rotação de 500 linhas

const path = require('path')
const fs   = require('fs')
const { CONFIG_DIR } = require('./config')

const LOG_PATH  = path.join(CONFIG_DIR, 'agent.log')
const LOG_BAK   = path.join(CONFIG_DIR, 'agent.log.1')
const MAX_LINES = 500

function timestamp() {
  return new Date().toISOString()
}

function escrever(nivel, msg) {
  try {
    // Rotação: se ultrapassar MAX_LINES, renomeia para .log.1 e começa novo
    if (fs.existsSync(LOG_PATH)) {
      const conteudo = fs.readFileSync(LOG_PATH, 'utf8')
      const linhas   = conteudo.split('\n').filter(Boolean)
      if (linhas.length >= MAX_LINES) {
        fs.writeFileSync(LOG_BAK, conteudo)
        fs.writeFileSync(LOG_PATH, '')
      }
    }
    const linha = `${timestamp()} [${nivel}] ${msg}\n`
    fs.appendFileSync(LOG_PATH, linha)
    // Também imprime no console (visível quando rodando fora do pkg)
    process.stdout.write(linha)
  } catch {
    // Falha silenciosa — log nunca deve derrubar o agente
  }
}

const log = {
  info:  (msg) => escrever('INFO ', msg),
  warn:  (msg) => escrever('WARN ', msg),
  error: (msg) => escrever('ERROR', msg),
}

module.exports = log

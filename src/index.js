// index.js — entrada do Cheffya Print Agent

const log  = require('./logger')
const { ler } = require('./config')
const { criarServidor } = require('./server')
const { iniciarTray, configurarAutoStart } = require('./tray')
const { verificarAtualizacao } = require('./updater')

// Impede múltiplas instâncias: se a porta já estiver em uso, encerra
process.on('uncaughtException', (err) => {
  log.error(`Erro não tratado: ${err.message}`)
  if (err.code === 'EADDRINUSE') {
    log.error('Porta 9100 em uso — outro agente já está rodando. Encerrando.')
    process.exit(1)
  }
})

process.on('unhandledRejection', (reason) => {
  log.error(`Promise rejeitada: ${reason}`)
})

async function main() {
  const cfg = ler()
  log.info(`=== Cheffya Print Agent v${cfg.versao} iniciando ===`)
  log.info(`Porta COM configurada: ${cfg.porta || '(nenhuma)'}`)

  // 1. Servidor HTTP
  try {
    await criarServidor()
  } catch (e) {
    log.error(`Falha ao iniciar servidor: ${e.message}`)
    process.exit(1)
  }

  // 2. Auto-start no Windows (primeira execução)
  configurarAutoStart()

  // 3. Ícone na bandeja
  await iniciarTray(() => {
    log.info('Agente encerrado.')
    process.exit(0)
  })

  // 4. Verificar atualizações (após 5s para não atrasar o startup)
  setTimeout(() => {
    verificarAtualizacao().catch(e => log.warn(`Update check: ${e.message}`))
  }, 5000)

  log.info('Agente pronto. Token: ' + cfg.token.slice(0, 8) + '...')
  log.info('Configure a porta COM e cole o token na app web para conectar.')
}

main()

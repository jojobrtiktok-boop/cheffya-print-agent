// tray.js — ícone na bandeja do Windows (systray2)
// Graceful: se a tray falhar, o agente continua rodando normalmente

const path = require('path')
const fs   = require('fs')
const os   = require('os')
const { ler, salvar } = require('./config')
const { listarPortas } = require('./printer')
const { verificarAtualizacao } = require('./updater')
const log  = require('./logger')

// Ícone base64 (PNG 32x32 — ícone de impressora simples)
// Para substituir: converta um .ico para base64 e cole aqui
const ICON_BASE64 = `iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABHNCSVQICAgI
fAhkiAAAAAlwSFlzAAAA7AAAAOwBeShxvQAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9y
Z5vuPBoAAAHISURBVFiF7ZYxaxsxFMc/kq4Q7OAhQ6EUCqFDKYVCKZRCKYRCKZRCKZRCcQ7ZgiBQ
IAMhkCEDAQIZMhBCCIRACIRACIRACGQIgRAIgRAIgRAIgRAIgRAIgRAIgRAIgRAI/z8k6f3Tneq2
nq3rCv0ghIe/7773ve8JIYS4E0IIIYQQ4k4IIYQQQggh7oQQQgghhBB3QgghhBBCiDshhBBCCCHE
nRBCCCGEEOJOCCGEEEIIcSeEEEIIIYS4E0IIIYQQ4k4IIYQQQghxJ4QQQgghhLgTQgghhBBC3Akh
hBBCCCHuhBBCCCGEEHdCCCGEEEKIOyGEEEIIIcSdEEIIIYQQ4k4IIYQQQghxJ4QQQgghhLgTQggh
hBBC3AkhhBBCCCHuhBBCCCGEEHdCCCGEEEKIOyGEEEIIIcSdEEIIIYQQ4k4IIYQQQghxJ4QQQggh
hLgTQgghhBBC3AkhhBBCCCHuhBBCCCGEEHdCCCGEEEKIOyGEEEIIIcSdEEIIIYQQ4k4IIYQQ4k4I
IYQQQghxJ4QQQgghhLgTQgghhBBC3AkhhBBCCCHuhBBCCCGEEHdCCCGEEEKIOyGEEEIIIcSdEEII
IYQQd0IIIYQQQtx9AK7rHJFJAAAAAElFTkSuQmCC`

// Caminho do ícone (extrai para temp se rodando como pkg)
function getIconPath() {
  const iconName = 'cheffya-tray-icon.png'
  const tempIcon = path.join(os.tmpdir(), iconName)

  // Tenta usar ícone da pasta assets (dentro do snapshot pkg ou ao lado do exe)
  const candidates = [
    path.join(__dirname, '..', 'assets', 'icon.png'),         // dev (node direto)
    path.join(path.dirname(process.execPath), 'assets', 'icon.png'), // pkg (pasta do exe)
  ]

  for (const src of candidates) {
    if (fs.existsSync(src)) {
      try { fs.copyFileSync(src, tempIcon) } catch {}
      return tempIcon
    }
  }

  // Fallback: usa base64 embutido
  if (!fs.existsSync(tempIcon)) {
    try {
      const buf = Buffer.from(ICON_BASE64.replace(/\s/g, ''), 'base64')
      fs.writeFileSync(tempIcon, buf)
    } catch {}
  }
  return tempIcon
}

// Extrai helper systray2 para temp (necessário para pkg)
function getHelperPath() {
  if (!process.pkg) return null // usa path padrão do módulo

  const helperName = 'trayhelper-win.exe'
  const tempHelper = path.join(os.tmpdir(), `cheffya-${helperName}`)

  if (!fs.existsSync(tempHelper)) {
    const snapshotPath = path.join(__dirname, '..', 'node_modules', 'systray2', 'traybin', helperName)
    try {
      fs.copyFileSync(snapshotPath, tempHelper)
    } catch (e) {
      log.warn(`Não foi possível extrair tray helper: ${e.message}`)
      return null
    }
  }
  return tempHelper
}

async function iniciarTray(onQuit) {
  let Systray
  try {
    Systray = require('systray2').default
  } catch (e) {
    log.warn(`Tray não disponível: ${e.message} — agente continua sem ícone na bandeja.`)
    return null
  }

  // Menu inicial (será recriado com portas dinâmicas)
  const cfg   = ler()
  const portas = await listarPortas().catch(() => [])

  const itensPorta = portas.length > 0
    ? portas.map(p => ({
        title:   `${p.path}${p.descricao ? ' — ' + p.descricao : ''}${p.path === cfg.porta ? ' ✓' : ''}`,
        tooltip: p.path,
        checked: p.path === cfg.porta,
        enabled: true,
      }))
    : [{ title: 'Nenhuma porta encontrada', tooltip: '', checked: false, enabled: false }]

  const menu = {
    icon:    getIconPath(),
    title:   '',
    tooltip: `Cheffya Print Agent v${cfg.versao}`,
    items: [
      {
        title:   cfg.porta ? `● Porta: ${cfg.porta}` : '○ Porta não configurada',
        tooltip: 'Status da impressora',
        checked: false,
        enabled: false,
      },
      Systray.separator,
      {
        title:   'Alterar porta COM',
        tooltip: 'Selecionar porta da impressora',
        checked: false,
        enabled: true,
        items:   itensPorta,
      },
      Systray.separator,
      { title: 'Testar impressão',     tooltip: '', checked: false, enabled: true },
      { title: 'Verificar atualização',tooltip: '', checked: false, enabled: true },
      Systray.separator,
      {
        title:   `v${cfg.versao}`,
        tooltip: 'Versão atual',
        checked: false,
        enabled: false,
      },
      Systray.separator,
      { title: 'Sair', tooltip: 'Encerrar o agente', checked: false, enabled: true },
    ],
  }

  const helperPath = getHelperPath()
  const tray = new Systray({ menu, debug: false, copyDir: !helperPath, ...(helperPath ? { trayPath: helperPath } : {}) })

  tray.onClick(action => {
    const { seq_id } = action

    // Índices do menu (0=status, 1=sep, 2=portas, 3=sep, 4=testar, 5=update, 6=sep, 7=versao, 8=sep, 9=sair)
    // Clique no submenu de portas: seq_id tipo "2.0", "2.1" etc.
    if (String(seq_id).startsWith('2.')) {
      const idx = parseInt(String(seq_id).split('.')[1])
      if (portas[idx]) {
        const novaCom = portas[idx].path
        salvar({ porta: novaCom })
        log.info(`Porta alterada para ${novaCom}`)
      }
      return
    }

    if (seq_id === 4) { // Testar impressão
      const { testar } = require('./printer')
      const c = ler()
      if (!c.porta) return log.warn('Porta não configurada para teste')
      testar(c.porta)
        .then(() => log.info('Teste de impressão enviado'))
        .catch(e => log.error(`Teste falhou: ${e.message}`))
    }

    if (seq_id === 5) { // Verificar atualização
      verificarAtualizacao().catch(e => log.error(`Update: ${e.message}`))
    }

    if (seq_id === 9) { // Sair
      log.info('Encerrando por solicitação do usuário')
      removerAutoStart()
      tray.kill()
      setTimeout(() => process.exit(0), 300)
      if (onQuit) onQuit()
    }
  })

  log.info('Ícone da bandeja inicializado')
  return tray
}

// ── Auto-start (atalho na pasta Startup do Windows) ──────────────────────────
function getStartupPath() {
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'CheffyaPrintAgent.lnk')
}

function configurarAutoStart() {
  if (!process.pkg) return // só faz sentido no .exe
  try {
    const { execSync } = require('child_process')
    const lnkPath = getStartupPath()
    const exePath = process.execPath

    // Cria atalho .lnk via PowerShell
    const ps = `$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('${lnkPath}'); $s.TargetPath = '${exePath}'; $s.Save()`
    execSync(`powershell -Command "${ps}"`, { stdio: 'ignore' })
    log.info('Auto-start configurado')
  } catch (e) {
    log.warn(`Auto-start não configurado: ${e.message}`)
  }
}

function removerAutoStart() {
  try {
    const lnkPath = getStartupPath()
    if (fs.existsSync(lnkPath)) {
      fs.unlinkSync(lnkPath)
      log.info('Atalho de auto-start removido')
    }
  } catch {}
}

module.exports = { iniciarTray, configurarAutoStart, removerAutoStart }

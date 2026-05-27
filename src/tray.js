// tray.js — ícone na bandeja do Windows (systray2)
// Graceful: se a tray falhar, o agente continua rodando normalmente

const path = require('path')
const fs   = require('fs')
const os   = require('os')
const { ler, salvar } = require('./config')
const { listarPortas } = require('./printer')
const { verificarAtualizacao } = require('./updater')
const log  = require('./logger')

// ── Extrai o binary do systray2 para o disco (necessário no pkg) ─────────────
function extrairTrayBinary() {
  const { CONFIG_DIR } = require('./config')
  const trayBinDir = path.join(CONFIG_DIR, 'traybin')
  const binName    = 'tray_windows_release.exe'
  const dstPath    = path.join(trayBinDir, binName)

  if (!fs.existsSync(trayBinDir)) fs.mkdirSync(trayBinDir, { recursive: true })

  if (!fs.existsSync(dstPath)) {
    const srcPath = path.join(__dirname, '..', 'node_modules', 'systray2', 'traybin', binName)
    try {
      const data = fs.readFileSync(srcPath)
      fs.writeFileSync(dstPath, data)
      log.info(`Tray binary extraído para ${dstPath}`)
    } catch (e) {
      log.warn(`Falha ao extrair tray binary: ${e.message}`)
      return null
    }
  }
  return trayBinDir
}

// ── Extrai ícone para o disco e retorna o caminho real ────────────────────────
// systray2's resolveIcon usa fs.pathExists — só converte p/ base64 se o arquivo
// existir em disco real. No pkg, snapshot não passa nessa verificação.
function extrairIcone() {
  const { CONFIG_DIR } = require('./config')

  const candidates = [
    { src: path.join(__dirname, '..', 'assets', 'icon.ico'), dst: path.join(CONFIG_DIR, 'tray-icon.ico') },
    { src: path.join(__dirname, '..', 'assets', 'tray.png'), dst: path.join(CONFIG_DIR, 'tray-icon.png') },
    { src: path.join(__dirname, '..', 'assets', 'icon.png'), dst: path.join(CONFIG_DIR, 'tray-icon.png') },
    process.pkg
      ? { src: path.join(path.dirname(process.execPath), 'assets', 'icon.ico'), dst: path.join(CONFIG_DIR, 'tray-icon.ico') }
      : null,
  ].filter(Boolean)

  for (const { src, dst } of candidates) {
    try {
      const data = fs.readFileSync(src)
      if (data && data.length > 50) {
        fs.writeFileSync(dst, data)
        log.info(`Ícone extraído: ${dst} (${data.length} bytes)`)
        return dst
      }
    } catch {}
  }

  log.warn('Ícone não encontrado — bandeja sem imagem')
  return ''
}

// ── Inicializar bandeja ───────────────────────────────────────────────────────
async function iniciarTray(onQuit) {
  if (process.pkg) {
    const trayBinDir = extrairTrayBinary()
    if (trayBinDir) {
      try {
        const { CONFIG_DIR } = require('./config')
        process.chdir(CONFIG_DIR)
        log.info(`CWD alterado para ${CONFIG_DIR} (para systray2 encontrar traybin)`)
      } catch (e) {
        log.warn(`chdir falhou: ${e.message}`)
      }
    }
  }

  let Systray
  try {
    Systray = require('systray2').default
  } catch (e) {
    log.warn(`systray2 não carregou: ${e.message} — agente continua sem ícone na bandeja.`)
    return null
  }

  const cfg    = ler()
  const portas = await listarPortas().catch(() => [])
  const papel  = cfg.larguraPapel || 58

  // ── Sub-menu: dispositivos ─────────────────────────────────────────────────
  const itensPorta = portas.length > 0
    ? portas.map(p => ({
        title:   `${p.path}${p.path === cfg.porta ? ' ✓' : ''}`,
        tooltip: p.descricao || p.path,
        checked: p.path === cfg.porta,
        enabled: true,
      }))
    : [{ title: 'Nenhum dispositivo encontrado', tooltip: '', checked: false, enabled: false }]

  // ── Sub-menu: largura de papel ─────────────────────────────────────────────
  const itensPapel = [
    { title: `58mm${papel === 58 ? ' ✓' : ''}`, tooltip: '32 colunas — papel 58mm', checked: papel === 58, enabled: true },
    { title: `80mm${papel === 80 ? ' ✓' : ''}`, tooltip: '42 colunas — papel 80mm', checked: papel === 80, enabled: true },
  ]

  const iconePath = extrairIcone()

  const menu = {
    icon:    iconePath,
    title:   '',
    tooltip: `Cheffya Print Agent v${cfg.versao}`,
    items: [
      { title: cfg.porta ? `● ${cfg.porta}` : '○ Impressora não configurada', tooltip: '', checked: false, enabled: false },
      Systray.separator,
      { title: 'Alterar impressora',    tooltip: '', checked: false, enabled: true, items: itensPorta  },
      { title: `Papel: ${papel}mm`,     tooltip: '', checked: false, enabled: true, items: itensPapel  },
      Systray.separator,
      { title: 'Testar impressão',      tooltip: '', checked: false, enabled: true },
      { title: 'Verificar atualização', tooltip: '', checked: false, enabled: true },
      Systray.separator,
      { title: `v${cfg.versao}`,        tooltip: 'Versão atual', checked: false, enabled: false },
      Systray.separator,
      { title: 'Sair',                  tooltip: 'Encerrar o agente', checked: false, enabled: true },
    ],
  }

  let tray
  try {
    tray = new Systray({ menu, debug: false, copyDir: false })
  } catch (e) {
    log.warn(`Falha ao criar tray: ${e.message}`)
    return null
  }

  // ── onClick — usa o TÍTULO do item em vez de seq_id numérico ──────────────
  // Muito mais robusto: adicionar/remover itens não quebra os handlers.
  tray.onClick(action => {
    const titulo = (action.item?.title || '').trim()
    log.info(`[CLICK] "${titulo}"`)

    // ── Seleção de dispositivo ─────────────────────────────────────────────
    const porta = portas.find(p => titulo.startsWith(p.path))
    if (porta) {
      salvar({ porta: porta.path })
      log.info(`Dispositivo selecionado: ${porta.path}`)
      return
    }

    // ── Seleção de largura de papel ────────────────────────────────────────
    if (titulo.startsWith('58mm')) {
      salvar({ larguraPapel: 58 })
      log.info('Papel configurado: 58mm (32 colunas)')
      return
    }
    if (titulo.startsWith('80mm')) {
      salvar({ larguraPapel: 80 })
      log.info('Papel configurado: 80mm (42 colunas)')
      return
    }

    // ── Testar impressão ───────────────────────────────────────────────────
    if (titulo === 'Testar impressão') {
      const { testar } = require('./printer')
      const c = ler()
      if (!c.porta) {
        log.warn('Selecione uma impressora primeiro (Alterar impressora).')
        return
      }
      log.info(`Disparando teste de impressão em "${c.porta}" (${c.larguraPapel || 58}mm)...`)
      testar(c.porta, c.larguraPapel || 58)
        .then(() => log.info('Teste enviado com sucesso'))
        .catch(e => log.error(`Teste falhou: ${e.message}`))
      return
    }

    // ── Verificar atualização ──────────────────────────────────────────────
    if (titulo === 'Verificar atualização') {
      verificarAtualizacao().catch(e => log.error(`Update check: ${e.message}`))
      return
    }

    // ── Sair ───────────────────────────────────────────────────────────────
    if (titulo === 'Sair') {
      log.info('Encerrando por solicitação do usuário')
      removerAutoStart()
      if (onQuit) onQuit()
      tray.kill(false)
      setTimeout(() => {
        log.info('Saindo (process.exit)')
        process.exit(0)
      }, 400)
      return
    }

    // Itens desabilitados (status, versão) ou pais de submenu não geram ação
  })

  log.info('Ícone da bandeja inicializado')
  return tray
}

// ── Auto-start (Startup folder do Windows) ───────────────────────────────────
function getStartupLnkPath() {
  return path.join(
    os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows',
    'Start Menu', 'Programs', 'Startup', 'CheffyaPrintAgent.lnk'
  )
}

function configurarAutoStart() {
  if (!process.pkg) return
  try {
    const { execSync } = require('child_process')
    const lnkPath = getStartupLnkPath()
    if (fs.existsSync(lnkPath)) return

    const exeDir  = path.dirname(process.execPath)
    const vbsPath = path.join(exeDir, 'cheffya-print-agent-launcher.vbs')
    const target  = fs.existsSync(vbsPath) ? vbsPath : process.execPath

    const ps = `$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('${lnkPath}'); $s.TargetPath = '${target}'; $s.Save()`
    execSync(`powershell -WindowStyle Hidden -Command "${ps}"`, { stdio: 'ignore' })
    log.info('Auto-start configurado')
  } catch (e) {
    log.warn(`Auto-start não configurado: ${e.message}`)
  }
}

function removerAutoStart() {
  try {
    const lnkPath = getStartupLnkPath()
    if (fs.existsSync(lnkPath)) { fs.unlinkSync(lnkPath); log.info('Auto-start removido') }
  } catch {}
}

module.exports = { iniciarTray, configurarAutoStart, removerAutoStart }

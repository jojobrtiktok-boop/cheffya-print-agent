// updater.js — auto-update via GitHub Releases

const https  = require('https')
const fs     = require('fs')
const path   = require('path')
const os     = require('os')
const { execFile } = require('child_process')
const log    = require('./logger')

// ── Configuração — ajustar para o repositório correto ────────────────────────
const GITHUB_OWNER = 'jojobrtiktok-boop'
const GITHUB_REPO  = 'cheffya-print-agent'
const GITHUB_API   = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`

function versaoAtual() {
  try { return require('../package.json').version } catch { return '1.0.0' }
}

function compararVersao(a, b) {
  // Retorna true se b é mais novo que a
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pb[i] || 0) > (pa[i] || 0)) return true
    if ((pb[i] || 0) < (pa[i] || 0)) return false
  }
  return false
}

function baixarArquivo(url, destino) {
  return new Promise((resolve, reject) => {
    const arquivo = fs.createWriteStream(destino)

    function pedirUrl(u) {
      https.get(u, { headers: { 'User-Agent': 'cheffya-print-agent' } }, res => {
        // Segue redirecionamentos
        if (res.statusCode === 301 || res.statusCode === 302) {
          arquivo.close()
          return pedirUrl(res.headers.location)
        }
        if (res.statusCode !== 200) {
          arquivo.close()
          return reject(new Error(`Download falhou: HTTP ${res.statusCode}`))
        }
        res.pipe(arquivo)
        arquivo.on('finish', () => { arquivo.close(); resolve() })
        arquivo.on('error', reject)
      }).on('error', reject)
    }

    pedirUrl(url)
  })
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'cheffya-print-agent' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(httpGet(res.headers.location))
      }
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch { reject(new Error('JSON inválido da API')) }
      })
    }).on('error', reject)
  })
}

async function verificarAtualizacao() {
  const atual = versaoAtual()
  log.info(`Verificando atualizações... (versão atual: v${atual})`)

  let release
  try {
    release = await httpGet(GITHUB_API)
  } catch (e) {
    log.warn(`Não foi possível verificar atualização: ${e.message}`)
    return false
  }

  const nova = release.tag_name || ''
  if (!compararVersao(atual, nova)) {
    log.info(`Sem atualizações (última: ${nova})`)
    return false
  }

  log.info(`Nova versão disponível: ${nova}`)

  // Encontra o asset .exe no release
  const asset = (release.assets || []).find(a => a.name.endsWith('.exe'))
  if (!asset) {
    log.warn('Release não tem .exe para download')
    return false
  }

  // Caminho do exe atual (funciona tanto em pkg quanto em node direto)
  const exeAtual  = process.pkg ? process.execPath : path.join(__dirname, '..', 'dist', 'cheffya-print-agent.exe')
  const exeNovo   = path.join(os.tmpdir(), 'cheffya-agent-new.exe')
  const batPath   = path.join(os.tmpdir(), 'cheffya-update.bat')

  log.info(`Baixando ${nova}...`)
  try {
    await baixarArquivo(asset.browser_download_url, exeNovo)
  } catch (e) {
    log.error(`Falha no download: ${e.message}`)
    return false
  }

  // Gera script .bat com retry (máx 10 tentativas, ~3s cada)
  const bat = `@echo off
set /a tries=0
:retry
set /a tries+=1
if %tries% gtr 10 (
  echo Falha ao atualizar apos 10 tentativas
  exit /b 1
)
ping -n 3 localhost > nul
copy /Y "${exeNovo}" "${exeAtual}"
if errorlevel 1 goto retry
start "" "${exeAtual}"
del "%~f0"
`
  fs.writeFileSync(batPath, bat)

  log.info(`Atualizando para ${nova}... O agente vai reiniciar.`)

  // Lança o .bat e encerra este processo
  execFile('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore' }).unref()
  setTimeout(() => process.exit(0), 500)
  return true
}

module.exports = { verificarAtualizacao }

// build.js — empacota o agente como .exe usando @yao-pkg/pkg

const { execSync }   = require('child_process')
const { rcedit }     = require('rcedit')
const path = require('path')
const fs   = require('fs')

const ROOT    = __dirname
const DIST    = path.join(ROOT, 'dist')
const EXE     = path.join(DIST, 'cheffya-print-agent.exe')
const PKG_BIN = path.join(ROOT, 'node_modules', '.bin', 'pkg')
const ICON    = path.join(ROOT, 'assets', 'icon.ico')

if (!fs.existsSync(DIST)) fs.mkdirSync(DIST)

// ── Passo 1: gerar o .exe com pkg ────────────────────────────────────────────
console.log('🔨 Gerando cheffya-print-agent.exe...')
try {
  // Não passa --icon aqui: o rcedit (passo 2) embute de forma mais confiável
  execSync(
    `"${PKG_BIN}" src/index.js --config package.json --target node20-win-x64 --output dist/cheffya-print-agent.exe`,
    { cwd: ROOT, stdio: 'inherit' }
  )
} catch (e) {
  console.error('❌ Erro ao gerar .exe:', e.message)
  process.exit(1)
}
console.log('✅ dist/cheffya-print-agent.exe gerado!')

// ── Passo 2: mudar subsistema PE de CONSOLE → WINDOWS ───────────────────────
// Isso elimina a janela CMD preta — o .exe abre silenciosamente em background
// (mesma técnica usada pelo Electron)
try {
  const buf       = fs.readFileSync(EXE)
  const peOffset  = buf.readUInt32LE(0x3C)               // offset do cabeçalho PE
  const peHdr     = buf.toString('ascii', peOffset, peOffset + 4)

  if (peHdr !== 'PE\0\0') throw new Error('Assinatura PE inválida')

  // Optional header começa após PE sig (4 bytes) + COFF header (20 bytes)
  const optOffset       = peOffset + 4 + 20
  const subsystemOffset = optOffset + 68                  // campo Subsystem

  const antes = buf.readUInt16LE(subsystemOffset)
  buf.writeUInt16LE(2, subsystemOffset)                   // 2 = IMAGE_SUBSYSTEM_WINDOWS_GUI
  fs.writeFileSync(EXE, buf)

  console.log(`✅ Subsistema alterado: ${antes} (CONSOLE) → 2 (WINDOWS) — sem janela CMD!`)
} catch (e) {
  console.warn(`⚠️  Não foi possível alterar subsistema PE: ${e.message}`)
  console.warn('   O .exe ainda funciona, mas pode abrir uma janela CMD.')
}

// ── Passo 3: embeber ícone Cheffya no .exe com rcedit ────────────────────────
// rcedit modifica o resource table do PE para trocar o ícone — mais confiável
// que o --icon do pkg, que depende de rcedit interno nem sempre funcional.
console.log('🎨 Embebendo ícone Cheffya no .exe...')
;(async () => {
  try {
    await rcedit(EXE, { icon: ICON })
    console.log('✅ Ícone Cheffya embebido com sucesso!')
  } catch (e) {
    console.warn(`⚠️  rcedit falhou: ${e.message}`)
    console.warn('   O .exe funciona, mas sem o ícone correto no Explorer.')
  }

  // ── Passo 4: gerar o .vbs launcher (backup / compatibilidade) ────────────────
  const vbsDst = path.join(DIST, 'cheffya-print-agent-launcher.vbs')
  fs.writeFileSync(vbsDst, [
    "' Cheffya Print Agent — Launcher silencioso (backup)",
    "' Use o .exe diretamente — o subsistema já é WINDOWS",
    'Dim WshShell, exePath, scriptDir',
    'Set WshShell = CreateObject("WScript.Shell")',
    'scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)',
    'exePath = scriptDir & "\\cheffya-print-agent.exe"',
    'WshShell.Run Chr(34) & exePath & Chr(34), 0, False',
  ].join('\r\n'))
  console.log('✅ dist/cheffya-print-agent-launcher.vbs gerado!')

  console.log('')
  console.log('📦 Para instalar no Windows:')
  console.log('   → Duplo clique em cheffya-print-agent.exe  (nenhuma janela abre!)')
  console.log('   → Ícone aparece na bandeja do sistema (system tray)')
})()

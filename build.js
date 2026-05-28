// build.js — empacota o agente como .exe usando @yao-pkg/pkg
// Ordem obrigatória: pkg → rcedit (ícone) → patch PE subsistema
// O rcedit reescreve partes do PE, então o patch de subsistema DEVE vir por último.

const { execSync } = require('child_process')
const { rcedit }   = require('rcedit')
const path = require('path')
const fs   = require('fs')

const ROOT    = __dirname
const DIST    = path.join(ROOT, 'dist')
const EXE     = path.join(DIST, 'cheffya-print-agent.exe')
const PKG_BIN = path.join(ROOT, 'node_modules', '.bin', 'pkg')
const ICON    = path.join(ROOT, 'assets', 'icon.ico')

if (!fs.existsSync(DIST)) fs.mkdirSync(DIST)

;(async () => {
  // ── Passo 1: gerar o .exe com pkg ──────────────────────────────────────────
  console.log('🔨 Gerando cheffya-print-agent.exe...')
  try {
    execSync(
      `"${PKG_BIN}" src/index.js --config package.json --target node20-win-x64 --output dist/cheffya-print-agent.exe`,
      { cwd: ROOT, stdio: 'inherit' }
    )
  } catch (e) {
    console.error('❌ Erro ao gerar .exe:', e.message)
    process.exit(1)
  }
  console.log('✅ dist/cheffya-print-agent.exe gerado!')

  // ── Passo 2: embeber ícone com rcedit ──────────────────────────────────────
  // DEVE vir antes do patch de subsistema — rcedit reescreve o PE e pode
  // reverter o campo Subsystem de volta para CONSOLE (3).
  console.log('🎨 Embebendo ícone Cheffya no .exe...')
  try {
    await rcedit(EXE, { icon: ICON })
    console.log('✅ Ícone Cheffya embebido!')
  } catch (e) {
    console.warn(`⚠️  rcedit falhou: ${e.message}`)
    console.warn('   O .exe funciona, mas sem o ícone correto no Explorer.')
  }

  // ── Passo 3: patch PE — subsistema CONSOLE (3) → WINDOWS (2) ──────────────
  // DEVE ser o último passo porque o rcedit pode sobrescrever esse campo.
  // Isso elimina a janela CMD preta ao abrir o .exe.
  try {
    const buf             = fs.readFileSync(EXE)
    const peOffset        = buf.readUInt32LE(0x3C)
    const peHdr           = buf.toString('ascii', peOffset, peOffset + 4)
    if (peHdr !== 'PE\0\0') throw new Error('Assinatura PE inválida')
    const subsystemOffset = peOffset + 4 + 20 + 68
    const antes           = buf.readUInt16LE(subsystemOffset)
    buf.writeUInt16LE(2, subsystemOffset)                  // 2 = WINDOWS_GUI
    fs.writeFileSync(EXE, buf)
    console.log(`✅ Subsistema: ${antes} → 2 (WINDOWS) — sem janela CMD!`)
  } catch (e) {
    console.warn(`⚠️  Patch PE falhou: ${e.message}`)
  }

  // ── Passo 4: gerar launcher .vbs (silencioso, compatibilidade) ─────────────
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
  console.log('✅ launcher.vbs gerado!')

  console.log('')
  console.log('📦 Duplo clique em cheffya-print-agent.exe — nenhuma janela abre!')
  console.log('   Ícone Cheffya aparece na bandeja do sistema (system tray)')
})()

// build.js — empacota o Cheffya Print Agent como .exe distribuível
//
// Estratégia de ícone (pkg --icon não funciona com Node 20/24):
//   1. pkg  → dist/cheffya-print-agent-core.exe  (Node.js embutido, sem ícone real)
//   2. csc  → dist/cheffya-print-agent.exe        (C# launcher com ícone Cheffya real)
//      O launcher embute o core como recurso gerenciado, extrai para
//      %LOCALAPPDATA%\CheffyaPrintAgent\ na primeira execução e o inicia.
//      Arquivos extraídos NÃO têm Zone.Identifier → PowerShell funciona normalmente.
//
// NÃO usar rcedit: reescreve o PE e perde o snapshot Node.js (arquivo encolhe ~14 MB).

const { execSync, spawnSync } = require('child_process')
const path = require('path')
const fs   = require('fs')
const os   = require('os')

const ROOT        = __dirname
const DIST        = path.join(ROOT, 'dist')
const CORE        = path.join(DIST, 'cheffya-print-agent-core.exe')
const WRAPPER     = path.join(DIST, 'cheffya-print-agent.exe')
const PKG_BIN     = path.join(ROOT, 'node_modules', '.bin', 'pkg')
const ICON        = path.join(ROOT, 'assets', 'icon.ico')
const LAUNCHER_CS = path.join(ROOT, 'launcher.cs')
const CSC         = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'

if (!fs.existsSync(DIST)) fs.mkdirSync(DIST)

// ── Passo 1: gerar core.exe com pkg ───────────────────────────────────────────
console.log('🔨 [1/3] Gerando cheffya-print-agent-core.exe com pkg...')
try {
  execSync(
    `"${PKG_BIN}" src/index.js --config package.json --target node20-win-x64 --output "${CORE}"`,
    { cwd: ROOT, stdio: 'inherit' }
  )
} catch (e) {
  console.error('❌ Erro ao gerar core.exe:', e.message)
  process.exit(1)
}
console.log(`✅ core.exe gerado (${(fs.statSync(CORE).size / 1024 / 1024).toFixed(1)} MB)`)

// ── Passo 2: patch PE — subsistema CONSOLE (3) → WINDOWS (2) no core ─────────
// Impede que uma janela CMD apareça ao iniciar o core diretamente.
console.log('🔨 [2/3] Patch PE: CONSOLE → WINDOWS no core...')
try {
  const buf             = fs.readFileSync(CORE)
  const peOffset        = buf.readUInt32LE(0x3C)
  if (buf.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0')
    throw new Error('Assinatura PE inválida')
  const subsystemOffset = peOffset + 4 + 20 + 68
  const antes           = buf.readUInt16LE(subsystemOffset)
  buf.writeUInt16LE(2, subsystemOffset)
  fs.writeFileSync(CORE, buf)
  console.log(`✅ Subsistema core: ${antes} → 2 (WINDOWS_GUI)`)
} catch (e) {
  console.warn(`⚠️  Patch PE falhou: ${e.message}`)
}

// ── Passo 3: compilar launcher C# → cheffya-print-agent.exe ──────────────────
// Usa spawnSync (sem shell) para evitar problemas de quoting com espaços nos paths.
// Os arquivos de entrada são copiados para %TEMP% (sem espaços) por segurança.
console.log('🔨 [3/3] Compilando launcher C# com ícone Cheffya...')

if (!fs.existsSync(CSC)) {
  console.error(`❌ csc.exe não encontrado em:\n   ${CSC}`)
  console.error('   Instale o .NET Framework 4.x ou ajuste o caminho CSC no build.js')
  process.exit(1)
}

// Copia inputs para %TEMP% para garantir caminhos sem espaços
const tmpDir      = os.tmpdir()   // geralmente C:\Users\...\AppData\Local\Temp (sem espaços)
const tmpCore     = path.join(tmpDir, 'cheffya-core.exe')
const tmpIcon     = path.join(tmpDir, 'cheffya-icon.ico')
const tmpLauncher = path.join(tmpDir, 'cheffya-launcher.cs')
const tmpOut      = path.join(tmpDir, 'cheffya-launcher-out.exe')

fs.copyFileSync(CORE,        tmpCore)
fs.copyFileSync(ICON,        tmpIcon)
fs.copyFileSync(LAUNCHER_CS, tmpLauncher)

const cscArgs = [
  '/target:winexe',
  `/win32icon:${tmpIcon}`,
  '/reference:System.Windows.Forms.dll',
  `/resource:${tmpCore},CheffyaCore`,
  `/out:${tmpOut}`,
  tmpLauncher,
]

const cscResult = spawnSync(CSC, cscArgs, { stdio: 'inherit' })

// Limpa temporários independente do resultado
for (const f of [tmpCore, tmpIcon, tmpLauncher]) {
  try { fs.unlinkSync(f) } catch {}
}

if (cscResult.status !== 0) {
  try { fs.unlinkSync(tmpOut) } catch {}
  console.error('❌ Erro ao compilar launcher C#')
  process.exit(1)
}

// Move resultado para dist/
fs.copyFileSync(tmpOut, WRAPPER)
try { fs.unlinkSync(tmpOut) } catch {}

// ── Sumário ───────────────────────────────────────────────────────────────────
const coreSize    = (fs.statSync(CORE).size    / 1024 / 1024).toFixed(1)
const wrapperSize = (fs.statSync(WRAPPER).size / 1024 / 1024).toFixed(1)

console.log('')
console.log('📦 Build finalizado!')
console.log(`   dist/cheffya-print-agent.exe       ${wrapperSize.padStart(5)} MB  ← DISTRIBUIR este (tem ícone Cheffya)`)
console.log(`   dist/cheffya-print-agent-core.exe  ${coreSize.padStart(5)} MB  ← asset do GitHub Release (usado pelo auto-updater)`)
console.log('')
console.log('   1ª execução: launcher extrai o core para:')
console.log('   %LOCALAPPDATA%\\CheffyaPrintAgent\\cheffya-print-agent-core.exe')
console.log('   Arquivos extraídos NÃO têm Zone.Identifier — impressão funciona!')

// build.js — empacota o agente como .exe usando @yao-pkg/pkg

const { execSync } = require('child_process')
const path = require('path')
const fs   = require('fs')

const ROOT    = __dirname
const DIST    = path.join(ROOT, 'dist')
const PKG_BIN = path.join(ROOT, 'node_modules', '.bin', 'pkg')

if (!fs.existsSync(DIST)) fs.mkdirSync(DIST)

console.log('🔨 Gerando cheffya-print-agent.exe...')

try {
  execSync(
    `"${PKG_BIN}" src/index.js --target node20-win-x64 --output dist/cheffya-print-agent.exe`,
    { cwd: ROOT, stdio: 'inherit' }
  )
  console.log('✅ dist/cheffya-print-agent.exe gerado com sucesso!')
  console.log('')
  console.log('📦 Próximos passos:')
  console.log('   1. Crie uma GitHub Release com a tag v' + require('./package.json').version)
  console.log('   2. Faça upload do dist/cheffya-print-agent.exe')
  console.log('   3. Atualize o link de download na app web')
} catch (e) {
  console.error('❌ Erro ao gerar .exe:', e.message)
  process.exit(1)
}

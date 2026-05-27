// generate-icons.js — gera tray.png, icon.png e icon.ico a partir do favicon.png
const sharp    = require('sharp')
const pngToIco = require('png-to-ico').default
const path     = require('path')
const fs       = require('fs')

const SRC  = path.join(__dirname, 'assets', 'favicon.png')
const ASSETS = path.join(__dirname, 'assets')

async function main() {
  console.log('🎨 Gerando ícones a partir do favicon.png...')

  // icon.png — 256x256 (usado pelo tray no app e como fallback)
  await sharp(SRC)
    .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(ASSETS, 'icon.png'))
  console.log('✅ assets/icon.png (256x256)')

  // tray.png — 64x64 (compacto para a bandeja)
  await sharp(SRC)
    .resize(64, 64, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(ASSETS, 'tray.png'))
  console.log('✅ assets/tray.png (64x64)')

  // icon.ico — múltiplos tamanhos: 16, 32, 48, 256
  const sizes = [16, 32, 48, 256]
  const pngBuffers = await Promise.all(
    sizes.map(sz =>
      sharp(SRC)
        .resize(sz, sz, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer()
    )
  )
  const icoBuffer = await pngToIco(pngBuffers)
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), icoBuffer)
  console.log(`✅ assets/icon.ico (${sizes.join('/')}px, ${icoBuffer.length} bytes)`)
}

main().catch(e => { console.error('❌', e.message); process.exit(1) })

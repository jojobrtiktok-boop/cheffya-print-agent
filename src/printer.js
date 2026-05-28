// printer.js — ESC/POS + acesso à porta COM via PowerShell/.NET
// (sem dependências nativas — funciona dentro do pkg .exe)

const path    = require('path')
const fs      = require('fs')
const os      = require('os')
const { execFile } = require('child_process')
const log     = require('./logger')

// ── ESC/POS constantes ────────────────────────────────────────────────────────
const ESC = 0x1B
const GS  = 0x1D
const LF  = 0x0A

// Colunas por largura de papel:
//   58mm → ~32 chars por linha (font padrão ESC/POS ~1.8mm por char)
//   80mm → ~42 chars por linha (font padrão ESC/POS ~1.7mm por char)
function getCols(larguraMm) {
  if (larguraMm === 80) return { N: 42, H: 42, D: 21 }
  return { N: 32, H: 32, D: 16 }   // padrão 58mm
}

const SIZE_NORMAL = [GS, 0x21, 0x00]
const SIZE_HIGH   = [GS, 0x21, 0x01]
const SIZE_DOUBLE = [GS, 0x21, 0x11]

// ── Helpers de texto ──────────────────────────────────────────────────────────
function semAcento(str) {
  return (str || '')
    .replace(/[ãâáàä]/gi, c => /[A-Z]/.test(c) ? 'A' : 'a')
    .replace(/[êéè]/gi,   c => /[A-Z]/.test(c) ? 'E' : 'e')
    .replace(/[îíì]/gi,   c => /[A-Z]/.test(c) ? 'I' : 'i')
    .replace(/[õôóò]/gi,  c => /[A-Z]/.test(c) ? 'O' : 'o')
    .replace(/[ûúù]/gi,   c => /[A-Z]/.test(c) ? 'U' : 'u')
    .replace(/[ç]/gi,     c => /[A-Z]/.test(c) ? 'C' : 'c')
    .replace(/[ñ]/gi,     c => /[A-Z]/.test(c) ? 'N' : 'n')
}

function toBytes(str) {
  const s = semAcento(str)
  const arr = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    arr.push(c < 256 ? c : 63)
  }
  return arr
}

function linha(txt, cols = COLS_N) {
  const t = (txt || '').slice(0, cols)
  return [...toBytes(t), LF]
}

function centrar(txt, cols = COLS_N) {
  const t   = (txt || '').slice(0, cols)
  const pad = Math.max(0, Math.floor((cols - t.length) / 2))
  return [...toBytes(' '.repeat(pad) + t), LF]
}

function duasColunas(esq, dir, cols = COLS_N) {
  const dirFull = (dir || '')
  const maxDir  = Math.min(Math.ceil(cols / 2), dirFull.length)
  const d       = dirFull.slice(0, maxDir)
  const e       = (esq || '').slice(0, cols - d.length - 1)
  const esp     = cols - e.length - d.length
  return [...toBytes(e + ' '.repeat(Math.max(1, esp)) + d), LF]
}

function separador(c = '-', cols = COLS_N) {
  return [...toBytes(c.repeat(cols)), LF]
}

// ── Parse defensivo de arrays (itens podem vir como JSON string do Supabase) ─
function parseArr(v) {
  if (!v) return []
  if (Array.isArray(v)) return v
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : [] } catch { return [] } }
  return []
}

// ── Montar bytes ESC/POS ──────────────────────────────────────────────────────
function montarEscPos(pedido, nomeLoja = '', larguraPapel = 58) {
  const b = []
  const { N: COLS_N, H: COLS_H, D: COLS_D } = getCols(larguraPapel)

  const clienteNome     = pedido.cliente_nome     || pedido.clienteNome
  const clienteTelefone = pedido.cliente_telefone || pedido.clienteTelefone
  const enderecoEntrega = pedido.endereco_entrega || pedido.enderecoEntrega
  const formaPagamento  = pedido.forma_pagamento  || pedido.formaPagamento
  const plataformaTaxa  = Number(pedido.plataforma_taxa || pedido.plataformaTaxa || 0)
  const labelPgto = {
    dinheiro: 'Dinheiro', pix: 'PIX', cartaoCredito: 'Credito',
    cartaoDebito: 'Debito', cartao: 'Cartao', pixWhatsapp: 'PIX WPP',
  }

  // Init: reset + negrito global
  b.push(ESC, 0x40)
  b.push(ESC, 0x45, 0x01)

  // Cabeçalho duplo
  b.push(ESC, 0x61, 0x01)
  b.push(...SIZE_DOUBLE)
  if (nomeLoja) b.push(...centrar(nomeLoja.toUpperCase(), COLS_D))

  const canalLabel = {
    ifood: 'iFOOD', ifood2: 'iFOOD 2', '99food': '99FOOD',
    keeta: 'KEETA', delivery: 'DELIVERY', balcao: 'BALCAO',
  }
  const canal   = canalLabel[pedido.canal] || (pedido.canal || 'PEDIDO').toUpperCase()
  const shortId = pedido.ifood_short_id || pedido.ifoodShortId || (pedido.id || '----').slice(-6)
  b.push(...centrar(canal, COLS_D))
  b.push(...centrar(`#${shortId.toUpperCase()}`, COLS_D))

  b.push(...SIZE_NORMAL)
  b.push(...centrar(`${pedido.data || ''} ${pedido.hora || ''}`.trim(), COLS_N))
  b.push(ESC, 0x61, 0x00)
  b.push(...separador('=', COLS_N))

  // Cliente
  b.push(...SIZE_HIGH)
  if (clienteNome)     b.push(...linha(`Cliente: ${clienteNome}`, COLS_H))
  if (clienteTelefone) b.push(...linha(`Tel: ${clienteTelefone}`, COLS_H))

  // Endereço
  if (enderecoEntrega) {
    b.push(...SIZE_NORMAL)
    b.push(...separador('-', COLS_N))
    b.push(...SIZE_HIGH)
    if (enderecoEntrega === 'Retirada no local') {
      b.push(...linha('RETIRADA NO LOCAL', COLS_H))
    } else {
      b.push(...linha('ENTREGA:', COLS_H))
      const end = semAcento(enderecoEntrega)
      for (let i = 0; i < end.length; i += COLS_H)
        b.push(...linha(end.slice(i, i + COLS_H), COLS_H))
    }
  }

  // Itens
  b.push(...SIZE_NORMAL)
  b.push(...separador('-', COLS_N))
  b.push(...SIZE_DOUBLE)
  b.push(...linha('ITENS:', COLS_D))
  b.push(...SIZE_HIGH)

  let totalItens = 0
  for (const item of parseArr(pedido.itens)) {
    if (!item || typeof item !== 'object') continue   // ignora caracteres se itens vier como string
    const nomeRaw  = item.ifoodItemName || item.nome || 'Item'
    const qtd      = item.quantidade || 1
    const preco    = (item.precoUnit || 0) * qtd
    totalItens += preco

    const variacoes   = parseArr(item.variacoes)
    const tamanhoNome = item.tamanho?.nome || ''
    const cleanV = (nome) => tamanhoNome
      ? nome.replace(new RegExp(`\\s*\\(${tamanhoNome}\\)\\s*$`, 'i'), '').trim()
      : nome

    let nomeExibir
    if (variacoes.length === 1)      nomeExibir = cleanV(variacoes[0].nome)
    else if (variacoes.length > 1)   nomeExibir = tamanhoNome ? `${nomeRaw.split(' (')[0]} (${tamanhoNome})` : nomeRaw.split(' (')[0]
    else                             nomeExibir = nomeRaw

    b.push(...duasColunas(`${qtd}x ${nomeExibir}`, `R$${preco.toFixed(2)}`, COLS_H))

    if (variacoes.length > 1) {
      const frac = variacoes.length === 2 ? '1/2' : '1/3'
      for (const v of variacoes) b.push(...linha(`  ${frac} ${cleanV(v.nome)}`, COLS_H))
    }
    if (item.borda) b.push(...linha(`  Borda: ${item.borda.nome}`, COLS_H))
    for (const op of parseArr(item.opcoes))
      if (op?.nome) b.push(...linha(`  + ${op.nome}${op.qtd > 1 ? ` x${op.qtd}` : ''}`, COLS_H))
    for (const c of parseArr(item.complementosEscolhidos))
      if (c?.nome) b.push(...linha(`  + ${c.nome}${c.qtd > 1 ? ` x${c.qtd}` : ''}`, COLS_H))
    for (const a of parseArr(item.adicionaisEscolhidos))
      if (a?.nome) b.push(...linha(`  + ${a.nome}${a.qtd > 1 ? ` x${a.qtd}` : ''}`, COLS_H))
    if (item.obs) b.push(...linha(`  Obs: ${item.obs}`, COLS_H))
  }

  // Totais
  b.push(...SIZE_NORMAL)
  b.push(...separador('=', COLS_N))
  if (plataformaTaxa > 0) {
    b.push(...SIZE_HIGH)
    b.push(...duasColunas('Taxa de entrega:', `R$${plataformaTaxa.toFixed(2)}`, COLS_H))
  }
  const total = totalItens + plataformaTaxa
  b.push(...SIZE_DOUBLE)
  b.push(...duasColunas('TOTAL:', `R$${total.toFixed(2)}`, COLS_D))
  b.push(...SIZE_HIGH)
  if (formaPagamento) b.push(...linha(`Pgto: ${labelPgto[formaPagamento] || formaPagamento}`, COLS_H))
  if (pedido.obs) {
    const obs = semAcento(String(pedido.obs))
    for (let i = 0; i < obs.length; i += COLS_H)
      b.push(...linha((i === 0 ? 'Obs: ' : '     ') + obs.slice(i, i + COLS_H - 5), COLS_H))
  }
  b.push(...SIZE_NORMAL)
  b.push(...separador('=', COLS_N))
  b.push(ESC, 0x61, 0x01)
  b.push(...SIZE_DOUBLE)
  b.push(...centrar('Obrigado!', COLS_D))
  b.push(...SIZE_NORMAL)
  b.push(ESC, 0x61, 0x00)

  // Avanço final com LF simples — compatível com qualquer térmica ESC/POS.
  // ESC d e GS V removidos: causavam comportamento inesperado em impressoras
  // mais simples (papel em branco, corte dentro da máquina, etc).
  b.push(LF, LF, LF, LF, LF, LF)  // 6 LFs ≈ 20-25mm — empurra além da barra de rasgo

  return Buffer.from(b)
}

// ── Executar PowerShell ───────────────────────────────────────────────────────
function runPS(script, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, windowsHide: true },   // windowsHide=true → sem janela PowerShell visível
      (err, stdout, stderr) => {
        if (stderr && stderr.trim()) log.warn(`[PS stderr] ${stderr.trim().slice(0, 300)}`)
        if (err) return reject(new Error((stderr || err.message || 'Erro PowerShell').trim()))
        resolve(stdout.trim())
      }
    )
  })
}

// ── Detectar tipo de dispositivo ─────────────────────────────────────────────
function ehPortaCOM(dispositivo) {
  return /^COM\d+$/i.test(dispositivo)
}

// ── Enviar buffer via porta COM (serial/USB-serial/Bluetooth) ─────────────────
async function escrevePortaCOM(portaCOM, buffer) {
  const tempFile = path.join(os.tmpdir(), `cheffya-print-${Date.now()}.bin`)
  fs.writeFileSync(tempFile, buffer)

  const portaPS = portaCOM.replace(/'/g, "''")
  const filePS  = tempFile.replace(/\\/g, '\\\\').replace(/'/g, "''")

  const script = `
$bytes = [System.IO.File]::ReadAllBytes('${filePS}')
$port  = New-Object System.IO.Ports.SerialPort('${portaPS}', 9600, 'None', 8, 'One')
$port.WriteTimeout = 5000
try {
  $port.Open()
  $port.Write($bytes, 0, $bytes.Length)
  $port.Flush()
} finally {
  if ($port.IsOpen) { $port.Close() }
}
Remove-Item -Path '${filePS}' -ErrorAction SilentlyContinue
`
  try {
    await runPS(script)
  } catch (e) {
    try { fs.unlinkSync(tempFile) } catch {}
    throw e
  }
}

// ── Enviar buffer via impressora Windows (USB direto, sem porta COM) ──────────
// Usa a API winspool.drv (RAW) — bypassa driver de formatação, envia ESC/POS direto
async function escreveImpressoraWindows(nomeImpressora, buffer) {
  const tempFile = path.join(os.tmpdir(), `cheffya-print-${Date.now()}.bin`)
  fs.writeFileSync(tempFile, buffer)

  const nomePS = nomeImpressora.replace(/'/g, "''")
  const filePS = tempFile.replace(/\\/g, '\\\\').replace(/'/g, "''")

  // Usa winspool.drv via Add-Type para enviar bytes RAW (ESC/POS) sem driver de formatação
  const script = `
$ErrorActionPreference = 'Stop'
# Só define a classe se ainda não existir (evita erro "type already exists")
if (-not ([System.Management.Automation.PSTypeName]'RawPrint').Type) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class RawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)] public struct DOCINFO {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterA")] public static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
  [DllImport("winspool.Drv", EntryPoint="ClosePrinter")] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA")] public static extern int StartDocPrinter(IntPtr h, int lv, ref DOCINFO di);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter")] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter")] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter")] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter")] public static extern bool WritePrinter(IntPtr h, byte[] b, int n, out int w);
}
"@
}
$h = [IntPtr]::Zero
if (-not [RawPrint]::OpenPrinter('${nomePS}', [ref]$h, [IntPtr]::Zero)) { throw "Falha ao abrir impressora: ${nomePS}" }
try {
  $di = New-Object RawPrint+DOCINFO
  $di.pDocName  = 'Cheffya'
  $di.pDataType = 'RAW'
  $dh = [RawPrint]::StartDocPrinter($h, 1, [ref]$di)
  if ($dh -le 0) { throw "StartDocPrinter falhou (retornou $dh)" }
  [RawPrint]::StartPagePrinter($h) | Out-Null
  $bytes = [System.IO.File]::ReadAllBytes('${filePS}')
  $w = 0
  if (-not [RawPrint]::WritePrinter($h, $bytes, $bytes.Length, [ref]$w)) { throw 'WritePrinter falhou' }
  [RawPrint]::EndPagePrinter($h) | Out-Null
  [RawPrint]::EndDocPrinter($h) | Out-Null
  Write-Host "OK:$w"
} finally {
  [RawPrint]::ClosePrinter($h) | Out-Null
  Remove-Item -Path '${filePS}' -ErrorAction SilentlyContinue
}
`
  try {
    await runPS(script, 15000)
  } catch (e) {
    try { fs.unlinkSync(tempFile) } catch {}
    throw e
  }
}

// ── Listar dispositivos de impressão (COM + impressoras Windows USB) ──────────
async function listarPortas() {
  const resultados = []

  // 1. Portas COM (serial, USB-serial virtual, Bluetooth SPP)
  try {
    const out = await runPS('[System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object', 5000)
    if (out) {
      out.split(/\r?\n/)
        .map(s => s.trim())
        .filter(s => /^COM\d+$/i.test(s))
        .forEach(p => resultados.push({ path: p.toUpperCase(), descricao: 'Porta serial / USB-serial / Bluetooth' }))
    }
  } catch {}

  // 2. Impressoras Windows instaladas (USB direto, rede, etc.) — exclui PDF/Fax/XPS
  try {
    const out = await runPS(
      `Get-Printer | Where-Object { $_.Name -notmatch 'PDF|XPS|Fax|OneNote|Microsoft' } | Select-Object -ExpandProperty Name`,
      5000
    )
    if (out) {
      out.split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean)
        .forEach(nome => resultados.push({ path: nome, descricao: 'Impressora USB / Rede (Windows)' }))
    }
  } catch {}

  return resultados
}

// ── Verificar se dispositivo está acessível ───────────────────────────────────
async function verificarPorta(dispositivo) {
  if (ehPortaCOM(dispositivo)) {
    const portaPS = dispositivo.replace(/'/g, "''")
    try {
      const out = await runPS(`
try { $p = New-Object System.IO.Ports.SerialPort('${portaPS}',9600); $p.Open(); $p.Close(); Write-Host 'OK' }
catch { Write-Host "ERRO:$($_.Exception.Message)" }
`, 5000)
      return out.startsWith('OK')
    } catch { return false }
  } else {
    // Impressora Windows: verifica se está na lista
    try {
      const nomePS = dispositivo.replace(/'/g, "''")
      const out = await runPS(`(Get-Printer -Name '${nomePS}' -ErrorAction SilentlyContinue) -ne $null`, 3000)
      return out.trim() === 'True'
    } catch { return false }
  }
}

// ── Imprimir pedido ───────────────────────────────────────────────────────────
async function imprimir(pedido, nomeLoja, dispositivo, larguraPapel = 58) {
  if (!dispositivo) throw new Error('Nenhum dispositivo configurado. Configure em Alterar porta / impressora.')
  const dados = montarEscPos(pedido, nomeLoja, larguraPapel)
  log.info(`Imprimindo ${dados.length} bytes em "${dispositivo}" (papel ${larguraPapel}mm)`)
  if (ehPortaCOM(dispositivo)) {
    await escrevePortaCOM(dispositivo, dados)
  } else {
    await escreveImpressoraWindows(dispositivo, dados)
  }
  log.info(`Impressão concluída`)
}

// ── Testar impressora ─────────────────────────────────────────────────────────
async function testar(dispositivo, larguraPapel = 58) {
  const pedidoTeste = {
    id: 'TESTE01',
    canal: 'balcao',
    data: new Date().toLocaleDateString('pt-BR'),
    hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
    itens: [
      { nome: 'X-Burguer Especial', quantidade: 2, precoUnit: 25.90, opcoes: [{ nome: 'Sem cebola' }] },
      { nome: 'Coca-Cola 2L',       quantidade: 1, precoUnit: 15.00, opcoes: [] },
    ],
    forma_pagamento: 'pix',
    obs: `Teste ${larguraPapel}mm — ${larguraPapel === 80 ? 42 : 32} colunas`,
  }
  await imprimir(pedidoTeste, 'CHEFFYA', dispositivo, larguraPapel)
}

module.exports = { imprimir, testar, listarPortas, verificarPorta, montarEscPos }

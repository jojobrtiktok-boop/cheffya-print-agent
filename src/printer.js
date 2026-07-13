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

const SIZE_NORMAL_REAL = [GS, 0x21, 0x00]
const SIZE_HIGH   = [GS, 0x21, 0x01]   // altura dobrada (largura igual — não muda colunas)
const SIZE_DOUBLE = [GS, 0x21, 0x11]
// SIZE_NORMAL é mutável: no modo "letra maior" vira altura dobrada, então TODO o texto
// (que reseta para SIZE_NORMAL) sai maior — sem quebrar o alinhamento das colunas.
let SIZE_NORMAL = SIZE_NORMAL_REAL

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
// ── Helpers de negrito ────────────────────────────────────────────────────────
const BOLD_ON      = [ESC, 0x45, 0x01]
const BOLD_OFF_REAL = [ESC, 0x45, 0x00]
// BOLD_OFF é mutável: no modo "forte" vira [] (vazio), então o "desliga negrito"
// não faz nada e TODO o texto sai em negrito (forma mais eficaz de escurecer em
// impressora térmica — double-strike sozinho costuma não ter efeito visível).
let BOLD_OFF = BOLD_OFF_REAL
// Double-strike: reforço extra (em térmica o efeito principal vem do negrito).
const DOUBLE_STRIKE_ON = [ESC, 0x47, 0x01]

// Linha em negrito
function linhaN(txt, cols) {
  return [...BOLD_ON, ...toBytes((txt || '').slice(0, cols)), LF, ...BOLD_OFF]
}
// Linha normal (sem negrito)
function linhaL(txt, cols) {
  return [...BOLD_OFF, ...toBytes((txt || '').slice(0, cols)), LF]
}
// Duas colunas: esquerda bold, direita normal, alinhado à direita
function duasColB(esq, dir, cols) {
  const d = (dir || '').slice(0, Math.ceil(cols / 2))
  const e = (esq || '').slice(0, cols - d.length - 1)
  const esp = ' '.repeat(Math.max(1, cols - e.length - d.length))
  return [...BOLD_ON, ...toBytes(e), ...BOLD_OFF, ...toBytes(esp + d), LF]
}
// Nome do item (bold) + preço, sem cortar o nome: quebra em linhas por palavra.
// O preço entra na última linha se couber; senão vai em linha própria à direita.
function nomePreco(esq, dir, cols) {
  const nome  = semAcento(esq || '')
  const preco = (dir || '').toString()
  const palavras = nome.split(' ')
  const linhas = []
  let atual = ''
  for (const w of palavras) {
    const tentativa = atual ? atual + ' ' + w : w
    if (tentativa.length <= cols) {
      atual = tentativa
    } else {
      if (atual) linhas.push(atual)
      if (w.length > cols) {
        let resto = w
        while (resto.length > cols) { linhas.push(resto.slice(0, cols)); resto = resto.slice(cols) }
        atual = resto
      } else {
        atual = w
      }
    }
  }
  if (atual) linhas.push(atual)
  if (linhas.length === 0) linhas.push('')

  const out = []
  if (preco) {
    const ultima = linhas[linhas.length - 1]
    if (ultima.length + 1 + preco.length <= cols) {
      for (let i = 0; i < linhas.length - 1; i++) out.push(...BOLD_ON, ...toBytes(linhas[i]), LF, ...BOLD_OFF)
      const esp = ' '.repeat(Math.max(1, cols - ultima.length - preco.length))
      out.push(...BOLD_ON, ...toBytes(ultima), ...BOLD_OFF, ...toBytes(esp + preco), LF)
    } else {
      for (const l of linhas) out.push(...BOLD_ON, ...toBytes(l), LF, ...BOLD_OFF)
      const esp = ' '.repeat(Math.max(0, cols - preco.length))
      out.push(...toBytes(esp + preco), LF)
    }
  } else {
    for (const l of linhas) out.push(...BOLD_ON, ...toBytes(l), LF, ...BOLD_OFF)
  }
  return out
}

// Linha com label bold + valor normal na mesma linha: "Label: valor"
function linhaLV(label, valor, cols) {
  const l = semAcento(label)
  const v = semAcento(valor || '').slice(0, cols - l.length)
  return [...BOLD_ON, ...toBytes(l), ...BOLD_OFF, ...toBytes(v), LF]
}

// modoVia: 'completo' (com preços) | 'cozinha' (sem preços, sem total)
function montarEscPos(pedido, nomeLoja = '', larguraPapel = 58, modoVia = 'completo', forte = false, fonteGrande = false, cnpj = '') {
  const b = []
  const { N: COLS_N, H: COLS_H } = getCols(larguraPapel)
  const semPreco = modoVia === 'cozinha'
  // "Letra maior": o texto normal passa a ter altura dobrada
  SIZE_NORMAL = fonteGrande ? SIZE_HIGH : SIZE_NORMAL_REAL

  const clienteNome     = pedido.cliente_nome     || pedido.clienteNome
  const clienteTelefone = pedido.cliente_telefone || pedido.clienteTelefone
  const enderecoEntrega = pedido.endereco_entrega || pedido.enderecoEntrega
  const formaPagamento  = pedido.forma_pagamento  || pedido.formaPagamento
  const plataformaTaxa  = Number(pedido.plataforma_taxa || pedido.plataformaTaxa || 0)
  const labelPgto = {
    dinheiro: 'Dinheiro', pix: 'PIX', cartaoCredito: 'Credito',
    cartaoDebito: 'Debito', cartao: 'Cartao', pixWhatsapp: 'PIX WPP',
  }

  // Modo "forte": negrito permanente (BOLD_OFF vira no-op) + double-strike de reforço.
  // OBS: comandos de densidade/aquecimento (ESC 7 / DC2 #) foram REMOVIDOS porque, em
  // papel 80mm (linha mais larga), faziam a impressora borrar tudo virando "código de
  // barras". Negrito + double-strike escurecem com segurança em qualquer largura.
  BOLD_OFF = forte ? [] : BOLD_OFF_REAL
  // ── Reset completo (recupera a impressora de qualquer modo travado) ──
  // Alguns clones de impressora térmica não limpam tudo só com ESC @; mandar a
  // sequência completa abaixo garante que cada impressão começa "limpa" e desfaz
  // qualquer modo gráfico/codepage/tamanho que tenha ficado preso de uma vez anterior.
  b.push(0x18)               // CAN — cancela dados/buffer de linha pendente
  b.push(ESC, 0x40)          // ESC @ — inicializa
  b.push(ESC, 0x74, 0x00)    // ESC t 0 — codepage padrão (PC437)
  b.push(ESC, 0x21, 0x00)    // ESC ! 0 — limpa modo de impressão (Font A, sem ênfase/duplo)
  b.push(GS, 0x21, 0x00)     // GS ! 0 — tamanho normal
  b.push(ESC, 0x32)          // ESC 2 — espaçamento de linha padrão
  b.push(ESC, 0x61, 0x00)    // ESC a 0 — alinhar à esquerda
  // Define explicitamente margem esquerda 0 e área de impressão conforme o papel.
  // Algumas 80mm vêm de fábrica com área de 58mm e embolam ("código de barras") quando
  // recebem linha mais larga — forçar a área correta resolve sem mexer no firmware.
  b.push(GS, 0x4C, 0x00, 0x00)   // GS L 0 — margem esquerda = 0
  if (larguraPapel === 80) {
    b.push(GS, 0x57, 0x40, 0x02) // GS W 576 — área de impressão = 576 dots (80mm)
  } else {
    b.push(GS, 0x57, 0x80, 0x01) // GS W 384 — área de impressão = 384 dots (58mm)
  }
  b.push(...BOLD_OFF_REAL)   // ESC E 0 — negrito off
  b.push(...SIZE_NORMAL)     // aplica o tamanho deste job (normal ou "letra maior")
  if (forte) {
    // Só negrito permanente. O double-strike (passada dupla) foi REMOVIDO porque em
    // térmica 80mm o papel anda entre as passadas e BORRA o texto (vira mancha ilegível).
    b.push(...BOLD_ON)
  }

  // ── Cabeçalho (SIZE_NORMAL + bold, centralizado pelo ESC — sem padding manual,
  //    senão o texto é centralizado duas vezes e sai deslocado) ──
  b.push(ESC, 0x61, 0x01)
  b.push(...SIZE_NORMAL)
  b.push(...BOLD_ON)
  if (nomeLoja) b.push(...toBytes(nomeLoja.toUpperCase().slice(0, COLS_N)), LF)
  // CNPJ abaixo do nome da loja (configurado no painel — vazio = não imprime)
  if (cnpj) {
    b.push(...BOLD_OFF)
    b.push(...toBytes(`CNPJ: ${String(cnpj)}`.slice(0, COLS_N)), LF)
    b.push(...BOLD_ON)
  }

  const canalLabel = {
    ifood: 'iFOOD', ifood2: 'iFOOD 2', '99food': '99FOOD',
    keeta: 'KEETA', delivery: 'DELIVERY', balcao: 'BALCAO',
  }
  const canal   = canalLabel[pedido.canal] || (pedido.canal || 'PEDIDO').toUpperCase()
  b.push(...toBytes(canal.slice(0, COLS_N)), LF)

  const numPedido = pedido.numero_pedido ?? pedido.numeroPedido
  // Código curto: mantém só o código da plataforma (iFood/99/Keeta — usado p/ casar no app).
  // O código aleatório do balcão/delivery próprio sai fora quando já tem Nº pra identificar.
  const shortIdPlataforma = pedido.ifood_short_id || pedido.ifoodShortId
  if (shortIdPlataforma) {
    b.push(...toBytes(`#${String(shortIdPlataforma).toUpperCase()}`.slice(0, COLS_N)), LF)
  } else if (numPedido == null || numPedido === '') {
    const sid = (pedido.id || '----').replace(/_coz$/, '').slice(-6)
    b.push(...toBytes(`#${sid.toUpperCase()}`.slice(0, COLS_N)), LF)
  }

  // Número sequencial do pedido (por restaurante, 0001..9999)
  if (numPedido != null && numPedido !== '') {
    const numFmt = String(numPedido).padStart(4, '0')
    b.push(...SIZE_NORMAL, ...BOLD_ON, ...toBytes(`No ${numFmt}`.slice(0, COLS_N)), LF, ...BOLD_OFF)
  }

  b.push(...SIZE_NORMAL)
  b.push(...BOLD_OFF)
  b.push(...toBytes(`${pedido.data || ''} ${pedido.hora || ''}`.trim().slice(0, COLS_N)), LF)
  b.push(ESC, 0x61, 0x00)
  b.push(LF)
  b.push(...SIZE_NORMAL, ...BOLD_OFF, ...toBytes('-'.repeat(COLS_N)), LF)

  // ── Mesa ──
  const nomeMesa = pedido.nomeMesa || pedido.nome_mesa
  if (nomeMesa) {
    b.push(ESC, 0x61, 0x01)
    b.push(...BOLD_ON, ...toBytes(`MESA: ${nomeMesa.toUpperCase()}`), LF, ...BOLD_OFF)
    b.push(ESC, 0x61, 0x00)
    b.push(...SIZE_NORMAL, ...BOLD_OFF, ...toBytes('-'.repeat(COLS_N)), LF)
  }

  // ── Cliente + Endereço (juntos, sem separador entre eles) ──
  if (clienteNome)     b.push(...linhaLV('Cliente: ', clienteNome, COLS_N))
  if (clienteTelefone) b.push(...linhaLV('Tel: ', clienteTelefone, COLS_N))
  if (enderecoEntrega) {
    if (enderecoEntrega === 'Retirada no local') {
      b.push(...linhaN('Retirada no local', COLS_N))
    } else {
      // Label "Entrega:" bold + primeira parte do endereço na mesma linha
      const end = semAcento(enderecoEntrega)
      const maxFirst = COLS_N - 9
      b.push(...BOLD_ON, ...toBytes('Entrega: '), ...BOLD_OFF, ...toBytes(end.slice(0, maxFirst)), LF)
      for (let i = maxFirst; i < end.length; i += COLS_N)
        b.push(...linhaL(end.slice(i, i + COLS_N), COLS_N))
    }
  }

  // ── Itens ──
  // Só repete o separador se houve bloco de cliente/endereço — sem ele, o separador
  // do cabeçalho já está logo acima (evita dois traços com linha em branco no meio)
  if (clienteNome || clienteTelefone || enderecoEntrega) {
    b.push(ESC, 0x4A, 6)
    b.push(...SIZE_NORMAL, ...BOLD_OFF, ...toBytes('-'.repeat(COLS_N)), LF)
  }
  b.push(...linhaN('ITENS:', COLS_N))
  b.push(ESC, 0x4A, 8)

  let totalItens = 0
  for (const item of parseArr(pedido.itens)) {
    if (!item || typeof item !== 'object') continue
    const nomeRaw  = item.ifoodItemName || item.nome || 'Item'
    const qtd      = item.quantidade || 1
    const preco    = (item.precoUnit || 0) * qtd
    totalItens += preco

    const variacoes        = parseArr(item.variacoes)
    const gruposEscolhidos = parseArr(item.gruposEscolhidos)
    const tamanhoNome      = item.tamanho?.nome || ''
    // Remove sufixo entre parênteses do final do nome: "(m)", "(g)", "(média)", "(2L)" etc.
    const cleanV = (nome) => {
      if (!nome) return nome
      return nome.replace(/\s*\(.*\)\s*$/, '').trim() || nome
    }

    const temGruposSabores = gruposEscolhidos.length > 0
    const nomeProduto = cleanV(nomeRaw.split(' (')[0]) || nomeRaw.split(' (')[0]
    let nomeExibir = nomeProduto
    // 1 sabor só E o nome do item já é o próprio sabor (delivery salva assim): mostra o sabor como título
    if (variacoes.length === 1 && !temGruposSabores && cleanV(variacoes[0].nome) === nomeProduto) nomeExibir = cleanV(variacoes[0].nome)

    // Nome + preço (negrito) — quebra o nome em linhas em vez de cortar
    const precoStr = !semPreco ? `R$${preco.toFixed(2)}` : ''
    b.push(...nomePreco(`${qtd}x ${nomeExibir}`, precoStr, COLS_N))

    // Tamanho do produto customizável (ex: "Serve 2 pessoas") — só quando tem tamanho ativo
    // e o produto NÃO estiver marcado como "não imprimir o nome do tamanho".
    if (tamanhoNome && !item.tamanho?.naoImprimir) b.push(...linhaL(`  ${semAcento(tamanhoNome)}`, COLS_N))

    // Sabores simples
    if (!temGruposSabores && variacoes.length === 1 && cleanV(variacoes[0].nome) !== nomeProduto) {
      // 1 sabor com produto diferente (ex: Pizza Grande → 3 Queijos): sabor na linha de baixo
      b.push(...linhaL(`  1x ${cleanV(variacoes[0].nome)}`, COLS_N))
    } else if (variacoes.length > 1 && !temGruposSabores) {
      const frac = variacoes.length === 2 ? '1/2' : '1/3'
      for (const v of variacoes) b.push(...linhaL(`  ${frac} ${cleanV(v.nome)}`, COLS_N))
    }

    // Grupos de sabores — label bold, cada variação em linha separada
    for (const grupo of gruposEscolhidos) {
      if (!grupo?.titulo) continue
      const vars = parseArr(grupo.variacoes)
      if (!vars.length) continue
      // naoImprimir: oculta SÓ o título do grupo (ex: "Blend:"); os sabores continuam.
      if (!grupo.naoImprimir) b.push(...linhaN(`  ${grupo.titulo}:`, COLS_N))
      const ident = grupo.naoImprimir ? '  ' : '    '   // sem título, sabor menos indentado
      for (const v of vars) {
        const nomeV = cleanV(v.nome || '')
        const qtdV  = v.quantidade || v.qtd || 1
        b.push(...linhaL(`${ident}${qtdV > 1 ? qtdV + 'x ' : ''}${nomeV}`, COLS_N))
      }
    }

    // Opções agrupadas por grupoNome — label bold, itens normais
    const opcoes = parseArr(item.opcoes)
    if (opcoes.length > 0) {
      const grupos = []
      const mapaIdx = {}
      for (const op of opcoes) {
        if (!op?.nome) continue
        const chave = op.grupoNome || ''
        if (mapaIdx[chave] === undefined) { mapaIdx[chave] = grupos.length; grupos.push({ nome: chave, itens: [] }) }
        grupos[mapaIdx[chave]].itens.push(op)
      }
      for (const g of grupos) {
        if (g.nome) b.push(...linhaN(`  ${g.nome}:`, COLS_N))
        for (const op of g.itens)
          b.push(...linhaL(`    ${op.qtd > 1 ? op.qtd + 'x ' : ''}${cleanV(op.nome)}`, COLS_N))
      }
    }

    // Borda
    if (item.borda) {
      b.push(...linhaN(`  Borda:`, COLS_N))
      b.push(...linhaL(`    ${item.borda.nome}`, COLS_N))
    }

    // Complementos
    const comps = parseArr(item.complementosEscolhidos)
    if (comps.length > 0) {
      b.push(...linhaN(`  Complementos:`, COLS_N))
      for (const c of comps) if (c?.nome) b.push(...linhaL(`    ${c.qtd > 1 ? c.qtd + 'x ' : ''}${cleanV(c.nome)}`, COLS_N))
    }

    // Adicionais
    const adics = parseArr(item.adicionaisEscolhidos)
    if (adics.length > 0) {
      b.push(...linhaN(`  Adicionais:`, COLS_N))
      for (const a of adics) if (a?.nome) b.push(...linhaL(`    ${a.qtd > 1 ? a.qtd + 'x ' : ''}${cleanV(a.nome)}`, COLS_N))
    }

    // Obs do item
    if (item.obs) b.push(...linhaLV('  Obs: ', semAcento(String(item.obs)), COLS_N))

    b.push(ESC, 0x4A, 12)  // ESC J 12 — avanço de meia linha entre itens (metade do LF normal)
  }

  // ── Totais (só na via completa) ──
  b.push(...SIZE_NORMAL, ...BOLD_OFF, ...toBytes('-'.repeat(COLS_N)), LF)

  if (!semPreco) {
    if (plataformaTaxa > 0) {
      b.push(...duasColB('Taxa de entrega:', `R$${plataformaTaxa.toFixed(2)}`, COLS_N))
      b.push(ESC, 0x4A, 6)   // espaço mínimo
    }
    const total = totalItens + plataformaTaxa
    b.push(...duasColB('TOTAL:', `R$${total.toFixed(2)}`, COLS_N))
    b.push(ESC, 0x4A, 8)     // espaço pequeno entre total e pagamento
    if (formaPagamento) b.push(...linhaLV('Pagamento: ', labelPgto[formaPagamento] || formaPagamento, COLS_N))
    if (pedido.obs) {
      const obs = semAcento(String(pedido.obs))
      b.push(...BOLD_ON, ...toBytes('Obs: '), ...BOLD_OFF)
      for (let i = 0; i < obs.length; i += COLS_N - 5)
        b.push(...linhaL((i === 0 ? '' : '     ') + obs.slice(i, i + COLS_N - 5), COLS_N))
    }
    b.push(...SIZE_NORMAL, ...BOLD_OFF, ...toBytes('-'.repeat(COLS_N)), LF)
    b.push(ESC, 0x61, 0x01)
    b.push(ESC, 0x21, 0x09)  // Font B (pequena) + negrito
    b.push(...toBytes('Sistema Cheffya'), LF)
    b.push(...toBytes('www.cheffya.com.br'), LF)
    b.push(ESC, 0x21, 0x00)  // volta Font A normal
    b.push(ESC, 0x61, 0x00)
  } else {
    if (pedido.obs) {
      const obs = semAcento(String(pedido.obs))
      b.push(...BOLD_ON, ...toBytes('Obs: '), ...BOLD_OFF)
      for (let i = 0; i < obs.length; i += COLS_N - 5)
        b.push(...linhaL((i === 0 ? '' : '     ') + obs.slice(i, i + COLS_N - 5), COLS_N))
      b.push(LF)
      b.push(...SIZE_NORMAL, ...BOLD_OFF, ...toBytes('-'.repeat(COLS_N)), LF)
    }
  }

  b.push(LF, LF, LF)               // avanço até a barra de corte (reduzido)
  b.push(GS, 0x56, 0x42, 0x00)     // GS V 66 0 — corte parcial ESC/POS

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
async function imprimir(pedido, nomeLoja, dispositivo, larguraPapel = 58, modoVia = 'completo', forte = false, fonteGrande = false, cnpj = '') {
  if (!dispositivo) throw new Error('Nenhum dispositivo configurado. Configure em Alterar porta / impressora.')
  const dados = montarEscPos(pedido, nomeLoja, larguraPapel, modoVia, forte, fonteGrande, cnpj)
  log.info(`Imprimindo ${dados.length} bytes em "${dispositivo}" (papel ${larguraPapel}mm, via=${modoVia})`)
  if (ehPortaCOM(dispositivo)) {
    await escrevePortaCOM(dispositivo, dados)
  } else {
    await escreveImpressoraWindows(dispositivo, dados)
  }
  log.info(`Impressão concluída`)
}

// ── Testar impressora ─────────────────────────────────────────────────────────
async function testar(dispositivo, larguraPapel = 58, forte = false, fonteGrande = false, cnpj = '') {
  let versao = '?'
  try { versao = require('../package.json').version } catch {}
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
    obs: `Agente v${versao} | ${larguraPapel}mm | ${forte ? 'FORTE: SIM' : 'forte: nao'}`,
  }
  await imprimir(pedidoTeste, 'CHEFFYA', dispositivo, larguraPapel, 'completo', forte, fonteGrande, cnpj)
}

module.exports = { imprimir, testar, listarPortas, verificarPorta, montarEscPos }

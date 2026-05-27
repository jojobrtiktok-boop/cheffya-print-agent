// printer.js — ESC/POS + serialport
// Portado de src/utils/impressora.js da app web (Menu Control)

const { SerialPort } = require('serialport')
const log = require('./logger')

// ── ESC/POS constantes ────────────────────────────────────────────────────────
const ESC = 0x1B
const GS  = 0x1D
const LF  = 0x0A

const COLS_N = 32
const COLS_H = 32
const COLS_D = 16

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

// ── Montar bytes ESC/POS ──────────────────────────────────────────────────────
function montarEscPos(pedido, nomeLoja = '') {
  const b = []

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
  for (const item of pedido.itens || []) {
    const nomeRaw  = item.ifoodItemName || item.nome || 'Item'
    const qtd      = item.quantidade || 1
    const preco    = (item.precoUnit || 0) * qtd
    totalItens += preco

    const variacoes   = item.variacoes || []
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
    for (const op of item.opcoes || [])
      if (op.nome) b.push(...linha(`  + ${op.nome}${op.qtd > 1 ? ` x${op.qtd}` : ''}`, COLS_H))
    for (const c of item.complementosEscolhidos || [])
      if (c.nome) b.push(...linha(`  + ${c.nome}${c.qtd > 1 ? ` x${c.qtd}` : ''}`, COLS_H))
    for (const a of item.adicionaisEscolhidos || [])
      if (a.nome) b.push(...linha(`  + ${a.nome}${a.qtd > 1 ? ` x${a.qtd}` : ''}`, COLS_H))
    if (item.obs) b.push(...linha(`  Obs: ${item.obs}`, COLS_H))
  }

  // Totais
  b.push(...SIZE_NORMAL)
  b.push(...separador('=', COLS_N))
  if (plataformaTaxa > 0) {
    b.push(...SIZE_HIGH)
    b.push(...duasColunas('Taxa entrega:', `R$${plataformaTaxa.toFixed(2)}`, COLS_H))
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
  b.push(LF, LF, LF)

  return Buffer.from(b)
}

// ── Listar portas COM disponíveis ─────────────────────────────────────────────
async function listarPortas() {
  const portas = await SerialPort.list()
  return portas
    .filter(p => p.path.startsWith('COM') || p.path.startsWith('/dev/'))
    .map(p => ({ path: p.path, descricao: p.manufacturer || p.friendlyName || '' }))
}

// ── Imprimir (open → write → drain → close por job) ──────────────────────────
async function imprimir(pedido, nomeLoja, portaCOM) {
  if (!portaCOM) throw new Error('Nenhuma porta COM configurada. Configure em Alterar porta COM.')

  const dados = montarEscPos(pedido, nomeLoja)

  await new Promise((resolve, reject) => {
    const porta = new SerialPort({ path: portaCOM, baudRate: 9600, autoOpen: false })

    porta.open(err => {
      if (err) return reject(new Error(`Erro ao abrir ${portaCOM}: ${err.message}`))

      porta.write(dados, err2 => {
        if (err2) {
          porta.close(() => {})
          return reject(new Error(`Erro ao escrever em ${portaCOM}: ${err2.message}`))
        }

        porta.drain(err3 => {
          porta.close(() => {})
          if (err3) return reject(new Error(`Erro no drain ${portaCOM}: ${err3.message}`))
          resolve()
        })
      })
    })

    porta.on('error', err => reject(new Error(`Porta ${portaCOM}: ${err.message}`)))
  })

  log.info(`Imprimiu pedido #${pedido.id || pedido.ifood_short_id || '?'} em ${portaCOM}`)
}

// ── Testar impressora ─────────────────────────────────────────────────────────
async function testar(portaCOM) {
  const pedidoTeste = {
    id: 'TESTE01',
    canal: 'balcao',
    data: new Date().toLocaleDateString('pt-BR'),
    hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
    itens: [
      { nome: 'X-Burguer Especial', quantidade: 2, precoUnit: 25.90, opcoes: [{ nome: 'Sem cebola' }] },
      { nome: 'Coca-Cola 2L',        quantidade: 1, precoUnit: 15.00, opcoes: [] },
    ],
    forma_pagamento: 'pix',
    obs: 'Pedido de teste do agente',
  }
  await imprimir(pedidoTeste, 'CHEFFYA', portaCOM)
}

module.exports = { imprimir, testar, listarPortas, montarEscPos }

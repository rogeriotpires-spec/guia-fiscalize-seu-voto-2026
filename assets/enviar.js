/* Envie seu boletim: lê o QR Code no aparelho (ZXing, com jsQR de reserva),
   preenche a seção, comprime as fotos e envia para a ponte, que guarda no Drive. */
(function () {
  'use strict';
  const PONTE = 'https://script.google.com/macros/s/AKfycbwpl594yIsZJIdtunWGalH4uxJVCvwVKOpdX9eakG1YdV-uBkOHOIf3M2xhTFE_zAndpQ/exec';
  const $ = (id) => document.getElementById(id);
  const MAX_ARQ = 5, MAX_LADO = 2200, MAX_PDF = 9 * 1024 * 1024;
  let arquivos = []; // {nome, tipo, url, qr:[], blob}
  let munis = null, munCodigo = '', lido = {};

  function status(t, cls) { const s = $('status'); s.textContent = t; s.className = 'status ' + (cls || ''); }
  function norm(s) { return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }
  const carregando = fetch('../data/2t/municipios.json').then(r => r.json()).then(d => { munis = d; listaMun(); }).catch(() => {});
  function listaMun() {
    const uf = $('uf').value, dl = $('lista-mun'); dl.textContent = '';
    if (!munis || !munis[uf]) return;
    Object.values(munis[uf]).sort().forEach(n => { const o = document.createElement('option'); o.value = n; dl.appendChild(o); });
  }
  function codigoMun() {
    const uf = $('uf').value, n = norm($('municipio').value);
    if (!munis || !munis[uf]) return '';
    for (const [c, nome] of Object.entries(munis[uf])) if (norm(nome) === n) return c;
    return '';
  }
  $('uf').addEventListener('change', listaMun);

  // ---------- leitura do QR Code ----------
  let zxPronto = null;
  function zx() {
    if (zxPronto) return zxPronto;
    zxPronto = (async () => {
      if (!window.ZXingWASM) throw new Error('sem zxing');
      window.ZXingWASM.prepareZXingModule({ overrides: { locateFile: (p) => '../assets/vendor/zxing/' + p }, fireImmediately: true });
      await window.ZXingWASM.prepareZXingModule({ fireImmediately: true });
      return window.ZXingWASM;
    })();
    zxPronto.catch(() => { zxPronto = null; });
    return zxPronto;
  }
  function carregar(file) {
    return new Promise((ok, erro) => {
      const url = URL.createObjectURL(file); const img = new Image();
      img.onload = () => ok({ img, url }); img.onerror = () => { URL.revokeObjectURL(url); erro(new Error('imagem')); };
      img.src = url;
    });
  }
  function desenhar(img, maxLado) {
    const s = Math.min(1, maxLado / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
    c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  function completo(textos) {
    const frs = textos.filter(t => /^QRBU:/.test(t));
    if (!frs.length) return false;
    const m = frs[0].match(/^QRBU:(\d+):(\d+)/);
    return m && new Set(frs.map(t => t.match(/^QRBU:(\d+)/)[1])).size >= +m[2];
  }
  async function lerQR(img) {
    const achados = new Set();
    const addZX = async (c) => {
      try {
        const Z = await zx(); const ctx = c.getContext('2d', { willReadFrequently: true });
        const rs = await Z.readBarcodes(ctx.getImageData(0, 0, c.width, c.height), { formats: ['QRCode'], tryHarder: true, tryRotate: true, tryDownscale: true, maxNumberOfSymbols: 8 });
        rs.forEach(r => { if (r.text) achados.add(r.text); });
      } catch (_) { /* zxing indisponível */ }
    };
    const addJS = (c) => {
      if (!window.jsQR) return;
      const ctx = c.getContext('2d', { willReadFrequently: true }), w = c.width, h = c.height;
      const tenta = (x, y, tw, th) => { try { const d = ctx.getImageData(x, y, tw, th); const r = window.jsQR(d.data, tw, th, { inversionAttempts: 'dontInvert' }); if (r && r.data) achados.add(r.data); } catch (_) { /* nada */ } };
      tenta(0, 0, w, h);
      for (const [fx, fy] of [[1, 0.5], [1, 0.34], [0.6, 0.6]]) {
        const tw = Math.round(w * fx), th = Math.round(h * fy);
        for (let y = 0; y + th <= h; y += Math.round(th / 2)) for (let x = 0; x + tw <= w; x += Math.max(1, Math.round(tw / 2))) tenta(x, y, tw, th);
      }
    };
    for (const lado of [1800, 2800, 1200]) {
      const c = desenhar(img, lado);
      await addZX(c);
      if (completo([...achados])) break;
      addJS(c);
      if (completo([...achados])) break;
    }
    return [...achados];
  }
  function interpretar(textos) {
    const g = {};
    for (const t of textos) {
      if (!/^QRBU:/.test(t)) continue;
      for (const tk of t.split(/\s+/)) { const i = tk.indexOf(':'); if (i > 0) { const k = tk.slice(0, i); if (!(k in g)) g[k] = tk.slice(i + 1); } }
    }
    return g;
  }
  function listar() {
    const ul = $('lista'); ul.textContent = '';
    arquivos.forEach((a, i) => {
      const li = document.createElement('li');
      if (a.url) { const im = document.createElement('img'); im.src = a.url; im.alt = ''; li.appendChild(im); }
      else { const d = document.createElement('div'); d.className = 'pdf'; d.textContent = 'PDF'; li.appendChild(d); }
      const s = document.createElement('span'); s.textContent = a.qr.length ? '✓ QR lido' : 'sem QR'; s.className = a.qr.length ? 'ok' : ''; li.appendChild(s);
      const b = document.createElement('button'); b.type = 'button'; b.textContent = 'remover'; b.className = 'remover';
      b.addEventListener('click', () => { arquivos.splice(i, 1); listar(); avaliar(); });
      li.appendChild(b); ul.appendChild(li);
    });
  }
  async function adicionar(files) {
    status('Lendo o QR Code…');
    for (const f of files) {
      if (arquivos.length >= MAX_ARQ) { status(`Máximo de ${MAX_ARQ} arquivos por envio.`, 'aviso'); break; }
      if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
        if (f.size > MAX_PDF) { status('PDF acima de 9 MB. Envie uma foto no lugar.', 'aviso'); continue; }
        arquivos.push({ nome: f.name, tipo: 'application/pdf', url: null, qr: [], blob: f }); continue;
      }
      try {
        const { img, url } = await carregar(f);
        const qr = await lerQR(img);
        const grande = desenhar(img, MAX_LADO);
        const blob = await new Promise(ok => grande.toBlob(ok, 'image/jpeg', 0.86));
        arquivos.push({ nome: f.name, tipo: 'image/jpeg', url: desenhar(img, 400).toDataURL('image/jpeg', 0.6), qr, blob });
        URL.revokeObjectURL(url);
      } catch (_) { status('Não consegui abrir uma das fotos. Tente outra.', 'aviso'); }
    }
    listar(); await carregando; avaliar();
  }
  function avaliar() {
    const textos = arquivos.flatMap(a => a.qr);
    lido = interpretar(textos);
    const conf = $('confirmacao'), form = $('form');
    if (!arquivos.length) { conf.hidden = true; form.hidden = true; $('mais-qr').hidden = true; status(''); return; }
    const uf = (lido.UNFE || '').toUpperCase();
    const nome = munis && munis[uf] && lido.MUNI ? munis[uf][String(+lido.MUNI)] : '';
    if (uf && nome && lido.ZONA && lido.SECA) {
      $('uf').value = uf; listaMun(); $('municipio').value = nome; $('zona').value = +lido.ZONA; $('secao').value = +lido.SECA;
      const r = document.querySelector(`input[name=turno][value="${lido.TURN === '1' ? '1' : '2'}"]`); if (r) r.checked = true;
      $('r-uf').textContent = uf; $('r-mun').textContent = nome; $('r-zona').textContent = +lido.ZONA; $('r-secao').textContent = +lido.SECA;
      $('r-turno').textContent = (lido.TURN === '1' ? '1º turno' : '2º turno') + (completo(textos) ? ' · todos os QR Codes lidos' : ' · falta um QR Code do boletim, mas o envio já vale');
      form.hidden = true; conf.hidden = false; $('mais-qr').hidden = completo(textos);
      status(completo(textos) ? 'QR Code lido. Confira e confirme.' : 'Li parte do QR Code. Se puder, fotografe os outros QR Codes de perto.', 'ok');
      conf.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      conf.hidden = true; form.hidden = false; $('mais-qr').hidden = false;
      status('Não consegui ler o QR Code. Fotografe o QR Code de perto, ou preencha os dados da seção abaixo.', 'aviso');
    }
  }
  $('fotos').addEventListener('change', (e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) adicionar(f); });
  $('fotos-qr').addEventListener('change', (e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) adicionar(f); });
  $('corrigir').addEventListener('click', () => { $('confirmacao').hidden = true; $('form').hidden = false; $('form').scrollIntoView({ behavior: 'smooth' }); });
  $('confirmar').addEventListener('click', () => enviar($('confirmar')));
  $('form').addEventListener('submit', (e) => { e.preventDefault(); enviar($('enviar')); });

  // ---------- envio ----------
  const sha256 = async (blob) => { try { const h = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()); return [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join(''); } catch (_) { return ''; } };
  let painel = null;
  async function jaCadastrado(uf, mun, zona, secao) {
    try {
      if (!painel) painel = await fetch('../data/bus/painel.json', { cache: 'no-cache' }).then(r => r.json());
      return painel.itens.find(i => i.uf === uf && String(i.mun) === String(mun) && i.zona === +zona && i.secao === +secao &&
        ['confere', 'confere_numeros', 'em_analise', 'na_fila', 'diverge'].includes(i.status)) || null;
    } catch (_) { return null; }
  }
  function repetido(quando, item, motivo) {
    const pop = $('popup'), caixa = pop.querySelector('.popup-caixa');
    const foto = motivo === 'foto';
    caixa.className = 'popup-caixa ' + (foto ? 'vermelho' : 'amarelo');
    $('popup-titulo').textContent = foto ? '✕ Esta foto já foi enviada' : '⚠ Boletim já cadastrado';
    $('popup-texto').textContent = foto
      ? 'Esta mesma foto já está na conferência' + (quando ? ' (recebida em ' + new Date(quando).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) + ')' : '') + '. Não precisa enviar de novo. Obrigado por fiscalizar!'
      : (item && (item.status === 'confere' || item.status === 'confere_numeros')
        ? 'O boletim desta seção já foi enviado por outra pessoa e confere com o TSE. Se o seu boletim tiver números diferentes, toque em Enviar mesmo assim.'
        : 'O boletim desta seção já está na conferência' + (quando ? ' (recebido em ' + new Date(quando).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) + ')' : '') + '. Se o seu tiver números diferentes, toque em Enviar mesmo assim.');
    $('forcar').hidden = foto;
    const q = new URLSearchParams({ uf: $('uf').value }); if (munCodigo) q.set('mun', munCodigo);
    q.set('zona', $('zona').value.trim()); q.set('secao', $('secao').value.trim());
    $('popup-ver').href = '../boletins/?' + q.toString();
    pop.hidden = false; $('popup-fechar').focus();
  }
  $('popup-fechar').addEventListener('click', () => { $('popup').hidden = true; });
  $('popup').addEventListener('click', (e) => { if (e.target.id === 'popup') $('popup').hidden = true; });
  let forcar = false;
  $('forcar').addEventListener('click', () => { forcar = true; $('popup').hidden = true; enviar($('confirmacao').hidden ? $('enviar') : $('confirmar')); });
  const b64 = (blob) => new Promise((ok, erro) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = () => erro(new Error('leitura')); r.readAsDataURL(blob); });
  async function enviar(btn) {
    const uf = $('uf').value, mun = $('municipio').value.trim(), zona = $('zona').value.trim(), secao = $('secao').value.trim();
    if (!arquivos.length) { status('Escolha pelo menos uma foto do boletim.', 'aviso'); return; }
    if (!uf || !mun || !zona || !secao) { status('Preencha estado, município, zona e seção.', 'aviso'); $('form').hidden = false; return; }
    munCodigo = codigoMun();
    const rotulo = btn.textContent; btn.disabled = true; btn.textContent = 'Enviando…';
    if (!forcar && munCodigo) {
      const item = await jaCadastrado(uf, munCodigo, zona, secao);
      if (item) { btn.disabled = false; btn.textContent = rotulo; repetido(item.data, item, 'secao'); return; }
    }
    status('Enviando… não feche a página.');
    try {
      const lista = [], shas = [];
      for (const a of arquivos) { lista.push({ nome: a.nome.slice(0, 80), tipo: a.tipo, b64: await b64(a.blob) }); const h = await sha256(a.blob); if (h) shas.push(h); }
      const corpo = {
        acao: 'enviar', uf, municipio: mun, zona, secao, shas, forcar,
        turno: (document.querySelector('input[name=turno]:checked') || {}).value === '1' ? '1º turno' : '2º turno',
        nome: $('nome').value.trim(), whats: $('whats').value.trim(), site: $('site').value, arquivos: lista,
      };
      const r = await fetch(PONTE, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(corpo), redirect: 'follow' });
      const d = await r.json();
      if (d.erro === 'repetido') { btn.disabled = false; btn.textContent = rotulo; repetido(d.quando, null, d.motivo); return; }
      if (!d.ok) throw new Error(d.erro || 'falha');
      sucesso();
    } catch (err) {
      btn.disabled = false; btn.textContent = rotulo;
      const m = String(err.message || err);
      status(m === 'tamanho' ? 'Um dos arquivos é grande demais. Tire a foto de novo ou envie menos arquivos.' :
        m === 'dados' ? 'Confira o estado, o município, a zona e a seção.' :
        'Não consegui enviar agora. Tente de novo em instantes. Se continuar, use o formulário reserva no fim da página.', 'aviso');
      $('reserva').hidden = false;
    }
  }
  function sucesso() {
    ['form', 'painel-fotos', 'confirmacao', 'contato'].forEach(id => { $(id).hidden = true; });
    const s = $('sucesso'); s.hidden = false;
    const q = new URLSearchParams({ uf: $('uf').value }); if (munCodigo) q.set('mun', munCodigo);
    q.set('zona', $('zona').value.trim()); q.set('secao', $('secao').value.trim());
    $('ver').href = '../boletins/?' + q.toString();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  $('compartilhar').addEventListener('click', async () => {
    const dados = { title: 'Fiscalize seu voto', text: 'Mande a foto do boletim de urna da sua seção para a conferência nacional.', url: 'https://fiscalize.revistatimeline.com/enviar/' };
    try { if (navigator.share) await navigator.share(dados); else { await navigator.clipboard.writeText(dados.url); $('compartilhar').textContent = 'Link copiado'; } } catch (_) { /* cancelado */ }
  });
})();

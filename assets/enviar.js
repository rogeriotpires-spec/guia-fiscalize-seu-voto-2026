/* Envie seu boletim: formulário próprio do Fiscalize. Lê o QR Code no aparelho,
   comprime as fotos e envia para a ponte (Apps Script), que guarda no Drive. */
(function () {
  'use strict';
  const PONTE = 'https://script.google.com/macros/s/AKfycbwpl594yIsZJIdtunWGalH4uxJVCvwVKOpdX9eakG1YdV-uBkOHOIf3M2xhTFE_zAndpQ/exec';
  const $ = (id) => document.getElementById(id);
  const MAX_ARQ = 5, MAX_LADO = 2200, MAX_PDF = 9 * 1024 * 1024;
  let arquivos = []; // {file, nome, tipo, url, qr:[], dataUrl}
  let munis = null, munCodigo = '';

  function status(t, cls) { const s = $('status'); s.textContent = t; s.className = 'status ' + (cls || ''); }

  // ---------- municípios ----------
  fetch('../data/2t/municipios.json').then(r => r.json()).then(d => { munis = d; listaMun(); }).catch(() => {});
  function norm(s) { return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }
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

  // ---------- fotos ----------
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
  function lerQR(c) {
    const achados = new Set();
    if (!window.jsQR) return achados;
    const ctx = c.getContext('2d', { willReadFrequently: true }), w = c.width, h = c.height;
    const tenta = (x, y, tw, th) => {
      try { const d = ctx.getImageData(x, y, tw, th); const r = window.jsQR(d.data, tw, th, { inversionAttempts: 'dontInvert' }); if (r && r.data) achados.add(r.data); } catch (_) { /* nada */ }
    };
    tenta(0, 0, w, h);
    for (const [fx, fy] of [[1, 0.5], [1, 0.34], [0.6, 0.6]]) {
      const tw = Math.round(w * fx), th = Math.round(h * fy);
      for (let y = 0; y + th <= h; y += Math.round(th / 2)) for (let x = 0; x + tw <= w; x += Math.max(1, Math.round(tw / 2))) tenta(x, y, tw, th);
    }
    return achados;
  }
  function interpretar(textos) {
    const g = {};
    for (const t of textos) {
      if (!/^QRBU:/.test(t)) continue;
      for (const tk of t.split(/\s+/)) { const i = tk.indexOf(':'); if (i > 0) { const k = tk.slice(0, i); if (!(k in g)) g[k] = tk.slice(i + 1); } }
    }
    return g;
  }
  function preencher(g) {
    let n = 0;
    if (g.UNFE && munis && munis[g.UNFE.toUpperCase()]) { $('uf').value = g.UNFE.toUpperCase(); listaMun(); n++; }
    if (g.MUNI && munis && munis[$('uf').value]) { const nome = munis[$('uf').value][String(+g.MUNI)]; if (nome) { $('municipio').value = nome; n++; } }
    if (g.ZONA) { $('zona').value = +g.ZONA; n++; }
    if (g.SECA) { $('secao').value = +g.SECA; n++; }
    if (g.TURN) { const r = document.querySelector(`input[name=turno][value="${g.TURN}"]`); if (r) r.checked = true; }
    return n;
  }
  function listar() {
    const ul = $('lista'); ul.textContent = '';
    arquivos.forEach((a, i) => {
      const li = document.createElement('li');
      if (a.url) { const im = document.createElement('img'); im.src = a.url; im.alt = ''; li.appendChild(im); }
      else { const d = document.createElement('div'); d.className = 'pdf'; d.textContent = 'PDF'; li.appendChild(d); }
      const s = document.createElement('span'); s.textContent = a.qr.length ? `QR Code lido (${a.qr.length})` : (a.tipo === 'application/pdf' ? 'PDF' : 'foto'); li.appendChild(s);
      const b = document.createElement('button'); b.type = 'button'; b.textContent = 'remover'; b.className = 'remover';
      b.addEventListener('click', () => { arquivos.splice(i, 1); listar(); });
      li.appendChild(b); ul.appendChild(li);
    });
    $('cont').textContent = arquivos.length ? `${arquivos.length} de ${MAX_ARQ} arquivos` : '';
  }
  $('fotos').addEventListener('change', async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    if (!files.length) return;
    status('Preparando as fotos…');
    for (const f of files) {
      if (arquivos.length >= MAX_ARQ) { status(`Máximo de ${MAX_ARQ} arquivos por envio.`, 'aviso'); break; }
      if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
        if (f.size > MAX_PDF) { status('PDF acima de 9 MB. Envie uma foto no lugar.', 'aviso'); continue; }
        arquivos.push({ file: f, nome: f.name, tipo: 'application/pdf', url: null, qr: [], blob: f }); continue;
      }
      try {
        const { img, url } = await carregar(f);
        const grande = desenhar(img, MAX_LADO);
        const qr = [...lerQR(desenhar(img, 1600))];
        if (!qr.length) lerQR(grande).forEach(x => qr.push(x));
        const blob = await new Promise(ok => grande.toBlob(ok, 'image/jpeg', 0.86));
        arquivos.push({ file: f, nome: f.name, tipo: 'image/jpeg', url: grande.toDataURL('image/jpeg', 0.5), qr, blob });
        URL.revokeObjectURL(url);
      } catch (_) { status('Não consegui abrir uma das fotos. Tente outra.', 'aviso'); }
    }
    listar();
    const g = interpretar(arquivos.flatMap(a => a.qr));
    const n = preencher(g);
    if (n >= 3) status('QR Code lido: estado, município, zona e seção preenchidos. Confira e envie.', 'ok');
    else if (arquivos.length) status('Fotos prontas. Preencha o estado, o município, a zona e a seção que estão no cabeçalho do boletim.');
  });

  // ---------- envio ----------
  const b64 = (blob) => new Promise((ok, erro) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = () => erro(new Error('leitura')); r.readAsDataURL(blob); });
  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const uf = $('uf').value, mun = $('municipio').value.trim(), zona = $('zona').value.trim(), secao = $('secao').value.trim();
    if (!arquivos.length) { status('Escolha pelo menos uma foto do boletim.', 'aviso'); $('fotos').focus(); return; }
    if (!uf || !mun || !zona || !secao) { status('Preencha estado, município, zona e seção.', 'aviso'); return; }
    munCodigo = codigoMun();
    const btn = $('enviar'); btn.disabled = true; btn.textContent = 'Enviando…';
    status('Enviando as fotos… não feche a página.');
    try {
      const lista = [];
      for (const a of arquivos) lista.push({ nome: a.nome.slice(0, 80), tipo: a.tipo, b64: await b64(a.blob) });
      const corpo = {
        acao: 'enviar', uf, municipio: mun, zona, secao,
        turno: (document.querySelector('input[name=turno]:checked') || {}).value === '1' ? '1º turno' : '2º turno',
        nome: $('nome').value.trim(), whats: $('whats').value.trim(), site: $('site').value, arquivos: lista,
      };
      const r = await fetch(PONTE, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(corpo), redirect: 'follow' });
      const d = await r.json();
      if (!d.ok) throw new Error(d.erro || 'falha');
      sucesso();
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Enviar boletim';
      const m = String(err.message || err);
      status(m === 'tamanho' ? 'Um dos arquivos é grande demais. Tire a foto de novo ou envie menos arquivos.' :
        m === 'dados' ? 'Confira o estado, o município, a zona e a seção.' :
        'Não consegui enviar agora. Tente de novo em instantes. Se continuar, use o formulário reserva no fim da página.', 'aviso');
      $('reserva').hidden = false;
    }
  });
  function sucesso() {
    $('form').hidden = true; $('painel-fotos').hidden = true;
    const s = $('sucesso'); s.hidden = false;
    const q = new URLSearchParams({ uf: $('uf').value }); if (munCodigo) q.set('mun', munCodigo);
    q.set('zona', $('zona').value.trim()); q.set('secao', $('secao').value.trim());
    $('ver').href = '../boletins/?' + q.toString();
    s.scrollIntoView({ behavior: 'smooth' });
  }
  $('compartilhar').addEventListener('click', async () => {
    const dados = { title: 'Fiscalize seu voto', text: 'Mande a foto do boletim de urna da sua seção para a conferência nacional.', url: 'https://fiscalize.revistatimeline.com/enviar/' };
    try { if (navigator.share) await navigator.share(dados); else { await navigator.clipboard.writeText(dados.url); $('compartilhar').textContent = 'Link copiado'; } } catch (_) { /* cancelado */ }
  });
})();

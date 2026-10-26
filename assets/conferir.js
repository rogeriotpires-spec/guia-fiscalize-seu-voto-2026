/* Confira seu BU: lê o QR Code do boletim de urna no aparelho do eleitor
   e compara com os dados oficiais do TSE (arquivos em data/2t/<uf>.json). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const fragmentos = new Map(); // índice -> {total, texto}
  const campos = ['uf', 'muni', 'zona', 'secao', 'v13', 'v22', 'bran', 'nulo'];
  let extras = {};

  // ---------- leitura de QR Code ----------
  function carregarImagem(file) {
    return new Promise((ok, erro) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); ok(img); };
      img.onerror = () => { URL.revokeObjectURL(url); erro(new Error('imagem')); };
      img.src = url;
    });
  }
  function lerRegiao(ctx, x, y, w, h) {
    const d = ctx.getImageData(x, y, w, h);
    const r = window.jsQR(d.data, w, h, { inversionAttempts: 'attemptBoth' });
    return r && r.data ? r.data : null;
  }
  async function lerQRs(file) {
    const img = await carregarImagem(file);
    const achados = new Set();
    for (const max of [1600, 2400, 1000]) {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * s), h = Math.round(img.height * s);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, w, h);
      const t = lerRegiao(ctx, 0, 0, w, h); if (t) achados.add(t);
      // varre janelas sobrepostas para achar vários QR Codes na mesma foto
      for (const [fx, fy] of [[1, 0.5], [1, 0.34], [0.5, 1], [0.6, 0.6], [1, 0.25]]) {
        const tw = Math.round(w * fx), th = Math.round(h * fy);
        for (let y = 0; y + th <= h; y += Math.round(th / 2)) {
          for (let x = 0; x + tw <= w; x += Math.max(1, Math.round(tw / 2))) {
            const r = lerRegiao(ctx, x, y, tw, th); if (r) achados.add(r);
          }
        }
      }
      if (achados.size) break;
    }
    return [...achados];
  }

  // ---------- interpretação do conteúdo do QR Code do BU ----------
  function registrarFragmento(texto) {
    const m = texto.match(/^QRBU:(\d+):(\d+)\s/);
    if (!m) return false;
    fragmentos.set(+m[1], { total: +m[2], texto });
    return true;
  }
  function conteudoCompleto() {
    if (!fragmentos.size) return null;
    const total = [...fragmentos.values()][0].total;
    const partes = [];
    for (let i = 1; i <= total; i++) {
      const f = fragmentos.get(i);
      if (!f) return { faltando: i, total };
      // remove cabeçalho (QRBU, VRQR) e o hash/assinatura do fim de cada fragmento
      let t = f.texto.replace(/^QRBU:\S+\s+VRQR:\S+\s*/, '');
      t = t.replace(/\s*HASH:[0-9A-Fa-f]+(\s+ASSI:[0-9A-Fa-f]+)?\s*$/, '');
      partes.push(t);
    }
    return { texto: partes.join(' '), total };
  }
  function interpretar(texto) {
    const tokens = texto.split(/\s+/).filter(Boolean);
    const geral = {}; const cargos = []; let atual = null;
    for (const tk of tokens) {
      const i = tk.indexOf(':'); if (i < 1) continue;
      const k = tk.slice(0, i), v = tk.slice(i + 1);
      if (k === 'CARG') { atual = { CARG: v, votos: {} }; cargos.push(atual); continue; }
      if (atual) {
        if (/^\d+$/.test(k)) atual.votos[k] = +v; else atual[k] = v;
      } else geral[k] = v;
    }
    const pres = cargos.find(c => c.CARG === '1') || cargos[0];
    return { geral, pres };
  }
  function preencherDoQR() {
    const c = conteudoCompleto();
    if (!c) return;
    if (c.faltando) { status(`Lidos ${fragmentos.size} de ${c.total} QR Codes. Falta o QR Code nº ${c.faltando}.`); return; }
    const { geral, pres } = interpretar(c.texto);
    if (!pres) { status('QR Code lido, mas não encontrei o cargo de presidente.'); return; }
    if (geral.TURN && geral.TURN !== '2') status('Atenção: este boletim é do ' + geral.TURN + 'º turno. A conferência automática cobre o 2º turno.');
    $('uf').value = (geral.UNFE || '').toUpperCase();
    $('muni').value = +geral.MUNI || '';
    $('zona').value = +geral.ZONA || '';
    $('secao').value = +geral.SECA || '';
    $('v13').value = pres.votos['13'] ?? '';
    $('v22').value = pres.votos['22'] ?? '';
    $('bran').value = pres.BRAN ?? '';
    $('nulo').value = pres.NULO ?? '';
    extras = { apto: +geral.APTO, comp: +geral.COMP, nomi: +pres.NOMI, totc: +pres.TOTC, idue: geral.IDUE, hrfc: geral.HRFC };
    status(`QR Code lido com sucesso (${c.total} de ${c.total}). Confira os números abaixo com o papel.`);
    checarConta();
  }
  function status(t) { $('qr-status').textContent = t; }
  function listarQR() {
    const ul = $('qr-lista'); ul.textContent = '';
    const total = fragmentos.size ? [...fragmentos.values()][0].total : 0;
    for (let i = 1; i <= total; i++) {
      const li = document.createElement('li');
      li.textContent = `QR ${i}/${total} ${fragmentos.has(i) ? '✓' : '…'}`;
      if (fragmentos.has(i)) li.className = 'ok';
      ul.appendChild(li);
    }
  }
  $('fotos').addEventListener('change', async (e) => {
    const files = [...e.target.files]; if (!files.length) return;
    if (!window.jsQR) { status('O leitor de QR Code ainda está carregando. Tente de novo em instantes.'); return; }
    status('Lendo ' + files.length + (files.length > 1 ? ' fotos…' : ' foto…'));
    let lidos = 0, outros = 0;
    for (const f of files) {
      try {
        const textos = await lerQRs(f);
        for (const t of textos) { if (registrarFragmento(t)) lidos++; else outros++; }
      } catch (_) { /* foto ilegível */ }
    }
    listarQR();
    if (!lidos) {
      status(outros ? 'Li um QR Code, mas ele não é de boletim de urna.' :
        'Não consegui ler nenhum QR Code. Tente uma foto mais de perto, com boa luz e sem cortar as bordas, ou digite os números abaixo.');
      return;
    }
    preencherDoQR();
    e.target.value = '';
  });

  // ---------- conferência da conta interna ----------
  function n(id) { const v = $(id).value.trim(); return v === '' ? null : +v; }
  function checarConta() {
    const el = $('checagem'); el.className = 'checagem'; el.textContent = '';
    const v13 = n('v13'), v22 = n('v22'), b = n('bran'), nu = n('nulo');
    if ([v13, v22, b, nu].some(x => x === null)) return;
    const msgs = [];
    if (extras.nomi && v13 + v22 !== extras.nomi) msgs.push(`Lula + Flávio (${v13 + v22}) difere do total nominal do boletim (${extras.nomi}).`);
    if (extras.totc && v13 + v22 + b + nu !== extras.totc) msgs.push(`Nominais + brancos + nulos (${v13 + v22 + b + nu}) difere do total apurado (${extras.totc}).`);
    if (msgs.length) { el.className = 'checagem aviso'; el.textContent = msgs.join(' '); }
    else if (extras.totc) el.textContent = `Conta interna do boletim confere: ${v13} + ${v22} + ${b} + ${nu} = ${extras.totc}.`;
  }
  campos.forEach(id => $(id).addEventListener('input', () => {
    if (['v13', 'v22', 'bran', 'nulo'].includes(id)) checarConta();
  }));

  // ---------- comparação com o TSE ----------
  const pad = (v, k) => String(v).padStart(k, '0');
  function linkTSE(uf, mu, zn, se) {
    const u = uf.toLowerCase();
    return `https://resultados.tse.jus.br/oficial/app/index.html#/eleicao;e=e6258;uf=${u};mu=${pad(mu, 5)};ufbu=${u};mubu=${pad(mu, 5)};zn=${pad(zn, 4)};se=${pad(se, 4)}/dados-de-urna/boletim-de-urna`;
  }
  const cache = {};
  async function dadosUF(uf) {
    if (uf in cache) return cache[uf];
    try {
      const r = await fetch(`../data/2t/${uf.toLowerCase()}.json`, { cache: 'no-cache' });
      cache[uf] = r.ok ? await r.json() : null;
    } catch (_) { cache[uf] = null; }
    return cache[uf];
  }
  $('form-bu').addEventListener('submit', async (e) => {
    e.preventDefault();
    const uf = $('uf').value, mu = n('muni'), zn = n('zona'), se = n('secao');
    const meu = { v13: n('v13'), v22: n('v22'), bran: n('bran'), nulo: n('nulo') };
    if (!uf || mu === null || zn === null || se === null || Object.values(meu).some(x => x === null)) {
      $('checagem').className = 'checagem aviso';
      $('checagem').textContent = 'Preencha UF, município, zona, seção e os quatro números do boletim.';
      return;
    }
    const sec = $('resultado'); sec.hidden = false;
    $('link-tse').href = linkTSE(uf, mu, zn, se);
    const tab = $('res-tabela'); tab.textContent = '';
    const selo = $('res-selo'), txt = $('res-texto');
    selo.className = 'selo neutro'; selo.textContent = 'Consultando os dados oficiais…'; txt.textContent = '';
    const dados = await dadosUF(uf);
    const nomes = { v13: 'Lula (13)', v22: 'Flávio Bolsonaro (22)', bran: 'Brancos', nulo: 'Nulos' };
    const oficial = dados && dados.secoes ? dados.secoes[`${mu}-${zn}-${se}`] : null;
    if (!dados) {
      selo.textContent = 'Base oficial do 2º turno ainda em preparação';
      txt.textContent = 'O TSE ainda não publicou o arquivo aberto com o resultado de cada seção do 2º turno. Enquanto isso, abra o boletim oficial da sua seção pelo botão abaixo e compare os números com os do seu papel.';
      for (const k in nomes) addLinha(tab, nomes[k], meu[k], '—', false);
      sec.scrollIntoView({ behavior: 'smooth' }); return;
    }
    if (!oficial) {
      selo.textContent = 'Seção não encontrada';
      txt.textContent = 'Não encontrei essa combinação de município, zona e seção no arquivo do TSE. Confira os números do cabeçalho do boletim (o código do município é o número ao lado do nome da cidade).';
      sec.scrollIntoView({ behavior: 'smooth' }); return;
    }
    const of = { v13: oficial[0], v22: oficial[1], bran: oficial[2], nulo: oficial[3] };
    let difs = 0;
    for (const k in nomes) { const d = meu[k] !== of[k]; if (d) difs++; addLinha(tab, nomes[k], meu[k], of[k], d); }
    if (!difs) {
      selo.className = 'selo ok'; selo.textContent = '✓ Confere com o TSE';
      txt.textContent = 'Os números do seu boletim são idênticos aos publicados pelo TSE para esta seção. O resultado que saiu da sua urna chegou igual. Envie a foto para a conferência nacional, para ela entrar na contagem.';
    } else {
      selo.className = 'selo bad'; selo.textContent = `✗ ${difs} ${difs > 1 ? 'campos diferentes' : 'campo diferente'}`;
      txt.textContent = 'Antes de tudo, confira se os números digitados são os do papel e se o boletim é do 2º turno e desta seção. Se a diferença se mantiver, guarde a foto original, envie pelo formulário da conferência nacional e registre a ocorrência na ficha do guia. Não divulgue a imagem sem antes ter a confirmação.';
    }
    sec.scrollIntoView({ behavior: 'smooth' });
  });
  function addLinha(tab, nome, a, b, dif) {
    const tr = document.createElement('tr'); if (dif) tr.className = 'dif';
    for (const v of [nome, a, b]) { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); }
    tab.appendChild(tr);
  }
})();

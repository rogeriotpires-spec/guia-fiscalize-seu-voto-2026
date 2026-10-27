/* Boletins enviados: placar e busca da conferência nacional (data/bus/painel.json). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const DESCARTE = ['nao_e_bu', 'via_digital', 'primeiro_turno', 'repetida'];
  const POR_PAGINA = 40;
  let dados = null, filtrados = [], mostrados = 0;

  const fmt = (n) => (n ?? 0).toLocaleString('pt-BR');
  const grupo = (s) => (s === 'confere' || s === 'confere_numeros') ? 'confere' : DESCARTE.includes(s) ? 'descartado' : s === 'na_fila' ? 'em_analise' : s;
  const classe = (s) => ({ confere: 'ok', em_analise: 'neutro', nao_encontrada: 'neutro', ilegivel: 'cinza', descartado: 'cinza' })[grupo(s)] || 'neutro';

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt !== undefined) e.textContent = txt;
    return e;
  }

  function placar() {
    const p = dados.placar, s = p.por_status || {};
    const soma = (ks) => ks.reduce((a, k) => a + (s[k] || 0), 0);
    const cards = [
      ['Envios recebidos', fmt(p.envios), ''],
      ['Seções conferidas', fmt(p.secoes_conferidas), 'cada seção conta uma vez'],
      ['Conferem com o TSE', fmt(p.secoes_conferem), p.secoes_conferidas ? `${Math.round(100 * p.secoes_conferem / p.secoes_conferidas)}% das seções conferidas` : ''],
      ['Em análise', fmt(soma(['em_analise', 'nao_encontrada', 'na_fila'])), s.na_fila ? `${fmt(s.na_fila)} ainda na fila de leitura` : 'aguardando confirmação'],
      ['Ilegíveis', fmt(s.ilegivel || 0), 'pedimos nova foto'],
      ['Descartados', fmt(soma(DESCARTE)), 'não é boletim, 1º turno, repetidas, via digital'],
    ];
    const box = $('placar'); box.textContent = '';
    cards.forEach(([t, v, d], i) => {
      const c = el('div', 'card' + (i === 2 ? ' destaque' : ''));
      c.append(el('span', 'valor', v), el('span', 'titulo', t));
      if (d) c.append(el('span', 'detalhe', d));
      box.append(c);
    });
    const at = new Date(dados.atualizado);
    $('atualizado').textContent = 'Atualizado em ' + at.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }) + ' (horário de Brasília). Atualização automática a cada 30 minutos.';
  }

  function opcoesUF() {
    const ufs = [...new Set(dados.itens.map(i => i.uf).filter(Boolean))].sort();
    const sel = $('f-uf');
    ufs.forEach(u => { const o = el('option', '', u); o.value = u; sel.append(o); });
  }
  function opcoesMun() {
    const uf = $('f-uf').value, sel = $('f-mun');
    sel.textContent = ''; const t = el('option', '', 'Todos'); t.value = ''; sel.append(t);
    sel.disabled = !uf;
    if (!uf) return;
    const m = new Map();
    dados.itens.filter(i => i.uf === uf && i.mun).forEach(i => m.set(i.mun, i.municipio || i.mun));
    [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR')).forEach(([c, n]) => {
      const o = el('option', '', n); o.value = c; sel.append(o);
    });
  }

  function filtrar() {
    const uf = $('f-uf').value, mun = $('f-mun').value, st = $('f-status').value;
    const zn = parseInt($('f-zona').value, 10), se = parseInt($('f-secao').value, 10);
    filtrados = dados.itens.filter(i =>
      (!uf || i.uf === uf) && (!mun || i.mun === mun) &&
      (isNaN(zn) || i.zona === zn) && (isNaN(se) || i.secao === se) &&
      (!st || grupo(i.status) === st));
    mostrados = 0; $('lista').textContent = '';
    $('contagem').textContent = filtrados.length ? `${fmt(filtrados.length)} ${filtrados.length > 1 ? 'envios encontrados' : 'envio encontrado'}` : 'Nenhum envio encontrado com esses filtros.';
    mais();
  }

  function cartao(i) {
    const c = el('article', 'bu');
    const topo = el('div', 'bu-topo');
    const onde = el('div', 'bu-onde');
    onde.append(el('strong', '', i.municipio ? `${i.municipio} (${i.uf})` : (i.uf || 'Local não informado')));
    const zs = [i.zona ? `Zona ${i.zona}` : '', i.secao ? `Seção ${i.secao}` : ''].filter(Boolean).join(' · ');
    if (zs) onde.append(el('span', '', zs));
    topo.append(onde, el('span', 'tag ' + classe(i.status), i.rotulo));
    c.append(topo);
    if (i.lido && i.oficial) {
      const t = el('table', 'mini');
      const th = el('tr'); ['', 'Boletim', 'TSE'].forEach(x => th.append(el('th', '', x)));
      t.append(th);
      ['Lula (13)', 'Flávio (22)', 'Brancos', 'Nulos'].forEach((n, k) => {
        const tr = el('tr', i.lido[k] !== i.oficial[k] ? 'dif' : '');
        tr.append(el('td', '', n), el('td', '', fmt(i.lido[k])), el('td', '', fmt(i.oficial[k])));
        t.append(tr);
      });
      c.append(t);
      if (i.fonte) c.append(el('p', 'fonte', 'Comparação feita pelo ' + (i.fonte === 'QR Code' ? 'QR Code do boletim' : i.fonte === 'leitura dos números' ? 'texto impresso do boletim' : 'conferência manual da foto') + '.'));
    }
    if (i.fotos && i.fotos.length) {
      const g = el('div', 'fotos');
      i.fotos.forEach((f, k) => {
        const b = el('button', 'foto'); b.type = 'button';
        b.setAttribute('aria-label', `Ampliar foto ${k + 1} do boletim`);
        const im = el('img'); im.loading = 'lazy'; im.src = '../' + f; im.alt = `Foto ${k + 1} do boletim`;
        b.append(im); b.addEventListener('click', () => abrir('../' + f)); g.append(b);
      });
      c.append(g);
    }
    const rod = el('p', 'rodape', 'Recebido em ' + i.data.split('-').reverse().join('/'));
    if (i.uf && i.mun && i.zona && i.secao) {
      const a = el('a', '', 'ver no TSE ↗');
      const u = i.uf.toLowerCase(), m = String(i.mun).padStart(5, '0');
      a.href = `https://resultados.tse.jus.br/oficial/app/index.html#/eleicao;e=e6258;uf=${u};mu=${m};ufbu=${u};mubu=${m};zn=${String(i.zona).padStart(4, '0')};se=${String(i.secao).padStart(4, '0')}/dados-de-urna/boletim-de-urna`;
      a.target = '_blank'; a.rel = 'noopener noreferrer';
      rod.append(' · ', a);
    }
    c.append(rod);
    return c;
  }

  function mais() {
    const lista = $('lista');
    filtrados.slice(mostrados, mostrados + POR_PAGINA).forEach(i => lista.append(cartao(i)));
    mostrados = Math.min(filtrados.length, mostrados + POR_PAGINA);
    $('mais').hidden = mostrados >= filtrados.length;
  }

  function abrir(src) {
    $('visor-img').src = src; $('visor').hidden = false; $('visor-fechar').focus();
  }
  function fechar() { $('visor').hidden = true; $('visor-img').src = ''; }
  $('visor-fechar').addEventListener('click', fechar);
  $('visor').addEventListener('click', (e) => { if (e.target.id === 'visor') fechar(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('visor').hidden) fechar(); });

  $('f-uf').addEventListener('change', () => { opcoesMun(); filtrar(); });
  ['f-mun', 'f-status'].forEach(id => $(id).addEventListener('change', filtrar));
  ['f-zona', 'f-secao'].forEach(id => $(id).addEventListener('input', filtrar));
  $('mais').addEventListener('click', mais);

  fetch('../data/bus/painel.json', { cache: 'no-cache' })
    .then(r => { if (!r.ok) throw new Error(); return r.json(); })
    .then(d => {
      dados = d; placar(); opcoesUF();
      const q = new URLSearchParams(location.search);
      if (q.get('uf')) { $('f-uf').value = q.get('uf').toUpperCase(); opcoesMun(); }
      if (q.get('mun')) $('f-mun').value = q.get('mun');
      if (q.get('zona')) $('f-zona').value = q.get('zona');
      if (q.get('secao')) $('f-secao').value = q.get('secao');
      filtrar();
    })
    .catch(() => {
      $('atualizado').textContent = 'A primeira rodada da conferência ainda está em andamento. Volte em alguns minutos.';
    });
})();

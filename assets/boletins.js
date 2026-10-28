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
    const conferem = soma(['confere', 'confere_numeros']);
    const analise = soma(['em_analise', 'nao_encontrada', 'na_fila']);
    const cards = [
      ['Envios recebidos', fmt(p.envios), 'cada foto enviada conta uma vez'],
      ['Conferem com o TSE', fmt(conferem), `${fmt(p.secoes_conferem)} seções distintas · ${p.secoes_conferidas ? Math.round(100 * p.secoes_conferem / p.secoes_conferidas) : 0}% das seções conferidas`],
      ['Em análise', fmt(analise), s.na_fila ? `${fmt(s.na_fila)} ainda na fila de leitura` : 'aguardando confirmação'],
      ['Ilegíveis', fmt(s.ilegivel || 0), 'pedimos nova foto'],
      ['Descartados', fmt(soma(DESCARTE)), 'não é boletim, 1º turno, repetidas, via digital'],
    ];
    const box = $('placar'); box.textContent = '';
    cards.forEach(([t, v, d], i) => {
      const c = el('div', 'card' + (i === 1 ? ' destaque' : ''));
      c.append(el('span', 'valor', v), el('span', 'titulo', t));
      if (d) c.append(el('span', 'detalhe', d));
      box.append(c);
    });
    const desc = soma(DESCARTE), ileg = s.ilegivel || 0, div = s.diverge || 0;
    const partes = [`${fmt(conferem)} conferem`].concat(div ? [`${fmt(div)} divergem`] : []).concat([`${fmt(analise)} em análise`, `${fmt(ileg)} ilegíveis`, `${fmt(desc)} descartados`]);
    box.append(el('p', 'equacao', `${partes.join(' + ')} = ${fmt(conferem + div + analise + ileg + desc)} envios`));
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
    apuracao(uf, mun, zn, se);
    $('contagem').textContent = filtrados.length ? `${fmt(filtrados.length)} ${filtrados.length > 1 ? 'envios encontrados' : 'envio encontrado'}` : 'Nenhum envio encontrado com esses filtros.';
    mais();
  }

  const BRASIL = { lula: 64256232, flavio: 59826041 };
  function apuracao(uf, mun, zn, se) {
    const vistos = new Map();
    dados.itens.forEach(i => {
      if (!(i.status === 'confere' || i.status === 'confere_numeros') || !i.lido) return;
      if ((uf && i.uf !== uf) || (mun && i.mun !== mun) || (!isNaN(zn) && i.zona !== zn) || (!isNaN(se) && i.secao !== se)) return;
      const k = `${i.uf}-${i.mun}-${i.zona}-${i.secao}`;
      if (!vistos.has(k)) vistos.set(k, i.lido);
    });
    const t = [0, 0, 0, 0];
    vistos.forEach(l => l.forEach((v, k) => { t[k] += v || 0; }));
    const validos = t[0] + t[1];
    const pct = (v, b) => b ? (100 * v / b).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%' : '0%';
    let onde = 'em todo o país';
    if (uf) {
      const m = mun && dados.itens.find(i => i.mun === mun);
      onde = m ? `em ${m.municipio} (${uf})` : `em ${uf}`;
      if (!isNaN(zn)) onde += `, zona ${zn}`;
      if (!isNaN(se)) onde += `, seção ${se}`;
    }
    $('apur-sub').textContent = `Soma dos boletins de urna enviados por eleitores ${onde} e já conferidos com o TSE. Cada seção conta uma vez.`;
    const box = $('apur-corpo'); box.textContent = '';
    if (!vistos.size) { box.append(el('p', 'muted', 'Ainda não há boletins conferidos para essa seleção.')); return; }
    const cand = [['Lula', 'PT · 13', t[0], 'lula'], ['Flávio Bolsonaro', 'PL · 22', t[1], 'flavio']];
    cand.forEach(([nome, part, v, cls]) => {
      const lin = el('div', 'cand ' + cls);
      const cab = el('div', 'cand-cab');
      const n = el('div', 'cand-nome'); n.append(el('strong', '', nome), el('span', '', part));
      const num = el('div', 'cand-num'); num.append(el('strong', '', pct(v, validos)), el('span', '', fmt(v) + ' votos'));
      cab.append(n, num);
      const barra = el('div', 'barra'); const f = el('div', 'barra-fill'); f.style.width = (validos ? 100 * v / validos : 0) + '%';
      barra.append(f); lin.append(cab, barra); box.append(lin);
    });
    const tot = t[0] + t[1] + t[2] + t[3];
    const rodape = el('dl', 'apur-resumo');
    [['Seções', fmt(vistos.size)], ['Votos válidos', fmt(validos)], ['Brancos', `${fmt(t[2])} (${pct(t[2], tot)})`], ['Nulos', `${fmt(t[3])} (${pct(t[3], tot)})`]]
      .forEach(([a, b]) => { const d = el('div'); d.append(el('dt', '', a), el('dd', '', b)); rodape.append(d); });
    box.append(rodape);
    const bv = BRASIL.lula + BRASIL.flavio;
    box.append(el('p', 'apur-ref', `Resultado oficial do TSE no Brasil: Lula ${pct(BRASIL.lula, bv)} · Flávio Bolsonaro ${pct(BRASIL.flavio, bv)}. Os boletins acima foram enviados voluntariamente e não são uma amostra do país: servem para conferir seção por seção, não para prever o total.`));
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
      dados = d;
      dados.itens.sort((a, b) => (a.status === 'na_fila') - (b.status === 'na_fila'));
      placar(); opcoesUF();
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

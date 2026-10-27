/* Resultado dos boletins: apuração só com os boletins conferidos (data/bus/painel.json). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const UFS = { AC: 'Acre', AL: 'Alagoas', AM: 'Amazonas', AP: 'Amapá', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MG: 'Minas Gerais', MS: 'Mato Grosso do Sul', MT: 'Mato Grosso', PA: 'Pará', PB: 'Paraíba', PE: 'Pernambuco', PI: 'Piauí', PR: 'Paraná', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RO: 'Rondônia', RR: 'Roraima', RS: 'Rio Grande do Sul', SC: 'Santa Catarina', SE: 'Sergipe', SP: 'São Paulo', TO: 'Tocantins' };
  const fmt = (n) => (n ?? 0).toLocaleString('pt-BR');
  const pct = (v, b, d = 2) => b ? (100 * v / b).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }) + '%' : '0%';
  const POR_PAGINA = 30;
  let secoes = [], oficial = {}, munLista = [], munMostrados = 0;

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt !== undefined) e.textContent = txt;
    return e;
  }
  function soma(lista) {
    const t = { n: lista.length, lula: 0, flavio: 0, brancos: 0, nulos: 0 };
    lista.forEach(s => { t.lula += s.v[0] || 0; t.flavio += s.v[1] || 0; t.brancos += s.v[2] || 0; t.nulos += s.v[3] || 0; });
    t.validos = t.lula + t.flavio;
    return t;
  }
  function barraDupla(t) {
    const b = el('div', 'dupla');
    const l = el('div', 'dupla-lula'); l.style.width = (t.validos ? 100 * t.lula / t.validos : 50) + '%';
    const f = el('div', 'dupla-flavio');
    b.append(l, f);
    b.setAttribute('aria-hidden', 'true');
    return b;
  }

  function totalizacao() {
    const t = soma(secoes);
    const br = oficial.BR;
    $('tot-secoes').textContent = `${fmt(t.n)} seções conferidas de ${fmt(br.secoes)} no país (${pct(t.n, br.secoes, 3)})`;
    $('tot-prog-fill').style.width = Math.max(0.5, 100 * t.n / br.secoes) + '%';
    const box = $('tot-corpo'); box.textContent = '';
    const grade = el('div', 'tot-cands');
    [['Lula', 'PT · 13', t.lula, 'lula', br.lula], ['Flávio Bolsonaro', 'PL · 22', t.flavio, 'flavio', br.flavio]].forEach(([nome, part, v, cls, of]) => {
      const c = el('div', 'tot-cand ' + cls);
      c.append(el('span', 'tot-nome', nome), el('span', 'tot-part', part), el('strong', 'tot-pct', pct(v, t.validos)),
        el('span', 'tot-votos', fmt(v) + ' votos nos boletins'),
        el('span', 'tot-of', 'TSE no Brasil: ' + pct(of, br.lula + br.flavio)));
      grade.append(c);
    });
    box.append(grade, barraDupla(t));
    const tot = t.validos + t.brancos + t.nulos;
    const r = el('dl', 'apur-resumo');
    [['Votos válidos', fmt(t.validos)], ['Brancos', `${fmt(t.brancos)} (${pct(t.brancos, tot)})`], ['Nulos', `${fmt(t.nulos)} (${pct(t.nulos, tot)})`], ['Total apurado', fmt(tot)]]
      .forEach(([a, b]) => { const d = el('div'); d.append(el('dt', '', a), el('dd', '', b)); r.append(d); });
    box.append(r);
  }

  function linhaRes(tr, t) {
    tr.append(el('td', 'num', fmt(t.n)), el('td', 'num lula-c', pct(t.lula, t.validos, 1)), el('td', 'num flavio-c', pct(t.flavio, t.validos, 1)));
    const td = el('td', 'col-barra'); td.append(barraDupla(t)); tr.append(td);
  }

  function porUF() {
    const g = {};
    secoes.forEach(s => (g[s.uf] = g[s.uf] || []).push(s));
    const tb = $('tab-uf').querySelector('tbody'); tb.textContent = '';
    Object.keys(g).sort((a, b) => g[b].length - g[a].length || a.localeCompare(b)).forEach(uf => {
      const t = soma(g[uf]); const o = oficial[uf];
      const tr = el('tr', 'clicavel'); tr.tabIndex = 0;
      const n = el('td'); n.append(el('strong', '', uf), el('span', 'uf-nome', ' ' + (UFS[uf] || '')));
      tr.append(n); linhaRes(tr, t);
      tr.append(el('td', 'of', o ? `Lula ${pct(o.lula, o.lula + o.flavio, 1)} · Flávio ${pct(o.flavio, o.lula + o.flavio, 1)}` : ''));
      const ir = () => { $('m-uf').value = uf; $('m-busca').value = ''; municipios(); $('sec-mun').scrollIntoView({ behavior: 'smooth' }); };
      tr.addEventListener('click', ir);
      tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ir(); } });
      tb.append(tr);
    });
    const sel = $('m-uf');
    Object.keys(g).sort().forEach(uf => { const o = el('option', '', `${uf} · ${UFS[uf] || ''}`); o.value = uf; sel.append(o); });
  }

  function municipios() {
    const uf = $('m-uf').value;
    const busca = $('m-busca').value.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const g = new Map();
    secoes.forEach(s => {
      if (uf && s.uf !== uf) return;
      const k = s.uf + '-' + s.mun;
      if (!g.has(k)) g.set(k, { nome: s.municipio || s.mun, uf: s.uf, lista: [] });
      g.get(k).lista.push(s);
    });
    munLista = [...g.values()]
      .filter(m => !busca || m.nome.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(busca))
      .sort((a, b) => b.lista.length - a.lista.length || a.nome.localeCompare(b.nome, 'pt-BR'));
    munMostrados = 0; $('tab-mun').querySelector('tbody').textContent = '';
    if (!munLista.length) {
      const tr = el('tr'); const td = el('td', 'muted', 'Nenhum município com boletim conferido para essa busca.'); td.colSpan = 5; tr.append(td);
      $('tab-mun').querySelector('tbody').append(tr);
    }
    maisMun();
  }
  function maisMun() {
    const tb = $('tab-mun').querySelector('tbody');
    munLista.slice(munMostrados, munMostrados + POR_PAGINA).forEach(m => {
      const tr = el('tr'); const n = el('td'); n.append(el('strong', '', m.nome), el('span', 'uf-nome', ' ' + m.uf));
      const a = el('a', 'ver', 'ver boletins');
      a.href = `../boletins/?uf=${m.uf}&mun=${m.lista[0].mun}`;
      n.append(el('br'), a);
      tr.append(n); linhaRes(tr, soma(m.lista)); tb.append(tr);
    });
    munMostrados = Math.min(munLista.length, munMostrados + POR_PAGINA);
    $('m-mais').hidden = munMostrados >= munLista.length;
  }

  $('m-uf').addEventListener('change', municipios);
  $('m-busca').addEventListener('input', municipios);
  $('m-mais').addEventListener('click', maisMun);

  Promise.all([
    fetch('../data/bus/painel.json', { cache: 'no-cache' }).then(r => r.json()),
    fetch('../data/2t/oficial_uf.json').then(r => r.json()),
  ]).then(([d, of]) => {
    oficial = of;
    const vistos = new Map();
    d.itens.forEach(i => {
      if (!(i.status === 'confere' || i.status === 'confere_numeros') || !i.lido || !i.uf || !i.mun) return;
      const k = `${i.uf}-${i.mun}-${i.zona}-${i.secao}`;
      if (!vistos.has(k)) vistos.set(k, { uf: i.uf, mun: i.mun, municipio: i.municipio, v: i.lido });
    });
    secoes = [...vistos.values()];
    const at = new Date(d.atualizado);
    $('atualizado').textContent = 'Atualizado em ' + at.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }) + ' (horário de Brasília). Atualização automática a cada 30 minutos.';
    totalizacao(); porUF(); municipios();
  }).catch(() => { $('atualizado').textContent = 'Não foi possível carregar os dados agora. Tente de novo em alguns minutos.'; });
})();

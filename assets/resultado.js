/* Resultado dos boletins: apuração só com os boletins conferidos (data/bus/painel.json). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const UFS = { AC: 'Acre', AL: 'Alagoas', AM: 'Amazonas', AP: 'Amapá', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MG: 'Minas Gerais', MS: 'Mato Grosso do Sul', MT: 'Mato Grosso', PA: 'Pará', PB: 'Paraíba', PE: 'Pernambuco', PI: 'Piauí', PR: 'Paraná', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RO: 'Rondônia', RR: 'Roraima', RS: 'Rio Grande do Sul', SC: 'Santa Catarina', SE: 'Sergipe', SP: 'São Paulo', TO: 'Tocantins' };
  const fmt = (n) => (n ?? 0).toLocaleString('pt-BR');
  const pct = (v, b, d = 2) => b ? (100 * v / b).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }) + '%' : '0%';
  const POR_PAGINA = 30;
  let secoes = [], oficial = {}, metas = null, munLista = [], munMostrados = 0;

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
    const g = {}; secoes.forEach(s => (g[s.uf] = g[s.uf] || []).push(s));
    const mn = margemNacional(g);
    if (mn) box.append(el('p', 'margem-nac', `Margem de erro desta amostra: ${fmtPP(mn.m)} (95% de confiança), considerando o peso de cada estado nos votos válidos; estados com boletim cobrem ${pct(mn.cob, 1, 1)} do eleitorado. A margem mede o erro de amostragem e não corrige o viés de quem escolhe enviar.`));
    const tot = t.validos + t.brancos + t.nulos;
    const r = el('dl', 'apur-resumo');
    [['Votos válidos', fmt(t.validos)], ['Brancos', `${fmt(t.brancos)} (${pct(t.brancos, tot)})`], ['Nulos', `${fmt(t.nulos)} (${pct(t.nulos, tot)})`], ['Total apurado', fmt(tot)]]
      .forEach(([a, b]) => { const d = el('div'); d.append(el('dt', '', a), el('dd', '', b)); r.append(d); });
    box.append(r);
  }

  function metaNacional() {
    if (!metas) return;
    const ok = secoes.length, alvo = metas.nacional, falta = Math.max(0, alvo - ok);
    $('meta-nac-alvo').textContent = fmt(alvo);
    $('meta-prazo').textContent = metas.prazo_texto;
    $('meta-nac-ok').textContent = fmt(ok);
    $('meta-nac-falta').textContent = falta ? fmt(falta) : 'meta atingida';
    $('meta-nac-pct').textContent = pct(Math.min(ok, alvo), alvo, 1);
    const dias = (new Date(metas.prazo) - Date.now()) / 86400000;
    $('meta-dias').textContent = dias <= 0 ? 'prazo encerrado' : dias < 1 ? Math.max(1, Math.round(dias * 24)) + ' h' : Math.ceil(dias) + (Math.ceil(dias) === 1 ? ' dia' : ' dias');
    $('meta-nac-fill').style.width = Math.min(100, Math.max(1, 100 * ok / alvo)) + '%';
    if (ok >= alvo) $('meta-nac-fill').classList.add('ok');
  }
  function margem(uf, n) {
    if (!metas || !metas.sigma || !metas.sigma[uf] || !n) return null;
    return 1.96 * metas.sigma[uf] / Math.sqrt(n);
  }
  function margemNacional(g) {
    if (!metas || !metas.sigma) return null;
    let v = 0, cob = 0;
    Object.keys(g).forEach(uf => { const n = g[uf].length, w = metas.peso[uf], sg = metas.sigma[uf]; if (n && w && sg) { v += (w * sg) * (w * sg) / n; cob += w; } });
    return cob ? { m: 1.96 * Math.sqrt(v), cob } : null;
  }
  const fmtPP = (x) => '±' + x.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' p.p.';
  function celMeta(n, alvo) {
    const td = el('td', 'col-meta');
    if (!alvo) { td.textContent = '–'; return td; }
    const falta = Math.max(0, alvo - n);
    const w = el('div', 'meta-mini');
    const b = el('div', 'barra fina meta-barra'); const f = el('div', 'barra-fill meta-fill' + (falta ? '' : ' ok')); f.style.width = Math.min(100, Math.max(2, 100 * n / alvo)) + '%'; b.append(f);
    w.append(el('span', 'meta-txt', `${fmt(n)} de ${fmt(alvo)}`), b, el('span', 'meta-falta' + (falta ? '' : ' ok'), falta ? `faltam ${fmt(falta)}` : '✓ meta atingida'));
    td.append(w);
    return td;
  }

  function linhaRes(tr, t) {
    tr.append(el('td', 'num', fmt(t.n)), el('td', 'num lula-c', pct(t.lula, t.validos, 1)), el('td', 'num flavio-c', pct(t.flavio, t.validos, 1)));
    const td = el('td', 'col-barra'); td.append(barraDupla(t)); tr.append(td);
  }

  function porUF() {
    const g = {};
    secoes.forEach(s => (g[s.uf] = g[s.uf] || []).push(s));
    const ufs = new Set(Object.keys(g)); if (metas) Object.keys(metas.uf).forEach(u => ufs.add(u));
    const tb = $('tab-uf').querySelector('tbody'); tb.textContent = '';
    [...ufs].sort((a, b) => ((g[b] || []).length - (g[a] || []).length) || a.localeCompare(b)).forEach(uf => {
      const lista = g[uf] || []; const t = soma(lista); const o = oficial[uf];
      const tr = el('tr', 'clicavel'); tr.tabIndex = 0;
      const n = el('td'); n.append(el('strong', '', uf), el('span', 'uf-nome', ' ' + (UFS[uf] || '')));
      tr.append(n, el('td', 'num', fmt(t.n)));
      if (lista.length) {
        tr.append(el('td', 'num lula-c', pct(t.lula, t.validos, 1)), el('td', 'num flavio-c', pct(t.flavio, t.validos, 1)));
        const td = el('td', 'col-barra'); td.append(barraDupla(t)); tr.append(td);
      } else {
        const td = el('td', 'muted', 'nenhum boletim ainda'); td.colSpan = 3; tr.append(td);
      }
      tr.append(el('td', 'of', o ? `Lula ${pct(o.lula, o.lula + o.flavio, 1)} · Flávio ${pct(o.flavio, o.lula + o.flavio, 1)}` : ''));
      // linha de apoio: meta de envios + margem de erro
      const sub = el('tr', 'sub'); const sd = el('td', 'sub-cel'); sd.colSpan = 6;
      const alvo = metas ? metas.uf[uf] : 0; const mg = margem(uf, t.n);
      const bl = el('div', 'sub-meta'); bl.append(el('span', 'sub-rotulo', 'Meta de envios'));
      bl.append(...[...celMeta(t.n, alvo).childNodes]);
      const mb = el('div', 'sub-margem'); mb.append(el('span', 'sub-rotulo', 'Margem de erro'), el('strong', '', mg ? fmtPP(mg) : (lista.length ? '–' : 'sem boletins')));
      const wrap = el('div', 'sub-cel-in'); wrap.append(bl, mb); sd.append(wrap); sub.append(sd);
      if (lista.length) {
        const ir = () => { $('m-uf').value = uf; $('m-busca').value = ''; municipios(); $('sec-mun').scrollIntoView({ behavior: 'smooth' }); };
        tr.addEventListener('click', ir);
        tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ir(); } });
      } else tr.classList.remove('clicavel');
      tb.append(tr, sub);
      return;
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
    fetch('../data/2t/metas.json', { cache: 'no-cache' }).then(r => r.json()).catch(() => null),
  ]).then(([d, of, m]) => {
    oficial = of; metas = m;
    const vistos = new Map();
    d.itens.forEach(i => {
      if (!(i.status === 'confere' || i.status === 'confere_numeros') || !i.lido || !i.uf || !i.mun) return;
      const k = `${i.uf}-${i.mun}-${i.zona}-${i.secao}`;
      if (!vistos.has(k)) vistos.set(k, { uf: i.uf, mun: i.mun, municipio: i.municipio, v: i.lido });
    });
    secoes = [...vistos.values()];
    const at = new Date(d.atualizado);
    $('atualizado').textContent = 'Atualizado em ' + at.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }) + ' (horário de Brasília). Atualização automática a cada 30 minutos.';
    totalizacao(); metaNacional(); porUF(); municipios();
    if (metas && metas.metodo) $('metodo-margem').textContent = metas.metodo + ' Exemplo: um estado com σ = 12 e 36 seções conferidas tem margem de 1,96 × 12 ÷ 6 = ±3,9 pontos.';
  }).catch(() => { $('atualizado').textContent = 'Não foi possível carregar os dados agora. Tente de novo em alguns minutos.'; });
})();

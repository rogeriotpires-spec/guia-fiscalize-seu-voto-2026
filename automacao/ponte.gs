/**
 * Ponte Fiscalize – entrega ao robô do GitHub as respostas e os arquivos do
 * formulário "Fiscalize seu BU" e grava o painel interno (restrito) no Drive.
 * Roda na conta do Rogerio. Toda chamada exige a senha (TOKEN) guardada nas
 * propriedades do script; sem ela, nada é devolvido.
 */
const FORM_ID = '1I5Dtwl42Ix2hc24trXyLfz7p1negFX_7Ftqs6-CYAso';
const PASTA_UPLOADS = '17QfifUvxcFO45Y08e31PVLSY3StIWu5lchADy5cSFI7Jk3mJduviHsgIE_hobU7gRo9m5SsF';
const PASTA_RELATORIOS = '14bbCRZvg_iQyCGpEbU904F6LuZWBq6SU';
const NOME_PLANILHA = 'Fiscalize – Painel interno (restrito)';

/** Rode UMA vez pelo editor: cria a senha e a planilha e mostra a senha no registro. */
function configurar() {
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('TOKEN')) p.setProperty('TOKEN', (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''));
  planilha_();
  DriveApp.getFolderById(PASTA_UPLOADS).getName(); // pede a autorização do Drive
  FormApp.openById(FORM_ID).getTitle();            // pede a autorização do Forms
  Logger.log('SENHA DA PONTE (copie para o GitHub): ' + p.getProperty('TOKEN'));
}

function planilha_() {
  const p = PropertiesService.getScriptProperties();
  const id = p.getProperty('PLANILHA');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) { /* recria */ } }
  const ss = SpreadsheetApp.create(NOME_PLANILHA);
  DriveApp.getFileById(ss.getId()).moveTo(DriveApp.getFolderById(PASTA_RELATORIOS));
  p.setProperty('PLANILHA', ss.getId());
  return ss;
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function autorizado_(t) {
  const ok = PropertiesService.getScriptProperties().getProperty('TOKEN');
  return ok && t && t === ok;
}

function doGet(e) {
  const q = e.parameter || {};
  if (!autorizado_(q.t)) return json_({ erro: 'nao autorizado' });
  if (q.acao === 'respostas') return json_(respostas_());
  if (q.acao === 'arquivo') return json_(arquivo_(q.id));
  if (q.acao === 'marcacoes') return json_(marcacoes_());
  return json_({ erro: 'acao desconhecida' });
}

function respostas_() {
  const form = FormApp.openById(FORM_ID);
  return form.getResponses().map(r => ({
    id: r.getId(),
    ts: r.getTimestamp().toISOString(),
    itens: r.getItemResponses().map(ir => ({ t: ir.getItem().getTitle(), tipo: String(ir.getItem().getType()), v: ir.getResponse() }))
  }));
}

function arquivo_(id) {
  const f = DriveApp.getFileById(id);
  // só entrega arquivos enviados pelo formulário
  let ok = false; const it = f.getParents();
  while (it.hasNext()) if (it.next().getId() === PASTA_UPLOADS) ok = true;
  if (!ok) return { erro: 'fora da pasta do formulario' };
  const b = f.getBlob();
  return { mime: b.getContentType(), b64: Utilities.base64Encode(b.getBytes()) };
}

/** Devolve o que o Rogerio preencheu à mão nas colunas editáveis:
 *  {aba: {chave: {coluna: valor}}}. */
function marcacoes_() {
  const ss = planilha_(); const out = {};
  const cfg = JSON.parse(PropertiesService.getScriptProperties().getProperty('EDITAVEIS') || '{}');
  for (const aba of Object.keys(cfg)) {
    const sh = ss.getSheetByName(aba); out[aba] = {};
    if (!sh || sh.getLastRow() < 2) continue;
    const v = sh.getDataRange().getValues(); const h = v[0]; const ic = h.indexOf('chave');
    v.slice(1).forEach(r => {
      const o = {}; let tem = false;
      cfg[aba].forEach(c => { const i = h.indexOf(c); if (i >= 0 && r[i] !== '' && r[i] !== false) { o[c] = r[i]; tem = true; } });
      if (tem) out[aba][String(r[ic])] = o;
    });
  }
  return out;
}

/** Recebe {t, abas:{nome:[[cabeçalho],[linha]...]}, editaveis:{aba:[colunas]}, caixas:{aba:[colunas]}}
 *  e reescreve as abas, preservando o que o Rogerio preencheu nas colunas editáveis. */
function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  if (!autorizado_(body.t)) return json_({ erro: 'nao autorizado' });
  const ed = body.editaveis || {}, cx = body.caixas || {};
  PropertiesService.getScriptProperties().setProperty('EDITAVEIS', JSON.stringify(ed));
  const ss = planilha_();
  for (const nome of Object.keys(body.abas)) {
    let linhas = body.abas[nome];
    let sh = ss.getSheetByName(nome) || ss.insertSheet(nome);
    if (ed[nome]) linhas = preservar_(sh, linhas, ed[nome]);
    sh.clear();
    if (!linhas.length) continue;
    const w = Math.max.apply(null, linhas.map(l => l.length));
    linhas = linhas.map(l => l.concat(Array(w - l.length).fill('')));
    sh.getRange(1, 1, linhas.length, w).setValues(linhas);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, w).setFontWeight('bold');
    (cx[nome] || []).forEach(c => {
      const i = linhas[0].indexOf(c) + 1;
      if (i > 0 && linhas.length > 1) sh.getRange(2, i, linhas.length - 1, 1).insertCheckboxes();
    });
  }
  const padrao = ss.getSheetByName('Sheet1') || ss.getSheetByName('Página1');
  if (padrao && ss.getSheets().length > 1) ss.deleteSheet(padrao);
  return json_({ ok: true, url: ss.getUrl() });
}

function preservar_(sh, linhas, cols) {
  if (sh.getLastRow() < 2 || !linhas.length) return linhas;
  const v = sh.getDataRange().getValues(); const h = v[0]; const ic = h.indexOf('chave');
  const m = {}; v.slice(1).forEach(r => { m[String(r[ic])] = r; });
  const nh = linhas[0]; const nc = nh.indexOf('chave');
  return [nh].concat(linhas.slice(1).map(l => {
    const old = m[String(l[nc])]; if (!old) return l;
    const c = l.slice();
    cols.forEach(col => { const i = h.indexOf(col), j = nh.indexOf(col); if (i >= 0 && j >= 0) c[j] = old[i]; });
    return c;
  }));
}

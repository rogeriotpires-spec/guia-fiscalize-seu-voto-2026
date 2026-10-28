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
const PASTA_BUS = '1_lutnr7D9vLzhbrKnnz-eNmExXJSJRcf';   // 02 BUs enviados pelo público
const NOME_ENVIOS = 'Fiscalize – Envios pelo site';
const MAX_ARQ = 5, MAX_BYTES = 9 * 1024 * 1024;

/** Rode UMA vez pelo editor: cria a senha e a planilha e mostra a senha no registro. */
function configurar() {
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('TOKEN')) p.setProperty('TOKEN', (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''));
  planilha_();
  DriveApp.getFolderById(PASTA_UPLOADS).getName(); // pede a autorização do Drive
  FormApp.openById(FORM_ID).getTitle();            // pede a autorização do Forms
  pastaEnvios_(); planilhaEnvios_();
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

/** Pasta e planilha do formulário próprio do site. */
function pastaEnvios_() {
  const p = PropertiesService.getScriptProperties();
  const id = p.getProperty('PASTA_ENVIOS');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* recria */ } }
  const f = DriveApp.getFolderById(PASTA_BUS).createFolder('Envios pelo site');
  p.setProperty('PASTA_ENVIOS', f.getId());
  return f;
}
function planilhaEnvios_() {
  const p = PropertiesService.getScriptProperties();
  const id = p.getProperty('PLANILHA_ENVIOS');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) { /* recria */ } }
  const ss = SpreadsheetApp.create(NOME_ENVIOS);
  DriveApp.getFileById(ss.getId()).moveTo(DriveApp.getFolderById(PASTA_BUS));
  const sh = ss.getSheets()[0]; sh.setName('Envios');
  sh.appendRow(['id', 'recebido', 'uf', 'municipio', 'zona', 'secao', 'turno', 'nome', 'whatsapp', 'arquivos', 'origem']);
  sh.setFrozenRows(1);
  p.setProperty('PLANILHA_ENVIOS', ss.getId());
  return ss;
}

/** Envio público feito pelo formulário do site (sem senha). */
function enviar_(b) {
  const limpa = (v, n) => String(v == null ? '' : v).replace(/[\r\n\t]/g, ' ').trim().slice(0, n);
  const uf = limpa(b.uf, 2).toUpperCase(), mun = limpa(b.municipio, 80), zona = limpa(b.zona, 4), secao = limpa(b.secao, 4);
  if (!/^[A-Z]{2}$/.test(uf) || !mun || !/^\d{1,4}$/.test(zona) || !/^\d{1,4}$/.test(secao)) return { erro: 'dados' };
  if (b.site) return { ok: true, id: 'x' }; // campo-armadilha preenchido: robô de spam
  const arqs = (b.arquivos || []).slice(0, MAX_ARQ);
  if (!arqs.length) return { erro: 'sem_arquivo' };
  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { return { erro: 'ocupado' }; }
  try {
    const pasta = pastaEnvios_();
    const id = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
    const ids = [];
    for (let i = 0; i < arqs.length; i++) {
      const a = arqs[i] || {};
      const tipo = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/.test(a.tipo || '') ? a.tipo : 'image/jpeg';
      const bytes = Utilities.base64Decode(String(a.b64 || '').replace(/^data:[^,]*,/, ''));
      if (!bytes.length || bytes.length > MAX_BYTES) return { erro: 'tamanho' };
      const ext = tipo === 'application/pdf' ? 'pdf' : (tipo.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      const nome = uf + '-' + mun.replace(/[^\w]+/g, '_').slice(0, 30) + '-z' + zona + '-s' + secao + '-' + id + '-' + (i + 1) + '.' + ext;
      const f = pasta.createFile(Utilities.newBlob(bytes, tipo, nome));
      ids.push(f.getId());
    }
    const sh = planilhaEnvios_().getSheetByName('Envios');
    sh.appendRow([id, new Date(), uf, mun, zona, secao, limpa(b.turno, 10) || '2º turno', limpa(b.nome, 80), limpa(b.whats, 30), ids.join(','), 'site']);
    return { ok: true, id: id, arquivos: ids.length };
  } catch (e) {
    return { erro: 'falha', detalhe: String(e).slice(0, 120) };
  } finally {
    lock.releaseLock();
  }
}

function enviosSite_() {
  const sh = planilhaEnvios_().getSheetByName('Envios');
  if (!sh || sh.getLastRow() < 2) return [];
  const v = sh.getDataRange().getValues(); const h = v[0];
  const c = n => h.indexOf(n);
  return v.slice(1).filter(r => r[c('id')]).map(r => ({
    id: 'site-' + r[c('id')],
    ts: (r[c('recebido')] instanceof Date ? r[c('recebido')] : new Date(r[c('recebido')])).toISOString(),
    itens: [
      { t: 'UF', tipo: 'LIST', v: String(r[c('uf')]) },
      { t: 'Município', tipo: 'TEXT', v: String(r[c('municipio')]) },
      { t: 'Zona', tipo: 'TEXT', v: String(r[c('zona')]) },
      { t: 'Seção', tipo: 'TEXT', v: String(r[c('secao')]) },
      { t: 'Turno', tipo: 'LIST', v: String(r[c('turno')]) },
      { t: 'Foto do boletim', tipo: 'FILE_UPLOAD', v: String(r[c('arquivos')]).split(',').filter(Boolean) },
      { t: 'Nome e WhatsApp', tipo: 'TEXT', v: (String(r[c('nome')]) + ' ' + String(r[c('whatsapp')])).trim() },
    ]
  }));
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
  const doForm = form.getResponses().map(r => ({
    id: r.getId(),
    ts: r.getTimestamp().toISOString(),
    itens: r.getItemResponses().map(ir => ({ t: ir.getItem().getTitle(), tipo: String(ir.getItem().getType()), v: ir.getResponse() }))
  }));
  return doForm.concat(enviosSite_());
}

function arquivo_(id) {
  const f = DriveApp.getFileById(id);
  // só entrega arquivos enviados pelo formulário ou pelo site
  const permitidas = [PASTA_UPLOADS, pastaEnvios_().getId()];
  let ok = false; const it = f.getParents();
  while (it.hasNext()) if (permitidas.indexOf(it.next().getId()) >= 0) ok = true;
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
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (x) { return json_({ erro: 'json' }); }
  if (body.acao === 'enviar') return json_(enviar_(body));
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

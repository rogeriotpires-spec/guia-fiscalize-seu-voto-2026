/**
 * Ponte Fiscalize – Depoimentos "Votou no Flávio?".
 * Arquivo novo do mesmo projeto Apps Script da ponte. Recebe o vídeo em partes
 * (depo_parte), junta e guarda no Drive (depo_fim), registra na planilha e
 * mantém a rotina pública de apagamento das fotos de título.
 *
 * Pastas (criadas na primeira chamada, dentro de "Depoimentos – Votou no Flávio"):
 *   videos   – os depoimentos (ficam)
 *   partes   – pedaços temporários do envio (apagados ao juntar)
 *   titulos  – fotos de título (restrito; apagadas pela rotina depois da conferência)
 *
 * Planilha "Fiscalize – Depoimentos": uma linha por envio. Rogerio preenche a
 * coluna "status" (conferido ou recusado). A rotina apagarTitulosConferidos()
 * apaga a foto e carimba a data. O site mostra o contador público.
 */
const DEPO_MAX_PARTES = 12;                 // 12 × 4 MB = 48 MB
const DEPO_MAX_PARTE_BYTES = 4 * 1024 * 1024 + 1024;
const DEPO_MAX_TITULO = 3 * 1024 * 1024;
const DEPO_COLS = ['id', 'recebido', 'uf', 'municipio', 'cod_mun', 'zona_secao', 'nome', 'whatsapp', 'duracao_s', 'tamanho_mb', 'video_id', 'video_url', 'titulo_id', 'status', 'conferido_em', 'titulo_apagado_em', 'publicar', 'obs'];

function depoRaiz_() {
  const p = PropertiesService.getScriptProperties();
  let id = p.getProperty('PASTA_DEPO');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* recria */ } }
  const f = DriveApp.createFolder('Depoimentos – Votou no Flávio');
  p.setProperty('PASTA_DEPO', f.getId());
  return f;
}
function depoPasta_(nome) {
  const raiz = depoRaiz_();
  const it = raiz.getFoldersByName(nome);
  return it.hasNext() ? it.next() : raiz.createFolder(nome);
}
function depoPlanilha_() {
  const p = PropertiesService.getScriptProperties();
  const id = p.getProperty('PLANILHA_DEPO');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) { /* recria */ } }
  const ss = SpreadsheetApp.create('Fiscalize – Depoimentos');
  DriveApp.getFileById(ss.getId()).moveTo(depoRaiz_());
  const sh = ss.getSheets()[0]; sh.setName('Depoimentos');
  sh.appendRow(DEPO_COLS); sh.setFrozenRows(1); sh.getRange(1, 1, 1, DEPO_COLS.length).setFontWeight('bold');
  sh.getRange(2, DEPO_COLS.indexOf('publicar') + 1, 500, 1).insertCheckboxes();
  sh.getRange(2, DEPO_COLS.indexOf('status') + 1, 500, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['pendente', 'conferido', 'recusado']).build());
  p.setProperty('PLANILHA_DEPO', ss.getId());
  return ss;
}
function depoLimpa_(v, n) { return String(v == null ? '' : v).replace(/[\r\n\t]/g, ' ').trim().slice(0, n); }
function depoEnvioOk_(s) { return /^[a-z0-9]{8,20}$/.test(String(s || '')); }

/** Uma parte do vídeo: {envio, i, n, tipo, b64}. Sem senha (envio público). */
function depoParte_(b) {
  if (!depoEnvioOk_(b.envio)) return { erro: 'dados' };
  const i = +b.i, n = +b.n;
  if (!(n >= 1 && n <= DEPO_MAX_PARTES && i >= 0 && i < n)) return { erro: 'tamanho' };
  const bytes = Utilities.base64Decode(String(b.b64 || '').replace(/^data:[^,]*,/, ''));
  if (!bytes.length || bytes.length > DEPO_MAX_PARTE_BYTES) return { erro: 'tamanho' };
  const pasta = depoPasta_('partes');
  const nome = b.envio + '-' + ('00' + i).slice(-2) + '.part';
  const antigos = pasta.getFilesByName(nome); while (antigos.hasNext()) antigos.next().setTrashed(true);
  pasta.createFile(Utilities.newBlob(bytes, 'application/octet-stream', nome));
  return { ok: true, i: i };
}

/** Fecha o envio: junta as partes, guarda vídeo e título, registra na planilha. */
function depoFim_(b) {
  if (b.site) return { ok: true, id: 'x' };               // campo-armadilha: robô de spam
  if (!depoEnvioOk_(b.envio)) return { erro: 'dados' };
  const uf = depoLimpa_(b.uf, 2).toUpperCase(), mun = depoLimpa_(b.municipio, 80), cod = depoLimpa_(b.cod, 6), nome = depoLimpa_(b.nome, 80);
  const sec = depoLimpa_(b.secao, 12);
  if (!/^[A-Z]{2}$/.test(uf) || !mun || !nome || !b.aceite) return { erro: 'dados' };
  const n = +b.n; if (!(n >= 1 && n <= DEPO_MAX_PARTES)) return { erro: 'tamanho' };
  const tit = Utilities.base64Decode(String(b.titulo_b64 || '').replace(/^data:[^,]*,/, ''));
  if (!tit.length || tit.length > DEPO_MAX_TITULO) return { erro: 'dados' };
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); } catch (e) { return { erro: 'ocupado' }; }
  try {
    const partes = depoPasta_('partes');
    const blobs = [];
    for (let i = 0; i < n; i++) {
      const it = partes.getFilesByName(b.envio + '-' + ('00' + i).slice(-2) + '.part');
      if (!it.hasNext()) return { erro: 'partes', falta: i };
      blobs.push(it.next());
    }
    let bytes = [];
    for (const f of blobs) { const bb = f.getBlob().getBytes(); bytes = bytes.length ? bytes.concat(bb) : bb; }
    const tipo = /^video\/(mp4|quicktime|webm|3gpp|x-m4v)$/.test(b.tipo || '') ? b.tipo : 'video/mp4';
    const ext = { 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/3gpp': '3gp', 'video/x-m4v': 'm4v' }[tipo] || 'mp4';
    const base = uf + '-' + mun.replace(/[^\wÀ-ÿ]+/g, '_').slice(0, 30) + (sec ? '-zs' + sec : '') + '-' + b.envio;
    const video = depoPasta_('videos').createFile(Utilities.newBlob(bytes, tipo, base + '.' + ext));
    const titulo = depoPasta_('titulos (restrito, apagar após conferência)').createFile(Utilities.newBlob(tit, 'image/jpeg', base + '-titulo.jpg'));
    blobs.forEach(f => f.setTrashed(true));
    const sh = depoPlanilha_().getSheetByName('Depoimentos');
    const id = b.envio;
    sh.appendRow([id, new Date(), uf, mun, cod, sec, nome, depoLimpa_(b.whats, 30), +b.dur || '', Math.round((+b.tamanho || bytes.length) / 1048576 * 10) / 10, video.getId(), video.getUrl(), titulo.getId(), 'pendente', '', '', false, '']);
    return { ok: true, id: id };
  } catch (e) {
    return { erro: 'falha', detalhe: String(e).slice(0, 120) };
  } finally {
    lock.releaseLock();
  }
}

/** Contador público (sem dados pessoais): quantas fotos de título foram recebidas, conferidas e apagadas. */
function depoContador_() {
  const sh = depoPlanilha_().getSheetByName('Depoimentos');
  const out = { recebidos: 0, conferidos: 0, titulos_apagados: 0, titulos_guardados: 0, atualizado: new Date().toISOString() };
  if (!sh || sh.getLastRow() < 2) return out;
  const v = sh.getRange(2, 1, sh.getLastRow() - 1, DEPO_COLS.length).getValues();
  const cS = DEPO_COLS.indexOf('status'), cT = DEPO_COLS.indexOf('titulo_id'), cA = DEPO_COLS.indexOf('titulo_apagado_em');
  for (const r of v) {
    if (!r[0]) continue;
    out.recebidos++;
    if (r[cS] === 'conferido' || r[cS] === 'recusado') out.conferidos++;
    if (r[cA]) out.titulos_apagados++; else if (r[cT]) out.titulos_guardados++;
  }
  return out;
}

/** Rotina de apagamento: para cada linha conferida ou recusada, apaga a foto do título e carimba a data.
 *  Rode pelo editor ou instale o gatilho diário com instalarGatilhoApagar(). */
function apagarTitulosConferidos() {
  const sh = depoPlanilha_().getSheetByName('Depoimentos');
  if (!sh || sh.getLastRow() < 2) return 0;
  const n = sh.getLastRow() - 1;
  const v = sh.getRange(2, 1, n, DEPO_COLS.length).getValues();
  const cS = DEPO_COLS.indexOf('status'), cT = DEPO_COLS.indexOf('titulo_id'), cC = DEPO_COLS.indexOf('conferido_em'), cA = DEPO_COLS.indexOf('titulo_apagado_em');
  let apagados = 0;
  for (let i = 0; i < n; i++) {
    const r = v[i];
    if (!(r[cS] === 'conferido' || r[cS] === 'recusado') || !r[cT] || r[cA]) continue;
    try {
      const f = DriveApp.getFileById(String(r[cT]));
      f.setTrashed(true);
      try { Drive.Files.remove(String(r[cT])); } catch (e) { /* sem o serviço avançado, fica na lixeira 30 dias */ }
    } catch (e) { /* já não existe */ }
    if (!r[cC]) sh.getRange(i + 2, cC + 1).setValue(new Date());
    sh.getRange(i + 2, cA + 1).setValue(new Date());
    sh.getRange(i + 2, cT + 1).setValue('apagado');
    apagados++;
  }
  Logger.log('títulos apagados: ' + apagados);
  return apagados;
}
function instalarGatilhoApagar() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'apagarTitulosConferidos') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('apagarTitulosConferidos').timeBased().everyHours(1).create();
  Logger.log('gatilho instalado: apagarTitulosConferidos a cada hora');
}

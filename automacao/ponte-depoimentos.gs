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
    const titPdf = String(b.titulo_tipo || '') === 'application/pdf';
    const titulo = depoPasta_('titulos (restrito, apagar após conferência)').createFile(Utilities.newBlob(tit, titPdf ? 'application/pdf' : 'image/jpeg', base + '-titulo.' + (titPdf ? 'pdf' : 'jpg')));
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

/* ---------- conferência automática (chamadas do robô, com senha) ---------- */

/** Linhas pendentes: só o necessário para o robô conferir (sem nome nem WhatsApp). */
function depoPendentes_() {
  const sh = depoPlanilha_().getSheetByName('Depoimentos');
  if (!sh || sh.getLastRow() < 2) return { pendentes: [] };
  const v = sh.getRange(2, 1, sh.getLastRow() - 1, DEPO_COLS.length).getValues();
  const c = (n) => DEPO_COLS.indexOf(n);
  const out = [];
  v.forEach((r, i) => {
    if (!r[0] || r[c('status')] !== 'pendente' || !r[c('titulo_id')] || r[c('titulo_id')] === 'apagado') return;
    out.push({ id: r[0], linha: i + 2, uf: r[c('uf')], cod: r[c('cod_mun')], municipio: r[c('municipio')], zona_secao: r[c('zona_secao')], titulo_id: r[c('titulo_id')], obs: r[c('obs')] });
  });
  return { pendentes: out };
}

/** Entrega a foto do título ao robô (só da pasta de títulos). */
function depoTitulo_(id) {
  const f = DriveApp.getFileById(id);
  const pasta = depoPasta_('titulos (restrito, apagar após conferência)').getId();
  let ok = false; const it = f.getParents();
  while (it.hasNext()) if (it.next().getId() === pasta) ok = true;
  if (!ok) return { erro: 'fora da pasta de titulos' };
  const b = f.getBlob();
  return { mime: b.getContentType(), b64: Utilities.base64Encode(b.getBytes()) };
}

/** Resultado da conferência: {id, status, obs, zona_secao}. Se conferido ou recusado, apaga a foto na hora. */
function depoMarcar_(b) {
  const sh = depoPlanilha_().getSheetByName('Depoimentos');
  const c = (n) => DEPO_COLS.indexOf(n);
  const status = ['pendente', 'conferido', 'recusado'].indexOf(String(b.status)) >= 0 ? String(b.status) : 'pendente';
  const v = sh.getRange(2, 1, Math.max(1, sh.getLastRow() - 1), 1).getValues();
  for (let i = 0; i < v.length; i++) {
    if (String(v[i][0]) !== String(b.id)) continue;
    const lin = i + 2;
    if (b.zona_secao) sh.getRange(lin, c('zona_secao') + 1).setValue(depoLimpa_(b.zona_secao, 12));
    sh.getRange(lin, c('obs') + 1).setValue(depoLimpa_(b.obs, 300));
    if (status !== 'pendente') {
      sh.getRange(lin, c('status') + 1).setValue(status);
      sh.getRange(lin, c('conferido_em') + 1).setValue(new Date());
      const tid = String(sh.getRange(lin, c('titulo_id') + 1).getValue());
      if (tid && tid !== 'apagado') {
        try { DriveApp.getFileById(tid).setTrashed(true); try { Drive.Files.remove(tid); } catch (e) { /* lixeira */ } } catch (e) { /* já não existe */ }
        sh.getRange(lin, c('titulo_id') + 1).setValue('apagado');
        sh.getRange(lin, c('titulo_apagado_em') + 1).setValue(new Date());
      }
    }
    return { ok: true, id: b.id, status: status };
  }
  return { erro: 'id nao encontrado' };
}

/* ---------- painel do Rogerio: entrada por e-mail + código, sem senha fixa ---------- */
const ADM_EMAIL = 'rogeriotpires@gmail.com';   // único e-mail que pode entrar no painel
const ADM_SESSAO_S = 6 * 60 * 60;              // sessão de 6 horas (limite do cache)

function admHash_(s) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8));
}
/** Passo 1: manda um código de 6 dígitos para o e-mail autorizado. Qualquer outro e-mail é negado na hora. */
function admCodigo_(b) {
  const email = depoLimpa_(b.email, 120).toLowerCase();
  const cache = CacheService.getScriptCache();
  const chaveTent = 'adm_tent_' + admHash_(email);
  const tent = +(cache.get(chaveTent) || 0);
  if (tent >= 5) return { erro: 'excesso' };               // bloqueia tentativas em excesso (15 min)
  cache.put(chaveTent, String(tent + 1), 15 * 60);
  if (email !== ADM_EMAIL) return { erro: 'email' };
  const codigo = String(Math.floor(100000 + Math.random() * 900000));
  cache.put('adm_codigo', admHash_(codigo + email), 10 * 60);
  MailApp.sendEmail({ to: email, subject: 'Fiscalize – código do painel: ' + codigo,
    htmlBody: '<p>Seu código para entrar no painel de depoimentos é</p><p style="font-size:34px;font-weight:bold;letter-spacing:6px">' + codigo + '</p><p>Vale por 10 minutos. Se não foi você, ignore.</p>' });
  return { ok: true };
}
/** Passo 2: confere o código e devolve a chave da sessão. */
function admEntrar_(b) {
  const email = depoLimpa_(b.email, 120).toLowerCase(), codigo = depoLimpa_(b.codigo, 6);
  const cache = CacheService.getScriptCache();
  const guardado = cache.get('adm_codigo');
  if (email !== ADM_EMAIL || !guardado || guardado !== admHash_(codigo + email)) return { erro: 'codigo' };
  cache.remove('adm_codigo');
  const sessao = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  cache.put('adm_sessao_' + admHash_(sessao), '1', ADM_SESSAO_S);
  return { ok: true, sessao: sessao, expira_s: ADM_SESSAO_S };
}
function admValida_(s) {
  if (!s || String(s).length < 40) return false;
  return CacheService.getScriptCache().get('adm_sessao_' + admHash_(String(s))) === '1';
}
/** Lista completa para o painel (só com sessão válida). */
function admLista_() {
  const sh = depoPlanilha_().getSheetByName('Depoimentos');
  if (!sh || sh.getLastRow() < 2) return { linhas: [] };
  const v = sh.getRange(2, 1, sh.getLastRow() - 1, DEPO_COLS.length).getValues();
  const linhas = v.filter(r => r[0]).map(r => {
    const o = {}; DEPO_COLS.forEach((c, i) => { o[c] = r[i] instanceof Date ? r[i].toISOString() : r[i]; }); return o;
  });
  return { linhas: linhas.reverse() };
}
/** Foto do título em base64 para o painel (se ainda existir). */
function admTitulo_(b) {
  if (!b.id) return { erro: 'dados' };
  const r = depoTitulo_(String(b.id));
  return r;
}
/** Marca conferido / recusado / pendente e publicar; apaga a foto do título quando sai de pendente. */
function admMarcar_(b) {
  const r = depoMarcar_({ id: b.id, status: b.status, obs: b.obs, zona_secao: b.zona_secao });
  if (r.ok && typeof b.publicar === 'boolean') {
    const sh = depoPlanilha_().getSheetByName('Depoimentos');
    const v = sh.getRange(2, 1, Math.max(1, sh.getLastRow() - 1), 1).getValues();
    for (let i = 0; i < v.length; i++) if (String(v[i][0]) === String(b.id)) sh.getRange(i + 2, DEPO_COLS.indexOf('publicar') + 1).setValue(b.publicar);
  }
  return r;
}
/** Apaga um envio inteiro (linha, vídeo e foto). Para testes e envios indevidos. */
function admApagar_(b) {
  const sh = depoPlanilha_().getSheetByName('Depoimentos');
  const c = (n) => DEPO_COLS.indexOf(n);
  const v = sh.getRange(2, 1, Math.max(1, sh.getLastRow() - 1), DEPO_COLS.length).getValues();
  for (let i = 0; i < v.length; i++) {
    if (String(v[i][0]) !== String(b.id)) continue;
    [v[i][c('video_id')], v[i][c('titulo_id')]].forEach(id => {
      if (id && id !== 'apagado') { try { DriveApp.getFileById(String(id)).setTrashed(true); } catch (e) { /* já foi */ } }
    });
    sh.deleteRow(i + 2);
    return { ok: true, id: b.id };
  }
  return { erro: 'id nao encontrado' };
}
/** Porta de entrada das chamadas do painel. */
function admPost_(body) {
  if (body.acao === 'adm_codigo') return admCodigo_(body);
  if (body.acao === 'adm_entrar') return admEntrar_(body);
  if (!admValida_(body.s)) return { erro: 'sessao' };
  if (body.acao === 'adm_lista') return admLista_();
  if (body.acao === 'adm_titulo') return admTitulo_(body);
  if (body.acao === 'adm_marcar') return admMarcar_(body);
  if (body.acao === 'adm_apagar') return admApagar_(body);
  return { erro: 'acao desconhecida' };
}

/** Rode UMA vez pelo editor para autorizar o envio de e-mail e o cache: manda um e-mail de teste ao e-mail autorizado. */
function autorizarPainel() {
  CacheService.getScriptCache().put('adm_teste', '1', 60);
  MailApp.sendEmail({ to: ADM_EMAIL, subject: 'Fiscalize – painel autorizado', htmlBody: '<p>O painel de depoimentos está autorizado a enviar códigos para este e-mail.</p>' });
  Logger.log('ok: e-mail de teste enviado para ' + ADM_EMAIL);
}

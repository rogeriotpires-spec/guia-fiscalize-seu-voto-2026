(function () {
  'use strict';
  const endpoint = 'https://timeline-guia-contadores.rogeriotpires.chatgpt.site/api/occurrences';
  const test = new URLSearchParams(location.search).get('contadores') === 'teste';
  const fields = ['quando','onde','ocorrido','testemunhas','autoridade','email','nome','telefone'];
  const consent = document.getElementById('autoriza-publicacao');
  const send = document.getElementById('enviar-ocorrencia');
  const status = document.getElementById('envio-status');
  const fileInput = document.getElementById('imagem-ocorrencia');
  const imageStatus = document.getElementById('imagem-status');
  const removeImage = document.getElementById('remover-imagem');
  let imageState = null, imagePromise = Promise.resolve(null), imageError = '', imageVersion = 0;
  let busy = false, lastRequest = null, savedFingerprint = null, page = 1;

  function values() {
    const result = {};
    fields.forEach(function (key) {result[key] = document.getElementById(key).value.trim();});
    return result;
  }
  function fingerprint() {return JSON.stringify(values()) + ':' + imageVersion;}
  function updateButton() {send.disabled = busy || !consent.checked || savedFingerprint === fingerprint();}
  function resetImage() {
    imageVersion += 1; imageState = null; imageError = ''; imagePromise = Promise.resolve(null);
    fileInput.value = ''; imageStatus.textContent = ''; removeImage.hidden = true; updateButton();
  }
  async function prepareImage(file, version) {
    if (!['image/jpeg','image/png','image/webp'].includes(file.type)) throw new Error('Escolha uma imagem JPG, PNG ou WebP.');
    if (file.size > 5 * 1024 * 1024) throw new Error('A imagem deve ter no máximo 5 MB.');
    const bitmap = await createImageBitmap(file);
    try {
      if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40000000) throw new Error('A imagem é muito grande. Reduza as dimensões e tente novamente.');
      const scale = Math.min(1, 1800 / Math.max(bitmap.width,bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1,Math.round(bitmap.width*scale)); canvas.height = Math.max(1,Math.round(bitmap.height*scale));
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff'; context.fillRect(0,0,canvas.width,canvas.height); context.drawImage(bitmap,0,0,canvas.width,canvas.height);
      const blob = await new Promise(function (resolve) {canvas.toBlob(resolve,'image/jpeg',0.85);});
      if (!blob || blob.size > 2000000) throw new Error('Não foi possível reduzir a imagem. Escolha um arquivo menor.');
      const prepared = {blob:blob,bytes:new Uint8Array(await blob.arrayBuffer()),type:'image/jpeg'};
      if (version === imageVersion) {imageState = prepared;imageStatus.textContent = 'Imagem pronta para acompanhar a ficha em PDF. Ela não será exibida na tabela.';}
      return prepared;
    } finally {bitmap.close();}
  }
  fileInput.addEventListener('change',function () {
    const file = fileInput.files[0]; imageVersion += 1; const version = imageVersion;
    imageState = null; imageError = ''; removeImage.hidden = !file;
    if (!file) {resetImage();return;}
    imageStatus.textContent = 'Preparando a imagem…';
    imagePromise = prepareImage(file,version).catch(function (error) {
      if (version === imageVersion) {imageError = error.message || 'Não foi possível abrir a imagem.';imageStatus.textContent = imageError;}
      return null;
    });
    updateButton();
  });
  removeImage.addEventListener('click',resetImage);
  window.TimelineOcorrencias = {imageForExport:async function () {await imagePromise;if(imageError)throw new Error(imageError);return imageState ? {bytes:imageState.bytes,type:imageState.type}:null;}};
  consent.addEventListener('change',updateButton);
  fields.forEach(function (key) {document.getElementById(key).addEventListener('input',updateButton);});
  async function request(url, options) {
    const controller = new AbortController(); const timer = setTimeout(function () {controller.abort();},30000);
    try {
      const response = await fetch(url,Object.assign({mode:'cors',credentials:'omit',cache:'no-store',signal:controller.signal},options));
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Não foi possível concluir o pedido.');
      return result;
    } finally {clearTimeout(timer);}
  }
  send.addEventListener('click',async function () {
    if (busy || !consent.checked) return;
    const data = values();
    for (const key of ['quando','onde','ocorrido']) {
      if (data[key].length < (key === 'ocorrido' ? 10 : 3)) {status.textContent = 'Preencha data, local e uma descrição do fato com pelo menos 10 caracteres.';document.getElementById(key).focus();return;}
    }
    if (data.nome.length < 3) {status.textContent = 'Informe seu nome completo para enviar o relato.';document.getElementById('nome').focus();return;}
    if (!data.email || !document.getElementById('email').checkValidity()) {status.textContent = 'Informe um endereço de e-mail válido para contato.';document.getElementById('email').focus();return;}
    const phoneDigits = data.telefone.replace(/\D/g,'');
    const validPhone = /^\+?[\d\s().-]+$/.test(data.telefone) && (data.telefone.startsWith('+') ? /^[1-9]\d{7,14}$/.test(phoneDigits) : /^[1-9]{2}\d{8,9}$/.test(phoneDigits));
    if (!validPhone) {status.textContent = 'Informe um telefone com DDD. Para números internacionais, inclua + e o código do país.';document.getElementById('telefone').focus();return;}
    busy = true; updateButton(); status.textContent = 'Enviando a ficha autorizada…';
    const snapshot = fingerprint();
    try {
      await imagePromise;
      if (imageError) throw new Error(imageError);
      if (!consent.checked || snapshot !== fingerprint()) throw new Error('Os campos mudaram durante o preparo. Confira a ficha e clique em enviar novamente.');
      if (!lastRequest || lastRequest.fingerprint !== snapshot) lastRequest = {fingerprint:snapshot,id:crypto.randomUUID()};
      const body = new FormData();
      body.append('payload',JSON.stringify(Object.assign({id:lastRequest.id,consent:true,consentVersion:'2026-10-12-v2',website:document.getElementById('ocorrencia-website').value},data)));
      if (imageState) body.append('image',imageState.blob,'ocorrencia.jpg');
      const result = await request(endpoint+(test?'?test=1':''),{method:'POST',body:body});
      savedFingerprint = snapshot;
      status.textContent = (test ? 'Ficha de teste salva, fora da tabela pública principal.' : 'Relato publicado. Nome, e-mail, telefone, testemunhas, protocolo e imagem ficaram em acesso reservado.') + ' Identificador: ' + result.id;
      page = 1; await loadTable();
    } catch(error) {
      status.textContent = (error.name === 'AbortError' || error instanceof TypeError) ? 'Não foi possível confirmar o envio. Tente novamente: a mesma ficha não será duplicada.' : (error.message || 'Não foi possível enviar. Tente novamente.');
    } finally {busy=false;updateButton();}
  });

  const tableBody = document.getElementById('ocorrencias-corpo');
  const listStatus = document.getElementById('ocorrencias-lista-status');
  const previous = document.getElementById('ocorrencias-anterior');
  const next = document.getElementById('ocorrencias-proxima');
  const refresh = document.getElementById('ocorrencias-atualizar');
  let listing = false;
  function cell(row,text) {const td=document.createElement('td');td.textContent=text;row.appendChild(td);return td;}
  async function loadTable() {
    if(listing)return;listing=true;previous.disabled=true;next.disabled=true;refresh.disabled=true;
    try {
      const result=await request(endpoint+'?page='+page+(test?'&test=1':''));
      if (!Array.isArray(result.records)) throw new Error('Resposta inválida.');
      tableBody.replaceChildren();
      result.records.forEach(function (record) {
        const tr=document.createElement('tr');cell(tr,record.quando);cell(tr,record.onde);
        const td=cell(tr,'');
        if(record.ocorrido.length>320) {const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent='Ler relato completo';const p=document.createElement('p');p.textContent=record.ocorrido;details.append(summary,p);td.appendChild(details);}
        else td.textContent=record.ocorrido;
        tableBody.appendChild(tr);
      });
      if(!result.records.length) {const tr=document.createElement('tr');const td=cell(tr,'Nenhum relato compartilhado até o momento.');td.colSpan=3;tableBody.appendChild(tr);}
      listStatus.textContent=test?'Modo de teste: estes registros não aparecem na tabela pública principal.':result.total+' '+(result.total===1?'relato compartilhado.':'relatos compartilhados.');
      listStatus.classList.toggle('occ-test-note',test);
      document.getElementById('ocorrencias-pagina').textContent='Página '+page+' de '+Math.max(1,Math.ceil(result.total/result.pageSize));
      previous.disabled=page<=1;next.disabled=page*result.pageSize>=result.total;
    } catch(error) {listStatus.textContent='Não foi possível carregar os relatos agora. Use “Atualizar” para tentar novamente.';}
    finally {listing=false;refresh.disabled=false;}
  }
  previous.addEventListener('click',function(){if(page>1){page--;loadTable();}});
  next.addEventListener('click',function(){page++;loadTable();});
  refresh.addEventListener('click',function(){loadTable();});
  updateButton();loadTable();
})();

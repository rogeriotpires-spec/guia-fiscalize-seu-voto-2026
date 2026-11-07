/* Votou no Flávio? Recebe o depoimento em vídeo e a foto do título das seções em que
   o TSE registrou zero votos, e envia em partes para a ponte, que guarda no Drive. */
(function () {
  'use strict';
  const PONTE = 'https://script.google.com/macros/s/AKfycbwpl594yIsZJIdtunWGalH4uxJVCvwVKOpdX9eakG1YdV-uBkOHOIf3M2xhTFE_zAndpQ/exec';
  const $ = (id) => document.getElementById(id);
  const PARTE = 4 * 1024 * 1024;          // 4 MB por parte (base64 vira ~5,4 MB, abaixo do limite da ponte)
  const MAX_VIDEO = 45 * 1024 * 1024;     // 45 MB
  const MAX_SEG = 75;                     // segundos
  const MAX_LADO_FOTO = 1400;
  let dados = null, video = null, foto = null, videoDur = 0;

  function status(t, cls, el) { const s = $(el || 'status'); s.textContent = t; s.className = 'status ' + (cls || ''); }
  const b64 = (blob) => new Promise((ok, erro) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = () => erro(new Error('leitura')); r.readAsDataURL(blob); });

  // ---------- contador público de transparência ----------
  fetch(PONTE + '?acao=depo_contador', { redirect: 'follow' }).then(r => r.json()).then(c => {
    if (!c || c.erro) return;
    $('c-rec').textContent = c.recebidos; $('c-conf').textContent = c.conferidos; $('c-rec2').textContent = c.recusados || 0; $('c-guard').textContent = c.titulos_guardados;
    $('contador').hidden = false;
  }).catch(() => {});

  // ---------- municípios e seções ----------
  fetch('../data/depoimentos/secoes.json', { cache: 'no-cache' }).then(r => r.json()).then(d => {
    dados = d.municipios;
    const ufs = [...new Set(dados.map(m => m.uf))].sort();
    ufs.forEach(u => { const o = document.createElement('option'); o.value = u; o.textContent = u; $('uf').appendChild(o); });
  }).catch(() => status('Não consegui carregar a lista de municípios. Recarregue a página.', 'aviso'));
  $('uf').addEventListener('change', () => {
    const sel = $('municipio'); sel.textContent = ''; sel.disabled = false;
    const o0 = document.createElement('option'); o0.value = ''; o0.textContent = 'Escolha'; sel.appendChild(o0);
    dados.filter(m => m.uf === $('uf').value).forEach(m => { const o = document.createElement('option'); o.value = m.cod; o.textContent = m.nome; sel.appendChild(o); });
    $('secoes').hidden = true; $('lista-secoes').textContent = '';
  });
  $('municipio').addEventListener('change', () => {
    const m = dados.find(x => x.uf === $('uf').value && x.cod === $('municipio').value);
    const ul = $('lista-secoes'); ul.textContent = '';
    if (!m) { $('secoes').hidden = true; return; }
    m.secoes.forEach(s => {
      const li = document.createElement('li'); const lab = document.createElement('label');
      const inp = document.createElement('input'); inp.type = 'radio'; inp.name = 'secao'; inp.value = s.zona + '-' + s.secao;
      const tx = document.createElement('span');
      const b = document.createElement('b'); b.textContent = s.local;
      const sm = document.createElement('small'); sm.textContent = 'Zona ' + s.zona + ', seção ' + s.secao + ' · ' + s.end + (s.f1 ? ' · Flávio tinha ' + s.f1 + ' voto' + (s.f1 > 1 ? 's' : '') + ' no 1º turno' : '');
      tx.appendChild(b); tx.appendChild(sm); lab.appendChild(inp); lab.appendChild(tx); li.appendChild(lab); ul.appendChild(li);
    });
    $('secoes').hidden = false;
  });

  // ---------- vídeo ----------
  $('video').addEventListener('change', () => {
    const f = $('video').files[0]; if (!f) return;
    video = null; videoDur = 0;
    const v = $('video-prev'); v.hidden = false; v.src = URL.createObjectURL(f);
    v.onloadedmetadata = () => {
      videoDur = v.duration || 0;
      if (videoDur > MAX_SEG) { status('O vídeo tem ' + Math.round(videoDur) + ' segundos. Grave um de até 60 segundos.', 'aviso', 'status-video'); return; }
      if (f.size > MAX_VIDEO) { status('O vídeo tem ' + (f.size / 1048576).toFixed(0) + ' MB, acima de 45 MB. Grave mais curto ou em 720p (nas configurações da câmera).', 'aviso', 'status-video'); return; }
      video = f; status('Vídeo pronto: ' + Math.round(videoDur) + ' s, ' + (f.size / 1048576).toFixed(1) + ' MB.', 'ok', 'status-video');
    };
    v.onerror = () => { video = f; status('Vídeo escolhido (' + (f.size / 1048576).toFixed(1) + ' MB).', 'ok', 'status-video'); };
  });

  // ---------- foto do título (comprimida no aparelho) ----------
  $('titulo').addEventListener('change', async () => {
    const f = $('titulo').files[0]; if (!f) return;
    foto = null; $('foto-prev').hidden = true;
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
      if (f.size > 3 * 1024 * 1024) return status('PDF acima de 3 MB. Tire uma foto do título em vez do PDF.', 'aviso', 'status-foto');
      foto = f; return status('PDF do e-Título pronto (' + (f.size / 1024).toFixed(0) + ' KB).', 'ok', 'status-foto');
    }
    status('Lendo a foto...', '', 'status-foto');
    try {
      let bmp;
      try { bmp = await createImageBitmap(f); }
      catch (e) {
        const url = URL.createObjectURL(f); const img = new Image();
        await new Promise((ok, erro) => { img.onload = ok; img.onerror = erro; img.src = url; });
        bmp = img;
      }
      const w = bmp.width, h = bmp.height;
      const s = Math.min(1, MAX_LADO_FOTO / Math.max(w, h));
      const c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      foto = await new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.82));
      if (!foto) throw new Error('canvas');
      $('foto-prev').src = c.toDataURL('image/jpeg', 0.6); $('foto-prev').hidden = false;
      status('Foto pronta (' + (foto.size / 1024).toFixed(0) + ' KB).', 'ok', 'status-foto');
    } catch (e) {
      if (/^image\/(jpeg|png|webp)$/.test(f.type) && f.size <= 3 * 1024 * 1024) { foto = f; status('Foto escolhida (' + (f.size / 1024).toFixed(0) + ' KB).', 'ok', 'status-foto'); }
      else status('Não consegui abrir essa imagem (' + (f.type || 'formato desconhecido') + '). Tire a foto de novo pela câmera ou escolha uma JPG.', 'aviso', 'status-foto');
    }
  });

  // ---------- envio em partes ----------
  async function post(corpo) {
    const r = await fetch(PONTE, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(corpo), redirect: 'follow' });
    if (!r.ok) throw new Error('http ' + r.status);
    return r.json();
  }
  async function postTentando(corpo, vezes) {
    let ultimo;
    for (let i = 0; i < (vezes || 3); i++) { try { return await post(corpo); } catch (e) { ultimo = e; await new Promise(ok => setTimeout(ok, 1500 * (i + 1))); } }
    throw ultimo;
  }
  $('form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const uf = $('uf').value, cod = $('municipio').value, nome = $('nome').value.trim();
    const m = dados && dados.find(x => x.uf === uf && x.cod === cod);
    if (!m) return status('Escolha o estado e o município.', 'aviso');
    if (!video) return status('Falta o vídeo do depoimento.', 'aviso');
    if (!foto) return status('Falta a foto do título ou do e-Título.', 'aviso');
    if (!nome) return status('Escreva o seu nome.', 'aviso');
    if (!$('aceite').checked) return status('Marque a autorização para publicar o depoimento.', 'aviso');
    const sec = (document.querySelector('input[name=secao]:checked') || {}).value || '';
    $('enviar').disabled = true; $('barra').hidden = false;
    const envio = (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)).slice(0, 20);
    try {
      const n = Math.ceil(video.size / PARTE);
      for (let i = 0; i < n; i++) {
        status('Enviando o vídeo: parte ' + (i + 1) + ' de ' + n + '. Não feche a página.');
        const r = await postTentando({ acao: 'depo_parte', envio, i, n, tipo: video.type || 'video/mp4', b64: await b64(video.slice(i * PARTE, (i + 1) * PARTE)) });
        if (!r.ok) throw new Error(r.erro || 'parte');
        $('barra-i').style.width = Math.round(90 * (i + 1) / n) + '%';
      }
      status('Enviando a foto e os dados.');
      const r = await postTentando({ acao: 'depo_fim', envio, n, uf, municipio: m.nome, cod, secao: sec, nome, whats: $('whats').value.trim(), dur: Math.round(videoDur), tipo: video.type || 'video/mp4', tamanho: video.size, titulo_b64: await b64(foto), titulo_tipo: foto.type || 'image/jpeg', aceite: true, site: $('site').value });
      if (!r.ok) throw new Error(r.erro || 'fim');
      $('barra-i').style.width = '100%';
      $('form').hidden = true; $('sucesso').hidden = false; window.scrollTo(0, 0);
    } catch (e) {
      $('enviar').disabled = false;
      const m2 = { tamanho: 'O vídeo passou do limite. Grave mais curto.', dados: 'Confira os dados e tente de novo.', partes: 'Faltou uma parte do vídeo. Tente enviar de novo.' };
      status(m2[String(e.message)] || 'Não consegui enviar. Confira a internet e tente de novo.', 'aviso');
    }
  });
  $('compartilhar').addEventListener('click', async () => {
    const d = { title: 'Você votou no Flávio?', text: 'Nas nossas seções o TSE diz que o Flávio teve zero votos. Se você votou nele, grave um depoimento.', url: location.href.split('#')[0] };
    if (navigator.share) { try { await navigator.share(d); } catch (e) { /* cancelou */ } }
    else window.open('https://wa.me/?text=' + encodeURIComponent(d.text + ' ' + d.url), '_blank', 'noopener');
  });
})();

(function () {
  'use strict';
  const teste = new URLSearchParams(location.search).get('contadores') === 'teste';
  const endpoint = 'https://timeline-guia-contadores.rogeriotpires.chatgpt.site/api/metrics' + (teste ? '?test=1' : '');
  const keys = ['visitas', 'relatorio', 'ficha'];
  const shown = {};
  const number = new Intl.NumberFormat('pt-BR');
  const status = document.getElementById('metricas-status');

  function show(data) {
    if (!data || !data.counts) throw new Error('Resposta inválida');
    keys.forEach(function (key) {
      const value = data.counts[key];
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Contagem inválida');
      shown[key] = Math.max(shown[key] || 0, value);
      const el = document.getElementById('total-' + key);
      el.textContent = number.format(shown[key]);
      el.classList.remove('indisponivel');
    });
    status.textContent = teste ? 'Modo de verificação: estes números não entram nos totais públicos.' : 'Contagem desde 12/10/2026. Downloads iniciados pelos botões desta página. Visitas não são pessoas únicas.';
  }
  function unavailable() {
    keys.forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(shown, key)) return;
      const el = document.getElementById('total-' + key);
      el.textContent = 'Indisponível';
      el.classList.add('indisponivel');
    });
    status.textContent = 'Contadores temporariamente indisponíveis. A leitura e os downloads continuam funcionando.';
  }
  async function request(options) {
    const abort = new AbortController();
    const timer = setTimeout(function () { abort.abort(); }, 8000);
    try {
      const response = await fetch(endpoint, Object.assign({mode:'cors', credentials:'omit', cache:'no-store', signal:abort.signal}, options));
      if (!response.ok) throw new Error('Contagem indisponível');
      const data = await response.json();
      show(data);
    } finally { clearTimeout(timer); }
  }
  function register(metric) {
    const event = {id:crypto.randomUUID(), metric:metric};
    // Only the event name and a random deduplication ID leave the browser.
    // Never include form fields, URL parameters or visitor identifiers.
    function send(attempt) {
      request({method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(event), keepalive:true})
        .catch(function () {
          unavailable();
          if (attempt < 2) setTimeout(function () { send(attempt + 1); }, [1500, 5000][attempt]);
        });
    }
    send(0);
  }
  const report = document.getElementById('baixar-relatorio');
  let reportLast = 0;
  report.addEventListener('click', function (event) {
    if (Date.now() - reportLast < 800) { event.preventDefault(); return; }
    reportLast = Date.now();
    register('relatorio');
  });

  let pdfLibrary;
  function loadScript(source, variable) {
    if (window[variable]) return Promise.resolve(window[variable]);
    return new Promise(function (resolve, reject) {
      const script = document.createElement('script');
      const timer = setTimeout(function () { script.remove(); reject(new Error('Tempo de espera excedido')); }, 25000);
      script.src = source;
      script.onload = function () { clearTimeout(timer); if (window[variable]) resolve(window[variable]); else reject(new Error('PDF indisponível')); };
      script.onerror = function () { clearTimeout(timer); script.remove(); reject(new Error('PDF indisponível')); };
      document.head.appendChild(script);
    });
  }
  function loadPdfLibrary() {
    if (!pdfLibrary) pdfLibrary = Promise.all([
      loadScript('assets/vendor/pdf-lib-1.17.1.min.js', 'PDFLib'),
      loadScript('assets/vendor/fontkit.min.js', 'fontkit'),
      fetch('assets/vendor/DejaVuSans.ttf', {credentials:'omit'}).then(function (response) { if (!response.ok) throw new Error('Fonte indisponível'); return response.arrayBuffer(); })
    ]).catch(function (error) { pdfLibrary = null; throw error; });
    return pdfLibrary;
  }
  const fichaButton = document.getElementById('baixar-ficha');
  const fichaStatus = document.getElementById('ficha-status');
  fichaButton.addEventListener('click', async function () {
    fichaButton.disabled = true;
    fichaStatus.textContent = 'Preparando o PDF da sua ficha…';
    try {
      const data = {};
      ['quando','onde','ocorrido','testemunhas','autoridade'].forEach(function (key) { data[key] = document.getElementById(key).value; });
      const resources = await loadPdfLibrary();
      const bytes = await window.TimelineFicha.createPdf(data, resources[0], resources[2], resources[1]);
      const url = URL.createObjectURL(new Blob([bytes], {type:'application/pdf'}));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'Ficha_de_Ocorrencia_Timeline_2026.pdf';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      register('ficha');
      fichaStatus.textContent = 'PDF preparado. O download da ficha foi iniciado.';
    } catch (error) {
      fichaStatus.textContent = 'Não foi possível gerar o PDF. Tente novamente ou use “Imprimir / salvar em PDF”.';
    } finally { fichaButton.disabled = false; }
  });
  request().catch(unavailable);
  register('visitas');
})();

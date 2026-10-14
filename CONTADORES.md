# Contadores e ficha em PDF

Os totais começaram em 12/10/2026. Não há dados retroativos.

- Visitas: carregamentos da página, incluindo retornos e recarregamentos. Não são visitantes únicos.
- Relatório: downloads iniciados pelo botão do PDF completo.
- Ficha: downloads iniciados depois da geração do PDF preenchido. A impressão pelo navegador não entra nesse total.

Os totais são compartilhados entre visitantes e persistidos em uma base D1 do serviço publicado em https://timeline-guia-contadores.rogeriotpires.chatgpt.site. O site principal continua no GitHub Pages. O serviço é um projeto Sites da mesma conta, com identificador `appgprj_6accaeec0ec88191b00d9cec4bef871e` e código próprio versionado.

`assets/metricas.js` consulta e envia eventos para `/api/metrics`. Cada evento contém apenas a categoria e um UUID aleatório para evitar duplicação nas tentativas de reenvio. Os campos da ficha nunca são enviados ao serviço. A API não grava IP, navegador ou identificador persistente de visitante. Como qualquer contador público sem autenticação, os números podem incluir automações e não equivalem a uma auditoria de audiência.

Para verificar os três botões sem alterar os totais públicos, abra a página com `?contadores=teste`. Esse modo usa um conjunto separado de contadores. A API aceita `?test=1` para essa finalidade e rejeita campos adicionais no corpo dos eventos.

`assets/ficha-pdf.js` gera o PDF no dispositivo usando as bibliotecas locais em `assets/vendor`. A fonte incorporada mantém os acentos, e relatos longos continuam nas páginas seguintes. Caracteres sem glifo na fonte são preservados como códigos Unicode. As bibliotecas só são carregadas ao solicitar o PDF. O relatório original e as oito imagens permanecem nos caminhos originais.

Se o serviço ficar indisponível, a página mostra esse estado e mantém a leitura, o PDF original, a exportação da ficha e a impressão disponíveis. Não são exibidos totais simulados nem estimados.

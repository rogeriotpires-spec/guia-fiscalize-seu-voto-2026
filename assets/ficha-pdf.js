(function (root) {
  'use strict';
  async function createPdf(data, lib, fontBytes, fontkit) {
    const {PDFDocument, rgb} = lib;
    const doc = await PDFDocument.create();
    doc.setTitle('Ficha de ocorrência eleitoral | Revista Timeline');
    doc.setAuthor('Revista Timeline');
    doc.setCreator('Guia Fiscalize Seu Voto 2026');
    doc.registerFontkit(fontkit);
    const regular = await doc.embedFont(fontBytes, {subset:true});
    const bold = regular;
    const glyphs = new Set(regular.getCharacterSet());
    const orange = rgb(0.83, 0.32, 0.055);
    const ink = rgb(0.09, 0.09, 0.09);
    const muted = rgb(0.36, 0.36, 0.36);
    const line = rgb(0.78, 0.78, 0.78);
    const width = 595.28, height = 841.89, margin = 46, inner = width - margin * 2;
    let page, y, escaped = false;

    function printable(value) {
      return Array.from(String(value || '').replace(/\r\n?/g, '\n').normalize('NFC')).map(function (char) {
        if (char === '\n' || char === '\t') return char === '\t' ? '    ' : char;
        const cp = char.codePointAt(0);
        if (cp < 32) return '';
        if (glyphs.has(cp)) return char;
        escaped = true;
        return '[U+' + cp.toString(16).toUpperCase() + ']';
      }).join('');
    }
    function newPage() {
      page = doc.addPage([width, height]);
      page.drawText('REVISTA TIMELINE', {x:margin, y:height-47, font:bold, size:10, color:orange});
      page.drawText('FICHA DE OCORRÊNCIA', {x:margin, y:height-78, font:bold, size:21, color:ink});
      page.drawText('FISCALIZE SEU VOTO 2026', {x:margin, y:height-96, font:regular, size:9, color:muted});
      page.drawLine({start:{x:margin,y:height-110},end:{x:width-margin,y:height-110},thickness:1.6,color:orange});
      y = height - 133;
    }
    function wrap(value) {
      const lines = [];
      printable(value).split('\n').forEach(function (paragraph) {
        if (!paragraph) {lines.push('');return;}
        let current = '';
        for (const word of paragraph.split(/ +/)) {
          const candidate = current ? current + ' ' + word : word;
          if (regular.widthOfTextAtSize(candidate, 10.5) <= inner - 24) {current = candidate;continue;}
          if (current) lines.push(current);
          current = '';
          for (const char of word) {
            if (regular.widthOfTextAtSize(current + char, 10.5) > inner - 24) {lines.push(current);current = '';}
            current += char;
          }
        }
        if (current) lines.push(current);
      });
      return lines.length ? lines : [''];
    }
    function field(label, value, minimum) {
      const rows = wrap(value);
      let first = true;
      while (rows.length) {
        if (y < 136) newPage();
        page.drawText(label + (first ? '' : ' (continuação)'), {x:margin, y:y, font:bold, size:9.4, color:ink});
        y -= 12;
        const capacity = Math.max(1, Math.floor((y - 69 - 22) / 15));
        const chunk = rows.splice(0, capacity);
        const required = chunk.length * 15 + 18;
        const boxHeight = Math.min(y - 69, Math.max(first && rows.length === 0 ? minimum : 33, required));
        page.drawRectangle({x:margin,y:y-boxHeight,width:inner,height:boxHeight,borderColor:line,borderWidth:0.7,color:rgb(1,1,1)});
        chunk.forEach(function (text, i) {
          if (text) page.drawText(text,{x:margin+12,y:y-19-i*15,font:regular,size:10.5,color:ink});
        });
        if (!value.trim()) {
          for (let ly=y-24;ly>y-boxHeight+9;ly-=18) page.drawLine({start:{x:margin+12,y:ly},end:{x:width-margin-12,y:ly},thickness:0.35,color:rgb(.88,.88,.88)});
        }
        y -= boxHeight + 21;
        first = false;
        if (rows.length) newPage();
      }
    }
    newPage();
    field('01  QUANDO? Data e hora do fato', String(data.quando || ''), 43);
    field('02  ONDE? Cidade, local, zona e seção', String(data.onde || ''), 57);
    field('03  O QUE ACONTECEU? Descreva o que você presenciou', String(data.ocorrido || ''), 128);
    field('04  QUEM VIU JUNTO? Nome e contato das testemunhas', String(data.testemunhas || ''), 72);
    field('05  PARA QUEM CONTOU? Autoridade e número do protocolo', String(data.autoridade || ''), 72);
    if (data.email) field('06  E-MAIL PARA CONTATO (acesso reservado)', String(data.email), 43);
    if (escaped) {
      if (y < 106) newPage();
      page.drawText('Símbolos fora da fonte foram preservados entre colchetes como códigos Unicode.',{x:margin,y:y,font:regular,size:7.8,color:muted});
    }
    if (data.image && data.image.bytes && data.image.bytes.length) {
      const attachment = data.image.type === 'image/png'
        ? await doc.embedPng(data.image.bytes)
        : await doc.embedJpg(data.image.bytes);
      newPage();
      page.drawText('IMAGEM ANEXADA À FICHA', {x:margin,y:y,font:bold,size:11,color:ink});
      y -= 22;
      page.drawText('A imagem não é exibida na tabela pública de ocorrências.', {x:margin,y:y,font:regular,size:9,color:muted});
      y -= 20;
      const scale = Math.min(inner / attachment.width, (y - 76) / attachment.height);
      const imageWidth = attachment.width * scale, imageHeight = attachment.height * scale;
      page.drawImage(attachment, {x:margin+(inner-imageWidth)/2,y:y-imageHeight,width:imageWidth,height:imageHeight});
    }
    const pages = doc.getPages();
    pages.forEach(function (p, i) {
      if (data.id) p.drawText('Identificador do relato: ' + printable(data.id),{x:margin,y:61,font:regular,size:7.5,color:muted});
      p.drawLine({start:{x:margin,y:51},end:{x:width-margin,y:51},thickness:.5,color:line});
      p.drawText('Fatos antes, durante ou depois da eleição. Não substitui registro na autoridade competente.',{x:margin,y:38,font:regular,size:7.5,color:muted});
      p.drawText('REVISTA TIMELINE  |  @rogerrio  |  @rogerrioX',{x:margin,y:26,font:regular,size:7.5,color:muted});
      p.drawText(String(i+1)+' / '+pages.length,{x:width-margin-25,y:26,font:regular,size:7.5,color:muted});
    });
    return doc.save();
  }
  if (typeof module === 'object' && module.exports) module.exports = {createPdf:createPdf};
  else root.TimelineFicha = {createPdf:createPdf};
})(typeof window !== 'undefined' ? window : globalThis);


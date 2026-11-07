"""Robô dos depoimentos: lê a foto do título (OCR), confere zona e seção contra a
lista das seções zeradas e marca a linha na planilha. A ponte apaga a foto na hora.

Resultado por linha:
  lido       zona e seção lidas, documento reconhecido e seção entre as zeradas; a foto fica até o Rogerio marcar conferido
  recusado   zona e seção lidas, mas não estão na lista (ou são de outro município)
  pendente   OCR não leu com segurança; fica para conferência manual (obs explica)
"""
import base64, io, json, os, re, sys, time
import requests
from PIL import Image, ImageOps, ImageFilter
import pytesseract

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_CFG = os.path.join(RAIZ, 'automacao', 'config.json')
URL = os.environ.get('PONTE_URL') or (json.load(open(_CFG)).get('ponte_url', '') if os.path.exists(_CFG) else '')
TOKEN = os.environ.get('PONTE_TOKEN', '')
S = requests.Session()


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def get(**q):
    q['t'] = TOKEN
    r = S.get(URL, params=q, timeout=(30, 300)); r.raise_for_status(); d = r.json()
    if isinstance(d, dict) and d.get('erro'): raise RuntimeError('ponte: ' + str(d['erro']))
    return d


def post(corpo):
    corpo['t'] = TOKEN
    r = S.post(URL, data=json.dumps(corpo, ensure_ascii=False).encode(), timeout=300, headers={'Content-Type': 'application/json'})
    r.raise_for_status(); return r.json()


def secoes_por_mun():
    d = json.load(open(os.path.join(RAIZ, 'data', 'depoimentos', 'secoes.json'), encoding='utf-8'))
    out = {}
    for m in d['municipios']:
        out[(m['uf'], str(m['cod']))] = {(s['zona'], s['secao']) for s in m['secoes']}
    return out


def variantes(img):
    """algumas versões da imagem para o OCR tentar"""
    g = ImageOps.exif_transpose(img).convert('L')
    w, h = g.size
    if max(w, h) < 1600:
        k = 1600 / max(w, h); g = g.resize((int(w * k), int(h * k)), Image.LANCZOS)
    yield g
    yield ImageOps.autocontrast(g, cutoff=2)
    yield ImageOps.invert(g)                                   # tela escura do e-Título
    yield g.filter(ImageFilter.SHARPEN).point(lambda p: 255 if p > 150 else 0)
    yield g.rotate(90, expand=True)
    yield g.rotate(-90, expand=True)


MARCAS = ('JUSTICA ELEITORAL', 'TITULO DE ELEITOR', 'TITULO ELEITORAL', 'E-TITULO', 'ETITULO', 'COMPROVANTE DE VOTACAO', 'INSCRICAO', 'TRIBUNAL SUPERIOR ELEITORAL', 'TRIBUNAL REGIONAL ELEITORAL', 'ELEITOR')


def parece_documento(txt):
    t = txt.upper().replace('Ç', 'C').replace('Ã', 'A').replace('Õ', 'O').replace('Í', 'I').replace('É', 'E')
    t = re.sub(r'[^A-Z0-9 -]', ' ', t)
    return any(m in t for m in MARCAS)


def ler_zona_secao(img):
    """Procura 'Zona NNNN' e 'Seção NNNN' no texto do OCR. Devolve (zona, secao, texto) ou (None, None, texto)."""
    melhor = (None, None, '')
    for v in variantes(img):
        txt = ''
        for lang in ('por', 'eng'):
            try:
                txt = pytesseract.image_to_string(v, lang=lang, config='--psm 6'); break
            except Exception:
                continue
        if not txt:
            continue
        t = txt.upper().replace('Ç', 'C').replace('Ã', 'A').replace('Õ', 'O')
        # e-Título: "ZONA 0005" / "SECAO 0176"; título físico: "ZONA  SECAO" numa linha e "005  0176" na seguinte
        m = re.search(r'ZONA\W+SE[CG5][AÁ4]O\W+(\d{1,4})\W+(\d{1,4})', t)   # título físico: rótulos numa linha, números na seguinte
        if m:
            zona, secao = int(m.group(1)), int(m.group(2))
        else:
            z = re.search(r'ZONA\D{0,20}(\d{1,4})', t)
            s_ = re.search(r'SE[CG5][AÁ4]O\D{0,20}(\d{1,4})', t)
            zona, secao = (int(z.group(1)), int(s_.group(1))) if (z and s_) else (None, None)
        if zona and secao:
            return zona, secao, txt
        if len(txt) > len(melhor[2]): melhor = (None, None, txt)
    return melhor


def main():
    if not URL or not TOKEN:
        log('PONTE_URL ou PONTE_TOKEN ausentes'); sys.exit(1)
    lista = secoes_por_mun()
    pend = get(acao='depo_pendentes').get('pendentes', [])
    log(f'{len(pend)} depoimentos pendentes')
    res = {'lido': 0, 'recusado': 0, 'pendente': 0}
    for p in pend:
        try:
            a = get(acao='depo_titulo', id=p['titulo_id'])
            raw = base64.b64decode(a['b64'])
            if 'pdf' in str(a.get('mime', '')).lower() or raw[:4] == b'%PDF':
                import fitz
                doc = fitz.open(stream=raw, filetype='pdf'); pix = doc[0].get_pixmap(dpi=200)
                img = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
            else:
                img = Image.open(io.BytesIO(raw))
            zona, secao, txt = ler_zona_secao(img)
        except Exception as e:  # noqa: BLE001
            log(p['id'], 'falha ao ler', type(e).__name__); continue
        ok_mun = lista.get((p['uf'], str(p['cod'])), set())
        if zona is None:
            if 'OCR' in str(p.get('obs', '')):
                status, obs = 'pendente', 'OCR não leu zona/seção (2ª tentativa). Conferir à mão.'
            else:
                status, obs = 'pendente', 'OCR não leu zona/seção. Conferir à mão.'
        elif (zona, secao) in ok_mun:
            if parece_documento(txt):
                status, obs = 'lido', f'OCR: zona {zona}, seção {secao}, documento reconhecido. Está entre as seções zeradas de {p["municipio"]}. Confira o vídeo e a foto e marque conferido.'
            else:
                status, obs = 'pendente', f'OCR: zona {zona}, seção {secao} batem, mas a imagem não parece título nem comprovante. Conferir à mão.'
        else:
            # pode ser seção do mesmo município sem zero, ou de outro município
            outro = [k for k, v in lista.items() if (zona, secao) in v and k[0] == p['uf']]
            if outro:
                status, obs = 'recusado', f'OCR: zona {zona}, seção {secao}. Seção zerada, mas de outro município ({outro[0][1]}), não de {p["municipio"]}.'
            else:
                status, obs = 'recusado', f'OCR: zona {zona}, seção {secao}. Não está entre as seções zeradas de {p["municipio"]}.'
        if p.get('zona_secao') and zona is not None and p['zona_secao'] != f'{zona}-{secao}':
            obs += f' Atenção: o eleitor marcou {p["zona_secao"]}.'
        r = post({'acao': 'depo_marcar', 'id': p['id'], 'status': status, 'obs': obs, 'zona_secao': f'{zona}-{secao}' if zona is not None else ''})
        log(p['id'], status, '|', obs, '|', r)
        res[status] += 1
    log('resumo', res)
    with open(os.environ.get('GITHUB_STEP_SUMMARY', '/dev/null'), 'a') as f:
        f.write(f"Depoimentos: {res['lido']} lidos (aguardam sua conferência), {res['recusado']} recusados, {res['pendente']} ficaram para conferência manual.\n")


if __name__ == '__main__':
    main()

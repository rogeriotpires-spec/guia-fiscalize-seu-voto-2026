"""Robô Fiscalize: confere os boletins de urna enviados pelo formulário.

Busca as respostas e os arquivos pela ponte (Apps Script), lê os QR Codes,
classifica cada envio, compara com a base oficial do TSE (data/2t), publica
o painel público (data/bus/painel.json + bus/img/) e grava o painel interno
restrito na planilha do Rogerio.

REGRA DE PRIVACIDADE: nome, WhatsApp, nome original do arquivo e ids do Drive
nunca são escritos em disco nem impressos no log (o repositório e os logs do
GitHub são públicos). Eles só vão para a planilha restrita.
"""
import base64
import concurrent.futures as cf
import datetime as dt
import hashlib
import io
import json
import os
import re
import time
import unicodedata
import urllib.parse

import cv2
import numpy as np
import requests
import zxingcpp
from PIL import Image, ImageOps

try:
    import pymupdf as fitz
except ImportError:  # pragma: no cover
    try:
        import fitz
    except ImportError:
        fitz = None
try:
    import pytesseract
except ImportError:  # pragma: no cover
    pytesseract = None
try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:  # pragma: no cover
    pass
try:
    from nacl.public import PublicKey, SealedBox
except ImportError:  # pragma: no cover
    SealedBox = None
import threading
_SEM_OCR = threading.BoundedSemaphore(3)

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ESTADO = os.path.join(RAIZ, 'automacao', 'estado.json')
SAIDA = os.path.join(RAIZ, 'data', 'bus', 'painel.json')
PASTA_IMG = os.path.join(RAIZ, 'bus', 'img')
BASE = os.path.join(RAIZ, 'data', '2t')
VERSAO = 4  # muda quando a lógica de leitura muda (reprocessa o que não tem QR completo)
os.environ.setdefault('OMP_THREAD_LIMIT', '1')  # tesseract com uma thread por processo
DEPURACAO = os.path.join(RAIZ, 'automacao', 'depuracao')
# chave pública para miniaturas de depuração criptografadas (só o Claude tem a privada)
CHAVE_DEPURACAO = 'kcwi+vH8v9LYAXhWjtdS7ldVopqJfTO4Iknc4lU5QjE='

_CFG = os.path.join(RAIZ, 'automacao', 'config.json')
URL = os.environ.get('PONTE_URL') or (json.load(open(_CFG)).get('ponte_url', '') if os.path.exists(_CFG) else '')
TOKEN = os.environ.get('PONTE_TOKEN', '')
FORM_LINK = 'https://fiscalize.revistatimeline.com/enviar/'
SITE = 'https://fiscalize.revistatimeline.com/boletins/'

ROTULOS = {
    'confere': 'Confere com o TSE',
    'confere_numeros': 'Confere com o TSE (pelos números)',
    'diverge': 'Divergência em análise',
    'nao_encontrada': 'Seção não encontrada na base',
    'em_analise': 'Em análise',
    'ilegivel': 'Ilegível',
    'nao_e_bu': 'Descartado: não é boletim',
    'via_digital': 'Descartado: via digital',
    'primeiro_turno': 'Descartado: 1º turno',
    'repetida': 'Descartado: foto repetida',
    'na_fila': 'Na fila de conferência',
}
INTEGRIDADE = {
    'confere': 'Íntegro', 'diverge': 'Íntegro', 'nao_encontrada': 'Íntegro',
    'confere_numeros': 'Parcialmente íntegro', 'em_analise': 'Parcialmente íntegro',
    'ilegivel': 'Ilegível',
}


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def h(s, n=16):
    return hashlib.sha256(('fiscalize:' + str(s)).encode()).hexdigest()[:n]


def norm(s):
    s = unicodedata.normalize('NFKD', str(s or '')).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'\s+', ' ', s).strip()


# ----------------------------------------------------------------- ponte
SESSAO = requests.Session()


def ponte_get(**q):
    q['t'] = TOKEN
    msg = ''
    for tent in range(5):
        try:
            r = SESSAO.get(URL, params=q, timeout=300)
            r.raise_for_status()
            try:
                d = r.json()
            except ValueError:
                titulo = re.search(r'<title>(.*?)</title>', r.text or '', re.S)
                raise ValueError(f"resposta não é JSON (HTTP {r.status_code}, {r.headers.get('content-type')}, "
                                 f"página: {titulo.group(1).strip()[:80] if titulo else '?'})")
            if isinstance(d, dict) and d.get('erro'):
                raise RuntimeError('ponte: ' + d['erro'])
            return d
        except RuntimeError:
            raise
        except Exception as e:  # noqa: BLE001
            espera = 5 * (tent + 1)
            msg = str(e).replace(TOKEN, '***') if TOKEN else str(e)
            msg = re.sub(r'https?://\S+', '<url>', msg)[:200]
            log(f'ponte falhou ({type(e).__name__}: {msg}), nova tentativa em {espera}s')
            time.sleep(espera)
    raise RuntimeError('ponte indisponível: ' + msg)


def ponte_post(corpo):
    corpo['t'] = TOKEN
    r = SESSAO.post(URL, data=json.dumps(corpo, ensure_ascii=False).encode(), timeout=300,
                    headers={'Content-Type': 'application/json'})
    r.raise_for_status()
    return r.json()


# ----------------------------------------------------------------- base TSE
_BASE = {}


def base_uf(uf):
    uf = (uf or '').lower()
    if uf not in _BASE:
        p = os.path.join(BASE, f'{uf}.json')
        _BASE[uf] = json.load(open(p))['secoes'] if os.path.exists(p) else None
    return _BASE[uf]


MUNIS = json.load(open(os.path.join(BASE, 'municipios.json')))
MUNIS_NORM = {uf: {norm(n): c for c, n in d.items()} for uf, d in MUNIS.items()}


def achar_municipio(uf, texto):
    """Converte o nome digitado no formulário no código TSE do município."""
    uf = (uf or '').upper()
    t = norm(texto)
    if not t or uf not in MUNIS_NORM:
        return None
    if re.fullmatch(r'\d{4,5}', t) and str(int(t)) in MUNIS[uf]:
        return str(int(t))
    t = re.sub(r'\s*[-/(,].*$', '', t).strip()  # "Salvador - BA", "Salvador (BA)"
    d = MUNIS_NORM[uf]
    if t in d:
        return d[t]
    t2 = t.replace("'", ' ').replace('  ', ' ')
    for n, c in d.items():
        if n.replace("'", ' ') == t2:
            return c
    import difflib
    m = difflib.get_close_matches(t, list(d), n=1, cutoff=0.88)
    return d[m[0]] if m else None


# ----------------------------------------------------------------- imagens
def carregar(conteudo, mime):
    """Devolve (lista de imagens RGB numpy, dados do arquivo)."""
    info = {'mime': mime, 'pdf_texto': False, 'scanner': False, 'camera': False, 'png': False}
    imgs = []
    if mime == 'application/pdf' or conteudo[:4] == b'%PDF':
        if fitz is None:
            return imgs, info
        doc = fitz.open(stream=conteudo, filetype='pdf')
        prod = norm((doc.metadata or {}).get('producer', '') + ' ' + (doc.metadata or {}).get('creator', ''))
        info['scanner'] = any(k in prod for k in ('camscanner', 'scan', 'adobe scan', 'genius', 'notes'))
        texto = ''.join(p.get_text() for p in doc)[:5000]
        info['pdf_texto'] = len(texto.strip()) > 80
        info['texto_pdf'] = texto
        for i, p in enumerate(doc):
            if i >= 4:
                break
            pix = p.get_pixmap(dpi=220)
            a = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.h, pix.w, pix.n)
            imgs.append(a[:, :, :3].copy())
        return imgs, info
    try:
        im = Image.open(io.BytesIO(conteudo))
        info['png'] = (im.format == 'PNG')
        ex = im.getexif() if hasattr(im, 'getexif') else {}
        info['camera'] = bool(ex.get(271) or ex.get(272))  # Make / Model
        im = ImageOps.exif_transpose(im).convert('RGB')
        imgs.append(np.asarray(im))
        info['w'], info['h'] = im.size
    except Exception:  # noqa: BLE001
        pass
    return imgs, info


def ler_qrs(img, alvo=None):
    """Lê todos os QR Codes de uma imagem; tenta escalas e recortes."""
    achados = set()

    def tentar(a):
        try:
            for b in zxingcpp.read_barcodes(a, formats=zxingcpp.BarcodeFormat.QRCode, try_rotate=True,
                                            try_downscale=True):
                if b.text:
                    achados.add(b.text)
        except Exception:  # noqa: BLE001
            pass

    def completo():
        frs = [t for t in achados if t.startswith('QRBU:')]
        if not frs:
            return False
        m = re.match(r'QRBU:(\d+):(\d+)', frs[0])
        return m and len({re.match(r'QRBU:(\d+)', t).group(1) for t in frs}) >= int(m.group(2))

    H, W = img.shape[:2]
    for lado in (2200, 3400, 1400):
        s = min(1.0, lado / max(H, W))
        a = cv2.resize(img, (int(W * s), int(H * s)), interpolation=cv2.INTER_AREA) if s < 1 else img
        tentar(a)
        if completo():
            return achados
    # recortes sobrepostos em resolução cheia (QR pequenos no fim do boletim)
    g = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    for frac in (0.5, 0.34):
        th, tw = int(H * frac), int(W * min(1, frac * 2))
        for y in range(0, max(1, H - th + 1), max(1, th // 2)):
            for x in range(0, max(1, W - tw + 1), max(1, tw // 2)):
                bloco = g[y:y + th, x:x + tw]
                tentar(bloco)
                if completo():
                    return achados
                # contraste local para papel térmico apagado
                tentar(cv2.adaptiveThreshold(bloco, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 41, 10))
                if completo():
                    return achados
    return achados


try:
    LINGUA_OCR = 'por' if 'por' in pytesseract.get_languages(config='') else 'eng'
except Exception:  # noqa: BLE001
    LINGUA_OCR = 'eng'


def ocr(img):
    if pytesseract is None:
        return ''
    g = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    H, W = g.shape
    s = min(1.0, 2600 / max(H, W))
    if s < 1:
        g = cv2.resize(g, (int(W * s), int(H * s)), interpolation=cv2.INTER_AREA)
    g = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(g)
    try:
        with _SEM_OCR:
            return pytesseract.image_to_string(g, lang=LINGUA_OCR, config='--psm 6', timeout=150)
    except Exception as e:  # noqa: BLE001
        log(f'OCR falhou ({type(e).__name__})')
        return ''


def depurar(img, nome):
    """Guarda miniatura CRIPTOGRAFADA para revisão (ilegível ao público)."""
    if SealedBox is None or os.environ.get('DEPURAR', '1') != '1':
        return
    im = Image.fromarray(img)
    im.thumbnail((1100, 1100))
    b = io.BytesIO()
    im.save(b, 'JPEG', quality=60)
    caixa = SealedBox(PublicKey(base64.b64decode(CHAVE_DEPURACAO)))
    os.makedirs(DEPURACAO, exist_ok=True)
    open(os.path.join(DEPURACAO, nome + '.bin'), 'wb').write(caixa.encrypt(b.getvalue()))


import threading
_LOCAL = threading.local()


def tem_rosto(img):
    mod = os.path.join(RAIZ, 'automacao', 'modelos', 'face_detection_yunet_2023mar.onnx')
    if not os.path.exists(mod):
        return True  # sem o detector, não publica a foto (por segurança)
    a = img
    H, W = a.shape[:2]
    s = min(1.0, 1280 / max(H, W))
    a = cv2.resize(a, (int(W * s), int(H * s))) if s < 1 else a
    if getattr(_LOCAL, 'rosto', None) is None:
        _LOCAL.rosto = cv2.FaceDetectorYN.create(mod, '', (a.shape[1], a.shape[0]), 0.85)
    _LOCAL.rosto.setInputSize((a.shape[1], a.shape[0]))
    _, f = _LOCAL.rosto.detect(cv2.cvtColor(a, cv2.COLOR_RGB2BGR))
    return f is not None and len(f) > 0


def miniatura(img):
    im = Image.fromarray(img)
    im.thumbnail((1400, 1400))
    b = io.BytesIO()
    im.save(b, 'JPEG', quality=72, optimize=True, progressive=True)  # sem EXIF
    return b.getvalue()


def salvar_publica(dados, nome):
    os.makedirs(PASTA_IMG, exist_ok=True)
    open(os.path.join(PASTA_IMG, nome + '.jpg'), 'wb').write(dados)
    return 'bus/img/' + nome + '.jpg'


def resumo_ocr(texto):
    """Guarda só o necessário do OCR (sem texto livre, que pode ter dado pessoal)."""
    t = norm(texto)
    linhas = [norm(l) for l in texto.splitlines() if l.strip()]
    nums = {}
    for nome, pal, cod in (('lula', 'lula', r'^\s*13\b'), ('flavio', 'flavio|bolsonaro', r'^\s*22\b'),
                           ('branco', 'branco', None), ('nulo', 'nulo', None)):
        for l in linhas:
            if re.search(pal, l) or (cod and re.search(cod, l)):
                ns = [int(x) for x in re.findall(r'\d+', l)][:6]
                if cod and len(ns) > 1 and ns[0] in (13, 22):
                    ns = ns[1:]
                nums.setdefault(nome, []).extend(ns)
    sens = any(p in t for p in ('comprovante', 'titulo eleitoral', 'credencial', 'cpf', 'identidade', 'fiscal'))
    return {'kw': sum(1 for p in PALAVRAS_BU if p in t), 'letras': len(re.findall(r'[a-z]{3,}', t)), 'sensivel': sens,
            'turno1': ('04/10/2026' in t or '1o turno' in t or '1 turno' in t), 'nums': nums}


# ----------------------------------------------------------------- BU
def chave_bu(textos):
    """Identidade do boletim pelo QR Code: seção + votos (mesma do site)."""
    g = {}
    for t in textos:
        if not t.startswith('QRBU:'):
            continue
        for tk in t.split():
            if ':' in tk:
                k, v = tk.split(':', 1)
                g.setdefault(k, v)
    campos = [g.get(k) for k in ('UNFE', 'MUNI', 'ZONA', 'SECA', '13', '22', 'BRAN', 'NULO')]
    if any(c is None for c in campos):
        return ''
    chave = '-'.join(str(int(c)) if c.isdigit() else c.upper() for c in campos)
    return hashlib.sha256(('bu:' + chave).encode()).hexdigest()


def montar_bu(textos):
    frs = {}
    total = None
    for t in textos:
        m = re.match(r'QRBU:(\d+):(\d+)\s', t)
        if m:
            frs[int(m.group(1))] = t
            total = int(m.group(2))
    if not frs:
        return None
    falta = [i for i in range(1, total + 1) if i not in frs]
    partes = []
    for i in sorted(frs):
        t = re.sub(r'^QRBU:\S+\s+VRQR:\S+\s*', '', frs[i])
        t = re.sub(r'\s*HASH:[0-9A-Fa-f]+(\s+ASSI:[0-9A-Fa-f]+)?\s*$', '', t)
        partes.append(t)
    geral, cargos, atual = {}, [], None
    for tk in ' '.join(partes).split():
        if ':' not in tk:
            continue
        k, v = tk.split(':', 1)
        if k == 'CARG':
            atual = {'CARG': v, 'votos': {}}
            cargos.append(atual)
        elif atual is not None:
            if k.isdigit():
                atual['votos'][k] = int(v) if v.isdigit() else v
            else:
                atual[k] = v
        else:
            geral[k] = v
    pres = next((c for c in cargos if c['CARG'] == '1'), None)
    return {'falta': falta, 'total': total, 'geral': geral, 'pres': pres}


PALAVRAS_BU = ('boletim', 'urna', 'eleitores', 'apto', 'comparec', 'brancos', 'nulos', 'presidente',
               'zona', 'secao', 'votos', 'nominais', 'total apurado', 'justica eleitoral')


def processar_arquivo(fid):
    """Baixa e analisa um arquivo. Resultado sem nenhum dado pessoal."""
    d = ponte_get(acao='arquivo', id=fid)
    conteudo = base64.b64decode(d['b64'])
    sha = hashlib.sha256(conteudo).hexdigest()
    imgs, info = carregar(conteudo, d.get('mime', ''))
    res = {'v': VERSAO, 'sha': sha, 'mime': info['mime'], 'paginas': len(imgs), 'qr': [], 'outros_qr': 0,
           'ocr': {'kw': 0, 'letras': 0, 'turno1': False, 'nums': {}},
           'camera': info['camera'], 'png': info['png'], 'pdf_texto': info['pdf_texto'],
           'scanner': info['scanner'], 'rosto': False, 'foto': None}
    if not imgs:
        res['erro'] = 'nao_abriu'
        return res, None
    qrs = set()
    for im in imgs:
        qrs |= ler_qrs(im)
    res['qr'] = sorted(q for q in qrs if q.startswith('QRBU:'))  # QR de outro tipo pode ter dado pessoal
    res['outros_qr'] = len(qrs) - len(res['qr'])
    res['outros_qr_inicio'] = sorted({re.sub(r'[^A-Za-z:/.]', '', q[:8]) for q in qrs if not q.startswith('QRBU:')})
    bu = montar_bu(res['qr'])
    if not bu or bu['falta']:
        res['ocr'] = resumo_ocr((info.get('texto_pdf') or '') + '\n' + '\n'.join(ocr(im) for im in imgs[:2]))
    res['rosto'] = any(tem_rosto(im) for im in imgs[:2])
    if not bu or bu['falta']:
        try:
            depurar(imgs[0], h('dep' + fid, 20))
        except Exception:  # noqa: BLE001
            pass
    return res, (None if res['rosto'] else miniatura(imgs[0]))


# ----------------------------------------------------------------- respostas
def campos(resp):
    c = {'uf': '', 'municipio': '', 'zona': '', 'secao': '', 'turno': '', 'arquivos': [],
         'nome': '', 'whats': ''}
    for it in resp['itens']:
        t, v = norm(it['t']), it['v']
        if it['tipo'] == 'FILE_UPLOAD' or isinstance(v, list):
            c['arquivos'] += list(v or [])
        elif 'whats' in t or 'telefone' in t or 'celular' in t:
            c['whats'] = str(v)
            if 'nome' in t:
                c['nome'] = str(v)
        elif 'nome' in t:
            c['nome'] = str(v)
        elif 'municip' in t or 'cidade' in t:
            c['municipio'] = str(v)
        elif 'zona' in t:
            c['zona'] = str(v)
        elif 'secao' in t:
            c['secao'] = str(v)
        elif 'turno' in t:
            c['turno'] = str(v)
        elif t in ('uf', 'estado') or 'uf' in t.split() or 'estado' in t:
            c['uf'] = str(v).strip().upper()[:2]
    return c


def telefone(texto):
    dig = re.sub(r'\D', '', texto or '')
    if len(dig) in (10, 11):
        dig = '55' + dig
    return dig if len(dig) in (12, 13) and dig.startswith('55') else ''


def inteiro(s):
    m = re.search(r'\d+', str(s or ''))
    return int(m.group()) if m else None


def classificar(resp, c, arqs, revisao):
    """Classifica um envio a partir dos arquivos já analisados."""
    validos = [a for a in arqs if a and not a.get('erro')]
    qrs = sorted({q for a in validos for q in a['qr']})
    bu = montar_bu(qrs)
    r = {'uf': c['uf'], 'mun': achar_municipio(c['uf'], c['municipio']), 'zona': inteiro(c['zona']),
         'secao': inteiro(c['secao']), 'lido': None, 'oficial': None, 'conta': None, 'motivo': '',
         'fonte': ''}
    kw = max([a['ocr'].get('kw', 0) for a in validos] or [0])
    letras = sum(a['ocr'].get('letras', 0) for a in validos)
    turno1 = any(a['ocr'].get('turno1') for a in validos)
    digital = validos and all((a['png'] and not a['camera']) or (a['pdf_texto'] and not a['scanner'])
                              for a in validos)

    if bu and bu['pres'] and not bu['falta']:
        g, p = bu['geral'], bu['pres']
        r.update(uf=g.get('UNFE', r['uf']).upper(), mun=str(int(g['MUNI'])) if g.get('MUNI', '').isdigit() else r['mun'],
                 zona=inteiro(g.get('ZONA')) or r['zona'], secao=inteiro(g.get('SECA')) or r['secao'])
        r['lido'] = [p['votos'].get('13'), p['votos'].get('22'), inteiro(p.get('BRAN')), inteiro(p.get('NULO'))]
        r['fonte'] = 'QR Code'
        try:
            nomi, totc = int(p.get('NOMI')), int(p.get('TOTC'))
            l = r['lido']
            r['conta'] = (l[0] + l[1] == nomi) and (l[0] + l[1] + l[2] + l[3] == totc)
        except Exception:  # noqa: BLE001
            pass
        if g.get('TURN') and g['TURN'] != '2':
            return 'primeiro_turno', r
        if digital:
            r['motivo'] = 'imagem gerada em tela (print ou PDF digital), não é foto do papel'
            st = 'via_digital'
        else:
            st = None
        base = base_uf(r['uf'])
        chave = f"{r['mun']}-{r['zona']}-{r['secao']}"
        of = base.get(chave) if base else None
        if of is None:
            return st or 'nao_encontrada', r
        r['oficial'] = of
        if st:
            return st, r
        return ('confere' if r['lido'] == of else 'diverge'), r

    # sem QR completo: tenta os números pelo texto, com a seção informada no formulário
    if turno1 and kw >= 3:
        return 'primeiro_turno', r
    base = base_uf(r['uf'])
    of = base.get(f"{r['mun']}-{r['zona']}-{r['secao']}") if (base and r['mun']) else None
    r['oficial'] = of
    man = revisao.get(h(resp['id']))
    if man:
        cl = norm(man.get('Classificação manual', ''))
        if cl.startswith('nao') or 'nao e' in cl:
            return 'nao_e_bu', r
        if cl.startswith('ileg'):
            return 'ilegivel', r
        nums = [inteiro(man.get(k)) for k in ('Lula', 'Flávio', 'Brancos', 'Nulos')]
        if all(n is not None for n in nums):
            r['lido'] = nums
            r['fonte'] = 'revisão manual'
            if of is None:
                return 'nao_encontrada', r
            return ('confere_numeros' if nums == of else 'diverge'), r
    if bu and bu['falta']:
        r['motivo'] = f"faltam QR Codes ({len(bu['falta'])} de {bu['total']})"
    if of is not None and kw >= 2:
        nums = {}
        for a in validos:
            for k2, v2 in a['ocr'].get('nums', {}).items():
                nums.setdefault(k2, []).extend(v2)
        ok = [v in nums.get(k2, []) for k2, v in zip(('lula', 'flavio', 'branco', 'nulo'), of)]
        if all(ok):
            r['lido'] = of
            r['fonte'] = 'leitura dos números'
            if digital:
                return 'via_digital', r
            return 'confere_numeros', r
    if digital and kw >= 3:
        return 'via_digital', r
    if kw >= 3 or (bu is not None):
        r['motivo'] = r['motivo'] or 'boletim identificado, números ainda não confirmados'
        return 'em_analise', r
    if not validos:
        r['motivo'] = 'arquivo não abriu'
        return 'ilegivel', r
    if letras > 40:
        r['motivo'] = 'imagem com texto, sem sinais de boletim de urna'
        return 'nao_e_bu', r
    r['motivo'] = 'não foi possível ler QR Code nem números'
    return 'ilegivel', r


# ----------------------------------------------------------------- principal
def main():
    if not URL or not TOKEN:
        log('Ponte ainda não configurada (falta a URL ou a senha). Nada a fazer.')
        return
    estado = json.load(open(ESTADO)) if os.path.exists(ESTADO) else {'arquivos': {}}
    cache = estado['arquivos']
    respostas = ponte_get(acao='respostas')
    log(f'{len(respostas)} respostas no formulário')
    marc = ponte_get(acao='marcacoes')
    aprovadas = {k for k, v in marc.get('Divergências para aprovar', {}).items() if v.get('Aprovar publicação') is True}
    revisao = marc.get('Revisão manual', {})

    envios = [(r, campos(r)) for r in respostas]
    envios = [e for e in envios if 'TESTE' not in e[1]['municipio'].upper()]  # envios de teste do formulário
    todos = [fid for _, c in envios for fid in c['arquivos']]
    def completo(a):
        b = montar_bu(a.get('qr', [])) if a else None
        return bool(b and not b['falta'])
    novos = [f for f in dict.fromkeys(todos)
             if h(f) not in cache or (cache[h(f)].get('v') != VERSAO and not completo(cache[h(f)]))]
    novos.sort(key=lambda f: h(f) in cache)  # primeiro os nunca vistos
    log(f'{len(todos)} arquivos, {len(novos)} a processar')
    imagens = {}

    def tarefa(fid):
        try:
            return fid, *processar_arquivo(fid)
        except Exception as e:  # noqa: BLE001
            return fid, {'v': VERSAO, 'erro': type(e).__name__, 'qr': [], 'ocr': {}}, None

    feitos = 0
    limite = int(os.environ.get('LIMITE_ARQUIVOS', '100000'))
    # tempo máximo de processamento por rodada: o que sobrar fica para a próxima
    prazo = time.time() + 60 * float(os.environ.get('MINUTOS_MAX', '25'))
    fila = novos[:limite]
    with cf.ThreadPoolExecutor(max_workers=int(os.environ.get('TRABALHADORES', '4'))) as ex:
        for i in range(0, len(fila), 20):
            if time.time() > prazo:
                log(f'tempo da rodada esgotado; {len(fila) - i} arquivos ficam para a próxima')
                break
            for fid, res, img in ex.map(tarefa, fila[i:i + 20]):
                cache[h(fid)] = res
                if img is not None:
                    imagens[h(fid)] = img
                feitos += 1
            log(f'{feitos}/{len(novos)} arquivos processados')

    # classificação por envio
    vistos_sha = {}
    itens, internos = [], []
    for r, c in sorted(envios, key=lambda x: x[0]['ts']):
        arqs = [cache.get(h(f)) for f in c['arquivos']]
        shas = [a.get('sha') for a in arqs if a and a.get('sha')]
        if any(a is None for a in arqs):
            info = {'uf': c['uf'], 'mun': achar_municipio(c['uf'], c['municipio']), 'zona': inteiro(c['zona']),
                    'secao': inteiro(c['secao']), 'lido': None, 'oficial': None, 'conta': None,
                    'motivo': 'aguardando processamento', 'fonte': ''}
            internos.append((r, c, 'na_fila', info, arqs))
            continue
        st, info = classificar(r, c, arqs, revisao)
        chave_env = h(r['id'])
        if shas and all(s in vistos_sha for s in shas):
            info['motivo'] = 'mesma foto já enviada antes'
            st = 'repetida'
        for s in shas:
            vistos_sha.setdefault(s, chave_env)
        internos.append((r, c, st, info, arqs))

    # placar e itens públicos
    secoes_vistas = {}
    faltam_fotos = []
    for r, c, st, info, arqs in internos:
        chave_env = h(r['id'])
        sec = f"{info['uf']}-{info['mun']}-{info['zona']}-{info['secao']}" if info['mun'] else None
        publico = st
        if st == 'diverge' and chave_env not in aprovadas:
            publico = 'em_analise'
        fotos = []
        if publico in ('confere', 'confere_numeros', 'diverge', 'em_analise', 'nao_encontrada', 'ilegivel'):
            for f, a in zip(c['arquivos'], arqs):
                if not a or a.get('erro') or a.get('rosto'):
                    continue
                nome = h('img' + f, 20)
                arq = os.path.join(PASTA_IMG, nome + '.jpg')
                # só publica a foto que tem o QR Code do boletim (evita comprovantes, crachás, documentos)
                eh_bu = bool(a.get('qr')) and not a.get('ocr', {}).get('sensivel')
                if not eh_bu:
                    continue
                if os.path.exists(arq):
                    fotos.append('bus/img/' + nome + '.jpg')
                elif h(f) in imagens:
                    fotos.append(salvar_publica(imagens[h(f)], nome))
                else:
                    faltam_fotos.append((f, nome, fotos))
        itens.append({
            'id': chave_env[:12], 'data': r['ts'][:10], 'uf': info['uf'] or '',
            'mun': info['mun'] or '', 'municipio': MUNIS.get(info['uf'] or '', {}).get(info['mun'] or '', ''),
            'zona': info['zona'], 'secao': info['secao'], 'status': publico, 'rotulo': ROTULOS[publico],
            'lido': info['lido'] if publico in ('confere', 'confere_numeros', 'diverge') else None,
            'oficial': info['oficial'] if publico in ('confere', 'confere_numeros', 'diverge') else None,
            'fonte': info['fonte'] if publico in ('confere', 'confere_numeros', 'diverge') else '',
            'conta': info['conta'], 'fotos': fotos,
        })
        if sec and publico in ('confere', 'confere_numeros', 'diverge'):
            secoes_vistas.setdefault(sec, publico)

    # fotos de envios que só agora ficaram publicáveis: baixa de novo
    for f, nome, lista in faltam_fotos[:200]:
        try:
            _, mini = processar_arquivo(f)
            if mini:
                lista.append(salvar_publica(mini, nome))
        except Exception:  # noqa: BLE001
            pass
    # apaga do site qualquer foto que não esteja mais em uso
    usadas = {os.path.basename(f) for it in itens for f in it['fotos']}
    if os.path.isdir(PASTA_IMG):
        for nome in os.listdir(PASTA_IMG):
            if nome not in usadas:
                os.remove(os.path.join(PASTA_IMG, nome))
    cont = {}
    for it in itens:
        cont[it['status']] = cont.get(it['status'], 0) + 1
    contato = [x for x in internos if x[2] in ('ilegivel', 'em_analise')]
    placar = {
        'envios': len(itens),
        'secoes_conferidas': len(secoes_vistas),
        'secoes_conferem': sum(1 for v in secoes_vistas.values() if v in ('confere', 'confere_numeros')),
        'por_status': cont,
        'votos_conferidos': sum((it['lido'][0] or 0) + (it['lido'][1] or 0) for it in itens
                                if it['lido'] and it['status'] in ('confere', 'confere_numeros')),
    }
    agora = dt.datetime.now(dt.timezone(dt.timedelta(hours=-3))).strftime('%Y-%m-%dT%H:%M:%S-03:00')
    os.makedirs(os.path.dirname(SAIDA), exist_ok=True)
    json.dump({'atualizado': agora, 'placar': placar, 'rotulos': ROTULOS, 'itens': itens[::-1]},
              open(SAIDA, 'w'), ensure_ascii=False, separators=(',', ':'))
    shas = sorted({a['sha'] for a in cache.values() if a.get('sha')})
    bus = sorted({chave_bu(a.get('qr', [])) for a in cache.values()} - {''})
    json.dump({'atualizado': agora, 'shas': shas, 'bus': bus}, open(os.path.join(os.path.dirname(SAIDA), 'shas.json'), 'w'), separators=(',', ':'))
    json.dump(estado, open(ESTADO, 'w'), ensure_ascii=False, separators=(',', ':'))
    log('placar', json.dumps(placar, ensure_ascii=False))

    # painel interno (restrito) na planilha do Rogerio
    link = lambda f: f'https://drive.google.com/file/d/{f}/view'  # noqa: E731
    msg = ('Olá! Aqui é da Revista Timeline. Recebemos a foto do boletim de urna que você enviou para a '
           'conferência nacional, mas não conseguimos ler os números com segurança. Pode enviar de novo? '
           'Dica: fotografe o boletim inteiro, de perto, com boa luz, sem reflexo, e inclua os QR Codes do '
           f'final sem cortar as bordas. Formulário: {FORM_LINK} Obrigado por fiscalizar!')
    fmt = lambda v: '' if v is None else ' / '.join('' if x is None else str(x) for x in v)  # noqa: E731
    resumo = [['Indicador', 'Valor'], ['Atualizado em', agora], ['Envios no formulário', len(itens)],
              ['Seções conferidas (únicas)', placar['secoes_conferidas']],
              ['Seções que conferem', placar['secoes_conferem']]]
    resumo += [[ROTULOS[k] + (' (integridade: ' + INTEGRIDADE[k] + ')' if k in INTEGRIDADE else ''), v]
               for k, v in sorted(cont.items(), key=lambda x: -x[1])]
    resumo += [['Divergências reais (antes da aprovação)', sum(1 for x in internos if x[2] == 'diverge')],
               ['Pessoas para contatar (ilegível ou incompleto)', len(contato)],
               ['… dessas, com WhatsApp', sum(1 for x in contato if telefone(x[1]['whats']))],
               ['Página pública', SITE]]
    div = [['chave', 'Recebido', 'UF', 'Município', 'Zona', 'Seção', 'Fonte', 'Boletim (Lula/Flávio/Br/Nu)',
            'TSE (Lula/Flávio/Br/Nu)', 'Conta interna', 'Fotos (Drive)', 'Aprovar publicação', 'Observação do Rogerio']]
    rev = [['chave', 'Recebido', 'UF', 'Município digitado', 'Zona', 'Seção', 'Motivo', 'TSE (Lula/Flávio/Br/Nu)',
            'Fotos (Drive)', 'Classificação manual', 'Lula', 'Flávio', 'Brancos', 'Nulos']]
    con = [['chave', 'Recebido', 'Nome', 'WhatsApp', 'Abrir conversa', 'UF', 'Município', 'Zona', 'Seção',
            'Situação', 'Motivo', 'Fotos (Drive)', 'Contatado?']]
    tod = [['chave', 'Recebido', 'Nome', 'WhatsApp', 'UF', 'Município digitado', 'Código TSE', 'Zona', 'Seção',
            'Situação', 'Integridade', 'Motivo', 'Fonte', 'Boletim', 'TSE', 'Arquivos', 'Fotos (Drive)']]
    for r, c, st, info, arqs in internos:
        k = h(r['id'])
        fotos = '\n'.join(link(f) for f in c['arquivos'])
        base = [k, r['ts'][:16].replace('T', ' ')]
        if st == 'diverge':
            div.append(base + [info['uf'], c['municipio'], info['zona'], info['secao'], info['fonte'],
                               fmt(info['lido']), fmt(info['oficial']), {True: 'ok', False: 'NÃO FECHA', None: ''}[info['conta']],
                               fotos, k in aprovadas, ''])
        if st == 'em_analise':
            rev.append(base + [info['uf'], c['municipio'], info['zona'], info['secao'], info['motivo'],
                               fmt(info['oficial']), fotos, '', '', '', '', ''])
        if st in ('ilegivel', 'em_analise'):
            tel = telefone(c['whats'])
            wa = f'https://wa.me/{tel}?text=' + urllib.parse.quote(msg) if tel else ''
            con.append(base + [c['nome'], c['whats'], wa, info['uf'], c['municipio'], info['zona'], info['secao'],
                               ROTULOS[st], info['motivo'], fotos, False])
        tod.append(base + [c['nome'], c['whats'], info['uf'], c['municipio'], info['mun'] or '', info['zona'],
                           info['secao'], ROTULOS[st], INTEGRIDADE.get(st, 'Descarte'), info['motivo'], info['fonte'],
                           fmt(info['lido']), fmt(info['oficial']), len(c['arquivos']), fotos])
    corpo = {'abas': {'Resumo': resumo, 'Divergências para aprovar': div, 'Revisão manual': rev,
                      'Contato para reenvio': con, 'Todos os envios': tod,
                      'Mensagem padrão': [['Mensagem para quem enviou imagem ilegível ou incompleta'], [msg]]},
             'editaveis': {'Divergências para aprovar': ['Aprovar publicação', 'Observação do Rogerio'],
                           'Revisão manual': ['Classificação manual', 'Lula', 'Flávio', 'Brancos', 'Nulos'],
                           'Contato para reenvio': ['Contatado?']},
             'caixas': {'Divergências para aprovar': ['Aprovar publicação'], 'Contato para reenvio': ['Contatado?']}}
    try:
        ponte_post(corpo)
        log('painel interno atualizado')
    except Exception as e:  # noqa: BLE001
        log(f'falha ao gravar painel interno ({type(e).__name__})')


if __name__ == '__main__':
    main()

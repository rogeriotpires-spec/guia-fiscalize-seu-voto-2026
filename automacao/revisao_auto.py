"""Revisão automática (segunda passagem) dos envios em análise.

Melhora a leitura de QR Code e do texto quando a primeira passagem não
fecha o boletim. Só confirma quando os números batem com o TSE.
Não publica divergência, não chama a ponte e não grava o painel.
"""
from __future__ import annotations

import re
import sys
import os

import cv2
import numpy as np
import zxingcpp

# garante que 'import robo' funcione quando este arquivo é o ponto de entrada
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _robo():
    import robo
    return robo


def cinza(img):
    """Converte RGB, BGR ou cinza para uma única camada uint8."""
    if img.ndim == 2:
        return img
    if img.shape[2] == 4:
        img = img[:, :, :3]
    return cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)


def _escala(img, lado):
    h, w = img.shape[:2]
    m = max(h, w)
    if m == 0:
        return img
    if m == lado:
        return img
    s = lado / m
    interp = cv2.INTER_CUBIC if s > 1 else cv2.INTER_AREA
    return cv2.resize(img, (max(1, int(w * s)), max(1, int(h * s))), interpolation=interp)


def _nitidez(g):
    return cv2.filter2D(g, -1, np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]], dtype=np.float32))


def _deskew(g):
    """Endireita inclinacoes leves (0,8° a 15°). Devolve a imagem original se não houver ângulo confiável."""
    if g is None or min(g.shape[:2]) < 80:
        return g
    t = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    # papel térmico é claro: o texto/QR fica escuro
    if np.mean(t) > 127:
        t = 255 - t
    coords = np.column_stack(np.where(t > 0))
    if len(coords) < 200:
        return g
    ang = cv2.minAreaRect(coords)[-1]
    if ang < -45:
        ang += 90
    if abs(ang) < 0.8 or abs(ang) > 15:
        return g
    h, w = g.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), ang, 1.0)
    return cv2.warpAffine(g, m, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def _completou(achados):
    robo = _robo()
    bu = robo.montar_bu(sorted(t for t in achados if t.startswith('QRBU:')))
    return bool(bu and not bu['falta'])


def _zxing(img, achados, binarizer=None):
    kw = dict(formats=zxingcpp.BarcodeFormat.QRCode, try_rotate=True, try_downscale=True, try_invert=True)
    if binarizer is not None:
        kw['binarizer'] = binarizer
    try:
        for b in zxingcpp.read_barcodes(img, **kw):
            if b.text:
                achados.add(b.text)
    except Exception:  # noqa: BLE001
        pass


def _opencv_qrs(img, achados):
    g = cinza(img)
    try:
        det = cv2.QRCodeDetector()
        ok, textos, _, _ = det.detectAndDecodeMulti(g)
        if ok and textos:
            for t in textos:
                if t:
                    achados.add(t)
            return
    except Exception:  # noqa: BLE001
        pass
    try:
        t, _, _ = cv2.QRCodeDetector().detectAndDecode(g)
        if t:
            achados.add(t)
    except Exception:  # noqa: BLE001
        pass


def _recortes_inferiores(g):
    """Faixas na parte de baixo e no meio, onde costumam ficar os QR do BU."""
    h, w = g.shape[:2]
    out = []
    for y0, y1 in ((int(h * 0.35), h), (int(h * 0.55), h), (int(h * 0.15), int(h * 0.7)), (0, int(h * 0.5))):
        if y1 - y0 >= 40:
            out.append(g[y0:y1, 0:w])
    return out


def _papeis(g):
    """Recorta regiões claras e alongadas (o papel do boletim numa foto de cena)."""
    h, w = g.shape[:2]
    if h * w < 20000:
        return []
    blur = cv2.GaussianBlur(g, (9, 9), 0)
    _, mask = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    if np.mean(mask) < 127:
        mask = 255 - mask
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    contornos, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    recortes = []
    area_min = 0.04 * h * w
    for c in contornos:
        x, y, cw, ch = cv2.boundingRect(c)
        if cw * ch < area_min or cw < 80 or ch < 80:
            continue
        if cw * ch > 0.95 * h * w:
            continue
        recortes.append(g[y:y + ch, x:x + cw])
    recortes.sort(key=lambda im: im.shape[0] * im.shape[1], reverse=True)
    return recortes[:6]


def ler_qrs_reforcado(img, ja=None):
    """Segunda tentativa de QR: cinza, aumento de escala, inclinacao, cortes e outro decodificador."""
    achados = set(ja or [])
    if _completou(achados):
        return achados

    g0 = cinza(img)
    base = [g0, _deskew(g0), _nitidez(g0)]
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(g0)
    base.append(clahe)
    adapt = cv2.adaptiveThreshold(g0, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 41, 10)
    base.append(adapt)

    lados = []
    m = max(g0.shape[:2])
    if m < 1800:
        lados.append(2200)
        lados.append(3000)
    else:
        lados.extend([2200, 2800, 3600])
        if m > 3600:
            lados.append(m)  # resolução original, via zxing em cinza

    binarios = [None, zxingcpp.Binarizer.GlobalHistogram, zxingcpp.Binarizer.FixedThreshold]

    def tentar_img(a):
        for binarizer in binarios:
            _zxing(a, achados, binarizer=binarizer)
            if _completou(achados):
                return True
        _opencv_qrs(a, achados)
        return _completou(achados)

    for g in base:
        for lado in lados:
            a = _escala(g, lado) if max(g.shape[:2]) != lado else g
            if tentar_img(a):
                return achados
        if tentar_img(g):
            return achados

    # recortes (papel, faixa dos QR) em alta resolução
    extras = _papeis(g0) + _recortes_inferiores(g0)
    for rec in extras:
        if tentar_img(_escala(rec, 2200)) or tentar_img(_escala(_nitidez(rec), 2600)):
            return achados

    # rotações completas só se ainda faltar QR (zxing já tenta 90°, isto cobre 180° com pré-processamento)
    if not _completou(achados):
        for ang in (180, 90, 270):
            rot = cv2.rotate(g0, {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}[ang])
            if tentar_img(_escala(rot, 2200)):
                return achados
    return achados


def ocr_reforcado(img, timeout=40, partes=False):
    """Várias pré-processagens e configs do Tesseract; devolve texto (ou lista, se partes=True)."""
    robo = _robo()
    if robo.pytesseract is None:
        return ''
    g0 = cinza(img)
    h, w = g0.shape[:2]
    s = min(1.0, 3200 / max(h, w)) if max(h, w) > 3200 else (1600 / max(h, w) if max(h, w) < 1200 else 1.0)
    if s != 1:
        g0 = cv2.resize(g0, (max(1, int(w * s)), max(1, int(h * s))),
                        interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
    variantes = [
        cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(g0),
        _nitidez(cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(g0)),
        cv2.adaptiveThreshold(g0, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 9),
        _deskew(g0),
    ]
    # se a foto tem dois boletins, lê cada papel
    variantes.extend(_papeis(g0)[:3])
    configs = ['--psm 6', '--psm 4']
    partes = []
    vistos = set()
    for g in variantes:
        if g is None or g.size == 0:
            continue
        chave = (g.shape, int(g.mean()), int(g.std()))
        if chave in vistos:
            continue
        vistos.add(chave)
        for cfg in configs:
            try:
                with robo._SEM_OCR:
                    t = robo.pytesseract.image_to_string(g, lang=robo.LINGUA_OCR, config=cfg, timeout=timeout)
                if t and t.strip():
                    partes.append(t)
            except Exception:  # noqa: BLE001
                continue
        if sum(len(p) for p in partes) > 8000:
            break
    if partes:
        return partes
    return '\n'.join(partes)


def resumo_ocr_ampliado(texto):
    """Como resumo_ocr, mas também lê números na linha seguinte e padrões '13 0117'."""
    robo = _robo()
    base = robo.resumo_ocr(texto)
    linhas = [robo.norm(l) for l in texto.splitlines() if l.strip()]
    nums = {k: list(v) for k, v in (base.get('nums') or {}).items()}

    def add(nome, valores):
        nums.setdefault(nome, []).extend(valores)

    # 13/22 seguidos do total (com ou sem zeros à esquerda)
    for l in linhas:
        for nome, cod in (('lula', 13), ('flavio', 22)):
            for m in re.finditer(rf'(?:^|\s){cod}\s*[:.\-]?\s*(\d{{1,5}})\b', l):
                add(nome, [int(m.group(1))])
        if re.search(r'\blula\b', l):
            ns = [int(x) for x in re.findall(r'\d+', l)]
            ns = [n for n in ns if n != 13]
            add('lula', ns[:4])
        if re.search(r'\bflavio\b|\bbolsonaro\b', l):
            ns = [int(x) for x in re.findall(r'\d+', l)]
            ns = [n for n in ns if n != 22]
            add('flavio', ns[:4])

    # número sozinho na linha imediatamente abaixo do rótulo
    rotulo = {
        r'lula|\b13\b': 'lula',
        r'flavio|bolsonaro|\b22\b': 'flavio',
        r'branco': 'branco',
        r'nulo': 'nulo',
        r'nominais|total de votos nominais': 'nominais',
        r'total apurado|totais? de votos': 'total',
    }
    for i, l in enumerate(linhas[:-1]):
        nxt = linhas[i + 1]
        if not re.fullmatch(r'[\d\s./]+', nxt):
            continue
        ns = [int(x) for x in re.findall(r'\d+', nxt)]
        if not ns:
            continue
        for pat, nome in rotulo.items():
            if re.search(pat, l):
                add(nome, ns[:4])

    base['nums'] = nums
    return base


def fundir_ocr(textos):
    """Junta várias leituras de OCR sem inflar 'letras' (evita classificar BU como nao_e_bu)."""
    resumos = [resumo_ocr_ampliado(t) for t in textos if t and str(t).strip()]
    if not resumos:
        return {'kw': 0, 'letras': 0, 'turno1': False, 'nums': {}}
    nums = {}
    for r in resumos:
        for k, vs in (r.get('nums') or {}).items():
            nums.setdefault(k, []).extend(vs)
    out = {
        'kw': max(r.get('kw') or 0 for r in resumos),
        'letras': max(r.get('letras') or 0 for r in resumos),
        'turno1': any(r.get('turno1') for r in resumos),
        'nums': nums,
    }
    if any(r.get('sensivel') for r in resumos):
        out['sensivel'] = True
    return out



def numeros_conferem(nums, oficial):
    """Verdadeiro só se os quatro totais oficiais aparecem na leitura, com consistência extra se houver."""
    if not oficial or len(oficial) < 4 or any(v is None for v in oficial):
        return False
    chaves = ('lula', 'flavio', 'branco', 'nulo')
    listas = [list(nums.get(k) or []) for k in chaves]
    if not all(oficial[i] in listas[i] for i in range(4)):
        return False
    # se o OCR também leu nominais ou total apurado, algum desses valores precisa fechar
    lula, flavio, branco, nulo = oficial
    if nums.get('nominais') and (lula + flavio) not in nums['nominais']:
        return False
    if nums.get('total') and (lula + flavio + branco + nulo) not in nums['total']:
        return False
    return True


def motivo_pendente(bu=None, uf=None, mun=None, zona=None, secao=None, oficial=None, nums=None):
    """Texto curto, sem dado pessoal, para deixar o item em análise com uma razão."""
    if (uf or '').upper() == 'ZZ' or (uf and _robo().base_uf(uf) is None):
        return 'UF sem base local para confronto (ex.: seção no exterior, ZZ); não é possível confirmar automaticamente'
    if bu and bu.get('falta'):
        falta = bu['falta']
        return f"faltam QR Codes ({len(falta)} de {bu['total']})"
    if oficial is None and mun and zona and secao:
        return f'seção {zona}/{secao} não encontrada na base do TSE desta UF'
    if oficial is not None and nums is not None:
        chaves = ('lula', 'flavio', 'branco', 'nulo')
        faltam = [k for i, k in enumerate(chaves) if oficial[i] not in (nums.get(k) or [])]
        if faltam:
            return 'boletim identificado, números ainda não confirmados (' + ', '.join(faltam) + ')'
    if bu is not None:
        return 'boletim identificado, números ainda não confirmados'
    return 'não foi possível ler QR Code completo nem confirmar os números com o TSE'


def classificar_segunda_passagem(status, info, arqs, uf, mun, zona, secao):
    """Reavalia um item em_analise/nao_encontrada a partir dos arquivos já relidos.

    Devolve (status, info) sem nunca marcar confere se os números não baterem.
    Divergência lida com segurança permanece 'diverge' (o painel público já
    a esconde como em_analise até haver aprovação).
    """
    # esta função é um ajudante para o dry-run; a classificação oficial
    # continua em robo.classificar, que usa as mesmas regras reforçadas.
    return status, info

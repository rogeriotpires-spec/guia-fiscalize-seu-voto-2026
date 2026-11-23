"""Dry-run da revisão automática, só com dados já públicos (painel + fotos locais).

Não chama a ponte, não grava painel.json, não altera estado.json e não
escreve na planilha. Uso:

    python automacao/dryrun_revisao.py --painel data/bus/painel.json \\
        --fotos /caminho/das/miniaturas --saida /tmp/dryrun-revisao.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import revisao_auto
import robo


def _abrir(caminho):
    im = ImageOps.exif_transpose(Image.open(caminho)).convert('RGB')
    return np.asarray(im)


def processar_local(caminhos):
    """Espelha processar_arquivo, mas lê o disco e nunca fala com a ponte."""
    qrs = set()
    imgs = []
    for c in caminhos:
        if not os.path.isfile(c):
            continue
        imgs.append(_abrir(c))
    if not imgs:
        return {'qr': [], 'ocr': {'kw': 0, 'letras': 0, 'turno1': False, 'nums': {}},
                'erro': 'nao_abriu', 'png': False, 'camera': True, 'pdf_texto': False, 'scanner': False, 'sha': None}
    for im in imgs:
        qrs |= robo.ler_qrs(im)
    bu = robo.montar_bu(sorted(q for q in qrs if q.startswith('QRBU:')))
    if not bu or bu['falta']:
        for im in imgs:
            qrs |= revisao_auto.ler_qrs_reforcado(im, qrs)
    qr = sorted(q for q in qrs if q.startswith('QRBU:'))
    bu = robo.montar_bu(qr)
    ocr = {'kw': 0, 'letras': 0, 'turno1': False, 'nums': {}}
    if not bu or bu['falta']:
        textos = []
        for im in imgs[:2]:
            textos.extend(revisao_auto.ocr_reforcado(im, partes=True) or [])
        ocr = revisao_auto.fundir_ocr(textos)
    return {'qr': qr, 'ocr': ocr, 'erro': None, 'png': False, 'camera': True,
            'pdf_texto': False, 'scanner': False, 'sha': None, 'rosto': False}


def classificar_item(item, arq):
    resp = {'id': item['id'], 'ts': (item.get('data') or '2026-01-01') + 'T00:00:00', 'itens': []}
    c = {
        'uf': item.get('uf') or '',
        'municipio': item.get('municipio') or item.get('mun') or '',
        'zona': '' if item.get('zona') is None else str(item['zona']),
        'secao': '' if item.get('secao') is None else str(item['secao']),
        'arquivos': ['local'], 'nome': '', 'whats': '', 'turno': '',
    }
    st, info = robo.classificar(resp, c, [arq], {})
    if item.get('status') in ('em_analise', 'nao_encontrada', 'ilegivel') and st == 'nao_e_bu':
        info['motivo'] = (info.get('motivo') or 'texto inconclusivo') + ' (mantido em análise: a revisão automática não descarta sozinha um envio já identificado)'
        st = 'em_analise'
    # o painel público não publica divergência sem aprovação
    publico = 'em_analise' if st == 'diverge' else st
    return st, publico, info


def main():
    ap = argparse.ArgumentParser(description='Dry-run da revisão automática (somente leitura).')
    ap.add_argument('--painel', default=os.path.join(robo.RAIZ, 'data', 'bus', 'painel.json'))
    ap.add_argument('--fotos', default='', help='Pasta com as miniaturas públicas (nome do arquivo = basename de bus/img/...)')
    ap.add_argument('--saida', default='')
    args = ap.parse_args()

    dados = json.load(open(args.painel))
    pendentes = [i for i in dados['itens'] if i.get('status') in ('em_analise', 'nao_encontrada')]
    fotos_dir = Path(args.fotos) if args.fotos else None

    resumo = Counter()
    detalhes = []
    for n, item in enumerate(pendentes, 1):
        caminhos = []
        if fotos_dir and item.get('fotos'):
            caminhos = [str(fotos_dir / Path(f).name) for f in item['fotos']]
            caminhos = [c for c in caminhos if os.path.isfile(c)]
        if not caminhos:
            resumo['sem_foto_publica'] += 1
            detalhes.append({'id': item['id'], 'status_atual': item['status'],
                             'resultado': 'sem_foto_publica',
                             'motivo': 'dry-run só cobre miniaturas públicas; a rodada real relê o arquivo original'})
            continue
        arq = processar_local(caminhos)
        st, publico, info = classificar_item(item, arq)
        if st == 'diverge':
            resumo['diverge_nao_publicado'] += 1
            resultado = 'diverge_nao_publicado'
        else:
            resumo[st] += 1
            resultado = st
        detalhes.append({
            'id': item['id'], 'status_atual': item['status'],
            'uf': item.get('uf'), 'zona': item.get('zona'), 'secao': item.get('secao'),
            'resultado': resultado, 'publico': publico,
            'fonte': info.get('fonte'), 'motivo': info.get('motivo'),
            'lido': info.get('lido'), 'oficial': info.get('oficial'),
            'qrs': len(arq.get('qr') or []),
        })
        print(f"[{n}/{len(pendentes)}] {item['id']} {item['status']} -> {resultado} ({info.get('motivo') or info.get('fonte') or ''})", flush=True)

    total = len(pendentes)
    saida = {
        'pendentes': total,
        'resumo': dict(resumo),
        'observacao': (
            'As fotos públicas são miniaturas (até 1400 px, JPEG 72). '
            'A rodada real, depois que este código for mesclado, relê o arquivo original pela ponte. '
            'Este dry-run não altera o site nem a planilha.'
        ),
        'itens': detalhes,
    }
    print('\nPendentes no painel:', total)
    for k, v in sorted(resumo.items(), key=lambda kv: (-kv[1], kv[0])):
        print(f'  {k}: {v}')
    if args.saida:
        json.dump(saida, open(args.saida, 'w'), ensure_ascii=False, indent=2)
        print('Relatório:', args.saida)


if __name__ == '__main__':
    main()

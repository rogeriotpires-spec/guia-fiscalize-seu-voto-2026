#!/usr/bin/env python3
# Lê o RDV (Registro Digital do Voto) de uma seção e conta os votos por eleição/cargo/tipo/dígitos.
import io, zipfile, collections


def der(b, s=0, e=None):
    """lista de (tag, inicio, fim) dos elementos DER consecutivos em b[s:e]"""
    e = len(b) if e is None else e
    out = []
    i = s
    while i < e:
        tag = b[i]; i += 1
        l = b[i]; i += 1
        if l & 0x80:
            n = l & 0x7f; l = int.from_bytes(b[i:i + n], 'big'); i += n
        out.append((tag, i, i + l)); i += l
    return out


def contagem(raw):
    """devolve {(id_eleicao, cargo): Counter({'13':n, 'B':n, 'N:14':n, 'L:xx':n})}"""
    res = {}
    top = der(raw)
    seq = [x for x in der(raw, top[0][1], top[0][2])]
    rdv = seq[2]                      # terceiro elemento: o RDV em si
    for tag, s, e in der(raw, rdv[1], rdv[2]):
        if tag != 0xa1:               # [1] eleições
            continue
        for _, s1, e1 in der(raw, s, e):          # cada eleição
            campos = der(raw, s1, e1)
            id_ele = int.from_bytes(raw[campos[0][1]:campos[0][2]], 'big')
            for _, s2, e2 in der(raw, campos[1][1], campos[1][2]):     # votosCargos
                c = der(raw, s2, e2)
                cargo = raw[c[0][1]:c[0][2]][0] if c[0][0] == 0x81 else None
                votos = c[-1]
                cont = collections.Counter()
                for _, s3, e3 in der(raw, votos[1], votos[2]):
                    v = der(raw, s3, e3)
                    tipo = raw[v[0][1]]
                    dig = raw[v[1][1]:v[1][2]].decode('ascii') if len(v) > 1 else ''
                    if tipo == 2: cont[dig] += 1            # nominal
                    elif tipo == 3: cont['B'] += 1          # branco
                    elif tipo == 4: cont['N:' + dig] += 1   # nulo (dígitos digitados)
                    elif tipo == 1: cont['L:' + dig] += 1   # legenda
                    else: cont[f'T{tipo}:' + dig] += 1
                res[(id_ele, cargo)] = cont
    return res


if __name__ == '__main__':
    import sys, json
    raw = open(sys.argv[1], 'rb').read()
    r = contagem(raw)
    print(json.dumps({f'{k[0]}/{k[1]}': dict(v) for k, v in r.items()}, ensure_ascii=False, indent=1))

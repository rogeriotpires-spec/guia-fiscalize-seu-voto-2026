#!/usr/bin/env python3
# Decodifica o BU (bu.dat) e o manifesto de assinaturas (vota.vsc) de uma seção.
import hashlib
from rdv import der


def texto(b, i, j):
    return b[i:j].decode('latin-1')


def inteiro(b, i, j):
    return int.from_bytes(b[i:j], 'big')


def le_bu(raw):
    top = der(raw)[0]
    kids = der(raw, top[1], top[2])
    inner = raw[kids[-1][1]:kids[-1][2]]          # OctetString com o BU em si
    t = der(inner)[0]
    campos = der(inner, t[1], t[2])
    out = {'e': {}}
    # elementos: [0] cabecalho, [1] fase, [2] urna, [3] identificacao, [4] dataHoraEmissao, [a0] abertura/encerramento, [2] qtdEleitoresLib?, [a1] habilitacao, [30] resultados, [30] chave
    urna = campos[2]
    uc = der(inner, urna[1], urna[2])
    out['versao'] = texto(inner, uc[1][1], uc[1][2]) if uc[1][0] == 0x1b else None
    for tag, i, j in campos:
        if tag == 0x1b:
            out['emissao'] = texto(inner, i, j)
        elif tag == 0xa0:
            d = der(inner, i, j)
            if len(d) >= 2 and d[0][0] == 0x1b:
                out['abertura'] = texto(inner, d[0][1], d[0][2]); out['encerramento'] = texto(inner, d[1][1], d[1][2])
        elif tag == 0xa1:
            out['hab'] = [inteiro(inner, a, b) for _, a, b in der(inner, i, j)]
        elif tag == 0x02 and 'comp_total' not in out and campos.index((tag, i, j)) > 4:
            out['comp_total'] = inteiro(inner, i, j)
    # resultados por eleição
    res = [k for k in campos if k[0] == 0x30 and k[2] - k[1] > 300]
    if not res:
        return out
    for _, i, j in der(inner, res[-1][1], res[-1][2]):
        e = der(inner, i, j)
        if len(e) < 5 or e[0][0] != 0x02:
            continue
        ide = inteiro(inner, e[0][1], e[0][2])
        aptos = inteiro(inner, e[1][1], e[1][2])
        rec = {'aptos': aptos, 'cargos': {}}
        for _, a, b in der(inner, e[4][1], e[4][2]):          # resultadosVotacao (por tipo)
            r = der(inner, a, b)
            if len(r) < 3:
                continue
            rec['comp'] = inteiro(inner, r[1][1], r[1][2])
            for _, c1, c2 in der(inner, r[2][1], r[2][2]):     # por cargo
                cc = der(inner, c1, c2)
                cargo = inner[cc[0][1]] if cc[0][0] == 0x81 else None
                votos = {}
                for _, v1, v2 in der(inner, cc[-1][1], cc[-1][2]):
                    vv = der(inner, v1, v2)
                    tipo = inner[vv[0][1]]
                    qtd = inteiro(inner, vv[1][1], vv[1][2])
                    cod = None
                    for tg, x1, x2 in vv:
                        if tg == 0xa3:
                            sub = der(inner, x1, x2); cod = inteiro(inner, sub[0][1], sub[0][2])
                    chave = str(cod) if tipo == 1 and cod is not None else {2: 'B', 3: 'N'}.get(tipo, f'T{tipo}')
                    votos[chave] = votos.get(chave, 0) + qtd
                rec['cargos'][str(cargo)] = votos
        out['e'][str(ide)] = rec
    return out


def le_vsc(raw):
    """devolve {nome_arquivo: (tamanho, sha512hex)} do manifesto de assinatura de hardware e o CN do certificado"""
    top = der(raw)[0]
    kids = der(raw, top[1], top[2])
    k0 = der(raw, kids[0][1], kids[0][2])
    big = [k for k in k0 if k[0] == 0x04 and k[2] - k[1] > 10000][0]
    inner = raw[big[1]:big[2]]
    lst = der(inner)[0]; lst = der(inner, lst[1], lst[2])[0]
    out = {}
    for _, i, j in der(inner, lst[1], lst[2]):
        campos = der(inner, i, j); nome = inner[campos[0][1]:campos[0][2]].decode()
        sub = der(inner, campos[1][1], campos[1][2])
        out[nome] = (int.from_bytes(inner[sub[0][1]:sub[0][2]], 'big'), inner[sub[1][1]:sub[1][2]].hex())
    cn = None
    try:
        k1 = der(raw, kids[1][1], kids[1][2])
        pem = raw[k1[-1][1]:k1[-1][2]]
        import base64, re
        b64 = b''.join(l for l in pem.split(b'\n') if l and not l.startswith(b'-----'))
        cert = base64.b64decode(b64)
        m = re.search(rb'UEAO\d{8}', cert)
        cn = m.group(0).decode() if m else None
    except Exception:
        pass
    return out, cn


if __name__ == '__main__':
    import sys, json
    print(json.dumps(le_bu(open(sys.argv[1], 'rb').read()), ensure_ascii=False, indent=1))
    if len(sys.argv) > 2:
        m, cn = le_vsc(open(sys.argv[2], 'rb').read()); print(cn, {k: v[0] for k, v in m.items()})

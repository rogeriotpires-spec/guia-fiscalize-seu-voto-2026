#!/usr/bin/env python3
# Censo dos RDVs no GitHub Actions: para cada seção da parte, baixa o rdv.dat do 2º turno,
# conta os votos (nominal, branco, nulo por dígitos) e grava JSONL; commit no branch rdv-parte-XX.
import csv, gzip, json, os, subprocess, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rdv import contagem

PARTE = sys.argv[1]
PLEITO = int(os.environ.get('PLEITO', '3221'))
ANO = 2026
WORKERS = int(os.environ.get('WORKERS', '8'))
LOTE = int(os.environ.get('LOTE', '5000'))
RAIZ = os.path.dirname(os.path.abspath(__file__))
PASTA = os.path.join(RAIZ, 'rdv', f'parte-{PARTE}')
os.makedirs(PASTA, exist_ok=True)
BASE = 'https://resultados.tse.jus.br/oficial'
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'


def sh(*cmd, check=True):
    return subprocess.run(cmd, cwd=RAIZ, check=check, capture_output=True, text=True)


def publica(msg):
    sh('git', 'add', '-A', 'rdv')
    if sh('git', 'commit', '-qm', msg, check=False).returncode != 0:
        return
    for i in range(6):
        if sh('git', 'push', '-q', 'origin', f'HEAD:rdv-parte-{PARTE}', check=False).returncode == 0:
            return
        time.sleep(5 + 7 * i)


def get(url, tentativas=5):
    for i in range(tentativas):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                return None
            time.sleep(2 * (i + 1))
        except Exception:
            time.sleep(2 * (i + 1))
    return None


def secao(uf, mun, zn, se):
    chave = f'{uf}-{mun}-{zn}-{se}'
    base = f'{BASE}/ele{ANO}/arquivo-urna/{PLEITO}/dados/{uf}/{mun}/{zn}/{se}'
    aux = get(f'{base}/p{PLEITO:06d}-{uf}-m{mun}-z{zn}-s{se}-aux.json')
    if not aux:
        return chave, 'sem_aux', None
    try:
        j = json.loads(aux)
        arq = hsh = None
        for h in j.get('hashes') or []:
            for a in h.get('arq', []):
                if a.get('tp') == 'rdv':
                    arq, hsh = a['nm'], h['hash']
        if not arq:
            return chave, 'sem_rdv', None
    except Exception:
        return chave, 'aux_ruim', None
    raw = get(f'{base}/{hsh}/{arq}')
    if not raw:
        return chave, 'sem_rdv', None
    try:
        c = contagem(raw)
    except Exception as e:
        return chave, 'rdv_ruim:' + str(e)[:60], None
    reg = {'uf': uf.upper(), 'mun': mun, 'zn': zn, 'se': se, 'bytes': len(raw),
           'e': {f'{k[0]}/{k[1]}': dict(v) for k, v in c.items()}}
    return chave, 'ok', reg


feitas = set()
for nome in os.listdir(PASTA):
    if nome.endswith('.jsonl.gz'):
        with gzip.open(os.path.join(PASTA, nome), 'rt', encoding='utf-8') as f:
            for ln in f:
                try:
                    r = json.loads(ln); feitas.add(f"{r['uf'].lower()}-{r['mun']}-{r['zn']}-{r['se']}")
                except Exception:
                    pass
falhas_path = os.path.join(PASTA, 'falhas.json')
falhas = json.load(open(falhas_path)) if os.path.exists(falhas_path) else {}
secoes = [tuple(r[:4]) for r in csv.reader(open(os.path.join(RAIZ, 'partes', f'parte-{PARTE}.csv')))]
fila = [s for s in secoes if f'{s[0]}-{s[1]}-{s[2]}-{s[3]}' not in feitas]
print(f'parte {PARTE}: {len(secoes)} seções, {len(feitas)} feitas, {len(fila)} na fila', flush=True)
t0 = time.time(); ok = err = 0; lote_i = 0
while fila and (time.time() - t0) / 60 < 320:
    lote, fila = fila[:LOTE], fila[LOTE:]
    arq = os.path.join(PASTA, f'rdv-{int(time.time())}-{lote_i:03d}.jsonl.gz')
    with gzip.open(arq, 'wt', encoding='utf-8') as out, ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for chave, status, reg in ex.map(lambda s: secao(*s), lote):
            if status == 'ok':
                out.write(json.dumps(reg, ensure_ascii=False, separators=(',', ':')) + '\n'); ok += 1
            else:
                falhas[chave] = status; err += 1
            if (ok + err) % 500 == 0:
                print(f'{time.strftime("%H:%M:%S")} ok={ok} erro={err} {(ok + err) / (time.time() - t0) * 3600:.0f}/h', flush=True)
    json.dump(falhas, open(falhas_path, 'w'))
    lote_i += 1
    publica(f'rdv parte {PARTE}: +{len(lote)} seções (ok={ok} erro={err})')
json.dump({'parte': PARTE, 'ok': ok, 'erro': err, 'restam': len(fila), 'hora': time.strftime('%Y-%m-%d %H:%M:%S')}, open(os.path.join(PASTA, 'status.json'), 'w'))
publica(f'rdv parte {PARTE}: status final (restam {len(fila)})')
print('fim', ok, err, flush=True)

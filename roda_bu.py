#!/usr/bin/env python3
# Censo de BU + manifesto de assinatura (vsc) + checagem de hash do BU e do RDV publicados.
import csv, gzip, hashlib, json, os, subprocess, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bu import le_bu, le_vsc

PARTE = sys.argv[1]
PLEITO = 3221; ANO = 2026
WORKERS = int(os.environ.get('WORKERS', '8')); LOTE = int(os.environ.get('LOTE', '4000'))
RAIZ = os.path.dirname(os.path.abspath(__file__))
PASTA = os.path.join(RAIZ, 'bu', f'parte-{PARTE}'); os.makedirs(PASTA, exist_ok=True)
BASE = 'https://resultados.tse.jus.br/oficial'
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'


def sh(*cmd, check=True):
    return subprocess.run(cmd, cwd=RAIZ, check=check, capture_output=True, text=True)


def publica(msg):
    sh('git', 'add', '-A', 'bu')
    if sh('git', 'commit', '-qm', msg, check=False).returncode != 0:
        return
    for i in range(6):
        if sh('git', 'push', '-q', 'origin', f'HEAD:bu-parte-{PARTE}', check=False).returncode == 0:
            return
        time.sleep(5 + 7 * i)


def get(url, tentativas=5):
    for i in range(tentativas):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=90) as r:
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
        j = json.loads(aux); arqs = {}
        for h in j.get('hashes') or []:
            for a in h.get('arq', []):
                arqs[a.get('tp')] = (a['nm'], h['hash'])
    except Exception:
        return chave, 'aux_ruim', None
    reg = {'uf': uf.upper(), 'mun': mun, 'zn': zn, 'se': se, 'arqs': sorted(arqs), 'hash_dir': {k: v[1][:16] for k, v in arqs.items()}}
    dados = {}
    for tp in ('bu', 'rdv', 'vota'):
        if tp in arqs:
            nm, hsh = arqs[tp]; raw = get(f'{base}/{hsh}/{nm}')
            if raw is None:
                reg[f'falta_{tp}'] = True
            else:
                dados[tp] = (nm, raw)
    if 'bu' in dados:
        try:
            reg['bu'] = le_bu(dados['bu'][1])
        except Exception as e:
            reg['bu_erro'] = str(e)[:80]
    if 'vota' in dados:
        try:
            man, cn, pem = le_vsc(dados['vota'][1]); reg['serial'] = cn; reg['cert'] = pem
            reg['manifesto'] = {k.split('-')[-1]: v for k, v in man.items()}     # 'bu.dat': (tam, sha512)
            chk = {}
            for tp in ('bu', 'rdv'):
                if tp in dados:
                    nm, raw = dados[tp]
                    m = man.get(nm)
                    chk[tp] = 'ok' if m and m[0] == len(raw) and m[1] == hashlib.sha512(raw).hexdigest() else ('sem_entrada' if not m else 'DIFERENTE')
            reg['hash_ok'] = chk
        except Exception as e:
            reg['vsc_erro'] = str(e)[:80]
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
    arq = os.path.join(PASTA, f'bu-{int(time.time())}-{lote_i:03d}.jsonl.gz')
    with gzip.open(arq, 'wt', encoding='utf-8') as out, ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for chave, status, reg in ex.map(lambda s: secao(*s), lote):
            if status == 'ok':
                out.write(json.dumps(reg, ensure_ascii=False, separators=(',', ':')) + '\n'); ok += 1
            else:
                falhas[chave] = status; err += 1
            if (ok + err) % 500 == 0:
                print(f'{time.strftime("%H:%M:%S")} ok={ok} erro={err} {(ok + err) / (time.time() - t0) * 3600:.0f}/h', flush=True)
    json.dump(falhas, open(falhas_path, 'w')); lote_i += 1
    publica(f'bu parte {PARTE}: +{len(lote)} seções (ok={ok} erro={err})')
json.dump({'parte': PARTE, 'ok': ok, 'erro': err, 'restam': len(fila), 'hora': time.strftime('%Y-%m-%d %H:%M:%S')}, open(os.path.join(PASTA, 'status.json'), 'w'))
publica(f'bu parte {PARTE}: status final (restam {len(fila)})')
print('fim', ok, err, flush=True)

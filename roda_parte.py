#!/usr/bin/env python3
# Roda uma parte do censo no GitHub Actions: baixa/parseia as seções da parte, grava em
# dados/parte-XX/*.jsonl.gz e faz commit+push periódico no branch censo (retomável).
import csv, gzip, json, os, subprocess, sys, time, threading
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from coleta_logs import Coletor

PARTE = sys.argv[1]
PLEITO = 3221
DATAS = {'t1': '04/10/2026', 't2': '25/10/2026'}
WORKERS = int(os.environ.get('WORKERS', '6'))
LOTE = int(os.environ.get('LOTE', '2500'))        # seções por commit
MINUTOS_MAX = float(os.environ.get('MINUTOS_MAX', '330'))
RAIZ = os.path.dirname(os.path.abspath(__file__))
PASTA = os.path.join(RAIZ, 'dados', f'parte-{PARTE}')
os.makedirs(PASTA, exist_ok=True)


def sh(*cmd, check=True):
    return subprocess.run(cmd, cwd=RAIZ, check=check, capture_output=True, text=True)


def publica(msg):
    sh('git', 'add', '-A', 'dados')
    r = sh('git', 'commit', '-qm', msg, check=False)
    if r.returncode != 0:
        return
    for i in range(6):
        p = sh('git', 'push', '-q', 'origin', f'HEAD:censo-parte-{PARTE}', check=False)
        if p.returncode == 0:
            print('push ok', flush=True)
            return
        time.sleep(5 + 7 * i)
    print('push falhou', p.stderr[-500:], flush=True)


# estado: chaves já feitas = união dos jsonl existentes (status ok) + falhas.json
feitas = set()
for nome in os.listdir(PASTA):
    if nome.endswith('.jsonl.gz'):
        with gzip.open(os.path.join(PASTA, nome), 'rt', encoding='utf-8') as f:
            for ln in f:
                try:
                    r = json.loads(ln)
                    feitas.add(f"{r['uf'].lower()}-{r['mun']}-{r['zn']}-{r['se']}")
                except Exception:
                    pass
falhas_path = os.path.join(PASTA, 'falhas.json')
falhas = json.load(open(falhas_path)) if os.path.exists(falhas_path) else {}
# falhas são sempre tentadas de novo (custam 1 requisição cada)

secoes = [tuple(r[:4]) for r in csv.reader(open(os.path.join(RAIZ, 'partes', f'parte-{PARTE}.csv')))]
fila = [s for s in secoes if f'{s[0]}-{s[1]}-{s[2]}-{s[3]}' not in feitas]
print(f'parte {PARTE}: {len(secoes)} seções, {len(feitas)} feitas, {len(fila)} na fila', flush=True)

c = Coletor('/tmp/censo-estado', PLEITO, 2026, DATAS, WORKERS)
c.saida.close()
t0 = time.time()
lote_i = 0
ok = err = 0
from concurrent.futures import ThreadPoolExecutor
while fila and (time.time() - t0) / 60 < MINUTOS_MAX:
    lote, fila = fila[:LOTE], fila[LOTE:]
    arq = os.path.join(PASTA, f'resumos-{int(time.time())}-{lote_i:03d}.jsonl.gz')
    novas_falhas = {}
    with gzip.open(arq, 'wt', encoding='utf-8') as out, ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for chave, status, reg in ex.map(lambda s: c.secao(*s), lote):
            if status == 'ok' and reg:
                out.write(json.dumps(reg, ensure_ascii=False, separators=(',', ':')) + '\n')
                ok += 1
            else:
                novas_falhas[chave] = status
                err += 1
            if (ok + err) % 200 == 0:
                dt = time.time() - t0
                print(f'{time.strftime("%H:%M:%S")} ok={ok} erro={err} {(ok + err) / dt * 3600:.0f}/h pausa={c.pausa:.2f}', flush=True)
    falhas.update(novas_falhas)
    json.dump(falhas, open(falhas_path, 'w'))
    lote_i += 1
    publica(f'censo parte {PARTE}: +{len(lote)} seções (ok={ok} erro={err})')
print('fim', ok, err, 'restam', len(fila), flush=True)
json.dump({'parte': PARTE, 'ok': ok, 'erro': err, 'restam': len(fila), 'hora': time.strftime('%Y-%m-%d %H:%M:%S')},
          open(os.path.join(PASTA, 'status.json'), 'w'))
publica(f'censo parte {PARTE}: status final (restam {len(fila)})')

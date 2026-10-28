#!/usr/bin/env python3
# Censo dos logs de urna 2026 (Revista Timeline / Fiscalize Seu Voto)
# Baixa o log.jez de cada seção no Portal de Resultados do TSE, extrai só o resumo
# (horários, tipo de habilitação, mesário que liberou) e grava em JSONL comprimido.
# Só biblioteca padrão. Reinicia de onde parou. Uso:
#   python3 coleta_logs.py --pasta ~/CensoUrnas --secoes secoes.csv [--workers 6]
import argparse, csv, gzip, hashlib, io, json, os, random, re, sqlite3, sys, threading, time, zipfile
import urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = 'https://resultados.tse.jus.br/oficial'
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'

# fuso de cada UF em relação a Brasília (horas) no dia da eleição
OFF = {'AC': -2, 'AM': -1, 'RR': -1, 'RO': -1, 'MT': -1, 'MS': -1}

RE_LINHA = re.compile(r'^(\d\d)/(\d\d)/(\d{4}) (\d\d):(\d\d):(\d\d)\t(\w+)\t(\w+)\t(\w+)\t(.*?)\t\w+$')
RE_MES_HAB = re.compile(r'^Mesário (\d+) habilitou o eleitor')
RE_MES_REG = re.compile(r'^Mesário (\d+) registrado')
RE_NAO_MES = re.compile(r'^Biometria coletada não é do mesário')
RE_ENC = re.compile(r'^Título digitado para encerramento: (\d+)')


def hms(h, m, s):
    return h * 3600 + m * 60 + s


def parse_log(texto, datas):
    """datas: {'t1': '04/10/2026', 't2': '25/10/2026'}. Devolve resumo por turno."""
    out = {}
    for turno, data in datas.items():
        out[turno] = {'abre': None, 'enc': None, 'fim': None, 'votos': [], 'mes': [], 'mes_reg': [], 'enc_tit': None,
                      'nao_mes': 0, 'nconf': 0, 'cpf': 0, 'just': 0, 'tent': 0, 'nassoc': 0}
    tipo = None   # tipo da habilitação em curso
    mes_i = -1
    turno_atual = None
    linhas = texto.split('\n')
    if '\n' in texto and texto.count('Início das operações do logd') > 1:
        # mais de um log (urna de contingência): ordena cronologicamente pelos campos de data/hora
        def chave_t(ln):
            m = RE_LINHA.match(ln)
            if not m: return (0, 0, 0, 0, 0, 0)
            dd, mm, yy, H, M, S = m.groups()[:6]
            return (int(yy), int(mm), int(dd), int(H), int(M), int(S))
        linhas = sorted(linhas, key=chave_t)
    for ln in linhas:
        m = RE_LINHA.match(ln)
        if not m:
            continue
        dd, mm, yy, H, M, S, nivel, serial, app, msg = m.groups()
        data = f'{dd}/{mm}/{yy}'
        turno_atual = None
        for t, d in datas.items():
            if d == data:
                turno_atual = t
        if turno_atual is None:
            continue
        r = out[turno_atual]
        t = hms(int(H), int(M), int(S))
        if msg == 'Urna pronta para receber votos':
            if r['abre'] is None:
                r['abre'] = t
        elif msg.startswith('Identificador digitado pelo mesário foi'):
            tipo = None
            mes_i = -1
            if '(CPF)' in msg:
                r['cpf'] += 1
        elif msg == 'Tipo de habilitação do eleitor [biométrica]':
            tipo = 'B'
        elif msg == 'Solicitação de dado pessoal do eleitor para habilitação manual':
            tipo = 'M'
            r['tent'] += 1
        elif msg == 'Dado digitado não confere':
            r['nconf'] += 1
        elif msg.startswith('Ano de nascimento digitado'):
            tipo = 'N'
        elif RE_NAO_MES.match(msg):
            r['nao_mes'] += 1
        elif msg.startswith('Digital coletada bate com uma digital gravada após o registro inicial'):
            r['nassoc'] += 1
        else:
            mh = RE_MES_HAB.match(msg)
            if mh:
                tit = mh.group(1)
                if tit not in r['mes']:
                    r['mes'].append(tit)
                mes_i = r['mes'].index(tit)
                continue
            mr = RE_MES_REG.match(msg)
            if mr:
                if mr.group(1) not in r['mes_reg']:
                    r['mes_reg'].append(mr.group(1))
                continue
            me = RE_ENC.match(msg)
            if me:
                r['enc_tit'] = me.group(1)
                continue
            if msg == 'O voto do eleitor foi computado':
                r['votos'].append([t, tipo or '?', mes_i])
                tipo = None
                mes_i = -1
            elif msg == 'Justificativa recebida':
                r['just'] += 1
            elif msg == 'Procedimento de encerramento confirmado':
                r['enc'] = t
            elif msg == 'Inicio do Encerramento':
                r['fim'] = t
    return out


def compacta(resumo):
    """votos -> string compacta 'segundos:tipo:mesario,...' para o JSONL ficar pequeno."""
    for t, r in resumo.items():
        r['n'] = len(r['votos'])
        r['nB'] = sum(1 for v in r['votos'] if v[1] == 'B')
        r['nM'] = sum(1 for v in r['votos'] if v[1] == 'M')
        r['nN'] = sum(1 for v in r['votos'] if v[1] == 'N')
        r['v'] = ','.join(f'{v[0]}{v[1]}{v[2] if v[2] >= 0 else ""}' for v in r['votos'])
        del r['votos']
    return resumo


def extrai_logs(dados, prof=0):
    """Devolve a lista de textos logd.dat dentro do .jez, incluindo os .jez aninhados
    (log da urna original quando houve troca por urna de contingência)."""
    out = []
    with zipfile.ZipFile(io.BytesIO(dados)) as z:
        for nome in z.namelist():
            raw = z.read(nome)
            if nome.lower().endswith('.jez') and prof < 3:
                out.extend(extrai_logs(raw, prof + 1))
            elif nome.lower().endswith('.dat') or nome.lower().endswith('.txt'):
                out.append(raw.decode('latin-1'))
    return out


class Coletor:
    def __init__(self, pasta, pleito, ano, datas, workers):
        self.pasta = pasta
        self.pleito = pleito
        self.ano = ano
        self.datas = datas
        self.workers = workers
        os.makedirs(pasta, exist_ok=True)
        self.db = sqlite3.connect(os.path.join(pasta, 'estado.sqlite'), check_same_thread=False)
        self.db.execute('create table if not exists feito(chave text primary key, status text, quando real)')
        self.db.commit()
        self.lock = threading.Lock()
        self.saida = gzip.open(os.path.join(pasta, f'resumos_{int(time.time())}.jsonl.gz'), 'at', encoding='utf-8')
        self.pausa = 0.0   # atraso adaptativo
        self.ok = self.err = 0
        self.t0 = time.time()

    def feitos(self):
        return {r[0] for r in self.db.execute('select chave from feito where status in ("ok","sem_log","sem_aux")')}

    def get(self, url, tentativas=5):
        for i in range(tentativas):
            try:
                if self.pausa:
                    time.sleep(self.pausa + random.random() * 0.1)
                req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': '*/*'})
                with urllib.request.urlopen(req, timeout=60) as r:
                    dados = r.read()
                with self.lock:
                    self.pausa = max(0.0, self.pausa * 0.9)
                return 200, dados
            except urllib.error.HTTPError as e:
                if e.code in (403, 404):
                    return e.code, None
                with self.lock:
                    self.pausa = min(5.0, self.pausa + 0.5)
                time.sleep(2 * (i + 1))
            except Exception:
                with self.lock:
                    self.pausa = min(5.0, self.pausa + 0.5)
                time.sleep(2 * (i + 1))
        return 0, None

    def secao(self, uf, mun, zn, se):
        uf = uf.lower()
        chave = f'{uf}-{mun}-{zn}-{se}'
        p = self.pleito
        base = f'{BASE}/ele{self.ano}/arquivo-urna/{p}/dados/{uf}/{mun}/{zn}/{se}'
        code, aux = self.get(f'{base}/p{p:06d}-{uf}-m{mun}-z{zn}-s{se}-aux.json')
        if aux is None:
            return chave, 'sem_aux', None
        try:
            j = json.loads(aux)
            hashes = j.get('hashes') or []
            arq = None
            hsh = None
            for h in hashes:
                for a in h.get('arq', []):
                    nm = a.get('nm', '') if isinstance(a, dict) else str(a)
                    if a.get('tp') == 'log' or nm.endswith('-log.jez') or nm.endswith('.logjez'):
                        arq, hsh = nm, h['hash']
            if not arq:
                return chave, 'sem_log', {'aux': j}
        except Exception as e:
            return chave, 'aux_ruim', None
        code, jez = self.get(f'{base}/{hsh}/{arq}')
        if jez is None:
            return chave, 'sem_log', None
        try:
            textos = extrai_logs(jez)
            texto = '\n'.join(textos)
        except Exception:
            return chave, 'zip_ruim', None
        resumo = compacta(parse_log(texto, self.datas))
        reg = {'uf': uf.upper(), 'mun': mun, 'zn': zn, 'se': se, 'off': OFF.get(uf.upper(), 0),
               'sha': hashlib.sha256(jez).hexdigest(), 'arq': arq, 'bytes': len(jez), 'logs': len(textos),
               'gerado': j.get('dtgeracao') or j.get('dg'), 'r': resumo}
        return chave, 'ok', reg

    def roda(self, secoes):
        feitos = self.feitos()
        fila = [s for s in secoes if f'{s[0].lower()}-{s[1]}-{s[2]}-{s[3]}' not in feitos]
        print(f'{len(secoes)} seções, {len(feitos)} já feitas, {len(fila)} na fila', flush=True)
        with ThreadPoolExecutor(max_workers=self.workers) as ex:
            futs = {}
            it = iter(fila)
            for s in it:
                futs[ex.submit(self.secao, *s)] = s
                if len(futs) >= self.workers * 4:
                    break
            while futs:
                for f in as_completed(list(futs)):
                    futs.pop(f)
                    chave, status, reg = f.result()
                    with self.lock:
                        if reg and status == 'ok':
                            self.saida.write(json.dumps(reg, ensure_ascii=False, separators=(',', ':')) + '\n')
                            self.ok += 1
                        else:
                            self.err += 1
                        self.db.execute('insert or replace into feito values(?,?,?)', (chave, status, time.time()))
                        if (self.ok + self.err) % 50 == 0:
                            self.db.commit()
                            self.saida.flush()
                            dt = time.time() - self.t0
                            print(f'{time.strftime("%H:%M:%S")} ok={self.ok} erro={self.err} '
                                  f'{(self.ok + self.err) / dt * 3600:.0f}/h pausa={self.pausa:.2f}s', flush=True)
                            with open(os.path.join(self.pasta, 'progresso.json'), 'w') as fp:
                                json.dump({'ok': self.ok, 'erro': self.err, 'fila': len(fila), 'feitos_antes': len(feitos),
                                           'por_hora': (self.ok + self.err) / dt * 3600, 'pausa': self.pausa,
                                           'hora': time.strftime('%Y-%m-%d %H:%M:%S')}, fp)
                    s = next(it, None)
                    if s is not None:
                        futs[ex.submit(self.secao, *s)] = s
                    break
        self.db.commit()
        self.saida.close()
        print('fim', self.ok, self.err, flush=True)


def descobre_pleito(ano, uf, mun, zn, se):
    """Tenta achar o código do pleito (p000NNN) testando o aux.json de uma seção conhecida."""
    uf = uf.lower()
    for p in list(range(400, 700)) + list(range(100, 400)):
        url = f'{BASE}/ele{ano}/arquivo-urna/{p}/dados/{uf}/{mun}/{zn}/{se}/p{p:06d}-{uf}-m{mun}-z{zn}-s{se}-aux.json'
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                j = json.loads(r.read())
                print('pleito', p, json.dumps(j)[:400])
                return p
        except urllib.error.HTTPError as e:
            if e.code not in (403, 404):
                print(p, e.code)
        except Exception as e:
            print(p, e)
    return None


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--pasta', required=True)
    ap.add_argument('--secoes', help='CSV uf,mun,zn,se (com zeros à esquerda: mun 5, zn 4, se 4)')
    ap.add_argument('--pleito', type=int)
    ap.add_argument('--ano', type=int, default=2026)
    ap.add_argument('--datas', default='t1=04/10/2026,t2=25/10/2026')
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--descobrir', help='uf,mun,zn,se de uma seção para descobrir o código do pleito')
    ap.add_argument('--teste', help='uf,mun,zn,se: baixa e imprime o resumo de uma seção só')
    a = ap.parse_args()
    datas = dict(x.split('=') for x in a.datas.split(','))
    if a.descobrir:
        print(descobre_pleito(a.ano, *a.descobrir.split(',')))
        sys.exit()
    c = Coletor(os.path.expanduser(a.pasta), a.pleito, a.ano, datas, a.workers)
    if a.teste:
        chave, st, reg = c.secao(*a.teste.split(','))
        print(st)
        print(json.dumps(reg, ensure_ascii=False)[:3000])
        sys.exit()
    with open(a.secoes, encoding='utf-8') as f:
        secoes = [tuple(r[:4]) for r in csv.reader(f) if r and r[0] != 'uf']
    c.roda(secoes)

# Baixa votacao_secao_2026_{UF}.zip dos dados abertos do TSE e extrai votos por seção de governador (cargo 3) e senador (cargo 5)
import duckdb, os, sys, urllib.request, zipfile, io, time
UFS=sys.argv[1].split(',')
os.makedirs('estaduais/saida',exist_ok=True)
for uf in UFS:
    url=f'https://cdn.tse.jus.br/estatistica/sead/odsele/votacao_secao/votacao_secao_2026_{uf}.zip'
    for i in range(5):
        try:
            req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'}); raw=urllib.request.urlopen(req,timeout=300).read(); break
        except Exception as e:
            print(uf,'tentativa',i,e,flush=True); time.sleep(10*(i+1)); raw=None
    if raw is None: print(uf,'FALHOU',flush=True); continue
    z=zipfile.ZipFile(io.BytesIO(raw)); nome=[n for n in z.namelist() if n.endswith('.csv')][0]
    open(f'estaduais/{uf}.csv','wb').write(z.read(nome))
    con=duckdb.connect()
    con.execute(f"""copy (select SG_UF uf, lpad(cast(CD_MUNICIPIO as varchar),5,'0') mun, NR_ZONA zn, NR_SECAO se, NR_TURNO turno, CD_CARGO cargo, NR_VOTAVEL nr, NM_VOTAVEL nome, SG_PARTIDO partido, sum(QT_VOTOS) votos
      from read_csv('estaduais/{uf}.csv', delim=';', header=true, encoding='latin-1', all_varchar=false, ignore_errors=true)
      where CD_CARGO in (3,5) group by all) to 'estaduais/saida/{uf}.csv.gz' (header, delimiter ';', compression gzip)""")
    os.remove(f'estaduais/{uf}.csv'); print(uf,'ok',os.path.getsize(f'estaduais/saida/{uf}.csv.gz'),flush=True)

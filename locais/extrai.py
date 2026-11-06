import json, zipfile, io, urllib.request, csv, sys
alvo=json.load(open('locais/alvo.json'))
muns=set((r[0],r[1].zfill(5)) for r in alvo)
url='https://cdn.tse.jus.br/estatistica/sead/odsele/eleitorado_locais_votacao/eleitorado_local_votacao_2026.zip'
urllib.request.urlretrieve(url,'elv.zip')
import os; print('zip bytes',os.path.getsize('elv.zip'))
z=zipfile.ZipFile('elv.zip'); print(z.namelist()); name=[n for n in z.namelist() if 'BRASIL' in n][0]
out=open('locais/saida.csv','w',newline='',encoding='utf-8'); w=None; n=0
with z.open(name) as f:
    r=csv.DictReader(io.TextIOWrapper(f,encoding='latin-1'),delimiter=';')
    print(r.fieldnames)
    for k,row in enumerate(r):
        if k==0: print(row)
        if (row['SG_UF'],row['CD_MUNICIPIO'].zfill(5)) in muns:
            if w is None: print('primeiro match',row); w=csv.DictWriter(out,fieldnames=r.fieldnames); w.writeheader()
            w.writerow(row); n+=1
out.close(); print('linhas',n)

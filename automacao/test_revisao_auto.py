"""Testes da revisão automática: regras conservadoras, sem fotos reais de eleitor."""
import os
import sys
import unittest

import numpy as np
import zxingcpp

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import revisao_auto
import robo


def _qr_img(texto, tamanho=320):
    img = zxingcpp.write_barcode(zxingcpp.BarcodeFormat.QRCode, texto, width=tamanho, height=tamanho, quiet_zone=4)
    arr = np.asarray(img)
    if arr.ndim == 3:
        arr = arr[:, :, 0]
    h, w = arr.shape
    canvas = np.full((h + 80, w + 80), 255, dtype=np.uint8)
    canvas[40:40 + h, 40:40 + w] = arr
    rgb = cv2_gray_to_rgb(canvas)
    return rgb


def cv2_gray_to_rgb(g):
    return np.stack([g, g, g], axis=2)


# payload mínimo de um BU 1/1 com votos de presidente
QR_COMPLETO = (
    "QRBU:1:1 VRQR:6.0 ORIG:VOTA ORLC:LEG PROC:1219 DTPL:20261025 PLEI:3221 TURN:2 FASE:O "
    "UNFE:PE MUNI:12345 ZONA:90 SECA:42 IDUE:1 IDCA:1 HIQT:1 VERS:1 LOCA:1 APTO:200 "
    "IDEL:6258 CARG:1 TIPO:0 VERC:1 13:117 22:50 APTA:200 NOMI:167 BRAN:1 NULO:5 TOTC:173 "
    "HASH:00 ASSI:00"
)

# fragmento 1/2 só com cabeçalho (sem votos de presidente)
QR_CABECA = (
    "QRBU:1:2 VRQR:6.0 ORIG:VOTA UNFE:SP MUNI:71072 ZONA:324 SECA:250 TURN:2 "
    "HASH:00 ASSI:00"
)


class TestNumerosConferem(unittest.TestCase):
    def test_bate_os_quatro(self):
        of = [117, 50, 1, 5]
        nums = {'lula': [13, 117], 'flavio': [50], 'branco': [1], 'nulo': [5, 0]}
        self.assertTrue(revisao_auto.numeros_conferem(nums, of))

    def test_nao_bate_sem_um_total(self):
        of = [117, 50, 1, 5]
        nums = {'lula': [117], 'flavio': [50], 'branco': [1], 'nulo': [4]}
        self.assertFalse(revisao_auto.numeros_conferem(nums, of))

    def test_nunca_confirma_oficial_incompleto(self):
        self.assertFalse(revisao_auto.numeros_conferem({'lula': [1]}, None))
        self.assertFalse(revisao_auto.numeros_conferem({'lula': [1], 'flavio': [2], 'branco': [0], 'nulo': [0]}, [1, 2, None, 0]))

    def test_nominais_inconsistente_bloqueia(self):
        of = [117, 50, 1, 5]
        nums = {'lula': [117], 'flavio': [50], 'branco': [1], 'nulo': [5], 'nominais': [999]}
        self.assertFalse(revisao_auto.numeros_conferem(nums, of))

    def test_nominais_consistente_libera(self):
        of = [117, 50, 1, 5]
        nums = {'lula': [117], 'flavio': [50], 'branco': [1], 'nulo': [5], 'nominais': [167], 'total': [173]}
        self.assertTrue(revisao_auto.numeros_conferem(nums, of))


class TestResumoOcrAmpliado(unittest.TestCase):
    def test_le_13_e_linha_seguinte(self):
        texto = "LULA\n0117\nFLAVIO BOLSONARO 22 0050\nBrancos 0001\nNulos 0005"
        r = revisao_auto.resumo_ocr_ampliado(texto)
        self.assertIn(117, r['nums'].get('lula', []))
        self.assertIn(50, r['nums'].get('flavio', []))
        self.assertIn(1, r['nums'].get('branco', []))
        self.assertIn(5, r['nums'].get('nulo', []))


class TestMotivo(unittest.TestCase):
    def test_zz_sem_base(self):
        m = revisao_auto.motivo_pendente(uf='ZZ', mun='30341', zona=1, secao=1853, oficial=None)
        self.assertIn('ZZ', m)
        self.assertIn('base', m.lower())

    def test_qr_incompleto(self):
        bu = robo.montar_bu([QR_CABECA])
        self.assertIsNotNone(bu)
        self.assertTrue(bu['falta'])
        m = revisao_auto.motivo_pendente(bu=bu)
        self.assertIn('faltam QR Codes', m)


class TestMontarBuIncompletoNaoConfirma(unittest.TestCase):
    def test_fragmento_sozinho_nao_e_completo(self):
        bu = robo.montar_bu([QR_CABECA])
        self.assertTrue(bu['falta'])
        # regra conservadora: sem o conjunto de QR, não se confirma pelo QR
        self.assertTrue(bu['falta'] or not bu['pres'])


class TestLerQrSintetico(unittest.TestCase):
    def test_reforcado_le_qr_gerado(self):
        img = _qr_img(QR_COMPLETO, 360)
        achados = revisao_auto.ler_qrs_reforcado(img)
        bu = robo.montar_bu(sorted(t for t in achados if t.startswith('QRBU:')))
        self.assertIsNotNone(bu)
        self.assertFalse(bu['falta'])
        self.assertEqual(bu['pres']['votos'].get('13'), 117)
        self.assertEqual(bu['pres']['votos'].get('22'), 50)

    def test_classificar_confere_com_qr_completo(self):
        # usa a base real de PE se a seção de teste não existir: injeta na base carregada
        base = robo.base_uf('PE') or {}
        chave = '12345-90-42'
        # não alteramos o arquivo; só o dicionário em memória desta execução
        if base is not None:
            base[chave] = [117, 50, 1, 5]
        resp = {'id': 'teste-sintetico', 'ts': '2026-11-01T00:00:00', 'itens': []}
        c = {'uf': 'PE', 'municipio': '12345', 'zona': '90', 'secao': '42',
             'arquivos': ['x'], 'nome': '', 'whats': '', 'turno': ''}
        arqs = [{'qr': [QR_COMPLETO], 'ocr': {'kw': 4, 'letras': 20, 'turno1': False, 'nums': {}},
                 'erro': None, 'png': False, 'camera': True, 'pdf_texto': False, 'scanner': False, 'sha': 'abc'}]
        st, info = robo.classificar(resp, c, arqs, {})
        self.assertEqual(st, 'confere')
        self.assertEqual(info['lido'], [117, 50, 1, 5])

    def test_classificar_nao_marca_confere_se_numero_diverge(self):
        base = robo.base_uf('PE')
        if base is not None:
            base['12345-90-42'] = [200, 50, 1, 5]  # Lula diferente do QR
        resp = {'id': 'teste-diverge', 'ts': '2026-11-01T00:00:00', 'itens': []}
        c = {'uf': 'PE', 'municipio': '12345', 'zona': '90', 'secao': '42',
             'arquivos': ['x'], 'nome': '', 'whats': '', 'turno': ''}
        arqs = [{'qr': [QR_COMPLETO], 'ocr': {'kw': 4, 'letras': 20, 'turno1': False, 'nums': {}},
                 'erro': None, 'png': False, 'camera': True, 'pdf_texto': False, 'scanner': False, 'sha': 'abc'}]
        st, info = robo.classificar(resp, c, arqs, {})
        self.assertEqual(st, 'diverge')
        self.assertNotEqual(info['lido'], info['oficial'])


class TestFundirOcr(unittest.TestCase):
    def test_nao_infla_letras(self):
        a = "boletim de urna\nLULA 13 0117"
        b = "texto aleatorio sem relacao com eleicao " + ("palavra " * 30)
        r = revisao_auto.fundir_ocr([a, b])
        isolado = revisao_auto.resumo_ocr_ampliado(a)
        self.assertEqual(r['letras'], max(isolado['letras'], revisao_auto.resumo_ocr_ampliado(b)['letras']))
        self.assertIn(117, r['nums'].get('lula', []))
        # a soma das duas leituras seria bem maior que o máximo
        self.assertLess(r['letras'], isolado['letras'] + revisao_auto.resumo_ocr_ampliado(b)['letras'])


if __name__ == '__main__':
    unittest.main()
